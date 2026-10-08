---
title: "Scaling W0a + W0d: realistic agent simulator and per-route DB budget gate"
spec: docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md
spec_sections: "§1, §3, §6 W0 (W0a, W0d)"
spec_pr: LanternOps/breeze#8127
date: 2026-10-07
waves: [W0a, W0d]
---

# Scaling W0a + W0d: Agent Simulator and Hot-Route DB Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Go agent simulator that drives a real Breeze stack with N distinct, really-enrolled agents at production cadence and emits a machine-readable run report (W0a), and pin the per-request DB cost of every request that simulator sends, agent auth included, in the Integration Tests job (W0d).

**Architecture:** The simulator is a `main` package plus a `sim` library inside the agent Go module (`agent/tools/agentsim/`), because every payload struct it must reuse lives under `agent/internal/`. It enrolls through `POST /api/v1/agents/enroll` with a real enrollment key, persists one token per device in a 0600 token store, and runs one goroutine set per agent that mirrors the real agent's loops: the 60 s heartbeat tick with tick-gated inventory/security/session/posture/event-log sends, the 30 s UniFi poll, the process sampler, the crawl-config poll, and a persistent agent WebSocket with app-level pong replies, control pings and command-result replies. A recording `http.RoundTripper` counts every attempt per route template; a run report (`breeze.agentsim.report/v1`) is the contract W0c will consume. `load-tests/agentsim/` holds the operator surface (run script, lab setup, acceptance check, README). W0d extends `agentHotPathQueryBudget.integration.test.ts` in place, reusing its `postgres` debug-hook counter, with full-chain (agent-auth-included) budgets for every simulator route, two WS frame budgets, and an auth-only case; a Go test keeps the simulator's route list and the TS budget table in lock-step.

**Tech Stack:** Go 1.26 (agent module: `gorilla/websocket`, `golang.org/x/time/rate`, `google/uuid`, agent `internal/*` packages), Bash + `jq` + `docker` for lab scripts, Vitest integration suite against real Postgres/Redis (Hono app, postgres.js debug hook).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md` (§1 failure spiral, §3 capacity model, §6 W0a and W0d rows). Owner approved 2026-10-07.

## Design decisions (read before Task 1)

| Decision | Choice | Why |
|---|---|---|
| Module placement | Code in `agent/tools/agentsim/` (package `main`) and `agent/tools/agentsim/sim`; the spec's `load-tests/agentsim/` holds the run/lab/check scripts and README | The structs the spec says to reuse (`heartbeat.HeartbeatPayload`, `collectors.*`, `security.SecurityStatus`, `mgmtdetect.ManagementPosture`, `websocket.Command`/`CommandResult`, `tools.CommandResult`) are all under `agent/internal/`; Go only allows imports of those from inside `github.com/breeze-rmm/agent`. A separate module under `load-tests/` cannot import them. Living in the agent module also puts the simulator's tests in the required **Test Agent** CI job (`go test ./...` in `agent/`) for free. `tools/` is not under `cmd/`, and no build script globs `./cmd/...`, so nothing ships it. |
| Struct reuse vs. mirrors | Import the agent's own types, accept the dependency weight | `internal/heartbeat` pulls in most of the agent (~490 packages) but that is compile cost only. Mirror structs would drift silently; imported ones break the build when a field is renamed or retyped. The one unexported value the simulator needs, `compiledSecurityCapabilities()`, gets a one-line exported accessor (Task 1) — the only change to shipped agent code, and it adds no behaviour. |
| WebSocket client | Thin gorilla client in `sim`, reusing `agentws.Command`/`agentws.CommandResult` and mirroring `internal/websocket/client.go`'s constants and reconnect rules | The agent's `websocket.Client` exposes no connect/reconnect hooks (the report needs them) and logs per client; 2,000 instances of its ordered-command pump add nothing to load fidelity. The mirrored rules are cited line by line. |
| HTTP behaviour | Every agent HTTP call goes through the agent's own `httputil.Do` + `httputil.DefaultRetryConfig()` with a per-agent clone of `http.DefaultTransport` | Same retry/backoff/Retry-After behaviour and the same one-keep-alive-connection-per-agent shape as `heartbeat.go newHeartbeatHTTPClient`. Retries are what turn saturation into a storm (spec §1), so they must be real. |
| Auth | Bearer `brz_…` token on HTTP and on the WS upgrade; no mTLS | Matches the agent: enrollment issues an mTLS cert only when Cloudflare credentials are configured, and `AGENT_MTLS_BINDING_MODE` defaults to `off`. No HMAC/request signing exists on the agent path. |
| Start mode | Default `warm`: no startup fan-out, every periodic stream at a random phase. `cold` replays a fresh service start | Production's steady state is agents that have been up for hours with uniformly spread phases. A ramp of a few minutes would otherwise put every agent's 15-minute inventory in the same 5-minute band. `cold` exists for W0b storms. |
| Rate accounting | "Requests" = logical requests (first attempts); "attempts" = including retries. The ±10 % mix check uses requests | Retries depend on server health; the mix the spec compares to production is what agents *intend* to send. |
| Lab overrides | Env only, exported in the shell before `pnpm wt-stack up` (`AGENT_ENROLL_RATE_LIMIT=5000`); no code default changes | `docker-compose.yml` already maps `AGENT_ENROLL_RATE_LIMIT` into `x-api-env`; a shell export beats both env files and survives `.env.stack` being rewritten on every `up`. `E2E_MODE=true` (global per-IP limiter off, which WS upgrades otherwise share at 300/min) and `IS_HOSTED=false` (partner-trust probation off) are already pinned by wt-stack. Production defaults are untouched. |

### Server-side guards checked (none blocks 2,000 enrollments from one IP once the lab env is set)

| Guard | Default | Lab handling |
|---|---|---|
| Per-IP enrollment limiter `agent-enroll:<ip>` (`config/enrollmentRateLimit.ts`) | 10 / 60 s → 2,000 enrollments would take 200 min | `AGENT_ENROLL_RATE_LIMIT=5000` (shell export) |
| Enrollment key `max_usage` (`enrollment.ts`, `usage_count < max_usage`) | `maxUsage` defaults to **1** | `lab-setup.sh` creates the key with `maxUsage: 2500` |
| Global enrollment secret `AGENT_ENROLLMENT_SECRET` (required by compose) | required | `lab-setup.sh` reads it from the api container; simulator sends `enrollmentSecret` |
| Partner device cap `partners.max_devices` | NULL (unlimited) on the seeded Default Partner | none needed |
| Global per-IP limiter (`middleware/globalRateLimit.ts`, 300/min, does not skip `/api/v1/agent-ws/`) | on | `E2E_MODE=true`, already pinned by wt-stack |
| Per-agent limiters in `agentAuthMiddleware` (30/min per agent+IP, 120/min per agent) | keyed per device | none needed at real cadence; never compress cadences below these |
| Per-org limiter `clamp(devices × 12, 600, 20000)` / min | 20,000/min at 2,000 devices | none needed (≈10,500/min at 5.2 req/agent-min) |
| WS pre-upgrade limit `agentws:conn:<agentId>` 6/min | per agent | none needed |
| Agent version / upgrade offers | `dev-*` versions are never offered an upgrade | simulator reports `agentVersion: "dev-agentsim"` |
| mTLS binding | `off` | none |
| Postgres `max_connections` 100, `DB_POOL_MAX` 30, Redis `maxclients 10000` / 256 MB | — | fine for one API container |

### Open item the owner must rule on (flagged, not blocking implementation)

1. **One dev-mode API container cannot carry 2,000 agents at production cadence.** The spec's own model (§1, §3) puts the post-mitigation cost at ~400 agents per core, and wt-stack runs the API under the dev override (tsx), not the production bundle. At 2,000 agents the lab API will saturate: heartbeats slow, the tick-gated streams stretch (the agent reads `now` after the heartbeat returns), and retries inflate attempts. The plan therefore runs the acceptance in two parts (Task 14): **Run A** (200 agents, 20 min) gates the ±10 % mix and zero-error criteria; **Run B** (2,000 agents, 30 min) gates 2,000 distinct device rows and 2,000 presence leases and records latency/errors as the first capacity data point rather than as pass/fail. If the owner wants the mix gate at 2,000 too, that needs either the production build in the lab or W2 (N API instances) first.
2. **The "~5 req/agent-min" production figure depends on the workspace module.** From the agent code, the mix is 4.21 req/agent-min without `GET /api/v1/workspace/agent/crawl-config` and 5.21 with it (the agent polls it every ~60 s unless it 404s, then backs off 6 h). wt-stack runs with `BREEZE_WORKSPACE_ENABLED=false`. The report always states the code-derived expectation next to the measurement; Task 14 compares against 5.0 only if the lab's workspace flag matches production. The production figure itself is [I] in the spec and is re-measured in W0c.

## Global Constraints

- Simulator location: `agent/tools/agentsim/` (Go, agent module `github.com/breeze-rmm/agent`, `go 1.26.6`). Operator scripts and README: `load-tests/agentsim/`.
- The only change to shipped agent code is the exported accessor `heartbeat.CompiledSecurityCapabilities()`; nothing under `agent/cmd/` imports `tools/agentsim`.
- Cadences match production at this commit: heartbeat 60 s (`config.DefaultHeartbeatIntervalSeconds`), `GET /agents/:id/unifi-collectors` every 30 s, process sample 180 s, security status and sessions gated at 5 min, the six-PUT inventory batch and management posture at 15 min, event logs 15 min, crawl-config ~60 s (6 h after a 404), WS control ping every 54 s, app-level `{"type":"pong"}` to every server `{"type":"ping"}`.
- Every simulated agent: distinct hostname `<prefix>-<storeTag>-<index:05d>`, distinct enrollment, distinct `brz_` token; per-agent start jitter in `[0, heartbeat interval)`.
- Reported agent version: `dev-agentsim` (the API never offers `dev-*` versions an upgrade).
- Lab overrides are env-only: `AGENT_ENROLL_RATE_LIMIT=5000` exported before `pnpm wt-stack up`. Never change a code default or a committed compose default.
- Token store and reports are secrets/artifacts: written 0600, under `load-tests/agentsim/.state/` and `load-tests/agentsim/reports/`, both gitignored.
- No real hostnames, IPs, regions or domains in committed files; lab URLs come from `.breeze-stack.json` at run time. Example addresses are RFC 1918 (`10.x`).
- Report schema id `breeze.agentsim.report/v1`; route keys are the templates in `sim/routes.go` and must match the keys in `agentHotPathQueryBudget.integration.test.ts`.
- Go tests: `cd agent && go test -race ./tools/agentsim/... ./internal/heartbeat/ -run <name>`; CI runs `CGO_ENABLED=0 go test ./...` on Linux, so no cgo-only code and no build-tag gaps (the rlimit check is `linux || darwin` with a stub elsewhere).
- Vitest: never `pnpm --filter … test -- --run`. Integration file runs as `pnpm --filter @breeze/api test:integration src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` against `pnpm test-stack up`.
- The W0d budget file stays a single suite; reuse its `recorder`/`measure`/`summarize` harness, never fork it.
- Tear down every stack you bring up (`pnpm wt-stack down`, `pnpm test-stack down`) and say what is left running.

## Review Focus

1. **A run that ends before its steady window opens** (Ctrl-C, or `--duration` shorter than ramp + warmup). A reasonable user expects a clear refusal up front for the second, and a written, honest report for the first: agent-minutes 0 and every rate 0, never `NaN` (which makes `json.Marshal` fail and loses the whole report). Pinned by `TestValidateRejectsDurationInsideRampAndWarmup` (Task 2), `TestBuildReportWithNoAgentMinutesHasZeroRates` (Task 4) and `TestRunInterruptedBeforeTheWindowStillWritesAReport` (Task 10).
2. **Re-running against a re-created stack** (`pnpm wt-stack down && up` wipes the DB but the token store survives). Expected: each stale identity gets one 401 on its first heartbeat, is re-enrolled under a fresh hostname, and runs — not 2,000 agents silently 401-ing for 30 minutes. Pinned by `TestAgentReenrollsWhenTheStoredTokenIs401` (Task 8).
3. **Pointing a token store at a different server.** Expected: refusal naming both URLs, so tokens are never sent to the wrong stack and two stacks' identities never mix. Pinned by `TestLoadStoreRefusesAStoreFromAnotherServer` (Task 5).
4. **A saturated API answering 429/503 with `Retry-After`.** Expected: enrollment waits and retries; agent requests retry exactly as `httputil.Do` does; the report counts one request but two attempts. Pinned by `TestEnrollHonours429RetryAfter` (Task 6) and `TestRecordingTransportCountsOneRequestAcrossRetries` (Task 3).
5. **The server closing sockets.** Expected, as the real agent: a refused upgrade backs off 1 s → 60 s with ±30 % jitter (no hot loop); an established socket that drops is redialled immediately. Pinned by `TestFailedUpgradeBacksOff` and `TestEstablishedDropReconnectsImmediately` (Task 9).

---

## File map

| File | Responsibility |
|---|---|
| `agent/internal/heartbeat/simexport.go` (+ `_test.go`) | Exported `CompiledSecurityCapabilities()` accessor |
| `agent/tools/agentsim/main.go` (+ `main_test.go`) | Flag/env parsing, signal handling, summary line |
| `agent/tools/agentsim/sim/config.go` (+ test) | `Config`, `Cadence`, defaults, overrides, validation, steady window |
| `sim/routes.go` (+ test) | Route templates, `RouteKey`, the steady-state route list |
| `sim/histogram.go` (+ test) | Fixed log-bucket latency histogram |
| `sim/recorder.go`, `sim/transport.go` (+ test) | Thread-safe counters; recording `RoundTripper`; logical-vs-attempt context |
| `sim/model.go`, `sim/report.go` (+ test) | Expected per-route rate; report schema, build, atomic write |
| `sim/store.go` (+ test) | Token store load/save/refusal |
| `sim/enroll.go` (+ test) | Enrollment client with 429 handling |
| `sim/payloads.go` (+ test) | Request bodies built from the agent's own structs |
| `sim/agent.go`, `sim/gates.go` (+ tests) | One simulated agent's HTTP loops and command worker |
| `sim/ws.go` (+ test) | Agent WebSocket session |
| `sim/commander.go` (+ test) | Optional admin-side command dispatcher |
| `sim/runner.go`, `sim/rlimit_unix.go`, `sim/rlimit_other.go` (+ test) | Ramp, enrollment pacing, run lifecycle, file-limit check |
| `sim/fakeapi_test.go` | Test-only fake Breeze API (HTTP + WS) shared by sim tests |
| `sim/budget_contract_test.go` | Simulator routes ⇔ TS budget table contract |
| `load-tests/agentsim/{README.md,run.sh,lab-setup.sh,check-acceptance.sh,.gitignore}` | Operator surface |
| `load-tests/README.md` | Note that `scenarios/heartbeat.js` does not measure agent cost |
| `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` | W0d budgets (extended in place) |

## Run report schema (`breeze.agentsim.report/v1`) — the W0c contract

```jsonc
{
  "schema": "breeze.agentsim.report/v1",
  "runId": "20261007T180000Z-3f9a1c",          // UTC start + random suffix
  "startedAt": "2026-10-07T18:00:00Z",
  "endedAt": "2026-10-07T18:30:00Z",
  "target": "http://localhost:54321",          // stack base URL as given
  "config": {
    "agents": 2000, "rampPerSecond": 5, "durationSeconds": 1800, "warmupSeconds": 90,
    "startMode": "warm", "wsEnabled": true, "agentVersion": "dev-agentsim", "osType": "linux",
    "cadenceSeconds": { "heartbeat": 60, "unifi": 30, "crawl-config": 60, "process-sample": 180,
                        "security": 300, "sessions": 300, "inventory": 900, "posture": 900,
                        "eventlogs": 900, "ws-ping": 54 },
    "commandsPerMinute": 30,
    "retry": { "maxRetries": 3, "initialDelaySeconds": 1, "maxDelaySeconds": 30 }
  },
  "agents": { "configured": 2000, "started": 2000, "onlineAtWindowOpen": 2000,
              "enrolledThisRun": 0, "reusedFromStore": 2000, "reenrolled": 0, "enrollFailures": 0 },
  "window": { "start": "…", "end": "…", "seconds": 1290, "agentMinutes": 43000 },
  "totals": {
    "requests": 181000,                         // logical, steady window, modelled routes only
    "attempts": 181400,                         // incl. retries
    "allRequests": 181900,                      // + command results, steady window
    "requestsPerAgentMinute": 4.21,
    "expectedRequestsPerAgentMinute": 4.21,     // from the agent's cadences (model.go)
    "deviationPct": 0.0,
    "non2xx": 2000,                             // steady window, excl. the WS upgrade (101)
    "transportErrors": 0
  },
  "routes": [                                   // sorted by route; every modelled route present
    { "route": "POST /agents/:id/heartbeat", "requests": 43000, "attempts": 43010,
      "perAgentMinute": 1.0, "expectedPerAgentMinute": 1.0,
      "latencyMs": { "count": 43010, "p50": 41.2, "p95": 180.4, "p99": 420.0, "max": 2900.1 },
      "status": { "200": 43010 },               // steady window
      "statusTotal": { "200": 51000, "0": 2 },  // whole run; 0 = transport error
      "transportErrors": 0 }
  ],
  "ws": { "connects": 2000, "reconnects": 0, "connectFailures": 0, "disconnects": 2000,
          "controlPingsSent": 47000, "controlPongsReceived": 47000,
          "framesReceived": { "connected": 2000, "ping": 86000, "ack": 900 },
          "connectLatencyMs": { "count": 2000, "p50": 12.0, "p95": 40.0, "p99": 80.0, "max": 300.0 } },
  "commands": { "dispatched": 900, "dispatchFailures": 0, "received": { "ws": 900, "http": 0 },
                "duplicates": 0, "dropped": 0, "resultsSent": { "ws": 900, "http": 0 } }
}
```

Rules W0c can rely on: `schema` changes on any breaking change; route keys are templates (never contain ids); latency is per attempt, time to response headers, steady window only; `status`/`statusTotal` keys are HTTP codes as strings, `"0"` is a transport error; every rate is `0` (never `NaN`) when `window.agentMinutes` is 0.

---
### Task 1: Export the compiled security-capability set

The API gates remote desktop and other dispatch on the capability versions a heartbeat declares (`heartbeat.go` `compiledSecurityCapabilities`, comment above it). A simulator that sends zeros is a different agent. The function is unexported; add a one-line exported accessor so the simulator sends exactly this build's declaration.

**Files:**
- Create: `agent/internal/heartbeat/simexport.go`
- Test: `agent/internal/heartbeat/simexport_test.go`

**Interfaces:**
- Produces: `func CompiledSecurityCapabilities() heartbeat.SecurityCapabilities` (used by Task 7).

- [ ] **Step 1: Write the failing test**

```go
// agent/internal/heartbeat/simexport_test.go
package heartbeat

import (
	"reflect"
	"testing"
)

func TestCompiledSecurityCapabilitiesExportMatchesTheHeartbeatDeclaration(t *testing.T) {
	got := CompiledSecurityCapabilities()
	if want := compiledSecurityCapabilities(); !reflect.DeepEqual(got, want) {
		t.Fatalf("exported capabilities %+v differ from the heartbeat declaration %+v", got, want)
	}
	// The API refuses remote desktop against revocationLeaseProtocolVersion 0;
	// a zero here would make every simulated agent a degraded one.
	if got.RevocationLeaseProtocolVersion == 0 {
		t.Fatal("RevocationLeaseProtocolVersion is 0")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestCompiledSecurityCapabilitiesExportMatchesTheHeartbeatDeclaration`
Expected: FAIL to compile: `undefined: CompiledSecurityCapabilities`.

- [ ] **Step 3: Write minimal implementation**

```go
// agent/internal/heartbeat/simexport.go
package heartbeat

// CompiledSecurityCapabilities returns the capability set this build declares
// on every heartbeat. Exported for agent/tools/agentsim, which must send the
// same declaration a real agent of this build sends. Pure accessor: it adds no
// behaviour to the shipped agent.
func CompiledSecurityCapabilities() SecurityCapabilities {
	return compiledSecurityCapabilities()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestCompiledSecurityCapabilitiesExportMatchesTheHeartbeatDeclaration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/simexport.go agent/internal/heartbeat/simexport_test.go
git commit -m "feat(agent): export the compiled security-capability set for the agent simulator"
```

---

### Task 2: Simulator config, cadences and validation

**Files:**
- Create: `agent/tools/agentsim/sim/config.go`
- Test: `agent/tools/agentsim/sim/config_test.go`

**Interfaces:**
- Produces:
  - `type StartMode string`; consts `StartWarm = "warm"`, `StartCold = "cold"`.
  - `type Cadence struct { Heartbeat, UnifiPoll, CrawlConfig, ProcessSample, Security, Sessions, Inventory, Posture, EventLogs, WSPing time.Duration }`
  - `func DefaultCadence() Cadence`, `func CadenceNames() []string`, `func (c *Cadence) Set(name string, d time.Duration) error`, `func (c Cadence) Seconds() map[string]float64`, `func ParseCadenceOverrides(spec string, c *Cadence) error`
  - `type CommanderConfig struct { PerMinute float64; Email, Password, CommandType string }`
  - `type Config struct { ServerURL, EnrollmentKey, EnrollmentSecret string; Agents int; RampPerSecond float64; EnrollConcurrency int; Duration, Warmup time.Duration; StorePath, ReportPath, HostnamePrefix, AgentVersion, OSType string; StartMode StartMode; WSEnabled bool; Cadence Cadence; Retry httputil.RetryConfig; RequestTimeout, CommandDelay time.Duration; Commander CommanderConfig }`
  - `func DefaultConfig() Config`, `func (c Config) Validate() error`, `func (c Config) SteadyWindow() (open, close time.Duration)`

- [ ] **Step 1: Write the failing test**

```go
// agent/tools/agentsim/sim/config_test.go
package sim

import (
	"strings"
	"testing"
	"time"
)

func validConfig() Config {
	c := DefaultConfig()
	c.ServerURL = "http://localhost:8080"
	return c
}

func TestDefaultCadenceMirrorsTheAgent(t *testing.T) {
	c := DefaultCadence()
	for name, tc := range map[string]struct{ got, want time.Duration }{
		"heartbeat":      {c.Heartbeat, 60 * time.Second},
		"unifi":          {c.UnifiPoll, 30 * time.Second},
		"process-sample": {c.ProcessSample, 180 * time.Second},
		"security":       {c.Security, 5 * time.Minute},
		"inventory":      {c.Inventory, 15 * time.Minute},
		"ws-ping":        {c.WSPing, 54 * time.Second},
	} {
		if tc.got != tc.want {
			t.Errorf("%s cadence = %s, want %s", name, tc.got, tc.want)
		}
	}
}

func TestParseCadenceOverrides(t *testing.T) {
	c := DefaultCadence()
	if err := ParseCadenceOverrides("heartbeat=30s, inventory=0", &c); err != nil {
		t.Fatal(err)
	}
	if c.Heartbeat != 30*time.Second || c.Inventory != 0 {
		t.Fatalf("overrides not applied: %+v", c)
	}
	for spec, want := range map[string]string{
		"nope=1s":       "unknown cadence",
		"heartbeat":     "want name=duration",
		"heartbeat=abc": "invalid duration",
		"security=-1s":  "negative",
	} {
		err := ParseCadenceOverrides(spec, &c)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("ParseCadenceOverrides(%q) = %v, want error containing %q", spec, err, want)
		}
	}
}

func TestValidateAcceptsTheDefaultsWithAServer(t *testing.T) {
	if err := validConfig().Validate(); err != nil {
		t.Fatalf("default config with a server URL must be valid: %v", err)
	}
}

func TestValidateRejectsBadInput(t *testing.T) {
	for name, tc := range map[string]struct {
		mutate func(*Config)
		want   string
	}{
		"no server":        {func(c *Config) { c.ServerURL = "" }, "--server"},
		"server with path": {func(c *Config) { c.ServerURL = "http://x/api" }, "without a path"},
		"zero agents":      {func(c *Config) { c.Agents = 0 }, "--agents"},
		"zero ramp":        {func(c *Config) { c.RampPerSecond = 0 }, "--ramp"},
		"bad os":           {func(c *Config) { c.OSType = "beos" }, "--os"},
		"bad start":        {func(c *Config) { c.StartMode = "lukewarm" }, "--start"},
		"bad prefix":       {func(c *Config) { c.HostnamePrefix = "Sim_01" }, "--hostname-prefix"},
		"no heartbeat":     {func(c *Config) { c.Cadence.Heartbeat = 0 }, "heartbeat cadence"},
		"commander no creds": {func(c *Config) {
			c.Commander.PerMinute = 10
			c.Commander.Email = ""
		}, "--admin-email"},
	} {
		c := validConfig()
		tc.mutate(&c)
		err := c.Validate()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: Validate() = %v, want error containing %q", name, err, tc.want)
		}
	}
}

func TestValidateRejectsDurationInsideRampAndWarmup(t *testing.T) {
	c := validConfig()
	c.Agents, c.RampPerSecond, c.Warmup = 600, 5, 90*time.Second // ramp 120 s + warmup 90 s
	c.Duration = 200 * time.Second
	err := c.Validate()
	if err == nil || !strings.Contains(err.Error(), "steady window") {
		t.Fatalf("Validate() = %v, want a steady-window error", err)
	}
	open, closeAt := c.SteadyWindow()
	if open != 210*time.Second || closeAt != 200*time.Second {
		t.Fatalf("SteadyWindow() = %s, %s", open, closeAt)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestDefaultCadence|TestParseCadence|TestValidate'`
Expected: FAIL to compile: `undefined: DefaultConfig`.

- [ ] **Step 3: Write minimal implementation**

```go
// agent/tools/agentsim/sim/config.go
// Package sim drives N simulated Breeze agents against a real stack. See
// load-tests/agentsim/README.md.
package sim

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

// StartMode selects how a simulated agent begins.
type StartMode string

const (
	// StartWarm models an agent that has been running for hours: no startup
	// inventory fan-out, and every periodic stream starts at a random phase.
	StartWarm StartMode = "warm"
	// StartCold replays a fresh service start: the inventory batch fires after
	// the first heartbeat and the zero-stamped gates fire on the first tick, as
	// heartbeat.go Start() does.
	StartCold StartMode = "cold"
)

// Cadence is every periodic interval the simulator drives. Zero disables a
// stream (except Heartbeat, which drives the tick loop).
type Cadence struct {
	Heartbeat     time.Duration
	UnifiPoll     time.Duration
	CrawlConfig   time.Duration
	ProcessSample time.Duration
	Security      time.Duration
	Sessions      time.Duration
	Inventory     time.Duration
	Posture       time.Duration
	EventLogs     time.Duration
	WSPing        time.Duration
}

// DefaultCadence mirrors the real agent at this commit.
func DefaultCadence() Cadence {
	return Cadence{
		Heartbeat:     time.Duration(config.DefaultHeartbeatIntervalSeconds) * time.Second,
		UnifiPoll:     30 * time.Second, // internal/unifi/collector.go StartCollectorLoop ticker
		CrawlConfig:   60 * time.Second, // internal/workspaceindex/loop.go default poll, ±10 %
		ProcessSample: time.Duration(config.Default().ProcessSampleIntervalSeconds) * time.Second,
		Security:      5 * time.Minute,  // heartbeat.go Start(): shouldSendSecurity
		Sessions:      5 * time.Minute,  // shouldSendSessions
		Inventory:     15 * time.Minute, // shouldSendInventory -> sendInventory()
		Posture:       15 * time.Minute, // shouldSendPosture
		EventLogs:     15 * time.Minute, // collectors/eventlogs.go intervalMinutes default
		WSPing:        54 * time.Second, // internal/websocket/client.go pingPeriod
	}
}

// CadenceNames lists the names --cadence accepts, in report order.
func CadenceNames() []string {
	return []string{"heartbeat", "unifi", "crawl-config", "process-sample", "security",
		"sessions", "inventory", "posture", "eventlogs", "ws-ping"}
}

func (c *Cadence) field(name string) *time.Duration {
	switch name {
	case "heartbeat":
		return &c.Heartbeat
	case "unifi":
		return &c.UnifiPoll
	case "crawl-config":
		return &c.CrawlConfig
	case "process-sample":
		return &c.ProcessSample
	case "security":
		return &c.Security
	case "sessions":
		return &c.Sessions
	case "inventory":
		return &c.Inventory
	case "posture":
		return &c.Posture
	case "eventlogs":
		return &c.EventLogs
	case "ws-ping":
		return &c.WSPing
	}
	return nil
}

// Set overrides one named cadence.
func (c *Cadence) Set(name string, d time.Duration) error {
	f := c.field(name)
	if f == nil {
		return fmt.Errorf("unknown cadence %q (known: %s)", name, strings.Join(CadenceNames(), ", "))
	}
	*f = d
	return nil
}

// Seconds renders the cadence for the run report.
func (c Cadence) Seconds() map[string]float64 {
	out := make(map[string]float64, len(CadenceNames()))
	for _, n := range CadenceNames() {
		out[n] = c.field(n).Seconds()
	}
	return out
}

// ParseCadenceOverrides applies "name=duration,name=duration".
func ParseCadenceOverrides(spec string, c *Cadence) error {
	if strings.TrimSpace(spec) == "" {
		return nil
	}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		name, value, ok := strings.Cut(part, "=")
		if !ok {
			return fmt.Errorf("cadence override %q: want name=duration", part)
		}
		d, err := time.ParseDuration(strings.TrimSpace(value))
		if err != nil {
			return fmt.Errorf("cadence override %q: %w", part, err)
		}
		if d < 0 {
			return fmt.Errorf("cadence override %q: negative duration", part)
		}
		if err := c.Set(strings.TrimSpace(name), d); err != nil {
			return err
		}
	}
	return nil
}

// CommanderConfig drives the optional admin-side command dispatcher.
type CommanderConfig struct {
	PerMinute   float64
	Email       string
	Password    string
	CommandType string
}

// Config is one simulator run.
type Config struct {
	ServerURL         string // stack base URL; the simulator appends /api/v1
	EnrollmentKey     string
	EnrollmentSecret  string
	Agents            int
	RampPerSecond     float64
	EnrollConcurrency int
	Duration          time.Duration // whole run, from the first agent start
	Warmup            time.Duration // after the ramp, before the steady window opens
	StorePath         string
	ReportPath        string
	HostnamePrefix    string
	AgentVersion      string
	OSType            string
	StartMode         StartMode
	WSEnabled         bool
	Cadence           Cadence
	Retry             httputil.RetryConfig
	RequestTimeout    time.Duration
	CommandDelay      time.Duration
	Commander         CommanderConfig
}

// DefaultConfig is the smoke-test shape: 20 agents for 3 minutes.
func DefaultConfig() Config {
	return Config{
		Agents:            20,
		RampPerSecond:     5,
		EnrollConcurrency: 8,
		Duration:          3 * time.Minute,
		Warmup:            90 * time.Second,
		StorePath:         ".agentsim/tokens.json",
		ReportPath:        ".agentsim/report.json",
		HostnamePrefix:    "agentsim",
		AgentVersion:      "dev-agentsim", // the API never offers dev-* versions an upgrade
		OSType:            "linux",
		StartMode:         StartWarm,
		WSEnabled:         true,
		Cadence:           DefaultCadence(),
		Retry:             httputil.DefaultRetryConfig(),
		RequestTimeout:    30 * time.Second, // heartbeat.go newHeartbeatHTTPClient
		CommandDelay:      250 * time.Millisecond,
		Commander:         CommanderConfig{CommandType: "refresh_inventory"},
	}
}

var hostnamePrefixRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// SteadyWindow is when the measured window opens and closes, from run start.
func (c Config) SteadyWindow() (open, closeAt time.Duration) {
	ramp := time.Duration(float64(c.Agents) / c.RampPerSecond * float64(time.Second))
	return ramp + c.Warmup, c.Duration
}

// Validate reports every invalid field at once.
func (c Config) Validate() error {
	var errs []error
	u, err := url.Parse(c.ServerURL)
	switch {
	case err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "":
		errs = append(errs, fmt.Errorf("--server must be an http(s) URL, got %q", c.ServerURL))
	case u.Path != "" && u.Path != "/":
		errs = append(errs, fmt.Errorf("--server is the stack base URL without a path (the simulator appends /api/v1), got %q", c.ServerURL))
	}
	if c.Agents < 1 {
		errs = append(errs, errors.New("--agents must be at least 1"))
	}
	if c.RampPerSecond <= 0 {
		errs = append(errs, errors.New("--ramp must be above 0 agents per second"))
	}
	if c.EnrollConcurrency < 1 {
		errs = append(errs, errors.New("--enroll-concurrency must be at least 1"))
	}
	if c.Duration <= 0 || c.Warmup < 0 {
		errs = append(errs, errors.New("--duration must be positive and --warmup not negative"))
	}
	if c.StorePath == "" || c.ReportPath == "" {
		errs = append(errs, errors.New("--store and --report are required"))
	}
	if c.OSType != "linux" && c.OSType != "windows" && c.OSType != "macos" {
		errs = append(errs, fmt.Errorf("--os must be linux, windows or macos, got %q", c.OSType))
	}
	if c.StartMode != StartWarm && c.StartMode != StartCold {
		errs = append(errs, fmt.Errorf("--start must be warm or cold, got %q", c.StartMode))
	}
	if !hostnamePrefixRe.MatchString(c.HostnamePrefix) {
		errs = append(errs, fmt.Errorf("--hostname-prefix must match %s, got %q", hostnamePrefixRe, c.HostnamePrefix))
	}
	if c.Cadence.Heartbeat <= 0 {
		errs = append(errs, errors.New("the heartbeat cadence cannot be disabled: it drives the tick loop every gated stream hangs off"))
	}
	if c.Commander.PerMinute < 0 {
		errs = append(errs, errors.New("--commands-per-minute cannot be negative"))
	}
	if c.Commander.PerMinute > 0 && (c.Commander.Email == "" || c.Commander.Password == "") {
		errs = append(errs, errors.New("--commands-per-minute needs --admin-email and --admin-password (or AGENTSIM_ADMIN_EMAIL / AGENTSIM_ADMIN_PASSWORD)"))
	}
	if c.RampPerSecond > 0 && c.Duration > 0 {
		if open, closeAt := c.SteadyWindow(); open >= closeAt {
			errs = append(errs, fmt.Errorf("--duration %s leaves no steady window: the ramp plus --warmup takes %s", closeAt, open))
		}
	}
	return errors.Join(errs...)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestDefaultCadence|TestParseCadence|TestValidate'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/sim/config.go agent/tools/agentsim/sim/config_test.go
git commit -m "feat(agentsim): simulator config, production cadences and validation"
```

---

### Task 3: Route keys, latency histogram, recorder and recording transport

**Files:**
- Create: `agent/tools/agentsim/sim/routes.go`, `sim/histogram.go`, `sim/recorder.go`, `sim/transport.go`
- Test: `sim/routes_test.go`, `sim/histogram_test.go`, `sim/recorder_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Route constants `RouteHeartbeat`, `RouteUnifi`, `RouteCrawlConfig`, `RouteProcessSample`, `RouteSecurity`, `RouteSessions`, `RouteSoftware`, `RouteDisks`, `RouteNetwork`, `RouteConnections`, `RouteRegistryState`, `RouteConfigState`, `RoutePosture`, `RouteEventLogs`, `RouteCommandResult`, `RouteEnroll`, `RouteWSUpgrade`, `FrameCommandResult`, `FramePong`; `var InventoryBatchRoutes []string`; `func SteadyStateRoutes() []string`; `func RouteKey(method, path string) string`.
  - `type Histogram`; `NewHistogram() *Histogram`; `(*Histogram).Observe(time.Duration)`, `Quantile(q float64) float64` (ms), `Count() uint64`, `MaxMs() float64`.
  - `type Recorder` with exported fields `RunID string; Start, WindowOpen, WindowClose time.Time`; `NewRecorder(runID string, start, windowOpen, windowClose time.Time) *Recorder`; methods `ObserveHTTP(route string, first bool, start time.Time, latency time.Duration, status int, err error)`, `AgentOnline(index int, t time.Time)`, `AgentOffline(index int, t time.Time)`, `WSConnected(reconnect bool, latency time.Duration)`, `WSConnectFailed()`, `WSDisconnected()`, `WSControlPing()`, `WSControlPong()`, `WSFrame(kind string)`, `CommandReceived(via string)`, `CommandDuplicate()`, `CommandDropped()`, `CommandResultSent(via string)`, `CommandDispatched(ok bool)`, `Enrolled()`, `EnrollReused()`, `Reenrolled()`, `EnrollFailed()`; package-internal `agentMinutes(end time.Time) (float64, int)`.
  - `func withLogicalRequest(ctx context.Context) context.Context`; `type recordingTransport struct{ base http.RoundTripper; rec *Recorder }`.

- [ ] **Step 1: Write the failing tests**

```go
// agent/tools/agentsim/sim/routes_test.go
package sim

import "testing"

func TestRouteKeyTemplatesEveryAgentPath(t *testing.T) {
	for _, tc := range []struct{ method, path, want string }{
		{"POST", "/api/v1/agents/abc123/heartbeat", RouteHeartbeat},
		{"GET", "/api/v1/agents/abc123/unifi-collectors", RouteUnifi},
		{"PUT", "/api/v1/agents/abc123/security/status", RouteSecurity},
		{"POST", "/api/v1/agents/abc123/commands/9f1c/result", RouteCommandResult},
		{"POST", "/api/v1/agents/enroll", RouteEnroll},
		{"GET", "/api/v1/agent-ws/abc123/ws", RouteWSUpgrade},
		{"GET", "/api/v1/workspace/agent/crawl-config", RouteCrawlConfig},
	} {
		if got := RouteKey(tc.method, tc.path); got != tc.want {
			t.Errorf("RouteKey(%s %s) = %q, want %q", tc.method, tc.path, got, tc.want)
		}
	}
}

func TestSteadyStateRoutesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range SteadyStateRoutes() {
		if seen[r] {
			t.Fatalf("duplicate route %q", r)
		}
		seen[r] = true
	}
	if len(seen) != 17 {
		t.Fatalf("SteadyStateRoutes has %d routes, want 17", len(seen))
	}
}
```

```go
// agent/tools/agentsim/sim/histogram_test.go
package sim

import (
	"math"
	"testing"
	"time"
)

func TestHistogramQuantilesWithinTwoPercent(t *testing.T) {
	h := NewHistogram()
	for ms := 1; ms <= 1000; ms++ {
		h.Observe(time.Duration(ms) * time.Millisecond)
	}
	for q, want := range map[float64]float64{0.50: 500, 0.95: 950, 0.99: 990} {
		got := h.Quantile(q)
		if math.Abs(got-want)/want > 0.02 {
			t.Errorf("p%.0f = %.2f ms, want %.0f ±2%%", q*100, got, want)
		}
	}
	if h.Count() != 1000 || h.MaxMs() != 1000 {
		t.Fatalf("count %d max %.1f", h.Count(), h.MaxMs())
	}
}

func TestEmptyHistogramIsZero(t *testing.T) {
	h := NewHistogram()
	if h.Quantile(0.99) != 0 || h.MaxMs() != 0 || h.Count() != 0 {
		t.Fatal("empty histogram must report zeros")
	}
}
```

```go
// agent/tools/agentsim/sim/recorder_test.go
package sim

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

func TestRecorderCountsOnlyInsideTheWindow(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("r", t0, t0.Add(time.Minute), t0.Add(2*time.Minute))
	rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(30*time.Second), 10*time.Millisecond, 200, nil) // before
	rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(90*time.Second), 10*time.Millisecond, 200, nil) // inside
	rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(3*time.Minute), 10*time.Millisecond, 503, nil)  // after
	st := rec.routes[RouteHeartbeat]
	if st.requests != 1 || st.status[200] != 1 || st.statusTotal[200] != 2 || st.statusTotal[503] != 1 {
		t.Fatalf("window accounting wrong: %+v", st)
	}
}

func TestAgentMinutesClipToTheWindow(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("r", t0, t0.Add(time.Minute), t0.Add(3*time.Minute))
	rec.AgentOnline(0, t0)                      // runs through the whole window: 2 min
	rec.AgentOnline(1, t0.Add(2*time.Minute))   // joins late: 1 min
	rec.AgentOnline(2, t0)                      // leaves early
	rec.AgentOffline(2, t0.Add(90*time.Second)) // 0.5 min
	minutes, onlineAtOpen := rec.agentMinutes(t0.Add(10 * time.Minute))
	if minutes < 3.49 || minutes > 3.51 {
		t.Fatalf("agent-minutes = %.3f, want 3.5", minutes)
	}
	if onlineAtOpen != 2 {
		t.Fatalf("online at window open = %d, want 2", onlineAtOpen)
	}
}

func TestRecordingTransportCountsOneRequestAcrossRetries(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	t0 := time.Now().Add(-time.Second)
	rec := NewRecorder("r", t0, t0, t0.Add(time.Hour))
	client := &http.Client{Transport: &recordingTransport{base: http.DefaultTransport, rec: rec}}
	retry := httputil.RetryConfig{MaxRetries: 2, InitialDelay: time.Millisecond, MaxDelay: time.Millisecond, BackoffFactor: 1}
	resp, err := httputil.Do(withLogicalRequest(context.Background()), client, http.MethodPost,
		srv.URL+"/api/v1/agents/a1/heartbeat", []byte(`{}`), http.Header{}, retry)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	st := rec.routes[RouteHeartbeat]
	if st.requests != 1 || st.attempts != 2 || st.status[503] != 1 || st.status[200] != 1 {
		t.Fatalf("want 1 request / 2 attempts / one 503 + one 200, got %+v", st)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestRouteKey|TestSteadyState|TestHistogram|TestEmptyHistogram|TestRecorder|TestAgentMinutes'`
Expected: FAIL to compile: `undefined: RouteKey`.

- [ ] **Step 3: Write the implementation**

```go
// agent/tools/agentsim/sim/routes.go
package sim

import "strings"

// Route templates. The report and the API DB-budget test
// (apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts)
// use the same strings; budget_contract_test.go keeps them in step.
const (
	RouteHeartbeat     = "POST /agents/:id/heartbeat"
	RouteUnifi         = "GET /agents/:id/unifi-collectors"
	RouteCrawlConfig   = "GET /workspace/agent/crawl-config"
	RouteProcessSample = "POST /agents/:id/process-sample"
	RouteSecurity      = "PUT /agents/:id/security/status"
	RouteSessions      = "PUT /agents/:id/sessions"
	RouteSoftware      = "PUT /agents/:id/software"
	RouteDisks         = "PUT /agents/:id/disks"
	RouteNetwork       = "PUT /agents/:id/network"
	RouteConnections   = "PUT /agents/:id/connections"
	RouteRegistryState = "PUT /agents/:id/registry-state"
	RouteConfigState   = "PUT /agents/:id/config-state"
	RoutePosture       = "PUT /agents/:id/management/posture"
	RouteEventLogs     = "PUT /agents/:id/eventlogs"
	RouteCommandResult = "POST /agents/:id/commands/:commandId/result"
	RouteEnroll        = "POST /agents/enroll"
	RouteWSUpgrade     = "GET /agent-ws/:id/ws"
	FrameCommandResult = "WS command_result"
	FramePong          = "WS pong"
)

// InventoryBatchRoutes is what heartbeat.go sendInventory() fans out every 15
// minutes on Linux. changes (only when there are change records) and
// warranty-info (darwin only) are not modelled.
var InventoryBatchRoutes = []string{RouteSoftware, RouteDisks, RouteNetwork, RouteConnections, RouteRegistryState, RouteConfigState}

// SteadyStateRoutes is every request a running simulated agent sends, plus the
// two WS frames it answers with. Each needs a DB budget in the API test.
func SteadyStateRoutes() []string {
	out := []string{RouteHeartbeat, RouteUnifi, RouteCrawlConfig, RouteProcessSample, RouteSecurity,
		RouteSessions, RoutePosture, RouteEventLogs, RouteCommandResult, FrameCommandResult, FramePong}
	return append(out, InventoryBatchRoutes...)
}

// RouteKey turns a request into its route template: ids become :id and
// :commandId, and the /api/v1 prefix is dropped.
func RouteKey(method, path string) string {
	segs := strings.Split(strings.Trim(strings.TrimPrefix(path, "/api/v1"), "/"), "/")
	switch {
	case len(segs) >= 2 && segs[0] == "agents" && segs[1] != "enroll":
		segs[1] = ":id"
		if len(segs) >= 4 && segs[2] == "commands" {
			segs[3] = ":commandId"
		}
	case len(segs) >= 2 && segs[0] == "agent-ws":
		segs[1] = ":id"
	}
	return method + " /" + strings.Join(segs, "/")
}
```

```go
// agent/tools/agentsim/sim/histogram.go
package sim

import (
	"math"
	"sync"
	"time"
)

// Histogram is a fixed log-bucket latency histogram: bucket i covers
// [base·growth^i, base·growth^(i+1)). With base 0.1 ms and growth 1.02 any
// reported quantile is within 2 % of the true value, and an hour of 2,000
// agents costs a few KB per route instead of one sample per request.
type Histogram struct {
	mu     sync.Mutex
	counts []uint64
	total  uint64
	max    time.Duration
}

const (
	histBase    = 100 * time.Microsecond
	histGrowth  = 1.02
	histBuckets = 720 // 0.1 ms · 1.02^720 ≈ 1,550 s, beyond any client timeout
)

func NewHistogram() *Histogram { return &Histogram{counts: make([]uint64, histBuckets)} }

func bucketFor(d time.Duration) int {
	if d <= histBase {
		return 0
	}
	i := int(math.Log(float64(d)/float64(histBase)) / math.Log(histGrowth))
	if i >= histBuckets {
		return histBuckets - 1
	}
	return i
}

func (h *Histogram) Observe(d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.counts[bucketFor(d)]++
	h.total++
	if d > h.max {
		h.max = d
	}
}

// Quantile returns the upper edge of the bucket that holds quantile q, in
// milliseconds, capped at the observed maximum. Zero when empty.
func (h *Histogram) Quantile(q float64) float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.total == 0 {
		return 0
	}
	rank := uint64(math.Ceil(q * float64(h.total)))
	if rank == 0 {
		rank = 1
	}
	maxMs := float64(h.max) / float64(time.Millisecond)
	var seen uint64
	for i, c := range h.counts {
		seen += c
		if seen >= rank {
			upper := float64(histBase) * math.Pow(histGrowth, float64(i+1)) / float64(time.Millisecond)
			return math.Min(upper, maxMs)
		}
	}
	return maxMs
}

func (h *Histogram) Count() uint64 { h.mu.Lock(); defer h.mu.Unlock(); return h.total }

func (h *Histogram) MaxMs() float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return float64(h.max) / float64(time.Millisecond)
}
```

```go
// agent/tools/agentsim/sim/recorder.go
package sim

import (
	"sync"
	"sync/atomic"
	"time"
)

type routeStats struct {
	requests        uint64         // logical requests started in the steady window
	attempts        uint64         // first attempts + retries started in the steady window
	transportErrors uint64         // steady window
	status          map[int]uint64 // steady window, by HTTP status
	statusTotal     map[int]uint64 // whole run, by HTTP status; 0 = transport error
	latency         *Histogram     // steady window, per attempt, time to response headers
}

type span struct{ start, stop time.Time }

// Recorder accumulates everything the run report needs. Safe for concurrent use.
type Recorder struct {
	RunID       string
	Start       time.Time
	WindowOpen  time.Time
	WindowClose time.Time

	mu     sync.Mutex
	routes map[string]*routeStats
	spans  map[int]*span
	frames map[string]uint64
	cmdVia map[string]uint64
	resVia map[string]uint64

	wsConnectLatency *Histogram

	wsConnects, wsReconnects, wsConnectFailures, wsDisconnects  atomic.Uint64
	wsControlPings, wsControlPongs                              atomic.Uint64
	cmdDuplicates, cmdDropped, cmdDispatched, cmdDispatchFailed atomic.Uint64
	enrolled, reused, reenrolled, enrollFailed                  atomic.Uint64
}

func NewRecorder(runID string, start, windowOpen, windowClose time.Time) *Recorder {
	return &Recorder{
		RunID: runID, Start: start, WindowOpen: windowOpen, WindowClose: windowClose,
		routes: map[string]*routeStats{}, spans: map[int]*span{}, frames: map[string]uint64{},
		cmdVia: map[string]uint64{}, resVia: map[string]uint64{}, wsConnectLatency: NewHistogram(),
	}
}

func (r *Recorder) inWindow(t time.Time) bool {
	return !t.Before(r.WindowOpen) && t.Before(r.WindowClose)
}

// route returns the stats for name; the caller holds r.mu.
func (r *Recorder) route(name string) *routeStats {
	st, ok := r.routes[name]
	if !ok {
		st = &routeStats{status: map[int]uint64{}, statusTotal: map[int]uint64{}, latency: NewHistogram()}
		r.routes[name] = st
	}
	return st
}

// ObserveHTTP records one attempt; first marks the logical request.
func (r *Recorder) ObserveHTTP(route string, first bool, start time.Time, latency time.Duration, status int, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.route(route)
	st.statusTotal[status]++
	if !r.inWindow(start) {
		return
	}
	st.attempts++
	if first {
		st.requests++
	}
	if err != nil {
		st.transportErrors++
		return
	}
	st.status[status]++
	st.latency.Observe(latency)
}

func (r *Recorder) AgentOnline(index int, t time.Time) {
	r.mu.Lock()
	r.spans[index] = &span{start: t}
	r.mu.Unlock()
}

func (r *Recorder) AgentOffline(index int, t time.Time) {
	r.mu.Lock()
	if s, ok := r.spans[index]; ok {
		s.stop = t
	}
	r.mu.Unlock()
}

// agentMinutes is the summed running time of every agent inside
// [WindowOpen, min(WindowClose, end)), and how many were up when it opened.
func (r *Recorder) agentMinutes(end time.Time) (float64, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	closeAt := r.WindowClose
	if end.Before(closeAt) {
		closeAt = end
	}
	var total time.Duration
	onlineAtOpen := 0
	for _, s := range r.spans {
		stop := s.stop
		if stop.IsZero() || stop.After(closeAt) {
			stop = closeAt
		}
		start := s.start
		if !start.After(r.WindowOpen) && (s.stop.IsZero() || s.stop.After(r.WindowOpen)) {
			onlineAtOpen++
		}
		if start.Before(r.WindowOpen) {
			start = r.WindowOpen
		}
		if stop.After(start) {
			total += stop.Sub(start)
		}
	}
	return total.Minutes(), onlineAtOpen
}

func (r *Recorder) WSConnected(reconnect bool, latency time.Duration) {
	r.wsConnects.Add(1)
	if reconnect {
		r.wsReconnects.Add(1)
	}
	r.wsConnectLatency.Observe(latency)
}
func (r *Recorder) WSConnectFailed() { r.wsConnectFailures.Add(1) }
func (r *Recorder) WSDisconnected()  { r.wsDisconnects.Add(1) }
func (r *Recorder) WSControlPing()   { r.wsControlPings.Add(1) }
func (r *Recorder) WSControlPong()   { r.wsControlPongs.Add(1) }
func (r *Recorder) WSFrame(kind string) {
	r.mu.Lock()
	r.frames[kind]++
	r.mu.Unlock()
}
func (r *Recorder) CommandReceived(via string) {
	r.mu.Lock()
	r.cmdVia[via]++
	r.mu.Unlock()
}
func (r *Recorder) CommandResultSent(via string) {
	r.mu.Lock()
	r.resVia[via]++
	r.mu.Unlock()
}
func (r *Recorder) CommandDuplicate() { r.cmdDuplicates.Add(1) }
func (r *Recorder) CommandDropped()   { r.cmdDropped.Add(1) }
func (r *Recorder) CommandDispatched(ok bool) {
	if ok {
		r.cmdDispatched.Add(1)
		return
	}
	r.cmdDispatchFailed.Add(1)
}
func (r *Recorder) Enrolled()     { r.enrolled.Add(1) }
func (r *Recorder) EnrollReused() { r.reused.Add(1) }
func (r *Recorder) Reenrolled()   { r.reenrolled.Add(1) }
func (r *Recorder) EnrollFailed() { r.enrollFailed.Add(1) }
```

```go
// agent/tools/agentsim/sim/transport.go
package sim

import (
	"context"
	"net/http"
	"sync/atomic"
	"time"
)

type attemptKey struct{}

// withLogicalRequest marks ctx as one logical request; every attempt
// httputil.Do makes under it shares the counter, so the first is the request
// and the rest are retries.
func withLogicalRequest(ctx context.Context) context.Context {
	return context.WithValue(ctx, attemptKey{}, new(atomic.Int32))
}

func isFirstAttempt(ctx context.Context) bool {
	n, ok := ctx.Value(attemptKey{}).(*atomic.Int32)
	if !ok {
		return true // a plain client.Do (no retry wrapper) is always its own request
	}
	return n.Add(1) == 1
}

// recordingTransport records every attempt by route template.
type recordingTransport struct {
	base http.RoundTripper
	rec  *Recorder
}

func (t *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	route := RouteKey(req.Method, req.URL.Path)
	first := isFirstAttempt(req.Context())
	start := time.Now()
	resp, err := t.base.RoundTrip(req)
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	t.rec.ObserveHTTP(route, first, start, time.Since(start), status, err)
	return resp, err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestRouteKey|TestSteadyState|TestHistogram|TestEmptyHistogram|TestRecorder|TestAgentMinutes'`
Expected: PASS. If `TestRecordingTransportCountsOneRequestAcrossRetries` reports one attempt, `httputil.Do` stopped passing its context to the request — fix the counter, do not loosen the test.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/sim/routes.go agent/tools/agentsim/sim/routes_test.go \
  agent/tools/agentsim/sim/histogram.go agent/tools/agentsim/sim/histogram_test.go \
  agent/tools/agentsim/sim/recorder.go agent/tools/agentsim/sim/recorder_test.go \
  agent/tools/agentsim/sim/transport.go
git commit -m "feat(agentsim): route templates, latency histogram, recorder and recording transport"
```

---

### Task 4: Expected-mix model and the run report

**Files:**
- Create: `agent/tools/agentsim/sim/model.go`, `sim/report.go`
- Test: `sim/report_test.go`

**Interfaces:**
- Consumes: `Recorder`, route constants (Task 3); `Config`, `Cadence` (Task 2).
- Produces:
  - `func ExpectedPerAgentMinute(c Cadence, crawlConfigAbsent bool) map[string]float64`
  - `const ReportSchema = "breeze.agentsim.report/v1"`; types `Report`, `ReportConfig`, `RetryReport`, `AgentReport`, `WindowReport`, `TotalsReport`, `LatencyReport`, `RouteReport`, `WSReport`, `CommandReport` (JSON exactly as the schema section above).
  - `func BuildReport(rec *Recorder, cfg Config, ended time.Time, started int) Report`; `func WriteReport(path string, r Report) error`.

- [ ] **Step 1: Write the failing test**

```go
// agent/tools/agentsim/sim/report_test.go
package sim

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sum(m map[string]float64) float64 {
	var s float64
	for _, v := range m {
		s += v
	}
	return s
}

// The documented mix (plan §"Open item 2"): 1 heartbeat + 2 UniFi polls + 1/3
// process sample + security and sessions every 5.5 min + posture, event logs
// and the six-PUT inventory batch every 15.5 min = 4.213, and 5.213 with
// crawl-config. A tick-gated stream fires on tick n or n+1 about equally
// often (the agent reads `now` after the heartbeat returns), so its mean
// interval is period + tick/2.
func TestExpectedMixMatchesTheAgentCadences(t *testing.T) {
	absent := sum(ExpectedPerAgentMinute(DefaultCadence(), true))
	present := sum(ExpectedPerAgentMinute(DefaultCadence(), false))
	if math.Abs(absent-4.2131) > 0.001 || math.Abs(present-5.2131) > 0.001 {
		t.Fatalf("expected mix = %.4f (crawl-config absent) / %.4f (present), want 4.2131 / 5.2131", absent, present)
	}
}

func TestBuildReportRatesAndDeviation(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("run-1", t0, t0, t0.Add(10*time.Minute))
	rec.AgentOnline(0, t0)
	rec.AgentOnline(1, t0)
	for i := 0; i < 20; i++ { // 2 agents × 10 min × 1/min
		rec.ObserveHTTP(RouteHeartbeat, true, t0.Add(time.Duration(i)*time.Second), 20*time.Millisecond, 200, nil)
	}
	rec.ObserveHTTP(RouteCrawlConfig, true, t0, time.Millisecond, 404, nil)
	cfg := validConfig()
	r := BuildReport(rec, cfg, t0.Add(10*time.Minute), 2)

	if r.Schema != ReportSchema || r.Window.AgentMinutes != 20 {
		t.Fatalf("schema %q agent-minutes %.2f", r.Schema, r.Window.AgentMinutes)
	}
	var hb *RouteReport
	for i := range r.Routes {
		if r.Routes[i].Route == RouteHeartbeat {
			hb = &r.Routes[i]
		}
	}
	if hb == nil || hb.PerAgentMinute != 1 || hb.ExpectedPerAgentMinute != 1 || hb.Status[200] != 20 {
		t.Fatalf("heartbeat route report wrong: %+v", hb)
	}
	// crawl-config only ever 404'd, so the model expects 0 from it.
	if math.Abs(r.Totals.ExpectedRequestsPerAgentMinute-4.2131) > 0.001 {
		t.Fatalf("expected total %.4f, want 4.2131", r.Totals.ExpectedRequestsPerAgentMinute)
	}
	if r.Totals.Non2xx != 1 {
		t.Fatalf("non2xx = %d, want the one 404", r.Totals.Non2xx)
	}
}

func TestBuildReportWithNoAgentMinutesHasZeroRates(t *testing.T) {
	t0 := time.Now()
	rec := NewRecorder("run-2", t0, t0.Add(time.Hour), t0.Add(2*time.Hour)) // window never opened
	rec.AgentOnline(0, t0)
	r := BuildReport(rec, validConfig(), t0.Add(time.Minute), 1)
	if r.Window.AgentMinutes != 0 || r.Totals.RequestsPerAgentMinute != 0 || r.Totals.DeviationPct != 0 {
		t.Fatalf("empty window must report zeros, got %+v", r.Totals)
	}
	path := filepath.Join(t.TempDir(), "nested", "report.json")
	if err := WriteReport(path, r); err != nil {
		t.Fatalf("an empty-window report must still serialise: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var back Report
	if err := json.Unmarshal(data, &back); err != nil || back.RunID != "run-2" {
		t.Fatalf("round trip: %v %+v", err, back)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestExpectedMix|TestBuildReport'`
Expected: FAIL to compile: `undefined: ExpectedPerAgentMinute`.

- [ ] **Step 3: Write the implementation**

```go
// agent/tools/agentsim/sim/model.go
package sim

import "time"

func perMinuteOf(d time.Duration) float64 {
	if d <= 0 {
		return 0
	}
	return float64(time.Minute) / float64(d)
}

// ExpectedPerAgentMinute is the steady-state request rate per route that c
// implies for one agent. Streams gated on the heartbeat tick fire when
// `now.Sub(last) > period` with `now` read after the heartbeat returns, so a
// period that is a whole number of ticks fires on tick n or n+1 about equally
// often: mean interval period + tick/2. crawlConfigAbsent is true when the
// stack 404s crawl-config (workspace module not loaded), after which the
// agent stops polling for six hours.
func ExpectedPerAgentMinute(c Cadence, crawlConfigAbsent bool) map[string]float64 {
	gated := func(p time.Duration) float64 {
		if p <= 0 || c.Heartbeat <= 0 {
			return 0
		}
		return perMinuteOf(p + c.Heartbeat/2)
	}
	m := map[string]float64{
		RouteHeartbeat:     perMinuteOf(c.Heartbeat),
		RouteUnifi:         perMinuteOf(c.UnifiPoll),
		RouteProcessSample: perMinuteOf(c.ProcessSample),
		RouteSecurity:      gated(c.Security),
		RouteSessions:      gated(c.Sessions),
		RoutePosture:       gated(c.Posture),
		RouteEventLogs:     gated(c.EventLogs),
		RouteCrawlConfig:   0,
	}
	for _, r := range InventoryBatchRoutes {
		m[r] = gated(c.Inventory)
	}
	if !crawlConfigAbsent {
		m[RouteCrawlConfig] = perMinuteOf(c.CrawlConfig)
	}
	return m
}
```

```go
// agent/tools/agentsim/sim/report.go
package sim

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// ReportSchema identifies the run-report format W0c's perf workflow reads.
// Change it on any breaking change to the fields below.
const ReportSchema = "breeze.agentsim.report/v1"

type Report struct {
	Schema    string        `json:"schema"`
	RunID     string        `json:"runId"`
	StartedAt time.Time     `json:"startedAt"`
	EndedAt   time.Time     `json:"endedAt"`
	Target    string        `json:"target"`
	Config    ReportConfig  `json:"config"`
	Agents    AgentReport   `json:"agents"`
	Window    WindowReport  `json:"window"`
	Totals    TotalsReport  `json:"totals"`
	Routes    []RouteReport `json:"routes"`
	WS        WSReport      `json:"ws"`
	Commands  CommandReport `json:"commands"`
}

type RetryReport struct {
	MaxRetries          int     `json:"maxRetries"`
	InitialDelaySeconds float64 `json:"initialDelaySeconds"`
	MaxDelaySeconds     float64 `json:"maxDelaySeconds"`
}

type ReportConfig struct {
	Agents            int                `json:"agents"`
	RampPerSecond     float64            `json:"rampPerSecond"`
	DurationSeconds   float64            `json:"durationSeconds"`
	WarmupSeconds     float64            `json:"warmupSeconds"`
	StartMode         StartMode          `json:"startMode"`
	WSEnabled         bool               `json:"wsEnabled"`
	AgentVersion      string             `json:"agentVersion"`
	OSType            string             `json:"osType"`
	CadenceSeconds    map[string]float64 `json:"cadenceSeconds"`
	CommandsPerMinute float64            `json:"commandsPerMinute"`
	Retry             RetryReport        `json:"retry"`
}

type AgentReport struct {
	Configured         int `json:"configured"`
	Started            int `json:"started"`
	OnlineAtWindowOpen int `json:"onlineAtWindowOpen"`
	EnrolledThisRun    int `json:"enrolledThisRun"`
	ReusedFromStore    int `json:"reusedFromStore"`
	Reenrolled         int `json:"reenrolled"`
	EnrollFailures     int `json:"enrollFailures"`
}

type WindowReport struct {
	Start        time.Time `json:"start"`
	End          time.Time `json:"end"`
	Seconds      float64   `json:"seconds"`
	AgentMinutes float64   `json:"agentMinutes"`
}

type TotalsReport struct {
	Requests                       uint64  `json:"requests"`
	Attempts                       uint64  `json:"attempts"`
	AllRequests                    uint64  `json:"allRequests"`
	RequestsPerAgentMinute         float64 `json:"requestsPerAgentMinute"`
	ExpectedRequestsPerAgentMinute float64 `json:"expectedRequestsPerAgentMinute"`
	DeviationPct                   float64 `json:"deviationPct"`
	Non2xx                         uint64  `json:"non2xx"`
	TransportErrors                uint64  `json:"transportErrors"`
}

type LatencyReport struct {
	Count uint64  `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

type RouteReport struct {
	Route                  string         `json:"route"`
	Requests               uint64         `json:"requests"`
	Attempts               uint64         `json:"attempts"`
	PerAgentMinute         float64        `json:"perAgentMinute"`
	ExpectedPerAgentMinute float64        `json:"expectedPerAgentMinute"`
	LatencyMs              LatencyReport  `json:"latencyMs"`
	Status                 map[int]uint64 `json:"status"`
	StatusTotal            map[int]uint64 `json:"statusTotal"`
	TransportErrors        uint64         `json:"transportErrors"`
}

type WSReport struct {
	Connects             uint64            `json:"connects"`
	Reconnects           uint64            `json:"reconnects"`
	ConnectFailures      uint64            `json:"connectFailures"`
	Disconnects          uint64            `json:"disconnects"`
	ControlPingsSent     uint64            `json:"controlPingsSent"`
	ControlPongsReceived uint64            `json:"controlPongsReceived"`
	FramesReceived       map[string]uint64 `json:"framesReceived"`
	ConnectLatencyMs     LatencyReport     `json:"connectLatencyMs"`
}

type CommandReport struct {
	Dispatched       uint64            `json:"dispatched"`
	DispatchFailures uint64            `json:"dispatchFailures"`
	Received         map[string]uint64 `json:"received"`
	Duplicates       uint64            `json:"duplicates"`
	Dropped          uint64            `json:"dropped"`
	ResultsSent      map[string]uint64 `json:"resultsSent"`
}

func latencyOf(h *Histogram) LatencyReport {
	return LatencyReport{Count: h.Count(), P50: h.Quantile(0.50), P95: h.Quantile(0.95), P99: h.Quantile(0.99), Max: h.MaxMs()}
}

func copyCounts[K comparable](in map[K]uint64) map[K]uint64 {
	out := make(map[K]uint64, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func perAgentMinute(n uint64, minutes float64) float64 {
	if minutes <= 0 {
		return 0 // never NaN: json.Marshal rejects it and the report would be lost
	}
	return float64(n) / minutes
}

// onlyNotFound is true when a route was answered and every answer was 404.
func onlyNotFound(counts map[int]uint64) bool {
	if counts[http.StatusNotFound] == 0 {
		return false
	}
	for code, c := range counts {
		if c > 0 && code != http.StatusNotFound {
			return false
		}
	}
	return true
}

type routeSnapshot struct {
	requests, attempts, transportErrors uint64
	status, statusTotal                 map[int]uint64
	latency                             LatencyReport
}

func (r *Recorder) snapshotRoutes() map[string]routeSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]routeSnapshot, len(r.routes))
	for name, st := range r.routes {
		out[name] = routeSnapshot{
			requests: st.requests, attempts: st.attempts, transportErrors: st.transportErrors,
			status: copyCounts(st.status), statusTotal: copyCounts(st.statusTotal), latency: latencyOf(st.latency),
		}
	}
	return out
}

// BuildReport freezes the recorder into a report. started is how many agents
// actually began running.
func BuildReport(rec *Recorder, cfg Config, ended time.Time, started int) Report {
	routes := rec.snapshotRoutes()
	model := ExpectedPerAgentMinute(cfg.Cadence, onlyNotFound(routes[RouteCrawlConfig].statusTotal))
	minutes, onlineAtOpen := rec.agentMinutes(ended)

	windowEnd := rec.WindowClose
	if ended.Before(windowEnd) {
		windowEnd = ended
	}
	seconds := windowEnd.Sub(rec.WindowOpen).Seconds()
	if seconds < 0 {
		seconds = 0
	}

	rep := Report{
		Schema: ReportSchema, RunID: rec.RunID, StartedAt: rec.Start.UTC(), EndedAt: ended.UTC(), Target: cfg.ServerURL,
		Config: ReportConfig{
			Agents: cfg.Agents, RampPerSecond: cfg.RampPerSecond, DurationSeconds: cfg.Duration.Seconds(),
			WarmupSeconds: cfg.Warmup.Seconds(), StartMode: cfg.StartMode, WSEnabled: cfg.WSEnabled,
			AgentVersion: cfg.AgentVersion, OSType: cfg.OSType, CadenceSeconds: cfg.Cadence.Seconds(),
			CommandsPerMinute: cfg.Commander.PerMinute,
			Retry:             RetryReport{MaxRetries: cfg.Retry.MaxRetries, InitialDelaySeconds: cfg.Retry.InitialDelay.Seconds(), MaxDelaySeconds: cfg.Retry.MaxDelay.Seconds()},
		},
		Agents: AgentReport{
			Configured: cfg.Agents, Started: started, OnlineAtWindowOpen: onlineAtOpen,
			EnrolledThisRun: int(rec.enrolled.Load()), ReusedFromStore: int(rec.reused.Load()),
			Reenrolled: int(rec.reenrolled.Load()), EnrollFailures: int(rec.enrollFailed.Load()),
		},
		Window: WindowReport{Start: rec.WindowOpen.UTC(), End: windowEnd.UTC(), Seconds: seconds, AgentMinutes: minutes},
	}

	names := map[string]struct{}{}
	for n := range routes {
		names[n] = struct{}{}
	}
	for n := range model {
		names[n] = struct{}{}
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)

	var expected float64
	for _, n := range sorted {
		st := routes[n]
		exp, modelled := model[n]
		rep.Routes = append(rep.Routes, RouteReport{
			Route: n, Requests: st.requests, Attempts: st.attempts,
			PerAgentMinute: perAgentMinute(st.requests, minutes), ExpectedPerAgentMinute: exp,
			LatencyMs: st.latency, Status: st.status, StatusTotal: st.statusTotal, TransportErrors: st.transportErrors,
		})
		if modelled {
			rep.Totals.Requests += st.requests
			rep.Totals.Attempts += st.attempts
			expected += exp
		}
		if n == RouteEnroll || n == RouteWSUpgrade {
			continue // once per agent / per connection, not steady-state traffic; 101 is not an error
		}
		rep.Totals.AllRequests += st.requests
		rep.Totals.TransportErrors += st.transportErrors
		for code, c := range st.status {
			if code < 200 || code >= 300 {
				rep.Totals.Non2xx += c
			}
		}
	}
	rep.Totals.RequestsPerAgentMinute = perAgentMinute(rep.Totals.Requests, minutes)
	rep.Totals.ExpectedRequestsPerAgentMinute = expected
	if expected > 0 && minutes > 0 {
		rep.Totals.DeviationPct = (rep.Totals.RequestsPerAgentMinute - expected) / expected * 100
	}

	rec.mu.Lock()
	rep.WS = WSReport{
		Connects: rec.wsConnects.Load(), Reconnects: rec.wsReconnects.Load(), ConnectFailures: rec.wsConnectFailures.Load(),
		Disconnects: rec.wsDisconnects.Load(), ControlPingsSent: rec.wsControlPings.Load(), ControlPongsReceived: rec.wsControlPongs.Load(),
		FramesReceived: copyCounts(rec.frames), ConnectLatencyMs: latencyOf(rec.wsConnectLatency),
	}
	rep.Commands = CommandReport{
		Dispatched: rec.cmdDispatched.Load(), DispatchFailures: rec.cmdDispatchFailed.Load(),
		Received: copyCounts(rec.cmdVia), Duplicates: rec.cmdDuplicates.Load(), Dropped: rec.cmdDropped.Load(),
		ResultsSent: copyCounts(rec.resVia),
	}
	rec.mu.Unlock()
	return rep
}

// WriteReport writes r atomically (temp file + rename).
func WriteReport(path string, r Report) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".report-*.json")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestExpectedMix|TestBuildReport'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/sim/model.go agent/tools/agentsim/sim/report.go agent/tools/agentsim/sim/report_test.go
git commit -m "feat(agentsim): expected-mix model and breeze.agentsim.report/v1 run report"
```

---
### Task 5: Token store

Re-runs reuse enrolled devices instead of re-enrolling. Each store carries a random tag in its hostname base, so a fresh store never collides with rows an old run left behind (a hostname collision makes the API mint a fresh row plus an audit entry and an alert, `enrollment.ts` #2764).

**Files:**
- Create: `agent/tools/agentsim/sim/store.go`
- Test: `agent/tools/agentsim/sim/store_test.go`

**Interfaces:**
- Produces:
  - `type Identity struct { Index int; Hostname, AgentID, DeviceID, AuthToken, OrgID, SiteID string; EnrolledAt time.Time }` (JSON camelCase).
  - `type TokenStore`; `func LoadStore(path, serverURL, prefix string) (*TokenStore, error)`; methods `Hostname(index int) string`, `ReenrollHostname(index int) string`, `HostnameBase() string`, `Get(index int) (Identity, bool)`, `Put(id Identity)`, `Missing(n int) int`, `Save(path string) error`.

- [ ] **Step 1: Write the failing test**

```go
// agent/tools/agentsim/sim/store_test.go
package sim

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestStoreRoundTripAndPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "tokens.json")
	s, err := LoadStore(path, "http://localhost:1", "agentsim")
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^agentsim-[0-9a-f]{6}-00007$`).MatchString(s.Hostname(7)) {
		t.Fatalf("hostname %q", s.Hostname(7))
	}
	s.Put(Identity{Index: 3, Hostname: s.Hostname(3), AgentID: "a3", AuthToken: "brz_x"})
	if s.Missing(5) != 4 {
		t.Fatalf("Missing(5) = %d, want 4", s.Missing(5))
	}
	if err := s.Save(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token store mode %o, want 600 (it holds bearer tokens)", perm)
	}
	again, err := LoadStore(path, "http://localhost:1", "ignored-on-reload")
	if err != nil {
		t.Fatal(err)
	}
	if got, ok := again.Get(3); !ok || got.AuthToken != "brz_x" {
		t.Fatalf("reloaded identity %+v %v", got, ok)
	}
	if again.HostnameBase() != s.HostnameBase() {
		t.Fatal("the hostname base must survive a reload, or re-runs would collide with their own rows")
	}
}

func TestLoadStoreRefusesAStoreFromAnotherServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tokens.json")
	s, _ := LoadStore(path, "http://stack-a:1", "agentsim")
	if err := s.Save(path); err != nil {
		t.Fatal(err)
	}
	_, err := LoadStore(path, "http://stack-b:1", "agentsim")
	if err == nil || !strings.Contains(err.Error(), "http://stack-a:1") || !strings.Contains(err.Error(), "http://stack-b:1") {
		t.Fatalf("want a refusal naming both servers, got %v", err)
	}
}

func TestReenrollHostnamesNeverRepeat(t *testing.T) {
	s, _ := LoadStore(filepath.Join(t.TempDir(), "t.json"), "http://x:1", "agentsim")
	a, b := s.ReenrollHostname(1), s.ReenrollHostname(1)
	if a == b || !strings.HasPrefix(a, s.Hostname(1)+"-r") {
		t.Fatalf("re-enroll hostnames %q %q", a, b)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestStore|TestLoadStore|TestReenrollHostnames'`
Expected: FAIL to compile: `undefined: LoadStore`.

- [ ] **Step 3: Write minimal implementation**

```go
// agent/tools/agentsim/sim/store.go
package sim

import (
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const storeVersion = 1

// Identity is one enrolled simulated device.
type Identity struct {
	Index      int       `json:"index"`
	Hostname   string    `json:"hostname"`
	AgentID    string    `json:"agentId"`
	DeviceID   string    `json:"deviceId"`
	AuthToken  string    `json:"authToken"`
	OrgID      string    `json:"orgId"`
	SiteID     string    `json:"siteId"`
	EnrolledAt time.Time `json:"enrolledAt"`
}

type storeFile struct {
	Version      int        `json:"version"`
	ServerURL    string     `json:"serverUrl"`
	HostnameBase string     `json:"hostnameBase"`
	Agents       []Identity `json:"agents"`
}

// TokenStore persists one token per simulated device. Safe for concurrent use.
type TokenStore struct {
	mu       sync.Mutex
	file     storeFile
	byIndex  map[int]int
	reenroll int
}

func randomTag() string {
	b := make([]byte, 3)
	_, _ = crand.Read(b)
	return hex.EncodeToString(b)
}

// LoadStore reads path, or starts an empty store when it does not exist. A
// store written for another server is refused: its tokens must never be sent
// anywhere else.
func LoadStore(path, serverURL, prefix string) (*TokenStore, error) {
	s := &TokenStore{byIndex: map[int]int{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		s.file = storeFile{Version: storeVersion, ServerURL: serverURL, HostnameBase: prefix + "-" + randomTag()}
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.file); err != nil {
		return nil, fmt.Errorf("token store %s: %w", path, err)
	}
	if s.file.Version != storeVersion {
		return nil, fmt.Errorf("token store %s: version %d, want %d", path, s.file.Version, storeVersion)
	}
	if s.file.ServerURL != serverURL {
		return nil, fmt.Errorf("token store %s belongs to %s, not %s; pass another --store", path, s.file.ServerURL, serverURL)
	}
	for i, id := range s.file.Agents {
		s.byIndex[id.Index] = i
	}
	return s, nil
}

func (s *TokenStore) HostnameBase() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.file.HostnameBase
}

func (s *TokenStore) Hostname(index int) string {
	return fmt.Sprintf("%s-%05d", s.HostnameBase(), index)
}

// ReenrollHostname is a never-repeating hostname for re-enrolling index after
// its stored token was rejected (the old row may still exist under the old
// hostname).
func (s *TokenStore) ReenrollHostname(index int) string {
	s.mu.Lock()
	s.reenroll++
	n := s.reenroll
	s.mu.Unlock()
	return fmt.Sprintf("%s-r%d%s", s.Hostname(index), n, randomTag())
}

func (s *TokenStore) Get(index int) (Identity, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i, ok := s.byIndex[index]
	if !ok {
		return Identity{}, false
	}
	return s.file.Agents[i], true
}

func (s *TokenStore) Put(id Identity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i, ok := s.byIndex[id.Index]; ok {
		s.file.Agents[i] = id
		return
	}
	s.byIndex[id.Index] = len(s.file.Agents)
	s.file.Agents = append(s.file.Agents, id)
}

// Missing counts indices in [0, n) with no stored identity.
func (s *TokenStore) Missing(n int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	missing := 0
	for i := 0; i < n; i++ {
		if _, ok := s.byIndex[i]; !ok {
			missing++
		}
	}
	return missing
}

// Save writes the store atomically with mode 0600 (it holds bearer tokens).
func (s *TokenStore) Save(path string) error {
	s.mu.Lock()
	file := s.file
	file.Agents = append([]Identity(nil), s.file.Agents...)
	s.mu.Unlock()
	sort.Slice(file.Agents, func(i, j int) bool { return file.Agents[i].Index < file.Agents[j].Index })
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tokens-*.json") // CreateTemp opens 0600
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestStore|TestLoadStore|TestReenrollHostnames'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/sim/store.go agent/tools/agentsim/sim/store_test.go
git commit -m "feat(agentsim): 0600 token store keyed to one server, collision-free hostnames"
```

---

### Task 6: Enrollment client

Uses the agent's own `api.EnrollRequest` / `api.EnrollResponse` (`agent/pkg/api/client.go`) against `POST /api/v1/agents/enroll`. Only `Content-Type` is sent, as the agent does; the secret goes in the body. A 429 is honoured via `httputil.ParseRetryAfter` (the agent's parser, capped at 300 s).

**Files:**
- Create: `agent/tools/agentsim/sim/enroll.go`, `agent/tools/agentsim/sim/sleep.go`
- Test: `agent/tools/agentsim/sim/enroll_test.go`

**Interfaces:**
- Consumes: `Identity` (Task 5), `withLogicalRequest` (Task 3).
- Produces: `type Enroller struct { ServerURL, Key, Secret, AgentVersion, OSType string; Client *http.Client; MaxAttempts int; Sleep func(ctx context.Context, d time.Duration) bool }`; `func (e *Enroller) Enroll(ctx context.Context, index int, hostname string) (Identity, error)`; `var ErrEnrollRejected`; `func sleepCtx(ctx context.Context, d time.Duration) bool`; `func osVersion(osType string) string`.

- [ ] **Step 1: Write the failing test**

```go
// agent/tools/agentsim/sim/enroll_test.go
package sim

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/pkg/api"
)

func TestEnrollSendsTheAgentsRequestShape(t *testing.T) {
	var got api.EnrollRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agents/enroll" || r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected request %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(api.EnrollResponse{AgentID: "a1", AuthToken: "brz_t", DeviceID: "d1", OrgID: "o1", SiteID: "s1"})
	}))
	defer srv.Close()

	e := &Enroller{ServerURL: srv.URL, Key: "k", Secret: "sec", AgentVersion: "dev-agentsim", OSType: "linux", Client: srv.Client()}
	id, err := e.Enroll(context.Background(), 4, "agentsim-abc123-00004")
	if err != nil {
		t.Fatal(err)
	}
	if id.Index != 4 || id.AgentID != "a1" || id.DeviceID != "d1" || id.AuthToken != "brz_t" || id.OrgID != "o1" {
		t.Fatalf("identity %+v", id)
	}
	if got.EnrollmentKey != "k" || got.EnrollmentSecret != "sec" || got.Hostname != "agentsim-abc123-00004" ||
		got.OSType != "linux" || got.AgentVersion != "dev-agentsim" || got.HardwareInfo == nil ||
		got.HardwareInfo.SerialNumber != "AGENTSIM-agentsim-abc123-00004" {
		t.Fatalf("enroll request %+v", got)
	}
}

func TestEnrollHonours429RetryAfter(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(api.EnrollResponse{AgentID: "a1", AuthToken: "brz_t"})
	}))
	defer srv.Close()

	var slept []time.Duration
	e := &Enroller{ServerURL: srv.URL, Key: "k", OSType: "linux", Client: srv.Client(),
		Sleep: func(_ context.Context, d time.Duration) bool { slept = append(slept, d); return true }}
	if _, err := e.Enroll(context.Background(), 0, "h"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || len(slept) != 1 || slept[0] != 7*time.Second {
		t.Fatalf("calls %d slept %v, want 2 calls and one 7s wait", calls.Load(), slept)
	}
}

func TestEnrollRejectionIsTerminal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Enrollment tenant is not active"}`))
	}))
	defer srv.Close()
	e := &Enroller{ServerURL: srv.URL, Key: "k", OSType: "linux", Client: srv.Client()}
	_, err := e.Enroll(context.Background(), 0, "h")
	if !errors.Is(err, ErrEnrollRejected) {
		t.Fatalf("want ErrEnrollRejected, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run TestEnroll`
Expected: FAIL to compile: `undefined: Enroller`.

- [ ] **Step 3: Write minimal implementation**

```go
// agent/tools/agentsim/sim/sleep.go
package sim

import (
	"context"
	"time"
)

// sleepCtx waits d or until ctx ends; false means ctx ended.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func osVersion(osType string) string {
	switch osType {
	case "windows":
		return "Windows 11 Pro 23H2 (agentsim)"
	case "macos":
		return "macOS 15.1 (agentsim)"
	default:
		return "Ubuntu 24.04 LTS (agentsim)"
	}
}
```

```go
// agent/tools/agentsim/sim/enroll.go
package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/pkg/api"
)

// ErrEnrollRejected is a terminal (non-429) enrollment refusal.
var ErrEnrollRejected = errors.New("enrollment rejected")

// Enroller enrolls simulated devices the way `breeze-agent enroll` does.
type Enroller struct {
	ServerURL    string
	Key          string
	Secret       string
	AgentVersion string
	OSType       string
	Client       *http.Client
	MaxAttempts  int                                             // default 5
	Sleep        func(ctx context.Context, d time.Duration) bool // default sleepCtx
}

func (e *Enroller) Enroll(ctx context.Context, index int, hostname string) (Identity, error) {
	body, err := json.Marshal(api.EnrollRequest{
		EnrollmentKey:    e.Key,
		EnrollmentSecret: e.Secret,
		Hostname:         hostname,
		OSType:           e.OSType,
		OSVersion:        osVersion(e.OSType),
		Architecture:     "amd64",
		AgentVersion:     e.AgentVersion,
		HardwareInfo: &api.HardwareInfo{
			CPUModel: "agentsim vCPU", CPUCores: 4, CPUThreads: 8, RAMTotalMB: 16384, DiskTotalGB: 500,
			SerialNumber: "AGENTSIM-" + hostname, Manufacturer: "Breeze", Model: "agentsim",
		},
	})
	if err != nil {
		return Identity{}, err
	}
	attempts := e.MaxAttempts
	if attempts <= 0 {
		attempts = 5
	}
	sleep := e.Sleep
	if sleep == nil {
		sleep = sleepCtx
	}
	for attempt := 1; ; attempt++ {
		req, err := http.NewRequestWithContext(withLogicalRequest(ctx), http.MethodPost,
			e.ServerURL+"/api/v1/agents/enroll", bytes.NewReader(body))
		if err != nil {
			return Identity{}, err
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := e.Client.Do(req)
		if err != nil {
			if attempt >= attempts || !sleep(ctx, time.Second) {
				return Identity{}, fmt.Errorf("enroll %s: %w", hostname, err)
			}
			continue
		}
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated:
			var out api.EnrollResponse
			if err := json.Unmarshal(data, &out); err != nil {
				return Identity{}, fmt.Errorf("enroll %s: decode response: %w", hostname, err)
			}
			if out.AgentID == "" || !strings.HasPrefix(out.AuthToken, "brz_") {
				return Identity{}, fmt.Errorf("enroll %s: response has no agentId or brz_ token", hostname)
			}
			return Identity{Index: index, Hostname: hostname, AgentID: out.AgentID, DeviceID: out.DeviceID,
				AuthToken: out.AuthToken, OrgID: out.OrgID, SiteID: out.SiteID, EnrolledAt: time.Now().UTC()}, nil
		case resp.StatusCode == http.StatusTooManyRequests && attempt < attempts:
			wait := httputil.ParseRetryAfter(resp.Header, time.Now())
			if wait <= 0 {
				wait = time.Second
			}
			if !sleep(ctx, wait) {
				return Identity{}, ctx.Err()
			}
		default:
			msg := string(data)
			if len(msg) > 300 {
				msg = msg[:300]
			}
			return Identity{}, fmt.Errorf("%w: %s: HTTP %d: %s", ErrEnrollRejected, hostname, resp.StatusCode, msg)
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run TestEnroll`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/sim/enroll.go agent/tools/agentsim/sim/sleep.go agent/tools/agentsim/sim/enroll_test.go
git commit -m "feat(agentsim): enroll through a real enrollment key with the agent's request shape"
```

---

### Task 7: Request payloads from the agent's own structs

Every body is built from the agent's wire types so a renamed or retyped field breaks this build. Values satisfy the API's zod schemas (`apps/api/src/routes/agents/schemas.ts`, `packages/shared/src/types/softwareInventoryObservation.ts`); the test pins the constraints that would otherwise 400 silently.

**Files:**
- Create: `agent/tools/agentsim/sim/payloads.go`
- Test: `agent/tools/agentsim/sim/payloads_test.go`

**Interfaces:**
- Consumes: `Config` (Task 2), `Identity` (Task 5), `heartbeat.CompiledSecurityCapabilities` (Task 1), `osVersion` (Task 6).
- Produces: `type Payloads`; `func NewPayloads(cfg *Config, rng *rand.Rand) *Payloads`; methods `Heartbeat(id Identity, uptime time.Duration) heartbeat.HeartbeatPayload`, `Software(now time.Time) collectors.SoftwareInventoryObservationV2`, `Disks() map[string]any`, `Network(id Identity) map[string]any`, `Connections(id Identity) map[string]any`, `RegistryState() map[string]any`, `ConfigState() map[string]any`, `Sessions(now time.Time) map[string]any`, `Security(id Identity) security.SecurityStatus`, `Posture(now time.Time) mgmtdetect.ManagementPosture`, `EventLogs(now time.Time) map[string]any`, `ProcessSample(now time.Time) map[string]any`; helpers `macFor(index int) string`, `ipFor(index int) string`.

- [ ] **Step 1: Write the failing test**

```go
// agent/tools/agentsim/sim/payloads_test.go
package sim

import (
	"encoding/json"
	"math/rand/v2"
	"strings"
	"testing"
	"time"
)

func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func testPayloads() *Payloads {
	cfg := DefaultConfig()
	return NewPayloads(&cfg, rand.New(rand.NewPCG(1, 2)))
}

var testID = Identity{Index: 2, Hostname: "agentsim-abc123-00002", AgentID: "a2", DeviceID: "d2", OrgID: "o1"}

func TestHeartbeatPayloadCarriesTheRequiredFields(t *testing.T) {
	m := asJSON(t, testPayloads().Heartbeat(testID, 72*time.Hour))
	if m["status"] != "ok" || m["agentVersion"] != "dev-agentsim" || m["hostname"] != testID.Hostname {
		t.Fatalf("heartbeat %v", m)
	}
	caps := m["securityCapabilities"].(map[string]any)
	if caps["revocationLeaseProtocolVersion"] != float64(1) {
		t.Fatalf("capabilities %v", caps)
	}
	metrics := m["metrics"].(map[string]any)
	for _, k := range []string{"cpuPercent", "ramPercent", "ramUsedMb", "diskPercent", "diskUsedGb"} {
		if _, ok := metrics[k]; !ok {
			t.Errorf("metrics.%s missing (required by heartbeatSchema)", k)
		}
	}
}

func TestSoftwareObservationSatisfiesTheV2Refinements(t *testing.T) {
	m := asJSON(t, testPayloads().Software(time.Now()))
	items := m["items"].([]any)
	if m["schemaVersion"] != float64(2) || int(m["itemCount"].(float64)) != len(items) || len(items) == 0 {
		t.Fatalf("itemCount must equal len(items): %v / %d", m["itemCount"], len(items))
	}
	if fs, ok := m["failedSources"].([]any); !ok || len(fs) != 0 {
		t.Fatalf("failedSources must be an empty array, not null: %v", m["failedSources"])
	}
	if m["completeness"] != "complete" || !strings.HasSuffix(m["observedAt"].(string), "Z") {
		t.Fatalf("completeness/observedAt %v %v", m["completeness"], m["observedAt"])
	}
}

func TestSessionPrincipalHasExactlyOneOfUIDOrSID(t *testing.T) {
	m := asJSON(t, testPayloads().Sessions(time.Now()))
	s := m["sessions"].([]any)[0].(map[string]any)
	p := s["principal"].(map[string]any)
	_, hasUID := p["uid"]
	_, hasSID := p["sid"]
	if !hasUID || hasSID {
		t.Fatalf("principal must carry exactly one of uid/sid: %v", p)
	}
	if ev, ok := m["events"].([]any); !ok || len(ev) != 0 {
		t.Fatalf("events must be an empty array: %v", m["events"])
	}
}

func TestPerAgentIdentityFieldsDiffer(t *testing.T) {
	if macFor(1) == macFor(2) || ipFor(1) == ipFor(2) {
		t.Fatal("MAC and IP must be distinct per agent")
	}
	ps := asJSON(t, testPayloads().ProcessSample(time.Now()))
	if n := len(ps["processes"].([]any)); n == 0 || n > 16 {
		t.Fatalf("processes %d, schema allows 1..16", n)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestHeartbeatPayload|TestSoftwareObservation|TestSessionPrincipal|TestPerAgentIdentity'`
Expected: FAIL to compile: `undefined: NewPayloads`.

- [ ] **Step 3: Write minimal implementation**

```go
// agent/tools/agentsim/sim/payloads.go
package sim

import (
	"fmt"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/mgmtdetect"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

// Payloads builds request bodies from the agent's own wire structs.
type Payloads struct {
	cfg *Config
	mu  sync.Mutex
	rng *rand.Rand
}

func NewPayloads(cfg *Config, rng *rand.Rand) *Payloads { return &Payloads{cfg: cfg, rng: rng} }

func (p *Payloads) between(lo, hi float64) float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return lo + p.rng.Float64()*(hi-lo)
}

func macFor(index int) string {
	return fmt.Sprintf("02:42:%02x:%02x:%02x:%02x", byte(index>>24), byte(index>>16), byte(index>>8), byte(index))
}

func ipFor(index int) string {
	return fmt.Sprintf("10.%d.%d.%d", 64+((index>>16)&0x3f), (index>>8)&0xff, index&0xff)
}

func (p *Payloads) Heartbeat(id Identity, uptime time.Duration) heartbeat.HeartbeatPayload {
	available := true
	ram := p.between(30, 70)
	return heartbeat.HeartbeatPayload{
		Metrics: &collectors.SystemMetrics{
			CPUPercent:   p.between(2, 35),
			RAMPercent:   ram,
			RAMUsedMB:    uint64(ram / 100 * 16384),
			DiskPercent:  41.5,
			DiskUsedGB:   207.5,
			ProcessCount: 180 + int(p.between(0, 40)),
		},
		MetricsAvailable:     &available,
		Status:               "ok",
		AgentVersion:         p.cfg.AgentVersion,
		Hostname:             id.Hostname,
		OSVersion:            osVersion(p.cfg.OSType),
		UptimeSeconds:        int64(uptime / time.Second),
		IsHeadless:           true,
		SecurityCapabilities: heartbeat.CompiledSecurityCapabilities(),
	}
}

var softwareCatalog = func() []collectors.SoftwareItem {
	items := []collectors.SoftwareItem{
		{Name: "openssl", Version: "3.0.13", Vendor: "Ubuntu"},
		{Name: "openssh-server", Version: "9.6p1", Vendor: "Ubuntu"},
		{Name: "curl", Version: "8.5.0", Vendor: "Ubuntu"},
		{Name: "python3", Version: "3.12.3", Vendor: "Ubuntu"},
		{Name: "systemd", Version: "255.4", Vendor: "Ubuntu"},
		{Name: "bash", Version: "5.2.21", Vendor: "Ubuntu"},
		{Name: "coreutils", Version: "9.4", Vendor: "Ubuntu"},
		{Name: "git", Version: "2.43.0", Vendor: "Ubuntu"},
	}
	for i := len(items); i < 40; i++ {
		items = append(items, collectors.SoftwareItem{Name: fmt.Sprintf("libagentsim%02d", i), Version: fmt.Sprintf("1.0.%d", i), Vendor: "Ubuntu"})
	}
	return items
}()

func (p *Payloads) Software(now time.Time) collectors.SoftwareInventoryObservationV2 {
	items := append([]collectors.SoftwareItem(nil), softwareCatalog...)
	return collectors.SoftwareInventoryObservationV2{
		SchemaVersion:    2,
		ObservationID:    uuid.NewString(),
		CollectorVersion: "agentsim-1",
		ObservedAt:       now.UTC(),
		Completeness:     collectors.SoftwareInventoryComplete,
		ExpectedSources:  []string{"dpkg"},
		SucceededSources: []string{"dpkg"},
		FailedSources:    []collectors.SoftwareSourceFailure{},
		ItemCount:        len(items),
		Items:            items,
	}
}

func (p *Payloads) Disks() map[string]any {
	return map[string]any{"disks": []collectors.DiskInfo{{
		MountPoint: "/", Device: "/dev/sda1", FSType: "ext4",
		TotalGB: 500, UsedGB: 207.5, FreeGB: 292.5, UsedPercent: 41.5, Health: "healthy",
	}}}
}

func (p *Payloads) Network(id Identity) map[string]any {
	return map[string]any{
		"adapters": []collectors.NetworkAdapterInfo{{
			InterfaceName: "eth0", MACAddress: macFor(id.Index), IPAddress: ipFor(id.Index), IPType: "ipv4", IsPrimary: true,
		}},
		"vpns": []any{},
	}
}

// Connections mirrors heartbeat.go sendConnectionsInventory, which sends maps.
func (p *Payloads) Connections(id Identity) map[string]any {
	conns := []map[string]any{}
	for i, proc := range []string{"sshd", "breeze-agent", "systemd-resolved", "chronyd", "postgres"} {
		conns = append(conns, map[string]any{
			"protocol": "tcp", "localAddr": ipFor(id.Index), "localPort": 22 + i,
			"remoteAddr": "10.0.0.1", "remotePort": 40000 + i, "state": "ESTABLISHED",
			"pid": 800 + i, "processName": proc,
		})
	}
	return map[string]any{"connections": conns}
}

func (p *Payloads) RegistryState() map[string]any {
	return map[string]any{"entries": []any{}, "replace": true}
}

func (p *Payloads) ConfigState() map[string]any {
	return map[string]any{"entries": []any{}, "replace": true}
}

// Sessions mirrors heartbeat.go sendSessionInventory.
func (p *Payloads) Sessions(now time.Time) map[string]any {
	uid := uint32(1000)
	idle := 3
	return map[string]any{
		"sessions": []collectors.UserSession{{
			Username: "simuser", SessionType: "ssh", SessionID: "1",
			LoginAt: now.Add(-2 * time.Hour).UTC(), IdleMinutes: &idle, ActivityState: "active",
			IsActive: true, LastActivityAt: now.Add(-3 * time.Minute).UTC(),
			Principal: &collectors.SessionPrincipal{UID: &uid, Username: "simuser"},
		}},
		"events":      []collectors.UserSessionEvent{},
		"collectedAt": now.UTC(),
	}
}

func (p *Payloads) Security(id Identity) security.SecurityStatus {
	return security.SecurityStatus{
		DeviceID: id.DeviceID, DeviceName: id.Hostname, OrgID: id.OrgID, OS: p.cfg.OSType,
		Provider: "none", FirewallEnabled: true, EncryptionStatus: "encrypted",
	}
}

func (p *Payloads) Posture(now time.Time) mgmtdetect.ManagementPosture {
	return mgmtdetect.ManagementPosture{
		CollectedAt:    now.UTC(),
		ScanDurationMs: 420,
		Categories:     map[mgmtdetect.Category][]mgmtdetect.Detection{},
		Identity:       mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinTypeNone, Source: "agentsim"},
	}
}

func (p *Payloads) EventLogs(now time.Time) map[string]any {
	events := make([]collectors.EventLogEntry, 0, 3)
	for i := 0; i < 3; i++ {
		events = append(events, collectors.EventLogEntry{
			Timestamp: now.Add(-time.Duration(i) * time.Minute).UTC().Format(time.RFC3339),
			Level:     "info", Category: "system", Source: "systemd",
			EventID: fmt.Sprint(1000 + i), Message: "agentsim: periodic system event",
		})
	}
	return map[string]any{"events": events}
}

// ProcessSample mirrors heartbeat.go sendProcessSample (top-N union, ≤ 16).
func (p *Payloads) ProcessSample(now time.Time) map[string]any {
	names := []string{"breeze-agent", "sshd", "systemd", "postgres", "node", "dockerd", "containerd", "chronyd"}
	procs := make([]tools.ProcessSampleEntry, 0, len(names))
	for i, n := range names {
		procs = append(procs, tools.ProcessSampleEntry{Name: n, PID: int32(100 + i), CPU: p.between(0, 5), RAMMb: p.between(10, 400)})
	}
	return map[string]any{"timestamp": now.UTC().Format(time.RFC3339), "processes": procs}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestHeartbeatPayload|TestSoftwareObservation|TestSessionPrincipal|TestPerAgentIdentity'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/sim/payloads.go agent/tools/agentsim/sim/payloads_test.go
git commit -m "feat(agentsim): request bodies built from the agent's own wire structs"
```

---
### Task 8: One simulated agent — HTTP loops, tick gates, command worker (with the shared fake API)

Mirrors `heartbeat.go Start()`: random first-beat delay in `[0, interval)`, a heartbeat ticker, and after each beat (with `now` read *after* it returns) the gated security / sessions / event-log / posture sends and the six-PUT inventory batch as concurrent goroutines. Independent loops mirror `unifi/collector.go` (plain GET every 30 s, no retry wrapper), the process sampler (180 s ticker) and `workspaceindex` (≈60 s ±10 %, 6 h after a 404). Commands arriving in a heartbeat response or over the socket are answered over the socket when connected, else by `POST /commands/:id/result` (the agent's HTTP fallback). The WebSocket session itself is Task 9; this task defines the `socket` seam it plugs into.

**Files:**
- Create: `agent/tools/agentsim/sim/gates.go`, `agent/tools/agentsim/sim/agent.go`
- Create (test-only, shared by Tasks 8–10): `agent/tools/agentsim/sim/fakeapi_test.go`
- Test: `agent/tools/agentsim/sim/gates_test.go`, `agent/tools/agentsim/sim/agent_test.go`

**Interfaces:**
- Consumes: `Config`, `Cadence`, `StartMode` (Task 2); `Recorder`, `recordingTransport`, `withLogicalRequest`, route constants (Task 3); `Identity` (Task 5); `sleepCtx` (Task 6); `Payloads` (Task 7).
- Produces:
  - `type gate`, `type gates`, `func newGates(c Cadence, mode StartMode, now time.Time, randDur func(time.Duration) time.Duration) gates`.
  - `type socket interface { Run(ctx context.Context); Connected() bool; SendResult(r agentws.CommandResult) error }`.
  - `type Agent`; `func NewAgent(cfg *Config, rec *Recorder, id Identity, reenroll func(context.Context, Identity) (Identity, error)) *Agent`; `(*Agent).Run(ctx context.Context)`; package-internal `identity()`, `enqueue(cmd agentws.Command, via string)`, `jitter(d time.Duration, frac float64) time.Duration`, `randDuration(max time.Duration) time.Duration`, and the fields `cfg`, `rec`, `ws socket`.
  - Test helpers (in `fakeapi_test.go`): `newFakeAPI(t) *fakeAPI`, `(*fakeAPI).preEnroll(index int) Identity`, `count(route string) int`, `result(commandID string) string`, `pongs() int`, `queueHeartbeatCommand(agentID, commandID string)`, `pushWS(agentID, commandID string) error`, `dropSockets()`, `setRejectWS(bool)`, `setPingEvery(time.Duration)`, `setEnroll429(n int)`, `socketFor(agentID string) bool`; `testConfig(f *fakeAPI, dir string) Config`, `fastCadence() Cadence`, `newTestRecorder() *Recorder`, `eventually(t, within, cond, msg)`.

- [ ] **Step 1: Write the fake API (test-only)**

```go
// agent/tools/agentsim/sim/fakeapi_test.go
package sim

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	gws "github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/pkg/api"
)

// fakeAPI is just enough of the Breeze API for the simulator's tests: bearer
// auth, enrollment, the steady-state routes, the agent WebSocket, admin login
// and command dispatch. Every request is counted by RouteKey.
type fakeAPI struct {
	srv *httptest.Server

	mu          sync.Mutex
	counts      map[string]int
	tokens      map[string]string // agentId -> bearer token
	devices     map[string]string // deviceId -> agentId
	sockets     map[string]*fakeSocket
	pending     map[string][]heartbeat.Command // agentId -> commands for the next heartbeat response
	results     map[string]string              // commandId -> "ws" | "http"
	pongCount   int
	enroll429   int
	rejectWS    bool
	pingEvery   time.Duration
	nextAgent   int
	nextCommand int
}

type fakeSocket struct {
	mu   sync.Mutex
	conn *gws.Conn
}

func (s *fakeSocket) write(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteJSON(v)
}

var fakeUpgrader = gws.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func newFakeAPI(t *testing.T) *fakeAPI {
	t.Helper()
	f := &fakeAPI{counts: map[string]int{}, tokens: map[string]string{}, devices: map[string]string{},
		sockets: map[string]*fakeSocket{}, pending: map[string][]heartbeat.Command{}, results: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(func() { f.dropSockets(); f.srv.Close() })
	return f
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// pathSegment returns segment i of /api/v1/<...>: 3 is the agent or device id.
func pathSegment(path string, i int) string {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	if i < len(segs) {
		return segs[i]
	}
	return ""
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	route := RouteKey(r.Method, r.URL.Path)
	f.mu.Lock()
	f.counts[route]++
	f.mu.Unlock()
	switch {
	case route == RouteEnroll:
		f.enroll(w, r)
	case route == "POST /auth/login":
		writeJSON(w, http.StatusOK, map[string]any{"tokens": map[string]string{"accessToken": "admin-jwt"}})
	case strings.HasPrefix(route, "POST /devices/"):
		f.dispatch(w, r)
	case route == RouteCrawlConfig:
		http.NotFound(w, r) // workspace module not loaded
	case route == RouteWSUpgrade:
		f.upgrade(w, r)
	case !f.authorized(r):
		w.WriteHeader(http.StatusUnauthorized)
	case route == RouteHeartbeat:
		f.heartbeat(w, r)
	case route == RouteUnifi:
		writeJSON(w, http.StatusOK, map[string]any{"collectors": []any{}})
	case route == RouteCommandResult:
		f.mu.Lock()
		f.results[pathSegment(r.URL.Path, 5)] = "http"
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	default:
		_, _ = io.Copy(io.Discard, r.Body)
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	}
}

func (f *fakeAPI) authorized(r *http.Request) bool {
	f.mu.Lock()
	tok, ok := f.tokens[pathSegment(r.URL.Path, 3)]
	f.mu.Unlock()
	return ok && r.Header.Get("Authorization") == "Bearer "+tok
}

func (f *fakeAPI) register() Identity { // caller holds f.mu
	f.nextAgent++
	n := f.nextAgent
	id := Identity{AgentID: fmt.Sprintf("agent-%04d", n), DeviceID: fmt.Sprintf("device-%04d", n),
		AuthToken: fmt.Sprintf("brz_token_%04d", n), OrgID: "org-1", SiteID: "site-1"}
	f.tokens[id.AgentID] = id.AuthToken
	f.devices[id.DeviceID] = id.AgentID
	return id
}

func (f *fakeAPI) enroll(w http.ResponseWriter, r *http.Request) {
	var req api.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.EnrollmentKey == "" || req.Hostname == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	if f.enroll429 > 0 {
		f.enroll429--
		f.mu.Unlock()
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	id := f.register()
	f.mu.Unlock()
	writeJSON(w, http.StatusCreated, api.EnrollResponse{AgentID: id.AgentID, AuthToken: id.AuthToken,
		DeviceID: id.DeviceID, OrgID: id.OrgID, SiteID: id.SiteID})
}

func (f *fakeAPI) preEnroll(index int) Identity {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.register()
	id.Index = index
	id.Hostname = fmt.Sprintf("agentsim-test00-%05d", index)
	return id
}

func (f *fakeAPI) heartbeat(w http.ResponseWriter, r *http.Request) {
	var p heartbeat.HeartbeatPayload
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.Status == "" || p.AgentVersion == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	agentID := pathSegment(r.URL.Path, 3)
	f.mu.Lock()
	cmds := f.pending[agentID]
	delete(f.pending, agentID)
	f.mu.Unlock()
	writeJSON(w, http.StatusOK, heartbeat.HeartbeatResponse{Commands: cmds})
}

func (f *fakeAPI) upgrade(w http.ResponseWriter, r *http.Request) {
	agentID := pathSegment(r.URL.Path, 3)
	f.mu.Lock()
	tok, ok := f.tokens[agentID]
	reject, ping := f.rejectWS, f.pingEvery
	f.mu.Unlock()
	if reject || !ok || r.Header.Get("Authorization") != "Bearer "+tok {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	conn, err := fakeUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	sock := &fakeSocket{conn: conn}
	f.mu.Lock()
	f.sockets[agentID] = sock
	f.mu.Unlock()
	_ = sock.write(map[string]any{"type": "connected", "agentId": agentID})
	done := make(chan struct{})
	if ping > 0 {
		go func() {
			t := time.NewTicker(ping)
			defer t.Stop()
			for {
				select {
				case <-done:
					return
				case <-t.C:
					if sock.write(map[string]any{"type": "ping", "timestamp": time.Now().UnixMilli()}) != nil {
						return
					}
				}
			}
		}()
	}
	go func() {
		defer close(done)
		defer conn.Close()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var frame struct {
				Type      string `json:"type"`
				CommandID string `json:"commandId"`
			}
			_ = json.Unmarshal(data, &frame)
			f.mu.Lock()
			switch frame.Type {
			case "pong":
				f.pongCount++
			case "command_result":
				f.results[frame.CommandID] = "ws"
			}
			f.mu.Unlock()
			if frame.Type == "command_result" {
				_ = sock.write(map[string]any{"type": "ack", "commandId": frame.CommandID})
			}
		}
	}()
}

func (f *fakeAPI) dispatch(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer admin-jwt" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	agentID, ok := f.devices[pathSegment(r.URL.Path, 3)]
	f.nextCommand++
	cmdID := fmt.Sprintf("cmd-%04d", f.nextCommand)
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if f.pushWS(agentID, cmdID) != nil {
		f.queueHeartbeatCommand(agentID, cmdID)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": cmdID})
}

func (f *fakeAPI) pushWS(agentID, commandID string) error {
	f.mu.Lock()
	sock := f.sockets[agentID]
	f.mu.Unlock()
	if sock == nil {
		return fmt.Errorf("no socket for %s", agentID)
	}
	return sock.write(map[string]any{"id": commandID, "type": "refresh_inventory", "payload": map[string]any{}})
}

func (f *fakeAPI) queueHeartbeatCommand(agentID, commandID string) {
	f.mu.Lock()
	f.pending[agentID] = append(f.pending[agentID], heartbeat.Command{ID: commandID, Type: "refresh_inventory"})
	f.mu.Unlock()
}

func (f *fakeAPI) dropSockets() {
	f.mu.Lock()
	socks := f.sockets
	f.sockets = map[string]*fakeSocket{}
	f.mu.Unlock()
	for _, s := range socks {
		_ = s.conn.Close()
	}
}

func (f *fakeAPI) count(route string) int       { f.mu.Lock(); defer f.mu.Unlock(); return f.counts[route] }
func (f *fakeAPI) result(id string) string      { f.mu.Lock(); defer f.mu.Unlock(); return f.results[id] }
func (f *fakeAPI) pongs() int                   { f.mu.Lock(); defer f.mu.Unlock(); return f.pongCount }
func (f *fakeAPI) setRejectWS(v bool)           { f.mu.Lock(); f.rejectWS = v; f.mu.Unlock() }
func (f *fakeAPI) setPingEvery(d time.Duration) { f.mu.Lock(); f.pingEvery = d; f.mu.Unlock() }
func (f *fakeAPI) setEnroll429(n int)           { f.mu.Lock(); f.enroll429 = n; f.mu.Unlock() }
func (f *fakeAPI) socketFor(agentID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sockets[agentID] != nil
}

const ms = time.Millisecond

func fastCadence() Cadence {
	return Cadence{Heartbeat: 100 * ms, UnifiPoll: 50 * ms, CrawlConfig: 100 * ms, ProcessSample: 150 * ms,
		Security: 250 * ms, Sessions: 250 * ms, Inventory: 400 * ms, Posture: 400 * ms, EventLogs: 400 * ms, WSPing: 100 * ms}
}

func testConfig(f *fakeAPI, dir string) Config {
	cfg := DefaultConfig()
	cfg.ServerURL = f.srv.URL
	cfg.EnrollmentKey, cfg.EnrollmentSecret = "key", "secret"
	cfg.Cadence = fastCadence()
	cfg.StorePath = filepath.Join(dir, "tokens.json")
	cfg.ReportPath = filepath.Join(dir, "report.json")
	cfg.Retry = httputil.RetryConfig{MaxRetries: 0, InitialDelay: 10 * ms, MaxDelay: 10 * ms, BackoffFactor: 2}
	cfg.RequestTimeout = 2 * time.Second
	cfg.CommandDelay = 5 * ms
	return cfg
}

func newTestRecorder() *Recorder {
	now := time.Now()
	return NewRecorder("test", now, now, now.Add(time.Hour))
}

func eventually(t *testing.T, within time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * ms)
	}
	t.Fatal(msg)
}
```

- [ ] **Step 2: Write the failing tests**

```go
// agent/tools/agentsim/sim/gates_test.go
package sim

import (
	"testing"
	"time"
)

func TestGateFiresOnlyAfterStrictlyMoreThanItsPeriod(t *testing.T) {
	t0 := time.Now()
	g := gate{period: 5 * time.Minute, last: t0}
	if g.due(t0.Add(5 * time.Minute)) {
		t.Fatal("exactly one period is not > period (heartbeat.go uses a strict >)")
	}
	if !g.due(t0.Add(5*time.Minute + time.Millisecond)) {
		t.Fatal("past the period must fire")
	}
	if g.due(t0.Add(6 * time.Minute)) {
		t.Fatal("fired twice in one period")
	}
	if (&gate{}).due(t0) {
		t.Fatal("a disabled gate never fires")
	}
}

func TestColdGatesMatchHeartbeatStart(t *testing.T) {
	t0 := time.Now()
	g := newGates(DefaultCadence(), StartCold, t0, func(time.Duration) time.Duration { return 0 })
	if !g.security.due(t0.Add(time.Minute)) || !g.sessions.due(t0.Add(time.Minute)) || !g.eventlogs.due(t0.Add(time.Minute)) {
		t.Fatal("cold security/sessions/event-log gates are zero-stamped and fire on the first tick")
	}
	if g.inventory.due(t0.Add(time.Minute)) || g.posture.due(t0.Add(time.Minute)) {
		t.Fatal("cold inventory/posture are stamped at startup")
	}
}

func TestWarmGatesStartAtARandomPhase(t *testing.T) {
	t0 := time.Now()
	g := newGates(DefaultCadence(), StartWarm, t0, func(p time.Duration) time.Duration { return p - time.Second })
	if !g.inventory.due(t0.Add(2 * time.Second)) {
		t.Fatal("a warm gate whose phase is almost elapsed must fire within seconds")
	}
}
```

```go
// agent/tools/agentsim/sim/agent_test.go
package sim

import (
	"context"
	"testing"
	"time"
)

func TestAgentDrivesEverySteadyStateStream(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	id := f.preEnroll(0)
	ctx, cancel := context.WithTimeout(context.Background(), 2500*ms)
	defer cancel()
	NewAgent(&cfg, newTestRecorder(), id, nil).Run(ctx)

	for _, route := range append([]string{RouteHeartbeat, RouteUnifi, RouteProcessSample, RouteSecurity,
		RouteSessions, RoutePosture, RouteEventLogs}, InventoryBatchRoutes...) {
		if f.count(route) == 0 {
			t.Errorf("%s was never sent", route)
		}
	}
	if got := f.count(RouteCrawlConfig); got != 1 {
		t.Errorf("crawl-config 404 must back off for 6 h: got %d requests, want 1", got)
	}
	if hb := f.count(RouteHeartbeat); hb < 15 || hb > 27 {
		t.Errorf("heartbeats at 100 ms over ~2.4 s: got %d, want 15..27", hb)
	}
	if u := f.count(RouteUnifi); u < 30 || u > 52 {
		t.Errorf("unifi polls at 50 ms over ~2.5 s: got %d, want 30..52", u)
	}
}

func TestAgentReenrollsWhenTheStoredTokenIs401(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	cfg.WSEnabled = false
	stale := Identity{Index: 0, Hostname: "agentsim-test00-00000", AgentID: "gone", AuthToken: "brz_gone"}
	fresh := f.preEnroll(0)
	calls := 0
	reenroll := func(_ context.Context, old Identity) (Identity, error) {
		calls++
		if old.AgentID != "gone" {
			t.Errorf("re-enroll got %+v", old)
		}
		return fresh, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 700*ms)
	defer cancel()
	a := NewAgent(&cfg, newTestRecorder(), stale, reenroll)
	a.Run(ctx)
	if calls != 1 || a.identity().AgentID != fresh.AgentID {
		t.Fatalf("re-enroll calls %d, identity %s, want 1 call and %s", calls, a.identity().AgentID, fresh.AgentID)
	}
	if f.count(RouteHeartbeat) < 3 {
		t.Fatalf("the fresh identity must keep heartbeating, got %d beats", f.count(RouteHeartbeat))
	}
}

func TestHeartbeatCommandIsAnsweredOverHTTPWithoutASocket(t *testing.T) {
	f := newFakeAPI(t)
	cfg := testConfig(f, t.TempDir())
	cfg.WSEnabled = false
	id := f.preEnroll(0)
	f.queueHeartbeatCommand(id.AgentID, "c-http")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go NewAgent(&cfg, newTestRecorder(), id, nil).Run(ctx)
	eventually(t, 1500*ms, func() bool { return f.result("c-http") == "http" }, "heartbeat-delivered command never got an HTTP result")
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestGate|TestColdGates|TestWarmGates|TestAgent|TestHeartbeatCommand'`
Expected: FAIL to compile: `undefined: gate` / `undefined: NewAgent`.

- [ ] **Step 4: Write the implementation**

```go
// agent/tools/agentsim/sim/gates.go
package sim

import "time"

// gate mirrors one `now.Sub(h.lastX) > interval` check in heartbeat.go Start().
type gate struct {
	period time.Duration
	last   time.Time
}

func (g *gate) due(now time.Time) bool {
	if g.period <= 0 {
		return false
	}
	if now.Sub(g.last) > g.period {
		g.last = now
		return true
	}
	return false
}

type gates struct{ security, sessions, eventlogs, inventory, posture gate }

// newGates seeds the tick-gated streams. Cold: security, sessions and event
// logs are zero-stamped (fire on the first tick) and inventory/posture were
// stamped at startup, exactly as heartbeat.go Start(). Warm: every gate starts
// at a random phase so a fleet's gated sends spread across their period.
func newGates(c Cadence, mode StartMode, now time.Time, randDur func(time.Duration) time.Duration) gates {
	mk := func(p time.Duration, coldLast time.Time) gate {
		if mode == StartWarm && p > 0 {
			return gate{period: p, last: now.Add(-randDur(p))}
		}
		return gate{period: p, last: coldLast}
	}
	return gates{
		security:  mk(c.Security, time.Time{}),
		sessions:  mk(c.Sessions, time.Time{}),
		eventlogs: mk(c.EventLogs, time.Time{}),
		inventory: mk(c.Inventory, now),
		posture:   mk(c.Posture, now),
	}
}
```

```go
// agent/tools/agentsim/sim/agent.go
package sim

import (
	"context"
	"encoding/json"
	"io"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	agentws "github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workspaceindex"
)

// crawlConfigAbsentBackoff mirrors workspaceindex/loop.go moduleAbsentBackoff.
const crawlConfigAbsentBackoff = 6 * time.Hour

// simulatedUptime is added to run time for the heartbeat's uptime field.
const simulatedUptime = 72 * time.Hour

// socket is the agent WebSocket session (ws.go).
type socket interface {
	Run(ctx context.Context)
	Connected() bool
	SendResult(r agentws.CommandResult) error
}

// Agent is one simulated device.
type Agent struct {
	cfg      *Config
	rec      *Recorder
	payloads *Payloads
	client   *http.Client
	reenroll func(context.Context, Identity) (Identity, error)
	started  time.Time
	ws       socket

	mu sync.Mutex
	id Identity

	rngMu sync.Mutex
	rng   *rand.Rand

	commands chan agentws.Command
	seenMu   sync.Mutex
	seen     map[string]struct{}
	inflight sync.WaitGroup
}

// NewAgent builds one agent. reenroll, when set, replaces an identity the
// server rejects with 401 on its first heartbeat (a re-created stack).
func NewAgent(cfg *Config, rec *Recorder, id Identity, reenroll func(context.Context, Identity) (Identity, error)) *Agent {
	seed := uint64(id.Index) + 1
	a := &Agent{
		cfg: cfg, rec: rec, id: id, reenroll: reenroll,
		client:   newAgentHTTPClient(rec, cfg.RequestTimeout),
		rng:      rand.New(rand.NewPCG(seed, 0x5eed)),
		commands: make(chan agentws.Command, 16),
		seen:     map[string]struct{}{},
	}
	a.payloads = NewPayloads(cfg, rand.New(rand.NewPCG(seed, 0xfeed)))
	return a
}

// newAgentHTTPClient clones http.DefaultTransport per agent, as heartbeat.go
// newHeartbeatHTTPClient does, so each simulated agent holds its own
// keep-alive connection the way a real one does.
func newAgentHTTPClient(rec *Recorder, timeout time.Duration) *http.Client {
	base := http.DefaultTransport.(*http.Transport).Clone()
	return &http.Client{Timeout: timeout, Transport: &recordingTransport{base: base, rec: rec}}
}

func (a *Agent) identity() Identity {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.id
}

// randDuration is uniform in [0, max).
func (a *Agent) randDuration(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	a.rngMu.Lock()
	defer a.rngMu.Unlock()
	return time.Duration(a.rng.Int64N(int64(max)))
}

// jitter is d ± frac·d, the way the agent's reconnect and poll loops compute it.
func (a *Agent) jitter(d time.Duration, frac float64) time.Duration {
	a.rngMu.Lock()
	f := a.rng.Float64()
	a.rngMu.Unlock()
	out := d + time.Duration(float64(d)*frac*(f*2-1))
	if out < 0 {
		return d
	}
	return out
}

func (a *Agent) agentPath(action string) string {
	return "/api/v1/agents/" + a.identity().AgentID + "/" + action
}

// send is one agent HTTP call through the agent's own retry wrapper.
func (a *Agent) send(ctx context.Context, method, path string, payload any) (*http.Response, []byte, error) {
	headers := http.Header{"Authorization": {"Bearer " + a.identity().AuthToken}}
	var body []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, nil, err
		}
		body = b
		headers.Set("Content-Type", "application/json")
	}
	resp, err := httputil.Do(withLogicalRequest(ctx), a.client, method, a.cfg.ServerURL+path, body, headers, a.cfg.Retry)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return resp, data, err
}

func (a *Agent) sendAsync(ctx context.Context, method, action string, payload any) {
	path := a.agentPath(action)
	a.inflight.Add(1)
	go func() {
		defer a.inflight.Done()
		_, _, _ = a.send(ctx, method, path, payload)
	}()
}

// Run drives the agent until ctx ends.
func (a *Agent) Run(ctx context.Context) {
	a.started = time.Now()
	index := a.identity().Index
	a.rec.AgentOnline(index, a.started)
	defer func() {
		a.inflight.Wait()
		a.rec.AgentOffline(index, time.Now())
	}()

	// heartbeat.go Start(): the first beat waits a random fraction of one
	// interval — the per-agent start jitter that spreads a fleet's phases.
	if !sleepCtx(ctx, a.randDuration(a.cfg.Cadence.Heartbeat)) {
		return
	}
	if !a.firstHeartbeat(ctx) {
		return
	}
	if a.cfg.StartMode == StartCold {
		a.sendInventoryBatch(ctx)
	}

	var loops sync.WaitGroup
	start := func(f func(context.Context)) {
		loops.Add(1)
		go func() { defer loops.Done(); f(ctx) }()
	}
	start(a.commandWorker)
	start(a.unifiLoop)
	start(a.crawlConfigLoop)
	start(a.processSampleLoop)
	if a.ws != nil {
		start(a.ws.Run)
	}
	a.tickLoop(ctx)
	loops.Wait()
}

// firstHeartbeat validates a stored identity: a 401 means the stack no longer
// knows this device, so it is re-enrolled once instead of 401-ing all run.
func (a *Agent) firstHeartbeat(ctx context.Context) bool {
	if a.heartbeat(ctx) == http.StatusUnauthorized && a.reenroll != nil {
		fresh, err := a.reenroll(ctx, a.identity())
		if err != nil {
			return false
		}
		a.mu.Lock()
		a.id = fresh
		a.mu.Unlock()
		a.heartbeat(ctx)
	}
	return ctx.Err() == nil
}

// heartbeat sends one beat and queues any commands in the response.
func (a *Agent) heartbeat(ctx context.Context) int {
	payload := a.payloads.Heartbeat(a.identity(), simulatedUptime+time.Since(a.started))
	resp, body, err := a.send(ctx, http.MethodPost, a.agentPath("heartbeat"), payload)
	if err != nil {
		return 0
	}
	if resp.StatusCode == http.StatusOK {
		var hr heartbeat.HeartbeatResponse
		if json.Unmarshal(body, &hr) == nil {
			for _, c := range hr.Commands {
				a.enqueue(agentws.Command{ID: c.ID, Type: c.Type, Payload: c.Payload}, "http")
			}
		}
	}
	return resp.StatusCode
}

func (a *Agent) tickLoop(ctx context.Context) {
	g := newGates(a.cfg.Cadence, a.cfg.StartMode, time.Now(), a.randDuration)
	ticker := time.NewTicker(a.cfg.Cadence.Heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.heartbeat(ctx)
			now := time.Now() // read AFTER the beat returns, as heartbeat.go Start() does
			if g.inventory.due(now) {
				a.sendInventoryBatch(ctx)
			}
			if g.eventlogs.due(now) {
				a.sendAsync(ctx, http.MethodPut, "eventlogs", a.payloads.EventLogs(now))
			}
			if g.security.due(now) {
				a.sendAsync(ctx, http.MethodPut, "security/status", a.payloads.Security(a.identity()))
			}
			if g.sessions.due(now) {
				a.sendAsync(ctx, http.MethodPut, "sessions", a.payloads.Sessions(now))
			}
			if g.posture.due(now) {
				a.sendAsync(ctx, http.MethodPut, "management/posture", a.payloads.Posture(now))
			}
		}
	}
}

// sendInventoryBatch is heartbeat.go sendInventory(): concurrent PUTs.
func (a *Agent) sendInventoryBatch(ctx context.Context) {
	now := time.Now()
	id := a.identity()
	a.sendAsync(ctx, http.MethodPut, "software", a.payloads.Software(now))
	a.sendAsync(ctx, http.MethodPut, "disks", a.payloads.Disks())
	a.sendAsync(ctx, http.MethodPut, "network", a.payloads.Network(id))
	a.sendAsync(ctx, http.MethodPut, "connections", a.payloads.Connections(id))
	a.sendAsync(ctx, http.MethodPut, "registry-state", a.payloads.RegistryState())
	a.sendAsync(ctx, http.MethodPut, "config-state", a.payloads.ConfigState())
}

// periodic runs f on its own ticker, as the agent's independent loops do.
// Warm agents start at a random phase.
func (a *Agent) periodic(ctx context.Context, period time.Duration, f func()) {
	if period <= 0 {
		return
	}
	if a.cfg.StartMode == StartWarm && !sleepCtx(ctx, a.randDuration(period)) {
		return
	}
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

func (a *Agent) unifiLoop(ctx context.Context) {
	a.periodic(ctx, a.cfg.Cadence.UnifiPoll, func() {
		// unifi/collector.go fetchConfigs: one plain GET, no retry wrapper.
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.ServerURL+a.agentPath("unifi-collectors"), nil)
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+a.identity().AuthToken)
		if resp, err := a.client.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
		}
	})
}

func (a *Agent) processSampleLoop(ctx context.Context) {
	a.periodic(ctx, a.cfg.Cadence.ProcessSample, func() {
		_, _, _ = a.send(ctx, http.MethodPost, a.agentPath("process-sample"), a.payloads.ProcessSample(time.Now()))
	})
}

func (a *Agent) crawlConfigLoop(ctx context.Context) {
	period := a.cfg.Cadence.CrawlConfig
	if period <= 0 {
		return
	}
	wait := a.randDuration(period)
	for {
		if !sleepCtx(ctx, wait) {
			return
		}
		resp, _, err := a.send(ctx, http.MethodGet, workspaceindex.DefaultEndpointBase+"/crawl-config", nil)
		if err == nil && resp.StatusCode == http.StatusNotFound {
			wait = crawlConfigAbsentBackoff
			continue
		}
		wait = a.jitter(period, 0.10)
	}
}

// enqueue de-duplicates by command id (a command can arrive over both paths).
func (a *Agent) enqueue(cmd agentws.Command, via string) {
	a.seenMu.Lock()
	if _, dup := a.seen[cmd.ID]; dup {
		a.seenMu.Unlock()
		a.rec.CommandDuplicate()
		return
	}
	if len(a.seen) > 1024 {
		a.seen = map[string]struct{}{}
	}
	a.seen[cmd.ID] = struct{}{}
	a.seenMu.Unlock()
	a.rec.CommandReceived(via)
	select {
	case a.commands <- cmd:
	default:
		a.rec.CommandDropped()
	}
}

func (a *Agent) commandWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case cmd := <-a.commands:
			if !sleepCtx(ctx, a.cfg.CommandDelay) {
				return
			}
			a.reply(ctx, cmd)
		}
	}
}

// reply answers over the socket when connected, else over HTTP — the
// fallback heartbeat.go processCommand uses without a socket.
func (a *Agent) reply(ctx context.Context, cmd agentws.Command) {
	if a.ws != nil && a.ws.Connected() {
		err := a.ws.SendResult(agentws.CommandResult{CommandID: cmd.ID, Status: "completed", ExitCode: 0, Stdout: "agentsim"})
		if err == nil {
			a.rec.CommandResultSent("ws")
			return
		}
	}
	resp, _, err := a.send(ctx, http.MethodPost, a.agentPath("commands/"+cmd.ID+"/result"),
		tools.CommandResult{Status: "completed", ExitCode: 0, Stdout: "agentsim"})
	if err == nil && resp.StatusCode < 300 {
		a.rec.CommandResultSent("http")
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd agent && go test -race -count=3 ./tools/agentsim/sim/ -run 'TestGate|TestColdGates|TestWarmGates|TestAgent|TestHeartbeatCommand'`
Expected: PASS three times (the count catches timing flakiness under `-race`; widen a bound only with a comment explaining the timing it absorbs).

- [ ] **Step 6: Commit**

```bash
git add agent/tools/agentsim/sim/gates.go agent/tools/agentsim/sim/gates_test.go \
  agent/tools/agentsim/sim/agent.go agent/tools/agentsim/sim/agent_test.go \
  agent/tools/agentsim/sim/fakeapi_test.go
git commit -m "feat(agentsim): simulated agent HTTP loops, tick gates and command replies"
```

---
### Task 9: Agent WebSocket session

A thin gorilla client that reproduces `internal/websocket/client.go` on the wire: `GET /api/v1/agent-ws/<agentId>/ws` with `Authorization: Bearer`, 10 s handshake, no hello frame; control ping every 54 s and a 60 s read deadline refreshed on each pong; `{"type":"pong","timestamp":<ms>}` for every server `{"type":"ping"}` (the server closes with 4008 otherwise); any frame with a non-empty `id` is a command; results as `agentws.CommandResult{type:"command_result"}`. Reconnect exactly as `reconnectLoop` (client.go:385-432): a failed connect sleeps `backoff ± 30 %` and doubles to 60 s; an established socket that drops is redialled at once; backoff resets only after a connection that lasted more than 30 s.

**Files:**
- Create: `agent/tools/agentsim/sim/ws.go`
- Modify: `agent/tools/agentsim/sim/agent.go` (`NewAgent`: attach the session)
- Test: `agent/tools/agentsim/sim/ws_test.go`

**Interfaces:**
- Consumes: `Agent` (`identity()`, `enqueue`, `jitter`, `cfg`, `rec`), `socket` interface (Task 8); `Recorder` WS methods and `ObserveHTTP` (Task 3); `RouteWSUpgrade`; `sleepCtx`.
- Produces: `type wsSession` implementing `socket`; `func newWSSession(a *Agent) *wsSession`.

- [ ] **Step 1: Write the failing tests**

```go
// agent/tools/agentsim/sim/ws_test.go
package sim

import (
	"context"
	"testing"
	"time"
)

func runAgent(t *testing.T, f *fakeAPI, mutate func(*Config)) (*Agent, Identity, *Recorder, context.CancelFunc) {
	t.Helper()
	cfg := testConfig(f, t.TempDir())
	if mutate != nil {
		mutate(&cfg)
	}
	id := f.preEnroll(0)
	rec := newTestRecorder()
	a := NewAgent(&cfg, rec, id, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return a, id, rec, cancel
}

func TestWSCommandIsAnsweredOverTheSocket(t *testing.T) {
	f := newFakeAPI(t)
	_, id, _, _ := runAgent(t, f, nil)
	eventually(t, 2*time.Second, func() bool { return f.socketFor(id.AgentID) }, "agent never opened its socket")
	if err := f.pushWS(id.AgentID, "c-ws"); err != nil {
		t.Fatal(err)
	}
	eventually(t, 2*time.Second, func() bool { return f.result("c-ws") == "ws" }, "WS command never got a command_result frame")
}

func TestAppPingIsAnsweredWithPong(t *testing.T) {
	f := newFakeAPI(t)
	f.setPingEvery(50 * ms)
	runAgent(t, f, nil)
	eventually(t, 2*time.Second, func() bool { return f.pongs() >= 3 }, "server app pings were not answered with pong frames (the API closes with 4008)")
}

func TestEstablishedDropReconnectsImmediately(t *testing.T) {
	f := newFakeAPI(t)
	_, id, rec, _ := runAgent(t, f, nil)
	eventually(t, 2*time.Second, func() bool { return f.socketFor(id.AgentID) }, "no first connection")
	f.dropSockets()
	// No backoff after an established drop: well under the 700 ms floor a
	// failed connect would cost (1 s − 30 %).
	eventually(t, 500*ms, func() bool { return f.socketFor(id.AgentID) && rec.wsReconnects.Load() >= 1 },
		"an established socket that dropped was not redialled at once")
}

func TestFailedUpgradeBacksOff(t *testing.T) {
	f := newFakeAPI(t)
	f.setRejectWS(true)
	_, _, rec, _ := runAgent(t, f, nil)
	time.Sleep(1600 * ms)
	// Attempt 1 at ~first beat, attempt 2 after 1 s ± 30 %, attempt 3 only
	// after a further 2 s ± 30 %: at most 2 attempts in 1.6 s.
	if got := f.count(RouteWSUpgrade); got < 1 || got > 2 {
		t.Fatalf("upgrade attempts in 1.6 s = %d, want 1..2 (a hot reconnect loop would be dozens)", got)
	}
	if rec.wsConnectFailures.Load() == 0 {
		t.Fatal("refused upgrades must count as connect failures")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./tools/agentsim/sim/ -run 'TestWSCommand|TestAppPing|TestEstablishedDrop|TestFailedUpgrade'`
Expected: FAIL — `TestWSCommandIsAnsweredOverTheSocket` times out with "agent never opened its socket" (no session is attached yet).

- [ ] **Step 3: Write the implementation**

```go
// agent/tools/agentsim/sim/ws.go
package sim

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	gws "github.com/gorilla/websocket"

	agentws "github.com/breeze-rmm/agent/internal/websocket"
)

// Mirrors of internal/websocket/client.go, where they are unexported. The
// simulator keeps its own thin client so it can count connects and reconnects
// per agent and hold thousands of sockets without the agent's per-client
// logging and ordered-command pump.
const (
	wsWriteWait      = 10 * time.Second // writeWait
	wsPongWait       = 60 * time.Second // pongWait
	wsHandshake      = 10 * time.Second // connect(): Dialer.HandshakeTimeout
	wsInitialBackoff = 1 * time.Second  // initialBackoff
	wsMaxBackoff     = 60 * time.Second // maxBackoff
	wsBackoffFactor  = 2.0              // backoffFactor
	wsJitterFrac     = 0.3              // jitterFactor
	wsStableAfter    = 30 * time.Second // reconnectLoop: reset backoff after a connection this long
	wsMaxMessage     = 16 << 20         // maxMessageSize
)

var errNoSocket = errors.New("agent socket not connected")

type wsSession struct {
	agent     *Agent
	mu        sync.Mutex // gorilla allows one concurrent writer
	conn      *gws.Conn
	connected atomic.Bool
}

func newWSSession(a *Agent) *wsSession { return &wsSession{agent: a} }

func (s *wsSession) Connected() bool { return s.connected.Load() }

func (s *wsSession) url() string {
	base := s.agent.cfg.ServerURL
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	}
	return base + "/api/v1/agent-ws/" + s.agent.identity().AgentID + "/ws"
}

// Run is client.go reconnectLoop.
func (s *wsSession) Run(ctx context.Context) {
	rec := s.agent.rec
	backoff := wsInitialBackoff
	established := 0
	for ctx.Err() == nil {
		started := time.Now()
		conn, err := s.dial(ctx)
		if err != nil {
			rec.WSConnectFailed()
			if !sleepCtx(ctx, s.agent.jitter(backoff, wsJitterFrac)) {
				return
			}
			backoff = time.Duration(float64(backoff) * wsBackoffFactor)
			if backoff > wsMaxBackoff {
				backoff = wsMaxBackoff
			}
			continue
		}
		rec.WSConnected(established > 0, time.Since(started))
		established++
		connStart := time.Now()
		s.serve(ctx, conn)
		rec.WSDisconnected()
		if time.Since(connStart) > wsStableAfter {
			backoff = wsInitialBackoff
		}
		// An established socket that drops is redialled at once, with no delay
		// (spec §1, failure-spiral step 3).
	}
}

func (s *wsSession) dial(ctx context.Context) (*gws.Conn, error) {
	d := gws.Dialer{HandshakeTimeout: wsHandshake, Proxy: http.ProxyFromEnvironment}
	header := http.Header{"Authorization": {"Bearer " + s.agent.identity().AuthToken}}
	start := time.Now()
	conn, resp, err := d.DialContext(ctx, s.url(), header)
	status := 0
	if resp != nil {
		status = resp.StatusCode
		if resp.Body != nil {
			resp.Body.Close()
		}
	}
	s.agent.rec.ObserveHTTP(RouteWSUpgrade, true, start, time.Since(start), status, err)
	return conn, err
}

func (s *wsSession) serve(ctx context.Context, conn *gws.Conn) {
	rec := s.agent.rec
	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()
	s.connected.Store(true)
	stop := make(chan struct{})
	defer func() {
		close(stop)
		s.connected.Store(false)
		s.mu.Lock()
		s.conn = nil
		s.mu.Unlock()
		conn.Close()
	}()

	conn.SetReadLimit(wsMaxMessage)
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		rec.WSControlPong()
		return conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})
	go s.pinger(ctx, conn, stop)
	go func() { // unblock ReadMessage when the run ends
		select {
		case <-ctx.Done():
			_ = conn.WriteControl(gws.CloseMessage, gws.FormatCloseMessage(gws.CloseNormalClosure, ""), time.Now().Add(time.Second))
			conn.Close()
		case <-stop:
		}
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		s.handle(data)
	}
}

func (s *wsSession) pinger(ctx context.Context, conn *gws.Conn, stop <-chan struct{}) {
	period := s.agent.cfg.Cadence.WSPing
	if period <= 0 {
		return
	}
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-t.C:
			// WriteControl may run concurrently with other writers (gorilla docs).
			if err := conn.WriteControl(gws.PingMessage, nil, time.Now().Add(wsWriteWait)); err != nil {
				conn.Close()
				return
			}
			s.agent.rec.WSControlPing()
		}
	}
}

// handle follows client.go readPump's order: ping, then id-bearing commands.
func (s *wsSession) handle(data []byte) {
	var probe struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(data, &probe) != nil {
		s.agent.rec.WSFrame("unparseable")
		return
	}
	switch {
	case probe.Type == "ping":
		s.agent.rec.WSFrame("ping")
		_ = s.writeJSON(map[string]any{"type": "pong", "timestamp": time.Now().UnixMilli()})
	case probe.ID != "":
		var cmd agentws.Command
		if json.Unmarshal(data, &cmd) == nil {
			s.agent.enqueue(cmd, "ws")
		}
	default:
		kind := probe.Type
		if kind == "" {
			kind = "untyped"
		}
		s.agent.rec.WSFrame(kind)
	}
}

func (s *wsSession) writeJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return errNoSocket
	}
	_ = s.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return s.conn.WriteMessage(gws.TextMessage, data)
}

// SendResult writes a command_result frame (client.go sets Type the same way).
func (s *wsSession) SendResult(r agentws.CommandResult) error {
	r.Type = "command_result"
	return s.writeJSON(r)
}
```

In `agent/tools/agentsim/sim/agent.go`, attach the session at the end of `NewAgent`, just before `return a`:

```go
	a.payloads = NewPayloads(cfg, rand.New(rand.NewPCG(seed, 0xfeed)))
	if cfg.WSEnabled {
		a.ws = newWSSession(a)
	}
	return a
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race -count=3 ./tools/agentsim/sim/ -run 'TestWSCommand|TestAppPing|TestEstablishedDrop|TestFailedUpgrade|TestAgent|TestHeartbeatCommand'`
Expected: PASS three times.

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/sim/ws.go agent/tools/agentsim/sim/ws_test.go agent/tools/agentsim/sim/agent.go
git commit -m "feat(agentsim): agent WebSocket with app pongs, control pings and the agent's reconnect rules"
```

---

### Task 10: Runner, commander, file-limit check and CLI

The runner paces agent starts with a `rate.Limiter` (`--ramp`), enrolls missing indices through a concurrency-bounded semaphore, reuses stored identities, saves the store every 30 s and at exit, and always writes the report — including after Ctrl-C. The commander (optional, `--commands-per-minute`) logs in as the lab admin and queues `POST /api/v1/devices/:id/commands {"type":"refresh_inventory"}` round-robin so the agents' command-result replies are exercised; its own calls use a separate unrecorded client so they never appear in the agent mix. The simulator replies to commands but does not perform the work they ask for (see "Not in this plan").

**Files:**
- Create: `agent/tools/agentsim/sim/runner.go`, `sim/commander.go`, `sim/rlimit_unix.go`, `sim/rlimit_other.go`
- Create: `agent/tools/agentsim/main.go`
- Test: `agent/tools/agentsim/sim/runner_test.go`, `agent/tools/agentsim/main_test.go`

**Interfaces:**
- Consumes: everything above.
- Produces: `func Run(ctx context.Context, cfg Config) (Report, error)`; `type Commander struct { ServerURL string; Cfg CommanderConfig; Client *http.Client; Rec *Recorder; DeviceIDs func() []string }` with `Run(ctx) error`; `func checkFileLimit(agents int) error`; `main.parseFlags(args []string, getenv func(string) string) (sim.Config, error)`.

- [ ] **Step 1: Write the failing tests**

```go
// agent/tools/agentsim/sim/runner_test.go
package sim

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func runnerConfig(f *fakeAPI, dir string) Config {
	cfg := testConfig(f, dir)
	cfg.Agents, cfg.RampPerSecond, cfg.EnrollConcurrency = 5, 50, 2
	cfg.Duration, cfg.Warmup = 2500*ms, 300*ms
	cfg.Commander = CommanderConfig{PerMinute: 600, Email: "admin@example.test", Password: "pw", CommandType: "refresh_inventory"}
	return cfg
}

func TestRunEnrollsOnceThenReusesTheStore(t *testing.T) {
	f := newFakeAPI(t)
	f.setEnroll429(1) // the first enrollment is rate limited and must be retried
	cfg := runnerConfig(f, t.TempDir())

	first, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if f.count(RouteEnroll) != 6 || first.Agents.EnrolledThisRun != 5 || first.Agents.Started != 5 {
		t.Fatalf("enroll calls %d (want 5 + one 429), report %+v", f.count(RouteEnroll), first.Agents)
	}
	if first.Schema != ReportSchema || first.WS.Connects < 5 || first.Window.AgentMinutes <= 0 {
		t.Fatalf("report %+v / ws %+v / window %+v", first.Schema, first.WS, first.Window)
	}
	if first.Commands.Dispatched == 0 || first.Commands.ResultsSent["ws"] == 0 {
		t.Fatalf("commander round trip missing: %+v", first.Commands)
	}
	data, err := os.ReadFile(cfg.ReportPath)
	if err != nil {
		t.Fatal(err)
	}
	var onDisk Report
	if err := json.Unmarshal(data, &onDisk); err != nil || onDisk.RunID != first.RunID {
		t.Fatalf("report on disk: %v %+v", err, onDisk.RunID)
	}

	second, err := Run(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if f.count(RouteEnroll) != 6 || second.Agents.ReusedFromStore != 5 || second.Agents.EnrolledThisRun != 0 {
		t.Fatalf("the second run re-enrolled: enroll calls %d, agents %+v", f.count(RouteEnroll), second.Agents)
	}
}

func TestRunRefusesAShortStoreWithoutAKey(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	cfg.EnrollmentKey = ""
	_, err := Run(context.Background(), cfg)
	if err == nil || !strings.Contains(err.Error(), "--enrollment-key") {
		t.Fatalf("want an --enrollment-key error, got %v", err)
	}
}

func TestRunInterruptedBeforeTheWindowStillWritesAReport(t *testing.T) {
	f := newFakeAPI(t)
	cfg := runnerConfig(f, t.TempDir())
	cfg.Duration, cfg.Warmup = time.Minute, 30*time.Second
	cfg.Commander.PerMinute = 0
	ctx, cancel := context.WithTimeout(context.Background(), 400*ms) // Ctrl-C long before the window opens
	defer cancel()
	rep, err := Run(ctx, cfg)
	if err != nil {
		t.Fatalf("an interrupted run must still succeed in writing its report: %v", err)
	}
	if rep.Window.AgentMinutes != 0 || rep.Totals.RequestsPerAgentMinute != 0 {
		t.Fatalf("empty window must report zero rates: %+v", rep.Totals)
	}
	if _, err := os.Stat(cfg.ReportPath); err != nil {
		t.Fatalf("report not written: %v", err)
	}
}
```

```go
// agent/tools/agentsim/main_test.go
package main

import (
	"testing"
	"time"
)

func TestParseFlagsTakesSecretsFromTheEnvironment(t *testing.T) {
	env := map[string]string{
		"AGENTSIM_SERVER":                "http://localhost:9",
		"AGENTSIM_ENROLLMENT_KEY":        "key-from-env",
		"BREEZE_AGENT_ENROLLMENT_SECRET": "secret-from-env",
	}
	cfg, err := parseFlags([]string{"--agents", "200", "--duration", "20m", "--cadence", "heartbeat=30s"},
		func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ServerURL != "http://localhost:9" || cfg.EnrollmentKey != "key-from-env" || cfg.EnrollmentSecret != "secret-from-env" {
		t.Fatalf("env defaults not applied: %+v", cfg)
	}
	if cfg.Agents != 200 || cfg.Duration != 20*time.Minute || cfg.Cadence.Heartbeat != 30*time.Second {
		t.Fatalf("flags not applied: agents %d duration %s heartbeat %s", cfg.Agents, cfg.Duration, cfg.Cadence.Heartbeat)
	}
}

func TestParseFlagsRejectsAnInvalidConfig(t *testing.T) {
	if _, err := parseFlags([]string{"--agents", "0"}, func(string) string { return "" }); err == nil {
		t.Fatal("want a validation error")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./tools/agentsim/... -run 'TestRun|TestParseFlags'`
Expected: FAIL to compile: `undefined: Run` and `undefined: parseFlags`.

- [ ] **Step 3: Write the implementation**

```go
// agent/tools/agentsim/sim/rlimit_unix.go
//go:build linux || darwin

package sim

import (
	"fmt"
	"syscall"
)

// checkFileLimit makes sure the process may hold one HTTP and one WebSocket
// socket per agent plus headroom. macOS defaults to 256 open files.
func checkFileLimit(agents int) error {
	need := uint64(agents)*2 + 256
	var lim syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &lim); err != nil {
		return nil // cannot tell; let the run surface EMFILE itself
	}
	if lim.Cur >= need {
		return nil
	}
	raised := lim
	raised.Cur = need
	if raised.Max < need {
		raised.Cur = raised.Max
	}
	_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &raised)
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &lim); err == nil && lim.Cur >= need {
		return nil
	}
	return fmt.Errorf("open-file limit %d is below the %d this run needs (two sockets per agent); run `ulimit -n %d` first", lim.Cur, need, need)
}
```

```go
// agent/tools/agentsim/sim/rlimit_other.go
//go:build !linux && !darwin

package sim

func checkFileLimit(int) error { return nil }
```

```go
// agent/tools/agentsim/sim/commander.go
package sim

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"golang.org/x/time/rate"
)

// Commander queues commands for simulated devices through the admin API, so
// the agents' command-result path carries load. Its requests are not agent
// traffic and are never recorded in the route mix.
type Commander struct {
	ServerURL string
	Cfg       CommanderConfig
	Client    *http.Client
	Rec       *Recorder
	DeviceIDs func() []string
}

func (c *Commander) Run(ctx context.Context) error {
	token, err := c.login(ctx)
	if err != nil {
		return err
	}
	lim := rate.NewLimiter(rate.Limit(c.Cfg.PerMinute/60), 1)
	next := 0
	for {
		if err := lim.Wait(ctx); err != nil {
			return nil // run over
		}
		ids := c.DeviceIDs()
		if len(ids) == 0 {
			continue
		}
		deviceID := ids[next%len(ids)]
		next++
		status, err := c.dispatch(ctx, token, deviceID)
		if err == nil && status == http.StatusUnauthorized { // access token expired
			if token, err = c.login(ctx); err != nil {
				return err
			}
			status, err = c.dispatch(ctx, token, deviceID)
		}
		c.Rec.CommandDispatched(err == nil && status == http.StatusCreated)
	}
}

func (c *Commander) login(ctx context.Context) (string, error) {
	body, _ := json.Marshal(map[string]string{"email": c.Cfg.Email, "password": c.Cfg.Password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.ServerURL+"/api/v1/auth/login", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("commander login: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		Tokens *struct {
			AccessToken string `json:"accessToken"`
		} `json:"tokens"`
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK || json.Unmarshal(data, &out) != nil || out.Tokens == nil || out.Tokens.AccessToken == "" {
		return "", fmt.Errorf("commander login: HTTP %d with no access token (the lab stack pins MFA_FORCE_FOR_PARTNER_ADMIN=false; check --admin-email/--admin-password)", resp.StatusCode)
	}
	return out.Tokens.AccessToken, nil
}

func (c *Commander) dispatch(ctx context.Context, token, deviceID string) (int, error) {
	body, _ := json.Marshal(map[string]string{"type": c.Cfg.CommandType})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.ServerURL+"/api/v1/devices/"+deviceID+"/commands", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Client.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, nil
}
```

```go
// agent/tools/agentsim/sim/runner.go
package sim

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"
)

type deviceList struct {
	mu  sync.Mutex
	ids []string
}

func (d *deviceList) add(id string) {
	if id == "" {
		return
	}
	d.mu.Lock()
	d.ids = append(d.ids, id)
	d.mu.Unlock()
}

func (d *deviceList) snapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.ids...)
}

// Run executes one simulator run and always writes its report, including
// when ctx is cancelled (Ctrl-C) before the steady window opens.
func Run(ctx context.Context, cfg Config) (Report, error) {
	if err := cfg.Validate(); err != nil {
		return Report{}, err
	}
	cfg.ServerURL = strings.TrimRight(cfg.ServerURL, "/")
	if err := checkFileLimit(cfg.Agents); err != nil {
		return Report{}, err
	}
	store, err := LoadStore(cfg.StorePath, cfg.ServerURL, cfg.HostnamePrefix)
	if err != nil {
		return Report{}, err
	}
	if missing := store.Missing(cfg.Agents); missing > 0 && cfg.EnrollmentKey == "" {
		return Report{}, fmt.Errorf("%d of %d agents are not in %s and no --enrollment-key (AGENTSIM_ENROLLMENT_KEY) was given", missing, cfg.Agents, cfg.StorePath)
	}

	start := time.Now()
	open, closeAt := cfg.SteadyWindow()
	rec := NewRecorder(start.UTC().Format("20060102T150405Z")+"-"+randomTag(), start, start.Add(open), start.Add(closeAt))
	enroller := &Enroller{
		ServerURL: cfg.ServerURL, Key: cfg.EnrollmentKey, Secret: cfg.EnrollmentSecret,
		AgentVersion: cfg.AgentVersion, OSType: cfg.OSType,
		Client: &http.Client{Timeout: cfg.RequestTimeout,
			Transport: &recordingTransport{base: http.DefaultTransport.(*http.Transport).Clone(), rec: rec}},
	}
	reenroll := func(ctx context.Context, old Identity) (Identity, error) {
		fresh, err := enroller.Enroll(ctx, old.Index, store.ReenrollHostname(old.Index))
		if err != nil {
			rec.EnrollFailed()
			return Identity{}, err
		}
		store.Put(fresh)
		rec.Reenrolled()
		return fresh, nil
	}

	runCtx, cancel := context.WithDeadline(ctx, start.Add(cfg.Duration))
	defer cancel()

	go func() { // a crash mid-run must not lose 2,000 enrollments
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-t.C:
				_ = store.Save(cfg.StorePath)
			}
		}
	}()

	var (
		wg      sync.WaitGroup
		started atomic.Int64
		devices deviceList
	)
	sem := make(chan struct{}, cfg.EnrollConcurrency)
	if cfg.Commander.PerMinute > 0 {
		cmd := &Commander{ServerURL: cfg.ServerURL, Cfg: cfg.Commander, Client: &http.Client{Timeout: cfg.RequestTimeout},
			Rec: rec, DeviceIDs: devices.snapshot}
		wg.Add(1)
		go func() { defer wg.Done(); _ = cmd.Run(runCtx) }()
	}
	ramp := rate.NewLimiter(rate.Limit(cfg.RampPerSecond), 1)
	for i := 0; i < cfg.Agents; i++ {
		if ramp.Wait(runCtx) != nil {
			break
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id, ok := store.Get(i)
			if ok {
				rec.EnrollReused()
			} else {
				select {
				case sem <- struct{}{}:
				case <-runCtx.Done():
					return
				}
				var err error
				id, err = enroller.Enroll(runCtx, i, store.Hostname(i))
				<-sem
				if err != nil {
					rec.EnrollFailed()
					return
				}
				store.Put(id)
				rec.Enrolled()
			}
			started.Add(1)
			devices.add(id.DeviceID)
			NewAgent(&cfg, rec, id, reenroll).Run(runCtx)
		}(i)
	}
	<-runCtx.Done()
	wg.Wait()
	ended := time.Now()

	saveErr := store.Save(cfg.StorePath)
	report := BuildReport(rec, cfg, ended, int(started.Load()))
	if err := WriteReport(cfg.ReportPath, report); err != nil {
		return report, fmt.Errorf("write report: %w", err)
	}
	if saveErr != nil {
		return report, fmt.Errorf("save token store: %w", saveErr)
	}
	return report, nil
}
```

```go
// agent/tools/agentsim/main.go
// Command agentsim drives N simulated Breeze agents against a real stack and
// writes a breeze.agentsim.report/v1 run report. It lives in the agent module
// because it reuses the agent's internal wire structs. Operator guide:
// load-tests/agentsim/README.md.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/tools/agentsim/sim"
)

func parseFlags(args []string, getenv func(string) string) (sim.Config, error) {
	cfg := sim.DefaultConfig()
	fs := flag.NewFlagSet("agentsim", flag.ContinueOnError)
	var cadence, start string
	fs.StringVar(&cfg.ServerURL, "server", getenv("AGENTSIM_SERVER"), "stack base URL (baseUrl in .breeze-stack.json); env AGENTSIM_SERVER")
	fs.StringVar(&cfg.EnrollmentKey, "enrollment-key", getenv("AGENTSIM_ENROLLMENT_KEY"), "raw enrollment key, needed only for agents missing from --store; env AGENTSIM_ENROLLMENT_KEY")
	fs.StringVar(&cfg.EnrollmentSecret, "enrollment-secret", getenv("BREEZE_AGENT_ENROLLMENT_SECRET"), "enrollment secret; env BREEZE_AGENT_ENROLLMENT_SECRET (same as the real agent)")
	fs.IntVar(&cfg.Agents, "agents", cfg.Agents, "number of simulated agents")
	fs.Float64Var(&cfg.RampPerSecond, "ramp", cfg.RampPerSecond, "agents started per second")
	fs.IntVar(&cfg.EnrollConcurrency, "enroll-concurrency", cfg.EnrollConcurrency, "concurrent enrollments")
	fs.DurationVar(&cfg.Duration, "duration", cfg.Duration, "whole run, from the first agent start")
	fs.DurationVar(&cfg.Warmup, "warmup", cfg.Warmup, "wait after the ramp before the steady window opens")
	fs.StringVar(&cfg.StorePath, "store", cfg.StorePath, "token store (0600; reused across runs)")
	fs.StringVar(&cfg.ReportPath, "report", cfg.ReportPath, "run report output path")
	fs.StringVar(&cfg.HostnamePrefix, "hostname-prefix", cfg.HostnamePrefix, "hostname prefix for a new store")
	fs.StringVar(&cfg.AgentVersion, "agent-version", cfg.AgentVersion, "agentVersion to report (dev-* is never offered an upgrade)")
	fs.StringVar(&cfg.OSType, "os", cfg.OSType, "linux, windows or macos")
	fs.StringVar(&start, "start", string(cfg.StartMode), "warm (steady-state phases) or cold (startup fan-out)")
	fs.BoolVar(&cfg.WSEnabled, "ws", cfg.WSEnabled, "hold an agent WebSocket per agent")
	fs.StringVar(&cadence, "cadence", "", "overrides, e.g. heartbeat=30s,inventory=0 (names: "+strings.Join(sim.CadenceNames(), ", ")+")")
	fs.IntVar(&cfg.Retry.MaxRetries, "retries", cfg.Retry.MaxRetries, "httputil retries per request (agent default 3)")
	fs.DurationVar(&cfg.CommandDelay, "command-delay", cfg.CommandDelay, "simulated command execution time")
	fs.Float64Var(&cfg.Commander.PerMinute, "commands-per-minute", 0, "queue this many commands per minute through the admin API (0 = off)")
	fs.StringVar(&cfg.Commander.Email, "admin-email", getenv("AGENTSIM_ADMIN_EMAIL"), "admin login for --commands-per-minute; env AGENTSIM_ADMIN_EMAIL")
	fs.StringVar(&cfg.Commander.Password, "admin-password", getenv("AGENTSIM_ADMIN_PASSWORD"), "prefer env AGENTSIM_ADMIN_PASSWORD (flags show in ps)")
	fs.StringVar(&cfg.Commander.CommandType, "command-type", cfg.Commander.CommandType, "command type the commander queues")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	cfg.StartMode = sim.StartMode(start)
	if err := sim.ParseCadenceOverrides(cadence, &cfg.Cadence); err != nil {
		return cfg, err
	}
	return cfg, cfg.Validate()
}

func printSummary(w io.Writer, path string, r sim.Report) {
	fmt.Fprintf(w, "agentsim %s: %d/%d agents started, %.1f agent-minutes in the steady window\n",
		r.RunID, r.Agents.Started, r.Agents.Configured, r.Window.AgentMinutes)
	fmt.Fprintf(w, "  requests/agent-min %.2f (model %.2f, %+.1f%%), non-2xx %d, transport errors %d\n",
		r.Totals.RequestsPerAgentMinute, r.Totals.ExpectedRequestsPerAgentMinute, r.Totals.DeviationPct,
		r.Totals.Non2xx, r.Totals.TransportErrors)
	fmt.Fprintf(w, "  ws connects %d (reconnects %d, failures %d); commands dispatched %d, results %v\n",
		r.WS.Connects, r.WS.Reconnects, r.WS.ConnectFailures, r.Commands.Dispatched, r.Commands.ResultsSent)
	fmt.Fprintf(w, "  report: %s\n", path)
}

func main() {
	cfg, err := parseFlags(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "agentsim:", err)
		os.Exit(2)
	}
	logging.Init("text", "error", os.Stderr) // the agent packages log per retry; keep 2,000 agents quiet
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	report, err := sim.Run(ctx, cfg)
	if report.Schema != "" {
		printSummary(os.Stdout, cfg.ReportPath, report)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "agentsim:", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race -count=2 ./tools/agentsim/... && go vet ./tools/agentsim/... && GOOS=windows go vet ./tools/agentsim/...`
Expected: PASS; both `go vet` runs clean (the Windows one proves the rlimit build tags compile).

- [ ] **Step 5: Commit**

```bash
git add agent/tools/agentsim/main.go agent/tools/agentsim/main_test.go \
  agent/tools/agentsim/sim/runner.go agent/tools/agentsim/sim/runner_test.go \
  agent/tools/agentsim/sim/commander.go agent/tools/agentsim/sim/rlimit_unix.go agent/tools/agentsim/sim/rlimit_other.go
git commit -m "feat(agentsim): ramped runner, token reuse, admin commander and CLI"
```

---
### Task 11: Operator surface in `load-tests/agentsim/` and the 20-agent smoke run

**Files:**
- Create: `load-tests/agentsim/README.md`, `load-tests/agentsim/run.sh`, `load-tests/agentsim/lab-setup.sh`, `load-tests/agentsim/check-acceptance.sh`, `load-tests/agentsim/.gitignore`
- Modify: `load-tests/README.md` (add a section after the title paragraph)

**Interfaces:**
- Consumes: the `agentsim` CLI (Task 10); `.breeze-stack.json` written by `pnpm wt-stack up` (`project`, `baseUrl`, `apiUrl`, `pgContainer`, `redisContainer`, `admin.email`, `admin.password`).
- Produces: `run.sh [agentsim flags]`; `eval "$(lab-setup.sh)"` exporting `AGENTSIM_SERVER`, `AGENTSIM_ENROLLMENT_KEY`, `BREEZE_AGENT_ENROLLMENT_SECRET`, `AGENTSIM_ADMIN_EMAIL`, `AGENTSIM_ADMIN_PASSWORD`, `AGENTSIM_STORE`; `check-acceptance.sh live <n>` and `check-acceptance.sh report <report.json> [expectedRpm]`.

- [ ] **Step 1: Write the failing check (scripts do not exist yet)**

Run: `bash -n load-tests/agentsim/run.sh load-tests/agentsim/lab-setup.sh load-tests/agentsim/check-acceptance.sh`
Expected: FAIL — `No such file or directory`.

- [ ] **Step 2: Write the scripts**

```bash
# load-tests/agentsim/.gitignore
# Token stores hold live bearer tokens; reports are run artifacts (W0c commits baselines elsewhere).
.state/
reports/
```

```bash
#!/usr/bin/env bash
# load-tests/agentsim/run.sh — run the agent simulator from the agent module
# (it imports agent/internal/*). Extra flags pass straight through; a flag given
# twice takes the last value, so --store/--report here are overridable.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
mkdir -p "$HERE/.state" "$HERE/reports"
chmod 700 "$HERE/.state"
STORE="${AGENTSIM_STORE:-$HERE/.state/tokens.json}"
REPORT="$HERE/reports/$(date -u +%Y%m%dT%H%M%SZ).json"
cd "$REPO/agent"
exec go run ./tools/agentsim --store "$STORE" --report "$REPORT" "$@"
```

```bash
#!/usr/bin/env bash
# load-tests/agentsim/lab-setup.sh — print the env the simulator needs against
# THIS worktree's wt-stack:   eval "$(load-tests/agentsim/lab-setup.sh)"
# Creates one enrollment key (maxUsage AGENTSIM_KEY_MAX_USAGE, default 2500) on
# the seeded Default Organization / Default Site. Lab use only: it prints the
# enrollment secret and admin password for eval.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
HERE="$REPO/load-tests/agentsim"
DESC="$REPO/.breeze-stack.json"
[ -f "$DESC" ] || { echo "lab-setup: no $DESC — run: AGENT_ENROLL_RATE_LIMIT=5000 pnpm wt-stack up" >&2; exit 1; }
for bin in jq curl docker; do command -v "$bin" >/dev/null || { echo "lab-setup: $bin is required" >&2; exit 1; }; done

PROJECT="$(jq -r .project "$DESC")"
BASE_URL="$(jq -r .baseUrl "$DESC")"
API_URL="$(jq -r .apiUrl "$DESC")"
PG="$(jq -r .pgContainer "$DESC")"
EMAIL="$(jq -r .admin.email "$DESC")"
PASSWORD="$(jq -r .admin.password "$DESC")"
MAX_USAGE="${AGENTSIM_KEY_MAX_USAGE:-2500}"

API_CONTAINER="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
  --filter label=com.docker.compose.service=api --format '{{.Names}}' | head -n1)"
[ -n "$API_CONTAINER" ] || { echo "lab-setup: no running api container for $PROJECT" >&2; exit 1; }

LIMIT="$(docker exec "$API_CONTAINER" printenv AGENT_ENROLL_RATE_LIMIT 2>/dev/null || true)"
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -lt "$MAX_USAGE" ]; then
  echo "lab-setup: AGENT_ENROLL_RATE_LIMIT in $API_CONTAINER is '${LIMIT:-unset}' (default 10/min per IP)." >&2
  echo "lab-setup: re-up with:  AGENT_ENROLL_RATE_LIMIT=5000 pnpm wt-stack up" >&2
  exit 1
fi
SECRET="$(docker exec "$API_CONTAINER" printenv AGENT_ENROLLMENT_SECRET)"

read -r ORG_ID SITE_ID < <(docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F " "' <<'SQL'
SELECT s.org_id, s.id FROM sites s JOIN organizations o ON o.id = s.org_id
WHERE o.name = 'Default Organization' AND s.name = 'Default Site' LIMIT 1;
SQL
)
[ -n "${SITE_ID:-}" ] || { echo "lab-setup: seeded Default Organization / Default Site not found" >&2; exit 1; }

TOKEN="$(curl -fsS -X POST "$API_URL/v1/auth/login" -H 'content-type: application/json' \
  -d "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" | jq -r '.tokens.accessToken // empty')"
[ -n "$TOKEN" ] || { echo "lab-setup: admin login returned no access token" >&2; exit 1; }

KEY="$(curl -fsS -X POST "$API_URL/v1/enrollment-keys" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "$(jq -n --arg o "$ORG_ID" --arg s "$SITE_ID" --argjson m "$MAX_USAGE" '{orgId:$o,siteId:$s,name:"agentsim",maxUsage:$m}')" \
  | jq -r '.key // empty')"
[ -n "$KEY" ] || { echo "lab-setup: enrollment-key create returned no key" >&2; exit 1; }

cat <<EOF
export AGENTSIM_SERVER='$BASE_URL'
export AGENTSIM_ENROLLMENT_KEY='$KEY'
export BREEZE_AGENT_ENROLLMENT_SECRET='$SECRET'
export AGENTSIM_ADMIN_EMAIL='$EMAIL'
export AGENTSIM_ADMIN_PASSWORD='$PASSWORD'
export AGENTSIM_STORE='$HERE/.state/tokens-$PROJECT.json'
EOF
```

```bash
#!/usr/bin/env bash
# load-tests/agentsim/check-acceptance.sh — W0a acceptance checks.
#   check-acceptance.sh live <expectedAgents>           run DURING the steady window
#   check-acceptance.sh report <report.json> [expRpm]   run after the simulator exits
# live: distinct device rows for this store's hostnames, and live presence leases
#       (agent-presence:<agentId>, 90 s TTL, cleared on socket close — so only
#       while the simulator is running).
# report: the ±10 % mix against the code-derived model (and against expRpm,
#         the production figure, when given), zero non-2xx outside crawl-config,
#         zero transport errors, one WS connect per agent, and ≥ 99 % of
#         dispatched commands answered.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
DESC="$REPO/.breeze-stack.json"
STORE="${AGENTSIM_STORE:-$REPO/load-tests/agentsim/.state/tokens.json}"
fail=0
check() { if [ "$1" = ok ]; then echo "PASS  $2"; else echo "FAIL  $2"; fail=1; fi; }
stackval() { grep -h "^$1=" "$REPO/.env" "$REPO/.env.stack" 2>/dev/null | tail -n1 | cut -d= -f2-; }

case "${1:-}" in
live)
  WANT="${2:?usage: check-acceptance.sh live <expectedAgents>}"
  PG="$(jq -r .pgContainer "$DESC")"; REDIS="$(jq -r .redisContainer "$DESC")"
  BASE="$(jq -r .hostnameBase "$STORE")"
  DEVICES="$(docker exec -i "$PG" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v base="$0"' "$BASE" <<'SQL'
SELECT count(DISTINCT id) FROM devices WHERE hostname LIKE :'base' || '-%' AND status <> 'decommissioned';
SQL
)"
  LEASES="$(docker exec "$REDIS" redis-cli -a "$(stackval REDIS_PASSWORD)" --no-auth-warning \
    --scan --pattern 'agent-presence:*' | wc -l | tr -d ' ')"
  [ "$DEVICES" -ge "$WANT" ] && r=ok || r=bad; check "$r" "distinct device rows for $BASE-*: $DEVICES (want >= $WANT)"
  [ "$LEASES" -ge "$WANT" ] && r=ok || r=bad; check "$r" "live presence leases: $LEASES (want >= $WANT)"
  ;;
report)
  R="${2:?usage: check-acceptance.sh report <report.json> [expectedRpm]}"; PROD="${3:-}"
  jq -e '.schema == "breeze.agentsim.report/v1"' "$R" >/dev/null && r=ok || r=bad; check "$r" "schema"
  N="$(jq .config.agents "$R")"
  dev="$(jq '.totals.deviationPct | fabs' "$R")"
  jq -e '(.totals.deviationPct | fabs) <= 10' "$R" >/dev/null && r=ok || r=bad
  check "$r" "mix vs model: $(jq .totals.requestsPerAgentMinute "$R") vs $(jq .totals.expectedRequestsPerAgentMinute "$R") req/agent-min ($dev %)"
  if [ -n "$PROD" ]; then
    jq -e --argjson p "$PROD" '((.totals.requestsPerAgentMinute - $p) / $p | fabs) <= 0.10' "$R" >/dev/null && r=ok || r=bad
    check "$r" "mix vs production $PROD req/agent-min"
  fi
  BAD="$(jq '[.routes[] | select(.route != "GET /workspace/agent/crawl-config" and .route != "GET /agent-ws/:id/ws")
              | (.status // {}) | to_entries[] | select(.key | test("^2") | not) | .value] | add // 0' "$R")"
  [ "$BAD" -eq 0 ] && r=ok || r=bad; check "$r" "non-2xx outside crawl-config: $BAD"
  TE="$(jq .totals.transportErrors "$R")"; [ "$TE" -eq 0 ] && r=ok || r=bad; check "$r" "transport errors: $TE"
  jq -e --argjson n "$N" '.agents.started == $n and .ws.connects >= $n' "$R" >/dev/null && r=ok || r=bad
  check "$r" "agents started $(jq .agents.started "$R")/$N, ws connects $(jq .ws.connects "$R")"
  jq -e '.commands.dispatched == 0 or (([.commands.resultsSent[]] | add // 0) >= .commands.dispatched * 0.99)' "$R" >/dev/null && r=ok || r=bad
  check "$r" "command results $(jq '[.commands.resultsSent[]] | add // 0' "$R") for $(jq .commands.dispatched "$R") dispatched"
  ;;
*) echo "usage: check-acceptance.sh live <n> | report <report.json> [expectedRpm]" >&2; exit 2 ;;
esac
exit "$fail"
```

`load-tests/agentsim/README.md` — write it with these sections and this content (prose may be tightened, facts may not change):

````markdown
# Agent simulator (`agentsim`)

Drives N simulated Breeze agents against a real stack and writes a
`breeze.agentsim.report/v1` run report. Each simulated agent enrolls through a
real enrollment key, holds its own `brz_` token, sends the real agent's request
bodies (built from the agent's own Go structs) at production cadence, and keeps
a persistent agent WebSocket that answers pings and command results.

The code lives in the agent module (`agent/tools/agentsim/`) because the
payload structs are under `agent/internal/`. This directory holds the scripts.

> The k6 scenario `../scenarios/heartbeat.js` is not an agent model: it shares
> one token across fake agent IDs and sends a toy payload. Use `agentsim` for
> anything that claims an agent count or a per-agent cost.

## Lab stack

```bash
export AGENT_ENROLL_RATE_LIMIT=5000   # lab-only: default is 10 enrollments/min per IP
pnpm wt-stack up                       # E2E_MODE=true and IS_HOSTED=false are pinned already
eval "$(load-tests/agentsim/lab-setup.sh)"
ulimit -n 16384                        # two sockets per agent; macOS defaults to 256
```

The override is an exported shell variable, so `.env.stack` (rewritten on every
`up`) and every committed default stay untouched. `lab-setup.sh` refuses to run
until the api container sees it.

## Smoke (20 agents, 3 minutes)

```bash
load-tests/agentsim/run.sh --agents 20 --duration 3m --commands-per-minute 6
# in a second terminal, during the last 90 s of the run:
load-tests/agentsim/check-acceptance.sh live 20
# after it exits:
load-tests/agentsim/check-acceptance.sh report load-tests/agentsim/reports/<newest>.json
```

A 3-minute smoke has ~30 agent-minutes in its window, too few for the ±10 % mix
check to be meaningful; read that line as informational. Every other check must pass.

## Acceptance (W0a)

| Run | Command | Gates |
|---|---|---|
| A — fidelity | `run.sh --agents 200 --duration 20m --commands-per-minute 30` | `report` checks all PASS (mix ±10 % of the model) |
| B — scale | `run.sh --agents 2000 --ramp 5 --duration 30m --commands-per-minute 30` | `live 2000` PASS during the last 5 min; the report is recorded as the first capacity data point |

Re-runs reuse `$AGENTSIM_STORE`; only missing indices enroll. After
`pnpm wt-stack down && up` the stored tokens are stale: each agent gets one 401,
re-enrolls under a fresh hostname, and carries on (`agents.reenrolled`).

## What is modelled

| Stream | Cadence | Source in the agent |
|---|---|---|
| `POST /agents/:id/heartbeat` | 60 s, first beat at a random point in the first interval | `internal/config` `DefaultHeartbeatIntervalSeconds`, `heartbeat.go Start()` |
| `GET /agents/:id/unifi-collectors` | 30 s | `internal/unifi/collector.go` |
| `GET /api/v1/workspace/agent/crawl-config` | ~60 s ±10 %; 6 h after a 404 | `internal/workspaceindex` |
| `POST /agents/:id/process-sample` | 180 s | `config.Default().ProcessSampleIntervalSeconds` |
| `PUT security/status`, `PUT sessions` | tick-gated, 5 min | `heartbeat.go Start()` |
| `PUT software, disks, network, connections, registry-state, config-state` | tick-gated, 15 min, concurrent | `sendInventory()` |
| `PUT management/posture`, `PUT eventlogs` | tick-gated, 15 min | `heartbeat.go Start()`, `collectors/eventlogs.go` |
| Agent WebSocket | control ping 54 s; pong to every app ping; reconnect as `reconnectLoop` | `internal/websocket/client.go` |
| Command results | over the socket; `POST /commands/:id/result` without one | `heartbeat.go processCommand` |

Not modelled: daily hardware/patch/reliability uploads, `time-status`,
`hardware-health`, `changes` (only when there are change records),
`security/recovery-keys` (only when the key fingerprint changes),
`monitoring-results` (only with monitors), `logs`, `warranty-info` (darwin),
UniFi telemetry, and the work a command asks for (results are synthetic).

`--start cold` replays a fresh service start (startup inventory, zero-stamped
gates fire on the first tick) — the shape W0b storms need. Default `warm`
starts every stream at a random phase, which is the steady state.

## Flags

`run.sh --help` lists them. The ones that matter: `--agents`, `--ramp`
(agents/s), `--duration`, `--warmup` (after the ramp, before the window opens),
`--cadence name=dur,...` (`0` disables), `--start warm|cold`, `--ws=false`,
`--retries`, `--commands-per-minute`. Secrets come from the environment
(`AGENTSIM_ENROLLMENT_KEY`, `BREEZE_AGENT_ENROLLMENT_SECRET`,
`AGENTSIM_ADMIN_PASSWORD`), never from committed files.

## Report

`reports/<UTC timestamp>.json`, schema `breeze.agentsim.report/v1`: per-route
logical requests and attempts, requests per agent-minute next to the expected
rate derived from the agent's cadences, latency p50/p95/p99/max per route,
status counts (steady window and whole run), WS connects/reconnects/failures,
and command round trips. Full field list:
`docs/superpowers/plans/platform-ci/2026-10-07-scaling-w0a-agent-simulator.md`.

## Tear down

`pnpm wt-stack down` from the same worktree and branch. Token stores in
`.state/` are useless after that; delete them or let the 401 re-enroll path
replace them.
````

Add to `load-tests/README.md`, directly under the opening description paragraph:

```markdown
> **Agent load:** `scenarios/heartbeat.js` shares one token across fake agent
> IDs with a toy payload, so its "10k agents" runs do not measure what an agent
> costs the API. For agent counts and per-agent cost use the Go simulator in
> [`agentsim/`](agentsim/README.md).
```

- [ ] **Step 3: Check the scripts parse and are executable**

Run: `chmod +x load-tests/agentsim/*.sh && bash -n load-tests/agentsim/run.sh load-tests/agentsim/lab-setup.sh load-tests/agentsim/check-acceptance.sh && (command -v shellcheck >/dev/null && shellcheck load-tests/agentsim/*.sh || echo "shellcheck not installed — skipped")`
Expected: no syntax errors; shellcheck clean or skipped.

- [ ] **Step 4: Smoke run against a lab stack (manual verification)**

```bash
export AGENT_ENROLL_RATE_LIMIT=5000
pnpm wt-stack up
eval "$(load-tests/agentsim/lab-setup.sh)"
ulimit -n 16384
load-tests/agentsim/run.sh --agents 20 --duration 3m --commands-per-minute 6 &
sleep 120 && load-tests/agentsim/check-acceptance.sh live 20
wait
load-tests/agentsim/check-acceptance.sh report "$(ls -t load-tests/agentsim/reports/*.json | head -n1)"
```

Expected: both `live` lines PASS (20 device rows, 20 leases); every `report` line PASS except possibly the mix line (informational at 20 agents). Any non-2xx on a modelled route is a payload/schema mismatch: read the route's `statusTotal`, fix the payload in `payloads.go` with a test that pins the failing constraint, and re-run. Then re-run the same command once more and confirm `agents.reusedFromStore == 20` and `enrolledThisRun == 0` in the new report.

- [ ] **Step 5: Commit**

```bash
git add load-tests/agentsim/ load-tests/README.md
git commit -m "docs(load-tests): agentsim operator scripts, lab setup and acceptance checks"
```

---
### Task 12: W0d — agent-auth cost and full-chain budgets for every simulator HTTP route

Extends `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts` in place. Its `recorder` / `measure` / `summarize` harness counts every statement the request pool (`application_name: 'breeze-api'`) sends; fixture writes go through the superuser test client and are never counted. The existing route-only heartbeat and unifi-collectors tests stay as they are (they isolate the route's own cost). The new cases mount the **production agent router** (`agentRoutes`) and send a real `Bearer brz_…` token, so `agentAuthMiddleware` runs exactly as for a real agent — device lookup, limiters, tenant gate, and for non-self-managed routes the request-long org transaction. That is the full per-request cost.

Steady state, per route: the device has sent this request once before (first-ever sends take insert paths), the clock moves one agent interval, a sibling device in the same org sends it (org-wide caches warm, as in any org with more than one device), the device's own Redis caches are dropped, then the device's request is measured.

**Files:**
- Modify: `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`

**Interfaces:**
- Consumes: the file's existing `recorder`, `measure(run)`, `Measurement`, `advanceClock(ms)`, `seedOrg(label)`, `enrollDevice(org, hostname)`, `dropDeviceRedisCaches(deviceId)`, `runDb`; `agentRoutes` from `routes/agents/index.ts`; `agentAuthMiddleware` from `middleware/agentAuth.ts`.
- Produces (used by Task 13 in the same file): `interface Budget`, `HOT_ROUTE_BUDGETS: Record<string, Budget>`, `expectWithinBudget(key, measured)`, `agentRequest(device, method, action, body?)`, `HOT_ROUTES: HotRoute[]`, `W0D_EXTRA_KEYS: string[]`, `AUTH_ONLY_SELF_MANAGED`, `AUTH_ONLY_WRAPPED`; `EnrolledDevice` gains `authToken: string`.

- [ ] **Step 1: Add the imports and the enrolled device's token**

Add after `import { unifiTelemetryRoutes } from '../../routes/agents/unifiTelemetry';`:

```ts
import { agentRoutes } from '../../routes/agents';
import { agentAuthMiddleware } from '../../middleware/agentAuth';
```

In `enrollDevice`, replace

```ts
  const body = await response.json() as { deviceId: string; agentId: string };
  return {
    deviceId: body.deviceId,
    agentId: body.agentId,
```

with

```ts
  const body = await response.json() as { deviceId: string; agentId: string; authToken: string };
  return {
    deviceId: body.deviceId,
    agentId: body.agentId,
    authToken: body.authToken,
```

In the header comment, replace the paragraph that begins `The agent-auth middleware is not mounted here` with:

```ts
 * The route-only cases below set the agent context directly (as in
 * enrollmentReachability.integration.test.ts), so they isolate each route's
 * own cost. The W0d cases at the bottom go through the production agent
 * router with a real bearer token, so agentAuthMiddleware's device lookup,
 * limiters, tenant gate and request-long transaction are counted too: that is
 * the full per-request cost every simulated (and real) agent pays.
```

- [ ] **Step 2: Add the W0d helpers and route table**

Insert after the `dropDeviceRedisCaches` function:

```ts
// ---------------------------------------------------------------------------
// W0d — full per-request cost of every request the agent simulator
// (agent/tools/agentsim) sends, agent auth INCLUDED.
// ---------------------------------------------------------------------------

interface Budget {
  transactions: number;
  statements: number;
}

const AUTH_ONLY_SELF_MANAGED = 'agent auth only (self-managed route)';
const AUTH_ONLY_WRAPPED = 'agent auth only (request-long org transaction)';

/** Budget keys outside HOT_ROUTES (Task 13 adds the command-result and WS frame keys). */
const W0D_EXTRA_KEYS: string[] = [];

// Declared after the key constants: its computed keys read them.
/**
 * Pinned per-request DB cost, keyed by the simulator's route key
 * (agent/tools/agentsim/sim/routes.go). `transactions` is the measured
 * steady-state count; `statements` is the measured count plus one, as for the
 * heartbeat budget above: any new transaction costs at least three statements
 * (BEGIN, the RLS prologue, COMMIT), so it trips. A change that legitimately
 * adds a query raises its number in the same PR and says why.
 * agent/tools/agentsim/sim/budget_contract_test.go fails when the simulator
 * gains a route with no entry here.
 */
const HOT_ROUTE_BUDGETS: Record<string, Budget> = {};

function expectWithinBudget(key: string, measured: Measurement): void {
  const budget = HOT_ROUTE_BUDGETS[key];
  const seen = JSON.stringify(measured);
  expect(budget, `no budget pinned for '${key}' — measured ${seen}`).toBeDefined();
  expect(measured.transactions, `'${key}' transactions — measured ${seen}`).toBeLessThanOrEqual(budget!.transactions);
  expect(measured.statements, `'${key}' statements — measured ${seen}`).toBeLessThanOrEqual(budget!.statements);
}

function fullChainApp(): Hono {
  const app = new Hono();
  app.route('/agents', agentRoutes);
  return app;
}

function agentRequest(device: EnrolledDevice, method: string, action: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${device.authToken}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return Promise.resolve(fullChainApp().request(`/agents/${device.agentId}/${action}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

/**
 * agentAuthMiddleware in front of stub handlers that touch no database, so a
 * measurement is the middleware's own cost. `heartbeat` is in
 * SELF_MANAGED_DB_CONTEXT_ACTIONS (no request-long transaction); `software`
 * is not, so its stub also pays the org transaction every wrapped route pays.
 */
function authOnlyRequest(device: EnrolledDevice, method: 'POST' | 'PUT', action: 'heartbeat' | 'software'): Promise<Response> {
  const app = new Hono();
  app.use('/agents/:id/*', agentAuthMiddleware);
  app.post('/agents/:id/heartbeat', (c) => c.json({ ok: true }));
  app.put('/agents/:id/software', (c) => c.json({ ok: true }));
  return Promise.resolve(app.request(`/agents/${device.agentId}/${action}`, {
    method,
    headers: { authorization: `Bearer ${device.authToken}` },
  }));
}

interface HotRoute {
  key: string; // the simulator's route key
  method: 'GET' | 'POST' | 'PUT';
  action: string; // path after /agents/:id/
  intervalMs: number; // the agent's mean interval for this request (plus 1 s)
  body?: () => unknown;
}

const nowIso = () => new Date().toISOString();

/** Bodies mirror agent/tools/agentsim/sim/payloads.go. */
const HOT_ROUTES: HotRoute[] = [
  {
    key: 'POST /agents/:id/heartbeat', method: 'POST', action: 'heartbeat', intervalMs: 61_000,
    body: () => ({ status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false }),
  },
  { key: 'GET /agents/:id/unifi-collectors', method: 'GET', action: 'unifi-collectors', intervalMs: 31_000 },
  {
    key: 'POST /agents/:id/process-sample', method: 'POST', action: 'process-sample', intervalMs: 181_000,
    body: () => ({ timestamp: nowIso(), processes: [
      { name: 'breeze-agent', pid: 100, cpu: 0.4, ramMb: 42 },
      { name: 'postgres', pid: 103, cpu: 2.1, ramMb: 180 },
    ] }),
  },
  {
    key: 'PUT /agents/:id/security/status', method: 'PUT', action: 'security/status', intervalMs: 331_000,
    body: () => ({ provider: 'none', realTimeProtection: false, threatCount: 0, firewallEnabled: true, encryptionStatus: 'encrypted' }),
  },
  {
    key: 'PUT /agents/:id/sessions', method: 'PUT', action: 'sessions', intervalMs: 331_000,
    body: () => ({
      sessions: [{
        username: 'simuser', sessionType: 'ssh', sessionId: '1', loginAt: nowIso(), idleMinutes: 3,
        activityState: 'active', isActive: true, lastActivityAt: nowIso(), principal: { uid: 1000, username: 'simuser' },
      }],
      events: [],
      collectedAt: nowIso(),
    }),
  },
  {
    key: 'PUT /agents/:id/software', method: 'PUT', action: 'software', intervalMs: 931_000,
    body: () => ({
      schemaVersion: 2, observationId: randomUUID(), collectorVersion: 'budget-1', observedAt: nowIso(),
      completeness: 'complete', expectedSources: ['dpkg'], succeededSources: ['dpkg'], failedSources: [],
      truncated: false, itemCount: 2,
      items: [{ name: 'openssl', version: '3.0.13', vendor: 'Ubuntu' }, { name: 'curl', version: '8.5.0', vendor: 'Ubuntu' }],
    }),
  },
  {
    key: 'PUT /agents/:id/disks', method: 'PUT', action: 'disks', intervalMs: 931_000,
    body: () => ({ disks: [{ mountPoint: '/', device: '/dev/sda1', fsType: 'ext4', totalGb: 500, usedGb: 207.5, freeGb: 292.5, usedPercent: 41.5, health: 'healthy' }] }),
  },
  {
    key: 'PUT /agents/:id/network', method: 'PUT', action: 'network', intervalMs: 931_000,
    body: () => ({ adapters: [{ interfaceName: 'eth0', macAddress: '02:42:00:00:00:01', ipAddress: '10.64.0.1', ipType: 'ipv4', isPrimary: true }], vpns: [] }),
  },
  {
    key: 'PUT /agents/:id/connections', method: 'PUT', action: 'connections', intervalMs: 931_000,
    body: () => ({ connections: [{ protocol: 'tcp', localAddr: '10.64.0.1', localPort: 22, remoteAddr: '10.0.0.1', remotePort: 40000, state: 'ESTABLISHED', pid: 800, processName: 'sshd' }] }),
  },
  { key: 'PUT /agents/:id/registry-state', method: 'PUT', action: 'registry-state', intervalMs: 931_000, body: () => ({ entries: [], replace: true }) },
  { key: 'PUT /agents/:id/config-state', method: 'PUT', action: 'config-state', intervalMs: 931_000, body: () => ({ entries: [], replace: true }) },
  {
    key: 'PUT /agents/:id/management/posture', method: 'PUT', action: 'management/posture', intervalMs: 931_000,
    body: () => ({
      collectedAt: nowIso(), scanDurationMs: 420, categories: {},
      identity: { joinType: 'none', azureAdJoined: false, domainJoined: false, workplaceJoined: false, source: 'budget' },
    }),
  },
  {
    key: 'PUT /agents/:id/eventlogs', method: 'PUT', action: 'eventlogs', intervalMs: 931_000,
    body: () => ({ events: [{ timestamp: nowIso(), level: 'info', category: 'system', source: 'systemd', eventId: '1000', message: 'budget event' }] }),
  },
];

async function steadyStateMeasure(route: HotRoute, device: EnrolledDevice, sibling: EnrolledDevice): Promise<Measurement> {
  const send = (d: EnrolledDevice) => agentRequest(d, route.method, route.action, route.body?.());
  const primed = await send(device); // first-ever send takes insert paths: not steady state
  expect(primed.status, `${route.key} prime`).toBeLessThan(300);
  advanceClock(route.intervalMs);
  const warmed = await send(sibling); // org-wide caches warm, as in any org with more than one device
  expect(warmed.status, `${route.key} sibling`).toBeLessThan(300);
  await dropDeviceRedisCaches(device.deviceId);
  return measure(() => send(device));
}
```

- [ ] **Step 3: Add the failing tests**

Inside the existing `describe('agent hot-path DB budget (#8053) — real PostgreSQL', …)` block, after the unifi-collectors test's closing `});` and before the block's final `});`, add:

```ts
  it('W0d: the budget table pins exactly the simulator routes and the auth-only cases', () => {
    const expected = [...HOT_ROUTES.map((r) => r.key), ...W0D_EXTRA_KEYS, AUTH_ONLY_SELF_MANAGED, AUTH_ONLY_WRAPPED].sort();
    expect(Object.keys(HOT_ROUTE_BUDGETS).sort()).toEqual(expected);
  });

  runDb('W0d: agentAuthMiddleware alone stays inside its budget on both route classes', async () => {
    const org = await seedOrg('w0d-auth');
    const device = await enrollDevice(org, 'auth-target');
    const sibling = await enrollDevice(org, 'auth-sibling');
    // Org-wide caches (tenant state, org device count) warm, as for any org with more than one device.
    expect((await authOnlyRequest(sibling, 'POST', 'heartbeat')).status).toBe(200);
    const cold = await measure(() => authOnlyRequest(device, 'POST', 'heartbeat'));
    const selfManaged = await measure(() => authOnlyRequest(device, 'POST', 'heartbeat'));
    const wrapped = await measure(() => authOnlyRequest(device, 'PUT', 'software'));
    console.log(
      '[W0d budget] agent auth cold:', JSON.stringify(cold),
      'self-managed:', JSON.stringify(selfManaged),
      'wrapped:', JSON.stringify(wrapped),
    );
    expect(selfManaged.status).toBe(200);
    expect(wrapped.status).toBe(200);
    // The device lookup is unconditional: zero means the middleware never ran.
    expect(selfManaged.statements).toBeGreaterThan(0);
    // The request-long org transaction (opened eagerly by withDbAccessContext)
    // is what separates the two route classes.
    expect(wrapped.transactions).toBeGreaterThan(selfManaged.transactions);
    expectWithinBudget(AUTH_ONLY_SELF_MANAGED, selfManaged);
    expectWithinBudget(AUTH_ONLY_WRAPPED, wrapped);
  });

  for (const route of HOT_ROUTES) {
    runDb(`W0d ${route.key}: a steady-state request, agent auth included, stays inside its budget`, async () => {
      const org = await seedOrg(`w0d-${route.action.replace(/\//g, '-')}`);
      const device = await enrollDevice(org, 'target');
      const sibling = await enrollDevice(org, 'sibling');
      const measured = await steadyStateMeasure(route, device, sibling);
      console.log('[W0d budget]', route.key, JSON.stringify(measured));
      expect(measured.status).toBeLessThan(300);
      // Agent auth's device lookup is unconditional: zero statements means the
      // request never reached the database and the budget would be vacuous.
      expect(measured.statements).toBeGreaterThan(0);
      expectWithinBudget(route.key, measured);
    });
  }

  it('W0d: the full-chain heartbeat budget is the route budget plus agent auth, no more', () => {
    const fullChain = HOT_ROUTE_BUDGETS['POST /agents/:id/heartbeat'];
    const auth = HOT_ROUTE_BUDGETS[AUTH_ONLY_SELF_MANAGED];
    expect(fullChain, 'heartbeat budget pinned').toBeDefined();
    expect(auth, 'auth-only budget pinned').toBeDefined();
    // 3 is the route-only steady-state heartbeat budget pinned above (#8053).
    expect(fullChain!.transactions).toBeLessThanOrEqual(3 + auth!.transactions);
  });
```

- [ ] **Step 4: Run to verify the new tests fail, and capture the measurements**

Run:
```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
```
Expected: the four pre-existing tests PASS; every new W0d test FAILS with `no budget pinned for '<key>' — measured {"status":…,"transactions":T,"savepoints":…,"statements":S}`, and the table test fails listing every missing key. If any W0d test instead fails earlier on a `status` assertion, the request body does not match the API schema — fix the body (and the same body in `payloads.go`), not the assertion.

- [ ] **Step 5: Pin the measured budgets**

Fill `HOT_ROUTE_BUDGETS` with one entry per key from the failure messages, `transactions: T` and `statements: S + 1`, in this shape:

```ts
const HOT_ROUTE_BUDGETS: Record<string, Budget> = {
  [AUTH_ONLY_SELF_MANAGED]: { transactions: T, statements: S + 1 },
  [AUTH_ONLY_WRAPPED]: { transactions: T, statements: S + 1 },
  'POST /agents/:id/heartbeat': { transactions: T, statements: S + 1 },
  'GET /agents/:id/unifi-collectors': { transactions: T, statements: S + 1 },
  // …one line for every other HOT_ROUTES key, each with its own measured T and S + 1
};
```

keeping the table below the key constants it reads, and writing the literal numbers each test printed (the `T`/`S` above are where they go, not values to commit). Before committing, sanity-check: the wrapped auth-only case measured exactly one transaction more than the self-managed one (if not, find out why before pinning); the full-chain heartbeat is within 3 + the auth-only transactions; and record the full measured table in the PR description. Any route whose steady-state transactions exceed 4 goes in the PR as a W1 efficiency finding — pinning records today's cost, it does not bless it.

- [ ] **Step 6: Run to verify everything passes**

Run: `pnpm --filter @breeze/api test:integration src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
Expected: PASS, every test. Then prove the gate discriminates: temporarily add one extra query, ``await db.execute(sql`select 1`);``, at the top of the `PUT /:id/disks` handler in `routes/agents/inventory.ts` (import `sql` from `drizzle-orm` if the file lacks it), re-run, and confirm `W0d PUT /agents/:id/disks` FAILS on statements; revert the handler and re-run green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
git commit -m "test(api): pin full-chain DB budgets for every agentsim route, agent auth included (W0d)"
```

---

### Task 13: W0d — command-result and WebSocket frame budgets, and the simulator ⇔ budget contract

The simulator answers commands over the socket (`command_result` frame) and HTTP (`POST /commands/:id/result` fallback), and answers every server ping with a `pong` frame (which refreshes the presence lease). The two WS frames are driven through `createAgentWsHandlers` with a stub socket, the pattern `commandResultPersistenceOrder.integration.test.ts` uses. A Go test then fails whenever the simulator gains a steady-state route that has no budget here.

**Files:**
- Modify: `apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
- Create: `agent/tools/agentsim/sim/budget_contract_test.go`

**Interfaces:**
- Consumes: Task 12's `HOT_ROUTE_BUDGETS`, `expectWithinBudget`, `agentRequest`, `W0D_EXTRA_KEYS`; `createAgentWsHandlers` from `routes/agentWs.ts`; `deviceCommands` schema; `getTestDb` from `./setup`; Go `SteadyStateRoutes()`, `RouteCrawlConfig` (Task 3).
- Produces: budget keys `'POST /agents/:id/commands/:commandId/result'`, `'WS command_result'`, `'WS pong'`.

- [ ] **Step 1: Write the failing Go contract test**

```go
// agent/tools/agentsim/sim/budget_contract_test.go
package sim

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// budgetExempt lists steady-state routes with no API DB budget, and why.
var budgetExempt = map[string]string{
	RouteCrawlConfig: "ee/workspace extension route, mounted only with BREEZE_WORKSPACE_ENABLED; its budget belongs with that module",
}

// Every request the simulator sends per minute must have a pinned DB budget in
// the API Integration Tests job (W0d), so a new query on any hot agent path
// reds CI. The TS file owns the numbers; this only checks the keys exist.
// Adding a simulator route touches agent/**, so this runs in Test Agent.
func TestEverySteadyStateRouteHasAnAPIDBBudget(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "apps", "api", "src", "__tests__", "integration",
		"agentHotPathQueryBudget.integration.test.ts")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the API budget test (%s): %v", path, err)
	}
	for _, route := range SteadyStateRoutes() {
		if _, exempt := budgetExempt[route]; exempt {
			continue
		}
		if !strings.Contains(string(src), "'"+route+"'") {
			t.Errorf("simulator route %q has no DB budget in %s (add it to HOT_ROUTES or W0D_EXTRA_KEYS and pin it)", route, filepath.Base(path))
		}
	}
}
```

Run: `cd agent && go test ./tools/agentsim/sim/ -run TestEverySteadyStateRouteHasAnAPIDBBudget`
Expected: FAIL for exactly `POST /agents/:id/commands/:commandId/result`, `WS command_result` and `WS pong`.

- [ ] **Step 2: Add the TS keys, helpers and failing tests**

Add imports (merge with the existing lines):

```ts
import { eq } from 'drizzle-orm';
import { deviceCommands, enrollmentKeys } from '../../db/schema';
import { getTestDb, getTestRedis } from './setup';
import { createAgentWsHandlers } from '../../routes/agentWs';
```

(replacing the existing `import { enrollmentKeys } from '../../db/schema';` and `import { getTestRedis } from './setup';` lines).

Replace the `W0D_EXTRA_KEYS` declaration and its one-line doc comment (both above `HOT_ROUTE_BUDGETS`) with:

```ts
const COMMAND_RESULT_KEY = 'POST /agents/:id/commands/:commandId/result';
const WS_COMMAND_RESULT_KEY = 'WS command_result';
const WS_PONG_KEY = 'WS pong';

/** Budget keys outside HOT_ROUTES. */
const W0D_EXTRA_KEYS: string[] = [COMMAND_RESULT_KEY, WS_COMMAND_RESULT_KEY, WS_PONG_KEY];

const wsStub = { send: vi.fn(), close: vi.fn() } as unknown as Parameters<
  ReturnType<typeof createAgentWsHandlers>['onMessage']
>[1];

/** A `sent` command row, as dispatch leaves it; written by the uncounted test client. */
async function insertSentCommand(deviceId: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({ deviceId, type: 'refresh_inventory', targetRole: 'agent', payload: {}, status: 'sent' })
    .returning({ id: deviceCommands.id });
  if (!row) throw new Error('insertSentCommand: no row');
  return row.id;
}

async function commandStatus(commandId: string): Promise<string | undefined> {
  const [row] = await getTestDb()
    .select({ status: deviceCommands.status })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);
  return row?.status;
}

const commandResultBody = { status: 'completed', exitCode: 0, stdout: 'agentsim' };
```

Inside the describe block, after the full-chain heartbeat test, add:

```ts
  runDb(`W0d ${COMMAND_RESULT_KEY}: the HTTP fallback result, agent auth included, stays inside its budget`, async () => {
    const org = await seedOrg('w0d-cmd-http');
    const device = await enrollDevice(org, 'target');
    const sibling = await enrollDevice(org, 'sibling');
    const warm = await agentRequest(sibling, 'POST', `commands/${await insertSentCommand(sibling.deviceId)}/result`, commandResultBody);
    expect(warm.status).toBeLessThan(300);
    const commandId = await insertSentCommand(device.deviceId);
    const measured = await measure(() => agentRequest(device, 'POST', `commands/${commandId}/result`, commandResultBody));
    console.log('[W0d budget]', COMMAND_RESULT_KEY, JSON.stringify(measured));
    expect(measured.status).toBeLessThan(300);
    expect(await commandStatus(commandId)).toBe('completed'); // accepted, not short-circuited
    expectWithinBudget(COMMAND_RESULT_KEY, measured);
  });

  runDb('W0d WS frames: a pong and a command_result stay inside their budgets', async () => {
    const org = await seedOrg('w0d-ws');
    const device = await enrollDevice(org, 'ws-target');
    const handlers = createAgentWsHandlers(device.agentId, {
      deviceId: device.deviceId,
      orgId: device.orgId,
      partnerId: device.partnerId,
    });
    const frame = async (data: unknown): Promise<Response> => {
      await handlers.onMessage({ data: JSON.stringify(data) } as MessageEvent, wsStub);
      return new Response(null, { status: 204 });
    };
    await handlers.onOpen({}, wsStub);
    try {
      await frame({ type: 'pong', timestamp: Date.now() }); // the first pong after open is not steady state
      const pong = await measure(() => frame({ type: 'pong', timestamp: Date.now() }));
      const commandId = await insertSentCommand(device.deviceId);
      const result = await measure(() => frame({ type: 'command_result', commandId, ...commandResultBody }));
      console.log('[W0d budget] ws pong:', JSON.stringify(pong), 'ws command_result:', JSON.stringify(result));
      expect(await commandStatus(commandId)).toBe('completed');
      expect(result.statements).toBeGreaterThan(0);
      expectWithinBudget(WS_PONG_KEY, pong);
      expectWithinBudget(WS_COMMAND_RESULT_KEY, result);
    } finally {
      await handlers.onClose({}, wsStub);
    }
  });
```

- [ ] **Step 3: Run to verify they fail and capture the measurements**

Run: `pnpm --filter @breeze/api test:integration src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
Expected: the two new tests FAIL with `no budget pinned for '…' — measured {…}` (and the table test lists the three new keys); everything from Task 12 still PASSES. A pong that measures `statements: 0` is expected (presence refresh is Redis-only) and is pinned as `{ transactions: 0, statements: 1 }`.

- [ ] **Step 4: Pin and verify**

Add the three keys to `HOT_ROUTE_BUDGETS` exactly as in Task 12 Step 5 (`[COMMAND_RESULT_KEY]`, `[WS_COMMAND_RESULT_KEY]`, `[WS_PONG_KEY]`, measured transactions, measured statements + 1).

Run:
```bash
pnpm --filter @breeze/api test:integration src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
cd agent && go test ./tools/agentsim/sim/ -run TestEverySteadyStateRouteHasAnAPIDBBudget
```
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts agent/tools/agentsim/sim/budget_contract_test.go
git commit -m "test: pin command-result and agent WS frame DB budgets; keep agentsim routes and budgets in step (W0d)"
```

---

### Task 14: W0a acceptance runs and full verification

No new code. This task produces the evidence the PR carries.

- [ ] **Step 1: Full local verification**

Run:
```bash
cd agent && go test -race ./tools/agentsim/... ./internal/heartbeat/ && CGO_ENABLED=0 go test ./tools/agentsim/... && go vet ./tools/agentsim/... && cd ..
pnpm --filter @breeze/api test:integration src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
pnpm test-stack down
```
Expected: all PASS. (`go test ./...` over the whole agent module runs in CI's Test Agent job.)

- [ ] **Step 2: Run A — fidelity (200 agents, 20 minutes)**

```bash
export AGENT_ENROLL_RATE_LIMIT=5000
pnpm wt-stack up
eval "$(load-tests/agentsim/lab-setup.sh)"
ulimit -n 16384
load-tests/agentsim/run.sh --agents 200 --duration 20m --commands-per-minute 30 &
sleep 960 && load-tests/agentsim/check-acceptance.sh live 200
wait
load-tests/agentsim/check-acceptance.sh report "$(ls -t load-tests/agentsim/reports/*.json | head -n1)"
```
Expected: every line PASS — 200 device rows, 200 leases, mix within ±10 % of the model (4.21 req/agent-min with the lab's workspace module off), zero non-2xx outside crawl-config, zero transport errors, ≥ 99 % command results. If the lab's `BREEZE_WORKSPACE_ENABLED` matches production, also pass `5.0` as the third argument and record that line.

- [ ] **Step 3: Run B — scale (2,000 agents, 30 minutes)**

```bash
load-tests/agentsim/run.sh --agents 2000 --ramp 5 --duration 30m --commands-per-minute 30 &
sleep 1500 && load-tests/agentsim/check-acceptance.sh live 2000
wait
load-tests/agentsim/check-acceptance.sh report "$(ls -t load-tests/agentsim/reports/*.json | head -n1)" || true
```
Expected: both `live` lines PASS (2,000 distinct device rows, 2,000 presence leases). The `report` lines are recorded, not gated (see "Open item 1"): note heartbeat p95/p99, `totals.attempts − totals.requests` (retries), non-2xx and the measured req/agent-min. If `live` shows fewer than 2,000 leases, read `ws.reconnects` / `ws.connectFailures` and the API log for 4008/4002 closes before calling it a simulator bug.

- [ ] **Step 4: Record and tear down**

Paste both reports' `totals`, the heartbeat and inventory `routes[]` entries, and both `check-acceptance.sh` outputs into the PR description. Do not commit the reports (W0c owns committed baselines). Then:

```bash
pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Expected: nothing from this worktree still running; say in the PR what, if anything, was left up.

---

## Not in this plan

- **W0b storm scenarios** (kill the API, drop every socket, slow event loop, rolling deploy). `--start cold`, the mirrored reconnect rules and the per-attempt accounting are the hooks they need.
- **W0c KPI dashboard and the nightly/manual `perf` workflow.** It consumes `breeze.agentsim.report/v1` as specified above and owns committed baselines; it also re-measures the production req/agent-min figure the spec marks [I].
- **Streams not modelled** (each ≤ ~0.1 req/agent-min or event-driven): daily `hardware`, `patches/*`, `reliability`; `time-status`; `hardware-health`; `changes`; `security/recovery-keys`; `monitoring-results`; `logs`; `warranty-info` (darwin); `unifi-telemetry`; `boot-performance`. The work a command asks for (e.g. a real inventory fan-out on `refresh_inventory`) is not performed — results are synthetic.
- **Fleet shape:** every simulated device lands in one org via one key, which keeps org-wide caches warmer than a real multi-org MSP fleet. Spreading agents over several keys/orgs is a W0c option.
- **mTLS client certificates:** the lab issues none and binding mode is `off`; a cert-bound run needs Cloudflare credentials and is out of scope.
- **A DB budget for `GET /workspace/agent/crawl-config`:** an `ee/workspace` extension route that exists only with `BREEZE_WORKSPACE_ENABLED`; its budget belongs with that module (exempted, with the reason, in `budget_contract_test.go`).
- **Budgets for the WS upgrade and enrollment:** once per connection / once per device, not per-minute traffic.

## Self-review

1. **Spec coverage.** W0a: Go simulator ✓ (Tasks 2–10); real enrollment key and a distinct token per device ✓ (Tasks 5, 6, 10); agent's own payload structs ✓ (Tasks 1, 7, plus `api.Enroll*`, `heartbeat.HeartbeatResponse`, `agentws.Command`/`CommandResult`, `tools.CommandResult`); heartbeat 60 s, unifi-collectors 30 s, inventory PUTs, persistent WS with pings, command-result replies ✓ (Tasks 8, 9); per-agent start jitter ✓ (Task 8); configurable N, ramp, duration, target, key, cadence overrides, token store reuse ✓ (Tasks 2, 5, 10); JSON run report with per-route requests per agent-minute, p50/p95/p99, status/error counts, WS connects/reconnects ✓ (Tasks 3, 4); lab stack via wt-stack with env-only overrides and a 20-agent smoke ✓ (Task 11); 2,000-agent acceptance with device rows, presence leases and the mix ✓ (Task 14, with the saturation caveat raised to the owner); k6 README note ✓ (Task 11). W0d: every hot agent route the simulator exercises, through agent auth, in the Integration Tests job ✓ (Tasks 12, 13); separate agent-auth case ✓ (Task 12); harness reused, not forked ✓; a new query reds CI ✓ (Task 12 Step 6 proves it).
2. **Placeholder scan.** The only values not in the plan are the W0d budget numbers, which cannot be known without a live database; Task 12 Steps 4–5 make "no budget pinned" the red state and give the exact procedure and shape for pinning them.
3. **Type consistency.** `Config`/`Cadence`/`StartMode` (Task 2) used unchanged in 4, 7–10; `Recorder` method names (Task 3) match their call sites in 8–10; `Identity` (Task 5) fields match `Enroller.Enroll` (6), `Payloads` (7), `Agent` (8); the `socket` interface (8) is what `wsSession` (9) implements (`Run`, `Connected`, `SendResult`); route keys in `routes.go` match the TS `key` strings and `W0D_EXTRA_KEYS` character for character, which `budget_contract_test.go` enforces.
4. **Review Focus.** All five lines have an owning test: Tasks 2/4/10 (empty window), 8 (stale-token re-enroll), 5 (cross-server store), 3/6 (429/503 and retry accounting), 9 (upgrade backoff vs. immediate redial).
5. **Code verified at authoring time.** Every Go block in this plan (with Task 9's `NewAgent` edit applied) was extracted into a scratch copy of the agent module at this commit: `gofmt` clean, `go vet` clean for darwin, linux (`CGO_ENABLED=0`) and windows, and `go test -race ./tools/agentsim/...` passed twice; `budget_contract_test.go` failed on exactly the three keys Task 13 Step 1 predicts and passed once they existed. The TypeScript blocks were not executed (they need a live Postgres); their payloads were checked by hand against `routes/agents/schemas.ts` and `softwareInventoryObservation.ts`.
