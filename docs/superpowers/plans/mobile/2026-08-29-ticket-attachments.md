---
tracking_issue: LanternOps/breeze#3206
wave: W08
wave_issue: LanternOps/breeze#3902
spec: docs/superpowers/specs/mobile/2026-08-29-ticket-attachments-design.md
---

# Ticket Comment Attachments (W08, #3902) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A technician attaches photos (camera/library) or PDFs to a ticket comment from the phone or the web; attachments render in the ticket feed on mobile, web and (public comments only) the customer portal, on hosted (S3) and self-hosted (no S3) installs alike.

**Architecture:** One new Shape-1 tenant table `ticket_attachments` holds metadata plus either an S3 key or an inline `bytea` blob (`storage_backend` = `'s3' | 'db'`, chosen by `isS3Configured()` at upload time). Upload is two-step: `POST /tickets/:id/attachments` (multipart, one file, returns a *pending* row with `comment_id NULL`) then the existing JSON `POST /tickets/:id/comments` carries `attachmentIds[]` and claims the pending rows inside the comment transaction. Bytes are always served through an authenticated API route (ETag/304, `nosniff`), never a presigned URL. An hourly reaper (slot-allocated, not epoch-aligned) deletes pending rows older than 24 h; org erasure deletes S3 objects *before* rows and aborts (rerunnable) on a storage fault. Mobile uploads through the existing `coreRequest` transport with a `FormData` body.

**Tech Stack:** Hono + Drizzle + postgres.js (API), `@aws-sdk/client-s3` via `services/s3Storage.ts`, BullMQ repeatable job, Zod v4 validators in `packages/shared`, React (web/portal), React Native / Expo 57 (`expo-image-picker`, `expo-image-manipulator`, `expo-document-picker`, `expo-image`), Vitest everywhere, Astro/Starlight for `apps/docs`.

**Spec:** `docs/superpowers/specs/mobile/2026-08-29-ticket-attachments-design.md` (frontmatter path above). Decisions D1–D16 in the spec are binding; this plan cites them by number.

**Revision note (2026-08-30):** this plan was truncated after Task 4 by a session limit and has been completed. Tasks 5–26 are new; Tasks 1–4 were corrected against a critic pass (duplicate import, `guid()` vs `uuid()`, the wrong rls-coverage runner, a false partial-index precedent, an existing test the registration silently breaks, a dangling "Task 11" reference, and a forge recipe that proved nothing). Evidence labels: **[verified]** = read at file:line on the `origin/main` checkout 2026-08-30; **[inferred]**; **[not-checked]**.

## Global Constraints

- **Migration filename:** `apps/api/migrations/2026-09-23-ticket-attachments.sql`. `scripts/check-migration-naming.sh` rule 3 requires sorting strictly after the newest committed file (`2026-09-22-ai-alert-verdicts-live-unique.sql` **[verified]**); a `2026-08-29-` name fails pre-commit and CI. `2026-08-06` is a CLOSED date block — never reach for `-g-` there. Before creating the file, re-run `ls apps/api/migrations/*.sql | tail -1` and bump the date if something newer landed. Idempotent, no inner `BEGIN`/`COMMIT`, RLS policies in the same file, never edited after it ships.
- **Tenancy shape 1** (direct `org_id`, denormalised from `tickets.org_id`). Not config — Partner-Wide-First does not apply. RLS coverage is auto-discovered; no allowlist entry in `rls-coverage.integration.test.ts`. Registration lists that DO need an entry (all in the same PR): `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `TICKET_ORG_DENORMALIZED_TABLES`, `CUSTOM_ORG_REWRITE_TABLES` (+ its hand-written UPDATE in `moveOrg.ts`), `moveOrg.coverage.test.ts`. Not applicable: device cascade lists (no `device_id`), `AUDIT_ADMIN_REQUIRED_TABLES` (not append-only).
- **Export policy:** every column classified. `data` (bytea) is `excludedOpen` by the json/jsonb/bytea rule; everything else `included` (`storage_key` precedent: `ai_screenshots.storage_key` is `included`; `sha256` matches nothing in `SUSPICIOUS_NAME_PARTS` **[verified]** `tenantExportPolicy.ts:35`).
- **Zod dialect:** this repo is on `zod@^4.4.3` **[verified]** and its validators use `z.string().guid()` (144 call sites) over `z.string().uuid()` (5) **[verified]** `packages/shared/src/validators`. Use `.guid()` for every new uuid field.
- **Limits (D5), single source `packages/shared`:** `TICKET_ATTACHMENT_LIMITS = { maxBytes: 10 * 1024 * 1024, maxPerComment: 5, maxPendingPerUser: 20, allowedMimes: ['image/jpeg','image/png','image/webp','application/pdf'] }`; rate limit `userRateLimit('ticket-attachment-upload', 30, 60)` (signature `(bucket, limit, windowSeconds)` **[verified]** `middleware/userRateLimit.ts:11`).
- **Never select `data` in feed/list queries** (D10). Every read that is not the content route uses `ATTACHMENT_META_COLUMNS`; a unit test asserts the compiled SQL.
- **`STORAGE_UNAVAILABLE` 503 when S3 is configured and fails — never fall back to `db`** (D1, failure-modes table).
- **Object keys are `ticket-attachments/<attachmentId>`** (D8) — no tenant ids. Org/device moves re-stamp `org_id` on rows only.
- **Erasure order:** objects before rows; abort on fault (D9).
- **Serving headers (D7):** `ETag: "<sha256>"`, `If-None-Match` → 304, `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="…"` for `image/*`, `attachment; filename="…"` for PDF.
- **Visibility (D6):** computed from the parent comment (`is_public`, `deleted_at`) and the ticket's `deleted_at`. Pending rows visible only to their uploader.
- **Audit details never include the filename** (possible PII): `ticket.attachment.upload { attachmentId, byteSize, contentType }`.
- **`ticket.commented` payload unchanged** (D14).
- **No new permission is introduced.** Every route reuses `PERMISSIONS.TICKETS_READ` / `TICKETS_WRITE` / `TICKETS_MANAGE`. This is deliberate — a new permission would require the six-list registration sweep from the AI-agents W1 lesson. Task 13 is a contract test asserting it stays that way.
- **Mobile:** single transport `coreRequest`; `FormData` bodies omit `Content-Type`; `timeoutMs: 120_000`; picker `exif: false`; attach disabled offline; nothing enters `timeEntryQueue.ts` (D3, D13, D15). Mobile unit tests mock `./api` as `src/services/tickets.test.ts` does.
- **Web:** mutation handlers wrap `fetchWithAuth` in `runAction`; new strings in all 8 locale dirs — `de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR` **[verified]** `ls apps/web/src/locales` — and `apps/web/src/lib/i18n/localeParity.test.ts` enforces key AND interpolation-token parity across them.
- **Error codes:** `ATTACHMENT_TOO_LARGE` 413, `UNSUPPORTED_ATTACHMENT_TYPE` 415, `TOO_MANY_PENDING` 429, `ATTACHMENT_NOT_CLAIMABLE` 409, `TICKET_DELETED` 409, `STORAGE_UNAVAILABLE` 503.
- **Which test runner for which contract suite** (this is the "0 tests = stall, not green" trap):
  - `rls-coverage.integration.test.ts` is **excluded** from `vitest.integration.config.ts` **[verified]** `apps/api/vitest.integration.config.ts:293` and has its own runner: `pnpm --filter @breeze/api test:rls-coverage` → `vitest.config.rls-coverage.ts` **[verified]** `apps/api/package.json:33`. Running it through `test:integration` exercises **zero tests** and reports success.
  - `site-scope-coverage.integration.test.ts` is likewise excluded **[verified]** `:298`; its runner is `test:site-scope-coverage`.
  - `rls.integration.test.ts` is excluded **[verified]** `:288`; its runner is `test:rls`.
  - `tenantCascade`, `tenant-export-policy` and `tenantExportErasureRoundtrip` **are** in the integration glob and run under `test:integration`.
  - `pnpm --filter @breeze/api test:integration -- <path>` may run the WHOLE suite (memory: `integration_test_dashdash_runs_whole_suite`). Use `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <path>` and **read the reported test count** — a zero-test run is a stall, not a pass.
- **`pnpm db:check-drift` does not compare the Drizzle schema to the live DB.** Its own header says schema-vs-live-DB drift is intentionally NOT checked; it applies the migration set to a fresh database and verifies the `breeze_migrations` ledger **[verified]** `apps/api/scripts/check-drift.ts:17-34`. So it will never complain about a Drizzle/SQL index mismatch — declare indexes in both places because readers rely on the schema file, not because a check will catch you.
- **Rigor labels** per task follow the user's global CLAUDE.md calibration; `Rigor: high` tasks use TDD + one independent review round; `Rigor: low` tasks still write the red test first.
- **Authoring:** "Codex-eligible" tasks are pure services/validators/tests/single endpoints with a named reference file (`codex exec -m gpt-5.6-sol -c 'model_reasoning_effort="high"' -C <repo> "<prompt with the reference file and the constraints above pasted in>" < /dev/null`, foregrounded with an explicit Bash `timeout` parameter of 600000 ms — the tool default of 120 s will background it). Codex does not know repo contracts — paste the relevant Global Constraints into every prompt. "Claude" tasks are RN screens, web components, and cross-module wiring.

## PR split

- **PR A — `feat(api,web,portal,docs): ticket comment attachments (#3902 W08-A)`**: Tasks 1–20. Migration, storage service, routes, claim transaction, reaper, erasure pre-clear, contract tests, web + portal render/upload, docs. Targets `main`, gets full CI (integration shards). Body: `Part of #3902`.
- **PR B — `feat(mobile): ticket comment attachments (#3902 W08-B)`**: Tasks 21–26. Branch from `main` **after PR A merges** (not stacked — a stacked PR gets zero CI, see CLAUDE.md tenancy section). Needs a native build (new Expo modules), so it rides its own TestFlight cycle. Body: `Closes #3902`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/constants/ticketAttachments.ts` (create) | `TICKET_ATTACHMENT_LIMITS`, `TicketAttachmentMime` union. |
| `packages/shared/src/validators/tickets.ts` (modify) | `attachmentIds` on `addTicketCommentSchema`. |
| `packages/shared/src/types/tickets.ts` (create) | `TicketAttachmentMeta`. |
| `apps/api/migrations/2026-09-23-ticket-attachments.sql` (create) | Table, CHECKs, indexes, RLS, GRANT. |
| `apps/api/src/db/schema/ticketAttachments.ts` (create) | Drizzle table; `ATTACHMENT_META_COLUMNS` (the never-`data` column list). |
| `apps/api/src/services/tenantCascade.ts` (modify) | Cascade order entry + S3 object pre-clear step. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` (modify) | Column classification. |
| `apps/api/src/services/ticketService.ts` (modify) | `TICKET_ORG_DENORMALIZED_TABLES`; `addTicketComment` claim in a transaction. |
| `apps/api/src/routes/devices/core.ts`, `routes/devices/moveOrg.ts` (modify) | `CUSTOM_ORG_REWRITE_TABLES` + UPDATE via tickets join. |
| `apps/api/src/services/attachmentSniff.ts` (create) | `sniffAttachmentMime(buf)`: image sniff + `%PDF-`. |
| `apps/api/src/services/s3Storage.ts` (modify) | `putObjectBuffer`, `getObjectStream`, `deleteObjects`. |
| `apps/api/src/services/ticketAttachmentStorage.ts` (create) | Backend selection, put/open/delete, compensating delete, `STORAGE_UNAVAILABLE`. |
| `apps/api/src/middleware/bodyLimit.ts` (modify) | `ticket-attachment` carve-out + `BodyLimitRule` union member. |
| `apps/api/src/routes/tickets/attachments.ts` (create) | POST upload, GET content, DELETE. |
| `apps/api/src/routes/tickets/tickets.ts` (modify) | Detail GET adds `attachments`; comment POST passes `attachmentIds`. |
| `apps/api/src/routes/tickets/index.ts` (modify) | Mount `ticketAttachmentRoutes` before `ticketsApiRoutes`. |
| `apps/api/src/routes/portal/tickets.ts` (modify) | Public-comment attachments on detail; portal content route. |
| `apps/api/src/jobs/ticketAttachmentReaper.ts` (create) + `jobs/scheduleRegistry.ts`, `services/workerRegistry.ts` (modify) | Hourly pending reaper on an allocated slot. |
| `apps/api/src/__tests__/integration/ticketAttachmentsRls.integration.test.ts` (create) | Cross-org forge, portal isolation, erasure order, move re-stamp, db backend. |
| `apps/web/src/components/tickets/{TicketComposer,TicketWorkbench,TicketFeed}.tsx`, `ticketConfig.ts`, `locales/*/tickets.json` (modify) | Web upload + render (8 locales). |
| `apps/portal/src/lib/api.ts`, `apps/portal/src/components/portal/TicketDetails.tsx` (modify) | Portal render-only. |
| `apps/docs/src/content/docs/reference/api.mdx` (modify) | Three new endpoint rows, limits, self-host storage note. |
| `apps/mobile/src/services/api.ts` (modify) | FormData branch; `getAuthImageHeaders()`. |
| `apps/mobile/src/services/ticketAttachments.ts` (create) | Pickers, resize, upload, error mapping. |
| `apps/mobile/src/services/tickets.ts` (modify) | `attachments` on `TicketComment`; `attachmentIds` on `addTicketComment`. |
| `apps/mobile/src/screens/tickets/{TicketDetailScreen,AttachmentViewerScreen}.tsx`, `components/AttachmentChip.tsx`, `navigation/MainNavigator.tsx`, `app.json`, `package.json` (create/modify) | Mobile UI + the new `AttachmentViewer` stack route. |

---
### Task 1: Shared contract — limits, meta type, `attachmentIds` validator

**Rigor: low** · **Author: Codex-eligible** (reference: `packages/shared/src/constants/agentFileTransfer.ts` for a constants module, `packages/shared/src/validators/tickets.ts:131` for the schema).

**Files:**
- Create: `packages/shared/src/constants/ticketAttachments.ts`
- Create: `packages/shared/src/types/tickets.ts`
- Modify: `packages/shared/src/constants/index.ts` (add `export * from './ticketAttachments';`)
- Modify: `packages/shared/src/types/index.ts` (add `export * from './tickets';`)
- Modify: `packages/shared/src/validators/tickets.ts:131-134`
- Test: `packages/shared/src/validators/tickets.test.ts` (append), `packages/shared/src/constants/ticketAttachments.test.ts` (create)

**Interfaces:**
- Produces:
  - `TICKET_ATTACHMENT_LIMITS: { readonly maxBytes: 10485760; readonly maxPerComment: 5; readonly maxPendingPerUser: 20; readonly allowedMimes: readonly ['image/jpeg','image/png','image/webp','application/pdf'] }`
  - `type TicketAttachmentMime = (typeof TICKET_ATTACHMENT_LIMITS.allowedMimes)[number]`
  - `interface TicketAttachmentMeta { id: string; commentId: string | null; contentType: TicketAttachmentMime; byteSize: number; originalFilename: string; createdAt: string }`
  - `addTicketCommentSchema` now `{ content: string (may be empty when attachmentIds non-empty), isPublic: boolean, attachmentIds: string[] (guid, max 5, default []) }`

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/constants/ticketAttachments.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { TICKET_ATTACHMENT_LIMITS } from './ticketAttachments';

describe('TICKET_ATTACHMENT_LIMITS', () => {
  it('pins the D5 limits shared by api, web and mobile', () => {
    expect(TICKET_ATTACHMENT_LIMITS.maxBytes).toBe(10 * 1024 * 1024);
    expect(TICKET_ATTACHMENT_LIMITS.maxPerComment).toBe(5);
    expect(TICKET_ATTACHMENT_LIMITS.maxPendingPerUser).toBe(20);
    expect([...TICKET_ATTACHMENT_LIMITS.allowedMimes]).toEqual([
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    ]);
  });
});
```

Append to `packages/shared/src/validators/tickets.test.ts`. **Do not add an import line** — the file already imports `addTicketCommentSchema` from `./tickets` in the single top-of-file import block at `:1-7` **[verified]**; a second import is a duplicate-identifier error, not a no-op:
```ts
describe('addTicketCommentSchema attachmentIds (W08)', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it('defaults attachmentIds to [] and still requires content when empty', () => {
    expect(addTicketCommentSchema.parse({ content: 'hi' })).toMatchObject({ attachmentIds: [] });
    expect(addTicketCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('allows empty content when at least one attachment id is present', () => {
    const r = addTicketCommentSchema.safeParse({ content: '', attachmentIds: [uuid(1)] });
    expect(r.success).toBe(true);
  });

  it('caps attachmentIds at 5 and rejects non-uuids', () => {
    expect(addTicketCommentSchema.safeParse({ content: 'x', attachmentIds: [1, 2, 3, 4, 5, 6].map(uuid) }).success).toBe(false);
    expect(addTicketCommentSchema.safeParse({ content: 'x', attachmentIds: ['nope'] }).success).toBe(false);
  });
});
```

Control check before moving on: the pre-existing assertion at `validators/tickets.test.ts:104` that `{ content: '' }` fails **[verified]** must still be present and passing after Step 3 — it is the regression guard that the `.refine` did not simply relax the old rule.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/shared exec vitest run src/constants/ticketAttachments.test.ts src/validators/tickets.test.ts`
Expected: FAIL — `Cannot find module './ticketAttachments'`; the two attachmentIds cases fail on `.success`.

- [ ] **Step 3: Implement**

`packages/shared/src/constants/ticketAttachments.ts`:
```ts
/**
 * Ticket comment attachment limits (W08, spec D5). Single source of truth for
 * the API's post-parse check, the web composer's pre-flight and the mobile
 * client's size pre-check. Raising maxBytes needs a migration too — the
 * ticket_attachments_size_chk CHECK constraint mirrors it.
 */
export const TICKET_ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPerComment: 5,
  maxPendingPerUser: 20,
  allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
} as const;

export type TicketAttachmentMime = (typeof TICKET_ATTACHMENT_LIMITS.allowedMimes)[number];
```

`packages/shared/src/types/tickets.ts`:
```ts
import type { TicketAttachmentMime } from '../constants/ticketAttachments';

/**
 * Client-visible attachment metadata (W08). Deliberately never carries
 * storageKey, storageBackend, sha256 or data — those are server-only.
 */
export interface TicketAttachmentMeta {
  id: string;
  /** null while the upload is pending (not yet claimed by a comment). */
  commentId: string | null;
  contentType: TicketAttachmentMime;
  byteSize: number;
  originalFilename: string;
  createdAt: string;
}
```

Replace `addTicketCommentSchema` in `packages/shared/src/validators/tickets.ts`. Note `.guid()`, not `.uuid()` — the repo convention (Global Constraints):
```ts
export const addTicketCommentSchema = z.object({
  // W08: content may be blank when the comment carries attachments; the
  // refine below keeps the old "non-empty" rule for attachment-less comments.
  content: z.string().max(50_000).default(''),
  isPublic: z.boolean().default(true),
  attachmentIds: z.array(z.string().guid()).max(TICKET_ATTACHMENT_LIMITS.maxPerComment).default([])
}).refine((v) => v.content.trim().length > 0 || v.attachmentIds.length > 0, {
  message: 'Comment needs text or at least one attachment',
  path: ['content']
});
```

Add the two `export *` lines to `constants/index.ts` and `types/index.ts`, and import `TICKET_ATTACHMENT_LIMITS` at the top of `validators/tickets.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/shared exec vitest run src/constants/ticketAttachments.test.ts src/validators/tickets.test.ts && pnpm --filter @breeze/shared typecheck`
Expected: PASS. Then `pnpm --filter @breeze/api exec vitest run src/routes/tickets/tickets.test.ts` — the existing comment tests must still pass. The schema is now a `ZodEffects`; its only non-test consumer is the `zValidator('json', addTicketCommentSchema)` at `apps/api/src/routes/tickets/tickets.ts:798` **[verified]**, which accepts any Zod type, so this is safe. If any call site does `addTicketCommentSchema.shape` or `.partial()`, it will fail to compile — there are none today **[verified]** by `grep -rn addTicketCommentSchema`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants/ticketAttachments.ts packages/shared/src/constants/ticketAttachments.test.ts packages/shared/src/constants/index.ts packages/shared/src/types/tickets.ts packages/shared/src/types/index.ts packages/shared/src/validators/tickets.ts packages/shared/src/validators/tickets.test.ts
git commit -m "feat(shared): ticket attachment limits, meta type and attachmentIds on comment schema (#3902)"
```

---

### Task 2: Migration, Drizzle schema, cascade + export-policy registration

**Rigor: high** (migration + RLS + tenant registrations) · **Author: Claude** (cross-module registration sweep). Codex may draft the SQL from the spec block, but Claude owns the registration edits and the contract-test run.

**Files:**
- Create: `apps/api/migrations/2026-09-23-ticket-attachments.sql`
- Create: `apps/api/src/db/schema/ticketAttachments.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './ticketAttachments';` next to `ticketEmailLinks`)
- Modify: `apps/api/src/services/tenantCascade.ts:376-383` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:339` (`CORE_TENANT_EXPORT_POLICY`)
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing — ordering/naming), `apps/api/src/services/tenantCascade.test.ts` (append), contract suites below

**Interfaces:**
- Produces: Drizzle `ticketAttachments` table; `ATTACHMENT_META_COLUMNS` — the explicit column map every non-content read must use:
  ```ts
  export const ATTACHMENT_META_COLUMNS = {
    id: ticketAttachments.id, commentId: ticketAttachments.commentId,
    contentType: ticketAttachments.contentType, byteSize: ticketAttachments.byteSize,
    originalFilename: ticketAttachments.originalFilename, createdAt: ticketAttachments.createdAt,
  } as const;
  ```

- [ ] **Step 1: Write the failing cascade-order unit test**

Append to `apps/api/src/services/tenantCascade.test.ts` inside the top-level describe that imports `getOrgCascadeDeleteOrder`:
```ts
describe('ticket_attachments registration (W08 #3902)', () => {
  it('is in the org cascade list between ticket_alert_links and ticket_email_links', () => {
    const order = getOrgCascadeDeleteOrder();
    const i = order.indexOf('ticket_attachments');
    expect(i).toBeGreaterThan(-1);
    expect(order.indexOf('ticket_alert_links')).toBeLessThan(i);
    expect(i).toBeLessThan(order.indexOf('ticket_email_links'));
    expect(i).toBeLessThan(order.indexOf('tickets')); // FK child before parent
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/tenantCascade.test.ts -t "ticket_attachments registration"`
Expected: FAIL — `expected -1 to be greater than -1`.

- [ ] **Step 3: Write the migration**

First confirm the name still sorts last: `ls apps/api/migrations/*.sql | tail -1` must print `2026-09-22-ai-alert-verdicts-live-unique.sql`; if not, use a later date.

`apps/api/migrations/2026-09-23-ticket-attachments.sql`:
```sql
-- ticket_attachments (W08, #3902): photo / PDF attachments on ticket comments.
-- Tenancy shape 1 (direct org_id, denormalised from tickets.org_id; RLS
-- auto-discovered). Bytes live in S3 (storage_key) when the platform bucket
-- is configured, else inline in `data` (bytea). comment_id NULL = pending
-- upload not yet claimed by a comment (reaped after 24h).
-- Registered in CORE_ORG_CASCADE_DELETE_ORDER, CORE_TENANT_EXPORT_POLICY,
-- TICKET_ORG_DENORMALIZED_TABLES and CUSTOM_ORG_REWRITE_TABLES in the same PR.
-- Idempotent: IF NOT EXISTS / duplicate_object guards; re-applying is a no-op.

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id),
  ticket_id           uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  comment_id          uuid REFERENCES ticket_comments(id) ON DELETE CASCADE,
  uploaded_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  storage_backend     varchar(8)   NOT NULL,
  storage_key         text,
  data                bytea,
  content_type        varchar(64)  NOT NULL,
  byte_size           integer      NOT NULL,
  original_filename   varchar(255) NOT NULL,
  sha256              char(64)     NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  attached_at         timestamptz
);

DO $$ BEGIN
  ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_backend_chk CHECK (
    (storage_backend = 's3' AND storage_key IS NOT NULL AND data IS NULL) OR
    (storage_backend = 'db' AND data IS NOT NULL AND storage_key IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_size_chk
    CHECK (byte_size > 0 AND byte_size <= 10485760);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_attachments ADD CONSTRAINT ticket_attachments_attached_chk
    CHECK ((comment_id IS NULL) = (attached_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS ticket_attachments_ticket_idx  ON ticket_attachments (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS ticket_attachments_comment_idx ON ticket_attachments (comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_attachments_pending_idx ON ticket_attachments (uploaded_by_user_id, created_at) WHERE comment_id IS NULL;
CREATE INDEX IF NOT EXISTS ticket_attachments_org_idx     ON ticket_attachments (org_id);

ALTER TABLE ticket_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_attachments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_attachments;
CREATE POLICY breeze_org_isolation_select ON ticket_attachments
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_attachments;
CREATE POLICY breeze_org_isolation_insert ON ticket_attachments
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_attachments;
CREATE POLICY breeze_org_isolation_update ON ticket_attachments
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_attachments;
CREATE POLICY breeze_org_isolation_delete ON ticket_attachments
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_attachments TO breeze_app;
```

Policy shape is byte-identical to the established precedent at `2026-08-22-ticket-email-links.sql:37-54` **[verified]** (four `breeze_org_isolation_*` policies, no role clause, plus the GRANT). `breeze_has_org_access` returns TRUE under scope `'system'` **[verified]** `0008-tenant-rls.sql:42-52`, so the reaper (Task 14) and the erasure pre-step (Task 15) can see rows across orgs; a contextless statement resolves scope `'none'` (migration `0012-tenant-rls-deny-default.sql` overrode the `'system'` default) and sees nothing.

- [ ] **Step 4: Write the Drizzle schema**

`apps/api/src/db/schema/ticketAttachments.ts`:
```ts
import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, integer, char, timestamp, index } from 'drizzle-orm/pg-core';
import { tickets, ticketComments } from './portal';
import { organizations } from './orgs';
import { users, bytea } from './users';

/**
 * Ticket comment attachments (W08, #3902). Shape 1 (direct org_id). Bytes are
 * either in S3 (storage_backend='s3', storage_key) or inline (storage_backend
 * ='db', data). comment_id NULL means "pending upload" (D2); never a product
 * concept of a ticket-level attachment.
 *
 * NEVER select `data` outside the content route — use ATTACHMENT_META_COLUMNS.
 * ticketAttachmentStorage.test.ts asserts the feed queries' compiled SQL.
 */
export const ticketAttachments = pgTable('ticket_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  commentId: uuid('comment_id').references(() => ticketComments.id, { onDelete: 'cascade' }),
  uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  storageBackend: varchar('storage_backend', { length: 8 }).notNull(), // 's3' | 'db'
  storageKey: text('storage_key'),
  data: bytea('data'),
  contentType: varchar('content_type', { length: 64 }).notNull(),
  byteSize: integer('byte_size').notNull(),
  originalFilename: varchar('original_filename', { length: 255 }).notNull(),
  sha256: char('sha256', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  attachedAt: timestamp('attached_at', { withTimezone: true }),
}, (t) => [
  index('ticket_attachments_ticket_idx').on(t.ticketId, t.createdAt),
  // Partial indexes ARE expressible in Drizzle and MUST be declared here so the
  // schema file is a faithful picture of the table. Precedent:
  // db/schema/aiAlertVerdicts.ts:54-56 [verified] declares three partial
  // indexes with exactly this `.where(sql\`…\`)` form.
  index('ticket_attachments_comment_idx').on(t.commentId).where(sql`${t.commentId} IS NOT NULL`),
  index('ticket_attachments_pending_idx').on(t.uploadedByUserId, t.createdAt).where(sql`${t.commentId} IS NULL`),
  index('ticket_attachments_org_idx').on(t.orgId),
]);

export type TicketAttachmentRow = typeof ticketAttachments.$inferSelect;

/** Client-safe column subset. Everything else (data, key, sha256) is server-only. */
export const ATTACHMENT_META_COLUMNS = {
  id: ticketAttachments.id,
  commentId: ticketAttachments.commentId,
  contentType: ticketAttachments.contentType,
  byteSize: ticketAttachments.byteSize,
  originalFilename: ticketAttachments.originalFilename,
  createdAt: ticketAttachments.createdAt,
} as const;
```

**Correction to an earlier draft of this step:** it claimed "`pnpm db:check-drift` tolerates partial-index predicates the same way `ticket_email_links` does". That precedent does not exist — `ticket_email_links` has no partial index at all (its migration declares one unique + one plain index at `2026-08-22-ticket-email-links.sql:32,34` and the Drizzle file declares the same two at `db/schema/ticketEmailLinks.ts:22-24` **[verified]**), and `db:check-drift` does not compare Drizzle to the DB in either direction (Global Constraints). Declare all four indexes in both places; nothing automated will catch you if you don't, which is exactly why it goes in the plan.

- [ ] **Step 5: Register in the cascade list and export policy**

`apps/api/src/services/tenantCascade.ts` — insert directly after `'ticket_alert_links',` (line 376):
```ts
  // ticket_attachments (W08 #3902): comment photo/PDF attachments. Shape 1.
  // ticket_id / comment_id FKs are ON DELETE CASCADE; uploaded_by_user_id is
  // SET NULL. Cascade leaf. localeCompare: 'ticket_alert_links' <
  // 'ticket_attachments' < 'ticket_email_links' ('al' < 'at' < 'em').
  // S3 objects are cleared BEFORE this DELETE by the pre-step added to
  // cascadeDeleteOrg in Task 15 — the rows are the only index to the keys.
  'ticket_attachments',
```

`apps/api/src/services/tenantExportPolicyRegistry.ts` — insert after the `ticket_alert_links` line (338):
```ts
  // ticket_attachments (W08 #3902): `data` is bytea → excludedOpen by rule.
  // storage_key is an opaque `ticket-attachments/<id>` path (precedent:
  // ai_screenshots.storage_key, included); sha256 is a content digest, not
  // a credential, and matches nothing in SUSPICIOUS_NAME_PARTS.
  "ticket_attachments": tablePolicy("org_id", {
    included: ["id", "org_id", "ticket_id", "comment_id", "uploaded_by_user_id", "storage_backend", "storage_key", "content_type", "byte_size", "original_filename", "sha256", "created_at", "attached_at"],
    reviewedIncluded: [],
    excludedSensitive: [],
    excludedOpen: ["data"],
  }),
```

- [ ] **Step 6: Run unit tests and apply the migration**

```bash
pnpm --filter @breeze/api exec vitest run src/services/tenantCascade.test.ts src/db/autoMigrate.test.ts
bash scripts/check-migration-naming.sh
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
```
Expected: all PASS; the migration applies; `db:check-drift` confirms one ledger row per migration file (it does NOT compare schema to DB — see Global Constraints).

- [ ] **Step 7: Run the contract suites (live DB) — each on its OWN runner**

```bash
# rls-coverage has a DEDICATED runner; it is EXCLUDED from the integration config.
pnpm --filter @breeze/api test:rls-coverage

# These three ARE in the integration glob. Use the config directly, not `-- <path>`.
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts

# Mocked RLS unit-ish suite, also its own runner.
pnpm --filter @breeze/api test:rls
```
**Read the test counts.** A run reporting `0 tests` is a stall, not a pass — that is exactly what `test:integration -- src/__tests__/integration/rls-coverage.integration.test.ts` produces, because the integration config excludes that file at `vitest.integration.config.ts:293` **[verified]**.

Expected: `test:rls-coverage` discovers `ticket_attachments` with all four `breeze_has_org_access` policies (Shape 1 is auto-discovered — no allowlist entry); `tenantCascade` passes the five ordering properties; export policy reports no unclassified column; the erasure roundtrip passes.

- [ ] **Step 8: Manual forge check as `breeze_app`**

A contextless `INSERT … SELECT … FROM organizations o JOIN tickets t` proves **nothing**. With no GUC set, `breeze_current_scope()` resolves to `'none'` — migration `0012-tenant-rls-deny-default.sql:6-12` **[verified]** replaced the `'system'` default that `0008-tenant-rls.sql:11` originally shipped — so the SELECT source returns zero rows and the statement completes as `INSERT 0 0`, never reaching the `WITH CHECK`. (An independent Codex read of this same question answered "no GUC means scope `'system'`, so the forge succeeds"; it read 0008 and missed 0012. Both wrong answers land on "the check is vacuous", which is the point.)

Set an explicit org context — the same six transaction-local GUCs `applyAccessContextGucs` writes **[verified]** `apps/api/src/db/index.ts:465-470`, of which three matter here — and forge a row stamped with a *different* org. Wrap it in a transaction and `ROLLBACK`, so the check is non-destructive on a dev database:

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze
```
```sql
\set VERBOSITY verbose
-- Pick two real org ids and one ticket in ALLOWED_ORG first (read them under a
-- system context in a throwaway session, or from `pnpm db:seed` output).
\set allowed_org   '00000000-...'
\set forbidden_org '11111111-...'
\set ticket_id     '22222222-...'   -- a ticket belonging to :allowed_org

BEGIN;
SELECT set_config('breeze.scope', 'organization', true);
SELECT set_config('breeze.org_id', :'allowed_org', true);
SELECT set_config('breeze.accessible_org_ids', :'allowed_org', true);

-- CONTROL: the context itself must discriminate, or the INSERT below proves nothing.
SELECT breeze_has_org_access(:'allowed_org'::uuid)   AS should_be_true,
       breeze_has_org_access(:'forbidden_org'::uuid) AS should_be_false;
-- EXPECTED: t | f

-- POSITIVE CONTROL: same row, own org, must SUCCEED.
INSERT INTO ticket_attachments
  (org_id, ticket_id, storage_backend, data, content_type, byte_size, original_filename, sha256)
VALUES (:'allowed_org', :'ticket_id', 'db', '\x89504e470d0a1a0a'::bytea, 'image/png', 8, 'ok.png', repeat('a', 64));
-- EXPECTED: INSERT 0 1

-- THE FORGE: same row, foreign org.
INSERT INTO ticket_attachments
  (org_id, ticket_id, storage_backend, data, content_type, byte_size, original_filename, sha256)
VALUES (:'forbidden_org', :'ticket_id', 'db', '\x89504e470d0a1a0a'::bytea, 'image/png', 8, 'forge.png', repeat('a', 64));
-- EXPECTED: ERROR (SQLSTATE 42501)
--   new row violates row-level security policy for table "ticket_attachments"

ROLLBACK;
```

Record the 42501 **and** both controls in the PR body. A forge that errors while the positive control also errors proves only that the statement is malformed. The automated mirror of this check lives in Task 16.

- [ ] **Step 9: Commit**

```bash
git add apps/api/migrations/2026-09-23-ticket-attachments.sql apps/api/src/db/schema/ticketAttachments.ts apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantCascade.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): ticket_attachments table with RLS, cascade and export-policy registration (#3902)"
```

---
### Task 3: Org re-stamp on ticket move and device move

**Rigor: high** (tenant isolation on move) · **Author: Codex-eligible** for the two UPDATE statements (reference: the `ticket_alert_links` rewrite at `apps/api/src/routes/devices/moveOrg.ts:277-279` and the `TICKET_ORG_DENORMALIZED_TABLES` loop at `services/ticketService.ts:1442-1446`); **Claude owns the edit to the existing 4-tables test** and the lock-order decision.

**Files:**
- Modify: `apps/api/src/services/ticketService.ts:1374` (`TICKET_ORG_DENORMALIZED_TABLES`)
- Modify: `apps/api/src/routes/devices/core.ts:219` (`CUSTOM_ORG_REWRITE_TABLES`)
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (new UPDATE **after** the `ticket_parts` UPDATE, ~:310)
- Test: `apps/api/src/services/ticketService.test.ts` (**edit the existing test at :2675 AND add one**), `apps/api/src/routes/devices/moveOrg.coverage.test.ts:181-187`, `apps/api/src/routes/devices/moveOrg.test.ts`

**Lock-order decision (state it, don't discover it):** `moveOrg.ts:283-291` documents a global lock order `tickets → time_entries → ticket_parts` and says a concurrent `moveTicketOrg` or `issueInvoice` therefore serializes instead of deadlocking **[verified]**. `ticket_attachments` is **appended LAST in both paths** — after `ticket_outbox` in `TICKET_ORG_DENORMALIZED_TABLES`, and after the `ticket_parts` UPDATE in `moveOrg.ts` — so the two movers touch it in the same relative position and the documented order is extended, not reordered. Do **not** insert it next to the `ticket_alert_links` rewrite in `moveOrg.ts`: that statement runs *before* `time_entries`/`ticket_parts`, so placing the attachment UPDATE there would give the device path the order `attachments → time_entries → ticket_parts` against the ticket path's `time_entries → ticket_parts → attachments` — a lock-order inversion on the same rows whenever a device move and a ticket move touch the same ticket. [inferred from the two call sites; not reproduced under concurrency.]

- [ ] **Step 1: Write the failing tests (three files)**

(a) `moveOrg.coverage.test.ts`, after the `ticket_parts` assertion at line 187:
```ts
  it('contains ticket_attachments (W08: org_id denormalized from tickets, no device_id)', () => {
    expect(CUSTOM_ORG_REWRITE_TABLES).toContain('ticket_attachments');
  });
```

(b) `moveOrg.test.ts`, next to the `ticket_alert_links` rewrite test (line 399), same rig:
```ts
    it('rewrites ticket_attachments org_id via the tickets join inside the transaction (W08)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      const rewrites = statements.filter((s) => s.startsWith('UPDATE ticket_attachments '));
      expect(rewrites).toEqual([
        `UPDATE ticket_attachments SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
      // Lock order: attachments must come AFTER ticket_parts in this path.
      const idx = (t: string) => statements.findIndex((s) => s.startsWith(`UPDATE ${t} `));
      expect(idx('ticket_parts')).toBeLessThan(idx('ticket_attachments'));
    });
```

(c) `ticketService.test.ts` — **this is the step the first draft got wrong twice.** The `moveTicketOrg` describe begins at `:2664` and already owns a local helper `executedTableNames()` at `:2670-2677` that walks `queryChunks[1].value` **[verified]**; use it rather than inventing a second extraction style. Two edits:

**(c1) Update the existing test, which this change breaks.** `ticketService.test.ts:2675` is titled `'moves ticket to a same-partner org, detaches device, re-stamps child org_id on 4 tables including ticket_outbox'` and hard-asserts `expect(dbMocks.txExecuteMock).toHaveBeenCalledTimes(4)` at `:2702` **[verified]**. Adding a fifth entry to `TICKET_ORG_DENORMALIZED_TABLES` makes that a 5. Rename it to `…on 5 tables including ticket_attachments`, change the count to `5`, and extend the `arrayContaining` to list `'ticket_attachments'`. Leave the surrounding comment block, but add: `// W08 #3902 added ticket_attachments as the 5th and LAST entry.`

**(c2) Add the ordering test beside it** — a complete arrange block and an actual `moveTicketOrg` call, because `beforeEach` clears `txExecuteMock` and an assertion over an un-invoked mock is vacuous:
```ts
  it('re-stamps ticket_attachments.org_id LAST on ticket move (W08 #3902)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't1', orgId: 'oA', partnerId: 'p1', deviceId: 'd1' }])
      .mockResolvedValueOnce([{ currencyCode: 'USD' }])
      .mockResolvedValueOnce([{ currencyCode: 'USD' }])
      .mockResolvedValueOnce([
        { id: 'oA', partnerId: 'p1', name: 'Alpha Corp', currencyCode: 'USD' },
        { id: 'oB', partnerId: 'p1', name: 'Beta Corp', currencyCode: 'USD' }
      ]);
    dbMocks.txUpdateReturning.mockResolvedValue([{ id: 't1', orgId: 'oB', deviceId: null }]);
    dbMocks.txExecuteMock.mockResolvedValue(undefined);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-sys' }]);

    await moveTicketOrg('t1', 'oB', { userId: 'admin' });

    const tables = executedTableNames();
    expect(tables).toContain('ticket_attachments');
    // Appended last so the device-move path (moveOrg.ts) and this path touch
    // the ticket-linked tables in the same relative order — see the
    // lock-order note at moveOrg.ts:283.
    expect(tables[tables.length - 1]).toBe('ticket_attachments');
  });
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/moveOrg.test.ts src/services/ticketService.test.ts
```
Expected: FAIL in all three — the coverage assertion, the `moveOrg` rewrite list (empty), and BOTH `ticketService` cases (the edited 4→5 test now expects 5 and gets 4; the new ordering test finds no `ticket_attachments`). Confirm the edited test fails on the **count**, not on a typo — that is the control proving the edit is load-bearing.

- [ ] **Step 3: Implement**

`ticketService.ts:1374` — append last, and extend the block comment above it:
```ts
// ticket_attachments (W08 #3902): comment photo/PDF metadata rows denormalize
// org_id from their ticket (shape 1) and have no device_id. Appended LAST so
// this path and the device-move path (routes/devices/moveOrg.ts) touch the
// ticket-linked child tables in the same relative order; see the lock-order
// comment at moveOrg.ts:283. S3 objects are keyed by attachment id only
// (spec D8) and are NOT touched by a move.
const TICKET_ORG_DENORMALIZED_TABLES = ['time_entries', 'ticket_parts', 'ticket_alert_links', 'ticket_outbox', 'ticket_attachments'] as const;
```
(The loop at `:1442` runs `UPDATE <table> SET org_id = $new WHERE ticket_id = $ticket` for every entry **[verified]**; nothing else changes.)

`routes/devices/core.ts:219`:
```ts
export const CUSTOM_ORG_REWRITE_TABLES = ['ticket_alert_links', 'time_entries', 'ticket_parts', 'ticket_attachments'] as const;
```

`routes/devices/moveOrg.ts`, immediately **after** the `ticket_parts` UPDATE (~:310), not after `ticket_alert_links`:
```ts
        // ticket_attachments (W08 #3902) denormalizes org_id from its ticket and
        // has no device_id; tickets bound to this device move org, so their
        // attachment rows follow via the tickets join. Placed AFTER ticket_parts
        // to extend — not reorder — the documented global lock order
        // (tickets -> time_entries -> ticket_parts -> ticket_attachments); the
        // moveTicketOrg loop appends it last for the same reason. S3 objects are
        // keyed by attachment id only (spec D8) and are not touched.
        await tx.execute(
          sql`UPDATE ${sql.identifier('ticket_attachments')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
        );
```

- [ ] **Step 4: Run to verify pass**

Run the Step 2 command. Expected: PASS, including `moveOrg.coverage.test.ts`'s "every CUSTOM entry exists with org_id and without device_id" assertion (it reads the Drizzle schema from Task 2 via `Object.values(schema)` **[verified]** `:177-180`, so Task 2 must be committed first) and its disjointness check against the generic device lists.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/moveOrg.test.ts apps/api/src/routes/devices/moveOrg.coverage.test.ts
git commit -m "feat(api): re-stamp ticket_attachments.org_id on ticket and device org moves (#3902)"
```

---

### Task 4: Attachment MIME sniffer

**Rigor: low** · **Author: Codex-eligible** (reference: `apps/api/src/services/avatarStorage.ts:82` `sniffImageMime`, which returns `'image/png' | 'image/jpeg' | 'image/webp' | null` and rejects buffers shorter than 12 bytes **[verified]**).

**Files:**
- Create: `apps/api/src/services/attachmentSniff.ts`
- Test: `apps/api/src/services/attachmentSniff.test.ts`

**Interfaces:**
- Produces: `sniffAttachmentMime(buf: Buffer): TicketAttachmentMime | null`

- [ ] **Step 1: Write the failing table-driven test**

```ts
import { describe, it, expect } from 'vitest';
import { sniffAttachmentMime } from './attachmentSniff';

const pad = (head: number[]) => Buffer.from([...head, ...Array(16).fill(0)]);

describe('sniffAttachmentMime', () => {
  const cases: Array<[string, Buffer, string | null]> = [
    ['png', pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['jpeg', pad([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 \0\0\0\0'), 'image/webp'],
    ['pdf', Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'), 'application/pdf'],
    ['heic (ftypheic) is rejected', Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic', 'latin1'), null],
    ['svg is rejected', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), null],
    ['html is rejected', Buffer.from('<!doctype html><html></html>'), null],
    ['a PDF header not at offset 0 is rejected', Buffer.from('  %PDF-1.7\n', 'latin1'), null],
    ['too short', Buffer.from([0x89, 0x50]), null],
    ['empty', Buffer.alloc(0), null],
  ];
  it.each(cases)('%s', (_name, buf, expected) => {
    expect(sniffAttachmentMime(buf)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @breeze/api exec vitest run src/services/attachmentSniff.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { TicketAttachmentMime } from '@breeze/shared';
import { sniffImageMime } from './avatarStorage';

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * Magic-byte sniff for ticket attachments (spec D4). The client Content-Type
 * is never consulted. Images reuse the avatar sniffer (PNG/JPEG/WebP); PDF is
 * the 5-byte `%PDF-` header AT OFFSET 0. HEIC, SVG, HTML and everything else
 * -> null (415 UNSUPPORTED_ATTACHMENT_TYPE at the route).
 */
export function sniffAttachmentMime(buf: Buffer): TicketAttachmentMime | null {
  if (buf.length >= PDF_MAGIC.length && buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return 'application/pdf';
  }
  return sniffImageMime(buf);
}
```

- [ ] **Step 4: Run to verify pass** — same command, expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/attachmentSniff.ts apps/api/src/services/attachmentSniff.test.ts
git commit -m "feat(api): magic-byte sniffer for ticket attachments (#3902)"
```

---

### Task 5: `s3Storage` buffer/stream/delete primitives

**Rigor: high** (object-store writes on the upload path) · **Author: Codex-eligible** for the three functions (reference: `uploadBinary` at `apps/api/src/services/s3Storage.ts:385` and `deleteBinary` at `:418`, which already show the `requireBucket()` + `getS3Client()` + `wrapS3Failure(op, bucket, key, err)` shape **[verified]**); Claude reviews.

Today `s3Storage` can only upload a **local file path** as `application/octet-stream` **[verified]** `:385-410`. Attachments are in-memory buffers with a real content type.

**Files:**
- Modify: `apps/api/src/services/s3Storage.ts`
- Test: `apps/api/src/services/s3Storage.test.ts` (append; mock `@aws-sdk/client-s3` as the existing suite does)

**Interfaces:**
- Produces:
  - `putObjectBuffer(key: string, body: Buffer, contentType: string, sha256: string): Promise<void>`
  - `getObjectStream(key: string): Promise<{ body: Readable; contentLength: number | null }>`
  - `deleteObjects(keys: readonly string[]): Promise<void>` (batched `DeleteObjectsCommand`, ≤1000 per call, throws on any `Errors[]` entry)
- Consumes: existing `requireBucket`, `getS3Client`, `wrapS3Failure`, `isS3NotFound`.

- [ ] **Step 1: Write the failing tests**

Assert, with the S3 client mocked: `putObjectBuffer` sends `PutObjectCommand` with `ContentType` set to the argument (**not** octet-stream), `ContentLength` = `body.length`, and `Metadata: { sha256 }`; a `send` rejection surfaces as the `S3OperationError` from `wrapS3Failure` (not a raw SDK error); `getObjectStream` maps a `NoSuchKey` rejection to `null`-body via `isS3NotFound` rather than throwing; `deleteObjects` chunks 1500 keys into two `DeleteObjectsCommand` calls and **throws** when the response carries a non-empty `Errors` array (the erasure contract in D9 depends on this).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api exec vitest run src/services/s3Storage.test.ts`. Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement** the three functions beside `uploadBinary`, each wrapping `client.send` in `try/catch` → `throw wrapS3Failure('<op>', bucket, key, err)`. `deleteObjects` returns early on an empty array (never send a zero-key delete).

- [ ] **Step 4: Run to verify pass** — same command.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/services/s3Storage.ts apps/api/src/services/s3Storage.test.ts
git commit -m "feat(api): buffer put, object stream and batch delete in s3Storage (#3902)"
```

---

### Task 6: `ticketAttachmentStorage` service — backend selection and byte lifecycle

**Rigor: high** (D1 dual driver; a silent `s3 → db` fallback would scatter customer bytes across two stores) · **Author: Codex-eligible** (reference: `apps/api/src/services/avatarStorage.ts` for the service shape; Task 5's new s3 primitives).

**Files:**
- Create: `apps/api/src/services/ticketAttachmentStorage.ts`
- Test: `apps/api/src/services/ticketAttachmentStorage.test.ts`

**Interfaces:**
- Produces:
  - `class AttachmentStorageError extends Error { code: 'STORAGE_UNAVAILABLE'; status: 503 }`
  - `selectBackend(): 's3' | 'db'` — `isS3Configured() ? 's3' : 'db'` **[verified]** `s3Storage.ts:112`
  - `objectKeyFor(id: string): string` → `` `ticket-attachments/${id}` `` (D8)
  - `putBytes(id, buf, contentType, sha256): Promise<{ backend: 's3'|'db'; storageKey: string|null; data: Buffer|null }>`
  - `openBytes(row): Promise<{ body: Readable | Buffer; contentLength: number | null }>`
  - `deleteBytes(row): Promise<void>` / `deleteObjectKeys(keys: readonly string[]): Promise<void>`
- Consumes: `s3Storage` (Task 5), `TICKET_ATTACHMENT_LIMITS`.

- [ ] **Step 1: Write the failing tests**

- `selectBackend()` is `'s3'` with `S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` set and `'db'` with any of them unset.
- **`putBytes` throws `AttachmentStorageError('STORAGE_UNAVAILABLE')` when the backend is `'s3'` and the put fails — and NEVER returns a `db` result.** Assert on the thrown code, and additionally assert `putObjectBuffer` was called exactly once and no `data` buffer is present on any return value. This is the single most important test in the task.
- `putBytes` on the `db` backend returns `{ backend: 'db', storageKey: null, data: buf }` and does not touch S3.
- `openBytes` routes by `row.storageBackend`, never by whether `storage_key` happens to be set.
- `deleteBytes` on a `db` row is a no-op (the row DELETE carries the bytes); on an `s3` row it calls `deleteObjects([key])`.

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement.** Key rule, in a comment at the top of the file: *selection happens once, at upload; a row's `storage_backend` is authoritative forever after, so rows written before an operator configured S3 keep serving from `data`.*

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/services/ticketAttachmentStorage.ts apps/api/src/services/ticketAttachmentStorage.test.ts
git commit -m "feat(api): ticket attachment storage service with s3/db backend selection (#3902)"
```

---

### Task 7: `bodyLimit` carve-out for the upload route

**Rigor: low** · **Author: Codex-eligible** (reference: the `software-package` branch at `apps/api/src/middleware/bodyLimit.ts:69-75` **[verified]**).

Without this, every upload 413s at the global 1 MB gate before the route's own check runs (#3482 class). Note the `BodyLimitRule` union is deliberately closed — adding a branch without a label is a type error **[verified]** `bodyLimit.ts:24-40`.

**Files:**
- Modify: `apps/api/src/middleware/bodyLimit.ts`
- Test: `apps/api/src/middleware/bodyLimit.test.ts`

- [ ] **Step 1: Failing test** — `bodyLimitForPath('/api/v1/tickets/<uuid>/attachments')` returns `{ rule: 'ticket-attachment', maxSize: 10 * 1024 * 1024 + 64 * 1024, error: 'Attachment too large (max 10 MB)' }`; and `bodyLimitForPath('/api/v1/tickets/<uuid>/comments')` still returns `default` (the carve-out must not widen the comment route).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — add `'ticket-attachment'` to `BodyLimitRule` and the branch `if (path.match(/^\/api\/v1\/tickets\/[^/]+\/attachments$/))`. The 64 KiB headroom covers the multipart envelope so the route's own message wins.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `fix(api): body-limit carve-out for ticket attachment uploads (#3902)`.

---
### Task 8: `POST /tickets/:id/attachments` — the upload route

**Rigor: high** (unauthenticated-adjacent file ingest, tenant scoping, size/type gates) · **Author: Claude** (multi-concern route; codex may draft the parse + sniff block in isolation).

**Files:**
- Create: `apps/api/src/routes/tickets/attachments.ts` (POST only in this task; GET/DELETE land in Task 10)
- Modify: `apps/api/src/routes/tickets/index.ts` (mount **before** `ticketsApiRoutes`)
- Test: `apps/api/src/routes/tickets/attachments.test.ts`

**Interfaces:**
- Produces: `export const ticketAttachmentRoutes: Hono`; `201 { data: TicketAttachmentMeta }` with `commentId: null`.
- Consumes: `getScopedTicketOr404`, `actorFrom`, `handleServiceError` (all exported from `routes/tickets/tickets.ts` **[verified]** `:116`), `requireScope`, `requirePermission`, `userRateLimit`, `sniffAttachmentMime` (Task 4), `ticketAttachmentStorage` (Task 6), `TICKET_ATTACHMENT_LIMITS`.

**Handler order** (each line is a test case):
`requireScope('organization','partner','system')` → `requirePermission(TICKETS_WRITE)` → `zValidator('param', idParam)` → `userRateLimit('ticket-attachment-upload', 30, 60)` → org-context guard (`auth.scope === 'organization' && !auth.orgId` → 403, matching every sibling route **[verified]** `tickets.ts:805-807`) → `getScopedTicketOr404(auth, id)` → 404 → soft-deleted ticket → 409 `TICKET_DELETED` → `c.req.parseBody({ all: true })` → exactly one `File` under key `file` (zero or ≥2 → 400) → `Buffer.from(await file.arrayBuffer())` → `0 < size <= maxBytes` (413 `ATTACHMENT_TOO_LARGE`) → `sniffAttachmentMime` (415 `UNSUPPORTED_ATTACHMENT_TYPE`) → pending count for this user `< maxPendingPerUser` (429 `TOO_MANY_PENDING`; soft cap, deliberately un-locked) → `sha256` hex + sanitised basename → `putBytes` → `INSERT` pending row → audit.

**Two rules that are easy to get wrong:**
1. **Put before insert, compensate on insert failure.** A put failure leaves no row; an insert failure must `deleteBytes` the object and then rethrow the *original* error (never let the compensating delete mask it — the `deleteBinary` docstring at `s3Storage.ts:411-417` states this contract **[verified]**).
2. **Filename sanitisation is a basename, not an escape.** Strip any path separators and NUL, cap at 255 chars, and fall back to `attachment` when the result is empty. The stored name is echoed in `Content-Disposition` (Task 10), so a `"` or newline in it is a header-injection vector.

- [ ] **Step 1: Write the failing route tests** — mock `../../db`, `../../services/ticketAttachmentStorage` and `./tickets` the way `apps/api/src/routes/tickets/parts.test.ts` does. Cases: happy path 201 shape (and that the response body contains **no** `storageKey`/`sha256`/`data`); org-scope-without-orgId 403; foreign ticket 404; soft-deleted ticket 409; zero parts 400; two parts 400; 11 MiB 413; a HEIC buffer 415; 20 pending 429; S3 fault 503 `STORAGE_UNAVAILABLE` with **no row inserted**; insert fault → `deleteBytes` called once and the original error surfaced; audit details contain `attachmentId`/`byteSize`/`contentType` and **not** `originalFilename`.
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/api exec vitest run src/routes/tickets/attachments.test.ts`.
- [ ] **Step 3: Implement** the route and mount it in `routes/tickets/index.ts` on the line **above** `ticketsRoutes.route('/', ticketsApiRoutes)`, with the same comment style the file already uses for literal-path-before-`/:id` ordering **[verified]** `index.ts:15-23`.
- [ ] **Step 4: Run to verify pass**, plus `pnpm --filter @breeze/api exec vitest run src/routes/tickets/` to prove no sibling route regressed on mount order.
- [ ] **Step 5: Commit** — `feat(api): POST /tickets/:id/attachments upload route (#3902)`.

---

### Task 9: Claim the pending rows inside the comment transaction

**Rigor: high** (introduces a transaction where there was none; a partial claim strands bytes or attaches a foreign file) · **Author: Claude**.

`addTicketComment` today writes with the global `db` across four separate statements — comment insert `:999`, `firstResponseAt` update `:1015`, event emit, outbox write **[verified]** `services/ticketService.ts:996-1044`. The claim must roll back with the comment, so those writes move onto one `db.transaction` handle.

**Files:**
- Modify: `apps/api/src/services/ticketService.ts` (`addTicketComment`)
- Modify: `apps/api/src/routes/tickets/tickets.ts:793-816` (pass `attachmentIds` through; it already arrives in `body` after Task 1)
- Test: `apps/api/src/services/ticketService.test.ts`, `apps/api/src/routes/tickets/tickets.test.ts`

**Interfaces:**
- Changed: `addTicketComment(ticketId, input: { content; isPublic; attachmentIds?: string[] }, actor)` → `{ comment, firstResponseStamped, attachments: TicketAttachmentMeta[] }`.

**The claim statement** (all five predicates are load-bearing; each gets its own test):
```sql
UPDATE ticket_attachments
   SET comment_id = $comment, attached_at = now()
 WHERE id = ANY($ids)
   AND ticket_id = $ticket          -- can't attach another ticket's file
   AND org_id = $org                -- belt with the RLS braces
   AND comment_id IS NULL           -- can't re-claim an attached file
   AND uploaded_by_user_id = $actor -- can't claim someone else's upload
```
Then `if (rowCount !== ids.length) throw new TicketServiceError('ATTACHMENT_NOT_CLAIMABLE', 409)` — inside the transaction, so the comment rolls back.

**Event/outbox/audit ordering:** `emitTicketEvent`, `writeTicketOutbox` and `createAuditLogAsync` stay **after** the transaction commits. Moving them inside would publish a `ticket.commented` for a comment that may still roll back. `ticket.commented`'s payload is unchanged (D14).

- [ ] **Step 1: Write the failing tests**
  - `attachmentIds: []` (the default) executes **no** claim UPDATE — the zero-attachment path must not regress into an extra round trip.
  - The claim's compiled SQL contains `comment_id IS NULL` and `uploaded_by_user_id` (assert the compiled SQL text, not the mock's call shape — a `where` object assertion is vacuous here).
  - Rowcount 1 with 2 ids → throws 409 `ATTACHMENT_NOT_CLAIMABLE` and the transaction mock's rollback path is taken.
  - The returned comment carries `attachments` with meta only (no `storageKey`, no `data`).
  - `firstResponseAt` is still stamped on the first public comment, now via `tx`.
  - Route test: `POST /tickets/:id/comments` with `{ content: '', attachmentIds: [uuid] }` → 201 (empty content is legal with an attachment, Task 1); with `{ content: '' }` alone → 400.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — wrap the four writes in `await db.transaction(async (tx) => { … })`, thread `tx` through, add the claim, return the claimed meta rows selected with `ATTACHMENT_META_COLUMNS`.
- [ ] **Step 4: Run to verify pass**, plus the whole `src/services/ticketService.test.ts` and `src/routes/tickets/tickets.test.ts` — `addTicketComment` has many callers (portal comment path, inbound email, AI helpdesk subscriber); a signature change that compiles can still break their mocks.
- [ ] **Step 5: Commit** — `feat(api): claim attachment rows inside the comment transaction (#3902)`.

---

### Task 10: Byte-serving and delete routes

**Rigor: high** (this is the read path a leak would travel) · **Author: Claude**.

**Files:**
- Modify: `apps/api/src/routes/tickets/attachments.ts`
- Test: `apps/api/src/routes/tickets/attachments.test.ts`

| Route | Permission | Behaviour |
|---|---|---|
| `GET /tickets/:id/attachments/:attachmentId/content` | `tickets:read` | D7 headers; streams via `openBytes`. |
| `DELETE /tickets/:id/attachments/:attachmentId` | `tickets:write` for own pending or own comment; `tickets:manage` for any | hard delete: object first, then row. |

**Visibility ladder for GET (D6) — one test per rung, all returning a bare 404 so the route never discloses existence:**
1. Row not found, or `row.ticket_id !== :id` → 404.
2. `comment_id IS NULL` (pending) and `uploaded_by_user_id !== actor` → 404.
3. Parent comment `deleted_at IS NOT NULL` → 404, **unless** the caller holds `tickets:manage`.
4. Ticket soft-deleted → 404 unless `tickets:manage` (matches `getScopedTicketOr404`'s `includeDeleted` convention **[verified]** `tickets.ts:781`).

**Headers:** `ETag: "<sha256>"`; an `If-None-Match` that matches → `304` with **no body and no `openBytes` call** (assert the storage mock was not invoked — a 304 that still fetched the bytes is a silent egress bill); `Cache-Control: private, max-age=300`; `X-Content-Type-Options: nosniff`; `Content-Type` from the stored `content_type` (never the client's); `Content-Disposition: inline; filename="…"` for `image/*` and `attachment; filename="…"` for `application/pdf`, with the filename quote-escaped.

**DELETE ordering:** `deleteBytes` then row DELETE. Reversed, a failed object delete leaves bytes with no row to find them by — the same reasoning as D9.

- [ ] **Step 1: Write the failing tests** — the four visibility rungs, the header set, 304-without-fetch, `Content-Disposition` per type, filename escaping, DELETE ownership matrix (own pending ✓, own comment ✓, other user's attachment ✗ without `tickets:manage`, ✓ with it), object-delete-before-row ordering (assert call order on the mocks).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(api): authenticated attachment content and delete routes (#3902)`.

---

### Task 11: `GET /tickets/:id` returns `attachments` per comment

**Rigor: low** · **Author: Codex-eligible** (reference: the existing comment/alert-link fetch block at `apps/api/src/routes/tickets/tickets.ts:485-508` **[verified]**).

**Files:**
- Modify: `apps/api/src/routes/tickets/tickets.ts` (detail handler, after the `commentRows` map at `:485-497`)
- Test: `apps/api/src/routes/tickets/tickets.test.ts`

- [ ] **Step 1: Failing tests**
  - Detail response: each comment gains `attachments: TicketAttachmentMeta[]`.
  - A soft-deleted comment reports `attachments: []` (it already blanks `content` at `:495` **[verified]**; attachments must follow, or a deleted comment still leaks its photos).
  - A pending row (`comment_id IS NULL`) never appears in the feed.
  - **The query selects `ATTACHMENT_META_COLUMNS`, asserted against the compiled SQL — `data` must not appear** (D10). This is the guard that keeps a 10 MiB blob out of every ticket-detail response.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — one extra query, `WHERE ticket_id = :id AND comment_id IS NOT NULL`, grouped into a `Map<commentId, meta[]>` in memory (no N+1, no join fan-out on the comment rows).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(api): ticket detail returns comment attachments (#3902)`.

---

### Task 12: Portal read path

**Rigor: high** (a customer-facing read where the failure mode is showing one tenant's photo to another) · **Author: Claude**.

**Files:**
- Modify: `apps/api/src/routes/portal/tickets.ts` (detail handler ~`:259-283`; new content route)
- Modify: `apps/portal/src/lib/api.ts` (~`:725` `getTicket`)
- Test: `apps/api/src/routes/portal/tickets.test.ts`

**Precondition to confirm first (one command, not a leap of faith):** the portal wraps handlers in `withDbAccessContext({ scope: 'organization', orgId: user.orgId, … })` **[verified]** `routes/portal/auth.ts:235-241`, so `breeze_has_org_access(org_id)` admits portal reads and **no** `withSystemDbAccessContext` fallback is needed. Confirm on the live DB in Task 16's integration suite before shipping; if it does not hold, the portal reads move to a system context behind the app-layer filters below — never the reverse.

**App-layer filter, mirroring the existing comment query at `:277-283` [verified]** (`eq(tickets.submittedBy, auth.user.id)`, `eq(ticketComments.isPublic, true)`, `isNull(ticketComments.deletedAt)`):
- Detail: attach `attachments` only to comments already passing that filter.
- `GET /portal/tickets/:id/attachments/:attachmentId/content`: 404 unless the ticket's `submitted_by` is the portal user AND the ticket is not soft-deleted AND the parent comment `is_public AND deleted_at IS NULL`. Same D7 headers as Task 10.

- [ ] **Step 1: Write the failing tests** — the leak cases first, because they are the point of the task: an attachment on an **internal** comment is neither listed nor served (404); an attachment on a ticket the session did **not** submit is 404; a pending row is 404; a soft-deleted parent comment is 404 (the portal has no `tickets:manage` escape hatch); the happy public-comment case serves bytes with `nosniff`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the API route + detail decoration, then the portal client method in `apps/portal/src/lib/api.ts`.
- [ ] **Step 4: Run to verify pass** — `pnpm --filter @breeze/api exec vitest run src/routes/portal/tickets.test.ts`.
- [ ] **Step 5: Commit** — `feat(api,portal): public-comment attachments in the customer portal (#3902)`.

---

### Task 13: Permission and scope contract test

**Rigor: low** · **Author: Codex-eligible**.

Closes the "permissions surfacing" gap explicitly rather than by silence: W08 adds **no** new permission, and that is a decision worth pinning, because adding one later would require the six-list sweep (`ai_agents_wave1` lesson).

**Files:**
- Test: `apps/api/src/routes/tickets/attachments.permissions.test.ts` (create)

- [ ] **Step 1: Write the test** — enumerate the three new routes and assert each is registered with an existing `PERMISSIONS.TICKETS_{READ,WRITE,MANAGE}` pair; assert `PERMISSIONS` gained no `attachments`-shaped entry (`Object.keys(PERMISSIONS).filter(k => /attach/i.test(k))` is empty); assert every new route carries `requireScope('organization','partner','system')` and the `auth.scope === 'organization' && !auth.orgId → 403` guard.
- [ ] **Step 2: Run to verify failure** (routes not yet enumerable if Tasks 8/10 are incomplete — run this task after them).
- [ ] **Step 3/4: Implement/verify.**
- [ ] **Step 5: Commit** — `test(api): pin the attachment routes to existing ticket permissions (#3902)`.

---

### Task 14: Pending-upload reaper

**Rigor: high** (an unattended sweep that deletes customer bytes) · **Author: Codex-eligible** for the SQL and the job module (reference: `apps/api/src/jobs/quoteExpiryReaper.ts` — queue/worker lifecycle, `runWithSystemDbAccess` guard, `MAX_REAP_PER_RUN = 500` **[verified]**); Claude owns the schedule-slot allocation.

**Files:**
- Create: `apps/api/src/jobs/ticketAttachmentReaper.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (allocate a slot)
- Modify: `apps/api/src/services/workerRegistry.ts` (register `init`/`shutdown`, mirroring the `quoteExpiryReaper` entry at `:923-928` **[verified]**)
- Test: `apps/api/src/jobs/ticketAttachmentReaper.test.ts`

**Schedule slot — this is what "hourly with jitter" means in this repo.** Do **not** invent a random offset. `scheduleRegistry.ts` is the allocator that exists precisely because BullMQ `repeat: { every: N }` epoch-aligns and stampedes at 00:01 UTC **[verified]** `scheduleRegistry.ts:1-20`. Add to the **sub-daily tier**, whose convention is minutes ≡ 2 (mod 5):
```ts
  'ticket-attachment-pending-reaper': '32 * * * *',
```
Minutes 2 and 32 are the only free ≡2 (mod 5) slots in that tier today — used minutes are 0, 7, 12, 15, 17, 22, 27, 35, 37, 42, 47, 52, 57 **[verified]** `scheduleRegistry.ts:126-141`. Register via `jobSchedule('ticket-attachment-pending-reaper')`, never an inline pattern string. Re-check the tier for a collision at implementation time — the map moves.

**Sweep:** `withSystemDbAccessContext` (system scope makes `breeze_has_org_access` TRUE, so the sweep sees every org **[verified]** `0008-tenant-rls.sql:42-52`; a contextless sweep would see nothing and silently do no work). `SELECT id, storage_backend, storage_key FROM ticket_attachments WHERE comment_id IS NULL AND created_at < now() - interval '24 hours' LIMIT 500` → `deleteObjectKeys` for the `s3` rows → `DELETE … WHERE id = ANY(...)`. Objects before rows, same as D9.

- [ ] **Step 1: Write the failing tests**
  - The predicate: a pending row aged 25 h **is** reaped; a pending row aged 23 h is **not**; an **attached** row aged 30 days is **not** (the single most damaging bug this job could have).
  - `LIMIT 500` is present.
  - Objects are deleted before rows (call-order assertion).
  - An object-store fault aborts the run and leaves the rows (next hour retries) rather than deleting rows whose bytes survive.
  - The job registers with `jobSchedule('ticket-attachment-pending-reaper')` and not a literal cron string.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the job, the slot, and the `workerRegistry` entry.
- [ ] **Step 4: Run to verify pass**, plus `pnpm --filter @breeze/api exec vitest run src/jobs/scheduleRegistry.test.ts src/services/workerRegistry.test.ts` (the registry has its own collision/shape guards).
- [ ] **Step 5: Commit** — `feat(api): hourly reaper for abandoned pending ticket attachments (#3902)`.

---

### Task 15: Org-erasure S3 object pre-clear

**Rigor: high** (GDPR erasure; D9) · **Author: Claude** (edits `cascadeDeleteOrg`, the highest-consequence function in the service).

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`cascadeDeleteOrg`, before the cascade-list walk at `:735` **[verified]**)
- Test: `apps/api/src/services/tenantCascade.test.ts`

**Placement:** a new step between the `ASSOCIATED_SYSTEM_SCOPED_TABLES` loop (`:709-730`) and the main `for (const table of order)` loop (`:735`). Both existing loops already run one `withSystemDbAccessContext` per unit and write a forensic `writeErasureFailedAudit` before rethrowing **[verified]** `:717-729` — the new step follows that exact shape.

**Behaviour (D9):**
```
SELECT storage_key FROM ticket_attachments WHERE org_id = $org AND storage_backend = 's3'
  -> batch deleteObjectKeys()
  -> on ANY fault: writeErasureFailedAudit(..., 'ticket_attachments_objects', ...) then throw
```
The error message must say the erasure is **rerunnable** — objects-before-rows means a re-run re-reads the same keys and finishes the job. Best-effort deletion with a logged count is explicitly rejected: it leaves customer bytes in the bucket with no row left to find them by.

- [ ] **Step 1: Write the failing tests** — the pre-clear runs **before** the first cascade-table DELETE (call-order assertion against the mocked `db.execute`); an object-store fault aborts erasure with rows intact and writes the failed-audit row; an org with only `db`-backend attachments issues **zero** S3 calls; an org with no attachments issues zero S3 calls and does not abort.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass**, then the live-DB roundtrip: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` (**read the test count**).
- [ ] **Step 5: Commit** — `feat(api): delete attachment objects before rows during org erasure (#3902)`.

---

### Task 16: RLS and lifecycle integration suite

**Rigor: high** · **Author: Claude**.

**Files:**
- Create: `apps/api/src/__tests__/integration/ticketAttachmentsRls.integration.test.ts`

Placement matters: a file under `src/__tests__/integration/**` is picked up by the shared glob in `vitest.integration.config.ts:12` **[verified]** and therefore runs in the blocking **Integration Tests** job. A co-located `*.integration.test.ts` elsewhere in `src/` would run in **zero** CI jobs unless explicitly added to that include list (memory: `integration_test_placement_and_runif_skip_trap`).

**Properties to prove against real Postgres (each its own `it`):**
1. Cross-org forge as `breeze_app` under an org-A context inserting an org-B row raises **42501** — with the positive control (same insert, org A) succeeding in the same test, so a broken statement can't masquerade as a passing isolation check.
2. Org A cannot `SELECT` an org-B attachment row (zero rows, not an error).
3. Portal isolation: an attachment on an **internal** comment is invisible to the portal read path; one on a public comment is visible.
4. `moveTicketOrg` re-stamps `ticket_attachments.org_id` (the mocked unit test in Task 3 asserts the statement's shape; only this one proves Postgres actually moved the row and RLS let it).
5. Device `move-org` re-stamps via the tickets join.
6. Org erasure with a **stubbed** S3 deletes objects before rows, and aborts rerunnably when the stub faults (rows still present afterwards).
7. `S3_BUCKET` unset → the `db` backend round-trips a byte-identical buffer through upload → claim → serve.
8. The portal DB-context precondition from Task 12: a portal-shaped `withDbAccessContext({ scope: 'organization', orgId })` can read a `ticket_attachments` row in that org. If this fails, Task 12's design assumption is wrong and the portal reads must move to a system context.

- [ ] **Step 1: Write the suite (red).**
- [ ] **Step 2: Run it and confirm a NON-ZERO test count:**
  `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketAttachmentsRls.integration.test.ts`
  Expected: FAIL on assertions, never `No test files found` and never `0 passed`.
- [ ] **Step 3: Fix whatever it catches** (this suite exists to catch things; a first run that passes everything is suspicious — re-read the setup).
- [ ] **Step 4: Green, then re-run the four contract suites from Task 2 Step 7 on their own runners.**
- [ ] **Step 5: Commit** — `test(api): ticket_attachments RLS, move, erasure and db-backend integration suite (#3902)`.

---
### Task 17: Web — render attachments in the ticket feed

**Rigor: low** · **Author: Claude** (React component with i18n).

`<img src>` cannot carry a Bearer token, so bytes come through `fetchWithAuth` → `blob()` → `URL.createObjectURL`, revoked on unmount (precedent: the avatar in `ProfilePage.tsx`).

**Files:**
- Modify: `apps/web/src/components/tickets/ticketConfig.ts` (`TicketComment.attachments?: TicketAttachmentMeta[]`)
- Modify: `apps/web/src/components/tickets/TicketFeed.tsx`
- Test: `apps/web/src/components/tickets/TicketFeed.test.tsx`

- [ ] **Step 1: Failing tests** — image attachments render as thumbnails and PDFs as file chips; every object URL created is revoked on unmount (spy on `URL.revokeObjectURL`); a comment with `attachments: []` renders exactly as today (no empty container, no layout shift); the delete control appears only when the viewer may delete; a fetch failure renders a broken-attachment placeholder rather than an empty box (memory: `quiet_failure_ui_needs_e2e_proof`).
- [ ] **Step 2: Run to verify failure** — `pnpm --filter @breeze/web exec vitest run src/components/tickets/TicketFeed.test.tsx`.
- [ ] **Step 3: Implement**, with all new strings under a `ticketFeed.attachments.*` namespace in `apps/web/src/locales/en/tickets.json` (other locales land in Task 18).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(web): render ticket comment attachments in the feed (#3902)`.

---

### Task 18: Web — composer upload, and all eight locales

**Rigor: low** (mechanically wide, not deep) · **Author: Claude**.

**Files:**
- Modify: `apps/web/src/components/tickets/TicketComposer.tsx`, `TicketWorkbench.tsx`
- Modify: **all eight** of `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/tickets.json` **[verified]** — `localeParity.test.ts` compares key sets **and** interpolation tokens across every locale dir, so an English-only key reddens `test-web`.
- Test: `TicketComposer.test.tsx`, `apps/web/src/lib/i18n/localeParity.test.ts` (existing), `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (existing)

- [ ] **Step 1: Failing tests** — file input restricted to `image/jpeg,image/png,image/webp,application/pdf`; a 6th file is rejected client-side with a toast; each file uploads through `fetchWithAuth` with a `FormData` body (the web helper already skips the JSON content-type **[verified]** `apps/web/src/stores/auth.ts:1059-1064`) wrapped in `runAction`; Send is disabled while any chip is uploading; the comment POST carries the successful ids; a failed upload leaves a Retry chip and the other chips intact.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, then add the same keys to the other seven locale files. Translate rather than copying English — `tr-TR` parity has broken branches before (memory: `tr_tr_locale_parity_breaks_every_prefork_branch`). Keep `{{count}}`-style tokens identical across locales or the parity test fails on tokens even with matching keys.
- [ ] **Step 4: Run to verify pass**
  ```bash
  pnpm --filter @breeze/web exec vitest run \
    src/components/tickets/ src/lib/i18n/localeParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts
  ```
  If a handler legitimately cannot use `runAction` (aggregate partial-success), record it in `apps/web/src/lib/runActionAllowlist.ts` **in this commit** rather than leaving the test red.
- [ ] **Step 5: Commit** — `feat(web): upload attachments from the ticket composer (#3902)`.

---

### Task 19: Documentation

**Rigor: low** · **Author: Codex-eligible** (reference: the Tickets endpoint table at `apps/docs/src/content/docs/reference/api.mdx:1050-1057` **[verified]**).

The API reference documents ticket endpoints in a Markdown table; three new routes plus the storage behaviour belong there, or self-hosters discover the `db`-backend trade-off by surprise.

**Files:**
- Modify: `apps/docs/src/content/docs/reference/api.mdx`

- [ ] **Step 1: Add three rows** to the Tickets table — `POST /tickets/:id/attachments`, `GET /tickets/:id/attachments/:attachmentId/content`, `DELETE /tickets/:id/attachments/:attachmentId` — each naming its permission.
- [ ] **Step 2: Add a short prose block** after the table covering: the two-step upload (`attachmentIds` on `POST /tickets/:id/comments`), the D5 limits (10 MiB/file, 5/comment, 20 pending/user, 30 uploads/min), the accepted types and that the client `Content-Type` is ignored in favour of magic-byte sniffing, that bytes are served **authenticated** (never a public or presigned URL), and that installs without `S3_BUCKET` store bytes in Postgres with identical behaviour.
- [ ] **Step 3: Build the docs** — `pnpm --filter @breeze/docs build`. Expected: no broken-link or MDX errors.
- [ ] **Step 4: Commit** — `docs: ticket attachment endpoints, limits and storage backends (#3902)`.

---

### Task 20: PR A finish

**Rigor: high** · **Author: Claude**.

- [ ] **Step 1: Full sweep**
  ```bash
  pnpm lint
  pnpm --filter @breeze/shared test && pnpm --filter @breeze/api test:run && pnpm --filter @breeze/web test
  pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts
  pnpm --filter @breeze/api test:rls-coverage
  pnpm --filter @breeze/api test:rls
  ```
  `pnpm test` alone does **not** run the RLS/integration configs; local green is not CI green.
- [ ] **Step 2: Diff the migration against `origin/main`** — `git diff origin/main --stat apps/api/migrations/` — to catch a mid-flight sweep that landed a newer date while this branch was open. An unmerged migration is still editable; a merged one never is.
- [ ] **Step 3: One independent review round, security lens** — portal leak paths, the sniffing bypass, the body-limit carve-out, the claim predicates, `Content-Disposition` header injection. Act only on confirmed, consequential findings; re-review only if a fix touched RLS, the claim transaction, or erasure.
- [ ] **Step 4: Open PR A and STOP.** Body: `Part of #3902`, the manual forge transcript (both controls), the reaper slot, and an explicit list of the five registration lists touched. Do not merge.

---

## PR B — Mobile

> Branch from `main` **after PR A merges**. A PR based on a sibling branch triggers no CI at all (`ci.yml` is `pull_request: branches: [main]`), which makes `gh pr checks` read green on nothing.

### Task 21: Mobile transport — `FormData` bodies on `coreRequest`

**Rigor: high** (touches the single authenticated transport every mobile call shares) · **Author: Claude**.

`requestWithPrefix` unconditionally sets `'Content-Type': 'application/json'` **[verified]** `apps/mobile/src/services/api.ts:248-251`. A `FormData` body needs the header **omitted** so the runtime can supply its own multipart boundary; setting it by hand corrupts every upload.

**Files:**
- Modify: `apps/mobile/src/services/api.ts`
- Test: `apps/mobile/src/services/api.test.ts` (or a new `api.formdata.test.ts` following the `api.logout.test.ts` / `api.mfa.test.ts` split convention **[verified]**)

**Precondition (run it, don't assume):** confirm the mobile token actually carries `tickets:write`. A W03 findings doc some drafts cite (`2026-08-23-mobile-time-entry-scope-findings.md`) **does not exist on `origin/main`** [verified via `git ls-tree`]; derive the scope from `apps/api/src/routes/auth/helpers.ts` and the mobile login response instead. If it does not, that is a blocking finding for the whole of PR B — surface it before writing UI.

- [ ] **Step 1: Failing tests** — with a `FormData` body the outgoing headers contain **no** `Content-Type`, and still contain `Authorization: Bearer`, the CSRF header (non-GET), and the mobile device-id header; with a JSON body the header is unchanged; `timeoutMs: 120_000` is honoured; a `device_blocked` response is handled identically for both body kinds (this is the whole reason D3 rejects `FileSystem.createUploadTask`).
- [ ] **Step 2: Run to verify failure** — `pnpm --filter breeze-mobile exec vitest run src/services/api*.test.ts`.
- [ ] **Step 3: Implement** the branch plus `export function getAuthImageHeaders(): Promise<Record<string,string>>` (Bearer + device-id, for `<Image source={{ uri, headers }}>`).
- [ ] **Step 4: Run to verify pass** — the whole `src/services/` suite; this file is on every code path in the app.
- [ ] **Step 5: Commit** — `feat(mobile): FormData bodies on the shared coreRequest transport (#3902)`.

---

### Task 22: Mobile packages, permissions and native prebuild

**Rigor: low** (config) but **release-blocking** · **Author: Claude**.

**Files:**
- Modify: `apps/mobile/package.json` — add `expo-image-picker`, `expo-image-manipulator`, `expo-document-picker`, `expo-image` (pin to the `~57.x` line matching the other Expo modules **[verified]** — the app is on `expo ~57.0.15`).
- Modify: `apps/mobile/app.json` — picker plugins with `photosPermission` / `cameraPermission` strings; Android `CAMERA` in the `permissions` array (currently `USE_BIOMETRIC, USE_FINGERPRINT, RECEIVE_BOOT_COMPLETED, VIBRATE` **[verified]** `app.json:33-38`).

- [ ] **Step 1: Rewrite the stale iOS camera string.** `app.json:19` currently reads `"NSCameraUsageDescription": "Camera access for QR code scanning"` **[verified]** — the app has no QR scanner. App Review rejects usage strings that do not match observed behaviour. Replace with the real reason (photographing a ticket's hardware/screen). Add `NSPhotoLibraryUsageDescription`.
- [ ] **Step 2: Install and prebuild** — `pnpm --filter breeze-mobile install`, then `npx expo prebuild --clean`. Requires a native build, not OTA. Known hazard: Ruby 4 / CocoaPods gem breakage on prebuild (memory: `ios_prebuild_ruby4_cocoapods_gem_breakage`) — budget for it, it is not a code bug.
- [ ] **Step 3: Verify** `pnpm --filter breeze-mobile typecheck` and `pnpm --filter breeze-mobile preflight`.
- [ ] **Step 4: Commit** — `chore(mobile): image/document picker modules and camera permission strings (#3902)`.

---

### Task 23: Mobile attachment service

**Rigor: low** · **Author: Codex-eligible** (reference: `apps/mobile/src/services/tickets.ts` for the `coreRequest` call shape and `tickets.test.ts` for the `vi.mock('./api')` convention **[verified]**).

**Files:**
- Create: `apps/mobile/src/services/ticketAttachments.ts`, `ticketAttachments.test.ts`
- Modify: `apps/mobile/src/services/tickets.ts` (`TicketComment.attachments`, `addTicketComment(id, content, isPublic, attachmentIds?)`)

**Interfaces:** `pickFromCamera()`, `pickFromLibrary()` (`mediaTypes: ['images']`, `quality: 0.8`, `exif: false`, `selectionLimit: 5 - pending`), `pickDocument()` (`application/pdf`), `prepareImage()` (manipulator → ≤2048 px long edge, JPEG q0.8), `uploadTicketAttachment(ticketId, file)` via `coreRequest` FormData with `timeoutMs: 120_000`, `attachmentContentUrl(ticketId, id)`, and a typed `AttachmentUploadError` mapping the six server codes to user-facing strings.

- [ ] **Step 1: Failing tests** — pickers request `exif: false` (D15: EXIF/GPS never leaves the phone); `prepareImage` re-encodes to JPEG and caps the long edge; a file over `maxBytes` fails **client-side** before any network call; each server error code maps to its own message (413/415/429/409/503 are distinguishable, not one generic "upload failed"); `addTicketComment` sends `attachmentIds` only when non-empty.
- [ ] **Step 2–4: Red, implement, green** — `pnpm --filter breeze-mobile exec vitest run src/services/ticketAttachments.test.ts src/services/tickets.test.ts`.
- [ ] **Step 5: Commit** — `feat(mobile): ticket attachment pickers, resize and upload service (#3902)`.

---

### Task 24: Mobile composer chips and feed rendering

**Rigor: low** · **Author: Claude** (RN screen).

**Files:**
- Modify: `apps/mobile/src/screens/tickets/TicketDetailScreen.tsx` (465 lines today **[verified]** — extract the attachment UI into `components/AttachmentChip.tsx` and a feed sub-component rather than growing one file past the 500-line guideline)
- Create: `apps/mobile/src/components/AttachmentChip.tsx`

- [ ] **Step 1: Failing tests** — attach button opens an action sheet (Take photo / Choose from library / Choose file); each pick uploads immediately and shows a chip; Send is disabled while any chip is uploading; a failed chip offers Retry and keeps the local file; with `useNetworkConnected()` false the attach button is disabled with an offline message; **nothing is ever written to `timeEntryQueue.ts`** (D13 — assert the queue module is never called); the feed renders a 3-column image grid plus PDF rows.
- [ ] **Step 2–4: Red, implement, green.**
- [ ] **Step 5: Commit** — `feat(mobile): attach photos and files to ticket comments (#3902)`.

---

### Task 25: `AttachmentViewer` modal route

**Rigor: low** · **Author: Claude**.

The spec's full-screen viewer has no home today: `TicketsStackParamList` declares only `Tickets` and `TicketDetail` **[verified]** `apps/mobile/src/navigation/MainNavigator.tsx:22-25`.

**Files:**
- Modify: `apps/mobile/src/navigation/MainNavigator.tsx`
- Create: `apps/mobile/src/screens/tickets/AttachmentViewerScreen.tsx`

- [ ] **Step 1: Failing test** — `TicketsStackParamList` includes `AttachmentViewer: { ticketId: string; attachmentId: string; contentType: string; filename: string }`, the screen is registered on `TicketsStack` with `presentation: 'modal'`, and tapping a feed thumbnail navigates to it with those params.
- [ ] **Step 2–4: Red, implement, green.** The viewer loads bytes with `getAuthImageHeaders()` (Task 21) via `expo-image` with `cachePolicy: 'memory-disk'`; PDFs download to cache and open the share sheet rather than rendering inline.
- [ ] **Step 5: Commit** — `feat(mobile): full-screen attachment viewer route (#3902)`.

---

### Task 26: PR B finish

**Rigor: high** (ships to phones) · **Author: Claude**.

- [ ] **Step 1: Sweep** — `pnpm --filter breeze-mobile test && pnpm --filter breeze-mobile typecheck && pnpm --filter breeze-mobile preflight && pnpm lint`.
- [ ] **Step 2: Real-device pass, recorded in the PR body** — iOS camera capture and library pick (HEIC selected → transcoded → accepted; served bytes carry no EXIF), PDF pick, airplane mode mid-upload → Retry chip, Android 13 media permission grant, portal-visible public comment vs invisible internal comment.
- [ ] **Step 3: One review round** if any finding touches the transport change from Task 21.
- [ ] **Step 4: Open PR B and STOP.** Body: `Closes #3902`, the device-test transcript, and a note that this build is native (not OTA). Do not merge.

---

## Open product questions

Each carries the default the plan implements unless the owner overrides it. None blocks starting Task 1.

| # | Question | Default implemented |
|---|---|---|
| 1 | Images + PDF in v1, or images only? | JPEG/PNG/WebP **+ PDF**. Cutting to images-only changes only Task 4's sniffer and the picker; no schema change. |
| 2 | 10 MiB/file, 5/comment, 20 pending/user, 30 uploads/min? | Yes. Raising the per-file cap later needs a migration (the CHECK mirrors it). |
| 3 | May portal customers upload? | No — render-only. A later setting, defaulting off. |
| 4 | Attachment bytes in the GDPR export bundle? | Metadata rows only; `data` is `excludedOpen`. |
| 5 | Server-side EXIF stripping (adds `sharp`)? | Deferred. Mobile strips on-device (D15); the web composer discloses that it does not. |
| 6 | Should `ticket.commented` consumers learn about attachments? | No payload change (D14). |
| 7 | Byte-level upload progress bar? | No — "Sending N of M" from one-file-per-request. |
| 8 | Purge objects when a comment or ticket is soft-deleted? | Hide only; rows and objects survive so restore is free. A hard-purge job is future work. |
| 9 | Fix the pre-existing `ticket_comments` org-erasure FK gap here? | No — separate issue. Evidence for filing it: the FK is declared at `0001-baseline.sql:14910` with no `ON DELETE` clause, and `grep ticket_comments apps/api/src/services/tenantCascade.ts` returns zero hits. |
| 10 | Drop the unused `ticket_comments.attachments jsonb` column? | No — separate cleanup migration. |
| 11 | Reaper grace period of 24 h? | Yes. Shorter risks reaping a slow composer; longer grows the pending table. |
