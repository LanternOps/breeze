# OneDrive Helper — Phase 3 (Web UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the OneDrive Helper its UI: a config-policy **feature tab** (base toggles + library list + Graph picker), a **per-device OneDrive status panel**, and an **org-level rollup page** — plus the two read-only API endpoints the panels need.

**Architecture:** The policy editor becomes a normal feature tab (DECISION 2026-07-09: remove `onedrive_helper` from `EDITOR_EXCLUDED_FEATURE_TYPES`; the compile-enforced registries force every registration in one change). The tab uses `useFeatureLink` + `FeatureTabShell` (the `EventLogTab` pattern). Device panel follows `DeviceVulnerabilitiesTab` (fetch/loading/error/testids); rollup follows `VulnerabilityFleetPage` (Astro island + `SecurityStatCard` tiles + `ResponsiveTable`). New reads mount on the existing `onedriveRoutes` group.

**Tech Stack:** Astro + React islands, Tailwind, Vitest + jsdom (+ jest-dom), Hono + Drizzle (two read endpoints), no new tables/migrations.

## Global Constraints

- **Node:** prefix node/pnpm/vitest commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- **Branch base:** `feat/onedrive-helper-phase3` (stacked on Phase 2 — the write path, picker route `GET /onedrive/libraries` returning `{libraries:[{siteId,siteName,siteUrl,driveId,listId,libraryName,tenantId,webId,spSiteId,autoMountValue}],skippedSites}`, and `onedrive_device_state` ingest all exist).
- **Org-scoped-only stands:** `onedrive_helper` stays in `ORG_SCOPED_ONLY_FEATURE_TYPES`. The tab needs NO ownerScope selector; partner-wide gating comes free from `ConfigPolicyDetailPage`'s existing `isGatedFeature` logic.
- **Wire shapes (fixed, do not invent):** feature-link inlineSettings = the `onedriveHelperInlineSettingsSchema` shape `{silentAccountConfig,filesOnDemand,kfmSilentOptIn,kfmFolders,kfmBlockOptOut,tenantAssociationId,restartOnChange,libraries:[{libraryId,displayName,siteUrl?,siteId?,webId?,listId?,targetingMode,groupId?,groupName?,hiveScope,enabled}]}`. Device state row = `{deviceId,orgId,signedIn,oneDriveVersion,filesOnDemandOn,kfmFolderStates,mountedLibraries,entitledLibraries,driftEntries,lastReportedAt,updatedAt}`.
- **M365 connection check** for the picker empty state: `GET /m365/connection?orgId=` → `{connected:boolean,...}` (matches the table the picker 409s on). NOT the c2c connections list.
- **Mutation conventions:** feature-link saves go through `useFeatureLink` (self-managed error state rendered by `FeatureTabShell` — no toast). Any other mutation uses `runAction`. New handlers must not trip `no-silent-mutations.test.ts`.
- **URL state:** hash-based tabs only (`window.location.hash`), never query params.
- **Tests:** jsdom; scope `ResponsiveTable` queries to `data-testid="responsive-table-desktop"` (both surfaces render simultaneously); mock `useFeatureLink` for tab tests (EventLogTab.test.tsx idiom) and api-client modules for panel tests (DeviceVulnerabilitiesTab.test.tsx idiom); `data-testid`-based queries (E2E convention).
- **No migrations, no schema changes, no partner-wide work, no unmount actions** (Sub-project B).

---

## File Structure

**Create:**
- `apps/web/src/lib/api/onedrive.ts` — typed client: `fetchOneDriveLibraries`, `fetchM365ConnectionStatus`, `fetchDeviceOneDriveState`, `fetchOneDriveFleetState`
- `apps/web/src/components/configurationPolicies/featureTabs/OneDriveHelperTab.tsx` — the feature tab
- `apps/web/src/components/configurationPolicies/featureTabs/OneDriveLibraryPicker.tsx` — picker modal (Graph browse + manual paste)
- `apps/web/src/components/configurationPolicies/featureTabs/OneDriveHelperTab.test.tsx`
- `apps/web/src/components/devices/DeviceOneDriveTab.tsx` — per-device status panel
- `apps/web/src/components/devices/DeviceOneDriveTab.test.tsx`
- `apps/web/src/components/onedrive/OneDriveFleetPage.tsx` — org rollup island
- `apps/web/src/components/onedrive/OneDriveFleetPage.test.tsx`
- `apps/web/src/pages/onedrive.astro` — rollup page
- `apps/api/src/routes/onedrive.state.test.ts` — new-endpoint route tests

**Modify:**
- `apps/api/src/routes/onedrive.ts` — add `GET /devices/:deviceId/state` and `GET /state`
- `apps/web/src/components/configurationPolicies/featureTabs/types.ts` — remove exclusion; add `FEATURE_META.onedrive_helper`
- `apps/web/src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts` — exclusion list now empty
- `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` — icon entry + `renderFeatureTab` case
- `apps/web/src/components/devices/DeviceDetails.tsx` — new tab registration
- Sidebar/nav registration for `/onedrive` (find where `/vulnerabilities` is registered in the dashboard nav and mirror it)

---

## Task 1: Read endpoints — device state + org rollup

**Files:**
- Modify: `apps/api/src/routes/onedrive.ts`
- Test: `apps/api/src/routes/onedrive.state.test.ts`

**Interfaces:**
- Produces: `GET /onedrive/devices/:deviceId/state` → 200 `{state: <row|null>}` (404 if device not visible); `GET /onedrive/state?orgId=` → 200 `{devices:[{deviceId,hostname,signedIn,filesOnDemandOn,oneDriveVersion,kfmFolderStates,mountedLibraries,entitledLibraries,driftEntries,lastReportedAt}],stats:{total,signedIn,kfmProtected,withDrift}}`. Same auth chain as `/libraries` (`requireScope` + `requirePermission(DEVICES_READ)`, `resolveScopedOrgId`).

- [ ] **Step 1: Write the failing route tests**

Copy the harness from the existing `apps/api/src/routes/onedrive.test.ts` (same mocking approach for auth middleware; mock the db module the way sibling route tests in that directory do — read one first). Required cases:

```typescript
// apps/api/src/routes/onedrive.state.test.ts — shape only; adopt the sibling harness verbatim
describe('GET /onedrive/devices/:deviceId/state', () => {
  it('returns the state row for an accessible device', async () => { /* mock device lookup (org A) + state row; expect 200 {state:{signedIn:true,...}} */ });
  it('returns state:null when the agent has not reported yet', async () => { /* device exists, no row → 200 {state:null} */ });
  it('404s for a device in an inaccessible org', async () => { /* device.orgId = org B, canAccessOrg false → 404, no state query */ });
});
describe('GET /onedrive/state', () => {
  it('returns per-device rows + stats for the org', async () => {
    /* two devices: one signedIn w/ drift, one not signed in →
       stats {total:2, signedIn:1, withDrift:1}; kfmProtected counts devices whose
       kfmFolderStates values are ALL 'redirected' (non-empty) */
  });
  it('400s when no org resolvable', async () => { /* cross-tenant orgId → 400 */ });
});
```

- [ ] **Step 2: Run to confirm they fail** — `PATH=... pnpm --filter @breeze/api exec vitest run src/routes/onedrive.state.test.ts` → FAIL (routes don't exist).

- [ ] **Step 3: Implement** (append to `apps/api/src/routes/onedrive.ts`; reuse its existing imports/auth chain):

```typescript
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { devices } from '../db/schema/devices';
import { onedriveDeviceState } from '../db/schema/onedriveHelper';

// Per-device OneDrive state for the device detail panel.
onedriveRoutes.get(
  '/devices/:deviceId/state',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('deviceId');
    const [device] = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices).where(eq(devices.id, deviceId)).limit(1);
    if (!device || !resolveScopedOrgId(auth, device.orgId)) {
      return c.json({ error: 'Device not found' }, 404);
    }
    const [state] = await db
      .select().from(onedriveDeviceState)
      .where(eq(onedriveDeviceState.deviceId, deviceId)).limit(1);
    return c.json({ state: state ?? null });
  }
);

// Org rollup: entitled-vs-mounted / drift / KFM across the fleet.
onedriveRoutes.get(
  '/state',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const rows = await db
      .select({
        deviceId: onedriveDeviceState.deviceId,
        hostname: devices.hostname,
        signedIn: onedriveDeviceState.signedIn,
        filesOnDemandOn: onedriveDeviceState.filesOnDemandOn,
        oneDriveVersion: onedriveDeviceState.oneDriveVersion,
        kfmFolderStates: onedriveDeviceState.kfmFolderStates,
        mountedLibraries: onedriveDeviceState.mountedLibraries,
        entitledLibraries: onedriveDeviceState.entitledLibraries,
        driftEntries: onedriveDeviceState.driftEntries,
        lastReportedAt: onedriveDeviceState.lastReportedAt,
      })
      .from(onedriveDeviceState)
      .innerJoin(devices, eq(onedriveDeviceState.deviceId, devices.id))
      .where(eq(onedriveDeviceState.orgId, orgId));

    const kfmProtected = (kfm: unknown) => {
      const entries = Object.values((kfm ?? {}) as Record<string, string>);
      return entries.length > 0 && entries.every((v) => v === 'redirected');
    };
    const stats = {
      total: rows.length,
      signedIn: rows.filter((r) => r.signedIn).length,
      kfmProtected: rows.filter((r) => kfmProtected(r.kfmFolderStates)).length,
      withDrift: rows.filter((r) => Array.isArray(r.driftEntries) && (r.driftEntries as unknown[]).length > 0).length,
    };
    return c.json({ devices: rows, stats });
  }
);
```

> `resolveScopedOrgId(auth, device.orgId)` doubles as the access check on the device route (returns null for an org the caller can't access). Adapt exact db-mocking to whatever the sibling tests do — the route contract above is binding.

- [ ] **Step 4: Run tests green + typecheck** — the Step-2 command (PASS) + `pnpm --filter @breeze/api exec tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(onedrive-helper): device-state + fleet-state read endpoints`

---

## Task 2: Web API client — `apps/web/src/lib/api/onedrive.ts`

**Interfaces:**
- Produces (consumed by Tasks 3–6):

```typescript
export type OneDriveLibrary = { siteId: string; siteName: string; siteUrl: string; driveId: string; listId: string; libraryName: string; tenantId: string; webId: string; spSiteId: string; autoMountValue: string };
export type OneDriveDeviceState = { deviceId: string; signedIn: boolean; oneDriveVersion: string | null; filesOnDemandOn: boolean; kfmFolderStates: Record<string, string>; mountedLibraries: string[]; entitledLibraries: string[]; driftEntries: Array<{ libraryId: string; displayName: string; reason: string }>; lastReportedAt: string };
export type OneDriveFleetRow = OneDriveDeviceState & { hostname: string };
export type OneDriveFleetStats = { total: number; signedIn: number; kfmProtected: number; withDrift: number };

export async function fetchM365ConnectionStatus(orgId?: string): Promise<boolean>;            // GET /m365/connection[?orgId] → data.connected === true
export async function fetchOneDriveLibraries(orgId?: string): Promise<{ libraries: OneDriveLibrary[]; skippedSites: Array<{siteId:string;code:string}> }>; // GET /onedrive/libraries — throw with the response error message on !ok (409 → "connect M365" message)
export async function fetchDeviceOneDriveState(deviceId: string): Promise<OneDriveDeviceState | null>;  // GET /onedrive/devices/:id/state → data.state
export async function fetchOneDriveFleetState(orgId?: string): Promise<{ devices: OneDriveFleetRow[]; stats: OneDriveFleetStats }>; // GET /onedrive/state
```

All read-only via `fetchWithAuth` (from `../../stores/auth`) + `friendlyFetchError`-style error surfacing — copy the exact fetch/error idiom from `apps/web/src/lib/api/vulnerabilities.ts` reads. No `runAction` (no mutations here). Include a small vitest (`onedrive.test.ts` alongside) asserting URL construction (incl. `orgId` query passthrough) and the `state:null` passthrough, using the `fetchWithAuth` mock idiom.

Steps: failing test → implement → green → commit `feat(onedrive-helper): web api client for onedrive endpoints`.

---

## Task 3: Policy-editor feature tab — registration + `OneDriveHelperTab`

The compile-enforced un-exclusion. **All registries change in one task** (the `Exclude<>` type forces it).

**Files:**
- Modify: `featureTabs/types.ts` — `EDITOR_EXCLUDED_FEATURE_TYPES = [] as const` (keep the const + comment explaining it's now empty and why it exists); add `FEATURE_META.onedrive_helper = { label: 'OneDrive Helper', fetchUrl: null, description: 'Silently sign in OneDrive, enforce Files On-Demand and Known Folder Move, and auto-mount SharePoint libraries per user.' }`
- Modify: `featureTypeParity.test.ts` — update the exclusion assertion (now empty)
- Modify: `ConfigPolicyDetailPage.tsx` — `featureTabIcons.onedrive_helper` (use the `Cloud` icon, matching `DeviceEffectiveConfigTab`), `renderFeatureTab` case returning `<OneDriveHelperTab {...featureTabProps} />`
- Create: `OneDriveHelperTab.tsx` + `OneDriveHelperTab.test.tsx`

**Interfaces:**
- Consumes: `FeatureTabProps`, `useFeatureLink`, `FeatureTabShell` (exact contracts quoted in the research brief), `onedriveHelperInlineSettingsSchema` shape.
- Produces: a tab that (a) renders base toggles — Silent sign-in, Files On-Demand, KFM opt-in (+ folder checkboxes Desktop/Documents/Pictures + Block opt-out + tenant-association text input, all only when KFM on), Restart on change; (b) renders the libraries list (display name, site URL, targeting mode select `everyone|graph_group|local_ad_group`, group id/name inputs shown per mode, enabled toggle, remove button, `data-testid="onedrive-lib-row-<idx>"`); (c) "Add library" opens `OneDriveLibraryPicker` (Task 4 — in THIS task render a manual-entry inline form: paste `libraryId` composite + display name; the picker replaces/augments it in Task 4); (d) saves via `useFeatureLink.save(existingLink?.id ?? null, { featureType: 'onedrive_helper', featurePolicyId: null, inlineSettings: toPayload(state) })` with an EventLogTab-style `toPayload` allowlist; (e) inherited/override/revert semantics identical to EventLogTab.

**Required tests** (mock `useFeatureLink` per the EventLogTab.test.tsx idiom):
1. renders defaults when no link exists; 2. seeds state from `existingLink.inlineSettings`; 3. Save posts the full allowlisted payload (assert `saveMock.mock.calls[0]` deep shape incl. libraries array); 4. adding a manual library then saving includes it with `targetingMode` default `everyone`; 5. `graph_group` mode without group id/name disables Save (client-side mirror of the zod superRefine — show inline hint); 6. inherited (parentLink only) shows Override affordance and no direct Save.

Steps: failing tests → registration edits (typecheck will drive completeness — run `pnpm --filter @breeze/web exec tsc --noEmit` or the repo's web typecheck and fix every forced site) → component → green (whole featureTabs test dir + parity test) → commit `feat(onedrive-helper): config-policy editor feature tab`.

---

## Task 4: Graph library picker — `OneDriveLibraryPicker.tsx`

**Interfaces:**
- Consumes: `fetchOneDriveLibraries`, `fetchM365ConnectionStatus` (Task 2). Props: `{ orgId?: string; onAdd: (lib: { libraryId: string; displayName: string; siteUrl: string; siteId: string; webId: string; listId: string }) => void; onClose: () => void }` — `libraryId` = `autoMountValue`; `siteId` = `spSiteId` (bare GUID, the DB column meaning).
- Produces: a modal/panel with three states: (1) **no M365 connection** → explainer + link to the M365 connection settings surface + "paste a library ID instead" manual fallback (composite text input + display name — validate it starts with `tenantId=`); (2) **connected** → grouped-by-site list of libraries with search filter, each row an "Add" button (`data-testid="onedrive-picker-add-<driveId>"`), rows with empty `autoMountValue` disabled with a hint; `skippedSites.length > 0` renders a warning line "N sites could not be read"; (3) loading/error states.
- The tab (Task 3) swaps its inline manual form for this picker; manual paste stays available inside the picker.

**Required tests:** connection-false → manual fallback visible, no libraries fetch; connected → libraries listed grouped by `siteName`, Add invokes `onAdd` with `libraryId === autoMountValue` and `siteId === spSiteId`; disabled row when `autoMountValue` empty; skippedSites warning renders.

Steps: failing tests → implement → green → integrate into `OneDriveHelperTab` (replace the Task-3 inline form; keep its tests passing by updating them to open the picker) → whole featureTabs dir green → commit `feat(onedrive-helper): Graph library picker with manual-paste fallback`.

---

## Task 5: Per-device OneDrive panel — `DeviceOneDriveTab`

**Files:**
- Modify: `DeviceDetails.tsx` — `Tab` union + `VALID_TABS` + `tabs[]` entry `{ id: 'onedrive', label: 'OneDrive', icon: Cloud }` + conditional render `{activeTab === 'onedrive' && <DeviceOneDriveTab deviceId={device.id} />}`
- Create: `DeviceOneDriveTab.tsx` + test

**Interfaces:**
- Consumes: `fetchDeviceOneDriveState` (Task 2).
- Produces: panel with (a) status header chips — Signed in / Files On-Demand / OneDrive version / last reported (relative time, existing util if present); (b) KFM grid: the three folders with `redirected`/`not_redirected`/`unknown` states as colored badges; (c) Libraries section: entitled list (parse `displayName` is NOT in entitled — it's raw composites; show a shortened composite with the `webUrl=` segment decoded as the human label) vs mounted paths, and a **Drift** list from `driftEntries` (amber warning rows, `data-testid="onedrive-drift-<idx>"`); (d) `state === null` → empty state "No OneDrive state reported yet — the agent reports on its next heartbeat after a policy applies" (`data-testid="device-onedrive-empty"`); (e) loading + error states (`data-testid="device-onedrive-error"`), fetch pattern copied from `DeviceVulnerabilitiesTab` (`useCallback` load + `useEffect`).

**Required tests** (mock the api module): loading→data render (chips + KFM badges + drift rows); null state → empty message; error → error testid; a device with drift shows the amber row with reason text.

Steps: failing tests → implement + register → green (+ any existing DeviceDetails test still passing) → commit `feat(onedrive-helper): per-device OneDrive status panel`.

---

## Task 6: Org rollup — `onedrive.astro` + `OneDriveFleetPage`

**Files:**
- Create: `apps/web/src/pages/onedrive.astro` (copy `vulnerabilities.astro` shape: `DashboardLayout` + `<OneDriveFleetPage client:load />`, title "OneDrive", intro line "Fleet OneDrive posture — sign-in, Known Folder Move protection, and library mount drift.")
- Create: `OneDriveFleetPage.tsx` + test
- Modify: the dashboard sidebar/nav — find where the `/vulnerabilities` nav item is registered (grep the layout/nav component) and add an equivalent `/onedrive` entry with the `Cloud` icon, adjacent to it.

**Interfaces:**
- Consumes: `fetchOneDriveFleetState` (Task 2).
- Produces: (a) four `SecurityStatCard` tiles — Devices reporting (`total`), Signed in (`signedIn`, variant success), KFM protected (`kfmProtected`, warning when `< signedIn`), Drift (`withDrift`, danger when `> 0`) — clickable tiles filter the table (all/signed-in/kfm-gap/drift), mirroring `VulnerabilityFleetPage`'s interactive-tile pattern; (b) `ResponsiveTable` of devices: hostname (link to `/devices#...`? use however device links are built elsewhere — copy an existing hostname-link cell), signed-in badge, FOD, KFM summary (`3/3 redirected` style), mounted/entitled counts, drift count (amber when >0), last reported; mobile `DataCard` variant with `CardField`s; (c) org selector: none — rely on the caller's scope (partner users see their scoped org resolution; pass no orgId and let `resolveScopedOrgId` fall back, matching how other fleet pages handle it — check `VulnerabilityFleetPage` and copy exactly); (d) loading/error/empty (`data-testid="onedrive-fleet-empty"` when `total === 0` with a pointer to enabling the policy feature).

**Required tests:** stats tiles render from mocked fleet response; tile click filters rows (scope queries to `responsive-table-desktop`); drift row shows amber count; empty state.

Steps: failing tests → implement island + astro page + nav entry → green → commit `feat(onedrive-helper): org OneDrive rollup page`.

---

## Task 7: Live verification on the wt-stack (browser)

No new code. Rebuild and drive the real UI against the still-enrolled VM device:

- [ ] `PATH=... pnpm wt-stack up --rebuild` (web + api containers pick up the branch)
- [ ] Playwright MCP / browser at `baseUrl` from `.breeze-stack.json` (admin creds there): log in →
  - Config policy "OneDrive E2E" → OneDrive Helper tab shows the Phase-2-created settings (base toggles + 1 library); toggle something, Save, confirm PATCH succeeds and normalized rows update (psql check)
  - Library picker opens; with no M365 connection on the stack org it must show the connect-first + manual-paste state (the 409 path)
  - Device `WIN-DHQNR1F8LO2` → OneDrive tab shows live state (signed in, FOD, 3× KFM redirected, mounted + entitled, no drift)
  - `/onedrive` page → tiles `total=1, signedIn=1, kfmProtected=1, withDrift=0`; table row links to the device
- [ ] Log results in `docs/testing/FEATURE_TEST_LOG.md` (local-only, do not commit)

---

## Self-Review (completed during authoring)

**Spec §5 coverage:** policy editor (base toggles, library list, picker-or-paste, per-library targeting) → Tasks 3–4. Per-device panel (signed-in/FOD/KFM/mounted-vs-entitled/drift) → Task 5. Org rollup (entitled-vs-mounted, drift, "KFM not protected") → Task 6 (KFM-gap tile). Missing read APIs discovered during planning → Task 1. Picker's M365-absent degradation (spike doc's assisted-paste fallback) → Task 4 state 1.

**Placeholder scan:** Tasks 3–6 specify contracts + named template files with exact idioms (quoted at length in the research handed to each implementer) rather than full JSX — deliberate for UI components where the repo's live templates (EventLogTab, DeviceVulnerabilitiesTab, VulnerabilityFleetPage) are stronger sources of truth than transcribed code; every payload shape, endpoint, state, testid, and test case is pinned. Task 1 carries full route code.

**Type consistency:** `OneDriveLibrary.autoMountValue → onAdd.libraryId`, `spSiteId → siteId` column mapping stated in both Task 2 and Task 4; inlineSettings payload shape identical in Global Constraints and Task 3; fleet stats keys identical in Task 1 response and Task 6 tiles.
