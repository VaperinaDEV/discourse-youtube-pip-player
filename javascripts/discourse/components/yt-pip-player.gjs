import Component from "@glimmer/component";
import { tracked } from "@glimmer/tracking";
import { action } from "@ember/object";
import { service } from "@ember/service";
import { on } from "@ember/modifier";
import didInsert from "@ember/render-modifiers/modifiers/did-insert";
import willDestroy from "@ember/render-modifiers/modifiers/will-destroy";
import DButton from "discourse/components/d-button";
import icon from "discourse-common/helpers/d-icon";
import { i18n } from "discourse-i18n";
import pipState from "../lib/pip-state";
import DiscourseURL from "discourse/lib/url";

const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default class YtPipPlayer extends Component {
  @service router;

  @tracked progressOffset = CIRCUMFERENCE;

  get state() { return pipState; }
  get isVisible() { return pipState.visible && pipState.videoId; }
  get panelOpen() { return pipState.panelOpen; }
  get dashOffset() { return this.progressOffset; }

  // ── iframe ───────────────────────────────────────────────────────────────
  @action
  setupIframe(el) {
    pipState.iframeEl = el;
    el.onload = () => {
      // We send the listening event once - the YouTube API then
      // sends the infoDelivery messages on its own. No polling required.
      el.contentWindow?.postMessage('{"event":"listening"}', "*");
    };
  }

  @action
  teardownIframe() {
    pipState.iframeEl = null;
  }

  // Progress callback – called by the initializer based on postMessage
  updateProgress(current, duration) {
    if (!duration || duration <= 0) return;
    const newOffset = CIRCUMFERENCE * (1 - Math.min(current / duration, 1));
    // Only if there is a significant change – do not trigger Glimmer render below 0.5px
    if (Math.abs(this.progressOffset - newOffset) > 0.5) {
      this.progressOffset = newOffset;
    }
  }

  // ── Trigger ──────────────────────────────────────────────────────────────
  @action
  setupTrigger(el) {
    pipState.triggerEl = el;
    pipState.updateProgress = (cur, dur) => this.updateProgress(cur, dur);
  }

  @action
  teardownTrigger() {
    pipState.triggerEl = null;
    pipState.updateProgress = null;
  }

  @action
  togglePanel() {
    pipState.panelOpen = !pipState.panelOpen;
    if (pipState.panelOpen) {
      requestAnimationFrame(() => {
        const trigger = pipState.triggerEl;
        const panel = document.querySelector(".discourse-pip-panel");
        if (!trigger || !panel) return;
        const rect = trigger.getBoundingClientRect();
        panel.style.left = rect.left + "px";
        panel.style.top = (rect.bottom + 6) + "px";
      });
    }
  }

  @action
  jumpToSource() {
    if (!pipState.sourceTopicId) return;
    const currentTopicId = this.router.currentRoute?.attributes?.id;
    if (currentTopicId === pipState.sourceTopicId && pipState.sourcePostNumber) {
      document
        .querySelector(`[data-post-number="${pipState.sourcePostNumber}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const base = pipState.sourceTopicSlug
      ? `/t/${pipState.sourceTopicSlug}/${pipState.sourceTopicId}`
      : `/t/-/${pipState.sourceTopicId}`;
    DiscourseURL.routeTo(
      pipState.sourcePostNumber ? `${base}/${pipState.sourcePostNumber}` : base
    );
  }

  @action playNext() { pipState.requestNext?.(); }
  @action close() { pipState.requestClose?.(); }

  <template>
    {{#if this.isVisible}}

      <div
        class="pip-header-wrap"
        {{didInsert this.setupTrigger}}
        {{willDestroy this.teardownTrigger}}
      >
        <button
          type="button"
          class="pip-trigger {{if this.panelOpen 'pip-trigger--open'}}"
          title={{i18n (themePrefix "discourse_pip.toggle_player")}}
          {{on "click" this.togglePanel}}
        >
          <span class="pip-trigger-avatar">
            <svg class="pip-progress-ring" viewBox="0 0 40 40">
              <circle class="pip-progress-bg"   cx="20" cy="20" r={{RADIUS}} fill="none" stroke-width="3" />
              <circle class="pip-progress-fill" cx="20" cy="20" r={{RADIUS}} fill="none" stroke-width="3"
                stroke-dasharray={{CIRCUMFERENCE}}
                stroke-dashoffset={{this.dashOffset}}
                stroke-linecap="round"
              />
            </svg>
            {{#if this.state.currentItem.avatarUrl}}
              <img src={{this.state.currentItem.avatarUrl}} alt="" />
            {{else}}
              <span class="pip-trigger-icon">{{icon "circle-play"}}</span>
            {{/if}}
          </span>
        </button>

        <button
          type="button"
          class="pip-close-trigger"
          title={{i18n (themePrefix "discourse_pip.close")}}
          {{on "click" this.close}}
        >
          {{icon "xmark"}}
        </button>
      </div>

      <div class="discourse-pip-panel {{if this.panelOpen 'pip-panel--open'}}">
        <div class="pip-panel-header">
          {{#if this.state.currentItem}}
            <div class="pip-meta">
              {{#if this.state.currentItem.avatarUrl}}
                <img src={{this.state.currentItem.avatarUrl}} class="pip-avatar" alt="" />
              {{else}}
                <div class="pip-avatar-placeholder">{{icon "user"}}</div>
              {{/if}}
              <div class="pip-user-info">
                <span class="pip-username">@{{this.state.currentItem.username}}</span>
                <span class="pip-video-title">{{this.state.currentItem.videoTitle}}</span>
              </div>
            </div>
          {{/if}}
          <div class="pip-controls">
            <DButton
              @icon="forward-step"
              @action={{this.playNext}}
              @translatedTitle={{i18n (themePrefix "discourse_pip.next_video")}}
              class="pip-btn" 
            />
            <DButton
              @icon="arrow-up-right-from-square"
              @action={{this.jumpToSource}}
              @translatedTitle={{i18n (themePrefix "discourse_pip.jump_to_post")}}
              class="pip-btn"
            />
            <DButton
              @icon="chevron-down"
              @action={{this.togglePanel}}
              @translatedTitle={{i18n (themePrefix "discourse_pip.hide_panel")}}
              class="pip-btn" 
            />
          </div>
        </div>

        <div class="pip-panel-body">
          <iframe
            {{didInsert this.setupIframe}}
            {{willDestroy this.teardownIframe}}
            id="discourse-pip-iframe"
            src={{this.state.embedUrl}}
            frameborder="0"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowfullscreen
          ></iframe>
        </div>
      </div>

    {{/if}}
  </template>
}
