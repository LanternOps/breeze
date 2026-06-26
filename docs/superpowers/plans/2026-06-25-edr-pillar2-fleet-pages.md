# EDR Pillar 2 — Fleet EDR Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A Security → EDR area with two hash-routed tabs — **SentinelOne Threats** and **Huntress Incidents** — listing the partner's fleet (all customer orgs) with filters, row→device navigation, and inline S1 threat actions. Consumes existing endpoints plus one small additive API change so SentinelOne can list partner-wide like Huntress already does.

**Architecture:** One backend change (`GET /s1/threats` gains a partner-wide branch mirroring the existing `GET /huntress/incidents` pattern). Web: generalize the `edr.ts` fetchers to a filter object returning `{ rows, total }`; add an `EdrPage` tab shell (hash routing), two list components reusing `ResponsiveTable`/badge patterns from `ThreatList.tsx`, an astro page, and a Sidebar entry.

**Tech Stack:** Hono + Drizzle (API), Astro + React islands + Tailwind (web), Vitest (both).

## Global Constraints

**Decision (from phase brainstorm):** Option A — partner-wide S1 via a small API change, NOT an org-selector. Both tabs list partner-wide by default; org-scoped users auto-scope to their org; `orgId` is an optional filter.

**API contracts after this pillar:**
- `GET /s1/threats` accepts `{ partnerId?, orgId?, integrationId?, deviceId?, status?, severity?, search?, start?, end?, limit?(1-500,def 100), offset?(>=0) }` → `{ data: S1Threat[], pagination: { total, limit, offset } }`. After Task 1: a **partner-scoped** caller with no `orgId` (and >1 accessible org) gets threats across all the partner's active-integration orgs instead of a 400.
- `GET /huntress/incidents` (unchanged) accepts `{ partnerId?, orgId?, integrationId?, status?, severity?, deviceId?, search?, limit?, offset? }` → `{ data: HuntressIncident[], total, limit, offset }` (flat — note: NO `pagination` wrapper, unlike S1). Already partner-wide.
- `POST /s1/threat-action` body `{ orgId?, action: 'kill'|'quarantine'|'rollback', threatIds: [rowId] }`; MFA + `devices:execute`. (Reused from Pillar 1 via `runS1ThreatAction`.)

**Tenancy/RLS (Task 1 is security-sensitive):** `s1_threats` is org-axis RLS (`breeze_has_org_access(org_id)`). The partner-wide read does NOT change the table's tenancy shape — it relies on the SAME `auth.orgCondition(s1Threats.orgId)` filter the handler already applies (line 626) plus an `integrationId IN (partner's active integrations)` narrowing. This mirrors `huntress.ts` `GET /incidents` lines 865-882 verbatim in shape. No new table, no allowlist change; `rls-coverage.integration.test.ts` must stay green unchanged.

**Conventions:** mutations through `runAction`; reads via `fetchWithAuth`; tab/sub-tab state in `window.location.hash` (NOT query params); tests mock fetch by URL+method (not positional); `ResponsiveTable` renders desktop+mobile (scope assertions to `responsive-table-desktop` to avoid the jsdom dup-render gotcha); files ~500 lines soft cap.

## File Structure
- Modify: `apps/api/src/routes/sentinelOne.ts` (GET /threats partner-wide branch) + `apps/api/src/routes/sentinelOne.test.ts`.
- Modify: `apps/web/src/lib/edr.ts` (+ `edr.test.ts`) — filter-object fetchers returning `{ rows, total }`; update Pillar 1 `DeviceEdrPanel.tsx` callers + its test.
- Create: `apps/web/src/components/security/EdrPage.tsx` (+ test), `S1ThreatList.tsx` (+ test), `HuntressIncidentList.tsx` (+ test).
- Create: `apps/web/src/pages/security/edr.astro`.
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (Security → EDR entry).

---

### Task 1: `GET /s1/threats` partner-wide branch (API)

**Files:**
- Modify: `apps/api/src/routes/sentinelOne.ts` — the `GET /threats` handler (lines 601-710).
- Test: `apps/api/src/routes/sentinelOne.test.ts`.

**Interfaces:**
- Produces: `/s1/threats` returns partner-wide rows for partner-scoped callers without `orgId`. Org-scoped behavior unchanged.

**Context — the template to mirror** is `apps/api/src/routes/huntress.ts` GET `/incidents` (lines 840-882): it computes a nullable `scopedOrgId`, and when there's no org scope but the caller is partner-scoped, it resolves the partner's active integrations and pushes `inArray(<table>.integrationId, integrationIds)` plus `auth.orgCondition`. Read it before editing.

- [ ] **Step 1: Write the failing test.** In `sentinelOne.test.ts`, mirror the existing `GET /threats` org-scope test (find it; copy its app/mock/auth harness). Add a partner-scope case:

```ts
it('GET /threats lists across all partner orgs for a partner-scoped caller without orgId', async () => {
  // auth: scope 'partner', partnerId set, accessibleOrgIds = [orgA, orgB] (>1 so the old code would 400)
  // mock: two active s1_integrations for the partner; s1_threats rows in orgA and orgB
  const res = await app.request('/threats', { headers: partnerAuthHeaders });
  expect(res.status).toBe(200);
  const body = await res.json();
  // both orgs' threats returned (no 400 'orgId is required')
  expect(body.data.map((t: any) => t.orgId).sort()).toEqual([orgA, orgB].sort());
});
```

Also keep/confirm an org-scope case still returns only that org's rows. Match the file's existing mock style for `db.select(...).from(s1Threats)` exactly — do not invent a new harness.

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/sentinelOne.test.ts -t "partner orgs"`
Expected: FAIL (400 "orgId is required for this scope").

- [ ] **Step 3: Implement the partner-wide branch.** In the `GET /threats` handler, replace the unconditional `resolveOrgId` + single-org pin with a Huntress-shaped branch. The current head is:

```ts
const auth = c.get('auth');
const query = c.req.valid('query');
const orgResult = resolveOrgId(auth, query.orgId);
if ('error' in orgResult) {
  return c.json({ error: orgResult.error }, orgResult.status);
}
// ... timestamp validation ...
const conditions: SQL[] = [eq(s1Threats.orgId, orgResult.orgId)];
withOrgCondition(conditions, auth.orgCondition(s1Threats.orgId));
```

Change it to compute an optional org scope and branch (mirror huntress.ts:840-882):

```ts
const auth = c.get('auth');
const query = c.req.valid('query');

// Org scope when the caller is org-scoped or explicitly asked for one org.
const requestedOrg = query.orgId;
const wantsOrgScope = requestedOrg || auth.scope === 'organization';
const orgResult = wantsOrgScope ? resolveOrgId(auth, requestedOrg) : null;
if (orgResult && 'error' in orgResult) {
  return c.json({ error: orgResult.error }, orgResult.status);
}
const scopedOrgId = orgResult && 'orgId' in orgResult ? orgResult.orgId : null;

// ... keep the existing start/end timestamp validation here ...

const conditions: SQL[] = [];
if (scopedOrgId) {
  conditions.push(eq(s1Threats.orgId, scopedOrgId));
}
withOrgCondition(conditions, auth.orgCondition(s1Threats.orgId));

// Partner-wide: no single org → restrict to the partner's active integrations.
if (!scopedOrgId) {
  const partnerResult = resolvePartnerId(auth, query.partnerId);
  if ('error' in partnerResult) return c.json({ error: partnerResult.error }, partnerResult.status);
  const integrations = await db
    .select({ id: s1Integrations.id })
    .from(s1Integrations)
    .where(and(eq(s1Integrations.partnerId, partnerResult.partnerId), eq(s1Integrations.isActive, true)));
  const integrationIds = integrations.map((i) => i.id);
  if (integrationIds.length === 0) {
    return c.json({ data: [], pagination: { total: 0, limit: query.limit ?? 100, offset: query.offset ?? 0 } });
  }
  conditions.push(inArray(s1Threats.integrationId, integrationIds));
}
```

Then the **site-scope narrowing block** (the `if (perms?.allowedSiteIds)` section) must only run when `scopedOrgId` is set — site restriction is an org-user concept and `resolveSiteAllowedDeviceIds` needs an orgId. Guard it: `if (perms?.allowedSiteIds && scopedOrgId) { ... resolveSiteAllowedDeviceIds(scopedOrgId, perms) ... }`. Leave the rest of the handler (filters, query, response) unchanged — it already reads `query.integrationId/deviceId/status/severity/start/end/search` and returns `{ data, pagination }`.

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/sentinelOne.test.ts`
Expected: PASS (new partner case + existing org cases).

- [ ] **Step 5: Confirm RLS coverage unaffected.**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: clean. (No schema/tenancy change → `rls-coverage` allowlists need no edit; do not modify that test.)

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/routes/sentinelOne.ts apps/api/src/routes/sentinelOne.test.ts
git commit -m "feat(api): partner-wide GET /s1/threats (mirror huntress incidents fleet listing)"
```

---

### Task 2: Generalize `edr.ts` fetchers to filter objects (and update Pillar 1)

**Files:**
- Modify: `apps/web/src/lib/edr.ts`, `apps/web/src/lib/edr.test.ts`.
- Modify: `apps/web/src/components/devices/DeviceEdrPanel.tsx` (callers), `apps/web/src/components/devices/DeviceEdrPanel.test.tsx` (mock URLs unchanged, but verify).

**Interfaces:**
- Produces:
  `type S1ThreatFilters = { orgId?: string; deviceId?: string; status?: string; severity?: string; search?: string; start?: string; end?: string; limit?: number; offset?: number }`
  `type HuntressIncidentFilters = { orgId?: string; deviceId?: string; status?: string; severity?: string; search?: string; limit?: number; offset?: number }`
  `fetchS1Threats(filters: S1ThreatFilters): Promise<{ rows: S1Threat[]; total: number }>`
  `fetchHuntressIncidents(filters: HuntressIncidentFilters): Promise<{ rows: HuntressIncident[]; total: number }>`
  (`isolateDevice`, `runS1ThreatAction` unchanged.)

- [ ] **Step 1: Update the fetcher unit tests.** In `edr.test.ts`, change the two fetcher tests to the new shape:

```ts
it('passes filters and returns { rows, total } from the pagination shape', async () => {
  fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 't1' }], pagination: { total: 5, limit: 100, offset: 0 } }));
  const { rows, total } = await fetchS1Threats({ orgId: 'org-1', deviceId: 'dev-1' });
  expect(rows).toEqual([{ id: 't1' }]);
  expect(total).toBe(5);
  const url = fetchWithAuth.mock.calls[0][0] as string;
  expect(url).toContain('/s1/threats');
  expect(url).toContain('orgId=org-1');
  expect(url).toContain('deviceId=dev-1');
});

it('reads { rows, total } from the Huntress flat shape and omits empty filters', async () => {
  fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 'i1' }], total: 3, limit: 100, offset: 0 }));
  const { rows, total } = await fetchHuntressIncidents({ severity: 'high' });
  expect(rows).toEqual([{ id: 'i1' }]);
  expect(total).toBe(3);
  const url = fetchWithAuth.mock.calls[0][0] as string;
  expect(url).toContain('/huntress/incidents');
  expect(url).toContain('severity=high');
  expect(url).not.toContain('orgId='); // undefined filters are omitted
});
```

- [ ] **Step 2: Run, verify fail.**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/edr.test.ts`
Expected: FAIL (old signature).

- [ ] **Step 3: Refactor the fetchers.** Replace the two fetcher bodies in `edr.ts`:

```ts
export interface S1ThreatFilters {
  orgId?: string; deviceId?: string; status?: string; severity?: string;
  search?: string; start?: string; end?: string; limit?: number; offset?: number;
}
export interface HuntressIncidentFilters {
  orgId?: string; deviceId?: string; status?: string; severity?: string;
  search?: string; limit?: number; offset?: number;
}

function toParams(filters: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  return p.toString();
}

export async function fetchS1Threats(filters: S1ThreatFilters = {}): Promise<{ rows: S1Threat[]; total: number }> {
  const qs = toParams({ limit: 100, ...filters });
  const res = await fetchWithAuth(`/s1/threats?${qs}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) { console.warn('[edr] /s1/threats returned non-array data'); return { rows: [], total: 0 }; }
  return { rows: body.data as S1Threat[], total: Number(body?.pagination?.total ?? body.data.length) };
}

// Huntress returns a FLAT { data, total, limit, offset } envelope (not the S1 { data, pagination } shape).
export async function fetchHuntressIncidents(filters: HuntressIncidentFilters = {}): Promise<{ rows: HuntressIncident[]; total: number }> {
  const qs = toParams({ limit: 100, ...filters });
  const res = await fetchWithAuth(`/huntress/incidents?${qs}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) { console.warn('[edr] /huntress/incidents returned non-array data'); return { rows: [], total: 0 }; }
  return { rows: body.data as HuntressIncident[], total: Number(body?.total ?? body.data.length) };
}
```

- [ ] **Step 4: Update the Pillar 1 panel callers.** In `DeviceEdrPanel.tsx` `load()`, change:

```ts
const [s1, hi] = await Promise.all([
  fetchS1Threats(orgId, deviceId),
  fetchHuntressIncidents(orgId, deviceId),
]);
setThreats(s1);
setIncidents(hi);
```

to:

```ts
const [s1, hi] = await Promise.all([
  fetchS1Threats({ orgId, deviceId, limit: 50 }),
  fetchHuntressIncidents({ orgId, deviceId, limit: 50 }),
]);
setThreats(s1.rows);
setIncidents(hi.rows);
```

- [ ] **Step 5: Run web suites, verify green.**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/edr.test.ts src/components/devices/DeviceEdrPanel.test.tsx`
Expected: PASS. (The panel tests mock `fetchWithAuth` by URL; URLs still contain `orgId`+`deviceId`, so they pass unchanged.)
Run: `pnpm --filter @breeze/web exec tsc --noEmit` → clean.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/edr.ts apps/web/src/lib/edr.test.ts apps/web/src/components/devices/DeviceEdrPanel.tsx
git commit -m "refactor(web): edr fetchers take filter objects, return { rows, total }"
```

---

### Task 3: EdrPage tab shell + astro page + Sidebar entry

**Files:**
- Create: `apps/web/src/components/security/EdrPage.tsx`, `apps/web/src/components/security/EdrPage.test.tsx`.
- Create: `apps/web/src/pages/security/edr.astro`.
- Modify: `apps/web/src/components/layout/Sidebar.tsx`.

**Interfaces:**
- Consumes (Tasks 4-5, may be stubbed until then): `S1ThreatList`, `HuntressIncidentList` (default exports, no required props).
- Produces: `default function EdrPage()` with hash-routed tabs `'sentinelone' | 'huntress'`.

- [ ] **Step 1: Write the failing test.** `EdrPage.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
vi.mock('./S1ThreatList', () => ({ default: () => <div data-testid="s1-list" /> }));
vi.mock('./HuntressIncidentList', () => ({ default: () => <div data-testid="huntress-list" /> }));
import EdrPage from './EdrPage';

describe('EdrPage', () => {
  it('defaults to the SentinelOne tab and switches to Huntress', () => {
    render(<EdrPage />);
    expect(screen.getByTestId('s1-list')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edr-tab-huntress'));
    expect(screen.getByTestId('huntress-list')).toBeInTheDocument();
    expect(window.location.hash).toBe('#huntress');
  });
});
```

- [ ] **Step 2: Run, verify fail** (`cannot resolve ./EdrPage`).

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/EdrPage.test.tsx`

- [ ] **Step 3: Implement EdrPage.** Use the hash pattern from `DeviceDetails.tsx` (read on mount, `hashchange` listener, write on switch):

```tsx
import { useEffect, useState } from 'react';
import { ShieldAlert, Activity } from 'lucide-react';
import S1ThreatList from './S1ThreatList';
import HuntressIncidentList from './HuntressIncidentList';

type EdrTab = 'sentinelone' | 'huntress';
const TABS: { id: EdrTab; label: string; testid: string }[] = [
  { id: 'sentinelone', label: 'SentinelOne Threats', testid: 'edr-tab-sentinelone' },
  { id: 'huntress', label: 'Huntress Incidents', testid: 'edr-tab-huntress' },
];

function tabFromHash(): EdrTab {
  if (typeof window === 'undefined') return 'sentinelone';
  const h = window.location.hash.replace(/^#/, '');
  return h === 'huntress' ? 'huntress' : 'sentinelone';
}

export default function EdrPage() {
  const [activeTab, setActiveTab] = useState<EdrTab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const switchTab = (t: EdrTab) => { window.location.hash = t; setActiveTab(t); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Endpoint Detection &amp; Response</h1>
        <p className="text-sm text-muted-foreground">Threats and incidents across your fleet from SentinelOne and Huntress.</p>
      </div>
      <div className="flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            data-testid={t.testid}
            onClick={() => switchTab(t.id)}
            className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${activeTab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t.id === 'sentinelone' ? <ShieldAlert className="h-4 w-4" /> : <Activity className="h-4 w-4" />}
            {t.label}
          </button>
        ))}
      </div>
      {activeTab === 'sentinelone' ? <S1ThreatList /> : <HuntressIncidentList />}
    </div>
  );
}
```

- [ ] **Step 4: Create stubs so the shell compiles + test passes.** Create minimal `S1ThreatList.tsx` and `HuntressIncidentList.tsx` (replaced in Tasks 4-5):

```tsx
export default function S1ThreatList() { return <div data-testid="s1-list" />; }
```
```tsx
export default function HuntressIncidentList() { return <div data-testid="huntress-list" />; }
```

- [ ] **Step 5: Run, verify pass.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/EdrPage.test.tsx`
Expected: PASS.

- [ ] **Step 6: Create the astro page.** `apps/web/src/pages/security/edr.astro` (mirror `vulnerabilities.astro`):

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import EdrPage from '../../components/security/EdrPage';
import Breadcrumbs from '../../components/layout/Breadcrumbs';
---

<DashboardLayout title="EDR">
  <Breadcrumbs client:load items={[{ label: 'Security', href: '/security' }, { label: 'EDR' }]} />
  <EdrPage client:load />
</DashboardLayout>
```

- [ ] **Step 7: Add the Sidebar entry.** In `Sidebar.tsx`, in the `security` section `items` array, add after the `'Security'` entry:

```tsx
{ name: 'EDR', href: '/security/edr', icon: ShieldAlert, requiredPermission: { resource: 'devices', action: 'read' } },
```

Ensure `ShieldAlert` is imported from `lucide-react` (add to the existing import if absent).

- [ ] **Step 8: Typecheck + commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/security/EdrPage.tsx apps/web/src/components/security/EdrPage.test.tsx apps/web/src/components/security/S1ThreatList.tsx apps/web/src/components/security/HuntressIncidentList.tsx apps/web/src/pages/security/edr.astro apps/web/src/components/layout/Sidebar.tsx
git commit -m "feat(web): EDR page shell (hash tabs) + astro route + sidebar entry"
```

---

### Task 4: S1ThreatList — fleet SentinelOne threats with filters + actions

**Files:**
- Modify: `apps/web/src/components/security/S1ThreatList.tsx` (replace the stub).
- Test: `apps/web/src/components/security/S1ThreatList.test.tsx`.

**Interfaces:**
- Consumes: `fetchS1Threats` (filter object → `{ rows, total }`), `runS1ThreatAction`, `S1Threat`, `S1ThreatActionType` (Task 2 / Pillar 1), `navigateTo` (`@/lib/navigation`).

**Template:** mirror `apps/web/src/components/security/ThreatList.tsx` for the `ResponsiveTable` desktop/cards scaffolding and the search/severity/status filter controls. Read it.

- [ ] **Step 1: Write the failing test.** `S1ThreatList.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
import S1ThreatList from './S1ThreatList';

function ok(b: unknown) { return { ok: true, status: 200, json: async () => b } as Response; }
beforeEach(() => { fetchWithAuth.mockReset(); navigateTo.mockReset(); });

describe('S1ThreatList', () => {
  it('lists threats and navigates to the device on row click', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [{ id: 't1', deviceId: 'dev-9', deviceName: 'PC-1', threatName: 'Emotet', severity: 'high', status: 'active', detectedAt: '2026-06-20T00:00:00Z' }], pagination: { total: 1, limit: 100, offset: 0 } }));
      return Promise.resolve(ok({ data: [] }));
    });
    render(<S1ThreatList />);
    const desktop = await screen.findByTestId('responsive-table-desktop');
    expect(within(desktop).getByText('Emotet')).toBeInTheDocument();
    fireEvent.click(within(desktop).getByTestId('s1-row-t1'));
    expect(navigateTo).toHaveBeenCalledWith('/devices/dev-9');
  });

  it('sends the severity filter in the query', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [], pagination: { total: 0, limit: 100, offset: 0 } }));
    render(<S1ThreatList />);
    fireEvent.change(await screen.findByTestId('s1-filter-severity'), { target: { value: 'critical' } });
    await waitFor(() => expect((fetchWithAuth.mock.calls.at(-1)?.[0] as string)).toContain('severity=critical'));
  });

  it('POSTs a threat action with the row id', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [{ id: 't1', deviceId: 'dev-9', threatName: 'X', severity: 'high', status: 'active', detectedAt: '2026-06-20T00:00:00Z' }], pagination: { total: 1, limit: 100, offset: 0 } }));
      if (url === '/s1/threat-action') { body = JSON.parse(String(init?.body)); return Promise.resolve(ok({ data: {} })); }
      return Promise.resolve(ok({ data: [] }));
    });
    render(<S1ThreatList />);
    const desktop = await screen.findByTestId('responsive-table-desktop');
    fireEvent.click(within(desktop).getByTestId('s1-threat-quarantine-t1'));
    await waitFor(() => expect(body).toEqual({ orgId: undefined, action: 'quarantine', threatIds: ['t1'] }));
  });
});
```

(Note: `orgId: undefined` — the fleet list passes no orgId; the threat's own org is resolved server-side from the threat row. If `runS1ThreatAction` requires an orgId, pass `threat.orgId` instead and update this assertion to that value. Confirm against the Pillar 1 `runS1ThreatAction` signature: `runS1ThreatAction(orgId, threatId, action)` — so pass `threat.orgId` and assert `orgId: 'org-...'`. Use the threat's `orgId` field.)

- [ ] **Step 2: Run, verify fail.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/S1ThreatList.test.tsx`
Expected: FAIL (stub renders nothing).

- [ ] **Step 3: Implement S1ThreatList.** Mirror `ThreatList.tsx` structure. Requirements:
  - State: `rows: S1Threat[]`, `loading`, `error`, `total`, and filters `search`, `severity` ('all'|low|medium|high|critical), `status` ('all'|active|in_progress|quarantined|resolved), `start`, `end`, plus `actingId`.
  - `load()` (useCallback, deps = all filters): `const { rows, total } = await fetchS1Threats({ search: search||undefined, severity: severity==='all'?undefined:severity, status: status==='all'?undefined:status, start: start?new Date(start).toISOString():undefined, end: end?...:undefined, limit: 100 })`. try/catch → `friendlyFetchError`. No `orgId` (fleet/partner-wide).
  - Filter controls with testids: `s1-filter-search`, `s1-filter-severity`, `s1-filter-status`, plus date inputs and a Refresh button. Changing a `<select>` triggers `load()` (via the useEffect on filter state).
  - `ResponsiveTable` desktop `<table>`: columns Device, Threat, Severity (badge), Status (badge), Detected. Each row `<tr data-testid={\`s1-row-${t.id}\`}>` with `onClick={() => t.deviceId && navigateTo(\`/devices/${t.deviceId}\`)}` and `cursor-pointer`. Device cell shows `t.deviceName ?? '—'`. Threat name `{t.threatName ?? 'Unknown threat'}`. Severity `{t.severity ?? 'unknown'}` with the badge classes from ThreatList. For `t.status === 'active'`, render kill/quarantine/rollback buttons (testid `s1-threat-${action}-${t.id}`) calling `doThreatAction(t.orgId, t.id, action)` → `runS1ThreatAction(t.orgId, t.id, action)`; **stopPropagation** on the action cell so a button click doesn't trigger row navigation; disable while `actingId === t.id`; catch via `handleActionError`.
  - Provide a `cards` arm for mobile mirroring ThreatList (DataCard/CardField); scope tests to `responsive-table-desktop` to avoid dup-render assertions.
  - Loading and empty states; render the error banner (`data-testid="s1-error"`) when `error` set.

- [ ] **Step 4: Run, verify pass.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/S1ThreatList.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/security/S1ThreatList.tsx apps/web/src/components/security/S1ThreatList.test.tsx
git commit -m "feat(web): fleet SentinelOne threats list with filters + inline actions"
```

---

### Task 5: HuntressIncidentList — fleet Huntress incidents (read-only)

**Files:**
- Modify: `apps/web/src/components/security/HuntressIncidentList.tsx` (replace the stub).
- Test: `apps/web/src/components/security/HuntressIncidentList.test.tsx`.

**Interfaces:**
- Consumes: `fetchHuntressIncidents` (filter object → `{ rows, total }`), `HuntressIncident` (Task 2 / Pillar 1), `navigateTo`.

- [ ] **Step 1: Write the failing test.** `HuntressIncidentList.test.tsx` (mirror Task 4's test, minus actions):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
import HuntressIncidentList from './HuntressIncidentList';

function ok(b: unknown) { return { ok: true, status: 200, json: async () => b } as Response; }
beforeEach(() => { fetchWithAuth.mockReset(); navigateTo.mockReset(); });

describe('HuntressIncidentList', () => {
  it('lists incidents (flat envelope) and navigates to the device on row click', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [{ id: 'i1', deviceId: 'dev-3', deviceHostname: 'SRV-2', title: 'Persistence', severity: 'critical', status: 'open', category: 'malware', reportedAt: '2026-06-21T00:00:00Z' }], total: 1, limit: 100, offset: 0 }));
      return Promise.resolve(ok({ data: [] }));
    });
    render(<HuntressIncidentList />);
    const desktop = await screen.findByTestId('responsive-table-desktop');
    expect(within(desktop).getByText('Persistence')).toBeInTheDocument();
    fireEvent.click(within(desktop).getByTestId('huntress-row-i1'));
    expect(navigateTo).toHaveBeenCalledWith('/devices/dev-3');
  });

  it('sends the status filter in the query', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [], total: 0, limit: 100, offset: 0 }));
    render(<HuntressIncidentList />);
    fireEvent.change(await screen.findByTestId('huntress-filter-status'), { target: { value: 'open' } });
    await waitFor(() => expect((fetchWithAuth.mock.calls.at(-1)?.[0] as string)).toContain('status=open'));
  });
});
```

- [ ] **Step 2: Run, verify fail.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/HuntressIncidentList.test.tsx`

- [ ] **Step 3: Implement HuntressIncidentList.** Same structure as S1ThreatList minus actions (read-only):
  - State: `rows: HuntressIncident[]`, `loading`, `error`, `total`, filters `search`, `severity`, `status` ('all'|open|in_progress|resolved|dismissed). No date filters (the endpoint has none).
  - `load()`: `fetchHuntressIncidents({ search, severity, status, limit: 100 })` with the same omit-empty pattern. No orgId (partner-wide).
  - Filter testids: `huntress-filter-search`, `huntress-filter-severity`, `huntress-filter-status`, Refresh.
  - `ResponsiveTable` desktop columns: Device (`deviceHostname ?? '—'`), Title, Category, Severity (badge, `i.severity ?? 'unknown'`), Status (badge), Reported. Row `<tr data-testid={\`huntress-row-${i.id}\`}>` `onClick={() => i.deviceId && navigateTo(\`/devices/${i.deviceId}\`)}` cursor-pointer. Provide the `cards` mobile arm.
  - Loading/empty/error (`data-testid="huntress-error"`) states.

- [ ] **Step 4: Run, verify pass.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/HuntressIncidentList.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/security/HuntressIncidentList.tsx apps/web/src/components/security/HuntressIncidentList.test.tsx
git commit -m "feat(web): fleet Huntress incidents list (read-only)"
```

---

## Verification (end of pillar)
- [ ] `pnpm --filter @breeze/api exec vitest run src/routes/sentinelOne.test.ts` — green (partner + org cases).
- [ ] `pnpm --filter @breeze/web exec vitest run src/components/security src/components/devices src/lib/edr.test.ts` — green.
- [ ] `pnpm --filter @breeze/web exec tsc --noEmit` and `pnpm --filter @breeze/api exec tsc --noEmit` — clean.
- [ ] `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts` — green (add `S1ThreatList.tsx` to TARGET_GLOBS + bump count if its threat-action mutation should be enforced; note the count-drift gotcha).
- [ ] Manual (local, `PUBLIC_ENABLE_EDR_INTEGRATIONS` not required — fleet pages aren't flag-gated; confirm whether they SHOULD be before shipping): `/security/edr` lists threats/incidents partner-wide; tab hash works; row→device nav works; quarantine on an active S1 threat toasts + reloads.

## Notes for Pillar 3 / 4
- The fleet fetchers now return `{ rows, total }` — Pillar 3 dashboard widgets can reuse them for counts.
- "Promote to Incident" (Pillar 4) attaches to these rows; keep `id`/`deviceId`/`orgId` in row props.
- Decide before shipping: should the fleet pages be gated behind `ENABLE_EDR_INTEGRATIONS` like the device panel? (Pillar 1 is flag-gated; for consistency the nav entry + page likely should be too — raise with Todd.)
