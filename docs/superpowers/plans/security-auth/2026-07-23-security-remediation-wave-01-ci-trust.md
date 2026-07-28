# Security Remediation Wave 1 CI Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pull-request CI deterministic and secret-free, pin every external GitHub Action to an immutable commit, and separate arbitrary-ref unsigned builds from independently approved signing/notarization.

**Architecture:** Repository policy tests enforce the trust boundary before workflow linting. PR documentation checks execute only checked-in, deterministic code and receive no secret. Anthropic-assisted verification runs after merge on a fresh runner in a protected environment. Developer builds resolve an input ref to an immutable SHA, produce a digest-bound unsigned artifact without credentials, and pass only that artifact to a protected signing job that never checks out or rebuilds source.

**Tech Stack:** GitHub Actions and environments, Node.js built-in test runner, dependency-free workflow scanners, GitHub CLI/REST API, npm lockfile v3, pnpm, Vitest, actionlint 1.7.12, Zizmor 1.25.2, Go 1.25.12, macOS `codesign` and `notarytool`.

## Global Constraints

- Findings covered: `CI-ACTIONS-001`, `CI-PR-SECRET-001`, `CI-DEVSIGN-001`, and `CI-E2E-LOCK-001`.
- Implementation branch: `fix/security-review-ci-trust`, created from the SHA freshly advertised by `origin/main`.
- Stage 0 remains active while this wave is developed: `.github/workflows/doc-verify.yml` stays disabled and `ENABLE_MACOS_SIGNING=false`.
- Do not run workflow code or build artifacts from an unreviewed ref while implementing this plan.
- Every external `uses:` value in `.github/workflows/*.yml` must end in a full 40-character lowercase hexadecimal commit SHA. Preserve the prior tag as an end-of-line comment, for example `# v7`.
- Pinning all workflow references and changing `.github/zizmor.yml` to hash-only enforcement is one atomic change. A partially pinned state must not merge.
- A PR-triggered workflow that checks out repository code must not reference `secrets.*` anywhere in the job. A later secret-bearing step on the same runner is forbidden.
- Never introduce `pull_request_target` that checks out or executes a pull-request head, merge ref, or head repository.
- `e2e-tests/package-lock.json` remains the standalone dependency contract. CI uses `npm ci --prefix e2e-tests`; it does not use `pnpm install --ignore-workspace`, `npm install`, `npx`, or an executable that can be downloaded on demand.
- The arbitrary-ref developer workflow reads signing credentials only from `macos-signing`; its
  signing job has no source checkout or build command. Existing protected-release consumers in
  `release.yml` continue using repository secrets until a separate atomic release-job migration is
  implemented and canaried; Wave 1 must not delete credentials they still consume.
- Public changes state the invariant restored, not the exploit sequence.
- Complete one independent security review after all Wave 1 tasks and before merge.

---

### Task 1: Add a repository workflow-security policy test

**Files:**

- Create: `.github/scripts/check-workflow-security.mjs`
- Create: `.github/scripts/check-workflow-security.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/security.yml`

**Interfaces:**

```javascript
export function inspectWorkflowText(file, text) {
  return [{ file, line, rule, message }];
}

export function inspectWorkflowDirectory(rootDirectory) {
  return [{ file, line, rule, message }];
}
```

Rules emitted by `inspectWorkflowText`:

- `external-uses-must-be-sha`: any non-local `uses:` value does not match `owner/repository[/path]@[0-9a-f]{40}`; `docker://` workflow steps are rejected because they cannot satisfy this repository's full-action-SHA contract;
- `pr-workflow-must-be-secret-free`: a workflow triggered by `pull_request` checks out repository code and contains `secrets.`;
- `pr-target-must-not-execute-head`: a workflow triggered by `pull_request_target` checks out a ref derived from `github.event.pull_request.head`, `github.head_ref`, or a pull-request merge ref.

- [ ] Write failing Node tests using temporary workflow directories.

Required cases:

1. rejects `uses: actions/checkout@v7`;
2. accepts `uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7`;
3. accepts `uses: ./path/to/local-action` and rejects `uses: docker://alpine:latest`;
4. rejects a `pull_request` workflow with checkout plus `${{ secrets.ANTHROPIC_API_KEY }}`;
5. accepts a secret-free `pull_request` workflow with checkout;
6. accepts a `schedule`-only secret-bearing workflow;
7. rejects `pull_request_target` plus `ref: ${{ github.event.pull_request.head.sha }}`;
8. reports the source filename, line, and stable rule ID;
9. scans both `.yml` and `.yaml`.

```bash
node --test .github/scripts/check-workflow-security.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] Implement the dependency-free scanner.

Implementation requirements:

- ignore blank/comment-only lines;
- parse `uses:` from steps and reusable-workflow jobs;
- recognize `pull_request`/`pull_request_target` in block, scalar, and inline-list `on` forms;
- use indentation only to locate the `on` block; do not treat a commented trigger as active;
- reject uppercase SHA characters to make the canonical form deterministic;
- sort violations by filename, line, then rule;
- CLI mode scans `.github/workflows`, prints one violation per line, and exits `1` on any violation.

- [ ] Run the focused tests.

```bash
node --test .github/scripts/check-workflow-security.test.mjs
```

Expected: PASS, 9 or more tests, exit `0`.

- [ ] Add these root scripts:

```json
"test:workflow-security": "node --test .github/scripts/check-workflow-security.test.mjs scripts/security/pin-github-actions.test.mjs && node .github/scripts/check-workflow-security.mjs",
"pin:github-actions": "node scripts/security/pin-github-actions.mjs"
```

The pinning test path is added now and becomes green in Task 2.

- [ ] In `.github/workflows/security.yml`, add an explicit Node setup and run the dependency-free
  policy scripts in the existing `workflow-lint` job after checkout and before actionlint:

```yaml
- name: Setup Node
  uses: actions/setup-node@v7 # temporary resolver input; Task 2 pins it before push
  with:
    node-version: '22.19.0'

- name: Run workflow security policy
  run: |
    node --test \
      .github/scripts/check-workflow-security.test.mjs \
      scripts/security/pin-github-actions.test.mjs
    node .github/scripts/check-workflow-security.mjs
```

Do not push the intermediate commit containing the temporary setup-node tag. Task 2 resolves it to
a full SHA together with every other Action reference before the repository-wide policy turns green.

- [ ] Confirm the policy fails against the current mutable GitHub-owned actions.

```bash
node .github/scripts/check-workflow-security.mjs
```

Expected: FAIL with `external-uses-must-be-sha` violations including `actions/checkout@v7`. Do not weaken the rule to make this intermediate state green.

- [ ] Commit the red policy tests and scanner only on the Wave 1 branch; do not merge until Task 2 makes the repository-wide check green.

```bash
git add .github/scripts/check-workflow-security.mjs \
  .github/scripts/check-workflow-security.test.mjs \
  .github/workflows/security.yml package.json
git commit -m "test(ci): enforce immutable secret-free workflows"
```

### Task 2: Pin every external action atomically

**Files:**

- Create: `scripts/security/pin-github-actions.mjs`
- Create: `scripts/security/pin-github-actions.test.mjs`
- Modify: every file under `.github/workflows/` containing an external `uses:`
- Modify: `.github/zizmor.yml`
- Verify: `.github/dependabot.yml`

**Interfaces:**

```javascript
export function findMutableActionReferences(text) {
  return [{ owner, repository, path, ref, line }];
}

export async function pinWorkflowText(text, resolveCommit) {
  return { text, changedReferences };
}

export async function resolveActionCommit(owner, repository, ref) {
  return "40-character-lowercase-sha";
}
```

`resolveActionCommit` invokes `gh api` with `execFile`, never a shell, against:
`repos/{owner}/{repository}/commits/{url-encoded-ref}`.

- [ ] Write failing tests for the mechanical pinner.

Required cases:

1. converts `actions/checkout@v7` to a resolver-provided SHA and appends `# v7`;
2. converts `github/codeql-action/upload-sarif@v4` while retaining the action subpath;
3. preserves a pre-existing version comment;
4. leaves a 40-character SHA unchanged;
5. leaves `./local-action` unchanged and rejects `docker://` as unsupported by the repository policy;
6. deduplicates resolver calls for the same owner/repository/ref;
7. rejects a resolver result that is not 40 lowercase hexadecimal characters;
8. `--check` exits non-zero without writing when mutable refs remain.

```bash
node --test scripts/security/pin-github-actions.test.mjs
```

Expected: FAIL because the implementation does not exist.

- [ ] Implement the pinner with these CLI modes:

```text
node scripts/security/pin-github-actions.mjs --check
node scripts/security/pin-github-actions.mjs --write
```

`--write` scans `.github/workflows/**/*.yml` and `*.yaml`, resolves tags/branches through authenticated GitHub REST calls, rewrites only the `uses:` token/comment, and prints a file/reference summary. It must never print `GH_TOKEN`.

- [ ] Run unit tests.

```bash
node --test scripts/security/pin-github-actions.test.mjs
```

Expected: PASS, 8 or more tests.

- [ ] Authenticate `gh`, verify the requested tag targets through the REST resolver, and apply all pins in one mechanical run.

```bash
gh auth status
pnpm pin:github-actions -- --write
```

Expected: every mutable external reference is replaced; existing third-party SHA pins are unchanged; each changed line retains a readable version comment.

- [ ] Replace `.github/zizmor.yml` `unpinned-uses` policies with one hash-only rule:

```yaml
rules:
  unpinned-uses:
    config:
      policies:
        "*": hash-pin
```

Preserve the existing `cache-poisoning` section unchanged.

- [ ] Verify the atomic result.

```bash
pnpm test:workflow-security
rg -n 'uses:\s+[^#[:space:]]+@(v[0-9]|main|master|stable|latest)\b' .github/workflows
pipx run zizmor==1.25.2 --no-progress \
  --config .github/zizmor.yml --min-severity medium .github/workflows/
```

Expected:

- policy tests and repository scan PASS;
- `rg` returns no rows;
- Zizmor reports no mutable-reference finding.

- [ ] Verify the scanner covers the complete workflow set and comments remain automation-readable.

```bash
find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 |
  sort -z |
  xargs -0 rg -n 'uses:'
git diff --check
```

Expected: every external reference visibly contains a 40-character SHA; the preceding tag remains in a `#` comment. `.github/dependabot.yml` continues to include the `github-actions` ecosystem.

- [ ] Commit the pinner, all workflow pins, and Zizmor hash enforcement together.

```bash
git add scripts/security/pin-github-actions.mjs \
  scripts/security/pin-github-actions.test.mjs \
  .github/workflows .github/zizmor.yml
git commit -m "chore(ci): pin workflow dependencies immutably"
```

### Task 3: Make pull-request documentation checks deterministic and secret-free

**Files:**

- Create: `e2e-tests/doc-verify/cliArgs.ts`
- Create: `e2e-tests/doc-verify/cliArgs.test.ts`
- Modify: `e2e-tests/doc-verify/cli.ts`
- Modify: `e2e-tests/vitest.config.ts`
- Modify: `e2e-tests/package.json`
- Modify: `.github/workflows/doc-verify.yml`

**Interfaces:**

```typescript
export type DocAssertionType = 'api' | 'sql' | 'ui';

export interface DocVerifyCliArgs {
  command: 'extract' | 'run' | 'all';
  incremental: boolean;
  page?: string;
  types?: DocAssertionType[];
}

export function parseDocVerifyCliArgs(argv: string[]): DocVerifyCliArgs;
```

- [ ] Write failing parser tests.

Required cases:

1. defaults to command `all`;
2. parses `run --types=api,sql`;
3. normalizes duplicate types while preserving `api`, `sql`, `ui` order;
4. rejects an empty type list;
5. rejects an unknown type;
6. preserves `--incremental` and `--page=path`;
7. rejects `--types` for `extract` because extraction has no execution filter.

```bash
npm ci --prefix e2e-tests
(cd e2e-tests && ./node_modules/.bin/vitest run doc-verify/cliArgs.test.ts)
```

Expected: FAIL because `cliArgs.ts` does not exist. The executable is the lockfile-installed binary; no package-manager fallback can download code.

- [ ] Implement `parseDocVerifyCliArgs`, update `cli.ts` to pass `types` as `runAssertions(..., { typeFilter: types })`, and include the selected types in the console summary. Export no secret-bearing environment values.

- [ ] Add to `e2e-tests/package.json`:

```json
"test:unit": "vitest run",
"playwright:install": "playwright install chromium"
```

- [ ] Change `e2e-tests/vitest.config.ts` include patterns to:

```typescript
include: ['live-signup/**/*.test.ts', 'doc-verify/**/*.test.ts'],
```

- [ ] Run the parser tests through the installed package script.

```bash
npm run --prefix e2e-tests test:unit -- doc-verify/cliArgs.test.ts
```

Expected: PASS, 7 or more tests.

- [ ] Rewrite `.github/workflows/doc-verify.yml` as a PR-only, secret-free workflow:

1. keep the current documentation and `e2e-tests/doc-verify/**` path filters;
2. keep `permissions: contents: read`;
3. checkout the pull-request revision using the pinned checkout action;
4. set up Node 22 using its pinned action;
5. run `npm ci --prefix e2e-tests`;
6. run `npm run --prefix e2e-tests test:unit -- doc-verify`;
7. do not start the product stack, extract assertions, initialize Playwright browsers, or reference any secret.

The complete job must contain no `secrets.`, `pnpm install`, `npm install`, `npx`, or `environment:`.

- [ ] Verify the PR trust boundary and lockfile determinism.

```bash
pnpm test:workflow-security
cp e2e-tests/package-lock.json /tmp/breeze-e2e-package-lock.before
npm ci --prefix e2e-tests
cmp /tmp/breeze-e2e-package-lock.before e2e-tests/package-lock.json
npm run --prefix e2e-tests test:unit -- doc-verify
```

Expected: all commands PASS; `cmp` emits no output; tests do not need `ANTHROPIC_API_KEY`.

- [ ] Commit the deterministic PR workflow.

```bash
git add e2e-tests/doc-verify/cliArgs.ts \
  e2e-tests/doc-verify/cliArgs.test.ts \
  e2e-tests/doc-verify/cli.ts e2e-tests/vitest.config.ts \
  e2e-tests/package.json .github/workflows/doc-verify.yml
git commit -m "fix(ci): keep pull request documentation checks secret-free"
```

### Task 4: Move Anthropic-assisted verification to trusted code on a fresh runner

**Files:**

- Create: `.github/workflows/doc-verify-protected.yml`
- Delete: `.github/workflows/docs-review.yml`
- Verify: `docker-compose.doc-verify.yml`
- GitHub environment: `documentation-verification`
- Environment secret: `ANTHROPIC_API_KEY`

- [ ] Confirm with the documentation owner that `.github/workflows/docs-review.yml` is obsolete: its only active trigger is `workflow_dispatch`, while its job condition requires a merged `pull_request`, so it cannot run successfully. Record that confirmation in the private change ticket, then delete the workflow rather than retaining a second secret-bearing AI path with `contents: write`.

- [ ] Add `.github/workflows/doc-verify-protected.yml` with:

```yaml
name: Protected Documentation Verification

on:
  push:
    branches: [main]
    paths:
      - 'apps/docs/src/content/docs/getting-started/**'
      - 'apps/docs/src/content/docs/agents/**'
      - 'e2e-tests/doc-verify/**'
      - 'docker-compose.doc-verify.yml'
  workflow_dispatch:

permissions:
  contents: read

jobs:
  verify:
    environment: documentation-verification
    runs-on: ubuntu-latest
    timeout-minutes: 20
```

Complete the steps as follows, using the pinned actions from Task 2:

1. checkout `${{ github.sha }}`; do not accept a ref input;
2. set up Node 22 and pnpm 10.34.5;
3. run `pnpm install --frozen-lockfile`;
4. run `npm ci --prefix e2e-tests`;
5. run `npm run --prefix e2e-tests playwright:install`;
6. start `docker-compose.doc-verify.yml` and wait for health;
7. run `npm run --prefix e2e-tests doc-verify -- extract`;
8. run `npm run --prefix e2e-tests doc-verify -- run`;
9. expose `ANTHROPIC_API_KEY` only on steps 7 and 8 from `${{ secrets.ANTHROPIC_API_KEY }}`;
10. upload assertions and reports as a 14-day artifact;
11. tear the stack down with `if: always()`.

- [ ] Create `documentation-verification` from GitHub repository settings with deployment limited to protected branches. Add `ANTHROPIC_API_KEY` as an environment secret from the provider; do not copy or expose the old repository-secret value.

```bash
gh secret set --env documentation-verification ANTHROPIC_API_KEY \
  --repo LanternOps/breeze
gh api repos/LanternOps/breeze/environments/documentation-verification \
  >"$BREEZE_CONTAINMENT_EVIDENCE/documentation-environment.json"
gh api repos/LanternOps/breeze/environments/documentation-verification/secrets \
  --jq '[.secrets[].name] | sort'
```

Expected: environment policy limits deployment to protected branches; secret list is exactly `["ANTHROPIC_API_KEY"]`.

- [ ] After the environment secret is verified, delete the repository-scoped Anthropic secret so no other workflow can reference it.

```bash
gh secret delete ANTHROPIC_API_KEY --repo LanternOps/breeze
```

- [ ] Verify workflow policy and local lockfiles.

```bash
pnpm test:workflow-security
npm ci --prefix e2e-tests
git diff --exit-code -- e2e-tests/package-lock.json
```

Expected: PASS; protected workflow is not a PR workflow and has no mutable action; npm does not change the lockfile.

- [ ] Commit the protected path.

```bash
git add .github/workflows/doc-verify-protected.yml \
  .github/workflows/docs-review.yml
git commit -m "fix(ci): isolate assisted documentation verification"
```

### Task 5: Split immutable unsigned builds from protected signing

**Files:**

- Modify: `.github/workflows/dev-build-agent.yml`
- GitHub environment: `macos-signing`
- Environment secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`
- Repository variable: `ENABLE_MACOS_SIGNING`

- [ ] Add a `resolve` job that receives the existing `branch`, `platform`, and `version` inputs but executes no repository code. Use the pinned `actions/github-script` action to call:

```javascript
const response = await github.rest.repos.getCommit({
  owner: context.repo.owner,
  repo: context.repo.repo,
  ref: inputs.branch,
});
const sourceSha = response.data.sha;
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  core.setFailed('Requested ref did not resolve to an immutable commit SHA');
  return;
}
core.setOutput('source_sha', sourceSha);
```

Use `github.rest.repos.compareCommits({ owner, repo, base: sourceSha, head: context.payload.repository.default_branch })` to output `main_ancestry=ancestor_or_equal` only for comparison status `ahead` or `identical`; output `main_ancestry=not_ancestor` for every other successful status and `main_ancestry=unknown` if comparison fails. This value is advisory metadata only and must not bypass or suppress environment approval.

Also output a sanitized source label for artifact metadata. Do not interpolate the branch into a shell command.

Add `actions/github-script@v8` as the temporary resolver input, immediately run `pnpm pin:github-actions -- --write`, and commit only the resulting full-SHA reference with `# v8`. The mutable tag must never reach a pushed commit.

- [ ] Replace `build-arm64` and `build-amd64` with one `build-unsigned` matrix job:

- `needs: resolve`;
- `runs-on: macos-latest`;
- matrix architectures `arm64` and `amd64`, filtered by the existing `platform` input;
- checkout only `${{ needs.resolve.outputs.source_sha }}`;
- verify `git rev-parse HEAD` equals that output;
- build `agent/breeze-agent-darwin-${{ matrix.arch }}`;
- copy `agent/entitlements/agent-macos.entitlements.plist` into the artifact as
  `agent-macos.entitlements.plist`;
- create `provenance.json` containing source SHA, advisory main-ancestry result, architecture,
  requested version, workflow run ID, unsigned binary SHA-256, and entitlements SHA-256;
- create a `SHA256SUMS` file covering the unsigned binary and entitlements;
- upload `unsigned-breeze-agent-${{ matrix.arch }}-${{ needs.resolve.outputs.source_sha }}`.

The job has no `environment`, no `secrets.*`, no certificate import, no codesign, and no notarization.

- [ ] Add a `sign-notarize` matrix job:

- `needs: [resolve, build-unsigned]`;
- `if` requires `vars.ENABLE_MACOS_SIGNING == 'true'` and the selected architecture;
- `environment: macos-signing`;
- runs on `macos-latest`;
- downloads only the matching unsigned artifact;
- checks `provenance.json.sourceSha` equals `needs.resolve.outputs.source_sha`;
- runs `shasum -a 256 -c SHA256SUMS` before reading any signing secret;
- signs with the downloaded, digest-verified `agent-macos.entitlements.plist`;
- imports the certificate into an ephemeral keychain;
- signs the downloaded binary in place;
- verifies it with `codesign --verify --strict --verbose=2`;
- notarizes without invoking `go`, `git`, checkout, or any build command;
- writes a separate signed SHA-256 and uploads `signed-breeze-agent-${arch}-${source_sha}`;
- deletes the keychain with `if: always()`.

- [ ] Add a workflow-policy fixture/test that fails if a job in
  `.github/workflows/dev-build-agent.yml` containing an `APPLE_` secret also contains
  `actions/checkout`, `go build`, `cargo build`, `npm run build`, or `pnpm build`. Use stable rule ID
  `signing-job-must-not-build-source`.

Scope this rule to the arbitrary-ref developer workflow. Do not apply it to the existing protected
release jobs while they still combine trusted-tag builds and signing; doing so would make
repository policy unpassable without implementing an unplanned release-pipeline split.

- [ ] Run the focused policy tests and workflow scan.

```bash
pnpm test:workflow-security
```

Expected: PASS; the signed job has no checkout/build source path and all action refs are full SHAs.

- [ ] Keep `ENABLE_MACOS_SIGNING=false` and dispatch one arbitrary-branch canary.

```bash
gh workflow run dev-build-agent.yml \
  -f branch=main -f platform=darwin-arm64 -f version=wave1-unsigned-canary
```

Expected: `resolve` and `build-unsigned` pass, unsigned artifact digest matches its provenance, and `sign-notarize` is skipped. This proves arbitrary-ref unsigned builds remain available.

- [ ] Commit the workflow split.

```bash
git add .github/workflows/dev-build-agent.yml \
  .github/scripts/check-workflow-security.mjs \
  .github/scripts/check-workflow-security.test.mjs
git commit -m "fix(release): separate unsigned builds from protected signing"
```

### Task 6: Configure and verify the signing environment

**Interfaces:**

- GitHub environment REST endpoint: `repos/LanternOps/breeze/environments/macos-signing`
- Required independent reviewers: at least one named reviewer/team other than the workflow dispatcher
- Deployment branch policy: protected branches only

- [ ] In GitHub repository settings, create `macos-signing`, enable required reviewers, enable prevention of self-review, and limit deployments to protected branches. The workflow definition is dispatched from the default branch; the source artifact may come from any immutable commit after review.

- [ ] Reuse the Stage 0 private evidence directory without placing infrastructure configuration in git.

```bash
umask 077
export BREEZE_CONTAINMENT_EVIDENCE="$PWD/internal/security-containment/2026-07-23"
test -d "$BREEZE_CONTAINMENT_EVIDENCE"
```

Expected: the existing private incident directory is present; if it is not, stop and have the incident owner identify the approved evidence location.

- [ ] Populate all six environment secrets interactively from the approved credential store:

```bash
for BREEZE_SIGNING_SECRET in \
  APPLE_CERTIFICATE \
  APPLE_CERTIFICATE_PASSWORD \
  APPLE_SIGNING_IDENTITY \
  APPLE_ID \
  APPLE_PASSWORD \
  APPLE_TEAM_ID
do
  gh secret set --env macos-signing "$BREEZE_SIGNING_SECRET" \
    --repo LanternOps/breeze
done
unset BREEZE_SIGNING_SECRET
```

Expected: every command prompts; no value appears in terminal history or output.

- [ ] Verify configuration through GitHub, not YAML inference.

```bash
gh api repos/LanternOps/breeze/environments/macos-signing \
  >"$BREEZE_CONTAINMENT_EVIDENCE/macos-signing-environment.json"

jq -e '
  any(.protection_rules[];
    .type == "required_reviewers"
    and (.reviewers | length) >= 1
    and .prevent_self_review == true)
  and .deployment_branch_policy.protected_branches == true
' "$BREEZE_CONTAINMENT_EVIDENCE/macos-signing-environment.json"

gh api repos/LanternOps/breeze/environments/macos-signing/secrets \
  --jq '[.secrets[].name] | sort' \
  >"$BREEZE_CONTAINMENT_EVIDENCE/macos-signing-secret-names.json"
```

Expected: `jq` exits `0`; the names file contains exactly the six names above and no values.

- [ ] Inventory and preserve the existing protected-release consumers before enabling the
  developer signing path.

```bash
rg -n 'secrets\\.APPLE_(CERTIFICATE|CERTIFICATE_PASSWORD|SIGNING_IDENTITY|ID|PASSWORD|TEAM_ID)' \
  .github/workflows/release.yml \
  >"$BREEZE_CONTAINMENT_EVIDENCE/release-apple-secret-consumers.txt"
test -s "$BREEZE_CONTAINMENT_EVIDENCE/release-apple-secret-consumers.txt"
```

Expected: the private inventory is non-empty. Do **not** delete the six repository secrets in this
wave. Open a separate high-rigor release-pipeline migration that splits every release build/sign
consumer, moves it to an independently reviewed environment, canaries agent/viewer/helper outputs,
and only then removes the repository copies. Wave 1 closes `CI-DEVSIGN-001` by removing the
arbitrary-ref developer workflow's access to repository secrets; it does not claim the broader
release migration is complete.

- [ ] Confirm `ENABLE_MACOS_SIGNING` remains `false` until the Wave 1 commit is on `main` and all merge gates pass.

### Task 7: Run the Wave 1 merge gate and controlled rollout

**Files:**

- Verify: all files under `.github/workflows/`
- Verify: `.github/zizmor.yml`
- Verify: `.github/scripts/check-workflow-security.test.mjs`
- Verify: `scripts/security/pin-github-actions.test.mjs`
- Verify: `e2e-tests/package-lock.json`
- Verify: `.github/workflows/dev-build-agent.yml`

- [ ] Run the local deterministic gate.

```bash
pnpm test:workflow-security
npm ci --prefix e2e-tests
npm run --prefix e2e-tests test:unit -- doc-verify
git diff --exit-code -- e2e-tests/package-lock.json
pipx run zizmor==1.25.2 --no-progress \
  --config .github/zizmor.yml --min-severity medium .github/workflows/
git diff --check
```

Expected: every command exits `0`; no lockfile changes; no mutable-action or trust-boundary violation.

- [ ] Push the Wave 1 branch and require these GitHub checks before merge:

- `Security Scanning / Workflow Lint`;
- the PR `Documentation Verification` unit job;
- the standard required API/web/agent jobs;
- independent Wave 1 review.

The independent reviewer checks requirement coverage, workflow expression safety, action-pin completeness, artifact/SHA binding, secret scope, environment configuration, and fail-closed rollback.

- [ ] Merge the complete wave atomically. Do not merge action pinning separately from Zizmor enforcement or merge signing YAML before the environment exists.

- [ ] Verify the post-merge protected documentation run:

```bash
gh run list --workflow doc-verify-protected.yml --branch main --limit 3 \
  --json databaseId,headSha,status,conclusion,url
```

Expected: the run uses the merged `main` SHA and a fresh protected job; no PR head is checked out.

- [ ] Re-enable the secret-free PR workflow after its merged YAML is verified.

```bash
gh workflow enable doc-verify.yml
```

- [ ] Enable signing and dispatch one main-branch canary.

```bash
gh variable set ENABLE_MACOS_SIGNING --body true
gh workflow run dev-build-agent.yml \
  -f branch=main -f platform=darwin-arm64 -f version=wave1-signed-canary
```

Expected:

- unsigned build completes before the environment approval;
- a reviewer other than the dispatcher approves `macos-signing`;
- signing job downloads the exact unsigned artifact and verifies its SHA;
- no source checkout/build occurs in the signing job;
- signed artifact passes `codesign --verify --strict`;
- notarization succeeds.

- [ ] Test the fail-closed path by withholding approval on a second canary. Expected: unsigned artifact is available; signing remains waiting/skipped; no credential is exposed.

- [ ] Rollout completion requires one arm64 and one amd64 signed canary, matching provenance/digests, and no unexplained workflow-policy exception.

### Task 8: Rollback and closure

- [ ] If PR documentation CI fails, disable only `doc-verify.yml`; do not restore the former secret-bearing PR steps.

```bash
gh workflow disable doc-verify.yml
```

- [ ] If protected Anthropic verification fails, disable only `doc-verify-protected.yml`, retain the secret-free PR unit checks, and keep the key environment-scoped.

```bash
gh workflow disable doc-verify-protected.yml
```

- [ ] If signing/provenance/notarization fails, darken signing while preserving unsigned builds.

```bash
gh variable set ENABLE_MACOS_SIGNING --body false
```

- [ ] A code rollback reverts the Wave 1 commit on `main`, but the operator must keep
  `doc-verify.yml` disabled and `ENABLE_MACOS_SIGNING=false` until the corrected Wave 1 reapplies.
  Never reconnect the arbitrary-ref developer workflow to repository-scoped signing secrets, roll
  back to mutable Action tags, or restore Anthropic execution on PR-controlled code. Existing
  protected-release consumers remain unchanged until their separately approved migration.

- [ ] Record final evidence:

```bash
pnpm test:workflow-security \
  >"$BREEZE_CONTAINMENT_EVIDENCE/wave1-workflow-policy.txt" 2>&1
gh api repos/LanternOps/breeze/environments/macos-signing \
  >"$BREEZE_CONTAINMENT_EVIDENCE/wave1-macos-signing-environment.json"
gh run list --workflow dev-build-agent.yml --limit 5 \
  --json databaseId,headSha,status,conclusion,url \
  >"$BREEZE_CONTAINMENT_EVIDENCE/wave1-signing-runs.json"
```

- [ ] Close the wave only when all four finding IDs have a regression/policy test, environment configuration has been independently verified, both architectures pass the signed canary, and the independent reviewer has no unresolved Critical or Important finding.
