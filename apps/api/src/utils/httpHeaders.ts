// HTTP header helpers shared across routes.

/**
 * Sanitize a filename for use inside a quoted Content-Disposition value.
 * Strips CR/LF (header-injection) and escapes backslash + double-quote so the
 * quoted-string can't be broken out of. Same pattern as systemTools/fileBrowser.
 */
export function safeContentDispositionFilename(name: string): string {
  return name
    // Disallow header injection via CRLF.
    .replace(/[\r\n]/g, '')
    // Escape quoted-string backslashes and quotes.
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}
