# Security Review CI Recovery Design

## Context

PR #2679 is 32 commits behind `main`. Its first branch-only commit added pnpm overrides that redirect three extension SDK packages to ignored tarballs under `extensions/workspace/vendor`. Current `main` now consumes the committed workspace SDK packages directly. On the PR merge commit, pnpm rewrites the web SDK manifest specifier to the absent tarball while the lockfile records `workspace:*`, so every frozen install fails. Docker's non-frozen deploy proceeds farther and fails when it cannot open the same ignored tarball.

The macOS race job also exposes an unrelated flaky assertion in `TestSetWebSocketClient_ReconnectFlushesBackupOutbox`. `SendResult` returns after enqueueing to a buffered channel. The write pump can deliver the frame before the flush callback resumes and removes the persisted file, so wire receipt does not prove callback completion.

## Approaches Considered

1. **Use the committed workspace SDK packages (selected).** Merge `main`, remove the three obsolete tarball overrides and their lockfile entries, and retain `workspace:*` dependencies. This matches the green main branch and makes clean installs and Docker builds self-contained.
2. Commit the SDK tarballs. Rejected because the repository intentionally ignores extension worktrees and tarballs, and generated archives would duplicate committed SDK source.
3. Generate tarballs in every CI and Docker build. Rejected because it adds an unnecessary packaging stage when the canonical workspace packages already exist.

## Design

- Merge current `origin/main` into the published PR branch instead of rebasing, preserving published commit SHAs and avoiding a force-push.
- Remove only the three `extensions/workspace/vendor/*.tgz` pnpm overrides from the root manifest and lockfile. Preserve the secret-scrubbing environment example from the neighboring extension commit.
- Use current main's extension README and workspace package declarations; no tarballs enter Git or Docker contexts.
- Change only the flaky Go test. Wrap the installed `OnConnected` callback with a completion channel and wait for that channel before asserting the outbox directory is empty. Do not add sleeps and do not change production delivery semantics.
- Verify the original failure modes directly: frozen pnpm install, Docker API image build, repeated race-enabled heartbeat test, full agent race suite, and the repository checks relevant to the security remediation.

## Success Criteria

- No tracked manifest or lockfile references `extensions/workspace/vendor`.
- `pnpm install --frozen-lockfile` succeeds from the merged tree.
- `docker build -f docker/Dockerfile.api .` no longer fails with SDK tarball `ENOENT`.
- The reconnect outbox test passes 200 consecutive race-enabled runs without changing production code.
- PR #2679 is pushed with current `main` merged and GitHub Actions returns green, aside from clearly external or unrelated infrastructure failures.
