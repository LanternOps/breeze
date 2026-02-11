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

All scenarios read configuration from `config.js`. Override values with
environment variables passed via `-e`:

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3001` | API base URL |
| `WS_BASE_URL` | derived from `BASE_URL` | WebSocket base URL (`ws://` or `wss://`) |
| `AUTH_TOKEN` | (empty) | JWT or API key for authenticated endpoints |
| `AGENT_TOKEN` | (empty) | Bearer token for agent endpoints |
| `DEVICE_ID` | (empty) | A known device ID for single-device tests |
| `DEVICE_IDS` | (empty) | Comma-separated device IDs for command tests |
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
