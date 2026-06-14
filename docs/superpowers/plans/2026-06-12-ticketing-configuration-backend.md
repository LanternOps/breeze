# Ticketing Configuration PR 1 — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend for partner-configurable ticketing: `ticket_statuses` (custom names mapped to core states), `ticket_priority_settings` (labels + SLA defaults), `org_ticket_settings` (per-org SLA tiers + billing defaults), `tickets.status_id`, the extended SLA/rate fallback chains, config routes, and decorations — per spec `docs/superpowers/specs/2026-06-12-ticketing-configuration-design.md` (D1–D8).

**Architecture:** `tickets.status` (core enum) remains the source of truth for ALL logic; `status_id` is display/selection state stamped alongside it. New `ticketConfigService` owns config CRUD; `resolveSlaTargets` stays pure and gains two chain links; `timeEntryService.resolveTicketLink` gains the org layer. RLS ships in the same migration as the tables.

**Tech Stack:** Hono, Drizzle, PostgreSQL RLS, Zod (shared validators), Vitest.

---

## Ground truth (verified 2026-06-12 — match these exactly)

- `TICKET_STATUS_TRANSITIONS` + `changeTicketStatus(ticketId, toStatus, opts, actor)` — `apps/api/src/services/ticketService.ts:14-21, ~300`. Transition validation, resolve-note requirement, pause-fold logic all key off core `TicketStatus`.
- `resolveSlaTargets({overrideResponseMinutes?, overrideResolutionMinutes?, categoryResponseMinutes?, categoryResolutionMinutes?, priority})` — pure, `apps/api/src/services/ticketSla.ts:32-38`; called once in `createTicket` (`ticketService.ts:219`) with category values.
- `PRIORITY_SLA_DEFAULTS` — `ticketSla.ts:13-18` (urgent 60/240, high 240/1440, normal/low null).
- Time-entry defaulting: `resolveTicketLink` (`timeEntryService.ts:110-128`) returns `{ticket, partnerId, defaultBillable, defaultHourlyRate}` from category via system-context reads (`getCategoryDefaults`).
- Partner bootstrap: `createPartner` in `apps/api/src/services/partnerCreate.ts:47` — single `db.transaction` inserting partner/roles/users/org/site; seed the six statuses inside this tx.
- Org-settings upsert precedent: `portal_branding` + `apps/api/src/routes/orgPortalSettings.ts` (lazy `portalSettingsColumns()` factory — module-scope Drizzle column derefs crash other routes' tests, #1251 lesson).
- `ticketCategories` schema shape to mirror: `apps/api/src/db/schema/tickets.ts:16-33`.
- Web default status labels (for seeding): New, Open, Pending, On Hold, Resolved, Closed (verify against `apps/web/src/components/tickets/ticketConfig.ts` statusConfig labels before hardcoding).
- Admin-proxy pattern: `hasPermission(perms,'*','*')` (`routes/timeEntries/timeEntries.ts:29-40` `timeActorFrom`).
- Migration conventions: CLAUDE.md (idempotent, date-named, no inner BEGIN/COMMIT, RAISE WARNING row counts on data fixes, RLS in same migration).

**Branch:** `feat/ticketing-config-backend`, fresh worktree from origin/main (worktrees need `pnpm install`; gitignored `.env`/`.env.test` are absent — rls/integration tests need them copied or run on the main checkout; prefix node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`).

---

### Task 1: Schema + migration

**Files:**
- Create: `apps/api/src/db/schema/ticketConfig.ts`
- Modify: `apps/api/src/db/schema/index.ts` (export the new file), `apps/api/src/db/schema/portal.ts` (tickets.status_id column)
- Create: `apps/api/migrations/2026-06-13-a-ticketing-configuration.sql`

- [ ] **Step 1: Drizzle schema** — `apps/api/src/db/schema/ticketConfig.ts`:

```ts
import {
  pgTable, uuid, varchar, integer, boolean, timestamp, numeric, jsonb,
  uniqueIndex, index
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners, organizations } from './orgs';
import { ticketStatusEnum, ticketPriorityEnum } from './portal';

export const ticketStatuses = pgTable('ticket_statuses', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 60 }).notNull(),
  coreStatus: ticketStatusEnum('core_status').notNull(),
  color: varchar('color', { length: 7 }),
  sortOrder: integer('sort_order').notNull().default(0),
  // The six seeded rows: renameable/recolorable, never deactivated/re-mapped/deleted.
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  index('ticket_statuses_partner_idx').on(t.partnerId),
  uniqueIndex('ticket_statuses_partner_name_uq').on(t.partnerId, sql`lower(${t.name})`)
]);

export const ticketPrioritySettings = pgTable('ticket_priority_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  priority: ticketPriorityEnum('priority').notNull(),
  label: varchar('label', { length: 40 }),
  responseSlaMinutes: integer('response_sla_minutes'),
  resolutionSlaMinutes: integer('resolution_sla_minutes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [uniqueIndex('ticket_priority_settings_partner_priority_uq').on(t.partnerId, t.priority)]);

export const orgTicketSettings = pgTable('org_ticket_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().unique().references(() => organizations.id, { onDelete: 'cascade' }),
  // { "<priority>": { "responseMinutes": n|null, "resolutionMinutes": n|null } } — shape owned by the shared Zod validator
  slaOverrides: jsonb('sla_overrides').notNull().default(sql`'{}'::jsonb`),
  defaultHourlyRate: numeric('default_hourly_rate', { precision: 10, scale: 2 }),
  defaultBillable: boolean('default_billable'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});
```

In `portal.ts`, on the `tickets` table add:
```ts
statusId: uuid('status_id'),  // FK + ON DELETE SET NULL added in SQL (ticketStatuses lives in a later module — avoid a circular import)
```
Export `ticketStatuses, ticketPrioritySettings, orgTicketSettings` from `schema/index.ts`.

- [ ] **Step 2: Migration** — `apps/api/migrations/2026-06-13-a-ticketing-configuration.sql`. Idempotent, no inner BEGIN/COMMIT, RLS + policies + backfills all here:

```sql
-- Ticketing configuration: custom statuses, priority SLA settings, org overrides.
-- Spec: docs/superpowers/specs/2026-06-12-ticketing-configuration-design.md

CREATE TABLE IF NOT EXISTS ticket_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(60) NOT NULL,
  core_status ticket_status NOT NULL,
  color varchar(7),
  sort_order integer NOT NULL DEFAULT 0,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_statuses_partner_idx ON ticket_statuses(partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_statuses_partner_name_uq ON ticket_statuses(partner_id, lower(name));

CREATE TABLE IF NOT EXISTS ticket_priority_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  priority ticket_priority NOT NULL,
  label varchar(40),
  response_sla_minutes integer,
  resolution_sla_minutes integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_priority_settings_partner_priority_uq ON ticket_priority_settings(partner_id, priority);

CREATE TABLE IF NOT EXISTS org_ticket_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  sla_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_hourly_rate numeric(10,2),
  default_billable boolean,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- RLS: partner-axis tables (shape 3) + org-axis table (shape 1). Same migration, never deferred.
ALTER TABLE ticket_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_statuses FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ticket_statuses' AND policyname = 'ticket_statuses_partner_access') THEN
    CREATE POLICY ticket_statuses_partner_access ON ticket_statuses
      USING (breeze_has_partner_access(partner_id))
      WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
END $$;

ALTER TABLE ticket_priority_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_priority_settings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ticket_priority_settings' AND policyname = 'ticket_priority_settings_partner_access') THEN
    CREATE POLICY ticket_priority_settings_partner_access ON ticket_priority_settings
      USING (breeze_has_partner_access(partner_id))
      WITH CHECK (breeze_has_partner_access(partner_id));
  END IF;
END $$;

ALTER TABLE org_ticket_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_ticket_settings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'org_ticket_settings' AND policyname = 'org_ticket_settings_org_access') THEN
    CREATE POLICY org_ticket_settings_org_access ON org_ticket_settings
      USING (breeze_has_org_access(org_id))
      WITH CHECK (breeze_has_org_access(org_id));
  END IF;
END $$;

-- tickets.status_id (display/selection state; tickets.status stays the logic source of truth)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status_id uuid;
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_status_id_fkey
    FOREIGN KEY (status_id) REFERENCES ticket_statuses(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS tickets_status_id_idx ON tickets(status_id);

-- Seed the six system statuses for every existing partner (idempotent via anti-join).
DO $$
DECLARE n integer;
BEGIN
  WITH defaults(core_status, name, sort_order) AS (
    VALUES ('new'::ticket_status, 'New', 0), ('open'::ticket_status, 'Open', 1),
           ('pending'::ticket_status, 'Pending', 2), ('on_hold'::ticket_status, 'On Hold', 3),
           ('resolved'::ticket_status, 'Resolved', 4), ('closed'::ticket_status, 'Closed', 5)
  ), ins AS (
    INSERT INTO ticket_statuses (partner_id, name, core_status, sort_order, is_system)
    SELECT p.id, d.name, d.core_status, d.sort_order, true
    FROM partners p CROSS JOIN defaults d
    WHERE NOT EXISTS (
      SELECT 1 FROM ticket_statuses ts
      WHERE ts.partner_id = p.id AND ts.is_system AND ts.core_status = d.core_status
    )
    RETURNING 1
  )
  SELECT count(*) INTO n FROM ins;
  IF n > 0 THEN RAISE WARNING 'seeded % system ticket statuses', n; END IF;
END $$;

-- Backfill tickets.status_id from the partner's system row for the ticket's core status.
DO $$
DECLARE n integer;
BEGIN
  UPDATE tickets t
  SET status_id = ts.id
  FROM ticket_statuses ts
  WHERE t.status_id IS NULL
    AND t.partner_id IS NOT NULL
    AND ts.partner_id = t.partner_id AND ts.is_system AND ts.core_status = t.status;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled status_id on % tickets', n; END IF;
END $$;
```

- [ ] **Step 3: Verify drift + migration apply**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
Expected: no drift. Then start the API once (or run any vitest.integration test) so autoMigrate applies it; re-apply must be a no-op (run twice).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/ apps/api/migrations/2026-06-13-a-ticketing-configuration.sql
git commit -m "feat(ticketing): config tables (statuses, priority settings, org overrides) + tickets.status_id"
```

---

### Task 2: Seed statuses in partner bootstrap

**Files:**
- Modify: `apps/api/src/services/partnerCreate.ts` (inside the existing `db.transaction`)
- Create/extend: `apps/api/src/services/ticketConfigService.ts` (just the seed helper + DEFAULT_STATUSES constant for now)
- Test: `apps/api/src/services/partnerCreate.test.ts` (extend existing if present, else create alongside)

- [ ] **Step 1: Failing test** — partner creation inserts six `ticket_statuses` rows (is_system, one per core state). Mirror the file's existing transaction-mock style; assert the insert values include all six core states with `isSystem: true`.

- [ ] **Step 2: Implement** — in `ticketConfigService.ts`:

```ts
import { ticketStatuses } from '../db/schema';

// Accepts the drizzle transaction object createPartner already threads around —
// read createPartner's tx parameter type and reuse it (do not invent a new one).
export const DEFAULT_STATUSES: ReadonlyArray<{ coreStatus: CoreTicketStatus; name: string; sortOrder: number }> = [
  { coreStatus: 'new', name: 'New', sortOrder: 0 },
  { coreStatus: 'open', name: 'Open', sortOrder: 1 },
  { coreStatus: 'pending', name: 'Pending', sortOrder: 2 },
  { coreStatus: 'on_hold', name: 'On Hold', sortOrder: 3 },
  { coreStatus: 'resolved', name: 'Resolved', sortOrder: 4 },
  { coreStatus: 'closed', name: 'Closed', sortOrder: 5 }
];

/** Seed the six system statuses for a new partner. Runs inside createPartner's transaction. */
export async function seedSystemTicketStatuses(tx: Pick<typeof Db, 'insert'>, partnerId: string): Promise<void> {
  await tx.insert(ticketStatuses).values(
    DEFAULT_STATUSES.map((d) => ({ partnerId, name: d.name, coreStatus: d.coreStatus, sortOrder: d.sortOrder, isSystem: true }))
  );
}
```
(`CoreTicketStatus` = re-export of `TicketStatus` from ticketService or derive from the enum; pick one and use it consistently across this PR.) Call `await seedSystemTicketStatuses(tx, partner.id);` inside `createPartner`'s transaction after the org insert.

- [ ] **Step 3: Tests green; commit** — `git commit -m "feat(ticketing): seed system statuses on partner create"`

---

### Task 3: SLA chain extension (pure) + createTicket wiring

**Files:**
- Modify: `apps/api/src/services/ticketSla.ts`, `apps/api/src/services/ticketSla.test.ts`
- Modify: `apps/api/src/services/ticketService.ts` (createTicket), `apps/api/src/services/ticketService.test.ts`
- Extend: `apps/api/src/services/ticketConfigService.ts` (config readers)

- [ ] **Step 1: Failing unit tests** in `ticketSla.test.ts` for the new chain (D7: override → category → org → partner → hardcoded):

```ts
describe('resolveSlaTargets chain (D7)', () => {
  it('category beats org override', () => {
    expect(resolveSlaTargets({ categoryResponseMinutes: 30, orgResponseMinutes: 120, priority: 'urgent' }).responseMinutes).toBe(30);
  });
  it('org override beats partner setting', () => {
    expect(resolveSlaTargets({ orgResponseMinutes: 120, partnerResponseMinutes: 90, priority: 'urgent' }).responseMinutes).toBe(120);
  });
  it('partner setting beats hardcoded default', () => {
    expect(resolveSlaTargets({ partnerResponseMinutes: 90, priority: 'urgent' }).responseMinutes).toBe(90);
  });
  it('falls through to hardcoded defaults', () => {
    expect(resolveSlaTargets({ priority: 'urgent' })).toEqual({ responseMinutes: 60, resolutionMinutes: 240 });
  });
  it('explicit ticket override still wins over everything', () => {
    expect(resolveSlaTargets({ overrideResponseMinutes: 5, categoryResponseMinutes: 30, orgResponseMinutes: 120, partnerResponseMinutes: 90, priority: 'low' }).responseMinutes).toBe(5);
  });
});
```

- [ ] **Step 2: Implement** in `ticketSla.ts` (stays pure — callers resolve the per-priority numbers):

```ts
export interface ResolveSlaTargetsInput {
  overrideResponseMinutes?: number | null;
  overrideResolutionMinutes?: number | null;
  categoryResponseMinutes?: number | null;
  categoryResolutionMinutes?: number | null;
  orgResponseMinutes?: number | null;       // org_ticket_settings.sla_overrides[priority]
  orgResolutionMinutes?: number | null;
  partnerResponseMinutes?: number | null;   // ticket_priority_settings row for this priority
  partnerResolutionMinutes?: number | null;
  priority: TicketSlaPriority;
}

/** D7 chain, per target: ticket override → category → org override → partner setting → hardcoded default. */
export function resolveSlaTargets(input: ResolveSlaTargetsInput): { responseMinutes: number | null; resolutionMinutes: number | null } {
  const defaults = PRIORITY_SLA_DEFAULTS[input.priority];
  return {
    responseMinutes: input.overrideResponseMinutes ?? input.categoryResponseMinutes
      ?? input.orgResponseMinutes ?? input.partnerResponseMinutes ?? defaults.responseMinutes,
    resolutionMinutes: input.overrideResolutionMinutes ?? input.categoryResolutionMinutes
      ?? input.orgResolutionMinutes ?? input.partnerResolutionMinutes ?? defaults.resolutionMinutes
  };
}
```
Update the file-top comment (the SQL-twins note) to mention the new chain links. **The worker/filter SQL twins do NOT change** — stamped `response_sla_minutes`/`resolution_sla_minutes` on the ticket row remain the worker's only inputs.

- [ ] **Step 3: Config readers** in `ticketConfigService.ts` (system DB context — #1243 lesson; lazy column factories — #1251 lesson):

```ts
/** Per-priority minutes from org_ticket_settings.sla_overrides, or nulls. System-context read. */
export async function getOrgSlaOverride(orgId: string, priority: TicketSlaPriority): Promise<{ responseMinutes: number | null; resolutionMinutes: number | null }>;
/** Per-priority minutes from ticket_priority_settings, or nulls. System-context read. */
export async function getPartnerPrioritySla(partnerId: string, priority: TicketSlaPriority): Promise<{ responseMinutes: number | null; resolutionMinutes: number | null }>;
```
Both: `runOutsideDbContext(() => withSystemDbAccessContext(...))` selects with `.limit(1)`, defensive jsonb parsing (treat malformed/missing keys as nulls — never throw on config reads).

- [ ] **Step 4: Wire createTicket** (`ticketService.ts:219` call site): fetch both (org via `input.orgId`, partner via `org.partnerId`) and pass into `resolveSlaTargets`. Also stamp `statusId` on insert: resolve the partner's system row for the initial core status (`'open'`/`'new'`) via a new `getSystemStatusId(partnerId, coreStatus)` reader (system context, nullable — a missing row degrades to NULL statusId, never throws). Feed the new selects in `ticketService.test.ts` mocks (the #1238 contract-test lesson: per-task runs pass but CI full-suite fails when mocks starve a new select — update ALL affected tests in this task).

- [ ] **Step 5: All green** — `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketSla.test.ts src/services/ticketService.test.ts src/routes/tickets/` then commit: `git commit -m "feat(ticketing): org + partner links in the SLA chain, statusId stamping at create"`

---

### Task 4: changeTicketStatus accepts statusId; decoration

**Files:**
- Modify: `apps/api/src/services/ticketService.ts`, tests
- Modify: `apps/api/src/routes/tickets/tickets.ts` (status route + list/detail decoration), tests
- Modify: `packages/shared/src/validators/tickets.ts` (+tests)

- [ ] **Step 1: Failing service tests**: (a) `changeTicketStatus` with `{statusId}` of a custom row mapped to `pending` validates the transition against core `pending`, stamps BOTH `status='pending'` and `status_id=<id>`; (b) cross-partner statusId → 404-style `TicketServiceError('STATUS_NOT_FOUND')`; (c) inactive status → rejected; (d) legacy core-value call path still works and stamps the system row's id; (e) feed comment `oldValue/newValue` remain CORE values, `content` carries the custom display name.

- [ ] **Step 2: Implement.** New signature (additive):

```ts
export interface ChangeStatusTarget { status?: TicketStatus; statusId?: string }  // exactly one
export async function changeTicketStatus(ticketId: string, target: ChangeStatusTarget, opts: ChangeStatusOptions, actor: TicketActor)
```
Resolution: `statusId` → load row (system context), require same-partner as ticket + `is_active`, derive `toStatus = row.coreStatus`; `status` → `toStatus` as today, `statusId = getSystemStatusId(partnerId, toStatus)`. Everything downstream (transition table, resolve-note rule, pause folding, CAS update) operates on `toStatus` unchanged; the update patch additionally sets `statusId`. Add `'STATUS_NOT_FOUND' | 'STATUS_INACTIVE'` to `TicketServiceErrorCode`. Existing callers (`routes`, bulk, AI tools, portal) compile unchanged by passing `{status: value}` — update each call site mechanically.

- [ ] **Step 3: Validator** — `changeTicketStatusSchema` gains optional `statusId: z.string().uuid()` with a refinement: exactly one of `status`/`statusId`; `resolutionNote` requirement keys off `status === 'resolved'` OR is deferred to the service when only `statusId` is given (service already throws — keep the Zod refinement for the `status` path only, and note the service is the enforcement point for `statusId`).

- [ ] **Step 4: Decoration** — list + detail responses in `routes/tickets/tickets.ts` gain `statusName`/`statusColor` via LEFT JOIN on `ticket_statuses` (additive, Phase 1b pattern). Portal ticket list/detail (`routes/portal/tickets.ts`) gains the same decoration. Feed the joins in route tests.

- [ ] **Step 5: All green; commit** — `git commit -m "feat(ticketing): changeTicketStatus by statusId + status decoration"`

---

### Task 5: Time-entry org defaults (D6)

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts` + tests

- [ ] **Step 1: Failing tests**: ticket-linked `createTimeEntry`/`startTimer` with (a) org row having `default_hourly_rate=150, default_billable=true` and category `default_hourly_rate=100` → entry stamps 150/true (org wins); (b) org row with nulls → category values win; (c) no org row → category (existing behavior, must not regress); (d) explicit input still wins over both.

- [ ] **Step 2: Implement** — add `getOrgBillingDefaults(orgId)` to `ticketConfigService.ts` (system context, returns `{defaultHourlyRate: string|null, defaultBillable: boolean|null}` or null). In `resolveTicketLink`:

```ts
const org = await getOrgBillingDefaults(ticket.orgId);
const category = ticket.categoryId ? await getCategoryDefaults(ticket.categoryId) : null;
return {
  ticket,
  partnerId: ticketPartnerId,
  // D6: per-entry override → org default → category default → false/null
  defaultBillable: org?.defaultBillable ?? category?.defaultBillable ?? false,
  defaultHourlyRate: org?.defaultHourlyRate ?? category?.defaultHourlyRate ?? null
};
```
Feed the new select in every `timeEntryService.test.ts` arrangement that exercises `resolveTicketLink` (and `routes/timeEntries`/`routes/tickets/parts` mocks if they starve — run those files).

- [ ] **Step 3: Green; commit** — `git commit -m "feat(ticketing): org billing defaults in time-entry chain (org wins)"`

---

### Task 6: ticketConfigService CRUD + routes + validators

**Files:**
- Extend: `apps/api/src/services/ticketConfigService.ts` + create `ticketConfigService.test.ts`
- Create: `apps/api/src/routes/ticketConfig.ts` + `ticketConfig.test.ts`; mount in `apps/api/src/index.ts`: `api.route('/ticket-config', ticketConfigRoutes)`
- Create: `apps/api/src/routes/orgTicketSettings.ts` + test; mount alongside `orgPortalSettings` (same hub/prefix — read how orgPortalSettings is mounted and mirror exactly, including MFA + audit middleware)
- Create: `packages/shared/src/validators/ticketConfig.ts` + `ticketConfig.test.ts`; export from the shared index

- [ ] **Step 1: Shared validators (write tests first in the same file pattern as `validators/timeEntries.test.ts`):**

```ts
import { z } from 'zod';

export const coreTicketStatusSchema = z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const slaMinutes = z.number().int().min(0).max(525_600).nullable();

export const createTicketStatusSchema = z.object({
  name: z.string().trim().min(1).max(60),
  coreStatus: coreTicketStatusSchema,
  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).optional()
});
export const updateTicketStatusSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  coreStatus: coreTicketStatusSchema.optional(),   // service rejects for is_system rows
  color: hexColor.nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
export const reorderTicketStatusesSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) })
  .refine((v) => new Set(v.ids).size === v.ids.length, { message: 'ids must be unique', path: ['ids'] });

export const prioritySettingsSchema = z.object({
  priorities: z.record(ticketPrioritySchema, z.object({
    label: z.string().trim().min(1).max(40).nullable().optional(),
    responseSlaMinutes: slaMinutes.optional(),
    resolutionSlaMinutes: slaMinutes.optional()
  }))
});

export const orgTicketSettingsSchema = z.object({
  slaOverrides: z.record(ticketPrioritySchema, z.object({
    responseMinutes: slaMinutes.optional(),
    resolutionMinutes: slaMinutes.optional()
  })).optional(),
  defaultHourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  defaultBillable: z.boolean().nullable().optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
```

- [ ] **Step 2: Service CRUD (TDD per function):** `getTicketConfig(partnerId)` (statuses ordered by sortOrder + the four priorities with effective labels/minutes); `createTicketStatus` (name-uniqueness 409 `STATUS_NAME_TAKEN`); `updateTicketStatus` (is_system: allow name/color/sortOrder, reject coreStatus change `SYSTEM_STATUS_IMMUTABLE` and `isActive:false` `SYSTEM_STATUS_REQUIRED`; non-system deactivate allowed — system rows guarantee the ≥1-active-per-core-state invariant); `reorderTicketStatuses` (bulk sortOrder=index, #1251 pattern); `upsertPrioritySettings` (lazy per-priority upsert via `onConflictDoUpdate` on the unique index); `getOrgTicketSettings`/`upsertOrgTicketSettings` (portal_branding upsert pattern). All writes scoped by the actor's partnerId in the WHERE (RLS is the backstop, not the only gate). New `TicketConfigServiceError` with `code` mirroring `TimeEntryServiceError`.

- [ ] **Step 3: Routes (TDD):**

| Route | Gate |
|---|---|
| `GET /ticket-config` | `requireScope('partner','system')` + `tickets:read` |
| `POST /ticket-config/statuses`, `PATCH /ticket-config/statuses/:id`, `POST /ticket-config/statuses/reorder`, `PUT /ticket-config/priorities` | scope + `tickets:write` + admin proxy (`hasPermission(perms,'*','*')` or `isPlatformAdmin` → else 403) |
| `GET/PATCH /orgs/organizations/:id/ticket-settings` | mirror orgPortalSettings exactly (org-write perm + MFA + audit log) |

Literal paths before `/:id`. `handleServiceError` pattern from `routes/timeEntries/timeEntries.ts:42`. Route tests: mocked-auth wiring-sensitive tests INCLUDING the no-auth 401 case (Phase 1a lesson: hub-level auth must be exercised).

- [ ] **Step 4: Green; commit** — `git commit -m "feat(ticketing): ticket-config service, routes, validators"`

---

### Task 7: AI tools — custom status names

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts` + tests

- [ ] **Step 1: Failing tests**: `manage_tickets` status-change action with `statusName: 'Waiting on vendor'` resolves the partner's row and calls `changeTicketStatus` with `{statusId}`; unknown name → error listing the partner's active status names; ambiguity impossible (name unique per partner). Core `status` values keep working.

- [ ] **Step 2: Implement**: add optional `statusName` string param to the tool schema (alongside the existing core-status enum param; keep the registered schema static — no dynamic enums). Resolution via a `findStatusByName(partnerId, name)` reader (case-insensitive). Tier/permission registrations unchanged (no new write actions — same `manage_tickets` action; verify `TIER` registration still routes status changes to the approval tier they have today, the tier-1-fallthrough lesson from #1276).

- [ ] **Step 3: Green; commit** — `git commit -m "feat(ticketing): AI status changes by custom status name"`

---

### Task 8: Integration tests (real driver) + rls-coverage allowlists

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (allowlists)
- Create: `apps/api/src/__tests__/integration/ticket-config-rls.integration.test.ts`

- [ ] **Step 1: Allowlists** — add `ticket_statuses`, `ticket_priority_settings` to `PARTNER_TENANT_TABLES`. `org_ticket_settings` has a direct `org_id` column → auto-discovered shape 1, no allowlist entry (verify the contract test passes without one).

- [ ] **Step 2: Functional RLS test** (the dual-axis blindspot lesson — prove the policy works for rows routes actually write, as `breeze_app`): two partners; partner A context can read/write own `ticket_statuses` rows; forged insert with partner B's id fails with `new row violates row-level security policy`; partner A cannot SELECT B's rows. Same shape for one `org_ticket_settings` cross-org case. Also: seeding idempotency (re-run migration seed block → 0 new rows), `changeTicketStatus` by statusId stamps both columns, cross-partner statusId rejected, SLA chain order end-to-end (create ticket with org override 120 + partner setting 90 + no category → stamped 120), time-entry org-rate-wins end-to-end.

- [ ] **Step 3: Run** — needs the real test DB: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/ticket-config-rls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts` (watch for the shared-5433-DB phantom-drift gotcha: other branches' applied migrations — heal by deleting the stray `breeze_migrations` row). audit_logs flakiness: clear via `session_replication_role=replica` DELETE if the rls suite trips on it.

- [ ] **Step 4: Commit** — `git commit -m "test(ticketing): config RLS functional + chain integration tests"`

---

### Task 9: Sweep + PR

- [ ] **Step 1: Sweep** — affected-files runs (full API suite has known parallel flakiness; verify affected single-fork, trust CI):
```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts src/services/ticketSla.test.ts src/services/timeEntryService.test.ts src/services/ticketConfigService.test.ts src/services/aiToolsTicketing.test.ts src/routes/tickets/ src/routes/timeEntries/ src/routes/ticketConfig.test.ts src/routes/orgTicketSettings.test.ts --pool=forks
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit   # only pre-existing agents.test.ts/apiKeyAuth.test.ts errors
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift
```
- [ ] **Step 2: PR** — title `feat(ticketing): configuration backend — custom statuses, priority SLA settings, org overrides`; body per the issue-comment style (bold leads, file:line, test counts); note D7 ordering decision + the flagged alternative; end with the generated-with footer. Two-stage review (pr-review-toolkit agents) before merge; `gh pr merge --squash --admin` once CI is green.
- [ ] **Step 3:** Frontend (PR 2: settings tabs, nav move, org tab, workbench select, decorations in web) gets its own plan against the merged API — do NOT start it from this plan.

---

## Self-review notes (spec coverage)

- §2 data model (3 tables + status_id + seeds/backfills + RLS) → Task 1, 2, 8
- §3 service layer (ticketConfigService, changeTicketStatus, SLA chain D7, time-entry D6, system-context reads) → Tasks 2–6
- §4 routes/validators/decoration/AI tools → Tasks 4, 6, 7
- §6 testing (route mocks fed, validator tests, functional RLS, chain integration) → every task + Task 8
- §5 frontend → explicitly deferred to PR 2's own plan (D8)
