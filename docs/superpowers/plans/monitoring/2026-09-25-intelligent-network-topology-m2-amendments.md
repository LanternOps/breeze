---
tracking_issue: LanternOps/breeze#5995
wave: W03 (#5998)
amends: 2026-09-15-intelligent-network-topology-m2-physical.md
---

# M2 physical enrichment — implementation amendments (binding)

The M2 plan was written against assumed M1 seams. Mapping it onto the merged M0/M1 code (`880eaba02`) found that
several seams do not exist or have different contracts. Three advisor-quorum rounds resolved the design (Fable
position + Codex `gpt-6-astra` xhigh; records in the PR description). **Where this document and the M2 plan
disagree, this document wins.** Spec invariants are unchanged except the two explicit amendments marked **SPEC
AMENDMENT**.

## A. Corrections of plan names/paths to the real M0/M1 code

| Plan says | Reality |
| --- | --- |
| `packages/shared/src/fixtures/topology/*.json` | `packages/shared/src/testing/topology-adjacency-v2.json`, `topology-unifi-v1.json` (M1 cross-language vector convention) |
| `Section<T>` TS generic | private `section()` factory in `validators/topologyCollection.ts` (exported for reuse); Go `networkcontext.Section[T]` |
| `AuthenticatedTopologyProducer` without kind | also carries required `producerKind` and `sourceIdentity` |
| relationship `identityKey` | relationships use `canonicalKey` = `canonicalIdentityKey(scope, kind, sourceKey)`; `physicalLinkKey` returns a prefixed *sourceKey* `physical-link-v1:<nodeA>:<ifA>:<nodeB>:<ifB>` (sorted), never a JSON array |
| `deleteTopologyManualRelationship(ctx,id)` | `(ctx, id, {expectedRevision})` |
| `orgMergeRegistry {kind:'repoint'}` | add the table name to the `REPOINT_TABLES` string array |
| `CoverageReason` export | export `coverageReasonSchema`/type from `validators/topology.ts` |
| locale `discovery.json` | `apps/web/src/locales/*/topology.json` |
| "M1 shared API action hook" | none; call `runAction` + `handleActionError` directly (M1 pattern) |
| test IDs `topology-view-select`, `topology-relationship-row-*` | `topology-view`, `topology-edge-<id>` (new: `topology-source-port`, `topology-target-port`, `topology-directness`) |
| Go `snmppoll.FdbRow` | name taken; V2 row is `FdbV2Row` |
| `adaptLegacyAdjacency` | **dropped** — M0 capture remains the only legacy channel (see D5) |
| "existing repair scheduler" seals chunks | not needed — no chunks (D14) |

## B. Decisions

**D1 Producer authority.** Agent-token device authentication stays for every physical producer. Add server-owned
target (SNMP) and controller-site (UniFi) authority plus configuration generations inside the existing
`requireCurrentTopologyProducer`/ingest service, accepting `producerKind: 'discovery' | 'unifi'` with
`producerId = deviceId`. Quota is owned per target/controller-site source (Collection §4); the device root budget is
an additional throttle, looked up by producer (not by scope). The source-lifecycle revocation trigger is extended to
non-agent kinds on controller remap, collector change and device move; publication re-checks the fence.

**D2 Unchanged confirmations.** `ingestTopologySourceReport` accepts `unchanged`: explicitly validate
baseSnapshotId + digest + source key + epoch + configuration generation against the retained baseline, then reuse the
existing `confirm()` (exact partial-positive renewal, replay suppression, compact second-miss transitions). No
synthetic runs.

**D3 Reporter ≠ subject.** SNMP snapshots name their subject = the authorized target identity (dispatch snapshot
target, resolved to a scoped node; an IP match is corroboration only, never merge authority). UniFi resolves endpoints
per row. Unresolvable rows are retained as candidates (D15), never dropped and never attributed to the producer's node.

**D5 Legacy.** M0 capture stays the only legacy channel; no `adaptLegacyAdjacency`. Legacy collector-absence cleanup
(`reconcileTopology` age-out deletes, `discoveryWorker` ethernet/routed deletes) is tagged with a transaction-local
`breeze.topology_delete_cause = 'collector_absence'`; the capture trigger records the cause; `legacyReplay` turns a
collector-absence tombstone into support expiry (normal stale archive) while user/inventory deletions still delete.
Read-time suppression of a legacy attachment next to a measured physical relationship requires port-level
equivalence and applies to counts/frontiers.

**D6 Manual physical assertions.** Keep M0's separate manual rows and `expectedRevision`. Accept optional interface
IDs (validated for exact site and endpoint ownership). Identity material = sorted endpoint+port tuple + a generation
component (so recreate-after-delete does not collide with a retained tombstone) through `canonicalIdentityKey`.
Replace the node-pair duplicate check (it blocks parallel cables) with a same-tuple active check. Unknown-port
assertions stay distinct from measured cables. Capture/audit preserved.

**D7 Discovery dispatch authority.** Before sending a discovery command, persist on `discovery_jobs` a bounded,
secret-free dispatch authorization snapshot: scope, device id (not the transport `agentId`), included and excluded
targets, requested protocols/contexts, configuration generation, negotiated adjacency capability, deadline. Columns:
`topology_dispatch jsonb` (export `excludedOpen`), `topology_deadline_at timestamptz`, `topology_config_generation
varchar(64)` (export `included`). Admission revalidates ownership, deadline, generation and revocation. A report
after the deadline is rejected and creates no current support.

**D9/D15.4 Physical capability and flags.** Physical-view capability = `flags.materialization && flags.physical`
(deployment), independent of collector presence; collectability is shown via coverage. With physical off and
materialization on, canonical publication, support, aging, re-resolution and selection all continue; only exposure is
suppressed — across overview/physical graphs, counts, neighborhoods, relationship detail/evidence/health and
cursor/cache validation. Re-enable needs no reprojection. UniFi capability is attributed to authorized mapped sites.
`siteSettings.ts` stops hard-coding physical to false.

**D10/D13 Interface generations.** Server-owned per-interface generations in `topology_interfaces.epoch`. New columns
`phys_address varchar(32)` (export `included`) and `retired_at timestamptz` (`included`). Ingest compares a reported
if_index's (ifName, ifPhysAddress) with the current generation for owner+key: corroborated continuity → same
generation; conflicting identity → retire and allocate the next generation (links are not inherited); missing identity
evidence never establishes continuity. Shared by all collectors (keyed by owner node).

**D11 Coverage/evidence API.** Physical coverage is computed from authorized expected scopes (dispatch snapshots,
mapped controller sites), including scopes with no source row, with specific reasons (complete-empty is never
whole-site completeness). Relationship detail gains endpoint port names; the evidence endpoint returns scoped
observations/confirmations/expired-detail status/alternatives with pagination. Graph edges keep interface IDs only.

**D12 PR shape.** One PR (`Closes #5998`), one checkpoint commit per task.

**D13 FDB normalized state — SPEC AMENDMENT (evidence contract).** The normalized FDB section keeps per-MAC rows for
ports with ≤16 distinct eligible unicast MACs; a port above the threshold persists as one `shared_port` row
(PortRef, bridgeContext, size bucket `17-64|65-256|257+`). For shared/upstream ports M2 promises aggregate
excluded-port coverage only, not per-MAC membership (they are excluded from parent selection by Collection §7).
Ineligible rows are counted in section metadata. Admission budgets the ENTIRE retained source state (section,
`_knownKeys`, `_rowRelationships`, pending misses) against the 1 MiB / 512 KiB checks; over capacity → reject with
`snapshot_budget_exceeded` + coverage gap, never evict accepted support. Silent known-key truncation
(`retainTopologyKnownKeys` slice) is replaced by explicit capacity rejection.

**D14 Transport — SPEC AMENDMENT (Collection §7 chunking).** No chunks, Redis staging or seal loop. The agent posts
one report per authorized target per collection to `POST /agents/:id/topology/adjacency` (agent auth; body limit
4 MiB via a bodyLimit exception; bounded partial constructed on the agent BEFORE posting). Body: `{parentJobId,
report: full | unchanged}` for one target. Response: synchronous M1 ingest receipts per section. Retained:
command/job/device ownership, negotiated capability, exact requested protocol/context manifest, duplicate-key/count
checks, server-recomputed digests, quotas, independent section receipts. Duplicate/older sequences follow M1
(`confirm` for the same digest, `stale_sequence` otherwise; never renewal). Accepted tradeoff: an interrupted upload
salvages nothing (the whole per-target report is retried; delivery gaps show in coverage). The agent persists
per-target pending reports/receipts. The final discovery `command_result` stays bounded: hosts first, legacy
`adjacency` (derived from V2) capped separately so hosts are never lost to the 5,000,000-byte result limit.

**D15 Physical projection — keep M1 per-row lifecycle.**
1. `projectPhysicalTopology` is dispatched from `projectTopology` by section family. Every eligible positive row
   maps to exactly one relationship through M1's rowKey→relationship machinery, so partial/failed/second-miss/
   aging/revival semantics are unchanged. Resolved LLDP/CDP (both ports resolve to current interface generations, the
   remote chassis resolves uniquely in scope) → `physical_link`. Unresolved → `attachment` candidate carrying durable
   resolution material (typed chassis ID, tagged PortRefs, context) in attributes; a remote identity with no inventory
   → scoped unbound endpoint node (`lldp-chassis:<subtype>:<value>`), never merged by name/IP. FDB rows on non-shared
   ports → `attachment` candidates (inferred, directness unknown) **including** ports currently known as
   infrastructure (excluded at selection, not at retention).
2. Re-resolution pass: runs in the publisher for a site whose identity revision was explicitly dirtied (writers of
   bindings/interfaces/merges mark it; also on revival). For each unresolved candidate, recompute resolution from its
   durable attributes; when it resolves, move **active and archived** support rows (lifecycle, fresh_until, miss
   counts, epoch, digest unchanged — no renewal, no revival), atomically remap `_rowRelationships` and pending
   lifecycle IDs (including events beyond the publication barrier), merge destination support collisions, delete the
   old support keys, recompute both aggregates, archive the candidate.
3. FDB selection pass: reselect every client affected by new FDB rows, second misses, archival/revival, revocation,
   interface changes or LLDP/CDP infrastructure changes. Dedupe the same normalized port across reporters; require
   compatible bridge/FDB/VLAN contexts; exclude infrastructure ports. Single → `medium` + selected; competing → all
   `low`, alternatives recorded, none selected; clear obsolete selections. Selection is an attribute change only;
   evidence withdrawal stays exclusively M1's second-miss path.
4. Source families: fact keys dispatch by typed family; heartbeat disappearance processing filters
   `producerKind='agent'`; `publish.ts` strict validators get physical method/context variants.
5. Merges: node merge re-owns loser interfaces; coalesce generations only with corroborated continuity, otherwise
   keep distinct generations; migrate parent/observation references; use item 2's support remap; the publisher is
   taught to accept the resulting relationship rekeys; collection binding deltas are no longer dropped
   (`publish.ts:110`).

**D16 UniFi identity.** Separate scoped controller endpoint nodes (`unifi:<hostId>:<controllerSiteId>:<deviceId|mac>`).
Bind to inventory only through agent-reported NIC MACs (unique, same site); every other controller endpoint stays
unbound in M2. The topology adapter never reads `reconcileTelemetry` associations. The legacy telemetry cross-site
MAC mutation/fallback is a follow-up issue.

**D17 Exclusions.** Each view applies its active exclusions to edges, counts, frontiers and neighborhood
membership; canonical traversal, incidents and evidence are untouched. `GET /topology/sites/:siteId/exclusions?view=`
(topology read + device read + exact-site auth, bounded pagination bound to revision/view) lists hidden connections
with IDs/reasons; restore (topology write) revokes only the selected exclusion, audits, bumps graph revision and
dispatches nothing.

## C. Revised task order

1–3 as planned (contracts without chunk fields; Go LLDP/CDP; Go FDB).
4a Ingest seams: D1, D2, D13 budgeting/capacity, D15.4 source families, producer-kind isolation.
4b Discovery transport: D7 migration + dispatch snapshot, D14 route + Go per-target poster/baseline store, FDB
   normalization (D13), D5 collector-absence cause.
5  UniFi: Go resource outcomes + API adapter (D16), controller-site authority (D1).
6  Physical projector + D10 interface generations migration + D15 re-resolution/selection/merge.
7  Exclusions table + registrations (as planned).
8  Manual physical assertions (D6) + exclusion routes/listing (D17).
9  Graph read gating (D9), coverage/evidence/ports (D11), UI.
10 Vertical integration, E2E, verification record.

## D. Known limitations (as built)

Recorded at Task 6b (integration of Tasks 4b/5/6). Each is a deliberate M2 boundary, not a regression; lifting one is
follow-up work.

- **CDP device ids never resolve.** A CDP row's remote identity is a `cdp_device_id` (usually a hostname/serial
  string). Names never resolve anything (D3/D15), and LLDP chassis claims are a different namespace, so a CDP-only
  neighbour always projects onto a scoped unbound `cdp-device:<subtype>:<value>` endpoint node with an attachment
  candidate. A measured link needs LLDP from at least one end (or a MAC-typed CDP port id that resolves).
- **LLDP chassis resolution needs a MAC or an exact typed self-report.** A remote chassis resolves only by MAC (agent
  NIC MACs, current SNMP interface MACs, or a target's own `localChassis` MAC — base MACs are covered through the
  target's self-report) or by exact typed equality with a target's own non-MAC `localChassis`. A chassis two targets
  claim resolves nothing. Targets that are not polled (no dispatch authority) never contribute a claim.
- **LAG parent metadata is not collected.** Every LAG member is its own measured cable (`physical_link` per member
  port pair); there is no aggregate/parent interface, no LACP state and no member grouping in the graph.
- **FDB competition is FDB-id level only when the VLAN mapping is complete.** Candidates with a complete FDB-id→VLAN
  mapping compete per VLAN set; a `partial`/`unknown` mapping is treated as compatible with everything, so such
  candidates collapse into one competition class (more `competing`, fewer `selected`). Shared/upstream ports above the
  D13 threshold carry aggregate coverage only and never compete.
- **UniFi uplinks are attachments, never cables.** UniFi v1 device details name only the UPLINK device's port index
  (and the Integration API currently leaves it null), never the local uplink port, so a controller uplink cannot
  resolve both ends and is published as an `attachment` (`association: uplink`, uplink port as material). Wired
  clients are attachments with the reported uplink port as material; wireless is the only `direct` association;
  VPN/Teleport are remote-access associations. A client with no uplink device projects nothing (no orphan node).
- **UniFi bindings are as fresh as the last UniFi snapshot.** `inventoryDeviceId` is computed by the adapter at
  ingest from same-site agent NIC MACs; a later NIC-MAC change reaches the UniFi rows only on the next poll whose
  normalized digest changes. The legacy telemetry cross-site MAC mutation/fallback remains a follow-up (D16).
- **Unbound endpoint nodes do not age.** Scoped unbound nodes (`lldp-chassis:`, `cdp-device:`, `mac-endpoint:`,
  `physical-target:`, `unifi:`) persist after their relationships withdraw; they are hidden by relationship
  lifecycle, not removed.
