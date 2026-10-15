---
spec: docs/superpowers/specs/agent/2026-10-08-agent-localization-helper-runtime-branding-design.md
discussion: LanternOps/breeze#7567
spec_pr: LanternOps/breeze#8277
status: draft
date: 2026-10-15
area: agent / api / helper / web
verified_main: 6e83eb078f63
---

# Agent localization and Helper runtime branding (Phase 2): implementation plan

> **For implementation agents:** execute this plan task-by-task. Use red-first tests for new contracts and preserve every compatibility/security boundary called out below.

**Goal:** implement the Phase 2 design approved in #8277 without creating a replacement spec: localize user-visible Agent/Helper text from the OS/user-session language, add runtime Helper branding through the existing Helper configuration-policy path, retain the last-known valid brand safely on-device, and remove the Windows SCM reliability dependency on localized prose.

**Architecture:** extend the existing path `Configuration Policy -> helperSettings/devicePolicySet -> heartbeat -> Go Agent -> sessions/<key>/helper_config.yaml -> Tauri Helper`. Runtime branding is an optional decision nested inside `helperSettings`; it uses explicit `set` / `cleared` states while omission means no new branding decision. Locale is written per Helper session. No new branding table, migration, control endpoint, authentication path, or build-time Helper branding mechanism is introduced.

**Tracking:** the maintainer said the lifecycle issue will be registered after this plan lands. Do not create a competing lifecycle issue from this plan PR.

## Deltas since the spec

The #8277 design remains the product source of truth. These are implementation-surface changes verified on current `upstream/main` (`6e83eb078f63`, 2026-10-15); none reopen OD1-OD5.

1. **`devicePolicySet` is now on the heartbeat hot path.** `loadDevicePolicySet` / `withPolicySet` load candidate assignments once, and `resolveDeviceHelperSettings` already accepts that set. The branding pass must produce the same result in policy-set and standalone resolution, covered by the existing resolver-parity integration pattern.
2. **Heartbeat retain-state v1 is on main.** `heartbeatSettingsDecision.ts` omits `helperEnabled` / `helperSettings` when the API has no valid Helper decision and emits `retainState: ['helper']` to capable agents. Branding therefore belongs inside `helperSettings`: a retained beat naturally carries no branding decision and the Agent keeps the persisted last-known brand.
3. **Identity Sync v2 is on main.** `applyIdentityAssertion` runs before Helper/update application and an accepted identity move enters the restart path. An accepted organization change must clear persisted branding before restart so a failed first beat in the new org can never display the old tenant's brand.
4. **`showTrayIcon` is gone (#8138).** It is no longer part of `HelperSettings`; the web editor only strips the legacy key on future saves. Phase 2 must not reintroduce it in schema, heartbeat, YAML, or UI.
5. **The Tauri endpoint-message window now exists and is intentionally isolated.** `message-*` uses its own minimal capability (`apps/helper/src-tauri/capabilities/message-card.json`) and privileged commands reject that caller. Localization/branding must preserve that boundary.
6. **Helper YAML parsing now uses `serde_norway`.** `load_helper_config` and round-trip tests already use it. New locale/branding fields must follow that parser and keep old config files valid.
7. **Caller Verification has its own security branding contract.** `/api/v1/helper/config` returns `{partnerName, logoUrl}` for Caller Verification and `CallerVerifyWindow` has its own localized copy. That contract stays separate: Phase 2 Helper branding still accepts no URL/image field.
8. **Endpoint Messaging has a provisional branding snapshot.** `services/endpointMessaging/brandingSnapshot.ts` explicitly uses partner name + document primary colour until Phase 2 runtime-branding fields exist. Once runtime Helper branding lands, endpoint messages should prefer the effective Helper identity when configured while preserving snapshot-at-send and the current fallback when it is not configured.
9. **OD2 requires a collector change, not only a parser change.** Current `winEvent` / `EventLogEntry` do not carry EventRecord properties; reliability sees only `Message`. The Windows collector must capture the needed SCM structured value (`Properties[0]`) internally without expanding the public event-log payload.
10. **OD1 requires genuinely per-session config generation.** `helper.Manager.Apply()` currently creates one config and writes it to all sessions. Locale must be resolved per `SessionInfo` and written into each `sessions/<key>/helper_config.yaml` independently.

## Decision record: do not reopen

### Confirmed by the maintainer

- #8277 remains the approved Phase 2 spec; this file is an implementation plan, not a second spec.
- OD1 is approved: Helper language follows the logged-in user's session locale and belongs with that session's Helper configuration.
- OD2 is approved: use SCM `Properties[0]` as the service display name, then map through `CanonicalServiceName`; verify the assumption on a real Windows host during implementation.
- OD3 is approved: retain valid last-known runtime branding on disk; clear it on scope change, re-enrollment, or explicit `cleared` state.
- OD4 is approved: use a constrained semantic colour model, not arbitrary component CSS.
- OD5 is approved: validate colours/readability on branded surfaces.
- Native/signed assets remain deferred.

### Confirmed by #8277

- Technical identities stay fixed: `BreezeAgent`, `BreezeWatchdog`, executable/install paths, event-source identities, MSI `ProductName` / `UpgradeCode`, `com.breeze.*` / `com.breezermm.*`, API routes, IPC names, protocol values, and update identity.
- Helper branding lives in the existing `helper` feature link (`inlineSettings`).
- Branding inheritance is field-level `Breeze defaults -> partner -> organization`; operational Helper settings remain first-match-wins.
- Branding fields are valid only at partner and organization assignment levels. Site/device-group/device branding is rejected on write and ignored by the branding resolver.
- Branding text is one literal operator-supplied value, not per-locale content. Unset identity fields use localized Breeze defaults.
- Approved text limits: `displayName` 60, `companyName` 60, `welcomeTitle` 120, `welcomeMessage` 500, `supportLabel` 40, `portalLabel` 40 Unicode code points.
- Input is plain text only; control characters are rejected; colours are strict `#RRGGBB`; there are no branding URL, image, HTML, Markdown, or custom-CSS fields.
- PAM/consent/security copy remains Breeze-owned and localized; branding may only fill identity slots.
- No new table, RLS policy, cascade registration, or branding endpoint is part of Phase 2.

## Current-main constraints

- The operational Helper resolver remains first-match-wins and its effective result is cached per device for 120 seconds.
- The heartbeat's `DevicePolicySet` must remain a one-statement shared candidate load. Phase 2 may not add a second Helper assignment query on that hot path.
- `retainState` is the only signal that means "keep current Helper state". Do not infer retention from arbitrary field absence elsewhere.
- Helper configuration is already per session on disk and passed with `--config`; Phase 2 extends that shape rather than adding another transport.
- `serde_norway` remains the Rust YAML parser.
- `message-*` remains capability-isolated.
- `CanonicalServiceName` already maps Agent/Watchdog display names back to fixed service names.

## Runtime branding wire contract

Extend the existing heartbeat `helperSettings` object:

```json
{
  "helperSettings": {
    "enabled": true,
    "showOpenPortal": true,
    "branding": {
      "state": "set",
      "scopeId": "<opaque>",
      "values": {
        "displayName": "Example Assist",
        "companyName": "Example MSP",
        "welcomeTitle": "Welcome",
        "primaryColor": "#2255AA"
      }
    }
  }
}
```

Decision semantics:

| Received | Meaning | Agent behaviour |
|---|---|---|
| `branding.state = set` | valid effective branding decision | validate, compare scope, replace the persisted branding snapshot, apply |
| `branding.state = cleared` | branding explicitly unset | delete persisted branding and use Breeze defaults |
| no `branding` key | not sent / old API / Helper retained | preserve the last-known branding snapshot |

Rules:

- The API derives an opaque `scopeId` from the resolved partner + organization scope. The Agent compares it but does not parse tenancy semantics from it.
- A `set` block is a complete effective branding snapshot. An absent field inside `values` means the localized Breeze default for that field, not "keep the previous value".
- The Agent stores only validated snapshot values + scope in the per-session YAML; `state` itself is wire semantics.
- `locale` is also stored in the session YAML but is not part of the last-known branding state. It is recomputed per session.
- An old YAML file with neither `locale` nor `branding` remains valid and falls back to current Breeze behaviour.

### Mixed-version behaviour

- Old Agent + new API: unknown branding keys inside `helperSettings` are ignored.
- New Agent + old API: absence of the branding key preserves any valid persisted snapshot; a device that has never received branding uses Breeze defaults.
- New Agent + old Helper: extra YAML keys are ignored by the old Helper.
- New Helper + old config: locale/branding fall back safely.
- API rollback must not implicitly clear branding; only `state: cleared` does that.

## Server-side resolver and write gates

Create a focused Helper-branding module that performs:

1. validation/normalization of the new branding subtree;
2. partner + organization branding resolution from already-loaded policy candidates;
3. effective `set` / `cleared` decision construction plus opaque scope id.

Resolution rules:

- Operational Helper settings keep today's device -> group -> site -> org -> partner first-match-wins semantics.
- Branding performs a separate pass and considers only partner and organization candidates.
- At each level, existing assignment ordering/priority selects that level's winning policy.
- Effective fields merge `defaults <- partner <- organization`.
- Site/device-group/device candidates never contribute branding, even if invalid data reached the DB through manual means.
- A successful resolution with no custom partner/org branding returns `state: cleared`.
- A genuine no-decision/failure does not synthesize `cleared`; retain-state omits `helperSettings` instead.

### Close both mutation orders

The partner/org-only rule has two write doors and both require tests:

- `featureLinks.ts` POST/PATCH: reject adding/changing `helper.inlineSettings.branding` when the policy already has a site/device-group/device assignment.
- `assignments.ts` POST: reject adding a site/device-group/device assignment when that policy already contains Helper branding.

Clearing branding remains allowed. The resolver still ignores lower-level branding as defence in depth.

Do not make the entire existing Helper inline-settings object newly strict in this phase. Validate only the new branding subtree so legacy operational settings do not become invalid as an accidental side effect.

## OD1 — Helper locale per user session

Add a testable session-locale resolver under `agent/internal/helper` and generate the Helper config inside the per-session loop.

Requirements:

- each active `SessionInfo` produces its own `Config`, including a normalized locale tag;
- locale comes from a structured session/user source for the platform, not from parsing localized prose;
- resolver failure does not block Helper startup; fall back deterministically to English;
- a new Helper treats YAML `locale` as authoritative and may use `navigator.language` only as fallback for configs written by older agents;
- no new server route or heartbeat field is needed for locale;
- tests prove two simultaneous sessions can receive different locales.

Planned files:

- `agent/internal/helper/session_locale.go`
- `agent/internal/helper/session_locale_windows.go`
- `agent/internal/helper/session_locale_darwin.go`
- `agent/internal/helper/session_locale_linux.go`
- adjacent platform-specific tests and normalization table tests.

## OD3 — durable last-known branding

Extend Go `HelperSettings` with an optional branding decision and extend `helper.Config` with the persisted snapshot.

Critical behaviours:

1. **Missing wire decision preserves disk.** After an Agent restart, `sessionState.lastConfig` is empty. Before rewriting a session YAML without a new branding decision, load the existing file and carry forward its validated branding snapshot. Do not depend on memory only.
2. **`set` replaces the snapshot.** Validate all fields, compare `scopeId`, then persist the new effective snapshot atomically.
3. **`cleared` deletes the snapshot.** Do not carry any old branding field forward.
4. **Re-enrollment clears branding after successful identity persistence.** Sweep `sessions/*/helper_config.yaml` plus the legacy root config, remove only the branding section, and rewrite atomically. A cleanup failure is reported but must not roll back an enrollment already accepted by the server.
5. **Identity Sync clears on organization change before restart.** Reuse the same cleanup primitive when an accepted assertion changes `orgId`. A site-only move does not clear branding because the approved branding scope is partner + organization.
6. **Explicit Helper disable keeps today's uninstall behaviour.** Removing session state because policy disabled the Helper is not the same as transient control-plane unavailability.
7. **Corrupt persisted config is never trusted.** Invalid YAML/branding falls back to Breeze defaults and is logged using the existing bounded diagnostic pattern.

A required restart test writes branded YAML, constructs a fresh `Manager` with no in-memory `lastConfig`, applies settings that omit branding while changing an operational field, and verifies that the branding snapshot survives exactly.

## OD4 / OD5 — semantic colours and readability

The implementation must expose a small semantic contract, not arbitrary styling.

Implementation choice for this plan:

- expose `primaryColor` and `accentColor`, both strict `#RRGGBB`;
- derive foreground/on-colour values locally; do not accept foreground CSS from the server;
- centralize contrast math and thresholds in one module and cover it with shared fixture vectors on API and device sides;
- reject invalid/unreadable values on write; if a persisted value is invalid on-device, drop only that field and use the Breeze default.

The exact contrast threshold is an implementation detail to be reviewed in the plan/implementation PR; changing it must not change storage hierarchy, tenancy, or wire semantics.

## Helper localization and runtime rendering

Introduce one Helper UI catalog and consume the effective session locale.

Localize ordinary product copy including:

- onboarding/welcome text;
- connecting/disconnected/retry states;
- shell/history/device-info/navigation labels;
- approval labels and parameter/script affordances;
- chat placeholder/product copy;
- tray/menu labels;
- fixed consent/remote-support text;
- native window titles (`Remote Session Request`, `Remote Session Active`, endpoint-message title);
- static endpoint-message card copy.

Branding text (`displayName`, `companyName`, `welcomeTitle`, `welcomeMessage`, `supportLabel`, `portalLabel`) is rendered verbatim and never sent through the translation catalog. Surrounding Breeze-owned copy is localized.

Caller Verification should consume the effective session locale but keep its current independent `partnerName` / `logoUrl` source and fixed security copy.

## Tauri `message-*` boundary

Phase 2 must not loosen endpoint-message isolation.

- do not add window/webview/event/tray/menu privileges to `message-card.json`;
- keep the existing privileged-command `deny_message_window` checks;
- if the React window needs branding/locale, expose only a read-only sanitized UI context containing locale + effective identity tokens, never auth tokens, operational URLs, device secrets, or action capabilities;
- add tests that the capability remains minimal and the new read path cannot invoke privileged actions;
- endpoint-message body/title content remains the endpoint-messaging feature's content, not branding-provided HTML/CSS.

### Endpoint Messaging identity

Keep snapshot-at-send semantics. The send path already resolves Helper settings per device to check endpoint messaging. Reuse that effective resolution rather than adding another heartbeat/query path:

- when Phase 2 Helper branding is set, snapshot its effective company/display identity and semantic accent into the message;
- when Helper branding is cleared/unconfigured, keep today's partner-name/document-colour fallback;
- preserve current sender-slot anti-spoofing behaviour.

## OD2 — structured SCM identity

Update the Windows event collector so reliability can use SCM structured data while the public Event Log payload stays unchanged.

- project only the needed SCM property (`Properties[0].Value`) from `Get-WinEvent`; do not serialize the full `Properties` array;
- decode it into an internal `winEvent` field;
- carry it into `EventLogEntry` with `json:"-"` (or equivalent internal-only representation);
- reliability prefers `CanonicalServiceName(entry.ServiceDisplayName)` when a valid structured value exists;
- the current message parser remains fallback when structured data is missing/unusable;
- bound/sanitize the internal value before use;
- English and non-English rendered-message fixtures must resolve to the same canonical service name when the structured display name is the same;
- cover custom Agent/Watchdog display names.

Before merging this wave, capture a real Windows 7031 event for a branded service and confirm that `Properties[0]` contains the display name as expected. If not, stop this part of the implementation and report the mismatch rather than inventing another localized-prose parser.

## Agent user-visible localization

Add a small `agent/internal/localization` layer with:

- OS-locale normalization/matching;
- embedded catalogs with deterministic English fallback;
- typed/stable message keys rather than free-form lookups across packages.

Sweep only text actually shown to end users, including relevant surfaces in `agent/internal/agentapp`, user-helper/consent/notification paths, patch/reboot prompts, recovery/interactive surfaces, and equivalent OS dialogs.

Do **not** translate structured logs, machine-readable errors, service names, event sources, JSON keys, IPC names, metrics, API paths, or protocol values. Tests must prove these identifiers are byte-identical across locales.

## Configuration Policies UI

Helper branding stays in one home: `Configuration Policies -> Helper`.

Rule-9 accounting from `docs/agents/settings.md`:

| Item | Value |
|---|---|
| Home | existing Helper feature link (`inlineSettings`) |
| Levels | partner default, organization override |
| Resolver | the single server-side Helper branding resolver described above |
| Places configured before | 0 |
| Places configured after | 1 |

UI behaviour:

- blank means inherit;
- show inherited/effective value and source where available;
- organization overrides may change one field without copying the rest;
- clearing an org override restores inheritance;
- no logo/icon/URL/custom-CSS controls;
- when the policy already has an incompatible lower-level assignment, disable branding authoring with an actionable explanation; the server remains authoritative.

If the current editor lacks enough read metadata to show inheritance source, minimally extend an **existing** Configuration Policies read response using the same branding resolver. Do not create a separate branding endpoint.

## Expected file map

### API

- Create `apps/api/src/services/helperBranding.ts` + adjacent tests: validation, field merge, scope id, colour validation, `set`/`cleared` decision builder.
- Modify `apps/api/src/services/helperSettings.ts` + tests: attach effective branding without adding a hot-path query.
- Modify `apps/api/src/__tests__/integration/devicePolicySetResolverParity.integration.test.ts`: operational + branding parity.
- Modify `apps/api/src/routes/configurationPolicies/featureLinks.ts` and `assignments.ts` + tests: both write-order guards.
- Modify heartbeat tests only as needed to prove branding rides inside `HelperSettings` and retain-state omits the whole object.
- Modify endpoint-messaging branding/send code to consume already-resolved effective Helper branding while preserving fallback snapshot semantics.

### Agent / Go

- Modify `agent/internal/heartbeat/heartbeat.go`: optional branding shape inside `HelperSettings` and pass-through to helper manager.
- Modify `agent/internal/heartbeat/identity_sync.go` + tests: organization-move branding clear before restart.
- Create `agent/internal/helper/branding.go` + tests: validation, persistence, preservation across restart, atomic clear.
- Modify `agent/internal/helper/manager.go` / `session_state.go` + tests: per-session config construction, locale, persisted branding carry-forward.
- Create `agent/internal/helper/session_locale*.go` + tests.
- Modify successful re-enrollment path + tests to clear old branding after identity save.
- Create `agent/internal/localization/` + tests and migrate approved user-visible surfaces.
- Modify event-log/reliability collector files + tests for structured SCM display name.

### Helper / Tauri / React

- Add the Helper i18n dependency/layer following the monorepo's existing React i18n conventions.
- Add an English canonical Helper catalog and at least one non-English catalog for selection/fallback testing; the exact locale rollout list is not a product decision in #8277.
- Extend Rust `HelperConfig` with locale + branding using `serde_norway` and legacy-config tests.
- Localize native titles and React product copy.
- Apply only semantic branding CSS variables derived from validated config.
- Centralize session locale use for Caller Verification without changing its branding source.
- Keep endpoint-message isolation tests green.

### Web / docs

- Modify `apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx` + tests.
- Add editor localization strings to the existing web catalogs.
- Update Helper/runtime-branding docs after implementation; do not document deferred native assets as available.

## Wave plan

Each implementation wave starts from then-current `main` in its own branch/worktree. Do not reuse this documentation worktree for implementation.

### Wave 1 — server contract, resolver, write gates, heartbeat compatibility

**Goal:** make runtime branding a validated/effective server contract while remaining invisible to old agents/helpers.

- [ ] Red-first unit tests for all branding text limits, Unicode code-point counting, control characters, strict hex colours, unknown branding keys, partner/org merge, `set`/`cleared`, and stable scope changes.
- [ ] Implement pure Helper-branding validation/resolution.
- [ ] Extend `HelperSettings` with optional branding decision using the same candidates already loaded for operational resolution.
- [ ] Prove policy-set and standalone paths return identical branding.
- [ ] Prove a lower-level operational winner does not hide partner/org branding.
- [ ] Add both write-order guards (`featureLinks` and `assignments`).
- [ ] Test normal heartbeat `set`/`cleared` and retain-state omission of the entire `helperSettings` object.
- [ ] Reuse the already-resolved per-device branding for Endpoint Messaging; do not add a query.
- [ ] Run the existing hot-path/query-budget checks relevant to `devicePolicySet`.

**Mergeable result:** new API can send optional branding; old agents ignore it; no visual change yet.

### Wave 2 — Agent persistence, scope clearing, session locale

**Goal:** safely store/clear branding and write a locale-specific Helper config per user session.

- [ ] Red-first decode/validation tests for Agent-side branding decisions.
- [ ] Add persisted branding snapshot and `set`/`cleared` handling.
- [ ] Build config inside the session loop.
- [ ] Preserve branding from existing YAML after Agent restart when no new branding decision arrives.
- [ ] Implement atomic branding clear across session configs + legacy root config.
- [ ] Clear on successful re-enrollment and accepted Identity Sync org move; do not clear on site-only move.
- [ ] Implement per-platform session-locale resolution and deterministic English fallback.
- [ ] Prove two sessions can receive different locales and config changes restart only the affected session where current manager semantics allow that distinction.
- [ ] Compile/test platform-tagged code using the project's platform-specific test pattern; Linux-only green is insufficient for new Windows/macOS code.

**Mergeable result:** new Agent persists runtime state correctly; old Helper ignores the new YAML fields.

### Wave 3 — Helper rendering/localization and Configuration Policies editor

**Goal:** render approved branding/localization without expanding Tauri privilege.

- [ ] Add Helper catalogs and locale/fallback tests; migrate shell/onboarding first to prove the infrastructure.
- [ ] Extend Rust config round-trip tests for locale/branding and old YAML.
- [ ] Add the minimal sanitized UI-context read if required.
- [ ] Apply approved identity fields only in identity slots.
- [ ] Apply semantic colours through local CSS variables; no server CSS.
- [ ] Localize native titles and React product copy.
- [ ] Prove consent/PAM/security body copy cannot be replaced by branding.
- [ ] Use session locale for Caller Verification without changing its existing branding source.
- [ ] Localize endpoint-message static copy while keeping `message-card.json` minimal and privileged-command denial intact.
- [ ] Add Helper branding authoring/inheritance UI in `HelperTab` with blank=inherit and no asset/URL/CSS fields.
- [ ] Test no-branding behaviour remains Breeze-branded.

**Mergeable result:** runtime Helper branding/localization works without MSP-specific rebuilds.

### Wave 4 — Agent localization and structured SCM reliability

**Goal:** finish the Agent half of Phase 2 and eliminate SCM localized-prose dependency.

- [ ] Add Agent localization matcher/catalog with deterministic fallback.
- [ ] Inventory user-visible Agent strings and document in the PR what was migrated versus deliberately excluded as machine/log text.
- [ ] Migrate user prompts/notifications/CLI-facing text without changing technical identifiers.
- [ ] Add internal SCM `Properties[0]` capture without changing public event-log JSON.
- [ ] Make reliability prefer structured display name + `CanonicalServiceName`, with textual parser fallback.
- [ ] Test English/non-English rendered fixtures, custom display names, and missing structured properties.
- [ ] Verify a real branded Windows 7031 event before merge and attach the evidence to the PR.

**Mergeable result:** defined Phase 2 Agent surfaces are localized and own-service restart detection no longer depends on Windows display language.

## Validation

Follow `docs/agents/testing.md`; do not use the pnpm `--` passthrough trap for scoped Vitest runs.

### Wave 1

```bash
cd apps/api
npx vitest run \
  src/services/helperBranding.test.ts \
  src/services/helperSettings.test.ts \
  src/routes/configurationPolicies/featureLinks.test.ts \
  src/routes/configurationPolicies/assignments.test.ts \
  src/routes/agents/heartbeatSettingsDecision.test.ts
```

Also run the real-DB resolver-parity and applicable heartbeat hot-path/query-budget integration tests using their existing integration config.

### Wave 2

```bash
cd agent
go test -race ./internal/helper/... ./internal/heartbeat/... ./internal/agentapp/...
```

Add platform-specific compile/test coverage for every new build-tagged locale resolver.

### Wave 3

```bash
pnpm --filter=breeze-helper test
pnpm --filter=breeze-helper typecheck
pnpm --filter=breeze-helper build
cd apps/helper/src-tauri && cargo test
pnpm --filter=@breeze/web test
pnpm --filter=@breeze/web exec astro check
```

Also run the existing Tauri capability/isolation tests touched by the change.

### Wave 4

```bash
cd agent
go test -race ./internal/localization/... ./internal/collectors/... \
  ./internal/agentapp/... ./internal/userhelper/... ./internal/patching/...
```

Plus the real Windows SCM 7031 verification described above.

### Final gate for every implementation PR

- run package-specific checks required by `AGENTS.md`, `CLAUDE.md`, and `docs/agents/testing.md`;
- run the applicable security preflight before push;
- `git diff --check` clean;
- no credentials/internal infrastructure details;
- no migration/new branding table expected; if one becomes necessary, stop because the implementation has departed from #8277;
- one independent read-only review for Agent-shipped/security-sensitive changes, with findings accepted only after confirmation in code/spec.

## Security and compatibility invariants

1. With no runtime branding configured, Helper remains Breeze-branded.
2. No technical identifier changes with locale or branding.
3. Branding adds no URL, image, arbitrary CSS, HTML, or Markdown input.
4. React renders branding as text; no branding `dangerouslySetInnerHTML` path.
5. Consent/PAM/security wording remains Breeze-owned and localized.
6. `message-*` gains no privileged capability.
7. Persisted branding from one org/partner scope cannot survive an accepted org move or re-enrollment into another scope.
8. Temporary control-plane failure never implies `cleared`.
9. The `devicePolicySet` heartbeat hot path gains no assignment query.
10. Caller Verification keeps its independent security branding contract; Endpoint Messaging may snapshot effective Phase 2 text/colour but keeps its fallback and anti-spoofing rules.
11. The 120-second Helper cache remains per-device with no new invalidation fan-out.
12. Old Agent/Helper/API combinations degrade to known/default behaviour rather than decode failure.

## Acceptance mapping

| Decision / contract | Required evidence |
|---|---|
| OD1 | two user sessions can receive different locale values and each Helper selects its own locale |
| OD2 | localized fixture + real 7031 event resolve to the same fixed canonical service identity |
| OD3 | restart, retain/no-block, `set`, `cleared`, org move, and re-enrollment covered with disk-state tests |
| OD4 | semantic colour tokens only; no per-component CSS input |
| OD5 | write-time + device-side validation with safe default fallback |
| Partner -> org | one org field overrides while unspecified fields inherit partner/default values; lower-level operational policy does not hide branding |
| No branding | Breeze defaults across resolver, heartbeat/YAML, and rendering |
| Fixed identities | tests/snapshots show service IDs, paths, IPC/protocol names remain unchanged across locale/branding |
| Security UI | fixed consent/PAM copy, Caller Verification source unchanged, `message-*` isolated |
| Mixed versions | unknown-field/omission and legacy YAML round-trip tests |

## Out of scope

- tray, desktop, executable, `.ico`, `.icns`, PNG, or other native branding assets;
- Tauri `productName`, binary names, install directories;
- MSI `ProductName`, `UpgradeCode`, technical service names;
- event-source renaming;
- a new branding build/signing pipeline;
- per-locale branding values;
- automatic reuse of `partner_login_branding` or `portal_branding` as the Helper setting home;
- a new branding table or dedicated branding endpoint;
- lifecycle issue creation by this PR; the maintainer said he will register it after the plan lands.

## Implementation stop conditions

Stop and return to maintainer review if implementation would require any of the following:

- changing a fixed technical identifier;
- adding a branding table/migration/dedicated endpoint;
- a real SCM 7031 event disproves the expected `Properties[0]` display-name contract;
- session locale can only be obtained by parsing localized prose or by introducing a new privilege/credential requirement;
- branding/localization requires broadening the `message-*` capability;
- Identity Sync can render the old brand after an accepted organization move.
