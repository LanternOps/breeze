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
/**
 * Stable, closed-set identity for the carve-out branch that matched.
 *
 * #3517: the global gate's 413s were invisible server-side, and the obvious fix
 * (log the path) is exactly what `middleware/requestPathLogger.ts` forbids — the
 * gate runs at `app.use('*')` BEFORE routing, so no bounded matched-route label
 * exists yet. The rule label is bounded by construction, needs no redaction, and
 * is the dimension operators actually want to group on ("which limit is firing,
 * and how often"). Keep it a union type: adding a carve-out below without a
 * label here is a type error, which is the point.
 */
export type BodyLimitRule =
  | 'default'
  | 'dev-push'
  | 'file-upload'
  | 'software-chunk'
  | 'software-package'
  | 'agent-command-result'
  | 'script-bundle'
  | 'image-upload'
  | 'avatar'
  | 'contract-template'
  | 'agent-ingest'
  | 'ticket-attachment'
  // Route-level limits TIGHTER than the global default, so `bodyLimitForPath`
  // never returns them — the route's own gate is the one that answers. They
  // share this namespace so all body-limit 413s group on one tag.
  | 'agent-logs'
  | 'agent-process-sample'
  | 'agent-pam-observation';

export interface BodyLimitPolicy {
  rule: BodyLimitRule;
  maxSize: number;
  error: string;
}

export function bodyLimitForPath(path: string): BodyLimitPolicy {
  // Dev-push uploads agent binaries (~20MB); skip the default 1MB limit.
  if (path.startsWith('/api/v1/dev/push')) {
    return { rule: 'dev-push', maxSize: 150 * 1024 * 1024, error: 'Binary too large (max 150MB)' };
  }
  // File browser uploads send base64-encoded content in JSON body (~33%
  // overhead). The agent caps file_write at 4MB decoded (~5.6MB base64, see
  // fileUploadBodySchema); 8MB covers that plus JSON envelope/escaping.
  if (path.match(/^\/api\/v1\/system-tools\/devices\/[^/]+\/files\/upload$/)) {
    return { rule: 'file-upload', maxSize: 8 * 1024 * 1024, error: 'File too large (max 4MB)' };
  }
  // Chunked software package uploads (#2951): each chunk is a raw
  // application/octet-stream body of at most 8MB (client UPLOAD_CHUNK_SIZE,
  // server-validated chunk_size cap). 9MB headroom lets the route's own
  // per-chunk limit answer with its specific message instead of this one.
  if (path.match(/^\/api\/v1\/software\/catalog\/[^/]+\/versions\/uploads\/[^/]+\/chunks$/)) {
    return { rule: 'software-chunk', maxSize: 9 * 1024 * 1024, error: 'Chunk too large (max 8MB)' };
  }
  // Software package (installer) uploads are multipart and capped at 500MB by the
  // route's own MAX_UPLOAD_SIZE check; give the body limit headroom over that so the
  // route returns its specific "File too large" message instead of this generic one.
  if (path.match(/^\/api\/v1\/software\/catalog\/[^/]+\/versions\/upload$/)) {
    return {
      rule: 'software-package',
      maxSize: 512 * 1024 * 1024,
      error: 'Package too large (max 500MB)',
    };
  }
  // Ticket comment attachments (W08 #3902): one multipart file per request,
  // capped at 10 MiB by TICKET_ATTACHMENT_LIMITS.maxBytes and by the
  // ticket_attachments_size_chk CHECK. Without this carve-out every upload
  // 413s at the global 1 MB gate before the route's own check ever runs
  // (#3482 class). The 64 KiB headroom covers the multipart envelope so the
  // route's specific ATTACHMENT_TOO_LARGE message wins.
  if (path.match(/^\/api\/v1\/tickets\/[^/]+\/attachments$/)) {
    return {
      rule: 'ticket-attachment',
      maxSize: 10 * 1024 * 1024 + 64 * 1024,
      error: 'Attachment too large (max 10 MB)',
    };
  }
  // Agent command results submitted via the heartbeat/REST fallback leg (used
  // when the WS path is unavailable). commandResultSchema already caps stdout
  // and stderr at 5MB each; without this carve-out a large-but-valid result
  // (e.g. a ~2.8MB capture_pprof profile payload, or big script output) is
  // 413-rejected before the schema runs, the row never completes, and the
  // caller sees a misleading generic timeout (#2401). 12MB covers both capped
  // fields plus JSON escaping/envelope. Agent-authenticated route.
  if (path.match(/^\/api\/v1\/agents\/[^/]+\/commands\/[^/]+\/result$/)) {
    return {
      rule: 'agent-command-result',
      maxSize: 12 * 1024 * 1024,
      error: 'Command result too large (max 12MB)',
    };
  }
  // Script bundle import/preview (#3245): a bundle carries whole script
  // libraries (up to 200 scripts x 256KB content, both capped by the bundle
  // schema). 20MB is the effective total-bundle cap; the schema's per-field
  // caps answer with specific messages below it.
  if (path === '/api/v1/scripts/bundle/import' || path === '/api/v1/scripts/bundle/preview') {
    return { rule: 'script-bundle', maxSize: 20 * 1024 * 1024, error: 'Bundle too large (max 20MB)' };
  }
  // Multipart image/document uploads that the UI advertises at 5 MB (10 MB for
  // contract templates). Each of these routes already registers its OWN
  // `bodyLimit` sized to its cap + 64KB multipart slack, but a route-level
  // limit can only ever make a path TIGHTER, never looser: this global gate
  // runs at `app.use('*')` before any route is mounted, so without a carve-out
  // here every one of them 413s at 1MB with the generic message (#3482 for
  // quote images; same shape as #1377). Sizes below MUST stay >= the route's
  // own limit — where the two are equal this gate answers first, so the message
  // here is the one callers see and should read the same as the route's. The
  // 64KB slack covers multipart part headers and boundaries on top of the raw
  // file bytes.
  if (
    path.match(/^\/api\/v1\/quotes\/[^/]+\/images$/) ||
    path.match(/^\/api\/v1\/catalog\/[^/]+\/image$/)
  ) {
    return {
      rule: 'image-upload',
      maxSize: 5 * 1024 * 1024 + 64 * 1024,
      error: 'Image too large (max 5 MB)',
    };
  }
  if (path === '/api/v1/users/me/avatar') {
    return {
      rule: 'avatar',
      maxSize: 5 * 1024 * 1024 + 64 * 1024,
      error: 'Avatar file too large (max 5 MB)',
    };
  }
  if (path.match(/^\/api\/v1\/contracts\/contract-templates\/[^/]+\/versions\/upload$/)) {
    return {
      rule: 'contract-template',
      maxSize: 10 * 1024 * 1024 + 64 * 1024,
      error: 'File exceeds the 10MB upload limit',
    };
  }
  // Agent inventory/heartbeat ingest (#3516). Every one of these routes already
  // registers its OWN `bodyLimit({ maxSize: 5MB })` — hardware/software/disks/
  // network (routes/agents/inventory.ts), heartbeat (heartbeat.ts) and
  // connections (connections.ts) — but a route-level limit can only make a path
  // TIGHTER, never looser: this gate runs at `app.use('*')` before any route is
  // mounted, so without a carve-out here they all 413 at the 1MB default. That
  // fired silently in the field: a Linux host with 2,500-4,000 dpkg/rpm packages
  // (schema cap: 10,000 items, ~4.5MB) exceeds 1MB, the agent's 413 is not
  // retryable and its error is discarded, and software inventory goes
  // permanently stale with no server- or agent-side signal.
  //
  // 5MB matches what every one of these routes already declared, so the intent
  // is on record, not a new capacity decision — it sizes the byte gate so the
  // schema's 10,000-item cap is the limit that actually binds. Explicit
  // final-segment allowlist (not a broad `agents/:id/.*`) so it does NOT match
  // `/monitoring-results` (deliberately 1MB in heartbeat.ts) or the already
  // carved-out `/commands/:id/result` above.
  if (path.match(/^\/api\/v1\/agents\/[^/]+\/(hardware|software|disks|network|connections|heartbeat)$/)) {
    return { rule: 'agent-ingest', maxSize: 5 * 1024 * 1024, error: 'Request body too large' };
  }
  return { rule: 'default', maxSize: 1024 * 1024, error: 'Request body too large' };
}
