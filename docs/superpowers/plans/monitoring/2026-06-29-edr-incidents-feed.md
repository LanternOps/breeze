# EDR-aware Incidents Page (Unified Feed) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface all Huntress incidents and SentinelOne threats on the Incidents page alongside native tracked incidents, with a source-link so manually-promoted findings dedupe out of the feed.

**Architecture:** Add a `source_type`/`source_ref` link (and a forward-compat `affected_users`) to the `incidents` table. A new `GET /incidents/feed` endpoint returns a normalized `UNION ALL` of native incidents + Huntress incidents + S1 threats, scoped via the existing `resolveOrgFilter`, suppressing any finding already promoted. The web Incidents page renders the union as one list with source badges + a filter. The existing `GET /incidents` (tracked-only) is untouched.

**Tech Stack:** Hono + Drizzle (Postgres, RLS-forced as `breeze_app`), Vitest, Astro/React islands, Tailwind.

**Spec:** `docs/superpowers/specs/monitoring/2026-06-29-edr-incidents-feed-design.md`

## Global Constraints

- **No auto-file, no config gating.** All findings show; sensitivity stays EDR-side. Findings become tracked incidents only via the existing manual Promote button.
- **RLS:** `incidents` stays org-scoped (shape #1, direct `org_id`). This plan adds **columns only** — no new tenant-scoped table, so no `rls-coverage` allowlist change. All DB reads go through the request DB-access context (never the bare pool).
- **Migrations:** hand-written SQL in `apps/api/migrations/`, filename `YYYY-MM-DD-<slug>.sql`, idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), no inner `BEGIN/COMMIT`. Never edit a shipped migration.
- **Severity map (verbatim):** `critical→p1, high→p2, medium→p3, low→p4`, anything else → `p3`.
- **Promote contract unchanged:** `POST /incidents` still requires `alerts:write` + MFA.
- **File-size guideline:** keep route/helper files focused; the feed projection lives in `incidents.helpers.ts`, not inline in the route.

---

### Task 1: Migration + schema — source link & affected_users columns

**Files:**
- Create: `apps/api/migrations/2026-06-29-incidents-edr-source-link.sql`
- Modify: `apps/api/src/db/schema/incidentResponse.ts` (incidents table, ~line 49-72)

**Interfaces:**
- Produces: `incidents.sourceType` (`text`, nullable), `incidents.sourceRef` (`text`, nullable), `incidents.affectedUsers` (`jsonb`, `$type<string[]>`, not null, default `[]`); partial unique index `incidents_source_ref_unique (org_id, source_type, source_ref) WHERE source_ref IS NOT NULL`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-29-incidents-edr-source-link.sql`:

```sql
-- Link a tracked incident back to the EDR record it was promoted from, so the
-- /incidents/feed union can suppress findings that already became incidents.
-- incidents is org-scoped (RLS shape #1); adding columns does not change tenancy.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_type text;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS source_ref text;

-- Forward-compat hook for identity-based (ITDR) findings; unused until an ITDR
-- ingestion path exists. Device-based findings keep using affected_devices.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS affected_users jsonb NOT NULL DEFAULT '[]'::jsonb;

-- One tracked incident per (org, EDR source record). Partial: only enforced when
-- a source_ref is present, so manually-created incidents (no source) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS incidents_source_ref_unique
  ON incidents (org_id, source_type, source_ref)
  WHERE source_ref IS NOT NULL;
```

- [ ] **Step 2: Update the Drizzle schema**

In `apps/api/src/db/schema/incidentResponse.ts`, inside the `incidents = pgTable('incidents', {...})` column block (after `affectedDevices`, before `timeline`), add:

```ts
  sourceType: text('source_type'),
  sourceRef: text('source_ref'),
  affectedUsers: jsonb('affected_users').$type<string[]>().notNull().default([]),
```

And in the table's index callback (after `detectedAtIdx`), add:

```ts
  sourceRefIdx: uniqueIndex('incidents_source_ref_unique')
    .on(table.orgId, table.sourceType, table.sourceRef)
    .where(sql`source_ref IS NOT NULL`),
```

Ensure `uniqueIndex` and `sql` are imported from `drizzle-orm/pg-core` and `drizzle-orm` respectively at the top of the file (add to the existing import lists if missing).

- [ ] **Step 3: Run drift check to verify schema matches migration**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift reported (schema matches the migration).

- [ ] **Step 4: Verify migration idempotency**

Run: `cd apps/api && pnpm vitest run src/db/autoMigrate.test.ts`
Expected: PASS (migration ordering/idempotency regression test green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-29-incidents-edr-source-link.sql apps/api/src/db/schema/incidentResponse.ts
git commit -m "feat(incidents): add source_type/source_ref + affected_users to incidents"
```

---

### Task 2: Accept & persist the source link on `POST /incidents`

**Files:**
- Modify: `apps/api/src/routes/incidents.validation.ts` (`createIncidentSchema`)
- Modify: `apps/api/src/routes/incidents.ts` (POST handler insert, ~line 78-92)
- Test: `apps/api/src/routes/incidents.test.ts`

**Interfaces:**
- Consumes: `incidents.sourceType` / `incidents.sourceRef` columns (Task 1).
- Produces: `createIncidentSchema` accepts optional `sourceType: 'huntress_incident' | 's1_threat'` and `sourceRef: string (1..128)`; POST persists both.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/incidents.test.ts`, add (follow the file's existing Drizzle-mock + auth-context patterns; mirror the values asserted by an existing create test):

```ts
it('persists sourceType/sourceRef when promoting an EDR finding', async () => {
  // Arrange: org-scoped auth with alerts:write + MFA satisfied (reuse the
  // helper the other create tests in this file use).
  const body = {
    title: 'Huntress: Suspicious login',
    classification: 'huntress-incident',
    severity: 'p1',
    sourceType: 'huntress_incident',
    sourceRef: 'hunt-abc-123',
  };

  const res = await postIncident(body); // existing test helper in this file

  expect(res.status).toBe(201);
  // The insert .values(...) must have received the source link:
  expect(insertValuesArg).toMatchObject({
    sourceType: 'huntress_incident',
    sourceRef: 'hunt-abc-123',
  });
});
```

(If the file lacks an `insertValuesArg` capture, capture it the same way the existing create test asserts inserted columns — assert on the mock `.values` call argument.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.test.ts -t "persists sourceType"`
Expected: FAIL — schema rejects unknown keys or the insert omits the fields.

- [ ] **Step 3: Extend the validation schema**

In `apps/api/src/routes/incidents.validation.ts`, add to `createIncidentSchema` (after `status`):

```ts
  sourceType: z.enum(['huntress_incident', 's1_threat']).optional(),
  sourceRef: z.string().min(1).max(128).optional(),
```

- [ ] **Step 4: Persist in the POST handler**

In `apps/api/src/routes/incidents.ts`, in the `.insert(incidents).values({...})` object (after `detectedAt,`), add:

```ts
        sourceType: data.sourceType,
        sourceRef: data.sourceRef,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.test.ts -t "persists sourceType"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/incidents.validation.ts apps/api/src/routes/incidents.ts apps/api/src/routes/incidents.test.ts
git commit -m "feat(incidents): accept and persist source link on create"
```

---

### Task 3: Feed projection helper (severity map + union builder)

**Files:**
- Modify: `apps/api/src/routes/incidents.helpers.ts`
- Test: `apps/api/src/routes/incidents.helpers.test.ts` (create if absent)

**Interfaces:**
- Consumes: `resolveOrgFilter(auth, queryOrgId, column)` (already in this file); `huntressIncidents`, `s1Threats`, `incidents` from `../db/schema`.
- Produces:
  - `type IncidentFeedRow = { kind: 'tracked' | 'finding'; source: 'breeze' | 'huntress' | 's1'; sourceId: string; title: string; severity: 'p1'|'p2'|'p3'|'p4'; edrStatus: string | null; status: string | null; deviceId: string | null; detectedAt: string; trackedIncidentId: string | null }`
  - `mapEdrSeverityRank(sev): SQL<number>` — SQL CASE producing 1..4 (p1..p4) for sorting.
  - `buildIncidentFeed(auth, params): Promise<{ rows: IncidentFeedRow[]; total: number }>` where `params = { orgId?: string; kind?: 'tracked'|'finding'; source?: 'breeze'|'huntress'|'s1'; limit: number; offset: number }`. Throws `FeedScopeError` (carrying `{ message, status }`) when `resolveOrgFilter` returns an error.

- [ ] **Step 1: Write the failing test (severity rank + suppression shape)**

Create `apps/api/src/routes/incidents.helpers.test.ts` (mock `../db` so no real DB; assert the builder issues a query with the suppression `NOT EXISTS` and the org filter). Start with the pure pieces:

```ts
import { describe, it, expect } from 'vitest';
import { severityRankToLabel } from './incidents.helpers';

describe('severityRankToLabel', () => {
  it('maps rank 1..4 to p1..p4 and clamps unknown to p3', () => {
    expect(severityRankToLabel(1)).toBe('p1');
    expect(severityRankToLabel(2)).toBe('p2');
    expect(severityRankToLabel(3)).toBe('p3');
    expect(severityRankToLabel(4)).toBe('p4');
    expect(severityRankToLabel(99)).toBe('p3');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.helpers.test.ts`
Expected: FAIL — `severityRankToLabel` not exported.

- [ ] **Step 3: Implement the helper**

In `apps/api/src/routes/incidents.helpers.ts`:

Add imports at the top (extend existing import lines):

```ts
import { and, eq, inArray, sql, unionAll, type SQL } from 'drizzle-orm';
import { incidents, huntressIncidents, s1Threats } from '../db/schema';
```

Add the types + helpers:

```ts
export type IncidentFeedRow = {
  kind: 'tracked' | 'finding';
  source: 'breeze' | 'huntress' | 's1';
  sourceId: string;
  title: string;
  severity: 'p1' | 'p2' | 'p3' | 'p4';
  edrStatus: string | null;
  status: string | null;
  deviceId: string | null;
  detectedAt: string;
  trackedIncidentId: string | null;
};

export class FeedScopeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function severityRankToLabel(rank: number): IncidentFeedRow['severity'] {
  return rank === 1 ? 'p1' : rank === 2 ? 'p2' : rank === 4 ? 'p4' : 'p3';
}

// EDR severity string -> sortable rank (1=p1 highest .. 4=p4). Mirrors the
// web mapEdrSeverity: critical->1, high->2, medium->3, low->4, else 3.
function edrSeverityRank(col: SQL | PgColumn): SQL<number> {
  return sql<number>`CASE lower(coalesce(${col}, ''))
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
    ELSE 3 END`;
}

// Native p1..p4 enum -> same rank space.
function nativeSeverityRank(): SQL<number> {
  return sql<number>`CASE ${incidents.severity}
    WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p4' THEN 4 ELSE 3 END`;
}
```

Add the builder:

```ts
export async function buildIncidentFeed(
  auth: AuthContext,
  params: {
    orgId?: string;
    kind?: 'tracked' | 'finding';
    source?: 'breeze' | 'huntress' | 's1';
    limit: number;
    offset: number;
  }
): Promise<{ rows: IncidentFeedRow[]; total: number }> {
  const orgIncidents = resolveOrgFilter(auth, params.orgId, incidents.orgId);
  const orgHuntress = resolveOrgFilter(auth, params.orgId, huntressIncidents.orgId);
  const orgS1 = resolveOrgFilter(auth, params.orgId, s1Threats.orgId);
  if (orgIncidents.error) {
    throw new FeedScopeError(orgIncidents.error.status, orgIncidents.error.message);
  }

  // Native tracked incidents.
  const trackedQ = db
    .select({
      kind: sql<'tracked'>`'tracked'`,
      source: sql<'breeze'>`'breeze'`,
      sourceId: sql<string>`${incidents.id}::text`,
      title: incidents.title,
      rank: nativeSeverityRank(),
      edrStatus: sql<string | null>`null::text`,
      status: sql<string | null>`${incidents.status}::text`,
      deviceId: sql<string | null>`(${incidents.affectedDevices}->>0)`,
      detectedAt: incidents.detectedAt,
      trackedIncidentId: incidents.id,
    })
    .from(incidents)
    .where(orgIncidents.condition);

  // Huntress findings NOT already promoted.
  const huntressQ = db
    .select({
      kind: sql<'finding'>`'finding'`,
      source: sql<'huntress'>`'huntress'`,
      sourceId: huntressIncidents.huntressIncidentId,
      title: huntressIncidents.title,
      rank: edrSeverityRank(huntressIncidents.severity),
      edrStatus: huntressIncidents.status,
      status: sql<string | null>`null::text`,
      deviceId: huntressIncidents.deviceId,
      detectedAt: sql<Date>`coalesce(${huntressIncidents.reportedAt}, ${huntressIncidents.createdAt})`,
      trackedIncidentId: sql<string | null>`null::uuid`,
    })
    .from(huntressIncidents)
    .where(
      and(
        orgHuntress.condition,
        sql`NOT EXISTS (SELECT 1 FROM incidents i WHERE i.org_id = ${huntressIncidents.orgId}
          AND i.source_type = 'huntress_incident' AND i.source_ref = ${huntressIncidents.huntressIncidentId})`
      )
    );

  // S1 findings NOT already promoted.
  const s1Q = db
    .select({
      kind: sql<'finding'>`'finding'`,
      source: sql<'s1'>`'s1'`,
      sourceId: s1Threats.s1ThreatId,
      title: sql<string>`coalesce(${s1Threats.threatName}, 'SentinelOne threat')`,
      rank: edrSeverityRank(s1Threats.severity),
      edrStatus: s1Threats.status,
      status: sql<string | null>`null::text`,
      deviceId: s1Threats.deviceId,
      detectedAt: sql<Date>`coalesce(${s1Threats.detectedAt}, ${s1Threats.createdAt})`,
      trackedIncidentId: sql<string | null>`null::uuid`,
    })
    .from(s1Threats)
    .where(
      and(
        orgS1.condition,
        sql`NOT EXISTS (SELECT 1 FROM incidents i WHERE i.org_id = ${s1Threats.orgId}
          AND i.source_type = 's1_threat' AND i.source_ref = ${s1Threats.s1ThreatId})`
      )
    );

  // Apply kind/source filtering by selecting only the relevant legs.
  const legs = [];
  if (params.kind !== 'finding' && params.source !== 'huntress' && params.source !== 's1') legs.push(trackedQ);
  if (params.kind !== 'tracked' && (params.source === undefined || params.source === 'huntress')) legs.push(huntressQ);
  if (params.kind !== 'tracked' && (params.source === undefined || params.source === 's1')) legs.push(s1Q);
  if (legs.length === 0) return { rows: [], total: 0 };

  const union = legs.length === 1 ? legs[0]! : unionAll(legs[0]!, ...legs.slice(1));
  const sub = union.as('feed');

  const [countRows, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(sub),
    db
      .select()
      .from(sub)
      .orderBy(sql`rank asc`, sql`detected_at desc`)
      .limit(params.limit)
      .offset(params.offset),
  ]);

  return {
    rows: rows.map((r) => ({
      kind: r.kind,
      source: r.source,
      sourceId: r.sourceId,
      title: r.title,
      severity: severityRankToLabel(Number(r.rank)),
      edrStatus: r.edrStatus,
      status: r.status,
      deviceId: r.deviceId,
      detectedAt: new Date(r.detectedAt as unknown as string).toISOString(),
      trackedIncidentId: r.trackedIncidentId,
    })),
    total: Number(countRows[0]?.count ?? 0),
  };
}
```

(`PgColumn` is already imported at the top of this file; `db` and `AuthContext` too.)

- [ ] **Step 4: Run to verify the pure helper passes**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.helpers.test.ts`
Expected: PASS for `severityRankToLabel`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/incidents.helpers.ts apps/api/src/routes/incidents.helpers.test.ts
git commit -m "feat(incidents): feed projection helper (severity rank + union builder)"
```

---

### Task 4: `GET /incidents/feed` route

**Files:**
- Modify: `apps/api/src/routes/incidents.validation.ts` (add `listIncidentFeedSchema`)
- Modify: `apps/api/src/routes/incidents.ts` (mount `GET /feed` **before** `GET /:id`)
- Test: `apps/api/src/routes/incidents.test.ts`

**Interfaces:**
- Consumes: `buildIncidentFeed`, `FeedScopeError`, `IncidentFeedRow` (Task 3).
- Produces: `GET /incidents/feed` → `{ data: IncidentFeedRow[]; pagination: { page, limit, total } }`.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/incidents.test.ts` add (mock `buildIncidentFeed` from the helpers module, or assert against seeded Drizzle mocks consistent with the file's style):

```ts
it('GET /incidents/feed returns the unified union with pagination', async () => {
  const res = await app.request('/incidents/feed?limit=25', { headers: orgAuthHeaders });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({
    data: expect.any(Array),
    pagination: { page: 1, limit: 25 },
  });
});

it('GET /incidents/feed surfaces scope errors as their status', async () => {
  // org-scoped token requesting a foreign orgId -> 403 from resolveOrgFilter
  const res = await app.request('/incidents/feed?orgId=00000000-0000-0000-0000-000000000999', {
    headers: orgAuthHeaders,
  });
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.test.ts -t "incidents/feed"`
Expected: FAIL — route returns 404 (not mounted).

- [ ] **Step 3: Add the query schema**

In `apps/api/src/routes/incidents.validation.ts`:

```ts
export const listIncidentFeedSchema = z.object({
  orgId: z.string().guid().optional(),
  kind: z.enum(['tracked', 'finding']).optional(),
  source: z.enum(['breeze', 'huntress', 's1']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
```

- [ ] **Step 4: Add the route**

In `apps/api/src/routes/incidents.ts`, **above** the existing `incidentRoutes.get('/:id', ...)` (so `/feed` is not captured by `/:id`), add — importing `buildIncidentFeed`, `FeedScopeError`, and `listIncidentFeedSchema`:

```ts
incidentRoutes.get(
  '/feed',
  requireScope('organization', 'partner', 'system'),
  requireIncidentRead,
  zValidator('query', listIncidentFeedSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const limit = query.limit;
    const offset = (query.page - 1) * limit;

    try {
      const { rows, total } = await buildIncidentFeed(auth, {
        orgId: query.orgId,
        kind: query.kind,
        source: query.source,
        limit,
        offset,
      });
      return c.json({
        data: rows,
        pagination: { page: query.page, limit, total },
      });
    } catch (err) {
      if (err instanceof FeedScopeError) {
        return c.json({ error: err.message }, err.status as ContentfulStatusCode);
      }
      throw err;
    }
  }
);
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.test.ts -t "incidents/feed"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/incidents.validation.ts apps/api/src/routes/incidents.ts apps/api/src/routes/incidents.test.ts
git commit -m "feat(incidents): GET /incidents/feed unified EDR + tracked union"
```

---

### Task 5: Web — promote mappers set the source link

**Files:**
- Modify: `apps/web/src/lib/incidents.ts`
- Test: `apps/web/src/lib/incidents.test.ts`

**Interfaces:**
- Consumes: `POST /incidents` now accepting `sourceType`/`sourceRef` (Task 2).
- Produces: `CreateIncidentInput` gains optional `sourceType: 'huntress_incident' | 's1_threat'` and `sourceRef: string`; both mappers populate them.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/lib/incidents.test.ts`, extend the mapper describe block:

```ts
it('s1ThreatToIncident sets the s1 source link', () => {
  const input = s1ThreatToIncident({ id: 't1', orgId: 'org-1', deviceId: 'dev-9', deviceName: 'PC',
    s1ThreatId: 's1-xyz', threatName: 'Emotet', severity: 'critical', status: 'active',
    detectedAt: '2026-06-20T00:00:00Z' } as any);
  expect(input.sourceType).toBe('s1_threat');
  expect(input.sourceRef).toBe('s1-xyz');
});

it('huntressIncidentToIncident sets the huntress source link', () => {
  const input = huntressIncidentToIncident({ id: 'i1', orgId: 'org-1', deviceId: 'dev-9',
    huntressIncidentId: 'hunt-1', title: 'Bad login', severity: 'high', status: 'open',
    reportedAt: '2026-06-20T00:00:00Z' } as any);
  expect(input.sourceType).toBe('huntress_incident');
  expect(input.sourceRef).toBe('hunt-1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && pnpm vitest run src/lib/incidents.test.ts -t "source link"`
Expected: FAIL — `sourceType`/`sourceRef` undefined.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/incidents.ts`, extend the interface:

```ts
export interface CreateIncidentInput {
  orgId: string;
  title: string;
  classification: string;
  severity: IncidentSeverity;
  summary?: string;
  affectedDevices?: string[];
  detectedAt?: string;
  sourceType?: 'huntress_incident' | 's1_threat';
  sourceRef?: string;
}
```

In `s1ThreatToIncident`'s returned object add:

```ts
    sourceType: 's1_threat',
    sourceRef: t.s1ThreatId,
```

In `huntressIncidentToIncident`'s returned object add:

```ts
    sourceType: 'huntress_incident',
    sourceRef: i.huntressIncidentId,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && pnpm vitest run src/lib/incidents.test.ts`
Expected: PASS (existing mapper tests still green).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/incidents.ts apps/web/src/lib/incidents.test.ts
git commit -m "feat(web): promote mappers set EDR source link"
```

---

### Task 6: Web — Incidents page renders the unified feed

**Files:**
- Modify: `apps/web/src/components/incidents/IncidentsPage.tsx`
- Test: `apps/web/src/components/incidents/IncidentsPage.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `GET /incidents/feed` → `{ data: IncidentFeedRow[]; pagination }` (Task 4).
- Produces: list rows with a source badge (`Breeze`/`Huntress`/`SentinelOne`), a `All · Tracked · Findings` filter, Promote affordance hint on findings, and a link-out for findings.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/incidents/IncidentsPage.test.tsx` (mock `fetchWithAuth` to return a feed payload; follow the jsdom + Toast-mock conventions used by sibling component tests):

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import IncidentsPage from './IncidentsPage';

function feed(rows: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data: rows, pagination: { page: 1, limit: 25, total: rows.length } }) } as Response;
}
beforeEach(() => fetchWithAuth.mockReset());

describe('IncidentsPage feed', () => {
  it('renders source badges for tracked and finding rows', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([
      { kind: 'tracked', source: 'breeze', sourceId: 'i1', title: 'War room', severity: 'p1', edrStatus: null, status: 'analyzing', deviceId: null, detectedAt: '2026-06-20T00:00:00Z', trackedIncidentId: 'i1' },
      { kind: 'finding', source: 'huntress', sourceId: 'hunt-1', title: 'Huntress: Bad login', severity: 'p2', edrStatus: 'open', status: null, deviceId: 'd1', detectedAt: '2026-06-19T00:00:00Z', trackedIncidentId: null },
    ]));
    render(<IncidentsPage />);
    await waitFor(() => expect(screen.getByText('War room')).toBeInTheDocument());
    expect(screen.getByText('Huntress')).toBeInTheDocument();
    expect(screen.getByText('Bad login', { exact: false })).toBeInTheDocument();
  });

  it('hits /incidents/feed', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([]));
    render(<IncidentsPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(fetchWithAuth.mock.calls[0][0]).toContain('/incidents/feed');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && pnpm vitest run src/components/incidents/IncidentsPage.test.tsx`
Expected: FAIL — page still calls `/incidents` and has no badge.

- [ ] **Step 3: Rework the page to the feed**

In `apps/web/src/components/incidents/IncidentsPage.tsx`:
- Replace the `Incident` interface with the `IncidentFeedRow` shape (`kind`, `source`, `sourceId`, `severity`, `edrStatus`, `status`, `deviceId`, `detectedAt`, `trackedIncidentId`).
- Change the fetch URL from `/incidents?...` to `/incidents/feed?...`, keeping the `page`/`limit` params; add an optional `kind` param driven by a new filter state (`'' | 'tracked' | 'finding'`) replacing the old status/severity filters (severity filter may stay).
- Render per row: a **source badge** mapping `source` → label (`breeze`→`Breeze`, `huntress`→`Huntress`, `s1`→`SentinelOne`) with the existing `severityColors` chip for `severity`.
- For `kind === 'tracked'`: clicking the row calls `navigateTo('/incidents/' + row.trackedIncidentId)`; show `status` chip.
- For `kind === 'finding'`: show `edrStatus` text and a "View in {source}" external link (`linkOut` if present on the row — see Task 4 note; until link-out URLs are wired, render the badge + a non-link "Promote from the EDR view" hint). Do not make finding rows navigate to `/incidents/:id`.

Concretely, add the badge map near the existing `severityColors`:

```tsx
const sourceLabels: Record<'breeze' | 'huntress' | 's1', string> = {
  breeze: 'Breeze',
  huntress: 'Huntress',
  s1: 'SentinelOne',
};
const sourceBadge: Record<'breeze' | 'huntress' | 's1', string> = {
  breeze: 'bg-gray-100 text-gray-800 dark:bg-gray-700/40 dark:text-gray-200',
  huntress: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  s1: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
};
```

and render `<span className={...sourceBadge[row.source]}>{sourceLabels[row.source]}</span>` in each row.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/web && pnpm vitest run src/components/incidents/IncidentsPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Type-check the web app**

Run: `cd apps/web && pnpm astro check`
Expected: no new type errors in `IncidentsPage.tsx`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/incidents/IncidentsPage.tsx apps/web/src/components/incidents/IncidentsPage.test.tsx
git commit -m "feat(web): Incidents page renders unified EDR + tracked feed"
```

---

### Task 7: Link-out URL resolution (findings → EDR console)

**Files:**
- Modify: `apps/api/src/routes/incidents.helpers.ts` (`buildIncidentFeed` projection — add `linkOut`)
- Modify: `apps/web/src/components/incidents/IncidentsPage.tsx` (render the link)
- Test: `apps/api/src/routes/incidents.helpers.test.ts`

**Interfaces:**
- Produces: `IncidentFeedRow.linkOut: string | null` — a Huntress/S1 console URL when derivable from the row, else `null`.

> **Plan-time decision (from spec §4):** Neither EDR table stores a portal URL. First check whether `details` jsonb on `huntress_incidents` / `s1_threats` already carries a `portalUrl`/`url` field (grep the sync writers `huntressSync.ts` / `s1Sync.ts` for what they put in `details`). If yes, surface it. If no, derive a best-effort console root URL and accept that it links to the console rather than the specific record. Do NOT block the feature on exact deep-links.

- [ ] **Step 1: Investigate what `details` contains**

Run: `grep -n "details" apps/api/src/jobs/huntressSync.ts apps/api/src/jobs/s1Sync.ts`
Record whether a per-record URL is stored. This determines Step 3's implementation.

- [ ] **Step 2: Write the failing test**

In `apps/api/src/routes/incidents.helpers.test.ts`:

```ts
import { resolveFindingLinkOut } from './incidents.helpers';

describe('resolveFindingLinkOut', () => {
  it('returns the stored portal url when present', () => {
    expect(resolveFindingLinkOut('huntress', { portalUrl: 'https://huntress.io/x' })).toBe('https://huntress.io/x');
  });
  it('returns null when no url is derivable', () => {
    expect(resolveFindingLinkOut('s1', null)).toBeNull();
  });
});
```

- [ ] **Step 3: Implement `resolveFindingLinkOut` and wire it into the projection**

In `apps/api/src/routes/incidents.helpers.ts`:

```ts
export function resolveFindingLinkOut(
  source: 'huntress' | 's1',
  details: unknown
): string | null {
  if (details && typeof details === 'object') {
    const d = details as Record<string, unknown>;
    const url = d.portalUrl ?? d.url ?? d.link;
    if (typeof url === 'string' && /^https:\/\//.test(url)) return url;
  }
  return null;
}
```

Add `details` to the huntress/s1 select legs (`details: huntressIncidents.details` / `s1Threats.details`) and `linkOut: sql<null>\`null\`` to the tracked leg so the union columns line up; in the final `rows.map`, compute `linkOut: r.source === 'breeze' ? null : resolveFindingLinkOut(r.source, r.details)`. Add `linkOut: string | null` to `IncidentFeedRow`.

- [ ] **Step 4: Render the link on findings**

In `IncidentsPage.tsx`, for `kind === 'finding'` rows, when `row.linkOut` is set render an anchor `<a href={row.linkOut} target="_blank" rel="noopener noreferrer">View in {sourceLabels[row.source]}</a>`; otherwise render the static hint text.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.helpers.test.ts && cd ../web && pnpm vitest run src/components/incidents/IncidentsPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/incidents.helpers.ts apps/api/src/routes/incidents.helpers.test.ts apps/web/src/components/incidents/IncidentsPage.tsx
git commit -m "feat(incidents): derive EDR console link-out for findings"
```

---

### Task 8: RLS verification + full suite

**Files:** none (verification only).

- [ ] **Step 1: Verify the feed honors RLS as `breeze_app`**

With the worktree stack up, confirm a cross-tenant probe: query `/incidents/feed` as an org-A token and confirm no org-B Huntress/S1 rows appear. Spot-check directly:

Run: `docker exec -it breeze-postgres psql -U breeze_app -d breeze -c "SELECT count(*) FROM huntress_incidents;"`
Expected: governed by RLS context (0 without a set org context) — confirms the union legs can't leak across tenants.

- [ ] **Step 2: Run the affected suites**

Run: `cd apps/api && pnpm vitest run src/routes/incidents.test.ts src/routes/incidents.helpers.test.ts src/db/autoMigrate.test.ts`
Run: `cd apps/web && pnpm vitest run src/lib/incidents.test.ts src/components/incidents/IncidentsPage.test.tsx`
Expected: all PASS.

- [ ] **Step 3: Type-check both apps**

Run: `cd apps/api && pnpm typecheck && cd ../web && pnpm astro check`
Expected: no new errors.

- [ ] **Step 4: Final commit (if any cleanup)**

```bash
git add -A && git commit -m "test(incidents): verify EDR feed RLS + suites" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Two-tier model / unified list → Tasks 4, 6. ✅
- Show all Huntress + S1, no gating → Task 3 builder (no severity filter). ✅
- Source-link dedup/suppression → Tasks 1, 2, 3 (`NOT EXISTS`), 5 (promote sets link). ✅
- Scope via `resolveOrgFilter` (org + partner/fleet) → Task 3. ✅
- Severity normalization → Task 3 (`edrSeverityRank` + `severityRankToLabel`). ✅
- `affected_users` ITDR hook → Task 1. ✅
- Existing `GET /incidents` untouched → confirmed (new `/feed` route only). ✅
- Link-out with fallback → Task 7. ✅
- Out of scope (auto-file, config gating, resolve client, ITDR ingestion) → none added. ✅
- Testing (projection, route, migration idempotency, RLS, component) → Tasks 1,3,4,6,8. ✅

**Placeholder scan:** Task 7 carries an explicit investigate-first step with a concrete fallback (console-root link), not a TODO — acceptable per spec §4. No bare "add validation"/"handle edge cases" steps.

**Type consistency:** `IncidentFeedRow` defined in Task 3 is consumed verbatim in Tasks 4/6/7; `sourceType`/`sourceRef` names match across schema (Task 1), validation+insert (Task 2), mappers (Task 5), and suppression predicate (Task 3). `severityRankToLabel`/`edrSeverityRank` names consistent.
