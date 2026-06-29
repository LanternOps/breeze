# M365 Mailbox — Plan 1: Connection Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP partner register an M365 shared mailbox, complete admin consent for Breeze's Graph app, and have Breeze store the per-partner tenant + mailbox so inbound (Plan 2) and outbound (Plan 3) can authenticate.

**Architecture:** A new partner-axis table `ticket_mailbox_connections` (Shape 3 RLS, no secret column — Breeze's app secret lives in env). An app-only token helper reuses the existing `c2cM365.ts` client-credentials primitives against a *new* Azure app. Connect/callback routes mirror the accounting OAuth pattern: signed-state JWT + CSRF cookie, callback unauthenticated at the middleware layer, writes under system DB context.

**Tech Stack:** Hono, Drizzle ORM, PostgreSQL RLS, BullMQ (later plans), Vitest, Microsoft Graph (OAuth2 client-credentials).

## Global Constraints

- Node pinned to v22.20.0; fresh worktrees need `pnpm install` and a symlinked `.env`/`.env.test` (else RLS forge passes vacuously).
- Migrations: filename `^\d{4}-.*\.sql$`, applied in `localeCompare` order; idempotent (`IF NOT EXISTS`, `pg_policies` checks); **no inner `BEGIN;`/`COMMIT;`** (autoMigrate wraps each file in a txn); never edit a shipped migration.
- Every tenant-scoped table MUST have RLS enabled + forced + policies in the **same migration** that creates it, and an allowlist entry in `rls-coverage.integration.test.ts` in the **same PR**.
- Background/non-request DB work runs under `runOutsideDbContext(() => withSystemDbAccessContext(...))`; bare pool is forbidden in request code.
- OAuth callback that receives a browser redirect must NOT use `authMiddleware` (Bearer-only) — authenticate via signed `state` + binding cookie, write under system context.
- App registration is **separate** from the C2C backup app: env `TICKET_MAILBOX_M365_CLIENT_ID` / `TICKET_MAILBOX_M365_CLIENT_SECRET`. Graph permissions: `Mail.ReadWrite`, `Mail.Send` (app-only).
- `M365TenantId` is a GUID; the well-known `common`/`organizations`/`consumers` aliases are invalid for client-credentials.

## File Structure

- Create `apps/api/src/db/schema/ticketMailbox.ts` — Drizzle schema for `ticket_mailbox_connections`.
- Modify `apps/api/src/db/schema/index.ts` — export the new schema.
- Create `apps/api/migrations/2026-06-29-ticket-mailbox-connections.sql` — table + RLS.
- Create `apps/api/src/services/ticketMailbox/mailboxToken.ts` — app-only token helper + in-memory cache.
- Create `apps/api/src/services/ticketMailbox/connectionService.ts` — typed CRUD + status transitions + `probeMailbox`.
- Create `apps/api/src/routes/tickets/mailboxConnect.ts` — connect/callback/list/retest/disconnect routes.
- Modify `apps/api/src/routes/tickets/index.ts` — mount the mailbox routes.
- Modify `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — add to `PARTNER_TENANT_TABLES` + `ORG_AXIS_EXCLUDED`.
- Tests co-located: `mailboxToken.test.ts`, `connectionService.test.ts`, `mailboxConnect.test.ts`, and an RLS forge integration test.

## Shared Interface Contract (used by Plans 2 & 3)

```typescript
// services/ticketMailbox/connectionService.ts
export type MailboxConnectionStatus =
  | 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';

export interface MailboxConnection {
  id: string;
  partnerId: string;
  tenantId: string | null;
  mailboxAddress: string;
  displayName: string | null;
  status: MailboxConnectionStatus;
  deltaLink: string | null;
  strictSenderAuth: boolean;
  lastPolledAt: Date | null;
  lastMessageAt: Date | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function listMailboxConnections(partnerId: string): Promise<MailboxConnection[]>;
export function listConnectedMailboxes(): Promise<MailboxConnection[]>; // system-context, all partners
export function getMailboxConnection(id: string, partnerId: string): Promise<MailboxConnection | null>;
export function createPendingConnection(input: { partnerId: string; mailboxAddress: string; displayName: string | null; createdBy: string | null; }): Promise<MailboxConnection>;
export function setConnectionTenant(id: string, partnerId: string, tenantId: string): Promise<void>;
export function setConnectionStatus(id: string, partnerId: string, status: MailboxConnectionStatus, lastError: string | null): Promise<void>;
export function updateDeltaCursor(id: string, deltaLink: string, polledAt: Date, lastMessageAt: Date | null): Promise<void>;
export function resetDeltaCursor(id: string): Promise<void>; // 410-Gone resync → start delta from "now"
export function disableConnection(id: string, partnerId: string): Promise<void>;
export function probeMailbox(tenantId: string, mailboxAddress: string): Promise<{ ok: boolean; error?: string }>;

// services/ticketMailbox/mailboxToken.ts
export function getMailboxPlatformConfig(): { clientId: string; clientSecret: string } | null;
export function getMailboxToken(tenantId: string): Promise<string>;
export function getMailboxCallbackUri(): string;
```

---

### Task 1: Drizzle schema + migration for `ticket_mailbox_connections`

**Files:**
- Create: `apps/api/src/db/schema/ticketMailbox.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/migrations/2026-06-29-ticket-mailbox-connections.sql`

**Interfaces:**
- Produces: `ticketMailboxConnections` Drizzle table; SQL table `ticket_mailbox_connections`.

- [ ] **Step 1: Write the Drizzle schema**

```typescript
// apps/api/src/db/schema/ticketMailbox.ts
import { pgTable, uuid, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { partners } from './orgs';
import { users } from './users';

export const ticketMailboxConnections = pgTable('ticket_mailbox_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  tenantId: text('tenant_id'),                       // Entra GUID; null until consent callback
  mailboxAddress: text('mailbox_address').notNull(), // shared support UPN
  displayName: text('display_name'),
  status: text('status').notNull().default('pending_consent'), // see MailboxConnectionStatus
  deltaLink: text('delta_link'),
  strictSenderAuth: boolean('strict_sender_auth').notNull().default(false),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerMailboxIdx: uniqueIndex('ticket_mailbox_connections_partner_mailbox_idx')
    .on(table.partnerId, table.mailboxAddress),
  idPartnerIdx: uniqueIndex('ticket_mailbox_connections_id_partner_idx')
    .on(table.id, table.partnerId),
}));
```

- [ ] **Step 2: Export from the schema index**

Add to `apps/api/src/db/schema/index.ts` (alongside the other `export *` lines):

```typescript
export * from './ticketMailbox';
```

- [ ] **Step 3: Write the migration**

```sql
-- apps/api/migrations/2026-06-29-ticket-mailbox-connections.sql
CREATE TABLE IF NOT EXISTS ticket_mailbox_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  tenant_id text,
  mailbox_address text NOT NULL,
  display_name text,
  status varchar(20) NOT NULL DEFAULT 'pending_consent',
  delta_link text,
  strict_sender_auth boolean NOT NULL DEFAULT false,
  last_polled_at timestamptz,
  last_message_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_mailbox_connections_partner_mailbox_idx
  ON ticket_mailbox_connections(partner_id, mailbox_address);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_mailbox_connections_id_partner_idx
  ON ticket_mailbox_connections(id, partner_id);

ALTER TABLE ticket_mailbox_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_mailbox_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON ticket_mailbox_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON ticket_mailbox_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON ticket_mailbox_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON ticket_mailbox_connections;
CREATE POLICY breeze_partner_isolation_select ON ticket_mailbox_connections
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON ticket_mailbox_connections
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON ticket_mailbox_connections
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON ticket_mailbox_connections
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 4: Apply the migration and verify no drift**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
npx tsx -e "import('./apps/api/src/db/autoMigrate').then(m => m.autoMigrate()).then(() => process.exit(0))"
pnpm db:check-drift
```
Expected: migration applies; `db:check-drift` reports **no drift**.

- [ ] **Step 5: Verify isolation as `breeze_app`**

Run:
```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "INSERT INTO ticket_mailbox_connections (partner_id, mailbox_address) VALUES (gen_random_uuid(), 'x@y.com');"
```
Expected: FAIL with `new row violates row-level security policy`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/ticketMailbox.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-06-29-ticket-mailbox-connections.sql
git commit -m "feat(tickets): ticket_mailbox_connections table + partner-axis RLS"
```

---

### Task 2: Add the table to the RLS coverage allowlist

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/ticketMailboxConnections.rls.integration.test.ts`

**Interfaces:**
- Consumes: `ticket_mailbox_connections` from Task 1.

- [ ] **Step 1: Add to the partner-axis allowlists**

In `rls-coverage.integration.test.ts`, add `'ticket_mailbox_connections'` to the `PARTNER_TENANT_TABLES` array and to the `ORG_AXIS_EXCLUDED` array (the table has no `org_id`). Keep arrays alphabetically ordered if they already are.

- [ ] **Step 2: Write the forge test (must fail cross-partner)**

```typescript
// apps/api/src/__tests__/integration/ticketMailboxConnections.rls.integration.test.ts
import { describe, it, expect } from 'vitest';
import { withDbAccessContext } from '../../db';
import { getTestPartners } from './helpers/rlsFixtures'; // existing helper used by other forge tests

describe('ticket_mailbox_connections RLS (real driver)', () => {
  it('rejects a cross-partner insert as breeze_app', async () => {
    const { partnerA, partnerB } = await getTestPartners();
    await expect(
      withDbAccessContext({ scope: 'partner', partnerIds: [partnerA] }, async (db) => {
        await db.execute(
          `INSERT INTO ticket_mailbox_connections (partner_id, mailbox_address)
           VALUES ('${partnerB}', 'support@b.com')`
        );
      })
    ).rejects.toThrow(/row-level security/i);
  });

  it('allows insert + read within the same partner', async () => {
    const { partnerA } = await getTestPartners();
    await withDbAccessContext({ scope: 'partner', partnerIds: [partnerA] }, async (db) => {
      await db.execute(
        `INSERT INTO ticket_mailbox_connections (partner_id, mailbox_address)
         VALUES ('${partnerA}', 'support@a.com')
         ON CONFLICT (partner_id, mailbox_address) DO NOTHING`
      );
      const rows = await db.execute(
        `SELECT mailbox_address FROM ticket_mailbox_connections WHERE partner_id = '${partnerA}'`
      );
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});
```

> Adapt `getTestPartners`/`withDbAccessContext` call shapes to match the nearest existing forge test in that directory — copy its imports and fixture helper exactly. Confirm `breeze_app` is `rolbypassrls=f` (else the forge passes vacuously).

- [ ] **Step 3: Run the RLS suites**

Run:
```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts ticketMailboxConnections.rls
npx vitest run --config vitest.config.rls.ts rls-coverage
```
Expected: both PASS (coverage no longer reports `ticket_mailbox_connections` as unscoped).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/ticketMailboxConnections.rls.integration.test.ts
git commit -m "test(tickets): RLS coverage + forge for ticket_mailbox_connections"
```

---

### Task 3: App-only token helper (`mailboxToken.ts`)

**Files:**
- Create: `apps/api/src/services/ticketMailbox/mailboxToken.ts`
- Test: `apps/api/src/services/ticketMailbox/mailboxToken.test.ts`

**Interfaces:**
- Consumes: `acquireClientCredentialsToken`, `isM365TenantId`, `buildAdminConsentUrl` from `../c2cM365`.
- Produces: `getMailboxPlatformConfig()`, `getMailboxToken(tenantId)`, `getMailboxCallbackUri()`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/services/ticketMailbox/mailboxToken.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../c2cM365', () => ({
  isM365TenantId: (x: string) => /^[0-9a-f-]{36}$/i.test(x),
  acquireClientCredentialsToken: vi.fn(async () => ({ accessToken: 'tok-1', expiresIn: 3600 })),
}));

import { acquireClientCredentialsToken } from '../c2cM365';
import { getMailboxToken, _clearMailboxTokenCache } from './mailboxToken';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('getMailboxToken', () => {
  beforeEach(() => {
    _clearMailboxTokenCache();
    vi.mocked(acquireClientCredentialsToken).mockClear();
    process.env.TICKET_MAILBOX_M365_CLIENT_ID = 'cid';
    process.env.TICKET_MAILBOX_M365_CLIENT_SECRET = 'csecret';
  });

  it('acquires once and caches within the freshness window', async () => {
    const a = await getMailboxToken(TENANT);
    const b = await getMailboxToken(TENANT);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-GUID tenant id', async () => {
    await expect(getMailboxToken('common')).rejects.toThrow(/tenant id/i);
  });

  it('throws when app creds are not configured', async () => {
    delete process.env.TICKET_MAILBOX_M365_CLIENT_ID;
    await expect(getMailboxToken(TENANT)).rejects.toThrow(/not configured/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/mailboxToken.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```typescript
// apps/api/src/services/ticketMailbox/mailboxToken.ts
import { acquireClientCredentialsToken, isM365TenantId } from '../c2cM365';

interface CachedToken { token: string; expiresAt: number; }
const cache = new Map<string, CachedToken>();
const FRESH_BUFFER_MS = 5 * 60 * 1000;

export function _clearMailboxTokenCache(): void {
  cache.clear();
}

export function getMailboxPlatformConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.TICKET_MAILBOX_M365_CLIENT_ID?.trim();
  const clientSecret = process.env.TICKET_MAILBOX_M365_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function getMailboxCallbackUri(): string {
  const base = (
    process.env.PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.DASHBOARD_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/api/v1/tickets/mailbox/callback`;
}

/** App-only Graph token for a partner's tenant. Cached in-memory keyed by tenant. */
export async function getMailboxToken(tenantId: string): Promise<string> {
  if (!isM365TenantId(tenantId)) throw new Error('Invalid M365 tenant id');
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt - Date.now() > FRESH_BUFFER_MS) return cached.token;

  const cfg = getMailboxPlatformConfig();
  if (!cfg) throw new Error('TICKET_MAILBOX_M365_CLIENT_ID/SECRET not configured');

  const res = await acquireClientCredentialsToken({
    tenantId: tenantId as Parameters<typeof acquireClientCredentialsToken>[0]['tenantId'],
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  cache.set(tenantId, { token: res.accessToken, expiresAt: Date.now() + res.expiresIn * 1000 });
  return res.accessToken;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/mailboxToken.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketMailbox/mailboxToken.ts apps/api/src/services/ticketMailbox/mailboxToken.test.ts
git commit -m "feat(tickets): app-only Graph token helper for ticket mailbox"
```

---

### Task 4: Connection service (`connectionService.ts`)

**Files:**
- Create: `apps/api/src/services/ticketMailbox/connectionService.ts`
- Test: `apps/api/src/services/ticketMailbox/connectionService.test.ts`

**Interfaces:**
- Consumes: `getMailboxToken` (Task 3), `db`/`withSystemDbAccessContext`/`runOutsideDbContext` from `../../db`, `ticketMailboxConnections` schema.
- Produces: the full Shared Interface Contract block (`MailboxConnection`, `MailboxConnectionStatus`, and all functions).

- [ ] **Step 1: Write the failing test (probe + status mapping)**

```typescript
// apps/api/src/services/ticketMailbox/connectionService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { probeMailbox } from './connectionService';

describe('probeMailbox', () => {
  beforeEach(() => fetchMock.mockReset());

  it('returns ok on a 200 from the mailbox messages endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ value: [] }) });
    const r = await probeMailbox('11111111-1111-1111-1111-111111111111', 'support@a.com');
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/users/support%40a.com/messages?%24top=1"),
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('returns an error string on 403 (access policy not scoped)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'denied' });
    const r = await probeMailbox('11111111-1111-1111-1111-111111111111', 'support@a.com');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/connectionService.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the service**

```typescript
// apps/api/src/services/ticketMailbox/connectionService.ts
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections } from '../../db/schema/ticketMailbox';
import { getMailboxToken } from './mailboxToken';

export type MailboxConnectionStatus =
  | 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';

export interface MailboxConnection {
  id: string;
  partnerId: string;
  tenantId: string | null;
  mailboxAddress: string;
  displayName: string | null;
  status: MailboxConnectionStatus;
  deltaLink: string | null;
  strictSenderAuth: boolean;
  lastPolledAt: Date | null;
  lastMessageAt: Date | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type Row = typeof ticketMailboxConnections.$inferSelect;
function toConnection(r: Row): MailboxConnection {
  return { ...r, status: r.status as MailboxConnectionStatus };
}

export async function listMailboxConnections(partnerId: string): Promise<MailboxConnection[]> {
  const rows = await db.select().from(ticketMailboxConnections)
    .where(eq(ticketMailboxConnections.partnerId, partnerId));
  return rows.map(toConnection);
}

/** System-context read across all partners — used by the poll worker (Plan 2). */
export async function listConnectedMailboxes(): Promise<MailboxConnection[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select().from(ticketMailboxConnections)
      .where(eq(ticketMailboxConnections.status, 'connected'));
    return rows.map(toConnection);
  }));
}

export async function getMailboxConnection(id: string, partnerId: string): Promise<MailboxConnection | null> {
  const rows = await db.select().from(ticketMailboxConnections)
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)))
    .limit(1);
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function createPendingConnection(input: {
  partnerId: string; mailboxAddress: string; displayName: string | null; createdBy: string | null;
}): Promise<MailboxConnection> {
  const rows = await db.insert(ticketMailboxConnections).values({
    partnerId: input.partnerId,
    mailboxAddress: input.mailboxAddress.trim().toLowerCase(),
    displayName: input.displayName,
    status: 'pending_consent',
    createdBy: input.createdBy,
  }).onConflictDoUpdate({
    target: [ticketMailboxConnections.partnerId, ticketMailboxConnections.mailboxAddress],
    set: { status: 'pending_consent', displayName: input.displayName, updatedAt: new Date() },
  }).returning();
  return toConnection(rows[0]);
}

export async function setConnectionTenant(id: string, partnerId: string, tenantId: string): Promise<void> {
  await db.update(ticketMailboxConnections)
    .set({ tenantId, updatedAt: new Date() })
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)));
}

export async function setConnectionStatus(
  id: string, partnerId: string, status: MailboxConnectionStatus, lastError: string | null,
): Promise<void> {
  await db.update(ticketMailboxConnections)
    .set({ status, lastError, updatedAt: new Date() })
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)));
}

export async function updateDeltaCursor(
  id: string, deltaLink: string, polledAt: Date, lastMessageAt: Date | null,
): Promise<void> {
  await db.update(ticketMailboxConnections)
    .set({ deltaLink, lastPolledAt: polledAt, ...(lastMessageAt ? { lastMessageAt } : {}), updatedAt: new Date() })
    .where(eq(ticketMailboxConnections.id, id));
}

export async function disableConnection(id: string, partnerId: string): Promise<void> {
  await db.update(ticketMailboxConnections)
    .set({ status: 'disabled', deltaLink: null, updatedAt: new Date() })
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)));
}

/** 410 Gone: Graph invalidated the delta token. Clear it so the next sweep restarts
 *  the delta from "now" (no history backfill). Stays 'connected'. Called from the
 *  poll worker under system context. */
export async function resetDeltaCursor(id: string): Promise<void> {
  await db.update(ticketMailboxConnections)
    .set({ deltaLink: null, updatedAt: new Date() })
    .where(eq(ticketMailboxConnections.id, id));
}

/** Lightweight Graph probe: can the app read this mailbox under the tenant's consent? */
export async function probeMailbox(tenantId: string, mailboxAddress: string): Promise<{ ok: boolean; error?: string }> {
  let token: string;
  try {
    token = await getMailboxToken(tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'token acquisition failed' };
  }
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxAddress)}/messages?${encodeURIComponent('$top')}=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
  if (res.ok) return { ok: true };
  return { ok: false, error: `Graph returned ${res.status}` };
}
```

> Mark the table's `connected_by` / write paths system-safe: callers in routes use the request DB context; the poll worker uses `listConnectedMailboxes`/`updateDeltaCursor` under system context (Plan 2 wraps those calls).

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/ticketMailbox/connectionService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/ticketMailbox/connectionService.ts apps/api/src/services/ticketMailbox/connectionService.test.ts
git commit -m "feat(tickets): mailbox connection service (CRUD + probe)"
```

---

### Task 5: Connect/callback/list/retest/disconnect routes

**Files:**
- Create: `apps/api/src/routes/tickets/mailboxConnect.ts`
- Modify: `apps/api/src/routes/tickets/index.ts`
- Test: `apps/api/src/routes/tickets/mailboxConnect.test.ts`

**Interfaces:**
- Consumes: connection service (Task 4), `getMailboxToken`/`getMailboxCallbackUri` (Task 3), `buildAdminConsentUrl` + `isM365TenantId` from `services/c2cM365`, `authMiddleware`/`partnerScopes`/`requireMfa` middlewares, `zValidator`.
- Produces: routes under `/api/v1/tickets/mailbox/*`.

The state-signing helpers (`createState`/`verifyState`/`stateCookieValue`/`constantTimeEqual`/`signingSecret`/`hmac`) are copied from `routes/accounting/index.ts` but with label `'ticket-mailbox-oauth'` and a payload that adds `connectionId`. Reproduce them verbatim in this file (do not import from accounting — the label differs and they are file-private there).

- [ ] **Step 1: Write the failing route tests**

```typescript
// apps/api/src/routes/tickets/mailboxConnect.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../services/ticketMailbox/connectionService', () => ({
  createPendingConnection: vi.fn(async () => ({ id: 'conn-1', partnerId: 'p1', mailboxAddress: 'support@a.com' })),
  getMailboxConnection: vi.fn(async () => ({ id: 'conn-1', partnerId: 'p1', tenantId: '11111111-1111-1111-1111-111111111111', mailboxAddress: 'support@a.com', status: 'connected' })),
  setConnectionTenant: vi.fn(async () => {}),
  setConnectionStatus: vi.fn(async () => {}),
  probeMailbox: vi.fn(async () => ({ ok: true })),
  listMailboxConnections: vi.fn(async () => []),
  disableConnection: vi.fn(async () => {}),
}));
vi.mock('../../services/ticketMailbox/mailboxToken', () => ({
  getMailboxCallbackUri: () => 'https://app.example.com/api/v1/tickets/mailbox/callback',
}));

import { mailboxRoutes } from './mailboxConnect';

function appWithAuth() {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', scope: 'partner' }); await next(); });
  app.route('/tickets/mailbox', mailboxRoutes);
  return app;
}

describe('mailbox connect/callback routes', () => {
  beforeEach(() => { process.env.SESSION_SECRET = 'test-secret'; process.env.TICKET_MAILBOX_M365_CLIENT_ID = 'cid'; });

  it('POST /connect returns an admin-consent authUrl and sets the state cookie', async () => {
    const res = await appWithAuth().request('/tickets/mailbox/connect', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxAddress: 'support@a.com', displayName: 'Support' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authUrl).toContain('login.microsoftonline.com');
    expect(body.authUrl).toContain('adminconsent');
    expect(res.headers.get('set-cookie')).toContain('ticket_mailbox_oauth_state');
  });

  it('GET /callback rejects an unsigned/invalid state with 400', async () => {
    const res = await appWithAuth().request('/tickets/mailbox/callback?state=bogus&tenant=11111111-1111-1111-1111-111111111111&admin_consent=True');
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/tickets/mailboxConnect.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the routes**

```typescript
// apps/api/src/routes/tickets/mailboxConnect.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { authMiddleware } from '../../middleware/auth';
import { partnerScopes } from '../../middleware/partnerScopes';
import { requireMfa } from '../../middleware/mfa';
import { buildAdminConsentUrl, isM365TenantId } from '../../services/c2cM365';
import { getMailboxCallbackUri, getMailboxPlatformConfig } from '../../services/ticketMailbox/mailboxToken';
import {
  createPendingConnection, getMailboxConnection, setConnectionTenant,
  setConnectionStatus, probeMailbox, listMailboxConnections, disableConnection,
} from '../../services/ticketMailbox/connectionService';
import { withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { captureException } from '../../services/sentry';

const STATE_COOKIE = 'ticket_mailbox_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;
const LABEL = 'ticket-mailbox-oauth';

interface StatePayload { partnerId: string; userId: string | null; connectionId: string; nonce: string; exp: number; }

function signingSecret(): string | null {
  return process.env.APP_ENCRYPTION_KEY?.trim() || process.env.SECRET_ENCRYPTION_KEY?.trim()
    || process.env.SESSION_SECRET?.trim() || process.env.JWT_SECRET?.trim()
    || (process.env.NODE_ENV === 'production' ? null : 'test-only-ticket-mailbox-oauth-state-secret');
}
function hmac(label: string, value: string): string | null {
  const secret = signingSecret();
  return secret ? createHmac('sha256', secret).update(`${label}:${value}`).digest('base64url') : null;
}
function constantTimeEqual(a: string, b: string): boolean {
  const l = Buffer.from(a, 'utf8'); const r = Buffer.from(b, 'utf8');
  return l.length === r.length && timingSafeEqual(l, r);
}
function createState(p: Omit<StatePayload, 'nonce' | 'exp'>): string | null {
  const payload: StatePayload = { ...p, nonce: randomBytes(16).toString('hex'), exp: Date.now() + STATE_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = hmac(LABEL, encoded);
  return sig ? `${encoded}.${sig}` : null;
}
function verifyState(state: string): StatePayload | null {
  const [encoded, sig] = state.split('.');
  if (!encoded || !sig) return null;
  const expected = hmac(LABEL, encoded);
  if (!expected || !constantTimeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload;
    if (!parsed.partnerId || !parsed.connectionId || !parsed.nonce || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch { return null; }
}
function stateCookieValue(state: string): string | null { return hmac(`${LABEL}-cookie`, state); }

const connectBody = z.object({ mailboxAddress: z.string().email(), displayName: z.string().max(120).optional() });
const callbackQuery = z.object({ state: z.string(), tenant: z.string().optional(), admin_consent: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() });
const idParam = z.object({ id: z.string().uuid() });

export const mailboxRoutes = new Hono();

// List
mailboxRoutes.get('/connections', authMiddleware, partnerScopes, async (c) => {
  const auth = c.get('auth');
  const list = await listMailboxConnections(auth.partnerId);
  return c.json({ connections: list });
});

// Initiate consent (creates the pending row, returns admin-consent URL)
mailboxRoutes.post('/connect', authMiddleware, partnerScopes, requireMfa(), zValidator('json', connectBody), async (c) => {
  if (!getMailboxPlatformConfig()) return c.json({ error: 'M365 ticket mailbox app is not configured' }, 400);
  const auth = c.get('auth');
  const { mailboxAddress, displayName } = c.req.valid('json');
  const conn = await createPendingConnection({
    partnerId: auth.partnerId, mailboxAddress, displayName: displayName ?? null, createdBy: auth.user?.id ?? null,
  });
  const state = createState({ partnerId: auth.partnerId, userId: auth.user?.id ?? null, connectionId: conn.id });
  const cookie = state ? stateCookieValue(state) : null;
  if (!state || !cookie) return c.json({ error: 'OAuth state signing secret is not configured' }, 500);
  setCookie(c, STATE_COOKIE, cookie, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'Lax', path: '/', maxAge: STATE_TTL_MS / 1000,
  });
  const cfg = getMailboxPlatformConfig()!;
  const authUrl = buildAdminConsentUrl({ clientId: cfg.clientId, state, redirectUri: getMailboxCallbackUri() });
  return c.json({ authUrl, connectionId: conn.id });
});

// OAuth redirect target — NO authMiddleware. Authenticated by signed state + cookie.
mailboxRoutes.get('/callback', zValidator('query', callbackQuery), async (c) => {
  const q = c.req.valid('query');
  const state = verifyState(q.state);
  if (!state) return c.json({ error: 'Invalid or expired OAuth state' }, 400);

  const expectedCookie = stateCookieValue(q.state);
  const presented = getCookie(c, STATE_COOKIE);
  if (!expectedCookie || !presented || !constantTimeEqual(presented, expectedCookie)) {
    return c.json({ error: 'OAuth state binding mismatch' }, 400);
  }
  deleteCookie(c, STATE_COOKIE, { path: '/' });

  if (q.error || !q.tenant || !isM365TenantId(q.tenant)) {
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      setConnectionStatus(state.connectionId, state.partnerId, 'error', q.error_description ?? q.error ?? 'consent failed')));
    return c.redirect('/integrations?ticketMailbox=error#ticket-mailbox');
  }

  try {
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      setConnectionTenant(state.connectionId, state.partnerId, q.tenant!)));
    const probe = await probeMailbox(q.tenant, (await getConnAddress(state)) ?? '');
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      setConnectionStatus(state.connectionId, state.partnerId, probe.ok ? 'connected' : 'error', probe.ok ? null : (probe.error ?? 'probe failed'))));
    return c.redirect(probe.ok ? '/integrations?ticketMailbox=connected#ticket-mailbox' : '/integrations?ticketMailbox=needs_policy#ticket-mailbox');
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    return c.redirect('/integrations?ticketMailbox=error#ticket-mailbox');
  }
});

async function getConnAddress(state: StatePayload): Promise<string | null> {
  const conn = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    getMailboxConnection(state.connectionId, state.partnerId)));
  return conn?.mailboxAddress ?? null;
}

// Re-run the probe (after the admin scopes the Application Access Policy)
mailboxRoutes.post('/connections/:id/retest', authMiddleware, partnerScopes, requireMfa(), zValidator('param', idParam), async (c) => {
  const auth = c.get('auth');
  const { id } = c.req.valid('param');
  const conn = await getMailboxConnection(id, auth.partnerId);
  if (!conn || !conn.tenantId) return c.json({ error: 'Connection not found or not consented' }, 404);
  const probe = await probeMailbox(conn.tenantId, conn.mailboxAddress);
  await setConnectionStatus(id, auth.partnerId, probe.ok ? 'connected' : 'error', probe.ok ? null : (probe.error ?? 'probe failed'));
  return c.json({ ok: probe.ok, error: probe.error });
});

// Disconnect
mailboxRoutes.delete('/connections/:id', authMiddleware, partnerScopes, requireMfa(), zValidator('param', idParam), async (c) => {
  const auth = c.get('auth');
  await disableConnection(c.req.valid('param').id, auth.partnerId);
  return c.json({ ok: true });
});
```

> Confirm the exact middleware import paths and the `auth` context shape (`auth.partnerId`, `auth.user?.id`) against `routes/accounting/index.ts` — copy whatever it uses (`partnerScopes` may be named `partnerScopeMiddleware`; `requireMfa` may be `requireMfa()` factory). Adjust the redirect base to match the accounting card's redirect convention.

- [ ] **Step 4: Mount the routes**

In `apps/api/src/routes/tickets/index.ts`, import and mount:

```typescript
import { mailboxRoutes } from './mailboxConnect';
// ... within the tickets router hub setup:
ticketsRoutes.route('/mailbox', mailboxRoutes);
```

> Verify the callback path resolves to `/api/v1/tickets/mailbox/callback` given how the tickets hub is mounted in the top-level router. If the tickets hub already applies `authMiddleware` via `.use('*')`, the callback would be wrongly gated — mount `mailboxRoutes` so the callback escapes any wildcard auth (per the Hono wildcard-auth-leak lesson). Prefer per-route middleware on the tickets hub, not a `.use('*')`.

- [ ] **Step 5: Run the route tests**

Run: `cd apps/api && npx vitest run src/routes/tickets/mailboxConnect.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
cd apps/api && npx tsc --noEmit
git add apps/api/src/routes/tickets/mailboxConnect.ts apps/api/src/routes/tickets/mailboxConnect.test.ts apps/api/src/routes/tickets/index.ts
git commit -m "feat(tickets): M365 mailbox connect/callback/retest/disconnect routes"
```

---

## Self-Review (Plan 1)

- **Spec coverage:** table + RLS (Task 1–2), env-based separate app + token helper (Task 3), connection lifecycle + probe (Task 4), admin-consent connect/callback + retest/disconnect with the QuickBooks-callback hardening (Task 5). ✅
- **Callback security:** no `authMiddleware`; signed state + CSRF cookie; writes under `runOutsideDbContext(withSystemDbAccessContext(...))`; tenant validated via `isM365TenantId`. ✅
- **Type consistency:** `MailboxConnection`/`MailboxConnectionStatus` and all function names match the Shared Interface Contract used by Plans 2 & 3. ✅
- **Open verification for the implementer:** exact middleware names/paths, the `auth` context property names, the tickets-hub mount point (avoid `.use('*')` auth leak), and the redirect base — all flagged inline to confirm against `routes/accounting/index.ts`.
