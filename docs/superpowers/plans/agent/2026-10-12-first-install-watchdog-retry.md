---
issue: 7583
status: draft-for-approval
blast_radius: high (agent-shipped code, privileged service registration, install exit codes, three nullable ADD COLUMNs on `devices`)
---

# Watchdog Install Retry (#7583) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host whose `breeze-agent service install` could not stage the watchdog heals itself: the running, enrolled agent notices the watchdog is not registered and installs it through the verified updater path, with bounded, persisted, classified retries — and the failure is visible (device detail; an opt-in strict exit code for scripted installs) instead of a silent stderr warning.

**Architecture:** The server **already** signals a missing watchdog (`watchdogUpgradeTo`, pin-aware, `apps/api/src/routes/agents/heartbeat.ts:1998-2010`); the agent's handler for it (`handleWatchdogUpgrade`) cannot register a missing service and retries uncapped every 30 min with in-memory state. So the plan makes that path *correct and bounded* rather than adding a rival trigger. A new pure-logic package `agent/internal/watchdoginstall` (state file, backoff schedule, error classifier, per-OS "is the watchdog registered?" detector) is the single `Ensure` core behind the existing server-signalled path (and, optionally, a local detector tick, Decision 1). `Ensure` reuses `downloadWatchdogBinary` (signed manifest + SHA-256 + netpolicy, authenticated) to fetch the watchdog to a temp file, then executes that verified file's own `service install` — the single idempotent per-OS registration routine that already handles the binary copy, unit/plist/SCM entry, Windows recovery actions, and start. Install health rides the heartbeat as a bounded `watchdogInstall` object, persisted on `devices` in three nullable columns and shown on the device Info tab.

**Tech Stack:** Go agent (`agentapp`, `heartbeat`, `updater`, `config`, new `watchdoginstall`), Hono/Zod API + Drizzle, hand-written SQL migration, Astro/React web, MDX docs.

**Spec:** none — the spec is issue #7583 (body + one comment) and this plan's Open Decisions. No design doc precedes this plan.

## Premise check (verified on `origin/main` 48488cfc5a)

The brief's premise needed a correction, and the correction holds up:

- There is **no multi-stage "first-install watchdog" state machine and no persisted install state.** `git grep -n -i -E 'bootstrapWatchdog|firstInstallArtifactSpec|stageFirstInstallArtifact' origin/main -- agent` finds one function, `bootstrapWatchdog` (`agent/internal/agentapp/watchdog_bootstrap.go:107`), called once at the tail of `service install` in `service_cmd_{linux,darwin,windows}.go`. Failure is downgraded to a stderr warning and nothing ever re-attempts it. `stageFirstInstallArtifact` is also used by the macOS desktop-helper bootstrap (`desktop_helper_bootstrap.go:132`).
- The "stages" this plan must make idempotent are therefore the **steps inside `bootstrapWatchdog` and its downstream `<watchdog> service install`**, plus the new steps the reconcile adds. The audit table below is organised that way.
- No `watchdog`-install key exists in `agent/internal/config` (only `WatchdogConfig` runtime tuning and the watchdog's auth-token fields); `--no-watchdog` is a process-local cobra bool (`var noWatchdog bool`, e.g. `service_cmd_linux.go:54`, flag registered at `:124`). It is not persisted anywhere.

**Second premise correction (found by the Codex quorum, re-verified):** the brief and the issue say a host with no watchdog never receives `WatchdogUpgradeTo`. That is false for the *never-installed* case. `heartbeat.ts:1998-2010` sets `watchdogUpgradeTo = targetWatchdog` when `targetWatchdog && !installedWatchdogVersion && pinsResolved` ("Watchdog not yet installed - signal to agent to install it"; honours the tenant watchdog pin, fails closed when pins are unresolved), and the agent dispatches it at `heartbeat.go:5434` (gated by `!rollbackActive && !identityRestarting`). What is actually broken on the agent side: (1) `installAndRestartWatchdog` cannot register a missing service (Windows `OpenService` fails; Unix never writes the unit); (2) the throttle is in-memory, per-version, 30 min (`heartbeat.go:7585-7635`), so up to ~48 downloads/day forever, reset on every restart; (3) it ignores `--no-watchdog`; (4) nothing is reported to the server. The server trigger does **not** cover "binary present, unit absent" (the agent then reports a version, and the server also falls back to the stored `device.watchdogVersion`), nor an old API that never signals. Everything below is built on this corrected picture.

Drift found while verifying the brief (adjusted below):

| Brief said | `origin/main` reality | Consequence |
|---|---|---|
| Reuse `installAndRestartWatchdog` for the missing-watchdog case | Linux/macOS variants only swap the binary (`replaceWatchdogBinaryUnix`) and `systemctl restart`/kickstart; the Windows variant calls `m.OpenService("BreezeWatchdog")` and **fails if the service does not exist**. None writes a unit/plist or creates the SCM entry | Reuse **`downloadWatchdogBinary`** only, then run the verified binary's `service install`. See Open Decision 8 |
| Windows watchdog recovery actions "confirm" | The watchdog's `service install` goes through `winsvcinstall.Install` (`cmd/breeze-watchdog/service_cmd_windows.go:61`), the same routine that calls `SetRecoveryActions` (`winsvcinstall/install.go:320`), so a late registration **is** armed — provided we use its `service install` rather than re-implementing SCM calls | Confirms the exec-`service install` design |
| Linux agent can register the unit | The running agent unit is `ProtectSystem=strict` on old units and cannot write `/etc/systemd/system`; the repo already escapes via a `systemd-run` transient service (`service_cmd_linux.go:57-118`, `reconcileServiceUnitIfNeeded`) | Linux reconcile must use the same escape; staging path must be visible to the transient service. Task 6 spikes this first |
| `installedWatchdogVersion` could report absence | It caches `("", stable)` for "not installed" for the process lifetime (`watchdog_version.go:37-80`), so a reconcile-installed watchdog stays invisible to heartbeat telemetry unless the cache is invalidated | Reconcile success must set `watchdogInstalledVersion` (Task 7) |
| `strip` vs `passthrough` on unknown heartbeat keys | `heartbeatSchema` (`apps/api/src/routes/agents/schemas.ts:150-452`) is a plain `z.object` with no `.strict()` (the `.strict()` at lines 124/148 belong to the nested health-observation schema) → unknown keys are **stripped**; optional fields use `.optional().catch(undefined)` so a malformed value never rejects the beat | New agent → old API is safe; compat table below |

## Global Constraints

- Agent-shipped code: **high blast radius**. Every code task is test-first (red, then green; Task 6 is a spike and Tasks 14-15 are script/docs checks); `go test -race`; GOOS cross-compile vet for windows and darwin on every agent task.
- Never log or report raw `err.Error()` from a download path; use `updater.SafeDownloadErrorFields` / `SafeDownloadErrorMessage` (`updater.go:221,254`) and the closed `ErrorClass` enum for anything leaving the box.
- A signature/checksum/policy failure never falls back to an unverified download and is never retried before its persisted probe time (7 days) within the same agent version, across restarts; a new agent version re-arms the budget once (Decision 15).
- No internal hostnames/IPs/regions in code, tests, docs, commits or PR text.
- Migration (W2 only): hand-written, idempotent, no inner `BEGIN;/COMMIT;`, nullable `ADD COLUMN IF NOT EXISTS`, slot `2026-12-23-220000-device-watchdog-install-state.sql`. **Re-check before writing:** newest on `origin/main` today is `2026-12-23-100000-tier1-sweep-indexes.sql`; open PRs hold `…110000`–`…210000`. Move up if anything newer landed (`git ls-tree --name-only origin/main apps/api/migrations/ | grep 2026-12 | tail`).
- Web: new en locale keys go into all 8 locale files (en + 7 translations) (`apps/web/src/lib/i18n` localeParity); no new mutation handlers (read-only UI), so no `runAction` change; transient UI state, if any, uses `window.location.hash`.
- CI: stacked PRs (base ≠ main) get **no CI** (`ci.yml` triggers only on PRs to `main`). The waves below are written as **sequential PRs off `main`**; if W2/W3 must be developed before W1 merges, dispatch `gh workflow run CI --ref <branch>` per branch.
- Test commands (no `--` before vitest flags): `cd agent && go test -race ./internal/watchdoginstall/... ./internal/heartbeat/... ./internal/agentapp/... ./cmd/breeze-watchdog/...`; `cd apps/api && npx vitest run <files>`; `cd apps/web && npx vitest run <files>`. Typecheck API/web: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` and check the exit code (never pipe to `tail`).

## Review Focus

Failure modes the issue implies but no obvious task would test, most likely first:

1. **Poisoned host** (signature mismatch / policy refusal / read-only FS): bounded attempts, then terminal with **zero further network calls** until version change or operator reset. Pinned in Tasks 3 and 7.
2. **Crash-looping agent** resets an in-memory counter and hammers the control plane every start. Persisted `NextAttemptAt` is honoured across restarts. Tasks 3 and 7.
3. **Operator opted out, then the agent upgrades / re-enrols / `agent.yaml` is rewritten** — opt-out must survive. Marker file separate from disposable counters. Task 2.
4. **Corrupt/truncated state file** must fail *closed to the slow cadence*, never to "retry immediately" and never to "clear the opt-out". Task 3.
5. **Concurrent mutation**: reconcile racing `handleWatchdogUpgrade`, the agent self-updater, an MSI/pkg upgrade, or a human running `breeze-watchdog service install`. One lease (`updater.TryBeginProcessMutation`) plus idempotent `service install`. Task 7.
6. **A successful agent install must not report failure** when a background retry will heal the host (exit-code decision). Task 13.
7. **Not-yet-enrolled agent** (the pre-enrollment failure mode): the reconcile must wait for enrollment and credentials, not burn the budget on unauthenticated calls. Task 7.

---

## Idempotency audit (mandatory; agent-shipped)

Rows are the steps a retry re-runs. "Interrupted" = power loss, SIGKILL, or a concurrent actor mid-step. Test column names the test that proves the row (Tasks 2, 3, 7, 9, 10).

| # | Step | Side effects | Second run | Interrupted halfway leaves | Concurrency | Proof |
|---|---|---|---|---|---|---|
| 1 | Detect "registered?" (stat binary + unit/plist/`OpenService`) | None (read-only) | Same answer | n/a | Safe; TOCTOU handled by step 6 being idempotent | `TestDetect_*` (per-OS, fake FS/SCM seam) |
| 2 | Read state + opt-out marker | None | Same | n/a | Torn read of state → treated as corrupt (fail closed) | `TestStore_CorruptFailsClosed` |
| 3 | Backoff gate (`now < NextAttemptAt`) | None | Same | n/a | n/a | `TestScheduler_*` |
| 4 | Temp/staging dir create (`downloadWatchdogBinary` temp file; Linux: stage dir under `/var/lib/breeze`) | New file/dir, unique name | New unique name; no collision | Orphan temp file | Unique names; startup sweep removes `breeze-watchdog-ensure-*` older than 1 h | `TestStageSweep_RemovesStaleOnly` |
| 5 | Download + manifest signature + SHA-256 verify | Network; temp file | Re-downloads; pure function of release | Partial temp file (removed by `defer`; swept next start) | Throttled by lease + backoff; never two in flight (`atomic.Bool`) | `TestDownload_UsesAttemptDir` |
| 6 | `<verified watchdog> service install` | **Per-OS service registration + binary swap + start** (below) | Rewrites unit/plist/binary identically; restarts the watchdog | See per-OS rows | Linux: `systemctl stop` then rewrite then `restart`; Windows: `winsvcinstall.Install` handles "already exists" since #5299 | `TestReconcile_RegisterSucceedsButStillMissingIsFailure` + existing `service_install_test.go` |
| 6a | Linux: copy to `/usr/local/bin/breeze-watchdog` (`os.WriteFile` in place, `service_cmd_linux.go:~113`) | Truncating in-place write of the live binary | Same bytes | **Torn binary** if killed mid-write (`ETXTBSY` is avoided only because the unit was stopped first) | Unit stopped first; but a torn file + `Restart=always` can crash-loop until the next reconcile | **Fix in W1:** write-temp-then-rename (reuse `replaceWatchdogBinaryUnix` semantics) — Task 9. `TestLinuxInstall_BinarySwapIsAtomic` |
| 6b | Linux: write unit + `daemon-reload` + `enable` + `restart` | Unit file (0644), systemd state | Identical rewrite | Unit written, not reloaded: next boot picks it up; reconcile detects "registered", so **registered-but-not-started is not retried** (liveness is out of scope, Decision 2) | `systemctl` serialises | `TestInstallWatchdogUnit_*` (exists) |
| 6c | macOS: in-place `os.WriteFile` of binary and plist (`cmd/breeze-watchdog/service_cmd_darwin.go:~114-127`), `launchctl unload` then `bootstrap`/legacy `load` | Plist, launchd job, binary | Unloads then loads again | Binary present, plist absent → detector says missing → next attempt completes | launchd serialises | `TestDarwinInstall_*` plus the Task 9 fix (atomic binary + plist write on darwin too; a torn binary would otherwise pass the detector) |
| 6d | Windows: stage to Program Files, `CreateService` or `ChangeConfig`, `SetRecoveryActions`, start | SCM entry, protected binary | `winsvcinstall.Install` updates the existing service (since #5299); recovery actions re-set | Binary copied, service not created → detector (SCM) says missing; locked running `.exe`: `Install` stops the service before swap | SCM serialises | `winsvcinstall` tests (exist) + `TestDetect_WindowsBinaryWithoutService` |
| 7 | Persist new state (success clears; failure bumps) | Atomic temp+fsync+rename of one small file | Overwrites | Old file intact (rename is atomic) or temp orphan swept | Single writer (the agent, under `watchdog-install.lock`); `service install --watchdog` (Task 5) resets under the same lock | `TestStore_AtomicWrite` |
| 8 | Invalidate watchdog-version cache / set `watchdogInstalledVersion` | In-memory | Idempotent | n/a | `watchdogUpgradeMu` | `TestReconcile_SuccessUpdatesVersionTelemetry` |
| 9 | Heartbeat payload `watchdogInstall` | Network | Same | n/a | Read-only snapshot under mutex | `TestHeartbeatPayload_WatchdogInstall*` |

Concurrency matrix. **Correction (verified at `updater/coordinator.go:9-20`):** `TryBeginProcessMutation` is a *process-local* `atomic.Bool` that ignores its name argument; it excludes other in-process updaters only. Cross-process exclusion comes from the new `watchdog-install.lock` file lock (Task 7 step 5b). Manual installers that do not take it are tolerated by idempotency, not excluded. A held lease or lock means "defer, do not count an attempt":

| Actor | How it is excluded |
|---|---|
| `handleWatchdogUpgrade` (server `watchdogUpgradeTo`) | Same lease name + shared `watchdogUpgradeInProgress` CAS. If the server-directed upgrade runs first and succeeds, step 1 sees "registered" and the reconcile no-ops |
| Agent self-update / helper / backup-helper updaters | `TryBeginProcessMutation` is process-wide; a held lease defers the reconcile without consuming budget |
| MSI / pkg upgrade | The MSI is **declarative** (`ServiceInstall`/`ServiceControl` for `BreezeWatchdog`, `breeze.wxs:~508`); it does not run `breeze-watchdog service install`. It stops services and kills processes during upgrade (~line 316), so the agent running `Ensure` is itself stopped; a half-finished `Ensure` shows up only as `Missing` next time. msiexec does not take our lock, so safety rests on idempotent re-detect under the lock |
| Operator running `service install` / `breeze-watchdog service install` by hand | Not excluded (they do not take our lock). Windows `winsvcinstall.Install` does separate open/stage/create steps (`install.go:268-310`), so two installers can both see "absent"; the loser must treat `ERROR_SERVICE_EXISTS` as update-in-place, not failure (W1 test `TestWinInstall_ConcurrentCreateFallsThroughToUpdate`) |
| Two agent processes (old one not yet dead during self-update) | State writes are atomic-rename; the lease is per-process, so worst case is one extra install — still idempotent (row 6) |

---

## Design summary (decisions are argued in "Open Decisions")

- **Where it runs:** one `Ensure` core in the running enrolled agent, entered from the existing server-signalled `handleWatchdogUpgrade` (primary, pin-aware, covers never-installed hosts) and, only if Decision 1 option (c) is approved, from a local detector tick for the partial/old-API cases. Not a scheduled task (a second privileged persistence mechanism per OS).
- **What "missing" means:** *registration-level*, per OS — binary absent **or** service definition absent (Linux unit file; macOS plist; Windows SCM entry). Ongoing liveness is out (service-manager job), **but** an install we run only counts as success once the service is verified started (bounded 30 s poll), because every installer writes the definition before starting it.
- **Target version:** the server-supplied `watchdogUpgradeTo` (pin-aware); a local tick never invents one (Decision 16).
- **Trust path:** post-enrollment the agent has an auth token, `pinnedManifestPubKeys`, and the server URL, so the retry uses the *heartbeat* updater path (`downloadWatchdogBinary`), not the pre-enrollment first-install path (`stageFirstInstallArtifact` with embedded trust keys + hosted source). That path stays as-is for first install.
- **State:** `watchdog-install.state` (JSON, counters, disposable) and `watchdog.disabled` (marker, operator intent, durable) in the machine config dir, root/SYSTEM only.
- **Schedule:** first attempt on the first signalled heartbeat (or first tick); after a failure the delay is 5 min, ×3 multiplier, cap 6 h, ±20 % jitter, 8 attempts in the active phase, then terminal with a 24 h slow probe for transient classes and 7 d for security classes.
- **Visibility:** bounded `watchdogInstall` heartbeat object → 3 nullable `devices` columns → Info-tab banner. Alert deferred (Decision 11).

## File Structure

| File | Responsibility |
|---|---|
| `agent/internal/watchdoginstall/state.go` (new) | `Record`, `Store` (atomic JSON), opt-out marker, corruption handling |
| `agent/internal/watchdoginstall/schedule.go` (new) | `NextDelay`, budget/terminal transitions, injected clock + rand |
| `agent/internal/watchdoginstall/classify.go` (new) | `ErrorClass`, `Classify(err) (class, permanent)`; no `err.Error()` leaves the package |
| `agent/internal/watchdoginstall/detect_{linux,darwin,windows,other}.go` (new) | `Detect() (Status, error)` per OS with FS/SCM seams |
| `agent/internal/updater/updater.go` (modify) | Typed sentinels `ErrChecksumMismatch`, `ErrManifestSignature` wrapped with `%w` so `Classify` can use `errors.Is` (today they are bare `fmt.Errorf` strings, `updater.go:1540,853,882`) |
| `agent/internal/heartbeat/watchdog_ensure.go` (new) | `Ensure` core, lease/lock, wiring from `handleWatchdogUpgrade`, telemetry, test seams |
| `agent/internal/heartbeat/watchdog_reconcile.go` (new, **only if Decision 1(c)**) | Local detector tick |
| `agent/internal/heartbeat/watchdog_install_{linux,darwin,windows,other}.go` (modify) | Add `registerVerifiedWatchdog(tempPath string) error` per OS |
| `agent/internal/heartbeat/heartbeat.go` (modify) | Start loop; `WatchdogInstall` payload field (~line 125, ~line 4835) |
| `agent/internal/agentapp/service_cmd_*.go` (modify) | Persist `--no-watchdog`; add `--watchdog`; (W3) exit code |
| `agent/cmd/breeze-watchdog/service_cmd_{linux,darwin}.go` (modify) | Atomic binary + unit/plist writes (audit rows 6a, 6c) |
| `agent/internal/updater/updater.go` (also) | `Config.TempDir`; typed `HTTPStatusError`; `ErrManifestKey` |
| `agent/internal/config/machine_config_trust.go` (modify) | Add `watchdog-install.state`, `watchdog.disabled` and `watchdog-install.lock` to `reclaimAgentEntries` |
| `apps/api/src/routes/agents/{schemas,heartbeat}.ts`, `db/schema/devices.ts`, `routes/devices/core.ts`, `services/tenantExportPolicyRegistry.ts`, migration (W2) | Ingest, store, expose, classify for export |
| `apps/web/src/components/devices/DeviceInfoTab.tsx` + 7 locale `devices.json` (W2) | Banner |
| `agent/scripts/install/install-linux.sh`, `install-darwin.sh` (W3, only per Decision 6/7; the MSI is declarative and untouched) | Lane signalling |
| `apps/docs/src/content/docs/agents/{installation,advanced-install}.mdx`, `features/watchdog.mdx` (W1 note, W3 final) | Docs |

## Wave cut

| Wave | Ships | Mergeable alone because | If the next wave never ships |
|---|---|---|---|
| **W1 — agent reconcile** | `watchdoginstall` package, persisted state + opt-out marker, `Ensure` core behind the existing server-signalled path, atomic Linux swap, `--no-watchdog` persisted, `--watchdog` flag, heartbeat `watchdogInstall` field (omitempty), stage-sweep, docs note | Pure agent change; the new heartbeat key is stripped by the current API (verified above); behaviour only changes on hosts that are missing a watchdog and not opted out | Hosts self-heal. Failure is visible only in agent logs/`agent_logs` and the unreadable-to-server heartbeat field; `service install` still exits 0 on bootstrap failure. This is the highest-value wave |
| **W2 — API + web visibility** | Zod field, 3 nullable `devices` columns + migration, export-policy classification, device response, Info-tab banner, 8 locales | API accepts the field before/after any agent version (optional + catch); banner renders only when the column is set | Operators see nothing server-side; W1 healing still works. Columns stay NULL |
| **W3 — install-lane signalling + docs** | Exit-code behaviour per Decision 6, `install-linux.sh` / `install-darwin.sh` / MSI follow-ups per Decision 7, final docs | Additive: default stays exit 0 unless Decision 6 is approved otherwise; docs describe only shipped behaviour | Scripted installs keep reporting success with a stderr warning, but W1 heals the host within the first backoff window |

Cut vs. the suggested one (W1 agent / W2 API+web / W3 docs): docs ship **with** each wave (a docs page that describes unshipped behaviour is wrong), and W3 is instead the install-lane signalling, which is independently shippable, independently risky, and gated on an Open Decision. Ordering rationale: W1 alone fixes the reported harm; W2 depends on W1 only for data; W3 changes contracts with external scripts and should land last and be revertible without touching W1.

---

# Wave 1 — Agent: detect, retry, persist

### Task 1: Error classification (`watchdoginstall/classify.go`) + typed updater sentinels

**Files:**
- Create: `agent/internal/watchdoginstall/classify.go`, `classify_test.go`
- Modify: `agent/internal/updater/updater.go:853,882,1540` (wrap with `%w` of new exported sentinels)
- Test: `agent/internal/updater/updater_security_test.go` (add sentinel assertions)

**Interfaces:**
- Produces: `type ErrorClass string` with consts `ClassNetwork="network"`, `ClassServer="server"` (5xx/429), `ClassPolicy="policy"`, `ClassSignature="signature"`, `ClassChecksum="checksum"`, `ClassDevBuild="dev_build"`, `ClassUnsupportedOS="unsupported_os"`, `ClassInstallCmd="install_cmd"`, `ClassLocked="locked"`, `ClassUnknown="unknown"`; `func Classify(err error) (ErrorClass, bool /*permanent*/)`. Produces in `updater`: `var ErrChecksumMismatch`, `var ErrManifestSignature`.
- Permanence: `signature`, `checksum`, `policy`, `dev_build`, `unsupported_os` permanent; `network`, `server`, `locked`, `install_cmd`, `unknown` transient. (`ErrUntrustedRelease` and `ErrCodeSignatureInvalid` → `signature`; `ErrReadOnlyFS` → `install_cmd`, transient, because a remount heals it.)

- [ ] **Step 1: Write the failing table test**

```go
func TestClassify(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		class     ErrorClass
		permanent bool
	}{
		{"checksum", fmt.Errorf("checksum verification failed: %w", updater.ErrChecksumMismatch), ClassChecksum, true},
		{"manifest sig", fmt.Errorf("x: %w", updater.ErrManifestSignature), ClassSignature, true},
		{"untrusted release", updater.ErrUntrustedRelease, ClassSignature, true},
		{"policy", &netpolicy.PolicyError{Reason: "redirect_refused"}, ClassPolicy, true},
		{"timeout", &url.Error{Op: "Get", URL: "https://x", Err: context.DeadlineExceeded}, ClassNetwork, false},
		{"locked", updater.ErrFileLocked, ClassLocked, false},
		{"nil-ish unknown", errors.New("boom"), ClassUnknown, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, p := Classify(tc.err)
			if c != tc.class || p != tc.permanent {
				t.Fatalf("got (%s,%v) want (%s,%v)", c, p, tc.class, tc.permanent)
			}
		})
	}
}

// Classify's string output must never contain a URL or err text.
func TestClassifyNeverEchoesErrorText(t *testing.T) {
	c, _ := Classify(&url.Error{Op: "Get", URL: "https://secret.example/x?cap=abc", Err: io.EOF})
	if strings.Contains(string(c), "secret") { t.Fatal("leaked") }
}
```

- [ ] **Step 2: Run, expect FAIL:** `cd agent && go test -race ./internal/watchdoginstall/ -run 'TestClassify' -v` → "undefined: Classify".
- [ ] **Step 3a:** the trust boundary is wider than two sites. Audit every verification failure in `downloadBinary`/manifest verification (`updater.go:~845-882`: unknown/missing/malformed signing-key id, no trusted keys configured, malformed signature encoding at `:1215`) and wrap each in `ErrManifestSignature` (or sibling `ErrManifestKey`); every *trust* decision must classify permanent. Also introduce a typed `updater.HTTPStatusError{Code int}` for non-200 download/info responses (`updater.go:~1820`) so `Classify` can map 5xx/429 to `server` and other codes to `unknown`; without it a 503 classifies `unknown`. Also add `updater.Config.TempDir` so the download lands in our per-attempt dir (Task 7 step 6). Test with the real downloader (Task 7 `RealDownloaderFailuresClassified`).
- [ ] **Step 3: Add the two sentinels to `updater.go`** and change the three `fmt.Errorf` sites to wrap them (`fmt.Errorf("%w: expected %s, got %s", ErrChecksumMismatch, …)`; keep message text identical after the sentinel so existing log greps still match). Grep for tests asserting the old text: `git grep -n 'checksum mismatch' agent`.
- [ ] **Step 4: Implement `Classify`** with `errors.Is`/`errors.As` ordering: policy → sentinels → `*url.Error`/`net.Error` → HTTP status class if the updater exposes one (if it does not, W1 treats unrecognised HTTP failures as `unknown`/transient; do not parse strings) → unknown.
- [ ] **Step 5: Run** `go test -race ./internal/watchdoginstall/... ./internal/updater/...` → PASS; `GOOS=windows go vet ./internal/updater/... ./internal/watchdoginstall/...`; `GOOS=darwin go vet …`.
- [ ] **Step 6: Commit** `feat(agent): classify watchdog install failures (#7583)`.

### Task 2: Persisted state store + opt-out marker (`watchdoginstall/state.go`)

**Files:**
- Create: `agent/internal/watchdoginstall/state.go`, `state_test.go`
- Modify: `agent/internal/config/machine_config_trust.go` (`reclaimAgentEntries`: add `"watchdog-install.state": true, "watchdog.disabled": true`)
- Test: `agent/internal/config/machine_config_trust_test.go`

**Interfaces:**
- Produces:
```go
type Record struct {
	SchemaVersion  int        `json:"v"`
	BudgetVersion  string     `json:"budgetVersion"` // agent version the budget belongs to
	Attempts       int        `json:"attempts"`
	FirstAttemptAt time.Time  `json:"firstAttemptAt,omitempty"`
	LastAttemptAt  time.Time  `json:"lastAttemptAt,omitempty"`
	NextAttemptAt  time.Time  `json:"nextAttemptAt,omitempty"`
	LastClass      ErrorClass `json:"lastClass,omitempty"`
	Terminal       bool       `json:"terminal,omitempty"`
}
type Store struct{ Dir string; Now func() time.Time }
func (s Store) Load() (rec Record, corrupt bool, err error)
func (s Store) Save(Record) error            // temp in same dir, fsync, rename, 0600
func (s Store) Reset() error                 // removes state only; NEVER the opt-out marker
func (s Store) OptedOut() bool
func (s Store) SetOptedOut(bool) error       // marker file `watchdog.disabled`, 0600 root/SYSTEM
```
- Location (Open Decision 3): `config.MachineConfigDir()` (`/etc/breeze`, `/Library/Application Support/Breeze`, `%ProgramData%\Breeze`) — beside `agent.state`. Windows: files created by SYSTEM inherit the folder ACL that `programdata_trust` already audits; **do not** loosen it. Not under `/tmp` or user-writable dirs.

- [ ] **Step 1: Failing tests**
```go
func TestStore_CorruptFailsClosed(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "watchdog-install.state"), []byte(`{"v":1,"attempts":`), 0o600) // torn
	s := Store{Dir: dir, Now: fixedNow}
	rec, corrupt, err := s.Load()
	if err != nil || !corrupt { t.Fatalf("corrupt=%v err=%v", corrupt, err) }
	if rec.NextAttemptAt.IsZero() || !rec.NextAttemptAt.After(fixedNow()) { t.Fatal("corrupt state must defer to the slow cadence, not retry now") }
}
func TestStore_ResetKeepsOptOut(t *testing.T) { /* SetOptedOut(true); Save(rec); Reset(); OptedOut()==true; state gone */ }
func TestStore_AtomicWrite(t *testing.T)     { /* Save twice; no *.tmp left; mode 0600 on unix */ }
func TestStore_UnknownSchemaVersionIsCorrupt(t *testing.T) { /* v:99 → corrupt=true */ }
func TestOptOutMarker_UnreadableMeansOptedOut(t *testing.T) { /* stat error other than ENOENT → true (fail safe: don't install) */ }
```
- [ ] **Step 2:** `go test -race ./internal/watchdoginstall/ -run 'TestStore|TestOptOut' -v` → FAIL (undefined).
- [ ] **Step 3: Implement.** Corrupt → `Record{NextAttemptAt: now+24h, Terminal:false}` plus `corrupt=true` (caller logs once). Marker unreadable for any non-ENOENT reason ⇒ treated as opted out (an ambiguous state must not trigger a privileged install).
- [ ] **Step 4:** add the two names to `reclaimAgentEntries`; extend `machine_config_trust_test.go` to assert the entries are recognised (a SYSTEM-owned unknown entry is "set aside", an agent-owned one is not).
- [ ] **Step 5:** `go test -race ./internal/watchdoginstall/... ./internal/config/...`; `GOOS=windows go vet ./internal/config/... ./internal/watchdoginstall/...`.
- [ ] **Step 6: Commit** `feat(agent): persisted watchdog install state and opt-out marker (#7583)`.

### Task 3: Schedule + budget (`watchdoginstall/schedule.go`)

**Files:** Create `schedule.go`, `schedule_test.go`.

**Interfaces:**
- Produces:
```go
type Plan struct {
	Initial     time.Duration // 5m
	Multiplier  float64       // 3
	Cap         time.Duration // 6h
	Jitter      float64       // 0.2
	MaxAttempts int           // 8, then Terminal
	SlowProbe   time.Duration // 24h (transient exhaustion)
	SecurityProbe time.Duration // 7d (permanent classes)
}
var DefaultPlan Plan
func (p Plan) Record(rec Record, version string, now time.Time, class ErrorClass, permanent bool, rnd func() float64) Record // pure
func (p Plan) Due(rec Record, version string, now time.Time) bool
```
Delay series (before jitter): 5 m, 15 m, 45 m, 2 h 15 m, 6 h (cap) …; attempts 1–8, then `Terminal=true` and `NextAttemptAt = now + SlowProbe` (transient) or `SecurityProbe` (permanent). A permanent class goes terminal **on first occurrence** (no budget burn): `Attempts` increments, `Terminal=true`.
- Reset rules inside `Due`/`Record`: `version != rec.BudgetVersion` ⇒ budget restarts (new binary may fix it) — but at most once per version, since `BudgetVersion` is then set to `version`. A crash-loop cannot re-arm it because the version is unchanged.

- [ ] **Step 1: Failing tests** (injected `now`, deterministic `rnd`):
  - `TestPlan_DelaySeries` asserts 5 m, 15 m, 45 m, 2 h15 m, 6 h, 6 h with `rnd=0.5` (zero jitter) and ±20 % bounds with `rnd=0/1`.
  - `TestPlan_PermanentGoesTerminalImmediately`: one signature failure → `Terminal`, `NextAttemptAt = now+7d`, `Due` false at +6 d 23 h.
  - `TestPlan_RestartDoesNotResetBudget`: build rec after 3 failures, "restart" (new Plan value, same rec) → `Due` false until `NextAttemptAt`.
  - `TestPlan_VersionChangeRearmsOnce`: new version → `Due` true; record a failure at the new version; same version again does not re-arm.
  - `TestPlan_ExhaustionGoesTerminalThenSlowProbe`: 8 failures → `Terminal`; `Due` false until +24 h; a 9th (probe) failure stays terminal and re-arms +24 h (probe attempts do not grow the active-phase counter without bound — cap `Attempts` at `MaxAttempts+probe count` saturating at 1000).
  - `TestPlan_ClockSkewBackwards`: `now` before `LastAttemptAt` → treat `NextAttemptAt` as `now + Initial` (never a negative wait, never an immediate storm).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS (`-race`). **Step 5:** commit `feat(agent): bounded backoff schedule for watchdog install (#7583)`.

### Task 4: Per-OS registration detector

**Files:** Create `detect_{linux,darwin,windows,other}.go`, `detect_test.go` (build-tagged variants per OS with seams).

**Interfaces:** `type Status int` (`StatusRegistered`, `StatusRegisteredStopped`, `StatusMissing`, `StatusUnsupported`, `StatusUnknown`); `func Detect(seams ...) (Status, error)`. `StatusRegisteredStopped` = definition present but service not active: treated as `Registered` (no install) **unless** the persisted record shows an open `install_cmd` attempt, in which case it is treated as `Missing` so an interrupted install is completed rather than erased. Paths come from existing constants (`securefs.LegacyExecutableDir`/`TrustedExecutableDir` for the binary — mirror `heartbeat.watchdogBinaryPath()` incl. the macOS trusted-first fallback; unit `/etc/systemd/system/breeze-watchdog.service`; plist `/Library/LaunchDaemons/com.breeze.watchdog.plist`; Windows `OpenService("BreezeWatchdog")` + protected binary path). **Definition:** `StatusRegistered` iff binary exists **and** service definition exists. `Unsupported` for `GOOS` not in {linux, darwin, windows} and for Linux hosts without systemd (`/run/systemd/system` absent) → terminal state `unsupported`, zero attempts.

- [ ] **Step 1: Failing tests (table, fake FS):** binary-only ⇒ `Missing`; unit-only ⇒ `Missing`; both ⇒ `Registered`; stat error other than ENOENT ⇒ `Unknown` (caller does **not** install on `Unknown`); non-systemd Linux ⇒ `Unsupported`; Windows: `ERROR_SERVICE_DOES_NOT_EXIST` ⇒ `Missing`, other SCM errors ⇒ `Unknown`, binary-without-service ⇒ `Missing` (`TestDetect_WindowsBinaryWithoutService`).
- [ ] **Step 2–5:** run red, implement, run green with `-race`, `GOOS=windows go vet`, `GOOS=darwin go vet`; commit `feat(agent): detect unregistered watchdog per OS (#7583)`.

### Task 5: Persist `--no-watchdog`, add `--watchdog`

**Files:** Modify `agent/internal/agentapp/service_cmd_{linux,darwin,windows}.go`; test `agent/internal/agentapp/service_cmd_watchdog_optout_test.go` (new, tagless — extract a small `applyWatchdogFlags(store, noWatchdog, watchdog bool) (skip bool, err error)` so it is testable without root).

Behaviour (Decision 3): `--no-watchdog` ⇒ `SetOptedOut(true)` **before** skipping bootstrap (write failure is a hard error: an opt-out that cannot be recorded must not silently become "retry later"); `--watchdog` ⇒ `SetOptedOut(false)` + `Reset()` + run bootstrap; neither flag with marker present ⇒ skip bootstrap and print one line `watchdog install skipped: opted out (use --watchdog to re-enable)`; neither flag, no marker ⇒ today's behaviour. `--no-watchdog` and `--watchdog` together is a flag error.

- [ ] **Step 1: Failing tests:** the four combinations above plus "marker write fails ⇒ error, bootstrap not run".
- [ ] **Step 2–5:** red → implement → green → `GOOS=windows go vet ./internal/agentapp/...` / darwin → commit `feat(agent): persist watchdog opt-out; add --watchdog (#7583)`.

### Task 6: Spike — can the agent install the watchdog on each OS? (no production code; output is a test fixture + notes in the PR)

**Files:** none. Record findings in the PR body (not a new doc). Deliverable: three answers, each backed by a runnable check (a throwaway Go test or shell transcript pasted into the PR), that fix the shape of Task 7.

- [ ] Linux: print the agent unit's mount namespace (`ProtectSystem`, `PrivateTmp`, `ReadWritePaths`; `systemd_unit.go:62`) and confirm (a) the temp file `downloadBinary` writes is visible to a `systemd-run` transient service (if `PrivateTmp=true` it is **not**), (b) staging under `/var/lib/breeze` (in `ReadWritePaths`) is visible. Expected outcome: Linux stages to `/var/lib/breeze/watchdog-stage/` (mode 0700), invoked via `systemd-run --wait --collect --pipe` using the same flag invariants as `reconcileTransientArgs`.
- [ ] macOS: confirm the agent (root LaunchDaemon) can exec the downloaded binary's `service install` and that `Library/Breeze/bin` ownership checks (`securefs`) pass; confirm the downloaded file's quarantine/code-signature behaviour (`ErrCodeSignatureInvalid` path in the updater).
- [ ] Windows: confirm LocalSystem can run `winsvcinstall.Install` while the agent service runs (no lock on `breeze-watchdog.exe`, since it does not exist yet).
- [ ] Gate: if Linux (a)/(b) fails, stop and revise Task 7 before continuing; record the outcome as a comment on the PR (not the issue).

### Task 7: `Ensure` core (`heartbeat/watchdog_ensure.go`), wiring into `handleWatchdogUpgrade`, per-OS `registerVerifiedWatchdog`

**Files:** Create `watchdog_ensure.go`, `watchdog_ensure_test.go` (tests keep the `TestReconcile_*` names); optional local tick `watchdog_reconcile.go` only under Decision 1(c); modify `watchdog_install_{linux,darwin,windows,other}.go` (add `registerVerifiedWatchdog(path string) error`, executing `<path> service install` with a 120 s timeout and, on Linux, through `systemd-run`), `heartbeat.go` (start loop where other background loops start; guard like the existing auto-update gating).

**Interfaces:**
- Consumes: Task 1–4 (`Classify`, `Store`, `Plan`, `Registered`), `h.downloadWatchdogBinary(version)`, `updater.TryBeginProcessMutation("watchdog-update")`, `watchdogUpgradeDecision(version, h.agentVersion)`.
- Produces: `func (h *Heartbeat) ensureWatchdog(version string) (handled bool)` (no `trigger` type in W1; `handled==true` means `handleWatchdogUpgrade` must **return** without falling through to the old uncapped `installAndRestartWatchdog` path whenever the host is `Missing`, opted out, terminal, or deferred); test seams `h.watchdogReconcileDetect`, `h.watchdogReconcileDownload`, `h.watchdogReconcileRegister`, `h.watchdogReconcileStore`, `h.watchdogReconcileNow` (injected clock); `func (h *Heartbeat) watchdogInstallReport() *WatchdogInstallReport` (Task 8).

`Ensure(version string, trigger)` contract. Entry points: (T1) `handleWatchdogUpgrade` calls `Ensure` **when `Registered()` is `Missing`** (otherwise the existing version-swap path is untouched), after the existing semver/downgrade guard and the `!rollbackActive && !identityRestarting` gate at the call site (`heartbeat.go:5434`); (T2, only Decision 1(c)) a local tick every 60 s that runs **only while a server-signalled target is cached** and never invents a version. Both triggers share one budget, opt-out, lease and state (otherwise "poisoned host becomes silent" is false). Steps:
0. Gates shared with the call site: `rollbackActive`, `identityRestarting`, `watchdogUpgradeDecision`. `autoUpdate()` is checked **inside** `Ensure` (step 1b) and `handleWatchdogUpgrade` must call `Ensure` *before* its own `!h.autoUpdate()` early return when the host is `Missing`, otherwise `disabled_by_policy` can never be reported (`heartbeat.go:7552`).
1. Not enrolled or no auth token → return (no budget burn). 1b. `!autoUpdate()` → report `disabled_by_policy`, return without a download. Auto-update disabled (`!h.autoUpdate()`) → state `opted_out`-equivalent `disabled_by_policy`, return. Dev build (`isDevBuildVersion`-equivalent) → permanent `dev_build`, terminal, zero network.
2. `store.OptedOut()` → report state `opted_out`, return.
3. `Registered()` → `Registered`: clear state if any; mark success; return. `Unsupported`: report `unsupported`; `Unknown`: log once, return without counting.
4. `!plan.Due(rec, version, now)` → return.
5. Acquire the lease; not acquired ⇒ return (no attempt counted). Re-run `Registered()` under the lease (TOCTOU).
5b. Take the cross-process lock `watchdog-install.lock` (non-blocking). **There is no ready primitive**: `updater/filelock_{unix,windows}.go` only holds `isFileLocked(err)`. Add `watchdoginstall/lock_{unix,windows}.go` (`flock(LOCK_EX|LOCK_NB)` / `LockFileEx`), modelled on `agent/internal/backup/journal_lock_{unix,windows}.go`, with `TestLock_SecondAcquirerDefers` (red first); held means defer without counting. **Persist an attempt reservation** (`Attempts++`, `NextAttemptAt = now+Initial`) *before* any side effect; `Plan.Record` on failure sets class and the delay for the **next** attempt but does not increment `Attempts` again (Task 3 test `TestPlan_ReservationNotDoubleCounted`) so a kill mid-download or mid-install cannot re-enter work for free; a failed `Save` aborts the attempt.
6. Download into a per-attempt dir we create (`0700`, root-owned, opened via the `securefs` no-follow traversal, `securefs/path_unix.go`), not the downloader's default `os.CreateTemp("", "breeze-agent-dev-*")`; chmod the verified file `0700` (it is created `0600`, `updater.go:1827`). Download → on error: `Classify`, `plan.Record`, `Save`, log with `SafeDownloadErrorFields`, return.
7. macOS only: run the staged-binary code-signature check the updater applies in `replaceBinary` (`ErrCodeSignatureInvalid`, `updater.go:1624`) **before** executing the file as root (`DownloadBinary` alone does not). `registerVerifiedWatchdog(temp)` (Linux: `systemd-run --wait -p RuntimeMaxSec=120`, so the unit self-terminates and the lease is never released over a live installer); on error: classify as `install_cmd` (transient, except exit "unsupported"), record. On success: `Registered()` must now be true and the service must reach started within 30 s (Linux `systemctl is-active`, macOS `launchctl print`, Windows `svc.Running`), otherwise record an `install_cmd` failure (exit codes alone are not trusted). Missing Windows recovery-action configuration (`install.go:318` only warns) is logged as degraded, not failed (Decision 17).
8. Success: `Reset()`, set `watchdogInstalledVersion = version` (the server-supplied target, never the agent's own version), invalidate the version cache (`watchdogVersionRead=false`), log once at Info.
Panics are caught by `observability.Recoverer` (already deferred in `handleWatchdogUpgrade`). If Decision 1(c) is approved, the local tick is a separate goroutine that exits on `ctx.Done()`.

- [ ] **Step 1: Failing tests (injected seams, fake clock; no network):**
  - `TestReconcile_UnenrolledDoesNothing` (no download seam call, no state written).
  - `TestReconcile_OptedOutDoesNothing`.
  - `TestReconcile_MissingWatchdogInstallsOnceAndClearsState`.
  - `TestReconcile_TransientFailureBacksOffAndPersists` (2 ticks inside the window ⇒ 1 download).
  - **`TestReconcile_PoisonedHost_BoundedThenSilent`**: download returns a signature error ⇒ exactly 1 download, `Terminal`, then 1000 ticks across simulated 6 d ⇒ **0** more downloads; at +7 d exactly 1 probe.
  - **`TestReconcile_RestartPersistence`**: fail twice, construct a fresh `Heartbeat` with the same store dir ⇒ no immediate attempt; honours `NextAttemptAt`.
  - `TestReconcile_LeaseHeldDefersWithoutCountingAttempt`.
  - `TestReconcile_ConcurrentHeartbeatsInstallOnce` (many concurrent `handleWatchdogUpgrade` calls; installer called once; `-race -count=50`); under Decision 1(c) add the tick-vs-signal variant.
  - `TestWinInstall_ConcurrentCreateFallsThroughToUpdate` (in `winsvcinstall`).
  - `TestReconcile_RegisterSucceedsButStillMissingIsFailure`.
  - `TestReconcile_SuccessUpdatesVersionTelemetry` (`installedWatchdogVersion()` returns the new version without a disk read).
  - `TestReconcile_DevBuildNeverDownloads`.
  - `TestReconcile_ServerSignalHonoursPersistedBackoffAndOptOut`: 1000 simulated heartbeats each carrying `watchdogUpgradeTo` yield downloads bounded exactly by the schedule, and 0 when opted out (current code does ~48/day).
  - `TestReconcile_KilledMidAttemptStillSpendsBudget` (reservation persisted before side effects).
  - `TestReconcile_InstalledButNotStartedIsFailure`.
  - `TestReconcile_RealDownloaderFailuresClassified`: drive the real `updater` against an `httptest` server returning a bad checksum, bad signature, unknown key id, redirect to a refused host, and a 503; assert the class each time (not synthetic sentinels).
- [ ] **Step 2:** `cd agent && go test -race ./internal/heartbeat/ -run TestReconcile -v` → FAIL.
- [ ] **Step 3–4:** implement; run → PASS, then `go test -race -count=20 ./internal/heartbeat/ -run 'TestReconcile|TestHandleWatchdogUpgrade'`.
- [ ] **Step 5:** `GOOS=windows go vet ./internal/heartbeat/...`; `GOOS=darwin go vet ./internal/heartbeat/...`.
- [ ] **Step 6: Commit** `feat(agent): reconcile a missing watchdog from the enrolled agent (#7583)`.

### Task 8: Heartbeat payload `watchdogInstall`

**Files:** Modify `agent/internal/heartbeat/heartbeat.go` (struct ~line 125, populate ~line 4835); test `agent/internal/heartbeat/watchdog_install_payload_test.go`.

```go
type WatchdogInstallReport struct {
	State          string `json:"state"`                    // closed set below
	Attempts       int    `json:"attempts,omitempty"`       // saturates at 1000
	LastAttemptAt  string `json:"lastAttemptAt,omitempty"`  // RFC3339 UTC
	LastErrorClass string `json:"lastErrorClass,omitempty"` // ErrorClass enum only
}
// field on HeartbeatPayload:
WatchdogInstall *WatchdogInstallReport `json:"watchdogInstall,omitempty"`
```
`State` ∈ `retrying` | `gave_up` | `opted_out` | `unsupported` | `disabled_by_policy` (server adds `unrecognized`). **Healthy/registered ⇒ the field is omitted** (absence = nothing to report; the server clears). No free text, no URL, no `err.Error()`, ≤ ~120 bytes.

- [ ] Failing tests (named `TestHeartbeatPayload_WatchdogInstall_*`): omitted when registered; omitted before first evaluation; `retrying` after one failure with class; `gave_up` after exhaustion; JSON size bound (`len(json) < 200`); a fuzz-ish test that feeds an error containing a URL with a query string through the whole path and asserts the marshalled payload contains neither the URL nor the text.
- [ ] Run red/green with `-race`; commit `feat(agent): report watchdog install health in heartbeat (#7583)`.

### Task 9: Install-path hardening: atomic Linux/macOS writes, Windows create-race (audit rows 6a, 6c, 6d)

**Files:** Modify `agent/internal/winsvcinstall/install.go` (~lines 268-312: when `m.Create` fails with `ERROR_SERVICE_EXISTS`, re-open and fall through to the update-in-place branch instead of returning a hard error; test `TestWinInstall_ConcurrentCreateFallsThroughToUpdate` in `install_test.go` using the existing fake manager seam); `agent/cmd/breeze-watchdog/service_cmd_darwin.go` (~lines 114-127: same temp+rename for binary and plist) and `agent/cmd/breeze-watchdog/service_cmd_linux.go` (~line 113, replace `os.WriteFile(watchdogBinaryPath, data, 0755)` with write-temp-in-dir + fsync + chmod + rename); test `service_cmd_linux_test.go`.

- [ ] Failing test `TestLinuxInstall_BinarySwapIsAtomic`: extract `installBinaryAtomically(src, dst string) error`; assert (a) a failure injected after the temp write leaves `dst` untouched, (b) no `.breeze-watchdog-*.new` left, (c) result mode 0755. Run red; implement (mirror `replaceWatchdogBinaryUnix`, which lives in `package heartbeat` — copy the 20 lines rather than add a cross-package dependency, note it in the commit); green; commit `fix(watchdog): install binary via atomic rename (#7583)`.

### Task 10: Stage-dir sweep + docs note

**Files:** `agent/internal/heartbeat/watchdog_reconcile.go` (sweep our per-attempt dirs `breeze-watchdog-ensure-*` under the protected stage root, older than 1 h, at first `Ensure`; the downloader's default `breeze-agent-dev-*` temp files are avoided via `updater.Config.TempDir`, Task 1); docs: `apps/docs/src/content/docs/agents/installation.mdx` (~line 260-277: replace "re-run `service install`" guidance with the self-heal behaviour + `--no-watchdog` persistence + `--watchdog`) and `features/watchdog.mdx` (one paragraph: how a missing watchdog is repaired, backoff, where state lives).

- [ ] `TestStageSweep_RemovesStaleOnly` and `TestDownload_UsesAttemptDir` red→green; docs build check `cd apps/docs && pnpm build` (or the repo's docs check) ; full W1 verification: `cd agent && go test -race ./... ` for touched packages + GOOS vets; commit `docs+test(agent): watchdog self-heal behaviour (#7583)`.
- [ ] W1 PR: base `main`, body `Refs #7583`, (a PR to `main` runs CI; no manual dispatch needed). Required jobs: `test-agent`. Wave exit: lab check on one Linux, one Windows, one macOS VM (delete the watchdog, restart the agent, observe self-heal within the first window; run a poisoned-signature case by pointing the lab at a tampered manifest and observe the terminal state with no further requests) — recorded in the PR.

---

# Wave 2 — API + web: surface the terminal state

### Task 11: Migration, schema, ingest

**Files:**
- Create: `apps/api/migrations/2026-12-23-220000-device-watchdog-install-state.sql` (slot re-checked first)
```sql
-- #7583: agent-reported watchdog install health. Nullable, no default:
-- metadata-only ALTER on the hot devices table. Existing RLS policies on devices
-- cover the new columns. Writes no rows (so no breeze.scope election needed).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_install_state varchar(20);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_install_error_class varchar(20);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS watchdog_install_since timestamptz;
```
- Modify: `apps/api/src/db/schema/devices.ts` (next to `helperInstallIssue`, ~line 340); `apps/api/src/routes/agents/schemas.ts` (~line 199, beside `watchdogVersion`); `apps/api/src/routes/agents/heartbeat.ts` (beside the `helperInstallIssue` block, ~line 1116); `apps/api/src/routes/devices/core.ts` (select ~1245, response ~1459); `apps/api/src/services/tenantExportPolicyRegistry.ts` (`devices` entry: add the three names to `included` — short enums and a timestamp, no free text, no json/jsonb/bytea so not `excludedOpen`).
- Tests: `apps/api/src/routes/agents/heartbeat.test.ts`, `schemas.heartbeatTolerance.test.ts`, `routes/devices/core.list-response-shape.test.ts`.

Zod (mirrors the `helperInstallIssue` closed-set pattern, never rejects the beat):
```ts
watchdogInstall: z.object({
  state: z.enum(['retrying','gave_up','opted_out','unsupported','disabled_by_policy','unrecognized']),
  attempts: z.number().int().min(0).max(1000).optional(),
  lastAttemptAt: z.string().datetime({ offset: true }).optional().catch(undefined),
  lastErrorClass: z.enum(['network','server','policy','signature','checksum','dev_build','unsupported_os','install_cmd','locked','unknown']).optional().catch('unknown'),
}).optional().catch({ state: 'unrecognized' }),
```
`state` therefore also admits `'unrecognized'` (a future or malformed value **must not clear a real stored failure**; this is why `helperInstallIssue` maps to `'unrecognized'` rather than `undefined`, `schemas.ts:~193`). Ingest semantics: **absence = clear** (`NULL`, like `helperInstallIssue`); a present-but-`unrecognized` value is stored only when no state is stored yet; it never overwrites or clears an existing recognised state — safe because an old agent never has the field and a new healthy agent omits it; `since` is set only on transition (null→value or state change).

- [ ] **Step 1: Failing tests:** (a) tolerance: `watchdogInstall: 'garbage'`, `{state:'x'}`, oversized `attempts` ⇒ beat accepted, stored as `unrecognized` when the column was NULL, and an existing `gave_up` is left untouched; (b) heartbeat with `{state:'gave_up',lastErrorClass:'signature'}` writes the 3 columns with `since` = now; (c) same value again does not move `since`; (d) a following heartbeat without the field clears all three; (e) list-response shape includes the new keys.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts src/routes/agents/schemas.heartbeatTolerance.test.ts src/routes/devices/core.list-response-shape.test.ts` → FAIL.
- [ ] **Step 3–4:** implement; green; `pnpm db:check-drift`; typecheck (`NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .`, check exit code).
- [ ] **Step 5 (tenancy checks, per CLAUDE.md):** this is an `ADD COLUMN` on an org-cascade table (`devices`), not a new table. Required: export-policy classification (done above). Cascade/merge registries need no change for a column on an already-registered table — **prove it, don't judge**: `git grep -n "'devices'\|\"devices\"" apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts` and confirm no per-column lists; the column-level enforcement is the export-policy suite, which **fails only under Integration Tests** (not Test API): run `pnpm test-stack up` then the export-policy/org-cascade suites per `docs/agents/testing.md`, then `pnpm test-stack down` and state in the PR what was left running (nothing).
- [ ] **Step 6: Commit** `feat(api): persist agent-reported watchdog install health (#7583)`.

### Task 12: Info-tab banner

**Files:** Modify `apps/web/src/components/devices/DeviceInfoTab.tsx` (type ~line 85, banner after the `helper-install-issue` block ~line 1143); `apps/web/src/locales/*/devices.json` ×8; test `DeviceInfoTab.test.tsx`.

Banner states: `gave_up` → "The watchdog could not be installed automatically ({reason}). Re-run `breeze-agent service install --watchdog` on the host." with `{reason}` from a fixed map of `lastErrorClass` → localized phrase (never the raw class string); `retrying` → "Watchdog install is being retried automatically."; `opted_out` → neutral text (`text-muted-foreground`, not warning); `unsupported`/`disabled_by_policy` → neutral. Offline devices: the banner shows the **last stored** state with its `since` date; no staleness logic (consistent with `helperInstallIssue`). `data-testid="watchdog-install-issue"`; no mutation handlers, so no `runAction`.

- [ ] Failing tests per state + "renders nothing when null" + unknown state falls back to a generic string (mirrors `helperInstallIssue.unknown`). Run `cd apps/web && npx vitest run src/components/devices/DeviceInfoTab.test.tsx` red→green. Locale parity: `npx vitest run src/lib/i18n` (localeParity lives there; fixers miss it). Typecheck web. Commit `feat(web): show watchdog install health on device info (#7583)`.
- [ ] W2 PR exit: Test API + Test Web + **Integration Tests** (export policy) green.

---

# Wave 3 — Install-lane signalling + final docs

### Task 13: `service install` outcome signalling (gated on Decision 6)

**Files:** `agent/internal/agentapp/service_cmd_{linux,darwin,windows}.go`; new `agent/internal/agentapp/exit_codes.go`; tests `service_cmd_exitcode_test.go`.

Default if approved as recommended (Decision 6, option B; `--strict-watchdog` makes *any* bootstrap failure, transient or permanent, exit 78): keep **exit 0** and add a **machine-readable stdout/stderr line** `BREEZE_WATCHDOG_INSTALL=deferred reason=<class>` plus a new opt-in `--strict-watchdog` flag that returns a distinct exit code (`78`) for scripted lanes that want to fail. Rationale: the agent installed and a background retry will heal the host, so the default must not report failure. If option A (distinct non-zero by default) is chosen instead: exit 78 only when the agent service is installed **and** the bootstrap failed **and** the failure is *permanent* (`Classify` permanent, ); transient failures stay 0 because the reconcile will heal them.

- [ ] Failing tests: transient failure ⇒ 0 + marker line; permanent failure with `--strict-watchdog` ⇒ `ExitCodeError{78}`; `--no-watchdog` ⇒ 0; agent start failure still wins (`installErr`/`startErr` semantics unchanged, `service_cmd_windows.go:~150`). Verify the cobra main maps the error to the process code; verify lanes: the MSI is declarative (`ServiceInstall svcInstallWatchdog`, `breeze.wxs:~508`) and runs neither CLI, so the exit code cannot affect it; confirm no custom action wraps `breeze-agent service install`; `install-linux.sh`/`install-darwin.sh` call neither; the web one-liner and RMM runner wrappers are server-generated scripts — grep `apps/api/src` for the one-liner generator before claiming compatibility.
- [ ] Commit `feat(agent): signal deferred watchdog install to scripted installs (#7583)`.

### Task 14: Linux `install-linux.sh` (gated on Decision 7)

Recommendation: **no script change for self-heal** (the W1 reconcile covers a Linux host that has the agent unit but no watchdog); add one warning line to `install-linux.sh` (~line 54-90) when neither `bin/breeze-watchdog` nor `./breeze-watchdog` exists: `Warning: no watchdog bundled; the agent installs one after enrollment when the control plane offers a watchdog build for this platform`. Test: extend the install-script shell test harness if one exists (`git grep -n install-linux.sh agent --include='*test*'`); otherwise shellcheck in CI plus a dry-run in the lab. Also note macOS `install-darwin.sh` (~line 102-145) registers the watchdog only if bundled — same warning.

### Task 15: Final docs

**Files:** `apps/docs/src/content/docs/agents/installation.mdx`, `advanced-install.mdx`, `features/watchdog.mdx`. Content: exit-code table (0 success; 78 only under `--strict-watchdog` or per Decision 6), `--no-watchdog` / `--watchdog` semantics and the marker's location per OS, the self-heal timeline (5 m / 15 m / 45 m / 2 h 15 m / 6 h; 8 attempts; 24 h and 7 d probes), troubleshooting (terminal state, how to reset: `service install --watchdog`), Linux install-script behaviour, air-gapped hosts must use `--no-watchdog`. Docs build must pass. Commit `docs: watchdog self-heal, exit codes, opt-out (#7583)`.

---

## Compatibility matrix

| Agent | API | Result |
|---|---|---|
| old (no `watchdogInstall`) | old | Unchanged |
| old | new (W2) | Field absent ⇒ columns NULL ⇒ no banner. Never writes garbage |
| new (W1) | old | `watchdogInstall` stripped by Zod (non-strict top-level, verified); self-heal still works; nothing shown |
| new | new | Full behaviour |
| new agent, **old watchdog binary** installed | any | Detector says `Registered` ⇒ reconcile no-ops; version upgrades remain `handleWatchdogUpgrade`'s job |
| new agent, `service install` from an **old** agent binary (opt-out not persisted) | any | The old binary's `--no-watchdog` leaves no marker ⇒ a new agent later "heals" an intentionally watchdog-less host. Not knowable from disk, so this is an accepted, documented risk: air-gapped fleets re-run `service install --no-watchdog` once after upgrading. See Decision 3 |

## Open Decisions

1. **Where does the retry run?** (a) *Fix the existing server-signalled path only*: the server already sends `watchdogUpgradeTo` for a never-installed watchdog, pin-aware (`heartbeat.ts:1998-2010`); make the agent handler register-capable, bounded, persisted and opt-out-aware; (b) a scheduled task/timer created by `service install`; (c) (a) **plus** a local detector tick that re-attempts only while a server target is cached; (d) a purely local loop that picks its own version. **Recommend (a) for W1, (c) as a follow-up** — (a) honours tenant watchdog pins and org policy with no new trigger; (d) is rejected because it installs the agent's version and defeats a holdback pin; (b) adds a second privileged persistence mechanism. (a)'s known gaps are binary-present/unit-absent hosts and old APIs that never signal; (c) or a server tweak (add a `missing` state to the closed enum and treat it as not-installed instead of falling back to the stored version) closes them.
2. **What does "watchdog missing" mean per OS?** (a) *Registration-level*: binary absent or service definition absent (Linux unit, macOS plist, Windows SCM), plus a bounded started-check **after our own install**; (b) also continuous "registered but not running". **Recommend (a)** — ongoing liveness is the service manager's job (`Restart=always`, `KeepAlive`, SCM recovery), but all three installers write the definition before starting (`service_cmd_linux.go:129`, `service_cmd_darwin.go:126`, `winsvcinstall/install.go:310`), so an install interrupted in that gap must count as a failed attempt.
3. **Persisted state location/format and where `--no-watchdog` lives.** Options: (a) two files in the machine config dir — `watchdog-install.state` (disposable JSON) + `watchdog.disabled` (durable marker); (b) keys in `agent.yaml`; (c) one combined file. **Recommend (a)** — opt-out is operator intent and must survive state corruption/reset and `agent.yaml` rewrites (enrol, config sync); counters are disposable. *Sub-decisions:* plain `service install` honours a standing opt-out and `--watchdog` clears it (**recommend**: scripted upgrade lanes that re-run `service install` must not silently re-enable a deliberately removed watchdog); an agent upgraded from a pre-marker build cannot know about a past `--no-watchdog` — **recommend** accepting that and documenting `--no-watchdog` re-run once after upgrade for air-gapped fleets. *Needs confirming at execution time:* every writer of `agent.yaml` (not audited here).
4. **Schedule, cap, terminal cadence.** (a) 5 m ×3 → cap 6 h, ±20 % jitter, 8 attempts, then 24 h probe (transient) / 7 d probe (security classes); (b) fewer, faster attempts (helper precedent: 3 failures / 6 h cooldown, `helper/install_retry.go`); (c) no cap, 6 h forever. **Recommend (a)** — bounded, but a transient outage lasting days still heals; the numbers are `DefaultPlan` constants, one-line to change.
5. **Permanent vs transient classification.** (a) Closed enum with `signature`, `checksum`, `policy`, `dev_build`, `unsupported_os` permanent and `network`, `server`, `locked`, `install_cmd`, `unknown` transient, using new typed updater sentinels; (b) string-match error text; (c) treat everything as transient with the cap. **Recommend (a)** — (b) is brittle, (c) re-downloads a tampered artifact up to 8 times. `unknown` is transient but capped.
6. **`service install` exit code when the watchdog bootstrap fails.** (A) Distinct non-zero by default (breaking for scripted installs, MSI-adjacent lanes, the web one-liner and RMM runners, which treat 0 as success); (B) **exit 0 by default** + machine-readable marker line + opt-in `--strict-watchdog` → exit 78; (C) leave as is. **Recommend (B)** — the agent install *did* succeed and W1 will heal the host, so reporting failure by default creates false alarms and breaks installs that currently work; strict lanes opt in. Breaking-change note for (A): it must not fire for transient failures at all.
7. **Linux `install.sh` coverage.** (a) W1's reconcile alone covers it; (b) also change `install-linux.sh` to call `breeze-agent service install`; (c) warn only. **Recommend (a)+(c)** — (b) changes unit/ownership behaviour of a lane that deliberately only copies files and rewrites the unit, a bigger blast radius than the gap warrants.
8. **Reuse which download path?** (a) `downloadWatchdogBinary` (authenticated updater: signed manifest, SHA-256, netpolicy, pinned keys) then exec the verified binary's `service install`; (b) `installAndRestartWatchdog` as is (cannot register a missing service — Windows `OpenService` fails; Unix does not write the unit); (c) `stageFirstInstallArtifact` (pre-enrollment path with embedded trust keys / hosted source). **Recommend (a)** — post-enrollment there is a token and server URL, so the stronger path is available; (c) exists because those do not exist before enrollment. Pre-enrollment trust differences: first install trusts embedded keys + hosted route; the retry trusts the enrolled control plane's pinned manifest keys (`pinnedManifestPubKeys`) — a compromised control plane is already trusted for agent self-update, so this does not widen the boundary.
9. **Heartbeat payload shape.** (a) Bounded `watchdogInstall` object (state, attempts, lastAttemptAt, lastErrorClass), omitted when healthy; (b) a flat `watchdogInstallIssue` string like `helperInstallIssue`; (c) reuse `watchdogVersion` absence. **Recommend (a)** — (c) is ambiguous (old agent vs no watchdog); (b) can't carry the error class without encoding. Closed enums, no free text.
10. **Does W2 need storage?** (a) 3 nullable columns on `devices` (precedent: `helper_install_issue`); (b) reuse existing columns; (c) agent log only. **Recommend (a)** — existing columns cannot represent it; the cost is one metadata-only ALTER plus export-policy classification (enum-sized values ⇒ `included`).
11. **Alert on terminal failure now or later?** (a) Defer — banner only; (b) add an alert rule now. **Recommend (a)** — an alert needs a policy/config surface, and the default is *not* to add a config table; if added later, it falls under partner-wide-first (epic #2135: `org_id` XOR `partner_id`, per `docs/agents/tenancy-rls.md`). Revisit after W2 telemetry shows how many hosts reach `gave_up`.
12. **Wave cut and ordering.** (a) W1 agent / W2 API+web / W3 install-lane + docs-with-each-wave; (b) the suggested W3-is-docs-only cut; (c) one PR. **Recommend (a)** — see "Wave cut".
13. **Linux registration from a sandboxed agent.** (a) `systemd-run` transient service (existing precedent) with staging under `/var/lib/breeze`; (b) ask the operator to re-run `service install`. **Recommend (a)**, gated on the Task 6 spike confirming staging visibility; if the spike fails, Linux falls back to reporting `gave_up`/`install_cmd` instead of installing.
14. **`auto_update=false` hosts.** (a) The reconcile honours it and reports `disabled_by_policy` (the existing watchdog upgrade path also refuses when auto-update is off); (b) install regardless, since a missing watchdog is a safety gap, not an update. **Recommend (a)** — an operator who froze binaries expects no downloads; surface it in the banner. Revisit if support data shows this is common.
15. **Version change vs. security probe.** (a) A new agent version re-arms the budget once, even after a signature/checksum/policy terminal state; (b) security-class terminals stay terminal until the 7-day probe or an operator reset. **Recommend (a)** — a new agent build may carry new trust keys or a fixed manifest; re-arming is bounded to once per version, so a crash-loop cannot abuse it.
16. **Target version source.** (a) Server-supplied `watchdogUpgradeTo` only; (b) the agent's own version (lockstep). **Recommend (a)** — (b) bypasses the tenant watchdog pin and the fail-closed `pinsResolved` behaviour (`heartbeat.ts:1980-2010`).
17. **Windows recovery actions failing.** `SetRecoveryActions` failure only warns (`winsvcinstall/install.go:318`). (a) degraded-success, logged; (b) count as an incomplete install and retry. **Recommend (a)** for W1 (a running watchdog beats none); revisit if lab shows it is common.
18. **Cross-process locking.** (a) `watchdog-install.lock` via a small new helper modelled on `backup/journal_lock_*.go`; (b) idempotency alone. **Recommend (a)** — the in-process lease cannot exclude a second agent process (old one during self-update) and Windows create is not atomic with its existence check.
19. **Dev builds.** Terminal `dev_build`, zero network, same as the first-install path; flagged so a lab agent never self-installs a release watchdog next to a dev build.

## Self-review

- **Spec coverage (issue #7583 scope 1–5):** (1) retry after failed stage ⇒ Tasks 7/10; (2) enrolled agent notices missing watchdog via the verified updater path with backoff ⇒ Tasks 3, 4, 7; (3) opt-out persisted ⇒ Tasks 2, 5; (4) `install.sh` ⇒ Task 14 + Decision 7; (5) exit code ⇒ Task 13 + Decision 6. Brief requirements: idempotency table (above), bounded retries/poisoned host/restart persistence (Tasks 3, 7), cross-platform (Tasks 4, 6, 7), compat table, migration slot, W3 docs, numbered Open Decisions.
- **Placeholder scan:** Task 12's locale strings are written at implementation time (8 locales, localeParity enforces completeness). Items marked "needs confirming at execution time" (writers of `agent.yaml`, one-liner generator) are verification steps with the exact grep, not open design.
- **Type consistency:** `ErrorClass` values match across Tasks 1, 7, 8 and the Zod enum in Task 11 (`network, server, policy, signature, checksum, dev_build, unsupported_os, install_cmd, locked, unknown`); `State` values match across Tasks 8, 11, 12; column names `watchdog_install_state`, `watchdog_install_error_class`, `watchdog_install_since` match the migration, Drizzle fields and export policy.
- **Quorum:** the task brief asked for `codex exec` at medium effort (CLAUDE.md prefers `xhigh` for consequential design; the orchestrator may re-run at `xhigh`). Codex (gpt-6-astra, read-only) returned 17 findings; 14 marked CONFIRMED and re-checked by me for the four headline ones and folded in (headline: the server already signals a missing watchdog, which reversed Decision 1; also shared budget across entry points, pin bypass, partial-install false success, non-executable download, macOS code-signature, macOS atomic swap, process-local lease, systemd-run termination, trust-failure boundary, recovery-action overstatement, rollback/identity gates, Zod `unrecognized`, sweep pattern, declarative MSI, attempt reservation). Findings 7, 10 and 17 were SPECULATIVE and adopted as cheap hardening. No unresolved disagreements; Decision 1 changed from the first draft because the code contradicted the task brief. A post-PR document review (stale loop-era text, cross-references, contradictions) was also folded in.
- **Not verified by running code (labelled):** Linux `PrivateTmp` visibility (Task 6 spike), `agent.yaml` writers, whether the updater exposes a typed HTTP-status error (Task 1 falls back to `unknown`, never string-matching), install-lane wrappers outside the repo's agent directory.
