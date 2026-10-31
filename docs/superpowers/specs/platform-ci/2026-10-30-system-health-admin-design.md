# System Health: native platform-admin health tab (design)

**Date:** 2026-10-30 · **Status:** draft for maintainer review (not approved for implementation) · **Origin:** [Discussion #10764](https://github.com/LanternOps/breeze/discussions/10764), [Todd's direction](https://github.com/LanternOps/breeze/discussions/10764#discussioncomment-19302403) · **Prior art:** [System page #6768](https://github.com/LanternOps/breeze/issues/6768), `docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md`

> **Decision boundary.** Todd accepted the direction for a platform-admin Health tab, not this detailed spec. The design choices below are proposals for review. This document intentionally excludes the Customer Portal altogether, at the proposer's request; it neither specifies nor reserves a portal wave.

## 1. Why

Breeze already has process liveness, dependency/consumer readiness, selected job heartbeats, BullMQ queue counters, and an optional Prometheus/Grafana observability overlay. There is no unified platform-admin **operational health** view in the native System page. Operators must inspect several sources to distinguish a living HTTP process from a runnable service, a stale scheduled job, or a queue with a growing backlog.

The existing `/admin/system` **Connections** tab shows what is *configured* (not whether the service answers), and **Deprecations** addresses another concern. **Health** must remain separate from both: it answers what the Breeze deployment can presently do, and whether the supporting observations are fresh.

**Goals**

1. Give **platform administrators** a fast, read-only, in-product view of the Breeze platform's operational condition.
2. Reuse canonical in-process readiness and shared operational signals; do not build another monitoring engine.
3. Surface **API readiness, PostgreSQL, Redis, required consumer readiness, supported queue depths, and supported scheduled-job heartbeats**.
4. Represent partial failures honestly: `unknown` is different from `unavailable`, and an intentionally disabled capability is not an incident.
5. Preserve the distinction between **the responding API process** and **shared deployment-level observations**, especially in multi-replica/worker-split topologies.
6. Work without the optional monitoring overlay.

**Non-goals**

- Customer Portal, customer status pages, any per-`orgId` publication setting, portal API, white-label status, or external/public uptime page. **No portal work is proposed, including as a later wave of this design.**
- Managed-device, agent fleet, customer network, site, or endpoint health.
- Host CPU/RAM/disk, Prometheus integration, Grafana visualization, logs, Sentry, or advanced performance analytics.
- AI diagnosis/recommendations, remediation, process restarts, job retries, queue manipulation, or incident/SLA management.
- Independently monitoring an API outage while the very API serving this screen is unreachable.
- Discovering all API replicas or introducing cluster-wide process-health aggregation in the MVP.

## 2. Verified foundations and approved direction

| Source | Confirmed behavior / relevance |
|---|---|
| `apps/web/src/components/admin/system/SystemPage.tsx` and `apps/web/src/pages/admin/system.astro` | Existing `/admin/system` page with Connections/Deprecations tabs and query-parameter tab selection. |
| `apps/api/src/routes/admin/index.ts` | `adminRoutes.use('*', platformAdminMiddleware)`; System routes are mounted underneath it. |
| `apps/api/src/routes/admin/systemConnectionHealth.ts` | Read-only, platform-admin-only, Redis-backed job health; Redis failure is represented in response rather than a generic HTTP 500. |
| `apps/api/src/services/connectionHealth/heartbeat.ts` | Reconciler/digest heartbeat timestamps, stale/missing states, per-kind last success and failure streak; Redis `mget` failure produces a partial status. |
| `apps/api/src/services/readiness.ts` and `apps/api/src/index.ts` | Cached, single-flight, timeout-bounded readiness evaluator for DB, Redis, and required consumers; `/ready` and `/health/ready` share its handler; `/health` is liveness only. |
| `apps/api/src/jobs/m365SyncWorker.ts` and `apps/api/src/jobs/eventDispatchWorker.ts` | Existing `getJobCounts` usage; queue state categories and semantics differ by queue. |
| `docs/operations/health-probes.md` | API and optional split worker have different readiness roles; a replying API replica does not establish another replica's status. |
| `docker-compose.monitoring.yml` | Optional observability overlay; its presence is not a prerequisite for native readiness. |

**Maintainer-confirmed, Discussion #10764:** locate the tab at `/admin/system`; follow `systemConnectionHealth.ts` authorization and partial-failure pattern; use existing API-visible signals without requiring a Prometheus client; MVP covers API readiness, PostgreSQL, Redis, queue depth, and job heartbeats; exclude host capacity; identify local versus shared signals. Todd deferred the portal direction; this document goes further by **explicitly removing the portal from this feature's scope**, as requested by the proposer. This exclusion is a project proposal, not a separate maintainer approval.

## 3. Decisions proposed for approval

| ID | Decision |
|---|---|
| D1 | **One home:** add **Health** as a third tab to `/admin/system`; preserve Connections and Deprecations. No additional global navigation item. |
| D2 | **Platform-admin only:** the API is mounted via `adminRoutes.route('/system', ...)`, not directly on the root API; existing `platformAdminMiddleware` remains the gate. |
| D3 | **Read-only:** GET only; no mutation, service controls, retries, or new permissions. |
| D4 | **Prometheus-independent:** basic Health is available even when `ENABLE_MONITORING=false`, Prometheus/Grafana are absent, or the optional overlay is down. |
| D5 | **Reuse readiness:** consume the existing evaluator/its snapshot through a shared internal seam; do not call the public `/health/ready` endpoint over HTTP or duplicate DB/Redis probes. |
| D6 | **Bounded degradation:** when Redis or a queue/heartbeat read fails, return other available components and mark affected observations unknown; no blanket 500 for a dependency outage. |
| D7 | **Truthful status:** fresh evidence is required for `operational`; missing/stale/unreadable evidence is `unknown`; disabled optional functionality is `disabled`, not broken. |
| D8 | **Local vs shared:** every observation carries `scope: 'process' | 'shared'`; process-local readiness is never labeled fleet-/cluster-wide. |
| D9 | **Curated coverage:** initially include only explicit queue/job descriptors with known configuration and observability semantics; no blind iteration over all BullMQ queues. |
| D10 | **No global queue threshold:** use existing domain thresholds where justified; an occupied queue, delayed job, or missing optional queue is not automatically degraded. |
| D11 | **No new persistence:** prefer existing read models/Redis keys; new tables, migrations, and monitoring infrastructure are not part of the MVP. |
| D12 | **Do not change probe contracts:** existing `/health`, `/ready`, `/health/ready`, and connection-health status route remain behaviorally compatible. |
| D13 | **No customer scope:** no Portal UI/API, customer organization selector, `portal_branding` field, visibility flag, or tenant-specific data in the report. |
| D14 | **No secret-bearing payload:** no credentials, connection strings, queue payloads, internal hostnames/IPs, raw logs, or exception messages in the JSON/UI. |
| D15 | **Native UI:** i18n and existing System-page tab state patterns; fresh/stale/partial-data presentation, manual refresh, bounded background polling. |
| D16 | **Truthful availability:** if the serving API fails completely, the admin tab may be unreachable; this is not an external availability service. |

## 4. Status vocabulary and evaluation

### 4.1 Distinct states

| State | Meaning | Permitted evidence |
|---|---|---|
| `operational` | A current authoritative observation indicates normal operation | Successful readiness/dependency probe; eligible heartbeat within its known cadence |
| `degraded` | Function remains possible but an established domain health criterion fails | An existing meaningful backlog/failure criterion, or partial required processing impairment |
| `unavailable` | An explicitly required capability is confirmed unable to perform its function | Failed dependency readiness or confirmed required consumer failure |
| `unknown` | No trustworthy current verdict is available | Missing/stale heartbeat, timed-out collection, unreachable monitoring source, non-authoritative replica view |
| `disabled` | The optional capability is intentionally turned off | Existing authoritative feature/role flag |

An optional capability **not deployed for this role** should be omitted or marked disabled with a clear reason; it must not become a red component. No `unavailable` status may be inferred solely from a nonexistent optional target.

### 4.2 Overall verdict (proposal)

Aggregate only **applicable, required** capabilities with evidence relevant to the represented scope.

1. A confirmed required dependency/consumer failure makes the **responding process** not ready. Display this clearly; do not assert that every API replica or all Breeze features are down.
2. A confirmed impairment which does not prove an entire capability unavailable is `degraded`.
3. If all required checks pass but a required observation is missing/stale, the overall verdict is `unknown` (or an explicitly labeled *partial coverage* verdict; do not silently promote to operational).
4. `operational` requires fresh successful observations for every required signal **within that verdict's defined scope**.
5. Optional disabled components do not penalize overall health.

**Open design decision:** whether to expose a single top-level verdict at all, given that process-local readiness and shared queues represent different scopes. Safer default: display **"Responding API process"** readiness and an independent **"Background processing"** summary rather than a misleading deployment-wide green banner. If a combined label is retained, name its coverage and limitations.

### 4.3 Freshness

- Reuse `checkedAt` from readiness; do not replace it with response-render time.
- Reuse heartbeat cadence/TTL and existing `stale`/`missing` semantics from `connectionHealth/heartbeat.ts`.
- Every derived queue/job read should have a time of observation and a timeout/failure state.
- Do not invent success when a Redis read yields no value or errors.
- Never apply a generic one-minute heartbeat timeout to jobs with different schedules.

## 5. Components and data acquisition

### 5.1 Existing readiness as the base

`createReadinessEvaluator` already implements bounded probes, caching, single-flight, worker registration and invalidation. The new admin service should consume the same evaluator instance (or an internal, injected read-only adapter exposing its snapshot) used by `/health/ready`.

**Do not instantiate a second evaluator or invoke public HTTP readiness from within the API.** In particular, avoid a second DB `SELECT 1` + Redis `PING` per admin refresh.

Proposed process-local cards:

- **API readiness:** `ready` and source timestamp for the process that answered.
- **PostgreSQL:** `db` readiness result from that process.
- **Redis:** `redis` readiness result from that process.
- **Required consumers:** readiness summary based on existing registry and required/optional flags; do not expose raw errors/queue names by default.
- **API role:** communicate that results reflect the process role (`api`, `worker`, or combined), without claiming another process was inspected.

The existing public readiness response intentionally provides aggregated consumer counts, not consumer names. The admin health read may reuse those counts; any more detailed diagnostics require a separate, security-reviewed explicit allowlist.

### 5.2 Queue depth: explicit bounded registry

Start from queues whose state can be read safely with existing BullMQ queue instances and known semantics. `m365SyncWorker.ts` counts `waiting`, `prioritized`, `delayed`, `active` for its workload, while `eventDispatchWorker.ts` uses its own categories.

**Proposed per-queue adapter contract:**

- stable ID and admin-facing localized label;
- optional configuration/role predicate (active vs disabled vs absent);
- read-only, bounded count retrieval;
- explicit named categories (`waiting`, `prioritized`, `delayed`, `active`, `paused` only if meaningful for that queue);
- domain-defined severity mapping **only where currently justified**;
- `checkedAt`, `scope: 'shared'`, and `status`.

Avoid interpreting `delayed` as overdue: BullMQ delayed tasks can be scheduled intentionally. Avoid a generic global backlog threshold. If no reliable thresholds exist for a queue, show counts with `status: 'unknown'` for performance/degradation rather than fabricate a healthy/degraded verdict. Collection failure should preserve other queues and dependencies.

**Open inventory for implementation planning:** name the exact initial queues, map their existing queue getters, feature flags, and category/threshold semantics. This spec does not claim every Breeze queue is observable or that a uniform backlog threshold exists.

### 5.3 Scheduled-job heartbeats

Reuse `readConnectionHealthJobStatus()` and its existing reconciler/digest/per-kind freshness rules as the first authoritative heartbeat source. Do not create another heartbeat framework for the same jobs.

Report for known, supported jobs:

- stable ID and admin-facing label;
- schedule or known expected cadence (if authoritative);
- last run / last success where already stored;
- `ok`, `stale`, `missing` and `failing` source states mapped carefully to the UI vocabulary;
- `scope: 'shared'` when heartbeat storage is shared.

A stale/missing heartbeat normally means **unknown/not observed**, not proof that the entire API is unavailable. A known positive failure streak may justify degraded/failing status within that job's defined scope. Disabled/unscheduled jobs must be excluded from failure counts.

**Open inventory:** determine which additional jobs (if any) have authoritative heartbeat data. Adding heartbeat writers requires separate explicit justification and tests; no blanket instrumentation of all background workers.

### 5.4 Multiple replicas and split worker

- **Process-local:** the responding API replica's readiness snapshot, local required consumers, initialization/shutdown state.
- **Shared:** queue depths and Redis-backed heartbeats, subject to their own freshness and configuration checks.
- A successful request to one replica **does not establish the readiness of every API replica**.
- In a split deployment, API-role readiness does not imply worker-role readiness; do not label split-worker health as checked unless there is an authoritative signal for it.
- No cluster-wide replica discovery/aggregation is required. If only local readiness exists, label it precisely and mark other roles not observed rather than assuming green.

## 6. API design

### 6.1 Route and authorization

**Proposed:** `GET /api/v1/admin/system/health`.

Mount a new router under `adminRoutes.route('/system', ...)` in `apps/api/src/routes/admin/index.ts`, *after* `adminRoutes.use('*', platformAdminMiddleware)`. Do **not** mount a top-level `api.route('/admin/...')` in `apps/api/src/index.ts`.

- No session: 401.
- Partner admin / organization user: 403.
- Platform admin: 200 with partial results if necessary.
- Other verbs: 404.
- `Cache-Control: no-store`.
- No tenant identifiers or user-controlled `orgId` parameter.
- Only allowlisted, bounded observations, no arbitrary metric/job/queue lookup.

### 6.2 Response shape (proposed, not yet a frozen contract)

```ts
type HealthState = 'operational' | 'degraded' | 'unavailable' | 'unknown' | 'disabled';
type HealthScope = 'process' | 'shared';
type HealthObservation = {
  id: string;
  status: HealthState;
  scope: HealthScope;
  checkedAt: string | null;
  detailCode?: string; // stable, allowlisted reason for i18n; never raw exceptions
};

type SystemHealthResponse = {
  data: {
    generatedAt: string; // response creation time, not proof of freshness
    process: {
      readiness: HealthObservation;
      database: HealthObservation;
      redis: HealthObservation;
      requiredConsumers: HealthObservation & {
        required: number | null;
        runnable: number | null;
        unavailable: number | null;
      };
    };
    queues: Array<HealthObservation & {
      counts: Partial<Record<'waiting' | 'prioritized' | 'delayed' | 'active' | 'paused', number>>;
    }>;
    jobs: Array<HealthObservation & {
      lastRunAt: string | null;
      failureStreak?: number;
    }>;
  };
};
```

Example shapes are illustrative. The implementation plan must settle how missing data maps to nullable values, which queue states are reported, and how source states map to the summary; do not promise a complete cluster-wide overall state.

### 6.3 Failure isolation and read budget

- An exception in one queue/job adapter must not discard successfully read API/PostgreSQL/Redis results.
- Redis unavailable: return appropriate DB/Redis readiness and mark Redis-backed queue/heartbeat observations `unknown` (or unobserved); **do not transform this into generic HTTP 500**.
- Probe and queue reads must be bounded and share existing read paths/caches where available. No unbounded `Promise.all` of every registered queue, and no arbitrary admin-specified queue names.
- The health endpoint must not block readiness or alter the existing application admission gate.
- Preserve distinct `generatedAt`, source `checkedAt`, and stale semantics.

## 7. Web design

Extend `apps/web/src/components/admin/system/SystemPage.tsx` and the existing server-side tab parser at `apps/web/src/pages/admin/system.astro`.

**Tabs:** Connections (existing default), Deprecations, **Health**. Proposed deep link: `/admin/system?tab=health`. Keep SSR and hydration tab state aligned with the existing implementation; do not replace this page's established query-param pattern with a new URL convention.

**Suggested sections:**

1. **API process readiness** — clear title limiting the result to the responding instance, and fresh timestamp.
2. **Dependencies and required consumers** — PostgreSQL, Redis, consumer counts and truthful state badges.
3. **Background work** — supported queues and jobs; depths, last-run times, optional disabled states, and partial-read notices.
4. **Coverage note** — no claim of independent external monitoring, host metrics, or fleet-wide replica health.

Show a readable loading state, empty/disabled states, partial errors, inaccessible API state, and a manual Refresh control. Automatic polling should be conservative and paused when the Health tab is not active. Avoid generating a cascade of backend probes on every render.

Use existing admin i18n keys and extend all supported locales following repo parity requirements. Keep navigation, title handling, and other System tabs unchanged.

## 8. Security and scope invariants

1. **Authorization:** verified through platform-admin middleware, not a permissive partner/org read permission.
2. **One-way read:** no actions, POST/PUT/PATCH/DELETE, job triggers, restarts or configuration mutations.
3. **No tenant payload:** no devices, tenants, customers, queue bodies, job arguments/results, or organization-specific identifiers.
4. **No secrets / internal infra leakage:** no DSNs, credentials, access tokens, passwords, Redis keys, hostnames, IPs, internal URLs, stack traces or unfiltered error strings in the serialized response.
5. **No uncontrolled queries:** clients cannot specify metric expressions or arbitrary queue/job names.
6. **No new schema/migrations:** all observations are derived from existing process/Redis sources.
7. **No portal:** no `apps/portal`, `portal_branding`, `PORTAL_VISIBILITY_FLAG_KEYS`, customer-safe projection or public status API changes.
8. **No weakened health gate:** keep existing liveness and readiness behavior, including API container liveness vs worker readiness distinction.

## 9. Tests and verification requirements

Every test resides alongside its implementation and follows `docs/agents/testing.md`.

**API / service unit tests**

- Valid process readiness snapshot; DB down; Redis down; required worker initialization/consumer failure; process shutting down.
- `unknown` for stale, missing, malformed, timed-out, or unreachable observations; `disabled` for legitimately disabled optional capabilities.
- Single-flight/cache reuse and bounded reads; no extra independent DB/Redis probe path.
- Queue category correctness, empty queue, expected delayed jobs, failure isolation, and per-queue criteria (no universal threshold).
- Heartbeat fresh/stale/missing/failure streak mapping and feature-disabled semantics.
- Shared vs process scopes, split worker, multi-replica non-claims, and null/unknown coverage.

**Route / security tests**

- No authentication 401; organization/partner user 403; platform admin 200; non-GET 404.
- Partial response when Redis or a queue read fails, not 500.
- Response serialization canaries: no secrets, connection URLs, hostnames, queue payloads, raw error messages, tenant/user/device data.
- `Cache-Control: no-store`; bounded/allowlisted read surface.

**Web tests**

- Tab parsing and deep-linking (including reload/SSR hydration), existing tabs unchanged.
- Correct loading, success, disabled, unknown/stale, and error rendering.
- Manual refresh and inactive-tab polling behavior.
- i18n parity and admin navigation; selected components use repo `data-testid` conventions where applicable.

**Compatibility and integration**

- Existing `/health`, `/ready`, `/health/ready`, `/admin/system/connections`, and `/admin/system/connection-health` contracts remain intact.
- Works with monitoring overlay absent and with worker-split enabled.
- Real Redis failure causes partial result without a false green verdict.
- No new tenant-scoped schema or RLS implications.

For the **spec-only PR**, verify formatting, internal paths, diff scope and absence of secrets. Runtime/API/web suites belong to the implementation PRs, not this documentation-only change.

## 10. Delivery proposal (not implementation approval)

**W01 — API contract and aggregator.** Define curated source registry and source-to-state mapping, expose injected readiness access, implement bounded queue/job readers and the admin GET, and add authorization/failure/security tests.

**W02 — Web tab and documentation.** Add Health tab and i18n, source freshness/error UI, polling/refresh behavior, web tests, and operational documentation.

The two-wave split is a **suggestion**; it requires maintainer approval. Do not register implementation waves or begin work merely because this design PR is open.

## 11. Risks and trade-offs

| Risk | Mitigation |
|---|---|
| Local process appears green while another replica is unhealthy | Explicit `process` scope and coverage note; no unearned deployment-wide green |
| Queue backlogs misclassified | Curated queues, domain-specific semantics; unknown when no established threshold |
| Stale heartbeat interpreted as proof of outage | Distinguish missing/stale from confirmed failure |
| Query amplification / DB pressure | Reuse bounded cached evaluator; bounded queue/heartbeat reads and conservative polling |
| Redis failure makes health UI fail with 500 | Per-source failure isolation and partial JSON |
| System tab confuses configuration with live condition | Retain distinct Connections vs Health semantics |
| Admin UI unavailable during full API outage | Document the limitation; no claim of independent status service |
| Sensitive diagnostics exposed by future extension | Explicit response allowlist and negative serialization tests |

## 12. Decisions requested from maintainer before implementation

1. **Coverage and terminology:** Is a process-scoped readiness card plus separate shared background-processing sections preferred over a single misleading deployment-wide status badge?
2. **Queue inventory:** Which existing queues are worthwhile for the first read-only registry, and which already have defensible health thresholds?
3. **Job inventory:** Are connection-health reconciler/digest/per-kind heartbeats sufficient for W01, or should one or two other existing authoritative heartbeat sources be included?
4. **Degraded vs unavailable:** Should required consumer failures map to `unavailable` for that process while queue/job impairments remain `degraded` or `unknown` depending on evidence?
5. **Read budget/polling:** Which existing API caching and admin-web refresh patterns should set the concrete bounds?
6. **Delivery:** Is the proposed two-wave API-then-web split reasonable, or would a single implementation PR be preferable?

## 13. Explicit product decision: no Customer Portal exposure

The initial Discussion mentioned a possible customer-facing view. **The proposer has withdrawn that idea from this feature.** This spec has no portal phase, public or partner-facing status surface, org-level enable flag, customer-safe API, or cross-tenant disclosure decision. The scope is the existing **platform-admin-only System page**.

That also means **hosted MSP users who are not platform administrators do not receive this tab**; no role expansion is implied. Any other audience or unrelated portal proposal must be separately proposed and approved and is not a deferred item in this spec.
