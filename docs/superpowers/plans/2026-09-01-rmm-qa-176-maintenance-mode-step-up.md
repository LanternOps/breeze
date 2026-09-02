---
finding: RMM-QA-176
tracking_issue: none (QA backlog row; no GitHub issue exists — PR body carries `Refs: RMM-QA-176`)
branch: fix/rmm-qa-176-maintenance-mode-step-up
base: origin/main @ fcd5b498a
spec_commit: e34b9d852
rigor: HIGH (auth + tenancy-adjacent + shipped surfaces + migration)
---

# RMM-QA-176 — Device Maintenance-Mode Step-Up and Persisted Lease — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make entering or extending device maintenance mode a gated, auditable, persisted operation — an assured session **plus** a single-use, operation-bound step-up grant, with the window stored on `devices` (`maintenance_started_at/until/reason/started_by`) — while exit stays un-gated but liveness-truthful, machine principals are denied independently of MFA configuration, and the two parallel API-key-reachable maintenance-suppression authoring paths (config-policy feature links over HTTP, MCP `manage_policy_feature_link`) are closed.

**Architecture:** A new pure `services/deviceLiveness.ts` owns the offline threshold; a new `services/deviceMaintenanceLease.ts` owns the transactional row write (`FOR UPDATE` → re-check → exactly one `UPDATE … RETURNING`) with no auth and no Redis; `services/mfaStepUpGrant.ts` gains a `device_maintenance` operation plus `maintenanceResourceDigest`, the single canonicalizer both the mint route and the maintenance routes call; `POST /auth/mfa/step-up` generalizes its resource binding through a `RESOURCE_BOUND_OPERATIONS` map; `routes/devices/commands.ts` gains an unconditional `isInteractiveUserSession` gate, an entry-only `requireMfa()`, grant validate-then-consume-in-transaction, and a new server-side `POST /devices/bulk/maintenance` (preflight → consume once → one transaction). `featureLinks.ts` promotes `maintenance` to the existing patch MFA gate on add/update; `aiGuardrails.ts` escalates `manage_policy_feature_link:{add,update}` with `featureType: 'maintenance'` to input-aware Tier 3 (supervised), which fails MCP machine principals closed; the web ships a `MaintenanceModeDialog` driven by a server `403 STEP_UP_REQUIRED`.

**Tech Stack:** TypeScript, Hono, Drizzle ORM 0.45, Postgres (RLS as `breeze_app`), Redis (ioredis), zod v4, Vitest (unit + real-Postgres integration), React + Testing Library + i18next (web).

**Spec:** `docs/superpowers/specs/2026-09-01-rmm-qa-176-maintenance-mode-step-up-design.md` (same worktree, committed at `e34b9d852`). This plan argues from that spec's decisions D1–D12, verified facts F1–F20, RED list T1–T23 and non-claims §10. **Read both.** The spec's Decisions section is settled — do not reopen a decision; if execution proves one wrong, stop and report rather than improvising.

## Global Constraints

- **Worktree (the ONLY tree you touch):** `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-176` — a git worktree of `/Users/toddhebebrand/breeze`. Never `cd` into `/Users/toddhebebrand/breeze` itself and never touch any other worktree. Never push to `main`; never merge. All relative paths below are from this worktree root.
- **Branch:** `fix/rmm-qa-176-maintenance-mode-step-up`, HEAD `e34b9d852`, based on `origin/main @ fcd5b498a`.
- **Scratchpad (evidence root), referred to below as `<SP>`:** `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad`. RED and battery output goes under `<SP>/rmm-qa-176-red/`.
- **Rigor: HIGH — RED-first is mandatory for every behaviour change.** For each behaviour change: write the test, run it, save the failing output to `<SP>/rmm-qa-176-red/<test-id>.txt` (`… 2>&1 | tee <file>`), and paste the salient failing lines (test name + assertion/error line) into that task's commit message under `RED (before):`.
- **Every test control is mutation-proven.** After GREEN, apply the named mutation to the *implementation*, run the suite, watch the named test fail, revert with `git checkout -- <file>`, re-run green, and record the mutation and the observed failure line under `Mutation control:` in the same commit message. A mutation that does NOT turn the test red is a finding: stop, report the vacuous control, fix the test.
- **Install once, first:** `pnpm install --frozen-lockfile` at the worktree root — a fresh worktree has no `node_modules`. Node is pinned (`.nvmrc` = `22.23.2`).
- **Typecheck gate (API):** `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit`
- **Unit tests (API):** `pnpm --filter @breeze/api exec vitest run <explicit paths>` — list files explicitly; **never insert `--` before flags**; vitest path filters are substring matches, so a bare name can pull in unintended files.
- **Web tests:** `pnpm --filter @breeze/web exec vitest run <paths>`. Web lint: `pnpm --filter @breeze/web exec eslint <files>`. Web typecheck: `pnpm --filter @breeze/web exec tsc --noEmit`. API lint: `pnpm --filter @breeze/api exec eslint <files>`.
- **Integration tests (real Postgres as `breeze_app` + real Redis):** from the **worktree root** run `pnpm test-stack up` (a private, per-worktree stack that writes a worktree-local `.env.test`) → `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <paths>` → `pnpm test-stack down` at the end of the plan (Task 14). **NEVER run `pnpm --filter @breeze/api test:docker:up`** — it uses fixed container names that collide with and corrupt other worktrees' stacks and would destroy other agents' evidence. New integration files go under `apps/api/src/__tests__/integration/`; the config glob already includes them, so do not edit `vitest.integration.config.ts`.
- **Migration rules (Task 5 owns the only migration):**
  - Preferred filename form `YYYY-MM-DD-HHMMSS-<slug>.sql`. This plan's file is `apps/api/migrations/2026-10-01-100001-device-manual-maintenance-lease.sql`.
  - **Re-verify the ceiling at execution time** — main moves. Run `ls apps/api/migrations | sort | tail -3`. The ceiling verified while writing this plan is `2026-10-01-100000-script-children-rls.sql`; `…-100001-…` sorts strictly after it (`localeCompare` differs at the sixth stamp character, `1` > `0`, so the slug never enters the comparison). If a later stamp has landed, take the next free `2026-10-01-1000NN` or a later date that sorts after the real max.
  - Gates: `bash scripts/check-migration-naming.sh --staged` (rule 3, strict sort-after-max, is only checked in `--staged` mode) and `pnpm --filter @breeze/api check:migrations`.
  - **A shipped migration is NEVER edited.** If the file is wrong after it lands, add a new forward migration.
  - `devices` is an org-cascade table whose export policy enumerates every column (`services/tenantExportPolicyRegistry.ts:185`). **Every new column must be registered** or `__tests__/integration/tenant-export-policy.integration.test.ts` fails with `devices.<column>: unclassified`.
  - `2026-08-06-` is a CLOSED reserved date block (`scripts/check-migration-naming.sh:70`) — never name a file into it.
- **Machine-principal denial must NOT depend on the MFA gate.** API-key and MCP-OAuth auth contexts are built with `token: {}` (`routes/mcpServer.ts:2246`), and `hasSatisfiedMfa` returns `true` unconditionally when `ENABLE_2FA` is off (`middleware/auth.ts:886-889`). The denial is `isInteractiveUserSession` (`middleware/auth.ts:64`), unconditional, first after `requireScope`, on **entry and exit**. A test must prove denial **with `ENABLE_2FA=false`** (T9), or the control is vacuous.
- **Zero state change on denial is proven, not asserted.** Unit level: the denied request leaves `db.update` / `db.transaction` un-called. Integration level (Task 9): `SELECT *` the device row before, issue the denied request, `SELECT *` again, `expect(after).toEqual(before)`.
- **Commit trailer — every commit, verbatim, as the last two lines:**
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c
  ```
- **Do NOT edit the QA repo.** `/Users/toddhebebrand/breeze-rmm-qa/docs/qa/probes/core-device-actions-release-contract.test.ts:83-96` characterizes the *unsafe* state (`expect(maintenance).not.toContain("requireMfa()")`, `expect(maintenance).toContain("const targetStatus = data.enable ? 'maintenance' : 'online'")`, `expect(maintenance).toContain("durationHours: data.durationHours ?? null")`) and `maintenance-window-contract.test.tsx:127` pins `"data.featureType === 'patch' && !hasSatisfiedMfa(auth)"`. Those assertions are **expected to flip** after this lands; updating them is the QA repo's job, **not this branch's**. Task 13 records which assertions flip as evidence only.
- **Non-goals (do NOT implement — these are RMM-QA-217):** no heartbeat change (`routes/agents/heartbeat.ts:750` keeps writing `status: 'online'`); no fold of the lease into `isDeviceInMaintenance` (`services/maintenanceService.ts:42`) or `featureConfigResolver.checkDeviceMaintenanceWindow`; no lease-expiry sweeper; no countdown in the device UI; no index on `maintenance_until`; no change to the legacy `/maintenance/*` window routes; no `pre_maintenance_status` column; no unrelated refactoring.
- **Copy/strings fixed by the spec (use verbatim):** interactive gate `{ error: 'Interactive user session required' }` 403 (matches `routes/agentRollback.ts:39`); MFA gate `{ error: 'MFA required', code: 'MFA_REQUIRED' }` 403 (produced by the real `requireMfa()`); step-up gate `{ error: 'Step-up required', code: 'STEP_UP_REQUIRED' }` 403; state conflict `{ error: '…', code: 'MAINTENANCE_STATE_CONFLICT' }` 409; decommissioned keeps `'Cannot change maintenance mode for a decommissioned device'` 400; feature-link gate keeps `{ error: 'MFA required' }` 403; audit actions `device.maintenance.enable` / `device.maintenance.disable` / new `device.maintenance.extend` ("Maintenance mode extended").
- **Shared numbers have one owner:** `MAINTENANCE_MAX_DURATION_HOURS = 168` and `MAINTENANCE_MAX_BULK_DEVICES = 500` are exported from `services/mfaStepUpGrant.ts` and imported by `routes/auth/schemas.ts`, `routes/devices/schemas.ts` and the bulk route. Never retype the literals.
- **Codex (only if a read-only second opinion is wanted):** `codex exec "…" -s read-only -m gpt-5.6-sol -C <dir> < /dev/null` (the `< /dev/null` is required — `codex exec` blocks on stdin from the Bash tool).

## File map

| File | Responsibility | Task |
|---|---|---|
| `docs/superpowers/plans/2026-09-01-rmm-qa-176-maintenance-mode-step-up.md` | this plan | 1 |
| `apps/api/src/routes/devices/commands.test.ts` | test-double surface (partial auth mock, `ENABLE_2FA` getter, `principal`/`token`, tx stub); T1–T10; three existing maintenance cases flipped | 2, 7, 8 |
| `apps/api/src/services/deviceLiveness.ts` (new) | `DEFAULT_OFFLINE_THRESHOLD_MINUTES`, `resolveLivenessStatus` — pure, no DB (D7) | 3 |
| `apps/api/src/services/deviceLiveness.test.ts` (new) | boundary unit tests for the helper | 3 |
| `apps/api/src/jobs/offlineDetector.ts:37` | imports the constant instead of its private copy; no behaviour change | 3 |
| `apps/api/src/services/mfaStepUpGrant.ts` | `'device_maintenance'` operation, `maintenanceResourceDigest`, the two shared maxima (D11) | 4 |
| `apps/api/src/services/mfaStepUpGrant.test.ts` | T13 digest canonicalization | 4 |
| `apps/api/src/routes/auth/schemas.ts:147-179` | `STEP_UP_OPERATIONS` += `device_maintenance`; `maintenanceStepUpResource`; `resource` union (D11) | 4 |
| `apps/api/src/routes/auth/schemas.test.ts` | operation-list assertions extended (T12 half) | 4 |
| `apps/api/src/routes/auth/mfa.ts:1094-1197` | `RESOURCE_BOUND_OPERATIONS` map; digest dispatch by operation (D11) | 4 |
| `apps/api/src/routes/auth.test.ts:3675` | T12 mint-route cases | 4 |
| `apps/api/migrations/2026-10-01-100001-device-manual-maintenance-lease.sql` (new) | four nullable lease columns + idempotent CHECK (D5) | 5 |
| `apps/api/src/db/schema/devices.ts:85` | four matching Drizzle fields (D5) | 5 |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:185` | four column names appended to `devices.included` (F12) | 5 |
| `apps/api/src/__tests__/integration/deviceMaintenanceLease.integration.test.ts` (new) | T19 migration idempotency, CHECK, `ON DELETE SET NULL`, export-policy registration | 5 |
| `apps/api/src/services/deviceMaintenanceLease.ts` (new) | `MAINTENANCE_ENTRY_ALLOWED_STATUSES`, `MaintenanceLeaseError`, `applyMaintenanceEntry`, `clearMaintenanceLease` (D3, D6) | 6 |
| `apps/api/src/services/deviceMaintenanceLease.test.ts` (new) | T14 | 6 |
| `apps/api/src/routes/devices/schemas.ts:185-188` | `maintenanceModeSchema` discriminated union + `bulkMaintenanceSchema` (D4) | 7 |
| `apps/api/src/routes/devices/commands.ts:363-413` | gates + entry/extend/exit handler (D1, D3, D4, D12) | 7 |
| `apps/api/src/routes/devices/events.ts:346` | `device.maintenance.extend` label (D12) | 7 |
| `apps/api/src/routes/devices/commands.ts` (new route) | `POST /devices/bulk/maintenance` (D2) | 8 |
| `apps/api/src/__tests__/devices.endpoints.test.ts:238-262` | T11 — endpoint-level gate + API-key 401 | 9 |
| `apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts` (new) | byte-identical-row denial proof, real Postgres | 9 |
| `apps/api/src/routes/configurationPolicies/featureLinks.ts:107,286` | `MFA_GATED_FEATURE_TYPES` (D8); `:438` unchanged | 10 |
| `apps/api/src/routes/configurationPolicies/featureLinks.test.ts:46` | T15 | 10 |
| `apps/api/src/services/aiGuardrails.ts:452,466,1251` | `isInputAwareTier3`, `TIER3_INPUT_AWARE_ACTIONS` += 2 pairs, `resolveApprovalScope` override (D9.1) | 11 |
| `apps/api/src/services/aiGuardrails.test.ts`, `aiGuardrails.approvalScope.contract.test.ts` | T16 | 11 |
| `apps/api/src/services/aiToolsConfigPolicy.ts:751-845` | principal denial + `featureType` anti-bypass on `update` (D9.3) | 11 |
| `apps/api/src/services/aiToolsConfigPolicy.test.ts` | T17 | 11 |
| `apps/api/src/routes/mcpServer.approvalGate.test.ts` | T18 | 11 |
| `packages/shared/src/types/index.ts:142` | four optional lease fields on `Device` | 12 |
| `apps/web/src/lib/mfaStepUp.ts` (new) + `.test.ts` | `mintStepUpGrant` helper extracted from the store (D10) | 12 |
| `apps/web/src/stores/authenticator.ts:88-118` | `mintRegisterGrant` delegates TOTP/passkey branches | 12 |
| `apps/web/src/services/deviceActions.ts:537-556` | `enterMaintenanceMode`, `exitMaintenanceMode`, `bulkEnterMaintenanceMode` | 12 |
| `apps/web/src/components/devices/MaintenanceModeDialog.tsx` (new) + `.test.tsx` | reason/duration/factor dialog, server-driven step-up (D10, T21) | 12 |
| `apps/web/src/components/devices/DeviceActions.tsx:158-175`, `DeviceDetailPage.tsx:295-303`, `DevicesPage.tsx:854-862,1159-1191` | wiring | 12 |
| `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json` | dialog + error copy (8 locales, `localeParity.test.ts`) | 12 |
| `apps/docs/src/content/docs/features/maintenance-windows.mdx` | "Manual maintenance mode" note | 13 |

---

### Task 1: Bootstrap the worktree, baseline the suites, commit this plan

**Files:**
- Commit: `docs/superpowers/plans/2026-09-01-rmm-qa-176-maintenance-mode-step-up.md`

**Interfaces:**
- Consumes: nothing.
- Produces: an installed worktree, `<SP>/rmm-qa-176-red/00-baseline.txt` (the green baseline every later RED is measured against).

- [ ] **Step 1: Confirm the worktree, branch and base**

```bash
WT=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-176
git -C "$WT" branch --show-current && git -C "$WT" log --oneline -2 && git -C "$WT" status --short
```
Expected: branch `fix/rmm-qa-176-maintenance-mode-step-up`; HEAD `e34b9d852 docs(specs): RMM-QA-176 maintenance-mode step-up design` over `fcd5b498a`; the only untracked file is this plan.

- [ ] **Step 2: Create the evidence directory and install dependencies**

```bash
mkdir -p /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/rmm-qa-176-red
pnpm install --frozen-lockfile
```
Expected: install exits 0; `node_modules/` present at the worktree root.

- [ ] **Step 3: Re-verify the migration ceiling (it moves with main)**

```bash
ls apps/api/migrations | sort | tail -3
```
Expected: the last dated entry is `2026-10-01-100000-script-children-rls.sql` (the ceiling this plan's `…-100001-…` name was chosen against). If a higher name is present, record the new ceiling here and adjust the Task 5 filename to sort strictly after it. Confirm the choice mechanically:
```bash
node -e 'console.log("2026-10-01-100001-device-manual-maintenance-lease.sql".localeCompare("2026-10-01-100000-script-children-rls.sql") > 0)'
```
Expected: `true`.

- [ ] **Step 4: Baseline every suite this plan touches (all must be green BEFORE any change)**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run \
  src/routes/devices/commands.test.ts \
  src/__tests__/devices.endpoints.test.ts \
  src/routes/auth.test.ts \
  src/routes/auth/schemas.test.ts \
  src/services/mfaStepUpGrant.test.ts \
  src/jobs/offlineDetector.test.ts \
  src/jobs/offlineDetector_reeval.test.ts \
  src/jobs/offlineDetector_fanout.test.ts \
  src/jobs/offlineDetector_configPolicy.test.ts \
  src/jobs/offlineDetector_uninstallIntentReaper.test.ts \
  src/jobs/offlineDetector.dbcontext.test.ts \
  src/routes/configurationPolicies/featureLinks.test.ts \
  src/services/aiGuardrails.test.ts \
  src/services/aiGuardrails.approvalScope.contract.test.ts \
  src/services/aiToolsConfigPolicy.test.ts \
  src/routes/mcpServer.approvalGate.test.ts \
  src/routes/mcpServer.effectiveTier.test.ts \
  src/db/autoMigrate.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/00-baseline.txt" | tail -25
```
Expected: every file passes. Record the per-file test counts — Task 2 and Task 7 assert the counts they expect to change.

- [ ] **Step 5: Commit this plan (docs commit; the spec is already committed at `e34b9d852`)**

```bash
git add docs/superpowers/plans/2026-09-01-rmm-qa-176-maintenance-mode-step-up.md
git commit -m "docs(qa): RMM-QA-176 executable plan — maintenance-mode step-up and persisted lease

Turns the reviewed design spec (e34b9d852) into 14 executable tasks: RED-first
per behaviour change with mutation-proven controls, one forward migration
(2026-10-01-100001-device-manual-maintenance-lease.sql, sorts after the
2026-10-01-100000-script-children-rls.sql ceiling), and the per-file plan for
the three existing suites that must FLIP from asserting the ungated behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 2: Test-double surface for `commands.test.ts` — real auth gates, no behaviour change

`commands.test.ts:28-61` replaces the whole `middleware/auth` module, so `requireMfa` is a pass-through stub, and `isInteractiveUserSession` / `hasSatisfiedMfa` would import as `undefined` once `commands.ts` starts using them. A stubbed gate cannot produce an honest RED. This task switches to a **partial** mock (`importOriginal`) so the gates under test are the real implementations, keeps `requireScope`/`requirePermission` stubbed (the suite's site-scope logic lives there), and gives the mocked auth context the `principal` and `token` fields the real gates read. No production file changes; the suite must stay green at the Task 1 baseline count.

**Files:**
- Modify: `apps/api/src/routes/devices/commands.test.ts:4-13` (`../../db` mock), `:28-61` (auth mock)

**Interfaces:**
- Consumes: the Task 1 baseline counts.
- Produces, for Tasks 7–8:
  - a partial `../../middleware/auth` mock in which `requireMfa`, `hasSatisfiedMfa` and `isInteractiveUserSession` are the REAL exports;
  - an `enable2faState` hoisted box plus a `vi.mock('../../routes/auth/schemas')` getter so a test can flip `ENABLE_2FA` (pattern: `routes/auth/login.test.ts:271-280`);
  - a mutable `authState` box the tests use to swap `principal.kind`, `token.mfa` and `token.sid` per case;
  - `db.transaction` on the `../../db` mock;
  - helper `mockMaintenanceTx(opts)` returning `{ txSelect, txUpdate, capturedUpdates, calls }`.

- [ ] **Step 1: Add the hoisted state boxes and the `ENABLE_2FA` getter mock**

At the top of `apps/api/src/routes/devices/commands.test.ts`, immediately after the `import { Hono } from 'hono';` line, insert:

```ts
// RMM-QA-176: ENABLE_2FA is a module constant (routes/auth/schemas.ts:10); the
// established way to flip it per test is a getter on a partial module mock
// (precedent: routes/auth/login.test.ts:271-280). T1 asserts it is TRUE by
// default so no later RED can be an "ENABLE_2FA=false" artefact.
const { enable2faState, authState } = vi.hoisted(() => ({
  enable2faState: { value: true },
  authState: {
    principalKind: 'user_session' as string,
    mfa: true as boolean,
    sid: 'sid-1' as string | undefined,
  },
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});
```

- [ ] **Step 2: Add `transaction` to the `../../db` mock**

In the `vi.mock('../../db', …)` factory (currently `:4-13`), add `transaction: vi.fn(),` next to `update: vi.fn()` inside the `db` object.

- [ ] **Step 3: Convert the `middleware/auth` mock to a partial mock and give the context `principal` + `token`**

Replace the whole `vi.mock('../../middleware/auth', () => ({ … }))` block (`:28-61`) with:

```ts
// PARTIAL mock (RMM-QA-176): requireMfa, hasSatisfiedMfa and
// isInteractiveUserSession must be the REAL implementations — the gates this
// suite now proves are exactly those three. Only the transport-ish middlewares
// (authMiddleware) and the two authorization stubs whose behaviour this suite
// drives by header (requireScope / requirePermission) stay mocked.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        // `principal` drives isInteractiveUserSession (middleware/auth.ts:64);
        // `token` drives hasSatisfiedMfa (middleware/auth.ts:886). API-key
        // contexts are built with `token: {}` (routes/mcpServer.ts:2246), which
        // is why T9 sets principalKind without touching `mfa`.
        principal: { kind: authState.principalKind, id: 'principal-1' },
        token: { mfa: authState.mfa, sid: authState.sid },
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: 'org-123',
        partnerId: null,
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (orgId: string) => orgId === 'org-123'
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      if (resource === 'devices' && action === 'read' && c.req.header('x-deny-read') === 'true') {
        return c.json({ error: 'Permission denied' }, 403);
      }
      // Production `requirePermission` ALWAYS populates `permissions`; the
      // canAccessDeviceSite helper fails closed when it is absent (T10), so the
      // mock must mirror that — set an unrestricted context by default, and add
      // a site restriction only when the test asks for one.
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        ...(c.req.header('x-site-restricted') === 'true'
          ? { allowedSiteIds: ['site-allowed'] }
          : {}),
      });
      return next();
    }),
  };
});
```

- [ ] **Step 4: Reset the state boxes between tests**

In the top-level `beforeEach` (currently `vi.clearAllMocks(); app = new Hono(); app.route('/devices', commandsRoutes);`), add as the first three lines of the body:

```ts
    enable2faState.value = true;
    authState.principalKind = 'user_session';
    authState.mfa = true;
    authState.sid = 'sid-1';
```

- [ ] **Step 5: Run the suite — must be green at the Task 1 baseline count**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/devices/commands.test.ts 2>&1 | tail -20
```
Expected: PASS, same test count as `00-baseline.txt` for this file. The real `requireMfa()` now runs on `POST /devices/bulk/commands`, `/:id/commands` and `/:id/auto-update`; `authState.mfa = true` satisfies it, which is why the count is unchanged.

*Contingency (only if the suite errors on module load, not on an assertion):* the real `middleware/auth` pulls `services/jwt`, `services/permissions`, `services/tokenRevocation`, `services/tenantStatus`, `services/mfaPolicy`, `services/sentry`, `services/auditEvents`. None execute (`authMiddleware` is overridden), but if one has an import-time side effect that breaks under this suite's `../../db` mock, add the narrowest stub for that one module and note it in the commit message — do not revert to a wholesale auth mock.

- [ ] **Step 6: Typecheck**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/devices/commands.test.ts
git commit -m "test(devices): make commands.test.ts exercise the REAL auth gates (RMM-QA-176 prep)

Test-double surface only, no production change. The wholesale
vi.mock('../../middleware/auth') stubbed requireMfa as a pass-through and
exported no hasSatisfiedMfa / isInteractiveUserSession, so a gate added to the
maintenance route could not produce an honest RED. Switched to a partial mock
via importOriginal (requireMfa / hasSatisfiedMfa / isInteractiveUserSession are
now real; requireScope / requirePermission stay stubbed), gave the mocked auth
context the principal + token fields the real gates read, added an ENABLE_2FA
getter box (login.test.ts:271-280 pattern) and db.transaction.

Suite green at the pre-change test count.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 3: D7 — `services/deviceLiveness.ts`, the single owner of the offline threshold

**Files:**
- Create: `apps/api/src/services/deviceLiveness.ts`
- Create: `apps/api/src/services/deviceLiveness.test.ts`
- Modify: `apps/api/src/jobs/offlineDetector.ts:36-37`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 5`
  - `export function resolveLivenessStatus(lastSeenAt: Date | null | undefined, now: Date): 'online' | 'offline'`

  Consumed by `jobs/offlineDetector.ts` (constant only) and `services/deviceMaintenanceLease.ts` (Task 6, both).

- [ ] **Step 1: Write the failing unit test `apps/api/src/services/deviceLiveness.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_OFFLINE_THRESHOLD_MINUTES, resolveLivenessStatus } from './deviceLiveness';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe('deviceLiveness', () => {
  it('pins the offline threshold at the value offlineDetector shipped with', () => {
    // The six offlineDetector suites assert behaviour derived from this number;
    // moving it is a fleet-wide change, not a refactor.
    expect(DEFAULT_OFFLINE_THRESHOLD_MINUTES).toBe(5);
  });

  it('treats a device seen inside the threshold as online', () => {
    expect(resolveLivenessStatus(minutesAgo(1), NOW)).toBe('online');
  });

  it('treats a device seen exactly at the threshold as online (inclusive boundary)', () => {
    expect(resolveLivenessStatus(minutesAgo(DEFAULT_OFFLINE_THRESHOLD_MINUTES), NOW)).toBe('online');
  });

  it('treats a device seen one second past the threshold as offline', () => {
    expect(resolveLivenessStatus(new Date(minutesAgo(DEFAULT_OFFLINE_THRESHOLD_MINUTES).getTime() - 1000), NOW)).toBe('offline');
  });

  it('treats a device that has never been seen as offline', () => {
    expect(resolveLivenessStatus(null, NOW)).toBe('offline');
    expect(resolveLivenessStatus(undefined, NOW)).toBe('offline');
  });

  it('treats a future last_seen_at as online rather than throwing (clock skew)', () => {
    expect(resolveLivenessStatus(new Date(NOW.getTime() + 60_000), NOW)).toBe('online');
  });
});
```

- [ ] **Step 2: Run it and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run src/services/deviceLiveness.test.ts 2>&1 | tee "$SP/rmm-qa-176-red/T20-deviceLiveness.txt" | tail -20
```
Expected: FAIL — `Failed to resolve import "./deviceLiveness"`. Copy that line into the commit message.

- [ ] **Step 3: Create `apps/api/src/services/deviceLiveness.ts`**

```ts
/**
 * Device liveness, in one place (RMM-QA-176 D7).
 *
 * `DEFAULT_OFFLINE_THRESHOLD_MINUTES` was a private const inside
 * jobs/offlineDetector.ts, which also owns a BullMQ queue — importing that
 * module from a request path would drag the queue in. The maintenance EXIT
 * path (routes/devices/commands.ts) needs the same threshold to answer "is
 * this device actually alive right now?" instead of restoring a stale stored
 * status, so the number and the predicate live here and the detector imports
 * the constant. No behaviour change: the value is unchanged and the six
 * offlineDetector suites are the guard.
 */
export const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 5;

/**
 * Fresh-evidence liveness. `online` iff the agent was seen within the
 * threshold; a never-seen device is `offline`. A `lastSeenAt` in the future
 * (clock skew) reads as `online` — the conservative direction for a device
 * that is demonstrably reporting.
 */
export function resolveLivenessStatus(
  lastSeenAt: Date | null | undefined,
  now: Date,
): 'online' | 'offline' {
  if (!lastSeenAt) return 'offline';
  const ageMs = now.getTime() - lastSeenAt.getTime();
  return ageMs <= DEFAULT_OFFLINE_THRESHOLD_MINUTES * 60_000 ? 'online' : 'offline';
}
```

- [ ] **Step 4: Point `offlineDetector.ts` at the shared constant**

In `apps/api/src/jobs/offlineDetector.ts`, delete lines 36-37:
```ts
// Default offline threshold in minutes
const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 5;
```
and add to the import block at the top of the file:
```ts
import { DEFAULT_OFFLINE_THRESHOLD_MINUTES } from '../services/deviceLiveness';
```
Nothing else in that file changes; its two use sites (`:217`, `:316`) keep the same identifier.

- [ ] **Step 5: GREEN — the new suite and all six detector suites**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/deviceLiveness.test.ts \
  src/jobs/offlineDetector.test.ts \
  src/jobs/offlineDetector_reeval.test.ts \
  src/jobs/offlineDetector_fanout.test.ts \
  src/jobs/offlineDetector_configPolicy.test.ts \
  src/jobs/offlineDetector_uninstallIntentReaper.test.ts \
  src/jobs/offlineDetector.dbcontext.test.ts 2>&1 | tail -20
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass, detector counts identical to `00-baseline.txt`; tsc exits 0.

- [ ] **Step 6: Mutation controls**

  1. In `deviceLiveness.ts` change `DEFAULT_OFFLINE_THRESHOLD_MINUTES = 5` to `= 6`. Run the command from Step 5. Expected: the "pins the offline threshold" test fails AND at least one `offlineDetector*` threshold assertion fails — the proof that the constant is load-bearing in both places. Revert: `git checkout -- apps/api/src/services/deviceLiveness.ts`; re-run green.
  2. Change `ageMs <=` to `ageMs <` . Expected: "exactly at the threshold" fails. Revert; re-run green.

  Record both mutations and their observed failure lines.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/deviceLiveness.ts apps/api/src/services/deviceLiveness.test.ts apps/api/src/jobs/offlineDetector.ts
git commit -m "refactor(devices): export the offline threshold from services/deviceLiveness (RMM-QA-176 D7)

New pure module owns DEFAULT_OFFLINE_THRESHOLD_MINUTES (unchanged: 5) and
resolveLivenessStatus(lastSeenAt, now). jobs/offlineDetector.ts imports the
constant instead of keeping a private copy; the maintenance EXIT path (D3)
will use the predicate so exit derives status from fresh evidence rather than
restoring a stale value. No behaviour change — the six offlineDetector suites
are the guard and are green at their baseline counts.

RED (before): <paste from T20-deviceLiveness.txt: Failed to resolve import \"./deviceLiveness\">
Mutation control: <paste the two observed failures from Step 6>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 4: D11 — `device_maintenance` step-up operation, digest, and generalized resource binding

**Files:**
- Modify: `apps/api/src/services/mfaStepUpGrant.ts:32-38` (operation union), `:65-78` (digests)
- Modify: `apps/api/src/services/mfaStepUpGrant.test.ts:25` (import), append a `maintenanceResourceDigest` describe
- Modify: `apps/api/src/routes/auth/schemas.ts:147-179`
- Modify: `apps/api/src/routes/auth/schemas.test.ts` (append cases)
- Modify: `apps/api/src/routes/auth/mfa.ts:1101-1105` and `:1181-1185`
- Modify: `apps/api/src/routes/auth.test.ts:3675` describe (append cases)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 7, 8, 12):
  - `type StepUpOperation = 'add_factor' | 'register_approver_device' | 'agent_rollback' | 'enroll_first_factor' | 'device_maintenance'`
  - `export const MAINTENANCE_MAX_DURATION_HOURS = 168`
  - `export const MAINTENANCE_MAX_BULK_DEVICES = 500`
  - `export function maintenanceResourceDigest(input: { deviceIds: string[]; reason: string; durationHours: number }): \`sha256:${string}\``
  - `export const rollbackStepUpResource` and `export const maintenanceStepUpResource` (zod objects) from `routes/auth/schemas.ts`
  - wire contract: `POST /auth/mfa/step-up` accepts `{ method, …, operation: 'device_maintenance', resource: { deviceIds, reason, durationHours } }` → `{ stepUpGrantId }`

- [ ] **Step 1: Write the failing digest test — append to `apps/api/src/services/mfaStepUpGrant.test.ts`**

Change the import on `:25` to add `maintenanceResourceDigest`, then append after the existing `describe('rollbackResourceDigest', …)` block:

```ts
describe('maintenanceResourceDigest', () => {
  const base = { deviceIds: ['b-2', 'a-1'], reason: '  scheduled patching  ', durationHours: 4 };

  it('is insensitive to deviceIds order', () => {
    expect(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2'] }))
      .toBe(maintenanceResourceDigest({ ...base, deviceIds: ['b-2', 'a-1'] }));
  });

  it('is insensitive to duplicate deviceIds', () => {
    expect(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2', 'a-1'] }))
      .toBe(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2'] }));
  });

  it('trims reason so the mint route and the maintenance route cannot disagree', () => {
    expect(maintenanceResourceDigest(base))
      .toBe(maintenanceResourceDigest({ ...base, reason: 'scheduled patching' }));
  });

  it('binds durationHours — a longer window is a different grant', () => {
    expect(maintenanceResourceDigest({ ...base, durationHours: 8 }))
      .not.toBe(maintenanceResourceDigest(base));
  });

  it('binds the device set — adding a device is a different grant', () => {
    expect(maintenanceResourceDigest({ ...base, deviceIds: ['a-1', 'b-2', 'c-3'] }))
      .not.toBe(maintenanceResourceDigest(base));
  });

  it('binds the reason — a different justification is a different grant', () => {
    expect(maintenanceResourceDigest({ ...base, reason: 'hardware swap' }))
      .not.toBe(maintenanceResourceDigest(base));
  });

  it('emits the sha256: prefixed shape the grant store compares literally', () => {
    expect(maintenanceResourceDigest(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Write the failing mint-route tests — append inside `describe('POST /auth/mfa/step-up', …)` in `apps/api/src/routes/auth.test.ts` (opens at `:3675`)**

Add `maintenanceResourceDigest` to whatever import that file already uses for `mfaStepUpGrant` symbols (the module is mocked there; import the real digest from `'../services/mfaStepUpGrant'` via `await vi.importActual` inside the test if the module mock shadows it — check the file's existing pattern for `rollbackResourceDigest` first and mirror it exactly).

```ts
		it('mints a device_maintenance grant bound to the canonical resource digest', async () => {
			vi.mocked(verifyStepUpPasskeyAssertion).mockResolvedValueOnce(true);
			vi.mocked(mintStepUpGrant).mockResolvedValueOnce('grant-maintenance');
			const resource = {
				deviceIds: ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010'],
				reason: 'scheduled patching',
				durationHours: 4,
			};
			const res = await app.request('/auth/mfa/step-up', {
				method: 'POST',
				headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
				body: JSON.stringify({ method: 'passkey', credential: { id: 'credential-1' }, operation: 'device_maintenance', resource }),
			});
			expect(res.status).toBe(200);
			expect(mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({
				operation: 'device_maintenance',
				resourceDigest: maintenanceResourceDigest(resource),
			}));
		});

		it('rejects device_maintenance without a resource binding, before factor verification', async () => {
			const res = await app.request('/auth/mfa/step-up', {
				method: 'POST',
				headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
				body: JSON.stringify({ method: 'passkey', credential: { id: 'credential-1' }, operation: 'device_maintenance' }),
			});
			expect(res.status).toBe(400);
			expect(verifyStepUpPasskeyAssertion).not.toHaveBeenCalled();
			expect(mintStepUpGrant).not.toHaveBeenCalled();
		});

		it('rejects device_maintenance carrying a ROLLBACK-shaped resource (per-operation shape check)', async () => {
			const res = await app.request('/auth/mfa/step-up', {
				method: 'POST',
				headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'passkey',
					credential: { id: 'credential-1' },
					operation: 'device_maintenance',
					resource: { deviceId: '00000000-0000-4000-8000-000000000004', currentVersion: '2.0.0', targetVersion: '1.9.0', reason: 'incident rollback' },
				}),
			});
			expect(res.status).toBe(400);
			expect(mintStepUpGrant).not.toHaveBeenCalled();
		});

		it('still rejects a resource on an operation that is not resource-bound', async () => {
			const res = await app.request('/auth/mfa/step-up', {
				method: 'POST',
				headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: 'passkey',
					credential: { id: 'credential-1' },
					operation: 'add_factor',
					resource: { deviceIds: ['00000000-0000-4000-8000-000000000010'], reason: 'scheduled patching', durationHours: 4 },
				}),
			});
			expect(res.status).toBe(400);
			expect(mintStepUpGrant).not.toHaveBeenCalled();
		});
```

- [ ] **Step 3: Write the failing schema test — append to `apps/api/src/routes/auth/schemas.test.ts` inside `describe('mfaStepUpSchema operation field', …)` (`:62`)**

```ts
  it('accepts device_maintenance with a maintenance resource binding', () => {
    const parsed = mfaStepUpSchema.parse({
      method: 'totp',
      code: '123456',
      operation: 'device_maintenance',
      resource: { deviceIds: ['00000000-0000-4000-8000-000000000010'], reason: 'scheduled patching', durationHours: 4 },
    });
    expect(parsed.operation).toBe('device_maintenance');
    expect(parsed.resource).toMatchObject({ durationHours: 4, reason: 'scheduled patching' });
  });

  it('rejects a maintenance resource with a duration above the shared cap', () => {
    expect(() =>
      mfaStepUpSchema.parse({
        method: 'totp',
        code: '123456',
        operation: 'device_maintenance',
        resource: { deviceIds: ['00000000-0000-4000-8000-000000000010'], reason: 'scheduled patching', durationHours: 169 },
      })
    ).toThrow();
  });
```
(The existing `enroll_first_factor` rejection test must stay green — `device_maintenance` is added to the `Exclude<StepUpOperation, 'enroll_first_factor'>`-typed list, so that exclusion is unchanged.)

- [ ] **Step 4: Run all three and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run \
  src/services/mfaStepUpGrant.test.ts \
  src/routes/auth/schemas.test.ts \
  src/routes/auth.test.ts 2>&1 | tee "$SP/rmm-qa-176-red/T12-T13-stepup.txt" | tail -40
```
Expected: `maintenanceResourceDigest is not a function` / import error in the grant suite; `Invalid option: expected one of "add_factor"|"register_approver_device"|"agent_rollback"` in the schema suite; 400s where 200 is expected in the route suite.

- [ ] **Step 5: Implement the grant-service half — `apps/api/src/services/mfaStepUpGrant.ts`**

Extend the operation union at `:34-38`:
```ts
export type StepUpOperation =
  | 'add_factor'
  | 'register_approver_device'
  | 'agent_rollback'
  | 'enroll_first_factor'
  // RMM-QA-176: entering or EXTENDING device maintenance mode. Bound by
  // resourceDigest to the exact { deviceIds, reason, durationHours } the
  // technician was shown, so a grant can never be replayed against a
  // different device set or a longer window.
  | 'device_maintenance';
```

Add after `rollbackResourceDigest` (`:78`):
```ts
/**
 * Shared maxima for the device-maintenance operation. Single owner on purpose:
 * the step-up mint schema (routes/auth/schemas.ts), the device route schemas
 * (routes/devices/schemas.ts) and the bulk route all bound the SAME numbers,
 * and a drift between the schema that accepts a value and the digest that
 * binds it would be a silent authorization hole.
 */
export const MAINTENANCE_MAX_DURATION_HOURS = 168;
export const MAINTENANCE_MAX_BULK_DEVICES = 500;

/**
 * Canonical digest for a device-maintenance grant.
 *
 * Canonicalization is part of the security contract, not a convenience: the
 * mint route and the maintenance routes must produce byte-identical input for
 * the same operator intent, so `deviceIds` is deduplicated and sorted and
 * `reason` is trimmed here — in ONE function both callers use — rather than at
 * each call site. Keys are emitted in a fixed alphabetical order because
 * JSON.stringify preserves insertion order, which would otherwise let two
 * equivalent objects hash differently.
 */
export function maintenanceResourceDigest(input: {
  deviceIds: string[];
  reason: string;
  durationHours: number;
}): `sha256:${string}` {
  const canonical = JSON.stringify({
    deviceIds: [...new Set(input.deviceIds)].sort(),
    durationHours: input.durationHours,
    reason: input.reason.trim(),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
```

- [ ] **Step 6: Implement the schema half — `apps/api/src/routes/auth/schemas.ts:147-179`**

Add to the imports at the top of the file:
```ts
import { MAINTENANCE_MAX_BULK_DEVICES, MAINTENANCE_MAX_DURATION_HOURS } from '../../services/mfaStepUpGrant';
```
Replace the operations list and resource declarations:
```ts
const STEP_UP_OPERATIONS = [
  'add_factor',
  'register_approver_device',
  'agent_rollback',
  'device_maintenance',
] as const satisfies readonly Exclude<StepUpOperation, 'enroll_first_factor'>[];
const stepUpOperation = z
  .enum(STEP_UP_OPERATIONS)
  .default('add_factor');
export const rollbackStepUpResource = z.object({
  deviceId: z.string().uuid(),
  currentVersion: z.string().min(1).max(100),
  targetVersion: z.string().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
});
// RMM-QA-176 D11: the maintenance binding. Mirrors maintenanceModeSchema /
// bulkMaintenanceSchema (routes/devices/schemas.ts) exactly — a value the
// device route would accept but this schema would not (or vice versa) is a
// grant a technician can mint and never spend, or spend for more than they
// proved. Both sides import the maxima from services/mfaStepUpGrant.ts.
export const maintenanceStepUpResource = z.object({
  deviceIds: z.array(z.string().uuid()).min(1).max(MAINTENANCE_MAX_BULK_DEVICES),
  reason: z.string().trim().min(3).max(500),
  durationHours: z.number().int().min(1).max(MAINTENANCE_MAX_DURATION_HOURS),
});
// Coarse pre-filter only. The AUTHORITY on "does this resource match this
// operation" is RESOURCE_BOUND_OPERATIONS in routes/auth/mfa.ts, which
// re-parses under the operation's own schema — a union member alone would
// happily accept a rollback-shaped body under operation:'device_maintenance'.
const stepUpResource = z.union([rollbackStepUpResource, maintenanceStepUpResource]);
```
Then in each of the three `mfaStepUpSchema` branches replace `resource: rollbackStepUpResource.optional(),` with `resource: stepUpResource.optional(),`.

- [ ] **Step 7: Implement the mint-route half — `apps/api/src/routes/auth/mfa.ts`**

Add to the file's imports: `maintenanceResourceDigest` from `'../../services/mfaStepUpGrant'`, and `maintenanceStepUpResource, rollbackStepUpResource` from `'./schemas'`.

Above the route handler (module scope), add:
```ts
/**
 * Operations whose grant MUST carry a resource binding, and the schema that
 * binding must satisfy. An operation in this map with a missing or wrongly
 * shaped resource is a 400 BEFORE any factor is verified; an operation NOT in
 * this map must carry no resource at all. Replaces the pair of agent_rollback
 * `if`s so adding a bound operation is a map entry, not a third branch that
 * can be forgotten (RMM-QA-176 D11).
 */
const RESOURCE_BOUND_OPERATIONS = {
  agent_rollback: rollbackStepUpResource,
  device_maintenance: maintenanceStepUpResource,
} as const;
```

Replace lines `:1101-1105`:
```ts
  const resourceSchema = RESOURCE_BOUND_OPERATIONS[body.operation as keyof typeof RESOURCE_BOUND_OPERATIONS];
  let boundResource: z.infer<typeof rollbackStepUpResource> | z.infer<typeof maintenanceStepUpResource> | undefined;
  if (resourceSchema) {
    const parsedResource = resourceSchema.safeParse(body.resource);
    if (!parsedResource.success) {
      return c.json({ error: `A valid ${body.operation} resource binding is required` }, 400);
    }
    boundResource = parsedResource.data;
  } else if (body.resource) {
    return c.json({ error: 'Resource binding is only valid for resource-bound operations' }, 400);
  }
```
and replace the `resourceDigest:` expression in the `mintStepUpGrant({…})` call (`:1181-1183`):
```ts
    resourceDigest:
      body.operation === 'agent_rollback'
        ? rollbackResourceDigest(boundResource as z.infer<typeof rollbackStepUpResource>)
        : body.operation === 'device_maintenance'
          ? maintenanceResourceDigest(boundResource as z.infer<typeof maintenanceStepUpResource>)
          : '',
```
(`z` is already imported in this file; if not, add `import { z } from 'zod';`.)

- [ ] **Step 8: GREEN + typecheck**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/mfaStepUpGrant.test.ts \
  src/routes/auth/schemas.test.ts \
  src/routes/auth.test.ts 2>&1 | tail -20
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass — including the pre-existing `agent_rollback` mint cases at `:3676` and `:3697` and the `enroll_first_factor` rejection, which prove the generalization did not regress the existing binding.

- [ ] **Step 9: Mutation controls**

  1. In `maintenanceResourceDigest`, delete `.sort()`. Expected: "is insensitive to deviceIds order" fails. Revert `git checkout -- apps/api/src/services/mfaStepUpGrant.ts`; re-run green.
  2. In `maintenanceResourceDigest`, delete `[...new Set(...)]`. Expected: "is insensitive to duplicate deviceIds" fails. Revert; re-run green.
  3. In `maintenanceResourceDigest`, replace `input.reason.trim()` with `input.reason`. Expected: "trims reason" fails. Revert; re-run green.
  4. In `mfa.ts`, replace the `safeParse` check with a bare `if (!body.resource)`. Expected: "rejects device_maintenance carrying a ROLLBACK-shaped resource" fails (it would mint). Revert `git checkout -- apps/api/src/routes/auth/mfa.ts`; re-run green.

  Record all four mutations and their observed failure lines.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/mfaStepUpGrant.ts apps/api/src/services/mfaStepUpGrant.test.ts \
        apps/api/src/routes/auth/schemas.ts apps/api/src/routes/auth/schemas.test.ts \
        apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(auth): device_maintenance step-up operation with a canonical resource digest (RMM-QA-176 D11)

StepUpOperation gains 'device_maintenance'; maintenanceResourceDigest sorts and
dedupes deviceIds and trims reason in ONE function both the mint route and the
maintenance routes call, so the two can never disagree on what a grant
authorizes. MAINTENANCE_MAX_DURATION_HOURS / MAINTENANCE_MAX_BULK_DEVICES are
exported from the grant service as the single owner of both bounds.

/auth/mfa/step-up replaces its two agent_rollback ifs with
RESOURCE_BOUND_OPERATIONS: a bound operation must carry a resource that parses
under ITS schema (checked before any factor verification), an unbound one must
carry none. Existing agent_rollback and enroll_first_factor behaviour unchanged
and still asserted.

RED (before): <paste from T12-T13-stepup.txt>
Mutation control: <paste the four observed failures from Step 9>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 5: D5 — the migration, the Drizzle fields, and the tenant-export registration

This is the only migration in the plan. It brings the private per-worktree Postgres stack up; **leave it up** — Tasks 9 and 14 reuse it, and Task 14 tears it down.

**Files:**
- Create: `apps/api/migrations/2026-10-01-100001-device-manual-maintenance-lease.sql`
- Modify: `apps/api/src/db/schema/devices.ts:85` (insert four fields after `isEphemeral`)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:185` (`devices.included`)
- Create: `apps/api/src/__tests__/integration/deviceMaintenanceLease.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 6, 7, 8, 9, 12): `devices.maintenanceStartedAt: Date | null`, `devices.maintenanceUntil: Date | null`, `devices.maintenanceReason: string | null`, `devices.maintenanceStartedBy: string | null` on the Drizzle table; DB columns `maintenance_started_at`, `maintenance_until` (both `timestamptz`), `maintenance_reason` (`varchar(500)`), `maintenance_started_by` (`uuid` → `users(id)` `ON DELETE SET NULL`); CHECK constraint `devices_maintenance_lease_chk`.

- [ ] **Step 1: Re-verify the ceiling, then bring the private stack up**

```bash
ls apps/api/migrations | sort | tail -3
pnpm test-stack up
```
Expected: the ceiling is still `2026-10-01-100000-script-children-rls.sql` (if not, rename the file below to sort after the real max and note the change in the commit message); `test-stack up` reports a running Postgres + Redis and writes a worktree-local `.env.test`. **Do NOT run `pnpm --filter @breeze/api test:docker:up`.**

- [ ] **Step 2: Write the failing integration test `apps/api/src/__tests__/integration/deviceMaintenanceLease.integration.test.ts`**

Open an existing file in `apps/api/src/__tests__/integration/` first and copy its setup import and fixture/teardown conventions verbatim (`./setup`, the org/site/device fixture helpers, the `breeze_app` context helper). Then:

```ts
import { describe, expect, it } from 'vitest';
// NOTE: match the setup import and fixture helpers used by the neighbouring
// integration files in this directory — do not invent a new harness.
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

const LEASE_COLUMNS = [
  'maintenance_started_at',
  'maintenance_until',
  'maintenance_reason',
  'maintenance_started_by',
] as const;

describe('devices manual maintenance lease columns (RMM-QA-176 D5)', () => {
  it('exposes all four lease columns with the intended types and nullability', async () => {
    const rows = await rawSql(`
      SELECT column_name, data_type, is_nullable, character_maximum_length
      FROM information_schema.columns
      WHERE table_name = 'devices' AND column_name = ANY($1::text[])
      ORDER BY column_name
    `, [LEASE_COLUMNS]);
    expect(rows.map((r: any) => r.column_name).sort()).toEqual([...LEASE_COLUMNS].sort());
    const byName = Object.fromEntries(rows.map((r: any) => [r.column_name, r]));
    expect(byName.maintenance_started_at.data_type).toBe('timestamp with time zone');
    expect(byName.maintenance_until.data_type).toBe('timestamp with time zone');
    expect(byName.maintenance_reason.character_maximum_length).toBe(500);
    expect(byName.maintenance_started_by.data_type).toBe('uuid');
    for (const c of LEASE_COLUMNS) expect(byName[c].is_nullable).toBe('YES');
  });

  it('rejects a partial lease: until without reason/started_at', async () => {
    const device = await createFixtureDevice();
    await expect(rawSql(
      `UPDATE devices SET maintenance_until = now() + interval '1 hour' WHERE id = $1`,
      [device.id],
    )).rejects.toThrow(/devices_maintenance_lease_chk/);
  });

  it('accepts an all-null lease and a fully populated lease', async () => {
    const device = await createFixtureDevice();
    await rawSql(
      `UPDATE devices SET maintenance_started_at = now(), maintenance_until = now() + interval '1 hour',
              maintenance_reason = 'scheduled patching', maintenance_started_by = $2 WHERE id = $1`,
      [device.id, device.enrolledBy ?? null],
    );
    await rawSql(
      `UPDATE devices SET maintenance_started_at = NULL, maintenance_until = NULL,
              maintenance_reason = NULL, maintenance_started_by = NULL WHERE id = $1`,
      [device.id],
    );
  });

  it('nulls maintenance_started_by when the actor user row is deleted (ON DELETE SET NULL)', async () => {
    const { device, userId } = await createFixtureDeviceWithLeaseActor();
    await rawSql(`DELETE FROM users WHERE id = $1`, [userId]);
    const [row] = await rawSql(
      `SELECT maintenance_started_by, maintenance_until FROM devices WHERE id = $1`, [device.id]);
    expect(row.maintenance_started_by).toBeNull();
    // The CHECK deliberately permits a null actor beside a live window: user
    // erasure must not be blocked by, and must not silently clear, the lease.
    expect(row.maintenance_until).not.toBeNull();
  });

  it('re-applying the migration is a no-op (idempotency)', async () => {
    const sqlText = await readMigration('2026-10-01-100001-device-manual-maintenance-lease.sql');
    await rawSql(sqlText);
    await rawSql(sqlText);
    const [{ count }] = await rawSql(
      `SELECT count(*)::int AS count FROM pg_constraint WHERE conname = 'devices_maintenance_lease_chk'`);
    expect(count).toBe(1);
  });

  it('registers every lease column in the devices tenant-export policy', () => {
    // Guard for the "unclassified" failure in
    // __tests__/integration/tenant-export-policy.integration.test.ts: a column
    // added to an org-cascade table without a decision fails that suite, and
    // this local assertion says WHY when it does.
    for (const column of LEASE_COLUMNS) {
      expect(CORE_TENANT_EXPORT_POLICY.devices.columns[column]?.decision).toBe('include');
    }
  });
});
```
Replace `rawSql`, `createFixtureDevice`, `createFixtureDeviceWithLeaseActor` and `readMigration` with the neighbouring files' real helpers; if none exists for a given need, write the smallest local helper in this file.

- [ ] **Step 3: Run it and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceMaintenanceLease.integration.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T19-lease-columns.txt" | tail -40
```
Expected: FAIL — the columns query returns `[]`; the CHECK test rejects with `column "maintenance_until" of relation "devices" does not exist` rather than the constraint name; the export-policy assertion reads `undefined`.

- [ ] **Step 4: Write the migration `apps/api/migrations/2026-10-01-100001-device-manual-maintenance-lease.sql`**

```sql
-- 2026-10-01-100001: persist the MANUAL device maintenance lease (RMM-QA-176).
--
-- POST /devices/:id/maintenance echoed `durationHours` into an audit detail and
-- threw it away, so "extend the window" was not a distinguishable operation and
-- there was no durable record of who suppressed monitoring on a device, why, or
-- until when. These four columns are that record, written in the SAME
-- transaction as the status change, which is what makes the audit trail's
-- actor/reason/window claim backed rather than best-effort.
--
-- Deliberately NOT indexed: nothing queries maintenance_until yet. RMM-QA-217
-- ("the heartbeat preserves the lease and the suppression consumers honour it")
-- is the ticket that reads this column across the fleet and adds the index it
-- needs. The shape here is chosen so 217 needs no second migration:
-- start / until / reason / actor is exactly its contract.
--
-- started_by is ON DELETE SET NULL, not RESTRICT: erasing a user must never be
-- blocked by a device that happens to be in maintenance. The CHECK below
-- therefore permits a null actor beside a live window, while still forbidding a
-- half-written lease (an `until` with no reason, or a reason with no window).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_started_at timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_until timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_reason varchar(500);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS maintenance_started_by uuid
  REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_maintenance_lease_chk'
  ) THEN
    ALTER TABLE devices ADD CONSTRAINT devices_maintenance_lease_chk CHECK (
      (maintenance_until IS NULL AND maintenance_started_at IS NULL AND maintenance_reason IS NULL)
      OR (maintenance_until IS NOT NULL AND maintenance_started_at IS NOT NULL AND maintenance_reason IS NOT NULL)
    );
  END IF;
END $$;
```
No inner `BEGIN`/`COMMIT` — the runner wraps each file.

- [ ] **Step 5: Add the Drizzle fields — `apps/api/src/db/schema/devices.ts`**

Insert immediately after `isEphemeral: boolean('is_ephemeral').notNull().default(false),` (`:85`):
```ts
  // RMM-QA-176: manual maintenance lease. `maintenance_until > now()` — not
  // `status` — is the truth of "a technician put this device into maintenance":
  // the heartbeat overwrites status to 'online' on every beat, so a status read
  // cannot distinguish entry from extension. started_at / started_by are
  // IMMUTABLE across extensions (the original actor stays on the row; each
  // extension's actor is on its audit event). See services/deviceMaintenanceLease.ts.
  maintenanceStartedAt: timestamp('maintenance_started_at', { withTimezone: true }),
  maintenanceUntil: timestamp('maintenance_until', { withTimezone: true }),
  maintenanceReason: varchar('maintenance_reason', { length: 500 }),
  maintenanceStartedBy: uuid('maintenance_started_by').references(() => users.id, { onDelete: 'set null' }),
```
(`users` is already imported at `:3`; `timestamp`, `varchar`, `uuid` are already imported at `:1`.)

- [ ] **Step 6: Register the columns in the tenant export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts:185`, inside the `"devices"` entry, append the four names to the END of the `"included"` array (after `"partner_export_updated_at"`):
```
,"maintenance_started_at","maintenance_until","maintenance_reason","maintenance_started_by"
```
They are customer operational data, not credentials, and none of the names contains a `SUSPICIOUS_NAME_PARTS` substring (`services/tenantExportPolicy.ts:35-55`), so plain `included` — not `reviewedIncluded` — is the right decision.

- [ ] **Step 7: Migration gates + drift check**

```bash
git add apps/api/migrations/2026-10-01-100001-device-manual-maintenance-lease.sql
bash scripts/check-migration-naming.sh --staged
pnpm --filter @breeze/api check:migrations
pnpm --filter @breeze/api db:check-drift
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts 2>&1 | tail -10
```
Expected: naming gate reports no violations (in particular rule 3, strict sort-after-max, passes); `check:migrations` exits 0; `db:check-drift` reports no drift between the Drizzle schema and the migrated database; `autoMigrate.test.ts` green.

- [ ] **Step 8: GREEN — the new integration suite plus the export/erasure/RLS guards**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceMaintenanceLease.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts 2>&1 | tail -25
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass. `rls-coverage` is unchanged because no new table was added.

- [ ] **Step 9: Mutation controls**

  1. Remove `"maintenance_reason"` from the `devices.included` array in `tenantExportPolicyRegistry.ts`. Re-run `tenant-export-policy.integration.test.ts`. Expected: FAIL with `devices.maintenance_reason: unclassified` — the executed proof that registration is load-bearing (F12). Revert `git checkout -- apps/api/src/services/tenantExportPolicyRegistry.ts`; re-run green.
  2. In a **scratch copy** of the migration (never edit the staged file after it is committed; at this point it is still uncommitted, so edit and revert is safe), weaken the CHECK to `CHECK (true)`, drop and re-create the constraint against the live DB, and re-run the "rejects a partial lease" test. Expected: FAIL (the partial UPDATE succeeds). Revert the file with `git checkout -- apps/api/migrations/2026-10-01-100001-device-manual-maintenance-lease.sql`, drop the weakened constraint, re-apply the real migration, re-run green.

  Record both mutations and their observed failures.

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/2026-10-01-100001-device-manual-maintenance-lease.sql \
        apps/api/src/db/schema/devices.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts \
        apps/api/src/__tests__/integration/deviceMaintenanceLease.integration.test.ts
bash scripts/check-migration-naming.sh --staged
git commit -m "feat(db): persist the manual device maintenance lease on devices (RMM-QA-176 D5)

Four nullable columns (maintenance_started_at, maintenance_until,
maintenance_reason, maintenance_started_by -> users ON DELETE SET NULL) plus an
idempotent CHECK forbidding a half-written lease. Migration
2026-10-01-100001-device-manual-maintenance-lease.sql sorts strictly after the
verified ceiling 2026-10-01-100000-script-children-rls.sql; naming gate and
check:migrations pass on the staged commit. Drizzle fields added and
db:check-drift is clean. All four columns registered in the devices
tenant-export policy — devices is an org-cascade table whose policy enumerates
every column, so an unregistered one fails tenant-export-policy with
'unclassified' (proved by mutation).

No index and no consumer: nothing reads maintenance_until yet. That is
RMM-QA-217, which inherits this shape and needs no second migration.

RED (before): <paste from T19-lease-columns.txt>
Mutation control: <paste the two observed failures from Step 9>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 6: D6 — `services/deviceMaintenanceLease.ts`, the transactional row write

Pure DB logic: takes the caller's `tx`, locks the row, re-checks state under the lock, issues exactly one `UPDATE`. **No Redis, no auth, no HTTP** — the route owns grant handling and authorization, and keeping them out of here is what lets the bulk route reuse the same helper under one transaction.

**Files:**
- Create: `apps/api/src/services/deviceMaintenanceLease.ts`
- Create: `apps/api/src/services/deviceMaintenanceLease.test.ts`

**Interfaces:**
- Consumes: `resolveLivenessStatus` from `./deviceLiveness` (Task 3); `devices` from `../db/schema` (Task 5 fields).
- Produces (used by Tasks 7, 8):
  - `export const MAINTENANCE_ENTRY_ALLOWED_STATUSES = ['online', 'offline', 'maintenance'] as const`
  - `export type MaintenanceLeaseErrorCode = 'not_found' | 'decommissioned' | 'state_conflict'`
  - `export class MaintenanceLeaseError extends Error { readonly code: MaintenanceLeaseErrorCode; readonly status: number; readonly deviceStatus?: string }`
  - `export interface MaintenanceEntryResult { action: 'enable' | 'extend'; previousUntil: Date | null; previousReason: string | null; until: Date; startedAt: Date; device: Record<string, unknown> }`
  - `export async function applyMaintenanceEntry(tx: MaintenanceTx, input: { deviceId: string; reason: string; durationHours: number; actorUserId: string; now: Date }): Promise<MaintenanceEntryResult>`
  - `export interface MaintenanceClearResult { changed: boolean; previousUntil: Date | null; previousReason: string | null; resolvedStatus: string; device: Record<string, unknown> }`
  - `export async function clearMaintenanceLease(tx: MaintenanceTx, input: { deviceId: string; now: Date }): Promise<MaintenanceClearResult>`

- [ ] **Step 1: Write the failing unit test `apps/api/src/services/deviceMaintenanceLease.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return { ...actual };
});

import {
  MAINTENANCE_ENTRY_ALLOWED_STATUSES,
  MaintenanceLeaseError,
  applyMaintenanceEntry,
  clearMaintenanceLease,
} from './deviceMaintenanceLease';

const NOW = new Date('2026-09-02T12:00:00.000Z');
const DEVICE = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ACTOR = '00000000-0000-4000-8000-0000000000bb';
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

/**
 * Stub tx that records the ORDER of operations, so "locked SELECT first" and
 * "exactly one UPDATE" are assertions, not hopes.
 */
function makeTx(row: Record<string, unknown> | null) {
  const calls: string[] = [];
  const captured: Array<Record<string, unknown>> = [];
  const forUpdate = vi.fn(async () => { calls.push('select-for-update'); return row ? [row] : []; });
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => ({ for: forUpdate })) })) })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      captured.push(values);
      calls.push('update');
      return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...row, ...values, id: DEVICE }]) })) };
    }),
  }));
  return { tx: { select, update } as any, calls, captured, forUpdate, update };
}

const baseRow = (over: Record<string, unknown> = {}) => ({
  id: DEVICE,
  orgId: 'org-1',
  siteId: 'site-1',
  hostname: 'host-a',
  status: 'online',
  lastSeenAt: minutesAgo(1),
  maintenanceStartedAt: null,
  maintenanceUntil: null,
  maintenanceReason: null,
  maintenanceStartedBy: null,
  ...over,
});

describe('applyMaintenanceEntry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('locks the device row BEFORE writing and issues exactly one UPDATE', async () => {
    const { tx, calls, update } = makeTx(baseRow());
    await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(calls).toEqual(['select-for-update', 'update']);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('enters maintenance when there is no lease: sets started_at/by, until, reason and status', async () => {
    const { tx, captured } = makeTx(baseRow());
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('enable');
    expect(result.previousUntil).toBeNull();
    expect(result.until).toEqual(hoursFromNow(2));
    expect(captured[0]).toMatchObject({
      status: 'maintenance',
      maintenanceStartedAt: NOW,
      maintenanceStartedBy: ACTOR,
      maintenanceUntil: hoursFromNow(2),
      maintenanceReason: 'scheduled patching',
    });
  });

  it('treats an EXPIRED lease as a fresh entry and re-stamps the actor', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance',
      maintenanceUntil: new Date(NOW.getTime() - 3_600_000),
      maintenanceStartedAt: minutesAgo(600),
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('enable');
    expect(captured[0]).toMatchObject({ maintenanceStartedBy: ACTOR, maintenanceStartedAt: NOW });
  });

  it('EXTENDS an active lease from NOW, not from the old until, and never compounds', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance',
      maintenanceUntil: hoursFromNow(1),
      maintenanceStartedAt: minutesAgo(60),
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'still patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('extend');
    expect(result.previousUntil).toEqual(hoursFromNow(1));
    expect(result.previousReason).toBe('old reason');
    // now + 2h, NOT (now + 1h) + 2h — a state-independent outcome is what
    // closes the grant TOCTOU (D6): the grant means one thing whatever the
    // row's prior state.
    expect(result.until).toEqual(hoursFromNow(2));
    expect(captured[0]).toMatchObject({ maintenanceUntil: hoursFromNow(2), maintenanceReason: 'still patching' });
  });

  it('keeps started_at and started_by IMMUTABLE across an extension', async () => {
    const originalStart = minutesAgo(60);
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance',
      maintenanceUntil: hoursFromNow(1),
      maintenanceStartedAt: originalStart,
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'still patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.startedAt).toEqual(originalStart);
    expect(captured[0]).not.toHaveProperty('maintenanceStartedAt');
    expect(captured[0]).not.toHaveProperty('maintenanceStartedBy');
  });

  it('extends a device whose heartbeat already overwrote status to online (lease, not status, decides)', async () => {
    const { tx } = makeTx(baseRow({
      status: 'online',
      maintenanceUntil: hoursFromNow(1),
      maintenanceStartedAt: minutesAgo(60),
      maintenanceReason: 'old reason',
      maintenanceStartedBy: OTHER_ACTOR,
    }));
    const result = await applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'still patching', durationHours: 2, actorUserId: ACTOR, now: NOW });
    expect(result.action).toBe('extend');
  });

  it('throws not_found and writes nothing when the locked select returns no row', async () => {
    const { tx, update } = makeTx(null);
    await expect(applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(update).not.toHaveBeenCalled();
  });

  it('throws decommissioned (400) and writes nothing', async () => {
    const { tx, update } = makeTx(baseRow({ status: 'decommissioned' }));
    await expect(applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW }))
      .rejects.toMatchObject({ code: 'decommissioned', status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it.each(['quarantined', 'pending', 'updating'])(
    'throws state_conflict (409) for status %s and writes nothing — enter-then-exit must not launder it',
    async (status) => {
      const { tx, update } = makeTx(baseRow({ status }));
      await expect(applyMaintenanceEntry(tx, { deviceId: DEVICE, reason: 'scheduled patching', durationHours: 2, actorUserId: ACTOR, now: NOW }))
        .rejects.toMatchObject({ code: 'state_conflict', status: 409, deviceStatus: status });
      expect(update).not.toHaveBeenCalled();
    });

  it('exposes exactly the three allowed entry statuses', () => {
    expect([...MAINTENANCE_ENTRY_ALLOWED_STATUSES]).toEqual(['online', 'offline', 'maintenance']);
  });
});

describe('clearMaintenanceLease', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves status from FRESH evidence: recently seen -> online', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance', lastSeenAt: minutesAgo(1),
      maintenanceUntil: hoursFromNow(1), maintenanceStartedAt: minutesAgo(60), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(true);
    expect(result.resolvedStatus).toBe('online');
    expect(captured[0]).toMatchObject({
      status: 'online', maintenanceUntil: null, maintenanceReason: null,
      maintenanceStartedAt: null, maintenanceStartedBy: null,
    });
  });

  it('resolves status from FRESH evidence: not seen for 10 minutes -> offline (never resurrects a stale online)', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance', lastSeenAt: minutesAgo(10),
      maintenanceUntil: hoursFromNow(1), maintenanceStartedAt: minutesAgo(60), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.resolvedStatus).toBe('offline');
    expect(captured[0]).toMatchObject({ status: 'offline' });
  });

  it('leaves a non-maintenance status untouched while still clearing the lease', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'updating', lastSeenAt: minutesAgo(1),
      maintenanceUntil: hoursFromNow(1), maintenanceStartedAt: minutesAgo(60), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(true);
    expect(result.resolvedStatus).toBe('updating');
    expect(captured[0]).not.toHaveProperty('status');
    expect(captured[0]).toMatchObject({ maintenanceUntil: null });
  });

  it('is a no-op with changed:false when there is no lease and status is not maintenance', async () => {
    const { tx, update } = makeTx(baseRow({ status: 'online' }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('still exits a device stuck at status maintenance with an expired lease', async () => {
    const { tx, captured } = makeTx(baseRow({
      status: 'maintenance', lastSeenAt: minutesAgo(1),
      maintenanceUntil: new Date(NOW.getTime() - 3_600_000), maintenanceStartedAt: minutesAgo(600), maintenanceReason: 'r', maintenanceStartedBy: ACTOR,
    }));
    const result = await clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW });
    expect(result.changed).toBe(true);
    expect(captured[0]).toMatchObject({ status: 'online' });
  });

  it('throws not_found and writes nothing when the device is gone', async () => {
    const { tx, update } = makeTx(null);
    await expect(clearMaintenanceLease(tx, { deviceId: DEVICE, now: NOW })).rejects.toMatchObject({ code: 'not_found' });
    expect(update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run src/services/deviceMaintenanceLease.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T14-lease-service.txt" | tail -20
```
Expected: FAIL — `Failed to resolve import "./deviceMaintenanceLease"`.

- [ ] **Step 3: Create `apps/api/src/services/deviceMaintenanceLease.ts`**

```ts
import { eq } from 'drizzle-orm';
import { devices } from '../db/schema';
import { resolveLivenessStatus } from './deviceLiveness';

/**
 * Transactional writer for the manual maintenance lease (RMM-QA-176 D3, D6).
 *
 * Deliberately knows nothing about auth, Redis or HTTP: the route validates and
 * consumes the step-up grant and maps errors to status codes, and the BULK route
 * reuses these same two functions inside ONE transaction over many devices. Both
 * take the caller's `tx`, take a `FOR UPDATE` lock, RE-CHECK state under the
 * lock (the check the route did before the transaction is advisory — another
 * actor can change the row in between), and issue exactly one UPDATE.
 */

/**
 * Statuses a device may be in to ENTER or EXTEND maintenance. `decommissioned`
 * keeps its own 400. `quarantined`, `pending` and `updating` are refused
 * because enter-then-exit would launder them: exit derives status from
 * liveness, so a quarantined device could come back as plain 'online'.
 * ONE list rather than separate entry/extension lists, because entry-vs-
 * extension is decided by the LEASE, not by status — a device whose heartbeat
 * already overwrote 'maintenance' with 'online' must still be extendable.
 */
export const MAINTENANCE_ENTRY_ALLOWED_STATUSES = ['online', 'offline', 'maintenance'] as const;

export type MaintenanceLeaseErrorCode = 'not_found' | 'decommissioned' | 'state_conflict';

export class MaintenanceLeaseError extends Error {
  constructor(
    readonly code: MaintenanceLeaseErrorCode,
    readonly status: number,
    message: string,
    readonly deviceStatus?: string,
  ) {
    super(message);
    this.name = 'MaintenanceLeaseError';
  }
}

type DeviceRow = typeof devices.$inferSelect;
/** Structural view of a Drizzle transaction — keeps this module free of the tx type's import weight. */
export type MaintenanceTx = {
  select: (...args: any[]) => any;
  update: (...args: any[]) => any;
};

export interface MaintenanceEntryResult {
  action: 'enable' | 'extend';
  previousUntil: Date | null;
  previousReason: string | null;
  until: Date;
  startedAt: Date;
  device: DeviceRow;
}

export interface MaintenanceClearResult {
  changed: boolean;
  previousUntil: Date | null;
  previousReason: string | null;
  resolvedStatus: string;
  device: DeviceRow;
}

async function lockDevice(tx: MaintenanceTx, deviceId: string): Promise<DeviceRow> {
  const rows = await tx.select().from(devices).where(eq(devices.id, deviceId)).limit(1).for('update');
  const row = rows[0] as DeviceRow | undefined;
  if (!row) {
    throw new MaintenanceLeaseError('not_found', 404, 'Device not found');
  }
  return row;
}

const leaseIsActive = (row: Pick<DeviceRow, 'maintenanceUntil'>, now: Date): boolean =>
  row.maintenanceUntil != null && row.maintenanceUntil.getTime() > now.getTime();

export async function applyMaintenanceEntry(
  tx: MaintenanceTx,
  input: { deviceId: string; reason: string; durationHours: number; actorUserId: string; now: Date },
): Promise<MaintenanceEntryResult> {
  const row = await lockDevice(tx, input.deviceId);

  if (row.status === 'decommissioned') {
    throw new MaintenanceLeaseError(
      'decommissioned', 400, 'Cannot change maintenance mode for a decommissioned device', row.status,
    );
  }
  if (!(MAINTENANCE_ENTRY_ALLOWED_STATUSES as readonly string[]).includes(row.status)) {
    throw new MaintenanceLeaseError(
      'state_conflict', 409,
      `Cannot enter maintenance mode while the device is "${row.status}"`,
      row.status,
    );
  }

  const active = leaseIsActive(row, input.now);
  const until = new Date(input.now.getTime() + input.durationHours * 3_600_000);

  // State-INDEPENDENT outcome (D6): `until = now + durationHours` whether or not
  // a lease is already active, so "extend by N" means "N more hours from now"
  // and a grant minted for {devices, reason, N} always produces exactly that.
  // Compounding would make the same grant mean different things depending on a
  // race, which is precisely the TOCTOU this shape removes.
  const values: Partial<DeviceRow> = {
    maintenanceUntil: until,
    maintenanceReason: input.reason,
    status: 'maintenance',
    updatedAt: new Date(),
  };
  // started_at / started_by are IMMUTABLE across extensions — the ORIGINAL
  // actor stays on the row; each extension's actor is on its audit event.
  if (!active) {
    values.maintenanceStartedAt = input.now;
    values.maintenanceStartedBy = input.actorUserId;
  }

  const [updated] = await tx.update(devices).set(values).where(eq(devices.id, input.deviceId)).returning();

  return {
    action: active ? 'extend' : 'enable',
    previousUntil: active ? row.maintenanceUntil : null,
    previousReason: active ? row.maintenanceReason : null,
    until,
    startedAt: active ? (row.maintenanceStartedAt as Date) : input.now,
    device: updated as DeviceRow,
  };
}

export async function clearMaintenanceLease(
  tx: MaintenanceTx,
  input: { deviceId: string; now: Date },
): Promise<MaintenanceClearResult> {
  const row = await lockDevice(tx, input.deviceId);

  const hadLease = row.maintenanceUntil != null || row.maintenanceStartedAt != null || row.maintenanceReason != null;
  const wasLabelledMaintenance = row.status === 'maintenance';
  if (!hadLease && !wasLabelledMaintenance) {
    // Nothing to end. Returning changed:false (and writing NO audit row) is the
    // point: an audit event must not claim a transition that did not happen.
    return { changed: false, previousUntil: null, previousReason: null, resolvedStatus: row.status, device: row };
  }

  // Status comes from FRESH evidence, never from a stored pre-maintenance
  // value: a device that went offline during the window must not be resurrected
  // as 'online' until its next heartbeat. A status that is NOT 'maintenance'
  // (the heartbeat already moved it, or it is 'updating') is left alone.
  const resolvedStatus = wasLabelledMaintenance
    ? resolveLivenessStatus(row.lastSeenAt, input.now)
    : row.status;

  const values: Partial<DeviceRow> = {
    maintenanceUntil: null,
    maintenanceReason: null,
    maintenanceStartedAt: null,
    maintenanceStartedBy: null,
    updatedAt: new Date(),
  };
  if (wasLabelledMaintenance) {
    values.status = resolvedStatus as DeviceRow['status'];
  }

  const [updated] = await tx.update(devices).set(values).where(eq(devices.id, input.deviceId)).returning();

  return {
    changed: true,
    previousUntil: row.maintenanceUntil,
    previousReason: row.maintenanceReason,
    resolvedStatus,
    device: updated as DeviceRow,
  };
}
```

- [ ] **Step 4: GREEN + typecheck**

```bash
pnpm --filter @breeze/api exec vitest run src/services/deviceMaintenanceLease.test.ts 2>&1 | tail -20
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: 18 tests pass; tsc exits 0.

- [ ] **Step 5: Mutation controls**

  1. Change `until` to `new Date(Math.max(input.now.getTime(), row.maintenanceUntil?.getTime() ?? 0) + input.durationHours * 3_600_000)` (the compounding form Codex proposed). Expected: "EXTENDS an active lease from NOW" fails. Revert `git checkout -- apps/api/src/services/deviceMaintenanceLease.ts`; re-run green.
  2. Move `values.maintenanceStartedBy = input.actorUserId;` outside the `if (!active)` block. Expected: "keeps started_at and started_by IMMUTABLE" fails. Revert; re-run green.
  3. Delete the `MAINTENANCE_ENTRY_ALLOWED_STATUSES` guard block. Expected: all three `state_conflict` cases fail. Revert; re-run green.
  4. In `clearMaintenanceLease`, hard-code `const resolvedStatus = wasLabelledMaintenance ? 'online' : row.status;`. Expected: "not seen for 10 minutes -> offline" fails. Revert; re-run green.
  5. Add a second `tx.update(...)` call at the end of `applyMaintenanceEntry`. Expected: "issues exactly one UPDATE" fails. Revert; re-run green.
  6. Reorder `lockDevice` so the `.for('update')` clause is dropped (`.limit(1)` only, returning the array directly). Expected: "locks the device row BEFORE writing" still passes but the `calls` trace loses `select-for-update` → the test fails on the array equality. Revert; re-run green.

  Record all six mutations and their observed failures.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/deviceMaintenanceLease.ts apps/api/src/services/deviceMaintenanceLease.test.ts
git commit -m "feat(devices): transactional maintenance-lease writer (RMM-QA-176 D3/D6)

applyMaintenanceEntry / clearMaintenanceLease take the caller's tx, lock the
device row FOR UPDATE, re-check state under the lock and issue exactly one
UPDATE. Entry vs extension is decided by the LEASE (maintenance_until > now),
never by status, because the heartbeat overwrites status on every beat. The
outcome is STATE-INDEPENDENT — until = now + durationHours whether or not a
lease is active — which is what makes a grant minted for {devices, reason, N}
mean exactly one thing regardless of a concurrent entry. started_at/started_by
are immutable across extensions. Exit derives status from fresh liveness
evidence and is a changed:false no-op (no audit) when there is nothing to end.
Entry allowlist online|offline|maintenance keeps enter-then-exit from
laundering a quarantined device.

No auth, no Redis, no HTTP here — the route owns the grant, and the bulk route
reuses these two functions inside one transaction.

RED (before): <paste from T14-lease-service.txt: Failed to resolve import \"./deviceMaintenanceLease\">
Mutation control: <paste the six observed failures from Step 5>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 7: D1–D4, D12 — gate, persist and audit the single-device maintenance route

The core of the finding. Schemas and route land together because the discriminated union removes `durationHours` from the exit branch, which the current handler reads unconditionally.

**Three existing tests FLIP here.** They currently assert the ungated behaviour and would go red on a correct implementation; each is replaced with the *stronger* statement of the same intent, not deleted:

| Existing case | Why it flips — and why the replacement is not "make the test match the code" |
|---|---|
| `commands.test.ts:853` "enables maintenance mode for eligible devices" (body `{ enable: true, durationHours: 2 }` → 200) | The body is no longer valid (no `reason`) and 200 without a grant is the vulnerability. Replaced by T4: same happy path, now with `reason` + a valid grant, and it additionally asserts the grant was **consumed with the exact binding** and that the audit carries actor/reason/window. It proves *more* than the original, not less. |
| `commands.test.ts:884` "rejects maintenance mode changes for decommissioned devices" | Body updated to the new required shape; the 400 assertion and the `db.transaction` not-called assertion are kept and strengthened. Behaviour under test is unchanged. |
| `commands.test.ts:901` "denies maintenance changes when site scope excludes the device" | Body updated; the 403 stays and `db.update`-not-called becomes `db.transaction`-not-called. Behaviour under test is unchanged. |

**Files:**
- Modify: `apps/api/src/routes/devices/schemas.ts:185-188`
- Modify: `apps/api/src/routes/devices/commands.ts:1-15` (imports), `:363-413` (route)
- Modify: `apps/api/src/routes/devices/events.ts:346`
- Modify: `apps/api/src/routes/devices/commands.test.ts` (maintenance describe at `:852-921`)

**Interfaces:**
- Consumes: `maintenanceResourceDigest`, `MAINTENANCE_MAX_DURATION_HOURS`, `MAINTENANCE_MAX_BULK_DEVICES` (Task 4); `applyMaintenanceEntry`, `clearMaintenanceLease`, `MaintenanceLeaseError`, `MAINTENANCE_ENTRY_ALLOWED_STATUSES` (Task 6); `validateStepUpGrant`, `consumeStepUpGrant` (existing); `getUserEpochs` from `../../services/authEpochs`; `ENABLE_2FA` from `../../routes/auth/schemas`.
- Produces (used by Tasks 8, 9, 12):
  - `export const maintenanceReasonSchema`, `export const maintenanceDurationSchema`, `export const maintenanceModeSchema`, `export const bulkMaintenanceSchema` from `routes/devices/schemas.ts`
  - HTTP: `POST /devices/:id/maintenance` — entry `{ enable: true, reason, durationHours, stepUpGrant? }` → `200 { success: true, action: 'enable'|'extend', maintenance: { until, startedAt, reason }, device }`; exit `{ enable: false }` → `200 { success: true, changed: boolean, device }`; denials `403 { error: 'Interactive user session required' }`, `403 { error: 'MFA required', code: 'MFA_REQUIRED' }`, `403 { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }`, `409 { error, code: 'MAINTENANCE_STATE_CONFLICT' }`, `400`, `404`.

- [ ] **Step 1: Extend the test-double surface this task's REDs need**

In `apps/api/src/routes/devices/commands.test.ts`, add after the existing `vi.mock('../../services/clientIp', …)` block:

```ts
vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => {
  // Partial: maintenanceResourceDigest stays REAL so the binding assertion in
  // T4 compares against the production canonicalization, not a stub.
  const actual = await importOriginal<typeof import('../../services/mfaStepUpGrant')>();
  return {
    ...actual,
    validateStepUpGrant: vi.fn(async () => true),
    consumeStepUpGrant: vi.fn(async () => true),
  };
});

vi.mock('../../services/authEpochs', () => ({
  getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })),
}));
```
and to the import block after `import { dispatchWake } from '../../services/wakeOnLan';`:
```ts
import { consumeStepUpGrant, maintenanceResourceDigest, validateStepUpGrant } from '../../services/mfaStepUpGrant';
```

Add this helper just above the `describe('POST /devices/:id/maintenance', …)` block (it is also reused by Task 8):

```ts
  /**
   * tx stub for db.transaction: the lease service takes a FOR UPDATE lock, then
   * issues one UPDATE … RETURNING. `calls` gives tests the ordered trace so
   * "no write on denial" and "exactly one UPDATE" are real assertions.
   */
  function mockMaintenanceTx(row: Record<string, unknown> | null) {
    const calls: string[] = [];
    const captured: Array<Record<string, unknown>> = [];
    const txSelect = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({ for: vi.fn(async () => { calls.push('select-for-update'); return row ? [row] : []; }) })),
        })),
      })),
    }));
    const txUpdate = vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        captured.push(values);
        calls.push('update');
        return { where: vi.fn(() => ({ returning: vi.fn(async () => [{ ...row, ...values }]) })) };
      }),
    }));
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn({ select: txSelect, update: txUpdate }));
    return { calls, captured, txSelect, txUpdate };
  }
```

- [ ] **Step 2: Write the failing tests — replace the whole `describe('POST /devices/:id/maintenance', …)` block (`:852-921`)**

```ts
  describe('POST /devices/:id/maintenance', () => {
    const NOW_ISH = () => new Date();
    const deviceRow = (over: Record<string, unknown> = {}) => ({
      id: 'device-a', orgId: 'org-123', hostname: 'host-a', siteId: 'site-allowed',
      status: 'online', lastSeenAt: new Date(Date.now() - 60_000),
      maintenanceStartedAt: null, maintenanceUntil: null, maintenanceReason: null, maintenanceStartedBy: null,
      ...over,
    });
    const enterBody = (over: Record<string, unknown> = {}) => JSON.stringify({
      enable: true, reason: 'scheduled patching', durationHours: 2, stepUpGrant: '11111111-1111-4111-8111-111111111111', ...over,
    });
    const post = (body: string, headers: Record<string, string> = {}) =>
      app.request('/devices/device-a/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', ...headers },
        body,
      });

    // ---- T1: precondition. Without this every later RED could be an
    // "ENABLE_2FA is off in tests" artefact rather than a real gate.
    it('runs with ENABLE_2FA true and the REAL MFA gate (precondition for every case below)', async () => {
      const { ENABLE_2FA } = await import('../../routes/auth/schemas');
      expect(ENABLE_2FA).toBe(true);
      const { requireMfa, hasSatisfiedMfa, isInteractiveUserSession } = await import('../../middleware/auth');
      expect(vi.isMockFunction(requireMfa)).toBe(false);
      expect(hasSatisfiedMfa({ token: { mfa: false } } as never)).toBe(false);
      expect(isInteractiveUserSession({ principal: { kind: 'api_key' } } as never)).toBe(false);
    });

    // ---- T2: non-assured session denied, zero writes.
    it('denies entry from a session that has not satisfied MFA, with no state change', async () => {
      authState.mfa = false;
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    // ---- T3: grant required; missing and stale are indistinguishable.
    it('denies entry with no step-up grant, with no state change', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      const res = await post(enterBody({ stepUpGrant: undefined }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
    });

    it('denies entry with a stale or mismatched grant, indistinguishably from a missing one', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      vi.mocked(validateStepUpGrant).mockResolvedValueOnce(false);
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    // ---- T4: happy path (this REPLACES "enables maintenance mode for eligible
    // devices" and asserts strictly more: the grant binding and the audit).
    it('enters maintenance with a valid grant, consuming it with the exact binding, and audits actor/reason/window', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      const { captured, calls } = mockMaintenanceTx(deviceRow());
      const res = await post(enterBody());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, action: 'enable' });
      expect(body.maintenance).toMatchObject({ reason: 'scheduled patching' });
      expect(calls).toEqual(['select-for-update', 'update']);
      expect(captured[0]).toMatchObject({ status: 'maintenance', maintenanceReason: 'scheduled patching', maintenanceStartedBy: 'user-123' });
      expect(consumeStepUpGrant).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
        userId: 'user-123',
        operation: 'device_maintenance',
        authEpoch: 1,
        mfaEpoch: 1,
        sid: 'sid-1',
        resourceDigest: maintenanceResourceDigest({ deviceIds: ['device-a'], reason: 'scheduled patching', durationHours: 2 }),
      });
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'device.maintenance.enable',
        details: expect.objectContaining({ reason: 'scheduled patching', durationHours: 2, stepUp: 'grant' }),
      }));
    });

    // ---- T5: extension semantics.
    it('extends an ACTIVE lease from now (never compounding), keeping the original actor, and audits device.maintenance.extend', async () => {
      const originalStart = new Date(Date.now() - 3_600_000);
      const row = deviceRow({
        status: 'maintenance', maintenanceUntil: new Date(Date.now() + 3_600_000),
        maintenanceStartedAt: originalStart, maintenanceReason: 'old reason', maintenanceStartedBy: 'user-original',
      });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { captured } = mockMaintenanceTx(row);
      const res = await post(enterBody({ reason: 'still patching' }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.action).toBe('extend');
      // now + 2h, not (now + 1h) + 2h
      expect(new Date(body.maintenance.until).getTime() - Date.now()).toBeGreaterThan(1.9 * 3_600_000);
      expect(new Date(body.maintenance.until).getTime() - Date.now()).toBeLessThan(2.1 * 3_600_000);
      expect(captured[0]).not.toHaveProperty('maintenanceStartedBy');
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'device.maintenance.extend',
        details: expect.objectContaining({ previousReason: 'old reason' }),
      }));
    });

    it('treats an EXPIRED lease as a fresh entry and still requires the grant', async () => {
      authState.mfa = false;
      const row = deviceRow({ status: 'maintenance', maintenanceUntil: new Date(Date.now() - 3_600_000), maintenanceStartedAt: new Date(Date.now() - 7_200_000), maintenanceReason: 'old', maintenanceStartedBy: 'user-original' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it.each(['quarantined', 'pending', 'updating'])(
      'refuses entry for a %s device with 409 MAINTENANCE_STATE_CONFLICT and no state change', async (status) => {
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow({ status }) as never);
        const res = await post(enterBody());
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: 'MAINTENANCE_STATE_CONFLICT' });
        expect(db.transaction).not.toHaveBeenCalled();
      });

    // ---- REPLACES "rejects maintenance mode changes for decommissioned devices"
    it('rejects maintenance mode changes for decommissioned devices, with no state change', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow({ status: 'decommissioned' }) as never);
      const res = await post(enterBody());
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    // ---- REPLACES "denies maintenance changes when site scope excludes the device"
    it('denies maintenance changes when site scope excludes the device, with no state change', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow({ siteId: 'site-denied' }) as never);
      const res = await post(enterBody(), { 'x-site-restricted': 'true' });
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    // ---- T6: consume race.
    it('returns 403 STEP_UP_REQUIRED and issues no UPDATE when the grant is consumed by a racing request', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
      const { calls } = mockMaintenanceTx(deviceRow());
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(calls).not.toContain('update');
    });

    // ---- T7: exit stays un-gated and truthful.
    it('exits maintenance without MFA or a grant and resolves status from FRESH liveness (offline)', async () => {
      authState.mfa = false;
      const row = deviceRow({ status: 'maintenance', lastSeenAt: new Date(Date.now() - 10 * 60_000), maintenanceUntil: new Date(Date.now() + 3_600_000), maintenanceStartedAt: new Date(Date.now() - 3_600_000), maintenanceReason: 'r', maintenanceStartedBy: 'user-123' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { captured } = mockMaintenanceTx(row);
      const res = await post(JSON.stringify({ enable: false }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, changed: true });
      expect(captured[0]).toMatchObject({ status: 'offline', maintenanceUntil: null });
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: 'device.maintenance.disable',
        details: expect.objectContaining({ resolvedStatus: 'offline', endedEarly: true }),
      }));
    });

    it('resolves a recently-seen device to online on exit', async () => {
      const row = deviceRow({ status: 'maintenance', lastSeenAt: new Date(Date.now() - 60_000), maintenanceUntil: new Date(Date.now() + 3_600_000), maintenanceStartedAt: new Date(Date.now() - 3_600_000), maintenanceReason: 'r', maintenanceStartedBy: 'user-123' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { captured } = mockMaintenanceTx(row);
      await post(JSON.stringify({ enable: false }));
      expect(captured[0]).toMatchObject({ status: 'online' });
    });

    it('is a 200 no-op with changed:false and NO audit row when there is nothing to end', async () => {
      const row = deviceRow({ status: 'online' });
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(row as never);
      const { calls } = mockMaintenanceTx(row);
      const res = await post(JSON.stringify({ enable: false }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ changed: false });
      expect(calls).not.toContain('update');
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    // ---- T8: body contract.
    it.each([
      ['missing reason', { enable: true, durationHours: 2 }],
      ['reason under 3 chars', { enable: true, reason: 'ab', durationHours: 2 }],
      ['durationHours 0', { enable: true, reason: 'scheduled patching', durationHours: 0 }],
      ['durationHours 169', { enable: true, reason: 'scheduled patching', durationHours: 169 }],
      ['unknown field on entry', { enable: true, reason: 'scheduled patching', durationHours: 2, sneaky: 1 }],
      ['durationHours on exit (strict)', { enable: false, durationHours: 2 }],
    ])('rejects %s with 400 and no state change', async (_label, body) => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow() as never);
      const res = await post(JSON.stringify(body));
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    // ---- T9: machine-principal denial that does NOT depend on the MFA gate.
    it.each([[true], [false]])(
      'denies an api_key principal on ENTRY with ENABLE_2FA=%s, with no state change', async (twoFactorOn) => {
        // With ENABLE_2FA=false, hasSatisfiedMfa returns true for ANY context and
        // API-key contexts carry token:{} (routes/mcpServer.ts:2246) — so if the
        // interactive gate were removed, this case would 200. That is exactly why
        // it runs with 2FA OFF as well as on.
        enable2faState.value = twoFactorOn;
        authState.principalKind = 'api_key';
        vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow() as never);
        const res = await post(enterBody());
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Interactive user session required' });
        expect(db.transaction).not.toHaveBeenCalled();
        expect(db.update).not.toHaveBeenCalled();
        expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
      });

    it.each([[true], [false]])(
      'denies an api_key principal on EXIT with ENABLE_2FA=%s, with no state change', async (twoFactorOn) => {
        enable2faState.value = twoFactorOn;
        authState.principalKind = 'api_key';
        const res = await post(JSON.stringify({ enable: false }));
        expect(res.status).toBe(403);
        expect(db.transaction).not.toHaveBeenCalled();
      });

    it('denies an oauth_grant principal — acting FOR a user is not acting AS an interactive session', async () => {
      authState.principalKind = 'oauth_grant';
      const res = await post(enterBody());
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('skips the grant requirement when ENABLE_2FA is off, and records stepUp: disabled_2fa', async () => {
      enable2faState.value = false;
      authState.mfa = false;
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(deviceRow() as never);
      mockMaintenanceTx(deviceRow());
      const res = await post(JSON.stringify({ enable: true, reason: 'scheduled patching', durationHours: 2 }));
      expect(res.status).toBe(200);
      expect(validateStepUpGrant).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({ stepUp: 'disabled_2fa' }),
      }));
    });
  });
```

- [ ] **Step 3: Run and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run src/routes/devices/commands.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T1-T9-single-route.txt" | tail -60
```
Expected: T1 passes (precondition established by Task 2); T2/T3/T9 fail with `expected 403 … received 200` — **live proof the route is ungated on current `main`**; T4/T5/T6/T7 fail on missing `action`/`maintenance` fields; T8 fails because the current schema accepts the old body. Paste the T2, T3, T9 `expected 403 … received 200` lines into the commit message — they are the finding itself.

- [ ] **Step 4: Implement the schemas — `apps/api/src/routes/devices/schemas.ts:185-188`**

Add to the file's imports:
```ts
import { MAINTENANCE_MAX_BULK_DEVICES, MAINTENANCE_MAX_DURATION_HOURS } from '../../services/mfaStepUpGrant';
```
Replace `maintenanceModeSchema`:
```ts
/**
 * RMM-QA-176 D4. `reason` and `durationHours` are REQUIRED on entry: the exit
 * contract's "audit actor/reason/window" clause cannot be met by an audit row
 * that says `reason: null`, and there is no released client to protect — the
 * route is JWT-only (index.ts:840) so no API-key integration can exist, and the
 * web ships its dialog in the same PR. Both branches are `.strict()`, so an old
 * client sending `{ enable: false, durationHours }` gets a named 400 rather
 * than silently having a field ignored. Bounds are imported, never retyped:
 * the step-up mint schema binds the SAME numbers into the grant digest.
 */
export const maintenanceReasonSchema = z.string().trim().min(3).max(500);
export const maintenanceDurationSchema = z.number().int().min(1).max(MAINTENANCE_MAX_DURATION_HOURS);

export const maintenanceModeSchema = z.discriminatedUnion('enable', [
  z.object({
    enable: z.literal(true),
    reason: maintenanceReasonSchema,
    durationHours: maintenanceDurationSchema,
    stepUpGrant: z.string().guid().optional(),
  }).strict(),
  z.object({
    enable: z.literal(false),
  }).strict(),
]);

/** Entry-only. Exit stays per-device — ending suppression needs no batching. */
export const bulkMaintenanceSchema = z.object({
  deviceIds: z.array(z.string().guid()).min(1).max(MAINTENANCE_MAX_BULK_DEVICES),
  reason: maintenanceReasonSchema,
  durationHours: maintenanceDurationSchema,
  stepUpGrant: z.string().guid().optional(),
}).strict();
```

- [ ] **Step 5: Implement the route — `apps/api/src/routes/devices/commands.ts`**

Extend the import block at the top of the file:
```ts
import type { Context, MiddlewareHandler, Next } from 'hono';
import { authMiddleware, isInteractiveUserSession, requireMfa, requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { createCommandSchema, bulkCommandSchema, maintenanceModeSchema, bulkMaintenanceSchema } from './schemas';
import {
  MAINTENANCE_ENTRY_ALLOWED_STATUSES,
  MaintenanceLeaseError,
  applyMaintenanceEntry,
  clearMaintenanceLease,
} from '../../services/deviceMaintenanceLease';
import { consumeStepUpGrant, maintenanceResourceDigest, validateStepUpGrant, type StepUpGrantBinding } from '../../services/mfaStepUpGrant';
import { getUserEpochs } from '../../services/authEpochs';
import { ENABLE_2FA } from '../auth/schemas';
```

Add just above the maintenance route (module scope):
```ts
const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

/** Thrown inside the write transaction when the grant lost a consume race. */
class MaintenanceStepUpConsumedError extends Error {}

/**
 * "A human must be doing this" — UNCONDITIONAL, on entry AND exit
 * (RMM-QA-176 D1). NOT redundant with requireMfa(): API-key and MCP-OAuth
 * contexts are built with `token: {}` (routes/mcpServer.ts:2246), and
 * hasSatisfiedMfa returns true for ANY context when ENABLE_2FA is off — so on
 * such a deployment the MFA gate would ADMIT a machine principal. This gate is
 * what makes "API-key denial with zero state change" independent of MFA
 * configuration. Placed before the device lookup so a denial costs no query.
 */
function requireInteractiveSession(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth || !isInteractiveUserSession(auth)) {
      return c.json({ error: 'Interactive user session required' }, 403);
    }
    return next();
  };
}

/**
 * Entry and extension need an assured session; EXIT deliberately does not —
 * "keep exit safely available" (D3). Sits AFTER zValidator so `enable` is
 * parsed, not read off an unvalidated body.
 */
function requireMaintenanceEntryMfa(): MiddlewareHandler {
  const mfaGate = requireMfa();
  return async (c: Context, next: Next) => {
    const data = (c.req as unknown as { valid: (t: 'json') => { enable: boolean } }).valid('json');
    if (data?.enable !== true) return next();
    return mfaGate(c, next);
  };
}

function maintenanceLeaseErrorResponse(c: Context, err: MaintenanceLeaseError) {
  const body = err.code === 'state_conflict'
    ? { error: err.message, code: 'MAINTENANCE_STATE_CONFLICT' as const }
    : { error: err.message };
  return c.json(body, err.status as 400 | 404 | 409);
}
```

Replace the route body (`:363-413`) with:
```ts
// POST /devices/:id/maintenance - Enter, extend or exit maintenance mode
//
// RMM-QA-176: entry and extension mutate monitoring posture, so they require an
// assured session AND a single-use, operation-bound step-up grant; exit is
// un-gated but truthful. Every 4xx below happens BEFORE db.transaction is
// called — that is the "zero state change on denial" property, and it is
// asserted per denial in commands.test.ts rather than assumed.
commandsRoutes.post(
  '/:id/maintenance',
  requireScope('organization', 'partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  zValidator('json', maintenanceModeSchema),
  requireMaintenanceEntryMfa(),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const deviceId = c.req.param('id')!;
    const data = c.req.valid('json');
    const now = new Date();

    const device = await getDeviceWithOrgCheck(deviceId, auth);
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (device.status === 'decommissioned') {
      return c.json({ error: 'Cannot change maintenance mode for a decommissioned device' }, 400);
    }

    if (!data.enable) {
      const result = await db.transaction(async (tx) => clearMaintenanceLease(tx, { deviceId, now }));
      // No audit row when nothing changed: an audit event must never claim a
      // transition that did not happen.
      if (result.changed) {
        writeRouteAudit(c, {
          orgId: device.orgId,
          action: 'device.maintenance.disable',
          resourceType: 'device',
          resourceId: result.device.id,
          resourceName: result.device.hostname ?? result.device.displayName ?? device.hostname,
          details: {
            previousMaintenanceUntil: result.previousUntil?.toISOString() ?? null,
            previousReason: result.previousReason,
            resolvedStatus: result.resolvedStatus,
            endedEarly: result.previousUntil != null && result.previousUntil.getTime() > now.getTime(),
          },
        });
      }
      return c.json({ success: true, changed: result.changed, device: result.device });
    }

    // Advisory pre-check so a state denial costs no lock and no write; the
    // lease service re-checks under the FOR UPDATE lock.
    if (!(MAINTENANCE_ENTRY_ALLOWED_STATUSES as readonly string[]).includes(device.status)) {
      return c.json(
        { error: `Cannot enter maintenance mode while the device is "${device.status}"`, code: 'MAINTENANCE_STATE_CONFLICT' },
        409,
      );
    }

    let grantBinding: StepUpGrantBinding | null = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      grantBinding = {
        userId: auth.user.id,
        operation: 'device_maintenance',
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
        resourceDigest: maintenanceResourceDigest({
          deviceIds: [deviceId],
          reason: data.reason,
          durationHours: data.durationHours,
        }),
      };
      // Missing, stale and mismatched are ONE response on purpose: telling a
      // caller which of the three it hit is a probing oracle for the binding.
      if (!data.stepUpGrant || !(await validateStepUpGrant(data.stepUpGrant, grantBinding))) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        // Consume INSIDE the transaction, before the write: a grant burned by a
        // racing request must abort this one with no row change.
        if (grantBinding && !(await consumeStepUpGrant(data.stepUpGrant!, grantBinding))) {
          throw new MaintenanceStepUpConsumedError();
        }
        return applyMaintenanceEntry(tx, {
          deviceId,
          reason: data.reason,
          durationHours: data.durationHours,
          actorUserId: auth.user.id,
          now,
        });
      });

      writeRouteAudit(c, {
        orgId: device.orgId,
        action: result.action === 'extend' ? 'device.maintenance.extend' : 'device.maintenance.enable',
        resourceType: 'device',
        resourceId: result.device.id,
        resourceName: result.device.hostname ?? result.device.displayName ?? device.hostname,
        details: {
          reason: data.reason,
          durationHours: data.durationHours,
          maintenanceUntil: result.until.toISOString(),
          maintenanceStartedAt: result.startedAt.toISOString(),
          previousMaintenanceUntil: result.previousUntil?.toISOString() ?? null,
          previousReason: result.previousReason,
          stepUp: grantBinding ? 'grant' : 'disabled_2fa',
        },
      });

      return c.json({
        success: true,
        action: result.action,
        maintenance: {
          until: result.until.toISOString(),
          startedAt: result.startedAt.toISOString(),
          reason: data.reason,
        },
        device: result.device,
      });
    } catch (err) {
      if (err instanceof MaintenanceStepUpConsumedError) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
      if (err instanceof MaintenanceLeaseError) {
        return maintenanceLeaseErrorResponse(c, err);
      }
      throw err;
    }
  }
);
```

- [ ] **Step 6: Add the audit label — `apps/api/src/routes/devices/events.ts:346`**

Insert between `'device.maintenance.enable'` and `'device.maintenance.disable'`:
```ts
  'device.maintenance.extend': 'Maintenance mode extended',
```

- [ ] **Step 7: GREEN + typecheck**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/devices/commands.test.ts src/routes/devices/events.test.ts 2>&1 | tail -25
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass; tsc exits 0. (`devices.endpoints.test.ts` is expected to be RED at this point — Task 9 owns it. Do not "fix" it here.)

- [ ] **Step 8: Mutation controls**

  1. Delete `requireInteractiveSession(),` from the chain. Expected: both `api_key` cases fail — **and note that with `ENABLE_2FA=true` alone they would still pass**, which is the whole point of running them with 2FA off. Revert `git checkout -- apps/api/src/routes/devices/commands.ts`; re-run green.
  2. Delete `requireMaintenanceEntryMfa(),` from the chain. Expected: T2 fails. Revert; re-run green.
  3. In `requireMaintenanceEntryMfa`, change `if (data?.enable !== true)` to `return next();` unconditionally. Expected: T2 fails, and the exit tests stay green — proving the gate is entry-scoped, not blanket. Revert; re-run green.
  4. Delete the `validateStepUpGrant` call (keep `consumeStepUpGrant`). Expected: "denies entry with a stale or mismatched grant" fails. Revert; re-run green.
  5. Move `consumeStepUpGrant` to AFTER `applyMaintenanceEntry` inside the transaction. Expected: the consume-race test's `expect(calls).not.toContain('update')` fails. Revert; re-run green.
  6. In the digest call, pass `reason: data.reason.toUpperCase()`. Expected: T4's `consumeStepUpGrant` binding assertion fails on `resourceDigest` — the executed proof that the route and the mint route share one canonicalization. Revert; re-run green.
  7. Remove `.strict()` from the exit branch of `maintenanceModeSchema`. Expected: "durationHours on exit (strict)" fails. Revert `git checkout -- apps/api/src/routes/devices/schemas.ts`; re-run green.
  8. In the exit branch, write the audit unconditionally (drop `if (result.changed)`). Expected: "NO audit row when there is nothing to end" fails. Revert; re-run green.

  Record all eight mutations and their observed failures.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/devices/schemas.ts apps/api/src/routes/devices/commands.ts \
        apps/api/src/routes/devices/events.ts apps/api/src/routes/devices/commands.test.ts
git commit -m "fix(devices): gate maintenance entry/extension behind an assured session and a single-use step-up grant (RMM-QA-176 D1-D4/D12)

POST /devices/:id/maintenance mutated monitoring posture behind devices:write +
site scope only. Now: unconditional isInteractiveUserSession gate (entry AND
exit) -> devices:write -> body -> requireMfa() ON ENTRY ONLY -> entry-state
allowlist -> validate a device_maintenance step-up grant bound to
{deviceIds, reason, durationHours} -> consume it INSIDE the write transaction ->
applyMaintenanceEntry. reason and durationHours are required on entry and the
window is persisted, so 'extend' is a real, distinguishable, audited operation
(device.maintenance.extend). Exit needs neither MFA nor a grant, clears the
lease, and resolves status from FRESH liveness instead of restoring a stale
value; nothing to end is a 200 changed:false with NO audit row.

The interactive gate is deliberately NOT the MFA gate: API-key/MCP-OAuth
contexts carry token:{} (mcpServer.ts:2246) and hasSatisfiedMfa passes anything
when ENABLE_2FA is off, so the machine-principal denial is proved with
ENABLE_2FA=false as well as true.

Three existing cases FLIP. 'enables maintenance mode for eligible devices'
asserted a 200 on an ungated route — replaced by the same happy path that now
also asserts the exact grant binding consumed and the actor/reason/window
audit. The decommissioned and site-scope cases keep their assertions with the
new required body and a stronger no-write check.

RED (before): <paste the T2/T3/T9 'expected 403 ... received 200' lines from T1-T9-single-route.txt>
Mutation control: <paste the eight observed failures from Step 8>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 8: D2 — `POST /devices/bulk/maintenance`, one grant for the whole batch

Bulk entry becomes a server-side operation so the technician proves one factor for the set they were shown, not N times. Three phases: preflight with **no writes**, consume the grant **once**, then **one** transaction over the eligible set.

**Files:**
- Modify: `apps/api/src/routes/devices/commands.ts` (new route registered BEFORE `/:id/maintenance`)
- Modify: `apps/api/src/routes/devices/commands.test.ts` (new describe)

**Interfaces:**
- Consumes: `bulkMaintenanceSchema` (Task 7); `applyMaintenanceEntry`, `MaintenanceLeaseError` (Task 6); `maintenanceResourceDigest`, `validateStepUpGrant`, `consumeStepUpGrant` (Task 4).
- Produces (used by Task 12): `POST /devices/bulk/maintenance` `{ deviceIds, reason, durationHours, stepUpGrant? }` → `200 { succeeded: [{ deviceId, action, maintenanceUntil }], failed: [{ deviceId, code, message }] }`, `code ∈ TARGET_NOT_FOUND | SITE_ACCESS_DENIED | DECOMMISSIONED | STATE_CONFLICT`.

- [ ] **Step 1: Write the failing tests — add a new describe to `commands.test.ts`, immediately before `describe('POST /devices/:id/maintenance', …)`**

```ts
  describe('POST /devices/bulk/maintenance', () => {
    const GRANT = '22222222-2222-4222-8222-222222222222';
    const ids = {
      ok: '00000000-0000-4000-8000-00000000000a',
      missing: '00000000-0000-4000-8000-00000000000b',
      denied: '00000000-0000-4000-8000-00000000000c',
      quarantined: '00000000-0000-4000-8000-00000000000d',
    };
    const row = (id: string, over: Record<string, unknown> = {}) => ({
      id, orgId: 'org-123', hostname: `host-${id.slice(-1)}`, siteId: 'site-allowed',
      status: 'online', lastSeenAt: new Date(Date.now() - 60_000),
      maintenanceStartedAt: null, maintenanceUntil: null, maintenanceReason: null, maintenanceStartedBy: null,
      ...over,
    });
    const bulkPost = (body: unknown, headers: Record<string, string> = {}) =>
      app.request('/devices/bulk/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', ...headers },
        body: JSON.stringify(body),
      });
    const validBody = (over: Record<string, unknown> = {}) => ({
      // NOTE the duplicate: the digest must be computed over the DEDUPED set.
      deviceIds: [ids.ok, ids.missing, ids.denied, ids.quarantined, ids.ok],
      reason: 'scheduled patching', durationHours: 2, stepUpGrant: GRANT, ...over,
    });

    function stubLookups() {
      vi.mocked(getDeviceWithOrgCheck).mockImplementation(async (id: string) => {
        if (id === ids.missing) return null as never;
        if (id === ids.denied) return row(id, { siteId: 'site-denied' }) as never;
        if (id === ids.quarantined) return row(id, { status: 'quarantined' }) as never;
        return row(id) as never;
      });
    }

    it('validates the grant over the SORTED, DEDUPED device set and consumes it exactly once, after preflight', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      const res = await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      expect(res.status).toBe(200);
      const expectedDigest = maintenanceResourceDigest({
        deviceIds: [ids.ok, ids.missing, ids.denied, ids.quarantined],
        reason: 'scheduled patching', durationHours: 2,
      });
      expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({ operation: 'device_maintenance', resourceDigest: expectedDigest }));
      expect(consumeStepUpGrant).toHaveBeenCalledTimes(1);
      expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({ resourceDigest: expectedDigest }));
    });

    it('reports per-device failures with codes and enters only the eligible devices, in ONE transaction', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      const res = await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      const body = await res.json();
      expect(body.succeeded.map((s: any) => s.deviceId)).toEqual([ids.ok]);
      expect(body.succeeded[0]).toMatchObject({ action: 'enable' });
      expect(body.failed.map((f: any) => [f.deviceId, f.code]).sort()).toEqual([
        [ids.denied, 'SITE_ACCESS_DENIED'],
        [ids.missing, 'TARGET_NOT_FOUND'],
        [ids.quarantined, 'STATE_CONFLICT'],
      ].sort());
      expect(db.transaction).toHaveBeenCalledTimes(1);
    });

    it('writes one audit row per succeeded device (per-resource trail, like bulk wake)', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      const maintenanceAudits = vi.mocked(writeRouteAudit).mock.calls
        .filter(([, e]: any) => String(e.action).startsWith('device.maintenance.'));
      expect(maintenanceAudits).toHaveLength(1);
      expect(maintenanceAudits[0][1]).toMatchObject({ action: 'device.maintenance.enable' });
    });

    it('returns 200 with all failures and NEVER burns the grant when no device is eligible', async () => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null as never);
      const res = await bulkPost(validBody());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.succeeded).toEqual([]);
      expect(body.failed).toHaveLength(4);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 403 STEP_UP_REQUIRED with no transaction when the consume loses a race', async () => {
      stubLookups();
      vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
      const res = await bulkPost(validBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 403 STEP_UP_REQUIRED before any lookup when the grant is missing', async () => {
      stubLookups();
      const res = await bulkPost(validBody({ stepUpGrant: undefined }));
      expect(res.status).toBe(403);
      expect(consumeStepUpGrant).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('requires MFA unconditionally — this route is entry only', async () => {
      authState.mfa = false;
      const res = await bulkPost(validBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it.each([[true], [false]])('denies an api_key principal with ENABLE_2FA=%s and no state change', async (twoFactorOn) => {
      enable2faState.value = twoFactorOn;
      authState.principalKind = 'api_key';
      const res = await bulkPost(validBody());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Interactive user session required' });
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects a body over the shared device cap with 400 and no state change', async () => {
      const res = await bulkPost(validBody({ deviceIds: Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }));
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('is registered BEFORE /:id/maintenance so "bulk" is not read as a device id', async () => {
      stubLookups();
      mockMaintenanceTx(row(ids.ok));
      await bulkPost(validBody(), { 'x-site-restricted': 'true' });
      expect(vi.mocked(getDeviceWithOrgCheck).mock.calls.map((c) => c[0])).not.toContain('bulk');
    });
  });
```

- [ ] **Step 2: Run and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run src/routes/devices/commands.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T10-bulk-maintenance.txt" | tail -40
```
Expected: every bulk case fails with `expected 200 … received 404` (route absent).

- [ ] **Step 3: Implement the bulk route — insert into `apps/api/src/routes/devices/commands.ts` immediately after the `POST /bulk/commands` route (`:243`) and BEFORE any `/:id/…` route**

```ts
// POST /devices/bulk/maintenance - Enter maintenance mode on many devices
//
// RMM-QA-176 D2. ENTRY ONLY (exit stays per-device — ending suppression needs
// no batching). Registered before the `/:id/…` routes in this router so `bulk`
// is never read as a device id; commandsRoutes is mounted last in
// routes/devices/index.ts and no earlier router registers POST /bulk/*.
//
// Three phases, in this order and for this reason:
//   1. PREFLIGHT, no writes — validate the grant against the digest of the
//      WHOLE deduplicated set, then authorize every device, collecting the
//      ineligible ones. Authorization is decided before anything is written.
//   2. CONSUME ONCE — one getdel for the batch. A multi-use grant, or N
//      single-device calls re-presenting one grant, would be a wider replay
//      window than a single consume.
//   3. ONE TRANSACTION over the eligible set, all-or-nothing.
// Cost, stated: a phase-3 failure rolls the batch back with the grant already
// burned, so the technician re-steps-up. Preflight-ineligible devices never
// touch the transaction and are reported, never silently retried.
commandsRoutes.post(
  '/bulk/maintenance',
  requireScope('organization', 'partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', bulkMaintenanceSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const data = c.req.valid('json');
    const now = new Date();
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const deviceIds = [...new Set(data.deviceIds)];

    type BulkFailureCode = 'TARGET_NOT_FOUND' | 'SITE_ACCESS_DENIED' | 'DECOMMISSIONED' | 'STATE_CONFLICT';
    const failed: Array<{ deviceId: string; code: BulkFailureCode; message: string }> = [];
    const eligible: Array<{ id: string; orgId: string; hostname: string | null; displayName?: string | null }> = [];

    let grantBinding: StepUpGrantBinding | null = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      grantBinding = {
        userId: auth.user.id,
        operation: 'device_maintenance',
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
        resourceDigest: maintenanceResourceDigest({
          deviceIds,
          reason: data.reason,
          durationHours: data.durationHours,
        }),
      };
      if (!data.stepUpGrant || !(await validateStepUpGrant(data.stepUpGrant, grantBinding))) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
    }

    // Phase 1 — preflight. No writes.
    for (const deviceId of deviceIds) {
      const device = await getDeviceWithOrgCheck(deviceId, auth);
      if (!device) {
        failed.push({ deviceId, code: 'TARGET_NOT_FOUND', message: 'Device not found.' });
        continue;
      }
      if (!canAccessDeviceSite(device, permissions)) {
        failed.push({ deviceId, code: 'SITE_ACCESS_DENIED', message: 'Access to this site denied.' });
        continue;
      }
      if (device.status === 'decommissioned') {
        failed.push({ deviceId, code: 'DECOMMISSIONED', message: 'Cannot change maintenance mode for a decommissioned device.' });
        continue;
      }
      if (!(MAINTENANCE_ENTRY_ALLOWED_STATUSES as readonly string[]).includes(device.status)) {
        failed.push({ deviceId, code: 'STATE_CONFLICT', message: `Cannot enter maintenance mode while the device is "${device.status}".` });
        continue;
      }
      eligible.push(device);
    }

    // Nothing to do: report and leave the grant unspent so the technician can
    // fix the selection and retry without a second factor prompt.
    if (eligible.length === 0) {
      return c.json({ succeeded: [], failed });
    }

    // Phase 2 — consume ONCE, outside the transaction, after authorization.
    if (grantBinding && !(await consumeStepUpGrant(data.stepUpGrant!, grantBinding))) {
      return c.json(STEP_UP_REQUIRED_BODY, 403);
    }

    // Phase 3 — one transaction, all-or-nothing.
    let results: Array<{ device: typeof eligible[number]; result: Awaited<ReturnType<typeof applyMaintenanceEntry>> }>;
    try {
      results = await db.transaction(async (tx) => {
        const applied: Array<{ device: typeof eligible[number]; result: Awaited<ReturnType<typeof applyMaintenanceEntry>> }> = [];
        for (const device of eligible) {
          applied.push({
            device,
            result: await applyMaintenanceEntry(tx, {
              deviceId: device.id,
              reason: data.reason,
              durationHours: data.durationHours,
              actorUserId: auth.user.id,
              now,
            }),
          });
        }
        return applied;
      });
    } catch (err) {
      // A state change that surfaced only under the lock aborts the whole batch
      // — reported, not partially applied.
      if (err instanceof MaintenanceLeaseError) {
        return maintenanceLeaseErrorResponse(c, err);
      }
      throw err;
    }

    // Per-device audit rows after commit — same shape as the single route, no
    // aggregate row, so the trail stays per-resource like bulk wake.
    for (const { device, result } of results) {
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: result.action === 'extend' ? 'device.maintenance.extend' : 'device.maintenance.enable',
        resourceType: 'device',
        resourceId: result.device.id,
        resourceName: result.device.hostname ?? result.device.displayName ?? device.hostname,
        details: {
          reason: data.reason,
          durationHours: data.durationHours,
          maintenanceUntil: result.until.toISOString(),
          maintenanceStartedAt: result.startedAt.toISOString(),
          previousMaintenanceUntil: result.previousUntil?.toISOString() ?? null,
          previousReason: result.previousReason,
          stepUp: grantBinding ? 'grant' : 'disabled_2fa',
          bulk: true,
        },
      });
    }

    return c.json({
      succeeded: results.map(({ result }) => ({
        deviceId: result.device.id,
        action: result.action,
        maintenanceUntil: result.until.toISOString(),
      })),
      failed,
    });
  }
);
```

- [ ] **Step 4: GREEN + typecheck**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/devices/commands.test.ts 2>&1 | tail -25
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass; tsc exits 0.

- [ ] **Step 5: Mutation controls**

  1. Move the `consumeStepUpGrant` call above the preflight loop. Expected: "returns 200 with all failures and NEVER burns the grant" fails. Revert; re-run green.
  2. Change the digest input to `data.deviceIds` (undeduped). Expected: the sorted/deduped digest assertion fails. Revert; re-run green.
  3. Wrap each `applyMaintenanceEntry` in its own `db.transaction`. Expected: `expect(db.transaction).toHaveBeenCalledTimes(1)` fails. Revert; re-run green.
  4. Register the route AFTER `/:id/maintenance`. Expected: the "registered BEFORE" test fails (`getDeviceWithOrgCheck` is called with `'bulk'`). Revert; re-run green.
  5. Drop the `MAINTENANCE_ENTRY_ALLOWED_STATUSES` preflight branch. Expected: the `STATE_CONFLICT` entry disappears from `failed`. Revert; re-run green.

  Record all five mutations and their observed failures.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/commands.ts apps/api/src/routes/devices/commands.test.ts
git commit -m "feat(devices): server-side bulk maintenance entry under ONE step-up grant (RMM-QA-176 D2)

POST /devices/bulk/maintenance replaces the web's N-single-calls loop. Preflight
(no writes) validates the grant against the digest of the whole deduplicated
set and authorizes every device, collecting ineligible ones with codes; the
grant is consumed exactly ONCE after authorization; one transaction applies the
eligible set all-or-nothing; per-device audit rows are written after commit.
An all-ineligible batch is a 200 that never burns the grant. Registered before
the /:id/... routes so 'bulk' is never read as a device id.

RED (before): <paste from T10-bulk-maintenance.txt: expected 200 ... received 404>
Mutation control: <paste the five observed failures from Step 5>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---
### Task 9: T11 — endpoint-level proof of the gate, and the byte-identical-row denial evidence

Task 7 deliberately left `__tests__/devices.endpoints.test.ts` RED: its `:239` case asserts a **200 on enable with the default `mfa: false` token** (`__tests__/helpers.ts:93` — `mfa: options.mfa ?? false`), which is the finding stated as a passing test. That case flips here into the stronger statement, and the exit-evidence contract's *"prove non-assured-session / API-key denial with zero state change"* clause gets its **real-Postgres** proof: `SELECT *` the device row, issue the denied request, `SELECT *` again, assert byte-identical.

**Why a second, integration-level denial test when `commands.test.ts` already asserts `db.transaction` was not called:** a mock-level "the write function was not invoked" is a statement about the *test double*. The contract's claim is about the *row*. Only a real Postgres round-trip can say the row did not move — including via a path the unit suite's mock does not model (a trigger, a cascade, an `updatedAt` touch).

**Files:**
- Modify: `apps/api/src/__tests__/devices.endpoints.test.ts:238-262` (the `describe('POST /devices/:id/maintenance')` block)
- Create: `apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts`

**Interfaces:**
- Consumes: the route and schemas from Tasks 7–8; the lease columns from Task 5; `maintenanceResourceDigest` (Task 4).
- Produces: `<SP>/rmm-qa-176-red/T11-endpoints.txt` and `<SP>/rmm-qa-176-red/T11-integration.txt` — the two evidence files the PR body (Task 14) cites for the denial claim.

- [ ] **Step 1: Capture the standing RED that Task 7 left**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run src/__tests__/devices.endpoints.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T11-endpoints.txt" | tail -40
```
Expected: `should enable maintenance mode` FAILS with `expected 200 … received 403` (or a 400 on the now-required `reason`). Compare against `00-baseline.txt`, where this same case PASSED with a 200 — that pair of lines (green on `main`, red on the branch) is the endpoint-level statement of the finding. Paste both into the commit message.

- [ ] **Step 2: Replace the maintenance describe in `apps/api/src/__tests__/devices.endpoints.test.ts` (`:238-262` plus the `should disable maintenance mode` case that follows it)**

This suite runs the REAL `authMiddleware` against a real signed token (`createAuthenticatedClient`), so it is the only unit-level place where the token's `mfa` claim is genuine rather than a mocked auth context. Keep that property — do not add an auth mock.

```ts
  describe('POST /devices/:id/maintenance', () => {
    // This suite mints a REAL token (helpers.ts createTestToken) and runs the
    // REAL authMiddleware, so `mfa` here is an actual JWT claim, not a mocked
    // context field. That is what makes it a different proof from
    // routes/devices/commands.test.ts and worth keeping.
    const DEVICE_ID = '11111111-2222-4333-8444-555555555555';

    it('denies entry from a non-assured session and writes nothing (was: a 200 — the finding)', async () => {
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);

      // Default token: mfa:false (helpers.ts:93). On main this returned 200.
      const client = await createAuthenticatedClient(app);
      const res = await client.post(`/devices/${device.id}/maintenance`, {
        enable: true,
        reason: 'scheduled patching',
        durationHours: 2,
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('rejects the OLD body shape (no reason) even from an assured session', async () => {
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);

      const client = await createAuthenticatedClient(app, { mfa: true });
      const res = await client.post(`/devices/${device.id}/maintenance`, { enable: true, durationHours: 2 });

      expect(res.status).toBe(400);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('admits an assured session presenting a valid grant', async () => {
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);
      // db.transaction runs the lease service against a stub tx: locked select
      // then one UPDATE ... RETURNING.
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({
        select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [device] }) }) }) }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => ({ returning: async () => [{ ...device, ...values }] }),
          }),
        }),
      }));

      const client = await createAuthenticatedClient(app, { mfa: true });
      const res = await client.post(`/devices/${device.id}/maintenance`, {
        enable: true,
        reason: 'scheduled patching',
        durationHours: 2,
        stepUpGrant: '11111111-1111-4111-8111-111111111111',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ success: true, action: 'enable' });
    });

    it('exits maintenance without MFA and without a grant', async () => {
      const device = createTestDevice({
        id: '22222222-3333-4444-8555-666666666666',
        status: 'maintenance',
        lastSeenAt: new Date(),
        maintenanceUntil: new Date(Date.now() + 3_600_000),
        maintenanceStartedAt: new Date(Date.now() - 3_600_000),
        maintenanceReason: 'scheduled patching',
        maintenanceStartedBy: 'test-user-id',
      });
      mockUserLookup();
      mockDeviceLookup(device);
      vi.mocked(db.transaction).mockImplementationOnce(async (fn: any) => fn({
        select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [device] }) }) }) }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: () => ({ returning: async () => [{ ...device, ...values }] }),
          }),
        }),
      }));

      const client = await createAuthenticatedClient(app); // mfa:false on purpose
      const res = await client.post(`/devices/${device.id}/maintenance`, { enable: false });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true, changed: true });
    });

    it('rejects an X-API-Key-only request at authMiddleware and writes nothing', async () => {
      // /devices is mounted under the JWT authMiddleware only (index.ts:840) —
      // no apiKeyAuthMiddleware branch — so an API key never reaches the route
      // at all. Asserted here rather than assumed: if a future PR mounts an
      // API-key branch under /devices, this test is what notices.
      const device = createTestDevice({ id: DEVICE_ID, status: 'online' });
      mockUserLookup();
      mockDeviceLookup(device);

      const res = await app.request(`/devices/${device.id}/maintenance`, {
        method: 'POST',
        headers: { 'X-API-Key': 'brz_test_key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: true, reason: 'scheduled patching', durationHours: 2 }),
      });

      expect(res.status).toBe(401);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });
```

If `db.transaction` is not on this file's `../db` mock, add `transaction: vi.fn()` beside `update` there (same one-line change Task 2 made to `commands.test.ts`).

- [ ] **Step 3: Run the endpoint suite to GREEN**

```bash
pnpm --filter @breeze/api exec vitest run src/__tests__/devices.endpoints.test.ts 2>&1 | tail -25
```
Expected: PASS. If the `X-API-Key` case returns 403 rather than 401, that is a real finding about the mount, not a test bug — stop and report it before adjusting the assertion.

- [ ] **Step 4: Write the real-Postgres denial proof `apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts`**

Model the harness on `apps/api/src/__tests__/integration/aiAgents.routes.integration.test.ts:1-95` (verified: `import './setup'`, `buildApp()` mounting the router under test, a `mfaClient` / `noMfaClient` pair minting real tokens with `createAccessToken`, fixtures via `./db-utils`). Note `createIntegrationTestClient` mints `mfa: false` by default (`db-utils.ts:446`), so it *is* the non-assured client.

```ts
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { deviceRoutes } from '../../routes/devices';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { createIntegrationTestClient } from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/devices', deviceRoutes);
  return app;
}

const orgContext = (orgId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null,
});

/** Whole row, so "unchanged" means EVERY column — including updated_at. */
async function readDeviceRow(orgId: string, deviceId: string): Promise<Record<string, unknown>> {
  const rows = await withDbAccessContext(orgContext(orgId), () =>
    getTestDb().execute(sql`SELECT * FROM devices WHERE id = ${deviceId}`),
  ) as unknown as Array<Record<string, unknown>>;
  return rows[0]!;
}

describe('device maintenance step-up: denial leaves the row byte-identical (RMM-QA-176)', () => {
  let app: Hono;
  let env: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let deviceId: string;

  beforeEach(async () => {
    app = buildApp();
    // Default token is mfa:false (db-utils.ts:446) — the non-assured session.
    env = await createIntegrationTestClient(app, { scope: 'organization' });
    const [device] = await withDbAccessContext(orgContext(env.env.organization.id), () =>
      getTestDb().execute(sql`
        INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status, last_seen_at)
        VALUES (${env.env.organization.id}, ${env.env.site.id}, ${`agent-${randomUUID()}`},
                ${`host-${randomUUID()}`}, 'windows', '11', 'amd64', '2.0.0', 'online', now())
        RETURNING id
      `),
    ) as unknown as Array<{ id: string }>;
    deviceId = device!.id;
  });

  /** An ASSURED session (mfa: true). createIntegrationTestClient mints
   *  mfa:false (db-utils.ts:446), so it is the non-assured client by default. */
  async function assuredPost(): Promise<(path: string, body: unknown) => Promise<Response>> {
    const payload: Omit<TokenPayload, 'type'> = {
      sub: env.env.user.id,
      email: env.env.user.email,
      roleId: env.env.role.id,
      orgId: env.env.organization.id,
      partnerId: env.env.partner.id,
      scope: 'organization',
      mfa: true,
      aep: 1, mep: 1, sid: randomUUID(),
    };
    const token = await createAccessToken(payload);
    return (path: string, body: unknown) => Promise.resolve(app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  it('a NON-ASSURED session is denied and the device row does not move', async () => {
    const before = await readDeviceRow(env.env.organization.id, deviceId);

    const res = await env.post(`/devices/${deviceId}/maintenance`, {
      enable: true, reason: 'scheduled patching', durationHours: 2,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });

    const after = await readDeviceRow(env.env.organization.id, deviceId);
    // EVERY column, not just the four lease columns: a denial that touched
    // updated_at or status would still be a state change.
    expect(after).toEqual(before);
  });

  it('an assured session with NO step-up grant is denied and the device row does not move', async () => {
    const post = await assuredPost();
    const before = await readDeviceRow(env.env.organization.id, deviceId);

    const res = await post(`/devices/${deviceId}/maintenance`, { enable: true, reason: 'scheduled patching', durationHours: 2 });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    expect(await readDeviceRow(env.env.organization.id, deviceId)).toEqual(before);
  });

  it('an X-API-Key request never reaches the route and the device row does not move', async () => {
    const before = await readDeviceRow(env.env.organization.id, deviceId);

    const res = await app.request(`/devices/${deviceId}/maintenance`, {
      method: 'POST',
      headers: { 'X-API-Key': 'brz_not_a_real_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ enable: true, reason: 'scheduled patching', durationHours: 2 }),
    });
    expect(res.status).toBe(401);

    expect(await readDeviceRow(env.env.organization.id, deviceId)).toEqual(before);
  });

  it('the bulk route denies the same two ways with no row movement', async () => {
    const before = await readDeviceRow(env.env.organization.id, deviceId);
    const body = { deviceIds: [deviceId], reason: 'scheduled patching', durationHours: 2 };

    // (a) non-assured session -> MFA gate.
    const nonAssured = await env.post('/devices/bulk/maintenance', body);
    expect(nonAssured.status).toBe(403);
    expect(await nonAssured.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await readDeviceRow(env.env.organization.id, deviceId)).toEqual(before);

    // (b) assured session, no grant -> step-up gate. Both denials happen before
    // phase 2 (consume) and phase 3 (the transaction), so the grant is not
    // burned and no row moves — the D2 "zero state change by construction"
    // claim, checked rather than asserted.
    const post = await assuredPost();
    const noGrant = await post('/devices/bulk/maintenance', body);
    expect(noGrant.status).toBe(403);
    expect(await noGrant.json()).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await readDeviceRow(env.env.organization.id, deviceId)).toEqual(before);
  });
});
```

- [ ] **Step 5: Prove the RED by reverting the route to base, then restore it**

The suite above is GREEN the moment it is written, because Tasks 7–8 already landed the gate. A control whose red was never observed is not evidence, so observe it — by putting the route back the way `main` has it:

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
git checkout fcd5b498a -- apps/api/src/routes/devices/commands.ts apps/api/src/routes/devices/schemas.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T11-integration.txt" | tail -40
```
Expected: the non-assured case fails with `expected 403 … received 200` **and** the row-identity assertion fails showing `status: 'online' → 'maintenance'` — the finding, stated against a real database row. Then restore, immediately:
```bash
git checkout HEAD -- apps/api/src/routes/devices/commands.ts apps/api/src/routes/devices/schemas.ts
git status --short   # must show NO modification to those two files
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts 2>&1 | tail -20
```
Expected: restored files clean; suite GREEN. **Do not proceed while `git status` shows either file modified** — a base-version route left in the tree would silently un-fix the finding.

- [ ] **Step 6: Mutation controls**

  1. In `commands.ts`, delete `requireInteractiveSession(),` from the `/:id/maintenance` chain, then re-run the endpoint suite. Expected: the `X-API-Key` case still passes (it 401s at `authMiddleware`, before any route middleware) — **this mutation is expected NOT to move that test**, and recording that is the point: the API-key 401 is a *mount* property, and the interactive gate is proven separately by `commands.test.ts` T9 with `ENABLE_2FA=false`. Revert `git checkout -- apps/api/src/routes/devices/commands.ts`.
  2. In `commands.ts`, move the exit branch's `db.transaction` call above the `requireMaintenanceEntryMfa()` middleware's effect by making `requireMaintenanceEntryMfa` return `next()` unconditionally. Re-run the **integration** suite. Expected: "a NON-ASSURED session is denied and the device row does not move" fails on BOTH the status code and the row equality — the executed proof that the row assertion is load-bearing and not a tautology. Revert; re-run green.
  3. In `deviceMaintenanceLease.ts` `applyMaintenanceEntry`, move the `tx.update(...)` call above the allowlist/decommissioned guards. Re-run the integration suite. Expected: the "no step-up grant" case's row assertion fails. Revert; re-run green.

  Record all three, including mutation 1's *non*-movement and why that is the correct outcome.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/__tests__/devices.endpoints.test.ts \
        apps/api/src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts
git commit -m "test(devices): endpoint-level gate proof and real-Postgres zero-state-change evidence (RMM-QA-176)

devices.endpoints.test.ts ran the REAL authMiddleware against a real signed
token and asserted a 200 on enable with the default mfa:false claim — the
finding stated as a passing test. Replaced with the denial (403 MFA_REQUIRED,
no write), the old-body 400, the assured+grant 200, the un-gated exit, and an
X-API-Key request that 401s at authMiddleware because /devices is mounted
JWT-only (index.ts:840) — asserted rather than assumed, so a future API-key
mount under /devices is noticed.

New deviceMaintenanceStepUp.integration.test.ts is the exit-evidence
contract's 'denied with zero state change' clause proved against a real row:
SELECT * before, denied request, SELECT * after, expect(after).toEqual(before)
over EVERY column, for the non-assured session, the assured-but-grantless
session and the API-key request, on the single and bulk routes. A mock-level
'db.transaction was not called' is a statement about the test double; this is
a statement about the row.

RED (before): <paste from T11-endpoints.txt (expected 200 -> received 403, vs
the same case PASSING in 00-baseline.txt) and from T11-integration.txt (the
base-route revert: expected 403 received 200, and the row diff
status: 'online' -> 'maintenance')>
Mutation control: <paste the three observed outcomes from Step 6, including
mutation 1's deliberate non-movement>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 10: D8 — close the config-policy feature-link HTTP path (`maintenance` joins the patch MFA gate)

**Why this task is not optional.** Everything Tasks 7–8 gated is `POST /devices/:id/maintenance` — a *device* actuation. The thing that actually suppresses alerts, patching, scripts and automations is the **`maintenance` feature link on a configuration policy** (`services/featureConfigResolver.ts` `checkDeviceMaintenanceWindow` is what every suppression consumer reads — spec F19). `featureLinks.ts` gates MFA on `featureType === 'patch'` **only**, verified at three sites in the current file:

| Site | Line (verified) | Code today |
|---|---|---|
| add | `:107` | `if (data.featureType === 'patch' && !hasSatisfiedMfa(auth)) {` |
| update | `:286` | `if (existingLink.featureType === 'patch' && !hasSatisfiedMfa(auth)) {` |
| remove | `:438` | `if (existingLink.featureType === 'patch' && !hasSatisfiedMfa(auth)) {` |

So an un-assured session can author a policy-level maintenance window — the same monitoring suppression the device route now gates — through a parallel HTTP path. Leaving it open makes the whole fix cosmetic.

**About the test stub, and why this is not "make the test match the code" (spec F15).** `featureLinks.test.ts:41-47` replaces the whole `middleware/auth` module with `hasSatisfiedMfa: vi.fn(() => true)`. Every one of that file's ~40 cases therefore runs as an assured session, and **no test in the repo exercises the MFA branch of this route at all** — not even for `patch`. The suite is not wrong; it is *blind*, and a blind suite is exactly how a gap ships. The change is:

- the stub becomes a hoisted, per-test-controllable box (`mfaState.satisfied`) **defaulting to `true`**, so all existing cases keep their current meaning byte-for-byte — this is not a rewrite of the suite;
- the new cases flip it to `false`, and **are run against the unchanged route first** (Step 3). The `maintenance` add/update cases go red on today's code — that red is the finding, observed, not asserted. Only then does `MFA_GATED_FEATURE_TYPES` land. A test written after the `Set` exists would merely restate the `Set`; a test written against the *contract* ("authoring monitoring suppression needs an assured session") and watched to fail discriminates;
- a `patch` case is added too — the existing gate has never had one.

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts:56` (add the constant beside `ORG_SCOPED_ONLY_FEATURES`), `:107`, `:286`; **`:438` unchanged**
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.test.ts:41-47` (the auth mock), plus a new describe

**Interfaces:**
- Consumes: nothing from earlier tasks — this is an independent surface and can be reviewed on its own.
- Produces: `export const MFA_GATED_FEATURE_TYPES: ReadonlySet<string>` from `routes/configurationPolicies/featureLinks.ts` (exported so the test names the same object the route uses, rather than re-listing the members).

- [ ] **Step 1: Make the MFA stub controllable — `apps/api/src/routes/configurationPolicies/featureLinks.test.ts`**

Replace the `vi.mock('../../middleware/auth', …)` block at `:41-47` with:

```ts
// RMM-QA-176: the MFA answer becomes per-test controllable, DEFAULTING TO TRUE
// so every pre-existing case in this file keeps exactly its current meaning
// (they are about inline-settings validation and partner-wide scope, not MFA).
// Before this, `hasSatisfiedMfa: () => true` meant no test in the repo ever
// exercised this route's MFA branch — for maintenance OR for patch.
const { mfaState } = vi.hoisted(() => ({ mfaState: { satisfied: true } }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));
```
and add `mfaState.satisfied = true;` as the first line of the file's top-level `beforeEach` (inside `describe('featureLinks routes', …)`, `:96`), so a case that flips it cannot leak into the next.

- [ ] **Step 2: Write the failing tests — append a new describe to `featureLinks.test.ts`**

```ts
  describe('MFA gate on monitoring-suppression feature links (RMM-QA-176 D8)', () => {
    const STUB_POLICY_WITH_MAINTENANCE_LINK = {
      ...STUB_POLICY,
      featureLinks: [{ id: LINK_ID, featureType: 'maintenance' }],
    };

    it('refuses to ADD a maintenance link from a session that has not satisfied MFA', async () => {
      // A maintenance feature link is the canonical suppression source: every
      // alert/patch/script/reboot consumer reads it through
      // featureConfigResolver.checkDeviceMaintenanceWindow. Authoring one from
      // an un-assured session is the same capability the device route now
      // gates, reached by another door.
      mfaState.satisfied = false;
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);

      const res = await buildApp().request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'maintenance', inlineSettings: { recurrence: 'weekly', durationHours: 2 } }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'MFA required' });
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('refuses to UPDATE an existing maintenance link from a non-assured session', async () => {
      mfaState.satisfied = false;
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY_WITH_MAINTENANCE_LINK);

      const res = await buildApp().request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inlineSettings: { recurrence: 'daily', durationHours: 4 } }),
      });

      expect(res.status).toBe(403);
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('still allows REMOVING a maintenance link without MFA — removal ENDS suppression', async () => {
      // Mirrors "keep exit safely available" (D3): the safe direction is never
      // gated. A technician must always be able to stop suppressing monitoring.
      mfaState.satisfied = false;
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY_WITH_MAINTENANCE_LINK);
      removeFeatureLinkMock.mockResolvedValue(true);

      const res = await buildApp().request(`/${POLICY_ID}/features/${LINK_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(removeFeatureLinkMock).toHaveBeenCalled();
    });

    it('gates patch the same way it always did (the gate that existed but was never tested)', async () => {
      mfaState.satisfied = false;
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);

      const res = await buildApp().request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'patch', inlineSettings: { scheduleTime: '02:00' } }),
      });

      expect(res.status).toBe(403);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('does NOT gate an unrelated feature type (monitoring) — the gate stays narrow', async () => {
      // Regression guard against over-gating: this PR promotes exactly one
      // feature type. `monitoring` is agent-side watches, not suppression.
      mfaState.satisfied = false;
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'monitoring' });

      const res = await buildApp().request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'monitoring', inlineSettings: { checkIntervalSeconds: 60, watches: [] } }),
      });

      expect(res.status).toBe(200);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('an assured session is unaffected on every gated type', async () => {
      mfaState.satisfied = true;
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'maintenance' });

      const res = await buildApp().request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'maintenance', inlineSettings: { recurrence: 'weekly', durationHours: 2 } }),
      });

      expect(res.status).toBe(200);
    });

    it('names maintenance and patch as the gated set, and nothing else', () => {
      expect([...MFA_GATED_FEATURE_TYPES].sort()).toEqual(['maintenance', 'patch']);
    });
  });
```
Add `MFA_GATED_FEATURE_TYPES` to the file's `import { featureLinkRoutes } from './featureLinks';` line (`:49`).

**Note on the `maintenance` `inlineSettings` bodies above:** this route does **not** validate maintenance inline settings (there is no `maintenanceInlineSettingsSchema` branch — QA probe `maintenance-window-contract.test.tsx:129` pins that absence, and closing that validation gap is a *different* finding and a non-goal here). The bodies just need to satisfy `addFeatureLinkSchema`; if a field is rejected, trim it — do not add a validation branch.

- [ ] **Step 3: Run against the UNCHANGED route and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run src/routes/configurationPolicies/featureLinks.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T15-featureLinks.txt" | tail -40
```
Expected, on the production file as it stands:
- "refuses to ADD a maintenance link…" FAILS — `expected 403 … received 200`, and `addFeatureLinkMock` **was** called;
- "refuses to UPDATE an existing maintenance link…" FAILS the same way;
- "names maintenance and patch as the gated set" FAILS on the missing export;
- the remove, patch, monitoring and assured cases PASS — they describe behaviour that is already correct, and their passing here is what shows the two reds are about `maintenance` specifically, not about the harness change.

Paste the two `expected 403 … received 200` lines into the commit message. They are the finding.

- [ ] **Step 4: Implement the gate — `apps/api/src/routes/configurationPolicies/featureLinks.ts`**

Add beside `ORG_SCOPED_ONLY_FEATURES` (`:56`):
```ts
/**
 * Feature types whose feature link may only be authored (added or updated) by
 * a session that has satisfied MFA.
 *
 * `patch` was here from the start: a patch link arms unattended installs and
 * reboots. `maintenance` joins it (RMM-QA-176 D8) because a maintenance link
 * is the CANONICAL monitoring-suppression source — every alert, patch, script
 * and reboot consumer reads it via featureConfigResolver's
 * checkDeviceMaintenanceWindow / resolveMaintenanceConfigForDevice. Gating
 * POST /devices/:id/maintenance while leaving this open would have left the
 * same capability reachable through a second door.
 *
 * Session-claim strength on purpose, NOT the operation-bound step-up grant the
 * device route requires (RMM-QA-176 D1): a policy-level window is authored
 * CONFIGURATION, not a per-device actuation, and parity with the adjacent
 * patch gate is the shape that stays consistent as more types are added.
 *
 * REMOVAL IS DELIBERATELY NOT GATED (`:438` keeps its patch-only check):
 * removing a maintenance link ENDS suppression — the safe direction, the same
 * reasoning that keeps maintenance EXIT un-gated on the device route.
 */
export const MFA_GATED_FEATURE_TYPES: ReadonlySet<string> = new Set(['patch', 'maintenance']);
```

At `:107` replace:
```ts
    if (data.featureType === 'patch' && !hasSatisfiedMfa(auth)) {
```
with:
```ts
    if (MFA_GATED_FEATURE_TYPES.has(data.featureType) && !hasSatisfiedMfa(auth)) {
```

At `:286` replace:
```ts
    if (existingLink.featureType === 'patch' && !hasSatisfiedMfa(auth)) {
```
with:
```ts
    if (MFA_GATED_FEATURE_TYPES.has(existingLink.featureType) && !hasSatisfiedMfa(auth)) {
```

The 403 body stays `{ error: 'MFA required' }` at both sites — the existing shape, unchanged. **Leave `:438` exactly as it is.**

- [ ] **Step 5: GREEN + typecheck + lint**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/configurationPolicies/featureLinks.test.ts 2>&1 | tail -20
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/api exec eslint src/routes/configurationPolicies/featureLinks.ts src/routes/configurationPolicies/featureLinks.test.ts
```
Expected: all pass at the Task 1 baseline count plus the seven new cases; tsc and eslint exit 0.

- [ ] **Step 6: Mutation controls**

  1. Revert `MFA_GATED_FEATURE_TYPES.has(data.featureType)` at `:107` to `data.featureType === 'patch'`. Expected: "refuses to ADD a maintenance link" fails; the patch case stays green. Revert `git checkout -- apps/api/src/routes/configurationPolicies/featureLinks.ts`; re-run green.
  2. Same reversion at `:286`. Expected: "refuses to UPDATE an existing maintenance link" fails; add case stays green — proving the two sites are asserted independently. Revert; re-run green.
  3. Change the remove gate at `:438` to use `MFA_GATED_FEATURE_TYPES` too. Expected: "still allows REMOVING a maintenance link without MFA" fails. Revert; re-run green. **This mutation is the one that matters most:** it proves the plan's "exit stays available" decision is enforced by a test, not just by a comment.
  4. Widen the set to every feature type (`new Set(CONFIG_FEATURE_TYPES)`). Expected: "does NOT gate an unrelated feature type (monitoring)" fails. Revert; re-run green.
  5. Set `mfaState.satisfied` default back to `false` in the hoisted box. Expected: a large number of *pre-existing* cases fail — the executed proof that defaulting to `true` is what preserved their meaning, i.e. that this task did not quietly rewrite the suite. Revert `git checkout -- apps/api/src/routes/configurationPolicies/featureLinks.test.ts`; re-run green.

  Record all five mutations and their observed failure lines.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/featureLinks.ts \
        apps/api/src/routes/configurationPolicies/featureLinks.test.ts
git commit -m "fix(config-policies): require an assured session to author maintenance feature links (RMM-QA-176 D8)

featureLinks.ts gated MFA on featureType === 'patch' ONLY, at add (:107),
update (:286) and remove (:438). A 'maintenance' link is the canonical
monitoring-suppression source — every alert/patch/script/reboot consumer reads
it through featureConfigResolver.checkDeviceMaintenanceWindow — so an
un-assured session could author exactly the suppression the device route was
just gated for, through a parallel HTTP path. maintenance now joins patch in
MFA_GATED_FEATURE_TYPES at add and update. REMOVE stays un-gated: removing the
link ENDS suppression, the safe direction, same reasoning as un-gated
maintenance exit.

Session-claim strength, not the device route's operation-bound grant: a
policy-level window is authored configuration, not a per-device actuation, and
parity with the adjacent patch gate is the consistent shape.

The suite could not have seen this: featureLinks.test.ts stubbed
hasSatisfiedMfa as () => true, so NO test in the repo exercised this route's
MFA branch — not for maintenance, not for patch. The stub is now a hoisted box
DEFAULTING TO TRUE, so every pre-existing case keeps its exact meaning (proved
by mutation 5), and the new cases flip it. They were run against the unchanged
route first and went red there.

RED (before): <paste the two 'expected 403 ... received 200' lines from
T15-featureLinks.txt>
Mutation control: <paste the five observed failures from Step 6>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---
### Task 11: D9 — close the MCP `manage_policy_feature_link` path (input-aware Tier 3 + machine-principal denial)

The third door to the same capability. Verified on the current tree:

| Fact | Evidence (re-read) |
|---|---|
| `manage_policy_feature_link` registers at **base tier 2** | `services/aiToolsConfigPolicy.ts:700-703` (`registerTool({ tier: 2, … name: 'manage_policy_feature_link'`) |
| only `remove` escalates | `TIER3_ACTIONS.manage_policy_feature_link: ['remove']` at `aiGuardrails.ts:209`; `TIER3_SUPERVISED_ACTIONS` same at `:396` |
| `add` / `update` / `list` are in **no** tier table | `TIER1_ACTIONS` (`:178`) and `TIER2_ACTIONS` (`:49`) have no entry for the tool — grep returns zero |
| the tool is **not** in either whole-tool set | `TIER3_FOUR_EYES_TOOLS` / `TIER3_SUPERVISED_TOOLS` — grep returns zero, so an unclassified tier-3 resolution would land on the `four_eyes` fail-safe (`resolveApprovalScope:498-501`), which is why the override is required, not optional |
| the established input-aware mechanism exists | `TIER3_INPUT_AWARE_ACTIONS` at `:452` (currently `['manage_organizations:update_org']`), consumed by the contract test at `:89` and `:157` to exempt a pair from the "classified in exactly one static table" invariant; `resolveApprovalScope`'s overrides at `:474-486` |
| `checkGuardrails` sees the full input and orders Tier 1 → Tier 3 → Tier 2 → base | `:1251`, `:1280`, `:1289`, `:1299` |
| MCP denies every effective-Tier-3 call before `executeTool` | `mcpServer.ts:1194` (`Math.max(baseTier, guardrailCheck.tier)`), `:1200-1206` (`MCP_APPROVAL_REQUIRED`, `isError: true`) |
| machine principals carry `token: {}` | `mcpServer.ts:2246` and `:2302` |

So today: `tools/call manage_policy_feature_link {action:'add', featureType:'maintenance'}` over an API key resolves to tier 2 and **auto-executes**.

**Use the established mechanism, not a new one.** `TIER3_INPUT_AWARE_ACTIONS` + a `resolveApprovalScope` override is exactly the shape `manage_organizations:update_org` already uses, including its contract-test exemption. Inventing a parallel escalation would leave the contract test unable to reason about it.

**The MFA gate is not the denial here, and must not be.** API-key and OAuth-grant contexts are built with `token: {}` (`mcpServer.ts:2246`), and `hasSatisfiedMfa` returns `true` for **any** context when `ENABLE_2FA` is off (`middleware/auth.ts:884-887`: `if (!ENABLE_2FA) return true;`). On such a deployment an MFA-based denial would *admit* a machine principal. The denials in this task are (a) the effective-tier gate, which is transport-level and MFA-blind, and (b) `auth.principal.kind`, the repo's written discriminator (`isInteractiveUserSession`, `middleware/auth.ts:64`). Step 4's test proves the handler denial holds **with `ENABLE_2FA=false`**, and asserts in the same test that `hasSatisfiedMfa` would have *passed* that context — both halves, or the control is decorative.

**`ai_agent` principals are NOT hard-denied** (spec D9.2, verifier concern C6): inside the web app an escalated call becomes a normal supervised approval, and an approved run proceeds. The handler denies only `api_key` / `oauth_grant`.

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts:452` (`TIER3_INPUT_AWARE_ACTIONS`), `:466` (`resolveApprovalScope` override), `:1251` (`checkGuardrails` hook), `:1919` (`buildApprovalDescription` case)
- Modify: `apps/api/src/services/aiGuardrails.test.ts` (append), `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts` (append, mirroring its `update_org` pattern at `:235-257`)
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts:751-845`
- Modify: `apps/api/src/services/aiToolsConfigPolicy.test.ts`
- Modify: `apps/api/src/routes/mcpServer.approvalGate.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–10 — reviewable independently.
- Produces:
  - `export function isInputAwareTier3(toolName: string, action: string | undefined, input: Record<string, unknown>): boolean` from `services/aiGuardrails.ts`
  - `TIER3_INPUT_AWARE_ACTIONS` gains `'manage_policy_feature_link:add'` and `'manage_policy_feature_link:update'`
  - `export const MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED` and `export const MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED` (error-string constants) from `services/aiToolsConfigPolicy.ts`, imported by its test so the strings have one owner

- [ ] **Step 1: Write the failing guardrail tests — append to `apps/api/src/services/aiGuardrails.test.ts`**

```ts
describe('manage_policy_feature_link maintenance escalation (RMM-QA-176 D9)', () => {
  it('escalates add of a maintenance link to tier 3, supervised', () => {
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'add', configPolicyId: 'p1', featureType: 'maintenance',
    });
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
    expect(check.approvalScope).toBe('supervised');
  });

  it('escalates update of a maintenance link to tier 3, supervised', () => {
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'update', configPolicyId: 'p1', featureLinkId: 'l1', featureType: 'maintenance',
    });
    expect(check.tier).toBe(3);
    expect(check.approvalScope).toBe('supervised');
  });

  it('leaves every OTHER feature type at the tool base tier 2 — the gate stays narrow', () => {
    for (const featureType of ['patch', 'monitoring', 'backup', 'alert_rule']) {
      const check = checkGuardrails('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType,
      });
      expect(check.tier, `${featureType} must not escalate`).toBe(2);
      expect(check.requiresApproval).toBe(false);
    }
  });

  it('leaves list at tier 2 and remove at its existing tier 3', () => {
    expect(checkGuardrails('manage_policy_feature_link', { action: 'list', configPolicyId: 'p1' }).tier).toBe(2);
    const remove = checkGuardrails('manage_policy_feature_link', { action: 'remove', configPolicyId: 'p1', featureLinkId: 'l1' });
    expect(remove.tier).toBe(3);
    expect(remove.approvalScope).toBe('supervised');
  });

  it('fails CLOSED on a non-string featureType rather than falling through to tier 2', () => {
    // A caller sending featureType: { $ne: 'maintenance' } or an array must not
    // slip past the predicate into auto-execute. Strict === 'maintenance' means
    // anything else stays tier 2 — which is the correct outcome ONLY because a
    // non-'maintenance' value cannot create a maintenance link either (the
    // handler's own featureType is what addFeatureLink writes). Pinned so a
    // future loosening of the predicate is a deliberate act.
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'add', configPolicyId: 'p1', featureType: ['maintenance'],
    });
    expect(check.tier).toBe(2);
  });

  it('names the feature type in the approval description', () => {
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'add', configPolicyId: 'p1', featureType: 'maintenance',
    });
    expect(check.description).toContain('maintenance');
  });
});
```

- [ ] **Step 2: Write the failing contract tests — append to `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts`, immediately after the `s1_isolate_device` input-aware block (`:259-…`)**

Mirror the `update_org` pair at `:235-257` exactly — same three-test shape (registered as input-aware / both branches of `resolveApprovalScope` / both branches through `checkGuardrails`):

```ts
  it('manage_policy_feature_link add+update are input-aware: exempt from the static per-action tables', () => {
    expect(TIER3_INPUT_AWARE_ACTIONS.has('manage_policy_feature_link:add')).toBe(true);
    expect(TIER3_INPUT_AWARE_ACTIONS.has('manage_policy_feature_link:update')).toBe(true);
    // They escalate through the input-aware hook, NOT the static table — so
    // they must not appear in TIER3_ACTIONS either, or `remove`'s entry would
    // stop being the only static escalation for this tool.
    expect(TIER3_ACTIONS.manage_policy_feature_link ?? []).toEqual(['remove']);
    expect(TIER3_FOUR_EYES_ACTIONS.manage_policy_feature_link ?? []).not.toContain('add');
    expect(TIER3_SUPERVISED_ACTIONS.manage_policy_feature_link ?? []).not.toContain('add');
  });

  it('manage_policy_feature_link resolves supervised for maintenance on both add and update', () => {
    expect(resolveApprovalScope('manage_policy_feature_link', 'add', { featureType: 'maintenance' })).toBe('supervised');
    expect(resolveApprovalScope('manage_policy_feature_link', 'update', { featureType: 'maintenance' })).toBe('supervised');
    // remove keeps reaching supervised via the STATIC table, unchanged.
    expect(resolveApprovalScope('manage_policy_feature_link', 'remove', {})).toBe('supervised');
  });

  it('checkGuardrails surfaces the input-aware escalation on both branches', () => {
    const maintenance = checkGuardrails('manage_policy_feature_link', { action: 'add', featureType: 'maintenance' });
    expect(maintenance.tier).toBe(3);
    expect(maintenance.approvalScope).toBe('supervised');
    const patch = checkGuardrails('manage_policy_feature_link', { action: 'add', featureType: 'patch' });
    expect(patch.tier).toBe(2);
    expect(patch.approvalScope).toBeUndefined();
  });
```

- [ ] **Step 3: Write the failing MCP transport test — append to `apps/api/src/routes/mcpServer.approvalGate.test.ts`**

The harness there already authenticates with `X-API-Key` (`:76-90`), so the caller **is** an `api_key` principal, and it uses the REAL `checkGuardrails` (`:127-136`). Add the tool's real action enum beside `REGISTRY_OPERATIONS_SCHEMA` (`:180`):

```ts
const MANAGE_POLICY_FEATURE_LINK_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add', 'update', 'remove', 'list'] },
  },
};
```
then, as a new describe inside `describe('MCP interactive-approval-only gate …')`:

```ts
  // (RMM-QA-176 D9) manage_policy_feature_link — mixed multiplexer, base tier 2,
  // escalated by INPUT content rather than by action name.
  describe('manage_policy_feature_link — maintenance links escalate by input', () => {
    beforeEach(() => {
      mocks.getToolDefinitions.mockReturnValue([
        { name: 'manage_policy_feature_link', description: 'Manage feature links.', input_schema: MANAGE_POLICY_FEATURE_LINK_SCHEMA },
      ]);
      mocks.getToolTier.mockImplementation((name: string) => (name === 'manage_policy_feature_link' ? 2 : undefined));
    });

    it('add of a MAINTENANCE link is denied MCP_APPROVAL_REQUIRED without executing', async () => {
      const res = await callTool('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType: 'maintenance',
        inlineSettings: { recurrence: 'weekly', durationHours: 2 },
      });
      const body = await res.json();
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('update of a MAINTENANCE link is denied the same way', async () => {
      const res = await callTool('manage_policy_feature_link', {
        action: 'update', configPolicyId: 'p1', featureLinkId: 'l1', featureType: 'maintenance',
        inlineSettings: { durationHours: 8 },
      });
      const body = await res.json();
      expect(JSON.parse(body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });

    it('add of a MONITORING link still executes — this gate is narrow, not a tool ban', async () => {
      const res = await callTool('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType: 'monitoring',
        inlineSettings: { checkIntervalSeconds: 60, watches: [] },
      });
      const body = await res.json();
      expect(body.result.isError).toBeFalsy();
      expect(mocks.executeTool).toHaveBeenCalled();
    });

    it('the denial does not depend on MFA at all — the caller carries token:{} and no MFA gate runs on this transport', async () => {
      // mcpServer.ts builds api_key/oauth_grant contexts with token:{} (:2246),
      // so hasSatisfiedMfa would return true for them on an ENABLE_2FA=false
      // deployment. The MCP denial is the EFFECTIVE-TIER gate (:1194-1206),
      // which never consults MFA — asserted here by the fact that the deny
      // above happens with no MFA state configured anywhere in this harness.
      const res = await callTool('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType: 'maintenance',
      }, ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin']);
      const body = await res.json();
      expect(JSON.parse(body.result.content[0].text).code).toBe('MCP_APPROVAL_REQUIRED');
      expect(mocks.executeTool).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 4: Write the failing handler tests — append to `apps/api/src/services/aiToolsConfigPolicy.test.ts`**

`makeAuth()` in that file (`:90-99`) has **no `principal` field**. That is load-bearing twice over: (a) the new handler code must read `auth.principal?.kind`, never `auth.principal.kind`, or every pre-existing case in the file turns into a `safeHandler`-wrapped `GENERIC_TOOL_ERROR_MESSAGE`; (b) the new cases must pass a principal explicitly. Extend the helper rather than editing the existing one:

```ts
/** makeAuth() has no `principal` (a user-session context in all pre-existing
 *  cases). These build the machine-principal shapes mcpServer.ts:2244-2250
 *  constructs — note `token: {}`, which is what makes hasSatisfiedMfa unsafe
 *  as a denial for them. */
function makeMachineAuth(kind: 'api_key' | 'oauth_grant') {
  return { ...makeAuth(), principal: { kind, apiKeyId: 'key-1' }, token: {} } as any;
}
function makeUserAuth() {
  return { ...makeAuth(), principal: { kind: 'user_session' }, token: { mfa: true } } as any;
}
function makeAgentAuth() {
  return { ...makeAuth(), principal: { kind: 'ai_agent', agentId: 'a1', runId: 'r1' }, token: {} } as any;
}
```

```ts
describe('manage_policy_feature_link machine-principal denial (RMM-QA-176 D9.3)', () => {
  const MAINTENANCE_SETTINGS = { recurrence: 'weekly', durationHours: 2, timezone: 'UTC' };

  function toolsWithPolicy() {
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Org policy' } as any);
    const tools = new Map<string, any>();
    registerConfigPolicyTools(tools);
    return tools;
  }

  it('denies an api_key principal adding a maintenance link, before any service call', async () => {
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED);
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('denies an oauth_grant principal updating an existing maintenance link', async () => {
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
      featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeMachineAuth('oauth_grant'));

    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('DENIES a machine principal even where hasSatisfiedMfa would PASS it (ENABLE_2FA=false)', async () => {
    // The trap this closes, stated as two assertions in one test: with 2FA off,
    // hasSatisfiedMfa returns true for ANY context (middleware/auth.ts:884-887)
    // and machine contexts carry token:{} (mcpServer.ts:2246) — so an MFA-based
    // denial would ADMIT them. The denial must be principal-based.
    enable2faState.value = false;
    const auth = makeMachineAuth('api_key');
    const { hasSatisfiedMfa } = await import('../middleware/auth');
    expect(hasSatisfiedMfa(auth)).toBe(true);           // the MFA gate would let it through
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, auth);
    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED); // the principal gate does not
    expect(vi.mocked(addFeatureLink)).not.toHaveBeenCalled();
  });

  it('anti-bypass: a user_session update of a maintenance link WITHOUT featureType is refused with an actionable error', async () => {
    // `update` does not require featureType, so a caller could edit a
    // maintenance link while presenting an input the guardrail hook cannot see
    // as maintenance — auto-executing at tier 2. The handler resolves the
    // EXISTING link's type unconditionally and refuses, telling the caller how
    // to re-issue so the change routes through approval.
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeUserAuth());

    expect(JSON.parse(output).error).toBe(MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED);
    expect(vi.mocked(updateFeatureLink)).not.toHaveBeenCalled();
  });

  it('the same update WITH featureType: maintenance proceeds (it was routed through approval)', async () => {
    const tools = toolsWithPolicy();
    mockSelectRows([{ featureType: 'maintenance' }]);
    vi.mocked(updateFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);
    const output = await tools.get('manage_policy_feature_link')!.handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
      featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeUserAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(updateFeatureLink)).toHaveBeenCalled();
  });

  it('an ai_agent principal PROCEEDS — approval is upstream, the handler must not hard-deny', async () => {
    // Inside the web app an escalated call is a normal supervised approval; an
    // APPROVED run reaching this handler must execute. Hard-denying here would
    // break the approval workflow the escalation exists to create.
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'maintenance' } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'maintenance', inlineSettings: MAINTENANCE_SETTINGS,
    }, makeAgentAuth());

    expect(JSON.parse(output).success).toBe(true);
    expect(vi.mocked(addFeatureLink)).toHaveBeenCalled();
  });

  it('an api_key principal is NOT denied for a non-maintenance link', async () => {
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1', featureType: 'monitoring' } as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'add', configPolicyId: POLICY_ID, featureType: 'monitoring',
      inlineSettings: { checkIntervalSeconds: 60, watches: [] },
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).success).toBe(true);
  });

  it('remove is untouched — it is already Tier 3 and ending suppression is the safe direction', async () => {
    vi.mocked(removeFeatureLink).mockResolvedValue(true as any);
    const output = await toolsWithPolicy().get('manage_policy_feature_link')!.handler({
      action: 'remove', configPolicyId: POLICY_ID, featureLinkId: 'link-1',
    }, makeMachineAuth('api_key'));

    expect(JSON.parse(output).success).toBe(true);
  });
});
```

Add the `ENABLE_2FA` getter box to the top of `aiToolsConfigPolicy.test.ts` (same pattern Task 2 added to `commands.test.ts`, precedent `routes/auth/login.test.ts:271-280`), reset to `true` in the file's `beforeEach`, and add `removeFeatureLink` and the two error-string constants to its imports.

*Contingency (only if the file fails on MODULE LOAD after the `await import('../middleware/auth')` line):* `middleware/auth` pulls `services/jwt`, `services/permissions`, `services/tokenRevocation`, `services/tenantStatus`, `services/mfaPolicy`, `services/sentry`, `services/auditEvents`, and this suite's `../db` mock exposes only `select`. If one of those has an import-time `db` touch, add the narrowest stub for that ONE module and note it in the commit message — do not delete the `hasSatisfiedMfa` assertion, which is half the proof.

- [ ] **Step 5: Run all four suites and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run \
  src/services/aiGuardrails.test.ts \
  src/services/aiGuardrails.approvalScope.contract.test.ts \
  src/services/aiToolsConfigPolicy.test.ts \
  src/routes/mcpServer.approvalGate.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T16-T18-ai-path.txt" | tail -60
```
Expected:
- guardrails: `expected 2 … received 3` inverted — i.e. `expected 3, received 2` on both maintenance cases; `approvalScope` `undefined`;
- contract: `TIER3_INPUT_AWARE_ACTIONS.has('manage_policy_feature_link:add')` → `false`;
- MCP: the maintenance add/update calls **execute** — `expect(mocks.executeTool).not.toHaveBeenCalled()` fails, and `body.result.isError` is falsy. **This is the finding: an API key adding a monitoring-suppression window over MCP with no approval.** Paste that line into the commit message;
- handler: `MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED` is not exported (import error).

- [ ] **Step 6: Implement the guardrail half — `apps/api/src/services/aiGuardrails.ts`**

At `:452`, extend the set:
```ts
export const TIER3_INPUT_AWARE_ACTIONS: ReadonlySet<string> = new Set<string>([
  'manage_organizations:update_org',
  // RMM-QA-176 D9: a 'maintenance' feature link is the canonical
  // monitoring-suppression source, so authoring one is a different class of
  // act from authoring any other link — but only the INPUT says which it is,
  // so it cannot be classified by (tool, action) in the static tables.
  'manage_policy_feature_link:add',
  'manage_policy_feature_link:update',
]);

/**
 * True when a (tool, action, input) triple escalates to Tier 3 on argument
 * CONTENT. Exported so checkGuardrails, resolveApprovalScope and the tests all
 * ask the SAME question — a second copy of this predicate is how a tier and
 * its scope drift apart.
 *
 * Strict `=== 'maintenance'`: a non-string featureType stays at the base tier,
 * which is safe here because the handler writes exactly the featureType it was
 * given, so a value that is not the literal 'maintenance' cannot create a
 * maintenance link either. The handler's own principal check (D9.3) is the
 * belt to this brace for `update`, where featureType is not a required input.
 */
export function isInputAwareTier3(
  toolName: string,
  action: string | undefined,
  input: Record<string, unknown>,
): boolean {
  return (
    toolName === 'manage_policy_feature_link' &&
    (action === 'add' || action === 'update') &&
    input.featureType === 'maintenance'
  );
}
```

In `resolveApprovalScope` (`:466`), add a third override beside the existing two, **before** the static-table lookups:
```ts
  if (isInputAwareTier3(toolName, action, input)) {
    // `supervised`, matching the #3552/835f7eb3d policy-prerequisite
    // escalations and manage_configuration_policy's own create/update/delete —
    // authoring policy configuration, not an externally binding act.
    return 'supervised';
  }
```
Guarding it with the same predicate is what keeps a non-maintenance `add` from ever reaching the override.

In `checkGuardrails` (`:1251`), insert **after** the `TIER1_ACTIONS` downgrade block (which ends at `:1287`) and **before** the `TIER3_ACTIONS` block at `:1289`:
```ts
  // Input-aware Tier-3 escalation (RMM-QA-176 D9). After the Tier-1 downgrade
  // so a read action can never be escalated by a stray argument; before
  // TIER3_ACTIONS and TIER2_ACTIONS so the base tier 2 cannot claim it first.
  if (isInputAwareTier3(toolName, action, input)) {
    return {
      tier: 3,
      allowed: true,
      requiresApproval: true,
      approvalScope: resolveApprovalScope(toolName, action, input),
      description: buildApprovalDescription(toolName, action, input),
    };
  }
```

In `buildApprovalDescription` (`:1919`), add a case beside `apply_configuration_policy` (`:2068`):
```ts
    case 'manage_policy_feature_link':
      parts.push(`${action?.toUpperCase()} ${String(input.featureType ?? 'feature')} link`);
      parts.push(`on config policy ${(input.configPolicyId as string)?.slice(0, 8) ?? 'unknown'}...`);
      break;
```

- [ ] **Step 7: Implement the handler half — `apps/api/src/services/aiToolsConfigPolicy.ts:751-845`**

Add above `registerConfigPolicyTools` (module scope), exported so the tests name the strings rather than duplicating them:
```ts
/** RMM-QA-176 D9.3. Exported so the tests assert the SAME string the handler returns. */
export const MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED =
  'Authoring a maintenance feature link suppresses monitoring and requires an interactive user session. API-key and OAuth-grant callers cannot perform this action.';
export const MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED =
  'This feature link is a maintenance link. Re-issue the call with featureType: "maintenance" so the change routes through approval.';
```

Inside the handler, restructure the `update` branch so the existing-link lookup runs **unconditionally** rather than only inside `if (input.inlineSettings !== undefined)` (today at `:816-823`), and add the two checks. Concretely, after the partner-wide capability gate (`:768-770`) and before `if (action === 'add')` (`:772`):

```ts
      // RMM-QA-176 D9.3. Belt-and-braces to the input-aware tier escalation,
      // and the ANTI-BYPASS for `update`: featureType is not a required input
      // there, so a call that omits it would present nothing the guardrail hook
      // can recognise as maintenance and would auto-execute at tier 2. Resolve
      // the EXISTING link's type unconditionally (one indexed lookup) and make
      // the omission an actionable refusal, not a silent write.
      let existingFeatureType: string | undefined;
      if (action === 'update') {
        const featureLinkId = input.featureLinkId as string | undefined;
        if (!featureLinkId) return JSON.stringify({ error: 'featureLinkId is required for update' });
        const [existingLink] = await db
          .select({ featureType: configPolicyFeatureLinks.featureType })
          .from(configPolicyFeatureLinks)
          .where(and(eq(configPolicyFeatureLinks.id, featureLinkId), eq(configPolicyFeatureLinks.configPolicyId, configPolicyId)))
          .limit(1);
        existingFeatureType = existingLink?.featureType as string | undefined;
      }

      const touchesMaintenance =
        (action === 'add' && input.featureType === 'maintenance') ||
        (action === 'update' && existingFeatureType === 'maintenance');

      if (touchesMaintenance) {
        // `?.` deliberately: pre-existing callers in this file's tests build an
        // auth context with no `principal` at all, and a hard read would turn
        // every one of them into a generic tool error.
        const principalKind = auth.principal?.kind;
        if (principalKind === 'api_key' || principalKind === 'oauth_grant') {
          // NOT an MFA check. Machine contexts carry token:{} (mcpServer.ts:2246)
          // and hasSatisfiedMfa passes ANY context when ENABLE_2FA is off
          // (middleware/auth.ts:884-887), so an MFA-based denial would admit
          // exactly the callers this refuses. `ai_agent` is deliberately NOT
          // here: an approved agent run must proceed (approval is upstream).
          return JSON.stringify({ error: MAINTENANCE_LINK_MACHINE_PRINCIPAL_DENIED });
        }
        if (action === 'update' && input.featureType !== 'maintenance') {
          return JSON.stringify({ error: MAINTENANCE_LINK_FEATURE_TYPE_REQUIRED });
        }
      }
```
Then, in the existing `update` branch, reuse `existingFeatureType` for the `validateInlineSettingsForFeature(existingFeatureType, inlineSettings)` call and delete the now-duplicate inline `db.select` at `:818-823`. The `featureLinkId` guard at `:809` becomes redundant for `update` and can stay (harmless) or be removed — either is fine, but the suite must stay green.

`remove` is untouched.

- [ ] **Step 8: GREEN + typecheck + the parity suites**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/aiGuardrails.test.ts \
  src/services/aiGuardrails.approvalScope.contract.test.ts \
  src/services/aiGuardrails.readonly.contract.test.ts \
  src/services/aiGuardrails.agentPrincipal.contract.test.ts \
  src/services/aiGuardrails.enforcementArming.contract.test.ts \
  src/services/aiGuardrailsTierConfig.parity.test.ts \
  src/services/aiGuardrailsAiDocs.parity.test.ts \
  src/services/aiToolsConfigPolicy.test.ts \
  src/routes/mcpServer.approvalGate.test.ts \
  src/routes/mcpServer.effectiveTier.test.ts 2>&1 | tail -30
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass. The two parity mirrors (`apps/web/src/components/ai-risk/tierConfig.ts`, `apps/docs/.../features/ai.mdx`) do not mention `manage_policy_feature_link` — verified by grep, zero hits — so an input-aware escalation of it trips neither suite. **If either parity suite goes red, stop:** it means the mirror now enumerates the tool and the fix is to update the mirror, not to weaken the escalation.

- [ ] **Step 9: Mutation controls**

  1. In `isInputAwareTier3`, drop the `input.featureType === 'maintenance'` clause (escalate every add/update). Expected: "leaves every OTHER feature type at the tool base tier 2" fails AND the MCP "monitoring still executes" case fails — the both-branches proof the contract test demands for an input-aware pair. Revert `git checkout -- apps/api/src/services/aiGuardrails.ts`; re-run green.
  2. In `checkGuardrails`, move the input-aware block **after** the `TIER2_ACTIONS` check. Expected: no change (the tool has no TIER2_ACTIONS entry) — record the non-movement, then move it **before** the `TIER1_ACTIONS` downgrade instead. Expected: no test moves either, because no `list` case carries a `featureType` — record this as a *gap the tests do not cover* and add a case asserting `checkGuardrails('manage_policy_feature_link', { action: 'list', featureType: 'maintenance' }).tier === 2` so ordering is pinned. Revert; re-run green with the added case.
  3. In `resolveApprovalScope`, return `'four_eyes'` from the new override. Expected: both `approvalScope` assertions fail. Revert; re-run green.
  4. In the handler, change the principal check to `if (!hasSatisfiedMfa(auth))`. Expected: the `ENABLE_2FA=false` test fails (the machine principal is admitted) — **the executed proof that MFA is the wrong denial for this caller**. Revert `git checkout -- apps/api/src/services/aiToolsConfigPolicy.ts`; re-run green.
  5. In the handler, add `'ai_agent'` to the denied kinds. Expected: "an ai_agent principal PROCEEDS" fails. Revert; re-run green.
  6. In the handler, move the existing-link lookup back inside `if (input.inlineSettings !== undefined)`. Expected: the anti-bypass test fails for a call that carries only `featurePolicyId`. Revert; re-run green.
  7. Change `auth.principal?.kind` to `auth.principal.kind`. Expected: many pre-existing `manage_policy_feature_link` cases fail with `GENERIC_TOOL_ERROR_MESSAGE` — the proof that the optional chain is load-bearing, not decoration. Revert; re-run green.

  Record all seven, including mutation 2's two non-movements and the case added to close that gap.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts \
        apps/api/src/services/aiGuardrails.test.ts \
        apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts \
        apps/api/src/services/aiToolsConfigPolicy.ts \
        apps/api/src/services/aiToolsConfigPolicy.test.ts \
        apps/api/src/routes/mcpServer.approvalGate.test.ts
git commit -m "fix(ai): escalate maintenance feature links to Tier 3 and deny machine principals (RMM-QA-176 D9)

manage_policy_feature_link is base Tier 2 and only 'remove' escalated
(TIER3_ACTIONS :209), so 'tools/call manage_policy_feature_link
{action:add, featureType:maintenance}' over an API key AUTO-EXECUTED — an
unattended caller authoring the monitoring suppression the device route and the
HTTP feature-link route were just gated for.

Escalation uses the EXISTING input-aware mechanism rather than a new one:
isInputAwareTier3 + TIER3_INPUT_AWARE_ACTIONS + a resolveApprovalScope override,
the same shape manage_organizations:update_org already uses, including its
contract-test exemption and its both-branches test requirement. Scope is
'supervised', matching manage_configuration_policy's own create/update/delete.
Over MCP that is automatically a fail-closed MCP_APPROVAL_REQUIRED before
executeTool; inside the web app it is a normal supervised approval, so an
APPROVED ai_agent run still proceeds (the handler must not hard-deny it).

The handler adds the belt: it resolves the existing link's featureType
unconditionally (an update that omits featureType would otherwise present
nothing the guardrail hook can see as maintenance) and denies api_key /
oauth_grant principals outright.

That denial is deliberately NOT the MFA gate. Machine contexts carry token:{}
(mcpServer.ts:2246) and hasSatisfiedMfa returns true for ANY context when
ENABLE_2FA is off (middleware/auth.ts:884-887), so an MFA-based denial would
ADMIT them. One test asserts both halves in the same case: with ENABLE_2FA
false, hasSatisfiedMfa(auth) === true AND the handler still denies. Mutation 4
(swapping the principal check for hasSatisfiedMfa) turns that test red.

RED (before): <paste from T16-T18-ai-path.txt — the MCP line where the
maintenance add EXECUTED, plus the tier 'expected 3, received 2' lines>
Mutation control: <paste the seven observed outcomes from Step 9>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---
### Task 12: D10 — the web: a reusable step-up mint, a reason/duration dialog, and one bulk call

The client half. Three separable pieces, landed as one task because none of them is independently shippable: extracting the mint helper without a consumer is dead code, and the dialog without the helper duplicates the store's ceremony.

Verified call sites (re-read):

| Site | Line (verified) | Today |
|---|---|---|
| `apps/web/src/services/deviceActions.ts` | `:537-556` | `toggleMaintenanceMode(deviceId, enable, durationHours?)` — sends `{ enable }` or `{ enable, durationHours }`, no reason, no grant |
| `apps/web/src/components/devices/DeviceDetailPage.tsx` | `:295-303` | `case "maintenance"` decides enter/exit from `device.status === "maintenance"` |
| `apps/web/src/components/devices/DevicesPage.tsx` | `:854-863` | same, single-row action |
| `apps/web/src/components/devices/DevicesPage.tsx` | `:1159-1191` | `maintenance-on` / `maintenance-off` — a **client loop of N single-device calls** with per-device try/catch |
| `apps/web/src/components/devices/DeviceActions.tsx` | `:158-175` | `case "maintenance"` returns `ConfirmDialog` copy for enter and exit |
| `apps/web/src/stores/authenticator.ts` | `:70-118` (`mintRegisterGrant`; the TOTP/passkey branches begin at `:88`) | the only existing step-up mint |
| `apps/web/src/components/settings/StepUpPrompt.tsx` | `:8` | `pickReauthTier(passkeyCount, mfaMethod): 'passkey' \| 'totp' \| 'password'` |

**Server-driven step-up, restated because it is the load-bearing choice:** the dialog submits **without** a grant. A `403 { code: 'STEP_UP_REQUIRED' }` is what reveals the factor step. The web never reads `ENABLE_2FA` — a 2FA-off deployment simply succeeds on the first submit, and the server stays the only enforcer. A client that decided for itself whether a factor was needed would be a second, weaker copy of the gate.

**Files:**
- Create: `apps/web/src/lib/mfaStepUp.ts`, `apps/web/src/lib/mfaStepUp.test.ts`
- Modify: `apps/web/src/stores/authenticator.ts:88-118` (delegate the TOTP/passkey branches)
- Modify: `apps/web/src/services/deviceActions.ts:537-556`
- Create: `apps/web/src/components/devices/MaintenanceModeDialog.tsx`, `MaintenanceModeDialog.test.tsx`
- Modify: `apps/web/src/components/devices/DeviceActions.tsx:158-175`, `DeviceDetailPage.tsx:295-303`, `DevicesPage.tsx:854-863` and `:1159-1191`
- Modify: `packages/shared/src/types/index.ts:142-165` (the `Device` interface)
- Modify: `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json`

**Interfaces:**
- Consumes: `POST /devices/:id/maintenance` and `POST /devices/bulk/maintenance` (Tasks 7–8); `operation: 'device_maintenance'` with `resource: { deviceIds, reason, durationHours }` on `POST /auth/mfa/step-up` (Task 4).
- Produces:
  - `export async function mintStepUpGrant(opts: { operation: string; resource?: unknown; reauth: { method: 'totp'; code: string } | { method: 'passkey' } }): Promise<string>` and `export class StepUpMintError extends Error { readonly code: 'invalid_factor' | 'unavailable' }` from `lib/mfaStepUp.ts`
  - `enterMaintenanceMode(deviceId, body)`, `exitMaintenanceMode(deviceId)`, `bulkEnterMaintenanceMode(body)` from `services/deviceActions.ts`; each throws an error carrying `status` and `code`
  - `Device.maintenanceUntil?: string | null`, `maintenanceStartedAt?`, `maintenanceReason?`, `maintenanceStartedBy?` in `@breeze/shared`

- [ ] **Step 1: Write the failing helper test `apps/web/src/lib/mfaStepUp.test.ts`**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { fetchWithAuthMock, startAuthenticationMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  startAuthenticationMock: vi.fn(),
}));

vi.mock('../stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: startAuthenticationMock }));

import { mintStepUpGrant, StepUpMintError } from './mfaStepUp';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('mintStepUpGrant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts a TOTP body carrying the operation and its resource binding', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(ok({ stepUpGrantId: 'grant-1' }));
    const resource = { deviceIds: ['d1'], reason: 'scheduled patching', durationHours: 2 };

    const grant = await mintStepUpGrant({ operation: 'device_maintenance', resource, reauth: { method: 'totp', code: '123456' } });

    expect(grant).toBe('grant-1');
    const [path, init] = fetchWithAuthMock.mock.calls[0];
    expect(path).toBe('/auth/mfa/step-up');
    expect(JSON.parse(init.body)).toEqual({ method: 'totp', code: '123456', operation: 'device_maintenance', resource });
  });

  it('runs the passkey ceremony BEFORE proving it, in order', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(ok({ options: { challenge: 'c' } }))
      .mockResolvedValueOnce(ok({ stepUpGrantId: 'grant-2' }));
    startAuthenticationMock.mockResolvedValueOnce({ id: 'credential-1' });

    const grant = await mintStepUpGrant({ operation: 'device_maintenance', resource: { deviceIds: ['d1'], reason: 'r r r', durationHours: 1 }, reauth: { method: 'passkey' } });

    expect(grant).toBe('grant-2');
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe('/auth/mfa/step-up/options');
    expect(startAuthenticationMock).toHaveBeenCalled();
    expect(JSON.parse(fetchWithAuthMock.mock.calls[1][1].body)).toMatchObject({ method: 'passkey', credential: { id: 'credential-1' } });
  });

  it('never replays the mint on a 401 — a 401 means a bad code, not a stale token', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'Invalid code' }) });

    await expect(mintStepUpGrant({ operation: 'device_maintenance', reauth: { method: 'totp', code: '000000' } }))
      .rejects.toMatchObject({ code: 'invalid_factor' });
    // The store's rationale (authenticator.ts:78-82) applies verbatim: replaying
    // would resubmit the same rejected factor.
    expect(fetchWithAuthMock.mock.calls[0][1].skipUnauthorizedRetry).toBe(true);
  });

  it('maps a 5xx to unavailable, distinctly from a rejected factor', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(mintStepUpGrant({ operation: 'device_maintenance', reauth: { method: 'totp', code: '123456' } }))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('omits `resource` entirely when the operation is not resource-bound', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(ok({ stepUpGrantId: 'grant-3' }));
    await mintStepUpGrant({ operation: 'register_approver_device', reauth: { method: 'totp', code: '123456' } });
    expect(JSON.parse(fetchWithAuthMock.mock.calls[0][1].body)).not.toHaveProperty('resource');
    // The mint route 400s an unbound operation that carries a resource
    // (RESOURCE_BOUND_OPERATIONS, routes/auth/mfa.ts) — sending `resource:
    // undefined` would serialise it away, but an explicit null would not.
  });
});
```

- [ ] **Step 2: Run it and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/web exec vitest run src/lib/mfaStepUp.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T22-mfaStepUp.txt" | tail -20
```
Expected: FAIL — `Failed to resolve import "./mfaStepUp"`.

- [ ] **Step 3: Create `apps/web/src/lib/mfaStepUp.ts` and delegate from the store**

```ts
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { fetchWithAuth } from '../stores/auth';

/**
 * Mint an operation-bound, single-use step-up grant (RMM-QA-176 D10).
 *
 * Extracted verbatim from stores/authenticator.ts's mintRegisterGrant so the
 * maintenance dialog and approver-device registration cannot drift on the
 * ceremony or on skipUnauthorizedRetry. The store's `password` branch stays
 * there: it targets a different endpoint (/authenticator/register-grant) and
 * `password` is not a valid step-up method for a resource-bound operation.
 */
export type StepUpReauth = { method: 'totp'; code: string } | { method: 'passkey' };

export class StepUpMintError extends Error {
  constructor(readonly code: 'invalid_factor' | 'unavailable', message: string) {
    super(message);
    this.name = 'StepUpMintError';
  }
}

async function postOrThrow(path: string, body: unknown, fallback: string): Promise<any> {
  const response = await fetchWithAuth(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // A 401 here means the TOTP code / passkey assertion was rejected (wrong
    // code, or an assertion already burned) — NOT a stale access token.
    // Replaying after a refresh would resubmit the same rejected factor.
    skipUnauthorizedRetry: true,
  });
  if (!response.ok) {
    throw new StepUpMintError(response.status === 401 || response.status === 403 ? 'invalid_factor' : 'unavailable', fallback);
  }
  return response.json();
}

export async function mintStepUpGrant(opts: {
  operation: string;
  resource?: unknown;
  reauth: StepUpReauth;
}): Promise<string> {
  let body: Record<string, unknown>;
  if (opts.reauth.method === 'totp') {
    body = { method: 'totp', code: opts.reauth.code, operation: opts.operation };
  } else {
    const challengeData = await postOrThrow('/auth/mfa/step-up/options', undefined, 'Could not start passkey verification.');
    const optionsJSON: PublicKeyCredentialRequestOptionsJSON =
      challengeData.options ?? challengeData.optionsJSON ?? challengeData;
    const credential = await startAuthentication({ optionsJSON });
    body = { method: 'passkey', credential, operation: opts.operation };
  }
  // Only set when present: the mint route 400s a resource on an operation that
  // is not in RESOURCE_BOUND_OPERATIONS (routes/auth/mfa.ts).
  if (opts.resource !== undefined) body.resource = opts.resource;

  const data = await postOrThrow('/auth/mfa/step-up', body, 'Verification failed.');
  if (!data?.stepUpGrantId) throw new StepUpMintError('unavailable', 'Verification failed.');
  return data.stepUpGrantId;
}
```

Then in `apps/web/src/stores/authenticator.ts`, replace the TOTP/passkey body of `mintRegisterGrant` (`:88-118`) with a delegation, keeping the `password` branch (`:71-86`) and the `stepUpGrantId → registerGrantId` comment exactly as they are:
```ts
  try {
    return await mintStepUpGrant({ operation: 'register_approver_device', reauth });
  } catch (err) {
    // The store's callers branch on RegisterStepError; keep that contract.
    throw new RegisterStepError(err instanceof Error ? err.message : 'Verification failed.');
  }
```
`stores/authenticator.test.ts` is the guard that this refactor changed nothing observable.

- [ ] **Step 4: GREEN on the helper and the store**

```bash
pnpm --filter @breeze/web exec vitest run src/lib/mfaStepUp.test.ts src/stores/authenticator.test.ts 2>&1 | tail -20
```
Expected: both pass; the store suite at its pre-change count. If a store case asserts the raw `fetchWithAuth` call shape and now sees the helper's, adjust the *assertion's location*, not its meaning, and say so in the commit message.

- [ ] **Step 5: Write the failing service + dialog tests**

Append to the existing `apps/web/src/services/deviceActions.test.ts` (verified present). Reuse whatever hoisted `fetchWithAuth` mock that file already declares — the name `fetchWithAuthMock` below is a placeholder for the file's real one; do not add a second mock of the same module.

```ts
describe('maintenance mode services (RMM-QA-176)', () => {
  it('enterMaintenanceMode posts reason, duration and the grant', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, action: 'enable' }) });
    await enterMaintenanceMode('d1', { reason: 'scheduled patching', durationHours: 2, stepUpGrant: 'g1' });
    const [path, init] = fetchWithAuthMock.mock.calls[0];
    expect(path).toBe('/devices/d1/maintenance');
    expect(JSON.parse(init.body)).toEqual({ enable: true, reason: 'scheduled patching', durationHours: 2, stepUpGrant: 'g1' });
  });

  it('enterMaintenanceMode omits stepUpGrant on the FIRST submit (server-driven step-up)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    await enterMaintenanceMode('d1', { reason: 'scheduled patching', durationHours: 2 });
    expect(JSON.parse(fetchWithAuthMock.mock.calls[0][1].body)).not.toHaveProperty('stepUpGrant');
  });

  it('exitMaintenanceMode posts EXACTLY { enable: false } — the route body is strict', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true, changed: true }) });
    await exitMaintenanceMode('d1');
    expect(JSON.parse(fetchWithAuthMock.mock.calls[0][1].body)).toEqual({ enable: false });
  });

  it('surfaces the server code so the dialog can branch on STEP_UP_REQUIRED vs MFA_REQUIRED', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' }) });
    await expect(enterMaintenanceMode('d1', { reason: 'scheduled patching', durationHours: 2 }))
      .rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
  });

  it('bulkEnterMaintenanceMode makes ONE call with every id', async () => {
    fetchWithAuthMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ succeeded: [], failed: [] }) });
    await bulkEnterMaintenanceMode({ deviceIds: ['a', 'b', 'c'], reason: 'scheduled patching', durationHours: 2, stepUpGrant: 'g1' });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock.mock.calls[0][0]).toBe('/devices/bulk/maintenance');
    expect(JSON.parse(fetchWithAuthMock.mock.calls[0][1].body).deviceIds).toEqual(['a', 'b', 'c']);
  });
});
```

Create `apps/web/src/components/devices/MaintenanceModeDialog.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { enterMock, bulkMock, mintMock } = vi.hoisted(() => ({
  enterMock: vi.fn(), bulkMock: vi.fn(), mintMock: vi.fn(),
}));
vi.mock('../../services/deviceActions', () => ({
  enterMaintenanceMode: enterMock,
  bulkEnterMaintenanceMode: bulkMock,
}));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class extends Error {},
}));

import MaintenanceModeDialog from './MaintenanceModeDialog';

const DEVICE = { id: 'd1', hostname: 'host-a' };
const stepUpDenial = Object.assign(new Error('Step-up required'), { status: 403, code: 'STEP_UP_REQUIRED' });

function renderDialog(props: Partial<React.ComponentProps<typeof MaintenanceModeDialog>> = {}) {
  return render(
    <MaintenanceModeDialog open devices={[DEVICE]} onClose={vi.fn()} onCompleted={vi.fn()} {...props} />,
  );
}

describe('MaintenanceModeDialog (RMM-QA-176 D10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('will not submit a reason shorter than the server minimum', async () => {
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'ab');
    expect(screen.getByTestId('maintenance-submit')).toBeDisabled();
  });

  it('submits WITHOUT a grant first, then reveals the factor step on 403 STEP_UP_REQUIRED', async () => {
    enterMock.mockRejectedValueOnce(stepUpDenial);
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(screen.getByTestId('maintenance-stepup-code')).toBeInTheDocument());
    // The client never decides whether a factor is needed — the SERVER did.
    expect(enterMock.mock.calls[0][1]).not.toHaveProperty('stepUpGrant');
  });

  it('mints against the SAME resource it submitted, then resubmits carrying the grant', async () => {
    enterMock.mockRejectedValueOnce(stepUpDenial).mockResolvedValueOnce({ success: true, action: 'enable' });
    mintMock.mockResolvedValueOnce('grant-1');
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));
    await userEvent.type(await screen.findByTestId('maintenance-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(enterMock).toHaveBeenCalledTimes(2));
    // A digest mismatch is indistinguishable from a missing grant (403), so the
    // resource MUST be byte-identical to the body — asserted, not assumed.
    expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'device_maintenance',
      resource: expect.objectContaining({ deviceIds: ['d1'], reason: 'scheduled patching' }),
    }));
    expect(enterMock.mock.calls[1][1]).toMatchObject({ stepUpGrant: 'grant-1' });
  });

  it('shows the MFA copy, not the factor step, on 403 MFA_REQUIRED', async () => {
    enterMock.mockRejectedValueOnce(Object.assign(new Error('MFA required'), { status: 403, code: 'MFA_REQUIRED' }));
    renderDialog();
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));
    await waitFor(() => expect(screen.getByText(/complete mfa sign-in/i)).toBeInTheDocument());
    expect(screen.queryByTestId('maintenance-stepup-code')).not.toBeInTheDocument();
  });

  it('a password-only account gets the add-an-authenticator state and NO submit button', () => {
    // pickReauthTier returns 'password' for SMS-only/password-only accounts, and
    // there is no authenticated step-up SMS sender — so the dialog says so
    // instead of offering a submit that can only 403.
    renderDialog({ passkeyCount: 0, mfaMethod: 'sms' });
    expect(screen.getByText(/authenticator app or passkey/i)).toBeInTheDocument();
    expect(screen.queryByTestId('maintenance-submit')).not.toBeInTheDocument();
  });

  it('the bulk variant makes ONE call carrying every id', async () => {
    bulkMock.mockResolvedValueOnce({ succeeded: [{ deviceId: 'd1' }, { deviceId: 'd2' }], failed: [] });
    renderDialog({ devices: [DEVICE, { id: 'd2', hostname: 'host-b' }] });
    await userEvent.type(screen.getByTestId('maintenance-reason'), 'scheduled patching');
    await userEvent.click(screen.getByTestId('maintenance-submit'));

    await waitFor(() => expect(bulkMock).toHaveBeenCalledTimes(1));
    expect(bulkMock.mock.calls[0][0].deviceIds).toEqual(['d1', 'd2']);
    expect(enterMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run and capture the RED**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/web exec vitest run \
  src/components/devices/MaintenanceModeDialog.test.tsx \
  src/services/deviceActions.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/T21-web-dialog.txt" | tail -40
```
Expected: `Failed to resolve import "./MaintenanceModeDialog"` and `enterMaintenanceMode is not a function`.

- [ ] **Step 7: Implement the services — `apps/web/src/services/deviceActions.ts:537-556`**

Replace `toggleMaintenanceMode` (it has no other consumers once Step 9 lands — verify with `grep -rn "toggleMaintenanceMode" apps/web/src`):
```ts
/** Error carrying the server's coded 403 so the dialog can branch. */
export class MaintenanceActionError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'MaintenanceActionError';
  }
}

async function maintenanceRequest(path: string, body: unknown): Promise<any> {
  const response = await fetchWithAuth(path, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) {
    const parsed = await response.json().catch(() => null);
    throw new MaintenanceActionError(
      (parsed as { error?: string } | null)?.error ?? 'Failed to update maintenance mode',
      response.status,
      (parsed as { code?: string } | null)?.code,
    );
  }
  const data = await response.json();
  return data.data ?? data;
}

/**
 * Enter or EXTEND maintenance. `stepUpGrant` is deliberately optional and
 * omitted on the first submit: the SERVER decides whether a factor is required
 * (403 STEP_UP_REQUIRED), so a 2FA-off deployment never prompts and the client
 * can never decide it does not need one.
 */
export async function enterMaintenanceMode(
  deviceId: string,
  body: { reason: string; durationHours: number; stepUpGrant?: string },
): Promise<any> {
  return maintenanceRequest(`/devices/${deviceId}/maintenance`, { enable: true, ...body });
}

/** Exit. The route's exit branch is `.strict()` — send exactly this. */
export async function exitMaintenanceMode(deviceId: string): Promise<any> {
  return maintenanceRequest(`/devices/${deviceId}/maintenance`, { enable: false });
}

/** One server-side operation under ONE grant — replaces the N-call client loop. */
export async function bulkEnterMaintenanceMode(
  body: { deviceIds: string[]; reason: string; durationHours: number; stepUpGrant?: string },
): Promise<{ succeeded: Array<{ deviceId: string; action: string; maintenanceUntil: string }>; failed: Array<{ deviceId: string; code: string; message: string }> }> {
  return maintenanceRequest('/devices/bulk/maintenance', body);
}
```
`deviceActions.ts` already holds a `RUN_ACTION_ALLOWLIST` row (`lib/runActionAllowlist.ts:4`), so these typed service functions introduce no new silent-mutation path; the calling components keep whatever feedback pattern they already use.

- [ ] **Step 8: Implement `apps/web/src/components/devices/MaintenanceModeDialog.tsx`**

Follow the surrounding devices components for shell/styling (`ConfirmDialog` in `components/shared/ConfirmDialog.tsx` is the modal precedent) and `StepUpPrompt.tsx` for the factor input. Contract:

- Props: `{ open: boolean; devices: Array<{ id: string; hostname: string }>; passkeyCount?: number; mfaMethod?: string | null; onClose: () => void; onCompleted: (result: unknown) => void }`
- States: `form → stepUp → submitting`.
- `data-testid`s exactly: `maintenance-reason`, `maintenance-duration`, `maintenance-stepup-code`, `maintenance-submit`.
- Reason: textarea, trimmed length 3..500, submit disabled below 3 — mirrors `maintenanceReasonSchema`.
- Duration: select of `1, 2, 4, 8, 24, 72, 168` hours. **Copy must say "extend by N hours from now", not "add N hours"** — the server re-leases from `now` (D6), and UI copy that implies compounding would be a lie about the operation.
- Submit: `devices.length === 1 ? enterMaintenanceMode(devices[0].id, body) : bulkEnterMaintenanceMode({ deviceIds: devices.map(d => d.id), ...body })`, **without** `stepUpGrant`.
- On `403 STEP_UP_REQUIRED`: switch to `stepUp`, render the factor input for `pickReauthTier(passkeyCount ?? 0, mfaMethod ?? null)` restricted to `passkey | totp`; on resubmit call `mintStepUpGrant({ operation: 'device_maintenance', resource: { deviceIds: devices.map(d => d.id), reason, durationHours }, reauth })` and retry the SAME call with the grant. The `resource` must be built from the same values as the body — a mismatch is a 403 the user cannot diagnose.
- On `403 MFA_REQUIRED`: show the "Complete MFA sign-in first" copy (pattern: `components/settings/OrganizationsPage.tsx:575`), and do **not** reveal the factor step.
- On `409 MAINTENANCE_STATE_CONFLICT`: surface the server's message verbatim.
- `pickReauthTier(...) === 'password'`: render the "add an authenticator app or passkey" state and **no submit button** — there is no authenticated step-up SMS sender, so a submit could only ever 403.

Import `pickReauthTier` from `../settings/StepUpPrompt` (already exported there, `:8`); do not re-derive the tiering.

- [ ] **Step 9: Wire the three call sites**

`DeviceActions.tsx:158-175` — keep the exit `ConfirmDialog` branch verbatim; the enter branch no longer returns confirm copy but signals the parent to open the dialog. In-maintenance predicate, used identically in all three files:
```ts
const inMaintenance = (d: { status: string; maintenanceUntil?: string | null }) =>
  d.status === 'maintenance' || (d.maintenanceUntil != null && new Date(d.maintenanceUntil).getTime() > Date.now());
```

`DeviceDetailPage.tsx:295-303` and `DevicesPage.tsx:854-863` — `case 'maintenance'`: if `inMaintenance(device)` call `exitMaintenanceMode(device.id)` and keep the existing success toast; else open `MaintenanceModeDialog` with `devices={[device]}` and refresh in `onCompleted`.

`DevicesPage.tsx:1159-1191` — split the fused case:
- `maintenance-off` keeps the loop, calling `exitMaintenanceMode(device.id)`;
- `maintenance-on` opens the dialog with all `selectedDevices` and, on completion, reports through the **existing** `bulkMaintenance*` toast keys (`bulkMaintenanceSuccess` / `bulkMaintenanceAllFailed` / `bulkMaintenanceSomeFailed`) fed from the response's `succeeded.length` / `failed`, so no new copy is needed for the outcome path.

Add the four optional fields to `packages/shared/src/types/index.ts` inside `export interface Device {` (`:142`), after `updatedAt`:
```ts
  // RMM-QA-176 manual maintenance lease. Serialised from the API as ISO
  // strings. `maintenanceUntil > now` — not `status` — is the truth of "a
  // technician put this device into maintenance": the heartbeat overwrites
  // status on every beat.
  maintenanceStartedAt?: string | null;
  maintenanceUntil?: string | null;
  maintenanceReason?: string | null;
  maintenanceStartedBy?: string | null;
```

Add the dialog and error copy to **all eight** locale files (`de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`) under `devices.json` — `localeParity.test.ts` fails on any key present in one locale and missing in another, and it also compares interpolation tokens, so `{{hostname}}`-style placeholders must match across files.

- [ ] **Step 10: GREEN — the touched web suites, typecheck, lint**

```bash
pnpm --filter @breeze/web exec vitest run \
  src/lib/mfaStepUp.test.ts \
  src/stores/authenticator.test.ts \
  src/services/deviceActions.test.ts \
  src/components/devices/MaintenanceModeDialog.test.tsx \
  src/components/devices/DeviceActions.test.tsx \
  src/components/devices/DevicesPage.test.tsx \
  src/components/devices/DeviceDetailPage.scriptAdmission.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/__tests__/no-silent-mutations.test.ts 2>&1 | tail -30
pnpm --filter @breeze/web exec tsc --noEmit
pnpm --filter @breeze/web exec eslint \
  src/lib/mfaStepUp.ts src/stores/authenticator.ts src/services/deviceActions.ts \
  src/components/devices/MaintenanceModeDialog.tsx src/components/devices/DeviceActions.tsx \
  src/components/devices/DeviceDetailPage.tsx src/components/devices/DevicesPage.tsx
```
Expected: all pass; tsc and eslint exit 0.

**`DevicesPage.test.tsx` has four `toggleMaintenanceMode` cases that FLIP here** (verified: `:42` mock entry, `:653-664`, `:675-689`, `:698-722`, `:1936-1944`). They assert the N-call loop — `expect(toggleMaintenanceMode).toHaveBeenCalledTimes(3)`, the targeted-id list, and the per-device failure summary. Replace, do not delete:
- the `maintenance-on` cases become "calls `bulkEnterMaintenanceMode` **once** with all three ids" and "renders the summary toast from the response's `failed[]`" — the same intent, now asserting the server-side operation;
- the `:698-722` case (`expect(toggleMaintenanceMode).not.toHaveBeenCalled()` — the asset-id guard) becomes `expect(bulkEnterMaintenanceMode).not.toHaveBeenCalled()`, unchanged in meaning;
- the `maintenance-off` cases keep their loop shape against `exitMaintenanceMode`.
Record each flip and its replacement in the commit message.

- [ ] **Step 11: Mutation controls**

  1. In the dialog, send `stepUpGrant` on the FIRST submit (guess a grant from a prior mint). Expected: "submits WITHOUT a grant first" fails. Revert; re-run green.
  2. In the dialog, build the mint `resource` with a different reason (e.g. `reason.trim().toUpperCase()`). Expected: "mints against the SAME resource it submitted" fails — the client-side proof that the digest binding is exact. Revert; re-run green.
  3. In the dialog, reveal the factor step on `MFA_REQUIRED` too. Expected: "shows the MFA copy, not the factor step" fails. Revert; re-run green.
  4. In the dialog, render a submit button in the `password` tier. Expected: "a password-only account gets the add-an-authenticator state and NO submit" fails. Revert; re-run green.
  5. In `mfaStepUp.ts`, drop `skipUnauthorizedRetry: true`. Expected: the 401 test's `skipUnauthorizedRetry` assertion fails. Revert; re-run green.
  6. In `exitMaintenanceMode`, add `durationHours: 0` to the body. Expected: "posts EXACTLY { enable: false }" fails — and note that the SERVER would also 400 it, because the exit branch is `.strict()`. Revert; re-run green.
  7. Restore the bulk client loop in `DevicesPage.tsx` (`for (const device of selectedDevices) await enterMaintenanceMode(...)`). Expected: the "ONE call carrying every id" cases fail. Revert; re-run green.
  8. Delete one added key from `apps/web/src/locales/tr-TR/devices.json`. Expected: `localeParity.test.ts` fails naming that key. Revert; re-run green.

  Record all eight mutations and their observed failure lines.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/lib/mfaStepUp.ts apps/web/src/lib/mfaStepUp.test.ts \
        apps/web/src/stores/authenticator.ts \
        apps/web/src/services/deviceActions.ts apps/web/src/services/deviceActions.test.ts \
        apps/web/src/components/devices/MaintenanceModeDialog.tsx \
        apps/web/src/components/devices/MaintenanceModeDialog.test.tsx \
        apps/web/src/components/devices/DeviceActions.tsx \
        apps/web/src/components/devices/DeviceDetailPage.tsx \
        apps/web/src/components/devices/DevicesPage.tsx \
        apps/web/src/components/devices/DevicesPage.test.tsx \
        packages/shared/src/types/index.ts \
        apps/web/src/locales/de-DE/devices.json apps/web/src/locales/en/devices.json \
        apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-CA/devices.json \
        apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/it-IT/devices.json \
        apps/web/src/locales/pt-BR/devices.json apps/web/src/locales/tr-TR/devices.json
git commit -m "feat(web): maintenance dialog with server-driven step-up and one bulk call (RMM-QA-176 D10)

The client sent { enable } (plus an ignored durationHours), collected no reason
and no factor, and did bulk as an N-single-calls loop. Now:

- lib/mfaStepUp.ts extracts the step-up mint from stores/authenticator.ts so
  the maintenance dialog and approver-device registration share ONE ceremony
  and one skipUnauthorizedRetry rationale; the store's password branch (a
  different endpoint) stays local and its suite guards the refactor.
- MaintenanceModeDialog collects reason + duration and is SERVER-DRIVEN: it
  submits with NO grant, and a 403 STEP_UP_REQUIRED is what reveals the factor
  step. The web never reads ENABLE_2FA, so a 2FA-off deployment simply succeeds
  on the first submit and the server stays the only enforcer. The mint resource
  is built from the same values as the body — a digest mismatch is
  indistinguishable from a missing grant, so it is asserted, not assumed.
- password-tier accounts (SMS-only) get an 'add an authenticator app or
  passkey' state and no submit button rather than a submit that can only 403.
- deviceActions: toggleMaintenanceMode -> enterMaintenanceMode /
  exitMaintenanceMode / bulkEnterMaintenanceMode, each surfacing the server's
  coded 403; exit posts exactly { enable: false } because the route's exit
  branch is strict.
- DevicesPage bulk maintenance-on is ONE call to /devices/bulk/maintenance,
  reusing the existing bulkMaintenance* toast keys for the outcome.
- Duration copy says 'from now', matching D6's state-independent re-lease — UI
  that implied compounding would misdescribe the operation.

Four DevicesPage.test.tsx cases FLIP: they asserted the N-call loop
(toHaveBeenCalledTimes(3) and the targeted-id list). Replaced with the same
intent against the single bulk call; the asset-id guard case is unchanged in
meaning.

RED (before): <paste from T22-mfaStepUp.txt and T21-web-dialog.txt>
Mutation control: <paste the eight observed failures from Step 11>

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 13: the docs note, and the QA-probe flip recorded as evidence

Two small, unrelated-in-code but same-in-purpose jobs: tell an operator what changed, and record — **without editing** — which QA characterizations of the unsafe state now flip.

**Files:**
- Modify: `apps/docs/src/content/docs/features/maintenance-windows.mdx`
- Create (evidence only, NOT committed to this repo): `<SP>/rmm-qa-176-red/T13-qa-probe-flip.txt`

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 7–12.
- Produces: the probe-flip evidence file the PR body (Task 14) quotes.

- [ ] **Step 1: Add the "Manual maintenance mode" section to `apps/docs/src/content/docs/features/maintenance-windows.mdx`**

The page today documents scheduled windows (policy-driven and standalone) and says nothing about the per-device toggle. Add a section after the "Key Concepts" block. Content, and nothing more:

- Manual maintenance mode is a **per-device** action, distinct from the scheduled windows the rest of the page describes.
- Entering **or extending** requires an assured session and a fresh factor (authenticator app or passkey); a technician whose only second factor is SMS must add TOTP or a passkey first.
- A **reason** and a **duration** (1–168 hours) are required and are recorded on the device, with the actor.
- **Extending means "N hours from now"**, not "N hours added to the existing window" — say this explicitly, it is the one behaviour a reader will guess wrong.
- **Exiting needs no factor.** On exit the device's status is recomputed from when it was last seen, so a device that went offline during the window comes back as offline rather than being resurrected as online.
- A device that is quarantined, pending or updating cannot enter maintenance until it settles.
- **State the boundary plainly:** entering manual maintenance mode records and audits the window; it does not yet change which alerts fire or which patches install — that is governed by the configuration-policy maintenance feature and by scheduled windows, as documented above. Do not imply suppression this PR does not deliver (spec §10).

- [ ] **Step 2: Build the docs site to catch MDX/link breakage**

```bash
pnpm --filter @breeze/docs build 2>&1 | tail -20
```
Expected: exits 0. (If the docs package's script name differs, use whatever `apps/docs/package.json` defines for a production build.)

- [ ] **Step 3: Run the QA probes against the branch and record which assertions flip — DO NOT EDIT THEM**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
cd /Users/toddhebebrand/breeze-rmm-qa
# Read-only run against this branch's worktree; the probes read source text.
pnpm exec vitest run \
  docs/qa/probes/core-device-actions-release-contract.test.ts \
  docs/qa/probes/maintenance-window-contract.test.tsx \
  2>&1 | tee "$SP/rmm-qa-176-red/T13-qa-probe-flip.txt" | tail -40
```
Expected flips (each is a characterization of the *unsafe* state that this branch removes — verified against the probe sources):

| Probe | Line | Assertion that flips |
|---|---|---|
| `core-device-actions-release-contract.test.ts` | `:89` | `expect(maintenance).not.toContain("requireMfa()")` — the route now carries an entry-scoped `requireMfa()` |
| same | `:90` | `expect(maintenance).toContain("const targetStatus = data.enable ? 'maintenance' : 'online'")` — that line is gone; status comes from `resolveLivenessStatus` |
| same | `:91` | `expect(maintenance).toContain("durationHours: data.durationHours ?? null")` — the duration is persisted now, not echoed into an audit detail |
| same | `:92` | `expect(maintenance).not.toMatch(/expiresAt\|maintenanceUntil\|setTimeout\|interval/)` — `maintenanceUntil` is now in the handler |
| `maintenance-window-contract.test.tsx` | `:127` | `expect(featureLinkRouteSource).toContain("data.featureType === 'patch' && !hasSatisfiedMfa(auth)")` — replaced by `MFA_GATED_FEATURE_TYPES.has(...)` |

Two things NOT expected to flip, worth recording as such because they are the boundary this PR keeps: the `heartbeat` assertions at `:94-96` (RMM-QA-217 — the heartbeat still writes `status: 'online'`), and `maintenance-window-contract.test.tsx:128`'s `not.toContain("data.featureType === 'maintenance' && !hasSatisfiedMfa(auth)")`, which stays green because the fix uses a `Set` rather than a second literal comparison.

**Updating these probes is the QA repo's job, not this branch's.** Do not stage, edit or commit anything under `/Users/toddhebebrand/breeze-rmm-qa`. The recorded output goes in the PR body as evidence.

- [ ] **Step 4: Commit the docs note**

```bash
cd /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-176
git add apps/docs/src/content/docs/features/maintenance-windows.mdx
git commit -m "docs(maintenance): document manual maintenance mode and its boundary (RMM-QA-176)

The page documented scheduled windows only. Adds the per-device manual mode:
reason and duration required, a fresh factor for entry AND extension, exit
un-gated, extension meaning 'N hours from now' rather than compounding, exit
recomputing status from last-seen, and the entry-state restriction.

States the boundary rather than overclaiming: entering manual maintenance
records and audits a window; it does not yet change which alerts fire or which
patches install. That is RMM-QA-217.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011ZcfdKzt7p6NSWkqPgv54c"
```

---

### Task 14: full verification battery, stack teardown, push, DRAFT PR

Nothing new is written here. This is the run that decides whether the branch is honest.

**Files:**
- No source changes. Evidence under `<SP>/rmm-qa-176-red/`; a draft PR on GitHub.

**Interfaces:**
- Consumes: every commit from Tasks 1–13.
- Produces: `<SP>/rmm-qa-176-red/99-battery.txt`, a pushed branch, and a **draft** PR.

- [ ] **Step 1: Full API typecheck and lint on every touched file**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/api exec eslint \
  src/services/deviceLiveness.ts src/services/deviceMaintenanceLease.ts \
  src/services/mfaStepUpGrant.ts src/services/aiGuardrails.ts src/services/aiToolsConfigPolicy.ts \
  src/services/tenantExportPolicyRegistry.ts \
  src/routes/auth/schemas.ts src/routes/auth/mfa.ts \
  src/routes/devices/commands.ts src/routes/devices/schemas.ts src/routes/devices/events.ts \
  src/routes/configurationPolicies/featureLinks.ts \
  src/db/schema/devices.ts src/jobs/offlineDetector.ts
pnpm --filter @breeze/web exec tsc --noEmit
```
Expected: all exit 0.

- [ ] **Step 2: Every affected API unit suite, named explicitly, in one run**

```bash
SP=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad
pnpm --filter @breeze/api exec vitest run \
  src/routes/devices/commands.test.ts \
  src/routes/devices/events.test.ts \
  src/__tests__/devices.endpoints.test.ts \
  src/routes/auth.test.ts \
  src/routes/auth/schemas.test.ts \
  src/services/mfaStepUpGrant.test.ts \
  src/services/deviceLiveness.test.ts \
  src/services/deviceMaintenanceLease.test.ts \
  src/jobs/offlineDetector.test.ts \
  src/jobs/offlineDetector_reeval.test.ts \
  src/jobs/offlineDetector_fanout.test.ts \
  src/jobs/offlineDetector_configPolicy.test.ts \
  src/jobs/offlineDetector_uninstallIntentReaper.test.ts \
  src/jobs/offlineDetector.dbcontext.test.ts \
  src/routes/configurationPolicies/featureLinks.test.ts \
  src/services/aiGuardrails.test.ts \
  src/services/aiGuardrails.approvalScope.contract.test.ts \
  src/services/aiGuardrails.readonly.contract.test.ts \
  src/services/aiGuardrails.agentPrincipal.contract.test.ts \
  src/services/aiGuardrails.enforcementArming.contract.test.ts \
  src/services/aiGuardrailsTierConfig.parity.test.ts \
  src/services/aiGuardrailsAiDocs.parity.test.ts \
  src/services/aiToolsConfigPolicy.test.ts \
  src/routes/mcpServer.approvalGate.test.ts \
  src/routes/mcpServer.effectiveTier.test.ts \
  src/services/policyBaselineDefaults.test.ts \
  src/db/autoMigrate.test.ts \
  2>&1 | tee "$SP/rmm-qa-176-red/99-battery.txt" | tail -40
```
Expected: every file green. **Compare each file's count against `00-baseline.txt`.** A file whose count *dropped* means a case was deleted rather than replaced — stop and investigate; the three flipped `commands.test.ts` cases and the four flipped `DevicesPage.test.tsx` cases were replacements, so no count should fall.

- [ ] **Step 3: Migration gates on the staged tree**

```bash
bash scripts/check-migration-naming.sh --staged
pnpm --filter @breeze/api check:migrations
ls apps/api/migrations | sort | tail -3
```
Expected: the naming gate reports no violations — in particular **rule 3 (strict sort-after-max), which is only evaluated in `--staged` mode**; `check:migrations` exits 0. If `main` has moved and a later stamp now exists, the migration filename must be re-chosen and the file renamed **before** the PR opens — a shipped migration is never edited afterwards.

- [ ] **Step 4: The integration suite against the private stack**

```bash
pnpm test-stack up   # NEVER `pnpm --filter @breeze/api test:docker:up`
pnpm --filter @breeze/api db:check-drift
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceMaintenanceLease.integration.test.ts \
  src/__tests__/integration/deviceMaintenanceStepUp.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  2>&1 | tee -a "$SP/rmm-qa-176-red/99-battery.txt" | tail -30
```
Expected: `db:check-drift` reports no drift; every suite green. `rls-coverage` is unchanged because no table was added — only columns on an existing one.

- [ ] **Step 5: Web battery**

```bash
pnpm --filter @breeze/web exec vitest run \
  src/lib/mfaStepUp.test.ts \
  src/stores/authenticator.test.ts \
  src/services/deviceActions.test.ts \
  src/components/devices/MaintenanceModeDialog.test.tsx \
  src/components/devices/DeviceActions.test.tsx \
  src/components/devices/DevicesPage.test.tsx \
  src/components/devices/DeviceDetailPage.scriptAdmission.test.tsx \
  src/components/settings/StepUpPrompt.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/__tests__/no-silent-mutations.test.ts \
  2>&1 | tee -a "$SP/rmm-qa-176-red/99-battery.txt" | tail -30
```
Expected: all green.

- [ ] **Step 6: Tear the private stack down**

```bash
pnpm test-stack down
docker ps --format '{{.Names}}' | grep -i rmm-qa-176 || echo "no stack containers left"
```
Expected: the stack is gone. **Do this before opening the PR** — a stack left running holds ports another worktree needs.

- [ ] **Step 7: Confirm the working tree is exactly what was reviewed**

```bash
git status --short
git log --oneline origin/main..HEAD
git diff --stat origin/main..HEAD
```
Expected: `git status` clean (no stray mutation left in place from any Step's mutation controls — **this is the last chance to catch a reverted-but-not-really mutation**); the log shows the Task 1–13 commits in order; the diff touches no file outside the File map, and nothing under `/Users/toddhebebrand/breeze-rmm-qa`.

- [ ] **Step 8: Push and open a DRAFT PR**

```bash
git push -u origin fix/rmm-qa-176-maintenance-mode-step-up
gh pr create --draft \
  --base main \
  --head fix/rmm-qa-176-maintenance-mode-step-up \
  --title "fix(api,web): step-up gate and persisted lease for device maintenance mode (RMM-QA-176)" \
  --body-file "$SP/rmm-qa-176-red/pr-body.md"
```

Write `pr-body.md` first, to this outline — each section filled from the recorded evidence, not from memory:

1. **What was wrong.** `POST /devices/:id/maintenance` mutated monitoring posture behind `devices:write` + site scope only, and two parallel authoring paths for the *same* suppression (config-policy feature links over HTTP; MCP `manage_policy_feature_link`) were reachable by an API key with no approval. Quote the endpoint-level RED: the case that returned **200** on `main` with `mfa: false`, and the MCP case that **executed**.
2. **What it does now.** The chain (`requireScope` → unconditional `isInteractiveUserSession` → `devices:write` → body → entry-only `requireMfa()` → entry-state allowlist → grant validate → consume-inside-transaction), the persisted lease, `device.maintenance.extend`, the un-gated truthful exit, the single-grant bulk route, the feature-link gate, the input-aware Tier-3 escalation.
3. **Evidence boundary — state it plainly, do not let a reader infer more.**
   - What is proven: the gate denies, and a denied request leaves the device row **byte-identical** in real Postgres (Task 9); the grant is bound to `{deviceIds, reason, durationHours}` by one shared canonicalizer; every control is mutation-proven, and each mutation and its observed failure line is in the commit that introduced it.
   - What is **not** claimed: **suppression behaviour is unchanged by this PR.** After entry, alerts/patching/scripts are governed exactly as before — `checkDeviceMaintenanceWindow` and `isDeviceInMaintenance` do not read the lease, the heartbeat still overwrites `status`, and there is no expiry sweeper. The gated act is the *authoring* of a persisted, audited window. Making that window act is RMM-QA-217, which inherits these columns and needs no second migration.
   - Also not claimed: no production deployment, no customer-device mutation, no rollout. Manual smoke was against a disposable dev stack only.
4. **Compatibility notes.**
   - `reason` and `durationHours` become **required** on entry; both request branches are `.strict()`. In-repo callers are updated in this PR, and the route is JWT-only (`index.ts:840`) so no API-key integration can exist. A third-party caller of the old body gets a 400 naming the field.
   - `toggleMaintenanceMode` is removed from the web service layer, replaced by three named functions.
   - "Extend by N" means **N hours from now**, not `existing + N`. Deliberate (D6): a state-independent outcome is what makes one grant mean one thing under a concurrent entry.
   - `quarantined` / `pending` / `updating` devices are refused with `409 MAINTENANCE_STATE_CONFLICT` — new, and the reason enter-then-exit can no longer launder a quarantined device.
   - SMS-only accounts cannot enter maintenance while 2FA is on until they add TOTP or a passkey (no authenticated step-up SMS sender exists). Surfaced in the dialog; product follow-up, not hidden.
   - `ENABLE_2FA=false` deployments get no factor prompt (audited `stepUp: 'disabled_2fa'`), consistent with every other `requireMfa()` gate — **machine principals are still denied there**, by the interactive gate, and that is tested with 2FA off.
   - One forward migration adding four nullable columns to `devices`, no index, no backfill; all four registered in the tenant-export policy.
5. **QA probe flip, as evidence only.** Paste `T13-qa-probe-flip.txt`. State that these probes characterize the *unsafe* state, that their flip is the expected outcome, and that **updating them is the QA repo's job, not this PR's** — no file under `breeze-rmm-qa` is touched.
6. **Footer:** `Refs: RMM-QA-176` (no GitHub issue exists for it).

- [ ] **Step 9: Confirm CI actually attached to the head**

```bash
gh pr view --json number,isDraft,headRefOid
gh run list --branch fix/rmm-qa-176-maintenance-mode-step-up --limit 10
```
Expected: the PR is **draft**, and workflow runs exist against the exact head SHA. If the list is silent, dispatch explicitly (`gh workflow run CI --ref fix/rmm-qa-176-maintenance-mode-step-up`) and re-check — a PR whose CI never attached is not evidence of anything. Wait for `integration-test` shards specifically; the migration and export-policy proofs live there.

- [ ] **Step 10: Request one independent review round, then stop**

Per the rigor policy: **at most one** independent code-review round unless a fix itself touches a high-blast-radius surface (auth, the migration, the guardrail tables). Address findings, re-run the affected suite plus its mutation control, and mark the PR ready for review. Do not merge.
