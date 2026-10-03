---
title: Topology neighbour-cache corroboration (ARP/NDP) for the grouped overview
issue: LanternOps/breeze#7816, LanternOps/breeze#7817 (follow-ups to #7762)
status: decided — advisor quorum 2026-10-02 (Fable + Codex gpt-6-astra xhigh), option B
---

# Topology neighbour-cache corroboration

## Problem

Agents already ingest a `neighbors` section (ARP/NDP cache, ≤4096 rows per context; Linux and
Windows report NUD state, macOS reports `unknown`), but no projector consumes it. Discovered-only
endpoints (phones, printers) therefore have no relationship, and #7762 can only draw them in a LAN
card as `address_match` ("membership not verified"). Separately, the grouped overview's gateway
candidate key `(family, prefix, gateway-address set)` cannot tell two LANs apart when both use the
same private gateway address (#7817).

## Decision: option B — presentation-time corroboration through one shared selector

Rejected **A** (project neighbours canonically as `network_member`): trusted identity resolution
deliberately excludes discovered-asset MACs (`physicalIdentity.ts`), so A would create a second
`mac-endpoint:` node for the same phone/printer, and DC:277 forbids automatic IP/name linking. The
blocker is MAC trust/provenance, not MAC matching as such (C:295 permits qualified controller MAC
matching). Grouping already performs inference with `authority:false`, outside impact, pathfinding
and AI evidence, so corroborating containment fits that boundary. Canonical projection stays deferred
until inventory MAC trust exists.

## Contract (binding)

**Writes:** none. No node, alias, binding, observation or relationship; the relationship
`attributes.method` enum is unchanged.

**Selector** (`apps/api/src/services/topology/neighborEvidence.ts`), one read per graph request, in
the graph read's transaction after its `FOR SHARE` on `topology_site_state`:

- Sources: `producer_kind='agent'`, protocol `neighbors` / `interfaces`, same org/site, unrevoked,
  `published_digest` present and equal to the published baseline's own digest, published baseline
  epoch equal to the source's current `producer_epoch`. The observer is the source device's live
  binding to an active endpoint node this view may expose. Pending (accepted, unpublished) content
  never counts.
- Freshness, as `observedFreshUntilSql`: the published run's `effective_at + max(3×cadence, 900 s)`,
  extended by compact confirmations only while `published_digest = content_digest` and the last
  outcome is `complete`/`partial`. Expired or unknown freshness removes the row. Interfaces baselines
  must be fresh too.
- Row qualification: state `reachable|stale|delay|probe|permanent|unknown` (`incomplete`/`failed`
  rejected; `permanent` = static entry, `unknown` incl. macOS = reachability unknown); non-null,
  valid, non-zero unicast MAC (multicast/broadcast rejected, locally administered allowed);
  family matches row and source; unspecified, loopback, multicast, limited-broadcast and — for
  IPv4 prefixes ≤ /30 — network/broadcast addresses rejected (/31 both usable, /32 only self);
  interface known, not explicitly down, not a tunnel; a preferred/deprecated interface prefix that
  contains the neighbour (zone-scoped for link-local); never the observer's own address or MAC.
  `isRouter` is a hint only.
- Bounds: ≤256 neighbour sources, ≤256 address-filtered rows per source, ≤16,384 indexed tuples,
  ≤8,192 asked-about addresses, ≤20,000 inventory pairs. Rows are filtered in SQL to the addresses
  that could matter (unplaced endpoints' inventory IPs and reported next hops). Any truncation —
  including the agent's own `omittedRowCount` — marks coverage `limited`; a missing row is never
  absence. **Limited coverage decides nothing** (review fix, 2026-10-02): no `neighbor_seen` upgrade
  and no gateway-MAC split, site-wide, because a dropped source or row could be the other candidate's
  observer or the conflicting mapping. Corroborated gateway MACs are still displayed.

**Placement policy (#7816):** an endpoint that would otherwise be unplaced keeps the unique-range
rule; inside that one range it is placed `neighbor_seen` (method `neighbor_cache`, inferred/low) in
the ONE candidate whose observer has a qualifying, fresh, non-link-local row with the endpoint's
exact (IP, MAC) pair, where both values come from the **same inventory row** (an asset, or one
`device_network` row) and that pair belongs to no other endpoint. The observer's membership must be
on the row's interface, in the same OS context and prefix. Two candidates, or any in-range cache that
maps the IP to a different MAC, stay ambiguous → `address_match`. `neighbor_seen` members count as
members, never as observers. Bounded provenance per member: observer node and label, source ID, row
key, interface name, address, MAC, state, confirmation time, expiry (no producer epoch or digest on
the wire).

**Gateway policy (#7817):** a default route is corroborated by the observer's own row for its exact
next hop, in the route's OS context, on the route's interface (which carries the zone) and family;
several MACs for one next hop count as no evidence. Within one `(prefix, gateway-address set)`
candidate, observers whose fresh caches map the same non-link-local gateway address to different MACs
become separate presentation candidates (`conflict: true`, `conflictBasis: ['gateway_mac']`).
Observers with missing or ambiguous evidence keep the base candidate: missing evidence never splits
or bridges, and equal MACs never prove a common LAN. Gateway groups list corroborated MACs with
observer counts. Nothing merges or splits canonical gateway identities.

**Read surfaces:** web only. AI/MCP graph reads pass `presentationGroups: false` and allowlist their
fields, so no presentation data — and no neighbour read — reaches them.

## Spec amendments made with this change

C:190 (aliasing needs trusted identity; cache mappings may corroborate presentation), C:211
(inferred/low annotation of containment), C:356 (confidence of presentation-only corroboration),
DC:32 (placement categories and typed provenance), grouped-overview Q4 (`neighbor_seen` as an explicit
third category).

## Known limits

- Presentation only: impact, diagnostics and AI do not see corroboration.
- Cache-only devices that match no inventory endpoint get no node and no count (the read is narrowed
  to inventory and next-hop addresses to keep it bounded).
- Proxy ARP/NDP, spoofing, static entries, DHCP reuse and overwritten inventory MACs can still
  produce a misleading match; copy never says "verified".
- Existing ingestion churn is unchanged (cache state changes already change digests); confirmation and
  expiry changes alter the graph response and its ETag.
