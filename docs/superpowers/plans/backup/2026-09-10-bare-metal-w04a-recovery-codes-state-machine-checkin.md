---
tracking_issue: LanternOps/breeze#5493
---

# Wave 04a — Recovery codes, `bare_metal_recoveries` state machine, heartbeat check-in, token-driven rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator creates a bare-metal recovery for a device + snapshot and gets a short one-time code; a machine booted from Breeze media exchanges that code for a recovery token and bootstrap, reports each rebuild phase to the server, and the recovery is marked complete only when the restored device's first heartbeat carries the marker the engine wrote. Everything the console (W04b) needs from the server and the helper exists after this wave; the console itself is W04b.

**Architecture:** New org-scoped table `bare_metal_recoveries` (shape-1 RLS, four registry lists + export policy) holds the code hash, nonce hash, identity mode, state, timestamps, plan and result. Three new API surfaces on the existing `bmr` route files: session-authed `POST/GET /backup/bmr/recoveries[/:id]`, and public token-less `POST /bmr/recover/exchange` (code → freshly minted recovery token + bootstrap, reusing `POST /bmr/recover/authenticate`'s bootstrap builder) plus public token-authed `POST /bmr/recover/progress` (phase transitions carrying the engine's `Plan`/`Result`). The heartbeat handler gains a one-time marker check that flips the recovery to `checked_in`, stamps `devices.recovered_at`, and acks so the agent deletes the marker. The helper's `breeze-backup rebuild` gains `--token/--server` mode: authenticate, build the recovery download provider, post `planned/restoring/validated/rebooted`, run the engine with the marker from the bootstrap. The web Recovery tab gets a "Bare-metal recovery" section (create → code → live status).

**Tech Stack:** Hono + Drizzle + zod + Vitest (`apps/api`), PostgreSQL migration, Go (`agent/internal/backup/bmr`, `agent/internal/heartbeat`, `agent/cmd/breeze-backup`), React + Vitest (`apps/web`).

**Spec:** `docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md` §8.1 (codes, state machine, check-in), §8.2 (identity resumption), §9 (one-time short-lived codes, 30-minute overdue window). Not §7 (media/console — W04b), not §8.3 (DR/Restore-as-VM — W05).

**Depends on:** W03 (`rebuild.Run`, `rebuild.Marker`, `rebuild.Result`, `bmr.BootstrapResponse`, `breeze-backup rebuild`). W04b depends on this wave.

## Global Constraints

- Table `bare_metal_recoveries` (all columns below, no more, no less) — migration `apps/api/migrations/2026-10-15-160020-bare-metal-recoveries.sql` (sorts after W01's `160010`; re-check `ls apps/api/migrations/*.sql | sort | tail -1` before committing).
- RLS: shape 1 (`org_id`), policies copied from the `recovery_tokens` migration so the public token-less routes work under the same DB context the existing `bmrPublicRoutes` use. Registered in `CORE_ORG_CASCADE_DELETE_ORDER` (after `backup_verifications`, before `brain_device_context`), `CORE_DEVICE_CASCADE_DELETE_TABLES` (first line, before `recovery_tokens` — it FKs to `recovery_tokens` with `SET NULL`, so order is not FK-forced, but keep it first for clarity), `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same alphabetical slot), `CORE_TENANT_EXPORT_POLICY` (`code_hash`, `nonce_hash` → `excludedSensitive`; `target`, `plan`, `result`, `warnings` → `excludedOpen`; everything else `included`). `devices` gains `recovered_at timestamptz NULL` and `recovered_from_snapshot_id uuid NULL REFERENCES backup_snapshots(id) ON DELETE SET NULL` → both `included` in the `devices` export-policy row.
- Recovery code: 9 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), displayed as `XXX-XXX-XXX`, normalised (upper-case, dashes/spaces removed) before hashing; stored as `code_hash = sha256hex(normalised)` with a UNIQUE index; TTL 15 minutes (`code_expires_at`); one-time (`code_used_at`).
- Nonce: 32 random bytes → 64 hex chars, returned once in the bootstrap (`recovery.nonce`); stored as `nonce_hash = sha256hex(nonce)`. The engine writes it into `/var/lib/breeze/recovery-marker.json` (W03 `rebuild.Marker`); the agent sends it in heartbeats as `recoveryMarker: {recoveryId, nonce}` until acked.
- Status machine (server-enforced, forward-only): `created → media_booted → planned → restoring → validated → rebooted → checked_in`; terminal `checked_in | completed | failed | refused`. `failed`/`refused` allowed from any non-terminal state. `validated` with `identity = 'new'` transitions straight to `completed`. Heartbeat check-in accepts marker matches while status ∈ {`restoring`, `validated`, `rebooted`} (the console may lose the network before posting `rebooted`). Re-sent markers on an already `checked_in` recovery are acked idempotently.
- Overdue is computed on read, never stored: `overdue = status === 'rebooted' && rebootedAt + 30 min < now`.
- Rate limits: `/bmr/recover/exchange` 10/min per IP (`enforcePublicRateLimit(c, 'exchange', 10)`) and 5/hour per code hash (`enforceTokenRateLimit(c, 'exchange', codeHash, 5, 3600)`); `/bmr/recover/progress` reuses the `download` token limiter budget (`enforceTokenRateLimit(c, 'progress', tokenHash, 600, 3600)`).
- Exchange mints a NEW recovery token (`restoreType: 'bare_metal'`, `expiresInHours` 24) linked via `bare_metal_recoveries.recovery_token_id`, marks it `authenticated`, and returns the plain token + the same bootstrap payload `authenticate` returns, extended with `recovery: {id, identity, nonce}`. `authenticate` also returns `recovery` (without `nonce` unless the token has never authenticated before — nonce is disclosed exactly once).
- Every new route writes an audit event (`bmr.recovery.create`, `bmr.recovery.exchange`, `bmr.recovery.progress`, `bmr.recovery.checked_in`) via the existing `writeRouteAudit`/`writeAuditEvent` helpers.
- Agent-side marker file: `<config.GetDataDir()>/recovery-marker.json`, read once in `startAgent`, sent every heartbeat until `recoveryMarkerAck: true` is received, then renamed to `recovery-marker.acked.json`.
- No internal hostnames/IPs in committed files.

## 0. Ground truth (verified 2026-09-10 on main @ `1ffe9b150b`)

- `apps/api/src/routes/backup/bmr.ts` — imports `:1-62` (`db`, `and/desc/eq/inArray`, schema tables, `requireMfa/requirePermission/requireScope`, `writeAuditEvent/writeRouteAudit`, `rateLimiter`, `resolveScopedOrgId`, `authorizeRouteResilienceResources`, `captureRecoveryAuthorizationSubject`); `enforcePublicRateLimit(c, action, limit)` `:364`; `enforceTokenRateLimit(c, action, tokenHash, limit, windowSeconds)` `:378`; `POST /bmr/tokens` `:445-529` (template: `generateRecoveryToken`, `hashRecoveryToken`, insert into `recoveryTokens` with `orgId, deviceId, snapshotId, tokenHash, restoreType, targetConfig, status:'active', createdBy, expiresAt`, `toTokenSummary(row)` `:110`); `POST /bmr/recover/authenticate` `:1120-1382` (rate limits → `expireUnusedRecoveryTokens()` → token lookup by hash → expiry/status guards → `resolveSnapshotProviderConfig` → device select → status flip to `authenticated` → `buildAuthenticatedBootstrapPayload({...})`); `POST /bmr/recover/complete` `:1586-1745` (transaction: `restoreJobs` insert `onConflictDoNothing({target: restoreJobs.recoveryTokenId})`, token → `used`).
- `apps/api/src/routes/backup/schemas.ts:275-357` — `bmrCreateTokenSchema`, `bmrAuthenticateSchema`, `bmrCompleteSchema` (result shape), `bmrTokenListSchema`.
- `apps/api/src/services/recoveryBootstrap.ts` — `generateRecoveryToken`, `hashRecoveryToken` (sha256 hex), `RECOVERY_TOKEN_REGEX`, `buildAuthenticatedBootstrapPayload`, `BMR_BOOTSTRAP_VERSION`, `BMR_MIN_HELPER_VERSION`, `expireUnusedRecoveryTokens`, `resolveSnapshotProviderConfig`.
- `apps/api/src/db/schema/recoveryTokens.ts:20-57` `recoveryTokens` (columns incl. `recoveryAuthorizationSubjectColumns()`); its migration's RLS policy block is the template for the new table.
- `apps/api/src/routes/agents/heartbeat.ts` — handler `:278` (`const data = c.req.valid('json')` `:279`, `agent = c.get('agent')` `:281`); org-scoped closure `withDbAccessContext(dbContext, …)` `:448`; `deviceUpdates` built `~:860-911`; main guarded `db.update(devices).set(deviceUpdates)` `:933-940`; `apps/api/src/routes/agents/schemas.ts:119-323` `heartbeatSchema` (last fields `agentEdition`, `migrationRequired`, all `.optional().catch(undefined)`).
- `apps/api/src/db/schema/devices.ts` — `lastSeenAt :86`, `enrolledAt :87`; no recovery columns.
- `apps/api/src/services/tenantCascade.ts:136-138` (`backup_verifications` → `brain_device_context`); `apps/api/src/routes/devices/core.ts:206-208` (`CORE_DEVICE_ORG_DENORMALIZED_TABLES`), `:297-300` (`CORE_DEVICE_CASCADE_DELETE_TABLES` starts with `'recovery_tokens', 'backup_chains'`); `apps/api/src/services/tenantExportPolicyRegistry.ts:294` (`recovery_tokens` row), `:170` (`devices` row).
- `agent/internal/heartbeat/heartbeat.go:83-151` `HeartbeatPayload` (last fields `AgentEdition`, `MigrationRequired`); `sendHeartbeat()` `:3976`, payload literal `:4014`; `agent/internal/agentapp/main.go:684` `startAgent(cfg)` constructs the heartbeat at `:903`; `config.GetDataDir()` (`/var/lib/breeze` on Linux).
- `agent/internal/backup/bmr/session.go:29` `RunRecoveryWithTokenContext`, `:119` `authenticateRecoverySessionContext(ctx, serverURL, token) (*BootstrapResponse, error)` (POSTs `/api/v1/backup/bmr/recover/authenticate`), `:158` `reportRecoveryCompletion`; `download_provider.go:94` `newRecoveryDownloadProvider(ctx, serverURL, token, descriptor)`; `types.go:63` `BootstrapResponse`.
- `agent/cmd/breeze-backup/rebuild_cmd.go` (W03) — `newRebuildCommand`, `parseTargetFlag`, `providerFromConfigFile`; `agent/internal/backup/rebuild` — `Run(ctx, Options)`, `Options.Marker *Marker{RecoveryID, Nonce}`, `Options.Progress func(Phase, string, int64, int64)`, `Result{Status, PhaseReached, Phases, Plan, Refusal, Error, Warnings, …}`.
- `apps/web/src/components/backup/RecoveryBootstrapTab.tsx` — create-token form state `:485-489`, `handleCreateToken` `:710-767` (`fetchWithAuth('/backup/bmr/tokens', {method:'POST', body})`), token table `:1677`; `RecoveryBootstrapTab.test.tsx:1-40` fetch mock (`makeJsonResponse`, URL+method dispatcher). No `data-testid` convention in this file — tests select by translated text.
- `apps/web/src/locales/*/backup.json` — new keys need REAL translations in all 7 non-English locales (`translationCoverage.test.ts` caps exact-English duplicates); run `cd apps/web && npx vitest run src/lib/i18n`.

---

### Task 1: Schema, migration, registries

**Files:**
- Create: `apps/api/migrations/2026-10-15-160020-bare-metal-recoveries.sql`
- Create: `apps/api/src/db/schema/bareMetalRecoveries.ts`; export from `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/db/schema/devices.ts` (two columns), `apps/api/src/services/tenantCascade.ts:137`, `apps/api/src/routes/devices/core.ts:207` and `:300`, `apps/api/src/services/tenantExportPolicyRegistry.ts` (new row + `devices` row)
- Test: `apps/api/src/db/autoMigrate.test.ts` (existing ordering test), `apps/api/src/routes/devices/cascadeDelete.test.ts` + `moveOrg.coverage.test.ts` (existing contract tests must pass), integration `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `rls-coverage.integration.test.ts`

**Interfaces:**
- Produces: Drizzle `bareMetalRecoveries` table with columns `id, orgId, deviceId, snapshotId, recoveryTokenId, identity, codeHash, codeExpiresAt, codeUsedAt, nonceHash, status, target, plan, result, failureReason, warnings, createdBy, createdAt, updatedAt, mediaBootedAt, plannedAt, restoringAt, validatedAt, rebootedAt, checkedInAt, completedAt`; `BARE_METAL_RECOVERY_STATUSES` const tuple; `devices.recoveredAt`, `devices.recoveredFromSnapshotId`.

- [ ] **Step 1: Red — run the registry contract tests before touching the lists**

Run: `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts 2>&1 | tail -4` — green now; after Step 3's schema lands but before Step 4's registrations they must FAIL naming `bare_metal_recoveries` (that is the red run for this task — do Step 3, run again, observe the failure, then Step 4).

- [ ] **Step 2: Migration**

```sql
-- Bare-metal recovery W04a: one row per recovery attempt started from Breeze
-- boot media. Spec §8.1. Shape-1 RLS (org_id); policies mirror recovery_tokens
-- so the public, token-authenticated recover/* routes can read and update rows.
CREATE TABLE IF NOT EXISTS bare_metal_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  snapshot_id uuid REFERENCES backup_snapshots(id) ON DELETE SET NULL,
  recovery_token_id uuid REFERENCES recovery_tokens(id) ON DELETE SET NULL,
  identity varchar(10) NOT NULL CHECK (identity IN ('original', 'new')),
  code_hash varchar(64) NOT NULL,
  code_expires_at timestamptz NOT NULL,
  code_used_at timestamptz,
  nonce_hash varchar(64) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','media_booted','planned','restoring','validated','rebooted','checked_in','completed','failed','refused')),
  target jsonb,
  plan jsonb,
  result jsonb,
  failure_reason text,
  warnings jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  media_booted_at timestamptz,
  planned_at timestamptz,
  restoring_at timestamptz,
  validated_at timestamptz,
  rebooted_at timestamptz,
  checked_in_at timestamptz,
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS bare_metal_recoveries_code_hash_idx ON bare_metal_recoveries(code_hash);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_org_idx ON bare_metal_recoveries(org_id);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_device_idx ON bare_metal_recoveries(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_token_idx ON bare_metal_recoveries(recovery_token_id);
CREATE INDEX IF NOT EXISTS bare_metal_recoveries_status_idx ON bare_metal_recoveries(status) WHERE status NOT IN ('checked_in','completed','failed','refused');

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "recovered_at" timestamptz;
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "recovered_from_snapshot_id" uuid REFERENCES backup_snapshots(id) ON DELETE SET NULL;

ALTER TABLE bare_metal_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE bare_metal_recoveries FORCE ROW LEVEL SECURITY;
-- Policies: copy the four policy statements from the migration that created
-- recovery_tokens (grep -l "recovery_tokens" apps/api/migrations/*.sql | head),
-- substituting the table name, each wrapped in the repo's
-- DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'bare_metal_recoveries' AND policyname = '...') ... $$ guard.
GRANT SELECT, INSERT, UPDATE, DELETE ON bare_metal_recoveries TO breeze_app;
```

- [ ] **Step 3: Drizzle schema**

```ts
// apps/api/src/db/schema/bareMetalRecoveries.ts
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { devices } from './devices';
import { backupSnapshots } from './backup';
import { recoveryTokens } from './recoveryTokens';
import { users } from './users';

export const BARE_METAL_RECOVERY_STATUSES = [
  'created', 'media_booted', 'planned', 'restoring', 'validated', 'rebooted', 'checked_in', 'completed', 'failed', 'refused',
] as const;
export type BareMetalRecoveryStatus = (typeof BARE_METAL_RECOVERY_STATUSES)[number];
export const BARE_METAL_RECOVERY_TERMINAL: ReadonlySet<BareMetalRecoveryStatus> = new Set(['checked_in', 'completed', 'failed', 'refused']);

export const bareMetalRecoveries = pgTable('bare_metal_recoveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),
  snapshotId: uuid('snapshot_id').references(() => backupSnapshots.id, { onDelete: 'set null' }),
  recoveryTokenId: uuid('recovery_token_id').references(() => recoveryTokens.id, { onDelete: 'set null' }),
  identity: varchar('identity', { length: 10 }).notNull().$type<'original' | 'new'>(),
  codeHash: varchar('code_hash', { length: 64 }).notNull(),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }).notNull(),
  codeUsedAt: timestamp('code_used_at', { withTimezone: true }),
  nonceHash: varchar('nonce_hash', { length: 64 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('created').$type<BareMetalRecoveryStatus>(),
  target: jsonb('target').$type<Record<string, unknown>>(),
  plan: jsonb('plan').$type<Record<string, unknown>>(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  failureReason: text('failure_reason'),
  warnings: jsonb('warnings').$type<string[]>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  mediaBootedAt: timestamp('media_booted_at', { withTimezone: true }),
  plannedAt: timestamp('planned_at', { withTimezone: true }),
  restoringAt: timestamp('restoring_at', { withTimezone: true }),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  rebootedAt: timestamp('rebooted_at', { withTimezone: true }),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  codeHashIdx: uniqueIndex('bare_metal_recoveries_code_hash_idx').on(t.codeHash),
  orgIdx: index('bare_metal_recoveries_org_idx').on(t.orgId),
  deviceIdx: index('bare_metal_recoveries_device_idx').on(t.deviceId, t.createdAt),
  tokenIdx: index('bare_metal_recoveries_token_idx').on(t.recoveryTokenId),
}));
```

`devices.ts` after `enrolledAt` (`:87`):

```ts
  // Bare-metal recovery W04a: stamped by the heartbeat check-in that completes a recovery.
  recoveredAt: timestamp('recovered_at', { withTimezone: true }),
  recoveredFromSnapshotId: uuid('recovered_from_snapshot_id'),
```

(Reference to `backupSnapshots` from `devices.ts` would create an import cycle — leave the FK to the migration only, as other cross-schema soft references in this file do; check how `possibleReplacementOfDeviceId` is declared and copy that style.)

- [ ] **Step 4: Registries + export policy**

- `tenantCascade.ts` line 137: insert `'bare_metal_recoveries',` after `'backup_verifications',`.
- `core.ts:207` `CORE_DEVICE_ORG_DENORMALIZED_TABLES`: insert `'bare_metal_recoveries',` after `'backup_verifications',`.
- `core.ts:300` `CORE_DEVICE_CASCADE_DELETE_TABLES`: insert `'bare_metal_recoveries',` as the first entry (before `'recovery_tokens'`).
- `tenantExportPolicyRegistry.ts`: add, in alphabetical position among the `b*` rows:

```ts
  "bare_metal_recoveries": tablePolicy("org_id", {"included":["id","org_id","device_id","snapshot_id","recovery_token_id","identity","code_expires_at","code_used_at","status","failure_reason","created_by","created_at","updated_at","media_booted_at","planned_at","restoring_at","validated_at","rebooted_at","checked_in_at","completed_at"],"reviewedIncluded":[],"excludedSensitive":["code_hash","nonce_hash"],"excludedOpen":["target","plan","result","warnings"]}),
```

and append `"recovered_at","recovered_from_snapshot_id"` to the `devices` row's `included` array.

- [ ] **Step 5: Run migrations, drift, contract + integration suites**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate 2>&1 | tail -2 && pnpm db:check-drift 2>&1 | tail -2
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts 2>&1 | tail -4
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts 2>&1 | tail -6
npx vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage.integration.test.ts 2>&1 | tail -4
```
Expected: all green; RLS coverage auto-discovers the table by its `org_id` column (no allowlist entry). Then forge a cross-tenant insert as `breeze_app` (`docker exec -it breeze-postgres psql -U breeze_app -d breeze`) with `breeze.scope` set to a different org and confirm `new row violates row-level security policy`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-10-15-160020-bare-metal-recoveries.sql apps/api/src/db/schema/bareMetalRecoveries.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/devices.ts apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): bare_metal_recoveries table, device recovery stamps, registries + export policy (W04a)"
```

---

### Task 2: Recovery codes — service helpers

**Files:**
- Create: `apps/api/src/services/bareMetalRecoveryCodes.ts`
- Test: `apps/api/src/services/bareMetalRecoveryCodes.test.ts`

**Interfaces:**
- Produces:

```ts
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_LENGTH = 9;
export const RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_NONCE_BYTES = 32;
export function generateRecoveryCode(): string;                 // 9 chars from the alphabet, crypto-random
export function formatRecoveryCode(code: string): string;        // "ABC-DEF-GHJ"
export function normalizeRecoveryCode(input: string): string | null; // upper-case, strip "-"/" "; null unless exactly 9 alphabet chars
export function hashRecoveryCode(normalized: string): string;    // sha256 hex
export function generateRecoveryNonce(): string;                 // 64 hex chars
export function hashRecoveryNonce(nonce: string): string;        // sha256 hex
export type BareMetalRecoveryStatus = ...;                        // re-export from schema
export const RECOVERY_STATUS_ORDER: readonly BareMetalRecoveryStatus[]; // created … checked_in
export function canTransition(from: BareMetalRecoveryStatus, to: BareMetalRecoveryStatus): boolean;
export function isOverdue(status: BareMetalRecoveryStatus, rebootedAt: Date | null, now?: Date): boolean; // 30 min
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  canTransition, formatRecoveryCode, generateRecoveryCode, generateRecoveryNonce, hashRecoveryCode,
  isOverdue, normalizeRecoveryCode, RECOVERY_CODE_ALPHABET,
} from './bareMetalRecoveryCodes';

describe('recovery codes', () => {
  it('generates 9 chars from the unambiguous alphabet and formats as XXX-XXX-XXX', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRecoveryCode();
      expect(code).toHaveLength(9);
      for (const ch of code) expect(RECOVERY_CODE_ALPHABET).toContain(ch);
      expect(formatRecoveryCode(code)).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    }
  });
  it('normalizes user input and rejects anything that is not exactly nine alphabet chars', () => {
    expect(normalizeRecoveryCode(' abc-def-ghj ')).toBe('ABCDEFGHJ');
    expect(normalizeRecoveryCode('ABC DEF GHJ')).toBe('ABCDEFGHJ');
    expect(normalizeRecoveryCode('ABC-DEF-GH0')).toBeNull(); // 0 is not in the alphabet
    expect(normalizeRecoveryCode('ABCDEFGH')).toBeNull();
    expect(normalizeRecoveryCode('')).toBeNull();
  });
  it('hashes deterministically with sha256', () => {
    expect(hashRecoveryCode('ABCDEFGHJ')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode('ABCDEFGHJ')).toBe(hashRecoveryCode('ABCDEFGHJ'));
  });
  it('nonce is 64 hex chars and unique', () => {
    const a = generateRecoveryNonce(); const b = generateRecoveryNonce();
    expect(a).toMatch(/^[0-9a-f]{64}$/); expect(a).not.toBe(b);
  });
  it('state machine is forward-only with failed/refused from any non-terminal state', () => {
    expect(canTransition('created', 'media_booted')).toBe(true);
    expect(canTransition('media_booted', 'planned')).toBe(true);
    expect(canTransition('planned', 'restoring')).toBe(true);
    expect(canTransition('restoring', 'validated')).toBe(true);
    expect(canTransition('validated', 'rebooted')).toBe(true);
    expect(canTransition('rebooted', 'checked_in')).toBe(true);
    expect(canTransition('created', 'restoring')).toBe(true);   // skipping forward is allowed (lost progress posts)
    expect(canTransition('restoring', 'planned')).toBe(false);  // never backwards
    expect(canTransition('restoring', 'failed')).toBe(true);
    expect(canTransition('created', 'refused')).toBe(true);
    expect(canTransition('checked_in', 'failed')).toBe(false);
    expect(canTransition('completed', 'rebooted')).toBe(false);
    expect(canTransition('validated', 'completed')).toBe(true);
  });
  it('overdue only for rebooted older than 30 minutes', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    expect(isOverdue('rebooted', new Date('2026-09-10T11:20:00Z'), now)).toBe(true);
    expect(isOverdue('rebooted', new Date('2026-09-10T11:45:00Z'), now)).toBe(false);
    expect(isOverdue('validated', new Date('2026-09-10T10:00:00Z'), now)).toBe(false);
    expect(isOverdue('checked_in', new Date('2026-09-10T10:00:00Z'), now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/services/bareMetalRecoveryCodes.test.ts 2>&1 | tail -3` (module not found).

- [ ] **Step 3: Implement**

```ts
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { BARE_METAL_RECOVERY_STATUSES, BARE_METAL_RECOVERY_TERMINAL, type BareMetalRecoveryStatus } from '../db/schema/bareMetalRecoveries';

export type { BareMetalRecoveryStatus };
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_LENGTH = 9;
export const RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_NONCE_BYTES = 32;
export const RECOVERY_OVERDUE_MS = 30 * 60 * 1000;

export function generateRecoveryCode(): string {
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) out += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  return out;
}
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_CODE_ALPHABET.includes(ch)) return null;
  return s;
}
export function hashRecoveryCode(normalized: string): string { return createHash('sha256').update(normalized).digest('hex'); }
export function generateRecoveryNonce(): string { return randomBytes(RECOVERY_NONCE_BYTES).toString('hex'); }
export function hashRecoveryNonce(nonce: string): string { return createHash('sha256').update(nonce).digest('hex'); }

export const RECOVERY_STATUS_ORDER: readonly BareMetalRecoveryStatus[] = ['created', 'media_booted', 'planned', 'restoring', 'validated', 'rebooted', 'checked_in'];

export function canTransition(from: BareMetalRecoveryStatus, to: BareMetalRecoveryStatus): boolean {
  if (BARE_METAL_RECOVERY_TERMINAL.has(from)) return false;
  if (to === 'failed' || to === 'refused') return true;
  if (to === 'completed') return from === 'validated';
  const a = RECOVERY_STATUS_ORDER.indexOf(from);
  const b = RECOVERY_STATUS_ORDER.indexOf(to);
  return a >= 0 && b > a;
}
export function isOverdue(status: BareMetalRecoveryStatus, rebootedAt: Date | null, now = new Date()): boolean {
  return status === 'rebooted' && rebootedAt !== null && now.getTime() - rebootedAt.getTime() > RECOVERY_OVERDUE_MS;
}
void BARE_METAL_RECOVERY_STATUSES;
```

- [ ] **Step 4: Run green, commit**

```bash
cd apps/api && npx vitest run src/services/bareMetalRecoveryCodes.test.ts 2>&1 | tail -3
git add apps/api/src/services/bareMetalRecoveryCodes.ts apps/api/src/services/bareMetalRecoveryCodes.test.ts
git commit -m "feat(api): bare-metal recovery code/nonce helpers and state machine rules (W04a)"
```

---

### Task 3: API routes — create/list/get recoveries, exchange, progress

**Files:**
- Create: `apps/api/src/routes/backup/bmrRecoveries.ts` (session routes `bmrRecoveryRoutes` + public routes `bmrRecoveryPublicRoutes`), mounted in `apps/api/src/routes/backup/index.ts` next to `bmrRoutes`/`bmrPublicRoutes` (public BEFORE `authMiddleware`, exactly like `bmrPublicRoutes` at `index.ts:24`)
- Modify: `apps/api/src/routes/backup/schemas.ts` (four zod schemas), `apps/api/src/routes/backup/bmr.ts` (export `enforcePublicRateLimit`, `enforceTokenRateLimit`, `toTokenSummary`; `authenticate` response gains `recovery`), `apps/api/src/services/recoveryBootstrap.ts` (`buildAuthenticatedBootstrapPayload` accepts optional `recovery`)
- Test: `apps/api/src/routes/backup/bmrRecoveries.test.ts` (chainMock pattern from `bmr.test.ts:1-30`)

**Interfaces:**
- `POST /backup/bmr/recoveries` (`requireScope('organization','partner','system')`, `BACKUP_WRITE`, `requireMfa()`), body `bmrRecoveryCreateSchema = { snapshotId: uuid, identity: 'original'|'new' (default 'original') }` → 201 `{ id, deviceId, snapshotId, identity, status:'created', code: 'XXX-XXX-XXX', codeExpiresAt, createdAt }`. Refuses 409 `snapshot_not_bare_metal_restorable` when `backupSnapshots.bareMetalRestorable !== true` (reasons in body), 409 `recovery_in_progress` when a non-terminal recovery exists for the device.
- `GET /backup/bmr/recoveries?deviceId=&limit=` and `GET /backup/bmr/recoveries/:id` (`BACKUP_READ`) → `toRecoverySummary(row)`: `{ id, deviceId, snapshotId, identity, status, overdue, codeExpiresAt, codeUsedAt, target, plan, result, failureReason, warnings, timestamps…, recoveryTokenId }` (never `codeHash`/`nonceHash`).
- `POST /bmr/recover/exchange` (public) body `bmrExchangeSchema = { code: string(1..32) }` → 200 `{ token: 'brz_rec_…', bootstrap: <authenticate payload> }` where `bootstrap.recovery = { id, identity, nonce, deviceId, snapshotId }`; 404 `code_invalid` (same response for unknown/expired/used — no oracle), 410 `code_expired` only after the row is found and expired? — NO: return 404 for all three so a guess reveals nothing. Side effects: `code_used_at = now`, new `recoveryTokens` row (`restoreType 'bare_metal'`, 24h, `status 'authenticated'`, `authenticatedAt now`), `recovery_token_id` set, `status → media_booted`, `media_booted_at`.
- `POST /bmr/recover/progress` (public, token) body `bmrProgressSchema = { token, status: enum(media_booted|planned|restoring|validated|rebooted|failed|refused), target?: record, plan?: record, result?: record, reason?: string.max(2000), warnings?: string[].max(64) }` → 200 `{ id, status }`; 409 `invalid_transition` with `{from, to}`; `validated` + identity `new` → stored as `completed` with `completed_at`; `failed`/`refused` store `failure_reason` (= `reason` ?? `result.error`/`result.refusal`).
- `authenticate` (existing) adds `recovery: { id, identity, deviceId, snapshotId }` when `recoveryTokens.id` is referenced by a recovery (nonce NOT included here).

- [ ] **Step 1: Write the failing route tests** (`bmrRecoveries.test.ts`; copy the mock scaffolding from `bmr.test.ts:1-30` — `vi.mock('../../services', …)`, `chainMock`, `selectMock/insertMock/updateMock`, and the way `bmr.test.ts` fakes `c.get('auth')` and the rate limiter):

```ts
describe('POST /backup/bmr/recoveries', () => {
  it('creates a recovery for a bare-metal-restorable snapshot and returns a formatted one-time code', async () => {
    selectMock
      .mockReturnValueOnce(chainMock([{ id: 'snap-1', deviceId: 'dev-1', orgId: 'org-1', bareMetalRestorable: true, bareMetalReasons: [] }])) // snapshot
      .mockReturnValueOnce(chainMock([])); // no in-progress recovery
    insertMock.mockReturnValueOnce(chainMock([{ id: 'rec-1', deviceId: 'dev-1', snapshotId: 'snap-1', identity: 'original', status: 'created', codeExpiresAt: new Date(), createdAt: new Date() }]));
    const res = await app.request('/backup/bmr/recoveries', { method: 'POST', headers: authHeaders, body: JSON.stringify({ snapshotId: 'snap-1', identity: 'original' }) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    const inserted = insertMock.mock.results[0].value.values.mock.calls[0][0];
    expect(inserted.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted).not.toHaveProperty('nonce');
    expect(body).not.toHaveProperty('codeHash');
  });
  it('refuses a snapshot the guard marked non-restorable, naming the reasons', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: 'snap-1', deviceId: 'dev-1', orgId: 'org-1', bareMetalRestorable: false, bareMetalReasons: ['LVM volumes are not supported'] }]));
    const res = await app.request('/backup/bmr/recoveries', { method: 'POST', headers: authHeaders, body: JSON.stringify({ snapshotId: 'snap-1' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'snapshot_not_bare_metal_restorable', reasons: ['LVM volumes are not supported'] });
  });
  it('refuses when the device already has a recovery in progress', async () => { /* second select returns [{id:'rec-0', status:'restoring'}] → 409 recovery_in_progress */ });
});

describe('POST /bmr/recover/exchange', () => {
  it('exchanges a valid code once: mints a token, marks media_booted, returns bootstrap with nonce', async () => {
    const code = 'ABCDEFGHJ';
    selectMock.mockReturnValueOnce(chainMock([{ id: 'rec-1', orgId: 'org-1', deviceId: 'dev-1', snapshotId: 'snap-1', identity: 'original', status: 'created', codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + 60_000), codeUsedAt: null, nonceHash: 'x' }]));
    // …then the selects/updates the reused authenticate logic performs (snapshot, device, config) — mirror bmr.test.ts's authenticate test fixtures.
    const res = await publicApp.request('/bmr/recover/exchange', { method: 'POST', body: JSON.stringify({ code: 'abc-def-ghj' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^brz_rec_[0-9a-f]{64}$/);
    expect(body.bootstrap.recovery).toMatchObject({ id: 'rec-1', identity: 'original' });
    expect(body.bootstrap.recovery.nonce).toMatch(/^[0-9a-f]{64}$/);
    // nonce hash persisted must match the disclosed nonce
    const update = updateMock.mock.results.map((r) => r.value.set.mock.calls[0]?.[0]).find((s) => s && 'nonceHash' in s);
    expect(update.nonceHash).toBe(hashRecoveryNonce(body.bootstrap.recovery.nonce));
    expect(update.status).toBe('media_booted');
    expect(update.codeUsedAt).toBeInstanceOf(Date);
  });
  it('returns 404 code_invalid for unknown, expired and already-used codes alike', async () => {
    for (const row of [[], [{ codeExpiresAt: new Date(Date.now() - 1000), codeUsedAt: null }], [{ codeExpiresAt: new Date(Date.now() + 60_000), codeUsedAt: new Date() }]]) {
      selectMock.mockReturnValueOnce(chainMock(row.map((r) => ({ id: 'rec-1', status: 'created', codeHash: 'h', nonceHash: 'n', ...r }))));
      const res = await publicApp.request('/bmr/recover/exchange', { method: 'POST', body: JSON.stringify({ code: 'ABC-DEF-GHJ' }) });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('code_invalid');
    }
  });
  it('rejects malformed codes with 400 before touching the database', async () => { /* code 'ABC-DEF-GH0' → 400, selectMock not called */ });
});

describe('POST /bmr/recover/progress', () => {
  it('advances forward, stores plan/result/timestamps, and refuses backwards moves', async () => { /* token → recoveryTokens row → recovery row status 'planned'; post 'restoring' → 200 + update {status:'restoring', restoringAt}; post 'planned' again → 409 invalid_transition {from:'restoring', to:'planned'} */ });
  it('validated on a new-identity recovery completes it', async () => { /* identity 'new', post validated → update status 'completed', completedAt set */ });
  it('failed stores the reason and the engine result', async () => { /* post failed with result {status:'failed', error:'grub-install: …'} → failureReason 'grub-install: …' */ });
});
```

Note on the exchange nonce: generate the nonce at EXCHANGE time (not at create) and overwrite `nonce_hash` then — the test above asserts that. Rationale: the nonce is disclosed exactly once to the machine that presents the code; a nonce generated at create time would otherwise have to be stored in plaintext until exchange. Update the row's `nonceHash` in the same transaction as `codeUsedAt`. (At create time store a random placeholder hash — the column is NOT NULL.)

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/routes/backup/bmrRecoveries.test.ts 2>&1 | tail -5` (module not found).

- [ ] **Step 3: Implement `bmrRecoveries.ts`**

Session routes (mirror `POST /bmr/tokens` `:445-529` for auth/org resolution/audit):

```ts
bmrRecoveryRoutes.post('/bmr/recoveries', requireScope('organization', 'partner', 'system'), requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action), requireMfa(), zValidator('json', bmrRecoveryCreateSchema), async (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
  if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);
  const payload = c.req.valid('json');
  const authorization = await authorizeRouteResilienceResources(c, orgId, [{ kind: 'snapshot', id: payload.snapshotId, role: 'source' }], 'token');
  if (!authorization.ok) return authorization.response;
  const [snapshot] = await db.select().from(backupSnapshots).where(and(eq(backupSnapshots.id, payload.snapshotId), eq(backupSnapshots.orgId, orgId))).limit(1);
  if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);
  if (snapshot.bareMetalRestorable !== true) {
    return c.json({ error: 'snapshot_not_bare_metal_restorable', reasons: snapshot.bareMetalReasons ?? ['snapshot was not assessed for bare-metal restore'] }, 409);
  }
  const [inProgress] = await db.select({ id: bareMetalRecoveries.id, status: bareMetalRecoveries.status }).from(bareMetalRecoveries)
    .where(and(eq(bareMetalRecoveries.deviceId, snapshot.deviceId), eq(bareMetalRecoveries.orgId, orgId), notInArray(bareMetalRecoveries.status, [...BARE_METAL_RECOVERY_TERMINAL]))).limit(1);
  if (inProgress) return c.json({ error: 'recovery_in_progress', recoveryId: inProgress.id, status: inProgress.status }, 409);
  const code = generateRecoveryCode();
  const [row] = await db.insert(bareMetalRecoveries).values({
    orgId, deviceId: snapshot.deviceId, snapshotId: snapshot.id, identity: payload.identity,
    codeHash: hashRecoveryCode(code), codeExpiresAt: new Date(Date.now() + RECOVERY_CODE_TTL_MS),
    nonceHash: hashRecoveryNonce(generateRecoveryNonce()), // placeholder until exchange
    status: 'created', createdBy: auth.user?.id ?? null,
  }).returning();
  if (!row) return c.json({ error: 'Failed to create recovery' }, 500);
  writeRouteAudit(c, { orgId, action: 'bmr.recovery.create', resourceType: 'bare_metal_recovery', resourceId: row.id, details: { snapshotId: snapshot.id, deviceId: snapshot.deviceId, identity: payload.identity } });
  return c.json({ ...toRecoverySummary(row), code: formatRecoveryCode(code) }, 201);
});
```

`GET` list/get: `db.select().from(bareMetalRecoveries).where(and(eq(orgId), optional eq(deviceId))).orderBy(desc(createdAt)).limit(limit)` → `{ data: rows.map(toRecoverySummary) }`; get by id → 404 when absent.

```ts
export function toRecoverySummary(row: typeof bareMetalRecoveries.$inferSelect) {
  return {
    id: row.id, deviceId: row.deviceId, snapshotId: row.snapshotId, recoveryTokenId: row.recoveryTokenId,
    identity: row.identity, status: row.status, overdue: isOverdue(row.status, row.rebootedAt),
    codeExpiresAt: row.codeExpiresAt.toISOString(), codeUsedAt: row.codeUsedAt?.toISOString() ?? null,
    target: row.target ?? null, plan: row.plan ?? null, result: row.result ?? null,
    failureReason: row.failureReason ?? null, warnings: row.warnings ?? [],
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    mediaBootedAt: iso(row.mediaBootedAt), plannedAt: iso(row.plannedAt), restoringAt: iso(row.restoringAt),
    validatedAt: iso(row.validatedAt), rebootedAt: iso(row.rebootedAt), checkedInAt: iso(row.checkedInAt), completedAt: iso(row.completedAt),
  };
}
```

Public exchange (mirror `authenticate` `:1120-1382` for structure; factor the "token row → bootstrap payload" part of `authenticate` into an exported `buildBootstrapForTokenRow(c, row, { recovery })` in `bmr.ts` so both routes share it — this refactor must keep `bmr.test.ts` green unchanged):

```ts
bmrRecoveryPublicRoutes.post('/bmr/recover/exchange', zValidator('json', bmrExchangeSchema), async (c) => {
  const limited = await enforcePublicRateLimit(c, 'exchange', 10);
  if (limited) return limited;
  const normalized = normalizeRecoveryCode(c.req.valid('json').code);
  if (!normalized) return c.json({ error: 'code_invalid' }, 400);
  const codeHash = hashRecoveryCode(normalized);
  const codeLimited = await enforceTokenRateLimit(c, 'exchange', codeHash, 5, 3600);
  if (codeLimited) return codeLimited;
  const [rec] = await db.select().from(bareMetalRecoveries).where(eq(bareMetalRecoveries.codeHash, codeHash)).limit(1);
  const now = new Date();
  if (!rec || rec.codeUsedAt || rec.codeExpiresAt.getTime() < now.getTime() || rec.status !== 'created') {
    writeAuditEvent(c, { orgId: rec?.orgId ?? null, action: 'bmr.recovery.exchange', resourceType: 'bare_metal_recovery', resourceId: rec?.id ?? null, result: 'failure', details: { reason: !rec ? 'unknown' : rec.codeUsedAt ? 'used' : 'expired_or_state' } });
    return c.json({ error: 'code_invalid' }, 404);
  }
  const plainToken = generateRecoveryToken();
  const tokenHash = hashRecoveryToken(plainToken);
  const nonce = generateRecoveryNonce();
  const tokenRow = await db.transaction(async (tx) => {
    const [t] = await tx.insert(recoveryTokens).values({ orgId: rec.orgId, deviceId: rec.deviceId, snapshotId: rec.snapshotId, tokenHash, restoreType: 'bare_metal', targetConfig: { bareMetalRecoveryId: rec.id }, status: 'authenticated', authenticatedAt: now, createdBy: rec.createdBy, expiresAt: new Date(now.getTime() + 24 * 3600 * 1000) }).returning();
    await tx.update(bareMetalRecoveries).set({ codeUsedAt: now, nonceHash: hashRecoveryNonce(nonce), recoveryTokenId: t!.id, status: 'media_booted', mediaBootedAt: now, updatedAt: now }).where(eq(bareMetalRecoveries.id, rec.id));
    return t!;
  });
  writeAuditEvent(c, { orgId: rec.orgId, action: 'bmr.recovery.exchange', resourceType: 'bare_metal_recovery', resourceId: rec.id, result: 'success', details: { tokenId: tokenRow.id, identity: rec.identity } });
  const bootstrap = await buildBootstrapForTokenRow(c, tokenRow, { recovery: { id: rec.id, identity: rec.identity, deviceId: rec.deviceId, snapshotId: rec.snapshotId, nonce } });
  if ('error' in bootstrap) return c.json(bootstrap, 409);
  return c.json({ token: plainToken, bootstrap });
});
```

Public progress:

```ts
bmrRecoveryPublicRoutes.post('/bmr/recover/progress', zValidator('json', bmrProgressSchema), async (c) => {
  const { token, status: to, target, plan, result, reason, warnings } = c.req.valid('json');
  if (!isValidRecoveryTokenFormat(token)) return c.json({ error: 'invalid_token' }, 400);
  const tokenHash = hashRecoveryToken(token);
  const limited = await enforceTokenRateLimit(c, 'progress', tokenHash, 600, 3600);
  if (limited) return limited;
  const [t] = await db.select({ id: recoveryTokens.id, status: recoveryTokens.status, expiresAt: recoveryTokens.expiresAt }).from(recoveryTokens).where(eq(recoveryTokens.tokenHash, tokenHash)).limit(1);
  if (!t || t.status === 'revoked' || t.expiresAt.getTime() < Date.now()) return c.json({ error: 'invalid_token' }, 401);
  const [rec] = await db.select().from(bareMetalRecoveries).where(eq(bareMetalRecoveries.recoveryTokenId, t.id)).limit(1);
  if (!rec) return c.json({ error: 'recovery_not_found' }, 404);
  let target_ = to;
  if (to === 'validated' && rec.identity === 'new') target_ = 'completed';
  if (!canTransition(rec.status, target_)) return c.json({ error: 'invalid_transition', from: rec.status, to: target_ }, 409);
  const now = new Date();
  const set: Record<string, unknown> = { status: target_, updatedAt: now };
  if (target) set.target = target;
  if (plan) set.plan = plan;
  if (result) set.result = result;
  if (warnings) set.warnings = warnings;
  const stamp: Record<string, string> = { media_booted: 'mediaBootedAt', planned: 'plannedAt', restoring: 'restoringAt', validated: 'validatedAt', rebooted: 'rebootedAt', completed: 'completedAt' };
  if (stamp[target_]) set[stamp[target_]] = now;
  if (target_ === 'completed') set.validatedAt = set.validatedAt ?? now;
  if (target_ === 'failed' || target_ === 'refused') set.failureReason = reason ?? (result as { error?: string; refusal?: string } | undefined)?.error ?? (result as { refusal?: string } | undefined)?.refusal ?? `${target_} without reason`;
  await db.update(bareMetalRecoveries).set(set).where(eq(bareMetalRecoveries.id, rec.id));
  writeAuditEvent(c, { orgId: rec.orgId, action: 'bmr.recovery.progress', resourceType: 'bare_metal_recovery', resourceId: rec.id, result: 'success', details: { from: rec.status, to: target_ } });
  return c.json({ id: rec.id, status: target_ });
});
```

`buildAuthenticatedBootstrapPayload` (recoveryBootstrap.ts): add optional `recovery?: { id: string; identity: 'original' | 'new'; deviceId: string; snapshotId: string | null; nonce?: string }` to its input and echo it as `recovery` in the payload. `authenticate` looks up `bareMetalRecoveries` by `recoveryTokenId = row.id` and passes `{ id, identity, deviceId, snapshotId }` (no nonce).

- [ ] **Step 4: Run route tests + typecheck**

```bash
cd apps/api && npx vitest run src/routes/backup/bmrRecoveries.test.ts src/routes/backup/bmr.test.ts src/services/recoveryBootstrap 2>&1 | tail -6 && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p . 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/backup/bmrRecoveries.ts apps/api/src/routes/backup/bmrRecoveries.test.ts apps/api/src/routes/backup/bmr.ts apps/api/src/routes/backup/schemas.ts apps/api/src/routes/backup/index.ts apps/api/src/services/recoveryBootstrap.ts
git commit -m "feat(api): bare-metal recoveries — create/list, one-time code exchange, phase progress (W04a)"
```

---

### Task 4: Heartbeat check-in (API)

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts:322` (append field), `apps/api/src/routes/agents/heartbeat.ts` (~`:860-940`, inside the org-scoped closure, before the guarded device update; and the response object)
- Test: `apps/api/src/routes/agents/heartbeat.test.ts` (extend; if the file does not exist, create it with the same chainMock scaffolding as `bmr.test.ts`, mocking `agentAuthMiddleware` to set `c.set('agent', {deviceId:'dev-1', orgId:'org-1', …})`)

**Interfaces:**
- Heartbeat request: `recoveryMarker: z.object({ recoveryId: z.string().uuid(), nonce: z.string().regex(/^[0-9a-f]{64}$/) }).optional().catch(undefined)`.
- Heartbeat response: `recoveryMarkerAck: true` present only when the marker matched (or was already acknowledged).
- Side effects on match: `bare_metal_recoveries.status = 'checked_in'`, `checked_in_at`; `deviceUpdates.recoveredAt = now`, `deviceUpdates.recoveredFromSnapshotId = rec.snapshotId`; audit `bmr.recovery.checked_in`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('heartbeat recovery marker', () => {
  it('completes a rebooted recovery when the nonce matches and acks', async () => {
    const nonce = 'a'.repeat(64);
    selectMock /* device lookup … existing fixtures */ ;
    selectMock.mockReturnValueOnce(chainMock([{ id: 'rec-1', orgId: 'org-1', deviceId: 'dev-1', snapshotId: 'snap-1', identity: 'original', status: 'rebooted', nonceHash: hashRecoveryNonce(nonce) }]));
    const res = await app.request('/agents/agent-1/heartbeat', { method: 'POST', headers: agentHeaders, body: JSON.stringify({ ...minimalHeartbeat, recoveryMarker: { recoveryId: '11111111-1111-4111-8111-111111111111', nonce } }) });
    expect(res.status).toBe(200);
    expect((await res.json()).recoveryMarkerAck).toBe(true);
    const recUpdate = updateMock.mock.results.map((r) => r.value.set.mock.calls[0]?.[0]).find((s) => s && s.status === 'checked_in');
    expect(recUpdate.checkedInAt).toBeInstanceOf(Date);
    const devUpdate = updateMock.mock.results.map((r) => r.value.set.mock.calls[0]?.[0]).find((s) => s && 'recoveredAt' in s);
    expect(devUpdate.recoveredFromSnapshotId).toBe('snap-1');
  });
  it('ignores a marker whose nonce does not match (no ack, no update, audit failure)', async () => { /* nonceHash of 'b'.repeat(64) → response lacks recoveryMarkerAck; no update with status checked_in */ });
  it('ignores a marker for a recovery in a terminal failed state', async () => { /* status 'failed' → no ack */ });
  it('re-acks an already checked_in recovery without writing again', async () => { /* status 'checked_in' + matching nonce → ack true, zero recovery updates */ });
  it('ignores a marker that belongs to another device', async () => { /* rec.deviceId 'dev-2' → no ack */ });
});
```

- [ ] **Step 2: Run to verify failure** — `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts -t "recovery marker" 2>&1 | tail -6`.

- [ ] **Step 3: Implement**

`schemas.ts` before the closing `});` of `heartbeatSchema`:

```ts
  // Bare-metal recovery W04a: the rebuild engine leaves a marker on the restored
  // disk; the agent sends it until the server acknowledges the check-in.
  recoveryMarker: z.object({ recoveryId: z.string().uuid(), nonce: z.string().regex(/^[0-9a-f]{64}$/) }).optional().catch(undefined),
```

`heartbeat.ts`, inside the org-scoped closure, immediately before the `deviceUpdates` block is finalised (before `:933`):

```ts
let recoveryMarkerAck = false;
if (data.recoveryMarker) {
  const marker = data.recoveryMarker;
  const [rec] = await db.select().from(bareMetalRecoveries)
    .where(and(eq(bareMetalRecoveries.id, marker.recoveryId), eq(bareMetalRecoveries.deviceId, device.id), eq(bareMetalRecoveries.orgId, agent.orgId)))
    .limit(1);
  const nonceOk = rec !== undefined && timingSafeEqualHex(rec.nonceHash, hashRecoveryNonce(marker.nonce));
  if (rec && nonceOk && rec.status === 'checked_in') {
    recoveryMarkerAck = true;
  } else if (rec && nonceOk && rec.identity === 'original' && ['restoring', 'validated', 'rebooted'].includes(rec.status)) {
    const now = new Date();
    await db.update(bareMetalRecoveries).set({ status: 'checked_in', checkedInAt: now, rebootedAt: rec.rebootedAt ?? now, updatedAt: now }).where(eq(bareMetalRecoveries.id, rec.id));
    deviceUpdates.recoveredAt = now;
    deviceUpdates.recoveredFromSnapshotId = rec.snapshotId;
    recoveryMarkerAck = true;
    writeAuditEvent(c, { orgId: agent.orgId, action: 'bmr.recovery.checked_in', resourceType: 'bare_metal_recovery', resourceId: rec.id, result: 'success', details: { deviceId: device.id, snapshotId: rec.snapshotId, from: rec.status } });
  } else {
    writeAuditEvent(c, { orgId: agent.orgId, action: 'bmr.recovery.checked_in', resourceType: 'bare_metal_recovery', resourceId: marker.recoveryId, result: 'failure', details: { deviceId: device.id, reason: !rec ? 'not_found' : !nonceOk ? 'nonce_mismatch' : `status_${rec.status}` } });
  }
}
```

`timingSafeEqualHex(a, b)` = `a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))` (import `timingSafeEqual` from `node:crypto`). Add `recoveryMarkerAck` to the response object: `...(recoveryMarkerAck ? { recoveryMarkerAck: true } : {})`. Import `bareMetalRecoveries` and `hashRecoveryNonce`.

- [ ] **Step 4: Run heartbeat tests + typecheck, commit**

```bash
cd apps/api && npx vitest run src/routes/agents/heartbeat 2>&1 | tail -4 && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p . 2>&1 | tail -3
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(api): heartbeat recovery-marker check-in completes bare-metal recoveries (W04a)"
```

---

### Task 5: Agent — send the marker, delete on ack

**Files:**
- Create: `agent/internal/heartbeat/recovery_marker.go`, `agent/internal/heartbeat/recovery_marker_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (`HeartbeatPayload` + the response struct + `sendHeartbeat`), `agent/internal/agentapp/main.go:684` `startAgent` (load once)

**Interfaces:**

```go
// RecoveryMarker mirrors rebuild's /var/lib/breeze/recovery-marker.json.
type RecoveryMarker struct {
	RecoveryID string `json:"recoveryId"`
	Nonce      string `json:"nonce"`
	SnapshotID string `json:"snapshotId,omitempty"`
}
const recoveryMarkerFile = "recovery-marker.json"
func LoadRecoveryMarker(dataDir string) (*RecoveryMarker, error)   // nil,nil when absent; error on unreadable/invalid
func AcknowledgeRecoveryMarker(dataDir string) error               // rename to recovery-marker.acked.json
func (h *Heartbeat) SetRecoveryMarker(m *RecoveryMarker)           // stored on the Heartbeat; sent while non-nil
```

`HeartbeatPayload` gains `RecoveryMarker *RecoveryMarker json:"recoveryMarker,omitempty"`; the heartbeat response struct gains `RecoveryMarkerAck bool json:"recoveryMarkerAck"`; on ack: `AcknowledgeRecoveryMarker(dataDir)` then `h.SetRecoveryMarker(nil)`.

- [ ] **Step 1: Write the failing tests**

```go
func TestLoadRecoveryMarker(t *testing.T) {
	dir := t.TempDir()
	if m, err := LoadRecoveryMarker(dir); m != nil || err != nil {
		t.Fatalf("absent: m=%v err=%v", m, err)
	}
	os.WriteFile(filepath.Join(dir, recoveryMarkerFile), []byte(`{"recoveryId":"rec-1","nonce":"`+strings.Repeat("a", 64)+`","snapshotId":"snap-1","completedAt":"2026-09-10T00:00:00Z"}`), 0o600)
	m, err := LoadRecoveryMarker(dir)
	if err != nil || m.RecoveryID != "rec-1" || len(m.Nonce) != 64 || m.SnapshotID != "snap-1" {
		t.Fatalf("m=%+v err=%v", m, err)
	}
	os.WriteFile(filepath.Join(dir, recoveryMarkerFile), []byte(`{"recoveryId":""}`), 0o600)
	if _, err := LoadRecoveryMarker(dir); err == nil {
		t.Fatal("empty recoveryId must be an error")
	}
	if err := AcknowledgeRecoveryMarker(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "recovery-marker.acked.json")); err != nil {
		t.Fatal("acked file missing")
	}
	if _, err := os.Stat(filepath.Join(dir, recoveryMarkerFile)); !os.IsNotExist(err) {
		t.Fatal("original marker must be gone")
	}
}

func TestHeartbeat_SendsMarkerUntilAcked(t *testing.T) {
	// Use the package's existing heartbeat test server helper (grep "httptest.NewServer" in heartbeat_test.go);
	// first response {"recoveryMarkerAck":false} → payload must contain recoveryMarker;
	// second response {"recoveryMarkerAck":true} → AcknowledgeRecoveryMarker called (file renamed) and the third payload has no recoveryMarker.
}
```

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./internal/heartbeat/ -run 'TestLoadRecoveryMarker|TestHeartbeat_SendsMarkerUntilAcked' 2>&1 | head -3`.

- [ ] **Step 3: Implement** (`recovery_marker.go` per the interface; `sendHeartbeat` sets `RecoveryMarker: h.recoveryMarker()` under the existing mutex; after decoding the response, `if resp.RecoveryMarkerAck && h.recoveryMarker() != nil { if err := AcknowledgeRecoveryMarker(config.GetDataDir()); err != nil { log.Warn(...) }; h.SetRecoveryMarker(nil) }`). In `startAgent` (`main.go:684`) after `hb := heartbeat.NewWithVersion(...)` (`:903`):

```go
	if marker, err := heartbeat.LoadRecoveryMarker(config.GetDataDir()); err != nil {
		log.Warn("recovery marker unreadable; bare-metal recovery will not auto-complete", "error", err.Error())
	} else if marker != nil {
		log.Info("recovery marker found; reporting bare-metal recovery check-in", "recoveryId", marker.RecoveryID)
		hb.SetRecoveryMarker(marker)
	}
```

- [ ] **Step 4: Run, vet, commit**

```bash
cd agent && go test -race -count=1 ./internal/heartbeat/ ./internal/agentapp/ 2>&1 | tail -3 && GOOS=windows go vet ./internal/heartbeat/ && git fetch origin main && golangci-lint run --new-from-rev=origin/main ./... | tail -1
git add agent/internal/heartbeat/recovery_marker.go agent/internal/heartbeat/recovery_marker_test.go agent/internal/heartbeat/heartbeat.go agent/internal/agentapp/main.go
git commit -m "feat(agent): send the bare-metal recovery marker in heartbeats until the server acks (W04a)"
```

---

### Task 6: Helper — token-driven `rebuild` mode with progress reporting

**Files:**
- Modify: `agent/internal/backup/bmr/types.go` (`BootstrapResponse.Recovery`), `agent/internal/backup/bmr/session.go` (export helpers), `agent/cmd/breeze-backup/rebuild_cmd.go` (`--token/--server`)
- Create: `agent/internal/backup/bmr/progress.go`, `agent/internal/backup/bmr/progress_test.go`
- Test: `agent/cmd/breeze-backup/rebuild_cmd_test.go`

**Interfaces:**

```go
// types.go
type RecoveryBinding struct {
	ID         string `json:"id"`
	Identity   string `json:"identity"` // original|new
	DeviceID   string `json:"deviceId"`
	SnapshotID string `json:"snapshotId"`
	Nonce      string `json:"nonce,omitempty"` // present only on the exchange response
}
// BootstrapResponse gains: Recovery *RecoveryBinding `json:"recovery,omitempty"`

// session.go
func AuthenticateRecoverySession(ctx context.Context, serverURL, token string) (*BootstrapResponse, error) // exported wrapper of authenticateRecoverySessionContext
func NewRecoveryProvider(ctx context.Context, serverURL, token string, bs *BootstrapResponse) (providers.BackupProvider, error) // newRecoveryDownloadProvider(ctx, serverURL, token, bs.Download); error when bs.Download == nil

// progress.go
type ProgressUpdate struct {
	Status   string         `json:"status"` // media_booted|planned|restoring|validated|rebooted|failed|refused
	Target   map[string]any `json:"target,omitempty"`
	Plan     any            `json:"plan,omitempty"`
	Result   any            `json:"result,omitempty"`
	Reason   string         `json:"reason,omitempty"`
	Warnings []string       `json:"warnings,omitempty"`
}
func PostRecoveryProgress(ctx context.Context, serverURL, token string, u ProgressUpdate) error // POST {server}/api/v1/backup/bmr/recover/progress {"token":…, ...u}; 409 invalid_transition is returned as *ProgressConflictError, other non-2xx as error; 3 retries with backoff on 5xx/network
```

CLI: `breeze-backup rebuild --token T --server URL --target … [--identity …]` (mutually exclusive with `--provider-config`): authenticate → provider → `identity` defaults to `bootstrap.Recovery.Identity` → `Marker` from `Recovery.ID/Nonce` (nonce required for `original`; error if absent) → post `planned` (with `plan` from a preflight `DryRun` first) → post `restoring` → `rebuild.Run` → on success post `validated` with `result`, then `rebooted` is posted by the console after the user confirms reboot (W04b) — the CLI posts `validated` only; on refusal post `refused` with `reason=result.Refusal`; on failure post `failed` with `result` + `reason`.

- [ ] **Step 1: Write the failing tests**

`progress_test.go`: `httptest.NewServer` asserting the JSON body `{token, status:"restoring"}` and path `/api/v1/backup/bmr/recover/progress`; a 409 `{error:"invalid_transition",from:"restoring",to:"planned"}` → `*ProgressConflictError` with `From/To`; a 503 twice then 200 → succeeds after retries.

`rebuild_cmd_test.go`: `TestRebuildCommand_TokenModeRequiresNoProviderConfig` (both flags → error message "use either --token/--server or --provider-config"); `TestRebuildCommand_TokenModePostsProgressSequence` — fake server implementing `authenticate` (returns a bootstrap with `download` descriptor pointing at the same fake server that serves `snapshots/snap-1/layout.json`, `manifest.json`, `system-state/manifest.json`, files) and `progress` (records statuses); inject a fake `rebuild.System` through an unexported package hook `rebuildSystemForTest`; run with `--target image:<tmp>/x.img --image-size 4G --skip-boot`; assert progress statuses recorded == `["planned","restoring","validated"]` and the `validated` body carries `result.status == "completed"`. A second case with a BIOS layout → statuses `["refused"]` with `reason` containing `layout.ReasonBIOSBoot`.

- [ ] **Step 2: Run to verify failure** — `cd agent && go test ./internal/backup/bmr/ ./cmd/breeze-backup/ -run 'TestPostRecoveryProgress|TestRebuildCommand_TokenMode' 2>&1 | head -5`.

- [ ] **Step 3: Implement** (per the interfaces; in `rebuild_cmd.go`, the token path):

```go
if token != "" {
	if providerConfig != "" { return errors.New("use either --token/--server or --provider-config, not both") }
	if server == "" { return errors.New("--server is required with --token") }
	bs, err := bmr.AuthenticateRecoverySession(ctx, server, token)
	if err != nil { return fmt.Errorf("authenticate: %w", err) }
	provider, err = bmr.NewRecoveryProvider(ctx, server, token, bs)
	if err != nil { return err }
	if bs.Recovery == nil { return errors.New("this token is not bound to a bare-metal recovery; create one in Breeze first") }
	if identityFlag == "" { identityFlag = bs.Recovery.Identity }
	if identityFlag == string(rebuild.IdentityOriginal) {
		if bs.Recovery.Nonce == "" { return errors.New("recovery nonce missing from bootstrap; re-exchange the code") }
		opts.Marker = &rebuild.Marker{RecoveryID: bs.Recovery.ID, Nonce: bs.Recovery.Nonce}
	}
	opts.SnapshotID = bs.SnapshotID
	report := func(u bmr.ProgressUpdate) { if err := bmr.PostRecoveryProgress(ctx, server, token, u); err != nil { fmt.Fprintf(cmd.ErrOrStderr(), "progress %s not recorded: %v\n", u.Status, err) } }
	dry := opts; dry.DryRun = true
	if pre, err := rebuild.Run(ctx, dry); err != nil {
		if pre != nil && pre.Status == "refused" { report(bmr.ProgressUpdate{Status: "refused", Reason: pre.Refusal, Result: pre}) } else { report(bmr.ProgressUpdate{Status: "failed", Reason: err.Error(), Result: pre}) }
		return err
	} else {
		report(bmr.ProgressUpdate{Status: "planned", Plan: pre.Plan, Target: map[string]any{"kind": tgt.Kind, "path": tgt.Path}})
	}
	report(bmr.ProgressUpdate{Status: "restoring"})
	res, runErr := rebuild.Run(ctx, opts)
	switch {
	case runErr == nil: report(bmr.ProgressUpdate{Status: "validated", Result: res, Warnings: res.Warnings})
	case res != nil && res.Status == "refused": report(bmr.ProgressUpdate{Status: "refused", Reason: res.Refusal, Result: res})
	default: report(bmr.ProgressUpdate{Status: "failed", Reason: runErr.Error(), Result: res})
	}
	// …then the existing result printing/--result-json and return runErr
}
```

(Progress posting failures never abort the rebuild — they are printed and the console shows them.)

- [ ] **Step 4: Run everything, lint, commit**

```bash
cd agent && go test -race -count=1 ./internal/backup/... ./cmd/breeze-backup/ 2>&1 | tail -4 && GOOS=windows go build ./cmd/breeze-backup/ && GOOS=darwin go build ./cmd/breeze-backup/ && golangci-lint run --new-from-rev=origin/main ./... | tail -1
git add agent/internal/backup/bmr/ agent/cmd/breeze-backup/
git commit -m "feat(breeze-backup): token-driven rebuild mode reporting phase progress to the server (W04a)"
```

---

### Task 7: Web — "Bare-metal recovery" section

**Files:**
- Create: `apps/web/src/components/backup/BareMetalRecoveryPanel.tsx`, `apps/web/src/components/backup/BareMetalRecoveryPanel.test.tsx`
- Modify: `apps/web/src/components/backup/RecoveryBootstrapTab.tsx` (render the panel above the token table), `apps/web/src/locales/*/backup.json` (new `bareMetal.*` keys, translated in all 7 non-English locales)

**Interfaces:**
- Panel props: `{ orgId?: string }`. Loads `GET /backup/snapshots?bareMetalRestorable=true` (add that query filter to `snapshots.ts` list route: `where(eq(backupSnapshots.bareMetalRestorable, true))` when `bareMetalRestorable=true` — one-line addition + test) and `GET /backup/bmr/recoveries?limit=20`. Create form: snapshot select (label shows device + timestamp), identity radio (Original device / New device), Create → shows the code in a large monospace block (`data-testid="bare-metal-recovery-code"`), expiry countdown, and a status timeline (created → media booted → planned → restoring → validated → rebooted → checked in) for the active recovery, polling `GET /backup/bmr/recoveries/:id` every 10 s until terminal; `overdue` renders an amber notice "No check-in yet — look at the recovery console"; `failed`/`refused` show `failureReason`.
- All mutations go through `runAction` (`apps/web/src/lib/runAction.ts`) per CLAUDE.md.

- [ ] **Step 1: Write the failing panel tests** (mock `fetchWithAuth` as `RecoveryBootstrapTab.test.tsx:1-40` does): creates a recovery and shows the formatted code; renders a refused create's reasons; timeline reflects `status: 'restoring'`; `overdue: true` shows the amber notice; terminal `checked_in` stops polling (assert `fetchMock` call count stable after `vi.advanceTimersByTime(30_000)`).

- [ ] **Step 2: Run to verify failure**, **Step 3: implement**, **Step 4:**

```bash
cd apps/web && npx vitest run src/components/backup/BareMetalRecoveryPanel.test.tsx src/components/backup/RecoveryBootstrapTab.test.tsx src/lib/i18n 2>&1 | tail -5 && npx tsc --noEmit -p . 2>&1 | tail -2 && cd ../.. && pnpm --filter @breeze/web lint 2>&1 | tail -2
git add apps/web/src/components/backup/BareMetalRecoveryPanel.tsx apps/web/src/components/backup/BareMetalRecoveryPanel.test.tsx apps/web/src/components/backup/RecoveryBootstrapTab.tsx apps/web/src/locales/*/backup.json apps/api/src/routes/backup/snapshots.ts apps/api/src/routes/backup/snapshots.test.ts
git commit -m "feat(web): bare-metal recovery panel — create code, live status timeline (W04a)"
```

---

### Task 8: Whole-wave verification, end-to-end proof, PR

- [ ] **Step 1: Suites**

```bash
cd apps/api && npx vitest run src/routes/backup src/routes/agents/heartbeat src/services/bareMetalRecoveryCodes.test.ts src/db/autoMigrate.test.ts src/routes/devices 2>&1 | tail -4
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts 2>&1 | tail -4
cd ../../agent && go test -race -count=1 ./... 2>&1 | grep -v "^ok" | head; golangci-lint run --new-from-rev=origin/main ./... | tail -1
```

- [ ] **Step 2: End-to-end on the lab stack (no media yet)** — lab stack up, Ubuntu rig enrolled on the lab build with a whole-machine snapshot:
  1. UI: create a recovery for the rig's snapshot (identity original) → code shown.
  2. On the rig (as root): `breeze-backup rebuild --token "$(curl -s -XPOST $LAB/api/v1/backup/bmr/recover/exchange -H 'content-type: application/json' -d '{"code":"<code>"}' | jq -r .token)" --server $LAB --target image:/var/tmp/e2e.img --image-size 40G --result-json /var/tmp/e2e.json` → UI timeline advances `media booted → planned → restoring → validated`.
  3. Simulate the reboot check-in without booting: copy `/var/tmp/… /var/lib/breeze/recovery-marker.json` out of the image (mount partition 3 of the loop device) into the rig's own `/var/lib/breeze/`, restart the agent → next heartbeat flips the recovery to `checked_in`, device shows `recoveredAt`, and the marker is renamed `.acked.json`.
  Record the recovery id, the `progress` audit rows, and the timeline screenshot in the PR body and in the campaign doc §11 as `W04a-e2e-checkin`.

- [ ] **Step 3: PR** — branch `feature/5493-bare-metal-boot-media/wave-5497` (W04 sub-issue; W04b will be a second PR on the same wave), body per task + evidence; do NOT `Closes #5497` (the wave closes with W04b) — write `Part of #5497`. One review round (Sonnet, explicit questions: RLS/system-context on the public routes, timing-safe nonce compare, transition table, no code/nonce leakage in any response or audit `details`), then `gh pr merge <N> --squash`.

---

## Self-review notes (plan author)

- Spec §8.1: `POST /backup/bmr/recoveries` → Task 3; 9-char one-time 15-min rate-limited code → Tasks 2, 3; exchange → Task 3; state machine with `validated` and `completed` → Tasks 2, 3; check-in on first heartbeat carrying the nonce, device `recovered_at`/`recovered_from_snapshot_id` → Tasks 1, 4, 5; failure reason and warnings persisted (closes the #5479 gap) → Task 3; overdue on read → Task 2/3.
- Spec §8.2: hardware changes are accepted for the same device because the restored agent authenticates with restored credentials; the marker completes the recovery — no fingerprint logic needed (none exists, see ground truth).
- Spec §9: no secrets on media (exchange happens at boot), codes bound to org/device/snapshot (row), rehearsals cannot resume production identity (`identity` fixed at create; marker only written for `original`).
- Names consistent: `bareMetalRecoveries`, `BARE_METAL_RECOVERY_STATUSES/TERMINAL`, `generateRecoveryCode/formatRecoveryCode/normalizeRecoveryCode/hashRecoveryCode`, `generateRecoveryNonce/hashRecoveryNonce`, `canTransition`, `isOverdue`, `toRecoverySummary`, `buildBootstrapForTokenRow`, `recoveryMarker`/`recoveryMarkerAck`, `heartbeat.RecoveryMarker/LoadRecoveryMarker/AcknowledgeRecoveryMarker`, `bmr.RecoveryBinding/AuthenticateRecoverySession/NewRecoveryProvider/PostRecoveryProgress/ProgressUpdate/ProgressConflictError`.
- Deliberate choice recorded: the nonce is generated at exchange time (disclosed once, hash stored), not at create time.
