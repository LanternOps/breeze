# Breeze Assist relaunch loop when not installed (#6872) — fix design

Issue: LanternOps/breeze#6872
Date: 2026-09-24
Status: approved 2026-09-24 (D1–D3 accepted); implemented in #6920 (API) and #6921 (agent)
Blast radius: agent-shipped code (Windows spawn path, helper manager) + API binary registration on hosted prod. Full rigor.

## 1. Summary

A Windows device with Breeze Assist enabled by policy but no helper binary on
disk relaunches a missing executable every 30 s, burns the watcher's five
retries, then logs an error once a minute forever. It never installs the
helper. Three defects stack:

| # | Layer | Defect | Status |
|---|---|---|---|
| A | agent `helper.Manager` | `Apply` and `ensureRunningSession` spawn even when `isInstalled()` is false | verified in code |
| B | agent `sessionbroker` | `SpawnProcessInSessionWithArgs` launches `cmd.exe /c start "" "<binary>"`, so a missing binary reports success with cmd.exe's PID | verified in code |
| C | API `binarySync` (local mode) | `component='helper'` rows are never registered, so hosted servers never send `helperUpgradeTo` and the bootstrap install never runs | **verified on US and EU prod** |

C is the reason the device stays broken. A and B are why it is noisy and
misleading while broken. All three are fixed here. The fix ships in one API
PR and one agent PR; the API side takes effect on the next hosted deploy, the
agent side on the next agent release.

## 2. Verified facts (2026-09-24)

Labels: **verified** = observed directly; **inferred** = consistent with the
evidence but not proven; **not checked** = left open.

**Prod state (verified, both regions, `BINARY_SOURCE=local`, `BINARY_EDITION=hosted`):**

| region | `agent_versions` components with `edition='hosted'` | `helper` rows |
|---|---|---|
| US | agent, backup, watchdog (11 versions each), user-helper (8) | **0** |
| EU | agent, backup, watchdog (55 each), user-helper (8) | **0** |

- `/data/binaries/helper/` on both droplets holds `breeze-helper-windows.msi`,
  `breeze-helper-macos.dmg`, `breeze-helper-linux.AppImage` for 0.116.0
  (verified). The files are there; the rows are not.
- The hosted `release-artifact-manifest.json` on the droplet does **not** list
  the three helper installers (verified). The public v0.116.0 manifest lists
  them with `edition: self-host` (verified). The hosted build lane
  (`build-hosted-release.yml`) does not build the Tauri helper at all
  (verified); the installers on the droplet come from the public release.
- `resolvePinnedUpgradeTarget` (`apps/api/src/routes/agents/helpers.ts:2660`)
  with `pin: null` returns null when no row matches
  `(platform, arch, component, is_latest=true, edition=getBinaryEdition())`.
  There is no other early return on that path. So with zero helper rows the
  heartbeat's bootstrap branch (`heartbeat.ts:1605-1611`) never sets
  `helperUpgradeTo`. Verified by code read.
- `syncBinaries` local mode (`binarySync.ts:1043-1049`) scans only
  `agent`, `user-helper`, `watchdog`, `backup` from `AGENT_BINARY_DIR`.
  `parseBinaryFilename` (`:267`) only accepts
  `breeze-{component}-{os}-{arch}[.exe]`, so the helper's `.msi/.dmg/.AppImage`
  names could never match even if the dir were scanned. `HELPER_BINARY_DIR`
  is never scanned. GitHub mode does register `helper` (`:1366`), but a hosted
  server refuses GitHub mode (`:186`). Verified.
- No code path deletes `agent_versions` rows (verified by grep; the only
  deletes are manual ops SQL).
- Agent wiring (verified): on Windows as a service, `helper.WithSpawnFunc`
  (`agent/internal/heartbeat/heartbeat.go:985-1016`) tries the user-helper
  launch first and falls back to `sessionbroker.SpawnProcessInSessionWithArgs`
  (`:1014`), which is the `cmd /c start` path
  (`agent/internal/sessionbroker/spawn_process_windows.go:42-86`).
  `install_windows.go:170 spawnWithConfig` (direct `CreateProcessAsUser` on
  the helper exe) is only reached via `defaultSpawnFunc`, i.e. when no spawn
  function is injected.
- `SpawnProcessInSessionWithArgs` has one other caller:
  `agent/internal/onedrivehelper/onedrivehelper_windows.go:418-420`, which
  ignores the returned error. Verified.
- The downgrade guard (`agent/internal/heartbeat/version_downgrade.go:57-67`)
  allows a bootstrap offer when the binary is missing and the installed
  version is empty (`fresh_install`). It would not have dropped an offer for
  the KIT device. Verified.

**Not established:** where the `helper update pending` for 0.111.1 on
2026-09-09 came from. Current code cannot create a hosted helper row, and no
code deletes rows. Candidates: rows registered by hand during an earlier
release and removed by the #5704 self-host row cleanup on 09-22 (732 rows on
US), or a row inserted under a different edition. It does not change the fix.
The ops step in §6 verifies the rows exist after deploy, which is what matters.

**Not checked:** why the KIT device's `breeze-helper.exe` is gone with only
`breeze-helper.exe.backup` (mtime 2026-04-09) left. A failed in-place update
that renamed the old binary and never wrote the new one fits (#6252 territory),
but no log proves it. Out of scope here; §8 files it.

## 3. Root causes

### A. Manager spawns a helper that is not installed

`Apply` (`agent/internal/helper/manager.go:313-330`): when
`settings.Enabled && !isInstalled()` and `pendingHelperVersion == ""`, it logs
at Debug ("deferring install") and **falls through** into the per-session loop,
which calls `ensureRunningSession` for every active session. Nothing between
the deferral and the spawn checks the binary exists.

`ensureRunningSession` (`:557-594`) checks "is it running", then
`watcherGaveUp`, then spawns. No install check.

`watcher.run` (`watcher.go:33-96`) counts each not-running tick as a failure
and calls `ensureRunningSession` up to `watcherMaxRetries` (5) with
exponential backoff, then sets `watcherGaveUp`. After that every heartbeat's
`ensureRunningSession` returns "helper keeps crashing, not respawning until
next update", which `Apply` logs at **Error** (`:387`) once a minute.

### B. `cmd /c start` hides a missing binary

`SpawnProcessInSessionWithArgs` builds
`"C:\Windows\System32\cmd.exe" /c start "" "<binary>" [args]` and
`CreateProcessAsUser`s cmd.exe. cmd.exe always exists, so the call succeeds,
the log says `spawned process in session pid=<cmd.exe pid>`, and the watcher
logs `breeze assist restarted by watcher`. The missing file surfaces only as
the helper "crashing" 30 s later. `start` on a missing path is what produces
the repeated "Windows cannot find…" dialog the user sees (inferred).

### C. Hosted servers never register `helper` rows

See §2. Consequence: on hosted prod, **no device** with Assist enabled and no
helper installed can ever bootstrap, on any OS, since the hosted droplets went
`BINARY_SOURCE=local`. Devices that already had a helper keep it; nothing
upgrades it either. This is an outage of the Assist install/upgrade lane, not
a KIT-only problem.

## 4. Design

### 4.1 API: register `helper` in local mode (fixes C)

Mirror the #4682 user-helper registration (`binarySync.ts:1105-1154`) for the
`helper` component, with the filename mapping the helper actually uses.

- **Scan `HELPER_BINARY_DIR`** (default `./agent/bin`, prod
  `/data/binaries/helper`) for the `HELPER_TARGETS` asset names (`:201-206`):

  | file | platform | arch |
  |---|---|---|
  | `breeze-helper-windows.msi` | windows | amd64 |
  | `breeze-helper-macos.dmg` | macos | amd64 **and** arm64 (one file, two rows, same as GitHub mode) |
  | `breeze-helper-linux.AppImage` | linux | amd64 |

  Add a `scanHelperInstallerDir()` next to `scanBinaryDir` that returns
  `BinaryInfo[]` from that table instead of `parseBinaryFilename`. Do not
  widen `parseBinaryFilename`; its regex is load-bearing for the other four
  components.
- **Two-tier registration, same as user-helper:** `registerFromOfficialManifest`
  first (covers a future hosted manifest that lists the installers, and
  self-host deploys where the public manifest does list them), then
  `registerLocalBinaries` (per-deployment re-signing) for files the manifest
  does not cover, excluding files the manifest refused. `downloadUrlFor` is
  `${serverUrl}/api/v1/agents/download/helper/${os}/${arch}`, which is the
  route `registerComponentDownloadRoute` already serves from
  `HELPER_BINARY_DIR` (`download.ts:414-425`), and the same URL shape
  `/agent-versions/:v/download?component=helper` hands back
  (`agentVersions.ts:513`).
- **Per-component isolation:** own `try/catch`, own log lines
  (`[binarySync] Registered N helper installers …` /
  `[binarySync] Failed to register local helper installers — Breeze Assist
  install/upgrade unavailable: …`). A helper failure must not block the agent
  row, and vice versa.
- **No files present:** one `console.warn` like the watchdog/backup ones
  (`:1208`, `:1236`), not an error.
- **Lockstep check (#3499):** the version offered by
  `resolvePinnedUpgradeTarget` must be the version whose bytes
  `/download/helper/:os/:arch` serves. In local mode that route serves
  whatever is on disk, and the row's checksum is computed from that same file
  at sync time, so they agree by construction. The plan must add a test that
  registers from a temp dir and asserts the row checksum equals the file's
  sha256.
- **`ensureCurrentVersionRegistered`** (`:1526`) is left alone. It backfills
  agent+backup for the running version; extending it to helper is a separate
  change and the boot-time sync already covers the deploy case.

Hosted today: the hosted manifest does not cover the installers, so the
re-signing tier registers them. That is the same trust level the agent row
gets for any uncovered file on that server, and the MSI/DMG carry their own
Authenticode/notarization signatures on top. Long-term the hosted lane should
copy the public helper installers **into its manifest** so the official tier
covers them; that is a follow-up in the private hosted-release repo (§8),
not a blocker.

### 4.2 Agent: never spawn what is not installed (fixes A)

New sentinel in `agent/internal/helper`:

```go
// ErrNotInstalled: Assist is enabled by policy but the helper binary is not
// on disk. Callers must not spawn, must not count it as a crash, and must
// not log it as an error on every heartbeat.
var ErrNotInstalled = errors.New("breeze assist is not installed")
```

- `ensureRunningSession`: after the "already running" checks and before
  `watcherGaveUp`, `if !m.isInstalled() { return ErrNotInstalled }`. Placing it
  before the `watcherGaveUp` check means a device that hit the old give-up
  state recovers the moment the binary appears (install sets state anyway).
- `Apply`: in the `settings.Enabled && !m.isInstalled()` block, when there is
  no pending version, log at **Warn once per state transition** (a
  `notInstalledWarned bool` on the manager, reset when `isInstalled()` turns
  true or when the policy turns off):
  `breeze assist enabled but not installed; waiting for the server to offer a
  helper version`. Then `return` — do not enter the per-session loop. There
  is nothing to configure, spawn, or watch. Stop any running session watchers
  first (`stopSessionWatcher` for each `m.sessions` entry) so a watcher from
  a previous installed state cannot keep spawning. On the install-failed
  branch the existing `return` already stops the loop.
- `Apply` per-session branch (`:386-390`): if `ensureRunningSession` returns
  `ErrNotInstalled`, log at Debug and `continue` (belt and braces: the early
  return above already covers it, this keeps the invariant local).
- `watcher.run`: if `ensureRunningSession` returns `ErrNotInstalled`, log at
  Debug and `return` without incrementing `failures` or setting
  `watcherGaveUp`. `Apply` restarts a watcher on the next heartbeat once the
  helper is installed.
- `CheckUpdate` / `downloadAndInstall` are unchanged. A successful install
  makes `isInstalled()` true and the next `Apply` proceeds as today.

### 4.3 Agent: fail the spawn when the binary is missing (fixes B)

`SpawnProcessInSessionWithArgs` (`spawn_process_windows.go`): before
`acquireUserToken`, `os.Stat(binaryPath)`; on `os.IsNotExist`, return a
wrapped `ErrBinaryMissing` (`fmt.Errorf("%w: %s", ErrBinaryMissing,
binaryPath)`) and log nothing (the caller decides). Any other stat error is
returned wrapped too. Keep `cmd /c start` for the launch itself.

Why not launch directly like `spawnWithConfig`: the direct path returns the
real helper PID and avoids cmd.exe entirely, which is better, but it changes
behaviour for the OneDrive helper caller as well and interacts with the
user-helper first-try in the `WithSpawnFunc` closure. It is the right
follow-up (§8), not part of a loop fix that needs an agent release soon.

The stat is a TOCTOU-free improvement, not a guarantee: a binary removed
between stat and launch still behaves as today. That is acceptable; the
manager-level check in 4.2 is the real gate.

### 4.4 Logging contract after the fix

| condition | before | after |
|---|---|---|
| enabled, not installed, no server offer | Debug "deferring install" + 5× Info "restarted by watcher" + Error "keeps crashing" + Error every heartbeat | one Warn per transition, nothing else |
| enabled, not installed, server offer arrives | as today | as today ("helper update pending" → install → spawn) |
| installed, binary vanishes mid-run | watcher burns 5 retries, then Error every heartbeat | watcher exits on `ErrNotInstalled`, one Warn, waits for server |
| spawn target missing at OS level | Info "spawned process … pid=<cmd.exe>" | error `ErrBinaryMissing` from the spawn function |

## 5. Tests

**Go, `agent/internal/helper` (`manager_test.go`, mock pattern at `:199-214`):**
- `TestApplyEnabledNotInstalledNoPendingDoesNotSpawn`: no binary at
  `mgr.binaryPath`, `Enabled`, `pendingHelperVersion==""`, one active session
  → `spawnFunc` never called, no session watcher started, one Warn logged;
  second `Apply` logs no second Warn.
- `TestApplyNotInstalledStopsExistingWatcher`: start with binary + watcher,
  remove binary, `Apply` → watcher stopped, `spawnFunc` not called again.
- `TestEnsureRunningSessionReturnsErrNotInstalled`: `errors.Is(err,
  ErrNotInstalled)`; `watcherGaveUp=true` beforehand still yields
  `ErrNotInstalled` (recovery ordering).
- `TestWatcherExitsOnNotInstalled` (new, first direct watcher test): watcher
  with missing binary exits within one tick, `failures` not incremented,
  `watcherGaveUp` stays false.
- Existing `TestApplyEnabledInstallUsesPendingVersion` must still pass
  unchanged (install path).

**Go, `agent/internal/sessionbroker` (`//go:build windows`):**
- `TestSpawnProcessInSessionWithArgsMissingBinary`: nonexistent path →
  `errors.Is(err, ErrBinaryMissing)` and no token acquisition (inject or
  assert before the token call). Runs natively on the Windows lab VM; the
  cross-compile-only run has missed a test bug before (W06a lesson).

**API, `apps/api/src/services/binarySync.test.ts` (or a new
`binarySync.helper.test.ts` alongside):**
- Local mode, temp `HELPER_BINARY_DIR` with the three installer files, no
  manifest → three targets registered via `registerLocalBinaries` with
  `component='helper'`, four rows (dmg → two arches), download URL
  `/api/v1/agents/download/helper/<os>/<arch>`, `edition=getBinaryEdition()`,
  checksum equals the file's sha256.
- Manifest covers `breeze-helper-windows.msi` only → msi via manifest tier,
  dmg/AppImage via re-signing tier, refused asset excluded from both.
- Empty dir → one warn, no throw, agent rows unaffected.
- `resolvePinnedUpgradeTarget({component:'helper', pin:null})` returns the
  registered version for `windows/amd64` (integration, real DB).

**Lab (mandatory before merge of the agent PR):** on the Windows VM (.55),
`make dev-push` a build with the helper binary deleted and Assist enabled;
expect one Warn and no spawn; then register helper rows on the lab API and
expect the bootstrap install to run and Assist to start. Run
`go test -race ./internal/helper/... ./internal/sessionbroker/...` natively.

## 6. Rollout and ops

1. Merge the API PR. Deploy hosted (EU+US) per the CLAUDE.md deploy line. The
   API's boot-time `syncBinaries` registers the helper rows for the deployed
   version from `/data/binaries/helper`.
2. Verify on each droplet:
   ```sql
   select version,platform,architecture,is_latest,edition
   from agent_versions where component='helper' order by created_at desc;
   ```
   Expect four rows for the deployed version, `is_latest=true`,
   `edition='hosted'`. Then `curl -sI https://<region>.2breeze.app/api/v1/agents/download/helper/windows/amd64` → 200.
3. Watch the KIT device: next heartbeat should log `helper update pending`,
   then `downloading helper package (verified)`, `helper installed`, and a
   real spawn. Until the agent PR ships, the old give-up state on KIT clears
   on the next agent restart or on the install itself
   (`applyPendingUpdate` resets session state).
4. Merge the agent PR; ships in the next agent release. Add
   `component='helper'` to the release skill's post-promote verification
   query so "15 slots" is actually checked on hosted, not assumed.
5. The release skill's promote SQL already flips all components including
   helper; no change.

## 7. Decisions for Todd

- **D1 — helper rows on hosted via per-deployment re-signing now, hosted
  manifest coverage as a follow-up.** Alternative: block registration until
  the hosted manifest lists the installers. Recommend the fallback: it is the
  same trust tier the agent binary already gets for uncovered files on that
  server, the installers are Authenticode/notarized, and blocking leaves the
  Assist lane down for another release cycle.
- **D2 — `Apply` returns early when enabled-but-not-installed** (writes no
  per-session config, starts no watcher). Alternative: keep writing config so
  the first spawn after install is faster. Recommend early return: config is
  written on the first post-install `Apply` anyway, and skipping the loop is
  what makes "not installed" a quiet state.
- **D3 — keep `cmd /c start`, add the stat check.** Direct launch is a
  follow-up (§8). Recommend as written.

## 8. Follow-ups (file as issues, not in these PRs)

- Hosted-release lane: include the public helper installers in the hosted
  `release-artifact-manifest.json` so the official tier covers them.
- `SpawnProcessInSessionWithArgs`: launch the target directly (real PID, no
  cmd.exe), aligning with `install_windows.go:spawnWithConfig`; audit the
  OneDrive helper caller.
- Why KIT's `breeze-helper.exe` disappeared leaving only `.backup` (probable
  failed in-place update; relate to #6252).
- Surface "Assist enabled but not installed, no server offer" in the device
  page / fleet health instead of only in agent.log.
- Origin of the 2026-09-09 helper 0.111.1 offer on US (row provenance).

## 9. Out of scope

- Helper single-instance mutex (#6870).
- Changing the bootstrap policy gate (bootstrap stays exempt from the org
  update policy, as today).
- macOS/Linux helper spawn paths (they do not use the Windows session broker;
  4.2 covers them through the manager).
