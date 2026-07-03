import { apiInitializer } from "discourse/lib/api";
import { iconHTML } from "discourse-common/lib/icon-library";
import { i18n } from "discourse-i18n";
import pipState from "../lib/pip-state";
import YtPipPlayer from "../components/yt-pip-player";

const BATCH_SIZE = 300;
const PLAYLIST_CHUNK_SIZE = 50;
const PREFETCH_THRESHOLD = 10;

export default apiInitializer("1.0", (api) => {

  api.renderInOutlet("home-logo__after", YtPipPlayer);

  // ── Helpers ───────────────────────────────────────────────────────────────

  function getCurrentTopic() {
    try {
      return api.container.lookup("controller:topic")?.model ?? null;
    } catch {
      return null;
    }
  }

  function buildEmbedUrl(videoId, start, autoplay) {
    const params = new URLSearchParams({
      autoplay: autoplay ? "1" : "0",
      enablejsapi: "1",
      origin: window.location.origin,
    });
    if (start) params.set("start", Math.floor(start));
    return `https://www.youtube.com/embed/${videoId}?${params.toString()}`;
  }

  function setIframeSrc(url) {
    const el = pipState.iframeEl || document.getElementById("discourse-pip-iframe");
    if (el) {
      try { el.contentWindow.location.replace(url); return; } catch { /* not loaded */ }
    }
    pipState.embedUrl = url;
  }

  function resolveAvatarUrl(tpl) {
    if (!tpl) return null;
    const sized = tpl.replace("{size}", "40");
    return sized.startsWith("http") ? sized : `${window.location.origin}${sized}`;
  }

  // ── Playlist fetch ────────────────────────────────────────────────────────

  async function fetchPostBatch(topicId, postIds) {
    const params = postIds.map((id) => `post_ids[]=${id}`).join("&");
    const res = await fetch(`/t/${topicId}/posts.json?${params}`, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.post_stream?.posts ?? [];
  }

  // Handles two embedding types:
  // 1. lazy-video-container: data-video-id attribute
  // 2. Direct iframe.youtube-onebox: src from URL
  // The `cooked` string is not stored - only the IDs are extracted from it.
  function extractYoutubeFromCooked(cooked) {
    const results = [];
    const seen = new Set();

    // 1. lazy-video-container
    const re1 = /class="[^"]*lazy-video-container[^"]*youtube-onebox[^"]*"[^>]*data-video-id="([^"]+)"(?:[^>]*data-video-start-time="([^"]*)")?(?:[^>]*data-video-title="([^"]*)")?/g;
    let m;
    while ((m = re1.exec(cooked)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      results.push({
        videoId: m[1],
        startSeconds: parseInt(m[2] || "0", 10),
        videoTitle: m[3]
          ? decodeURIComponent(m[3].replace(/&amp;/g, "&"))
          : i18n(themePrefix("discourse_pip.unknown_title")),
      });
    }

    // 2. Direct iframe.youtube-onebox
    if (cooked.includes("youtube-onebox") && cooked.includes("youtube.com/embed/")) {
      const re2 = /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/g;
      let m2;
      while ((m2 = re2.exec(cooked)) !== null) {
        if (seen.has(m2[1])) continue;
        // Check if youtube-onebox class is nearby
        const ctx = cooked.substring(Math.max(0, m2.index - 200), m2.index + 50);
        if (!ctx.includes("youtube-onebox")) continue;
        seen.add(m2[1]);
        results.push({
          videoId: m2[1],
          startSeconds: 0,
          videoTitle: i18n(themePrefix("discourse_pip.unknown_title")),
        });
      }
    }

    // Fallback DOM parse
    if (results.length === 0 && cooked.includes("youtube")) {
      const tmp = document.createElement("div");
      tmp.innerHTML = cooked;
      tmp.querySelectorAll(".lazy-video-container.youtube-onebox").forEach((w) => {
        const videoId = w.dataset.videoId;
        if (videoId && !seen.has(videoId)) {
          seen.add(videoId);
          results.push({ videoId, startSeconds: parseInt(w.dataset.videoStartTime || "0", 10), videoTitle: w.dataset.videoTitle || i18n(themePrefix("discourse_pip.unknown_title")) });
        }
      });
      tmp.querySelectorAll("iframe.youtube-onebox[src]").forEach((iframe) => {
        const em = iframe.src?.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
        if (em && !seen.has(em[1])) {
          seen.add(em[1]);
          results.push({ videoId: em[1], startSeconds: 0, videoTitle: i18n(themePrefix("discourse_pip.unknown_title")) });
        }
      });
    }

    return results;
  }

  // ── Playlist build ────────────────────────────────────────────────────────
  // Loading starts from the position of the clicked post (playlistStartOffset),
  // goes to the end of the topic, then turns back to the beginning and loads
  // until it reaches startOffset – so it goes around.

  let activeLoadId = 0;

  async function loadMorePlaylist(topic, loadId) {
    if (pipState.loadingPlaylist || !pipState.hasMorePlaylist) return;
    pipState.loadingPlaylist = true;

    const allPostIds = topic.postStream.get("stream");
    const total = allPostIds.length;
    let collected = 0;

    while (collected < PLAYLIST_CHUNK_SIZE) {
      if (loadId !== activeLoadId) break;

      // Wrap-around: once the end is reached, it returns to the beginning
      if (pipState.playlistCursor >= total) {
        if (pipState.playlistWrapped) {
          // You've already gone around once - done
          pipState.hasMorePlaylist = false;
          break;
        }
        pipState.playlistWrapped = true;
        pipState.playlistCursor = 0;
      }

      // If we reach the starting position after wrapping – it’s done
      if (pipState.playlistWrapped && pipState.playlistCursor >= pipState.playlistStartOffset) {
        pipState.hasMorePlaylist = false;
        break;
      }

      // Do not go beyond the starting position after the wrap
      const batchEnd = pipState.playlistWrapped
        ? Math.min(pipState.playlistCursor + BATCH_SIZE, pipState.playlistStartOffset)
        : Math.min(pipState.playlistCursor + BATCH_SIZE, total);

      const batch = allPostIds.slice(pipState.playlistCursor, batchEnd);
      pipState.playlistCursor = batchEnd;

      if (batch.length === 0) break;

      try {
        const posts = await fetchPostBatch(topic.id, batch);
        if (loadId !== activeLoadId) break;

        const byId = Object.create(null);
        for (const p of posts) byId[p.id] = p;

        for (const postId of batch) {
          const post = byId[postId];
          if (!post?.cooked) continue;

          for (const v of extractYoutubeFromCooked(post.cooked)) {
            const key = `${v.videoId}-${post.id}`;
            if (pipState.seen.has(key)) continue;
            pipState.seen.add(key);

            pipState.playlist.push({
              videoId: v.videoId,
              startSeconds: v.startSeconds,
              videoTitle: v.videoTitle,
              postId: post.id,
              postNumber: post.post_number,
              username: post.username || i18n(themePrefix("discourse_pip.anonymous")),
              avatarUrl: resolveAvatarUrl(post.avatar_template),
            });

            collected++;
            if (collected >= PLAYLIST_CHUNK_SIZE) break;
          }
          if (collected >= PLAYLIST_CHUNK_SIZE) break;
        }
      } catch (e) {
        console.warn("[Discourse PiP] playlist chunk fail", e);
        break;
      }
    }

    pipState.loadingPlaylist = false;
  }

  // ── Next track ────────────────────────────────────────────────────────────

  function playNext() {
    const topic = getCurrentTopic();
    if (topic && pipState.currentPlaylistIndex >= pipState.playlist.length - PREFETCH_THRESHOLD) {
      loadMorePlaylist(topic, activeLoadId);
    }

    pipState.currentPlaylistIndex++;
    if (pipState.currentPlaylistIndex >= pipState.playlist.length) pipState.currentPlaylistIndex = 0;

    const next = pipState.playlist[pipState.currentPlaylistIndex];
    if (!next) return;

    pipState.sourcePostNumber = next.postNumber;
    pipState.videoId = next.videoId;
    pipState.currentItem = next;
    setIframeSrc(buildEmbedUrl(next.videoId, next.startSeconds, true));
  }

  pipState.requestNext = playNext;

  // ── YouTube postMessage ───────────────────────────────────────────────────
  // The infoDelivery messages are sent by YouTube itself after we send the
  // {"event":"listening"} message in the iframe's onload.
  // No need for setInterval polling - that's just unnecessary CPU/memory.

  let lastDuration = 0;

  window.addEventListener("message", (event) => {
    if (event.origin !== "https://www.youtube.com" || !pipState.visible) return;

    let data = event.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { return; }
    }

    if (data?.event !== "infoDelivery" || !data.info) return;

    const info = data.info;
    if (info.duration !== undefined) lastDuration = info.duration;
    if (info.currentTime !== undefined && lastDuration > 0) {
      pipState.updateProgress?.(info.currentTime, lastDuration);
    }
    if (info.playerState === 0) playNext();
  });

  // ── Reset helper ──────────────────────────────────────────────────────────

  function resetState() {
    activeLoadId++;
    lastDuration = 0;
    pipState.playlist = [];
    pipState.seen = new Set();
    pipState.currentPlaylistIndex = -1;
    pipState.playlistCursor = 0;
    pipState.playlistStartOffset = 0;
    pipState.playlistWrapped = false;
    pipState.hasMorePlaylist = true;
    pipState.loadingPlaylist = false;
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  pipState.requestClose = function doClose() {
    resetState();
    pipState.visible = false;
    pipState.panelOpen = false;
    pipState.videoId = null;
    pipState.embedUrl = null;
    pipState.currentItem = null;
    pipState.sourceTopicId = null;
    pipState.sourceTopicSlug = null;
    pipState.sourcePostNumber = null;
    restoreOriginalEmbed();
  };

  // ── Embed placeholder ─────────────────────────────────────────────────────

  function replaceOriginalEmbed(wrapper) {
    pipState.originalEmbed = wrapper;
    const placeholder = document.createElement("div");
    placeholder.className = "pip-placeholder";
    placeholder.dataset.pipOriginal = "true";
    placeholder.innerHTML = `
      <div class="pip-placeholder-inner">
        ${iconHTML("circle-play")}
        <span>${i18n(themePrefix("discourse_pip.playing_in_pip"))}</span>
      </div>
    `;
    wrapper.parentNode.replaceChild(placeholder, wrapper);
  }

  function restoreOriginalEmbed() {
    if (!pipState.originalEmbed) return;
    const placeholder = document.querySelector("[data-pip-original='true']");
    placeholder?.parentNode?.replaceChild(pipState.originalEmbed, placeholder);
    pipState.originalEmbed = null;
  }

  function quickMetaFromDom(wrapper, videoId) {
    const postEl = wrapper.closest("[data-post-id]");
    if (!postEl) return null;
    const postId = parseInt(postEl.getAttribute("data-post-id"), 10);
    const postModel = getCurrentTopic()?.postStream?.findLoadedPost(postId);
    return {
      videoId,
      videoTitle: wrapper.dataset.videoTitle || wrapper.querySelector("iframe")?.title || i18n(themePrefix("discourse_pip.unknown_title")),
      username: postModel?.username || postEl.querySelector("[data-user-card]")?.getAttribute("data-user-card") || i18n(themePrefix("discourse_pip.anonymous")),
      avatarUrl: resolveAvatarUrl(postModel?.avatar_template),
    };
  }

  // ── Launch ────────────────────────────────────────────────────────────────

  async function launchPip(videoId, start, wrapper) {
    if (pipState.originalEmbed && pipState.videoId !== videoId) restoreOriginalEmbed();

    resetState();
    const myLoadId = activeLoadId;

    const topic = getCurrentTopic();
    pipState.sourceTopicId   = topic?.id   ?? null;
    pipState.sourceTopicSlug = topic?.slug ?? null;

    const postEl = wrapper.closest("[data-post-id]");
    const postId = postEl ? parseInt(postEl.getAttribute("data-post-id"), 10) : null;
    if (postId && topic?.postStream) {
      pipState.sourcePostNumber = topic.postStream.findLoadedPost(postId)?.post_number ?? null;
    } else {
      pipState.sourcePostNumber = null;
    }

    // Set cursor to the position of the clicked post.
    // topic.postStream.get("stream") contains all post IDs in a row.
    // Find the position of the clicked postId and start loading from there.
    if (postId && topic?.postStream) {
      const allPostIds = topic.postStream.get("stream");
      const clickedIdx = allPostIds.indexOf(postId);
      if (clickedIdx >= 0) {
        pipState.playlistCursor = clickedIdx;
        pipState.playlistStartOffset = clickedIdx;
      }
    }

    // The meta extracted from the DOM is the truth - we show this while the playlist is being built.
    // The playlist index lookup only sets the index, the currentItem
    // is only updated if it matches exactly (videoId + postNumber).
    const domMeta = quickMetaFromDom(wrapper, videoId);

    pipState.videoId = videoId;
    pipState.currentItem = domMeta;
    pipState.embedUrl = buildEmbedUrl(videoId, start, true);
    pipState.panelOpen = false;
    pipState.visible = true;

    replaceOriginalEmbed(wrapper);

    if (!topic) return;

    // We search the playlist for the clicked video in the background.
    // Goal: set the index to the correct position so that "next" works properly.
    // We do NOT overwrite currentItem - DOM meta is the trusted source.
    let found = false;
    while (!found && pipState.hasMorePlaylist) {
      await loadMorePlaylist(topic, myLoadId);
      if (myLoadId !== activeLoadId) return;

      // Exact match: videoId + postNumber
      let idx = pipState.playlist.findIndex(
        (v) => v.videoId === videoId && v.postNumber === pipState.sourcePostNumber
      );

      if (idx >= 0) {
        pipState.currentPlaylistIndex = idx;
        // We only update the meta if it's the exact same post
        // (not a different post with the same video)
        if (pipState.playlist[idx].postNumber === pipState.sourcePostNumber) {
          pipState.currentItem = pipState.playlist[idx];
        }
        found = true;
      }
    }

    // If we didn't find it exactly: keep the DOM meta,
    // and set the index to the end of the playlist so that "next" continues from there
    if (!found && myLoadId === activeLoadId) {
      // Add the clicked video to the beginning of the playlist as "current"
      // so that the next/prev logic starts from there
      const syntheticItem = {
        videoId,
        startSeconds: start,
        videoTitle: domMeta?.videoTitle || i18n(themePrefix("discourse_pip.unknown_title")),
        postId,
        postNumber: pipState.sourcePostNumber,
        username: domMeta?.username || i18n(themePrefix("discourse_pip.anonymous")),
        avatarUrl: domMeta?.avatarUrl || null,
      };
      // Find the closest position in the playlist based on postNumber
      // so that next is in the correct order
      let insertAt = 0;
      if (pipState.sourcePostNumber) {
        for (let i = 0; i < pipState.playlist.length; i++) {
          if (pipState.playlist[i].postNumber > pipState.sourcePostNumber) break;
          insertAt = i + 1;
        }
      }
      pipState.playlist.splice(insertAt, 0, syntheticItem);
      pipState.currentPlaylistIndex = insertAt;
    }

    // Continue Prefetch in the background
    if (myLoadId === activeLoadId && pipState.hasMorePlaylist) {
      loadMorePlaylist(topic, myLoadId);
    }
  }

  // ── onPageChange ──────────────────────────────────────────────────────────

  api.onPageChange(() => {
    if (!pipState.sourceTopicId || !pipState.visible) {
      setTimeout(() => injectButtons(document), 600);
      return;
    }

    const topic = getCurrentTopic();
    if (!topic) return;

    if (topic.id === pipState.sourceTopicId) {
      resetState();
      pipState.visible = false;
      setTimeout(() => {
        restoreOriginalEmbed();
        pipState.currentItem = null;
        pipState.videoId = null;
        pipState.embedUrl = null;
        pipState.sourceTopicId = null;
        pipState.sourceTopicSlug = null;
        pipState.sourcePostNumber = null;
        injectButtons(document);
      }, 400);
    } else {
      setTimeout(() => injectButtons(document), 600);
    }
  });

  // ── Button injection ──────────────────────────────────────────────────────

  let injectTimer = null;

  function scheduleInject(root) {
    clearTimeout(injectTimer);
    injectTimer = setTimeout(() => injectButtons(root), 200);
  }

  function injectButtons(root) {
    // Thumbnail 404 fix
    root
      .querySelectorAll(".lazy-video-container img[src*='maxresdefault']:not([data-pip-thumb-fixed])")
      .forEach((img) => {
        img.dataset.pipThumbFixed = "true";
        img.onerror = function () {
          this.onerror = null;
          this.src = this.src.replace("maxresdefault", "hqdefault");
        };
      });

    // 1. lazy-video-container
    root
      .querySelectorAll(".lazy-video-container.youtube-onebox:not([data-pip-bound])")
      .forEach((wrapper) => {
        wrapper.dataset.pipBound = "true";
        if (!wrapper.dataset.videoId) return;

        const btn = document.createElement("button");
        btn.className = "pip-launch-btn";
        btn.setAttribute("aria-label", i18n(themePrefix("discourse_pip.open_in_pip")));
        btn.innerHTML = `${iconHTML("window-restore")}<span>${i18n(themePrefix("discourse_pip.mini_player"))}</span>`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          launchPip(wrapper.dataset.videoId, parseInt(wrapper.dataset.videoStartTime || "0", 10), wrapper);
        });

        wrapper.style.position = "relative";
        wrapper.appendChild(btn);
      });

    // 2. Direct iframe.youtube-onebox
    root
      .querySelectorAll("iframe.youtube-onebox:not([data-pip-bound])")
      .forEach((iframe) => {
        const m = iframe.src?.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
        if (!m) return;
        const videoId = m[1];
        iframe.dataset.pipBound = "true";

        const wrapper = document.createElement("div");
        wrapper.className = "pip-iframe-wrapper";
        wrapper.style.cssText = `position:relative;display:block;width:${iframe.width ? iframe.width + "px" : "100%"};aspect-ratio:${iframe.width && iframe.height ? `${iframe.width}/${iframe.height}` : "16/9"}`;
        iframe.parentNode.insertBefore(wrapper, iframe);
        wrapper.appendChild(iframe);
        iframe.style.cssText = "width:100%;height:100%";

        const btn = document.createElement("button");
        btn.className = "pip-launch-btn";
        btn.setAttribute("aria-label", i18n(themePrefix("discourse_pip.open_in_pip")));
        btn.innerHTML = `${iconHTML("window-restore")}<span>${i18n(themePrefix("discourse_pip.mini_player"))}</span>`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          e.preventDefault();
          launchPip(videoId, 0, wrapper);
        });
        wrapper.appendChild(btn);
      });
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes.length) { scheduleInject(document); break; }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => injectButtons(document), 800);
});
