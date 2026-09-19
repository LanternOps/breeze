# Disk Cleanup (winapp2.ini-driven) — Design Spec

**Date:** 2026-06-15
**Status:** Approved design, pending implementation plan
**Scope (v1):** On-demand, single-device, Windows-only junk/cache cleaner driven by a Breeze-vetted `winapp2.ini` ruleset. Preview-then-confirm. Files **and** registry, with a registry-backup safety net.

## Summary

Breeze gains a "Disk Cleanup" remote tool: a tech opens a Windows device, scans for junk/cache files (and registry junk), reviews a per-category preview of what would be reclaimed, selects categories, and confirms deletion. The engine interprets the `winapp2.ini` format — a long-standing, community-maintained declarative database describing what is safe to delete for thousands of Windows applications — the same format used by CCleaner, BleachBit, and FluentCleaner.

This is the conceptual port of FluentCleaner's interpreter into the Breeze Go agent, hardened for the "someone else's machine, at fleet scale" reality: vetted central ruleset, always-preview, registry backup, locked-file safety, and a code-level denylist that no rule can override.

### Explicitly out of scope for v1 (but designed not to preclude)

- **Fleet fan-out** (run across many devices with aggregate reporting) — later surface on the same engine.
- **Policy-driven / scheduled cleanup** — later surface, plugs into the Configuration Policy system like patch jobs.
- **App uninstall + leftover removal** (Revo Uninstaller's everyday mode) — adjacent feature that reuses the same delete+backup engine; build as a fast follow.
- **Install monitoring / full undo** (Revo Pro's real-time install tracker) — a genuinely separate, heavyweight feature requiring a persistent filesystem/registry watcher in the agent. Not an add-on to this engine; own spec if ever.
- **macOS/Linux cleanup** — winapp2.ini is Windows-only (Windows paths + registry). Other platforms simply don't expose the tool in v1.
- **Custom/partner-supplied rulesets** — v1 runs only the Breeze-vetted, version-pinned ruleset.

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Platform | Windows-only | winapp2.ini maps 1:1 to Windows; agent already has Windows-specific subsystems (WUA patching, DXGI desktop). |
| Registry scope | Files **and** registry (FileKey + RegKey) | More complete cleanup; mitigated by mandatory registry backup + denylist. |
| Ruleset trust | API-served, Breeze-vetted, version-pinned | Central control, push rule fixes without an agent release, single source of trust, matches signed-release posture. |
| v1 surface | On-demand, preview-then-confirm, single device | Safest way to earn trust in a destructive feature; mirrors existing terminal/desktop remote tools. |
| Spec width | Junk cleaning only | Keep v1 tight; design engine with seams for uninstall-leftover (#2) later. |

## Architecture

Reuses Breeze's existing **request/response command** plumbing (the path discovery uses) — no new transport, no new BullMQ job for v1 (single device, interactive).

### Agent (Go) — `agent/internal/diskcleanup/`

Two command types registered in the handler registry (`agent/internal/heartbeat/handlers.go`; consts in `agent/internal/remote/tools/types.go`):

- **`disk_cleanup_scan`** — *read-only*. Loads the ruleset, enumerates matching files + registry keys, returns a per-category preview (counts + bytes, sampled paths, registry-key counts). **Deletes nothing.**
- **`disk_cleanup_apply`** — given approved category IDs + a `scanToken` from a prior scan, deletes the matched items, writing the registry `.reg` backup first. Returns actual bytes/count freed, skipped (locked) items, and the backup path.

Engine files:

- `parser.go` — parse winapp2.ini into `Rule` objects `{Section, Detect/DetectFile/DetectOS, FileKeys[], RegKeys[], ExcludeKeys[]}`. Honors detection keys so only rules for installed software are offered.
- `pathexpand.go` — expand `%LocalAppData%`, `%AppData%`, `%WinDir%`, `%ProgramData%`, `%Temp%`, etc. via known-folder/env calls; fall back to `ExpandEnvironmentStrings`. Trailing-slash normalization (the FluentCleaner gotcha).
- `enumerate.go` — per FileKey: split patterns on `;`, glob via `filepath.Glob`/`WalkDir`, honor `RECURSE`/`REMOVESELF`. **Skip reparse points** (junctions/symlinks) — both loop-avoidance and a security control (prevents escaping the intended tree).
- `exclude.go` — apply ExcludeKey (FILE/PATH/REG flags): subtree blocks, glob, literal.
- `category.go` — group per-app winapp2 sections into a handful of user-facing categories ("Browser caches", "Windows temp & logs", "Thumbnail/icon cache", "Crash dumps", "App caches", …). Mapping lives in the vetted ruleset metadata so it is tunable server-side.
- `regbackup.go` — export affected registry keys to a timestamped `.reg` before deletion.
- `denylist.go` — hard-coded protected-root refusal (see Safety §4).

### API (Hono)

- `POST /devices/:id/commands` with `type: 'disk_cleanup_scan'` / `'disk_cleanup_apply'` — reuses the existing per-device command endpoint (`apps/api/src/routes/devices/commands.ts`) and `deviceCommands` row lifecycle (pending→sent→completed).
- Results return through `agentWs` → `processOrphanedCommandResult` (or a small typed handler), stored on `deviceCommands.result`.
- `GET /platform/winapp2` — **new**, no-auth, version-pinned. Serves the vetted ruleset + category metadata, mirroring the agent-binary/manifest distribution pattern (`apps/api/src/routes/agents/download.ts`). Includes a version string + content hash.
- `writeRouteAudit` on **apply**: `action: 'disk_cleanup.apply'`, `resourceType: 'device'`, details = categories + bytes freed + backup path. (Scan optionally audited.)

### Web (Astro/React)

- New **"Disk Cleanup"** tab in `apps/web/src/components/devices/DeviceDetails.tsx`, near the existing `filesystem` tab. **Windows devices only.**
- Component `DeviceDiskCleanupTab.tsx`. All POSTs wrapped in `runAction`; HTTP-200 `{success:false}`-style bodies surface as errors per the project's mutation-feedback contract.

## Data flow

```
[Tech clicks Scan]
  -> POST /devices/:id/commands {type: disk_cleanup_scan}
  -> deviceCommands row (pending) -> agent claims over WS
  -> agent: fetch/cache ruleset -> enumerate (no delete)
  -> command_result {categories:[{id,label,fileCount,bytes,sampledPaths,regKeyCount}], scanToken}
  -> result stored on deviceCommands.result -> UI renders checklist

[Tech selects categories + Confirm (with destructive-action acknowledgement)]
  -> POST /devices/:id/commands {type: disk_cleanup_apply, payload:{scanToken, categoryIds:[...]}}
  -> agent: re-resolve those categories -> write .reg backup -> delete files+regkeys (skip locked)
  -> command_result {freedBytes, freedCount, skipped:[...], regBackupPath}
  -> writeRouteAudit(apply) -> UI shows "Reclaimed 2.3 GB; 4 files in use skipped; registry backup at ..."
```

## Safety model

1. **Scan/apply split with a `scanToken`.** Apply re-resolves the *same approved categories* rather than re-deriving "what's junk." The token (hash of ruleset version + device + category set + timestamp) lets the agent/API reject a stale apply if the ruleset changed between scan and confirm.
2. **Registry backup before any RegKey delete.** `regbackup.go` exports affected keys to a timestamped `.reg` under the agent data dir (e.g. `…/breeze-agent/cleanup-backups/<runId>.reg`) *before* deletion; the path is returned in the result. This is the undo. Files are **not** backed up (junk by definition; backing up GBs of cache defeats the purpose) — only the registry, where a mistake is dangerous. Restorable via `reg import` / double-click.
3. **Locked-file safety.** Before deleting, probe deletability (Windows `CreateFileW` with `DELETE` access / `FILE_SHARE_DELETE`); if locked, **skip and report** rather than force. Never delete a file an app is actively using.
4. **Code-level denylist (defense-in-depth).** A built-in denylist in the agent refuses deletion inside protected roots (`%WinDir%\System32` core paths, user `Documents`/`Desktop`/`Pictures`, Program Files binaries, etc.) **even if a rule says to**. The vetted ruleset should never request these; the denylist guarantees a bad rule cannot brick a machine. This is code, not config — the last line of defense.
5. **Ruleset trust.** The agent runs only the API-served, version-pinned ruleset, integrity-checked on download (hash; signing with the manifest-signing key infra preferred). No arbitrary local winapp2.ini in v1.
6. **Always preview, never silent.** v1 has no auto/scheduled mode; a human always confirms the category list against real sizes before any deletion.

### Open choices resolved

- **Registry backup format:** flat `.reg` per run (boring, restorable, no custom tooling). Confirmed.
- **Denylist:** essential, code-level. Confirmed.

## Data model

**No new tables. No migrations. No new RLS-scoped tables.** (Called out explicitly so reviewers don't expect one.)

- Scan/apply results: transient on existing `deviceCommands.result` JSON.
- History/accountability: existing audit log (`disk_cleanup.apply`).
- The only new server-side asset is the vetted ruleset file + category metadata served from a directory (mirrors `AGENT_BINARY_DIR`), exposed at `GET /platform/winapp2`. Updating the ruleset = drop a new vetted version in the dir + bump the version; no agent release, no DB write.

## UI state machine (`DeviceDiskCleanupTab.tsx`)

```
Idle --Scan--> Scanning --> Preview --(select + Confirm + ack)--> Applying --> Result
```

- **Preview**: category checklist; each row = label + size + file count + "N registry keys"; expandable to show sampled paths.
- **Confirm**: explicit "this permanently deletes files" acknowledgement.
- **Result**: reclaimed bytes, skipped-locked list, "Registry backup saved at …".
- Tab hidden on non-Windows devices.

## Testing

### Agent (Go, `go test -race`)
- `parser_test.go` — table-driven: real winapp2.ini snippets → expected `Rule` structs; malformed lines; `Detect`/`DetectFile` gating.
- `pathexpand_test.go` — every `%VAR%` maps; trailing-slash normalization; unknown var falls through to env expansion.
- `enumerate_test.go` — temp fixture tree: glob, `;`-split, `RECURSE`/`REMOVESELF`, and **reparse-point skip** (create a junction, assert not followed).
- `exclude_test.go` — FILE/PATH/REG semantics; a file matched by FileKey but saved by ExcludeKey survives.
- `denylist_test.go` — **critical**: a hostile rule pointing at System32/Documents/Program Files is refused regardless of ruleset.
- `regbackup_test.go` — backup `.reg` written before delete and round-trips (export → delete → import restores).
- Locked-file probe — skip-not-force behavior (mock the deletability check).

### API (Vitest)
- `POST /devices/:id/commands` accepts both new types; payload validation (apply requires `scanToken` + `categoryIds`); stale-token rejection.
- `GET /platform/winapp2` serves with version/hash; integrity headers.
- `processOrphanedCommandResult` stores scan/apply results on `deviceCommands`.
- `writeRouteAudit` fires on apply with bytes + categories.

### Web (Vitest + jsdom)
- Tab renders only for Windows devices.
- State-machine transitions; checklist selection → apply payload; result rendering incl. skipped/backup.
- `runAction` surfaces a failed apply as an error toast (not a silent no-op).

## Build phasing

Each phase is independently shippable/verifiable; the dangerous part (deletion) does not exist until the safe part (enumeration + guardrails) is proven.

1. **Engine core** — parser + pathexpand + enumerate + exclude + denylist, all unit-tested, no side effects beyond a `--dry-run` CLI harness in the agent. The bulk and the risk; pure and fully testable in isolation.
2. **Scan command** — wire `disk_cleanup_scan` into the handler registry; read-only category preview. Ruleset fetch + cache + `GET /platform/winapp2`.
3. **Apply command** — `disk_cleanup_apply` with registry backup, locked-file skip, scanToken validation, audit.
4. **UI** — the tab + state machine on top of the working commands.

## Key references (existing patterns)

- Command dispatch / discovery flow: `apps/api/src/routes/discovery.ts`, `apps/api/src/services/commandDispatch.ts`, `apps/api/src/routes/agentWs.ts` (`processOrphanedCommandResult`, `commandResultSchema`).
- Per-device command endpoint: `apps/api/src/routes/devices/commands.ts`; web caller `apps/web/src/services/deviceActions.ts`.
- Agent handler registry / dispatch: `agent/internal/heartbeat/handlers.go`; command-type consts `agent/internal/remote/tools/types.go`; result struct `tools.CommandResult`.
- Agent feature references: `agent/internal/discovery`, `agent/internal/patching`.
- Device detail tabs: `apps/web/src/components/devices/DeviceDetails.tsx`.
- Audit: `apps/api/src/services/auditEvents.ts` (`writeRouteAudit`), `apps/api/src/services/auditService.ts`.
- Global asset distribution / signing: `apps/api/src/routes/agents/download.ts`, `apps/api/src/services/manifestSigning.ts`.
