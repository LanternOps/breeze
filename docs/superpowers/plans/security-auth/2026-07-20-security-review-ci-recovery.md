# Security Review CI Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore PR #2679 to a reproducible, green CI state without weakening dependency integrity or changing production agent behavior.

**Architecture:** Merge current `main`, return extension SDK resolution to the committed pnpm workspace packages, and synchronize the flaky Go test on callback completion. Validate the same clean-install, Docker, and race-enabled paths that failed in GitHub Actions.

**Tech Stack:** Git, pnpm 10, Docker, Go 1.25, GitHub Actions

## Global Constraints

- Keep branch `fix/security-review-2026-07-20` and merge `origin/main`; do not rewrite published history.
- Do not commit extension SDK tarballs or weaken `.gitignore`, `.dockerignore`, or frozen-lockfile enforcement.
- Do not change production agent behavior for the flaky test.
- Run Go agent tests with `-race`.
- Preserve unrelated user changes and the existing security remediation commits.

---

### Task 1: Update the Published Branch and Restore Reproducible SDK Resolution

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Merge/update: files changed on `origin/main`

**Interfaces:**
- Consumes: committed packages `packages/extension-sdk`, `packages/extension-web-sdk`, and `packages/extension-cli`
- Produces: a merged tree whose pnpm importers resolve those packages through `workspace:*`

- [ ] **Step 1: Merge current main**

Run:

```bash
git fetch origin main
git merge --no-edit origin/main
```

Expected: merge completes without textual conflicts.

- [ ] **Step 2: Verify the original dependency failure**

Run:

```bash
CI=true pnpm install --frozen-lockfile --lockfile-only --ignore-scripts
```

Expected before the fix: `ERR_PNPM_OUTDATED_LOCKFILE` naming `@breeze/extension-web-sdk` and the ignored tarball.

- [ ] **Step 3: Remove the obsolete override source**

Delete these exact root `pnpm.overrides` keys and their corresponding top-level lockfile override entries:

```text
@breeze/extension-testkit@1.0.0>@breeze/extension-sdk
@breeze/extension-cli@1.0.0>@breeze/extension-sdk
@breeze/extension-web-sdk
```

- [ ] **Step 4: Verify deterministic dependency resolution**

Run:

```bash
rg 'extensions/workspace/vendor' package.json pnpm-lock.yaml
CI=true pnpm install --frozen-lockfile --lockfile-only --ignore-scripts
pnpm install --frozen-lockfile
```

Expected: `rg` has no matches and both installs exit 0 without changing the lockfile.

- [ ] **Step 5: Verify the Docker failure path**

Run:

```bash
docker build -f docker/Dockerfile.api -t breeze-api:security-scan .
```

Expected: image builds without an extension SDK tarball `ENOENT`.

### Task 2: Synchronize the Reconnect Outbox Test

**Files:**
- Modify: `agent/internal/heartbeat/backup_outbox_wiring_test.go`

**Interfaces:**
- Consumes: `websocket.Client.OnConnected` callback installed by `Heartbeat.SetWebSocketClient`
- Produces: a test-only completion signal proving the flush callback returned before filesystem assertions

- [ ] **Step 1: Verify the flaky failure**

Run:

```bash
cd agent
go test -race ./internal/heartbeat -run '^TestSetWebSocketClient_ReconnectFlushesBackupOutbox$' -count=200
```

Expected before the fix: intermittent `expected outbox drained` failures with no `WARNING: DATA RACE`.

- [ ] **Step 2: Add callback-completion synchronization**

After `SetWebSocketClient`, retain the installed callback, wrap it, and close a completion channel after it returns:

```go
flushDone := make(chan struct{})
onConnected := ws.OnConnected
ws.OnConnected = func() {
	onConnected()
	close(flushDone)
}
```

After receiving the result, wait for `flushDone` using a bounded `select` before reading the outbox directory. Keep the existing five-second test timeout and fail with a message identifying callback completion.

- [ ] **Step 3: Verify the focused and package tests**

Run:

```bash
go test -race ./internal/heartbeat -run '^TestSetWebSocketClient_ReconnectFlushesBackupOutbox$' -count=200
go test -race ./internal/heartbeat
```

Expected: both commands exit 0.

### Task 3: Verify, Review, Publish, and Monitor

**Files:**
- Update: `.superpowers/sdd/progress.md` (ignored ledger)
- Update: existing PR #2679 through the current branch

**Interfaces:**
- Consumes: Tasks 1 and 2
- Produces: pushed commits and fresh GitHub Actions results

- [ ] **Step 1: Run broad local verification**

Run:

```bash
pnpm typecheck
pnpm lint
cd agent && go test -race ./...
```

Also run the focused API, migration, RLS, portal, and Docker checks used by the original security remediation where local services and credentials are available.

- [ ] **Step 2: Obtain an independent whole-diff review**

Review the changes from the pre-fix head through the final fix for requirement compliance, concurrency correctness, package integrity, and unintended changes. Resolve all Critical and Important findings.

- [ ] **Step 3: Commit and push**

Stage only the CI recovery files, commit with a focused message, and push `fix/security-review-2026-07-20` without force.

- [ ] **Step 4: Monitor PR checks**

Run:

```bash
gh pr checks 2679 --repo LanternOps/breeze --watch
```

Expected: required GitHub Actions checks complete successfully; investigate any residual failure by its own log rather than assuming it shares the original cause.
