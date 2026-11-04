---
status: draft  # awaiting Gate A
issue: LanternOps/breeze#11023
related: [10088, 10100, 4618, 6758]
builds_on:
  - docs/superpowers/specs/security/2026-10-25-network-isolation-containment-spec.md
  - docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
  - docs/superpowers/specs/monitoring/2026-09-08-monitoring-automation-unification-design.md
  - docs/superpowers/specs/monitoring/2026-10-29-org-subject-alerts-design.md
  - docs/superpowers/specs/monitoring/2026-09-15-intelligent-network-topology-design.md
---

# Network/endpoint correlation: budgeted syslog ingestion, correlated findings, approved response

Stage-2 spec for #11023. Drafted against `origin/main` at `36f9d9ca53`. Paths are relative to the repo root. Anything not confirmed in code is marked **(assumption)**. No customer names, hostnames or addresses appear here.

## 1. Problem

A design-partner MSP trialled a self-hosted SIEM and collected roughly 100 GB of logs in two to three weeks. They could not act on any of it. What they want from Breeze is narrower and more useful. Breeze should:

1. Take in network syslog from firewalls, switches and UniFi.
2. Tie each network event to the endpoint the agent already knows: device, user, process and time.
3. Let the AI explain what is happening.
4. Offer a response, with approval and opt-in only. Two responses are in view: isolate the device, or shut the switch port that is generating abusive traffic.

Breeze has most of the pieces. It has none of the ingestion, and none of the join:

- **No network log ingestion exists.** No agent or API code listens on 514/UDP or TCP. No RFC 3164/5424 parser exists, and there is no NetFlow, sFlow or IPFIX receiver. The only listeners in `agent/` are ICMP (`agent/internal/discovery/ping.go`, `agent/internal/networkdiagnostic/`) and the session-broker unix socket. Syslog appears only as future work, in `docs/superpowers/specs/monitoring/2026-02-21-event-log-hierarchy-forwarding-design.md` and in the UniFi spec's "Phase 3 CEF syslog" note (`docs/superpowers/specs/integrations/2026-06-28-unifi-network-integration-design.md:237`). The `journald` reader (`agent/internal/collectors/eventlogs_journal.go`) reads only the local host.
- **Most of the identity data exists, but nothing joins it at a point in time.**
  - IP history is in `device_ip_history` (`apps/api/src/db/schema/devices.ts:526`). Its columns are first/last seen and assignment type, inactive rows are pruned after 90 days (`jobs/ipHistoryRetention.ts`), and `get_ip_history` already answers "who had this IP at T" (`services/aiToolsNetwork.ts:680`).
  - MACs are in `device_network`, `discovered_assets.mac_address` (linked through `linked_device_id`), `unifi_clients` (MAC, IP, `uplink_port_idx`, VLAN, SSID; current state only) and FDB `attachment` relationships in `topology_relationships` (`db/schema/topology.ts:130`).
  - Logged-on users are in `device_sessions` (`db/schema/sessions.ts:24`, `login_at` and `logout_at`).
  - Processes and sockets are in `device_connections` (`devices.ts:813`), a 15-minute snapshot that is replaced wholesale and holds no history.
  - The DNS pipeline already shows what goes wrong without a time-aware join: `jobs/dnsSyncJob.ts:381-402` attributes an event by matching the source IP against **current** `device_network`, not against the IP history at the time of the event.
- **No switch-port write path exists.**
  - UniFi is GET-only in both places. The API side is the Site Manager cloud client (`services/unifi/unifiClient.ts`). The agent side is the local-controller client (`agent/internal/unifi/client.go`, which only issues `MethodGet`).
  - SNMP is read-only: `SNMPClient` exposes Get, GetMulti, Walk, BulkWalk and WalkBounded (`agent/internal/snmppoll/client.go:120-303`). `ifAdminStatus` is polled (`interface_poll.go:41`) but never set.
- **Device isolation exists. Automated isolation was deliberately deferred.** Feature #10088 is built: the episode table is `device_network_isolations`, the service is `services/networkIsolation/service.ts`, and the Windows and macOS isolators are done (Linux is W10, still open). The policy feature `containment` is #10100, part 1 merged. The isolation spec's §5 puts *"automated isolation from alert/EDR rules"* out of scope. Its OD15 denies isolation to unattended MCP principals and says to *"revisit with the automation wave"*. **This spec is that automation wave.** It must not quietly reopen those decisions, so §3.7 and OD5 deal with them head on.

The hard requirement from the issue: **this must not become a SIEM bill.** The design therefore treats ingestion as *reduce, attribute, detect, discard*, not *store and search*.

## 2. Users & scope

**Who it is for.**
- MSP technicians and security staff, at partner scope, working across many customer orgs.
- Org-scoped admins (a customer's own IT), for their own org's networks.
- The AI assistant and Wisp, which read findings and propose responses under approval.

**Tenancy axis, stated per object:**

| Object | Axis | Why |
|---|---|---|
| Collection policy: listener on/off, port, parser profiles, drop rules, per-source rate limit | **Partner-wide first**: config-policy feature `network_log_collection` | MSPs run the same firewall vendors across all their customers. It is assigned to collector devices like any other policy. |
| Budget and retention (rows/day, bytes/day, retention days per tier) | **Partner default → org override**, clamped by a platform ceiling (env) and, when hosted, by an entitlement limit | Volume and retention are an org-level storage concept, not per-device. See OD3. |
| Log source: a firewall or switch that sends syslog | **Org** (`org_id NOT NULL`, justified): a physical sender on one customer's network | Precedent: `snmp_devices`, `unifi_collectors` |
| Network events, rollups, findings, network containment episodes | **Org** (`org_id NOT NULL`): facts about one org's network | The same justification as `device_network_isolations` |
| Detector tuning (thresholds, enable/disable per detector) and protected ports | **Partner default → org override** in settings, the same resolver as budget | Cross-source detectors need one deterministic answer per org (OD7) |

**Who may respond.**
- **Device isolation** is unchanged: the guards in §2 of the isolation spec (interactive session, `devices:execute`, `requireMfa()`, `execute_containment` tier 3 supervised, `release_containment` four-eyes).
- **Switch-port disable** is new. It mirrors isolation, with a new grant `TOPOLOGY_PORT_CONTROL` (`topology:port_control`) in `packages/shared/src/constants/permissions.ts`, next to the existing `topology:read|write|execute` (line 40). It is a separate grant so an MSP can hand out topology diagnostics without the power to cut ports, following the `DEVICES_RECOVER_AGENT` precedent at line 25. Reading network logs and findings uses `topology:read`, and managing sources uses `topology:write`. It requires an interactive session and MFA. The AI tool `set_network_containment` is tier 3: apply is supervised, and restore is four-eyes when the AI asks for it (OD6). UniFi client block (OD10) uses the same grant and tool.
- **API keys** can do neither in v1 (`requireInteractiveSession()`). Unattended MCP principals are denied both, by name, the way `isNetworkIsolationCommand` is denied today (`routes/mcpServer.ts:1546,2230`).

**Hosted and self-host.** Both. Hosted ceilings come from the entitlement registry (`packages/shared/src/entitlements/registry.ts`). Self-host ceilings come from env, and self-hosters may raise them.

**Platforms.** The syslog listener runs on any agent OS that is designated as a collector (Windows, macOS, Linux). Switch-port actions need either a UniFi local controller reachable from a collector agent, or an SNMPv3 device with write access.

**In scope:**
- An agent-side syslog listener with local reduction.
- Parsers for a small set of firewall and switch vendors, plus a generic parser.
- Network events, rollups and findings, with hard budgets.
- Time-aware identity resolution.
- Deterministic detectors that join endpoint telemetry.
- Findings as alerts.
- AI read tools.
- A network-side containment action with its episode table, guards and auto-restore: SNMP port disable, plus UniFi client block and port disable if the lab gate passes (OD10).
- Wiring both responses through action intents and Flows.
- Console surfaces.

**Out of scope:** §5.

## 3. Proposed design

### 3.1 Principles

1. **Reduce at the edge.** The collector agent parses, classifies, drops and aggregates *before* anything leaves the LAN. Breeze stores **classified events**, **rollups** and **findings**. It never stores a raw syslog firehose (OD1).
2. **Budgets are hard and fail closed.** Every byte that enters the database has already passed a per-collector, per-org and per-day budget. Crossing a cap degrades to rollup-only mode. It never results in unbounded writes. The budget is an atomic Postgres reservation in the ingest transaction, so no outage of a side store can wave writes through. That is a deliberate departure from `checkAndConsumeIngestQuota`, which is Redis-based and fails open (`services/ingestQuota.ts`).
3. **Retention is partition drops, not row deletes.** Events and rollups are partitioned by retention class and then by day or month, and expire by `DROP PARTITION` (§3.3). This follows the `metric_rollups` and `topology_interface_samples` precedents (`migrations/2026-11-10-130000-metric-rollups-bucket-partitions.sql`, `services/metricRollupRetention.ts`). Row-delete retention on a GIN-indexed table is exactly the cost profile of `device_event_logs` (`db/schema/eventLogs.ts:39-45`), and this design avoids it.
4. **Attribute once, at ingest, with provenance.** Each event is stamped with `device_id`, how it was matched (`ip_history`, `mac`, `unifi_client`, `fdb`, `none`), and how confident the match is. The same resolver later fixes DNS attribution.
5. **Detect deterministically. Explain with AI.** Detectors are cheap SQL or worker rules over rollups and events. The AI is never on the ingest or detection hot path. It reads findings and evidence on demand or through `ai_triage`, under existing AI budgets.
6. **Every response is an approved action on an episode row.** No response is issued as a bare command. Isolation keeps its own episode table. Network-side containment (port disable, client block) gets one modelled on it, with TTL auto-restore, generation binding, conditional restore and verification.

### 3.2 Ingestion path

```
firewall / switch / UniFi gateway
   │ syslog UDP/TCP, or TLS (RFC 5425), on the LAN
   ▼
collector agent → breeze-netlog (unprivileged child process, new; OD11)
   listener → frame/conn limits → per-source token bucket → parser profile → classifier
   → drop rules → 60 s aggregation (bounded keys) → local budget mirror → spool (bounded)
   │ IPC to the agent → HTTPS batch (gzip, batch_id) every 30 s or 512 KB
   ▼
POST /agents/network-events (apps/api/src/routes/agents/networkEvents.ts, new)
   agentAuth (agent org DB context) → admission → batch-id dedupe
   → budget reservation (Postgres, atomic, fail-closed) → identity resolver
   → INSERT network_events (partitioned) + UPSERT rollups, in the same transaction
   │ after commit: enqueue detector tick (BullMQ `network-detect`, coalesced per org)
   ▼
network-detect worker → network_findings → createSourcedAlert(...) → alert.triggered
   → (opt-in) Flow → tier-3 step parks as action intent → human approves → episode
```

**Why the listener runs on a LAN collector agent and not on the API.**
- A public cloud listener would put an internet-facing UDP/TCP port on the API.
- NAT'd senders would need customer firewall rules to reach it.
- Every customer's raw stream would cross the internet before any reduction happens.

Authenticated TLS syslog to a cloud endpoint is possible (RFC 5425), so this is a cost and exposure choice, not a claim that syslog cannot be secured. A collector on the customer LAN sits next to the senders already, and reduces before anything leaves. That is how UniFi local collection (`unifi_collectors.collector_device_id`) and SNMP polling (`agent/internal/snmppoll/`) already work.

**The listener parses hostile input, so it does not run inside the SYSTEM/root agent process (OD11).**
- The agent spawns `breeze-netlog` as a separate low-privilege process. On Linux and macOS it binds 514 and then drops to an unprivileged user. On Windows it runs under a restricted service SID **(assumption: the exact mechanism is chosen in the plan)**.
- It talks to the agent over a local IPC channel, following the helper/session-broker pattern.
- A parser crash or exploit stays out of the process that holds the device credential, the UniFi key and the SNMP credentials.

**Collector (`agent/internal/netlog/` + `cmd/breeze-netlog`):**
- **Transports and hard resource limits:**
  - UDP and TCP (octet-counting and LF framing), plus optional TLS.
  - Messages over 8 KB are truncated, then counted.
  - At most 64 concurrent TCP/TLS connections, with a 5-minute idle timeout.
  - No decompression of any payload.
  - At most 20k open aggregation keys per minute. Overflow folds into an `(source, category, overflow)` key.
  - Process RSS cap of 256 MB, with self-restart above it.
  - The listener binds LAN interfaces only, never an interface with a public address. Its default port is 514, configurable.
- **Sender trust model.** UDP source addresses are spoofable, and a sender allowlist by IP only cuts noise; it is not authentication.
  - Every source has a `trust` of `udp_unauthenticated`, `tcp_unauthenticated` or `tls_pinned`. `tls_pinned` means the collector presents a per-collector certificate *and* the sender's client certificate or fingerprint is pinned on the source, where the vendor supports it.
  - Datagrams from unregistered IPs are counted and dropped. An "unknown sender seen" summary goes up hourly so the console can offer "add as source".
  - **Unauthenticated evidence cannot, on its own, produce a suggested response** (§3.5): it alerts, and a response needs corroboration from an independent channel.
- **Token buckets.** Each source defaults to 200 messages/s with a burst of 2000. The collector total is 2000 messages/s. Overflow is counted and never queued.
- **Parser profiles** (Go, table-driven, fuzzed): `generic_rfc5424`, `generic_rfc3164`, `unifi` (gateway and switch, including CEF), `pfsense_opnsense` (filterlog), `fortigate` (key=value), `sonicwall`, `cisco_ios`. A profile maps a message to `{category, action, src/dst ip:port, proto, mac, rule, user?, bytes?, severity}` or to `unclassified` (OD2).
- **Categories** (closed set): `fw_deny`, `fw_allow`, `ips_alert`, `auth_fail`, `auth_success`, `vpn_session`, `dhcp_lease`, `port_link`, `mac_move`, `stp_change`, `wifi_assoc`, `config_change`, `system`, `unclassified`.
- **Drop rules** (from policy; defaults shown):
  - `fw_allow` per-connection lines are never sent as events, only as rollups.
  - `unclassified` lines are dropped except a 1% sample, capped at 100 per hour per source.
  - `system` lines below warning are dropped.
- **Aggregation.** The window is 60 s, keyed on `(source, category, action, src_ip, dst_ip, dst_port, proto, rule)`. Each key becomes one event carrying `count`, `first_ts`, `last_ts`, `bytes_out` and `bytes_in` when the vendor provides them.
- **Rollup-only mode.** When the server answers `rollup_only` (§3.3), the collector stops sending events. Each minute it sends one summary per `(source, category, action, src_ip)` carrying:
  - `count` and `bytes`;
  - **distinct-destination and distinct-port counts**, as exact small sets capped at 64 entries and then as a HyperLogLog sketch.

  This keeps the fan-out, scan and volume detectors working on the summaries. A detector that needs more than the summary marks its findings `degraded: true` rather than going silent (§3.5).
- **Spool.** When the server is unreachable, batches spool to disk, capped at 50 MB and 24 h, oldest dropped first. Every batch carries a `batch_id` (UUIDv7), so a retry after a lost response is deduplicated server-side and not double-counted.

**Agent wiring.**
- `network_log_settings` is a new heartbeat config block, delivered like `event_log_settings` (`routes/agents/heartbeat.ts:2927,3127` → `agent/internal/heartbeat/heartbeat.go:3981`).
- Only devices that are the *designated collector* of a site with at least one source, and whose `network_log_collection` policy resolves `listener.enabled=true`, start `breeze-netlog`.
- `NETLOG_MIN_AGENT_VERSION` lives in `@breeze/shared` (pattern: `FORCE_REBOOT_MIN_AGENT_VERSION`).

**Server ingest route `POST /agents/network-events`:**
1. **Auth and rate.** `agentAuth`, then admission (`middleware/agentAdmission.ts`), then the per-org agent rate limit (`services/agentOrgRateLimit.ts`).
2. **DB context.** The route runs in the **agent's own org DB context** that `agentAuth` establishes (`currentOrgId` = the device's org). It **never** uses `withSystemDbAccessContext`, which is unrestricted (`apps/api/src/db/index.ts:243`) and cannot be "scoped to an org". RLS is what keeps a collector from writing another org's rows.
3. **Ownership.** The authenticated device must be the `collector_device_id` of every `source_id` in the batch. Otherwise the route returns 403 and rejects the whole batch.
4. **Validation.** Strict Zod. `message` is at most 1024 B, `fields` at most 2 KB and 32 keys. A batch holds at most 5000 rows, and the body is capped at 1 MB.
5. **Dedupe.** `INSERT INTO network_log_ingest_batches (org_id, collector_device_id, batch_id) ON CONFLICT DO NOTHING`. A conflict means the batch was already applied, and the route returns the stored outcome.
6. **Budget reservation (§3.3)**, in the same transaction as the insert. Exhausted → `rollup_only` (rollup rows are reserved against their own cap). Any failure to reserve aborts the transaction.
7. **Identity resolution** (§3.4), batched per request.
8. **Write.** Insert events and upsert rollups in that same transaction. Commit, then return `{ mode, remaining }`.
9. **Detection.** A coalesced `network-detect` job for the org, debounced to 30 s.

### 3.3 Budgets and retention: the "not a SIEM bill" contract

Three layers. A lower layer can only *tighten* what the layer above allows.

| Layer | Who sets it | Knobs |
|---|---|---|
| **Platform ceiling** | env (`NETLOG_*`). Hosted: ops. Self-host: the operator, and may raise. | Maximum event rows and bytes per org per day, rollup rows per org per day, finding opens per org per day, retention class set, events/s per collector |
| **Entitlement limit** (hosted) | `partner_entitlements.limits` for a new key `network_log_correlation` (registry `packages/shared/src/entitlements/registry.ts`) | Per-plan maxima for the same knobs. `requireEntitlement` gates the feature and fails closed (`middleware/entitlement.ts`). |
| **Partner default → org override** | Settings (OD3) | Caps and retention class, each clamped to min(entitlement, ceiling) |

**The budget is enforced in Postgres, not Redis.**
- `checkAndConsumeIngestQuota` (`services/ingestQuota.ts`) is the wrong base for a hard cap. It fails open by design on a missing client, a null `exec()` and any thrown error (lines 67-70, 86-87, 97-99), and returns `allowed: true` in all three cases. A wrapper cannot tell "allowed" from "Redis is down".
- It also consumes the budget before deciding, and is not retry-idempotent. (It already refuses the batch that crosses the cap, at line 93; the first draft of this spec was wrong to say it admits it.)
- Instead, a small table `network_log_daily_usage (org_id, usage_day, event_rows, event_bytes, rollup_rows, findings_opened, mode)` is reserved atomically **in the ingest transaction**:

  ```sql
  INSERT … ON CONFLICT (org_id, usage_day) DO UPDATE
    SET event_rows = network_log_daily_usage.event_rows + $rows, event_bytes = … + $bytes
    WHERE network_log_daily_usage.event_rows + $rows <= $capRows
      AND network_log_daily_usage.event_bytes + $bytes <= $capBytes
  RETURNING …
  ```

  No row returned means exhausted, so the org flips to `mode = 'rollup_only'` for the day.
- The same mechanism covers each collector (`network_log_collector_daily_usage`, default 100k rows/day) and rollup rows.
- Because the reservation and the insert commit or roll back together, the counter is durable across Redis flushes and API restarts. The batch-id ledger (§3.2 step 5) makes retries idempotent.
- With one collector per site batching every 30 s, the update rate is a few rows per org per minute, so hot-row contention is negligible.
- **Finding opens** reserve against `findings_opened`, default 200 per org per day. Resolved and suppressed findings still count toward the findings-tier row total, so open/resolve churn cannot grow the tier without bound.

**Retention: fixed classes, so expiry is always a partition drop (OD4).**
- An org does not pick an arbitrary number of days. It picks a **retention class** for events (3, 7, 14 or 30 days) and one for rollups (30, 90 or 395 days).
- `network_events` is `PARTITION BY LIST (retention_class)` → `PARTITION BY RANGE (occurred_at)` daily. `network_event_rollups` is LIST → RANGE monthly. The precedent is `topology_interface_samples` (LIST by resolution, then RANGE: `migrations/2026-11-06-210000-topology-interface-samples.sql:62-69`).
- Expiry drops whole leaf partitions per class. **No retention row-deletes at all**, which avoids `device_event_logs`' GIN-plus-batched-delete cost profile (`db/schema/eventLogs.ts:39-45`, `jobs/eventLogRetention.ts`).
- A class change applies to new rows only. Old rows age out under the class they were written with. The console says so.
- The class is stamped on the row at ingest, from the budget resolver.

**Defaults (OD4; every number is re-measured in W2 against lab senders, including index and WAL overhead, before it is frozen):**

| Tier | Contents | Default class | Max class | Default daily cap per org | Ceiling |
|---|---|---|---|---|---|
| Events | classified, aggregated events | **7 days** | 30 days | **250k rows / 150 MB** | 2M rows / 1 GiB |
| Rollups | per-hour summaries per `(source, category, action, src device-or-ip, dst_port)` with distinct-count sketches and bytes | **90 days** | 395 days | **20k rows** (overflow folds into an `other` key) | 200k rows |
| Findings | detector output and evidence snapshot | 365 days (row-deleted; low volume) | 730 days | **200 opens**; at most 500 open | — |

Per collector: 100k event rows/day by default (ceiling 1M), so one chatty firewall cannot spend the whole org's budget.

**Sizing, worst case per org at defaults:**
- Events: about 350 B/row with indexes **(assumption, measured in W2)** × 250k rows × 7 days ≈ 0.6 GB.
- Rollups: 20k × 90 days = 1.8M rows ≈ 0.5 GB.

That totals about 1.1 GB. The partner's SIEM trial saw about 5–7 GB/day, and most orgs will sit well under the caps because allow-lines never leave the LAN.

**Visibility, so a budget never runs silent:**
- A budget meter on the org network-logs page shows today's usage per tier, the mode, and drops by reason: `rate_limited`, `dropped_by_rule`, `unknown_sender`, `oversize`, `aggregation_overflow`, `rollup_only`.
- Alerts fire at 80% and 100%: one sourced alert per org per day, with an org-subject owner once #10725 lands and the `topology_site` owner of the collector's site until then.
- Collector counters appear on the collector's device page.

**Partition maintenance (the `metric_rollups` trap).**
- `metric_rollups` partition maintenance silently never ran in production: `breeze_app` cannot `CREATE TABLE … PARTITION OF` a table it does not own (`migrations/2026-08-05-metric-rollup-partition-maintenance-privileges.sql:3-16`).
- This feature ships privileged `SECURITY DEFINER` create/drop functions from day one, following that migration.
- **Every leaf partition explicitly gets `ENABLE` and `FORCE ROW LEVEL SECURITY` plus the same policies at creation**, following the helper in `migrations/2026-11-10-130000-metric-rollups-bucket-partitions.sql:88-115`. Parent policies do **not** protect a direct query against a child.
- A W1 integration test, run *as `breeze_app`*, proves three things:
  - the job creates and drops leaves;
  - a new leaf is RLS-forced;
  - a cross-org read of a leaf queried directly returns nothing.

**Indexes.**
- Btree on each leaf: `(org_id, occurred_at)`; `(org_id, device_id, occurred_at)` where `device_id IS NOT NULL`; `(org_id, src_ip, occurred_at)`; `(org_id, source_id, occurred_at)`.
- **No GIN or trigram index on `message`, and no free-text search.** Search is structured filters. Free-text search is the line where this becomes a SIEM (§5).

### 3.4 Identity resolution (correlation keys)

New service `services/networkIdentity/resolve.ts`:

```ts
resolveNetworkIdentity(orgId, { ip?, mac?, sourceId, at: Date })
  → { deviceId | null, method, confidence: 'high'|'medium'|'low'|'ambiguous',
      discoveredAssetId?, switchPort?: { kind:'unifi'|'snmp', deviceRef, port, identity }, username? }
```

**Identity is observational, not authoritative lease history.** The rules follow from what the tables actually record:

- `device_ip_history` rows are opened and closed by the agent's own interface reports (`services/deviceIpHistory.ts:210-225` closes explicit removals). An `is_active` row can be stale indefinitely when an agent goes offline. The resolver therefore **never** treats `is_active` as "still holds the IP". A match requires `first_seen <= T` **and** `last_seen >= T - 30 min`, which is a bounded observation interval.
- `device_ip_history` has **no site or realm** (`db/schema/devices.ts:526`). Joining through today's `devices.site_id` would rewrite yesterday's attribution after a device moves sites. **W1 adds `site_id` to `device_ip_history`**, stamped at observation from the device's site at that moment. That is a column on an org-cascade table, so it needs an export-policy classification (`included`). The resolver only matches rows whose `site_id` equals the source's site.
- Each source has a **realm**: its site, plus an optional VLAN/VRF list on the source. Overlapping RFC 1918 space across sites or realms the resolver cannot distinguish stays **unattributed**. It never picks one.
- **Every method has an ambiguity rule.** More than one candidate gives `confidence: 'ambiguous'`, no `device_id` stamped, and the candidates kept in the event's `fields`.

Resolution order, first unambiguous hit wins:
1. **MAC.** `device_network.mac_address`, then `discovered_assets.mac_address` → `linked_device_id`, then `unifi_clients.mac` (`last_seen_at` within 30 min).
2. **IP at T.** `device_ip_history` under the rules above.
3. **UniFi client IP.** `unifi_clients.ip` within 30 min of `last_seen_at`. Port and VLAN fields are **not populated by the agent today** (`agent/internal/unifi/client.go:105`); W2 adds them.
4. **Unattributed.** `discovered_assets` by IP and site gives `discoveredAssetId`, with `device_id` null.

**Switch port.** The newest *fresh* FDB `attachment` relationship for the MAC (`topology_relationships`, evidence `fdb`, within `topology_observations.fresh_until`), or the UniFi uplink fields once populated. The port carries its **canonical interface identity**: UUID, epoch, ifIndex, ifName and ifPhysAddress, the binding `topology_interface_poll` already uses against ifIndex reuse (`agent/internal/snmppoll/interface_poll.go:15-25`).

**User.** The `device_sessions` row for the resolved device with `login_at <= T AND (logout_at IS NULL OR logout_at >= T)`, and only when exactly one interactive session matches.

**Mechanics.** The resolver is batched (one query per key type per batch) and memoised per request.

**DNS fix (small, same wave).** `jobs/dnsSyncJob.ts:381-402` attributes by current `device_network`. It switches to `resolveNetworkIdentity(..., at: event.timestamp)`. This is the resolver's second consumer.

### 3.5 Detectors and findings

A `network-detect` BullMQ worker runs per org: coalesced on ingest, and also every 5 minutes as a floor. It evaluates a fixed registry of detectors (`services/networkDetect/detectors/*.ts`). Each detector is a pure function over a bounded window of rollups and events and returns finding candidates. v1 detectors:

| Key | Signal (network) | Endpoint join (evidence) |
|---|---|---|
| `lateral_fanout` | one internal source denied or allowed to at least N distinct internal hosts on 445/135/3389/22/5985 within 10 min (events, or rollup distinct-dst sketches in rollup-only mode) | **latest observed** `device_connections` for that device and port (process and pid). The table is a 15-minute replace-all snapshot (`routes/agents/connections.ts:153`), so this is labelled "latest observed context", never "process at T"; `device_event_logs` 4625/4624 type 3 around T, EDR incidents (`edr_incidents`) for the device |
| `port_scan` | one source hits at least N distinct dst ports or hosts on fw_deny within 5 min | same, plus whether the process is a known scanner (software inventory) |
| `auth_bruteforce` | at least N `auth_fail` from one source against VPN/firewall/switch admin within 10 min | whether the source resolves to a managed device and whose session it is; whether an external IP also appears in DNS security events |
| `ips_hit` | any `ips_alert` at high or critical severity from the vendor | the device's latest observed processes and connections; EDR state |
| `exfil_volume` | a rollup's outbound byte count from one device exceeds its 14-day p99 × 5 **(only when the parser provides bytes)** | `device_connections` remote endpoints; DNS events |
| `rogue_dhcp` / `mac_flap` | a DHCP offer from a non-registered server; a MAC seen on more than one port within 60 s | topology adjacency; link to `network_change_events` |
| `blocked_c2` | a fw_deny or DNS block to a destination listed in DNS security threat categories | device, and latest observed process holding a connection to that destination |

Detectors run **per org, over all of the org's sources**. A cross-source detector such as `mac_flap` needs a deterministic configuration, not one that depends on which collector's policy resolved. Thresholds and enable flags therefore resolve per org through the same partner-default → org-override settings resolver as the budget (OD7; the quorum moved this from per-collector policy). A detector whose inputs were reduced by rollup-only mode or aggregation overflow marks its finding `degraded: true` and says which inputs were missing. The registry is code, not user-authored rules, in v1 (§5). Existing `log_correlation_rules` / `log_correlations` (`db/schema/eventLogs.ts:83-138`) are org-only regex rules over Windows event text. Their shape does not fit (no subject, no evidence model, no device-less findings), so this spec neither extends nor replaces them.

**Finding model (`network_findings`).**
- Fields: `detector_key`; subject (`device_id`, or `subject_ip` with `discovered_asset_id`); `site_id`; `switch_port` reference; `first_seen` / `last_seen`; `occurrences`; `severity`.
- `evidence` (jsonb, capped at 16 KB): event ids, rollup counts, plus a *snapshot* of the joined endpoint facts, so the finding outlives the 7-day events and the 15-minute `device_connections` snapshot.
- `status`: `open | acknowledged | resolved | suppressed`; `dedupe_key`; `alert_id`.
- `suggested_response` (jsonb): `{ kind: 'isolate_device' | 'disable_switch_port' | 'block_client' | 'none', target, rationale, corroboration }`.
- **Corroboration rule.** A finding whose network evidence comes only from `udp_unauthenticated` or `tcp_unauthenticated` sources may alert, but its `suggested_response` is `none` unless an **independent channel** corroborates it:
  - endpoint telemetry from the attributed device's own agent (a matching connection, logon event or EDR incident);
  - an SNMP or UniFi observation (FDB, client table);
  - a `tls_pinned` source.

  The corroboration is recorded in the finding. This stops a spoofed datagram from manufacturing a one-click shutdown of someone else's port.
- Open findings are deduplicated on `(org_id, detector_key, dedupe_key)`. A repeat extends `last_seen` and `occurrences`.

**Findings become alerts.** `createSourcedAlert` (`services/alertService.ts:443`):
- Device-attributed findings use owner kind `device`.
- Unattributed ones use `topology_site`, following `services/topology/monitoringAlerts.ts` (provenance plus an origin-independent source key).

So all the existing alert machinery applies: notifications, suppression, re-arm, `alert.triggered` → Flows, and `ai_triage`. A finding is the evidence record and the alert is the notification and workflow record. They link 1:1 through `alert_id`.

### 3.6 Network-side containment actions (new write path)

Two action kinds, one episode model:
- `switch_port_disable` (UniFi or SNMP): admin-down one access port.
- `client_block` (UniFi only): block one client MAC at the controller, so the block follows the device across ports and Wi-Fi.

Which kinds ship depends on the W5 lab gate (OD10).

**Episode table `network_containment_actions`.** The shape mirrors `device_network_isolations` (`db/schema/networkIsolation.ts:45`).
- **Target:** `org_id`, `site_id`, `kind` (`switch_port_disable | client_block`), `target_kind` (`unifi | snmp`), the device ref (`unifi_device_id` or `snmp_device_id`).
- **Port identity, carried end to end:** `port_identity` (interface UUID, epoch, ifIndex, ifName, ifPhysAddress) or `client_mac`.
- **What is behind it, snapshotted:** `target_mac`, `target_device_id`.
- **State:** `desired_state`; `prior_state_encrypted` (the exact prior override or admin state); `written_state_digest` (what we wrote); `generation`; `status` (`requested → journaled → applying → applied → restore_pending → restored | restore_blocked | restore_skipped_changed | failed:<code> | expired_restored`); `expires_at` (TTL, default 4 h, maximum 72 h).
- **Provenance:** `requested_by_kind` (`user | brain | flow`); `requested_by_flow_id`; `approved_by_user_id`; `intent_id`; `incident_id`; `finding_id`; `applied_at`, `restored_at`, `last_verified_at`, `last_restore_attempt_at`, `restore_attempts`; `reason`.
- **One unresolved episode per target:** a partial unique index on `(org_id, kind, device ref, port UUID or client_mac)` where status is non-terminal.

**Executor.**
- Commands go to a collector agent on the site, never from the API.
- New command types: `network_containment_apply` and `network_containment_restore` (`services/commandTypes.ts`).
- Each has a `COMMAND_MIN_AGENT_VERSION` entry, and credential fields go through `services/sensitiveCommandPayload.ts`.
- The command carries the full port identity, target MAC, generation and expiry. The agent **refuses** if, at execution time, the ifIndex no longer carries that UUID or epoch (ifName/ifPhysAddress mismatch), or the target MAC is no longer the only MAC learned on the port.

**UniFi (local controller) is lab-gated (W5 starts with a spike).**
- Write support is **(assumption)**. The official Network Integration API exposes port power-cycle but, as far as we know, not admin disable. Disable goes through the controller's device port-override update; client block through the controller's client-block command.
- Today's local client only issues GETs and **disables TLS certificate verification** (`agent/internal/unifi/client.go:198`). Before any write ships, the collector must:
  - pin the controller certificate, by fingerprint captured at collector setup;
  - prove write permission with an authenticated, *reverting* write in the lab. A GET cannot prove that a key can write.
- **If the spike fails, UniFi write is dropped from v1** and SNMP port control plus endpoint isolation remain (OD10).
- The cloud Site Manager API is read-only and is not used.

**SNMP.**
- One typed operation, not a generic SET: `SET IF-MIB::ifAdminStatus.<ifIndex>` with exactly the OID `1.3.6.1.2.1.2.2.1.7.<ifIndex>`, the value `down(2)`, or on restore the saved prior value.
- The agent's new `SNMPClient.SetIfAdminStatus(ifIndex, value)` is the only SET in the codebase. Any other OID or value is unrepresentable.
- It requires a **separate write credential**, SNMPv3 `authPriv` only (OD8), held in `snmp_write_credentials` (org-scoped, encrypted via `services/snmpSecrets.ts`, `excludedSensitive`).
- Setup docs tell the MSP to restrict the switch-side SNMPv3 user to a write view containing only `ifAdminStatus`. Breeze cannot enforce that on the device; the quorum asked for it as defence in depth.

**Guards.** All are checked server-side at proposal **and** at approval-time execution, and re-checked by the agent before writing. Approval does not freeze stale facts.
1. **Positively identified single-endpoint access port only.** Exactly one MAC learned on the port in the last 15 minutes, and it equals the target MAC. No LLDP/CDP neighbour of any kind. Not a VLAN trunk (UniFi profile `all`; for SNMP, `dot1qVlanStaticEgressPorts` membership in more than one VLAN — **(assumption: not walked today; W5 adds it to `agent/internal/snmppoll/templates.go`)**). The draft's "at most 3 MACs" rule allowed collateral shutdown of a phone pass-through or a small unmanaged switch, and is dropped.
2. Not the port of the collector itself, the gateway, or any Breeze-managed device with a server role.
3. Not on the partner's or org's `protected_ports` list (a setting, §4 Rule 9).
4. Fresh evidence (FDB or UniFi) that the target MAC is on this port, under 15 minutes old.
5. One target per request. At most 3 unresolved episodes per site. No bulk.

**Restore without stranding a port.** Both restorers in the draft depended on the collector reaching the switch. This model does not assume that.
- **Pre-write journal.** The agent journals `{episode, generation, identity, prior_state, written_state, expires_at}` to disk *before* writing, following the isolation manager's pre-write journal discipline (`agent/internal/isolation/manager.go:1191`).
- **Restart reconciliation.** After a restart, the agent reconciles every journaled episode against the server's desired state.
- **Conditional restore.** The prior state is restored only if the target's current state still equals what *we* wrote. If an administrator changed the port or override in the meantime, the episode goes to `restore_skipped_changed` and alerts. Their change is never clobbered.
- **Failover executor.** Any collector at the site with network reach and the credential may execute a restore. The server picks the first online one.
- **Visible failure.** A server sweeper (`jobs/networkContainmentSweeper.ts`, pattern `jobs/networkIsolationSweeper.ts`) drives TTL expiry. If no collector can restore, the episode becomes `restore_blocked`: a critical alert, visible retries with backoff, and a console runbook ("re-enable port N on switch X by hand"). An unresolved episode cannot be silently dropped. Org erasure is fenced on unresolved episodes the way it is fenced on isolation (`services/tenantCascade.ts:2521`, `assertIsolationErasureSafe`).
- **Native rollback.** Switch-native timed rollback (commit-confirm) is used where a vendor offers it. That is out of v1 scope, and the residual risk is stated in the docs.

**Verification and audit.**
- After apply, the agent re-reads the state. The episode becomes `applied` only on a verified read.
- `writeRouteAudit` rows: `network.containment.apply`, `.restore`, `.restore_skipped`, `.refused`.
- **Approval binding:** the effect digest is `(org_id, kind, device ref, port UUID + epoch or client_mac, target_mac, generation, desired_state, expires_at)`, through an `EFFECT_DIGEST_RESOLVERS` entry (`services/actionIntents/effectDigest.ts:176`). It is re-checked under a row lock at execution.

**Flags.** `NETWORK_CONTAINMENT_ENABLED` (default false) plus `NETWORK_CONTAINMENT_ENABLED_PARTNER_IDS`, the pattern of `services/networkIsolation/gates.ts:8-9`. Restore and the sweeper stay live when the flag is off.

### 3.7 Response routing through the approval model

There is **one rule: every response is an action intent or an interactive human action.** No new approval UI or decision machinery is built. Three entry points:

1. **Human, from a finding.**
   - "Isolate device…" calls the existing `POST /devices/:id/network-isolation` with `incidentId`. The finding auto-creates or links an incident, which satisfies isolation spec OD8.
   - "Disable port…" and "Block client…" call the new `POST /network/containment-actions`.
   - Guards: an interactive session, `topology:port_control`, MFA.
2. **AI, in chat or Wisp.**
   - `execute_containment` (`network_isolation`) stays tier 3 supervised.
   - `set_network_containment` is tier 3: apply is supervised, restore is four-eyes (OD6).
   - Both create `action_intents` through `createActionIntent` (`services/actionIntents/intentService.ts:1383`).
3. **Opt-in automation (Flows), which needs an authorization adapter and not just an enum.**
   - Tier-3 Flow steps already park as `source='flow'` intents (`services/flows/stepExecutor.ts:434`). That part is real.
   - **The execution side is not ready today:**
     - The Flow principal is a Flow UUID in `user.id` with no session or token (`services/flows/flowAuthContext.ts:90-100`).
     - `checkToolPermission` denies automation principals.
     - `startNetworkIsolation` writes the requester id straight into provenance (`services/networkIsolation/service.ts:119`).
     - The interactive-session and MFA guards live on the routes, not in the service.
   - **W6 therefore builds a `flowResponseAdapter`:**
     - When a parked response intent is approved, execution runs under a *derived* authorization: the **approving human's** permissions (they must hold `devices:execute` / `topology:port_control` for the target), the decision's recorded assurance level (the policy minimum is `session_tap` with MFA satisfied; isolation and containment also refuse a decision made with 2FA disabled — **(assumption: a policy choice for Gate A)**), and the Flow as *requester*.
     - Provenance gets a separate `requested_by_kind: 'flow'` with `requested_by_flow_id`, and `approved_by_user_id`. `ISOLATION_REQUESTED_BY_KINDS` (`packages/shared/src/utils/networkIsolation.ts:115`) and the SQL CHECK on `device_network_isolations.requested_by_kind` change together in one migration.
   - **v1 has no unattended execution.** Neither action joins `POLICY_DECIDABLE_TIER3` (`services/actionIntents/policyDecidableKeys.ts:75`) or Flow pre-approval (`services/flows/preApproval.ts`).
   - Unattended MCP principals are denied both actions by name, alongside `isNetworkIsolationCommand` (`routes/mcpServer.ts:1546,2230`).

**Isolation-spec §5 ("no automated isolation from alert rules") is reopened only in the narrow form *automation proposes, human approves*.** Fully unattended response is OD5, and the recommendation is to keep deferring it.

### 3.8 AI tools

New file `services/aiToolsNetworkEvents.ts`, registered from `aiTools.ts` like `registerIncidentTools`:

| Tool | Tier | Notes |
|---|---|---|
| `query_network_events` | 1 | Structured filters only (site, source, category, ip/cidr, device, port, time ≤ 24 h window). Returns aggregates by default and at most 200 rows. The time window is capped by the org's retention. |
| `resolve_network_identity` | 1 | Wraps §3.4: IP/MAC at T → device, user, switch port, confidence, method. Supersedes nothing; `get_ip_history` stays. |
| `get_network_findings` | 1 | List and detail with evidence. Detail includes `suggested_response`. |
| `set_network_containment` | 3 | `{ kind, target, desiredState: 'apply' \| 'restore', ttlHours?, reason, findingId? }`. Apply is supervised; restore is four-eyes (OD6). Needs: `TOOL_TIERS` (`aiAgentSdkTools.ts:246`), `TIER3_SUPERVISED_TOOLS` / `TIER3_FOUR_EYES_TOOLS` split by argument (precedent: `execute_containment` action types), `TOOL_PERMISSIONS` (`aiGuardrails.ts:1558`), `EFFECT_DIGEST_RESOLVERS`, `aiToolRateLimits.ts` (5/600, like containment), an approval label, web `components/ai-risk/tierConfig.ts`, and the unattended-MCP deny set. |

**Contract checklist (each one has bitten before):**
- Every tool is classified once in `WISP_TOOL_SUBJECTS` / `WISP_NON_FOCAL_TOOLS` (`services/wisp/toolSubjects.ts`, `toolSubjects.contract.test.ts`).
- Index-budget tests (`aiToolIndex.test.ts:256`, 7,040 B today, plus `aiToolIndex.w15-budget.test.ts`). Three tier-1 tools and one tier-3 tool under one domain block need about +384 B, and the wave must request the +128 B/wave allowance or trim existing hints.
- Registry parity, domain metadata, approval-scope, effect-digest coverage and approval-label contract tests (`aiAgentSdkTools.registryParity.contract.test.ts` and siblings).
- `SAFE_WRITE_SITES` (`aiTools.userOwnedRelease.contract.test.ts:153`) for any `auth.user.id` written into an FK.

**AI analysis.** No new AI pipeline. The `ai_triage` automation action, Wisp, and chat already run on alerts, with budgets (`aiBudgetReservations.ts`). A finding's alert gives them the finding id. The tier-1 tools let them pull the evidence and propose a response through the tools above. The model never sees raw syslog in bulk: `query_network_events` aggregates and caps.

### 3.9 Console surfaces

- **Network logs page** (`apps/web/src/pages/network/logs.astro`, new): sources list (add from "unknown senders seen"), budget meter (§3.3), an events explorer with structured filters, hash-state tabs per `DeviceDetails.tsx` convention, and rollup charts.
- **Findings** are on the alerts page through the alert link. A findings tab on the network logs page shows evidence, the endpoint join and the suggested response buttons (§3.7).
- **Device detail:** a new "Network activity" tab (hash `#network-activity`) with this device's attributed events and findings, next to the existing `connections` and `ip-history` tabs (`components/devices/DeviceDetails.tsx:1344-1357`).
- **Network device page** (`components/devices/NetworkDeviceDetailPage.tsx`): for a syslog source, its sender stats. For a switch, a port table with an active-episode badge and a "Disable port…" dialog showing each guard result. For a UniFi client, a "Block client…" action.
- **Collector designation:** an extension of the existing collector concept on the site (UniFi `unifi_collectors`, SNMP poller). The policy decides *what* the listener does; the site's collector is *which* agent runs it.
- **Mutations** use `runAction` (`apps/web/src/lib/runAction.ts`). New locale keys go in all 8 locales.

### 3.10 Interactions and gates

- **Feature gate:** entitlement `network_log_correlation` (hosted) plus env `NETLOG_ENABLED` (self-host default false in v1). Off means no heartbeat block is sent and the route returns 403 `feature_disabled`. Partition maintenance and retention keep running so data still expires.
- **Partner trust** (`services/partnerTrust.ts`): network containment actions are `device_execute`-class. Probation and restricted partners cannot issue them; restore is lifecycle-exempt.
- **Existing EDR and vendor isolation:** untouched.
- **Log forwarding** (`services/logForwarding.ts`, Elasticsearch): **not** extended in v1. An MSP that wants a SIEM can point firewalls at it directly. Forwarding Breeze's reduced stream is a possible later wave (§5).

## 4. Tenancy & data-model impact

**Baseline for every new table:**
- RLS enabled, forced and with policies **in the creating migration**.
- Every composite FK to an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE`.
- Partitioned tables put RLS on the parent **and** on every leaf, through the maintenance function (§3.3).
- Request and agent paths use the caller's org DB context. Only the partition-maintenance job and genuine cross-org workers (the sweeper, the detect scheduler fan-out) use system context.

| Table | Shape | Device lists / move-org | Cascade / merge / export |
|---|---|---|---|
| `network_log_sources` | 1 (org). Columns: `site_id`, `collector_device_id`, optional `discovered_asset_id` / `snmp_device_id` / `unifi_device_id`, `parser_profile`, `sender_ips inet[]`, `trust`, `tls_client_fingerprint`, `realm_vlans int[]`, `label` | `collector_device_id`: **detach** (SET NULL; the source is network inventory, precedent `discovered_assets`). On move-org: detach. | cascade; merge `repoint`; export: scalars `included`, `tls_client_fingerprint` `reviewedIncluded` |
| `network_events` (LIST class → RANGE day) | 1 (org) + `device_id` nullable | **Not moved, and detached on move.** On a device org move the source-org rows keep their `org_id` and get `device_id` set to NULL, so a source-org row never names a device now in another org. **Trap:** `breeze_device_child_orgid_tables()` (`migrations/2026-12-27-170000-pam-org-move-unactuated-elevation-restamp.sql`) picks up every `relkind = 'r'` table with the columns. That includes **leaf partitions**, so `breeze_cascade_device_org_id()` would restamp them. W1 excludes these tables and their leaves (`relispartition` or a name exclusion) from that function, adds the explicit detach to `moveDeviceOrgInTransaction.ts`, and registers them in `moveOrg.coverage.test.ts`'s not-moved list. Device hard-delete: the detach list. | cascade: **batched, partition-wise** (below); merge `repoint`; export: OD9; `fields` `excludedOpen` |
| `network_event_rollups` (LIST class → RANGE month) | same | same | same |
| `network_findings` | 1 (org) + `device_id` nullable, `alert_id`, `incident_id` | detach on move and on hard-delete (history) | cascade (before `alerts`, `incidents`); merge `repoint` with a **collision rule**: when two open findings share `(detector_key, dedupe_key)` after merge, the newer is resolved as `merged` into the older; export: `evidence`, `suggested_response` `excludedOpen` |
| `network_containment_actions` | 1 (org) + `target_device_id` nullable | detach (the port belongs to the network). **Unresolved episodes block a device org move and org erasure**, following `assertIsolationErasureSafe` (`services/tenantCascade.ts:2521`). | cascade (before `incidents`, `action_intents`); merge `repoint` (target refs are org-specific, so there are no unique collisions); export: `prior_state_encrypted` `excludedSensitive`, `port_identity` `excludedOpen` |
| `snmp_write_credentials` | 1 (org); composite FK `(snmp_device_id, org_id)` | — | cascade (before `snmp_devices`); merge `repoint`; export: secrets `excludedSensitive` |
| `network_log_daily_usage`, `network_log_collector_daily_usage` | 1 (org) | collector table: `collector_device_id` detach | cascade; merge: **sum on collision** of `(org_id, usage_day)`; export `included`; pruned after 90 days |
| `network_log_ingest_batches` | 1 (org) | `collector_device_id` cascade-delete (a dedupe ledger, nothing to keep) | cascade; merge `repoint`; export: excluded by retention (pruned after 3 days), columns `included` |
| `device_ip_history.site_id` (**new column**) | existing table | the move-org restamp already covers the table; on move, `site_id` follows the existing site-pointer rewrite (`DEVICE_SITE_DENORMALIZED_TABLES`) — **(assumption: verify, else `SITE_FK_RESTAMP_REVIEWED`)** | export: add `site_id` to `included` (the column-add trap) |
| config-policy feature `network_log_collection` | inline settings on `config_feature_links` (dual-axis already). The enum value goes in its **own** migration, precedent `2027-01-19-120000-config-feature-containment.sql`. | — | `PARTNER_LINKABLE_FEATURE_TYPES`; `validateFeaturePolicyExists` dual-axis branch; resolver `resolveNetworkLogPolicy(deviceId)` in `services/featureConfigResolver.ts` |
| budget, retention class, detector tuning, protected ports | Partner settings catalog (`PARTNER_SETTINGS_CATALOG`, `packages/shared/src/settings/partnerSettingsCatalog.ts`) + org override, through `services/effectiveSettings.ts`. **No new table** (OD3, OD7). | — | — |

**Grep, don't judge.** Every table above is checked against:
- `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`;
- `routes/devices/core.ts` (the cascade and detach lists), the `DEVICE_ORG_*` lists and `moveOrg.coverage.test.ts`;
- `rls-coverage.integration.test.ts`;
- the new-service classification contract for `apps/api/src/services/*` files.

**Org erasure and export do not scale as they stand.**
- `deleteOrgRows` issues one `DELETE … WHERE org_id = $1` per table (`services/tenantCascade.ts:2700-2708`).
- `tenantExport.ts:93` materialises whole tables, and in the end the ZIP, in memory.
- An org at the 30-day class and the ceiling cap holds tens of millions of event rows. W1 therefore adds:
  1. **A per-table erasure hook** in `tenantCascade.ts` for the partitioned tables. It deletes leaf by leaf, in bounded batches keyed by `(tableoid, ctid)` under an outer `org_id` predicate, and can resume after interruption. `jobs/retentionBatch.ts:175` selects by `ctid` alone, which is unsafe across partitions, so it is not reused for these tables.
  2. **An export decision (OD9).** Either keyset-streamed export for these tables, or table-level exclusion.

  A seeded multi-partition integration test covers both.

**Settings Rule 9 statement:**
- (a) **Collection behaviour** (listener, port, parsers, drop rules, rate limits). Home = Configuration Policies → Network Logs tab. Level = partner → org → site → device via assignment. Resolver = `resolveNetworkLogPolicy`. Places configured: before 0, after 1.
- (b) **Budget, retention class, detector tuning, protected ports.** Home = Settings → Monitoring → Network logs, at partner and org level. Level = partner default → org override, clamped by entitlement and ceiling. Resolver = `resolveNetworkLogOrgSettings(orgId)`, used by ingest, the heartbeat block, detection, the containment guards and partition routing. Places configured: before 0, after 1.

## 5. Out of scope

- **Raw syslog storage and free-text search.** That is the SIEM line, and §3.1(1) keeps it closed. A time-boxed raw capture for parser debugging is OD1(b).
- NetFlow, sFlow and IPFIX ingestion. Proposed as a later wave, aggregate-only (top talkers per 5 min per device, never raw flow records) (OD2).
- User-authored detection rules or a query language. v1 is a fixed, tunable detector registry.
- Forwarding the reduced stream to an external SIEM (Elasticsearch forwarding stays event-log-only).
- **Unattended (policy-decided) isolation or port shutdown** (OD5).
- Bulk responses: many devices or ports per request.
- Port actions on non-UniFi vendors through vendor APIs (Meraki, Aruba Central, and others). SNMP covers the generic case.
- VLAN quarantine moves and Wi-Fi deauth. UniFi client block is *in* scope, conditionally (OD10).
- DHCP-server lease ingestion beyond what the `dhcp_lease` syslog category gives.
- Replacing `log_correlation_rules`.

## 6. Open Decisions

Quorum positions come from the independent advisor review (Appendix A). Where the advisor disagreed, the disagreement is stated, not silently resolved.

**OD1 — Raw syslog storage.** (a) **None.** Only classified, aggregated events with a 1 KB message, plus a 1% unclassified sample. (b) (a), plus a per-source "raw capture" switch that stores unparsed lines for at most 1 hour, capped at 10k lines, for parser debugging. (c) A raw tier with 24 h retention. **Recommend (a) for W1 and (b) in the parsers wave.** Parser coverage needs raw samples, and a self-expiring capture provides them without a standing raw tier. (c) is how the partner got 100 GB. *Quorum: agrees conditionally. Raw capture must count against the same budget, expire automatically, and redact secrets (passwords and keys in vendor lines) before storage. Adopted as conditions on (b).*

**OD2 — Vendor scope and flow.** (a) v1 parsers: generic RFC 3164/5424, UniFi, pfSense/OPNsense, FortiGate, SonicWall and Cisco IOS; flow is out of scope. (b) Add NetFlow v5/v9 aggregates in v1. **Recommend (a).** Syslog covers every §3.5 detector except bytes-dependent `exfil_volume`, and flow at v1 doubles the agent surface. *Quorum: agrees.*

**OD3 — Where budget and retention live.** (a) **The partner settings catalog plus an org override** (`effectiveSettings.ts`), under Settings → Monitoring. (b) Inline on the `network_log_collection` config policy, the way `event_log.retentionDays` is today (`config_policy_event_log_settings`, resolved org-beats-partner at `routes/agents/helpers.ts:2588-2645`). **Recommend (a).** Budget and retention are org-level storage facts. A per-device policy resolver is ambiguous when two collectors in one org resolve different policies. The cost is that "retention lives in config policy" now differs between two features. *Quorum: agrees.*

**OD4 — Retention mechanism and default sizes.** (a) **Fixed retention classes** (events 3/7/14/30 days, rollups 30/90/395 days) with LIST-by-class → RANGE-by-time partitioning, so expiry is always a partition drop. Defaults are events 7 days at 250k rows/150 MB per org per day, rollups 90 days at 20k rows per day, and findings 365 days at 200 opens per day. (b) Arbitrary per-org day counts under one global horizon, with batched row deletes for the gap (the first draft). **Recommend (a).** *Quorum disagreed with the first draft's sizing.* It showed that the draft's rollup allowance (50k keys per hour) allowed about 108M rows per org over 90 days, that the sizing omitted rollups entirely, and that a 7-day default under a 30-day horizon is mostly row deletes. Both points are adopted: classes replace the horizon, and rollups are capped and sized. *The advisor still holds that no number should be frozen before W2 measures every tier including index and WAL overhead and deletion cost.* That is accepted: the table in §3.3 is provisional until W2.

**OD5 — Unattended response.** (a) **v1: automation proposes, a human approves** (flow-parked intents only). No `POLICY_DECIDABLE_TIER3` entry for either action. (b) Allow policy-decided `switch_port_disable` / `client_block` for guarded access targets with a TTL of 4 h or less, behind an explicit per-org opt-in. (c) Also allow policy-decided isolation. **Recommend (a)**, and revisit (b) after a quarter of field data on false-positive rates per detector. A mis-attributed IP plus an automatic shutdown is the network-side version of the self-inflicted outage that isolation-spec §5 and OD15 deferred. *Quorum: agrees, and requires the Flow authorization adapter (§3.7) to land first.*

**OD6 — AI restore of a network containment.** (a) Four-eyes, mirroring `release_containment`. (b) Supervised. **Recommend (a).** Re-admitting an attacker's port or MAC is the "attacker with a key" path that four-eyes guards on isolation release. Humans in the console restore with one person. *Quorum: agrees.*

**OD7 — Where detector tuning lives.** (a) Inline on the per-collector `network_log_collection` policy (the first draft). (b) **Org-level settings with a partner default** (the same resolver as OD3), applied to all of the org's sources. **Recommend (b).** *The quorum disagreed with (a)*: cross-source detectors such as `mac_flap` need deterministic per-site or per-realm configuration, and a collector-dependent resolution gives two answers. Adopted.

**OD8 — SNMP write credential versions.** (a) **SNMPv3 authPriv only**, with docs requiring a switch-side write view limited to `ifAdminStatus`. (b) Also allow v2c write communities, flagged insecure. **Recommend (a).** *Quorum: agrees, and added the restricted write view.*

**OD9 — Tenant export of the high-volume tiers.** (a) Include events and rollups, after first replacing whole-table materialisation (`tenantExport.ts:93`) with keyset streaming for these tables. (b) Add table-level exclusion to the export registry for operational telemetry, and exclude events and rollups (findings, sources and episodes are still exported). (c) Include them under the current materialising export. **Recommend (b) for v1.** Events and rollups are at most 30 days of operational telemetry, and findings carry the durable evidence. *The quorum disagrees and prefers (a)*: telemetry is customer data and belongs in the export, and streaming is a prerequisite either way, because `device_metrics` is already exported the same way (`tenantExportPolicyRegistry.ts:424`). **Unresolved; Todd to decide.** Both sides reject (c).

**OD10 — Which network-side response ships.** (a) SNMP port disable only. (b) **UniFi client block as the preferred response where UniFi is present** (MAC-level, follows the device, no collateral to a port's other users), with SNMP port disable as the generic fallback, and UniFi port disable as a third option. (c) Defer all network-side writes and keep endpoint isolation only. **Recommend (b), conditional on the W5 lab spike** proving authenticated write and exact restore on the controller with certificate pinning. If the spike fails: (a) for SNMP sites, endpoint isolation elsewhere. *Quorum: chose (b) conditionally, and said to fall back to (c) if client-block enforcement cannot be proven.* The difference is small: this spec keeps SNMP port disable even if UniFi fails.

**OD11 — Where the syslog parser runs.** (a) **A separate low-privilege `breeze-netlog` process** spawned by the agent, with IPC to the agent. (b) In-process in the agent (SYSTEM/root). (c) An existing third-party syslog relay on the collector, which Breeze then tails. **Recommend (a).** The parser handles hostile, unauthenticated network input, and the agent process holds the device credential and the UniFi and SNMP secrets. (c) moves parsing out of Breeze's control and adds a dependency per OS. *Quorum raised the isolation concern (it suggested an isolated worker or an existing relay) and the sender-authentication gap. (a) is our answer to both, alongside §3.2's trust model.*

## 7. Test & rollout notes

**Waves sketch** (one PR per wave; the plan will refine them):

| Wave | Contents | Gate |
|---|---|---|
| W1 | **Server data and contracts:**<br>• tables (§4), leaf-RLS partition-maintenance functions with a runtime-role test<br>• all tenancy registrations, the move-org trigger exclusion and detach<br>• the partition-wise erasure hook<br>• `device_ip_history.site_id`<br>• the org settings resolver<br>• the Postgres budget reservation and batch ledger<br>• the ingest route in the agent org context<br>• the identity resolver plus the DNS attribution fix | Integration suites green; partitions create, drop and RLS-force as `breeze_app`; a seeded multi-partition erasure test |
| W2 | **Agent collector:**<br>• `breeze-netlog` low-privilege process and IPC, frame/connection/memory limits, token buckets<br>• generic and UniFi parsers (fuzzed), aggregation with bounded keys<br>• rollup-only summaries with distinct-count sketches, spool with batch ids<br>• heartbeat block, config-policy feature `network_log_collection` (enum in its own migration), version gate<br>• UniFi client port/VLAN field population | **Lab:** a UniFi gateway and a pfSense VM sending to Windows and Linux collectors. **Measure** bytes/row (index and WAL included) and daily volume per tier, then freeze the OD4 numbers. |
| W3 | Remaining v1 parsers, plus raw capture with redaction and budget (OD1b); console network logs page, budget meter, sources with trust level, device "Network activity" tab, settings page | 8 locales; `settingsPageRegistry.test.ts` |
| W4 | Detector worker and the v1 detectors (org-level tuning, `degraded`, corroboration rule), `network_findings`, sourced alerts, findings UI, AI tier-1 tools (index budget) | Detector tests on recorded fixtures, including a spoofed-UDP fixture that must yield `suggested_response: none`; Wisp classification contract |
| W5 | **Starts with a lab spike:** UniFi port-override and client-block write plus exact restore, with certificate pinning (OD10 gate). Then:<br>• `network_containment_actions`, `snmp_write_credentials`<br>• agent typed `SetIfAdminStatus`; the UniFi writes that passed the spike<br>• guards at proposal and at execution, pre-write journal, conditional restore, failover executor, sweeper, `restore_blocked`<br>• erasure and move fences, console dialogs<br>• `set_network_containment` tier 3, effect digest, MCP deny, flags | **Lab:** a UniFi switch and an SNMPv3 switch. Guard refusals fire on uplink, trunk, multi-MAC, collector and protected ports. Killing the collector mid-episode → failover restore or `restore_blocked`. An admin change during an episode → `restore_skipped_changed`. |
| W6 | **Response routing:**<br>• finding → incident → isolation button<br>• the `flowResponseAdapter` (approver-derived authorization, `requested_by_kind: 'flow'` in shared types and the SQL CHECK together)<br>• Flow steps for isolate / containment parking as `flow` intents<br>• docs, including the residual-risk note on network-side restore | **End-to-end:** a lateral-fanout fixture → finding → alert → Flow → intent → mobile approve → port down → TTL restore. The Flow principal alone must be refused. |

**CI traps:**
- The RLS coverage, tenant cascade, export-policy and org-merge integration suites **do not run under `pnpm test`**. They fail only under the **Integration Tests** job. Run them locally against a real database before each PR in W1, W4, W5 and W6 (`docs/agents/testing.md`).
- `moveOrg.coverage.test.ts` reads the Drizzle schema statically, so the leaf partitions are invisible to it. The `breeze_device_child_orgid_tables()` exclusion needs its own integration test: move a device that has events, and assert the source-org leaf rows keep their `org_id` and get `device_id` set to NULL.
- `orgMerge.test.ts` reds only in the full unit suite, never in a touched-file run.
- Stacked PRs (base ≠ main) run no CI. Dispatch `gh workflow run CI --ref <branch>`.
- Migration names must sort after the newest committed migration. At drafting time that is `2027-01-20-120000-m365-mailbox-connect-baseline.sql`; check again at write time. Any migration that writes rows elects system scope first.
- Enum values (the config feature type, command types if enum-backed) go in their own migration (the transaction rule).
- The AI tool index budget, Wisp subject classification and line-keyed `SAFE_WRITE_SITES` contracts all fire on W4 and W5.
- Any date-dependent detector or retention test must use a fixed clock. A date-bomb test has poisoned the merge queue before.

**Rollout.**
- Behind `NETLOG_ENABLED` and the entitlement. Enable for one design-partner MSP first, with defaults at the low end.
- Watch per-org rows and bytes per day and partition sizes for two weeks before raising any ceiling.
- `NETWORK_CONTAINMENT_ENABLED` is a separate flag with its own partner allowlist, enabled only after W5 lab sign-off.

## Appendix A — Advisor quorum record (2026-11-04)

The independent read-only review verified the draft against the cited code.

| # | Quorum point | Evidence the reviewer cited | Disposition |
|---|---|---|---|
| 1 | The budget was not hard: `ingestQuota` fails open on missing client, null exec and throw; it already refuses the crossing batch (the draft said otherwise); retries are not idempotent; rollup and finding caps were missing | `services/ingestQuota.ts:67,86,93,97` | **Adopted**: Postgres atomic reservation in the ingest transaction, batch-id ledger, rollup and finding caps (§3.3) |
| 2 | Parent RLS does not protect direct leaf access; `pruneInCtidBatches` keys on `ctid` alone, which is unsafe across partitions; a short default under a long horizon is mostly row deletes | `migrations/2026-11-10-130000-…:98`, `jobs/retentionBatch.ts:175` | **Adopted**: leaf RLS, retention classes, a `(tableoid, ctid)` erasure hook |
| 3 | Erasure is one DELETE and export materialises tables; isolation erasure fences must cover unresolved port actions | `tenantCascade.ts:2521,2706`, `tenantExport.ts:93` | **Adopted** (§4); export approach left as OD9 (disagreement stands) |
| 4 | A UDP IP allowlist is not authentication, and the listener needs resource bounds | — | **Adopted**: trust levels, the corroboration rule, limits, a separate process (OD11) |
| 5 | IP history is observational; `is_active` can be stale; no historical site, so today's site rewrites the past | `services/deviceIpHistory.ts:218`, `db/schema/devices.ts:526` | **Adopted**: bounded interval, `site_id` column, realm, ambiguity rule (§3.4) |
| 6 | UniFi readiness unproven: port and VLAN fields unpopulated, a GET cannot prove write, TLS verification disabled; preserve admin changes on restore | `agent/internal/unifi/client.go:105,198` | **Adopted**: W5 spike gate, cert pinning, conditional restore |
| 7 | Port identity must carry UUID and epoch; "at most 3 MACs" allows collateral; replace prefix-SET and unconditional `up(1)` | `agent/internal/snmppoll/interface_poll.go:19` | **Adopted**: exact single-MAC rule, typed exact-OID SET, restore to saved state |
| 8 | TTL restore strands the port if the collector dies | `agent/internal/isolation/manager.go:1191` | **Adopted**: pre-write journal, failover executor, `restore_blocked` alert and runbook |
| 9 | Flow routing needs an authorization adapter: the Flow principal is a UUID with no permissions; isolation writes the requester id | `flows/flowAuthContext.ts:96`, `networkIsolation/service.ts:119` | **Adopted** (§3.7 `flowResponseAdapter`) |
| 10 | System DB context is unrestricted, not org-scoped; move-org needs explicit detach plus trigger exclusion; merge collisions undefined | `db/index.ts:243`, `moveDeviceOrgInTransaction.ts:1012` | **Adopted**, and we found the leaf-partition `relkind='r'` trap ourselves while verifying (§4) |
| 11 | Rollups dropped destination dimensions; process joins are not "at T" | `routes/agents/connections.ts:153` | **Adopted**: distinct-count sketches, `degraded` flag, "latest observed context" wording |
| — | OD positions: agree OD1 (conditions), OD2, OD3, OD5, OD6, OD8; disagree OD4 (sizing), OD7, OD9; OD10 choose (b) conditionally | — | OD4 and OD7 changed; **OD9 still in disagreement** |
