# Retire AI Documentation Automation Design

**Date:** 2026-07-24

**Status:** Approved by incident owner Todd Hebebrand on 2026-07-24

**Incident owner:** Todd Hebebrand

## Decision

Retire both repository-hosted Anthropic documentation automations:

1. the pull-request `Documentation Verification` workflow; and
2. the dormant `AI Doc Review` workflow that was intended to rewrite documentation and push directly to `main`.

Replace them with deterministic documentation checks. Preserve Breeze product AI, self-hosted AI configuration, and the manually maintained documentation mapping/tracking data.

## Goals

- Remove every GitHub Actions path that supplies `ANTHROPIC_API_KEY` to documentation-controlled code.
- Remove the retired automation implementations and their dedicated dependencies so they cannot be casually re-enabled.
- Preserve a normal, deterministic documentation build/check gate.
- Add a regression guard that prevents the retired secret-bearing automation shape from returning unnoticed.
- Delete the now-unused GitHub Actions repository secret after the retirement is present on `main`.
- Preserve the containment evidence and accurately record the 32 historical runs whose logs are no longer retained.

## Non-goals

- Do not remove or modify Breeze product AI features.
- Do not remove production or self-hosted `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, or `ANTHROPIC_AUTH_TOKEN` support.
- Do not remove Anthropic SDK dependencies used by `apps/api`.
- Do not rewrite archival plans, research, threat models, or product documentation merely because they mention Anthropic.
- Do not restore an AI documentation workflow as rollback.

## Repository Changes

### Remove the documentation automations

Delete:

- `.github/workflows/doc-verify.yml`
- `.github/workflows/docs-review.yml`
- `docker-compose.doc-verify.yml`
- `e2e-tests/doc-verify/**`
- `scripts/docs-review/review.mjs`

Remove the `doc-verify`, `doc-verify:extract`, and `doc-verify:run` scripts and the direct `@anthropic-ai/sdk` dependency from `e2e-tests/package.json`. Regenerate only `e2e-tests/package-lock.json` for that package-level dependency change. Remove obsolete doc-verification artifact ignores and TypeScript exclusions from:

- `.gitignore`
- `e2e-tests/.gitignore`
- `e2e-tests/tsconfig.json`

### Preserve manual documentation knowledge

Keep:

- `scripts/docs-review/mapping.json`
- `scripts/docs-review/last-reviewed.json`

These files remain data for manual documentation sweeps. They are not executable and must not be overwritten or deleted as part of retirement. This also avoids colliding with the incident owner's existing local edits to both files.

### Preserve product AI

Do not alter product-level Anthropic references, including:

- `apps/api` Anthropic SDK dependencies and AI services;
- deployment and `.env.example` product configuration;
- product and self-hosted operator documentation; or
- tests that exercise product AI behavior.

The GitHub Actions repository secret is a separate storage object from production and self-hosted environment configuration.

## Deterministic Documentation Gate

Keep `.github/workflows/docs-ci.yml` and its existing workflow/job identity:

- workflow: `Docs CI`
- required-check-compatible job name: `CI Success`

Replace the current echo-only job with pinned checkout, Node, and pnpm setup; a frozen workspace install; a deterministic Astro check; and an Astro production build for `@breeze/docs`.

Add an explicit `check` script to `apps/docs/package.json`. Add only the package dependencies required for `astro check`, keeping the dependency update scoped to the workspace lockfile.

Add `.github/scripts/docs-automation-retirement.test.mjs` and a root `test:docs-automation` script. The regression test must prove:

- both retired workflow files are absent;
- the retired executable directories/files and compose stack are absent;
- `e2e-tests/package.json` has no doc-verification scripts or direct Anthropic SDK dependency;
- no GitHub workflow references `ANTHROPIC_API_KEY`;
- `docs-ci.yml` retains `Docs CI / CI Success`; and
- Docs CI runs both the documentation check and build.

Run this guard in the normal CI lint job so changes outside documentation paths cannot reintroduce a secret-bearing documentation workflow without detection.

## Test-first Sequence

1. Add the retirement regression test and root script.
2. Run it against the existing tree and record the expected failure caused by the existing workflows and implementation.
3. Remove the retired files and dependencies and update deterministic Docs CI.
4. Run the regression test again and require it to pass.
5. Run the documentation check and production build.
6. Validate the e2e package lock and install after removing its direct Anthropic dependency.
7. Run the repository supply-chain hardening guard and relevant workflow/static tests.

## Operational Sequence

1. Before source changes, record live workflow states, repository-secret metadata, required-check/ruleset context, and the absence of running documentation jobs.
2. Keep `doc-verify.yml` disabled and disable `docs-review.yml` as defense in depth.
3. Implement and review the retirement on a fresh worktree based on the SHA currently advertised for `origin/main`.
4. Merge the retirement through the normal PR process.
5. Verify on the default branch that:
   - both retired workflow files are absent;
   - neither workflow can be dispatched;
   - no GitHub workflow references `ANTHROPIC_API_KEY`; and
   - deterministic Docs CI succeeds.
6. In the Anthropic provider console, identify and record the label/ID of the exact credential stored in GitHub. If it was shared, move every legitimate product consumer to a dedicated replacement before continuing.
7. Revoke the identified provider credential and record its provider audit reference.
8. Delete the GitHub Actions repository secret and verify its absence using metadata/listing only.
9. Append evidence to the private change record and update the execution ledger without deleting historical evidence.

Provider credential revocation remains a user/provider-console operation because GitHub does not reveal the stored secret or provider key identity.

## Security State and Ledger Semantics

- Workflow disablement is reversible containment.
- Source deletion is Git-revertible, but security rollback must never restore the old secret-bearing workflows.
- GitHub secret deletion is destructive; recovery requires creating a new provider credential.
- Provider revocation is irreversible; recovery requires key reissuance.
- `CI-PR-SECRET-001` may move from `Partial` to `Yes` only after the retirement is on `main`, the GitHub secret is absent, and the exposed provider credential is revoked or otherwise proven dead.
- `CI-DEVSIGN-001` remains `Partial`; this retirement does not change signing controls.
- `CI-ACTIONS-001` remains open; this retirement does not pin unrelated Actions.
- `CI-E2E-LOCK-001` may close only after the entire nondeterministic documentation-verification path and its dedicated dependency are removed and verified.

## Rollback

Do not restore either retired workflow, its repository secret, or direct-to-main AI write authority.

If deterministic Docs CI causes an unexpected compatibility problem, the safe rollback is to temporarily reduce the deterministic check set while keeping the retired AI workflows and secret absent. A future AI-assisted documentation process would require a new design with no untrusted PR secret exposure, no direct push to `main`, isolated credentials, explicit approval gates, and deterministic review of generated changes.

## Acceptance Criteria

- Both Anthropic documentation workflows and their executable implementations are absent from the default branch.
- Manual `mapping.json` and `last-reviewed.json` data are preserved unchanged by the retirement.
- Product AI implementation, dependencies, configuration, and documentation are untouched.
- No GitHub workflow references `ANTHROPIC_API_KEY`.
- The retirement regression test passes after an observed pre-removal failure.
- `@breeze/docs` check and build pass from a frozen install.
- Docs-only pull requests still produce the `Docs CI / CI Success` check.
- Normal CI runs the retirement guard.
- The GitHub Actions repository secret is deleted only after default-branch verification and revocation of the identified provider credential.
- Provider revocation is recorded by provider audit reference without storing the credential.
- Private incident evidence remains ignored and mode-restricted.
