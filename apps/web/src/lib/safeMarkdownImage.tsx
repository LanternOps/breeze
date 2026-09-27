/**
 * Shared react-markdown `img` component override for AI-authored markdown.
 *
 * The default react-markdown `img` renderer emits a plain `<img src>`, which
 * loads unconditionally the moment the DOM node mounts — no click, no
 * confirmation. Combined with the web CSP's `img-src https:`, any
 * `https://` URL the model streams (whether from the user's own prompt or
 * from tool-returned text such as a device log line) causes an immediate,
 * silent GET request carrying whatever the model encoded in the URL. That is
 * an exfiltration channel, not a rendering feature.
 *
 * Used by AiChatMessages and ScriptAiMessages, the two panels that render
 * full (non-allowlisted) AI-authored markdown. RunDetailPage's run-summary
 * renderer takes a narrower approach (a strict `allowedElements` list that
 * omits `img` entirely); this override is for panels that otherwise keep the
 * full GFM element set.
 */
import type { ReactNode } from "react";

/** Only `http(s)` survives as a link; every other scheme (`javascript:`,
 *  `data:`, a bare relative path) is treated as unsafe. */
export function isSafeHttpUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * Renders a model-authored markdown image as a click-through link instead of
 * an auto-loading `<img>`. Non-http(s) sources (or a missing source) render
 * as inert text so nothing resolvable ever reaches the DOM unclicked.
 */
export function SafeMarkdownImage({
  src,
  alt,
}: {
  src?: string;
  alt?: ReactNode;
}) {
  const label = typeof alt === "string" && alt.trim().length > 0 ? alt : src;
  if (!isSafeHttpUrl(src)) {
    return <span>{label ?? ""}</span>;
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      {label ?? src}
    </a>
  );
}
