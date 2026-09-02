---
tracking_issue: LanternOps/breeze#3206
wave: W08
wave_issue: LanternOps/breeze#3902
---

# Photo and File Attachments on Ticket Comments (Mobile + Web) — Design Spec

**Date:** 2026-08-29
**Wave:** W08 (`LanternOps/breeze#3902`) of parent feature `LanternOps/breeze#3206` "Ticketing and time entry in the mobile app".
**Status:** Drafted — synthesised from three competing design attempts (mvp-first, codex-design, risk-first) and two judge reviews (Claude, Codex) that disagreed on the winner; the tie-break is in §11.
**Depends on:** W03–W05 conventions in `docs/superpowers/plans/mobile/2026-08-23-mobile-time-entry.md` (mobile `coreRequest` single transport, service-file + co-located tests, no new store slices for detail screens, `useNetworkConnected`).

Evidence labels: **[verified]** = read at file:line on origin/main 2026-08-29; **[inferred]** = reasoned from verified facts; **[not-checked]** = must be confirmed during implementation.

## Goal

A field tech attaches a photo (camera or library) or a PDF to a ticket comment from the phone. The attachment renders in the ticket feed on mobile, on web, and (public comments only) in the customer portal. Web techs can upload too. Self-hosters without S3 get the same feature.

## Non-goals

- Ticket-level (comment-less) attachments as a product concept. `comment_id IS NULL` means "pending upload" only.
- Portal customer uploads (read-only render in v1).
- Office documents, SVG, HTML, video. HEIC is transcoded on-device and rejected server-side.
- Queued / background upload when offline. Attachments never enter the W03 time-entry queue.
- Server-side EXIF stripping (would add `sharp`; **[verified]** not a dependency of `apps/api`).
- Reusing or dropping the unused `ticket_comments.attachments jsonb` column (**[verified]** `schema/portal.ts:127`). It is ignored; dropping it is a separate cleanup migration.
- Fixing the pre-existing `ticket_comments` org-erasure FK gap (**[verified]** `ticket_comments` has no entry in `services/tenantCascade.ts`; `0001-baseline.sql` FK to `tickets` is `NO ACTION`) — **[inferred]** org erasure with comments may already raise 23503. File separately after a live-DB check; W08's own `ON DELETE CASCADE` FKs neither depend on nor worsen it.
- A GDPR export bundle containing attachment bytes (metadata rows only in v1).

## Decisions

**D1 — Storage: metadata row in Postgres; bytes in platform S3 when `isS3Configured()`, else `bytea` on the same row.**
Rationale: every existing tenant image store (avatars, quote images, catalog images) is `bytea` **[verified]** `avatarStorage.ts`, `quoteImageStorage.ts`, `catalogImageStorage.ts`), but those are single small images per entity. Ticket photos are multi-per-comment and up to 10 MB each; on hosted (where S3 is always configured — memory: uploads → DO Spaces) putting that into Postgres inflates WAL, backups and the tenant-export roundtrip from day one. Pure S3 is dead on self-host: `S3_BUCKET` is optional and the only precedent is a hard 503 (**[verified]** `routes/softwareUploads.ts:205-206`), unacceptable for core ticketing. The row carries `storage_backend` (`'s3' | 'db'`) so rows written before an operator later configures S3 keep serving. Local disk rejected: avatars were deliberately moved off the filesystem (#1059) and hosted API is multi-replica.
Rejected: bytea-only with an S3 seam later (mvp-first) — the seam columns cost the same export-policy entries now, and the backfill it defers is the expensive part.

**D2 — Upload protocol: two-step. `POST /tickets/:id/attachments` (one file per request, multipart) returns a pending attachment id; `POST /tickets/:id/comments` (existing JSON) carries `attachmentIds[]` and claims them inside the comment transaction.**
Rationale: (a) S3 puts cannot live inside a DB transaction, so a single atomic multipart comment route would still need compensation logic; two-step puts the object write in its own request where put-before-insert plus a compensating delete is natural. (b) The existing JSON `addTicketCommentSchema` (**[verified]** `packages/shared/src/validators/tickets.ts:131`) stays JSON; no content-type branching in a shared validator. (c) One file per request gives "2 of 3" progress and per-file retry for free, and web/mobile share one contract. (d) `addTicketComment` writes with the global `db` (**[verified]** `ticketService.ts:999,1015`); the claim is one extra `UPDATE` in a transaction that must be introduced anyway — the single-step design needed the same tx threading plus buffering 20 MB per request.
Cost: pending rows and an hourly jittered reaper (§Backend flow). Accepted.
Rejected: presigned PUT to S3 — the platform client is operator-scoped (`getS3Client`, **[verified]** `s3Storage.ts`), phones cannot be trusted to honour size/type, it bypasses sniffing/RLS/audit and does not exist on self-host. `guardedS3Client.ts` is irrelevant: it guards tenant-supplied backup endpoints only.

**D3 — Mobile transport: `coreRequest` with a `FormData` body; no `expo-file-system` upload task.**
Rationale: `requestWithPrefix` hardcodes `Content-Type: application/json` (**[verified]** `apps/mobile/src/services/api.ts:248`); add a branch that omits it when `body instanceof FormData` (web precedent **[verified]** `apps/web/src/stores/auth.ts:1059-1064`). This keeps Bearer, CSRF, device-id, session-generation and `device_blocked` handling on the single transport the W03 plan mandates. Byte-level progress is dropped: photos are resized on-device to 0.5–2 MB, and one-file-per-request already yields "Sending 2 of 3". Per-request timeout 120 s.
Rejected: `FileSystem.createUploadTask` (codex-design, risk-first) — a second native network path that re-implements auth headers and misses `device_blocked`/account-switch handling.

**D4 — Accepted types: JPEG, PNG, WebP, PDF. Magic-byte sniffed; client Content-Type ignored.**
Rationale: the brief says "photo … or a file"; PDF costs one `%PDF-` check on top of the existing `sniffImageMime` (**[verified]** `avatarStorage.ts:82`) and `expo-document-picker`. HEIC rejected server-side (browsers cannot render it; mobile transcodes). SVG/HTML never (stored XSS).
Scope cut if the wave must shrink: ship images-only; nothing in the schema or sniffer wrapper changes.

**D5 — Limits: 10 MiB/file, 5 files/comment, 20 pending uploads/user, 30 uploads/min/user (`userRateLimit`, **[verified]** `middleware/userRateLimit.ts`). Mobile resizes images to ≤2048 px long edge JPEG q0.8 before the cap.**
Constants live in `packages/shared` so API, web and mobile share one source. Per-file cap is enforced at three layers: `bodyLimitForPath` carve-out (the global gate only tightens, **[verified]** `middleware/bodyLimit.ts:36-48`), route `bodyLimit`, post-parse check. No per-ticket byte quota in v1 (gold-plating; add if abuse is observed).

**D6 — Visibility is computed from the parent comment (`ticket_comments.is_public`, `deleted_at`), never stored on the attachment.** Pending rows are visible only to their uploader. Portal reads only rows whose parent comment is public and non-deleted on a ticket the portal user submitted.

**D7 — Serving: authenticated byte streaming through the API, never a public or presigned URL.** Same route shape for both backends. `ETag: "<sha256>"` with `If-None-Match` → 304, `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` for `image/*`, `attachment` for PDF. Revisit 302-to-presigned only on measured egress cost.

**D8 — Object keys carry no tenant identifiers: `ticket-attachments/<attachmentId>`.** Org moves (ticket move, device move) re-stamp `org_id` on rows only; objects never move. Consequence: erasure must read keys from rows before deleting rows (D9).
Rejected: `ticket-attachments/<orgId>/<ticketId>/<id>` — stale tenant ids in object paths after a move.

**D9 — Org erasure deletes objects BEFORE rows and aborts (rerunnable) on an object-store fault.** Best-effort deletion with a logged count would leave customer bytes in the bucket with no row left to find them by.

**D10 — Single table; bytea in a nullable `data` column with a CHECK tying it to `storage_backend`.** Postgres TOASTs `bytea` out-of-line and every read path selects an explicit column list (unit test asserts `data` is never selected by feed/list queries). A second `ticket_attachment_blobs` table would double the cascade/export/move registrations for no gain.

**D11 — Server-generated ids; no client idempotency keys.** A retry re-uploads and gets a fresh row; the reaper handles abandonment. Client-generated ids with a key derived from them let a reused id overwrite an object with different bytes (Codex judge finding).

**D12 — `uploaded_by_user_id` nullable, `ON DELETE SET NULL`** (repo norm; keeps the door open for portal uploads).

**D13 — Offline: fail-fast, never queued.** Attach is disabled without connectivity; a comment with pending chips cannot be sent; failed uploads keep the local file with a Retry chip. Draft text and chips live in component state only.

**D14 — `ticket.commented` payload unchanged (`{commentId, isPublic}`)**. No new events; consumers (`eventSubscribers.ts`, `ticketEvents.ts`, `inboundEmail/emailComments.ts`, `aiAgents/ticketHelpdeskSubscriber.ts`) untouched; emails link to the ticket and never embed bytes.

**D15 — EXIF/GPS: mobile picks with `exif: false` and re-encodes JPEG (drops metadata); web uploads keep EXIF in v1 and the composer says so.** This extends the owner's "technician position is never stored server-side" principle from live location to photo metadata for the mobile path.

**D16 — Web upload + render parity ships in this wave; portal is render-only.**

## Data model

Migration: `apps/api/migrations/2026-09-23-ticket-attachments.sql`. **[verified]** `scripts/check-migration-naming.sh` rule 3 requires a new migration to sort strictly after the newest committed file, currently `2026-09-22-ai-alert-verdicts-live-unique.sql`, so `2026-08-29-…` would fail the pre-commit hook and CI. Template: `2026-08-22-ticket-email-links.sql` **[verified]**. Idempotent, no inner `BEGIN/COMMIT`.

```sql
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  ticket_id           uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id          uuid REFERENCES ticket_comments(id) ON DELETE CASCADE,   -- NULL = pending
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  storage_backend     varchar(8)   NOT NULL,       -- 's3' | 'db'
  storage_key         text,                        -- s3 only: 'ticket-attachments/<id>'
  data                bytea,                       -- db only
  content_type        varchar(64)  NOT NULL,       -- sniffed
  byte_size           integer      NOT NULL,
  original_filename   varchar(255) NOT NULL,       -- sanitised basename
  sha256              char(64)     NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  attached_at         timestamptz
);
DO $$ BEGIN ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_backend_chk CHECK (
  (storage_backend = 's3' AND storage_key IS NOT NULL AND data IS NULL) OR
  (storage_backend = 'db' AND data IS NOT NULL AND storage_key IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_size_chk
  CHECK (byte_size > 0 AND byte_size <= 10485760); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_attached_chk
  CHECK ((comment_id IS NULL) = (attached_at IS NULL)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_idx  ON ticket_attachments (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_attachments_comment_idx ON ticket_attachments (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_attachments_pending_idx ON ticket_attachments (uploaded_by_user_id, created_at) WHERE comment_id IS NULL;
CREATE INDEX IF NOT EXISTS ticket_attachments_org_idx     ON ticket_attachments (org_id);
ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments FORCE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS + CREATE POLICY breeze_org_isolation_{select,insert,update,delete}
--   ON ticket_attachments FOR <cmd> TO breeze_app USING/WITH CHECK (public.breeze_has_org_access(org_id))
GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_attachments TO breeze_app;
```

Tenancy shape: **Shape 1** (direct `org_id`, denormalised from `tickets.org_id`). Ticket data, not config — Partner-Wide-First does not apply. No `device_id`, no `partner_id`. RLS coverage is auto-discovered.

Portal DB context: **[verified]** `routes/portal/auth.ts:235-241` wraps handlers in `withDbAccessContext({ scope: 'organization', orgId: user.orgId, … })`, so `breeze_has_org_access(org_id)` admits portal reads; the portal route filters `is_public`/`deleted_at`/`submitted_by` in the app layer as it does for comments. No `withSystemDbAccessContext` fallback needed.

Drizzle: new `apps/api/src/db/schema/ticketAttachments.ts` importing `tickets`/`ticketComments` from `portal.ts` (no reverse import).

### Registration lists (same PR — mechanical grep, not judgement)

| List | File | Entry |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `services/tenantCascade.ts` | `'ticket_attachments'` between `'ticket_alert_links'` (:376) and `'ticket_email_links'` (:383) **[verified]**; FK parents `tickets` (:405) later, `ticket_comments` unlisted → children-first holds |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` beside `ticket_email_links` | see classification below |
| `TICKET_ORG_DENORMALIZED_TABLES` | `services/ticketService.ts:1374` **[verified]** | add `'ticket_attachments'` (ticket move re-stamps `org_id`) |
| `CUSTOM_ORG_REWRITE_TABLES` + UPDATE | `routes/devices/core.ts:219`, `routes/devices/moveOrg.ts` ~:278 **[verified]** | `UPDATE ticket_attachments a SET org_id=$new FROM tickets t WHERE a.ticket_id=t.id AND t.device_id=$dev` |
| `moveOrg.coverage.test.ts` | `routes/devices/` | `toContain('ticket_attachments')` |
| Org-erasure object pre-clear | `services/tenantCascade.ts` | new step before the SQL cascade (D9) |
| `bodyLimitForPath` carve-out | `middleware/bodyLimit.ts` | `/^\/api\/v1\/tickets\/[^/]+\/attachments$/` → `{ rule:'ticket-attachment', maxSize: 10 MiB + 64 KiB, error:'Attachment too large (max 10 MB)' }` |
| Device cascade lists, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`, `AUDIT_ADMIN_REQUIRED_TABLES`, RLS allowlists | — | not applicable (no `device_id`; not append-only; Shape 1 auto-discovered) |

### Export-policy classification (every column)

| Bucket | Columns |
|---|---|
| `included` | `id, org_id, ticket_id, comment_id, uploaded_by_user_id, storage_backend, storage_key, content_type, byte_size, original_filename, sha256, created_at, attached_at` |
| `reviewedIncluded` | none — **[verified]** neither `key` nor `sha256` is in `SUSPICIOUS_NAME_PARTS` (`tenantExportPolicy.ts:35`); precedent `ai_screenshots.storage_key` is `included` (`registry :63`). `hash`/`token` are in the list but `sha256` does not contain them. |
| `excludedSensitive` | none |
| `excludedOpen` | `data` (bytea) |

### Salvaged from alternate designs

Two items from the discarded attempts that D1–D16 do not cover:

- **Optional composite-FK hardening on the denormalised `org_id`.** `org_id` is copied from `tickets.org_id` at upload and re-stamped by two separate move paths; nothing in the DDL above stops the two from diverging. If `tickets` carries (or can idempotently gain) a `UNIQUE (id, org_id)`, add `FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)` in the same migration and the divergence becomes impossible rather than test-covered. Repo precedent for the pattern: `elevation_requests_id_org_id_key` (`2026-05-26-a`, ~:278) and `ai_agent_runs_id_org_id_key` (`2026-09-05-a`:47) [verified (alternate draft) — confirm the `tickets` unique key exists before relying on it]. **[not-checked]** whether `tickets` has that unique key today; if it does not, skip the composite FK and keep the `moveOrg.coverage` assertions as the only guard. Note the composite FK also forces the ticket-move re-stamp and the attachment re-stamp into one statement order — check `moveTicketOrg` before adopting.
- **File:line for the pre-existing `ticket_comments` erasure gap** (listed under Non-goals): the FK is declared at `0001-baseline.sql:14910` with no `ON DELETE` clause, and `grep ticket_comments apps/api/src/services/tenantCascade.ts` returns zero hits [verified (alternate draft)]. Use those two facts when filing the separate issue; W08 still must not depend on the fix.

## API

New `apps/api/src/routes/tickets/attachments.ts`, mounted in `routes/tickets/index.ts` before the generic `/:id` routes. All staff routes: `requireScope('organization','partner','system')` + `getScopedTicketOr404` (**[verified]** exported from `routes/tickets/tickets.ts`).

| Route | Permission | Behaviour |
|---|---|---|
| `POST /tickets/:id/attachments` | `tickets:write`, `userRateLimit('ticket-attachment-upload', 30, 60)` | multipart, exactly one `file` part. 201 `{ data: AttachmentMeta }` with `commentId: null`. Rejects soft-deleted tickets (409 `TICKET_DELETED`). |
| `POST /tickets/:id/comments` (existing) | `tickets:write` | `addTicketCommentSchema` + `attachmentIds: z.array(z.string().uuid()).max(5).default([])`. Content may be empty when ≥1 attachment. Response comment includes `attachments`. |
| `GET /tickets/:id` (existing) | `tickets:read` | each comment gains `attachments: AttachmentMeta[]` (one extra query, grouped in memory; `[]` on deleted comments). |
| `GET /tickets/:id/attachments/:attachmentId/content` | `tickets:read` | streams bytes with D7 headers. 404 if attachment not on this ticket, or parent comment deleted (unless `tickets:manage`), or pending and not the uploader. |
| `DELETE /tickets/:id/attachments/:attachmentId` | `tickets:write` for own pending / own comment; `tickets:manage` for any | hard delete: object first, then row. |
| `GET /portal/tickets/:id` (existing) | portal session + `portalTicketsEnabledMiddleware` | public, non-deleted comments gain `attachments`. |
| `GET /portal/tickets/:id/attachments/:attachmentId/content` | same | 404 unless `tickets.submitted_by` = portal user AND parent comment `is_public AND deleted_at IS NULL`. |

Shared (`packages/shared`): `TicketAttachmentMeta = { id, commentId, contentType, byteSize, originalFilename, createdAt }` — never `storageKey`, `storageBackend`, `sha256`, `data`. `TICKET_ATTACHMENT_LIMITS = { maxBytes: 10 MiB, maxPerComment: 5, maxPendingPerUser: 20, allowedMimes: ['image/jpeg','image/png','image/webp','application/pdf'] }`. `TicketComment.attachments?: TicketAttachmentMeta[]`.

Error codes: `ATTACHMENT_TOO_LARGE` 413, `UNSUPPORTED_ATTACHMENT_TYPE` 415, `TOO_MANY_PENDING` 429, `ATTACHMENT_NOT_CLAIMABLE` 409, `TICKET_DELETED` 409, `STORAGE_UNAVAILABLE` 503 (S3 configured but failing — never silently fall back to `db`).

## Backend flow

`apps/api/src/services/ticketAttachmentStorage.ts` (new): `selectBackend()`, `putBytes(id, buf, mime) → { backend, key | data }`, `openBytes(row) → stream|Buffer`, `deleteBytes(row)`, `deleteObjects(keys[])`. `s3Storage.ts` gains `putObjectBuffer(key, buf, contentType, sha256)`, `getObjectStream(key)`, `deleteObjects(keys[])`, all via existing `getS3Client` + `wrapS3Failure` (today `uploadBinary` streams a local path as octet-stream, **[verified]** `:385`). `services/attachmentSniff.ts` wraps `sniffImageMime` + `%PDF-`.

**Upload:** scoped ticket (reject soft-deleted) → `c.req.parseBody({ all: true })` → one `File`, 1..10 MiB → `Buffer` → sniff (415) → pending count for user < 20 (429; soft cap, no lock) → sha256, sanitised basename → `putBytes` → `INSERT` pending row → audit `ticket.attachment.upload { attachmentId, byteSize, contentType }` (no filename: possible PII). Put before insert: a put failure leaves no row; an insert failure triggers a compensating object delete, then rethrows.

**Claim (inside `addTicketComment`, one transaction):** insert comment → `UPDATE ticket_attachments SET comment_id=$c, attached_at=now() WHERE id = ANY($ids) AND ticket_id=$t AND org_id=$o AND comment_id IS NULL AND uploaded_by_user_id=$actor` → assert rowcount = `ids.length` else rollback + 409 → existing first-response/event/outbox writes. Implementation note: `addTicketComment` uses the global `db` today (**[verified]** `:999,1015`); thread a `tx` through the comment, first-response and outbox writes.

**Serve:** scoped ticket → row `WHERE id AND ticket_id` → visibility (D6) → `If-None-Match` short-circuit → `openBytes` → stream with D7 headers.

**Lifecycle:** comment/ticket soft-delete hides attachments (feed `[]`, content 404) and keeps rows/objects so restore is free (no hard-purge worker exists today, **[verified]** grep). Attachment DELETE is hard. Pending reaper: BullMQ repeatable job, **hourly with jitter** (memory: epoch-aligned repeats stampede at 00:01 UTC), `withSystemDbAccessContext`, `comment_id IS NULL AND created_at < now() - interval '24 hours' LIMIT 500`, objects then rows. Org erasure: new pre-step in `tenantCascade.ts` selects `storage_key WHERE org_id=$o AND storage_backend='s3'`, batch-deletes, aborts with a rerunnable error on fault; then the SQL cascade removes rows (bytea goes with them). Org/device move: re-stamp `org_id` via the two registered lists; objects untouched (D8).

**Self-host without S3:** `db` backend, identical limits and routes, no 503, no partner flag. Documented trade-off; a `db → s3` backfill script is a follow-on.

## Mobile flow

Packages (none present, **[verified]** `apps/mobile/package.json`): `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker`, `expo-image`. `app.json`: plugins with `photosPermission`/`cameraPermission` strings; rewrite the leftover `NSCameraUsageDescription` that cites a nonexistent QR scanner (**[verified]** `app.json:19`); Android `CAMERA` (media permission via picker plugin **[not-checked]** for this SDK). Requires a native build, not OTA (memory: Ruby 4 / CocoaPods prebuild breakage is a scheduling risk).

- `services/api.ts`: `requestWithPrefix` omits `Content-Type` when `body instanceof FormData`; export `getAuthImageHeaders()` (Bearer + device-id) for `<Image source={{ uri, headers }}>`; upload calls pass `timeoutMs: 120_000`.
- `services/ticketAttachments.ts` (new): `pickFromCamera()`, `pickFromLibrary()` (`mediaTypes: ['images']`, `quality: 0.8`, `exif: false`, `selectionLimit: 5 - pending`), `pickDocument()` (`application/pdf`), `prepareImage()` (manipulator: ≤2048 px, JPEG q0.8), client size pre-check, `uploadTicketAttachment(ticketId, { uri, name, type })` via `coreRequest` FormData, error mapping to typed `AttachmentUploadError`, `attachmentContentUrl(ticketId, id)`. Tests mock `./api` as `tickets.test.ts` does.
- `services/tickets.ts`: `TicketComment.attachments`, `addTicketComment(id, content, isPublic, attachmentIds?)`.
- `screens/tickets/TicketDetailScreen.tsx`: attach button → action sheet (Take photo / Choose from library / Choose file); each pick prepares then uploads immediately, showing a chip (thumbnail or PDF icon, spinner, remove; failed → Retry). Send disabled while any chip is uploading; comment POST carries the successful ids; on comment failure ids are kept for retry (reaper covers abandonment). Feed: 3-column image grid (`expo-image`, `cachePolicy: 'memory-disk'`, auth headers) + PDF rows (download to cache → share sheet); tap image → `AttachmentViewer` modal in `TicketsStack` (`MainNavigator.tsx`). No store slice changes (detail is component state, **[verified]**).
- Offline (D13): `useNetworkConnected()` false → attach disabled with "Photos need a connection"; in-flight loss → fail-fast, Retry chip. Never written to `timeEntryQueue.ts`.

## Web and portal

- `TicketFeed.tsx`: render `attachments` below content as thumbnails + file chips; bytes via `fetchWithAuth` → blob → object URL, revoked on unmount (`<img src>` cannot carry Bearer; precedent `ProfilePage.tsx` avatar). Lightbox on tap; delete control per permission.
- `TicketComposer.tsx` + `TicketWorkbench.tsx`: file input (`accept` jpeg/png/webp/pdf, ≤5), preview chips, per-file upload through `fetchWithAuth` FormData (**[verified]** skips JSON content-type) wrapped in `runAction`, then comment POST with ids. Strings in all 8 locales; `no-silent-mutations` and locale-parity tests must pass.
- Portal `TicketDetails.tsx` + `portal/lib/api.ts`: render-only for public-comment attachments via the portal content route (cookie session may permit plain `<img>` **[not-checked]**; fall back to blob fetch).

## Failure modes

| Failure | Behaviour |
|---|---|
| Body > 10 MiB | 413 at gate carve-out (same message as route); without the carve-out every upload would 413 at the 1 MB global gate (#3482 class) |
| Unsupported / HEIC / spoofed type | 415; mobile hint "Photos (JPEG/PNG/WebP) and PDFs only" |
| S3 put fails (configured) | 503 `STORAGE_UNAVAILABLE`; no row; never falls back to `db` |
| Insert fails after put | compensating object delete, error rethrown |
| Comment POST fails after uploads | pending rows kept; client retries with same ids; reaper at 24 h |
| Claim rowcount mismatch (foreign / already-claimed / other ticket) | 409, comment rolled back |
| Object missing at serve | 404 + error log |
| Expired token on `<Image>` | 401 → next API call refreshes; thumbnail retries |
| Comment soft-deleted | feed `[]`, content 404 (manage may still open), rows kept for restore |
| Org erasure with object store down | erasure aborts with rerunnable error; no orphan bytes |
| Org / device move | rows re-stamped; objects untouched |
| Phone offline | attach disabled; in-flight → Retry chip; nothing queued |
| Self-host without S3 | `db` backend |

## Testing

**Unit (Test API job):** `routes/tickets/attachments.test.ts` (scope/permission, foreign-ticket 404, wrong-ticket 404, pending-not-uploader 404, deleted-parent 404 vs manage, size/type/one-part rejections, ETag 304, D7 headers, DELETE ownership); `services/attachmentSniff.test.ts` (table-driven incl. HEIC→null, PDF); `services/ticketAttachmentStorage.test.ts` (backend selection, put-before-insert, compensating delete, `STORAGE_UNAVAILABLE` never falls back, feed/list queries never select `data` — assert compiled SQL); `services/ticketService.test.ts` (claim UPDATE compiled SQL contains `comment_id IS NULL` and `uploaded_by_user_id`; rowcount mismatch rolls back; `TICKET_ORG_DENORMALIZED_TABLES` includes the table); `middleware/bodyLimit.test.ts` carve-out; `routes/devices/moveOrg.coverage.test.ts` + `moveOrg.test.ts`; `routes/portal/tickets.test.ts` (internal-comment attachment never listed/served; `submitted_by` mismatch 404); `autoMigrate.test.ts`; shared validator test (`attachmentIds.max(5)`, limits). Web: `TicketFeed.test.tsx`, `TicketComposer.test.tsx`, locale parity, `no-silent-mutations`. Mobile: `api.test.ts` (FormData → no JSON content-type; Bearer/CSRF/device-id present), `ticketAttachments.test.ts`, `tickets.test.ts`.

**Contract suites (live DB, run explicitly):** `rls-coverage.integration` (auto-discovered), `tenantCascade.integration` (order, children-first), `tenant-export-policy.integration` + `tenantExportErasureRoundtrip.integration`, new `ticketAttachmentsRls.integration.test.ts` (cross-org forge as `breeze_app` → 42501; portal cannot read internal-comment attachment; erasure deletes objects before rows with stubbed S3 and aborts on fault; ticket move and device move re-stamp `org_id`; `S3_BUCKET` unset exercises the `db` backend end-to-end).

**Manual device checks:** `psql -U breeze_app` forged cross-tenant insert fails with the RLS message; TestFlight iOS camera + library (HEIC → JPEG accepted, EXIF absent in served bytes), PDF pick, airplane mode mid-upload → Retry chip, Android 13 media permission; web upload + portal public-vs-internal visibility via `data-testid` E2E.

## Open product questions

Each with the default the implementation assumes unless overridden.

1. **Images + PDF in v1, or images only?** Default: JPEG/PNG/WebP + PDF. Cut to images-only if the wave must shrink; no schema change either way.
2. **10 MiB/file, 5/comment, 20 pending/user, 30 uploads/min?** Default: yes. Raising the per-file cap later needs a migration for the CHECK.
3. **Portal customers upload?** Default: no; render-only. Later behind a setting defaulting off.
4. **Bytes in the GDPR export bundle?** Default: metadata rows only.
5. **Server-side EXIF strip (adds `sharp`)?** Default: defer; mobile strips, web composer discloses.
6. **`ticket.commented` consumers learn about attachments?** Default: no payload change.
7. **Byte-level progress bar?** Default: no; "Sending N of M" via one-file-per-request on `coreRequest`.
8. **Purge objects on comment/ticket soft-delete?** Default: hide only; hard purge belongs to a future purge job.
9. **Fix the `ticket_comments` org-erasure FK gap here?** Default: no; separate issue after live-DB confirmation.
10. **Drop `ticket_comments.attachments jsonb`?** Default: separate cleanup migration.

## Quorum note and tie-break analysis

The judges disagreed: Claude picked **risk-first** (8 / 7.5 / 7); Codex picked **mvp-first** (7.5 / 6.3 / 5.8). Both were weighed against the code, not against each other's scores.

| Disagreement | Codex-judge argument | Claude-judge argument | Verdict |
|---|---|---|---|
| Storage | bytea matches every existing image store; no `s3Storage` expansion | hosted WAL/backup growth from day one; long-term-over-fastest principle; backfill later is the expensive part | **Dual driver (D1).** Hosted always has S3; the precedents are single small images, not multi-photo feeds. |
| Upload protocol | single multipart keeps one transport and no pending rows; two-step is "too much machinery" | two-step gives per-file progress/retry, web parity, JSON validator unchanged | **Two-step (D2).** Decisive: with S3 in play the single-step design still needs put-before-tx + compensation, so its "no orphans" advantage evaporates; and both need `addTicketComment` moved onto a `tx` (**[verified]** it uses global `db`). |
| Mobile transport | `FileSystem.createUploadTask` bypasses `coreRequest` (auth, `device_blocked`, CSRF) | (no objection; both runners-up used the upload task) | **Codex is right (D3).** Two-step does not require the upload task; `coreRequest` + FormData keeps the single transport. Byte-level progress is the only casualty. |
| Erasure | (noted best-effort as the largest failure-mode defect) | objects-before-rows, abort on fault | **Agree: risk-first ordering (D9).** |
| Idempotency | client-generated ids let a reused id overwrite an object with different bytes | idempotent retry is a feature | **Codex is right (D11).** Server ids; reaper handles orphans. |
| Table count / key shape / `uploaded_by` | — | single table, opaque keys, SET NULL | **Adopted (D8, D10, D12).** Both judges' grafts agree. |
| Types | images-only "does not fully ship the brief" | PDF is additive | **Images + PDF (D4)** with a stated scope cut. |
| Quotas / parsers | 100 MB/ticket, 20-pending race, hand-written dimension parser are gold-plating | mild gold-plating | **Dropped** ticket quota and `width/height`; kept the soft pending cap and `userRateLimit`. |
| Migration name | — | both judges: `2026-08-29-…` fails rule 3 | **`2026-09-23-ticket-attachments.sql`** (**[verified]** newest is `2026-09-22-…`). |

Net: the storage/erasure/key/table skeleton is risk-first's; the transport, idempotency and scope trims are Codex's corrections; the client-side resize, shared limits, `data`-never-selected test and portal-context statement are mvp-first grafts. No judge's proposal was adopted wholesale.
