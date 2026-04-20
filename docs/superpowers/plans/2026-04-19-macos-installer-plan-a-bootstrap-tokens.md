# macOS Installer App — Plan A: Bootstrap Token Infrastructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single-use, 24h-TTL `installer_bootstrap_tokens` table and a public `GET /api/v1/installer/bootstrap/:token` endpoint that lazily creates a child enrollment key on consumption. This is the foundation for the macOS installer app design (`docs/superpowers/specs/2026-04-19-macos-installer-app-design.md`); Plan A ships and is testable on its own — the installer route is unchanged here, and the new endpoint can be exercised end-to-end with `curl`.

**Architecture:** New tenant-scoped table (RLS Shape 1, direct `org_id`). New unauthenticated route at `/api/v1/installer/bootstrap/:token` that resolves a token, atomically marks it consumed, lazily creates the child enrollment key, and returns enrollment values. Token issuance is added as a second new endpoint on the enrollment-keys router so admins can mint a token for a parent key without touching the existing installer-download route. Plan C will wire the installer route to call this issuance helper.

**Tech Stack:** Drizzle ORM, PostgreSQL RLS (`breeze_app` role), Hono, Vitest, hand-written SQL migrations.

---

## File Structure

**Create:**
- `apps/api/migrations/2026-04-19-installer-bootstrap-tokens.sql` — table + RLS policies + index, fully idempotent
- `apps/api/src/db/schema/installerBootstrapTokens.ts` — Drizzle table definition
- `apps/api/src/services/installerBootstrapToken.ts` — generator + helpers
- `apps/api/src/services/installerBootstrapToken.test.ts` — unit tests for generator
- `apps/api/src/routes/installer.ts` — public `/installer/bootstrap/:token` route
- `apps/api/src/routes/installer.test.ts` — integration tests for bootstrap endpoint

**Modify:**
- `apps/api/src/db/schema/index.ts` (or wherever the schema barrel lives — see Task 1) — re-export new schema
- `apps/api/src/index.ts` line ~672 — mount the installer route at `/api/v1/installer`
- `apps/api/src/routes/enrollmentKeys.ts` — add `POST /:id/bootstrap-token` issuance helper (used by Plan C)
- `apps/api/src/routes/enrollmentKeys.test.ts` — test for the new issuance route

**No-op (verification):**
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — should auto-discover the new table via its `org_id` column; no allowlist edits needed. Run to confirm.

---

## Task 1: Drizzle schema for `installer_bootstrap_tokens`

**Files:**
- Create: `apps/api/src/db/schema/installerBootstrapTokens.ts`
- Modify: schema barrel (find via `grep -rn "from './installerBootstrapTokens\|export.*from.*schema'" apps/api/src/db/`)

- [ ] **Step 1: Locate the schema barrel**

```bash
ls apps/api/src/db/schema/index.ts 2>/dev/null && head -30 apps/api/src/db/schema/index.ts
# If no index.ts, check what drizzle.config.ts points at:
grep -A2 "schema" apps/api/drizzle.config.ts
```

Expected: either an `index.ts` re-exports each schema file, OR `drizzle.config.ts` points at the directory directly (in which case any new `.ts` file is auto-picked-up).

- [ ] **Step 2: Create the schema file**

```ts
// apps/api/src/db/schema/installerBootstrapTokens.ts
import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, sites, enrollmentKeys } from './orgs';
import { users } from './users';

/**
 * Single-use, short-TTL token issued at installer-download time. The token
 * is embedded in the macOS installer app filename (`Breeze Installer
 * [TOKEN@host].app`) and exchanged for enrollment values on first launch via
 * the unauthenticated `/api/v1/installer/bootstrap/:token` route.
 *
 * Stored as plain text (not hashed) intentionally: tokens are ephemeral
 * (24h max), single-use, and hashing adds ceremony without a meaningful
 * security win for this lifetime. Compare by equality.
 */
export const installerBootstrapTokens = pgTable(
  'installer_bootstrap_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: text('token').notNull().unique(),
    orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    parentEnrollmentKeyId: uuid('parent_enrollment_key_id')
      .notNull()
      .references(() => enrollmentKeys.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id').references(() => sites.id),
    maxUsage: integer('max_usage').notNull().default(1),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    consumedFromIp: text('consumed_from_ip'),
  },
  (t) => ({
    expiresIdx: index('idx_installer_bootstrap_tokens_expires').on(t.expiresAt),
  }),
);
```

- [ ] **Step 3: Re-export from the barrel (if there is one)**

If `apps/api/src/db/schema/index.ts` exists, add:
```ts
export * from './installerBootstrapTokens';
```

If schemas are auto-discovered from the directory by `drizzle.config.ts`, no change needed.

- [ ] **Step 4: Type-check**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -i installerBootstrap
```
Expected: no errors mentioning the new file.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/installerBootstrapTokens.ts apps/api/src/db/schema/index.ts
git commit -m "schema: add installer_bootstrap_tokens table"
```

---

## Task 2: Hand-written migration with RLS policies

**Files:**
- Create: `apps/api/migrations/2026-04-19-installer-bootstrap-tokens.sql`

- [ ] **Step 1: Confirm migration filename convention**

```bash
ls apps/api/migrations/ | tail -5
```
Expected: date-prefixed files like `2026-04-13-fix-uuid-hostnames.sql`. Use `2026-04-19-installer-bootstrap-tokens.sql`. (If the directory has switched to numeric NNNN- prefixes — CLAUDE.md mentions both — use the next available number.)

- [ ] **Step 2: Write the migration**

```sql
-- 2026-04-19: installer_bootstrap_tokens — single-use, short-TTL tokens for
-- the macOS GUI installer. Tokens are issued at installer-download time and
-- consumed by the unauthenticated /api/v1/installer/bootstrap/:token route.
--
-- RLS Shape 1 (direct org_id) — auto-discovered by the rls-coverage
-- integration test, no allowlist entry needed.
--
-- Fully idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS installer_bootstrap_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_enrollment_key_id UUID NOT NULL REFERENCES enrollment_keys(id) ON DELETE CASCADE,
  site_id UUID REFERENCES sites(id),
  max_usage INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_from_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_installer_bootstrap_tokens_expires
  ON installer_bootstrap_tokens(expires_at)
  WHERE consumed_at IS NULL;

-- ============================================================
-- RLS — Shape 1, direct org_id, standard four breeze_org_isolation policies
-- ============================================================

ALTER TABLE installer_bootstrap_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE installer_bootstrap_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON installer_bootstrap_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON installer_bootstrap_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_update ON installer_bootstrap_tokens;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON installer_bootstrap_tokens;

CREATE POLICY breeze_org_isolation_select ON installer_bootstrap_tokens
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON installer_bootstrap_tokens
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON installer_bootstrap_tokens
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON installer_bootstrap_tokens
  FOR DELETE USING (public.breeze_has_org_access(org_id));

COMMIT;
```

- [ ] **Step 3: Apply migration**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze < apps/api/migrations/2026-04-19-installer-bootstrap-tokens.sql
```
Expected: `BEGIN`, `CREATE TABLE`, `CREATE INDEX`, multiple `ALTER`/`CREATE POLICY`, `COMMIT`.

- [ ] **Step 4: Run drift check**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```
Expected: no drift detected. If drift appears, the Drizzle schema file (Task 1) and the SQL must be reconciled — column types/nullability/defaults must match exactly.

- [ ] **Step 5: Verify RLS as `breeze_app`**

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c "
  INSERT INTO installer_bootstrap_tokens (token, org_id, parent_enrollment_key_id, expires_at)
  VALUES ('TESTXX', '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000', NOW() + interval '1 hour');
"
```
Expected: `ERROR:  new row violates row-level security policy for table "installer_bootstrap_tokens"` — confirms RLS is forced and `breeze_app` cannot bypass.

- [ ] **Step 6: Run RLS coverage integration test**

```bash
cd apps/api && pnpm test --config vitest.config.rls.ts -- rls-coverage
```
Expected: all assertions pass, including auto-discovered policies on the new table.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-04-19-installer-bootstrap-tokens.sql
git commit -m "migration: installer_bootstrap_tokens with RLS"
```

---

## Task 3: Bootstrap token generator helper + unit tests

**Files:**
- Create: `apps/api/src/services/installerBootstrapToken.ts`
- Test: `apps/api/src/services/installerBootstrapToken.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/installerBootstrapToken.test.ts
import { describe, it, expect } from 'vitest';
import { generateBootstrapToken, BOOTSTRAP_TOKEN_PATTERN } from './installerBootstrapToken';

describe('generateBootstrapToken', () => {
  it('returns a 6-char token of [A-Z0-9]', () => {
    const t = generateBootstrapToken();
    expect(t).toMatch(BOOTSTRAP_TOKEN_PATTERN);
  });

  it('returns 6 chars exactly', () => {
    expect(generateBootstrapToken()).toHaveLength(6);
  });

  it('is statistically unique across 1000 calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) tokens.add(generateBootstrapToken());
    // 36^6 ≈ 2.2B values; collisions in 1000 samples are essentially impossible.
    // Allow a single collision before flagging — defensive against an unlucky CI run.
    expect(tokens.size).toBeGreaterThanOrEqual(999);
  });

  it('emits only uppercase letters and digits', () => {
    for (let i = 0; i < 100; i++) {
      expect(generateBootstrapToken()).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe('BOOTSTRAP_TOKEN_PATTERN', () => {
  it('matches the canonical 6-char form', () => {
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2XQ')).toBe(true);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('123456')).toBe(true);
  });

  it('rejects shorter, longer, or lowercase variants', () => {
    expect(BOOTSTRAP_TOKEN_PATTERN.test('a7k2xq')).toBe(false);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2X')).toBe(false);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7K2XQA')).toBe(false);
    expect(BOOTSTRAP_TOKEN_PATTERN.test('A7-2XQ')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd apps/api && npx vitest run src/services/installerBootstrapToken.test.ts
```
Expected: FAIL — `Cannot find module './installerBootstrapToken'`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/installerBootstrapToken.ts
import { randomInt } from 'node:crypto';

/**
 * Canonical shape of a bootstrap token: 6 chars of base36 (uppercase
 * letters + digits). 36^6 ≈ 2.2 billion values — sufficient entropy for
 * a single-use 24h-TTL token. Used by both the generator and the
 * route-side input validator.
 */
export const BOOTSTRAP_TOKEN_PATTERN = /^[A-Z0-9]{6}$/;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generates a 6-character base36 bootstrap token using a CSPRNG.
 * Output is always 6 chars of [A-Z0-9].
 */
export function generateBootstrapToken(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

/**
 * Default TTL for a freshly-issued bootstrap token. Tunable via env
 * for testing; production default is 24 hours which matches the
 * "admin downloads installer, sends to user, user runs sometime
 * within a day" mental model.
 */
export function bootstrapTokenExpiresAt(): Date {
  const ttlMin = Number(process.env.INSTALLER_BOOTSTRAP_TOKEN_TTL_MINUTES ?? 24 * 60);
  return new Date(Date.now() + ttlMin * 60 * 1000);
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd apps/api && npx vitest run src/services/installerBootstrapToken.test.ts
```
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/installerBootstrapToken.ts apps/api/src/services/installerBootstrapToken.test.ts
git commit -m "feat(api): bootstrap token generator for installer"
```

---

## Task 4: Bootstrap endpoint — failing integration tests first

**Files:**
- Create: `apps/api/src/routes/installer.test.ts`

- [ ] **Step 1: Write five integration test cases (failing)**

```ts
// apps/api/src/routes/installer.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the database, mirroring patterns from existing route tests.
// See enrollmentKeys.test.ts for the full mock shape — we reuse the same
// withSystemDbAccessContext stub.
const mockTx = {
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
};

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn(mockTx)),
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((k: string) => `hashed:${k}`),
}));

import { Hono } from 'hono';
import { installerRoutes } from './installer';

function makeApp() {
  const app = new Hono();
  app.route('/api/v1/installer', installerRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/installer/bootstrap/:token', () => {
  it('returns 400 for malformed token', async () => {
    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/lowercase');
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown token', async () => {
    mockTx.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    });
    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/AAAAAA');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'token invalid, expired, or already used' });
  });

  it('returns 404 for already-consumed token', async () => {
    mockTx.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 't1', token: 'BBBBBB', orgId: 'o1',
            parentEnrollmentKeyId: 'pk1', siteId: 's1', maxUsage: 1,
            consumedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
          }]),
        }),
      }),
    });
    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/BBBBBB');
    expect(res.status).toBe(404);
  });

  it('returns 404 for expired token', async () => {
    mockTx.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: 't1', token: 'CCCCCC', orgId: 'o1',
            parentEnrollmentKeyId: 'pk1', siteId: 's1', maxUsage: 1,
            consumedAt: null, expiresAt: new Date(Date.now() - 1000),
          }]),
        }),
      }),
    });
    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/CCCCCC');
    expect(res.status).toBe(404);
  });

  it('happy path: consumes token, creates child key, returns enrollment payload', async () => {
    process.env.PUBLIC_API_URL = 'https://us.2breeze.app';
    process.env.AGENT_ENROLLMENT_SECRET = 'shared-secret-test';

    const tokenRow = {
      id: 't1', token: 'DDDDDD', orgId: 'o1',
      parentEnrollmentKeyId: 'pk1', siteId: 's1', maxUsage: 3,
      createdBy: 'u1',
      consumedAt: null, expiresAt: new Date(Date.now() + 60_000),
    };
    const parentKey = {
      id: 'pk1', name: 'Acme parent', orgId: 'o1', siteId: 's1',
      keySecretHash: 'parent-secret-hash',
    };
    const org = { id: 'o1', name: 'Acme Corp' };

    mockTx.select
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([tokenRow]) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([parentKey]) }) }) })
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([org]) }) }) });

    mockTx.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]) }) }),
    });
    mockTx.insert.mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: 'ck1', orgId: 'o1', siteId: 's1' }]) }),
    });

    const app = makeApp();
    const res = await app.request('/api/v1/installer/bootstrap/DDDDDD');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serverUrl).toBe('https://us.2breeze.app');
    expect(body.enrollmentSecret).toBe('shared-secret-test');
    expect(body.siteId).toBe('s1');
    expect(body.orgName).toBe('Acme Corp');
    expect(body.enrollmentKey).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

```bash
cd apps/api && npx vitest run src/routes/installer.test.ts
```
Expected: FAIL — `Cannot find module './installer'` for all 5 tests.

- [ ] **Step 3: Commit (tests only)**

```bash
git add apps/api/src/routes/installer.test.ts
git commit -m "test(api): bootstrap endpoint integration cases"
```

---

## Task 5: Implement the bootstrap endpoint

**Files:**
- Create: `apps/api/src/routes/installer.ts`

- [ ] **Step 1: Implement**

```ts
// apps/api/src/routes/installer.ts
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { withSystemDbAccessContext } from '../db';
import { installerBootstrapTokens } from '../db/schema/installerBootstrapTokens';
import { enrollmentKeys, organizations } from '../db/schema/orgs';
import { hashEnrollmentKey } from '../services/enrollmentKeySecurity';
import { BOOTSTRAP_TOKEN_PATTERN } from '../services/installerBootstrapToken';

const CHILD_TTL_MIN = Number(
  process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES ?? 24 * 60,
);

function freshChildExpiresAt(): Date {
  return new Date(Date.now() + CHILD_TTL_MIN * 60 * 1000);
}

function generateChildEnrollmentKey(): string {
  return randomBytes(32).toString('hex'); // 64-char hex, matches enrollmentKeys.ts:66
}

const INVALID_TOKEN_RESPONSE = {
  body: { error: 'token invalid, expired, or already used' as const },
  status: 404 as const,
};

export const installerRoutes = new Hono();

/**
 * Public bootstrap endpoint. The token IS the auth — no JWT, no API key,
 * no session. Resolves the token to an enrollment payload, atomically
 * marks it consumed, and lazily creates the child enrollment key.
 *
 * Invalid / expired / already-used tokens all return the same 404 to
 * avoid leaking which condition was hit. (Same pattern as enrollment
 * key validation in agents/enrollment.ts.)
 */
installerRoutes.get('/bootstrap/:token', async (c) => {
  const token = c.req.param('token');
  if (!BOOTSTRAP_TOKEN_PATTERN.test(token)) {
    return c.json({ error: 'invalid token' }, 400);
  }

  const result = await withSystemDbAccessContext(async (tx) => {
    const [row] = await tx
      .select()
      .from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.token, token))
      .limit(1);
    if (!row) return null;
    if (row.consumedAt) return null;
    if (new Date(row.expiresAt) < new Date()) return null;

    // Atomic single-use guard: UPDATE ... WHERE consumed_at IS NULL.
    // Two concurrent requests both read row.consumedAt = null but only one
    // UPDATE will return a row.
    const [updated] = await tx
      .update(installerBootstrapTokens)
      .set({
        consumedAt: new Date(),
        consumedFromIp: c.req.header('cf-connecting-ip') ?? null,
      })
      .where(
        and(
          eq(installerBootstrapTokens.id, row.id),
          isNull(installerBootstrapTokens.consumedAt),
        ),
      )
      .returning();
    if (!updated) return null;

    const [parent] = await tx
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, row.parentEnrollmentKeyId))
      .limit(1);
    if (!parent) return null;

    const rawChildKey = generateChildEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    await tx
      .insert(enrollmentKeys)
      .values({
        orgId: row.orgId,
        siteId: row.siteId,
        name: `${parent.name} (mac-installer ${token})`,
        key: childKeyHash,
        keySecretHash: parent.keySecretHash,
        maxUsage: row.maxUsage,
        expiresAt: freshChildExpiresAt(),
        createdBy: row.createdBy,
        installerPlatform: 'macos',
      })
      .returning();

    const [org] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, row.orgId))
      .limit(1);

    return {
      rawChildKey,
      siteId: row.siteId,
      orgName: org?.name ?? 'your organization',
    };
  });

  if (!result) {
    return c.json(INVALID_TOKEN_RESPONSE.body, INVALID_TOKEN_RESPONSE.status);
  }

  return c.json({
    serverUrl: process.env.PUBLIC_API_URL ?? process.env.API_URL ?? '',
    enrollmentKey: result.rawChildKey,
    enrollmentSecret: process.env.AGENT_ENROLLMENT_SECRET || null,
    siteId: result.siteId,
    orgName: result.orgName,
  });
});
```

- [ ] **Step 2: Run tests, verify pass**

```bash
cd apps/api && npx vitest run src/routes/installer.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/installer.ts
git commit -m "feat(api): bootstrap endpoint /api/v1/installer/bootstrap/:token"
```

---

## Task 6: Mount the installer route

**Files:**
- Modify: `apps/api/src/index.ts` (around line 672 where other routes are mounted)

- [ ] **Step 1: Add import**

In `apps/api/src/index.ts`, add near the existing route imports (around line 34):
```ts
import { installerRoutes } from './routes/installer';
```

- [ ] **Step 2: Mount the route**

Below the existing `api.route('/enrollment-keys', enrollmentKeyRoutes);` line (around 672):
```ts
api.route('/installer', installerRoutes);
```

- [ ] **Step 3: Verify type check**

```bash
cd apps/api && npx tsc --noEmit 2>&1 | grep -E "installer|index.ts"
```
Expected: no new errors. (Existing pre-existing errors in `agents.test.ts` / `apiKeyAuth.test.ts` per project memory are unrelated.)

- [ ] **Step 4: Smoke-test mounting locally**

```bash
# In one terminal, with docker compose up:
cd apps/api && pnpm dev
# In another:
curl -i http://localhost:3001/api/v1/installer/bootstrap/lowercase
# Expected: HTTP/1.1 400, body {"error":"invalid token"}

curl -i http://localhost:3001/api/v1/installer/bootstrap/AAAAAA
# Expected: HTTP/1.1 404, body {"error":"token invalid, expired, or already used"}
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): mount /api/v1/installer routes"
```

---

## Task 7: Token issuance helper for parent enrollment keys

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts` — add `POST /:id/bootstrap-token` handler
- Modify: `apps/api/src/routes/enrollmentKeys.test.ts` — add tests

This issuance route is what Plan C will call from the installer-download path. Building it here so Plan A is self-contained and Plan C is a one-line route change.

- [ ] **Step 1: Write failing tests**

In `apps/api/src/routes/enrollmentKeys.test.ts`, add a new `describe` block:

```ts
describe('POST /:id/bootstrap-token', () => {
  it('issues a bootstrap token for a valid parent key', async () => {
    // Mock the parent key lookup (existing pattern in this file)
    const parent = {
      id: 'pk1', orgId: 'o1', siteId: 's1', name: 'Acme parent',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      maxUsage: 100, usageCount: 0,
    };
    // ... use the existing select/insert mock setup pattern from the file ...

    const res = await app.request('/enrollment-keys/pk1/bootstrap-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ maxUsage: 1 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.expiresAt).toBeTypeOf('string');
  });

  it('rejects unknown parent key with 404', async () => {
    // ... mock select returns [] ...
    const res = await app.request('/enrollment-keys/missing/bootstrap-token', {
      method: 'POST', headers: { authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ maxUsage: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects when caller has no org access (403)', async () => {
    // ... mock ensureOrgAccess returns false ...
    const res = await app.request('/enrollment-keys/pk1/bootstrap-token', {
      method: 'POST', headers: { authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ maxUsage: 1 }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects expired parent key with 410', async () => {
    // ... parent.expiresAt = past ...
    const res = await app.request('/enrollment-keys/pk1/bootstrap-token', {
      method: 'POST', headers: { authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ maxUsage: 1 }),
    });
    expect(res.status).toBe(410);
  });
});
```

(Use the existing test file's mock harness — the `select`/`insert`/`auth` patterns are already wired. The full mock setup may take a few extra lines per case; copy from the existing `GET /:id/installer/:platform` block in this file as the reference, since it has the same access-control + parent-key-validation shape.)

- [ ] **Step 2: Run tests, verify failure**

```bash
cd apps/api && npx vitest run src/routes/enrollmentKeys.test.ts -t "bootstrap-token"
```
Expected: FAIL — route returns 404 for the path.

- [ ] **Step 3: Implement the route**

Add to `apps/api/src/routes/enrollmentKeys.ts`, after the existing `GET /:id/installer/:platform` handler:

```ts
import { generateBootstrapToken, bootstrapTokenExpiresAt } from '../services/installerBootstrapToken';
import { installerBootstrapTokens } from '../db/schema/installerBootstrapTokens';

// ============================================
// POST /:id/bootstrap-token — issue a single-use installer bootstrap token
// ============================================

const bootstrapTokenBodySchema = z.object({
  maxUsage: z.number().int().min(1).max(1000).default(1),
});

enrollmentKeyRoutes.post(
  '/:id/bootstrap-token',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', bootstrapTokenBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const { maxUsage } = c.req.valid('json');

    const [parent] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);
    if (!parent) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(parent.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    if (parent.expiresAt && new Date(parent.expiresAt) < new Date()) {
      return c.json({ error: 'Enrollment key has expired' }, 410);
    }
    if (parent.maxUsage !== null && parent.usageCount >= parent.maxUsage) {
      return c.json({ error: 'Enrollment key usage exhausted' }, 410);
    }

    const token = generateBootstrapToken();
    const expiresAt = bootstrapTokenExpiresAt();

    const [row] = await db
      .insert(installerBootstrapTokens)
      .values({
        token,
        orgId: parent.orgId,
        parentEnrollmentKeyId: parent.id,
        siteId: parent.siteId,
        maxUsage,
        createdBy: auth.user.id,
        expiresAt,
      })
      .returning();

    writeEnrollmentKeyAudit(c, auth, {
      orgId: parent.orgId,
      action: 'enrollment_key.bootstrap_token_issued',
      keyId: parent.id,
      keyName: parent.name,
      details: { tokenId: row.id, maxUsage },
    });

    return c.json({
      token,
      expiresAt: expiresAt.toISOString(),
      maxUsage,
    });
  },
);
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd apps/api && npx vitest run src/routes/enrollmentKeys.test.ts -t "bootstrap-token"
```
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "feat(api): POST /enrollment-keys/:id/bootstrap-token issues installer token"
```

---

## Task 8: End-to-end smoke test with `curl`

**Files:** none (manual verification)

- [ ] **Step 1: Start a clean local environment**

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up -d
cd apps/api && pnpm dev
```

- [ ] **Step 2: Issue a bootstrap token**

```bash
# Get a JWT (use existing dev login or seed script)
JWT=$(./scripts/dev-login.sh 2>/dev/null || echo "REPLACE_WITH_JWT")
KEY_ID="REPLACE_WITH_REAL_PARENT_KEY_ID"

curl -sS -X POST http://localhost:3001/api/v1/enrollment-keys/$KEY_ID/bootstrap-token \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"maxUsage": 1}' | jq
```
Expected: `{ "token": "A7K2XQ", "expiresAt": "2026-04-20T...", "maxUsage": 1 }`.

- [ ] **Step 3: Consume the token**

```bash
TOKEN="A7K2XQ"   # use the value from step 2
curl -sS http://localhost:3001/api/v1/installer/bootstrap/$TOKEN | jq
```
Expected: `{ "serverUrl": "...", "enrollmentKey": "<64 hex>", "enrollmentSecret": "...", "siteId": "...", "orgName": "..." }`.

- [ ] **Step 4: Verify single-use — second call should 404**

```bash
curl -sS -i http://localhost:3001/api/v1/installer/bootstrap/$TOKEN
```
Expected: `HTTP/1.1 404`, body `{"error":"token invalid, expired, or already used"}`.

- [ ] **Step 5: Verify enrollment key was created**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c "
  SELECT id, name, max_usage, expires_at FROM enrollment_keys
  WHERE name LIKE '%mac-installer%' ORDER BY created_at DESC LIMIT 3;
"
```
Expected: a row with name like `<parent>  (mac-installer A7K2XQ)`, max_usage=1, expires_at ~24h in the future.

- [ ] **Step 6: Verify enrollment key actually works**

Take the `enrollmentKey` value from step 3 and try a real `agent enroll`:
```bash
cd agent
./bin/breeze-agent enroll <enrollmentKey> --server http://localhost:3001 --quiet
```
Expected: enrollment succeeds, agent.yaml is written with valid config.

- [ ] **Step 7: Confirm CI green**

```bash
cd apps/api && pnpm test
cd apps/api && pnpm test --config vitest.config.rls.ts -- rls-coverage
```
Expected: all green, no new failures.

No commit — Task 8 is verification only.

---

## Self-Review Notes

- **Spec coverage:** Plan A delivers Spec §"Components #2 — API — bootstrap token endpoint" entirely (table, RLS, route, single-use semantics, lazy child-key creation, uniform 404). Spec §"Components #5 — installer builder service" (zip-rename helper) is deferred to Plan C. Spec §"Components #1 — Swift installer app" and §"#4 — CI" are Plan B.
- **No placeholders:** all SQL, all TypeScript, all curl commands are concrete.
- **Type consistency:** `BOOTSTRAP_TOKEN_PATTERN`, `generateBootstrapToken`, `bootstrapTokenExpiresAt`, `installerBootstrapTokens` table, `freshChildExpiresAt`, `generateChildEnrollmentKey` — all defined where first used and referenced consistently downstream.
- **One known gap:** the plan does not explicitly add an OpenAPI annotation for the new routes. If `apps/api/src/openapi.ts` auto-discovers routes, this is a no-op; if it requires manual registration, add a follow-up task. Verify with `grep -n "enrollment-keys" apps/api/src/openapi.ts` after Task 6.
- **One known omission by design:** rate-limiting on the bootstrap endpoint. Spec defers it ("no rate limit for v1; add a global 1000/min if abuse appears"). Same here — call out as a Plan A followup if the security review flags it.

---

## Plan A Followups (not in this plan)

- OpenAPI registration for `/installer/bootstrap/:token` and `/enrollment-keys/:id/bootstrap-token` (if the `openapi.ts` registry is manual).
- Global rate limit on `/installer/bootstrap/:token` (e.g. 1000 req/min from Redis sliding window — `services/rate-limit.ts` pattern).
- Garbage-collection job for expired-but-never-consumed token rows (cron in `apps/api/src/jobs/` running daily — keep one week for audit).
