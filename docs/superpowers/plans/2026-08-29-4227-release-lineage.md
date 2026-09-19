# Issue #4227 Release-Lineage Implementation Plan

> **For executor:** Use `executing-plans`. This is high-blast-radius
> migration/release governance: use strict TDD and one independent review for
> the entire implementation.

**Goal:** Restore an honest `Check Migrations` verdict on main while freezing
migrations on the lineage where they shipped, and prevent a non-main candidate
from being published as production.

**Architecture:** Add an exact candidate ledger and reusable lineage classifier.
Make the migration guard select the highest ancestor tag and classify higher
non-ancestor tags. Gate release publication with the classifier, recognize
candidates in history monitoring, and ancestry-gate draft promotion.

**Design:** `docs/superpowers/specs/2026-08-29-4227-release-lineage-design.md`

**Start:** `fix/4227-release-lineage` at
`5c2d0578db1fe1546f114ac0258a0dad38c1d71b`, based on main
`355b3746565784a9a3cb9dea282372e934b55abd`.

**Technology:** Bash 3.2-compatible shell, Git, Node.js `node:test`, GitHub
Actions YAML, and `gh` inside the promotion workflow.

## Global constraints

- Never edit, rename, copy, reconcile, or renumber an SQL migration.
- Never move/delete a tag, publish a release, dispatch promotion, or deploy.
- Candidate identity is exact tag plus exact commit; never patch equivalence.
- Repository CI may read the ledger in its reviewed tree. Release creation and
  promotion must read it from `origin/main`.
- Preserve explicit-base guard operation, checksum reconciliations, the stable
  side-branch registry, and the main root check.
- Use one implementation-wide review after all code is complete. No per-task or
  reassurance reviews.
- Run focused tests and `git diff --check` before every commit.

---

## Task 1: Candidate ledger and lineage classifier

**Files:**

- Create `.github/release-provenance/candidate-tags.tsv`
- Create `scripts/release/check-release-lineage.sh`
- Create `scripts/release/check-release-lineage.test.mjs`
- Modify `package.json`

### Step 1: Write failing tests

Use `node:test`, `mkdtemp`, local Git repos, and `spawnSync`. Freeze:

1. reachable tag returns `mainline` and exact SHA — create it with `git tag -a`
   so the test proves `tag_sha` is the peeled commit, not the tag object
   (`v0.108.0` is annotated in the live repo; the rc tags are lightweight);
2. exact registered prerelease outside main returns `candidate`;
3. stable non-main and unregistered prerelease tags fail;
4. duplicate or malformed rows fail;
5. recorded SHA different from peeled tag SHA fails;
6. a ledger present only on the candidate branch cannot authorize when the
   registry ref points at main;
7. `--allow-unclassified` returns `unclassified`;
8. `--require-mainline` rejects a valid candidate;
9. a `git clone --depth=1 file://...` of the fixture fails closed with a
   distinct shallow diagnostic before any tag is inspected (a plain local-path
   clone ignores `--depth`).

Invoke the real CLI with `--tag`, `--main-ref`, and
`--candidate-registry-ref` arguments.

### Step 2: Prove RED

```bash
node --test scripts/release/check-release-lineage.test.mjs
```

Expected: FAIL because the classifier does not exist.

### Step 3: Add the ledger

Create the TSV with comments and these exact rows:

```text
v0.109.0-rc.1	d473815e434141135b23a6cf51fca715e8218938	#4105/#4060	Track E lab candidate
v0.109.0-rc.2	fb1731e97c0d61a8c6d82420694daf186cfa44fa	#4105/#4060	Track E lab candidate
v0.109.0-rc.3	a11d432a6e68288eceef050933483c231f5d40dc	#4105/#4060	Track E accepted lab-evidence candidate
```

State that rows authorize draft candidates only—never publication, deployment,
rollout, or floating tags.

### Step 4: Implement the classifier

Support exactly:

```text
--tag TAG --main-ref REF --candidate-registry-ref REF
[--allow-unclassified] [--require-mainline]
```

Use `set -euo pipefail`. Fail closed when `git rev-parse --is-shallow-repository`
prints `true`. Validate SemVer tag syntax, peel with
`git rev-parse "$TAG^{commit}"`, and return `mainline` only when the peeled
commit is an ancestor of the supplied main ref. For a
non-main prerelease, read the ledger using `git show REGISTRY_REF:path`, validate
every row, reject duplicates, and require exact SHA equality. Emit `channel`,
`tag`, and `tag_sha` to `$GITHUB_OUTPUT` when set.

### Step 5: Add the package command

Add:

```json
"test:release-lineage": "node --test scripts/release/check-release-lineage.test.mjs scripts/check-migration-immutability.test.mjs"
```

The second file arrives in Task 2; until then run Task 1 directly.

### Step 6: Prove GREEN and commit

```bash
node --test scripts/release/check-release-lineage.test.mjs
bash scripts/release/check-release-lineage.sh --tag v0.109.0-rc.3 \
  --main-ref origin/main --candidate-registry-ref HEAD
git diff --check
git add .github/release-provenance/candidate-tags.tsv \
  scripts/release/check-release-lineage.sh \
  scripts/release/check-release-lineage.test.mjs package.json
git commit -m "feat(ci): classify exact candidate release lineages"
```

Expected live classification: `candidate` at
`a11d432a6e68288eceef050933483c231f5d40dc`.

---

## Task 2: Make migration immutability lineage-aware

**Files:**

- Create `scripts/check-migration-immutability.test.mjs`
- Modify `scripts/check-migration-immutability.sh`
- Modify `.github/workflows/ci.yml`
- Modify `apps/api/migrations/README.md`

### Step 1: Write failing migration tests

Create temporary repos with minimal migrations, `autoMigrate.ts`, tags,
branches, and ledgers. Invoke the real Bash guard from the Breeze checkout using
the fixture as `cwd`. Freeze:

1. highest ancestor selection with a higher registered candidate elsewhere;
2. candidate-only migrations are not deletions from main;
3. ancestral edit/delete/rename fails and names its baseline;
4. exact checksum reconciliation remains allowed;
5. candidate descendants select their candidate tag and detect mutation;
6. unregistered higher tag and candidate SHA mismatch fail;
7. higher stable side-branch release is an additional baseline only when its
   recorded equivalent is reachable;
8. the additional baseline detects mutation/deletion;
9. stale side-branch equivalent fails;
10. no tags skips, while tags with no reachable/classified baseline fail;
11. explicit base operation remains deterministic;
12. SemVer precedence: `v0.109.0-rc.3` and `v0.109.0` both ancestral selects
    `v0.109.0` (git's default `v:refname` ranks the prerelease higher, and the
    current script inherits that);
13. the primary baseline is an annotated tag (`git tag -a`) and is still
    selected and diffed correctly;
14. a higher tag reachable from `origin/main` but not from `HEAD` fails with
    the behind-mainline diagnostic even when the tag has a retained candidate
    row — the fixture needs a real `origin` remote (clone from a bare repo) so
    `origin/main` resolves;
15. a `--depth=1 file://...` clone fails closed in automatic mode with the
    shallow diagnostic.

### Step 2: Prove RED

```bash
node --test scripts/check-migration-immutability.test.mjs
```

Expected: FAIL because the current guard uses the global highest tag.

### Step 3: Implement resolution

Keep existing per-file rules. In automatic mode:

1. fetch tags when an origin exists; fail closed with a distinct message when
   `git rev-parse --is-shallow-repository` prints `true`;
2. select the highest `v*` tag merged into `HEAD` under SemVer precedence
   (`git -c versionsort.suffix=- tag --sort=-v:refname`, or an explicit
   comparator); use the same ordering to decide which tags are "higher";
3. distinguish no tags from no reachable baseline;
4. inspect every higher tag;
5. when `origin/main` resolves and the higher tag is an ancestor of it, fail
   with the behind-mainline diagnostic (merge/rebase main, or pass an explicit
   base ref) — do not exclude it, even when a retained candidate row records it;
6. validate exact candidate rows from the checked tree and exclude them from an
   unrelated lineage;
7. add a higher stable side-branch baseline only when its recorded equivalent is
   an ancestor of `HEAD`;
8. fail every other higher tag with the provenance error;
9. compare the primary plus applicable side-branch baselines;
10. preserve `--no-renames`, top-level SQL scope, additions, reconciliation,
    and working-tree comparison.

### Step 4: Wire tests and history into CI

Add `fetch-depth: 0` and `fetch-tags: true` to the `check-migrations` checkout.
Immediately before the shipped-migration guard add:

```yaml
- name: Release-lineage and migration-guard tests
  run: pnpm test:release-lineage
```

Do not broaden permissions or persist credentials. Update the migration README
to describe the lineage contract instead of “latest release tag.”

### Step 5: Prove GREEN and commit

```bash
pnpm test:release-lineage
bash scripts/check-migration-immutability.sh
bash scripts/check-migration-immutability.sh v0.108.0
git diff --name-only origin/main...HEAD -- apps/api/migrations
git diff --check
git add scripts/check-migration-immutability.sh \
  scripts/check-migration-immutability.test.mjs \
  .github/workflows/ci.yml apps/api/migrations/README.md
git commit -m "fix(ci): resolve migration baselines by release lineage"
```

Expected: automatic baseline `v0.108.0`, all three rc tags classified as
candidates, guard OK, and no migration file output.

---

## Task 3: Gate release publication

**Files:**

- Modify `scripts/release/check-release-lineage.test.mjs`
- Modify `.github/scripts/check-workflow-security.mjs`
- Modify `.github/workflows/release.yml`

### Step 1: Add failing workflow tests

Import `.github/scripts/check-workflow-security.mjs` as a namespace. First
assert that `activeLines`, `workflowJobs`, and `topLevelLogicalParts` are exposed
as functions; this is RED against the current internal-only helpers. Then parse
`release.yml` with those helpers rather than regexes over YAML and assert:

1. `validate-release-lineage` exists with full history and tags, and carries
   the same job-level gate as `create-release` (`github.ref_type == 'tag'`,
   `startsWith(github.ref, 'refs/tags/v')`, and not a `skip_release`
   dispatch) so a build-only branch dispatch skips it instead of failing on a
   non-SemVer ref name;
2. it resolves `origin/main` explicitly and uses that registry ref;
3. `create-release` lists it in `needs:` **and** its `if:` contains
   `needs.validate-release-lineage.result == 'success'` as a top-level `&&`
   conjunct — the existing `if:` uses `!cancelled()`, which disables the
   implicit `success()` gate, so a `needs:` entry alone does not block
   publication (`release.yml` lines 2114–2132);
4. candidate channel forces draft independently of `RELEASE_DRAFT_FIRST`;
5. all GHCR publishers remain transitively behind `create-release`;
6. prerelease metadata cannot emit `latest`, major, or minor tags.

### Step 2: Prove RED

```bash
node --test scripts/release/check-release-lineage.test.mjs
```

Expected: FAIL on the missing validation job and draft expression.

### Step 3: Implement the gate

Export `activeLines`, `workflowJobs`, and `topLevelLogicalParts` from the
existing workflow-security module without changing their behavior. Add a
read-only job that checks out full history/tags, resolves `origin/main`,
runs the classifier for `github.ref_name`, and exposes `channel`, `tag`, and
`tag_sha`. Give it the `create-release` tag gate as its own `if:`. It may run
beside build jobs, but `create-release` must both list it in `needs:` and add
`&& needs.validate-release-lineage.result == 'success'` to its `if:`
expression; `'success'` also excludes a skipped validation.

Use:

```yaml
draft: ${{ needs.validate-release-lineage.outputs.channel == 'candidate' || vars.RELEASE_DRAFT_FIRST == 'true' }}
```

Preserve the existing image dependency on `create-release` and exact/SHA
prerelease tags.

### Step 4: Prove GREEN and commit

```bash
pnpm test:release-lineage
pnpm test:workflow-security
git diff --check
git add .github/scripts/check-workflow-security.mjs \
  .github/workflows/release.yml \
  scripts/release/check-release-lineage.test.mjs
git commit -m "fix(release): gate publication on exact tag lineage"
```

Do not push a tag or dispatch `release.yml`.

---

## Task 4: Candidate-aware drift and guarded promotion

**Files:**

- Modify `scripts/release/check-release-lineage.test.mjs`
- Modify `.github/workflows/drift-detector.yml`
- Modify `.github/workflows/release.yml`
- Create `.github/workflows/release-promotion.yml`

### Step 1: Add failing contracts

Assert:

1. drift classification uses `--allow-unclassified` with
   `--candidate-registry-ref origin/main` before the existing stable
   side-branch fallback;
2. candidate gets a distinct success while `unclassified` retains that fallback;
3. expected root SHA and stale-equivalent checks remain;
4. promotion is manual-only and defaults to `contents: read`;
5. only its publisher gets `contents: write`;
6. promotion checks out full main history/tags and uses `--require-mainline`
   against authoritative `origin/main` refs;
7. it requires an existing matching draft before publication, where the match
   is decided by re-peeling the tag after the fetch and comparing it to the
   classifier's `tag_sha`, never by `targetCommitish`;
8. it does not rebuild, move tags, push images, or deploy.

### Step 2: Prove RED

```bash
node --test scripts/release/check-release-lineage.test.mjs
```

Expected: FAIL because drift lacks candidate handling and promotion is absent.

### Step 3: Update drift monitoring

Keep root and direct-ancestry fast paths. For the latest unreachable tag, invoke
the classifier with main `origin/main`, registry `origin/main` (the checkout
has no `ref:`, so a manual dispatch from another branch would otherwise read
that branch's ledger), and `--allow-unclassified`. Exact candidate returns a distinct success without
claiming main reaches it. `unclassified` continues through the current
`side-branch-tags.tsv` checks. Unknown provenance and stale equivalent stay red.

### Step 4: Add guarded promotion

Create `release-promotion.yml` with only `workflow_dispatch` and a tag input. Its
publishing job must:

1. check out main with full history/tags and resolve `origin/main`;
2. run the classifier with `--require-mainline` and authoritative main refs;
3. run `gh release view "$TAG" --json isDraft,tagName`, require `isDraft`
   true and `tagName` equal to the input, and re-peel the tag after the fetch
   to compare with the classifier's `tag_sha` (do not use `targetCommitish`;
   it may be a branch name);
4. run quoted `gh release edit "$TAG" --draft=false`;
5. perform no build, signing, image push, tag update, or deployment.

Replace the direct `gh release edit` comment in `release.yml` with the guarded
workflow instruction. Do not dispatch it.

### Step 5: Prove GREEN and commit

```bash
pnpm test:release-lineage
pnpm test:workflow-security
bash scripts/security/check-supply-chain-hardening.sh
git diff --check
git add .github/workflows/drift-detector.yml \
  .github/workflows/release-promotion.yml .github/workflows/release.yml \
  scripts/release/check-release-lineage.test.mjs
git commit -m "fix(release): guard candidate drift and promotion"
```

---

## Task 5: Verification, one review, PR, and trackers

**State:** implementation diff, `/tmp/s0-fleet-integrity-tracker.md`, issue
`#4227`, tracker `#4060`.

### Step 1: Verify scope and preserved files

```bash
git status --short --branch
git diff --name-status origin/main...HEAD
git diff --name-only origin/main...HEAD -- apps/api/migrations
git diff --check
```

Recheck the root Breeze worktree, QA repository, Track E, and both helper
worktrees. Preserve every pre-existing dirty/untracked file.

### Step 2: Run the full local gate

```bash
pnpm test:release-lineage
pnpm test:workflow-security
bash scripts/check-migration-immutability.sh
bash scripts/check-migration-immutability.sh v0.108.0
bash scripts/check-migration-naming.sh
bash scripts/security/check-supply-chain-hardening.sh
git diff --check
```

Expected: all PASS; automatic guard names `v0.108.0` and the three candidates;
no migration changes. If a defect appears, add a failing regression test before
the smallest fix and rerun focused plus full gates.

### Step 3: Consume the single review

Dispatch one reviewer for `origin/main...HEAD`, covering migration mutation and
deletion detection, higher-tag classification, exact tag/SHA identity,
checked-tree versus main authority, stable side-branch preservation, workflow
permissions/input quoting, publication/promotion boundaries, test coverage, and
absence of migration/tag mutations.

Do not dispatch another reviewer. Address valid findings with RED-first tests
and verification.

### Step 4: Push and open a draft PR

Prepare `/tmp/4227-release-lineage-pr.md`, then:

```bash
git push -u origin fix/4227-release-lineage
gh pr create --repo LanternOps/breeze --draft --base main \
  --head fix/4227-release-lineage \
  --title "fix(ci): make migration baselines release-lineage aware" \
  --body-file /tmp/4227-release-lineage-pr.md
```

Include `Closes #4227`, exact rc SHAs, RED/GREEN evidence, the single review,
and explicit no-migration/no-tag/no-release/no-deployment statements.

### Step 5: Dispatch exact-head core CI

```bash
CANDIDATE_SHA=$(git rev-parse HEAD)
gh workflow run ci.yml --repo LanternOps/breeze \
  --ref fix/4227-release-lineage
gh run list --repo LanternOps/breeze --workflow ci.yml \
  --branch fix/4227-release-lineage --limit 5 \
  --json databaseId,headSha,status,conclusion,url
```

Select only the run whose `headSha` equals `$CANDIDATE_SHA`, then:

```bash
RUN_ID=$(gh run list --repo LanternOps/breeze --workflow ci.yml \
  --branch fix/4227-release-lineage --limit 10 \
  --json databaseId,headSha \
  --jq ".[] | select(.headSha == \"$CANDIDATE_SHA\") | .databaseId" | head -1)
test -n "$RUN_ID"
gh run watch "$RUN_ID" --repo LanternOps/breeze --exit-status
gh run view "$RUN_ID" --repo LanternOps/breeze \
  --json headSha,conclusion,jobs,url
```

Do not call CI green unless that exact-head run succeeds. Diagnose inherited or
unrelated failures precisely; do not rerun blindly.

### Step 6: Confirm synchronization and checks

```bash
PR_NUMBER=$(gh pr list --repo LanternOps/breeze \
  --head fix/4227-release-lineage --state open \
  --json number --jq '.[0].number')
test -n "$PR_NUMBER"
gh pr view "$PR_NUMBER" --repo LanternOps/breeze \
  --json headRefOid,baseRefName,isDraft,state,mergeable,mergeStateStatus,url
gh pr checks "$PR_NUMBER" --repo LanternOps/breeze
git status --short --branch
git rev-parse HEAD
git rev-parse origin/fix/4227-release-lineage
```

Report attached PR checks separately from manually dispatched exact-head CI.

### Step 7: Synchronize trackers

Update `/tmp/s0-fleet-integrity-tracker.md` with exact SHA, PR, review, local
gates, attached checks, exact-head CI, and remaining blocker. Synchronize `#4060`
from that body source and comment on `#4227` with the same evidence.

Do not mark complete until the guard passes without migration changes,
release/promotion tests pass, remote SHA matches, exact-head CI succeeds, and no
review finding remains.

### Step 8: Stop before merge or promotion

Hand off the draft PR. Do not merge, publish, dispatch promotion, deploy, retag,
or alter the Track D/Track E merge order without separate explicit instruction.

## Completion report

State the literally `running` worker, latest SHA, dirty files in every relevant
worktree, push/PR/attached-check/exact-head-CI states separately, primary
baseline and classified tags, the single review result, exact blocker, and
explicit non-claims for migrations, tags, releases, deployment, hosted state,
and customer devices.
