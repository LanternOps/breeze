# EDR Pillar 4a — Promote to Incident — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a technician escalate a SentinelOne threat or Huntress incident into a tracked Breeze **Incident** (the BE-32 incident-response module) with one click — from the device EDR panel and the fleet EDR lists. This finally gives the starved Incidents page organic inflow. No API change — uses the existing `POST /incidents`.

**Architecture:** A shared `incidents.ts` web lib exposes `promoteToIncident(input)` (wrapped in `runAction`) plus two pure mappers that turn an `S1Threat` / `HuntressIncident` into the `POST /incidents` body (with EDR-severity → p1–p4 mapping). A "Promote to Incident" control is added to the four EDR surfaces (device panel S1 + Huntress rows; fleet `S1ThreatList` + `HuntressIncidentList` rows). On success it navigates to `/incidents/{id}`.

**Tech Stack:** React islands + Tailwind, Vitest.

## Global Constraints

**`POST /incidents` contract** (`apps/api/src/routes/incidents.ts`): requires `ALERTS_WRITE` (`alerts:write`) + MFA. Body (`createIncidentSchema`):
`{ orgId?: string; title: string(3..500); classification: string(2..40); severity: 'p1'|'p2'|'p3'|'p4'; summary?: string(≤10000); relatedAlerts?: uuid[]; affectedDevices?: uuid[]; assignedTo?: uuid; detectedAt?: ISO; status?: 'detected'|'analyzing' }`.
Scope rules: **org** scope ignores body `orgId` and uses `auth.orgId`; **partner** scope **requires** `orgId` and `canAccessOrg`-checks it; system requires `orgId`. Returns the created incident `{ id, orgId, ... }` with HTTP **201**.

**Therefore:** always send `orgId` from the source row (`threat.orgId` / `incident.orgId`) — required for partner (fleet) callers, harmless for org callers.

**EDR severity → incident severity map:** `critical→p1, high→p2, medium→p3, low→p4`, anything else (null/unknown) → `p3`.

**Conventions:** the promote mutation goes through `runAction` (toasts success/failure; MFA 403 surfaces as a toast — no step-up modal). Caller catch via `handleActionError`. Tests mock fetch by URL+method. `navigateTo` from `@/lib/navigation` on success. Title clamps to 500 chars; classification is a fixed ≤40-char string.

## File Structure
- Create: `apps/web/src/lib/incidents.ts` (+ `incidents.test.ts`).
- Modify: `apps/web/src/components/devices/DeviceEdrPanel.tsx` (+ test) — promote buttons on S1 + Huntress rows.
- Modify: `apps/web/src/components/security/S1ThreatList.tsx` (+ test), `apps/web/src/components/security/HuntressIncidentList.tsx` (+ test) — promote in the row actions.
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` — enroll `incidents.ts` + `HuntressIncidentList.tsx` (count bump).

---

### Task 1: `incidents.ts` lib — promoteToIncident + mappers

**Files:**
- Create: `apps/web/src/lib/incidents.ts`, `apps/web/src/lib/incidents.test.ts`.

**Interfaces:**
- Produces:
  `type IncidentSeverity = 'p1'|'p2'|'p3'|'p4'`
  `mapEdrSeverity(sev: string | null | undefined): IncidentSeverity`
  `s1ThreatToIncident(t: S1Threat): CreateIncidentInput`
  `huntressIncidentToIncident(i: HuntressIncident): CreateIncidentInput`
  `promoteToIncident(input: CreateIncidentInput): Promise<{ id: string }>`
  where `CreateIncidentInput = { orgId: string; title: string; classification: string; severity: IncidentSeverity; summary?: string; affectedDevices?: string[]; detectedAt?: string }`.

- [ ] **Step 1: Write the failing test.** `incidents.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const fetchWithAuth = vi.fn();
vi.mock('../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../components/shared/Toast', () => ({ showToast: vi.fn() }));
import { mapEdrSeverity, s1ThreatToIncident, huntressIncidentToIncident, promoteToIncident } from './incidents';

function ok(b: unknown) { return { ok: true, status: 201, json: async () => b } as Response; }
beforeEach(() => fetchWithAuth.mockReset());

describe('mapEdrSeverity', () => {
  it('maps EDR severities to p1-p4 with a safe default', () => {
    expect(mapEdrSeverity('critical')).toBe('p1');
    expect(mapEdrSeverity('HIGH')).toBe('p2');
    expect(mapEdrSeverity('medium')).toBe('p3');
    expect(mapEdrSeverity('low')).toBe('p4');
    expect(mapEdrSeverity(null)).toBe('p3');
    expect(mapEdrSeverity('weird')).toBe('p3');
  });
});

describe('mappers', () => {
  it('builds an incident input from an S1 threat', () => {
    const input = s1ThreatToIncident({ id: 't1', orgId: 'org-1', deviceId: 'dev-9', deviceName: 'PC', threatName: 'Emotet', severity: 'critical', status: 'active', detectedAt: '2026-06-20T00:00:00Z' } as any);
    expect(input.orgId).toBe('org-1');
    expect(input.severity).toBe('p1');
    expect(input.affectedDevices).toEqual(['dev-9']);
    expect(input.classification).toBe('sentinelone-threat');
    expect(input.title).toContain('Emotet');
  });
  it('builds an incident input from a Huntress incident with no device', () => {
    const input = huntressIncidentToIncident({ id: 'i1', orgId: 'org-2', deviceId: null, title: 'Persistence', severity: 'high', status: 'open', reportedAt: '2026-06-21T00:00:00Z' } as any);
    expect(input.orgId).toBe('org-2');
    expect(input.severity).toBe('p2');
    expect(input.affectedDevices).toEqual([]);
    expect(input.classification).toBe('huntress-incident');
  });
});

describe('promoteToIncident', () => {
  it('POSTs /incidents and returns the new id', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Promise.resolve(ok({ id: 'inc-1' })); });
    const res = await promoteToIncident({ orgId: 'org-1', title: 'X', classification: 'sentinelone-threat', severity: 'p1', affectedDevices: ['dev-9'] });
    expect(res).toEqual({ id: 'inc-1' });
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/incidents');
    expect((body as any).orgId).toBe('org-1');
    expect((body as any).severity).toBe('p1');
  });
});
```

- [ ] **Step 2: Run, verify fail.**

Run: `pnpm --filter @breeze/web exec vitest run src/lib/incidents.test.ts`

- [ ] **Step 3: Implement `incidents.ts`.**

```ts
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import type { S1Threat, HuntressIncident } from './edr';

export type IncidentSeverity = 'p1' | 'p2' | 'p3' | 'p4';

export interface CreateIncidentInput {
  orgId: string;
  title: string;
  classification: string;
  severity: IncidentSeverity;
  summary?: string;
  affectedDevices?: string[];
  detectedAt?: string;
}

const SEVERITY_MAP: Record<string, IncidentSeverity> = {
  critical: 'p1', high: 'p2', medium: 'p3', low: 'p4',
};

export function mapEdrSeverity(sev: string | null | undefined): IncidentSeverity {
  return SEVERITY_MAP[(sev ?? '').toLowerCase()] ?? 'p3';
}

function clampTitle(value: string): string {
  return value.length > 500 ? value.slice(0, 500) : value;
}

export function s1ThreatToIncident(t: S1Threat): CreateIncidentInput {
  const device = t.deviceName ?? t.deviceId ?? 'an unknown device';
  return {
    orgId: t.orgId,
    title: clampTitle(`SentinelOne: ${t.threatName ?? 'Unknown threat'}`),
    classification: 'sentinelone-threat',
    severity: mapEdrSeverity(t.severity),
    summary: `Promoted from SentinelOne threat "${t.threatName ?? 'Unknown threat'}" on ${device}.`,
    affectedDevices: t.deviceId ? [t.deviceId] : [],
    detectedAt: t.detectedAt ?? undefined,
  };
}

export function huntressIncidentToIncident(i: HuntressIncident): CreateIncidentInput {
  const device = i.deviceHostname ?? i.deviceId ?? 'an unknown device';
  const body = i.recommendation || i.description || '';
  return {
    orgId: i.orgId,
    title: clampTitle(`Huntress: ${i.title}`),
    classification: 'huntress-incident',
    severity: mapEdrSeverity(i.severity),
    summary: `Promoted from Huntress incident "${i.title}" on ${device}.${body ? ` ${body}` : ''}`.slice(0, 10000),
    affectedDevices: i.deviceId ? [i.deviceId] : [],
    detectedAt: i.reportedAt ?? undefined,
  };
}

export async function promoteToIncident(input: CreateIncidentInput): Promise<{ id: string }> {
  return runAction<{ id: string }>({
    request: () =>
      fetchWithAuth('/incidents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    errorFallback: 'Failed to create incident',
    successMessage: 'Incident created',
    parseSuccess: (data) => data as { id: string },
  });
}
```

- [ ] **Step 4: Run, verify pass.** `pnpm --filter @breeze/web exec vitest run src/lib/incidents.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/lib/incidents.ts apps/web/src/lib/incidents.test.ts
git commit -m "feat(web): promoteToIncident lib + EDR->incident mappers"
```

---

### Task 2: Promote buttons on the device EDR panel

**Files:**
- Modify: `apps/web/src/components/devices/DeviceEdrPanel.tsx`, `apps/web/src/components/devices/DeviceEdrPanel.test.tsx`.

**Interfaces:** Consumes `promoteToIncident`, `s1ThreatToIncident`, `huntressIncidentToIncident` (Task 1), `navigateTo`, `handleActionError`.

- [ ] **Step 1: Write the failing test.** Append to `DeviceEdrPanel.test.tsx`:

```tsx
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

describe('DeviceEdrPanel promote to incident', () => {
  it('promotes an S1 threat then navigates to the new incident', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [{ id: 't1', orgId: 'org-1', deviceId: 'dev-1', threatName: 'Emotet', severity: 'critical', status: 'active', detectedAt: '2026-06-20T00:00:00Z' }], pagination: { total: 1, limit: 50, offset: 0 } }));
      if (url.startsWith('/huntress/incidents')) return Promise.resolve(ok({ data: [], total: 0, limit: 50, offset: 0 }));
      if (url === '/incidents') { body = JSON.parse(String(init?.body)); return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'inc-9' }) } as Response); }
      return Promise.resolve(ok({ data: [] }));
    });
    render(<DeviceEdrPanel deviceId="dev-1" orgId="org-1" />);
    fireEvent.click(await screen.findByTestId('edr-s1-promote-t1'));
    await waitFor(() => expect((body as any).classification).toBe('sentinelone-threat'));
    expect(navigateTo).toHaveBeenCalledWith('/incidents/inc-9');
  });
});
```

(Add `navigateTo.mockReset()` to the file's `beforeEach` if present, and ensure `fireEvent`/`waitFor` are imported.)

- [ ] **Step 2: Run, verify fail.** `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx -t "promote"`

- [ ] **Step 3: Implement.** In `DeviceEdrPanel.tsx`:
  - Import `promoteToIncident, s1ThreatToIncident, huntressIncidentToIncident` from `../../lib/incidents`, and `navigateTo` from `@/lib/navigation`.
  - Add a `promotingId` state and a handler:

```tsx
const [promotingId, setPromotingId] = useState<string | null>(null);
const promote = async (key: string, input: import('../../lib/incidents').CreateIncidentInput) => {
  setPromotingId(key);
  try {
    const { id } = await promoteToIncident(input);
    navigateTo(`/incidents/${id}`);
  } catch (err) {
    handleActionError(err, 'Failed to create incident');
  } finally {
    setPromotingId(null);
  }
};
```

  - On each **S1 threat** row, add a button (works for any status, not only active):

```tsx
<button
  type="button"
  data-testid={`edr-s1-promote-${t.id}`}
  onClick={() => promote(t.id, s1ThreatToIncident(t))}
  disabled={promotingId === t.id}
  className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
>
  Promote to Incident
</button>
```

  - On each **Huntress incident** row, add the analogous button `data-testid={\`edr-huntress-promote-${i.id}\`}` calling `promote(i.id, huntressIncidentToIncident(i))`.

- [ ] **Step 4: Run, verify pass.** `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEdrPanel.test.tsx` → PASS (all cases).

- [ ] **Step 5: Commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/devices/DeviceEdrPanel.tsx apps/web/src/components/devices/DeviceEdrPanel.test.tsx
git commit -m "feat(web): promote S1 threat / Huntress incident to Incident from device panel"
```

---

### Task 3: Promote in the fleet lists + no-silent-mutations enrollment

**Files:**
- Modify: `apps/web/src/components/security/S1ThreatList.tsx` (+ test), `apps/web/src/components/security/HuntressIncidentList.tsx` (+ test).
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.

**Interfaces:** same as Task 2.

- [ ] **Step 1: Write the failing tests.** Add to `S1ThreatList.test.tsx`:

```tsx
it('promotes a threat to an incident and navigates', async () => {
  let body: unknown;
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/s1/threats')) return Promise.resolve(ok({ data: [{ id: 't1', orgId: 'org-7', deviceId: 'dev-9', threatName: 'X', severity: 'high', status: 'active', detectedAt: '2026-06-20T00:00:00Z' }], pagination: { total: 1, limit: 100, offset: 0 } }));
    if (url === '/incidents') { body = JSON.parse(String(init?.body)); return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'inc-2' }) } as Response); }
    return Promise.resolve(ok({ data: [] }));
  });
  render(<S1ThreatList />);
  const desktop = await screen.findByTestId('responsive-table-desktop');
  fireEvent.click(within(desktop).getByTestId('s1-promote-t1'));
  await waitFor(() => expect((body as any).orgId).toBe('org-7'));
  expect(navigateTo).toHaveBeenCalledWith('/incidents/inc-2');
});
```

Add the analogous case to `HuntressIncidentList.test.tsx` (testid `huntress-promote-i1`, fixture incident with `orgId: 'org-3'`, assert `classification: 'huntress-incident'` and navigate to `/incidents/inc-3`). The Huntress list previously had no `navigateTo` for actions — it already mocks `@/lib/navigation` for row clicks, so reuse that mock.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.**
  - **S1ThreatList.tsx:** import `promoteToIncident, s1ThreatToIncident`; add the same `promotingId` state + `promote` handler as Task 2. In the desktop Actions cell AND the mobile card Actions, add a `Promote to Incident` button `data-testid={\`s1-promote-${t.id}\`}` (available for all rows, not only active). Keep `stopPropagation` so it doesn't trigger row navigation.
  - **HuntressIncidentList.tsx:** it is currently read-only with no Actions column. Add an **Actions** column (desktop) and an Actions `CardField` (mobile) containing a `Promote to Incident` button `data-testid={\`huntress-promote-${i.id}\`}` calling `promote(i.id, huntressIncidentToIncident(i))`. Add the `promotingId` state + handler + the `handleActionError` import + `promoteToIncident`/`huntressIncidentToIncident` imports. The row already navigates on click — wrap the actions cell with `stopPropagation`.

- [ ] **Step 4: Enroll the new mutation surfaces.** In `no-silent-mutations.test.ts`, add `'src/lib/incidents.ts'` and `'src/components/security/HuntressIncidentList.tsx'` to `TARGET_GLOBS` and bump `expect(absoluteFiles.length).toBe(52)` → `54`. (`S1ThreatList.ts` and `DeviceEdrPanel.tsx` are already enrolled.)

- [ ] **Step 5: Run, verify pass.**

Run: `pnpm --filter @breeze/web exec vitest run src/components/security src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
git add apps/web/src/components/security/S1ThreatList.tsx apps/web/src/components/security/S1ThreatList.test.tsx apps/web/src/components/security/HuntressIncidentList.tsx apps/web/src/components/security/HuntressIncidentList.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): promote to incident from fleet EDR lists + guard enrollment"
```

---

## Verification (end of pillar)
- [ ] `pnpm --filter @breeze/web exec vitest run src/components/security src/components/devices src/lib/incidents.test.ts src/lib/__tests__/no-silent-mutations.test.ts` — green.
- [ ] `pnpm --filter @breeze/web exec tsc --noEmit` — clean.
- [ ] Manual (`PUBLIC_ENABLE_EDR_INTEGRATIONS=true`): on a device with EDR data, "Promote to Incident" on a threat creates an incident and lands on `/incidents/{id}` with the affected device + severity prefilled; same from `/security/edr`. With a non-MFA session, the action toasts "MFA required".

## Deferred to Pillar 4b (raise with Todd)
- **Huntress write-back** (resolve incident / approve remediations via the new `POST /v1/incident_reports/{id}/resolution`) — net-new `huntressClient.ts` write methods + remediation sync. Own PR.
- **S1 containment logged as `incident_actions`** when isolate/quarantine is performed from inside an incident (links the IR `containIncidentSchema` to the S1 action API).
- **Auto-file** incidents on p1/critical `s1.threat_detected` / `huntress.incident_created` events (D5 deferred manual-first).
