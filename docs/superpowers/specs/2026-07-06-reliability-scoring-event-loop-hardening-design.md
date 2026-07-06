# Reliability-scoring event-loop hardening — design

**Date:** 2026-07-06
**Status:** approved (design), pending implementation plan
**Area:** `apps/api` — device reliability scoring worker + ingest route
**Related:** #1105 (held-transaction connection pins), ML metric-rollup CPU peg (v0.82.x), reliability scoring fixes #2159 / #2166

## Problem

Production US (v0.91.0) showed intermittent high API response times. Live investigation traced it to the **in-process device-reliability scoring worker saturating the Node event loop**, not the database or connection pool.

Evidence gathered on the US droplet:

- `GET /api/v1/devices/:id/events` averaged **22.4s (max 29s)**, yet the exact query `EXPLAIN ANALYZE`s in **0.3ms** with proper indexes — so the latency is **contention, not slow SQL**.
- The API container **spikes to 112% CPU** in bursts (samples: 2% → 3% → 39% → 112%); most requests between bursts stay fast (`/health` max 3ms), giving bimodal "sometimes very slow" latency. **683 / 8,791 responses (7.8%) took ≥1s.**
- Reliability ingests sit **idle-in-transaction 5–20s** at `wait=Client:ClientRead` (Postgres idle, app busy) — the #1105 pattern — flooding **1,215 warnings in 2 hours**.
- Pool was **not** the bottleneck (peak 4/20 connections in use). Redis latency ~0ms. Sentry errors: 0 in 14 days.

### Root cause

`computeAndPersistDeviceReliability` (`apps/api/src/services/reliabilityScoring.ts`) reads a device's **entire 90-day history via `SELECT *`** (including the large `rawMetrics` JSONB) — `getHistoryForDevice(deviceId, 90)` at line ~1356 — and buckets it in JS. It runs on **every** ingest POST, at worker **concurrency 5**, **in the API process**. The compute cost is **O(history rows)** when the algorithm only needs **O(days)** of daily aggregates.

An acute trigger exposed the latent bug: one device (`61728f06…`) posts reliability every **~18s** and has accumulated **13,774 rows** (all other devices: ~80–90 rows total). Each of its posts reads all 13,774 rows (with JSONB) and processes them in JS — pegging a core. The **runaway device/agent is a separate operational track**; this design hardens the compute so no single device — or the daily all-org scan at fleet scale — can ever peg the API again.

## Non-goals (separate tracks)

- Investigating why device `61728f06…` posts every ~18s (agent bug vs retry loop).
- Moving the reliability worker to its own process/container.
- Ingest-side rate-limiting / debounce of reliability POSTs.
- Count-based retention on `device_reliability_history`.

## Design

Four changes, all in `apps/api`. Scoring output must be **preserved exactly**.

### 1. Make the compute O(days), not O(history rows) — core fix

`getHistoryForDevice` currently does `SELECT *` over the 90-day window and buckets in JS.

- **Guaranteed-safe floor:** select only the columns the scorer consumes; **drop `rawMetrics`** (and any other unused column) from the read. This is pure perf with zero behavior change and removes the bulk of the row payload (~2KB JSONB/row).
- **O(days) reduction:** push the per-day reduction the algorithm already performs into SQL, so JS receives **≤~90 daily rows** instead of thousands — applied **only where it provably preserves output**. The exact aggregation (per-day reduction and event de-duplication semantics — e.g. whether `crashEvents`/`appHangs`/`serviceFailures`/`hardwareErrors` are cumulative snapshots or deltas) is pinned in the implementation plan against the current bucketing logic (`reliabilityScoring.ts` day-bucket loops).
- **Correctness guard:** a **golden-value test** asserts identical score + all persisted fields for a fixed synthetic history (including a high-frequency multi-post-per-day device) before vs. after the refactor. If any field cannot be aggregated in SQL without changing output, it stays row-based but **bounded/downsampled** — correctness wins over cleverness.

Index support already exists: `reliability_history_device_collected_idx` on `(device_id, collected_at)` — **no migration required**.

### 2. Throttle on-demand recompute

`ON_DEMAND_RELIABILITY_DEDUPE_WINDOW_MS` (`apps/api/src/jobs/reliabilityWorker.ts`): **30s → 10 min**. A device recomputes at most every 10 min on-demand regardless of post rate. The existing `jobId` slot mechanism (`reliability-device:${deviceId}:${slot}`) already keys on this window, so widening the constant is sufficient. Trade-off: reliability-score staleness ≤10 min (acceptable).

### 3. Lower worker concurrency

`createReliabilityWorker` `concurrency: 5 → 2`. Caps simultaneous heavy computes. With change #1 making each compute cheap, 2 is ample headroom.

### 4. Fix the #1105 held-transaction pin on ingest

`POST /agents/:id/reliability` currently runs entirely inside the request-long org-scope `withDbAccessContext` imposed by `agentAuth` middleware (only `heartbeat` is in `SELF_MANAGED_DB_CONTEXT_ACTIONS`). The BullMQ `enqueue` (Redis) and the audit write therefore run inside a held transaction, pinning a pooled connection.

- Add `reliability` to `SELF_MANAGED_DB_CONTEXT_ACTIONS` (`apps/api/src/middleware/agentAuth.ts`), following the `heartbeat` pattern.
- In `apps/api/src/routes/agents/reliability.ts`, scope a short `withDbAccessContext` (org scope) around just the device lookup + history insert, then run `enqueueDeviceReliabilityComputation` and `writeAuditEvent` **outside** any open transaction.
- The worker's `scope=system` holds shrink to ms automatically once change #1 lands (the context is held only across a now-cheap read→write).

## Testing

- **Golden-value score-equality test** (critical): fixed synthetic history → identical score and all persisted `device_reliability` fields before vs. after the O(days) refactor. Include a device with many same-day posts.
- **Dedupe-window test:** repeated `enqueueDeviceReliabilityComputation` calls within the window reuse the same job id.
- **#1105 depth-tracking test:** on the reliability route, the BullMQ enqueue and audit write execute at DB-context depth 0 (no open transaction held across them), mirroring the existing #1703/#1704 depth-tracking test style.
- **Bound assertion:** the compute reads ≤~90 aggregated rows regardless of raw history size (guards against O(rows) regressions).
- Existing reliability unit/integration tests continue to pass.

## Rollout

- Normal release: tag → build → deploy EU + US (`docker compose pull api web && up`).
- No data migration. No new env vars. No infra/compose changes.
- Shipping this relieves prod even while the runaway agent is still misbehaving, because the compute becomes cheap and bounded.
- Post-deploy verification on US: API CPU no longer spikes to a full core under reliability load; `POST /agents/:id/reliability` and `GET /devices/:id/events` p95 drop to sub-second; #1105 warning rate falls to ~0.
