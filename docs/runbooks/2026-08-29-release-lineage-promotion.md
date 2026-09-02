# Release-lineage draft promotion

Use this runbook only to publish an existing draft GitHub release after its
exact tagged commit has become reachable from `origin/main`. It does not
authorize a deployment, rollout, tag change, rebuild, or image publication.

## Supported procedure

1. Confirm the intended tag is an existing draft release.
2. Confirm the exact tagged commit—not a squash, cherry-pick, or
   patch-equivalent commit—is reachable from `origin/main`.
3. Run the manual `release-promotion.yml` workflow with that exact tag as its
   input.
4. Treat any failed workflow check as a stop. Resolve the ancestry, draft, or
   tag-identity problem; do not work around the failed gate.

The workflow checks out full main history and tags, requires mainline ancestry,
requires an exact matching draft, refreshes and re-peels the tag, and compares
that commit to the classifier decision immediately before publication.

## Prohibited bypasses

Do not move or recreate the tag to satisfy the check. Do not publish through a
direct `gh release edit`, the GitHub release UI, or an administrator override.
Any such bypass violates the release-lineage contract, even when the content is
believed to be equivalent.

If equivalent content reached main through a squash or cherry-pick but the exact
tagged commit did not, cut a new release from main under the normal reviewed
release process. Never use patch equivalence as release identity.

## Failure handling

- `mainline ancestry is required`: merge the exact candidate commit into main,
  or recut from main. Do not promote the existing candidate tag.
- missing or non-draft release: stop and verify the requested tag and release
  state. Do not create or publish a replacement from this workflow.
- tag SHA changed during promotion: stop and investigate the tag mutation. Do
  not retry until repository owners establish the authoritative tag identity.

Record the promotion workflow run, tag, peeled commit SHA, and release URL in
the owning release record. Production deployment and rollout remain separate,
explicitly authorized procedures.
