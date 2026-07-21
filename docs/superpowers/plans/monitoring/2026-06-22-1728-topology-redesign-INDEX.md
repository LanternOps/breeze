# #1728 Network Topology Redesign — Plan Index

Umbrella index for the four phase plans implementing the design spec
`docs/superpowers/specs/monitoring/2026-06-22-network-topology-redesign-design.md`.

**Execute strictly in order.** Each phase is independently mergeable, but later
phases depend on earlier ones at the type/schema level.

| Phase | Plan file | Tasks | Deliverable |
|---|---|---|---|
| 1 | `2026-06-22-1728-topology-phase1-measured-backbone.md` | 12 | Agent LLDP/CDP walk → `adjacency` payload; `network_topology` provenance columns + `reconcileTopology`; infra edges drawn in the existing D3 view |
| 2 | `2026-06-22-1728-topology-phase2-host-attachment.md` | 11 | Agent bridge-FDB walk; `reconcileTopology` uplink detection + host→access-port attachment (`method=fdb`) |
| 3 | `2026-06-22-1728-topology-phase3-cytoscape-view.md` | 10 | `topology_layout` table; Cytoscape rewrite with saved `preset` positions; `PATCH /topology/layout`; **introduces `topology:write` permission** |
| 4 | `2026-06-22-1728-topology-phase4-manual-mapping.md` | 14 | `topology_manual_nodes`; manual node/edge routes; Cytoscape edit mode |

## Locked cross-phase contracts (authoritative)

These were fixed before the plans were written; every plan uses them verbatim.

- **Adjacency payload** (Go emits, API consumes): `DeviceAdjacency { sourceDeviceIp; sourceChassisId?; lldp: LldpNeighbor[]; cdp: CdpNeighbor[]; fdb: FdbEntry[] }`, emitted as result field `adjacency: DeviceAdjacency[]` (always a slice, never nil). Row types `LldpNeighbor`/`CdpNeighbor`/`FdbEntry` per the spec §6/§7. Phase 1 fills `lldp`/`cdp`; Phase 2 fills `fdb`.
- **Writer:** `reconcileTopology(orgId, siteId, hosts: DiscoveredHostResult[], adjacency: DeviceAdjacency[]): Promise<void>` (new file `apps/api/src/jobs/reconcileTopology.ts`, replaces the delete-only `enrichTopology`). Runs under the worker's system DB context.
- **`network_topology` provenance:** `method ('lldp'|'cdp'|'fdb'|'manual')`, `confidence ('high'|'medium'|'asserted')`, `created_by`, `first_seen_at`; `source_type`/`target_type` gain `'manual_node'`. Unique index `ux_network_topology_provenance(org_id, site_id, source_type, source_id, target_type, target_id, method)`. **`interface_name` already exists** on the table (`varchar(100)`) — do not re-add it. Reconcile age-out `DELETE` must be scoped `method IN ('lldp','cdp','fdb')` so manual edges are never touched.
- **`topology:write` permission** is introduced **once, in Phase 3**. Phase 4's "permission registry" task is verify-only when Phase 3 has landed (see its Task 1 cross-phase note) — never ship two migrations inserting the same `('topology','write')` row.

## Migration ordering (important)

The plans hardcode placeholder dates (`2026-06-29-*`, `2026-06-30-*`). The dev DB
already has migrations through `2026-06-28-pam-signer-groups.sql`. At implementation
time, **rename each new migration to the real current date** so it sorts
lexicographically last, mind the same-day `-a-`/`-b-` infix rule when two land the
same day, and **re-run `apps/api/src/db/autoMigrate.test.ts`** to catch ordering bugs.
New tables (`topology_layout`, `topology_manual_nodes`) are `org_id`-direct (RLS
shape 1, auto-discovered) — RLS policies go in the creating migration; add each to
`ORG_CASCADE_DELETE_ORDER` in the correct localeCompare slot. No `rls-coverage`
allowlist edits are needed.

## Pre-existing issue noted during planning (out of scope, verify)

Phase 3 flagged that the current `GET /discovery/topology` handler reads on a bare
`db` rather than the request context. The new `PATCH /topology/layout` and the
Phase 4 manual routes correctly use the request `db` (org/site server-derived). If
the bare-read ever returns 0 rows under `breeze_app` RLS, that's the known
silent-0-row-read class — worth a separate fix, not part of these phases.
