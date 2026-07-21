# CLI install: auto-bootstrap the watchdog

**Issue:** [#407](https://github.com/lanternops/breeze/issues/407) — command-line install method does not install the watchdog service.

## Problem

Today, installation paths diverge:

| Path | Installs agent | Installs watchdog |
|---|---|---|
| Windows MSI | ✅ | ✅ (WiX `ServiceInstall`) |
| macOS PKG | ✅ | ✅ (postinstall loads `com.breeze.watchdog.plist`) |
| `breeze-agent service install` (CLI) | ✅ | ❌ |

The one-liner install commands shown in the Breeze dashboard (`AddDeviceModal.tsx`, `EnrollDeviceStep.tsx`) and in the docs (`apps/docs/src/content/docs/agents/installation.mdx`) use the CLI path on Windows and Linux. The docs at `installation.mdx:107-114` already claim manual install includes the watchdog — that claim is currently false.

CLI-installed devices therefore lack agent self-recovery (watchdog restarts the agent on crash / hang and drives watchdog-mediated upgrades). This is a reliability regression vs. MSI/PKG-installed devices.

## Goal

Make `breeze-agent service install` install the watchdog service as a side-effect, so that every install path produces the same end state (agent + watchdog, both running, both set to auto-start).

## Non-goals

- Embedding the watchdog binary inside the agent binary (doubles binary size, complicates upgrades).
- Changing how the MSI or PKG install the watchdog — those already work.
- Replacing the existing `breeze-watchdog service install` command — it remains the source of truth for service registration. The agent just calls it.
- Adding a new env var for the download base URL. We match the existing hardcoded pattern (`agent/internal/updater/pkg_darwin.go`); if that ever becomes configurable, both call sites migrate together.

## Design

### `breeze-agent service install` flow

After the existing agent service registration succeeds, run a best-effort watchdog bootstrap step:

1. **Locate watchdog binary.**
   - **Sibling lookup first.** Check for `breeze-watchdog[.exe]` in the directory containing the current agent executable (`os.Executable()` → `filepath.Dir`). If it exists and is executable, use that path. This covers MSI/PKG contexts, `make install` contexts, and any user who downloaded both binaries manually.
   - **Download fallback.** Otherwise, download the matching-version watchdog binary from GitHub releases to the same directory as the agent executable. URL pattern (matches `pkg_darwin.go`):
     ```
     https://github.com/LanternOps/breeze/releases/download/v<version>/breeze-watchdog-<goos>-<goarch>[.exe]
     ```
     `<version>` is the agent's compiled-in `main.version`. If `main.version` is empty or `"dev"`, skip the download (dev builds don't have a matching release) and warn.
   - On Unix, `chmod 0755` the downloaded file.

2. **Exec the watchdog's own installer.** Run `<watchdog-path> service install` as a child process, inheriting stdout/stderr. All SCM / systemd / launchd logic already lives in `agent/cmd/breeze-watchdog/service_cmd_{windows,linux,darwin}.go` — we don't duplicate it.

3. **Failure is non-fatal.** If any of the above fails (network error, 404, exec failure, watchdog install returned non-zero), log a clear warning to stderr explaining what failed and how to retry manually (`breeze-watchdog service install`). The agent install command itself still exits 0.

4. **Opt-out flag.** Add `--no-watchdog` on `breeze-agent service install` to skip steps 1-3 entirely. For air-gapped / explicit-opt-out scenarios.

### Download implementation

- Use `net/http` with a 60s timeout for the download.
- Stream to a temp file in the same directory, then atomic rename to final path. Avoids leaving partial binaries on disk.
- Verify the downloaded file is non-empty and >1MB (sanity check — the real watchdog is several MB; a 404 HTML body is small).
- No checksum verification in this change. GitHub serves over HTTPS; signature verification is a separate concern (tracked elsewhere — the agent updater has the same posture today).

### Re-run semantics

Running `breeze-agent service install` twice is already idempotent for the agent side (second call fails with "already exists" from SCM/systemd/launchd). The watchdog bootstrap step is likewise idempotent:
- Sibling lookup: finds existing binary, no download.
- Watchdog's own `service install`: errors cleanly if already installed, surfaced as a warning.

This means a user who ran the old one-liner and got an agent-only install can re-run `breeze-agent service install` to add the missing watchdog, without reinstalling the agent.

### Uninstall

Out of scope for this change. `breeze-agent service uninstall` today removes only the agent service. We should mirror the install symmetry (also uninstall the watchdog), but it's a separate, safer-as-its-own-change edit. File follow-up if needed.

## Files changed

1. **`agent/cmd/breeze-agent/service_cmd_windows.go`** — add watchdog bootstrap after the agent `CreateService` succeeds; add `--no-watchdog` flag.
2. **`agent/cmd/breeze-agent/service_cmd_linux.go`** — same.
3. **`agent/cmd/breeze-agent/service_cmd_darwin.go`** — same. (macOS PKG already handles watchdog; this path is only hit by users running the binary directly.)
4. **`agent/cmd/breeze-agent/watchdog_bootstrap.go`** (new, build-tagged or plain) — shared logic: `locateOrDownloadWatchdog`, `installWatchdog`. Platform-specific bits (binary extension, chmod) handled via `runtime.GOOS` + small helpers.
5. **`agent/cmd/breeze-agent/watchdog_bootstrap_test.go`** (new) — unit tests for URL construction, sibling-lookup precedence, download-error paths (using `httptest.Server`), `--no-watchdog` opt-out.
6. **`apps/docs/src/content/docs/agents/installation.mdx`** — the claim at lines 107-114 becomes true; no edit needed to the claim itself, but add a note that re-running `service install` repairs a missing watchdog. Optionally add the `--no-watchdog` flag to a troubleshooting section.

The UI command templates in `AddDeviceModal.tsx` and `EnrollDeviceStep.tsx` do **not** need changes — the existing `breeze-agent.exe service install` / `sudo breeze-agent service install` step now implicitly installs the watchdog.

## Testing

### Unit tests (`watchdog_bootstrap_test.go`)

- URL construction: given `version=0.62.24`, `goos=windows`, `goarch=amd64` → expected URL.
- Sibling lookup: tmpdir with a fake `breeze-watchdog[.exe]` next to a fake agent binary → returns sibling path, no HTTP.
- Download path: `httptest.Server` serving a fake binary → file is written next to agent path, mode 0755 on unix.
- Download failure: 404 → returns error with actionable message; agent install does not abort.
- Dev version (`main.version == "" || "dev"`) → skips download with a warning.
- `--no-watchdog` flag: bootstrap is not called.

### Manual smoke

Order of verification:
1. **Windows VM** (Tailscale `100.101.150.55`, per memory) — run the dashboard one-liner; confirm `sc query BreezeWatchdog` shows RUNNING and `sc query BreezeAgent` shows RUNNING.
2. **Linux** (Docker container or local VM) — run the Linux one-liner; confirm `systemctl status breeze-agent breeze-watchdog` both active.
3. **macOS** manual binary path — run `./breeze-agent service install`; confirm both LaunchDaemons loaded.
4. **Re-run repair** — on a machine with agent-only install (simulate by uninstalling watchdog), re-run `breeze-agent service install`; confirm watchdog is now present without reinstalling the agent.
5. **Air-gapped** — run with `--no-watchdog`; confirm only the agent is installed and no network call was attempted (verify via `strace`/Process Monitor or by running on a host with no route to github.com and seeing no delay).

No CI changes required — Go tests are picked up automatically per the repo convention.

## Risks

- **Network dependency at install time.** Mitigated by sibling lookup (covers MSI/PKG), non-fatal failure, `--no-watchdog`, and clear warning text pointing at the manual-retry command.
- **Version mismatch.** The agent downloads the watchdog at its own `main.version` (tag `v<version>`). If that tag doesn't exist (e.g. someone runs a locally-built agent without a matching release), the download 404s and we fall through to the warning. Dev builds are explicitly skipped.
- **Silent drift from `pkg_darwin.go`.** Both files hardcode the same `https://github.com/LanternOps/breeze/releases/download/v<version>/...` base. Adding a code comment in each referencing the other, so anyone changing one remembers to change both. If this base needs to change three or more times, extract to a shared helper — YAGNI until then.

## Rollout

Single PR, merges to `main`, ships in the next agent release. No migration needed — existing deployments keep their current watchdog state (present if MSI/PKG, absent if CLI-installed). CLI-installed devices can be repaired by re-running `breeze-agent service install` at the admin's convenience, or will pick up the watchdog on the next agent reinstall / upgrade.
