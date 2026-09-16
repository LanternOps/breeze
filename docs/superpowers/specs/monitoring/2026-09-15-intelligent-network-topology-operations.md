# Intelligent network topology — diagnostics, monitoring, and AI

Date: 2026-09-15
Status: Engineering specification; no implementation or production action
Companion: [main design](2026-09-15-intelligent-network-topology-design.md)
Scope: Operational behavior for the logical and discovered topology, including networks without LLDP, CDP, SNMP, or a controller.

## 1. Outcome and boundaries

Every rendered node and relationship can explain what Breeze knows, how recently it learned it, and which useful checks are available. An agent-equipped network can diagnose gateway, DNS, and outbound connectivity without knowing its switches. A network without a suitable agent still renders its inventory and honest unknown states.

Opening, refreshing, or selecting a map performs reads only. Arranging the diagram may persist authorized layout changes; it launches no network activity. None of these actions scans address ranges, enables recurring checks, sends probes, polls extra SNMP OIDs, or invokes an LLM. Existing authorized collection continues independently. A user starts a diagnostic explicitly; a configured monitoring policy starts scheduled checks.

Diagnostics collect evidence. They do not reboot devices, change routes, reset interfaces, modify firewall rules, run arbitrary scripts, or claim to repair connectivity. Remediation remains in existing separately authorized workflows. Internet nodes describe tested destinations from a stated origin; they never promise that the whole Internet is healthy.

The [data and API contracts](2026-09-15-intelligent-network-topology-data-contracts.md) own graph identity, canonical database tables, permission definitions, and API prefixes; the main design owns UI and delivery. This document specifies the operational semantics of those contracts. All example names and limits below are proposed behavior, not claims about current implementation.

## 2. Existing integration points and required corrections

| Foundation | Reuse and required work |
| --- | --- |
| `apps/api/src/services/monitorCommands.ts` | Existing `network_ping`, `network_tcp_check`, `network_http_check`, and `network_dns_check` commands provide reusable probe primitives. New topology runs require durable correlation, actual method, and route attribution. |
| `apps/api/src/jobs/monitorWorker.ts` | Scheduled monitor selection already enforces an asset's site and excludes ephemeral Quick Support agents. Reuse these constraints through one shared selector. |
| `apps/api/src/routes/monitors.ts` | Existing manual-monitor bug [#5987](https://github.com/LanternOps/breeze/issues/5987): its separate on-demand selector can fall back to another site in the same organization and omits the worker's `isEphemeral` exclusion. Fix and consolidate the selector through that separate issue before topology exposes Run check; scheduled `monitorWorker.ts` already enforces both constraints. No compatibility fallback across sites. |
| `apps/api/src/services/commandQueue.ts` | Reuse command persistence, authorization, delivery, cancellation mechanisms where available, and audit attribution. Add versioned diagnostic capability and execution deadlines; do not implement a parallel ungoverned socket path. |
| `apps/api/src/db/schema/monitors.ts` | Current monitors derive site from optional `assetId`. Explicit site/network binding is required for virtual gateways, segments, and Internet nodes; do not manufacture discovered assets solely to bypass this limitation. |
| `apps/api/src/routes/snmp.ts` | Old metric history/per-OID routes return 410. Implement the scoped interface-history contract in the main design before displaying historical port charts. |
| `agent/internal/unifi/client.go` | Client `uplinkDeviceId` exists. Client port/VLAN/SSID/signal/counters and device PoE/CPU/traffic fields are not populated by the current list-only collection. Add validated detail/statistics adapters before exposing those metrics. |
| `apps/api/src/services/aiToolsNetwork.ts`, `aiToolsMonitoring.ts` | Reuse tool registration and scoped access helpers. New topology reads and actions receive explicit tiers; do not inherit the mixed monitoring tool's tier for execution. |

## 3. Inspector content and interpretation

| Selection | Required content | Available actions |
| --- | --- | --- |
| Agent/device | Identity, site, collection state, last heartbeat, associated alerts, applicable monitors, source interface/route summary | Open details; run target or gateway recipe; inspect existing history |
| Virtual gateway | Reporting endpoints, next-hop address/family/context, last route evidence, probe results and origins | Run gateway recipe where an eligible reporter exists; inspect identity evidence |
| Network segment | Observed versus inferred membership, prefixes/context, known gateway alternatives, coverage counts | Choose a reporter; run baseline diagnostics; configure scheduled monitoring |
| Internet destination/group | Tested endpoint identities, IPv4/IPv6 independently, DNS/TCP/TLS/HTTP results, proxy/route limitations | Run outbound recipe; inspect each destination and vantage point |
| Physical link/attachment | Endpoint identities and resolved ports, evidence/provenance, confidence, freshness, associated monitors/alerts | Inspect ports; run reachability toward a known endpoint; compare recent changes |
| Logical relationship | Relationship meaning, reporting device, route or membership evidence, freshness | Inspect supporting observations; test the related destination from a suitable reporter |
| Path | Selected source/target, graph relationships and uncertainty, routed probe result when available | Run bounded traceroute; compare observations; inspect each contributing item |

Show “Observed connection,” “Inferred attachment,” or “Manual assertion” independently of operational color. Unknown ports render “Port not identified,” not port zero. Missing measurements render “Not measured,” not zero traffic, zero loss, or online.

Canonical relationships retain `network_member`, `default_route`, `egress_path`, `attachment`, or `physical_link` semantics. Unknown-gateway connectors are presentation objects in the `presentation:` namespace with `meaning:'schematic'`, `presentationOnly:true`, and `relationshipKind:null`; there is no `placeholder` relationship enum. They supply neither diagnostic authority nor path/impact evidence. The inspector can explain missing configuration without offering a check against an invented gateway.

Clicking a connection tests a selected endpoint or path; it does not test the cable by itself. Directional port counters are scoped to one interface and may include unrelated traffic. Graph-path highlighting is labeled “Topology relationship path”; traceroute is labeled “Observed routed path.” Neither substitutes for the other.

Inspector actions explain an unavailable prerequisite inline: collector offline, incompatible version, route unavailable, execution denied, policy disabled, or destination unconfigured. Readable result tables and keyboard controls provide the same functionality as the canvas. All web mutations use `runAction`; accepted/queued feedback is followed by completion, cancellation, expiry, or failure feedback.

## 4. Independent state dimensions

Maintain these dimensions separately in API responses and presentation:

- **Relationship provenance/confidence:** observed, inferred, or manual; high, medium, low, or asserted as defined by the main design. A route directly reported by the OS is observed logical evidence, regardless of probe success.
- **Freshness:** fresh, stale, or unknown for each evidence/measurement stream, with `observedAt`, `receivedAt`, `freshUntil`, expected cadence, and last collection outcome. Compute with server receipt and bounded clock-skew handling; agent wall-clock timestamps cannot extend freshness arbitrarily.
- **Measured health:** healthy, degraded, failed check, or unknown, including reasons, source result IDs, and scope. The main API wire enum uses `failed_check` for the failed-check presentation. Explicit port operational state remains its own value.
- **Coverage:** monitored, partially monitored, unmonitored, unsupported, or unavailable. A successful TCP check does not satisfy an expected DNS/TLS check.

Topology observations become stale after `max(3 × expected collection cadence, 15 minutes)` without a newer success; health after `max(3 × scheduled check cadence, 60 seconds)`. An isolated on-demand result has a five-minute freshness window. A failed collection does not renew successful evidence. Disabled schedules become unmonitored immediately and retain visibly historical results.

Store the previous assessment when stale, but never show it as a current green/red assertion. Collector disconnection means “No recent measurement from this collector.” Gateway ICMP timeout means “No ICMP response,” not “Router down.” A route with no default gateway is a valid observed state, distinct from collection failure or an unknown gateway.

## 5. Baseline diagnostic recipes

Recipes are versioned, fixed DAGs of typed steps. The server expands allowed parameters; users and models cannot supply executable text or add arbitrary step types. Each step returns a structured outcome and retains the actual protocol used.

| Recipe ID | Steps and default limits | Assessment scope |
| --- | --- | --- |
| `gateway_basic` | Read selected route/interface; resolve the reported next hop; ICMP three packets at one-second timeout; optionally one TCP check on an explicitly configured gateway service | This reporter's configured route and responses from that next hop |
| `dns_basic` | Read applicable resolver configuration; query one configured known-answer diagnostic name for requested A/AAAA using at most two applicable resolvers, two-second timeout and one retry each | Resolver/query success from the selected interface/context; no assumption that arbitrary names resolve |
| `internet_basic` | Route/source attribution; applicable DNS check; TCP/443 and strict-TLS HTTPS check against two separately configured external endpoints, five-second step deadlines | Reachability and protocol outcomes to those destinations from this origin |
| `target_connectivity` | Route lookup; DNS when target is a hostname; three ICMP packets; optionally a single configured TCP port and a configured HTTPS health endpoint | Selected target/service reachability, never a subnet scan |
| `trace_route` | Destination-scoped ICMP or UDP trace supported by the agent; default 16, maximum 30 hops; one probe/hop, maximum two; one-second hop timeout; 60-second execution ceiling | Observed layer-3 responders for this method/time/destination |

The `internet_basic` DAG for one address family has one local route/resolver-context step, up to four endpoint-name/resolver checks (two configured names × two resolvers), then up to two selected addresses per endpoint with TCP and HTTPS as one bounded service-check step per address: at most nine steps total. That combined step reports TCP, TLS, and HTTP subresults separately and does not silently retry another address. Reuse the validated DNS answers for service checks; additional names, resolvers, or addresses require a new plan. Route lookup immediately before each probe is attribution inside that step, not an unbounded new network step. This remains within the 12-step and target-address budgets.

ICMP has no silent TCP fallback. If a legacy primitive falls back, report both requested and actual methods, preserve the ICMP unknown/unsupported outcome, and show the TCP result separately. Do not use TCP/443 to “prove” a gateway responds unless that service was configured as a meaningful target.

External diagnostic endpoints are explicit site-scoped execution targets with target host, port, HTTPS path, expected status, address-family support, and owner/independence label. Reusable definitions follow the [partner and organization template library](2026-09-15-intelligent-network-topology-data-contracts.md#partner-and-organization-template-library): partner-XOR-organization ownership, immutable versions, and site bindings, resolved in order from code defaults to selected partner version, selected organization version, then site overrides. Version adoption is explicit and pinned, including bulk preview/apply across 200 selected sites in one action; it is not manual per-site copying or automatic adoption of the latest version. Data owns the storage and inheritance contract.

No endpoint or public resolver is silently selected by code. Reading or publishing a template does not dispatch probes or enable schedules; applying a binding alone grants no execution authority. Explicit activation and material changes follow the existing execute, MFA, and recurring-authority re-arm requirements; failure to re-arm leaves the runtime policy disabled with a reason. Target/policy IDs and effective template versions are pinned in run plans; material changes invalidate affected queued plans. Setup may offer a maintained provider catalog, but its endpoints remain inactive until explicitly selected and authorized.

With no configured known-answer name, `dns_basic` reports `target_not_configured`; with no configured external endpoints, `internet_basic` reports the same reason. Both dispatch zero external probes in that state, and never substitute a public resolver or a guessed destination. `gateway_basic` remains available only for an observed route-derived next hop and its eligible same-site origin; a schematic gateway is not executable. The deterministic [baseline-no-management acceptance scenario](2026-09-15-intelligent-network-topology-design.md#12-acceptance-matrix-and-verification) tests this unconfigured state first, then explicitly configures a mocked known-answer DNS target and two controlled HTTPS destinations before testing DNS/outbound results.

Use two independent providers when policy supplies them; two names behind the same operator are not declared independent. A single configured destination produces a partial-coverage result. Isolated sites can disable outbound tests with an explicit “Outbound monitoring disabled” state. No default-route evidence skips external checks unless an allowed destination has a specific usable route.

Each recipe instance probes one target address family; choosing both in the UI submits two separately budgeted, visibly grouped runs. IPv4 and IPv6 are measured and assessed independently. IPv4 success cannot clear an IPv6 problem, and absence of an IPv6 route is not an IPv6 outage when that family is not expected by policy. Resolver selection respects interface and split-DNS configuration; DNS transport itself can use a different family from the queried A/AAAA destination. Where the platform cannot safely select the requested resolver context, return `unsupported_context` instead of using another resolver silently.

Gateway neighbor lookup may corroborate identity; a missing ARP/NDP entry is not failure proof. No next-hop MAC is invented for tunnels or point-to-point links. Link-local IPv6 destinations require a validated interface scope. NAT, VPN, proxy, policy routing, and multiple uplinks remain explicit context; successful proxied HTTP does not validate a direct egress edge.

## 6. Collector eligibility and path attribution

All topology execution uses an enrolled, trusted, non-ephemeral agent in exactly the requested organization and site. The requester must be allowed to read the target and origin and execute on that origin. Site membership alone does not prove attachment: require compatible observed routing context/interface for local gateway/segment checks. A roaming laptop with the wrong current context is ineligible for that network even if its inventory site matches.

Rank eligible origins deterministically: explicit authorized selection; original reporting agent for a gateway/context; policy-preferred collector with matching observations; then other matching agents by availability and collection freshness. A default choice is shown in the UI before execution. Never use an agent at another site as fallback. A separate cross-site diagnostic is outside this specification.

The eligibility response lists authorized candidates and machine-readable rejection reasons without disclosing inaccessible devices. Revalidate eligibility at submission and immediately before dispatch. A changed agent site, revoked execution permission, changed trust state, disabled policy, incompatible capability, or expired route binding cancels/refuses the dispatch.

Each step records `originDeviceId`, `originAgentId`, requested and actual method, destination logical ID, resolved IP/family, port where applicable, selected interface ID, local source address, route-table/context ID, selected next hop, proxy use, started/finished/received timestamps, and evidence IDs for route attribution. Unavailable fields are null with explicit attribution quality (`observed`, `requested_unverified`, `unknown`). A `default_route` belongs to its reporting endpoint/interface, and an `egress_path` belongs to the tested source context and destination; neither applies automatically to subnet peers.

Refresh route selection immediately before each probe and record the source/socket binding where supported. A route-table snapshot alone cannot establish the interface a proxied or policy-routed socket used. If the route changes during a run, annotate affected steps and withhold an exact egress-edge health assignment. Do not attribute a generic successful probe to every available gateway.

Traceroute unknown hops remain gaps. Missing responses, ICMP filtering, asymmetric return paths, ECMP, and address aliases limit interpretation. Do not infer failed physical links from asterisks or create inventory devices for every responding public hop. Retain per-TTL responders; mark alternatives instead of forcing a single physical route.

## 7. API and command contracts

The canonical API is site-scoped:

| Endpoint | Semantics |
| --- | --- |
| `GET /topology/sites/:siteId/collectors?recipe=...` | Return bounded eligible origins/capabilities for an authorized subject/context; read only |
| `POST /topology/sites/:siteId/diagnostic-runs` | Validate and enqueue a durable run; return 202 with run ID, accepted plan, chosen origin, deadlines, and status URL |
| `GET /topology/sites/:siteId/diagnostic-runs/:runId` | Return run/step status and evidence; no command dispatch; inaccessible IDs return 404 |
| `POST /topology/sites/:siteId/diagnostic-runs/:runId/cancel` | Idempotently request stop; return current authoritative state |

POST requires an `Idempotency-Key`, `recipeId`, `recipeVersion`, `subject` (`node`, `relationship`, or permitted destination ID), optional origin device, graph revision, and optional routing-context/address-family preference. HTTP recipes reference saved target configurations. Targets, route observations, ownership, and limits are resolved server-side; no arbitrary raw command, shell argument, OID, URL override, credential, or `orgId` hidden in a step is accepted.

Retain idempotency mappings for 24 hours scoped by organization, user, site, and endpoint; replaying the same normalized request returns its existing run, while a different body is 409. A moved/deleted subject or materially changed target/route context is 409 with a refresh reason. Invalid input is 400; missing permission is 403; inaccessible resources are 404; no eligible collector is 409; budget exhaustion is 429 with `Retry-After`; unavailable dispatch infrastructure is 503. None dispatch a command.

New agent command: `network_diagnostic` with a supported schema version, run/attempt/command IDs, recipe/version, pinned authorized step plan, subject/context references, permitted literal destinations or hostname-resolution policy, per-step bounds, absolute expiry, and a digest binding the normalized plan. For hostname targets the digest binds the hostname and allowed resolution policy, while the agent resolves and validates the actual address before connection. The agent validates its capability, payload bounds, expiry, and destination policy again. Results include the same IDs/digest, step IDs, actual observations, and truncation flags. The digest protects binding and audit consistency; authenticated command transport remains the trust boundary.

The API persists a run and an outbox/dispatch intent atomically, then dispatches outside the DB transaction. Workers use `runOutsideDbContext` before bounded `withSystemDbAccessContext` reads/writes; network/Redis waits never hold a database transaction. Queue envelopes are strictly validated. An origin authenticated through one agent connection cannot submit another origin's result.

Existing `device_commands` remain system-scoped per the repository contract. Diagnostic run/step/result/binding tables are tenant-scoped with `org_id`, forced organization-level RLS, and validated same-org/site references in the creating migration. Site authorization is application-layer enforcement using the existing site allowlist/access helpers on API, worker, AI, history, and result paths; organization RLS does not enforce site access. Reads require `topology:read` intersected with the existing permissions for the included devices, monitors, alerts, or metrics; aggregate counts must not reveal filtered entities. Server-resolved audit records include initiating user/policy, effective permissions, origin, target, plan digest, graph revision, and completion reason.

## 8. Durable run lifecycle

Run states are `queued → running → completed`, with `failed`, `cancelled`, and `expired` terminal alternatives. Terminal states are monotonic. `completed` means the planned checks produced an assessment; it can report failed connectivity or partial coverage. `failed` is orchestration/agent execution failure, not an unreachable target. `expired` means the useful execution window elapsed before the result could be accepted as current.

Step outcomes are `succeeded`, `failed_check`, `timeout`, `unsupported`, `skipped`, `cancelled`, or `execution_error`, preceded by `pending`/`running`. A timeout while actually probing is measurement evidence; a timeout waiting for a collector is not. The run additionally returns `assessment` (`healthy`, `degraded`, `failed_check`, `unknown`) and `coverage` (`complete`, `partial`, `none`), plus machine-readable reasons.

Ordinary runs allow 30 seconds queued and 90 seconds execution, with a 120-second absolute lifetime from acceptance. Traceroute execution is capped at 60 seconds inside the same lifetime. The agent receives and enforces the remaining budget, not a fresh timeout after delivery. No offline “execute whenever reconnected” behavior is allowed.

Use compare-and-swap transitions and unique `(runId, attemptId, stepId)` result identities. The agent durably journals command acceptance and each step's start intent before any network side effect; retain the journal until expiry plus 24 hours. Repeated delivery cannot start the same step again; dispatch retries reuse its identity. After a crash, a step with persisted intent but no terminal result becomes `execution_error` with reason `outcome_indeterminate`; never automatically reprobe it. This is at-most-once step start, not a promise of exactly-once measurement or guaranteed results through a crash. Cap the journal at 10,000 entries and refuse new runs when full rather than evicting unexpired identities. Once acknowledged/running, an automatic retry cannot choose another collector. User Retry creates a new audited run.

Cancel first persists `cancelRequestedAt`, prevents undispatched steps, then sends best-effort cancellation to the agent, which cancels contexts and bounded child processes. The UI distinguishes “Stop requested” while cancellation is pending. Mark `cancelled` when stopped/acknowledged; a run awaiting acknowledgement until its deadline becomes `expired` with `cancellation_unconfirmed`. An already completed run stays completed. A late result can be stored as historical late evidence but cannot resurrect a cancelled/expired run or overwrite newer health.

Partial results remain visible after failure/cancellation. Agent disconnect, worker restart, Redis outage, missing acknowledgement, and deadline expiry all converge through a sweeper that expires abandoned runs. Authorization/policy checks cannot be bypassed by retry, queue redelivery, or a preexisting idempotency record; a replay after access revocation returns an access error without revealing the old run.

## 9. Probe safety and fixed budgets

| Budget | Default and hard limit |
| --- | --- |
| Active runs | 2 per agent, 4 per site, 20 per organization; excess on-demand starts return 429 |
| Starts | 10 per user/minute, 30 per site/minute, 120 per organization/minute; AI shares these limits |
| Ordinary recipe | Maximum 12 steps, two concurrent network steps, 5 ICMP packets/step, 2-second ICMP timeout, 1,024-byte payload |
| Destination fan-out | At most 4 target addresses/run in one target family (2 addresses per each of 2 external endpoints), plus at most 2 resolver addresses for DNS; no ranges/wildcards; responding traceroute hops are not additional probe targets |
| HTTP | GET/HEAD only, 5-second request deadline, 64 KiB response limit, no body persistence, no credentials/cookies; redirects disabled by default |
| DNS | Diagnostic name ≤253 bytes; at most 2 explicit resolvers, 2-second queries, one retry; no zone transfers |
| Results | 8 KiB sanitized details/step, 128 KiB/run, no raw packet captures or unrestricted stdout |
| Polling UI | Start at 2 seconds, back off to 5 seconds, stop at terminal state; leave/reopen uses durable run ID |

Only validated IPs, hostnames, ports, and saved HTTP target records reach probes. Probe processes use native libraries or argument arrays, never shell interpolation. Validate names, IPv6 zones, lengths, address families, and numeric bounds on both server and agent. Support private network targets only through authorized same-site target/route records; an invented private IP cannot be supplied through the topology action.

Resolve destination names on the selected agent, validate all results against the target policy, and connect to the pinned approved address while retaining TLS server-name verification. Block loopback, unspecified, multicast, broadcast, and cloud/agent metadata-service destinations for arbitrary targets. The sole loopback exception is a typed DNS-resolver step targeting the selected agent's freshly OS-observed local stub at its observed port; bind it to that origin and resolver evidence, never a user/model URL, generic TCP check, or another host's loopback. If safe stub routing cannot be established, return `unsupported_context`. IPv6 link-local next hops are allowed only for the matching observed interface. Proxy use must be an explicit recorded policy; do not inherit a secret-bearing proxy environment silently.

Redirects, if an administrator enables them for a saved target, have maximum two hops and repeat hostname/IP/policy validation per hop with no credential forwarding. HTTP error content is summarized by bounded status/error classifications, not uploaded pages. Protect workers against DNS rebinding, oversized payloads, redirects to internal services, OS argument injection, and result replay as concrete validation requirements.

## 10. Scheduled monitoring

Reuse existing monitor schedules/results where compatible, linked through canonical topology bindings. Never change an existing monitor's target, interval, or alert rule merely because topology discovered it. Reuse requires equivalent organization/site, destination, protocol, configured context, and origin-selection policy. Expose the monitor that supplies an overlay.

Enable baseline monitoring by an authorized site/network policy write or explicit bulk template adoption/activation, with per-site preview of effective version/overrides, collector, destinations, interval, and estimated check volume. Template publication alone leaves running sites on their pinned versions. Bulk apply still validates each site's access and existing execution/MFA/re-arm authority; template ownership grants no execution permission. Default interval is 300 seconds, configurable from 60 to 3,600 seconds, with ±10% jitter. One preferred origin runs per configured routing context and address family; policies initially enable at most two contexts, and additional contexts require an explicit selection. No “one monitor per discovered device” expansion is implicit.

Scheduled work shares concurrency quotas with on-demand work but has a separate fair queue. Deduplicate each `(policy, context, family, scheduledFor)` occurrence; do not overlap the same occurrence or build catch-up bursts after downtime. Missed/budget-skipped executions become collection-gap events and never target failures. Scheduling deadlines expire before the next interval; one site's load cannot starve all others.

A site-bound policy persists when its preferred collector goes offline. A different eligible matching collector may execute a later scheduled occurrence, with a visible origin-change event and new continuity series. Do not mix pre/post-switch latency, route, or failure streaks. If none is eligible, show monitoring unavailable and preserve stale results.

New topology monitoring requires `devices:write` and `devices:execute`, policy authority, applicable site access, and existing MFA/approval requirements. On-demand requires `topology:execute` and `devices:execute`; topology write alone does not authorize probes. Monitoring through virtual nodes must follow the explicit-site contract, not unrestricted legacy asset-less monitor behavior.

## 11. Health assessment and alerts

Use deterministic assessment rules with referenced inputs. A fresh successful required check is healthy for its exact scope; mixed successes/failures or a configured threshold breach are degraded; fresh failed required probes are failed checks; missing, unsupported, or stale required evidence is unknown. Multiple protocols remain independently inspectable even when rolled into a summary.

For external reachability, both independent configured destinations succeeding yields healthy; one succeeding and another failing yields degraded; all actual direct connectivity probes failing from the origin yields failed check (“Outbound checks failed from collector”), not “ISP down.” Resolver failure with successful direct-IP TCP yields “DNS check failed; IP reachability succeeded.” TLS/certificate or HTTP status failure with successful TCP is service-level failure, not gateway loss.

Gateway silence does not worsen an otherwise successful outbound path. A gateway route exists independently of whether the gateway answers. A managed physical port's fresh explicit `operStatus=down` can label that port down; administratively disabled is its own expected-state reason. An inferred membership edge inherits no cable status from endpoint reachability.

Group summaries expose counts of healthy/degraded/failed/unknown and coverage. Do not average percentages or hide unmonitored nodes behind a green group. A port endpoint mismatch (one side up, another down) is disagreement requiring inspection, not proof of which observation is correct.

Default new baseline alert policy: alert after three consecutive complete failed occurrences from the same context/origin, recover after two successes, and apply a five-minute notification cooldown. Origin changes, collection gaps, unsupported steps, and stale results break failure/recovery streaks. Existing monitor alert policies retain their configured semantics. On-demand results do not advance scheduled alert streaks unless an explicit policy requests that behavior.

Deduplicate topology presentation with the existing source alert rather than creating another alert for the same monitor event. A collector-unavailable notification is a monitoring-coverage event; it cannot assert a site outage. Maintenance windows silence notifications through existing mechanisms while retaining measurements, coverage, and visible maintenance state.

## 12. Interface telemetry and connection metrics

Telemetry requires stable canonical interface identities from the main design: device/controller identity, interface identity/epoch, observed ifIndex/name/alias, member/parent relation, address/port mapping evidence, and collection timestamps. ifIndex reuse after reboot or interface replacement creates a new epoch unless corroborated; old samples never migrate based only on a matching label.

Prefer high-capacity octet counters, discontinuity markers, and explicit interface speed; preserve integer precision in transit/storage. The IF-MIB defines 64-bit counters and counter-discontinuity information, which must be used when supported. [RFC 2863](https://www.rfc-editor.org/rfc/rfc2863.html)

The following are Breeze calculation requirements, not claims that current aggregation already implements them:

- Compute rate from two consecutive valid samples of the same identity/epoch/source: `bitsPerSecond = 8 × counterDelta / elapsedSeconds`; retain counter width and integer values as decimal strings/BigInt through subtraction.
- Reject zero/negative elapsed time, duplicate/out-of-order samples, a discontinuity marker change, device reboot, interface replacement, and gaps over three expected polling intervals. First samples and rejected windows are null with a reason, never zero.
- A decreasing 64-bit counter is a reset/invalid interval. A 32-bit wrap is usable only if continuity and known speed/elapsed time allow exactly one feasible modular delta; possible multiple wraps or unknown speed make the interval unavailable. Do not use lifetime counter value or min/max range as a rate.
- Track input/output separately relative to the named endpoint. Full-duplex utilization is per direction (`directionBitsPerSecond / directionCapacity × 100`), never the sum divided by one speed. Unknown or changed capacity within the sample window produces no utilization percentage; a valid byte rate can remain available.
- Retain raw anomalies and flag implausible rates instead of silently capping to 100%. Errors/discards use deltas; percentages require compatible packet denominators and the same window. No denominator means a rate/count with units, not a percentage.
- Polling observes transitions, not every flap. Label flap counts “Observed state changes” with interval/coverage; a gap can miss changes. Unknown admin state or stale operational state cannot be treated as a current fault.
- LAG parent and members are separate entities. Use either reliable parent counters or a complete synchronized member sum, never both. Mark incomplete member coverage. Capacity sums only known active members; standby and unknown members are not silently counted.
- Parallel physical links remain individually selectable. Two endpoint counters are alternative views of the same traffic, never summed as total link traffic; one-sided telemetry is explicitly labeled. Do not infer loss from asynchronous endpoint counter differences.

Default opt-in port polling is 60 seconds, minimum 30, maximum 300. Start with linked infrastructure ports and explicitly selected interfaces, capped at 256 interfaces per collector poll batch, with resumable bounded batches. The enablement preview computes daily sample volume as `enabledPorts × 86,400 / intervalSeconds`, multiplied by the stored series count, and enforces the configured collection quota before saving. Partition samples by sampled date/resolution. Raw telemetry retains 7 days, five-minute summaries 30 days, and hourly summaries 90 days; diagnostic details and collection observations retain 30 days. Aggregate min/max/mean, valid duration/sample count, and gaps; do not fabricate continuous uptime from sparse data.

The new scoped history API supplies units, source/identity epochs, coverage, and at most 1,000 time buckets per series, up to eight series/request and 7 days at raw resolution. Bucketing is server-selected within the requested range and returned explicitly. Every queried interface and graph binding must pass organization/site/read checks. Querying history never triggers a poll.

UniFi metric adapters must distinguish cumulative bytes from reported rates; never copy a field named `txRateBps` into a cumulative byte counter. Validate units against supported controller versions and fixtures before release. Unsupported firmware/fields return unavailable. PoE, signal, VLAN, and wireless overlays ship only after their source endpoints and semantics are implemented and tested.

M3 port activation uses an explicit selection and preview: `POST /topology/sites/:siteId/interface-telemetry/preview`, then a revisioned settings PATCH carrying the preview token. Store portable defaults in the existing template layers, explicit site selections in the site override layer, and compiled interface/source/epoch IDs plus standing authority in site runtime settings. Preview resolves local ifIndex/controller identifiers server-side; callers cannot choose them. Cap 4,096 selected ports/site within the 256 KiB settings limit and dispatch at most 256 per batch. Each existing outbox dispatch intent pins the authorized local-port-to-canonical-interface mapping, expiry and config/effect revision. SNMP commands and UniFi collector configuration consume that mapping; authenticated results must match it. Disable, revoked authority or identity/config drift fences remaining batches and requires fresh preview/re-arm. Reads, template publication and upgrades cannot start polling.

## 13. Incident impact and redundancy

Impact analysis returns two sets with evidence: devices/services with matching measured failures, and potentially affected entities connected through relevant topology. Include graph revision, time window, assumptions, coverage, and reasons. A logical segment membership edge may support a broad possible-impact group but cannot prove a single cable dependency.

Respect cycles, alternate uplinks, LAG members, multiple gateways, routing contexts, and observed route selection. Removing one graph edge does not imply disconnection when another applicable path remains; conversely, a redundant physical edge is not proof of a usable forwarding route. Where forwarding/HA state is unavailable, say “Alternative path exists; availability unverified.”

An upstream-cause suggestion requires fresh corroborating failures, compatible context/timing, and explicit uncertainty. Default correlation window is five minutes, adjustable 1–30 minutes. Mere graph centrality or a high-confidence discovery relationship is insufficient cause evidence. A successful observation from another origin is presented as a potentially location-specific failure, not discarded.

No inferred, stale, incomplete, or AI-proposed topology suppresses, closes, acknowledges, downgrades, or stops evaluating downstream alerts. Initial correlation groups alerts visually and recommends investigation only. Any future suppression capability requires its own explicit specification and policy controls; it is outside this release.

## 14. Optional AI investigation

AI is optional and disabled until the organization's existing AI policy enables it. Layout, discovery, health calculations, monitoring, and diagnostics work without a model. “Explain this” retrieves a bounded evidence snapshot, then asks the model for findings, possible causes, missing data, and recommended next checks with citations.

| Tool | Tier and behavior |
| --- | --- |
| `get_topology` | Tier 1 read: one authorized site/context/revision; bounded node/relationship slice |
| `get_link_evidence` | Tier 1 read: evidence/conflicts/freshness for one authorized relationship |
| `get_link_health` | Tier 1 read: metrics, monitor results, coverage, and actual origins |
| `get_recent_network_changes` | Tier 1 read: bounded time window with existing site checks |
| `get_diagnostic_run` | Tier 1 read: authorized run/steps and current state |
| `diagnose_connectivity` | Tier 3 action: propose then execute one exact fixed recipe through the same diagnostic API/approval path |

Tier 3 execution follows the existing approval and effect-digest mechanism. Classify `diagnose_connectivity` explicitly in `TIER3_SUPERVISED_TOOLS`, not `TIER3_FOUR_EYES_TOOLS`: its accepted operations are bounded fixed observational recipes. Supervised scope retains explicit authorized approval, MFA and effect pinning; it does not grant unattended execution or add this tool to the existing `POLICY_DECIDABLE_TIER3` registry. Approval pins organization, site, subject, chosen origin, routing context, destination configuration/version, recipe version, limits, and expiry. A changed material input invalidates approval. A generic chat instruction, existing read-tool tier, model confidence, or map edit permission cannot bypass execution authority. This feature requires normal explicit approval for each proposed diagnostic. Any future policy grant for unattended execution must be specified and reviewed separately and must preserve the same pinned effect and current-authority checks.

Every factual network claim cites authorized evidence/result IDs with timestamp and scope. Citations open the inspector/history using ordinary access checks. The server verifies referenced IDs came from the scoped retrieved context. Unsupported claims are rendered as hypotheses; an invalid or missing citation cannot create a verified connection, health update, or incident cause.

LLDP/CDP descriptions, DNS names, HTTP errors, hostnames, aliases, manual notes, and controller strings are untrusted data. Serialize them into bounded structured evidence, label their origin, remove control characters, and never treat their text as tool instructions. Tool names/arguments and targets are server validated regardless of model output. A hostile device name cannot expand scope or request secrets.

Send only the selected subgraph and relevant recent results. Exclude credentials, SNMP communities, API keys, cookies, authentication headers, private keys, raw configuration, packet payloads, and HTTP bodies. Replace addresses/hostnames with stable per-investigation aliases by default; retain only network facts needed for reasoning. Actual values require the organization's explicit AI data-sharing policy and existing provider governance. Logs and traces apply the same redaction.

AI limits: maximum 150 nodes, 250 relationships, 100 observations, 30 diagnostic steps, and 24 hours of events per initial evidence slice; maximum 20,000 input tokens, 2,000 output tokens, six read-tool calls and one proposed diagnostic run per investigation. Maximum three concurrent investigations/organization, 10/user/hour, and 100/organization/day; configurable lower limits and the existing monetary budget also apply. Exceeding any limit produces a useful bounded summary and a narrowing suggestion, not hidden follow-up calls.

Topology investigations buffer raw model output server-side under the output budget. Existing SDK and chat-only transports publish only vetted progress/tool state until the complete structured answer passes schema, citation and current-access checks; no raw text delta enters the client event bus, replay or visible history. Invalid/cancelled/expired output is discarded rather than shown as partial prose. Reconnect, cache and history reads reauthorize before returning validated content.

No model calls occur on map refresh. Reuse a sanitized answer for at most five minutes only when graph/evidence revisions, effective permission scope, prompt/version, and question match. Freshness changes, new results, revocation, a site move, or a changed selection invalidate current use. Validate current inventory bindings and source epochs on cache hits, follow-up reads and final publication even while graph publication or cache eviction is delayed. A move fences in-flight explanations and pending approved diagnostics; a new-site investigation requires a fresh authorized snapshot. Retained original-site observations, runs and completed answers remain historical and require original-site access; do not delete or move that history to invalidate a current cache. Cache and usage accounting are tenant scoped; a model outage or exhausted budget leaves deterministic diagnostics usable.

AI-proposed attachments are hypotheses with cited candidates/conflicts. Acceptance creates a manual assertion through the normal topology mutation API and audit trail; it cannot forge an observed discovery source. AI cannot assign canvas coordinates as authoritative state, suppress alerts, schedule recurring checks, or make remediation changes through these tools.

## 15. Operational visibility

Expose aggregate dispatch latency, active/queued runs, expiry/cancellation rates, per-recipe duration, collector unavailability, budget skips, duplicate/late/rejected results, route-attribution coverage, valid metric-sample ratio, and AI token/cost/cache usage. Metric labels contain recipe/status/platform only, never device names, addresses, arbitrary site IDs, or secrets. Detailed tenant-scoped logs carry correlation IDs and sanitized reason codes.

Alert operators on sweeper backlog or an increasing orphan-run count; diagnostics cannot depend on a healthy browser tab to finish or expire. Keep API responses bounded and return a run ID without waiting for network tests. The inspector displays queued age, execution deadline, completed step count, and partial results. A rolled-back API/agent capability or disabled feature stops new dispatch and leaves historical results readable.

## 16. Acceptance and release gates

1. **Low-discovery network:** pass the executable [baseline-no-management scenario](2026-09-15-intelligent-network-topology-design.md#12-acceptance-matrix-and-verification). Routes/interfaces alone provide the inspector and authorize only the explicit route-derived same-site gateway recipe. Unconfigured DNS/outbound targets return `target_not_configured` with zero external probes. A separate fixture variant explicitly configures the known-answer DNS target and two mocked HTTPS destinations before expecting probe results. Unknown gateway, isolated network, offline agent, and no-agent inventory all render usable explicit states; no SNMP/LLDP data is required.
2. **Truthful methods:** gateway ICMP refusal with successful HTTPS stays outbound healthy; silent TCP fallback is impossible; successful DNS with failed TLS identifies TLS separately; single-destination coverage is partial.
3. **Attribution:** dual-stack, multiple gateways, VPN/proxy, split DNS, roaming origin, IPv6 link-local, and mid-run route changes retain correct scope or explicitly unknown attribution.
4. **No side effects from reads:** opening/refreshing/selecting the map and fetching graph/history/AI read tools enqueue zero commands, polls, schedules, or model calls.
5. **Authorization:** unauthenticated, missing execute permission, wrong organization, wrong site, empty site allowlist, inaccessible metric binding, ephemeral/foreign collector, moved origin, and revoked queued authority all fail closed without dispatch or disclosure.
6. **Lifecycle:** duplicate submissions/results, mismatched digest/origin, worker restart, queue retry, offline collector, deadline, cancellation races, and late results never duplicate probes or resurrect terminal runs; partial evidence remains reviewable.
7. **Target safety:** malformed addresses/names, link-local without scope, rebinding, metadata/unauthorized loopback targets, forbidden redirect, shell metacharacters, oversized output, and unapproved endpoint overrides fail validation. A freshly OS-observed local DNS stub succeeds only through the typed, origin-bound resolver exception; the same address supplied as HTTP/TCP or another origin's target is rejected.
8. **Scheduling:** jitter, budgets, same-site failover, context mismatch, no overlap, no catch-up burst, skipped checks, origin changes, and disabled policy preserve meaningful freshness and alert streaks. Template reads/publication dispatch nothing; pinned version changes across 200 sites are previewed explicitly, preserve site overrides, and cannot bypass per-site execution/MFA/re-arm checks.
9. **Counters:** 64-bit precision, first sample, wrap/reset, discontinuity, out-of-order/gaps, speed change, impossible rate, ifIndex reuse, LAG membership change, one-sided data, and independent direction tests prevent fabricated traffic or utilization.
10. **Impact:** cycles, active/standby alternatives, parallel cables, partial LAG, stale links, conflicting observations, and inferred membership never cause unsupported definite impact or automatic downstream suppression.
11. **AI:** hostile device strings cannot execute instructions; inaccessible citations are rejected; unsupported explanations remain hypotheses; policy/digest changes invalidate approvals; cache/budget/provider failure preserves core operation.
12. **Quality gates:** meaningful API/worker tests, real DB forced-RLS and cross-site integration tests, Go table-driven tests with `-race` and mocked network I/O, web action-feedback tests, and `data-testid` E2E diagnostics flows pass before feature enablement.

Release order: existing scoped monitor/alert overlays and fixed baseline diagnostics first; scheduled baseline policy and production lifecycle/security tests next; reliable interface history/metrics then routed traces and impact grouping; optional AI last. No phase advertises telemetry or diagnoses unavailable in its actual collector versions. Expose version/capability coverage and disable unavailable actions with a reason during rolling upgrades.
