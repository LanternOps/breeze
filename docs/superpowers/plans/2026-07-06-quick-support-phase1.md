# Quick Support Phase 1 (Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tech generates a one-time code; end user runs a downloaded client (the Go agent in `support` mode) that enrolls an ephemeral device in a hidden per-partner org; the existing remote-desktop stack connects to it; everything cleans itself up.

**Architecture:** Ephemeral enrollment (approved spec `docs/superpowers/specs/2026-07-06-one-off-support-session-design.md`). New `support_sessions` table (Shape-1 org RLS) + one-time code redemption modeled on installer bootstrap tokens; redemption mints a single-use child enrollment key flagged with `support_session_id`; `/agents/enroll` marks the device `is_ephemeral` and links it back. The tech connects via the unchanged `POST /remote/sessions` + Tauri viewer flow.

**Tech Stack:** Hono + Drizzle + BullMQ (API), Astro + React islands (web), Go + cobra (agent), Vitest / go test.

## Global Constraints

- Windows end-user client only in Phase 1 (macOS = Phase 2). Tech-side viewer already cross-platform.
- Code format: 9 chars from alphabet `ABCDEFGHJKMNPQRSTVWXYZ23456789` (30 chars, no I/L/O/0/1 → ~44 bits), displayed `XXX-XXX-XXX`, stored as SHA-256 hex.
- TTLs: code redemption 15 min; session hard cap 8 h; ephemeral device purge 6 h after end; client dead-man switch 10 min offline; reaper interval 5 min.
- New tenant-scoped table uses RLS Shape 1 (direct `org_id`), policies in the same migration. Migration naming `2026-07-06-<slug>.sql`, idempotent, no inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file in a transaction).
- All web mutations via `runAction` (`apps/web/src/lib/runAction.ts`).
- v1 requires `auth.scope === 'partner'` (or `system`) to create support sessions — org-scoped tokens can't reach the hidden org (documented limitation).
- BullMQ job ids: use `-`, never `:`.
- Never derive Zod enums from Drizzle `pgEnum.enumValues` (breaks schema mocks).
- All new web UI strings go through the i18n layer (literal-key `t()`); every new key lands in en AND all other locale catalogs in the same commit — the locale-parity test reds main otherwise. Applies to the public `/quick` page too (it's consumer-facing).
- The served support client MUST be Authenticode-signed (see Task 11 Step 2b). Per-session filename renames do NOT invalidate the signature or SmartScreen reputation — both key on content hash + cert — but an *unsigned* exe is a SmartScreen wall for consumers.

## Deviations from spec (implementation adaptations — spec updated alongside this plan)

1. `organizations.kind` → reuse existing `org_type` pg enum; add value `'quick_support'`.
2. `failed_attempts` column dropped: codes are looked up by hash, so an unknown code has no row to count against. Per-IP sliding-window rate limits + 44-bit entropy + 15-min TTL cover guessing.
3. `active` status is **derived** (live `remote_sessions` rows for the device) rather than stored — avoids hooking remote-session create/end. Stored states: `pending / claimed / ready / ended / expired`.
4. v1 status "window" = console window with status lines + Ctrl+C to stop (the agent has no GUI framework; a native window is Phase 3 polish).
5. Landing URL is `/quick?code=<CODE>` (Astro static pages can't do dynamic `/quick/:code` paths without SSR).
6. End-user-initiated stop is detected via agent-offline (reaper marks `ended/end_user` after 5 min offline) rather than a dedicated API call — no new agent-auth surface in v1.

## Review adjustments (2026-07-17 review — spec implementation notes updated to match)

7. **Migration split (`-a-`/`-b-`):** the partial index `WHERE type = 'quick_support'` cannot live in the same file as `ALTER TYPE ... ADD VALUE 'quick_support'` — Postgres rejects any *use* of an enum value added in the current transaction (`55P04 unsafe use of new value`), and autoMigrate wraps each file in one transaction. As originally written, Task 1's migration failed on first run, rolled back, and would retry forever.
8. **End-path hardening:** `endSupportSession` force-closes the device's agent WS after revoking tokens. Without it, a lost `support_end` on a healthy WS lingers until the 8h hard cap (the client is online, so the offline dead-man never fires). With it: close → reconnect → re-auth fails → dead-man cleans up in ≤10 min. Also verify `POST /remote/sessions` rejects decommissioned devices.
9. **Tier 2 consent guarantee moved service-side:** the temporary service watches the console monitor's process handle and self-tears-down when it dies. Closing the console with X (~5s SIGTERM grace) or killing it from Task Manager must never leave a SYSTEM service silently sharing the screen.
10. **Claimed-limbo reaping:** `claimed` sessions with no device 20 min after `claimed_at` → `expired` (client crashed between redeem and enroll; otherwise the tech's panel shows "Client connecting…" until the 8h cap).
11. **i18n is mandatory** (see Global Constraints) — the plan originally predated the literal-key `t()` gate and locale-parity CI checks.
12. **Signing/SmartScreen:** the served exe must be Authenticode-signed; release-blocking check in Task 11 Step 2b, honest publisher copy in Task 16.
13. **Milestones:** **A = Tasks 1–13 + 15–18** (Tier 1, shippable end-to-end); **B = Task 14** (Tier 2 — quarantines the two riskiest unknowns: helper-binary path resolution and service lifecycle). Run Task 18's Tier-2 checks only with B.

---

### Task 1: DB migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-07-06-a-quick-support-sessions.sql` (date both files with the actual implementation date; keep the `-a-`/`-b-` infix)
- Create: `apps/api/migrations/2026-07-06-b-quick-support-org-index.sql`
- Create: `apps/api/src/db/schema/supportSessions.ts`
- Modify: `apps/api/src/db/schema/orgs.ts` (orgTypeEnum ~line 8)
- Modify: `apps/api/src/db/schema/devices.ts` (devices table)
- Modify: `apps/api/src/db/schema/orgs.ts` (enrollmentKeys table ~line 115)
- Modify: `apps/api/src/db/schema/index.ts` (barrel export)

**Interfaces:**
- Produces: `supportSessions` table object, `supportSessionStatusEnum` (values `['pending','claimed','ready','ended','expired']`), `devices.isEphemeral: boolean`, `enrollmentKeys.supportSessionId: uuid | null`, org type value `'quick_support'`.

- [ ] **Step 1: Write the migrations — TWO files; the split is load-bearing**

File `2026-07-06-a-quick-support-sessions.sql`:

```sql
-- 2026-07-06-a: Quick Support — one-time code ad-hoc sessions.
-- Spec: docs/superpowers/specs/2026-07-06-one-off-support-session-design.md
-- support_sessions is RLS Shape 1 (direct org_id) — auto-discovered by the
-- rls-coverage integration test, no allowlist entry needed.
-- Fully idempotent. NOTE: no BEGIN/COMMIT — autoMigrate wraps the file.

-- New org type for the hidden per-partner Quick Support org.
-- PG12+ allows ADD VALUE inside a transaction, but the new value cannot be
-- USED in the same transaction (55P04 "unsafe use of new value") — and
-- autoMigrate wraps each file in ONE transaction. That is why the partial
-- index on type = 'quick_support' lives in the -b- file. Nothing in THIS
-- file may reference the new value.
ALTER TYPE org_type ADD VALUE IF NOT EXISTS 'quick_support';

ALTER TABLE devices ADD COLUMN IF NOT EXISTS is_ephemeral BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  CREATE TYPE support_session_status AS ENUM ('pending','claimed','ready','ended','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash VARCHAR(64) NOT NULL UNIQUE,
  code_expires_at TIMESTAMPTZ NOT NULL,
  status support_session_status NOT NULL DEFAULT 'pending',
  hard_expires_at TIMESTAMPTZ NOT NULL,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  attributed_org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  attribution_label TEXT,
  claimed_at TIMESTAMPTZ,
  claimed_from_ip TEXT,
  ended_at TIMESTAMPTZ,
  ended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_reaper
  ON support_sessions(status, hard_expires_at);
CREATE INDEX IF NOT EXISTS idx_support_sessions_device
  ON support_sessions(device_id);

ALTER TABLE enrollment_keys
  ADD COLUMN IF NOT EXISTS support_session_id UUID REFERENCES support_sessions(id) ON DELETE CASCADE;

-- RLS — Shape 1, standard four breeze_org_isolation policies
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON support_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON support_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON support_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON support_sessions;

CREATE POLICY breeze_org_isolation_select ON support_sessions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON support_sessions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON support_sessions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON support_sessions
  FOR DELETE USING (public.breeze_has_org_access(org_id));
```

File `2026-07-06-b-quick-support-org-index.sql`:

```sql
-- 2026-07-06-b: Quick Support — partial unique index on the new enum value.
-- MUST be a separate file from -a-: Postgres forbids using an enum value added
-- in the current transaction (55P04), and autoMigrate wraps each file in ONE
-- transaction. File -a- commits the value; this file may use it.

-- Exactly one hidden org per partner.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_partner_quick_support_uniq
  ON organizations(partner_id) WHERE type = 'quick_support';
```

- [ ] **Step 2: Drizzle schema file `supportSessions.ts`**

```ts
import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { organizations } from './orgs';
import { users } from './users';
import { devices } from './devices';

export const supportSessionStatusEnum = pgEnum('support_session_status',
  ['pending', 'claimed', 'ready', 'ended', 'expired']);

export const supportSessions = pgTable('support_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  codeHash: varchar('code_hash', { length: 64 }).notNull().unique(),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  status: supportSessionStatusEnum('status').notNull().default('pending'),
  hardExpiresAt: timestamp('hard_expires_at', { withTimezone: true }).notNull(),
  deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
  attributedOrgId: uuid('attributed_org_id').references(() => organizations.id, { onDelete: 'set null' }),
  attributionLabel: text('attribution_label'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimedFromIp: text('claimed_from_ip'),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endedReason: text('ended_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  reaperIdx: index('idx_support_sessions_reaper').on(t.status, t.hardExpiresAt),
  deviceIdx: index('idx_support_sessions_device').on(t.deviceId),
}));
```

- [ ] **Step 3: Modify existing schema files**

In `orgs.ts`: `orgTypeEnum` becomes `pgEnum('org_type', ['customer', 'internal', 'quick_support'])`. In `enrollmentKeys` add `supportSessionId: uuid('support_session_id')` (plain uuid — no `.references()` to avoid a circular import with `supportSessions.ts`; FK lives in SQL). In `devices.ts` add `isEphemeral: boolean('is_ephemeral').notNull().default(false)` right after `status`. Export `supportSessions` + `supportSessionStatusEnum` from `schema/index.ts`. If `pnpm db:check-drift` flags the partial unique index, mirror it in the orgs.ts table extras: `uniqueIndex('organizations_partner_quick_support_uniq').on(t.partnerId).where(sql`type = 'quick_support'`)`.

- [ ] **Step 4: Verify drift + migration test**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift` → no drift. Run `pnpm test --filter=@breeze/api -- autoMigrate` → ordering test passes.

- [ ] **Step 5: Commit** — `feat(api): quick support schema — support_sessions, ephemeral devices, quick_support org type`

---

### Task 2: Shared code validators + API code service

**Files:**
- Create: `packages/shared/src/validators/quickSupport.ts`
- Test: `packages/shared/src/validators/quickSupport.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (barrel)
- Create: `apps/api/src/services/quickSupportCode.ts`
- Test: `apps/api/src/services/quickSupportCode.test.ts`

**Interfaces:**
- Produces (shared, imported as `from '@breeze/shared'`):
  `SUPPORT_CODE_ALPHABET: string`, `SUPPORT_CODE_LENGTH = 9`, `SUPPORT_CODE_PATTERN: RegExp`,
  `normalizeSupportCode(raw: string): string | null`, `formatSupportCode(code: string): string`,
  `createSupportSessionSchema` (zod: `{ attributedOrgId?: uuid, attributionLabel?: string(max 200) }`),
  `redeemSupportSessionSchema` (zod: `{ code: string, hostname: string, osType: 'windows'|'macos'|'linux' }` — hand-written enum, not from pgEnum).
- Produces (API): `generateSupportCode(): string`, `hashSupportCode(code: string): string` (sha256 hex).

- [ ] **Step 1: Write failing shared tests** — cases: `normalizeSupportCode('ktm-4h7 p2x') === 'KTM4H7P2X'`; rejects `'KTM4H7P20'` (contains 0) → null; rejects 8/10 char inputs → null; `formatSupportCode('KTM4H7P2X') === 'KTM-4H7-P2X'`; both zod schemas accept/reject representative payloads. Run `pnpm test --filter=@breeze/shared -- quickSupport` → FAIL (module not found).

- [ ] **Step 2: Implement**

```ts
import { z } from 'zod';

export const SUPPORT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const SUPPORT_CODE_LENGTH = 9;
export const SUPPORT_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{9}$/;

export function normalizeSupportCode(raw: string): string | null {
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, '');
  return SUPPORT_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

export function formatSupportCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

export const createSupportSessionSchema = z.object({
  attributedOrgId: z.string().guid().optional(),
  attributionLabel: z.string().max(200).optional(),
});

export const redeemSupportSessionSchema = z.object({
  code: z.string().min(SUPPORT_CODE_LENGTH).max(15),
  hostname: z.string().min(1).max(255),
  osType: z.enum(['windows', 'macos', 'linux']),
});
```

(Check sibling validators for whether this repo's Zod 4 uses `.guid()` — memory says yes; mirror whatever `remoteAccessInlineSettings.ts` does.)

API service `quickSupportCode.ts`:

```ts
import { createHash, randomInt } from 'node:crypto';
import { SUPPORT_CODE_ALPHABET, SUPPORT_CODE_LENGTH } from '@breeze/shared';

export const SUPPORT_CODE_TTL_MINUTES = 15;
export const SUPPORT_SESSION_HARD_CAP_HOURS = 8;

export function generateSupportCode(): string {
  let code = '';
  for (let i = 0; i < SUPPORT_CODE_LENGTH; i++) {
    code += SUPPORT_CODE_ALPHABET[randomInt(SUPPORT_CODE_ALPHABET.length)];
  }
  return code;
}

export function hashSupportCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
```

API test: generated code matches `SUPPORT_CODE_PATTERN`; 1000 generations all distinct-ish (no exact-dup assertion — just pattern + length); `hashSupportCode` is stable 64-hex.

- [ ] **Step 3: Run both suites → PASS. Commit** — `feat(shared): quick support code validators + generator`

---

### Task 3: Hidden Quick Support org provisioning service

**Files:**
- Create: `apps/api/src/services/quickSupportOrg.ts`
- Test: `apps/api/src/services/quickSupportOrg.test.ts`

**Interfaces:**
- Consumes: `db, withSystemDbAccessContext, runOutsideDbContext` from `../db`; `organizations, sites` from `../db/schema`.
- Produces: `getOrCreateQuickSupportOrg(partnerId: string): Promise<{ orgId: string; siteId: string }>`.

- [ ] **Step 1: Failing tests** — mock `../db` (mirror an existing service test, e.g. whatever `partnerCreate`-adjacent tests do): (a) existing quick_support org + site → returned without insert; (b) none → inserts org `{ partnerId, name: 'Quick Support', slug: 'quick-support-<full partnerId>', type: 'quick_support', status: 'active' }` then site `{ orgId, name: 'Quick Support', timezone: 'UTC' }`; (c) insert conflict (unique partial index) → re-select wins (no throw).

- [ ] **Step 2: Implement**

```ts
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { organizations, sites } from '../db/schema';

/**
 * One hidden 'quick_support' org per partner (organizations_partner_quick_support_uniq).
 * Must run in a fresh system context: a brand-new org id isn't in the caller's
 * accessible_org_ids yet, so RLS would reject both INSERT and RETURNING
 * (same pattern as POST /organizations in routes/orgs.ts).
 */
export async function getOrCreateQuickSupportOrg(partnerId: string): Promise<{ orgId: string; siteId: string }> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const findOrg = () => db.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.partnerId, partnerId), eq(organizations.type, 'quick_support')))
      .limit(1);

    let [org] = await findOrg();
    if (!org) {
      // onConflictDoNothing on the partial unique index handles the concurrent-create race
      // (never rely on catching the error — pg.js begin() rethrows handled errors).
      await db.insert(organizations).values({
        partnerId,
        name: 'Quick Support',
        // Full uuid in the slug — an 8-char prefix can collide across partners
        // if slugs are globally unique, which would make provisioning throw.
        slug: `quick-support-${partnerId}`,
        type: 'quick_support',
        status: 'active',
      }).onConflictDoNothing();
      [org] = await findOrg();
      if (!org) throw new Error('quick support org provisioning failed');
    }

    let [site] = await db.select({ id: sites.id }).from(sites)
      .where(eq(sites.orgId, org.id)).limit(1);
    if (!site) {
      [site] = await db.insert(sites).values({ orgId: org.id, name: 'Quick Support', timezone: 'UTC' }).returning({ id: sites.id });
    }
    return { orgId: org.id, siteId: site.id };
  }));
}
```

Note: `.onConflictDoNothing()` needs the target — if Drizzle requires it for partial indexes, use `.onConflictDoNothing({ target: [organizations.partnerId], targetWhere: sql`type = 'quick_support'` })`; if that fights the types, fall back to re-select after a caught unique-violation checked via error `code === '23505'` re-select (still no reliance on tx-abort recovery — this block is not inside a `begin()`).

- [ ] **Step 3: Run → PASS. Commit** — `feat(api): quick support hidden org provisioning`

---

### Task 4: Authenticated support-session routes (create / list / get)

**Files:**
- Create: `apps/api/src/routes/remote/supportSessions.ts`
- Test: `apps/api/src/routes/remote/supportSessions.test.ts`
- Modify: `apps/api/src/routes/remote/index.ts` (mount)

**Interfaces:**
- Consumes: Task 2 (`generateSupportCode`, `hashSupportCode`, TTL consts, `createSupportSessionSchema`, `formatSupportCode`), Task 3 (`getOrCreateQuickSupportOrg`), `logSessionAudit` from `./helpers`, `supportSessions, remoteSessions, devices` schema.
- Produces routes (final paths under `/api/v1/remote`):
  - `POST /remote/support-sessions` → `201 { id, code /* formatted, shown once */, codeExpiresAt, hardExpiresAt, landingUrl }`
  - `GET /remote/support-sessions?limit=50` → `{ sessions: SupportSessionView[] }`
  - `GET /remote/support-sessions/:id` → `SupportSessionView`
  - `SupportSessionView = { id, status /* stored or derived 'active' */, createdAt, codeExpiresAt, hardExpiresAt, deviceId, deviceOnline: boolean, attributedOrgId, attributionLabel, endedAt, endedReason, createdByUserId }`
- Middleware inherited from `remote/index.ts` mount: `authMiddleware` + `requirePermission('remote','access')` + `requireMfa()`.

- [ ] **Step 1: Failing route tests** (mirror the Drizzle-mock style of `routes/remote/sessions.test.ts` — same `vi.mock` targets):
  - create: partner-scope auth → 201, body has formatted code matching `/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/`, `landingUrl` ends `/quick?code=<raw>`; DB insert received `codeHash` = sha256 of raw code, `orgId` from provisioning.
  - create with `attributedOrgId` not in `auth.accessibleOrgIds` → 403.
  - create with org-scope auth (`auth.scope === 'organization'`) → 403.
  - create with a system-scope token that has no `partnerId` → 403 (the hidden org is per-partner; provisioning would otherwise crash).
  - get: session whose device has a live `remote_sessions` row (status `active`) → `status: 'active'` (derived); device row `status==='online'` → `deviceOnline: true`.
  - list: returns sessions ordered `createdAt desc`.
  - Audit: create emits `logSessionAudit('support_session_created', ...)`.

- [ ] **Step 2: Implement `supportSessions.ts`**

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createSupportSessionSchema, formatSupportCode } from '@breeze/shared';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../../db';
import { supportSessions, remoteSessions, devices } from '../../db/schema';
import { getOrCreateQuickSupportOrg } from '../../services/quickSupportOrg';
import {
  generateSupportCode, hashSupportCode,
  SUPPORT_CODE_TTL_MINUTES, SUPPORT_SESSION_HARD_CAP_HOURS,
} from '../../services/quickSupportCode';
import { logSessionAudit } from './helpers';
import { getTrustedClientIp } from '../../services/clientIp';

export const supportSessionRoutes = new Hono();

supportSessionRoutes.post('/support-sessions', zValidator('json', createSupportSessionSchema), async (c) => {
  const auth = c.get('auth');
  if (auth.scope !== 'partner' && auth.scope !== 'system') {
    return c.json({ error: 'Quick Support requires partner scope' }, 403);
  }
  if (!auth.partnerId) {
    // system tokens may carry no partner context — the hidden org is per-partner
    return c.json({ error: 'Quick Support requires a partner context' }, 403);
  }
  const data = c.req.valid('json');
  if (data.attributedOrgId && auth.accessibleOrgIds !== null
      && !auth.accessibleOrgIds.includes(data.attributedOrgId)) {
    return c.json({ error: 'Attributed organization not accessible' }, 403);
  }

  const { orgId } = await getOrCreateQuickSupportOrg(auth.partnerId);
  const code = generateSupportCode();
  const now = Date.now();

  // System context: if the hidden org was just created it isn't in this
  // request's accessible_org_ids yet, so the RLS INSERT policy would reject.
  const [session] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.insert(supportSessions).values({
      orgId,
      createdByUserId: auth.userId,
      codeHash: hashSupportCode(code),
      codeExpiresAt: new Date(now + SUPPORT_CODE_TTL_MINUTES * 60_000),
      hardExpiresAt: new Date(now + SUPPORT_SESSION_HARD_CAP_HOURS * 3_600_000),
      attributedOrgId: data.attributedOrgId ?? null,
      attributionLabel: data.attributionLabel ?? null,
    }).returning()
  ));

  await logSessionAudit('support_session_created', auth.userId, orgId, {
    sessionId: session.id,
    attributedOrgId: data.attributedOrgId ?? null,
    attributionLabel: data.attributionLabel ?? null,
  }, getTrustedClientIp(c, 'unknown'));

  const webBase = process.env.PUBLIC_WEB_URL ?? '';
  return c.json({
    id: session.id,
    code: formatSupportCode(code),
    codeExpiresAt: session.codeExpiresAt,
    hardExpiresAt: session.hardExpiresAt,
    landingUrl: `${webBase}/quick?code=${code}`,
  }, 201);
});
```

`GET /support-sessions` + `GET /support-sessions/:id`: normal (non-system) DB context — RLS grants access because the hidden org's `partner_id` puts it in the tech's `accessible_org_ids`. Derive view:

```ts
async function toView(session: typeof supportSessions.$inferSelect) {
  let deviceOnline = false;
  let derivedStatus: string = session.status;
  if (session.deviceId && (session.status === 'ready' || session.status === 'claimed')) {
    const [dev] = await db.select({ status: devices.status }).from(devices)
      .where(eq(devices.id, session.deviceId)).limit(1);
    deviceOnline = dev?.status === 'online';
    const live = await db.select({ id: remoteSessions.id }).from(remoteSessions)
      .where(and(
        eq(remoteSessions.deviceId, session.deviceId),
        inArray(remoteSessions.status, ['pending', 'connecting', 'active']),
      )).limit(1);
    if (session.status === 'ready' && live.length > 0) derivedStatus = 'active';
  }
  const { codeHash: _omit, ...rest } = session;
  return { ...rest, status: derivedStatus, deviceOnline };
}
```

Never return `codeHash`. List caps `limit` at 100, default 50, `orderBy(desc(supportSessions.createdAt))`. For the list endpoint don't call `toView` per row (N+1 — ~100 queries at limit 50): batch-load device statuses and live `remote_sessions` with two `inArray(deviceId, [...])` queries over the page's device ids, then map.

- [ ] **Step 3: Mount in `remote/index.ts`** after the existing sub-routes:

```ts
import { supportSessionRoutes } from './supportSessions';
// ...
remoteRoutes.route('/', supportSessionRoutes);
```

- [ ] **Step 4: Run tests → PASS. Also run `pnpm test --filter=@breeze/api -- routes/remote` (no regressions). Commit** — `feat(api): quick support session create/list/get routes`

---

### Task 5: Public routes — check + redeem

**Files:**
- Create: `apps/api/src/routes/supportPublic.ts`
- Test: `apps/api/src/routes/supportPublic.test.ts`
- Modify: `apps/api/src/index.ts` (mount `api.route('/support', supportPublicRoutes)` next to the installer mount ~line 829, with the `// Public — code is the auth` comment convention)

**Interfaces:**
- Consumes: Task 2 (`normalizeSupportCode`, `redeemSupportSessionSchema`, `hashSupportCode`), `rateLimiter` from `../services/rate-limit`, `getRedis` from `../services/redis`, `hashEnrollmentKey` from `../services/enrollmentKeySecurity`, `getTrustedClientIp`, schema tables.
- Produces:
  - `GET /api/v1/support/check/:code` → `200 { valid: boolean }` (never session details)
  - `POST /api/v1/support/redeem` body `{ code, hostname, osType }` → `200 { serverUrl, enrollmentKey /* raw child key */, enrollmentSecret, sessionId, hardExpiresAt }` | `404 { error: 'invalid or expired code' }`
- Child enrollment key naming: `Quick Support <sessionId first 8>`; `maxUsage: 1`; `expiresAt: now + 15 min`; `supportSessionId: session.id`; `installerPlatform: osType === 'windows' ? 'windows' : 'macos'`; `keySecretHash: null` (global `AGENT_ENROLLMENT_SECRET` applies, returned like installer.ts does).

- [ ] **Step 1: Failing tests** — mirror `installer.ts` test style:
  - check: valid pending unexpired code → `{valid:true}`; unknown / expired / already-claimed → `{valid:false}`; rate limit exceeded → 429; malformed code → `{valid:false}` without DB hit.
  - redeem: happy path → 200 with 64-hex `enrollmentKey`, session flipped `pending→claimed` with `claimedAt/claimedFromIp` set, child key insert received `supportSessionId`.
  - redeem same code twice → second gets 404 (atomic `WHERE status='pending'` guard).
  - redeem expired code → 404, session untouched.
  - rate limit → 429.

- [ ] **Step 2: Implement**

```ts
export const supportPublicRoutes = new Hono();
const REDEEM_LIMIT = 10, CHECK_LIMIT = 30, WINDOW_S = 60;

supportPublicRoutes.get('/check/:code', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rl = await rateLimiter(getRedis(), `support-check:${ip}`, CHECK_LIMIT, WINDOW_S);
  if (!rl.allowed) return c.json({ error: 'rate limited' }, 429);
  const code = normalizeSupportCode(c.req.param('code'));
  if (!code) return c.json({ valid: false });
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ status: supportSessions.status, codeExpiresAt: supportSessions.codeExpiresAt })
      .from(supportSessions).where(eq(supportSessions.codeHash, hashSupportCode(code))).limit(1));
  return c.json({ valid: !!row && row.status === 'pending' && row.codeExpiresAt > new Date() });
});

supportPublicRoutes.post('/redeem', zValidator('json', redeemSupportSessionSchema), async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rl = await rateLimiter(getRedis(), `support-redeem:${ip}`, REDEEM_LIMIT, WINDOW_S);
  if (!rl.allowed) return c.json({ error: 'rate limited' }, 429);
  const data = c.req.valid('json');
  const code = normalizeSupportCode(data.code);
  if (!code) return c.json({ error: 'invalid or expired code' }, 404);

  const result = await withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(supportSessions)
      .where(eq(supportSessions.codeHash, hashSupportCode(code))).limit(1);
    if (!row || row.status !== 'pending' || row.codeExpiresAt < new Date()
        || row.hardExpiresAt < new Date()) return null;

    // Atomic claim — the WHERE status='pending' guard wins the race.
    const [claimed] = await db.update(supportSessions).set({
      status: 'claimed',
      claimedAt: new Date(),
      claimedFromIp: ip === 'unknown' ? null : ip,
    }).where(and(eq(supportSessions.id, row.id), eq(supportSessions.status, 'pending')))
      .returning();
    if (!claimed) return null;

    const [site] = await db.select({ id: sites.id }).from(sites)
      .where(eq(sites.orgId, row.orgId)).limit(1);

    const rawChildKey = randomBytes(32).toString('hex');
    await db.insert(enrollmentKeys).values({
      orgId: row.orgId,
      siteId: site.id,
      name: `Quick Support ${row.id.slice(0, 8)}`,
      key: hashEnrollmentKey(rawChildKey),
      maxUsage: 1,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      supportSessionId: row.id,
      installerPlatform: data.osType === 'windows' ? 'windows' : 'macos',
    });
    return { rawChildKey, sessionId: row.id, hardExpiresAt: row.hardExpiresAt };
  });

  if (!result) return c.json({ error: 'invalid or expired code' }, 404);
  return c.json({
    serverUrl: process.env.PUBLIC_API_URL ?? process.env.API_URL ?? '',
    enrollmentKey: result.rawChildKey,
    enrollmentSecret: process.env.AGENT_ENROLLMENT_SECRET || null,
    sessionId: result.sessionId,
    hardExpiresAt: result.hardExpiresAt,
  });
});
```

Audit the claim via `logSessionAudit('support_session_claimed', row.createdByUserId, row.orgId, { sessionId: row.id, actor: 'end_user' }, ip)` after the claim succeeds — the userId is the session *creator's* (audit rows need one); the real actor is the anonymous end user, so say so in the details.

Before shipping: confirm the public installer redemption flow really does return `AGENT_ENROLLMENT_SECRET` to code-authenticated callers (`installer.ts`) — this endpoint must match existing exposure, not create new exposure. If installer.ts does NOT return it, neither do we (and the Go client falls back to prompt-free enrollment without a secret only if the server allows it).

- [ ] **Step 3: Run tests → PASS. Commit** — `feat(api): public quick support check/redeem endpoints`

---

### Task 6: Enrollment integration — ephemeral devices + session linkage

**Files:**
- Modify: `apps/api/src/routes/agents/enrollment.ts`
- Modify: `apps/api/src/routes/devices/provision.ts` (~lines 168-193, license count)
- Test: extend `apps/api/src/routes/agents/enrollment.test.ts` (or sibling test file if enrollment tests live elsewhere — check for existing `enrollment*.test.ts` first)

**Interfaces:**
- Consumes: `enrollmentKeys.supportSessionId` (Task 1).
- Produces: devices enrolled via a support-derived key are `isEphemeral: true`, linked (`supportSessions.deviceId` set), and skip the partner license count; both license-count queries exclude ephemeral devices.

- [ ] **Step 1: Failing tests**
  - enroll with key having `supportSessionId` + session in `claimed` status → device `isEphemeral: true`; `supportSessions.deviceId` updated.
  - enroll with support key whose session is `ended`/`expired` → 401 `enrollment_key_not_found`-style rejection (reuse the existing invalid-key response shape).
  - enroll with support key when partner is at `maxDevices` → still succeeds (count skipped).
  - normal key → `isEphemeral: false`, no session update.
  - license count query excludes `is_ephemeral` rows (assert the where clause via the mock, or — better — cover in the Task 17 integration test).

- [ ] **Step 2: Implement in `enrollment.ts`**

After the enrollment key lookup succeeds (~line 128), load the linkage:

```ts
const isSupportEnrollment = !!matchingKey.supportSessionId;
if (isSupportEnrollment) {
  const [supportSession] = await db.select().from(supportSessions)
    .where(eq(supportSessions.id, matchingKey.supportSessionId)).limit(1);
  if (!supportSession || supportSession.status !== 'claimed'
      || supportSession.hardExpiresAt < new Date()) {
    // Same 401 shape as enrollment_key_expired
    return c.json({ error: 'Invalid enrollment key', code: 'enrollment_key_expired' }, 401);
  }
}
```

Device-limit check (~lines 543-577): wrap with `if (!isSupportEnrollment) { ... }` AND add `eq(devices.isEphemeral, false)` to the count's `where(and(...))`. Make the same count change in `provision.ts:168-193`.

Hostname-collision lookup (the `existingDevice` query): add `eq(devices.isEphemeral, false)` so repeat quick-support runs on the same machine always insert a fresh row instead of hitting the re-enrollment-token branch.

Device insert (~line 632): add `isEphemeral: isSupportEnrollment,`.

After the insert, inside the same `tx`:

```ts
if (isSupportEnrollment && matchingKey.supportSessionId) {
  await tx.update(supportSessions)
    .set({ deviceId: dev.id })
    .where(and(
      eq(supportSessions.id, matchingKey.supportSessionId),
      eq(supportSessions.status, 'claimed'),
    ));
}
```

(The enrollment tx already runs in system context via `withSystemDbAccessContext` — verify; if the device insert runs under a different context, put the session update in the same context the insert uses.)

- [ ] **Step 3: Run enrollment tests + full agents route suite → PASS. Commit** — `feat(api): ephemeral enrollment via quick support keys`

---

### Task 7: agentWs "ready" hook

**Files:**
- Modify: `apps/api/src/routes/agentWs.ts` (`onOpen`, ~lines 1558-1636)
- Test: extend the existing agentWs test file (locate `agentWs*.test.ts`; if onOpen isn't unit-testable there, cover via Task 17's integration test and note it)

**Interfaces:**
- Consumes: `supportSessions` schema; the `deviceInfo` select already in `onOpen`.
- Produces: support session flips `claimed → ready` when its ephemeral device's WS connects.

- [ ] **Step 1: Add `isEphemeral: devices.isEphemeral` to the existing `deviceInfo` select in `onOpen`, then:**

```ts
if (deviceInfo?.isEphemeral) {
  // Quick Support: agent is online — code was redeemed and the client enrolled.
  await runWithAgentDbAccess(async () => {
    await db.update(supportSessions)
      .set({ status: 'ready' })
      .where(and(
        eq(supportSessions.deviceId, deviceInfo.id),
        eq(supportSessions.status, 'claimed'),
      ));
  });
}
```

Guarded on `isEphemeral` so the 10k-device fleet pays zero extra queries on reconnect. The agent context's org is the hidden org, which matches `support_sessions.org_id`, so RLS passes.

- [ ] **Step 2: Test (unit if feasible, else integration in Task 17) → PASS. Commit** — `feat(api): mark quick support session ready on agent connect`

---

### Task 8: End route + `support_end` command + token revocation

**Files:**
- Modify: `apps/api/src/routes/remote/supportSessions.ts`
- Test: extend `apps/api/src/routes/remote/supportSessions.test.ts`

**Interfaces:**
- Consumes: `sendCommandToAgent(agentId, command)` from `../agentWs` (returns `boolean`), plus a WS force-close helper — grep `agentWs.ts` for the per-agent connection registry and export `closeAgentConnection(agentId: string)` if it isn't already.
- Produces: `POST /remote/support-sessions/:id/end` → `200 { success: true }`; wire command `{ id: 'support-end-<sessionId>', type: 'support_end', payload: { sessionId } }` (Go side consumes this exact shape in Task 13). Exported helper `endSupportSession(sessionId, reason, actorId | null): Promise<boolean>` in a new `apps/api/src/services/quickSupportEnd.ts` so the reaper (Task 9) reuses it.

- [ ] **Step 1: Failing tests** — end a `ready` session: command sent with the device's `agentId`; device row updated `{ agentTokenHash: null, watchdogTokenHash: null, helperTokenHash: null, status: 'decommissioned' }`; the device's agent WS force-closed after revocation; session `{ status: 'ended', endedReason: 'tech', endedAt set }`; audit `support_session_ended`. Ending an already-`ended` session → 409. Ending a `pending` session (never claimed) → 200, no command attempted.

- [ ] **Step 2: Implement service `quickSupportEnd.ts`**

```ts
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { devices, supportSessions } from '../db/schema';
import { sendCommandToAgent, closeAgentConnection } from '../routes/agentWs';

export async function endSupportSession(
  sessionId: string,
  reason: 'tech' | 'end_user' | 'expired' | 'error',
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [session] = await db.select().from(supportSessions)
      .where(eq(supportSessions.id, sessionId)).limit(1);
    if (!session || session.status === 'ended' || session.status === 'expired') return false;

    if (session.deviceId) {
      const [dev] = await db.select({ agentId: devices.agentId }).from(devices)
        .where(eq(devices.id, session.deviceId)).limit(1);
      if (dev) {
        // Deliver self-destruct first (WS is still up), then revoke, then
        // force-close the WS. The close is load-bearing: if support_end is
        // lost, a healthy WS would otherwise linger until the 8h hard cap
        // (client online → offline dead-man never fires). Close → reconnect
        // → re-auth fails → dead-man cleans up within ~10 min.
        sendCommandToAgent(dev.agentId, {
          id: `support-end-${sessionId}`,
          type: 'support_end',
          payload: { sessionId },
        } as never);
        await db.update(devices).set({
          agentTokenHash: null, watchdogTokenHash: null, helperTokenHash: null,
          status: 'decommissioned',
        }).where(eq(devices.id, session.deviceId));
        closeAgentConnection(dev.agentId);
      }
    }

    await db.update(supportSessions).set({
      status: reason === 'expired' ? 'expired' : 'ended',
      endedAt: new Date(),
      endedReason: reason,
    }).where(eq(supportSessions.id, sessionId));
    return true;
  }));
}
```

(Cast/typing: match the actual `AgentCommand` type from agentWs instead of `as never`.) Route handler: load session under normal RLS context (proves the caller can see it), 409 if terminal, then call `endSupportSession(id, 'tech')`, then `logSessionAudit('support_session_ended', auth.userId, session.orgId, { sessionId: id, reason: 'tech' }, ip)`.

Also verify `POST /remote/sessions` rejects devices with `status === 'decommissioned'` — if there's no such guard, add one here (an ended-but-still-lingering client must not be connectable); assert it in Task 17's chain test.

- [ ] **Step 3: Run → PASS. Commit** — `feat(api): end quick support session with agent self-destruct + token revocation`

---

### Task 9: Reaper worker

**Files:**
- Create: `apps/api/src/jobs/quickSupportReaper.ts`
- Test: `apps/api/src/jobs/quickSupportReaper.test.ts`
- Modify: `apps/api/src/index.ts` (initialize/shutdown alongside `initializeEnrollmentKeyCleanupWorker`, ~lines 157-177)
- Possibly create: `apps/api/src/services/deviceDeletion.ts` (see Step 2)

**Interfaces:**
- Consumes: `endSupportSession` (Task 8), BullMQ pattern from `apps/api/src/services/ssoDomainRecheckWorker.ts` / `apps/api/src/jobs/enrollmentKeyCleanup.ts`.
- Produces: `initializeQuickSupportReaper(): Promise<void>`, `shutdownQuickSupportReaper(): Promise<void>`; queue name `quick-support-reaper`, repeat every 5 min, job name `reap` (no colons in ids).

- [ ] **Step 1: Failing tests** for the pure `reapOnce()` function (export it for tests; the worker just calls it):
  - `pending` past `codeExpiresAt` → `expired`.
  - `claimed` with no `deviceId` and `claimedAt` older than 20 min → `expired` (client crashed between redeem and enroll — the child key is long dead; don't leave the tech's panel on "Client connecting…" for 8 h).
  - `claimed`/`ready` past `hardExpiresAt` → `endSupportSession(id, 'expired')` called.
  - `ready` session whose device `status='offline'` and `lastSeenAt` older than 5 min → `endSupportSession(id, 'end_user')` (deviation #6: end-user stop detection).
  - ended/expired sessions with `deviceId` and `endedAt` older than 6 h → device purged and `supportSessions.deviceId` nulled (FK `ON DELETE SET NULL`).

- [ ] **Step 2: Implement**

```ts
export async function reapOnce(): Promise<void> {
  // 1. Expire unredeemed codes
  await db.update(supportSessions).set({ status: 'expired', endedAt: new Date(), endedReason: 'expired' })
    .where(and(eq(supportSessions.status, 'pending'), lt(supportSessions.codeExpiresAt, new Date())));

  // 1b. Claimed-but-never-enrolled limbo (client crashed between redeem and enroll)
  await db.update(supportSessions).set({ status: 'expired', endedAt: new Date(), endedReason: 'error' })
    .where(and(
      eq(supportSessions.status, 'claimed'),
      isNull(supportSessions.deviceId),
      lt(supportSessions.claimedAt, new Date(Date.now() - 20 * 60_000)),
    ));

  // 2. Hard-cap enforcement
  const overdue = await db.select({ id: supportSessions.id }).from(supportSessions)
    .where(and(inArray(supportSessions.status, ['claimed', 'ready']), lt(supportSessions.hardExpiresAt, new Date())));
  for (const s of overdue) await endSupportSession(s.id, 'expired');

  // 3. End-user stop: ready session, device offline > 5 min
  const stale = await db.select({ id: supportSessions.id }).from(supportSessions)
    .innerJoin(devices, eq(devices.id, supportSessions.deviceId))
    .where(and(
      eq(supportSessions.status, 'ready'),
      eq(devices.status, 'offline'),
      lt(devices.lastSeenAt, new Date(Date.now() - 5 * 60_000)),
    ));
  for (const s of stale) await endSupportSession(s.id, 'end_user');

  // 4. Purge ephemeral device rows 6h after end (audit_logs have no device FK and survive)
  const purgeable = await db.select({ id: supportSessions.id, deviceId: supportSessions.deviceId })
    .from(supportSessions)
    .where(and(
      inArray(supportSessions.status, ['ended', 'expired']),
      isNotNull(supportSessions.deviceId),
      lt(supportSessions.endedAt, new Date(Date.now() - 6 * 3_600_000)),
    ));
  for (const s of purgeable) await purgeEphemeralDevice(s.deviceId!);
}
```

`purgeEphemeralDevice(deviceId)`: **first inspect the existing `DELETE /devices/:id` handler** (in `apps/api/src/routes/devices/` — grep `\.delete\(` there). If its cascade logic is inline, extract it to `apps/api/src/services/deviceDeletion.ts` as `deleteDeviceCascade(deviceId: string): Promise<void>` and call it from both the route and the reaper. It must delete FK children that lack `ON DELETE CASCADE` — at minimum `remote_sessions` rows (`device_id` NOT NULL, no cascade) — before the device row. Guard the reaper call: only delete when the device row has `isEphemeral === true` (never let a corrupted session row purge a real device).

Worker wrapper: copy `ssoDomainRecheckWorker.ts` structure verbatim (queue getter, `runWithSystemDbAccess`, `concurrency: 1`, remove-existing-repeatables then `queue.add('reap', {}, { repeat: { every: 5 * 60 * 1000 }, removeOnComplete: { count: 10 }, removeOnFail: { count: 50 } })`).

- [ ] **Step 3: Run tests → PASS. Register init/shutdown in `index.ts`. Commit** — `feat(api): quick support reaper worker`

---

### Task 10: Exclusion sweep — hide the quick_support org + ephemeral devices

**Files (known call sites — the sweep must ALSO grep for more):**
- Modify: `apps/api/src/routes/orgs.ts` — org list endpoint(s): grep `from(organizations)` selects that return org lists.
- Modify: `apps/api/src/routes/partner.ts` (~lines 99-140 org/device dashboard buckets)
- Modify: main devices list route in `apps/api/src/routes/devices/core.ts` — default `eq(devices.isEphemeral, false)` filter.
- Verify only (no change): license counts already done in Task 6.
- Test: extend the touched routes' sibling test files.

**Interfaces:** none new — behavioral filters only.

- [ ] **Step 1: Grep checklist (run all; record findings in the PR description):**

```bash
grep -rn "from(organizations)" apps/api/src/routes apps/api/src/services --include='*.ts' | grep -v test
grep -rn "from(organizations)" apps/api/src/routes/aiTools*.ts
grep -rn "count(\*)" apps/api/src/routes apps/api/src/services --include='*.ts' | grep -iv test | grep -i device
```

For each hit, decide: **user-facing org enumeration or device count → exclude** (`ne(organizations.type, 'quick_support')` / `eq(devices.isEphemeral, false)`); **internal/RLS plumbing → leave alone**.

**DO NOT touch `computeAccessibleOrgIds` (`apps/api/src/middleware/auth.ts:208`) or its `bearerTokenAuth.ts` twin** — the hidden org MUST stay in `accessibleOrgIds` or RLS blocks all tech access to `support_sessions`. Add a comment there saying exactly that.

**DO NOT exclude ephemeral devices from the status-upkeep path** — whatever job/logic flips `devices.status` to `offline` by `lastSeenAt` must keep processing ephemeral devices, or Task 9's end-user-stop detection silently never fires.

Sweep beyond enumeration too: alert/monitor *evaluation* paths that apply to all devices at the code level regardless of policy rows (e.g. default event-log monitoring), and billing/usage rollup queries — an ephemeral device must never page anyone or appear on an invoice.

- [ ] **Step 2: Failing tests** — org list endpoint response omits a seeded `type='quick_support'` org; devices list omits an `isEphemeral` device; both still returned when queried directly by id (detail routes untouched).

- [ ] **Step 3: Apply filters, run the full API unit suite (`pnpm test --filter=@breeze/api`) → PASS. Commit** — `feat(api): hide quick support org + ephemeral devices from listings`

---

### Task 11: Support client download route

**Files:**
- Modify: `apps/api/src/routes/supportPublic.ts` (add `GET /download/:platform`)
- Test: extend `apps/api/src/routes/supportPublic.test.ts`

**Interfaces:**
- Consumes: `getBinarySource`, `getGithubAgentUrl(os, arch)` from `../services/binarySource`; the disk/S3 streaming pattern from `apps/api/src/routes/viewers/download.ts` and the filename-embedding pattern from the public enrollment-keys download route (`apps/api/src/routes/enrollment-keys` public sub-app, mounted at `index.ts:827`) — read that handler first and mirror how it sets `Content-Disposition` with a token-bearing filename.
- Produces: `GET /api/v1/support/download/windows?code=<CODE>` → binary stream/redirect. Download filename: `breeze-support-<CODE>-<apiHost>.exe` where `<apiHost>` is `PUBLIC_API_URL` host (no scheme) — e.g. `breeze-support-KTM4H7P2X-us.2breeze.app.exe`. The Go client (Task 12) parses this exact format.

- [ ] **Step 1: Failing tests** — valid pending code + platform windows → 200 with `Content-Disposition: attachment; filename="breeze-support-<CODE>-<host>.exe"`; invalid/claimed code → 404; platform `macos` → 400 `{ error: 'macOS support client coming soon' }`; rate limited per IP (reuse `support-check` limiter budget).

- [ ] **Step 2: Implement** — soft-validate the code (same query as `/check`); resolve the agent binary: `getBinarySource() === 'github'` → `fetch(getGithubAgentUrl('windows', 'amd64'))` and stream the response body through with our Content-Disposition (a redirect would lose the filename; note the ~60 MB proxy cost as acceptable v1); `local`/S3 → mirror `viewers/download.ts` disk/presign logic but force the filename. Build `<apiHost>` via `new URL(process.env.PUBLIC_API_URL ?? '').host`.

- [ ] **Step 2b: Signing / SmartScreen check (release-blocking).** Verify the binary this route serves is Authenticode-signed (pull a GitHub-release `breeze-agent.exe`, check with `Get-AuthenticodeSignature`). Per-session filename renames do NOT invalidate the signature or SmartScreen reputation — both key on content hash + cert — but serving an *unsigned* exe puts consumers in front of a "Windows protected your PC" wall at the scariest possible moment, and AV/EDR heuristics pile on (renamed binary from Downloads installing a temp service). If unsigned, extend the MSI signing pipeline to sign the raw exe before this task ships, record the signer name for Task 16's landing copy, and expect a reputation ramp for a newly-signed binary.

- [ ] **Step 3: Run → PASS. Commit** — `feat(api): quick support client download with code-embedded filename`

---

### Task 12: Go agent — `support` command, Tier 1 (user-mode)

**Files:**
- Create: `agent/internal/agentapp/support.go`
- Test: `agent/internal/agentapp/support_test.go`
- Modify: `agent/internal/agentapp/main.go` (register `supportCmd` in `init()` ~line 257; basename dispatch in `Main` ~line 309)
- Modify: `agent/pkg/api/client.go` (add `RedeemSupportCode`)
- Modify: `agent/internal/config/config.go` (add runtime-only `SupportMode bool` + `SupportSessionID string`, both `mapstructure:"-"`)

**Interfaces:**
- Consumes: `POST /api/v1/support/redeem` (Task 5 response shape), `enrollDevice`-style enrollment via `client.Enroll` (`pkg/api/client.go:181`), `config.SaveTo(cfg, cfgFile)`, `startAgentFn(cfg)` (`main.go:650` area).
- Produces: `breeze-agent support [--code XXX] [--server URL]`; filename auto-dispatch (`breeze-support-<CODE>-<host>.exe` → support mode with code+server pre-filled); `resolveSupportInput(argv0, codeFlag, serverFlag) (code, server string, err error)` (pure, tested); temp config dir `%TEMP%\breeze-support-<pid>\`.

- [ ] **Step 1: Failing table-driven tests for `resolveSupportInput`**

```go
func TestResolveSupportInput(t *testing.T) {
	cases := []struct {
		name, argv0, codeFlag, serverFlag string
		wantCode, wantServer              string
		wantErr                           bool
	}{
		{"flags win", "breeze-agent.exe", "KTM-4H7-P2X", "https://eu.2breeze.app", "KTM4H7P2X", "https://eu.2breeze.app", false},
		{"filename parsed", "breeze-support-KTM4H7P2X-us.2breeze.app.exe", "", "", "KTM4H7P2X", "https://us.2breeze.app", false},
		{"browser copy suffix", "breeze-support-KTM4H7P2X-us.2breeze.app (1).exe", "", "", "KTM4H7P2X", "https://us.2breeze.app", false},
		{"firefox copy suffix (no space)", "breeze-support-KTM4H7P2X-us.2breeze.app(1).exe", "", "", "KTM4H7P2X", "https://us.2breeze.app", false},
		{"case insensitive", "Breeze-Support-ktm4h7p2x-us.2breeze.app.exe", "", "", "KTM4H7P2X", "https://us.2breeze.app", false},
		{"nothing embedded, no flags", "breeze-agent.exe", "", "", "", "", true}, // caller falls back to prompt
	}
	// filename regex: (?i)^breeze-support-([a-z2-9]{9})-(.+?)(?:\s?\(\d+\))?\.exe$
	// (space before "(1)" optional — Chrome/Edge insert one, Firefox doesn't)
}
```

Run: `cd agent && go test -race ./internal/agentapp/ -run TestResolveSupportInput` → FAIL.

- [ ] **Step 2: Implement `support.go`**

```go
var supportCodeFlag string

var supportCmd = &cobra.Command{
	Use:   "support",
	Short: "Run a one-time Quick Support session (nothing is permanently installed)",
	Run:   func(cmd *cobra.Command, args []string) { runSupportSession() },
}
```

`runSupportSession()` flow (Tier 1):
1. `resolveSupportInput(os.Args[0], supportCodeFlag, serverURL)`; on err → interactive prompt: `fmt.Print("Enter your support code: ")` + `bufio` read + `normalize`, and server prompt defaulting to a `-ldflags`-injectable `defaultSupportServer` var.
2. `POST <server>/api/v1/support/redeem` with `{code, hostname, osType: "windows"}` (new `pkg/api` func `RedeemSupportCode(server, code, hostname, osType string) (*SupportRedeemResponse, error)`; struct fields `ServerURL, EnrollmentKey, EnrollmentSecret, SessionID, HardExpiresAt`). Friendly errors: 404 → "That code is invalid or has expired — ask your technician for a new one."
3. Build temp workspace `dir := filepath.Join(os.TempDir(), fmt.Sprintf("breeze-support-%d", os.Getpid()))`; `cfgFile = filepath.Join(dir, "agent.yaml")`. **Never touch `C:\ProgramData\Breeze`** — the machine may run a real enrolled agent.
4. Enroll: reuse the body of `enrollDevice` (`main.go:948`) — refactor its core into `enrollWithConfig(cfg *config.Config, cfgFile, enrollmentKey, secret string) error` so both the `enroll` command and support mode call it (mechanical extraction, no behavior change). Set `cfg.Watchdog.Enabled = false`, `cfg.SupportMode = true`, `cfg.SupportSessionID = resp.SessionID`, log file inside the temp dir.
5. Start: call `startAgentFn(cfg)` — as a plain foreground process `IsService=false / IsHeadless=false`, so desktop commands take the **in-process capture path** (`handlers_desktop.go:232 h.desktopMgr.StartSession`) — no SYSTEM helper needed. Support-mode gating inside `startAgent`: when `cfg.SupportMode`, skip watchdog bootstrap, skip updater start, skip collectors except the minimal hardware snapshot used at enrollment (grep `startAgent` for `bootstrapWatchdog` / updater / collector starts and gate each on `!cfg.SupportMode`).
6. Console status (this IS the v1 status window):

```
  Breeze Quick Support
  ─────────────────────────────────────
  Connected. Waiting for your technician…
  Nothing is permanently installed. Close this window
  or press Ctrl+C at any time to stop sharing.
```

  Print state changes ("Technician connected." / "Technician disconnected.") by setting `h.desktopMgr.OnSessionStarted/OnSessionStopped` style callbacks (OnSessionStopped already exists for direct mode — `heartbeat.go:570`; add OnSessionStarted symmetrically if absent).
7. Signal handling: on Ctrl+C/SIGTERM → `supportCleanup(dir)` (Task 13) then exit. (A console X-close arrives as SIGTERM with a ~5s grace budget on Windows — keep cleanup free of network waits.)
8. Dead-man switch goroutine: if the WS client reports disconnected continuously for 10 min, or `time.Now()` passes `HardExpiresAt` → print notice, `supportCleanup(dir)`, exit. (Server-side end force-closes the WS after revoking tokens — Task 8 — so even a lost `support_end` converges here in ≤10 min: reconnect attempts fail re-auth and the client counts as disconnected.)

`Main()` basename dispatch (next to the `breeze-desktop-helper` special case at `main.go:309`):

```go
// Second condition guards the Tier 2 service copy (breeze-support-svc.exe),
// which is launched with an explicit `support --service-run ...` argv —
// without it the prefix dispatch would prepend a SECOND "support" and cobra
// would parse the duplicate as a positional arg.
if strings.HasPrefix(strings.ToLower(filepath.Base(os.Args[0])), "breeze-support") &&
	(len(os.Args) < 2 || os.Args[1] != "support") {
	rootCmd.SetArgs(append([]string{"support"}, os.Args[1:]...))
}
```

- [ ] **Step 3: `go build ./...` + `go test -race ./internal/agentapp/` → PASS. Manual smoke on the Windows test VM (address in the `windows_test_vm` note — not recorded here, this repo is public) against a wt-stack: run `breeze-agent.exe support --code <code> --server <url>`, verify device appears ephemeral + session goes `ready`. Commit** — `feat(agent): quick support mode (tier 1 user-session)`

---

### Task 13: Go agent — `support_end` handler, self-cleanup, self-delete

**Files:**
- Modify: `agent/internal/remote/tools/types.go` (add `CmdSupportEnd = "support_end"` near `CmdSelfUninstall` ~line 200)
- Create: `agent/internal/heartbeat/handlers_support.go`
- Test: `agent/internal/heartbeat/handlers_support_test.go`

**Interfaces:**
- Consumes: command shape from Task 8: `{ id, type: 'support_end', payload: { sessionId } }`; registration pattern from `handlers_uninstall.go:14`; Windows self-delete trampoline from `handlers_uninstall.go:236-246`.
- Produces: `handleSupportEnd` registered in `handlerRegistry`; `supportCleanup(workDir string)` — stops desktop sessions, removes temp workspace, schedules exe self-delete, exits 0.

- [ ] **Step 1: Failing tests** — table-driven: `handleSupportEnd` on a heartbeat with `supportMode=false` returns an error result ("not a support session") and does NOT exit — **the guard that stops a forged/misrouted command from nuking a real agent**; with `supportMode=true` it returns success and invokes the (injected, test-faked) cleanup func. Inject via package-level `var supportCleanupFn = supportCleanup` for testability.

- [ ] **Step 2: Implement**

```go
func init() { handlerRegistry[tools.CmdSupportEnd] = handleSupportEnd }

func handleSupportEnd(h *Heartbeat, cmd Command) tools.CommandResult {
	if !h.supportMode {
		return tools.CommandResult{Success: false, Error: "not a support session"}
	}
	go func() {
		time.Sleep(500 * time.Millisecond) // let the result flush over WS
		supportCleanupFn(h.supportWorkDir)
	}()
	return tools.CommandResult{Success: true, Output: "support session ending"}
}
```

`supportCleanup`: stop active desktop sessions via the session manager; `os.RemoveAll(workDir)`; Windows self-delete exactly like `handlers_uninstall.go:236` (`cmd /C ping 127.0.0.1 -n 3 >NUL & del /f "<exe>"`, detached); `os.Exit(0)`. Thread `supportMode`/`supportWorkDir` into `Heartbeat` from `cfg` the same way `isService`/`isHeadless` are copied at `heartbeat.go:417-418`. Match `tools.CommandResult`'s real field names (check `tools/types.go`).

- [ ] **Step 3: `go test -race ./internal/heartbeat/ -run TestHandleSupportEnd` → PASS. Manual: end from API, watch the client clean up and delete itself on the test VM. Commit** — `feat(agent): support_end self-destruct handler`

---

### Task 14: Go agent — Tier 2 (elevated temporary service) — **Milestone B**

**Files:**
- Create: `agent/internal/agentapp/support_service_windows.go` (build tag `windows`)
- Test: `agent/internal/agentapp/support_service_windows_test.go` (pure helpers only; service lifecycle is manual-verified)
- Modify: `agent/internal/agentapp/support.go`

**Interfaces:**
- Consumes: `golang.org/x/sys/windows/svc` + `svc/mgr` (service create/start/stop/delete), elevation check via `windows.Token.IsElevated()`, existing service-mode startup (`runAsService`, `service_windows.go:106`), SYSTEM desktop-helper spawn machinery (works when `IsService=true`).
- Produces: when the support process is launched **elevated** (user right-clicked → Run as administrator, or accepts the UAC prompt on our re-launch offer), it installs a temporary service `BreezeQuickSupport` running `<tempdir>\breeze-support-svc.exe support --service-run --config <tempdir>\agent.yaml --monitor-pid <console pid>`, starts it, and the console process becomes a monitor. The service watches the monitor PID and self-tears-down when it dies. Teardown removes service + files.

- [ ] **Step 1: Flow to implement**

1. In `runSupportSession()` after redeem+enroll: if `isElevated()` → Tier 2 path; else print `TIP: for full control (admin prompts), close this and re-run as administrator.` and continue Tier 1. (No forced UAC prompt in v1 — "Run as administrator" is the documented path; a mid-session elevation request is Phase 3.)
2. Tier 2 setup: copy own exe into the temp workspace twice — `breeze-support-svc.exe` (service binary) and `breeze-desktop-helper.exe`. **Investigation sub-step:** find how `sessionbroker.SpawnHelperInSession` / `spawnHelperForDesktop` (`handlers_desktop_helper.go:481,589`) resolves the desktop-helper binary path; if it assumes the Program Files install dir, add a fallback to "directory of the running executable" (benefits dev builds too). This is the riskiest line in the Go work — timebox it and, if the resolution is tangled, ship Tier 2 as service-without-helper (secure-desktop capture degraded) and file a follow-up issue.
3. Install: `mgr.Connect()` → `m.CreateService("BreezeQuickSupport", svcExe, mgr.Config{DisplayName: "Breeze Quick Support (temporary)", StartType: mgr.StartManual}, "support", "--service-run", "--config", cfgFile, "--monitor-pid", strconv.Itoa(os.Getpid()))` → `s.Start()`. Fail → warn and fall back to Tier 1 inline.
4. `--service-run` (hidden flag): sets `cfg.SupportMode` from the loaded config dir and enters the existing `runAsService` path (SCM). Service loads the already-enrolled temp config; `IsService=true` → broker + SYSTEM desktop helper → UAC/secure-desktop capture works.
5. **Service-side monitor watchdog — THE consent guarantee.** In Tier 2 the console is only an indicator; capture runs in the SYSTEM service. If the user closes the console with X (~5s SIGTERM grace — `sc stop` may not finish) or kills it from Task Manager (no grace at all), the service must not keep sharing the screen with no visible indicator. So on start the service opens the `--monitor-pid` process handle (`windows.OpenProcess(SYNCHRONIZE, ...)`) and a goroutine `WaitForSingleObject`s on it; when the monitor dies for ANY reason → full teardown (stop desktop sessions, `sc delete` self, trampoline-delete both exes, exit). Never rely on the monitor's own close handling for teardown — that path is best-effort UX only. Missing/dead `--monitor-pid` at service start → refuse to start (fail safe).
6. Console monitor: polls service status; Ctrl+C → stop+delete service, cleanup (best-effort — the watchdog in step 5 is the guarantee). `supportCleanup` on the service side (support_end command) must also `sc stop/delete BreezeQuickSupport` — reuse the `sc.exe stop/delete` invocation pattern from `selfUninstallWindows` (`handlers_uninstall.go:209`) with the temp service name, then delete both copied exes via the trampoline.

- [ ] **Step 2: Unit-test the pure parts** (service args builder, `isElevated` wrapper injectable). `go build ./... && go test -race ./...` → PASS.

- [ ] **Step 3: Manual verification on the Windows test VM:** run elevated → temp service appears (`sc query BreezeQuickSupport`), desktop session shows UAC prompts; end session → service gone, files gone; **kill the console monitor from Task Manager mid-session → service self-tears-down within seconds (`sc query` gone, capture stops)** — this is the consent-guarantee check, do not skip it. Commit** — `feat(agent): quick support tier 2 temporary service (elevated)`

---

### Task 15: Web — Quick Support page (create dialog + status panel + list)

**Files:**
- Create: `apps/web/src/components/remote/QuickSupportPage.tsx`
- Test: `apps/web/src/components/remote/QuickSupportPage.test.tsx`
- Create: `apps/web/src/pages/remote/quick-support.astro` (DashboardLayout + `<QuickSupportPage client:load />`)
- Modify: `apps/web/src/pages/remote/index.astro` (add a "Quick Support" card next to the existing terminal/files/sessions cards)

**Interfaces:**
- Consumes: `fetchWithAuth` (`stores/auth.ts:463`), `runAction`/`ActionError` (`lib/runAction.ts`), `showToast`, `ConnectDesktopButton` (`components/remote/ConnectDesktopButton.tsx` — pass `deviceId={session.deviceId}` when set), Task 4/8 endpoints.
- Produces: page at `/remote/quick-support` with `data-testid` attributes: `quick-support-create`, `quick-support-code`, `quick-support-copy-link`, `quick-support-status`, `quick-support-connect`, `quick-support-end`, `quick-support-list`.

- [ ] **Step 1: Failing component tests** (Vitest + jsdom, mirror a sibling like `EnrollmentKeyManager` tests): create → code displayed in `XXX-XXX-XXX` format + copy-link button writes `landingUrl` to clipboard; status polling transitions render "Waiting for user" (`pending`) → "User connected — ready" (`ready` + `deviceOnline`) → Connect button appears; End calls `POST .../end` via `runAction`; list renders recent sessions with attribution label.

- [ ] **Step 2: Implement.** Create dialog: attribution org select (options from existing org store / `GET /organizations` — hidden org is already server-filtered by Task 10) + label input; submit via `runAction({ request: () => fetchWithAuth('/remote/support-sessions', { method: 'POST', body: JSON.stringify(payload) }), errorFallback: 'Failed to create support session', successMessage: () => 'Support session created' })`. After create, show the code big + copyable link, and poll `GET /remote/support-sessions/:id` every 3 s (recursive `setTimeout` in a `useRef`, cleared on unmount — the `ConnectDesktopButton.tsx:399` pattern; stop polling on terminal states). When `deviceId && deviceOnline`, render `<ConnectDesktopButton deviceId={session.deviceId} deviceName={session.attributionLabel ?? 'Quick Support device'} deviceOs="windows" />` plus the End button (runAction, 401 → return, non-ActionError → toast). Status copy: pending → "Waiting for the user to run the client…", claimed → "Client connecting…", ready → "Ready to connect", active → "Session in progress", ended/expired → terminal badge. All user-visible strings via the i18n layer (literal-key `t()` — mirror a recently-added sibling component), with every new key added to en AND all other locale catalogs in the same commit.

- [ ] **Step 3: `pnpm test --filter=@breeze/web -- QuickSupport` → PASS; i18n literal-key + locale-parity suites → PASS; `pnpm astro check` clean (types in tests count). Commit** — `feat(web): quick support page`

---

### Task 16: Web — public `/quick` landing page

**Files:**
- Create: `apps/web/src/pages/quick.astro` (model: `accept-invite.astro` — `AuthLayout`, no auth guard)
- Create: `apps/web/src/components/quick/QuickLandingPage.tsx`
- Test: `apps/web/src/components/quick/QuickLandingPage.test.tsx`

**Interfaces:**
- Consumes: plain `fetch` (no bearer) against `import.meta.env.PUBLIC_API_URL || ''` + `/api/v1/support/check/:code` and download URL `/api/v1/support/download/windows?code=<CODE>`; `normalizeSupportCode`/`formatSupportCode` from `@breeze/shared`.
- Produces: `/quick` and `/quick?code=XXX`. `data-testid`s: `quick-code-input`, `quick-code-submit`, `quick-download-windows`, `quick-invalid-code`.

- [ ] **Step 1: Failing tests** — no `?code` → code-entry form; submit normalizes (`ktm 4h7 p2x` → checks `KTM4H7P2X`); check returns `{valid:false}` → `quick-invalid-code` visible, no download button; `{valid:true}` → download button with href containing the code + plain-language copy ("Your technician wants to help…", "This program runs once and removes itself…") + macOS row disabled with "coming soon".

- [ ] **Step 2: Implement.** Read code from `location.search` on mount; validate via `/support/check`; render entry-form vs landing states. Download = plain `<a href>` (browser download, no fetch). Include the manual-fallback instruction under the button: "If the download prompts for a code, enter: **XXX-XXX-XXX**."

This page is consumer-facing: localize it first-class (same i18n rules as Task 15). Set honest expectations for the Windows prompt — show the expected publisher from the Authenticode cert recorded in Task 11 Step 2b ("You'll see a Windows prompt — the publisher should read *<signer>*"). Do NOT ship copy that coaches users past an unsigned-binary warning; if the signing check fails, this page is blocked on it.

- [ ] **Step 3: Run tests → PASS. Verify CSP: the page fetches the API origin — confirm `apps/web/src/middleware.ts` CSP `connect-src` already allows it (it must, all islands do). Commit** — `feat(web): public quick support landing page`

---

### Task 17: RLS + full-chain integration tests

**Files:**
- Create: `apps/api/src/__tests__/integration/supportSessionsRls.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/quickSupportChain.integration.test.ts`
(Confirm placement/naming against existing files in that directory and the dual hand-list convention — integration files must be excluded from the unit config; check `vitest.integration.config.ts` include globs.)

**Interfaces:** consumes everything above against real Postgres (`:5433` per `test_integration_config_run_mechanics`).

- [ ] **Step 1: RLS suite** — as `breeze_app` with partner-A context: SELECT partner-B's support_sessions → 0 rows; forged INSERT into partner-B's hidden org → fails `42501` (assert the error code — don't let a memoized fixture make it vacuous); rls-coverage contract test still green (Shape 1 auto-discovery: `pnpm vitest run -c vitest.config.rls.ts`).

- [ ] **Step 2: Chain suite** — seed partner + tech user; `POST /remote/support-sessions` → code; `POST /support/redeem` → child key; `POST /agents/enroll` with it → device `is_ephemeral=true`, session `deviceId` linked, status `claimed`; second redeem of same code → 404; enroll at maxDevices=0 partner limit → still succeeds for support key, fails for a normal key; `endSupportSession(id,'tech')` → device tokens nulled + status decommissioned; creating a remote session against that decommissioned device → rejected; `reapOnce()` after faking `endedAt` 7 h back → device row gone, `supportSessions.deviceId` null.

- [ ] **Step 3: Run integration suite locally against the docker Postgres → PASS. Commit** — `test(api): quick support RLS + end-to-end chain integration tests`

---

### Task 18: Final verification sweep

- [ ] `pnpm test` (all workspaces), `cd agent && go test -race ./...`, `pnpm astro check`, `pnpm db:check-drift` — all green.
- [ ] Type Check includes tests + site-scope contract (CI parity — run `pnpm typecheck` if defined).
- [ ] Manual e2e via the `worktree-stack` skill: full happy path from create → landing page → client on Windows VM → viewer connect → end → self-delete. Verify as `breeze_app` in psql: forge a cross-tenant support_session insert → RLS rejection.
- [ ] Verify the served support binary is Authenticode-signed (Task 11 Step 2b) and the landing-page publisher copy matches the cert.
- [ ] End a session while the client WS is healthy and confirm the client exits promptly (support_end path) — then repeat with the command handler artificially disabled and confirm the WS force-close → dead-man path converges in ≤10 min.
- [ ] Milestone B only: the Task Manager–kill teardown check from Task 14 Step 3.
- [ ] Grep sweep from Task 10 recorded in PR description; confirm no `support_sessions` consumer bypasses the status guards (`grep -rn "supportSessions" apps/api/src --include='*.ts' | grep -v test`).
- [ ] Update `apps/docs` remote-access page with a Quick Support section (brief; full docs pass at release via the release skill).
- [ ] Commit any stragglers; run `superpowers:requesting-code-review` / open PR.

---

## Self-review notes

- **Spec coverage:** flows (T4/5/11/12/15/16), lifecycle+states (T1/5/7/8/9), data model (T1), hidden org (T3/T10), enrollment guards (T6), reaper 3-layer cleanup (T9/T13 dead-man/T8 cooperative), security (rate limits T5/T11, revocation T8, forged-command guard T13, RLS T1/T17), audit (T4/5/8), UI (T15/16), Tier 2 (T14), testing standards (each task + T17). Consent posture needs no code: sessions on ephemeral devices use the default prompt config; running the client is consent (spec) — the hidden org has no `config_policy_remote_access_settings`, so `resolveRemoteSessionPromptConfig` falls back to defaults; verify during T18 manual e2e that the default doesn't hard-block (if default is `consent` + `block`, add a support-mode bypass in the offer path — check `remoteAccessPolicy.ts` defaults during T4).
- **Known risks, called out in-task:** desktop-helper binary path resolution for Tier 2 (T14, timeboxed with degrade path); GitHub-mode 60 MB proxy streaming (T11); org-exclusion sweep completeness (T10 grep checklist + PR record).
- Types/names used across tasks were cross-checked: `endSupportSession(sessionId, reason)` (T8→T9), redeem response `{serverUrl, enrollmentKey, enrollmentSecret, sessionId, hardExpiresAt}` (T5→T12), command `support_end` + payload (T8→T13), filename format (T11→T12), `SupportSessionView.deviceOnline` (T4→T15).
- **2026-07-17 review pass (items 7–13 above):** migration split (`-a-`/`-b-` enum-use rule — the original single file failed on first run); WS force-close on end (dead-man convergence ≤10 min instead of the 8h cap) + decommissioned-device connect guard; Tier 2 service-side monitor watchdog (the consent guarantee — console kill must always stop sharing); claimed-limbo reaping; full-uuid org slug; system-token `partnerId` guard; batched list view (N+1); Firefox rename tolerance; basename-dispatch double-`support` guard for the svc binary; i18n + signing/SmartScreen made explicit; Milestone A/B split so Tier 1 can ship without waiting on the Tier 2 unknowns.
