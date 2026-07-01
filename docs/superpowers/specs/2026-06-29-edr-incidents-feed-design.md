# EDR-aware Incidents Page (Unified Feed) — Design

> **Status:** Approved design. Next step is an implementation plan via `writing-plans`.
> **Branch:** `ToddHebebrand/Incidents-Tab`
> **Date:** 2026-06-29

## Problem

The Incidents page (`IncidentsPage.tsx` → `GET /incidents`) reads only the BE-32 `incidents`
table, which is populated solely by manual create, the AI brain, and audit-chain tamper detection.
Meanwhile Huntress incidents and SentinelOne (S1) threats sync into their **own** tables
(`huntress_incidents`, `s1_threats`) and are shown only under the integration / EDR pages. The two
systems were never connected, so the Incidents page looks empty even when EDR integrations are
syncing healthily (observed on the OliveTech / DO-US tenant).

Pillar 4a (PR #1946) shipped a manual **"Promote to Incident"** button on the EDR surfaces, but it
creates an `incidents` row with **no trace of its origin** — there is no link from the EDR record to
the resulting incident.

## Goal

Make the Incidents page the single pane for security incidents: surface **all** Huntress incidents
and S1 threats alongside native tracked incidents, while keeping proper incident management for the
ones a human chooses to work — without rebuilding the Huntress/S1 console inside Breeze.

## Decisions (locked with the product owner)

- **Two-tier model**, not auto-file. EDR findings appear read-only; they become tracked incidents
  only via manual **Promote** (the shipped Pillar 4a button).
- **Show everything.** All Huntress incidents and all S1 threats surface. Breeze does **no**
  severity filtering or config-policy gating — sensitivity is configured on the EDR side.
- **Don't duplicate Huntress.** Findings render as thin summary rows with a **link-out** to the EDR
  console for forensic detail. Tracked incidents **reference** their EDR origin (do not copy it).
- **Manual promote only.** No auto-file, no auto-promote rules.
- **Forward-compat for ITDR** (identity-based, user- not device-scoped): add the schema hook now,
  build the ingestion later. The Huntress **resolve** write-back API client is a separate follow-up.

## Architecture

### 1. Page layout (web)

A single **interleaved list** with two row kinds, distinguished by a **source badge**
(`Breeze` / `Huntress` / `SentinelOne`) and a filter (`All · Tracked · Findings`, plus by source):

- **Finding rows** (read-only): title, normalized severity, affected device/user, EDR status,
  detected time, **"View in Huntress/S1"** link-out, and a **Promote** button.
- **Tracked rows**: native `incidents` with full lifecycle; click opens the existing
  `IncidentDetailPage`.

Rationale for one list over tabs: the owner's mental model is "one place to see all incidents." The
badge + the Promote-vs-status affordance make the two kinds visually obvious.

### 2. API

- **New** `GET /incidents/feed` returns a **normalized union** of three projections — native
  `incidents`, `huntress_incidents`, `s1_threats` — into a common row shape:

  ```ts
  {
    kind: 'tracked' | 'finding';
    source: 'breeze' | 'huntress' | 's1';
    sourceId: string;            // incident id, or EDR external id
    title: string;
    severity: 'p1' | 'p2' | 'p3' | 'p4';
    edrStatus: string | null;    // raw EDR status for findings; null for tracked
    status: IncidentStatus | null; // BE-32 lifecycle for tracked; null for findings
    deviceId: string | null;
    detectedAt: string;          // ISO
    linkOut: string | null;      // EDR console deep-link (findings only)
    trackedIncidentId: string | null; // set if a finding was promoted (suppressed from feed)
  }
  ```

  Sorted (severity, then `detectedAt` desc) and **paginated server-side**.

- The existing `GET /incidents` (tracked-only) is **unchanged** — AI tools and other consumers keep
  working.
- **Scope** reuses the existing `resolveOrgFilter(auth, orgId, col)` helper against each table's
  `org_id`, so org users see their org and partner users get the fleet view — identical to today's
  incidents list behavior.
- **Severity normalization**: a server-side `mapEdrSeverity` (mirror of the one in
  `apps/web/src/lib/incidents.ts`) maps Huntress/S1 severity strings → `p1–p4`
  (`critical→p1, high→p2, medium→p3, low→p4`, else `p3`).
- **Dedup / suppression**: the feed `LEFT JOIN`s `incidents` on `(source_type, source_ref)` and
  **excludes any finding already promoted**, so a promoted finding shows exactly once — as its
  tracked incident.

#### Implementation approach for the union

Project each source to the common shape and `UNION ALL`, then sort + paginate. Prefer a query (or a
`security_invoker` SQL view) so each underlying table's RLS still applies under `breeze_app`. Avoid
app-level merge across capped per-source fetches (breaks clean pagination). RLS must be verified as
`breeze_app` for the view/query path.

### 3. Schema (one idempotent migration)

`incidents` has no source link today. Add:

- `source_type` text — `'huntress_incident' | 's1_threat' | null`.
- `source_ref` text — the EDR external id (`huntress_incident_id` / `s1_threat_id`).
- Partial unique index `(org_id, source_type, source_ref) WHERE source_ref IS NOT NULL`.
- `affected_users jsonb NOT NULL DEFAULT '[]'` — **forward-compat hook for ITDR**, unused for now,
  so identity-based findings slot in later without another migration.

RLS shape is unchanged — `incidents` stays org-scoped (shape #1, direct `org_id`). No new
tenant-scoped table is introduced; the migration only adds columns + an index.

Also:

- Extend `createIncidentSchema` + the `POST /incidents` handler to accept and persist
  `source_type` / `source_ref`.
- Update the **shipped Pillar 4a mappers** (`apps/web/src/lib/incidents.ts`:
  `s1ThreatToIncident`, `huntressIncidentToIncident`) to pass `source_type` / `source_ref` so
  promote dedups against the feed.

### 4. Link-out detail

Neither EDR table stores a portal URL. The link-out URL is **derived** from the external id (+ the
integration's base) or pulled from the `details` jsonb if present. Exact URL shape is resolved during
the plan; worst case is linking to the Huntress/S1 console root rather than the specific record.

## Out of scope (deferred)

- **Auto-file / auto-promote** — manual promote only.
- **Config-policy gating** — none; sensitivity stays EDR-side.
- **Resolve API client** (Huntress write-back, `HuntressClient` POST methods + UI) — separate spec.
- **ITDR ingestion** (no sync exists) — only the `affected_users` schema hook is added now.

## Testing

- **Feed projection unit tests**: severity mapping; suppression of promoted findings; org-vs-partner
  scope filtering; sort/pagination ordering.
- **Route test** for `GET /incidents/feed` (org scope, partner/fleet scope, suppression).
- **Migration idempotency** test (re-apply is a no-op) + RLS verification as `breeze_app`.
- **Web component test** for the unified list: source badges, `All · Tracked · Findings` filter,
  Promote affordance on findings, link-out rendering.
- Update `no-silent-mutations` count if any new mutation handler is enrolled.

## Affected files (indicative)

- New migration: `apps/api/migrations/2026-06-29-incidents-edr-source-link.sql`.
- `apps/api/src/db/schema/incidentResponse.ts` — new columns.
- `apps/api/src/routes/incidents.ts` + `incidents.validation.ts` — feed endpoint, source link on POST.
- `apps/api/src/routes/incidents.helpers.ts` — feed projection / union builder + server-side
  `mapEdrSeverity`.
- `apps/web/src/components/incidents/IncidentsPage.tsx` — unified list, badge, filter.
- `apps/web/src/lib/incidents.ts` — mappers pass source link.
- `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — no new table, but
  re-verify if the union view is added.
