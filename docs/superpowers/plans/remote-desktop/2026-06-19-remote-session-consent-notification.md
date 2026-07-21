# Remote Session Consent & End-User Notification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify (and optionally gate on consent from) the end user at a managed device when a technician starts a remote desktop session, with a persistent active-session indicator — all policy-configurable.

**Architecture:** The API is authoritative: it resolves the effective `remote_access` prompt policy for the target device and the (redacted) technician identity at offer time, and stamps a `prompt` block into the existing `start_desktop` agent command. The agent's `handleStartDesktop` reads that block and, in `consent` mode, requests an Allow/Deny verdict from the notify-scoped Breeze Helper (reusing the `SendCommandAndWait` IPC round-trip that `handleNotifyUser` already uses) **before** dispatching capture; in `notify` mode it fires a start notice and shows a top-center "active session" pill; on disconnect it hides the pill and fires an ended notice. The Helper renders the consent dialog and the banner as new always-on-top Tauri windows.

**Tech Stack:** PostgreSQL + Drizzle (hand-written SQL migrations, RLS), Hono + TypeScript (API), Go (agent), Rust + React + Tauri v2 (Breeze Helper), Vitest (TS), `go test` (agent).

**Design spec:** `docs/superpowers/specs/remote-desktop/2026-06-19-remote-session-consent-notification-design.md` (read it first — it contains the full UI design, decision matrix, and rationale).

## Global Constraints

- **Node:** prefix all `pnpm`/`vitest`/`tsx` commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). Fresh worktree needs `pnpm install` once.
- **Migrations:** hand-written SQL only (no `drizzle-kit generate`/`push`). Filename `YYYY-MM-DD-<slug>.sql`, applied in `localeCompare` order. Must be idempotent (`IF NOT EXISTS`, `DROP POLICY IF EXISTS` then `CREATE POLICY`, `DO $$` guards). No inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration. Use today's date `2026-06-19`.
- **RLS workflow:** every new tenant-scoped table gets RLS enabled + forced + policies **in the same migration that creates it**, an allowlist entry in `rls-coverage.integration.test.ts` **in the same PR**, and a functional `breeze_app` cross-tenant forge test (the coverage contract test alone does not prove the policy works).
- **Real-DB tests** go in `apps/api/src/__tests__/integration/*.integration.test.ts` (BLOCKING `integration-test` job, runs as `breeze_app`, autoMigrate + TRUNCATE-per-test). The unit `test-api` job has no `DATABASE_URL` so `it.runIf(!!process.env.DATABASE_URL)` cases skip there.
- **Defaults (verbatim from spec):** `session_prompt_mode` default `'notify'`; `consent_unavailable_behavior` default `'proceed'`; `notify_on_session_end` default `true`; `show_active_indicator` default `true`; `technician_identity_level` default `'name_email'`; consent timeout = **30000 ms** system constant (not policy-configurable in v1).
- **New IPC fields are additive/optional** — older agents/Helpers must ignore them and behave as today (degraded = silent).
- **Commit messages** end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

# Phase 1 — Policy table, RLS, API resolution, audit, `denied` state (apps/api)

## Task 1: Add `config_policy_remote_access_settings` Drizzle schema

**Files:**
- Modify: `apps/api/src/db/schema/configurationPolicies.ts` (add table after `configPolicyMonitoringSettings`, ~line 264)

**Interfaces:**
- Produces: `configPolicyRemoteAccessSettings` Drizzle table with columns `featureLinkId`, `sessionPromptMode`, `consentUnavailableBehavior`, `notifyOnSessionEnd`, `showActiveIndicator`, `technicianIdentityLevel`, `createdAt`, `updatedAt`.

- [ ] **Step 1: Add the table definition** (mirrors `configPolicyMonitoringSettings` exactly — same `featureLinkId` unique FK shape)

```typescript
export const configPolicyRemoteAccessSettings = pgTable('config_policy_remote_access_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  featureLinkId: uuid('feature_link_id').notNull().unique().references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
  // 'off' | 'notify' | 'consent'
  sessionPromptMode: text('session_prompt_mode').notNull().default('notify'),
  // 'proceed' | 'block' — applied when the user cannot be asked (no helper / no user / timeout)
  consentUnavailableBehavior: text('consent_unavailable_behavior').notNull().default('proceed'),
  notifyOnSessionEnd: boolean('notify_on_session_end').notNull().default(true),
  showActiveIndicator: boolean('show_active_indicator').notNull().default(true),
  // 'name_email' | 'name' | 'generic'
  technicianIdentityLevel: text('technician_identity_level').notNull().default('name_email'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

- [ ] **Step 2: Verify it's exported** — `configurationPolicies.ts` re-exports via `db/schema/index.ts` barrel; confirm the new symbol is picked up:

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json 2>&1 | head -20`
Expected: no new type errors referencing `configPolicyRemoteAccessSettings`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/db/schema/configurationPolicies.ts
git commit -m "feat(api): add config_policy_remote_access_settings schema"
```

## Task 2: Migration — create table + RLS + add `denied` to session status enum

**Files:**
- Create: `apps/api/migrations/2026-06-19-remote-session-consent-settings.sql`

**Interfaces:**
- Produces: table `config_policy_remote_access_settings` with FORCE RLS + 4 join policies; `remote_session_status` enum value `denied`.

- [ ] **Step 1: Write the migration** (RLS pattern copied verbatim from `2026-06-23-sec-review-1-fk-child-rls-backstop.sql`'s `config_policy_monitoring_settings` block — 3-hop scalar-subquery EXISTS through `configuration_policies`)

```sql
-- Remote-session consent/notification: per-policy settings + denied session state.

-- 1) Settings table (mirrors config_policy_monitoring_settings shape)
CREATE TABLE IF NOT EXISTS config_policy_remote_access_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id UUID NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  session_prompt_mode TEXT NOT NULL DEFAULT 'notify',
  consent_unavailable_behavior TEXT NOT NULL DEFAULT 'proceed',
  notify_on_session_end BOOLEAN NOT NULL DEFAULT TRUE,
  show_active_indicator BOOLEAN NOT NULL DEFAULT TRUE,
  technician_identity_level TEXT NOT NULL DEFAULT 'name_email',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Value guards (idempotent: drop-then-add)
DO $$ BEGIN
  ALTER TABLE config_policy_remote_access_settings DROP CONSTRAINT IF EXISTS chk_ras_prompt_mode;
  ALTER TABLE config_policy_remote_access_settings ADD CONSTRAINT chk_ras_prompt_mode
    CHECK (session_prompt_mode IN ('off','notify','consent'));
  ALTER TABLE config_policy_remote_access_settings DROP CONSTRAINT IF EXISTS chk_ras_unavailable;
  ALTER TABLE config_policy_remote_access_settings ADD CONSTRAINT chk_ras_unavailable
    CHECK (consent_unavailable_behavior IN ('proceed','block'));
  ALTER TABLE config_policy_remote_access_settings DROP CONSTRAINT IF EXISTS chk_ras_identity;
  ALTER TABLE config_policy_remote_access_settings ADD CONSTRAINT chk_ras_identity
    CHECK (technician_identity_level IN ('name_email','name','generic'));
END $$;

-- 2) RLS: reach org via feature_link_id → config_policy_feature_links.config_policy_id
--    → configuration_policies.org_id (scalar subqueries keep EXISTS FROM = configuration_policies)
ALTER TABLE config_policy_remote_access_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_remote_access_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_update ON config_policy_remote_access_settings;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON config_policy_remote_access_settings;
CREATE POLICY breeze_org_isolation_select ON config_policy_remote_access_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_insert ON config_policy_remote_access_settings FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_update ON config_policy_remote_access_settings FOR UPDATE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);
CREATE POLICY breeze_org_isolation_delete ON config_policy_remote_access_settings FOR DELETE USING (
  EXISTS (SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (SELECT fl.config_policy_id FROM config_policy_feature_links fl
                   WHERE fl.id = config_policy_remote_access_settings.feature_link_id)
    AND public.breeze_has_org_access(cp.org_id))
);

-- 3) New terminal session state for an end-user-denied connection
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'remote_session_status' AND e.enumlabel = 'denied'
  ) THEN
    ALTER TYPE remote_session_status ADD VALUE 'denied';
  END IF;
END $$;
```

- [ ] **Step 2: Apply locally and verify** (requires local DB + `.env.test` symlink — confirm the `breeze_app` role is `rolbypassrls=false` first)

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsx src/db/autoMigrate.ts 2>&1 | tail -20`
Expected: migration applies cleanly; re-running is a no-op (idempotent).

- [ ] **Step 3: Verify RLS as `breeze_app`** — forge a cross-tenant insert in psql, must fail:

Run: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "INSERT INTO config_policy_remote_access_settings (feature_link_id) VALUES (gen_random_uuid());"`
Expected: fails with `new row violates row-level security policy` (or FK violation if the random link id check runs first — either way, not a silent success).

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-06-19-remote-session-consent-settings.sql
git commit -m "feat(api): migration for remote-access settings table + RLS + denied session state"
```

## Task 3: Update Drizzle enum + register table in RLS coverage allowlist

**Files:**
- Modify: `apps/api/src/db/schema/remote.ts:7` (`remoteSessionStatusEnum`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`PARENT_FK_JOIN_POLICY_TABLES`, ~line 240)

**Interfaces:**
- Consumes: `configPolicyRemoteAccessSettings` (Task 1), migration (Task 2).
- Produces: `'denied'` in `remoteSessionStatusEnum`; allowlist entry proving the join policy.

- [ ] **Step 1: Add `denied` to the enum**

```typescript
export const remoteSessionStatusEnum = pgEnum('remote_session_status', ['pending', 'connecting', 'active', 'disconnected', 'failed', 'denied']);
```

- [ ] **Step 2: Add the allowlist entry** in `PARENT_FK_JOIN_POLICY_TABLES`, next to the other `config_policy_*` children:

```typescript
  ['config_policy_remote_access_settings', ['configuration_policies']],
```

- [ ] **Step 3: Run the RLS coverage contract test**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run -c vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts 2>&1 | tail -30`
Expected: the parent-FK join-policy coverage test passes with the new table included.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/db/schema/remote.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(api): register remote-access settings in RLS coverage; add denied session status"
```

## Task 4: Zod inline-settings schema + service decomposition (read/write path)

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` (add `remoteAccessInlineSettingsSchema`; add `case 'remote_access'` to `decomposeInlineSettings`; mirror in the update path)
- Test: `apps/api/src/services/configurationPolicy.remoteAccess.test.ts` (new unit test, Drizzle-mock style)

**Interfaces:**
- Produces: `remoteAccessInlineSettingsSchema` (Zod) with fields `sessionPromptMode`, `consentUnavailableBehavior`, `notifyOnSessionEnd`, `showActiveIndicator`, `technicianIdentityLevel`, all optional with the spec defaults; `decomposeInlineSettings` writes a `config_policy_remote_access_settings` row when `featureType === 'remote_access'`.

- [ ] **Step 1: Write the failing test** (schema defaults + decompose insert)

```typescript
import { describe, it, expect } from 'vitest';
import { remoteAccessInlineSettingsSchema } from './configurationPolicy';

describe('remoteAccessInlineSettingsSchema', () => {
  it('applies spec defaults when empty', () => {
    const parsed = remoteAccessInlineSettingsSchema.parse({});
    expect(parsed).toEqual({
      sessionPromptMode: 'notify',
      consentUnavailableBehavior: 'proceed',
      notifyOnSessionEnd: true,
      showActiveIndicator: true,
      technicianIdentityLevel: 'name_email',
    });
  });

  it('rejects an invalid mode', () => {
    expect(() => remoteAccessInlineSettingsSchema.parse({ sessionPromptMode: 'always' })).toThrow();
  });
});
```

- [ ] **Step 2: Run it, verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/configurationPolicy.remoteAccess.test.ts 2>&1 | tail -20`
Expected: FAIL — `remoteAccessInlineSettingsSchema` is not exported.

- [ ] **Step 3: Add the schema** (near `monitoringInlineSettingsSchema`)

```typescript
export const remoteAccessInlineSettingsSchema = z.object({
  sessionPromptMode: z.enum(['off', 'notify', 'consent']).default('notify'),
  consentUnavailableBehavior: z.enum(['proceed', 'block']).default('proceed'),
  notifyOnSessionEnd: z.boolean().default(true),
  showActiveIndicator: z.boolean().default(true),
  technicianIdentityLevel: z.enum(['name_email', 'name', 'generic']).default('name_email'),
});
```

- [ ] **Step 4: Add the decompose case** inside `decomposeInlineSettings`'s `switch (featureType)` (mirror the `monitoring` case structure)

```typescript
    case 'remote_access': {
      const parsed = remoteAccessInlineSettingsSchema.parse(s);
      await tx.insert(configPolicyRemoteAccessSettings).values({
        featureLinkId: linkId,
        sessionPromptMode: parsed.sessionPromptMode,
        consentUnavailableBehavior: parsed.consentUnavailableBehavior,
        notifyOnSessionEnd: parsed.notifyOnSessionEnd,
        showActiveIndicator: parsed.showActiveIndicator,
        technicianIdentityLevel: parsed.technicianIdentityLevel,
      });
      break;
    }
```

Add `configPolicyRemoteAccessSettings` to the schema import block at the top of the file. Mirror the same insert in the update/re-decompose path (find where `updateFeatureLink` deletes + re-inserts per-feature rows; ensure `config_policy_remote_access_settings` rows are deleted before re-decompose just like monitoring).

- [ ] **Step 5: Run the test, verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/configurationPolicy.remoteAccess.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.remoteAccess.test.ts
git commit -m "feat(api): remote_access inline-settings schema + policy decomposition"
```

## Task 5: Route validation for the `remote_access` feature link

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts` (POST + PATCH handlers — add a `remote_access` validation branch mirroring the `backup`/`pam` branches)
- Test: `apps/api/src/routes/configurationPolicies/featureLinks.remoteAccess.test.ts`

**Interfaces:**
- Consumes: `remoteAccessInlineSettingsSchema` (Task 4).
- Produces: POST/PATCH `/:id/features` validate `inlineSettings` for `featureType === 'remote_access'` and 400 on invalid.

- [ ] **Step 1: Write the failing route test** (mirror existing featureLinks route tests; assert 400 on bad mode, 201 on valid)

```typescript
// Mirror the existing featureLinks test harness in this directory.
// Assert: POST /:id/features with { featureType: 'remote_access', inlineSettings: { sessionPromptMode: 'nope' } } → 400
// Assert: POST with { featureType: 'remote_access', inlineSettings: { sessionPromptMode: 'consent' } } → 201
```

- [ ] **Step 2: Run it, verify failure** (route accepts invalid settings today)

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/configurationPolicies/featureLinks.remoteAccess.test.ts 2>&1 | tail -20`
Expected: FAIL (invalid mode currently returns 201).

- [ ] **Step 3: Add the validation branch** in both POST and PATCH handlers (alongside the `backup`/`pam` branches)

```typescript
    if (data.featureType === 'remote_access' && data.inlineSettings) {
      const parsed = remoteAccessInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid remote access settings', details: parsed.error.flatten(), issues: parsed.error.issues },
          400
        );
      }
      data.inlineSettings = parsed.data;
    }
```

- [ ] **Step 4: Run the test, verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/configurationPolicies/featureLinks.remoteAccess.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.remoteAccess.test.ts
git commit -m "feat(api): validate remote_access feature-link inline settings"
```

## Task 6: Resolve prompt policy + technician identity; stamp into `start_desktop`; ingest verdict; `denied` state + audit

**Files:**
- Modify: `apps/api/src/routes/remote/helpers.ts` (add `resolveRemoteSessionPromptConfig(deviceId)` next to `resolveDesktopSessionPolicy`; add `buildTechnicianDisplay(...)`)
- Modify: `apps/api/src/routes/remote/sessions.ts` (offer handler: build + attach `prompt`; add `POST /sessions/:id/deny` agent-facing handler)
- Test: `apps/api/src/routes/remote/promptConfig.integration.test.ts` (real-DB: resolution + identity redaction + RLS), `apps/api/src/routes/remote/sessions.deny.test.ts` (route)

**Interfaces:**
- Consumes: `configPolicyRemoteAccessSettings`, `resolveEffectiveConfig` (effective `remote_access` feature for the device).
- Produces:
  - `resolveRemoteSessionPromptConfig(deviceId: string): Promise<{ mode: 'off'|'notify'|'consent'; consentUnavailableBehavior: 'proceed'|'block'; notifyOnEnd: boolean; showIndicator: boolean; identityLevel: 'name_email'|'name'|'generic' }>` — returns the spec defaults when no `remote_access` policy applies.
  - `buildTechnicianDisplay(level, name, email, orgName): { name: string|null; email: string|null; orgName: string|null }` — redacts per identity level (`generic` → `{name:null,email:null,orgName}`; `name` → drops email).
  - `start_desktop` payload gains `prompt` (shape in spec §6.1).
  - `POST /sessions/:id/deny` sets `status='denied'` and audits.

- [ ] **Step 1: Write the failing resolution + redaction test**

```typescript
// promptConfig.integration.test.ts (it.runIf(!!process.env.DATABASE_URL))
// Seed: partner/org/device + a configuration_policy with a remote_access feature link
//   carrying inlineSettings { sessionPromptMode: 'consent', technicianIdentityLevel: 'name' }, assigned to the device.
// Assert resolveRemoteSessionPromptConfig(deviceId).mode === 'consent' and identityLevel === 'name'.
// Assert default path: a device with no remote_access policy → mode === 'notify' (spec default).
// Assert buildTechnicianDisplay('name', 'Jordan Lee', 'j@acme.com', 'Acme') === { name:'Jordan Lee', email:null, orgName:'Acme' }.
// Assert buildTechnicianDisplay('generic', ...) === { name:null, email:null, orgName:'Acme' }.
```

- [ ] **Step 2: Run it, verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts src/routes/remote/promptConfig.integration.test.ts 2>&1 | tail -25`
Expected: FAIL — functions undefined.

- [ ] **Step 3: Implement `resolveRemoteSessionPromptConfig` + `buildTechnicianDisplay`** in `helpers.ts`.

`resolveRemoteSessionPromptConfig` resolves the effective `remote_access` feature for the device (reuse the same effective-policy lookup `resolveDesktopSessionPolicy` uses — read its implementation and follow it), then reads the matching `config_policy_remote_access_settings` row by `featureLinkId`; if none, return the spec defaults. Run via `runOutsideDbContext`→`withSystemDbAccessContext` if it must work outside a request context (match `resolveDesktopSessionPolicy`). `buildTechnicianDisplay`:

```typescript
export function buildTechnicianDisplay(
  level: 'name_email' | 'name' | 'generic',
  name: string | null,
  email: string | null,
  orgName: string | null,
): { name: string | null; email: string | null; orgName: string | null } {
  if (level === 'generic') return { name: null, email: null, orgName };
  if (level === 'name') return { name, email: null, orgName };
  return { name, email, orgName };
}
```

- [ ] **Step 4: Stamp `prompt` into the offer handler.** In `sessions.ts` `POST /sessions/:id/offer`, after `resolveDesktopSessionPolicy(device.id)`, resolve the prompt config and technician identity (look up `users.name/email` via the existing `db.select({name, email}).from(users)` pattern; `orgName` from the org), then add to the `start_desktop` payload:

```typescript
    const promptCfg = await resolveRemoteSessionPromptConfig(device.id);
    let prompt: Record<string, unknown> | undefined;
    if (promptCfg.mode !== 'off') {
      const [tech] = await db.select({ name: users.name, email: users.email })
        .from(users).where(eq(users.id, session.userId)).limit(1);
      const display = buildTechnicianDisplay(
        promptCfg.identityLevel, tech?.name ?? null, tech?.email ?? null, /* orgName */ null,
      );
      prompt = {
        mode: promptCfg.mode,
        technicianDisplay: display,
        consentUnavailableBehavior: promptCfg.consentUnavailableBehavior,
        consentTimeoutMs: 30000,
        notifyOnEnd: promptCfg.notifyOnEnd,
        showIndicator: promptCfg.showIndicator,
      };
    }
    // ...add `...(prompt ? { prompt } : {})` into the start_desktop payload object.
```

- [ ] **Step 5: Add `POST /sessions/:id/deny`** (agent-facing; mirror the `/answer` handler's scope + ownership + state guards). It accepts `{ reason: 'user'|'timeout'|'no_user'|'helper_absent'|'policy_proceed' }` (here only deny/block reasons reach it), requires `status === 'connecting'`, sets `status='denied'`, and audits:

```typescript
    await db.update(remoteSessions).set({ status: 'denied', endedAt: new Date() }).where(eq(remoteSessions.id, sessionId));
    const action = reason === 'user' || reason === 'timeout' ? 'session_consent_denied' : 'session_consent_bypassed';
    await logSessionAudit(action, session.userId, device.orgId, { sessionId, reason }, getTrustedClientIpOrUndefined(c));
```

Also: where the agent's answer is ingested (`POST /sessions/:id/answer`) emit `session_consent_granted` (reason `user`) **only when** the session was in `consent` mode — thread a boolean from the agent's answer payload, or accept a `consentReason` field on the answer body and audit accordingly. (Keep `session_connected` as-is.)

- [ ] **Step 6: Write + run the deny route test, verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/remote/sessions.deny.test.ts src/routes/remote/promptConfig.integration.test.ts 2>&1 | tail -25` (integration file needs `vitest.integration.config.ts`)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/remote/helpers.ts apps/api/src/routes/remote/sessions.ts apps/api/src/routes/remote/promptConfig.integration.test.ts apps/api/src/routes/remote/sessions.deny.test.ts
git commit -m "feat(api): resolve remote-session prompt policy + technician identity, stamp start_desktop, add denied endpoint + consent audit"
```

---

# Phase 2 — Agent consent gate + IPC contract (agent/)

## Task 7: Extend IPC structs with the prompt block + verdict

**Files:**
- Modify: `agent/internal/ipc/message.go` (`DesktopStartRequest` ~254; new `ConsentRequest`/`ConsentResult`; new message type constants; `BannerShow`/`BannerHide`)
- Test: `agent/internal/ipc/message_test.go` (JSON round-trip)

**Interfaces:**
- Produces:
  - `DesktopPrompt` struct (`Mode`, `TechnicianName *string`, `TechnicianEmail *string`, `OrgName *string`, `ConsentUnavailableBehavior`, `ConsentTimeoutMs int`, `NotifyOnEnd bool`, `ShowIndicator bool`).
  - New constants `TypeConsentRequest = "consent_request"`, `TypeConsentResult = "consent_result"`, `TypeBannerShow = "banner_show"`, `TypeBannerHide = "banner_hide"`.
  - `ConsentRequest{ SessionID, TechnicianName, TechnicianEmail, OrgName string; TimeoutMs int; OnTimeout string }` and `ConsentResult{ Decision string /* allow|deny */ }`.
  - `BannerShowRequest{ SessionID, Label string; StartedAtUnixMs int64 }`.

- [ ] **Step 1: Write the failing round-trip test**

```go
func TestConsentRequestRoundTrip(t *testing.T) {
	in := ConsentRequest{SessionID: "s1", TechnicianName: "Jordan Lee", TimeoutMs: 30000, OnTimeout: "proceed"}
	b, err := json.Marshal(in)
	if err != nil { t.Fatal(err) }
	var out ConsentRequest
	if err := json.Unmarshal(b, &out); err != nil { t.Fatal(err) }
	if out.OnTimeout != "proceed" || out.TimeoutMs != 30000 { t.Fatalf("round-trip mismatch: %+v", out) }
}
```

- [ ] **Step 2: Run it, verify failure**

Run: `cd agent && go test ./internal/ipc/ -run TestConsentRequestRoundTrip 2>&1 | tail -10`
Expected: FAIL — undefined `ConsentRequest`.

- [ ] **Step 3: Add the constants + structs.** Add a `Prompt *DesktopPrompt \`json:"prompt,omitempty"\`` field to `DesktopStartRequest`, and the new types/constants above.

- [ ] **Step 4: Run the test, verify pass**

Run: `cd agent && go test ./internal/ipc/ -run TestConsentRequestRoundTrip 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/ipc/message.go agent/internal/ipc/message_test.go
git commit -m "feat(agent): IPC structs for desktop prompt, consent request/result, banner show/hide"
```

## Task 8: Pure consent-decision function

**Files:**
- Create: `agent/internal/heartbeat/consent.go`
- Test: `agent/internal/heartbeat/consent_test.go`

**Interfaces:**
- Produces: `decideConsent(verdict string /* "allow"|"deny"|"" */, helperPresent bool, timedOut bool, unavailableBehavior string) (proceed bool, reason string)` — encodes the spec's decision matrix. `reason ∈ {"user","timeout","no_user","helper_absent","policy_proceed"}`.

- [ ] **Step 1: Write the failing table test** (every row of the spec decision matrix)

```go
func TestDecideConsent(t *testing.T) {
	cases := []struct{ name, verdict string; helper, timedOut bool; behavior string; wantProceed bool; wantReason string }{
		{"allow", "allow", true, false, "proceed", true, "user"},
		{"deny-proceedFallback", "deny", true, false, "proceed", false, "user"},
		{"deny-blockFallback", "deny", true, false, "block", false, "user"},
		{"timeout-proceed", "", true, true, "proceed", true, "timeout"},   // proceed but reason=timeout
		{"timeout-block", "", true, true, "block", false, "timeout"},
		{"noHelper-proceed", "", false, false, "proceed", true, "helper_absent"},
		{"noHelper-block", "", false, false, "block", false, "helper_absent"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proceed, reason := decideConsent(c.verdict, c.helper, c.timedOut, c.behavior)
			if proceed != c.wantProceed || reason != c.wantReason {
				t.Fatalf("got (%v,%q) want (%v,%q)", proceed, reason, c.wantProceed, c.wantReason)
			}
		})
	}
}
```

- [ ] **Step 2: Run it, verify failure**

Run: `cd agent && go test ./internal/heartbeat/ -run TestDecideConsent 2>&1 | tail -10`
Expected: FAIL — undefined `decideConsent`.

- [ ] **Step 3: Implement `decideConsent`**

```go
package heartbeat

// decideConsent encodes the spec decision matrix. An explicit "deny" always
// blocks (reason "user"). Otherwise (no helper / no response) the configured
// unavailable-behavior decides, and the reason records why we couldn't get a
// positive answer.
func decideConsent(verdict string, helperPresent, timedOut bool, unavailableBehavior string) (bool, string) {
	switch verdict {
	case "allow":
		return true, "user"
	case "deny":
		return false, "user"
	}
	var reason string
	switch {
	case !helperPresent:
		reason = "helper_absent"
	case timedOut:
		reason = "timeout"
	default:
		reason = "no_user"
	}
	return unavailableBehavior == "proceed", reason
}
```

- [ ] **Step 4: Run the test, verify pass**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestDecideConsent 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/consent.go agent/internal/heartbeat/consent_test.go
git commit -m "feat(agent): pure consent-decision function for the spec matrix"
```

## Task 9: Wire the consent gate + notify + banner into `handleStartDesktop`

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop.go` (parse `prompt` from `cmd.Payload`; gate before `startDesktopViaHelper`; fire notify + banner)
- Modify: `agent/internal/heartbeat/heartbeat.go` (helper to POST the `denied` verdict to the API; banner hide + ended notice on disconnect)

**Interfaces:**
- Consumes: `decideConsent` (Task 8); `ipc.ConsentRequest`/`ipc.BannerShowRequest` (Task 7); the `sessionBroker.PreferredSessionWithScope("notify")` + `SendCommandAndWait` pattern from `handleNotifyUser`.
- Produces: consent enforced before capture; start/ended notices + banner driven; `denied` reported to the API.

- [ ] **Step 1: Parse the prompt block** in `handleStartDesktop` (after `parseDesktopSessionPolicy`). Add `parseDesktopPrompt(cmd.Payload) *ipc.DesktopPrompt` (re-marshal the `map[string]interface{}` into the `ipc.DesktopPrompt` struct from Task 7) returning nil when absent (older API). When present and `mode == "consent"`, run the gate **before** the `startDesktopViaHelper` dispatch:

```go
	prompt := parseDesktopPrompt(cmd.Payload)
	if prompt != nil && prompt.Mode == "consent" {
		verdict, helperPresent, timedOut := h.requestConsent(sessionID, prompt) // see Step 2
		proceed, reason := decideConsent(verdict, helperPresent, timedOut, prompt.ConsentUnavailableBehavior)
		if !proceed {
			go h.reportConsentDenied(sessionID, reason) // POST /sessions/:id/deny
			return tools.CommandResult{Status: "failed", Error: "remote session denied by user (" + reason + ")"}
		}
	}
```

- [ ] **Step 2: Implement `requestConsent`** — mirror `handleNotifyUser`: find the notify session (`h.sessionBroker.PreferredSessionWithScope("notify")`); if nil → return `("", false, false)` (helper absent). Else `SendCommandAndWait(session, "consent-"+sessionID, ipc.TypeConsentRequest, ipc.ConsentRequest{...}, time.Duration(prompt.ConsentTimeoutMs+2000)*time.Millisecond)`; on timeout error return `("", true, true)`; else unmarshal `ipc.ConsentResult` and return `(result.Decision, true, false)`.

- [ ] **Step 3: Fire notify + banner on a proceeding session.** After a successful `startDesktopViaHelper` (allow, or `notify`/`off`+indicator), when `prompt != nil`:
  - if `mode == "notify"`: send a `TypeNotify` ("`<name>` connected to your computer", or "A technician connected…" in generic) via the notify session — reuse `handleNotifyUser`'s build path or call it directly.
  - if `prompt.ShowIndicator`: send `TypeBannerShow` with `ipc.BannerShowRequest{SessionID, Label, StartedAtUnixMs}`.
  - Record (sessionID → prompt) in a small map so the disconnect path (Step 4) can fire the ended notice/banner-hide.

- [ ] **Step 4: On peer disconnect**, in the `ipc.TypeDesktopPeerDisconnected` branch of `heartbeat.go` (right where `sendDesktopDisconnectNotification` is called), look up the remembered prompt and, if present: send `TypeBannerHide`; if `NotifyOnEnd`, send a `TypeNotify` ("Remote session ended"). Then forget the mapping.

- [ ] **Step 5: Implement `reportConsentDenied`** — mirror `sendDesktopDisconnectNotification`, but instead of a WS command result, call the API `POST /sessions/:id/deny` with `{reason}` (use the agent's authenticated HTTP client; find how the agent makes authenticated API calls — same client used elsewhere in heartbeat). If HTTP isn't readily available from this context, instead emit a `command_result` the API's agentWs handler maps to a deny (coordinate with Task 6's ingestion). Pick whichever matches the existing answer-relay mechanism and note it.

- [ ] **Step 6: Build the agent**

Run: `cd agent && go build ./... 2>&1 | tail -20`
Expected: builds clean.

- [ ] **Step 7: Run agent heartbeat tests**

Run: `cd agent && go test -race ./internal/heartbeat/ 2>&1 | tail -20`
Expected: PASS (existing + new).

- [ ] **Step 8: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): consent gate + start/ended notices + active banner in handleStartDesktop"
```

## Task 10: Agent end-to-end decision smoke (table) test

**Files:**
- Test: `agent/internal/heartbeat/handlers_desktop_consent_test.go`

- [ ] **Step 1: Write a test** that injects a fake notify-session returning allow/deny/timeout and asserts `handleStartDesktop` proceeds to capture only on allow (or on `proceed` fallback), and returns a failed result + calls the deny reporter otherwise. Use the existing heartbeat test fakes/mocks for `sessionBroker`. If the broker isn't easily fakeable, assert at the `requestConsent`+`decideConsent` seam instead and document the gap.

- [ ] **Step 2: Run, iterate to green**

Run: `cd agent && go test -race ./internal/heartbeat/ -run Consent 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop_consent_test.go
git commit -m "test(agent): consent gate behavior across allow/deny/timeout/no-helper"
```

---

# Phase 3 — Breeze Helper UI (apps/helper)

> Read the existing IPC dispatch under `apps/helper/src-tauri/src/ipc/` and the `crate::ipc::client::run` path before starting — new message types are handled there. Both new surfaces are **separate always-on-top Tauri windows**. Full component code + CSS is in spec §9 — copy it verbatim.

## Task 11: Rust — handle consent + banner IPC messages; create the windows

**Files:**
- Modify: `apps/helper/src-tauri/src/ipc/` (the envelope dispatch — add `consent_request`, `banner_show`, `banner_hide` cases)
- Modify: `apps/helper/src-tauri/src/lib.rs` (window builders + a `#[tauri::command] submit_consent(session_id, decision)` that sends `ConsentResult` back over IPC and closes the consent window)

**Interfaces:**
- Produces: on `consent_request` → create window `consent` (`inner_size(380,300).center().decorations(false).always_on_top(true).focused(true).skip_taskbar(true)`) and `emit("consent-request", payload)`; on `banner_show` → create window `session-banner` (`inner_size(360,52)`, top-center, `transparent(true).decorations(false).always_on_top(true).skip_taskbar(true).focused(false)`) and `emit("banner-show", payload)`; on `banner_hide` → close `session-banner`. `submit_consent` Tauri command returns the verdict over the IPC socket as `ipc::ConsentResult` and closes `consent`.

- [ ] **Step 1: Add the dispatch + window creation + command.** Follow the existing pattern that emits `show-device-info` and the main-window `WebviewWindowBuilder`. The consent window loads a route that renders `ConsentDialog`; the banner window loads a route that renders `SessionBanner` (use a query param or distinct `WebviewUrl` like `index.html#/consent` / `index.html#/banner` and branch in the React entry — see Task 13).

- [ ] **Step 2: Build the Rust side**

Run: `cd apps/helper/src-tauri && cargo build 2>&1 | tail -25`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add apps/helper/src-tauri/src/ipc apps/helper/src-tauri/src/lib.rs
git commit -m "feat(helper): IPC handling + always-on-top windows for consent dialog and session banner"
```

## Task 12: CSS — consent + banner styles

**Files:**
- Modify: `apps/helper/src/styles.css` (append the `.helper-consent-*`, `.helper-btn-accept`, `.helper-sessionbanner-*` blocks, the `livePulse`/`slideDown` keyframes, and the reduced-motion guards — full block in spec §9.1 / §9.2)

- [ ] **Step 1: Append the styles** verbatim from spec §9.1 and §9.2 (uses existing tokens `--bg-secondary`, `--accent`, `--accent-subtle`, `--border`, `--text-*`, `--radius-*`, `--font-mono`, `--transition-fast`; the banner window root is `background: transparent`).

- [ ] **Step 2: Commit**

```bash
git add apps/helper/src/styles.css
git commit -m "feat(helper): consent dialog + session banner styles"
```

## Task 13: React — ConsentDialog + SessionBanner components and window routing

**Files:**
- Create: `apps/helper/src/windows/ConsentDialog.tsx` (verbatim from spec §9.1)
- Create: `apps/helper/src/windows/SessionBanner.tsx` (verbatim from spec §9.2)
- Modify: the React entry (`apps/helper/src/main.tsx` or `App.tsx`) to render `ConsentDialog`/`SessionBanner` when the window route is `#/consent` / `#/banner`, wiring `listen('consent-request', …)` / `listen('banner-show', …)` and `invoke('submit_consent', …)`.
- Test: `apps/helper/src/windows/ConsentDialog.test.tsx`, `apps/helper/src/windows/SessionBanner.test.tsx` (if `apps/helper` has a vitest+jsdom config; if not, add a minimal one mirroring `apps/web`).

**Interfaces:**
- Consumes: Tauri events `consent-request` (payload → `ConsentRequest` props), `banner-show` (payload → `{label, startedAt}`); Tauri command `submit_consent`.
- Produces: rendered dialog that calls `invoke('submit_consent', { sessionId, decision })` on Allow/Deny/timeout; banner pill with live elapsed.

- [ ] **Step 1: Write failing component tests** (only if a test runner exists in `apps/helper`)

```tsx
// ConsentDialog.test.tsx
// - renders "A technician" + no email when technicianName=null
// - default focus is the Deny button (denyRef)
// - Escape triggers onDecision(false,'user')
// - countdown label is "Connecting automatically in" when onTimeout='proceed', "Declining automatically in" when 'block'
// SessionBanner.test.tsx
// - shows the generic label and a mm:ss elapsed that ticks
```

- [ ] **Step 2: Run, verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/helper exec vitest run src/windows 2>&1 | tail -20`
Expected: FAIL (components missing). (If `@breeze/helper` has no vitest config, add one first, mirroring `apps/web/vitest.config.ts`.)

- [ ] **Step 3: Create both components** verbatim from spec §9.1 / §9.2, and add the window-route branching in the React entry (render `ConsentDialog` with props from the `consent-request` event; render `SessionBanner` from `banner-show`).

- [ ] **Step 4: Run tests, verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/helper exec vitest run src/windows 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Typecheck the helper frontend**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/helper exec tsc --noEmit 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/helper/src/windows apps/helper/src/main.tsx apps/helper/src/App.tsx
git commit -m "feat(helper): ConsentDialog + SessionBanner components and window routing"
```

## Task 14: Verify CSP allows the new windows

**Files:**
- Modify (if needed): `apps/helper/src-tauri/tauri.conf.json` (CSP / capabilities)

- [ ] **Step 1: Confirm** the existing CSP (`default-src 'self'; … style-src 'self' 'unsafe-inline'`) and Tauri capabilities permit window creation + `emit`/`listen`/`invoke` for the new windows. If Tauri v2 capability files gate window creation or `core:event`/`core:window` permissions, add the `consent` and `session-banner` window labels to the capability set.

- [ ] **Step 2: Commit (if changed)**

```bash
git add apps/helper/src-tauri/tauri.conf.json apps/helper/src-tauri/capabilities 2>/dev/null
git commit -m "chore(helper): permit consent + banner windows in capabilities/CSP" || echo "no change"
```

## Task 15: Manual in-Helper verification (no automated harness for Tauri windows)

- [ ] **Step 1:** Build + run the Helper locally; simulate a `consent_request` IPC envelope (or drive a real `consent`-mode session end-to-end per Task 16) and confirm: the consent window appears always-on-top and focused, Deny is default-focused, Escape denies, the countdown label matches the fallback, Allow/Deny round-trips a `ConsentResult`, and the banner pill appears top-center with a pulsing dot + ticking timer and disappears on session end. Record results in the PR description. (Helper window behavior can't be unit-tested; this manual gate stands in.)

---

# Phase 4 — Web viewer handles `denied` (apps/web)

## Task 16: Surface a user-denied connection in the viewer

**Files:**
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx` (the status poll ~lines 382–420)
- Test: `apps/web/src/components/remote/ConnectDesktopButton.denied.test.tsx`

**Interfaces:**
- Consumes: session status `'denied'` (Phase 1).
- Produces: when polling sees `status === 'denied'`, show an explicit "The user denied the connection" message instead of the generic pending/fallback path.

- [ ] **Step 1: Write the failing test** — mock the session fetch to return `{ status: 'denied' }` and assert a denied message renders (not the generic fallback).

- [ ] **Step 2: Run, verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/remote/ConnectDesktopButton.denied.test.tsx 2>&1 | tail -20`
Expected: FAIL.

- [ ] **Step 3: Handle `denied` in the poll.** In the `poll` callback, before the generic non-`pending` branch:

```typescript
            if (sessionStatus === 'denied') {
              setStatus('denied');               // add 'denied' to the status union + render a clear message
              return;
            }
```

Add a `'denied'` branch to the component's status union and render: "The user denied the remote connection." Stop polling.

- [ ] **Step 4: Run, verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/remote/ConnectDesktopButton.denied.test.tsx 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/remote/ConnectDesktopButton.tsx apps/web/src/components/remote/ConnectDesktopButton.denied.test.tsx
git commit -m "feat(web): show user-denied state in the remote desktop connect flow"
```

---

# Phase 5 — Integration + cross-cutting verification

## Task 17: Integration test — deny path teardown + audit

**Files:**
- Test: `apps/api/src/__tests__/integration/remote-session-consent.integration.test.ts`

- [ ] **Step 1:** Seed a `consent`-mode `remote_access` policy on a device; simulate the agent posting `POST /sessions/:id/deny` with reason `user`; assert the session row is `status='denied'` with `endedAt` set, and an `audit_logs` row exists with `action='session_consent_denied'`. Add a `policy_proceed`/`helper_absent` case asserting `action='session_consent_bypassed'`. (Real-DB integration file → BLOCKING `integration-test` job.)

- [ ] **Step 2: Run**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts src/__tests__/integration/remote-session-consent.integration.test.ts 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/remote-session-consent.integration.test.ts
git commit -m "test(api): integration coverage for consent deny/bypass teardown + audit"
```

## Task 18: Full-surface typecheck + targeted suites + docs/rollout note

**Files:**
- Modify: release-notes / deploy doc as needed (the **notify-on-by-default behavior change** must be called out — see spec §12).

- [ ] **Step 1: Typecheck everything touched**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit && pnpm --filter @breeze/web exec tsc --noEmit && pnpm --filter @breeze/helper exec tsc --noEmit 2>&1 | tail -20`
Expected: clean.

- [ ] **Step 2: Agent vet/build/test**

Run: `cd agent && go vet ./... && go build ./... && go test -race ./internal/heartbeat/ ./internal/ipc/ 2>&1 | tail -20`
Expected: clean + PASS.

- [ ] **Step 3: Add the rollout note** — document that `session_prompt_mode` defaults to `notify`, so every Helper-equipped device begins showing a start notice on upgrade; operators set a `remote_access` policy with `mode: off` for the prior silent behavior. Put it in the release notes draft / deploy doc per the `update-breeze-release-notes` convention.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: rollout note for remote-session consent default-notify behavior change"
```

---

## Notes for the implementer

- **Helper topology:** the notify-scoped session (`PreferredSessionWithScope("notify")`) is the Breeze Helper (Tauri). Capture goes to a different helper role via `TypeDesktopStart`. The consent gate sits in the **service** (`handleStartDesktop`) so it's independent of which process hosts capture — do **not** put it in `session_stream.go`.
- **Verdict-report transport (Task 9 Step 5):** confirm how the agent currently relays the WebRTC answer to the API (`command_result` over the agent WS vs. an authenticated HTTP `POST /answer`). Use the **same** transport for the deny verdict so auth/ownership is consistent; adjust Task 6's ingestion endpoint to match (a WS `command_result` mapped in `agentWs.ts`, or the HTTP `POST /sessions/:id/deny`).
- **Unattended / login screen:** no notify helper → `requestConsent` returns helper-absent → `consent_unavailable_behavior` decides; `notify` mode silently no-ops. This is the intended behavior, not a bug.
- **Effort/cost:** Phases are independently reviewable. Recommended review gates: after Phase 1 (RLS + audit are security-sensitive), after Phase 2 (consent correctness), and a final pass over Phases 3–4.
```
