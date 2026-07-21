# Network Discovery Topology Redesign — Design Spec

**Issue:** #1728 — "Network Discovery topology view needs redesign — connections/nodes don't render meaningfully"
**Date:** 2026-06-22
**Related:** #1325 (removed fabricated subnet/gateway-star topology)
**Status:** Design — approved in brainstorm, pending implementation plan

## 1. Summary

The Network Discovery topology view renders discovered assets as subnet-grouped dots with **zero edges**, because the platform collects no real inter-host adjacency and the frontend (correctly, per #1325) refuses to fabricate links. This is not a rendering bug — it is a missing data pipeline plus a layout that conveys no structure.

This redesign delivers a **full vertical slice scoped to Layer-2 adjacency first**: the Go agent collects real L2 evidence (LLDP/CDP + bridge forwarding tables) from SNMP-credentialed devices during a discovery scan; the API reconciles that evidence into the existing `network_topology` table with provenance and confidence; and the web view becomes a **switch-anchored, saved-layout diagram** that the user can also hand-edit — adding placeholder nodes for unmanaged gear and drawing manual connections. Measured and manual edges coexist on one canvas, visually distinguished, and a rescan never erases hand-drawn wiring.

## 2. Goals / Non-goals

**Goals**
- Draw edges that reflect **real discovered relationships** (LLDP/CDP infra links, bridge-FDB host→port links) with no fabricated/guessed connections; edges carry provenance + confidence.
- Actually **populate `network_topology`** via a writer driven by collected evidence.
- A **switch-anchored hierarchical layout** that reads meaningfully and degrades honestly when no adjacency is measured.
- **Persistent, hand-arrangeable diagram**: every node draggable, positions saved; the map stays exactly as the user arranges it.
- **Manual mapping** for unmanaged-switch sites: user-created placeholder nodes + user-drawn edges, immune to scan cleanup.
- Usable/readable at hundreds-to-thousands of nodes via grouping, collapse, and zoom.

**Non-goals (this spec)**
- L3 topology (gateway/next-hop, `ipRouteTable`/`ipNetToMediaTable`) — deferred to a follow-on spec.
- Passive LLDP listening from endpoints — we use SNMP-to-switch only (L3 reachable; agent need not be on the switch's segment).
- Traffic-flow / NetFlow visualization.
- Auto-promotion of manual edges to measured when later corroborated (manual and measured simply coexist).

## 3. Background — current state (verified)

- **View:** `apps/web/src/components/discovery/NetworkTopologyMap.tsx` — hand-rolled **D3 v7** SVG; force-sim ≤150 nodes, static grid above; subnet-clustered, not connectivity-driven. Hosted in `DiscoveryPage.tsx`; subnet grouping in `topologySubnets.ts`.
- **Read API:** `GET /discovery/topology` (`apps/api/src/routes/discovery.ts`) returns `discovered_assets` as nodes, profile CIDRs as subnets, and edges from `network_topology` — which is **empty in practice**.
- **Edge table exists, no writer:** `network_topology` (`apps/api/src/db/schema/discovery.ts`) is only ever SELECTed and DELETEd. `enrichTopology()` (`apps/api/src/jobs/discoveryWorker.ts`) calls `cleanupSpeculativeTopologyLinks()` — it deletes speculative edges and writes none (`_hosts` arg intentionally unused).
- **Agent collects no adjacency:** `agent/internal/discovery/scanner.go` `DiscoveredHost` is per-host only. SNMP discovery fetches sysDescr/sysObjectID/sysName — no LLDP, no FDB.
- **Reusable infra:** `agent/internal/snmppoll/` has v2c/v3 client + an OID template registry that **already includes `dot1dTpFdbTable` (1.3.6.1.2.1.17.4.3)**; LLDP OIDs (`1.0.8802.1.1.2`) are **absent**. SNMP creds are stored encrypted per discovery profile (`discovery_profiles.snmp_communities` / `.snmp_credentials`, decrypted via `apps/api/src/services/snmpSecrets.ts`). Discovery scans are scheduled by a 60s BullMQ `schedule-profiles` job and run by the first online agent in the site (overridable via `agentId`).

## 4. Approach

**Approach A — switch-anchored L2 map** (chosen over LLDP-backbone-only and over riding the SNMP-monitoring poller). Extend the discovery scan to collect LLDP/CDP + bridge-FDB, write provenance-tagged edges, and rebuild the view on Cytoscape.js with a saved-position canvas + manual editing.

**Rendering tech: Cytoscape.js.** The hard parts here — hierarchical/compound layout (fcose/dagre), native node collapse/expand for subnet/VLAN/switch groups, and a canvas renderer that survives thousands of nodes — are exactly what Cytoscape provides and what makes this "a redesign, not a bug." We use its **`preset` layout (saved x/y) with per-node locking**, not auto-layout-every-render. Cost: ~one new dependency and a rewrite of `NetworkTopologyMap.tsx`, offset by deleting bespoke D3 layout code.

## 5. Architecture / data flow

```
① Agent (Go discovery scan)
   For each SNMP-credentialed device: walk LLDP (lldpRemTable), CDP, bridge-FDB (dot1dTpFdbTable).
   Emit adjacency in the existing scan result payload (no new transport).
        ↓
② API · discoveryWorker.processResults → reconcileTopology()
   Match FDB MACs → discovered_assets. LLDP/CDP → infra↔infra edges + flag uplink ports.
   Attach hosts to ACCESS ports only. Upsert edges w/ method·confidence·vlan·interface·lastVerifiedAt.
   Age out stale MEASURED edges. Never touch manual.   [withSystemDbAccessContext — worker path]
        ↓
③ Postgres (RLS, org/site scoped)
   network_topology (edges + provenance) · topology_manual_nodes (placeholders) · topology_layout (saved x/y + pinned)
        ↓
④ API read · GET /discovery/topology
   Returns nodes (assets + manual), edges (measured + manual w/ provenance), saved layout — one payload.
        ↓
⑤ Web · Cytoscape canvas
   preset layout from saved positions; Auto-arrange seeds only never-placed nodes; edit mode.

Manual edit path (originates in ⑤, writes ③, request context):
   POST /discovery/topology/manual-node · POST /discovery/topology/manual-edge · PATCH /discovery/topology/layout
   requirePermission(topology:write) · withDbAccessContext (org/site server-derived)
```

## 6. Data model

All three tables are `org_id`-direct (**RLS shape 1**: `ENABLE` + `FORCE` + policies created in the same migration). Each is added to `ORG_CASCADE_DELETE_ORDER` (localeCompare-sorted) and the partner-purge path per the dual-cascade contract.

### 6.1 `network_topology` (extend existing)
Existing: `id, org_id, site_id, source_type, source_id, target_type, target_id, connection_type, vlan, bandwidth, latency, last_verified_at`. Add:

| column | purpose |
|---|---|
| `method` | `lldp \| cdp \| fdb \| manual` — the linchpin; scan cleanup only touches the measured set |
| `confidence` | `high` (LLDP/CDP) · `medium` (FDB) · `asserted` (manual) — drives edge styling |
| `interface_name` | switch port the edge lands on (FDB/LLDP); nullable |
| `created_by` | user id for manual edges; null for measured |
| `first_seen_at` | retained across rescans; `last_verified_at` bumped on each re-observation |

- `source_type` / `target_type` gain a `manual_node` value so an edge may reference a placeholder.
- **Unique index** `(org_id, site_id, source_type, source_id, target_type, target_id, method)` → idempotent upsert on rescan; lets a measured and a manual edge coexist on the same node pair.
- Confirm/extend RLS policies; manual inserts run on the request `db` (org/site server-derived); reconcile runs under `withSystemDbAccessContext`.

### 6.2 `topology_manual_nodes` (new)
`id, org_id, site_id, label, role (switch|router|ap|firewall|patch_panel|other), notes (nullable), created_by, created_at, updated_at`.

### 6.3 `topology_layout` (new)
`org_id, site_id, node_type (discovered_asset|manual_node), node_id, x (double), y (double), pinned (bool), updated_by, updated_at`; unique `(site_id, node_type, node_id)`. Positions live here (not on `discovered_assets`) to keep the discovery inventory clean and let discovered nodes be pinned without schema churn.

## 7. Collection — Go agent

- Add LLDP OIDs (`lldpRemTable`, `1.0.8802.1.1.2.x` — chassis id, port id, system name) and CDP to the `snmppoll` template registry; reuse the existing `dot1dTpFdbTable` entry. Implement SNMP **table walks** (current client only does Get/GetMulti).
- During a scan, for each device that has SNMP creds and responds, collect: LLDP/CDP neighbor rows (local port ↔ remote chassis/port/system) and FDB rows (MAC ↔ bridge port, with VLAN where available). Resolve bridge-port → ifName via `dot1dBasePortIfIndex` + `ifName`.
- Extend the discovery result payload with an `adjacency` block (per source device: lldp[], cdp[], fdb[]). No new WebSocket message type.
- **Table-driven Go tests** for LLDP/FDB/CDP row parsing and port→ifName mapping; golden fixtures from real switch walks.

## 8. Reconciliation — API writer

`reconcileTopology(orgId, siteId, hosts, adjacency)` replaces the delete-only `enrichTopology`:

1. **Infra edges:** LLDP/CDP neighbor rows → edges between the two infra devices (matched to `discovered_assets` by chassis-id MAC / mgmt IP / system name). `method=lldp|cdp`, `confidence=high`, `connection_type=infra`. Record local `interface_name`.
2. **Uplink detection:** any bridge port that appears as an LLDP/CDP neighbor to another infra device is an **uplink** — excluded from host attachment.
3. **Host attachment:** FDB rows on non-uplink (access) ports → edge from the switch to the host matched by MAC against `discovered_assets`. `method=fdb`, `confidence=medium`, `interface_name=port`, `vlan`. Skip MACs not in inventory and ports with many MACs above a sanity threshold (likely undetected uplink) — log the skip count.
4. **Upsert + age:** upsert on the unique index, bump `last_verified_at`; measured edges not re-observed for *N* consecutive scans (config, default 3) are deleted. **Manual edges (`method=manual`) are never read, modified, or deleted by reconcile.**
5. Runs under `withSystemDbAccessContext` (worker path); resilient to partial/empty adjacency (a device that fails SNMP still contributes per-host data).

## 9. Read API

`GET /discovery/topology` returns one payload: `nodes` (discovered assets + manual nodes, each with role/status/label), `edges` (measured + manual, each with `method`, `confidence`, `interfaceName`, `vlan`), `subnets` (profile CIDRs), and `layout` (saved positions). Existing org/site scoping preserved.

Manual write routes (new), all `requirePermission(topology:write)`, request `db` context, site/org server-derived:
- `POST /discovery/topology/manual-node` — create placeholder (validates site membership).
- `DELETE /discovery/topology/manual-node/:id` — cascade its manual edges + layout row.
- `POST /discovery/topology/manual-edge` — endpoints must be assets-in-site or manual-nodes-in-site.
- `DELETE /discovery/topology/manual-edge/:id`.
- `PATCH /discovery/topology/layout` — batch upsert positions (drag-to-save), `pinned=true`.

All mutations go through `runAction` on the web side per the no-silent-mutations contract.

## 10. Web — visualization & editing

- Rewrite `NetworkTopologyMap.tsx` on **Cytoscape.js**: compound nodes for subnet/VLAN/switch groups (collapsible), canvas renderer, `preset` layout from `layout`. Infra nodes styled as hubs; hosts grouped under their switch/port.
- **Edge styling by provenance:** LLDP/CDP solid blue (high), FDB solid green (medium), manual dashed orange (asserted). Selecting an edge shows method/confidence/port/VLAN, or "manual".
- **Saved-layout behavior:** dragging any node persists `(x,y,pinned=true)` immediately. New discovered nodes appearing later are auto-seeded near their switch/subnet **without disturbing pinned nodes**. "Auto-arrange" reseeds only unplaced nodes (or, with confirm, reflows all).
- **Edit mode** (gated by `topology:write`, hidden otherwise): mode toggle; add-node palette; drag-to-connect (manual edge); drag-to-move (save); select-edge → delete. There is no "edit a measured edge" — measured edges are owned by the scan; users delete-override or draw manual edges alongside.
- **Honest degraded state retained:** when no measured edges exist, keep the explanatory note but present a useful subnet/VLAN-grouped layout with role badges (and the user can still hand-map).

## 11. Cross-cutting

**Security / tenancy.** New tables: RLS enable+force+policies in the creating migration; verify by forging a cross-tenant insert as `breeze_app`. Add to `ORG_CASCADE_DELETE_ORDER` (correct localeCompare slot) + partner-purge; add asset/manual-node delete cleanup for dependent edges + layout rows. Manual writes never use a bare pool (avoid the silent 0-row-write class) — request context with server-derived org/site. New `topology:write` permission added to the RBAC matrix and enforced at the route (constant-compare/route-level, with an integration test that an org user without it gets 403).

**Error handling.** SNMP failures (timeout, bad creds, unsupported MIB) degrade per-device: no adjacency from that device, scan still succeeds, per-host data still upserts. Reconcile tolerates empty/partial adjacency. Manual-edge endpoints validate endpoint existence + site scoping and return typed failures surfaced via `runAction`. Cytoscape import guarded so a malformed layout row can't crash the canvas.

**Performance / scale.** Canvas renderer + collapsed groups by default; expand-on-demand. Read payload bounded by site; consider edge/node counts in the response and lazy-expand large groups. Target hundreds-to-thousands of nodes per site readable; document any rendered-node cap with a visible "N more — expand" affordance rather than silent truncation.

**Testing.**
- Go: table-driven LLDP/CDP/FDB parsing + port mapping (golden fixtures).
- API unit: `reconcileTopology` — uplink exclusion, host attachment, confidence assignment, age-out, **manual-edge preservation across rescan**.
- API integration (real DB, `*.integration.test.ts`): RLS forge on all three tables; cross-partner read/write denial; cascade coverage; `topology:write` RBAC 403.
- Web: Cytoscape component (provenance styling, saved-position load, edit-mode add/connect/move/delete), `runAction` feedback. Stub ResizeObserver per the jsdom convention.

## 12. Phasing (recommended)

A clean staging that ships value early; each phase is independently mergeable:

1. **Phase 1 — Measured backbone.** Agent LLDP/CDP walk + reconcile infra edges; extend `network_topology`; keep the current D3 view but draw the new infra edges. (Equivalent to the "LLDP-backbone-only" milestone; strict subset of A.)
2. **Phase 2 — Host attachment.** FDB collection + access-port attachment + uplink exclusion + age-out.
3. **Phase 3 — Cytoscape view + saved layout.** Rewrite the component; `topology_layout`; preset positions + Auto-arrange.
4. **Phase 4 — Manual mapping.** `topology_manual_nodes`, manual edges, edit mode, `topology:write` RBAC.

## 13. Open questions / decisions taken

- **Confidence = enum** (`high/medium/asserted`), not a numeric score — accepted (no calibrated model to justify numbers; maps to three styles).
- Age-out threshold *N* scans — default 3, make it a profile/config value.
- CDP collection is included with LLDP; if it adds material agent complexity, Phase 1 may ship LLDP-only and add CDP in Phase 2.

## 14. Out of scope (future specs)

L3 next-hop/gateway topology; NetFlow/traffic overlays; manual→measured promotion; cross-site topology stitching.
