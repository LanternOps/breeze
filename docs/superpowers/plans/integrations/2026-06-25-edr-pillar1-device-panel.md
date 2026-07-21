# EDR Pillar 1 — Device-Detail EDR Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the device Security tab, show this device's SentinelOne threats and Huntress incidents, and let a technician isolate/un-isolate the device and run S1 threat actions (kill/quarantine/rollback) inline — all backed by endpoints that already exist.

**Architecture:** Web-only, no API changes. A new shared lib (`edr.ts`) holds typed fetchers/action-callers for the existing `/s1/*` and `/huntress/*` endpoints. A new `DeviceEdrPanel` component renders two read lists plus S1 action buttons (confirm-modal + `runAction`). It mounts inside `DeviceSecurityTab`, below the existing native-AV cards, gated behind a feature flag. The device's `orgId` is forwarded so partner-scoped (MSP) admins resolve the right tenant.

**Tech Stack:** Astro + React islands, TypeScript, Vitest + jsdom, Tailwind, lucide-react. Fetch via `fetchWithAuth` (`apps/web/src/stores/auth`); mutations via `runAction` (`apps/web/src/lib/runAction`).

## Global Constraints

These apply to every task. Exact values, copied from the live API.

**API contracts (no changes in this pillar):**

- `GET /s1/threats?orgId=<uuid>&deviceId=<uuid>&limit=<n>` → `200 { data: S1Threat[], pagination: { total: number, limit: number, offset: number } }`
  - `S1Threat = { id: string; s1ThreatId: string; orgId: string; integrationId: string; deviceId: string | null; deviceName: string | null; threatName: string; classification: string | null; severity: string | null; status: string; processName: string | null; filePath: string | null; mitreTactics: unknown; detectedAt: string; resolvedAt: string | null; updatedAt: string; details: unknown }`
- `GET /huntress/incidents?orgId=<uuid>&deviceId=<uuid>&limit=<n>` → `200 { data: HuntressIncident[], total: number, limit: number, offset: number }` (NOTE: flat shape — `total` is top-level, NOT nested under `pagination` like S1)
  - `HuntressIncident = { id: string; orgId: string; integrationId: string; deviceId: string | null; deviceHostname: string | null; huntressIncidentId: string; severity: string; category: string | null; title: string; description: string | null; recommendation: string | null; status: string; reportedAt: string; resolvedAt: string | null; details: unknown; createdAt: string; updatedAt: string }`
- `POST /s1/isolate` body `{ orgId?: string; deviceIds: string[]; isolate?: boolean }` → `200 { data, warnings? }` · `404` no active integration · `403` site/MFA denied · `502 { error, data, warnings }` dispatch failed. **Requires MFA + `devices:execute`.**
- `POST /s1/threat-action` body `{ orgId?: string; action: 'kill' | 'quarantine' | 'rollback'; threatIds: string[] }` → `200 { data, warnings? }` · `404` · `403` · `502`. **Requires MFA + `devices:execute`.** `threatIds` accepts the threat **row `id` (uuid)** — pass `threat.id`.

**MFA is token-level, not per-request step-up.** `requireMfa()` returns `403 "MFA required"` only when the caller's *session* didn't satisfy MFA at login (or when `ENABLE_2FA` is off, it always passes). There is NO step-up token to attach. The UI does NOT build an MFA modal — a 403 simply surfaces as a `runAction` error toast.

**orgId:** always send `?orgId=<device.orgId>`. Org-scoped users would resolve it from auth anyway, but partner-scoped (MSP) admins viewing a device in a sub-org MUST pass it. `Device.orgId` exists on the type (`apps/web/src/components/devices/DeviceList.tsx`).

**Conventions:**
- All mutations wrapped in `runAction`; catch per CLAUDE.md (401 → let auth redirect; non-401 `ActionError` already toasted).
- Reads use `fetchWithAuth` directly (no `runAction` — they don't mutate).
- Tests mock `fetchWithAuth` and **route by URL + method, never by call order** (positional `mockResolvedValueOnce` races the effect-load vs. click — see `web_userriskpage_toast_pollution_flake`).
- Reuse the severity/status badge Tailwind classes already in `DeviceSecurityTab.tsx`.
- Feature flag gates the whole panel for phased rollout, mirroring `ENABLE_ENDPOINT_AV_FEATURES`.

## File Structure

- Create: `apps/web/src/lib/edr.ts` — types (`S1Threat`, `HuntressIncident`), read fetchers, action callers.
- Modify: `apps/web/src/lib/featureFlags.ts` — add `ENABLE_EDR_INTEGRATIONS`.
- Create: `apps/web/src/components/devices/DeviceEdrPanel.tsx` — the panel.
- Create: `apps/web/src/components/devices/DeviceEdrPanel.test.tsx` — component tests.
- Modify: `apps/web/src/components/devices/DeviceSecurityTab.tsx` — accept `orgId`, render panel.
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx:362` — pass `orgId={device.orgId}`.

---

### Task 1: EDR feature flag + shared lib (types, read fetchers, action callers)

**Files:**
- Modify: `apps/web/src/lib/featureFlags.ts`
- Create: `apps/web/src/lib/edr.ts`
- Test: `apps/web/src/lib/edr.test.ts`

**Interfaces:**
- Produces: `ENABLE_EDR_INTEGRATIONS: boolean`; types `S1Threat`, `HuntressIncident`, `S1ThreatActionType`; functions
  `fetchS1Threats(orgId, deviceId): Promise<S1Threat[]>`,
  `fetchHuntressIncidents(orgId, deviceId): Promise<HuntressIncident[]>`,
  `isolateDevice(orgId, deviceId, isolate): Promise<void>`,
  `runS1ThreatAction(orgId, threatId, action): Promise<void>`.

- [ ] **Step 1: Add the feature flag.** In `apps/web/src/lib/featureFlags.ts`, directly after the `ENABLE_ENDPOINT_AV_FEATURES` export, add:

```ts
export const ENABLE_EDR_INTEGRATIONS = parseBoolean(
  import.meta.env.PUBLIC_ENABLE_EDR_INTEGRATIONS,
  false,
);
```

(Match the exact `parseBoolean(import.meta.env.X, default)` signature already used in this file — if the existing call passes no default, omit the second arg and rely on its falsy fallback.)

- [ ] **Step 2: Write the failing fetcher test.** Create `apps/web/src/lib/edr.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { fetchS1Threats, fetchHuntressIncidents } from './edr';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => fetchWithAuth.mockReset());

describe('fetchS1Threats', () => {
  it('passes orgId + deviceId and unwraps pagination shape', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 't1' }], pagination: { total: 1, limit: 100, offset: 0 } }));
    const rows = await fetchS1Threats('org-1', 'dev-1');
    expect(rows).toEqual([{ id: 't1' }]);
    const url = fetchWithAuth.mock.calls[0][0] as string;
    expect(url).toContain('/s1/threats');
    expect(url).toContain('orgId=org-1');
    expect(url).toContain('deviceId=dev-1');
  });
});

describe('fetchHuntressIncidents', () => {
  it('unwraps the flat (non-pagination) shape', async () => {
    fetchWithAuth.mockResolvedValue(ok({ data: [{ id: 'i1' }], total: 1, limit: 100, offset: 0 }));
    const rows = await fetchHuntressIncidents('org-1', 'dev-1');
    expect(rows).toEqual([{ id: 'i1' }]);
    expect(fetchWithAuth.mock.calls[0][0]).toContain('/huntress/incidents');
  });
});
```

- [ ] **Step 3: Run test, verify it fails.**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/edr.test.ts`
Expected: FAIL — cannot resolve `./edr`.

- [ ] **Step 4: Implement `edr.ts`.** Create `apps/web/src/lib/edr.ts`:

```ts
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';

export type S1ThreatActionType = 'kill' | 'quarantine' | 'rollback';

export interface S1Threat {
  id: string;
  s1ThreatId: string;
  orgId: string;
  integrationId: string;
  deviceId: string | null;
  deviceName: string | null;
  threatName: string;
  classification: string | null;
  severity: string | null;
  status: string;
  processName: string | null;
  filePath: string | null;
  mitreTactics: unknown;
  detectedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
  details: unknown;
}

export interface HuntressIncident {
  id: string;
  orgId: string;
  integrationId: string;
  deviceId: string | null;
  deviceHostname: string | null;
  huntressIncidentId: string;
  severity: string;
  category: string | null;
  title: string;
  description: string | null;
  recommendation: string | null;
  status: string;
  reportedAt: string;
  resolvedAt: string | null;
  details: unknown;
  createdAt: string;
  updatedAt: string;
}

export async function fetchS1Threats(orgId: string, deviceId: string): Promise<S1Threat[]> {
  const params = new URLSearchParams({ orgId, deviceId, limit: '50' });
  const res = await fetchWithAuth(`/s1/threats?${params.toString()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  return Array.isArray(body?.data) ? (body.data as S1Threat[]) : [];
}

export async function fetchHuntressIncidents(orgId: string, deviceId: string): Promise<HuntressIncident[]> {
  const params = new URLSearchParams({ orgId, deviceId, limit: '50' });
  const res = await fetchWithAuth(`/huntress/incidents?${params.toString()}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const body = await res.json();
  return Array.isArray(body?.data) ? (body.data as HuntressIncident[]) : [];
}

export async function isolateDevice(orgId: string, deviceId: string, isolate: boolean): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth('/s1/isolate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, deviceIds: [deviceId], isolate }),
      }),
    errorFallback: isolate ? 'Failed to isolate device' : 'Failed to remove isolation',
    successMessage: isolate ? 'Device isolated' : 'Isolation removed',
  });
}

export async function runS1ThreatAction(orgId: string, threatId: string, action: S1ThreatActionType): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth('/s1/threat-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, action, threatIds: [threatId] }),
      }),
    errorFallback: `Failed to ${action} threat`,
    successMessage: `Threat ${action} requested`,
  });
}
```

- [ ] **Step 5: Run test, verify it passes.**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/edr.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/lib/featureFlags.ts apps/web/src/lib/edr.ts apps/web/src/lib/edr.test.ts
git commit -m "feat(web): EDR shared lib + feature flag for device-level S1/Huntress"
```

---

### Task 2: DeviceEdrPanel — read views (threats + incidents)

**Files:**
- Create: `apps/web/src/components/devices/DeviceEdrPanel.tsx`
- Test: `apps/web/src/components/devices/DeviceEdrPanel.test.tsx`

**Interfaces:**
- Consumes: `fetchS1Threats`, `fetchHuntressIncidents`, `S1Threat`, `HuntressIncident` (Task 1).
- Produces: `default function DeviceEdrPanel({ deviceId, orgId, timezone }: { deviceId: string; orgId: string; timezone?: string })`.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/components/devices/DeviceEdrPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import DeviceEdrPanel from './DeviceEdrPanel';

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

// Route by URL + method — never positional (effect-load vs click race).
function routeFetch(map: { s1?: unknown; huntress?: unknown }) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: map.s1 ?? [], pagination: { total: 0, limit: 50, offset: 0 } }));
    if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: map.huntress ?? [], total: 0, limit: 50, offset: 0 }));
    return Promise.resolve(ok({ data: [] }));
  });
}

beforeEach(() => fetchWithAuth.mockReset());

describe('DeviceEdrPanel', () => {
  it('renders S1 threats and Huntress incidents for the device', async () => {
    routeFetch({
      s1: [{ id: 't1', threatName: 'Emotet', severity: 'high', status: 'active', filePath: 'C:/x.exe', detectedAt: '2026-06-20T00:00:00Z' }],
      huntress: [{ id: 'i1', title: 'Suspicious persistence', severity: 'critical', status: 'open', category: 'malware', reportedAt: '2026-06-21T00:00:00Z' }],
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    expect(await screen.findByText('Emotet')).toBeInTheDocument();
    expect(await screen.findByText('Suspicious persistence')).toBeInTheDocument();
  });

  it('shows empty states when there is no EDR data', async () => {
    routeFetch({ s1: [], huntress: [] });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('edr-s1-empty')).toBeInTheDocument());
    expect(screen.getByTestId('edr-huntress-empty')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx`
Expected: FAIL — cannot resolve `./DeviceEdrPanel`.

- [ ] **Step 3: Implement the read-only panel.** Create `apps/web/src/components/devices/DeviceEdrPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldAlert, Activity } from 'lucide-react';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { friendlyFetchError } from '../../lib/utils';
import {
  fetchS1Threats,
  fetchHuntressIncidents,
  type S1Threat,
  type HuntressIncident,
} from '../../lib/edr';

const severityBadge: Record<string, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
};

function sevClass(sev: string | null): string {
  return severityBadge[(sev ?? '').toLowerCase()] ?? 'bg-muted text-muted-foreground border-border';
}

function fmt(value: string | null, timezone?: string): string {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : formatUserDateTime(d, timezone ? { timeZone: timezone } : undefined);
}

type Props = { deviceId: string; orgId: string; timezone?: string };

export default function DeviceEdrPanel({ deviceId, orgId, timezone }: Props) {
  const [threats, setThreats] = useState<S1Threat[]>([]);
  const [incidents, setIncidents] = useState<HuntressIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [s1, hi] = await Promise.all([
        fetchS1Threats(orgId, deviceId),
        fetchHuntressIncidents(orgId, deviceId),
      ]);
      setThreats(s1);
      setIncidents(hi);
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId, deviceId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm" data-testid="device-edr-panel">
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-primary" />
        <h3 className="text-lg font-semibold">Endpoint Protection (EDR)</h3>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* SentinelOne threats */}
        <div>
          <h4 className="mb-3 text-sm font-semibold">SentinelOne Threats</h4>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : threats.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="edr-s1-empty">No SentinelOne threats for this device.</p>
          ) : (
            <div className="space-y-3">
              {threats.map((t) => (
                <div key={t.id} className="rounded-md border bg-background p-3" data-testid="edr-s1-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{t.threatName}</p>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${sevClass(t.severity)}`}>{t.severity ?? 'unknown'}</span>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground border-border">{t.status}</span>
                    </div>
                  </div>
                  {t.filePath && <p className="mt-1 text-xs text-muted-foreground" title={t.filePath}>{t.filePath}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Detected: {fmt(t.detectedAt, timezone)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Huntress incidents (read-only this pillar) */}
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4" />Huntress Incidents</h4>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="edr-huntress-empty">No Huntress incidents for this device.</p>
          ) : (
            <div className="space-y-3">
              {incidents.map((i) => (
                <div key={i.id} className="rounded-md border bg-background p-3" data-testid="edr-huntress-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{i.title}</p>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${sevClass(i.severity)}`}>{i.severity}</span>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground border-border">{i.status}</span>
                    </div>
                  </div>
                  {i.recommendation && <p className="mt-1 text-xs text-muted-foreground">{i.recommendation}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Reported: {fmt(i.reportedAt, timezone)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/devices/DeviceEdrPanel.tsx apps/web/src/components/devices/DeviceEdrPanel.test.tsx
git commit -m "feat(web): device EDR panel — S1 threats + Huntress incidents read views"
```

---

### Task 3: S1 isolate / un-isolate with confirm modal

**Files:**
- Modify: `apps/web/src/components/devices/DeviceEdrPanel.tsx`
- Test: `apps/web/src/components/devices/DeviceEdrPanel.test.tsx` (add cases)

**Interfaces:**
- Consumes: `isolateDevice(orgId, deviceId, isolate)` (Task 1).

- [ ] **Step 1: Write the failing test.** Append to `DeviceEdrPanel.test.tsx`:

```tsx
import { fireEvent } from '@testing-library/react';

describe('DeviceEdrPanel isolate', () => {
  it('confirms then POSTs /s1/isolate with the device id', async () => {
    let isolateBody: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [], pagination: { total: 0, limit: 50, offset: 0 } }));
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      if (url === '/s1/isolate') { isolateBody = JSON.parse(String(init?.body)); return Promise.resolve(ok({ data: {} })); }
      return Promise.resolve(ok({ data: [] }));
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('edr-isolate-btn'));
    // confirm modal
    fireEvent.click(await screen.findByTestId('edr-isolate-confirm'));
    await waitFor(() => expect(isolateBody).toEqual({ orgId: 'org-1', deviceIds: ['dev-1'], isolate: true }));
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx -t isolate`
Expected: FAIL — no `edr-isolate-btn`.

- [ ] **Step 3: Add isolate state + confirm modal + handler.** In `DeviceEdrPanel.tsx`: import `isolateDevice` and `ActionError` (`import { ActionError } from '../../lib/runAction';`), add state and handler inside the component:

```tsx
  const [confirmIsolate, setConfirmIsolate] = useState(false);
  const [isolating, setIsolating] = useState(false);

  const doIsolate = async () => {
    setIsolating(true);
    try {
      await isolateDevice(orgId, deviceId, true);
      setConfirmIsolate(false);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      // non-401 ActionError already toasted by runAction
    } finally {
      setIsolating(false);
    }
  };
```

Add an **Isolate device** button to the panel header (next to the `<h3>`), and a confirm modal at the end of the returned JSX:

```tsx
{/* header button — place beside the EDR title */}
<button
  type="button"
  data-testid="edr-isolate-btn"
  onClick={() => setConfirmIsolate(true)}
  className="ml-auto inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
>
  Isolate device
</button>

{/* confirm modal — append before the panel's closing </div> */}
{confirmIsolate && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
      <h4 className="text-base font-semibold">Isolate this device?</h4>
      <p className="mt-2 text-sm text-muted-foreground">
        SentinelOne will cut the device off the network until you remove isolation. Active sessions will drop.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => setConfirmIsolate(false)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Cancel</button>
        <button
          type="button"
          data-testid="edr-isolate-confirm"
          onClick={doIsolate}
          disabled={isolating}
          className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-60"
        >
          {isolating && <Loader2 className="h-4 w-4 animate-spin" />}Isolate
        </button>
      </div>
    </div>
  </div>
)}
```

(To anchor the header button with `ml-auto`, wrap the title row in a `flex` container — the existing `<div className="mb-4 flex items-center gap-2">` already is a flex row; the button as a sibling with `ml-auto` will push right.)

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/devices/DeviceEdrPanel.tsx apps/web/src/components/devices/DeviceEdrPanel.test.tsx
git commit -m "feat(web): S1 isolate device action with confirm modal"
```

---

### Task 4: S1 threat actions (kill / quarantine / rollback) per threat row

**Files:**
- Modify: `apps/web/src/components/devices/DeviceEdrPanel.tsx`
- Test: `apps/web/src/components/devices/DeviceEdrPanel.test.tsx` (add case)

**Interfaces:**
- Consumes: `runS1ThreatAction(orgId, threatId, action)`, `S1ThreatActionType` (Task 1).

- [ ] **Step 1: Write the failing test.** Append to `DeviceEdrPanel.test.tsx`:

```tsx
describe('DeviceEdrPanel threat actions', () => {
  it('POSTs /s1/threat-action with the threat row id', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [{ id: 't1', threatName: 'Emotet', severity: 'high', status: 'active', detectedAt: '2026-06-20T00:00:00Z' }], pagination: { total: 1, limit: 50, offset: 0 } }));
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      if (url === '/s1/threat-action') { body = JSON.parse(String(init?.body)); return Promise.resolve(ok({ data: {} })); }
      return Promise.resolve(ok({ data: [] }));
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('edr-threat-quarantine-t1'));
    await waitFor(() => expect(body).toEqual({ orgId: 'org-1', action: 'quarantine', threatIds: ['t1'] }));
  });
});
```

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx -t "threat actions"`
Expected: FAIL — no `edr-threat-quarantine-t1`.

- [ ] **Step 3: Add a per-threat action handler + buttons.** In `DeviceEdrPanel.tsx`: import `runS1ThreatAction` and `S1ThreatActionType`, add:

```tsx
  const [actingId, setActingId] = useState<string | null>(null);

  const doThreatAction = async (threatId: string, action: S1ThreatActionType) => {
    setActingId(threatId);
    try {
      await runS1ThreatAction(orgId, threatId, action);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
    } finally {
      setActingId(null);
    }
  };
```

In the S1 threat row JSX, after the `Detected:` line, add an action row (only for active threats):

```tsx
{t.status === 'active' && (
  <div className="mt-3 flex flex-wrap items-center gap-2">
    {(['kill', 'quarantine', 'rollback'] as const).map((action) => (
      <button
        key={action}
        type="button"
        data-testid={`edr-threat-${action}-${t.id}`}
        onClick={() => doThreatAction(t.id, action)}
        disabled={actingId === t.id}
        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium capitalize hover:bg-muted disabled:opacity-60"
      >
        {actingId === t.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{action}
      </button>
    ))}
  </div>
)}
```

- [ ] **Step 4: Run test, verify it passes.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/devices/DeviceEdrPanel.tsx apps/web/src/components/devices/DeviceEdrPanel.test.tsx
git commit -m "feat(web): S1 per-threat kill/quarantine/rollback actions"
```

---

### Task 5: Mount the panel in DeviceSecurityTab + pass orgId from DeviceDetails

**Files:**
- Modify: `apps/web/src/components/devices/DeviceSecurityTab.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (line ~362)
- Test: `apps/web/src/components/devices/DeviceSecurityTab.test.tsx` (add case)

**Interfaces:**
- Consumes: `DeviceEdrPanel` (Tasks 2–4), `ENABLE_EDR_INTEGRATIONS` (Task 1).
- `DeviceSecurityTab` gains an `orgId: string` prop.

- [ ] **Step 1: Write the failing test.** Add to `DeviceSecurityTab.test.tsx` a case asserting the EDR panel renders when the flag is on. Mock the flag module and `DeviceEdrPanel`:

```tsx
vi.mock('../../lib/featureFlags', async (orig) => ({
  ...(await orig<typeof import('../../lib/featureFlags')>()),
  ENABLE_EDR_INTEGRATIONS: true,
}));
vi.mock('./DeviceEdrPanel', () => ({ default: ({ orgId }: { orgId: string }) => <div data-testid="edr-panel-stub">{orgId}</div> }));

it('renders the EDR panel with the device orgId when the flag is on', async () => {
  // ...existing render of DeviceSecurityTab with deviceId="dev-1" orgId="org-9"...
  render(<DeviceSecurityTab deviceId="dev-1" orgId="org-9" />);
  expect(await screen.findByTestId('edr-panel-stub')).toHaveTextContent('org-9');
});
```

(Reuse the file's existing `fetchWithAuth` mock + render harness; only the flag mock, the `DeviceEdrPanel` mock, and the new `orgId` prop are new.)

- [ ] **Step 2: Run test, verify it fails.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceSecurityTab.test.tsx -t "EDR panel"`
Expected: FAIL — `DeviceSecurityTab` doesn't accept `orgId` / doesn't render the panel.

- [ ] **Step 3: Wire the panel into DeviceSecurityTab.** In `DeviceSecurityTab.tsx`:
  - Add `import { ENABLE_EDR_INTEGRATIONS } from '../../lib/featureFlags';` and `import DeviceEdrPanel from './DeviceEdrPanel';`.
  - Change the props type to `type DeviceSecurityTabProps = { deviceId: string; orgId: string; timezone?: string };` and destructure `orgId`.
  - Render the panel inside the returned `<div className="space-y-6">`, after `<DeviceSecurityStatus ... />` and before the native "Security Operations" card:

```tsx
{ENABLE_EDR_INTEGRATIONS && <DeviceEdrPanel deviceId={deviceId} orgId={orgId} timezone={timezone} />}
```

  - Apply the same gate in the early-return branch (`if (!ENABLE_ENDPOINT_AV_FEATURES)`) so the EDR panel still shows when native-AV features are off:

```tsx
if (!ENABLE_ENDPOINT_AV_FEATURES) {
  return (
    <div className="space-y-6">
      <DeviceSecurityStatus deviceId={deviceId} showAvActions={false} />
      {ENABLE_EDR_INTEGRATIONS && <DeviceEdrPanel deviceId={deviceId} orgId={orgId} timezone={timezone} />}
    </div>
  );
}
```

- [ ] **Step 4: Pass orgId from DeviceDetails.** In `DeviceDetails.tsx:362`, change:

```tsx
<DeviceSecurityTab deviceId={device.id} timezone={effectiveTimezone} />
```

to:

```tsx
<DeviceSecurityTab deviceId={device.id} orgId={device.orgId} timezone={effectiveTimezone} />
```

- [ ] **Step 5: Run the device test suite, verify it passes.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceSecurityTab.test.tsx src/components/devices/DeviceEdrPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/devices/DeviceSecurityTab.tsx apps/web/src/components/devices/DeviceSecurityTab.test.tsx apps/web/src/components/devices/DeviceDetails.tsx
git commit -m "feat(web): mount EDR panel in device security tab behind ENABLE_EDR_INTEGRATIONS"
```

---

## Verification (end of pillar)

- [ ] `pnpm --filter @breeze/web exec vitest run src/components/devices src/lib/edr.test.ts` — all green.
- [ ] `pnpm --filter @breeze/web exec tsc --noEmit` — clean.
- [ ] Manual (local stack, `PUBLIC_ENABLE_EDR_INTEGRATIONS=true`): open a device with synced S1/Huntress data → EDR panel lists threats + incidents; isolate shows confirm modal then toasts; a `kill` on an active threat toasts and reloads. With a non-MFA session, the action toasts "MFA required" (403) rather than failing silently.
- [ ] `no-silent-mutations` test passes (mutations route through `runAction`): `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`.

## Notes for the next pillars

- Fleet pages (Pillar 2) reuse `edr.ts` fetchers — generalize them to accept a filter object `{ orgId?, deviceId?, status?, severity?, search?, limit?, offset? }` and return the pagination total when Pillar 2 needs paging.
- "Promote to Incident" (Pillar 4) hangs off these same rows — keep `S1Threat.id` / `HuntressIncident.id` and `huntressIncidentId` in the row props so the escalation call has the identifiers it needs.
