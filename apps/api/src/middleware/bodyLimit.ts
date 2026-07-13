/**
 * Per-route request body-size limits.
 *
 * The global default is intentionally tight (1MB). Routes that legitimately
 * accept larger payloads (binary/dev-push, file-browser uploads, software
 * package installers) are carved out explicitly here so the
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
  // File browser uploads send base64-encoded content in JSON body (~33%
  // overhead). The agent caps file_write at 4MB decoded (~5.6MB base64, see
  // fileUploadBodySchema); 8MB covers that plus JSON envelope/escaping.
  if (path.match(/^\/api\/v1\/system-tools\/devices\/[^/]+\/files\/upload$/)) {
    return { maxSize: 8 * 1024 * 1024, error: 'File too large (max 4MB)' };
  }
  // Software package (installer) uploads are multipart and capped at 500MB by the
  // route's own MAX_UPLOAD_SIZE check; give the body limit headroom over that so the
  // route returns its specific "File too large" message instead of this generic one.
  if (path.match(/^\/api\/v1\/software\/catalog\/[^/]+\/versions\/upload$/)) {
    return { maxSize: 512 * 1024 * 1024, error: 'Package too large (max 500MB)' };
  }
  // Agent command results submitted via the heartbeat/REST fallback leg (used
  // when the WS path is unavailable). commandResultSchema already caps stdout
  // and stderr at 5MB each; without this carve-out a large-but-valid result
  // (e.g. a ~2.8MB capture_pprof profile payload, or big script output) is
  // 413-rejected before the schema runs, the row never completes, and the
  // caller sees a misleading generic timeout (#2401). 12MB covers both capped
  // fields plus JSON escaping/envelope. Agent-authenticated route.
  if (path.match(/^\/api\/v1\/agents\/[^/]+\/commands\/[^/]+\/result$/)) {
    return { maxSize: 12 * 1024 * 1024, error: 'Command result too large (max 12MB)' };
  }
  return { maxSize: 1024 * 1024, error: 'Request body too large' };
}
