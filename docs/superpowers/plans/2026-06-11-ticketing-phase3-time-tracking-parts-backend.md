# Ticketing Phase 3 — Time Tracking + Parts Backend (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase 3 backend: `time_entries` + `ticket_parts` tables, `timeEntryService`, technician routes (timers, timesheet, approval, parts, billables CSV), AI tool actions.

**Architecture:** Two new tenant-scoped tables (partner-axis `time_entries`, org-axis `ticket_parts`) with RLS in the creating migration. All business logic in `timeEntryService.ts` mirroring `ticketService.ts`; routes/AI tools are thin consumers. Lifecycle events through a new `timeEntryEvents.ts` (BullMQ, fire-and-forget, same pattern as `ticketEvents.ts`). Spec: `docs/superpowers/specs/2026-06-11-ticketing-phase3-time-tracking-parts-design.md`.

**Tech Stack:** Hono + Drizzle + Zod (`@breeze/shared` validators) + BullMQ + Vitest. PostgreSQL RLS via `breeze_has_partner_access` / `breeze_has_org_access`.

**Plan-level decisions (deltas/clarifications vs spec, decided here):**
- **Scope restriction:** all time-entry and parts routes are `requireScope('partner', 'system')` — org-scope users get 403. The spec's D4 (internal-only) already implies this; time_entries has no org-axis RLS policy so org-scope DB contexts couldn't read it anyway.
- **Admin check (D5's "partner-admin check"):** v1 proxy = role holds the wildcard permission: `hasPermission(c.get('permissions'), '*', '*')` (`services/permissions.ts:182-191` — only a literal `*`/`*` entry matches). Computed in routes, passed to the service as `actor.manageAll`.
- **Standalone `GET /time-entries` is NOT site-gated** (partner-internal data, no device axis); per-ticket subresources inherit `getScopedTicketOr404`'s site gate.
- **Migration filename:** `2026-06-12-a-ticketing-time-parts.sql` (bump the date/letter to the actual landing day if needed — never reuse a taken prefix).
- Tickets hub mounts at `/tickets` in `apps/api/src/index.ts`; the standalone time-entries hub mounts at `/time-entries`.

**Worktree:** create via superpowers:using-git-worktrees from `origin/main`, branch `feat/ticketing-time-parts-backend`. Run `pnpm install` in fresh worktrees, and prefix Node commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. First commit: this plan file + the spec (`git add docs/superpowers/specs/2026-06-11-ticketing-phase3-time-tracking-parts-design.md docs/superpowers/plans/2026-06-11-ticketing-phase3-time-tracking-parts-backend.md && git commit -m "docs: Phase 3 time tracking + parts spec and backend plan"`).

---

### Task 1: Schema + migration + RLS allowlist

**Files:**
- Create: `apps/api/src/db/schema/timeTracking.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add export)
- Create: `apps/api/migrations/2026-06-12-a-ticketing-time-parts.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (PARTNER_TENANT_TABLES entry)

- [ ] **Step 1: Create the Drizzle schema file**

Create `apps/api/src/db/schema/timeTracking.ts`:

```typescript
import {
  pgTable, uuid, text, varchar, integer, boolean, timestamp, numeric,
  pgEnum, uniqueIndex, index
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { tickets } from './portal';

export const billingStatusEnum = pgEnum('billing_status', ['not_billed', 'billed', 'no_charge', 'contract']);

// Standalone partner-axis table (spec §2 / parent spec §8a): supports technician
// timesheets and non-ticket work, not just ticket time. org_id is denormalized
// from the ticket at write time for filtering only — RLS axis is partner_id.
export const timeEntries = pgTable('time_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  orgId: uuid('org_id').references(() => organizations.id),
  ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  startedAt: timestamp('started_at').notNull(),
  endedAt: timestamp('ended_at'),
  durationMinutes: integer('duration_minutes'),
  description: text('description'),
  isBillable: boolean('is_billable').notNull().default(false),
  hourlyRate: numeric('hourly_rate', { precision: 10, scale: 2 }),
  billingStatus: billingStatusEnum('billing_status').notNull().default('not_billed'),
  isApproved: boolean('is_approved').notNull().default(false),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [
  // One running timer per user, DB-enforced (spec D3 backstop)
  uniqueIndex('time_entries_one_running_per_user_uq').on(t.userId).where(sqlIsRunning(t)),
  index('time_entries_partner_started_idx').on(t.partnerId, t.startedAt),
  index('time_entries_ticket_idx').on(t.ticketId),
  index('time_entries_user_started_idx').on(t.userId, t.startedAt)
]);

// Drizzle partial-index predicate helper (kept local; drizzle-kit only needs it
// for drift detection — the real index is created in the SQL migration).
import { sql, type SQL } from 'drizzle-orm';
function sqlIsRunning(t: { endedAt: unknown }): SQL {
  return sql`${t.endedAt} IS NULL`;
}

export const ticketParts = pgTable('ticket_parts', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  description: text('description').notNull(),
  partNumber: varchar('part_number', { length: 100 }),
  vendor: varchar('vendor', { length: 100 }),
  quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull(),
  unitPrice: numeric('unit_price', { precision: 10, scale: 2 }).notNull().default('0'),
  costBasis: numeric('cost_basis', { precision: 10, scale: 2 }),
  isBillable: boolean('is_billable').notNull().default(true),
  billingStatus: billingStatusEnum('billing_status').notNull().default('not_billed'),
  addedBy: uuid('added_by').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [index('ticket_parts_ticket_idx').on(t.ticketId)]);
```

Note: move the `import { sql, type SQL } from 'drizzle-orm';` line to the top of the file with the other imports (shown inline above only for reading order). If `pnpm db:check-drift` later complains about the partial-index expression, simplify to defining the unique index ONLY in SQL and keep a plain (non-unique) `index('time_entries_user_idx').on(t.userId)` in Drizzle — drift tolerance for partial indexes varies; the SQL migration is the source of truth.

- [ ] **Step 2: Export from the schema barrel**

In `apps/api/src/db/schema/index.ts`, after `export * from './tickets';` add:

```typescript
export * from './timeTracking';
```

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-06-12-a-ticketing-time-parts.sql` (idempotent; NO inner BEGIN/COMMIT — autoMigrate wraps the file):

```sql
-- Phase 3 (native ticketing): time_entries + ticket_parts
-- Spec: docs/superpowers/specs/2026-06-11-ticketing-phase3-time-tracking-parts-design.md

DO $$ BEGIN
  CREATE TYPE billing_status AS ENUM ('not_billed','billed','no_charge','contract');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  org_id UUID REFERENCES organizations(id),
  ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  duration_minutes INTEGER,
  description TEXT,
  is_billable BOOLEAN NOT NULL DEFAULT FALSE,
  hourly_rate NUMERIC(10,2),
  billing_status billing_status NOT NULL DEFAULT 'not_billed',
  is_approved BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  description TEXT NOT NULL,
  part_number VARCHAR(100),
  vendor VARCHAR(100),
  quantity NUMERIC(10,2) NOT NULL,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost_basis NUMERIC(10,2),
  is_billable BOOLEAN NOT NULL DEFAULT TRUE,
  billing_status billing_status NOT NULL DEFAULT 'not_billed',
  added_by UUID REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One running timer per user (spec D3): DB-level backstop for the
-- stop-then-start race in timeEntryService.startTimer.
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_running_per_user_uq
  ON time_entries (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS time_entries_partner_started_idx ON time_entries (partner_id, started_at);
CREATE INDEX IF NOT EXISTS time_entries_ticket_idx ON time_entries (ticket_id);
CREATE INDEX IF NOT EXISTS time_entries_user_started_idx ON time_entries (user_id, started_at);
CREATE INDEX IF NOT EXISTS ticket_parts_ticket_idx ON ticket_parts (ticket_id);

-- RLS: time_entries is partner-axis (Shape 3). Internal-only (spec D4):
-- deliberately NO org/portal policies.
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY time_entries_partner_access ON time_entries
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RLS: ticket_parts is org-axis (Shape 1, org_id denormalized from parent ticket).
ALTER TABLE ticket_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_parts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_parts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_parts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_parts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_parts;
CREATE POLICY breeze_org_isolation_select ON ticket_parts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ticket_parts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ticket_parts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ticket_parts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- updated_at triggers (same pattern as incidents / elevation_requests)
CREATE OR REPLACE FUNCTION update_time_entries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_time_entries_updated_at ON time_entries;
CREATE TRIGGER trg_time_entries_updated_at
  BEFORE UPDATE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION update_time_entries_updated_at();

DROP TRIGGER IF EXISTS trg_ticket_parts_updated_at ON ticket_parts;
CREATE TRIGGER trg_ticket_parts_updated_at
  BEFORE UPDATE ON ticket_parts
  FOR EACH ROW EXECUTE FUNCTION update_time_entries_updated_at();

-- Permissions: new time_entries resource (spec D5)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'time_entries' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('time_entries', 'read', 'View time entries and timesheets');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'time_entries' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('time_entries', 'write', 'Log and edit time entries');
  END IF;
END $$;

-- Grant time_entries perms to every role that already holds the matching
-- tickets perm (technician-shaped roles) — same propagation pattern as 2026-06-09-a.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'read'
JOIN permissions p2 ON p2.resource = 'time_entries' AND p2.action = 'read'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'tickets' AND p1.action = 'write'
JOIN permissions p2 ON p2.resource = 'time_entries' AND p2.action = 'write'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
```

- [ ] **Step 4: Add the RLS-coverage allowlist entry**

In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, extend `PARTNER_TENANT_TABLES` (around line 87):

```typescript
  ['partner_ticket_sequences', 'partner_id'],
  ['time_entries', 'partner_id'],
```

`ticket_parts` has an `org_id` column and is auto-discovered — no allowlist entry.

- [ ] **Step 5: Apply migration + drift check**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsx src/db/autoMigrate.ts 2>/dev/null || PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter=@breeze/api dev:migrate
```

If neither entrypoint exists, check how migrations run in dev: `grep -rn "autoMigrate" apps/api/src/index.ts apps/api/package.json` and use that path (autoMigrate runs on API boot — `docker compose up api` also applies it). Then:

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```

Expected: no drift. If the partial unique index reports drift, apply the fallback from Step 1 (plain Drizzle index, SQL owns the partial unique).

- [ ] **Step 6: Run the RLS coverage test (real DB required)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
```

Expected: PASS (3 pre-existing `approval_requests` Shape-6 failures are known-unrelated if they appear — see memory; do not fix here).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/timeTracking.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-06-12-a-ticketing-time-parts.sql apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(ticketing): time_entries + ticket_parts schema, RLS, permissions (Phase 3)"
```

---

### Task 2: Permission constants + catalog label

**Files:**
- Modify: `apps/api/src/services/permissions.ts` (PERMISSIONS object, ~line 263)
- Modify: `apps/api/src/routes/permissionsCatalog.ts` (RESOURCE_LABELS, ~line 9)

- [ ] **Step 1: Add PERMISSIONS entries**

In `apps/api/src/services/permissions.ts`, after the Tickets block (`TICKETS_WRITE`):

```typescript
  // Time entries (ticketing Phase 3)
  TIME_ENTRIES_READ: { resource: 'time_entries', action: 'read' },
  TIME_ENTRIES_WRITE: { resource: 'time_entries', action: 'write' },
```

- [ ] **Step 2: Add the catalog label**

In `apps/api/src/routes/permissionsCatalog.ts` RESOURCE_LABELS, after `tickets: 'Tickets',`:

```typescript
  time_entries: 'Time Entries',
```

- [ ] **Step 3: Run permission-adjacent tests**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/permissions.test.ts src/routes/permissionsCatalog.test.ts --pool=forks
```

Expected: PASS (if a catalog test snapshot-counts resources, update it to include the new entry).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/permissions.ts apps/api/src/routes/permissionsCatalog.ts
git commit -m "feat(ticketing): seed time_entries permission constants + catalog label"
```

---

### Task 3: Shared validators

**Files:**
- Create: `packages/shared/src/validators/timeEntries.ts`
- Create: `packages/shared/src/validators/timeEntries.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (barrel export)

- [ ] **Step 1: Write the failing validator tests**

Create `packages/shared/src/validators/timeEntries.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  createTimeEntrySchema, updateTimeEntrySchema, startTimerSchema,
  listTimeEntriesQuerySchema, bulkApproveSchema, ticketPartSchema,
  updateTicketPartSchema, billablesExportQuerySchema
} from './timeEntries';

const UUID = '3f2f1d8e-1111-4222-8333-444455556666';

describe('createTimeEntrySchema', () => {
  it('accepts a minimal manual entry', () => {
    const r = createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:30:00Z'
    });
    expect(r.success).toBe(true);
  });

  it('rejects endedAt <= startedAt', () => {
    expect(createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:30:00Z',
      endedAt: '2026-06-11T09:00:00Z'
    }).success).toBe(false);
    expect(createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:00:00Z'
    }).success).toBe(false);
  });

  it('rejects a negative hourlyRate', () => {
    expect(createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:30:00Z',
      hourlyRate: -5
    }).success).toBe(false);
  });

  it('rejects startedAt more than 5 minutes in the future', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const futureEnd = new Date(Date.now() + 40 * 60_000).toISOString();
    expect(createTimeEntrySchema.safeParse({ startedAt: future, endedAt: futureEnd }).success).toBe(false);
  });
});

describe('startTimerSchema', () => {
  it('accepts empty body and optional ticketId/description', () => {
    expect(startTimerSchema.safeParse({}).success).toBe(true);
    expect(startTimerSchema.safeParse({ ticketId: UUID, description: 'debugging' }).success).toBe(true);
  });
});

describe('listTimeEntriesQuerySchema', () => {
  it('coerces running flag and dates', () => {
    const r = listTimeEntriesQuerySchema.safeParse({ running: 'true', from: '2026-06-01', limit: '10' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.running).toBe(true);
      expect(r.data.limit).toBe(10);
    }
  });
});

describe('bulkApproveSchema', () => {
  it('requires 1-200 ids', () => {
    expect(bulkApproveSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(bulkApproveSchema.safeParse({ ids: [UUID] }).success).toBe(true);
  });
});

describe('ticketPartSchema', () => {
  it('accepts a minimal part', () => {
    expect(ticketPartSchema.safeParse({ description: 'SSD 1TB', quantity: 1 }).success).toBe(true);
  });
  it('rejects quantity <= 0 and negative prices', () => {
    expect(ticketPartSchema.safeParse({ description: 'x', quantity: 0 }).success).toBe(false);
    expect(ticketPartSchema.safeParse({ description: 'x', quantity: 1, unitPrice: -1 }).success).toBe(false);
    expect(ticketPartSchema.safeParse({ description: 'x', quantity: 1, costBasis: -1 }).success).toBe(false);
  });
});

describe('billablesExportQuerySchema', () => {
  it('requires from/to and rejects inverted ranges', () => {
    expect(billablesExportQuerySchema.safeParse({}).success).toBe(false);
    expect(billablesExportQuerySchema.safeParse({ from: '2026-06-01', to: '2026-06-30' }).success).toBe(true);
    expect(billablesExportQuerySchema.safeParse({ from: '2026-06-30', to: '2026-06-01' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/timeEntries.test.ts
```

Expected: FAIL — module `./timeEntries` not found.

- [ ] **Step 3: Implement the validators**

Create `packages/shared/src/validators/timeEntries.ts`:

```typescript
import { z } from 'zod';

export const billingStatusSchema = z.enum(['not_billed', 'billed', 'no_charge', 'contract']);
export type BillingStatus = z.infer<typeof billingStatusSchema>;

const CLOCK_SKEW_MS = 5 * 60_000;
const notFarFuture = (d: Date) => d.getTime() <= Date.now() + CLOCK_SKEW_MS;

export const createTimeEntrySchema = z.object({
  ticketId: z.string().uuid().optional(),
  startedAt: z.coerce.date().refine(notFarFuture, { message: 'startedAt cannot be in the future' }),
  endedAt: z.coerce.date(),
  description: z.string().max(10_000).optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  billingStatus: billingStatusSchema.optional()
}).refine((v) => v.endedAt.getTime() > v.startedAt.getTime(), {
  message: 'endedAt must be after startedAt',
  path: ['endedAt']
});

export const updateTimeEntrySchema = z.object({
  ticketId: z.string().uuid().nullable().optional(),
  startedAt: z.coerce.date().refine(notFarFuture, { message: 'startedAt cannot be in the future' }).optional(),
  endedAt: z.coerce.date().optional(),
  description: z.string().max(10_000).nullable().optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  billingStatus: billingStatusSchema.optional()
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

export const startTimerSchema = z.object({
  ticketId: z.string().uuid().optional(),
  description: z.string().max(10_000).optional()
});

export const stopTimerSchema = z.object({
  description: z.string().max(10_000).optional(),
  isBillable: z.boolean().optional()
});

export const listTimeEntriesQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  ticketId: z.string().uuid().optional(),
  orgId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  running: z.coerce.boolean().optional(),
  billingStatus: billingStatusSchema.optional(),
  approved: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export const bulkApproveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  approve: z.boolean().default(true)
});

export const timesheetQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  weekStart: z.coerce.date()
});

export const ticketPartSchema = z.object({
  description: z.string().min(1).max(2_000),
  partNumber: z.string().max(100).optional(),
  vendor: z.string().max(100).optional(),
  quantity: z.number().positive().multipleOf(0.01),
  unitPrice: z.number().nonnegative().multipleOf(0.01).default(0),
  costBasis: z.number().nonnegative().multipleOf(0.01).nullable().optional(),
  isBillable: z.boolean().optional(),
  billingStatus: billingStatusSchema.optional(),
  notes: z.string().max(10_000).optional()
});

export const updateTicketPartSchema = ticketPartSchema.partial().refine(
  (v) => Object.keys(v).length > 0,
  { message: 'At least one field is required' }
);

export const billablesExportQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  orgId: z.string().uuid().optional()
}).refine((v) => v.to.getTime() >= v.from.getTime(), { message: 'to must be on/after from', path: ['to'] });

export type CreateTimeEntryInput = z.infer<typeof createTimeEntrySchema>;
export type UpdateTimeEntryInput = z.infer<typeof updateTimeEntrySchema>;
export type TicketPartInput = z.infer<typeof ticketPartSchema>;
```

Note: `z.coerce.boolean()` treats any non-empty string (including `'false'`) as `true`. Query strings come from the API's own web client, which sends `running=true` only when set — acceptable. If `running=false` must work, swap to `z.enum(['true','false']).transform(v => v === 'true').optional()` — check how `listTicketsQuerySchema` handles booleans in `packages/shared/src/validators/tickets.ts` and match it.

- [ ] **Step 4: Barrel export**

In `packages/shared/src/validators/index.ts`, after `export * from './tickets';`:

```typescript
export * from './timeEntries';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/timeEntries.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/validators/timeEntries.ts packages/shared/src/validators/timeEntries.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(ticketing): time-entry and parts validators"
```

---

### Task 4: Lifecycle events — `timeEntryEvents.ts`

**Files:**
- Create: `apps/api/src/services/timeEntryEvents.ts`
- Create: `apps/api/src/services/timeEntryEvents.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/timeEntryEvents.test.ts` (mirror `ticketEvents.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addMock, captureExceptionMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  captureExceptionMock: vi.fn()
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({ add: addMock }))
}));
vi.mock('./queue', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../lib/sentry', () => ({ captureException: captureExceptionMock }));

import { emitTimeEntryEvent } from './timeEntryEvents';

describe('emitTimeEntryEvent', () => {
  beforeEach(() => {
    addMock.mockClear();
    captureExceptionMock.mockClear();
  });

  it('enqueues the event with its type as the job name', async () => {
    await emitTimeEntryEvent({
      type: 'time_entry.created',
      timeEntryId: 'te-1',
      partnerId: 'p-1',
      ticketId: 't-1',
      actorUserId: 'u-1',
      payload: { userId: 'u-1', durationMinutes: 30, isBillable: true }
    });
    expect(addMock).toHaveBeenCalledWith(
      'time_entry.created',
      expect.objectContaining({ timeEntryId: 'te-1', partnerId: 'p-1' }),
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('never throws to the caller when the queue is down', async () => {
    addMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(emitTimeEntryEvent({
      type: 'time_entry.approved',
      timeEntryId: 'te-2',
      partnerId: 'p-1',
      ticketId: null,
      actorUserId: 'u-9',
      payload: { ids: ['te-2'], approvedBy: 'u-9' }
    })).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
```

Before writing, confirm the exact mock module paths used by `apps/api/src/services/ticketEvents.test.ts` (the BullMQ connection helper and Sentry import paths) and copy them verbatim — the paths above (`./queue`, `../lib/sentry`) must match whatever `ticketEvents.ts` actually imports.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryEvents.test.ts --pool=forks
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/timeEntryEvents.ts` (copy `ticketEvents.ts` imports for Queue/connection/captureException verbatim):

```typescript
import { Queue } from 'bullmq';
import { getBullMQConnection } from './queue';      // match ticketEvents.ts import path
import { captureException } from '../lib/sentry';   // match ticketEvents.ts import path

export const TIME_ENTRY_EVENTS_QUEUE = 'time-entry-events';

interface TimeEntryEventEnvelope {
  timeEntryId: string;
  partnerId: string;
  ticketId: string | null;
  actorUserId?: string | null;
}

export type TimeEntryEvent = TimeEntryEventEnvelope & (
  | { type: 'time_entry.created'; payload: { userId: string; durationMinutes: number | null; isBillable: boolean } }
  | { type: 'time_entry.updated'; payload: { changed: string[] } }
  | { type: 'time_entry.deleted'; payload: { userId: string } }
  | { type: 'time_entry.approved'; payload: { ids: string[]; approvedBy: string } }
);

let queue: Queue | null = null;

export function getTimeEntryEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(TIME_ENTRY_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design (ticketEvents.ts pattern): a Redis outage must
// never fail the user-facing mutation that emitted the event.
export async function emitTimeEntryEvent(event: TimeEntryEvent): Promise<void> {
  try {
    await getTimeEntryEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 }
    });
  } catch (err) {
    console.error('[TimeEntryEvents] failed to enqueue', event.type, `timeEntryId=${event.timeEntryId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}
```

No consumer worker ships in this PR (no notifications are spec'd for time entries) — the queue exists so future workflow/billing consumers subscribe without service changes (§8a). If a queue with zero consumers accumulates jobs in Redis, `removeOnComplete`/`removeOnFail` caps bound it; verify how `TICKET_EVENTS_QUEUE` consumers register (jobs/ index) and leave a `// TODO(phase-billing)` comment is NOT needed — this is intentional, document it in the PR body instead.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryEvents.test.ts --pool=forks
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/timeEntryEvents.ts apps/api/src/services/timeEntryEvents.test.ts
git commit -m "feat(ticketing): time-entry lifecycle events (typed union + BullMQ emit)"
```

---

### Task 5: `timeEntryService.ts` — types, helpers, create, timers

**Files:**
- Create: `apps/api/src/services/timeEntryService.ts`
- Create: `apps/api/src/services/timeEntryService.test.ts`

**Service design notes (read before coding):**
- Request-path queries run inside `withDbAccessContext` (set up by auth middleware), so plain `db.select(...)` is already partner-scoped by RLS. Use `runOutsideDbContext(() => withSystemDbAccessContext(...))` ONLY for cross-boundary validation reads (ticket/category lookups), exactly like `ticketService.ts:100-162`.
- `TimeEntryActor.manageAll` is computed in the routes (wildcard-permission check) — the service trusts it.
- Money/numeric columns: Drizzle `numeric` reads as `string`, writes accept `string`. Validator gives `number` — convert with `.toFixed(2)` at the service boundary.

- [ ] **Step 1: Write the failing tests (create + timers)**

Create `apps/api/src/services/timeEntryService.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbMocks, emitMock } = vi.hoisted(() => {
  const dbMocks = {
    // queue of results for successive db.select()...where()/limit() terminals
    selectResults: [] as unknown[][],
    insertResult: [] as unknown[],
    updateResult: [] as unknown[],
    insertedValues: [] as Record<string, unknown>[],
    updateSetArgs: [] as Record<string, unknown>[]
  };
  return { dbMocks, emitMock: vi.fn() };
});

vi.mock('./timeEntryEvents', () => ({ emitTimeEntryEvent: emitMock }));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const result = dbMocks.selectResults.shift() ?? [];
          return {
            limit: vi.fn(() => Promise.resolve(result)),
            orderBy: vi.fn(() => Promise.resolve(result)),
            then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
              Promise.resolve(result).then(res, rej)
          };
        }),
        leftJoin: vi.fn(() => ({
          where: vi.fn(() => {
            const result = dbMocks.selectResults.shift() ?? [];
            return {
              limit: vi.fn(() => Promise.resolve(result)),
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => Promise.resolve(result)) }))
              })),
              then: (res: (v: unknown) => unknown, rej: (e?: unknown) => unknown) =>
                Promise.resolve(result).then(res, rej)
            };
          })
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.insertedValues.push(vals);
        return { returning: vi.fn(() => Promise.resolve(dbMocks.insertResult)) };
      })
    })),
    update: vi.fn(() => ({
      set: vi.fn((vals: Record<string, unknown>) => {
        dbMocks.updateSetArgs.push(vals);
        return { where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(dbMocks.updateResult)) })) };
      })
    }))
  }
}));

vi.mock('../db/schema', () => ({
  timeEntries: {
    id: 'id', partnerId: 'partnerId', orgId: 'orgId', ticketId: 'ticketId',
    userId: 'userId', startedAt: 'startedAt', endedAt: 'endedAt',
    durationMinutes: 'durationMinutes', description: 'description',
    isBillable: 'isBillable', hourlyRate: 'hourlyRate', billingStatus: 'billingStatus',
    isApproved: 'isApproved', approvedBy: 'approvedBy', approvedAt: 'approvedAt',
    createdAt: 'createdAt', updatedAt: 'updatedAt'
  },
  ticketParts: {
    id: 'id', ticketId: 'ticketId', orgId: 'orgId', description: 'description',
    quantity: 'quantity', unitPrice: 'unitPrice', costBasis: 'costBasis',
    isBillable: 'isBillable', billingStatus: 'billingStatus', addedBy: 'addedBy'
  },
  tickets: { id: 'id', partnerId: 'partnerId', orgId: 'orgId', categoryId: 'categoryId', internalNumber: 'internalNumber', subject: 'subject' },
  ticketCategories: { id: 'id', partnerId: 'partnerId', defaultBillable: 'defaultBillable', defaultHourlyRate: 'defaultHourlyRate' },
  organizations: { id: 'id', partnerId: 'partnerId', name: 'name' },
  users: { id: 'id', name: 'name' }
}));

import {
  computeDurationMinutes, createTimeEntry, startTimer, stopTimer,
  TimeEntryServiceError
} from './timeEntryService';

const ACTOR = { userId: 'u-1', name: 'Tess', partnerId: 'p-1', manageAll: false };
const ADMIN = { ...ACTOR, userId: 'u-admin', manageAll: true };

beforeEach(() => {
  dbMocks.selectResults.length = 0;
  dbMocks.insertedValues.length = 0;
  dbMocks.updateSetArgs.length = 0;
  dbMocks.insertResult = [];
  dbMocks.updateResult = [];
  emitMock.mockClear();
});

describe('computeDurationMinutes', () => {
  it('floors to whole minutes', () => {
    expect(computeDurationMinutes(new Date('2026-06-11T09:00:00Z'), new Date('2026-06-11T09:30:59Z'))).toBe(30);
    expect(computeDurationMinutes(new Date('2026-06-11T09:00:00Z'), new Date('2026-06-11T09:00:30Z'))).toBe(0);
  });
});

describe('createTimeEntry', () => {
  it('rejects a ticket from another partner', async () => {
    // 1st system read: the ticket
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-OTHER', orgId: 'o-1', categoryId: null }]);
    await expect(createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      ACTOR
    )).rejects.toMatchObject({ code: 'TICKET_WRONG_PARTNER', status: 400 });
  });

  it('defaults billable + rate from the ticket category (D2) and denormalizes org_id', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00' }]);
    dbMocks.insertResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: 't-1', userId: 'u-1', durationMinutes: 30, isBillable: true }];
    const entry = await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z') },
      ACTOR
    );
    expect(entry.id).toBe('te-1');
    const vals = dbMocks.insertedValues[0];
    expect(vals.orgId).toBe('o-1');
    expect(vals.isBillable).toBe(true);
    expect(vals.hourlyRate).toBe('125.00');
    expect(vals.durationMinutes).toBe(30);
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.created' }));
  });

  it('explicit isBillable/hourlyRate override category defaults', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: true, defaultHourlyRate: '125.00' }]);
    dbMocks.insertResult = [{ id: 'te-1' }];
    await createTimeEntry(
      { ticketId: 't-1', startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'), isBillable: false, hourlyRate: 80 },
      ACTOR
    );
    const vals = dbMocks.insertedValues[0];
    expect(vals.isBillable).toBe(false);
    expect(vals.hourlyRate).toBe('80.00');
  });

  it('non-ticket entry: org null, rate null, not billable by default', async () => {
    dbMocks.insertResult = [{ id: 'te-2' }];
    await createTimeEntry(
      { startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T10:00:00Z'), description: 'internal maintenance' },
      ACTOR
    );
    const vals = dbMocks.insertedValues[0];
    expect(vals.orgId).toBeNull();
    expect(vals.ticketId).toBeNull();
    expect(vals.hourlyRate).toBeNull();
    expect(vals.isBillable).toBe(false);
    expect(vals.durationMinutes).toBe(60);
  });

  it('requires a resolvable partner', async () => {
    await expect(createTimeEntry(
      { startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T10:00:00Z') },
      { ...ACTOR, partnerId: null }
    )).rejects.toMatchObject({ code: 'PARTNER_UNRESOLVABLE' });
  });
});

describe('startTimer / stopTimer', () => {
  it('startTimer stops the running entry first (D3) then inserts a running row', async () => {
    // update(...).returning() = the previously-running entry being stopped
    dbMocks.updateResult = [{ id: 'te-old', startedAt: new Date('2026-06-11T08:00:00Z') }];
    dbMocks.insertResult = [{ id: 'te-new', endedAt: null }];
    const entry = await startTimer({ description: 'on it' }, ACTOR);
    expect(entry.id).toBe('te-new');
    const vals = dbMocks.insertedValues[0];
    expect(vals.endedAt).toBeNull();
    expect(vals.durationMinutes).toBeNull();
  });

  it('stopTimer errors with NO_RUNNING_TIMER when nothing is running', async () => {
    dbMocks.updateResult = []; // CAS update matched no rows
    await expect(stopTimer({}, ACTOR)).rejects.toMatchObject({ code: 'NO_RUNNING_TIMER', status: 404 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryService.test.ts --pool=forks
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service (part 1)**

Create `apps/api/src/services/timeEntryService.ts`:

```typescript
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { timeEntries, ticketParts, tickets, ticketCategories, organizations } from '../db/schema';
import { emitTimeEntryEvent } from './timeEntryEvents';
import type { CreateTimeEntryInput, UpdateTimeEntryInput, TicketPartInput } from '@breeze/shared';

export type TimeEntryServiceErrorCode =
  | 'TICKET_NOT_FOUND'
  | 'TICKET_WRONG_PARTNER'
  | 'ENTRY_NOT_FOUND'
  | 'PART_NOT_FOUND'
  | 'NOT_OWN_ENTRY'
  | 'ADMIN_REQUIRED'
  | 'APPROVED_IMMUTABLE'
  | 'NO_RUNNING_TIMER'
  | 'ENTRY_RUNNING'
  | 'PARTNER_UNRESOLVABLE'
  | 'INVALID_RANGE';

export class TimeEntryServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 = 400,
    public code?: TimeEntryServiceErrorCode
  ) {
    super(message);
    this.name = 'TimeEntryServiceError';
  }
}

export interface TimeEntryActor {
  userId: string;
  name?: string;
  email?: string;
  /** auth.partnerId — null only for system scope */
  partnerId: string | null;
  /** wildcard-permission holders (computed in routes): may manage others' entries + approve */
  manageAll: boolean;
}

/** Floored whole minutes — matches the SLA pause-folding convention. */
export function computeDurationMinutes(startedAt: Date, endedAt: Date): number {
  return Math.floor((endedAt.getTime() - startedAt.getTime()) / 60_000);
}

const toRate = (rate: number | null | undefined): string | null =>
  rate == null ? null : rate.toFixed(2);

interface TicketForTimeTracking {
  id: string;
  partnerId: string | null;
  orgId: string;
  categoryId: string | null;
}

// System-context read: org-scoped RLS would hide cross-boundary rows during
// validation (ticketService.ts / PR #1243 lesson).
async function getTicketForTimeTracking(ticketId: string): Promise<TicketForTimeTracking> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: tickets.id, partnerId: tickets.partnerId, orgId: tickets.orgId, categoryId: tickets.categoryId })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .limit(1)
    )
  );
  const ticket = rows[0];
  if (!ticket) throw new TimeEntryServiceError('Ticket not found', 404, 'TICKET_NOT_FOUND');
  return ticket;
}

async function resolveTicketPartner(ticket: TicketForTimeTracking): Promise<string | null> {
  if (ticket.partnerId) return ticket.partnerId;
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, ticket.orgId))
        .limit(1)
    )
  );
  return rows[0]?.partnerId ?? null;
}

async function getCategoryDefaults(categoryId: string): Promise<{ defaultBillable: boolean; defaultHourlyRate: string | null } | null> {
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          id: ticketCategories.id,
          partnerId: ticketCategories.partnerId,
          defaultBillable: ticketCategories.defaultBillable,
          defaultHourlyRate: ticketCategories.defaultHourlyRate
        })
        .from(ticketCategories)
        .where(eq(ticketCategories.id, categoryId))
        .limit(1)
    )
  );
  return rows[0] ?? null;
}

/**
 * Validates a ticket link for the acting partner and resolves billing defaults
 * (spec D2: category default + manual override). Returns the denormalization
 * payload for the time-entry/part row.
 */
async function resolveTicketLink(ticketId: string, actorPartnerId: string | null) {
  const ticket = await getTicketForTimeTracking(ticketId);
  const ticketPartnerId = await resolveTicketPartner(ticket);
  if (!ticketPartnerId) {
    throw new TimeEntryServiceError('Ticket partner is unresolvable', 400, 'PARTNER_UNRESOLVABLE');
  }
  if (actorPartnerId && ticketPartnerId !== actorPartnerId) {
    throw new TimeEntryServiceError('Ticket must belong to the same partner', 400, 'TICKET_WRONG_PARTNER');
  }
  const category = ticket.categoryId ? await getCategoryDefaults(ticket.categoryId) : null;
  return {
    ticket,
    partnerId: ticketPartnerId,
    defaultBillable: category?.defaultBillable ?? false,
    defaultHourlyRate: category?.defaultHourlyRate ?? null
  };
}

export async function createTimeEntry(input: CreateTimeEntryInput, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;

  if (input.ticketId) {
    const link = await resolveTicketLink(input.ticketId, actor.partnerId);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }

  const rows = await db
    .insert(timeEntries)
    .values({
      partnerId,
      orgId,
      ticketId: input.ticketId ?? null,
      userId: actor.userId,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMinutes: computeDurationMinutes(input.startedAt, input.endedAt),
      description: input.description ?? null,
      isBillable: input.isBillable ?? defaultBillable,
      hourlyRate: input.hourlyRate !== undefined ? toRate(input.hourlyRate) : defaultRate,
      billingStatus: input.billingStatus ?? 'not_billed'
    })
    .returning();
  const entry = rows[0];

  await emitTimeEntryEvent({
    type: 'time_entry.created',
    timeEntryId: entry.id,
    partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: { userId: actor.userId, durationMinutes: entry.durationMinutes, isBillable: entry.isBillable }
  });
  return entry;
}

/** Stops the actor's running entry if any. Returns the stopped row or null. */
async function stopRunningEntry(actor: TimeEntryActor, overrides: { description?: string; isBillable?: boolean } = {}) {
  const now = new Date();
  // CAS on ended_at IS NULL: two concurrent stops -> one winner, one no-op.
  const rows = await db
    .update(timeEntries)
    .set({
      endedAt: now,
      // floor(extract(epoch ...)/60) — duration computed in SQL from the row's own started_at
      durationMinutes: sql`FLOOR(EXTRACT(EPOCH FROM (${now.toISOString()}::timestamp - ${timeEntries.startedAt})) / 60)::int`,
      ...(overrides.description !== undefined ? { description: overrides.description } : {}),
      ...(overrides.isBillable !== undefined ? { isBillable: overrides.isBillable } : {})
    })
    .where(and(eq(timeEntries.userId, actor.userId), isNull(timeEntries.endedAt)))
    .returning();
  return rows[0] ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export async function startTimer(input: { ticketId?: string; description?: string }, actor: TimeEntryActor) {
  let partnerId = actor.partnerId;
  let orgId: string | null = null;
  let defaultBillable = false;
  let defaultRate: string | null = null;

  if (input.ticketId) {
    const link = await resolveTicketLink(input.ticketId, actor.partnerId);
    partnerId = link.partnerId;
    orgId = link.ticket.orgId;
    defaultBillable = link.defaultBillable;
    defaultRate = link.defaultHourlyRate;
  }
  if (!partnerId) {
    throw new TimeEntryServiceError('Partner is unresolvable for this entry', 400, 'PARTNER_UNRESOLVABLE');
  }

  const attempt = async () => {
    // D3: auto-stop the previous timer, then start the new one. The partial
    // unique index time_entries_one_running_per_user_uq is the race backstop.
    await stopRunningEntry(actor);
    const rows = await db
      .insert(timeEntries)
      .values({
        partnerId: partnerId!,
        orgId,
        ticketId: input.ticketId ?? null,
        userId: actor.userId,
        startedAt: new Date(),
        endedAt: null,
        durationMinutes: null,
        description: input.description ?? null,
        isBillable: defaultBillable,
        hourlyRate: defaultRate,
        billingStatus: 'not_billed'
      })
      .returning();
    return rows[0];
  };

  let entry;
  try {
    entry = await attempt();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    entry = await attempt(); // lost the race: another start slipped in — stop it and retry once
  }

  await emitTimeEntryEvent({
    type: 'time_entry.created',
    timeEntryId: entry.id,
    partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: { userId: actor.userId, durationMinutes: null, isBillable: entry.isBillable }
  });
  return entry;
}

export async function stopTimer(input: { description?: string; isBillable?: boolean }, actor: TimeEntryActor) {
  const stopped = await stopRunningEntry(actor, input);
  if (!stopped) {
    throw new TimeEntryServiceError('No running timer', 404, 'NO_RUNNING_TIMER');
  }
  await emitTimeEntryEvent({
    type: 'time_entry.updated',
    timeEntryId: stopped.id,
    partnerId: stopped.partnerId,
    ticketId: stopped.ticketId,
    actorUserId: actor.userId,
    payload: { changed: ['endedAt', 'durationMinutes'] }
  });
  return stopped;
}
```

Implementation caveat for the SQL duration expression in `stopRunningEntry`: verify the generated SQL with the real driver in the Task 13 integration test; if parameter typing fights you, the simpler portable form is to first `select` the running row, then `update` by `id` with `durationMinutes: computeDurationMinutes(row.startedAt, now)` and `where(and(eq(timeEntries.id, row.id), isNull(timeEntries.endedAt)))` (still CAS-safe). Prefer whichever passes the integration test cleanly — both satisfy D3.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryService.test.ts --pool=forks
```

Expected: PASS. (If the mock's update-chain shape doesn't match the select-then-update fallback, adjust the mock — the contract being tested is D2 defaults, D3 stop-then-start, and the error codes.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts
git commit -m "feat(ticketing): timeEntryService — create + timer start/stop with category defaults"
```

---

### Task 6: `timeEntryService.ts` — update/delete, approval, queries, parts

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts`
- Modify: `apps/api/src/services/timeEntryService.test.ts`

- [ ] **Step 1: Write the failing tests (append to `timeEntryService.test.ts`)**

```typescript
import {
  updateTimeEntry, deleteTimeEntry, approveTimeEntries,
  addTicketPart
} from './timeEntryService';

describe('updateTimeEntry — own-vs-all + approval semantics (D5)', () => {
  const baseEntry = {
    id: 'te-1', partnerId: 'p-1', orgId: null, ticketId: null, userId: 'u-1',
    startedAt: new Date('2026-06-11T09:00:00Z'), endedAt: new Date('2026-06-11T09:30:00Z'),
    durationMinutes: 30, isApproved: false
  };

  it("403s when a non-admin edits someone else's entry", async () => {
    dbMocks.selectResults.push([{ ...baseEntry, userId: 'u-OTHER' }]);
    await expect(updateTimeEntry('te-1', { description: 'x' }, ACTOR))
      .rejects.toMatchObject({ code: 'NOT_OWN_ENTRY', status: 403 });
  });

  it('403s when a non-admin edits an approved entry', async () => {
    dbMocks.selectResults.push([{ ...baseEntry, isApproved: true }]);
    await expect(updateTimeEntry('te-1', { description: 'x' }, ACTOR))
      .rejects.toMatchObject({ code: 'APPROVED_IMMUTABLE', status: 403 });
  });

  it('any edit clears approval (even by an approver)', async () => {
    dbMocks.selectResults.push([{ ...baseEntry, isApproved: true }]);
    dbMocks.updateResult = [{ ...baseEntry, description: 'fixed' }];
    await updateTimeEntry('te-1', { description: 'fixed' }, ADMIN);
    const setArgs = dbMocks.updateSetArgs.at(-1)!;
    expect(setArgs.isApproved).toBe(false);
    expect(setArgs.approvedBy).toBeNull();
    expect(setArgs.approvedAt).toBeNull();
  });

  it('recomputes duration when the range changes', async () => {
    dbMocks.selectResults.push([baseEntry]);
    dbMocks.updateResult = [baseEntry];
    await updateTimeEntry('te-1', { endedAt: new Date('2026-06-11T10:00:00Z') }, ACTOR);
    expect(dbMocks.updateSetArgs.at(-1)!.durationMinutes).toBe(60);
  });

  it('rejects an update producing endedAt <= startedAt', async () => {
    dbMocks.selectResults.push([baseEntry]);
    await expect(updateTimeEntry('te-1', { endedAt: new Date('2026-06-11T08:00:00Z') }, ACTOR))
      .rejects.toMatchObject({ code: 'INVALID_RANGE' });
  });

  it('relinking to a ticket re-validates partner and re-denormalizes org', async () => {
    dbMocks.selectResults.push([baseEntry]); // the entry
    dbMocks.selectResults.push([{ id: 't-9', partnerId: 'p-1', orgId: 'o-9', categoryId: null }]); // ticket (system read)
    dbMocks.updateResult = [baseEntry];
    await updateTimeEntry('te-1', { ticketId: 't-9' }, ACTOR);
    const setArgs = dbMocks.updateSetArgs.at(-1)!;
    expect(setArgs.ticketId).toBe('t-9');
    expect(setArgs.orgId).toBe('o-9');
  });
});

describe('deleteTimeEntry', () => {
  it("403s for someone else's entry without manageAll", async () => {
    dbMocks.selectResults.push([{ id: 'te-1', userId: 'u-OTHER', isApproved: false, partnerId: 'p-1', ticketId: null }]);
    await expect(deleteTimeEntry('te-1', ACTOR)).rejects.toMatchObject({ code: 'NOT_OWN_ENTRY' });
  });
  it('403s for an approved entry without manageAll', async () => {
    dbMocks.selectResults.push([{ id: 'te-1', userId: 'u-1', isApproved: true, partnerId: 'p-1', ticketId: null }]);
    await expect(deleteTimeEntry('te-1', ACTOR)).rejects.toMatchObject({ code: 'APPROVED_IMMUTABLE' });
  });
});

describe('approveTimeEntries', () => {
  it('requires manageAll', async () => {
    await expect(approveTimeEntries(['te-1'], true, ACTOR)).rejects.toMatchObject({ code: 'ADMIN_REQUIRED', status: 403 });
  });

  it('skips running and missing entries with reasons', async () => {
    dbMocks.selectResults.push([
      { id: 'te-1', endedAt: new Date(), partnerId: 'p-1', ticketId: null },
      { id: 'te-2', endedAt: null, partnerId: 'p-1', ticketId: null } // running
    ]); // te-3 missing
    dbMocks.updateResult = [{ id: 'te-1', partnerId: 'p-1', ticketId: null }];
    const result = await approveTimeEntries(['te-1', 'te-2', 'te-3'], true, ADMIN);
    expect(result.updated).toBe(1);
    expect(result.skippedReasons).toEqual({ ENTRY_RUNNING: 1, ENTRY_NOT_FOUND: 1 });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'time_entry.approved' }));
  });
});

describe('addTicketPart', () => {
  it('denormalizes org_id and defaults billable from category', async () => {
    dbMocks.selectResults.push([{ id: 't-1', partnerId: 'p-1', orgId: 'o-1', categoryId: 'cat-1' }]);
    dbMocks.selectResults.push([{ id: 'cat-1', partnerId: 'p-1', defaultBillable: false, defaultHourlyRate: null }]);
    dbMocks.insertResult = [{ id: 'part-1' }];
    await addTicketPart('t-1', { description: 'SSD 1TB', quantity: 1, unitPrice: 120 }, ACTOR);
    const vals = dbMocks.insertedValues.at(-1)!;
    expect(vals.orgId).toBe('o-1');
    expect(vals.isBillable).toBe(false);
    expect(vals.unitPrice).toBe('120.00');
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryService.test.ts --pool=forks
```

Expected: new tests FAIL (functions not exported); Task 5 tests still PASS.

- [ ] **Step 3: Implement (append to `timeEntryService.ts`)**

```typescript
async function getEntryOr404(id: string) {
  // RLS (partner-axis) scopes this read in the request context.
  const rows = await db.select().from(timeEntries).where(eq(timeEntries.id, id)).limit(1);
  const entry = rows[0];
  if (!entry) throw new TimeEntryServiceError('Time entry not found', 404, 'ENTRY_NOT_FOUND');
  return entry;
}

function assertCanMutate(entry: { userId: string; isApproved: boolean }, actor: TimeEntryActor) {
  if (entry.userId !== actor.userId && !actor.manageAll) {
    throw new TimeEntryServiceError('You can only manage your own time entries', 403, 'NOT_OWN_ENTRY');
  }
  if (entry.isApproved && !actor.manageAll) {
    throw new TimeEntryServiceError('Approved entries can only be changed by an approver', 403, 'APPROVED_IMMUTABLE');
  }
}

export async function updateTimeEntry(id: string, input: UpdateTimeEntryInput, actor: TimeEntryActor) {
  const entry = await getEntryOr404(id);
  assertCanMutate(entry, actor);

  const startedAt = input.startedAt ?? entry.startedAt;
  const endedAt = input.endedAt !== undefined ? input.endedAt : entry.endedAt;
  if (endedAt && endedAt.getTime() <= startedAt.getTime()) {
    throw new TimeEntryServiceError('endedAt must be after startedAt', 400, 'INVALID_RANGE');
  }

  const set: Record<string, unknown> = {};
  const changed: string[] = [];
  if (input.startedAt !== undefined) { set.startedAt = input.startedAt; changed.push('startedAt'); }
  if (input.endedAt !== undefined) { set.endedAt = input.endedAt; changed.push('endedAt'); }
  if (input.description !== undefined) { set.description = input.description; changed.push('description'); }
  if (input.isBillable !== undefined) { set.isBillable = input.isBillable; changed.push('isBillable'); }
  if (input.hourlyRate !== undefined) { set.hourlyRate = toRate(input.hourlyRate); changed.push('hourlyRate'); }
  if (input.billingStatus !== undefined) { set.billingStatus = input.billingStatus; changed.push('billingStatus'); }

  if (input.ticketId !== undefined) {
    if (input.ticketId === null) {
      set.ticketId = null;
      set.orgId = null;
    } else {
      const link = await resolveTicketLink(input.ticketId, actor.partnerId);
      set.ticketId = input.ticketId;
      set.orgId = link.ticket.orgId;
    }
    changed.push('ticketId');
  }
  if ((input.startedAt !== undefined || input.endedAt !== undefined) && endedAt) {
    set.durationMinutes = computeDurationMinutes(startedAt, endedAt);
    changed.push('durationMinutes');
  }

  // Spec D1: any edit clears approval — re-approval required, including for approvers.
  set.isApproved = false;
  set.approvedBy = null;
  set.approvedAt = null;

  const rows = await db.update(timeEntries).set(set).where(eq(timeEntries.id, id)).returning();
  const updated = rows[0] ?? entry;

  await emitTimeEntryEvent({
    type: 'time_entry.updated',
    timeEntryId: id,
    partnerId: entry.partnerId,
    ticketId: updated.ticketId ?? entry.ticketId,
    actorUserId: actor.userId,
    payload: { changed }
  });
  return updated;
}

export async function deleteTimeEntry(id: string, actor: TimeEntryActor) {
  const entry = await getEntryOr404(id);
  assertCanMutate(entry, actor);
  await db.delete(timeEntries).where(eq(timeEntries.id, id));
  await emitTimeEntryEvent({
    type: 'time_entry.deleted',
    timeEntryId: id,
    partnerId: entry.partnerId,
    ticketId: entry.ticketId,
    actorUserId: actor.userId,
    payload: { userId: entry.userId }
  });
}

export interface BulkApproveResult {
  updated: number;
  skipped: number;
  skippedReasons: Record<string, number>;
}

export async function approveTimeEntries(ids: string[], approve: boolean, actor: TimeEntryActor): Promise<BulkApproveResult> {
  if (!actor.manageAll) {
    throw new TimeEntryServiceError('Approving time entries requires an admin role', 403, 'ADMIN_REQUIRED');
  }
  // RLS scopes to the actor's partner — out-of-partner ids look "missing", by design.
  const candidates = await db
    .select({ id: timeEntries.id, endedAt: timeEntries.endedAt, partnerId: timeEntries.partnerId, ticketId: timeEntries.ticketId })
    .from(timeEntries)
    .where(inArray(timeEntries.id, ids));

  const found = new Map(candidates.map((c) => [c.id, c]));
  const skippedReasons: Record<string, number> = {};
  const skip = (reason: string) => { skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1; };
  const eligible: string[] = [];
  for (const id of ids) {
    const row = found.get(id);
    if (!row) { skip('ENTRY_NOT_FOUND'); continue; }
    if (!row.endedAt) { skip('ENTRY_RUNNING'); continue; }
    eligible.push(id);
  }

  let updated: { id: string; partnerId: string; ticketId: string | null }[] = [];
  if (eligible.length > 0) {
    updated = await db
      .update(timeEntries)
      .set(approve
        ? { isApproved: true, approvedBy: actor.userId, approvedAt: new Date() }
        : { isApproved: false, approvedBy: null, approvedAt: null })
      .where(inArray(timeEntries.id, eligible))
      .returning({ id: timeEntries.id, partnerId: timeEntries.partnerId, ticketId: timeEntries.ticketId });
  }

  if (updated.length > 0 && approve) {
    await emitTimeEntryEvent({
      type: 'time_entry.approved',
      timeEntryId: updated[0].id,
      partnerId: updated[0].partnerId,
      ticketId: updated[0].ticketId,
      actorUserId: actor.userId,
      payload: { ids: updated.map((u) => u.id), approvedBy: actor.userId }
    });
  }

  return {
    updated: updated.length,
    skipped: ids.length - updated.length,
    skippedReasons
  };
}

// ── Parts ────────────────────────────────────────────────────────────────

export async function addTicketPart(ticketId: string, input: TicketPartInput, actor: TimeEntryActor) {
  const link = await resolveTicketLink(ticketId, actor.partnerId);
  const rows = await db
    .insert(ticketParts)
    .values({
      ticketId,
      orgId: link.ticket.orgId,
      description: input.description,
      partNumber: input.partNumber ?? null,
      vendor: input.vendor ?? null,
      quantity: input.quantity.toFixed(2),
      unitPrice: (input.unitPrice ?? 0).toFixed(2),
      costBasis: input.costBasis != null ? input.costBasis.toFixed(2) : null,
      isBillable: input.isBillable ?? link.defaultBillable,
      billingStatus: input.billingStatus ?? 'not_billed',
      addedBy: actor.userId,
      notes: input.notes ?? null
    })
    .returning();
  return rows[0];
}

async function getPartOr404(id: string) {
  const rows = await db.select().from(ticketParts).where(eq(ticketParts.id, id)).limit(1);
  const part = rows[0];
  if (!part) throw new TimeEntryServiceError('Part not found', 404, 'PART_NOT_FOUND');
  return part;
}

export async function updateTicketPart(id: string, input: Partial<TicketPartInput>, actor: TimeEntryActor) {
  const part = await getPartOr404(id);
  const set: Record<string, unknown> = {};
  if (input.description !== undefined) set.description = input.description;
  if (input.partNumber !== undefined) set.partNumber = input.partNumber;
  if (input.vendor !== undefined) set.vendor = input.vendor;
  if (input.quantity !== undefined) set.quantity = input.quantity.toFixed(2);
  if (input.unitPrice !== undefined) set.unitPrice = input.unitPrice.toFixed(2);
  if (input.costBasis !== undefined) set.costBasis = input.costBasis != null ? input.costBasis.toFixed(2) : null;
  if (input.isBillable !== undefined) set.isBillable = input.isBillable;
  if (input.billingStatus !== undefined) set.billingStatus = input.billingStatus;
  if (input.notes !== undefined) set.notes = input.notes;
  const rows = await db.update(ticketParts).set(set).where(eq(ticketParts.id, id)).returning();
  return rows[0] ?? part;
}

export async function deleteTicketPart(id: string, actor: TimeEntryActor) {
  await getPartOr404(id);
  await db.delete(ticketParts).where(eq(ticketParts.id, id));
}
```

Add `inArray` to the drizzle-orm import at the top of the file, and `db.delete` to the test's db mock:

```typescript
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }))
```

(`actor` is unused in `updateTicketPart`/`deleteTicketPart` beyond scoping — parts authz is `tickets:write` at the route layer; keep the parameter for the audit-friendly signature.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/timeEntryService.test.ts --pool=forks
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts apps/api/src/services/timeEntryService.test.ts
git commit -m "feat(ticketing): timeEntryService — update/delete, approval, parts"
```

---

### Task 7: `timeEntryService.ts` — queries (list, running, timesheet, billing summary)

**Files:**
- Modify: `apps/api/src/services/timeEntryService.ts`

These are read paths exercised end-to-end by the route tests (Task 8) and integration tests (Task 13) — no separate service unit tests for query-builder plumbing.

- [ ] **Step 1: Implement (append to `timeEntryService.ts`)**

Add `users` to the schema import, and `asc, desc, gte, lt, lte` to the drizzle-orm import.

```typescript
export interface ListTimeEntriesFilters {
  userId?: string;
  ticketId?: string;
  orgId?: string;
  from?: Date;
  to?: Date;
  running?: boolean;
  billingStatus?: 'not_billed' | 'billed' | 'no_charge' | 'contract';
  approved?: boolean;
  limit: number;
  offset: number;
}

const entrySelection = {
  id: timeEntries.id,
  partnerId: timeEntries.partnerId,
  orgId: timeEntries.orgId,
  ticketId: timeEntries.ticketId,
  userId: timeEntries.userId,
  startedAt: timeEntries.startedAt,
  endedAt: timeEntries.endedAt,
  durationMinutes: timeEntries.durationMinutes,
  description: timeEntries.description,
  isBillable: timeEntries.isBillable,
  hourlyRate: timeEntries.hourlyRate,
  billingStatus: timeEntries.billingStatus,
  isApproved: timeEntries.isApproved,
  approvedBy: timeEntries.approvedBy,
  approvedAt: timeEntries.approvedAt,
  createdAt: timeEntries.createdAt,
  // decorations (additive, Phase 1b pattern)
  ticketNumber: tickets.internalNumber,
  ticketSubject: tickets.subject,
  userName: users.name
};

function listConditions(filters: ListTimeEntriesFilters) {
  const conditions = [];
  if (filters.userId) conditions.push(eq(timeEntries.userId, filters.userId));
  if (filters.ticketId) conditions.push(eq(timeEntries.ticketId, filters.ticketId));
  if (filters.orgId) conditions.push(eq(timeEntries.orgId, filters.orgId));
  if (filters.from) conditions.push(gte(timeEntries.startedAt, filters.from));
  if (filters.to) conditions.push(lt(timeEntries.startedAt, filters.to));
  if (filters.running !== undefined) {
    conditions.push(filters.running ? isNull(timeEntries.endedAt) : sql`${timeEntries.endedAt} IS NOT NULL`);
  }
  if (filters.billingStatus) conditions.push(eq(timeEntries.billingStatus, filters.billingStatus));
  if (filters.approved !== undefined) conditions.push(eq(timeEntries.isApproved, filters.approved));
  return conditions;
}

export async function listTimeEntries(filters: ListTimeEntriesFilters) {
  const conditions = listConditions(filters);
  const entries = await db
    .select(entrySelection)
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(timeEntries.startedAt))
    .limit(filters.limit)
    .offset(filters.offset);

  const totalRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(timeEntries)
    .where(conditions.length ? and(...conditions) : undefined);

  return { entries, total: totalRows[0]?.count ?? 0 };
}

export async function getRunningTimer(userId: string) {
  const rows = await db
    .select(entrySelection)
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(eq(timeEntries.userId, userId), isNull(timeEntries.endedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export interface TimesheetDay {
  date: string; // YYYY-MM-DD
  totalMinutes: number;
  billableMinutes: number;
  entries: Awaited<ReturnType<typeof listTimeEntries>>['entries'];
}

export async function getTimesheet(userId: string, weekStart: Date) {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60_000);
  const entries = await db
    .select(entrySelection)
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(
      eq(timeEntries.userId, userId),
      gte(timeEntries.startedAt, weekStart),
      lt(timeEntries.startedAt, weekEnd)
    ))
    .orderBy(asc(timeEntries.startedAt));

  const days = new Map<string, TimesheetDay>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart.getTime() + i * 24 * 60 * 60_000);
    const key = d.toISOString().slice(0, 10);
    days.set(key, { date: key, totalMinutes: 0, billableMinutes: 0, entries: [] });
  }
  for (const entry of entries) {
    const key = entry.startedAt.toISOString().slice(0, 10);
    const day = days.get(key);
    if (!day) continue; // boundary rows from TZ edges — still in totals below
    day.entries.push(entry);
    const minutes = entry.durationMinutes ?? 0;
    day.totalMinutes += minutes;
    if (entry.isBillable) day.billableMinutes += minutes;
  }
  const allDays = [...days.values()];
  return {
    weekStart: weekStart.toISOString().slice(0, 10),
    days: allDays,
    totals: {
      totalMinutes: allDays.reduce((s, d) => s + d.totalMinutes, 0),
      billableMinutes: allDays.reduce((s, d) => s + d.billableMinutes, 0)
    }
  };
}

export async function getTicketBillingSummary(ticketId: string) {
  const timeRows = await db
    .select({
      totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)::int`,
      billableMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}) FILTER (WHERE ${timeEntries.isBillable}), 0)::int`,
      billableAmount: sql<string>`COALESCE(SUM((${timeEntries.durationMinutes}::numeric / 60) * ${timeEntries.hourlyRate}) FILTER (WHERE ${timeEntries.isBillable} AND ${timeEntries.hourlyRate} IS NOT NULL), 0)::numeric(12,2)`
    })
    .from(timeEntries)
    .where(eq(timeEntries.ticketId, ticketId));

  const partsRows = await db
    .select({
      partsCount: sql<number>`COUNT(*)::int`,
      billableTotal: sql<string>`COALESCE(SUM(${ticketParts.quantity} * ${ticketParts.unitPrice}) FILTER (WHERE ${ticketParts.isBillable}), 0)::numeric(12,2)`
    })
    .from(ticketParts)
    .where(eq(ticketParts.ticketId, ticketId));

  return {
    time: timeRows[0] ?? { totalMinutes: 0, billableMinutes: 0, billableAmount: '0.00' },
    parts: partsRows[0] ?? { partsCount: 0, billableTotal: '0.00' }
  };
}
```

- [ ] **Step 2: Type-check**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```

Expected: clean apart from the pre-existing `agents.test.ts` / `apiKeyAuth.test.ts` errors (known, untouched).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/timeEntryService.ts
git commit -m "feat(ticketing): timeEntryService queries — list, running, timesheet, billing summary"
```

---

### Task 8: Standalone `/time-entries` routes

**Files:**
- Create: `apps/api/src/routes/timeEntries/index.ts` (hub)
- Create: `apps/api/src/routes/timeEntries/timeEntries.ts`
- Create: `apps/api/src/routes/timeEntries/timeEntries.test.ts`
- Modify: `apps/api/src/index.ts` (mount at `/time-entries`, next to the tickets mount — find it with `grep -n "ticketsRoutes" apps/api/src/index.ts`)

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/routes/timeEntries/timeEntries.test.ts` (mock pattern copied from `routes/tickets/tickets.test.ts` — import the HUB, not the sub-router):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks, authRef, permsRef } = vi.hoisted(() => ({
  serviceMocks: {
    createTimeEntry: vi.fn(),
    startTimer: vi.fn(),
    stopTimer: vi.fn(),
    updateTimeEntry: vi.fn(),
    deleteTimeEntry: vi.fn(),
    approveTimeEntries: vi.fn(),
    listTimeEntries: vi.fn(),
    getRunningTimer: vi.fn(),
    getTimesheet: vi.fn()
  },
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example', isPlatformAdmin: false },
      partnerId: 'p-1' as string | null,
      orgId: null as string | null,
      accessibleOrgIds: null as string[] | null,
      orgCondition: () => undefined,
      canAccessOrg: (_id: string) => true as boolean
    }
  },
  // wildcard permission present => manageAll admin
  permsRef: { current: { permissions: [{ resource: 'time_entries', action: 'write' }, { resource: 'time_entries', action: 'read' }] } }
}));

vi.mock('../../services/timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
  return { ...actual, ...serviceMocks };
});

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth) return c.json({ error: 'Not authenticated' }, 401);
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    c.set('permissions', permsRef.current);
    await next();
  }
}));

import { timeEntriesRoutes } from './index';

const ADMIN_PERMS = { permissions: [{ resource: '*', action: '*' }] };

beforeEach(() => {
  Object.values(serviceMocks).forEach((m) => m.mockReset());
  authRef.current.scope = 'partner';
  permsRef.current = { permissions: [{ resource: 'time_entries', action: 'write' }, { resource: 'time_entries', action: 'read' }] };
});

describe('GET /time-entries', () => {
  it('403s org-scope callers (internal-only, spec D4)', async () => {
    authRef.current.scope = 'organization';
    const res = await timeEntriesRoutes.request('/');
    expect(res.status).toBe(403);
  });

  it('forces userId=self for non-admin callers (D5)', async () => {
    serviceMocks.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    const res = await timeEntriesRoutes.request('/?userId=u-OTHER');
    expect(res.status).toBe(200);
    expect(serviceMocks.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1' }));
  });

  it('lets wildcard-permission admins query any user', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.listTimeEntries.mockResolvedValue({ entries: [], total: 0 });
    const res = await timeEntriesRoutes.request('/?userId=u-OTHER');
    expect(res.status).toBe(200);
    expect(serviceMocks.listTimeEntries).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-OTHER' }));
  });
});

describe('timer endpoints', () => {
  it('POST /start passes manageAll=false actor and returns the entry', async () => {
    serviceMocks.startTimer.mockResolvedValue({ id: 'te-1', endedAt: null });
    const res = await timeEntriesRoutes.request('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketId: '3f2f1d8e-1111-4222-8333-444455556666' })
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.startTimer).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: '3f2f1d8e-1111-4222-8333-444455556666' }),
      expect.objectContaining({ userId: 'u-1', partnerId: 'p-1', manageAll: false })
    );
  });

  it('maps TimeEntryServiceError to its status', async () => {
    const { TimeEntryServiceError } = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
    serviceMocks.stopTimer.mockRejectedValue(new TimeEntryServiceError('No running timer', 404, 'NO_RUNNING_TIMER'));
    const res = await timeEntriesRoutes.request('/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'No running timer', code: 'NO_RUNNING_TIMER' });
  });

  it('GET /running returns null data when nothing is running', async () => {
    serviceMocks.getRunningTimer.mockResolvedValue(null);
    const res = await timeEntriesRoutes.request('/running');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
  });
});

describe('POST /bulk-approve', () => {
  it('surfaces skippedReasons from the service', async () => {
    permsRef.current = ADMIN_PERMS;
    serviceMocks.approveTimeEntries.mockResolvedValue({ updated: 1, skipped: 1, skippedReasons: { ENTRY_RUNNING: 1 } });
    const res = await timeEntriesRoutes.request('/bulk-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['3f2f1d8e-1111-4222-8333-444455556666'] })
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { updated: 1, skippedReasons: { ENTRY_RUNNING: 1 } } });
  });
});

describe('GET /timesheet', () => {
  it("403s a non-admin requesting someone else's timesheet", async () => {
    const res = await timeEntriesRoutes.request('/timesheet?userId=u-OTHER&weekStart=2026-06-08');
    expect(res.status).toBe(403);
  });

  it('defaults to own timesheet', async () => {
    serviceMocks.getTimesheet.mockResolvedValue({ weekStart: '2026-06-08', days: [], totals: { totalMinutes: 0, billableMinutes: 0 } });
    const res = await timeEntriesRoutes.request('/timesheet?weekStart=2026-06-08');
    expect(res.status).toBe(200);
    expect(serviceMocks.getTimesheet).toHaveBeenCalledWith('u-1', expect.any(Date));
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/timeEntries/timeEntries.test.ts --pool=forks
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hub**

Create `apps/api/src/routes/timeEntries/index.ts`:

```typescript
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { timeEntriesApiRoutes } from './timeEntries';

export const timeEntriesRoutes = new Hono();

// authMiddleware at the hub (tickets/index.ts pattern) — requireScope/requirePermission
// in the sub-router depend on c.get('auth') being populated.
timeEntriesRoutes.use('*', authMiddleware);
timeEntriesRoutes.route('/', timeEntriesApiRoutes);
```

- [ ] **Step 4: Implement the routes**

Create `apps/api/src/routes/timeEntries/timeEntries.ts`:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import {
  createTimeEntrySchema, updateTimeEntrySchema, startTimerSchema, stopTimerSchema,
  listTimeEntriesQuerySchema, bulkApproveSchema, timesheetQuerySchema
} from '@breeze/shared';
import {
  createTimeEntry, startTimer, stopTimer, updateTimeEntry, deleteTimeEntry,
  approveTimeEntries, listTimeEntries, getRunningTimer, getTimesheet,
  TimeEntryServiceError, type TimeEntryActor
} from '../../services/timeEntryService';

export const timeEntriesApiRoutes = new Hono();

// Internal-only surface (spec D4): partner/system scope only. time_entries has
// no org-axis RLS policy, so org-scope DB contexts could not read it anyway.
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action);
const writePerm = requirePermission(PERMISSIONS.TIME_ENTRIES_WRITE.resource, PERMISSIONS.TIME_ENTRIES_WRITE.action);

type Ctx = { get: (k: 'auth' | 'permissions') => unknown };

export function timeActorFrom(c: Ctx): TimeEntryActor {
  const auth = c.get('auth') as AuthContext;
  const perms = c.get('permissions') as UserPermissions | undefined;
  return {
    userId: auth.user.id,
    name: auth.user.name,
    email: auth.user.email,
    partnerId: auth.partnerId,
    // v1 admin proxy (plan decision): wildcard-permission roles approve + manage others
    manageAll: auth.user.isPlatformAdmin || (perms ? hasPermission(perms, '*', '*') : false)
  };
}

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TimeEntryServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// Literal paths BEFORE /:id (Hono matching is registration-ordered).

timeEntriesApiRoutes.get('/running', scopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const entry = await getRunningTimer(auth.user.id);
  return c.json({ data: entry });
});

timeEntriesApiRoutes.post('/start', scopes, writePerm, zValidator('json', startTimerSchema), async (c) => {
  try {
    const entry = await startTimer(c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.post('/stop', scopes, writePerm, zValidator('json', stopTimerSchema), async (c) => {
  try {
    const entry = await stopTimer(c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.post('/bulk-approve', scopes, writePerm, zValidator('json', bulkApproveSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const result = await approveTimeEntries(body.ids, body.approve, timeActorFrom(c));
    return c.json({ data: { ...result, total: body.ids.length } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.get('/timesheet', scopes, readPerm, zValidator('query', timesheetQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const actor = timeActorFrom(c);
  const targetUserId = q.userId ?? actor.userId;
  if (targetUserId !== actor.userId && !actor.manageAll) {
    return c.json({ error: 'Viewing other timesheets requires an admin role' }, 403);
  }
  const timesheet = await getTimesheet(targetUserId, q.weekStart);
  return c.json({ data: timesheet });
});

timeEntriesApiRoutes.get('/', scopes, readPerm, zValidator('query', listTimeEntriesQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const actor = timeActorFrom(c);
  // D5: non-admins see only their own entries through the standalone list.
  const filters = { ...q, userId: actor.manageAll ? q.userId : actor.userId };
  const { entries, total } = await listTimeEntries(filters);
  return c.json({ data: entries, total, limit: q.limit, offset: q.offset });
});

timeEntriesApiRoutes.post('/', scopes, writePerm, zValidator('json', createTimeEntrySchema), async (c) => {
  try {
    const entry = await createTimeEntry(c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.patch('/:id', scopes, writePerm, zValidator('json', updateTimeEntrySchema), async (c) => {
  try {
    const entry = await updateTimeEntry(c.req.param('id'), c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: entry });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeEntriesApiRoutes.delete('/:id', scopes, writePerm, async (c) => {
  try {
    await deleteTimeEntry(c.req.param('id'), timeActorFrom(c));
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});
```

(If `UserPermissions` isn't exported from `services/permissions.ts` under that name, check the actual export — `middleware/auth.ts:4` imports it from there.)

- [ ] **Step 5: Mount the hub**

In `apps/api/src/index.ts`, next to the existing tickets mount (find with `grep -n "tickets" apps/api/src/index.ts`):

```typescript
import { timeEntriesRoutes } from './routes/timeEntries';
// ...
app.route('/time-entries', timeEntriesRoutes);
```

Match the exact mounting idiom used for `ticketsRoutes` (path prefix may include `/api` — copy whatever tickets does).

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/timeEntries/timeEntries.test.ts --pool=forks
```

Expected: PASS.

- [ ] **Step 7: Run the route-scan + wiring guards**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/__tests__/routeScan.test.ts --pool=forks
```

Expected: PASS — if the site-scope scanner flags the new routes, the time-entries list is intentionally not site-gated (no device axis, partner-internal); add the exemption with a comment pointing at the spec's site-scope paragraph, mirroring how existing exemptions are recorded.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/timeEntries/ apps/api/src/index.ts
git commit -m "feat(ticketing): /time-entries routes — list, timers, timesheet, bulk-approve"
```

---

### Task 9: Per-ticket routes (parts, time list, billing summary) + billables CSV export

**Files:**
- Create: `apps/api/src/routes/tickets/parts.ts`
- Create: `apps/api/src/routes/tickets/parts.test.ts`
- Create: `apps/api/src/routes/tickets/export.ts`
- Modify: `apps/api/src/routes/tickets/index.ts` (mount both BEFORE `ticketsApiRoutes`)
- Modify: `apps/api/src/services/timeEntryService.ts` (add `listBillables`)

- [ ] **Step 1: Add `listBillables` to the service**

Append to `timeEntryService.ts` (add `organizations` already imported; ensure `lte` imported):

```typescript
export interface BillableRow {
  kind: 'time' | 'part';
  date: Date;
  orgName: string | null;
  ticketNumber: string | null;
  description: string | null;
  technician: string | null;
  quantity: string;       // hours for time rows, qty for parts
  rate: string | null;    // hourly rate / unit price
  amount: string;
  billingStatus: string;
  isApproved: boolean | null; // null for parts (no approval concept)
}

export async function listBillables(from: Date, to: Date, orgId?: string): Promise<BillableRow[]> {
  const timeConditions = [
    eq(timeEntries.isBillable, true),
    gte(timeEntries.startedAt, from),
    lte(timeEntries.startedAt, to)
  ];
  if (orgId) timeConditions.push(eq(timeEntries.orgId, orgId));

  const timeRows = await db
    .select({
      date: timeEntries.startedAt,
      orgName: organizations.name,
      ticketNumber: tickets.internalNumber,
      description: timeEntries.description,
      technician: users.name,
      minutes: timeEntries.durationMinutes,
      rate: timeEntries.hourlyRate,
      billingStatus: timeEntries.billingStatus,
      isApproved: timeEntries.isApproved
    })
    .from(timeEntries)
    .leftJoin(tickets, eq(timeEntries.ticketId, tickets.id))
    .leftJoin(organizations, eq(timeEntries.orgId, organizations.id))
    .leftJoin(users, eq(timeEntries.userId, users.id))
    .where(and(...timeConditions))
    .orderBy(asc(timeEntries.startedAt));

  const partConditions = [
    eq(ticketParts.isBillable, true),
    gte(ticketParts.createdAt, from),
    lte(ticketParts.createdAt, to)
  ];
  if (orgId) partConditions.push(eq(ticketParts.orgId, orgId));

  const partRows = await db
    .select({
      date: ticketParts.createdAt,
      orgName: organizations.name,
      ticketNumber: tickets.internalNumber,
      description: ticketParts.description,
      technician: users.name,
      quantity: ticketParts.quantity,
      unitPrice: ticketParts.unitPrice,
      billingStatus: ticketParts.billingStatus
    })
    .from(ticketParts)
    .leftJoin(tickets, eq(ticketParts.ticketId, tickets.id))
    .leftJoin(organizations, eq(ticketParts.orgId, organizations.id))
    .leftJoin(users, eq(ticketParts.addedBy, users.id))
    .where(and(...partConditions))
    .orderBy(asc(ticketParts.createdAt));

  const rows: BillableRow[] = [];
  for (const r of timeRows) {
    const hours = (r.minutes ?? 0) / 60;
    const rate = r.rate != null ? Number(r.rate) : null;
    rows.push({
      kind: 'time',
      date: r.date,
      orgName: r.orgName,
      ticketNumber: r.ticketNumber,
      description: r.description,
      technician: r.technician,
      quantity: hours.toFixed(2),
      rate: r.rate,
      amount: rate != null ? (hours * rate).toFixed(2) : '0.00',
      billingStatus: r.billingStatus,
      isApproved: r.isApproved
    });
  }
  for (const r of partRows) {
    rows.push({
      kind: 'part',
      date: r.date,
      orgName: r.orgName,
      ticketNumber: r.ticketNumber,
      description: r.description,
      technician: r.technician,
      quantity: r.quantity,
      rate: r.unitPrice,
      amount: (Number(r.quantity) * Number(r.unitPrice)).toFixed(2),
      billingStatus: r.billingStatus,
      isApproved: null
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime());
  return rows;
}
```

Note: `cost_basis` is deliberately absent from `BillableRow` — the export is customer-billing-shaped; margin stays MSP-internal in the UI only (spec D4).

- [ ] **Step 2: Write the failing route tests**

Create `apps/api/src/routes/tickets/parts.test.ts`. Copy the auth/db/schema mock block from `routes/tickets/bulk.test.ts` (it already mocks `./tickets` exports — mirror exactly how it mocks `getScopedTicketOr404`/`actorFrom`), then:

```typescript
// ...mock block per bulk.test.ts, plus:
const { timeServiceMocks } = vi.hoisted(() => ({
  timeServiceMocks: {
    addTicketPart: vi.fn(),
    updateTicketPart: vi.fn(),
    deleteTicketPart: vi.fn(),
    listTimeEntries: vi.fn(),
    getTicketBillingSummary: vi.fn(),
    listBillables: vi.fn()
  }
}));
vi.mock('../../services/timeEntryService', async () => {
  const actual = await vi.importActual<typeof import('../../services/timeEntryService')>('../../services/timeEntryService');
  return { ...actual, ...timeServiceMocks };
});

import { ticketsRoutes } from './index';

describe('parts routes', () => {
  it('404s when the ticket is out of scope (site gate via getScopedTicketOr404)', async () => {
    getScopedTicketOr404Mock.mockResolvedValue(null);
    const res = await ticketsRoutes.request('/t-1/parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'SSD', quantity: 1 })
    });
    expect(res.status).toBe(404);
    expect(timeServiceMocks.addTicketPart).not.toHaveBeenCalled();
  });

  it('creates a part on an in-scope ticket', async () => {
    getScopedTicketOr404Mock.mockResolvedValue({ id: 't-1', orgId: 'o-1', deviceId: null });
    timeServiceMocks.addTicketPart.mockResolvedValue({ id: 'part-1' });
    const res = await ticketsRoutes.request('/t-1/parts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'SSD', quantity: 1, unitPrice: 120 })
    });
    expect(res.status).toBe(201);
  });

  it('PATCH /parts/:id resolves scope through the parent ticket', async () => {
    // part lookup happens in the route via db mock (select ticket_parts by id)
    dbSelectMock.mockReturnValueOnce([{ id: 'part-1', ticketId: 't-1' }]);
    getScopedTicketOr404Mock.mockResolvedValue(null); // parent out of scope
    const res = await ticketsRoutes.request('/parts/part-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 2 })
    });
    expect(res.status).toBe(404);
    expect(timeServiceMocks.updateTicketPart).not.toHaveBeenCalled();
  });
});

describe('GET /export/billables.csv', () => {
  it('returns CSV with headers and no cost_basis column', async () => {
    timeServiceMocks.listBillables.mockResolvedValue([
      { kind: 'time', date: new Date('2026-06-10T10:00:00Z'), orgName: 'Acme', ticketNumber: 'T-2026-0001',
        description: 'fix', technician: 'Tess', quantity: '0.50', rate: '125.00', amount: '62.50',
        billingStatus: 'not_billed', isApproved: true }
    ]);
    const res = await ticketsRoutes.request('/export/billables.csv?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const body = await res.text();
    expect(body.split('\n')[0]).toBe('type,date,organization,ticket,description,technician,quantity,rate,amount,billing_status,approved');
    expect(body).toContain('T-2026-0001');
    expect(body).not.toContain('cost');
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/parts.test.ts --pool=forks
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `parts.ts`**

Create `apps/api/src/routes/tickets/parts.ts`:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { ticketParts } from '../../db/schema';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { ticketPartSchema, updateTicketPartSchema, listTimeEntriesQuerySchema } from '@breeze/shared';
import {
  addTicketPart, updateTicketPart, deleteTicketPart,
  listTimeEntries, getTicketBillingSummary, TimeEntryServiceError
} from '../../services/timeEntryService';
import { getScopedTicketOr404, actorFrom } from './tickets';
import { timeActorFrom } from '../timeEntries/timeEntries';

// Internal-only (spec D4): parts + per-ticket time data never reach org scope.
export const ticketPartsRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TimeEntryServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// /parts/:id BEFORE the hub's /:id routes — this router mounts first in index.ts.
ticketPartsRoutes.patch('/parts/:id', scopes, writePerm, zValidator('json', updateTicketPartSchema), async (c) => {
  const auth = c.get('auth');
  const rows = await db.select().from(ticketParts).where(eq(ticketParts.id, c.req.param('id'))).limit(1);
  const part = rows[0];
  if (!part || !(await getScopedTicketOr404(auth, part.ticketId))) {
    return c.json({ error: 'Part not found' }, 404);
  }
  try {
    const updated = await updateTicketPart(part.id, c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: updated });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketPartsRoutes.delete('/parts/:id', scopes, writePerm, async (c) => {
  const auth = c.get('auth');
  const rows = await db.select().from(ticketParts).where(eq(ticketParts.id, c.req.param('id'))).limit(1);
  const part = rows[0];
  if (!part || !(await getScopedTicketOr404(auth, part.ticketId))) {
    return c.json({ error: 'Part not found' }, 404);
  }
  try {
    await deleteTicketPart(part.id, timeActorFrom(c));
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketPartsRoutes.get('/:id/parts', scopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.param('id'));
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  const parts = await db.select().from(ticketParts).where(eq(ticketParts.ticketId, ticket.id));
  return c.json({ data: parts });
});

ticketPartsRoutes.post('/:id/parts', scopes, writePerm, zValidator('json', ticketPartSchema), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.param('id'));
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  try {
    const part = await addTicketPart(ticket.id, c.req.valid('json'), timeActorFrom(c));
    return c.json({ data: part }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketPartsRoutes.get('/:id/time-entries', scopes, readPerm, zValidator('query', listTimeEntriesQuerySchema), async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.param('id'));
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  const q = c.req.valid('query');
  const { entries, total } = await listTimeEntries({ ...q, ticketId: ticket.id });
  return c.json({ data: entries, total });
});

ticketPartsRoutes.get('/:id/billing-summary', scopes, readPerm, async (c) => {
  const auth = c.get('auth');
  const ticket = await getScopedTicketOr404(auth, c.req.param('id'));
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
  const summary = await getTicketBillingSummary(ticket.id);
  return c.json({ data: summary });
});
```

(`actorFrom` import is unused if `timeActorFrom` covers everything — drop whichever is unused at lint time.)

- [ ] **Step 5: Implement `export.ts`**

Create `apps/api/src/routes/tickets/export.ts`:

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { billablesExportQuerySchema } from '@breeze/shared';
import { listBillables } from '../../services/timeEntryService';
import { csvRow } from '../../services/spreadsheetExport';

export const ticketExportRoutes = new Hono();

const CSV_HEADERS = ['type', 'date', 'organization', 'ticket', 'description', 'technician', 'quantity', 'rate', 'amount', 'billing_status', 'approved'];

ticketExportRoutes.get(
  '/export/billables.csv',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action),
  zValidator('query', billablesExportQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    const rows = await listBillables(q.from, q.to, q.orgId);
    const lines = [CSV_HEADERS.join(',')];
    for (const r of rows) {
      lines.push(csvRow([
        r.kind, r.date.toISOString(), r.orgName ?? '', r.ticketNumber ?? '',
        r.description ?? '', r.technician ?? '', r.quantity, r.rate ?? '',
        r.amount, r.billingStatus, r.isApproved === null ? '' : String(r.isApproved)
      ]));
    }
    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="billables.csv"');
    return c.body(lines.join('\n'));
  }
);
```

- [ ] **Step 6: Mount both in the tickets hub**

In `apps/api/src/routes/tickets/index.ts` — literal-path routers BEFORE the `/:id`-bearing routers:

```typescript
import { ticketExportRoutes } from './export';
import { ticketPartsRoutes } from './parts';
// ...
ticketsRoutes.route('/', ticketExportRoutes);   // /export/... before /:id
ticketsRoutes.route('/', ticketPartsRoutes);    // /parts/:id + /:id/parts before generic /:id
ticketsRoutes.route('/', ticketsBulkRoutes);
ticketsRoutes.route('/', ticketsApiRoutes);
```

- [ ] **Step 7: Run tests to verify they pass (including the existing tickets suite)**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/ --pool=forks
```

Expected: new tests PASS; existing tickets/bulk tests still PASS. Gotcha from #1251: module-scope Drizzle column derefs in a route file crash OTHER route-test files whose schema mocks omit the table — `parts.ts` only derefs `ticketParts` inside handlers, but if any tickets-suite file fails at COLLECTION, add `ticketParts: {...}` to its schema mock.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/tickets/parts.ts apps/api/src/routes/tickets/parts.test.ts apps/api/src/routes/tickets/export.ts apps/api/src/routes/tickets/index.ts apps/api/src/services/timeEntryService.ts
git commit -m "feat(ticketing): per-ticket parts/time routes, billing summary, billables CSV export"
```

---

### Task 10: AI tool actions — `log_time_entry`, `start_timer`, `stop_timer`

**Files:**
- Modify: `apps/api/src/services/aiToolsTicketing.ts`
- Modify: `apps/api/src/services/aiToolSchemas.ts` (manage_tickets schema, ~line 168)
- Modify: `apps/api/src/services/aiGuardrails.ts` (TOOL_PERMISSIONS, ~line 102 — NOT TIER2_ACTIONS)
- Modify: `apps/api/src/services/aiToolsTicketing.test.ts` (or wherever manage_tickets handler tests live — `grep -rn "manage_tickets" apps/api/src --include="*.test.ts"`)

- [ ] **Step 1: Extend the action schema**

In `aiToolSchemas.ts`, `manage_tickets` entry — extend the enum and add fields:

```typescript
  action: z.enum(['list', 'get', 'create', 'comment', 'assign', 'update_status', 'log_time_entry', 'start_timer', 'stop_timer']),
  // ... existing fields ...
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  isBillable: z.boolean().optional(),
  hourlyRate: z.number().nonnegative().optional(),
```

- [ ] **Step 2: Add RBAC mappings (fail-closed registry)**

In `aiGuardrails.ts` `TOOL_PERMISSIONS.manage_tickets`:

```typescript
  log_time_entry: { resource: 'time_entries', action: 'write' },
  start_timer: { resource: 'time_entries', action: 'write' },
  stop_timer: { resource: 'time_entries', action: 'write' },
```

Do NOT add these to `TIER2_ACTIONS` — unlisted write actions stay approval-required (tier 3 per spec §4). Verify with a quick read of how `aiGuardrails.ts` tiers unlisted actions before relying on this.

- [ ] **Step 3: Add handler branches + tool description**

In `aiToolsTicketing.ts`: extend the `definition.description` and `input_schema.properties.action.enum` to include the three new actions (and document `startedAt`/`endedAt`/`isBillable`/`hourlyRate` properties). Then add branches after `update_status`:

```typescript
import { createTimeEntry, startTimer, stopTimer, TimeEntryServiceError } from './timeEntryService';
// actor for time tracking: AI runs as the chat user; never manageAll.
const timeActor = { userId: auth.user.id, name: auth.user.name, partnerId: auth.partnerId, manageAll: false };

// ── log_time_entry ────────────────────────────────────────────────────
if (action === 'log_time_entry') {
  if (!input.startedAt || !input.endedAt) {
    return { error: 'startedAt and endedAt are required for log_time_entry' };
  }
  const entry = await createTimeEntry({
    ticketId: input.ticketId,
    startedAt: new Date(input.startedAt),
    endedAt: new Date(input.endedAt),
    description: input.description,
    isBillable: input.isBillable,
    hourlyRate: input.hourlyRate
  }, timeActor);
  return { timeEntry: { id: entry.id, durationMinutes: entry.durationMinutes, isBillable: entry.isBillable } };
}

// ── start_timer ───────────────────────────────────────────────────────
if (action === 'start_timer') {
  const entry = await startTimer({ ticketId: input.ticketId, description: input.description }, timeActor);
  return { timer: { id: entry.id, startedAt: entry.startedAt, ticketId: entry.ticketId } };
}

// ── stop_timer ────────────────────────────────────────────────────────
if (action === 'stop_timer') {
  const entry = await stopTimer({ description: input.description, isBillable: input.isBillable }, timeActor);
  return { timer: { id: entry.id, durationMinutes: entry.durationMinutes } };
}
```

Wrap in the file's existing TicketServiceError-style catch if the handler uses one — convert `TimeEntryServiceError` to `{ error: err.message }` the same way ticket actions surface service errors. Match the surrounding handler's exact `input`/`auth` variable names and return-shape conventions (read the `create` branch first and mirror it).

**Site-scope note:** `log_time_entry`/`start_timer` accept a `ticketId`, not a `deviceId` — the service validates partner ownership; site-gating per-ticket here would need the ticket's device, which the `get` action's `findTicketWithAccess` already implements — reuse it to pre-check `input.ticketId` for these three actions (one-line guard before delegating), keeping parity with the #1261 site-scope fix.

- [ ] **Step 4: Tests**

In the manage_tickets handler test file, add (adapting to its existing harness):

```typescript
it('log_time_entry delegates to createTimeEntry with a non-admin actor', async () => { /* assert manageAll: false and Date conversion */ });
it('start_timer/stop_timer delegate and surface NO_RUNNING_TIMER as an error result', async () => { /* mock stopTimer rejection */ });
it('rejects unknown actions for the extended enum via schema (guardrails registry test)', async () => { /* if a registry contract test exists, update its action list */ });
```

There is a fail-closed registry contract: if a test asserts every schema action has a TOOL_PERMISSIONS entry (or vice versa), the new actions must appear in both — run the ai-tools test files and fix whichever enumeration assertions fail:

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/aiToolsTicketing.test.ts src/services/aiGuardrails.test.ts src/services/aiToolSchemas.test.ts --pool=forks
```

Expected: PASS after updates.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsTicketing.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiToolsTicketing.test.ts
git commit -m "feat(ticketing): AI tool actions — log_time_entry, start_timer, stop_timer (tier 3)"
```

---

### Task 11: moveOrg org_id rewrite for ticket-linked rows

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:136` (`CUSTOM_ORG_REWRITE_TABLES`)
- Modify: `apps/api/src/routes/devices/moveOrg.ts` (~line 159, next to the `ticket_alert_links` rewrite)
- Modify: the moveOrg test file (`grep -rn "CUSTOM_ORG_REWRITE_TABLES" apps/api/src --include="*.test.ts"`)

- [ ] **Step 1: Extend the allowlist**

```typescript
export const CUSTOM_ORG_REWRITE_TABLES = ['ticket_alert_links', 'time_entries', 'ticket_parts'] as const;
```

- [ ] **Step 2: Add the rewrite statements**

In `moveOrg.ts`, immediately after the `ticket_alert_links` UPDATE (same transaction):

```typescript
// Ticket-linked billing rows denormalize org_id from their ticket (spec §2);
// tickets bound to this device move org with it, so these must follow —
// same stranded-org_id class as ticket_alert_links (#1261).
await tx.execute(
  sql`UPDATE ${sql.identifier('time_entries')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
);
await tx.execute(
  sql`UPDATE ${sql.identifier('ticket_parts')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
);
```

Match the surrounding variable names exactly (`targetOrgId`/`deviceId` — read the existing statement first). Note `time_entries` keeps `partner_id` unchanged — moveOrg is same-partner by definition; if a cross-partner move path exists, the existing tickets handling already governs it.

- [ ] **Step 3: Update the contract/unit test**

If a test enumerates `CUSTOM_ORG_REWRITE_TABLES` or asserts "every org_id table without device_id is either generic-rewritten or custom-listed", add the two tables to its expectations. Run:

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/devices/ --pool=forks
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/routes/devices/moveOrg.ts
git commit -m "fix(ticketing): rewrite time_entries/ticket_parts org_id on cross-org device move"
```

---

### Task 12: Real-driver integration tests

**Files:**
- Create: `apps/api/src/__tests__/integration/time-entries-rls.integration.test.ts`

Requires the local Docker Postgres (`docker compose up -d postgres`). Model fixture setup/teardown on `ticket-validation-rls.integration.test.ts` (partner → org → category → ticket seeding, `withDbAccessContext` for scoped calls). Remember `audit_logs` teardown flakiness ([[test-audit-logs-append-only-flakiness]]) — clean only what this file seeds.

- [ ] **Step 1: Write the tests**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// imports/fixture helpers: copy from ticket-validation-rls.integration.test.ts
// Seed: partnerA + orgA + categoryA(defaultBillable=true, defaultHourlyRate=125.00) + ticketA;
// partnerB + orgB + ticketB; users techA (partnerA), techB (partnerB).

describe('time_entries RLS isolation (partner-axis, Shape 3)', () => {
  it('a partner-scoped context cannot read another partner\'s entries', async () => {
    // insert an entry for partnerB via system context, then:
    await withDbAccessContext(partnerAContext, async () => {
      const rows = await db.select().from(timeEntries);
      expect(rows.every((r) => r.partnerId === partnerA.id)).toBe(true);
    });
  });

  it('a forged cross-partner insert fails with an RLS violation', async () => {
    await withDbAccessContext(partnerAContext, async () => {
      await expect(
        db.insert(timeEntries).values({
          partnerId: partnerB.id, userId: techA.id,
          startedAt: new Date(), endedAt: new Date(Date.now() + 60_000), durationMinutes: 1
        })
      ).rejects.toThrow(/row-level security/);
    });
  });
});

describe('ticket_parts RLS isolation (org-axis, Shape 1)', () => {
  it('a forged cross-org insert fails with an RLS violation', async () => {
    await withDbAccessContext(orgAContext, async () => {
      await expect(
        db.insert(ticketParts).values({
          ticketId: ticketB.id, orgId: orgB.id, description: 'forged', quantity: '1.00'
        })
      ).rejects.toThrow(/row-level security/);
    });
  });
});

describe('timer semantics (D3) — real driver', () => {
  it('two racing startTimer calls leave exactly one running entry', async () => {
    await withDbAccessContext(partnerAContext, async () => {
      await Promise.all([
        startTimer({ description: 'race-1' }, techAActor),
        startTimer({ description: 'race-2' }, techAActor)
      ]);
      const running = await db.select().from(timeEntries)
        .where(and(eq(timeEntries.userId, techA.id), isNull(timeEntries.endedAt)));
      expect(running).toHaveLength(1);
    });
  });

  it('startTimer folds the previous timer with a floored duration', async () => {
    await withDbAccessContext(partnerAContext, async () => {
      await startTimer({ description: 'first' }, techAActor);
      await startTimer({ description: 'second' }, techAActor);
      const stopped = await db.select().from(timeEntries)
        .where(and(eq(timeEntries.userId, techA.id), sql`${timeEntries.endedAt} IS NOT NULL`));
      expect(stopped).toHaveLength(1);
      expect(stopped[0].durationMinutes).toBe(0); // sub-minute, floored
    });
  });
});

describe('category defaults (D2) — real driver', () => {
  it('ticket-linked entry stamps billable + rate from the category and denormalizes org_id', async () => {
    await withDbAccessContext(partnerAContext, async () => {
      const entry = await createTimeEntry({
        ticketId: ticketA.id,
        startedAt: new Date(Date.now() - 30 * 60_000),
        endedAt: new Date()
      }, techAActor);
      expect(entry.isBillable).toBe(true);
      expect(entry.hourlyRate).toBe('125.00');
      expect(entry.orgId).toBe(orgA.id);
    });
  });
});

describe('approval flow (D1) — real driver', () => {
  it('approve stamps fields; a later edit clears approval', async () => {
    await withDbAccessContext(partnerAContext, async () => {
      const entry = await createTimeEntry({
        startedAt: new Date(Date.now() - 60 * 60_000), endedAt: new Date()
      }, techAActor);
      const result = await approveTimeEntries([entry.id], true, adminAActor);
      expect(result.updated).toBe(1);
      const updated = await updateTimeEntry(entry.id, { description: 'edited' }, adminAActor);
      expect(updated.isApproved).toBe(false);
      expect(updated.approvedBy).toBeNull();
    });
  });

  it('a non-admin cannot approve', async () => {
    await expect(approveTimeEntries(['00000000-0000-4000-8000-000000000000'], true, techAActor))
      .rejects.toMatchObject({ code: 'ADMIN_REQUIRED' });
  });
});
```

The actor fixtures: `techAActor = { userId: techA.id, partnerId: partnerA.id, manageAll: false }`, `adminAActor = { ...techAActor, userId: adminA.id, manageAll: true }`. `partnerAContext`/`orgAContext` are the `DbAccessContext` shapes used by the existing integration tests — copy them.

- [ ] **Step 2: Run the integration suite**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.integration.config.ts src/__tests__/integration/time-entries-rls.integration.test.ts
```

Expected: PASS. This is also where the `stopRunningEntry` SQL-duration expression gets validated against the real driver (Task 5 caveat) — if it fails here, switch to the select-then-CAS-update fallback.

- [ ] **Step 3: Verify as breeze_app manually (RLS workflow step 5, CLAUDE.md)**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "INSERT INTO time_entries (partner_id, user_id, started_at) VALUES ('<partnerB-uuid>', '<techA-uuid>', now());"
```

Expected: `new row violates row-level security policy` (no GUC context set → no partner access).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/time-entries-rls.integration.test.ts
git commit -m "test(ticketing): real-driver RLS + timer-race + approval integration coverage"
```

---

### Task 13: Final verification + PR

- [ ] **Step 1: Full affected-area test run (single-fork — [[api-test-suite-parallel-flakiness]])**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/services/timeEntryService.test.ts src/services/timeEntryEvents.test.ts \
  src/routes/timeEntries/ src/routes/tickets/ src/routes/devices/ \
  src/services/aiToolsTicketing.test.ts src/services/aiGuardrails.test.ts \
  src/db/autoMigrate.test.ts --pool=forks
cd ../../packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/timeEntries.test.ts
```

Expected: all PASS. Full-suite failures outside these files: prove pre-existing with a stash+base run before touching anything; trust CI.

- [ ] **Step 2: Type-check + drift check**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```

Expected: clean (modulo the two known pre-existing test-file type errors).

- [ ] **Step 3: Self-review against the spec**

Walk `docs/superpowers/specs/2026-06-11-ticketing-phase3-time-tracking-parts-design.md` §2-§4 + §6 and check every requirement has landed (D1-D5 each have a test asserting them). Confirm NO portal/org read path can reach `time_entries`/`ticket_parts` (grep portal routes for the new tables — expect zero hits).

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/ticketing-time-parts-backend
gh pr create --title "feat(ticketing): Phase 3 backend — time tracking + parts" --body "$(cat <<'EOF'
## Summary
Phase 3 (PR 1 of 2) of native ticketing per docs/superpowers/specs/2026-06-11-ticketing-phase3-time-tracking-parts-design.md:
- `time_entries` (partner-axis, standalone, one running timer per user) + `ticket_parts` (org-axis) with RLS in the creating migration
- `timeEntryService` (D2 category-default rates, D3 auto-stop timers, D1 approval flow, D5 own-vs-all)
- `/time-entries` routes (list/timers/timesheet/bulk-approve), per-ticket parts + billing summary, billables CSV export
- AI tool actions `log_time_entry`/`start_timer`/`stop_timer` (tier 3)
- moveOrg org_id rewrite for both new tables; real-driver RLS/race/approval integration tests

Frontend (timer widget, /timesheet page, ticket-detail UI) lands in PR 2.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then request review per superpowers:requesting-code-review.

---

## Out of scope for this PR (PR 2 — frontend)

Timer widget, `/timesheet` page, ticket-detail Time & Billing rail + parts table, TicketFeed `time_entry` renderer, settings export UI, `runAction` enrollment + `no-silent-mutations` TARGET_GLOBS bump, web component tests. A separate plan will be written against the merged API surface.

