---
tracking_issue: LanternOps/breeze#10190
---

# On-Device Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Breeze Assist draws every prompt Breeze shows the person at the keyboard (restart, elevation, remote support, notices) on one stateful, branded, localized contract. The native helpers stay as a fallback that mirrors the same copy and safe defaults.

**Architecture:**
- **One host in the agent.** A new agent package, `prompthost`, owns every prompt and speaks one additive IPC contract to every renderer:
  - agent → renderer: `prompt_show`, `prompt_update`, `prompt_close`;
  - renderer → agent: `prompt_presented`, `prompt_action`, `prompt_closed`.
- **Renderers.** Assist, the native user-helper and, for elevation, the SYSTEM helper.
- **Kind gating.** Renderers advertise the kinds they can draw, and the server holds a per-kind kill switch. Any kind that is not advertised or not enabled goes the legacy way, exactly as today.
- **Copy and identity.** The agent renders all copy from one shared catalog in eight locales. It learns the MSP identity from a new heartbeat `promptIdentity` block.
- **Waves.**
  - W01–W03 build Assist reliability, the dormant contract, and copy plus identity.
  - W04–W08 each move one prompt family onto the contract.
  - W09 documents the result, flips the general-availability defaults, and files the follow-ups.

**Tech Stack:**
- Go agent (`go test -race`)
- Tauri 2 / Rust + React for Assist (`cargo test --locked --lib`, vitest)
- Hono/TypeScript API (Vitest; Drizzle for queries only; hand-written SQL migrations)
- Astro/React web
- `packages/shared` (Zod, JSON fixtures, the catalog)

**Spec:** `docs/superpowers/specs/helper/2026-10-26-on-device-dialogs-design.md` (Gate A approved 2026-10-26).
- OD-1 through OD-12 are resolved as recommended, with OD-5 = (c) default on and OD-11 = (b).
- The two decision comments on #10190 are binding.
- Spec section numbers (§) below refer to that file.

**Tracking:** Not registered yet. After Gate B, the orchestrator runs `register_feature` (parent #10190, `wave` sub-issues W01–W09). Wave branches are `feature/10190-on-device-dialogs/wave-<sub-issue#>`.
- In a multi-PR wave, only the last PR carries `Closes #<sub-issue>`. The others say `Part of #<sub-issue>`.
- **W00 is not planned here.** These standalone fixes are dispatched separately: #10187, #10179, #10186, #10182, #10184, and docs #10188/#10189.
- Waves that need a W00 fix say so. **At plan time none of the W00 fixes is on `main`** (for example, `consent_dialog_windows.go` still lacks `MB_DEFBUTTON2`).

## Global Constraints

Contract values, copied from the spec. Every task obeys them.

- **IPC versioning:**
  - `ipc.ProtocolVersion` stays `1`. The broker rejects a mismatch permanently (`broker.go:2246`).
  - Every new IPC field is additive and `omitempty`.
- **AuthRequest additions:**
  - `promptProtocolVersion` (int; absent = 0).
  - `promptKinds` (`[]string`, entries shaped `"<kind>@<n>"`).
  - `rendererVersion` (string).
  - `uiLocale` (string; added in W03).
  - The broker clamps the protocol version to its own.
- **Scopes:**
  - `prompt` covers Breeze-owned kinds: `notice.info`, `remote.consent`, `remote.session`, `elevation.request`.
  - `prompt_operator` covers kinds that may carry MSP copy: `restart.prompt`, `restart.final`.
  - A scope is granted only for kinds the session advertised.
- **Message types:**
  - Agent → renderer: `prompt_show`, `prompt_update`, `prompt_close`, `prompt_action_result`, `prompt_branding_sync`.
  - Renderer → agent: `prompt_presented`, `prompt_action`, `prompt_closed`.
- **Close reasons:**
  - From the agent: `resolved | superseded | withdrawn | expired | fenced`.
  - From the renderer: `hidden | render_failed | replaced`.
- **Action results:** `accepted | rejected_stale | rejected_invalid`.
- **States:** `pending → waiting → {approved, denied, expired, cancelled, failed}`.
- **Actions:**
  - Roles are `safe | proceed | neutral`. A state has at most 3 actions.
  - A decision state has exactly one `safe` action, and `defaultActionId` names it.
  - Esc and the window close box map to the safe action in a pending decision, and to "hide" everywhere else.
- **Timing:**
  - `presentWithinMs` = 10 000.
  - The response budget is either `deadlineUnixMs` (absolute) or `responseMs` (counted from presentation; used by consent only).
  - The agent's timer decides expiry. A replay or a renderer switch never restarts a deadline.
- **Lifetimes:**
  - Terminal-state linger: 8 s.
  - Tombstones for prompts: 24 h. Endpoint-message tombstones stay at 168 h (`message_store.go:56`).
  - Grace after Assist disconnects: 10 s. Watcher respawn check: 30 s.
- **Notification list:**
  - Entries live 7 days, up to 50 per owner (session + user principal). This is fixed, not a policy setting.
  - At most 3 visible cards per session. One `modal` at a time.
  - At most 10 new cards per 10 minutes per session; beyond that, new prompts go to the list only.
- **Focus and accessibility:**
  - `steal` is allowed only for: a modal answering something the user just did, `remote.consent`, and `restart.final`. At most once per focus interval (`FOCUS_INTERVAL_MS` = 5 min, `message.rs:49`).
  - `QUNS_BUSY`, `QUNS_RUNNING_D3D_FULL_SCREEN` and `QUNS_PRESENTATION_MODE` mean: draw the card, never steal focus, and hold non-urgent cards.
  - The countdown is announced at 60, 30 and 10 s only.
- **Locales:** `en de-DE es-419 fr-FR fr-CA it-IT pt-BR tr-TR`.
- **Identity:**
  - `partnerName` = `partners.name`, trimmed, capped at 120 code points. An org can never override it.
  - Logo and colour come from `partners.settings.branding`, with the `portal_branding` org override via `resolveDocumentBrand`.
  - `scopeId` = the first 32 hex characters of `sha256("<partnerId>:<orgId>")`.
- **Logo:**
  - PNG, JPEG or WebP, checked by magic bytes. At most 256 KB (262 144 bytes) and at most 1024 px per side.
  - SVG, or anything else, means no logo.
  - An `https://` source is fetched only through `checkSsrfSafe` (`services/ssrfGuard.ts:91`). A `data:` value is decoded.
- **Defaults** (OD-3; none of these changes):
  - Postpone is off unless the policy turns it on; the budget is 3 × 60 min (cap 10).
  - Consent response window: 30 s.
  - Elevation first question: 90 s (`pam_flow.go:24`).
  - Elevation waiting time = the server TTL of 15 min (`pamJobs.ts:38`), shown as a clock time.
- **Restart:**
  - The last minute stays with the OS: `shutdown /r /t 60 /d p:2:17` (OD-4).
  - The Postpone label is `Postpone until <time>`, computed by `ComputeDeferral` (`reboot_deferral.go:65`).
- **Audit:**
  - `renderer` ∈ `assist | native | headless`.
  - New actions: `device.reboot.user_postponed`, `device.reboot.user_restart_now`, `remote.session.ended_by_user`.
- **New helper issue codes:** `webview2_outdated`, `crash_loop`, `unmanaged_install`. They fit the existing regex `^[a-z][a-z0-9_]*$`, max 50, in `routes/agents/schemas.ts:241`.
- **Engineering:**
  - Go: `cd agent && go test -race ./internal/<pkg>/...`
  - Assist Rust: `cd apps/helper/src-tauri && cargo test --locked --lib <filter>`
  - Assist TS: `cd apps/helper && npx vitest run <file>`
  - API: `cd apps/api && npx vitest run <file>` (never `--` before flags; paths are substring matches)
  - Shared: `cd packages/shared && npx vitest run <file>`
  - Web: `cd apps/web && npx vitest run <file>`
  - API typecheck, as CI runs it: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --build tsconfig.tests.json; echo exit=$?`. Read the exit code; never pipe tsc to `tail`.
  - Integration and RLS suites need `pnpm test-stack up`. Tear it down afterwards.
- **Migrations:**
  - **The orchestrator assigns every slot at dispatch time.** At plan time the newest file on `main` is `2027-01-06-130000-flow-runs.sql`.
  - Idempotent, with no inner `BEGIN;`/`COMMIT;`. Read `apps/api/migrations/README.md` first. Never edit or rename a shipped migration. Run `pnpm db:check-drift`.
- **Public repo:** no customer names, hostnames, IPs or session ids in code, tests, commits or PR text. Detailed security-gap analysis stays in the #10190 issue thread, not in this plan or in PR bodies.
- **Model tier:** Opus for every agent PR, every Assist PR (both ship to customer machines), and every API PR that touches a migration, PAM or identity. Sonnet may take web-only, locale-only and docs-only PRs.

## Review Focus

These are input classes the spec implies but its listed tests do not exercise. Each one is pinned by a test in the task named.

1. **Skew: two renderers in one session.** An agent update leaves an old native user-helper running next to a new Assist in the same session. The host must still pick exactly one renderer, and the old helper must get the legacy type only if it was chosen. A live-auth advertisement of nothing means legacy. Test: Task 2.3, `TestSelectExactlyOneRendererWithOldNativeAndNewAssist`.
2. **Sleep, resume and clock jumps.** A laptop sleeps past a restart or consent deadline, or the wall clock jumps.
   - The agent must fire expiry on resume and must never extend the deadline.
   - Assist's `{remaining}` must floor at `0:00`, never show negative time.
   - Tests: Task 2.3 `TestAbsoluteDeadlineFiresAfterSleepPastIt`; Task 2.6 `formatRemaining floors at 0:00`.
3. **Hostile identity and operator strings.** Bidi overrides, zero-width characters, 500-character names, newlines; operator restart text with `{{countdown}}` twice or unknown `{{x}}` placeholders. The result must be sanitized, capped, and never interpreted as markup or a placeholder.
   - Tests: Task 3.2 `sanitizePromptPartnerName` fixture (shared by TS and Go); Task 5.1 `TestRestartOperatorCopyPlaceholders`.
4. **Locales outside the eight.** `en-GB`, `pt-PT`, `es-ES`, `fr-BE`, `zh-CN`, empty string, and POSIX `fr_CA.UTF-8` must negotiate deterministically and identically in Go and TS. Test: Task 3.1, the `locale-negotiation.json` fixture consumed by both suites.
5. **Concurrent decisions across sessions.** Two signed-in users answer the same restart at the same moment, one Postpone and one Restart now. Exactly one decision is applied, the other session gets `rejected_stale` plus a `prompt_update` with the outcome, and the deferral ledger counts once. Test: Task 5.1, `TestRestartConcurrentDecisionsFirstWins`.

## Plan decisions (refinements of the spec — confirm at Gate B)

- **P1 — `promptHost` telemetry moves from W01 to W02.** Nothing is advertised before W02.
  - W01's device-page label is derived from persisted columns and describes the installed or last-observed state ("Breeze Assist installed", "unavailable: <reason>", "not deployed"). It does not claim the live per-session renderer (quorum).
  - W02 adds the live observation.
- **P2 — Renderers advertise only kinds whose wave has shipped.** W02 advertises none, so the contract is dormant by construction, not only by `enabledKinds`.
  - W02's change to message storage is not dormant, and is made rollback-safe in P5.
- **P3 — Catalog layout.**
  - One JSON file per namespace (`common`, `notice`, `restart`, `remote`, `elevation`), each holding all eight locales. W05, W06 and W07 run in parallel and never edit the same file.
  - Go embeds a byte-identical copy, checked by a parity test (the `cleanup_rules.json` precedent, `internal/remote/tools/filesystem_cleanup_rules.go:14-20`).
  - Assist imports the catalog through a Vite/TS path alias, not a workspace dependency (Assist deliberately has no `@breeze/shared` dependency, per `apps/helper/src/lib/messageMarkdown.tsx:26`). Rust tray strings use `include_str!`.
- **P4 — `enabledKinds` comes from the env var `PROMPT_HOST_ENABLED_KINDS`.**
  - Unset → the code default `DEFAULT_ENABLED_PROMPT_KINDS`. Empty string → nothing (the kill switch). Otherwise a comma list.
  - Entries are a bare `kind` (all versions) or `kind@n` (one version).
  - The code default is empty until W09 flips it to the kinds that have run enabled in both hosted regions for at least one release. Until then self-hosters keep today's behaviour, unless they opt in.
  - Agent canary pins provide the canary: a kind only goes live where the agent speaks it.
- **P5 — One inbox, two files.**
  - `inbox.Store` generalises `message_store.go`. There are two instances:
    - endpoint messages: `endpoint_messages.json`, same path and record format, plus an optional additive `owner` field, tombstones 168 h;
    - prompt entries: new `prompt_inbox.json`, tombstones 24 h.
  - A single list and replay API merges the two.
  - An agent rolled back to a pre-W02 build reads `endpoint_messages.json` unchanged (quorum).
- **P6 — Locale plumbing.** `AuthRequest.uiLocale` carries the session language (the spec notes it is missing today). `prompt_branding_sync` also carries the negotiated `locale`, so Assist can localize its tray chrome.
- **P7 — `remote.session` actions.**
  - `details` is renderer-local (expanding the pill) and is not a wire action.
  - `report_problem` is a wire action. The agent answers `accepted`, and Assist then opens Request Support (OD-6 (b)).
- **P8 — Legacy restart default fixed early.** The legacy restart `MessageBoxTimeoutW` gets `MB_DEFBUTTON2` in W05 whatever `enabledKinds` says. A timeout keeps meaning "no decision".
- **P9 — W08 launch context stays on the device.**
  - The arguments and working directory captured at ETW time are held by the agent, keyed by request id.
  - The server stores a display copy of the command line plus `launch_context_sha256`. Approval binds to that hash, so the server can never supply what runs elevated.
  - The spec's "carried through request, approval and launch" is read as "bound through".
- **P10 — OD-11.**
  - Newly created helper policies default to `enabled: true` (API create path + `HelperTab` initial state).
  - `HELPER_DEFAULTS.enabled` stays `false`, so devices with no policy are unchanged; option (c) was rejected.
  - "New partners" has no mechanism today: no partner-default policy is seeded (Gate B item G1).
- **P11 — W04 enable condition.** A kind is enabled only after the Assist build that advertises it is published, not the W02 build.
- **P12 — Where the WebView2 minimum comes from.**
  - Assist ships a sidecar file, `assist-requirements.json` (`{assistVersion, minWebView2Version}`), next to the executable.
  - The agent ignores the sidecar when its `assistVersion` does not match the installed executable's version, which covers an update rollback that restored only the executable (quorum, `manager.go:1047`). It then uses a compiled fallback constant.
- **P13 — No WebView2 version on the device badge in W01** (no new `devices` column).
  - The badge says "WebView2 runtime too old". The version found goes in the agent WARN log, searchable through diagnostic logs.
  - A column can be added later if technicians need it.
- **P14 — The SYSTEM-helper renderer moves from W02 to W07,** the only wave that uses it, so it is built against a real kind. W02 ships the generic user-helper native renderer.
- **P15 — Kill switch during an open prompt.**
  - Disabling a kind affects new prompts.
  - An open prompt that has already been presented finishes on its renderer.
  - One that was never presented falls back when its present budget runs out.

## Compatibility order (every wave obeys it)

1. **No protocol bump.** `ProtocolVersion` stays at 1. Capability is negotiated per kind at IPC auth (`grantScopes`, `broker.go:2908`, extended additively).
2. **Three switches decide each prompt.** A kind is live for one prompt only when all three are on:
   - the agent build constructs the kind (agent release);
   - the chosen renderer advertised `kind@n` at its **live** authentication (for Assist, the server-published build; for the native helpers, the same package as the agent — **an old native process that survives an update advertises nothing and stays legacy**);
   - the server lists the kind in `promptHost.enabledKinds`.
   If any switch is off, the agent sends the legacy type exactly as today (`notify`, `consent_request` v2, `banner_show`, `pam_request_dialog`).
3. **Unknown is never silent for a decision.** Old Assist drops unknown types silently (`client.rs:653`). The agent never sends `prompt_*` to a session that has not advertised the kind. A renderer that cannot draw a `prompt_show` answers `prompt_closed{render_failed}`. A missing `prompt_presented` within 10 s is treated the same way, and the agent falls back.
4. **Release trains are independent.**
   - **Assist has one global, unpinnable `latest` channel** (`heartbeat.ts:2127-2150`). An installed Assist upgrades subject to the org update gate. Agent canary pins neither canary Assist nor guarantee its installation (quorum).
   - Therefore every Assist build in this epic passes its wave's lab legs **before** it is published as `latest`. The Assist side of a kind does nothing until an agent that speaks the kind is present and the kind is enabled.
5. **Per-kind sequence (W04–W08):**
   1. Merge the agent and Assist PRs, in either order.
   2. Run the Assist lab legs with the kind enabled on a lab stack, then publish Assist.
   3. Release the agent with canary org pins.
   4. Run the agent lab legs with the kind enabled on the lab stack.
   5. Set `PROMPT_HOST_ENABLED_KINDS` on the canary region.
   6. Promote the agent and **clear the canary pins at that promote**.
   7. Enable the kind in the other region.
6. **Kill switch.** Turning a kind off is an API env change plus restart; no agent release is needed. P15 sets what happens to open prompts.
7. **Legacy branches toward native helpers** may be deleted only after a release whose lab legs covered "agent update while an old helper process keeps running".
8. **Legacy branches toward Assist** may be deleted only after both:
   - the server enforces a minimum Assist version (a floor in the `helperUpgradeTo` offer);
   - **fresh connected-renderer observations** (W02's `promptHost` observation, which carries the running `rendererVersion`) show no connected Assist below the floor.
   `devices.helper_version` is not evidence: it reports the on-disk version and keeps its old value when reporting stops (quorum, `manager.go:930`, `heartbeat.ts:1320`). This is a follow-up issue filed in W09, not a wave.
9. **Safety fixes on the legacy path ship unconditionally:** W00 #10187 for consent and P8 for restart.

## Wave map

| Wave | PRs (component · model) | Depends on | Migration / tenancy | Todd lab legs | 
|---|---|---|---|---|
| W01 Assist reliability (#10183, #10185) | 1A agent · Opus; 1B Assist · Opus; 1C API+web · Sonnet | — (parallel with W00) | none | WebView2 90.x, crash loop, ownership, rollback |
| W02 contract, dormant | 2A shared · Opus; 2B agent core · Opus; 2C agent inbox + native + heartbeat · Opus; 2D Assist · Opus; 2E API · Opus | W01 first by spec order (no shared files; may overlap) | none | regression only: messages after update and rollback; #8138 |
| W03 copy + identity | 3A shared catalog · Opus; 3B API identity · Opus; 3C agent · Opus; 3D Assist · Opus | W02 | none (in-request capability gating) | caller-verify logo change; non-en user; org move purge |
| W04 notices | 4A agent · Opus; 4B Assist · Opus | W03 | none | DND notices, macOS TCC, list survival, FUS |
| W05 restart | 5A agent · Opus; 5B Assist · Opus; 5C API+web · Sonnet (API audit Opus) | W04 | none | full restart matrix + restart video |
| W06 remote support | 6A API migration · Opus; 6B web · Sonnet; 6C agent · Opus; 6D Assist · Opus | W04; **W00 #10187 merged** | `config_policy_remote_access_settings.allow_user_end_session`; orchestrator assigns the slot | consent matrix, pill end session + video |
| W07 elevation, transitional | 7A API · Opus; 7B agent · Opus; 7C Assist · Opus | W04; #8971 PR A+B, #8928 PR 1, #10177, W00 #10179 merged and lab-tested | widen `elevation_requests_withdrawn_reason_chk` with `user_cancelled`; slot assigned by the orchestrator | UAC matrix + elevation video |
| W08 elevation, destination | 8A agent spike · Opus; 8B API · Opus; 8C agent · Opus; 8D Assist · Opus | W07 + its lab qualification; 8A go | `elevation_requests.command_line_display`, `launch_context_sha256`; slot assigned by the orchestrator | W07 matrix + installers + requester binding; video take 2 |
| W09 docs + GA + follow-ups | 9A docs · Sonnet; 9B API default flip · Sonnet | W05–W08 | none | videos (restart, elevation, remote support) |

W05, W06 and W07 can run in parallel after W04. Each kind keeps its own files (Go `promptkinds/<kind>.go`, Assist `src/prompt/kinds/<kind>.tsx`, catalog `<namespace>.json`). The only shared registries are append-only lines.

## Per-PR checklist (CI traps; every PR copies this into its description and ticks it)

- [ ] **Opened against `main`.** A stacked PR runs no CI. If one is unavoidable, run `gh workflow run CI --ref <branch>`.
- [ ] **New `apps/api/src/services/**` file** is classified in `__tests__/parkedFanout.contract.test.ts` / `parkedFanoutModules.ts`.
- [ ] **New top-level paths** (e.g. `agent/internal/prompthost`, `packages/shared/src/promptCatalog`) are covered by the per-area job gating contract (Lint job, "Test per-area job gating contract").
- [ ] **New web locale keys** are in all 8 `apps/web/src/locales/<code>/*.json` (`localeParity.test.ts`). Removed keys are also removed from `humanizedKeyBaseline.json`.
- [ ] **API typecheck** with `tsc --build tsconfig.tests.json` (strict index). Exit code read.
- [ ] **Assist version** bumped in `tauri.conf.json`, `Cargo.toml` and `package.json` together ("Guard Tauri crate/npm version parity"). Any new window label has a `src-tauri/capabilities/*.json` entry. The source-scan guard tests in `lib.rs:2132-2171` still pass.
- [ ] **Agent logic** that CI must test lives in untagged files; windows- and darwin-tagged code is not tested in CI.
- [ ] **Tenancy-touching PRs** (W06, W07, W08) run the integration and RLS-coverage suites locally. Those suites fail only under the **Integration Tests** job, never Test API.
- [ ] **Release notes:** append under the heading "On-device dialogs (#10190)" in `docs/release-notes/next-release-draft.md` (a merge-queue hot spot: append only, and enqueue behind a queued PR rather than race it).
- [ ] **Migrations untouched** except the new file at the slot the orchestrator assigned.
- [ ] **Settings rule 9** (only when a setting is added): the PR states the home, level, resolver and the place count before and after.

---

# W01 — Assist reliability (closes #10183, #10185)

Spec §3.8. This wave ships a WebView2 check before launch, crash-loop diagnostics, install ownership (OD-8 (a)), a derived Assist-status label, and the OD-11 default for new policies. It introduces no new contract. **If W02 never ships:** Assist failures become visible and recoverable, and hand-installed copies are no longer removed.

| PR | Owns | Safe alone because |
|---|---|---|
| 1A agent | `agent/internal/helper/{webview2.go,webview2_windows.go,webview2_other.go,ownership.go,watcher.go,install_retry.go,manager.go}` + tests | New issue codes are plain strings; an old server shows "unknown" |
| 1B Assist | `apps/helper/src-tauri/assist-requirements.json` (new), `tauri.conf.json` `bundle.resources`, `src-tauri/src/requirements.rs` (new) | The agent falls back to its constant while the sidecar is absent |
| 1C API+web | `apps/web/src/components/devices/{DeviceInfoTab.tsx,promptRenderer.ts}` + 8 × `locales/<code>/devices.json`; `HelperTab.tsx`; `services/configurationPolicy.ts` (helper create default) | Display and create-time default only |

### Task 1.1: WebView2 runtime check before launch (agent)

**Files:**
- Create: `agent/internal/helper/webview2.go` (untagged: version parse/compare and sidecar load)
- Create: `agent/internal/helper/webview2_windows.go` (registry read)
- Create: `agent/internal/helper/webview2_other.go` (reports "not applicable")
- Modify: `agent/internal/helper/manager.go` (gate in `ensureRunningSession`, :677), `install_retry.go` (codes, :85-88)
- Test: `agent/internal/helper/webview2_test.go`

**Interfaces:**
- Produces:
  - `const InstallIssueWebView2Outdated = "webview2_outdated"`
  - `type webview2Version [4]uint32`
  - `func parseWebView2Version(s string) (webview2Version, bool)`
  - `func (v webview2Version) less(o webview2Version) bool`
  - `func readInstalledWebView2() (string, bool)`. Windows reads the `pv` value under `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`, then the native HKLM key, then HKCU. `"0.0.0.0"` or empty counts as absent.
  - `type assistRequirements struct{ AssistVersion, MinWebView2Version string }`
  - `func loadAssistRequirements(installDir, installedVersion string) assistRequirements`. It returns `fallbackAssistRequirements` when the file is missing, malformed, or its `assistVersion` differs from `installedVersion` (P12).

- [ ] **Step 1: Write the failing tests.**
  - `TestParseWebView2Version`: `"90.0.818.66"` parses; `""`, `"0.0.0.0"`, `"abc"` and `"1.2.3"` do not.
  - `TestWebView2Less`: `90.0.818.66 < 120.0.2210.91`.
  - `TestLoadAssistRequirementsMismatchedVersionUsesFallback`: sidecar `{assistVersion:"0.2.0"}` with an installed `0.1.9` returns the fallback.
  - `TestLoadAssistRequirementsMissingUsesFallback`.
  - `TestEnsureRunningRefusesBelowMinimum`, using a fake reader returning `90.0.818.66`: no launch, `InstallIssue()` returns `webview2_outdated`, and the log line carries the found and minimum versions.
- [ ] **Step 2: Run them and watch them fail.** `cd agent && go test -race ./internal/helper/ -run 'WebView2|AssistRequirements|EnsureRunningRefuses'` → FAIL (undefined).
- [ ] **Step 3: Implement.**
  - `fallbackMinWebView2` = the minimum runtime documented for the Microsoft.Web.WebView2 SDK version that `webview2-com-sys 0.39.x` pins (read `apps/helper/src-tauri/Cargo.lock` → that crate's build source). Record the value and the source in the PR.
  - On Windows the gate runs before every launch. Other OSes skip it.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command → PASS. Then run `go test -race ./internal/helper/...`.
- [ ] **Step 5: Commit** `feat(agent): refuse to launch Breeze Assist on an outdated WebView2 runtime (#10183)`.

### Task 1.2: Crash-loop diagnostics and long-backoff retry (agent)

**Files:** Modify: `agent/internal/helper/watcher.go` (:10-14, :35-108), `install_retry.go`, plus the Assist spawn call reached from `ensureRunningSession`. Test: `watcher_test.go`.

**Interfaces:**
- Produces:
  - `const InstallIssueCrashLoop = "crash_loop"`
  - `type assistExit struct{ Code int; StderrTail string }`, where the tail is at most the last 20 lines or 4 KB
  - `const watcherGiveUpRetry = 6 * time.Hour`
- The spawn redirects Assist's stderr to `<agent log dir>/assist-<winSession>.stderr.log`, capped at 64 KB and truncated at each launch. The watcher reads the exit code from the process handle.

- [ ] **Step 1: Write the failing tests.** All use a fake clock and a fake spawner.
  - `TestWatcherLogsExitCodeAndStderrTail`.
  - `TestWatcherGiveUpReportsCrashLoop`: 6 failures → `InstallIssue()=="crash_loop"`.
  - `TestWatcherRetriesAfterSixHours`: still given up at 5h59m; launches once at 6h.
  - `TestWatcherRetriesOnAssistVersionChange`: version change → resets `watcherGaveUp`.
- [ ] **Step 2: Run them and watch them fail.** `go test -race ./internal/helper/ -run Watcher` → FAIL.
- [ ] **Step 3: Implement.** Keep the existing ERROR "breeze assist keeps crashing, giving up" and add `exitCode` and `stderrTail` fields. `ErrNotInstalled` behaviour (#6872) is unchanged.
- [ ] **Step 4: Run the tests and confirm they pass.** `go test -race ./internal/helper/...` → PASS.
- [ ] **Step 5: Commit** `feat(agent): record Assist exit codes and report crash_loop with a 6 h retry (#10183)`.

### Task 1.3: Install ownership marker (agent, OD-8 (a), #10185)

**Files:** Create: `agent/internal/helper/ownership.go`. Modify: `manager.go` (`Apply` :343, install :399, `uninstallLocked` :556-569). Test: `ownership_test.go`.

**Interfaces:**
- Produces:
  - `const InstallIssueUnmanagedInstall = "unmanaged_install"`
  - `type ownershipMarker struct{ InstalledBy string /* "breeze-agent" */; Version string; InstalledAt time.Time }`, stored as `assist-ownership.json` in the agent's data directory (SYSTEM-owned)
  - `func readOwnership(dir string) (ownershipMarker, bool)`
  - `func writeOwnership(dir string, m ownershipMarker) error`
- Rules:
  - After every successful agent install or update, the agent writes the marker.
  - It uninstalls only when the marker is present.
  - Installed, unmarked and deploy off → leave the install and report `unmanaged_install`.
  - Installed, unmarked and deploy on → adopt it: install the next server-offered version over it, then write the marker.
  - **Upgrade adoption.** On the first `Apply` after upgrading to this build: if the marker is absent, Assist is installed and `settings.Enabled` is true, the agent writes the marker, because today's agent manages that install. If the marker is absent and the toggle is off, the install is treated as unmanaged, because today's agent would already have removed it.

- [ ] **Step 1: Write the failing tests.**
  - `TestApplyDisabledLeavesUnmarkedInstall`: no uninstall call; `InstallIssue()=="unmanaged_install"`.
  - `TestApplyDisabledRemovesMarkedInstall`.
  - `TestApplyEnabledAdoptsUnmarkedOnNextOffer`.
  - `TestUpgradeAdoptsEnabledInstall`.
  - `TestMarkerWrittenAfterInstall`.
- [ ] **Step 2: Run them and watch them fail.** `go test -race ./internal/helper/ -run 'Ownership|Apply|Upgrade|Marker'` → FAIL.
- [ ] **Step 3: Implement.** The marker is written atomically (temp file + rename).
- [ ] **Step 4: Run the tests and confirm they pass.** `go test -race ./internal/helper/...` → PASS.
- [ ] **Step 5: Commit** `fix(agent): only remove Breeze Assist installs the agent made (#10185)`.

### Task 1.4: Assist requirements sidecar (Assist)

**Files:**
- Create: `apps/helper/src-tauri/assist-requirements.json`, containing `{"assistVersion":"<CARGO_PKG_VERSION>","minWebView2Version":"<same value as Task 1.1>"}`.
- Modify: `tauri.conf.json` (`bundle.resources`).
- Create: `src-tauri/src/requirements.rs` (a `#[cfg(test)]` test only).

- [ ] **Step 1: Failing test** `requirements_sidecar_matches_crate_version`: it reads the file with `include_str!` and asserts `assistVersion == env!("CARGO_PKG_VERSION")` and that `minWebView2Version` has 4 dot-separated numeric parts.
- [ ] **Step 2:** `cd apps/helper/src-tauri && cargo test --locked --lib requirements` → FAIL (no file).
- [ ] **Step 3:** Add the file and the resource entry. The installer drops it next to the executable on Windows. Check the installed layout in the W01 lab leg.
- [ ] **Step 4:** Same command → PASS. Bump the Assist version in all three files.
- [ ] **Step 5: Commit** `feat(assist): ship the WebView2 minimum as a requirements sidecar (#10183)`.

### Task 1.5: Device-page labels and the OD-11 default (API + web)

**Files:**
- Create: `apps/web/src/components/devices/promptRenderer.ts` + `.test.ts`
- Modify:
  - `DeviceInfoTab.tsx:1313-1329`
  - 8 × `locales/<code>/devices.json` (`deviceInfoTab.helperInstallIssue.{webview2Outdated,crashLoop,unmanagedInstall}`, `deviceInfoTab.assistStatus.{installed,unavailable,notDeployed}`)
  - `components/configurationPolicies/featureTabs/HelperTab.tsx` (new link initial `enabled: true`)
  - `apps/api/src/services/configurationPolicy.ts` (helper feature-link **create** path stores `enabled: true` when the body omits it; update paths unchanged)
- Test: `services/configurationPolicy.test.ts`

**Interfaces:** `derivePromptRenderer({ helperVersion, helperInstallIssue }): { status: 'installed' | 'unavailable' | 'notDeployed'; issue?: string }`. A non-null issue gives `unavailable`; otherwise a version gives `installed`; otherwise `notDeployed` (P1 wording).

- [ ] **Step 1: Failing tests.**
  - The derivation table, including `webview2_outdated` → unavailable.
  - `creates a helper feature link with enabled:true when omitted`.
  - `updating a helper link without enabled does not flip it`.
  - `HELPER_DEFAULTS.enabled stays false`.
- [ ] **Step 2:** Run both vitest files → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Both files PASS. Run `localeParity.test.ts` and the web and API typechecks.
- [ ] **Step 5: Commit** `feat(web): show Breeze Assist availability and default new helper policies to deploy (#10183)`.

### Task 1.6: W01 verification and lab legs

- [ ] `cd agent && go test -race ./internal/helper/... ./internal/heartbeat/...` (heartbeat for `helper_install_issue_test.go`), plus the Assist and web suites. Paste the evidence into each PR.
- [ ] **Todd lab legs (before the agent promote; the Assist build passes before publish):**
  - Windows 11 21H2 with inbox WebView2 90.x: Assist is refused with the reason in the log, the badge says unavailable, and prompts use native.
  - Kill Assist 6 times: `crash_loop`, with exit codes in the log.
  - Hand-installed Assist with deploy off: left alone and reported `unmanaged_install`.
  - Upgrade over an agent-installed Assist, then deploy off: removed.
  - Failed Assist update rolled back: still launches (P12).

---

# W02 — Prompt contract, shipped dormant

Spec §3.1, §3.2 (store), §3.7 (selection), and §8 (fixtures, skew). Every renderer advertises **zero kinds**, so no `prompt_*` is sent outside tests (P2). The endpoint-message store change is real and rollback-safe (P5). **If W03 never ships:** behaviour is unchanged, the message store is generalised, and the technician sees the live renderer observation.

| PR | Owns | Merge order |
|---|---|---|
| 2A shared contract | `packages/shared/src/promptHost/{kinds.ts,schema.ts,index.ts,promptHost.test.ts}`, `packages/shared/src/fixtures/prompt-host/*.json` | first |
| 2B agent core | `agent/internal/ipc/{prompt.go,prompt_kinds.go,message.go}`, `agent/internal/sessionbroker/broker.go` (grant, routing, send guard), `agent/internal/prompthost/**` (new) + tests | after 2A |
| 2C agent inbox + native + heartbeat | `agent/internal/inbox/**` (new), `heartbeat/message_store.go` (thin wrapper), `userhelper/prompt_native*.go` (new), `heartbeat/heartbeat.go` (enabledKinds, telemetry), `Makefile` (winres check) | after 2B |
| 2D Assist | `apps/helper/src-tauri/src/ipc/{prompt.rs,client.rs,desktop.rs}`, `src-tauri/capabilities/prompt-card.json`, `src/prompt/**`, `src/main.tsx`, `src/App.tsx` (Notifications tab), `src-tauri/src/lib.rs` (tray item) | after 2A (parallel with 2B/2C) |
| 2E API | `apps/api/src/services/{promptHostConfig.ts,promptHostObservation.ts}` (new), `routes/agents/{schemas.ts,heartbeat.ts}`, `routes/devices/core.ts`, `.env.example` | after 2A (any time) |

### Task 2.1: Golden fixtures and the shared schema (2A)

**Files:**
- Create: `packages/shared/src/promptHost/kinds.ts`, which exports `PROMPT_KINDS` with every kind and its copy class, its scope, and the wave that ships it, taken from the spec's kind registry.
- Create: `schema.ts` (Zod for every message and for the `AuthRequest` additions).
- Create these fixtures under `packages/shared/src/fixtures/prompt-host/`: `show.notice.json`, `show.restart.json`, `show.elevation.waiting.json`, `update.state.json`, `close.fenced.json`, `presented.json`, `action.json`, `action_result.accepted.json`, `action_result.rejected_stale.json`, `closed.render_failed.json`, `branding_sync.set.json`, `branding_sync.cleared.json`, `auth.prompt_v1.json`, `auth.legacy.json`, `heartbeat.prompt_host.json`, `skew-matrix.json`.

**Interfaces:**
- Produces the fixture files that 2B, 2C and 2D decode.
- `skew-matrix.json` rows: `{ agentSpeaks: string[], rendererAdvertises: string[] | null, enabled: string[], expectedPath: 'prompt' | 'legacy' }`. They cover spec §8:
  - new agent + old Assist;
  - old agent + new Assist;
  - new + new;
  - native only;
  - kind disabled;
  - `kind@n` versus a bare `kind` entry;
  - an old native process surviving an update.

- [ ] **Step 1: Failing test** `promptHost.test.ts`.
  - Every fixture parses with its schema.
  - Every `show.*` decision fixture has exactly one `safe` action named by `defaultActionId`.
  - Every kind in `PROMPT_KINDS` has the class given in spec §3.1.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/promptHost` → FAIL.
- [ ] **Step 3:** Write the schemas and fixtures. Field names are exactly those in spec §3.1, in lowerCamel.
- [ ] **Step 4:** PASS. Run the shared typecheck.
- [ ] **Step 5: Commit** `feat(shared): prompt host contract schema and golden fixtures (#10190)`.

### Task 2.2: IPC types, advertisement, scopes and the broker send guard (2B)

**Files:**
- Create: `agent/internal/ipc/prompt.go` (types and constants), `prompt_kinds.go` (class table for all six kinds).
- Modify: `ipc/message.go:249-288` (`AuthRequest`), `sessionbroker/broker.go` (`grantScopes` :2908, `applyAuthAdvertisements` :2953, inbound routing near :3395/:3433).
- Test: `ipc/prompt_contract_test.go`, `sessionbroker/broker_prompt_test.go`.

**Interfaces:**
- Produces:
  - IPC constants: `ipc.TypePrompt*` (8 types), `ipc.ScopePrompt`, `ipc.ScopePromptOperator`, `ipc.PromptProtocolVersion = 1`.
  - Message structs: `ipc.PromptShow`, `PromptUpdate` (pointer fields: present means replace), `PromptClose`, `PromptPresented`, `PromptActionRequest` (wire `prompt_action`), `PromptActionResult`, `PromptClosed`, `PromptBrandingSync`.
  - Sub-structs: `PromptLease{RendererSession string; Epoch uint32}`, `PromptAction{ID, Label, Role string}`, `PromptCopy`, `PromptFact`, `PromptTiming`, `PromptExpiry`, `PromptListEntry`, `PromptIdentityRef`.
  - `func PromptKindClass(kind string) (PromptCopyClass, bool)`
  - `func ParsePromptKindAd(s string) (name string, version int, ok bool)`
  - Session accessors: `func (s *Session) PromptKindVersion(kind string) (int, bool)`, `func (s *Session) PromptProtocol() int`, `func (s *Session) RendererVersion() string`.
  - `func (b *Broker) SendPrompt(sessionKey, msgType, kind string, payload any) error`, which returns `ErrPromptScopeMissing` when the kind is not granted.
  - `type PromptSink interface{ HandleRendererMessage(s *Session, msgType string, raw json.RawMessage) (string, any) }`, set with `b.SetPromptSink`.
- Role rules:
  - `assist`: any kind.
  - `user`: any kind except `elevation.request`.
  - `system`: only `elevation.request`.
  - Kinds unknown to the class table are ignored.

- [ ] **Step 1: Failing tests.**
  - `TestPromptFixturesRoundTrip`: each `prompt-host` fixture decodes into its Go type and re-encodes to the same canonical JSON. Read the fixtures with `filepath.Join("..","..","..","packages","shared","src","fixtures","prompt-host",…)`, the `handlers_actuate_test.go:447` precedent.
  - `TestAuthRequestPromptFieldsAreAdditive`: a zero `AuthRequest` marshals without the new keys.
  - `TestPromptScopeNotGrantedWithoutAdvertisement`.
  - `TestOperatorScopeOnlyForOperatorKinds`.
  - `TestSystemRoleGetsOnlyElevationKind`.
  - `TestSendPromptRefusesUngrantedKind`.
  - `TestPromptMessageWithoutScopeIsDropped`: it takes the existing unauthorized path, not the sink.
  - `TestProtocolVersionUnchanged` (`ipc.ProtocolVersion == 1`).
- [ ] **Step 2:** `cd agent && go test -race ./internal/ipc/ ./internal/sessionbroker/ -run 'Prompt|ProtocolVersionUnchanged'` → FAIL.
- [ ] **Step 3:** Implement. Clamp the protocol the same way as `consentProtocolFromAuth` (:2933). Store only the granted kinds on the session.
- [ ] **Step 4:** PASS. Run `go test -race ./internal/ipc/... ./internal/sessionbroker/...`.
- [ ] **Step 5: Commit** `feat(agent): prompt IPC types, per-kind advertisement and scopes (dormant) (#10190)`.

### Task 2.3: `prompthost` core — registry, leases, transitions, timers, selection (2B)

**Files:**
- Create in `agent/internal/prompthost/`: `host.go`, `registry.go`, `lease.go`, `timers.go`, `select.go`, `tombstones.go`, `replay.go`, `ratelimit.go`.
- Tests: `host_test.go`, `select_test.go`, `timers_test.go`.

**Interfaces:**
- Produces:
  - `type KindSpec struct{ Name string; Version int; Transitions map[ipc.PromptState]map[string]ipc.PromptState; Linger time.Duration }`
  - `type Owner struct{ WinSessionID uint32; UserSID, LogonID string; UID int; UnixSession string }` and `func (o Owner) Key() string`
  - `type Prompt struct{ ID string; Kind KindSpec; Owners []Owner; Show ipc.PromptShow; Legacy func(Owner) error; Headless func() error; OnAction func(actionID string, from Owner) (ActionOutcome, error); OnExpire func() }`
  - `type ActionOutcome struct{ Accepted bool; Patch *Patch; Close *ipc.PromptCloseReason }`
  - `func New(deps Deps) *Host`, where `Deps{ Broker RendererDirectory; Inbox PromptInbox; Clock Clock; Log *slog.Logger }`
  - `(h *Host) Show(p Prompt) error`, which is idempotent by `ID`
  - `Update(id string, p Patch) error`
  - `Close(id string, r ipc.PromptCloseReason) error`
  - `HandleRendererMessage(...)`, which satisfies `PromptSink`
  - `RendererConnected(s RendererSession)`
  - `RendererDisconnected(sessionKey string)`
  - `SetEnabledKinds(entries []string)`
  - `SessionStateChanged(winSession uint32, ev SessionEvent)`
  - `func selectRenderer(kind string, ver int, o Owner, dir RendererDirectory, enabled EnabledKinds) Choice`, returning `Path` ∈ `PathPrompt | PathLegacy | PathHeadless | PathNone`.
- Rules:
  - Spec §3.1 rules 1, 4 and "Choosing a renderer".
  - Exactly one authorized renderer per prompt per session.
  - The lease epoch is bumped before a move.
  - `prompt_close{fenced}` goes to a reachable stale renderer.
  - Grace of 10 s, then the native renderer with the remaining budget.
  - Replay without activation, restoring at most one decision surface.
  - Tombstones last 24 h.
  - Rate limits as in Global Constraints.
  - **Deadlines are checked against `clock.Now()` on a 1 s tick, not a monotonic `AfterFunc`**, so a sleep across a deadline fires on resume.
  - P15: disable means new prompts only.

- [ ] **Step 1: Failing tests.** All use a fake clock, a fake directory and fake renderers.
  - `TestShowIsIdempotentByPromptID`.
  - `TestStaleLeaseActionRejected`.
  - `TestDuplicateActionAcceptedOnce`.
  - `TestDecisionWithoutSingleSafeDefaultRefused`.
  - `TestPresentBudgetMissFallsBack` (10 s).
  - `TestAssistDisconnectGraceThenNativeWithRemainingBudget`.
  - `TestReconnectClosesNativeCopyAndReplaysWithoutActivation`.
  - `TestTombstoneBlocksResurrection`.
  - `TestRemainingBudgetPreservedAcrossFallback`.
  - `TestDisableKindMidDecisionKeepsPresentedPrompt` (P15).
  - `TestAbsoluteDeadlineFiresAfterSleepPastIt`: the clock jumps 2 h past the deadline and expiry fires exactly once (Review Focus 2).
  - `TestSelectFollowsSkewMatrix`, table-driven from `skew-matrix.json`.
  - `TestSelectExactlyOneRendererWithOldNativeAndNewAssist` (Review Focus 1).
  - `TestCardRateLimitGoesListOnly` (10 per 10 min).
- [ ] **Step 2:** `go test -race ./internal/prompthost/...` → FAIL.
- [ ] **Step 3:** Implement. No kind is registered in production code yet: the host is constructed and wired as the broker's `PromptSink` with an empty registry.
- [ ] **Step 4:** PASS. Run with `-count=3` to catch flaky timing.
- [ ] **Step 5: Commit** `feat(agent): prompt host core with leases, transitions and fallback (dormant) (#10190)`.

### Task 2.4: Generalised inbox with ownership (2C)

**Files:** Create: `agent/internal/inbox/{store.go,owner.go,store_test.go}`. Modify: `agent/internal/heartbeat/message_store.go`, which keeps its public methods and delegates to `inbox.Store`.

**Interfaces:**
- Produces:
  - `func Open(path string, o Options) (*Store, error)`, where `Options{ MaxPerOwner int; EntryTTL, TombstoneTTL time.Duration }`
  - `Put(e Entry) error`
  - `Pending(ownerKey string) []Entry`
  - `Retract(id string)`
  - `Tombstone(id string)`
  - `PurgeScope(scopeID string) int`
  - `Entry{ ID, Source /* "message"|"prompt" */, OwnerKey, ScopeID string; ExpiresAt time.Time; Payload json.RawMessage }`
  - `type Inbox struct{ Messages, Prompts *Store }` with `func (i Inbox) ListFor(ownerKey string) []Entry` (the merged view, P5)
- File compatibility:
  - The messages file keeps its path and record format. `owner` is optional.
  - A record with no owner is replayed to the next session that connects and is then bound to that owner.

- [ ] **Step 1: Failing tests.**
  - `TestLegacyMessageFileLoadsUnchanged`: a pre-W02 `endpoint_messages.json` fixture loads, and a re-save round-trips the old fields byte-for-byte except the added `owner`.
  - `TestMessageTombstonesStay168h`.
  - `TestPromptTombstones24h`.
  - `TestEntriesNeverCrossOwners`.
  - `TestUnownedLegacyEntryBindsToFirstOwner`.
  - `TestPurgeScopeRemovesOnlyThatScope`.
  - `TestCapIs50PerOwner`.
  - The existing `heartbeat/message_store_test.go` and `message_events_test.go` pass unchanged.
- [ ] **Step 2:** `go test -race ./internal/inbox/... ./internal/heartbeat/ -run 'Message|Inbox'` → FAIL.
- [ ] **Step 3:** Implement, with atomic writes.
- [ ] **Step 4:** PASS. Run `go test -race ./internal/heartbeat/...`.
- [ ] **Step 5: Commit** `refactor(agent): generalise the endpoint-message store into an owner-bound inbox (#10190)`.

### Task 2.5: Native renderer in the user-helper, heartbeat `enabledKinds`, telemetry (2C)

**Files:**
- Create: `agent/internal/userhelper/prompt_native.go` (untagged model), `prompt_native_windows.go`, `prompt_native_darwin.go`, `prompt_native_linux.go`, `prompt_native_test.go`.
- Modify: `heartbeat/heartbeat.go`:
  - response gets `PromptHost *PromptHostSettings json:"promptHost,omitempty"` with `EnabledKinds []string`;
  - request `helperCapabilities` gets `PromptHost *promptHostTelemetry`.
- Modify: `heartbeat/caller_verify.go:172` (`callerHelperCapabilities` gains the field), `Makefile` (fail the Windows build when `rsrc_windows_amd64.syso` is missing for `breeze-user-helper`).

**Interfaces:**
- Produces:
  - `func buildNativePromptModel(p ipc.PromptShow) (nativePromptModel, error)`
  - `nativePromptModel{ Title, Body string; Buttons []nativeButton; DefaultID, CancelID string; Deadline time.Time }`
  - Errors: `errNoSafeDefault`, `errOperatorTextOnBreezeKind`
  - Windows `showNativePromptOS`, via `TaskDialogIndirect`:
    - flags `TDF_ALLOW_DIALOG_CANCELLATION | TDF_CALLBACK_TIMER`;
    - custom buttons with the real labels;
    - `nDefaultButton` = safe;
    - Esc → safe;
    - if `TaskDialogIndirect` cannot be resolved (comctl32 v5), fall back to `MessageBoxTimeoutW` with the safe default.
  - macOS: `osascript … default button "<safe>" cancel button "<safe>" giving up after <n>`.
  - Linux: `zenity --question --ok-label <proceed> --cancel-label <safe> --default-cancel --timeout <n>`. A neutral third action is dropped on macOS and Linux and still reachable from the list.
  - The native helper advertises `promptProtocolVersion: 1` and `promptKinds: []` in W02.
- Heartbeat rules:
  - An absent `promptHost` block in the heartbeat response means an empty list (fail to legacy).
  - Telemetry `{protocolVersion, kinds, rendererVersion}` describes the active console session's Assist; it is empty if there is none.

- [ ] **Step 1: Failing tests** (untagged).
  - `TestNativeModelDefaultIsSafe`.
  - `TestNativeModelEscMapsToSafeInPendingDecision`.
  - `TestNativeModelRefusesNoSafeDefault`.
  - `TestNativeModelRefusesOperatorNoteOnBreezeKind`.
  - `TestHeartbeatAbsentPromptHostMeansEmpty`.
  - `TestHeartbeatTelemetryReportsConsoleAssistAdvertisement`.
- [ ] **Step 2:** `go test -race ./internal/userhelper/ ./internal/heartbeat/ -run 'NativeModel|PromptHost'` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS. `GOOS=windows go vet ./internal/userhelper/` and `GOOS=darwin go vet ./internal/userhelper/` are clean.
- [ ] **Step 5: Commit** `feat(agent): native prompt renderer with safe defaults and the enabledKinds switch (dormant) (#10190)`.

### Task 2.6: Assist host — Rust tracker, windows, React card and list (2D)

**Files:**
- Create: `apps/helper/src-tauri/src/ipc/prompt.rs`, `src-tauri/capabilities/prompt-card.json`.
- Create in `src/prompt/`: `PromptCard.tsx`, `PromptCardWindow.tsx`, `NotificationsTab.tsx`, `countdown.ts`, `placeholders.ts`, `a11y.ts`, and tests for each.
- Modify: `client.rs` (`AuthRequest` :82-118, `build_auth_request` :156, dispatch :435 with new arms before `_ =>` :653), `desktop.rs` (`show_prompt_window` / `close_prompt_window`, label `prompt-<first 8 hex of sha256(promptId)>`, `place_card`), `src/main.tsx` (hash route `#prompt/<id>`), `src/App.tsx` (Notifications tab), `lib.rs` (tray item `notifications`, hidden while the list is empty).

**Interfaces:**
- Produces:
  - `PROMPT_PROTOCOL_VERSION: u32 = 1`
  - `ADVERTISED_PROMPT_KINDS: &[&str] = &[]` (W02)
  - `PromptTracker::{on_show, on_update, on_close, action, on_disconnect}`. `on_show` returns `Render | Replace | DropStale | RenderFailed(reason)`. `action` refuses while an earlier action is unacknowledged. `on_disconnect` drops every pending action, so nothing is replayed.
  - `fn place_card(work_area: Rect, size: Size, index: usize) -> Position`: bottom-right of the work area of the monitor holding the cursor, stacked at most 3, clamped inside the work area.
  - TS: `formatRemaining(deadlineMs: number, nowMs: number): string` gives `M:SS` and floors at `0:00`. `applyPlaceholders(text, nowMs, locale)` replaces only `{remaining}` and `{time:<unixMs>}`. `shouldAnnounce(prevS, nowS): boolean` is true only when crossing 60, 30 or 10.
- Invariants:
  - #8138 holds: nothing in `prompt.rs` shows the main window. Add a source-scan guard next to the `message.rs` one at `lib.rs:2132-2171`.
  - Every `prompt_*` type the tracker cannot render is answered with `prompt_closed{render_failed}`. Unknown non-prompt types keep today's silent arm.

- [ ] **Step 1: Failing tests.**
  - Rust:
    - `prompt_fixtures_round_trip`, via `include_str!("../../../../../packages/shared/src/fixtures/prompt-host/…")`.
    - `stale_rev_dropped`.
    - `unadvertised_kind_render_failed`.
    - `breeze_kind_with_operator_note_refused`.
    - `no_replay_of_unacked_action_after_disconnect`.
    - `place_card_clamps_to_work_area`.
    - `prompt_rs_never_shows_main_window` (source scan).
  - TS:
    - `formatRemaining floors at 0:00`.
    - `applyPlaceholders leaves {{countdown}} and unknown braces literal`.
    - `shouldAnnounce only at 60/30/10`.
    - `PromptCard: safe action is first in tab order and focused`.
    - `Esc triggers the safe action on a pending decision and hide otherwise`.
- [ ] **Step 2:** `cd apps/helper/src-tauri && cargo test --locked --lib prompt` and `cd apps/helper && npx vitest run src/prompt` → FAIL.
- [ ] **Step 3:** Implement. Bump the Assist version.
- [ ] **Step 4:** Both suites PASS. Run `cargo test --locked --lib` (all of it) and `npx vitest run`.
- [ ] **Step 5: Commit** `feat(assist): prompt host renderer, notification list and tray entry (dormant) (#10190)`.

### Task 2.7: API — `promptHost.enabledKinds` and the renderer observation (2E)

**Files:**
- Create: `apps/api/src/services/promptHostConfig.ts` + test, `services/promptHostObservation.ts` + test (both go into the parkedFanout classification).
- Modify: `routes/agents/schemas.ts` (`helperCapabilities` :228 gains `promptHost`), `routes/agents/heartbeat.ts` (response block, always present; observation write next to `recordWorkstationCapabilities` :2410), `routes/devices/core.ts` (:1367 / :1586 expose `promptHost`), `.env.example` (`PROMPT_HOST_ENABLED_KINDS=`, commented, generic).

**Interfaces:**
- Produces:
  - `DEFAULT_ENABLED_PROMPT_KINDS: readonly string[] = []`
  - `parseEnabledPromptKinds(raw: string | undefined): string[]`: unset gives the default; `""` gives `[]`; entries outside `PROMPT_KINDS`, or malformed `kind@n` entries, are dropped with one warning.
  - `recordPromptHostObservation(deviceId, obs | undefined)` and `readPromptHostObservation(deviceId)`, using Redis key `prompt-host:<deviceId>` with a TTL of 180 s. Reads fail closed to `null` and are logged.
- Schema: `promptHost` is `{ protocolVersion: int 0–16, kinds: string[] ≤ 16 matching /^[a-z]+(\.[a-z_]+)+@\d{1,3}$/, rendererVersion: string ≤ 32 }`, `.optional().catch(undefined)`.

- [ ] **Step 1: Failing tests.**
  - The parse table (unset, empty, valid, unknown kind, bad version).
  - `heartbeat response always carries promptHost.enabledKinds`.
  - `malformed helperCapabilities.promptHost does not fail the heartbeat`.
  - `device detail returns null promptHost when no observation`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/promptHost src/routes/agents/heartbeat` → FAIL.
- [ ] **Step 3:** Implement. Do not add a `devices` column.
- [ ] **Step 4:** PASS. Run the parkedFanout contract and the typecheck.
- [ ] **Step 5: Commit** `feat(api): prompt host kill switch and live renderer observation (#10190)`.

### Task 2.8: W02 verification

- [ ] **Full suites:** `go test -race ./...` (agent), `cargo test --locked --lib` and `npx vitest run` (Assist), shared, the API unit suite, and the API typecheck.
- [ ] **Todd lab legs (regression only):**
  - Endpoint message send/ack/retract/replay after the agent update **and after an agent rollback** to the previous release.
  - Plain Assist start shows no window (#8138).
  - The technician's device page shows the live observation.

---

# W03 — Copy and identity

Spec §3.1 ("Who renders copy"), §3.6, OD-2 (a). **If W04 never ships:** caller-verify and endpoint messages resolve the MSP identity through one function, and the agent caches the identity offline. No prompt kind is live.

| PR | Owns | Merge order |
|---|---|---|
| 3A shared catalog | `packages/shared/src/promptCatalog/{index.ts,negotiate.ts,sanitize.ts,catalog/common.json,promptCatalog.test.ts}`, fixtures `locale-negotiation.json` and `identity-name-sanitize.json`, `agent/internal/promptcatalog/**` (embed copy + tests) | first |
| 3B API identity | `services/promptIdentity.ts`, `services/promptIdentityLogo.ts` (new), `routes/agents/promptIdentityLogo.ts` (new), `routes/agents/{index.ts,schemas.ts,heartbeat.ts}`, `services/endpointMessaging/brandingSnapshot.ts`, `services/callerVerification/helperBranding.ts`, `packages/shared/src/utils/brandContrast.ts` (moved from `services/helperBrandingContrast.ts`, re-exported there) | after 3A |
| 3C agent | `agent/internal/promptidentity/**` (new), `heartbeat/heartbeat.go` (block + capability), `ipc/message.go` (`UILocale`), `userhelper` locale probe, `prompthost` branding sync + locale | after 3A (parallel with 3B) |
| 3D Assist | `client.rs` (`uiLocale`, `prompt_branding_sync` arm), `src/prompt/{IdentityHeader.tsx,identity.ts,chrome.ts}`, `vite.config.ts` / `tsconfig.json` / `vitest.config.ts` alias, `tauri.conf.json` CSP `img-src blob:`, `lib.rs` (tray label via `include_str!`) | after 3A |

### Task 3.1: Catalog, negotiation and sanitization (3A)

**Interfaces:**
- Catalog file shape: `catalog/<ns>.json` = `{ "namespace": "<ns>", "messages": { "<key>": { "en": "…", "de-DE": "…", …8 } } }`. Parameters are named, as `{name}`. `{remaining}` and `{time:<unixMs>}` are renderer-owned and pass through untouched.
- TS: `PROMPT_LOCALES`, `type PromptLocale`, `negotiatePromptLocale(tag: string): PromptLocale`, `renderPromptMessage(ns, key, locale, params): string`, `sanitizePromptPartnerName(raw: string): string | null`.
- Go (`agent/internal/promptcatalog`): `Negotiate(tag string) Locale`, `Render(loc Locale, ns, key string, params map[string]string) (string, error)` (errors on an unknown key or a missing parameter), `SanitizeIdentityName(raw string) string`.
- Negotiation rules, case-insensitive with `_` normalised to `-`:
  - an exact match among the eight wins;
  - `fr-CA` matches exactly only;
  - other `fr*` → `fr-FR`;
  - `es*` → `es-419`;
  - `pt*` → `pt-BR`;
  - `de*` → `de-DE`;
  - `it*` → `it-IT`;
  - `tr*` → `tr-TR`;
  - `en*` → `en`;
  - anything else → `en`.
- Sanitize rules:
  - strip C0/C1 controls;
  - strip U+202A–U+202E, U+2066–U+2069, U+200B–U+200D, U+2060 and U+FEFF;
  - collapse whitespace and trim;
  - cap at 120 code points;
  - empty → null (the generic name).
- `common.json` keys: `identity.generic` ("your IT support team"), `chrome.notifications`, `chrome.notificationsCount` (`{count}`), `chrome.showMore`, `chrome.showLess`, `chrome.working`, `chrome.hide`, `chrome.emptyList`, `chrome.remainingAnnounce` (`{seconds}`), `native.windowTitle` (`{partner}`).

- [ ] **Step 1: Failing tests.**
  - TS:
    - key parity across the 8 locales;
    - non-empty strings;
    - equal placeholder sets per key;
    - no `<` or `>`;
    - every row of `locale-negotiation.json`, including `en-GB`, `pt-PT`, `es-ES`, `fr-BE`, `zh-CN`, `""` and `fr_CA.UTF-8` (Review Focus 4);
    - every row of `identity-name-sanitize.json` (Review Focus 3).
  - Go:
    - `TestEmbeddedCatalogMatchesSharedSource` (same file set, byte-identical);
    - `TestNegotiateFixture` and `TestSanitizeFixture` over the same fixtures;
    - `TestRenderMissingParamErrors`.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/promptCatalog` and `cd agent && go test -race ./internal/promptcatalog/...` → FAIL.
- [ ] **Step 3:** Implement. The `en` copy is written first. The 7 translations follow `apps/web/src/locales/TERMINOLOGY.md`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(shared): prompt catalog in eight locales with Go embed parity (#10190)`.

### Task 3.2: `resolvePromptIdentity`, the heartbeat block and the logo route (3B)

**Interfaces:**
- `resolvePromptIdentity(orgId: string): Promise<PromptIdentity | null>` returns `{ scopeId, partnerName, primaryColor?: '#RRGGBB', logoSource?: string }`.
  - The name is `sanitizePromptPartnerName(partners.name)`.
  - Logo and colour go partner settings → `resolveDocumentBrand` org override. The name is **never** overridden.
  - It is cached through `readDevicePolicyCache` / `writeDevicePolicyCache('prompt-identity', …)`, 120 s.
- `loadPromptIdentityLogo(source): Promise<{ sha256, mime, bytes } | null>`. It decodes `data:`, or fetches `https://` once through `checkSsrfSafe`, then calls `validatePromptLogo`. The result is cached in Redis under `prompt-identity-logo:<sha256(source)>` for 3600 s; a failure is cached for 600 s.
- `validatePromptLogo(buf: Uint8Array): { mime, width, height } | null` parses headers only, with no new dependency:
  - PNG: magic `89 50 4E 47 0D 0A 1A 0A`, dimensions from IHDR;
  - JPEG: `FF D8 FF`, dimensions from the SOFn scan;
  - WebP: `RIFF….WEBP`, dimensions from VP8, VP8L or VP8X;
  - more than 262 144 bytes, or more than 1024 px on a side → null.
- `resolveMessageBranding` and `callerHelperBranding` call the resolver (OD-2 (a)). The caller-verify logo source changes from the partner login-page logo to Partner → Branding; note this in the release notes.
- The heartbeat sends `promptIdentity: { state: 'set', scopeId, partnerName, primaryColor?, logo?: { sha256, mime, bytes } }` only when `securityCapabilities.promptIdentityProtocolVersion === 1`, a schema member with `.optional().catch(undefined)` and no column (the retainState precedent, `heartbeat.ts:2963`). If resolution fails, the block is omitted.
- The route `GET /api/v1/agents/:id/prompt-identity/logo?sha256=<hex>` sits under agent auth. It returns the bytes with the stored mime, or 404 when the sha is not current. The `routerAuthGate` and `writeRoutePermissionGate` contracts stay green.

- [ ] **Step 1: Failing tests.**
  - `name is never taken from portal_branding`.
  - `org override wins for logo and colour`.
  - `svg / 300 KB / 2048 px / http:// / private-IP https refused`.
  - `png, jpeg, webp accepted with dimensions`.
  - `data: URL decoded`.
  - `block omitted for agents without the capability`.
  - `logo route 404 on stale sha`.
  - `caller-verify branding now comes from the resolver`.
  - `endpoint-message snapshot unchanged for partners with no portal override`.
- [ ] **Step 2:** `npx vitest run src/services/promptIdentity src/routes/agents/promptIdentityLogo src/services/endpointMessaging src/services/callerVerification` → FAIL.
- [ ] **Step 3:** Implement. Add the two new services files to parkedFanout.
- [ ] **Step 4:** PASS. Run the typecheck and the contract suites.
- [ ] **Step 5: Commit** `feat(api): one MSP identity resolver for device prompts, with a validated logo route (#10190)`.

### Task 3.3: Agent identity cache, locale and branding sync (3C)

**Interfaces:**
- `promptidentity.Store`:
  - `Apply(b *HeartbeatBlock) (changed, scopeChanged bool, err error)`: `set` stores; `cleared` deletes; absent keeps.
  - `Clear()`, called from the enrollment success path.
  - `Current() (Identity, bool)`.
  - `FetchLogo(ctx, sha string) error` uses the authenticated API client, checks the sha256 of the bytes, and keeps the last-known logo on failure.
- Files go in `<agent data dir>/branding/{identity.json,logo.bin}`, SYSTEM-owned and readable by users. Reuse the agent's existing ACL helper for user-readable files (grep the agent's other user-readable files and reuse that call).
- **On a `scopeChanged`:** call `inbox.Prompts.PurgeScope(old)` and clear the identity before anything else from that heartbeat is applied.
- `ipc.AuthRequest.UILocale` probes per platform:
  - Windows: `GetUserDefaultUILanguage` → `LCIDToLocaleName`;
  - macOS: first entry of `defaults read -g AppleLanguages`;
  - Linux: `LC_ALL`, then `LC_MESSAGES`, then `LANG`.
- The session locale is `promptcatalog.Negotiate(session.UILocale)`, falling back to the OS UI language and then `en`. The SYSTEM role borrows the locale of a user session in the same Windows session.
- `compiledSecurityCapabilities()` (`heartbeat.go:8686`) adds `PromptIdentityProtocolVersion: 1`.
- `prompthost` sends `prompt_branding_sync{ state, scopeId, partnerName, primaryColor, logo{ sha256, mime, base64 }, locale }` on renderer connect and on every change, to sessions holding any prompt scope.

- [ ] **Step 1: Failing tests.**
  - `TestApplySetClearedAbsent`.
  - `TestScopeChangePurgesPromptEntriesFirst`.
  - `TestReenrolClearsIdentity`.
  - `TestLogoShaMismatchKeepsLastKnown`.
  - `TestNegotiatedLocalePerSession`.
  - `TestBrandingSyncOnConnectAndChange`.
  - `TestCapabilityAdvertised`.
- [ ] **Step 2:** `go test -race ./internal/promptidentity/... ./internal/prompthost/... ./internal/heartbeat/ -run 'Identity|Locale|BrandingSync|Capability'` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, then run the full agent suite.
- [ ] **Step 5: Commit** `feat(agent): cache the MSP identity offline and negotiate the session locale (#10190)`.

### Task 3.4: Assist identity header and chrome strings (3D)

**Interfaces:**
- `AuthRequest.uiLocale` comes from the `sys-locale` crate, a new dependency; review its licence and transitive dependencies in `Cargo.lock`.
- `IdentityHeader({ identity })` renders the logo from a Blob object URL, plus the partner name.
  - The accent colour is used only when `isReadableBrandColor` (from `brandContrast.ts`, through the alias) passes against the card background. Otherwise the default palette is used.
  - High-contrast mode and the OS text size always win.
- `chromeString(key, locale, params)` reads the `common` namespace through the alias `@prompt-catalog` → `../../packages/shared/src/promptCatalog/catalog`.
- `tauri.conf.json` CSP adds `img-src blob:`.

- [ ] **Step 1: Failing tests.**
  - `IdentityHeader falls back to the generic name when identity is cleared`.
  - `unreadable brand colour replaced by the default`.
  - `chrome strings render in the prompt's locale` (de-DE).
  - Rust: `branding_sync_cleared_drops_identity` and `auth_request_carries_ui_locale`.
- [ ] **Step 2:** Run both suites → FAIL.
- [ ] **Step 3:** Implement. Bump the Assist version.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(assist): MSP identity header and localized chrome (#10190)`.

### Task 3.5: W03 verification and lab legs

- [ ] Run every suite named in Tasks 3.1–3.4, plus the API typecheck and parkedFanout.
- [ ] **Todd lab legs:**
  - The caller-verify card shows the Partner → Branding logo, with the portal override where one is set (the visible OD-2 change).
  - A de-DE Windows user receives the German identity and chrome.
  - An offline device keeps its identity across an agent restart.
  - Moving a device to another org purges its prompt list entries.

---

# W04 — Notices (first enabled kind)

Spec §3.2, §3.5 (endpoint messages), §9 W04. **If W05 never ships:** notices are DND-resistant Assist cards with a list. Restart, consent and elevation stay legacy.

| PR | Owns |
|---|---|
| 4A agent | `agent/internal/promptkinds/{registry.go,notice.go}` (new), `heartbeat/handlers.go:329-344` (safe mode), `heartbeat/consent_gate.go:693` (session ended), TCC path (agent side of `TypeTCCStatus`), `ipc/message.go` (`AuthResponse.AgentHandlesTCCNotice`), `userhelper/tcc_darwin.go` (skip self-toast when the flag is set), `userhelper/notify_state_windows.go` (new, `SHQueryUserNotificationState`), catalog `notice.json` (+ Go copy) |
| 4B Assist | advertise `notice.info@1`; `src/prompt/kinds/notice.tsx`; `src/prompt/Card.tsx` (shared card); `src/components/MessageCard.tsx` renders through `Card`; message entries in `NotificationsTab` |

### Task 4.1: `notice.info` constructors and call sites (4A)

**Interfaces:**
- Constructors:
  - `promptkinds.SafeModeRebootNotice(delay time.Duration, at time.Time) prompthost.Prompt`, with id `notice:safe_mode:<unixMs>`.
  - `MacPermissionNotice(missing []string) prompthost.Prompt`, with id `notice:tcc:<sha8(sorted missing)>` and the action `open_settings` (neutral).
  - `RemoteSessionEndedNotice(sessionID string, d time.Duration, technician string) prompthost.Prompt`, with id `notice:session_ended:<sessionID>`.
- Each one's `Legacy` is today's call.
- **TCC skew rule:**
  - The agent builds the TCC notice only for a helper whose live advertisement has `promptProtocolVersion ≥ 1`.
  - A new helper skips its own toast only when `AuthResponse.AgentHandlesTCCNotice` is true.
  - Old agent + new helper → the helper toasts. New agent + old helper → the helper toasts and the agent does not.
- Native notice rendering uses `SHQueryUserNotificationState`:
  - `QUNS_ACCEPTS_NOTIFICATIONS` → toast.
  - `QUNS_QUIET_TIME` or `QUNS_NOT_PRESENT` → `FallbackDialog`.
  - `QUNS_BUSY`, `QUNS_RUNNING_D3D_FULL_SCREEN` or `QUNS_PRESENTATION_MODE` → hold, re-polling every 30 s until the entry expires.

- [ ] **Step 1: Failing tests.**
  - `TestSafeModeNoticeCopyAndID`.
  - `TestTCCNoticeOnlyForPromptCapableHelper`.
  - `TestNoDoubleTCCNoticeWithOldHelper`.
  - `TestSessionEndedNoticeReplacesToastWhenPromptPath`.
  - `TestNoticeFallsBackToLegacyWhenDisabled`.
  - `TestNativeNoticeHoldsDuringPresentation` (untagged state mapper).
- [ ] **Step 2:** `go test -race ./internal/promptkinds/... ./internal/heartbeat/ -run 'Notice|TCC'` → FAIL.
- [ ] **Step 3:** Implement. Register `notice.info@1` in `promptkinds/registry.go`. The native helper now advertises `notice.info@1`.
- [ ] **Step 4:** PASS, then run the full agent suite.
- [ ] **Step 5: Commit** `feat(agent): safe-mode, permission and session-ended notices on the prompt host (#10190)`.

### Task 4.2: Notice card and the converged message card (4B)

- [ ] **Step 1: Failing tests.**
  - `notice card is non-activating and lists the entry`.
  - `open_settings action sends prompt_action`.
  - `MessageCard renders through Card` (the existing `MessageCard.test.tsx` passes unchanged).
  - `NotificationsTab lists message and prompt entries for this session only`.
  - Rust `advertises_notice_info_v1`.
- [ ] **Step 2:** Run both suites → FAIL.
- [ ] **Step 3:** Implement. The `message_*` wire format is unchanged. Bump the Assist version.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(assist): notice cards and one notification list for messages and prompts (#10190)`.

### Task 4.3: W04 enablement and lab legs

- [ ] Run the full agent and Assist suites.
- [ ] **Release notes:** add `PROMPT_HOST_ENABLED_KINDS` (optional; unset = the code default; `notice.info` to opt in) to the self-hoster section.
- [ ] **Todd lab legs, with `notice.info` enabled on the lab stack:**
  - Windows 11 with DND on (first hour after setup): the safe-mode notice appears as a card and stays in the list.
  - macOS with Focus on: the TCC notice, and Open Settings works.
  - The session-ended card.
  - Kill Assist: the list survives and nothing is activated on replay.
  - Fast user switching: entries stay with their own user.
  - Message cards look identical to before.
- [ ] Then follow compatibility-order step 5 (canary region → promote → clear pins → other region).

---

# W05 — Restart (closes #10181; fixes #4940 residue)

Spec §3.3. **If W06 never ships:** restart prompts are branded, Postpone is the default, the label shows the real time, and every session stays in step.

| PR | Owns |
|---|---|
| 5A agent | `promptkinds/restart.go` (new), `heartbeat/reboot_prompt.go` (:34, :89, :114), `patching/reboot_manager.go` (~680-685), `patching/reboot_plan.go` (after-restart entry before the `windowsRebootArgs` call), `heartbeat/reboot_status_report.go` (`LastUserAction`), `userhelper/notify_prompt_windows.go` (`MB_DEFBUTTON2`, P8), catalog `restart.json` (+ Go copy) |
| 5B Assist | advertise `restart.prompt@1` and `restart.final@1`; `src/prompt/kinds/restart.tsx` |
| 5C API + web | `routes/agents/schemas.ts:291-310` (`lastUserAction`), `routes/agents/heartbeat.ts:1371-1409`, `services/rebootUserActionAudit.ts` (new, parkedFanout); `featureTabs/RebootPromptPreview.tsx` (new) in `PatchTab.tsx`; 8 × `locales/<code>/policies.json` |

### Task 5.1: `restart.prompt` / `restart.final` (5A)

**Interfaces:**
- `promptkinds.RestartPrompt(in RestartPromptInput) prompthost.Prompt` with:
  - `RestartPromptInput{ Generation uint64; ScheduledAt, Deadline time.Time; Deferral patching.DeferralOutcome; MinGap time.Duration; OperatorTitle, OperatorBody, OperatorButton string; Rung RungKind }`
  - id `restart:<Generation>`
- `RestartFinal(gen uint64, at time.Time) prompthost.Prompt` uses `focus: steal`, the single action `ok`, and the OS countdown copy.
- Transitions for `restart.prompt`, pending state:
  - `restart_now` (proceed) → closes the prompt and starts the restart;
  - `postpone` (safe, default) → re-plans through the existing deferral path and sends a `prompt_update` with the new time.
  - `postpone` is present only while `Deferral` allows it **and** the clamp leaves at least `MinGap`.
  - Its label is `restart.postponeUntil` = `Postpone until {time:<unixMs>}`, built from the deferral outcome's new scheduled time.
- Operator copy fills `title`, `body` and the `restart_now` label. Every literal `{{countdown}}` becomes `{remaining}`. Any other `{{…}}` stays literal. Operator copy never fills the header or the Postpone label.
- **Multi-session:**
  - The same id goes out to one renderer per session (`notifyTargets`).
  - The first accepted decision is applied under the reboot manager lock.
  - Other sessions get `rejected_stale` for a crossing click, then a `prompt_update` (new time) or a `prompt_close{resolved}` (restarting).
- **Locked session:** a rung that fires while the session is locked writes only the list entry. The card appears at `WTS_SESSION_UNLOCK` with the remaining time. The restart time never moves.
- **Cancel with a restart pending:** `Close(withdrawn)` plus the list entry `restart.cancelledBy`. Cancel with nothing pending is W00 #10186.
- **After-restart entry:** written per owner before the OS restart command, id `notice:restarted:<gen>`. It is shown at the next sign-in without activation.
- `RebootStatusReport.LastUserAction *RebootUserAction json:"lastUserAction,omitempty"`, with `{Action: "postponed"|"restart_now", AtUnixMs int64, Renderer: "assist"|"native"|"headless"}`.
- **Legacy (P8):** the restart Yes/No box gets `MB_DEFBUTTON2`. The 32000 timeout still maps to no decision. This happens whatever `enabledKinds` says.

- [ ] **Step 1: Failing tests.**
  - `TestPostponeLabelEqualsComputeDeferralClampedTime`.
  - `TestPostponeHiddenWhenBudgetUsedOrClampBelowMinGap`.
  - `TestRestartOperatorCopyPlaceholders`: `{{countdown}}` appears twice, plus an unknown `{{x}}` and a newline (Review Focus 3).
  - `TestRestartConcurrentDecisionsFirstWins` (Review Focus 5).
  - `TestLockedRungListOnlyThenCardAtUnlockSameDeadline`.
  - `TestCancelPendingWithdrawsAndLists`.
  - `TestAfterRestartEntryWrittenBeforeOSRestart`.
  - `TestLastUserActionReported`.
  - `TestLegacyRestartBoxDefaultsToSecondButton`: assert on the flags value built in an untagged helper, `restartPromptFlags()`.
  - `TestRestartFallsBackToLegacyWhenDisabled`.
- [ ] **Step 2:** `go test -race ./internal/promptkinds/... ./internal/patching/... ./internal/heartbeat/ ./internal/userhelper/ -run 'Restart|Postpone|LastUserAction'` → FAIL.
- [ ] **Step 3:** Implement. The restart policy, rungs, deadlines and ledger are unchanged (spec §3.3). The native helper advertises both restart kinds and renders them with `TaskDialogIndirect` (Postpone default).
- [ ] **Step 4:** PASS, then run the full agent suite.
- [ ] **Step 5: Commit** `feat(agent): branded restart prompt with Postpone as the default and sessions in step (#10181)`.

### Task 5.2: Restart cards (5B)

- [ ] **Step 1: Failing tests.**
  - `restart card shows {time:} in local format and live {remaining}`.
  - `Postpone is focused and default`.
  - `final card steals focus once and has only OK`.
  - Rust `advertises_restart_kinds_v1`.
- [ ] **Steps 2–5:** run the suites → FAIL; implement; PASS; bump the version; commit `feat(assist): restart prompt and closing cards (#10181)`.

### Task 5.3: Restart audit and the policy preview (5C)

**Interfaces:**
- Schema: `rebootStatus.lastUserAction` = `{ action: enum, atUnixMs: int, renderer: enum }`, `.optional().catch(undefined)`.
- `recordRebootUserAction(deviceId, orgId, action)`: Redis `SET reboot-user-action:<deviceId>:<atUnixMs> NX EX 604800`. When the set succeeds, it calls `writeAuditEvent` with `device.reboot.user_postponed` or `device.reboot.user_restart_now` and details `{ renderer, deferralsUsed, maxDeferrals, scheduledAt }`.
  - Actions older than 24 h are ignored.
  - Use the actor attribution that existing agent-originated audit events in `heartbeat.ts` use (grep `writeAuditEvent` there), and register the action names wherever audit actions are enumerated (grep `device.reboot`).
- `RebootPromptPreview({ settings, locale })` shows what the user will see:
  - the operator title, body and button, or the catalog defaults through `@breeze/shared`;
  - "Postpone until <now + interval, clamped>" only when `rebootAllowDeferral` is on, marked as the default.

- [ ] **Step 1: Failing tests.**
  - `postpone audit written once per atUnixMs`.
  - `restart_now audit carries renderer`.
  - `stale action ignored`.
  - `malformed lastUserAction does not fail heartbeat`.
  - `preview hides Postpone when deferral off`.
  - `preview shows operator button label`.
- [ ] **Steps 2–5:** FAIL → implement → PASS (plus `localeParity`, typecheck, parkedFanout) → commit `feat(api,web): audit restart decisions and preview the restart card in the policy editor (#10181)`.

### Task 5.4: W05 lab legs

- [ ] **Todd, with `restart.prompt` and `restart.final` enabled on the lab stack:**
  - Windows 11, standard user and admin: every rung, with DND on.
  - Lock during a rung, then unlock.
  - A full-screen game and PowerPoint presenting.
  - Narrator and high contrast.
  - 150 % and 200 % scaling on two monitors.
  - Fast user switching with two users (concurrent decisions).
  - RDP: native `TaskDialogIndirect`, Postpone default.
  - Kill Assist mid-prompt (native after 10 s, same deadline); update Assist mid-prompt; agent update with the prompt open.
  - macOS, current and previous release.
  - Linux GNOME on Wayland and on X11 (zenity).
  - Re-take the restart video after enablement (spec §8).

---

# W06 — Remote support

Spec §3.5, OD-5 (c), OD-6 (b), OD-7 (b). **Blocked on W00 #10187 being merged** (native Deny default); quorum found it absent from `main` at plan time. **If W07 never ships:** consent and the indicator are on Assist, and the user can end a session when policy allows.

| PR | Owns |
|---|---|
| 6A API migration | migration file in the slot the orchestrator assigns; `db/schema/configurationPolicies.ts:538`; `services/configurationPolicy.ts` (:105-140 validators, :1108 write, :1561 read); `routes/partnerApi/configuration.ts` (remote-access canonical key set); `services/aiToolsConfigPolicy.ts`; `routes/remote/helpers.ts` (:525 default, :688 resolver, :762 payload); session end reason → audit `remote.session.ended_by_user` |
| 6B web | `featureTabs/RemoteAccessTab.tsx` toggle; remote session list/detail shows "Ended by the user"; 8 × `locales/<code>/policies.json` + 8 × `locales/<code>/remote.json` |
| 6C agent | `promptkinds/remote.go` (new); `heartbeat/consent_gate.go` (`solicitConsentV2` :253, `afterDesktopStart` :600, banner :637/:659); `ipc` `DesktopPrompt.AllowUserEndSession`; `userhelper/banner_windows.go` (clickable when allowed); native consent on `TaskDialogIndirect`; catalog `remote.json` (+ Go copy) |
| 6D Assist | advertise `remote.consent@1` and `remote.session@1`; `ConsentDialog.tsx` → `kinds/consent.tsx` on `Card` (Deny focused, Esc = deny kept); `SessionBanner.tsx` → clickable pill `kinds/session.tsx`; Request Support pre-filled through the main window hash |

### Task 6.1: `allow_user_end_session` (6A — migration, high blast radius)

**Tenancy shape (state it in the migration header, following the `2026-12-22-110000-patch-restart-prompt-text.sql` precedent):**
- `config_policy_remote_access_settings` has no `org_id` and no `partner_id`. Ownership comes through `feature_link_id → config_policy_feature_links → configuration_policies` (`org_id` XOR `partner_id`).
- It is already partner-wide capable, with RLS from `2026-07-29-remote-access-settings-partner-rls.sql`.
- No new RLS policy is needed. No cascade, merge or export-registry entry is needed, because those key on `org_id`; verify this by grep.
- **The canonical partner-export projection must be re-emitted.** Copy the newest definition of `breeze_partner_export_policy_settings_pre_patch` (find it with `git grep -l` over `apps/api/migrations`, sorted with `localeCompare`) and add `'allowUserEndSession', allow_user_end_session` to the `remote_access` branch. Update the partnerApi canonical key set to match. Otherwise policies export as `blocked`.
- **Snapshot version:** there is none on this path. The value travels in the per-session `start_desktop` prompt block (`buildRemoteSessionPromptPayload`). An absent field on the wire means no End button, which is safe against old servers.

**Interfaces:**
- Migration: `ALTER TABLE config_policy_remote_access_settings ADD COLUMN IF NOT EXISTS allow_user_end_session boolean NOT NULL DEFAULT true;` plus the re-emitted function. It writes no rows, so it needs no `breeze.scope`.
- Validator: `allowUserEndSession: z.boolean().default(true)`, and `.optional()` on patch.
- The prompt payload gains `allowUserEndSession: boolean`.
- An agent report of `endReason: 'ended_by_user'` writes the audit `remote.session.ended_by_user` and sets the session's end reason, so the technician sees why.

- [ ] **Step 1: Failing tests.**
  - `helpers.test.ts`: `payload carries allowUserEndSession from the row`; `defaults true when no row`.
  - `configurationPolicy.test.ts`: round-trip.
  - Integration:
    - `promptConfig.integration.test.ts` (partner-wide policy resolves the field);
    - `partnerApiConfigurationWatermark.integration.test.ts` (export not blocked);
    - `remote-access-settings-rls.integration.test.ts` stays green.
  - `migrationPartnerExportLocks.test.ts` updated if it pins the function.
- [ ] **Step 2:** Run the unit tests → FAIL. Run the integration tests with `pnpm test-stack up` → FAIL.
- [ ] **Step 3:** Implement. Run `pnpm db:check-drift`.
- [ ] **Step 4:** Unit, integration and `test:rls-coverage` all PASS. Run the typecheck. Tear down the test stack.
- [ ] **Step 5: Commit** `feat(api): allow_user_end_session on remote access policy, default on (#10190)`.

### Task 6.2: Remote access policy UI and end reason (6B)

- [ ] **Step 1: Failing tests.** `RemoteAccessTab saves allowUserEndSession`; `session detail shows Ended by the user`.
- [ ] **Steps 2–5:** FAIL → implement (8 locales) → PASS → commit `feat(web): let MSPs choose whether users can end a remote session (#10190)`.
- [ ] **Settings rule 9 statement in the PR:**
  - Home: the remote-access policy feature.
  - Level: partner-wide policy → org policy (existing assignment resolution).
  - Resolver: `resolveRemoteSessionPromptConfig`.
  - Places configured: 0 before, 1 after.

### Task 6.3: `remote.consent` and `remote.session` (6C)

**Interfaces:**
- `promptkinds.RemoteConsent(req ipc.ConsentRequest, cfg DesktopPrompt) prompthost.Prompt`:
  - id `consent:<nonce>`, `modal`, `steal`;
  - pending actions `allow` (proceed) and `deny` (safe, default);
  - `responseMs` = the consent window;
  - expiry text per `consentUnavailableBehavior` ("If no one answers, the session starts in {remaining}" or "…is declined in {remaining}").
  - The decision matrix and occupancy rules (`consent_occupancy.go`) are unchanged.
  - The consent result reports `renderer`.
  - An unavailable renderer is never re-asked.
- `promptkinds.RemoteSession(sessionID string, cfg DesktopPrompt) prompthost.Prompt`:
  - id `session:<sessionID>`, presentation `indicator`;
  - actions `end_session` (only when `cfg.AllowUserEndSession`) and `report_problem`;
  - `end_session` moves to the state `confirm_end`, with `end_confirm` (proceed) and `keep_session` (safe).
  - Confirming calls `endDesktopSessionByUser(sessionID)`, which runs the same stop routine as the `stop_desktop` command and reports `endReason:"ended_by_user"` on the existing session-state report.
- Native:
  - consent uses `TaskDialogIndirect` with "Allow" / "Deny", Deny as the default;
  - the Windows pill drops `WS_EX_TRANSPARENT` only when `AllowUserEndSession` is set; a click opens a native confirm.

- [ ] **Step 1: Failing tests.**
  - `TestConsentDefaultDenyAndEscDeny`.
  - `TestConsentExpiryFollowsBehavior`.
  - `TestConsentRendererReported`.
  - `TestConsentAssistLossNotReasked`.
  - `TestSessionEndOnlyWhenAllowed`.
  - `TestEndSessionRequiresConfirm`.
  - `TestEndedByUserReported`.
  - `TestReportProblemAccepted`.
  - `TestPillClickThroughWhenNotAllowed` (untagged flag builder).
- [ ] **Steps 2–5:** `go test -race ./internal/promptkinds/... ./internal/heartbeat/ -run 'Consent|Session|Pill'` → FAIL → implement → PASS (plus the full agent suite) → commit `feat(agent): remote consent and a clickable session indicator on the prompt host (#10190)`.

### Task 6.4: Consent card and session pill (6D)

- [ ] **Step 1: Failing tests.**
  - The existing `ConsentWindow.test.tsx` assertions (Deny focused, Esc deny) are ported to `kinds/consent.test.tsx`.
  - `pill expands locally without a wire action` (P7).
  - `end session asks for confirmation`.
  - `report a problem opens request support with the session id after accepted`.
  - Rust `advertises_remote_kinds_v1`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → version bump → commit `feat(assist): remote consent card and session pill (#10190)`.

### Task 6.5: W06 lab legs

- [ ] **Todd, with both remote kinds enabled on the lab stack:**
  - Consent as a standard user and as an admin.
  - DND on.
  - RDP: native `TaskDialogIndirect` with Deny as the default.
  - macOS `osascript` and Linux `zenity`, both defaulting to Deny.
  - Kill Assist mid-consent: the decision matrix applies and the user is not asked again.
  - End the session from the pill, both allowed and disallowed.
  - Report a problem.
  - Re-take the remote-support video.

---

# W07 — Elevation, transitional (closes #10178, #10180)

Spec §3.4 (W07 flow), OD-1 (a), OD-7 (b).

**Preconditions:** each of these is merged **and** lab-tested.
- #8971 PR A and PR B (withdraw route, local decline record);
- #8928 PR 1 (`pam_request_notify`, toasts);
- #10177 (kind-aware dismiss);
- W00 #10179 (immediate `pam_apply_v2`).

The action `use_local_credentials` ships only if #8928 PR 2 (`local_credentials`) has merged. Otherwise W07 ships two actions, and the third arrives with PR 2.

**If W08 never ships:** the first question stays native next to UAC (explicitly degraded), and everything after "Send request" is a stateful Assist card.

| PR | Owns |
|---|---|
| 7A API | migration in the slot the orchestrator assigns, widening `elevation_requests_withdrawn_reason_chk` with `user_cancelled` (copy the current clause verbatim from #8971's or #8928's newest migration); `PAM_WITHDRAW_REASONS`; withdraw body gains optional `renderer`; submit body gains optional `firstQuestionRenderer`; `pam_apply_v2` (`jobs/pamActuationCommandPayload.ts:39,78`) and `pam_request_notify` gain `decidedBy: { technicianName: string \| null }` |
| 7B agent | `promptkinds/elevation.go` (new); `heartbeat/pam_flow.go` (:57-186, :547); the SYSTEM-helper renderer (P14), adapting `userhelper/pam_dialog_window_windows.go` and `pam_dialog_desktop.go` to the native model; `pamdecline.ReasonUserCancelled`; catalog `elevation.json` (+ Go copy) |
| 7C Assist | advertise `elevation.request@1`; `kinds/elevation.tsx` (waiting, approved, denied, expired, failed, cancelled; facts) |

### Task 7.1: API — `user_cancelled`, renderer, technician name (7A)

**Tenancy:** an existing org-cascade table, with a CHECK change only. No column, no export-policy change, no RLS change.

**Interfaces:**
- `PAM_WITHDRAW_REASONS` adds `'user_cancelled'`, byte-identical in the CHECK and in `pamdecline`.
- `decidedBy.technicianName` = `buildTechnicianDisplay(level, …).name` when `resolveRemoteSessionPromptConfig(device).identityLevel` is `name` or `name_email`; otherwise `null`. The email is never sent.
- `renderer` and `firstQuestionRenderer` go into `elevation_audit` / `writeAuditEvent` details.

- [ ] **Step 1: Failing tests.**
  - `withdraw accepts user_cancelled`.
  - `CHECK rejects unknown reason` (integration).
  - `technicianName null at generic level`.
  - `email never present`.
  - `renderer recorded in audit details`.
- [ ] **Steps 2–5:** FAIL → implement → unit + integration + `test:rls-coverage` PASS → commit `feat(api): user_cancelled withdraw reason and technician name for elevation outcomes (#10178)`.

### Task 7.2: `elevation.request@1` (7B)

**Interfaces:**
- `promptkinds.ElevationRequest(t pamTracked, partner string) prompthost.Prompt` with id `elevation:<requestId>`.
- Transitions:
  - pending: `send_request` (proceed), `cancel` (safe, default), `use_local_credentials` (neutral, conditional on #8928 PR 2).
  - waiting: `cancel_request` (safe), `hide` (neutral).
  - terminal: `approved`, `failed`, `denied`, `expired`, `cancelled`.
- **First question:**
  - `PromptOnSecureDesktop` (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`) set to 1, or missing → the SYSTEM helper renders on the input desktop. The system role advertises `elevation.request@1`.
  - Set to 0 → an Assist `modal` next to UAC. When `consent.exe` exits, the agent sends `prompt_close{superseded}`.
- **After `send_request`** with a require-approval verdict:
  1. Run the #10177 targeted dismiss.
  2. Bump the lease epoch.
  3. Show the `waiting` card on Assist. With no Assist in the session, fall back to the #8928 toasts with the same catalog strings.
  If the dismiss cannot be proven, `stateDetail` says "You can close the Windows prompt; your request stays with {partner}". An unproven dismiss never engages the fail-closed gate.
- **Outcomes:**
  - `pam_apply_v2` `verified_active` → `approved` ("Approved by {technician} at {partner}" when a name is present).
  - `failed` → `failed`.
  - `pam_request_notify` → `denied` or `expired`, with the server-sanitized reason.
  - A decision that arrives while the first question is open closes it (`superseded`) and shows the outcome.
- `cancel_request` → #8971 withdraw with `user_cancelled`, plus the local decline record. `hide` only closes the window.
- **Never re-show native blindly:** before any SYSTEM-helper draw, re-check the requester's session, the principal, and the current input desktop.
- The end-user-allowed verdict is unchanged: credentials are typed into `consent.exe`, and the outcome is a list entry.

- [ ] **Step 1: Failing tests.**
  - `TestFirstQuestionRendererBySecureDesktopSetting`.
  - `TestSendRequestMovesToAssistWithLeaseBump`.
  - `TestUnprovenDismissCopyAndGateClear`.
  - `TestDecisionDuringFirstQuestionSupersedes`.
  - `TestApprovedVerifiedActiveAndFailed`.
  - `TestDeniedReasonSanitized`.
  - `TestCancelRequestWithdrawsUserCancelledAndRecordsDecline`.
  - `TestHideDoesNotCancel`.
  - `TestNoNativeRedrawAfterUserSwitch`.
  - `TestTechnicianNameShownOnlyWhenSent`.
  - `TestElevationLegacyWhenDisabled`.
- [ ] **Steps 2–5:** `go test -race ./internal/promptkinds/... ./internal/heartbeat/ ./internal/userhelper/ ./internal/pamdecline/... -run 'Elevation|FirstQuestion|SendRequest|CancelRequest|Superseded'` → FAIL → implement → PASS (plus the full agent suite) → commit `feat(agent): stateful elevation request — waiting, approved, denied on Assist (#10178, #10180)`.

### Task 7.3: Elevation cards (7C)

- [ ] **Step 1: Failing tests.**
  - `waiting card shows IT has until {time:}`.
  - `Cancel request is safe and Hide is neutral`.
  - `facts truncate with Show more`.
  - `approved card lingers 8 s`.
  - Rust `advertises_elevation_v1`.
- [ ] **Steps 2–5:** FAIL → implement → PASS → version bump → commit `feat(assist): elevation request status cards (#10180)`.

### Task 7.4: W07 lab legs

- [ ] **Todd, with `elevation.request@1` enabled on the lab stack:**
  - `PromptOnSecureDesktop` = 1 and = 0, each with the consent prompt (admin) and the credential prompt (standard user).
  - For each: approve, deny, expire, cancel request, and use administrator password (if PR 2 has merged).
  - A technician decision crossing the user's click.
  - Approval while the screen is locked.
  - An RDS host with 3 sessions; fast user switching.
  - Re-take the elevation video.

---

# W08 — Elevation, destination (decision 2 in full)

Spec §3.4 "W08 prerequisites", P9. Starts only after W07 is enabled and qualified in the lab. **If W08 stops at the spike:** W07 remains the shipped behaviour, documented as such (spec §3.4, last line).

| PR | Owns |
|---|---|
| 8A spike (no merge) | written finding on capturing the target's arguments, working directory, SID and logon session from the existing ETW/consent capture path, for both prompt kinds and both `PromptOnSecureDesktop` values |
| 8B API | migration in the slot the orchestrator assigns: `elevation_requests.command_line_display text NULL`, `launch_context_sha256 char(64) NULL`; schema `db/schema/elevations.ts:84`; export-policy classification for both columns in `services/tenantExportPolicyRegistry.ts` (the command line may carry secrets, so classify it excluded; the hash included), following the registry's treatment of `target_executable_path`; submit route `routes/agents/elevationRequests.ts:274` accepts both; `pam_apply_v2` echoes `launchContextSha256`; the PAM web request detail shows the command line to `requirePamApprove` users |
| 8C agent | device-held launch context keyed by request id; requester-bound session resolution by SID + logon id (replacing the bare-username match, `tokenlaunch_windows.go:389-418`; fails closed); argument-faithful `LaunchSuspendedV2` (`:170-182`); dismiss-first flow; self-approve through token launch; "use administrator password" relaunch with a one-shot capture bypass bound to (SID, session, executable hash, 60 s) |
| 8D Assist | advertise `elevation.request@2`; the first-question modal on Assist after the dismiss |

### Task 8.1: Capture-feasibility spike (go / no-go)

- [ ] Write `docs/superpowers/plans/helper/2026-10-26-on-device-dialogs-w08-spike.md` (docs-only PR). For each prompt kind and `PromptOnSecureDesktop` setting it records whether the arguments, working directory, SID and logon id are available at capture time, where they come from, and the installer cases (`msiexec /i`, bootstrappers waiting on an elevated child that sees `ERROR_CANCELLED`).
- [ ] **Go:** every field is available reliably → continue to 8B.
- [ ] **No-go:** stop W08 and return to Todd with the finding. W07 stays the shipped behaviour.

### Task 8.2: Command-line display and launch binding (8B)

**Interfaces:**
- The submit body gains `commandLineDisplay?: string` (at most 2048 code points, controls stripped) and `launchContextSha256?: string` (64 hex characters).
- The respond route copies `launchContextSha256` into `pam_apply_v2`.
- The agent refuses a launch whose hash does not match its held context, with failure code `launch_context_mismatch`.

- [ ] **Step 1: Failing tests.**
  - `submit stores display and hash`.
  - `apply payload carries hash`.
  - `export policy classifies both columns` (the export-policy contract).
  - `org-cascade suite green` (integration).
- [ ] **Steps 2–5:** FAIL → implement → unit + integration + `test:rls-coverage` PASS → commit `feat(api): bind elevation approvals to the captured launch context (#10190)`.

### Task 8.3: Dismiss first, ask on Assist, launch faithfully (8C)

**Interfaces:**
- `launchctx.Store` with `Put(requestID string, c LaunchContext) error`, `Get`, and `Drop`, where `LaunchContext{ TargetPath, Args, Cwd, UserSID, LogonID string; WinSession uint32 }` and `Sha256() string` hashes path + args + cwd.
- `resolveSessionByLogon(sid, logonID string) (uint32, error)` — no username fallback.
- `elevation.request@2` begins with a pending decision on Assist (`modal`, `steal`, because the user just initiated it) after a proven dismiss. If the dismiss is unproven, or there is no Assist, the W07 path is used.

- [ ] **Step 1: Failing tests.**
  - `TestLaunchUsesCapturedArgsAndCwd`.
  - `TestLaunchRefusesHashMismatch`.
  - `TestSessionResolvedByLogonNotUsername`.
  - `TestSelfApproveUsesTokenLaunch`.
  - `TestLocalCredentialsRelaunchBypassIsOneShotAndBound`.
  - `TestDismissFirstFallsBackToW07WhenUnproven`.
  - `TestV2OnlyWhenAdvertisedAndEnabled`.
- [ ] **Steps 2–5:** FAIL → implement → PASS (plus the full agent suite) → commit `feat(agent): dismiss UAC first and ask on Assist, with argument-faithful requester-bound launch (#10190)`.

### Task 8.4: First question on Assist (8D) and lab legs

- [ ] **Assist tests:**
  - `first-question modal: Cancel is default and focused`.
  - `Send request moves to waiting without a new window`.
  - Rust `advertises_elevation_v2`.
  - Commit `feat(assist): ask the elevation question on Assist (#10190)`.
- [ ] **Todd lab legs, with `elevation.request@2` enabled on the lab stack:**
  - The full W07 matrix.
  - Installers: `msiexec /i` and a bootstrapper.
  - Arguments containing spaces and quotes; relative paths that depend on the working directory.
  - Requester binding under fast user switching and on RDS.
  - The relaunch bypass works once only.
  - Elevation video, take 2.

---

# W09 — Docs, general availability, follow-ups

Spec §9 W09, §8 Rollout.

### Task 9.1: Docs (9A, Sonnet)

**Files:**
- Create: `apps/docs/src/content/docs/features/end-user-experience.mdx`, registered in the docs sidebar config. It covers:
  - every prompt and its states;
  - the native fallback matrix (spec §2);
  - DND-resistant delivery and its limits;
  - "Breeze never asks for your password";
  - Assist health codes;
  - `PROMPT_HOST_ENABLED_KINDS` for self-hosters.
- Modify: `features/remote-access.mdx` (consent, pill, `allow_user_end_session`, no indicator on macOS/Linux without Assist), `features/patch-management.mdx` (restart card, Postpone default, operator copy, audit), `features/pam.mdx` and `security/pam.mdx` (W07, and W08 if it shipped), `agents/helper.mdx` (WebView2 minimum, crash loop, ownership, OD-11).

- [ ] `pnpm --filter @breeze/docs build` passes (the sidebar lives in `apps/docs/astro.config.mjs`), and so does the Docs Check job (PII guard). Commit `docs: end-user experience page and prompt updates (#10190)`.

### Task 9.2: General-availability default flip (9B)

- [ ] **Failing test:** `DEFAULT_ENABLED_PROMPT_KINDS equals the GA list`. The GA list is the kinds that have run enabled in both hosted regions through at least one release, as confirmed by the orchestrator at dispatch.
- [ ] Implement, then PASS. The release notes tell self-hosters the kinds are on by default and how to turn them off.
- [ ] Commit `feat(api): enable proven prompt kinds by default (#10190)`.

### Task 9.3: Follow-up issues and videos

- [ ] **Legacy removal** (compatibility order rules 7–8). Its acceptance gates:
  - the server-enforced Assist floor in `helperUpgradeTo`;
  - fresh `promptHost` observations showing no connected Assist below the floor (not `devices.helper_version`);
  - a tested release covering an old native process that survives an agent update.
- [ ] **OD-9:** a security design for Assist in RDP/RDS sessions (the biggest remaining gap).
- [ ] **OD-10:** revisit an automatic WebView2 install if lab or field data show outdated runtimes are common.
- [ ] **OD-11:** partner-creation seeding, if Gate B G1 chose it.
- [ ] **Videos (Todd):** restart, elevation and remote support, re-taken with the kinds enabled (rig on the local `video-enduser` branch), plus the second elevation take after W08.

---

## Open items for Gate B

- **G1 — OD-11 "new partners".** Today no default policies are seeded at partner creation. This plan delivers "newly created helper policies default on" (P10).
  - (a) Accept that as OD-11.
  - (b) Add a W01 task that seeds a partner-wide helper policy for each new partner.
  - **Recommend (a).** A seeded policy installs software on every device of a new partner without the partner having opened the helper settings, which is close to the (c) that was rejected.
- **G2 — Confirm P1–P15.** Most consequential:
  - **P9:** the W08 launch context stays on the device, the server gets a display copy plus a binding hash, and two columns are added.
  - **P4:** env kill switch, with the W09 default flip; until then self-hosters must opt in.
  - **P13:** no WebView2 version on the badge.
  - **P15:** a kill switch does not yank a prompt that is already presented.
- **G3 — W07 and #8928 PR 2.** `use_local_credentials` ships only if PR 2 has merged. Otherwise it is added when PR 2 lands.
- **G4 — W08 is gated on the 8A spike.** A no-go returns to Todd, and W07 stays the shipped behaviour.
- **G5 — W00 is not on `main` yet.** W06 is blocked on #10187, and W07 on #10179 (plus #8971, #8928 PR 1 and #10177).
- **G6 — `sys-locale` crate** added to Assist (W03), pending supply-chain review in that PR.

## Quorum (`codex exec`, gpt-6-astra, xhigh, read-only — wave split and IPC order only)

The design quorum was done at spec time. This round reviewed only the wave split and the compatibility order.

**Agreed:**
- Keep `ProtocolVersion` at 1, with additive per-kind grants.
- The three-switch activation order.
- No ordering failure between old and new agent and Assist as long as the legacy handlers stay.
- All four deviations put to it: P1, P2, P3 and P8. For P8, keep timeout = no decision.

**Adopted from the reviewer:**
- **(a) W02 storage is not dormant.** Hence P5: two files, endpoint-message tombstones kept at 168 h, rollback-safe.
- **(b) Sidecar and executable can disagree after a rollback.** Hence P12's version check.
- **(c) Legacy removal needs fresh connected-renderer observations,** not `devices.helper_version`. Hence `rendererVersion` in the W02 telemetry and rule 8.
- **(d) Assist's global, unpinnable channel.** Hence rule 4: Assist lab legs before publish.
- **(e) Lab legs run with the kinds enabled on a lab stack, and canary pins are cleared at promote.** Hence rule 5.
- **(f) Acceptance tests for enable/disable mid-decision, Assist replacement, a surviving native process, and timers preserved through fallback.** Hence Task 2.3.
- **(g) W00 #10187 is absent from `main`.** Hence W06's precondition and G5.

**Not adopted:** none.

## Self-review notes

- **Spec coverage:**
  - §3.1 contract → W02; §3.2 list → W02 and W04; §3.3 → W05; §3.4 → W07 and W08; §3.5 → W04 and W06; §3.6 → W03; §3.7 → Task 2.3 selection plus each kind's locked-session and fast-user-switching tests; §3.8 → W01; §4 audit → Tasks 5.3, 6.1 and 7.1; §5 safety → Tasks 2.2, 2.3, 2.5 and 2.6; §8 fixtures and skew → Task 2.1; lab legs → per wave; §9 → the wave map.
  - Deviations are listed as P1–P15.
- **Interface consistency:**
  - `prompthost.Prompt`, `KindSpec`, `Owner`, `selectRenderer` and `inbox.Store` are defined in Tasks 2.3 and 2.4.
  - `promptkinds.*` constructors return `prompthost.Prompt`.
  - Catalog `Render` and `Negotiate` are defined in Task 3.1 and consumed from W04 onward.
- **Length:** about 3 times the spec for nine waves, mostly in wrapped bullet lists. Code is limited to signatures, fixtures and the values the spec pins.
