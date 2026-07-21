# Signup Abuse Detection Implementation Plan (PR 1: data capture + PR 2: sweep/alerting)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist signup/enrollment attribution data and run an hourly deterministic abuse-signals sweep that alerts the platform operator (Discord webhook/email) on activation-invariant breaches and malicious-RMM-use heuristics.

**Architecture:** New nullable attribution columns on `partners`/`devices` written on existing hot paths; a system-scoped `partner_abuse_signals` table (RLS deny-all to tenants) fed by an hourly BullMQ job; pure-function signal scoring over fleet-grouped SQL aggregates; a standalone `opsAlerts` service with state-based dedup so alerts fire once per signal lifecycle.

**Tech Stack:** Hono, Drizzle ORM + raw `sql` aggregates, BullMQ, Vitest with Drizzle mocks, `safeFetch` for outbound webhooks.

**Spec:** `docs/superpowers/specs/security-auth/2026-07-11-signup-abuse-detection-design.md`

## Global Constraints

- RLS: `partner_abuse_signals` must be readable/writable ONLY under the system DB context (`current_setting('breeze.scope', true) = 'system'`). Never add `breeze_has_partner_access` policies to it — partners must not see signals about themselves.
- Background DB access always goes through `runOutsideDbContext(() => withSystemDbAccessContext(...))` (the #1105 pattern); a bare `db` read from a worker silently returns 0 rows.
- Migrations: filename `YYYY-MM-DD-<slug>.sql` (adjust date prefix to the actual implementation date; keep relative order), idempotent (`IF NOT EXISTS`, `pg_policies` checks), no inner `BEGIN;`/`COMMIT;`, never edit shipped migrations.
- BullMQ jobIds use `-`, never `:`.
- New env vars are OPTIONAL: unset → logged warning + no-op, never boot refusal. No IPs, hostnames, webhook URLs, or tenant identifiers in code, config templates, tests, or comments.
- IP columns are `varchar(45)`, user agents are `text` (house style per `sessions`).
- Tests live alongside source files. Run API tests with `pnpm test --filter=@breeze/api` (or `npx vitest run <file>` inside `apps/api`).
- Commit after each task with a conventional-commit message.

---

### Task 1: Attribution columns (schema + migration)

**Files:**
- Modify: `apps/api/src/db/schema/orgs.ts` (partners table, after `mcpOriginUserAgent` ~line 34)
- Modify: `apps/api/src/db/schema/devices.ts` (devices table, after `lastSeenIp` ~line 46)
- Create: `apps/api/migrations/2026-07-12-signup-attribution-columns.sql`

**Interfaces:**
- Produces: `partners.signupIp`, `partners.signupUserAgent`, `devices.enrollmentIp` Drizzle columns used by Tasks 2, 3, 8.

- [ ] **Step 1: Add columns to the Drizzle schema**

In `apps/api/src/db/schema/orgs.ts`, directly after the `mcpOriginUserAgent` line inside `partners`:

```ts
  // Signup attribution for web registrations (abuse detection). MCP-originated
  // signups already record mcp_origin_ip/mcp_origin_user_agent above.
  signupIp: varchar('signup_ip', { length: 45 }),
  signupUserAgent: text('signup_user_agent'),
```

In `apps/api/src/db/schema/devices.ts`, directly after the `lastSeenIp` line inside `devices`:

```ts
  // Public IP the agent enrolled from (point-in-time; lastSeenIp above tracks
  // the ongoing value). Feeds the abuse-signals sweep's IP-spread heuristics.
  enrollmentIp: varchar('enrollment_ip', { length: 45 }),
```

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-07-12-signup-attribution-columns.sql`:

```sql
-- Signup/enrollment attribution columns for abuse detection.
-- Nullable; existing rows stay NULL. Idempotent.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS signup_ip varchar(45);
ALTER TABLE partners ADD COLUMN IF NOT EXISTS signup_user_agent text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS enrollment_ip varchar(45);
```

- [ ] **Step 3: Verify migrations apply cleanly**

Run: `cd apps/api && DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift`
Expected: exits 0, one ledger row per migration file including the new one.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/orgs.ts apps/api/src/db/schema/devices.ts apps/api/migrations/2026-07-12-signup-attribution-columns.sql
git commit -m "feat(abuse): signup/enrollment attribution columns"
```

---

### Task 2: Persist signup IP/UA at partner registration

**Files:**
- Modify: `apps/api/src/services/partnerCreate.ts` (input type ~line 21, insert values ~line 75)
- Modify: `apps/api/src/routes/auth/register.ts` (createPartner call ~line 191)
- Test: `apps/api/src/routes/auth/register.test.ts`

**Interfaces:**
- Consumes: `partners.signupIp` / `partners.signupUserAgent` (Task 1).
- Produces: `CreatePartnerInput.origin` non-MCP arm becomes `{ mcp: false; ip?: string; userAgent?: string }`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/routes/auth/register.test.ts` (inside the existing register-partner describe block; `getTrustedClientIpOrUndefined` is already mocked to `'127.0.0.1'` at the top of the file):

```ts
  it('threads signup IP and user agent into createPartner', async () => {
    process.env.IS_HOSTED = 'true';
    setupDbSelectsForSuccess(true);

    const res = await postRegisterPartner(validBody, { 'user-agent': 'vitest-agent/1.0' });
    expect(res.status).toBeLessThan(400);
    expect(createPartner).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: { mcp: false, ip: '127.0.0.1', userAgent: 'vitest-agent/1.0' },
      }),
    );
  });
```

If the existing `postRegisterPartner` helper (register.test.ts ~line 120) doesn't accept extra headers, extend it:

```ts
function postRegisterPartner(body: unknown, headers: Record<string, string> = {}) {
  return registerRoutes.request('/register-partner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/auth/register.test.ts -t "threads signup IP"`
Expected: FAIL — `createPartner` called with `origin: { mcp: false }` (no ip/userAgent).

- [ ] **Step 3: Extend CreatePartnerInput and the insert**

In `apps/api/src/services/partnerCreate.ts`, change the `origin` arm of `CreatePartnerInput`:

```ts
  origin:
    | { mcp: false; ip?: string; userAgent?: string }
    | { mcp: true; ip?: string; userAgent?: string };
```

In the `.insert(partners).values({...})` block, after the `mcpOriginUserAgent` line add:

```ts
        signupIp: !mcpOrigin ? (input.origin as { ip?: string }).ip ?? null : null,
        signupUserAgent: !mcpOrigin ? (input.origin as { userAgent?: string }).userAgent ?? null : null,
```

- [ ] **Step 4: Pass IP/UA from the register handler**

In `apps/api/src/routes/auth/register.ts`, the handler already imports `getTrustedClientIpOrUndefined` (line 25). Change the `createPartner` call:

```ts
      const result = await createPartner({
        orgName: companyName,
        adminEmail: email,
        adminName: name,
        passwordHash,
        origin: {
          mcp: false,
          ip: getTrustedClientIpOrUndefined(c),
          userAgent: c.req.header('user-agent'),
        },
        status: isHosted() ? 'pending' : 'active',
      });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/auth/register.test.ts src/services/partnerCreate.test.ts`
Expected: PASS (all — the existing partnerCreate tests must still pass with the widened origin type; if any construct `origin: { mcp: false }` they remain valid since the new fields are optional).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/partnerCreate.ts apps/api/src/routes/auth/register.ts apps/api/src/routes/auth/register.test.ts
git commit -m "feat(abuse): persist signup IP and user agent on partner registration"
```

---

### Task 3: Persist enrollment IP on both enroll paths

**Files:**
- Modify: `apps/api/src/routes/agents/enrollment.ts` (fresh INSERT ~line 631, re-enroll UPDATE ~line 600)
- Test: `apps/api/src/routes/agents/enrollment.test.ts`

**Interfaces:**
- Consumes: `devices.enrollmentIp` (Task 1); `clientIp` already in scope in the handler (line 77, `getTrustedClientIp(c, 'unknown')`).

- [ ] **Step 1: Update the schema mock stub**

`enrollment.test.ts` stubs the schema module (~lines 35-60). Add `enrollmentIp: 'enrollment_ip'` (matching the stub's existing column-map style) to the `devices` stub — without this the route module crashes on import once the route references the column.

- [ ] **Step 2: Write the failing test**

Add to `enrollment.test.ts`, following the file's existing success-path test (which mocks `db.transaction` and the select chain — reuse the same helpers that test uses):

```ts
  it('persists the enrolling client IP on the new device row', async () => {
    const insertValuesSpy = setupSuccessfulEnrollTransaction(); // reuse/extract the file's existing success-path tx mock so the insert's .values() arg is captured
    const resp = await buildApp().request('/agents/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(baseEnrollBody),
    });
    expect(resp.status).toBe(200);
    expect(insertValuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentIp: '127.0.0.1' }),
    );
  });
```

(`getTrustedClientIp` is already mocked to `'127.0.0.1'` at the top of the file. If the file's existing success-path mock doesn't expose the insert `.values()` spy, extract it into a `setupSuccessfulEnrollTransaction()` helper returning the spy — a mechanical refactor of the existing inline mock.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/agents/enrollment.test.ts -t "persists the enrolling client IP"`
Expected: FAIL — `.values()` called without `enrollmentIp`.

- [ ] **Step 4: Write the implementation**

In `apps/api/src/routes/agents/enrollment.ts`, near the top of the handler after `clientIp` is computed (line 77):

```ts
  // 'unknown' is the rate-limiter fallback, not a real address — store NULL.
  const enrollmentIp = clientIp === 'unknown' ? null : clientIp;
```

Add `enrollmentIp,` to BOTH device write paths inside the transaction:
- the fresh `tx.insert(devices).values({...})` block (~line 633): after `hostname: data.hostname,` add `enrollmentIp,`
- the re-enrollment `tx.update(devices).set({...})` block (~line 602): after `agentId: agentId,` add `enrollmentIp,` (a re-enrollment is a fresh install; refreshing the origin IP is correct).

- [ ] **Step 5: Run the full enrollment suite**

Run: `cd apps/api && npx vitest run src/routes/agents/enrollment.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/enrollment.ts apps/api/src/routes/agents/enrollment.test.ts
git commit -m "feat(abuse): persist client IP at agent enrollment"
```

---

**PR 1 boundary.** Tasks 1-3 are independently shippable (`gh pr create` from this branch or a stacked branch per the repo's squash-stack workflow). Tasks 4+ can proceed immediately; only the geo PR needs capture data to have accrued.

---

### Task 4: `partner_abuse_signals` table (schema, migration, RLS registration, forge suite)

**Files:**
- Create: `apps/api/src/db/schema/abuseSignals.ts`
- Modify: `apps/api/src/db/schema/index.ts` (append export)
- Create: `apps/api/migrations/2026-07-13-partner-abuse-signals.sql`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`EXEMPT_TABLES` ~line 43, `INTENTIONAL_UNSCOPED` ~line 59, new forge describe block next to the `manifest_signing_keys` suite ~line 1278)

**Interfaces:**
- Produces: `partnerAbuseSignals` Drizzle table + `abuseSignalSeverityEnum`, consumed by Tasks 8, 9, 10.

- [ ] **Step 1: Create the schema file**

`apps/api/src/db/schema/abuseSignals.ts`:

```ts
import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum, real, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { partners } from './orgs';

export const abuseSignalSeverityEnum = pgEnum('abuse_signal_severity', ['info', 'watch', 'alert']);

// Platform-operator abuse signals ABOUT partners — never visible TO partners.
// RLS is a system-only policy (see the migration); all reads/writes happen
// under withSystemDbAccessContext. Do NOT add breeze_has_partner_access
// policies to this table.
export const partnerAbuseSignals = pgTable('partner_abuse_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id, { onDelete: 'cascade' }),
  signalKey: varchar('signal_key', { length: 64 }).notNull(),
  severity: abuseSignalSeverityEnum('severity').notNull(),
  score: real('score').notNull().default(0),
  evidence: jsonb('evidence').notNull().default({}),
  firstFiredAt: timestamp('first_fired_at', { withTimezone: true }).defaultNow().notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedBy: varchar('acknowledged_by', { length: 255 }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
}, (t) => [
  // One OPEN row per (partner, signal); resolved rows keep history.
  uniqueIndex('partner_abuse_signals_open_uq').on(t.partnerId, t.signalKey).where(sql`resolved_at IS NULL`),
  index('partner_abuse_signals_partner_idx').on(t.partnerId),
]);
```

Append to `apps/api/src/db/schema/index.ts`:

```ts
export * from './abuseSignals';
```

- [ ] **Step 2: Write the migration**

`apps/api/migrations/2026-07-13-partner-abuse-signals.sql` (copies the `2026-05-09-manifest-signing-keys.sql` system-only pattern):

```sql
-- Platform-operator abuse signals about partners. System-scoped: forced RLS
-- with a system-only policy — partners must never read signals about
-- themselves. All access via withSystemDbAccessContext. Idempotent.

DO $$ BEGIN
  CREATE TYPE abuse_signal_severity AS ENUM ('info', 'watch', 'alert');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS partner_abuse_signals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  signal_key      varchar(64) NOT NULL,
  severity        abuse_signal_severity NOT NULL,
  score           real NOT NULL DEFAULT 0,
  evidence        jsonb NOT NULL DEFAULT '{}',
  first_fired_at  timestamptz NOT NULL DEFAULT now(),
  computed_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by varchar(255),
  delivered_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_abuse_signals_open_uq
  ON partner_abuse_signals(partner_id, signal_key)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS partner_abuse_signals_partner_idx
  ON partner_abuse_signals(partner_id);

ALTER TABLE partner_abuse_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_abuse_signals FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'partner_abuse_signals'
      AND policyname = 'partner_abuse_signals_system_only'
  ) THEN
    EXECUTE $POLICY$
      CREATE POLICY partner_abuse_signals_system_only
        ON partner_abuse_signals
        USING (current_setting('breeze.scope', true) = 'system')
        WITH CHECK (current_setting('breeze.scope', true) = 'system')
    $POLICY$;
  END IF;
END$$;
```

- [ ] **Step 3: Register in the RLS contract test**

In `rls-coverage.integration.test.ts` add to `EXEMPT_TABLES`:

```ts
  'partner_abuse_signals',
```

and to `INTENTIONAL_UNSCOPED`:

```ts
  'partner_abuse_signals', // Operator abuse signals ABOUT partners. Forced RLS, system-only policy — partners must never see their own risk signals.
```

- [ ] **Step 4: Write the forge suite (failing until migration applies)**

Clone the adjacent `describe('manifest_signing_keys RLS — system-only enforcement (#639)', ...)` block (~line 1278) as a new describe in the same file, reusing its context helpers verbatim, with these cases:

1. INSERT as `breeze_app` under a tenant (partner-scoped) context → rejects with `/row-level security|permission denied/`.
2. Seed one row via `withSystemDbAccessContext`, then SELECT under a partner context **whose partnerId matches the row's partner_id** → zero rows (the specific threat: a partner reading its own signals).
3. `withSystemDbAccessContext` INSERT + SELECT round-trips successfully.

- [ ] **Step 5: Run migration check and the forge suite**

Run: `cd apps/api && DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift`
Expected: exits 0.
Run the integration config against the integration DB (port 5433, per repo convention): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS including the three new cases. (Beware the memoized-fixture and `.env.test` BYPASSRLS traps — the forge test must run as `breeze_app`.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/abuseSignals.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-07-13-partner-abuse-signals.sql apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(abuse): partner_abuse_signals table with system-only RLS"
```

---

### Task 5: Signal config with env overrides

**Files:**
- Create: `apps/api/src/services/abuseSignals/config.ts`
- Create: `apps/api/src/services/abuseSignals/types.ts`
- Test: `apps/api/src/services/abuseSignals/config.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `type AbuseSeverity = 'info' | 'watch' | 'alert'`; `interface ComputedSignal { partnerId: string; signalKey: string; score: number; severity: AbuseSeverity; evidence: Record<string, unknown>; }`
  - `config.ts`: `SIGNAL_DEFAULTS: Record<string, number>`, `loadSignalConfig(): Record<string, number>`, `scoreToSeverity(score, cfg): AbuseSeverity`, `youngWeight(partnerCreatedAt: Date, now: Date, cfg): number`

- [ ] **Step 1: Create types.ts**

```ts
export type AbuseSeverity = 'info' | 'watch' | 'alert';

export interface ComputedSignal {
  partnerId: string;
  signalKey: string;
  /** 0-100 after young-account weighting. */
  score: number;
  severity: AbuseSeverity;
  evidence: Record<string, unknown>;
}
```

- [ ] **Step 2: Write the failing tests**

`config.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadSignalConfig, SIGNAL_DEFAULTS, scoreToSeverity, youngWeight } from './config';

afterEach(() => {
  delete process.env.ABUSE_SIGNAL_OVERRIDES;
  vi.restoreAllMocks();
});

describe('loadSignalConfig', () => {
  it('returns defaults when ABUSE_SIGNAL_OVERRIDES is unset', () => {
    expect(loadSignalConfig()).toEqual(SIGNAL_DEFAULTS);
  });

  it('merges known override keys', () => {
    process.env.ABUSE_SIGNAL_OVERRIDES = '{"rmm.enrollment_velocity.devices_24h": 25}';
    expect(loadSignalConfig()['rmm.enrollment_velocity.devices_24h']).toBe(25);
  });

  it('warns and ignores unknown keys and non-numeric values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_SIGNAL_OVERRIDES = '{"nope.unknown": 1, "severity.alert_score": "high"}';
    const cfg = loadSignalConfig();
    expect(cfg['severity.alert_score']).toBe(SIGNAL_DEFAULTS['severity.alert_score']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns and returns defaults on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_SIGNAL_OVERRIDES = '{not json';
    expect(loadSignalConfig()).toEqual(SIGNAL_DEFAULTS);
    expect(warn).toHaveBeenCalled();
  });
});

describe('scoreToSeverity', () => {
  const cfg = SIGNAL_DEFAULTS;
  it('maps score bands', () => {
    expect(scoreToSeverity(75, cfg)).toBe('alert');
    expect(scoreToSeverity(45, cfg)).toBe('watch');
    expect(scoreToSeverity(5, cfg)).toBe('info');
  });
});

describe('youngWeight', () => {
  const cfg = SIGNAL_DEFAULTS;
  const now = new Date('2026-07-15T00:00:00Z');
  it('is 1.0 under 30 days, 0 at 90+, linear between', () => {
    expect(youngWeight(new Date('2026-07-01T00:00:00Z'), now, cfg)).toBe(1);
    expect(youngWeight(new Date('2026-04-01T00:00:00Z'), now, cfg)).toBe(0);
    const w = youngWeight(new Date('2026-05-16T00:00:00Z'), now, cfg); // 60 days old
    expect(w).toBeCloseTo(0.5, 1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement config.ts**

```ts
import type { AbuseSeverity } from './types';

/**
 * Published defaults. Production deployments may diverge via the
 * ABUSE_SIGNAL_OVERRIDES env var (JSON map of key -> number) so adversaries
 * reading this public repo do not learn the live thresholds.
 */
export const SIGNAL_DEFAULTS: Record<string, number> = {
  'sweep.young_full_weight_days': 30,
  'sweep.young_zero_weight_days': 90,
  'severity.watch_score': 40,
  'severity.alert_score': 70,
  'rmm.consumer_devices.min_devices': 5,
  'rmm.consumer_devices.watch_ratio': 0.6,
  'rmm.enrollment_velocity.devices_24h': 10,
  'rmm.session_intensity.fast_remote_count_7d': 3,
  'rmm.session_intensity.sessions_per_device_7d': 5,
  'rmm.enrollment_ip_spread.min_devices': 8,
  'rmm.enrollment_ip_spread.distinct_ratio': 0.8,
  'fraud.failed_login_cluster.count_24h': 20,
  'resource.enrollment_denied.count_24h': 20,
  'resource.volume_outlier.commands_24h': 500,
  'resource.volume_outlier.scripts_24h': 200,
};

export function loadSignalConfig(): Record<string, number> {
  const raw = process.env.ABUSE_SIGNAL_OVERRIDES;
  if (!raw) return { ...SIGNAL_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[AbuseSignals] ABUSE_SIGNAL_OVERRIDES is not valid JSON — using defaults');
    return { ...SIGNAL_DEFAULTS };
  }
  const cfg = { ...SIGNAL_DEFAULTS };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(key in SIGNAL_DEFAULTS)) {
        console.warn(`[AbuseSignals] Unknown override key ignored: ${key}`);
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        console.warn(`[AbuseSignals] Non-numeric override ignored: ${key}`);
        continue;
      }
      cfg[key] = value;
    }
  }
  return cfg;
}

export function scoreToSeverity(score: number, cfg: Record<string, number>): AbuseSeverity {
  if (score >= cfg['severity.alert_score']) return 'alert';
  if (score >= cfg['severity.watch_score']) return 'watch';
  return 'info';
}

/** 1.0 for partners younger than young_full_weight_days, linearly decaying to 0 at young_zero_weight_days. */
export function youngWeight(partnerCreatedAt: Date, now: Date, cfg: Record<string, number>): number {
  const ageDays = (now.getTime() - partnerCreatedAt.getTime()) / 86_400_000;
  const full = cfg['sweep.young_full_weight_days'];
  const zero = cfg['sweep.young_zero_weight_days'];
  if (ageDays <= full) return 1;
  if (ageDays >= zero) return 0;
  return (zero - ageDays) / (zero - full);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/abuseSignals/
git commit -m "feat(abuse): signal config with env-overridable thresholds"
```

---

### Task 6: opsAlerts service + Prometheus counters + env docs

**Files:**
- Create: `apps/api/src/services/opsAlerts.ts`
- Test: `apps/api/src/services/opsAlerts.test.ts`
- Create: `apps/api/src/services/abuseMetrics.ts`
- Modify: `apps/api/src/routes/metrics.ts` (counters near ~line 256, recorder registration near ~line 616)
- Modify: `apps/api/.env.example` (or root `.env.example` — wherever OPS-facing vars live; use generic placeholders)
- Modify: `docker-compose.yml` (api service `environment:` block — pass-through mappings)

**Interfaces:**
- Produces:
  - `sendOpsAlert(msg: { title: string; body: string }): Promise<boolean>` — true if ≥1 channel delivered.
  - `isOpsAlertingConfigured(): boolean`
  - `recordAbuseSignalFired(severity: string): void`, `recordAbuseSweepRun(result: 'success' | 'error'): void` (thin recorder, mirroring `anomalyMetrics.ts`).

- [ ] **Step 1: Write the failing tests**

`opsAlerts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./urlSafety', () => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));
vi.mock('./email', () => ({ getEmailService: vi.fn(() => null) }));

import { safeFetch } from './urlSafety';
import { getEmailService } from './email';
import { sendOpsAlert, isOpsAlertingConfigured } from './opsAlerts';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPS_ALERT_WEBHOOK_URL = 'https://discord.example.com/api/webhooks/x/y';
  delete process.env.OPS_ALERT_EMAIL;
  delete process.env.OPS_ALERT_LABEL;
});
afterEach(() => {
  delete process.env.OPS_ALERT_WEBHOOK_URL;
});

describe('sendOpsAlert', () => {
  it('POSTs Discord-format content and returns true on 2xx', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 204 }));
    const ok = await sendOpsAlert({ title: 'Test alert', body: 'evidence here' });
    expect(ok).toBe(true);
    const [url, init] = vi.mocked(safeFetch).mock.calls[0];
    expect(url).toBe(process.env.OPS_ALERT_WEBHOOK_URL);
    expect(JSON.parse(init!.body as string).content).toContain('Test alert');
  });

  it('prefixes the title with OPS_ALERT_LABEL when set', async () => {
    process.env.OPS_ALERT_LABEL = 'US';
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 204 }));
    await sendOpsAlert({ title: 'Test', body: 'b' });
    const [, init] = vi.mocked(safeFetch).mock.calls[0];
    expect(JSON.parse(init!.body as string).content).toContain('[US]');
  });

  it('truncates content to Discord 2000-char limit', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 204 }));
    await sendOpsAlert({ title: 'T', body: 'x'.repeat(3000) });
    const [, init] = vi.mocked(safeFetch).mock.calls[0];
    expect(JSON.parse(init!.body as string).content.length).toBeLessThanOrEqual(2000);
  });

  it('returns false when no channel is configured, warning once', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await sendOpsAlert({ title: 'T', body: 'b' })).toBe(false);
    expect(safeFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('returns false on webhook failure and does not throw', async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error('network down'));
    expect(await sendOpsAlert({ title: 'T', body: 'b' })).toBe(false);
  });

  it('falls back to email channel when configured', async () => {
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    process.env.OPS_ALERT_EMAIL = 'ops@example.com';
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getEmailService).mockReturnValue({ sendEmail } as never);
    expect(await sendOpsAlert({ title: 'T', body: 'b' })).toBe(true);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.com' }));
  });
});

describe('isOpsAlertingConfigured', () => {
  it('reflects env state', () => {
    expect(isOpsAlertingConfigured()).toBe(true);
    delete process.env.OPS_ALERT_WEBHOOK_URL;
    expect(isOpsAlertingConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/opsAlerts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement opsAlerts.ts**

```ts
import { safeFetch } from './urlSafety';
import { getEmailService } from './email';
import { captureException } from './sentry';

export interface OpsAlertMessage {
  title: string;
  body: string;
}

const DISCORD_CONTENT_LIMIT = 2000;
const WEBHOOK_TIMEOUT_MS = 10_000;
let warnedUnconfigured = false;

export function isOpsAlertingConfigured(): boolean {
  return Boolean(process.env.OPS_ALERT_WEBHOOK_URL || process.env.OPS_ALERT_EMAIL);
}

function formatContent(msg: OpsAlertMessage): string {
  const label = process.env.OPS_ALERT_LABEL?.trim();
  const title = label ? `[${label}] ${msg.title}` : msg.title;
  return `**${title}**\n${msg.body}`.slice(0, DISCORD_CONTENT_LIMIT);
}

async function sendWebhook(url: string, msg: OpsAlertMessage): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    const response = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Breeze-RMM/1.0' },
      body: JSON.stringify({ content: formatContent(msg) }),
      signal: controller.signal,
      redirect: 'error',
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      console.error(`[OpsAlerts] Webhook responded ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('[OpsAlerts] Webhook delivery failed:', error instanceof Error ? error.message : error);
    captureException(error);
    return false;
  }
}

async function sendOpsEmail(to: string, msg: OpsAlertMessage): Promise<boolean> {
  const email = getEmailService();
  if (!email) {
    console.warn('[OpsAlerts] OPS_ALERT_EMAIL set but email service not configured');
    return false;
  }
  try {
    await email.sendEmail({
      to,
      subject: `[Breeze ops] ${msg.title}`,
      text: msg.body,
      html: `<pre>${msg.body.replace(/</g, '&lt;')}</pre>`,
    });
    return true;
  } catch (error) {
    console.error('[OpsAlerts] Email delivery failed:', error instanceof Error ? error.message : error);
    captureException(error);
    return false;
  }
}

/** Delivers to every configured channel; true if at least one succeeded. Never throws. */
export async function sendOpsAlert(msg: OpsAlertMessage): Promise<boolean> {
  const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL?.trim();
  const emailTo = process.env.OPS_ALERT_EMAIL?.trim();
  if (!webhookUrl && !emailTo) {
    if (!warnedUnconfigured) {
      console.warn('[OpsAlerts] No OPS_ALERT_WEBHOOK_URL or OPS_ALERT_EMAIL configured — ops alerts disabled');
      warnedUnconfigured = true;
    }
    return false;
  }
  const results = await Promise.all([
    webhookUrl ? sendWebhook(webhookUrl, msg) : Promise.resolve(false),
    emailTo ? sendOpsEmail(emailTo, msg) : Promise.resolve(false),
  ]);
  return results.some(Boolean);
}
```

- [ ] **Step 4: Create abuseMetrics.ts (thin recorder, mirrors anomalyMetrics.ts)**

```ts
type AbuseMetricsRecorder = {
  onSignalFired: (severity: string) => void;
  onSweepRun: (result: 'success' | 'error') => void;
};

const noop = () => {};
let recorder: AbuseMetricsRecorder = { onSignalFired: noop, onSweepRun: noop };

export function setAbuseMetricsRecorder(next: Partial<AbuseMetricsRecorder> | null | undefined): void {
  recorder = {
    onSignalFired: next?.onSignalFired ?? noop,
    onSweepRun: next?.onSweepRun ?? noop,
  };
}

export function recordAbuseSignalFired(severity: string): void {
  recorder.onSignalFired(severity);
}

export function recordAbuseSweepRun(result: 'success' | 'error'): void {
  recorder.onSweepRun(result);
}
```

- [ ] **Step 5: Register counters in metrics.ts**

Next to the existing anomaly counters (~line 256), following the same shape:

```ts
const abuseSignalsFiredTotal = new Counter({
  name: 'breeze_abuse_signals_fired_total',
  help: 'Abuse signals fired by the sweep, by severity',
  labelNames: ['severity'] as const,
  registers: [register]
});
const abuseSweepRunsTotal = new Counter({
  name: 'breeze_abuse_sweep_runs_total',
  help: 'Abuse sweep job runs by result',
  labelNames: ['result'] as const,
  registers: [register]
});
```

Warm-up zero-incs next to the existing ones (~line 304): `abuseSignalsFiredTotal.labels('alert').inc(0); abuseSweepRunsTotal.labels('success').inc(0);`

Recorder registration next to `setAnomalyMetricsRecorder` (~line 616):

```ts
setAbuseMetricsRecorder({
  onSignalFired: (severity) => abuseSignalsFiredTotal.labels(normalizeMetricLabel(severity, 'unknown')).inc(),
  onSweepRun: (result) => abuseSweepRunsTotal.labels(result).inc(),
});
```

(Import `setAbuseMetricsRecorder` from `../services/abuseMetrics` alongside the anomaly import.)

- [ ] **Step 6: Env documentation + compose mapping**

Add to the `.env.example` used by the API (generic placeholders only):

```bash
# Platform-operator abuse alerts (all optional; unset = feature disabled)
# OPS_ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook
# OPS_ALERT_EMAIL=ops@your-domain.example.com
# OPS_ALERT_LABEL=US
# ABUSE_SIGNAL_OVERRIDES={"rmm.enrollment_velocity.devices_24h": 25}
```

Add pass-through mappings to the `api` service `environment:` block in `docker-compose.yml` (compose only interpolates vars listed there):

```yaml
      OPS_ALERT_WEBHOOK_URL: ${OPS_ALERT_WEBHOOK_URL:-}
      OPS_ALERT_EMAIL: ${OPS_ALERT_EMAIL:-}
      OPS_ALERT_LABEL: ${OPS_ALERT_LABEL:-}
      ABUSE_SIGNAL_OVERRIDES: ${ABUSE_SIGNAL_OVERRIDES:-}
```

- [ ] **Step 7: Run tests**

Run: `cd apps/api && npx vitest run src/services/opsAlerts.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/opsAlerts.ts apps/api/src/services/opsAlerts.test.ts apps/api/src/services/abuseMetrics.ts apps/api/src/routes/metrics.ts docker-compose.yml
git add -A -- '*.env.example'
git commit -m "feat(abuse): opsAlerts platform-operator channel + sweep metrics"
```

---

### Task 7: Invariant signals

**Files:**
- Create: `apps/api/src/services/abuseSignals/invariants.ts`
- Test: `apps/api/src/services/abuseSignals/invariants.test.ts`

**Interfaces:**
- Consumes: `ComputedSignal` (Task 5).
- Produces: `computeInvariantSignals(): Promise<ComputedSignal[]>` — caller is responsible for running it inside a system DB context.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
}));

import { db } from '../../db';
import { computeInvariantSignals } from './invariants';

beforeEach(() => vi.clearAllMocks());

describe('computeInvariantSignals', () => {
  it('emits alert signals for each invariant breach', async () => {
    vi.mocked(db.execute)
      // active_unverified_email
      .mockResolvedValueOnce([{ id: 'p1', name: 'Acme', created_at: '2026-07-01' }] as never)
      // active_no_payment
      .mockResolvedValueOnce([] as never)
      // inactive_partner_with_agents
      .mockResolvedValueOnce([{ id: 'p2', name: 'Bad Co', status: 'suspended', device_count: '4' }] as never);

    const signals = await computeInvariantSignals();
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      partnerId: 'p1',
      signalKey: 'invariant.active_unverified_email',
      severity: 'alert',
      score: 100,
    });
    expect(signals[1]).toMatchObject({
      partnerId: 'p2',
      signalKey: 'invariant.inactive_partner_with_agents',
      severity: 'alert',
      evidence: expect.objectContaining({ deviceCount: 4, partnerStatus: 'suspended' }),
    });
  });

  it('returns empty when all invariants hold', async () => {
    vi.mocked(db.execute).mockResolvedValue([] as never);
    expect(await computeInvariantSignals()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/invariants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement invariants.ts**

```ts
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import type { ComputedSignal } from './types';

// Activation invariants — conditions the signup gate makes impossible, so any
// hit means gate drift (deploy lag, manual SQL, a new bypass). Suppression of
// reviewed/grandfathered accounts happens via acknowledged_at in persistence,
// NEVER via allowlists here (public repo: no tenant identifiers in code).
// MUST run inside a system DB context — bare breeze_app reads return 0 rows.
export async function computeInvariantSignals(): Promise<ComputedSignal[]> {
  const signals: ComputedSignal[] = [];

  const unverified = (await db.execute(sql`
    SELECT id, name, created_at FROM partners
    WHERE status = 'active' AND email_verified_at IS NULL AND deleted_at IS NULL
  `)) as unknown as Array<{ id: string; name: string; created_at: string }>;
  for (const p of unverified) {
    signals.push({
      partnerId: p.id,
      signalKey: 'invariant.active_unverified_email',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: p.name, partnerCreatedAt: p.created_at },
    });
  }

  const unpaid = (await db.execute(sql`
    SELECT id, name, created_at FROM partners
    WHERE status = 'active' AND payment_method_attached_at IS NULL AND deleted_at IS NULL
  `)) as unknown as Array<{ id: string; name: string; created_at: string }>;
  for (const p of unpaid) {
    signals.push({
      partnerId: p.id,
      signalKey: 'invariant.active_no_payment',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: p.name, partnerCreatedAt: p.created_at },
    });
  }

  const inactiveWithAgents = (await db.execute(sql`
    SELECT p.id, p.name, p.status, COUNT(d.id) AS device_count
    FROM partners p
    JOIN organizations o ON o.partner_id = p.id
    JOIN devices d ON d.org_id = o.id
    WHERE p.status IN ('pending', 'suspended')
      AND d.status NOT IN ('decommissioned', 'quarantined')
    GROUP BY p.id, p.name, p.status
  `)) as unknown as Array<{ id: string; name: string; status: string; device_count: string }>;
  for (const p of inactiveWithAgents) {
    signals.push({
      partnerId: p.id,
      signalKey: 'invariant.inactive_partner_with_agents',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: p.name, partnerStatus: p.status, deviceCount: Number(p.device_count) },
    });
  }

  return signals;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/invariants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/abuseSignals/invariants.ts apps/api/src/services/abuseSignals/invariants.test.ts
git commit -m "feat(abuse): activation invariant signals"
```

---

### Task 8: Heuristic signals (aggregates loader + pure scoring)

**Files:**
- Create: `apps/api/src/services/abuseSignals/heuristics.ts`
- Test: `apps/api/src/services/abuseSignals/heuristics.test.ts`

**Interfaces:**
- Consumes: `ComputedSignal`, `scoreToSeverity`, `youngWeight`, config keys (Task 5); `devices.enrollment_ip` (Task 1).
- Produces:
  - `interface PartnerAggregates { partnerId: string; partnerName: string; partnerCreatedAt: Date; deviceCount: number; consumerHostnameCount: number; enrolled24h: number; distinctEnrollmentIps30d: number; devicesEnrolled30d: number; sessions7d: number; fastRemoteSessions7d: number; failedLogins24h: number; enrollmentDenied24h: number; commands24h: number; scriptExecutions24h: number; }`
  - `loadPartnerAggregates(): Promise<PartnerAggregates[]>` (system-context caller)
  - `computeHeuristicSignals(aggs: PartnerAggregates[], cfg: Record<string, number>, now: Date): ComputedSignal[]` (pure)

- [ ] **Step 1: Write the failing tests for the pure scorer**

```ts
import { describe, it, expect } from 'vitest';
import { computeHeuristicSignals, type PartnerAggregates } from './heuristics';
import { SIGNAL_DEFAULTS } from './config';

const now = new Date('2026-07-15T00:00:00Z');

function agg(overrides: Partial<PartnerAggregates>): PartnerAggregates {
  return {
    partnerId: 'p1',
    partnerName: 'Acme',
    partnerCreatedAt: new Date('2026-07-10T00:00:00Z'), // 5 days old → full weight
    deviceCount: 0,
    consumerHostnameCount: 0,
    enrolled24h: 0,
    distinctEnrollmentIps30d: 0,
    devicesEnrolled30d: 0,
    sessions7d: 0,
    fastRemoteSessions7d: 0,
    failedLogins24h: 0,
    enrollmentDenied24h: 0,
    commands24h: 0,
    scriptExecutions24h: 0,
    ...overrides,
  };
}

describe('computeHeuristicSignals', () => {
  it('emits nothing for a quiet partner', () => {
    expect(computeHeuristicSignals([agg({})], SIGNAL_DEFAULTS, now)).toEqual([]);
  });

  it('fires consumer_devices when ratio and fleet size exceed thresholds', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 10, consumerHostnameCount: 9 })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.consumer_devices');
    expect(s).toBeDefined();
    expect(s!.evidence).toMatchObject({ deviceCount: 10, consumerHostnameCount: 9 });
    expect(s!.score).toBeGreaterThan(0);
  });

  it('fires enrollment_velocity on a 24h burst', () => {
    const signals = computeHeuristicSignals([agg({ enrolled24h: 30, deviceCount: 30 })], SIGNAL_DEFAULTS, now);
    expect(signals.some((x) => x.signalKey === 'rmm.enrollment_velocity')).toBe(true);
  });

  it('weighs fast enroll-to-remote sessions heavily', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 5, sessions7d: 12, fastRemoteSessions7d: 5 })],
      SIGNAL_DEFAULTS,
      now,
    );
    const s = signals.find((x) => x.signalKey === 'rmm.session_intensity');
    expect(s).toBeDefined();
    expect(s!.severity).toBe('alert');
  });

  it('fires enrollment_ip_spread when nearly every device came from a distinct IP', () => {
    const signals = computeHeuristicSignals(
      [agg({ deviceCount: 10, devicesEnrolled30d: 10, distinctEnrollmentIps30d: 10 })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'rmm.enrollment_ip_spread')).toBe(true);
  });

  it('decays scores for old partners (zero weight at 90+ days)', () => {
    const signals = computeHeuristicSignals(
      [agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), deviceCount: 10, consumerHostnameCount: 10 })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals).toEqual([]); // weight 0 → score 0 → not emitted
  });

  it('does not decay fraud/resource signals', () => {
    const signals = computeHeuristicSignals(
      [agg({ partnerCreatedAt: new Date('2026-01-01T00:00:00Z'), failedLogins24h: 100 })],
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signals.some((x) => x.signalKey === 'fraud.failed_login_cluster')).toBe(true);
  });

  it('fires enrollment_denied on repeated cap/key rejections', () => {
    const signals = computeHeuristicSignals([agg({ enrollmentDenied24h: 40 })], SIGNAL_DEFAULTS, now);
    expect(signals.some((x) => x.signalKey === 'resource.enrollment_denied')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/heuristics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement heuristics.ts**

```ts
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { scoreToSeverity, youngWeight } from './config';
import type { ComputedSignal } from './types';

export interface PartnerAggregates {
  partnerId: string;
  partnerName: string;
  partnerCreatedAt: Date;
  deviceCount: number;
  consumerHostnameCount: number;
  enrolled24h: number;
  distinctEnrollmentIps30d: number;
  devicesEnrolled30d: number;
  sessions7d: number;
  fastRemoteSessions7d: number;
  failedLogins24h: number;
  enrollmentDenied24h: number;
  commands24h: number;
  scriptExecutions24h: number;
}

// Default Windows hostnames (DESKTOP-XXXXXXX / LAPTOP-XXXXXXX) mark unmanaged
// consumer machines — a legit MSP's fleet is mostly named/domain-joined.
const CONSUMER_HOSTNAME_SQL = `d.hostname ~* '^(DESKTOP|LAPTOP)-[A-Z0-9]{7}$'`;

/**
 * One fleet-grouped pass over young-or-recently-active partners.
 * MUST run inside a system DB context — bare breeze_app reads return 0 rows.
 */
export async function loadPartnerAggregates(): Promise<PartnerAggregates[]> {
  const rows = (await db.execute(sql.raw(`
    WITH scoped AS (
      SELECT p.id, p.name, p.created_at
      FROM partners p
      WHERE p.deleted_at IS NULL AND p.status = 'active'
        AND (
          p.created_at > now() - interval '90 days'
          OR EXISTS (
            SELECT 1 FROM organizations o JOIN devices d ON d.org_id = o.id
            WHERE o.partner_id = p.id AND d.enrolled_at > now() - interval '2 hours'
          )
        )
    ),
    dev AS (
      SELECT o.partner_id,
        COUNT(*) AS device_count,
        COUNT(*) FILTER (WHERE ${CONSUMER_HOSTNAME_SQL}) AS consumer_count,
        COUNT(*) FILTER (WHERE d.enrolled_at > now() - interval '24 hours') AS enrolled_24h,
        COUNT(DISTINCT d.enrollment_ip) FILTER (WHERE d.enrolled_at > now() - interval '30 days' AND d.enrollment_ip IS NOT NULL) AS distinct_enroll_ips_30d,
        COUNT(*) FILTER (WHERE d.enrolled_at > now() - interval '30 days' AND d.enrollment_ip IS NOT NULL) AS devices_enrolled_30d
      FROM devices d JOIN organizations o ON o.id = d.org_id
      WHERE d.status NOT IN ('decommissioned', 'quarantined')
      GROUP BY o.partner_id
    ),
    sess AS (
      SELECT o.partner_id,
        COUNT(*) AS sessions_7d,
        COUNT(*) FILTER (WHERE rs.created_at < d.enrolled_at + interval '24 hours') AS fast_remote_7d
      FROM remote_sessions rs
      JOIN devices d ON d.id = rs.device_id
      JOIN organizations o ON o.id = d.org_id
      WHERE rs.created_at > now() - interval '7 days'
      GROUP BY o.partner_id
    ),
    logins AS (
      SELECT o.partner_id, COUNT(*) AS failed_24h
      FROM audit_logs al JOIN organizations o ON o.id = al.org_id
      WHERE al.action = 'user.login.failed' AND al."timestamp" > now() - interval '24 hours'
      GROUP BY o.partner_id
    ),
    denied AS (
      SELECT o.partner_id, COUNT(*) AS denied_24h
      FROM audit_logs al JOIN organizations o ON o.id = al.org_id
      WHERE al.action = 'agent.enroll' AND al.result = 'denied'
        AND al."timestamp" > now() - interval '24 hours'
      GROUP BY o.partner_id
    ),
    cmds AS (
      SELECT o.partner_id, COUNT(*) AS commands_24h
      FROM device_commands dc
      JOIN devices d ON d.id = dc.device_id
      JOIN organizations o ON o.id = d.org_id
      WHERE dc.created_at > now() - interval '24 hours'
      GROUP BY o.partner_id
    ),
    scripts AS (
      SELECT o.partner_id, COUNT(*) AS scripts_24h
      FROM script_executions se JOIN organizations o ON o.id = se.org_id
      WHERE se.created_at > now() - interval '24 hours'
      GROUP BY o.partner_id
    )
    SELECT s.id, s.name, s.created_at,
      COALESCE(dev.device_count, 0) AS device_count,
      COALESCE(dev.consumer_count, 0) AS consumer_count,
      COALESCE(dev.enrolled_24h, 0) AS enrolled_24h,
      COALESCE(dev.distinct_enroll_ips_30d, 0) AS distinct_enroll_ips_30d,
      COALESCE(dev.devices_enrolled_30d, 0) AS devices_enrolled_30d,
      COALESCE(sess.sessions_7d, 0) AS sessions_7d,
      COALESCE(sess.fast_remote_7d, 0) AS fast_remote_7d,
      COALESCE(logins.failed_24h, 0) AS failed_24h,
      COALESCE(denied.denied_24h, 0) AS denied_24h,
      COALESCE(cmds.commands_24h, 0) AS commands_24h,
      COALESCE(scripts.scripts_24h, 0) AS scripts_24h
    FROM scoped s
    LEFT JOIN dev ON dev.partner_id = s.id
    LEFT JOIN sess ON sess.partner_id = s.id
    LEFT JOIN logins ON logins.partner_id = s.id
    LEFT JOIN denied ON denied.partner_id = s.id
    LEFT JOIN cmds ON cmds.partner_id = s.id
    LEFT JOIN scripts ON scripts.partner_id = s.id
  `))) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    partnerId: String(r.id),
    partnerName: String(r.name),
    partnerCreatedAt: new Date(String(r.created_at)),
    deviceCount: Number(r.device_count),
    consumerHostnameCount: Number(r.consumer_count),
    enrolled24h: Number(r.enrolled_24h),
    distinctEnrollmentIps30d: Number(r.distinct_enroll_ips_30d),
    devicesEnrolled30d: Number(r.devices_enrolled_30d),
    sessions7d: Number(r.sessions_7d),
    fastRemoteSessions7d: Number(r.fast_remote_7d),
    failedLogins24h: Number(r.failed_24h),
    enrollmentDenied24h: Number(r.denied_24h),
    commands24h: Number(r.commands_24h),
    scriptExecutions24h: Number(r.scripts_24h),
  }));
}

/** Pure scoring: no I/O, unit-testable. Scores are 0-100 pre-weighting. */
export function computeHeuristicSignals(
  aggs: PartnerAggregates[],
  cfg: Record<string, number>,
  now: Date,
): ComputedSignal[] {
  const signals: ComputedSignal[] = [];

  for (const a of aggs) {
    const weight = youngWeight(a.partnerCreatedAt, now, cfg);
    const push = (signalKey: string, rawScore: number, evidence: Record<string, unknown>, decays = true) => {
      const score = Math.min(100, Math.round(rawScore * (decays ? weight : 1)));
      if (score <= 0) return;
      signals.push({
        partnerId: a.partnerId,
        signalKey,
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: { partnerName: a.partnerName, ...evidence },
      });
    };

    // rmm.consumer_devices — ratio of throwaway-named consumer machines.
    if (a.deviceCount >= cfg['rmm.consumer_devices.min_devices']) {
      const ratio = a.consumerHostnameCount / a.deviceCount;
      if (ratio >= cfg['rmm.consumer_devices.watch_ratio']) {
        push('rmm.consumer_devices', ratio * 100, {
          deviceCount: a.deviceCount,
          consumerHostnameCount: a.consumerHostnameCount,
          ratio: Number(ratio.toFixed(2)),
        });
      }
    }

    // rmm.enrollment_velocity — burst enrollments in 24h.
    const velThreshold = cfg['rmm.enrollment_velocity.devices_24h'];
    if (a.enrolled24h >= velThreshold) {
      push('rmm.enrollment_velocity', Math.min(100, (a.enrolled24h / velThreshold) * 50), {
        enrolled24h: a.enrolled24h,
      });
    }

    // rmm.session_intensity — fast enroll-to-remote is the scammer fingerprint.
    const fastThreshold = cfg['rmm.session_intensity.fast_remote_count_7d'];
    const perDevice = a.deviceCount > 0 ? a.sessions7d / a.deviceCount : 0;
    if (a.fastRemoteSessions7d >= fastThreshold || perDevice >= cfg['rmm.session_intensity.sessions_per_device_7d']) {
      const fastScore = (a.fastRemoteSessions7d / fastThreshold) * 70;
      const volumeScore = (perDevice / cfg['rmm.session_intensity.sessions_per_device_7d']) * 40;
      push('rmm.session_intensity', Math.max(fastScore, volumeScore), {
        sessions7d: a.sessions7d,
        fastRemoteSessions7d: a.fastRemoteSessions7d,
        deviceCount: a.deviceCount,
      });
    }

    // rmm.enrollment_ip_spread — scattered origin IPs (residential-victim proxy until geo lands).
    if (a.devicesEnrolled30d >= cfg['rmm.enrollment_ip_spread.min_devices']) {
      const ratio = a.distinctEnrollmentIps30d / a.devicesEnrolled30d;
      if (ratio >= cfg['rmm.enrollment_ip_spread.distinct_ratio']) {
        push('rmm.enrollment_ip_spread', ratio * 80, {
          devicesEnrolled30d: a.devicesEnrolled30d,
          distinctEnrollmentIps30d: a.distinctEnrollmentIps30d,
        });
      }
    }

    // fraud.failed_login_cluster — never age-decayed.
    const loginThreshold = cfg['fraud.failed_login_cluster.count_24h'];
    if (a.failedLogins24h >= loginThreshold) {
      push('fraud.failed_login_cluster', Math.min(100, (a.failedLogins24h / loginThreshold) * 50), {
        failedLogins24h: a.failedLogins24h,
      }, false);
    }

    // resource.enrollment_denied — repeated cap/key rejections; never age-decayed.
    const deniedThreshold = cfg['resource.enrollment_denied.count_24h'];
    if (a.enrollmentDenied24h >= deniedThreshold) {
      push('resource.enrollment_denied', Math.min(100, (a.enrollmentDenied24h / deniedThreshold) * 50), {
        enrollmentDenied24h: a.enrollmentDenied24h,
      }, false);
    }

    // resource.volume_outlier — never age-decayed.
    const cmdThreshold = cfg['resource.volume_outlier.commands_24h'];
    const scriptThreshold = cfg['resource.volume_outlier.scripts_24h'];
    if (a.commands24h >= cmdThreshold || a.scriptExecutions24h >= scriptThreshold) {
      push('resource.volume_outlier', Math.min(
        100,
        Math.max((a.commands24h / cmdThreshold) * 50, (a.scriptExecutions24h / scriptThreshold) * 50),
      ), {
        commands24h: a.commands24h,
        scriptExecutions24h: a.scriptExecutions24h,
      }, false);
    }
  }

  return signals;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/heuristics.test.ts`
Expected: PASS. (If a threshold/score interaction fails, fix the score math, not the test intent: consumer 9/10 young ⇒ ≥ watch; 5 fast-remote on 5 devices young ⇒ alert.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/abuseSignals/heuristics.ts apps/api/src/services/abuseSignals/heuristics.test.ts
git commit -m "feat(abuse): malicious-RMM-use heuristic signals"
```

---

### Task 9: Persistence + dedup state machine

**Files:**
- Create: `apps/api/src/services/abuseSignals/persistence.ts`
- Test: `apps/api/src/services/abuseSignals/persistence.test.ts`

**Interfaces:**
- Consumes: `partnerAbuseSignals` table (Task 4), `ComputedSignal` (Task 5).
- Produces:
  - `interface OpenSignalRow { id: string; partnerId: string; signalKey: string; severity: AbuseSeverity; acknowledgedAt: Date | null; deliveredAt: Date | null; }`
  - `persistSignals(computed: ComputedSignal[], now: Date): Promise<{ toNotify: Array<ComputedSignal & { rowId: string }> }>` (system-context caller)
  - `markDelivered(rowIds: string[], now: Date): Promise<void>` (system-context caller)

State machine rules (the tests below encode them):
1. Fired + no open row → INSERT; notify if severity is `alert`.
2. Fired + open row → UPDATE score/severity/evidence/computed_at (keep `first_fired_at`); notify only if severity is `alert` AND (`delivered_at` IS NULL) AND (`acknowledged_at` IS NULL). Covers watch→alert escalation (never delivered) and failed-delivery retry, without hourly re-spam of already-delivered alerts.
3. Open row + not fired this sweep → set `resolved_at` (acknowledged rows resolve too; a re-fire later creates a fresh row, so materially-changed evidence re-alerts).
4. Acknowledged rows are never notified while open.

- [ ] **Step 1: Write the failing tests**

Mock the db module with a chainable stub (same style as `register.test.ts`); assert behavior through which mutations run and what `toNotify` contains:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const inserted: unknown[] = [];
const updates: Array<{ set: Record<string, unknown> }> = [];

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        inserted.push(v);
        return { returning: vi.fn().mockResolvedValue([{ id: `new-${inserted.length}` }]) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((s: Record<string, unknown>) => {
        updates.push({ set: s });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  },
}));

import { db } from '../../db';
import { persistSignals } from './persistence';
import type { ComputedSignal } from './types';

const now = new Date('2026-07-15T12:00:00Z');

function mockOpenRows(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(rows) })),
  } as never);
}

function signal(overrides: Partial<ComputedSignal>): ComputedSignal {
  return { partnerId: 'p1', signalKey: 'rmm.consumer_devices', score: 80, severity: 'alert', evidence: {}, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
  updates.length = 0;
});

describe('persistSignals', () => {
  it('inserts new fired signals and notifies alerts only', async () => {
    mockOpenRows([]);
    const { toNotify } = await persistSignals(
      [signal({}), signal({ signalKey: 'rmm.enrollment_velocity', score: 45, severity: 'watch' })],
      now,
    );
    expect(inserted).toHaveLength(2);
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0].signalKey).toBe('rmm.consumer_devices');
  });

  it('updates an existing open row without re-notifying a delivered alert', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: null, deliveredAt: new Date() }]);
    const { toNotify } = await persistSignals([signal({})], now);
    expect(inserted).toHaveLength(0);
    expect(updates.length).toBeGreaterThan(0);
    expect(toNotify).toHaveLength(0);
  });

  it('notifies on escalation to alert (open watch row, never delivered)', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    const { toNotify } = await persistSignals([signal({ severity: 'alert' })], now);
    expect(toNotify).toHaveLength(1);
    expect(toNotify[0].rowId).toBe('row1');
  });

  it('never notifies acknowledged rows', async () => {
    mockOpenRows([{ id: 'row1', partnerId: 'p1', signalKey: 'rmm.consumer_devices', severity: 'alert', acknowledgedAt: new Date(), deliveredAt: null }]);
    const { toNotify } = await persistSignals([signal({})], now);
    expect(toNotify).toHaveLength(0);
  });

  it('resolves open rows that did not fire this sweep', async () => {
    mockOpenRows([{ id: 'stale', partnerId: 'p9', signalKey: 'rmm.enrollment_velocity', severity: 'watch', acknowledgedAt: null, deliveredAt: null }]);
    await persistSignals([], now);
    expect(updates.some((u) => u.set.resolvedAt instanceof Date)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/persistence.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement persistence.ts**

```ts
import { eq, isNull, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { partnerAbuseSignals } from '../../db/schema';
import type { ComputedSignal } from './types';

const key = (partnerId: string, signalKey: string) => `${partnerId}|${signalKey}`;

/**
 * Reconciles this sweep's computed signals against open rows. State-based
 * dedup: notify on first alert firing or on escalation-to-alert, never on
 * hourly recomputation of an already-delivered alert. MUST run inside a
 * system DB context.
 */
export async function persistSignals(
  computed: ComputedSignal[],
  now: Date,
): Promise<{ toNotify: Array<ComputedSignal & { rowId: string }> }> {
  const openRows = await db
    .select()
    .from(partnerAbuseSignals)
    .where(isNull(partnerAbuseSignals.resolvedAt));

  const openByKey = new Map(openRows.map((r) => [key(r.partnerId, r.signalKey), r]));
  const firedKeys = new Set(computed.map((s) => key(s.partnerId, s.signalKey)));
  const toNotify: Array<ComputedSignal & { rowId: string }> = [];

  for (const s of computed) {
    const open = openByKey.get(key(s.partnerId, s.signalKey));
    if (!open) {
      const [row] = await db
        .insert(partnerAbuseSignals)
        .values({
          partnerId: s.partnerId,
          signalKey: s.signalKey,
          severity: s.severity,
          score: s.score,
          evidence: s.evidence,
          firstFiredAt: now,
          computedAt: now,
        })
        .returning();
      if (s.severity === 'alert') toNotify.push({ ...s, rowId: row.id });
      continue;
    }

    await db
      .update(partnerAbuseSignals)
      .set({ severity: s.severity, score: s.score, evidence: s.evidence, computedAt: now })
      .where(eq(partnerAbuseSignals.id, open.id));

    const notifiable =
      s.severity === 'alert' && open.deliveredAt === null && open.acknowledgedAt === null;
    if (notifiable) toNotify.push({ ...s, rowId: open.id });
  }

  const staleIds = openRows
    .filter((r) => !firedKeys.has(key(r.partnerId, r.signalKey)))
    .map((r) => r.id);
  if (staleIds.length > 0) {
    await db
      .update(partnerAbuseSignals)
      .set({ resolvedAt: now })
      .where(inArray(partnerAbuseSignals.id, staleIds));
  }

  return { toNotify };
}

/** MUST run inside a system DB context. */
export async function markDelivered(rowIds: string[], now: Date): Promise<void> {
  if (rowIds.length === 0) return;
  await db
    .update(partnerAbuseSignals)
    .set({ deliveredAt: now })
    .where(inArray(partnerAbuseSignals.id, rowIds));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/abuseSignals/persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/abuseSignals/persistence.ts apps/api/src/services/abuseSignals/persistence.test.ts
git commit -m "feat(abuse): signal persistence with state-based alert dedup"
```

---

### Task 10: Sweep orchestration, digest, BullMQ job, wiring

**Files:**
- Create: `apps/api/src/services/abuseSignals/index.ts`
- Create: `apps/api/src/jobs/abuseSignalsSweep.ts`
- Modify: `apps/api/src/index.ts` (import ~line 206, `initializeWorkers()` list ~line 1150, shutdown list ~line 1365)
- Test: `apps/api/src/jobs/abuseSignalsSweep.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5-9 plus `sendOpsAlert`, `recordAbuseSignalFired`, `recordAbuseSweepRun` (Task 6).
- Produces: `runAbuseSweep(): Promise<{ fired: number; notified: number }>`, `runAbuseDigest(): Promise<void>`, `initializeAbuseSignalsWorker(): Promise<void>`, `shutdownAbuseSignalsWorker(): Promise<void>`.

- [ ] **Step 1: Implement the orchestrator** (`services/abuseSignals/index.ts`)

```ts
import { sql } from 'drizzle-orm';
import * as dbModule from '../../db';
import { sendOpsAlert } from '../opsAlerts';
import { recordAbuseSignalFired } from '../abuseMetrics';
import { loadSignalConfig } from './config';
import { computeInvariantSignals } from './invariants';
import { loadPartnerAggregates, computeHeuristicSignals } from './heuristics';
import { persistSignals, markDelivered } from './persistence';
import type { ComputedSignal } from './types';

const { db } = dbModule;

// #1105: hold the system DB context only around DB work; alert delivery
// (network) happens outside it.
const runSystemDbCompute = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  const runOutside = dbModule.runOutsideDbContext;
  if (typeof withSystem !== 'function') return fn();
  if (typeof runOutside !== 'function') return withSystem(fn);
  return runOutside(() => withSystem(fn));
};

function formatSignalAlert(s: ComputedSignal & { rowId: string }): { title: string; body: string } {
  const shortId = s.partnerId.slice(0, 8);
  return {
    title: `Abuse signal: ${s.signalKey} (${s.severity})`,
    body: [
      `Partner: ${String(s.evidence.partnerName ?? 'unknown')} (${shortId})`,
      `Score: ${s.score}`,
      `Evidence: ${JSON.stringify(s.evidence)}`,
      `Review: docs/superpowers/specs/security-auth/2026-07-11-signup-abuse-detection-design.md — suspend playbook applies; partner id ${s.partnerId}`,
    ].join('\n'),
  };
}

export async function runAbuseSweep(): Promise<{ fired: number; notified: number }> {
  const cfg = loadSignalConfig();
  const now = new Date();

  const { invariants, aggregates } = await runSystemDbCompute(async () => ({
    invariants: await computeInvariantSignals(),
    aggregates: await loadPartnerAggregates(),
  }));

  const computed = [...invariants, ...computeHeuristicSignals(aggregates, cfg, now)];
  const { toNotify } = await runSystemDbCompute(() => persistSignals(computed, now));

  for (const s of computed) recordAbuseSignalFired(s.severity);

  const deliveredIds: string[] = [];
  for (const n of toNotify) {
    if (await sendOpsAlert(formatSignalAlert(n))) deliveredIds.push(n.rowId);
  }
  if (deliveredIds.length > 0) {
    await runSystemDbCompute(() => markDelivered(deliveredIds, new Date()));
  }

  return { fired: computed.length, notified: deliveredIds.length };
}

export async function runAbuseDigest(): Promise<void> {
  const stats = await runSystemDbCompute(async () => {
    const openBySeverity = (await db.execute(sql`
      SELECT severity, COUNT(*) AS count FROM partner_abuse_signals
      WHERE resolved_at IS NULL AND acknowledged_at IS NULL
      GROUP BY severity
    `)) as unknown as Array<{ severity: string; count: string }>;
    const watchRows = (await db.execute(sql`
      SELECT s.signal_key, s.score, s.evidence, p.name
      FROM partner_abuse_signals s JOIN partners p ON p.id = s.partner_id
      WHERE s.resolved_at IS NULL AND s.acknowledged_at IS NULL AND s.severity = 'watch'
      ORDER BY s.score DESC LIMIT 20
    `)) as unknown as Array<{ signal_key: string; score: number; evidence: Record<string, unknown>; name: string }>;
    const newPartners = (await db.execute(sql`
      SELECT COUNT(*) AS count FROM partners WHERE created_at > now() - interval '7 days' AND deleted_at IS NULL
    `)) as unknown as Array<{ count: string }>;
    return { openBySeverity, watchRows, newPartnerCount: Number(newPartners[0]?.count ?? 0) };
  });

  const severityLine = stats.openBySeverity.map((r) => `${r.severity}: ${r.count}`).join(', ') || 'none open';
  const watchLines = stats.watchRows.map((r) => `- ${r.name}: ${r.signal_key} (score ${r.score})`).join('\n');
  await sendOpsAlert({
    title: 'Weekly abuse-signals digest',
    body: [
      `New partners this week: ${stats.newPartnerCount}`,
      `Open unacknowledged signals — ${severityLine}`,
      watchLines ? `Watch tier:\n${watchLines}` : 'Watch tier: empty',
      'Invariants checked hourly all week (any breach would have alerted immediately).',
    ].join('\n'),
  });
}
```

- [ ] **Step 2: Write the failing job tests**

`jobs/abuseSignalsSweep.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queueAdd = vi.fn();
const getRepeatableJobs = vi.fn().mockResolvedValue([
  { name: 'abuse-sweep', key: 'old-key-1' },
  { name: 'unrelated', key: 'other' },
]);
const removeRepeatableByKey = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn(() => ({ add: queueAdd, getRepeatableJobs, removeRepeatableByKey, close: vi.fn() })),
  Worker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/abuseSignals', () => ({ runAbuseSweep: vi.fn(), runAbuseDigest: vi.fn() }));
vi.mock('../services/abuseMetrics', () => ({ recordAbuseSweepRun: vi.fn() }));

import { scheduleAbuseSignalsJobs } from './abuseSignalsSweep';

beforeEach(() => vi.clearAllMocks());

describe('scheduleAbuseSignalsJobs', () => {
  it('clears prior repeatables for its own job names only, then schedules hourly sweep + weekly digest', async () => {
    getRepeatableJobs.mockResolvedValueOnce([
      { name: 'abuse-sweep', key: 'stale-sweep' },
      { name: 'abuse-digest', key: 'stale-digest' },
      { name: 'unrelated', key: 'other' },
    ]);
    await scheduleAbuseSignalsJobs();
    expect(removeRepeatableByKey).toHaveBeenCalledWith('stale-sweep');
    expect(removeRepeatableByKey).toHaveBeenCalledWith('stale-digest');
    expect(removeRepeatableByKey).not.toHaveBeenCalledWith('other');
    expect(queueAdd).toHaveBeenCalledWith(
      'abuse-sweep',
      expect.anything(),
      expect.objectContaining({ jobId: 'abuse-sweep-repeat', repeat: { every: 60 * 60 * 1000 } }),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'abuse-digest',
      expect.anything(),
      expect.objectContaining({ jobId: 'abuse-digest-repeat', repeat: { pattern: '0 9 * * 1' } }),
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/jobs/abuseSignalsSweep.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the job** (`jobs/abuseSignalsSweep.ts`; follows `userRiskJobs.ts`)

```ts
import { Job, Queue, Worker } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';
import { runAbuseSweep, runAbuseDigest } from '../services/abuseSignals';
import { recordAbuseSweepRun } from '../services/abuseMetrics';

const ABUSE_QUEUE = 'abuse-signals';
const SWEEP_JOB = 'abuse-sweep';
const DIGEST_JOB = 'abuse-digest';
// jobIds use hyphens, never colons (BullMQ jobId rule).
const SWEEP_REPEAT_ID = 'abuse-sweep-repeat';
const DIGEST_REPEAT_ID = 'abuse-digest-repeat';
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const DIGEST_CRON = '0 9 * * 1'; // Monday 09:00

type AbuseJobData = Record<string, never>;

let abuseQueue: Queue<AbuseJobData> | null = null;
let abuseWorker: Worker<AbuseJobData> | null = null;

export function getAbuseSignalsQueue(): Queue<AbuseJobData> {
  if (!abuseQueue) {
    abuseQueue = new Queue<AbuseJobData>(ABUSE_QUEUE, { connection: getBullMQConnection() });
  }
  return abuseQueue;
}

export async function scheduleAbuseSignalsJobs(): Promise<void> {
  const queue = getAbuseSignalsQueue();
  // Clear prior repeatables so interval/cron changes take effect on redeploy.
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === SWEEP_JOB || job.name === DIGEST_JOB) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(SWEEP_JOB, {}, {
    jobId: SWEEP_REPEAT_ID,
    repeat: { every: SWEEP_INTERVAL_MS },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
  await queue.add(DIGEST_JOB, {}, {
    jobId: DIGEST_REPEAT_ID,
    repeat: { pattern: DIGEST_CRON },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });
}

export function createAbuseSignalsWorker(): Worker<AbuseJobData> {
  return new Worker<AbuseJobData>(
    ABUSE_QUEUE,
    async (job: Job<AbuseJobData>) => {
      try {
        if (job.name === SWEEP_JOB) {
          const result = await runAbuseSweep();
          recordAbuseSweepRun('success');
          return result;
        }
        if (job.name === DIGEST_JOB) {
          await runAbuseDigest();
          return {};
        }
        return {};
      } catch (error) {
        recordAbuseSweepRun('error');
        throw error;
      }
    },
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAbuseSignalsWorker(): Promise<void> {
  abuseWorker = createAbuseSignalsWorker();
  attachWorkerObservability(abuseWorker, 'abuseSignalsWorker');
  await scheduleAbuseSignalsJobs();
  console.log('[AbuseSignals] Sweep worker initialized');
}

export async function shutdownAbuseSignalsWorker(): Promise<void> {
  if (abuseWorker) {
    await abuseWorker.close();
    abuseWorker = null;
  }
  if (abuseQueue) {
    await abuseQueue.close();
    abuseQueue = null;
  }
}
```

- [ ] **Step 5: Wire into index.ts**

Add alongside the userRisk imports (~line 206):

```ts
import { initializeAbuseSignalsWorker, shutdownAbuseSignalsWorker } from './jobs/abuseSignalsSweep';
```

Add to the `initializeWorkers()` tuple list (~line 1150):

```ts
    ['abuseSignalsWorker', initializeAbuseSignalsWorker],
```

Add to the shutdown list (~line 1365):

```ts
    shutdownAbuseSignalsWorker,
```

- [ ] **Step 6: Run the job tests and full API unit suite**

Run: `cd apps/api && npx vitest run src/jobs/abuseSignalsSweep.test.ts`
Expected: PASS.
Run: `pnpm test --filter=@breeze/api`
Expected: PASS (no regressions; watch for the schema-mock trap — any suite stubbing `../../db/schema` may need `partnerAbuseSignals` added).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/abuseSignals/index.ts apps/api/src/jobs/abuseSignalsSweep.ts apps/api/src/jobs/abuseSignalsSweep.test.ts apps/api/src/index.ts
git commit -m "feat(abuse): hourly abuse-signals sweep + weekly digest job"
```

---

### Task 11: Hardening fixes (unsuspend email gate, createPartner explicit status)

**Files:**
- Modify: `apps/api/src/routes/admin/abuse.ts` (unsuspend handler, partner select ~line 384, status decision ~line 400)
- Modify: `apps/api/src/services/partnerCreate.ts` (make `status` required)
- Test: the existing test file for `routes/admin/abuse.ts` (co-located; create `abuse.test.ts` with the standard Drizzle-mock scaffolding from `register.test.ts` if none exists)

**Interfaces:**
- Consumes: nothing new. Changes `CreatePartnerInput.status` from optional to required (Task 2 already passes it explicitly at the only production call site).

- [ ] **Step 1: Write the failing test**

In the abuse route test file:

```ts
  it('unsuspend falls back to pending when email is unverified, even with payment attached', async () => {
    // Arrange the partner select to return paymentMethodAttachedAt set, emailVerifiedAt null
    // (use the file's tx-mock scaffolding), then call POST /partners/:id/unsuspend.
    // Assert the partners UPDATE ran with status 'pending', not 'active'.
    expect(capturedPartnerUpdate.status).toBe('pending');
  });
```

(Complete the arrange step with the file's mock scaffolding; the assertion above is the contract. If creating the file fresh, copy the `vi.mock('../../db', ...)` block from `register.test.ts` and mock `withSystemDbAccessContext`/`db.transaction` so the transaction callback runs with a stub `tx` whose `update().set()` captures its argument into `capturedPartnerUpdate`.)

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — status is `'active'` (current behavior ignores email verification).

- [ ] **Step 3: Fix the unsuspend gate**

In `apps/api/src/routes/admin/abuse.ts`, add `emailVerifiedAt` to the partner select:

```ts
          .select({
            id: partners.id,
            paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
            emailVerifiedAt: partners.emailVerifiedAt,
          })
```

and change the status decision (comment updated to match):

```ts
        // Preserve the FULL activation gate (email verification AND payment
        // method) — unsuspend must not become the one path that activates an
        // unverified partner. Otherwise route back through pending-activation.
        const newStatus: 'active' | 'pending' =
          partner.paymentMethodAttachedAt && partner.emailVerifiedAt ? 'active' : 'pending';
```

- [ ] **Step 4: Make createPartner status explicit**

In `apps/api/src/services/partnerCreate.ts`, change the input field to required and remove the fallback:

```ts
  /**
   * Initial partner status — REQUIRED so no future caller silently mints an
   * 'active' partner. Hosted signups pass 'pending' (partnerGuard blocks
   * features until breeze-billing activates post-payment + email verify).
   */
  status: PartnerStatus;
```

and in the insert values: `status: input.status,`

Run `cd apps/api && npx tsc --noEmit` — any caller not passing `status` explicitly now fails the build; fix each by passing the correct explicit value (register.ts already does; tests may need `status: 'pending'` added to fixtures).

- [ ] **Step 5: Run tests**

Run: `cd apps/api && npx vitest run src/routes/admin/abuse.test.ts src/services/partnerCreate.test.ts src/routes/auth/register.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin/abuse.ts apps/api/src/services/partnerCreate.ts apps/api/src/routes/admin/abuse.test.ts apps/api/src/services/partnerCreate.test.ts
git commit -m "fix(abuse): unsuspend re-checks email verification; createPartner requires explicit status"
```

---

### Task 12: Full verification pass

- [ ] **Step 1: Full API suite + typecheck**

Run: `pnpm test --filter=@breeze/api` and `cd apps/api && npx tsc --noEmit`
Expected: PASS / no errors.

- [ ] **Step 2: Integration suite (real Postgres on :5433)**

Run the RLS coverage + forge suites per the repo's integration-test mechanics.
Expected: PASS, including the new `partner_abuse_signals` forge cases.

- [ ] **Step 3: Migration replay**

Run: `cd apps/api && DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" pnpm db:check-drift` twice.
Expected: exits 0 both times (idempotency).

- [ ] **Step 4: Live smoke (worktree stack)**

Bring up the worktree stack, set `OPS_ALERT_WEBHOOK_URL` to a test webhook, seed a synthetic young partner with ≥5 `DESKTOP-XXXXXXX` devices and force-run the sweep (enqueue `abuse-sweep` once via a one-off script or drop the repeat interval); confirm the alert message arrives and a `partner_abuse_signals` row exists with `delivered_at` set. Then re-run the sweep and confirm no duplicate alert.

- [ ] **Step 5: Commit any fixes, then hand off for PR**

PR 2 ships Tasks 4-12. Use the repo's standard PR + review flow.

---

## Out of scope for this plan (tracked in the spec)

- **Geo PR** (GeoLite2 download job, geography/ASN signals): separate follow-up plan once this lands and capture data accrues.
- **breeze-billing** Radar early-fraud-warning/dispute forward: separate repo.
- **Ops tasks**: CrowdSec on droplets, weekly Claude analyst schedule + `internal/` playbook, prod env var rollout (`.env` + compose mapping on droplets), acknowledging the ~11 grandfathered `invariant.active_unverified_email` hits on first sweep.
