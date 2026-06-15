# Live Sign-up Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an on-demand synthetic monitor that exercises the live hosted partner sign-up flow (register → verify email → simulate payment → assert activation) against `us`/`eu` production and auto-cleans every account it creates.

**Architecture:** A standalone `tsx` CLI under `e2e-tests/live-signup/` (Playwright for the UI layer, `fetch` for API/Resend) drives the real production endpoints. Two new guarded API actions under `/api/v1/internal/synthetic/` — `simulate-payment` (writes `payment_method_attached_at` on a canary so our real `partnerGuard` reconciliation activates it) and `purge-partner` (full cascade delete) — are gated by a secret + a hard "only `signup-canary+…@2breeze.app` accounts" latch.

**Tech Stack:** TypeScript, Hono (API), Drizzle ORM, Playwright, Vitest, Resend HTTP API, Node 22 (`tsx`).

**Spec:** `docs/superpowers/specs/2026-06-14-live-signup-monitoring-design.md`

**Environment note:** All `pnpm`/`vitest`/`tsx` commands assume the pinned Node. Prefix every command with:
```
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH
```
(Node 23 default breaks pnpm engine-strict.) Fresh worktrees need `pnpm install`.

---

## File Structure

**API (apps/api/src/):**
- Modify `services/tenantCascade.ts` — generalize `topologicalCascadeOrder()` to accept a table set; add `cascadeDeletePartner()`.
- Create `routes/internal/synthetic.ts` — guarded router: shared gate + latch, `simulate-payment`, `purge-partner`.
- Create `routes/internal/synthetic.test.ts` — security-critical unit tests.
- Modify `index.ts` — import + mount router; add `/api/v1/internal/` to the `partnerGuard` passthrough.
- Modify `services/tenantCascade.ts` test: `services/tenantCascade.partner.test.ts` (new) for `cascadeDeletePartner`.

**Web (apps/web/src/):**
- Modify `components/auth/PartnerRegisterForm.tsx` — add `data-testid`s.
- Create `components/auth/PartnerRegisterForm.test.tsx` — assert testids render.
- Modify the post-signup dashboard landing component — add a stable `data-testid` (identified in Task 1).

**Harness (e2e-tests/live-signup/):**
- Create `monitor.ts` — CLI entry + per-region orchestration + exit code.
- Create `regions.ts`, `identity.ts`, `resendClient.ts`, `report.ts`.
- Create `phases/{preflight,apiSmoke,uiFlow,verifyEmail,simulatePayment,cleanup}.ts`.
- Create `lib.test.ts` — unit tests for pure helpers (`identity`, token extraction).
- Modify `e2e-tests/package.json` — add `monitor` script.
- Create `e2e-tests/live-signup/.env.example` and `e2e-tests/live-signup/README.md`.

---

## Task 1: Web — data-testids on the register form + dashboard landing signal

**Files:**
- Modify: `apps/web/src/components/auth/PartnerRegisterForm.tsx`
- Test: `apps/web/src/components/auth/PartnerRegisterForm.test.tsx` (create)
- Modify: the post-signup dashboard landing component (locate in Step 1)

- [ ] **Step 1: Locate the post-signup landing element**

After a successful signup, `PartnerRegisterPage.tsx` calls `login()` and redirects (default to the dashboard). Find the dashboard landing element to tag:

Run: `grep -rn "data-testid" apps/web/src/components/dashboard/ apps/web/src/pages/index.astro apps/web/src/pages/dashboard* 2>/dev/null | head`
Then pick the top-level dashboard container (e.g. the main dashboard page wrapper). Note its file path for Step 5. If a stable container testid already exists (e.g. `dashboard-root`), reuse it and skip Step 5.

- [ ] **Step 2: Write the failing test**

```tsx
// apps/web/src/components/auth/PartnerRegisterForm.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PartnerRegisterForm from './PartnerRegisterForm';

describe('PartnerRegisterForm test ids', () => {
  it('exposes stable data-testids for every field and the submit button', () => {
    render(<PartnerRegisterForm />);
    for (const id of [
      'register-company-name',
      'register-name',
      'register-email',
      'register-password',
      'register-confirm-password',
      'register-accept-terms',
      'register-submit',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/auth/PartnerRegisterForm.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="register-company-name"]`.

- [ ] **Step 4: Add the testids**

In `apps/web/src/components/auth/PartnerRegisterForm.tsx`, add `data-testid` to each control. `PasswordInput` forwards props via `{...register(...)}`, so the attribute must be passed alongside `register`:

- companyName `<input>`: add `data-testid="register-company-name"`
- name `<input>`: add `data-testid="register-name"`
- email `<input>`: add `data-testid="register-email"`
- password `<PasswordInput>`: add `data-testid="register-password"`
- confirmPassword `<PasswordInput>`: add `data-testid="register-confirm-password"`
- acceptTerms `<input type="checkbox">`: add `data-testid="register-accept-terms"`
- submit `<button>`: add `data-testid="register-submit"`

Example (companyName and submit shown; apply the same pattern to all seven):

```tsx
        <input
          id="companyName"
          type="text"
          placeholder="Acme IT Services"
          data-testid="register-company-name"
          className={inputClass}
          {...register('companyName')}
        />
```

```tsx
      <button
        type="submit"
        disabled={isLoading}
        aria-busy={isLoading}
        data-testid="register-submit"
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading ? 'Creating account...' : 'Create company account'}
      </button>
```

> Note: `PasswordInput` must spread unknown props onto its underlying `<input>`. Verify it does (`grep -n "\.\.\." apps/web/src/components/auth/PasswordInput.tsx`). If it does not forward arbitrary attributes, add `data-testid` to its prop passthrough.

- [ ] **Step 5: Add the dashboard landing testid**

On the dashboard container found in Step 1, add `data-testid="dashboard-root"` to the outermost element. (Skip if a stable container testid already exists — record the existing one for Task 6's `uiFlow`.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/auth/PartnerRegisterForm.test.tsx`
Expected: PASS (7 assertions).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/auth/PartnerRegisterForm.tsx apps/web/src/components/auth/PartnerRegisterForm.test.tsx
# plus the dashboard component if modified in Step 5
git commit -m "feat(web): data-testids on partner register form + dashboard landing"
```

---

## Task 2: API — `cascadeDeletePartner` (generalize topo sort, add partner cascade)

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts`
- Test: `apps/api/src/services/tenantCascade.partner.test.ts` (create)

- [ ] **Step 1: Generalize `topologicalCascadeOrder` to accept a table set**

In `tenantCascade.ts`, change the signature so the FK-safe sort can run over any table set (defaulting to the org set so existing callers are unchanged). Replace the `const tableSet = new Set(ORG_CASCADE_DELETE_ORDER);` line at the top of `topologicalCascadeOrder` with a parameter:

```ts
export async function topologicalCascadeOrder(
  tables: Iterable<string> = ORG_CASCADE_DELETE_ORDER,
): Promise<string[]> {
  const tableSet = new Set(tables);
  // ...rest of the function body is unchanged...
}
```

- [ ] **Step 2: Write the failing test for `cascadeDeletePartner`**

```ts
// apps/api/src/services/tenantCascade.partner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execMock = vi.fn();
const cascadeDeleteOrgMock = vi.fn();

vi.mock('../db', () => ({
  db: { execute: (...a: unknown[]) => execMock(...a) },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./auditService', () => ({ createAuditLog: vi.fn() }));

describe('cascadeDeletePartner', () => {
  beforeEach(() => {
    execMock.mockReset();
    cascadeDeleteOrgMock.mockReset();
  });

  it('cascades each child org, sweeps partner-axis tables, then deletes the partner row', async () => {
    const mod = await import('./tenantCascade');
    vi.spyOn(mod, 'cascadeDeleteOrg').mockImplementation(cascadeDeleteOrgMock);
    vi.spyOn(mod, 'topologicalCascadeOrder').mockResolvedValue(['scripts', 'users']);

    // 1st execute() = org id lookup; subsequent = partner-axis discovery + deletes + partners delete
    execMock
      .mockResolvedValueOnce([{ id: 'org-1' }])                 // SELECT id FROM organizations
      .mockResolvedValueOnce([{ table_name: 'scripts' }, { table_name: 'users' }]) // discovery
      .mockResolvedValue([]);                                   // every DELETE

    await mod.cascadeDeletePartner('partner-1', 'synthetic-test-cleanup');

    expect(cascadeDeleteOrgMock).toHaveBeenCalledWith('org-1', 'synthetic-test-cleanup');
    // last execute() must be the partners-row delete
    const lastCall = execMock.mock.calls.at(-1)![0];
    expect(JSON.stringify(lastCall)).toContain('partners');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tenantCascade.partner.test.ts`
Expected: FAIL — `cascadeDeletePartner is not a function`.

- [ ] **Step 4: Implement `cascadeDeletePartner`**

Append to `apps/api/src/services/tenantCascade.ts`. It mirrors `cascadeDeleteOrg`'s strategy: org data first (reusing `cascadeDeleteOrg`, which also deletes the `organizations` row), then an FK-safe partner-axis sweep with **one DELETE per transaction** (a failed DELETE inside a shared transaction would poison it), then the `partners` row, then audit.

```ts
/**
 * Hard-deletes a partner and ALL its data. Built for synthetic test-canary
 * cleanup (see routes/internal/synthetic.ts). The caller MUST have already
 * verified the partner is a disposable canary — this helper does not re-check.
 *
 * Strategy (mirrors cascadeDeleteOrg):
 *   1. For each child org → cascadeDeleteOrg (also removes the organizations row).
 *   2. FK-safe sweep of every public table with a `partner_id` column, deleting
 *      this partner's rows children-first. One DELETE per transaction so a single
 *      FK failure cannot poison a shared transaction.
 *   3. Delete the partners row last.
 * Idempotent: re-running on an already-purged partner matches zero rows.
 */
export async function cascadeDeletePartner(
  partnerId: string,
  performedBy: string,
): Promise<{ orgsDeleted: number; tablesSwept: number }> {
  // 1. Child orgs (org-scoped data + the organizations row each).
  const orgRows = (await dbModule.db.execute(
    sql`SELECT id FROM organizations WHERE partner_id = ${partnerId}`,
  )) as unknown as Array<{ id: string }>;
  for (const row of orgRows) {
    await cascadeDeleteOrg(row.id, performedBy);
  }

  // 2. Partner-axis sweep. Discover tables with a partner_id column (excluding
  //    organizations, already handled), order children-first via the shared
  //    FK topo sort, and delete each in its own transaction.
  const partnerTableRows = (await dbModule.db.execute(sql`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'partner_id'
      AND table_name <> 'organizations'
  `)) as unknown as Array<{ table_name: string }>;
  const partnerTables = partnerTableRows.map((r) => r.table_name);
  const order = await topologicalCascadeOrder(partnerTables);
  // topologicalCascadeOrder only returns tables it was given; any discovered
  // table missing from `order` (no FK edges) is appended so nothing is skipped.
  const orderedSet = new Set(order);
  const sweep = [...order, ...partnerTables.filter((t) => !orderedSet.has(t))];

  for (const table of sweep) {
    await dbModule.db.execute(
      sql`DELETE FROM ${sql.raw(quoteIdent(table))} WHERE partner_id = ${partnerId}`,
    );
  }

  // 3. The partners row itself.
  await dbModule.db.execute(sql`DELETE FROM partners WHERE id = ${partnerId}`);

  await createAuditLog({
    orgId: null,
    actorType: 'system',
    actorId: performedBy,
    action: 'test.synthetic_partner.purged',
    details: { partnerId, orgsDeleted: orgRows.length, tablesSwept: sweep.length },
  } as Parameters<typeof createAuditLog>[0]);

  return { orgsDeleted: orgRows.length, tablesSwept: sweep.length };
}
```

> `quoteIdent` is already defined in this file (used by `cascadeDeleteOrg`'s per-table delete). Confirm with `grep -n "function quoteIdent" apps/api/src/services/tenantCascade.ts`. If `createAuditLog`'s param type rejects the `details` key, match the exact key name used elsewhere in this file's `createAuditLog` calls (grep `createAuditLog(` in tenantCascade.ts).

- [ ] **Step 5: Run the test to verify it passes**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tenantCascade.partner.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the org cascade test still passes (signature change)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tenantCascade`
Expected: PASS (no regressions from the `topologicalCascadeOrder` default-param change).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantCascade.partner.test.ts
git commit -m "feat(api): cascadeDeletePartner for synthetic-canary cleanup"
```

---

## Task 3: API — guarded internal synthetic router (gate + latch + two actions)

**Files:**
- Create: `apps/api/src/routes/internal/synthetic.ts`
- Test: `apps/api/src/routes/internal/synthetic.test.ts`

- [ ] **Step 1: Write the failing security tests**

```ts
// apps/api/src/routes/internal/synthetic.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const partnerLookupMock = vi.fn();
const setPaymentMock = vi.fn();
const cascadeDeletePartnerMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: () => partnerLookupMock() }) }) }),
    update: () => ({ set: () => ({ where: () => setPaymentMock() }) }),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../services/tenantCascade', () => ({
  cascadeDeletePartner: (...a: unknown[]) => cascadeDeletePartnerMock(...a),
}));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: () => '10.0.0.9' }));

const CANARY = [{ id: 'p1', adminEmail: 'signup-canary+abc@2breeze.app' }];
const REAL = [{ id: 'p1', adminEmail: 'owner@acme.com' }];

async function load() {
  vi.resetModules();
  const { internalSyntheticRoutes } = await import('./synthetic');
  return internalSyntheticRoutes;
}

function req(path: string, headers: Record<string, string> = {}, body: unknown = { partnerId: 'p1' }) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const AUTH = { Authorization: 'Bearer s3cret-token' };

describe('internal synthetic router gate', () => {
  beforeEach(() => {
    partnerLookupMock.mockReset();
    setPaymentMock.mockReset().mockResolvedValue(undefined);
    cascadeDeletePartnerMock.mockReset().mockResolvedValue({ orgsDeleted: 1, tablesSwept: 3 });
    vi.unstubAllEnvs();
  });

  for (const path of ['/simulate-payment', '/purge-partner']) {
    it(`${path}: 503 when SYNTHETIC_TEST_TOKEN unset`, async () => {
      const app = await load();
      const res = await app.request(req(path, AUTH));
      expect(res.status).toBe(503);
    });

    it(`${path}: 401 on wrong bearer`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      const app = await load();
      const res = await app.request(req(path, { Authorization: 'Bearer nope' }));
      expect(res.status).toBe(401);
    });

    it(`${path}: 403 when IP not in allowlist`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      vi.stubEnv('SYNTHETIC_TEST_IP_ALLOWLIST', '1.2.3.4');
      const app = await load();
      const res = await app.request(req(path, AUTH));
      expect(res.status).toBe(403);
    });

    it(`${path}: 422 when target is NOT a canary account (the latch)`, async () => {
      vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
      partnerLookupMock.mockResolvedValue(REAL);
      const app = await load();
      const res = await app.request(req(path, AUTH));
      expect(res.status).toBe(422);
    });
  }

  it('simulate-payment: writes payment_method_attached_at for a canary, does NOT flip status', async () => {
    vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
    partnerLookupMock.mockResolvedValue(CANARY);
    const app = await load();
    const res = await app.request(req('/simulate-payment', AUTH));
    expect(res.status).toBe(200);
    expect(setPaymentMock).toHaveBeenCalledTimes(1);
    expect(cascadeDeletePartnerMock).not.toHaveBeenCalled();
  });

  it('purge-partner: cascades a canary partner', async () => {
    vi.stubEnv('SYNTHETIC_TEST_TOKEN', 's3cret-token');
    partnerLookupMock.mockResolvedValue(CANARY);
    const app = await load();
    const res = await app.request(req('/purge-partner', AUTH));
    expect(res.status).toBe(200);
    expect(cascadeDeletePartnerMock).toHaveBeenCalledWith('p1', expect.any(String));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/internal/synthetic.test.ts`
Expected: FAIL — cannot resolve `./synthetic`.

- [ ] **Step 3: Implement the router**

```ts
// apps/api/src/routes/internal/synthetic.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { partners, partnerUsers, users } from '../../db/schema';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { cascadeDeletePartner } from '../../services/tenantCascade';
import { createAuditLog } from '../../services/auditService';

export const internalSyntheticRoutes = new Hono();

const PERFORMED_BY = 'synthetic-test-monitor';
// Hard latch: the ONLY accounts these endpoints may ever touch.
const CANARY_EMAIL_RE = /^signup-canary\+[^@]*@2breeze\.app$/i;

function token(): string | undefined {
  return process.env.SYNTHETIC_TEST_TOKEN?.trim() || undefined;
}

function ipAllowlist(): Set<string> {
  const raw = process.env.SYNTHETIC_TEST_IP_ALLOWLIST;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Shared gate: secret presence (503), IP allowlist (403), timing-safe bearer (401).
internalSyntheticRoutes.use('*', async (c, next) => {
  const expected = token();
  if (!expected) return c.json({ error: 'Synthetic test endpoints are not configured' }, 503);

  const allow = ipAllowlist();
  if (allow.size > 0) {
    const ip = getTrustedClientIpOrUndefined(c);
    if (!ip || !allow.has(ip)) return c.json({ error: 'Forbidden' }, 403);
  }

  if (!safeEqual(c.req.header('Authorization') ?? '', `Bearer ${expected}`)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

const bodySchema = z.object({ partnerId: z.string().uuid() });

/**
 * Load the partner + its admin user email and enforce the canary latch.
 * Returns the partnerId on success, or a Response to short-circuit with.
 */
async function requireCanary(partnerId: string): Promise<{ ok: true } | { ok: false; res: Response; status: number }> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: partners.id, adminEmail: users.email })
      .from(partners)
      .innerJoin(partnerUsers, eq(partnerUsers.partnerId, partners.id))
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .where(eq(partners.id, partnerId))
      .limit(1),
  );
  const row = rows?.[0];
  if (!row || !CANARY_EMAIL_RE.test(row.adminEmail ?? '')) {
    return { ok: false, status: 422, res: new Response(null), };
  }
  return { ok: true };
}

internalSyntheticRoutes.post('/simulate-payment', async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'partnerId (uuid) required' }, 400);
  const { partnerId } = parsed.data;

  const latch = await requireCanary(partnerId);
  if (!latch.ok) return c.json({ error: 'Not a synthetic canary partner' }, 422);

  // Mirror exactly what breeze-billing's webhook writes. Do NOT flip status —
  // activation is left to the real partnerGuard reconciliation so the monitor
  // actually exercises it.
  await withSystemDbAccessContext(() =>
    db
      .update(partners)
      .set({
        paymentMethodAttachedAt: new Date(),
        stripeCustomerId: sql`COALESCE(${partners.stripeCustomerId}, ${'cus_canary_' + partnerId})`,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, partnerId)),
  );

  await createAuditLog({
    orgId: null,
    actorType: 'system',
    actorId: PERFORMED_BY,
    action: 'test.synthetic_partner.payment_simulated',
    details: { partnerId },
  } as Parameters<typeof createAuditLog>[0]);

  return c.json({ simulated: true, partnerId });
});

internalSyntheticRoutes.post('/purge-partner', async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: 'partnerId (uuid) required' }, 400);
  const { partnerId } = parsed.data;

  const latch = await requireCanary(partnerId);
  if (!latch.ok) return c.json({ error: 'Not a synthetic canary partner' }, 422);

  const stats = await cascadeDeletePartner(partnerId, PERFORMED_BY);
  return c.json({ purged: true, partnerId, stats });
});
```

> Verify the imported schema names: `grep -nE "export const (partners|partnerUsers|users)\b" apps/api/src/db/schema/*.ts`. Adjust the import path/names if `users`/`partnerUsers` live under different exports. If `users.email` is the wrong column name, correct it (`grep -n "email" apps/api/src/db/schema/users.ts`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/internal/synthetic.test.ts`
Expected: PASS (all gate/latch/happy-path cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/internal/synthetic.ts apps/api/src/routes/internal/synthetic.test.ts
git commit -m "feat(api): guarded synthetic test router (simulate-payment + purge-partner)"
```

---

## Task 4: API — mount the router + partnerGuard passthrough

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Add the passthrough for `/api/v1/internal/`**

In `apps/api/src/index.ts`, the global guard is the `api.use('*', ...)` block (around line 663). Add an `/internal/` passthrough alongside the existing `/auth`, `/config`, `/users/me` exceptions so the synthetic router reaches its own gate instead of `partnerGuard`:

```ts
api.use('*', async (c, next) => {
  const path = c.req.path;
  if (path.startsWith('/api/v1/auth')) return next();
  if (path === '/api/v1/config' || path.startsWith('/api/v1/config/')) return next();
  if (path.startsWith('/api/v1/users/me')) return next();
  if (path === '/api/v1/partner/me' || path.startsWith('/api/v1/partner/me/')) return next();
  if (path.startsWith('/api/v1/agents/')) return next();
  if (path.startsWith('/api/v1/internal/')) return next();   // synthetic test router — self-gated
  return partnerGuard(c, next);
});
```

- [ ] **Step 2: Import and mount the router**

Add the import near the other route imports (e.g. by the `adminRoutes` import around line 131):

```ts
import { internalSyntheticRoutes } from './routes/internal/synthetic';
```

Add the mount next to the other `api.route(...)` calls (e.g. just after `api.route('/partner', partnerRoutes);` around line 823):

```ts
api.route('/internal/synthetic', internalSyntheticRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors (pre-existing errors in `agents.test.ts` / `apiKeyAuth.test.ts` are known per CLAUDE notes).

- [ ] **Step 4: Smoke-run the gate locally (optional, needs API running)**

With the local API up and `SYNTHETIC_TEST_TOKEN` unset:
Run: `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/api/v1/internal/synthetic/purge-partner -H 'content-type: application/json' -d '{"partnerId":"00000000-0000-0000-0000-000000000000"}'`
Expected: `503` (feature off by default).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): mount synthetic test router + partnerGuard passthrough"
```

---

## Task 5: Harness scaffolding — config, identity, Resend client, pure-helper tests

**Files:**
- Modify: `e2e-tests/package.json`
- Create: `e2e-tests/live-signup/regions.ts`, `identity.ts`, `resendClient.ts`, `report.ts`
- Create: `e2e-tests/live-signup/lib.test.ts`
- Create: `e2e-tests/live-signup/.env.example`

- [ ] **Step 1: Add the `monitor` script**

In `e2e-tests/package.json` `scripts`, add:

```json
    "monitor": "tsx live-signup/monitor.ts",
```

- [ ] **Step 2: Write `regions.ts`**

```ts
// e2e-tests/live-signup/regions.ts
export type RegionKey = 'us' | 'eu';

export interface Region {
  key: RegionKey;
  baseUrl: string;   // web origin; API is baseUrl + /api/v1
  apiUrl: string;
}

export const REGIONS: Record<RegionKey, Region> = {
  us: { key: 'us', baseUrl: 'https://us.2breeze.app', apiUrl: 'https://us.2breeze.app/api/v1' },
  eu: { key: 'eu', baseUrl: 'https://eu.2breeze.app', apiUrl: 'https://eu.2breeze.app/api/v1' },
};

export function parseRegions(arg: string | undefined): Region[] {
  const v = (arg ?? 'both').toLowerCase();
  if (v === 'both') return [REGIONS.us, REGIONS.eu];
  if (v === 'us' || v === 'eu') return [REGIONS[v]];
  throw new Error(`--region must be us|eu|both, got "${arg}"`);
}
```

- [ ] **Step 3: Write the pure-helper test first (identity + token extraction)**

```ts
// e2e-tests/live-signup/lib.test.ts
import { describe, it, expect } from 'vitest';
import { makeIdentity } from './identity';
import { extractVerifyToken } from './resendClient';

describe('makeIdentity', () => {
  it('produces a canary-prefixed @2breeze.app email matching the API latch', () => {
    const id = makeIdentity('run123', 'ui');
    expect(id.email).toMatch(/^signup-canary\+run123-ui@2breeze\.app$/);
    expect(id.companyName.length).toBeGreaterThanOrEqual(2);
    expect(id.password.length).toBeGreaterThanOrEqual(12);
  });
});

describe('extractVerifyToken', () => {
  it('pulls the 48-char token out of a verify-email link', () => {
    const tok = 'A'.repeat(48);
    const html = `<a href="https://us.2breeze.app/auth/verify-email?token=${tok}">Verify</a>`;
    expect(extractVerifyToken(html)).toBe(tok);
  });
  it('returns null when no token present', () => {
    expect(extractVerifyToken('<p>no link here</p>')).toBeNull();
  });
});
```

Run (must FAIL — modules not created yet):
`PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/e2e-tests exec vitest run live-signup/lib.test.ts`

> If `@breeze/e2e-tests` has no vitest, run from the package dir instead: `cd e2e-tests && npx vitest run live-signup/lib.test.ts` (tsx/typescript are already devDeps; add `vitest` to devDependencies if absent: `pnpm --filter @breeze/e2e-tests add -D vitest`).

- [ ] **Step 4: Write `identity.ts`**

```ts
// e2e-tests/live-signup/identity.ts
import { randomBytes } from 'crypto';

export interface Identity {
  email: string;
  password: string;
  name: string;
  companyName: string;
}

/** runId + layer ('api' | 'ui') → a unique canary identity the API latch accepts. */
export function makeIdentity(runId: string, layer: 'api' | 'ui'): Identity {
  const rand = randomBytes(9).toString('base64url'); // strong, URL-safe
  return {
    email: `signup-canary+${runId}-${layer}@2breeze.app`,
    password: `Cy-${rand}-${randomBytes(6).toString('base64url')}9!`,
    name: 'Signup Canary',
    companyName: `Canary ${runId} ${layer}`,
  };
}

export function makeRunId(): string {
  // No Date.now() restriction here (this is a normal Node CLI, not a workflow).
  return `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}
```

- [ ] **Step 5: Write `resendClient.ts`**

```ts
// e2e-tests/live-signup/resendClient.ts
const RESEND_BASE = 'https://api.resend.com';

export function extractVerifyToken(html: string): string | null {
  const m = html.match(/verify-email\?token=([A-Za-z0-9_-]{48})/);
  return m ? m[1] : null;
}

interface ResendListItem { id: string; to: string[] | string; subject?: string; created_at?: string }

async function resend(path: string, apiKey: string): Promise<any> {
  const res = await fetch(`${RESEND_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Resend ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

function toList(to: string[] | string | undefined): string[] {
  if (!to) return [];
  return Array.isArray(to) ? to : [to];
}

/**
 * Poll Resend's sent log for the verification email to `recipient`, fetch its
 * HTML, and return the 48-char token. Throws on timeout.
 */
export async function fetchVerifyToken(opts: {
  apiKey: string;
  recipient: string;
  timeoutMs?: number;
}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  let delay = 2_000;
  while (Date.now() < deadline) {
    const list = (await resend('/emails?limit=100', opts.apiKey)) as { data?: ResendListItem[] };
    const match = (list.data ?? []).find((e) =>
      toList(e.to).some((addr) => addr.toLowerCase() === opts.recipient.toLowerCase()),
    );
    if (match) {
      const full = (await resend(`/emails/${match.id}`, opts.apiKey)) as { html?: string; text?: string };
      const token = extractVerifyToken(full.html ?? full.text ?? '');
      if (token) return token;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 10_000);
  }
  throw new Error(`Verification email to ${opts.recipient} not observed in Resend within budget`);
}
```

> The Resend list response shape is `{ data: [...] }` per their API. If a run shows the list under a different key, adjust `list.data`. The retrieve endpoint returns `{ html, text }`.

- [ ] **Step 6: Write `report.ts`**

```ts
// e2e-tests/live-signup/report.ts
export interface PhaseResult { name: string; ok: boolean; ms: number; error?: string }
export interface RegionResult { region: string; phases: PhaseResult[]; ok: boolean }

export function printReport(results: RegionResult[], json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ results, ok: results.every((r) => r.ok) }, null, 2) + '\n');
    return;
  }
  for (const r of results) {
    process.stdout.write(`\n=== ${r.region.toUpperCase()} : ${r.ok ? 'PASS' : 'FAIL'} ===\n`);
    for (const p of r.phases) {
      const mark = p.ok ? '✓' : '✗';
      process.stdout.write(`  ${mark} ${p.name.padEnd(16)} ${p.ms}ms${p.error ? `  — ${p.error}` : ''}\n`);
    }
  }
  process.stdout.write(`\nOVERALL: ${results.every((r) => r.ok) ? 'PASS' : 'FAIL'}\n`);
}
```

- [ ] **Step 7: Run the pure-helper tests to verify they pass**

Run: `cd e2e-tests && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run live-signup/lib.test.ts`
Expected: PASS (identity + token-extraction cases).

- [ ] **Step 8: Write `.env.example`**

```bash
# e2e-tests/live-signup/.env.example — copy to e2e-tests/live-signup/.env (gitignored)
RESEND_API_KEY=re_xxx               # read access to the sent-email log
SYNTHETIC_TEST_TOKEN=               # must match each region's API SYNTHETIC_TEST_TOKEN
```

Confirm `.env` is gitignored (`grep -n "\.env" e2e-tests/.gitignore ../.gitignore 2>/dev/null`); if not, add `live-signup/.env` to `e2e-tests/.gitignore`.

- [ ] **Step 9: Commit**

```bash
git add e2e-tests/package.json e2e-tests/live-signup/regions.ts e2e-tests/live-signup/identity.ts e2e-tests/live-signup/resendClient.ts e2e-tests/live-signup/report.ts e2e-tests/live-signup/lib.test.ts e2e-tests/live-signup/.env.example e2e-tests/.gitignore
git commit -m "feat(e2e): live-signup monitor scaffolding (regions, identity, resend, report)"
```

---

## Task 6: Harness phases + orchestrator

**Files:**
- Create: `e2e-tests/live-signup/phases/preflight.ts`, `apiSmoke.ts`, `uiFlow.ts`, `verifyEmail.ts`, `simulatePayment.ts`, `cleanup.ts`
- Create: `e2e-tests/live-signup/monitor.ts`

- [ ] **Step 1: Write `phases/preflight.ts`**

```ts
// e2e-tests/live-signup/phases/preflight.ts
import type { Region } from '../regions';

export async function preflight(region: Region): Promise<void> {
  const health = await fetch(`${region.baseUrl}/health/ready`);
  if (!health.ok) throw new Error(`health/ready → ${health.status}`);

  const cfgRes = await fetch(`${region.apiUrl}/config`);
  if (!cfgRes.ok) throw new Error(`config → ${cfgRes.status}`);
  const cfg = (await cfgRes.json()) as { registration?: { enabled?: boolean } };
  if (cfg.registration?.enabled !== true) {
    throw new Error('registration.enabled is not true on this region');
  }
}
```

- [ ] **Step 2: Write `phases/apiSmoke.ts`**

```ts
// e2e-tests/live-signup/phases/apiSmoke.ts
import type { Region } from '../regions';
import type { Identity } from '../identity';

export interface SignupResult { partnerId: string; accessToken: string }

export async function registerViaApi(region: Region, id: Identity): Promise<SignupResult> {
  const res = await fetch(`${region.apiUrl}/auth/register-partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      companyName: id.companyName,
      name: id.name,
      email: id.email,
      password: id.password,
      acceptTerms: true,
    }),
  });
  if (!res.ok) throw new Error(`register-partner → ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { partner?: { id?: string }; tokens?: { accessToken?: string } };
  if (!body.partner?.id || !body.tokens?.accessToken) {
    throw new Error('register-partner response missing partner.id or tokens.accessToken');
  }
  return { partnerId: body.partner.id, accessToken: body.tokens.accessToken };
}
```

- [ ] **Step 3: Write `phases/uiFlow.ts`**

```ts
// e2e-tests/live-signup/phases/uiFlow.ts
import { chromium } from 'playwright';
import type { Region } from '../regions';
import type { Identity } from '../identity';
import type { SignupResult } from './apiSmoke';

export async function registerViaUi(region: Region, id: Identity): Promise<SignupResult> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    // Capture the register-partner response to read partner.id + accessToken.
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes('/auth/register-partner') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );

    await page.goto(`${region.baseUrl}/register-partner`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('register-company-name').fill(id.companyName);
    await page.getByTestId('register-name').fill(id.name);
    await page.getByTestId('register-email').fill(id.email);
    await page.getByTestId('register-password').fill(id.password);
    await page.getByTestId('register-confirm-password').fill(id.password);
    await page.getByTestId('register-accept-terms').check();
    await page.getByTestId('register-submit').click();

    const resp = await responsePromise;
    if (!resp.ok()) throw new Error(`UI register-partner → ${resp.status()}`);
    const body = (await resp.json()) as { partner?: { id?: string }; tokens?: { accessToken?: string } };
    if (!body.partner?.id || !body.tokens?.accessToken) {
      throw new Error('UI register-partner response missing partner.id/accessToken');
    }

    // Assert we land authenticated on the dashboard.
    await page.getByTestId('dashboard-root').waitFor({ state: 'visible', timeout: 20_000 });

    return { partnerId: body.partner.id, accessToken: body.tokens.accessToken };
  } finally {
    await browser.close();
  }
}
```

> If Step 1 of Task 1 reused an existing dashboard testid instead of `dashboard-root`, use that id here.

- [ ] **Step 4: Write `phases/verifyEmail.ts`**

```ts
// e2e-tests/live-signup/phases/verifyEmail.ts
import type { Region } from '../regions';
import { fetchVerifyToken } from '../resendClient';

export async function verifyEmail(region: Region, recipient: string, resendApiKey: string): Promise<void> {
  const token = await fetchVerifyToken({ apiKey: resendApiKey, recipient });
  const res = await fetch(`${region.apiUrl}/auth/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`verify-email → ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { verified?: boolean };
  if (body.verified !== true) throw new Error('verify-email did not return verified:true');
}
```

- [ ] **Step 5: Write `phases/simulatePayment.ts`**

```ts
// e2e-tests/live-signup/phases/simulatePayment.ts
import type { Region } from '../regions';

/**
 * Simulate a successful payment on the canary (writes payment_method_attached_at),
 * then trigger the REAL partnerGuard reconciliation by hitting a guarded partner
 * endpoint with the canary's own token, and confirm status flipped to 'active'.
 */
export async function simulatePaymentAndAssertActivation(opts: {
  region: Region;
  partnerId: string;
  accessToken: string;
  syntheticToken: string;
}): Promise<void> {
  const { region, partnerId, accessToken, syntheticToken } = opts;

  const sim = await fetch(`${region.apiUrl}/internal/synthetic/simulate-payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${syntheticToken}` },
    body: JSON.stringify({ partnerId }),
  });
  if (!sim.ok) throw new Error(`simulate-payment → ${sim.status} ${await sim.text()}`);

  // /partner/dashboard runs partnerGuard (not in the passthrough): a 200 means
  // the partner self-healed pending→active; a still-pending partner returns 403.
  const dash = await fetch(`${region.apiUrl}/partner/dashboard`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (dash.status !== 200) {
    throw new Error(`partner/dashboard after payment → ${dash.status} (expected 200 = activated)`);
  }

  // Explicit confirmation: /partner/me now reports active.
  const me = await fetch(`${region.apiUrl}/partner/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await me.json()) as { status?: string };
  if (body.status !== 'active') throw new Error(`partner/me status = ${body.status} (expected active)`);
}
```

- [ ] **Step 6: Write `phases/cleanup.ts`**

```ts
// e2e-tests/live-signup/phases/cleanup.ts
import type { Region } from '../regions';

export async function purgePartner(region: Region, partnerId: string, syntheticToken: string): Promise<void> {
  const res = await fetch(`${region.apiUrl}/internal/synthetic/purge-partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${syntheticToken}` },
    body: JSON.stringify({ partnerId }),
  });
  if (!res.ok) throw new Error(`purge-partner ${partnerId} → ${res.status} ${await res.text()}`);
}
```

- [ ] **Step 7: Write `monitor.ts` (orchestrator)**

```ts
// e2e-tests/live-signup/monitor.ts
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { parseRegions, type Region } from './regions';
import { makeIdentity, makeRunId } from './identity';
import { printReport, type PhaseResult, type RegionResult } from './report';
import { preflight } from './phases/preflight';
import { registerViaApi, type SignupResult } from './phases/apiSmoke';
import { registerViaUi } from './phases/uiFlow';
import { verifyEmail } from './phases/verifyEmail';
import { simulatePaymentAndAssertActivation } from './phases/simulatePayment';
import { purgePartner } from './phases/cleanup';

loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

async function timed(name: string, fn: () => Promise<void>): Promise<PhaseResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - start };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runRegion(region: Region, opts: {
  resendKey: string; syntheticToken: string; skipUi: boolean; skipVerify: boolean;
}): Promise<RegionResult> {
  const runId = makeRunId();
  const phases: PhaseResult[] = [];
  const created: SignupResult[] = [];
  let uiRecipient: string | null = null;

  phases.push(await timed('preflight', () => preflight(region)));
  if (!phases[0].ok) {
    return { region: region.key, phases, ok: false };
  }

  // API smoke (identity A)
  const idA = makeIdentity(runId, 'api');
  phases.push(await timed('apiSmoke', async () => {
    created.push(await registerViaApi(region, idA));
  }));

  // UI flow (identity B) — also the verify + payment target
  let uiResult: SignupResult | null = null;
  if (!opts.skipUi) {
    const idB = makeIdentity(runId, 'ui');
    uiRecipient = idB.email;
    phases.push(await timed('uiFlow', async () => {
      uiResult = await registerViaUi(region, idB);
      created.push(uiResult);
    }));

    if (uiResult && !opts.skipVerify) {
      phases.push(await timed('verifyEmail', () => verifyEmail(region, uiRecipient!, opts.resendKey)));
      phases.push(await timed('payment', () => simulatePaymentAndAssertActivation({
        region, partnerId: uiResult!.partnerId, accessToken: uiResult!.accessToken, syntheticToken: opts.syntheticToken,
      })));
    }
  }

  // Cleanup ALWAYS — purge every partner we created.
  for (const c of created) {
    phases.push(await timed(`cleanup:${c.partnerId.slice(0, 8)}`, () =>
      purgePartner(region, c.partnerId, opts.syntheticToken)));
  }

  return { region: region.key, phases, ok: phases.every((p) => p.ok) };
}

async function main(): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  const syntheticToken = process.env.SYNTHETIC_TEST_TOKEN;
  if (!resendKey || !syntheticToken) {
    console.error('RESEND_API_KEY and SYNTHETIC_TEST_TOKEN must be set (see live-signup/.env.example)');
    process.exit(2);
  }

  const regions = parseRegions(arg('region'));
  const opts = { resendKey, syntheticToken, skipUi: hasFlag('skip-ui'), skipVerify: hasFlag('skip-verify') };

  const results: RegionResult[] = [];
  for (const region of regions) {
    results.push(await runRegion(region, opts)); // sequential US then EU
  }

  printReport(results, hasFlag('json'));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 8: Typecheck the harness**

Run: `cd e2e-tests && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit -p .` (if no tsconfig, run `npx tsc --noEmit live-signup/monitor.ts --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck`)
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add e2e-tests/live-signup/phases e2e-tests/live-signup/monitor.ts
git commit -m "feat(e2e): live-signup monitor phases + orchestrator"
```

---

## Task 7: Docs + deploy env wiring

**Files:**
- Create: `e2e-tests/live-signup/README.md`
- Modify: `deploy/.env.example`
- Modify: `CLAUDE.md` (deploy section note) — optional but recommended

- [ ] **Step 1: Write the README**

````markdown
# Live Sign-up Monitor

On-demand synthetic monitor for the hosted partner sign-up flow. Per region it:
preflight → API register → UI register (Playwright) → email verify (via Resend) →
simulate payment → assert pending→active → purge every account it created.

## Setup
```bash
cp live-signup/.env.example live-signup/.env   # fill RESEND_API_KEY + SYNTHETIC_TEST_TOKEN
cd e2e-tests && pnpm install && npx playwright install chromium
```
`SYNTHETIC_TEST_TOKEN` must match the `SYNTHETIC_TEST_TOKEN` set on each region's API.

## Run
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/e2e-tests monitor            # both regions
pnpm --filter @breeze/e2e-tests monitor -- --region us               # one region
pnpm --filter @breeze/e2e-tests monitor -- --skip-ui --skip-verify   # fast preflight+API+cleanup
pnpm --filter @breeze/e2e-tests monitor -- --json                    # machine-readable
```
Exit `0` = all phases passed for all regions; `1` = a failure (the integration seam for future cron/Slack).

## Notes
- Canary accounts are `signup-canary+<runId>-<layer>@2breeze.app`; the API purge endpoint
  refuses anything that doesn't match that pattern.
- Register rate limit is 3/hour/IP; two signups per region per run. Back-to-back runs from one IP
  within an hour can trip it.
- Stripe itself is not exercised — `simulate-payment` writes the timestamp our reconciliation
  reacts to. See the design spec for the coverage tradeoff.
````

- [ ] **Step 2: Add the API env var to the deploy template**

In `deploy/.env.example`, add (under a "Synthetic monitoring" comment):

```bash
# Synthetic sign-up monitor (off unless set). Enables /api/v1/internal/synthetic/*.
# Must ALSO be mapped in the api service `environment:` block of docker-compose.
SYNTHETIC_TEST_TOKEN=
SYNTHETIC_TEST_IP_ALLOWLIST=
```

- [ ] **Step 3: Record the deploy wiring requirement**

Add a one-line note to the README (or a `deploy/` note) that on each droplet the var must be added to `/opt/breeze/.env` **and** mapped in the `api` service `environment:` block of `/opt/breeze/docker-compose.yml` (compose interpolation only happens for explicitly-listed vars). This is a manual prod step performed when the feature is turned on — not part of code.

- [ ] **Step 4: Commit**

```bash
git add e2e-tests/live-signup/README.md deploy/.env.example
git commit -m "docs(e2e): live-signup monitor README + deploy env wiring"
```

---

## Task 8: Full-suite verification

- [ ] **Step 1: API unit tests for the new code**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/internal/synthetic.test.ts src/services/tenantCascade.partner.test.ts`
Expected: PASS.

- [ ] **Step 2: Web test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/auth/PartnerRegisterForm.test.tsx`
Expected: PASS.

- [ ] **Step 3: Harness pure-helper tests**

Run: `cd e2e-tests && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run live-signup/lib.test.ts`
Expected: PASS.

- [ ] **Step 4: RLS / cascade integration (needs a real DB; run if available)**

Run the integration suite that covers tenant cascade + RLS coverage to confirm the
`topologicalCascadeOrder` signature change and the partner-axis assumptions hold:
`PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts tenantCascade`
Expected: PASS (or skipped with a clear "no DB" message — do not claim pass if skipped).

- [ ] **Step 5: Manual live validation (the real test of the monitor)**

Once `SYNTHETIC_TEST_TOKEN` is set on a region's API (start with US), run a single live region with cleanup and confirm a clean PASS and that no canary rows remain:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/e2e-tests monitor -- --region us
```
Expected: every phase `✓`, OVERALL PASS, exit 0. Then verify no leak (server-side, via the prod DB per the managed-PG access pattern):
`SELECT id, status FROM partners WHERE id IN (...the run's partner ids...);` → 0 rows.

- [ ] **Step 6: Finalize**

Confirm `git status` is clean and all task commits are present on `feat/live-signup-monitoring`.

---

## Self-Review (completed during authoring)

- **Spec coverage:** both layers (Task 5/6 apiSmoke + uiFlow) · email verify via Resend (Task 6 verifyEmail + Task 5 resendClient) · payment simulation + activation assertion (Task 3 simulate-payment + Task 6 simulatePayment) · auto-cleanup always-runs (Task 6 monitor `created[]` loop + Task 3/2 purge) · both regions sequential (Task 6 monitor) · guarded router with gate + latch (Task 3) · data-testids (Task 1) · env wiring (Task 7) · security-critical latch tests (Task 3). All spec sections map to a task.
- **Type consistency:** `SignupResult { partnerId, accessToken }` is produced by both `registerViaApi` and `registerViaUi` and consumed by `simulatePayment`/`cleanup`. `Identity` fields match the register body. `Region { key, baseUrl, apiUrl }` used consistently. `cascadeDeletePartner(partnerId, performedBy)` signature matches its caller in `synthetic.ts`.
- **Known follow-ups (deferred per spec):** scheduling + Slack alerting; rate-limit IP allowlisting for frequent runs; real Stripe-path coverage.
