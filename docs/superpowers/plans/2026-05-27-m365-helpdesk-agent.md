# M365 Helpdesk Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Breeze's AI agent a tier-1 Microsoft 365 helpdesk capability (lookup user, recent sign-ins, group memberships, disable account, reset password) executed through Delegant's `/v1/tools/invoke` wire contract, scoped per-customer-tenant, with mutations gated by Breeze's existing approval UI.

**Architecture:** Five new `m365_*` tools register into Breeze's existing static `aiTools` Map. A thin `delegantClient.ts` owns all HTTP + principal-JWT minting + error mapping to Delegant. Each AI session binds to one customer via a new `delegant_m365_connections` row (pointers into Delegant, no secrets). Approvals stay in Breeze (`ai_tool_executions` + `waitForApproval`); audit stays in Delegant (hash-chained ledger); the two link by a correlation id. No direct-to-Graph fallback — if Delegant is down, tools fail loud and the AI tells the user.

**Tech Stack:** TypeScript, Hono (api), Drizzle ORM (Postgres, hand-written dated SQL migrations applied by `autoMigrate.ts`), `jose` for EdDSA JWT, Vitest, pnpm + turbo monorepo. AI tools use the Anthropic SDK `Tool` shape.

**Spec:** `~/Delegant/docs/superpowers/specs/2026-05-27-delegant-slice12-breeze-m365-helpdesk-design.md`

**Repo:** This plan executes in `~/Breeze`. The `@breeze/api` package is at `apps/api/`. All commands below assume CWD `~/Breeze` unless noted; the api test command is `pnpm --filter @breeze/api test`.

---

## File Structure

**Created:**
- `apps/api/src/db/schema/delegant.ts` — `delegantM365Connections` table definition.
- `apps/api/migrations/2026-05-27-b-delegant-m365-connections.sql` — create the connection table.
- `apps/api/migrations/2026-05-27-c-ai-sessions-delegant-connection.sql` — add `delegant_m365_connection_id` to `ai_sessions` and `delegant_tool_call_id` to `ai_tool_executions`.
- `apps/api/src/services/delegantClient.ts` — JWT mint + HTTP + response→result mapping. The whole Breeze↔Delegant boundary.
- `apps/api/src/services/delegantClient.test.ts` — unit tests for the client.
- `apps/api/src/services/aiToolsM365.ts` — the five `m365_*` tool definitions + handlers + a `registerM365Tools()` function.
- `apps/api/src/services/aiToolsM365.test.ts` — unit tests for the handlers.
- `apps/api/src/services/m365Helpers.ts` — shared helpers (`loadCurrentSession`, `loadConnection`, `resolveUserId`, `formatResultForLlm`, principal loaders).
- `apps/api/test-live/m365.live.test.ts` — opt-in live suite (skips without creds).
- `docs/runbooks/m365-helpdesk-agent.md` — operator runbook (env vars, manual seeding).

**Modified:**
- `apps/api/src/db/schema/index.ts` — add `export * from './delegant';`.
- `apps/api/src/config/env.ts` — add the four `DELEGANT_*` env constants.
- `apps/api/src/services/aiTools.ts` — call `registerM365Tools(aiTools)` alongside the other registrations.
- `apps/api/src/services/aiGuardrails.ts` — add the five tools to `TOOL_TIERS` (or equivalent) and `TOOL_PERMISSIONS`.
- `apps/api/src/services/aiAgentSdk.ts` — when building the per-step approval `riskSummary`, enrich M365 tool calls with customer + target user + reason.
- `apps/web/src/...` (customer switcher) — exact files discovered in Task 9; the new-session flow gains a customer selector and the chat header gains a customer badge.
- `apps/mobile/src/screens/approvals/...` — add a "Customer tenant" line above `RiskBand` (exact file discovered in Task 10).

> **Note on file-path precision:** the api-side paths above are verified to exist (2026-05-27). The web and mobile paths in Tasks 9–10 require a short discovery step (greps included in the task) because the exact component files weren't enumerated during planning. Every other task uses verified paths.

---

## Pre-flight: confirm conventions (do once, no commit)

- [ ] **Step 0.1: Read the existing tool registration to confirm the `AiTool` shape and registration pattern**

Run:
```bash
cd ~/Breeze && sed -n '1,80p' apps/api/src/services/aiTools.ts
```
Expected: an `export interface AiTool { definition: Anthropic.Tool; tier: ...; handler: (input, auth) => Promise<string> }` and a series of `registerXxxTools(aiTools)` calls. Confirm the exact tier type (`1 | 2 | 3 | 4`) and the `AuthContext` import path. If the shape differs from what this plan assumes, note the delta before proceeding — every handler task depends on it.

- [ ] **Step 0.2: Read the guardrails maps to confirm where tiers and permissions are declared**

Run:
```bash
cd ~/Breeze && sed -n '1,260p' apps/api/src/services/aiGuardrails.ts
```
Expected: `TOOL_TIERS`, `TIER3_ACTIONS`/etc., and `TOOL_PERMISSIONS`. Confirm whether tier lives on the tool definition, in `TOOL_TIERS`, or both. This plan assumes tier is on the `AiTool.tier` field AND mirrored in guardrails where existing tools are; follow whatever the existing tools do.

- [ ] **Step 0.3: Read how a handler obtains the current session + how `aiToolExecutions` rows are written**

Run:
```bash
cd ~/Breeze && sed -n '1,200p' apps/api/src/services/aiAgent.ts && echo "---SDK---" && sed -n '180,370p' apps/api/src/services/aiAgentSdk.ts
```
Expected: confirm how a handler can reach `session.id`, `session.orgId`, and (after this plan) `session.delegantM365ConnectionId`. Confirm where `riskSummary` is generated for the approval row — that's the hook Task 8 modifies.

---

## Task 1: Config — Delegant env constants

**Files:**
- Modify: `apps/api/src/config/env.ts`
- Test: `apps/api/src/config/env.delegant.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/config/env.delegant.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('delegant env config', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL }; });

  it('reads DELEGANT_* vars when present', async () => {
    process.env.DELEGANT_BASE_URL = 'https://delegant.example';
    process.env.DELEGANT_SERVICE_TOKEN = 'svc-token';
    process.env.DELEGANT_PRINCIPAL_SIGNING_KEY = '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----';
    process.env.DELEGANT_PRINCIPAL_KID = 'kid-1';
    const mod = await import('./env?delegant-present' as string).catch(() => import('./env'));
    expect(mod.DELEGANT_BASE_URL).toBe('https://delegant.example');
    expect(mod.DELEGANT_SERVICE_TOKEN).toBe('svc-token');
    expect(mod.DELEGANT_PRINCIPAL_KID).toBe('kid-1');
    expect(mod.DELEGANT_PRINCIPAL_SIGNING_KEY).toContain('BEGIN PRIVATE KEY');
  });

  it('defaults to empty strings when absent', async () => {
    delete process.env.DELEGANT_BASE_URL;
    const mod = await import('./env');
    expect(typeof mod.DELEGANT_BASE_URL).toBe('string');
  });
});
```
> The dynamic-import-with-query trick avoids module cache staleness; if Breeze's vitest config can't resolve the query suffix, the `.catch` falls back to the plain import. Keep it simple — the assertion that matters is that the constants exist and read from `process.env`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test env.delegant`
Expected: FAIL — `DELEGANT_BASE_URL` is undefined on the imported module.

- [ ] **Step 3: Add the constants**

In `apps/api/src/config/env.ts`, alongside the existing `process.env` reads, add:
```ts
export const DELEGANT_BASE_URL = process.env.DELEGANT_BASE_URL ?? '';
export const DELEGANT_SERVICE_TOKEN = process.env.DELEGANT_SERVICE_TOKEN ?? '';
export const DELEGANT_PRINCIPAL_SIGNING_KEY = process.env.DELEGANT_PRINCIPAL_SIGNING_KEY ?? '';
export const DELEGANT_PRINCIPAL_KID = process.env.DELEGANT_PRINCIPAL_KID ?? '';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test env.delegant`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config/env.ts apps/api/src/config/env.delegant.test.ts
git commit -m "feat(m365): add DELEGANT_* env config constants"
```

---

## Task 2: Schema — `delegant_m365_connections` table definition

**Files:**
- Create: `apps/api/src/db/schema/delegant.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Test: `apps/api/src/db/schema/delegant.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/db/schema/delegant.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { delegantM365Connections } from './delegant';

describe('delegantM365Connections schema', () => {
  it('has the expected columns', () => {
    const cfg = getTableConfig(delegantM365Connections);
    const names = cfg.columns.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'id', 'org_id', 'customer_label', 'customer_display_name',
        'delegant_org_id', 'delegant_connection_id', 'm365_tenant_id',
        'status', 'last_verified_at', 'created_at', 'updated_at',
      ].sort(),
    );
  });

  it('is named delegant_m365_connections', () => {
    expect(getTableConfig(delegantM365Connections).name).toBe('delegant_m365_connections');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test schema/delegant`
Expected: FAIL — cannot import `./delegant`.

- [ ] **Step 3: Write the schema**

Create `apps/api/src/db/schema/delegant.ts`. Match the import style of a sibling file (open `apps/api/src/db/schema/c2c.ts` first to copy the exact `drizzle-orm/pg-core` import line and timestamp helper conventions):
```ts
import {
  pgTable, uuid, varchar, timestamp, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

export const delegantM365Connections = pgTable('delegant_m365_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  customerLabel: varchar('customer_label', { length: 128 }).notNull(),
  customerDisplayName: varchar('customer_display_name', { length: 256 }).notNull(),
  delegantOrgId: varchar('delegant_org_id', { length: 64 }).notNull(),
  delegantConnectionId: varchar('delegant_connection_id', { length: 64 }).notNull(),
  m365TenantId: varchar('m365_tenant_id', { length: 64 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('active'),
  lastVerifiedAt: timestamp('last_verified_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  orgCustomerUniq: uniqueIndex('delegant_m365_org_customer_uniq').on(t.orgId, t.customerLabel),
  orgIdx: index('delegant_m365_org_idx').on(t.orgId),
}));

export type DelegantM365ConnectionRow = typeof delegantM365Connections.$inferSelect;
```

- [ ] **Step 4: Wire it into the schema barrel**

In `apps/api/src/db/schema/index.ts`, add at the end:
```ts
export * from './delegant';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test schema/delegant`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/delegant.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/delegant.test.ts
git commit -m "feat(m365): delegant_m365_connections schema"
```

---

## Task 3: Migrations — create table + add session/execution columns

**Files:**
- Create: `apps/api/migrations/2026-05-27-b-delegant-m365-connections.sql`
- Create: `apps/api/migrations/2026-05-27-c-ai-sessions-delegant-connection.sql`

> Breeze migrations are hand-written dated SQL applied transactionally by `autoMigrate.ts`. File naming: `YYYY-MM-DD-<letter>-<slug>.sql`. The latest existing file is `2026-05-27-a-elevation-status-add-actuating.sql`, so use letters `b` and `c`.

- [ ] **Step 1: Write the table-creation migration**

Create `apps/api/migrations/2026-05-27-b-delegant-m365-connections.sql`:
```sql
-- Per-customer M365 connection pointers for the Breeze AI agent's Delegant
-- integration. Stores references into Delegant + display metadata only.
-- NO secrets here: the per-customer Entra client secret lives in Delegant.
CREATE TABLE IF NOT EXISTS delegant_m365_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL,
  customer_label        VARCHAR(128) NOT NULL,
  customer_display_name VARCHAR(256) NOT NULL,
  delegant_org_id       VARCHAR(64) NOT NULL,
  delegant_connection_id VARCHAR(64) NOT NULL,
  m365_tenant_id        VARCHAR(64) NOT NULL,
  status                VARCHAR(32) NOT NULL DEFAULT 'active',
  last_verified_at      TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS delegant_m365_org_customer_uniq
  ON delegant_m365_connections (org_id, customer_label);
CREATE INDEX IF NOT EXISTS delegant_m365_org_idx
  ON delegant_m365_connections (org_id);
```
> Check whether sibling tables (e.g. `c2c_connections`) have RLS policies attached. If Breeze enforces row-level security per-org on tenant data, add the matching `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + policy here, mirroring the c2c table exactly. Open the migration that created `c2c_connections` to confirm.

- [ ] **Step 2: Write the column-addition migration**

Create `apps/api/migrations/2026-05-27-c-ai-sessions-delegant-connection.sql`:
```sql
-- Bind an AI session to one customer M365 connection for its lifetime, and
-- correlate a tool execution to its Delegant audit entry.
ALTER TABLE ai_sessions
  ADD COLUMN IF NOT EXISTS delegant_m365_connection_id UUID
  REFERENCES delegant_m365_connections (id);

ALTER TABLE ai_tool_executions
  ADD COLUMN IF NOT EXISTS delegant_tool_call_id VARCHAR(64);
```

- [ ] **Step 3: Apply migrations against a local/test DB**

Run:
```bash
cd ~/Breeze && pnpm --filter @breeze/api db:migrate
```
Expected: both files apply cleanly; `autoMigrate` reports them recorded in `breeze_migrations`.

- [ ] **Step 4: Verify drift check passes**

Run:
```bash
cd ~/Breeze && pnpm --filter @breeze/api db:check-drift
```
Expected: no drift (the Drizzle schema from Task 2 matches the migrated DB). If drift is reported, reconcile the SQL with the schema definition until clean.

- [ ] **Step 5: Add the Drizzle columns to the existing schemas (so drift stays clean)**

In `apps/api/src/db/schema/ai.ts`, add to the `aiSessions` table definition:
```ts
  delegantM365ConnectionId: uuid('delegant_m365_connection_id'),
```
and to the `aiToolExecutions` table definition:
```ts
  delegantToolCallId: varchar('delegant_tool_call_id', { length: 64 }),
```
Re-run `pnpm --filter @breeze/api db:check-drift` — expected: clean. (If `uuid`/`varchar` aren't already imported in `ai.ts`, add them to the existing `drizzle-orm/pg-core` import.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-05-27-b-delegant-m365-connections.sql apps/api/migrations/2026-05-27-c-ai-sessions-delegant-connection.sql apps/api/src/db/schema/ai.ts
git commit -m "feat(m365): migrations for connections table + session/execution columns"
```

---

## Task 4: Delegant client — JWT minting

**Files:**
- Create: `apps/api/src/services/delegantClient.ts`
- Test: `apps/api/src/services/delegantClient.test.ts`

> `jose` is already a transitive/dev dep in most Breeze installs (the api uses JWTs for OAuth). Confirm with `cd ~/Breeze && pnpm --filter @breeze/api list jose`. If absent, `pnpm --filter @breeze/api add jose` and commit the lockfile change in this task.

- [ ] **Step 1: Write the failing test for JWT claims**

Create `apps/api/src/services/delegantClient.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPair, exportPKCS8, exportJWK, jwtVerify, importJWK } from 'jose';
import { __mintPrincipalJwtForTest } from './delegantClient';

let privatePem: string;
let publicJwk: any;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  privatePem = await exportPKCS8(privateKey);
  publicJwk = await exportJWK(publicKey);
});

describe('mintPrincipalJwt', () => {
  it('mints a breeze_ai_agent token with the acting-user chain and required claims', async () => {
    const token = await __mintPrincipalJwtForTest({
      signingKeyPem: privatePem,
      kid: 'kid-1',
      agentPrincipalId: 'agent-123',
      breezeOrgId: 'should-not-be-used',
      delegantOrgId: 'dorg-456',
      actingUserBreezeId: 'tech-1',
      actingUserDelegantId: 'duser-789',
      sessionId: 'sess-1',
      nowSeconds: 1_000_000,
    });
    const pubKey = await importJWK(publicJwk, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, pubKey, {
      issuer: 'breeze-api', audience: 'delegant',
    });
    expect(protectedHeader.kid).toBe('kid-1');
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.sub).toBe('agent-123');
    expect(payload.principal_type).toBe('breeze_ai_agent');
    expect(payload.breeze_org_id).toBe('dorg-456'); // delegant org, not breeze org
    expect(payload.breeze_acting_user_id).toBe('duser-789');
    expect(payload.breeze_user_id).toBe('tech-1');
    expect(payload.breeze_session_id).toBe('sess-1');
    expect(payload.exp).toBe(1_000_060); // now + 60
    expect(typeof payload.jti).toBe('string');
  });

  it('produces a unique jti on each call', async () => {
    const args = {
      signingKeyPem: privatePem, kid: 'kid-1', agentPrincipalId: 'a',
      breezeOrgId: 'b', delegantOrgId: 'd', actingUserBreezeId: 't',
      actingUserDelegantId: 'u', sessionId: 's', nowSeconds: 1,
    };
    const t1 = await __mintPrincipalJwtForTest(args);
    const t2 = await __mintPrincipalJwtForTest(args);
    const p1 = JSON.parse(Buffer.from(t1.split('.')[1], 'base64url').toString());
    const p2 = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString());
    expect(p1.jti).not.toBe(p2.jti);
  });
});
```
> Claim names must match Delegant's `claimsSchema` exactly (`~/Delegant/src/api/wire/principal-jwt.ts`): `sub, iss, aud, iat, exp, jti, breeze_org_id, principal_type, breeze_user_id?, breeze_acting_user_id?, breeze_session_id?`. `breeze_org_id` carries the **Delegant** org id, and `breeze_acting_user_id` must be a UUID.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @breeze/api test delegantClient`
Expected: FAIL — cannot import `__mintPrincipalJwtForTest`.

- [ ] **Step 3: Implement JWT minting**

Create `apps/api/src/services/delegantClient.ts` (minting portion only for now):
```ts
import { SignJWT, importPKCS8 } from 'jose';
import { randomUUID } from 'node:crypto';

interface MintArgs {
  signingKeyPem: string;
  kid: string;
  agentPrincipalId: string;
  breezeOrgId: string;        // accepted but not placed in token; delegantOrgId is authoritative
  delegantOrgId: string;
  actingUserBreezeId: string;
  actingUserDelegantId: string;
  sessionId: string;
  nowSeconds: number;
}

async function mintPrincipalJwt(args: MintArgs): Promise<string> {
  const key = await importPKCS8(args.signingKeyPem, 'EdDSA');
  return new SignJWT({
    breeze_org_id: args.delegantOrgId,
    principal_type: 'breeze_ai_agent',
    breeze_user_id: args.actingUserBreezeId,
    breeze_acting_user_id: args.actingUserDelegantId,
    breeze_session_id: args.sessionId,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: args.kid })
    .setSubject(args.agentPrincipalId)
    .setIssuer('breeze-api')
    .setAudience('delegant')
    .setIssuedAt(args.nowSeconds)
    .setExpirationTime(args.nowSeconds + 60)
    .setJti(randomUUID())
    .sign(key);
}

export const __mintPrincipalJwtForTest = mintPrincipalJwt;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @breeze/api test delegantClient`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/delegantClient.ts apps/api/src/services/delegantClient.test.ts
git commit -m "feat(m365): delegant principal JWT minting"
```

---

## Task 5: Delegant client — HTTP invoke + response mapping

**Files:**
- Modify: `apps/api/src/services/delegantClient.ts`
- Modify: `apps/api/src/services/delegantClient.test.ts`

- [ ] **Step 1: Write the failing tests for the response→result mapping**

Append to `apps/api/src/services/delegantClient.test.ts`:
```ts
import { vi } from 'vitest';
import { invokeDelegantTool } from './delegantClient';

function mockFetchOnce(status: number, body: unknown, opts: { throwNetwork?: boolean } = {}) {
  if (opts.throwNetwork) {
    return vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  }
  return vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

const baseArgs = () => ({
  connection: {
    id: 'conn-1', orgId: 'org-1', customerLabel: 'pinnacle',
    customerDisplayName: 'Pinnacle', delegantOrgId: 'dorg-1',
    delegantConnectionId: 'dconn-1', m365TenantId: 'tid-1',
    status: 'active', lastVerifiedAt: null, createdAt: new Date(), updatedAt: new Date(),
  } as any,
  toolName: 'get_user' as const,
  parameters: { userId: 'u1' },
  actingUser: { breezeUserId: 'tech-1', delegantPrincipalId: 'duser-1' },
  agent: { delegantPrincipalId: 'agent-1' },
  sessionId: 'sess-1',
});

describe('invokeDelegantTool response mapping', () => {
  const env = {
    DELEGANT_BASE_URL: 'https://delegant.example',
    DELEGANT_SERVICE_TOKEN: 'svc',
    DELEGANT_PRINCIPAL_SIGNING_KEY: '', // set in beforeAll via real key
    DELEGANT_PRINCIPAL_KID: 'kid-1',
  };
  beforeAll(() => { env.DELEGANT_PRINCIPAL_SIGNING_KEY = privatePem; });

  it('maps 200 + {isError:false,data} to ok', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, data: { id: 'u1' } });
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    expect(res).toEqual({ kind: 'ok', data: { id: 'u1' } });
  });

  it('maps 200 + {isError:true,message} to error/tool_error', async () => {
    const fetchMock = mockFetchOnce(200, { isError: true, message: 'user not found' });
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    expect(res).toEqual({ kind: 'error', code: 'tool_error', message: 'user not found' });
  });

  it('maps 200 + {pending:true} to error/unexpected_pending (fail loud)', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, pending: true, approvalRequestId: 'a1' });
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    expect(res).toMatchObject({ kind: 'error', code: 'unexpected_pending' });
  });

  it('maps 401 to error/auth_failed', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(401, { error: 'unauthorized' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'auth_failed' });
  });

  it('maps 403 to error/forbidden', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(403, { error: 'forbidden_principal_type' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'forbidden' });
  });

  it('maps 400 to error/bad_request', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(400, { error: 'missing toolName' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'bad_request' });
  });

  it('maps 404 to error/not_found', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(404, { error: 'unknown tool' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'not_found' });
  });

  it('maps 500 to error/delegant_unavailable', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(500, { isError: true, message: 'Internal error' }) });
    expect(res).toMatchObject({ kind: 'error', code: 'delegant_unavailable' });
  });

  it('maps a network throw to error/delegant_unreachable', async () => {
    const res = await invokeDelegantTool(baseArgs(), { env, fetchImpl: mockFetchOnce(0, null, { throwNetwork: true }) });
    expect(res).toMatchObject({ kind: 'error', code: 'delegant_unreachable' });
  });

  it('sends the service token and principal header', async () => {
    const fetchMock = mockFetchOnce(200, { isError: false, data: {} });
    await invokeDelegantTool(baseArgs(), { env, fetchImpl: fetchMock });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://delegant.example/v1/tools/invoke');
    expect(init.headers['Authorization']).toBe('Bearer svc');
    expect(typeof init.headers['X-Delegant-Principal']).toBe('string');
    expect(JSON.parse(init.body)).toEqual({ toolName: 'get_user', parameters: { userId: 'u1' } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @breeze/api test delegantClient`
Expected: FAIL — `invokeDelegantTool` not exported.

- [ ] **Step 3: Implement the client**

Append to `apps/api/src/services/delegantClient.ts`:
```ts
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';

export type DelegantToolName =
  | 'get_user' | 'get_user_signin_activity' | 'list_groups'
  | 'get_group_members' | 'disable_user' | 'reset_user_password';

export type DelegantErrorCode =
  | 'tool_error' | 'unexpected_pending' | 'bad_request' | 'auth_failed'
  | 'forbidden' | 'not_found' | 'delegant_unavailable' | 'delegant_unreachable'
  | 'unexpected';

export interface DelegantInvokeArgs {
  connection: DelegantM365ConnectionRow;
  toolName: DelegantToolName;
  parameters: Record<string, unknown>;
  actingUser: { breezeUserId: string; delegantPrincipalId: string };
  agent: { delegantPrincipalId: string };
  sessionId: string;
}

export type DelegantInvokeResult =
  | { kind: 'ok'; data: unknown }   // Task 11 widens this to add an optional `toolCallId?: string`
  | { kind: 'error'; code: DelegantErrorCode; message: string };

interface InvokeDeps {
  env: {
    DELEGANT_BASE_URL: string; DELEGANT_SERVICE_TOKEN: string;
    DELEGANT_PRINCIPAL_SIGNING_KEY: string; DELEGANT_PRINCIPAL_KID: string;
  };
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

const TIMEOUT_MS = 15_000;

export async function invokeDelegantTool(
  args: DelegantInvokeArgs,
  deps: InvokeDeps,
): Promise<DelegantInvokeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.nowSeconds ? deps.nowSeconds() : Math.floor(Date.now() / 1000);
  const requestId = randomUUID();

  let token: string;
  try {
    token = await mintPrincipalJwt({
      signingKeyPem: deps.env.DELEGANT_PRINCIPAL_SIGNING_KEY,
      kid: deps.env.DELEGANT_PRINCIPAL_KID,
      agentPrincipalId: args.agent.delegantPrincipalId,
      breezeOrgId: args.connection.orgId,
      delegantOrgId: args.connection.delegantOrgId,
      actingUserBreezeId: args.actingUser.breezeUserId,
      actingUserDelegantId: args.actingUser.delegantPrincipalId,
      sessionId: args.sessionId,
      nowSeconds: now,
    });
  } catch (err) {
    return { kind: 'error', code: 'unexpected', message: `failed to mint token: ${String(err)}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let result: DelegantInvokeResult;
  try {
    const resp = await fetchImpl(`${deps.env.DELEGANT_BASE_URL}/v1/tools/invoke`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${deps.env.DELEGANT_SERVICE_TOKEN}`,
        'X-Delegant-Principal': token,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({ toolName: args.toolName, parameters: args.parameters }),
      signal: controller.signal,
    });
    result = await mapResponse(resp);
  } catch {
    result = { kind: 'error', code: 'delegant_unreachable', message: 'Could not reach the M365 service.' };
  } finally {
    clearTimeout(timer);
  }

  logInvoke({
    toolName: args.toolName, connectionId: args.connection.id,
    customerLabel: args.connection.customerLabel, sessionId: args.sessionId,
    requestId, durationMs: Date.now() - started, result,
  });
  return result;
}

async function mapResponse(resp: Response): Promise<DelegantInvokeResult> {
  const body = await resp.json().catch(() => null) as any;
  if (resp.status === 200) {
    if (body && body.pending === true) {
      return { kind: 'error', code: 'unexpected_pending',
        message: 'Delegant returned a pending approval; expected allow. Check Delegant policy for this org.' };
    }
    if (body && body.isError === true) {
      return { kind: 'error', code: 'tool_error', message: String(body.message ?? 'tool error') };
    }
    return { kind: 'ok', data: body?.data ?? body };
  }
  const message = String(body?.message ?? body?.error ?? `HTTP ${resp.status}`);
  switch (resp.status) {
    case 400: return { kind: 'error', code: 'bad_request', message };
    case 401: return { kind: 'error', code: 'auth_failed', message };
    case 403: return { kind: 'error', code: 'forbidden', message };
    case 404: return { kind: 'error', code: 'not_found', message };
    default:
      if (resp.status >= 500) return { kind: 'error', code: 'delegant_unavailable', message };
      return { kind: 'error', code: 'unexpected', message };
  }
}

function logInvoke(fields: {
  toolName: string; connectionId: string; customerLabel: string;
  sessionId: string; requestId: string; durationMs: number; result: DelegantInvokeResult;
}): void {
  const base = {
    msg: 'delegant_invoke', toolName: fields.toolName, connectionId: fields.connectionId,
    customerLabel: fields.customerLabel, sessionId: fields.sessionId,
    requestId: fields.requestId, durationMs: fields.durationMs, kind: fields.result.kind,
  };
  if (fields.result.kind === 'error') {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ ...base, code: fields.result.code, error: fields.result.message.slice(0, 200) }));
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(base));
  }
}
```
> Replace `console.log`/`console.error` with Breeze's actual logger if one is conventional in `services/` (check how `c2cM365.ts` logs). The structured-line requirement is what matters: never log `parameters` (UPNs go to Delegant's audit, not Breeze logs).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @breeze/api test delegantClient`
Expected: PASS (all mapping cases + header assertions).

- [ ] **Step 5: Add a test asserting no UPN is logged**

Append:
```ts
it('does not log tool parameters', async () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = baseArgs();
  args.parameters = { userId: 'jane.doe@pinnacle.dental' };
  await invokeDelegantTool(args, { env, fetchImpl: mockFetchOnce(200, { isError: false, data: {} }) });
  const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
  expect(logged).not.toContain('jane.doe@pinnacle.dental');
  spy.mockRestore();
});
```
Run: `pnpm --filter @breeze/api test delegantClient` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/delegantClient.ts apps/api/src/services/delegantClient.test.ts
git commit -m "feat(m365): delegant HTTP invoke + response mapping + safe logging"
```

---

## Task 6: M365 shared helpers

**Files:**
- Create: `apps/api/src/services/m365Helpers.ts`
- Test: `apps/api/src/services/m365Helpers.test.ts`

These helpers are used by every tool handler: load the session, load+authorize the connection, resolve a UPN to an object id, and format a `DelegantInvokeResult` into the LLM-facing string.

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/services/m365Helpers.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { authorizeConnection, formatResultForLlm, errorString } from './m365Helpers';

describe('authorizeConnection', () => {
  it('rejects a connection from another org', () => {
    const conn = { id: 'c1', orgId: 'org-A' } as any;
    const out = authorizeConnection(conn, 'org-B');
    expect(out.ok).toBe(false);
  });
  it('accepts a connection in the same org', () => {
    const conn = { id: 'c1', orgId: 'org-A' } as any;
    const out = authorizeConnection(conn, 'org-A');
    expect(out.ok).toBe(true);
  });
  it('rejects a null connection', () => {
    expect(authorizeConnection(null, 'org-A').ok).toBe(false);
  });
});

describe('formatResultForLlm', () => {
  it('renders ok via the success template', () => {
    const s = formatResultForLlm(
      { kind: 'ok', data: { temporaryPassword: 'Temp123!' } },
      { successTemplate: (d: any) => `pw=${d.temporaryPassword}`, errorTemplate: (e) => `err=${e.message}` },
    );
    expect(s).toBe('pw=Temp123!');
  });
  it('renders error via the error template', () => {
    const s = formatResultForLlm(
      { kind: 'error', code: 'delegant_unreachable', message: 'down' },
      { successTemplate: () => 'ok', errorTemplate: (e) => `err=${e.message}` },
    );
    expect(s).toBe('err=down');
  });
});

describe('errorString', () => {
  it('produces a JSON error string the LLM can read', () => {
    const s = errorString('no_customer_selected', 'pick a customer');
    expect(JSON.parse(s)).toEqual({ error: 'no_customer_selected', message: 'pick a customer' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @breeze/api test m365Helpers`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement helpers**

Create `apps/api/src/services/m365Helpers.ts`:
```ts
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';
import type { DelegantInvokeResult } from './delegantClient';

export function errorString(code: string, message: string): string {
  return JSON.stringify({ error: code, message });
}

export function authorizeConnection(
  conn: DelegantM365ConnectionRow | null,
  authOrgId: string,
): { ok: true; conn: DelegantM365ConnectionRow } | { ok: false } {
  if (!conn) return { ok: false };
  if (conn.orgId !== authOrgId) return { ok: false };
  if (conn.status !== 'active') return { ok: false };
  return { ok: true, conn };
}

export function formatResultForLlm(
  result: DelegantInvokeResult,
  templates: {
    successTemplate: (data: any) => string;
    errorTemplate: (err: { code: string; message: string }) => string;
  },
): string {
  if (result.kind === 'ok') return templates.successTemplate(result.data);
  return templates.errorTemplate({ code: result.code, message: result.message });
}
```
> `loadCurrentSession`, `loadConnection`, `resolveUserId`, and the principal loaders (`loadActingUserPrincipal`, `loadAgentPrincipal`) require DB access and the session/principal mapping. They are thin DB queries; implement them here too, but they're exercised by the handler tests in Task 7 (with mocked DB) rather than unit-tested in isolation — keep them as small, single-query functions. Add them in Step 4.

- [ ] **Step 4: Add the DB-backed helpers**

Append to `apps/api/src/services/m365Helpers.ts` (adapt the exact `db`/`eq` imports and the principal-id source to whatever Task 0.3 revealed — the agent/technician Delegant principal ids must come from somewhere: either columns on the Breeze org / user, or a small mapping table; for v1 manual seeding they can be read from config or a `delegant_principals` lookup. Document the chosen source in the runbook, Task 12):
```ts
import { db } from '../db';
import { eq, and } from 'drizzle-orm';
import { aiSessions } from '../db/schema/ai';
import { delegantM365Connections } from '../db/schema/delegant';

export async function loadSession(sessionId: string) {
  const [row] = await db.select().from(aiSessions).where(eq(aiSessions.id, sessionId)).limit(1);
  return row ?? null;
}

export async function loadConnection(connectionId: string) {
  const [row] = await db.select().from(delegantM365Connections)
    .where(eq(delegantM365Connections.id, connectionId)).limit(1);
  return row ?? null;
}
```
> Principal-id resolution (`loadActingUserPrincipal`, `loadAgentPrincipal`): for v1, read the agent principal id and a per-technician principal id from the seeded mapping. The simplest v1 source is two columns added during manual seeding OR a config-driven default for the single test customer. Pick the simplest that lets the live test pass; record the decision in the runbook. This is intentionally minimal — bulk principal provisioning is an out-of-scope Delegant gap (#2).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @breeze/api test m365Helpers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/m365Helpers.ts apps/api/src/services/m365Helpers.test.ts
git commit -m "feat(m365): shared helpers (authorize connection, format result, loaders)"
```

---

## Task 7: The five M365 tools + registration

**Files:**
- Create: `apps/api/src/services/aiToolsM365.ts`
- Create: `apps/api/src/services/aiToolsM365.test.ts`
- Modify: `apps/api/src/services/aiTools.ts`

> Do the three read tools and two mutation tools in the same task because they share a single handler template; the test file covers all five. Write the test for `m365_lookup_user` first (full TDD), then the other four reuse the proven template.

- [ ] **Step 1: Write failing tests covering the cross-cutting behaviors**

Create `apps/api/src/services/aiToolsM365.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the delegant client + helpers' DB loaders.
vi.mock('./delegantClient', () => ({ invokeDelegantTool: vi.fn() }));
vi.mock('./m365Helpers', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, loadSession: vi.fn(), loadConnection: vi.fn() };
});

import { invokeDelegantTool } from './delegantClient';
import { loadSession, loadConnection } from './m365Helpers';
import { m365Tools } from './aiToolsM365';

const auth = { orgId: 'org-A', user: { id: 'tech-1', email: 't@x.com' } } as any;

function getHandler(name: string) {
  const t = m365Tools.find((x) => x.definition.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.handler;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('m365_lookup_user', () => {
  it('returns an error and never calls Delegant when no customer is selected', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: null });
    const out = await getHandler('m365_lookup_user')({ userIdentifier: 'jane@x.com' }, auth);
    expect(JSON.parse(out).error).toBe('no_customer_selected');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('returns connection_not_found and never calls Delegant on a cross-org connection', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue({ id: 'c1', orgId: 'org-OTHER', status: 'active' });
    const out = await getHandler('m365_lookup_user')({ userIdentifier: 'jane@x.com' }, auth);
    expect(JSON.parse(out).error).toBe('connection_not_found');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('calls Delegant get_user on the happy path', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue({
      id: 'c1', orgId: 'org-A', status: 'active', delegantOrgId: 'dorg-1',
      delegantConnectionId: 'dconn-1', customerLabel: 'pinnacle', customerDisplayName: 'Pinnacle',
    });
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { id: 'u1', displayName: 'Jane', assignedLicenses: [] } });
    const out = await getHandler('m365_lookup_user')({ userIdentifier: 'u1' }, auth);
    expect(invokeDelegantTool).toHaveBeenCalledTimes(1);
    expect((invokeDelegantTool as any).mock.calls[0][0].toolName).toBe('get_user');
    expect(out).toContain('Jane');
  });

  it('returns a graceful message when Delegant is unreachable', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue({ id: 'c1', orgId: 'org-A', status: 'active', delegantOrgId: 'dorg-1', delegantConnectionId: 'dconn-1', customerLabel: 'p', customerDisplayName: 'P' });
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'error', code: 'delegant_unreachable', message: 'down' });
    const out = await getHandler('m365_lookup_user')({ userIdentifier: 'u1' }, auth);
    expect(out.toLowerCase()).toContain('could');  // "could not reach"/"couldn't"
  });
});

describe('m365_reset_password', () => {
  it('requires a reason argument', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue({ id: 'c1', orgId: 'org-A', status: 'active', delegantOrgId: 'dorg-1', delegantConnectionId: 'dconn-1', customerLabel: 'p', customerDisplayName: 'P' });
    const out = await getHandler('m365_reset_password')({ userIdentifier: 'u1' }, auth); // no reason
    expect(JSON.parse(out).error).toBeDefined();
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('calls reset_user_password and surfaces the temp password', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue({ id: 'c1', orgId: 'org-A', status: 'active', delegantOrgId: 'dorg-1', delegantConnectionId: 'dconn-1', customerLabel: 'p', customerDisplayName: 'P' });
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { temporaryPassword: 'Temp123!' } });
    const out = await getHandler('m365_reset_password')({ userIdentifier: 'u1', reason: 'forgot' }, auth);
    expect((invokeDelegantTool as any).mock.calls[0][0].toolName).toBe('reset_user_password');
    expect(out).toContain('Temp123!');
  });
});

describe('tool tiers', () => {
  it('assigns tiers 1/1/1/3/3', () => {
    const byName = Object.fromEntries(m365Tools.map((t) => [t.definition.name, t.tier]));
    expect(byName['m365_lookup_user']).toBe(1);
    expect(byName['m365_recent_signins']).toBe(1);
    expect(byName['m365_list_group_memberships']).toBe(1);
    expect(byName['m365_disable_user']).toBe(3);
    expect(byName['m365_reset_password']).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @breeze/api test aiToolsM365`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the tools**

Create `apps/api/src/services/aiToolsM365.ts`. (Use the real `AiTool` type + `AuthContext` import confirmed in Step 0.1. The `runHandler` template centralizes the session/connection/authorize/invoke/format flow so each tool is a few lines.)
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { AuthContext } from '../middleware/auth';
import { invokeDelegantTool, type DelegantToolName } from './delegantClient';
import {
  loadSession, loadConnection, authorizeConnection, formatResultForLlm, errorString,
} from './m365Helpers';
import {
  DELEGANT_BASE_URL, DELEGANT_SERVICE_TOKEN,
  DELEGANT_PRINCIPAL_SIGNING_KEY, DELEGANT_PRINCIPAL_KID,
} from '../config/env';

export interface AiTool {            // re-declare locally only if not exported from aiTools.ts
  definition: Anthropic.Tool;
  tier: 1 | 2 | 3 | 4;
  handler: (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;
}

const env = {
  DELEGANT_BASE_URL, DELEGANT_SERVICE_TOKEN,
  DELEGANT_PRINCIPAL_SIGNING_KEY, DELEGANT_PRINCIPAL_KID,
};

// v1: single-customer manual seeding. Replace with a real principal mapping later.
async function resolvePrincipals(auth: AuthContext, _conn: { delegantOrgId: string }) {
  return {
    actingUser: { breezeUserId: auth.user.id, delegantPrincipalId: process.env.DELEGANT_TEST_ACTING_USER_ID ?? '' },
    agent: { delegantPrincipalId: process.env.DELEGANT_TEST_AGENT_ID ?? '' },
  };
}

interface RunOpts {
  toolName: DelegantToolName;
  buildParams: (input: Record<string, unknown>, ctx: { userId?: string }) => Record<string, unknown>;
  needsUser: boolean;
  success: (data: any, input: Record<string, unknown>) => string;
}

async function runHandler(input: Record<string, unknown>, auth: AuthContext, opts: RunOpts): Promise<string> {
  const session = await loadSession((input.__sessionId as string) ?? (auth as any).sessionId);
  if (!session) return errorString('session_not_found', 'AI session not found.');
  if (!session.delegantM365ConnectionId) {
    return errorString('no_customer_selected',
      'No M365 customer is selected for this session. Start a new session and pick a customer.');
  }
  const conn = await loadConnection(session.delegantM365ConnectionId);
  const authz = authorizeConnection(conn, auth.orgId!);
  if (!authz.ok) return errorString('connection_not_found', 'M365 connection not found for this session.');

  let userId: string | undefined;
  if (opts.needsUser) {
    const raw = String(input.userIdentifier ?? '');
    if (!raw) return errorString('missing_user', 'A userIdentifier (email/UPN or object id) is required.');
    userId = raw.includes('@') ? await resolveUpn(raw, authz.conn, auth, session.id) : raw;
    if (!userId) return errorString('user_not_found', `Could not resolve user ${raw}.`);
  }

  const principals = await resolvePrincipals(auth, authz.conn);
  const result = await invokeDelegantTool({
    connection: authz.conn, toolName: opts.toolName,
    parameters: opts.buildParams(input, { userId }),
    actingUser: principals.actingUser, agent: principals.agent, sessionId: session.id,
  }, { env });

  return formatResultForLlm(result, {
    successTemplate: (d) => opts.success(d, input),
    errorTemplate: (e) => `Could not complete the M365 operation: ${e.message}`,
  });
}

async function resolveUpn(upn: string, conn: any, auth: AuthContext, sessionId: string): Promise<string | undefined> {
  const principals = await resolvePrincipals(auth, conn);
  const res = await invokeDelegantTool({
    connection: conn, toolName: 'get_user', parameters: { userId: upn },
    actingUser: principals.actingUser, agent: principals.agent, sessionId,
  }, { env });
  if (res.kind === 'ok') return (res.data as any)?.id ?? upn;
  return undefined;
}

function strProp(desc: string) { return { type: 'string' as const, description: desc }; }

export const m365Tools: AiTool[] = [
  {
    tier: 1,
    definition: {
      name: 'm365_lookup_user',
      description: 'Look up a Microsoft 365 user (profile, account status, assigned licenses) on the customer tenant selected for this session.',
      input_schema: { type: 'object', properties: { userIdentifier: strProp("User's email/UPN or Entra object ID.") }, required: ['userIdentifier'] },
    },
    handler: (input, auth) => runHandler(input, auth, {
      toolName: 'get_user', needsUser: true,
      buildParams: (_i, c) => ({ userId: c.userId }),
      success: (d) => `User: ${JSON.stringify(d)}`,
    }),
  },
  {
    tier: 1,
    definition: {
      name: 'm365_recent_signins',
      description: 'Read recent sign-in activity for a Microsoft 365 user on the customer tenant selected for this session. Useful for "can\'t log in" and lockout triage.',
      input_schema: { type: 'object', properties: { userIdentifier: strProp("User's email/UPN or Entra object ID.") }, required: ['userIdentifier'] },
    },
    handler: (input, auth) => runHandler(input, auth, {
      toolName: 'get_user_signin_activity', needsUser: true,
      buildParams: (_i, c) => ({ userId: c.userId }),
      success: (d) => `Recent sign-ins: ${JSON.stringify(d)}`,
    }),
  },
  {
    tier: 1,
    definition: {
      name: 'm365_list_group_memberships',
      description: 'List the groups in the customer tenant selected for this session (use to see directory groups; combine with a group lookup to find a user\'s memberships).',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handler: (input, auth) => runHandler(input, auth, {
      toolName: 'list_groups', needsUser: false,
      buildParams: () => ({}),
      success: (d) => `Groups: ${JSON.stringify(d)}`,
    }),
  },
  {
    tier: 3,
    definition: {
      name: 'm365_disable_user',
      description: 'Disable (block sign-in for) a Microsoft 365 user on the customer tenant selected for this session. Requires approval.',
      input_schema: { type: 'object', properties: { userIdentifier: strProp("User's email/UPN or Entra object ID."), reason: strProp('Brief reason; appears in the audit trail.') }, required: ['userIdentifier', 'reason'] },
    },
    handler: (input, auth) => {
      if (!input.reason) return Promise.resolve(errorString('missing_reason', 'A reason is required for this action.'));
      return runHandler(input, auth, {
        toolName: 'disable_user', needsUser: true,
        buildParams: (_i, c) => ({ userId: c.userId }),
        success: (_d, i) => `Disabled sign-in for ${String(i.userIdentifier)}. Reason recorded: ${String(i.reason)}.`,
      });
    },
  },
  {
    tier: 3,
    definition: {
      name: 'm365_reset_password',
      description: 'Reset the password for a Microsoft 365 user on the customer tenant selected for this session. Returns a temporary password the user must change at next sign-in. Requires approval.',
      input_schema: { type: 'object', properties: { userIdentifier: strProp("User's email/UPN or Entra object ID."), reason: strProp('Brief reason; appears in the audit trail.') }, required: ['userIdentifier', 'reason'] },
    },
    handler: (input, auth) => {
      if (!input.reason) return Promise.resolve(errorString('missing_reason', 'A reason is required for this action.'));
      return runHandler(input, auth, {
        toolName: 'reset_user_password', needsUser: true,
        buildParams: (_i, c) => ({ userId: c.userId }),
        success: (d, i) => `Password reset for ${String(i.userIdentifier)}. Temporary password: ${(d as any)?.temporaryPassword ?? '(see Entra)'}. The user must change it at next sign-in. Reason recorded: ${String(i.reason)}.`,
      });
    },
  },
];

export function registerM365Tools(aiTools: Map<string, AiTool>): void {
  for (const t of m365Tools) aiTools.set(t.definition.name, t);
}
```
> **Session-id access:** the template reads the current session id. Step 0.3 reveals the real path (a handler may receive session context via `auth`, a closure, or a `__sessionId` injected by the SDK harness). Replace the `(input.__sessionId ...)` line with the real mechanism. If handlers genuinely cannot see the session id, add it to the `AuthContext` the SDK builds per session — a one-line change in `aiAgentSdk.ts` where handlers are constructed. Do NOT ship the `__sessionId` placeholder.

- [ ] **Step 4: Register the tools**

In `apps/api/src/services/aiTools.ts`, next to the other `registerXxxTools(aiTools)` calls, add:
```ts
import { registerM365Tools } from './aiToolsM365';
// ... with the other registrations:
registerM365Tools(aiTools);
```
> If `aiTools.ts` exports the `AiTool` interface, import it in `aiToolsM365.ts` instead of re-declaring; remove the local re-declaration to avoid type drift.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter @breeze/api test aiToolsM365`
Expected: PASS (all cross-org / no-customer / happy / unreachable / reason-required / tier cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiToolsM365.ts apps/api/src/services/aiToolsM365.test.ts apps/api/src/services/aiTools.ts
git commit -m "feat(m365): five helpdesk tools + registration"
```

---

## Task 8: Guardrails — tiers, RBAC, and approval-card enrichment

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts`
- Modify: `apps/api/src/services/aiAgentSdk.ts`
- Test: `apps/api/src/services/aiGuardrails.m365.test.ts` (create)

- [ ] **Step 1: Write failing guardrails tests**

Create `apps/api/src/services/aiGuardrails.m365.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { checkToolPermission } from './aiGuardrails'; // adapt to the real exported fn name from Step 0.2

describe('m365 RBAC', () => {
  it('blocks reset_password for a read-only user', async () => {
    const auth = { user: { id: 'u' }, orgId: 'o', has: (_r: string, _a: string) => false } as any;
    const err = await checkToolPermission('m365_reset_password', { userIdentifier: 'x', reason: 'y' }, auth);
    expect(err).toBeTruthy();
  });
  it('allows lookup_user for an m365.read user', async () => {
    const auth = { user: { id: 'u' }, orgId: 'o', has: (r: string, a: string) => r === 'm365' && a === 'read' } as any;
    const err = await checkToolPermission('m365_lookup_user', { userIdentifier: 'x' }, auth);
    expect(err).toBeFalsy();
  });
});
```
> The exact RBAC-check function name + the `auth` permission-test signature come from Step 0.2. Adapt the `auth` mock to whatever `checkToolPermission` actually calls (it may be `auth.canAccessOrg`-style or a `hasPermission(resource, action)` call). The assertion that matters: `m365.execute` gates the two mutations; `m365.read` gates the three reads.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @breeze/api test aiGuardrails.m365`
Expected: FAIL — the five tools aren't in `TOOL_PERMISSIONS`.

- [ ] **Step 3: Add the tools to the guardrails maps**

In `apps/api/src/services/aiGuardrails.ts`:
- Add to `TOOL_PERMISSIONS`:
```ts
  m365_lookup_user:            { resource: 'm365', action: 'read' },
  m365_recent_signins:         { resource: 'm365', action: 'read' },
  m365_list_group_memberships: { resource: 'm365', action: 'read' },
  m365_disable_user:           { resource: 'm365', action: 'execute' },
  m365_reset_password:         { resource: 'm365', action: 'execute' },
```
- If a separate `TOOL_TIERS` map exists (Step 0.2), add the matching tiers (1/1/1/3/3) there too, so the central tier source agrees with `AiTool.tier`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @breeze/api test aiGuardrails.m365`
Expected: PASS.

- [ ] **Step 5: Write a failing test for approval-card enrichment**

The per-step approval row's `riskSummary` must, for M365 tools, contain the customer display name + target user + reason. Create `apps/api/src/services/aiAgentSdk.m365risk.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildM365RiskSummary } from './aiAgentSdk';

describe('buildM365RiskSummary', () => {
  it('includes customer, user, and reason for reset_password', () => {
    const s = buildM365RiskSummary('m365_reset_password',
      { userIdentifier: 'jane@pinnacle.dental', reason: 'forgot password' },
      { customerDisplayName: 'Pinnacle Dental' } as any);
    expect(s).toContain('Pinnacle Dental');
    expect(s).toContain('jane@pinnacle.dental');
    expect(s).toContain('forgot password');
  });
  it('returns null for a non-m365 tool', () => {
    expect(buildM365RiskSummary('execute_command', {}, null)).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify fail**

Run: `pnpm --filter @breeze/api test aiAgentSdk.m365risk`
Expected: FAIL — `buildM365RiskSummary` not exported.

- [ ] **Step 7: Implement `buildM365RiskSummary` and wire it into the approval-row creation**

In `apps/api/src/services/aiAgentSdk.ts`, add:
```ts
import type { DelegantM365ConnectionRow } from '../db/schema/delegant';

const M365_VERB: Record<string, string> = {
  m365_reset_password: 'Reset M365 password for',
  m365_disable_user: 'Disable M365 sign-in for',
};

export function buildM365RiskSummary(
  toolName: string,
  input: Record<string, unknown>,
  conn: Pick<DelegantM365ConnectionRow, 'customerDisplayName'> | null,
): string | null {
  const verb = M365_VERB[toolName];
  if (!verb || !conn) return null;
  const user = String(input.userIdentifier ?? 'a user');
  const reason = input.reason ? ` Reason: ${String(input.reason)}.` : '';
  return `${verb} ${user} on ${conn.customerDisplayName}.${reason}`;
}
```
Then, at the point where the `aiToolExecutions` pending row is created (located in Step 0.3), compute the M365 summary and prefer it when present:
```ts
const m365Summary = buildM365RiskSummary(toolName, input, sessionConnection ?? null);
const riskSummary = m365Summary ?? existingRiskSummary;
```
> `sessionConnection` is the connection row for the session; load it once when the session starts (it's already needed for handlers). If the approval-row creation site doesn't have the connection in scope, load it there via `loadConnection(session.delegantM365ConnectionId)` guarded by a null check.

- [ ] **Step 8: Run to verify pass**

Run: `pnpm --filter @breeze/api test aiAgentSdk.m365risk`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.m365.test.ts apps/api/src/services/aiAgentSdk.ts apps/api/src/services/aiAgentSdk.m365risk.test.ts
git commit -m "feat(m365): RBAC tiers + approval-card risk summary enrichment"
```

---

## Task 9: Web — customer switcher + session badge

**Files:**
- Modify: the new-session creation flow + chat header (discover exact paths below)
- Modify: the session-create API call to include `delegantM365ConnectionId`
- Modify: `apps/api/src/routes/ai.ts` (accept + persist the field on session create)
- Test: `apps/api/src/routes/ai.m365session.test.ts` (create)

- [ ] **Step 1: Discover the web files**

Run:
```bash
cd ~/Breeze && grep -rn "aiStore\|createSession\|new session\|startSession" apps/web/src | grep -i session | head -30
grep -rn "POST.*ai/sessions\|/api/ai/sessions" apps/web/src | head
```
Record the component that starts a session and the store action that POSTs it. These are the files modified in Steps 4–5.

- [ ] **Step 2: Write the failing API test (session create accepts the connection id)**

Create `apps/api/src/routes/ai.m365session.test.ts` following the mock pattern in the existing `apps/api/src/routes/ai_sessions_actions.test.ts` (copy its `vi.mock('../db', ...)`, `vi.mock('../middleware/auth', ...)` setup). Assert that POSTing `{ delegantM365ConnectionId: 'c1' }` to the session-create route results in an insert whose values include `delegantM365ConnectionId: 'c1'`, and that the connection is validated to belong to `auth.orgId` (reject cross-org with 403/404). Mirror the exact route + handler names from `ai.ts`.

- [ ] **Step 3: Run to verify fail**

Run: `pnpm --filter @breeze/api test ai.m365session`
Expected: FAIL — route ignores `delegantM365ConnectionId`.

- [ ] **Step 4: Persist the field on session create**

In `apps/api/src/routes/ai.ts`, in the session-create handler: read `delegantM365ConnectionId` from the body; if present, load the connection and verify `connection.orgId === auth.orgId` (return 403 otherwise); include it in the `aiSessions` insert values.

- [ ] **Step 5: Add the web customer switcher**

In the session-start component (Step 1): fetch active connections (add a `GET /api/ai/m365-connections` route returning `delegant_m365_connections` where `orgId = auth.orgId AND status='active'`, projecting only `id, customerLabel, customerDisplayName` — never the Delegant pointer fields to the browser). Render a radio list with a "No M365 customer" default; pass the chosen id to the create call. After creation, render a header badge showing `customerDisplayName` when the session has a connection.

- [ ] **Step 6: Run API test to verify pass; manually verify the web UI**

Run: `pnpm --filter @breeze/api test ai.m365session` — Expected: PASS.
Then run the web app locally and confirm: the switcher lists the seeded test customer, selecting it shows the badge, "No M365 customer" produces the unchanged experience. (UI correctness is manual — note it explicitly in the PR.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/ai.ts apps/api/src/routes/ai.m365session.test.ts apps/web/src/...
git commit -m "feat(m365): customer switcher, session binding, header badge"
```

---

## Task 10: Mobile — "Customer tenant" line on the approval card

**Files:**
- Modify: the mobile approval card component (discover below)
- Modify: the approval payload builder to include a `customerTenant` field (api side)

- [ ] **Step 1: Discover the mobile + payload files**

Run:
```bash
cd ~/Breeze && ls apps/mobile/src/screens/approvals && grep -rn "RiskBand\|riskSummary\|ApprovalRequest" apps/mobile/src | head -20
grep -rn "riskSummary\|actionLabel\|ApprovalRequest" apps/api/src | grep -i approval | head
```
Record the approval card component and where the API builds the approval payload.

- [ ] **Step 2: Add `customerTenant` to the approval payload (api)**

Where the API serializes an approval request (Step 1), include `customerTenant: connection?.customerDisplayName ?? null` for M365 tool executions. This is additive; existing non-M365 approvals get `null`. Add/extend a unit test in the existing approval-payload test to assert the field is populated for an M365 execution and `null` otherwise.

- [ ] **Step 3: Render the line (mobile)**

In the approval card component, above `RiskBand`, render a "Customer tenant: {customerTenant}" line when `customerTenant` is non-null. Keep it visually prominent (it's the one-glance blast-radius signal).

- [ ] **Step 4: Verify**

Run the mobile approval-related unit tests if any exist (`grep -rn "approval" apps/mobile/**/*.test.* `); otherwise verify the api payload test passes: `pnpm --filter @breeze/api test approval`. Manual device/simulator check of the rendered line — note in PR.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/... apps/mobile/src/screens/approvals/...
git commit -m "feat(m365): show customer tenant on approval card"
```

---

## Task 11: Audit correlation — capture Delegant tool-call id (reactive Delegant gap #1)

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts` (the `onPostToolUse` path)
- Possibly: `~/Delegant/src/api/wire/v1.ts` + broker (Delegant-side, only if the id isn't returned)

- [ ] **Step 1: Check whether Delegant returns a tool-call id**

Run:
```bash
cd ~/Delegant && grep -n "toolCallId\|tool_call_id\|ToolCallResult" src/broker/broker.ts src/api/wire/v1.ts
```
Expected (per spec gap #1): the response shape `{ isError, data?, message?, pending?, approvalRequestId? }` does NOT include a tool-call id. If confirmed absent, do Step 2 (Delegant-side). If present, skip to Step 3.

- [ ] **Step 2 (Delegant-side, only if absent): add `toolCallId` to the invoke response**

In `~/Delegant`, in the broker result + the `/v1/tools/invoke` handler, include the persisted tool-call row id as `toolCallId` in the success body. Add a Delegant-side test asserting the field is present on a successful invoke. Commit in the Delegant repo:
```bash
cd ~/Delegant && git add src/broker/broker.ts src/api/wire/v1.ts test/... && git commit -m "feat(wire): return toolCallId on /v1/tools/invoke for consumer correlation"
```
Then extend the Breeze client (`delegantClient.ts`) `ok` result to carry it: `{ kind: 'ok'; data: unknown; toolCallId?: string }`, populated from `body.toolCallId`. Update the Task 5 mapping test accordingly.

- [ ] **Step 3: Persist `delegant_tool_call_id` on the execution row (Breeze)**

In the `onPostToolUse` path (Step 0.3), when an M365 tool returns `ok` with a `toolCallId`, write it to `ai_tool_executions.delegant_tool_call_id` for that execution. Add a unit test asserting the column is set after a successful M365 invoke.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @breeze/api test delegantClient aiToolsM365`
Expected: PASS.

- [ ] **Step 5: Commit (Breeze)**

```bash
git add apps/api/src/services/delegantClient.ts apps/api/src/services/aiAgentSdk.ts apps/api/src/services/*.test.ts
git commit -m "feat(m365): correlate executions to Delegant tool-call id"
```

---

## Task 12: Operator runbook + manual seeding

**Files:**
- Create: `docs/runbooks/m365-helpdesk-agent.md`

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/m365-helpdesk-agent.md` covering:
- **Env vars** (`DELEGANT_BASE_URL`, `DELEGANT_SERVICE_TOKEN`, `DELEGANT_PRINCIPAL_SIGNING_KEY`, `DELEGANT_PRINCIPAL_KID`, and the v1 `DELEGANT_TEST_AGENT_ID` / `DELEGANT_TEST_ACTING_USER_ID` used by `resolvePrincipals`). Where each is generated: the signing key pair is created once; the public JWK is registered in Delegant's `jwtKeySet` under the matching `kid`; Breeze holds the PKCS8 private key.
- **Delegant-side prerequisites** (must pre-exist via Delegant DB/CLI): a `breeze_ai_agent` principal (its id → `DELEGANT_TEST_AGENT_ID`), a `breeze_user` principal per technician (id → `DELEGANT_TEST_ACTING_USER_ID`), and a policy permitting `breeze_ai_agent` to invoke these tools (must be `allow`, not `require_approval`, or Breeze will get `unexpected_pending`).
- **Seed the test customer connection** (Breeze SQL):
```sql
INSERT INTO delegant_m365_connections
  (org_id, customer_label, customer_display_name, delegant_org_id, delegant_connection_id, m365_tenant_id, status)
VALUES
  ('<breeze-org-uuid>', 'sandbox', 'Sandbox Tenant', '<delegant-org-id>', '<delegant-connection-id>', '<m365-tenant-id>', 'active');
```
- **`unexpected_pending` troubleshooting:** check Delegant's policy table for this org; ensure the five tools resolve to `allow` for `breeze_ai_agent`.
- **Forensic flow:** Breeze audit log → `ai_tool_executions` row → `delegant_tool_call_id` → Delegant `GET /v1/audit/tool-calls/{id}`.

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/m365-helpdesk-agent.md
git commit -m "docs(m365): operator runbook + manual seeding"
```

---

## Task 13: Opt-in live test suite

**Files:**
- Create: `apps/api/test-live/m365.live.test.ts`
- Possibly modify: a vitest config to include `test-live` only when a flag is set (mirror Delegant's `test:live` pattern; check if Breeze already has a live/integration config from `vitest.integration.config.ts`).

- [ ] **Step 1: Write the live suite (skips without creds)**

Create `apps/api/test-live/m365.live.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

const LIVE = process.env.DELEGANT_LIVE_TEST === '1'
  && process.env.DELEGANT_BASE_URL && process.env.DELEGANT_SERVICE_TOKEN
  && process.env.DELEGANT_PRINCIPAL_SIGNING_KEY;

describe.skipIf(!LIVE)('m365 live (sandbox tenant)', () => {
  it('lookup_user returns a real profile', async () => {
    // Build args from env (seeded connection + sandbox user), call invokeDelegantTool directly.
    // Assert res.kind === 'ok' and data has an id/displayName.
    expect(LIVE).toBeTruthy();
  });

  it('audit round-trip: a live invoke appears in Delegant audit with agent+acting-user attribution', async () => {
    // After an invoke, GET {DELEGANT_BASE_URL}/v1/audit/events with the service token + a
    // breeze_service principal JWT; assert an event exists for this org with the agent id and
    // acting-user id. (This proves the integration's whole point.)
    expect(LIVE).toBeTruthy();
  });

  // reset_password against a DISPOSABLE sandbox user only — guard behind an extra
  // DELEGANT_LIVE_ALLOW_MUTATIONS=1 flag so a stray run can't reset a real account.
});
```
> Fill the bodies once a sandbox tenant + seeded connection exist (prerequisite, Todd). The structure (skip-without-creds, mutation double-guard, audit round-trip) is the deliverable here.

- [ ] **Step 2: Verify it skips cleanly without creds**

Run: `pnpm --filter @breeze/api test m365.live`
Expected: tests SKIPPED (no failure) when `DELEGANT_LIVE_TEST` is unset.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test-live/m365.live.test.ts apps/api/vitest*.ts
git commit -m "test(m365): opt-in live suite skeleton (sandbox-only, skips without creds)"
```

---

## Task 14: Full-suite green + manual end-to-end (Todd)

- [ ] **Step 1: Run the full api test suite**

Run: `pnpm --filter @breeze/api test:run`
Expected: green (or no NEW failures beyond pre-existing known-flaky ones; compare against a clean baseline).

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @breeze/api lint && pnpm --filter @breeze/api build`
Expected: clean.

- [ ] **Step 3: Manual end-to-end against the sandbox (Todd — requires real tenant + mobile device)**

Following the runbook: seed → open AI chat → pick the sandbox customer (badge appears) → "look up <sandbox user>" (no approval, profile returned) → "reset their password, they're locked out" (approval card shows customer + user + reason; approve on mobile; temp password returned) → confirm in the Entra portal → confirm the audit entry via Delegant's audit endpoint.

- [ ] **Step 4: Final commit / PR**

Open a PR summarizing the five tools, the boundary, the two migrations, and the manual-verification result. Note the one Delegant-side change (if Task 11 Step 2 was needed) as a linked Delegant PR.

---

## Self-Review notes (for the implementer)

- **Cross-org guard** (Task 7 Steps 1, 3) and **no-customer guard** are first-class required tests — they prevent horizontal escalation and accidental no-tenant calls. Do not skip.
- **Never ship the `__sessionId` placeholder** in Task 7 — wire the real session-id source from Step 0.3.
- **Never log `parameters`** (Task 5) — UPNs belong only in Delegant's audit.
- **`unexpected_pending` is fail-loud, not a wait** (Task 5) — Breeze owns approvals.
- **Two repos:** Tasks 1–10, 12–14 are Breeze; Task 11 Step 2 may touch Delegant. Commit in the correct repo.
- **Prerequisite for Tasks 13–14:** a disposable M365 sandbox tenant + seeded Delegant principals. Steps 1–12 don't need it.
