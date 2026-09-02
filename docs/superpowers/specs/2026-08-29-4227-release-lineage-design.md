# Issue #4227 Release-Lineage and Migration-Baseline Design

**Date:** 2026-08-29

**Issue:** [#4227 — define release baseline when latest tag is not on branch ancestry](https://github.com/LanternOps/breeze/issues/4227)

**Status:** Approved

## Problem

`scripts/check-migration-immutability.sh` currently chooses the highest `v*`
tag by version and treats every migration present at that tag as shipped on the
checked branch. That assumes the highest tag is an ancestor of the checked
commit.

The assumption is false for the S0 Track E release candidates. The current
highest tag, `v0.109.0-rc.3`, resolves to
`a11d432a6e68288eceef050933483c231f5d40dc` on the stacked Track E candidate
line. It is not an ancestor of main. Its Track D/E migrations therefore appear
as deletions when the unchanged guard compares that tag to main, even though
main did not edit or delete migrations in its own release lineage.

This is not permission to weaken migration immutability. Candidate artifacts
were materially produced: the three `v0.109.0-rc.*` GitHub releases are draft
prereleases, and the `rc.3` workflow pushed exact-version and SHA-addressed API,
web, portal, and binaries images. Candidate migrations therefore remain frozen
on their own lineage. They are not, however, an unrelated main branch's
migration baseline.

## Decision

Support two release channels:

1. **Mainline release.** The tagged commit is reachable from `origin/main`.
   It may follow the existing stable or prerelease publication process.
2. **Candidate release.** The tagged commit is not reachable from main, the tag
   is a prerelease, and main contains an exact reviewed registry entry binding
   the tag to its 40-character commit SHA. It is draft-only and may publish only
   exact-version and SHA-addressed artifacts or images. It may not publish or
   move floating tags.

A candidate may be promoted only after its exact tagged commit becomes
reachable from main. A squash or cherry-pick that lands equivalent content but
not the tagged commit does not satisfy that requirement; the release must be
recut from main.

## Invariants

1. Every migration frozen by an applicable release baseline stays present under
   the same filename and with byte-identical content, except for the existing
   exact checksum-reconciliation mechanism.
2. A branch freezes against release tags in its own ancestry.
3. A higher tag outside the branch's ancestry is never silently ignored. It must
   have an exact reviewed provenance classification.
4. A candidate registry row does not authorize release publication, deployment,
   rollout, or a floating image tag.
5. Candidate classification is based on exact tag and exact commit identity,
   never patch equivalence.
6. Release publication requires tag ancestry to main. Equivalent content is not
   sufficient.
7. Existing stable side-branch releases retain the separate
   `.github/release-provenance/side-branch-tags.tsv` contract, including its
   reachable main-equivalent check.
8. The main root-commit drift check remains unchanged and fail-closed.
9. No implementation under this design edits, renames, copies, or renumbers an
   existing migration, moves a tag, publishes a release, deploys software, or
   mutates a customer system.

## Provenance Records

Add `.github/release-provenance/candidate-tags.tsv`. Each non-comment row has:

```text
<tag><TAB><exact-tag-commit><TAB><integration-ref><TAB><note>
```

The parser requires:

- a `vX.Y.Z-<prerelease>` tag;
- a lowercase 40-character hexadecimal commit;
- exactly one row for a tag;
- the tag to peel to the recorded commit (`git rev-parse "$TAG^{commit}"`, so
  an annotated tag resolves to its commit, never to the tag object);
- a non-empty integration reference and note.

Repository checks evaluate the registry in the checked tree so the reviewed PR
that introduces a candidate record can bootstrap its own migration verdict. That
check has no publication authority. Release creation and promotion always read
the authoritative registry from `origin/main`, not a copy introduced only on the
candidate branch. This prevents an unmerged candidate from authorizing its own
release.

The initial records cover:

| Tag | Commit | Disposition |
|---|---|---|
| `v0.109.0-rc.1` | `d473815e434141135b23a6cf51fca715e8218938` | Track E lab candidate |
| `v0.109.0-rc.2` | `fb1731e97c0d61a8c6d82420694daf186cfa44fa` | Track E lab candidate |
| `v0.109.0-rc.3` | `a11d432a6e68288eceef050933483c231f5d40dc` | Track E accepted lab-evidence candidate |

Rows remain as an audit record after the candidate becomes reachable or is
superseded. Their presence never changes the ancestry requirement for
publication.

## Migration Baseline Resolution

When an explicit base ref is supplied, the guard preserves its current behavior
and compares that ref to the working tree. Automatic resolution requires full
history and tags: a shallow repository (`git rev-parse --is-shallow-repository`
prints `true`) fails closed with a distinct diagnostic before any tag is
inspected, because `git merge-base --is-ancestor` returns false negatives on a
shallow clone and would present as a missing baseline. Resolution then follows
this algorithm:

1. Find the highest semantic-version `v*` tag reachable from `HEAD`. This is the
   branch's primary baseline. Ordering is SemVer precedence, where a prerelease
   sorts below its release (`v0.109.0-rc.3` < `v0.109.0`). Git's default
   `--sort=v:refname` ranks a prerelease *above* its release (the live tag list
   already shows `v0.107.0-rc.2` above `v0.107.0`), so every tag ordering runs
   with `git -c versionsort.suffix=- tag --sort=-v:refname` or an explicit
   SemVer comparator. The same ordering defines "higher" in steps 4–8.
2. If no `v*` tags exist, report that nothing has shipped and exit successfully.
3. If tags exist but none is reachable, fail because the checked lineage has no
   trustworthy automatic baseline.
4. Inspect tags that sort higher than the primary baseline.
5. A higher non-ancestor tag that is reachable from `origin/main` is a mainline
   release the checked lineage has not merged yet (a stale local branch, or a
   `workflow_dispatch` of `ci.yml` on a branch; pull-request runs check out the
   merge ref and are unaffected). It fails with a distinct "behind mainline"
   diagnostic naming the tag and the remediation: merge or rebase onto main, or
   pass an explicit base ref. It is not excluded, because a migration added on
   main after the primary baseline and then edited on the branch would
   otherwise pass as an addition. This check precedes candidate classification
   so a retained candidate row cannot let a stale branch ignore that tag after
   its exact commit reaches main. When `origin/main` does not resolve, this
   classification is unavailable and the tag falls through to step 6.
6. A higher non-ancestor tag exactly registered as a candidate is classified and
   excluded from this unrelated branch's migration baselines.
7. A higher non-ancestor tag in the existing side-branch-release registry is
   applicable only when its recorded main-equivalent commit is reachable from
   `HEAD`; its tag becomes an additional baseline.
8. Any other higher non-ancestor tag fails with a release-provenance error.
9. Compare every applicable baseline to the working tree using the existing
   no-renames and top-level-SQL rules. Deduplicate violations by baseline and
   filename while retaining the baseline in diagnostics.

This yields the intended current behavior:

- main selects `v0.108.0`; the three higher Track E candidates are recognized
  by exact registry entries and do not make their migrations look deleted;
- a Track E descendant selects its highest ancestor candidate tag and therefore
  continues freezing the candidate migration set;
- an unknown future higher non-ancestor tag makes CI red until its provenance is
  resolved explicitly.

The `Check Migrations` checkout must use full history and tags. A shallow tag
fetch is insufficient to prove ancestry.

## Release-Lineage Validation

A reusable script validates a tag against `origin/main` and the authoritative
candidate registry. It emits one of two successful channels:

- `mainline`: the tag commit is an ancestor of `origin/main`;
- `candidate`: the tag is a prerelease, is not an ancestor of main, and has an
  exact matching registry row on main.

All other states fail, including malformed tags, missing or duplicate records,
tag/SHA mismatches, stable tags outside main, and candidate records that exist
only on the candidate branch.

`release.yml` runs this validation before `create-release` and every image job
that can publish to GHCR. The validation job carries the same job-level gate as
`create-release` (`github.ref_type == 'tag'`,
`startsWith(github.ref, 'refs/tags/v')`, and not a `skip_release` dispatch) so a
build-only `workflow_dispatch` from a branch skips it instead of failing on a
non-SemVer ref name. `create-release`'s existing `if:` uses `!cancelled()` and
enumerates `needs.<job>.result == 'success'`; that disables the implicit
`success()` gate, so a `needs:` entry alone does not block it. The condition
`needs.validate-release-lineage.result == 'success'` must therefore be a
top-level `&&` conjunct of that expression, which also excludes a skipped
validation. Candidate mode forces the GitHub release to draft regardless of
`RELEASE_DRAFT_FIRST`. The existing prerelease behavior of
`docker/metadata-action` remains in force: prereleases receive exact-version and
SHA tags but no `latest`, major, or minor tag.

Build-only artifacts may still be produced before the publishing boundary. No
release or package write occurs unless lineage validation succeeds.

## Promotion

Replace the documented direct `gh release edit <tag> --draft=false` operation
with a guarded manual promotion workflow. The workflow:

1. accepts an existing draft release tag;
2. fetches full main history and tags;
3. resolves the tag to an exact commit;
4. refuses unless that commit is an ancestor of `origin/main`;
5. refuses a missing, non-draft, or mismatched release, where mismatch is
   decided by re-peeling the tag after the fetch and comparing it to the
   classifier's `tag_sha` (the release's `targetCommitish` may be a branch name
   and is not used for identity);
6. publishes the already-created draft without rebuilding or moving the tag.

The implementation will create the workflow but will not dispatch it. Direct
administrator actions remain technically possible on GitHub; the guarded
workflow is the authoritative supported promotion path and the runbook must say
that bypassing it violates the release-lineage contract.

## Main-History Drift Detector

The detector retains its existing root check and side-branch release logic. For
the latest unreachable tag, it adds candidate classification before reporting an
unknown-provenance failure:

1. look up the tag in the candidate registry read from `origin/main` (the
   detector monitors main; a manual dispatch from another branch must not read
   that branch's ledger);
2. require prerelease syntax;
3. require the tag to peel to the exact recorded SHA;
4. report a distinct candidate-lineage success without claiming main reaches
   the tag.

An unknown tag, duplicate row, SHA mismatch, malformed candidate, changed main
root, or stale side-branch equivalent remains an error. Patch equivalence is not
introduced.

## Error Reporting

Diagnostics distinguish:

- migration mutation or deletion against a named applicable baseline;
- no reachable release baseline;
- shallow repository in automatic mode;
- checked lineage behind a mainline release (higher tag reachable from
  `origin/main` but not from `HEAD`);
- higher unclassified non-ancestor tag;
- malformed or duplicate candidate record;
- candidate tag/SHA mismatch;
- stable non-main tag;
- attempted candidate publication before main ancestry;
- stale side-branch equivalent.

Messages state the observed topology and the permitted remediation. They must
not suggest copying candidate migrations onto main, editing shipped migrations,
moving tags, or accepting patch equivalence.

## Testing

Repository-local tests create temporary Git repositories and do not depend on
the live Breeze tag graph.

### Migration guard

- ancestral release tag selects and passes;
- an annotated primary baseline tag is peeled to its commit;
- SemVer precedence: a release and its own prerelease both ancestral selects
  the release, not the prerelease;
- a higher tag reachable from `origin/main` but not from `HEAD` fails with the
  behind-mainline diagnostic even when a retained candidate row records it;
- a `--depth=1 file://...` clone fails closed in automatic mode;
- an edit and a deletion of an ancestral migration fail;
- a valid checksum reconciliation retains existing behavior;
- a higher registered candidate is classified and excluded on main;
- the same candidate tag is selected on its descendant branch;
- unregistered, malformed, duplicate, and SHA-mismatched candidate records fail;
- a higher side-branch release with a reachable recorded equivalent is checked;
- a stale side-branch equivalent fails;
- no tags skips, while tags with no reachable or classified baseline fail;
- explicit base-ref mode remains deterministic.

### Release validator and workflows

- mainline tag succeeds as `mainline`, and an annotated mainline tag reports
  the peeled commit as `tag_sha`;
- exact registered prerelease outside main succeeds as `candidate`;
- a shallow repository fails closed;
- the validation job is skipped, not failed, on a build-only branch dispatch;
- `create-release` carries `needs.validate-release-lineage.result == 'success'`
  as a top-level `&&` conjunct of its `if:`;
- the drift detector reads the candidate registry from `origin/main`;
- stable non-main tag and self-authorizing branch-only record fail;
- candidate release is structurally forced to draft;
- publishing jobs depend on successful validation;
- prerelease image configuration cannot emit floating tags;
- guarded promotion refuses a non-ancestor tag and accepts an ancestor tag;
- check-migrations, release validation, and promotion checkouts fetch full
  history and tags;
- workflow syntax and existing workflow-security tests pass.

### Current repository acceptance

- unchanged main migrations pass with primary baseline `v0.108.0` while
  classifying `v0.109.0-rc.1`, `rc.2`, and `rc.3` as candidate lineages;
- a Track E checkout passes with `v0.109.0-rc.3` as its primary baseline;
- the exact main CI `Check Migrations` job becomes green without migration
  changes;
- full relevant CI is dispatched against the final committed SHA before merge.

## Rejected Alternatives

### Continue using the highest tag globally

Rejected because it conflates independent branch lineages, leaves main red, and
encourages unsafe copying or renumbering of candidate migrations.

### Ignore all prerelease or draft tags

Rejected because the Track E candidates produced signed assets and exact GHCR
images and were used for lab evidence. Their migrations must remain immutable on
their own lineage.

### Compare only with the latest ancestor and ignore every other tag

Rejected because an unknown higher tag could represent an invalid release or a
stable side-branch release whose shipped migrations still require protection.

### Use patch equivalence

Rejected because it weakens commit provenance, loses metadata and signature
identity, behaves inconsistently across squash merges, and would erode the
existing main-history drift detector's force-push boundary.

### Copy Track D/E migrations to main or reconcile their checksums

Rejected because main has not shipped or applied those migrations, chronology
belongs to the integration branches, and checksum reconciliation is reserved for
an exact reviewed byte transition of a migration already shipped on the same
lineage.

### Delete, move, or retag the release candidates

Rejected. Tags and artifacts are evidence-bearing release records. This design
classifies them without rewriting history.

## Scope and Non-Claims

This design changes CI and release-governance code only. It does not merge Track
D or Track E, publish or deploy a release, modify a database, establish hosted
rollout evidence, or authorize customer-device mutation. It restores an honest
main migration verdict while continuing to freeze candidate migrations where
they actually shipped for evaluation.
