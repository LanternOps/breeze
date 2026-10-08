---
tracking_issue: LanternOps/breeze#8139
---

# Horizontal API scaling — W0 + W1 program plan

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md` (owner-approved 2026-10-07; all five §9 decisions)

This is the index for the first two workstreams of the spec. Each wave ships as its own PR and has its own plan doc. A wave without a plan doc yet gets one written at wave start, from the spec row it cites, before any code. Wave status lives on the GitHub tracking issue, not here.

The order follows owner decision 1: per-agent efficiency (W1a) and measurement (W0) come first, ahead of any scale-out. W2–W5 are registered on the tracking issue once W0 has a committed baseline.

| Key | Spec row | Scope | Depends on | Plan | Rigor |
|---|---|---|---|---|---|
| W01 | W1a-1 | Heartbeat statement cut, part A: hierarchy pass-through, topology skip with materialization off, per-org caches, single `agent_versions` read, site join, empty-savepoint removal, budget-suite payload fix and ratchet. Target: ≤30 statements per steady beat | — | `2026-10-07-scaling-w1a1-heartbeat-hierarchy-passthrough.md` | Standard; the hierarchy must come only from the authenticated device's own row |
| W02 | W0a + W0d | Realistic Go agent simulator (distinct enrolled tokens, real payload structs, production cadences, run report JSON); per-route statement-budget gate for every hot agent route plus agent auth | — | `2026-10-07-scaling-w0a-agent-simulator.md` | Standard; lab overrides via env only, never code defaults. Acceptance is split: a 200-agent run gates the ±10 % request mix and zero errors; the 2,000-agent run gates 2,000 device rows and presence leases and records latency and errors as the first capacity data point, because one dev-mode lab API cannot carry 2,000 agents at production cadence |
| W03 | W1a-2 | One batched policy-assignment read for all feature types; fold the OneDrive context into the policy context; cache monitoring "no policy applies" with invalidation. Target: ≤16 statements, ≤2 tx | W01 | at wave start | **High**: the batched read runs in system scope, so its ownership filters are the only tenant guard. Advisor quorum on the query shape; RLS suites; one full review round |
| W04 | W1e | Admission permit gate in front of the pool, lag-tolerant deadlines, deferred reclaim, postgres.js BEGIN-reservation patch; builds on #8243 (#8229) | #8243 | `2026-10-08-scaling-w04-prologue-pool-reclamation.md` | **High** (DB connection lifecycle) |
| W05 | W1b | Cluster cache primitive (in-process TTL + Redis pub/sub invalidation by id); migrate the #8128 hot-path caches onto it | W01 | at wave start | Standard; cross-instance invalidation test required |
| W06 | W0b | Storm scenarios on the simulator: API kill, drop all sockets, slow event loop, rolling deploy; reconnect curve and pool recovery report | W02 | at wave start | Tooling |
| W07 | W0c | KPI dashboard per instance and region; nightly/manual `perf` workflow on fixed hardware, failing on a >15 % KPI regression; first baseline committed | W02 | at wave start | Tooling |
| W08 | W1c | API admission control: priority shedding on event-loop lag / pool wait with `503` + `Retry-After`; WS upgrade token bucket refused with a pre-upgrade `503` + `Retry-After`; heartbeats never shed; ships in `observe` mode; edge shed rules removed after an `enforce` peak day | W04 | `2026-10-08-scaling-w08-api-admission-control.md` | **High** (agent-facing behaviour under load) |
| W09 | W1d | Agent: jittered first reconnect, `drain {reconnectWithinMs}` handling, loop-level `Retry-After`, jittered startup and periodic requests | W06, W08 | at wave start | **High**: ships to customer machines; follows agent release rings |

W01 and W02 can run in parallel. **P1 for v0.123.0 (owner, 2026-10-08):** W03, W04, W08, W10. Order for the pool/admission work: #8243 → W04 → W08. W04 is independent of everything else and can start whenever a slot is free.

## Exit criteria for W0 + W1

- Steady-state heartbeat ≤16 statements and ≤2 transactions, asserted by the budget suite (W01, W03).
- A committed simulator baseline of API CPU-ms per agent-minute, with the M1 target (≤60) met (W02, W07).
- Under a W0b storm, p95 heartbeat ≤1 s and the pool never below 80 % of max (W04, W08).
- 10k simulated agents told to reconnect within 120 s arrive spread over 120 s ±10 % (W09).
