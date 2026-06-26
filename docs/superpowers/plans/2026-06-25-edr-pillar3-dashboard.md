# EDR Pillar 3 — Dashboard Surfacing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface EDR posture on the Security dashboard — active SentinelOne threats, open Huntress incidents, and agent-coverage gaps — by fanning out client-side to the existing `/s1/status` and `/huntress/status` endpoints. No API change.

**Architecture:** A self-contained `EdrSummaryPanel` component fetches both status endpoints in parallel (`Promise.allSettled` so one provider's failure doesn't blank the other), renders a grid of `SecurityStatCard`s per configured provider, and is mounted in `SecurityDashboard` behind `ENABLE_EDR_INTEGRATIONS`. Org-scoped users see their org; partner-scoped users see partner-wide aggregates (the endpoints already resolve this from auth context with no params).

**Tech Stack:** React island + Tailwind, Vitest + jsdom.

## Global Constraints

**Endpoint contracts (no params → resolves from auth; org-scoped or partner-wide aggregates):**
- `GET /s1/status` → `{ integration: {...}|null, mapped?: boolean, summary: { totalAgents, mappedDevices, infectedAgents, activeThreats, highOrCriticalThreats, pendingActions, reportedThreatCount } }`. `integration: null` ⇒ not configured (all-zero summary).
- `GET /huntress/status` → `{ integration: {...}|null, mapped?: boolean, coverage: { totalAgents, mappedAgents, unmappedAgents, offlineAgents }, incidents: { open, bySeverity: [{severity,count}], byStatus: [{status,count}] } }`. `integration: null` ⇒ not configured.

**Decisions:**
- D4: **client-side fan-out**, no aggregator endpoint (widget count is small).
- Gate the panel behind `ENABLE_EDR_INTEGRATIONS` (consistent with Pillars 1-2).
- Use `Promise.allSettled` — a failed `/s1/status` must NOT blank the Huntress cards (the Pillar 1 review lesson; this is the always-on dashboard, so per-provider resilience matters here).
- Hide a provider's cards when its `integration` is `null` (not configured). If neither is configured, render nothing.
- "Isolated-devices count" from the original phase sketch is **out of scope** — `/s1/status` doesn't expose it without a new query; note it, don't invent.

**Conventions:** reads via `fetchWithAuth` (no `runAction` — read-only); reuse `SecurityStatCard`; tests mock fetch by URL+method (not positional).

## File Structure
- Create: `apps/web/src/components/security/EdrSummaryPanel.tsx` (+ `EdrSummaryPanel.test.tsx`).
- Modify: `apps/web/src/components/security/SecurityDashboard.tsx` (mount behind flag).

---

### Task 1: EdrSummaryPanel — fetch both status endpoints, render cards

**Files:**
- Create: `apps/web/src/components/security/EdrSummaryPanel.tsx`, `apps/web/src/components/security/EdrSummaryPanel.test.tsx`.

**Interfaces:**
- Produces: `default function EdrSummaryPanel()` — self-contained, no props.

**Pre-step — confirm `SecurityStatCard` export + props.** Open `apps/web/src/components/security/SecurityStatCard.tsx`. Its props are `{ icon: LucideIcon; label: string; value: string | number; variant?: 'default'|'success'|'warning'|'danger'; detail?: string }`. Use the file's actual export form (default vs named) in the import.

- [ ] **Step 1: Write the failing test.** `EdrSummaryPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
import EdrSummaryPanel from './EdrSummaryPanel';

function ok(b: unknown) { return { ok: true, status: 200, json: async () => b } as Response; }
function routeStatus(s1: unknown, huntress: unknown) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/s1/status')) return Promise.resolve(ok(s1));
    if (url.startsWith('/huntress/status')) return Promise.resolve(ok(huntress));
    return Promise.resolve(ok({}));
  });
}
beforeEach(() => fetchWithAuth.mockReset());

describe('EdrSummaryPanel', () => {
  it('renders S1 + Huntress cards from both status endpoints', async () => {
    routeStatus(
      { integration: { id: 'i1' }, summary: { totalAgents: 10, mappedDevices: 8, infectedAgents: 2, activeThreats: 3, highOrCriticalThreats: 1, pendingActions: 0, reportedThreatCount: 5 } },
      { integration: { id: 'h1' }, coverage: { totalAgents: 12, mappedAgents: 9, unmappedAgents: 3, offlineAgents: 1 }, incidents: { open: 4, bySeverity: [], byStatus: [] } },
    );
    render(<EdrSummaryPanel />);
    expect(await screen.findByTestId('edr-card-s1-active-threats')).toHaveTextContent('3');
    expect(screen.getByTestId('edr-card-huntress-open-incidents')).toHaveTextContent('4');
    expect(screen.getByTestId('edr-card-huntress-coverage')).toHaveTextContent('9/12');
  });

  it('hides a provider whose integration is null', async () => {
    routeStatus(
      { integration: null, summary: { totalAgents: 0, mappedDevices: 0, infectedAgents: 0, activeThreats: 0, highOrCriticalThreats: 0, pendingActions: 0, reportedThreatCount: 0 } },
      { integration: { id: 'h1' }, coverage: { totalAgents: 5, mappedAgents: 5, unmappedAgents: 0, offlineAgents: 0 }, incidents: { open: 0, bySeverity: [], byStatus: [] } },
    );
    render(<EdrSummaryPanel />);
    expect(await screen.findByTestId('edr-card-huntress-open-incidents')).toBeInTheDocument();
    expect(screen.queryByTestId('edr-card-s1-active-threats')).toBeNull();
  });

  it('renders Huntress cards even when /s1/status fails (allSettled)', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/s1/status')) return Promise.resolve({ ok: false, status: 500, statusText: 'err', json: async () => ({}) } as Response);
      if (url.startsWith('/huntress/status')) return Promise.resolve(ok({ integration: { id: 'h1' }, coverage: { totalAgents: 5, mappedAgents: 5, unmappedAgents: 0, offlineAgents: 0 }, incidents: { open: 2, bySeverity: [], byStatus: [] } }));
      return Promise.resolve(ok({}));
    });
    render(<EdrSummaryPanel />);
    await waitFor(() => expect(screen.getByTestId('edr-card-huntress-open-incidents')).toHaveTextContent('2'));
    expect(screen.queryByTestId('edr-card-s1-active-threats')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail** (`cannot resolve ./EdrSummaryPanel`).

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/EdrSummaryPanel.test.tsx`

- [ ] **Step 3: Implement EdrSummaryPanel.** Create `EdrSummaryPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ShieldAlert, Activity, ShieldCheck, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import SecurityStatCard from './SecurityStatCard'; // adjust if SecurityStatCard is a named export

interface S1Summary { totalAgents: number; mappedDevices: number; infectedAgents: number; activeThreats: number; highOrCriticalThreats: number; pendingActions: number; reportedThreatCount: number; }
interface S1Status { integration: { id: string } | null; summary: S1Summary; }
interface HuntressStatus { integration: { id: string } | null; coverage: { totalAgents: number; mappedAgents: number; unmappedAgents: number; offlineAgents: number }; incidents: { open: number }; }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithAuth(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export default function EdrSummaryPanel() {
  const [s1, setS1] = useState<S1Status | null>(null);
  const [huntress, setHuntress] = useState<HuntressStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s1Res, hRes] = await Promise.allSettled([
        getJson<S1Status>('/s1/status'),
        getJson<HuntressStatus>('/huntress/status'),
      ]);
      if (cancelled) return;
      setS1(s1Res.status === 'fulfilled' ? s1Res.value : null);
      setHuntress(hRes.status === 'fulfilled' ? hRes.value : null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const showS1 = s1?.integration != null;
  const showHuntress = huntress?.integration != null;

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm" data-testid="edr-summary-panel">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading EDR posture…</div>
      </div>
    );
  }
  if (!showS1 && !showHuntress) return null; // no EDR integrations configured

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm" data-testid="edr-summary-panel">
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-primary" />
        <h3 className="text-lg font-semibold">Endpoint Detection &amp; Response</h3>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {showS1 && s1 && (
          <>
            <div data-testid="edr-card-s1-active-threats">
              <SecurityStatCard
                icon={ShieldAlert}
                label="SentinelOne Active Threats"
                value={s1.summary.activeThreats}
                variant={s1.summary.activeThreats > 0 ? 'danger' : 'success'}
                detail={`${s1.summary.highOrCriticalThreats} high/critical`}
              />
            </div>
            <div data-testid="edr-card-s1-coverage">
              <SecurityStatCard
                icon={ShieldCheck}
                label="SentinelOne Agents"
                value={`${s1.summary.mappedDevices}/${s1.summary.totalAgents}`}
                detail={`${s1.summary.infectedAgents} infected`}
                variant={s1.summary.infectedAgents > 0 ? 'warning' : 'default'}
              />
            </div>
          </>
        )}
        {showHuntress && huntress && (
          <>
            <div data-testid="edr-card-huntress-open-incidents">
              <SecurityStatCard
                icon={Activity}
                label="Huntress Open Incidents"
                value={huntress.incidents.open}
                variant={huntress.incidents.open > 0 ? 'danger' : 'success'}
              />
            </div>
            <div data-testid="edr-card-huntress-coverage">
              <SecurityStatCard
                icon={ShieldCheck}
                label="Huntress Agents"
                value={`${huntress.coverage.mappedAgents}/${huntress.coverage.totalAgents}`}
                detail={`${huntress.coverage.offlineAgents} offline · ${huntress.coverage.unmappedAgents} unmapped`}
                variant={huntress.coverage.unmappedAgents > 0 ? 'warning' : 'default'}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

(If `SecurityStatCard` is a named export, change the import to `import { SecurityStatCard } from './SecurityStatCard';`.)

- [ ] **Step 4: Run, verify pass.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/EdrSummaryPanel.test.tsx`
Expected: PASS (3 cases).

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/security/EdrSummaryPanel.tsx apps/web/src/components/security/EdrSummaryPanel.test.tsx
git commit -m "feat(web): EDR summary panel (S1 + Huntress status cards, allSettled)"
```

---

### Task 2: Mount EdrSummaryPanel in SecurityDashboard behind the flag

**Files:**
- Modify: `apps/web/src/components/security/SecurityDashboard.tsx`.
- Test: add a case to `SecurityDashboard`'s existing test if present, else `apps/web/src/components/security/EdrSummaryPanel.dashboard.test.tsx`.

**Interfaces:**
- Consumes: `EdrSummaryPanel` (Task 1), `ENABLE_EDR_INTEGRATIONS`.

- [ ] **Step 1: Write the failing test.** If `SecurityDashboard.test.tsx` exists, add a case mocking `ENABLE_EDR_INTEGRATIONS: true` and stubbing `./EdrSummaryPanel`, asserting the stub renders. If no such test file exists, create `EdrSummaryPanel.dashboard.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
vi.mock('../../lib/featureFlags', async (orig) => ({ ...(await orig<typeof import('../../lib/featureFlags')>()), ENABLE_EDR_INTEGRATIONS: true }));
vi.mock('./EdrSummaryPanel', () => ({ default: () => <div data-testid="edr-summary-stub" /> }));
const fetchWithAuth = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) } as Response));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
import SecurityDashboard from './SecurityDashboard';

describe('SecurityDashboard EDR panel', () => {
  it('renders the EDR summary panel when the flag is on', async () => {
    render(<SecurityDashboard />);
    await waitFor(() => expect(screen.getByTestId('edr-summary-stub')).toBeInTheDocument());
  });
});
```

(If `SecurityDashboard` requires props or providers to render, mirror however its existing test/harness mounts it. Reuse the file's established mocks.)

- [ ] **Step 2: Run, verify fail.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/EdrSummaryPanel.dashboard.test.tsx`

- [ ] **Step 3: Mount the panel.** In `SecurityDashboard.tsx`:
  - Import: `import { ENABLE_EDR_INTEGRATIONS } from '../../lib/featureFlags';` and `import EdrSummaryPanel from './EdrSummaryPanel';`.
  - Render `{ENABLE_EDR_INTEGRATIONS && <EdrSummaryPanel />}` inside the top-level `<div className="space-y-6">`, immediately after the header/error region and BEFORE the main 12-col grid (so EDR posture sits near the top). It is a full-width section (the panel manages its own internal grid).

- [ ] **Step 4: Run, verify pass.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security/EdrSummaryPanel.dashboard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/security/SecurityDashboard.tsx apps/web/src/components/security/EdrSummaryPanel.dashboard.test.tsx
git commit -m "feat(web): mount EDR summary panel on security dashboard behind flag"
```

---

## Verification (end of pillar)
- [ ] `pnpm --filter @breeze/web exec vitest run src/components/security` — green.
- [ ] `pnpm --filter @breeze/web exec tsc --noEmit` — clean.
- [ ] Manual (`PUBLIC_ENABLE_EDR_INTEGRATIONS=true`): `/security` shows the EDR panel near the top with S1/Huntress cards reflecting `/s1/status` + `/huntress/status`; with only one provider configured, only that provider's cards show; with neither, the panel is absent.

## Notes
- No mutations here → no `no-silent-mutations` enrollment needed.
- "Isolated-devices count" deferred (needs a new `/s1/status` field or query). Raise if wanted.
- Pillar 4 (EDR → Incident escalation) is the remaining pillar.
