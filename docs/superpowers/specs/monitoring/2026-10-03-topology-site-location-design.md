# Topology: "belongs to" vs "is at" (site assignment vs observed network location)

Date: 2026-10-03
Status: Proposed. Advisor quorum complete (Fable + Codex gpt-6-astra xhigh); ownership anchor resolved by tie-break.
Feature: LanternOps/breeze#5995 follow-up. Tracking issue: LanternOps/breeze#7884.
Plan: [`plans/monitoring/2026-10-03-topology-site-location.md`](../../plans/monitoring/2026-10-03-topology-site-location.md)
Companions: [collection](2026-09-15-intelligent-network-topology-collection.md) (C), [data/API contracts](2026-09-15-intelligent-network-topology-data-contracts.md) (DC), [grouped overview](../../plans/monitoring/2026-10-02-topology-grouped-overview.md) (GO), [neighbour corroboration](../../plans/monitoring/2026-10-02-topology-neighbour-corroboration.md) (NC).

## 1. Problem

On a production customer org, site Main Office (10.1.2.0/24 via 10.1.2.100) shows a second network card,
"10.1.5.0/24 via 10.1.5.1", holding DESKTOP-0NPDOPV and WIN-92H1M08M1HB. Both agents have only ever
reported 10.1.5.0/24 via 10.1.5.1, which is the Lakeside site's network. Breeze has them assigned to the
wrong site. Separately, laptops legitimately move between sites, homes and hotels.

The grouped overview (GO) draws every device assigned to a site in a card for the network it reports.
It has no concept of "this network belongs to another site", so a misassigned desktop and a travelling
laptop both look like a second LAN at the home site.

## 2. Binding owner decisions

1. **No automatic site reassignment, ever.** There is no auto-move setting. The site of record drives
   configuration policies, patch and maintenance windows, alert routing, reports and billing.
2. **The site of record stays administrative.** The map shows observed reality separately:
   "belongs to" (assignment) is never inferred from "is at" (observation).
3. **Moves are suggestions only.** A suggested move is a one-click, permission-gated, audited use of
   the existing device site-move action.

Principle, adopted into C §5 and GO Q2 (section 13): *Administrative assignment remains authoritative.
Observed presence is a separately authorized inference. Unmatched evidence is not absence. Presence
history and dismissals may persist without canonical graph writes; AI/MCP evidence remains unchanged.*

## 3. Decision log

| # | Decision | Basis |
|---|---|---|
| D1 | Five presentation states: home, visiting, unrecognized, ambiguous, stale/unknown. No "away" state. | Codex correction to Fable's visiting/away proposal: no match does not prove off-site. |
| D2 | Ownership anchor = admin-declared per-site subnet intent (`discovery_profiles.subnets`, `network_baselines.subnet`), corroborated by the declaring site's own observers. | **Fable + Codex quorum; anchor resolved by tie-break.** Codex said no site-network registry exists and proposed new administrator-confirmed fingerprints. Fable showed that the two tables already hold admin-declared, per-site subnet intent. The tie-break adopts them (section 6), with the refinements in 6.4. |
| D3 | Observation source = published `network_member` + `default_route` relationships plus published neighbour baselines. `devices.last_seen_ip` is context only. | Codex point 2, adopted. |
| D4 | Bounded per-org fingerprint and presence read model, refreshed by a worker. No per-request cross-site graph reads. | Codex point 4, adopted. |
| D5 | Site visibility is enforced in the app layer. Naming B requires access to B. Showing an A-owned visitor on B requires access to both. Hidden matches leak nothing. | Codex point 4, adopted. RLS is org-level (DC:130). |
| D6 | Dismissal = one nullable `devices.site_assignment_confirmed_at`, cleared centrally by a trigger on any site or org change. | Codex point 5, adopted. |
| D7 | Persistence for suggestions = prospective daily presence summaries. No retroactive evaluation from the 30-day collection history. | Codex point 5, adopted. |
| D8 | Move hardening: an expected-source-site guard on every site change, plus an audit row with the old site, the new site and, for suggested moves, server-derived evidence. | Codex point 6, adopted. |
| D9 | Presence is served by a separate endpoint, `GET /topology/sites/:siteId/presence`. It is not added to the graph response. | Fable. It keeps the graph ETag, the AI allowlists and `schemaVersion` untouched, and gives presence its own authorization. |
| D10 | v1 location inference is IPv4 only. | Fable. `network_baselines.subnet` validation accepts IPv4 only, and IPv6 default routes are link-local (`fe80::1` is shared by every LAN). Revisit with NC MAC corroboration later. |
| D11 | Waves: W1 separates assignment from observation and hardens the move (no migration). W2 adds anchors, fingerprints, presence and visitors. W3 adds daily summaries, suggestions and dismissal. | Codex wave split, adopted. |

## 4. Presentation states

States are computed for every device of the org that has a topology endpoint binding. They describe the
device's current, fresh observations relative to its **assigned** site A. Section 6 defines the inputs
(attachments, declarations, fingerprints).

### 4.1 Per-attachment classification

An attachment is `a = (P, g, mac?)`: an IPv4 `lan` prefix P, the gateway address g reported on the same
interface and context, and the gateway MAC corroborated from the device's own neighbour cache (NC
gateway policy) when one exists. `Decl(P)` is the set of sites of the org that declare P exactly (6.2).
Evaluate in this order:

1. `Decl(P)` is empty → **unrecognized** (`not_declared`).
2. `A ∈ Decl(P)`, g is in A's own gateway set `G(A,P)`, and there is no MAC conflict with A → **home**.
   A MAC conflict means mac is known, A's corroborated set `C(A,P,g)` is non-empty, and mac is not in it.
3. `|Decl(P)| ≥ 2` → **ambiguous** (`multiply_declared`).
4. `Decl(P) = {A}` and step 2 failed → **unrecognized** (`own_gateway_mismatch` or `own_gateway_mac_conflict`).
5. `Decl(P) = {B}`, B ≠ A:
   - The org fingerprint coverage is `limited` → **unknown** (`coverage_limited`).
   - `G(B,P)` (B-assigned observers only) is empty → **unrecognized** (`declared_unconfirmed`, site B).
   - g ∉ `G(B,P)` → **unrecognized** (`gateway_mismatch`, site B).
   - P is a consumer default (6.5): mac known and mac ∈ `C(B,P,g)` → **visiting B**. Otherwise
     **unrecognized** (`consumer_uncorroborated`, site B).
   - P is not a consumer default: mac known, `C(B,P,g)` non-empty and mac ∉ `C(B,P,g)` → **unrecognized**
     (`gateway_mac_conflict`, site B). Otherwise → **visiting B**.

### 4.2 Device state

Only fresh attachments count (6.1). Overrides come first: if the presence row is missing, expired,
unreconciled (version or assignment mismatch, 7.3), or the org coverage is limited and no attachment
is home, the device is **stale/unknown**.

| Condition (first match wins) | State |
|---|---|
| No fresh attachment | stale/unknown (`no_fresh_observation`) |
| Any attachment is home | **home**. Home wins over everything, including multi-homed servers and full-tunnel VPNs whose tunnel is excluded anyway. |
| Visiting attachments name exactly one site B, and no attachment is ambiguous | **visiting B**. Unrecognized side attachments are allowed. |
| Visiting attachments name two or more sites, or any attachment is ambiguous | **ambiguous** |
| Otherwise | **unrecognized** |

### 4.3 Rendering and copy

"Away" never appears in UI copy. An unmatched device is "Other / unidentified networks". Copy lives in
`apps/web/src/locales/*/topology.json`, with English as the source. `<A>` and `<B>` are site names and are
rendered only under the visibility rules in section 8.

| State | Home site A's map | Matched site B's map |
|---|---|---|
| home | Tile in its network card, no badge. | — |
| visiting B (viewer sees A and B) | Not drawn in any A network card. Listed in the roster under **"Observed at other sites"**: "On <B>'s network (10.1.5.0/24) · since 09:12". Site header: "N observed at other sites". | Tile drawn in B's card for (P, g) with a neutral **"Visiting"** badge and subtitle "Assigned to <A>". Inspector: "Assigned to <A>. Reports <B>'s network 10.1.5.0/24 via 10.1.5.1. The gateway matches <B>'s devices" (plus ", including its router MAC" when MAC-corroborated). Card header: "+N visiting". Visitors never count as card members or observers. |
| visiting B (viewer lacks B) | Rendered exactly like unrecognized, with no reason text. | — |
| visiting B (viewer lacks A) | — | Not rendered, not counted. |
| unrecognized | Roster under **"Other / unidentified networks"**: "10.1.5.0/24 via 10.1.5.1 — not identified as any site's network". Reason hints appear only when the named site is visible: `declared_unconfirmed`: "Declared for <B>, but no <B> device confirms this gateway yet." `consumer_uncorroborated`: "Common home-router range. The router could not be matched to <B>'s." `gateway_mismatch`: "In <B>'s declared range, but through a different gateway." `own_gateway_mismatch`: "In <A>'s declared range, but through a different gateway (10.1.2.254)." | — |
| ambiguous | Viewer sees every declaring site: "Declared for <A> and <B>. Breeze can't tell which site this is." Otherwise rendered as unrecognized. | — |
| stale/unknown | Roster under **"Location unknown"**: "Last reported 10.1.5.0/24 via 10.1.5.1, 3 days ago". When the cause is unreconciled or limited coverage: "Location not current". | — |

The assigned-device roster is a collapsible panel under the explorer toolbar, collapsed by default and
showing a count chip. It holds every non-home device assigned to the viewed site, so a device that leaves
A's cards is never lost from A's view (Codex point 1). Selecting a roster entry opens the inspector.

## 5. Data sources

| Source | Use | Not used for |
|---|---|---|
| Published `topology_relationships` of kind `network_member` (endpoint → network) and `default_route` (endpoint → gateway), same observer, OS context (`logical_context.contextKey`) and source interface (`baselineProjector.ts`, read the same way as `readPresentationGroupInput`) | Attachments: prefix from the network node's `attributes.prefix`, next hop from the gateway node label, interface kind from `topology_interfaces.kind` | — |
| Published neighbour baselines through `readNeighborEvidence` / `buildNeighborEvidenceIndex` (`neighborEvidence.ts`, NC selector rules) | Gateway MAC for an attachment; corroborated MAC sets for fingerprints | Placement when coverage is `limited` |
| `discovery_profiles.subnets` (enabled profiles only) and `network_baselines.subnet` | Declarations (6.2) | Containment matching. A scan range is not a broadcast domain (C:210). |
| `devices.site_id` (live) | Assignment | — |
| `devices.last_seen_ip` | Inspector context only ("Last connected from <ip>"). It is the server-observed public source address with no observation timestamp of its own (`agentAuth.ts`). | Any matching rule |
| `device_network` | Inventory addresses (existing GO use) | Route evidence. Its `public_ip` is never written. |

Freshness uses the existing `observedFreshUntilSql` rule: a published run's `effective_at + max(3×cadence, 900 s)`,
extended by compact confirmations only while the published digest equals the content digest. Active
relationships with expired support are not fresh (Codex point 2: "fresh supporting evidence, not merely
active relationships").

Interfaces of kind `tunnel` and prefixes whose `topologyNetworkClass(prefix, interfaceKind)` is not
`lan` (link-local, host, overlay) never form attachments.

## 6. Ownership anchor (tie-break)

### 6.1 Attachment (observed side)

For device D bound to endpoint E in its assigned site's graph, an attachment exists for each fresh
`network_member` E→N where:

- N's prefix is IPv4, class `lan`, and not on a tunnel interface;
- its gateway set is the addresses of D's `default_route` relationships on the same interface and
  context (fresh ones; stale routes are listed in evidence but never decide);
- the gateway MAC is D's own qualifying neighbour row for that exact next hop, interface and context.
  It exists only when the site's neighbour coverage is `complete` and exactly one MAC is mapped.

If a membership has more than one gateway address, each address forms its own attachment.

### 6.2 Declaration (anchor side)

`normalizeDeclaredPrefix(text)` accepts an IPv4 CIDR with length 8–30 and normalizes host bits to zero
(`10.1.5.1/24` → `10.1.5.0/24`). It rejects ranges, bare addresses, `/31`, `/32`, IPv6 and anything
unparsable. Rejections are counted and surfaced to admins as "N entries ignored".

`Decl(P)` is the set of sites S in the org with an enabled discovery profile whose `subnets` contains P,
or a network baseline whose `subnet` is P, after normalization. **Matching is exact prefix equality.**
A declared `/16` never claims an observed `/24`, and a declared `/25` never matches an observed `/24`.

### 6.3 Fingerprint (corroboration by the declaring site's own observers)

For each (S, P) with S ∈ `Decl(P)`, the fingerprint holds:

- **`G(S,P)`**: gateway addresses reported on P by devices **assigned to S**, whose attachments to P were
  confirmed within the anchor horizon (7 days), with the reporting device IDs. The horizon keeps an
  office's fingerprint stable overnight while its desktops are off. Visitor evidence must still be fresh.
- **`C(S,P,g)`**: gateway MACs for (P, g) that at least **two distinct** S-assigned observers corroborate
  under the NC gateway policy, excluding the device being classified. This needs complete neighbour
  coverage for S. Limited coverage leaves C undefined, and undefined C fails every consumer-prefix match.
- `status`: `anchored` (one declaring site and `G` non-empty), `unconfirmed` (one declaring site and `G`
  empty), or `ambiguous` (`|Decl(P)| ≥ 2`).

Inference from S-assigned agents alone is never an anchor. A prefix that no admin declared has no
fingerprint, however many S devices report it.

### 6.4 Evaluation of the rule against the repo, and refinements

The tie-break rule is "P belongs to B when declared, by a discovery profile or network baseline, for
exactly one site of the org; a match also requires gateway agreement and, for consumer defaults, a
gateway MAC corroborated by B's own observers; inference from B-assigned agents alone is never an anchor;
multiply declared → ambiguous." Checked against the repo:

| Finding | Evidence | Resolution in this spec |
|---|---|---|
| The anchor data exists and is per-site and admin-written. | `discovery_profiles` (`org_id`, `site_id` NOT NULL, `subnets text[]`); `network_baselines` (`org_id`, `site_id` NOT NULL, `subnet varchar(50)`, unique `(org_id, site_id, subnet)`), both org RLS (`schema/discovery.ts`). | Adopted as the anchor. |
| **Neither table declares a gateway.** "Gateway agreement" has nothing to agree with except the declaring site's own observers. | No gateway column on either table. | `G(B,P)` comes from B-assigned observers (6.3). This is corroboration of a declared anchor, not inference of an anchor. |
| **Bootstrap gap.** If every device on B's network is assigned elsewhere, `G(B,P)` is empty and nothing can ever match. The motivating case resolves only if Lakeside has at least one correctly assigned agent reporting 10.1.5.1. | Follows from the row above. | State `unrecognized / declared_unconfirmed`, with the hint "Declared for <B>, but no <B> device confirms this gateway yet" for viewers of B. No visitor and no suggestion. An optional admin-declared gateway would close the gap but needs new surface. It is left as **open question Q1**. |
| `discovery_profiles.subnets` is untyped and unvalidated (only `min(1)`). It can hold ranges, hosts or supernets. | `routes/discovery.ts` validation. | Strict normalization with exact equality (6.2). Ignored entries are counted. |
| A scan range is not proof of a broadcast domain (C:210). Admins scan supernets. | C:210. | Exact equality only. A supernet declares nothing smaller. |
| Nothing prevents two sites from declaring the same prefix. Consumer-router small offices (192.168.1.0/24) make this common. | No cross-site uniqueness; the unique index includes `site_id`. | Ambiguous for **visiting** attribution, as the rule says. **Refinement:** a device assigned to one of the declaring sites may still be **home** when the gateway agrees and there is no MAC conflict (4.1 step 2). Home is the benign default and matches today's grouping. Without this refinement, every device of a small office that shares a consumer prefix with a sister site would become "ambiguous" on its own map. |
| Disabled profiles still carry subnets. | `discovery_profiles.enabled`. | Only enabled profiles declare. Baselines have no enabled flag and always declare. |
| **Circularity in home MAC corroboration.** The device being classified is itself one of A's observers. | — | `C` excludes the subject device and needs two other corroborating observers. As a consequence, a one- or two-agent site on a consumer prefix never detects a MAC conflict at home. It defaults to home, which is the stated GO Q2 limitation. |
| **Pollution of B's MAC set by B's own travelling laptops.** A B laptop at an employee's home on 192.168.1.0/24 reports that home router's MAC. | — | The two-observer threshold drops single-observer MACs. HA pairs with two physical MACs are kept, because each MAC is counted independently. |
| Gateway agreement on non-consumer prefixes can still pass with a different router (DHCP reuse, copied configs). | NC "equal MACs never prove a common LAN". | **Refinement:** a corroborated MAC that contradicts B's corroborated set vetoes the match (`gateway_mac_conflict`). Missing MAC evidence never vetoes a non-consumer match. |
| IPv6 gateways are link-local (`fe80::1` everywhere), and baselines only validate IPv4. | `networkBaselines.ts:37`. | v1 is IPv4 only (D10). |
| Editing a discovery profile now changes presence. | — | Profile and baseline forms state: "Subnets here also identify this site's networks on the topology map." Changes mark presence dirty (7.4). |

### 6.5 Consumer default prefixes

`TOPOLOGY_CONSUMER_DEFAULT_PREFIXES` lives in `@breeze/shared` (`validators/topology.ts`) as a reviewed
constant. Changing it requires a reviewed PR. A prefix is a consumer default when it overlaps any entry:

`192.168.0.0/24, 192.168.1.0/24, 192.168.2.0/24, 192.168.3.0/24, 192.168.4.0/24, 192.168.8.0/24,
`<lab-lan-subnet>`, 192.168.11.0/24, 192.168.31.0/24, 192.168.50.0/24, 192.168.68.0/22, 192.168.86.0/24,
192.168.88.0/24, 192.168.100.0/24, 192.168.178.0/24, 192.168.254.0/24, 10.0.0.0/24, 10.0.1.0/24,
10.1.10.0/24, 172.16.0.0/24`

## 7. Read model

### 7.1 Tables (W2, plus W3 additions)

All tables use the direct `org_id` tenancy shape (shape 1): `ENABLE` + `FORCE ROW LEVEL SECURITY` and the
four standard `breeze_has_org_access(org_id)` policies. They are derived runtime read models, not
configuration, so Partner-Wide First does not apply: there is no partner owner and no `partner_id`. Every
composite FK that references `org_id` is `DEFERRABLE INITIALLY IMMEDIATE`.

**`topology_org_presence_state`** (one row per org; PK `org_id`, FK → `organizations` ON DELETE CASCADE)

| Column | Type | Meaning |
|---|---|---|
| `fingerprint_version` | bigint NOT NULL default 0 | Bumped by each successful evaluation, in the same transaction as the rows it stamps |
| `coverage` | varchar(16) CHECK in (`complete`, `limited`, `not_configured`) | `not_configured` means no valid declarations in the org |
| `coverage_reason` | varchar(64) NULL | `fingerprint_cap`, `device_cap`, `neighbor_limited` |
| `dirty_at` | timestamptz NULL | Set by invalidation triggers; cleared by the evaluation that consumed it |
| `evaluated_at`, `next_evaluation_at` | timestamptz | Cadence (7.4) |
| `input_digest` | varchar(64) NULL | sha256 of declarations plus fingerprint inputs (diagnostics) |
| `created_at`, `updated_at` | timestamptz | |

**`topology_site_fingerprints`** (≤ 1,024 rows per org; overflow sets coverage `limited`)

`id` uuid PK; `org_id`; `site_id` (FK `(site_id, org_id)` → `sites(id, org_id)` ON DELETE CASCADE
DEFERRABLE INITIALLY IMMEDIATE); `family` (`ipv4`); `prefix` cidr; `gateway_address` inet NULL (NULL only
for `unconfirmed` or `ambiguous` rows); `status`; `consumer_default` boolean; `declared_by` text[]
(`discovery_profile`, `network_baseline`); `declaration_ids` uuid[] (≤ 32); `observer_device_ids` uuid[]
(≤ 64); `gateway_macs` jsonb (≤ 16 × `{mac, observerDeviceIds[≤64], lastConfirmedAt}`); `neighbor_coverage`
(`complete`, `limited`); `fingerprint_version`; `evaluated_at`; `expires_at`; `created_at`; `updated_at`.
Unique: `(org_id, site_id, prefix, coalesce(gateway_address, '0.0.0.0'))`.

**`topology_device_presence`** (one row per device with an endpoint binding)

`device_id` PK (FK `(device_id, org_id)` → `devices(id, org_id)` ON DELETE CASCADE DEFERRABLE INITIALLY
IMMEDIATE); `org_id`; `assigned_site_id` uuid NOT NULL (the assignment evaluated against: a
reconciliation guard, never rewritten, 7.3); `state` (`home`, `visiting`, `unrecognized`, `ambiguous`,
`stale`, `unknown`); `reason` varchar(48) NULL; `matched_site_id` uuid NULL (FK `(matched_site_id, org_id)`
→ `sites` ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE); `declaring_site_ids` uuid[] (≤ 8, for
ambiguous and hint visibility); `prefix` cidr NULL; `gateway_address` inet NULL; `gateway_mac` macaddr NULL;
`mac_corroborated` boolean; `evidence` jsonb (≤ 8 attachments × `{relationshipIds, observerNodeId,
interfaceName, confirmedAt, freshUntil, classification, reason, siteId}`); `observed_at`; `fresh_until`;
`fingerprint_version`; `evaluated_at`; `created_at`; `updated_at`.
Indexes: `(org_id, matched_site_id) WHERE state = 'visiting'`; `(org_id, assigned_site_id)`.
**W3 adds** `suggested_site_id` uuid NULL (FK as above), `suggestion_first_at`, `suggestion_last_at`
timestamptz NULL, and `suggestion_days` smallint NULL.

**`topology_device_presence_days`** (W3; ≤ 8 rows per device per day; retention 35 days)

`id` uuid PK; `org_id`; `device_id` (FK as above, ON DELETE CASCADE); `day` date (UTC);
`assigned_site_id` uuid NOT NULL (historical assignment, never rewritten); `state`; `matched_site_id` NULL;
`match_key` varchar(80) (`<state>:<matched_site_id|->`); `first_observed_at`, `last_observed_at`
timestamptz; `observation_count` integer; `created_at`; `updated_at`.
Unique `(device_id, day, assigned_site_id, match_key)`. Index `(org_id, device_id, day)`.

**`devices.site_assignment_confirmed_at`** (W3) timestamptz NULL.

### 7.2 Evaluator

`services/topology/presenceEvaluator.ts`, driven by `jobs/topologyPresenceWorker.ts` (interval tick, same
shape as `topologyTelemetryMaintenance.ts`). Each org evaluation runs as **one system transaction**
(`runOutsideDbContext(() => withSystemDbAccessContext(...))`) under
`pg_try_advisory_xact_lock(hashtext('topology_presence:' || org_id))`, so replicas never double-evaluate.
The steps:

1. Read declarations (6.2). If there are none, delete the org's fingerprints and presence rows and set
   coverage `not_configured`.
2. For each declaring site, read its anchor evidence (6.3) with the existing site-scoped readers
   (`readPresentationGroupInput`-style statement and `readNeighborEvidence` with a horizon option).
   Declaring sites are processed in id order, ≤ 256 per org (over → `limited`).
3. Upsert fingerprints (≤ 1,024) and delete rows no longer derived.
4. Read attachments for all bound devices (≤ 20,000 per org; over → `limited`, `device_cap`) in batches
   of 1,000. Classify (4.1, 4.2) with the pure function `classifyDevicePresence`.
5. Upsert presence rows stamped with the new `fingerprint_version`, the evaluated `assigned_site_id`, and
   `fresh_until = min(earliest supporting fresh_until, now + 75 min)`.
6. W3 only: upsert presence-day rows and compute suggestions (section 10).
7. Bump `fingerprint_version`, clear `dirty_at` if it is ≤ the evaluation's start time, and set
   `next_evaluation_at = now + 60 min`.

### 7.3 Reader validity (rejecting unreconciled rows)

A presence row is used only if all of these hold. Otherwise the device presents as stale/unknown
("Location not current"):

- `row.fingerprint_version = state.fingerprint_version`. This also covers rows repointed by an org merge.
- `row.fresh_until > now()`.
- `row.assigned_site_id = devices.site_id` (live join).
- `state.coverage = 'complete'`, for `visiting` rows.

### 7.4 Invalidation

Mark dirty means upsert `topology_org_presence_state.dirty_at = now()`. It is done by
`SECURITY DEFINER` trigger functions with a fixed `search_path`, so no write path can forget it.

| Event | Mechanism |
|---|---|
| Discovery profile insert, delete, or update of `subnets`, `enabled` or `site_id` | AFTER trigger on `discovery_profiles` |
| Network baseline insert, delete, or update of `subnet` or `site_id` | AFTER trigger on `network_baselines` |
| Device `site_id` or `org_id` change | AFTER UPDATE OF trigger on `devices`: delete that device's presence row and mark both orgs dirty. W3 adds the BEFORE trigger that clears `site_assignment_confirmed_at`. |
| Topology publication (`topology_site_state.graph_revision` advances) | AFTER UPDATE OF `graph_revision` trigger |
| Site delete, device delete | FK cascade removes rows. The profile and baseline cascades fire their triggers. |
| Org merge | Rows repoint and their version no longer matches (7.3). The devices `org_id` trigger marks the survivor dirty. |
| Freshness confirmations, source revocation, evidence expiry | No structural event. Covered by the hourly re-evaluation and `fresh_until` (≤ 75 min). |

Worker cadence: a tick every 60 s handles ≤ 20 orgs, ordered by `dirty_at` then `next_evaluation_at`.
An org is due when `dirty_at IS NOT NULL` (debounced 30 s) or `next_evaluation_at ≤ now()`. Orgs with
`not_configured` are re-checked only when dirty.

## 8. Visibility contract

RLS isolates orgs, not sites (DC:130: "Site authorization is application-layer only"). All presence
reads run in the request's org RLS context and then apply this app-layer site gate.
`canSeeSite(ctx, S)` is true iff all of these hold:

- `canAccessSite(current, S)`: live permissions, re-read as in `graphAuthority`;
- `canAccessSite(ctx.permissions, S)`;
- `siteAccessCheck(ctx.auth.allowedSiteIds)(S)`: the token ceiling.

Partner and system scopes are unrestricted by site.

| Rule | Contract |
|---|---|
| R1 Entry | `GET /topology/sites/:siteId/presence` uses `requireTopologySiteCapability('read')` (`topology:read` + `devices:read`) on the viewed site. |
| R2 Naming B | A site name or ID other than the viewed site appears only when `canSeeSite(B)`. This covers visitor origin, a home device's matched site, reason hints and ambiguous declarers. |
| R3 Visitor on B | An A-owned device appears on B's response only when `canSeeSite(A)` (and B, which R1 implies). The device ID, hostname and node label come from A's inventory, which the viewer may see. |
| R4 Hidden matches | A hidden visiting match is serialized byte-for-byte as an unrecognized entry with `reason: null`. A hidden visitor is omitted, with no count, no "+N", no frontier and no truncation hint. An ambiguous result is shown as ambiguous only when every declaring site is visible. Otherwise it is unrecognized with `reason: null`. **A reason is serialized only when it names a site the viewer can see** (`own_gateway_*` names A; `declared_unconfirmed`, `gateway_mismatch`, `consumer_uncorroborated` and `gateway_mac_conflict` name B). `not_declared` is never serialized, so a hidden match and a genuinely undeclared network produce the same JSON. Internal reasons stay in the presence row for diagnostics. |
| R5 Actions | "Move to <B>" requires `devices:write` plus both sites, which is the existing PATCH check. Dismissal requires `devices:write` on the device's site. Suggestions are only emitted under R2 and R3. |
| R6 No canonical leakage | Visitor DTOs carry `deviceId` and presentation IDs only. They never carry A's canonical node, relationship or interface IDs, frontier tokens or diagnostic capability on B's response (Codex point 4). |
| R7 Cache | The response ETag uses `topologyReadEtag(authority.digest, body)`. The authority digest already includes allowed sites and grants (`graphCursor.ts`). |

## 9. API and DTO

`presenceResponseSchema` in `@breeze/shared` (`validators/topologyPresence.ts`), strict, `authority:false`:

```ts
{
  schemaVersion: 1, siteId, asOf, authority: false,
  coverage: 'complete' | 'limited' | 'not_configured',
  declaredNetworks: { prefix, sources: ('discovery_profile'|'network_baseline')[], status: 'anchored'|'unconfirmed'|'ambiguous', gatewayAddresses: string[] }[],      // this site only, ≤ 256
  assigned: { deviceId, label, state, reason: string|null, matchedSite: {id,name}|null, declaringSites: {id,name}[]|null,
              network: { prefix, gatewayAddress }|null, macCorroborated: boolean, observedAt: string|null, freshUntil: string|null,
              suggestion: SuggestionDto|null }[],                                                             // non-home devices assigned here, ≤ 1000
  visitors: { id /* presentation:overview:<scopeHash>:visitor-<sha> */, deviceId, label, assignedSite: {id,name},
              network: { prefix, gatewayAddress }, macCorroborated: boolean, observedAt, freshUntil, suggestion: SuggestionDto|null }[], // ≤ 500
  counts: { observedElsewhere, unidentified, unknown, visiting },   // visible entries only
  truncated: { assigned: boolean, visitors: boolean },
}
SuggestionDto = { siteId, siteName, days, firstObservedAt, lastObservedAt }   // W3
```

The web client places a visitor in B's network card whose `group.prefix` equals `network.prefix` and whose
`gatewayAddresses` contain `network.gatewayAddress`, preferring a declared card. If no card matches, the
visitor goes into a presentation-only "Visiting devices" card labelled with the prefix. Visitor tiles
cannot be pinned, diagnosed or expanded.

W1 adds to the graph (no new endpoint): `group.declaration?: { state: 'declared'|'undeclared', sources }`
on `lan` network cards, and empty declared cards (C §6: "a configured but empty network gets its network
tile") with copy "Declared for <site> — no device reports this network".

## 10. Suggestions and persistence (W3)

### 10.1 Daily presence summaries

The rollup is prospective: no backfill, and evidence starts on the deploy day. During each evaluation,
the evaluator upserts a `topology_device_presence_days` row for every evaluated device under
`(day, assigned_site_id, match_key)`. It extends `last_observed_at` and increments `observation_count`,
and writes at most once per 60 minutes per row. Writes include `stale` and `unknown` rows, which is how
explained and unexplained gaps are told apart. A gap with **no row at all** means the evaluator did not
cover the device. Rows older than 35 days are deleted by the worker (≤ 10,000 per tick). Worst case is
24 writes per device per day: 240,000 per day at 10,000 devices.

### 10.2 Eligibility for "likely assigned to the wrong site"

Let A be the current assignment and B a candidate. Only rows with `assigned_site_id = A` count. All of
these must hold:

1. `devices.site_assignment_confirmed_at IS NULL`.
2. The current presence row is valid (7.3), with state `visiting` and `matched_site_id = B`.
3. Within the last 30 days, B-visiting rows exist on **≥ 7 distinct UTC days**, and the span from the
   first B row's `first_observed_at` to the last B row's `last_observed_at` is ≥ 7 × 24 h.
4. From the first B observation to now there are **no `home` rows, no `visiting` rows for another site,
   and no `ambiguous` rows** (no competing attachment).
5. **No unexplained gap > 36 h** in that interval. Take the union of every row's
   `[first_observed_at, last_observed_at + 60 min]`, counting `stale` rows and not counting `unknown`
   rows. That union must have no hole longer than 36 h. A powered-off weekend produces `stale` rows,
   which explain the gap. An evaluator outage or limited coverage does not.
6. B's fingerprint for the attachment is still `anchored`, with no other declarer.

The evaluator stores the result on the presence row (`suggested_site_id`, `suggestion_first_at`,
`suggestion_last_at`, `suggestion_days`). Readers emit it only under R2, R3 and R5.

### 10.3 Copy

- Roster entry on A and visitor tile on B: **"Probably assigned to the wrong site."** "Reported <B>'s
  network (10.1.5.0/24) on 9 days between 14 Sep and 2 Oct. No <A>-network observations during that time."
  It never says "always", "never at <A>" or "away".
- Actions: **"Move to <B>"**, with `devices:write` and both sites visible, and **"Keep at <A>"** (dismiss).
- Site header on B: "2 devices assigned to other sites have reported this network for 7+ days · Review".
- After dismissal: "Site assignment confirmed on 2 Oct · Suggestions off · Turn on".
- The move confirmation dialog states: "Moving changes which site's configuration policies, maintenance
  windows, alert routing and reports apply to <device>. Breeze will not move it back automatically."

## 11. Dismissal

`devices.site_assignment_confirmed_at timestamptz NULL` (W3).

- `PUT /devices/:id/site-assignment-confirmation` sets it to `now()`, and `DELETE` sets it to NULL ("Turn on").
  Both require `devices:write`, `requireMfa()`, and the device's site via `getDeviceWithOrgAndSiteCheck`.
  The actor is recorded only in the audit log (`device.site_assignment_confirmed` /
  `device.site_assignment_unconfirmed`, with `details.siteId`), not in a column. Confirming does not alter
  presence.
- **Cleared centrally** by a `BEFORE UPDATE OF site_id, org_id ON devices` trigger
  (`breeze_devices_site_assignment_confirmation_reset`) whenever either value changes. That covers PATCH,
  move-org, org merge and any future bulk path. It does not expire otherwise; whether it should is open
  question Q2.
- Suppression: while set, no suggestion is computed for the device. Presence states are still shown.

## 12. Move hardening (W1)

The move action stays the existing `PATCH /devices/:id` with `siteId` (`devices:write` + `requireMfa()`
+ source and destination site checks). Changes:

1. **Concurrency guard, always on.** When `siteChanged`, the UPDATE gets `AND site_id = <siteId read at
   the access check>`. Zero rows → `409 { error: 'device_site_changed' }`, with `currentSiteId` included
   only when the caller can access that site. This closes the check-then-write window for every caller,
   including API clients that send no new field.
2. **`expectedSiteId?: uuid`** in `updateDeviceSchema`. If present and not equal to the device's current
   site, the route returns 409 before any write. The web `ChangeSiteModal`, the settings modal and the
   topology suggestion always send it.
3. **`siteMoveTrigger?: 'manual' | 'topology_suggestion'`** (default `manual`). Client-supplied evidence
   is never accepted. For `topology_suggestion`, the server reads the device's presence row after the
   access checks and records its suggestion fields as evidence. If the device is no longer eligible, the
   move still proceeds, because it is the user's explicit choice, and the audit says
   `suggestionState: 'not_eligible'`.
4. **Audit.** In addition to the existing `device.update`, a `device.site_move` row is written via
   `writeRouteAudit` (the post-commit retry queue, same as `moveOrg.ts`):
   `details: { fromSiteId, fromSiteName, toSiteId, toSiteName, expectedSiteId, trigger, suggestionState?,
   evidence?: { matchedSiteId, prefix, gatewayAddress, macCorroborated, days, firstObservedAt,
   lastObservedAt, fingerprintVersion } }`. An in-transaction audit insert is rejected for the reasons in
   `auditService.ts` (RLS scope, and an abort risk to the caller's work).
5. The web confirmation shows the policy-implication copy (10.3) beside the destination picker.

## 13. Spec amendments (applied in W1, Task 1)

**C §5, after C:186** (append):

> Administrative assignment remains authoritative. Observed presence is a separately authorized inference
> over published `network_member`/`default_route` evidence and neighbour corroboration, matched only
> against prefixes an administrator declared for exactly one site (discovery profile or network
> baseline) and corroborated by that site's own observers; unmatched evidence is not absence. Presence,
> visitor rendering, presence history and assignment dismissals are presentation/read-model state with
> no canonical graph writes; AI/MCP evidence is unchanged (amended 2026-10-03,
> `specs/monitoring/2026-10-03-topology-site-location-design.md`).

**GO "Quorum resolution", Q2** (append):

> **Amended 2026-10-03 (site location):** a `lan` card carries `declaration` (declared/undeclared for
> the viewed site by exact prefix). When the site declares at least one network, undeclared cards move off the
> canvas into the "Other / unidentified networks" roster (toggle "Show other networks on the map");
> with no declarations the canvas is unchanged and shows a declare-networks hint. From W2, devices whose
> presence is `visiting` another site leave the home site's cards and render on the matched site's card
> as presentation-only visitors (`site-location` spec §4, §8).

## 14. AI / MCP

Unchanged. `aiRead.ts` and `aiEvidence.ts` keep `presentationGroups: false` and their field allowlists.
No AI tool, MCP tool or AI evidence path calls the presence endpoint or reads the presence tables. A unit
test pins that no file under `services/topology/ai*` imports the presence modules, and that AI graph
reads still serialize neither `declaration` nor any presence field.

## 15. Tenancy obligations (per CLAUDE.md)

| Item | W | Obligation |
|---|---|---|
| `topology_org_presence_state` | W2 | RLS shape 1 in the creating migration. `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical: after `topology_observations`, before `topology_policy_targets`). Merge policy `keep-survivor`, since the survivor's dirty mark comes from the devices trigger. `CORE_TENANT_EXPORT_POLICY`: all scalar columns `included`, no jsonb. |
| `topology_site_fingerprints` | W2 | RLS shape 1. Cascade order: after `topology_relationships`, before `topology_site_state`. Merge `repoint` (rows are rejected by version until re-evaluated). Export: `gateway_macs` → `excludedOpen` (jsonb). Everything else `included`. No `SUSPICIOUS_NAME_PARTS` hits, but re-check at implementation. |
| `topology_device_presence` | W2 (+W3 cols) | RLS shape 1. Cascade order: after `topology_config_templates`, before `topology_diagnostic_runs`. Merge `repoint`. Export: `evidence` → `excludedOpen`, the rest `included`. Has `device_id`, so it goes in `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`moveOrg.coverage.test.ts`). It also goes in `CORE_DEVICE_ORG_MOVE_DELETE_TABLES`, because a cross-org move must delete rather than restamp rows whose `matched_site_id` and `assigned_site_id` name source-org sites (verify loop order in `moveDeviceOrgInTransaction.ts` against the composite FK; see plan W2 Task 1). Not in `DEVICE_SITE_DENORMALIZED_TABLES`: the devices trigger deletes the row on a site change. The W3 columns are scalars → `included`. |
| `topology_device_presence_days` | W3 | Same lists as `topology_device_presence` (cascade order right after it, `repoint`, device cascade, org-denormalized and move-delete lists). Export: all `included`. |
| `devices.site_assignment_confirmed_at` | W3 | **New column on an already-registered table → `CORE_TENANT_EXPORT_POLICY` `devices` entry, `included`** (`tenant-export-policy.integration.test.ts` reds otherwise). No other list changes. |
| Triggers | W2/W3 | `SECURITY DEFINER`, `SET search_path = public, pg_temp`. They only write the same org's `topology_org_presence_state` and delete that device's presence row. |
| Migration naming | W2/W3 | `YYYY-MM-DD-HHMMSS-<slug>.sql`, named to sort after the newest **committed** migration at authoring time (on `origin/main` 2026-10-02 that is `2026-12-04-120200-autopay-capture-recovery.sql`). Idempotent, no inner `BEGIN`/`COMMIT`. These migrations write no rows, so no `set_config('breeze.scope','system')` is needed. If one gains a backfill, it must elect system scope first. |
| Contract runs | W2/W3 | `tenantCascade`, `orgMergeRegistry`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgLifecycleFoundations` (merge contract) under Integration Tests; `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; full `orgMerge.test.ts` in the full unit suite. |

## 16. Known limits

- Presence is only as good as declarations. Sites with no declared networks keep today's map plus a hint.
- The bootstrap gap (6.4): B needs one correctly assigned observer per declared prefix.
- Prolonged visits look like misassignment. Seven days cannot tell a month-long secondment from a wrong
  assignment, so the copy says "probably" and a human decides.
- Proxy ARP, VRRP or HSRP virtual MACs, cloned router configs and spoofing can produce misleading matches.
  Copy never says "verified".
- A VPN whose full tunnel lands on the home site's network is excluded (tunnel interfaces never form
  attachments). Split-tunnel devices are classified by their physical LAN.

## 17. Owner decisions (resolved 2026-10-03)

- **Q1 — admin-declared gateway: not in v1.** No new column on `network_baselines` and no
  site-networks table. Revisit only if `declared_unconfirmed` shows up in production; adding it later is
  additive.
- **Q2 — dismissal expiry: none in v1.** A confirmation (`devices.site_assignment_confirmed_at`) stays
  until the device is moved or an admin clears it. The "Suggestions off" marker keeps it visible.
