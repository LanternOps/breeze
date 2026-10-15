---
title: Customer Portal Environment Visibility — controlled, customer-safe infrastructure views
issue: LanternOps/breeze discussion #8775
status: draft (direction accepted in discussion #8775; English working draft for review)
depends_on:
  - LanternOps/breeze discussion #5438
  - LanternOps/breeze discussion #7450
  - LanternOps/breeze#5861
  - docs/superpowers/specs/portal/2026-10-01-portal-advanced-visibility-design.md
  - docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
  - docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md
---

# Customer Portal Environment Visibility (CPEV)

## 1. Status and origin

This specification consolidates the direction accepted in Discussion #8775 as a continuation of, not a replacement for, the decisions already established in #5438 and #7450.

**Confirmed by the maintainer — #8775:**

- an explicit option per data family, per organization, and off by default;
- topology and observed location require their own opt-in and are excluded from any "Enable all" behavior;
- each wave must have an explicit field allowlist;
- no passthrough of internal records and no `jsonb` blobs;
- no credentials, management IPs, or internal hostnames, unless they are an explicitly listed and justified field;
- CPEV-W1 must be limited to data that already exists, is already discovered/registered, and is already org-scoped.

**Confirmed by the maintainer — #5438:** Network Visibility is read-only, org-scoped, and fail-closed, uses a discriminated contract for `ok` / `no_data` / `not_enabled`, does not fabricate zero when the information does not exist, and does not expose raw SNMP, credentials, monitor configuration, or internal `jsonb`.

**Confirmed by the maintainer — #7450 / PR #7642:** the Portal follows the one-flag-per-family pattern, with higher-sensitivity families deliberately excluded from "Enable all"; the public contract must select columns explicitly, and tests must prove that excluded fields do not escape.

This specification defines the visibility contract and the division into waves. It does not authorize automatic implementation of all seven waves. Each wave remains small, reviewable, and implemented separately.

## 2. Problem

Breeze already maintains, or is consolidating, a structured view of the customer's environment: asset discovery, reachability, monitoring, physical placement, topology, presence/location, and circuits. These models were built primarily for the MSP operator and contain data that must not cross the Customer Portal boundary.

The problem is not a lack of data. It is the lack of an explicit customer-safe projection layer that allows the MSP to choose, per organization, which parts of the environment the customer may view.

The Portal must answer:

> What is happening in my environment?

It must not answer:

> How did my MSP discover, infer, configure, or diagnose this environment?

## 3. Goals

CPEV must:

1. expose only read-only, customer-safe projections;
2. reuse existing canonical data and classifications, without creating parallel algorithms in the Portal;
3. derive the organization exclusively from Portal authentication;
4. keep every capability off by default when it depends on a new flag;
5. allow control per organization and per data family;
6. define closed, field-by-field allowlists before implementing each wave;
7. preserve the `no_data` / `not_enabled` states when absence and disablement are semantically different from zero;
8. prevent leakage of credentials, operational configuration, raw evidence, free-form payloads, and inference metadata;
9. reuse the canonical reachability, topology, and presence services/read models instead of recomputing the same meaning in the Portal;
10. keep the Customer Portal a visibility surface, not an infrastructure operations surface.

## 4. Global non-goals

CPEV does not include:

- topology editing;
- changing the assigned site of a device;
- automatic movement of devices;
- editing or provisioning circuits;
- changing monitors, thresholds, templates, or polling;
- executing SNMP actions;
- SNMP credentials or other credentials;
- raw OIDs or raw SNMP payloads;
- raw discovery payloads/evidence;
- fingerprints, gateway MAC evidence, or neighbour evidence;
- collector internals;
- debug/execution metadata;
- Portal-specific inference of reachability, topology, or location;
- copying the technician console to the customer.

## 5. Visibility control model

### 5.1 General rule

Each family exposed by CPEV must have an explicit gate, per organization, with default `false`, following `portal_branding` and the current Portal pattern.

A missing, `false`, or `null` row must fail closed.

### 5.1.1 Enforcement of "outside Enable all" (maintainer review, 15/10/2026)

Keeping a flag outside "Enable all" is enforced by a mechanism, not by convention:

- every new flag that reveals layout or other sensitive data (`enableNetworkTopology`, `enableObservedLocation`, the future monitoring/SNMP flag, and `enablePhysicalPlacement`) is added to `PORTAL_SENSITIVE_FLAG_KEYS` in `packages/shared/src/validators/portal.ts`;
- `apps/api/src/services/portal/portalFlags.test.ts` pins the exact list of that constant, so adding a key requires updating that test in the same change;
- `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx` checks specific sensitive flags (for example `enablePatchDetail`) stay off through "Enable all". It does not iterate over the whole list, so each new sensitive flag needs its own case there;
- a flag that is not in `PORTAL_VISIBILITY_FLAG_KEYS` is not turned on by "Enable all", so the two tests together are what keep the boundary true.

### 5.1.2 Gate pattern per family

The existing gates are of two kinds, in `apps/api/src/routes/portal/featureFlags.ts`:

- `not_enabled` with null metrics or an empty list, as for `enableNetworkVisibility` (the approved shared contract from #5438);
- strict fail-closed `403`, as for `enablePatchDetail`, `enableVulnerabilityDetail` and `enableHourBlock`.

Each family must state which kind it follows. **Decision:** W1 (`enablePhysicalPlacement`) follows the `not_enabled` contract, the same as `enableNetworkVisibility`, so the network surface keeps a single shared contract. W5 and W6 also follow `not_enabled`, as a suggestion of this specification. W4 must choose its pattern when its flag is defined.

### 5.2 Family and flag matrix

| Family | Waves | Flag | Decision status | "Enable all" |
|---|---:|---|---|---|
| Network | W2, W3 | `enableNetworkVisibility` / `enable_network_visibility` | **Existing and confirmed in code** | follows existing behavior |
| Placement | W1 | `enablePhysicalPlacement` / `enable_physical_placement` | **Name proposed in this spec; new flag** | **outside "Enable all"** (decided 15/10/2026; rack and room are physical layout) |
| Monitoring / SNMP detail | W4 | **TBD: new dedicated monitoring-family flag** | family required by the maintainer; name not yet defined | proposed: outside "Enable all" until the maintainer decides |
| Topology | W5 | `enableNetworkTopology` / `enable_network_topology` | **Name proposed in this spec; new flag** | **outside "Enable all" — mandatory** |
| Observed location | W6 | `enableObservedLocation` / `enable_observed_location` | **Name proposed in this spec; new flag** | **outside "Enable all" — mandatory** |
| Circuits | W7 | `enableCircuitVisibility` / `enable_circuit_visibility` | **Name proposed in this spec; depends on the circuits foundation** | proposed: outside "Enable all" until the wave is reviewed |

`enableNetworkAlerts` remains the existing flag for alert/ticket enrichment of Network Visibility assets. It must not be reused as the gate for Advanced SNMP; alerts and SNMP are distinct contracts with distinct sensitivities.

**Decision still needed:** the names of the new flags are suggestions of this specification. What is confirmed as required is per-family isolation and per-organization opt-in, not these specific names.

### 5.3 Per-family implementation checklist

The flags are columns on `portal_branding`, which is org-scoped. Partner-Wide First (`docs/agents/tenancy-rls.md`) does not apply, because these are per-organization visibility switches, not policy or config rows that could be partner-wide. The existing mechanics are described in §3 of `docs/superpowers/specs/portal/2026-10-01-portal-advanced-visibility-design.md` and are reused, not re-derived here.

For each family, the implementation must include:

1. a `portal_branding` column with `default false`, in a new migration named per `apps/api/migrations/README.md` (sorted after the newest committed migration, `set_config('breeze.scope', 'system', true)` when it writes rows);
2. a classification of **each new column** in `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`); any `json`/`jsonb`/`bytea` column is `excludedOpen`;
3. a `.strict()` validator entry in `packages/shared/src/validators/portal.ts`;
4. the column in the `/portal/branding` select (`apps/api/src/routes/portal/branding.ts`) and the matching type additions in the portal;
5. the key in `PORTAL_VISIBILITY_FLAG_KEYS` (only if it is inside "Enable all") or in `PORTAL_SENSITIVE_FLAG_KEYS` (if it is outside), with the corresponding update to `portalFlags.test.ts` and `OrgPortalSettingsEditor.test.tsx` (see §5.1.1);
6. the gate pattern chosen in §5.1.2;
7. the reference to the field allow-list for the wave (§6).

## 6. Field exposure rule

For every wave:

- the Portal read model selects only explicitly listed fields;
- no unrestricted `select()` of an internal table may form the public DTO;
- `json`, `jsonb`, `bytea`, operational free text, and open containers are excluded by default;
- internal IDs are omitted when they are not needed for navigation/contract stability;
- fields needed only for joins, authorization, or inference may be read by the backend and still not appear in the DTO;
- contract tests must seed sensitive fields in the source records and prove that they do not appear in the serialized response.

## 7. CPEV-W1 — Physical Placement Visibility

### 7.1 Goal

Expose to the customer the structured physical location of an asset already known to Breeze, without exposing the placement authority/reconciliation mechanics.

### 7.2 Current state confirmed in code

`asset_physical_placements` already exists and is org-scoped. Its placement content is exactly:

```text
room
rack
rackUnit
heightU
```

The model accepts as subject a managed `device` or a `discovered_asset`. The site is **not stored** in the placement; it is derived from the current subject. When a discovered asset is linked to an eligible managed device, the managed device becomes the placement authority.

This means the Portal must not create another authority rule and must not copy `site_id` into a new structure.

### 7.3 Flag

New per-organization flag, default `false`:

```text
enablePhysicalPlacement
```

Name subject to maintainer approval.

### 7.4 Proposed customer-safe DTO

The projection must be an optional block of the asset detail:

```ts
physicalPlacement?: {
  siteName: string;
  room: string | null;
  rack: string | null;
  rackUnit: number | null;
  heightU: number | null;
}
```

**Exact W1 allowlist:**

| Public field | Source | Rule |
|---|---|---|
| `siteName` | live site of the subject/authority | customer-safe name; do not copy `site_id` into the contract if not necessary |
| `room` | `asset_physical_placements.room` | direct, nullable |
| `rack` | `asset_physical_placements.rack` | direct, nullable |
| `rackUnit` | `asset_physical_placements.rack_unit` | integer 1..100 or null |
| `heightU` | `asset_physical_placements.height_u` | integer 1..100 or null |

### 7.5 Fields explicitly excluded from W1

Do not expose:

```text
asset_physical_placements.id
org_id
device_id
discovered_asset_id
created_at
updated_at
authority kind
linked/unlinked state
reconciliation outcome
placement conflict state
additional internal subject identifiers
```

The backend may use the IDs for joins and authorization, but they are not part of the customer-safe placement block.

### 7.6 Behavior

- flag off or absent: no placement is exposed;
- flag on and placement absent: block omitted; do not fabricate strings such as `Unknown`;
- flag on and placement present: return only the allowlist;
- authority resolution must reuse `resolvePlacementAuthority()` and `readPlacement()` or an equivalent composition that preserves their rules exactly, not a second implementation;
- W1 is read-only in the Portal.

### 7.7 W1 acceptance criteria

1. Organization A never receives B's placement.
2. The orgId is derived from `portalAuth`, never from an authoritative query/body.
3. A managed device and a linked discovered asset do not produce conflicting placements in the Portal; the canonical authority is respected.
4. The displayed site is the authority's live site, not a value duplicated in the placement.
5. Flag absent/false exposes none of the five public fields.
6. Internal fields and administrative timestamps do not appear in the response.
7. A real database test covers cross-org isolation.
8. A contract test proves the absence of the excluded fields.

## 8. CPEV-W2 — Network Site Health

### 8.1 Goal

Provide a per-site aggregation of the customer-safe signals already used by Network Visibility, without creating a new health score.

### 8.2 Flag

Uses the existing flag:

```text
enableNetworkVisibility
```

Additional alert enrichment remains conditioned on `enableNetworkAlerts`.

### 8.3 Confirmed canonical sources

The current Network Visibility implementation already uses:

- `discovered_assets` for inventory;
- `loadReachability()` for reachability state — not `discovered_assets.isOnline` as the authority;
- org-scoped `network_monitor_results` for monitor results;
- `network_monitors` as the definition, including partner-wide, without using the shared `lastStatus` as organization-specific state;
- `networkSites()` for sites with visible, non-dismissed assets.

### 8.4 W2 allowlist

Per site:

```text
siteName
totalAssets
onlineAssets
offlineAssets
unverifiedAssets
snmpDevicesPolling
monitorsDown
```

When `enableNetworkAlerts=true`, the following may be added:

```text
activeAlertCount
highestAlertSeverity
```

`highestAlertSeverity` is limited to:

```text
critical | high | medium | low | info | null
```

`lastValidObservationAt` is **not in the initial allowlist** until a single, canonical, unambiguous source exists for the per-site aggregate. It must not be synthesized from heterogeneous timestamps.

### 8.5 W2 exclusions

- monitor IDs/configuration;
- polling interval;
- thresholds;
- monitor result rows;
- raw alert context;
- alert-rule configuration;
- ticket internals;
- discovery evidence;
- SNMP credentials or raw metrics;
- any site-health score invented by the wave.

## 9. CPEV-W3 — Network Asset Detail

### 9.1 Goal

Stabilize a customer-facing projection of a single network asset that can compose blocks from waves approved later.

### 9.2 Flag

Uses `enableNetworkVisibility`.

### 9.3 W3 base allowlist — already supported by the current contract

```text
id
hostname
label
ipAddress
macAddress
assetType
onlineState
lastSeenAt
firstSeenAt
manufacturer
model
siteName
```

`onlineState` keeps the existing semantics:

```text
online | offline | null
```

where `null` means unverified and is never converted to offline.

When `enableNetworkAlerts=true`, the contract may include the already-existing optional fields:

```text
activeAlertCount
highestAlertSeverity
openTicketCount
```

### 9.4 W3 exclusions

- raw fingerprints;
- open ports;
- discovery payloads/evidence;
- collector data;
- monitor IDs/configuration/thresholds;
- raw alert context;
- raw neighbor rows;
- raw SNMP state/OIDs;
- inference/debug metadata.

W3 may compose `physicalPlacement`, `snmp`, `observedLocation`, and topology relationships only when the respective flags are enabled and each block follows its own allowlist.

## 10. CPEV-W4 — Advanced SNMP Visibility

### 10.1 Status

The idea has already appeared in the approved Advanced Portal Visibility spec as an on-hold option. #8775 presents a concrete case, but the maintainer has not yet approved reactivating it or the flag name. Therefore W4 remains an **outline / pending decision**, not an implementation requirement.

### 10.2 Gate

Use a dedicated monitoring-family flag, default `false`. Until an explicit decision, it must remain outside "Enable all".

### 10.3 W4 candidate allowlist

If the wave is reactivated, limit the projection to data derived from reviewed standard OIDs/MIBs:

```text
pollingState
uptimeSeconds
interfaces[].name
interfaces[].operState
interfaces[].speedBps
interfaces[].inBps
interfaces[].outBps
interfaces[].inErrors
interfaces[].outErrors
printerSupplies[].description
printerSupplies[].percentRemaining
pageCount
```

`pollingState` must be a customer-safe enum and not the internal polling row.

### 10.4 Never expose in W4

```text
community
username
authPassword
privPassword
authProtocol
privProtocol
managementIp
port
pollingInterval
raw OID
raw metric name
raw metric payload
SNMP template
error/backoff internals
monitor rules
```

The future implementation must have a fixed OID allowlist in the backend and serialize only the public fields above; the OID itself never crosses the contract.

## 11. CPEV-W5 — Customer-safe Network Topology

### 11.1 Status

Outline. The wave must consume the canonical topology read models and reduce the result; it cannot build a second topology engine for the Portal.

### 11.2 Flag

New independent flag, default `false`, mandatorily outside "Enable all":

```text
enableNetworkTopology
```

Proposed name.

### 11.3 W5 initial candidate allowlist

Nodes:

```text
id
displayName
assetType
manufacturer
model
onlineState
ipAddress
```

Edges:

```text
sourceId
targetId
relationshipType
```

`relationshipType` must use a customer-safe enum explicitly reviewed by the wave; it must not automatically pass through the internal kinds.

### 11.4 W5 exclusions

- raw topology node attributes;
- raw relationship attributes;
- topology epochs/generations;
- observer/collector IDs;
- neighbour evidence;
- routes/default-route evidence;
- fingerprints;
- logical context keys;
- source evidence IDs;
- inference confidence/metadata;
- debug attributes;
- raw interface configuration.

The need for `id`, `sourceId`, and `targetId` is functional, to render relationships; these IDs must be the minimum stable ones already authorized by the projection and must not open access to additional internal endpoints.

## 12. CPEV-W6 — Observed Location Visibility

### 12.1 Confirmed current state

Breeze already has its own presence/location read model. The classifier produces `home`, `visiting`, `unrecognized`, `ambiguous`, and `unknown` (`apps/api/src/services/topology/presenceClassifier.ts:43`). `stale` is not a classifier output: it is a persisted presence state, set on stored rows whose evidence is no longer current (`apps/api/src/db/schema/topologyPresence.ts:79`). Assignment is kept separate from observation. The model also contains `reason`, prefixes, gateway address, MAC corroboration, fingerprints, evidence, suggestions, and history — this data is operational and is not appropriate for passthrough to the Portal.

### 12.2 Flag

New independent flag, default `false`, mandatorily outside "Enable all":

```text
enableObservedLocation
```

Proposed name.

### 12.3 W6 customer-safe contract

The public projection must be optional:

```ts
observedLocation?:
  | { kind: 'corporate_network'; siteName: string }
  | { kind: 'external_network' };
```

### 12.4 Mapping rule

**Confirmed by the presence spec:** `home` and `visiting` are positive states based on canonical rules, whereas the absence of a match does not prove that the device is outside the corporate network.

Therefore:

- `home` → `corporate_network` with the name of the applicable assigned/current corporate site;
- `visiting` → `corporate_network` with the customer-safe name of the matched site, only when that information is authorized;
- `unrecognized`, `ambiguous`, `stale`, `unknown` → **field omitted**, for now.

`external_network` remains **without an authorized source** in this specification. It cannot be derived from `unrecognized` or from the absence of a corporate match.

### 12.5 W6 exclusions

```text
reason
prefix
gatewayAddress
gatewayMac
macCorroborated
fingerprints
declaredBy
declarationIds
observerDeviceIds
evidence
observedAt/freshUntil when used as internal diagnostics
coverageReason
fingerprintVersion
suggestedSiteId
suggestionDays
suggestionFirstAt
suggestionLastAt
daily presence rows
assignment-confirmation internals
```

If a positive, canonical external-network signal is approved in the future, it must first be added to the canonical model and only then mapped to `external_network`; it must not be born as a Portal-exclusive heuristic.

## 13. CPEV-W7 — WAN / Circuit Visibility

### 13.1 Status

Deferred until the WAN/circuits foundation is stable in `upstream/main`. The Physical Placement and Circuits spec already defines circuits as org-owned customer data and separates service metadata from operational health. The Portal contract must not precede a stable canonical implementation.

### 13.2 Flag

New per-organization flag, default `false`:

```text
enableCircuitVisibility
```

Proposed name.

### 13.3 W7 candidate allowlist

When the foundation is stable, the wave may evaluate:

```text
provider
circuitLabelOrCid
bandwidth
serviceType
associatedInterfaceDisplayName
primarySiteName
servedSiteNames[]
```

The final public names must reflect the actual fields of the canonical implementation at that time; no future field should be created merely to satisfy this outline.

### 13.4 Operational status

Do not expose `up`, `down`, or `degraded` based on the existence, reassociation, or administrative state of a circuit.

Operational status may only be included when there is an authoritative, reviewed monitoring relationship. `servedSiteNames` describes association/potential impact and does not prove a site outage.

### 13.5 W7 exclusions

- credentials;
- provisioning details;
- reassociation internals/state;
- topology lifecycle internals;
- raw interface configuration;
- provider API internals;
- troubleshooting evidence;
- inferred outage without an authoritative monitoring source.

## 14. Organization, authorization, and tenancy

### 14.1 Request rule

Every CPEV route must:

1. authenticate via the Portal;
2. derive `orgId` from `portalAuth`;
3. ignore/reject any client attempt to choose another organization as the authoritative context;
4. execute the read under the same `withDbAccessContext` / organization scope used by the Portal read models;
5. preserve RLS as a mandatory database defense, not merely an application filter.

### 14.2 Site and asset IDs in filters

When a route accepts `siteId` or `assetId`, the value works only as a selector within the authenticated organization. It never changes the organization context.

An ID belonging to another org must result in absence/denial according to the route's pattern, never in cross-tenant data.

## 15. Security and field leakage prevention

Each wave must have:

1. a flag absent / false / true test;
2. an org isolation test A→A, A↛B, B↛A;
3. a test with source records deliberately populated with sensitive values;
4. an assertion on the serialized response proving that forbidden fields do not appear;
5. a `no_data` test where applicable;
6. a test that prevents `ok` with fabricated zeros when the source is unavailable;
7. an auth-derived org scope test, including an attempt at a forged org/site/asset ID where applicable;
8. a test of "Enable all" behavior for flags that must remain outside it;
9. a real-Postgres integration test for any read model whose guarantee depends on RLS/org-scoped joins.

No test should rely only on TypeScript to prove the absence of a secret; the serialized response is the boundary that must be verified.

## 16. UI impact

### 16.1 Customer Portal

The target architecture may compose:

```text
Network
├── Overview
├── Sites
│   └── Environment summary (W2)
├── Assets
│   └── Asset detail (W3)
│       ├── Physical placement (W1)
│       ├── SNMP (W4)
│       └── Observed location (W6)
├── Topology (W5)
└── WAN / Circuits (W7)
```

Flag-dependent blocks must disappear completely when disabled. The frontend must not receive sensitive data only to hide it visually afterward.

### 16.2 MSP / default web console

The MSP continues to configure visibility in the existing home of Portal settings for the organization. This spec does not create a second configuration area.

Any new setting must comply with the project's "one concept, one home" rule and document the home, level, resolver, and number of configuration places in the implementation PR.

## 17. Sequencing

The grouping approved for specification remains:

```text
CPEV-W1 — Physical Placement
CPEV-W2 — Network Site Health
CPEV-W3 — Network Asset Detail

CPEV-W4 — Advanced SNMP
CPEV-W5 — Customer-safe Topology
CPEV-W6 — Observed Location

CPEV-W7 — WAN / Circuits
```

Recommendation of this specification:

- **W1:** ready to become an issue/implementation wave after review of this spec;
- **W2:** canonical source sufficient for a detailed implementation spec;
- **W3:** much of the allowlist already exists in the current contract; detail the endpoint/UX in its own wave;
- **W4:** await an explicit decision on reactivation and on the name/gate of the monitoring family;
- **W5:** detail the relationships enum before implementing;
- **W6:** corporate network can use canonical presence; `external_network` remains blocked for lack of an authorized positive signal;
- **W7:** await the circuits foundation to stabilize in `main`.

The waves must not be implemented in a single PR.

## 18. CPEV feature acceptance criteria

CPEV is consistent with the approved direction when:

- [ ] each family has a per-organization gate and default off when new;
- [ ] topology and observed location are outside "Enable all";
- [ ] all public responses have closed allowlists;
- [ ] no credential, raw OID, raw `jsonb`, evidence, or debug metadata crosses the boundary;
- [ ] org scope comes from Portal auth;
- [ ] tests prove cross-tenant isolation and the absence of sensitive fields;
- [ ] W1 uses the existing placement authority and derives the site from the live subject;
- [ ] W2/W3 reuse the existing reachability and monitor-result semantics;
- [ ] W5 does not create a parallel topology engine;
- [ ] W6 does not turn "no corporate match" into external network;
- [ ] W7 does not turn administrative circuit metadata into operational health;
- [ ] there are no infrastructure mutations from these Portal surfaces.

## 19. Open decisions

### Q1 — Final names of the new flags

The names `enablePhysicalPlacement`, `enableNetworkTopology`, `enableObservedLocation`, and `enableCircuitVisibility` are suggestions. What is confirmed as required is an independent flag per family, not these names.

### Q2 — Placement and "Enable all"

The maintainer explicitly required that topology and observed location stay outside "Enable all". There was no equivalent decision for placement. Decided on 15/10/2026: placement stays outside "Enable all", as recommended in the maintainer's review of PR #8790, because rack and room are physical layout.

### Q3 — Monitoring / Advanced SNMP

Reactivation remains pending. If approved, W4 needs a new dedicated flag; `enableNetworkAlerts` must not be reused.

### Q4 — External network

Today the presence engine proves corporate `home`/`visiting`, but `unrecognized` does not prove external. Until a canonical positive signal exists, `external_network` must be omitted.

### Q5 — Topology relationship enum

W5 must define, in its wave spec, the list of customer-safe relationship types. Automatically reusing all internal kinds is prohibited.

### Q6 — Final circuit fields

W7 only freezes its contract after the canonical circuits implementation is stable in `upstream/main`.

## 20. Decision traceability

### Confirmed in code

- `enableNetworkVisibility` exists in `portal_branding` and is part of `PORTAL_VISIBILITY_FLAG_KEYS`.
- Network Visibility derives reachability through a canonical service, maintains `not_enabled`/`no_data`, and explicitly selects the asset fields.
- `NetworkAssetRowDto` already exposes identification, reachability, basic inventory, site, and optional alert/ticket enrichments.
- `asset_physical_placements` already exists, is org-scoped, and stores only room/rack/U/height besides internal IDs/timestamps.
- placement derives the live site from the subject and has a canonical authority rule for a discovered asset linked to a device.
- presence/location already exists as a separate read model with positive and inconclusive states, plus internal evidence that must not be passed to the Portal.

### Confirmed in the existing spec

- Advanced Portal Visibility requires closed field lists and keeps more sensitive data outside "Enable all".
- Physical Placement and Circuits keeps the site out of the placement row and treats circuit metadata as administrative, not health.
- Topology site location keeps administrative assignment separate from observed presence and states that unmatched evidence is not absence.

### Confirmed by the maintainer

- #8775 was accepted as a spec continuing #5438/#7450.
- opt-in per family, per organization, and default off.
- topology and observed location outside "Enable all".
- exact field allowlists per wave.
- no internal/jsonb passthrough; no unjustified credentials, management IPs, or internal hostnames.
- W1 limited to the existing, org-scoped foundation.

### Inferences deliberately avoided

- absence of a corporate match does not mean external network;
- circuit administrative state does not mean link health;
- a shared monitor definition/status does not mean one organization's result;
- a placement row is not a new source of site assignment;
- an internal topology relationship is not automatically customer-safe.

### Suggestions of this specification

- names of the new flags;
- keeping W4 and W7 outside "Enable all" until specific review;
- minimal W1 placement DTO;
- initial W5 nodes/edges allowlist;
- omitting `external_network` until a canonical positive signal exists.
