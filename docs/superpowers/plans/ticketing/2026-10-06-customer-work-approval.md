# Customer Work Approval (#4617) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ticket work that crosses a ticket budget, or uses an after-hours work type, is recorded but held from billing until a designated customer approver consents in the portal, or staff record that consent on the customer's behalf.

**Architecture:**
- A gate, `evaluateApprovalGate`, runs inside the four `timeEntryService.ts` writers under the existing `organizations SHARE → tickets FOR UPDATE` barrier.
- Held entries carry the new `billing_status = 'awaiting_approval'` and link to one `ticket_approval_requests` row. Every invoice gatherer selects only `not_billed`, so held time cannot be invoiced.
- Policy is one dual-axis settings table resolved by `resolveTicketApprovalSettings`.
- Decisions come from the portal (a frozen approver list) or from staff on behalf (method plus reference). Both are bound to the request `revision` the decider saw.

**Tech Stack:** Hono, Drizzle and Postgres (RLS), BullMQ (`ticketSlaWorker`, `ticketNotifyWorker`), Astro and React islands (`apps/web`, `apps/portal`), Vitest.

**Spec:** `docs/superpowers/specs/ticketing/2026-10-06-customer-work-approval-design.md`. Read it first. The spec wins on intent; this plan wins on file-level mechanics.

**Tracking:** feature registration is done by the orchestrator after approval. Do not register.

## Wave table

| Wave | Scope | Depends on | Migrations | Blast radius | Model tier |
|---|---|---|---|---|---|
| **W01** schema + policy | enum value, 2 new tables, ticket/time-entry/work-type columns, permission, every registration list, Drizzle, resolver, settings API | — | 4 (`2026-12-14-100000…100300`) | **High**: tenancy, RLS, cascade, org move | Opus implements; Sonnet review + contract suites |
| **W02** gate + decisions engine | `evaluateApprovalGate`, lock-order changes in the 4 writers, request lifecycle service (create, join, approve, deny, cancel, re-ask, write-off, expire), `billing_status` reader audit, expiry sweep | W01 | none | **High**: billing, concurrency | Opus implements + Opus review |
| **W03** staff API + web UI | ticket budget field, approvals panel, on-behalf dialog, held chips, settings card + org override, work-type flag, timesheet labels | W02 | none | Medium | Sonnet implements; Sonnet review |
| **W04** portal + notifications | portal approvals routes and page, ticket banner, `ticket.approval_*` events, approver/notify emails, staff in-app notification | W02 (W03 optional) | none | **High**: customer-facing money decision | Opus implements; Sonnet review |
| **W05** clients + docs | AI tool result text, Office add-in and mobile labels and `409 APPROVAL_REQUIRED` handling, `apps/docs` page | W02 | none | Low | Sonnet |

Each wave is one PR. W03, W04 and W05 can run in parallel after W02 merges. Feature
behaviour is dark until a partner sets `enabled = true` (spec §8), so no wave needs a
flag.

## Global Constraints

- Migrations sort after the newest committed file. At plan time that is `2026-12-13-110200-org-erasure-fk-child-actions.sql`. Before W01, run `ls apps/api/migrations | grep -E '^20' | sort | tail -1` and, if it has moved, re-date the four W01 files to sort after it. Never use the closed `2026-08-06` block.
- Every migration writes `SELECT set_config('breeze.scope','system',true);` before its first write (`migrationRlsScope.test.ts`). It is idempotent. It has no inner `BEGIN`/`COMMIT`.
- `ALTER TYPE billing_status ADD VALUE` lives alone in its own file. No other file may reference `'awaiting_approval'` in the same transaction.
- Composite FKs that reference an `org_id` column are `DEFERRABLE INITIALLY IMMEDIATE`.
- Tests run in the foreground: `cd apps/api && npx vitest run <files>`. Never use `pnpm … test -- --run`. Integration suites: `pnpm test-stack up`, then the integration config, then `pnpm test-stack down`.
- RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
- Web mutations use `runAction`. New i18n keys go in every locale file.
- PR bodies and commit messages are neutral in wording.
- No AI tool may decide, record on behalf, write off or set a budget (spec §6.5).

## Review Focus

These are the five input classes most likely to bite, each pinned by a named test:

1. **Two technicians stop timers on the same near-budget ticket at once.** Expected: exactly one entry is `not_billed` and one is held. Never two `not_billed` that together exceed the ceiling. Pinned by W02 Task 4 `gate.concurrency.integration.test.ts`.
2. **A customer approves a stale page after a new held entry bumped the revision.** Expected: `409 REQUEST_CHANGED`, nothing released. Pinned by W02 Task 5 and W04 Task 1.
3. **Mobile replays an offline-queued completed entry in hard mode.** Expected: recorded and held, never `409`. Pinned by W02 Task 3, `hard mode never refuses a completed entry`.
4. **A ticket with held time moves to an org in another currency.** Expected: the move is refused like any other unbilled time. Pinned by W02 Task 6 `ticketMoveCurrencyGuard` test.
5. **A billing contact who does not own the ticket opens the portal.** Expected: they see the request in Approvals, can decide it, and cannot read the ticket thread. A requester-only contact sees the request but gets no actions. Pinned by W04 Task 1.

---

# W01: schema, registrations, policy resolver

Branch: `feature/4617-customer-work-approval/wave-<sub#>`. Base: fresh `origin/main`.

### Task 1: Enum value migration

**Files:**
- Create: `apps/api/migrations/2026-12-14-100000-billing-status-awaiting-approval.sql`
- Modify: `apps/api/src/db/schema/timeTracking.ts:13`
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing; must stay green)

**Interfaces:** Produces the `BillingStatus` union, which now includes `'awaiting_approval'`.

- [ ] **Step 1: Write the migration**

```sql
-- #4617: hold state for time entries awaiting customer approval.
-- ALTER TYPE ... ADD VALUE cannot be USED in the transaction that adds it,
-- and autoMigrate wraps each file in one, so this file adds the value only.
-- See 2026-10-05-100000-contract-line-type-per-device-role.sql:3-8.
SELECT set_config('breeze.scope', 'system', true);
ALTER TYPE billing_status ADD VALUE IF NOT EXISTS 'awaiting_approval';
```

- [ ] **Step 2: Widen the Drizzle enum**

```ts
export const billingStatusEnum = pgEnum('billing_status', ['not_billed', 'billed', 'no_charge', 'contract', 'awaiting_approval']);
```

- [ ] **Step 3: Typecheck and record every compile error.** Run
  `cd apps/api && npx tsc --noEmit -p . 2>&1 | tee /tmp/tsc-4617.txt; echo exit=$?`.
  Check the exit code, because a heap OOM piped to `tail` reads as green. Use
  `NODE_OPTIONS=--max-old-space-size=12288` if needed. Every error here is a
  `billing_status` reader. Copy the list into the PR description; W02 Task 6 consumes it.
  Do not fix the readers in W01. If a compile error blocks the build, widen the local
  type with an explicit `awaiting_approval` arm that **throws**
  `new Error('awaiting_approval not handled (W02)')`. Never silently map it to another
  status.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-12-14-100000-billing-status-awaiting-approval.sql apps/api/src/db/schema/timeTracking.ts
git commit -m "feat(tickets): add awaiting_approval billing status value (#4617)"
```

### Task 2: `ticket_approval_settings` table, resolver, settings API

**Files:**
- Create: `apps/api/migrations/2026-12-14-100100-ticket-approval-settings.sql`
- Create: `apps/api/src/db/schema/ticketApproval.ts` (export it from `apps/api/src/db/schema/index.ts`)
- Create: `apps/api/src/services/ticketApproval/settings.ts`
- Create: `apps/api/src/services/ticketApproval/settings.test.ts`
- Create: `packages/shared/src/validators/ticketApproval.ts` (export from the validators index)
- Create: `apps/api/src/routes/tickets/approvalSettings.ts` (mount next to the other ticketing settings routes)
- Create: `apps/api/src/__tests__/integration/ticketApprovalSettingsPartnerRls.integration.test.ts`

**Interfaces:**
- Produces `resolveTicketApprovalSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveTicketApprovalSettings>`
- Produces `EffectiveTicketApprovalSettings = { enabled: Effective<boolean>; budgetTrigger: Effective<boolean>; afterHoursTrigger: Effective<boolean>; enforcement: Effective<'soft'|'hard'>; requestTtlHours: Effective<number> }`
- Produces `TICKET_APPROVAL_SETTINGS_DEFAULTS = { enabled: false, budgetTrigger: true, afterHoursTrigger: true, enforcement: 'soft', requestTtlHours: 72 }`
- Produces `GET/PATCH /api/v1/ticketing/approval-settings` (partner row) and `GET/PATCH /api/v1/orgs/:orgId/ticketing/approval-settings` (org override, where `null` clears a field)

- [ ] **Step 1: Write the failing resolver test**

```ts
// apps/api/src/services/ticketApproval/settings.test.ts
import { describe, it, expect } from 'vitest';
import { pickEffectiveTicketApprovalSettings, TICKET_APPROVAL_SETTINGS_DEFAULTS } from './settings';

describe('pickEffectiveTicketApprovalSettings', () => {
  const blank = { enabled: null, budgetTrigger: null, afterHoursTrigger: null, enforcement: null, requestTtlHours: null };
  it('falls back to defaults with no rows', () => {
    const r = pickEffectiveTicketApprovalSettings(undefined, undefined);
    expect(r.enabled).toEqual({ value: false, source: 'default' });
    expect(r.enforcement).toEqual({ value: 'soft', source: 'default' });
    expect(r.requestTtlHours.value).toBe(TICKET_APPROVAL_SETTINGS_DEFAULTS.requestTtlHours);
  });
  it('org overrides partner per field; null inherits', () => {
    const partner = { ...blank, enabled: true, enforcement: 'hard' as const, requestTtlHours: 24 };
    const org = { ...blank, enforcement: 'soft' as const };
    const r = pickEffectiveTicketApprovalSettings(org, partner);
    expect(r.enabled).toEqual({ value: true, source: 'partner' });
    expect(r.enforcement).toEqual({ value: 'soft', source: 'org' });
    expect(r.requestTtlHours).toEqual({ value: 24, source: 'partner' });
  });
  it('org false beats partner true (false is a value, not inherit)', () => {
    const r = pickEffectiveTicketApprovalSettings({ ...blank, enabled: false }, { ...blank, enabled: true });
    expect(r.enabled).toEqual({ value: false, source: 'org' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `cd apps/api && npx vitest run src/services/ticketApproval/settings.test.ts`.
  Expected: FAIL, `Cannot find module './settings'`.

- [ ] **Step 3: Write the migration**

```sql
-- #4617 spec §4.1. Dual-axis config (org XOR partner); NULL column = inherit.
-- Template: 2026-12-03-110100-billing-payment-settings.sql.
SELECT set_config('breeze.scope','system',true);
CREATE TABLE IF NOT EXISTS ticket_approval_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id),
  partner_id uuid REFERENCES partners(id),
  enabled boolean,
  budget_trigger boolean,
  after_hours_trigger boolean,
  enforcement text CHECK (enforcement IN ('soft','hard')),
  request_ttl_hours integer CHECK (request_ttl_hours BETWEEN 1 AND 720),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_approval_settings_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_approval_settings_partner_uq ON ticket_approval_settings(partner_id) WHERE partner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ticket_approval_settings_org_uq ON ticket_approval_settings(org_id) WHERE org_id IS NOT NULL;
ALTER TABLE ticket_approval_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_approval_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_approval_settings_tenant ON ticket_approval_settings;
CREATE POLICY ticket_approval_settings_tenant ON ticket_approval_settings FOR ALL
  USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id))
  WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id) OR public.breeze_has_partner_access(partner_id));
DROP POLICY IF EXISTS ticket_approval_settings_partner_default_select ON ticket_approval_settings;
CREATE POLICY ticket_approval_settings_partner_default_select ON ticket_approval_settings FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON ticket_approval_settings TO breeze_app;
```

- [ ] **Step 4: Write the Drizzle table and the resolver**

```ts
// apps/api/src/db/schema/ticketApproval.ts (settings part)
import { pgTable, uuid, boolean, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { organizations, partners } from './orgs';
/** #4617 spec §4.1 — dual-axis (org XOR partner); CHECK + RLS in SQL. */
export const ticketApprovalSettings = pgTable('ticket_approval_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  enabled: boolean('enabled'),
  budgetTrigger: boolean('budget_trigger'),
  afterHoursTrigger: boolean('after_hours_trigger'),
  enforcement: text('enforcement').$type<'soft' | 'hard'>(),
  requestTtlHours: integer('request_ttl_hours'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// apps/api/src/services/ticketApproval/settings.ts
import { and, eq, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { ticketApprovalSettings, organizations } from '../../db/schema';
import type { Effective, SettingSource } from '../autopay/billingPaymentSettings';
import type { Tx } from '../autopay/types';

export type ApprovalEnforcement = 'soft' | 'hard';
export interface EffectiveTicketApprovalSettings {
  enabled: Effective<boolean>; budgetTrigger: Effective<boolean>; afterHoursTrigger: Effective<boolean>;
  enforcement: Effective<ApprovalEnforcement>; requestTtlHours: Effective<number>;
}
export const TICKET_APPROVAL_SETTINGS_DEFAULTS = {
  enabled: false, budgetTrigger: true, afterHoursTrigger: true,
  enforcement: 'soft' as ApprovalEnforcement, requestTtlHours: 72,
};
type Fields = Pick<typeof ticketApprovalSettings.$inferSelect,
  'enabled' | 'budgetTrigger' | 'afterHoursTrigger' | 'enforcement' | 'requestTtlHours'>;
function pick<T>(org: T | null | undefined, partner: T | null | undefined, fallback: T): Effective<T> {
  if (org != null) return { value: org, source: 'org' as SettingSource };
  if (partner != null) return { value: partner, source: 'partner' };
  return { value: fallback, source: 'default' };
}
export function pickEffectiveTicketApprovalSettings(org: Fields | undefined, partner: Fields | undefined): EffectiveTicketApprovalSettings {
  const d = TICKET_APPROVAL_SETTINGS_DEFAULTS;
  return {
    enabled: pick(org?.enabled, partner?.enabled, d.enabled),
    budgetTrigger: pick(org?.budgetTrigger, partner?.budgetTrigger, d.budgetTrigger),
    afterHoursTrigger: pick(org?.afterHoursTrigger, partner?.afterHoursTrigger, d.afterHoursTrigger),
    enforcement: pick(org?.enforcement, partner?.enforcement, d.enforcement),
    requestTtlHours: pick(org?.requestTtlHours, partner?.requestTtlHours, d.requestTtlHours),
  };
}
/** The ONLY reader of ticket_approval_settings (spec §4.1). */
export async function resolveTicketApprovalSettings(db: Tx, args: { partnerId: string; orgId?: string | null }): Promise<EffectiveTicketApprovalSettings> {
  if (args.orgId) {
    const [org] = await db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, args.orgId), eq(organizations.partnerId, args.partnerId))).limit(1);
    if (!org) throw new HTTPException(404, { message: 'Organization not found' });
  }
  const rows = await db.select().from(ticketApprovalSettings).where(or(
    eq(ticketApprovalSettings.partnerId, args.partnerId),
    args.orgId ? eq(ticketApprovalSettings.orgId, args.orgId) : undefined,
  ));
  const partner = rows.find(r => r.partnerId === args.partnerId && r.orgId === null);
  const org = args.orgId ? rows.find(r => r.orgId === args.orgId && r.partnerId === null) : undefined;
  return pickEffectiveTicketApprovalSettings(org, partner);
}
```

If `Effective`/`Tx` are not exported from those paths, export them from
`billingPaymentSettings.ts` rather than redeclaring them. One `Effective<T>` type should
serve the whole repo.

- [ ] **Step 5: Run the resolver test and confirm it passes.** Same command as Step 2. Expected: PASS, 3 tests.

- [ ] **Step 6: Validators and routes.** In `packages/shared/src/validators/ticketApproval.ts`:

```ts
import { z } from 'zod';
const fields = {
  enabled: z.boolean(), budgetTrigger: z.boolean(), afterHoursTrigger: z.boolean(),
  enforcement: z.enum(['soft', 'hard']), requestTtlHours: z.number().int().min(1).max(720),
};
export const partnerTicketApprovalSettingsPatchSchema = z.object(fields).partial().strict();
export const orgTicketApprovalSettingsPatchSchema = z.object(
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.nullable()])) as { [K in keyof typeof fields]: z.ZodNullable<(typeof fields)[K]> },
).partial().strict();
export type PartnerTicketApprovalSettingsPatch = z.infer<typeof partnerTicketApprovalSettingsPatchSchema>;
export type OrgTicketApprovalSettingsPatch = z.infer<typeof orgTicketApprovalSettingsPatchSchema>;
```

  The routes follow the `billing_payment_settings` route pair exactly. Locate them with
  `grep -rn "resolveBillingPaymentSettings" apps/api/src/routes`. The partner PATCH is gated
  on `canManagePartnerWidePolicies(auth)`. The org PATCH uses the same middleware as the
  existing org ticket settings route; locate it with
  `grep -rn "orgTicketSettings" apps/api/src/routes`. Both upsert on the partial unique
  index. Both GETs return `resolveTicketApprovalSettings(...)` so the UI can show the
  value and its source. Write route tests in `approvalSettings.test.ts`:
  - partner PATCH without partner-wide rights → 403
  - org PATCH `{ enforcement: null }` clears the override, and GET then reports `source: 'partner'`
  - an unknown key → 400

- [ ] **Step 7: Partner RLS integration suite.** `ticketApprovalSettingsPartnerRls.integration.test.ts`
  must cover these cases, modelled on any existing `*PartnerRls.integration.test.ts`
  (`ls apps/api/src/__tests__/integration | grep PartnerRls`):
  - (a) Partner A's context inserting a `partner_id = B` row → `42501`.
  - (b) A row with both owners set → `23514`.
  - (c) An org-scoped context for org A1 reads partner A's default row through the
    SELECT-only branch, and cannot UPDATE it (0 rows).
  - (d) Org A1's context cannot read org A2's override.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-12-14-100100-ticket-approval-settings.sql apps/api/src/db/schema/ticketApproval.ts apps/api/src/db/schema/index.ts apps/api/src/services/ticketApproval packages/shared/src/validators apps/api/src/routes apps/api/src/__tests__/integration/ticketApprovalSettingsPartnerRls.integration.test.ts
git commit -m "feat(tickets): ticket approval policy settings with partner default and org override (#4617)"
```

### Task 3: `ticket_approval_requests`, ticket/time-entry/work-type columns, permission

**Files:**
- Create: `apps/api/migrations/2026-12-14-100200-ticket-approval-requests.sql`
- Create: `apps/api/migrations/2026-12-14-100300-tickets-record-approval-permission.sql`
- Modify: `apps/api/src/db/schema/ticketApproval.ts` (add `ticketApprovalRequests`)
- Modify: `apps/api/src/db/schema/portal.ts` (`tickets`: 3 budget columns)
- Modify: `apps/api/src/db/schema/timeTracking.ts` (`timeEntries.approvalRequestId`)
- Modify: `apps/api/src/db/schema/workTypes.ts` (`isAfterHours`)
- Modify: `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS` row for `tickets:record_approval`, byte-identical description)
- Modify: `packages/shared/src/constants/permissions.ts` (`TICKETS_RECORD_APPROVAL`)
- Test: `apps/api/src/__tests__/integration/ticketApprovalRequests.integration.test.ts`

**Interfaces:** Produces the Drizzle `ticketApprovalRequests` table. Its column names
match spec §4.3 1:1 in camelCase: `approverEmails`, `notifyEmails`, `revision`,
`decidedRevision`, and so on.

- [ ] **Step 1: Write the failing integration test.** It runs against a real DB
  (`pnpm test-stack up`). Seed partner P, org O and ticket T, then assert:

```ts
it('allows only one pending request per ticket+trigger', async () => {
  await insertRequest({ ticketId: T, orgId: O, trigger: 'budget', status: 'pending' });
  await expect(insertRequest({ ticketId: T, orgId: O, trigger: 'budget', status: 'pending' }))
    .rejects.toMatchObject({ code: '23505' });
  await expect(insertRequest({ ticketId: T, orgId: O, trigger: 'after_hours', status: 'pending' })).resolves.toBeDefined();
});
it('rejects an approved row with no decision evidence', async () => {
  await expect(insertRequest({ ticketId: T, orgId: O, trigger: 'budget', status: 'approved' }))
    .rejects.toMatchObject({ code: '23514' });
});
it('freezes a decided row except org_id and user-id nulling', async () => {
  const id = await insertDecidedRequest({ ticketId: T, orgId: O, decision: 'approved' });
  await expect(sqlSystem`UPDATE ticket_approval_requests SET approved_extension_minutes = 999 WHERE id = ${id}`)
    .rejects.toThrow(/decided approval request is immutable/);
  await expect(sqlSystem`UPDATE ticket_approval_requests SET decided_by_user_id = NULL WHERE id = ${id}`).resolves.toBeDefined();
});
it('nulls time_entries.approval_request_id when the request is deleted', async () => {
  const id = await insertRequest({ ticketId: T, orgId: O, trigger: 'budget', status: 'pending' });
  const entryId = await insertEntry({ ticketId: T, orgId: O, approvalRequestId: id, billingStatus: 'awaiting_approval' });
  await sqlSystem`DELETE FROM ticket_approval_requests WHERE id = ${id}`;
  expect((await readEntry(entryId)).approval_request_id).toBeNull();
});
it('forbids awaiting_approval on ticket_parts', async () => {
  await expect(insertPart({ ticketId: T, orgId: O, billingStatus: 'awaiting_approval' })).rejects.toMatchObject({ code: '23514' });
});
it('rejects a cross-org request insert from an org context', async () => {
  await expect(asOrg(OTHER_ORG, () => insertRequest({ ticketId: T, orgId: O, trigger: 'budget', status: 'pending' })))
    .rejects.toThrow(/row-level security/);
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run
  `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/ticketApprovalRequests.integration.test.ts`.
  Expected: FAIL, relation `ticket_approval_requests` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- #4617 spec §4.2-§4.5. Uses 'awaiting_approval' only in a CHECK on
-- ticket_parts, which is legal: the value was committed by 2026-12-14-100000.
SELECT set_config('breeze.scope','system',true);

-- §4.2 ticket budget (document value; no default)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS budget_minutes integer;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS budget_amount numeric(12,2);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS budget_currency_code char(3);
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_budget_chk;
ALTER TABLE tickets ADD CONSTRAINT tickets_budget_chk CHECK (
  (budget_minutes IS NULL OR budget_minutes > 0)
  AND (budget_amount IS NULL OR budget_amount > 0)
  AND ((budget_amount IS NULL) = (budget_currency_code IS NULL))
  AND (budget_currency_code IS NULL OR budget_currency_code ~ '^[A-Z]{3}$'));

-- §4.5
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS is_after_hours boolean NOT NULL DEFAULT false;

-- §4.3
CREATE TABLE IF NOT EXISTS ticket_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('budget','after_hours')),
  origin text NOT NULL CHECK (origin IN ('auto','staff')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  enforcement text NOT NULL CHECK (enforcement IN ('soft','hard')),
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  message text,
  budget_minutes_at_request integer,
  consumed_minutes_at_request integer,
  budget_amount_at_request numeric(12,2),
  consumed_amount_at_request numeric(12,2),
  currency_code char(3),
  requested_extension_minutes integer CHECK (requested_extension_minutes IS NULL OR requested_extension_minutes > 0),
  requested_extension_amount numeric(12,2) CHECK (requested_extension_amount IS NULL OR requested_extension_amount > 0),
  coverage_starts_at timestamptz,
  coverage_ends_at timestamptz,
  after_hours_work_type_id uuid,
  approver_emails text[] NOT NULL DEFAULT '{}',
  notify_emails text[] NOT NULL DEFAULT '{}',
  decided_at timestamptz,
  decision_origin text CHECK (decision_origin IN ('customer','on_behalf')),
  decided_by_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  signer_name text,
  signer_email text,
  decision_method text CHECK (decision_method IN ('verbal','email','signed_document','other')),
  decision_reference text,
  decision_note text,
  decided_revision integer,
  approved_extension_minutes integer,
  approved_extension_amount numeric(12,2),
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_approval_requests_id_ticket_uq UNIQUE (id, ticket_id),
  CONSTRAINT ticket_approval_requests_coverage_chk CHECK (
    (coverage_starts_at IS NULL) = (coverage_ends_at IS NULL)
    AND (coverage_ends_at IS NULL OR (coverage_ends_at > coverage_starts_at AND coverage_ends_at - coverage_starts_at <= interval '14 days'))),
  CONSTRAINT ticket_approval_requests_decision_shape_chk CHECK (
    (status NOT IN ('approved','denied')) OR (
      decided_at IS NOT NULL AND decision_origin IS NOT NULL AND decided_revision IS NOT NULL
      AND (decision_origin <> 'on_behalf' OR (decision_method IS NOT NULL AND decision_reference IS NOT NULL AND length(btrim(decision_reference)) > 0))
      AND (decision_origin <> 'customer' OR signer_email IS NOT NULL)))
);
-- decided_by_user_id / decided_by_portal_user_id are deliberately NOT required
-- by the CHECK: ON DELETE SET NULL may null them later. The service always
-- sets them; signer_name/signer_email are the durable identity.

ALTER TABLE ticket_approval_requests DROP CONSTRAINT IF EXISTS ticket_approval_requests_ticket_org_fk;
ALTER TABLE ticket_approval_requests ADD CONSTRAINT ticket_approval_requests_ticket_org_fk
  FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

CREATE UNIQUE INDEX IF NOT EXISTS ticket_approval_requests_one_pending_uq
  ON ticket_approval_requests(ticket_id, trigger) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ticket_approval_requests_sweep_idx ON ticket_approval_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS ticket_approval_requests_org_status_idx ON ticket_approval_requests(org_id, status);

-- Decided rows are immutable except org_id (org move/merge), updated_at and
-- FK SET NULL on the user-id columns. Rows stay deletable (tenant erasure).
CREATE OR REPLACE FUNCTION ticket_approval_requests_decided_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved','denied','expired','cancelled') THEN
    IF (to_jsonb(NEW) - ARRAY['org_id','updated_at','requested_by_user_id','decided_by_user_id','decided_by_portal_user_id'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['org_id','updated_at','requested_by_user_id','decided_by_user_id','decided_by_portal_user_id'])
       OR (NEW.requested_by_user_id IS NOT NULL AND NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id)
       OR (NEW.decided_by_user_id IS NOT NULL AND NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id)
       OR (NEW.decided_by_portal_user_id IS NOT NULL AND NEW.decided_by_portal_user_id IS DISTINCT FROM OLD.decided_by_portal_user_id) THEN
      RAISE EXCEPTION 'decided approval request is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ticket_approval_requests_decided_immutable ON ticket_approval_requests;
CREATE TRIGGER ticket_approval_requests_decided_immutable BEFORE UPDATE ON ticket_approval_requests
  FOR EACH ROW EXECUTE FUNCTION ticket_approval_requests_decided_immutable();

ALTER TABLE ticket_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_approval_requests_org ON ticket_approval_requests;
CREATE POLICY ticket_approval_requests_org ON ticket_approval_requests FOR ALL
  USING (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id))
  WITH CHECK (current_setting('breeze.scope',true)='system' OR public.breeze_has_org_access(org_id));
GRANT SELECT,INSERT,UPDATE,DELETE,REFERENCES ON ticket_approval_requests TO breeze_app;

-- §4.4 time entry link (keyed on ticket_id so org moves never defer it)
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS approval_request_id uuid;
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS time_entries_approval_request_fk;
ALTER TABLE time_entries ADD CONSTRAINT time_entries_approval_request_fk
  FOREIGN KEY (approval_request_id, ticket_id) REFERENCES ticket_approval_requests(id, ticket_id)
  ON DELETE SET NULL (approval_request_id);
CREATE INDEX IF NOT EXISTS time_entries_approval_request_idx ON time_entries(approval_request_id) WHERE approval_request_id IS NOT NULL;

ALTER TABLE ticket_parts DROP CONSTRAINT IF EXISTS ticket_parts_billing_status_not_held_chk;
ALTER TABLE ticket_parts ADD CONSTRAINT ticket_parts_billing_status_not_held_chk CHECK (billing_status <> 'awaiting_approval');
```

  Before committing, confirm against the CURRENT RLS helpers in
  `rls-coverage.integration.test.ts` that a Shape 1 `FOR ALL` policy with this exact
  `USING` text is what the coverage test auto-discovers. Copy the policy text from the
  newest Shape 1 table in `apps/api/migrations` if it differs (for example, a
  `breeze_current_scope()` helper instead of `current_setting`).

- [ ] **Step 4: Permission migration.** Copy
  `2026-10-27-100100-quotes-accept-permission.sql` structurally. Insert the
  `('tickets','record_approval')` permission row through an existence check, then
  back-fill it to every role holding `('tickets','manage')`, matched on the grant and
  never on the role name. Mirror the description in `seed.ts`
  `DEFAULT_PERMISSIONS`, byte-identical.

- [ ] **Step 5: Drizzle columns.** Add `budgetMinutes`, `budgetAmount` and `budgetCurrencyCode` to
  `tickets`. Add `approvalRequestId` to `timeEntries`. Add `isAfterHours` to `workTypes`. Add the
  full `ticketApprovalRequests` table, with a header comment stating that the FKs,
  CHECKs and trigger are SQL-only. `timeTracking.ts:27-40` is the precedent for composite FKs; extend the note to cover CHECKs and the trigger. Run
  `pnpm db:check-drift` against a migrated test-stack DB. Expected: no drift.

- [ ] **Step 6: Run the integration test and confirm it passes.** Same command as Step 2. Expected: PASS, 6 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-12-14-100200-ticket-approval-requests.sql apps/api/migrations/2026-12-14-100300-tickets-record-approval-permission.sql apps/api/src/db apps/api/src/__tests__/integration/ticketApprovalRequests.integration.test.ts packages/shared/src/constants/permissions.ts
git commit -m "feat(tickets): ticket approval requests table, budget and after-hours columns (#4617)"
```

### Task 4: Every registration list (mechanical; contract suites prove it)

**Files (all Modify):**
- `apps/api/src/services/tenantCascade.ts`: add `'ticket_approval_requests'` and `'ticket_approval_settings'` to `CORE_ORG_CASCADE_DELETE_ORDER` in `localeCompare` order. Both sort before `'tickets'` and `'time_entries'` (`'ticket_a…' < 'ticket_al…'`; check against the neighbours `ticket_alert_links` and `ticket_attachments`). Run `node -e "console.log(['ticket_alert_links','ticket_approval_requests','ticket_approval_settings','ticket_attachments'].sort((a,b)=>a.localeCompare(b)))"` and place them where that output puts them.
- `apps/api/src/services/orgMergeRegistry.ts`: `ticket_approval_settings: { kind: 'keep-survivor' }`, mirroring `billing_payment_settings` at `:137`, with the comment `verified: partial UNIQUE (org_id)`. `ticket_approval_requests` gets `repoint`.
- `apps/api/src/services/tenantExportPolicyRegistry.ts`:
  - New `ticket_approval_settings` row: every column `included`.
  - New `ticket_approval_requests` row: every column `included`. No column is
    `json`/`jsonb`/`bytea`. None matches `SUSPICIOUS_NAME_PARTS`; if `decision_reference`
    or another column does, move it to `reviewedIncluded` with a comment.
  - Append `budget_minutes`, `budget_amount` and `budget_currency_code` to the existing
    `tickets` row.
  - Append `approval_request_id` to the existing `time_entries` row.
- `apps/api/src/services/ticketOrgMoveLockOrder.ts`: append `'ticket_approval_requests'` LAST to both `TICKET_ORG_DENORMALIZED_TABLES` and `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER`, with a comment citing #4617.
- `apps/api/src/routes/devices/core.ts:442`: append `'ticket_approval_requests'` LAST to `CUSTOM_ORG_REWRITE_TABLES`, at the same relative position.
- `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts`: the device-move path does **not** loop over the list. It has one hand-written re-stamp per table (~`:969-1010`; `moveOrg.test.ts` pins the statement sequence). Add `await tx.execute(sql\`UPDATE ${sql.identifier('ticket_approval_requests')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)\`)` LAST, after the `ticket_external_refs` statements, with a comment in the style of the `ticket_checklist_items` block. Update `moveOrg.test.ts`'s expected sequence. Without this, the deferred `ticket_approval_requests_ticket_org_fk` fails at commit on every device move with a ticket that has a request. `moveTicketOrg` (`ticketService.ts:3440`) loops `TICKET_ORG_DENORMALIZED_TABLES` and needs only the list entry.
- Add a comment beside the list entries. Writers lock `request → time_entries`, while the movers rewrite `time_entries` first and `ticket_approval_requests` last. That is deadlock-free only because both sides take the `tickets` row lock first. The W01 Task 4 Step 5 org-move test and the W02 Task 4 concurrency test pin it.
- `apps/api/src/services/ticketService.ts:3144` and `apps/api/src/services/deviceOrgMove/moveDeviceOrgInTransaction.ts:178`: add `ticket_approval_requests_ticket_org_fk` to both `SET CONSTRAINTS … DEFERRED` lists.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`: add `ticket_approval_settings` to `DUAL_AXIS_TENANT_TABLES`. `ticket_approval_requests` is Shape 1 and auto-discovered, so it needs no allowlist entry.

- [ ] **Step 1: Run the unit contract tests first and confirm they fail**

`cd apps/api && npx vitest run src/services/ticketOrgMoveLockOrder.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/orgMerge.test.ts`

Before the edits, expect `orgMerge.test.ts` to throw `no merge policy registered for 'ticket_approval_…'`.
Run the FULL unit suite once at the end of this task, because `orgMerge.test.ts` only
reds in a full run (CLAUDE.md).

- [ ] **Step 2: Make the edits listed above.**

- [ ] **Step 3: Unit contracts green.** Run the same command, then the full API unit suite in batches. For example:
  `npx vitest run src/services` then `npx vitest run src/routes`, each with
  `timeout 900`.

- [ ] **Step 4: Integration contracts.** With `pnpm test-stack up`, run:
  `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`.
  Then run `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  All must be green. Paste the file and test counts into the PR body.

- [ ] **Step 5: Org-move smoke.** Add one case to the existing ticket org-move integration
  test, which you can find with
  `grep -rln "moveTicketOrg" apps/api/src/__tests__/integration`: a ticket with a pending
  approval request and a held entry moves orgs, and both rows follow with the new
  `org_id`. Run it.

- [ ] **Step 6: Commit and tear down.** Commit `chore(tickets): register approval tables in cascade, merge, export and move lists (#4617)`, then run `pnpm test-stack down`.

---

# W02: gate and decisions engine

### Task 1: Pure gate function

**Files:**
- Create: `apps/api/src/services/ticketApproval/gate.ts`
- Create: `apps/api/src/services/ticketApproval/gate.test.ts`

**Interfaces:**
- Consumes `EffectiveTicketApprovalSettings` (W01 T2).
- Produces:

```ts
export type GateTrigger = 'budget' | 'after_hours';
export interface GateInput {
  settings: { enabled: boolean; budgetTrigger: boolean; afterHoursTrigger: boolean; enforcement: 'soft' | 'hard' };
  ticket: { budgetMinutes: number | null; budgetAmount: string | null; budgetCurrencyCode: string | null };
  consumed: { minutes: number; amountCents: number };          // excludes the entry being written
  approvedExtensions: { minutes: number; amountCents: number };
  entry: {
    isBillable: boolean; coverage: 'billable' | 'included' | 'non_billable';
    minutes: number | null;            // null = running timer
    hourlyRate: string | null; currencyCode: string | null;
    startedAt: Date; isAfterHoursWorkType: boolean;
  };
  afterHoursCovered: boolean;          // an approved window covers entry.startedAt, or released by an approved auto request
  pendingBudgetRequest: boolean;       // queue rule (spec §5.3): a pending budget request exists on the ticket
  operation: 'create_finished' | 'start_timer' | 'stop' | 'update';
}
export type GateResult =
  | { kind: 'pass' }
  | { kind: 'hold'; trigger: GateTrigger; overMinutes: number; overAmountCents: number }
  | { kind: 'refuse'; trigger: GateTrigger };   // only ever for operation === 'start_timer' in hard mode
export function evaluateApprovalGate(input: GateInput): GateResult;
```

- [ ] **Step 1: Write the failing table-driven tests.** Each row names its case:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateApprovalGate, type GateInput } from './gate';

const base = (): GateInput => ({
  settings: { enabled: true, budgetTrigger: true, afterHoursTrigger: true, enforcement: 'soft' },
  ticket: { budgetMinutes: 120, budgetAmount: null, budgetCurrencyCode: null },
  consumed: { minutes: 90, amountCents: 0 },
  approvedExtensions: { minutes: 0, amountCents: 0 },
  entry: { isBillable: true, coverage: 'billable', minutes: 30, hourlyRate: '100.00', currencyCode: 'USD', startedAt: new Date('2026-10-06T14:00:00Z'), isAfterHoursWorkType: false },
  afterHoursCovered: false,
  pendingBudgetRequest: false,
  operation: 'create_finished',
});
const w = (f: (i: GateInput) => void) => { const i = base(); f(i); return i; };

describe('evaluateApprovalGate', () => {
  it.each([
    ['disabled policy passes', w(i => { i.settings.enabled = false; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['exactly at ceiling passes', base(), { kind: 'pass' }],
    ['one minute over holds', w(i => { i.entry.minutes = 31; }), { kind: 'hold', trigger: 'budget', overMinutes: 1, overAmountCents: 0 }],
    ['approved extension lifts ceiling', w(i => { i.entry.minutes = 60; i.approvedExtensions.minutes = 30; }), { kind: 'pass' }],
    ['non-billable never held', w(i => { i.entry.isBillable = false; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['included coverage never held', w(i => { i.entry.coverage = 'included'; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['no budget, no budget hold', w(i => { i.ticket.budgetMinutes = null; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['budget trigger off', w(i => { i.settings.budgetTrigger = false; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['amount ceiling: 0.30h at 100 over 100.00 budget with 80.00 consumed holds', w(i => {
      i.ticket = { budgetMinutes: null, budgetAmount: '100.00', budgetCurrencyCode: 'USD' };
      i.consumed = { minutes: 0, amountCents: 8000 }; i.entry.minutes = 18; }),
      { kind: 'hold', trigger: 'budget', overMinutes: 0, overAmountCents: 1000 }],
    ['amount budget + missing rate holds', w(i => {
      i.ticket = { budgetMinutes: null, budgetAmount: '100.00', budgetCurrencyCode: 'USD' };
      i.consumed = { minutes: 0, amountCents: 0 }; i.entry.hourlyRate = null; i.entry.minutes = 1; }),
      { kind: 'hold', trigger: 'budget', overMinutes: 0, overAmountCents: 0 }],
    ['after-hours uncovered holds before budget', w(i => { i.entry.isAfterHoursWorkType = true; i.entry.minutes = 999; }),
      { kind: 'hold', trigger: 'after_hours', overMinutes: 0, overAmountCents: 0 }],
    ['after-hours covered falls through to budget', w(i => { i.entry.isAfterHoursWorkType = true; i.afterHoursCovered = true; i.entry.minutes = 31; }),
      { kind: 'hold', trigger: 'budget', overMinutes: 1, overAmountCents: 0 }],
    ['running timer (null minutes) never held at start in soft', w(i => { i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 500; }), { kind: 'pass' }],
    ['hard: start at ceiling refused', w(i => { i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 120; }), { kind: 'refuse', trigger: 'budget' }],
    ['hard: start under ceiling allowed', w(i => { i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 119; }), { kind: 'pass' }],
    ['hard: start uncovered after-hours refused', w(i => { i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null; i.entry.isAfterHoursWorkType = true; }), { kind: 'refuse', trigger: 'after_hours' }],
    ['hard mode never refuses a completed entry', w(i => { i.settings.enforcement = 'hard'; i.entry.minutes = 999; }), { kind: 'hold', trigger: 'budget', overMinutes: 969, overAmountCents: 0 }],
    ['hard mode never refuses a stop', w(i => { i.settings.enforcement = 'hard'; i.operation = 'stop'; i.entry.minutes = 999; }), { kind: 'hold', trigger: 'budget', overMinutes: 969, overAmountCents: 0 }],
    ['queue rule: pending request holds an entry that would fit', w(i => { i.pendingBudgetRequest = true; i.consumed.minutes = 0; i.entry.minutes = 5; }), { kind: 'hold', trigger: 'budget', overMinutes: 0, overAmountCents: 0 }],
    ['queue rule: hard start refused while pending', w(i => { i.settings.enforcement = 'hard'; i.pendingBudgetRequest = true; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 0; }), { kind: 'refuse', trigger: 'budget' }],
    ['running timer edited onto after-hours work type is not held until stop', w(i => { i.operation = 'update'; i.entry.minutes = null; i.entry.isAfterHoursWorkType = true; }), { kind: 'pass' }],
    ['amount budget + entry in other currency holds', w(i => {
      i.ticket = { budgetMinutes: null, budgetAmount: '100.00', budgetCurrencyCode: 'USD' };
      i.consumed = { minutes: 0, amountCents: 0 }; i.entry.currencyCode = 'EUR'; i.entry.minutes = 1; }),
      { kind: 'hold', trigger: 'budget', overMinutes: 0, overAmountCents: 0 }],
  ])('%s', (_name, input, expected) => {
    expect(evaluateApprovalGate(input)).toEqual(expected);
  });
});
```

  `overMinutes` is the amount over the minute ceiling (0 when only money crosses).
  `overAmountCents` is the amount over the money ceiling (0 when only minutes cross, or
  when the rate is missing).

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/api && npx vitest run src/services/ticketApproval/gate.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/ticketApproval/gate.ts
import { multiplyToCurrency, toCents } from '@breeze/shared';
export /* types from Interfaces above */;

// Quantity derivation MUST match invoiceAssembly.ts:102 (minutes/60) and its
// rounding; if invoiceAssembly exposes a helper for the hours string, use it.
function entryCents(e: GateInput['entry'], budgetCurrency: string | null): number | null {
  if (e.minutes == null || e.hourlyRate == null || e.currencyCode == null) return null;
  if (budgetCurrency != null && e.currencyCode !== budgetCurrency) return null;
  return toCents(multiplyToCurrency(String(e.minutes / 60), e.hourlyRate, e.currencyCode));
}

export function evaluateApprovalGate(i: GateInput): GateResult {
  const s = i.settings;
  if (!s.enabled) return { kind: 'pass' };
  const e = i.entry;
  if (!e.isBillable || e.coverage !== 'billable') return { kind: 'pass' };

  // After-hours first (spec §5.4).
  if (s.afterHoursTrigger && e.isAfterHoursWorkType && !i.afterHoursCovered) {
    if (i.operation === 'start_timer') return s.enforcement === 'hard' ? { kind: 'refuse', trigger: 'after_hours' } : { kind: 'pass' };
    if (e.minutes == null) return { kind: 'pass' }; // still running; evaluated at stop
    return { kind: 'hold', trigger: 'after_hours', overMinutes: 0, overAmountCents: 0 };
  }

  if (!s.budgetTrigger) return { kind: 'pass' };
  const t = i.ticket;
  const ceilMin = t.budgetMinutes == null ? null : t.budgetMinutes + i.approvedExtensions.minutes;
  const ceilCents = t.budgetAmount == null ? null : toCents(t.budgetAmount) + i.approvedExtensions.amountCents;
  if (ceilMin == null && ceilCents == null) return { kind: 'pass' };

  if (i.operation === 'start_timer') {
    if (i.pendingBudgetRequest) return s.enforcement === 'hard' ? { kind: 'refuse', trigger: 'budget' } : { kind: 'pass' };
    const atCeiling = (ceilMin != null && i.consumed.minutes >= ceilMin) || (ceilCents != null && i.consumed.amountCents >= ceilCents);
    return atCeiling && s.enforcement === 'hard' ? { kind: 'refuse', trigger: 'budget' } : { kind: 'pass' };
  }
  if (e.minutes == null) return { kind: 'pass' }; // still running after an update; evaluated at stop
  if (i.pendingBudgetRequest) return { kind: 'hold', trigger: 'budget', overMinutes: 0, overAmountCents: 0 }; // queue rule

  const overMinutes = ceilMin == null ? 0 : Math.max(0, i.consumed.minutes + e.minutes - ceilMin);
  let overAmountCents = 0;
  let unknownMoney = false;
  if (ceilCents != null) {
    const c = entryCents(e, t.budgetCurrencyCode);
    if (c == null) unknownMoney = true;
    else overAmountCents = Math.max(0, i.consumed.amountCents + c - ceilCents);
  }
  if (overMinutes > 0 || overAmountCents > 0 || unknownMoney) {
    return { kind: 'hold', trigger: 'budget', overMinutes, overAmountCents };
  }
  return { kind: 'pass' };
}
```

  Check the `multiplyToCurrency` and `toCents` signatures in
  `packages/shared/src/utils/currency.ts:169` and `quoteMath.ts:17-26` before using
  them. If `toCents` lives in `quoteMath`, import it from there. Never use
  `Number(rate) * hours`.

- [ ] **Step 4: Run it and confirm it passes.** Same command. Expected: PASS, 22 tests.

- [ ] **Step 5: Commit.** Message: `feat(tickets): pure approval gate evaluation (#4617)`.

### Task 2: Gate context loader and request join/create

**Files:**
- Create: `apps/api/src/services/ticketApproval/requests.ts`
- Create: `apps/api/src/services/ticketApproval/requests.integration.test.ts` (under `src/__tests__/integration/` if that is where the integration config globs; check `vitest.integration.config.ts` `include`)

**Interfaces:**
- Produces `loadGateContext(db, { ticketId, orgId, partnerId, excludeEntryId?: string, entryStartedAt: Date, workTypeId: string | null, ignoreRequestId?: string }): Promise<Omit<GateInput, 'entry' | 'operation'> & { isAfterHoursWorkType: boolean }>`.
  `pendingBudgetRequest` is true when a `pending` budget request exists on the ticket
  other than `ignoreRequestId`. Decision re-runs pass the request being decided or
  cancelled. It must be called **while the ticket row lock is held**. It sums consumption with this SQL:

```sql
SELECT
  COALESCE(SUM(COALESCE(billable_minutes, duration_minutes)), 0)::int AS minutes
FROM time_entries
WHERE ticket_id = $1 AND is_billable AND coverage = 'billable' AND ended_at IS NOT NULL
  AND billing_status IN ('not_billed','billed','contract')
  AND ($2::uuid IS NULL OR id <> $2)
```

  For cents, fetch `(billable_minutes, duration_minutes, hourly_rate, currency_code)` for
  the same rows and fold them with `multiplyToCurrency` and `toCents` in JS. Do not
  `ROUND` in SQL, so the math matches the gate exactly.
- Produces `holdEntryOnRequest(db, { ticketId, orgId, trigger, enforcement, ttlHours, overMinutes, overAmountCents, currencyCode, entryId, afterHoursWorkTypeId? }): Promise<{ requestId: string; created: boolean }>`.
  It locks the pending request for `(ticket_id, trigger)` `FOR UPDATE`, or inserts one.
  If the insert races on `ticket_approval_requests_one_pending_uq`, it catches `23505`
  and re-selects. On join it sets `revision = revision + 1` and recomputes the ask over the whole
  ticket. The formula is `requested_extension_minutes = ceil15(max(0, consumedMinutes + Σ minutes of all held entries on this request incl. this one − ceilingMinutes))`,
  and the same in cents for the amount. Never sum per-entry overages: each one excludes
  the others from `consumed`, so the sum under-asks. It also resets `expires_at`.
  Add a test: budget 60, consumed 50, two held 30-minute entries → ask 50, not 40. It sets the entry to `billing_status = 'awaiting_approval'` and
  `approval_request_id`.
- Produces `resolveRecipients(db, { orgId, ticketId, trigger }): Promise<{ approverEmails: string[]; notifyEmails: string[] }>`, per spec §6.1, with lower-cased, de-duplicated emails.

- [ ] **Step 1: Write the failing integration tests.** Cover:
  - The first hold creates a request with `revision = 1`, `origin = 'auto'` and the
    snapshot figures.
  - A second hold joins it, `revision = 2`, and the extension grows.
  - An after-hours hold creates a separate request.
  - The recipient split: billing contact → approver; requester → notify; a requester
    who is also a billing contact → approver only.
  - With no billing contact, `approverEmails` is `[]`.

- [ ] **Step 2: Run them and confirm they fail.** **Step 3: Implement.** **Step 4: Pass.** **Step 5: Commit** `feat(tickets): approval request create/join and recipient resolution (#4617)`.

### Task 3: Wire the gate into the four writers

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts`:
  - `createTimeEntry` (`:644`)
  - `startTimer` (`:834`)
  - `stopRunningEntry` (`:770`) and `stopTimer` (`:929`)
  - `updateTimeEntry` (`:1001`), including the reprice block at `:1049-1060`
  - `getEntryOr404` (`:980`)
- Modify: `apps/api/src/services/timeEntryService.test.ts`, or create `timeEntryService.approvalGate.test.ts` next to it.
- Create: `apps/api/src/services/timeEntryWriters.contract.test.ts`

**Interfaces:**
- Consumes `evaluateApprovalGate`, `loadGateContext`, `holdEntryOnRequest` and `resolveTicketApprovalSettings`.
- Produces a new `TimeEntryServiceError(…, 409, 'APPROVAL_REQUIRED')` carrying `details: { trigger, pendingRequestId: string | null }`. The REST error mapper must pass `details` through; check how `code` is surfaced in `routes/timeEntries/timeEntries.ts`.
- Each writer's return value gains `approvalHold: { requestId: string; trigger: GateTrigger } | null`.

Required changes:
1. **Lock order (spec §5.2).** `stopRunningEntry` and `updateTimeEntry` currently lock the
   entry before the ticket. Change both:
   - Read the entry unlocked.
   - If it has a `ticket_id`, take `readOrgStampingDefaults` (SHARE), then `lockTicketRow`.
   - Then lock the entry with `getEntryOr404`'s `FOR UPDATE` and re-check `ticket_id`
     and `ended_at`. If either changed, retry the sequence once, then throw
     `409 ENTRY_CHANGED`.

   `startTimer`'s auto-stop must lock both tickets, the running entry's and the new
   one, in ascending id order before either write.
2. **Gate call sites.**
   - Run the gate after `resolveEntryBilling`/`applyBillingInput` has produced the stamp
     and before the INSERT/UPDATE.
   - `operation` is `'start_timer'` in `startTimer`, `'stop'` in
     `stopRunningEntry`/`stopTimer` and in `updateTimeEntry` when `endedAt` goes from
     null to set, `'create_finished'` in `createTimeEntry`, and `'update'` otherwise.
   - On `hold`, write the row with `billingStatus: 'awaiting_approval'`, then call
     `holdEntryOnRequest` in the same transaction.
   - On `refuse`, throw `APPROVAL_REQUIRED`.
   - On `pass` for an entry that WAS `awaiting_approval`, which happens on an edit,
     set `not_billed`, clear `approval_request_id`, and if the old request is `auto`,
     `pending` and now has no held entries, set it to `cancelled`.
3. **Reprice cannot clear a hold.** In the reprice block, never derive `billingStatus`
   from the stamp when the entry is `awaiting_approval`. The gate decides it.
4. **Clients cannot set the status.** Any input that names
   `billingStatus: 'awaiting_approval'` is rejected with 400 in the shared validator, and
   the service ignores it.
5. **`approved` after-hours coverage.** `afterHoursCovered` is true when an
   `approved` `after_hours` request on the ticket has
   `coverage_starts_at <= entry.started_at < coverage_ends_at`, or when the entry's
   current `approval_request_id` is an approved `auto` after-hours request.

- [ ] **Step 1: Write the failing service tests.** Use the existing `timeEntryService`
  test harness and mocks, following the `breeze-testing` skill. They must include:
  - a soft-mode stop over budget returns `approvalHold` and writes `awaiting_approval`;
  - **hard mode never refuses a completed entry**: `createTimeEntry` with `endedAt` in
    hard mode over budget → hold, no throw;
  - a hard-mode `startTimer` at the ceiling → 409 `APPROVAL_REQUIRED` with `details.trigger === 'budget'`;
  - a hard-mode `startTimer` with `isBillable: false` at the ceiling → OK;
  - editing a held entry down so it fits releases it and cancels the empty `auto` request;
  - a reprice (work type change) on a held entry leaves it `awaiting_approval` when it still crosses;
  - `billingStatus: 'awaiting_approval'` in the input → 400.
- [ ] **Step 2: Write the writer contract test.** `timeEntryWriters.contract.test.ts`
  reads every `.ts` file under `apps/api/src` that is not a test and fails if
  `insert(timeEntries)` or `update(timeEntries)` (and the raw `UPDATE time_entries`)
  appears outside an allowlist. The allowlist is `timeEntryService.ts`,
  `invoiceService.ts`, `ticketService.ts` (org move), `deviceOrgMove/moveDeviceOrgInTransaction.ts`,
  `tenantCascade.ts` and `orgMergeRegistry.ts`. Its failure message names the gate.
- [ ] **Step 3: Run both and confirm they fail.** **Step 4: Implement.** **Step 5: Pass.**
- [ ] **Step 6: Run the existing time-entry suites** to catch lock-order regressions:
  `npx vitest run src/services/timeEntryService src/routes/timeEntries src/routes/officeAddin src/services/aiToolsTicketing src/services/timeSuggestionService`.
  Compare the reported file count against `ls` so no file is skipped.
- [ ] **Step 7: Commit** `feat(tickets): hold over-budget and after-hours time entries pending customer approval (#4617)`.

### Task 4: Concurrency integration tests

**Files:** Create `apps/api/src/__tests__/integration/ticketApprovalGate.concurrency.integration.test.ts`.

- [ ] **Step 1: Write the tests.** Each one opens two real connections (two `withDbAccessContext`
  promises racing on a barrier) against the test stack:
  1. Ticket budget 60 min, consumed 30. Two techs each stop a 30-min timer
     concurrently. Assert exactly one entry is `not_billed`, one is
     `awaiting_approval`, and there is exactly one pending request.
  2. A held entry is joined while a portal approve commits on the same request. Assert
     either the approve wins and the join creates a new request (the old one is
     decided), or the join wins and the approve gets `REQUEST_CHANGED`. Never an
     approve that released an entry it did not see.
  3. User A has a timer running on ticket X and starts one on Y. At the same time,
     user B has a timer running on Y and starts one on X. Both complete with no `40P01`.
- [ ] **Step 2: Run them.** Expected: PASS. If any fails, fix the lock order in Task 3, not the test.
- [ ] **Step 3: Commit.**

### Task 5: Decision service

**Files:**
- Create: `apps/api/src/services/ticketApproval/decisions.ts`
- Create: `apps/api/src/services/ticketApproval/decisions.integration.test.ts`

**Interfaces (Produces):**

```ts
export type DecisionActor =
  | { kind: 'customer'; portalUserId: string; email: string; signerName: string; ip?: string; userAgent?: string }
  | { kind: 'on_behalf'; userId: string; method: 'verbal' | 'email' | 'signed_document' | 'other'; reference: string; signerName: string; signerEmail?: string };
export async function decideApprovalRequest(db: Tx, args: { requestId: string; decision: 'approved' | 'denied'; revision: number; note?: string; actor: DecisionActor }): Promise<{ released: string[]; stillHeld: string[] }>;
export async function cancelApprovalRequest(db: Tx, args: { requestId: string; userId: string }): Promise<void>;
export async function reaskApprovalRequest(db: Tx, args: { requestId: string; userId: string; message?: string; extensionMinutes?: number; extensionAmount?: string }): Promise<{ newRequestId: string }>;
export async function writeOffHeldEntry(db: Tx, args: { entryId: string; actor: TimeEntryActor }): Promise<void>; // requires manage_billing
export async function createStaffApprovalRequest(db: Tx, args: { ticketId: string; userId: string; trigger: 'budget' | 'after_hours'; message?: string; extensionMinutes?: number; extensionAmount?: string; coverageStartsAt?: Date; coverageEndsAt?: Date }): Promise<{ requestId: string }>;
export async function expireDueApprovalRequests(db: Tx, now: Date): Promise<number>;
```

Rules (spec §5.6):
- Lock order: every function receives an id, never a locked row. Each one:
  1. reads the request (or the entry, for write-off) **unlocked** to learn `ticket_id`
     and `org_id`;
  2. takes `organizations FOR SHARE` (reuse `readOrgStampingDefaults`), then
     `tickets FOR UPDATE` (`lockTicketRow`);
  3. locks the request `FOR UPDATE`, then the linked entries `FOR UPDATE ORDER BY id`;
  4. re-checks status and `ticket_id`. If the ticket moved or the status changed
     between step 1 and step 3, it retries once, then fails with `409`.

  Write-off follows the same sequence. It re-checks under the lock that the entry's
  request is still `denied`, `expired` or `cancelled`, because a concurrent re-ask may
  have moved the entry onto a pending request.
- The request must be `pending` (else `409 REQUEST_NOT_PENDING`), `revision` must equal
  the supplied value (else `409 REQUEST_CHANGED`), and `expires_at > now()` (else
  expire it, then `409 REQUEST_EXPIRED`).
- **Customer:** the actor's lower-cased email must be in `approver_emails` and the portal
  user's `orgId` must equal `org_id` (else `403`).
- **On behalf:** `reference` is non-blank and the actor holds `tickets:record_approval`
  (the route enforces this; the service asserts `actor.kind`).
- **Approve:** stamp the decision with `decided_revision = revision`, copying
  `approved_extension_* = requested_extension_*`. Then re-run the gate for each linked
  entry in id order, with consumption recomputed after each release. A passing entry
  becomes `not_billed` and keeps `approval_request_id` as provenance. One that still
  crosses → `holdEntryOnRequest`, which creates a new pending request.
- **Deny:** stamp only. Entries stay `awaiting_approval`, linked to the denied request.
- **Write-off:** the entry must be `awaiting_approval` on a `denied`, `expired` or
  `cancelled` request. Set `billing_status = 'no_charge'` and write audit action
  `time_entry.approval_written_off`.
- **Re-ask:** the old request must be `denied`, `expired` or `cancelled`. Create a new
  `staff` request and move the old request's still-held entries to it.
- **Cancel:** set `cancelled`. Then, in id order, re-run the gate for each linked entry
  with `ignoreRequestId` set to the cancelled request. Passing entries become
  `not_billed` and are unlinked. The rest go through `holdEntryOnRequest`, which opens a
  new pending request.
- **Expire:** run `SELECT id FROM ticket_approval_requests WHERE status = 'pending' AND expires_at <= now ORDER BY id LIMIT 200`.
  Then, for each id, open its own transaction with the full lock sequence above,
  locking the request `FOR UPDATE SKIP LOCKED`; skip it if it is locked or no longer
  due. Set it `expired`. Entries stay held. Never use one bulk `UPDATE`, which would
  take request locks out of order.
- Each transition inserts a ticket comment (`comment_type = 'system'`, `is_public = true`)
  and calls `emitTicketEvent('ticket.approval_requested' | 'ticket.approval_decided', …)`
  **after commit**. W04 adds the event types; in W02, add the types to the
  `ticketEvents.ts` union and make the worker `case` a no-op that logs.

- [ ] **Step 1: Write the failing integration tests.** Cover each rule above, with one
  test per bullet, and these too:
  - a customer whose email is in `notify_emails` only gets 403;
  - an approve with a stale revision gets 409 and releases nothing;
  - approval with an extension smaller than the overage leaves the excess entry held
    on a new request;
  - write-off without `manage_billing` gets 403;
  - expire leaves entries held;
  - cancel releases entries that now fit and re-holds the rest on a new request;
  - write-off racing a re-ask on the same entry: exactly one wins, and no pending
    request is left with zero held entries;
  - the queue-rule regression: budget 120 with 90 consumed. Hold a 60-minute entry,
    then log 20 minutes; it joins the request. Approve the recomputed ask, and both
    entries are released.
- [ ] **Step 2: Fail. Step 3: Implement. Step 4: Pass. Step 5: Commit.**

### Task 6: `billing_status` reader audit

**Files (Modify):** every file from W01 Task 1 Step 3's compile-error list, plus
`grep -rln "billing_status\|billingStatus" apps/*/src packages/shared/src | grep -v '\.test\.'`.
That is 29 files at plan time. The required behaviour for the known readers is the
spec §5.7 table. For each file, the PR body records one line: `file — change | no change because …`.

Minimum test additions:
- `ticketMoveCurrencyGuard.test.ts`: a ticket with an `awaiting_approval` entry in USD
  moving to an EUR org is refused, the same as a `not_billed` entry.
- `orgCurrencyService` test: a currency change is blocked by held time.
- `invoiceService` issue test: issuing a draft whose source entry became
  `awaiting_approval` after drafting gets `409 SOURCE_AWAITING_APPROVAL`.
- `supportUsage.test.ts`: held minutes are reported in a new `awaitingApprovalMinutes`
  bucket and are not counted as billed.
- `invoiceAssembly` test: a held entry is never gathered. This guards against a
  future refactor of the `= 'not_billed'` predicate.

- [ ] Steps: write the failing tests → fail → change each reader → pass → commit `fix(billing): treat held time entries as unbilled-but-not-invoiceable in every reader (#4617)`.

### Task 7: Expiry sweep

**Files:** Modify `apps/api/src/jobs/ticketSlaWorker.ts` (add a repeatable
`ticket-approval-expiry` job every 5 minutes, using the worker's existing repeatable
registration pattern). Test it in `ticketSlaWorker.test.ts`.

- [ ] Test: the job calls `expireDueApprovalRequests` inside
  `withSystemDbAccessContext`, after `runOutsideDbContext`, and emits one
  `ticket.approval_decided` event with `status: 'expired'` per expired row. Then fail →
  implement → pass → commit.

**W02 exit gate:**
- the full API unit suite, in batches;
- every new integration suite;
- the RLS coverage suite;
- `tsc` with the exit code checked.

---

# W03: staff API and web UI

### Task 1: Staff routes

**Files:**
- Create: `apps/api/src/routes/tickets/approvals.ts` and `approvals.test.ts`, mounted under the tickets router.
- Modify: the ticket PATCH validator in `packages/shared/src/validators/` (locate with `grep -rn "updateTicketSchema" packages/shared/src`) to accept `budgetMinutes`/`budgetAmount` (nullable).
- Modify: the ticket update service. Setting `budgetAmount` stamps `budgetCurrencyCode` from the org currency. Clearing it clears both.

Routes:
- `GET /tickets/:id/approval-summary` → `{ policy, budget: { minutes, amount, currency }, consumed, held, ceiling, requests[] }`
- `POST /tickets/:id/approval-requests` (`tickets:write`)
- `POST /ticket-approval-requests/:id/cancel` (`tickets:write`)
- `POST /ticket-approval-requests/:id/reask` (`tickets:write`)
- `POST /ticket-approval-requests/:id/decide-on-behalf` (`tickets:record_approval`)
- `POST /time-entries/:id/write-off-held` (`manage_billing`)

Route tests:
- each permission denial → 403;
- org-scope isolation: org B's token on org A's request → 404;
- `decide-on-behalf` with a blank reference → 400;
- setting a budget on a ticket stamps the currency.

### Task 2: Web components

**Files:**
- Create: `apps/web/src/components/tickets/TicketBudgetCard.tsx` (budget inputs, progress bar with held time shaded, "Request approval" button)
- Create: `apps/web/src/components/tickets/TicketApprovalsPanel.tsx` (request list, status, revision, recipients split into approvers and notified, Cancel / Re-ask / Record decision)
- Create: `apps/web/src/components/tickets/RecordApprovalDialog.tsx` (decision, method select, required reference, signer name and email, note)
- Modify: the ticket detail page that renders `TicketTimeBilling`, to mount both cards.
- Modify: `apps/web/src/components/time/TimesheetPage.tsx` and the ticket time list, to show the "Awaiting customer approval" chip and the "Write off" action (only for `manage_billing`).
- Modify: `apps/web/src/components/settings/TimeTrackingSettingsCard.tsx`, adding a "Customer approval" section. It is part of the page form, saved with page Save (rule 7).
- Modify: `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx`, adding the override fields with `InheritedField`. Blank means inherit, and the inherited value and its source are shown.
- Modify: `apps/web/src/components/billing/WorkTypesCard.tsx`, adding an "After-hours (requires customer approval when enabled)" checkbox per work type, plus the matching API field on the work-types route.
- i18n: new keys in every locale file.

Every mutation goes through `runAction`. Tests are co-located `*.test.tsx`:
- the budget card shows the ceiling including approved extensions;
- the dialog blocks submit without a reference;
- the settings card renders the inherited source label;
- the org editor's "clear" sends `null`;
- `no-silent-mutations.test.ts` stays green.

PR description: include the CLAUDE.md rule 9 settings statement from spec §7 verbatim.

---

# W04: portal and notifications

### Task 1: Portal routes

**Files:**
- Create: `apps/api/src/routes/portal/approvals.ts` and `approvals.test.ts`, mounted in `routes/portal/index.ts`.

Routes:
- `GET /portal/approvals`: requests where `org_id = auth.user.orgId` and the normalised
  `auth.user.email` is in `approver_emails` or `notify_emails`. Each row returns ticket
  number and subject, the ask and the snapshot figures, the status, and
  `canDecide: email ∈ approver_emails`. It never returns ticket comments.
- `POST /portal/approvals/:id/approve` and `/deny`: body `{ revision, signerName, note? }`.
  These require portal cookie CSRF (`validatePortalCookieCsrfRequest`). They run
  `decideApprovalRequest` with a `customer` actor and the trusted IP
  (`getTrustedClientIpOrUndefined`) and user agent. The run happens under
  `runOutsideDbContext(() => withSystemDbAccessContext(...))`, the same as
  `routes/portal/quotes.ts:244-297`, after the org and approver check. Audit with
  `writePortalAudit`.

Tests (Review Focus #2 and #5):
- an approver in another org → 404;
- a notify-only user → 403 on approve;
- a stale revision → 409;
- an approver who does not own the ticket can list and decide, and
  `GET /portal/tickets/:id` still returns 404 for them;
- a missing CSRF token → 403.

### Task 2: Portal UI

**Files:**
- Create: `apps/portal/src/pages/approvals/index.astro`
- Create: `apps/portal/src/components/portal/ApprovalsList.tsx`
- Create: `apps/portal/src/components/portal/ApprovalDecisionPanel.tsx`, modelled on the
  `QuoteDetailView.tsx` accept panel: the amount in words ("Approve up to 2 h 30 m more
  on ticket #1042"), a typed name, Approve and Deny, and an optional note.
- Modify: the portal nav, adding Approvals with a pending count.
- Modify: `TicketDetails.tsx`, adding a banner linking to the panel when the viewer can
  decide a pending request on that ticket.

Tests:
- the panel sends the `revision` it rendered;
- on 409 `REQUEST_CHANGED` it reloads and shows "This request was updated, please review again";
- a notify-only viewer sees no buttons.

### Task 3: Events and email

**Files:**
- Modify: `services/ticketEvents.ts`, adding real payloads for
  `ticket.approval_requested { requestId }` and
  `ticket.approval_decided { requestId, status }`.
- Modify: `jobs/ticketNotifyWorker.ts`:
  - New `case` arms that load the request in system context.
  - Send the approver email, which carries the portal Approvals deep link
    (`services/portalUrl.ts`), to `approver_emails`.
  - Send the informational email to `notify_emails`.
  - Use `renderPartnerEmail` template ids `ticket_approval_requested_approver`,
    `ticket_approval_requested_notify` and `ticket_approval_decided`. Register defaults
    wherever the existing ticket template ids are registered; locate them with
    `grep -rn "renderPartnerEmail(" apps/api/src/jobs/ticketNotifyWorker.ts`.
  - On a decision, write `user_notifications` rows for the ticket assignee and the
    request's `requested_by_user_id`.
  - When a request has no approvers, notify staff: "No approver on file".

Tests in `ticketNotifyWorker.test.ts`:
- approver and notify recipients get distinct templates;
- an empty approver list sends staff the in-app notice;
- a decided event notifies the assignee;
- partner template overrides apply.

---

# W05: clients, tools, docs

- **AI tools** (`services/aiToolsTicketing.ts`, `aiToolSchemas.ts`):
  - The `log_time_entry`, `start_timer` and `stop_timer` results include `approvalHold`,
    and the text says "Recorded; held pending customer approval (request …)".
  - `APPROVAL_REQUIRED` maps to a tool error that tells the model to log the entry as
    non-billable or ask a human to request approval.
  - Add read-only `get_ticket_approval_status`. Do not add any decide, budget or
    write-off tool.
  - Run the AI tool contract tests, and read memory `ai_tools_contract_tests_line_keyed_trap`
    first: `SAFE_WRITE_SITES` keys on line numbers.
  - Never use `z.undefined()` in a tool schema.
- **Office add-in** (`routes/officeAddin/time.ts`, `packages/shared/src/types/officeAddin.ts`):
  surface `approvalHold` and pass `409` through with its code.
- **Mobile** (`apps/mobile/src/screens/time/entryLock.ts`, `services/timeEntries.ts`,
  `timeEntryQueue.ts`):
  - Add the `awaiting_approval` label; held entries stay editable.
  - A `409 APPROVAL_REQUIRED` on a **start** shows "Approval required. Log as
    non-billable?". The offline replay of completed entries never sees it (W02 T3).
- **Docs:** add a page under `apps/docs` for ticket budgets and customer approval. Use
  the `update-breeze-docs` skill.
- Tests: the existing suites for each touched file, plus one new test per bullet above.

---

## Self-review (done at authoring)

- **Spec coverage.** Every spec section is covered:

  | Spec section | Plan location |
  |---|---|
  | §4.1 | W01 T2 |
  | §4.2–4.5 | W01 T3 |
  | §4.6 | W01 T4 |
  | §5.1–5.5 | W02 T1–T4 |
  | §5.6 | W02 T5 |
  | §5.7 | W02 T6 |
  | Expiry | W02 T7 |
  | §6.1 | W02 T2 |
  | §6.2 | W04 T1–T2 |
  | §6.3, §6.5, §7 | W03 |
  | §6.4 | W04 T3 |
  | AI/clients | W05 |

- **Types.** `GateTrigger`, `GateInput`, `GateResult`, `EffectiveTicketApprovalSettings`,
  `DecisionActor` and `approvalHold` are named identically wherever they are consumed.
- **Review Focus.** Each of the five items names its owning test.
- **Known judgement call left to the implementer.** The 15-minute rounding of auto
  extension requests (W02 T2) is a UX default and is not in the spec. If Todd objects,
  change the one constant `AUTO_EXTENSION_ROUND_MINUTES`.
