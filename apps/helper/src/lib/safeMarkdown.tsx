/**
 * Shared react-markdown `img`/`a` component overrides for AI-authored
 * markdown rendered in the helper chat panel.
 *
 * The default react-markdown `img` renderer emits a plain `<img src>`, which
 * loads unconditionally the moment the DOM node mounts — no click, no
 * confirmation. Any `https://` URL the model streams (whether from the
 * user's own prompt or from tool-returned text) would cause an immediate,
 * silent GET request carrying whatever the model encoded in the URL. That is
 * an exfiltration channel, not a rendering feature.
 *
 * Mirrors `apps/web/src/lib/safeMarkdownImage.tsx` — duplicated locally
 * rather than imported cross-app, since `apps/helper` does not depend on
 * `apps/web`.
 */
import type { ReactNode } from 'react';

/** Only `http(s)` survives as a link; every other scheme (`javascript:`,
 *  `data:`, a bare relative path) is treated as unsafe. */
export function isSafeHttpUrl(url: string | undefined | null): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Renders a model-authored markdown image as a click-through link instead of
 * an auto-loading `<img>`. Non-http(s) sources (or a missing source) render
 * as inert text so nothing resolvable ever reaches the DOM unclicked.
 */
export function SafeMarkdownImage({ src, alt }: { src?: string; alt?: ReactNode }) {
  const label = typeof alt === 'string' && alt.trim().length > 0 ? alt : src;
  if (!isSafeHttpUrl(src)) {
    return <span>{label ?? ''}</span>;
  }
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      {label ?? src}
    </a>
  );
}

/**
 * Renders a model-authored markdown link, neutralizing any non-http(s)
 * scheme (`javascript:`, `data:`, …) to `#` so it cannot execute on click.
 */
export function SafeMarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a href={isSafeHttpUrl(href) ? href : '#'} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
