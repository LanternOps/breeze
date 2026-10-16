# Agent localization and Helper runtime branding (Phase 2): Design

Discussion: LanternOps/breeze#7567
Related: LanternOps/breeze#6365
Phase 1 design: LanternOps/breeze#7841
Phase 1 implementation: LanternOps/breeze#8061
Date: 2026-10-08
Revised: 2026-10-09 (maintainer review on PR #8277)
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

### 4.3 Configuration hierarchy and resolution

**Existing behavior** (`apps/api/src/services/helperSettings.ts`). `resolveDeviceHelperSettings` selects a single winning `helper` feature link for a device. Matching assignments are ordered by level (device → device group → site → organization → partner) and then by assignment priority. The first match wins and its settings are returned as they are. There is no field-level merge: a winning assignment that omits a field yields the default for that field, not the value from a lower-precedence assignment. The resolved settings are cached per device for 120 seconds (Redis key `helper:settings:device:<deviceId>`).

**Phase 2 rule for branding (new).** Runtime branding does not follow first-match-wins. It uses a field-level merge. This is a new merge rule in this resolver, and it applies to branding fields only:

```text
Breeze defaults
      ↓
partner-level branding (per field)
      ↓
organization-level branding (per field, overrides the partner value)
```

- Operational Helper settings (`enabled`, `showTrayIcon`, `showOpenPortal`, `showDeviceInfo`, `showRequestSupport`, `portalUrl`, `lifecycleMode`) keep today's first-match-wins resolution unchanged.
- Branding fields are accepted only on `helper` policies assigned at the **partner** and **organization** levels. At the site, device-group and device levels, branding fields are rejected on write and ignored by the resolver. Those levels keep working for operational settings exactly as today.
- Branding is resolved in its own pass over the matching partner-level and organization-level assignments, independent of which assignment wins the operational settings. Otherwise a site, group or device policy that wins the operational settings would hide the partner or organization branding.
- Within one level, the existing assignment-priority order selects a single policy (first wins). The field-level merge happens only across the partner and organization levels.
- The merge is performed on the server. The device receives only the effective values, never the partner and organization layers.
- Effective branding is part of the same per-device cached settings entry. The cache is keyed per device, not per organization or partner, so a branding change reaches each device when its entry expires (up to 120 seconds) and on its next heartbeat. No cache-invalidation fan-out is introduced.
- When no `helper` policy matches, branding is empty and Breeze defaults apply.

The definition of the site, device-group and device levels is a proposal derived from the agreed partner default → organization override baseline. It is open to maintainer review.

### 4.4 Starting point and delivery split

Neither the Agent nor the Helper has an i18n layer today. In the Helper, user-visible text is hardcoded English in the source, for example "Welcome to Breeze Helper" in `apps/helper/src/App.tsx`, "Breeze Helper" in `apps/helper/src/components/shell/AppShell.tsx` and "I'm Breeze Helper." in `apps/helper/src/components/shell/ChatView.tsx`.

Branding values are single-value operator text and are not translated (see below), so runtime branding does not depend on the localization layer. The two pieces can be planned, sized and shipped separately:

| | Localization | Runtime branding |
|---|---|---|
| New components | An i18n layer and message catalogs in the Agent (Go) and in the Helper (Tauri/React) | Optional keys in the `helper` policy, a branding pass in the resolver, validation, device-side storage, Helper rendering, the policy UI |
| What it touches | Every user-visible string in both programs | A small, closed set of identity strings and colours (section 6.1) |
| Size (qualitative) | Larger. It scales with the number of strings and locales and needs a full string sweep | Smaller. It is bounded by the fields in section 6.1 |
| Depends on the other | No | No |

The sizing is qualitative. A full count of the user-visible strings in the Agent and the Helper has not been done and belongs to implementation planning.

**Single-language branding text.** `displayName`, `companyName`, `welcomeTitle`, `welcomeMessage`, `supportLabel` and `portalLabel` are each one value, written in the language the operator chose. They are not translated and are shown verbatim in every locale when set. When a field is unset, the localized Breeze default for the user's locale is shown. The surrounding product copy stays localized. Per-locale branding values are out of scope for Phase 2.

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

A known case exists in Windows SCM event handling, where the service name is currently extracted from the rendered, localized event message, which quotes the service display name.

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
  companyName?: string;
  // Colour fields: see section 6.1.1 and OD4.
}
```

The exact property names may change during implementation review.

Observable behavior is the contract:

- no branding config → Breeze defaults;
- partner branding → partner effective values;
- organization branding → organization overrides;
- unspecified organization fields → inherited partner/default values.

### 6.1.1 Input contract

Branding is operator-supplied text and colours that are rendered inside a privileged agent-shipped UI, so the accepted input is closed.

| Field | Type | Maximum length (proposed) |
|---|---|---|
| `displayName` | plain text | 60 |
| `companyName` | plain text | 60 |
| `welcomeTitle` | plain text | 120 |
| `welcomeMessage` | plain text | 500 |
| `supportLabel` | plain text | 40 |
| `portalLabel` | plain text | 40 |
| colour fields (OD4) | hex colour | exactly 7 (`#RRGGBB`) |

Lengths are counted in characters (Unicode code points). The values are proposed starting points, modelled on the existing `headline varchar(120)` and `accent_color varchar(7)` limits of `partner_login_branding`, and are to be confirmed in review.

- **Plain text only.** Values are rendered as text. They are never interpreted as HTML, Markdown or CSS.
- **No control characters.** Control characters, including line breaks, are rejected.
- **Strict hex colours.** A colour is `#` followed by exactly six hexadecimal digits. Named colours, shorthand forms, alpha channels, `rgb()`, `hsl()` and CSS expressions are rejected. This is the same shape as the existing check on `partner_login_branding.accent_color`. Contrast requirements are covered by OD5.
- **No URL or image fields.** Branding has no logo, icon, favicon, link, custom CSS or HTML field. The existing operational `portalUrl` setting is not part of branding.
- **Validated twice.** Values are validated on write by the API and again on the device when read. A value that fails validation on the device is dropped and that field falls back to its default.
- **Unknown keys are ignored.** The resolver already parses only known keys, so new fields must be added explicitly and older readers ignore them.

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

This field-level merge is a new rule. The existing Helper resolver does not merge fields (section 4.3). It applies to branding fields only, it is evaluated on the server, and the device receives only the effective values.

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

Branding rides inside the existing `helper` configuration-policy feature link (its `inlineSettings` JSONB) and reaches the device through the existing device-authenticated heartbeat. Phase 2 adds no tables, no routes and no endpoints. No new tenancy, row-level-security or cascade work applies. Branding fields are optional keys that the resolver parses explicitly.

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
- approval/consent copy shown to the end user (localized only; see section 6.5).

Machine identifiers and server-provided verbatim values remain unchanged.

### 6.5 Consent text

Branding cannot reword consent. Branding input is limited to identity strings: the product display name (`displayName`), the company name (`companyName`), the welcome line (`welcomeTitle`, `welcomeMessage`) and the support and portal labels (`supportLabel`, `portalLabel`).

- PAM elevation prompts and remote-access consent dialogs, and any other approval or consent surface, render a fixed body that Breeze owns, writes and localizes. Branding cannot replace, extend, reorder or hide any part of it.
- Where a consent surface shows the product or company name, the identity string is substituted into a fixed template slot. The template, the wording around it and its localization stay fixed.
- No branding field accepts free-form consent copy, and there is no per-surface override.

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

### 7.1 One concept, one home

Two branding concepts already exist in the repository:

- `partner_login_branding` is partner-only (no organization axis) and carries `logo_url`, `accent_color` and `headline` for the login screen.
- `portal_branding` is organization-only (one row per `org_id`) and carries logos, colours, `welcome_message`, `custom_css`, a custom domain and portal feature flags for the customer portal.

Neither can carry Helper identity. Neither offers a partner default with organization override on one resolver, neither is on the policy → heartbeat path that delivers settings to devices, and both include URL, image or CSS fields that the input contract in section 6.1.1 excludes. Helper identity is also a different concept: the name and colours an end user sees on a device, shown by the Agent and the Helper rather than by a web page. The home for it is therefore the existing `helper` policy, not a new table and not either existing one.

| Item | Value |
|---|---|
| Home | Configuration Policies → Helper (existing `helper` feature link, `inlineSettings` JSONB) |
| Level | Partner default, organization override (branding fields are not accepted at site, device-group or device level) |
| Resolver | `resolveDeviceHelperSettings` in `apps/api/src/services/helperSettings.ts`, extended with the branding pass of section 4.3 |
| Places configuring Helper identity, before | 0 (the identity strings are hardcoded in the Helper source) |
| Places configuring Helper identity, after | 1 |

The two existing concepts are unchanged: login branding stays at 1 place and portal branding stays at 1 place. Nothing existing is replaced, so there is no removal plan. Phase 2 does not copy brand values between the three homes.

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
- An older Agent or Helper ignores the branding keys it does not know.
- A newer Agent that receives no branding block from an older server keeps what it has (see OD3) and otherwise uses Breeze defaults.

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
- existing operational Helper settings continue to work;
- branding fields at site, device-group and device level are rejected on write and ignored by the resolver, and a winning site, group or device policy does not hide partner or organization branding;
- input validation: maximum lengths, plain-text rendering, strict `#RRGGBB`, control characters rejected, no URL or image field accepted;
- consent and PAM surfaces keep their fixed, localized body whatever the branding values are;
- if OD3 is approved: persisted branding is removed on organization move, partner change and re-enroll, an explicit cleared signal restores Breeze defaults, and a missing branding block keeps the last-known values.

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

**Rationale:** the Helper is a per-user interactive UI even though the Agent is machine-scoped. The Helper is already launched per user session with its own `sessions/<key>/helper_config.yaml`, so the locale of a session fits next to the rest of that session's Helper configuration. Whether the locale is detected by the Helper inside the session or written by the Agent into that file is an implementation detail.

**Recommendation:** accept session/user locale resolution for Helper.

### OD2 — Localized Windows SCM event parsing

**Proposal:** include the existing SCM/7031 localization issue in Phase 2. As recorded in the Phase 1 design, the structured `Properties[0]` of the event carries the service **display name**, not the service name, and does not depend on the Windows display language. The collector would read the display name from `Properties[0]` instead of matching the English `the (.+?) service` pattern against the rendered message, and would then map it to the fixed service name through the existing Phase 1 display-name mapping (`CanonicalServiceName`), so that reliability scoring keeps recognizing the Agent's own services.

**Rationale:** Agent behavior should not vary with Windows display language when structured event data is available. On a Windows installed in another language the English pattern does not match and the restarts of the Agent's own services are not recognized, branded or not. The behavior with a real 7031 event from a branded service remains to be verified, as already noted in the Phase 1 design.

**Recommendation:** include this fix in Phase 2.

### OD3 — Offline / last-known Helper branding

**Proposal:** retain the last known valid runtime branding configuration during temporary control-plane unavailability.

**Rationale:** a temporary outage should not unexpectedly switch a branded Helper back to Breeze identity.

**Where it persists.** In the per-session `sessions/<key>/helper_config.yaml` that the Agent already writes and the Helper already reads, as a separate branding section. It survives Agent and Helper restarts and is never held only in memory.

**Never across brands.** One partner's branding must never appear on another partner's device, so the persisted branding is tagged with an opaque scope identifier that the server derives from the partner and organization the branding was resolved for. The Agent discards the persisted branding, in every session's config, and shows Breeze defaults when:

- the scope identifier it receives differs from the stored one (organization move or partner change);
- the device is re-enrolled;
- a cleared signal is received (below).

This does not depend on the control plane being reachable. The Agent clears locally when it re-enrolls.

**Explicit cleared signal.** For operational settings, a missing field means "use the default", which cannot tell "unset" from "not sent". Branding therefore uses an explicit state in the branding block delivered with the heartbeat:

| Received | Meaning | Device behavior |
|---|---|---|
| Block with state `set` and values | Effective branding | Persist and apply |
| Block with state `cleared` | Branding explicitly unset | Delete the persisted branding and use Breeze defaults |
| No block | Not sent (older server or transient condition) | Keep the last-known branding unchanged |

Inside a `set` block, a field that is absent means the Breeze default for that field.

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
