# Intelligent network topology — collection and reconciliation

Date: 2026-09-15
Status: Engineering specification; implementation not started

Companions: [Main design](2026-09-15-intelligent-network-topology-design.md), [authoritative data/API contracts](2026-09-15-intelligent-network-topology-data-contracts.md)

Supersedes: Collection and automatic-connection recommendations in the [feasibility proposal](2026-09-15-intelligent-network-topology-proposal.md).

## 1. Contract and boundaries

Every known network must render a useful logical overview before managed-network discovery succeeds.
The minimum ingredients are known inventory, network groups, an identified or unidentified gateway presentation, and an Internet diagnostic destination with an explicit unknown state.
Missing observations must remain visible as missing observations; the diagram must never invent a physical switch, cable, ISP, or healthy Internet connection.

Use the data/API contracts' canonical relationship kinds: `network_member`, `default_route`, `egress_path`, `physical_link`, and `attachment`.
Keep `evidenceClass=observed|inferred|manual`, `confidence=high|medium|low|asserted`, `freshness=fresh|stale|unknown`, and `lifecycle=active|withdrawn|archived` independent.
A route read from an endpoint OS is observed logical evidence with high confidence; it does not establish a physical connection or successful forwarding.
Schematic placeholder objects use the `presentation:` namespace and `meaning:'schematic'`; placeholder is presentation copy, not an enum. Their connectors carry no canonical relationship ID and are excluded from path traversal, impact calculations, incident correlation, and health aggregation.

This document owns collection, normalization, identity matching, completeness, and graph synthesis.
The data/API contracts own authoritative SQL/API names, enums, RLS, identity, permissions, and migrations; defer to that document if a spelling differs here. The main design owns UI, layout, delivery, and release gates.
The [operations companion](2026-09-15-intelligent-network-topology-operations.md) owns active checks, command execution, probe targeting, monitor bindings, and AI investigation.
Passive collection never initiates DNS queries, gateway pings, external requests, controller discovery, or new scans merely because somebody opens the map.

## 2. Existing code to extend

| Current seam | Required change |
| --- | --- |
| `agent/internal/collectors/network.go` | Replace one-address/heuristic-primary assumptions for topology with complete interface and route observations. Preserve the legacy inventory contract. |
| `agent/internal/heartbeat/ip_tracking.go` | Populate legacy optional fields only when unambiguous; produce the separate versioned context snapshot below. |
| `agent/internal/discovery/adjacency.go`, `scanner.go` | Collect each protocol independently; emit successful-empty and failed source blocks; normalize ports. |
| `agent/internal/snmppoll/fdb.go` | Preserve bridge-port→ifIndex, FDB identity, and VLAN mappings instead of collapsing them. |
| `agent/internal/unifi/client.go`, `collector.go` | Preserve controller site and connection type; add per-resource completion manifests. |
| M1-created `apps/api/src/jobs/topologyReconcileWorker.ts` and `apps/api/src/services/topology/{projectors,reconcile}.ts` | Extend the ordered v2 materializer behind resolved rollout flags; M2 registers physical projection here and uses M0 atomic publication. |
| `apps/api/src/services/unifi/unifiTelemetryService.ts` | Resolve topology identities within the mapped organization/site/controller; reject ambiguous enrichment. |

The June `apps/api/src/jobs/reconcileTopology.ts` remains the legacy compatibility reconciler; do not add v2 reconciliation or canonical support writes there. M0 captures legacy mutations at their write boundary, while the M1 worker alone owns v2 ordered reconciliation.

The current scanner discards zero-neighbor blocks and does not collect FDB without LLDP/CDP neighbors.
Current LLDP local-port values contain the time mark; CDP ifIndex and bridge-port numbers occupy different identifier spaces.
The existing UniFi client lookup uses organization+MAC with `limit(1)`; that is insufficient for topology identity across sites.
These source findings are implementation prerequisites, not assumptions that production data is currently wrong.

## 3. Passive endpoint collection

Add `agent/internal/collectors/networkcontext/` with common normalized types, separate platform implementations, and injectable OS seams.
Use the existing pinned `golang.org/x/sys` and `golang.org/x/net` dependencies; no new privileged service or OS configuration changes are required.

| Platform | Required mechanism | Capability boundary |
| --- | --- | --- |
| Windows | IP Helper APIs: `GetAdaptersAddresses`, `GetIpForwardTable2`, and `GetBestRoute2` for a specified diagnostic destination. | Collect the agent's current compartment. Preserve compartment identity and advertise other compartments as unobserved. |
| Linux | `NETLINK_ROUTE` dumps for links, addresses, routes, rules, and cached neighbors; route lookup for the actual diagnostic flow. | Collect the agent's current network namespace, including its visible tables/VRFs. Do not enter other namespaces automatically. |
| macOS | `x/net/route` routing-information-base and interface reads; routing-socket lookup for a diagnostic destination. DNS uses SystemConfiguration on cgo builds and bounded `scutil --dns` parsing on no-cgo builds. | Preserve interface-scoped routes and resolver scopes. Missing resolver fields are partial DNS coverage, not empty configuration. |

Windows provides IPv4/IPv6 route and adapter APIs, including a source/destination-specific route query. [GetIpForwardTable2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getipforwardtable2), [GetBestRoute2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getbestroute2), [GetAdaptersAddresses](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getadaptersaddresses).
Linux rtnetlink exposes route table, gateway, source, multipath, and routing-rule information. [Kernel route specification](https://www.kernel.org/doc/html/next/networking/netlink_spec/rt-route.html), [Linux rtnetlink manual](https://man7.org/linux/man-pages/man7/rtnetlink.7.html).
Go's route package supports Darwin route/interface reads; Apple exposes active network state through the dynamic store. [Go route package](https://pkg.go.dev/golang.org/x/net/route), [Apple SCDynamicStore](https://developer.apple.com/documentation/systemconfiguration/scdynamicstore-gb2).

Linux DNS reads systemd-resolved's read-only D-Bus properties first, NetworkManager active IP configuration second, and `/etc/resolv.conf` last.
Collect per-interface resolver addresses and routing/search domains when available; mark a fallback flat resolver list as incomplete for split DNS.
Keep a loopback resolver as a local stub, never as a remote network device; do not infer its upstream server.
systemd-resolved explicitly distinguishes per-link DNS and domain-based DNS routing. [Resolver D-Bus contract](https://www.freedesktop.org/software/systemd/man/org.freedesktop.resolve1.html).

Collect at agent startup and every 5 minutes with ±10% jitter.
OS change notifications trigger a 10-second debounce; allow at most one extra collection per minute and one in-flight collection per agent.
The normal collection budget is 2 seconds; cancel remaining sections at 10 seconds and submit completed sections with partial outcomes.
Subprocess fallbacks use an argument array, fixed executable, 3-second timeout, and 1 MiB output cap; never interpolate labels into a shell command.
An event listener failure falls back to periodic reads and is reported as a capability limitation.

Collect all addresses and prefixes on active and inactive non-loopback interfaces, including tunnel, bridge, cellular, and virtual interfaces.
Hide inactive interfaces in the default overview, but retain them in evidence; loopback remains resolver/context metadata only.
Persist IP address, prefix length, family, scope/zone, address state, and OS-reported assignment source where available.
Do not infer DHCP/static from an interface name, public/private address, or address suffix; unknown is a valid value.
Read cached ARP/NDP entries without sending discovery packets; cache absence does not mean the peer is absent.

## 4. Versioned transport and capability negotiation

Introduce optional `networkContextV1` on the agent heartbeat ingestion contract; agent configuration advertises `acceptedNetworkContextVersions: [1]` before agents send it.
The API deploys the validator first. An old server that does not advertise support receives the existing heartbeat only.
An old agent remains useful through inventory/discovery inference; absence of the new field never clears existing evidence.
Keep existing `ipHistory`, `gateway`, `subnetMask`, and `dnsServers` fields backward compatible.
Populate a legacy gateway only when that address family/interface has exactly one unambiguous next hop; never select an arbitrary default for a multi-route host.

The wire envelope and row table below are normative; SQL representation belongs to the data/API contracts. `CollectionOutcome` uses its canonical enum:

```ts
type NetworkContextEnvelope = {
  version: 1;
  producerEpoch: string; // server-issued, bound to authenticated agent/collector
  snapshotId: string;    // UUID; report/retry identity; unchanged reports create no run row
  sequence: string;      // decimal uint64; assigned before collection starts
  capturedAt: string;    // RFC3339 UTC; never the ordering authority
  captureAgeAtSendMs: number | null;
  expectedIntervalSeconds: number;
  contentDigest: string; // lowercase SHA-256; canonicalization contract below
};
type NetworkContextV1 = NetworkContextEnvelope & ({
  reportKind: 'full';
  capabilities: Array<{ name: string; version: number; supported: boolean }>;
  contextManifest: { outcome: CollectionOutcome; contexts: Array<{
    contextKey: string; families: Array<'ipv4' | 'ipv6'>;
  }> }; // complete means all contexts visible to the authorized OS reader
  sections: Array<
    Section<InterfaceRow> & { kind: 'interfaces' } |
    Section<RouteRow> & { kind: 'routes' } |
    Section<RuleRow> & { kind: 'rules' } |
    Section<ResolverRow> & { kind: 'resolvers' } |
    Section<NeighborRow> & { kind: 'neighbors' }
  >;
} | { reportKind: 'unchanged'; baseSnapshotId: string });
type Section<T> = {
  contextKey: string;
  addressFamily?: 'ipv4' | 'ipv6'; // completeness scope, never a row filter
  contentDigest: string; // independently verified source/protocol/context digest
  outcome: CollectionOutcome; reasonCode?: string;
  rowCount: number; omittedRowCount?: number; rows: T[];
};
```

The API derives agent ID, organization, site, and permitted source scope from authentication/configuration; it never trusts tenant IDs in payload rows.
Advertised capabilities include interface/address, IPv4/IPv6 routes, routing rules, scoped DNS, neighbor cache, route lookup, and interface-bound probes separately.
`supported` means the binary/platform implements a capability; collection failure and insufficient permission are per-section outcomes.
Unknown minor optional fields are ignored after size validation; an unsupported major version is rejected with a typed error while the heartbeat remains usable.

Each row has a required source-local `rowKey:string`; duplicate keys in one section are invalid. In the field table, `?` means optional, `|null` means required but unknown is permitted; unmarked fields are required.

| Discriminator / row | Required and optional fields |
| --- | --- |
| `interfaces` / `InterfaceRow` | `interfaceKey:string`, `osIndex:uint32`, `name:string`, `kind:ethernet\|wifi\|tunnel\|bridge\|cellular\|virtual\|other\|unknown`, `adminState` and `operState:up\|down\|unknown`, `mtu:uint32\|null`, `addresses:AddressRow[]`; `permanentMac?:MAC`, `currentMac?:MAC`, `parentInterfaceKey?:string`. |
| Nested `AddressRow` | `address:IP`, `prefixLength:uint8`, `family:ipv4\|ipv6`, `zone:string\|null`, `state:preferred\|deprecated\|tentative\|duplicate\|unknown`, `assignment:dhcp\|static\|slaac\|link_local\|unknown`. Prefix bounds are 0–32 or 0–128 by family. |
| `routes` / `RouteRow` | `family`, `destinationPrefix:CIDR`, `interfaceKey:string\|null`, `tableKey:string`, `routeType:unicast\|on_link\|local\|blackhole\|unreachable\|prohibit\|other`, `metric:uint32\|null`, `nextHops:NextHop[]`, `osFlags:uint32`; `sourcePrefix?:CIDR`, `protocol?:string`, `expiresInSeconds?:uint32`. |
| Nested `NextHop` | `address:IP\|null`, `zone:string\|null`, `interfaceKey:string\|null`, `weight:uint32\|null`; maximum 64 per route, null address only for on-link/explicit interface routes. |
| `rules` / `RuleRow` | `priority:uint32`, `tableKey:string\|null`, `action:lookup\|blackhole\|unreachable\|prohibit\|goto\|other`, `selectors:RuleSelector[]`, `selectorCoverage:complete\|partial`; `unsupportedSelectorKinds?:string[]`. Selector union is `source\|destination→CIDR`, `inputInterface\|outputInterface→interfaceKey`, `fwmark→{value:uint32,mask:uint32}`, `uidRange→{start:uint32,end:uint32}`; other selectors make coverage partial. |
| `resolvers` / `ResolverRow` | `address:IP`, `zone:string\|null`, `interfaceKey:string\|null`, `isLocalStub:boolean`, `port:uint16`, `transport:udp_tcp\|tls\|https\|unknown`, `domains:{name:string,routeOnly:boolean}[]`, `mechanism:ip_helper\|systemd_resolved\|network_manager\|resolv_conf\|system_configuration\|scutil`; `serverName?:string`. |
| `neighbors` / `NeighborRow` | `address:IP`, `family`, `zone:string\|null`, `interfaceKey:string`, `mac:MAC\|null`, `state:reachable\|stale\|delay\|probe\|incomplete\|failed\|permanent\|unknown`, `isRouter:boolean\|null`. |

IP/CIDR/MAC validators canonicalize addresses, preserve zones separately, reject invalid family/prefix combinations, and require nonempty scoped keys. Scalar keys/names cap at 255 UTF-8 bytes; domain names follow DNS bounds; arrays of selectors/domains/unsupported kinds cap at 64 each. All numbers are finite integers in the named range; ports are 1–65535, row counts equal actual lengths, and optional properties do not accept null unless shown.
Represent on-link/no-gateway as a null next hop with an explicit route type; zero addresses are not virtual router identities.
Unsupported rule selectors remain a limitation, never a broad match; raw OS text and unrelated configuration are not uploaded.

Default per-context limits: 128 interfaces, 1,024 addresses, 2,048 routes, 512 rules, 128 resolvers, and 4,096 cached neighbors.
The OS envelope is capped at 512 KiB; retain interfaces, default/connected routes, resolver configuration, then other rows in deterministic order.
Hitting any limit marks that section `partial` with `reasonCode=limit_exceeded`; no negative inference is permitted for omitted rows.
The collection result must include every requested section, even if its rows are empty, failed, or unsupported.
`contextManifest` contains at most 128 unique contexts; `complete` requires successful enumeration without truncation. A vanished table/interface context counts as absent only after that manifest is complete, never because a section block was omitted. A present context still requires its requested sections; missing sections make the affected source partial.

### Content digests and unchanged confirmations

After every scheduled read, the collector canonicalizes the result and compares its digest with the latest server-acknowledged full baseline for the same authorized source and producer epoch. It sends `full` for initial, changed, or requested resynchronization content; otherwise it sends `unchanged` referencing that exact `baseSnapshotId` and digest. An unchanged report requires a new actual collection with a new sequence/capture time; resending cached observations or retrying an old report cannot refresh anything.

Canonicalization version 1 sorts object keys, contexts, sections, and set-like rows by normalized scoped identity; it preserves semantically ordered arrays such as ordered resolver search configuration. Hash input includes schema/canonicalization version, authorized source identity, producer epoch, capabilities, context enumeration, every section's outcome/coverage/reason/omission counts, and all normalized semantic evidence fields. It excludes digest fields themselves, snapshot IDs, sample/receipt/send timestamps, sequence counters, transport/chunk metadata, and LLDP time marks; these are collection metadata. An actual evidence expiry is retained as semantic validity, with countdowns normalized to their expiry anchor, not hashed as a decrementing sample clock. Array order or a new timestamp alone cannot create a structural change; a missing row or `complete`→`partial` always changes the digest.

The server recomputes full-report digests after validation and returns `{acceptedSequence, contentDigest, baseSnapshotId, nextFullValidationAt}`. An unchanged report is accepted only if scope, active epoch/configuration, digest, and retained baseline match; unknown/mismatched bases return `full_snapshot_required` without freshness renewal. The first report after epoch rotation is full. A full revalidation is requested every 24 hours with jitter; identical content confirms the retained baseline without appending a new collection run, observation, or checkpoint row. A changed full source scope creates one retained normalized snapshot; repeating it after a lost response does not create another.

The envelope batches independently scoped section digests; each digest includes its protocol/context/family, relevant context-manifest entry and enumeration outcome, section completeness, and semantic rows. A full envelope compares sections independently and retains only changed admitted scope content. Known identical complete sections can confirm their facts even when a noisy neighbor section changes or exceeds its history budget. Per-scope acceptance results include their accepted sequence/digest/base; the server acknowledges an envelope-wide baseline only when all sections are validated/admitted. Otherwise the client continues full reports for comparison; rejected section content cannot be referenced by a later whole-envelope unchanged acknowledgement. This prevents cache churn in one protocol from withholding valid confirmations in another.

For an accepted new unchanged report, atomically advance the compact accepted sequence and latest confirmation metadata. Renew `fresh_until` only for rows actually re-read and present in that verified digest, using the new effective capture time and bounded cadence. A missing fact is never renewed. `failed`, `unsupported`, and `not_attempted` sections renew no facts; `partial` sections may renew only their exact validated positive row keys, whether sent full or confirmed against the matching partial digest, never facts omitted from that partial result or inherited from an earlier complete baseline. Partial results cannot withdraw omitted facts. An unchanged outcome cannot promote incomplete coverage or reuse a different context's successful clock.

Freshness confirmations are mutable bounded source/support metadata, not new immutable observations. Each confirmation retains the validated digest and sequence; graph reads overlay it only when it matches the published support's source epoch/content identity. Confirmation of a staged changed digest cannot refresh an older published graph. A pure confirmation creates no dirty structural revision, graph rebuild, outbox event, per-tick collection-run/observation row, or structural graph revision; an actual freshness/coverage transition may update the separate health/coverage stream. Changed snapshots and qualified miss transitions still require ordered materialization.

Compact state retains the current normalized baseline, accepted/published digests and sequences, confirmed-through time, outcome, expected cadence, and bounded per-support absence state beyond the 30-day detailed-evidence window. This is typed current state under existing payload limits, not unlimited raw OS dumps. Retiring a source fences confirmations and subjects that state to normal lifecycle cleanup. Historical evidence may expire while the inspector still truthfully shows current content plus “Last confirmed”; it must not pretend every confirmation has a retained observation row.

At 10,000 agents and a five-minute cadence, there are 2,880,000 collections/confirmation messages per day. In the stable case after initial baselines, the default creates **zero additional collection-run or observation rows per tick**, and no periodic checkpoint rows; 10,000 of those daily reads carry full revalidation bodies and the remainder carry compact unchanged reports. Compact metadata still receives up to 2.88 million updates/day (about 33/second before scope fan-out); bounded row count does not mean zero write/WAL cost. No per-message successful audit record is created; aggregate metrics and exceptional transitions provide operational visibility.

Default full-content change admission is six retained snapshots/hour (burst two), 48/day, and 8 MiB normalized content/day per authorized producer, shared across its sections and epochs; SNMP/controller producers are scoped to their authorized target/controller-site, not attacker-chosen `sourceKey` values. Retained schema limits still apply. An organization additionally has a 250,000 changed-snapshot/day and 16 GiB/day ceiling; settings may lower these limits, and raising them requires explicit configuration with a storage estimate. Identical full revalidations/unchanged confirmations do not consume changed-history budgets. Authentication, parsing, and confirmation rate limits still bound input work to configured cadence plus the existing event allowance.
Count each retained changed source-scope snapshot against those limits; batching cannot bypass them. First baselines have a once-only allowance of up to 128 scoped snapshots per enrolled producer instead of the per-producer hourly/daily count limits; they still consume byte and organization budgets. Enrollment identity, not producer epoch, owns that allowance. Excess initial scopes expose limited coverage until admitted; never silently treat a truncated initial graph as complete.

On an over-budget changed report, return `snapshot_budget_exceeded` with Retry-After, update one compact coverage/error counter, and preserve at most one bounded latest retry candidate per producer. Do not accept its digest as a baseline or renew existing evidence from it. Coalescing unaccepted changed candidates marks an explicit coverage gap and invalidates any pending consecutive-miss streak; the next admitted complete snapshot starts a new streak. Do not discard already accepted pending snapshots/transitions. Epoch resets cannot reset quotas; quota/throttle state is collection coverage, never a target-down result.

## 5. Identity, routing contexts, and gateway meaning

Canonical node IDs are UUIDs with scoped identity aliases, as specified in the data/API contracts.
Managed `devices.site_id` is NOT NULL; agent collection always derives a concrete existing site through enrollment. Missing/invalid managed-site context is rejected/quarantined as inconsistent data, never normalized into an “unassigned managed device.” Null-site handling is limited to legacy/discovered/manual records whose own schema permits it; they cannot join a site graph until explicitly assigned.
Never derive a global node ID from an IP address, MAC, interface index, hostname, VLAN number, or subnet alone.
Prefer a persistent OS adapter identifier; otherwise use a persisted per-agent interface identity with unique hardware/OS evidence.
An unresolved interface-index reuse or ambiguous replacement creates a new interface identity; preserve old aliases/history instead of merging by index.
Temporary IPv6 addresses belong to the same interface, so address rotation does not produce new device nodes.

A local routing-context key is always subordinate to its observer and capture epoch; table `main` on two agents is not a shared routing domain.
Preserve namespace/compartment, table/VRF, interface scope, address family, and policy selectors when present.
Never equate two sites, VPNs, or routing domains because their address prefixes overlap.
Within one site, a configured network or uniquely corroborated managed network provides a durable group identity.
Otherwise, site+prefix grouping is an explicitly inferred presentation grouping; retain each observer's distinct context under it.
Conflicting gateway identities, simultaneous overlapping interfaces, tunnel contexts, or ambiguous discovery-profile scope split that grouping into labeled candidates.
An agent's administrative site assignment does not prove its current LAN is the site's LAN; roaming endpoints remain in an observer-local network until evidence supports joining a site group.

A gateway is initially an address/service node keyed by its resolved local network context, family, address, and zone.
Its label is “Reported gateway”; a virtual gateway address must not be silently renamed as one physical router in an HA pair.
ARP/NDP+unique inventory identity can attach a scoped alias to a gateway, but shared/virtual MACs and competing candidates remain unresolved.
Inventory enrichment preserves the existing canonical gateway identity and coordinates; merges require the data/API contracts' alias/redirect transaction.
Never infer a gateway from `.1`, `.254`, an HTTP port, a router classifier, or the first IP returned by discovery.

Keep all default routes for both families, including alternatives, equal-cost next hops, and routes through tunnels.
Do not run a home-grown “lowest metric wins” algorithm across OSes or policy tables.
An active diagnostic performs the OS route lookup for its actual source/destination/family and records the selected interface, next hop, and lookup time.
Routing inventory alone labels an outbound path “configured”; a tested `egress_path` remains scoped to the actual probe context and destination.
Split-tunnel routes, paired half-default routes, policy rules, proxies, and application-specific VPNs prevent a single universal “Internet gateway” claim.
Where the selected path cannot be resolved, show the observed route set plus “Selected path unknown.”
IPv6 link-local next hops include the interface zone; identical `fe80::` addresses on different links never merge.
A successful-empty complete route table means “No default route reported”; a failed read means “Gateway not identified.”

## 6. Baseline graph synthesis

Reconcile one site revision transactionally in this order; stable sort keys make equal inputs produce equal outputs:

1. Resolve inventory bindings and aliases under the same organization/site; retain unresolved identity candidates.
2. Create configured network groups, observer-local interface-prefix groups, and explicitly inferred discovery-profile groups.
3. Add `network_member` from a device/interface to its supported group. An OS prefix is observed membership in its local context; cross-observer grouping remains separately inferred.
4. For discovery-only assets, add inferred membership only for a unique configured/profile group containing their address. A scan range is not itself proof of a broadcast domain.
5. If grouping is ambiguous or no prefix is known, place the asset in “Network membership unknown”; its visual containment does not create a network-member claim.
6. Add observer interface→gateway `default_route` relationships for reported default-route next hops, keeping route attributes and alternative next hops.
7. Render a network→gateway overview projection only from those relationships, retaining supporting observer IDs/counts and per-family route alternatives in the inspector.
8. Add an Internet diagnostic destination with unknown health. Before a suitable test, its connecting line is schematic and explicitly labeled “Not tested.”
9. Add measured physical/controller/FDB detail using the rules below; do not delete useful logical membership when detail becomes available.
10. Suppress duplicate display lines at the view layer while preserving the independent canonical relationships and evidence.

No LLDP/SNMP/UniFi credentials are necessary for steps 1–8.
A site with devices but no agents can show inventory groups, gateway placeholders, and Internet unknown; it cannot have observed routes or current reachability.
A configured but empty network gets its network tile and explicit lack of observations, without fabricated endpoints.
Multiple networks with unknown gateways get separate placeholders; the renderer does not connect them into a fictitious shared LAN.
Known isolated networks keep an Internet destination in the inspector or optional diagnostics view rather than implying an uplink in their primary diagram.

## 7. Managed-network collector repairs

The existing discovery result path accepts additive `adjacencyV2` only after the authenticated parent job advertises `acceptedAdjacencyVersions:[2]`. Old agents continue sending legacy `adjacency`; those rows are positive-only. V2 source snapshots use this envelope, transported as one or more result chunks under the same parent job/command:

```ts
type AdjacencyV2Envelope = {
  version: 2; parentJobId: string; parentCommandId: string;
  producerEpoch: string; snapshotId: string; sequence: string;
  capturedAt: string; captureAgeAtSendMs: number | null;
  expectedIntervalSeconds: number; contentDigest: string;
  source: { sourceKey: string; address: string; zone: string | null };
};
type AdjacencyV2 = AdjacencyV2Envelope & ({
  reportKind: 'full';
  sections: Array<Section<LldpRow> & { kind: 'lldp' } |
    Section<CdpRow> & { kind: 'cdp' } |
    Section<FdbRow> & { kind: 'fdb' } |
    Section<InterfaceRow> & { kind: 'interfaces' }>;
  chunk: { index: number; count: number; contentSha256: string };
  finalManifest?: { chunks: Array<{ index: number; contentSha256: string }>;
    scopes: Array<{ kind: 'lldp' | 'cdp' | 'fdb' | 'interfaces';
      contextKey: string; outcome: CollectionOutcome; totalRows: number }> };
} | { reportKind: 'unchanged'; baseSnapshotId: string });
```

For each row below, `rowKey` is required; ports are `PortRef={namespace:if_index|if_name|bridge_port|lldp_local|controller_port, value:string, resolvedInterfaceKey:string|null}`. Chassis/remote IDs are `{subtype:string,value:string}` and preserve their typed namespace. Address fields use the OS envelope's address validation; strings/keys cap at 255 bytes, numeric indexes at uint32, optional lists at 64 entries.

| Row | Required fields; optional fields use `?` |
| --- | --- |
| `LldpRow` | `timeMark:uint32`, `remoteIndex:uint32`, `localPort:PortRef`, `remoteChassis:TypedId`, `remotePort:TypedId`; `remoteSysName?:string`, `remoteAddresses?:IP[]`. |
| `CdpRow` | `deviceIndex:uint32`, `localPort:PortRef` with `namespace=if_index`, `remoteDevice:TypedId`, `remotePort:TypedId`; `remoteAddress?:IP`. |
| `FdbRow` | `bridgeContext:string`, `fdbId:uint32\|null`, `mac:MAC`, `bridgePort:uint32`, `ifIndex:uint32\|null`, `status:learned\|self\|management\|invalid\|other`, `vlans:uint16[]`, `vlanMapping:complete\|partial\|unknown`; `ifName?:string`. VLAN values are 1–4094; an empty unknown list is not untagged VLAN membership. |

The API verifies that the authenticated agent owns `parentCommandId`, that the command belongs to `parentJobId`, and that source address/context/protocols fit the job's authorized target ranges and collector configuration revision. UUID possession alone is insufficient. Rejected, expired, fenced, or cancelled jobs cannot create current topology support; tenant/site authority comes from the stored parent, never `sourceKey` or payload IDs.
Full reports emit all requested protocol/context sections, including `complete` with zero rows, `failed`, `unsupported`, and `not_attempted`. A source snapshot's ID/sequence/capture content is immutable across chunks; chunk hashes cover canonical normalized section content. Chunk row counts are local, manifest row counts are total, duplicate row keys across chunks are invalid, and scope manifests must match the authorized requested protocols.
Only a validated final manifest with every matching chunk/hash/count can confer its per-scope `complete` outcome. A failed LLDP section cannot invalidate complete FDB data or make missing LLDP neighbors authoritative; no whole-site completeness is inferred.
Apply the same verified digest/unchanged protocol after a new actual SNMP read; the new parent job/command must independently authorize it. Digest identity excludes parent job/command IDs, chunk layout, and collection metadata while retaining the authorized source/configuration scope and final per-protocol completeness. An unchanged report has no chunks and can confirm only its retained validated baseline; chunk-only or partially received content never becomes that baseline.

For each authorized SNMP target, attempt LLDP, CDP, bridge FDB, interface inventory, and required mapping tables independently.
Reuse a successfully authenticated SNMP session; absence of neighbors must not trigger credential cycling or skip FDB.
Retain existing target authorization and credentials. Report timeout, authentication, access-denied, unsupported, malformed, and limit-exceeded distinctly without returning secrets.
A negative capability response may be cached for 24 hours; a timeout is failed, not unsupported. Configuration changes clear the cache.
Default adjacency budget is 30 seconds per target and four concurrent targets per collector; a user-configured scan can lower these limits.

LLDP joins remote columns on the full `timeMark.localPortNum.remoteIndex` tuple, but emits `localPortNum` separately.
Read local port ID+subtype/description and remote chassis/port subtype; normalize a MAC only when the subtype says MAC.
Resolve a local port to ifIndex using explicit mapping or a unique subtype-aware interface identity match; otherwise preserve an unresolved local port reference.
Time marks are observation metadata, never stable port IDs. Remote system names alone may propose an identity candidate but never auto-merge inventory.
CDP retains cache ifIndex as ifIndex, resolves it through interface inventory, and preserves remote port/address identity separately.
Interface name, ifIndex, bridge-port number, LLDP local number, and controller port index have tagged namespaces; numerical equality across namespaces never proves a match.

Bridge FDB walks retain bridge context, bridge port, mapped ifIndex, MAC, row status, FDB ID, and VLAN evidence.
Collect Q-BRIDGE rows even when the legacy BRIDGE FDB is empty; do not use Q-BRIDGE merely to decorate legacy rows.
The leading `dot1qTpFdbPort` index is an FDB ID, not necessarily a VLAN ID. Map through `dot1qVlanFdbId`; preserve one-to-many mappings and unknown VLANs. [RFC 4363](https://www.rfc-editor.org/rfc/rfc4363).
Never collapse `(bridge context, FDB ID, MAC, port)` to one MAC→VLAN value. Exclude invalid/self entries and port zero from attachment inference.
LLDP/CDP-known infrastructure ports are excluded from FDB endpoint-parent selection only after their normalized port identities match.
Ports with more than 16 distinct eligible unicast MACs are flagged “Shared or upstream port” and excluded from automatic parent selection; count distinct MACs, not duplicate VLAN rows.
For the remaining rows, an unambiguous candidate creates `attachment(method=fdb, directness=unknown, evidenceClass=inferred, confidence=medium)`.
FDB means the MAC was learned through that port; even one MAC does not prove a direct cable.
Competing candidate ports remain visible in evidence with low-confidence alternatives and no arbitrary chosen parent; newer complete observations can resolve the competition.
Use `directness=via_unmanaged` only after separate evidence/manual assertion establishes intervening equipment; do not invent an unmanaged switch node.

Limit FDB to 20,000 rows per target per run. Adjacency payloads may use up to eight 1 MiB chunks with a manifest and SHA-256 chunk hashes.
Ingest is idempotent per snapshot+chunk; chunks stage until the manifest validates or the earlier of the parent deadline and 10 minutes after the first chunk. At that boundary, seal one immutable normalized snapshot; missing chunks force affected scopes partial.
Only admitted changed sealed snapshots enter structural reconciliation. Validated positives in a sealed partial snapshot may materialize, but missing facts cannot withdraw support. Identical sealed full reports follow confirmation suppression. Chunks arriving after sealing are historical-only; a fresh collection needs a new snapshot/sequence, never an in-place upgrade that could double-count absence.

## 8. UniFi topology bridge

Use the existing local Network Integration API collector, authenticated endpoint, bounded pagination, and site mappings; do not assume access to undocumented endpoints.
Resolve `(integration, controller host identity, controller site ID)` to exactly one authorized organization/site before emitting topology facts.
An unknown controller site is quarantined as unmapped for topology; it must not fall back to the collector's site.
Resolve device IDs within that same controller+controller-site scope, then bind to inventory by unique site-scoped MAC identity.
Apply the same unique site-scoped matching rule to clients; hostname and IP may corroborate, but cannot override ambiguous MAC matches.
Preserve controller `type` as `WIRED|WIRELESS|VPN|TELEPORT|unknown` through the upload; a single `isWired=false` cannot mean wireless.

Client `uplinkDeviceId` creates `attachment(method=unifi)` only when its upstream controller identity resolves in the same mapped scope.
Wireless type means controller-reported AP association; wired type means controller-reported attachment with directness unknown unless a port relationship is explicitly supplied.
VPN/TELEPORT clients are tunnel associations, never radio associations or copper cables. Unknown types remain unspecified attachments.
A missing port, SSID, VLAN, signal, rate, or PoE field stays null with capability information; do not generate values from model names or schema defaults.
Client lists currently provide useful identity/upstream data; detail/statistics collection is separate work before per-port telemetry is advertised.

Publish separate completion manifests for each controller site's device list, client list, device-detail collection, and statistics collection.
Failure on page two makes that list partial even if page one succeeded; another site's successful list can still reconcile its own absences.
An API 404 means that specific endpoint is unavailable; it cannot establish that all devices disappeared or that unrelated capabilities are unsupported.
Roaming clients change attachment evidence while retaining inventory identity; the new association is shown immediately and the old one follows withdrawal rules.
Controller list rate limits follow the existing integration schedule; topology reads never start a fresh controller poll.
The topology adapter computes the same scoped digest from normalized UniFi resource outcomes and rows. It suppresses identical materialization even if the existing telemetry collector sends full bodies every poll; a per-site partial list cannot renew absent clients or copy another site's successful confirmation time.

## 9. Ordering, reconciliation, and aging

Every source scope is `(authorized collector, source identity, protocol/section, routing/controller context, address family where applicable)`.
Obtain `producerEpoch` from a server session-fence handshake and persist it with the monotonically increasing sequence counter; allocate sequence before collection begins.
Ordinary restart resumes the persisted epoch/counter. Counter loss or re-enrollment requires a new server epoch; issuing it atomically fences the old epoch from current-state writes.
The epoch binds the authorized organization/site and collector configuration revision. Agent moves, remapped controller sites, credential/source changes, or revoked authority fence the relevant epoch; late data never gets relabeled into the new site.
Sequence gaps are allowed. Repeated snapshot ID+same canonical capture content is a no-op; different capture content is a conflict recorded for investigation. Retry transport age may increase and is excluded from the immutable content hash.
Within each source scope, only a higher accepted sequence may advance current observations or absence counters. Older results remain historical.
Two collectors can independently support the same relation; one collector's complete empty result cannot remove another collector's support.
For admitted changed reports, ingestion commits immutable normalized source snapshots, accepted producer high-water marks, and the site's dirty revision atomically; it does not publish canonical graph rows. Identical verified reports update compact confirmations only, except for the qualified miss-transition case below.
The reconciler processes ordered pending changed snapshots and compact miss transitions from the last materialized input through a pinned dirty high-water revision. Coalescing queue jobs must not discard accepted transitions or collapse their complete-miss meaning; replaying a processed event cannot count a second miss. Confirmation-only sequence advancement does not require a new published graph revision.
Compute a candidate graph, then atomically commit canonical nodes/interfaces, bound observations, aliases, relationships, source-support/miss state, and the published graph revision under the data/API contracts' per-site `build_fence` and materialized-input CAS.
Ingestion during computation leaves a subsequent build due. Readers see only published revisions, never staged objects; no response may combine endpoints from one revision with relationships from another.
Reads perform no row writes, materialization, or collection dispatch; time-derived freshness in a response does not require persisting a read-side state change.

| Outcome | Positive rows | Missing previously observed row |
| --- | --- | --- |
| `complete` | Materialize changed facts or confirm the matching published facts; reset each present fact's source-local miss counter. | Count an authoritative miss for this exact collection scope, including an eligible unchanged confirmation. |
| `partial` | Upsert validated rows. | No negative inference, including bounded/truncated rows. |
| `failed` | No new facts; preserve prior observations. | No negative inference. |
| `unsupported` / `not_attempted` | Update coverage/capability explanation. | No negative inference. |
| Legacy payload without completeness | Positive-only, tagged legacy and unknown completeness. | No negative inference. |

Default expected cadence is 5 minutes for endpoint context; SNMP/controller scopes use their configured poll interval, bounded to 1 minute–24 hours.
Freshness expires at the latest valid new positive capture/confirmation time plus `max(3 × expectedInterval, 15 minutes)`; retries or repeated delivery of the same sequence do not extend this deadline.
Keep producer timestamp and server receipt timestamp separately. Compute effective capture time conservatively as the earlier of valid producer time and receipt time minus monotonic `captureAgeAtSendMs`.
If age is unavailable after a rebooted offline spool, or producer time is more than 5 minutes ahead of receipt, set freshness unknown and request a new snapshot; never mark a delayed old report fresh.
Read-side freshness is derived from time even if an aging worker is delayed.
Two consecutive complete misses at least 5 minutes apart withdraw that source's support; one transient miss leaves prior evidence visible with “Not seen in latest collection.”
A matching validated positive, including a row actually present in a partial result, resets that fact's counter; failed/partial absence neither advances nor resets a missing fact's counter.
Suppression must preserve the second miss: after a full complete snapshot first omits previously supported facts, compact state records an absence generation, bounded absent-support references, first-miss sequence/effective time, and threshold time. A later actual complete collection with the identical empty/missing-content digest, a higher sequence, and usable effective time at least five minutes later qualifies even though its body is suppressed. A retry, new sequence with cached capture time, unknown-age spool, or incomplete outcome cannot qualify.
Atomically persist one pending compact `second_complete_miss` transition per source scope and absence generation, containing baseline digest, first/qualifying sequence and effective times, and absent-set reference; mark the site dirty once. Repeated unchanged confirmations update the high-water/freshness summary but create no further transition. Ordered materialization applies that event at most once, rechecks matching epoch/digest and intervening positives, and withdraws only the affected source's still-missing supports. This bounded transition creates no synthetic collection run or duplicate observation and cannot expose staged graph rows. A subsequent changed positive is ordered after it and restores support normally; a fenced or reset generation makes it inapplicable.
Withdraw a canonical relationship only when no source supports it and no manual assertion retains it; withdrawal is not a link-down alert.
Stale automatic relationships archive 7 days after their last support expires; withdrawn relationships remain in history and leave the default scene immediately.
Retain admitted changed collection runs and observations for 30 days. Compact current baselines, confirmation/source-support state, and unconsumed miss transitions survive detailed-history expiry; consumed miss transitions are cleared from compact source state after publication (aggregate counters retain operational visibility). Manual assertions, configured network groups, inventory bindings, and layout pins do not age out with telemetry.

## 10. Evidence precedence and conflict handling

Prefer identity-bearing observations over labels, but do not use one blanket precedence order across unrelated relationship meanings.
OS route evidence establishes configured next-hop relationships; LLDP/CDP establishes reported adjacency; UniFi establishes controller attachment; FDB supports attachment through a port.
These facts can coexist without one overwriting another. New physical detail enriches the baseline instead of deleting it.
Reciprocal LLDP/CDP reports merge only when endpoint identities and compatible port identities match; keep both source observations.
Canonical physical-link identity includes both endpoint port identities. Distinct parallel ports stay distinct; link aggregation groups are explicit metadata, not deduplication keys.
If ports cannot be resolved, retain a provisional adjacency and never claim an exact cable count; later evidence refines it through aliases without losing layout.
Use high confidence for supported typed OS/LLDP/controller facts, medium for unique FDB candidates, low for prefix/profile/label inference, and asserted for manual claims.
Reciprocal independent corroboration is shown in evidence count; confidence values are categories, not uncalibrated probability percentages.
Conflicting manual and observed connections remain separately inspectable; neither collection nor an LLM silently deletes a manual assertion.
Every inferred relationship exposes its rule ID/version, supporting observation IDs, limitations, and rejection alternatives for deterministic replay.
An LLM may propose an interpretation of ambiguity; it cannot create observed evidence or change the reconciliation result without an explicit manual action.

## 11. Acceptance examples and tests

| Fixture / trigger | Required result |
| --- | --- |
| One ordinary LAN, several endpoints, no managed-network protocols | Useful grouped overview; observer-reported gateway; Internet unknown until tested; no physical links. |
| Gateway ignores ICMP but outbound application check succeeds | Route relationship remains; probe-specific outcomes do not mark gateway/cable down. |
| No agents, configured subnet, discovered printer | Inferred membership plus labeled gateway/Internet unknown; no new active traffic. |
| Complete routes with no default vs route API timeout | “No default route reported” vs “Gateway not identified”; prior evidence ages only in the latter case. |
| Ethernet+Wi-Fi, VPN half-defaults, overlapping prefixes | Separate interface contexts; per-probe OS route selection; no invented universal gateway. |
| IPv6-only host, rotating privacy addresses, two link-local gateways | One device identity; correct interface zones; no cross-link gateway merge. |
| Same private range/MAC/name across organizations or sites | Distinct nodes/evidence; all cross-scope joins rejected, including UniFi enrichment. |
| Switch with FDB and no LLDP/CDP neighbors | FDB still collected; inferred port attachment appears with unknown directness. |
| Q-BRIDGE FDB ID differs from VLAN, shared FDB, same MAC in two VLANs | Correct FDB→VLAN mapping or explicit unknown; no first-row-wins collapse. |
| SNMP walk failure, empty successful walk, missing chunk, replay | Only complete empty scopes count absences; retries/older results never erase fresh evidence. |
| Stable complete content for 24 hours, 10,000 agents | 2.88M collection confirmations, no appended tick/checkpoint run rows or repeated observations after baselines; no structural revision churn; daily full validation remains suppressed. |
| Identical complete empty digest after first removal | A new eligible confirmation at least five minutes later produces exactly one compact second-miss transition and withdraws the missing source support. |
| Digest retry, unknown base, epoch rollover, changed completeness | No cached/replayed freshness renewal; unknown bases require full data; outcome changes cannot masquerade as unchanged complete content. |
| Noisy neighbor section, stable route section, exhausted quota | Stable complete route facts confirm independently; rejected changes remain coverage gaps, old facts are not renewed, and skipped changes break the relevant miss generation. |
| Reciprocal LLDP+CDP and two parallel links | One relationship per resolved port pair; all source evidence retained. |
| UniFi page/site failure, unmapped controller site, VPN client | Per-resource partial scope; no fallback site leakage; tunnel classification preserved. |
| Gateway inventory identity becomes known | Same canonical gateway/layout survives; no duplicate gateway/cable is drawn. |
| Clock skew, epoch reset, two collectors disagree | Historical-only late data; explicit unknown freshness; independent support preserved. |

Go tests use recorded binary/JSON/PDU fixtures, fake clocks, stub OS readers, and table-driven parsers; no external network access.
Run race tests for event debounce, snapshot sequencing, concurrent callbacks, cancellation, and retry persistence; build each supported platform and no-cgo variant.
Property tests cover semantic digest stability under timestamps/set ordering, digest change under missing rows/completeness/context changes, idempotency, normalized port namespace separation, and no cross-context IPv6 identity collisions.
API tests cover unchanged confirmation CAS/retries, daily full revalidation, complete-empty suppressed second misses, intervening positives, quota gaps/epoch bypass, retained compact baselines after history expiry, per-scope noisy/stable isolation, completeness scopes, site/tenant denial, sequence fencing, chunk assembly, atomic graph revision, and exact withdrawal boundaries.
Use a real PostgreSQL integration fixture for concurrent ingest/identity reconciliation and forced-RLS denial; tests belong alongside source except established integration suites.
Golden graph fixtures assert relationship kinds/evidence, not only counts: a visually connected baseline must still contain zero invented physical relationships.
Benchmarks use 10,000 agents and a 20,000-row FDB fixture to measure bounded processing, queue coalescing, and deterministic output.
Collection work is complete when these fixtures pass and the no-discovery overview functions with no SNMP/controller credentials or LLM configuration.
