import { tracked } from "@glimmer/tracking";

class PipState {
  @tracked visible = false;
  @tracked panelOpen = false;
  @tracked videoId = null;
  @tracked embedUrl = null;
  @tracked currentItem = null;
  @tracked sourceTopicId = null;
  @tracked sourceTopicSlug = null;
  @tracked sourcePostNumber = null;
  @tracked loadingPlaylist = false;

  // Not tracked
  iframeEl = null;
  triggerEl = null;
  originalEmbed = null;
  playlist = [];
  currentPlaylistIndex = -1;
  playlistCursor = 0;
  playlistStartOffset = 0;  // from where the loading started (for wrap-around)
  playlistWrapped = false;  // it already gotten around
  hasMorePlaylist = true;
  seen = new Set();

  requestNext = null;
  requestClose = null;
}

const pipState = new PipState();
export default pipState;
