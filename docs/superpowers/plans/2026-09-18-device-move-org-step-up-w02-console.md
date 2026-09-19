---
tracking_issue: LanternOps/breeze#6301
---

# Device Move-Org Step-Up — W02 Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the console a "Move to Organization" action on the device page that drives `POST /devices/:id/move-org` through the server-driven two-phase step-up flow shipped for maintenance mode (W01 put the route behind an interactive-session gate and a `device_move_org` step-up grant).

**Architecture:** One dependency-free canonicaliser (`lib/moveOrgResource.ts`) produces the single object used for BOTH the step-up mint resource and the request body, so the two server digests cannot drift. A typed service call (`deviceActions.moveDeviceOrg`) surfaces `status` + `code` so the dialog can branch on `STEP_UP_REQUIRED` / `MFA_REQUIRED` / `TICKET_MOVE_CURRENCY_BLOCKED`. `MoveDeviceOrgDialog` mirrors `MaintenanceModeDialog` phase-for-phase; the first submit never carries a grant — the server's 403 reveals the factor step. The menu entry is gated client-side (partner/system scope + `devices:write` + `organizations:write`) purely as UX; the server remains the authority.

**Tech Stack:** React 19 + TypeScript, Vitest + jsdom + Testing Library, react-i18next (namespace `devices`), zustand stores (`useAuthStore`, `useOrgStore`), `fetchWithAuth`, `@simplewebauthn/browser` (already wrapped by `lib/mfaStepUp.ts`).

**Spec:** `docs/superpowers/specs/2026-09-18-device-move-org-step-up-design.md` — this plan implements **D5** (and the Web rows of the tests table) only. W01 (API) is `docs/superpowers/plans/2026-09-18-device-move-org-step-up-w01-api.md`; W03 (`mfa_src`) is separate.

## Global Constraints

- **Server-driven step-up, no client copy of the gate.** The first submit carries NO `stepUpGrant`. Only a `403 { code: 'STEP_UP_REQUIRED' }` reveals the factor step. The web never reads `ENABLE_2FA`. (Spec D5, `MaintenanceModeDialog.tsx:45-54`.)
- **One canonical object for mint and body.** Mint resource and request body are built from the same `canonicalMoveOrgResource(...)` result. A drift is a 403 the technician cannot diagnose (the route conflates missing/stale/mismatched grants on purpose).
- **Step-up operation name:** `device_move_org`. **Resource shape (server authority, W01):** `{ deviceId: string; targetOrgId: string; targetSiteId: string; acceptCurrencyMismatch: boolean }`, keys emitted in exactly that spelling; the server canonicalises `undefined → false`, the client always sends an explicit boolean.
- **Request body to `POST /devices/:id/move-org`:** `{ orgId, siteId, acceptCurrencyMismatch?: boolean, stepUpGrant?: string }` (`routes/devices/schemas.ts:241-249` + W01's optional `stepUpGrant`). Not `.strict()`.
- **Error codes the dialog branches on:** `403 STEP_UP_REQUIRED` (reveal factor step), `403 MFA_REQUIRED` (own copy, do NOT reveal the step), `409 TICKET_MOVE_CURRENCY_BLOCKED` with `details: { sourceCurrency, targetCurrency, unbilledTimeEntries, unbilledParts, blockedByCurrency }` (reveal the accept checkbox only if `can('invoices','write')`), `409 PAM_DEVICE_MOVE_BLOCKED` / `409 DELIVERABLE_TICKET_PINNED` (show message verbatim).
- **Mutations go through the typed service in `services/deviceActions.ts`** (already on `RUN_ACTION_ALLOWLIST`); no raw mutating `fetchWithAuth` in components (CLAUDE.md "Web Mutation Handlers").
- **Success response:** `{ success: true, device: PublicDevice | null }` (`moveOrg.ts:1222-1225`). The route disconnects the agent after commit, so the page **refetches** rather than assumes.
- **Permission constants:** `devices:write`, `organizations:write`, `invoices:write` (`packages/shared/src/constants/permissions.ts:22,118,75`).
- **i18n parity:** every key added to `en/devices.json` must be added, with a real translation, to `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` (`apps/web/src/locales/README.md`, parity enforced in tests).
- **Test discipline:** every gate test is written red first; component tests assert the exact mint resource object (whole-object equality) and the exact resubmit body.
- **Run tests with** `cd apps/web && npx vitest run <path>` (never `pnpm … test -- --run`).

---

### Task 1: `lib/moveOrgResource.ts` canonicaliser

**Files:**
- Create: `apps/web/src/lib/moveOrgResource.ts`
- Test: `apps/web/src/lib/moveOrgResource.test.ts`

**Interfaces:**
- Consumes: nothing (dependency-free on purpose — component tests that mock `services/deviceActions` must still get the real canonicalisation).
- Produces:
  ```ts
  export interface MoveOrgResource {
    deviceId: string;
    targetOrgId: string;
    targetSiteId: string;
    acceptCurrencyMismatch: boolean;
  }
  export function canonicalMoveOrgResource(input: {
    deviceId: string; targetOrgId: string; targetSiteId: string; acceptCurrencyMismatch?: boolean;
  }): MoveOrgResource;
  export function moveOrgRequestBody(resource: MoveOrgResource, stepUpGrant?: string): {
    orgId: string; siteId: string; acceptCurrencyMismatch: boolean; stepUpGrant?: string;
  };
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/moveOrgResource.test.ts
import { describe, expect, it } from 'vitest';
import { canonicalMoveOrgResource, moveOrgRequestBody } from './moveOrgResource';

/**
 * The step-up grant for device_move_org is bound to
 *   sha256(JSON.stringify({ acceptCurrencyMismatch, deviceId, targetOrgId, targetSiteId }))
 * — `moveOrgResourceDigest` in apps/api/src/services/mfaStepUpGrant.ts (W01).
 * The client mints AND submits from ONE object produced here, so the two
 * digests cannot drift. A mismatch is a 403 that is deliberately
 * indistinguishable from a missing grant.
 */
describe('canonicalMoveOrgResource (move-org step-up D5)', () => {
  it('defaults acceptCurrencyMismatch to an explicit false, exactly as the server canonicalises undefined', () => {
    expect(
      canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2' }),
    ).toEqual({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: false });
  });

  it('keeps an explicit true', () => {
    expect(
      canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: true })
        .acceptCurrencyMismatch,
    ).toBe(true);
  });

  it('produces exactly the four fields the digest hashes, and nothing else', () => {
    const out = canonicalMoveOrgResource({
      deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: false,
      // @ts-expect-error — an extra field must be dropped, never forwarded into the digest
      extra: 'x',
    });
    expect(Object.keys(out).sort()).toEqual(['acceptCurrencyMismatch', 'deviceId', 'targetOrgId', 'targetSiteId']);
  });
});

describe('moveOrgRequestBody', () => {
  it('maps the canonical resource onto the route body and omits stepUpGrant when absent', () => {
    const resource = canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2' });
    expect(moveOrgRequestBody(resource)).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false });
  });

  it('carries stepUpGrant when given', () => {
    const resource = canonicalMoveOrgResource({ deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: true });
    expect(moveOrgRequestBody(resource, 'grant-1')).toEqual({
      orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true, stepUpGrant: 'grant-1',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/moveOrgResource.test.ts`
Expected: FAIL — `Failed to resolve import "./moveOrgResource"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/moveOrgResource.ts
/**
 * The canonical `{ deviceId, targetOrgId, targetSiteId, acceptCurrencyMismatch }`
 * a device_move_org step-up grant is bound to (spec D2/D5).
 *
 * The server hashes
 *   JSON.stringify({ acceptCurrencyMismatch, deviceId, targetOrgId, targetSiteId })
 * in `moveOrgResourceDigest` (apps/api/src/services/mfaStepUpGrant.ts) — once
 * when minting the grant and once when spending it. The client builds ONE
 * object here and uses it for BOTH the mint resource and the request body, so
 * the two hashed inputs cannot drift.
 *
 * The move-org route answers missing / stale / mismatched grants with the SAME
 * 403 STEP_UP_REQUIRED so the response is not a probing oracle for the
 * binding. A client that minted against even a slightly different target is a
 * 403 loop the technician cannot diagnose.
 *
 * This module has no dependencies on purpose: it is imported by the dialog, and
 * component tests that mock `services/deviceActions` must still get the real
 * canonicalization.
 */
export interface MoveOrgResource {
  deviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  acceptCurrencyMismatch: boolean;
}

export function canonicalMoveOrgResource(input: {
  deviceId: string;
  targetOrgId: string;
  targetSiteId: string;
  acceptCurrencyMismatch?: boolean;
}): MoveOrgResource {
  // Enumerated, never spread: the server digests exactly these four keys, so an
  // extra field on the input must not reach the mint resource.
  return {
    deviceId: input.deviceId,
    targetOrgId: input.targetOrgId,
    targetSiteId: input.targetSiteId,
    acceptCurrencyMismatch: input.acceptCurrencyMismatch === true,
  };
}

/** The body `POST /devices/:id/move-org` takes (routes/devices/schemas.ts moveOrgSchema + W01 stepUpGrant). */
export function moveOrgRequestBody(
  resource: MoveOrgResource,
  stepUpGrant?: string,
): { orgId: string; siteId: string; acceptCurrencyMismatch: boolean; stepUpGrant?: string } {
  return {
    orgId: resource.targetOrgId,
    siteId: resource.targetSiteId,
    acceptCurrencyMismatch: resource.acceptCurrencyMismatch,
    ...(stepUpGrant ? { stepUpGrant } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/moveOrgResource.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/moveOrgResource.ts apps/web/src/lib/moveOrgResource.test.ts
git commit -m "feat(web): canonical move-org step-up resource shared by mint and body"
```

---

### Task 2: `deviceActions.moveDeviceOrg` + generalised `DeviceActionError`

**Files:**
- Modify: `apps/web/src/services/deviceActions.ts:588-623` (rename the error class, generalise the request helper) and append `moveDeviceOrg` after `bulkEnterMaintenanceMode` (~`:815`)
- Test: `apps/web/src/services/__tests__/deviceActions.test.ts`

**Interfaces:**
- Consumes: `moveOrgRequestBody` from Task 1 (type only — the service takes the already-built body).
- Produces:
  ```ts
  export class DeviceActionError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown);
  }
  /** Kept so existing imports keep compiling; identical class. */
  export const MaintenanceActionError: typeof DeviceActionError;
  export type MaintenanceActionError = DeviceActionError;
  export interface MoveDeviceOrgBody { orgId: string; siteId: string; acceptCurrencyMismatch?: boolean; stepUpGrant?: string }
  export interface MoveDeviceOrgResult { success: true; device: Record<string, unknown> | null }
  export async function moveDeviceOrg(deviceId: string, body: MoveDeviceOrgBody): Promise<MoveDeviceOrgResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Add inside the top-level `describe('deviceActions service', …)` block of `apps/web/src/services/__tests__/deviceActions.test.ts` (after the maintenance describe) and extend the import list with `moveDeviceOrg, DeviceActionError`:

```ts
  describe('moveDeviceOrg', () => {
    it('POSTs the body verbatim to /devices/:id/move-org and unwraps the JSON', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({ success: true, device: { id: 'dev-1', orgId: 'o2' } }));

      const result = await moveDeviceOrg('dev-1', { orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false });

      const [path, init] = fetchWithAuthMock.mock.calls[0] as [string, RequestInit];
      expect(path).toBe('/devices/dev-1/move-org');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false });
      expect(result).toEqual({ success: true, device: { id: 'dev-1', orgId: 'o2' } });
    });

    it('surfaces status + code so the dialog can branch on STEP_UP_REQUIRED vs MFA_REQUIRED', async () => {
      fetchWithAuthMock.mockResolvedValue(
        makeResponse({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' }, false, 403)
      );

      await expect(
        moveDeviceOrg('dev-1', { orgId: 'o2', siteId: 's2' })
      ).rejects.toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED', message: 'Step-up required' });
    });

    it('carries the 409 currency-guard details so the dialog can render what is blocking', async () => {
      const details = {
        sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 3, unbilledParts: 1,
        blockedByCurrency: [{ currency: 'USD', timeEntries: 3, parts: 1 }],
      };
      fetchWithAuthMock.mockResolvedValue(
        makeResponse({ error: 'Unbilled work in another currency', code: 'TICKET_MOVE_CURRENCY_BLOCKED', details }, false, 409)
      );

      const err = await moveDeviceOrg('dev-1', { orgId: 'o2', siteId: 's2' }).catch((e) => e);
      expect(err).toBeInstanceOf(DeviceActionError);
      expect(err).toMatchObject({ status: 409, code: 'TICKET_MOVE_CURRENCY_BLOCKED', details });
    });

    it('a failed request still rejects with DeviceActionError when the body carries no error string', async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse({}, false, 500));

      await expect(moveDeviceOrg('dev-1', { orgId: 'o2', siteId: 's2' })).rejects.toBeInstanceOf(DeviceActionError);
    });
  });
```

Also change the existing maintenance assertion at `deviceActions.test.ts:180` to prove the alias still works:

```ts
      await expect(exitMaintenanceMode('dev-1')).rejects.toBeInstanceOf(MaintenanceActionError);
      await expect(exitMaintenanceMode('dev-1')).rejects.toBeInstanceOf(DeviceActionError);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/services/__tests__/deviceActions.test.ts`
Expected: FAIL — `moveDeviceOrg is not a function` / `DeviceActionError` undefined.

- [ ] **Step 3: Implement**

Replace the block at `apps/web/src/services/deviceActions.ts:588-623` (the `MaintenanceActionError` class and `maintenanceRequest`) with:

```ts
/**
 * Typed error for gated device mutations (maintenance entry, org move).
 * `code` is what dialogs branch on: STEP_UP_REQUIRED reveals the factor step,
 * MFA_REQUIRED does not (a full MFA sign-in is needed, and a step-up factor
 * cannot substitute for it). `details` carries structured refusal context
 * (e.g. the 409 TICKET_MOVE_CURRENCY_BLOCKED guard summary).
 */
export class DeviceActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'DeviceActionError';
  }
}

/**
 * Manual maintenance mode (RMM-QA-176 D10). Kept as an alias so existing
 * imports keep compiling; it IS DeviceActionError.
 */
export const MaintenanceActionError = DeviceActionError;
export type MaintenanceActionError = DeviceActionError;

async function gatedRequest(path: string, body: unknown, fallback: string): Promise<any> {
  const response = await fetchWithAuth(path, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const parsed = await response.json().catch(() => null);
    throw new DeviceActionError(
      (parsed as { error?: string } | null)?.error ?? fallback,
      response.status,
      (parsed as { code?: string } | null)?.code,
      (parsed as { details?: unknown } | null)?.details
    );
  }
  const data = await response.json();
  return data.data ?? data;
}

async function maintenanceRequest(path: string, body: unknown): Promise<any> {
  return gatedRequest(path, body, 'Failed to update maintenance mode');
}
```

Then append after `bulkEnterMaintenanceMode`:

```ts
// ---------------------------------------------------------------------------
// Move a device to another organization (spec 2026-09-18 device-move-org D5)
// ---------------------------------------------------------------------------

export interface MoveDeviceOrgBody {
  orgId: string;
  siteId: string;
  acceptCurrencyMismatch?: boolean;
  /**
   * Deliberately optional and omitted on the first submit: the SERVER decides
   * whether a factor is required (403 STEP_UP_REQUIRED), so a 2FA-off
   * deployment never prompts and the client can never decide for itself that
   * it does not need one.
   */
  stepUpGrant?: string;
}

export interface MoveDeviceOrgResult {
  success: true;
  device: Record<string, unknown> | null;
}

/**
 * Relocates a device (and its tickets) to another organization of the same
 * partner. The route disconnects the agent after commit, so callers refetch
 * the device rather than trusting the echoed row.
 */
export async function moveDeviceOrg(deviceId: string, body: MoveDeviceOrgBody): Promise<MoveDeviceOrgResult> {
  return gatedRequest(`/devices/${deviceId}/move-org`, body, 'Failed to move device');
}
```

Note: `gatedRequest` returns `data.data ?? data`; the move-org route answers `{ success, device }` with no `data` wrapper, so the result is the body itself — the first test pins that.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/services/__tests__/deviceActions.test.ts src/components/devices/MaintenanceModeDialog.test.tsx`
Expected: PASS (all; the maintenance dialog suite proves the rename is behaviour-neutral).

- [ ] **Step 5: Typecheck the web app**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/deviceActions.ts apps/web/src/services/__tests__/deviceActions.test.ts
git commit -m "feat(web): moveDeviceOrg typed service; generalise MaintenanceActionError to DeviceActionError"
```

---

### Task 3: `MoveDeviceOrgDialog` — two-phase step-up flow

**Files:**
- Create: `apps/web/src/components/devices/MoveDeviceOrgDialog.tsx`
- Test: `apps/web/src/components/devices/MoveDeviceOrgDialog.test.tsx`
- Modify (en copy only in this task; other locales in Task 5): `apps/web/src/locales/en/devices.json` — add the `moveDeviceOrgDialog` block right after `maintenanceModeDialog`.

**Interfaces:**
- Consumes: `canonicalMoveOrgResource`, `moveOrgRequestBody` (Task 1); `moveDeviceOrg`, `DeviceActionError` (Task 2); `mintStepUpGrant`, `StepUpMintError` (`lib/mfaStepUp.ts`); `pickReauthTier`, `ReauthTier` (`components/settings/StepUpPrompt.tsx`); `fetchWithAuth` (`stores/auth`); `useOrgStore` (`stores/orgStore`, `organizations` + `fetchOrganizations`); `usePermissions` (`lib/permissions`).
- Produces:
  ```ts
  export interface MoveDeviceOrgDialogProps {
    open: boolean;
    device: { id: string; hostname: string; orgId: string; orgName: string };
    passkeyCount?: number;
    mfaMethod?: string | null;
    onClose: () => void;
    onCompleted: (result: { targetOrgId: string; targetOrgName: string }) => void;
  }
  export default function MoveDeviceOrgDialog(props: MoveDeviceOrgDialogProps): JSX.Element;
  ```

- [ ] **Step 1: Add the en copy**

In `apps/web/src/locales/en/devices.json`, immediately after the `"maintenanceModeDialog": { … }` block, add:

```json
  "moveDeviceOrgDialog": {
    "title": "Move to another organization",
    "description": "Moves {{hostname}} out of {{orgName}}. Its history, tickets and policies move with it, and the agent reconnects under the new organization.",
    "targetOrgLabel": "Target organization",
    "targetOrgPlaceholder": "Choose an organization",
    "targetSiteLabel": "Target site",
    "targetSitePlaceholder": "Choose a site",
    "loadingSites": "Loading sites…",
    "noOtherOrgs": "There is no other active organization to move this device to.",
    "noSites": "The chosen organization has no sites yet. Add a site to it first.",
    "currencyMismatchHeading": "Unbilled work in another currency",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}}: {{timeEntries}} unbilled time entries and {{parts}} unbilled parts keep their original currency after the move.",
    "currencyMismatchAccept": "I understand — move the device and keep those rows in their original currency",
    "currencyMismatchNoPermission": "Accepting this needs invoice write permission. Ask a billing administrator to bill or clear the open work first.",
    "stepUpHeading": "Confirm it's you",
    "stepUpIntro": "Moving a device between organizations requires a second factor.",
    "stepUpCodeLabel": "Authenticator code",
    "stepUpPasskeyNote": "You'll confirm with your passkey.",
    "noStepUpFactor": "Add an authenticator app or passkey to your account before moving devices between organizations.",
    "mfaRequired": "Complete MFA sign-in first, then try again.",
    "submit": "Move device",
    "submitStepUp": "Verify and move",
    "submitting": "Working…",
    "cancel": "Cancel",
    "genericError": "Failed to move the device."
  },
```

- [ ] **Step 2: Write the failing component tests**

```tsx
// apps/web/src/components/devices/MoveDeviceOrgDialog.test.tsx
import '@/lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { moveMock, mintMock, fetchMock, canMock, orgState } = vi.hoisted(() => ({
  moveMock: vi.fn(),
  mintMock: vi.fn(),
  fetchMock: vi.fn(),
  canMock: vi.fn(),
  orgState: {
    organizations: [
      { id: 'o1', name: 'Current Org', status: 'active' },
      { id: 'o2', name: 'Target Org', status: 'active' },
      { id: 'o3', name: 'Archived Org', status: 'archived' },
    ],
    fetchOrganizations: vi.fn(async () => undefined),
  },
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgState) => unknown) => selector(orgState),
}));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: canMock }) }));
vi.mock('../../services/deviceActions', () => ({
  moveDeviceOrg: moveMock,
  DeviceActionError: class DeviceActionError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
      super(message);
    }
  },
}));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));

import MoveDeviceOrgDialog from './MoveDeviceOrgDialog';

const DEVICE = { id: 'd1', hostname: 'host-a', orgId: 'o1', orgName: 'Current Org' };
const stepUpDenial = Object.assign(new Error('Step-up required'), { status: 403, code: 'STEP_UP_REQUIRED' });
const RESOURCE = { deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: false };

function renderDialog(props: Partial<React.ComponentProps<typeof MoveDeviceOrgDialog>> = {}) {
  return render(
    <MoveDeviceOrgDialog open device={DEVICE} onClose={vi.fn()} onCompleted={vi.fn()} {...props} />,
  );
}

async function chooseTarget() {
  await userEvent.selectOptions(screen.getByTestId('move-org-target-org'), 'o2');
  await userEvent.selectOptions(await screen.findByTestId('move-org-target-site'), 's2');
}

describe('MoveDeviceOrgDialog (device move-org step-up D5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMock.mockReturnValue(false);
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => {
        if (path === '/users/me') return { mfaMethod: 'totp' };
        if (path === '/auth/passkeys') return { passkeys: [] };
        if (path.startsWith('/orgs/sites?organizationId=o2')) return { data: [{ id: 's2', name: 'Site Two', orgId: 'o2' }] };
        return {};
      },
    }));
  });

  it('offers only OTHER active/trial organizations as targets', () => {
    renderDialog();
    const options = Array.from(screen.getByTestId('move-org-target-org').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Target Org');
    expect(options).not.toContain('Current Org');
    expect(options).not.toContain('Archived Org');
  });

  it('loads the chosen organization\'s sites and disables submit until both are chosen', async () => {
    renderDialog();
    expect(screen.getByTestId('move-org-submit')).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId('move-org-target-org'), 'o2');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/orgs/sites?organizationId=o2'));
    expect(screen.getByTestId('move-org-submit')).toBeDisabled();
    await userEvent.selectOptions(await screen.findByTestId('move-org-target-site'), 's2');
    expect(screen.getByTestId('move-org-submit')).toBeEnabled();
  });

  it('submits WITHOUT a grant first, then reveals the factor step on 403 STEP_UP_REQUIRED', async () => {
    moveMock.mockRejectedValueOnce(stepUpDenial);
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(screen.getByTestId('move-org-stepup-code')).toBeInTheDocument());
    expect(moveMock.mock.calls[0]).toEqual(['d1', { orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false }]);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('mints against the SAME canonical resource it submitted, then resubmits carrying the grant', async () => {
    moveMock.mockRejectedValueOnce(stepUpDenial).mockResolvedValueOnce({ success: true, device: null });
    mintMock.mockResolvedValueOnce('grant-1');
    const onCompleted = vi.fn();
    renderDialog({ onCompleted });
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(2));
    // Whole-object equality: an added or dropped field would change the server digest.
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'device_move_org',
      resource: RESOURCE,
      reauth: { method: 'totp', code: '123456' },
    });
    expect(moveMock.mock.calls[1]).toEqual([
      'd1',
      { orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false, stepUpGrant: 'grant-1' },
    ]);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith({ targetOrgId: 'o2', targetOrgName: 'Target Org' }));
  });

  it('does not dispatch after cancellation during step-up', async () => {
    moveMock.mockRejectedValueOnce(stepUpDenial);
    let finish!: (grant: string) => void;
    mintMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { unmount } = renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(mintMock).toHaveBeenCalledOnce());
    unmount();
    await act(async () => finish('late-grant'));
    expect(moveMock).toHaveBeenCalledTimes(1);
  });

  it('shows the MFA copy, not the factor step, on 403 MFA_REQUIRED', async () => {
    moveMock.mockRejectedValueOnce(Object.assign(new Error('MFA required'), { status: 403, code: 'MFA_REQUIRED' }));
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(screen.getByText(/complete mfa sign-in/i)).toBeInTheDocument());
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
  });

  it('a password-only account is only blocked after the server requests step-up', async () => {
    renderDialog({ passkeyCount: 0, mfaMethod: 'sms' });
    moveMock.mockRejectedValueOnce(stepUpDenial);
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByTestId('move-org-no-factor');
    expect(screen.getByText(/authenticator app or passkey/i)).toBeInTheDocument();
    expect(screen.queryByTestId('move-org-submit')).not.toBeInTheDocument();
  });

  it('discovers passkeys with omitted factor props and mints with the passkey ceremony', async () => {
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => {
        if (path === '/users/me') return { mfaMethod: null };
        if (path === '/auth/passkeys') return { passkeys: [{ id: 'p1' }] };
        if (path.startsWith('/orgs/sites?organizationId=o2')) return { data: [{ id: 's2', name: 'Site Two', orgId: 'o2' }] };
        return {};
      },
    }));
    moveMock.mockRejectedValueOnce(stepUpDenial).mockResolvedValueOnce({ success: true, device: null });
    mintMock.mockResolvedValueOnce('passkey-grant');
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByTestId('move-org-stepup-passkey');
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({ reauth: { method: 'passkey' } })));
    expect(moveMock.mock.calls[1][1].stepUpGrant).toBe('passkey-grant');
  });

  it('shows discovery failure without guessing a factor or minting a grant', async () => {
    fetchMock.mockImplementation(async (path: string) =>
      path.startsWith('/orgs/sites')
        ? { ok: true, json: async () => ({ data: [{ id: 's2', name: 'Site Two', orgId: 'o2' }] }) }
        : { ok: false, json: async () => ({}) },
    );
    moveMock.mockRejectedValueOnce(stepUpDenial);
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByTestId('move-org-error');
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('admits first-submit success without discovery even with no usable configured factor', async () => {
    moveMock.mockResolvedValueOnce({ success: true, device: null });
    const onCompleted = vi.fn();
    renderDialog({ passkeyCount: 0, mfaMethod: null, onCompleted });
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalledWith('/users/me');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('on 409 TICKET_MOVE_CURRENCY_BLOCKED offers the accept checkbox ONLY to invoices:write and re-mints against acceptCurrencyMismatch:true', async () => {
    canMock.mockImplementation((r: string, a: string) => r === 'invoices' && a === 'write');
    const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 3, unbilledParts: 1, blockedByCurrency: [] };
    moveMock
      .mockRejectedValueOnce(Object.assign(new Error('Unbilled work'), { status: 409, code: 'TICKET_MOVE_CURRENCY_BLOCKED', details }))
      .mockRejectedValueOnce(stepUpDenial)
      .mockResolvedValueOnce({ success: true, device: null });
    mintMock.mockResolvedValueOnce('grant-2');
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    const accept = await screen.findByTestId('move-org-currency-accept');
    expect(screen.getByText(/USD → EUR/)).toBeInTheDocument();
    await userEvent.click(accept);
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(3));
    expect(moveMock.mock.calls[1][1]).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true });
    expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({ resource: { ...RESOURCE, acceptCurrencyMismatch: true } }));
    expect(moveMock.mock.calls[2][1]).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true, stepUpGrant: 'grant-2' });
  });

  it('on 409 TICKET_MOVE_CURRENCY_BLOCKED without invoices:write explains and offers no checkbox', async () => {
    const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 3, unbilledParts: 1, blockedByCurrency: [] };
    moveMock.mockRejectedValueOnce(Object.assign(new Error('Unbilled work'), { status: 409, code: 'TICKET_MOVE_CURRENCY_BLOCKED', details }));
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByText(/invoice write permission/i);
    expect(screen.queryByTestId('move-org-currency-accept')).not.toBeInTheDocument();
  });

  it('surfaces a 409 PAM_DEVICE_MOVE_BLOCKED message verbatim', async () => {
    moveMock.mockRejectedValueOnce(Object.assign(
      new Error('Device organization move is blocked because durable PAM lifecycle evidence exists'),
      { status: 409, code: 'PAM_DEVICE_MOVE_BLOCKED' },
    ));
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(screen.getByText(/durable PAM lifecycle evidence/)).toBeInTheDocument());
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
  });

  it('shows the no-other-org state when every other org is inactive', () => {
    orgState.organizations = [
      { id: 'o1', name: 'Current Org', status: 'active' },
      { id: 'o3', name: 'Archived Org', status: 'archived' },
    ];
    renderDialog();
    expect(screen.getByTestId('move-org-no-targets')).toBeInTheDocument();
    expect(screen.queryByTestId('move-org-submit')).not.toBeInTheDocument();
    orgState.organizations = [
      { id: 'o1', name: 'Current Org', status: 'active' },
      { id: 'o2', name: 'Target Org', status: 'active' },
      { id: 'o3', name: 'Archived Org', status: 'archived' },
    ];
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/devices/MoveDeviceOrgDialog.test.tsx`
Expected: FAIL — `Failed to resolve import "./MoveDeviceOrgDialog"`.

- [ ] **Step 4: Implement the dialog**

```tsx
// apps/web/src/components/devices/MoveDeviceOrgDialog.tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { pickReauthTier, type ReauthTier } from '../settings/StepUpPrompt';
import { mintStepUpGrant, StepUpMintError } from '../../lib/mfaStepUp';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { usePermissions } from '@/lib/permissions';
import { canonicalMoveOrgResource, moveOrgRequestBody } from '../../lib/moveOrgResource';
import { moveDeviceOrg } from '../../services/deviceActions';
import '../../lib/i18n';

export interface MoveDeviceOrgDialogProps {
  open: boolean;
  device: { id: string; hostname: string; orgId: string; orgName: string };
  /**
   * The account's step-up factors, when the caller knows them. BOTH must be
   * supplied for the tier to be decidable; otherwise the dialog discovers them
   * only after the server asks for step-up (same contract as
   * MaintenanceModeDialog).
   */
  passkeyCount?: number;
  mfaMethod?: string | null;
  onClose: () => void;
  onCompleted: (result: { targetOrgId: string; targetOrgName: string }) => void;
}

type Phase = 'form' | 'stepUp';

interface SiteOption { id: string; name: string }

interface CurrencyBlock {
  sourceCurrency: string;
  targetCurrency: string;
  unbilledTimeEntries: number;
  unbilledParts: number;
}

/** Orgs a device can be moved INTO: any other org of the partner that is live. */
const MOVE_TARGET_STATUSES = new Set(['active', 'trial']);

/**
 * Move a device to another organization — spec 2026-09-18 device-move-org D5.
 *
 * SERVER-DRIVEN STEP-UP: the first submit carries NO grant. A
 * `403 { code: 'STEP_UP_REQUIRED' }` is what reveals the factor step. The web
 * never reads ENABLE_2FA, so a 2FA-off deployment succeeds on the first
 * submit and the server stays the only enforcer.
 */
export default function MoveDeviceOrgDialog({
  open,
  device,
  passkeyCount,
  mfaMethod,
  onClose,
  onCompleted,
}: MoveDeviceOrgDialogProps) {
  const { t } = useTranslation('devices');
  const { can } = usePermissions();
  const organizations = useOrgStore((s) => s.organizations);
  const fetchOrganizations = useOrgStore((s) => s.fetchOrganizations);

  // Invalidate at unmount commit so a pending proof cannot resume a dispatch.
  const live = useRef(false);
  useLayoutEffect(() => {
    live.current = open;
    return () => { live.current = false; };
  }, [open]);

  const [targetOrgId, setTargetOrgId] = useState('');
  const [targetSiteId, setTargetSiteId] = useState('');
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [acceptCurrencyMismatch, setAcceptCurrencyMismatch] = useState(false);
  const [currencyBlock, setCurrencyBlock] = useState<CurrencyBlock | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discoveredTier, setDiscoveredTier] = useState<ReauthTier | null>(null);

  // Reset on (re)open: a stale target would otherwise be minted into a grant
  // for the wrong move.
  useEffect(() => {
    if (!open) return;
    setTargetOrgId('');
    setTargetSiteId('');
    setSites([]);
    setAcceptCurrencyMismatch(false);
    setCurrencyBlock(null);
    setPhase('form');
    setCode('');
    setError(null);
    setSubmitting(false);
    setDiscoveredTier(null);
    if (organizations.length === 0) void fetchOrganizations();
  }, [open, organizations.length, fetchOrganizations]);

  const targets = useMemo(
    () => organizations.filter((o) => o.id !== device.orgId && MOVE_TARGET_STATUSES.has(o.status)),
    [organizations, device.orgId],
  );

  // Load the chosen org's sites. The route requires the target site to belong
  // to the target org, so the picker only offers those.
  useEffect(() => {
    if (!open || !targetOrgId) { setSites([]); return; }
    let cancelled = false;
    setSitesLoading(true);
    setTargetSiteId('');
    fetchWithAuth(`/orgs/sites?organizationId=${targetOrgId}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('sites'))))
      .then((data) => {
        if (cancelled) return;
        const list: SiteOption[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
        setSites(list);
      })
      .catch(() => { if (!cancelled) { setSites([]); setError(t('moveDeviceOrgDialog.genericError')); } })
      .finally(() => { if (!cancelled) setSitesLoading(false); });
    return () => { cancelled = true; };
  }, [open, targetOrgId, t]);

  const tier: ReauthTier | null = useMemo(
    () =>
      passkeyCount === undefined || mfaMethod === undefined
        ? discoveredTier
        : pickReauthTier(passkeyCount, mfaMethod),
    [passkeyCount, mfaMethod, discoveredTier],
  );
  // `password` is not a valid step-up method for device_move_org and there is
  // no authenticated step-up SMS sender, so a submit could only ever 403.
  const noUsableFactor = phase === 'stepUp' && tier === 'password';
  const canAcceptCurrency = can('invoices', 'write');

  const submit = useCallback(async () => {
    // ONE canonical object for both the mint and the body (see lib/moveOrgResource.ts).
    const resource = canonicalMoveOrgResource({
      deviceId: device.id,
      targetOrgId,
      targetSiteId,
      acceptCurrencyMismatch,
    });

    let stepUpGrant: string | undefined;
    if (phase === 'stepUp') {
      try {
        stepUpGrant = await mintStepUpGrant({
          operation: 'device_move_org',
          resource,
          reauth: tier === 'passkey' ? { method: 'passkey' } : { method: 'totp', code },
        });
      } catch (err) {
        setError(err instanceof StepUpMintError || err instanceof Error ? err.message : t('moveDeviceOrgDialog.genericError'));
        return;
      }
    }

    if (!live.current) return;

    try {
      await moveDeviceOrg(device.id, moveOrgRequestBody(resource, stepUpGrant));
      const targetOrgName = targets.find((o) => o.id === targetOrgId)?.name ?? '';
      onCompleted({ targetOrgId, targetOrgName });
      onClose();
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      const errCode = (err as { code?: string } | null)?.code;
      if (status === 403 && errCode === 'STEP_UP_REQUIRED') {
        if (tier === null) {
          try {
            const [userResponse, passkeyResponse] = await Promise.all([
              fetchWithAuth('/users/me'),
              fetchWithAuth('/auth/passkeys'),
            ]);
            if (!userResponse.ok || !passkeyResponse.ok) throw new Error();
            const user = await userResponse.json();
            const passkeyData = await passkeyResponse.json();
            const passkeys = Array.isArray(passkeyData) ? passkeyData : passkeyData?.passkeys;
            if (!user || typeof user !== 'object' || !('mfaMethod' in user) || !Array.isArray(passkeys)) {
              throw new Error();
            }
            setDiscoveredTier(pickReauthTier(passkeys.length, user.mfaMethod));
          } catch {
            setError(t('moveDeviceOrgDialog.genericError'));
            return;
          }
        }
        // The SERVER decided a factor is needed. Only now does the step appear.
        setPhase('stepUp');
        setCode('');
        setError(null);
        return;
      }
      if (status === 403 && errCode === 'MFA_REQUIRED') {
        // A step-up factor cannot substitute for a full MFA sign-in, so do NOT
        // reveal the factor step here.
        setError(t('moveDeviceOrgDialog.mfaRequired'));
        return;
      }
      if (status === 409 && errCode === 'TICKET_MOVE_CURRENCY_BLOCKED') {
        const d = (err as { details?: Partial<CurrencyBlock> } | null)?.details ?? {};
        setCurrencyBlock({
          sourceCurrency: String(d.sourceCurrency ?? ''),
          targetCurrency: String(d.targetCurrency ?? ''),
          unbilledTimeEntries: Number(d.unbilledTimeEntries ?? 0),
          unbilledParts: Number(d.unbilledParts ?? 0),
        });
        setError(null);
        return;
      }
      setError((err as { message?: string } | null)?.message ?? t('moveDeviceOrgDialog.genericError'));
    }
  }, [device.id, targetOrgId, targetSiteId, acceptCurrencyMismatch, phase, tier, code, targets, onCompleted, onClose, t]);

  const handleSubmit = useCallback(() => {
    if (submitting) return;
    setSubmitting(true);
    void submit().finally(() => setSubmitting(false));
  }, [submit, submitting]);

  const title = t('moveDeviceOrgDialog.title');
  const targetChosen = targetOrgId !== '' && targetSiteId !== '';
  const currencyGate = currencyBlock !== null && !acceptCurrencyMismatch;
  const canSubmit =
    targetChosen && !submitting && !currencyGate &&
    (phase === 'form' || tier === 'passkey' || code.length === 6);

  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="lg" className="p-6">
      <div className="flex gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/10">
          <ArrowRightLeft className="h-5 w-5 text-warning" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('moveDeviceOrgDialog.description', { hostname: device.hostname, orgName: device.orgName })}
          </p>
        </div>
      </div>

      {noUsableFactor ? (
        <p
          className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
          data-testid="move-org-no-factor"
        >
          {t('moveDeviceOrgDialog.noStepUpFactor')}
        </p>
      ) : targets.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground" data-testid="move-org-no-targets">
          {t('moveDeviceOrgDialog.noOtherOrgs')}
        </p>
      ) : (
        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="move-org-target-org">
              {t('moveDeviceOrgDialog.targetOrgLabel')}
            </label>
            <select
              id="move-org-target-org"
              data-testid="move-org-target-org"
              value={targetOrgId}
              onChange={(e) => { setTargetOrgId(e.target.value); setCurrencyBlock(null); setAcceptCurrencyMismatch(false); }}
              disabled={submitting || phase === 'stepUp'}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t('moveDeviceOrgDialog.targetOrgPlaceholder')}</option>
              {targets.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>

          {targetOrgId !== '' && (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="move-org-target-site">
                {t('moveDeviceOrgDialog.targetSiteLabel')}
              </label>
              {sitesLoading ? (
                <p className="text-xs text-muted-foreground">{t('moveDeviceOrgDialog.loadingSites')}</p>
              ) : sites.length === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="move-org-no-sites">
                  {t('moveDeviceOrgDialog.noSites')}
                </p>
              ) : (
                <select
                  id="move-org-target-site"
                  data-testid="move-org-target-site"
                  value={targetSiteId}
                  onChange={(e) => setTargetSiteId(e.target.value)}
                  disabled={submitting || phase === 'stepUp'}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">{t('moveDeviceOrgDialog.targetSitePlaceholder')}</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {currencyBlock && (
            <div className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3" data-testid="move-org-currency-block">
              <p className="text-sm font-medium">{t('moveDeviceOrgDialog.currencyMismatchHeading')}</p>
              <p className="text-xs text-muted-foreground">
                {t('moveDeviceOrgDialog.currencyMismatchDetail', {
                  sourceCurrency: currencyBlock.sourceCurrency,
                  targetCurrency: currencyBlock.targetCurrency,
                  timeEntries: currencyBlock.unbilledTimeEntries,
                  parts: currencyBlock.unbilledParts,
                })}
              </p>
              {canAcceptCurrency ? (
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="move-org-currency-accept"
                    checked={acceptCurrencyMismatch}
                    onChange={(e) => setAcceptCurrencyMismatch(e.target.checked)}
                    disabled={submitting || phase === 'stepUp'}
                    className="mt-0.5"
                  />
                  <span>{t('moveDeviceOrgDialog.currencyMismatchAccept')}</span>
                </label>
              ) : (
                <p className="text-xs text-foreground">{t('moveDeviceOrgDialog.currencyMismatchNoPermission')}</p>
              )}
            </div>
          )}

          {phase === 'stepUp' && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t('moveDeviceOrgDialog.stepUpHeading')}</p>
              <p className="text-xs text-muted-foreground">{t('moveDeviceOrgDialog.stepUpIntro')}</p>
              {tier === 'passkey' ? (
                <p className="text-xs text-muted-foreground" data-testid="move-org-stepup-passkey">
                  {t('moveDeviceOrgDialog.stepUpPasskeyNote')}
                </p>
              ) : (
                <>
                  <label className="text-sm font-medium" htmlFor="move-org-stepup-code">
                    {t('moveDeviceOrgDialog.stepUpCodeLabel')}
                  </label>
                  <input
                    id="move-org-stepup-code"
                    data-testid="move-org-stepup-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    disabled={submitting}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {error != null && (
        <p className="mt-4 flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="move-org-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          {t('moveDeviceOrgDialog.cancel')}
        </button>
        {!noUsableFactor && targets.length > 0 && (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="move-org-submit"
            className="rounded-md bg-warning px-4 py-2 text-sm font-medium text-warning-foreground hover:bg-warning/90 transition-colors disabled:opacity-50"
          >
            {submitting
              ? t('moveDeviceOrgDialog.submitting')
              : phase === 'stepUp'
                ? t('moveDeviceOrgDialog.submitStepUp')
                : t('moveDeviceOrgDialog.submit')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/devices/MoveDeviceOrgDialog.test.tsx`
Expected: PASS (14 tests). If the currency test's `USD → EUR` text assertion fails on the arrow glyph, the `en` string uses `→` (U+2192) — keep both in sync.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/MoveDeviceOrgDialog.tsx apps/web/src/components/devices/MoveDeviceOrgDialog.test.tsx apps/web/src/locales/en/devices.json
git commit -m "feat(web): MoveDeviceOrgDialog with server-driven step-up (device_move_org)"
```

---

### Task 4: Mount the action — `DeviceActions` menu entry + `DeviceDetailPage` wiring

**Files:**
- Create: `apps/web/src/lib/moveOrgCapability.ts`
- Test: `apps/web/src/lib/moveOrgCapability.test.ts`
- Modify: `apps/web/src/components/devices/DeviceActions.tsx` (menu item next to "Change Site" at `:445-453`)
- Modify: `apps/web/src/components/devices/DeviceDetailPage.tsx` (imports `:7-14`, state `:65-67`, `case "change-site"` at `:457-459`, mounts `:741-763`)
- Modify (test mocks only): `apps/web/src/components/devices/DeviceActions.test.tsx` and every `apps/web/src/components/devices/DeviceDetailPage.*.test.tsx` (10 files) whose `vi.mock('../../stores/auth', …)` factory lacks `useAuthStore`
- Test: `apps/web/src/components/devices/DeviceActions.test.tsx` (new cases), `apps/web/src/components/devices/DeviceDetailPage.moveOrg.test.tsx` (new file)
- Modify: `apps/web/src/locales/en/devices.json` — add `"moveOrg": "Move to Organization"` inside `deviceActions`.

**Interfaces:**
- Consumes: `MoveDeviceOrgDialog` (Task 3); `useJwtClaims` (`lib/authScope.ts`); `usePermissions` (`lib/permissions.ts`).
- Produces:
  ```ts
  // lib/moveOrgCapability.ts
  export function useCanMoveDeviceOrg(): boolean; // partner|system scope AND devices:write AND organizations:write
  ```
  `DeviceActions` emits `onAction('move-org', device)`; `DeviceDetailPage` handles `case 'move-org'` by opening the dialog.

- [ ] **Step 1: Write the failing hook test**

```ts
// apps/web/src/lib/moveOrgCapability.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { claimsMock, canMock } = vi.hoisted(() => ({ claimsMock: vi.fn(), canMock: vi.fn() }));
vi.mock('./authScope', () => ({ useJwtClaims: claimsMock }));
vi.mock('./permissions', () => ({ usePermissions: () => ({ permissions: [], can: canMock }) }));

import { useCanMoveDeviceOrg } from './moveOrgCapability';

const grantAll = (r: string, a: string) =>
  (r === 'devices' && a === 'write') || (r === 'organizations' && a === 'write');

describe('useCanMoveDeviceOrg', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('is true for a partner-scope caller holding devices:write and organizations:write', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(true);
  });

  it('is true for system scope with both permissions', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'system', orgId: null, partnerId: null } });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(true);
  });

  it('is false for an organization-scope caller even with both permissions (the route is partner/system only)', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'organization', orgId: 'o1', partnerId: 'p1' } });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(false);
  });

  it('is false while claims are unresolved (no flash of an action that may 403)', () => {
    claimsMock.mockReturnValue({ status: 'unresolved' });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(false);
  });

  it('is false when either permission is missing', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } });
    canMock.mockImplementation((r: string, a: string) => r === 'devices' && a === 'write');
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/moveOrgCapability.test.ts`
Expected: FAIL — cannot resolve `./moveOrgCapability`.

- [ ] **Step 3: Implement the hook**

```ts
// apps/web/src/lib/moveOrgCapability.ts
import { useJwtClaims } from './authScope';
import { usePermissions } from './permissions';

/**
 * UX-only gate for the "Move to Organization" device action. Mirrors the
 * route chain of POST /devices/:id/move-org — requireScope('partner','system')
 * + devices:write + organizations:write — so org-scoped users and
 * under-privileged technicians are not offered an action the server will 403.
 * Never an authorization decision: the server re-checks everything, and also
 * requires an interactive session plus a fresh step-up grant (W01).
 *
 * `unresolved` claims read as false so the entry does not flash then vanish on
 * a cold load (#4010).
 */
export function useCanMoveDeviceOrg(): boolean {
  const jwt = useJwtClaims();
  const { can } = usePermissions();
  if (jwt.status !== 'resolved') return false;
  const scope = jwt.claims.scope;
  if (scope !== 'partner' && scope !== 'system') return false;
  return can('devices', 'write') && can('organizations', 'write');
}
```

- [ ] **Step 4: Run the hook test to verify it passes**

Run: `cd apps/web && npx vitest run src/lib/moveOrgCapability.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing `DeviceActions` tests**

Append to `apps/web/src/components/devices/DeviceActions.test.tsx` (top-level, after the existing `it.each(['power','menu'])` case). First extend the existing `vi.mock('../../stores/auth', …)` factory so `useJwtClaims`/`usePermissions` can run, and add a hook mock:

```ts
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // useJwtClaims / usePermissions read the store; tokens:null = unresolved,
  // user:undefined = no permissions, so nothing new is offered by default.
  useAuthStore: (sel: (s: { tokens: null; user: undefined }) => unknown) => sel({ tokens: null, user: undefined }),
}));

const { canMoveOrgMock } = vi.hoisted(() => ({ canMoveOrgMock: vi.fn(() => false) }));
vi.mock('@/lib/moveOrgCapability', () => ({ useCanMoveDeviceOrg: canMoveOrgMock }));
```

Then the cases:

```ts
describe('DeviceActions — Move to Organization entry (device move-org D5)', () => {
  beforeEach(() => { vi.clearAllMocks(); canMoveOrgMock.mockReturnValue(false); });

  it('is hidden when the caller cannot move devices between organizations', async () => {
    render(<DeviceActions device={onlineDevice} onAction={vi.fn()} />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.queryByTestId('device-action-move-org')).not.toBeInTheDocument();
  });

  it('emits onAction("move-org") for a capable caller instead of opening a confirm', async () => {
    canMoveOrgMock.mockReturnValue(true);
    const onAction = vi.fn();
    render(<DeviceActions device={onlineDevice} onAction={onAction} />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    await userEvent.click(screen.getByTestId('device-action-move-org'));
    expect(onAction).toHaveBeenCalledWith('move-org', onlineDevice);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is offered for an offline device too — the move is a database operation, not an agent command', async () => {
    canMoveOrgMock.mockReturnValue(true);
    render(<DeviceActions device={offlineDevice} onAction={vi.fn()} />);
    await userEvent.click(screen.getByTestId('device-actions-menu'));
    expect(screen.getByTestId('device-action-move-org')).toBeEnabled();
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceActions.test.tsx -t "Move to Organization"`
Expected: FAIL — `device-action-move-org` not found in the capable case.

- [ ] **Step 7: Add the menu entry**

In `apps/web/src/components/devices/DeviceActions.tsx`:

1. Add imports: `import { ArrowRightLeft } from "lucide-react";` (merge into the existing `lucide-react` import) and `import { useCanMoveDeviceOrg } from "@/lib/moveOrgCapability";`.
2. Inside the component, after `const { t } = useTranslation("devices");` add `const canMoveOrg = useCanMoveDeviceOrg();`.
3. In the "…" menu, directly after the **Change Site** button (`:445-453`), add:

```tsx
              {canMoveOrg && (
                <button
                  type="button"
                  data-testid="device-action-move-org"
                  onClick={() => handleAction("move-org")}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <ArrowRightLeft className="h-4 w-4" />
                  {t("deviceActions.moveOrg")}{" "}
                </button>
              )}
```

`handleAction("move-org")` falls through to `onAction?.(action, device)` (it is not in the confirm list), which is what the test asserts.

4. In `apps/web/src/locales/en/devices.json`, inside `"deviceActions"`, next to `"changeSite": "Change Site"`, add `"moveOrg": "Move to Organization",`.

- [ ] **Step 8: Run the DeviceActions suite to verify green**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceActions.test.tsx`
Expected: PASS (all existing + 3 new).

- [ ] **Step 9: Write the failing page test**

```tsx
// apps/web/src/components/devices/DeviceDetailPage.moveOrg.test.tsx
import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { tokens: null; user: undefined }) => unknown) => sel({ tokens: null, user: undefined }),
}));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  executeScript: vi.fn(),
  exitMaintenanceMode: vi.fn(),
  decommissionDevice: vi.fn(),
  clearDeviceSessions: vi.fn(),
  restoreDevice: vi.fn(),
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error {},
  wakeFriendlyErrorMessage: vi.fn(),
  fetchRemovalConfig: vi.fn(async () => ({ uninstallDrainWindowHours: 72 })),
}));
// The page's own dialog is stubbed: what is under test is that the page OPENS
// it on `move-org` and REFETCHES on completion — the dialog's flow has its own suite.
const { dialogProps } = vi.hoisted(() => ({ dialogProps: { current: null as null | Record<string, any> } }));
vi.mock('./MoveDeviceOrgDialog', () => ({
  default: (props: Record<string, any>) => {
    dialogProps.current = props;
    return props.open ? <div data-testid="move-org-dialog-open" /> : null;
  },
}));
vi.mock('./DeviceDetails', () => ({
  default: ({ device, onAction }: { device: { hostname: string }; onAction: (a: string, d: unknown) => void }) => (
    <button type="button" data-testid="kebab-move-org" onClick={() => onAction('move-org', device)}>Move</button>
  ),
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));
vi.mock('./MaintenanceModeDialog', () => ({ default: () => null }));

const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const device = {
  id: DEVICE_ID, hostname: 'edge-01', os: 'windows', osVersion: '11', status: 'online',
  cpuPercent: 1, ramPercent: 1, lastSeen: '2026-09-18T00:00:00.000Z',
  orgId: 'o1', orgName: 'Current Org', siteId: 's1', siteName: 'HQ', agentVersion: '1.0.0', tags: [],
};

describe('DeviceDetailPage — move-org action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogProps.current = null;
    vi.mocked(fetchWithAuth).mockImplementation(async () => ({ ok: true, json: async () => ({ data: device }) }) as Response);
  });

  it('opens MoveDeviceOrgDialog on the move-org action and refetches + toasts on completion', async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    await screen.findByTestId('kebab-move-org');
    const fetchesBefore = vi.mocked(fetchWithAuth).mock.calls.length;

    screen.getByTestId('kebab-move-org').click();
    await screen.findByTestId('move-org-dialog-open');
    expect(dialogProps.current?.device).toMatchObject({ id: DEVICE_ID, orgId: 'o1', orgName: 'Current Org' });

    dialogProps.current!.onCompleted({ targetOrgId: 'o2', targetOrgName: 'Target Org' });
    await waitFor(() => expect(vi.mocked(fetchWithAuth).mock.calls.length).toBeGreaterThan(fetchesBefore));
    expect(vi.mocked(fetchWithAuth).mock.calls.at(-1)?.[0]).toBe(`/devices/${DEVICE_ID}`);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringContaining('Target Org') }));
  });
});
```

Check the page's prop name for the id before running: `grep -n "deviceId" apps/web/src/components/devices/DeviceDetailPage.tsx | head -3` and the shape the existing `DeviceDetailPage.removeDialog.test.tsx` renders with (`render(<DeviceDetailPage deviceId={DEVICE_ID} />)` or similar) — use the same.

- [ ] **Step 10: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceDetailPage.moveOrg.test.tsx`
Expected: FAIL — `move-org-dialog-open` never appears (the page ignores the action today).

- [ ] **Step 11: Wire the page**

In `apps/web/src/components/devices/DeviceDetailPage.tsx`:

1. Import: `import MoveDeviceOrgDialog from "./MoveDeviceOrgDialog";` next to the `MaintenanceModeDialog` import (`:14`).
2. State, next to `maintenanceDialogOpen` (`:67`): `const [moveOrgDialogOpen, setMoveOrgDialogOpen] = useState(false);`
3. In the action `switch`, next to `case "change-site":` (`:457`):

```tsx
        case "move-org":
          // Spec 2026-09-18 device-move-org D5: the move needs a target org,
          // a target site and possibly a step-up factor, so it opens a dialog
          // instead of firing a request here.
          setMoveOrgDialogOpen(true);
          return;
```

4. Mount, after `<MaintenanceModeDialog … />` (`:753-763`):

```tsx
      <MoveDeviceOrgDialog
        open={moveOrgDialogOpen}
        device={{ id: device.id, hostname: device.hostname, orgId: device.orgId, orgName: device.orgName }}
        onClose={() => setMoveOrgDialogOpen(false)}
        onCompleted={({ targetOrgName }) => {
          showToast({
            type: "success",
            message: t("deviceDetailPage.movedToOrg", { hostname: device.hostname, orgName: targetOrgName }),
          });
          // Refetch rather than trust the echoed row: the route disconnects
          // the agent after commit, so status and org fields settle server-side.
          void fetchDevice();
        }}
      />
```

5. Add `"movedToOrg": "{{hostname}} moved to {{orgName}}"` inside the `deviceDetailPage` block of `apps/web/src/locales/en/devices.json` (find the block with `grep -n '"deviceDetailPage"' apps/web/src/locales/en/devices.json`).

- [ ] **Step 12: Update the sibling page tests' auth mock**

Every one of these files mocks `../../stores/auth` with only `fetchWithAuth`; `DeviceActions` (rendered through the real `DeviceDetails` in some of them) now calls `useJwtClaims`/`usePermissions`, which read `useAuthStore`. Add the selector stub to each factory — same one line as in Step 9:

```
apps/web/src/components/devices/DeviceDetailPage.aiPageContextOrg.test.tsx
apps/web/src/components/devices/DeviceDetailPage.commandDelivery.test.tsx
apps/web/src/components/devices/DeviceDetailPage.liveDesktopAccess.test.tsx
apps/web/src/components/devices/DeviceDetailPage.orgBreadcrumb.test.tsx
apps/web/src/components/devices/DeviceDetailPage.permanentDelete.test.tsx
apps/web/src/components/devices/DeviceDetailPage.rebootScheduled.test.tsx
apps/web/src/components/devices/DeviceDetailPage.recents.test.tsx
apps/web/src/components/devices/DeviceDetailPage.removeDialog.test.tsx
apps/web/src/components/devices/DeviceDetailPage.scriptAdmission.test.tsx
apps/web/src/components/devices/DeviceDetailPage.uninstallState.test.tsx
```

Replace `vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));` with:

```ts
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { tokens: null; user: undefined }) => unknown) => sel({ tokens: null, user: undefined }),
}));
```

(If a file already spreads `importActual`, leave it alone.) Then also add `vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));` beside the existing `./MaintenanceModeDialog`/`./ChangeSiteModal` null-stubs in files that stub those.

- [ ] **Step 13: Run the whole devices component directory**

Run: `cd apps/web && npx vitest run src/components/devices src/lib/moveOrgCapability.test.ts`
Expected: PASS. Report the file count so a silently skipped sibling is noticed.

- [ ] **Step 14: Typecheck + lint**

Run: `cd apps/web && npx tsc --noEmit -p tsconfig.json && cd ../.. && npx eslint apps/web/src/components/devices/DeviceActions.tsx apps/web/src/components/devices/DeviceDetailPage.tsx apps/web/src/components/devices/MoveDeviceOrgDialog.tsx apps/web/src/lib/moveOrgCapability.ts`
Expected: both exit 0.

- [ ] **Step 15: Commit**

```bash
git add apps/web/src/lib/moveOrgCapability.ts apps/web/src/lib/moveOrgCapability.test.ts \
  apps/web/src/components/devices/DeviceActions.tsx apps/web/src/components/devices/DeviceActions.test.tsx \
  apps/web/src/components/devices/DeviceDetailPage.tsx apps/web/src/components/devices/DeviceDetailPage.moveOrg.test.tsx \
  apps/web/src/components/devices/DeviceDetailPage.*.test.tsx apps/web/src/locales/en/devices.json
git commit -m "feat(web): Move to Organization device action gated on partner/system scope + permissions"
```

---

### Task 5: i18n parity for every supported locale

**Files:**
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json` — add `moveDeviceOrgDialog` (after `maintenanceModeDialog`), `deviceActions.moveOrg`, `deviceDetailPage.movedToOrg`.

**Interfaces:** none (data only). Keys must match `en/devices.json` exactly; `{{placeholders}}` must be preserved verbatim.

- [ ] **Step 1: Run the parity suite to see it red**

Run: `cd apps/web && npx vitest run src/lib/i18n src/locales src/middleware.test.ts`
Expected: FAIL naming the missing keys per locale (the parity test lives in this set; if the run reports "No test files found" for a path, drop that path and rerun with the remaining ones — check the reported file count).

- [ ] **Step 2: Add the translations**

Insert into each locale's `devices.json` (same positions as en). `deviceActions.moveOrg` and `deviceDetailPage.movedToOrg` go into their existing blocks.

**de-DE**
```json
  "moveDeviceOrgDialog": {
    "title": "In eine andere Organisation verschieben",
    "description": "Verschiebt {{hostname}} aus {{orgName}}. Verlauf, Tickets und Richtlinien wandern mit, und der Agent verbindet sich unter der neuen Organisation neu.",
    "targetOrgLabel": "Zielorganisation",
    "targetOrgPlaceholder": "Organisation auswählen",
    "targetSiteLabel": "Zielstandort",
    "targetSitePlaceholder": "Standort auswählen",
    "loadingSites": "Standorte werden geladen…",
    "noOtherOrgs": "Es gibt keine andere aktive Organisation, in die dieses Gerät verschoben werden kann.",
    "noSites": "Die gewählte Organisation hat noch keine Standorte. Legen Sie zuerst einen Standort an.",
    "currencyMismatchHeading": "Nicht abgerechnete Arbeit in einer anderen Währung",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}}: {{timeEntries}} nicht abgerechnete Zeiteinträge und {{parts}} nicht abgerechnete Teile behalten nach dem Verschieben ihre ursprüngliche Währung.",
    "currencyMismatchAccept": "Verstanden – Gerät verschieben und diese Einträge in ihrer ursprünglichen Währung belassen",
    "currencyMismatchNoPermission": "Dafür ist die Berechtigung zum Schreiben von Rechnungen nötig. Bitten Sie einen Abrechnungsadministrator, die offene Arbeit zuerst abzurechnen oder zu bereinigen.",
    "stepUpHeading": "Bestätigen Sie Ihre Identität",
    "stepUpIntro": "Das Verschieben eines Geräts zwischen Organisationen erfordert einen zweiten Faktor.",
    "stepUpCodeLabel": "Authenticator-Code",
    "stepUpPasskeyNote": "Sie bestätigen mit Ihrem Passkey.",
    "noStepUpFactor": "Fügen Sie Ihrem Konto eine Authenticator-App oder einen Passkey hinzu, bevor Sie Geräte zwischen Organisationen verschieben.",
    "mfaRequired": "Schließen Sie zuerst die MFA-Anmeldung ab und versuchen Sie es erneut.",
    "submit": "Gerät verschieben",
    "submitStepUp": "Bestätigen und verschieben",
    "submitting": "Wird ausgeführt…",
    "cancel": "Abbrechen",
    "genericError": "Das Gerät konnte nicht verschoben werden."
  },
```
`"moveOrg": "In Organisation verschieben"` · `"movedToOrg": "{{hostname}} wurde nach {{orgName}} verschoben"`

**es-419**
```json
  "moveDeviceOrgDialog": {
    "title": "Mover a otra organización",
    "description": "Mueve {{hostname}} fuera de {{orgName}}. Su historial, tickets y políticas se mueven con él, y el agente se reconecta bajo la nueva organización.",
    "targetOrgLabel": "Organización de destino",
    "targetOrgPlaceholder": "Elige una organización",
    "targetSiteLabel": "Sitio de destino",
    "targetSitePlaceholder": "Elige un sitio",
    "loadingSites": "Cargando sitios…",
    "noOtherOrgs": "No hay otra organización activa a la que mover este dispositivo.",
    "noSites": "La organización elegida aún no tiene sitios. Agrega un sitio primero.",
    "currencyMismatchHeading": "Trabajo sin facturar en otra moneda",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}}: {{timeEntries}} registros de tiempo sin facturar y {{parts}} piezas sin facturar conservan su moneda original después del traslado.",
    "currencyMismatchAccept": "Entiendo: mover el dispositivo y conservar esas filas en su moneda original",
    "currencyMismatchNoPermission": "Aceptar esto requiere permiso de escritura de facturas. Pide a un administrador de facturación que facture o resuelva el trabajo pendiente primero.",
    "stepUpHeading": "Confirma que eres tú",
    "stepUpIntro": "Mover un dispositivo entre organizaciones requiere un segundo factor.",
    "stepUpCodeLabel": "Código del autenticador",
    "stepUpPasskeyNote": "Confirmarás con tu llave de acceso.",
    "noStepUpFactor": "Agrega una app de autenticación o una llave de acceso a tu cuenta antes de mover dispositivos entre organizaciones.",
    "mfaRequired": "Completa primero el inicio de sesión con MFA y vuelve a intentarlo.",
    "submit": "Mover dispositivo",
    "submitStepUp": "Verificar y mover",
    "submitting": "Procesando…",
    "cancel": "Cancelar",
    "genericError": "No se pudo mover el dispositivo."
  },
```
`"moveOrg": "Mover a organización"` · `"movedToOrg": "{{hostname}} se movió a {{orgName}}"`

**fr-CA**
```json
  "moveDeviceOrgDialog": {
    "title": "Déplacer vers une autre organisation",
    "description": "Retire {{hostname}} de {{orgName}}. Son historique, ses billets et ses politiques suivent, et l'agent se reconnecte sous la nouvelle organisation.",
    "targetOrgLabel": "Organisation cible",
    "targetOrgPlaceholder": "Choisir une organisation",
    "targetSiteLabel": "Site cible",
    "targetSitePlaceholder": "Choisir un site",
    "loadingSites": "Chargement des sites…",
    "noOtherOrgs": "Aucune autre organisation active ne peut recevoir cet appareil.",
    "noSites": "L'organisation choisie n'a pas encore de site. Ajoutez-en un d'abord.",
    "currencyMismatchHeading": "Travail non facturé dans une autre devise",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}} : {{timeEntries}} entrées de temps non facturées et {{parts}} pièces non facturées conservent leur devise d'origine après le déplacement.",
    "currencyMismatchAccept": "Je comprends – déplacer l'appareil et conserver ces lignes dans leur devise d'origine",
    "currencyMismatchNoPermission": "Cette acceptation exige la permission d'écriture des factures. Demandez à un administrateur de facturation de facturer ou de régler le travail en suspens d'abord.",
    "stepUpHeading": "Confirmez votre identité",
    "stepUpIntro": "Déplacer un appareil entre organisations exige un second facteur.",
    "stepUpCodeLabel": "Code de l'authentificateur",
    "stepUpPasskeyNote": "Vous confirmerez avec votre clé d'accès.",
    "noStepUpFactor": "Ajoutez une application d'authentification ou une clé d'accès à votre compte avant de déplacer des appareils entre organisations.",
    "mfaRequired": "Terminez d'abord la connexion MFA, puis réessayez.",
    "submit": "Déplacer l'appareil",
    "submitStepUp": "Vérifier et déplacer",
    "submitting": "En cours…",
    "cancel": "Annuler",
    "genericError": "Impossible de déplacer l'appareil."
  },
```
`"moveOrg": "Déplacer vers une organisation"` · `"movedToOrg": "{{hostname}} a été déplacé vers {{orgName}}"`

**fr-FR**
```json
  "moveDeviceOrgDialog": {
    "title": "Déplacer vers une autre organisation",
    "description": "Retire {{hostname}} de {{orgName}}. Son historique, ses tickets et ses stratégies suivent, et l'agent se reconnecte sous la nouvelle organisation.",
    "targetOrgLabel": "Organisation cible",
    "targetOrgPlaceholder": "Choisir une organisation",
    "targetSiteLabel": "Site cible",
    "targetSitePlaceholder": "Choisir un site",
    "loadingSites": "Chargement des sites…",
    "noOtherOrgs": "Aucune autre organisation active ne peut accueillir cet appareil.",
    "noSites": "L'organisation choisie n'a pas encore de site. Ajoutez-en un d'abord.",
    "currencyMismatchHeading": "Travail non facturé dans une autre devise",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}} : {{timeEntries}} saisies de temps non facturées et {{parts}} pièces non facturées conservent leur devise d'origine après le déplacement.",
    "currencyMismatchAccept": "Je comprends – déplacer l'appareil et conserver ces lignes dans leur devise d'origine",
    "currencyMismatchNoPermission": "Cette acceptation nécessite le droit d'écriture sur les factures. Demandez à un administrateur de facturation de facturer ou de solder le travail en attente d'abord.",
    "stepUpHeading": "Confirmez votre identité",
    "stepUpIntro": "Déplacer un appareil entre organisations nécessite un second facteur.",
    "stepUpCodeLabel": "Code de l'application d'authentification",
    "stepUpPasskeyNote": "Vous confirmerez avec votre passkey.",
    "noStepUpFactor": "Ajoutez une application d'authentification ou une passkey à votre compte avant de déplacer des appareils entre organisations.",
    "mfaRequired": "Terminez d'abord la connexion MFA, puis réessayez.",
    "submit": "Déplacer l'appareil",
    "submitStepUp": "Vérifier et déplacer",
    "submitting": "En cours…",
    "cancel": "Annuler",
    "genericError": "Impossible de déplacer l'appareil."
  },
```
`"moveOrg": "Déplacer vers une organisation"` · `"movedToOrg": "{{hostname}} a été déplacé vers {{orgName}}"`

**it-IT**
```json
  "moveDeviceOrgDialog": {
    "title": "Sposta in un'altra organizzazione",
    "description": "Sposta {{hostname}} fuori da {{orgName}}. Cronologia, ticket e criteri lo seguono e l'agente si riconnette sotto la nuova organizzazione.",
    "targetOrgLabel": "Organizzazione di destinazione",
    "targetOrgPlaceholder": "Scegli un'organizzazione",
    "targetSiteLabel": "Sede di destinazione",
    "targetSitePlaceholder": "Scegli una sede",
    "loadingSites": "Caricamento delle sedi…",
    "noOtherOrgs": "Non esiste un'altra organizzazione attiva in cui spostare questo dispositivo.",
    "noSites": "L'organizzazione scelta non ha ancora sedi. Aggiungine prima una.",
    "currencyMismatchHeading": "Lavoro non fatturato in un'altra valuta",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}}: {{timeEntries}} registrazioni di tempo non fatturate e {{parts}} parti non fatturate mantengono la valuta originale dopo lo spostamento.",
    "currencyMismatchAccept": "Ho capito: sposta il dispositivo e mantieni quelle righe nella valuta originale",
    "currencyMismatchNoPermission": "Per accettare serve il permesso di scrittura delle fatture. Chiedi a un amministratore della fatturazione di fatturare o chiudere prima il lavoro aperto.",
    "stepUpHeading": "Conferma la tua identità",
    "stepUpIntro": "Spostare un dispositivo tra organizzazioni richiede un secondo fattore.",
    "stepUpCodeLabel": "Codice dell'app di autenticazione",
    "stepUpPasskeyNote": "Confermerai con la tua passkey.",
    "noStepUpFactor": "Aggiungi un'app di autenticazione o una passkey al tuo account prima di spostare dispositivi tra organizzazioni.",
    "mfaRequired": "Completa prima l'accesso MFA, poi riprova.",
    "submit": "Sposta dispositivo",
    "submitStepUp": "Verifica e sposta",
    "submitting": "In corso…",
    "cancel": "Annulla",
    "genericError": "Impossibile spostare il dispositivo."
  },
```
`"moveOrg": "Sposta in un'organizzazione"` · `"movedToOrg": "{{hostname}} è stato spostato in {{orgName}}"`

**pt-BR**
```json
  "moveDeviceOrgDialog": {
    "title": "Mover para outra organização",
    "description": "Move {{hostname}} para fora de {{orgName}}. Histórico, tickets e políticas vão junto, e o agente reconecta sob a nova organização.",
    "targetOrgLabel": "Organização de destino",
    "targetOrgPlaceholder": "Escolha uma organização",
    "targetSiteLabel": "Local de destino",
    "targetSitePlaceholder": "Escolha um local",
    "loadingSites": "Carregando locais…",
    "noOtherOrgs": "Não há outra organização ativa para a qual mover este dispositivo.",
    "noSites": "A organização escolhida ainda não tem locais. Adicione um local primeiro.",
    "currencyMismatchHeading": "Trabalho não faturado em outra moeda",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}}: {{timeEntries}} lançamentos de tempo não faturados e {{parts}} peças não faturadas mantêm a moeda original após a movimentação.",
    "currencyMismatchAccept": "Entendi — mover o dispositivo e manter essas linhas na moeda original",
    "currencyMismatchNoPermission": "Aceitar isso exige permissão de escrita em faturas. Peça a um administrador de faturamento para faturar ou resolver o trabalho pendente primeiro.",
    "stepUpHeading": "Confirme que é você",
    "stepUpIntro": "Mover um dispositivo entre organizações exige um segundo fator.",
    "stepUpCodeLabel": "Código do autenticador",
    "stepUpPasskeyNote": "Você confirmará com sua chave de acesso.",
    "noStepUpFactor": "Adicione um app autenticador ou uma chave de acesso à sua conta antes de mover dispositivos entre organizações.",
    "mfaRequired": "Conclua primeiro o login com MFA e tente novamente.",
    "submit": "Mover dispositivo",
    "submitStepUp": "Verificar e mover",
    "submitting": "Processando…",
    "cancel": "Cancelar",
    "genericError": "Não foi possível mover o dispositivo."
  },
```
`"moveOrg": "Mover para organização"` · `"movedToOrg": "{{hostname}} foi movido para {{orgName}}"`

**tr-TR**
```json
  "moveDeviceOrgDialog": {
    "title": "Başka bir kuruluşa taşı",
    "description": "{{hostname}} cihazını {{orgName}} kuruluşundan çıkarır. Geçmişi, biletleri ve ilkeleri onunla birlikte taşınır ve aracı yeni kuruluş altında yeniden bağlanır.",
    "targetOrgLabel": "Hedef kuruluş",
    "targetOrgPlaceholder": "Bir kuruluş seçin",
    "targetSiteLabel": "Hedef konum",
    "targetSitePlaceholder": "Bir konum seçin",
    "loadingSites": "Konumlar yükleniyor…",
    "noOtherOrgs": "Bu cihazın taşınabileceği başka bir etkin kuruluş yok.",
    "noSites": "Seçilen kuruluşun henüz konumu yok. Önce bir konum ekleyin.",
    "currencyMismatchHeading": "Başka bir para biriminde faturalandırılmamış iş",
    "currencyMismatchDetail": "{{sourceCurrency}} → {{targetCurrency}}: {{timeEntries}} faturalandırılmamış zaman girişi ve {{parts}} faturalandırılmamış parça, taşımadan sonra orijinal para birimini korur.",
    "currencyMismatchAccept": "Anladım — cihazı taşı ve bu satırları orijinal para biriminde bırak",
    "currencyMismatchNoPermission": "Bunu kabul etmek için fatura yazma izni gerekir. Önce bir faturalama yöneticisinden açık işi faturalandırmasını veya temizlemesini isteyin.",
    "stepUpHeading": "Siz olduğunuzu doğrulayın",
    "stepUpIntro": "Bir cihazı kuruluşlar arasında taşımak ikinci bir faktör gerektirir.",
    "stepUpCodeLabel": "Kimlik doğrulayıcı kodu",
    "stepUpPasskeyNote": "Geçiş anahtarınızla doğrulayacaksınız.",
    "noStepUpFactor": "Cihazları kuruluşlar arasında taşımadan önce hesabınıza bir kimlik doğrulayıcı uygulaması veya geçiş anahtarı ekleyin.",
    "mfaRequired": "Önce MFA oturum açmayı tamamlayın, sonra yeniden deneyin.",
    "submit": "Cihazı taşı",
    "submitStepUp": "Doğrula ve taşı",
    "submitting": "İşleniyor…",
    "cancel": "İptal",
    "genericError": "Cihaz taşınamadı."
  },
```
`"moveOrg": "Kuruluşa taşı"` · `"movedToOrg": "{{hostname}} {{orgName}} kuruluşuna taşındı"`

- [ ] **Step 3: Run the parity suite green**

Run: `cd apps/web && npx vitest run src/lib/i18n src/locales src/middleware.test.ts`
Expected: PASS.

- [ ] **Step 4: Validate JSON**

Run: `for l in de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR; do node -e "JSON.parse(require('fs').readFileSync('apps/web/src/locales/$l/devices.json','utf8'))" && echo "$l ok"; done`
Expected: eight `ok` lines.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales/*/devices.json
git commit -m "i18n(web): move-org dialog and action copy for all locales"
```

---

### Task 6: Docs — "Move a device to another organization"

**Files:**
- Modify: `apps/docs/src/content/docs/features/devices.mdx` — new `## Moving a Device to Another Organization` section inserted before `## Billing Coverage` (`:131`).
- Modify: `apps/docs/src/content/docs/reference/api.mdx:81` — the `POST /devices/:id/move-org` row (W01 already added the step-up sentence; this task links it to the console section).

**Interfaces:** none.

- [ ] **Step 1: Write the section**

Insert into `apps/docs/src/content/docs/features/devices.mdx` immediately before `## Billing Coverage`:

```mdx
## Moving a Device to Another Organization

A partner technician can relocate a device -- with its history, tickets, custom-field values and policy assignments -- to a different organization of the same partner. Open the device page, choose **Move to Organization** from the **…** menu, pick the target organization and one of its sites, and confirm.

### What moving requires

<Steps>
1. **Partner or system scope, with `devices:write` and `organizations:write`.** Organization-scoped users do not see the action; the API refuses them.

2. **A signed-in technician.** API keys, MCP tools and other machine principals cannot move devices. The route requires an interactive user session whether or not two-factor authentication is enabled for the deployment.

3. **A fresh second factor.** An assured session is not enough on its own -- the technician re-verifies with an authenticator app code or a passkey at the moment of the move. A technician whose only second factor is SMS must add an authenticator app or a passkey first. The verification is bound to the exact device, target organization and target site chosen, so it cannot be replayed for a different move.
</Steps>

### Unbilled work in another currency

If the device's tickets carry unbilled time or parts in a currency other than the target organization's, the move is refused with an explanation. A technician who also holds `invoices:write` may accept the mismatch, in which case those rows keep their original currency after the move; anyone else is asked to have the open work billed or cleared first.

### What happens after the move

The agent is disconnected and reconnects under the new organization within its normal heartbeat interval. The device page refreshes to the new organization and site. Two audit events are written, one in each organization's trail (`device.move_org.source` and `device.move_org.target`).

<Aside type="note">
Moving is refused while durable PAM lifecycle evidence exists for the device, and while any of its tickets is pinned to a service deliverable. Both refusals leave the device untouched.
</Aside>

---
```

- [ ] **Step 2: Cross-link from the API reference**

In `apps/docs/src/content/docs/reference/api.mdx:81`, append to the move-org row's description: ` See [Moving a Device to Another Organization](/features/devices/#moving-a-device-to-another-organization).`

- [ ] **Step 3: Build the docs**

Run: `cd apps/docs && npx astro check && npx astro build 2>&1 | tail -5`
Expected: no errors; the build lists the devices page.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/src/content/docs/features/devices.mdx apps/docs/src/content/docs/reference/api.mdx
git commit -m "docs(devices): moving a device to another organization (console + step-up)"
```

---

## Self-review

**Spec coverage (D5):** entry in Actions menu gated on scope+permissions → Task 4; target org/site pickers → Task 3; currency-mismatch checkbox gated on `invoices:write` and only after the 409 → Task 3; two-phase flow, factor discovery, `noUsableFactor`, `MFA_REQUIRED` copy, cancel-during-step-up → Task 3; single canonical resource → Tasks 1+3; typed service with `status`/`code` and one error shape → Task 2; toast + refetch on success, tolerant of agent reconnect → Task 4; i18n all locales → Task 5; docs section → Task 6. Web rows of the spec tests table: `MoveDeviceOrgDialog.test.tsx` (14 cases), `moveOrgResource.test.ts`, `deviceActions` error mapping, locale parity — all present.

**Placeholder scan:** none.

**Type consistency:** `canonicalMoveOrgResource` / `moveOrgRequestBody` (Task 1) used verbatim in Task 3; `moveDeviceOrg(deviceId, body)` and `DeviceActionError(message, status, code, details)` (Task 2) match the dialog's `catch` reads; `onCompleted({ targetOrgId, targetOrgName })` (Task 3) matches the page mount (Task 4); `useCanMoveDeviceOrg` (Task 4) mocked at `@/lib/moveOrgCapability` in `DeviceActions.test.tsx` — the component imports it through the same alias.

**Known dependency:** Task 3's tests and the dialog assume W01's server contract (`device_move_org`, `stepUpGrant`, `STEP_UP_REQUIRED`). If W01 renamed anything, update the Global Constraints first and re-derive Tasks 1–3 from them.
