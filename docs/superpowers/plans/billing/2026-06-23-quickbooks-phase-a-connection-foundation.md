# QuickBooks Phase A — Accounting Connection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the partner-scoped accounting-connection foundation: a `accounting_connections` table, the encrypted token store, the `AccountingProvider` interface with a QuickBooks Online OAuth/token implementation (connect, callback, refresh with refresh-token rotation, disconnect), and a connection-status read — the seam every later phase and Xero reuses.

**Architecture:** One provider-agnostic partner-axis table (`accounting_connections`, RLS shape 3) holds encrypted OAuth tokens per (partner, provider). A narrow `AccountingProvider` interface isolates provider quirks; `QuickbooksProvider` is implementation #1 and only implements the OAuth/token surface in Phase A (customer/item/invoice/reconcile methods are declared but `throw NotImplemented` until Phases B–D). OAuth routes drive Intuit's 3-legged auth-code flow; access tokens (60-min) refresh inline with a 5-min buffer and **persist the rotated refresh token every time**.

**Tech Stack:** Hono (TypeScript) routes, Drizzle ORM + hand-written idempotent SQL migration, PostgreSQL RLS, `secretCrypto` AES encryption, Vitest (unit + integration), React/Astro web UI.

## Global Constraints

- **Source of truth:** Breeze. Phase A only establishes the connection; no data sync yet.
- **RLS shape 3 (partner-axis):** `accounting_connections` MUST have RLS `ENABLE` + `FORCE` + four `breeze_has_partner_access(partner_id)` policies in the same migration that creates it. Add `'accounting_connections' → 'partner_id'` to `PARTNER_TENANT_TABLES` in `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (map starts line 116) in the same PR.
- **Encryption:** every `*_encrypted` column registered in `apps/api/src/services/encryptedColumnRegistry.ts` (`{ table, column, kind: 'text', description }`); encrypt on write via `encryptSecret(value)`, decrypt on read via `decryptSecret(value)` from `apps/api/src/services/secretCrypto.ts`. Never log decrypted tokens.
- **Migration discipline:** filename `2026-06-23-quickbooks-accounting-connections.sql`; idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` then `CREATE POLICY`, `CREATE ... IF NOT EXISTS` indexes); NO inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file); never edit once shipped. No `gen_random_bytes`/pgcrypto (not installed) — use `gen_random_uuid()` defaults only.
- **DB context:** request-path code uses `withDbAccessContext` (partner scope); the OAuth callback runs in the authenticated partner's context. Never the bare pool. Wrap any QBO HTTP call with `runOutsideDbContext` so a pooled connection is never held across network I/O (#1105 class).
- **Route gating:** all management routes require `requireScope('partner','system')`; credential-changing actions (connect callback persist, disconnect) additionally require `requireMfa()` — the Pax8 convention.
- **App-level QBO credentials live in env**, never per-partner: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT` (`sandbox|production`). Partners only complete OAuth.
- **No external-ref columns on core tables** (`invoices`, `organizations`, `catalog_items`). N/A in Phase A but holds for the whole program.
- **Node:** run all pnpm/vitest with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (node 22.20.0). Integration/RLS tests need the `.env.test` symlink (already present in this worktree) and run via the RLS/integration vitest configs, not plain `vitest run`.
- **Spec reference:** `docs/superpowers/specs/billing/2026-06-23-quickbooks-accounting-integration-design.md` — read the Data model, OAuth & token model, and Multi-tenancy/RLS sections before starting.

---

### Task 1: `accounting_connections` schema + migration + RLS + allowlist

**Files:**
- Create: `apps/api/src/db/schema/accounting.ts`
- Modify: `apps/api/src/db/schema/index.ts` (export the new schema — match how `pax8` is exported)
- Create: `apps/api/migrations/2026-06-23-quickbooks-accounting-connections.sql`
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts:42+` (add entries)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:116+` (add to `PARTNER_TENANT_TABLES`)

**Interfaces:**
- Produces: Drizzle table `accountingConnections` (table name `accounting_connections`) with columns: `id uuid pk`, `partnerId uuid not null → partners.id`, `provider varchar(20) not null`, `realmIdEncrypted text`, `accessTokenEncrypted text`, `refreshTokenEncrypted text`, `accessTokenExpiresAt timestamptz`, `refreshTokenExpiresAt timestamptz`, `environment varchar(12) not null default 'production'`, `homeCurrency char(3)`, `defaultIncomeAccountRef varchar(64)`, `defaultTaxCodeRef varchar(64)`, `pushMode varchar(10) not null default 'auto'`, `webhookVerifierTokenEncrypted text`, `cdcCursor timestamptz`, `status varchar(20) not null default 'connected'`, `lastSyncAt timestamptz`, `lastError text`, `connectedBy uuid → users.id`, `createdAt`, `updatedAt`. Unique partial index on `(partner_id)` where `provider='quickbooks'` (one QBO connection per partner); unique index on `(id, partner_id)` for future composite FKs from Phase B mapping table.

- [ ] **Step 1: Write the Drizzle schema** in `apps/api/src/db/schema/accounting.ts`, mirroring `apps/api/src/db/schema/pax8.ts:1-46` for imports/style:

```ts
import { pgTable, uuid, varchar, text, timestamp, char, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners } from './orgs';
import { users } from './users';

export const accountingConnections = pgTable('accounting_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  provider: varchar('provider', { length: 20 }).notNull(), // 'quickbooks' | 'xero'
  realmIdEncrypted: text('realm_id_encrypted'),
  accessTokenEncrypted: text('access_token_encrypted'),
  refreshTokenEncrypted: text('refresh_token_encrypted'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  environment: varchar('environment', { length: 12 }).notNull().default('production'),
  homeCurrency: char('home_currency', { length: 3 }),
  defaultIncomeAccountRef: varchar('default_income_account_ref', { length: 64 }),
  defaultTaxCodeRef: varchar('default_tax_code_ref', { length: 64 }),
  pushMode: varchar('push_mode', { length: 10 }).notNull().default('auto'), // 'auto' | 'manual'
  webhookVerifierTokenEncrypted: text('webhook_verifier_token_encrypted'),
  cdcCursor: timestamp('cdc_cursor', { withTimezone: true }),
  status: varchar('status', { length: 20 }).notNull().default('connected'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  connectedBy: uuid('connected_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  partnerProviderIdx: uniqueIndex('accounting_connections_partner_provider_idx')
    .on(table.partnerId, table.provider),
  idPartnerIdx: uniqueIndex('accounting_connections_id_partner_idx').on(table.id, table.partnerId),
}));
```

- [ ] **Step 2: Export** from `apps/api/src/db/schema/index.ts` — add `export * from './accounting';` next to the other schema re-exports (grep for `export * from './pax8'` and match placement).

- [ ] **Step 3: Write the migration** `apps/api/migrations/2026-06-23-quickbooks-accounting-connections.sql`, mirroring `2026-06-18-a-pax8-billing-sync.sql:1-25,174-197`:

```sql
CREATE TABLE IF NOT EXISTS accounting_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  provider varchar(20) NOT NULL,
  realm_id_encrypted text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  environment varchar(12) NOT NULL DEFAULT 'production',
  home_currency char(3),
  default_income_account_ref varchar(64),
  default_tax_code_ref varchar(64),
  push_mode varchar(10) NOT NULL DEFAULT 'auto',
  webhook_verifier_token_encrypted text,
  cdc_cursor timestamptz,
  status varchar(20) NOT NULL DEFAULT 'connected',
  last_sync_at timestamptz,
  last_error text,
  connected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_partner_provider_idx
  ON accounting_connections(partner_id, provider);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_connections_id_partner_idx
  ON accounting_connections(id, partner_id);

ALTER TABLE accounting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON accounting_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON accounting_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON accounting_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON accounting_connections;
CREATE POLICY breeze_partner_isolation_select ON accounting_connections
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON accounting_connections
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON accounting_connections
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON accounting_connections
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
```

- [ ] **Step 4: Register encrypted columns** — add to the array in `encryptedColumnRegistry.ts:42`:

```ts
  { table: 'accounting_connections', column: 'realm_id_encrypted', kind: 'text', description: 'QBO realmId / Xero tenantId' },
  { table: 'accounting_connections', column: 'access_token_encrypted', kind: 'text', description: 'Accounting provider OAuth access token' },
  { table: 'accounting_connections', column: 'refresh_token_encrypted', kind: 'text', description: 'Accounting provider OAuth refresh token (rotates)' },
  { table: 'accounting_connections', column: 'webhook_verifier_token_encrypted', kind: 'text', description: 'QBO webhook verifier token' },
```

- [ ] **Step 5: Add to RLS allowlist** — in `rls-coverage.integration.test.ts`, inside the `PARTNER_TENANT_TABLES` map (line ~116), add: `['accounting_connections', 'partner_id'],`

- [ ] **Step 6: Verify drift + migration applies** — Run:
```
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts   # or the project's apply path; confirm no error
pnpm db:check-drift
```
Expected: migration applies cleanly; drift check reports no drift.

- [ ] **Step 7: Commit**
```bash
git add apps/api/src/db/schema/accounting.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-06-23-quickbooks-accounting-connections.sql apps/api/src/services/encryptedColumnRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(accounting): add accounting_connections table + partner-axis RLS"
```

---

### Task 2: Connection repository (encrypted CRUD)

**Files:**
- Create: `apps/api/src/services/accounting/accountingConnectionService.ts`
- Test: `apps/api/src/services/accounting/accountingConnectionService.test.ts`

**Interfaces:**
- Consumes: `accountingConnections` table (Task 1); `encryptSecret`/`decryptSecret` (`secretCrypto.ts`).
- Produces:
  - `type AccountingConnection = { id; partnerId; provider; realmId: string|null; accessToken: string|null; refreshToken: string|null; accessTokenExpiresAt: Date|null; refreshTokenExpiresAt: Date|null; environment: 'sandbox'|'production'; homeCurrency: string|null; defaultIncomeAccountRef: string|null; defaultTaxCodeRef: string|null; pushMode: 'auto'|'manual'; status: string; }` (decrypted view; never log it).
  - `getConnection(db, partnerId, provider): Promise<AccountingConnection | null>` — decrypts secret columns.
  - `upsertConnection(db, partnerId, provider, fields): Promise<AccountingConnection>` — encrypts `realmId/accessToken/refreshToken/webhookVerifierToken` via `encryptSecret` before write; `ON CONFLICT (partner_id, provider) DO UPDATE`.
  - `updateTokens(db, connectionId, partnerId, { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }): Promise<void>` — encrypts and updates only the token columns + `updated_at`.
  - `markStatus(db, connectionId, partnerId, status, lastError?): Promise<void>`.
  - `deleteConnection(db, partnerId, provider): Promise<void>`.

- [ ] **Step 1: Write failing test** `accountingConnectionService.test.ts` (Drizzle-mock pattern — see any `*Service.test.ts` using `vi.mock`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { encryptSecret, decryptSecret } from '../secretCrypto';

describe('accountingConnectionService', () => {
  it('encrypts tokens on upsert and returns decrypted on read', async () => {
    // Arrange a mock db that captures the inserted row, then returns it for select.
    const captured: any = {};
    const db = makeMockDb(captured); // helper builds Drizzle insert/select chain returning captured row
    const { upsertConnection, getConnection } = await import('./accountingConnectionService');

    await upsertConnection(db, 'partner-1', 'quickbooks', {
      realmId: 'realm-123', accessToken: 'at-secret', refreshToken: 'rt-secret',
      accessTokenExpiresAt: new Date('2026-06-23T01:00:00Z'),
      refreshTokenExpiresAt: new Date('2026-09-30T00:00:00Z'),
      environment: 'production',
    });

    // stored columns must be ciphertext, not plaintext
    expect(captured.row.access_token_encrypted).not.toBe('at-secret');
    expect(decryptSecret(captured.row.access_token_encrypted)).toBe('at-secret');

    const read = await getConnection(db, 'partner-1', 'quickbooks');
    expect(read?.accessToken).toBe('at-secret');
    expect(read?.realmId).toBe('realm-123');
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `pnpm --filter @breeze/api exec vitest run src/services/accounting/accountingConnectionService.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `accountingConnectionService.ts` with the interface above; encrypt with `encryptSecret(...)` on write, `decryptSecret(...)` on read; all queries take the request-scoped `db` (never the bare pool).
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(accounting): connection repository with encrypted token CRUD"`

---

### Task 3: `AccountingProvider` interface + config env

**Files:**
- Create: `apps/api/src/services/accounting/types.ts`
- Create: `apps/api/src/services/accounting/providerRegistry.ts`
- Modify: `apps/api/src/config/env.ts` (add QBO env consts, pattern at `env.ts:24`)
- Modify: `apps/api/src/config/validate.ts` (warn — not hard-fail — if `BINARY_SOURCE`-style required; QBO vars only required when a partner attempts connect, so validate lazily in the route, not at boot)
- Test: `apps/api/src/services/accounting/providerRegistry.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`:
    ```ts
    export type AccountingProviderId = 'quickbooks' | 'xero';
    export interface ConnectionTokens { realmId: string; accessToken: string; refreshToken: string; accessTokenExpiresAt: Date; refreshTokenExpiresAt: Date; }
    export interface RemoteEntity { id: string; displayName: string; email?: string; }
    export interface RemoteRef { id: string; syncToken?: string; docNumber?: string; }
    export interface ChangeSet { cursor: Date; payments: Array<{ remoteInvoiceId: string; remotePaymentId: string; amountMinor: number; currency: string; txnDate: string }>; }
    export interface AccountingProvider {
      readonly provider: AccountingProviderId;
      buildAuthUrl(state: string): string;
      exchangeCode(code: string, realmId: string): Promise<ConnectionTokens>;
      refresh(refreshToken: string): Promise<ConnectionTokens>;
      listRemoteCustomers(conn: AccountingConnection, query?: string): Promise<RemoteEntity[]>;
      listRemoteItems(conn: AccountingConnection, query?: string): Promise<RemoteEntity[]>;
      upsertCustomer(...args: unknown[]): Promise<RemoteRef>;
      upsertItem(...args: unknown[]): Promise<RemoteRef>;
      pushInvoice(...args: unknown[]): Promise<RemoteRef>;
      voidInvoice(...args: unknown[]): Promise<void>;
      reconcileChanges(conn: AccountingConnection, sinceCursor: Date | null): Promise<ChangeSet>;
      verifyWebhook(signatureHeader: string, rawBody: string, verifierToken: string): boolean;
    }
    ```
  - `providerRegistry.ts`: `getAccountingProvider(id: AccountingProviderId): AccountingProvider` — throws on unknown id.
  - `env.ts`: `export const QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENVIRONMENT` (each `process.env.X?.trim() ?? ''`).

- [ ] **Step 1: Write failing test** `providerRegistry.test.ts`: `getAccountingProvider('quickbooks').provider === 'quickbooks'`; `getAccountingProvider('bogus' as any)` throws.
- [ ] **Step 2: Run test, verify it fails.**
- [ ] **Step 3: Implement** `types.ts`, `providerRegistry.ts` (registry returns the `QuickbooksProvider` singleton from Task 4 — for this task a placeholder object satisfying the interface is fine; Task 4 fills the OAuth methods), and the env consts.
- [ ] **Step 4: Run test, verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(accounting): AccountingProvider interface + provider registry + QBO env"`

---

### Task 4: `QuickbooksProvider` OAuth + token methods (with rotation)

**Files:**
- Create: `apps/api/src/services/accounting/quickbooksProvider.ts`
- Test: `apps/api/src/services/accounting/quickbooksProvider.test.ts`

**Interfaces:**
- Consumes: `AccountingProvider` (Task 3); QBO env consts (Task 3).
- Produces: `class QuickbooksProvider implements AccountingProvider` exporting a singleton `quickbooksProvider`. Phase A implements `buildAuthUrl`, `exchangeCode`, `refresh`, `verifyWebhook`. The customer/item/invoice/reconcile methods `throw new Error('NotImplemented: Phase B/C/D')`.
  - `buildAuthUrl(state)` → `https://appcenter.intuit.com/connect/oauth2?client_id=...&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=...&state=...`.
  - `exchangeCode(code, realmId)` → POST `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` (Basic auth = base64(client_id:client_secret), `grant_type=authorization_code`), returns `ConnectionTokens` (compute `accessTokenExpiresAt = now + expires_in`, `refreshTokenExpiresAt = now + x_refresh_token_expires_in`).
  - `refresh(refreshToken)` → same token endpoint, `grant_type=refresh_token`; **returns the NEW `refresh_token` from the response** (QBO rotates it).

- [ ] **Step 1: Write failing tests** `quickbooksProvider.test.ts`, mocking `fetch`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('QuickbooksProvider', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('buildAuthUrl embeds state, scope, redirect_uri', async () => {
    const { quickbooksProvider } = await import('./quickbooksProvider');
    const url = quickbooksProvider.buildAuthUrl('state-abc');
    expect(url).toContain('com.intuit.quickbooks.accounting');
    expect(url).toContain('state=state-abc');
    expect(url).toContain('response_type=code');
  });

  it('refresh returns the ROTATED refresh token, not the input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-at', refresh_token: 'ROTATED-rt',
      expires_in: 3600, x_refresh_token_expires_in: 8640000,
    }), { status: 200 })));
    const { quickbooksProvider } = await import('./quickbooksProvider');
    const tokens = await quickbooksProvider.refresh('old-rt');
    expect(tokens.refreshToken).toBe('ROTATED-rt');
    expect(tokens.accessToken).toBe('new-at');
    expect(tokens.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('exchangeCode posts grant_type=authorization_code and parses expiry', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at', refresh_token: 'rt', expires_in: 3600, x_refresh_token_expires_in: 8640000,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { quickbooksProvider } = await import('./quickbooksProvider');
    const tokens = await quickbooksProvider.exchangeCode('the-code', 'realm-9');
    expect(tokens.realmId).toBe('realm-9');
    const body = String(fetchMock.mock.calls[0][1]?.body ?? '');
    expect(body).toContain('grant_type=authorization_code');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `quickbooksProvider.ts`. Token endpoint is constant `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`; auth header `Basic ${base64(QBO_CLIENT_ID:QBO_CLIENT_SECRET)}`; body `application/x-www-form-urlencoded`. `verifyWebhook` = HMAC-SHA256 of raw body with verifier token, base64-compared constant-time to the `intuit-signature` header. Stub the not-yet-built methods with `throw new Error('NotImplemented: ...')`. Wire the registry (Task 3) to return this singleton.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(accounting): QuickbooksProvider OAuth exchange + refresh-token rotation"`

---

### Task 5: Token-refresh manager (inline, 5-min buffer, persist rotation)

**Files:**
- Create: `apps/api/src/services/accounting/accountingTokens.ts`
- Test: `apps/api/src/services/accounting/accountingTokens.test.ts`

**Interfaces:**
- Consumes: `getConnection`/`updateTokens`/`markStatus` (Task 2); `getAccountingProvider` (Task 3).
- Produces: `getValidAccessToken(db, connection): Promise<string>` — if `accessTokenExpiresAt > now + 5min`, return current token; else call `provider.refresh(connection.refreshToken)`, **persist the rotated refresh token + new access token via `updateTokens`**, return the new access token. If `refreshTokenExpiresAt < now` (or refresh 400s with `invalid_grant`), call `markStatus(..., 'reauth_required')` and throw `ReauthRequiredError`.

- [ ] **Step 1: Write failing tests** `accountingTokens.test.ts`:
  - access token valid (expires in 30 min) → returns existing token, `updateTokens` NOT called.
  - access token within 5-min buffer → calls `provider.refresh`, then `updateTokens` with the **rotated** refresh token (assert the persisted `refreshToken` equals the provider's returned rotated value, not the old one).
  - refresh token expired → throws `ReauthRequiredError` and `markStatus('reauth_required')` called.

```ts
it('persists the rotated refresh token on refresh', async () => {
  const updateTokens = vi.fn();
  // connection with access token expiring in 1 minute, refresh valid
  const provider = { refresh: vi.fn(async () => ({
    realmId: 'r', accessToken: 'NEW-at', refreshToken: 'NEW-rt',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 8640000_000),
  })) };
  // ... wire mocks for getAccountingProvider + updateTokens ...
  const token = await getValidAccessToken(db, conn);
  expect(token).toBe('NEW-at');
  expect(updateTokens).toHaveBeenCalledWith(
    db, conn.id, conn.partnerId,
    expect.objectContaining({ refreshToken: 'NEW-rt', accessToken: 'NEW-at' }),
  );
});
```

- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `accountingTokens.ts` per interface. Define `class ReauthRequiredError extends Error`. Wrap the `provider.refresh` HTTP call with `runOutsideDbContext` (import from `apps/api/src/db`).
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(accounting): inline token refresh with rotation persistence + reauth gating"`

---

### Task 6: OAuth routes (connect / callback / disconnect / status)

**Files:**
- Create: `apps/api/src/routes/accounting/index.ts`
- Modify: `apps/api/src/index.ts` (import ~line 38-133 region; mount ~line 765 region)
- Test: `apps/api/src/routes/accounting/index.test.ts`

**Interfaces:**
- Consumes: connection repo (Task 2), provider (Task 4), env (Task 3). Auth middleware: `requireScope('partner','system')`, `requireMfa()` — import the same helpers `pax8Routes`/`stripeConnectRoutes` use (grep those route files).
- Produces a Hono router mounted at `/accounting` exposing:
  - `GET /accounting/:provider/connect` → returns `{ authUrl }` (or 302). Generates a signed/opaque `state` bound to `partnerId` (sign with an existing app secret; store nothing server-side beyond a short-lived nonce — match how `oauth.ts` handles state if a helper exists, else HMAC the partnerId+nonce).
  - `GET /accounting/:provider/callback?code=&realmId=&state=` → validate `state`, `exchangeCode`, `upsertConnection` (status `connected`, capture `homeCurrency` is deferred to Phase B — leave null), redirect to the web integrations page with a success flag. **`requireMfa()` + partner scope.**
  - `POST /accounting/:provider/disconnect` → `deleteConnection` (or `markStatus('disconnected')` + null tokens). **`requireMfa()`.**
  - `GET /accounting/:provider` → `{ status, environment, pushMode, connectedAt, lastError }` (never returns tokens).
  - `PATCH /accounting/:provider/settings` → update `pushMode` (`auto|manual`), `defaultIncomeAccountRef`, `defaultTaxCodeRef`. (income/tax refs are set in Phase B UI but the column write lands here.)

- [ ] **Step 1: Write failing route tests** `index.test.ts` (Drizzle-mock + Hono test client, mirroring an existing `routes/*.test.ts`): connect returns an authUrl containing the provider scope; status endpoint returns `{status}` and never a token field; callback with a bad `state` → 400; disconnect requires MFA (simulate missing-MFA → 403).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** the router; mount in `index.ts` as `api.route('/accounting', accountingRoutes);` near the other integration mounts. Wrap any provider HTTP call in `runOutsideDbContext`.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(accounting): OAuth connect/callback/disconnect/status routes for QuickBooks"`

---

### Task 7: RLS forge integration test (real DB)

**Files:**
- Create: `apps/api/src/__tests__/integration/accounting-connections-rls.integration.test.ts`

**Interfaces:**
- Consumes: real `breeze_app` connection (RLS forced). Per `test_realdb_placement_convention` + `test_integration_config_run_mechanics`, this MUST live in `src/__tests__/integration/*.integration.test.ts` and run via the integration config.

- [ ] **Step 1: Write the forge test** — seed two partners (A, B). As partner A's context, insert an `accounting_connections` row → succeeds. Then forge a cross-partner write: attempt to insert/select partner B's connection while in partner A's context → must yield **0 rows** (select) and the insert must fail with `new row violates row-level security policy`. Re-seed per test (per `rls-forge-test-memoized-fixture-vacuous` — do NOT memoize the fixture). Include a system-scope existence probe to prove the row really exists before asserting A can't see it.
- [ ] **Step 2: Run it** — confirm `.env.test` symlink present and `rolbypassrls=false` for the test role (per `worktree_env_test_rls_vacuous`):
```
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/accounting-connections-rls.integration.test.ts
```
Expected: PASS (cross-partner blocked); if it passes vacuously (no error on forge), STOP — the test role has BYPASSRLS, fix the env before trusting it.
- [ ] **Step 3: Run the RLS coverage contract test** to confirm the allowlist entry is consistent:
```
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts
```
Expected: PASS (accounting_connections recognized as partner-axis).
- [ ] **Step 4: Commit** — `git commit -m "test(accounting): RLS forge — cross-partner accounting_connections isolation"`

---

### Task 8: Web UI — QuickBooks integration card *(in-session, Opus — not delegated to Codex)*

**Files:**
- Create: `apps/web/src/components/integrations/QuickbooksIntegration.tsx`
- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx` (add a tab/card under the appropriate section — grep how `Pax8Integration`/`HuntressIntegration` are wired, incl. hash deep-link)

**Interfaces:**
- Consumes: the Task 6 routes (`GET /accounting/quickbooks`, connect, disconnect, settings).
- Produces: a card showing connection status (Connected / Not connected / Reconnect required), a "Connect to QuickBooks" button (navigates to `authUrl`), Disconnect, environment + push-mode toggle (`auto|manual`). All mutations wrapped in `runAction`; scope-gated UI message for org-scoped users (mirror `Pax8Integration.tsx`); MFA-error hint on 403.

- [ ] **Step 1:** Build the component mirroring `Pax8Integration.tsx` structure and `runAction` usage.
- [ ] **Step 2:** Wire into `IntegrationsPage.tsx` with hash deep-link.
- [ ] **Step 3:** Web test (Vitest + jsdom) for the status states; scope queries within the card's testid (per `web_responsive_table_primitive_jsdom_dupe` if a ResponsiveTable is involved).
- [ ] **Step 4: Commit** — `git commit -m "feat(web): QuickBooks accounting integration card"`

---

## Self-Review

**Spec coverage:** Phase A scope from the spec = connection table (Task 1) ✓, encrypted token store (Tasks 1–2) ✓, `AccountingProvider` interface (Task 3) ✓, QBO OAuth + refresh-token rotation (Tasks 4–5) ✓, connect/disconnect/status routes with scope+MFA gating (Task 6) ✓, settings UI + connection health (Task 8) ✓, RLS shape-3 + allowlist + forge test (Tasks 1, 7) ✓. Webhook verifier method stubbed in Task 4 (full webhook endpoint is Phase D) ✓. Customer/item/invoice/reconcile provider methods declared-but-`NotImplemented`, correctly deferred to B–D ✓.

**Type consistency:** `AccountingConnection` shape defined in Task 2 is consumed by Tasks 3/5/6; `ConnectionTokens` defined in Task 3 is produced by Task 4 and consumed by Task 5; `getValidAccessToken`/`updateTokens`/`getConnection` names consistent across tasks. `quickbooksProvider` singleton name consistent (Tasks 3–4).

**Placeholder scan:** no TBD/TODO; every code step shows real code. The one intentional stub (`NotImplemented` provider methods) is an explicit, scoped deferral, not a plan gap.

## Notes for the Codex implementer

- Tasks 1–7 are Codex-suitable (scoped, contract handed over here). **Task 8 (web UI) stays in-session on Opus** per project preference — do not delegate it to Codex.
- For the RLS migration (Task 1) and forge test (Task 7), the full contract is in this plan + the CLAUDE.md "Tenant Isolation / RLS" section — read both; do not improvise the policy shape.
- Sandbox-only HTTP: do not call real Intuit endpoints in tests — all `fetch` is mocked. A manual sandbox smoke against a real QBO sandbox realm is a separate, env-gated step, not part of CI.
