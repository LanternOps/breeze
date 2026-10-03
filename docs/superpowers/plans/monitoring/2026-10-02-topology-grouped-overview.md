---
title: Topology grouped overview — make the site map readable and useful
issue: LanternOps/breeze#5995 (feature), follow-up to the 2026-10-01 US production evaluation
status: approved — advisor quorum complete 2026-10-02 (Fable + Codex gpt-6-astra xhigh)
---

# Topology grouped overview

## Why

Production (US, v0.120.0, 2026-10-01) renders every site as a one-node-wide vertical strip of plain
white boxes. Root causes, all verified in code:

1. The site+prefix **presentation grouping** that the collection spec requires (C:184 "site+prefix
   grouping is an explicitly inferred presentation grouping; retain each observer's distinct context
   under it"; DC:41) is not implemented. Canonical network/gateway nodes are per observer by design
   (`baselineProjector.ts`), so a 20-agent LAN shows 20× `10.1.2.100`, 19× `10.1.2.0/24`, 41× `fe80::/64`.
2. Link-local, host (`/32`, `/128`) and overlay (Tailscale `100.64.0.0/10`, `fd7a:115c:a1e0::/48`)
   prefixes render as first-class networks.
3. `nodeLabelSql` falls back to `kind || ' ' || id` — 67/171 Whalers nodes read `endpoint <uuid>`; the
   live device/asset name is never consulted (legacy labels are a one-time copy).
4. `presentNode` hardcodes node `freshness:'unknown'` and empty evidence classes; no inventory facts
   (IP, MAC, OS, agent state) reach the client, so the inspector cannot answer "what is this".
5. Layout: ELK `layered` + `RIGHT` over a bipartite graph puts every endpoint in one layer; the canvas is
   a fixed 544 px; groups (`LayoutBox.groupId`) are supported by the adapter but never fed.
6. Discovered assets (phones, printers) have no relationship at all, so 79/171 nodes float.

Performance is not the problem (graph ≤ 1.7 s, layout ≤ 300 ms, no long tasks); the shape of the
response and the renderer are.

## Contract (server) — `GET /topology/sites/:siteId/graph`

All additions are **optional fields**, `schemaVersion` stays 1, canonical arrays are unchanged.
Presentation constructs keep `authority:false` and never enter pathfinding, impact, incident or AI
evidence (D:50, C:19, O:45). AI reads (`aiRead.ts`, `aiEvidence.ts`) allowlist fields and exclude
`presentation` already — unchanged.

### 1. Node inventory facts (`graphNodeSchema.inventory?`)

`inventory?: { source: 'device'|'discovered_asset', name: string|null, addresses: string[] (≤8),
mac: string|null, vendor: string|null, os: string|null, assetType: string|null,
agentState: 'online'|'offline'|'maintenance'|'updating'|'pending'|'quarantined'|'decommissioned'|null,
lastSeenAt: string|null }` — read live through `topology_node_bindings` (device → `devices` +
primary `device_network` rows; discovered asset → `discovered_assets`). Topology `read` already
requires `devices:read` (`permissionPairs.ts:19-21`), so no new disclosure. `agentState` is agent
presence, **not health** (DC:203, O:62); the UI labels it "Agent online/offline" and never colours
health from it.

### 2. Display label

`nodeLabelSql` becomes: `label_override` → live device `display_name`/`hostname` → live asset
`label`/`hostname`/`netbios_name` → `attributes.label` → primary IP → MAC → `'Unidentified device'`
(endpoint) / `kind` (other). One shared SQL fragment, reused by `impact.ts`, `relationshipDetail.ts`
and the search filter (which today duplicates the coalesce inline — fold it into the fragment).

### 3. Node freshness / evidence

Node `freshness` = `fresh` if any active support on an incident relationship is fresh
(`fresh_until > now()`, same rule as relationships), `stale` if it has observed support but none fresh,
`unknown` otherwise; `evidence.classes/methods` = union over incident active relationships (+ `legacy`).
Computed in SQL (lateral aggregate), not from the bounded visible edge set.

### 4. Presentation groups (overview + logical views)

Computed server-side in `graph.ts` after canonical rows are read (DC:172 server-issued tokens).
New presentation node roles (role is already a free string):

- `network_group` — one per **(family, prefix, gateway-candidate)** among visible canonical
  `network` nodes. Fields added to `presentationNodeSchema` (optional):
  `group?: { kind: 'network'|'gateway'|'unidentified', prefix?: string, networkClass?:
  'lan'|'link_local'|'host'|'overlay', observerCount: number, memberNodeIds: uuid[] (≤1000),
  canonicalNodeIds: uuid[] (≤1000), placement?: 'observed'|'address_containment' }`.
  - `canonicalNodeIds` = the per-observer network nodes folded into the card.
  - `memberNodeIds` = endpoints with an active `network_member` to one of them, plus discovered-only
    endpoints whose inventory address falls in **exactly one** `lan` group's prefix
    (`placement:'address_containment'`, C:210 — visual containment only, no canonical claim, C:211).
  - **Conflict split (C:185):** observers whose `default_route` gateways (same context) differ produce
    separate candidates: key = `(family, prefix, sorted gateway-address set)`. Observers with no
    reported gateway join the single candidate if exactly one exists, else form their own
    (`"no gateway reported"`). Roaming endpoints naturally form their own small group (C:186).
  - `networkClass`: `link_local` (169.254/16, fe80::/10), `host` (/32, /128), `overlay`
    (100.64.0.0/10, fd7a:115c:a1e0::/48), else `lan`. Non-`lan` groups are emitted but the client
    hides them by default behind a toggle; they never receive address-containment members.
    **Amended (#7819):** the agent-reported kind of the membership's interface wins when known
    (`topologyNetworkClass(prefix, interfaceKind)` in `@breeze/shared`, also used by the
    neighbour-cache selector): a `tunnel` interface makes any non-link-local prefix `overlay` (a VPN
    on RFC1918 included); a link-layer LAN kind (`ethernet`, `wifi`, `bridge`) disables the
    Tailscale/CGNAT range guess, so a genuine CGNAT LAN stays `lan`. The CIDR guess remains only
    for `unknown`/`virtual`/`cellular`/`other` kinds and memberships with no interface (a cellular
    uplink is a carrier WAN, so its CGNAT address keeps the guess).
- `gateway_group` — one per **(family, address)** for non-link-local gateways reported by observers
  inside the same network-group candidate; label `"Reported gateway 10.1.2.100"`,
  `observerCount`, `canonicalNodeIds` = per-observer gateway nodes. Link-local gateways
  (`fe80::…%zone`) are never grouped across observers (C:200, D:82). Never chooses a gateway by
  majority (D:80) — every reported address is its own group.
- `unidentified_group` — `"Network not identified"` (D:76 owns copy) holding endpoints with no
  membership and no containment placement.
- Aggregate edges (`meaning:'aggregate'`, `contributingRelationshipIds` = real ids, ≤2000):
  `network_group → gateway_group` (contributing = the members' `default_route` rels to the folded
  gateway nodes); secondary membership `network_group(v6) ↔ network_group(v4)` when they share members.
  `network_member` edges are implied by containment and are not re-emitted.

Ids: `presentation:<view>:<scopeHash>:<role-short>-<sha256(key)[0..40]>` (fits the 64-char segment
rule; deterministic per graph revision). Group cards cannot be pinned (DC:205) — their position is
derived from members. Physical view is unchanged (no grouping).

Limits: groups are computed over the projected (bounded, `limit ≤ 1000`) node set; omitted members are
already surfaced by `frontier`. Group `memberCount` counts only visible members; `observerCount`
counts folded canonical nodes.

## Renderer (web)

- **Compound graph:** each `network_group` (lan, or any class when the toggle is on) is a Cytoscape
  parent; its `memberNodeIds` get `parent`; its `canonicalNodeIds` and their `network_member` edges are
  not drawn (they are the card). `gateway_group` is drawn as one router tile; its folded gateway nodes
  and the members' individual `default_route` edges are replaced by the aggregate edge.
  An endpoint in several lan groups gets one parent (IPv4 first, then larger group); the others show
  in the inspector and as one aggregate edge.
- **Layout:** top level ELK `layered`, direction `DOWN` (Internet → gateways → network cards →
  ungrouped), `hierarchyHandling: SEPARATE_CHILDREN`, each group laid out with `rectpacking`
  (a grid of tiles, aspect ≈ canvas) inside 48 px padding (D:191). Pins are honoured for user
  (`source != 'legacy'`) positions of nodes outside groups. **Legacy-imported positions
  (`source:'legacy'`) are not applied** in the grouped overview — they were coordinates for the old
  flat map, and applying them is what produces "Saved devices overlap". (Quorum question Q3.)
- **Tiles (D:152):** role/asset-type icon (reuse `assetTypeIcon` mapping as data-URI SVG — CSP allows
  `img-src data:`), name, primary IP as second line, agent-presence pip with text alternative,
  health shown only as border/badge when measured (red/amber = health only, D:153; unknown is grey,
  never green, M1:879). Theme tokens (`--success`, `--warning-strong`, `--destructive`), not hex.
- **Zoom (D:152):** wide zoom → group cards with prefix, device count, issue count, "reported by N";
  medium → names; focus → addresses. `min-zoomed-font-size` + label switching on zoom.
- **Canvas:** fills the content area (`calc(100vh - top)`, min 560 px), inline style (Tailwind height
  classes were purged before, #1728); fit on first layout only; never refit on health refresh (D:193).
- **Inspector:** leads with identity (name, type, addresses, MAC/vendor, OS, agent state + last seen,
  network group, reported gateway), then health, then evidence/freshness in a collapsed "Evidence"
  section. Port measurement (SNMP) only for infrastructure roles (switch/router/AP/firewall) or assets
  of those types. Group cards: prefix, how grouped ("Inferred from N devices' interfaces"), members,
  reported gateways, conflict note when split.
- **Legend + toggle:** "Show link-local, VPN and single-host networks".
- **List view:** gains Address and Group columns; sorted by group then name.

## Explicitly out of scope

- Projecting ARP/NDP `neighbors` into relationships (spec gives neighbours only gateway-alias
  enrichment, C:190; would need the `attributes.method` enum + a spec decision). Follow-up issue.
  Decided 2026-10-02 (#7816/#7817): presentation-only corroboration, no canonical projection — see
  `2026-10-02-topology-neighbour-corroboration.md`.
- Physical view, switch inference (never invent switches, C:14).
- Changing canonical identity (per-observer nodes stay; grouping is presentation only).

## Quorum resolution (binding — supersedes conflicting text above)

Fable and Codex (xhigh, read-only, 2026-10-02) agreed on the direction; Codex's corrections were adopted:

- **Q1 — agreed.** Server-side, inside the existing `presentation` block, optional fields, `schemaVersion` 1.
  Web and API ship in the same image, so strict readers update together; external MCP/AI reads go through
  allowlists that never forward `presentation` or `inventory`.
- **Q2 — revised.** Groups are computed from the **complete site** (dedicated reads of all active network
  nodes, `network_member` and `default_route` rows under the view's exposure), never from the bounded
  page. A membership's gateway candidates are only the observer's default routes **on the same interface**
  (fresh routes preferred; stale ones listed, not used to split). Candidate key for `lan` prefixes is
  `(family, prefix, gateway-address set)`; observers with no reported gateway join the single candidate
  when exactly one exists. Known limitation, stated in the group's provenance text: a roaming device
  reporting the same private prefix *and* gateway address joins the office group; corroboration by
  gateway MAC (neighbour cache, C:190) is the follow-up.
- **Q3 — revised.** Pins are honoured, including `source:'legacy'` (they mix snapshot pins with later
  explicit edits). A pinned group member keeps its coordinates; its group becomes a fixed obstacle sized
  to contain it. When pins distort the grouped map the explorer offers **"Use grouped layout"**: editors
  get a draft with every position cleared, saved through the normal shared-layout save; nothing moves
  until they save.
- **Q4 — deliberate spec extension, labelled.** Discovered-only endpoints whose inventory address falls in
  exactly one `lan` candidate across the complete site are drawn inside it with per-member placement
  `address_match` and copy "Address in this range — membership not verified". No canonical relationship
  is created; these members are excluded from counts of observed members. **Amended 2026-10-02 (#7816):** an
  explicit third category, `neighbor_seen` (inferred/low), keeps the unique-range rule but places the endpoint in
  the ONE candidate whose observer's fresh, published neighbour cache holds the endpoint's exact (IP, MAC) pair
  from a single inventory row; conflicts stay `address_match`. Also excluded from observer counts. See
  `2026-10-02-topology-neighbour-corroboration.md`.
- **Q5 — agreed.** `inventory` (with presence) rides on graph nodes; presence uses neutral icons and
  explicit text ("Agent offline", last seen), never health colours; refreshing it never re-runs layout.
- **Layout — revised.** Two-stage, in the existing worker and within its 3 s budget: (1) pack each
  group's members into a grid; (2) ELK `layered` over a flat graph of group boxes, gateway groups,
  Internet and ungrouped nodes, with layout-only edges oriented gateway → network so the gateway ranks
  above its LAN; (3) translate members by their group's origin. Collision handling and the overflow grid
  move whole groups. Layout persistence stays canonical-only.
- **Consumers.** `nodeLabelSql` stays a self-contained fragment (scalar subqueries) so `impact.ts` and
  `relationshipDetail.ts` need no join changes. Folded gateways keep their operational value: the group
  inspector lists each reporter's canonical gateway, selectable for Diagnose. Search matches IP/MAC
  independently of the display label.
- **Group expansion (#7818, done):** a card's `frontierToken` carries a signed `group` claim
  (`{kind, key: sha256(grouping key)}`) in place of the old first-canonical-node focus. The expansion
  re-resolves the card's complete `members ∪ canonicalNodeIds` from the complete site under the pinned
  graph revision, pages over exactly that set with the usual limit/after/edge/boundary continuations
  (each carrying the same claim), and answers `409 presentation_group_changed` when the grouping no
  longer yields that key. Aggregate edges expand the card they used to stand in for (`routes_via` → its
  network card, `shared_devices` → the secondary card). Folded gateways stay on their gateway card.
- **Deferred (follow-up issues):** neighbour-cache gateway MAC corroboration (done in #7817), interface-kind
  tunnel classification (CIDR heuristics for Tailscale/CGNAT meanwhile; done in #7819), VPN half-default handling in the
  projector ("Selected path unknown").

## Quorum questions (original)

- Q1. Server-side grouping in the existing `presentation` block with optional schema fields vs a new
  top-level `groups` block / schemaVersion 2.
- Q2. Network-group candidate key `(family, prefix, gateway-address set)` — correct reading of C:185,
  or over-splitting (e.g. one observer with a stale second default route splits the LAN)?
- Q3. Ignore `source:'legacy'` pinned positions in the grouped overview vs honour them (D:192 "do not
  silently move pins").
- Q4. Address-containment placement of discovered-only assets into an *inferred* site+prefix group —
  C:210 says "unique configured/profile group"; is an inferred lan group acceptable when it is
  presentation-only and labelled `address_containment`?
- Q5. `inventory.agentState` on the graph node vs a separate endpoint — and whether a presence pip on
  the tile violates DC:203/O:62.

## Tests

- Shared: schema accepts/rejects new optional fields; id regex.
- API unit (`graph.test.ts` ordered mocks — add a grouping-pure function `buildPresentationGroups`
  with its own table-driven tests so `graph.test.ts` only gains one fixture): one LAN 20 observers →
  1 network_group + 1 gateway_group; conflict split; link-local/host/overlay classes; v4+v6 shared
  members; containment uniqueness; unidentified group; id format/length; aggregate edge
  contributing ids real and ≤2000.
- API: label fallback chain (`nodeLabelSql` compiled + integration on real DB), node freshness.
- Integration: `topologyBaselineAcceptance` stays green (presentation ids `presentation:`, authority
  false, zero physical links) + a new 3-observer same-LAN fixture asserting one group.
- Web: canvas element builder pure function tests (parents, hidden folded nodes, aggregate edges,
  toggle); layout adapter compound/rectpacking determinism + no overlap; inspector identity fields.
- Browser gates (`topology-worker`, `topology-baseline`, `topology-performance` V200/V500/V1000)
  stay green; re-measure on a Whalers-shaped fixture.
