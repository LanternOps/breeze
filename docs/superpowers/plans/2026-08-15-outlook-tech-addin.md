# Outlook Tech Persona (MSP Ticketing Add-in) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a technician-facing ticketing persona to the existing Outlook add-in — persona resolved server-side at token exchange, with email→ticket link/create, auto-threading via a new `ticket_email_links` ledger, and time entries.

**Architecture:** One manifest/deployment; a new neutral `POST /office-addin/auth/exchange` picks `tech` vs `client` persona per login via a new MFA-established `office_addin_user_bindings` table. Tech requests use an opaque Redis session validated by a new middleware that re-derives live authorization per request. Thin `/office-addin/*` routes call existing services (`ticketService`, `timeEntryService`) plus a shared thread matcher extracted from `inboundEmailService`; a new `ticket_email_links` table is the cross-channel association + idempotency ledger shared with the inbound pipeline.

**Tech Stack:** Hono + Drizzle + Redis (API), Vitest, React + Vite (`apps/outlook-addin` + `packages/office-addin-core`), Postgres RLS.

**Spec:** `docs/superpowers/specs/2026-08-15-outlook-tech-addin-design.md`

## Global Constraints

- v1 scope only: no AI reply drafting, no mailbox backfill, no shared mailboxes, no compose-mode tech actions (spec §Scope).
- `POST /client-ai/auth/exchange` behavior is NOT modified; Word/Excel/PowerPoint add-ins are untouched.
- All tech request bodies are POST — no sender addresses/Message-IDs/subjects in URLs.
- The tech session token is accepted ONLY by `/office-addin` tech routes — never `/api/v1/*` general routes, never `/client-ai/*`.
- Email is never an authorization identifier; the binding on `(entra_tenant_id, entra_oid)` is the only Entra→Breeze-user path.
- Add-in capabilities intersect with live RBAC — narrow, never replace.
- Migrations: `apps/api/migrations/YYYY-MM-DD-<slug>.sql`, idempotent, no inner `BEGIN/COMMIT`, RLS policies in the same migration that creates the table. Never edit shipped migrations. Use date `2026-08-22` or later (latest shipped is `2026-08-21-patch-reboot-delay-minutes.sql`); `2026-08-06` is a closed block.
- `ticket_email_links` registrations (same PR as the migration): auto-discovered shape-1 RLS, `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`. `office_addin_user_bindings` (no `org_id`): `PARTNER_TENANT_TABLES` only.
- Contract suites (`vitest.config.rls.ts`, `vitest.integration.config.ts`) need a real DB and are NOT run by `pnpm test` — run them explicitly for the tasks that touch tenancy/cascade code.
- Outlook manifest minimum stays at its current requirement set (VersionOverrides `DefaultMinVersion=1.5`) — header reads are runtime capability-detected, never a manifest bump.
- The AI draft is always a prefill; AI never chooses tenant, customer, or thread association. Create/link flows never block on AI.
- Commit after every task (checkpoint commits; worktree `outlook-adding-for-ticketing`).

## File Structure

**API — new:**
- `apps/api/src/db/schema/ticketEmailLinks.ts`, `apps/api/src/db/schema/officeAddin.ts`
- `apps/api/migrations/2026-08-22-ticket-email-links.sql`, `apps/api/migrations/2026-08-22-office-addin-user-bindings.sql`
- `apps/api/src/services/inboundEmail/threadMatcher.ts` (extracted matcher)
- `apps/api/src/services/inboundEmail/emailComments.ts` (extracted inbound-comment insert)
- `apps/api/src/services/ticketEmailLinks.ts` (ledger claim/lookup)
- `apps/api/src/services/officeAddin/techSession.ts`, `officeAddinBindings.ts`, `emailContext.ts`, `aiEmailDraft.ts`
- `apps/api/src/middleware/officeAddinTechAuth.ts`
- `apps/api/src/routes/officeAddin/index.ts`, `auth.ts`, `bindingsAdmin.ts`, `emailContext.ts`, `tickets.ts`, `time.ts`, `schemas.ts`

**API — modified:**
- `apps/api/src/index.ts` (mount `/office-addin`)
- `packages/extension-sdk/src/manifest.ts` (`RESERVED_ROUTE_NAMESPACES`)
- `apps/api/src/services/inboundEmail/inboundEmailService.ts` (consume extracted modules; record reply link rows)
- `apps/api/src/services/clientAiEntraJwt.ts` (expose `scp`), new `apps/api/src/services/clientAiExchange.ts` (extracted client resolver), `apps/api/src/routes/clientAi/auth.ts` (call it)
- `apps/api/src/middleware/auth.ts` (export `computeAccessibleOrgIds`)
- `apps/api/src/services/ticketService.ts` (add `listOrgTicketsForAddin`)
- `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (registrations)
- `apps/api/src/db/schema/index.ts` (barrel exports)

**Frontend — modified/new:**
- `packages/office-addin-core/src/auth/session.ts` (versioned store, persona-aware exchange), `src/components/App.tsx` (persona renderer injection), `src/api/client.ts` (unchanged consumers)
- `apps/outlook-addin/src/main.tsx` (pass tech renderer + exchange path)
- `apps/outlook-addin/src/tech/` — `api.ts`, `emailIdentity.ts`, `itemGeneration.ts`, `TechPane.tsx`, `ContextCard.tsx`, `TicketList.tsx`, `CreateTicketForm.tsx`, `LinkEmailAction.tsx`, `TimeWidget.tsx`, `BindFlow.tsx`

**Web UI:**
- `apps/web/src/components/settings/OfficeAddinBindingsPage.tsx` + a page route following the neighboring partner-settings page pattern.

---

## Phase 1 — Data layer & shared services

### Task 1: `ticket_email_links` table + full tenancy registration

**Files:**
- Create: `apps/api/src/db/schema/ticketEmailLinks.ts`
- Create: `apps/api/migrations/2026-08-22-ticket-email-links.sql`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './ticketEmailLinks';` alphabetically)
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Test: `apps/api/src/__tests__/integration/ticketEmailLinksRls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle table `ticketEmailLinks` (`ticket_email_links`) with columns `id, ticketId, orgId, partnerId, messageId, commentId, origin, visibility, linkedBy, createdAt`; unique `(partner_id, message_id)`.

- [ ] **Step 1: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/ticketEmailLinks.ts
import { pgTable, uuid, text, varchar, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tickets, ticketComments } from './tickets';
import { organizations, partners } from './orgs';
import { users } from './users';

// Cross-channel email↔ticket association + idempotency ledger (spec §4).
// Tenancy: shape 1 (direct org_id, auto-discovered RLS). partner_id is
// denormalized ONLY for the (partner_id, message_id) idempotency claim —
// it is NOT an access axis; keep this table out of DUAL_AXIS_TENANT_TABLES.
export const ticketEmailLinks = pgTable('ticket_email_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  messageId: text('message_id').notNull(), // normalized RFC 5322 Message-ID, angle brackets included
  commentId: uuid('comment_id').references(() => ticketComments.id, { onDelete: 'set null' }),
  origin: varchar('origin', { length: 20 }).notNull(), // 'addin_link' | 'addin_create' | 'inbound' (extensible: 'backfill')
  visibility: varchar('visibility', { length: 10 }).notNull(), // 'public' | 'internal'
  linkedBy: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }), // null for pipeline-origin rows
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('ticket_email_links_partner_message_uq').on(t.partnerId, t.messageId),
  index('ticket_email_links_ticket_idx').on(t.ticketId),
]);
```

Add `export * from './ticketEmailLinks';` to `apps/api/src/db/schema/index.ts` in alphabetical position (between the `ticketConfig`-area exports and `ticketForms`/`ticketMailbox`).

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-08-22-ticket-email-links.sql
-- ticket_email_links: cross-channel email↔ticket association + idempotency ledger.
-- Tenancy shape 1 (direct org_id). partner_id denormalized for the
-- (partner_id, message_id) idempotency claim only. Registered in
-- CORE_ORG_CASCADE_DELETE_ORDER and CORE_TENANT_EXPORT_POLICY in the same PR.
-- Idempotent: IF NOT EXISTS guards throughout; re-applying is a no-op.

CREATE TABLE IF NOT EXISTS ticket_email_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  message_id text NOT NULL,
  comment_id uuid REFERENCES ticket_comments(id) ON DELETE SET NULL,
  origin varchar(20) NOT NULL,
  visibility varchar(10) NOT NULL,
  linked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE ticket_email_links
    ADD CONSTRAINT ticket_email_links_origin_chk
    CHECK (origin IN ('addin_link', 'addin_create', 'inbound', 'backfill'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ticket_email_links
    ADD CONSTRAINT ticket_email_links_visibility_chk
    CHECK (visibility IN ('public', 'internal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_email_links_partner_message_uq
  ON ticket_email_links (partner_id, message_id);
CREATE INDEX IF NOT EXISTS ticket_email_links_ticket_idx
  ON ticket_email_links (ticket_id);

ALTER TABLE ticket_email_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_email_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_email_links;
CREATE POLICY breeze_org_isolation_select ON ticket_email_links
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_email_links;
CREATE POLICY breeze_org_isolation_insert ON ticket_email_links
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_email_links;
CREATE POLICY breeze_org_isolation_update ON ticket_email_links
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_email_links;
CREATE POLICY breeze_org_isolation_delete ON ticket_email_links
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_email_links TO breeze_app;
```

(Policy names/pattern copied from `apps/api/migrations/2026-08-19-contacts.sql:135-158`.)

- [ ] **Step 3: Register in cascade + export lists**

In `apps/api/src/services/tenantCascade.ts`, add `'ticket_email_links'` to `CORE_ORG_CASCADE_DELETE_ORDER` **between `'ticket_alert_links'` and `'ticket_form_org_links'`** (alphabetical; FK-direction safe — `ticket_email_links` sorts before its parent `tickets`, and its `comment_id`/`linked_by` FKs are `SET NULL`).

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, add between the `ticket_alert_links` and `ticket_form_org_links` entries:

```ts
"ticket_email_links": tablePolicy("org_id", {
  included: ["id", "ticket_id", "org_id", "partner_id", "message_id", "comment_id", "origin", "visibility", "linked_by", "created_at"],
  reviewedIncluded: [],
  excludedSensitive: [],
  excludedOpen: [],
}),
```

- [ ] **Step 4: Write the RLS forge integration test**

```ts
// apps/api/src/__tests__/integration/ticketEmailLinksRls.integration.test.ts
// Cross-tenant forge: inserting a ticket_email_links row for another org's
// ticket as breeze_app under an org-scoped context must fail with 42501.
// Model setup on emailInboundRls.integration.test.ts (two partners, one org
// + ticket each, withDbAccessContext per actor).
import { describe, it, expect } from 'vitest';
// ...same harness imports as emailInboundRls.integration.test.ts...

describe('ticket_email_links RLS', () => {
  it('rejects cross-org insert with 42501', async () => {
    // as org A context: insert link for org B's ticket → expect error.code 42501
  });
  it('allows same-org insert and blocks cross-org select', async () => {
    // insert as org A; select as org B returns 0 rows
  });
});
```

Fill the test bodies by copying the fixture helpers from `apps/api/src/__tests__/integration/emailInboundRls.integration.test.ts` (partner/org/ticket factories + `withDbAccessContext` wrappers) — assert `42501` on the forge and empty cross-org reads.

- [ ] **Step 5: Run migration + contract suites**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate && pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketEmailLinksRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/services/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts
```

Expected: all pass (rls-coverage auto-discovers the new shape-1 table; cascade + export suites see the new entries). If the integration config paths differ, locate them via `ls apps/api/vitest*.config.ts` and match existing invocation in `.github/workflows/ci.yml`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/ticketEmailLinks.ts apps/api/src/db/schema/index.ts \
  apps/api/migrations/2026-08-22-ticket-email-links.sql \
  apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/__tests__/integration/ticketEmailLinksRls.integration.test.ts
git commit -m "feat(api): ticket_email_links ledger table with RLS + cascade/export registration"
```

### Task 2: `office_addin_user_bindings` table

**Files:**
- Create: `apps/api/src/db/schema/officeAddin.ts`
- Create: `apps/api/migrations/2026-08-22-office-addin-user-bindings.sql`
- Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`)
- Test: `apps/api/src/__tests__/integration/officeAddinBindingsRls.integration.test.ts`

**Interfaces:**
- Produces: Drizzle table `officeAddinUserBindings` with `id, entraTenantId, entraOid, userId, partnerId, boundAuthEpoch, mfaVerifiedAt, createdAt, revokedAt, revokedBy`. Partial uniques among non-revoked rows on `(entra_tenant_id, entra_oid)` and `(user_id)`.

- [ ] **Step 1: Write the Drizzle schema**

```ts
// apps/api/src/db/schema/officeAddin.ts
import { pgTable, uuid, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { partners } from './orgs';
import { sql } from 'drizzle-orm';

// Entra identity → Breeze technician binding for the Office add-in tech
// persona (spec §2.2). Tenancy: shape 3 partner-axis (no org_id → no
// cascade/export registration). The binding is MFA-established
// (mfa_verified_at) and is the ONLY path from an Entra identity to a
// Breeze user — email is never an authorization identifier.
// bound_auth_epoch snapshots users.auth_epoch at bind time; a later epoch
// advance (password reset / forced logout) invalidates the binding.
export const officeAddinUserBindings = pgTable('office_addin_user_bindings', {
  id: uuid('id').primaryKey().defaultRandom(),
  entraTenantId: uuid('entra_tenant_id').notNull(),
  entraOid: uuid('entra_oid').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  boundAuthEpoch: integer('bound_auth_epoch').notNull(),
  mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by').references(() => users.id),
}, (t) => [
  uniqueIndex('office_addin_bindings_identity_active_uq')
    .on(t.entraTenantId, t.entraOid).where(sql`revoked_at IS NULL`),
  uniqueIndex('office_addin_bindings_user_active_uq')
    .on(t.userId).where(sql`revoked_at IS NULL`),
]);
```

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-08-22-office-addin-user-bindings.sql
-- office_addin_user_bindings: MFA-established Entra→technician binding for
-- the Office add-in tech persona. Tenancy shape 3 (partner-axis); no org_id,
-- so no cascade/export registration. Registered in PARTNER_TENANT_TABLES.
-- Idempotent: IF NOT EXISTS guards throughout.

CREATE TABLE IF NOT EXISTS office_addin_user_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_tenant_id uuid NOT NULL,
  entra_oid uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  bound_auth_epoch integer NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id)
);

-- The bound user must belong to the bound partner: composite FK against
-- users(id, partner_id). users.id is the PK so this index is trivially
-- unique; it exists to satisfy the FK reference.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_partner_id_key ON users (id, partner_id);
DO $$ BEGIN
  ALTER TABLE office_addin_user_bindings
    ADD CONSTRAINT office_addin_bindings_user_partner_fk
    FOREIGN KEY (user_id, partner_id) REFERENCES users (id, partner_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS office_addin_bindings_identity_active_uq
  ON office_addin_user_bindings (entra_tenant_id, entra_oid) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS office_addin_bindings_user_active_uq
  ON office_addin_user_bindings (user_id) WHERE revoked_at IS NULL;

ALTER TABLE office_addin_user_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_addin_user_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS office_addin_user_bindings_partner_access ON office_addin_user_bindings;
CREATE POLICY office_addin_user_bindings_partner_access ON office_addin_user_bindings
  USING (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR public.breeze_has_partner_access(partner_id)
  );

GRANT SELECT, INSERT, UPDATE ON office_addin_user_bindings TO breeze_app;
-- No DELETE grant: bindings are revoked (revoked_at), never deleted, so the
-- audit trail of who was bound survives.
```

- [ ] **Step 3: Register + forge test**

In `rls-coverage.integration.test.ts` add to `PARTNER_TENANT_TABLES` (map around line 165): `['office_addin_user_bindings', 'partner_id'],` in alphabetical position. (No `org_id` column → no exclusion-set entry, no cascade/export entries. Partner erasure sweeps `partner_id` columns dynamically — verify `cascadeDeletePartner` handles the missing DELETE grant; if partner cascade needs DELETE, grant it and note why.)

Write `apps/api/src/__tests__/integration/officeAddinBindingsRls.integration.test.ts` modeled on the Task 1 forge test: cross-partner insert as `breeze_app` under partner A's context targeting partner B → `42501`; cross-partner select returns 0 rows.

- [ ] **Step 4: Run migration + contract suites**

```bash
pnpm db:migrate && pnpm db:check-drift
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/officeAddinBindingsRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/officeAddin.ts apps/api/src/db/schema/index.ts \
  apps/api/migrations/2026-08-22-office-addin-user-bindings.sql \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts \
  apps/api/src/__tests__/integration/officeAddinBindingsRls.integration.test.ts
git commit -m "feat(api): office_addin_user_bindings table (partner-axis RLS)"
```

### Task 3: Extract shared thread matcher (behavior-neutral)

**Files:**
- Create: `apps/api/src/services/inboundEmail/threadMatcher.ts`
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts`
- Test: existing suites (`inboundEmailService.test.ts` etc.) — no new tests; this step must be invisible to them.

**Interfaces:**
- Produces (consumed by Tasks 4, 15, 16, 17):

```ts
export interface ThreadMatchInput {
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  subject?: string | null;
}
export interface MatchedTicket { id: string; partnerId: string; orgId: string; status: string; emailThreadKey: string | null; internalNumber: string | null }
export const TICKET_TOKEN_RE: RegExp; // /\bT-(\d{4})-(\d{4,})\b/ — unbracketed on purpose
export function candidateThreadKeys(input: ThreadMatchInput): string[];
export async function findTicketInPartner(input: ThreadMatchInput, partnerId: string): Promise<MatchedTicket | null>;
export async function findClosedTicketInPartner(input: ThreadMatchInput, partnerId: string): Promise<MatchedTicket | null>;
```

- [ ] **Step 1: Move the code**

Move `findTicketInPartner` (inboundEmailService.ts:387), `findClosedTicketInPartner` (:438), `candidateThreadKeys` (:373), `MatchedTicket` (:353), `MATCH_COLS` (:362) and the `TOKEN_RE` constant (:33, renamed export `TICKET_TOKEN_RE`) into `threadMatcher.ts`. Change the input type from `NormalizedInboundEmail` to `ThreadMatchInput` (the functions only read `inReplyTo`, `references`, `subject`, `messageId`). Preserve **exactly**:
- Live matcher pass 1: `status <> 'closed'`, `deleted_at IS NULL`, keys match `email_thread_key` **OR** `email_message_id`.
- Live pass 2: subject-token vs `internal_number`.
- Closed matcher: `status = 'closed'`, header pass matches **only** `email_thread_key` (the asymmetry is intentional — keep the comment explaining why).
- `deleted_at IS NULL` on every branch.

In `inboundEmailService.ts`, import from `./threadMatcher`, keep a local `const TOKEN_RE = TICKET_TOKEN_RE` for the subject-strip in `createFromEmail`, and pass the normalized email through (it structurally satisfies `ThreadMatchInput`). Do **not** move the sender-auth gate — it stays in `processInboundEmail`, upstream of matching (the add-in caller is authenticated staff; the gate must not live inside the shared service).

- [ ] **Step 2: Run the existing suites — must be untouched-green**

```bash
pnpm --filter @breeze/api exec vitest run src/services/inboundEmail/ src/jobs/inboundEmailWorker.test.ts
```

Expected: PASS with zero test-file edits (this is the behavior-neutrality proof; `inboundEmailWorker.test.ts` also asserts `processInboundEmail`'s exact arity — unchanged).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/inboundEmail/threadMatcher.ts apps/api/src/services/inboundEmail/inboundEmailService.ts
git commit -m "refactor(api): extract shared email thread matcher from inboundEmailService"
```

### Task 4: Ledger service + matcher/pipeline integration

**Files:**
- Create: `apps/api/src/services/ticketEmailLinks.ts`
- Create: `apps/api/src/services/ticketEmailLinks.test.ts`
- Modify: `apps/api/src/services/inboundEmail/threadMatcher.ts` (consult link rows)
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts` (record link rows)
- Test: `apps/api/src/__tests__/integration/ticketEmailLinksClaim.integration.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TicketEmailLink { id: string; ticketId: string; orgId: string; partnerId: string; messageId: string; commentId: string | null; origin: string; visibility: string; linkedBy: string | null }
export function normalizeMessageId(raw: string): string; // trim; wrap in <> when missing
export interface ClaimInput { ticketId: string; orgId: string; partnerId: string; messageId: string; origin: 'addin_link' | 'addin_create' | 'inbound'; visibility: 'public' | 'internal'; linkedBy?: string | null; commentId?: string | null }
export type ClaimResult = { created: true; link: TicketEmailLink } | { created: false; existing: TicketEmailLink };
export async function claimMessageLink(input: ClaimInput): Promise<ClaimResult>; // INSERT ... ON CONFLICT (partner_id,message_id) DO NOTHING; on conflict, SELECT + return existing
export async function findLinkByMessageId(partnerId: string, messageId: string): Promise<TicketEmailLink | null>;
export async function findTicketIdsByMessageIds(partnerId: string, messageIds: string[]): Promise<string[]>;
```

- [ ] **Step 1: Write failing unit tests**

```ts
// apps/api/src/services/ticketEmailLinks.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeMessageId } from './ticketEmailLinks';

describe('normalizeMessageId', () => {
  it('trims whitespace and preserves angle brackets', () => {
    expect(normalizeMessageId('  <abc@example.com>  ')).toBe('<abc@example.com>');
  });
  it('wraps bare ids in angle brackets', () => {
    expect(normalizeMessageId('abc@example.com')).toBe('<abc@example.com>');
  });
  it('throws on empty input', () => {
    expect(() => normalizeMessageId('   ')).toThrow();
  });
});
```

(Claim/lookup query functions are covered by the integration test in Step 4 — Drizzle-mock unit tests for `onConflictDoNothing` chains are vacuous; see the `vacuous_drizzle_where_clause_assertions` memory.)

- [ ] **Step 2: Run to verify fail, then implement**

`pnpm --filter @breeze/api exec vitest run src/services/ticketEmailLinks.test.ts` → FAIL (module not found).

```ts
// apps/api/src/services/ticketEmailLinks.ts
import { db } from '../db';
import { ticketEmailLinks } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export function normalizeMessageId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty message id');
  return trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed}>`;
}

export async function claimMessageLink(input: ClaimInput): Promise<ClaimResult> {
  const messageId = normalizeMessageId(input.messageId);
  const inserted = await db.insert(ticketEmailLinks)
    .values({ ...input, messageId, linkedBy: input.linkedBy ?? null, commentId: input.commentId ?? null })
    .onConflictDoNothing({ target: [ticketEmailLinks.partnerId, ticketEmailLinks.messageId] })
    .returning();
  if (inserted.length > 0) return { created: true, link: inserted[0] };
  const existing = await findLinkByMessageId(input.partnerId, messageId);
  if (!existing) throw new Error('claim conflict but no existing link visible'); // RLS-invisible winner; treat as retryable
  return { created: false, existing };
}

export async function findLinkByMessageId(partnerId: string, messageId: string) {
  const rows = await db.select().from(ticketEmailLinks)
    .where(and(eq(ticketEmailLinks.partnerId, partnerId), eq(ticketEmailLinks.messageId, normalizeMessageId(messageId))))
    .limit(1);
  return rows[0] ?? null;
}

export async function findTicketIdsByMessageIds(partnerId: string, messageIds: string[]): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const rows = await db.selectDistinct({ ticketId: ticketEmailLinks.ticketId }).from(ticketEmailLinks)
    .where(and(eq(ticketEmailLinks.partnerId, partnerId), inArray(ticketEmailLinks.messageId, messageIds)));
  return rows.map((r) => r.ticketId);
}
```

Run again → PASS.

- [ ] **Step 3: Wire into matcher and pipeline**

In `threadMatcher.ts`, extend `findTicketInPartner` pass 1: compute `linkTicketIds = await findTicketIdsByMessageIds(partnerId, keys)` and widen the WHERE to `(...existing key OR... OR inArray(tickets.id, linkTicketIds))` when non-empty — still constrained by `status <> 'closed'` AND `deleted_at IS NULL` (link rows must never re-enable appending to closed/deleted tickets; the closed matcher gets the same widening under `status = 'closed'`).

In `inboundEmailService.ts`:
- After `appendInboundComment` succeeds (matched-reply path), record the reply's own Message-ID: `if (n.messageId) await claimMessageLink({ ticketId, orgId: matched.orgId, partnerId, messageId: n.messageId, origin: 'inbound', visibility: 'public', commentId })` — swallow `created:false` (poller retry). This preserves the next hop when clients strip older References.
- After `createFromEmail` succeeds, record the originating Message-ID the same way (`origin: 'inbound'`).
- These writes participate in the pipeline's outer transaction — a rollback discards them together with the comment/ticket, which is the correct behavior (do NOT copy the `logInboundFailedDurable` outside-context pattern here).

- [ ] **Step 4: Write the race integration test**

```ts
// apps/api/src/__tests__/integration/ticketEmailLinksClaim.integration.test.ts
// Proves the (partner_id, message_id) claim: two concurrent claimMessageLink
// calls for the same message produce exactly one row; the loser receives the
// winner's association. Also: inbound reply processing records the reply's
// own Message-ID as a link row, and a link row on a CLOSED ticket does not
// resurrect it in findTicketInPartner.
describe('ticket_email_links claim', () => {
  it('concurrent claims: exactly one created', async () => {
    const [a, b] = await Promise.all([claimMessageLink(input), claimMessageLink(input)]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });
  it('inbound reply records its own message-id as a link row', async () => {
    // run processInboundEmail with a reply matching an open ticket; assert a
    // link row exists for the reply's messageId with origin 'inbound'
  });
  it('link rows never re-enable closed tickets in the live matcher', async () => {
    // closed ticket + link row for key K → findTicketInPartner({inReplyTo: K}) === null
    // and findClosedTicketInPartner finds it
  });
});
```

Use the fixtures from `inboundEmail.integration.test.ts` (CASE 5 is the concurrency precedent). Run:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/ticketEmailLinksClaim.integration.test.ts \
  src/services/inboundEmail/inboundEmail.integration.test.ts
```

Expected: PASS, including the pre-existing inbound suite (matcher widening is additive).

- [ ] **Step 5: Run unit suites + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/inboundEmail/ src/services/ticketEmailLinks.test.ts
git add -A apps/api/src/services apps/api/src/__tests__/integration/ticketEmailLinksClaim.integration.test.ts
git commit -m "feat(api): ticket_email_links claim service; matcher + inbound pipeline consult/record link rows"
```

### Task 5: Extract inbound email comment helper (behavior-neutral)

**Files:**
- Create: `apps/api/src/services/inboundEmail/emailComments.ts`
- Modify: `apps/api/src/services/inboundEmail/inboundEmailService.ts` (`appendInboundComment` delegates)
- Test: existing `inboundEmailService.test.ts` stays green unchanged.

**Interfaces:**
- Produces (consumed by Task 17):

```ts
export interface EmailCommentInput {
  ticketId: string;
  orgId: string;              // for the emitted event; pipeline passes '' today (existing wart, preserved)
  senderPortalUserId?: string | null;
  authorName: string;         // stored portal-user name preferred over spoofable display name — caller resolves
  content: string;
}
export async function insertEmailAuthoredComment(input: EmailCommentInput): Promise<{ commentId: string }>;
```

- [ ] **Step 1: Extract**

Move the body of `appendInboundComment` (inboundEmailService.ts:595) into `insertEmailAuthoredComment`: direct `ticket_comments` insert with `userId: null`, `portalUserId`, `authorName`, `authorType: 'email'`, `commentType: 'comment'`, `isPublic: true`, then `emitTicketEvent({ type: 'ticket.commented', ..., payload: { commentId, isPublic: true, inbound: true } })`. **Never** route through `addTicketComment` — that stamps `firstResponseAt` for public comments and marks the author internal. The `inbound: true` flag is what stops `ticketNotifyWorker` echoing the email back to its own sender. `appendInboundComment` becomes a thin adapter passing `orgId: ''` exactly as today.

- [ ] **Step 2: Verify neutral + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/inboundEmail/ src/jobs/ticketNotifyWorker.test.ts src/services/ticketEventsContract.test.ts
git add apps/api/src/services/inboundEmail/emailComments.ts apps/api/src/services/inboundEmail/inboundEmailService.ts
git commit -m "refactor(api): extract insertEmailAuthoredComment for shared inbound-email comment semantics"
```

---

## Phase 2 — Auth

### Task 6: Reserve `/office-addin` namespace + route scaffold

**Files:**
- Modify: `packages/extension-sdk/src/manifest.ts` (`RESERVED_ROUTE_NAMESPACES`, ~line 42)
- Modify: `apps/api/src/index.ts` (import + `api.route('/office-addin', officeAddinRoutes)` next to the `/client-ai` mount at ~line 1087)
- Create: `apps/api/src/routes/officeAddin/index.ts`
- Test: `packages/extension-sdk/src/manifest.test.ts` (adjust any count/snapshot assertion)

**Interfaces:**
- Produces: `export const officeAddinRoutes: Hono` mounted at `/api/v1/office-addin`.

- [ ] **Step 1: Reserve the namespace**

Add `'office-addin'` to `RESERVED_ROUTE_NAMESPACES` in `packages/extension-sdk/src/manifest.ts`, alphabetically (after `'oauth'`-area entries, before `'onedrive'` — verify locally; `'client-ai'` at line ~35 is the precedent). Run `pnpm --filter @breeze/extension-sdk test` — if a count/snapshot assertion fails, update it in the same commit.

- [ ] **Step 2: Scaffold + mount**

```ts
// apps/api/src/routes/officeAddin/index.ts
import { Hono } from 'hono';
export const officeAddinRoutes = new Hono();
// Sub-routers are attached by later tasks:
//   auth.ts        → /auth/exchange, /auth/bind        (pre-auth, IP rate-limited)
//   bindingsAdmin.ts → /bindings*                      (web-session authMiddleware + partner admin + MFA)
//   emailContext.ts, tickets.ts, time.ts               (officeAddinTechAuthMiddleware)
```

In `apps/api/src/index.ts`: `import { officeAddinRoutes } from './routes/officeAddin';` and `api.route('/office-addin', officeAddinRoutes);` adjacent to the `/client-ai` mount.

- [ ] **Step 3: Typecheck + commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit; pnpm --filter @breeze/extension-sdk test
git add packages/extension-sdk/src/manifest.ts packages/extension-sdk/src/manifest.test.ts apps/api/src/index.ts apps/api/src/routes/officeAddin/index.ts
git commit -m "feat(api): reserve /office-addin namespace and mount route scaffold"
```

### Task 7: Extract the client exchange resolver (behavior-neutral)

**Files:**
- Create: `apps/api/src/services/clientAiExchange.ts`
- Modify: `apps/api/src/routes/clientAi/auth.ts`
- Test: existing clientAi auth tests (locate via `ls apps/api/src/routes/clientAi/*.test.ts`) stay green unchanged.

**Interfaces:**
- Produces (consumed by Task 10):

```ts
import type { ClientAiEntraClaims } from './clientAiEntraJwt';
export type ClientExchangeOutcome =
  | { kind: 'denied'; status: 403 | 404; body: { error: string; reason?: string }; audit: { orgId: string | null; result: string; actorEmail: string | null; details: Record<string, unknown> } }
  | { kind: 'resolved'; body: { accessToken: string; expiresInSeconds: number; user: { id: string; email: string; name: string | null }; org: { id: string }; branding: { displayName: string | null; logoUrl: string | null } }; audit: { orgId: string; result: 'success'; actorId: string; actorEmail: string; details: Record<string, unknown> } };
export async function resolveAndMintClientSession(claims: ClientAiEntraClaims, redis: Redis): Promise<ClientExchangeOutcome>;
```

- [ ] **Step 1: Extract**

Move the inline resolution closure from `routes/clientAi/auth.ts` (the `withSystemDbAccessContext(async (): Promise<Denied | Resolved> => …)` block: tenant-mapping join, `aiForOfficeEnabled` check, `getOrgPolicy`, portal-user JIT with 23505 handling, status check, `isClientUserPermitted`) **plus** the session-mint block (`nanoid(48)`, `SETEX clientai:session:*`, `SADD clientai:user-sessions:*`) into `resolveAndMintClientSession`. The route handler shrinks to: dark-gate + rate-limit + `verifyEntraIdToken` + call the service + `auditExchange` from the returned `audit` + `c.json(body, status)`. Byte-identical wire behavior — response shapes, status codes, audit `details` unchanged.

- [ ] **Step 2: Verify + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/clientAi/
git add apps/api/src/services/clientAiExchange.ts apps/api/src/routes/clientAi/auth.ts
git commit -m "refactor(api): extract client-AI exchange resolver for reuse by the neutral office-addin exchange"
```

### Task 8: Expose `scp` from the Entra verifier (additive)

**Files:**
- Modify: `apps/api/src/services/clientAiEntraJwt.ts`
- Test: `apps/api/src/services/clientAiEntraJwt.test.ts` (existing file — add cases)

**Interfaces:**
- Produces: `ClientAiEntraClaims` gains `scp: string | null` (raw space-delimited scope string, or null when absent). No new validation in the verifier itself — the client path must keep admitting today's tokens; the delegated-scope check lives in the tech exchange (Task 10).

- [ ] **Step 1: Add failing test**

In the existing verifier test file, add: a token with `scp: 'access_as_user profile'` → claims.scp equals that string; a token without `scp` → `claims.scp === null`. Run → FAIL (property missing).

- [ ] **Step 2: Implement, run, commit**

Add `scp: typeof payload.scp === 'string' ? payload.scp : null` to the returned claims object and the interface. Run the verifier suite → PASS.

```bash
git add apps/api/src/services/clientAiEntraJwt.ts apps/api/src/services/clientAiEntraJwt.test.ts
git commit -m "feat(api): expose delegated scp claim from Entra token verification"
```

### Task 9: Tech session service (Redis)

**Files:**
- Create: `apps/api/src/services/officeAddin/techSession.ts`
- Test: `apps/api/src/services/officeAddin/techSession.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 10–13):

```ts
export const TECH_SESSION_SLIDING_TTL_SECONDS = 12 * 60 * 60;      // 12h sliding
export const TECH_SESSION_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7d absolute
export const TECH_SESSION_KEYS = {
  session: (token: string) => `techaddin:session:${token}`,
  userSessions: (userId: string) => `techaddin:user-sessions:${userId}`,
};
export interface TechSessionPayload { userId: string; partnerId: string; bindingId: string; createdAt: string }
export async function mintTechSession(redis: Redis, payload: Omit<TechSessionPayload, 'createdAt'>): Promise<{ token: string; expiresInSeconds: number }>;
export async function getTechSession(redis: Redis, token: string): Promise<TechSessionPayload | null>; // deletes+null past max lifetime; slides TTL otherwise
export async function revokeTechSessionsForUser(redis: Redis, userId: string): Promise<void>;
```

- [ ] **Step 1: Write failing tests** (use `ioredis-mock` or the repo's existing Redis test double — mirror whatever `clientAiAuth`'s tests use)

```ts
// techSession.test.ts — cases:
// mint stores JSON payload under techaddin:session:<48-char token> with TTL
//   TECH_SESSION_SLIDING_TTL_SECONDS and adds token to the user set
// getTechSession returns payload and re-EXPIREs the key (sliding)
// getTechSession returns null for unknown token
// getTechSession deletes the key and returns null when
//   Date.now() - createdAt > TECH_SESSION_MAX_LIFETIME_MS (absolute cap)
// revokeTechSessionsForUser deletes every token in the user set + the set
```

- [ ] **Step 2: Run (FAIL) → implement following the `clientai` pattern** (`nanoid(48)`, `SETEX`, `SADD`+`EXPIRE` on the user set at 2× TTL; on `getTechSession` parse JSON, enforce the absolute lifetime, then `EXPIRE` to slide) **→ run (PASS) → commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/officeAddin/techSession.test.ts
git add apps/api/src/services/officeAddin/techSession.ts apps/api/src/services/officeAddin/techSession.test.ts
git commit -m "feat(api): opaque Redis tech session for the office add-in (techaddin namespace)"
```

### Task 10: `POST /office-addin/auth/exchange`

**Files:**
- Create: `apps/api/src/routes/officeAddin/auth.ts`, `apps/api/src/routes/officeAddin/schemas.ts`
- Create: `apps/api/src/services/officeAddin/officeAddinBindings.ts`
- Modify: `apps/api/src/routes/officeAddin/index.ts` (attach)
- Test: `apps/api/src/routes/officeAddin/auth.test.ts`

**Interfaces:**
- Produces:
  - `officeAddinBindings.ts`: `findActiveBinding(entraTenantId: string, entraOid: string): Promise<BindingWithUser | null>` where `BindingWithUser = { binding: {id, userId, partnerId, boundAuthEpoch, mfaVerifiedAt}, user: {id, email, name, status, authEpoch, partnerId} }` (system-context join `office_addin_user_bindings ⋈ users`, `revoked_at IS NULL`); `hasAnyBinding(entraTenantId: string, entraOid: string): Promise<boolean>` (includes revoked rows — used to hard-deny instead of falling through to client JIT); `revokeBinding(bindingId: string, revokedBy: string | null): Promise<void>`.
  - Route responses: tech `{ persona:'tech', accessToken, expiresInSeconds, user:{id,email,name}, partner:{id} }`; client = Task 7 body + `persona:'client'`; deny `403 { error:'binding_denied', reason: 'user_inactive'|'membership_revoked'|'epoch_advanced' }`.

- [ ] **Step 1: Write failing route tests — the exchange matrix (spec §9)**

Model the harness on the existing clientAi auth route tests (mock `verifyEntraIdToken`, mock Redis, mock db). Cases:

```ts
// 1. no binding → resolveAndMintClientSession called; response = client body + persona:'client' (client path unchanged)
// 2. bound + eligible (user active, authEpoch matches) → persona:'tech', techaddin session minted, client resolver NOT called
// 3. bound + user.status !== 'active' → 403 binding_denied/user_inactive; client resolver NOT called (never JIT a former tech as client)
// 4. binding exists but revoked (revoked_at set, no active row) → 403 binding_denied/revoked_relink;
//    client resolver NOT called — a former technician's identity must never JIT-provision
//    as a client portal user (spec §2.1 step 4); the technician re-links instead
// 5. bound + user.authEpoch !== binding.boundAuthEpoch → 403 binding_denied/epoch_advanced AND revokeBinding called
// 6. token missing scp 'access_as_user' → 401 invalid_token (both personas — checked before binding lookup)
// 7. rate limit exceeded → 429
// 8. dual-mapped tenant (binding exists AND client tenant mapping exists) → binding wins → tech
```

Run → FAIL (module not found).

- [ ] **Step 2: Implement**

```ts
// apps/api/src/routes/officeAddin/schemas.ts
import { z } from 'zod';
export const exchangeSchema = z.object({ accessToken: z.string().min(1).max(8192) });
export const EXCHANGE_RATE_LIMIT = { limit: 20, windowSeconds: 300 }; // same posture as client exchange
```

```ts
// apps/api/src/routes/officeAddin/auth.ts (exchange handler outline)
officeAddinAuthRoutes.post('/auth/exchange', zValidator('json', exchangeSchema), async (c) => {
  // dark gate + redis + rate limit: copy the clientAi/auth.ts preamble verbatim
  //   (CLIENT_AI_ENTRA_CLIENT_ID gate, getRedis 503, rateLimiter with key
  //   `officeaddin-exchange-${rateLimitIpKey(ip)}`)
  const claims = await verifyEntraIdToken(body.accessToken, { audience: CLIENT_AI_ENTRA_CLIENT_ID });
  const scopes = (claims.scp ?? '').split(' ').filter(Boolean);
  if (!scopes.includes('access_as_user')) return c.json({ error: 'invalid_token' }, 401);

  const bound = await withSystemDbAccessContext(() => findActiveBinding(claims.tid, claims.oid));
  if (!bound && await withSystemDbAccessContext(() => hasAnyBinding(claims.tid, claims.oid)))
    return c.json({ error: 'binding_denied', reason: 'revoked_relink' }, 403); // never client-JIT a former tech
  if (bound) {
    if (bound.user.status !== 'active')
      return deny(c, 'user_inactive', bound);                    // hard deny — never fall through
    if (bound.user.authEpoch !== bound.binding.boundAuthEpoch) {
      await withSystemDbAccessContext(() => revokeBinding(bound.binding.id, null));
      return deny(c, 'epoch_advanced', bound);
    }
    if (bound.user.partnerId !== bound.binding.partnerId)
      return deny(c, 'membership_revoked', bound);
    const { token, expiresInSeconds } = await mintTechSession(redis, {
      userId: bound.user.id, partnerId: bound.binding.partnerId, bindingId: bound.binding.id,
    });
    // audit: writeAuditEvent action 'office_addin.auth.exchange', result 'success', principalType 'user'
    return c.json({ persona: 'tech', accessToken: token, expiresInSeconds,
      user: { id: bound.user.id, email: bound.user.email, name: bound.user.name },
      partner: { id: bound.binding.partnerId } });
  }
  const outcome = await resolveAndMintClientSession(claims, redis); // Task 7 — unchanged client semantics
  // audit via the outcome.audit block exactly as clientAi/auth.ts does
  if (outcome.kind === 'denied') return c.json(outcome.body, outcome.status);
  return c.json({ persona: 'client', ...outcome.body });
});
```

`deny()` writes an audit event (`result: 'denied'`, reason in details) and returns `403 { error: 'binding_denied', reason }`. Attach in `routes/officeAddin/index.ts`.

- [ ] **Step 3: Run tests (PASS) + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/officeAddin/auth.test.ts src/routes/clientAi/
git add apps/api/src/routes/officeAddin apps/api/src/services/officeAddin/officeAddinBindings.ts
git commit -m "feat(api): neutral office-addin auth exchange with tech/client persona resolution"
```

### Task 11: Bind flow — `POST /office-addin/auth/bind`

**Files:**
- Modify: `apps/api/src/routes/officeAddin/auth.ts`, `schemas.ts`
- Modify: `apps/api/src/services/officeAddin/officeAddinBindings.ts` (add `createBinding`)
- Test: `apps/api/src/routes/officeAddin/auth.test.ts` (extend)

**Interfaces:**
- Produces: `createBinding(input: { entraTenantId, entraOid, userId, partnerId, boundAuthEpoch, mfaVerifiedAt: Date }): Promise<{ id: string }>` — inside a transaction: revoke the user's own existing active binding (re-link), then insert; a 23505 on the identity index means the `(tid, oid)` is bound to a *different* user → throw `BindingConflictError`.
- Route: `POST /auth/bind` body `{ accessToken, email, password, mfaCode }` → 200 `{ bound: true }`; the pane then calls `/auth/exchange`.

- [ ] **Step 1: Write failing tests**

```ts
// cases (extend auth.test.ts):
// valid entra token + valid credentials + valid TOTP → binding row created with
//   bound_auth_epoch = user.authEpoch, mfa_verified_at set → 200
// wrong password → 401 invalid_credentials (and no binding)
// ENABLE_2FA on + user has no MFA enrolled → 403 mfa_enrollment_required
// wrong TOTP → 401 invalid_mfa
// (tid,oid) already actively bound to a DIFFERENT user → 409 identity_already_bound
// same user re-binding (e.g. new Entra tenant) → old binding revoked, new created → 200
// user with partner_id null (org-only user) → 403 not_a_technician
// missing scp access_as_user → 401
// rate limit (10 / 15 min per IP) → 429
```

- [ ] **Step 2: Implement**

```ts
// bind handler outline (auth.ts)
export const bindSchema = z.object({
  accessToken: z.string().min(1).max(8192),
  email: z.string().email().max(255),
  password: z.string().min(1).max(1024),
  mfaCode: z.string().min(6).max(10),
});

officeAddinAuthRoutes.post('/auth/bind', zValidator('json', bindSchema), async (c) => {
  // rate limit: `officeaddin-bind-${rateLimitIpKey(ip)}`, limit 10 / 900s
  const claims = await verifyEntraIdToken(body.accessToken, { audience: CLIENT_AI_ENTRA_CLIENT_ID });
  // scp check as in exchange
  const result = await withSystemDbAccessContext(async () => {
    const user = /* select id,email,name,status,partnerId,passwordHash,mfaEnabled,mfaSecret,authEpoch from users where lower(email)=lower(body.email) */;
    if (!user || user.status !== 'active') return { deny: 401 as const, error: 'invalid_credentials' };
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, body.password)))
      return { deny: 401 as const, error: 'invalid_credentials' };       // services/password.ts
    if (!user.partnerId) return { deny: 403 as const, error: 'not_a_technician' };
    if (ENABLE_2FA) {
      if (!user.mfaEnabled || !user.mfaSecret) return { deny: 403 as const, error: 'mfa_enrollment_required' };
      const secret = decryptMfaSecretForMigration(user.mfaSecret).plaintext; // same helper as routes/auth/mfa.ts:288
      if (!secret || !(await consumeMFAToken(secret, body.mfaCode, user.id)))
        return { deny: 401 as const, error: 'invalid_mfa' };
    }
    const { id } = await createBinding({ entraTenantId: claims.tid, entraOid: claims.oid,
      userId: user.id, partnerId: user.partnerId, boundAuthEpoch: user.authEpoch, mfaVerifiedAt: new Date() });
    return { bindingId: id, userId: user.id, partnerId: user.partnerId };
  });
  // BindingConflictError → 409 { error: 'identity_already_bound' }
  // audit 'office_addin.binding.created' / denied variants; constant-time note:
  // run verifyPassword against the dummy hash on user-miss, mirroring login.ts:272
});
```

Email here is a **login credential** (paired with password + MFA), not an authorization identifier — the resulting authorization key is `(tid, oid)`. Add a code comment saying exactly that.

- [ ] **Step 3: Run (PASS) + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/officeAddin/
git add apps/api/src/routes/officeAddin apps/api/src/services/officeAddin/officeAddinBindings.ts
git commit -m "feat(api): MFA-established office-addin technician bind flow"
```

### Task 12: `officeAddinTechAuthMiddleware` + capability guard

**Files:**
- Create: `apps/api/src/middleware/officeAddinTechAuth.ts`
- Modify: `apps/api/src/middleware/auth.ts` (export `computeAccessibleOrgIds`)
- Test: `apps/api/src/middleware/officeAddinTechAuth.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 14–19):

```ts
export interface OfficeAddinTechAuth {
  userId: string; partnerId: string; bindingId: string; token: string;
  user: { email: string; name: string | null };
  accessibleOrgIds: string[] | null;           // null = partnerOrgAccess 'all'
  partnerOrgAccess: 'all' | 'selected' | 'none';
  permissions: UserPermissions;                 // from getUserPermissions
  canAccessOrg: (orgId: string) => boolean;    // from buildOrgAccessClosures
  canAccessSite: (siteId: string | null) => boolean;
}
export async function officeAddinTechAuthMiddleware(c: Context, next: Next): Promise<void | Response>;
export type AddinCapability = 'email-context' | 'ticket-create' | 'ticket-link' | 'time-read' | 'time-write';
export function requireAddinCapability(cap: AddinCapability): MiddlewareHandler;
// capability → RBAC intersection (narrows, never replaces):
//   email-context → PERMISSIONS.TICKETS_READ; ticket-create/ticket-link → TICKETS_WRITE
//   time-read → TIME_ENTRIES_READ; time-write → TIME_ENTRIES_WRITE
```

- [ ] **Step 1: Export `computeAccessibleOrgIds`** from `middleware/auth.ts` (pure visibility change, signature `(scope, partnerId, orgId, userId) => Promise<{orgIds: string[] | null; partnerOrgAccess: 'all'|'selected'|'none'|null}>`). Run `pnpm --filter @breeze/api exec tsc --noEmit`.

- [ ] **Step 2: Write failing middleware tests**

```ts
// officeAddinTechAuth.test.ts — cases:
// no/garbage bearer → 401
// valid session but binding revoked since mint → 401 + session deleted
// valid session but user deactivated mid-session → 401 (spec §9)
// user.authEpoch advanced since bind → 401 + binding revoked
// partner membership removed (partnerOrgAccess null) → 401
// happy path: c.get('officeAddinAuth') populated; withDbAccessContext opened
//   with scope 'partner', partnerId, accessibleOrgIds; TTL slid
// requireAddinCapability('ticket-create') 403s when live RBAC lacks tickets:write
// ipAllowlistGuard result is returned, not swallowed
```

- [ ] **Step 3: Implement**

Per request, in order: bearer token → `getTechSession` (slides TTL, enforces absolute lifetime) → `withSystemDbAccessContext`: reload binding by `payload.bindingId` (`revoked_at IS NULL`) + user row (status, authEpoch, mfaEpoch, partnerId) → deny paths per tests (on epoch mismatch also `revokeBinding` + `revokeTechSessionsForUser`) → `assertActiveTenantContext({ scope: 'partner', partnerId, orgId: null })` → `computeAccessibleOrgIds('partner', partnerId, null, userId)`; `partnerOrgAccess === null` → 401 → `buildOrgAccessClosures(orgIds)` → `getUserPermissions(userId, { partnerId })` + `siteAccessCheck(permissions.allowedSiteIds)` → set `officeAddinAuth` → delegate to `ipAllowlistGuard(c, wrapped)` where `wrapped` runs `withDbAccessContext(buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId, userId }), next)`. The token is never accepted by `authMiddleware` (different Redis namespace, not a JWT) — add a test-visible comment. `requireAddinCapability` reads `officeAddinAuth.permissions` and `hasPermission(...)` → 403 `{ error: 'forbidden' }`.

- [ ] **Step 4: Run (PASS) + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/middleware/officeAddinTechAuth.test.ts src/middleware/
git add apps/api/src/middleware/officeAddinTechAuth.ts apps/api/src/middleware/auth.ts apps/api/src/middleware/officeAddinTechAuth.test.ts
git commit -m "feat(api): office-addin tech auth middleware with live re-authorization per request"
```

### Task 13: Binding management — admin API + web UI

**Files:**
- Create: `apps/api/src/routes/officeAddin/bindingsAdmin.ts` (+ attach in `index.ts`)
- Create: `apps/web/src/components/settings/OfficeAddinBindingsPage.tsx`
- Create: web page route for it (copy the pattern of the neighboring partner-settings page — find via `grep -rl "PsaConnectionsPage" apps/web/src/pages`)
- Test: `apps/api/src/routes/officeAddin/bindingsAdmin.test.ts`

**Interfaces:**
- Produces: `GET /office-addin/bindings` → `{ bindings: Array<{ id, userId, userName, userEmail, entraTenantId, mfaVerifiedAt, createdAt }> }` (active only, partner-scoped); `DELETE /office-addin/bindings/:id` → `{ revoked: true }`.

- [ ] **Step 1: Failing route tests** — partner-global admin lists own partner's active bindings; selected-org technician (`partnerOrgAccess: 'selected'`) → 403; missing MFA claim → 403 `MFA_REQUIRED`; revoke sets `revoked_at`/`revoked_by` and calls `revokeTechSessionsForUser`; cross-partner id → 404 (RLS + app filter).

- [ ] **Step 2: Implement routes**

```ts
// bindingsAdmin.ts — these are WEB-session routes, not tech-token routes:
const adminChain = [authMiddleware, requireScope('partner', 'system'), requireMfa()] as const;
officeAddinBindingsAdminRoutes.get('/bindings', ...adminChain, async (c) => {
  const auth = c.get('auth');
  if (!canManagePartnerWidePolicies(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  // select active bindings ⋈ users for auth.partnerId (RLS partner axis + explicit eq(partnerId))
});
officeAddinBindingsAdminRoutes.delete('/bindings/:id', ...adminChain, async (c) => {
  // canManagePartnerWidePolicies gate; revokeBinding(id, auth.userId);
  // revokeTechSessionsForUser(redis, binding.userId); audit 'office_addin.binding.revoked'
});
```

(`authMiddleware` is idempotent — explicit per-route use is the established pattern for routers that also carry non-standard auth.)

- [ ] **Step 3: Web UI**

`OfficeAddinBindingsPage.tsx`: table of active bindings (user name/email, Entra tenant, bound date, MFA-verified date) + a Revoke button per row. Fetch list with `fetchWithAuth`; revoke via `runAction` (web mutation contract) with confirm dialog; refresh on success. Use `data-testid="office-addin-bindings-table"` / `data-testid="revoke-binding-<id>"`. Wire a page route + partner-settings navigation entry following the sibling settings page found in Step 1's grep.

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/officeAddin/bindingsAdmin.test.ts
pnpm --filter @breeze/web test
git add apps/api/src/routes/officeAddin apps/web/src
git commit -m "feat: office-addin binding management (partner admin + MFA) with web UI"
```

---

## Phase 3 — Ticketing endpoints

### Task 14: Add-in ticket queries in `ticketService`

**Files:**
- Modify: `apps/api/src/services/ticketService.ts`
- Test: `apps/api/src/services/ticketService.test.ts` (extend, following its existing Drizzle-mock pattern)

**Interfaces:**
- Produces (consumed by Task 15):

```ts
export interface AddinTicketSummary { id: string; internalNumber: string | null; subject: string; status: string; priority: string | null; updatedAt: Date; submitterEmail: string | null; matchesSubmitter: boolean }
export async function listOrgTicketsForAddin(input: { orgId: string; partnerId: string; submitterEmail?: string | null }): Promise<{ openTickets: AddinTicketSummary[]; recentTickets: AddinTicketSummary[] }>;
// openTickets: status IN ('new','open','pending','on_hold'), deleted_at IS NULL, order updated_at desc, limit 10
// recentTickets: any status, deleted_at IS NULL, order created_at desc, limit 10
// matchesSubmitter: lower(submitter_email) = lower(input.submitterEmail) — service-level query, NOT a public list filter
```

- [ ] **Step 1: Write failing tests** (statuses filtered, limits, `matchesSubmitter` flag, partner+org constrained in the WHERE — walk the bound params, don't token-scan; see `vacuous_drizzle_where_clause_assertions`).
- [ ] **Step 2: Implement, run, commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/ticketService.test.ts
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(api): listOrgTicketsForAddin service query (org + submitter email)"
```

### Task 15: `POST /office-addin/email-context`

**Files:**
- Create: `apps/api/src/services/officeAddin/emailContext.ts`
- Create: `apps/api/src/routes/officeAddin/emailContext.ts` (+ attach with `officeAddinTechAuthMiddleware` + `requireAddinCapability('email-context')`)
- Modify: `apps/api/src/routes/officeAddin/schemas.ts`
- Test: `apps/api/src/services/officeAddin/emailContext.test.ts`, `apps/api/src/routes/officeAddin/emailContext.test.ts`

**Interfaces:**
- Request schema (all POST — no message identifiers in URLs):

```ts
export const emailContextSchema = z.object({
  from: z.object({ email: z.string().email().max(320), name: z.string().max(255).nullish() }),
  sender: z.object({ email: z.string().email().max(320), name: z.string().max(255).nullish() }).nullish(), // provenance only
  internetMessageId: z.string().max(998).nullish(),
  references: z.array(z.string().max(998)).max(100).nullish(),
  inReplyTo: z.string().max(998).nullish(),
  subject: z.string().max(1000),
  conversationId: z.string().max(256).nullish(),
  itemGeneration: z.number().int(), // echoed back for stale-response rejection in the pane
});
```

- Response: `{ itemGeneration, org: {id, name} | null, contacts: ContactCandidate[], threadMatchedTicket: AddinTicketSummary | null, openTickets, recentTickets, orgSummary: {name, siteCount, deviceCount, openTicketCount} | null, inboundPathConfigured: boolean }` with `ContactCandidate = { kind: 'portal_user' | 'contact'; id: string; name: string | null; email: string; orgId: string; provenance: 'address_match' | 'domain_org'; }`.
- `buildEmailContext(input, tech: OfficeAddinTechAuth): Promise<EmailContextResult>`.

- [ ] **Step 1: Write failing service tests**

```ts
// emailContext.test.ts — cases:
// represented `from` drives resolution; `sender` ignored for matching (send-on-behalf)
// portal_users exact address match (partner-scoped join) wins over domain
// customer_email_domains exact-domain match resolves org; subdomain does NOT match
// freemail domain (gmail.com etc.) skips domain resolution — no org guess
// resolved org outside tech.accessibleOrgIds → org: null (app-layer narrowing;
//   partner-axis RLS is flat and does NOT enforce the selected-org grant)
// duplicate emails → multiple candidates returned, never auto-picked
// threadMatchedTicket via findTicketInPartner(In-Reply-To ∪ References ∪ subject token),
//   dropped when !tech.canAccessOrg(match.orgId)
// no identifiers + no subject token → threadMatchedTicket null
// inboundPathConfigured true when partner has a connected ticket mailbox OR
//   inbound (Mailgun) address configured; false otherwise (spec §8)
```

- [ ] **Step 2: Implement**

```ts
const FREEMAIL_DOMAINS = new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','icloud.com','me.com','aol.com','proton.me','protonmail.com','gmx.com','mail.com']);

export async function buildEmailContext(input: EmailContextInput, tech: OfficeAddinTechAuth) {
  const email = input.from.email.toLowerCase();
  const domain = email.split('@')[1];
  // 1. address-level portal_users match (partner-scoped join organizations),
  //    narrowed: rows where !tech.canAccessOrg(orgId) are dropped
  // 2. contacts table match by email within accessible orgs (provenance 'address_match')
  // 3. domain: if !FREEMAIL_DOMAINS.has(domain), customer_email_domains
  //    (partnerId, domain, is_active) — same chain as resolveOrgBySenderDomain;
  //    drop if !tech.canAccessOrg(orgId)
  // org = single address-match org, else domain org, else null (ambiguity across
  //   orgs → org null + candidates listed for the technician to pick)
  // 4. threadMatchedTicket = await findTicketInPartner({ inReplyTo, references,
  //    subject, messageId: internetMessageId }, tech.partnerId)  — Task 3/4 matcher
  //    (link-table aware); null when !tech.canAccessOrg(...)
  // 5. tickets: org ? await listOrgTicketsForAddin({orgId, partnerId, submitterEmail: email}) : empty
  // 6. orgSummary: name + counts via three cheap counts (sites, devices, open tickets)
  // 7. inboundPathConfigured: EXISTS ticket_mailbox_connections (status 'connected',
  //    partnerId) OR the partner inbound-address config the Mailgun path uses
  //    (reuse the same lookup resolvePartnerByRecipient depends on)
}
```

Route: `officeAddinTechRoutes.post('/email-context', requireAddinCapability('email-context'), zValidator('json', emailContextSchema), ...)` — handler runs inside the middleware's `withDbAccessContext` (partner scope). Route test: selected-org tech never sees other orgs' tickets/domains (matrix over `accessibleOrgIds`).

- [ ] **Step 3: Run (PASS) + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/officeAddin/emailContext.test.ts src/routes/officeAddin/
git add apps/api/src/services/officeAddin/emailContext.ts apps/api/src/routes/officeAddin
git commit -m "feat(api): office-addin email-context endpoint (org/contact/thread resolution)"
```

### Task 16: `POST /office-addin/tickets/from-email`

**Files:**
- Create: `apps/api/src/routes/officeAddin/tickets.ts` (+ attach)
- Create: `apps/api/src/services/officeAddin/addinContacts.ts` (confirmed contact creation)
- Modify: `apps/api/src/routes/officeAddin/schemas.ts`
- Test: `apps/api/src/routes/officeAddin/tickets.test.ts`, extend `ticketEmailLinksClaim.integration.test.ts`

**Interfaces:**
- Request:

```ts
export const fromEmailSchema = z.object({
  orgId: z.string().uuid(),
  subject: z.string().min(1).max(255),
  description: z.string().min(1).max(100_000),
  from: z.object({ email: z.string().email().max(320), name: z.string().max(255).nullish() }),
  internetMessageId: z.string().max(998).nullish(),
  requester: z.union([
    z.object({ kind: z.literal('portal_user'), id: z.string().uuid() }),
    z.object({ kind: z.literal('create_contact'), email: z.string().email().max(320), name: z.string().max(255).nullish() }), // deliberate, technician-confirmed
    z.object({ kind: z.literal('raw') }), // submitter_email/name only
  ]),
  followUpOf: z.object({ ticketId: z.string().uuid() }).nullish(), // closed-ticket continuation: carries thread key + prior number
});
```

- Response 201 `{ ticket: AddinTicketSummary, alreadyExisted: false }`; 200 `{ ticket, alreadyExisted: true }` (idempotent replay); 409 `{ error: 'message_linked_elsewhere', ticket: AddinTicketSummary }`.
- Produces: `createConfirmedContact(orgId: string, input: {email, name}): Promise<{ portalUserId: string }>` in `addinContacts.ts` — explicit insert into `portal_users` (`status 'active'`, `passwordHash null`), in-request (RLS-scoped), NOT `findOrCreateEmailContact` (which is a non-atomic ingest side-effect path).

- [ ] **Step 1: Write failing route tests**

```ts
// cases:
// creates ticket source='email' with submitter fields; stamps email_message_id
//   (customer's Message-ID) + email_thread_key (ticketThreadAnchor(id) when
//   inbound domain configured, else the message id — same precedence as
//   inboundEmailService.createFromEmail); writes ticket_email_links row
//   origin 'addin_create', visibility 'public', linked_by = tech user
// same internetMessageId again → 200 alreadyExisted with the original ticket, no duplicate
// message already linked to a DIFFERENT ticket → 409 with that ticket
// requester create_contact → portal_users row created + submittedBy set
// orgId outside accessibleOrgIds → 404
// followUpOf closed ticket → new ticket carries the closed ticket's
//   email_thread_key and description prefixed `Re: <internalNumber> (continued)`
// no internetMessageId (Mailbox < 1.8 host) → ticket created, no link row, response ok
```

- [ ] **Step 2: Implement**

Handler (capability `ticket-create`), running inside the request's RLS transaction:
1. `canAccessOrg(orgId)` else 404.
2. `messageId = internetMessageId ? normalizeMessageId(...) : null`. Fast path: existing link for it → same-org load ticket → 200/409 per `link.ticketId`.
3. Resolve requester → `submittedBy` (portal_user id, verified in-org) or `createConfirmedContact` or null.
4. `followUpOf`: load ticket (must be status 'closed', partner-scoped); carry `carryThreadKey = closed.emailThreadKey` + description prefix.
5. `createTicket({ source: 'email', orgId, subject, description, submittedBy, submitterEmail: from.email, submitterName: from.name ?? null }, actor)` — build `TicketActor` from tech auth.
6. Stamp threading: `UPDATE tickets SET email_message_id = messageId, email_thread_key = carryThreadKey ?? anchor` where `anchor = ticketThreadAnchor(ticket.id)` (from `services/inboundEmail/outboundThreading.ts`) when the inbound domain is configured, else `messageId`.
7. `claimMessageLink({ ..., origin: 'addin_create', visibility: 'public', linkedBy: userId })`; on `created: false` throw `MessageClaimRaceError` — the request transaction rolls back (ticket vanishes), route catches it, re-reads the winner's association via `runOutsideDbContext(() => withSystemDbAccessContext(...))`, and returns 200/409 accordingly. This is race-safe precisely because the whole handler runs in one `withDbAccessContext` transaction.
8. Audit `office_addin.ticket.created_from_email`.

- [ ] **Step 3: Extend the claim integration test** — add-in create vs. concurrent poller ingest of the same message produces exactly one ticket/one association (drive `processInboundEmail` and the route service concurrently as in CASE 5 of `inboundEmail.integration.test.ts`).

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/officeAddin/
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/ticketEmailLinksClaim.integration.test.ts
git add apps/api/src/routes/officeAddin apps/api/src/services/officeAddin/addinContacts.ts
git commit -m "feat(api): create ticket from email with idempotent message-id claim"
```

### Task 17: `POST /office-addin/tickets/:id/link-email`

**Files:**
- Modify: `apps/api/src/routes/officeAddin/tickets.ts`, `schemas.ts`
- Test: `apps/api/src/routes/officeAddin/tickets.test.ts` (extend)

**Interfaces:**
- Request:

```ts
export const linkEmailSchema = z.object({
  visibility: z.enum(['public', 'internal']),
  from: z.object({ email: z.string().email().max(320), name: z.string().max(255).nullish() }),
  internetMessageId: z.string().max(998).nullish(),
  subject: z.string().max(1000),
  bodyText: z.string().max(200_000), // quoted into the comment
});
```

- Responses: 201 `{ linked: true, commentId }`; 200 `{ linked: true, alreadyLinked: true, commentId }`; 409 `{ error: 'message_linked_elsewhere', ticket }` (different ticket) or 409 `{ error: 'ticket_closed', ticket: { id, internalNumber, emailThreadKey } }` (pane offers create-linked-follow-up via Task 16 `followUpOf`); 404 for deleted/inaccessible.

- [ ] **Step 1: Write failing tests**

```ts
// cases:
// public link → insertEmailAuthoredComment used (authorType 'email', isPublic
//   true, userId null, portalUserId = matched portal user when the from address
//   resolves in-org, authorName prefers the STORED portal-user name); event
//   payload has inbound:true (no SLA stamp, no requester echo); link row
//   origin 'addin_link' visibility 'public' with commentId
// internal link → addTicketComment(ticketId, {content: quoted, isPublic:false},
//   actor) — technician-authored internal note; link row visibility 'internal'
// public link must NOT call addTicketComment (assert firstResponseAt untouched)
// idempotent: same message → same ticket → 200 alreadyLinked (no second comment)
// same message → different ticket → 409 with current association
// closed ticket → 409 ticket_closed, NO comment inserted (no silent appends)
// soft-deleted ticket → 404
// ticket in inaccessible org → 404
// no internetMessageId (host < 1.8) → comment created, no ledger row, 201
```

- [ ] **Step 2: Implement** (capability `ticket-link`; same in-transaction claim pattern as Task 16: insert comment → `claimMessageLink` → on lost race throw, rollback, re-read, 200/409). Quote format for both visibilities: `From: ${name} <${email}>\nSubject: ${subject}\n\n${bodyText}` trimmed to the comment length cap. Audit `office_addin.ticket.email_linked`.

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/officeAddin/
git add apps/api/src/routes/officeAddin
git commit -m "feat(api): link email to ticket (public inbound-semantics / internal note) with ledger idempotency"
```

### Task 18: Time endpoints

**Files:**
- Create: `apps/api/src/routes/officeAddin/time.ts` (+ attach)
- Test: `apps/api/src/routes/officeAddin/time.test.ts`

**Interfaces:**
- `GET /office-addin/time/running` → `{ running: { id, ticketId, ticketInternalNumber, startedAt, description } | null }` (capability `time-read`)
- `POST /office-addin/time/start` body `{ ticketId, description? }` → 201 `{ entry }` (capability `time-write`) — `startTimer` auto-stops any existing running timer, so the response also includes `{ autoStopped: {...} | null }`; the pane warns before calling (Task 24).
- `POST /office-addin/time/stop` body `{ description?, isBillable? }` → 200 `{ entry }` | 404 `NO_RUNNING_TIMER`
- `POST /office-addin/time/log` body `{ ticketId, startedAt, endedAt, description, isBillable? }` → 201 `{ entry }` (org billable defaults applied by `createTimeEntry` when `isBillable` omitted)
- Actor construction: `{ userId, partnerId, manageAll: false, accessibleOrgIds }` from `officeAddinAuth` (mirror `timeActorFrom` in `routes/timeEntries/timeEntries.ts`). **No** bulk approval / timesheet / arbitrary update/delete routes.

- [ ] **Step 1: Failing tests** — running returns own timer only; start/stop/log delegate with the tech actor; `TimeEntryServiceError` maps status/code through; org-gate: ticket outside accessibleOrgIds → 404 (`TICKET_ORG_DENIED` from `resolveTicketLink`); no other timeEntry routes exist on this router.
- [ ] **Step 2: Implement thin handlers over `timeEntryService` (`getRunningTimer(userId)`, `startTimer`, `stopTimer`, `createTimeEntry`).**
- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/officeAddin/time.test.ts
git add apps/api/src/routes/officeAddin
git commit -m "feat(api): narrow office-addin time endpoints over timeEntryService"
```

### Task 19: AI email draft service + endpoint

**Files:**
- Create: `apps/api/src/services/officeAddin/aiEmailDraft.ts`
- Create: `apps/api/src/services/officeAddin/aiEmailDraft.test.ts`
- Modify: `apps/api/src/routes/officeAddin/tickets.ts` (add `POST /tickets/draft`)
- Test: extend `apps/api/src/routes/officeAddin/tickets.test.ts`

**Interfaces:**

```ts
export interface EmailDraftInput { subject: string; bodyText: string; threadContext?: string | null; model: string }
export interface EmailDraftResult { subject: string; summary: string; suggestedTimeMinutes: number; inputTokens: number; outputTokens: number }
export async function draftTicketFromEmail(input: EmailDraftInput): Promise<EmailDraftResult>;
```

- Route: `POST /office-addin/tickets/draft` body `{ orgId, subject, bodyText }` (capability `ticket-create`) → 200 `{ draft }`; 422 `{ error: 'dlp_blocked' }`; 503 `{ error: 'ai_unavailable' }` (no key / timeout / model error — the pane falls back deterministically and never blocks the create flow).

- [ ] **Step 1: Failing service tests** — mock `@anthropic-ai/sdk` like `aiTicketDraft.test.ts` does: valid JSON → parsed result; malformed JSON retried once then throws; zod-invalid output throws; `suggestedTimeMinutes` clamped to `[5, 480]`.
- [ ] **Step 2: Implement** modeled on `aiTicketDraft.ts` (direct `new Anthropic()`, `messages.create({ model, max_tokens: 1024, system: SYSTEM_PROMPT, ... })`, `lastTextBlock` + zod `llmSchema`, 2-attempt loop). SYSTEM_PROMPT: produce `{subject (≤120 chars, imperative problem statement), summary (3-6 sentence description for the ticket body), suggestedTimeMinutes (integer)}` from a customer email; never invent customer identity. **AI output is a prefill only — it must not contain or choose org/contact/thread fields.**
- [ ] **Step 3: Route** — resolve model via `resolveDefaultModel()` (`services/aiAgent.ts`); missing `ANTHROPIC_API_KEY` → 503 (matches the existing tech-AI posture — there is no separate partner AI flag on the `/api/v1/ai` draft path either); DLP before the model call: `getOrgPolicy(orgId)` → `applyDlp({ text: bodyText, dlpConfig: policy?.dlpConfig, orgId })` (`services/clientAiDlp.ts`); blocked → 422; redacted text is what goes to the model. Wrap the service call in a 20s timeout → 503. Route tests: DLP-blocked → 422 and Anthropic never called; timeout → 503; happy path returns draft.
- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/officeAddin/aiEmailDraft.test.ts src/routes/officeAddin/
git add apps/api/src/services/officeAddin/aiEmailDraft.ts apps/api/src/routes/officeAddin
git commit -m "feat(api): AI email ticket draft with DLP and deterministic-fallback contract"
```

---

## Phase 4 — Add-in frontend

### Task 20: office-addin-core — versioned session store + persona exchange + renderer injection

**Files:**
- Modify: `packages/office-addin-core/src/auth/session.ts`
- Modify: `packages/office-addin-core/src/components/App.tsx`
- Modify: `packages/office-addin-core/src/index.ts` (export new types)
- Test: `packages/office-addin-core/src/auth/session.test.ts`, `src/components/App.test.tsx` (extend)

**Interfaces:**
- Produces (consumed by Tasks 21–25):

```ts
// session.ts
export type PersonaSession =
  | { v: 2; persona: 'client'; sessionToken: string; expiresAt: number; user: ExchangeUser; org: ExchangeOrg | null; branding: ExchangeBranding | null }
  | { v: 2; persona: 'tech'; sessionToken: string; expiresAt: number; user: ExchangeUser; partner: { id: string } };
export interface SignInOptions { interactive: boolean; exchangePath?: string } // default '/client-ai/auth/exchange'
export function signIn(options: SignInOptions, deps?: SignInDeps): Promise<PersonaSession>;
export function getStoredSession(): PersonaSession | null;   // returns null for any non-v2 shape
export function getSessionToken(): string | null;            // unchanged consumers (apiFetch)
// App.tsx
export interface AppProps { host: HostAdapter; clientHost: ClientHost; exchangePath?: string; techPane?: React.ComponentType<{ session: Extract<PersonaSession, {persona:'tech'}> }> }
```

- [ ] **Step 1: Failing tests**

```ts
// session.test.ts additions:
// new storage key 'breeze-office-addin-session-v2'; a stale unversioned
//   'breeze-client-ai-session' value is ignored AND removed (can never bypass
//   persona resolution)
// getStoredSession returns null for {v:1,...} or unversioned JSON
// signIn posts to the given exchangePath; default stays '/client-ai/auth/exchange'
// exchange response without `persona` (old server) → treated as persona 'client'
// tech response stored with persona 'tech' + partner
// App.test.tsx additions:
// persona 'tech' + techPane prop → techPane rendered, ChatPane absent
// persona 'tech' + NO techPane (word/excel/ppt) → BlockedScreen (defensive; those
//   hosts never hit the neutral endpoint, but a tech session must not fall into chat)
// persona 'client' → ChatPane exactly as before
```

- [ ] **Step 2: Implement** — `STORAGE_KEY = 'breeze-office-addin-session-v2'`; on module read, `sessionStorage.removeItem('breeze-client-ai-session')`; `signIn/reExchange` accept `exchangePath` (thread through `SignInDeps`, keep single-flight `reExchange` remembering the path); map exchange responses: `persona === 'tech'` → tech shape, else client shape (missing persona ⇒ client, for the untouched `/client-ai` servers). `App` picks renderer by `session.persona`. Run core suite: `pnpm --filter @breeze/office-addin-core test` → PASS (existing client tests updated only where they assert the storage key).

- [ ] **Step 3: Commit**

```bash
git add packages/office-addin-core/src
git commit -m "feat(office-addin-core): versioned persona session store and injected tech renderer"
```

### Task 21: Outlook host layer — email identity, capability detection, ItemChanged generation

**Files:**
- Create: `apps/outlook-addin/src/tech/emailIdentity.ts`, `apps/outlook-addin/src/tech/itemGeneration.ts`
- Modify: `apps/outlook-addin/src/host/outlookSelection.ts` (fix the no-op unsubscribe)
- Test: `apps/outlook-addin/src/tech/emailIdentity.test.ts`, `src/tech/itemGeneration.test.ts` (use `installOfficeMock` / `switchItem` from `src/__tests__/officeMock.ts`)

**Interfaces:**

```ts
// emailIdentity.ts
export interface EmailIdentity {
  mode: 'read' | 'compose' | 'none';
  subject: string;
  from: { email: string; name: string | null } | null;       // represented from — drives resolution
  sender: { email: string; name: string | null } | null;      // provenance only (send-on-behalf)
  conversationId: string | null;
  internetMessageId: string | null;                           // null below Mailbox 1.8
  references: string[]; inReplyTo: string | null;             // [] / null below 1.8
  headerCapable: boolean;                                     // Mailbox 1.8+
  sharedMailbox: boolean;                                     // detected, v1 = messaged & disabled
}
export function hasMailbox18(): boolean; // Office.context.requirements.isSetSupported('Mailbox','1.8')
export async function readEmailIdentity(): Promise<EmailIdentity>;
export function parseReferences(headerValue: string): string[]; // unfolds CRLF+WSP, extracts every <...>
// itemGeneration.ts
export interface ItemGenerationStore {
  current(): number;
  subscribe(onChange: (generation: number) => void): () => void; // bumps on ItemChanged; real unsubscribe
}
export function createItemGenerationStore(): ItemGenerationStore;
```

- [ ] **Step 1: Failing tests**

```ts
// emailIdentity:
// read mode with 1.8 mock → internetMessageId + references parsed from
//   getAllInternetHeadersAsync raw block (folded multi-line References handled)
// isSetSupported false for 1.8 → headerCapable false, identifiers null/[],
//   subject+from still populated (degrade path)
// compose-mode item (setAsync present, no displayReplyForm) → mode 'compose'
// null item (pinned pane transition) → mode 'none', no throw
// send-on-behalf: item.from ≠ item.sender → both surfaced distinctly
// parseReferences('<a@x>\r\n <b@x>') → ['<a@x>', '<b@x>']
// itemGeneration:
// switchItem() → generation bumps, subscriber called
// unsubscribe → no further callbacks (fixes the no-op unsubscribe: keep a
//   module-level handler registry; the Office handler stays attached but
//   dispatches only to live subscribers)
```

Extend `officeMock.ts` as needed: `internetMessageId` property, `getAllInternetHeadersAsync`, per-set `isSetSupported` control.

- [ ] **Step 2: Implement** (duck-type compose exactly like `draftReply.ts`: `typeof item.body?.setAsync === 'function'`; shared mailbox detection via `item.getSharedPropertiesAsync` presence — flag only). Run `pnpm --filter @breeze/outlook-addin test` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/outlook-addin/src/tech apps/outlook-addin/src/host/outlookSelection.ts apps/outlook-addin/src/__tests__/officeMock.ts
git commit -m "feat(outlook-addin): email identity reader with 1.8 capability detection and item-generation store"
```

### Task 22: Tech API client + TechPane shell (context card + ticket lists)

**Files:**
- Create: `apps/outlook-addin/src/tech/api.ts`, `TechPane.tsx`, `ContextCard.tsx`, `TicketList.tsx`
- Modify: `apps/outlook-addin/src/main.tsx` (`<App host={outlookHostAdapter} clientHost="outlook" exchangePath="/office-addin/auth/exchange" techPane={TechPane} />`)
- Test: `apps/outlook-addin/src/tech/api.test.ts`, `TechPane.test.tsx`, `ContextCard.test.tsx`

**Interfaces:**

```ts
// api.ts — typed wrappers over core apiFetch (Bearer from the shared session store)
export async function fetchEmailContext(body: EmailContextRequest): Promise<EmailContextResponse>;
export async function createTicketFromEmail(body: FromEmailRequest): Promise<FromEmailResponse>;   // Task 23
export async function linkEmail(ticketId: string, body: LinkEmailRequest): Promise<LinkEmailResponse>; // Task 23
export async function fetchDraft(body: DraftRequest): Promise<DraftResponse>;                       // Task 23
export async function fetchRunningTimer(): Promise<RunningTimerResponse>;                           // Task 24
export async function startTimer(body): Promise<...>; export async function stopTimer(body): ...; export async function logTime(body): ...; // Task 24
export async function bindTechnician(body: { accessToken, email, password, mfaCode }): Promise<{ bound: boolean }>; // Task 25
// request/response types mirror Tasks 15–19 schemas exactly
```

- `TechPane` state machine: on mount + on item-generation change → `readEmailIdentity()`; `mode==='compose'` → explanatory disabled state; `mode==='none'` → empty state; else `fetchEmailContext({...identity, itemGeneration})` with an `AbortController` cancelled on generation bump, and responses whose `itemGeneration !== store.current()` discarded. Renders `ContextCard`, `TicketList`, actions (Task 23), `TimeWidget` (Task 24).
- `ContextCard`: resolved org, or a "No match" state with a manual org search (typeahead over `searchOrgs(query)` — see the endpoint added below). Contact candidate picker when ambiguous (`data-testid="contact-candidate"`), never auto-picked. Header-degrade notice when `headerCapable === false` ("Thread matching limited on this Outlook version — matched by subject/sender"), inbound-path honesty banner when `inboundPathConfigured === false` ("Replies to this thread won't auto-attach — this partner has no connected inbound mailbox; re-link manually").
- Manual org search backend: add `POST /office-addin/orgs/search` body `{ query: z.string().min(1).max(200) }` → `{ orgs: Array<{ id, name }> }` to `apps/api/src/routes/officeAddin/emailContext.ts` (capability `email-context`) — `ilike` on org name, constrained to `accessibleOrgIds`, limit 20. Add a route test (selected-org tech only sees granted orgs) and an `api.ts` wrapper `searchOrgs(query: string): Promise<{orgs: Array<{id: string; name: string}>}>`. The chosen org feeds the create form's org field (Task 23).
- `TicketList`: `threadMatchedTicket` pinned on top ("Matched to this thread"), then open tickets, then recent; row selection drives Task 23 actions (`data-testid="ticket-row-<id>"`).

- [ ] **Step 1: Failing tests** — api.ts wrappers hit the right paths with JSON bodies (fake fetch); TechPane: compose → disabled message; rapid `switchItem()` twice → only the latest generation's response rendered, earlier aborted; ContextCard shows candidates + never auto-picks; both banners render on their flags.
- [ ] **Step 2: Implement (RTL + `data-testid`, banner/inline-error pattern per core's `chat-banner` convention — errors surface in a dismissible banner element `data-testid="tech-banner"`; every mutation failure sets it — no silent mutations).**
- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @breeze/outlook-addin test
git add apps/outlook-addin/src
git commit -m "feat(outlook-addin): tech pane shell with email context card and ticket lists"
```

### Task 23: Create / link actions + AI prefill + follow-up flow

**Files:**
- Create: `apps/outlook-addin/src/tech/CreateTicketForm.tsx`, `LinkEmailAction.tsx`
- Modify: `apps/outlook-addin/src/tech/TechPane.tsx`, `api.ts`
- Test: `CreateTicketForm.test.tsx`, `LinkEmailAction.test.tsx`

**Interfaces:**
- `LinkEmailAction` props: `{ ticket: AddinTicketSummary; identity: EmailIdentity; onDone(result): void }` — visibility toggle (public comment / internal note), calls `linkEmail`; on 409 `ticket_closed` → offers "Create linked follow-up" (invokes `createTicketFromEmail` with `followUpOf`); on 409 `message_linked_elsewhere` → offers "Open ticket <internalNumber>".
- `CreateTicketForm` props: `{ context: EmailContextResponse; identity: EmailIdentity; onDone(result): void }` — org (prefilled from context, editable), requester picker (candidates / "create contact" confirm checkbox / raw), subject+description prefilled: fire `fetchDraft({orgId, subject, bodyText})` on open (DLP is applied server-side before the model call, Task 19); until it resolves (or on 4xx/5xx/timeout) use the deterministic fallback `subject = email subject`, `description = trimmed body quote (first 2000 chars)` — the form is editable immediately and never blocks on AI; a small "AI draft" badge swaps values in only if the technician hasn't edited the field yet.

- [ ] **Step 1: Failing tests** — fallback prefill appears immediately; AI result does not clobber technician edits; create posts the exact `fromEmailSchema` shape incl. `internetMessageId` and requester union; `create_contact` requires the explicit confirm checkbox; closed-409 shows follow-up CTA which posts `followUpOf`; linked-elsewhere-409 shows the other ticket; success/failure surfaces in `tech-banner`.
- [ ] **Step 2: Implement, run `pnpm --filter @breeze/outlook-addin test` → PASS.**
- [ ] **Step 3: Commit**

```bash
git add apps/outlook-addin/src/tech
git commit -m "feat(outlook-addin): link/create ticket actions with AI prefill and follow-up flow"
```

### Task 24: Time widget

**Files:**
- Create: `apps/outlook-addin/src/tech/TimeWidget.tsx`
- Modify: `apps/outlook-addin/src/tech/TechPane.tsx`
- Test: `TimeWidget.test.tsx`

**Interfaces:**
- Props: `{ linkedTicket: AddinTicketSummary | null }`. Always shows the global running timer (poll `fetchRunningTimer` every 30s + on mount). Start on the linked ticket: if a timer is already running on another ticket, warn first ("Starts here and stops the timer on <internalNumber>") because `startTimer` auto-stops. Stop button; manual log form (start/end datetime or duration minutes, description, billable checkbox defaulting from server response). Suggested duration from the last AI draft (`suggestedTimeMinutes`) prefills the manual form when present.

- [ ] **Step 1: Failing tests** — running timer rendered from fetch; start-with-existing-timer shows the warning and only proceeds on confirm; stop calls the endpoint and clears; manual log posts `{ticketId, startedAt, endedAt, description, isBillable}`; errors hit `tech-banner`.
- [ ] **Step 2: Implement + run → PASS.**
- [ ] **Step 3: Commit**

```bash
git add apps/outlook-addin/src/tech
git commit -m "feat(outlook-addin): time widget (global timer, start/stop, manual log)"
```

### Task 25: Bind flow UI + edge states

**Files:**
- Create: `apps/outlook-addin/src/tech/BindFlow.tsx`
- Modify: `packages/office-addin-core/src/components/App.tsx` (blocked-state hook for `binding_denied` / bind entry point), `apps/outlook-addin/src/main.tsx`
- Test: `BindFlow.test.tsx`, extend `App.test.tsx`

**Interfaces:**
- `BindFlow` props: `{ onBound(): void }`. Flow: acquire Entra token via core `getEntraTokenSilent`/`getEntraTokenInteractive` → form (Breeze email, password, MFA code) → `bindTechnician` → `onBound()` triggers a fresh `signIn({interactive:false, exchangePath:'/office-addin/auth/exchange'})`.
- Entry points: (a) client-resolution 404 `tenant_not_provisioned` in Outlook shows "I'm a technician" alongside the existing block screen; (b) a persistent low-key "Technician sign-in" link on the Outlook sign-in screen. Wire via a new optional `App` prop `signInExtra?: React.ReactNode` supplied only by Outlook.
- `binding_denied` responses from exchange render a blocked screen with the reason ("Access revoked — contact your administrator" / "Re-link required after password reset" for `epoch_advanced`, which shows a "Re-link" button opening `BindFlow`).

- [ ] **Step 1: Failing tests** — bind form validation; invalid_mfa error surfaced inline; success calls `onBound`; `epoch_advanced` block screen offers re-link; word/excel/ppt hosts (no `signInExtra`) unchanged.
- [ ] **Step 2: Implement + run both packages' suites → PASS.**
- [ ] **Step 3: Full verification + commit**

```bash
pnpm --filter @breeze/office-addin-core test && pnpm --filter @breeze/office-addin-core typecheck
pnpm --filter @breeze/outlook-addin test && pnpm --filter @breeze/outlook-addin exec tsc --noEmit
pnpm --filter @breeze/api test && pnpm --filter @breeze/api exec tsc --noEmit
git add apps/outlook-addin/src packages/office-addin-core/src
git commit -m "feat(outlook-addin): technician bind flow and blocked/edge states"
```

---

## Final verification (before PR)

- [ ] `pnpm test` (workspace) green.
- [ ] Real-DB suites: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts` and the RLS config — required because Tasks 1–4 touch tenancy/cascade (local green ≠ CI green; these do NOT run under `pnpm test`).
- [ ] Forge as `breeze_app` manually: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` — cross-tenant insert into both new tables must fail with `new row violates row-level security policy`.
- [ ] `pnpm db:check-drift` clean.
- [ ] Grep sweep: `grep -rn "clientai:session" apps/api/src/routes/officeAddin apps/api/src/middleware/officeAddinTechAuth.ts` → no hits (tech token accepted nowhere else); `grep -rn "findOrCreateEmailContact" apps/api/src/routes/officeAddin apps/api/src/services/officeAddin` → no hits.
- [ ] If the PR is stacked on a sibling branch: dispatch CI per branch (`gh workflow run CI --ref <branch>`) — stacked PRs run no CI.

## Explicitly deferred (v2 — recorded, not planned)

Historical mailbox backfill (review-queue conversion over `ticket_email_links` `origin='backfill'`), AI reply drafting, shared mailboxes (Mailbox 1.13 + `SupportsSharedFolders`), per-partner ribbon branding (needs per-partner manifests/add-in IDs), personal-mailbox ingestion.
