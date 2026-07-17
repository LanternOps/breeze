# Breeze RMM - k6 Load Tests

Load and stress test scenarios for the Breeze RMM API using [k6](https://k6.io/).

## Prerequisites

### Install k6

**macOS:**
```bash
brew install k6
```

**Linux (Debian/Ubuntu):**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

**Docker:**
```bash
docker pull grafana/k6
```

**Verify installation:**
```bash
k6 version
```

## Configuration

All scenarios read configuration from `config.js`. Override non-secret values
with environment variables passed via `-e`; inject secret values through the
process environment or a secret manager:

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3001` | API base URL |
| `WS_BASE_URL` | derived from `BASE_URL` | WebSocket base URL (`ws://` or `wss://`) |
| `AUTH_TOKEN` | (empty) | JWT or API key for authenticated endpoints |
| `AGENT_TOKEN` | (empty) | Bearer token for agent endpoints |
| `DEVICE_ID` | (empty) | A known device ID for single-device tests |
| `DEVICE_IDS` | (empty) | Comma-separated device IDs for command tests |
| `PARTNER_API_KEY` | (empty) | Dedicated `brz_sp_...` partner-service-principal key for partner exports |
| `PARTNER_API_MODE` | `both` | `full`, `incremental`, or `both` traversal phases |
| `PARTNER_API_PAGE_LIMIT` | `500` | Export page size (clamped to the API maximum of 500) |
| `INCREMENTAL_PAGE_LIMIT` | `500` | Incremental-only page size; set to `1` for the changed-row cursor gate |
| `INCREMENTAL_UPDATED_SINCE` | (empty) | One ISO checkpoint applied to every incremental resource |
| `PARTNER_API_CHECKPOINTS_JSON` | (empty) | Per-resource checkpoint object from a prior full summary; takes precedence over `INCREMENTAL_UPDATED_SINCE` |
| `PARTNER_API_INCREMENTAL_EXPECTED_RECORDS` | `0` | Minimum changed records required from every resource |
| `PARTNER_API_SUMMARY_FILE` | `partner-api-export-summary.json` | Safe basename for the generated summary |
| `PARTNER_API_EXPECTED_DEVICES` | `10000` | Minimum device records required in the seeded full traversal |
| `PARTNER_API_MAX_RETRIES` | `5` | Bounded retries per page for HTTP 429 and 5xx responses (maximum 10) |
| `PARTNER_API_MAX_PAGES` | `100000` | Safety bound per resource traversal |
| `TEST_EMAIL` | `loadtest@breeze.local` | Login email for auth tests |
| `TEST_PASSWORD` | `LoadTest123!` | Login password for auth tests |
| `HEARTBEAT_INTERVAL` | `60` | Seconds between heartbeats per VU |
| `WS_HEARTBEAT_INTERVAL` | `60` | Seconds between WS heartbeats per VU |
| `STRESS` | `false` | Set to `true` for stress mode in heartbeat test |

### Generating Auth Tokens

1. Log into Breeze and create an API key in **Settings > API Keys**.
2. Or obtain a JWT by calling the login endpoint:
   ```bash
   curl -s -X POST http://localhost:3001/api/v1/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@breeze.local","password":"yourpassword"}' \
     | jq -r '.accessToken // .token'
   ```

## Running Tests

### Smoke Test (quick sanity check)

```bash
k6 run -e BASE_URL=http://localhost:3001 \
       -e TEST_EMAIL=admin@breeze.local \
       -e TEST_PASSWORD=yourpassword \
       --vus 1 --duration 30s \
       scenarios/auth.js
```

### Auth Throughput Test

```bash
k6 run -e BASE_URL=http://localhost:3001 \
       -e TEST_EMAIL=loadtest@breeze.local \
       -e TEST_PASSWORD=LoadTest123! \
       scenarios/auth.js
```

### Agent Heartbeat (Standard Load)

Simulates 10,000 agents sending heartbeats every 60 seconds:

```bash
k6 run -e BASE_URL=http://localhost:3001 \
       -e AGENT_TOKEN=brz_your_agent_token \
       scenarios/heartbeat.js
```

### Agent Heartbeat (Stress)

Pushes beyond capacity to find the breaking point:

```bash
k6 run -e BASE_URL=http://localhost:3001 \
       -e AGENT_TOKEN=brz_your_agent_token \
       -e STRESS=true \
       scenarios/heartbeat.js
```

### Device List

```bash
k6 run -e BASE_URL=http://localhost:3001 \
       -e AUTH_TOKEN=your_jwt_or_api_key \
       scenarios/device-list.js
```

### Command Dispatch

```bash
k6 run -e BASE_URL=http://localhost:3001 \
       -e AUTH_TOKEN=your_jwt_or_api_key \
       -e DEVICE_IDS=device-id-1,device-id-2,device-id-3 \
       scenarios/command-dispatch.js
```

### WebSocket Connections

```bash
k6 run -e BASE_URL=http://localhost:3001 \
       -e AGENT_TOKEN=brz_your_agent_token \
       scenarios/websocket.js
```

### Partner reconstruction export

Run this against a partner fixture containing at least 10,000 devices. Use a
dedicated partner-service-principal key with all eight partner read scopes; a human JWT
or ordinary organization API key cannot authenticate this route.

```bash
# Read silently or replace this line with your secret manager's environment injection.
read -r -s PARTNER_API_KEY && export PARTNER_API_KEY
k6 run -e BASE_URL=https://breeze.example.com scenarios/partner-api-export.js
unset PARTNER_API_KEY
```

Never pass the key with k6's `-e` flag: command-line arguments can be captured
by shell history, process listings, and CI logs. The local k6 process reads the
inherited `PARTNER_API_KEY` environment variable. In automation, inject that
variable directly from the job's secret manager and mask it from logs.

The setup phase performs a full cursor traversal of all 13 v1 resources. The
single shared iteration then uses each resource's full-crawl `snapshotAt` as
its `updatedSince` checkpoint and must finish the entire incremental pass in
under 15 minutes. A single VU, one iteration, a hard 15-minute `maxDuration`,
bounded page count, and bounded retries prevent one scheduled run from
overlapping itself indefinitely. The external scheduler must likewise allow
only one invocation per integration at a time.

For every resource, including `custom-fields` and scalar
`custom-field-values`, the scenario:

- requires one stable `snapshotAt` across every page;
- rejects repeated cursors and duplicate `(resource, id, orgId)` identities;
- records successful pages, records, response bytes, retry count, page time,
  and traversal time;
- records HTTP 429 and 5xx responses independently; and
- records pool-saturation signals independently. HTTP 503 is treated as the
  operational pool-saturation proxy, as are explicit pool-saturation headers
  or bounded error codes.

The scenario writes `partner-api-export-summary.json`, including full and
incremental page/traversal duration distributions for every resource. A run fails on a v1
contract error, duplicate identity, changing snapshot, detected pool
saturation, fewer than the expected devices, retry/page exhaustion, or the
15-minute incremental budget.

For a true changed-row cursor gate, run the phases separately. The full summary
contains a checkpoint for every resource. Mutate at least two export records
for every resource after the full run, then feed those checkpoints into an
incremental-only run with a one-record page and a two-record minimum:

```bash
# Read silently or inject this variable from the job's secret manager.
read -r -s PARTNER_API_KEY && export PARTNER_API_KEY
export PARTNER_API_MODE=full
export PARTNER_API_SUMMARY_FILE=partner-export-full-summary.json
k6 run -e BASE_URL=https://breeze.example.com scenarios/partner-api-export.js

export PARTNER_API_CHECKPOINTS_JSON="$(jq -c .checkpoints partner-export-full-summary.json)"
# Apply the fixture mutations here, after every captured checkpoint.
export PARTNER_API_MODE=incremental
export INCREMENTAL_PAGE_LIMIT=1
export PARTNER_API_INCREMENTAL_EXPECTED_RECORDS=2
export PARTNER_API_SUMMARY_FILE=partner-export-incremental-summary.json
k6 run -e BASE_URL=https://breeze.example.com scenarios/partner-api-export.js

unset PARTNER_API_KEY PARTNER_API_MODE PARTNER_API_CHECKPOINTS_JSON \
  INCREMENTAL_PAGE_LIMIT PARTNER_API_INCREMENTAL_EXPECTED_RECORDS \
  PARTNER_API_SUMMARY_FILE
```

`PARTNER_API_MODE=both` remains useful for cadence and no-change smoke tests.
It cannot prove changed-row ordering because there is no mutation boundary
between its setup and iteration. The changed-row gate requires each resource
to return at least two records and, at page size one, at least two pages; this
forces first-page and late-cursor execution for all 13 resources.

### With Docker

```bash
docker run --rm -i --network=host \
  -v "$(pwd)/load-tests:/scripts" \
  grafana/k6 run \
  -e BASE_URL=http://localhost:3001 \
  -e AUTH_TOKEN=your_token \
  /scripts/scenarios/device-list.js
```

## Scenarios Overview

| Scenario | File | VU Target | Hold Duration | Key Thresholds |
|---|---|---|---|---|
| Auth (login) | `auth.js` | 50 | 2 min | p95 < 500ms, errors < 1% |
| Heartbeat | `heartbeat.js` | 10,000 | 5 min per stage | p99 < 2s, errors < 0.1% |
| Device list | `device-list.js` | 100 | 3 min | p95 < 1s, errors < 1% |
| Command dispatch | `command-dispatch.js` | 50 | 2 min | p95 < 1s, errors < 1% |
| WebSocket | `websocket.js` | 500 | 5 min | connect p95 < 5s, fail < 5% |
| Partner API export | `partner-api-export.js` | 1 | one full + one incremental traversal | incremental < 15 min; no duplicates, snapshot drift, or pool saturation |

## Interpreting Results

k6 prints a summary at the end of each run. Key metrics to watch:

- **http_req_duration**: Response time distribution. Check `p(95)` and `p(99)`.
- **http_req_failed**: Percentage of requests that returned non-2xx status.
- **iteration_duration**: Total time for one VU iteration including sleep.
- **vus**: Current number of active virtual users.
- **Custom metrics**: Each scenario defines custom counters/trends (e.g.,
  `heartbeat_duration`, `login_failures`).

### Pass/Fail

k6 exits with code 0 if all thresholds pass, code 99 if any threshold is
breached. Use this in CI pipelines:

```bash
k6 run scenarios/auth.js || echo "Thresholds breached!"
```

### Exporting Results

Output to JSON for analysis:
```bash
k6 run --out json=results.json scenarios/auth.js
```

Stream to InfluxDB + Grafana for real-time dashboards:
```bash
k6 run --out influxdb=http://localhost:8086/k6 scenarios/heartbeat.js
```

## Hardware Requirements

The load generator machine (where k6 runs) needs sufficient resources:

| Scenario | Min CPU | Min RAM | Notes |
|---|---|---|---|
| Auth (50 VUs) | 2 cores | 1 GB | Minimal |
| Heartbeat (10K VUs) | 8 cores | 8 GB | Network bandwidth is bottleneck |
| Device list (100 VUs) | 2 cores | 2 GB | |
| Command dispatch (50 VUs) | 2 cores | 1 GB | |
| WebSocket (500 conns) | 4 cores | 4 GB | File descriptor limits matter |
| Partner API export (10K devices) | 2 cores | 2 GB | Run near the API to avoid measuring WAN latency |

## Partner export index evidence gate

Do not add speculative indexes from a small development database. Capture the
k6 summary and `EXPLAIN (ANALYZE, BUFFERS)` on the same representative partner
fixture with at least 10,000 devices, both for the first page and a late cursor
page of each incremental traversal. Retain the plan, actual rows, rows removed
by filter, sort method/disk spill, buffer hits/reads, and execution time.

### Representative changed-row evidence (2026-07-14)

The retained two-phase gate used 10,000 devices across two organizations and
sites. A full-only run captured all 13 resource checkpoints. After at least two
records or material clocks for every resource were changed, an
incremental-only run used a page limit of one and required two records per
resource. It completed 28 first/late pages with 28 changed records in 11.018
seconds and recorded no retries, HTTP errors, pool-saturation signals,
contract failures, duplicate identities, or snapshot changes.

The full fixture totals, per-resource changed counts and durations, and
sanitized first/late `EXPLAIN (ANALYZE, BUFFERS)` evidence are retained in
[`evidence/2026-07-14-partner-export-changed-incremental.md`](evidence/2026-07-14-partner-export-changed-incremental.md)
and its adjacent JSON file. No index was added: the changed incremental gate
used about 1.2% of the cadence, no sort spilled to disk, and the slowest
isolated predicate plan completed in 157.324 ms. Re-evaluate the following
candidates with production-shaped data if tenant cardinality or change volume
grows materially:

- Site inventory exports approved `printer`, `router`, `switch`, `firewall`,
  `access_point`, and `nas` assets. The existing
  `discovered_assets_partner_export_site_idx` partial predicate omits
  `printer`, so printer-heavy sites may not use it. Expand or replace that
  partial index only if the representative plan shows material heap scanning.
- Incremental devices order and filter by the effective
  `GREATEST(device.partner_export_updated_at,
  hardware.partner_export_updated_at)` timestamp. Inventory/software/
  relationship resources similarly use material-state timestamps. Add an
  expression or composite incremental index only if late-page plans show a
  material scan, sort, or spill; the exact expression and key order must match
  the measured query.

Example evidence capture (replace every placeholder and use a read-only
session with the same tenant context as the load fixture):

```sql
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT a.id
FROM discovered_assets AS a
WHERE a.org_id = '<organization-uuid>'::uuid
  AND a.site_id = '<site-uuid>'::uuid
  AND a.approval_status = 'approved'
  AND a.asset_type IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')
ORDER BY a.id
LIMIT 501;

EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT d.id,
       GREATEST(d.partner_export_updated_at,
                COALESCE(h.partner_export_updated_at, d.partner_export_updated_at)) AS effective_updated_at
FROM devices AS d
LEFT JOIN device_hardware AS h
  ON h.device_id = d.id AND h.org_id = d.org_id
WHERE d.org_id = '<organization-uuid>'::uuid
  AND GREATEST(d.partner_export_updated_at,
               COALESCE(h.partner_export_updated_at, d.partner_export_updated_at))
      > '<incremental-checkpoint>'::timestamp
ORDER BY effective_updated_at, d.id, d.org_id
LIMIT 501;
```

### OS Tuning for High VU Counts

For the heartbeat and WebSocket tests at scale:

```bash
# Increase file descriptor limit
ulimit -n 65535

# Increase ephemeral port range (Linux)
sudo sysctl -w net.ipv4.ip_local_port_range="1024 65535"

# Increase socket buffer sizes
sudo sysctl -w net.core.somaxconn=65535
sudo sysctl -w net.core.netdev_max_backlog=65535
```

## Developing New Scenarios

1. Create a new file in `scenarios/`.
2. Import shared config from `../config.js`.
3. Define `options` with `stages` and `thresholds`.
4. Export a `default` function that runs one iteration per VU.
5. Optionally export `handleSummary` for custom output.
