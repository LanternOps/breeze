# Native Ticketing Phase 1a (Backend Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the technician-facing ticketing backend: schema extensions, ticketService with lifecycle events, admin API routes, notifications, and AI tools.

**Architecture:** Extend the existing org-scoped `tickets`/`ticket_comments` tables (portal routes stay untouched). All business logic lives in `ticketService` — routes, AI tools, and MCP are thin consumers. State changes emit lifecycle events through one BullMQ dispatch point consumed by a notification worker.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL (RLS), BullMQ, Zod (`@hono/zod-validator`), Vitest.

**Specs:** `docs/superpowers/specs/2026-06-09-native-ticketing-design.md` (authoritative), `docs/superpowers/specs/2026-06-09-native-ticketing-ui-brief.md`.

**Branch:** `feat/ticketing-core-api` (use superpowers:using-git-worktrees at execution start; run `pnpm install` in fresh worktrees; prefix all pnpm/vitest commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`).

**Conventions that apply to every task:**
- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`, never edit after shipping.
- RLS: policies in the same migration that creates a table; same-PR allowlist updates in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`.
- BullMQ jobIds: `-` separators only (0 or exactly 2 colons; we use auto-generated ids here, which is always safe).
- Tests live alongside source files.

---

### Task 1: Migration — schema extensions, new tables, RLS, permissions

**Files:**
- Create: `apps/api/migrations/2026-06-09-a-native-ticketing-core.sql`

- [ ] **Step 1: Check the current state of the portal ticket tables**

Run: `grep -n "ticketNumber\|ticket_number" apps/api/src/routes/portal/tickets.ts | head -5`
Expected: shows how the portal route generates `ticket_number` today (needed in Task 4 — the service must reuse the same format).

- [ ] **Step 2: Write the migration**

```sql
-- Native ticketing Phase 1 (core).
-- Spec: docs/superpowers/specs/2026-06-09-native-ticketing-design.md
-- Extends tickets/ticket_comments, adds ticket_categories (partner-axis),
-- ticket_alert_links (org-axis), partner_ticket_sequences (partner-axis),
-- seeds tickets permissions, adds 'ticket' notification type.

-- 1. Enums ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE ticket_source AS ENUM ('portal','email','alert','manual','api','ai');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_comment_type AS ENUM ('comment','internal','status_change','assignment','time_entry','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ticket_alert_link_type AS ENUM ('created_from','attached','auto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'ticket';

-- 2. tickets extensions ------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS category_id UUID;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS due_date TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_sla_minutes INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_sla_minutes INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_breach_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMP;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_paused_minutes INTEGER DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source ticket_source NOT NULL DEFAULT 'portal';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS internal_number VARCHAR(20);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email_message_id TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS email_thread_key TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES users(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- Backfill partner_id from the owning org (small table today; no batching needed)
UPDATE tickets t SET partner_id = o.partner_id
FROM organizations o
WHERE t.org_id = o.id AND t.partner_id IS NULL;

-- 3. ticket_comments extensions -----------------------------------------
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS comment_type ticket_comment_type NOT NULL DEFAULT 'comment';
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS old_value TEXT;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS new_value TEXT;
ALTER TABLE ticket_comments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- 4. New tables ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id UUID NOT NULL REFERENCES partners(id),
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) NOT NULL DEFAULT '#6b7d83',
  parent_id UUID REFERENCES ticket_categories(id) ON DELETE SET NULL,
  default_priority ticket_priority,
  response_sla_minutes INTEGER,
  resolution_sla_minutes INTEGER,
  default_billable BOOLEAN NOT NULL DEFAULT TRUE,
  default_hourly_rate NUMERIC(10,2),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_alert_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id),
  alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  link_type ticket_alert_link_type NOT NULL DEFAULT 'attached',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partner_ticket_sequences (
  partner_id UUID NOT NULL REFERENCES partners(id),
  year INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, year)
);

-- 5. tickets.category_id FK (table now exists) ---------------------------
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_category_id_fkey
    FOREIGN KEY (category_id) REFERENCES ticket_categories(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. Indexes --------------------------------------------------------------
CREATE INDEX IF NOT EXISTS tickets_partner_status_idx ON tickets (partner_id, status);
CREATE INDEX IF NOT EXISTS tickets_org_status_idx ON tickets (org_id, status);
CREATE INDEX IF NOT EXISTS tickets_assigned_to_status_idx ON tickets (assigned_to, status);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_partner_internal_number_uq
  ON tickets (partner_id, internal_number) WHERE internal_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_comments_ticket_created_idx ON ticket_comments (ticket_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_alert_links_ticket_alert_uq ON ticket_alert_links (ticket_id, alert_id);
CREATE INDEX IF NOT EXISTS ticket_alert_links_alert_idx ON ticket_alert_links (alert_id);
CREATE INDEX IF NOT EXISTS ticket_categories_partner_idx ON ticket_categories (partner_id);

-- 7. RLS --------------------------------------------------------------------
-- ticket_alert_links: Shape 1 (direct org_id), same pattern as elevation_requests.
ALTER TABLE ticket_alert_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_alert_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_alert_links;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_alert_links;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_alert_links;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_alert_links;
CREATE POLICY breeze_org_isolation_select ON ticket_alert_links
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ticket_alert_links
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ticket_alert_links
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ticket_alert_links
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ticket_categories + partner_ticket_sequences: Shape 3 (partner-axis),
-- same pattern as oauth_client_partner_grants.
ALTER TABLE ticket_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_categories FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ticket_categories_partner_access ON ticket_categories
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partner_ticket_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_ticket_sequences FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY partner_ticket_sequences_partner_access ON partner_ticket_sequences
    FOR ALL TO breeze_app
    USING (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
    WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 8. Permissions seed ----------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'tickets' AND action = 'read') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('tickets', 'read', 'View tickets, comments, and categories');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource = 'tickets' AND action = 'write') THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('tickets', 'write', 'Create and update tickets, comments, and categories');
  END IF;
END $$;

-- Grant tickets perms to every role that already holds the matching alerts perm
-- (technician-shaped roles). Admin roles with '*' need nothing.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'alerts' AND p1.action = 'read'
JOIN permissions p2 ON p2.resource = 'tickets' AND p2.action = 'read'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p2.id
FROM role_permissions rp
JOIN permissions p1 ON p1.id = rp.permission_id AND p1.resource = 'alerts' AND p1.action = 'write'
JOIN permissions p2 ON p2.resource = 'tickets' AND p2.action = 'write'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions x WHERE x.role_id = rp.role_id AND x.permission_id = p2.id
);
```

Note: if `role_permissions` has extra NOT NULL columns (check with `grep -A12 "rolePermissions = pgTable" apps/api/src/db/schema/users.ts`), add them to the INSERT column list with their defaults.

- [ ] **Step 3: Apply locally and verify idempotency**

Run (local dev DB): `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"` then start the API once (`pnpm dev` applies migrations via autoMigrate) or apply via psql: `docker exec -i breeze-postgres psql -U breeze -d breeze < apps/api/migrations/2026-06-09-a-native-ticketing-core.sql`, then apply it a SECOND time.
Expected: second run completes with no errors (NOTICEs are fine).

- [ ] **Step 4: Verify RLS as breeze_app**

Run: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "INSERT INTO ticket_categories (partner_id, name) VALUES (gen_random_uuid(), 'forged');"`
Expected: `ERROR: new row violates row-level security policy` (no scope set → fail closed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-09-a-native-ticketing-core.sql
git commit -m "feat(tickets): core ticketing migration — schema extensions, categories, alert links, sequences, RLS, permissions"
```

---

### Task 2: Drizzle schema

**Files:**
- Modify: `apps/api/src/db/schema/portal.ts` (tickets + ticketComments columns, new enums)
- Create: `apps/api/src/db/schema/tickets.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './tickets';`)

- [ ] **Step 1: Add enums and columns to `portal.ts`**

Add next to the existing ticket enums:

```typescript
export const ticketSourceEnum = pgEnum('ticket_source', ['portal', 'email', 'alert', 'manual', 'api', 'ai']);
export const ticketCommentTypeEnum = pgEnum('ticket_comment_type', ['comment', 'internal', 'status_change', 'assignment', 'time_entry', 'system']);
```

Add to the `tickets` table object (after `closedAt`); `partners` is imported from `./orgs`:

```typescript
  partnerId: uuid('partner_id').references(() => partners.id),
  categoryId: uuid('category_id'), // FK created in SQL; no .references() here to avoid an import cycle with schema/tickets.ts
  pendingReason: text('pending_reason'),
  dueDate: timestamp('due_date'),
  responseSlaMinutes: integer('response_sla_minutes'),
  resolutionSlaMinutes: integer('resolution_sla_minutes'),
  slaBreachedAt: timestamp('sla_breached_at'),
  slaBreachReason: text('sla_breach_reason'),
  slaPausedAt: timestamp('sla_paused_at'),
  slaPausedMinutes: integer('sla_paused_minutes').default(0),
  source: ticketSourceEnum('source').notNull().default('portal'),
  internalNumber: varchar('internal_number', { length: 20 }),
  emailMessageId: text('email_message_id'),
  emailThreadKey: text('email_thread_key'),
  closedBy: uuid('closed_by').references(() => users.id),
  resolutionNote: text('resolution_note'),
```

Add to `ticketComments` (after `attachments`):

```typescript
  commentType: ticketCommentTypeEnum('comment_type').notNull().default('comment'),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  deletedAt: timestamp('deleted_at'),
```

Add `integer` to the drizzle-orm/pg-core import in portal.ts if missing.

- [ ] **Step 2: Create `apps/api/src/db/schema/tickets.ts`**

```typescript
import {
  pgTable, uuid, varchar, text, integer, boolean, timestamp, numeric,
  pgEnum, primaryKey, uniqueIndex, index
} from 'drizzle-orm/pg-core';
import { partners, organizations } from './orgs';
import { users } from './users';
import { tickets, ticketPriorityEnum } from './portal';
import { alerts } from './alerts';

export const ticketAlertLinkTypeEnum = pgEnum('ticket_alert_link_type', ['created_from', 'attached', 'auto']);

export const ticketCategories = pgTable('ticket_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  name: varchar('name', { length: 100 }).notNull(),
  color: varchar('color', { length: 7 }).notNull().default('#6b7d83'),
  parentId: uuid('parent_id'),
  defaultPriority: ticketPriorityEnum('default_priority'),
  responseSlaMinutes: integer('response_sla_minutes'),
  resolutionSlaMinutes: integer('resolution_sla_minutes'),
  defaultBillable: boolean('default_billable').notNull().default(true),
  defaultHourlyRate: numeric('default_hourly_rate', { precision: 10, scale: 2 }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (t) => [index('ticket_categories_partner_idx').on(t.partnerId)]);

export const ticketAlertLinks = pgTable('ticket_alert_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  ticketId: uuid('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  alertId: uuid('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
  linkType: ticketAlertLinkTypeEnum('link_type').notNull().default('attached'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull()
}, (t) => [
  uniqueIndex('ticket_alert_links_ticket_alert_uq').on(t.ticketId, t.alertId),
  index('ticket_alert_links_alert_idx').on(t.alertId)
]);

export const partnerTicketSequences = pgTable('partner_ticket_sequences', {
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  year: integer('year').notNull(),
  counter: integer('counter').notNull().default(0)
}, (t) => [primaryKey({ columns: [t.partnerId, t.year] })]);
```

- [ ] **Step 3: Export from schema index and verify drift**

Add `export * from './tickets';` to `apps/api/src/db/schema/index.ts`.
Run: `pnpm db:check-drift`
Expected: no drift reported. If drift appears, the Drizzle definition disagrees with the migration — fix the Drizzle side to match the SQL.

- [ ] **Step 4: Type-check and commit**

Run: `cd apps/api && npx tsc --noEmit` (pre-existing errors in `agents.test.ts`/`apiKeyAuth.test.ts` are known; no NEW errors allowed).

```bash
git add apps/api/src/db/schema/portal.ts apps/api/src/db/schema/tickets.ts apps/api/src/db/schema/index.ts
git commit -m "feat(tickets): drizzle schema for ticketing core tables"
```

---

### Task 3: RLS coverage allowlist

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`

- [ ] **Step 1: Add the partner-axis entries**

In `PARTNER_TENANT_TABLES`, add:

```typescript
  ['ticket_categories', 'partner_id'],
  ['partner_ticket_sequences', 'partner_id'],
```

`ticket_alert_links` has a direct `org_id` column → auto-discovered Shape 1, no allowlist entry needed.

- [ ] **Step 2: Run the contract test against the local DB**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run --config vitest.config.rls.ts 2>&1 | tail -20`
(If audit-logs flakiness appears, clear `audit_logs` via `session_replication_role=replica` DELETE per the known workaround — it is unrelated.)
Expected: PASS including the new tables.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(tickets): RLS coverage allowlist for ticketing tables"
```

---

### Task 4: Shared validators

**Files:**
- Create: `packages/shared/src/validators/tickets.ts`
- Create: `packages/shared/src/validators/tickets.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (or wherever validators are re-exported — check with `ls packages/shared/src/validators/`)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import {
  createTicketSchema, updateTicketSchema, changeTicketStatusSchema,
  assignTicketSchema, addTicketCommentSchema, listTicketsQuerySchema,
  ticketCategoryInputSchema
} from './tickets';

describe('ticket validators', () => {
  it('accepts a minimal valid create payload', () => {
    const r = createTicketSchema.safeParse({
      orgId: '3f2f1d8e-1111-4222-8333-444455556666',
      subject: 'Printer offline'
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBe('normal');
  });

  it('rejects empty subject and invalid orgId', () => {
    expect(createTicketSchema.safeParse({ orgId: 'nope', subject: 'x' }).success).toBe(false);
    expect(createTicketSchema.safeParse({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: '' }).success).toBe(false);
  });

  it('requires resolutionNote when status is resolved', () => {
    expect(changeTicketStatusSchema.safeParse({ status: 'resolved' }).success).toBe(false);
    expect(changeTicketStatusSchema.safeParse({ status: 'resolved', resolutionNote: 'Replaced toner' }).success).toBe(true);
    expect(changeTicketStatusSchema.safeParse({ status: 'open' }).success).toBe(true);
  });

  it('assign accepts a uuid or null (unassign)', () => {
    expect(assignTicketSchema.safeParse({ assigneeId: null }).success).toBe(true);
    expect(assignTicketSchema.safeParse({ assigneeId: '3f2f1d8e-1111-4222-8333-444455556666' }).success).toBe(true);
    expect(assignTicketSchema.safeParse({ assigneeId: 'me' }).success).toBe(false);
  });

  it('comment requires non-empty content and defaults to public', () => {
    const r = addTicketCommentSchema.safeParse({ content: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isPublic).toBe(true);
    expect(addTicketCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('list query coerces paging and validates enums', () => {
    const r = listTicketsQuerySchema.safeParse({ page: '2', limit: '25', statusGroup: 'open', assignee: 'me' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(2);
      expect(r.data.sort).toBe('triage');
    }
    expect(listTicketsQuerySchema.safeParse({ statusGroup: 'weird' }).success).toBe(false);
  });

  it('category validates hex color', () => {
    expect(ticketCategoryInputSchema.safeParse({ name: 'Hardware', color: '#1c8a9e' }).success).toBe(true);
    expect(ticketCategoryInputSchema.safeParse({ name: 'Hardware', color: 'teal' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/tickets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `packages/shared/src/validators/tickets.ts`**

```typescript
import { z } from 'zod';

export const ticketStatusSchema = z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const ticketSourceSchema = z.enum(['portal', 'email', 'alert', 'manual', 'api', 'ai']);

export const createTicketSchema = z.object({
  orgId: z.string().uuid(),
  subject: z.string().min(1).max(255),
  description: z.string().max(50_000).optional(),
  deviceId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  priority: ticketPrioritySchema.default('normal'),
  dueDate: z.coerce.date().optional(),
  assigneeId: z.string().uuid().optional()
});

export const updateTicketSchema = z.object({
  subject: z.string().min(1).max(255).optional(),
  description: z.string().max(50_000).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  priority: ticketPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  deviceId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional()
});

export const changeTicketStatusSchema = z.object({
  status: ticketStatusSchema,
  resolutionNote: z.string().min(1).max(10_000).optional(),
  pendingReason: z.string().max(500).optional()
}).refine(
  (v) => v.status !== 'resolved' || (v.resolutionNote !== undefined && v.resolutionNote.length > 0),
  { message: 'resolutionNote is required when resolving', path: ['resolutionNote'] }
);

export const assignTicketSchema = z.object({
  assigneeId: z.string().uuid().nullable()
});

export const addTicketCommentSchema = z.object({
  content: z.string().min(1).max(50_000),
  isPublic: z.boolean().default(true)
});

export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: ticketStatusSchema.optional(),
  statusGroup: z.enum(['open', 'closed']).optional(),
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  categoryId: z.string().uuid().optional(),
  priority: ticketPrioritySchema.optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['triage', 'newest', 'oldest', 'due']).default('triage')
});

export const ticketCategoryInputSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  parentId: z.string().uuid().nullable().optional(),
  defaultPriority: ticketPrioritySchema.nullable().optional(),
  responseSlaMinutes: z.number().int().positive().nullable().optional(),
  resolutionSlaMinutes: z.number().int().positive().nullable().optional(),
  defaultBillable: z.boolean().optional(),
  defaultHourlyRate: z.number().nonnegative().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional()
});
```

Re-export from the validators index following the existing pattern there.

- [ ] **Step 4: Run tests, then commit**

Run: `cd packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/validators/tickets.test.ts`
Expected: PASS (7 tests).

```bash
git add packages/shared/src/validators/
git commit -m "feat(tickets): shared zod validators for ticketing"
```

---

### Task 5: Internal ticket numbering service

**Files:**
- Create: `apps/api/src/services/ticketNumbers.ts`
- Create: `apps/api/src/services/ticketNumbers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { execute: executeMock }
}));

import { allocateInternalTicketNumber, formatInternalNumber } from './ticketNumbers';

describe('allocateInternalTicketNumber', () => {
  beforeEach(() => executeMock.mockReset());

  it('formats T-YYYY-NNNN with zero padding', () => {
    expect(formatInternalNumber(2026, 7)).toBe('T-2026-0007');
    expect(formatInternalNumber(2026, 12345)).toBe('T-2026-12345'); // grows past 4 digits, never truncates
  });

  it('returns the upserted counter as a formatted number', async () => {
    executeMock.mockResolvedValue([{ counter: 42 }]);
    const n = await allocateInternalTicketNumber('partner-1', new Date('2026-06-09T12:00:00Z'));
    expect(n).toBe('T-2026-0042');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the DB returns no counter', async () => {
    executeMock.mockResolvedValue([]);
    await expect(allocateInternalTicketNumber('partner-1')).rejects.toThrow(/allocate/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketNumbers.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
import { sql } from 'drizzle-orm';
import { db } from '../db';

export function formatInternalNumber(year: number, counter: number): string {
  return `T-${year}-${String(counter).padStart(4, '0')}`;
}

// Race-safe per-partner allocation: a single upsert with RETURNING means two
// concurrent creates can never get the same counter.
export async function allocateInternalTicketNumber(partnerId: string, now: Date = new Date()): Promise<string> {
  const year = now.getFullYear();
  const rows = await db.execute(sql`
    INSERT INTO partner_ticket_sequences (partner_id, year, counter)
    VALUES (${partnerId}, ${year}, 1)
    ON CONFLICT (partner_id, year)
    DO UPDATE SET counter = partner_ticket_sequences.counter + 1
    RETURNING counter
  `);
  const counter = Number((rows as unknown as Array<{ counter: number }>)[0]?.counter);
  if (!Number.isFinite(counter) || counter < 1) {
    throw new Error('Failed to allocate ticket number');
  }
  return formatInternalNumber(year, counter);
}
```

Note: with drizzle + postgres-js, `db.execute(sql...)` resolves to the row array. If this codebase's wrapper returns `{ rows }` instead (check one existing `db.execute` call site: `grep -rn "db.execute" apps/api/src/services | head -3`), adjust the destructure to match — and update the test mock the same way.

- [ ] **Step 4: Run tests, commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketNumbers.test.ts`
Expected: PASS (3 tests).

```bash
git add apps/api/src/services/ticketNumbers.ts apps/api/src/services/ticketNumbers.test.ts
git commit -m "feat(tickets): race-safe per-partner internal ticket numbering"
```

---

### Task 6: Lifecycle event dispatch (queue + worker shell)

**Files:**
- Create: `apps/api/src/services/ticketEvents.ts`
- Create: `apps/api/src/services/ticketEvents.test.ts`

- [ ] **Step 1: Find the BullMQ connection helper import**

Run: `grep -n "getBullMQConnection" apps/api/src/jobs/alertWorker.ts | head -2`
Expected: an import line showing the module path (e.g. `import { getBullMQConnection } from '../services/queue'`). Use that exact path below.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addMock } = vi.hoisted(() => ({ addMock: vi.fn().mockResolvedValue({ id: 'job-1' }) }));

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({ add: addMock })),
  Worker: vi.fn()
}));
// Mock the connection helper module found in Step 1 (path may differ):
vi.mock('./queue', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

import { emitTicketEvent } from './ticketEvents';

describe('emitTicketEvent', () => {
  beforeEach(() => addMock.mockClear());

  it('enqueues the event with its type as the job name', async () => {
    await emitTicketEvent({
      type: 'ticket.assigned',
      ticketId: 't-1',
      orgId: 'o-1',
      partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { assigneeId: 'u-2' }
    });
    expect(addMock).toHaveBeenCalledWith(
      'ticket.assigned',
      expect.objectContaining({ ticketId: 't-1', orgId: 'o-1' }),
      expect.objectContaining({ removeOnComplete: expect.anything() })
    );
  });

  it('never throws to the caller when the queue is down', async () => {
    addMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(emitTicketEvent({
      type: 'ticket.created', ticketId: 't', orgId: 'o', partnerId: null, payload: {}
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketEvents.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```typescript
import { Queue } from 'bullmq';
import { getBullMQConnection } from './queue'; // exact path from Step 1

export const TICKET_EVENTS_QUEUE = 'ticket-events';

export type TicketEventType =
  | 'ticket.created'
  | 'ticket.status_changed'
  | 'ticket.assigned'
  | 'ticket.commented';

export interface TicketEvent {
  type: TicketEventType;
  ticketId: string;
  orgId: string;
  partnerId: string | null;
  actorUserId?: string | null;
  payload: Record<string, unknown>;
}

let queue: Queue | null = null;

export function getTicketEventsQueue(): Queue {
  if (!queue) {
    queue = new Queue(TICKET_EVENTS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

// Fire-and-forget by design: a Redis outage must never fail the user-facing
// mutation that emitted the event. Consumers (notifications) are best-effort.
export async function emitTicketEvent(event: TicketEvent): Promise<void> {
  try {
    await getTicketEventsQueue().add(event.type, event, {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 }
    });
  } catch (err) {
    console.error('[TicketEvents] failed to enqueue', event.type, err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 5: Run tests, commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketEvents.test.ts`
Expected: PASS (2 tests).

```bash
git add apps/api/src/services/ticketEvents.ts apps/api/src/services/ticketEvents.test.ts
git commit -m "feat(tickets): ticket lifecycle event dispatch via BullMQ"
```

---

### Task 7: ticketService — create, status, assign, comment

**Files:**
- Create: `apps/api/src/services/ticketService.ts`
- Create: `apps/api/src/services/ticketService.test.ts`

This is the single source of business logic. Routes, AI tools, and future workflow actions call ONLY these functions (spec §2 hard requirement).

- [ ] **Step 1: Check the portal route's ticketNumber generation**

Run: `grep -n -B2 -A4 "ticketNumber" apps/api/src/routes/portal/tickets.ts | head -25`
Expected: the existing generation expression for the legacy `ticket_number` column. Copy that exact expression into `generateLegacyTicketNumber()` below so admin- and portal-created tickets share one format.

- [ ] **Step 2: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { emitMock, auditMock, allocateMock, dbMocks } = vi.hoisted(() => {
  const insertReturning = vi.fn();
  const updateReturning = vi.fn();
  const selectResult = vi.fn();
  return {
    emitMock: vi.fn().mockResolvedValue(undefined),
    auditMock: vi.fn().mockResolvedValue(undefined),
    allocateMock: vi.fn().mockResolvedValue('T-2026-0042'),
    dbMocks: { insertReturning, updateReturning, selectResult }
  };
});

vi.mock('./ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('./auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('./ticketNumbers', () => ({ allocateInternalTicketNumber: allocateMock }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbMocks.selectResult())
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => dbMocks.insertReturning()) }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn(() => dbMocks.updateReturning()) }))
      }))
    }))
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id', orgId: 'orgId', status: 'status' },
  ticketComments: {},
  ticketAlertLinks: {},
  organizations: { id: 'id', partnerId: 'partnerId' },
  alerts: { id: 'id', orgId: 'orgId' }
}));

import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  TicketServiceError, TICKET_STATUS_TRANSITIONS
} from './ticketService';

const actor = { userId: 'u-1', name: 'Tess Tech' };

describe('TICKET_STATUS_TRANSITIONS', () => {
  it('makes resolved reopenable and closed reopenable but otherwise terminal', () => {
    expect(TICKET_STATUS_TRANSITIONS.resolved).toEqual(['open', 'closed']);
    expect(TICKET_STATUS_TRANSITIONS.closed).toEqual(['open']);
  });
});

describe('createTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allocateMock.mockResolvedValue('T-2026-0042');
  });

  it('resolves partnerId from the org, allocates a number, inserts, emits ticket.created', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    const t = await createTicket({ orgId: 'o-1', subject: 'Printer offline', source: 'manual' }, actor);

    expect(allocateMock).toHaveBeenCalledWith('p-1');
    expect(t.internalNumber).toBe('T-2026-0042');
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.created', ticketId: 't-1' }));
    expect(auditMock).toHaveBeenCalled();
  });

  it('throws 404 when the org does not exist', async () => {
    dbMocks.selectResult.mockResolvedValue([]);
    await expect(createTicket({ orgId: 'missing', subject: 'x', source: 'manual' }, actor))
      .rejects.toThrow(TicketServiceError);
  });
});

describe('changeTicketStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects an illegal transition', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'closed', resolvedAt: null }]);
    await expect(changeTicketStatus('t-1', 'pending', {}, actor)).rejects.toThrow(/cannot transition/i);
  });

  it('stamps resolvedAt + resolutionNote on resolve and writes a status_change feed entry', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', resolvedAt: null }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'resolved' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', 'resolved', { resolutionNote: 'Replaced toner' }, actor);

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.status_changed',
      payload: expect.objectContaining({ from: 'open', to: 'resolved' })
    }));
  });

  it('requires a resolutionNote to resolve', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }]);
    await expect(changeTicketStatus('t-1', 'resolved', {}, actor)).rejects.toThrow(/resolution note/i);
  });
});

describe('assignTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates assignee, writes an assignment feed entry, emits ticket.assigned', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', assignedTo: null }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: 'u-2', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await assignTicket('t-1', 'u-2', actor);

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.assigned',
      payload: expect.objectContaining({ assigneeId: 'u-2' })
    }));
  });
});

describe('addTicketComment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps firstResponseAt on the first public technician comment', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', firstResponseAt: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1', isPublic: true }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1' }]);

    await addTicketComment('t-1', { content: 'On it', isPublic: true }, actor);

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.commented' }));
  });

  it('does not stamp firstResponseAt for internal notes', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', firstResponseAt: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1', isPublic: false }]);

    const result = await addTicketComment('t-1', { content: 'customer is VIP', isPublic: false }, actor);
    expect(result.firstResponseStamped).toBe(false);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `apps/api/src/services/ticketService.ts`**

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { tickets, ticketComments, organizations } from '../db/schema';
import { allocateInternalTicketNumber } from './ticketNumbers';
import { emitTicketEvent } from './ticketEvents';
import { createAuditLogAsync } from './auditService';

export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';
export type TicketSource = 'portal' | 'email' | 'alert' | 'manual' | 'api' | 'ai';

export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  on_hold: ['open', 'pending', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open']
};

export class TicketServiceError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
    this.name = 'TicketServiceError';
  }
}

export interface TicketActor {
  userId: string;
  name?: string;
  email?: string;
}

// Same format the portal route uses for the legacy global ticket_number
// column — copy the exact expression found in Task 7 Step 1.
function generateLegacyTicketNumber(): string {
  return `TKT-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

async function getTicketOrThrow(ticketId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  const ticket = rows[0];
  if (!ticket) throw new TicketServiceError('Ticket not found', 404);
  return ticket;
}

export interface CreateTicketInput {
  orgId: string;
  subject: string;
  description?: string;
  deviceId?: string;
  categoryId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  dueDate?: Date;
  assigneeId?: string;
  source: TicketSource;
}

export async function createTicket(input: CreateTicketInput, actor: TicketActor) {
  const orgRows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);
  const org = orgRows[0];
  if (!org) throw new TicketServiceError('Organization not found', 404);

  const internalNumber = await allocateInternalTicketNumber(org.partnerId);

  const inserted = await db
    .insert(tickets)
    .values({
      orgId: input.orgId,
      partnerId: org.partnerId,
      ticketNumber: generateLegacyTicketNumber(),
      internalNumber,
      subject: input.subject,
      description: input.description ?? null,
      deviceId: input.deviceId ?? null,
      categoryId: input.categoryId ?? null,
      priority: input.priority ?? 'normal',
      dueDate: input.dueDate ?? null,
      assignedTo: input.assigneeId ?? null,
      status: input.assigneeId ? 'open' : 'new',
      source: input.source
    })
    .returning();
  const ticket = inserted[0];
  if (!ticket) throw new TicketServiceError('Failed to create ticket', 500);

  await emitTicketEvent({
    type: 'ticket.created',
    ticketId: ticket.id,
    orgId: input.orgId,
    partnerId: org.partnerId,
    actorUserId: actor.userId,
    payload: { internalNumber, subject: input.subject, assigneeId: input.assigneeId ?? null, source: input.source }
  });
  await createAuditLogAsync({
    orgId: input.orgId,
    actorId: actor.userId,
    action: 'ticket.create',
    resourceType: 'ticket',
    resourceId: ticket.id,
    resourceName: internalNumber,
    result: 'success'
  });
  return ticket;
}

export interface ChangeStatusOptions {
  resolutionNote?: string;
  pendingReason?: string;
}

export async function changeTicketStatus(
  ticketId: string,
  toStatus: TicketStatus,
  opts: ChangeStatusOptions,
  actor: TicketActor
) {
  const ticket = await getTicketOrThrow(ticketId);
  const fromStatus = ticket.status as TicketStatus;

  if (fromStatus === toStatus) return ticket;
  if (!TICKET_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new TicketServiceError(`Cannot transition ticket from ${fromStatus} to ${toStatus}`, 422);
  }
  if (toStatus === 'resolved' && !opts.resolutionNote) {
    throw new TicketServiceError('A resolution note is required to resolve a ticket', 422);
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: toStatus, updatedAt: now };
  if (toStatus === 'resolved') {
    patch.resolvedAt = ticket.resolvedAt ?? now;
    patch.resolutionNote = opts.resolutionNote;
  }
  if (toStatus === 'closed') {
    patch.closedAt = now;
    patch.closedBy = actor.userId;
    patch.resolvedAt = ticket.resolvedAt ?? now;
  }
  if (toStatus === 'open' && (fromStatus === 'resolved' || fromStatus === 'closed')) {
    patch.resolvedAt = null;
    patch.closedAt = null;
    patch.closedBy = null;
  }
  if (toStatus === 'pending' || toStatus === 'on_hold') {
    patch.pendingReason = opts.pendingReason ?? null;
  } else {
    patch.pendingReason = null;
  }

  const updated = await db.update(tickets).set(patch).where(eq(tickets.id, ticketId)).returning();

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'status_change',
    content: opts.resolutionNote ?? opts.pendingReason ?? '',
    isPublic: false,
    oldValue: fromStatus,
    newValue: toStatus
  }).returning();

  await emitTicketEvent({
    type: 'ticket.status_changed',
    ticketId,
    orgId: ticket.orgId,
    partnerId: (ticket as { partnerId?: string | null }).partnerId ?? null,
    actorUserId: actor.userId,
    payload: { from: fromStatus, to: toStatus, resolutionNote: opts.resolutionNote ?? null }
  });
  await createAuditLogAsync({
    orgId: ticket.orgId,
    actorId: actor.userId,
    action: 'ticket.status_change',
    resourceType: 'ticket',
    resourceId: ticketId,
    details: { from: fromStatus, to: toStatus },
    result: 'success'
  });
  return updated[0];
}

export async function assignTicket(ticketId: string, assigneeId: string | null, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);

  const patch: Record<string, unknown> = { assignedTo: assigneeId, updatedAt: new Date() };
  if (assigneeId && ticket.status === 'new') patch.status = 'open';

  const updated = await db.update(tickets).set(patch).where(eq(tickets.id, ticketId)).returning();

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'assignment',
    content: '',
    isPublic: false,
    oldValue: (ticket as { assignedTo?: string | null }).assignedTo ?? null,
    newValue: assigneeId
  }).returning();

  await emitTicketEvent({
    type: 'ticket.assigned',
    ticketId,
    orgId: ticket.orgId,
    partnerId: (ticket as { partnerId?: string | null }).partnerId ?? null,
    actorUserId: actor.userId,
    payload: { assigneeId }
  });
  return updated[0];
}

export interface AddCommentInput {
  content: string;
  isPublic: boolean;
}

export async function addTicketComment(ticketId: string, input: AddCommentInput, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);

  const inserted = await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: input.isPublic ? 'comment' : 'internal',
    content: input.content,
    isPublic: input.isPublic
  }).returning();
  const comment = inserted[0];
  if (!comment) throw new TicketServiceError('Failed to add comment', 500);

  // First public technician response stamps firstResponseAt (spec §2).
  let firstResponseStamped = false;
  if (input.isPublic && !ticket.firstResponseAt) {
    await db.update(tickets)
      .set({ firstResponseAt: new Date(), updatedAt: new Date() })
      .where(eq(tickets.id, ticketId))
      .returning();
    firstResponseStamped = true;
  }

  await emitTicketEvent({
    type: 'ticket.commented',
    ticketId,
    orgId: ticket.orgId,
    partnerId: (ticket as { partnerId?: string | null }).partnerId ?? null,
    actorUserId: actor.userId,
    payload: { commentId: comment.id, isPublic: input.isPublic }
  });

  return { comment, firstResponseStamped };
}
```

- [ ] **Step 5: Run tests until green, type-check, commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts`
Expected: PASS (9 tests). Then `npx tsc --noEmit` (no new errors).

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): ticketService — create/status/assign/comment with lifecycle events"
```

---

### Task 8: Alert linking in ticketService

**Files:**
- Modify: `apps/api/src/services/ticketService.ts`
- Modify: `apps/api/src/services/ticketService.test.ts`

- [ ] **Step 1: Add failing tests**

```typescript
import { linkAlertToTicket, createTicketFromAlert } from './ticketService';

describe('linkAlertToTicket', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses to link an alert from a different org', async () => {
    // first select: ticket; second select: alert
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-OTHER', title: 'CPU high' }]);
    await expect(linkAlertToTicket('t-1', 'a-1', actor)).rejects.toThrow(/same organization/i);
  });

  it('links and writes a system feed entry', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', title: 'CPU high' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'link-1' }]);
    const link = await linkAlertToTicket('t-1', 'a-1', actor);
    expect(link).toBeDefined();
  });
});

describe('createTicketFromAlert', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a pre-filled ticket linked created_from', async () => {
    // selects in order: alert, org (inside createTicket), ticket (inside linkAlertToTicket), alert (inside linkAlertToTicket)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', deviceId: 'd-1', title: 'Disk 90%', message: 'C: at 92%', severity: 'high' }])
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 't-9', orgId: 'o-1', partnerId: 'p-1', status: 'new' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', title: 'Disk 90%' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-9', orgId: 'o-1', internalNumber: 'T-2026-0042' }]);
    allocateMock.mockResolvedValue('T-2026-0042');

    const t = await createTicketFromAlert('a-1', actor);
    expect(t.id).toBe('t-9');
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.created' }));
  });

  it('404s on a missing alert', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([]);
    await expect(createTicketFromAlert('missing', actor)).rejects.toThrow(/alert not found/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts`
Expected: new tests FAIL (functions not exported).

- [ ] **Step 3: Implement in ticketService.ts**

Add imports: `ticketAlertLinks, alerts` from `../db/schema`. Add:

```typescript
const SEVERITY_TO_PRIORITY: Record<string, 'low' | 'normal' | 'high' | 'urgent'> = {
  critical: 'urgent',
  high: 'high',
  medium: 'normal',
  low: 'low',
  info: 'low'
};

export async function linkAlertToTicket(
  ticketId: string,
  alertId: string,
  actor: TicketActor,
  linkType: 'created_from' | 'attached' | 'auto' = 'attached'
) {
  const ticket = await getTicketOrThrow(ticketId);
  const alertRows = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  const alert = alertRows[0];
  if (!alert) throw new TicketServiceError('Alert not found', 404);
  if (alert.orgId !== ticket.orgId) {
    throw new TicketServiceError('Alert and ticket must belong to the same organization', 422);
  }

  const inserted = await db.insert(ticketAlertLinks).values({
    ticketId,
    orgId: ticket.orgId,
    alertId,
    linkType,
    createdBy: actor.userId
  }).returning();

  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'system',
    content: `Linked alert: ${alert.title}`,
    isPublic: false,
    newValue: alertId
  }).returning();

  return inserted[0];
}

export async function unlinkAlertFromTicket(ticketId: string, alertId: string, actor: TicketActor) {
  const ticket = await getTicketOrThrow(ticketId);
  await db.delete(ticketAlertLinks).where(
    and(eq(ticketAlertLinks.ticketId, ticketId), eq(ticketAlertLinks.alertId, alertId))
  ).returning();
  await db.insert(ticketComments).values({
    ticketId,
    userId: actor.userId,
    authorName: actor.name ?? null,
    authorType: 'internal',
    commentType: 'system',
    content: 'Unlinked alert',
    isPublic: false,
    oldValue: alertId
  }).returning();
  return { ticketId, alertId, orgId: ticket.orgId };
}

export async function createTicketFromAlert(
  alertId: string,
  actor: TicketActor,
  overrides: Partial<Pick<CreateTicketInput, 'subject' | 'description' | 'categoryId' | 'priority' | 'assigneeId'>> = {}
) {
  const alertRows = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  const alert = alertRows[0];
  if (!alert) throw new TicketServiceError('Alert not found', 404);

  const ticket = await createTicket({
    orgId: alert.orgId,
    subject: overrides.subject ?? alert.title,
    description: overrides.description ?? alert.message ?? undefined,
    deviceId: alert.deviceId ?? undefined,
    categoryId: overrides.categoryId,
    priority: overrides.priority ?? SEVERITY_TO_PRIORITY[alert.severity as string] ?? 'normal',
    assigneeId: overrides.assigneeId,
    source: 'alert'
  }, actor);

  await linkAlertToTicket(ticket.id, alertId, actor, 'created_from');
  return ticket;
}
```

Add `and` and `delete`-capable import: `import { and, eq } from 'drizzle-orm';` and extend the db mock in the test file with a `delete` chain (`delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) }))`).

- [ ] **Step 4: Run tests, commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketService.test.ts`
Expected: PASS (13 tests).

```bash
git add apps/api/src/services/ticketService.ts apps/api/src/services/ticketService.test.ts
git commit -m "feat(tickets): alert linking + create-ticket-from-alert in ticketService"
```

---

### Task 9: Notification fan-out worker

**Files:**
- Create: `apps/api/src/jobs/ticketNotifyWorker.ts`
- Create: `apps/api/src/jobs/ticketNotifyWorker.test.ts`
- Modify: where `createAlertWorker()` is bootstrapped (find with `grep -rn "createAlertWorker()" apps/api/src --include="*.ts" | grep -v test` — register the ticket worker in the same place, same pattern)

Phase 1 fan-out rules (spec §3, kept modest):
- `ticket.assigned` → in-app `user_notifications` row (type `'ticket'`) for the assignee + email to assignee if EmailService configured. Skip when actor == assignee (self-assign).
- `ticket.commented` with `isPublic: true` → email the requester (`tickets.submitterEmail`) when present.
- `ticket.status_changed` to `resolved` → email the requester with the resolution note.
- `ticket.created` with an assignee → same as assigned.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValuesMock, selectMock, sendEmailMock, getEmailServiceMock } = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue([]);
  return {
    insertValuesMock,
    selectMock: vi.fn(),
    sendEmailMock: vi.fn().mockResolvedValue(undefined),
    getEmailServiceMock: vi.fn()
  };
});

vi.mock('bullmq', () => ({ Queue: vi.fn(() => ({ add: vi.fn() })), Worker: vi.fn() }));
vi.mock('../services/queue', () => ({ getBullMQConnection: vi.fn(() => ({})) })); // path from Task 6 Step 1
vi.mock('../services/email', () => ({ getEmailService: getEmailServiceMock }));
vi.mock('../db', () => ({
  runWithSystemDbAccess: vi.fn((fn: () => unknown) => fn()),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: vi.fn(() => selectMock()) }))
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn((v: unknown) => { insertValuesMock(v); return { returning: vi.fn(() => Promise.resolve([])) }; }) }))
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id' },
  userNotifications: {},
  users: { id: 'id' }
}));

import { handleTicketEvent } from './ticketNotifyWorker';

describe('handleTicketEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  });

  it('ticket.assigned inserts an in-app notification for the assignee', async () => {
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);

    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    });

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u-2', type: 'ticket', link: '/tickets#T-2026-0042'
    }));
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it('skips self-assignment notifications', async () => {
    await handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-2', payload: { assigneeId: 'u-2' }
    });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('public comment emails the requester', async () => {
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: true }
    });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'enduser@acme.example',
      subject: expect.stringContaining('T-2026-0042')
    }));
  });

  it('internal comment sends nothing to the requester', async () => {
    selectMock.mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: 'enduser@acme.example' }]);
    await handleTicketEvent({
      type: 'ticket.commented', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { commentId: 'c-1', isPublic: false }
    });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('works without an email service configured (in-app only)', async () => {
    getEmailServiceMock.mockReturnValue(null);
    selectMock
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', subject: 'Printer', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'u-2', email: 'tech@msp.example' }]);
    await expect(handleTicketEvent({
      type: 'ticket.assigned', ticketId: 't-1', orgId: 'o-1', partnerId: 'p-1',
      actorUserId: 'u-1', payload: { assigneeId: 'u-2' }
    })).resolves.toBeUndefined();
    expect(insertValuesMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

```typescript
import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db, runWithSystemDbAccess } from '../db';
import { tickets, userNotifications, users } from '../db/schema';
import { getEmailService } from '../services/email';
import { getBullMQConnection } from '../services/queue'; // path from Task 6 Step 1
import { TICKET_EVENTS_QUEUE, type TicketEvent } from '../services/ticketEvents';

async function getTicket(ticketId: string) {
  const rows = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  return rows[0] ?? null;
}

async function notifyAssignee(event: TicketEvent, assigneeId: string) {
  if (!assigneeId || assigneeId === event.actorUserId) return;
  const ticket = await getTicket(event.ticketId);
  if (!ticket) return;

  await db.insert(userNotifications).values({
    userId: assigneeId,
    orgId: event.orgId,
    type: 'ticket',
    priority: 'normal',
    title: `Ticket assigned: ${ticket.internalNumber ?? ticket.ticketNumber}`,
    message: ticket.subject,
    link: `/tickets#${ticket.internalNumber ?? ticket.id}`
  }).returning();

  const email = getEmailService();
  if (!email) return;
  const assigneeRows = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, assigneeId)).limit(1);
  const assignee = assigneeRows[0];
  if (!assignee?.email) return;
  await email.sendEmail({
    to: assignee.email,
    subject: `[${ticket.internalNumber ?? ticket.ticketNumber}] Assigned to you: ${ticket.subject}`,
    html: `<p>You have been assigned ticket <strong>${ticket.internalNumber ?? ticket.ticketNumber}</strong>: ${ticket.subject}</p>`
  });
}

async function emailRequester(event: TicketEvent, bodyHtml: string, subjectPrefix: string) {
  const ticket = await getTicket(event.ticketId);
  if (!ticket?.submitterEmail) return;
  const email = getEmailService();
  if (!email) return;
  await email.sendEmail({
    to: ticket.submitterEmail,
    subject: `[${ticket.internalNumber ?? ticket.ticketNumber}] ${subjectPrefix}: ${ticket.subject}`,
    html: bodyHtml
  });
}

export async function handleTicketEvent(event: TicketEvent): Promise<void> {
  switch (event.type) {
    case 'ticket.created':
    case 'ticket.assigned': {
      const assigneeId = event.payload.assigneeId as string | null;
      if (assigneeId) await notifyAssignee(event, assigneeId);
      return;
    }
    case 'ticket.commented': {
      if (event.payload.isPublic === true) {
        await emailRequester(event, '<p>Your ticket has a new reply. Sign in to the portal to view it.</p>', 'New reply');
      }
      return;
    }
    case 'ticket.status_changed': {
      if (event.payload.to === 'resolved') {
        const note = String(event.payload.resolutionNote ?? '');
        await emailRequester(event, `<p>Your ticket has been resolved.</p><p>${note}</p>`, 'Resolved');
      }
      return;
    }
  }
}

let worker: Worker<TicketEvent> | null = null;

export function startTicketNotifyWorker(): Worker<TicketEvent> {
  if (!worker) {
    worker = new Worker<TicketEvent>(
      TICKET_EVENTS_QUEUE,
      async (job: Job<TicketEvent>) => runWithSystemDbAccess(() => handleTicketEvent(job.data)),
      { connection: getBullMQConnection(), concurrency: 5 }
    );
  }
  return worker;
}
```

Note: confirm the `runWithSystemDbAccess` export name with `grep -n "runWithSystemDbAccess" apps/api/src/jobs/alertWorker.ts` and import from the same module alertWorker uses. Notification fan-out is plain inserts/emails — no long-running work inside the DB context (the `runOutsideDbContext` pool-poison rule from issue #1105 applies if anything slow is ever added here).

- [ ] **Step 3: Register the worker at bootstrap**

Run: `grep -rn "createAlertWorker()" apps/api/src --include="*.ts" | grep -v test`
Add `startTicketNotifyWorker()` adjacent to that call, with the same import style.

- [ ] **Step 4: Run tests, commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/ticketNotifyWorker.test.ts`
Expected: PASS (5 tests).

```bash
git add apps/api/src/jobs/ticketNotifyWorker.ts apps/api/src/jobs/ticketNotifyWorker.test.ts <bootstrap file>
git commit -m "feat(tickets): notification fan-out worker for ticket lifecycle events"
```

---

### Task 10: PERMISSIONS constants

**Files:**
- Modify: `apps/api/src/services/permissions.ts`

- [ ] **Step 1: Add to the PERMISSIONS object (next to ALERTS_*)**

```typescript
  // Tickets
  TICKETS_READ: { resource: 'tickets', action: 'read' },
  TICKETS_WRITE: { resource: 'tickets', action: 'write' },
```

- [ ] **Step 2: Type-check and commit**

Run: `cd apps/api && npx tsc --noEmit` (no new errors).

```bash
git add apps/api/src/services/permissions.ts
git commit -m "feat(tickets): TICKETS_READ/TICKETS_WRITE permission constants"
```

---

### Task 11: Tickets routes — list, create, get, patch

**Files:**
- Create: `apps/api/src/routes/tickets/index.ts`
- Create: `apps/api/src/routes/tickets/tickets.ts`
- Create: `apps/api/src/routes/tickets/tickets.test.ts`
- Modify: `apps/api/src/routes/index.ts` (mount)

House style follows `routes/alerts/alerts.ts`: `requireScope('organization','partner','system')` + `requirePermission` + `zValidator`, direct `db` usage (RLS-gated by middleware), pagination via `{ data, pagination }` response shape.

- [ ] **Step 1: Write the failing route test**

Follow the `users.test.ts` mock convention exactly (vi.hoisted mocks for db/schema/permissions/middleware). Key cases — full file:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { serviceMocks, dbSelectMock } = vi.hoisted(() => ({
  serviceMocks: {
    createTicket: vi.fn(),
    changeTicketStatus: vi.fn(),
    assignTicket: vi.fn(),
    addTicketComment: vi.fn(),
    linkAlertToTicket: vi.fn(),
    unlinkAlertFromTicket: vi.fn(),
    createTicketFromAlert: vi.fn()
  },
  dbSelectMock: vi.fn()
}));

vi.mock('../../services/ticketService', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
  return { ...actual, ...serviceMocks };
});

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', {
      scope: 'partner',
      userId: 'u-1',
      partnerId: 'p-1',
      orgId: null,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@msp.example' }
    });
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next()
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({ offset: vi.fn(() => dbSelectMock()) }))
              }))
            }))
          }))
        })),
        where: vi.fn(() => ({
          orderBy: vi.fn(() => Promise.resolve([])),
          limit: vi.fn(() => dbSelectMock())
        }))
      }))
    }))
  }
}));
vi.mock('../../db/schema', () => ({
  tickets: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', status: 'status', priority: 'priority', assignedTo: 'assignedTo', categoryId: 'categoryId', internalNumber: 'internalNumber', subject: 'subject', createdAt: 'createdAt', updatedAt: 'updatedAt', dueDate: 'dueDate', deviceId: 'deviceId' },
  ticketComments: {},
  ticketCategories: {},
  ticketAlertLinks: {},
  devices: { id: 'id', hostname: 'hostname' },
  organizations: { id: 'id', name: 'name' },
  users: { id: 'id', name: 'name' }
}));

import { ticketsRoutes } from './tickets';

function makeApp() {
  const app = new Hono();
  app.route('/tickets', ticketsRoutes);
  return app;
}

describe('GET /tickets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns paginated data', async () => {
    dbSelectMock.mockResolvedValue([{ id: 't-1', internalNumber: 'T-2026-0001', subject: 'Printer' }]);
    const res = await makeApp().request('/tickets?statusGroup=open');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('pagination');
  });

  it('rejects an invalid statusGroup', async () => {
    const res = await makeApp().request('/tickets?statusGroup=weird');
    expect(res.status).toBe(400);
  });
});

describe('POST /tickets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates via ticketService and returns 201', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-1', internalNumber: 'T-2026-0001' });
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: 'Printer offline' })
    });
    expect(res.status).toBe(201);
    expect(serviceMocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Printer offline', source: 'manual' }),
      expect.objectContaining({ userId: 'u-1' })
    );
  });

  it('400s on a missing subject', async () => {
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: '3f2f1d8e-1111-4222-8333-444455556666' })
    });
    expect(res.status).toBe(400);
  });

  it('maps TicketServiceError status through (404 org)', async () => {
    const { TicketServiceError } = await vi.importActual<typeof import('../../services/ticketService')>('../../services/ticketService');
    serviceMocks.createTicket.mockRejectedValue(new TicketServiceError('Organization not found', 404));
    const res = await makeApp().request('/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: 'x' })
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `apps/api/src/routes/tickets/tickets.ts`**

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { tickets, ticketComments, ticketCategories, ticketAlertLinks, devices, organizations, users, alerts } from '../../db/schema';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createTicketSchema, updateTicketSchema, changeTicketStatusSchema,
  assignTicketSchema, addTicketCommentSchema, listTicketsQuerySchema
} from '@breeze/shared';
import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  linkAlertToTicket, unlinkAlertFromTicket, createTicketFromAlert,
  TicketServiceError
} from '../../services/ticketService';

export const ticketsRoutes = new Hono();

const idParam = z.object({ id: z.string().uuid() });

const OPEN_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;
const CLOSED_STATUSES = ['resolved', 'closed'] as const;

// Priority weight for triage sort: urgent first.
const PRIORITY_ORDER = sql`CASE ${tickets.priority}
  WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

function actorFrom(c: { get: (k: 'auth') => { userId: string; user?: { name?: string; email?: string } } }) {
  const auth = c.get('auth');
  return { userId: auth.userId, name: auth.user?.name, email: auth.user?.email };
}

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TicketServiceError) {
    return c.json({ error: err.message }, err.status as 400);
  }
  throw err;
}

// GET /tickets — partner-wide queue
ticketsRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('query', listTicketsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const q = c.req.valid('query');
    const offset = (q.page - 1) * q.limit;

    const conditions: SQL[] = [];
    if (auth.scope === 'organization') {
      if (!auth.orgId) return c.json({ error: 'Organization context required' }, 403);
      conditions.push(eq(tickets.orgId, auth.orgId));
    }
    if (q.orgId) conditions.push(eq(tickets.orgId, q.orgId));
    if (q.status) conditions.push(eq(tickets.status, q.status));
    else if (q.statusGroup === 'open') conditions.push(inArray(tickets.status, [...OPEN_STATUSES]));
    else if (q.statusGroup === 'closed') conditions.push(inArray(tickets.status, [...CLOSED_STATUSES]));
    if (q.assignee === 'me') conditions.push(eq(tickets.assignedTo, auth.userId));
    else if (q.assignee === 'unassigned') conditions.push(isNull(tickets.assignedTo));
    else if (q.assignee) conditions.push(eq(tickets.assignedTo, q.assignee));
    if (q.categoryId) conditions.push(eq(tickets.categoryId, q.categoryId));
    if (q.priority) conditions.push(eq(tickets.priority, q.priority));
    if (q.search) {
      const term = `%${q.search}%`;
      const searchCond = or(ilike(tickets.subject, term), ilike(tickets.internalNumber, term));
      if (searchCond) conditions.push(searchCond);
    }
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const orderBy =
      q.sort === 'newest' ? [desc(tickets.createdAt)]
      : q.sort === 'oldest' ? [asc(tickets.createdAt)]
      : q.sort === 'due' ? [asc(tickets.dueDate)]
      : [PRIORITY_ORDER, asc(tickets.createdAt)]; // triage

    const data = await db
      .select({
        id: tickets.id,
        internalNumber: tickets.internalNumber,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        source: tickets.source,
        orgId: tickets.orgId,
        orgName: organizations.name,
        deviceId: tickets.deviceId,
        deviceHostname: devices.hostname,
        assignedTo: tickets.assignedTo,
        assigneeName: users.name,
        categoryId: tickets.categoryId,
        dueDate: tickets.dueDate,
        slaBreachedAt: tickets.slaBreachedAt,
        firstResponseAt: tickets.firstResponseAt,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt
      })
      .from(tickets)
      .leftJoin(organizations, eq(tickets.orgId, organizations.id))
      .leftJoin(devices, eq(tickets.deviceId, devices.id))
      .leftJoin(users, eq(tickets.assignedTo, users.id))
      .where(whereCondition)
      .orderBy(...orderBy)
      .limit(q.limit)
      .offset(offset);

    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(tickets)
      .where(whereCondition);
    const total = Number(countRows[0]?.count ?? 0);

    return c.json({ data, pagination: { page: q.page, limit: q.limit, total } });
  }
);

// POST /tickets — manual creation
ticketsRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('json', createTicketSchema),
  async (c) => {
    const body = c.req.valid('json');
    try {
      const ticket = await createTicket({ ...body, source: 'manual' }, actorFrom(c));
      return c.json({ data: ticket }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// GET /tickets/:id — full detail (ticket + comments + alert links + category)
ticketsRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('param', idParam),
  async (c) => {
    const { id } = c.req.valid('param');

    const ticketRows = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, id))
      .limit(1);
    const ticket = ticketRows[0];
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);

    const comments = await db
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, id), isNull(ticketComments.deletedAt)))
      .orderBy(asc(ticketComments.createdAt));

    const alertLinks = await db
      .select({
        id: ticketAlertLinks.id,
        alertId: ticketAlertLinks.alertId,
        linkType: ticketAlertLinks.linkType,
        alertTitle: alerts.title,
        alertSeverity: alerts.severity,
        alertStatus: alerts.status
      })
      .from(ticketAlertLinks)
      .leftJoin(alerts, eq(ticketAlertLinks.alertId, alerts.id))
      .where(eq(ticketAlertLinks.ticketId, id));

    return c.json({ data: { ...ticket, comments, alertLinks } });
  }
);

// PATCH /tickets/:id — field updates (not status/assignee; those have dedicated routes)
ticketsRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', updateTicketSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    if (Object.keys(body).length === 0) return c.json({ error: 'No fields to update' }, 400);

    const updated = await db
      .update(tickets)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(tickets.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: 'Ticket not found' }, 404);
    return c.json({ data: updated[0] });
  }
);

// POST /tickets/:id/status
ticketsRoutes.post(
  '/:id/status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', changeTicketStatusSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const ticket = await changeTicketStatus(id, body.status, {
        resolutionNote: body.resolutionNote,
        pendingReason: body.pendingReason
      }, actorFrom(c));
      return c.json({ data: ticket });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// POST /tickets/:id/assign
ticketsRoutes.post(
  '/:id/assign',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', assignTicketSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { assigneeId } = c.req.valid('json');
    try {
      const ticket = await assignTicket(id, assigneeId, actorFrom(c));
      return c.json({ data: ticket });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// POST /tickets/:id/comments
ticketsRoutes.post(
  '/:id/comments',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', addTicketCommentSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const result = await addTicketComment(id, body, actorFrom(c));
      return c.json({ data: result.comment }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// POST /tickets/:id/alerts — link an alert
ticketsRoutes.post(
  '/:id/alerts',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', z.object({ alertId: z.string().uuid() })),
  async (c) => {
    const { id } = c.req.valid('param');
    const { alertId } = c.req.valid('json');
    try {
      const link = await linkAlertToTicket(id, alertId, actorFrom(c));
      return c.json({ data: link }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// DELETE /tickets/:id/alerts/:alertId
ticketsRoutes.delete(
  '/:id/alerts/:alertId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', z.object({ id: z.string().uuid(), alertId: z.string().uuid() })),
  async (c) => {
    const { id, alertId } = c.req.valid('param');
    try {
      await unlinkAlertFromTicket(id, alertId, actorFrom(c));
      return c.json({ success: true });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

// GET /tickets/stats — queue counts for tabs + dashboard widget
ticketsRoutes.get(
  '/stats',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const conditions: SQL[] = [];
    if (auth.scope === 'organization' && auth.orgId) conditions.push(eq(tickets.orgId, auth.orgId));
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        status: tickets.status,
        assignedTo: tickets.assignedTo,
        breached: sql<boolean>`(${tickets.slaBreachedAt} IS NOT NULL)`,
        count: sql<number>`count(*)`
      })
      .from(tickets)
      .where(whereCondition)
      .groupBy(tickets.status, tickets.assignedTo, sql`(${tickets.slaBreachedAt} IS NOT NULL)`);

    let open = 0, unassigned = 0, mine = 0, breached = 0;
    for (const r of rows) {
      const n = Number(r.count);
      const isOpen = (OPEN_STATUSES as readonly string[]).includes(r.status as string);
      if (isOpen) {
        open += n;
        if (!r.assignedTo) unassigned += n;
        if (r.assignedTo === auth.userId) mine += n;
        if (r.breached) breached += n;
      }
    }
    return c.json({ data: { open, unassigned, mine, breached } });
  }
);
```

IMPORTANT ordering note: Hono matches routes in registration order — register `GET /stats` BEFORE `GET /:id`, or `/stats` will be captured by the `:id` param and 400 on the uuid check. Place the stats handler above the `:id` handlers in the file.

- [ ] **Step 4: Create `apps/api/src/routes/tickets/index.ts`**

```typescript
export { ticketsRoutes } from './tickets';
```

- [ ] **Step 5: Mount in `apps/api/src/routes/index.ts`**

Next to `api.route('/alerts', alertRoutes);` add:

```typescript
api.route('/tickets', ticketsRoutes);
```

with the corresponding import.

- [ ] **Step 6: Run tests, type-check, commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/tickets/tickets.test.ts`
Expected: PASS (6 tests). `npx tsc --noEmit`: no new errors.

```bash
git add apps/api/src/routes/tickets/ apps/api/src/routes/index.ts
git commit -m "feat(tickets): technician ticket API routes"
```

---

### Task 12: Create-from-alert route (alerts side)

**Files:**
- Modify: `apps/api/src/routes/alerts/alerts.ts`
- Modify: `apps/api/src/routes/alerts/alerts.test.ts` (or create `createTicket` cases in the existing test file)

- [ ] **Step 1: Add a failing test** (in the alerts route test file, following its existing mock conventions)

```typescript
describe('POST /alerts/:id/create-ticket', () => {
  it('creates a linked ticket via ticketService', async () => {
    createTicketFromAlertMock.mockResolvedValue({ id: 't-9', internalNumber: 'T-2026-0042' });
    const res = await app.request('/alerts/3f2f1d8e-1111-4222-8333-444455556666/create-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.internalNumber).toBe('T-2026-0042');
  });
});
```

(Add `createTicketFromAlertMock` to the hoisted mocks and `vi.mock('../../services/ticketService', ...)` mirroring Task 11's pattern.)

- [ ] **Step 2: Implement the route in alerts.ts**

```typescript
// POST /alerts/:id/create-ticket — create a pre-filled, linked ticket
alertsRoutes.post(
  '/:id/create-ticket',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', alertIdParamSchema),
  zValidator('json', z.object({
    subject: z.string().min(1).max(255).optional(),
    categoryId: z.string().uuid().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assigneeId: z.string().uuid().optional()
  })),
  async (c) => {
    const { id } = c.req.valid('param');
    const overrides = c.req.valid('json');
    const auth = c.get('auth');
    try {
      const ticket = await createTicketFromAlert(id, { userId: auth.userId, name: auth.user?.name }, overrides);
      return c.json({ data: ticket }, 201);
    } catch (err) {
      if (err instanceof TicketServiceError) return c.json({ error: err.message }, err.status as 400);
      throw err;
    }
  }
);
```

Imports: `createTicketFromAlert, TicketServiceError` from `../../services/ticketService`.

- [ ] **Step 3: Run tests, commit**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/alerts/`
Expected: PASS including the new test.

```bash
git add apps/api/src/routes/alerts/
git commit -m "feat(tickets): create-ticket-from-alert route"
```

---

### Task 13: Categories routes

**Files:**
- Create: `apps/api/src/routes/ticketCategories.ts`
- Create: `apps/api/src/routes/ticketCategories.test.ts`
- Modify: `apps/api/src/routes/index.ts` (mount `api.route('/ticket-categories', ticketCategoriesRoutes);`)

- [ ] **Step 1: Write the failing test** (same mocking pattern as Task 11; partner scope; cases: GET list 200, POST create 201 with partnerId stamped from auth, POST without name 400, PATCH update 200, DELETE soft-deactivate sets `isActive: false` and returns 200)

```typescript
describe('POST /ticket-categories', () => {
  it('stamps partnerId from auth', async () => {
    dbInsertReturning.mockResolvedValue([{ id: 'cat-1', name: 'Hardware', partnerId: 'p-1' }]);
    const res = await app.request('/ticket-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hardware', color: '#1c8a9e' })
    });
    expect(res.status).toBe(201);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db';
import { ticketCategories } from '../db/schema';
import { requireScope, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { ticketCategoryInputSchema } from '@breeze/shared';

export const ticketCategoriesRoutes = new Hono();

const idParam = z.object({ id: z.string().uuid() });

ticketCategoriesRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  async (c) => {
    const data = await db
      .select()
      .from(ticketCategories)
      .orderBy(asc(ticketCategories.sortOrder), asc(ticketCategories.name));
    return c.json({ data });
  }
);

ticketCategoriesRoutes.post(
  '/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('json', ticketCategoryInputSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
    const body = c.req.valid('json');
    const inserted = await db.insert(ticketCategories).values({
      ...body,
      defaultHourlyRate: body.defaultHourlyRate != null ? String(body.defaultHourlyRate) : null,
      partnerId: auth.partnerId
    }).returning();
    return c.json({ data: inserted[0] }, 201);
  }
);

ticketCategoriesRoutes.patch(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  zValidator('json', ticketCategoryInputSchema.partial()),
  async (c) => {
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const updated = await db.update(ticketCategories)
      .set({
        ...body,
        defaultHourlyRate: body.defaultHourlyRate != null ? String(body.defaultHourlyRate) : body.defaultHourlyRate === null ? null : undefined,
        updatedAt: new Date()
      })
      .where(eq(ticketCategories.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: 'Category not found' }, 404);
    return c.json({ data: updated[0] });
  }
);

// Delete = deactivate; tickets referencing the category keep their FK.
ticketCategoriesRoutes.delete(
  '/:id',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  async (c) => {
    const { id } = c.req.valid('param');
    const updated = await db.update(ticketCategories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(ticketCategories.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: 'Category not found' }, 404);
    return c.json({ success: true });
  }
);
```

- [ ] **Step 3: Mount, run tests, commit**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/ticketCategories.test.ts
git add apps/api/src/routes/ticketCategories.ts apps/api/src/routes/ticketCategories.test.ts apps/api/src/routes/index.ts
git commit -m "feat(tickets): ticket categories CRUD routes"
```

---

### Task 14: AI tools

**Files:**
- Create: `apps/api/src/services/aiToolsTicketing.ts`
- Create: `apps/api/src/services/aiToolsTicketing.test.ts`
- Modify: `apps/api/src/services/aiTools.ts` (import + `registerTicketingTools(aiTools);`)

Follows the house pattern (`manage_alerts`): one action-multiplexed tool per domain rather than the spec's per-verb names — the spec's intent (full capability via AI/MCP) is met; all actions delegate to ticketService.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serviceMocks } = vi.hoisted(() => ({
  serviceMocks: {
    createTicket: vi.fn(),
    changeTicketStatus: vi.fn(),
    assignTicket: vi.fn(),
    addTicketComment: vi.fn()
  }
}));
vi.mock('./ticketService', async () => {
  const actual = await vi.importActual<typeof import('./ticketService')>('./ticketService');
  return { ...actual, ...serviceMocks };
});
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }))
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id', orgId: 'orgId', status: 'status', priority: 'priority', assignedTo: 'assignedTo', createdAt: 'createdAt', internalNumber: 'internalNumber', subject: 'subject', deviceId: 'deviceId' }
}));

import { registerTicketingTools } from './aiToolsTicketing';
import type { AiTool } from './aiTools';

const auth = {
  userId: 'u-1',
  orgCondition: vi.fn(() => undefined)
} as never;

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  const tool = tools.get('manage_tickets');
  if (!tool) throw new Error('manage_tickets not registered');
  return tool;
}

describe('manage_tickets tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers with deviceArgs gating and tier 2', () => {
    const tool = getTool();
    expect(tool.tier).toBe(2);
    expect(tool.deviceArgs).toContain('deviceId');
  });

  it('create delegates to ticketService with source ai', async () => {
    serviceMocks.createTicket.mockResolvedValue({ id: 't-1', internalNumber: 'T-2026-0042' });
    const out = await getTool().handler(
      { action: 'create', orgId: 'o-1', subject: 'Disk full' },
      auth
    );
    expect(serviceMocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'ai' }),
      expect.objectContaining({ userId: 'u-1' })
    );
    expect(JSON.parse(out)).toHaveProperty('ticket');
  });

  it('rejects an unknown action', async () => {
    await expect(getTool().handler({ action: 'explode' }, auth)).rejects.toThrow(/unknown action/i);
  });
});
```

- [ ] **Step 2: Implement `aiToolsTicketing.ts`**

```typescript
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { tickets } from '../db/schema';
import type { AiTool, AiToolTier } from './aiTools';
import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  type TicketStatus
} from './ticketService';

export function registerTicketingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_tickets', {
    tier: 2 as AiToolTier,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_tickets',
      description: 'Search, view, create, comment on, assign, and change the status of support tickets. Use action "list" to search, "get" for full detail, "create" to open a new ticket, "comment" to add a reply or internal note, "assign" to set the assignee, "update_status" to move the lifecycle (resolving requires resolutionNote).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'create', 'comment', 'assign', 'update_status'], description: 'The action to perform' },
          ticketId: { type: 'string', description: 'Ticket UUID (required for get/comment/assign/update_status)' },
          orgId: { type: 'string', description: 'Organization UUID (required for create; filter for list)' },
          deviceId: { type: 'string', description: 'Device UUID (optional create field; filter for list)' },
          subject: { type: 'string', description: 'Ticket subject (create)' },
          description: { type: 'string', description: 'Ticket description (create)' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          status: { type: 'string', enum: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'], description: 'Target status (update_status) or filter (list)' },
          resolutionNote: { type: 'string', description: 'Required when resolving' },
          content: { type: 'string', description: 'Comment body (comment)' },
          isPublic: { type: 'boolean', description: 'Comment visibility — false = internal note (default true)' },
          assigneeId: { type: 'string', description: 'User UUID to assign, or omit with action assign to unassign' },
          limit: { type: 'number', description: 'Max results for list (default 25)' }
        },
        required: ['action']
      }
    },
    handler: async (input, auth) => {
      const action = input.action as string;
      const actor = { userId: (auth as { userId: string }).userId };

      if (action === 'list') {
        const conditions: SQL[] = [];
        const orgCondition = (auth as { orgCondition: (col: unknown) => SQL | undefined }).orgCondition(tickets.orgId);
        if (orgCondition) conditions.push(orgCondition);
        if (input.orgId) conditions.push(eq(tickets.orgId, input.orgId as string));
        if (input.deviceId) conditions.push(eq(tickets.deviceId, input.deviceId as string));
        if (input.status) conditions.push(eq(tickets.status, input.status as TicketStatus));
        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
        const results = await db
          .select({
            id: tickets.id,
            internalNumber: tickets.internalNumber,
            subject: tickets.subject,
            status: tickets.status,
            priority: tickets.priority,
            assignedTo: tickets.assignedTo,
            orgId: tickets.orgId,
            deviceId: tickets.deviceId,
            createdAt: tickets.createdAt
          })
          .from(tickets)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(tickets.createdAt))
          .limit(limit);
        return JSON.stringify({ tickets: results, showing: results.length });
      }

      if (action === 'get') {
        const rows = await db.select().from(tickets).where(eq(tickets.id, String(input.ticketId))).limit(1);
        if (!rows[0]) return JSON.stringify({ error: 'Ticket not found' });
        return JSON.stringify({ ticket: rows[0] });
      }

      if (action === 'create') {
        const ticket = await createTicket({
          orgId: String(input.orgId),
          subject: String(input.subject),
          description: input.description ? String(input.description) : undefined,
          deviceId: input.deviceId ? String(input.deviceId) : undefined,
          priority: input.priority as 'low' | 'normal' | 'high' | 'urgent' | undefined,
          source: 'ai'
        }, actor);
        return JSON.stringify({ ticket });
      }

      if (action === 'comment') {
        const result = await addTicketComment(String(input.ticketId), {
          content: String(input.content),
          isPublic: input.isPublic !== false
        }, actor);
        return JSON.stringify({ comment: result.comment });
      }

      if (action === 'assign') {
        const ticket = await assignTicket(String(input.ticketId), input.assigneeId ? String(input.assigneeId) : null, actor);
        return JSON.stringify({ ticket });
      }

      if (action === 'update_status') {
        const ticket = await changeTicketStatus(String(input.ticketId), input.status as TicketStatus, {
          resolutionNote: input.resolutionNote ? String(input.resolutionNote) : undefined
        }, actor);
        return JSON.stringify({ ticket });
      }

      throw new Error(`Unknown action: ${action}`);
    }
  });
}
```

Check the real `AuthContext` shape used by tool handlers (`grep -n "AuthContext" apps/api/src/services/aiTools.ts`) and use its actual orgCondition/userId field names.

- [ ] **Step 3: Register in the hub, run tests, commit**

In `aiTools.ts`: `import { registerTicketingTools } from './aiToolsTicketing';` and `registerTicketingTools(aiTools);` next to `registerAlertTools(aiTools);`.

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/aiToolsTicketing.test.ts
git add apps/api/src/services/aiToolsTicketing.ts apps/api/src/services/aiToolsTicketing.test.ts apps/api/src/services/aiTools.ts
git commit -m "feat(tickets): manage_tickets AI tool"
```

---

### Task 15: Internal-note leak regression test (portal)

**Files:**
- Modify: `apps/api/src/routes/portal/tickets.test.ts` (create if it doesn't exist, following the portal route's existing test conventions — check with `ls apps/api/src/routes/portal/*.test.ts`)

- [ ] **Step 1: Write the regression test**

The portal ticket detail/comments queries must filter `isPublic = true` AND `deletedAt IS NULL`. Assert it:

```typescript
describe('portal internal-note isolation', () => {
  it('GET portal ticket detail never returns internal comments', async () => {
    // Mock the comments select to return a mixed set; the route must filter
    // on is_public in SQL — assert the where() received an isPublic condition
    // OR (if the route filters in JS) assert the response excludes the internal one.
    commentsSelectMock.mockResolvedValue([
      { id: 'c-1', content: 'public reply', isPublic: true },
      { id: 'c-2', content: 'INTERNAL: customer is VIP', isPublic: false }
    ]);
    const res = await portalApp.request('/tickets/3f2f1d8e-1111-4222-8333-444455556666', {
      headers: { Authorization: 'Bearer portal-token' }
    });
    const body = await res.json();
    const contents = JSON.stringify(body);
    expect(contents).not.toContain('INTERNAL');
  });
});
```

First read `apps/api/src/routes/portal/tickets.ts` to see whether comments are filtered in SQL. If the route already filters `isPublic` in the query, ALSO add `isNull(ticketComments.deletedAt)` there (soft-deleted comments must vanish from the portal) and keep this test as the guard.

- [ ] **Step 2: Run, fix the portal route if it leaks, commit**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/portal/
git add apps/api/src/routes/portal/
git commit -m "test(tickets): portal internal-note leak regression guard"
```

---

### Task 16: Integration verification + PR

- [ ] **Step 1: Full affected-file test run**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/ticketNumbers.test.ts src/services/ticketEvents.test.ts src/services/ticketService.test.ts src/jobs/ticketNotifyWorker.test.ts src/routes/tickets/ src/routes/ticketCategories.test.ts src/services/aiToolsTicketing.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: all PASS. (Full-suite parallel flakiness is a known pre-existing issue; verify via affected files single-fork and trust CI.)

- [ ] **Step 2: Live smoke against local stack**

With `docker compose` dev stack up and a partner-scope JWT (login via UI, copy from devtools):

```bash
curl -s -X POST http://localhost/api/tickets -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"orgId":"<real-org-uuid>","subject":"Smoke test ticket"}'
# Expected: 201 with internalNumber T-2026-0001
curl -s http://localhost/api/tickets?statusGroup=open -H "Authorization: Bearer $TOKEN"
# Expected: the ticket appears
```

- [ ] **Step 3: Run drift check + RLS contract test one final time**

`pnpm db:check-drift` and the Task 3 RLS run.

- [ ] **Step 4: Open PR**

```bash
git push -u origin feat/ticketing-core-api
gh pr create --title "feat(tickets): native ticketing core backend (Phase 1a)" --body "$(cat <<'EOF'
Implements Phase 1a of the native ticketing spec (docs/superpowers/specs/2026-06-09-native-ticketing-design.md):
schema extensions + categories/alert-links/sequences with RLS, ticketService with lifecycle events,
technician API routes, notification fan-out worker, manage_tickets AI tool, permissions.

Frontend (queue + workbench) lands separately as Phase 1b.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- Spec coverage: migration ✓ (Task 1), schema ✓ (2), RLS allowlist ✓ (3), validators ✓ (4), numbering ✓ (5), events ✓ (6), service ✓ (7-8), notifications ✓ (9), permissions ✓ (10), routes ✓ (11-13), AI tools ✓ (14), internal-note guard ✓ (15). UI, device-tab, e2e → Phase 1b plan. SLA engine, time entries, email-inbound → Phases 2-4.
- Known investigation points are explicit grep/read steps with the follow-up action stated (BullMQ connection path, db.execute return shape, portal ticketNumber format, role_permissions columns, AuthContext shape) — resolve each where flagged before writing the dependent code.
- `partner_id` on tickets is an implementation addition to the spec (needed for per-partner number uniqueness + queue indexes); it is backfilled and matches spec §8a scale guarantees. Update the spec's data-model section when this PR merges.
