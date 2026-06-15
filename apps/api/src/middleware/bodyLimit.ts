/**
 * Per-route request body-size limits.
 *
 * The global default is intentionally tight (1MB). Routes that legitimately
 * accept larger payloads (binary/dev-push, file-transfer chunks, file-browser
 * uploads, software package installers) are carved out explicitly here so the
 * global gate doesn't reject them with a generic 413 before their own
 * route-level size checks ever run.
 *
 * Kept as a pure function (no Hono/server imports) so it can be unit-tested
 * without booting the API.
 */
export function bodyLimitForPath(path: string): { maxSize: number; error: string } {
  // Dev-push uploads agent binaries (~20MB); skip the default 1MB limit.
  if (path.startsWith('/api/v1/dev/push')) {
    return { maxSize: 150 * 1024 * 1024, error: 'Binary too large (max 150MB)' };
  }
  // File transfer chunk uploads can be up to 50MB; route-level bodyLimit handles the real cap.
  if (path.match(/^\/api\/v1\/remote\/transfers\/[^/]+\/chunks$/)) {
    return { maxSize: 50 * 1024 * 1024, error: 'Chunk too large (max 50MB)' };
  }
  // File browser uploads send base64-encoded content in JSON body (~33% overhead).
  if (path.match(/^\/api\/v1\/system-tools\/devices\/[^/]+\/files\/upload$/)) {
    return { maxSize: 50 * 1024 * 1024, error: 'File too large (max ~37MB)' };
  }
  // Software package (installer) uploads are multipart and capped at 500MB by the
  // route's own MAX_UPLOAD_SIZE check; give the body limit headroom over that so the
  // route returns its specific "File too large" message instead of this generic one.
  if (path.match(/^\/api\/v1\/software\/catalog\/[^/]+\/versions\/upload$/)) {
    return { maxSize: 512 * 1024 * 1024, error: 'Package too large (max 500MB)' };
  }
  return { maxSize: 1024 * 1024, error: 'Request body too large' };
}
