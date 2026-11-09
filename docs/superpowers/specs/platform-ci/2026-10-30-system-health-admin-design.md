---
title: System Health: native platform-admin health tab
issue: LanternOps/breeze#10958
discussion: LanternOps/breeze discussion #10764
status: draft (for maintainer review; not approved for implementation)
---

# System Health: native platform-admin health tab (design)

**Date:** 2026-10-30 · **Status:** draft for maintainer review (not approved for implementation) · **Origin:** [Discussion #10764](https://github.com/LanternOps/breeze/discussions/10764), [Todd's direction](https://github.com/LanternOps/breeze/discussions/10764#discussioncomment-19302403) · **Prior art:** [System page #6768](https://github.com/LanternOps/breeze/issues/6768), `docs/superpowers/specs/platform-ci/2026-09-23-system-connections-page-design.md`

> **Decision boundary.** Todd accepted the direction for a platform-admin Health tab, not this detailed spec. The design choices below are proposals for review. This document intentionally excludes the Customer Portal altogether, at the proposer's request; it neither specifies nor reserves a portal wave.

## 1. Why

Breeze already has probe endpoints, selected job heartbeats, BullMQ queue counters, and an optional Prometheus/Grafana observability overlay. There is no unified platform-admin **background-processing health** view in the native System page. Operators must inspect several sources to tell whether a scheduled job is stale or a queue has a growing backlog.

The existing `/admin/system` **Connections** tab shows what is *configured* (not whether the service answers), and **Deprecations** addresses another concern. **Health** must remain separate from both: it answers how background processing is doing, and whether the supporting observations are fresh.

**Goals**

1. Give **platform administrators** a fast, read-only, in-product view of background-processing health.
2. Reuse existing shared operational signals; do not build another monitoring engine.
3. Surface **supported queue depths and supported scheduled-job heartbeats**, all read from shared Redis.
4. Represent partial failures honestly: `unknown` is different from `unavailable`, and an intentionally disabled capability is not an incident.
5. Work without the optional monitoring overlay.

**Non-goals**

- Customer Portal, customer status pages, any per-`orgId` publication setting, portal API, white-label status, or external/public uptime page. **No portal work is proposed, including as a later wave of this design.**
- Managed-device, agent fleet, customer network, site, or endpoint health.
- Host CPU/RAM/disk, Prometheus integration, Grafana visualization, logs, Sentry, or advanced performance analytics.
- AI diagnosis/recommendations, remediation, process restarts, job retries, queue manipulation, or incident/SLA management.
- Independently monitoring an API outage while the very API serving this screen is unreachable.
- Per-process or per-host health, API replica discovery, and any overall verdict; these stay with `/health/ready` and the monitoring overlay.

## 2. Verified foundations and approved direction

| Source | Confirmed behavior / relevance |
|---|---|
| `apps/web/src/components/admin/system/SystemPage.tsx` and `apps/web/src/pages/admin/system.astro` | Existing `/admin/system` page with Connections/Deprecations tabs and query-parameter tab selection. |
| `apps/api/src/routes/admin/index.ts` | `adminRoutes.use('*', platformAdminMiddleware)`; System routes are mounted underneath it. |
| `apps/api/src/routes/admin/systemConnectionHealth.ts` | Read-only, platform-admin-only, Redis-backed job health; Redis failure is represented in response rather than a generic HTTP 500. |
| `apps/api/src/services/connectionHealth/heartbeat.ts` | Reconciler/digest heartbeat timestamps, stale/missing states, per-kind last success and failure streak; Redis `mget` failure produces a partial status. |
| `apps/api/src/jobs/m365SyncWorker.ts` and `apps/api/src/jobs/eventDispatchWorker.ts` | Existing `getJobCounts` usage; queue state categories and semantics differ by queue. |
| `docker-compose.monitoring.yml` and `docs/operations/MONITORING.md` | Optional observability overlay; its presence is not a prerequisite for the native Health tab. |

**Maintainer-confirmed, Discussion #10764:** locate the tab at `/admin/system`; follow `systemConnectionHealth.ts` authorization and partial-failure pattern; use existing API-visible signals without requiring a Prometheus client; MVP initially listed API readiness, PostgreSQL, Redis, queue depth, and job heartbeats and was narrowed in review to queue depth and job heartbeats; exclude host capacity. Todd deferred the portal direction; this document goes further by **explicitly removing the portal from this feature's scope**, as requested by the proposer. This exclusion is a project proposal, not a separate maintainer approval.

## 3. Decisions proposed for approval

| ID | Decision |
|---|---|
| D1 | **One home:** add **Health** as a third tab to `/admin/system`; preserve Connections and Deprecations. No additional global navigation item. |
| D2 | **Platform-admin only:** the API is mounted via `adminRoutes.route('/system', ...)`, not directly on the root API; existing `platformAdminMiddleware` remains the gate. |
| D3 | **Read-only:** GET only; no mutation, service controls, retries, or new permissions. |
| D4 | **Prometheus-independent:** basic Health is available even when `ENABLE_MONITORING=false`, Prometheus/Grafana are absent, or the optional overlay is down. |
| D5 | **Bounded degradation:** when Redis or a queue/heartbeat read fails, return other available components and mark affected observations unknown; no blanket 500 for a dependency outage. |
| D6 | **Truthful status:** fresh evidence is required for `operational`; missing/stale/unreadable evidence is `unknown`; disabled optional functionality is `disabled`, not broken. |
| D7 | **Curated coverage:** initially include only explicit queue/job descriptors with known configuration and observability semantics; no blind iteration over all BullMQ queues. |
| D8 | **No global queue threshold:** use existing domain thresholds where justified; an occupied queue, delayed job, or missing optional queue is not automatically degraded. |
| D9 | **No new persistence:** prefer existing read models/Redis keys; new tables, migrations, and monitoring infrastructure are not part of the MVP. |
| D10 | **Do not change probe contracts:** existing `/health`, `/ready`, `/health/ready`, and connection-health status route remain behaviorally compatible. |
| D11 | **No customer scope:** no Portal UI/API, customer organization selector, `portal_branding` field, visibility flag, or tenant-specific data in the report. |
| D12 | **No secret-bearing payload:** no credentials, connection strings, queue payloads, internal hostnames/IPs, raw logs, or exception messages in the JSON/UI. |
| D13 | **Native UI:** i18n and existing System-page tab state patterns; fresh/stale/partial-data presentation, manual refresh only. |
| D14 | **Truthful availability:** if the serving API fails completely, the admin tab may be unreachable; this is not an external availability service. |

## 4. Status vocabulary and evaluation

### 4.1 Distinct states

| State | Meaning | Permitted evidence |
|---|---|---|
| `operational` | A current authoritative observation indicates normal operation | Eligible heartbeat within its known cadence |
| `degraded` | Function remains possible but an established domain health criterion fails | A known failure streak, or an existing meaningful backlog criterion |
| `unavailable` | An explicitly required capability is confirmed unable to perform its function | Reserved; no MVP source maps here |
| `unknown` | No trustworthy current verdict is available | Missing/stale heartbeat, timed-out collection, unreadable Redis, queue without a domain threshold |
| `disabled` | The optional capability is intentionally turned off | Existing authoritative feature/role flag |

An optional capability **not deployed for this role** should be omitted or marked disabled with a clear reason; it must not become a red component. No `unavailable` status may be inferred solely from a nonexistent optional target.

### 4.2 Freshness

- Reuse heartbeat cadence/TTL and existing `stale`/`missing` semantics from `connectionHealth/heartbeat.ts`.
- Every derived queue/job read should have a time of observation and a timeout/failure state.
- Do not invent success when a Redis read yields no value or errors.
- Never apply a generic one-minute heartbeat timeout to jobs with different schedules.

## 5. Components and data acquisition

### 5.1 Queue depth: explicit bounded registry

Start from queues whose state can be read safely with existing BullMQ queue instances and known semantics. `m365SyncWorker.ts` counts `waiting`, `prioritized`, `delayed`, `active` for its workload, while `eventDispatchWorker.ts` uses its own categories.

**Proposed per-queue adapter contract:**

- stable ID and admin-facing localized label;
- optional configuration/role predicate (active vs disabled vs absent);
- read-only, bounded count retrieval;
- explicit named categories (`waiting`, `prioritized`, `delayed`, `active`);
- domain-defined severity mapping **only where currently justified**;
- `checkedAt` and `status`.

Avoid interpreting `delayed` as overdue: BullMQ delayed tasks can be scheduled intentionally. Avoid a generic global backlog threshold. If no reliable thresholds exist for a queue, show counts with `status: 'unknown'` for performance/degradation rather than fabricate a healthy/degraded verdict. Collection failure should preserve other queues and dependencies.

**Initial queues are fixed in §12.2.** Implementation planning maps their existing queue getters and feature flags. This spec does not claim every Breeze queue is observable or that a uniform backlog threshold exists.

### 5.2 Scheduled-job heartbeats

Reuse `readConnectionHealthJobStatus()` and its existing reconciler/digest/per-kind freshness rules as the first authoritative heartbeat source. Do not create another heartbeat framework for the same jobs.

Report for known, supported jobs:

- stable ID and admin-facing label;
- schedule or known expected cadence (if authoritative);
- last run / last success where already stored;
- `ok`, `stale`, `missing` and `failing` source states mapped carefully to the UI vocabulary.

A stale/missing heartbeat normally means **unknown/not observed**, not proof that the entire API is unavailable. A known positive failure streak may justify degraded status within that job's defined scope. Disabled/unscheduled jobs must be excluded from failure counts.

**Scope is fixed in §12.3:** connection-health heartbeats only. Adding heartbeat writers for other jobs requires separate explicit justification and tests; no blanket instrumentation of all background workers.

### 5.3 Replicas and split worker

All observations come from shared Redis; per-process and per-host health stays in `/health/ready` and the monitoring overlay (`docs/operations/MONITORING.md`).

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
type HealthObservation = {
  id: string;
  status: HealthState;
  checkedAt: string | null;
  detailCode?: string; // stable, allowlisted reason for i18n; never raw exceptions
};

type SystemHealthResponse = {
  data: {
    generatedAt: string; // response creation time, not proof of freshness
    queues: Array<HealthObservation & {
      counts: Partial<Record<'waiting' | 'prioritized' | 'delayed' | 'active', number>>;
    }>;
    jobs: Array<HealthObservation & {
      lastRunAt: string | null;
      failureStreak?: number;
    }>;
  };
};
```

Example shapes are illustrative. The implementation plan must settle how missing data maps to nullable values, which queue states are reported, and how source states map to the UI vocabulary; there is no overall verdict.

### 6.3 Failure isolation and read budget

- An exception in one queue/job adapter must not discard successfully read observations from the others.
- Redis unavailable: return 200 with the Redis-backed queue/heartbeat observations marked `unknown`; **do not transform this into generic HTTP 500**.
- Queue and heartbeat reads must be bounded and share existing read paths where available. No unbounded `Promise.all` of every registered queue, and no arbitrary admin-specified queue names.
- The health endpoint must not alter the existing application admission gate.
- Preserve distinct `generatedAt`, source `checkedAt`, and stale semantics.

## 7. Web design

Extend `apps/web/src/components/admin/system/SystemPage.tsx` and the existing server-side tab parser at `apps/web/src/pages/admin/system.astro`.

**Tabs:** Connections (existing default), Deprecations, **Health**. Proposed deep link: `/admin/system?tab=health`. Keep SSR and hydration tab state aligned with the existing implementation; do not replace this page's established query-param pattern with a new URL convention.

**Suggested sections:**

1. **Background work** — supported queues and jobs; depths, last-run times, optional disabled states, and partial-read notices.
2. **Coverage note** — no claim of independent external monitoring, host metrics, or per-process/per-host health (see `/health/ready` and the monitoring overlay).

Show a readable loading state, empty/disabled states, partial errors, inaccessible API state, and a manual Refresh control, as in the Connections tab. There is no background polling. Avoid generating a cascade of backend reads on every render.

Use existing admin i18n keys and extend all supported locales following repo parity requirements. Keep navigation, title handling, and other System tabs unchanged.

## 8. Security and scope invariants

1. **Authorization:** verified through platform-admin middleware, not a permissive partner/org read permission.
2. **One-way read:** no actions, POST/PUT/PATCH/DELETE, job triggers, restarts or configuration mutations.
3. **No tenant payload:** no devices, tenants, customers, queue bodies, job arguments/results, or organization-specific identifiers.
4. **No secrets / internal infra leakage:** no DSNs, credentials, access tokens, passwords, Redis keys, hostnames, IPs, internal URLs, stack traces or unfiltered error strings in the serialized response.
5. **No uncontrolled queries:** clients cannot specify metric expressions or arbitrary queue/job names.
6. **No new schema/migrations:** all observations are derived from existing Redis sources.
7. **No portal:** no `apps/portal`, `portal_branding`, `PORTAL_VISIBILITY_FLAG_KEYS`, customer-safe projection or public status API changes.
8. **No weakened health gate:** keep existing liveness and readiness behavior unchanged.

## 9. Tests and verification requirements

Every test resides alongside its implementation and follows `docs/agents/testing.md`.

**API / service unit tests**

- Redis down.
- `unknown` for stale, missing, malformed, timed-out, or unreachable observations; `disabled` for legitimately disabled optional capabilities.
- Bounded reads over the curated registry.
- Queue category correctness, empty queue, expected delayed jobs, failure isolation, and per-queue criteria (no universal threshold).
- Heartbeat fresh/stale/missing/failure streak mapping (known failure streak is `degraded`) and feature-disabled semantics.

**Route / security tests**

- No authentication 401; organization/partner user 403; platform admin 200; non-GET 404.
- Partial response when Redis or a queue read fails, not 500.
- Response serialization canaries: no secrets, connection URLs, hostnames, queue payloads, raw error messages, tenant/user/device data.
- `Cache-Control: no-store`; bounded/allowlisted read surface.

**Web tests**

- Tab parsing and deep-linking (including reload/SSR hydration), existing tabs unchanged.
- Correct loading, success, disabled, unknown/stale, and error rendering.
- Manual refresh; no background polling.
- i18n parity and admin navigation; selected components use repo `data-testid` conventions where applicable.

**Compatibility and integration**

- Existing `/health`, `/ready`, `/health/ready`, `/admin/system/connections`, and `/admin/system/connection-health` contracts remain intact.
- Works with the monitoring overlay absent.
- Real Redis failure causes partial result without a false green verdict.
- No new tenant-scoped schema or RLS implications.

For the **spec-only PR**, verify formatting, internal paths, diff scope and absence of secrets. Runtime/API/web suites belong to the implementation PR, not this documentation-only change.

## 10. Delivery

A single implementation PR: curated source registry and source-to-state mapping, bounded queue/job readers, the admin GET, the Health tab with i18n and manual refresh, tests, and operational documentation. Implementation begins only after this spec merges; do not start work merely because this design PR is open.

## 11. Risks and trade-offs

| Risk | Mitigation |
|---|---|
| Queue backlogs misclassified | Curated queues, domain-specific semantics; unknown when no established threshold |
| Stale heartbeat interpreted as proof of outage | Distinguish missing/stale from confirmed failure |
| Query amplification / DB pressure | Bounded queue/heartbeat reads over a curated registry; manual refresh only |
| Redis failure makes health UI fail with 500 | Per-source failure isolation and partial JSON |
| System tab confuses configuration with live condition | Retain distinct Connections vs Health semantics |
| Admin UI unavailable during full API outage | Document the limitation; no claim of independent status service |
| Sensitive diagnostics exposed by future extension | Explicit response allowlist and negative serialization tests |

## 12. Closed decisions (accepted by the maintainer)

Resolved in maintainer review; each is binding for the implementation.

1. **Coverage.** Neither a process-scoped readiness card nor a deployment-wide badge. The tab has only shared background-processing sections and no overall verdict.
2. **Queues.** First registry is `getConnectionHealthQueue`, `getConnectionHealthDigestQueue`, `getAlertQueue` and `getEventDispatchQueue`, counts only (`waiting`, `prioritized`, `delayed`, `active`). Status is `unknown` until the owning domain defines a threshold (D7, D8).
3. **Jobs.** Only the connection-health reconciler, digest and per-kind heartbeats read by `readConnectionHealthJobStatus()`. Any further job needs its own writer, tests and justification in a separate change.
4. **Degraded vs unavailable.** A known failure streak maps to `degraded`; missing or stale evidence maps to `unknown` (D6). There is no consumer-based `unavailable`.
5. **Polling.** Manual refresh only, as in the Connections tab; no background poll.
6. **Delivery.** One implementation PR (§10); implementation starts only after this spec merges.

## 13. Explicit product decision: no Customer Portal exposure

The initial Discussion mentioned a possible customer-facing view. **The proposer has withdrawn that idea from this feature.** This spec has no portal phase, public or partner-facing status surface, org-level enable flag, customer-safe API, or cross-tenant disclosure decision. The scope is the existing **platform-admin-only System page**.

That also means **hosted MSP users who are not platform administrators do not receive this tab**; no role expansion is implied. Any other audience or unrelated portal proposal must be separately proposed and approved and is not a deferred item in this spec.
