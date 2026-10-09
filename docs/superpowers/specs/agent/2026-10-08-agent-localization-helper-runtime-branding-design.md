# Agent localization and Helper runtime branding (Phase 2): Design

Discussion: LanternOps/breeze#7567
Related: LanternOps/breeze#6365
Phase 1 design: LanternOps/breeze#7841
Phase 1 implementation: LanternOps/breeze#8061
Date: 2026-10-08
Status: draft follow-up — Phase 2 direction already agreed; open implementation decisions require maintainer approval

## Summary

Phase 1 established build-time display branding for the Agent while preserving Breeze's fixed technical identifiers and update/runtime contracts.

This design formalizes the already agreed Phase 2 direction from #7567, #6365, #7841 and #8061:

- OS-language localization for user-visible Agent strings.
- Runtime Helper branding for titles, welcome copy and colours through the existing Helper configuration-policy path.
- Partner default with organization override.
- Fixed technical identifiers and existing Agent/API/update contracts remain unchanged.
- Icons and other native/signed assets remain deferred to a separate design.

This document does not reopen those decisions.

The only remaining design points are listed in §10 as open implementation decisions for maintainer approval.

## 1. Approved baseline

The following items are treated as already agreed and form the baseline contract for Phase 2.

### 1.1 Agent localization

- User-visible Agent strings are localized according to the operating-system language.
- Localization affects display-facing text only.
- Fixed technical identifiers remain fixed.
- Existing API routes, protocol values, IPC identifiers, service identities and update identity are not renamed as part of localization.

### 1.2 Helper runtime branding

- Helper welcome text is runtime-configurable.
- Helper colours are runtime-configurable.
- Helper titles/windows are part of the runtime branding surface.
- Branding is delivered through the existing Helper configuration-policy path.
- The configuration model is partner default with organization override.
- Applying runtime Helper branding does not require rebuilding the Helper binary.

### 1.3 Native assets

The following remain outside Phase 2:

- tray icons;
- desktop/application icons;
- executable icons/resources;
- `.ico`, `.icns`, PNG and other bundled assets;
- signing/build-pipeline changes related to native branding.

These require a separate design.

## 2. Goals

- Add a localization layer for user-visible Agent text.
- Add runtime branding for Helper titles, welcome copy and colours.
- Reuse the existing Helper configuration path.
- Preserve Breeze defaults when no branding is configured.
- Preserve the fixed identifiers and contracts established by Phase 1.
- Support partner-default → organization-override branding behavior.
- Add focused tests for localization, inheritance and runtime branding behavior.

## 3. Non-goals

Phase 2 does not:

- rename `BreezeAgent` or `BreezeWatchdog`;
- rename executables;
- rename install directories;
- change MSI `ProductName`;
- change MSI `UpgradeCode`;
- change event-source identifiers;
- change `com.breeze.*` or `com.breezermm.*` identifiers;
- change API routes;
- change Agent/server protocol values;
- change IPC identifiers;
- introduce custom signing or release infrastructure;
- replace native/bundled icons;
- implement the deferred `go-winres` branding follow-up;
- automatically include any item from §10 unless explicitly approved.

## 4. Existing architecture

### 4.1 Phase 1 contract

Phase 1 separates display branding from machine identity.

Phase 2 must preserve that separation.

The following remain stable:

- SCM service identifiers;
- update/self-inventory identifiers;
- executable and install paths;
- MSI upgrade identity;
- protocol/API identifiers;
- other machine-readable identities already fixed by Phase 1.

### 4.2 Helper configuration path

The existing runtime path is:

```text
Configuration Policy
        ↓
effective Helper settings resolver
        ↓
Agent heartbeat/config update
        ↓
Go Agent
        ↓
helper_config.yaml
        ↓
Tauri Helper
```

Phase 2 should extend this path rather than introduce a second branding transport.

### 4.3 Configuration hierarchy

The runtime branding behavior is:

```text
Breeze defaults
      ↓
partner default
      ↓
organization override
```

Organization overrides inherit partner values they do not replace.

This must remain true even if other Helper operational settings use additional assignment levels.

## 5. Agent localization design

### 5.1 Localization boundary

Only user-visible text is localized.

Examples:

- user prompts;
- user notifications;
- consent/interaction messages;
- user-visible status text;
- human-facing CLI/help text where applicable.

The following remain untranslated:

- service identifiers;
- event-source identifiers;
- API paths;
- JSON field names;
- IPC message names;
- metric names;
- protocol values;
- machine-readable error codes.

Technical structured fields should remain stable for support and diagnostics.

### 5.2 Locale resolution

The Agent resolves user-visible text from the operating-system language.

The implementation must provide a deterministic fallback when the requested locale is unavailable.

The exact locale catalog set and any additional locale precedence rules are implementation details unless separately approved.

### 5.3 Localized operating-system text

Machine behavior should not depend on parsing translated operating-system prose when structured OS data exists.

A known case exists in Windows SCM event handling, where service identity is currently derived from rendered event text.

Whether fixing that existing behavior belongs in Phase 2 is an open decision in §10.

## 6. Helper runtime branding design

### 6.1 Branding contract

The Helper branding contract should expose runtime-configurable identity text and colours.

Illustrative shape:

```ts
interface HelperBranding {
  displayName?: string;
  welcomeTitle?: string;
  welcomeMessage?: string;
  supportLabel?: string;
  portalLabel?: string;
  // Colour representation depends on §10.
}
```

The exact property names may change during implementation review.

Observable behavior is the contract:

- no branding config → Breeze defaults;
- partner branding → partner effective values;
- organization branding → organization overrides;
- unspecified organization fields → inherited partner/default values.

### 6.2 Field-level inheritance

An organization must not be required to duplicate the entire partner branding object just to override one value.

Example:

```text
Partner:
  displayName = "Example Assist"
  welcomeMessage = "Welcome to Example Assist"
  colour = <partner value>

Organization:
  welcomeMessage = "Welcome, Contoso"

Effective:
  displayName = "Example Assist"
  welcomeMessage = "Welcome, Contoso"
  colour = <partner value>
```

The internal representation may vary, but the effective behavior remains partner default → organization field override.

### 6.3 Runtime delivery

Branding values travel through the existing Helper configuration path.

Phase 2 must not introduce a new authentication model or separate branding control channel.

The existing behavior for:

- Helper authentication;
- mTLS;
- API-origin restrictions;
- Helper lifecycle/update;
- Agent/Helper IPC identity;

remains unchanged.

### 6.4 Helper surfaces

Relevant user-visible Helper surfaces should resolve their text from either:

1. localization resources for ordinary product copy; or
2. runtime branding config for identity-specific copy.

The implementation sweep should include:

- welcome / first-run UI;
- window/header titles;
- connection state copy;
- retry/disconnected copy;
- support labels;
- portal labels;
- tray menu user-facing text;
- navigation labels;
- device-info copy;
- approval/consent copy shown to the end user.

Machine identifiers and server-provided verbatim values remain unchanged.

## 7. Configuration UI

The branding controls belong in the existing:

```text
Configuration Policies → Helper
```

surface.

The UI must follow the project settings contract:

- one concept, one home;
- partner default → organization override;
- blank means inherit;
- inherited value is visible;
- inherited source is visible;
- one resolver is the source of truth.

The exact colour-input UI depends on the decision in §10.

## 8. Compatibility

### 8.1 Default behavior

With no Phase 2 branding configuration:

- Helper remains Breeze-branded;
- existing Helper operational settings behave as today;
- no existing policy becomes invalid;
- Agent identifiers remain unchanged;
- protocol behavior remains unchanged.

### 8.2 Mixed-version behavior

New fields must be optional.

- Older Agent/Helper versions must not break because the server supports the new fields.
- New Agent/Helper versions receiving no new fields must use Breeze defaults.
- Phase 2 must not require a synchronized fleet-wide binary replacement merely to keep existing behavior working.

### 8.3 Phase 1 compatibility

Phase 2 does not alter the Phase 1 build-time branding contract.

Runtime Helper branding must not be used to rename Agent services, executables, install paths or update identifiers.

## 9. Testing

### 9.1 Agent localization

Tests should prove:

- user-visible strings pass through the localization layer;
- unavailable locale uses deterministic fallback;
- machine identifiers do not vary by locale;
- existing default-language behavior remains stable where it is part of the contract.

### 9.2 Helper branding

Tests should prove:

- no branding → Breeze defaults;
- partner branding → partner effective values;
- organization override wins;
- missing organization field inherits partner value;
- missing branding config is safe;
- runtime configuration updates Helper display text without a rebuild;
- existing operational Helper settings continue to work.

### 9.3 Configuration UI

Tests should prove:

- partner values appear as inherited organization defaults;
- individual organization fields can be overridden;
- clearing an organization override restores inheritance;
- save behavior follows the existing configuration-policy mutation pattern.

## 10. Open decisions for maintainer approval

The following items are implementation proposals only. They are not part of the approved baseline unless explicitly accepted.

### OD1 — Helper locale on multi-user / RDS hosts

**Proposal:** resolve Helper UI language from the logged-in user's session locale rather than only from the host/machine locale.

**Rationale:** the Helper is a per-user interactive UI even though the Agent is machine-scoped.

**Recommendation:** accept session/user locale resolution for Helper.

### OD2 — Localized Windows SCM event parsing

**Proposal:** include the existing SCM/7031 localization issue in Phase 2 and read the structured service-name property instead of parsing rendered English event text.

**Rationale:** Agent behavior should not vary with Windows display language when structured event data is available.

**Recommendation:** include this fix in Phase 2.

### OD3 — Offline / last-known Helper branding

**Proposal:** retain the last known valid runtime branding configuration during temporary control-plane unavailability.

**Rationale:** a temporary outage should not unexpectedly switch a branded Helper back to Breeze identity.

**Recommendation:** retain last-known valid branding.

### OD4 — Helper colour model

**Proposal:** expose a constrained semantic colour model instead of arbitrary per-component CSS values.

Example only:

```text
primaryColor
accentColor
```

**Rationale:** a bounded contract is easier to validate, maintain and evolve than arbitrary styling overrides.

**Recommendation:** use a constrained semantic colour model.

### OD5 — Colour validation and accessibility

**Proposal:** validate accepted colour values and enforce sufficient readability/contrast for branded user-facing surfaces.

**Rationale:** runtime branding must not make critical Helper UI unreadable.

**Recommendation:** include colour/accessibility validation in Phase 2.

## 11. Deferred design: native branding assets

A separate design should cover native/signed branding, including any approved subset of:

- tray icon;
- desktop/application icon;
- executable icon/resources;
- macOS `.icns`;
- Tauri bundle icons;
- native bundle/product naming;
- executable filename;
- installation directory;
- signing implications;
- operator release/build-pipeline implications.

That work must preserve update identity and compatibility and must not be folded into Phase 2.

## 12. Acceptance criteria

Phase 2 is complete when:

1. Agent user-visible localization has a documented resolution and fallback contract.
2. Machine identifiers remain stable regardless of locale.
3. Helper runtime branding is delivered through the existing Helper configuration path.
4. Helper branding resolves as Breeze default → partner default → organization override.
5. Organization overrides inherit unspecified partner fields.
6. Helper titles, welcome copy and colours can change without rebuilding the Helper binary.
7. No branding configuration preserves current Breeze behavior.
8. Native icon/resource branding is not introduced in this phase.
9. The accepted localization and branding behavior has focused test coverage.
10. Each open decision in §10 is explicitly accepted or deferred before implementation begins.

## 13. Maintainer decision record

Phase 2 baseline is not reopened by this document.

Owner review is requested only for:

- OD1 — Helper locale on multi-user/RDS hosts.
- OD2 — localized Windows SCM event parsing.
- OD3 — offline/last-known Helper branding.
- OD4 — Helper colour model.
- OD5 — colour validation/accessibility.

Suggested maintainer response format:

```text
Owner decision (YYYY-MM-DD):
OD1 approved/deferred
OD2 approved/deferred
OD3 approved/deferred
OD4 approved/deferred
OD5 approved/deferred
```

Implementation planning should begin only after these open decisions are recorded.
