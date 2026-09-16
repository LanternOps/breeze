# Network device page truth: sourced reachability, SNMP collection health, one settings surface

Status: **approved in chat by Todd 2026-09-16** (design sections D1–D9; spec, plans and registration approved in the same session).
Advisor quorum: Fable position formed, codex gpt-6-astra xhigh read-only review received;
six contract disagreements resolved in codex's favour on the evidence, one split (D5 Xerox alias)
resolved by the owner's explicit ask. See "Quorum record" (§18).
Tracking: LanternOps/breeze#5988 (waves #5989 W01, #5990 W02, #5991 W03, #5992 W04, #5993 W05).
Plan: `docs/superpowers/plans/monitoring/2026-09-16-network-device-page-truth.md` (index, one plan per wave).
Origin: Impeccable critique of `/devices/network/:id`, 17/40, snapshot
`.impeccable/critique/2026-09-16T00-06-55Z__nents-devices-networkdevicedetailpage-tsx-5ed5d8ce.md` (gitignored, local).
Prior decisions this builds on: `2026-08-08-asset-link-lifecycle-design.md` (device page is the single
link surface), `2026-08-08-proxy-access-consolidation-design.md` (device page is the single proxy
surface), `2026-09-08-monitoring-automation-unification-design.md` (#5287; network monitoring page now
at `/monitoring/network`; SNMP monitor kinds deferred to "a later spec", which this is not: this spec
covers collection and presentation, not monitor kinds).

## 1. Problem and goal

`/devices/network/:id` (`apps/web/src/components/devices/NetworkDeviceDetailPage.tsx`) renders the
discovery scan's snapshot and calls it the device. Verified against main (8b21b0470):

- **F1. Status is the last subnet sweep.** `discovered_assets.is_online` / `last_seen_at` are written
  only by `jobs/discoveryWorker.ts` (seen: online + last_seen; disappeared sweep: online=false without
  touching last_seen, `:1287`) and the UniFi services (`unifiSyncService.ts:168`,
  `unifiTelemetryService.ts:68`). The SNMP poller (`jobs/snmpWorker.ts`) and the network-check worker
  (`jobs/monitorWorker.ts`) write their own tables (`snmp_devices`, `snmp_metrics`, `network_monitors`,
  `network_monitor_results`) and never the asset row. "Online · as of 19 hr ago" is a 19-hour-old scan.
- **F2. "SNMP monitoring: Enabled" can poll nothing.** `snmpWorker.ts` takes OIDs only from the assigned
  `snmp_templates.oids`; a device with no template hits `{ status: 'no-oids' }`, logs a `console.warn`,
  does not dispatch, and `last_status` stays null. Nothing on any page says so.
- **F3. Table OIDs have never collected.** `agent/internal/snmppoll/metrics.go` `CollectMetrics` issues one
  `GetMulti`; 145 of the ~407 built-in template OIDs are SNMP table columns (every Printer-MIB supply and
  page-count OID, every ifTable column). A GET on a column OID returns `noSuchObject`, `parseValue`
  yields nil, and the row is stored as `value_type = 'null'`. `client.BulkWalk` exists but only topology
  discovery uses it. The server also drops the template's per-OID `type` when it builds the poll
  command (`oids = template.oids.map(o => o.oid)`), so the agent cannot know which OIDs to walk.
- **F4. No per-OID outcome.** `SNMPMetric{OID, Name, Value, Timestamp, ValueEncoding}` has no error
  field; a poll is all-or-nothing at transport level.
- **F5. Identity shows scanner internals.** `agent/internal/discovery/classify.go:45` writes
  `model = sysObjectID` when nothing better is known; manufacturer falls back to the MAC OUI vendor.
  A Xerox C325 (Lexmark-built engine, OUI Lexmark, sysObjectID under IANA enterprise 253 = Xerox)
  renders Model `.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1` and Manufacturer `LEXMARK INTERNATIONAL, INC.`.
  No code maps enterprise numbers.
- **F6. Three surfaces edit one object.** Discovery `AssetDetailModal.tsx` (name/type/notes/tags,
  embedded SNMP enable form, delete), Monitoring `EditMonitoringModal` inside
  `MonitoringAssetsDashboard.tsx` (SNMP creds/interval/template, recent-metrics table, disable), and the
  device page (type select, link/unlink, proxy). Each has a different form idiom; nothing owns the whole.
- **F7. Dead chrome.** The "Approved" badge is always true on list-reachable pages
  (`routes/devices/network.ts:225` filters approved), but the route loads any asset id and Discovery
  deep-links pending ones, where the badge is the only signal and carries no action.

Goal: the page answers "is this device OK, and if not, why" from live monitoring data, with every
status claim carrying its source and age; SNMP collection is visibly healthy or visibly broken per
OID; printers show supplies and page counts; one settings surface owns the asset and the other two
pages launch it.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | Reachability | **Derived at read time** by one service from the sources' own last-observation state, ranked by evidence class (host probes > SNMP > scan/UniFi). Two provenance columns on the asset (`status_observed_at`, `status_source`); `is_online` semantics untouched. Materialised `reachability_*` columns written by four pipelines rejected (clobber ordering, UniFi already writes `is_online` unconditionally). |
| D2 | Check now | `POST /discovery/assets/:id/probe`: site-strict executor, 8 s wait then `pending`, result persisted on the asset (`last_probe_at`, `last_probe_status`), correlated to the dispatch. |
| D3 | Poll health | `snmp_devices.last_status = 'no_template'` (no backoff increment); per-OID `collection` state on the monitoring asset route, derived from data with explicit `unknown`. |
| D4 | Agent acquisition | Additive wire field `oidSpecs` with explicit `get`/`walk` and cadence; `oids: string[]` unchanged for old agents. Bounded walks, instance rows with `baseOid`, per-OID errors. Server ingestion ships first. Composite metrics index + retention reaper. |
| D5 | Template selection | `snmp_templates.sys_object_id_prefixes text[]`; boundary-aware prefix match, ties broken by device type then the longer prefix, equal-rank ties return null (never a guess); applied only on create when `templateId` is absent and the row would otherwise have none; suggestions scoped to built-ins + the org's own. New built-in "Xerox Printer" (RFC 3805 set, vendor Xerox, prefix 1.3.6.1.4.1.253). |
| D6 | Identity | Server-side at scan ingest: enterprise number → manufacturer; model from tested vendor-family extractors, else unknown, never the raw OID; `nicVendor` derived at read; manual identity precedence preserved. |
| D7 | Ownership | The device page owns the asset through one `NetworkAssetSettingsModal` (Identity · Monitoring · Link · Danger). Discovery and `/monitoring/network` become launchers. One web mutation module, contract-tested. |
| D8 | Page IA | Overview row 1: type-specific Health card + Reachability & collection card; row 2: condensed Identity with "All scan details"; row 3: open ports. Stat strip: Reachability · Last poll · type slot · Open ports. Monitoring tab: poll config, OID table with state, history charts, checks. No per-type tabs. |
| D9 | Approval | Badge hidden when approved; pending/dismissed render an action banner (Approve · Dismiss). Unknown status renders muted, not as dismissed. |

## 3. Scope and non-goals

In scope: everything in §4–§11 for discovered network assets (`discovered_assets`), including manual
network assets (#5213), across API, agent, and the MSP web app. Out of scope: SNMP threshold monitors
as `monitor_kind`s (the unification spec's deferred item); per-type tabs; a custom-template editor
redesign; UniFi topology; changing `snmp_metrics` from a row-per-sample table to a time-series store
(a retention reaper and a composite index are enough for this scope; a Timescale hypertable is noted as
a follow-up if volume demands it); the customer portal.

## 4. Reachability (D1)

### 4.1 Sources and observations

`apps/api/src/services/assetReachability.ts` exports `deriveReachability(input): Reachability`, pure,
no I/O. Input is assembled by the callers (single-asset route, list route, AI tools) from:

| Source | Class | Positive observation | Negative observation | Observed at | Freshness window |
|---|---|---|---|---|---|
| `network_check` (`network_monitors` rows with `asset_id`, types `icmp_ping`, `tcp_port` only) | host | `last_status = 'online'` or `'degraded'` | `last_status = 'offline'` | `last_checked` | 2 × `polling_interval`, min 5 min |
| `probe` (manual, §5) | host | `last_probe_status = 'ok'` | `'failed'` | `last_probe_at` | 15 min |
| `scan` (discovery) | host | `is_online = true` | `is_online = false` (disappeared sweep) | `status_observed_at` | 2 × the profile's schedule interval when known, else 24 h |
| `unifi` | host | `is_online = true` | `is_online = false` | `status_observed_at` | 60 min |
| `snmp` (`snmp_devices` for the asset) | protocol | `last_status = 'online'` | none; failures are protocol-level | `last_polled` (success) / `last_poll_attempted_at` (failure) | 2 × `polling_interval`, min 10 min |

`http_check` and `dns_check` monitors never contribute: a TLS or DNS failure is not host evidence
(`agent/internal/heartbeat/handlers_monitor.go:264`). `snmp_devices.last_status` in
`offline | no_template | asset_missing | asset_no_site | no_agent_in_site | warning` is reported in
`detail` but never produces `not_responding` on its own: `consecutive_failures` increments at dispatch
(`snmpWorker.ts` `markPollDispatched`), so `offline` can mean the bridging agent, not the device.

### 4.2 Rules

1. Collect the freshest positive observation across all sources (`P`) and the freshest host-class
   negative observation (`N`), each only if inside its freshness window.
2. If both exist, the more recent wins: `responding` (source = P's) or `not_responding` (source = N's).
3. If only one exists, it wins.
4. If neither is inside its window: `unverified`; `lastKnown` carries the freshest observation of any
   age with its state, so the UI can say "Unverified · last seen by scan 19 h ago".
5. A fresh SNMP success is a positive observation (an SNMP reply proves reachability). A fresh SNMP
   failure only adds `detail.snmp = { state: 'failing' | 'no_template' | 'no_agent' | 'asset_moved', since }`.

Output:

```ts
type ReachabilityState = 'responding' | 'not_responding' | 'unverified';
type ReachabilitySource = 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp';
type Reachability = {
  state: ReachabilityState;
  source: ReachabilitySource | null;      // null only when unverified with no observation at all
  observedAt: string | null;              // ISO
  lastKnown: { state: 'responding' | 'not_responding'; source: ReachabilitySource; observedAt: string } | null;
  detail: {
    networkCheck?: { state: 'online' | 'degraded' | 'offline'; observedAt: string; responseMs: number | null; monitorId: string };
    probe?: { state: 'ok' | 'failed' | 'pending'; observedAt: string | null; responseMs: number | null };
    snmp?: { state: 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled'; observedAt: string | null; consecutiveFailures: number };
    scan?: { state: 'seen' | 'missed'; observedAt: string | null; source: 'scan' | 'unifi' };
  };
};
```

### 4.3 Provenance columns and writers

`discovered_assets` gains `status_observed_at timestamptz NULL` and `status_source varchar(16) NULL`
(`'scan' | 'unifi'`). Stamped wherever `is_online` is written today: scan seen (`discoveryWorker.ts`
`buildScanUpdateSet`), disappeared sweep (`:1287`), auto-approve decision (`:1157`),
`unifiSyncService.ts:168`, `unifiTelemetryService.ts:68`. Manual asset creation
(`routes/devices/network.ts:390`) leaves both NULL. `last_seen_at` keeps its meaning (last positive
sighting) and is not changed. Rows that predate the columns: an undated `is_online = false` is no
observation at all (the sweep never stamped anything, so its age is unknowable), while an undated
`is_online = true` falls back to `last_seen_at`, labelled `scan`. An inactive SNMP device contributes
nothing; a cron-scheduled discovery profile gets the 24 h window (only `interval` schedules yield a
cadence).

### 4.4 Consumers (all switch in W01)

- `GET /discovery/assets/:id` (`routes/discovery.ts:1173`) adds `reachability`.
- `GET /devices/network` (`routes/devices/network.ts:68`): `status` becomes
  `reachability.state` mapped to the list's `online | offline | unknown` (`unverified → unknown`);
  the row also carries `reachability` so the devices list can show source and age on hover.
- `GET /monitoring/assets` and `/assets/:id` (`routes/monitoring.ts:234,270`) add `reachability`.
- `routes/discovery.ts:1825` (asset status export) uses the same mapping.
- No AI tool reports asset online state today (enumerated against main). `query_monitors`
  (`services/aiToolsMonitoring.ts`) gains `assetReachability` per asset, and a Tier-1 read-only
  `get_network_asset_reachability` tool is added; both phrase the source ("responding via SNMP 2 minutes
  ago"), never a bare "online".
- `is_online` stays available on every response for one release and is documented as
  "last scan/controller verdict".

## 5. Check now (D2)

`POST /discovery/assets/:id/probe` (auth: same org/site rules as the monitoring mutations,
`resolveAssetForMonitoringMutation` pattern in `routes/monitoring.ts`).

1. Resolve and lock the asset row; require `ip_address` and `site_id`. Select an online, non-ephemeral
   agent in the asset's site (`selectExecutionAgentForMonitor` extracted to
   `services/networkExecutorSelection.ts` and shared by the monitor worker, the monitors `/test`
   route, and this probe; no org-wide fallback for asset-bound work, and Quick Support ephemeral agents
   are never executors; sharing the picker means the monitors `/test` route loses its org-wide fallback
   and gains the ephemeral exclusion, a behaviour change the W01 PR calls out). No agent → 409
   `{ code: 'NO_AGENT_IN_SITE' }`. The probe's asset and site ids ride the command payload so the
   socket-holding API instance can record the result expectation; the 8 s await is instance-local and
   best-effort, the persisted stamp is the contract.
2. Insert a pending probe stamp on the asset: `last_probe_at = now()`, `last_probe_status = 'pending'`,
   `last_probe_ref = <command id>`.
3. Dispatch `network_ping` (existing agent command, `services/monitorCommands.ts` mapping) and await
   the result for up to 8 s. On result: verify the command id matches `last_probe_ref` and the asset's
   `ip_address`/`site_id` are unchanged, then write `last_probe_status = 'ok' | 'failed'`,
   `last_probe_response_ms`. Return `{ probe: { state, responseMs, observedAt, agentId }, reachability }`.
4. On timeout return `202 { probe: { state: 'pending' }, reachability }`; the late result is written by
   the command-result handler (`services/commandResultHandlers.ts`, new `probe` correlation kind, same
   orphan-expectation mechanism the SNMP result uses), and the page re-fetches the asset every 3 s for
   up to 60 s while `pending`.
5. A stale `pending` older than 2 min is treated as `failed` by `deriveReachability` (agent never answered).

New columns on `discovered_assets`: `last_probe_at timestamptz`, `last_probe_status varchar(12)`,
`last_probe_response_ms integer`, `last_probe_ref varchar(80)`. Rate limit: one in-flight probe per
asset (409 `PROBE_IN_FLIGHT` while `pending` and younger than 2 min).

## 6. SNMP collection health (D3)

### 6.1 Durable "no template"

In `snmpWorker.ts`, the `no-oids` branch writes `snmp_devices.last_status = 'no_template'` and
`last_poll_attempted_at = now()` and does **not** touch `consecutive_failures` (the scheduler contract
in `snmpWorkerScheduler.test.ts` excludes no-OIDs from backoff and stays green). A later successful
poll clears it like any other status. `no_template` joins the site-authority family in the same
`last_status varchar(20)`.

### 6.2 Per-OID collection state

`GET /monitoring/assets/:id` gains:

```ts
collection: {
  templateId: string | null;
  lastPolledAt: string | null;
  pollingInterval: number | null;
  status: 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled' | 'paused';
  consecutiveFailures: number;
  oids: Array<{
    baseOid: string; name: string; mode: 'get' | 'walk'; cadence: 'fast' | 'slow';
    state: 'collecting' | 'unsupported' | 'stale' | 'never_polled' | 'unknown';
    observedAt: string | null;
    instances: Array<{ oid: string; instance: string; value: string | null; valueType: string; observedAt: string }>; // ≤ 64 per base OID here; full set via /metrics
    error: string | null;   // last per-OID error (W02 agents), e.g. 'noSuchObject'
  }>;
}
```

Derivation (`services/snmpCollectionState.ts`, pure): for each template entry, the latest
`snmp_metrics` rows whose `base_oid` (W01 column, §7.3) equals the entry's OID, or whose `oid` equals it
for legacy rows. `collecting` = a non-null, non-error value inside 2 × polling interval;
`unsupported` = the latest row is an error row (`value_type = 'error'`); `stale` = last good value
older than the window; `never_polled` = no rows and the device has never succeeded; `unknown` = rows
exist but the latest value is null with no error (legacy agents' table GETs). The UI explains
`unknown` on a table-mode OID as "This agent version cannot read table values; update the agent".

### 6.3 Metric history

`GET /monitoring/assets/:id/metrics?oid=<base or instance oids, CSV of up to 64>&from=&to=&bucket=<auto|1m|5m|1h|1d>`
returns `{ series: [{ oid, instance, name, points: [[ts, value]] }] }`, server-side bucketed by
epoch-floor arithmetic (`date_trunc` has no 5-minute unit) with `avg` for gauges and `max` for counters (the template entry's `type` decides; counters
are additionally returned as reset-aware deltas when `&delta=1`). Hard caps: 90-day range, 2 000 points
per series, 64 series per request. Requires the composite index of §7.4.

## 7. Poll wire contract and agent acquisition (D4)

### 7.1 Command payload (server → agent)

`buildSnmpPollCommand` keeps every existing field and `oids: string[]` exactly as today and adds:

```json
"oidSpecs": [
  { "oid": "1.3.6.1.2.1.1.3.0",       "name": "sysUpTime",             "mode": "get",  "cadence": "fast" },
  { "oid": "1.3.6.1.2.1.43.11.1.1.9", "name": "prtMarkerSuppliesLevel", "mode": "walk", "cadence": "fast" },
  { "oid": "1.3.6.1.2.1.2.2.1.2",     "name": "ifDescr",               "mode": "walk", "cadence": "slow" }
],
"limits": { "maxRowsPerOid": 512, "maxRowsPerPoll": 4096, "maxBytesPerPoll": 1048576, "maxDurationMs": 20000 }
```

`mode` comes from the template entry's new optional `mode` field; default `get` when the OID ends in
`.0`, else `walk` (the seed's scalars all end in `.0`; its columns never do; `type` is a value type and
cannot decide acquisition, `ifHCInOctets` is `counter64` and a column). `cadence` from the entry's
optional `cadence`; default `fast`; the seed marks static columns (`ifDescr`, `ifName`, `ifSpeed`,
`prtInputName`, `prtMarkerSuppliesDescription`, `prtMarkerSuppliesType`, `prtMarkerColorantValue`)
`slow`. `slow` specs are included only on every 12th dispatch for the device (`snmp_devices.poll_seq`
counter, W01 column; the gate reads the pre-increment value so a new device gets its static columns on
its first poll, and an all-`slow` template still dispatches its specs on every poll rather than an empty
list), so a 5-minute device refreshes names hourly. Old agents ignore both new fields
(`tools.GetPayloadStringSlice` reads `oids` only) and keep their current behaviour.

### 7.2 Result payload (agent → server)

New agents set `"protocol": 2` on the result and emit:

```json
{ "oid": "1.3.6.1.2.1.43.11.1.1.9.1.1", "baseOid": "1.3.6.1.2.1.43.11.1.1.9", "instance": "1.1",
  "name": "prtMarkerSuppliesLevel", "value": 37, "timestamp": "…" }
{ "oid": "1.3.6.1.2.1.25.3.5.1.1", "baseOid": "1.3.6.1.2.1.25.3.5.1.1", "instance": "",
  "name": "hrPrinterStatus", "value": null, "error": "noSuchObject", "timestamp": "…" }
```

Errors: `noSuchObject`, `noSuchInstance`, `endOfMib`, `timeout`, `truncated` (a walk hit a bound; the
rows before the bound are still emitted). A walk that yields no PDU emits one `noSuchObject` row for
the base OID: gosnmp ends a walk on NoSuchObject / NoSuchInstance / EndOfMibView without invoking the
callback, so an unimplemented table would otherwise be indistinguishable from an empty one and the OID
could never leave `never_polled`. A walk transport error becomes a per-OID `timeout` row and the poll
continues. A failed GET batch still returns one top-level error as today. Absence of `protocol` means legacy shape; the server treats every legacy row as
`baseOid = oid`, `instance = ''`.

### 7.3 Ingestion (W01, before any agent ships)

`snmp_metrics` gains `base_oid varchar(200) NULL`, `instance varchar(64) NULL`,
`error varchar(32) NULL`; `value_type` gains the value `'error'`. `processPollResults` writes the new
fields when present, stores error rows with `value = NULL, value_type = 'error', error = <code>`, and
counts a poll as a success (`last_status = 'online'`, failures reset) when at least one non-error row
arrived; a poll where every row is an error sets `last_status = 'warning'` and does not reset
`consecutive_failures`. Backfill of `base_oid` for existing rows: none (legacy rows are matched by
`oid`, §6.2).

### 7.4 Agent implementation (W02)

`agent/internal/snmppoll/metrics.go`: `CollectMetrics` reads `oidSpecs` when present (else the legacy
`oids` as `get`). `get` specs go in one `GetMulti`; each `walk` spec uses a new bounded streaming walk
(`WalkBounded(root, fn)` over gosnmp's callback `BulkWalk`; the existing `BulkWalk` helper wraps
`BulkWalkAll`, which buffers the whole subtree and cannot honour a bound) with the limits enforced per
OID and per poll (rows, bytes, wall clock); PDU types `NoSuchObject`,
`NoSuchInstance`, `EndOfMibView` become error rows instead of nil values. `SNMPMetric` gains
`BaseOID`, `Instance`, `Error`. `handleSnmpPoll` sets `protocol: 2`. Tests use a gosnmp fake with
scalar, column, and unsupported OIDs and assert bounds and error rows. Volume note: a 48-port switch
with ten walked columns at 5 min is ~138 k rows/day; the `slow` cadence removes the static columns,
the bounds cap the rest, and the reaper below keeps the table bounded.

### 7.5 Index and retention (W01)

Migration adds `snmp_metrics (device_id, oid, timestamp DESC)` (a `-- @no-transaction` file using
`CREATE INDEX CONCURRENTLY IF NOT EXISTS`, with an operator note to pre-build it on large production
tables) and drops nothing. Retention already exists: `jobs/snmpRetention.ts` is ctid-batched, driven by
`SNMP_METRICS_RETENTION_DAYS`, logs counts and runs four times a day from the schedule registry, so no
second job is added (it would double-delete and fail `scheduleRegistry.contract.test.ts`). Its default
rises from 7 to 30 days so the 30-day charts and the 90-day range are not structurally empty. Alert
thresholds (`snmp_alert_thresholds`) are unaffected.

## 8. Template suggestion and the Xerox template (D5)

- `snmp_templates.sys_object_id_prefixes text[] NOT NULL DEFAULT '{}'`, seeded on built-ins by name in
  one migration (idempotent `UPDATE … WHERE name = … AND is_built_in AND sys_object_id_prefixes = '{}'`,
  system scope elected first). Enterprise prefixes are `1.3.6.1.4.1.<PEN>`; the plan verifies each PEN
  against the IANA registry before seeding. Some built-ins share a vendor (Cisco IOS Switch / IOS
  Router / ASA / Meraki): ties on prefix are broken by `device_type` matching the asset's type, then by
  the longer prefix (Meraki and ASA carry product-specific sub-prefixes).
- `services/snmpTemplateSuggest.ts` exports `suggestTemplate({ sysObjectId, assetType, orgId })`:
  normalises both sides (strip leading `.`, split on `.`), requires component-boundary matches, searches
  built-ins plus the org's own templates, returns `{ templateId, reason }` or null.
- `GET /monitoring/templates/suggest?assetId=` returns the suggestion; `PUT /monitoring/assets/:id/snmp`
  with `templateId` absent from the body applies it when the row would otherwise have no template and
  echoes `templateSuggestion: { templateId, templateName, reason, applied }`; an absent `templateId` on a
  row that already has one preserves it (today `body.templateId ?? null` silently clears it; the W03 PR
  calls out the change); `templateId: null` on PUT or PATCH still means "no template" (existing
  null-as-unset semantics at `monitoring.ts:612` preserved). Equal-rank ties (the three Cisco built-ins
  all claim `1.3.6.1.4.1.9`) return null rather than an alphabetical winner. `routes/snmp.ts` `oidSchema`
  accepts the optional `mode` and `cadence` keys so custom templates keep them. The settings modal pre-selects the suggestion with the reason line
  ("Detected Xerox printer, using Xerox Printer (RFC 3805)").
- New built-in **"Xerox Printer"**: the "Generic Printer (RFC 3805)" OID set, `vendor = 'Xerox'`,
  `device_type = 'printer'`, prefix `1.3.6.1.4.1.253`. "Lexmark Printer" gets `1.3.6.1.4.1.641`,
  "Brother Printer" `1.3.6.1.4.1.2435`, "Generic Printer" no prefix (fallback by device type). All
  printer templates' table entries get `mode: walk`; static supply descriptors get `cadence: slow`.

## 9. Identity resolution (D6)

`services/assetIdentity.ts` (created in W01 with the mask and NIC-vendor helpers) gains
`resolveAssetIdentity({ sysObjectId, sysDescr, snmpData, macVendor, current })`:

- Manufacturer: IANA enterprise number → vendor name (a code table `services/ianaEnterprise.ts`,
  seeded with the vendors in §8 plus Canon, Epson, Kyocera, Ricoh, Konica Minolta, Sharp, Zebra,
  Ubiquiti, Netgear, TP-Link, Juniper, Dell, Lenovo, Supermicro; each verified against IANA in the plan).
  Generic-agent numbers (net-snmp 8072) are skipped for manufacturer. Falls back to the existing sysDescr
  keyword rules (with `hp` matched on a word boundary so "Sharp" no longer reads as HP), then to the OUI
  vendor. The OUI vendor is always
  exposed separately as `nicVendor` on the asset responses (derived at read from `mac_address`).
- Model: per vendor family, tested extractors only: Xerox and Lexmark (text before the first `;` in
  sysDescr, e.g. `Xerox(R) C325 Color MFP`), Brother (`Brother NC-… , Firmware …` → the `MFC-…`/`HL-…`
  token), HP printers (`HP LaserJet …` up to the first `,`), Cisco (`sysDescr` `Cisco IOS Software, C3750
  …` → the `C3750` token via the existing classifier rule), everything else: `prtGeneralPrinterName` or
  `hrDeviceDescr` when polled, else null. The raw sysObjectID is never written to `model`.
- Precedence: manual rows (`source = 'manual'`) and operator-edited fields keep the existing guards in
  `buildScanUpdateSet` (`discoveryWorker.ts:709`); resolution only fills or corrects scan-authored values.
- Read-time guard (W01, before W03 lands): every asset response masks a `model` that matches
  `/^\.?1(\.\d+)+$/` to null and exposes it as `snmpData.sysObjectId` only.
- Agent: `classify.go` stops assigning `sysObjectID` to `model` (one line); the server rule is the
  source of truth for old and new agents alike.

## 10. Web: one settings surface (D7)

`apps/web/src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.tsx` (Dialog,
`maxWidth="4xl"`, the rail plus the SNMP credential grid needs it; left section rail on desktop, stacked
on mobile; the modal takes no device list, the Link section's picker fetches its own site-scoped list),
sections saved independently with their own Save/Cancel and `runAction`:

| Section | Fields | Writes |
|---|---|---|
| Identity | display name; type (grouped select over the 12 types `updateAssetSchema` accepts at `discovery.ts:434`; `website` and `service` exist in the enum and in `typeConfig` but the PATCH route rejects them, a pre-existing latent 400 in today's editors, so an asset already typed that way shows it selected-but-disabled with a note; groups Endpoints / Network gear / Peripherals / Other, detected type shown as anchor, "Reset to detected" when manual, consequence line "Changes the suggested SNMP template"); tags; notes | `PATCH /discovery/assets/:id` |
| Monitoring | SNMP: enable toggle, version, community / v3 credentials (masked, blank keeps current), port, polling interval, template (suggestion pre-selected with reason), pause/resume; Network checks: list with state, add (existing `CreateMonitorForm`), remove | `PUT`/`PATCH /monitoring/assets/:id/snmp`, `DELETE /monitoring/assets/:id`, `/monitors` |
| Link | "Same device as X (auto-detected / set manually)", Unlink (confirm), Link manually (existing `LinkManuallyControl`), suppressed-state line | `/discovery/assets/:id/link` |
| Danger | Approve (when pending or dismissed), Dismiss (with the pending/dismissed explanation), Delete asset (typed confirmation, lists what cascades) | `PATCH …/approve`, `PATCH …/dismiss`, `DELETE /discovery/assets/:id` |

- Single writer: `networkDevice/settings/useNetworkAssetMutations.ts` is the only module in
  `apps/web` that calls those endpoints (including the banner's Approve/Dismiss); `apps/web/src/lib/__tests__/network-asset-single-writer.test.ts`
  greps the tree and fails on any other caller (same shape as `no-silent-mutations.test.ts`).
- Entry points: a **Settings** button beside Open Web UI in `NetworkDeviceHeader`; Discovery asset rows
  and `/monitoring/network` rows get "Settings…" in their row menu, navigating to
  `/devices/network/:id#overview/settings/monitoring`. The hash grammar is
  `#<tab>[/settings/<section>]`; the existing parser (`NetworkDeviceDetailPage.tsx:49`, splits on `/`)
  is extended, tab-only hashes keep working, closing the modal rewrites the hash to `#<tab>`.
- `AssetDetailModal` (Discovery) loses its forms and its embedded `AssetMonitoringSection` /
  `EnableMonitoringForm`; it becomes a read-only peek (identity, reachability line, open ports, SNMP
  summary) with "Open device page" and "Settings…". Approve / Dismiss / Delete stay on the Discovery
  list rows and bulk bar (triage is Discovery's job). `EditMonitoringModal` in
  `MonitoringAssetsDashboard.tsx` is deleted; that table keeps pause / resume / disable row actions and
  gains reachability + collection status columns. `EnableMonitoringForm.tsx` and
  `AssetMonitoringSection.tsx` are deleted once the modal's Monitoring section replaces them.
- Copy rules: no bare "Online"; every status string is `<state> · <source> <relative time>`.

## 11. Web: page IA (D8, D9)

- **Header**: name, type badge, reachability badge (`Responding · SNMP 2 min ago`), site · IP · MAC ·
  manufacturer with `·` separators; actions: Open Web UI (primary), **Settings**, "Manage in
  Discovery" removed (the page owns the asset now). Approval badge only when not approved; pending /
  dismissed render a banner above the header: "Pending approval: nothing is monitored yet. [Approve]
  [Dismiss]" / "Dismissed: hidden from device lists. [Approve]".
- **Stat strip** (`NetworkDeviceStats`): Reachability (state + source + age, "Check now" link) ·
  Last poll (age + status word, links to the Monitoring tab) · type slot (printer: lowest supply "Cyan
  toner 12 %"; switch: "41 / 48 ports up"; else: ping from the freshest host observation with its age;
  a UPS slot waits for a `ups` asset type, which the enum lacks, and is a listed follow-up) · Open ports (existing shortcut). "Linked device" leaves the strip.
- **Overview row 1**: `HealthCard` (2/3) renders by type through a registry
  (`networkDevice/health/index.ts`): `PrinterHealth` (supplies as labelled meters from
  `prtMarkerSuppliesLevel` / `MaxCapacity` / `Description` / `ColorantValue`, negative levels shown as
  "unknown"; lifetime pages from `prtMarkerLifeCount` with "since yesterday / since last week" deltas
  from `/metrics?delta=1`; printer status words from `hrPrinterStatus` / `hrDeviceStatus` /
  `hrPrinterDetectedErrorState` bitmask decoded), `GenericHealth` (the template's key OIDs as a
  compact table), and an `EmptyHealth` that is the "Set up monitoring" affordance when no SNMP device
  exists. `ReachabilityCard` (1/3): the D1 detail lines, collection summary (n collecting / n
  unsupported / n stale), "Check now", agent that bridges the polls.
- **Overview row 2**: Identity (name, IP/MAC with copy buttons, make/model, `NIC vendor` when it differs
  from manufacturer, site, "Same device as X"), "All scan details" disclosure (hostname, NetBIOS, OS
  fingerprint, first seen, discovery methods, profile, raw sysObjectID, `is_online` legacy verdict).
- **Overview row 3**: `OpenPortsSection` unchanged.
- **Monitoring tab**: poll configuration summary with "Edit" (opens the modal's Monitoring section),
  OID table (name, base OID, mode, state, latest value, age; instance rows expandable), history charts
  (`ChartWidget`, 24 h / 7 d / 30 d, one chart per selected OID; counters as deltas), network checks
  with their latest results, SNMP threshold alerts list (read through a new
  `GET /monitoring/assets/:id/thresholds`, since `/snmp/thresholds/:deviceId` is a 410 stub; the tenant
  comes from the joined `snmp_devices` row because `snmp_alert_thresholds` has no `org_id`). `EmptyHealth`
  renders only when no SNMP device exists or it is disabled; a device with SNMP but `no_template` keeps
  its type card, which explains that failure.
- **Formatting**: timestamps use the site's timezone when the asset has a site with one (`siteTimezone`
  added to `GET /discovery/assets/:id` from the `sites` join it already makes), else the browser's; the
  page's `formatTimestamp` drops seconds everywhere; every relative time has an absolute `title`.
- **Accessibility**: the type select gets a real `<label>`; Save/Cancel pending state is announced
  through the existing live region; the stat-strip buttons move focus to their target; tabpanels use
  `aria-labelledby`; empty values render `—` with `aria-label="unknown"`.

## 12. API surface summary

| Route | Change |
|---|---|
| `GET /discovery/assets/:id` | + `reachability`, `nicVendor`, `probe`, `siteTimezone`; `model` masked when OID-shaped |
| `GET /discovery/assets` and `GET /devices/network` | + `reachability`; `status` derived from it |
| `POST /discovery/assets/:id/probe` | new (§5) |
| `GET /monitoring/assets`, `/assets/:id` | + `reachability`, `collection` (§6.2) |
| `GET /monitoring/assets/:id/metrics` | new (§6.3) |
| `GET /monitoring/templates/suggest` | new (§8) |
| `GET /monitoring/assets/:id/thresholds` | new, read-only (§11, W05) |
| `PUT /monitoring/assets/:id/snmp` | applies suggestion when `templateId` omitted; echoes `templateSuggestion` |
| AI tools that read asset online state (`services/aiToolsNetwork.ts`, `services/aiToolsMonitoring.ts`; the plan enumerates the exact tools) | report `reachability` with source and age, never a bare online flag |

All routes stay inside `withDbAccessContext`; asset-bound writes use the site-locking resolver.

## 13. Data changes and tenancy contract

| Table | Change | Registries |
|---|---|---|
| `discovered_assets` | + `status_observed_at`, `status_source`, `last_probe_at`, `last_probe_status`, `last_probe_response_ms`, `last_probe_ref` | `CORE_TENANT_EXPORT_POLICY` → `included` (all six) |
| `snmp_devices` | + `poll_seq integer NOT NULL DEFAULT 0`; `last_status` value `no_template` (no enum, varchar) | export policy `included` |
| `snmp_metrics` | + `base_oid`, `instance`, `error`; `value_type` value `error`; index `(device_id, oid, timestamp DESC)` | export policy `included` (three) |
| `snmp_templates` | + `sys_object_id_prefixes text[]`; seed prefixes; + built-in "Xerox Printer"; existing built-ins' table entries gain `mode`/`cadence` inside the `oids` jsonb | export policy `included` (`sys_object_id_prefixes` is a list of public OID prefixes, not a capability); `oids` stays `excludedOpen` |

No new tables, so no RLS policies or cascade-order entries change. Migrations (all idempotent, no
inner transactions, `SELECT set_config('breeze.scope','system',true)` first in the two that write
rows), reserved names, re-checked against `ls apps/api/migrations | sort | tail -1` before each commit:

| File | Wave |
|---|---|
| `2026-10-17-110000-discovered-assets-status-provenance-and-probe.sql` | W01 |
| `2026-10-17-110100-snmp-metrics-instances-errors-index.sql` (`-- @no-transaction`, index built `CONCURRENTLY`) | W01 |
| `2026-10-17-110200-snmp-devices-poll-seq.sql` | W01 |
| `2026-10-17-110300-snmp-templates-prefixes-modes-xerox.sql` (DML: seeds; elects system scope) | W03 |

## 14. Error handling

- Probe: `NO_AGENT_IN_SITE` (409), `PROBE_IN_FLIGHT` (409), `ASSET_NO_IP` (422), agent error result →
  `failed` with `detail.error`. The UI shows each as an inline line under the reachability badge, never
  a toast-only failure.
- Metrics: bucket/range beyond caps → 400 with the cap in the message.
- Suggestion: no match → `null`, the modal shows "No template matched; pick one" with the sysObjectID.
- Agent walk truncation → error row `truncated` per OID; the OID table shows "partial (512 of ? rows)".
- Modal saves surface through `runAction`; a 409 from a concurrent type change re-loads the section.

## 15. Testing

- `services/assetReachability.test.ts`: table-driven over the rules in §4.2 (each source alone, positive
  vs negative recency, windows, HTTP checks ignored, SNMP failure alone → unverified with detail).
- `services/snmpCollectionState.test.ts`: legacy null → `unknown`, error rows → `unsupported`, stale
  windows, instance grouping.
- `jobs/snmpWorkerScheduler.test.ts`: `no_template` written, backoff untouched (extends the existing
  `it.each`).
- `jobs/snmpWorker.test.ts`: ingestion of protocol-2 rows, all-error poll → `warning`.
- Integration (real DB): export-policy and erasure round-trip for the new columns; probe correlation
  rejects a moved asset; metrics endpoint bucketing; template suggestion boundary matching (`1.3.6.1.4.1.25`
  must not match `1.3.6.1.4.1.253`).
- Go: `snmppoll` walk bounds, error-row emission, legacy `oids`-only payload unchanged; `classify_test`
  no longer expects sysObjectID as model.
- Web: `NetworkAssetSettingsModal` per-section save/cancel and hash open/close; single-writer contract
  test; `PrinterHealth` rendering (negative supply → unknown, missing OIDs → explicit unavailable);
  reachability badge copy; approval banner; translation coverage in all 8 locales.
- E2E (Playwright, `data-testid`): open device page → Settings → Monitoring → save; Check now shows a
  result line; printer Health card shows supplies on the seeded fixture.

## 16. Wave split (one PR each)

| Wave | Ships | Depends on |
|---|---|---|
| W01 API truth | §4 (service, columns, all consumers), §5 probe, §6.1–6.3 (`no_template`, `collection`, `/metrics`), §7.3 ingestion, §7.5 index + retention default, §9 read-time model mask, `nicVendor`, executor-selection extraction | — |
| W02 Agent acquisition | §7.1 `oidSpecs` + limits in the server command builder, §7.2/§7.4 agent walks and error rows, `classify.go` change, `poll_seq` cadence gating | W01 |
| W03 Templates and identity | §8 prefixes, suggestion service + route + PUT behaviour, Xerox template, `mode`/`cadence` seeding; §9 identity resolution at ingest | W01 |
| W04 Web settings surface | §10 modal, single-writer module + contract test, entry points, Discovery peek, Monitoring modal removal | W01 (W03 for the suggestion line, feature-detected: the section works without it) |
| W05 Web page IA | §11 header, stat strip, Health/Reachability cards, Identity, Monitoring tab, charts, banner, a11y, timezone | W01, W04; printer supplies need W02+W03 in the field to show data, the card degrades to explicit "not collected yet" until then |

W02, W03 and W04 run in parallel after W01. Each wave dispatches CI per branch before merge
(`gh workflow run CI --ref <branch>`) because stacked branches get no `pull_request` run.

## 17. Risks and mitigations

- **Metric volume** after walks: bounds, `slow` cadence, reaper, composite index (§7). Watch
  `snmp_metrics` size on the EU/US droplets for the first week after the agent release.
- **Old agents in the field** keep the legacy shape indefinitely: every server path treats missing
  `protocol` as legacy; the UI names the agent update as the fix for `unknown` table OIDs.
- **Reachability disagreeing with the devices list**: both call the same service in W01; a unit test
  asserts the list mapping.
- **Probe abuse**: one in-flight per asset, site-strict executor, no org-wide fallback.
- **Enterprise-number errors** would mislabel vendors: the plan requires a verification step against
  IANA for every seeded PEN and a test fixture per vendor.

## 18. Quorum record

Codex (gpt-6-astra, xhigh, read-only, 2026-09-16) reviewed the position document. Outcomes:

| Item | Codex | Resolution |
|---|---|---|
| D1 derive vs materialise | Agree on derive; "newest status wins" is wrong: SNMP failures increment at dispatch, scan disappearance changes `is_online` without a timestamp, HTTP/TLS failure is not host evidence | Adopted: evidence classes, `status_observed_at`, HTTP/DNS excluded (§4) |
| D2 probe columns | Keep columns (monitor results need a persistent parent); the `/check` route only queues; 10 s must mean pending; centralise strict site-scoped executor selection; correlate results | Adopted (§5) |
| D3 `no_template` | Must not increment backoff (scheduler contract); missing rows cannot prove `no_such_object`; return freshness and `unknown` | Adopted (§6) |
| D4 wire compat | Old agents drop object entries and poll zero OIDs; add `oidSpecs` with explicit mode, value type cannot decide acquisition; ship ingestion first; bound walks; composite index | Adopted (§7) |
| D5 template column | Column over code map; boundary matching; tie-break by device type; reuse Generic Printer rather than a Xerox template | Adopted except the Xerox alias, kept on the owner's explicit ask (cost: one seed row) |
| D6 identity | Vendor-specific tested extractors, not universal `;` split; preserve manual precedence; sysDescr manufacturer rules already exist | Adopted (§9) |
| D7 / D8 | Agree; extend the hash parser, keep type-reset, credential masking, `runAction`; negative supplies = unknown; unit-aware, reset-aware counters | Adopted (§10, §11) |
| (e) tenancy | Every new column classified; no new tables | §13 |
| (f) waves | Ingestion and bounded history in W01; agents, templates, consolidation, presentation after; per-branch CI dispatch | §16 |
