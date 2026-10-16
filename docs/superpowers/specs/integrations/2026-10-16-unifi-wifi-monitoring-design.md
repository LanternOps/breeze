---
title: UniFi Wi-Fi monitoring (AP radios and device statistics)
issue: LanternOps/breeze discussion #7690
status: draft (spec requested in discussion #7690; implementation not approved yet)
related:
  - LanternOps/breeze#3208
  - LanternOps/breeze#7271
---

# UniFi Wi-Fi monitoring: AP radios and device statistics

Status: draft, for maintainer review. This is the spec requested in discussion #7690. It is a design/contract change only; implementation starts only after approval.

## 1. Problem and goal

Breeze already discovers UniFi sites, devices and clients through the official Network Integration API, and the agent publishes a typed UniFi topology companion. Today an operator can see that an AP exists and whether it is online, but cannot answer basic current-state Wi-Fi questions without opening the UniFi console:

- which radios the AP exposes and their band/channel/width/standard;
- whether radio TX retries are elevated;
- current AP CPU, memory and uptime;
- current/last-reported uplink rates;
- how many **wireless** clients are attached to each AP.

The `statistics` UniFi topology resource already exists but is deliberately emitted as `not_collected`. Device details already have a bounded rotating fetch window, but the current typed detail row has ports only and no radios.

**Goal:** extend the existing read-only UniFi collector with bounded AP radio inventory and current device/radio statistics, transport them through a versioned typed topology companion, and surface one current-state operator view in the existing **Integrations → UniFi → Deep telemetry** UI.

This feature does not diagnose why Wi-Fi is bad. It exposes controller facts with explicit freshness and missing-data semantics.

## 2. Source of truth and evidence status

This section is normative about where each decision comes from so implementation does not turn an inference into a requirement.

### 2.1 Confirmed by the maintainer

The review in discussion #7690 approved moving to a spec and requires this spec to settle all of the following before code:

1. contract/version rollout (the current UniFi contract is strict v1 and digest-bound);
2. supported-version fixture proof for the proposed controller fields;
3. one operator-facing home for CPU/memory/uptime/client-count and the new Wi-Fi state;
4. an explicit request cadence/cap for `statistics/latest`;
5. alerts, if later added, must use the consolidated alert framework rather than a separate UniFi evaluator.

The same review points to the spec-first shape used by PR #7642.

### 2.2 Confirmed in current Breeze code (`upstream/main` at `3de1f8194` when this spec was reviewed)

- The agent uses only `/proxy/network/integration/v1` and GETs for collection.
- Device/client list pagination is now complete and bounded; the older comment claiming only the first client page is read is stale.
- Device details rotate with `MaxDetailsPerPoll = 32` and a 45-second detail-phase timeout.
- `statistics` is a known UniFi resource kind, but the agent currently emits it as `not_attempted/not_collected`.
- `unifiTopologyV1Schema` is strict `version: 1`; its resource digests are canonicalized as `unifi_topology_v1` and recomputed by the API before acceptance.
- The API currently advertises `acceptedUnifiTopologyVersions: [1]` plus a producer epoch/source identity.
- The normalized topology pipeline retains `unifi_statistics`, but the physical topology projector intentionally derives no graph topology from it.
- Current UniFi topology authority accepts an exact controller-site mapping only inside the collector device's organization; a mapping to another organization is rejected as `controller_site_other_org`. Legacy UniFi telemetry can still route mapped rows across orgs.
- `unifi_device_telemetry` already stores current device uptime, CPU, memory and client count, and already has `poe_ports` plus legacy tx/rx byte columns.
- `GET /unifi/telemetry?siteId=` and the existing Deep telemetry UI read `unifi_device_telemetry`/`unifi_clients`.
- The collector's legacy `txBytes`/`rxBytes` fields mean byte counters. They are **not** compatible with UniFi `txRateBps`/`rxRateBps` rate values.
- Missing legacy telemetry metrics persist as SQL `NULL`, and the UI renders missing values as `—`.
- A current `partial` topology source snapshot retains absence/lifecycle bookkeeping, but `current_baseline.section.rows` is the current snapshot's row subset. It is not a per-device latest-value cache suitable by itself for a rotating Wi-Fi UI.
- There is already a pattern for side materialization from an accepted UniFi topology resource: accepted `device_details` can feed `ingestUnifiInterfaceTelemetry` without changing the structural topology receipt.

### 2.3 Confirmed by real supported-version controller evidence

`@bgatestmg` supplied sanitized, GET-only fixtures from Network **10.6.106** on UniFi OS **5.1.132** in discussion #7690 ([radio/statistics fixtures](https://github.com/LanternOps/breeze/discussions/7690#discussioncomment-18961621), [client/switch boundary observations](https://github.com/LanternOps/breeze/discussions/7690#discussioncomment-18961724)). These fixtures close the evidence gap identified in the maintainer review.

Observed on real APs:

- detail `interfaces.radios[]`: `frequencyGHz`, optional `channel`, `channelWidthMHz`, `wlanStandard`;
- 2.4, 5 and 6 GHz radios;
- `statistics/latest`: `uptimeSec`, `cpuUtilizationPct`, `memoryUtilizationPct`, uplink `rxRateBps`/`txRateBps`, and per-radio `txRetriesPct`;
- `txRetriesPct: 0.0` is a real measured zero, not missing data;
- `channel` can be omitted (observed on an offline AP);
- CPU/memory/uptime/retry fields can be omitted;
- uplink rate keys can be omitted;
- an offline AP can still return positive uplink rate values, so presence alone cannot mean "current traffic";
- `lastHeartbeatAt`/`nextHeartbeatAt` were present on `statistics/latest` in the captured responses;
- client rows expose `type` and `uplinkDeviceId`, but not radio/band/frequency/RSSI; `uplinkDeviceId` is present for wired clients too, therefore AP client counts must filter `type == WIRELESS` before grouping by `uplinkDeviceId`.

The same evidence shows switch `statistics/latest.interfaces` as `{}` with no per-port traffic rates. Switch PoE evidence belongs to #7271 and is not expanded by this spec.

### 2.4 Confirmed by official Network 10.6.106 API documentation

The [Network 10.6.106 OpenAPI contract](https://developer.ui.com/network/v10.6.106/openapi.json) defines adopted-device `features` (`switching`, `accessPoint`, `gateway`) and `interfaces` (`ports`, `radios`) sets. Device details expose optional `interfaces.radios`. The collector may therefore identify AP candidates from the device list without probing switch statistics. This is documentation evidence, separate from the real fixtures above.

### 2.5 Design decisions proposed by this spec

The following are design choices for maintainer approval, not pre-existing requirements:

- ship the expanded wire contract as **UniFi topology v2**, leaving v1 byte-for-byte/digest compatible;
- use the topology companion as the validated transport/evidence path, but make existing `unifi_device_telemetry` the **single operator-facing current-state materialization** for these metrics;
- add explicit rate/radio/freshness columns to that existing table rather than repurposing byte-counter columns or adding a new table;
- cap newly-added statistics traffic at **16 requests per minute per collector**, interval-adjusted per poll, with a durable fair cursor across AP candidates;
- treat topology freshness and device online state separately; positive rates from an offline AP are last-reported/stale, never presented as current throughput.

## 3. Scope

### In scope

1. AP radio inventory: frequency, channel, channel width, WLAN standard.
2. AP statistics: uptime, CPU, memory, uplink RX/TX rates, radio TX retry percentage.
3. Wireless-client count per AP, derived from the complete client list.
4. Explicit measurement/freshness metadata for statistics.
5. A v2 typed UniFi topology companion with deterministic canonicalization and digest parity between Go and TypeScript.
6. Bounded AP-only statistics collection with fair rotation and per-device failure isolation.
7. Current-state materialization into the existing `unifi_device_telemetry` row for the controller device.
8. Operator display in the existing Deep telemetry card.

### Out of scope

- radio or rate history/time-series;
- clients per radio/band;
- client RSSI, channel, band, VLAN or roaming (not exposed by the client endpoint used here);
- advanced RF metrics, interference/channel-quality diagnosis or AI recommendations;
- per-port switch traffic rates (not exposed by the evidence in #7271 / #7690);
- firewall zones/policies observed by the fixture contributor;
- UniFi write/control actions of any kind;
- legacy/undocumented UniFi APIs;
- multi-vendor Wi-Fi;
- customer portal Wi-Fi views in this wave;
- expanding UniFi topology authority across organizations. Cross-org controller-site mappings keep their current legacy-telemetry behavior and do not receive these new v2 Wi-Fi fields until a separate tenancy/authority design approves that boundary;
- a new UniFi alert evaluator or AP anomaly alerts. #3208 owns alerting; its current v1 scope explicitly defers AP anomaly detection.

## 4. Contract versioning and rollout

### 4.1 v1 is frozen

Do **not** add radio or new statistics fields to the existing v1 row schemas.

Why: the v1 digest is computed over the agent's canonical v1 resource. The API parses and recomputes that digest. Additive unknown fields are not a safe minor-version mechanism here: an older API can strip an unknown field during schema parsing and recompute different canonical bytes, producing `content_digest_mismatch`.

All existing v1 fixtures, canonical strings and digests remain unchanged.

### 4.2 Add UniFi topology v2

Add a separate shared `unifiTopologyV2Schema` and Go `TopologyV2` companion. v2 keeps the existing resource kinds and identity rules but extends the device overview, `device_details` and `statistics` rows as defined in section 5.

Canonicalization is version-bound:

- wire contract: `unifi_topology_v2`;
- normalized contract: `unifi_topology_normalized_v2`;
- v1 continues using its existing v1 contract names and fixture digests.

Both versions retain the same resource kinds/source keys so existing topology authority and lifecycle semantics remain stable. The API must validate by report version before normalization and its retained UniFi source schema must accept the normalized v1/v2 row union for those kinds. This is required for a v2-capable agent to fall back to v1 under the same producer epoch after server rollback; v2-only fields must never be silently interpreted as v1 fields.

The agent payload gains an optional `topologyV2` companion. It sends **at most one** UniFi topology companion per poll. The API treats `topologyV1` + `topologyV2` in the same request as an invalid topology companion (no ambiguous precedence), while the legacy telemetry body still proceeds. The legacy telemetry body otherwise remains independent, so a malformed/rejected topology companion must not block legacy ingest, matching current v1 behavior.

### 4.3 Negotiation

The agent chooses the highest version it implements that the API advertises:

- old API + old agent: v1 (unchanged);
- new API + old agent: API advertises `[1, 2]`; the old agent sees `1` and continues emitting v1;
- old API + new agent: old API advertises `[1]`; the new agent emits exact v1;
- new API + new agent: v2.

No agent may infer v2 support from server version. The advertisement is authoritative.

### 4.4 Deployment order

1. **API/shared/web first:** parse/ingest v1 and v2, advertise `[1, 2]`, materialize/display v2 data, keep all v1 tests green.
2. **Agent second:** add v2 negotiation/collection and release only after the API that accepts v2 is deployed.
3. Keep v1 ingest/advertisement support during the compatibility window; removal is a separate future decision, not part of this feature.

Rollback is therefore safe: disabling v2 advertisement makes new agents fall back to v1 without changing the legacy telemetry path.

## 5. v2 wire model

All new nullable values use explicit `null` after normalization. A controller key that is absent is not converted to zero.

### 5.1 Device overview capability signals

The v2 `device_list` row extends v1 with the documented adopted-device capability sets:

```ts
type UnifiDeviceV2Capabilities = {
  features: Array<'switching' | 'accessPoint' | 'gateway'> | null;
  interfaces: Array<'ports' | 'radios'> | null;
};
```

The agent sorts/deduplicates these finite documented enum sets before canonicalization (at most 3 feature values and 2 interface values). An absent controller key normalizes to `null`, not an empty set. The API derives `wifiCapable` as `true` from a positive documented signal (`interfaces` contains `radios` or `features` contains `accessPoint`), `false` only when the capability sets are present and contain no AP/radio signal, and `null` when the necessary capability evidence is unavailable. Model-name inference is never used.

These fields are part of v2 because the API needs the same typed evidence the agent uses to identify APs and to materialize an authoritative wireless-client count of zero.

### 5.2 Device detail radio overview

`device_details.rows[].radios` is `WirelessRadioOverview[] | null`: `null` means the controller omitted the `interfaces.radios` key, while `[]` means it explicitly reported an empty radio list. When present it is bounded to a maximum of 16 entries and sorted deterministically by frequency, then channel/width/standard for canonicalization.

```ts
type WirelessRadioOverview = {
  frequencyGHz: number;       // documented: 2.4, 5, 6, 60; fixtures observed 2.4/5/6
  channel: number | null;
  channelWidthMHz: number | null;
  wlanStandard: string | null;
};
```

The existing `ports` contract is unchanged.

### 5.3 Device/radio statistics

```ts
type WirelessRadioStatistics = {
  frequencyGHz: number;
  txRetriesPct: number | null; // 0 is a valid measurement
};

type UnifiStatisticsV2Row = {
  rowKey: string;
  deviceId: string;
  uptimeSeconds: number | null;
  cpuUtilizationPct: number | null;
  memoryUtilizationPct: number | null;
  uplinkRxRateBps: number | null;
  uplinkTxRateBps: number | null;
  lastHeartbeatAt: string | null;
  nextHeartbeatAt: string | null;
  radios: WirelessRadioStatistics[] | null;
};
```

Rules:

- percentages are finite and bounded 0–100;
- rates are finite, non-negative and use **bits per second** semantics;
- rates never populate legacy `txBytes`/`rxBytes` fields;
- heartbeat timestamps are retained as controller-reported metadata. This first Wi-Fi monitoring scope does not infer undocumented heartbeat cadence from them;
- a missing statistics `interfaces.radios` key normalizes to `null`; an explicitly empty array remains `[]`;
- present arrays are bounded to 16 entries and canonicalized deterministically before digesting.

### 5.4 Radio correlation

The fixtures expose no radio id. `frequencyGHz` is therefore the only observed cross-endpoint radio key.

The read model joins detail and statistics only when a frequency has exactly one overview entry and exactly one statistics entry. If a controller ever returns duplicate/ambiguous frequencies, Breeze keeps the raw typed entries but does **not** join them by array position or guess which statistic belongs to which radio.

This preserves the original proposal's "never array position" rule without assuming the vendor guarantees frequency uniqueness forever.

## 6. Collector algorithm and request budget

### 6.1 Existing list/detail behavior remains bounded

Sites, device lists and client lists keep their current bounded pagination behavior. The existing device-detail rotation remains capped at 32 device details per poll.

The device overview decoder retains the documented `features` and `interfaces` sets for candidate selection and publishes the bounded normalized sets in the v2 `device_list` row (section 5.1).

### 6.2 AP candidates

A device is eligible for `statistics/latest` when the current device overview identifies AP/radio capability from documented signals:

- `interfaces` contains `radios`; or
- `features` contains `accessPoint`.

A successful detail response with a non-empty `interfaces.radios` also confirms AP capability for that poll. Model-name heuristics (for example `U6*`/`E7*`) are forbidden.

### 6.3 Statistics budget

New statistics traffic is capped independently from the existing detail window.

Define a persisted token bucket plus a cadence cap:

```text
STATISTICS_TOKEN_CAPACITY          = 16
STATISTICS_TOKEN_REFILL_PER_MINUTE = 16
MAX_STATISTICS_REQUESTS_PER_POLL   = 16

cadenceBudget = min(
  MAX_STATISTICS_REQUESTS_PER_POLL,
  max(1, floor(pollIntervalSeconds * STATISTICS_TOKEN_REFILL_PER_MINUTE / 60))
)

statisticsBudgetPerPoll = min(cadenceBudget, floor(availableStatisticsTokens))
```

`availableStatisticsTokens` refills continuously at `16 / 60` tokens per second up to capacity 16. Each attempted `statistics/latest` request consumes one token; failures/404s still consume it because they consumed a controller request. Persist the token balance/refill timestamp with the statistics cursor so process restarts do not reset the request budget. A newly-created state may start at capacity, but the cadence cap still limits the first poll. `pollIntervalSeconds` here is the collector's configured scheduling interval **before** `BuildTopologyV1/V2` clamps the topology envelope's `expectedIntervalSeconds` to a minimum of 60 seconds; the envelope clamp must not inflate this request budget.

Examples:

| Collector poll interval | Maximum new stats calls per poll | Maximum new stats calls/minute |
|---:|---:|---:|
| 15 s | 4 | 16 |
| 30 s | 8 | 16 |
| 60 s | 16 | 16 |
| >60 s | 16 | <16 |

This is a deliberately conservative Breeze safety budget (16/min sustained, burst capacity 16), not a claim that every local controller has the same rate limit as the Site Manager connector. It adds at most half the existing 32-request detail window per 60-second poll and leaves substantial headroom relative to the contributor-observed 100 requests/minute connector cap. The local collector path's exact controller limit is not established by this spec, so raising the cap later requires evidence rather than assumption. No automatic retry may bypass the token bucket.

### 6.4 Fair rotation

- Sort AP targets by `(controllerSiteId, deviceId)`.
- Add a durable `statisticsCursor` plus token-bucket balance/refill timestamp beside the existing `detailCursor` in the per-collector topology state.
- Start each poll at that cursor, wrap once, and attempt at most `statisticsBudgetPerPoll` targets.
- Advance the cursor only past requests actually attempted. A deadline-skipped target remains eligible on the next poll.
- A changing AP set is handled by modulo-normalizing the cursor, as the detail rotation does today.

The cursor prevents ordering-based starvation among statistics targets. A target skipped because the shared enrichment deadline is exhausted keeps its turn (the cursor does not advance past it), so deadline pressure defers rather than silently drops that target.

### 6.5 Wall-clock bound and isolation

Statistics work shares the existing bounded per-device enrichment phase. Device details keep priority; statistics requests use only the remaining phase time. The feature does not create an unbounded second fan-out or extend a slow poll indefinitely.

Each `statistics/latest` request is isolated:

- one 404/unsupported device does not abort other APs;
- one 5xx/transport/decode failure does not discard successful AP rows;
- budget/deadline omissions are represented as partial/not-attempted coverage, never as zero-valued measurements.

## 7. Wireless client count

The AP client count is derived from the existing client list, not from a new controller call.

For each controller site:

1. use only a **complete** `client_list` result;
2. filter rows where `clientType == WIRELESS`;
3. group by non-null `uplinkDeviceId`;
4. for each device whose v2 capability evidence positively identifies it as Wi-Fi/AP-capable, materialize the resulting count; no matching wireless rows means a measured count of `0`;
5. `WIRED`, VPN, TELEPORT or unknown client types never contribute even if they have `uplinkDeviceId`.

If the client list is partial/failed, do not write a lower-bound count as if it were complete. Preserve the last materialized count and its observation timestamp until a later complete list refreshes it.

There is no client-per-radio count in this feature because the official client response has no radio/band key.

## 8. Persistence: one operator-facing current-state home

### 8.1 Decision

The topology v2 companion is the **validated transport and collection-evidence path**. The operator-facing current-state authority for this feature is the existing `unifi_device_telemetry` row.

Do not build a second Wi-Fi UI that queries `topology_collection_sources.current_baseline`, and do not create a new Wi-Fi table.

This choice resolves two current realities:

- `unifi_device_telemetry` is already where the existing Deep telemetry route/UI look for device health;
- a rotating partial topology baseline contains the current subset of rows, so using that baseline directly as the screen's cache would make unpolled APs disappear between rotations.

### 8.2 Materialization pattern

Follow the existing `ingestUnifiInterfaceTelemetry` pattern: after v2 resources are digest-validated, scope-resolved and accepted by the topology adapter, a separate savepoint materializes their current-state fields. A materialization failure is observable but must not change the structural topology receipt or legacy telemetry acceptance.

The Wi-Fi materializer consumes only resources that received an accepted topology receipt. It may combine the accepted `device_list` + complete `client_list` to derive wireless counts, and independently upsert accepted detail/statistics rows. This report-level merge avoids making resource processing order part of the data contract.

Materialization is scoped by the already-resolved collector/controller-site mapping **after the existing UniFi topology authority accepts that scope**. It never trusts an org/site from the upload. This spec does not relax the current `controller_site_other_org` fence: cross-org mappings remain legacy-only for these new fields. If the current-state row does not exist yet (topology ingest is synchronous and precedes the legacy queue), the materializer may insert the minimum `(collector, org, site, unifiDeviceId)` row with an empty `raw` placeholder; the legacy reconcile path later fills its legacy-owned identity/raw fields.

### 8.3 Existing table changes

Keep the current columns for their current meanings:

- `uptime_seconds`, `cpu_pct`, `mem_pct` receive v2 statistics values;
- `num_clients` is populated for AP rows with the complete **wireless** client count from section 7;
- `tx_bytes` and `rx_bytes` retain byte-counter semantics and are **not** used for rates;
- `poe_ports` is not populated or redefined by this feature; PoE collection remains owned by #7271.

Writer ownership is explicit because topology ingest happens synchronously before the legacy telemetry job is enqueued:

- when a request carries `topologyV2`, the v2 materializer is the sole writer for `uptime_seconds`, `cpu_pct`, `mem_pct`, `num_clients` and every new Wi-Fi field below;
- the route stamps an internal/server-owned v2-presence marker (or equivalent) onto the queued legacy payload; on that payload the legacy reconcile worker **must not** clear or overwrite the v2-owned columns, even when the v2 companion/resource was rejected — a rejected v2 attempt leaves the previous value and timestamp to become stale naturally;
- when no `topologyV2` companion is present (old/v1 agent), legacy reconcile keeps its current behavior for its existing fields;
- legacy identity/raw, `tx_bytes`/`rx_bytes`, stale lifecycle and current PoE ownership are unchanged by this spec.

This fence prevents the current legacy `undefined -> SQL NULL` behavior from erasing a v2 statistics value immediately after the topology transaction commits. The v2-presence marker is derived by the server from the companion field, never trusted from an arbitrary client flag.

Add bounded current-state fields to `unifi_device_telemetry` (column names are normative unless implementation finds an existing equivalent before coding):

- `controller_state` text — current typed UniFi device state from v2 `device_list`;
- `wifi_capable` nullable boolean — derived only from section 5.1 capability evidence;
- `device_inventory_observed_at` timestamp;
- `wifi_radio_overview` nullable `jsonb` — typed `WirelessRadioOverview[] | null`;
- `wifi_radio_statistics` nullable `jsonb` — typed `WirelessRadioStatistics[] | null`;
- `uplink_rx_rate_bps` bigint/number-safe representation;
- `uplink_tx_rate_bps` bigint/number-safe representation;
- `wifi_detail_observed_at` timestamp;
- `wifi_statistics_observed_at` timestamp;
- `wifi_clients_observed_at` timestamp;
- `statistics_last_heartbeat_at` timestamp;
- `statistics_next_heartbeat_at` timestamp.

The migration changes the existing table only; it creates no new table.

### 8.4 Partial resource semantics

For a **present row** in an accepted device/detail/statistics resource:

- write every field from that row;
- an explicit normalized `null` clears the previous value for that field;
- measured zero remains zero;
- update only that family's observed-at timestamp.

For a device **omitted from a partial resource because of rotation, request budget or deadline**:

- do not clear its last materialized values;
- do not advance its observed-at timestamp.

For a device that disappears from authoritative device inventory, existing stale/device lifecycle semantics remain responsible for marking/removing current-state presentation. This feature does not invent a second device lifecycle.

## 9. Freshness and operator semantics

Collection freshness and device state are different facts and must both be visible to the read model.

### 9.1 Source freshness

The topology pipeline's existing capture/effective/fresh-until logic remains authoritative for whether the accepted resource itself is fresh. The materialized per-family `*_observed_at` timestamps preserve when each AP's rotating row was actually refreshed.

`lastHeartbeatAt`/`nextHeartbeatAt` are retained as controller evidence, but this first Wi-Fi monitoring scope does not assume undocumented timing guarantees from them.

### 9.2 Offline AP with positive rate

The real fixture proves that an offline AP can return a positive uplink rate while CPU/memory/uptime are omitted.

Therefore:

- a positive rate must never be described as proof of current traffic;
- if the current device inventory state is not `ONLINE`, rate values are rendered as **last reported/stale** together with their statistics observation/heartbeat time;
- an omitted rate key materializes as `null` when that AP's statistics row was successfully read;
- no causal statement ("uplink saturated", "Wi-Fi slow because...") is derived from the value.

### 9.3 Missing versus zero

Across API, DB and UI:

- missing/unsupported/not-collected → `null` / `—`;
- measured `0` → `0`;
- `txRetriesPct: 0.0` must survive decoding, canonicalization, persistence and rendering as zero.

## 10. API/read model and UI

Keep the existing partner/operator surface: `GET /unifi/telemetry?siteId=` and **Integrations → UniFi → Deep telemetry**.

Extend the device read model with explicit names; do not overload byte fields:

- uptime / CPU / memory;
- `wirelessClientCount` (mapped from the AP's current materialized count);
- uplink RX/TX rate bps;
- radio overview + retry values;
- statistics/detail/client observation timestamps and heartbeat metadata;
- `controllerState`/Wi-Fi capability from the materialized v2 device inventory, plus existing stale state, so last-reported values can be labeled correctly.

The card should let an operator answer, per AP:

- online/offline and uptime;
- wireless-client count;
- radio band/frequency, channel, width and WLAN standard;
- TX retries per correlatable radio;
- CPU/memory;
- uplink RX/TX rate with honest freshness labeling.

Technical details stay operator-side. No customer-portal card is added in this wave.

## 11. Alerts

This feature collects and displays facts only.

Do not add retry/CPU/memory/AP-load alert evaluation here. #3208 is the alerting owner, and its maintainer-approved first scope is offline / firmware / PoE-fault; AP anomaly detection was explicitly deferred.

A future alert wave may consume the single current-state materialization defined here, but must use the consolidated alert-condition framework and its normal ownership/dedupe/authorization rules.

## 12. Security and tenancy

- Controller access remains official Network Integration API + API key, GET only.
- No reboot, channel change, client block, PoE action, firmware action or other write is introduced.
- Existing collector ownership, agent-role auth, topology producer epoch/source identity, controller-site mapping, org/site isolation and topology flags remain mandatory.
- The existing same-org topology authority boundary remains unchanged: `controller_site_other_org` is still rejected for topology/v2 materialization. Supporting cross-org UniFi topology is a separate authority/tenancy decision, not part of #7690.
- v2 materialization happens only after the same server-side collector/site scope resolution used by topology ingest. Uploaded org/site identifiers never become authority.
- The UI continues through existing partner-scope/read-permission gates; it does not read topology or DB state directly from the browser.
- No raw controller secret or credential is added to fixtures, topology rows, materialization or logs.

## 13. Failure and coverage semantics

The implementation must distinguish a controller fact from collection coverage:

- successful row, field omitted → row present, field `null`;
- measured zero → zero;
- endpoint 404 for an attempted AP → unsupported coverage for that attempt, not a zero row;
- one malformed/5xx/transport AP → partial statistics resource when other AP rows succeeded;
- AP not selected because of budget/deadline → omitted coverage, previous materialized row retained without refreshing its timestamp;
- partial client list → do not recompute wireless client counts;
- both `topologyV1` and `topologyV2` present → topology companion rejected as ambiguous; legacy telemetry still proceeds;
- malformed v2 companion/digest mismatch → v2 receipt rejected; legacy telemetry still proceeds;
- v2 disabled/not advertised → agent emits v1 and Wi-Fi v2 collection is not attempted.

Coverage/reason codes remain bounded lowercase topology reasons; implementation should reuse existing reasons (`limit_exceeded`, `request_failed`, `endpoint_unavailable`, etc.) where their semantics match instead of adding near-duplicates.

## 14. Tests and acceptance criteria

### 14.1 Shared contract / canonicalization

- v1 fixture canonical strings/digests remain unchanged.
- Add a real-evidence-derived v2 fixture (sanitized) covering:
  - 2.4/5/6 GHz;
  - channel present and absent;
  - WLAN standards observed in the supplied fixtures;
  - retries `0.0` and greater than zero;
  - CPU/memory/uptime present and absent;
  - uplink rates absent, zero and positive;
  - heartbeat timestamps present/absent;
  - offline AP with positive uplink rate.
- Go and TypeScript compute identical v2 resource digests.
- Nested radio ordering cannot change the digest after canonicalization.
- Missing `interfaces.radios` normalizes to `null`, while an explicit empty array remains `[]`, for both detail and statistics resources.
- Ambiguous duplicate-frequency radio rows are never correlated by array position.
- malformed percentages/rates/timestamps/row keys are rejected.

### 14.2 Agent

- decodes, bounds, sorts and publishes documented AP candidate signals without model-name heuristics;
- device/client pagination behavior remains unchanged;
- only AP candidates receive statistics requests;
- budget examples in section 6 are exact in tests (15/30/60/>60 seconds), and the persisted token bucket enforces the sustained cap across fast polls/restarts;
- durable statistics cursor rotates fairly and survives restart/epoch installation without resetting unrelated sequence/digest state;
- detail cap remains 32/poll;
- statistics work remains inside the bounded enrichment deadline;
- one stats 404/500/transport/decode error does not discard sibling successes;
- missing controller keys become nil/null; measured retry zero survives;
- WIRELESS-only client counting ignores a WIRED row with the same `uplinkDeviceId`;
- partial client list does not produce an authoritative count;
- v1 is emitted to `[1]`; v2 is emitted to `[1,2]`; no companion is emitted without topology authority/epoch as today.

### 14.3 API/topology ingest

- accepts existing v1 and new v2 simultaneously;
- v2 digest mismatch is rejected before materialization;
- exact collector/controller-site/org/site authority is preserved, including rejection of `controller_site_other_org`;
- accepted v2 detail/statistics side materialization is idempotent;
- materialization failure cannot flip an accepted structural receipt;
- present row + null clears old field; omitted row in a partial resource preserves value/timestamp;
- rate values never touch `tx_bytes`/`rx_bytes`;
- complete client list + accepted v2 device capability rows writes exact wireless counts including zero; partial client list leaves previous count untouched;
- a v2 request queued for legacy reconciliation cannot null/overwrite v2-owned uptime/CPU/memory/client-count/Wi-Fi columns; a v1/old-agent request retains existing legacy behavior;
- old agent + new API and new agent + old API compatibility paths are covered;
- a new agent that previously emitted v2 can fall back to v1 under the same valid producer authority/epoch after v2 advertisement is removed, without schema/digest ambiguity.

### 14.4 Database/export policy

- migration adds only the approved columns to `unifi_device_telemetry`; no new table;
- because `unifi_device_telemetry` is already in `CORE_TENANT_EXPORT_POLICY`, **every new column is classified in the same implementation PR**; scalar/timestamp/boolean fields are added to `included`, while `wifi_radio_overview` and `wifi_radio_statistics` are `jsonb` and therefore must be `excludedOpen` under the tenancy/export contract;
- the existing table already has its org-cascade, org-merge and RLS registrations, so this feature does not add a new tenancy shape or duplicate those registrations;
- capability/radio arrays are bounded/validated before persistence;
- tenant/site isolation integration tests cover the new materialization fields, including a cross-org mapping proving that v2 materialization is rejected while existing legacy telemetry routing remains unchanged.

### 14.5 Web

- Deep telemetry renders `—` for null and `0` for measured zero;
- offline AP + positive rate is labeled last-reported/stale, not current;
- radio detail/statistics join only on an unambiguous frequency;
- client count is labeled wireless clients, not all clients;
- no new customer-portal surface appears;
- translations and loading/empty/error states remain complete.

## 15. Implementation sequence after spec approval

This spec is the implementation plan; do not create a separate design document before coding unless the maintainer requests one.

1. **Contract + API compatibility:** shared v2 schemas/types/canonicalization/fixture, API dual-version parser/advertisement, topology v2 adapter support, DB migration and current-state materializer; keep v1 green.
2. **Agent collection:** candidate decoding, radio detail parsing, bounded statistics rotation/cursor, v2 builder/negotiation and fixture parity.
3. **Read model/UI:** extend `/unifi/telemetry`, Deep telemetry types/rendering and freshness labels.
4. **Integration/rollout verification:** mixed-version paths, tenancy, request-count tests, failure isolation, docs/changelog as required by the implementation PR.

Deployment follows section 4.4: API support before an agent release that can emit v2.

## 16. Explicit non-decisions / future work

This spec does not decide:

- when v1 support may eventually be removed;
- any threshold for "high" retry/CPU/memory;
- any AP anomaly alert policy;
- radio history retention;
- a customer-facing Wi-Fi dashboard;
- per-port traffic rates or firewall monitoring.

Those require separate evidence/spec ownership rather than being smuggled into this feature.

## 17. Fixture acknowledgement

The supported-version controller evidence that unblocked this spec was contributed by **@bgatestmg**: [AP radio/statistics fixtures](https://github.com/LanternOps/breeze/discussions/7690#discussioncomment-18961621), [client/switch boundary observations](https://github.com/LanternOps/breeze/discussions/7690#discussioncomment-18961724), and the separate [PoE fixture on #7271](https://github.com/LanternOps/breeze/issues/7271#issuecomment-6205243573). The spec commit should include the contributor as `Co-authored-by` using the verified GitHub-provided no-reply identity rather than an invented/private email.
