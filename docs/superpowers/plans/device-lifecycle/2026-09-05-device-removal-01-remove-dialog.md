---
tracking_issue: LanternOps/breeze#5023
---
# Device Removal 01 — Remove Dialog with Agent Choice (single + bulk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every web Remove action asks "uninstall the agent or leave it?" (default: uninstall) and sends `uninstallAgent` to `DELETE /devices/:id`, closing the zombie-agent gap.

**Architecture:** A thin `RemoveDeviceDialog` composes the existing `ConfirmDialog` (children slot + single-fire latch). The five Remove surfaces (DevicesPage row/card via `pendingDeviceAction`, bulk bar, DeviceActions/detail page, PossibleReplacementBanner) all render it and forward `{ uninstallAgent }` through the service layer. One new read-only API route exposes the env-driven drain window so the copy can say how long a queued uninstall waits.

**Tech Stack:** Hono route + Vitest (API); React + react-i18next + Vitest/jsdom (web).

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-05-device-removal-completion-design.md` (PR 1). Issues: #3987 items 2 and 6; supersedes #2250.

## Global Constraints

- Single-device API contract unchanged: `DELETE /devices/:id` body `{ uninstallAgent?: boolean }` already exists (`apps/api/src/routes/devices/schemas.ts:119`); default stays `false` on the API — the **web** supplies `true` by default.
- Radio defaults to **Uninstall** (owner decision 2026-08-24). Never default to leave-installed.
- Copy must say **queued**, never "runs now" — Remove inserts a pending command and disconnects the WS; the agent collects on its next poll.
- Drain window is env-driven (`DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS`, `services/deviceUninstallDrain.ts:80`). Never hardcode it in web or shared.
- Bulk status summary buckets are "online" / "not currently online" (not "offline") — `maintenance`, `quarantined`, `updating`, `pending` are neither.
- All new locale keys go into `en` AND `de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR` in the same commit (`apps/web/src/lib/i18n/localeParity.test.ts` fails otherwise). Machine-quality translations are acceptable; interpolation tokens must match exactly.
- Mutations go through `runAction` or the existing `deviceActions` service functions (no-silent-mutations test).
- Commit after each task. Run `cd apps/web && npx vitest run <file>` / `cd apps/api && npx vitest run <file>` — never `pnpm --filter x test -- --run`.

---

### Task 1: API — `GET /devices/removal-config` exposes the drain window

**Files:**
- Create: `apps/api/src/routes/devices/removalConfig.ts`
- Create: `apps/api/src/routes/devices/removalConfig.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts:79` (mount before `coreRoutes`)

**Interfaces:**
- Produces: `GET /api/v1/devices/removal-config` → `200 { uninstallDrainWindowHours: number }`. Requires `devices:read`, any scope.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/devices/removalConfig.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, scope: 'organization', orgId: 'org-1', accessibleOrgIds: ['org-1'] });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../../services/deviceUninstallDrain', () => ({
  DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS: 72,
}));

import { removalConfigRoutes } from './removalConfig';

describe('GET /devices/removal-config', () => {
  it('returns the configured uninstall drain window in hours', async () => {
    const app = new Hono().route('/devices', removalConfigRoutes);
    const res = await app.request('/devices/removal-config', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uninstallDrainWindowHours: 72 });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module './removalConfig'`)

```bash
cd apps/api && npx vitest run src/routes/devices/removalConfig.test.ts
```

- [ ] **Step 3: Implement the route**

```ts
// apps/api/src/routes/devices/removalConfig.ts
import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS } from '../../services/deviceUninstallDrain';

export const removalConfigRoutes = new Hono();
removalConfigRoutes.use('*', authMiddleware);

/**
 * GET /devices/removal-config — read-only knobs the Remove dialog needs.
 *
 * `uninstallDrainWindowHours` is how long a queued self_uninstall waits for a
 * removed device to check in before the stale-command reaper cancels it
 * (`DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS`, env-driven, floored at 1). The web
 * must not hardcode it: operators tune it per deployment.
 *
 * Static path — MUST be mounted before coreRoutes in devices/index.ts or the
 * `/:id` matcher eats it as a device id.
 */
removalConfigRoutes.get(
  '/removal-config',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  (c) => c.json({ uninstallDrainWindowHours: DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS }),
);
```

In `apps/api/src/routes/devices/index.ts`, add the import and mount it directly before the `// Mount core routes` line:

```ts
import { removalConfigRoutes } from './removalConfig';
// ...
// Mount the Remove-dialog config BEFORE core — `/removal-config` is a static
// path that must not be eaten by the `/:id` matcher in coreRoutes.
deviceRoutes.route('/', removalConfigRoutes);
```

- [ ] **Step 4: Run the test — expect PASS.** Also run the assembled-router guard: `npx vitest run src/routes/devices/index.test.ts` (must stay green).

- [ ] **Step 5: Add a mount-order assertion** to `apps/api/src/routes/devices/index.test.ts` (find the existing `describe` for static-before-dynamic; add a case): request `GET /devices/removal-config` with the file's standard auth mock and assert `status !== 404 && status !== 400` and the body has `uninstallDrainWindowHours`. Run, expect PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/removalConfig.ts apps/api/src/routes/devices/removalConfig.test.ts apps/api/src/routes/devices/index.ts apps/api/src/routes/devices/index.test.ts
git commit -m "feat(api): GET /devices/removal-config exposes the uninstall drain window (#3987)"
```

---

### Task 2: Web service — `decommissionDevice` / `bulkDecommissionDevices` send `uninstallAgent`; add `fetchRemovalConfig`

**Files:**
- Modify: `apps/web/src/services/deviceActions.ts:386-398` and `:490-506`
- Test: `apps/web/src/services/deviceActions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RemoveDeviceOptions { uninstallAgent: boolean }
  export async function decommissionDevice(deviceId: string, opts: RemoveDeviceOptions): Promise<{ success: boolean; uninstallQueued?: boolean }>
  export async function bulkDecommissionDevices(devices: Array<{ id: string; hostname: string }>, opts: RemoveDeviceOptions): Promise<BulkDecommissionResult>
  export async function fetchRemovalConfig(): Promise<{ uninstallDrainWindowHours: number }>
  ```

- [ ] **Step 1: Write the failing tests** (append to `deviceActions.test.ts`; it already mocks `@/stores/auth` `fetchWithAuth` and has `makeJsonResponse`)

```ts
import { decommissionDevice, bulkDecommissionDevices, fetchRemovalConfig } from './deviceActions';

describe('decommissionDevice — agent choice is sent to the API', () => {
  it('sends { uninstallAgent: true } as the JSON body', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ success: true, uninstallQueued: true }));
    await decommissionDevice('dev-1', { uninstallAgent: true });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe('/devices/dev-1');
    expect(init?.method).toBe('DELETE');
    expect(JSON.parse(String(init?.body))).toEqual({ uninstallAgent: true });
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends { uninstallAgent: false } when the user chose to leave the agent', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ success: true, uninstallQueued: false }));
    await decommissionDevice('dev-1', { uninstallAgent: false });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ uninstallAgent: false });
  });
});

describe('bulkDecommissionDevices — one body per device, same choice', () => {
  it('forwards the same uninstallAgent to every DELETE', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ success: true }));
    const result = await bulkDecommissionDevices(
      [{ id: 'a', hostname: 'A' }, { id: 'b', hostname: 'B' }],
      { uninstallAgent: true },
    );
    expect(result).toEqual({ succeeded: 2, failed: [] });
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toEqual({ uninstallAgent: true });
    }
  });
});

describe('fetchRemovalConfig', () => {
  it('returns the drain window from GET /devices/removal-config', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ uninstallDrainWindowHours: 48 }));
    expect(await fetchRemovalConfig()).toEqual({ uninstallDrainWindowHours: 48 });
    expect(fetchMock.mock.calls[0][0]).toBe('/devices/removal-config');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (TypeScript: `Expected 1 arguments`; `fetchRemovalConfig` not exported)

```bash
cd apps/web && npx vitest run src/services/deviceActions.test.ts
```

- [ ] **Step 3: Implement**

Replace `decommissionDevice`:

```ts
export interface RemoveDeviceOptions {
  /**
   * Queue a durable self_uninstall alongside the Remove (#3986/#4001). The
   * API defaults this to false for back-compat; the WEB defaults it to true
   * in RemoveDeviceDialog — defaulting to "leave installed" is what produces
   * zombie agents nobody notices (owner decision 2026-08-24).
   */
  uninstallAgent: boolean;
}

export async function decommissionDevice(
  deviceId: string,
  opts: RemoveDeviceOptions,
): Promise<{ success: boolean; uninstallQueued?: boolean }> {
  const response = await fetchWithAuth(`/devices/${deviceId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uninstallAgent: opts.uninstallAgent }),
  });

  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to remove device'));
  }

  const data = await response.json();
  return data.data ?? data;
}

export async function fetchRemovalConfig(): Promise<{ uninstallDrainWindowHours: number }> {
  const response = await fetchWithAuth('/devices/removal-config');
  if (!response.ok) {
    throw new Error(await getErrorMessage(response, 'Failed to load removal settings'));
  }
  return response.json();
}
```

Change `bulkDecommissionDevices` signature to `(devices, opts: RemoveDeviceOptions)` and call `decommissionDevice(device.id, opts)` in the loop.

- [ ] **Step 4: Run — expect PASS.** Then `cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep deviceActions` — expect call-site errors in DevicesPage.tsx / DeviceDetailPage.tsx (fixed in Tasks 4–5; that is the point of the required arg).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/deviceActions.ts apps/web/src/services/deviceActions.test.ts
git commit -m "feat(web): deviceActions sends uninstallAgent on Remove; add fetchRemovalConfig (#3987)"
```

---

### Task 3: `RemoveDeviceDialog` component

**Files:**
- Create: `apps/web/src/components/devices/RemoveDeviceDialog.tsx`
- Create: `apps/web/src/components/devices/RemoveDeviceDialog.test.tsx`
- Modify: `apps/web/src/locales/en/devices.json` (new `removeDialog` block under `deviceActions`) + the 7 other locales

**Interfaces:**
- Consumes: `fetchRemovalConfig` (Task 2), `ConfirmDialog` (`../shared/ConfirmDialog`).
- Produces:
  ```ts
  export interface RemoveDialogTarget { hostname: string; status: string }
  export interface RemoveDeviceDialogProps {
    open: boolean;
    targets: RemoveDialogTarget[];          // 1 = single, >1 = bulk
    onClose: () => void;
    onConfirm: (choice: { uninstallAgent: boolean }) => void;
    isLoading?: boolean;
    confirmTestId?: string;
  }
  export default function RemoveDeviceDialog(props: RemoveDeviceDialogProps): JSX.Element | null
  ```

- [ ] **Step 1: Add locale keys** to `apps/web/src/locales/en/devices.json` inside the existing `"deviceActions"` object (sibling of `"confirm"`):

```json
"removeDialog": {
  "titleOne": "Remove {{hostname}}?",
  "titleMany": "Remove {{count}} devices?",
  "bodyOne": "It will be taken out of your active fleet and stop being monitored. History is kept and you can restore it later.",
  "bodyMany": "They will be taken out of your active fleet and stop being monitored. History is kept and you can restore them later.",
  "summary": "{{online}} online, {{notOnline}} not currently online.",
  "legend": "What should happen to the Breeze agent?",
  "uninstall": "Uninstall the Breeze agent",
  "uninstallOnline": "Queued now — an online agent collects it within moments.",
  "uninstallQueuedWithWindow": "Queued — runs the next time the device checks in. Cancelled if it hasn't after {{hours}} hours.",
  "uninstallQueued": "Queued — runs the next time the device checks in.",
  "uninstallMixed": "Online devices collect it within moments; the rest run it on their next check-in.",
  "leave": "Leave the agent installed",
  "leaveHint": "The machine keeps running the agent but can't be managed.",
  "confirm": "Remove"
}
```

Add the same block (translated) to `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` `devices.json`. Keep `{{hostname}}`, `{{count}}`, `{{online}}`, `{{notOnline}}`, `{{hours}}` tokens verbatim. Run `npx vitest run src/lib/i18n/localeParity.test.ts` — expect PASS.

- [ ] **Step 2: Write the failing component test**

```tsx
// apps/web/src/components/devices/RemoveDeviceDialog.test.tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/deviceActions', () => ({
  fetchRemovalConfig: vi.fn(),
}));
import { fetchRemovalConfig } from '../../services/deviceActions';
import RemoveDeviceDialog from './RemoveDeviceDialog';

const cfg = vi.mocked(fetchRemovalConfig);

beforeEach(() => {
  vi.clearAllMocks();
  cfg.mockResolvedValue({ uninstallDrainWindowHours: 72 });
});

describe('RemoveDeviceDialog', () => {
  it('defaults the agent radio to Uninstall and confirms with uninstallAgent: true', async () => {
    const onConfirm = vi.fn();
    render(<RemoveDeviceDialog open targets={[{ hostname: 'WKSTN-042', status: 'online' }]} onClose={() => {}} onConfirm={onConfirm} confirmTestId="remove-confirm" />);
    expect(screen.getByRole('radio', { name: /uninstall the breeze agent/i })).toBeChecked();
    fireEvent.click(screen.getByTestId('remove-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ uninstallAgent: true });
  });

  it('confirms with uninstallAgent: false when Leave is chosen', () => {
    const onConfirm = vi.fn();
    render(<RemoveDeviceDialog open targets={[{ hostname: 'WKSTN-042', status: 'offline' }]} onClose={() => {}} onConfirm={onConfirm} confirmTestId="remove-confirm" />);
    fireEvent.click(screen.getByRole('radio', { name: /leave the agent installed/i }));
    fireEvent.click(screen.getByTestId('remove-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ uninstallAgent: false });
  });

  it('says "queued now" for an online device and never says "runs now"', () => {
    render(<RemoveDeviceDialog open targets={[{ hostname: 'A', status: 'online' }]} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(/queued now/i)).toBeInTheDocument();
    expect(screen.queryByText(/runs now/i)).toBeNull();
  });

  it('shows the drain window from the API for a not-online device', async () => {
    render(<RemoveDeviceDialog open targets={[{ hostname: 'A', status: 'maintenance' }]} onClose={() => {}} onConfirm={() => {}} />);
    await waitFor(() => expect(screen.getByText(/after 72 hours/i)).toBeInTheDocument());
  });

  it('falls back to window-less copy when the config fetch fails', async () => {
    cfg.mockRejectedValue(new Error('boom'));
    render(<RemoveDeviceDialog open targets={[{ hostname: 'A', status: 'offline' }]} onClose={() => {}} onConfirm={() => {}} />);
    await waitFor(() => expect(cfg).toHaveBeenCalled());
    expect(screen.getByText(/runs the next time the device checks in\.$/i)).toBeInTheDocument();
    expect(screen.queryByText(/after .* hours/i)).toBeNull();
  });

  it('bulk: titles with the count and buckets online vs not-currently-online', () => {
    render(<RemoveDeviceDialog open targets={[
      { hostname: 'A', status: 'online' },
      { hostname: 'B', status: 'offline' },
      { hostname: 'C', status: 'quarantined' },
    ]} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText('Remove 3 devices?')).toBeInTheDocument();
    expect(screen.getByText('1 online, 2 not currently online.')).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).toBeNull();
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (`Cannot find module './RemoveDeviceDialog'`)

```bash
cd apps/web && npx vitest run src/components/devices/RemoveDeviceDialog.test.tsx
```

- [ ] **Step 4: Implement**

```tsx
// apps/web/src/components/devices/RemoveDeviceDialog.tsx
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { fetchRemovalConfig } from '../../services/deviceActions';

export interface RemoveDialogTarget {
  hostname: string;
  status: string;
}

export interface RemoveDeviceDialogProps {
  open: boolean;
  /** One entry = single-device Remove; several = bulk Remove (one choice for all). */
  targets: RemoveDialogTarget[];
  onClose: () => void;
  onConfirm: (choice: { uninstallAgent: boolean }) => void;
  isLoading?: boolean;
  confirmTestId?: string;
}

/**
 * The Remove confirm (#3987). Composes ConfirmDialog — it already has a
 * `children` slot and the #3705 single-fire latch — and adds the one question
 * Remove actually needs answered: what happens to the agent.
 *
 * DEFAULTS TO UNINSTALL. Owner decision 2026-08-24: defaulting to "leave
 * installed" is what produces zombie agents heartbeating into a 403 forever.
 *
 * Copy says "queued", never "runs now": DELETE /devices/:id inserts a pending
 * self_uninstall and force-closes the agent WS (core.ts) — the agent collects
 * the command on its next poll, moments later if online. The wait window for
 * a device that never checks in is env-driven on the API
 * (DEVICE_UNINSTALL_DRAIN_WINDOW_HOURS), so it is fetched, not hardcoded.
 */
export default function RemoveDeviceDialog({
  open,
  targets,
  onClose,
  onConfirm,
  isLoading = false,
  confirmTestId,
}: RemoveDeviceDialogProps) {
  const { t } = useTranslation('devices');
  const [uninstallAgent, setUninstallAgent] = useState(true);
  const [windowHours, setWindowHours] = useState<number | null>(null);
  const legendId = useId();

  useEffect(() => {
    if (!open) return;
    setUninstallAgent(true);
    let cancelled = false;
    fetchRemovalConfig()
      .then((cfg) => { if (!cancelled) setWindowHours(cfg.uninstallDrainWindowHours); })
      .catch(() => { if (!cancelled) setWindowHours(null); });
    return () => { cancelled = true; };
  }, [open]);

  if (!open || targets.length === 0) return null;

  const online = targets.filter((d) => d.status === 'online').length;
  const notOnline = targets.length - online;
  const many = targets.length > 1;

  let uninstallHint: string;
  if (many && online > 0 && notOnline > 0) {
    uninstallHint = t('deviceActions.removeDialog.uninstallMixed');
  } else if (notOnline === 0) {
    uninstallHint = t('deviceActions.removeDialog.uninstallOnline');
  } else if (windowHours != null) {
    uninstallHint = t('deviceActions.removeDialog.uninstallQueuedWithWindow', { hours: windowHours });
  } else {
    uninstallHint = t('deviceActions.removeDialog.uninstallQueued');
  }

  return (
    <ConfirmDialog
      open
      onClose={onClose}
      onConfirm={() => onConfirm({ uninstallAgent })}
      title={many
        ? t('deviceActions.removeDialog.titleMany', { count: targets.length })
        : t('deviceActions.removeDialog.titleOne', { hostname: targets[0].hostname })}
      message={many ? t('deviceActions.removeDialog.bodyMany') : t('deviceActions.removeDialog.bodyOne')}
      confirmLabel={t('deviceActions.removeDialog.confirm')}
      variant="destructive"
      isLoading={isLoading}
      confirmTestId={confirmTestId}
    >
      {many && (
        <p className="text-sm text-muted-foreground" data-testid="remove-dialog-summary">
          {t('deviceActions.removeDialog.summary', { online, notOnline })}
        </p>
      )}
      <fieldset className="mt-3 space-y-2" aria-labelledby={legendId}>
        <legend id={legendId} className="text-sm font-medium">
          {t('deviceActions.removeDialog.legend')}
        </legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="remove-agent-choice"
            className="mt-1"
            checked={uninstallAgent}
            onChange={() => setUninstallAgent(true)}
            data-testid="remove-choice-uninstall"
          />
          <span>
            <span className="block">{t('deviceActions.removeDialog.uninstall')}</span>
            <span className="block text-xs text-muted-foreground">{uninstallHint}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="remove-agent-choice"
            className="mt-1"
            checked={!uninstallAgent}
            onChange={() => setUninstallAgent(false)}
            data-testid="remove-choice-leave"
          />
          <span>
            <span className="block">{t('deviceActions.removeDialog.leave')}</span>
            <span className="block text-xs text-muted-foreground">{t('deviceActions.removeDialog.leaveHint')}</span>
          </span>
        </label>
      </fieldset>
    </ConfirmDialog>
  );
}
```

- [ ] **Step 5: Run — expect PASS** (all six). Also `npx vitest run src/lib/i18n/keyUsage.test.ts src/lib/i18n/localeParity.test.ts` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/RemoveDeviceDialog.tsx apps/web/src/components/devices/RemoveDeviceDialog.test.tsx apps/web/src/locales/*/devices.json
git commit -m "feat(web): RemoveDeviceDialog — agent uninstall choice, defaults to uninstall (#3987)"
```

---

### Task 4: Wire DevicesPage — single (row/card) and bulk Remove

**Files:**
- Modify: `apps/web/src/components/devices/DevicesPage.tsx` (`runDeviceAction` ~:760, `case 'decommission'` :873, bulk `case 'decommission'` :1180, `pendingDeviceAction` render :1579)
- Test: `apps/web/src/components/devices/DevicesPage.test.tsx` (mocks `decommissionDevice`/`bulkDecommissionDevices` at :43-44)

**Interfaces:**
- Consumes: `RemoveDeviceDialog` (Task 3), `RemoveDeviceOptions` (Task 2).
- Produces (internal): `runDeviceAction(action: string, device: Device, opts?: { uninstallAgent?: boolean })`; new state `pendingBulkRemove: Device[] | null`.

- [ ] **Step 1: Write the failing tests** (append to `DevicesPage.test.tsx`, using the file's existing helpers for rendering a fleet and opening the row kebab / bulk menu — copy the setup from the test at :1235 "bulkDecommissionDevices fires one DELETE…")

```tsx
describe('Remove — agent choice (#3987)', () => {
  it('single Remove from the row kebab opens the agent-choice dialog and sends uninstallAgent: true by default', async () => {
    const { decommissionDevice } = await import('../../services/deviceActions');
    vi.mocked(decommissionDevice).mockResolvedValue({ success: true } as never);
    // …render fleet with one online agent device; open its kebab; click "Remove"
    // (same steps the existing "#3698 confirm gate" test in this file uses)…
    expect(screen.getByRole('radio', { name: /uninstall the breeze agent/i })).toBeChecked();
    fireEvent.click(screen.getByTestId('confirm-device-action'));
    // 5-second undo toast still fires; advance it
    await act(async () => { vi.advanceTimersByTime(5000); });
    await waitFor(() => expect(vi.mocked(decommissionDevice)).toHaveBeenCalledWith(expect.any(String), { uninstallAgent: true }));
  });

  it('bulk Remove asks once and forwards the choice to bulkDecommissionDevices', async () => {
    const { bulkDecommissionDevices } = await import('../../services/deviceActions');
    vi.mocked(bulkDecommissionDevices).mockResolvedValue({ succeeded: 2, failed: [] } as never);
    // …render 2 active devices, select all, Bulk Actions → Remove Selected…
    expect(screen.getByText('Remove 2 devices?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /leave the agent installed/i }));
    fireEvent.click(screen.getByTestId('confirm-bulk-remove'));
    await waitFor(() => expect(vi.mocked(bulkDecommissionDevices)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(bulkDecommissionDevices).mock.calls[0][1]).toEqual({ uninstallAgent: false });
  });
});
```

(Fill the `// …` lines with the exact render/select helpers already present in this test file — they exist at :1235-1290 for the bulk path and in the "#3698" describe for the row kebab. Do not invent new fixtures.)

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/web && npx vitest run src/components/devices/DevicesPage.test.tsx -t "agent choice"
```

- [ ] **Step 3: Implement in `DevicesPage.tsx`**

a) Import: `import RemoveDeviceDialog from './RemoveDeviceDialog';`

b) State (next to `pendingDeviceAction`):
```ts
  // #3987: bulk Remove asks the agent question ONCE for the whole selection.
  const [pendingBulkRemove, setPendingBulkRemove] = useState<Device[] | null>(null);
```

c) `runDeviceAction` signature → `(action: string, device: Device, opts?: { uninstallAgent?: boolean })`. In `case 'decommission'` replace `await decommissionDevice(device.id);` with:
```ts
              await decommissionDevice(device.id, { uninstallAgent: opts?.uninstallAgent ?? true });
```

d) In `runBulkAction`, replace the body of `case 'decommission'` so it defers to the dialog:
```ts
        case 'decommission': {
          // Ask the agent question once for the whole selection (#3987). The
          // actual loop runs in runBulkRemove after the dialog confirms.
          setPendingBulkRemove(selectedDevices);
          return;
        }
```
and add a new function directly after `runBulkAction`:
```ts
  const runBulkRemove = async (selectedDevices: Device[], choice: { uninstallAgent: boolean }) => {
    setActionInProgress(true);
    try {
      const result = await bulkDecommissionDevices(
        selectedDevices.map(d => ({ id: d.id, hostname: d.hostname })),
        choice,
      );
      if (result.failed.length === 0) {
        showToast({ type: 'success', message: t('devicesPage.toasts.bulkDecommissioned', { count: result.succeeded }) });
      } else if (result.succeeded === 0) {
        showToast({ type: 'error', message: t('devicesPage.toasts.bulkDecommissionAllFailed', { count: result.failed.length, devices: summarizeFailedDevices(result.failed.map(f => f.hostname)) }) });
      } else {
        showToast({ type: 'error', message: t('devicesPage.toasts.bulkDecommissionFailed', { succeeded: result.succeeded, failed: result.failed.length, devices: summarizeFailedDevices(result.failed.map(f => f.hostname)) }) });
      }
      await fetchDevices();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.bulkActionFailed', { action: 'decommission' }) });
    } finally {
      setActionInProgress(false);
    }
  };
```
Check `runBulkAction`'s `finally { setActionInProgress(false) }` still runs on the early `return` (it does — `return` inside `try` runs `finally`).

e) In the JSX, change the `pendingDeviceAction` block so `decommission` renders the new dialog and everything else keeps `ConfirmDialog`:
```tsx
      {pendingDeviceAction && pendingDeviceAction.action === 'decommission' && (
        <RemoveDeviceDialog
          open
          targets={[{ hostname: pendingDeviceAction.device.hostname, status: pendingDeviceAction.device.status }]}
          onClose={() => setPendingDeviceAction(null)}
          onConfirm={(choice) => {
            const p = pendingDeviceAction;
            setPendingDeviceAction(null);
            void runDeviceAction(p.action, p.device, choice);
          }}
          confirmTestId="confirm-device-action"
        />
      )}
      {pendingDeviceAction && pendingDeviceAction.action !== 'decommission' && (
        <ConfirmDialog … existing props unchanged … />
      )}
      {pendingBulkRemove && (
        <RemoveDeviceDialog
          open
          targets={pendingBulkRemove.map(d => ({ hostname: d.hostname, status: d.status }))}
          onClose={() => setPendingBulkRemove(null)}
          onConfirm={(choice) => {
            const devicesToRemove = pendingBulkRemove;
            setPendingBulkRemove(null);
            void runBulkRemove(devicesToRemove, choice);
          }}
          isLoading={actionInProgress}
          confirmTestId="confirm-bulk-remove"
        />
      )}
```

- [ ] **Step 4: Run the whole file — expect PASS**, including the pre-existing bulk-decommission tests at :1235-1290 (update their assertions to the two-arg call: `mock.calls[0][0]` still holds the device list; they now also need to click through the new dialog — add `fireEvent.click(screen.getByTestId('confirm-bulk-remove'))` after opening "Remove Selected").

```bash
cd apps/web && npx vitest run src/components/devices/DevicesPage.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DevicesPage.tsx apps/web/src/components/devices/DevicesPage.test.tsx
git commit -m "feat(web): DevicesPage Remove (row, card, bulk) goes through RemoveDeviceDialog (#3987)"
```

---

### Task 5: Wire DeviceActions (detail page) and DeviceDetailPage

**Files:**
- Modify: `apps/web/src/components/devices/DeviceActions.tsx` (`onAction` prop :100, `handleConfirm` :251, `getModalConfig` case :176, both `<ConfirmDialog` renders :451 and :659)
- Modify: `apps/web/src/components/devices/DeviceDetailPage.tsx` (`handleAction` :219, `case "decommission"` :363)
- Test: `apps/web/src/components/devices/DeviceActions.test.tsx` (exists)

**Interfaces:**
- Produces: `onAction?: (action: string, device: Device, opts?: DeviceActionOptions) => void | Promise<void>` where `export interface DeviceActionOptions { uninstallAgent?: boolean }` is exported from `DeviceActions.tsx`.

- [ ] **Step 1: Write the failing test** (append to `DeviceActions.test.tsx`, reusing its render helper and `baseDevice`)

```tsx
it('Remove opens the agent-choice dialog and forwards the choice to onAction', () => {
  const onAction = vi.fn();
  render(<DeviceActions device={{ ...baseDevice, status: 'online' }} onAction={onAction} />);
  // open the actions menu and click Remove (testid used by the existing menu-parity tests)
  fireEvent.click(screen.getByTestId('device-actions-menu-trigger'));
  fireEvent.click(screen.getByTestId('device-action-decommission'));
  expect(screen.getByRole('radio', { name: /uninstall the breeze agent/i })).toBeChecked();
  fireEvent.click(screen.getByRole('radio', { name: /leave the agent installed/i }));
  fireEvent.click(screen.getByTestId('device-actions-remove-confirm'));
  expect(onAction).toHaveBeenCalledWith('decommission', expect.objectContaining({ id: baseDevice.id }), { uninstallAgent: false });
});
```

If the menu trigger / Remove item testids differ, read the existing parity tests in the same file and use those testids — do not add new ones for the trigger.

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceActions.test.tsx -t "agent-choice"
```

- [ ] **Step 3: Implement**

`DeviceActions.tsx`:
```ts
export interface DeviceActionOptions { uninstallAgent?: boolean }
// prop:
  onAction?: (action: string, device: Device, opts?: DeviceActionOptions) => void | Promise<void>;
```
`handleConfirm` becomes `(opts?: DeviceActionOptions)` and calls `await onAction?.(modalType, device, opts)`. Remove the `case "decommission"` from `getModalConfig` (the dialog owns its copy). At BOTH `<ConfirmDialog` render sites (compact :451 and full :659) wrap:
```tsx
        {modalType === 'decommission' ? (
          <RemoveDeviceDialog
            open
            targets={[{ hostname: device.hostname, status: device.status }]}
            onClose={closeModal}
            onConfirm={(choice) => void handleConfirm(choice)}
            isLoading={loading}
            confirmTestId="device-actions-remove-confirm"
          />
        ) : modalCfg && (
          <ConfirmDialog … unchanged … />
        )}
```
Import `RemoveDeviceDialog from './RemoveDeviceDialog'`.

`DeviceDetailPage.tsx`: `handleAction = async (action: string, device: Device, opts?: DeviceActionOptions)`; in `case "decommission"` call `await decommissionDevice(device.id, { uninstallAgent: opts?.uninstallAgent ?? true });`. Import the `DeviceActionOptions` type from `./DeviceActions`.

- [ ] **Step 4: Run — expect PASS.** Then `cd apps/web && npx tsc --noEmit -p tsconfig.json` — expect zero errors from `deviceActions`, `DevicesPage`, `DeviceDetailPage`, `DeviceActions`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceActions.tsx apps/web/src/components/devices/DeviceActions.test.tsx apps/web/src/components/devices/DeviceDetailPage.tsx
git commit -m "feat(web): detail-page Remove goes through RemoveDeviceDialog (#3987)"
```

---

### Task 6: Wire PossibleReplacementBanner (the fifth surface)

**Files:**
- Modify: `apps/web/src/components/devices/PossibleReplacementBanner.tsx:115-125` and `:198-218`
- Test: `apps/web/src/components/devices/PossibleReplacementBanner.test.tsx`

- [ ] **Step 1: Write the failing test** (append; file already mocks `fetchWithAuth` and has `jsonResponse` + `oldDevicePayload`)

```tsx
it('Remove old device asks about the agent and sends uninstallAgent in the DELETE body', async () => {
  fetchWithAuthMock.mockResolvedValueOnce(jsonResponse(oldDevicePayload({ status: 'offline' })));
  fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ uninstallDrainWindowHours: 72 })); // removal-config
  fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ success: true }));                 // DELETE
  fetchWithAuthMock.mockResolvedValueOnce(jsonResponse(oldDevicePayload({ status: 'decommissioned' })));
  render(<PossibleReplacementBanner oldDeviceId={OLD_DEVICE_ID} />);
  fireEvent.click(await screen.findByRole('button', { name: /remove old device/i }));
  expect(screen.getByRole('radio', { name: /uninstall the breeze agent/i })).toBeChecked();
  fireEvent.click(screen.getByTestId('possible-replacement-confirm'));
  await waitFor(() => {
    const del = fetchWithAuthMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(del).toBeDefined();
    expect(JSON.parse(String(del![1]?.body))).toEqual({ uninstallAgent: true });
  });
});
```

(If the banner test file mocks `../../services/deviceActions` elsewhere, mock `fetchRemovalConfig` there instead of the second `fetchWithAuth` response.)

- [ ] **Step 2: Run — expect FAIL**

```bash
cd apps/web && npx vitest run src/components/devices/PossibleReplacementBanner.test.tsx -t "uninstallAgent"
```

- [ ] **Step 3: Implement**

`handleDecommission = async (choice: { uninstallAgent: boolean })` and the request becomes:
```ts
        request: () => fetchWithAuth(`/devices/${oldDeviceId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uninstallAgent: choice.uninstallAgent }),
        }),
```
Replace the `<ConfirmDialog …>` at :202 with:
```tsx
        <RemoveDeviceDialog
          open
          targets={[{ hostname: label, status: oldDevice?.status ?? 'offline' }]}
          onClose={() => { if (!busy) setConfirmOpen(false); }}
          onConfirm={(choice) => void handleDecommission(choice)}
          isLoading={busy}
          confirmTestId="possible-replacement-confirm"
        />
```
Import `RemoveDeviceDialog`; drop the now-unused `ConfirmDialog` import; update the comment at :50 to name `RemoveDeviceDialog`.

- [ ] **Step 4: Run the whole file — expect PASS.** Run `npx vitest run src/lib/__tests__/no-silent-mutations.test.ts` — PASS (still goes through `runAction`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/PossibleReplacementBanner.tsx apps/web/src/components/devices/PossibleReplacementBanner.test.tsx
git commit -m "feat(web): replacement banner Remove goes through RemoveDeviceDialog (#3987)"
```

---

### Task 7: Guard — no bodyless Remove can come back

**Files:**
- Create: `apps/web/src/components/devices/__tests__/removeSendsUninstallChoice.test.ts`

- [ ] **Step 1: Write the test** (static source scan; fails on any `DELETE` to `/devices/${…}` without a JSON body outside `deviceActions.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe('every Remove sends the agent choice (#3987)', () => {
  it('no component issues a bodyless DELETE /devices/:id', () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, 'components'))) {
      const src = readFileSync(file, 'utf8');
      // fetchWithAuth(`/devices/${x}`, { method: 'DELETE' }) with no `body:` in the same call
      const re = /fetchWithAuth\(\s*`\/devices\/\$\{[^}]+\}`\s*,\s*\{([^}]*)\}\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/method:\s*['"]DELETE['"]/.test(m[1]) && !/body:/.test(m[1])) offenders.push(file.replace(root, ''));
      }
    }
    expect(offenders, 'Route these through decommissionDevice(id, { uninstallAgent }) or add the JSON body').toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect PASS** (Task 6 removed the last offender). Temporarily revert Task 6's body to confirm it FAILS, then restore.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/devices/__tests__/removeSendsUninstallChoice.test.ts
git commit -m "test(web): guard — every Remove must send the agent choice (#3987)"
```

---

### Task 8: PR

- [ ] Run: `cd apps/web && npx vitest run src/components/devices src/services/deviceActions.test.ts src/lib/i18n` and `cd apps/api && npx vitest run src/routes/devices` — all green. `pnpm lint` clean.
- [ ] Merge `origin/main` into the branch before pushing (CI tests the merge commit).
- [ ] Open PR titled `feat(web): Remove asks about the agent — uninstall by default (#3987 items 2, 6)`. Body: the zombie gap (web never sent `uninstallAgent`), the five surfaces, the copy decisions (queued not "runs now"; window fetched), screenshots of single and bulk dialogs. `Refs #3987, closes #2250`. Stop at the PR.
