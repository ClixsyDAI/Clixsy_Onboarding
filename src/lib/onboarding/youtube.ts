// =============================================================
// YouTube URL helpers
// =============================================================
//
// One parser for the tutorial-video URLs in TUTORIAL_VIDEOS. Previously
// the same logic was copy-pasted in AccessChecklistStep, StepRenderer,
// and (a third, slightly-different variant) the welcome wizard — which
// meant an `embed/`-form URL played in one place and silently vanished
// in another. Pure string functions, safe to import from client
// components.

/** Extract the 11-ish-char video id from any youtu.be / watch / embed URL. */
export function youTubeId(url: string): string | null {
  const short = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  if (short) return short[1];
  const watch = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
  if (watch) return watch[1];
  const embed = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]+)/);
  if (embed) return embed[1];
  return null;
}

/** Embed URL for an `<iframe>`, or null when the URL isn't recognisable. */
export function youTubeEmbedUrl(url: string): string | null {
  const id = youTubeId(url);
  return id ? `https://www.youtube.com/embed/${id}` : null;
}
