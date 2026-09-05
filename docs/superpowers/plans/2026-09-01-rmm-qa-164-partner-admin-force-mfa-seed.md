# RMM-QA-164 Partner Admin `force_mfa` Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `force_mfa = true` a stored invariant of every system-defined Partner Admin role on every creation path (global seed template, per-tenant `createPartner()` copy, already-installed databases via one forward migration), so a password-only Partner Admin is minted `mfa: false`, told `mfaEnrollmentRequired: true`, and refused by `requireMfa()` until a real factor exists.

**Architecture:** Three write paths get the literal flag (D1/D2 seed definition + narrowed one-directional reconcile in `seedRoles()`, D3 literal in `partnerCreate.ts`, D4 idempotent forward migration filtered to `is_system = true`). No change to the MFA resolver, the login/verify mints, the 428 gate, or the web app — they already read the stored flag; the stored flag is the defect. The env kill switch `MFA_FORCE_FOR_PARTNER_ADMIN` stays the only relief valve and is made reachable in the self-host compose stack (D6); CI smoke uses it and gains a stored-flag assertion (D7).

**Tech Stack:** TypeScript (Hono + Drizzle ORM), Postgres 16 (real-DB vitest integration suites, per-worktree `pnpm test-stack`), plain SQL migrations under `apps/api/migrations/`, GitHub Actions YAML, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-01-rmm-qa-164-partner-admin-force-mfa-seed-design.md` (same worktree; commit it in Task 0). The plan argues from the spec's decisions D1–D13 and RED list T1–T5; executors read both.

**Finding inputs (read-only, never edited):**
- Verified brief + adversarial verifier concerns: `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/RMM-QA-164.brief.json`
- Backlog row (exit-evidence contract): `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/RMM-QA-164.row.md`
- QA characterization (do not edit): `/Users/toddhebebrand/breeze-rmm-qa/docs/qa/evidence/2026-08-22-partner-role-mfa-matrix.md` and `/Users/toddhebebrand/breeze-rmm-qa/docs/qa/run-local-partner-role-matrix.mjs`. No file under `/Users/toddhebebrand/breeze-rmm-qa/docs/qa/probes/` carries the ID (verified by grep on 2026-09-01).

**Codex advisor round (spec §8 said its findings land here):** the read-only `gpt-5.6-sol` attack round on D1–D8 (`scratchpad/codex-164-out.txt`, 401 KB, 2026-09-01 15:53) ended without a final message — the transcript stops after a refused MCP indexing call and a handful of file reads; there is no verdict to incorporate. The earlier Codex characterization (`scratchpad/s1/RMM-QA-164-codex.md`) independently proposed the same fix shape (seed literal + reconcile, `partnerCreate` literal, `is_system`-filtered idempotent migration with `GET DIAGNOSTICS` count, trigger removal from the registration test, kill switch retained) and recommended immediate web navigation on `mfaEnrollmentRequired` — which the spec deliberately scopes out as D8 (follow-up, UX-only). Nothing in either transcript contradicts D1–D13.

## Verifier concerns → where each is satisfied

| Concern (brief `verdict.fixDesignConcerns`) | Satisfied by |
| --- | --- |
| 1. `seedRoles()` name-only lookup could flip a custom `is_system=false` "Partner Admin" or a tenant copy; filter to `is_system=true AND partner_id IS NULL AND org_id IS NULL`, migration alone handles tenant copies | Task 2 (D2 narrowed lookup; T2 cases (c) and (e) pin it; mutation control reverts the filter and watches (e) fail). Task 4 migration reconciles tenant copies. |
| 2. Reconcile migration fires `breeze_roles_permissions_epoch` → fleet-wide epoch bump + 428 wall; rollout note must name `MFA_FORCE_FOR_PARTNER_ADMIN=false`; migration must RAISE the row count | Task 4 (T5 asserts exactly +1 epoch per member on first apply, 0 on re-apply; migration RAISEs WARNING/NOTICE with the count and T5 captures it). Task 5 makes the valve reachable in the root compose. Task 8 PR body carries the rollout note verbatim from spec §6. |
| 3. Do not touch `2026-05-25-f`; new file must sort after the newest shipped migration under `localeCompare` | Task 4 Step 0 re-computes the committed max with the runner's comparator; the pre-commit hook (`check-migration-naming.sh --staged`, rule 3) blocks a wrong name; `git diff --stat origin/main -- apps/api/migrations/2026-05-25-f-role-force-mfa.sql` must be empty (asserted in Task 7). |
| 4. The trigger-free integration test must run under `ENABLE_2FA=true` or the `mfa=false` assertions are vacuous | Task 3 keeps `process.env.ENABLE_2FA = 'true'` before the dynamic imports and proves non-vacuity by mutation: set it to `'false'`, watch the role-axis test fail, revert. |

## Global Constraints

- **Worktree:** `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-164` (git worktree of `/Users/toddhebebrand/breeze`). Every path below is relative to it unless absolute. Never touch any other worktree, never push to `main`, never merge.
- **Branch:** `fix/rmm-qa-164-partner-admin-force-mfa-seed`, cut from `origin/main` at `0fb5af40d`.
- **Rigor: HIGH** (auth + migration). Every behaviour change is RED-first and the failing output is retained in the commit message. Every test control is proven to discriminate: apply the listed mutation, run, confirm red, revert (`git checkout -- <file>` or reverse the edit), confirm green again. Keep each RED/mutation log under `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/` (create it) — the PR body cites them.
- **Bootstrap once:** `pnpm install --frozen-lockfile` in the worktree before anything else (also installs the `.githooks` pre-commit via the root `prepare` script; confirm with `git config core.hooksPath` → `.githooks`).
- **Typecheck gate:** `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit`
- **Unit tests:** `pnpm --filter @breeze/api exec vitest run <paths>`
- **Web tests:** `pnpm --filter @breeze/web exec vitest run <paths>` (not needed by this plan — D8 makes no web change).
- **Real-Postgres integration tests:** per-worktree stack only — `pnpm test-stack up` from the worktree root (writes a generated `.env.test`; `pnpm test-stack info` prints it), then `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <paths>`; `pnpm test-stack down` when finished. **Never** `test:docker:up`.
- **Migration gates (Task 4 adds a migration):** `bash scripts/check-migration-naming.sh --staged` (also runs in the pre-commit hook — do not commit with `--no-verify`), `pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts`, and `pnpm --filter @breeze/api check:migrations` against a fresh database (exact command in Task 4). `pnpm db:check-drift` is expected to be a no-op (no schema change).
- **Migration rules:** never edit a shipped migration; new file must sort strictly after `2026-09-29-detach-ticket-runs-on-device-org-move.sql` (re-verify at execution time; main moves); idempotent; no inner `BEGIN;`/`COMMIT;`; cleanup statements report row counts via `GET DIAGNOSTICS` + `RAISE`.
- **Copy rules from the spec:** role name literal `'Partner Admin'`; migration predicate `scope = 'partner' AND name = 'Partner Admin' AND is_system = true AND force_mfa = false`; log line `Role reconciled (force_mfa): <name>`; relief valve `MFA_FORCE_FOR_PARTNER_ADMIN=false`; enrollment URL `/auth/mfa/setup`.
- **Non-goals (spec):** no change to `2026-05-25-f-role-force-mfa.sql`, `services/mfaPolicy.ts`, `routes/auth/login.ts`, `routes/auth/verifyEmail.ts`, `middleware/auth.ts`, or anything under `apps/web`. Org Admin and every other system role stay `forceMfa: false` (D9). Custom `is_system=false` roles never inherit the invariant (D11).
- **Commit trailer (every commit):**
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu
  ```
- **Codex (if used for any read-only analysis):** `codex exec "..." -s read-only -m gpt-5.6-sol -C <dir> < /dev/null` — always redirect stdin.
- **Evidence labelling:** in commit messages and the PR body mark every claim `verified` (you ran it and pasted output), `inferred`, or `not executed`.

## File Structure

| File | Responsibility in this change | Task |
| --- | --- | --- |
| `apps/api/src/db/seed.ts` | `SystemRoleDefinition` type + `forceMfa` on all ten `SYSTEM_ROLES` entries (D1); `seedRoles()` narrowed template lookup, insert `forceMfa`, one-directional reconcile (D2) | 1, 2 |
| `apps/api/src/db/seed.test.ts` | T1: definition posture (only Partner Admin forced, every role declares a boolean) | 1 |
| `apps/api/src/__tests__/integration/seedPartnerAdminForceMfa.integration.test.ts` (new) | T2: real-Postgres stored-flag, reconcile, filter, one-directionality | 2 |
| `apps/api/src/services/partnerCreate.ts` | D3: `forceMfa: true` literal on the tenant Partner Admin insert | 3 |
| `apps/api/src/services/partnerCreate.test.ts` | T3: captured roles insert carries `forceMfa: true` | 3 |
| `apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts` | D12/T4: drop the role trigger; role-axis test on the real row; kill-switch control | 3 |
| `apps/api/migrations/2026-09-30-100000-partner-admin-force-mfa-reconcile.sql` (new) | D4: idempotent reconcile of system Partner Admin rows, logged count | 4 |
| `apps/api/src/__tests__/integration/partnerAdminForceMfaMigration.integration.test.ts` (new) | T5: replay migration twice over fixtures; system rows flip, custom/org-scope/Org Admin untouched, epoch +1 then 0, notice text | 4 |
| `docker-compose.yml`, `.env.example` | D6: map + document `MFA_FORCE_FOR_PARTNER_ADMIN` (parity-guarded) | 5 |
| `.github/workflows/ci.yml` (smoke job only), `e2e-tests/README.md` | D7: valve off in smoke `.env`, stored-flag + valve-honoured assertions; README note for local Playwright | 6 |
| `docs/superpowers/plans/...` / `docs/superpowers/specs/...` | this plan + the spec | 0 |

---

### Task 0: Bootstrap the worktree and commit the spec + plan

**Files:**
- Commit: `docs/superpowers/specs/2026-09-01-rmm-qa-164-partner-admin-force-mfa-seed-design.md`, `docs/superpowers/plans/2026-09-01-rmm-qa-164-partner-admin-force-mfa-seed.md`

- [ ] **Step 1: Confirm the worktree and branch**

Run:
```bash
cd /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-164
git branch --show-current
git log --oneline -1
git status --short
```
Expected: `fix/rmm-qa-164-partner-admin-force-mfa-seed`; head `0fb5af40d` (or a later `origin/main` if the worktree was re-cut — record the SHA); status shows only the untracked spec (and this plan). If the worktree is absent: `git -C /Users/toddhebebrand/breeze fetch origin main && git -C /Users/toddhebebrand/breeze worktree add -b fix/rmm-qa-164-partner-admin-force-mfa-seed <worktree path> origin/main` (drop `-b` if the branch already exists).

- [ ] **Step 2: Install dependencies and confirm the hook path**

Run:
```bash
pnpm install --frozen-lockfile
git config core.hooksPath
mkdir -p /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence
```
Expected: install succeeds; `.githooks` printed (the pre-commit hook runs `check-migration-naming.sh --staged`, which Task 4 relies on).

- [ ] **Step 3: Baseline typecheck (proves the gate is green before any edit)**

Run: `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit`
Expected: exit 0, no output. If it fails on `main`, stop and report — do not proceed on a red baseline.

- [ ] **Step 4: Start the private test stack (used by Tasks 2–4, 7)**

Run:
```bash
pnpm test-stack up
pnpm test-stack info
```
Expected: `.env.test` printed with `DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:<port>/breeze_test`, `DATABASE_URL_APP=...breeze_app...`, and `# compose project: breeze-test-<hash> (...)`. Note `<port>` and the project name — Task 4 Step 9 needs them.

- [ ] **Step 5: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-09-01-rmm-qa-164-partner-admin-force-mfa-seed-design.md docs/superpowers/plans/2026-09-01-rmm-qa-164-partner-admin-force-mfa-seed.md
git commit -m "docs(qa): RMM-QA-164 Partner Admin force_mfa seed — design spec and plan

Finding RMM-QA-164 (S1): a fresh stack seeds the system Partner Admin role
with force_mfa=false because autoMigrate applies 2026-05-25-f before seed()
and SYSTEM_ROLES/seedRoles()/createPartner() never write the flag.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 1: `SYSTEM_ROLES` declares its MFA posture (D1, T1)

**Files:**
- Modify: `apps/api/src/db/seed.ts:231-379` (`SYSTEM_ROLES` — Partner Admin at 233-238, Org Admin at 298-328)
- Test: `apps/api/src/db/seed.test.ts` (append a new `describe` after line 336)

**Interfaces:**
- Produces: `export interface SystemRoleDefinition { name: string; scope: 'partner' | 'organization'; description: string; permissions: string[]; forceMfa: boolean }` and `export const SYSTEM_ROLES: readonly SystemRoleDefinition[]`. Task 2 reads `roleDef.forceMfa` inside `seedRoles()`; `seed-idempotency.integration.test.ts` reads `SYSTEM_ROLES.length` (unchanged). The only other consumer is `seed.test.ts` (verified by `grep -rn SYSTEM_ROLES apps/api/src`).

- [ ] **Step 1: Write the failing test (T1)**

Append to the end of `apps/api/src/db/seed.test.ts`:

```ts
describe('system role MFA posture (RMM-QA-164)', () => {
  // The stored roles.force_mfa flag is what services/mfaPolicy.ts reads; the
  // 2026-05-25-f migration only ever flipped rows that existed when it ran,
  // and on a fresh database autoMigrate applies it BEFORE seed(). The seed
  // definition is therefore the source of truth for a fresh install, and it
  // must state the posture of every role explicitly rather than leave the
  // column to its DEFAULT false.
  it('every system role declares forceMfa as a boolean', () => {
    for (const role of SYSTEM_ROLES) {
      expect(typeof role.forceMfa, `role "${role.name}" must declare forceMfa`).toBe('boolean');
    }
  });

  it('forces MFA for Partner Admin and for no other system role (D9: Org Admin stays MSP opt-in)', () => {
    expect(SYSTEM_ROLES.filter((role) => role.forceMfa).map((role) => role.name)).toEqual(['Partner Admin']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/T1-red.log`
Expected: 2 failed — `expected 'undefined' to be 'boolean'` for `role "Partner Admin"` and `expected [] to deeply equal [ 'Partner Admin' ]`. Also run the typecheck gate: expected FAIL with `Property 'forceMfa' does not exist on type ...` (retain both in the commit message).

- [ ] **Step 3: Add the type and the flag to all ten entries**

In `apps/api/src/db/seed.ts`, replace lines 229-231 (`// Default system roles` … `export const SYSTEM_ROLES = [`) with:

```ts
// Default system roles
// Exported for the seed↔registry consistency test (seed.test.ts).
export interface SystemRoleDefinition {
  name: string;
  scope: 'partner' | 'organization';
  description: string;
  permissions: string[];
  /**
   * Stored on roles.force_mfa at seed time and reconciled false→true on
   * re-seed (never lowered — see seedRoles()). RMM-QA-164: the
   * 2026-05-25-f migration promised force_mfa=true for the system Partner
   * Admin role, but on a fresh database it ran before seed() created the
   * row, so the definition must carry the flag itself. Only Partner Admin
   * is forced; every other system role is an MSP opt-in per that
   * migration's header (D9).
   */
  forceMfa: boolean;
}

export const SYSTEM_ROLES: readonly SystemRoleDefinition[] = [
```

Then, in each of the ten entries, insert one line directly after the `description:` line. Partner Admin (lines 233-238) becomes:

```ts
  {
    name: 'Partner Admin',
    scope: 'partner' as const,
    description: 'Full access to partner and all organizations',
    forceMfa: true,
    permissions: ['*:*']
  },
```

Every other entry gets `forceMfa: false,` in the same position. Org Admin (starts line 298) becomes:

```ts
  {
    name: 'Org Admin',
    scope: 'organization' as const,
    description: 'Full access to organization',
    forceMfa: false,
    permissions: [
```
(keep its existing description text verbatim if it differs from the line above — only the inserted line is new). The remaining eight entries to edit, by `name:` line at the pre-edit numbering: Partner Technician (241), Partner Viewer (262), Partner Billing (277), Partner Billing Viewer (288), Org Technician (329), Org Viewer (347), Security Approver (361), Partner Security Approver (370). After editing, `grep -c "forceMfa:" apps/api/src/db/seed.ts` must print `11` (10 entries + the interface) and `grep -n "forceMfa: true" apps/api/src/db/seed.ts` must print exactly one line (Partner Admin).

- [ ] **Step 4: Run the test and the typecheck to verify they pass**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all `seed.test.ts` tests pass (the pre-existing suites too); tsc exit 0.

- [ ] **Step 5: Mutation controls (prove T1 discriminates)**

1. Change Partner Admin to `forceMfa: false,` → run `pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts -t "forces MFA for Partner Admin"` → expected FAIL `expected [] to deeply equal [ 'Partner Admin' ]`. Revert.
2. Change Org Admin to `forceMfa: true,` → same command → expected FAIL `expected [ 'Partner Admin', 'Org Admin' ] to deeply equal [ 'Partner Admin' ]`. Revert.
3. Re-run the full file → all pass. Save the two red outputs to `.../rmm-qa-164-evidence/T1-mutations.log`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/seed.ts apps/api/src/db/seed.test.ts
git commit -m "fix(api): declare forceMfa on every SYSTEM_ROLES entry; only Partner Admin forced (RMM-QA-164 D1)

RED before this change (seed.test.ts):
  <paste the two failure lines from T1-red.log>
tsc before this change: Property 'forceMfa' does not exist on type ...

Mutation controls (verified red, then reverted): Partner Admin→false fails
the posture test; Org Admin→true fails it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 2: `seedRoles()` stores, reconciles, and only ever matches the global template (D2, T2)

**Files:**
- Modify: `apps/api/src/db/seed.ts:7` (import) and `:846-883` (`seedRoles()` lookup + insert + existing branch)
- Create: `apps/api/src/__tests__/integration/seedPartnerAdminForceMfa.integration.test.ts`

**Interfaces:**
- Consumes: `SYSTEM_ROLES[i].forceMfa` (Task 1); `seedPermissions()`, `seedRoles()` from `apps/api/src/db/seed.ts` (both wrap themselves in `withSystemDbAccessContext` and write through the `breeze_app` pool); `getTestDb()` (superuser drizzle) from `./setup`; `createPartner()` from `./db-utils` (returns `{ id, ... }`).
- Produces: `seedRoles()` behaviour — lookup `and(eq(roles.name), eq(roles.isSystem, true), isNull(roles.partnerId), isNull(roles.orgId))`; insert includes `forceMfa: roleDef.forceMfa`; existing branch runs `db.update(roles).set({ forceMfa: true })` only when `roleDef.forceMfa && !existing.forceMfa` and logs `Role reconciled (force_mfa): <name>`.

- [ ] **Step 1: Write the failing integration test (T2)**

Create `apps/api/src/__tests__/integration/seedPartnerAdminForceMfa.integration.test.ts`:

```ts
/**
 * RMM-QA-164 — the seeded system Partner Admin template must STORE
 * force_mfa = true, and re-seeding must heal a false template without
 * touching rows the seed does not own.
 *
 * Why real Postgres: the defect is the stored column, not the definition.
 * seedRoles() writes through the breeze_app pool under system scope; this
 * file reads back with the superuser test client. setup.ts truncates
 * `roles`/`role_permissions` per test (not `permissions`, which
 * seedPermissions() re-seeds idempotently).
 *
 * Cases:
 *  (a) blank → seedRoles() → template true, every other system row false
 *  (b) template forced back to false → seedRoles() → true again (reconcile)
 *  (c) custom is_system=false same-name row and a tenant copy stay false
 *      and the template is not duplicated (verifier concern 1 / D11)
 *  (d) an operator-raised Org Admin template is NOT lowered (one-directional, D9)
 *  (e) template missing but a custom same-name row present → template is
 *      created; the custom row is untouched (the name-only lookup used to
 *      report "Role exists" and create nothing)
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { roles } from '../../db/schema';
import { seedPermissions, seedRoles, SYSTEM_ROLES } from '../../db/seed';
import { createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PARTNER_ADMIN = 'Partner Admin';

/** Global system rows: is_system AND partner_id IS NULL AND org_id IS NULL. */
async function globalSystemRows() {
  return getTestDb()
    .select({ id: roles.id, name: roles.name, forceMfa: roles.forceMfa })
    .from(roles)
    .where(and(eq(roles.isSystem, true), isNull(roles.partnerId), isNull(roles.orgId)));
}

async function templateRows(name: string) {
  return (await globalSystemRows()).filter((row) => row.name === name);
}

async function rowById(id: string) {
  const [row] = await getTestDb()
    .select({ id: roles.id, forceMfa: roles.forceMfa, isSystem: roles.isSystem, partnerId: roles.partnerId })
    .from(roles)
    .where(eq(roles.id, id));
  return row;
}

async function setForceMfa(id: string, value: boolean) {
  await getTestDb().update(roles).set({ forceMfa: value }).where(eq(roles.id, id));
}

describe('seedRoles() Partner Admin force_mfa (RMM-QA-164)', () => {
  beforeEach(async () => {
    await seedPermissions();
  });

  runDb('(a) a blank database seeds the Partner Admin template with force_mfa=true and every other system role false', async () => {
    await seedRoles();

    const rows = await globalSystemRows();
    expect(rows).toHaveLength(SYSTEM_ROLES.length);

    const forced = rows.filter((row) => row.forceMfa).map((row) => row.name);
    expect(forced).toEqual([PARTNER_ADMIN]);
  });

  runDb('(b) re-seeding reconciles a template that was forced back to false', async () => {
    await seedRoles();
    const [template] = await templateRows(PARTNER_ADMIN);
    expect(template).toBeDefined();
    await setForceMfa(template!.id, false);
    expect((await rowById(template!.id))?.forceMfa).toBe(false);

    await seedRoles();

    expect((await rowById(template!.id))?.forceMfa).toBe(true);
    expect(await globalSystemRows()).toHaveLength(SYSTEM_ROLES.length);
  });

  runDb('(c) a custom is_system=false same-name role and a tenant copy are never flipped and the template is not duplicated', async () => {
    await seedRoles();
    const partner = await createPartner();
    const [custom] = await getTestDb()
      .insert(roles)
      .values({ scope: 'partner', name: PARTNER_ADMIN, isSystem: false, forceMfa: false })
      .returning({ id: roles.id });
    const [tenantCopy] = await getTestDb()
      .insert(roles)
      .values({ partnerId: partner.id, scope: 'partner', name: PARTNER_ADMIN, isSystem: true, forceMfa: false })
      .returning({ id: roles.id });

    await seedRoles();

    expect((await rowById(custom!.id))?.forceMfa).toBe(false);
    expect((await rowById(tenantCopy!.id))?.forceMfa).toBe(false);
    const templates = await templateRows(PARTNER_ADMIN);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.forceMfa).toBe(true);
  });

  runDb('(d) an operator-raised Org Admin template is not lowered by re-seeding (one-directional)', async () => {
    await seedRoles();
    const [orgAdmin] = await templateRows('Org Admin');
    expect(orgAdmin).toBeDefined();
    await setForceMfa(orgAdmin!.id, true);

    await seedRoles();

    expect((await rowById(orgAdmin!.id))?.forceMfa).toBe(true);
  });

  runDb('(e) a missing template is created even when a custom same-name row exists; the custom row is untouched', async () => {
    await seedRoles();
    const [template] = await templateRows(PARTNER_ADMIN);
    await getTestDb().delete(roles).where(eq(roles.id, template!.id));
    const [custom] = await getTestDb()
      .insert(roles)
      .values({ scope: 'partner', name: PARTNER_ADMIN, isSystem: false, forceMfa: false })
      .returning({ id: roles.id });

    await seedRoles();

    const templates = await templateRows(PARTNER_ADMIN);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.forceMfa).toBe(true);
    expect(templates[0]?.id).not.toBe(custom!.id);
    const customAfter = await rowById(custom!.id);
    expect(customAfter?.isSystem).toBe(false);
    expect(customAfter?.forceMfa).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/seedPartnerAdminForceMfa.integration.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/T2-red.log`
Expected: (a) FAIL `expected [] to deeply equal [ 'Partner Admin' ]` (stored false — the QA symptom); (b) FAIL `expected false to be true`; (c) PASS or FAIL depending on which same-name row the name-only `LIMIT 1` returns (record what happened); (d) PASS (nothing reconciles today); (e) FAIL `expected +0 to be 1` (name-only lookup reports "Role exists" and creates nothing). (d) passing before the change is expected — it is the one-directionality guard whose discriminator is mutation 3 in Step 5.

- [ ] **Step 3: Implement D2 in `seedRoles()`**

In `apps/api/src/db/seed.ts` line 7 change the drizzle import to:

```ts
import { eq, and, isNull } from 'drizzle-orm';
```

Replace the body of the `for (const roleDef of SYSTEM_ROLES)` loop from `// Check if role already exists` through the `console.log('  Created role:', roleDef.name);` closing `}` (lines 855-882) with:

```ts
    // RMM-QA-164: match ONLY the global system template. A name-only lookup
    // could match a tenant copy (partner_id set, created by createPartner())
    // or a custom is_system=false role that happens to share the name — it
    // would then skip creating the template and, with the reconcile below,
    // flip a row the seed never owned. Tenant copies are reconciled by the
    // 2026-09-30-100000 migration, not here.
    const [existing] = await db
      .select()
      .from(roles)
      .where(
        and(
          eq(roles.name, roleDef.name),
          eq(roles.isSystem, true),
          isNull(roles.partnerId),
          isNull(roles.orgId),
        ),
      )
      .limit(1);

    let roleId: string;

    if (existing) {
      roleId = existing.id;
      if (roleDef.forceMfa && !existing.forceMfa) {
        // One-directional: the definition may RAISE a stored flag, never
        // lower one. Org Admin et al. are per-deployment opt-ins (see the
        // 2026-05-25-f header), so "make it equal the definition" would
        // silently revert an operator's choice on every db:seed. The UPDATE
        // fires breeze_roles_permissions_epoch for the template's members
        // (the bootstrap admin) — intended.
        await db.update(roles).set({ forceMfa: true }).where(eq(roles.id, existing.id));
        console.log('  Role reconciled (force_mfa):', roleDef.name);
      } else {
        console.log('  Role exists:', roleDef.name);
      }
    } else {
      const [newRole] = await db
        .insert(roles)
        .values({
          name: roleDef.name,
          scope: roleDef.scope,
          description: roleDef.description,
          isSystem: true,
          forceMfa: roleDef.forceMfa,
        })
        .returning();

      if (!newRole) {
        console.error('  Failed to create role:', roleDef.name);
        continue;
      }
      roleId = newRole.id;
      console.log('  Created role:', roleDef.name);
    }
```

Leave the permission-assignment loop that follows untouched.

- [ ] **Step 4: Run T2 plus the existing seed guard, then typecheck**

Run:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/seedPartnerAdminForceMfa.integration.test.ts src/__tests__/integration/seed-idempotency.integration.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: 5/5 in the new file, `seed-idempotency` still green (role count and grant count unchanged on re-seed), tsc exit 0.

- [ ] **Step 5: Mutation controls (prove T2 discriminates), each reverted before the next**

1. Revert the lookup to name-only (`.where(eq(roles.name, roleDef.name))`) → run the file → expected: (e) FAIL (template count 0 and/or custom row flipped to true); (c) may fail. Revert.
2. Delete the `if (roleDef.forceMfa && !existing.forceMfa) { ... }` branch (keep only the `Role exists` log) → expected: (b) FAIL `expected false to be true`. Revert.
3. Make the reconcile bidirectional: `if (existing.forceMfa !== roleDef.forceMfa) { await db.update(roles).set({ forceMfa: roleDef.forceMfa })... }` → expected: (d) FAIL `expected false to be true` (Org Admin lowered). Revert.
4. Re-run the file → 5/5. Save all red outputs to `.../rmm-qa-164-evidence/T2-mutations.log`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/seed.ts apps/api/src/__tests__/integration/seedPartnerAdminForceMfa.integration.test.ts
git commit -m "fix(api): seedRoles stores force_mfa, reconciles the global template only (RMM-QA-164 D2)

The existing-role lookup is narrowed to is_system=true AND partner_id IS
NULL AND org_id IS NULL so a tenant copy or a custom same-name role can
neither hide the template nor be flipped by the seed (verifier concern 1).
The reconcile is one-directional: false→true for roles the definition
forces, never lowering an operator-raised flag (D9).

RED before this change (seedPartnerAdminForceMfa.integration.test.ts):
  <paste (a), (b), (e) failure lines from T2-red.log>

Mutation controls (verified red, then reverted): name-only lookup → (e)
fails; reconcile removed → (b) fails; bidirectional reconcile → (d) fails.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 3: The tenant Partner Admin copy is created forced, proven on the real registration path (D3, D12, T3, T4)

**Files:**
- Modify: `apps/api/src/services/partnerCreate.ts:103-111` (roles insert)
- Test: `apps/api/src/services/partnerCreate.test.ts` (append one `it` inside `describe('createPartner')`)
- Modify: `apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts` (header lines 21-25, helpers, role-axis test lines 200-224, control lines 246-251)

**Interfaces:**
- Consumes: `createPartner()` from `apps/api/src/services/partnerCreate.ts`; `mfaForcePartnerAdmin()` reads `process.env.MFA_FORCE_FOR_PARTNER_ADMIN` at call time (`config/env.ts:436-438`) and `combineMfaPolicyFacts()` applies it only to the role-force component (`services/mfaPolicy.ts:91-95`) — this is what makes the in-test env override legal.
- Produces: the tenant `roles` insert values `{ partnerId, scope: 'partner', name: 'Partner Admin', description, isSystem: true, forceMfa: true }`.

- [ ] **Step 1: Write the failing unit test (T3)**

Append inside `describe('createPartner', () => { ... })` in `apps/api/src/services/partnerCreate.test.ts` (before its closing `});`):

```ts
  // RMM-QA-164: the tenant Partner Admin copy must be created with
  // force_mfa=true. The 2026-05-25-f migration ran before this row existed
  // and never revisits it, so the literal on the insert is the invariant.
  it('inserts the tenant Partner Admin role with forceMfa: true', async () => {
    await createPartner({
      orgName: 'Forced MFA Co',
      adminEmail: 'forced@example.com',
      adminName: 'Forced',
      passwordHash: 'hashed',
      origin: { mcp: false },
      status: 'active',
    });

    const roleCall = insertCalls.find((c) => (c.table as any).__t === 'roles');
    expect(roleCall).toBeDefined();
    expect(roleCall!.values).toMatchObject({
      scope: 'partner',
      name: 'Partner Admin',
      isSystem: true,
      forceMfa: true,
    });
  });
```

- [ ] **Step 2: Run T3 to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/partnerCreate.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/T3-red.log`
Expected: 1 failed — `toMatchObject` diff showing `forceMfa: true` expected and the key absent.

- [ ] **Step 3: Rewrite the real-DB registration test (T4, D12) — trigger removed, kill-switch control added**

In `apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts`:

(a) Replace the header paragraph at lines 21-25 (`* Constructing the required-policy condition:` … `force_mfa admin role, or a partner whose security settings require MFA.`) with:

```ts
 * Constructing the required-policy condition:
 *   Role axis — `createPartner()` now stores force_mfa = true on the tenant
 *   Partner Admin row itself (RMM-QA-164). The role-axis test therefore
 *   exercises the REAL row with no trigger; the kill-switch control below
 *   proves those assertions depend on the stored flag being honoured
 *   (MFA_FORCE_FOR_PARTNER_ADMIN is read at call time, config/env.ts).
 *   Settings axis — a BEFORE INSERT trigger on partners still models a
 *   tenant whose security settings require MFA.
 *
 * ENABLE_2FA is set to 'true' before the dynamic imports on purpose: with
 * it off, login/verify short-circuit to mfa: true and every `mfa: false`
 * assertion here would be vacuous (verifier concern 4).
```

(b) Replace `dropTriggers()` (the whole function) with:

```ts
async function dropTriggers(): Promise<void> {
  const db = getTestDb();
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_partner_require_mfa ON partners'));
}
```

(c) Replace the role-axis test (`it('does NOT mint mfa=true when the new admin role forces MFA (role axis)', ...)` — the whole block including the `installTrigger`/`attachTrigger` calls) with:

```ts
  it('stores force_mfa=true on the real createPartner row and does NOT mint mfa=true (role axis, no trigger — RMM-QA-164)', async () => {
    const { status, body, accessClaims } = await parkAndVerify('ForceMfaCo');
    expect(status).toBe(200);

    const db = getTestDb();
    const stored = await db.execute(sql`
      SELECT r.force_mfa, r.is_system FROM roles r
      WHERE r.partner_id = ${body.partner.id} AND r.name = 'Partner Admin'
    `);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.is_system).toBe(true);
    expect(stored[0]?.force_mfa).toBe(true);

    // The user holds NO factor and policy REQUIRES one → no MFA claim, and the
    // response must push them into enrollment.
    expect(body.user.mfaEnabled).toBe(false);
    expect(accessClaims.mfa).toBe(false);
    expect(body.mfaEnrollmentRequired).toBe(true);
    expect(body.enrollUrl).toBe('/auth/mfa/setup');
  });
```

(d) Replace the control test (`it('still mints mfa=true when nothing requires MFA (control — proves the assertions above are not vacuous)', ...)`) with:

```ts
  it('still mints mfa=true with the kill switch off (control — proves the role-axis assertions depend on the stored flag being honoured)', async () => {
    // After RMM-QA-164 every fresh tenant admin is forced, so "nothing requires
    // MFA" can no longer be produced by createPartner. The documented relief
    // valve is the only legitimate way to get there; mfaForcePartnerAdmin()
    // reads the env at call time, so the override needs no re-import.
    const previous = process.env.MFA_FORCE_FOR_PARTNER_ADMIN;
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false';
    try {
      const { status, accessClaims, body } = await parkAndVerify('KillSwitchCo');
      expect(status).toBe(200);
      expect(accessClaims.mfa).toBe(true);
      expect(body.mfaEnrollmentRequired).toBe(false);
    } finally {
      process.env.MFA_FORCE_FOR_PARTNER_ADMIN = previous;
    }
  });
```

Keep `installTrigger`, `attachTrigger`, `seedSystemPartnerAdminRole`, the settings-axis test, and everything else unchanged. Run `grep -n "breeze_test_role_force_mfa" apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts` → expected: no matches.

- [ ] **Step 4: Run T4 to verify the role-axis test fails on current code**

Run: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/T4-red.log`
Expected: the role-axis test FAILS at `expect(stored[0]?.force_mfa).toBe(true)` — `expected false to be true` (exactly the QA symptom: the real row stores false, and had the assertion continued, the claim would be `mfa: true`). The settings-axis test, the kill-switch control, and the other tests PASS.

- [ ] **Step 5: Implement D3**

In `apps/api/src/services/partnerCreate.ts` replace the roles insert values (lines 103-111) with:

```ts
    const [adminRole] = await tx
      .insert(roles)
      .values({
        partnerId: newPartner.id,
        scope: 'partner',
        name: 'Partner Admin',
        description: 'Full access to partner and all organizations',
        isSystem: true,
        // RMM-QA-164: the system Partner Admin role forces MFA on every
        // creation path. A literal, not a copy of the global template: the
        // template lookup happens after this insert, and the invariant is
        // "system Partner Admin forces MFA", not "whatever the template says".
        // MFA_FORCE_FOR_PARTNER_ADMIN=false is the only relief valve.
        forceMfa: true,
      })
      .returning();
```

- [ ] **Step 6: Run T3 + T4 + typecheck to verify they pass**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/services/partnerCreate.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts src/__tests__/integration/emailRecoveryRegistration.integration.test.ts
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass (`emailRecoveryRegistration` is the other real-DB consumer of `createPartner`; it must stay green), tsc exit 0.

- [ ] **Step 7: Mutation controls, each reverted before the next**

1. Delete the `forceMfa: true,` line in `partnerCreate.ts` → run T3 and T4 → expected: T3 FAIL (key absent); T4 role-axis FAIL `expected false to be true`. Revert.
2. In the integration test's `beforeAll`, change `process.env.ENABLE_2FA = 'true'` to `'false'` → run T4 → expected: role-axis FAIL at `expect(accessClaims.mfa).toBe(false)` (`expected true to be false`) — proves the assertions are not vacuous under the short-circuit (verifier concern 4). Revert to `'true'`.
3. Remove the `process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'false'` line from the control (keep the try/finally) → run T4 → expected: control FAIL at `expect(accessClaims.mfa).toBe(true)` (`expected false to be true`) — proves the control depends on the valve, not on an absent policy. Revert.
4. Re-run T3 + T4 → all pass. Save red outputs to `.../rmm-qa-164-evidence/T3-T4-mutations.log`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/partnerCreate.ts apps/api/src/services/partnerCreate.test.ts apps/api/src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts
git commit -m "fix(api): createPartner stores force_mfa=true on the tenant Partner Admin role (RMM-QA-164 D3/D12)

registerPartnerMfaPolicy no longer installs breeze_test_role_force_mfa to
model a corrected row: the real createPartner row IS the corrected row.
The old 'nothing requires MFA' control becomes a kill-switch-off control
(MFA_FORCE_FOR_PARTNER_ADMIN=false, read at call time).

RED before this change:
  partnerCreate.test.ts: <paste toMatchObject diff from T3-red.log>
  registerPartnerMfaPolicy.integration.test.ts (role axis, no trigger):
    <paste 'expected false to be true' line from T4-red.log>

Mutation controls (verified red, then reverted): literal removed → T3 and
T4 role-axis fail; ENABLE_2FA='false' → role-axis mfa assertion fails
(not vacuous); env override removed from control → control fails.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 4: Forward migration reconciles installed databases, filtered to system rows (D4, D5, T5)

**Files:**
- Create: `apps/api/migrations/2026-09-30-100000-partner-admin-force-mfa-reconcile.sql`
- Create: `apps/api/src/__tests__/integration/partnerAdminForceMfaMigration.integration.test.ts`
- Gate (no edit): `apps/api/src/db/autoMigrate.test.ts` ("resolves every core migration path referenced from apps/api/src"), `scripts/check-migration-naming.sh --staged`

**Interfaces:**
- Consumes: `createPartner()`, `createUser({ partnerId })`, `assignUserToPartner(userId, partnerId, roleId)` from `./db-utils`; `getTestDb()`; `process.env.DATABASE_URL` (superuser `breeze_test`, loaded by `./setup` → `./loadEnv`); `postgres` (postgres.js, already a dependency of `apps/api`) for a notice-capturing client.
- Produces: the migration file; nothing else depends on it in code.

- [ ] **Step 0: Re-verify the filename sorts last with the runner's comparator**

Run from the worktree root:
```bash
git ls-tree --name-only HEAD apps/api/migrations/ | sed 's#.*/##' | grep -E '^[0-9]{4}-.*\.sql$' \
  | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).sort((a,b)=>a.localeCompare(b)); const max=n.pop(); const cand="2026-09-30-100000-partner-admin-force-mfa-reconcile.sql"; console.log({max, cand, sortsAfter: cand.localeCompare(max)>0});'
```
Expected: `max: '2026-09-29-detach-ticket-runs-on-device-org-move.sql'`, `sortsAfter: true`. If `max` is newer (main moved), pick a `YYYY-MM-DD-HHMMSS-partner-admin-force-mfa-reconcile.sql` that sorts after it and use that name everywhere below (test constant, spec references in the PR body).

- [ ] **Step 1: Write the failing migration replay test (T5)**

Create `apps/api/src/__tests__/integration/partnerAdminForceMfaMigration.integration.test.ts`:

```ts
/**
 * Replays the RMM-QA-164 reconcile migration over real rows. globalSetup
 * applies it against an EMPTY roles table (the same reason 2026-05-25-f was
 * a no-op on fresh installs), so the reconcile itself is only exercised
 * here.
 *
 * Fixtures (all force_mfa = false):
 *   - global Partner Admin template          (is_system, partner_id NULL)  → flips
 *   - tenant Partner Admin copy + one member (is_system, partner_id set)   → flips, member epoch +1
 *   - custom same-name role                  (is_system = false)          → untouched
 *   - organization-scope system "Partner Admin" (scope != 'partner')      → untouched
 *   - global Org Admin template              (is_system, other name)      → untouched
 * Second apply: identical rows, epoch unchanged, "0 rows" notice.
 *
 * The migration's row count is its only observable for the
 * `force_mfa = false` predicate (the epoch trigger already ignores same-value
 * updates), so this file captures the Postgres notice stream with its own
 * client — setup.ts deliberately swallows notices — and asserts the count.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { roles, users } from '../../db/schema';
import { assignUserToPartner, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-09-30-100000-partner-admin-force-mfa-reconcile.sql',
);

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Apply the migration as the schema owner and return every NOTICE/WARNING it raised. */
async function applyMigration(): Promise<string[]> {
  const notices: string[] = [];
  const client = postgres(process.env.DATABASE_URL!, {
    max: 1,
    onnotice: (notice) => notices.push(String(notice.message ?? '')),
  });
  try {
    await client.unsafe(readFileSync(MIGRATION_FILE, 'utf8'));
  } finally {
    await client.end();
  }
  return notices;
}

async function forceMfaById(ids: string[]): Promise<Map<string, boolean>> {
  const rows = await getTestDb()
    .select({ id: roles.id, forceMfa: roles.forceMfa })
    .from(roles)
    .where(inArray(roles.id, ids));
  return new Map(rows.map((row) => [row.id, row.forceMfa]));
}

async function epochOf(userId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ permissionsEpoch: users.permissionsEpoch })
    .from(users)
    .where(eq(users.id, userId));
  return row!.permissionsEpoch;
}

describe('2026-09-30-100000 partner-admin force_mfa reconcile migration (RMM-QA-164)', () => {
  runDb('flips only system partner-scope Partner Admin rows, bumps member epochs once, and is idempotent', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const member = await createUser({ partnerId: partner.id });

    const inserted = await tdb
      .insert(roles)
      .values([
        { scope: 'partner', name: 'Partner Admin', isSystem: true, forceMfa: false },
        { partnerId: partner.id, scope: 'partner', name: 'Partner Admin', isSystem: true, forceMfa: false },
        { partnerId: partner.id, scope: 'partner', name: 'Partner Admin', isSystem: false, forceMfa: false },
        { scope: 'organization', name: 'Partner Admin', isSystem: true, forceMfa: false },
        { scope: 'organization', name: 'Org Admin', isSystem: true, forceMfa: false },
      ])
      .returning({ id: roles.id });
    const [template, tenantCopy, custom, orgScoped, orgAdmin] = inserted.map((row) => row.id);
    await assignUserToPartner(member.id, partner.id, tenantCopy!);
    const ids = [template!, tenantCopy!, custom!, orgScoped!, orgAdmin!];

    const epochBefore = await epochOf(member.id);

    const firstNotices = await applyMigration();
    expect(firstNotices.some((n) => /flipped 2 system Partner Admin role\(s\)/.test(n)), firstNotices.join(' | ')).toBe(true);

    const afterFirst = await forceMfaById(ids);
    expect(afterFirst.get(template!)).toBe(true);
    expect(afterFirst.get(tenantCopy!)).toBe(true);
    expect(afterFirst.get(custom!)).toBe(false);
    expect(afterFirst.get(orgScoped!)).toBe(false);
    expect(afterFirst.get(orgAdmin!)).toBe(false);
    expect(await epochOf(member.id)).toBe(epochBefore + 1);

    const secondNotices = await applyMigration();
    expect(secondNotices.some((n) => /0 rows needed flipping/.test(n)), secondNotices.join(' | ')).toBe(true);

    const afterSecond = await forceMfaById(ids);
    expect([...afterSecond.entries()]).toEqual([...afterFirst.entries()]);
    expect(await epochOf(member.id)).toBe(epochBefore + 1);
  });
});
```

- [ ] **Step 2: Run T5 and the path-resolution guard to verify both fail**

Run:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerAdminForceMfaMigration.integration.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/T5-red.log
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts -t "resolves every core migration path" 2>&1 | tee -a /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/T5-red.log
```
Expected: T5 FAIL with `ENOENT: no such file or directory, open '.../migrations/2026-09-30-100000-partner-admin-force-mfa-reconcile.sql'`; `autoMigrate.test.ts` FAIL naming the same unresolved path (this is the unit-job backstop).

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-09-30-100000-partner-admin-force-mfa-reconcile.sql`:

```sql
-- RMM-QA-164: reconcile force_mfa on every SYSTEM Partner Admin role.
--
-- 2026-05-25-f-role-force-mfa.sql promised force_mfa = true for the system
-- Partner Admin role, but its UPDATE only touched rows that existed when it
-- ran. autoMigrate applies migrations BEFORE the initial seed() on a fresh
-- database, so the seeded global template stored false; createPartner()
-- inserted every tenant copy without the flag, so those stored false too.
-- The seed and createPartner() now write the flag themselves; this
-- migration fixes forward the rows already on installed databases.
--
-- Scope: the global template (partner_id IS NULL) AND every tenant copy
-- (partner_id set). Custom roles (is_system = false) that happen to share
-- the name are excluded by construction — a user-chosen name is not
-- security policy. Org Admin and the other system roles stay opt-in.
--
-- Side effect (intended): each flipped row fires
-- breeze_roles_permissions_epoch (2026-08-06-b), bumping permissions_epoch
-- for that role's members once. Every Partner Admin without an enrolled
-- factor then receives 428 mfa_enrollment_required on their next
-- non-exempt request until they enrol at /auth/mfa/setup. Relief valve:
-- MFA_FORCE_FOR_PARTNER_ADMIN=false (suppresses only the role-force
-- component; settings-driven requireMfa stays enforced).
--
-- Idempotent: the force_mfa = false predicate makes re-application a no-op.
-- The row count is always logged (a zero is evidence too).

DO $$
DECLARE n integer;
BEGIN
  UPDATE roles
  SET force_mfa = true
  WHERE scope = 'partner'
    AND name = 'Partner Admin'
    AND is_system = true
    AND force_mfa = false;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'partner-admin force_mfa reconcile: flipped % system Partner Admin role(s) to force_mfa=true', n;
  ELSE
    RAISE NOTICE 'partner-admin force_mfa reconcile: 0 rows needed flipping';
  END IF;
END $$;
```

- [ ] **Step 4: Run T5 and the unit guards to verify they pass**

Run:
```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/partnerAdminForceMfaMigration.integration.test.ts src/__tests__/integration/permission-epoch.integration.test.ts
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
```
Expected: T5 passes (first notice `flipped 2 ...`, second `0 rows needed flipping`, epoch exactly +1); `permission-epoch` still green; every `autoMigrate.test.ts` test passes (path resolution, ordering, reserved-block manifest).

Note (verified while writing this plan): `globalSetup.ts` runs `autoMigrate()` once per integration run, so the new file is also applied to the private stack's ledger on its first appearance; the ledger check compares against `discoverCoreMigrationFilenames()`, so a new file is accepted, not flagged as pollution.

- [ ] **Step 5: Mutation controls, each reverted before the next**

1. Delete `AND is_system = true` from the predicate → run T5 → expected FAIL at `expect(afterFirst.get(custom!)).toBe(false)` and the notice assertion (`flipped 3`). Revert.
2. Delete `AND scope = 'partner'` → expected FAIL at `expect(afterFirst.get(orgScoped!)).toBe(false)`. Revert.
3. Delete `AND force_mfa = false` → expected FAIL at the second-apply notice assertion (`flipped 2` again instead of `0 rows`); rows and epoch stay identical (the epoch trigger ignores same-value updates — this is why the count is asserted). Revert.
4. Re-run T5 → pass. Save red outputs to `.../rmm-qa-164-evidence/T5-mutations.log`.

Deviation from spec §4 T5, stated: the spec chose to record the re-apply count in the PR rather than assert it; this plan asserts both counts in T5 (strictly stronger; mutation 3 is the reason).

- [ ] **Step 6: Naming gate on the staged file**

Run:
```bash
git add apps/api/migrations/2026-09-30-100000-partner-admin-force-mfa-reconcile.sql apps/api/src/__tests__/integration/partnerAdminForceMfaMigration.integration.test.ts
bash scripts/check-migration-naming.sh --staged
bash scripts/check-migration-naming.sh
```
Expected: `check-migration-naming: OK` twice.

- [ ] **Step 7: Prove the shipped migration is untouched and drift is a no-op**

Run:
```bash
git diff --stat origin/main -- apps/api/migrations/2026-05-25-f-role-force-mfa.sql
git diff --stat origin/main -- apps/api/migrations/ | tail -1
```
Expected: first command prints nothing; second shows exactly one file changed (the new one).

- [ ] **Step 8: Fresh-database apply — the finding's headline mechanism, end to end**

This replays "migrations first, seed second" on a truly empty database in the private stack and proves the seeded template now stores `true`. `<port>` and `<project>` come from `pnpm test-stack info` (Task 0 Step 4).

```bash
set -a; . ./.env.test; set +a
PGPORT=$(node -e 'console.log(new URL(process.env.DATABASE_URL).port)')
psql "postgresql://breeze_test:breeze_test@localhost:${PGPORT}/postgres" -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE IF EXISTS breeze_test_fresh' -c 'CREATE DATABASE breeze_test_fresh'
# `env -u DATABASE_URL_APP`: `. ./.env.test` above exported DATABASE_URL_APP
# (breeze_app @ breeze_test). db/index.ts opens the request pool from it, so
# without the scrub check:migrations migrates the fresh DB but seed() writes
# into breeze_test (fix round 2 found this: the seed printed "Role reconciled"
# against the private stack and the fresh DB ended with zero seeded roles).
env -u DATABASE_URL_APP \
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:${PGPORT}/breeze_test_fresh" \
POSTGRES_PASSWORD=breeze_test BREEZE_APP_DB_PASSWORD=breeze_test \
JWT_SECRET=local-check-migrations-jwt-secret-not-used-anywhere-32chars \
APP_ENCRYPTION_KEY=local-check-migrations-app-key-32bytes-padding \
MFA_ENCRYPTION_KEY=local-check-migrations-mfa-key-32bytes-padding \
AGENT_ENROLLMENT_SECRET=local-check-migrations-agent-enrollment-secret \
pnpm --filter @breeze/api check:migrations 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/fresh-db-autoMigrate.log
grep -n "partner-admin force_mfa reconcile" /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/fresh-db-autoMigrate.log
psql "postgresql://breeze_test:breeze_test@localhost:${PGPORT}/breeze_test_fresh" -tAc \
  "SELECT name, is_system, partner_id IS NULL AS global, force_mfa FROM roles WHERE name = 'Partner Admin' ORDER BY global DESC"
psql "postgresql://breeze_test:breeze_test@localhost:${PGPORT}/postgres" -c 'DROP DATABASE breeze_test_fresh'
```
Expected: `[check-migrations] OK — all migrations applied`; the log shows `NOTICE: partner-admin force_mfa reconcile: 0 rows needed flipping` (the migration ran against an empty `roles` table — F4 demonstrated) followed by `[auto-migrate] No users found, running initial seed...`; the SELECT prints `Partner Admin|t|t|t` for the global template. If `check:migrations` fails on an unrelated env requirement, read the error, add only that variable with a throwaway value, and record it in the evidence log. Do NOT run this against `breeze_test` itself.

- [ ] **Step 9: Commit (the pre-commit hook runs the naming guard again)**

```bash
git commit -m "fix(db): forward migration reconciles system Partner Admin force_mfa (RMM-QA-164 D4/D5)

2026-09-30-100000-partner-admin-force-mfa-reconcile.sql flips every
scope='partner' AND is_system Partner Admin row still at force_mfa=false
(global template and tenant copies), logs the count, and is a no-op on
re-apply. Custom is_system=false rows are excluded by construction. Each
flipped tenant row bumps its members' permissions_epoch once (intended:
one-time cache invalidation + 428 enrollment wall until they enrol);
MFA_FORCE_FOR_PARTNER_ADMIN=false is the relief valve.

RED before this change:
  partnerAdminForceMfaMigration.integration.test.ts: ENOENT ... 2026-09-30-100000-partner-admin-force-mfa-reconcile.sql
  autoMigrate.test.ts 'resolves every core migration path': <paste line>

Mutation controls (verified red, then reverted): drop is_system predicate
→ custom row flips; drop scope predicate → organization-scope row flips;
drop force_mfa=false predicate → re-apply reports 'flipped 2' not '0 rows'.

Fresh-DB apply (verified): check:migrations OK; migration logged '0 rows
needed flipping' against the empty roles table; seed then stored
force_mfa=true on the global template.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```
Expected: hook output `check-migration-naming: OK` (and the confidential scan OK) before the commit lands.

---

### Task 5: Make the relief valve reachable in the self-host stack (D6)

**Files:**
- Modify: `.env.example` (after line 799 `ENABLE_2FA=true`)
- Modify: `docker-compose.yml` (after line 278 `  ENABLE_2FA: ${ENABLE_2FA:-}` in the shared api environment block)
- Gate (no edit): `apps/api/src/config/envComposeParity.test.ts`

**Interfaces:**
- Produces: `MFA_FORCE_FOR_PARTNER_ADMIN` reaches the `api` (and `worker`, same anchor) container via `${MFA_FORCE_FOR_PARTNER_ADMIN:-}`; unset → empty string → `envFlag` default `true` (non-regressive).

- [ ] **Step 1: Document the knob first (this is the RED — the parity guard fails on a documented-but-unmapped var)**

In `.env.example`, directly after the line `ENABLE_2FA=true` (line 799), insert:

```
# Kill-switch for the role-level MFA gate. Defaults ON: members of a
# force_mfa role — the system Partner Admin role on every install since
# RMM-QA-164 — are minted mfa=false and receive 428 mfa_enrollment_required
# until they enrol at /auth/mfa/setup. Flip to false ONLY to relieve an
# enrollment outage that locks operators out; it suppresses the role-force
# component alone (settings-driven requireMfa stays enforced) and is read
# at call time, so no code deploy is needed. Mirrors deploy/.env.example.
# MFA_FORCE_FOR_PARTNER_ADMIN=true
```

- [ ] **Step 2: Run the parity guard to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/config/envComposeParity.test.ts 2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/D6-red.log`
Expected: FAIL in `.env.example ↔ compose parity: self-host` — `These vars are in .env.example but never reach a container ... MFA_FORCE_FOR_PARTNER_ADMIN`.

- [ ] **Step 3: Map the variable in the root compose**

In `docker-compose.yml`, directly after `  ENABLE_2FA: ${ENABLE_2FA:-}` (line 278) insert, at the same indentation:

```yaml
  # RMM-QA-164 relief valve (see .env.example). Empty when unset → envFlag
  # default true; mapped so a locked-out self-hoster can actually flip it.
  MFA_FORCE_FOR_PARTNER_ADMIN: ${MFA_FORCE_FOR_PARTNER_ADMIN:-}
```

- [ ] **Step 4: Run the parity guard and the compose mount guard to verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts`
Expected: all pass (both pairs, no stale/redundant allow-list entries).

- [ ] **Step 5: Mutation control**

Remove the compose line → run the parity test → FAIL (same message as Step 2). Restore → pass. (Step 2 already is this red; note it in the commit as the control.)

- [ ] **Step 6: Commit**

```bash
git add .env.example docker-compose.yml
git commit -m "chore(compose): thread MFA_FORCE_FOR_PARTNER_ADMIN through the self-host stack (RMM-QA-164 D6)

Without this a self-hoster locked out by the reconcile migration had no
documented escape short of psql: the valve was mapped only in
deploy/docker-compose.prod.yml. \${VAR:-} passes '' when unset, which
envFlag treats as unset (default true) — non-regressive.

RED before this change (envComposeParity.test.ts, after documenting the
var in .env.example): <paste the 'never reach a container' line>

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 6: CI smoke keeps reachability via the valve and asserts the stored flag; local e2e note (D7)

**Files:**
- Modify: `.github/workflows/ci.yml` — `smoke-test` job only: the `Create .env` heredoc (lines 2055-2110) and the `Login and export token` step (lines 2152-2165); add one step after it
- Modify: `e2e-tests/README.md` — add a subsection under `## Configuration` (after the table ending at line 144)

**Interfaces:**
- Consumes: Task 5 (the root compose must map the valve, otherwise `MFA_FORCE_FOR_PARTNER_ADMIN=false` in the smoke `.env` is inert). Compose postgres service: `postgres`, user `${POSTGRES_USER:-breeze}`, db `${POSTGRES_DB:-breeze}` (`docker-compose.yml:585-593`), reachable via `docker compose ... exec -T postgres psql`.
- Not affected (verified by grep): `ci-smoke-binary-source-github.yml` / `ci-smoke-binary-source-local.yml` boot a stack with a bootstrap admin but never log in or call an authenticated route; `auth-browser-transition` exercises only `/auth/*`.

- [ ] **Step 1: Add the valve to the smoke stack's `.env`**

In `.github/workflows/ci.yml`, inside the `cat > .env <<'EOF'` heredoc of the `smoke-test` job, directly after the `IS_HOSTED=false` line, insert (keep the heredoc's 10-space indentation):

```
          # RMM-QA-164: fresh installs now seed the system Partner Admin role
          # with force_mfa=true, so the bootstrap admin would be minted
          # mfa=false and get 428 mfa_enrollment_required on every
          # authMiddleware-gated GET below. This sweep is about endpoint
          # reachability, not the MFA wall (proven by the real-Postgres
          # suites), so use the documented relief valve. The stored flag is
          # still asserted with the valve off — see the step after login.
          MFA_FORCE_FOR_PARTNER_ADMIN=false
```

- [ ] **Step 2: Assert the valve is honoured in the login step**

Replace the body of the `Login and export token` step with:

```yaml
      - name: Login and export token
        id: login
        run: |
          RESPONSE=$(curl -sf -X POST http://localhost:3001/api/v1/auth/login \
            -H 'Content-Type: application/json' \
            -d '{"email":"ci-admin@breeze.local","password":"ci-smoke-bootstrap-credential-32-chars"}')
          TOKEN=$(echo "${RESPONSE}" | jq -r '.tokens.accessToken // .token // .accessToken // empty')
          if [ -z "${TOKEN}" ]; then
            echo "Login failed — no token in response"
            exit 1
          fi
          echo "::add-mask::${TOKEN}"
          echo "token=${TOKEN}" >> "$GITHUB_OUTPUT"
          # RMM-QA-164: with MFA_FORCE_FOR_PARTNER_ADMIN=false in this stack's
          # .env the role-force component must be suppressed end to end
          # (proves the root compose actually threads the valve, D6).
          ENROLL=$(echo "${RESPONSE}" | jq -r '.mfaEnrollmentRequired')
          echo "mfaEnrollmentRequired=${ENROLL} (expected false: relief valve set in .env)"
          if [ "${ENROLL}" != "false" ]; then
            echo "ERROR: relief valve MFA_FORCE_FOR_PARTNER_ADMIN=false was not honoured by the api container"
            exit 1
          fi
          echo "Login successful."
```

- [ ] **Step 3: Add the stored-flag assertion step immediately after it**

```yaml
      - name: Assert seeded Partner Admin stores force_mfa=true (RMM-QA-164)
        run: |
          # The finding's headline symptom was "fresh stack stored false".
          # This reads the seeded global template straight from Postgres,
          # independent of the relief valve (which only affects enforcement).
          STORED=$(docker compose -f docker-compose.yml -f docker-compose.override.yml.ci \
            exec -T postgres psql -U breeze -d breeze -tAc \
            "SELECT force_mfa FROM roles WHERE name = 'Partner Admin' AND is_system AND partner_id IS NULL")
          echo "roles.force_mfa for the seeded system Partner Admin template: '${STORED}'"
          if [ "${STORED}" != "t" ]; then
            echo "ERROR: fresh-stack seed stored force_mfa='${STORED}' (expected 't')"
            exit 1
          fi
```

- [ ] **Step 4: Validate the workflow YAML parses**

Run from the worktree root: `pnpm dlx js-yaml@4 .github/workflows/ci.yml > /dev/null && echo yaml-ok`
Expected: `yaml-ok`. (If `pnpm dlx` is unavailable offline, `node -e "require('yaml')"` is not guaranteed either — fall back to `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml"); puts "yaml-ok"'`, which ships with macOS.) The smoke job itself runs post-push (Task 8); it is non-blocking on PRs, so its log — not its check colour — is the evidence.

- [ ] **Step 5: e2e README note**

In `e2e-tests/README.md`, after the `## Configuration` table (after the `REDIS_PASSWORD` row, before `## Troubleshooting`), insert:

```markdown
### Seeded admin and forced MFA (RMM-QA-164)

A fresh stack seeds the system Partner Admin role with `force_mfa = true`, so the
seeded `admin@breeze.local` (or your `BREEZE_BOOTSTRAP_ADMIN_EMAIL`) is minted
`mfa: false` and receives `428 mfa_enrollment_required` on the first protected
request — `globalSetup`'s login lands on `/auth/mfa/setup?forced=1` instead of the
dashboard. Pick one before running the suite:

- enrol TOTP for that admin once (Settings → Security → Two-factor), or
- set `MFA_FORCE_FOR_PARTNER_ADMIN=false` in the stack's `.env` (the documented
  relief valve; it suppresses only the role-force component) and restart `api`.
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml e2e-tests/README.md
git commit -m "ci(smoke): relief valve off + stored force_mfa assertion; e2e README note (RMM-QA-164 D7)

The smoke sweep logs in as the bootstrap admin and expects 200 from ~20
authMiddleware-gated GETs; with the seeded template now forced it would
428 on every one. MFA_FORCE_FOR_PARTNER_ADMIN=false keeps the sweep about
reachability, the login step asserts the valve is honoured end to end
(D6), and a new step reads roles.force_mfa from Postgres — the compose
replica of the finding's 'fresh stack stored false'.

Not executed locally (runs post-push; job is non-blocking on PRs — read
its log, do not trust the check colour).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 7: Verification battery and evidence capture (spec §5)

**Files:** none modified. Outputs go to `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/`.

- [ ] **Step 1: Unit battery (Test API job scope) + typecheck**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/db/seed.test.ts src/services/partnerCreate.test.ts src/db/autoMigrate.test.ts \
  src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts \
  src/middleware/auth.test.ts src/routes/auth/login.test.ts src/services/mfaPolicy.test.ts \
  src/routes/auth.test.ts src/config/env.test.ts \
  2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/unit-battery.log
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit
```
Expected: all pass; tsc exit 0. Record counts. The regression evidence the PR cites without edits: `auth.test.ts` `requireMfa` → "rejects when token.mfa is false" (line ~1035); `login.test.ts` "mints mfa:false and returns mfaEnrollmentRequired:true ..." (line 770); the TOTP/recovery stale-pending suites in `routes/auth.test.ts`.

- [ ] **Step 2: Real-Postgres battery on the private stack**

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/seedPartnerAdminForceMfa.integration.test.ts \
  src/__tests__/integration/partnerAdminForceMfaMigration.integration.test.ts \
  src/__tests__/integration/registerPartnerMfaPolicy.integration.test.ts \
  src/__tests__/integration/seed-idempotency.integration.test.ts \
  src/__tests__/integration/permission-epoch.integration.test.ts \
  src/__tests__/integration/emailRecoveryRegistration.integration.test.ts \
  src/__tests__/integration/auth-browser-transition.integration.test.ts \
  src/__tests__/integration/pendingMfaEpoch.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  2>&1 | tee /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/integration-battery.log
```
Expected: all pass; `rls-coverage` unchanged (no new table/column).

- [ ] **Step 3: Drift check and shipped-migration immutability**

```bash
set -a; . ./.env.test; set +a
# Run the api script directly (not the turbo-wrapped root `pnpm db:check-drift`):
# turbo strips env vars not declared in turbo.json, and DATABASE_URL is what
# points the drift check at the private stack.
DATABASE_URL="$DATABASE_URL" pnpm --filter @breeze/api db:check-drift 2>&1 | tail -5
bash scripts/check-migration-immutability.sh
git diff --stat origin/main -- apps/api/migrations/2026-05-25-f-role-force-mfa.sql
```
Expected: drift check reports no drift (no schema change in this PR; if the tool reports pre-existing drift unrelated to `roles`, record it verbatim and label it pre-existing); immutability guard OK; empty diff for the shipped migration.

- [ ] **Step 4: Blank compose-stack replay of the QA symptom (conditional)**

This is the exit-evidence row's own shape (fresh stack, bootstrap admin login, `requireMfa()` write). It needs host ports 3001/4321/4322/5432/6379 (the CI override publishes them). Check first:
```bash
for p in 3001 4321 4322 5432 6379; do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null && echo "BUSY $p"; done
```
If any port is busy, **do not** stop the other stack; record `not executed: host port collision (<ports>)` in the handback under "Candidate-bound evidence still required" and skip to Step 5.

Otherwise, from the worktree root:
```bash
cp .env .env.rmmqa164.bak 2>/dev/null || true
sed -n '/cat > .env <<'"'"'EOF'"'"'/,/^          EOF$/p' .github/workflows/ci.yml | sed '1d;$d' | sed 's/^          //' > .env
grep -q '^MFA_FORCE_FOR_PARTNER_ADMIN=false' .env && sed -i '' 's/^MFA_FORCE_FOR_PARTNER_ADMIN=false/# valve ON for the replay/' .env
docker compose -p rmmqa164 -f docker-compose.yml -f docker-compose.override.yml.ci up --build -d
timeout 180 bash -c 'until curl -sf http://localhost:3001/health/ready >/dev/null; do sleep 3; done'
RESPONSE=$(curl -s -X POST http://localhost:3001/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"ci-admin@breeze.local","password":"ci-smoke-bootstrap-credential-32-chars"}')
echo "$RESPONSE" | jq '{mfaEnrollmentRequired, enrollUrl, mfaEnabled: .user.mfaEnabled}'
TOKEN=$(echo "$RESPONSE" | jq -r '.tokens.accessToken')
node -e 'const t=process.argv[1].split(".")[1];console.log(JSON.parse(Buffer.from(t,"base64url")).mfa)' "$TOKEN"
curl -s -o /dev/null -w 'protected GET /devices → %{http_code}\n' -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/devices
docker compose -p rmmqa164 -f docker-compose.yml -f docker-compose.override.yml.ci exec -T postgres psql -U breeze -d breeze -tAc \
  "SELECT force_mfa FROM roles WHERE name = 'Partner Admin' AND is_system AND partner_id IS NULL"
docker compose -p rmmqa164 -f docker-compose.yml -f docker-compose.override.yml.ci down -v
[ -f .env.rmmqa164.bak ] && mv .env.rmmqa164.bak .env || rm -f .env
```
Expected (valve ON — the shipped default): `mfaEnrollmentRequired: true`, `enrollUrl: "/auth/mfa/setup"`, decoded claim `false`, the protected GET returns `428`, the SELECT prints `t`. Save the transcript to `.../rmm-qa-164-evidence/blank-stack-replay.log`. The row's "command-free invalid write behind `requireMfa()`" is the same gate: the 428 lands before any handler, so child validation is unreachable; record the 428 as that clause's evidence.

- [ ] **Step 5: Tear down the private test stack**

Run: `pnpm test-stack down`
Expected: containers and the generated `.env.test` removed.

---

### Task 8: Push the branch and open the DRAFT PR with the handback record

**Files:** none modified.

- [ ] **Step 1: Final state check**

```bash
git status --short          # expected: clean
git log --oneline origin/main..HEAD
```
Expected: 7 commits (Task 0 docs, Tasks 1–6), no stray files.

- [ ] **Step 2: Push**

Run: `git push -u origin fix/rmm-qa-164-partner-admin-force-mfa-seed`

- [ ] **Step 3: Write the PR body**

Write `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/pr-body.md`. Fill every `<...>` from the evidence logs; label each claim `verified` / `inferred` / `not executed`. Template:

```markdown
## RMM-QA-164 — system Partner Admin roles store `force_mfa = true` on every creation path

Spec: `docs/superpowers/specs/2026-09-01-rmm-qa-164-partner-admin-force-mfa-seed-design.md` · Plan: `docs/superpowers/plans/2026-09-01-rmm-qa-164-partner-admin-force-mfa-seed.md`

### Rollout note
On the first boot after upgrade, `2026-09-30-100000-partner-admin-force-mfa-reconcile.sql` flips every system Partner Admin role that is still `force_mfa = false` — the global template and one row per tenant. Each flipped tenant row bumps `permissions_epoch` for that tenant's Partner Admin members (one-time cache invalidation), and every Partner Admin without an enrolled factor receives `428 mfa_enrollment_required` on their next non-exempt request until they enrol at `/auth/mfa/setup` (the web app redirects there automatically). Fresh installs seed the flag directly, so the bootstrap admin must enrol MFA before the setup wizard's protected calls succeed. Relief valve, if an enrolment outage locks operators out: `MFA_FORCE_FOR_PARTNER_ADMIN=false` in `.env` (now mapped in the root compose as well as the prod compose), which suppresses only the role-force component; settings-driven `requireMfa` stays enforced. The migration logs the flipped-row count as a `WARNING` (or `NOTICE … 0 rows`) in the Postgres log.

### Implementation handback record

Finding IDs: RMM-QA-164
Branch / commit / PR: fix/rmm-qa-164-partner-admin-force-mfa-seed / <head SHA> / <PR URL, filled after create>
Behavior changed: SYSTEM_ROLES declares forceMfa (only Partner Admin true); seedRoles() matches only the global template (is_system, partner_id/org_id NULL), inserts the flag and reconciles false→true one-directionally; createPartner() inserts the tenant Partner Admin copy with forceMfa: true; new forward migration flips remaining system partner-scope Partner Admin rows (idempotent, count logged); MFA_FORCE_FOR_PARTNER_ADMIN mapped in the root compose + documented in .env.example; CI smoke sets the valve off, asserts the valve is honoured and that the seeded template stores 't'; e2e README note. No change to mfaPolicy.ts, login.ts, verifyEmail.ts, middleware/auth.ts, apps/web, or any shipped migration.
Exit-contract clauses proved: (1) forceMfa=true defined and reconciled for every system/tenant Partner Admin creation path — T1 (verified), T2 (a)(b)(c)(e) (verified), T3/T4 (verified), T5 (verified); (2) blank-DB migrate+seed stores the flag — fresh-DB check:migrations + SELECT (verified, Task 4 Step 8) and <blank compose-stack replay: verified | not executed: <reason>>; (3) registration test asserts the stored flag with no trigger — T4 (verified); (4) password-only admin receives enrollment-required plus mfa=false — T4 verify-email mint (verified), login.test.ts:770 (verified, mocked policy), <blank-stack login: verified | not executed>; (5) requireMfa rejects false assurance — middleware/auth.test.ts "rejects when token.mfa is false", routes/auth.test.ts TOTP/recovery stale-pending suites, pendingMfaEpoch (all verified green, unchanged).
Exit-contract clauses still open: candidate-bound re-run of `run-local-partner-role-matrix.mjs` on a blank stack by the QA coordinator; <blank-stack login-route mint if not executed above>; web immediate navigation on mfaEnrollmentRequired is a follow-up (D8), not a clause of this row.
Tests run and exact results: <paste pass/fail counts per file from unit-battery.log and integration-battery.log>; tsc: exit 0; check-migration-naming --staged: OK; autoMigrate.test.ts: pass; fresh-DB check:migrations: OK with 'NOTICE: partner-admin force_mfa reconcile: 0 rows needed flipping'; db:check-drift: <result>.
Migration / RLS / config / rollout impact: one new migration (see rollout note; epoch bump per flipped tenant row; 428 wall for unenrolled Partner Admins); no RLS/cascade/export-policy registry change (no new table or column); config: MFA_FORCE_FOR_PARTNER_ADMIN now reachable in the root compose; CI: smoke job .env + 2 assertions.
Security and tenant/site negative cases: custom is_system=false 'Partner Admin' never flipped (T2 (c)(e), T5); tenant copy never touched by the seed (T2 (c)); organization-scope system row named 'Partner Admin' not flipped by the migration (T5); Org Admin opt-in never lowered (T2 (d)) and not raised (T1, T5); kill switch honoured (T4 control, smoke login assertion); ENABLE_2FA short-circuit proven non-vacuous (T4 mutation 2).
Operator/UI states checked: not executed — no web change (D8); the existing 428 handler redirect to /auth/mfa/setup?forced=1 is unchanged and untested here.
Candidate-bound evidence still required: blank-stack replay via the QA harness (`run-local-partner-role-matrix.mjs`) on the release candidate; smoke-job log inspection on this PR's head (non-blocking job); hosted/self-hosted reconcile counts from real Postgres logs at first boot.

### RED evidence retained
<paste the key failure lines from T1-red.log, T2-red.log, T3-red.log, T4-red.log, T5-red.log, D6-red.log>

### Mutation controls (each verified red, then reverted)
<one line per control from T1/T2/T3-T4/T5 mutation logs>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu
```

- [ ] **Step 4: Open the draft PR**

```bash
gh pr create --draft --base main \
  --title "fix(auth): system Partner Admin roles store force_mfa=true on every creation path (RMM-QA-164)" \
  --body-file /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1/rmm-qa-164-evidence/pr-body.md
```
Then edit the body once to fill `Branch / commit / PR:` with the returned URL: `gh pr edit <number> --body-file <same file after editing>`.

- [ ] **Step 5: Confirm CI attached to the exact head and read the smoke log**

```bash
gh pr checks <number> --watch
gh run list --branch fix/rmm-qa-164-partner-admin-force-mfa-seed --limit 5
gh run view <smoke run id> --log | grep -n "roles.force_mfa for the seeded\|mfaEnrollmentRequired=\|All API smoke tests passed"
```
Expected: `roles.force_mfa ... 't'`, `mfaEnrollmentRequired=false (expected false ...)`, and the sweep passing. Paste those three lines into the PR body's "Tests run" line (`gh pr edit`). If the smoke job shows a stale or missing run for this head, say so explicitly — the job is non-blocking on PRs and a green check without the new lines is not evidence.

- [ ] **Step 6: Return**

Report: PR URL, head SHA, the evidence directory path, and any clause recorded as `not executed`. Do not merge; do not push to `main`.

---

## Self-review (run by the plan author, 2026-09-01)

**Spec coverage:** D1→Task 1; D2→Task 2; D3/D12→Task 3; D4/D5→Task 4; D6→Task 5; D7→Task 6; D8/D9/D10/D11/D13→non-goals honoured (no web/mfaPolicy edits; Org Admin false everywhere; custom roles pinned by T2 (c)(e) and T5); §4 T1–T5→Tasks 1–4 with the listed mutations; §5 battery→Task 7; §6 rollout note→PR body; §7 ship sequence→task order (spec's "RED commits then GREEN commits" collapsed to RED→GREEN per task, failing output retained in each commit message as the spec requires); §8 Codex note→header.

**Placeholders:** the only `<...>` tokens are evidence values that exist only after execution (log lines, SHAs, PR URL) — every code, SQL, YAML, and command block is complete.

**Type consistency:** `SystemRoleDefinition.forceMfa: boolean` (Task 1) is read as `roleDef.forceMfa` (Task 2); `roles.forceMfa` (Drizzle column, `schema/users.ts:97`) is used in Tasks 2–4; migration filename is identical in Task 4 Steps 0, 1, 3, 9 and the PR body; env var name `MFA_FORCE_FOR_PARTNER_ADMIN` identical in Tasks 3, 5, 6, 7, 8; the notice strings in the migration (`flipped % system Partner Admin role(s)`, `0 rows needed flipping`) match T5's regexes.

---

## Execution notes — fix round 2 (2026-09-01, after the independent review)

Recorded so the plan matches what shipped; the PR body carries the evidence.

1. **Review payload was empty.** The independent review handed back for this round
   contained no findings — only the reviewer's in-flight status line. The reviewer's
   workspace showed: unit 394/394 green, integration baseline 13/13 green, `tsc`
   crashed with `FATAL ERROR: ... JavaScript heap out of memory` (exit 134 — run
   without the plan's `NODE_OPTIONS=--max-old-space-size=8192`), and an 11-mutation
   control script that never produced its log. Refuted by re-running `tsc` with the
   plan's flag (exit 0) and by running the reviewer's own script to completion
   (11/11 discriminate). A bounded read-only Codex pass was then run as the round's
   independent review; its findings are items 3 and 4.
2. **Migration renamed again** to `2026-10-01-200000-…`: `origin/main` gained
   `2026-10-01-100000-ai-agents-graduation-evidence.sql` after the branch was pushed
   (rule 3 of `check-migration-naming.sh`; comparator evidence in the commit). Never
   shipped; private-stack ledger row deleted and re-recorded.
3. **IMPORTANT (Codex, confirmed): the reconcile UPDATE was RLS-blind.** `roles` is
   FORCE RLS and `breeze_current_scope()` defaults to `'none'`, so on managed
   Postgres (non-superuser `DATABASE_URL`) the UPDATE matched zero rows and the
   ledger still recorded the file — the trap `2026-09-30-100000-rls-scoped-backfill-replay.sql`
   documents. Fixed with `SELECT set_config('breeze.scope','system', true);` (repo
   convention); RED-first via a `breeze_app` (NOSUPERUSER NOBYPASSRLS, asserted)
   replay in `partnerAdminForceMfaMigration.integration.test.ts`. Adds to Task 4's
   mutation list: set_config removed → `0 rows needed flipping` on the non-bypass
   apply while the superuser case stays green (the masking, demonstrated).
4. **MINOR ×2 (Codex, both taken): `seedRoles()` lookup pins `scope`.** The
   migration's ownership boundary is `scope='partner' AND is_system`; the seed
   lookup was looser (name + is_system + null tenant axes). Test (f) in
   `seedPartnerAdminForceMfa.integration.test.ts` covers an organization-scope
   global system row AND a tenant-copy-only collision with the template absent, so
   `scope` and `partner_id IS NULL` are each pinned by their own mutation.
5. **Task 7 Step 4 executed this round** (ports were free): blank compose stack,
   valve ON — `mfaEnrollmentRequired:true`, claim `mfa=false`, `GET /devices` 428,
   command-free `POST /scripts {}` 428 (`mfa_enrollment_required`, before any
   handler), stored template `t`.

## September 5 continuation of PR #4491

The branch was merged forward from `27a9677cb6` onto main `a52504b9ee` in
`c6f5749682`, without textual conflicts or replayed rerere resolutions. Current
main still omitted the stored flag from both role creation paths; #4491 was the
only matching open implementation. The existing auth, seed, migration, compose,
and CI changes were retained.

The migration ordering guard failed because the unshipped October 1 reconcile
sorted before main's `2026-10-09-000600-rls-scoped-replay-v0110.sql`. Commit
`96c8ebbbbc` renames it to
`2026-10-09-000700-partner-admin-force-mfa-reconcile.sql` and updates the replay
test. The SQL bytes are unchanged. This filename supersedes earlier filenames in
the historical instructions and execution records above. Active design and seed
comments were updated in `f23f499998`.

Verification on this continuation:

- Full API battery: 1,864 files passed / 3 skipped; 34,591 tests passed /
  21 skipped, exit 0 (617.48 seconds, two workers).
- Focused unit battery: 10 files, 556 tests passed.
- Real-Postgres battery: 8 files, 46 tests passed, including the explicit
  NOSUPERUSER/NOBYPASSRLS migration replay and permission-epoch checks.
- RLS coverage: 100 tests passed. API typecheck and lint passed.
- Mutation controls discriminated the seed and tenant-role literals (two unit
  failures), the actual registration role flag (one integration failure), and
  transaction-local system scope (non-bypass replay failed with zero rows while
  the superuser replay passed). Mutations were restored; the three affected
  real-DB suites then passed all 14 tests.
- A separate empty database applied every migration and then seeded roles. The
  request-pool override was scrubbed so seed and migration targeted that same
  database. The global Partner Admin row stored `force_mfa=true`.
- The actual API booted against that fresh database with forced MFA enabled.
  Seeded-admin login returned HTTP 200, `mfaEnrollmentRequired=true`, enrollment
  URL `/auth/mfa/setup`, and access-token assurance `mfa=false`. A command-free
  invalid write to `/api/v1/scripts/import/not-a-uuid` returned HTTP 428
  `mfa_enrollment_required`, before parameter validation or a write handler.
- Migration naming passed against current main; released migration immutability
  passed against `v0.109.0` after fetching complete release ancestry. The ledger
  drift check matched all 675 migration files. CI and compose YAML parsed.

The first full API run crossed a confirmed 1,019-second host sleep and ended
with timeout/configuration failures and a fork-start timeout. The three affected
files passed all 13 tests unchanged on an immediate rerun. A clean full run
passed with a child-scoped idle-sleep inhibitor; test timeouts remained unchanged.

Independent review of the branch's auth, seed, migration, tests and CI changes
found no blocking regressions. The API replay is branch-local acceptance; it is
not composed release-candidate evidence or a deployment claim. No production
state was changed.

### CI fixture follow-up

Run `33986111044` at `88a32850f7` exposed two newer-main fixture gaps:
Portal Dev E2E attempted organization creation with an unenrolled seeded admin
and received HTTP 428; Guided Setup Smoke completed its installer checks but
received the same 428 at its post-reboot remote-session trust assertion. These
were consequences of the corrected seed posture, not hydration or installer
failures. The dedicated Auth Browser Transition and existing Smoke Test jobs
passed on that head.

The portal hydration fixture and installer smoke now explicitly use the
documented role-only relief valve. The installer writes it into its staged
`.env` so it survives the systemd reboot. Login assertions require explicit
`mfaEnrollmentRequired=false`, including after reboot. The portal fixture also
asserts that its stored global Partner Admin still has `force_mfa=true`.
Production defaults and the forced-MFA acceptance tests remain unchanged.

Local verification: five related suites passed all 214 tests; workflow YAML
parsed; the installer and extracted workflow shell blocks passed `bash -n`.
Controls executed the actual portal guard and installer login helper with
stubbed dependencies: intended posture passed, enrollment-required login failed,
and a false stored role flag failed the portal guard. These are discrimination
controls, not live E2E evidence. Independent delta review found no actionable
findings. Portal and Guided Setup CI must rerun on the follow-up head before
claiming those jobs pass.
