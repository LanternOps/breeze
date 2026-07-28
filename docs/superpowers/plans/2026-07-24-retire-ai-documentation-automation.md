# Retire AI Documentation Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently retire both Anthropic-backed documentation automations, replace them with deterministic documentation validation, and close the associated GitHub Actions credential path without changing Breeze product AI.

**Architecture:** Remove the secret-bearing workflows and their dedicated executable implementations as one bounded CI trust change. Add a Node built-in regression test that forbids their return, upgrade the existing Docs CI check to run deterministic Astro validation while preserving its branch-protection-compatible identity, then revoke the exact provider credential and delete the unused GitHub repository secret after the retirement is merged.

**Tech Stack:** GitHub Actions, Node.js 22 built-in test runner, pnpm 10.34.5, Astro 7.1.2, `@astrojs/check` 0.9.9, TypeScript 5.7.2, npm package-lock v3, GitHub CLI.

## Global Constraints

- Retire both `.github/workflows/doc-verify.yml` and `.github/workflows/docs-review.yml`; neither may be replaced by another AI documentation workflow in this change.
- Preserve `scripts/docs-review/mapping.json` and `scripts/docs-review/last-reviewed.json` unchanged.
- Do not modify Breeze product AI code, `apps/api` Anthropic dependencies, production/self-hosted AI configuration, or product operator documentation.
- No GitHub workflow may reference `ANTHROPIC_API_KEY` after retirement.
- Keep the documentation workflow name `Docs CI` and job name `CI Success`.
- Docs CI must run both `pnpm --filter @breeze/docs check` and `pnpm --filter @breeze/docs build`.
- Run the retirement regression guard from normal CI as well as Docs CI.
- Add only `@astrojs/check@^0.9.9` and `typescript@^5.7.2` as new `apps/docs` development dependencies.
- Regenerate the root `pnpm-lock.yaml` only for the `apps/docs` dependency change and `e2e-tests/package-lock.json` only for removal of the e2e direct Anthropic dependency.
- Security rollback must never restore the old workflows, repository secret, or direct-to-main AI write authority.
- Do not delete the GitHub repository secret until the exact provider credential is identified and revoked; if it is shared, stop and migrate legitimate consumers before revocation.
- Keep all incident evidence under ignored `internal/` paths with directory mode `0700` and file mode `0600`; never store a credential value.
- Use branch `fix/retire-ai-doc-automation` from the SHA currently advertised for `origin/main`; do not work in the dirty primary checkout.

---

## Execution Setup: Create the fresh implementation worktree

Run from the canonical repository before Task 1:

```bash
set -euo pipefail
repo_root="/Users/toddhebebrand/breeze"
worktree="$repo_root/.worktrees/retire-ai-doc-automation"
branch="fix/retire-ai-doc-automation"
planning_branch="docs/security-remediation-2026-07-23"

git -C "$repo_root" fetch --prune origin
remote_sha="$(git -C "$repo_root" rev-parse origin/main)"
advertised_sha="$(git -C "$repo_root" ls-remote --heads origin refs/heads/main | awk '{print $1}')"
test -n "$advertised_sha"
test "$remote_sha" = "$advertised_sha"
git -C "$repo_root" check-ignore -q .worktrees
test ! -e "$worktree"
test -z "$(git -C "$repo_root" branch --list "$branch")"

git -C "$repo_root" worktree add "$worktree" -b "$branch" "$remote_sha"
test "$(git -C "$worktree" rev-parse HEAD)" = "$remote_sha"
test -z "$(git -C "$worktree" status --short)"

git -C "$worktree" checkout "$planning_branch" -- \
  docs/superpowers/specs/2026-07-24-retire-ai-documentation-automation-design.md \
  docs/superpowers/plans/2026-07-24-retire-ai-documentation-automation.md
git -C "$worktree" commit -m "docs(security): record AI docs automation retirement"
```

Expected: the implementation branch starts at the exact SHA currently advertised for `origin/main` and adds only the approved design and plan in its setup commit.

Install and verify the clean baseline:

```bash
set -euo pipefail
cd /Users/toddhebebrand/breeze/.worktrees/retire-ai-doc-automation
pnpm install --frozen-lockfile
pnpm test:community-readme
pnpm --filter @breeze/docs build
(cd e2e-tests && npm ci --ignore-scripts)
git status --short --branch
```

Expected: install, community README test, Docs build, and e2e clean install exit 0; the worktree is clean on `fix/retire-ai-doc-automation`. If any baseline command fails, stop and report the exact failure before implementation.

### Task 1: Disable the remaining live workflow and capture pre-change evidence

**Files:**
- Update: `internal/security-containment/2026-07-24-doc-automation-retirement/change-record.md`
- Create: `internal/security-containment/2026-07-24-doc-automation-retirement/doc-verify.before.json`
- Create: `internal/security-containment/2026-07-24-doc-automation-retirement/docs-review.before.json`
- Create: `internal/security-containment/2026-07-24-doc-automation-retirement/doc-verify-runs.before.json`
- Create: `internal/security-containment/2026-07-24-doc-automation-retirement/docs-review-runs.before.json`
- Create: `internal/security-containment/2026-07-24-doc-automation-retirement/secret-metadata.before.json`
- Create: `internal/security-containment/2026-07-24-doc-automation-retirement/rulesets.before.json`
- Report: `.superpowers/sdd/retire-ai-docs-task-1-report.md`

**Interfaces:**
- Consumes: owner approval to retire both documentation automations; GitHub operator access to `LanternOps/breeze`.
- Produces: both documentation workflows disabled, no running documentation job, metadata-only evidence, and an exact rollback statement that never authorizes re-enabling the old workflows.

- [ ] **Step 1: Resolve the canonical repository and create restricted evidence storage**

Run from `/Users/toddhebebrand/breeze`:

```bash
set -euo pipefail
git_common="$(git rev-parse --path-format=absolute --git-common-dir)"
repo_root="$(cd "$git_common/.." && pwd -P)"
test "$repo_root" = "/Users/toddhebebrand/breeze"
evidence="$repo_root/internal/security-containment/2026-07-24-doc-automation-retirement"
install -d -m 700 "$evidence"
umask 077
printf '%s\n' "$evidence"
```

Expected: the printed path is the ignored internal evidence directory and `stat -f '%Lp' "$evidence"` prints `700`.

- [ ] **Step 2: Capture metadata-only before state**

Run:

```bash
set -euo pipefail
repo="LanternOps/breeze"
evidence="/Users/toddhebebrand/breeze/internal/security-containment/2026-07-24-doc-automation-retirement"

gh api "repos/$repo/actions/workflows/doc-verify.yml" \
  --jq '{id,name,path,state}' >"$evidence/doc-verify.before.json"
gh api "repos/$repo/actions/workflows/docs-review.yml" \
  --jq '{id,name,path,state}' >"$evidence/docs-review.before.json"
gh run list --repo "$repo" --workflow doc-verify.yml --limit 100 \
  --json databaseId,status,conclusion,event,createdAt,updatedAt \
  >"$evidence/doc-verify-runs.before.json"
gh run list --repo "$repo" --workflow docs-review.yml --limit 100 \
  --json databaseId,status,conclusion,event,createdAt,updatedAt \
  >"$evidence/docs-review-runs.before.json"
gh api "repos/$repo/actions/secrets/ANTHROPIC_API_KEY" \
  --jq '{name,created_at,updated_at}' \
  >"$evidence/secret-metadata.before.json"
gh api "repos/$repo/rulesets" \
  --jq '[.[] | {id,name,target,enforcement,conditions,rules}]' \
  >"$evidence/rulesets.before.json"
chmod 600 "$evidence"/*
```

Expected: evidence contains workflow/run/ruleset/secret metadata only. It contains no workflow logs, patches, URLs, branch names, actor identities, secret values, or provider credential material.

- [ ] **Step 3: Prove no documentation automation is running**

Run:

```bash
set -euo pipefail
repo="LanternOps/breeze"
test "$(gh run list --repo "$repo" --workflow doc-verify.yml --status in_progress --limit 100 --json databaseId --jq 'length')" = "0"
test "$(gh run list --repo "$repo" --workflow docs-review.yml --status in_progress --limit 100 --json databaseId --jq 'length')" = "0"
echo "documentation-running-jobs=0"
```

Expected: `documentation-running-jobs=0`.

- [ ] **Step 4: Disable both workflow registrations**

Run:

```bash
set -euo pipefail
repo="LanternOps/breeze"
gh workflow disable doc-verify.yml --repo "$repo"
gh workflow disable docs-review.yml --repo "$repo"
test "$(gh api "repos/$repo/actions/workflows/doc-verify.yml" --jq .state)" = "disabled_manually"
test "$(gh api "repos/$repo/actions/workflows/docs-review.yml" --jq .state)" = "disabled_manually"
echo "documentation-workflows=disabled_manually"
```

Expected: `documentation-workflows=disabled_manually`. The prior `doc-verify` disable remains intact; `docs-review` changes from `active` to `disabled_manually`.

- [ ] **Step 5: Record the operational change and rollback boundary**

Create or append `change-record.md` with:

```markdown
## 2026-07-24 — AI documentation automation retirement preflight

- Incident/change owner: Todd Hebebrand
- Approved scope: permanently retire Documentation Verification and AI Doc Review.
- Before state: recorded in sibling metadata-only evidence files.
- After state: both workflow registrations are `disabled_manually`; no running job was present.
- Repository secret: retained pending source removal, exact provider-key identification, and provider revocation.
- Rollback: do not re-enable either old workflow. Recovery is deterministic manual documentation maintenance or a separately reviewed secret-free design.
```

Expected: no secret value, raw run URL, branch name, actor identity, or internal infrastructure detail is recorded.

Run:

```bash
chmod 600 /Users/toddhebebrand/breeze/internal/security-containment/2026-07-24-doc-automation-retirement/change-record.md
```

Expected: `stat -f '%Lp'` for the change record prints `600`.

- [ ] **Step 6: Write the task report**

Write `.superpowers/sdd/retire-ai-docs-task-1-report.md` with:

```markdown
# Task 1 report

Status: DONE

## External changes

- Documentation Verification: `disabled_manually`
- AI Doc Review: `disabled_manually`
- Running documentation jobs before disable: 0
- Repository secret: unchanged

## Evidence

- Ignored internal evidence directory: mode 0700
- Evidence files: mode 0600
- Captured metadata only; no secret values or raw logs

## Rollback boundary

The retired workflows must not be re-enabled. A future replacement requires a new reviewed design.
```

Expected: report contains the executed states and no credential value.

Run:

```bash
chmod 600 .superpowers/sdd/retire-ai-docs-task-1-report.md
```

---

### Task 2: Retire the implementation and add deterministic guardrails

**Files:**
- Create: `.github/scripts/docs-automation-retirement.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/docs-ci.yml`
- Delete: `.github/workflows/doc-verify.yml`
- Delete: `.github/workflows/docs-review.yml`
- Delete: `docker-compose.doc-verify.yml`
- Delete: `e2e-tests/doc-verify/cli.ts`
- Delete: `e2e-tests/doc-verify/extractor.ts`
- Delete: `e2e-tests/doc-verify/report.ts`
- Delete: `e2e-tests/doc-verify/runner.ts`
- Delete: `e2e-tests/doc-verify/types.ts`
- Delete: `e2e-tests/doc-verify/executors/api.ts`
- Delete: `e2e-tests/doc-verify/executors/sql.ts`
- Delete: `e2e-tests/doc-verify/executors/ui.ts`
- Delete: `e2e-tests/doc-verify/fixtures/seed.ts`
- Delete: `scripts/docs-review/review.mjs`
- Modify: `apps/docs/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `e2e-tests/package.json`
- Modify: `e2e-tests/package-lock.json`
- Modify: `.gitignore`
- Modify: `e2e-tests/.gitignore`
- Modify: `e2e-tests/tsconfig.json`
- Preserve unchanged: `scripts/docs-review/mapping.json`
- Preserve unchanged: `scripts/docs-review/last-reviewed.json`
- Test: `.github/scripts/docs-automation-retirement.test.mjs`
- Report: `.superpowers/sdd/retire-ai-docs-task-2-report.md`

**Interfaces:**
- Consumes: both live workflow registrations disabled by Task 1; the exact approved design in `docs/superpowers/specs/2026-07-24-retire-ai-documentation-automation-design.md`.
- Produces: no executable AI documentation automation, no workflow secret consumer, deterministic Docs CI, and a regression guard run by both Docs CI and normal CI.

- [ ] **Step 1: Create the failing retirement regression test**

Create `.github/scripts/docs-automation-retirement.test.mjs` with:

```js
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function absolute(relativePath) {
  return path.join(repoRoot, relativePath);
}

function read(relativePath) {
  return readFileSync(absolute(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('retired AI documentation automation is absent', () => {
  const retiredPaths = [
    '.github/workflows/doc-verify.yml',
    '.github/workflows/docs-review.yml',
    'docker-compose.doc-verify.yml',
    'e2e-tests/doc-verify',
    'scripts/docs-review/review.mjs',
  ];

  for (const retiredPath of retiredPaths) {
    assert.equal(
      existsSync(absolute(retiredPath)),
      false,
      `${retiredPath} must remain retired`,
    );
  }
});

test('no GitHub workflow injects the repository Anthropic key', () => {
  const workflowDir = absolute('.github/workflows');
  const workflowFiles = readdirSync(workflowDir)
    .filter((name) => /\.ya?ml$/u.test(name));

  for (const workflowFile of workflowFiles) {
    assert.doesNotMatch(
      read(path.join('.github/workflows', workflowFile)),
      /ANTHROPIC_API_KEY/u,
      `${workflowFile} must not reference ANTHROPIC_API_KEY`,
    );
  }
});

test('e2e package has no documentation verifier entrypoint or Anthropic dependency', () => {
  const e2ePackage = readJson('e2e-tests/package.json');
  const scripts = e2ePackage.scripts ?? {};
  const dependencies = e2ePackage.dependencies ?? {};

  for (const scriptName of ['doc-verify', 'doc-verify:extract', 'doc-verify:run']) {
    assert.equal(scripts[scriptName], undefined, `${scriptName} must remain absent`);
  }
  assert.equal(
    dependencies['@anthropic-ai/sdk'],
    undefined,
    '@anthropic-ai/sdk must not be a direct e2e dependency',
  );
});

test('manual documentation inventory remains available', () => {
  assert.equal(existsSync(absolute('scripts/docs-review/mapping.json')), true);
  assert.equal(existsSync(absolute('scripts/docs-review/last-reviewed.json')), true);
});

test('Docs CI keeps its check identity and runs deterministic validation', () => {
  const docsWorkflow = read('.github/workflows/docs-ci.yml');
  const docsPackage = readJson('apps/docs/package.json');

  assert.match(docsWorkflow, /^name: Docs CI$/mu);
  assert.match(docsWorkflow, /^\s+name: CI Success$/mu);
  assert.match(docsWorkflow, /pnpm --filter @breeze\/docs check/u);
  assert.match(docsWorkflow, /pnpm --filter @breeze\/docs build/u);
  assert.equal(docsPackage.scripts?.check, 'astro check');
  assert.equal(docsPackage.scripts?.build, 'astro build');
});
```

Add this root script immediately after `test:community-readme` in `package.json`:

```json
"test:docs-automation": "node --test .github/scripts/docs-automation-retirement.test.mjs",
```

- [ ] **Step 2: Run the regression test and observe RED**

Run:

```bash
pnpm test:docs-automation
```

Expected: FAIL in `retired AI documentation automation is absent` because at least `.github/workflows/doc-verify.yml`, `.github/workflows/docs-review.yml`, `e2e-tests/doc-verify`, and `scripts/docs-review/review.mjs` still exist. Record the command, non-zero exit, and assertion name in the task report.

- [ ] **Step 3: Remove the retired executable paths**

Run:

```bash
git rm \
  .github/workflows/doc-verify.yml \
  .github/workflows/docs-review.yml \
  docker-compose.doc-verify.yml \
  scripts/docs-review/review.mjs
git rm -r e2e-tests/doc-verify
```

Expected: only the approved executable paths are staged for deletion. Confirm preservation:

```bash
test -f scripts/docs-review/mapping.json
test -f scripts/docs-review/last-reviewed.json
git diff -- scripts/docs-review/mapping.json scripts/docs-review/last-reviewed.json
```

Expected: both files exist and the diff is empty.

- [ ] **Step 4: Remove package and configuration remnants**

Change `e2e-tests/package.json` so its scripts begin:

```json
"scripts": {
  "test": "playwright test",
  "test:ui": "playwright test --ui",
  "test:headed": "playwright test --headed",
  "test:debug": "PWDEBUG=1 playwright test",
  "test:report": "playwright show-report",
  "monitor": "tsx live-signup/monitor.ts",
  "stage:runtime-extension-fixture": "tsx fixtures/runtime-extension/stage.ts"
},
"dependencies": {
  "dotenv": "^17.4.2"
},
```

Remove these two lines from the root `.gitignore`:

```gitignore
e2e-tests/doc-verify/reports/
e2e-tests/doc-verify/assertions.json
```

Remove this section from `e2e-tests/.gitignore`:

```gitignore
# Doc verify artifacts
doc-verify/assertions.json
doc-verify/reports/
```

Remove `"doc-verify/**",` from the `exclude` array in `e2e-tests/tsconfig.json`.

Prove that no remaining e2e source imports the direct dependency:

```bash
test -z "$(git grep -l '@anthropic-ai/sdk' -- e2e-tests 2>/dev/null)"
```

Expected: no output and exit 0.

Regenerate only the e2e lockfile:

```bash
cd e2e-tests
npm install --package-lock-only --ignore-scripts
cd ..
```

Expected: `e2e-tests/package-lock.json` no longer contains a root direct `@anthropic-ai/sdk` dependency or its now-unreachable package subtree.

- [ ] **Step 5: Add the deterministic docs check dependencies and scripts**

Change `apps/docs/package.json` to:

```json
{
  "name": "@breeze/docs",
  "type": "module",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "check": "astro check",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "@astrojs/starlight": "^0.41.3",
    "astro": "^7.1.2",
    "sharp": "^0.35.0"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.9",
    "typescript": "^5.7.2"
  }
}
```

Update only the workspace lockfile:

```bash
pnpm install --lockfile-only
```

Expected: the `apps/docs` importer in `pnpm-lock.yaml` contains `@astrojs/check` and `typescript`; no product Anthropic dependency is removed.

- [ ] **Step 6: Replace echo-only Docs CI with deterministic validation**

Replace `.github/workflows/docs-ci.yml` with:

```yaml
name: Docs CI

on:
  push:
    branches: [main]
    paths:
      - 'docs/**'
      - 'apps/docs/**'
      - '**/*.md'
      - '**/*.mdx'
  pull_request:
    branches: [main]
    paths:
      - 'docs/**'
      - 'apps/docs/**'
      - '**/*.md'
      - '**/*.mdx'

permissions:
  contents: read

env:
  NODE_VERSION: '22'
  PNPM_VERSION: '10.34.5'

jobs:
  ci-success:
    name: CI Success
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - name: Setup pnpm
        uses: pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271 # v6.0.9
        with:
          version: ${{ env.PNPM_VERSION }}

      - name: Setup Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Guard retired AI documentation automation
        run: pnpm test:docs-automation

      - name: Check documentation
        run: pnpm --filter @breeze/docs check

      - name: Build documentation
        run: pnpm --filter @breeze/docs build
```

Expected: the workflow/job identity remains `Docs CI / CI Success`, permissions remain read-only, Actions are pinned to immutable commits, and no secret is referenced.

- [ ] **Step 7: Run the retirement guard from normal CI**

In `.github/workflows/ci.yml`, add immediately after `Test community README automation`:

```yaml
      - name: Guard retired AI documentation automation
        run: pnpm test:docs-automation
```

Expected: full CI catches reintroduction through `.github/**`, `scripts/**`, `e2e-tests/**`, or package/config changes even when Docs CI path filters do not match.

- [ ] **Step 8: Run the regression test and observe GREEN**

Run:

```bash
pnpm test:docs-automation
```

Expected: 5 tests pass, 0 fail.

- [ ] **Step 9: Verify locks, deterministic docs validation, and security guards**

Run:

```bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm test:docs-automation
pnpm test:community-readme
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
(cd e2e-tests && npm ci --ignore-scripts)
bash scripts/security/check-supply-chain-hardening.sh
git diff --check
```

Expected:

```text
- frozen pnpm install succeeds
- retirement guard: 5 passed, 0 failed
- community README tests pass
- Astro check: 0 errors
- Astro build exits 0
- e2e npm clean install exits 0
- supply-chain hardening guard exits 0
- git diff --check emits no output
```

- [ ] **Step 10: Prove the scope boundary**

Run:

```bash
set -euo pipefail
test -z "$(git diff -- scripts/docs-review/mapping.json scripts/docs-review/last-reviewed.json)"
test -z "$(git diff -- apps/api apps/web packages .env.example deploy/docker-compose.prod.yml docker-compose.yml)"
test "$(git grep -l 'ANTHROPIC_API_KEY' -- .github/workflows 2>/dev/null | wc -l | tr -d ' ')" = "0"
git diff --stat
```

Expected: manual mapping/tracking data and product AI/configuration have no diff; workflow secret-reference count is zero; the stat contains only the approved retirement, guard, deterministic Docs CI, and lock/config cleanup.

- [ ] **Step 11: Write the task report and commit**

Write `.superpowers/sdd/retire-ai-docs-task-2-report.md` with:

```markdown
# Task 2 report

Status: DONE

## TDD evidence

- RED command and expected retirement assertion failure
- GREEN command and 5/5 pass result

## Verification

- frozen pnpm install
- community README tests
- docs check and build
- e2e clean npm install
- supply-chain hardening guard
- diff and scope checks

## Scope

- Both AI documentation automations and dedicated executable code removed
- Manual mapping/tracking data preserved
- Product AI unchanged
- GitHub repository secret unchanged pending provider revocation
```

Commit:

```bash
git add \
  .github/scripts/docs-automation-retirement.test.mjs \
  .github/workflows/ci.yml \
  .github/workflows/docs-ci.yml \
  .gitignore \
  apps/docs/package.json \
  e2e-tests/.gitignore \
  e2e-tests/package-lock.json \
  e2e-tests/package.json \
  e2e-tests/tsconfig.json \
  package.json \
  pnpm-lock.yaml
git add -u \
  .github/workflows \
  docker-compose.doc-verify.yml \
  e2e-tests/doc-verify \
  scripts/docs-review/review.mjs
git commit -m "fix(ci): retire AI documentation automation"
```

Expected: one implementation commit; ignored reports/evidence are not committed.

---

### Task 3: Review, publish, merge, and verify the retirement

**Files:**
- Read: `docs/superpowers/specs/2026-07-24-retire-ai-documentation-automation-design.md`
- Read: `docs/superpowers/plans/2026-07-24-retire-ai-documentation-automation.md`
- Read: `.superpowers/sdd/retire-ai-docs-task-2-report.md`
- Update: `internal/security-containment/2026-07-24-doc-automation-retirement/change-record.md`
- Report: `.superpowers/sdd/retire-ai-docs-task-3-report.md`

**Interfaces:**
- Consumes: Task 2 commit with clean task review and clean final whole-branch review.
- Produces: merged default-branch retirement, successful deterministic Docs CI, and live evidence that no workflow source consumes the repository Anthropic secret.

- [ ] **Step 1: Rebase only if `origin/main` advanced**

Run:

```bash
set -euo pipefail
git fetch --prune origin
remote_sha="$(git rev-parse origin/main)"
advertised_sha="$(git ls-remote --heads origin refs/heads/main | awk '{print $1}')"
test -n "$advertised_sha"
test "$remote_sha" = "$advertised_sha"
base_sha="$(git merge-base HEAD origin/main)"
printf 'origin/main=%s\nmerge-base=%s\n' "$remote_sha" "$base_sha"
```

If `origin/main` advanced beyond the worktree start SHA, rebase:

```bash
git rebase origin/main
```

Expected: clean rebase. Re-run every Task 2 Step 9 and Step 10 verification command after any rebase.

- [ ] **Step 2: Push and create the retirement PR**

Run:

```bash
git push -u origin fix/retire-ai-doc-automation
gh pr create \
  --repo LanternOps/breeze \
  --base main \
  --head fix/retire-ai-doc-automation \
  --title "fix(ci): retire AI documentation automation" \
  --body-file .superpowers/sdd/retire-ai-docs-pr-body.md
```

The ignored PR body must contain:

```markdown
## Summary

- retire both Anthropic-backed documentation automations
- preserve product AI and manual documentation mapping/tracking data
- replace nondeterministic AI checks with deterministic Astro check/build
- add a regression guard to Docs CI and normal CI

## Security

- no GitHub workflow references `ANTHROPIC_API_KEY`
- both live workflow registrations were disabled before source removal
- repository secret deletion waits for exact provider-key identification and revocation

## Verification

- `pnpm test:docs-automation`
- `pnpm test:community-readme`
- `pnpm --filter @breeze/docs check`
- `pnpm --filter @breeze/docs build`
- `(cd e2e-tests && npm ci --ignore-scripts)`
- `bash scripts/security/check-supply-chain-hardening.sh`
```

Expected: PR URL for the exact branch and base.

- [ ] **Step 3: Require green checks and merge**

Run:

```bash
gh pr checks --repo LanternOps/breeze --watch --fail-fast
gh pr merge --repo LanternOps/breeze --squash --admin
```

Expected: all required checks green before a successful squash merge.

- [ ] **Step 4: Verify the default branch after merge**

Run:

```bash
set -euo pipefail
git fetch --prune origin
remote_sha="$(git rev-parse origin/main)"
advertised_sha="$(git ls-remote --heads origin refs/heads/main | awk '{print $1}')"
test "$remote_sha" = "$advertised_sha"

for retired_path in \
  .github/workflows/doc-verify.yml \
  .github/workflows/docs-review.yml \
  docker-compose.doc-verify.yml \
  e2e-tests/doc-verify \
  scripts/docs-review/review.mjs
do
  if git cat-file -e "origin/main:$retired_path" 2>/dev/null; then
    echo "retired path still present: $retired_path" >&2
    exit 1
  fi
done

test -z "$(git grep -l 'ANTHROPIC_API_KEY' origin/main -- .github/workflows 2>/dev/null)"
git show "origin/main:scripts/docs-review/mapping.json" >/dev/null
git show "origin/main:scripts/docs-review/last-reviewed.json" >/dev/null
echo "default-branch-retirement=verified"
```

Expected: `default-branch-retirement=verified`.

- [ ] **Step 5: Verify deterministic Docs CI on the merged commit**

Run:

```bash
set -euo pipefail
merged_sha="$(git rev-parse origin/main)"
run_id="$(
  gh run list \
    --repo LanternOps/breeze \
    --workflow docs-ci.yml \
    --commit "$merged_sha" \
    --limit 1 \
    --json databaseId \
    --jq '.[0].databaseId'
)"
test -n "$run_id"
gh run watch "$run_id" --repo LanternOps/breeze --exit-status
```

Expected: Docs CI concludes successfully for the merged SHA.

- [ ] **Step 6: Record merged and observed state**

Append to the private change record:

```markdown
## Default-branch retirement

- Retirement PR: recorded by number only
- Default-branch SHA: recorded as abbreviated SHA
- Retired source paths: absent
- Workflow `ANTHROPIC_API_KEY` consumers: 0
- Docs CI: successful for the merged SHA
- Repository secret: retained pending exact provider-key revocation
```

Write `.superpowers/sdd/retire-ai-docs-task-3-report.md` with the merge, default-branch, and Docs CI verification results.

---

### Task 4: Revoke the provider credential and delete the repository secret

**Files:**
- Update: `internal/security-containment/2026-07-24-doc-automation-retirement/change-record.md`
- Update: `internal/security-remediation/2026-07-23-execution-ledger.md`
- Create: `internal/security-containment/2026-07-24-doc-automation-retirement/secret-metadata.after.json`
- Report: `.superpowers/sdd/retire-ai-docs-task-4-report.md`

**Interfaces:**
- Consumes: merged/default-branch verification from Task 3 and user confirmation identifying the exact provider credential.
- Produces: provider credential revoked, GitHub repository secret absent, and accurately updated containment state.

- [ ] **Step 1: Identify the exact provider credential without sharing its value**

The incident owner must inspect the Anthropic provider console and provide only:

```text
- provider key label or non-secret ID
- whether the key is dedicated to documentation automation
- last-use metadata, if available
```

Expected: no credential value is pasted into chat, reports, evidence, shell history, or repository files.

If the key is shared with any legitimate product consumer, stop this task. Create a separate approved rotation plan that moves each legitimate consumer to a dedicated credential before revoking the old key.

- [ ] **Step 2: Revoke the exact provider credential**

The incident owner revokes the identified credential in the Anthropic console and supplies only the provider audit event/reference.

Expected: provider shows the key as revoked/deleted. The old credential can no longer authenticate.

- [ ] **Step 3: Delete the now-unused GitHub Actions repository secret**

Run:

```bash
set -euo pipefail
repo="LanternOps/breeze"
gh secret delete ANTHROPIC_API_KEY --repo "$repo"
if gh api "repos/$repo/actions/secrets/ANTHROPIC_API_KEY" >/dev/null 2>&1; then
  echo "repository secret still exists" >&2
  exit 1
fi
test "$(gh secret list --repo "$repo" --json name --jq '[.[] | select(.name == "ANTHROPIC_API_KEY")] | length')" = "0"
echo "repository-secret=absent"
```

Expected: `repository-secret=absent`.

- [ ] **Step 4: Record after-state metadata without a secret**

Create `secret-metadata.after.json` with:

```json
{
  "repository": "LanternOps/breeze",
  "secretName": "ANTHROPIC_API_KEY",
  "present": false,
  "providerCredentialStatus": "revoked",
  "providerAuditReferenceRecorded": true
}
```

Set mode:

```bash
chmod 600 internal/security-containment/2026-07-24-doc-automation-retirement/secret-metadata.after.json
```

- [ ] **Step 5: Update the private records**

Append to the change record:

```markdown
## Credential closure

- Exact provider credential identified by non-secret label/ID.
- Shared-use check: documentation-dedicated.
- Provider status: revoked.
- Provider audit reference: recorded privately.
- GitHub repository secret: absent.
- Historical limitation: 32 reviewed PR runs remain inconclusive because GitHub no longer retains their logs; this is neither a clean finding nor evidence of compromise.
```

Update ledger semantics:

```text
- CI-PR-SECRET-001: Contained=Yes, Code merged=Yes, Deployed=Yes, Observed=Yes, Enforced=Yes
- CI-E2E-LOCK-001: Contained=Yes, Code merged=Yes, Deployed=Yes, Observed=Yes, Enforced=Yes
- CI-DEVSIGN-001: leave Partial
- CI-ACTIONS-001: leave its existing state
```

`CI-PR-SECRET-001` evidence must link the change record, merged PR number, default-branch verification, provider audit reference, and repository-secret absence. `CI-E2E-LOCK-001` evidence must link the removed verifier path, deterministic guard, and green Docs CI.

- [ ] **Step 6: Write the final task report**

Write `.superpowers/sdd/retire-ai-docs-task-4-report.md` with:

```markdown
# Task 4 report

Status: DONE

## Credential closure

- Provider credential: identified by non-secret label/ID and revoked
- Provider audit reference: recorded privately
- GitHub Actions repository secret: absent

## Finding state

- CI-PR-SECRET-001: contained and enforced
- CI-E2E-LOCK-001: contained and enforced through retirement
- CI-DEVSIGN-001: unchanged, Partial
- CI-ACTIONS-001: unchanged

## Historical limitation

Thirty-two historical PR runs remain inconclusive because their logs are no longer retained. No retrievable run had a positive logged exfiltration indicator.
```

Expected: no secret value or sensitive provider material appears in the report.
