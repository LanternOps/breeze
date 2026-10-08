# Physical Placement and Circuits — V1 Design

**Date:** 2026-10-07

**Status:** Draft — prepared from Discussion #8134 and maintainer review; awaiting maintainer approval before implementation

**Discussion:** #8134

**Maintainer review:** discussion comment `18803894` (ToddHebebrand)

**Related:** `2026-09-15-intelligent-network-topology-design.md`, `2026-09-15-intelligent-network-topology-data-contracts.md`, `2026-10-03-topology-site-location-design.md`, `../device-lifecycle/2026-09-07-manual-asset-entry-spec.md`

## Summary

Add structured physical placement and telecommunications-circuit context to the assets Breeze already owns, without creating a second inventory or a second topology model.

V1 keeps the existing ownership boundaries intact:

- `devices` and `discovered_assets` remain the asset sources of truth;
- `topology_interfaces` remains the interface source of truth;
- `topology_relationships` remains the physical/logical relationship source of truth;
- the operator adds only context that discovery cannot reliably observe;
- circuits are org-owned customer records associated with an existing interface;
- the circuit's primary site is always derived from its current termination, never stored independently;
- additional served sites are explicit org-scoped relationships and are described as **potentially impacted**, never automatically down;
- V1 surfaces placement and circuit context on asset/interface detail; alert/ticket enrichment is a second implementation wave after explicit alert-to-interface provenance exists;
- topology rendering, cable plant, and provider automation remain separate future work.

The design introduces four small org-owned data structures:

```text
asset_physical_placements
circuits
circuit_terminations
circuit_served_sites
```

`circuit_terminations` is deliberately a separate 0..1 relationship instead of a nullable interface FK on `circuits`. Routine topology coalescing/generation replacement must transfer operator-owned WAN role and circuit termination to the known successor interface before deleting the predecessor. If no deterministic successor exists, deleting the relationship leaves the customer circuit record intact in a visible `needs_reassociation` state rather than deleting the carrier service record or storing a stale primary site.

---

## 0. Verified current state

The following points were verified against the current repository before choosing the design.

### 0.1 Placement

Structured room/rack/U placement does not exist.

`manual_assets.location` is a free-text field for manual, non-network inventory. Device custom fields can represent arbitrary values for managed devices but do not provide a shared typed placement model for managed and discovered network assets.

V1 therefore needs a first-class placement relation that can refer to either:

```text
managed device (`devices`)
OR
discovered network asset (`discovered_assets`)
```

without copying the asset itself.

### 0.2 Interfaces

`topology_interfaces` already has:

```text
id
org_id
site_id
owner_node_id
interface_key
epoch
kind
role nullable
name
alias
...
retired_at
```

No current writer was found that assigns `topology_interfaces.role`.

V1 uses the existing `role` column for the operator-owned value `wan`. Discovery/publication must preserve an operator-set non-NULL role rather than overwrite it.

### 0.3 Physical links

`topology_relationships` already models relationships between topology nodes with optional source/target interface IDs. `topology_node_bindings` maps topology nodes back to managed devices and discovered assets.

V1 does not add a cable/link table and does not duplicate those relationships.

### 0.4 Circuits

No circuit entity currently exists. A circuit is therefore genuinely new customer data, not an alternate representation of an existing Breeze object.

### 0.5 Site moves

Discovered-asset site moves intentionally invalidate topology authority: the current move path deletes topology node bindings and later allows topology to be re-established in the target site. A stable asset record can therefore outlive the topology interface row that represented its old site/interface generation.

That means a circuit must survive an interface disappearing or being replaced. When the topology lifecycle knows the predecessor/successor pair, V1 carries the operator-owned WAN role and termination to the successor. When no deterministic successor exists, V1 exposes **needs reassociation** rather than silently treating the circuit as an ordinary unassigned record.

### 0.6 Monitor/interface context

The current `bindTopologyMonitor` writer does not populate an interface identifier in `topology_monitor_bindings.origin_policy`, and `alerts` has no interface column. Therefore the repository does not currently provide a reliable alert -> interface source for circuit enrichment.

Alert/ticket context is deferred to Wave 2. That wave must first define and test explicit interface provenance at monitor-bind/alert creation time; it must never guess a circuit merely because an asset has one or more WAN interfaces.

---

## 1. Binding design decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Inventory ownership | **No new asset inventory.** Placement points to existing `devices` / `discovered_assets`. | Maintains the asset-centred contract from Discussion #8134. |
| D2 | Placement subject | **One physical box has one authoritative placement.** Unlinked discovered assets may own placement; once linked through `discovered_assets.linked_device_id`, the managed `device` is authoritative. | Prevents a managed device and its linked discovered representation from carrying conflicting placements. |
| D3 | Placement site | **Not stored.** Site is derived live from the subject asset. | Placement survives a same-org site move and cannot drift from asset assignment. |
| D4 | Placement vocabulary | **Room, rack, rack unit, height U only.** | Typed V1 fields; no cable/patch-panel model and no generic JSON bag. |
| D5 | WAN classification | **`topology_interfaces.role = 'wan'`, operator-owned.** | Reuses the existing interface record; no parallel interface entity. |
| D6 | Discovery ownership | **Discovery never overwrites a non-NULL operator role; known topology successor paths transfer the role.** | Prevents refresh/coalesce/generation roll from erasing WAN classification. |
| D7 | Circuit ownership | **Org-owned customer data.** | Circuits are customer service records, not partner-wide policy/config. |
| D8 | Circuit identity | **Provider + CID are scalar fields; no provider table in V1.** | Avoids a second provider-management subsystem. |
| D9 | Termination | **Separate `circuit_terminations`, max one active termination per circuit.** | Lets the circuit survive interface deletion/replacement while keeping cross-org linkage enforceable. |
| D10 | Primary site | **Derived from the current terminating interface/site; never stored.** | Eliminates duplicate state and follows Todd's explicit requirement. |
| D11 | Additional sites | **Separate `circuit_served_sites`.** | Same-org FK enforcement; represents dependency/use, not outage state. |
| D12 | Primary site in served list | **Rejected on write and de-duplicated on read.** | Keeps “additional” semantically distinct from termination. |
| D13 | Interface lifecycle | **Known successor: transfer role + termination. Unknown successor: `needs_reassociation`.** | Routine topology churn must not silently erase operator-owned context, while uncertain replacement must not be guessed. |
| D14 | Asset/site move | **Placement follows automatically; topology carries termination across a deterministic interface successor, otherwise the circuit becomes `needs_reassociation`.** | Placement is asset-bound; topology interfaces can rotate across moves/generations but known replacement paths can preserve operator context safely. |
| D15 | Asset deletion | **Placement cascades; circuit survives; termination relation disappears with its interface.** | A carrier circuit can continue to exist after router replacement. |
| D16 | Health semantics | **Circuit service metadata is administrative, not live outage health.** | Monitoring remains the source of operational health. |
| D17 | Alert/ticket context | **Wave 2 after explicit alert-to-interface provenance exists.** | The current monitor binding writer does not populate `interfaceId`, so Wave 1 must not promise enrichment that resolves zero alerts. |
| D18 | Impact wording | **“Potentially impacted sites”.** | Served-site association does not model redundancy or prove an outage. |
| D19 | Topology rendering | **Deferred.** | Todd requested a minimum V1 surface; topology rendering is a later wave. |
| D20 | Cable plant / provider automation | **Explicitly out of V1.** | No future-only columns or structures. |

---

## 2. Goals

V1 must:

1. store structured physical placement for managed devices and discovered assets;
2. let an operator classify an existing current topology interface as WAN;
3. create and manage org-owned circuits without creating a new inventory system;
4. attach a circuit to an existing topology interface without manually creating a port;
5. derive the primary site from the current termination instead of storing it;
6. allow zero or more additional served sites from the same organization;
7. reject cross-organization placement/circuit/site/interface relationships at the database layer;
8. preserve placement when its asset changes site within the same organization;
9. preserve the circuit record when its terminating interface/asset disappears;
10. distinguish intentionally unassigned circuits from circuits that require reassociation after an unresolved topology lifecycle change;
11. show placement and circuit context on asset detail;
12. define Wave 2 alert/ticket enrichment only after an explicit alert-to-interface provenance contract is implemented and tested;
13. use “potentially impacted” for served sites and never compute site outage from this relation;
14. participate in RLS, org erasure, tenant export, org merge, and site-scoped authorization contracts;
15. leave current topology physical links authoritative and untouched.

---

## 3. Non-goals

V1 does not include:

- cable inventory;
- patch panels;
- front/rear port modelling;
- cable tracing;
- a rack inventory/entity graph;
- rack capacity planning;
- creating topology interfaces manually;
- duplicating `topology_relationships` physical links;
- a provider master-data table;
- provider credentials;
- provider API integration;
- provider email automation;
- provider ticket creation;
- provider SLA modelling;
- redundancy/SD-WAN path modelling;
- automatic “site down” computation from circuit state;
- topology-map circuit rendering;
- automatic reassociation of a circuit to a replacement interface based only on name/MAC/index similarity;
- circuit cost/billing fields;
- free-form JSON metadata intended “for later”;
- physical placement for `manual_assets` in this V1.

`manual_assets` are explicitly deferred. The maintainer requirement for this V1 is managed devices plus discovered assets; adding a third asset class is additive later and should follow demonstrated demand rather than expand this first contract.

---

## 4. Terminology

### 4.1 Physical placement

Human-maintained information that describes where an existing Breeze network asset is physically installed inside its current assigned site.

V1 fields:

```text
room
rack
rack unit
height (U)
```

The asset's organization and site are not placement fields; they remain properties of the existing asset.

### 4.2 WAN interface

A current `topology_interfaces` row whose operator-owned `role` is `wan`.

WAN is a classification of an existing discovered interface, not a new interface record.

### 4.3 Circuit

An org-owned telecommunications service record containing carrier/service context such as provider, CID and bandwidth.

A circuit may exist without a current termination while equipment is being replaced or topology is being rebuilt.

### 4.4 Termination

The current 0..1 relationship between one circuit and one current topology interface.

### 4.5 Primary site

The site derived from the current terminating interface. It is a read-model value, never a stored circuit column.

### 4.6 Additional served site

A site in the same org that uses/depends on a circuit in addition to the termination site.

This is documentation/context only. It does not assert that the site becomes unavailable when the circuit fails.

---

## 5. Data model

All new tables are **tenancy shape 1** with direct `org_id NOT NULL` and the standard `breeze_has_org_access(org_id)` RLS policies.

They are customer data, not config/policy. Partner-Wide First does not apply.

Every composite FK that includes `org_id` is `DEFERRABLE INITIALLY IMMEDIATE` so organization merge can defer constraints while repointing rows.

### 5.1 `asset_physical_placements`

One placement row points to exactly one existing network asset.

Conceptual schema:

```sql
CREATE TABLE asset_physical_placements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  device_id            uuid NULL,
  discovered_asset_id  uuid NULL,
  room                 varchar(255) NULL,
  rack                 varchar(128) NULL,
  rack_unit             integer NULL,
  height_u              integer NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CHECK (num_nonnulls(device_id, discovered_asset_id) = 1),
  CHECK (rack_unit IS NULL OR rack_unit BETWEEN 1 AND 100),
  CHECK (height_u IS NULL OR height_u BETWEEN 1 AND 100)
);
```

Required constraints/indexes:

```text
UNIQUE(device_id) WHERE device_id IS NOT NULL
UNIQUE(discovered_asset_id) WHERE discovered_asset_id IS NOT NULL
(device_id, org_id) -> devices(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
(discovered_asset_id, org_id) -> discovered_assets(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
index(org_id)
```

Implementation must verify or add the composite unique key required on the referenced parent without weakening current tenancy contracts.

**No `site_id` column.** The route resolves the subject and uses its live site for authorization and display. A same-org site move therefore changes the placement's visible site automatically with no rewrite.

The row may be partially populated. An empty placement (all four placement fields NULL) is not persisted; deleting the last value deletes the placement row.

**Linked discovered-asset authority:** if `discovered_assets.linked_device_id` is NULL, the discovered asset may own its placement row. Once it is linked to a managed device, the managed device becomes the sole authoritative placement subject for that physical box. The link operation resolves placement atomically: if only the discovered asset has placement, move it to the device; if only the device has placement, keep it; if both are identical, keep the device row and remove the duplicate discovered row; if both exist and differ, reject the link with a placement-conflict response so an operator chooses which values survive. Unlinking does not clone placement back to the discovered asset; the device retains the authoritative row until an operator explicitly creates a new discovered placement after unlink.

### 5.2 `topology_interfaces.role`

No new table is introduced for WAN classification.

V1 reserves the application value:

```text
wan
```

Write contract:

```text
PATCH interface role -> `wan` or NULL
```

The topology publication/materialization path must preserve the stored role when updating a current interface. In addition, every repository path that replaces one interface row with a known successor, including coalescing and topology generation roll, must carry a non-NULL operator role to the successor before the predecessor is deleted/retired. Discovery may create a genuinely new interface with `role = NULL`; it must not reset a role on the same row or drop one during a deterministic replacement.

V1 does not add speculative values such as `lan`, `uplink`, `trunk`, or `management`. Those can be specified separately if needed.

### 5.3 `circuits`

A circuit is durable org-owned service context and can exist while unassigned.

Conceptual schema:

```sql
CREATE TABLE circuits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL,
  provider_name        varchar(255) NOT NULL,
  cid                  varchar(255) NOT NULL,
  bandwidth_bps        bigint NULL,
  service_type         varchar(64) NULL,
  administrative_status varchar(24) NOT NULL DEFAULT 'active',
  needs_reassociation boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CHECK (length(btrim(provider_name)) BETWEEN 1 AND 255),
  CHECK (length(btrim(cid)) BETWEEN 1 AND 255),
  CHECK (bandwidth_bps IS NULL OR bandwidth_bps > 0),
  CHECK (administrative_status IN ('active','planned','suspended','disconnected'))
);
```

`administrative_status` describes the service record lifecycle. It is not the live monitor result and must not be rendered as current reachability. `needs_reassociation` records lifecycle intent only: it is set to `true` when Breeze removes a termination because a topology/site lifecycle event has no deterministic successor, and reset to `false` when a termination is successfully assigned or when an authorized user intentionally leaves the circuit unassigned. It is not a stored primary-site field.

Required indexes:

```text
index(org_id)
index(org_id, cid)
```

V1 deliberately does not require provider/CID uniqueness. Real carrier data can be inconsistent during migrations/renames, and rejecting a duplicate service record is a product policy not established by Discussion #8134.

### 5.4 `circuit_terminations`

At most one current termination per circuit.

Conceptual schema:

```sql
CREATE TABLE circuit_terminations (
  circuit_id    uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  interface_id  uuid NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

Required FKs:

```text
(circuit_id, org_id) -> circuits(id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE

(interface_id, org_id) -> topology_interfaces(id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE
```

To make the second FK enforceable without storing the primary site, implementation may add a redundant unique key/index on `topology_interfaces(id, org_id)` if one does not already exist. `topology_interfaces.id` is already globally unique; the composite key exists only to make same-org linkage a database invariant.

Deleting a topology interface without a deterministic successor deletes only the termination relationship after setting the circuit's `needs_reassociation = true`. The circuit itself remains. A manual/intentional termination removal leaves `needs_reassociation = false`.

An interface with `retired_at IS NOT NULL` is not considered a current termination even if a stale relation somehow remains during a transition. Deterministic predecessor/successor transitions transfer the termination first. If no safe successor is known, cleanup removes the stale relation and readers return `terminationState = 'needs_reassociation'` rather than silently presenting a normal unassigned circuit.

The interface must be current (`retired_at IS NULL`) and `role = 'wan'` before a termination can be created.

### 5.5 `circuit_served_sites`

Additional served sites only.

Conceptual schema:

```sql
CREATE TABLE circuit_served_sites (
  circuit_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  site_id     uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (circuit_id, site_id)
);
```

Required FKs:

```text
(circuit_id, org_id) -> circuits(id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE

(site_id, org_id) -> sites(id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE
```

This makes a cross-org served-site link unrepresentable.

The write service also rejects `site_id == derivedPrimarySiteId`. The primary site remains derived and is never copied into this table.

If a circuit's termination later moves to a site already present in `circuit_served_sites`, the read model de-duplicates that site from the “additional served sites” output and the mutation/service cleanup removes the redundant association. The derived primary site always wins.

---

## 6. Primary-site derivation and lifecycle

### 6.1 Normal case

```text
circuit
  -> circuit_terminations.interface_id
  -> topology_interfaces (current, role=wan)
  -> interface.site_id
  -> sites
```

`primarySite` is the current interface's site. No `circuits.primary_site_id` column exists.

The asset identity shown with the termination is resolved through the interface owner node and `topology_node_bindings`. The read model may surface either a managed device or discovered asset binding. If multiple inventory bindings legitimately collapse onto one topology node, the site remains unambiguous because the topology node/interface itself is site-scoped; presentation chooses the canonical linked asset according to the existing topology binding rules instead of creating another identity.

### 6.2 Asset changes site

Placement:

```text
asset site changes
placement row unchanged
placement site on read = asset's new current site
```

Circuit:

- If the same current interface row remains valid in the new topology scope, the primary site is re-derived from it.
- If the topology lifecycle has a deterministic predecessor -> successor mapping (for example coalescing or generation roll), it must transfer `role = 'wan'` and the `circuit_terminations` row to the successor before deleting/retiring the predecessor. Existing relationship/observation re-pointing is the lifecycle precedent.
- If the old interface disappears and Breeze cannot prove a unique successor, the termination relation is removed, the circuit remains durable, and readers surface `terminationState = 'needs_reassociation'`.
- The operator reattaches that circuit to a current WAN interface after topology is re-established.

V1 does **not** invent a successor by `name`, `os_index`, MAC, or `interface_key`; those values can change or collide. Carry-over is allowed only when the topology lifecycle itself already knows the old/new identity mapping.

### 6.3 Asset deletion

Placement is deleted through the subject FK cascade.

Topology lifecycle removes the interface/binding. If there is a deterministic replacement interface, role and termination are transferred first; otherwise `circuit_terminations` is deleted and the circuit survives as `needs_reassociation`.

This is deliberate because deleting/replacing a router does not prove that the carrier circuit ceased to exist.

### 6.4 Interface coalescing and generation roll

A retired interface cannot be selected for a new termination. Before a known predecessor interface is deleted or retired, coalescing/generation lifecycle code must re-point a current circuit termination and copy the operator-owned non-NULL role to the successor in the same lifecycle operation. The transfer must preserve same-org invariants and termination uniqueness.

If no deterministic successor exists, the lifecycle transaction first sets `circuits.needs_reassociation = true` and then removes the termination relation. The old interface row remains topology history, not live service authority. A successful successor transfer or later reassociation sets the flag back to `false`.

### 6.5 Site deletion

Deleting a site follows the existing site/topology cascade. Before a terminating interface is removed as part of that cascade, the lifecycle path sets the affected circuit's `needs_reassociation = true`; deletion then removes its `circuit_terminations` row. The circuit itself survives, while `circuit_served_sites` rows for the deleted site cascade independently. No stale primary site is retained because primary site is derived, not stored.

### 6.6 Circuit deletion

Deleting a circuit cascades its termination and additional served-site rows. It does not alter the topology interface, asset, monitor, alert, or ticket.

---

## 7. Authorization and tenancy

### 7.1 RLS

Each new table:

```text
ENABLE ROW LEVEL SECURITY
FORCE ROW LEVEL SECURITY
standard SELECT/INSERT/UPDATE/DELETE policies using breeze_has_org_access(org_id)
```

Shape 1 is auto-discovered by the RLS coverage contract; no dual-axis allowlist entry is appropriate.

### 7.2 Site-scoped technicians

RLS is org-level. Site visibility/write authority must therefore be enforced in the API.

Placement access:

1. load the placement subject under org RLS;
2. derive the live subject site;
3. require the existing device/network asset read or write capability on that site.

Circuit access:

- org-level circuit list/detail is visible only through sites the caller can access;
- a circuit with a current termination is visible when the caller can access its primary site;
- `needs_reassociation` circuits are discoverable to a site-restricted technician through the reassociation picker when the technician has write access to the target WAN interface/site; that picker exposes only the minimum circuit identity needed to select it (provider, CID, administrative status, termination state) and never inaccessible served-site names/counts;
- intentionally unassigned circuits are not exposed through that exception; full org-level detail for any circuit without a current termination still requires org-wide/partner authority unless the caller can authorize through an accessible served site;
- additional served-site names are included only for sites the caller can access;
- writes require access to the current primary site when assigned, plus every site being added/removed from served sites;
- assigning a termination requires write access to the terminating interface's site.

A response must not leak the name/ID of an inaccessible additional site through counts, IDs, error text, or “N hidden sites” hints.

### 7.3 Cross-org invariants

Database constraints, not only route checks, make these impossible:

- placement referring to a device in another org;
- placement referring to a discovered asset in another org;
- circuit termination referring to an interface in another org;
- served-site relation referring to a site in another org.

Integration tests must forge each class of bad write as `breeze_app`/within a valid wrong-tenant context and expect the appropriate FK/RLS rejection.

---

## 8. API contract

Final route naming should follow the existing route organization, but the contract is fixed.

### 8.1 Placement

Conceptual endpoints:

```text
GET    /assets/:assetKind/:assetId/placement
PUT    /assets/:assetKind/:assetId/placement
DELETE /assets/:assetKind/:assetId/placement
```

`assetKind` V1:

```text
device
discovered
```

PUT body:

```ts
{
  room?: string | null;       // trimmed, max 255
  rack?: string | null;       // trimmed, max 128
  rackUnit?: number | null;   // integer 1..100
  heightU?: number | null;    // integer 1..100
}
```

An all-null body removes the row instead of storing an empty placement.

Response includes the live `orgId`/`siteId` derived from the subject, but they are not writable placement fields.

### 8.2 Interface role

Conceptual endpoint on the existing topology interface resource:

```text
PATCH /topology/interfaces/:id/role
{ role: 'wan' | null }
```

Requirements:

- interface must be current, visible and in an accessible site;
- role write is an operator mutation and goes through the standard audit/mutation feedback path;
- discovery/publication must preserve the value;
- clearing `wan` is rejected while the interface has a circuit termination, unless the same mutation explicitly detaches the circuit first. No dangling circuit can remain attached to a non-WAN interface.

### 8.3 Circuits

Conceptual endpoints:

```text
GET    /circuits
POST   /circuits
GET    /circuits/:id
PATCH  /circuits/:id
DELETE /circuits/:id
PUT    /circuits/:id/termination
DELETE /circuits/:id/termination
PUT    /circuits/:id/served-sites
```

Create/update scalar fields:

```ts
{
  providerName: string;
  cid: string;
  bandwidthBps?: number | null;
  serviceType?: string | null;
  administrativeStatus?: 'active' | 'planned' | 'suspended' | 'disconnected';
}
```

Termination write:

```ts
{ interfaceId: string }
```

Server validates:

- same org;
- current interface;
- `role = 'wan'`;
- interface/site write authorization;
- interface not already terminating another circuit;
- successful assignment/reassignment clears server-managed `needs_reassociation`; intentional `DELETE /circuits/:id/termination` also clears it, while topology/site lifecycle loss sets it as defined in §6.

Served-sites write:

```ts
{ siteIds: string[] }
```

Server validates every site in the circuit org, every site is writable by the caller, and excludes the current derived primary site.

### 8.4 Circuit read DTO

```ts
{
  id,
  orgId,
  providerName,
  cid,
  bandwidthBps,
  serviceType,
  administrativeStatus,
  terminationState: 'assigned' | 'unassigned' | 'needs_reassociation', // derived from termination + needs_reassociation

  termination: null | {
    interfaceId,
    interfaceName,
    asset: { kind: 'device' | 'discovered', id, label },
    primarySite: { id, name },
    placement: { room, rack, rackUnit, heightU } | null
  },
  additionalServedSites: { id, name }[],
  createdAt,
  updatedAt
}
```

No primary-site field is persisted; this is read-model output.

---

## 9. UI contract

### 9.1 Asset detail — required V1 surface

Managed device and discovered-asset details gain one **Physical placement** card:

```text
Room
Rack
Rack unit
Height
```

For assets with topology interfaces, the network/interface section shows the operator role. A current interface can be marked/unmarked **WAN**.

A WAN interface with a circuit shows:

```text
Provider
CID
Bandwidth
Service type
Administrative status
Additional served sites
```

The primary site is not an editable circuit field. The UI labels it as derived from the termination, for example:

```text
Termination site: Main Office (from RTR-RJ-01 / WAN1)
```

An unassigned circuit shows a clear neutral state:

```text
Termination needs reassociation
```

It must not display the last site as though it were current.

### 9.2 Circuit management

V1 needs a minimal management surface reachable from the asset/interface context and one list/detail surface for finding unassigned circuits.

The list supports at least:

```text
Provider
CID
Termination state
Current primary site (derived)
Administrative status
```

A site-restricted caller never receives inaccessible site names through the list.

### 9.3 Alert/ticket context — Wave 2

Alert and ticket enrichment are explicitly deferred from Wave 1 because the current monitor binding writer does not populate a reliable interface identifier and `alerts` has no interface column. Wave 2 must first add a concrete, tested alert -> interface provenance path (for example, populating an interface identifier at topology-monitor bind/alert creation time) and only then resolve interface -> circuit.

Wave 2 invariants remain binding:

1. circuit context requires one exact current interface;
2. the interface must have exactly one current circuit termination;
3. asset-level ambiguity never guesses a circuit;
4. stale/retired/unassigned context is omitted rather than presented as current authority;
5. tickets derive circuit context from their linked alert provenance and do not snapshot provider/CID/site metadata.

### 9.4 Wording contract

Allowed:

```text
Potentially impacted sites
Sites served by this circuit
```

Not allowed from this relation alone:

```text
Impacted sites
Sites down
Outage affects all served sites
```

V1 models dependency/context, not redundancy and not full-site availability.

---

## 10. Topology interaction

V1 consumes existing topology identity and interfaces but does not change topology rendering.

Existing physical relationships remain authoritative:

```text
switch/interface -> topology_relationships -> switch/interface
```

No placement or circuit mutation creates a `topology_relationships` row.

Future topology rendering may read placement/circuit context to decorate the current graph, but that is a separate implementation/spec wave and must not be required for V1 acceptance.

---

## 11. Monitoring and ticketing behavior

Circuits do not introduce another monitor type in V1.

Operational health remains owned by existing monitors/interface measurements/alerts.

Wave 1 does not enrich monitors, alerts or tickets. Wave 2 may do so only after the system records and proves exact interface provenance under §9.3.

`administrative_status` is never substituted for monitor health:

```text
administrative_status = active
monitor = down
```

is valid and means the contracted service record is active while current monitoring reports a failure.

No provider ticket is opened. No provider notification is sent.

---

## 12. Migration and repository registrations

Implementation must use a new, sort-last migration name according to the migration naming guard at implementation time. Do not pre-select a filename in this spec because the migration ceiling can advance before implementation.

### 12.1 New tables

All four new tables must be added to:

- `CORE_ORG_CASCADE_DELETE_ORDER` in `apps/api/src/services/tenantCascade.ts`, in alphabetical/FK-safe order;
- `CORE_TENANT_EXPORT_POLICY` in `apps/api/src/services/tenantExportPolicyRegistry.ts` with every column classified;
- the organization merge registry (`apps/api/src/services/orgMergeRegistry.ts`) with merge policy **`repoint`** for these org-owned rows;
- schema exports in `apps/api/src/db/schema/index.ts`.

Shape-1 tables do not require an RLS allowlist entry, but the RLS coverage integration suite must discover them and verify their policies.

### 12.2 FK ordering

Org erasure order must respect children before parents:

```text
circuit_served_sites
circuit_terminations
circuits
```

`asset_physical_placements` must precede any parent it references if deletion is performed manually rather than relying on cascade. The tenant-cascade integration contract is the final authority for ordering.

### 12.3 Export policy buckets

All proposed V1 columns are scalar and belong in `included` unless a final column name triggers `SUSPICIOUS_NAME_PARTS`.

No new `json`/`jsonb`/`bytea` column is proposed, so there should be no new `excludedOpen` bucket caused by this feature.

The existing `topology_interfaces.role` column is already classified in the export policy. No new topology-interface export column is required.

### 12.4 Existing table change

If the circuit-termination FK needs `topology_interfaces(id, org_id)`, add only the required composite unique index/constraint. Do not add `primary_site_id` or a circuit FK to topology interfaces itself.

---

## 13. Organization merge contract

Org merge must preserve customer records and keep constraints valid while IDs are repointed.

Expected behavior:

- placement rows move with their subject assets through `org_id` repointing;
- circuits move to the survivor org;
- termination and served-site relations repoint under deferred constraints;
- site IDs continue to refer to sites after the existing site merge/repoint logic;
- no circuit receives a stored primary-site rewrite because no such column exists.

All composite FKs involving `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`.

The implementation must run the existing merge contract integration test and add feature-specific coverage if the generic registry tests do not prove these relationships.

---

## 14. Mutation/audit behavior

Placement edits, WAN role changes, circuit mutations, termination changes, and served-site changes are user-visible mutations and must use Breeze's normal authorization/audit conventions.

Web mutation handlers must use `runAction` so success and failures are surfaced consistently.

At minimum, audit metadata must identify:

```text
actor
org
subject/circuit
mutation type
before/after values where the existing audit convention supports them
```

V1 does not create a new audit subsystem.

---

## 15. Delivery waves

### Wave 1 — placement and circuits core

Wave 1 implements the durable data/lifecycle contract only:

```text
schema + tenancy registrations
placement authority + link/unlink behavior
WAN role mutation
coalesce/generation role + termination carry-over
circuit CRUD + termination + served sites
derived primary site
unassigned vs needs_reassociation
asset/interface circuit UI
site-scoped reassociation picker
```

### Wave 2 — alert/ticket operational context

Wave 2 starts only after an explicit interface provenance source is defined for topology-managed monitors/alerts. It adds the alert/ticket read-time enrichment described in §9.3 and no earlier.

---

## 16. Acceptance criteria

### Placement

- [ ] A managed device can store room, rack, rack unit and height U.
- [ ] An unlinked discovered asset can store the same placement fields.
- [ ] The API cannot create one placement row pointing to both subject types or neither.
- [ ] Linking a discovered asset to a managed device leaves exactly one authoritative placement on the device; conflicting non-identical placements reject the link until explicitly resolved; unlinking does not duplicate placement back.
- [ ] Cross-org subject references fail at the database layer.
- [ ] A same-org site move does not require rewriting the placement row.
- [ ] Deleting the asset removes its placement.
- [ ] A site-restricted user cannot read/write placement for an inaccessible subject site.

### WAN interface role

- [ ] An existing current topology interface can be marked `wan` and cleared to NULL.
- [ ] Discovery/publication does not overwrite a non-NULL operator role.
- [ ] Coalescing and generation-roll paths transfer a non-NULL operator role to the deterministic successor interface.
- [ ] No extra interface record is created.
- [ ] A retired interface cannot be selected as a circuit termination.
- [ ] WAN cannot be cleared while a current termination still references the interface unless detachment occurs in the same action.

### Circuits

- [ ] A circuit can be created with provider, CID, optional bandwidth/service type and administrative status.
- [ ] A circuit can exist without a termination.
- [ ] A circuit can terminate on exactly one current WAN interface.
- [ ] One current interface cannot terminate two circuits.
- [ ] Cross-org termination is impossible at the database layer.
- [ ] Primary site is returned from the current termination and is not stored on `circuits`.
- [ ] Deterministic interface replacement transfers the termination to the successor without losing the circuit association.
- [ ] Interface deletion/replacement without a deterministic successor sets `needs_reassociation = true`, removes only the termination, and leaves the circuit record intact.
- [ ] Manual termination removal leaves the circuit intentionally unassigned with `needs_reassociation = false`; successful reassociation resets the flag to `false`.
- [ ] Asset deletion does not delete the circuit record.
- [ ] Reassociation to a replacement WAN interface restores the derived primary site.

### Served sites

- [ ] Additional served sites must belong to the circuit org.
- [ ] Cross-org site association fails at the database layer.
- [ ] The current derived primary site cannot be added as an additional served site.
- [ ] A site becoming the new primary is de-duplicated/removed from the additional list.
- [ ] Deleting an additional site removes only that relationship, not the circuit.

### Wave 1 UI/context

- [ ] Managed/discovered asset detail shows authoritative placement.
- [ ] A WAN interface shows its circuit details.
- [ ] `needs_reassociation` is visibly distinct from an intentionally unassigned circuit.
- [ ] A site-restricted technician with target-site write access can discover a reassociation candidate without receiving inaccessible served-site details.
- [ ] Served sites are labelled **potentially impacted** and never automatically reported down.
- [ ] Topology physical links remain unchanged.

### Wave 2 operational context

- [ ] Explicit alert -> interface provenance exists before circuit enrichment is enabled.
- [ ] Alert context shows circuit data only when one exact current interface/circuit is resolved.
- [ ] Generic asset-level monitoring with multiple possible WAN circuits does not guess.
- [ ] A linked ticket shows the same current circuit context from its alert(s).

### Tenancy/lifecycle

- [ ] All new tables have ENABLE + FORCE RLS and standard org policies.
- [ ] New tables are present in tenant erasure/cascade and export registries.
- [ ] Every export column is classified.
- [ ] Org merge succeeds with the new composite FKs deferred.
- [ ] Tenant erasure deletes all feature rows without FK-order failures.
- [ ] Tenant export includes placement/circuit data and no cross-tenant rows.

---

## 17. Required implementation tests

When implementation begins, the minimum test set is:

### API/unit

- placement create/update/delete for device and discovered asset;
- placement XOR validation;
- linked discovered-asset/device placement authority on link/unlink, including conflicting-placement rejection;
- site-scoped authorization for both subject kinds;
- WAN role mutation and clearing guard;
- publication/materialization regression proving operator role survives discovery refresh;
- coalescing and generation-roll regressions proving WAN role and circuit termination transfer to a deterministic successor;
- circuit CRUD validation;
- termination requires current WAN interface;
- termination uniqueness;
- served-site same-org validation and primary-site exclusion;
- primary-site derivation;
- intentional unassigned vs `needs_reassociation` state and flag transitions;
- site-scoped reassociation picker authorization/redaction;
- `runAction` coverage for all new web mutations.

### Integration / real Postgres

- RLS positive and cross-tenant forge tests for each new table;
- cross-org placement FK rejection;
- cross-org termination FK rejection;
- cross-org served-site FK rejection;
- organization merge with placement + circuit + termination + served sites;
- tenant cascade deletion order;
- tenant export policy coverage and export/erasure roundtrip;
- topology interface deletion/retirement without a successor leaves the circuit durable as `needs_reassociation`;
- deterministic interface replacement preserves termination and WAN role;
- site deletion removes termination/served-site relations but preserves the circuit record;
- discovery publication preserves `topology_interfaces.role = 'wan'`.

### Web

- asset detail placement rendering/editing;
- WAN role action;
- circuit editor plus distinct unassigned/`needs_reassociation` states;
- served-site selector authorization filtering;
- Wave 1 served-site wording contains “Potentially impacted” and does not claim outage;
- hidden/inaccessible sites do not appear in response/UI counts or labels.

### Wave 2 tests (when that wave starts)

- monitor binding/alert creation persists explicit interface provenance;
- alert context exact-interface success;
- alert context ambiguous/no-interface omission;
- ticket with one and multiple circuit-bearing alerts;
- alert/ticket wording uses “Potentially impacted” and never infers outage from served-site association.

---

## 18. Implementation validation gates

Because the eventual implementation touches tenancy, migrations, topology and web, it must run the full applicable local gate before a PR:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
pnpm --filter=@breeze/web exec astro check
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/web
pnpm build --filter=@breeze/api
pnpm build --filter=@breeze/web
pnpm db:check-drift
pnpm --filter @breeze/api run check:migrations
```

Plus the RLS/integration suites against the test stack, including the feature-specific tests described above.

Agent tests are not required unless implementation unexpectedly touches `agent/`; that would be a scope change and should be avoided for V1.

---

## 19. Wave 1 delivery boundary

The Wave 1 implementation corresponding to this spec is complete when:

```text
existing asset
  + structured placement
  + existing interface marked WAN
  + circuit association
  + derived primary site
  + additional served sites
  + asset/interface detail context
  + lifecycle-safe reassociation
```

works under the tenancy/lifecycle contracts above.

It is **not** complete-by-expansion. The following do not belong in the same V1 implementation merely because the new data makes them possible:

```text
cables / patch panels / front-rear ports
provider API/email/ticket automation
SD-WAN/redundancy inference
new outage engine
topology map rendering
rack inventory/capacity
provider master data
manual-asset placement
```

Those require independent specs and acceptance criteria.

---

## 20. Maintainer-review traceability

Todd's four explicit design points are resolved as follows:

| Maintainer point | V1 resolution |
|---|---|
| **Tenancy:** org-owned, RLS, erasure/export, cross-org served-sites rejected | §§5, 7, 12, 13, 16–18. Shape 1, DB-enforced composite FKs, cascade/export/org-merge contracts. |
| **Primary site derived, not stored; define move/delete** | §§5.4, 6. Known topology replacements transfer role/termination; unknown replacement or site deletion removes only the termination and surfaces `needs_reassociation`; placement follows asset moves automatically. |
| **“Potentially impacted” wording only** | §§9.4, 11, 15–16. No redundancy/outage inference. |
| **Minimum V1 surface** | §9. Wave 1 is schema + placement + WAN role + circuits API/UI. Alert/ticket context is Wave 2 after explicit interface provenance; topology rendering remains deferred. |

The discussion's other core constraints are also preserved:

- no second inventory;
- no duplicate physical links;
- no manually created interface;
- discovery/topology stay authoritative for observed facts;
- operator adds only non-discoverable physical/service context;
- V2 cable plant and V3 provider automation remain separate.
