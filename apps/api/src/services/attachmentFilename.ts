/**
 * Client-filename helpers shared by every byte surface that echoes a stored
 * filename back in a `Content-Disposition` header (ticket attachments W08
 * #3902; org documents, service deliverables W03). A leaf module on purpose:
 * services must not import route modules to reach them.
 */

/**
 * Reduce a client-supplied filename to a safe BASENAME.
 *
 * This value is echoed in the `Content-Disposition` header by the content
 * route, so a quote, backslash, CR or LF here is a header-injection vector —
 * they are removed outright rather than escaped. Path separators are dropped
 * (only the last segment survives) so nothing resembling a traversal is ever
 * persisted. Empty results fall back to a constant.
 */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return cleaned.slice(0, 255).trim() || 'attachment';
}

/**
 * Build the D7 `Content-Disposition` value. The filename is re-sanitised on the
 * way OUT as well as on the way in: a quote or CRLF reaching this header is a
 * response-splitting vector, and defence here does not depend on every row
 * having been written by the current upload route.
 */
export function contentDispositionFor(contentType: string, filename: string): string {
  const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment';
  const safe = sanitizeAttachmentFilename(filename);
  // A Node header value must be latin-1 — anything above U+00FF throws
  // ERR_INVALID_CHAR and 500s this route, which would make an ordinary upload
  // called `写真.png` permanently unreadable. So the quoted-string form carries an
  // ASCII-only fallback and the real name rides in the RFC 5987 `filename*`
  // parameter, which every current browser prefers.
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '') || 'attachment';
  // encodeURIComponent leaves !'()* unescaped; they are not RFC 5987
  // attr-chars, so escape them too.
  const encoded = encodeURIComponent(safe).replace(
    /['()!*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
