# RMM-QA-220 Script Children RLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land forced parent-join RLS on `script_versions` and `script_to_tags`, make the RLS coverage catalog exhaustive over every public base table, add command-specific USING/WITH CHECK policy-shape checks, and prove the enforcement behaviourally as `breeze_app` for Org A/B and Partner A/B — every behaviour change RED-first with the failing output retained, every new control proven to discriminate by mutation.

**Architecture:** One new idempotent migration installs four per-command policies per table (canonical `2026-05-30-fk-child-tables-rls.sql` shape) whose nested `EXISTS` mirrors the parents' reviewed predicates: `script_versions` SELECT = the parent's full read predicate (org OR partner OR `is_system` OR own-partner read branch), writes = the parent's write predicate only; `script_to_tags` additionally requires the tag to be readable on SELECT/INSERT/UPDATE-check and derives unlink authority from the script's write predicate only. The contract test `rls-coverage.integration.test.ts` gains the two catalog entries (the retained RED), an exhaustive every-public-base-table classification test with a shrink-only debt bucket, and two command-specific shape tests backed by a pure matcher module `src/db/rlsPolicyShape.ts` (unit-tested in the Test API job). A forge suite as `breeze_app` and a bundle-import regression suite prove behaviour.

**Tech Stack:** PostgreSQL 16 RLS (`pg_policies`, `pg_class`), Drizzle ORM + postgres.js, Vitest (unit runner `vitest.config.ts`; rls-coverage runner `vitest.config.rls-coverage.ts`; integration runner `vitest.integration.config.ts`), per-worktree Docker test stack (`pnpm test-stack`).

**Spec:** `docs/superpowers/specs/2026-09-01-rmm-qa-220-script-children-rls-design.md` (same worktree). Decisions D1–D9, verified facts F1–F22 and the advisor-quorum record live there; this plan cites them by number.

## Global Constraints

- **Worktree (the ONLY tree you touch):** `/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-220` — a git worktree of `/Users/toddhebebrand/breeze`, branch `fix/rmm-qa-220-script-children-rls`, based on `origin/main` `1b733cedb`. Never touch any other worktree, never push to `main`, never merge. Every command below runs with the worktree root as `cwd` unless stated; `WT` denotes that absolute path.
- **Scratch logs (never committed):** `LOGS=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/rmm-qa-220-logs` (`mkdir -p "$LOGS"`). Every RED/GREEN/mutation run is teed there; commit messages quote from these files.
- **Rigor: HIGH** (auth / tenancy / shipped surfaces). Every behaviour change is RED-first and the failing output is retained verbatim in the commit message. Every new test control is proven to discriminate: mutate, watch it fail, revert, watch it pass — the mutation and its output are recorded in the commit message.
- **Install once, before anything else:** `pnpm install --frozen-lockfile` (the worktree has no `node_modules` yet).
- **Typecheck gate:** `NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit` (`apps/api/tsconfig.json` includes `src/**/*`, so test files are type-checked too).
- **Unit tests:** `pnpm --filter @breeze/api exec vitest run <paths>` (unit runner; no DB). Web tests (`pnpm --filter @breeze/web exec vitest run <paths>`) are not needed — this change touches no `apps/web` file.
- **Real-Postgres suites need the per-worktree stack:** `pnpm test-stack up` (from `WT`; writes `WT/.env.test` with ephemeral ports) and `pnpm test-stack down` when finished. **Never** run `pnpm --filter @breeze/api test:docker:up` — it targets the shared `:5433` containers another session may be using.
  - Integration runner (migrates the stack DB once via `globalSetup`): `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts <file>`.
  - RLS coverage runner (no migrations, no truncation — run it only AFTER an integration run has migrated the DB). Task 0 writes the CI-equivalent variables (`ci.yml:2006-2020`) to `$LOGS/rls-coverage.env`; every invocation is then `set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage` (append `-- -t '<test name>'` to run a subset). The shell is zsh, which does not word-split an unquoted `$VAR`, so never try `env $VARS cmd`. `vitest.config.rls-coverage.ts` loads `WT/.env.test` itself.
  - Postgres container name: `PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"` (project name derives from the branch: `breeze-test-fix-rmm-qa-220-script-children-rls`). `docker exec -i "$PG" psql -U breeze_test -d breeze_test` is the superuser shell; `breeze_test` may `SET ROLE breeze_app` to act as the unprivileged request role.
- **Migration hygiene (Task 5 only):** filename `apps/api/migrations/2026-09-30-100000-script-children-rls.sql` (sorts strictly after the current ceiling `2026-09-29-detach-ticket-runs-on-device-org-move.sql`; if `main` has grown past it at commit time pick the next `HHMMSS` that sorts last — never rename after commit). `bash scripts/check-migration-naming.sh --staged` (also runs from the `.githooks/pre-commit` hook) and `pnpm --filter @breeze/api check:migrations` against a fresh database. No inner `BEGIN;`/`COMMIT;` (`autoMigrate` wraps each file — CLAUDE.md, `migrations/README.md:54-56`; the verifier's "some migrations wrap in BEGIN" note is refuted by `grep -l '^BEGIN;' apps/api/migrations/2026-09-*.sql` → nothing). Idempotent: `DROP POLICY IF EXISTS` then `CREATE POLICY`. **Never edit a shipped migration** (`0001-baseline.sql` stays byte-identical).
- **Files you may touch** (spec §3): `apps/api/migrations/2026-09-30-100000-script-children-rls.sql` (new), `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`, `apps/api/src/db/rlsPolicyShape.ts` (new), `apps/api/src/db/rlsPolicyShape.test.ts` (new), `apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts` (new), and this plan/spec pair. **Nothing else** — in particular not `ensureAppRole.ts`, `scriptBundle/index.ts`, `aiToolsScripts.ts`, `routes/scripts.ts`, `tenantCascade.ts`, `orgMergeRegistry.ts`, `db/schema/scripts.ts`, nor anything under `/Users/toddhebebrand/breeze-rmm-qa/docs/qa/probes/` (the QA probe pins the PRE-fix state and is expected to flip; QA owns that).
- **Policy semantics that must not drift** (D2/D3, verifier concerns 1–3): `is_system` appears ONLY in the `script_versions`/`script_to_tags` SELECT predicates, never in INSERT/UPDATE/DELETE (`2026-06-13-catalog-partner-axis-rls.sql:62-68`, Discussion #633); unlink/UPDATE authority derives from the script WRITE predicate; UPDATE `WITH CHECK` re-applies the tag READ leg; no strict `s.org_id = t.org_id` tightening.
- **No existing assertion is weakened or removed.** New tests are added beside existing ones.
- **Commit trailer (every commit):**
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu
  ```
- **Codex (only if you run it, e.g. the optional pre-PR review in Task 7):** `codex exec "..." -s read-only -m gpt-5.6-sol -C <dir> < /dev/null` — always redirect stdin.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/api/src/db/rlsPolicyShape.ts` (new, pure) | Predicate-shape matchers: alias discovery for `FROM <parent> [AS] <alias>`, helper-on-parent-alias check (`any-of` / `all-of`), org-axis argument check, command→slot coverage (`coveredCommands`). No DB import. |
| `apps/api/src/db/rlsPolicyShape.test.ts` (new) | Fixture-driven unit test for the module (Test API job). |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | D4 catalog entries; D5 exhaustive classification + `PLATFORM_INFRASTRUCTURE_TABLES` + `UNREVIEWED_RLS_CLASSIFICATION_DEBT`; D6a/D6b command-specific tests + `PARENT_FK_REQUIRED_PARENTS_PER_COMMAND`; D7 forge describe. |
| `apps/api/migrations/2026-09-30-100000-script-children-rls.sql` (new) | D1–D3 DDL. |
| `apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts` (new) | D8 bundle-import regression under real RLS (org / partner-wide / system callers). |

Commit order (spec §4): (1) plan doc → (2) shape module + unit test → (3) catalog + D5 RED→partial-GREEN → (4) D6a/D6b → (5) D7 forge, committed RED → (6) migration, everything green → (7) D8 regression + mutation proof → (8) push + draft PR. Intermediate commits are allowed to be red in CI; the PR head must be green.

---

### Task 0: Bootstrap the worktree, the test stack, and the pre-fix baseline evidence

**Files:**
- Create: `docs/superpowers/plans/2026-09-01-rmm-qa-220-script-children-rls.md` (this file — commit it with the spec)
- No source changes.

**Interfaces:**
- Produces: a migrated per-worktree test DB (`WT/.env.test`), `$LOGS/baseline-*.log` evidence files, one commit containing spec + plan.

- [ ] **Step 1: Verify the worktree and branch**

```bash
WT=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-220
LOGS=/private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/rmm-qa-220-logs
mkdir -p "$LOGS"
cd "$WT" && git status --short && git branch --show-current && git log --oneline -1
```
Expected: branch `fix/rmm-qa-220-script-children-rls`; HEAD `1b733cedb` (or a fast-forward of it); untracked `docs/superpowers/specs/2026-09-01-rmm-qa-220-script-children-rls-design.md` and this plan. If the worktree is absent: `git -C /Users/toddhebebrand/breeze fetch origin main && git -C /Users/toddhebebrand/breeze worktree add /private/tmp/claude-501/-Users-toddhebebrand-breeze-rmm-qa/096c7d0d-b990-4dcd-8885-640bde845261/scratchpad/s1wt/rmm-qa-220 fix/rmm-qa-220-script-children-rls` (add `-b fix/rmm-qa-220-script-children-rls … origin/main` only if the branch does not exist).

- [ ] **Step 2: Install dependencies and confirm the typecheck baseline is clean**

```bash
cd "$WT" && pnpm install --frozen-lockfile 2>&1 | tail -3
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tee "$LOGS/baseline-tsc.log" | tail -3
```
Expected: `tsc` exits 0 with no output. If it does not, stop — the baseline is broken upstream and must be reported, not fixed here.

- [ ] **Step 3: Start the per-worktree stack and migrate it through the current checkout**

```bash
cd "$WT" && pnpm test-stack up 2>&1 | tee "$LOGS/baseline-stack-up.log" | tail -12
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/scripts-system-rls.integration.test.ts 2>&1 | tee "$LOGS/baseline-migrate.log" | tail -8
```
Expected: `[test-stack] project=breeze-test-fix-rmm-qa-220-script-children-rls`, a JSON block with `pgPort`/`redisPort`, `WT/.env.test` written; the integration run prints `[integration global-setup] Running migrations (once per run)...` then `Database ready for testing`, and `scripts-system-rls` passes (3 tests). The DB is now migrated exactly to the checkout (no new migration yet).

- [ ] **Step 4: Record the pre-fix catalog proof (the QA query from `docs/qa/evidence/2026-08-23-core-tenant-isolation.md:31-35`)**

```bash
PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"
docker exec -i "$PG" psql -U breeze_test -d breeze_test -At <<'SQL' | tee "$LOGS/baseline-catalog-prefix.log"
SELECT json_agg(row_to_json(t)) FROM (
  SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls,
         has_table_privilege('breeze_app', c.oid, 'SELECT') AS app_select,
         has_table_privilege('breeze_app', c.oid, 'INSERT') AS app_insert,
         has_table_privilege('breeze_app', c.oid, 'UPDATE') AS app_update,
         has_table_privilege('breeze_app', c.oid, 'DELETE') AS app_delete
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('script_to_tags','script_versions') ORDER BY 1) t;
SQL
docker exec -i "$PG" psql -U breeze_test -d breeze_test -At -c "SELECT max(filename) FROM breeze_migrations" | tee "$LOGS/baseline-ledger-max.log"
```
Expected: both rows `rls_enabled=false, force_rls=false, app_*=true` (the exact RMM-QA-220 proof, F3); ledger max `2026-09-29-detach-ticket-runs-on-device-org-move.sql`.

- [ ] **Step 5: Confirm the current rls-coverage contract is green on this DB (so every later RED is attributable to this branch)**

```bash
cat > "$LOGS/rls-coverage.env" <<'ENV'
JWT_SECRET=ci-smoke-k7x9Qm4pR2vL8nW5jT3yF6hB0cA1dE4gI7
APP_ENCRYPTION_KEY=ci-smoke-Xz9Lm3Kp7Wn2Qr5Tv8Yb0Hd4Fg6Jc1Ae3
MFA_ENCRYPTION_KEY=ci-smoke-Nm4Rp8Ws2Kv6Tq0Yh3Bd7Fg1Jc5Le9Ax2
NODE_ENV=test
DB_CONTEXTLESS_WRITE_STRICT=true
ENV
cd "$WT" && set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage 2>&1 | tee "$LOGS/baseline-rls-coverage.log" | tail -6
```
Expected: all tests pass (the count is whatever main ships; record it). If anything fails here, stop and report — do not proceed on a red baseline.

- [ ] **Step 6: Commit spec + plan**

```bash
cd "$WT" && git add docs/superpowers/specs/2026-09-01-rmm-qa-220-script-children-rls-design.md docs/superpowers/plans/2026-09-01-rmm-qa-220-script-children-rls.md
git commit -m "docs(qa): RMM-QA-220 script children RLS design + plan

Design (D1-D9) and executable plan for forced parent-join RLS on
script_versions / script_to_tags, exhaustive RLS catalog classification,
command-specific policy-shape checks and breeze_app forge proofs.

Pre-fix baseline (per-worktree stack, ledger max
2026-09-29-detach-ticket-runs-on-device-org-move.sql):
script_to_tags  rls_enabled=false force_rls=false app_select/insert/update/delete=true
script_versions rls_enabled=false force_rls=false app_select/insert/update/delete=true

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 1: `rlsPolicyShape` — pure command-specific predicate matchers (RED → GREEN → mutation proofs)

**Files:**
- Create: `apps/api/src/db/rlsPolicyShape.ts`
- Test: `apps/api/src/db/rlsPolicyShape.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3):
  ```ts
  export type Cmd = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
  export const RLS_CMDS: readonly Cmd[];
  export type PredicateSlot = 'qual' | 'with_check';
  export interface PolicyRow { policyname: string; cmd: string; permissive: string; qual: string | null; with_check: string | null }
  export type ParentRule = { kind: 'any-of'; parents: readonly string[] } | { kind: 'all-of'; parents: readonly string[] };
  export type PredicateMatcher = (pred: string | null, cmd: Cmd, slot: PredicateSlot) => boolean;
  export function normalizePredicate(pred: string | null): string;
  export function parentAliases(pred: string | null, parent: string): string[];
  export function predicateCoversParent(pred: string | null, parent: string): boolean;
  export function predicateCoversParents(pred: string | null, rule: ParentRule): boolean;
  export function predicateCoversOrgAxis(pred: string | null, table: string, idKeyed: boolean): boolean;
  export function coveredCommands(policies: readonly PolicyRow[], matches: PredicateMatcher): Set<Cmd>;
  ```

Why `src/db/` and not `src/__tests__/integration/`: the unit runner (`vitest.config.ts:15-16`) excludes `src/__tests__/integration/**` wholesale and the integration runner includes every `*.test.ts` there (F20). A pure function's unit test must live where the **Test API** job sees it.

Postgres semantics encoded (verified against the local DB's deparsed `pg_policies` text, e.g. `ticket_form_org_links`: `(EXISTS ( SELECT 1 FROM ticket_forms tf WHERE ((tf.id = ticket_form_org_links.form_id) AND (... breeze_has_org_access(tf.org_id) ... breeze_has_partner_access(tf.partner_id)))))`):
- SELECT/DELETE are governed by `qual` (USING); INSERT by `with_check`; UPDATE by BOTH.
- A `FOR UPDATE` / `FOR ALL` policy that omits WITH CHECK reuses USING as its check (`with_check` is NULL in `pg_policies`); the matcher applies that fallback ONLY for those two policy kinds.
- Deparsed text drops the `public.` prefix on helpers and can contain newlines → normalise whitespace first (F16).
- Only PERMISSIVE policies count.

- [ ] **Step 1: Write the failing unit test**

Create `apps/api/src/db/rlsPolicyShape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  coveredCommands,
  normalizePredicate,
  parentAliases,
  predicateCoversOrgAxis,
  predicateCoversParent,
  predicateCoversParents,
  type PolicyRow,
} from './rlsPolicyShape';

// Deparsed shapes copied from pg_policies on a migrated test DB (whitespace
// exactly as Postgres emits it, including the leading "( SELECT").
const SCRIPTS_JOIN_ORG =
  '(EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_versions.script_id) AND breeze_has_org_access(s.org_id))))';
const SCRIPTS_JOIN_PARTNER =
  '(EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_versions.script_id) AND breeze_has_partner_access(s.partner_id))))';
const BOTH_PARENTS =
  '((EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_to_tags.script_id) AND (breeze_has_org_access(s.org_id) OR breeze_has_partner_access(s.partner_id))))) ' +
  'AND (EXISTS ( SELECT 1 FROM script_tags t WHERE ((t.id = script_to_tags.tag_id) AND (breeze_has_org_access(t.org_id) OR breeze_has_partner_access(t.partner_id))))))';
const SCRIPTS_ONLY_PLUS_TAG_JOIN_NO_HELPER =
  '((EXISTS ( SELECT 1 FROM scripts s WHERE ((s.id = script_to_tags.script_id) AND breeze_has_org_access(s.org_id)))) ' +
  'AND (EXISTS ( SELECT 1 FROM script_tags t WHERE (t.id = script_to_tags.tag_id))))';
const HELPER_ON_OTHER_ALIAS =
  '(EXISTS ( SELECT 1 FROM scripts s, organizations o WHERE ((s.id = script_versions.script_id) AND breeze_has_org_access(o.org_id))))';
const HELPER_ON_CHILD_OWN_COLUMN =
  '(EXISTS ( SELECT 1 FROM scripts s WHERE (s.id = script_versions.script_id)) AND breeze_has_org_access(org_id))';
const UNALIASED_PARENT =
  '(EXISTS ( SELECT 1 FROM scripts WHERE ((scripts.id = script_versions.script_id) AND breeze_has_org_access(scripts.org_id))))';
const WITH_NEWLINES =
  '(EXISTS ( SELECT 1\n   FROM scripts s\n  WHERE ((s.id = script_versions.script_id)\n    AND breeze_has_org_access(s.org_id))))';

function policy(p: Partial<PolicyRow> & { cmd: string }): PolicyRow {
  return { policyname: p.policyname ?? 'p', cmd: p.cmd, permissive: p.permissive ?? 'PERMISSIVE', qual: p.qual ?? null, with_check: p.with_check ?? null };
}

const scriptsRule = (pred: string | null) => predicateCoversParents(pred, { kind: 'any-of', parents: ['scripts'] });

describe('rlsPolicyShape — parent aliases', () => {
  it('finds the alias declared after FROM <parent>', () => {
    expect(parentAliases(SCRIPTS_JOIN_ORG, 'scripts')).toEqual(['s']);
  });
  it('falls back to the bare parent name when FROM <parent> has no alias', () => {
    expect(parentAliases(UNALIASED_PARENT, 'scripts')).toEqual(['scripts']);
  });
  it('does not treat FROM script_tags as FROM scripts (word boundary)', () => {
    expect(parentAliases('(EXISTS ( SELECT 1 FROM script_tags t WHERE (t.id = x.tag_id)))', 'scripts')).toEqual([]);
  });
  it('normalises embedded newlines before matching', () => {
    expect(normalizePredicate(WITH_NEWLINES)).not.toContain('\n');
    expect(predicateCoversParent(WITH_NEWLINES, 'scripts')).toBe(true);
  });
});

describe('rlsPolicyShape — predicateCoversParent(s)', () => {
  it('accepts breeze_has_org_access on the parent alias', () => {
    expect(predicateCoversParent(SCRIPTS_JOIN_ORG, 'scripts')).toBe(true);
  });
  it('accepts breeze_has_partner_access on the parent alias (dual-axis parents)', () => {
    expect(predicateCoversParent(SCRIPTS_JOIN_PARTNER, 'scripts')).toBe(true);
  });
  it('rejects a helper applied to a non-parent alias even though FROM <parent> is present', () => {
    expect(predicateCoversParent(HELPER_ON_OTHER_ALIAS, 'scripts')).toBe(false);
  });
  it("rejects a helper applied to the child's own column", () => {
    expect(predicateCoversParent(HELPER_ON_CHILD_OWN_COLUMN, 'scripts')).toBe(false);
  });
  it('any-of: one covered parent suffices', () => {
    expect(predicateCoversParents(SCRIPTS_JOIN_ORG, { kind: 'any-of', parents: ['scripts', 'script_tags'] })).toBe(true);
  });
  it('all-of: every listed parent must carry a helper on its alias', () => {
    expect(predicateCoversParents(BOTH_PARENTS, { kind: 'all-of', parents: ['scripts', 'script_tags'] })).toBe(true);
    expect(predicateCoversParents(SCRIPTS_ONLY_PLUS_TAG_JOIN_NO_HELPER, { kind: 'all-of', parents: ['scripts', 'script_tags'] })).toBe(false);
  });
  it('null / empty predicate never covers', () => {
    expect(scriptsRule(null)).toBe(false);
    expect(scriptsRule('')).toBe(false);
  });
});

describe('rlsPolicyShape — predicateCoversOrgAxis', () => {
  it('accepts breeze_has_org_access(org_id) and breeze_has_org_access(<table>.org_id)', () => {
    expect(predicateCoversOrgAxis('breeze_has_org_access(org_id)', 'devices', false)).toBe(true);
    expect(predicateCoversOrgAxis('breeze_has_org_access(devices.org_id)', 'devices', false)).toBe(true);
  });
  it('rejects a helper on another alias or another column', () => {
    expect(predicateCoversOrgAxis('breeze_has_org_access(tf.org_id)', 'ticket_form_org_links', false)).toBe(false);
    expect(predicateCoversOrgAxis('breeze_has_org_access(partner_id)', 'devices', false)).toBe(false);
    expect(predicateCoversOrgAxis('breeze_has_partner_access(org_id)', 'devices', false)).toBe(false);
  });
  it('accepts breeze_has_org_access(id) only for id-keyed tables', () => {
    expect(predicateCoversOrgAxis('breeze_has_org_access(id)', 'organizations', true)).toBe(true);
    expect(predicateCoversOrgAxis('breeze_has_org_access(id)', 'devices', false)).toBe(false);
    expect(predicateCoversOrgAxis('breeze_has_org_access(org_id)', 'organizations', true)).toBe(false);
  });
});

describe('rlsPolicyShape — coveredCommands (command → slot)', () => {
  it('SELECT and DELETE are covered from qual only', () => {
    const covered = coveredCommands(
      [policy({ cmd: 'SELECT', qual: SCRIPTS_JOIN_ORG }), policy({ cmd: 'DELETE', qual: SCRIPTS_JOIN_ORG })],
      (pred) => scriptsRule(pred),
    );
    expect([...covered].sort()).toEqual(['DELETE', 'SELECT']);
  });
  it('a SELECT policy whose helper sits only in with_check does NOT cover SELECT (the QA-named blind spot)', () => {
    const covered = coveredCommands([policy({ cmd: 'SELECT', qual: 'true', with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred));
    expect(covered.size).toBe(0);
  });
  it('INSERT is covered from with_check only', () => {
    expect(coveredCommands([policy({ cmd: 'INSERT', with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).has('INSERT')).toBe(true);
    expect(coveredCommands([policy({ cmd: 'INSERT', qual: SCRIPTS_JOIN_ORG, with_check: 'true' })], (pred) => scriptsRule(pred)).has('INSERT')).toBe(false);
  });
  it('UPDATE needs BOTH qual and with_check', () => {
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: 'true' })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(false);
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: 'true', with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(false);
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(true);
  });
  it('UPDATE/ALL with a NULL with_check reuses qual as the check (Postgres default); INSERT-only policies do not', () => {
    expect(coveredCommands([policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: null })], (pred) => scriptsRule(pred)).has('UPDATE')).toBe(true);
    const all = coveredCommands([policy({ cmd: 'ALL', qual: SCRIPTS_JOIN_ORG, with_check: null })], (pred) => scriptsRule(pred));
    expect([...all].sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(coveredCommands([policy({ cmd: 'INSERT', qual: SCRIPTS_JOIN_ORG, with_check: null })], (pred) => scriptsRule(pred)).has('INSERT')).toBe(false);
  });
  it('cmd=ALL with an explicit with_check expands to all four, checking the right slot for each', () => {
    const covered = coveredCommands([policy({ cmd: 'ALL', qual: SCRIPTS_JOIN_ORG, with_check: 'true' })], (pred) => scriptsRule(pred));
    expect([...covered].sort()).toEqual(['DELETE', 'SELECT']);
  });
  it('RESTRICTIVE policies never count', () => {
    expect(coveredCommands([policy({ cmd: 'ALL', permissive: 'RESTRICTIVE', qual: SCRIPTS_JOIN_ORG, with_check: SCRIPTS_JOIN_ORG })], (pred) => scriptsRule(pred)).size).toBe(0);
  });
  it('the matcher receives cmd and slot so per-command overlays can differ (script_to_tags shape)', () => {
    const seen: string[] = [];
    coveredCommands(
      [policy({ cmd: 'UPDATE', qual: SCRIPTS_JOIN_ORG, with_check: BOTH_PARENTS })],
      (pred, cmd, slot) => { seen.push(`${cmd}:${slot}`); return true; },
    );
    expect(seen).toEqual(['UPDATE:qual', 'UPDATE:with_check']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$WT" && pnpm --filter @breeze/api exec vitest run src/db/rlsPolicyShape.test.ts 2>&1 | tee "$LOGS/task1-red.log" | tail -15
```
Expected: FAIL — `Failed to resolve import "./rlsPolicyShape"` (module does not exist). Keep the log.

- [ ] **Step 3: Write the module**

Create `apps/api/src/db/rlsPolicyShape.ts`:

```ts
/**
 * Pure predicate-shape matchers for the RLS coverage contract
 * (src/__tests__/integration/rls-coverage.integration.test.ts).
 *
 * Why this exists (RMM-QA-220): the contract used to accept a helper NAME
 * appearing anywhere in `qual OR with_check` as coverage for every DML
 * command. Postgres evaluates SELECT/DELETE against USING (`qual`), INSERT
 * against WITH CHECK (`with_check`), and UPDATE against BOTH — so a helper in
 * the wrong slot proves nothing for the command the policy governs. These
 * matchers are command-specific and argument-specific.
 *
 * Lives under src/db/ rather than src/__tests__/integration/ on purpose: the
 * unit runner (vitest.config.ts) excludes that directory wholesale and the
 * integration runner includes every *.test.ts in it, so a pure function's
 * unit test has to sit where the Test API job sees it and the real-DB setup
 * does not.
 *
 * Input is the deparsed text of pg_policies.qual / with_check. Postgres drops
 * the `public.` prefix on helper calls and may emit newlines, so callers get
 * whitespace-normalised matching for free.
 */
export type Cmd = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
export const RLS_CMDS: readonly Cmd[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
export type PredicateSlot = 'qual' | 'with_check';

export interface PolicyRow {
  policyname: string;
  /** 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL' (pg_policies.cmd). */
  cmd: string;
  /** 'PERMISSIVE' | 'RESTRICTIVE' (pg_policies.permissive). */
  permissive: string;
  qual: string | null;
  with_check: string | null;
}

export type ParentRule =
  /** Default parent-FK rule: a covering helper on ANY one declared parent alias. */
  | { kind: 'any-of'; parents: readonly string[] }
  /** Overlay: a covering helper on EVERY listed parent alias (script_to_tags). */
  | { kind: 'all-of'; parents: readonly string[] };

export type PredicateMatcher = (pred: string | null, cmd: Cmd, slot: PredicateSlot) => boolean;

// Tokens that can legally follow `FROM <parent>` and must not be mistaken
// for an alias when the join is unaliased.
const NOT_AN_ALIAS = new Set([
  'where', 'join', 'on', 'left', 'right', 'inner', 'cross', 'full', 'natural',
  'using', 'and', 'or', 'group', 'order', 'limit', 'union', 'except', 'intersect',
]);

export function normalizePredicate(pred: string | null): string {
  return (pred ?? '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every alias under which `parent` is joined in `pred` via
 * `FROM [public.]<parent> [AS] <alias>`; the bare parent name when the join
 * is unaliased. `\b` after the parent name keeps `FROM scripts` from matching
 * `FROM script_tags`.
 */
export function parentAliases(pred: string | null, parent: string): string[] {
  const text = normalizePredicate(pred);
  const re = new RegExp(
    `\\bFROM\\s+(?:public\\.)?${escapeRegExp(parent)}\\b(?:\\s+(?:AS\\s+)?([A-Za-z_][A-Za-z0-9_]*))?`,
    'gi',
  );
  const aliases: string[] = [];
  for (const m of text.matchAll(re)) {
    const candidate = m[1];
    aliases.push(candidate && !NOT_AN_ALIAS.has(candidate.toLowerCase()) ? candidate : parent);
  }
  return aliases;
}

function helperOnAlias(text: string, alias: string): boolean {
  const re = new RegExp(
    `\\bbreeze_has_(?:org|partner)_access\\(\\s*${escapeRegExp(alias)}\\.(?:org_id|partner_id)\\s*\\)`,
    'i',
  );
  return re.test(text);
}

/**
 * True when `pred` joins `parent` and applies breeze_has_org_access(<alias>.org_id)
 * or breeze_has_partner_access(<alias>.partner_id) to THAT alias. A helper on
 * the child's own column or on a non-parent alias does not count.
 */
export function predicateCoversParent(pred: string | null, parent: string): boolean {
  const text = normalizePredicate(pred);
  if (text === '') return false;
  return parentAliases(text, parent).some((alias) => helperOnAlias(text, alias));
}

export function predicateCoversParents(pred: string | null, rule: ParentRule): boolean {
  if (rule.parents.length === 0) return false;
  const covered = rule.parents.map((parent) => predicateCoversParent(pred, parent));
  return rule.kind === 'all-of' ? covered.every(Boolean) : covered.some(Boolean);
}

/**
 * Org-axis shape: breeze_has_org_access([<table>.]org_id) — or
 * breeze_has_org_access([<table>.]id) when `idKeyed` (organizations). Any
 * other alias or column is NOT this table's tenant expression.
 */
export function predicateCoversOrgAxis(pred: string | null, table: string, idKeyed: boolean): boolean {
  const text = normalizePredicate(pred);
  if (text === '') return false;
  const column = idKeyed ? 'id' : 'org_id';
  const re = new RegExp(
    `\\bbreeze_has_org_access\\(\\s*(?:(?:public\\.)?${escapeRegExp(table)}\\.)?${column}\\s*\\)`,
    'i',
  );
  return re.test(text);
}

/**
 * Commands covered by `policies` under `matches`:
 *   SELECT / DELETE ← qual; INSERT ← with_check; UPDATE ← qual AND with_check.
 * cmd='ALL' expands to all four. Only PERMISSIVE rows count. A FOR UPDATE or
 * FOR ALL policy that omitted WITH CHECK reuses USING as its check (Postgres
 * semantics; pg_policies then reports with_check = NULL) — a FOR INSERT policy
 * never gets that fallback, because Postgres requires WITH CHECK for it.
 */
export function coveredCommands(policies: readonly PolicyRow[], matches: PredicateMatcher): Set<Cmd> {
  const covered = new Set<Cmd>();
  for (const p of policies) {
    if (p.permissive !== 'PERMISSIVE') continue;
    const cmds: Cmd[] = p.cmd === 'ALL' ? [...RLS_CMDS] : RLS_CMDS.includes(p.cmd as Cmd) ? [p.cmd as Cmd] : [];
    const reusesQualAsCheck = p.cmd === 'ALL' || p.cmd === 'UPDATE';
    const check = p.with_check ?? (reusesQualAsCheck ? p.qual : null);
    for (const cmd of cmds) {
      let ok: boolean;
      if (cmd === 'SELECT' || cmd === 'DELETE') ok = matches(p.qual, cmd, 'qual');
      else if (cmd === 'INSERT') ok = matches(check, cmd, 'with_check');
      else ok = matches(p.qual, cmd, 'qual') && matches(check, cmd, 'with_check');
      if (ok) covered.add(cmd);
    }
  }
  return covered;
}
```

- [ ] **Step 4: Run the unit test to verify it passes; typecheck**

```bash
cd "$WT" && pnpm --filter @breeze/api exec vitest run src/db/rlsPolicyShape.test.ts 2>&1 | tee "$LOGS/task1-green.log" | tail -8
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tail -3
```
Expected: all tests in the file pass (22); `tsc` clean.

- [ ] **Step 5: Mutation proofs — each mutation must turn at least one fixture red; revert after each**

Run each mutation with `pnpm --filter @breeze/api exec vitest run src/db/rlsPolicyShape.test.ts 2>&1 | tee "$LOGS/task1-mut-<letter>.log" | grep -E '✓|✗|×|FAIL|Tests'` and note the failing test name, then restore the file (`git checkout -- apps/api/src/db/rlsPolicyShape.ts` is NOT available yet since the file is untracked — instead reverse the edit by hand or keep a copy: `cp apps/api/src/db/rlsPolicyShape.ts "$LOGS/rlsPolicyShape.ts.good"` before mutating, `cp` back after).

  - **Mutation A (whitespace):** in `normalizePredicate` return `(pred ?? '').trim()` (drop the `replace`). Expected red: `normalises embedded newlines before matching`.
  - **Mutation B (INSERT slot):** in `coveredCommands` change the INSERT branch to `ok = matches(p.qual, cmd, 'qual')`. Expected red: `INSERT is covered from with_check only` (and the `cmd=ALL … expands` fixture).
  - **Mutation C (all-of → any-of):** in `predicateCoversParents` return `covered.some(Boolean)` unconditionally. Expected red: `all-of: every listed parent must carry a helper on its alias`.
  - **Mutation D (UPDATE pairing):** in `coveredCommands` change the UPDATE branch to `ok = matches(p.qual, cmd, 'qual')`. Expected red: `UPDATE needs BOTH qual and with_check`.
  - **Mutation E (alias binding):** in `helperOnAlias` replace `${escapeRegExp(alias)}\\.` with `[A-Za-z_][A-Za-z0-9_]*\\.`. Expected red: `rejects a helper applied to a non-parent alias …`.

After the last revert, re-run: all 22 pass (`tee "$LOGS/task1-green-after-mutations.log"`).

- [ ] **Step 6: Commit**

```bash
cd "$WT" && git add apps/api/src/db/rlsPolicyShape.ts apps/api/src/db/rlsPolicyShape.test.ts
git commit -m "test(rls): command-specific policy-shape matchers for the RLS coverage contract

Pure module (src/db/rlsPolicyShape.ts) + unit fixtures. SELECT/DELETE are
read from qual, INSERT from with_check, UPDATE from both; helpers must be
applied to the declared parent alias (any-of / all-of) or to the table's
own org_id / id. Deparsed newlines are normalised; RESTRICTIVE rows ignored;
FOR UPDATE / FOR ALL without WITH CHECK reuses USING (Postgres default).

RED (module absent): <paste the 'Failed to resolve import' line from task1-red.log>
GREEN: 22 passed.
Mutation controls (each observed red, then reverted):
  A drop whitespace normalisation -> 'normalises embedded newlines' failed
  B INSERT read from qual          -> 'INSERT is covered from with_check only' failed
  C all-of behaves as any-of       -> 'all-of: every listed parent...' failed
  D UPDATE reads qual only         -> 'UPDATE needs BOTH qual and with_check' failed
  E helper on any alias accepted   -> 'rejects a helper applied to a non-parent alias' failed

Refs RMM-QA-220.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```
(Replace the `<paste …>` instruction with the actual line from `$LOGS/task1-red.log` before committing.)

---

### Task 2: Exhaustive classification test (D5) and catalog registration (D4) — RED, then partial GREEN with the migration RED retained

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — imports (`:1-15`), `PARENT_FK_JOIN_POLICY_TABLES` (`:584-647`), new constants after `USER_ID_SCOPED_TABLES` (`:649-728`, before `const REQUIRED_CMDS` at `:729`), new test after the force test (`:893-948`).

**Interfaces:**
- Consumes: nothing new.
- Produces: `PLATFORM_INFRASTRUCTURE_TABLES: ReadonlySet<string>`, `UNREVIEWED_RLS_CLASSIFICATION_DEBT: ReadonlyMap<string, string>`, and the two `PARENT_FK_JOIN_POLICY_TABLES` entries Tasks 3–5 rely on.

- [ ] **Step 1: Add the D5 test with EMPTY buckets (RED first) — do NOT add the D4 entries yet**

Insert after `const USER_ID_SCOPED_TABLES … ]);` (before `const REQUIRED_CMDS = …`):

```ts
// Platform bookkeeping tables that hold no tenant data and are not a tenancy
// shape. Exactly one entry today. Adding here requires the same justification
// as INTENTIONAL_UNSCOPED (a plan-doc entry per CLAUDE.md "Intentionally
// system-scoped").
const PLATFORM_INFRASTRUCTURE_TABLES: ReadonlySet<string> = new Set<string>([
  // populated in Step 3 from the RED output
]);

// Tables that carry NEITHER row-level security NOR a tenancy classification
// and were NOT reviewed by RMM-QA-220. Inclusion is a TRACKING FACT, not a
// security review, and not a blessing: each name is a candidate finding
// handed to QA. The bucket is shrink-only — an entry may leave ONLY by moving
// the table into a real bucket (a shape allowlist, INTENTIONAL_UNSCOPED with
// a plan-doc entry, or PLATFORM_INFRASTRUCTURE_TABLES). A stale name (table
// dropped) fails the test so the list cannot rot.
const UNREVIEWED_RLS_CLASSIFICATION_DEBT: ReadonlyMap<string, string> = new Map<string, string>([
  // populated in Step 3 from the RED output
]);
```

Insert after the force test's closing `});` (the test titled `every tenant-scoped public table has FORCE ROW LEVEL SECURITY enabled`, before `it('deployment_invites has a database invariant …`):

```ts
  // RMM-QA-220: every assertion above enumerates ONE shape at a time, so a
  // tenant child that is in no allowlist and has no org_id column (the exact
  // way script_versions / script_to_tags shipped) is invisible to all of them.
  // This test enumerates every public base table and demands a classification.
  it('every public base table is classified by exactly one tenancy bucket', async () => {
    // relkind 'r' (ordinary) + 'p' (partitioned parent, e.g. metric_rollups);
    // NOT relispartition — metric_rollups partitions are created at runtime
    // by breeze_ensure_metric_rollup_partition and would make this
    // non-deterministic. The partitioned parent is classified once.
    const rows = (await db.execute(sql`
      SELECT
        c.relname AS table_name,
        EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = n.nspname AND col.table_name = c.relname AND col.column_name = 'org_id'
        ) AS has_org_id
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
      ORDER BY c.relname;
    `)) as unknown as Array<{ table_name: string; has_org_id: boolean }>;

    const existing = new Map(rows.map((r) => [r.table_name, r.has_org_id]));
    const shapeLists: ReadonlyArray<{ has(name: string): boolean }> = [
      ORG_ID_KEYED_TENANT_TABLES,
      PARTNER_TENANT_TABLES,
      DUAL_AXIS_TENANT_TABLES,
      DEVICE_ID_JOIN_POLICY_TABLES,
      PARENT_FK_JOIN_POLICY_TABLES,
      USER_ID_SCOPED_TABLES,
      INTENTIONAL_UNSCOPED,
      EXEMPT_TABLES,
    ];
    const classifiedByShape = (name: string): boolean =>
      (existing.get(name) ?? false) || shapeLists.some((list) => list.has(name));

    const unclassified = rows
      .map((r) => r.table_name)
      .filter((name) => !classifiedByShape(name))
      .filter((name) => !PLATFORM_INFRASTRUCTURE_TABLES.has(name))
      .filter((name) => !UNREVIEWED_RLS_CLASSIFICATION_DEBT.has(name));

    const bucketNames = [...PLATFORM_INFRASTRUCTURE_TABLES, ...UNREVIEWED_RLS_CLASSIFICATION_DEBT.keys()];
    // Shrink-only ratchet: a name that no longer exists must be removed.
    const stale = bucketNames.filter((name) => !existing.has(name));
    // Buckets 3 and 4 are disjoint from every shape list and from each other.
    const overlapping = [
      ...bucketNames.filter((name) => existing.has(name) && classifiedByShape(name)),
      ...[...PLATFORM_INFRASTRUCTURE_TABLES].filter((name) => UNREVIEWED_RLS_CLASSIFICATION_DEBT.has(name)),
    ];

    expect(
      { unclassified, stale, overlapping },
      `Every public base table must be classified. Unclassified tables have neither an org_id column nor an ` +
        `entry in any shape allowlist (ORG_ID_KEYED / PARTNER / DUAL_AXIS / DEVICE_ID_JOIN / PARENT_FK_JOIN / ` +
        `USER_ID_SCOPED), INTENTIONAL_UNSCOPED, EXEMPT_TABLES, PLATFORM_INFRASTRUCTURE_TABLES or the shrink-only ` +
        `UNREVIEWED_RLS_CLASSIFICATION_DEBT bucket. Pick a shape (CLAUDE.md "Six tenancy shapes"), add policies in a ` +
        `migration, and register the table. 'stale' names no longer exist and must be removed; 'overlapping' names ` +
        `are in a debt/infrastructure bucket AND a real bucket — remove them from the debt bucket.\n` +
        JSON.stringify({ unclassified, stale, overlapping }, null, 2)
    ).toEqual({ unclassified: [], stale: [], overlapping: [] });
  });
```

- [ ] **Step 2: Run the new test alone — RED with the unclassified list**

```bash
cd "$WT" && set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage -- -t 'every public base table is classified' 2>&1 | tee "$LOGS/task2-red-d5.log" | tail -40
```
Expected: FAIL. `unclassified` is expected to be exactly (F18, 2026-09-20 DB — the fresh-stack output is authoritative and may add post-09-20 tables):
`agent_versions, breeze_migrations, cis_check_catalog, device_software, mobile_sessions, patches, permissions, plugin_catalog, script_templates, script_to_tags, script_versions, software_compliance_status`. `stale` and `overlapping` are `[]`. If the list differs, the DB is the truth: every extra name goes into the debt bucket in Step 3 with a one-line description derived from its columns (`docker exec -i "$PG" psql -U breeze_test -d breeze_test -At -c "\d <table>"`).

- [ ] **Step 3: Populate the buckets from the RED output and add the D4 catalog entries**

Replace the two empty constants:

```ts
const PLATFORM_INFRASTRUCTURE_TABLES: ReadonlySet<string> = new Set<string>([
  'breeze_migrations', // autoMigrate's applied-migration ledger (filename + checksum). No tenant data. See apps/api/src/db/autoMigrate.ts MIGRATION_TABLE.
]);

const UNREVIEWED_RLS_CLASSIFICATION_DEBT: ReadonlyMap<string, string> = new Map<string, string>([
  // Surfaced by RMM-QA-220's exhaustive classification (2026-09). Candidate
  // findings handed to QA — NOT reviewed, NOT blessed. Descriptions are the
  // column facts that a reviewer needs, nothing more.
  ['device_software', 'device_id-keyed inventory rows, no RLS; candidate shape 5 (device-join) or denormalised org_id.'],
  ['mobile_sessions', 'user_id / refresh-token session rows, no RLS; candidate shape 6 (breeze_current_user_id).'],
  ['software_compliance_status', 'device_id + policy_id rows, no RLS; candidate shape 5 (device-join).'],
  ['agent_versions', 'Global agent release reference data, no RLS; candidate INTENTIONAL_UNSCOPED after review.'],
  ['cis_check_catalog', 'Global CIS benchmark check catalog, no RLS; candidate INTENTIONAL_UNSCOPED after review.'],
  ['patches', 'Global patch reference data, no RLS; candidate INTENTIONAL_UNSCOPED after review.'],
  ['permissions', 'Global permission catalog, no RLS; candidate INTENTIONAL_UNSCOPED after review.'],
  ['plugin_catalog', 'Global plugin catalog, no RLS; candidate INTENTIONAL_UNSCOPED after review.'],
  ['script_templates', 'Global script template library, no RLS; candidate INTENTIONAL_UNSCOPED after review.'],
]);
```
(Append any extra fresh-DB names the RED run reported, each with a column-derived description. Do NOT add `script_versions` / `script_to_tags` here — they are classified by the D4 entries below.)

Add to `PARENT_FK_JOIN_POLICY_TABLES` immediately after the `['ticket_form_org_links', ['ticket_forms']],` entry (still inside the `new Map([...])`):

```ts
  // RMM-QA-220: script_versions (script content history) and script_to_tags
  // (script↔tag join) shipped in the baseline with NO rls and reach their
  // tenant only through scripts (dual-axis, nullable org_id, is_system) and
  // script_tags (dual-axis). See 2026-09-30-100000-script-children-rls.sql.
  // script_to_tags additionally carries a per-command both-parents overlay
  // (PARENT_FK_REQUIRED_PARENTS_PER_COMMAND below).
  ['script_versions', ['scripts']],
  ['script_to_tags', ['scripts', 'script_tags']],
```

- [ ] **Step 4: Run the whole rls-coverage file — D5 GREEN, force test + parent-FK test RED naming the two tables (this is the retained RED for the migration)**

```bash
cd "$WT" && set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage 2>&1 | tee "$LOGS/task2-red-d4.log" | grep -E '✓|✗|×|FAIL|script_versions|script_to_tags|force_rls|rls_on|missing_cmds|Tests ' | head -60
```
Expected: `every public base table is classified …` PASSES; `every tenant-scoped public table has FORCE ROW LEVEL SECURITY enabled` FAILS listing `script_to_tags` and `script_versions`; `every parent-FK join-policy table has RLS on …` FAILS with `{"table":"script_versions","rls_on":false,"missing_cmds":["SELECT","INSERT","UPDATE","DELETE"]}` and the same for `script_to_tags`; every other test passes. Copy the two offender JSON blocks verbatim into `$LOGS/task2-red-d4-offenders.txt`.

- [ ] **Step 5: Mutation controls for the D5 ratchet (each red, then reverted)**

  - **Mutation A (stale entry):** add `['no_such_table_rmm_qa_220', 'mutation']` to `UNREVIEWED_RLS_CLASSIFICATION_DEBT`; run `-t 'every public base table is classified'` → expected FAIL with `stale: ["no_such_table_rmm_qa_220"]`. Revert.
  - **Mutation B (overlap):** add `'scripts'` to `PLATFORM_INFRASTRUCTURE_TABLES`; run → expected FAIL with `overlapping: ["scripts"]`. Revert.
  - **Mutation C (missing classification):** remove the `'breeze_migrations'` entry; run → expected FAIL with `unclassified: ["breeze_migrations"]`. Revert.
  Log each to `$LOGS/task2-mut-<letter>.log`; re-run the single test after the final revert → PASS.

- [ ] **Step 6: Typecheck and commit (tests intentionally red on this commit)**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tail -3
git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): exhaustive public-table classification + register script children (RED)

D5: every public base table (relkind r/p, not relispartition) must be
classified by a shape allowlist, an org_id column, INTENTIONAL_UNSCOPED,
EXEMPT_TABLES, PLATFORM_INFRASTRUCTURE_TABLES (breeze_migrations) or the
shrink-only UNREVIEWED_RLS_CLASSIFICATION_DEBT bucket (stale/overlap fail).
D4: script_versions -> scripts and script_to_tags -> scripts, script_tags
registered in PARENT_FK_JOIN_POLICY_TABLES.

RED (D5 with empty buckets, fresh per-worktree DB):
unclassified = <paste the array from task2-red-d5.log>
Debt bucket populated from that output and nothing else; the 9 non-script
names are candidate findings for QA, not reviewed.

RED retained for the migration (this commit is intentionally red in CI):
<paste the two offender JSON objects from task2-red-d4-offenders.txt>
force test: script_to_tags, script_versions missing FORCE ROW LEVEL SECURITY.

Mutation controls (each observed red, then reverted):
  A stale debt entry      -> stale: [no_such_table_rmm_qa_220]
  B bucket overlap        -> overlapping: [scripts]
  C drop breeze_migrations-> unclassified: [breeze_migrations]

Refs RMM-QA-220.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 3: Command-specific shape tests D6a (parent-FK, both-parents overlay) and D6b (org-axis)

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — imports; new constant + helpers after `UNREVIEWED_RLS_CLASSIFICATION_DEBT`; D6b test after the org-axis test (`every org-tenant public table has RLS on …`); D6a test after the parent-FK test (`every parent-FK join-policy table has RLS on …`).

**Interfaces:**
- Consumes (Task 1): `coveredCommands`, `predicateCoversOrgAxis`, `predicateCoversParents`, `Cmd`, `ParentRule`, `PolicyRow`, `PredicateSlot` from `../../db/rlsPolicyShape`.
- Produces: `PARENT_FK_REQUIRED_PARENTS_PER_COMMAND`, `loadPublicPolicies()`, `loadRlsState()`.

Open decision 3 is resolved all-at-once (D6): the run in Step 3 IS the fresh-DB simulation (F16/F17). If it reds any table other than the two new entries, STOP and triage per D6: fix the policy in a migration if it is genuinely wrong, or add the table to a new `RLS_SHAPE_TRIAGE: ReadonlyMap<string, string>` (name → owning migration + reason) that the test skips — and never loosen the matcher.

- [ ] **Step 1: Add the import, the overlay map and the two loaders**

Add to the imports at the top of the file:

```ts
import {
  coveredCommands,
  predicateCoversOrgAxis,
  predicateCoversParents,
  type Cmd,
  type ParentRule,
  type PolicyRow,
  type PredicateSlot,
} from '../../db/rlsPolicyShape';
```

Add after `UNREVIEWED_RLS_CLASSIFICATION_DEBT` (before `const REQUIRED_CMDS`):

```ts
// Per-command parent requirements that are STRICTER than PARENT_FK_JOIN_
// POLICY_TABLES' default "helper on any one declared parent alias". Keyed by
// table, then command, then predicate slot. A slot that is absent falls back
// to the default any-of rule over the table's declared parents.
//
// script_to_tags (RMM-QA-220, advisor quorum §9 point 6): a link is readable
// only when BOTH the script and the tag are visible, insertable only when the
// script is writable AND the tag is visible, re-pointable (UPDATE WITH CHECK)
// under the same both-parent rule, but unlinkable (UPDATE USING / DELETE) on
// script write authority alone — tag visibility must not confer unlink rights
// on another org's script.
type PerCommandParentRules = Readonly<Partial<Record<Cmd, Readonly<Partial<Record<PredicateSlot, ParentRule>>>>>>;
// Explicit type arguments on `new Map` keep the 'all-of' / 'any-of' string
// literals narrow inside the nested object literals (otherwise TS widens them
// to `string` and the assignment to ParentRule fails).
const PARENT_FK_REQUIRED_PARENTS_PER_COMMAND: ReadonlyMap<string, PerCommandParentRules> = new Map<string, PerCommandParentRules>([
  [
    'script_to_tags',
    {
      SELECT: { qual: { kind: 'all-of', parents: ['scripts', 'script_tags'] } },
      INSERT: { with_check: { kind: 'all-of', parents: ['scripts', 'script_tags'] } },
      UPDATE: {
        qual: { kind: 'any-of', parents: ['scripts'] },
        with_check: { kind: 'all-of', parents: ['scripts', 'script_tags'] },
      },
      DELETE: { qual: { kind: 'any-of', parents: ['scripts'] } },
    },
  ],
]);

async function loadPublicPolicies(): Promise<Map<string, PolicyRow[]>> {
  const rows = (await db.execute(sql`
    SELECT tablename, policyname, cmd, permissive, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
    ORDER BY tablename, policyname;
  `)) as unknown as Array<PolicyRow & { tablename: string }>;
  const byTable = new Map<string, PolicyRow[]>();
  for (const r of rows) {
    const list = byTable.get(r.tablename) ?? [];
    list.push({ policyname: r.policyname, cmd: r.cmd, permissive: r.permissive, qual: r.qual, with_check: r.with_check });
    byTable.set(r.tablename, list);
  }
  return byTable;
}

/** relname -> relrowsecurity for every public base table (r/p). Absent name = table missing. */
async function loadRlsState(): Promise<Map<string, boolean>> {
  const rows = (await db.execute(sql`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_on
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
  `)) as unknown as Array<{ table_name: string; rls_on: boolean }>;
  return new Map(rows.map((r) => [r.table_name, r.rls_on]));
}
```

- [ ] **Step 2: Add D6a after the existing parent-FK test and D6b after the existing org-axis test**

D6a — insert immediately after the closing `});` of `it('every parent-FK join-policy table has RLS on and all four DML commands covered by a parent-join org-access policy', …)`:

```ts
  // RMM-QA-220 (D6a): command-specific version of the assertion above. The
  // legacy check accepts a helper NAME anywhere in qual OR with_check plus
  // `LIKE '%FROM parent%'`; this one requires, per command, the helper on the
  // declared parent's alias in the slot Postgres actually evaluates
  // (SELECT/DELETE: USING; INSERT: WITH CHECK; UPDATE: both). Either
  // breeze_has_org_access(<alias>.org_id) or breeze_has_partner_access(
  // <alias>.partner_id) counts, so dual-axis parents fit. Tables in
  // PARENT_FK_REQUIRED_PARENTS_PER_COMMAND must satisfy their overlay.
  it('every parent-FK join-policy table has command-specific USING/WITH CHECK coverage on the declared parent alias', async () => {
    const policiesByTable = await loadPublicPolicies();
    const rlsState = await loadRlsState();
    const offenders: Array<{ table: string; rls_on: boolean; missing_cmds: string[] }> = [];

    for (const [table, parents] of PARENT_FK_JOIN_POLICY_TABLES) {
      const overlay = PARENT_FK_REQUIRED_PARENTS_PER_COMMAND.get(table);
      const covered = coveredCommands(policiesByTable.get(table) ?? [], (pred, cmd, slot) => {
        const rule: ParentRule = overlay?.[cmd]?.[slot] ?? { kind: 'any-of', parents };
        return predicateCoversParents(pred, rule);
      });
      const missing = REQUIRED_CMDS.filter((cmd) => !covered.has(cmd));
      const rlsOn = rlsState.get(table) ?? false;
      if (!rlsOn || missing.length > 0) offenders.push({ table, rls_on: rlsOn, missing_cmds: missing });
    }

    expect(
      offenders,
      `Parent-FK join-policy tables whose policies do not guard each command in the slot Postgres evaluates:\n` +
        `${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: SELECT/DELETE need the parent-alias helper in USING, INSERT in WITH CHECK, UPDATE in BOTH. ` +
        `Tables listed in PARENT_FK_REQUIRED_PARENTS_PER_COMMAND must satisfy every parent in their all-of rules. ` +
        `Shape reference: 2026-05-30-fk-child-tables-rls.sql; matcher: src/db/rlsPolicyShape.ts.`
    ).toEqual([]);
  });
```

D6b — insert immediately after the closing `});` of `it('every org-tenant public table has RLS on and all four DML commands covered by breeze_has_org_access', …)`:

```ts
  // RMM-QA-220 (D6b): command-specific version of the org-axis assertion
  // above, over the SAME table set (org_id tables minus
  // ORG_AXIS_POLICY_EXCLUDED_TABLES, plus ORG_ID_KEYED_TENANT_TABLES, minus
  // EXEMPT_TABLES via offendersFrom's filter). Requires
  // breeze_has_org_access([<table>.]org_id) — or ([<table>.]id) for id-keyed
  // tables — in USING for SELECT/DELETE, WITH CHECK for INSERT, both for UPDATE.
  it('every org-tenant public table has command-specific USING/WITH CHECK coverage by breeze_has_org_access on its own org_id', async () => {
    const idKeyedList = Array.from(ORG_ID_KEYED_TENANT_TABLES);
    const rows = (await db.execute(sql`
      WITH org_id_tables AS (
        SELECT DISTINCT c.relname, c.relrowsecurity, false AS id_keyed
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_schema = n.nspname AND col.table_name = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND col.column_name = 'org_id'
          AND c.relname <> ALL(${sql.raw(
            `ARRAY[${Array.from(ORG_AXIS_POLICY_EXCLUDED_TABLES).map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      id_keyed_tables AS (
        SELECT c.relname, c.relrowsecurity, true AS id_keyed
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${idKeyedList.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      )
      SELECT relname AS table_name, relrowsecurity AS rls_on, id_keyed FROM org_id_tables
      UNION ALL
      SELECT relname AS table_name, relrowsecurity AS rls_on, id_keyed FROM id_keyed_tables
      ORDER BY 1;
    `)) as unknown as Array<{ table_name: string; rls_on: boolean; id_keyed: boolean }>;

    const policiesByTable = await loadPublicPolicies();
    const tableRows: TableRow[] = rows.map((r) => {
      const covered = coveredCommands(policiesByTable.get(r.table_name) ?? [], (pred) =>
        predicateCoversOrgAxis(pred, r.table_name, r.id_keyed),
      );
      return { table_name: r.table_name, rls_on: r.rls_on, covered_cmds: [...covered] };
    });
    const offenders = offendersFrom(tableRows);

    expect(
      offenders,
      `Org-tenant tables whose policies do not call breeze_has_org_access on the table's own org_id (or id) in the ` +
        `slot Postgres evaluates for each command:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: USING for SELECT/DELETE, WITH CHECK for INSERT, both for UPDATE; the argument must be this table's ` +
        `org_id (id for ORG_ID_KEYED_TENANT_TABLES). A table whose tenancy axis is NOT its org_id column belongs in ` +
        `ORG_AXIS_POLICY_EXCLUDED_TABLES with a comment (see ticket_form_org_links). Matcher: src/db/rlsPolicyShape.ts.`
    ).toEqual([]);
  });
```

- [ ] **Step 3: Run the file — D6a red ONLY for the two new entries, D6b green (fresh-DB simulation of F16/F17)**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tail -3
set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage 2>&1 | tee "$LOGS/task3-red-d6.log" | grep -E '✓|✗|×|FAIL|"table"|missing_cmds|Tests ' | head -80
```
Expected: `… command-specific USING/WITH CHECK coverage on the declared parent alias` FAILS with exactly two offenders (`script_versions` and `script_to_tags`, `rls_on:false`, all four commands missing) — the 30 pre-existing entries pass (F16); `… coverage by breeze_has_org_access on its own org_id` PASSES (F17; verified on the 2026-09-20 DB that the only table where a strict own-column rule differs from the alias-agnostic one is `ticket_form_org_links`, which is already in `ORG_AXIS_POLICY_EXCLUDED_TABLES`). The Task 2 reds persist. Any other D6a/D6b offender → stop and triage (see the note above this task); record the triage in the commit message.

- [ ] **Step 4: Commit (still red for the two script children, by design)**

```bash
cd "$WT" && git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): command-specific USING/WITH CHECK shape checks for parent-FK and org-axis tables

D6a: every PARENT_FK_JOIN_POLICY_TABLES entry must carry the helper on the
declared parent's alias in the slot Postgres evaluates per command; the
new PARENT_FK_REQUIRED_PARENTS_PER_COMMAND overlay requires BOTH parents
for script_to_tags SELECT / INSERT / UPDATE-check and scripts alone for
UPDATE-using / DELETE. D6b: same per-command rule for org-axis tables with
breeze_has_org_access on the table's own org_id (id when id-keyed).
Closes the helper-name-anywhere blind spot the QA probe pins.

Fresh per-worktree DB run (open decision 3 -> all tables at once):
D6a offenders = <paste the two-object JSON from task3-red-d6.log>
  (30/30 pre-existing parent-FK entries pass)
D6b offenders = []  (0 asserted org-axis offenders)
Discriminating proofs for the matcher: src/db/rlsPolicyShape.test.ts
(mutations A-E in the previous commit).

Refs RMM-QA-220.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 4: Behavioural forge suite as `breeze_app` (D7) — committed RED

**Files:**
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — imports; new `describe` appended at the END of the file.

**Interfaces:**
- Consumes: `db`, `withDbAccessContext`, `withSystemDbAccessContext` (already imported), Drizzle tables `scripts`, `scriptTags`, `scriptToTags`, `scriptVersions` from `../../db/schema/scripts`, `partners`, `organizations` (already imported), `eq`, `inArray`, `and` from `drizzle-orm`.
- Produces: nothing consumed later; the failing rows are the retained RED for Task 5.

- [ ] **Step 1: Extend the imports**

Change `import { eq, sql } from 'drizzle-orm';` to `import { and, eq, inArray, sql } from 'drizzle-orm';` and `import { scripts, scriptExecutionBatches } from '../../db/schema/scripts';` to `import { scripts, scriptExecutionBatches, scriptTags, scriptToTags, scriptVersions } from '../../db/schema/scripts';`.

- [ ] **Step 2: Append the forge describe at the end of the file**

```ts
// ---------------------------------------------------------------------------
// script_versions / script_to_tags — parent-join forge test (RMM-QA-220)
// ---------------------------------------------------------------------------
// Both tables reach their tenant only through `scripts` (dual-axis, nullable
// org_id, is_system) and `script_tags` (dual-axis). Migration under test:
// 2026-09-30-100000-script-children-rls.sql. Runs as `breeze_app` under real
// contexts, modelled on the scripts partner-wide block above: self-contained
// fixtures seeded under system scope, cleanup by id in afterAll.
//
// Actors: org A1 (partner A), org B1 (partner B), org A1 with a MIS-SET own
// partner (B), partner A, partner B. Rows marked "positive" pass on main too —
// they guard against an over-tight policy; every negative row is RED on main.
describe('script_versions / script_to_tags RLS — parent-join forge enforcement (Org A/B, Partner A/B)', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let partnerAId: string;
  let partnerBId: string;
  let orgA1Id: string;
  let orgB1Id: string;
  let sA1Id: string; // org A1 script
  let sB1Id: string; // org B1 script
  let sPAId: string; // partner-wide script of partner A (org_id NULL)
  let sSysId: string; // system script (is_system, org NULL, partner NULL)
  let tA1Id: string; // org A1 tag
  let tB1Id: string; // org B1 tag
  let tPAId: string; // partner-wide tag of partner A
  let vSysId: string; // seeded version on sSys
  let vPAId: string; // seeded version on sPA
  let vA1Id: string | null = null; // version org A1 creates in the positive test

  async function ensureFixtures(): Promise<void> {
    if (partnerAId) return;
    await withSystemDbAccessContext(async () => {
      const seededPartners = await db.insert(partners).values([
        { name: `RLS ScriptChildren A ${runSuffix}`, slug: `rls-sc-a-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
        { name: `RLS ScriptChildren B ${runSuffix}`, slug: `rls-sc-b-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
      ]).returning({ id: partners.id });
      partnerAId = seededPartners[0]!.id;
      partnerBId = seededPartners[1]!.id;

      const seededOrgs = await db.insert(organizations).values([
        { currencyCode: 'USD', partnerId: partnerAId, name: `RLS SC Org A1 ${runSuffix}`, slug: `rls-sc-org-a1-${runSuffix}` },
        { currencyCode: 'USD', partnerId: partnerBId, name: `RLS SC Org B1 ${runSuffix}`, slug: `rls-sc-org-b1-${runSuffix}` },
      ]).returning({ id: organizations.id });
      orgA1Id = seededOrgs[0]!.id;
      orgB1Id = seededOrgs[1]!.id;

      const base = { osTypes: ['windows'], language: 'powershell' as const, content: 'echo seed' };
      const seededScripts = await db.insert(scripts).values([
        { ...base, orgId: orgA1Id, partnerId: partnerAId, name: `sc-sA1-${runSuffix}` },
        { ...base, orgId: orgB1Id, partnerId: partnerBId, name: `sc-sB1-${runSuffix}` },
        { ...base, orgId: null, partnerId: partnerAId, name: `sc-sPA-${runSuffix}` },
        { ...base, orgId: null, partnerId: null, isSystem: true, name: `sc-sSys-${runSuffix}` },
      ]).returning({ id: scripts.id });
      sA1Id = seededScripts[0]!.id;
      sB1Id = seededScripts[1]!.id;
      sPAId = seededScripts[2]!.id;
      sSysId = seededScripts[3]!.id;

      const seededTags = await db.insert(scriptTags).values([
        { orgId: orgA1Id, partnerId: partnerAId, name: `tA1-${runSuffix}` },
        { orgId: orgB1Id, partnerId: partnerBId, name: `tB1-${runSuffix}` },
        { orgId: null, partnerId: partnerAId, name: `tPA-${runSuffix}` },
      ]).returning({ id: scriptTags.id });
      tA1Id = seededTags[0]!.id;
      tB1Id = seededTags[1]!.id;
      tPAId = seededTags[2]!.id;

      // created_by is nullable (0001-baseline.sql:5216) — no users rows needed.
      const seededVersions = await db.insert(scriptVersions).values([
        { scriptId: sSysId, version: 1, content: 'echo sys-v1', changelog: 'seed', createdBy: null },
        { scriptId: sPAId, version: 1, content: 'echo pa-v1', changelog: 'seed', createdBy: null },
      ]).returning({ id: scriptVersions.id });
      vSysId = seededVersions[0]!.id;
      vPAId = seededVersions[1]!.id;
    });
  }

  afterAll(async () => {
    if (!partnerAId) return;
    await withSystemDbAccessContext(async () => {
      const scriptIds = [sA1Id, sB1Id, sPAId, sSysId];
      await db.delete(scriptVersions).where(inArray(scriptVersions.scriptId, scriptIds));
      await db.delete(scriptToTags).where(inArray(scriptToTags.scriptId, scriptIds));
      await db.delete(scripts).where(inArray(scripts.id, scriptIds));
      await db.delete(scriptTags).where(inArray(scriptTags.id, [tA1Id, tB1Id, tPAId]));
      await db.delete(organizations).where(inArray(organizations.id, [orgA1Id, orgB1Id]));
      await db.delete(partners).where(inArray(partners.id, [partnerAId, partnerBId]));
    });
  });

  function partnerContext(partnerId: string) {
    return { scope: 'partner' as const, orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
  }

  // ORGANIZATION scope: no partner-axis write access (accessiblePartnerIds []),
  // currentPartnerId = the caller's own partner so the read-only own-partner
  // branch of the parents' SELECT policies applies.
  function orgContext(orgId: string, ownPartnerId: string | null) {
    return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: ownPartnerId, userId: null };
  }

  async function expectRlsViolation(table: 'script_versions' | 'script_to_tags', fn: () => Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await fn();
    } catch (err) {
      caught = err;
    }
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message, `expected an RLS violation on ${table}; got: ${message || '<no error>'}`).toMatch(
      new RegExp(`new row violates row-level security policy for table "${table}"`),
    );
  }

  const versionsOf = (scriptId: string) =>
    db.select({ id: scriptVersions.id }).from(scriptVersions).where(eq(scriptVersions.scriptId, scriptId));
  const linksOf = (scriptId: string) =>
    db.select({ tagId: scriptToTags.tagId }).from(scriptToTags).where(eq(scriptToTags.scriptId, scriptId));

  // 1 (positive)
  it('org A1 can INSERT and SELECT a version of its own script', async () => {
    await ensureFixtures();
    const inserted = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
      db.insert(scriptVersions).values({ scriptId: sA1Id, version: 1, content: 'echo a1-v1', changelog: 'org A1', createdBy: null }).returning({ id: scriptVersions.id })
    );
    expect(inserted).toHaveLength(1);
    vA1Id = inserted[0]!.id;
    const visible = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () => versionsOf(sA1Id));
    expect(visible.map((r) => r.id)).toEqual([vA1Id]);
  });

  // 2 (positive)
  it('org A1 can INSERT and SELECT a link between its own script and its own tag', async () => {
    await ensureFixtures();
    await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
      db.insert(scriptToTags).values({ scriptId: sA1Id, tagId: tA1Id })
    );
    const visible = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () => linksOf(sA1Id));
    expect(visible.map((r) => r.tagId)).toEqual([tA1Id]);
  });

  // 3
  it("org B1 cannot SELECT org A1's versions or links", async () => {
    await ensureFixtures();
    const versions = await withDbAccessContext(orgContext(orgB1Id, partnerBId), async () => versionsOf(sA1Id));
    const links = await withDbAccessContext(orgContext(orgB1Id, partnerBId), async () => linksOf(sA1Id));
    expect(versions).toEqual([]);
    expect(links).toEqual([]);
  });

  // 4
  it("org B1 INSERT of a version onto org A1's script is rejected by WITH CHECK", async () => {
    await ensureFixtures();
    await expectRlsViolation('script_versions', () =>
      withDbAccessContext(orgContext(orgB1Id, partnerBId), async () =>
        db.insert(scriptVersions).values({ scriptId: sA1Id, version: 9, content: 'forged', changelog: null, createdBy: null })
      )
    );
  });

  // 5
  it('org B1 cannot pair (own script, A tag) nor (A script, own tag)', async () => {
    await ensureFixtures();
    await expectRlsViolation('script_to_tags', () =>
      withDbAccessContext(orgContext(orgB1Id, partnerBId), async () => db.insert(scriptToTags).values({ scriptId: sB1Id, tagId: tA1Id }))
    );
    await expectRlsViolation('script_to_tags', () =>
      withDbAccessContext(orgContext(orgB1Id, partnerBId), async () => db.insert(scriptToTags).values({ scriptId: sA1Id, tagId: tB1Id }))
    );
  });

  // 6
  it("org B1 UPDATE/DELETE on org A1's version and DELETE on its link affect 0 rows and leave the rows intact", async () => {
    await ensureFixtures();
    if (!vA1Id) throw new Error('positive test must run first');
    const updated = await withDbAccessContext(orgContext(orgB1Id, partnerBId), async () =>
      db.update(scriptVersions).set({ changelog: 'tampered' }).where(eq(scriptVersions.id, vA1Id!)).returning({ id: scriptVersions.id })
    );
    const deletedVersions = await withDbAccessContext(orgContext(orgB1Id, partnerBId), async () =>
      db.delete(scriptVersions).where(eq(scriptVersions.id, vA1Id!)).returning({ id: scriptVersions.id })
    );
    const deletedLinks = await withDbAccessContext(orgContext(orgB1Id, partnerBId), async () =>
      db.delete(scriptToTags).where(and(eq(scriptToTags.scriptId, sA1Id), eq(scriptToTags.tagId, tA1Id))).returning({ tagId: scriptToTags.tagId })
    );
    expect(updated).toEqual([]);
    expect(deletedVersions).toEqual([]);
    expect(deletedLinks).toEqual([]);

    const intact = await withSystemDbAccessContext(async () =>
      db.select({ changelog: scriptVersions.changelog }).from(scriptVersions).where(eq(scriptVersions.id, vA1Id!))
    );
    expect(intact).toEqual([{ changelog: 'org A1' }]);
    const linkIntact = await withSystemDbAccessContext(async () => linksOf(sA1Id));
    expect(linkIntact.map((r) => r.tagId)).toEqual([tA1Id]);
  });

  // 7
  it("partner B cannot SELECT org A1's version and cannot INSERT a version onto partner A's partner-wide script", async () => {
    await ensureFixtures();
    const visible = await withDbAccessContext(partnerContext(partnerBId), async () => versionsOf(sA1Id));
    expect(visible).toEqual([]);
    await expectRlsViolation('script_versions', () =>
      withDbAccessContext(partnerContext(partnerBId), async () =>
        db.insert(scriptVersions).values({ scriptId: sPAId, version: 9, content: 'forged', changelog: null, createdBy: null })
      )
    );
  });

  // 8 (positive)
  it('partner A can INSERT a version and a link on its own partner-wide script', async () => {
    await ensureFixtures();
    const inserted = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.insert(scriptVersions).values({ scriptId: sPAId, version: 2, content: 'echo pa-v2', changelog: 'partner A', createdBy: null }).returning({ id: scriptVersions.id })
    );
    expect(inserted).toHaveLength(1);
    await withDbAccessContext(partnerContext(partnerAId), async () => db.insert(scriptToTags).values({ scriptId: sPAId, tagId: tPAId }));
    const links = await withDbAccessContext(partnerContext(partnerAId), async () => linksOf(sPAId));
    expect(links.map((r) => r.tagId)).toEqual([tPAId]);
  });

  // 9
  it("org A1 can SELECT its MSP's partner-wide version (read branch) but cannot INSERT one", async () => {
    await ensureFixtures();
    const visible = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
      db.select({ id: scriptVersions.id }).from(scriptVersions).where(eq(scriptVersions.id, vPAId))
    );
    expect(visible.map((r) => r.id)).toEqual([vPAId]);
    await expectRlsViolation('script_versions', () =>
      withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
        db.insert(scriptVersions).values({ scriptId: sPAId, version: 9, content: 'forged', changelog: null, createdBy: null })
      )
    );
  });

  // 10
  it("org A1 whose own partner is mis-set to B CANNOT SELECT partner A's partner-wide version", async () => {
    await ensureFixtures();
    const visible = await withDbAccessContext(orgContext(orgA1Id, partnerBId), async () =>
      db.select({ id: scriptVersions.id }).from(scriptVersions).where(eq(scriptVersions.id, vPAId))
    );
    expect(visible).toEqual([]);
  });

  // 11 (positive)
  it("org A1 can link its own script to its MSP's partner-wide tag (tag read branch)", async () => {
    await ensureFixtures();
    await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () => db.insert(scriptToTags).values({ scriptId: sA1Id, tagId: tPAId }));
    const links = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () => linksOf(sA1Id));
    expect(links.map((r) => r.tagId).sort()).toEqual([tA1Id, tPAId].sort());
  });

  // 12
  it("org B1 cannot link its own script to partner A's partner-wide tag", async () => {
    await ensureFixtures();
    await expectRlsViolation('script_to_tags', () =>
      withDbAccessContext(orgContext(orgB1Id, partnerBId), async () => db.insert(scriptToTags).values({ scriptId: sB1Id, tagId: tPAId }))
    );
  });

  // 13 (positive, bound parameter through the extended protocol)
  it("org A1 can SELECT a system script's version by bound script_id (is_system read branch)", async () => {
    await ensureFixtures();
    const visible = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () => versionsOf(sSysId));
    expect(visible.map((r) => r.id)).toEqual([vSysId]);
  });

  // 14
  it('neither org A1 nor partner A can INSERT a version onto a system script (no is_system in any write predicate)', async () => {
    await ensureFixtures();
    await expectRlsViolation('script_versions', () =>
      withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
        db.insert(scriptVersions).values({ scriptId: sSysId, version: 9, content: 'forged', changelog: null, createdBy: null })
      )
    );
    await expectRlsViolation('script_versions', () =>
      withDbAccessContext(partnerContext(partnerAId), async () =>
        db.insert(scriptVersions).values({ scriptId: sSysId, version: 9, content: 'forged', changelog: null, createdBy: null })
      )
    );
  });

  // 16 — runs BEFORE 15 because 15 deletes the (sA1, tA1) link this test re-points.
  it('org A1 UPDATE re-pointing its own link at org B1\'s tag is rejected by the UPDATE WITH CHECK tag leg', async () => {
    await ensureFixtures();
    await expectRlsViolation('script_to_tags', () =>
      withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
        db.update(scriptToTags).set({ tagId: tB1Id }).where(and(eq(scriptToTags.scriptId, sA1Id), eq(scriptToTags.tagId, tA1Id)))
      )
    );
    const intact = await withSystemDbAccessContext(async () => linksOf(sA1Id));
    expect(intact.map((r) => r.tagId).sort()).toEqual([tA1Id, tPAId].sort());
  });

  // 15
  it("org A1 can DELETE its own link but DELETE on the partner-wide link affects 0 rows (unlink needs script WRITE)", async () => {
    await ensureFixtures();
    const own = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
      db.delete(scriptToTags).where(and(eq(scriptToTags.scriptId, sA1Id), eq(scriptToTags.tagId, tA1Id))).returning({ tagId: scriptToTags.tagId })
    );
    expect(own.map((r) => r.tagId)).toEqual([tA1Id]);
    const partnerWide = await withDbAccessContext(orgContext(orgA1Id, partnerAId), async () =>
      db.delete(scriptToTags).where(and(eq(scriptToTags.scriptId, sPAId), eq(scriptToTags.tagId, tPAId))).returning({ tagId: scriptToTags.tagId })
    );
    expect(partnerWide).toEqual([]);
    const intact = await withSystemDbAccessContext(async () => linksOf(sPAId));
    expect(intact.map((r) => r.tagId)).toEqual([tPAId]);
  });
});
```

- [ ] **Step 3: Typecheck, then run the forge block — negatives RED on the unmigrated DB**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tail -3
set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage -- -t 'parent-join forge enforcement' 2>&1 | tee "$LOGS/task4-red-d7.log" | grep -E '✓|✗|×|FAIL|Tests ' | head -40
```
Expected (no policies yet): tests 1, 2, 8, 11, 13 PASS (positive rows); tests 3, 4, 5, 6, 7, 9, 10, 12, 14, 16, 15 FAIL — SELECTs return rows instead of `[]`, forged INSERT/UPDATEs succeed (`expected an RLS violation … got: <no error>`), foreign UPDATE/DELETE return rows instead of `[]`. Record the exact pass/fail list. Note: test 16 fails on main by *succeeding* at the re-point, which changes the (sA1,tA1) link to (sA1,tB1) — so test 15's "own link" delete then also fails; that cascade is expected and disappears once the policy exists.

- [ ] **Step 4: Commit RED**

```bash
cd "$WT" && git add apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "test(rls): breeze_app forge suite for script_versions / script_to_tags (RED)

Org A/B, Partner A/B and mis-set-own-partner contexts against both script
children: same-tenant INSERT/SELECT succeed; foreign SELECT hidden; forged
INSERT (foreign script, foreign/partner tag, system script) rejected by
WITH CHECK; foreign UPDATE/DELETE affect 0 rows; UPDATE re-point at a
hidden tag rejected; unlink requires script WRITE; system-script version
readable by bound script_id; partner-wide version readable via the own-
partner read branch only.

RED on the unmigrated per-worktree DB (retained for the migration commit):
<paste the FAIL lines (test names) from task4-red-d7.log>
Positive rows 1, 2, 8, 11, 13 pass on main by construction (no policy).

Refs RMM-QA-220.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 5: The migration (D1–D3) — everything goes green; idempotency, fresh-DB apply, manual `breeze_app` forge, catalog proof

**Files:**
- Create: `apps/api/migrations/2026-09-30-100000-script-children-rls.sql`

**Interfaces:**
- Produces: policies `breeze_org_isolation_{select,insert,update,delete}` on `public.script_versions` and `public.script_to_tags`; RLS ENABLED + FORCED on both. Consumed by every test from Tasks 2–4 and by Task 6.

- [ ] **Step 1: Re-verify the filename ceiling**

```bash
cd "$WT" && ls apps/api/migrations/*.sql | xargs -n1 basename | node -e 'const n=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean); console.log(n.sort((a,b)=>a.localeCompare(b)).pop())'
```
Expected: `2026-09-29-detach-ticket-runs-on-device-org-move.sql`. If main has moved past `2026-09-30-100000-…`, choose a later `HHMMSS` (or later date) that sorts strictly after the printed name and use that name everywhere below (the D4 comment in the test file, the debt-bucket comment, the migration header).

- [ ] **Step 2: Write the migration**

Create `apps/api/migrations/2026-09-30-100000-script-children-rls.sql`:

```sql
-- 2026-09-30-100000: forced parent-join RLS for the two script CHILD tables
-- that shipped in 0001-baseline.sql with NO row-level security (RMM-QA-220).
--
-- Threat: script_versions carries customer script content + history and
-- script_to_tags pairs a script with a tag; both reach their tenant only
-- through scripts.script_id / script_tags.tag_id (no org_id), so they were
-- invisible to the org_id auto-discovery AND absent from every allowlist in
-- rls-coverage.integration.test.ts while breeze_app held blanket DML
-- (ensureAppRole.ts). This migration closes the DB invariant; the companion
-- test changes make the catalog exhaustive so the class cannot recur.
--
-- Shape: the canonical FK-child shape of 2026-05-30-fk-child-tables-rls.sql
-- (DROP IF EXISTS x4, ENABLE + FORCE, four per-command policies named
-- breeze_org_isolation_*), with predicates that MIRROR the parents' reviewed
-- policies rather than a plain breeze_has_org_access(parent.org_id):
--
--   R(s)  scripts read      = breeze_has_org_access(s.org_id)
--                             OR breeze_has_partner_access(s.partner_id)
--                             OR s.is_system
--                             OR (s.org_id IS NULL AND s.partner_id = breeze_current_partner_id())
--           (identical to scripts.breeze_dual_axis_select,
--            2026-06-13-catalog-partner-read-branch.sql)
--   W(s)  scripts write     = breeze_has_org_access(s.org_id)
--                             OR breeze_has_partner_access(s.partner_id)
--           (identical to scripts.breeze_dual_axis_insert/update/delete,
--            2026-06-13-catalog-partner-axis-rls.sql)
--   T(t)  script_tags read  = breeze_has_org_access(t.org_id)
--                             OR breeze_has_partner_access(t.partner_id)
--                             OR (t.org_id IS NULL AND t.partner_id = breeze_current_partner_id())
--           (identical to script_tags.breeze_dual_axis_select)
--
--   script_versions: SELECT R(s); INSERT W(s); UPDATE W(s)/W(s); DELETE W(s).
--   script_to_tags:  SELECT R(s) AND T(t); INSERT W(s) AND T(t);
--                    UPDATE USING W(s) WITH CHECK (W(s) AND T(t)); DELETE W(s).
--
-- is_system appears ONLY in SELECT. It must NEVER be in an INSERT/UPDATE/
-- DELETE predicate (2026-06-13-catalog-partner-axis-rls.sql:62-68, Discussion
-- #633 — `OR is_system` in a WITH CHECK is cross-tenant script injection).
-- System seeding runs under system scope, where W(s) is already TRUE.
--
-- Tag asymmetry (script_to_tags): INSERT and the UPDATE check gate on the tag
-- being READABLE, not writable, so an org user may attach its own script to
-- its MSP's partner-wide tag (the partner-wide-first use case; precedent
-- 2026-09-25-a-automation-resource-bindings.sql). Unlink authority (UPDATE
-- USING / DELETE) comes from the SCRIPT write predicate only, so merely
-- seeing a partner tag never lets a user unlink it from another org's script.
-- The UPDATE WITH CHECK re-applies the tag leg so a link cannot be re-pointed
-- at an invisible tag.
--
-- Bound parameters: the 2026-05-31 script_execution_batches note concerns an
-- INSERT WITH CHECK that ORs `s.is_system`; these write predicates carry no
-- such branch. The only is_system branch here is in SELECT, the same nested-
-- EXISTS shape role_permissions has run in production since 2026-06-13-b.
--
-- The nested EXISTS runs as breeze_app, so the parents' own SELECT policies
-- filter it too: child visibility can never exceed parent visibility.
--
-- Idempotent: DROP POLICY IF EXISTS x4 before each CREATE; ENABLE/FORCE are
-- no-ops when already set. No data change, so no row-count reporting applies.
-- autoMigrate wraps each migration file in a transaction — no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- script_versions  ->  scripts(script_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_versions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_versions;
ALTER TABLE public.script_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON public.script_versions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (
        public.breeze_has_org_access(s.org_id)
        OR public.breeze_has_partner_access(s.partner_id)
        OR s.is_system
        OR (s.org_id IS NULL AND s.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_insert ON public.script_versions FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);
CREATE POLICY breeze_org_isolation_update ON public.script_versions FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);
CREATE POLICY breeze_org_isolation_delete ON public.script_versions FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_versions.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);

-- ---------------------------------------------------------------------------
-- script_to_tags  ->  scripts(script_id)  AND  script_tags(tag_id)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.script_to_tags;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.script_to_tags;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.script_to_tags;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.script_to_tags;
ALTER TABLE public.script_to_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.script_to_tags FORCE ROW LEVEL SECURITY;

CREATE POLICY breeze_org_isolation_select ON public.script_to_tags FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (
        public.breeze_has_org_access(s.org_id)
        OR public.breeze_has_partner_access(s.partner_id)
        OR s.is_system
        OR (s.org_id IS NULL AND s.partner_id = public.breeze_current_partner_id())
      )
  )
  AND EXISTS (
    SELECT 1 FROM script_tags t
    WHERE t.id = script_to_tags.tag_id
      AND (
        public.breeze_has_org_access(t.org_id)
        OR public.breeze_has_partner_access(t.partner_id)
        OR (t.org_id IS NULL AND t.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_insert ON public.script_to_tags FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
  AND EXISTS (
    SELECT 1 FROM script_tags t
    WHERE t.id = script_to_tags.tag_id
      AND (
        public.breeze_has_org_access(t.org_id)
        OR public.breeze_has_partner_access(t.partner_id)
        OR (t.org_id IS NULL AND t.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_update ON public.script_to_tags FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
  AND EXISTS (
    SELECT 1 FROM script_tags t
    WHERE t.id = script_to_tags.tag_id
      AND (
        public.breeze_has_org_access(t.org_id)
        OR public.breeze_has_partner_access(t.partner_id)
        OR (t.org_id IS NULL AND t.partner_id = public.breeze_current_partner_id())
      )
  )
);
CREATE POLICY breeze_org_isolation_delete ON public.script_to_tags FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM scripts s
    WHERE s.id = script_to_tags.script_id
      AND (public.breeze_has_org_access(s.org_id) OR public.breeze_has_partner_access(s.partner_id))
  )
);
```

- [ ] **Step 3: Naming guard + static migration test**

```bash
cd "$WT" && git add apps/api/migrations/2026-09-30-100000-script-children-rls.sql
bash scripts/check-migration-naming.sh --staged 2>&1 | tee "$LOGS/task5-naming.log" | tail -3
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts 2>&1 | tee "$LOGS/task5-automigrate-unit.log" | tail -4
```
Expected: naming guard OK (sorts strictly after the committed max); `autoMigrate.test.ts` passes.

- [ ] **Step 4: Apply the migration through the integration runner (globalSetup → autoMigrate), then the full rls-coverage contract — GREEN**

```bash
cd "$WT" && pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/scripts-system-rls.integration.test.ts 2>&1 | tee "$LOGS/task5-migrate.log" | tail -6
PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"
docker exec -i "$PG" psql -U breeze_test -d breeze_test -At -c "SELECT filename FROM breeze_migrations WHERE filename LIKE '2026-09-30-100000%'"
set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage 2>&1 | tee "$LOGS/task5-green-rls-coverage.log" | grep -E '✗|×|FAIL|Tests |Test Files' | head
```
Expected: the ledger row exists; rls-coverage reports `Test Files 1 passed`, every test passing — including the force test, the legacy parent-FK test, D5, D6a, D6b and all 16 D7 rows. Every RED from Tasks 2–4 is now green with **no test edited**.

- [ ] **Step 5: Idempotency — apply the file twice directly and diff the policy catalog**

```bash
cd "$WT" && PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"
cat > "$LOGS/policy-snapshot.sql" <<'SQL'
SELECT tablename, policyname, cmd, permissive, md5(coalesce(qual, '') || '|' || coalesce(with_check, ''))
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('script_versions', 'script_to_tags')
ORDER BY 1, 2;
SQL
docker exec -i "$PG" psql -U breeze_test -d breeze_test -At < "$LOGS/policy-snapshot.sql" > "$LOGS/task5-policies-1.txt"
docker exec -i "$PG" psql -U breeze_test -d breeze_test -v ON_ERROR_STOP=1 < apps/api/migrations/2026-09-30-100000-script-children-rls.sql > "$LOGS/task5-reapply-1.log" 2>&1
docker exec -i "$PG" psql -U breeze_test -d breeze_test -v ON_ERROR_STOP=1 < apps/api/migrations/2026-09-30-100000-script-children-rls.sql > "$LOGS/task5-reapply-2.log" 2>&1
docker exec -i "$PG" psql -U breeze_test -d breeze_test -At < "$LOGS/policy-snapshot.sql" > "$LOGS/task5-policies-2.txt"
diff "$LOGS/task5-policies-1.txt" "$LOGS/task5-policies-2.txt" && echo IDEMPOTENT && wc -l < "$LOGS/task5-policies-2.txt"
grep -c 'NOTICE' "$LOGS/task5-reapply-2.log" || true
```
Expected: `IDEMPOTENT`, 8 policy rows, no `there is already a transaction in progress` notice (no inner BEGIN).

- [ ] **Step 6: Fresh-database apply (`check:migrations` from empty)**

```bash
cd "$WT" && PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"
PGPORT="$(grep '^DATABASE_URL=' "$WT/.env.test" | sed -E 's#.*localhost:([0-9]+)/.*#\1#')"
docker exec -i "$PG" psql -U breeze_test -d postgres -c 'DROP DATABASE IF EXISTS breeze_test_fresh' -c 'CREATE DATABASE breeze_test_fresh'
DATABASE_URL="postgresql://breeze_test:breeze_test@localhost:${PGPORT}/breeze_test_fresh" BREEZE_APP_DB_PASSWORD=breeze_test NODE_ENV=test pnpm --filter @breeze/api check:migrations 2>&1 | tee "$LOGS/task5-check-migrations-fresh.log" | tail -3
docker exec -i "$PG" psql -U breeze_test -d breeze_test_fresh -At -c "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('script_versions','script_to_tags') ORDER BY 1"
docker exec -i "$PG" psql -U breeze_test -d postgres -c 'DROP DATABASE breeze_test_fresh'
```
Expected: `[check-migrations] OK — all migrations applied`; both rows `t|t`.

- [ ] **Step 7: Manual forge as `breeze_app` via psql (CLAUDE.md workflow step 6)**

```bash
cd "$WT" && PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"
docker exec -i "$PG" psql -U breeze_test -d breeze_test -At <<'SQL' 2>&1 | tee "$LOGS/task5-manual-forge.log"
BEGIN;
INSERT INTO partners (id, name, slug) VALUES ('11111111-1111-4111-8111-111111111111','forge A','forge-a'), ('22222222-2222-4222-8222-222222222222','forge B','forge-b');
INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','forge org A','forge-org-a','USD'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','forge org B','forge-org-b','USD');
INSERT INTO scripts (id, org_id, partner_id, name, os_types, language, content) VALUES
  ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','forge script A','{windows}','powershell','echo a');
INSERT INTO script_tags (id, org_id, partner_id, name) VALUES
  ('77777777-7777-4777-8777-777777777777','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','forge tag A');
-- Now act as the unprivileged request role under an ORGANIZATION-scope context for org B.
SET ROLE breeze_app;
SELECT set_config('breeze.scope','organization',true);
SELECT set_config('breeze.org_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
SELECT set_config('breeze.accessible_org_ids','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
SELECT set_config('breeze.accessible_partner_ids','',true);
SELECT set_config('breeze.user_id','',true);
SELECT set_config('breeze.current_partner_id','22222222-2222-4222-8222-222222222222',true);
SAVEPOINT forge1;
INSERT INTO script_versions (script_id, version, content) VALUES ('55555555-5555-4555-8555-555555555555', 99, 'forged');
ROLLBACK TO SAVEPOINT forge1;
INSERT INTO script_to_tags (script_id, tag_id) VALUES ('55555555-5555-4555-8555-555555555555','77777777-7777-4777-8777-777777777777');
ROLLBACK;
SQL
```
Expected output contains exactly two errors: `ERROR:  new row violates row-level security policy for table "script_versions"` and `ERROR:  new row violates row-level security policy for table "script_to_tags"`; the final `ROLLBACK` discards every fixture (verify: `docker exec -i "$PG" psql -U breeze_test -d breeze_test -At -c "SELECT count(*) FROM partners WHERE slug IN ('forge-a','forge-b')"` → `0`).

- [ ] **Step 8: Catalog proof re-run (the QA query) and drift check**

```bash
cd "$WT" && PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"
docker exec -i "$PG" psql -U breeze_test -d breeze_test -At <<'SQL' | tee "$LOGS/task5-catalog-postfix.log"
SELECT json_agg(row_to_json(t)) FROM (
  SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls,
         has_table_privilege('breeze_app', c.oid, 'SELECT') AS app_select,
         has_table_privilege('breeze_app', c.oid, 'INSERT') AS app_insert,
         has_table_privilege('breeze_app', c.oid, 'UPDATE') AS app_update,
         has_table_privilege('breeze_app', c.oid, 'DELETE') AS app_delete
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('script_to_tags','script_versions') ORDER BY 1) t;
SQL
set -a && . "$WT/.env.test" && set +a && pnpm db:check-drift 2>&1 | tee "$LOGS/task5-check-drift.log" | tail -5
```
Expected: both rows `rls_enabled=true, force_rls=true`, privileges unchanged (`app_*=true`, by design — F2); `db:check-drift` clean (policies are not part of the Drizzle schema, F22).

- [ ] **Step 9: Typecheck + commit the migration with every retained RED**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tail -3
git add apps/api/migrations/2026-09-30-100000-script-children-rls.sql
git commit -m "fix(rls): forced parent-join RLS for script_versions and script_to_tags (RMM-QA-220)

Both tables shipped in 0001-baseline.sql with RLS off while breeze_app
holds blanket DML. New idempotent migration (canonical 2026-05-30 child
shape, no inner BEGIN/COMMIT):
  script_versions: SELECT mirrors scripts' full read predicate (org OR
    partner OR is_system OR own-partner read branch); INSERT/UPDATE/DELETE
    mirror scripts' write predicate only (no is_system, Discussion #633).
  script_to_tags: SELECT = script read AND tag read; INSERT = script WRITE
    AND tag READ; UPDATE USING script WRITE, WITH CHECK script WRITE AND
    tag READ; DELETE = script WRITE. Cross-tenant pairing is impossible by
    construction; unlink never derives from tag visibility.

RED before this commit (per-worktree DB migrated to 1b733cedb):
  force test: script_to_tags, script_versions missing FORCE RLS
  parent-FK (legacy + command-specific): <paste offender JSON from task2-red-d4-offenders.txt>
  forge suite negatives failing: <paste FAIL test names from task4-red-d7.log>
GREEN after: rls-coverage <N>/<N> (task5-green-rls-coverage.log), no test edited.
Idempotency: file applied twice via psql, pg_policies snapshot identical, 8 rows.
Fresh DB: check:migrations OK; both tables relrowsecurity=t relforcerowsecurity=t.
Manual forge as breeze_app (org B context): INSERT script_versions on org A's
script -> 'new row violates row-level security policy for table \"script_versions\"';
INSERT script_to_tags (A script, A tag) -> same for \"script_to_tags\".
Catalog proof (QA query): rls_enabled=true force_rls=true for both; DML
privileges unchanged by design (RLS is the defense, ensureAppRole untouched).
db:check-drift clean.

Refs RMM-QA-220.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 6: Bundle-import regression under real RLS (D8) with a one-time mutation proof

**Files:**
- Create: `apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts`

**Interfaces:**
- Consumes: `importBundle(auth: BundleAuth, bundle: ScriptBundleEnvelope, options: { availability: 'org' | 'partner'; orgId?: string | null; mode: 'skip' | 'rename' | 'new-version' })` and `type BundleAuth = ScriptWriteAuth & Pick<AuthContext, 'user'>` from `../../services/scriptBundle` (`index.ts:327,678`); `SCRIPT_BUNDLE_VERSION`, `type ScriptBundleEnvelope` from `../../services/scriptBundle/schema`; `buildDbAccessContext({ scope, orgId, accessibleOrgIds, partnerId, userId })` from `../../middleware/auth` (`:433`); `createPartner`, `createOrganization`, `createUser` from `./db-utils`.
- Produces: nothing consumed later.

Why this file and not the rls-coverage suite: `importBundle` writes through the normal `db` under `withDbAccessContext`, and `new-version` mode sets `createdBy: auth.user.id` (`scriptBundle/index.ts:767-775`) so real `users` rows are needed; the integration runner's `setup.ts` TRUNCATE CASCADE (which includes `scripts`, `users`, `partners`) cleans up (F20). This suite passes on main too — it is a regression guard for verifier concern 7 (org-axis parent), the partner-wide parent, and the system short-circuit; its discriminating power is proven once by the mutation in Step 4.

- [ ] **Step 1: Write the test**

```ts
/**
 * Script bundle import under REAL RLS on script_versions / script_to_tags
 * (RMM-QA-220, migration 2026-09-30-100000-script-children-rls.sql).
 *
 * importBundle authorises the parent script through resolveScriptCreateScope
 * and then INSERTs script_to_tags (linkTags) and, in `new-version` mode,
 * script_versions — as `breeze_app` inside the caller's DB access context.
 * With the child policies forced, those INSERTs must still pass for every
 * caller scope the route supports:
 *   (a) organization scope  -> org-owned script (org_id + partner_id set)
 *   (b) partner scope, availability 'partner' -> partner-wide script (org_id NULL)
 *   (c) system scope with an explicit orgId -> org-owned script
 * If any of these regress, the policy is wrong — not the importer (spec §non-goals).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { scripts, scriptTags, scriptToTags, scriptVersions } from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { importBundle, type BundleAuth } from '../../services/scriptBundle';
import { SCRIPT_BUNDLE_VERSION, type ScriptBundleEnvelope } from '../../services/scriptBundle/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

function bundleAuth(args: {
  scope: 'organization' | 'partner' | 'system';
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  partnerOrgAccess?: 'all' | 'selected' | 'none' | null;
  userId: string;
}): BundleAuth {
  return {
    scope: args.scope,
    orgId: args.orgId,
    partnerId: args.partnerId,
    partnerOrgAccess: args.partnerOrgAccess ?? null,
    accessibleOrgIds: args.accessibleOrgIds,
    canAccessOrg: (id: string) => args.accessibleOrgIds === null || args.accessibleOrgIds.includes(id),
    user: { id: args.userId, email: 'bundle-rls@example.com', name: 'Bundle RLS', isPlatformAdmin: false },
  };
}

function bundle(content: string, suffix: string): ScriptBundleEnvelope {
  return {
    bundleVersion: SCRIPT_BUNDLE_VERSION,
    scripts: [
      { name: `Bundle One ${suffix}`, osTypes: ['windows'], language: 'powershell', content, tags: ['alpha', 'beta'], timeoutSeconds: 300, runAs: 'system' },
      { name: `Bundle Two ${suffix}`, osTypes: ['linux'], language: 'bash', content, tags: ['alpha'], timeoutSeconds: 300, runAs: 'system' },
    ],
  };
}

async function readBack(names: string[]) {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(scripts).where(inArray(scripts.name, names));
    const byName = new Map(rows.map((r) => [r.name, r]));
    const ids = rows.map((r) => r.id);
    const versions = ids.length ? await db.select().from(scriptVersions).where(inArray(scriptVersions.scriptId, ids)) : [];
    const links = ids.length
      ? await db
          .select({ scriptId: scriptToTags.scriptId, tagName: scriptTags.name, tagOrgId: scriptTags.orgId, tagPartnerId: scriptTags.partnerId })
          .from(scriptToTags)
          .innerJoin(scriptTags, eq(scriptToTags.tagId, scriptTags.id))
          .where(inArray(scriptToTags.scriptId, ids))
      : [];
    return { byName, versions, links };
  });
}

async function importTwice(auth: BundleAuth, ctx: ReturnType<typeof buildDbAccessContext>, availability: 'org' | 'partner', orgId: string | null, suffix: string) {
  const first = await withDbAccessContext(ctx, () => importBundle(auth, bundle('echo v1', suffix), { availability, orgId, mode: 'skip' }));
  const second = await withDbAccessContext(ctx, () => importBundle(auth, bundle('echo v2', suffix), { availability, orgId, mode: 'new-version' }));
  return { first, second };
}

function expectImported(result: Awaited<ReturnType<typeof importBundle>>, expected: { imported?: number; versioned?: number }) {
  if ('error' in result) throw new Error(`importBundle returned a scope error: ${result.error}`);
  expect(result.errors).toEqual([]);
  if (expected.imported !== undefined) expect(result.imported).toBe(expected.imported);
  if (expected.versioned !== undefined) expect(result.versioned).toBe(expected.versioned);
}

async function assertChildren(suffix: string, owner: { orgId: string | null; partnerId: string | null }) {
  const names = [`Bundle One ${suffix}`, `Bundle Two ${suffix}`];
  const { byName, versions, links } = await readBack(names);
  const one = byName.get(names[0]!);
  const two = byName.get(names[1]!);
  expect(one?.orgId ?? null).toBe(owner.orgId);
  expect(one?.partnerId ?? null).toBe(owner.partnerId);
  expect(one?.content).toBe('echo v2');
  expect(one?.version).toBe(2);
  // One snapshot per script, holding the v1 content, created by the caller.
  const oneVersions = versions.filter((v) => v.scriptId === one!.id);
  const twoVersions = versions.filter((v) => v.scriptId === two!.id);
  expect(oneVersions.map((v) => [v.version, v.content])).toEqual([[1, 'echo v1']]);
  expect(twoVersions.map((v) => [v.version, v.content])).toEqual([[1, 'echo v1']]);
  // Tags: two links on One, one on Two, all owned by the same scope as the script.
  expect(links.filter((l) => l.scriptId === one!.id).map((l) => l.tagName).sort()).toEqual(['alpha', 'beta']);
  expect(links.filter((l) => l.scriptId === two!.id).map((l) => l.tagName)).toEqual(['alpha']);
  for (const l of links) {
    expect(l.tagOrgId ?? null).toBe(owner.orgId);
    expect(l.tagPartnerId ?? null).toBe(owner.partnerId);
  }
}

describe('script bundle import under forced RLS on script_versions / script_to_tags (RMM-QA-220)', () => {
  it('(a) organization-scope caller: versions and tag links land on the org-owned script', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const suffix = `org-${Date.now()}`;
    const auth = bundleAuth({ scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id], userId: user.id });
    const ctx = buildDbAccessContext({ scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], partnerId: partner.id, userId: user.id });

    const { first, second } = await importTwice(auth, ctx, 'org', null, suffix);
    expectImported(first, { imported: 2 });
    expectImported(second, { versioned: 2 });
    await assertChildren(suffix, { orgId: org.id, partnerId: partner.id });
  });

  it('(b) partner-scope caller with partner-wide capability: versions and tag links land on the partner-wide script', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const suffix = `pw-${Date.now()}`;
    const auth = bundleAuth({ scope: 'partner', orgId: null, partnerId: partner.id, accessibleOrgIds: [org.id], partnerOrgAccess: 'all', userId: user.id });
    const ctx = buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [org.id], partnerId: partner.id, userId: user.id });

    const { first, second } = await importTwice(auth, ctx, 'partner', null, suffix);
    expectImported(first, { imported: 2 });
    expectImported(second, { versioned: 2 });
    await assertChildren(suffix, { orgId: null, partnerId: partner.id });
  });

  it('(c) system-scope caller with an explicit orgId: versions and tag links land on the org-owned script', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const suffix = `sys-${Date.now()}`;
    const auth = bundleAuth({ scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null, userId: user.id });
    const ctx = buildDbAccessContext({ scope: 'system', orgId: null, accessibleOrgIds: null, partnerId: null, userId: user.id });

    const { first, second } = await importTwice(auth, ctx, 'org', org.id, suffix);
    expectImported(first, { imported: 2 });
    expectImported(second, { versioned: 2 });
    // resolveScriptCreateScope: system scope -> { orgId: requested, partnerId: null }.
    await assertChildren(suffix, { orgId: org.id, partnerId: null });
  });

  it('cross-check: the org-owned links are invisible to a different org under breeze_app', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: orgA.id });
    const suffix = `xo-${Date.now()}`;
    const auth = bundleAuth({ scope: 'organization', orgId: orgA.id, partnerId: partner.id, accessibleOrgIds: [orgA.id], userId: user.id });
    const ctxA = buildDbAccessContext({ scope: 'organization', orgId: orgA.id, accessibleOrgIds: [orgA.id], partnerId: partner.id, userId: user.id });
    const ctxB = buildDbAccessContext({ scope: 'organization', orgId: orgB.id, accessibleOrgIds: [orgB.id], partnerId: partner.id, userId: null });

    expectImported(await withDbAccessContext(ctxA, () => importBundle(auth, bundle('echo v1', suffix), { availability: 'org', orgId: null, mode: 'skip' })), { imported: 2 });
    const [row] = await withSystemDbAccessContext(() => db.select({ id: scripts.id }).from(scripts).where(eq(scripts.name, `Bundle One ${suffix}`)));
    const asB = await withDbAccessContext(ctxB, () =>
      db.select({ tagId: scriptToTags.tagId }).from(scriptToTags).where(eq(scriptToTags.scriptId, row!.id))
    );
    expect(asB).toEqual([]);
    const asA = await withDbAccessContext(ctxA, () => db.select({ tagId: scriptToTags.tagId }).from(scriptToTags).where(eq(scriptToTags.scriptId, row!.id)));
    expect(asA).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it — GREEN (migration applied in Task 5)**

```bash
cd "$WT" && NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tail -3
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptBundleRls.integration.test.ts 2>&1 | tee "$LOGS/task6-green.log" | tail -12
```
Expected: 4 tests pass. If (a) or (b) fails with an RLS violation, the POLICY is wrong (spec non-goal: never patch the importer) — go back to Task 5.

- [ ] **Step 3: Mutation proof — weaken the INSERT policy on the test DB, watch (b) fail, restore by re-applying the migration file**

```bash
cd "$WT" && PG="$(grep '^# compose project:' "$WT/.env.test" | awk '{print $4}')-postgres"
docker exec -i "$PG" psql -U breeze_test -d breeze_test -v ON_ERROR_STOP=1 <<'SQL'
DROP POLICY breeze_org_isolation_insert ON public.script_versions;
CREATE POLICY breeze_org_isolation_insert ON public.script_versions FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM scripts s WHERE s.id = script_versions.script_id AND public.breeze_has_org_access(s.org_id))
);
SQL
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptBundleRls.integration.test.ts 2>&1 | tee "$LOGS/task6-mutation.log" | grep -E '✓|✗|×|FAIL|row-level security' | head -12
docker exec -i "$PG" psql -U breeze_test -d breeze_test -v ON_ERROR_STOP=1 < apps/api/migrations/2026-09-30-100000-script-children-rls.sql > "$LOGS/task6-restore.log" 2>&1
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/scriptBundleRls.integration.test.ts 2>&1 | tee "$LOGS/task6-green-after-restore.log" | tail -6
```
Expected: with the partner branch removed, test (b) FAILS (`importBundle` throws `new row violates row-level security policy for table "script_versions"` because the partner-wide script has `org_id NULL`); (a), (c) and the cross-check still pass. After re-applying the migration file: 4 pass.

- [ ] **Step 4: Commit**

```bash
cd "$WT" && git add apps/api/src/__tests__/integration/scriptBundleRls.integration.test.ts
git commit -m "test(scripts): bundle import regression under forced script-children RLS

Real-RLS proof that importBundle's script_to_tags / script_versions writes
still pass for organization-scope (org-axis parent), partner-scope
partner-wide (partner-axis parent) and system-scope callers, plus a cross-
org read check as breeze_app. Passes on main (no policy) — regression
guard, not RED.

Discrimination proof (once, on the per-worktree DB): re-created
script_versions' INSERT policy WITHOUT the breeze_has_partner_access
branch -> (b) partner-wide import failed with 'new row violates row-level
security policy for table \"script_versions\"' (task6-mutation.log); re-
applied 2026-09-30-100000-script-children-rls.sql -> 4/4 green.

Refs RMM-QA-220.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu"
```

---

### Task 7: Full verification battery, push, draft PR with the handback record, teardown

**Files:**
- No source changes. (Only if the battery finds a problem does anything change — then fix RED-first in the owning task and re-run this task.)

**Interfaces:**
- Consumes: everything above.
- Produces: pushed branch `fix/rmm-qa-220-script-children-rls` on `origin` (`LanternOps/breeze`), a DRAFT PR against `main`, the handback record in its body.

- [ ] **Step 1: Unit suites (Test API job surface)**

```bash
cd "$WT" && pnpm --filter @breeze/api exec vitest run src/db/rlsPolicyShape.test.ts src/db/autoMigrate.test.ts src/services/scriptBundle/index.test.ts 2>&1 | tee "$LOGS/task7-unit.log" | tail -6
NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | tee "$LOGS/task7-tsc.log" | tail -3
```
Expected: all pass; `tsc` clean.

- [ ] **Step 2: Integration suites that touch scripts / registries (expected unchanged-green — no registry touched)**

```bash
cd "$WT" && pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/scriptBundleRls.integration.test.ts \
  src/__tests__/integration/scripts-system-rls.integration.test.ts \
  src/__tests__/integration/scripts-soft-delete.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  2>&1 | tee "$LOGS/task7-integration.log" | tail -12
```
Expected: every file passes. (If a listed file does not exist under that exact name, `ls src/__tests__/integration | grep -i <stem>` and substitute — do not skip it silently; record the substitution.)

- [ ] **Step 3: The full rls-coverage contract one final time, plus migration hygiene on the whole directory**

```bash
cd "$WT" && set -a && . "$LOGS/rls-coverage.env" && set +a && pnpm --filter @breeze/api test:rls-coverage 2>&1 | tee "$LOGS/task7-rls-coverage.log" | tail -6
bash scripts/check-migration-naming.sh 2>&1 | tail -2
git status --short   # must be clean except nothing — no stray files
```
Expected: rls-coverage fully green; naming guard OK; working tree clean.

- [ ] **Step 4 (optional, one independent review round — rigor cap): read-only Codex review of the diff**

```bash
cd "$WT" && git diff origin/main...HEAD > "$LOGS/task7-diff.patch"
codex exec "Review this diff for tenant-isolation correctness only: (1) does any INSERT/UPDATE/DELETE predicate on script_versions or script_to_tags contain is_system or the own-partner read branch? (2) can an org-scope caller unlink a partner-wide tag from another org's script? (3) does rlsPolicyShape.ts accept a helper on a non-parent alias? Answer each with file:line evidence from the diff at $LOGS/task7-diff.patch; do not propose refactors." -s read-only -m gpt-5.6-sol -C "$WT" < /dev/null > "$LOGS/task7-codex-review.txt" 2>&1 || true
tail -40 "$LOGS/task7-codex-review.txt"
```
Expected answers: (1) no, (2) no, (3) no. Any confirmed, consequential finding goes back to the owning task RED-first; nitpicks are recorded in the PR body, not looped on.

- [ ] **Step 5: Push and open the DRAFT PR**

```bash
cd "$WT" && git push -u origin fix/rmm-qa-220-script-children-rls 2>&1 | tail -3
```

Write the PR body to `$LOGS/pr-body.md` with the values filled from the logs (every `<…>` below is replaced by the real number/text from `$LOGS` — none may remain), then create the PR:

````markdown
## fix(rls): forced parent-join RLS for script_versions / script_to_tags (RMM-QA-220)

`script_versions` (customer script content + history) and `script_to_tags` (script↔tag join) shipped in `0001-baseline.sql` with RLS disabled while `breeze_app` holds blanket DML, and were in no allowlist of the RLS coverage contract. This PR installs forced per-command parent-join policies that mirror the reviewed `scripts` / `script_tags` semantics, makes the coverage catalog exhaustive over every public base table, adds command-specific USING/WITH CHECK shape checks, and proves enforcement behaviourally as `breeze_app`.

Design: `docs/superpowers/specs/2026-09-01-rmm-qa-220-script-children-rls-design.md` (D1–D9, advisor-quorum record). Plan: `docs/superpowers/plans/2026-09-01-rmm-qa-220-script-children-rls.md`.

### Standard implementation handback

```text
Finding IDs: RMM-QA-220
Branch / commit / PR: fix/rmm-qa-220-script-children-rls / <head sha> (base origin/main 1b733cedb) / this PR (draft)
Behavior changed: script_versions and script_to_tags now have RLS ENABLED + FORCED with four per-command policies each (2026-09-30-100000-script-children-rls.sql). script_versions SELECT mirrors scripts' read predicate (org OR partner OR is_system OR own-partner read branch); INSERT/UPDATE/DELETE mirror scripts' write predicate only. script_to_tags SELECT requires script read AND tag read; INSERT requires script WRITE AND tag READ; UPDATE USING script WRITE, WITH CHECK script WRITE AND tag READ; DELETE script WRITE. No app-layer code changed; breeze_app privileges unchanged (RLS is the defense, ensureAppRole untouched).
Exit-contract clauses proved: (1) idempotent forced parent-join policies preserving reviewed system-script behavior (forge rows 13/14: system version readable, never writable) and preventing cross-tenant pairing (rows 5, 12, 16); (2) exhaustive table classification registers both tables (D5 test + PARENT_FK_JOIN_POLICY_TABLES entries); (3) real breeze_app Org A/B and Partner A/B tests: same-tenant success (rows 1, 2, 8, 11), foreign SELECT hidden (3, 7, 10), forged INSERT rejected (4, 5, 7, 9, 12, 14), foreign UPDATE/DELETE ineffective (6, 15); (4) command-specific policy-shape checks validate USING/WITH CHECK/helper argument for all 32 parent-FK tables (both-parents overlay for script_to_tags) and all asserted org-axis tables.
Exit-contract clauses still open: none on the two script children at the DB layer; QA-side re-characterisation of the probe blocks core-tenant-isolation-release-contract.test.ts:151-177 (they pin the pre-fix state and now invert) and candidate-bound retest are QA's.
Tests run and exact results: rlsPolicyShape.test.ts 22/22 PASS (unit; mutations A–E each observed red then reverted); autoMigrate.test.ts PASS; scriptBundle/index.test.ts PASS; test:rls-coverage <N>/<N> PASS on a fresh per-worktree DB (RED before the migration: force test + parent-FK tests naming both tables, forge negatives <list>); scriptBundleRls.integration.test.ts 4/4 PASS (mutation: INSERT policy without partner branch -> partner-wide import fails with the RLS violation; restored -> 4/4); scripts-system-rls, scripts-soft-delete, tenantCascade, orgMergeRegistry, tenant-export-policy integration suites PASS; tsc clean; check:migrations from an empty DB OK; migration applied twice -> identical pg_policies (8 rows).
Migration / RLS / config / rollout impact: one new idempotent migration, DDL only (ENABLE/FORCE + 8 policies), no data change, no backfill, no config; sorts last (check-migration-naming --staged OK). No cascade/export registry change (neither table has org_id/device_id). db:check-drift clean. Rollback = a follow-up migration dropping the 8 policies and un-forcing RLS.
Security and tenant/site negative cases: forge suite as breeze_app — org B1 cannot read/insert/update/delete on org A1's versions or links; org B1 cannot pair (own script, A tag), (A script, own tag) or (own script, partner-A tag); partner B cannot read A's version nor write A's partner-wide script; org A1 with a mis-set own partner cannot read A's partner-wide version; org A1 cannot write a system script's version nor unlink a partner-wide link; UPDATE re-point at a hidden tag rejected. Manual psql forge as breeze_app: both INSERTs rejected with "new row violates row-level security policy". Site scope: N/A — neither table carries a site axis.
Operator/UI states checked: N/A — no UI or route changes; the only readers (aiToolsScripts includeVersionHistory, scriptBundle export/import) authorise the parent first and are covered by scriptBundleRls.integration.test.ts and the unchanged mocked unit suite.
Candidate-bound evidence still required: QA re-run of the catalog query (docs/qa/evidence/2026-08-23-core-tenant-isolation.md:31-35) and of the release-contract probe against the nominated candidate; review of the new UNREVIEWED_RLS_CLASSIFICATION_DEBT names (device_software, mobile_sessions, software_compliance_status, agent_versions, cis_check_catalog, patches, permissions, plugin_catalog, script_templates<, plus any fresh-DB additions>) as candidate findings; parent-level findings from the quorum (scripts/script_tags composite ownership FK, is_system ⇒ NULL axes, org-erasure 23503 on NO ACTION child FKs) handed back per spec §8.
```

### Not in scope (handed back as candidate findings — spec §8)
- Parent-level invariants on `scripts` / `script_tags` (composite ownership FK; `is_system ⇒ NULL axes`).
- Org/partner erasure `23503` on `script_to_tags` / `script_versions` `NO ACTION` FKs (RLS-independent).
- The debt-bucket tables and the seven `INTENTIONAL_UNSCOPED` tables whose RLS is off.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01E9p3mtFLSv8SFcZ9fcn8Vu
````

```bash
cd "$WT" && gh pr create --draft --base main --head fix/rmm-qa-220-script-children-rls \
  --title "fix(rls): forced parent-join RLS for script_versions / script_to_tags (RMM-QA-220)" \
  --body-file "$LOGS/pr-body.md" 2>&1 | tail -2
gh pr view --json url,isDraft,baseRefName -q '"\(.url) draft=\(.isDraft) base=\(.baseRefName)"'
```
Expected: a draft PR URL, `draft=true base=main`. Confirm CI attaches to the head (`gh pr checks` after a minute; the branch targets `main`, so `ci.yml` triggers — no stacked-PR blind spot). Do NOT merge, do NOT mark ready.

- [ ] **Step 6: Tear down the per-worktree stack**

```bash
cd "$WT" && pnpm test-stack down 2>&1 | tail -2 && ls "$WT/.env.test" 2>&1 | tail -1
```
Expected: containers and volumes removed; `.env.test` gone (`No such file`).

- [ ] **Step 7: Return** the PR URL, head SHA, the list of `$LOGS` files, and the three hand-backs from the PR body's "Not in scope" section.

---

## Spec coverage map (self-review)

| Spec item | Task |
| --- | --- |
| D1 migration file, canonical shape, no BEGIN/COMMIT, idempotent, header contents | 5 (Steps 2, 5) |
| D2 `script_versions` predicates; open decision 1 rejected; bound-parameter refutation | 5 (Step 2), 4 (row 13/14) |
| D3 `script_to_tags` predicates; open decision 2 = mirror; verifier concern 3 (unlink from script WRITE); UPDATE WITH CHECK tag leg | 5 (Step 2), 4 (rows 5, 11, 12, 15, 16), 3 (overlay) |
| D4 catalog entries = retained RED | 2 (Steps 3–4) |
| D5 exhaustive classification, `relkind IN ('r','p') AND NOT relispartition` (verifier concern 4), buckets 3/4, shrink-only, disjointness | 2 |
| D6 pure module under `src/db/`, unit fixtures + mutations; D6a both-parents overlay; D6b org-axis; open decision 3 all-at-once with triage escape hatch (verifier concern 5) | 1, 3 |
| D7 forge suite, 16 rows, Org A/B, Partner A/B, mis-set own partner | 4 |
| D8 bundle regression for org (verifier concern 7), partner-wide and system callers + mutation proof | 6 |
| D9 quorum already convened (spec §9); optional one review round | 7 (Step 4) |
| §5 verification battery: fresh DB, twice-apply, manual forge, catalog proof, unit/integration lists, drift, naming, tsc, post-push CI check | 5 (Steps 3–8), 7 |
| Verifier concern 6 (BEGIN/COMMIT) refuted | Global Constraints |
| §8 hand-offs surfaced to QA | 7 (PR body) |
| Exit-evidence contract (row): idempotent forced policies, system-script behaviour preserved, cross-tenant pairing prevented, exhaustive classification, Org A/B + Partner A/B breeze_app proofs, command-specific shape checks | 2, 3, 4, 5, 6 |
