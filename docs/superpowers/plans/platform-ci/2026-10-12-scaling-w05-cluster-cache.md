---
title: "Scaling W05 (W1b): cluster cache — in-process TTL + Redis pub/sub invalidation by id"
date: 2026-10-12
tracking_issue: LanternOps/breeze#8139
wave_issue: LanternOps/breeze#8144
depends_on: W01 (#8140, merged as #8222); builds on #8128 and W03 (#8264)
rigor: standard (program plan row W05); cross-instance invalidation test required
---

# Scaling W05 — Cluster Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A write on API instance A drops the matching entry of every hot-path cache on every other API instance within 1 s. Today it waits out the TTL (60 s, or 5 min for the collector-absence cache). If Redis is down, behaviour stays exactly what it is today: TTL-only.

**Architecture:** Extend the existing `HotPathTtlCache` (`services/hotPathCache.ts`) rather than adding a second cache class. All eight in-process hot-path caches are already instances of it. It already has a bounded size, the generation counter that keeps a racing load out of the cache, and `invalidateAroundCommit`. Add one option, `cluster`. When it is set, `invalidateAroundCommit(key?)` also publishes `{cache, key | null}` on one Redis channel, through `runAfterDbContextCommit`, so only after the writer's transaction has committed. A new `ClusterCacheBus` holds one subscriber connection per process (a `getRedis().duplicate()`) for every cache. On a message from another instance it calls the named cache's `invalidate(key)`, which bumps the generation, so an in-flight load on the receiver is not stored either. Payloads carry ids only, never values (spec §7). When the subscriber reconnects it clears every cluster cache once, because messages sent during the gap are lost. The "migration" of each cache is therefore not a type swap. It is: turn on `cluster`, make each writer call `invalidateAroundCommit`, and prove the publish with a test.

**Tech Stack:** Hono/TypeScript API, ioredis (`services/redis.ts`), `prom-client` 15 via the leaf `services/metricsRegistry.ts`, Vitest 4 (unit and integration configs).

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md`, row **W1b** (§6) and §7 "Tenancy". Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md`, row **W05**. Wave issue #8144, feature #8139.

## Global Constraints

- Spec W1b, verbatim: "A **cluster cache** primitive: in-process TTL cache plus Redis pub/sub invalidation by key (ids only, no payload). Use it for the trust keyset, delegations, per-org update config and topology flags." Acceptance, verbatim: "KPI ≤60 CPU-ms/agent-min (M1). A cache test proves a write on instance A invalidates instance B within 1 s."
- Program plan row W05: "migrate the #8128 hot-path caches onto it". This plan covers the four caches the spec names and the four other `HotPathTtlCache` instances that #8128, W01 and W03 added. There are eight in all.
- Spec §7: "Cache invalidations carry ids only; the receiver reloads under its own RLS context." The message carries a cache name and a key (an org id, a `${orgId}:${deviceId}` pair, or a fixed literal such as `'active'`). It never carries a value. The receiver only drops entries; its next read loads as it does today.
- **No new settings and no new env vars.** The spec names none. The channel name is a code constant. Redis availability is the only switch: without Redis, the cache is TTL-only, which is exactly today's behaviour.
- **No TTL changes in this wave.** Shortening or lengthening any TTL is a separate decision, made once W07 shows the hit rates (follow-up 2).
- **No schema change, no migration, no new table.** The RLS and cascade lists in CLAUDE.md do not apply.
- **No new DB statement on any hot path.** The cluster layer touches Redis only, and only on writes. `agentHotPathQueryBudget.integration.test.ts` must pass unchanged (Task 13).
- **#1105 / DB context rules:** a publish never runs inside a DB context. It goes through `runAfterDbContextCommit`, so a rolled-back write publishes nothing. The subscriber handler never opens a DB context; it only drops entries.
- `hotPathCacheRegistry.ts` stays a leaf with no imports. The integration setup loads it before `.env.test`. The bus is never imported from it.
- `metricsRegistry.ts` stays a leaf. The new metrics module imports only `prom-client` and `metricsRegistry`, and registers its series at module scope with `registers: [metricsRegistry]`, so `routes/metrics.ts` is not edited (it is W07's file).
- **Test placement:** unit tests sit next to their source. The cross-instance suite goes in `apps/api/src/__tests__/integration/`, which `vitest.integration.config.ts` already includes. CI runs it in the blocking `integration-test` job (`.github/workflows/ci.yml`, 16 shards; `docs/agents/testing.md` still says 8, and the workflow is the source of truth).
- **Vitest:** `cd apps/api && npx vitest run <file>` for unit tests, and `cd apps/api && npx vitest run -c vitest.integration.config.ts <file>` for integration. Never `pnpm --filter … test -- --run <path>`. A path filter is a substring match, so check the reported file count every time.
- **Integration stack:** run `pnpm test-stack up` from the worktree root before the first integration run, and `pnpm test-stack down` at the end of Task 13.
- **Typecheck** before each commit: `cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`. Read the exit code. Piping into `tail` hides a heap OOM as a pass.
- **Red first.** Every task writes its failing test, runs it, and sees it fail for the stated reason before the implementation step.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model). The PR body includes `Closes #8144` and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

1. **A publish that runs before COMMIT.** Instance B would drop its entry, reload, read the pre-commit rows and cache them for a full TTL. That is worse than today. Expected: publishes go only through `runAfterDbContextCommit`. Tests: Task 3 (unit: a publish is queued in a context and runs at commit, never on rollback) and Task 4 (integration: B keeps its entry while A's transaction is still open, and keeps it after a rollback).
2. **A remote invalidation that deletes the entry without bumping the generation.** A load already in flight on B, which read the old rows, would then store them. Expected: the bus calls `cache.invalidate(key)`, never a raw delete. Test: Task 4 "in-flight load on B is not stored".
3. **Lost messages across a subscriber reconnect.** ioredis re-subscribes on reconnect, but messages published during the gap never arrive. Expected: every reconnect after the first `ready` clears every cluster cache on that instance once. Test: Task 2 (unit) and Task 4 (integration, forced reconnect).
4. **Redis down or slow.** Expected: no writer throws, waits or blocks its response on Redis. The publish is fire-and-forget after commit, and `getRedis() === null` counts as `unavailable`. Boot never waits more than `CLUSTER_CACHE_SUBSCRIBE_TIMEOUT_MS` (1 s) for the subscription. Tests: Task 2 and Task 4 "degraded".
5. **Forged or malformed messages.** Anyone who can publish on the Redis channel can only make caches drop entries. That direction is safe: the next read reloads from the DB under its own context. Expected: unknown cache names, non-string or oversized keys, and bad JSON are dropped and counted, and never throw in the `message` handler. Metric labels come only from registered cache names. Test: Task 2.
6. **A writer that bypasses the invalidators.** Expected: every non-test file that runs `.update(organizations)` or `.update(partners)` is classified in a ratchet, so a new settings writer cannot silently skip invalidation. Test: Task 12.

---

## Verified findings that shape this plan

Labels: **[V]** read in code at `origin/main` `6859e6f749`. **[I]** inferred.

### The caches (all `HotPathTtlCache`, all in-process, none cluster-invalidated today)

| # | Cache (`name`) | Declared | Key → value | TTL / max | Writers that invalidate today (this process only) | Spec-named |
|---|---|---|---|---|---|---|
| C1 | `orgAgentUpdateConfigCache` (`org-agent-update-config`) | `services/agentOrgSettingsCache.ts:35` | org id → `AgentUpdateConfig` | 60 s / 20,000 | `invalidateAgentOrgSettingsCaches(orgId?)` from `routes/orgs.ts:1379` (`PATCH /partners/me`, all orgs), `:1569` (partner settings, all orgs), `:2858` (org update, one org) | per-org update config |
| C2 | `orgTopologyFlagsCache` (`org-topology-flags`) | `agentOrgSettingsCache.ts:41` | org id → `TopologyFlags` | 60 s / 20,000 | same as C1 | topology flags |
| C3 | `orgHelperSettingsCache` (`org-helper-legacy-settings`) | `agentOrgSettingsCache.ts:88` | org id → `{enabled}` | 60 s / 20,000 | `invalidateOrgHelperSettingsCache` from `routes/agents/mtls.ts:1790`; also cleared by `invalidateAgentOrgSettingsCaches` | — |
| C4 | `orgPolicyProbeCache` (`org-policy-probe`) | `agentOrgSettingsCache.ts:82` | org id → `PolicyProbeConfigUpdate \| null` | 60 s / 20,000 | `invalidateOrgPolicyProbeCache` from `routes/policyManagement/actions.ts:92` (deactivate). **Gap:** org merge re-points `automation_policies` and invalidates none of the hot-path caches (`agentOrgSettingsCache.ts` comment) | — |
| C5 | `orgPamFallbackCache` (`org-pam-fallback`) | `agentOrgSettingsCache.ts:94` | org id → `PamSettings` | 60 s / 20,000 | **No writer exists** for `pam_org_config.uac_interception_enabled` (`routes/pam.ts:1682` upserts only `defaultUnmatchedVerdict`) | — |
| C6 | `trustKeysetCache` (`manifest-trust-keyset`) | `services/manifestSigning.ts:242` | `'active'` → `ManifestTrustKey[]` | 60 s / 1 | `invalidateManifestTrustCaches()` (plain `invalidate`) from `ensureActiveSigningKey` (`:173`). **Gap:** the rotation CLI `apps/api/scripts/manifest-key-rotation.ts` (`:414-456`) runs in its own process and invalidates nothing | trust keyset |
| C7 | `delegationRowsCache` (`manifest-key-delegations`) | `manifestSigning.ts:521` | `'unexpired'` → `DelegationRow[]` | 60 s / 1 | same as C6 | delegations |
| C8 | `agentCollectorAbsenceCache` (`unifi-agent-collector-absence`) | `services/unifi/unifiCollectorService.ts:223` | `${orgId}:${deviceId}` → `boolean` (only `false` is stored) | 5 min / 50,000 | `invalidateAroundCommit` in `upsertCollector` (`:125`) and `upsertSelfHostedController` (`:173`) | — |

### The primitive today (`services/hotPathCache.ts`) [V]

- `getOrLoad` bypasses the cache inside any DB context, never caches a throw, and never coalesces concurrent misses.
- `invalidate(key?)` bumps `generation` and drops one key, or every key.
- `invalidateAroundCommit(key?)` drops now and drops again through `runAfterDbContextExit`. That second drop runs on commit **and** on rollback.
- `ticket()` + `fillIfCurrent()` keep a load that raced an invalidation out of the cache. `DeferredCacheFills` uses them for C3–C5 from inside the heartbeat's system context.
- Eviction is FIFO by insertion order past `maxEntries`.
- The cache has no metrics and does not use Redis. Its doc comment already says "Invalidation is process-local … Pick the TTL with that in mind".
- `db/index.ts:858` already exports `runAfterDbContextCommit(label, work)`: it runs `work` only if the outermost transaction committed, and runs it at once outside any context (#7277).

### Redis conventions [V]

- `getRedis(): Redis | null` (`services/redis.ts:125`) is the shared command client. It returns `null` while Redis is marked unavailable (an `ECONNREFUSED` sets that flag; `'connect'` clears it). `isRedisAvailable()` is at `:169`.
- `getRedisConnection()` (`:213`) is BullMQ's connection and **throws** when Redis is unavailable. It is not used here.
- There is no shared subscriber helper. The two existing pub/sub users each `getRedis().duplicate({ connectionName })` their own subscriber: `routes/agentWs.ts:349-418` (`agent-credential:revoked`, with a 1 s bounded subscribe and a DB fallback) and `:469-492` (`partner-trust:changed`). This plan copies that shape: one duplicate per process, named `breeze:cluster-cache`, for every cache.
- A connection in subscriber mode cannot publish, so publishes go on the `getRedis()` client.
- ioredis re-subscribes on reconnect by itself (`services/eventDispatcher.ts` ~88-93 documents it). Messages sent while it was disconnected are lost.
- `services/instanceIdentity.ts:7` exports `INSTANCE_ID`, a per-boot UUID. It is the message's `origin`, so an instance can drop its own echo.

### Not in scope, on purpose

| Item | Why not |
|---|---|
| `helper:settings:device:*` (`services/helperSettings.ts:209`), and the other device-keyed Redis policy caches in #8257 | These live in Redis, which all instances share. They are not process-local. #8257 (binding them to the org) is its own issue |
| Monitoring "no policy applies" cache | It does not exist. W03 decided against it (`2026-10-08-scaling-w03-batched-policy-read.md`, finding 10) |
| Partner trust | It is per-socket state in `activeConnections` with its own channel (`agentWs.ts:283`), not a TTL cache |
| `agentAuthNegativeCache`, partner scope-policy and allowlist caches, other module-level `Map`s | Spec W4 ("Per-process caches … Classify each; anything that needs cluster consistency moves to the W1b primitive"). Once this wave lands, W4 can move them with one option each |
| `agent_versions` | The spec says not to cache it: the version offered must match the bytes served |

## File structure

| File | Responsibility |
|---|---|
| Create `apps/api/src/services/clusterCacheMetrics.ts` | prom-client series (leaf: `prom-client` + `metricsRegistry` only) |
| Create `apps/api/src/services/clusterCacheRegistry.ts` | Leaf (no imports): name → cluster cache target, replace-on-duplicate (D12) |
| Create `apps/api/src/services/clusterCacheBus.ts` (+ `clusterCacheBus.test.ts`) | The channel, message codec, publish (time-bounded), the one subscriber, reconnect resync, the process default bus |
| Modify `apps/api/src/services/hotPathCache.ts` (+ `hotPathCache.test.ts`) | The `cluster` option; publish from `invalidateAroundCommit`; hit/miss/bypass counters |
| Create `apps/api/src/__tests__/integration/clusterCache.integration.test.ts` | Two buses, one real Redis: A→B within 1 s, commit-only, in-flight race, rollback, reconnect, degraded |
| Modify `apps/api/src/index.ts` | Start the subscriber before `serve()`; stop it in `runShutdownPhases` |
| Modify `apps/api/src/services/agentOrgSettingsCache.ts` (+ new `agentOrgSettingsCache.test.ts`) | `cluster: true` on C1–C5; `invalidateOrgPamFallbackCache` helper |
| Modify `apps/api/src/services/manifestSigning.ts` (+ test) | `cluster: true` on C6–C7; `invalidateManifestTrustCaches` uses `invalidateAroundCommit` |
| Modify `apps/api/scripts/manifest-key-rotation.ts` | Publish C6/C7 invalidations after its transaction commits |
| Modify `apps/api/src/services/unifi/unifiCollectorService.ts` (+ test) | `cluster: true` on C8 |
| Modify `apps/api/src/services/orgMerge.ts` (+ test) | Publish C1–C4 invalidations for both orgs after a merge commits |
| Create `apps/api/src/__tests__/orgSettingsWriters.contract.test.ts` | Ratchet: every `.update(organizations\|partners)` writer is classified |
| Modify `apps/docs/src/content/docs/monitoring/stack.mdx` | The new metric series |

### File ownership (keeps W05 disjoint from W06, W07 and W09)

| Wave | Owns | Overlap with W05 |
|---|---|---|
| **W05 (this)** | Every file in the table above | — |
| W06 (#8145, storm scenarios) | `load-tests/agentsim/**`, `agent/tools/agentsim/**` | None |
| W07 (#8146, KPI dashboard + perf gate) | `.github/workflows/perf*.yml`, dashboards, `routes/metrics.ts`, perf docs | **`apps/docs/src/content/docs/monitoring/stack.mdx`**: both waves append a section. Append-only, separate `##` headings; whoever merges second rebases. W05 does **not** edit `routes/metrics.ts` (module-scope registration instead) |
| W09 (#8148, agent reconnect/drain) | `agent/**` (Go) | None |
| Shared hot spot | `apps/api/src/index.ts` | W05 adds two lines in the boot block and one shutdown phase. Any concurrent wave touching `index.ts` rebases; no semantic overlap |

W05 does not touch `routes/agents/heartbeat.ts`, `routes/agents/helpers.ts` or `routes/agentWs.ts`. The readers keep calling the same cache instances.

---

## Design decision

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | New `ClusterCache` class or extend `HotPathTtlCache`? | **Extend** with a `cluster` option | All eight caches are `HotPathTtlCache`. `DeferredCacheFills` depends on its `peek/ticket/fillIfCurrent`. One class keeps the race guard in one place, and a wrapper would need to re-expose all of it |
| D2 | One channel or one per cache? | **One channel**, `breeze:cluster-cache:invalidate`, cache name in the payload | One subscriber connection and one `SUBSCRIBE` per process. Per-channel ordering is guaranteed by Redis, which the rollback test relies on |
| D3 | When to publish | `runAfterDbContextCommit` from `invalidateAroundCommit` | Pre-commit publish lets B cache pre-commit rows for a TTL. A publish on rollback is harmless but noisy; commit-only is the contract #7277 built |
| D4 | What the receiver does | `cache.invalidate(key)` (generation bump) | Keeps an in-flight load on B out of the cache. A raw delete would not |
| D5 | Self-echo | Drop messages whose `origin === INSTANCE_ID` (counted as `self`) | The writer already dropped locally; a self-delivery would only pollute the lag histogram |
| D6 | Reconnect | Track `seenReady` on the event itself. On every `ready` after the first, **re-issue `subscribe(CLUSTER_CACHE_CHANNEL)` (idempotent), await it, and only then** `invalidate()` every cluster cache once | Pub/sub is at-most-once. ioredis fires `ready` and re-subscribes in the same step, so a clear run straight from `ready` can land before SUBSCRIBE reaches the server; a message published in that window would be lost after the clear. Awaiting our own subscribe first closes it. One miss burst per reconnect is cheap (one reload per org per process) |
| D7 | Whole-cache invalidation | `key: null` | The partner settings writers already clear every org (`invalidateAgentOrgSettingsCaches()` with no id) |
| D8 | Which processes subscribe | The API entrypoint (`index.ts`) only. Any process may **publish** (worker jobs, the rotation CLI) | Only the API serves heartbeats and holds these caches warm. Publishing needs no subscription. Consequence, stated in the PR's Merge Danger: if a `BREEZE_ROLE=worker` process ever reads one of these caches, it stays TTL-only (follow-up 5 checks whether any does) |
| D9 | Boot behaviour when Redis is down | `start()` waits at most 1 s (`CLUSTER_CACHE_SUBSCRIBE_TIMEOUT_MS`, a code constant like `AGENT_CREDENTIAL_SUBSCRIBE_TIMEOUT_MS`) and then returns `'timeout'` so boot continues TTL-only, with `subscriber_up 0` and one warning. **It does not disconnect the subscriber.** The pending `subscribe` stays attached (with a `.catch` so it can never become an unhandled rejection), ioredis keeps reconnecting, and when the subscribe eventually resolves the bus sets `subscriber_up 1` and clears every cluster cache once (the same resync as D6) | Today's behaviour is the floor, never worse, and the instance recovers without a restart |
| D10 | Keys | Cluster caches must have string keys. A constructor overload types `cluster` caches as `HotPathTtlCache<string, V>`. At runtime, `invalidateAroundCommit` checks the key **before** touching anything and, for a non-string key on a cluster cache, logs an error and invalidates the whole cache locally and cluster-wide instead of throwing (a cache bug must not fail a settings write). The codec rejects keys over 256 chars | Ids only (§7) |
| D12 | Binding caches to the bus | `cluster: true` registers the cache in a leaf registry (`clusterCacheRegistry.ts`, no imports, like `hotPathCacheRegistry.ts`). The bus is resolved **lazily, at publish time**, through `getClusterCacheBus()`, and `start()`/resync/receive look targets up in the registry by name. Registering a second cache under an existing name replaces the first and logs a warning | The eight caches are built at module load. Binding a bus at construction would make `__setClusterCacheBusForTests` useless for any test that imports a module that imports them, and throwing on duplicates would break `vi.resetModules()` re-imports. An explicit `cluster: { bus }` (integration tests only) bypasses the registry and attaches to that bus |
| D13 | Publish bound | `publish` races the Redis call against `CLUSTER_CACHE_PUBLISH_TIMEOUT_MS` (1 s) and returns `'failed'` on timeout | During a reconnect `getRedis()` still returns a client and commands sit in ioredis's offline queue; the rotation CLI awaits its publish and must not stall |
| D11 | KPI ≤60 CPU-ms/agent-min | Not gated by this PR | The KPI is measured by W07's dashboard on fixed hardware. Cross-instance invalidation does not change the per-beat CPU cost: it adds no read-path work. Task 13 records the statement budget as unchanged; the KPI is read when W07 lands |

## Metrics and logs

All series live in `services/clusterCacheMetrics.ts`. The `cache` label is a registered cache `name` (8 values) or `unknown`. No other label values come from a message.

| Series | Type | Labels | Meaning |
|---|---|---|---|
| `breeze_hot_path_cache_lookups_total` | Counter | `cache`, `result` = `hit` \| `miss` \| `bypass` | Hit rate per cache. `bypass` = a read inside a DB context (`getOrLoad`), or a `DeferredCacheFills.through` miss whose scope is not cacheable |
| `breeze_hot_path_cache_entries` | Gauge (collect) | `cache` | Current size, read at scrape time |
| `breeze_cluster_cache_invalidations_published_total` | Counter | `cache`, `outcome` = `published` \| `unavailable` \| `failed` | Writes that reached (or failed to reach) Redis |
| `breeze_cluster_cache_invalidations_received_total` | Counter | `cache`, `result` = `applied` \| `self` \| `unknown_cache` \| `malformed` | Messages handled by this instance |
| `breeze_cluster_cache_invalidation_lag_seconds` | Histogram | `cache` | `receivedAt − sentAt` for `applied` messages. Buckets: 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5. Cross-host clock skew shows up here; one host today |
| `breeze_cluster_cache_subscriber_up` | Gauge | — | 1 while subscribed |
| `breeze_cluster_cache_resyncs_total` | Counter | — | Reconnect resyncs (D6) |

Log lines, tag `[clusterCache]`, plain `console.*` like the rest of the API:
- `warn` once per state change: subscribe failed or timed out (with the error message); subscriber reconnected and resynced N caches.
- `warn` at most once per minute per `outcome`: publish `unavailable` or `failed`, with the cache name.
- `warn` when an applied message's lag exceeds 1 s (rate-limited to once per minute), because that breaks the spec's acceptance.
- Never log keys at `info`. Org ids are not secret, but there is no reason to spray them.

---

## Tasks

### Task 1: Metrics module

**Files:**
- Create: `apps/api/src/services/clusterCacheMetrics.ts`
- Create: `apps/api/src/services/clusterCacheMetrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import {
  recordCacheLookup,
  recordInvalidationPublished,
  recordInvalidationReceived,
  recordInvalidationLag,
  setSubscriberUp,
  recordResync,
  registerCacheSizeSource,
} from './clusterCacheMetrics';

describe('clusterCacheMetrics', () => {
  it('registers every series on the shared registry', async () => {
    recordCacheLookup('org-topology-flags', 'hit');
    recordInvalidationPublished('org-topology-flags', 'published');
    recordInvalidationReceived('org-topology-flags', 'applied');
    recordInvalidationLag('org-topology-flags', 0.02);
    setSubscriberUp(true);
    recordResync();
    registerCacheSizeSource('org-topology-flags', () => 7);
    const text = await metricsRegistry.metrics();
    for (const name of [
      'breeze_hot_path_cache_lookups_total',
      'breeze_hot_path_cache_entries',
      'breeze_cluster_cache_invalidations_published_total',
      'breeze_cluster_cache_invalidations_received_total',
      'breeze_cluster_cache_invalidation_lag_seconds',
      'breeze_cluster_cache_subscriber_up',
      'breeze_cluster_cache_resyncs_total',
    ]) expect(text).toContain(name);
    expect(text).toContain('breeze_hot_path_cache_entries{cache="org-topology-flags"} 7');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/clusterCacheMetrics.test.ts`
Expected: FAIL, cannot resolve `./clusterCacheMetrics`. 1 file.

- [ ] **Step 3: Implement**

```ts
// services/clusterCacheMetrics.ts — LEAF: prom-client + metricsRegistry only (worker closure contract).
import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from './metricsRegistry';

export type LookupResult = 'hit' | 'miss' | 'bypass';
export type PublishOutcome = 'published' | 'unavailable' | 'failed';
export type ReceiveResult = 'applied' | 'self' | 'unknown_cache' | 'malformed';

function existing<T>(name: string): T | undefined {
  return metricsRegistry.getSingleMetric(name) as T | undefined;
}

const lookups = existing<Counter<'cache' | 'result'>>('breeze_hot_path_cache_lookups_total') ?? new Counter({
  name: 'breeze_hot_path_cache_lookups_total',
  help: 'Hot-path cache lookups by result (hit, miss, bypass inside a DB context)',
  labelNames: ['cache', 'result'] as const,
  registers: [metricsRegistry],
});

const sizeSources = new Map<string, () => number>();
existing('breeze_hot_path_cache_entries') ?? new Gauge({
  name: 'breeze_hot_path_cache_entries',
  help: 'Entries currently held per hot-path cache',
  labelNames: ['cache'] as const,
  registers: [metricsRegistry],
  collect() {
    this.reset();
    for (const [cache, size] of sizeSources) this.set({ cache }, size());
  },
});

const published = existing<Counter<'cache' | 'outcome'>>('breeze_cluster_cache_invalidations_published_total') ?? new Counter({
  name: 'breeze_cluster_cache_invalidations_published_total',
  help: 'Cluster cache invalidations published, by outcome',
  labelNames: ['cache', 'outcome'] as const,
  registers: [metricsRegistry],
});

const received = existing<Counter<'cache' | 'result'>>('breeze_cluster_cache_invalidations_received_total') ?? new Counter({
  name: 'breeze_cluster_cache_invalidations_received_total',
  help: 'Cluster cache invalidation messages handled, by result',
  labelNames: ['cache', 'result'] as const,
  registers: [metricsRegistry],
});

const lag = existing<Histogram<'cache'>>('breeze_cluster_cache_invalidation_lag_seconds') ?? new Histogram({
  name: 'breeze_cluster_cache_invalidation_lag_seconds',
  help: 'Publish-to-apply lag of cluster cache invalidations',
  labelNames: ['cache'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

const subscriberUp = existing<Gauge>('breeze_cluster_cache_subscriber_up') ?? new Gauge({
  name: 'breeze_cluster_cache_subscriber_up',
  help: '1 while this process is subscribed to cluster cache invalidations',
  registers: [metricsRegistry],
});

const resyncs = existing<Counter>('breeze_cluster_cache_resyncs_total') ?? new Counter({
  name: 'breeze_cluster_cache_resyncs_total',
  help: 'Full local cache clears after a subscriber reconnect',
  registers: [metricsRegistry],
});

export function recordCacheLookup(cache: string, result: LookupResult): void { lookups.inc({ cache, result }); }
export function recordInvalidationPublished(cache: string, outcome: PublishOutcome): void { published.inc({ cache, outcome }); }
export function recordInvalidationReceived(cache: string, result: ReceiveResult): void { received.inc({ cache, result }); }
export function recordInvalidationLag(cache: string, seconds: number): void { lag.observe({ cache }, Math.max(0, seconds)); }
export function setSubscriberUp(up: boolean): void { subscriberUp.set(up ? 1 : 0); }
export function recordResync(): void { resyncs.inc(); }
export function registerCacheSizeSource(cache: string, size: () => number): void { sizeSources.set(cache, size); }
```

Check the `getSingleMetric` re-registration guard against how `middleware/agentAuthNegativeCache.ts:73-79` does it, and match that file's pattern exactly if it differs.

- [ ] **Step 4: Run the test and the worker-closure contract**

Run: `cd apps/api && npx vitest run src/services/clusterCacheMetrics.test.ts src/services/workerEntrypointClosure.contract.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
git add apps/api/src/services/clusterCacheMetrics.ts apps/api/src/services/clusterCacheMetrics.test.ts
git commit -m "feat(api): cluster cache metrics series (#8144)"
```

### Task 2: The cluster cache bus

**Files:**
- Create: `apps/api/src/services/clusterCacheRegistry.ts` (leaf, no imports: `registerClusterCache(target)` replacing by name with a `console.warn`, `clusterCacheTargets()`, `getClusterCacheTarget(name)`)
- Create: `apps/api/src/services/clusterCacheBus.ts`
- Create: `apps/api/src/services/clusterCacheBus.test.ts`

**Interfaces (produced; used by Tasks 3–5 and 10):**

```ts
export const CLUSTER_CACHE_CHANNEL = 'breeze:cluster-cache:invalidate';
export const CLUSTER_CACHE_SUBSCRIBE_TIMEOUT_MS = 1_000;
export const CLUSTER_CACHE_PUBLISH_TIMEOUT_MS = 1_000;
export const CLUSTER_CACHE_MAX_KEY_LENGTH = 256;

export interface ClusterInvalidationMessage {
  v: 1;
  cache: string;
  /** null = every key of that cache */
  key: string | null;
  origin: string;
  sentAtMs: number;
}

/** What the bus needs from a cache. HotPathTtlCache satisfies it. */
export interface ClusterCacheTarget {
  readonly name: string;
  invalidate(key?: string): void;
}

/** The subset of ioredis the bus uses, so tests can pass fakes. */
export interface PublisherLike { publish(channel: string, message: string): Promise<number> }
export interface SubscriberLike {
  on(event: 'message', fn: (channel: string, message: string) => void): unknown;
  on(event: 'ready' | 'end', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface ClusterCacheBusOptions {
  origin: string;
  getPublisher: () => PublisherLike | null;
  createSubscriber: () => SubscriberLike | null;
  subscribeTimeoutMs?: number;
  publishTimeoutMs?: number;
  now?: () => number;
  /** Where receive/resync find targets. Default: clusterCacheRegistry. */
  targets?: () => Iterable<ClusterCacheTarget>;
}

export type StartOutcome = 'subscribed' | 'unavailable' | 'timeout' | 'failed';
export type { PublishOutcome } from './clusterCacheMetrics'; // defined once, in the leaf metrics module

export class ClusterCacheBus {
  constructor(options: ClusterCacheBusOptions);
  /** Explicit targets (integration tests). Without any, the bus reads clusterCacheRegistry. Replaces by name. */
  attach(target: ClusterCacheTarget): void;
  publish(cache: string, key: string | null): Promise<PublishOutcome>; // never throws; bounded by CLUSTER_CACHE_PUBLISH_TIMEOUT_MS
  start(): Promise<StartOutcome>;                     // idempotent; never throws
  stop(): Promise<void>;
  readonly subscribed: boolean;
}

export function encodeInvalidation(m: ClusterInvalidationMessage): string;
export function decodeInvalidation(raw: string): ClusterInvalidationMessage | null;

/** Process default: origin INSTANCE_ID, publisher getRedis(), subscriber getRedis()?.duplicate({ connectionName: 'breeze:cluster-cache' }). */
export function getClusterCacheBus(): ClusterCacheBus;
export function __setClusterCacheBusForTests(bus: ClusterCacheBus | null): void;
```

- [ ] **Step 1: Write the failing unit tests**

Use a fake subscriber built on `node:events` `EventEmitter` (with `subscribe` resolving, and a switch to make it hang or reject), and a fake publisher that records calls or throws. Cover:

1. `decodeInvalidation` accepts a valid message and returns `null` for: bad JSON; `v !== 1`; missing or empty `cache`; `key` that is not a string or `null`; `key` longer than 256; missing `origin`; non-finite `sentAtMs`.
2. `publish` returns `'published'` and sends exactly `encodeInvalidation({ v: 1, cache, key, origin, sentAtMs: now() })` on `CLUSTER_CACHE_CHANNEL`.
3. `publish` returns `'unavailable'` when `getPublisher()` returns `null`, `'failed'` when `publish` rejects, and `'failed'` when `publish` never settles within `publishTimeoutMs` (fake timers); none throws.
4. A message from another origin calls `target.invalidate(key)` on the attached cache with that name, and `target.invalidate()` (no argument) for `key: null`.
5. A message from the bus's own origin does not call `invalidate`.
6. A message for an unattached cache name, and a malformed message, call nothing and do not throw.
7. `attach` twice with the same name replaces the first target (the second receives, the first does not).
8. `start()` resolves `'subscribed'` when `subscribe` resolves; `'unavailable'` when `createSubscriber()` returns `null`; `'failed'` when it rejects. When `subscribe` does not resolve within `subscribeTimeoutMs` (fake timers), `start()` resolves `'timeout'`, does **not** disconnect, and when the subscribe later resolves, `subscribed` becomes true and every target is invalidated once (D9). A later rejection of that pending subscribe raises no unhandled rejection. Calling `start()` twice returns the same promise.
9. **Resync (D6):**
   - The first `ready` (including one that fires while the first subscribe is still pending) clears nothing.
   - A second `ready` re-issues `subscribe`; with the fake `subscribe` resolving only after a deferred, no target is invalidated until it resolves, then each exactly once.
   - Two reconnects produce two clears.
   - After `stop()`, a late `ready` or `message` invalidates nothing (listeners removed).
10. A target whose `invalidate` throws does not stop delivery to the others on resync, and does not throw out of the `message` handler.
11. With no explicit `attach`, the bus finds targets through `clusterCacheRegistry` (register a target there, deliver a message, it is invalidated).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/clusterCacheBus.test.ts`
Expected: FAIL, cannot resolve `./clusterCacheBus`. 1 file.

- [ ] **Step 3: Implement**

Rules the implementation must keep:
- `publish` is `async` and wraps everything in `try/catch`. It records `recordInvalidationPublished(cache, outcome)` and logs `unavailable`/`failed` at most once per minute per outcome.
- The `message` handler checks `channel === CLUSTER_CACHE_CHANNEL`, decodes, and then: `null` → `recordInvalidationReceived('unknown', 'malformed')`; own origin → `'self'`; unknown cache → `recordInvalidationReceived('unknown', 'unknown_cache')`; otherwise call `target.invalidate(key ?? undefined)` inside `try/catch`, record `'applied'`, and record lag `(now() - sentAtMs) / 1000`. A lag over 1 s logs a rate-limited warning.
- `start()` registers the handlers **before** `subscribe`, then races `subscribe` against the timeout. Success: `setSubscriberUp(true)`. Rejection: disconnect, `subscriberUp` 0, log once, `'failed'`. Timeout: return `'timeout'`, log once, but leave the subscriber and its pending subscribe in place, with a `.catch` attached; when it resolves later, set `subscriberUp` 1 and run the resync (D9).
- `ready` handling (D6): the handler sets `seenReady` on the first event and returns. On every later `ready` it awaits `subscribe(CLUSTER_CACHE_CHANNEL)`, then calls `invalidate()` on every target, `recordResync()`, one log line. A failed re-subscribe logs and leaves `subscriberUp` 0. An `end` event sets `subscriberUp` to 0.
- `stop()` removes the bus's listeners before quitting, so nothing fires after shutdown.
- `getClusterCacheBus()` builds the default lazily. `createSubscriber` returns `getRedis()?.duplicate({ connectionName: 'breeze:cluster-cache' }) ?? null`, guarding `typeof redis.duplicate === 'function'` like `agentWs.ts:351`.
- `stop()` calls `quit()` on the subscriber (falling back to `disconnect()`), and resets `subscribed`.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/clusterCacheBus.test.ts`
Expected: PASS. 1 file.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
git add apps/api/src/services/clusterCacheBus.ts apps/api/src/services/clusterCacheBus.test.ts
git commit -m "feat(api): cluster cache invalidation bus over Redis pub/sub (#8144)"
```

### Task 3: The `cluster` option on `HotPathTtlCache`

**Files:**
- Modify: `apps/api/src/services/hotPathCache.ts`
- Modify: `apps/api/src/services/hotPathCache.test.ts`

**Interface change:**

```ts
export interface HotPathTtlCacheOptions {
  name: string;
  ttlMs: number;
  maxEntries: number;
  /**
   * W05 (#8144): also drop this cache's entries on every other API instance.
   * `true` registers in clusterCacheRegistry and publishes through getClusterCacheBus()
   * resolved at publish time (D12); `{ bus }` attaches to that bus (integration tests).
   * Keys must be strings (ids only).
   */
  cluster?: true | { bus: ClusterCacheBus };
}
```

Behaviour:
- Constructor: `cluster: true` → `registerClusterCache(this)` (leaf registry, D12); `cluster: { bus }` → `bus.attach(this)`. Every cache, cluster or not, calls `registerCacheSizeSource(name, () => this.size)`.
- `invalidate(key?)`: unchanged. **Local only.** The bus and the test reset registry call it.
- `invalidateAroundCommit(key?)`: first, for a cluster cache, if `key` is defined and not a string, log `[clusterCache] non-string key` and continue with `key = undefined` (whole cache; D10). Then the unchanged local behaviour, plus, for a cluster cache, `runAfterDbContextCommit(\`hotPathCache.${name}.publish\`, () => void resolveBus().publish(name, key ?? null))`, where `resolveBus()` is the explicit bus or `getClusterCacheBus()` at that moment.
- `getOrLoad`: `recordCacheLookup(name, 'bypass')` inside a DB context; `'hit'` on a live entry; `'miss'` before a load.
- `DeferredCacheFills.through`: `'hit'` on a `peek` hit; `'miss'` when the miss is cacheable, `'bypass'` when it is not.
- Update the class doc comment: replace "Invalidation is process-local: another API instance keeps its entry until the TTL expires" with the cluster rule, and add "A cluster cache publishes only from `invalidateAroundCommit`, and only after the outermost transaction commits".

- [ ] **Step 1: Write the failing tests**

Extend the `vi.mock('../db', …)` block with `runAfterDbContextCommit`. Inside a context it queues work on a separate `committed` list that the test flushes to model COMMIT, or discards to model ROLLBACK. Outside a context it runs at once. Then add a `describe('cluster option (W05)')`, with a fake bus that records `publish` calls (build a real `ClusterCacheBus` with a recording fake publisher and `createSubscriber: () => null`):

1. `invalidate('org-1')` on a cluster cache publishes nothing.
2. `invalidateAroundCommit('org-1')` outside a context publishes `('test-cluster', 'org-1')` once, and drops the local entry.
3. `invalidateAroundCommit()` publishes `key: null`.
4. Inside a context: no publish until the commit list is flushed; then exactly one. If the list is discarded (rollback), no publish ever, but the local entry is still dropped (unchanged behaviour).
5. A non-cluster cache never publishes.
6. `invalidateAroundCommit(42 as never)` on a cluster cache does not throw, clears the whole local cache, and publishes `key: null`.
7. A `cluster: true` cache publishes through whatever bus `__setClusterCacheBusForTests` installed **after** the cache was constructed (D12). Two `cluster: true` caches with the same name: the second replaces the first in the registry, no throw.
8. Lookup counters: a hit, a miss and an in-context bypass each move `breeze_hot_path_cache_lookups_total` for that cache name (read with `metricsRegistry.getSingleMetricAsString`).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/hotPathCache.test.ts`
Expected: the new cluster tests FAIL (no publish recorded, no throw); all existing tests PASS. 1 file.

- [ ] **Step 3: Implement** the behaviour above. Import `runAfterDbContextCommit` from `../db` alongside the existing imports.

- [ ] **Step 4: Run the tests**

Run: `cd apps/api && npx vitest run src/services/hotPathCache.test.ts`
Expected: PASS. 1 file.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"
git add apps/api/src/services/hotPathCache.ts apps/api/src/services/hotPathCache.test.ts
git commit -m "feat(api): HotPathTtlCache cluster option publishes after commit (#8144)"
```

### Task 4: Cross-instance integration test (the spec's acceptance)

**Files:**
- Create: `apps/api/src/__tests__/integration/clusterCache.integration.test.ts`

Two instances in one process: `busA` and `busB`, with origins `'inst-a'` and `'inst-b'`. Each has its own `new Redis(process.env.REDIS_URL!)` publisher and its own subscriber, created in `beforeEach` and quit in `afterEach`. Integration setup flushes Redis per test and resets hot-path caches (`__tests__/integration/setup.ts:389, 419`), so subscribe inside each test's `beforeEach`, never `beforeAll`. Each test builds `cacheA` and `cacheB`: two `HotPathTtlCache<string, string>` with the same unique name (`cc-it-${randomUUID()}`, because names must be unique per bus but each bus is new) and `cluster: { bus }`. Seed values with `getOrLoad`.

Helper: `async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<number>` polls every 10 ms and returns the elapsed ms, or throws on timeout. Never `sleep` a fixed time to prove a positive.

Ordering probe for the negative cases: to prove B did **not** receive something, publish a sentinel invalidation on a second key afterwards and wait until B applies it. Redis delivers one channel's messages in order, so anything published before the sentinel would already have arrived.

Tests:

1. **A write on A invalidates B within 1 s.** Seed `org-1` and `org-2` on both. `cacheA.invalidateAroundCommit('org-1')` outside any context. `waitUntil(() => cacheB.peek('org-1') === undefined, 1_000)` passes. `cacheB.peek('org-2')` is still `'v2'`.
2. **Whole-cache invalidation.** `cacheA.invalidateAroundCommit()` clears every key on B within 1 s.
3. **Publish waits for COMMIT.** Inside `withSystemDbAccessContext(async () => { … })`: call `cacheA.invalidateAroundCommit('org-1')`, then publish a sentinel straight through `busA.publish(name, 'sentinel')` and wait until B applies it, then assert `cacheB.peek('org-1')` is still defined (the queued publish has not run). After the context returns, `waitUntil` B drops `org-1` within 1 s.
4. **Rollback publishes nothing.** Same as 3, but the context throws after `invalidateAroundCommit`. After it rejects, send a sentinel and wait for it. Then `cacheB.peek('org-1')` is still defined.
5. **An in-flight load on B is not stored.** `cacheB.getOrLoad('org-3', loader)` where the loader awaits a deferred promise. While it waits, `cacheA.invalidateAroundCommit('org-3')`, and wait until `breeze_cluster_cache_invalidations_received_total{cache=name,result="applied"}` moves (or poll a test-only hook). Resolve the loader with `'stale'`. The `getOrLoad` call returns `'stale'` to its caller, and `cacheB.peek('org-3')` is `undefined`.
6. **Self-echo is ignored.** Wrap `cacheA.invalidate` and `cacheB.invalidate` in `vi.spyOn` before test 1's write. After B has applied it: `cacheB.invalidate` was called once with `'org-1'`; `cacheA.invalidate` was called only by A's own `invalidateAroundCommit` (twice: the immediate drop and the after-exit drop), never a third time from its own echo. Do not use the Prometheus series to tell A from B: both buses share one process registry and the same `cache` label.
7. **Reconnect resyncs.** Seed `org-1` on B. Force B's subscriber to drop and reconnect (`subscriberB.disconnect(true)`; ioredis reconnects and re-emits `ready`). `waitUntil` `cacheB.size === 0` within 5 s, and `breeze_cluster_cache_resyncs_total` moved.
8. **Degraded: Redis unavailable.** A bus whose `getPublisher` returns `null` and whose `createSubscriber` returns `null`: `start()` resolves `'unavailable'`; `invalidateAroundCommit('org-1')` on its cache drops the local entry, does not throw, and `published_total{outcome="unavailable"}` moved.
9. **Timing evidence.** Test 1 logs the measured elapsed ms with `console.info('[clusterCache.it] A→B invalidation ms=', ms)` so the PR can quote it.

- [ ] **Step 1: Write the tests** (they can only fail at this point if Tasks 2–3 are wrong; to prove the suite discriminates, run Step 2's mutation)

- [ ] **Step 2: Mutation reds (record each in the PR body)**

With the test stack up (`pnpm test-stack up`, then source its env file per `docs/agents/testing.md`):

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/clusterCache.integration.test.ts
```

Expected first: PASS, 1 file, 8 tests (item 9 is a log line inside test 1, not a test). Then make each mutation, run, see the named test fail, and revert:
- In `hotPathCache.ts`, publish with `runAfterDbContextExit` instead of `runAfterDbContextCommit` → test 4 fails.
- Publish synchronously inside `invalidateAroundCommit` (no defer) → test 3 fails.
- In the bus handler, replace `target.invalidate(key)` with a raw delete (expose a test-only `deleteEntry`, or temporarily call `invalidate` without bumping generation) → test 5 fails.
- Remove the resync on `ready` → test 7 fails.
- Drop the self-origin check → test 6 fails.

- [ ] **Step 3: Confirm CI coverage**

Run: `pnpm --filter=@breeze/api test:integration-suite-coverage`
Expected: PASS. The file is under `src/__tests__/integration/`, which `vitest.integration.config.ts` already includes, so CI's `integration-test` job runs it.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/clusterCache.integration.test.ts
git commit -m "test(api): cross-instance cluster cache invalidation within 1 s (#8144)"
```

### Task 5: Start and stop the subscriber with the API

**Files:**
- Modify: `apps/api/src/index.ts`
- Create: `apps/api/src/index.clusterCache.test.ts` (source-level mount test, like `index.agentAdmission.test.ts` in W08)

- [ ] **Step 1: Write the failing source-level test.** Read `index.ts` as text and assert: `getClusterCacheBus().start()` is awaited before `serve({` and after the Redis startup check; a shutdown phase named `cluster-cache-bus` calls `.stop()` inside the `runShutdownPhases([` list. Run `cd apps/api && npx vitest run src/index.clusterCache.test.ts`; expect FAIL. 1 file.
- [ ] **Step 2: Implement.** In the boot block, after the Redis availability check and before `serve(`: `const ccOutcome = await getClusterCacheBus().start();` and log `[clusterCache] subscriber ${ccOutcome}` once. `start()` is bounded by 1 s and never throws, so boot is never blocked longer than that. When `startupChecks.redisOk` is false, skip `start()` and log `unavailable`. Add a shutdown phase `{ name: 'cluster-cache-bus', run: () => getClusterCacheBus().stop() }` next to the other Redis consumers (before `closeRedis`). Do **not** start it from `worker.ts` (D8).
- [ ] **Step 3: Run the test.** Expected: PASS. Also run `cd apps/api && npx vitest run src/services/workerEntrypointClosure.contract.test.ts` (PASS; `worker.ts` is untouched).
- [ ] **Step 4: Typecheck and commit** (`feat(api): start the cluster cache subscriber at API boot (#8144)`).

### Tasks 6–11: Put each cache on the cluster bus

Each task below is the same shape:

1. **Red:** a unit test that installs a recording bus with `__setClusterCacheBusForTests(bus)`, runs the named writer path (or the invalidator function it calls), and asserts the exact `publish(cacheName, key)` call. Run it; it fails because the cache is not `cluster` yet, or the writer does not use `invalidateAroundCommit`.
2. **Green:** add `cluster: true` to the cache options, and switch the writer to `invalidateAroundCommit` where it is not already.
3. **Comment:** update the cache's doc comment. Replace "process-local invalidation only until W1b" and "other API instances … up to one TTL" with: "Writers below invalidate every API instance within about 1 s through the cluster bus (W05). Writers not listed rely on the TTL."
4. Run the test file plus `src/services/hotPathCache.test.ts`. Typecheck. Commit one cache per commit: `feat(api): cluster-invalidate <cache name> (#8144)`.

Construction-order note: `agentOrgSettingsCache.ts` and `manifestSigning.ts` build their caches at module load. Because `cluster: true` resolves the bus at publish time (D12), a test can install its recording bus with `__setClusterCacheBusForTests(bus)` in `beforeEach`, after the imports, and reset it with `null` in `afterEach`.

**Commit-ordering check (every task below, and Task 12).** "Publish only after commit" holds only when the invalidator runs inside a DB context opened by `withDbAccessContext`/`withSystemDbAccessContext`, or after the write's context has already exited. `runAfterDbContextCommit` runs at once when no context is held, so a call inside a bare `db.transaction(...)` or a self-managed route **before** its commit would publish pre-commit. For each publishing writer: confirm which of the two cases it is (record it in the task's commit message), and add one unit assertion: an in-context writer's publish appears only after the modelled commit; an outside-context writer's publish is ordered after the write call. If a writer is neither, move its invalidator after the commit.

#### Task 6: C1 `orgAgentUpdateConfigCache` (spec: per-org update config)

- **Files:** `apps/api/src/services/agentOrgSettingsCache.ts`; create `apps/api/src/services/agentOrgSettingsCache.test.ts`.
- **Trigger (publishing write paths):** `invalidateAgentOrgSettingsCaches(orgId?)`, already called from `routes/orgs.ts:1379` (`PATCH /partners/me`, `key: null`), `:1569` (partner settings, `key: null`) and `:2858` (org update, `key: orgId`). It already uses `invalidateAroundCommit`, so the only change is `cluster: true`.
- **Tests:** `invalidateAgentOrgSettingsCaches('org-1')` publishes `('org-agent-update-config', 'org-1')`; `invalidateAgentOrgSettingsCaches()` publishes `('org-agent-update-config', null)`.

#### Task 7: C2 `orgTopologyFlagsCache` (spec: topology flags)

- **Files:** as Task 6.
- **Trigger:** the same `invalidateAgentOrgSettingsCaches` calls. Topology flags come from `topologyFeatureFlags` in org and partner `settings`.
- **Tests:** the same two cases, for `'org-topology-flags'`.

#### Task 8: C3 `orgHelperSettingsCache`

- **Files:** as Task 6.
- **Triggers:** `invalidateOrgHelperSettingsCache(orgId)` from `PATCH /agents/org/:orgId/settings/helper` (`routes/agents/mtls.ts:1790`), and `invalidateAgentOrgSettingsCaches`.
- **Tests:** `invalidateOrgHelperSettingsCache('org-1')` publishes `('org-helper-legacy-settings', 'org-1')`; `invalidateAgentOrgSettingsCaches()` publishes `('org-helper-legacy-settings', null)`.

#### Task 9: C4 `orgPolicyProbeCache`, plus the org-merge gap

- **Files:** as Task 6; plus `apps/api/src/services/orgMerge.ts` and its test.
- **Triggers:**
  - `invalidateOrgPolicyProbeCache(orgId?)` from `POST /policies/:id/deactivate` (`routes/policyManagement/actions.ts:92`; `key: null` for a partner-wide policy).
  - **New:** org merge re-points `automation_policies` (`orgMergeRegistry.ts:776`), `unifi_collectors` and devices from the loser org to the survivor, and keeps the survivor's `pam_org_config` (`:499`, `keep-survivor`). It already calls `invalidateAgentTenantCache([loser.id])` (`orgMerge.ts:515`, a different cache) but none of the hot-path caches. Step 0: confirm those registry rows, then find the repoint transaction: `executeOrgMerge` (`orgMerge.ts:1116`), whose `withSystemDbAccessContext` opens at `:1164` and calls `runPolicy` at `:1238` (at `6859e6f749`). At the end of that callback, after the repoint, call for both `loserId` and `survivorId`: `invalidateAgentOrgSettingsCaches(id)` (C1–C3), `invalidateOrgPolicyProbeCache(id)` (C4) and `invalidateOrgPamFallbackCache(id)` (C5; Task 10 adds the helper, so do Task 10 first or add it here); plus `agentCollectorAbsenceCache.invalidateAroundCommit()` once (C8, whole cache: a merge turns loser-org keys into survivor-org keys). Because they use `invalidateAroundCommit`, the publishes run only if the merge commits.
- **Tests:** `invalidateOrgPolicyProbeCache('org-1')` publishes `('org-policy-probe', 'org-1')`, and with no argument publishes `null`. In the orgMerge unit test (it already mocks `dbModule.withSystemDbAccessContext`), assert the invalidator calls above happen inside the repoint transaction's callback (spy on the exports of `agentOrgSettingsCache` and on `agentCollectorAbsenceCache.invalidateAroundCommit`).

#### Task 10: C5 `orgPamFallbackCache` (no writer today)

- **Files:** as Task 6.
- **Trigger:** none exists. No route writes `pam_org_config.uac_interception_enabled`. Add `export function invalidateOrgPamFallbackCache(orgId: string): void { orgPamFallbackCache.invalidateAroundCommit(orgId); }` and change the comment's "A future writer must call `orgPamFallbackCache.invalidateAroundCommit(orgId)`" to name this helper.
- **Tests:** `invalidateOrgPamFallbackCache('org-1')` publishes `('org-pam-fallback', 'org-1')`.

#### Task 11: C6 `trustKeysetCache` and C7 `delegationRowsCache` (spec: trust keyset, delegations), plus the rotation CLI

These two caches have one invalidator and one out-of-process writer, so they share a task. Each gets its own test case and its own commit.

- **Files:** `apps/api/src/services/manifestSigning.ts` (+ its test); `apps/api/scripts/manifest-key-rotation.ts`.
- **Triggers:**
  - `invalidateManifestTrustCaches()` from `ensureActiveSigningKey` (`manifestSigning.ts:173`). Change its body from `invalidate()` to `invalidateAroundCommit()` on both caches, which publishes `('manifest-trust-keyset', null)` and `('manifest-key-delegations', null)`. `null` because the keys are fixed literals and a whole-cache drop is the same thing.
  - **New:** the rotation CLI. After `insertPreparedRotation`'s transaction commits (and after the activation update at `:448-456`), publish both invalidations with a one-shot publisher: `getClusterCacheBus().publish(...)` for each, `await`ed, then `closeRedis()`. If the outcome is not `'published'`, print `Could not notify running API instances (Redis <outcome>); they pick up the new key within 60 s` and exit 0. The rotation itself succeeded; only the fast path did not.
- **Tests:** `invalidateManifestTrustCaches()` publishes both names with `null`. For the CLI, extract the publish into an exported `notifyTrustCachesChanged()` in `manifestSigning.ts` (so the CLI test is a plain unit test) and assert it publishes both and returns the outcomes.

#### Task 11b: C8 `agentCollectorAbsenceCache`

- **Files:** `apps/api/src/services/unifi/unifiCollectorService.ts` (+ its test).
- **Triggers:** `upsertCollector` (`:125`) and `upsertSelfHostedController` (`:173`) already call `invalidateAroundCommit(agentCollectorAbsenceKey(deviceId, orgId))`. Add `cluster: true`. Deletes still need no invalidation: they only make "none" truer.
- **Tests:** an `upsertCollector` call (with the existing mocks) publishes `('unifi-agent-collector-absence', '<orgId>:<deviceId>')`.

### Task 12: Settings-writer ratchet

**Files:**
- Create: `apps/api/src/__tests__/orgSettingsWriters.contract.test.ts`

C1–C3 are derived from `organizations.settings` and `partners.settings`. 28 non-test files run `.update(organizations)` or `.update(partners)` [V, grep at `6859e6f749`]. Most write other columns or other `settings` keys. Auditing them by judgment once does not stop the next one.

- [ ] **Step 1: Write the test.** Walk `apps/api/src` and `apps/api/scripts` (skip `*.test.ts` and `__tests__/`). Collect every file matching `/\.update\(\s*(organizations|partners)\b/` (whitespace and newlines allowed) **or** raw SQL `/UPDATE\s+(organizations|partners)\b/i`. Expect about 28 at `6859e6f749`; a multiline grep also hit `services/orgImport/index.ts`, so classify whatever the walk returns. Compare against a classified allowlist in the test:

```ts
type Classification =
  | { kind: 'invalidates'; via: string }            // calls invalidateAgentOrgSettingsCaches / invalidateOrgHelperSettingsCache
  | { kind: 'no-agent-settings'; reason: string };  // writes no agentUpdatePolicy / maintenanceWindow / version pins / topologyFeatureFlags / helper key

const WRITERS: Record<string, Classification> = {
  'src/routes/orgs.ts': { kind: 'invalidates', via: 'invalidateAgentOrgSettingsCaches' },
  'src/routes/agents/mtls.ts': { kind: 'invalidates', via: 'invalidateOrgHelperSettingsCache' },
  // … one row per file, filled in Step 2
};
```

Assert: (a) the set of matching files equals the allowlist's keys (a new writer fails with "classify <file> in orgSettingsWriters.contract.test.ts"); (b) every `invalidates` file's source contains a call `${via}(`, not just the name (an import alone does not count).

- [ ] **Step 2: Classify.** Run it; it fails listing every unclassified file. Open each one and classify it. A file that **does** write one of the agent-relevant `settings` keys and does not invalidate is a bug: add `invalidateAgentOrgSettingsCaches(orgId)` inside a held DB context (`withDbAccessContext`/`withSystemDbAccessContext`, not a bare `db.transaction`) or after its commit (see the commit-ordering check above), classify it `invalidates`, and list it in the PR body. Expected candidates to check carefully: `services/partnerActivation.ts`, `routes/agents/enrollment.ts:801`, `modules/mcpInvites/tools/configureDefaults.ts:91`, `services/orgArchive.ts`, `services/tenantOffboarding.ts`.
- [ ] **Step 3: Mutation red.** Add a dummy `.update(organizations)` line to a scratch copy of an allowlisted-free file under `src/`, run, see the failure name it, delete it.
- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/__tests__/orgSettingsWriters.contract.test.ts` (PASS, 1 file), typecheck, commit (`test(api): ratchet org/partner settings writers onto the cache invalidators (#8144)`).

### Task 13: Docs, the budget suite and the full pre-PR suites

- [ ] **Step 1: Docs.** In `apps/docs/src/content/docs/monitoring/stack.mdx`, append a `## Hot-path cache` section: the seven series from "Metrics and logs", one line on what a healthy instance shows (`subscriber_up 1`, lag p99 well under 1 s, `published{outcome="failed"}` flat), and that without Redis the caches fall back to their TTL. No hostnames or IPs. Also update the `HotPathTtlCache` doc comment (Task 3) if it was missed.
- [ ] **Step 2: Statement budget unchanged.**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts
```

Expected: PASS with **no edit** to its assertions (steady ≤15 statements at `:824`, warm 14 at `:828`, `ROUTE_ONLY_STEADY_HEARTBEAT_TX = 2`). The cluster layer adds Redis work on writes only.

- [ ] **Step 3: Affected unit suites** (small batches; the host may be loaded):

```bash
cd apps/api && npx vitest run src/services/clusterCacheMetrics.test.ts src/services/clusterCacheBus.test.ts src/services/hotPathCache.test.ts
cd apps/api && npx vitest run src/services/agentOrgSettingsCache.test.ts src/services/manifestSigning.test.ts src/services/unifi/unifiCollectorService.test.ts src/services/orgMerge.test.ts
cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts src/routes/orgs src/routes/policyManagement/actions.test.ts src/index.clusterCache.test.ts src/__tests__/orgSettingsWriters.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts
```

Check every reported file count against the list.

- [ ] **Step 4: Integration suites that read these caches.**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/clusterCache.integration.test.ts src/__tests__/integration/topologyUnifiRoute.integration.test.ts src/__tests__/integration/devicePolicySet.integration.test.ts
```

- [ ] **Step 5: Full API unit suite and typecheck.** `pnpm --filter=@breeze/api test` (read the summary, not just the exit code) and `cd apps/api && npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`.
- [ ] **Step 6:** `pnpm test-stack down`. Commit docs (`docs(monitoring): hot-path cache and cluster invalidation metrics (#8144)`).

## Acceptance (W05)

| Spec / program requirement | Evidence |
|---|---|
| Write on A invalidates B within 1 s | Task 4 test 1 (measured ms logged), run in CI's `integration-test` job |
| Ids only, receiver reloads under its own context | Task 2 codec (no value field); Task 4 test 5 (the receiver only drops) |
| Trust keyset, delegations, per-org update config, topology flags on the primitive | Tasks 11, 6, 7 |
| The other #8128 / W01 / W03 hot-path caches migrated | Tasks 8, 9, 10, 11b |
| Safe degradation without Redis | Task 2 (`unavailable`, `timeout`), Task 4 test 8, D9 |
| Bounded size | Unchanged `maxEntries` FIFO bound, plus `breeze_hot_path_cache_entries` |
| Hit rate and invalidation lag observable | Task 1 series; Task 3 counters |
| No new statements on the heartbeat | Task 13 Step 2 |
| KPI ≤60 CPU-ms/agent-min | Not gated here (D11). Read from W07 once it lands; note the value in #8144 |

## PR

- Title: `feat(api): cluster cache — Redis pub/sub invalidation for the hot-path caches (#8144)`.
- Body: `Closes #8144`; the design table condensed; the Task 4 timing line and mutation reds; the Task 12 list of writers that gained an invalidator; a `## Merge Danger` section (below).
- Review: `/pr-review-toolkit:review-pr`, one round. Include `silent-failure-hunter` (the bus swallows Redis errors by design; the reviewer should confirm each swallow is counted and logged).
- Merge through the queue with `gh pr merge <N>`. Never `--admin`.

**Merge Danger (for the implementation PR):**
- **Door:** two-way. Revert the PR. No schema, no data, no agent change, no env var. With one API instance (today's topology) the only visible change is metrics plus one extra Redis connection.
- **Worker processes** do not subscribe (D8); any cache read there stays TTL-only, as today.
- **Blast radius:** freshness of heartbeat-delivered config (update policy, topology flags, helper flag, policy probe, PAM fallback, trust keyset, delegations, collector absence) on every API instance. Failure modes: subscriber down → today's TTL-only behaviour; a publish that ran before commit → a stale value for one TTL on other instances (guarded by Task 4 tests 3–4); a boot that waits on Redis → bounded at 1 s (Task 5).

## Rollout

Server-side only; ships with the next API release. No flag. After deploy, on each region's `/metrics/scrape`: `breeze_cluster_cache_subscriber_up 1`; `breeze_cluster_cache_invalidations_published_total{outcome="published"}` moves when an operator edits org or partner settings; `received_total{result="self"}` moves with it (one instance today); `resyncs_total` stays flat outside Redis restarts. Rollback: revert and redeploy.

## Follow-ups to file at merge (not in this wave)

1. Spec W4: classify the other per-process caches (`agentAuthNegativeCache`, partner scope-policy and allowlist caches, module-level `Map`s) and move the cluster-unsafe ones onto `cluster: true`.
2. With W07 hit-rate data, revisit the TTLs. With cross-instance invalidation, the 60 s TTLs on C1–C4 and C6–C7 are now a backstop for writers outside the ratchet, and could be longer.
3. If production shows the subscriber failing (not timing out) at boot, retry `start()` when Redis recovers (the boot sequence's existing "Redis came back" hook, `index.ts` ~405-430). A timeout already recovers on its own (D9).
4. #8257 (device-keyed Redis policy caches bound to org) stays open and separate.
5. Check whether any `BREEZE_ROLE=worker` code path reads C1–C8 (for example via `manifestSigning`). If one does, start the subscriber from `worker.ts` too.

## Self-review

**Spec coverage (W1b).** In-process TTL: existing `HotPathTtlCache`. Redis pub/sub by key, ids only: Tasks 2–3. Trust keyset, delegations, per-org update config, topology flags: Tasks 11, 6, 7. A→B within 1 s: Task 4. KPI: D11. Program row: "migrate the #8128 hot-path caches": Tasks 6–11b. Dispatch asks: get/set with TTL, `invalidate(id)` publishing, subscriber dropping local entries, degradation, bounded size (Tasks 2–3); one task per cache with its trigger (Tasks 6–11b); cross-instance test and CI job (Task 4); metrics and logs (Task 1, "Metrics and logs"); no new settings (Global Constraints); Merge Danger and file ownership (above).

**Placeholder scan.** No TBD. Two "verify, then adapt" points: the metric re-registration guard (Task 1 Step 3, match `agentAuthNegativeCache.ts`), and the exact org-merge transaction to hook (Task 9 Step 0 grep). Task 12 Step 2's classification is deliberately left to the executor with the file list in hand; the test, not judgment, decides completeness.

**Type consistency.** `ClusterCacheTarget.invalidate(key?: string)` matches `HotPathTtlCache<string, V>.invalidate(key?: K)`. `PublishOutcome` is defined once, in `clusterCacheMetrics.ts`, and re-exported by the bus.
