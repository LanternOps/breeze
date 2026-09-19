# Linux Distribution Support Expansion (Arch + Omarchy) — Design

**Date:** 2026-09-10
**Status:** Draft spec — pending Todd's review
**Origin:** Omarchy fleet-opportunity research (memory `omarchy_fleet_opportunity_research_2026_09_09.md`, treated as verified input) + agent gap audit in worktree `omarchy-discovery`
**Related:** `docs/superpowers/specs/remote-desktop/2026-07-16-linux-remote-desktop-design.md` (Phase 2 = Wayland; dependency only, out of scope here); docs support matrix already merged in PR #5476 (not re-derived)

## Problem

Breeze silently degrades on Arch-family hosts. The software collector only knows dpkg and rpm (`agent/internal/collectors/software_linux.go:43-46`) and, when neither binary exists, reports both as `source_unavailable` (`:60-65`) — an Arch box shows an empty inventory with a failure badge. The Linux patch manager registers apt/dnf/yum only (`agent/internal/patching/defaults_linux.go:15-22`), so `ProviderIDs()` is empty and the heartbeat falls back to the legacy collector (`heartbeat.go:3133-3180`), which also knows only apt/yum (`collectors/patches_linux.go:12-28`) — zero pending patches, ever. Vulnerability correlation has no Linux package path at all: software matching is MSRC/CPE (`apps/api/src/services/vulnerabilityCorrelation.ts:356, 361-403`) and the OS pass is macOS-only (`:596-604`). Meanwhile Omarchy (Arch + Hyprland, "agentic Linux") is the fastest-growing Linux desktop — 250k ISO downloads in three weeks of 4.0, 37signals standard-issue — and the only fleet tooling is Fleet's vitals/scripts/software basics. An MSP enrolling one Omarchy laptop today sees an agent that is online, runs scripts, and knows nothing about what is installed or unpatched.

## Goals / Non-goals

**Goals**
- Shared distro-family detection (os-release `ID`/`ID_LIKE`) with explicit Omarchy detection, used by inventory, patching, and posture.
- `pacman` software inventory with a foreign/AUR distinction.
- Arch patch providers: `pacman` on plain Arch; `omarchy` (wrapping `omarchy update`) on Omarchy hosts, snapshot-first semantics preserved; kernel-aware reboot detection.
- Arch Security Tracker as a global advisory source feeding the existing vulnerability pipeline, with Arch `vercmp` semantics.
- Omarchy posture facts on the existing security-status surface.
- Zero-touch enrollment recipe (docs), Arch container CI, "Managing Omarchy with Breeze" docs page.
- Optional: Breeze Quickshell bar plugin.

**Non-goals**
- Wayland remote desktop — `2026-07-16` spec Phase 2 (portal/PipeWire helper). Omarchy remote desktop stays "not supported" until that ships; `remote/desktop/x11/resolve_linux.go:63-79` only reports Wayland sockets, it cannot attach.
- OS-level SSO login; Alpine/OpenRC (no systemd unit path); AUR package *patching* (inventory only); patronage/co-marketing.
- Automated snapshot rollback (Omarchy's boot menu owns that; Breeze documents it).

## Design

### a. Distro-family detection

Today os-release is parsed three times with three shapes: `collectors/classify_linux.go:24-55` (`readOsRelease`, full map, private), `backup/systemstate/state_linux.go:241-252` (PRETTY_NAME only), and `backup/bmr/validate.go:115` (path only). Promote one parser into a new package `agent/internal/linuxdistro`:

```go
// linuxdistro/distro.go (untagged: parser + family table test on any OS)
type Family string // "debian" | "rhel" | "arch" | "suse" | "alpine" | "unknown"
type Info struct {
    ID, VersionID, PrettyName string
    IDLike   []string
    Family   Family
    Omarchy  *OmarchyInfo // nil unless detected
}
type OmarchyInfo struct{ Version, Channel string }
func ParseOsRelease(r io.Reader) map[string]string          // same size/scanner limits as classify_linux.go
func FamilyOf(id string, idLike []string) Family             // ID first, then ID_LIKE tokens left→right
// linuxdistro/detect_linux.go (//go:build linux)
func Detect() Info                                            // cached, 1h TTL (omarchy update can change version/channel)
func detectOmarchy(lookPath, stat, run) *OmarchyInfo         // injected for tests
```

`FamilyOf` maps `arch|manjaro|endeavouros|cachyos|omarchy → arch`, `debian|ubuntu|linuxmint|pop → debian`, `rhel|fedora|centos|rocky|almalinux → rhel`, `opensuse*|sles → suse`, `alpine → alpine`; unmatched `ID` falls through to `ID_LIKE`. `collectors.readOsRelease` becomes a one-line wrapper so `detectLinuxServer` (`classify_linux.go:70-94`) is unchanged.

**Omarchy signals, in priority order.** (1) `omarchy` CLI resolvable via `exec.LookPath` — since 4.0 Omarchy ships as packages, so the CLI is system-wide (exact path unverified; expected `/usr/bin/omarchy`). (2) `/usr/share/omarchy` present (packaged layout; unverified). (3) os-release `ID=omarchy` or `NAME` containing "Omarchy" — corroboration only; whether Omarchy rewrites os-release is unverified. Either of (1)/(2) ⇒ detected; the pre-4.0 per-user layout under `~/.local/share/omarchy` is deliberately **not** a signal (a root service must not depend on a home directory). `Version` from `pacman -Q omarchy` (package name unverified), `Channel` from `omarchy-channel-set`'s persisted state (read mechanism unverified — confirm on the VM; report `""` when unknown).

**Server-side family.** The API needs to know a device is Arch (correlation, UI badge). `devices.os_version` is gopsutil `Platform + " " + PlatformVersion` (`collectors/hardware.go:127-128`) — "arch " with no version — too weak to key on. Add two nullable columns `devices.os_distro_id varchar(32)`, `devices.os_distro_family varchar(16)` reported in the heartbeat from `linuxdistro.Info`. `devices` is already in every cascade list, so the only registration that fires is the **column** rule: both classified `included` in `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) in the same PR. Idempotent `ADD COLUMN IF NOT EXISTS`, no RLS change. (Rejected: heuristics on `os_version`.)

**Tests.** Table-driven `ParseOsRelease`/`FamilyOf` with fixtures: Arch (`ID=arch`, no VERSION_ID), Omarchy (captured from the VM — unverified until then), Manjaro (`ID_LIKE=arch`), Ubuntu, Rocky (`ID_LIKE="rhel centos fedora"`), openSUSE, Alpine. `detectOmarchy` with fake lookPath/stat.

### b. Software inventory (`pacman`)

Add two sources to `collectors/software.go:16-21`:

```go
SoftwareSourceLinuxPacman        = "linux:pacman"          // native (repo) packages
SoftwareSourceLinuxPacmanForeign = "linux:pacman-foreign"  // pacman -Qm: AUR / manually built
```

`software_linux.go` candidate list gains `{SoftwareSourceLinuxPacman, "pacman", collectFromPacman}`; the collector runs **one** `LC_ALL=C pacman -Qi` (all installed, block format: `Name`, `Version`, `Packager`, `Install Date`, `Installed Size`) and one `pacman -Qm` (foreign names, `name version` per line), then splits items into the two `softwareSourceResult`s so foreign/AUR is encoded in the source identity — no `SoftwareItem` field change. `Vendor` = `Packager` with the `<email>` stripped exactly as dpkg's Maintainer is (`software_linux.go:99-105`); AUR builds usually report `Unknown Packager`, mapped to `"AUR/foreign"`. `InstallDate` from `Install Date` (`LC_ALL=C` makes the format stable: `Thu Aug 14 10:22:31 2026`). The empty-machine fallback at `:60-65` becomes family-aware: emit `source_unavailable` only for the sources the detected family *expects* (arch → the two pacman sources), so a healthy Arch box no longer shows dpkg/rpm failures.

**Server/UI impact: none required.** Source identifiers are free-form strings in `software_inventory_observations.expected_sources/succeeded_sources/failed_sources` (`db/schema/software.ts:148-150`); a repo-wide grep for `linux:dpkg-query` outside the agent returns zero hits (verified), so nothing validates or labels them. Confirm at implementation time that no per-item `source` column exists on `software_inventory` (unverified); if it does not, the foreign split is visible only at observation level, which is acceptable for W01.

**Tests.** `software_linux_test.go` (linux-tagged) + an untagged parser test with fixtures `pacman -Qi` (≥3 blocks incl. a multi-line `Description` and `Unknown Packager`), `pacman -Qm` (two foreign names, one absent from -Qi to prove the join is defensive), and the family-aware fallback matrix.

### c. Patch providers (`pacman`, `omarchy`)

Both implement `PatchProvider` (`patching/types.go:57-65`) following `apt.go`'s shape. `defaults_linux.go` becomes family-first:

```go
info := linuxdistro.Detect()
switch info.Family {
case linuxdistro.FamilyArch:
    if info.Omarchy != nil { providers = append(providers, NewOmarchyProvider(info.Omarchy)) }
    else if lookPath("pacman") { providers = append(providers, NewPacmanProvider()) }
}
// existing apt / dnf / yum LookPath registration unchanged (unknown families keep today's behaviour)
```

**Mutual exclusion:** on Omarchy hosts only `omarchy` registers. `pacman -Syu` is blocked by Omarchy's ALPM guard, so a `PacmanProvider.Install` would fail on every job; instead `OmarchyProvider` *embeds* `PacmanProvider` for `Scan`/`GetInstalled`/`Uninstall` and overrides `Install`. Ordering is otherwise irrelevant: `DefaultProviderID()` (`manager.go:272`) is the single Linux provider either way.

| Method | `PacmanProvider` (`ID()="pacman"`) | `OmarchyProvider` (`ID()="omarchy"`) |
|---|---|---|
| `Scan` | `checkupdates` (pacman-contrib; exit 2 = none, 0 = list `name old -> new`); fallback `pacman -Qu` when absent (stale-db caveat logged). Kernel packages (`linux`, `linux-lts`, `linux-zen`, `linux-hardened`) ⇒ `RebootRequired=true`, `Category="system"`; `Severity="unknown"` (server enriches, §d). | same, plus `Description` = `"channel: <stable\|rc\|edge\|dev>"` |
| `Install(pkg)` | `pacman -Syu --noconfirm` — **full upgrade, never per-package.** Arch does not support partial upgrades; `remote/tools/software_update.go:245-249` already excludes pacman from pinned upgrades for this reason. A 10-minute memo makes repeated `Install` calls within one job verify `pacman -Q <pkg>` instead of re-upgrading. | `omarchy update <non-interactive flags>` with `TERM=dumb`, no TTY, `patchMutateTimeout`. Snapshot → migrations → upgrade is Omarchy's own sequence; Breeze adds nothing before it. Flags come from upstream PR #11018 ("scripted updates: modes and policy flags", 2026-09-09) — **exact flag names must be confirmed at implementation time**. Non-zero exit with interactive-required output → `ErrPreflightFailed{Check:"omarchy_noninteractive"}` (`patching/errors.go:16-19`). |
| `Uninstall(pkg)` | `pacman -R --noconfirm <pkg>` (mirrors `remote/tools/software.go:292`) | inherited |
| `GetInstalled` | `pacman -Q` → `name version` | inherited |

Package names validated with `^[a-z0-9][a-z0-9@._+-]{0,254}$` (Arch naming rules) before any exec, mirroring `validateAptPackageName`.

**Who runs `omarchy update`?** Unverified and load-bearing: Omarchy's migrations edit the *user's* config, so running as root from the systemd service may migrate root's home instead. If PR #11018 does not settle this, the provider must execute as the primary desktop user through the existing `runAs=user` helper path (the machinery the cancel spec documents at `userhelper/client.go:712`), where sudo prompts intersect Omarchy's optional passwordless-sudo window. Resolve on the VM before W02 is planned in detail.

**Heartbeat wiring.** `mapPatchProviderSource` (`heartbeat.go:3419-3436`) maps only `apt`,`yum` → `linux`; add `pacman`,`omarchy` or they bucket as `custom` and are never swept. Same for `mapPatchProviderCategory` (`:3438`). Server enum already contains `linux` (`routes/agents/schemas.ts:779`) — no API change. The legacy `collectors/patches_linux.go` path is bypassed once a provider registers; leave it alone.

**Reboot detection.** Extend `reboot_detect_unix.go:44-57` with a third injected dependency `kernelStale func() (stale bool, reason string, ok bool)`: stale when `/usr/lib/modules/<uname -r>` no longer exists (Arch removes the old modules directory on kernel upgrade — the standard Arch heuristic, distro-agnostic and exec-free via `unix.Uname`). The `reason` also carries `pacman -Q <kernel-pkg>` vs running version when they differ. Cached with the existing `nrCache` TTL pattern (`:19-39`). Note `reboot_prompt_desktop_linux.go:34,56-58`: without `zenity` (GTK, likely absent on Hyprland) the reboot prompt degrades to `notify-send`, which mako on Omarchy renders — document, do not fix here.

**Tests.** Table-driven, fixtures: `checkupdates` (three lines incl. `linux 6.16.4.arch1-1 -> 6.16.5.arch1-1`), empty/exit-2, `pacman -Q`, `pacman -Qi`, and a fake runner asserting `omarchy update` is invoked with the confirmed flags and `pacman -Syu` is never invoked on Omarchy; `detectPendingRebootLinux` with a fake stat for the modules directory.

### d. Vulnerability correlation (Arch Security Tracker)

**Storage — recommend a global table, not memory.** The pipeline already owns five global, org-less tables (`vulnerabilities`, `vulnerability_sources`, `software_products`, `software_vulnerabilities`, `os_vulnerabilities`) listed in `INTENTIONAL_UNSCOPED` (`rls-coverage.integration.test.ts:94-99`) with forced RLS and system-only policies. Add one more:

```
distro_package_vulnerabilities
  id uuid PK, vulnerability_id uuid FK → vulnerabilities(id),
  ecosystem varchar(16) NOT NULL ('arch'), package varchar(255) NOT NULL,
  affected_version varchar(120), fixed_version varchar(120) NULL,
  status varchar(16) ('vulnerable'|'testing'|'fixed'|'not_affected'),
  severity varchar(16) (tracker: critical|high|medium|low|unknown),
  advisory_group varchar(32) (AVG-nnnn), updated_at timestamptz,
  UNIQUE (ecosystem, package, vulnerability_id, advisory_group); INDEX (ecosystem, package)
```

Forced RLS + a single system-only policy in the same migration; add to `INTENTIONAL_UNSCOPED`. **No `org_id`, no `device_id` ⇒ no `CORE_ORG_CASCADE_DELETE_ORDER`, device-cascade, or export-policy entry** (CLAUDE.md: "a table with no `org_id` needs no entry"). Rejected: (B) reusing `os_vulnerabilities` with `os_line = package` — abuses its semantics and its pass is mac-only; (C) process memory — lost on restart, per-replica, and not joinable from `correlateOrg`'s SQL. Migration must be named to sort after the newest committed file (`2026-10-15-140004-…` in this checkout; re-check `origin/main` at authoring time).

**Feed.** New `services/archSecurityClient.ts` (`fetchArchTracker`, `parseArchTracker`, `syncArchTracker`) modelled on `sofaClient.ts:104-252`: GET `https://security.archlinux.org/json` (all AVGs; `packages[]`, `status`, `severity`, `affected`, `fixed`, `issues[]`, `type`), `If-None-Match` from `vulnerability_sources.cursor` (source `'arch'`, health rows as in `vulnerabilityJobs.ts:180-300`). Per-package `/package/<name>.json` is for the admin "re-check one package" tool only. Per CVE in `issues[]`: match `vulnerabilities.cve_id`; insert with `source='arch'`, `rawPayload` = the AVG record, only when absent (NVD/`cveEnrichmentWorker` supply CVSS later). Add `'arch'` to `vulnSourceSyncSchema` (`jobs/queueSchemas.ts:391`) and a daily slot `jobSchedule('vulnerability-arch-sync')` in `jobs/scheduleRegistry.ts` (daily lane, before `vulnerability-correlate`).

**Matching.** New pass `correlateDistroPackages(orgId)` in `vulnerabilityCorrelation.ts`, run after `correlateOrg`: devices with `os_distro_family='arch'` → their `software_inventory` rows → facts by `(ecosystem, package = lower(trim(name)))`. Open when `status ∈ {vulnerable, testing}` (no fix) or `status='fixed' AND vercmp(installed, fixed_version) < 0`; `not_affected` skipped. `match_confidence='exact'` (package identity is authoritative; no CPE fuzz). Findings are `device_vulnerabilities` rows linked to the inventory row; the resolve sweep is discriminated by `EXISTS distro_package_vulnerabilities` exactly as `hasOsVulnFacts` discriminates OS findings (`:56-70`), so the "CVE with both fact kinds" caveat documented there gains a third fact source — extend the comment and the pre-lock scope (`buildFindingPreLockQuery`, `:106`) in the same PR.

**Version compare — implement `vercmp` in TS.** `compareBuilds` (`services/versionCompare.ts:8-19`) is numeric-dot only and wrong for `2:1.0-1`, `1.0rc1`, `6.16.5.arch1-1`. Add `services/archVercmp.ts` porting libalpm's `alpm_pkg_vercmp` (epoch, then rpmvercmp-style alnum segments, then pkgrel). Shelling out to `vercmp` is rejected: matching is server-side and the agent never sees the feed. Golden test: the documented `vercmp` examples plus a fixture generated by real `vercmp` in the Arch CI container (§h).

**Severity → patch enrichment.** Pending-patch ingest for `source='linux'` from provider `pacman|omarchy` sets `severity` = max tracker severity where `installed < fixed_version ≤ pending` (critical→`critical`, high→`important`, medium→`moderate`, low→`low`, else `unknown` — the enum at `schemas.ts:790`) and `category='security'` when any advisory matches. Server-side, so one fetch per deployment rather than per device (same shape as MSRC's `severityFromCvss`).

**Foreign packages.** Tracker covers official repos only. AUR names cannot collide with repo names, so false positives are bounded; if per-item source exists on the server, exclude `linux:pacman-foreign` items explicitly.

### e. Omarchy posture facts

Reuse the security-status pipeline: agent `SecurityStatus` (`security/status.go:39-63`) → `securityStatusIngestSchema` (`routes/agents/schemas.ts:518-560`, jsonb fields capped at 64 KB) → upsert (`routes/agents/helpers.ts:484-526`) → `security_status` (`db/schema/security.ts:52-71`). Add one jsonb column `security_status.platform_posture` (agent field `PlatformPosture any json:"platformPosture,omitempty"`), classified **`excludedOpen`** in `CORE_TENANT_EXPORT_POLICY` (jsonb is an open container — CLAUDE.md), migration `ADD COLUMN IF NOT EXISTS`. Rejected: overloading `localAdminSummary`.

```json
{ "source": "linux_posture", "distroId": "omarchy", "family": "arch",
  "omarchy": { "detected": true, "version": "4.2.0", "channel": "stable" },
  "sudo":    { "passwordlessWindowActive": true, "rules": ["/etc/sudoers.d/omarchy-nopasswd: %wheel ALL=(ALL) NOPASSWD: ALL"] },
  "sshd":    { "enabled": false, "active": false },
  "dockerGroup": { "primaryUser": "todd", "member": true },
  "secureBoot": { "state": "not_applicable", "observed": "disabled" },
  "tpm":        { "state": "not_applicable", "observed": "present" },
  "aiAgents":   { "default": "claude", "installed": ["claude", "codex", "opencode"] } }
```

Collection (all root-readable, no user session needed): sudo rules by scanning `/etc/sudoers` + `/etc/sudoers.d/*` for `NOPASSWD` lines matching the primary user or `%wheel` (Omarchy's window mechanism is unverified — if it is a timed drop-in this catches it; confirm on the VM); `sshd` via `systemctl is-enabled/is-active sshd`; primary user = uid 1000 (`getent passwd 1000`), docker membership via `getent group docker` (reuse `parseGroupMembers`, `status.go:803-830`); Secure Boot from `/sys/firmware/efi/efivars/SecureBoot-*` (last byte), TPM from `/dev/tpm0` — both reported `not_applicable` on Omarchy (it requires them off) with the observed value kept; AI agents: default from `omarchy default agent` state (read path unverified), installed = `LookPath` over the known launcher set (11 agents per research; list unverified). LUKS (`status.go:626-681`, `:1387-1408`) and ufw (`:1301-1337`) already work — unchanged, they are what the posture card cites. Emitted on every family, keys absent when not applicable.

**Surfaces.** `apps/web/src/components/devices/DeviceSecurityTab.tsx` gains a "Linux posture" card (rows above; Omarchy sub-rows only when `omarchy.detected`); `components/security/SecurityDashboard.tsx` untouched in this spec. i18n keys in every locale (tr-TR parity gate). Drift alerts on these facts are a follow-up, not this spec.

### f. Zero-touch enrollment (docs only)

Recipe for the "Managing Omarchy with Breeze" page: Omarchy's unattended installer reads a cloud-init `cidata` drive carrying `authorized_keys` and `tailscale_authkey`. Whether it also honours `runcmd` is **unverified**; document both paths: (1) if `runcmd` runs — fetch `https://<host>/api/v1/agents/install.sh` and run the enrol command the installer itself prints (`agent/scripts/install/install-linux.sh:229`: `breeze-agent enroll <key> --server <url> [--enrollment-secret …]`), using the one-liner the Add Device → CLI Commands tab generates (`apps/docs/src/content/docs/agents/installation.mdx:173-180`); (2) otherwise `authorized_keys` + a first-boot SSH push of the same one-liner. Enrollment-key hygiene per `docs/superpowers/specs/installer-enrollment/2026-04-07-public-installer-link-design.md`. The zero-touch onboarding design (`onboarding-signup/2026-09-07-zero-touch-onboarding-design.md`) exists only on the unpushed `feature/zero-touch-onboarding-spec` branch — not in this checkout (unverified); link it once it lands, since Omarchy is a natural second platform for its pre-registration-by-serial trigger.

### g. Breeze Omarchy plugin (optional wave)

The Linux user helper reaches the agent over the authenticated Unix socket `/var/run/breeze/agent.sock` (`ipc/auth_linux.go:69-70`, `userhelper/client_unix.go:11-16`) with roles `system|user|watchdog|assist` (`ipc/message.go:133-136`). A Quickshell plugin is QML/JS and cannot speak that protocol, so the contract is three local CLI verbs the plugin's `service` component shells out to: `breeze-agent status --json` (enrolled, connected, last heartbeat, pending updates, reboot pending, omarchy channel), `breeze-agent request-help` (raises the existing consent flow — `userhelper/consent_dialog_linux.go` — so a remote session is consented, never unattended), `breeze-agent open-ticket "<text>"`. Plugin = `manifest.json` + `bar-widget` (status glyph, pending-update count) + `service` (30 s poll). Plugins are unsandboxed, so the plugin holds no credentials: the verbs are read-only or consent-raising and the socket ACL is unchanged.

**Location:** `omarchy plugin add <git-url>` installs from a repo root (subdirectory support unverified), so the installable artifact must be its own repository. Recommend a separate public repo `LanternOps/omarchy-breeze` (source of truth there; `agent/` only gains the CLI verbs). Listing on plugins.omarchy.org: submission mechanism unverified — confirm before W06.

### h. CI

`test-agent` (`.github/workflows/ci.yml:1488-1511`) runs `CGO_ENABLED=0 go test ./...` on ubuntu-latest; no job uses `container:` today. Add `test-agent-arch`: `runs-on: ubuntu-latest`, `container: archlinux:latest`, `pacman -Syu --noconfirm go pacman-contrib`, then `BREEZE_ARCH_LIVE=1 go test ./internal/linuxdistro ./internal/collectors ./internal/patching -run 'Arch|Pacman|Vercmp'`. Live tests skip unless the env var is set and assert against real output: `pacman -Q` parses ≥1 item, `pacman -Qm` is empty-but-valid, `checkupdates` exit-code semantics, `linuxdistro.Detect().Family == arch`, and a `vercmp` golden file regenerated from the real binary (fails the job if it drifts from `archVercmp.ts`'s fixture). Non-blocking for one release, then required. **Omarchy has no container image — every `omarchy`-provider and posture claim is verified only on a real VM** (ISO installs in <2 min; Proxmox unattended recipe in the Omarchy manual).

## Waves

```
W01 ──► W02 ──► W03
 │        │
 ├──────► W04 ──► W05 (docs; can start after W02)
 └──────► W06 (optional; needs W04's facts)
```

| Wave | Scope | Files | Acceptance | Size |
|---|---|---|---|---|
| **W01 Detection + inventory** (independently shippable) | `linuxdistro` package; pacman/foreign sources; family-aware fallback; Arch CI job | `agent/internal/linuxdistro/*`, `collectors/software.go`, `software_linux.go`, `classify_linux.go` (wrapper), `.github/workflows/ci.yml` | Arch box: inventory lists native + foreign packages, no `source_unavailable`; Debian/RHEL fixtures unchanged; `test-agent-arch` green; `go test -race ./...` | M |
| **W02 Patch providers** | `PacmanProvider`, `OmarchyProvider`, family-first defaults, heartbeat maps, kernel-stale reboot | `patching/pacman.go`, `omarchy.go`, `defaults_linux.go`, `reboot_detect_unix.go`, `reboot_detect_linux.go`, `heartbeat.go:3419,3438` | Pending updates appear under source `linux`; patch job on Omarchy runs `omarchy update` (never `pacman -Syu`); reboot flag after kernel upgrade; flags from PR #11018 confirmed | M |
| **W03 Advisory feed + correlation** | `distro_package_vulnerabilities`, arch sync job, `archVercmp.ts`, `correlateDistroPackages`, patch severity enrichment, `devices.os_distro_*` columns | migration ×2, `services/archSecurityClient.ts`, `archVercmp.ts`, `vulnerabilityCorrelation.ts`, `jobs/vulnerabilityJobs.ts`, `queueSchemas.ts`, `scheduleRegistry.ts`, `tenantExportPolicyRegistry.ts`, `rls-coverage.integration.test.ts`, heartbeat + `routes/agents` for distro fields | Seeded old `openssl` on the Arch VM → finding within one correlate run; upgrade → `patched`; pending patch shows tracker severity; RLS/cascade/export suites green | L |
| **W04 Posture facts** | `platform_posture` column + agent collector + Security tab card | migration, `security/status.go` (+ `posture_linux.go`), `routes/agents/schemas.ts`, `helpers.ts`, `db/schema/security.ts`, `tenantExportPolicyRegistry.ts`, `DeviceSecurityTab.tsx`, locales | Omarchy VM shows version/channel, sudo window, sshd, docker group, agents; Secure Boot/TPM read `not applicable` | M |
| **W05 Docs** | "Managing Omarchy with Breeze" page, support-matrix update, zero-touch recipe, rollback note | `apps/docs/src/content/docs/agents/omarchy.mdx`, `agents/installation.mdx` support matrix + `features/patch-management.mdx:28` (flip the Arch cells from No to Yes once W01/W02 ship; PR #5476 already removed the zypper claim) | Page reviewed against the VM checklist; no claim without a verified wave behind it | S |
| **W06 Plugin** (go/no-go) | CLI verbs + separate plugin repo | `agent/cmd/*` status/help/ticket verbs; `LanternOps/omarchy-breeze` | Bar widget shows live status on the VM; help request raises consent dialog; listed on plugins.omarchy.org | M |

## Open decisions for Todd

- **Patch path on Omarchy — `omarchy update` vs raw pacman.** *Recommend `omarchy update` only* (ALPM guard makes pacman fail; snapshot-first is the product's safety story). Rider: resolve "who runs it" (§c) on the VM first.
- **zypper / apk siblings in scope?** *Recommend no for this feature*, but `linuxdistro.Family` and the family-first `defaults_linux.go` are built so a `ZypperProvider` is a one-file follow-up; Alpine stays a non-goal (OpenRC).
- **Plugin in-repo vs separate repo.** *Recommend separate* (`omarchy plugin add` needs a repo root); agent CLI verbs stay in-repo.
- **AUR handling.** *Recommend inventory-only as a distinct source* (`linux:pacman-foreign`); never upgrade via yay/paru from the agent (user-scoped, builds from source, unsigned).
- **Advisory cache: DB table vs process memory.** *Recommend the global table* (§d) — joinable, replica-safe, zero tenancy cost.
- **Distro identity on `devices`: two new columns vs heuristics.** *Recommend the columns* (one export-policy classification each); it also unblocks a distro badge and future zypper work.
- **Go/no-go on W06 (plugin).** *Recommend go only after W01–W04 ship and one external Omarchy fleet is enrolled*; it is the visible differentiator over Fleet but the smallest engineering value.

## Risks

- **Target-OS security posture.** Plugins are unsandboxed and the passwordless-sudo window is a design feature; the docker-group root escalation shipped Jun 2025 → fixed 4.0.1. Breeze's plugin therefore carries no secrets (§g), and the posture facts exist precisely to make these visible to the MSP. Anything Breeze runs as the desktop user (a possible `omarchy update` path) inherits that user's sudo state — document it.
- **Reputational.** DHH's politics and the 1Password backlash (2026-09-02) make co-marketing risky. Engineering-first: no patronage, no co-branding, no Omarchy logo in-product; the docs page describes what works.
- **Upstream churn.** Weekly point releases; PR #11018's flags may change before or after merge; CLI paths (`omarchy`, channel state, default-agent state) are unverified. Mitigation: every Omarchy-specific call is behind one `OmarchyProvider`/`detectOmarchy` seam with fixtures captured from a named Omarchy version, and the docs page states the tested version.
- **Partial-upgrade trap.** Per-package installs are unsupported on Arch; the UI's per-patch "install" will upgrade everything. W02 must say so in the job result message and the docs.
- **Correlation dual-fact caveat.** Adding a third fact source widens the "CVE with both fact kinds" hole documented at `vulnerabilityCorrelation.ts:50-58`; the W03 PR must extend the pre-lock scope, not just the pass.

## Verification

**W01** — fixture tests (os-release ×7, `pacman -Qi`, `pacman -Qm`, fallback matrix); `test-agent-arch` live checks; VM: enroll → Software tab lists pacman packages, foreign ones under their own source, no failure badge.

**W02** — provider fixtures (`checkupdates`, exit-2, fake runner asserting the exact `omarchy update` argv and the absence of `pacman -Syu`); `detectPendingRebootLinux` with fake modules dir; VM: pending updates listed under `linux`; create a patch job → `omarchy update` runs non-interactively, snapshot appears in the boot menu; kernel update → reboot flag set → clears after reboot; Debian VM regression: apt path unchanged.

**W03** — `archVercmp` golden (documented cases + Arch-container-generated fixture); parser fixture from a captured `/json` slice (fixed, vulnerable, testing, not-affected, multi-package AVG); integration: seeded fact + seeded inventory → finding, upgrade → `patched`, non-Arch device → no finding; `rls-coverage`, `tenantCascade`, `tenant-export-policy` + `tenantExportErasureRoundtrip` suites (columns on `devices` are the trigger); migration replay twice = no-op; VM: downgrade a repo package with a known AVG → finding with tracker severity → `omarchy update` → resolved.

**W04** — collector unit tests with fake sudoers/getent/efivars; ingest schema test (64 KB cap, unknown keys tolerated); web test asserting the card renders every key and hides Omarchy rows on plain Arch; VM: toggle the sudo window / add user to `docker` / enable sshd → facts change on the next security-status report; Secure Boot/TPM rows read "not applicable".

**W05** — page walked against the VM checklist end-to-end: **enroll → inventory shows pacman packages → pending updates listed → `omarchy update` applied via Breeze → reboot flag → posture facts visible**; the support matrix in `agents/installation.mdx` and the `linux` source row in `patch-management.mdx` reflect pacman inventory + `omarchy update` patching (PR #5476 already corrected the pre-W01 state).

**W06** — plugin installs via `omarchy plugin add … --enable` on the VM; bar widget reflects `status --json`; help request produces the consent dialog and a consented remote session; ticket appears in Breeze.
