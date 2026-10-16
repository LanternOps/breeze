# Agent localization and Helper runtime branding (Phase 2): Implementation plan

Spec: docs/superpowers/specs/agent/2026-10-08-agent-localization-helper-runtime-branding-design.md
Discussion: LanternOps/breeze#7567
Related: LanternOps/breeze#6365, #7841 (Phase 1 spec), #8061 (Phase 1 implementation)
Status: draft, not approved. No code changed yet.

## Deltas since the spec

The spec was written against main before the following merges. The plan is built on current main.

- Owner decisions recorded on 2026-10-15 in the discussion: OD1, OD2, OD3, OD4 and OD5 approved. Spec section 13 is the record.
- Heartbeat retain-state protocol (#8616) is on main. Helper settings reach beats through it, so the branding delivery must be checked against it (Task 3).
- Identity Sync protocol v2 is on main (agent/internal/heartbeat/identity_sync.go). Identity assertions must not be affected by branding (Task 3).
- Tray icon is out of scope for this PR. The existing showTrayIcon setting (HelperTab.tsx, helperSettings.ts, aiToolsConfigPolicy.ts) is not changed. Open question for the maintainer, deferred to the next wave: the maintainer note lists "no showTrayIcon" as a main decision, but the code still has the setting.
- Two resolvers exist: apps/api/src/services/helperSettings.ts (resolveDeviceHelperSettings) and apps/api/src/services/devicePolicySet.ts (loadDevicePolicySet, withPolicySet). Parity tests compare them (devicePolicySetResolverParity.integration.test.ts). The branding pass must be added to both, or the parity test must be extended. The spec names only helperSettings.ts; this is a delta.
- Phase 1 follow-ups #8227 (reliability.go lazy capture) and #8228 (build-msi.ps1 and pwsh tests) are merged.
- Phase 1 left the SCM parsing gap for Windows installs with a non-English display language (service_name.go parseServiceName matches the English message). OD2 brings this into Phase 2 (Task 6).

## Verified anchors on current main (main ed3f0e202, checked 2026-10-16)

- apps/api/src/services/helperSettings.ts: resolveDeviceHelperSettings, buildHelperConfigUpdate
- apps/api/src/services/devicePolicySet.ts: loadDevicePolicySet, withPolicySet
- apps/api/src/routes/agents/heartbeat.ts: consumes both; retain-state logic near lines 424 and 2519-2624
- agent/internal/heartbeat/heartbeat.go: beat payload, retainState and identitySync fields
- agent/internal/helper/manager.go: Config struct for helper_config.yaml (line ~42); per-session path sessions/<key>/helper_config.yaml (session_state.go)
- agent/internal/branding/canonical.go: CanonicalServiceName (Phase 1)
- agent/internal/collectors/service_name.go and reliability.go: parseServiceName (English pattern), used at reliability.go lines 397 and 404
- apps/helper/src-tauri/src/lib.rs: reads YAML with serde_norway
- apps/helper/src/App.tsx line 19: "Welcome to Breeze Helper"; apps/helper/src/components/shell/AppShell.tsx and ChatView.tsx hold other hardcoded strings
- apps/web/src/components/configurationPolicies/featureTabs/HelperTab.tsx: Helper policy UI
- Not found on main: any symbol matching "message-window" or "messageWindow". Tauri message-window isolation is listed by the maintainer as a current main decision and must be located in Task 0 before it is used.

## Constraints (from spec sections 1, 3, 6.1.1, 6.5, 8)

- Fixed identifiers do not change: BreezeAgent, BreezeWatchdog, event sources, UpgradeCode, ProductName, com.breeze.* and com.breezermm.*, API routes, protocol values, IPC names, executable and install paths.
- Branding fields are accepted only on helper policies at partner and organization level. Site, device-group and device levels reject them on write and ignore them on resolve.
- Operational Helper settings keep first-match-wins. Only branding fields use field-level merge (partner, then organization).
- Input: plain text only; maximum lengths displayName 60, companyName 60, welcomeTitle 120, welcomeMessage 500, supportLabel 40, portalLabel 40 (characters); strict #RRGGBB; no control characters; no URL, image, CSS or HTML fields. Validated on write (API) and on read (device).
- Consent and PAM bodies stay fixed and localized by Breeze. Branding fills only identity slots.
- No new tables, routes or endpoints. Branding rides in the helper feature link inlineSettings JSONB and the device-authenticated heartbeat.
- Without branding configuration, all behavior is identical to current main.
- Icons and native assets stay out (spec section 11).

## Task 0: Confirm anchors and test commands (read-only)

1. Locate the Tauri message-window code. Search apps/helper/src-tauri for window creation and labels (tauri.conf.json, lib.rs). Record file and line, or record that it does not exist on main.
2. Confirm the repository test commands from the PR template and AGENTS.md or CLAUDE.md (pnpm test, make test, go test for the agent, cargo test for the Helper).
3. Count user-visible strings in the agent (Go) and the Helper (TS and Rust) to size the localization sweep. Record the counts in an appendix to this plan.
4. Confirm how resolveDeviceHelperSettings and loadDevicePolicySet are called on each heartbeat and in the web UI.

Exit: a short facts note. Stop and ask if Task 0 contradicts the spec.

## Task 1: Branding input contract (API, pure module)

- Add a validation module for the closed input contract in spec 6.1.1: lengths in code points, plain text, no control characters, strict #RRGGBB, unknown keys dropped.
- Tests first: each limit, control characters rejected, URL and image keys ignored, named colours and rgb() rejected.
- Reuse the validator pattern of partner_login_branding where one exists. No new dependency.

## Task 2: Branding resolver pass (API)

- Add a branding pass to the resolver that reads only partner-level and organization-level helper assignments, independent of the operational winner.
- Field-level merge: the organization value wins per field; unset fields inherit the partner value; otherwise the Breeze default applies.
- Within one level, the existing priority order picks one policy.
- Branding fields on site, group and device policies are rejected on write and ignored on resolve.
- Implement in helperSettings.ts and devicePolicySet.ts with the same result. Extend devicePolicySetResolverParity to cover branding.
- Tests: partner only, organization override, missing organization field inherits partner, no policy gives defaults, a site or device policy cannot hide partner branding, cache is per device (120 s).

## Task 3: Heartbeat delivery and OD3 state (API and agent contract)

- Add a branding block to the helper settings delivered on the heartbeat, with state set or cleared and an opaque scope identifier derived from partner and organization.
- An omitted block means not sent: the device keeps last-known branding (spec 8.2).
- Confirm the retain-state beat handling (#8616) keeps the branding block for retain-state beats and that legacy beats are unaffected. Add a test.
- Confirm Identity Sync v2 (identity_sync.go) is not changed by the new block. Add a test.
- Tests: set, cleared, no block; schema tolerance for older agents.

## Task 4: Agent persistence of branding (OD3)

- Persist the branding section in each sessions/<key>/helper_config.yaml, not only in memory.
- Clear the persisted branding when the scope identifier changes (organization move or partner change), when the device is re-enrolled, or when a cleared state arrives. Clearing is local and does not depend on control-plane reachability.
- A missing block keeps last-known branding unchanged.
- Go tests with a temporary base directory for each rule.

## Task 5: Agent localization layer (OD1)

- Add a catalog-based localization layer for user-visible Agent strings only (spec 5.1). Identifiers, API paths, JSON keys, IPC names, metric names and error codes stay untranslated.
- Resolve the Helper UI locale from the logged-in user's session, stored in the per-session helper_config.yaml (OD1). Fall back to English deterministically.
- Tests: fallback when a locale is missing; machine identifiers identical across locales; default-language output unchanged.
- The full string sweep is sized in Task 0; it may be split into a follow-up plan if large.

## Task 6: Localized SCM event parsing (OD2)

- Read the service display name from the structured Properties[0] of the SCM event and map it to the fixed service name with CanonicalServiceName (Phase 1).
- Keep parseServiceName as fallback when the structured field is missing.
- Tests: English and pt-BR fixtures produce the same canonical name; branded display names map to fixed names; reliability scoring still recognizes the Agent's own services.
- Verify behavior with a real 7031 event from a branded service before merge (the Phase 1 design left this open).

## Task 7: Helper runtime branding and localization (Tauri and React)

- Read the branding section from the per-session helper_config.yaml (serde_norway, existing read path in lib.rs).
- Replace hardcoded titles and copy in App.tsx, AppShell.tsx and ChatView.tsx with resolved values. Unset fields show the localized Breeze default.
- Colours (OD4): expose a small semantic colour contract (for example primaryColor, accentColor) mapped to CSS variables. No per-component CSS.
- Contrast validation (OD5): reject colours that fail a minimum contrast ratio on branded surfaces, on device and in the API.
- Apply Tauri message-window isolation only if Task 0 confirms the code exists on main and the maintainer decision applies to it.
- Tests: Rust unit tests for the reader; React tests for default and branded rendering; one test that consent and PAM bodies stay fixed.

## Task 8: Configuration UI (web)

- Branding controls in Configuration Policies, Helper tab (HelperTab.tsx), at partner and organization level only.
- Blank means inherit; the inherited value and inherited source are visible; clearing an override restores inheritance.
- Save follows the existing configuration-policy mutation pattern.
- Tests: inherited defaults shown; override; clear; branding hidden at site, group and device levels.

## Task 9: Docs

- Update the Helper page in apps/docs only for the new partner and organization branding fields and the locale behavior. No later-phase content.

## Validation (every task)

- Unit tests for each touched package, plus the existing suite for each package changed.
- Default-behavior test: with no branding configured, resolver output, heartbeat payload and Helper rendering equal current main.
- Migration naming guard passes if any migration is touched (none expected).
- git diff --check clean. No secrets and no .env files.

## Stop points

- Stop before any commit or push and ask for authorization.
- Stop if a task requires changing a fixed identifier listed in Constraints.
- Stop if Task 0 finds that the resolver or heartbeat contract differs from this plan.
- No PR, comment or other GitHub publication without Portuguese approval first; English publication only after approval.

## Acceptance (spec section 12)

1. Agent localization has a documented resolution and fallback contract.
2. Machine identifiers stay stable regardless of locale.
3. Helper branding is delivered through the existing helper configuration path.
4. Branding resolves as Breeze default, partner default, organization override.
5. Organization overrides inherit unspecified partner fields.
6. Titles, welcome copy and colours change without a Helper rebuild.
7. No branding configuration preserves current behavior.
8. No native icon or resource branding is introduced.
9. Focused test coverage exists for localization, inheritance and runtime branding.
10. Each open decision in spec section 10 is recorded (done on 2026-10-15).
