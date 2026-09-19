---
tracking_issue: LanternOps/breeze#5988
---
# Network Device Page Truth W04: Web Settings Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the network device page sole ownership of the discovered asset. One `NetworkAssetSettingsModal` (Identity · Monitoring · Link · Danger, each section saved independently), one web module that writes every asset-scoped endpoint, a contract test that keeps it the only writer, a `#<tab>/settings/<section>` hash grammar, and launchers from Discovery and `/monitoring/network`. `EditMonitoringModal`, `EnableMonitoringForm` and `AssetMonitoringSection` are deleted; `AssetDetailModal` becomes a read-only peek.

**Architecture:** A new `apps/web/src/components/devices/networkDevice/settings/` folder holds the modal shell, a section shell, four section components, the SNMP form, the grouped type table, the hash parser and the single mutation hook. `NetworkDeviceDetailPage` gains a second `useHashState` for the settings section and drops its inline type editor and unlink flow. `DiscoveredAssetList` and `MonitoringAssetsDashboard` keep their own tables but call the mutation hook for every write and navigate to the device page for configuration. A guard test walks `apps/web/src` with the TypeScript compiler API and fails on any `fetchWithAuth` mutation against the asset-scoped endpoints outside the hook.

**Tech Stack:** Astro + React 19 islands, react-i18next, Tailwind, Vitest + jsdom + Testing Library (`data-testid` selectors), TypeScript compiler API for the contract test.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` (approved 2026-09-16). This wave ships §10 in full, §14 (modal error handling), §15's web bullet, and the §16 note that W03's `templateSuggestion` is feature-detected. §11 (page IA) is W05 and is deliberately NOT in this wave: the page keeps its current cards and only loses the controls that move into the modal.

**Cross-wave names (from the plan index — do not rename):**
`networkDevice/settings/NetworkAssetSettingsModal.tsx` (`open`, `section`, `assetId`, `onClose`, `onSaved`), `settings/useNetworkAssetMutations.ts`, `settings/settingsHash.ts` (`parseDetailHash`, `buildDetailHash`, `SettingsSection = 'identity' | 'monitoring' | 'link' | 'danger'`), `apps/web/src/lib/__tests__/network-asset-single-writer.test.ts`.

---

## Global Constraints

- **Every mutation goes through `runAction`** (`apps/web/src/lib/runAction.ts`). No `fetchWithAuth` with a mutating method may exist outside `useNetworkAssetMutations.ts` for the guarded endpoints. Caller catch pattern is always:
  ```ts
  if (err instanceof ActionError && err.status === 401) return; // auth redirect owns it
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
  ```
  or the `handleActionError(err, fallback)` helper that encodes it.
- **Single writer.** `useNetworkAssetMutations.ts` is the only module in `apps/web/src` that mutates `/discovery/assets/:id`, `/discovery/assets/:id/{approve,dismiss,link}`, `/monitoring/assets/:id` and `/monitoring/assets/:id/snmp`. Enforced by `apps/web/src/lib/__tests__/network-asset-single-writer.test.ts`.
- **Hash grammar** `#<tab>[/settings/<section>]`, parsed only by `settings/settingsHash.ts`. URL state is the hash — never a query param (CLAUDE.md "URL State in Components"). Tab-only hashes keep working; closing the modal rewrites the hash to `#<tab>`.
- **i18n:** every new key lands in all 8 locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) with a **real translation**, not an English copy — `apps/web/src/lib/i18n/localeParity.test.ts` fails on a missing key and `translationCoverage.test.ts` caps exact-English duplicates per namespace. Deleting a key means deleting it from all 8.
- **Copy rule (spec §10):** no bare "Online". Every status string reads `<state> · <source> <relative time>`.
- **Credentials are never echoed into an input.** `GET /monitoring/assets/:id` returns `community`/`authPassword`/`privPassword` already masked (`serializeSnmpDevice`, `monitoring.ts:114`). Inputs start blank; a blank field means "keep the stored secret" (`PUT`/`PATCH` only overwrite fields that are present).
- **Run one test file:** `cd apps/web && npx vitest run <path>`. Never `pnpm --filter @breeze/web test -- --run <path>` (the `--` is forwarded into argv and vitest runs the whole suite in watch mode).
- **Typecheck:** `cd apps/web && pnpm exec astro check` (this is exactly what CI's `typecheck` job runs; `apps/web` has no `typecheck` script).
- **File size:** one component per file under `networkDevice/settings/`, each under ~500 lines (CLAUDE.md soft guideline). The SNMP field block is its own file so `MonitoringSection.tsx` stays readable.
- **Imports** in new files use the `@/` alias (`@/lib/runAction`, `@/stores/auth`) — already used in this folder (`@/lib/useHashState` in `NetworkDeviceDetailPage.tsx:7`) and shorter than the four-level relative path.
- **No API, agent or migration changes in this wave.** W04 consumes W01's `reachability` and the `no_template` collection status and feature-detects W03's `templateSuggestion`; nothing here blocks on either.
- **Branch / PR / commits:** branch `feature/<parent#>-network-device-page-truth/wave-<W04 sub-issue#>`; PR body contains `Closes #<W04 sub-issue#>`. Because this branch may be stacked, dispatch CI per branch before enqueueing: `gh workflow run CI --ref <branch>`. Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File structure

| Path | Change | Responsibility |
|---|---|---|
| `apps/web/src/components/devices/networkDevice/settings/settingsHash.ts` | create | `parseDetailHash` / `buildDetailHash`, `SettingsSection`, `SETTINGS_SECTIONS` |
| `.../settings/settingsHash.test.ts` | create | table-driven grammar tests |
| `.../settings/useNetworkAssetMutations.ts` | create | the only writer: `patchIdentity`, `approve`, `dismiss`, `deleteAsset`, `link`, `unlink`, `putSnmp`, `patchSnmp`, `disableMonitoring`, `createCheck`, `deleteCheck` |
| `.../settings/useNetworkAssetMutations.test.ts` | create | URL/method/body + runAction failure behaviour per function |
| `.../settings/NetworkAssetSettingsModal.tsx` | create | Dialog shell, section rail, per-section routing |
| `.../settings/NetworkAssetSettingsModal.test.tsx` | create | open/close via hash, rail navigation, focus/close semantics |
| `.../settings/SettingsSectionShell.tsx` | create | heading + description + Save/Cancel footer + pending state |
| `.../settings/IdentitySection.tsx` | create | name, grouped type select + consequence copy + reset, tags, notes |
| `.../settings/IdentitySection.test.tsx` | create | per-field save/cancel, reset-to-detected, 409 reload |
| `.../settings/assetTypeGroups.ts` | create | grouped type table + the 12 types `PATCH /discovery/assets/:id` accepts |
| `.../settings/assetTypeGroups.test.ts` | create | groups cover exactly the API-accepted enum |
| `.../settings/MonitoringSection.tsx` | create | SNMP config save, pause/resume, disable, network-check list/add/remove |
| `.../settings/MonitoringSection.test.tsx` | create | PUT vs PATCH, blank-keeps-secret, suggestion feature detection, checks |
| `.../settings/SnmpConfigForm.tsx` | create | the SNMP field block (version / credentials / port / interval / template) |
| `.../settings/LinkSection.tsx` | create | link provenance, Unlink (confirm), Link manually, suppressed line |
| `.../settings/LinkSection.test.tsx` | create | unlink confirm + DELETE, manual link, suppressed copy |
| `.../settings/DangerSection.tsx` | create | Approve / Dismiss / Delete (typed confirm) |
| `.../settings/DangerSection.test.tsx` | create | approve/dismiss visibility, typed-confirm gate, delete navigates away |
| `apps/web/src/lib/__tests__/network-asset-single-writer.test.ts` | create | contract test: one writer for the asset-scoped endpoints |
| `apps/web/src/components/devices/networkDevice/NetworkDeviceHeader.tsx` | modify | add **Settings** button, remove "Manage in Discovery" |
| `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` | modify | settings hash state, mount the modal, drop inline type editor + unlink flow |
| `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx` | modify | migrate type-editor/unlink cases to the section suites; add Settings-button + hash cases |
| `apps/web/src/components/devices/networkDevice/LinkManuallyControl.tsx` | modify | route its POST through `useNetworkAssetMutations().link` |
| `apps/web/src/components/discovery/AssetDetailModal.tsx` | modify | reduce to a read-only peek + "Open device page" / "Settings…" |
| `apps/web/src/components/discovery/AssetDetailModal.test.tsx` | modify | replace the form/type/delete cases with peek cases |
| `apps/web/src/components/discovery/DiscoveredAssetList.tsx` | modify | row "Settings…" action; approve/dismiss through the hook |
| `apps/web/src/components/discovery/DiscoveredAssetList.test.tsx` | modify | add row-action + hook-routing cases |
| `apps/web/src/components/discovery/AssetMonitoringSection.tsx` | **delete** | replaced by the modal's Monitoring section |
| `apps/web/src/components/discovery/EnableMonitoringForm.tsx` | **delete** | replaced by the modal's Monitoring section |
| `apps/web/src/components/monitoring/MonitoringAssetsDashboard.tsx` | modify | delete `EditMonitoringModal`; add Settings… row action, reachability + collection columns; writes through the hook |
| `apps/web/src/components/monitoring/MonitoringAssetsDashboard.test.tsx` | create | columns, row actions, hook routing |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | modify | add the writer to `TARGET_GLOBS`, bump the count 133 → 134 |
| `apps/web/src/locales/{8}/devices.json` | modify | `networkDeviceDetailPage.settings.*`, header Settings label |
| `apps/web/src/locales/{8}/discovery.json` | modify | `assetDetailModal.peek.*`, `discoveredAssetList.actions.settings`; delete `assetMonitoringSection.*` and `enableMonitoringForm.*` |
| `apps/web/src/locales/{8}/common.json` | modify | `longTail.monitoring.MonitoringAssetsDashboard.{table.reachability,table.collection,collectionState.*,openSettings}` |

---

### Task 1: Hash grammar — `settingsHash.ts`

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/settings/settingsHash.ts`
- Create: `apps/web/src/components/devices/networkDevice/settings/settingsHash.test.ts`

**Interfaces:**
```ts
export const SETTINGS_SECTIONS: readonly ['identity', 'monitoring', 'link', 'danger'];
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export const DEFAULT_SETTINGS_SECTION: SettingsSection; // 'identity'
export type DetailHash = { tab: Tab; settings: SettingsSection | null };
export function parseDetailHash(hash: string): DetailHash;
export function buildDetailHash(tab: Tab, section?: SettingsSection | null): string; // no leading '#'
```

Decisions taken here (spec leaves them open):
- `buildDetailHash` returns the hash **without** a leading `#`, because the page already assigns `window.location.hash = tab` (`NetworkDeviceDetailPage.tsx:55`) and the browser adds the `#`.
- `#<tab>/settings` with no section, or with an unknown section, opens the modal on `identity` rather than being ignored — a truncated or stale deep link should still land somewhere useful.
- An unknown tab falls back to `'overview'`, matching the existing parser at `NetworkDeviceDetailPage.tsx:49-52`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/devices/networkDevice/settings/settingsHash.test.ts
import { describe, expect, it } from 'vitest';

import { buildDetailHash, parseDetailHash, SETTINGS_SECTIONS } from './settingsHash';

describe('parseDetailHash', () => {
  it.each([
    ['', { tab: 'overview', settings: null }],
    ['#', { tab: 'overview', settings: null }],
    ['overview', { tab: 'overview', settings: null }],
    ['#monitoring', { tab: 'monitoring', settings: null }],
    ['#overview/settings/identity', { tab: 'overview', settings: 'identity' }],
    ['#overview/settings/monitoring', { tab: 'overview', settings: 'monitoring' }],
    ['#monitoring/settings/link', { tab: 'monitoring', settings: 'link' }],
    ['#overview/settings/danger', { tab: 'overview', settings: 'danger' }],
    // Truncated or stale deep links still open the modal, on Identity.
    ['#overview/settings', { tab: 'overview', settings: 'identity' }],
    ['#overview/settings/bogus', { tab: 'overview', settings: 'identity' }],
    // Unknown tab falls back to overview, exactly as the pre-W04 parser did.
    ['#bogus', { tab: 'overview', settings: null }],
    ['#bogus/settings/link', { tab: 'overview', settings: 'link' }],
    // A non-"settings" second segment is not a settings hash.
    ['#monitoring/proxy', { tab: 'monitoring', settings: null }],
  ])('parses %s', (hash, expected) => {
    expect(parseDetailHash(hash)).toEqual(expected);
  });
});

describe('buildDetailHash', () => {
  it('emits the bare tab when no section is given', () => {
    expect(buildDetailHash('overview')).toBe('overview');
    expect(buildDetailHash('monitoring', null)).toBe('monitoring');
  });

  it('emits <tab>/settings/<section> with no leading #', () => {
    expect(buildDetailHash('overview', 'monitoring')).toBe('overview/settings/monitoring');
    expect(buildDetailHash('monitoring', 'danger')).toBe('monitoring/settings/danger');
  });

  it('round-trips every section', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseDetailHash(`#${buildDetailHash('overview', section)}`)).toEqual({
        tab: 'overview',
        settings: section,
      });
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/settings/settingsHash.test.ts
```
Expected: `Failed to resolve import "./settingsHash"` — the module does not exist yet.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/components/devices/networkDevice/settings/settingsHash.ts
// The network device page's URL fragment grammar: `#<tab>[/settings/<section>]`.
// Both halves are parsed here so the page, the header button, and the two
// launcher surfaces (Discovery rows, /monitoring/network rows) can never
// disagree about what a hash means. Tab-only hashes are unchanged from before
// W04, so every pre-existing deep link keeps working.

import { VALID_TABS, type Tab } from '../types';

export const SETTINGS_SECTIONS = ['identity', 'monitoring', 'link', 'danger'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Where a truncated (`#overview/settings`) or unknown-section hash lands. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'identity';
const DEFAULT_TAB: Tab = 'overview';

export type DetailHash = { tab: Tab; settings: SettingsSection | null };

export function parseDetailHash(hash: string): DetailHash {
  const segments = hash.replace(/^#/, '').split('/');
  const rawTab = segments[0] ?? '';
  const tab = (VALID_TABS as readonly string[]).includes(rawTab) ? (rawTab as Tab) : DEFAULT_TAB;

  if (segments[1] !== 'settings') return { tab, settings: null };

  const rawSection = segments[2] ?? '';
  const settings = (SETTINGS_SECTIONS as readonly string[]).includes(rawSection)
    ? (rawSection as SettingsSection)
    : DEFAULT_SETTINGS_SECTION;
  return { tab, settings };
}

/**
 * Returns the fragment WITHOUT a leading `#` — callers assign it to
 * `window.location.hash`, which prepends one, and `useHashState`'s parser is
 * handed the already-stripped value.
 */
export function buildDetailHash(tab: Tab, section?: SettingsSection | null): string {
  return section ? `${tab}/settings/${section}` : tab;
}
```

- [ ] **Step 4: Run it green**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/settings/settingsHash.test.ts
```
Expected: 1 file, 5 tests (13 `it.each` cases + 3), all passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/networkDevice/settings/settingsHash.ts \
        apps/web/src/components/devices/networkDevice/settings/settingsHash.test.ts
git commit -m "$(cat <<'EOF'
feat(web/network-device): add the #<tab>/settings/<section> hash grammar

W04 Task 1. parseDetailHash/buildDetailHash are the single place the network
device page, its header button, and the Discovery / monitoring launchers agree
on what a fragment means. Tab-only hashes behave exactly as before.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The single writer — `useNetworkAssetMutations.ts`

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.ts`
- Create: `apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts`

**Interfaces:**
```ts
export type SnmpVersion = 'v1' | 'v2c' | 'v3';
export type SnmpAuthProtocol = 'md5' | 'sha' | 'sha256';
export type SnmpPrivProtocol = 'des' | 'aes' | 'aes256';

export type IdentityPatch = {
  label?: string | null;
  notes?: string | null;
  tags?: string[];
  assetType?: DiscoveredAssetType;
  resetTypeToAuto?: true;
};

export type SnmpUpsertInput = {
  snmpVersion: SnmpVersion;
  community?: string;
  username?: string;
  authProtocol?: SnmpAuthProtocol;
  authPassword?: string;
  privProtocol?: SnmpPrivProtocol;
  privPassword?: string;
  templateId?: string | null;
  pollingInterval?: number;
  port?: number;
};
export type SnmpPatchInput = Partial<SnmpUpsertInput> & { isActive?: boolean };

export type NetworkCheckInput = {
  name: string;
  monitorType: 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  target: string;
  config?: Record<string, unknown>;
  pollingInterval?: number;
  timeout?: number;
};

export type TemplateSuggestion = { templateId: string; templateName: string; reason: string };
export type SnmpSaveResult = {
  snmpDevice?: { id: string; templateId: string | null } | null;
  /** W03 only. Absent on a pre-W03 API — callers must treat it as optional. */
  templateSuggestion?: TemplateSuggestion | null;
};

export type NetworkAssetMutations = {
  patchIdentity(assetId: string, patch: IdentityPatch): Promise<void>;
  approve(assetId: string): Promise<void>;
  dismiss(assetId: string): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  link(assetId: string, deviceId: string): Promise<void>;
  unlink(assetId: string): Promise<void>;
  putSnmp(assetId: string, input: SnmpUpsertInput): Promise<SnmpSaveResult>;
  patchSnmp(assetId: string, patch: SnmpPatchInput): Promise<SnmpSaveResult>;
  disableMonitoring(assetId: string): Promise<void>;
  createCheck(assetId: string, input: NetworkCheckInput): Promise<void>;
  deleteCheck(monitorId: string): Promise<void>;
};

export function useNetworkAssetMutations(): NetworkAssetMutations;
```

Decisions taken here:
- It is a **hook**, not a bare module, even though every function is stateless. Two reasons: the locked filename carries the `use` prefix, and `useTranslation('devices')` inside the hook is what lets `apps/web/src/lib/i18n/keyUsage.test.ts` bind the namespace for every literal `t()` key in the file (a plain module's `t` parameter would resolve against `common` and fail that test).
- Every function takes `assetId` as an argument instead of the hook closing over one, so `DiscoveredAssetList` and `MonitoringAssetsDashboard` — which act on many assets from one render — use a single hook instance.
- `createCheck`/`deleteCheck` exist for completeness (spec §10 lists `/monitors` among the modal's writes), but `/monitors` is deliberately **outside** the contract test's enforced set: `CreateMonitorForm`, `NetworkMonitorList` and `MonitorDetailModal` legitimately own the generic monitor surface, and spec §10 itself tells the Monitoring section to reuse `CreateMonitorForm` for Add. The reason is recorded in the test file (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts
import '@/lib/i18n';

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNetworkAssetMutations } from './useNetworkAssetMutations';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const ok = (payload: unknown = { success: true }): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const fail = (payload: unknown, status = 500): Response =>
  ({ ok: false, status, statusText: 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ASSET = 'asset-1';

function mutations() {
  return renderHook(() => useNetworkAssetMutations()).result.current;
}

const lastCall = () => fetchMock.mock.calls.at(-1)!;
const lastInit = () => lastCall()[1] as RequestInit;
const lastBody = () => JSON.parse(lastInit().body as string);

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  fetchMock.mockResolvedValue(ok());
});

describe('useNetworkAssetMutations — request shapes', () => {
  it('patchIdentity PATCHes /discovery/assets/:id with only the supplied fields', async () => {
    await mutations().patchIdentity(ASSET, { label: 'Main Switch', notes: null, tags: ['core'] });

    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastBody()).toEqual({ label: 'Main Switch', notes: null, tags: ['core'] });
  });

  it('patchIdentity carries resetTypeToAuto on its own', async () => {
    await mutations().patchIdentity(ASSET, { resetTypeToAuto: true });
    expect(lastBody()).toEqual({ resetTypeToAuto: true });
  });

  it('approve and dismiss PATCH their sub-resources with no body', async () => {
    const m = mutations();
    await m.approve(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/approve`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastInit().body).toBeUndefined();

    await m.dismiss(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/dismiss`);
    expect(lastInit().method).toBe('PATCH');
  });

  it('deleteAsset DELETEs /discovery/assets/:id', async () => {
    await mutations().deleteAsset(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}`);
    expect(lastInit().method).toBe('DELETE');
  });

  it('link POSTs the deviceId and unlink DELETEs the link sub-resource', async () => {
    const m = mutations();
    await m.link(ASSET, 'dev-9');
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/link`);
    expect(lastInit().method).toBe('POST');
    expect(lastBody()).toEqual({ deviceId: 'dev-9' });

    await m.unlink(ASSET);
    expect(lastCall()[0]).toBe(`/discovery/assets/${ASSET}/link`);
    expect(lastInit().method).toBe('DELETE');
  });

  it('putSnmp PUTs the full config and returns the parsed body', async () => {
    fetchMock.mockResolvedValue(
      ok({ success: true, snmpDevice: { id: 'snmp-1', templateId: 't-1' }, templateSuggestion: null }),
    );
    const result = await mutations().putSnmp(ASSET, {
      snmpVersion: 'v2c', community: 'public', pollingInterval: 300, port: 161, templateId: 't-1',
    });

    expect(lastCall()[0]).toBe(`/monitoring/assets/${ASSET}/snmp`);
    expect(lastInit().method).toBe('PUT');
    expect(lastBody()).toEqual({
      snmpVersion: 'v2c', community: 'public', pollingInterval: 300, port: 161, templateId: 't-1',
    });
    expect(result.snmpDevice).toEqual({ id: 'snmp-1', templateId: 't-1' });
  });

  it('patchSnmp PATCHes only the supplied fields (pause/resume is isActive alone)', async () => {
    await mutations().patchSnmp(ASSET, { isActive: false });
    expect(lastCall()[0]).toBe(`/monitoring/assets/${ASSET}/snmp`);
    expect(lastInit().method).toBe('PATCH');
    expect(lastBody()).toEqual({ isActive: false });
  });

  it('disableMonitoring DELETEs /monitoring/assets/:id', async () => {
    await mutations().disableMonitoring(ASSET);
    expect(lastCall()[0]).toBe(`/monitoring/assets/${ASSET}`);
    expect(lastInit().method).toBe('DELETE');
  });

  it('createCheck POSTs /monitors with the assetId bound and deleteCheck DELETEs by monitor id', async () => {
    const m = mutations();
    await m.createCheck(ASSET, { name: 'Ping', monitorType: 'icmp_ping', target: '10.0.0.2' });
    expect(lastCall()[0]).toBe('/monitors');
    expect(lastInit().method).toBe('POST');
    expect(lastBody()).toMatchObject({ assetId: ASSET, monitorType: 'icmp_ping', target: '10.0.0.2' });

    await m.deleteCheck('mon-3');
    expect(lastCall()[0]).toBe('/monitors/mon-3');
    expect(lastInit().method).toBe('DELETE');
  });
});

describe('useNetworkAssetMutations — outcome is never silent', () => {
  it('toasts a success message on every write', async () => {
    await mutations().approve(ASSET);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('toasts and throws an ActionError carrying the server status on failure', async () => {
    fetchMock.mockResolvedValue(fail({ error: 'Asset not found' }, 404));

    await expect(mutations().deleteAsset(ASSET)).rejects.toMatchObject({
      name: 'ActionError',
      status: 404,
      message: 'Asset not found',
    });
    expect(toastMock).toHaveBeenCalledWith({ message: 'Asset not found', type: 'error' });
  });

  it('surfaces a 409 as an ActionError with status 409 so sections can reload', async () => {
    fetchMock.mockResolvedValue(fail({ error: 'Asset changed' }, 409));

    const err = await mutations().patchIdentity(ASSET, { label: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).status).toBe(409);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts
```
Expected: `Failed to resolve import "./useNetworkAssetMutations"`.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.ts
// THE single writer for a discovered network asset.
//
// Before W04 the same asset was mutated from four places with four different
// idioms (Discovery's AssetDetailModal, Discovery's EnableMonitoringForm,
// the monitoring dashboard's EditMonitoringModal, and the device page), so a
// fix to one never reached the others and two of them failed silently. Every
// asset-scoped write now lives here, wrapped in runAction so success and
// failure are always shown, and `lib/__tests__/network-asset-single-writer.test.ts`
// fails the build if a second caller appears.
//
// This is a hook rather than a plain module for two reasons: the cross-wave
// name is fixed, and `useTranslation('devices')` in this scope is what lets
// the i18n key-usage guard bind the namespace for the literal keys below.

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import type { DiscoveredAssetType } from '@/components/discovery/DiscoveredAssetList';

export type SnmpVersion = 'v1' | 'v2c' | 'v3';
export type SnmpAuthProtocol = 'md5' | 'sha' | 'sha256';
export type SnmpPrivProtocol = 'des' | 'aes' | 'aes256';

export type IdentityPatch = {
  label?: string | null;
  notes?: string | null;
  tags?: string[];
  assetType?: DiscoveredAssetType;
  /** Mutually exclusive with `assetType` (routes/discovery.ts updateAssetSchema refine). */
  resetTypeToAuto?: true;
};

export type SnmpUpsertInput = {
  snmpVersion: SnmpVersion;
  community?: string;
  username?: string;
  authProtocol?: SnmpAuthProtocol;
  authPassword?: string;
  privProtocol?: SnmpPrivProtocol;
  privPassword?: string;
  templateId?: string | null;
  pollingInterval?: number;
  port?: number;
};

export type SnmpPatchInput = Partial<SnmpUpsertInput> & { isActive?: boolean };

export type NetworkCheckInput = {
  name: string;
  monitorType: 'icmp_ping' | 'tcp_port' | 'http_check' | 'dns_check';
  target: string;
  config?: Record<string, unknown>;
  pollingInterval?: number;
  timeout?: number;
};

export type TemplateSuggestion = { templateId: string; templateName: string; reason: string };

export type SnmpSaveResult = {
  snmpDevice?: { id: string; templateId: string | null } | null;
  /** W03 only. A pre-W03 API omits it; the Monitoring section feature-detects. */
  templateSuggestion?: TemplateSuggestion | null;
};

export type NetworkAssetMutations = {
  patchIdentity(assetId: string, patch: IdentityPatch): Promise<void>;
  approve(assetId: string): Promise<void>;
  dismiss(assetId: string): Promise<void>;
  deleteAsset(assetId: string): Promise<void>;
  link(assetId: string, deviceId: string): Promise<void>;
  unlink(assetId: string): Promise<void>;
  putSnmp(assetId: string, input: SnmpUpsertInput): Promise<SnmpSaveResult>;
  patchSnmp(assetId: string, patch: SnmpPatchInput): Promise<SnmpSaveResult>;
  disableMonitoring(assetId: string): Promise<void>;
  createCheck(assetId: string, input: NetworkCheckInput): Promise<void>;
  deleteCheck(monitorId: string): Promise<void>;
};

export function useNetworkAssetMutations(): NetworkAssetMutations {
  const { t } = useTranslation('devices');

  return useMemo<NetworkAssetMutations>(() => {
    const toVoid = (promise: Promise<unknown>) => promise.then(() => undefined);

    return {
      patchIdentity: (assetId, patch) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          }),
          successMessage: patch.resetTypeToAuto
            ? t('networkDeviceDetailPage.toasts.typeReset')
            : t('networkDeviceDetailPage.settings.toasts.identitySaved'),
          errorFallback: patch.resetTypeToAuto
            ? t('networkDeviceDetailPage.toasts.typeResetFailed')
            : t('networkDeviceDetailPage.settings.toasts.identitySaveFailed'),
        })),

      approve: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/approve`, { method: 'PATCH' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.approved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.approveFailed'),
        })),

      dismiss: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/dismiss`, { method: 'PATCH' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.dismissed'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.dismissFailed'),
        })),

      deleteAsset: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.assetDeleted'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.assetDeleteFailed'),
        })),

      link: (assetId, deviceId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/link`, {
            method: 'POST',
            body: JSON.stringify({ deviceId }),
          }),
          successMessage: t('networkDeviceDetailPage.toasts.linked'),
          errorFallback: t('networkDeviceDetailPage.toasts.linkFailed'),
        })),

      unlink: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/discovery/assets/${assetId}/link`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.toasts.unlinked'),
          errorFallback: t('networkDeviceDetailPage.toasts.unlinkFailed'),
        })),

      putSnmp: (assetId, input) =>
        runAction<SnmpSaveResult>({
          request: () => fetchWithAuth(`/monitoring/assets/${assetId}/snmp`, {
            method: 'PUT',
            body: JSON.stringify(input),
          }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.snmpSaved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.snmpSaveFailed'),
        }),

      patchSnmp: (assetId, patch) =>
        runAction<SnmpSaveResult>({
          request: () => fetchWithAuth(`/monitoring/assets/${assetId}/snmp`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          }),
          successMessage: patch.isActive === false
            ? t('networkDeviceDetailPage.settings.toasts.pollingPaused')
            : patch.isActive === true
              ? t('networkDeviceDetailPage.settings.toasts.pollingResumed')
              : t('networkDeviceDetailPage.settings.toasts.snmpSaved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.snmpSaveFailed'),
        }),

      disableMonitoring: (assetId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/monitoring/assets/${assetId}`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.monitoringDisabled'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.monitoringDisableFailed'),
        })),

      createCheck: (assetId, input) =>
        toVoid(runAction({
          request: () => fetchWithAuth('/monitors', {
            method: 'POST',
            body: JSON.stringify({ ...input, assetId }),
          }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.checkCreated'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.checkCreateFailed'),
        })),

      deleteCheck: (monitorId) =>
        toVoid(runAction({
          request: () => fetchWithAuth(`/monitors/${monitorId}`, { method: 'DELETE' }),
          successMessage: t('networkDeviceDetailPage.settings.toasts.checkRemoved'),
          errorFallback: t('networkDeviceDetailPage.settings.toasts.checkRemoveFailed'),
        })),
    };
  }, [t]);
}
```

- [ ] **Step 4: Add the placeholder i18n keys so the test can run**

Add to `apps/web/src/locales/en/devices.json` under `networkDeviceDetailPage` (the other 7 locales are done in Task 11, but `en` must exist now or `keyUsage.test.ts` and these tests read raw keys):

```json
"settings": {
  "toasts": {
    "identitySaved": "Identity saved",
    "identitySaveFailed": "Couldn't save the identity changes",
    "approved": "Asset approved",
    "approveFailed": "Couldn't approve the asset",
    "dismissed": "Asset dismissed",
    "dismissFailed": "Couldn't dismiss the asset",
    "assetDeleted": "Asset deleted",
    "assetDeleteFailed": "Couldn't delete the asset",
    "snmpSaved": "SNMP settings saved",
    "snmpSaveFailed": "Couldn't save the SNMP settings",
    "pollingPaused": "SNMP polling paused",
    "pollingResumed": "SNMP polling resumed",
    "monitoringDisabled": "Monitoring disabled for this asset",
    "monitoringDisableFailed": "Couldn't disable monitoring",
    "checkCreated": "Network check added",
    "checkCreateFailed": "Couldn't add the network check",
    "checkRemoved": "Network check removed",
    "checkRemoveFailed": "Couldn't remove the network check"
  }
}
```

- [ ] **Step 5: Run it green**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts
```
Expected: 1 file, 12 tests passing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.ts \
        apps/web/src/components/devices/networkDevice/settings/useNetworkAssetMutations.test.ts \
        apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): add useNetworkAssetMutations, the single asset writer

W04 Task 2. One typed, runAction-wrapped function per asset-scoped write, so
every surface reports success and failure the same way. Callers move over in
Tasks 8-10; the contract test that keeps this the only writer lands next.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Single-writer contract test (red on purpose until Task 10)

**Files:**
- Create: `apps/web/src/lib/__tests__/network-asset-single-writer.test.ts`

**Interfaces:** none exported — a guard test, shaped after `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (AST, not regex; conservative on non-literal methods; self-checks on inline fixtures).

**This test goes RED now and is turned GREEN by Task 10** (the monitoring dashboard is the last caller to move). At the end of Task 3 it must name exactly these seven files: `discovery/DiscoveredAssetList.tsx`, `discovery/AssetDetailModal.tsx`, `discovery/AssetMonitoringSection.tsx`, `discovery/EnableMonitoringForm.tsx`, `monitoring/MonitoringAssetsDashboard.tsx`, `devices/NetworkDeviceDetailPage.tsx`, `devices/networkDevice/LinkManuallyControl.tsx`.

Scope decision recorded in the file: the guard enforces the **asset-scoped** endpoints only. `/discovery/assets/bulk-approve` and `/bulk-dismiss` stay with Discovery (spec §10: "triage is Discovery's job") and `/monitors*` stays with `CreateMonitorForm` / `NetworkMonitorList` / `MonitorDetailModal`, which own the generic monitor surface and which spec §10 tells the Monitoring section to reuse.

- [ ] **Step 1: Write the test**

```ts
// apps/web/src/lib/__tests__/network-asset-single-writer.test.ts
/**
 * Guard (spec §10, D7): `networkDevice/settings/useNetworkAssetMutations.ts` is
 * the ONLY module in apps/web that mutates a discovered network asset.
 *
 * Before W04 four surfaces wrote the same asset with four different idioms, and
 * two of them (AssetDetailModal's save, AssetMonitoringSection's disable) failed
 * into an inline banner nobody scrolled to. Concentrating the writes is the fix;
 * this test is what keeps them concentrated.
 *
 * It is an AST check (TypeScript compiler API) over every .ts/.tsx under
 * apps/web/src: find each `fetchWithAuth(...)` call, reduce its URL argument to
 * a shape (`${…}` → `*`), and flag a mutating call against a guarded shape from
 * any file other than the writer.
 *
 * Deliberately OUT of scope, with reasons:
 *  - `/discovery/assets/bulk-approve` | `/bulk-dismiss` — list-level triage that
 *    spec §10 leaves on the Discovery rows and bulk bar.
 *  - `/monitors`, `/monitors/:id` — the generic monitor surface owned by
 *    CreateMonitorForm / NetworkMonitorList / MonitorDetailModal. Spec §10 tells
 *    the settings modal to reuse CreateMonitorForm for Add, so a blanket ban
 *    would contradict the spec. The writer still exposes createCheck/deleteCheck
 *    so the modal has one typed path.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

/** The one module allowed to mutate the guarded endpoints. */
const WRITER = join('components', 'devices', 'networkDevice', 'settings', 'useNetworkAssetMutations.ts');

/**
 * URL shapes (interpolations collapsed to `*`, query string dropped) that only
 * the writer may mutate, with the methods that count as a mutation there.
 */
const GUARDED: ReadonlyArray<{ shape: string; methods: readonly string[] }> = [
  { shape: '/discovery/assets/*', methods: ['PATCH', 'DELETE'] },
  { shape: '/discovery/assets/*/approve', methods: ['PATCH', 'POST'] },
  { shape: '/discovery/assets/*/dismiss', methods: ['PATCH', 'POST'] },
  { shape: '/discovery/assets/*/link', methods: ['POST', 'DELETE', 'PATCH'] },
  { shape: '/monitoring/assets/*', methods: ['DELETE', 'PATCH', 'PUT', 'POST'] },
  { shape: '/monitoring/assets/*/snmp', methods: ['PUT', 'PATCH', 'POST', 'DELETE'] },
];

const SKIP_DIRS = new Set(['node_modules', '__mocks__', 'dist', '.astro']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectSourceFiles(full, out);
      continue;
    }
    if (['.ts', '.tsx'].includes(extname(entry)) && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/** `/discovery/assets/${id}/link?x=1` → `/discovery/assets/*\/link`. */
function urlShape(node: ts.Expression): string | null {
  let raw: string | null = null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    raw = node.text;
  } else if (ts.isTemplateExpression(node)) {
    raw = node.head.text + node.templateSpans.map((s) => `*${s.literal.text}`).join('');
  }
  if (raw === null) return null;
  return raw.split('?')[0]!.replace(/\/+$/, '');
}

/**
 * The HTTP method a `fetchWithAuth` call uses.
 *   - one argument, or an options object with no `method`  → 'GET' (the default)
 *   - a string-literal `method`                            → that verb
 *   - anything else (spread, identifier, conditional)      → 'UNKNOWN' (mutating)
 */
function methodOf(call: ts.CallExpression): string {
  const options = call.arguments[1];
  if (!options) return 'GET';
  if (!ts.isObjectLiteralExpression(options)) return 'UNKNOWN';
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop)) return 'UNKNOWN';
    const name = (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) ? prop.name : undefined;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== 'method') continue;
    if (ts.isShorthandPropertyAssignment(prop)) return 'UNKNOWN';
    const value = (prop as ts.PropertyAssignment).initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.toUpperCase();
    return 'UNKNOWN';
  }
  return 'GET';
}

type Violation = { line: number; shape: string; method: string };

export function findAssetWrites(source: string, fileName = 'x.tsx'): Violation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetchWithAuth') {
      const shape = node.arguments[0] ? urlShape(node.arguments[0]) : null;
      if (shape) {
        const guard = GUARDED.find((g) => g.shape === shape);
        const method = methodOf(node);
        if (guard && (method === 'UNKNOWN' || guard.methods.includes(method))) {
          violations.push({
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            shape,
            method,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe('guard self-checks', () => {
  it('flags a mutating call against a guarded shape', () => {
    expect(findAssetWrites("fetchWithAuth(`/discovery/assets/${id}`, { method: 'PATCH' });")).toHaveLength(1);
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}/snmp`, { method: 'PUT' });")).toHaveLength(1);
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}`, { method: 'DELETE' });")).toHaveLength(1);
  });

  it('does NOT flag reads of the same URLs', () => {
    expect(findAssetWrites("fetchWithAuth(`/discovery/assets/${id}`);")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}`, { headers: h });")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth(`/discovery/assets/${id}`, { method: 'GET' });")).toHaveLength(0);
  });

  it('treats a non-literal method as a mutation (conservative)', () => {
    expect(findAssetWrites('fetchWithAuth(`/discovery/assets/${id}`, { method: m });')).toHaveLength(1);
    expect(findAssetWrites('fetchWithAuth(`/discovery/assets/${id}`, { ...init });')).toHaveLength(1);
  });

  it('ignores the out-of-scope endpoints by design', () => {
    expect(findAssetWrites("fetchWithAuth('/discovery/assets/bulk-approve', { method: 'POST' });")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth('/monitors', { method: 'POST' });")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth(`/monitors/${id}`, { method: 'DELETE' });")).toHaveLength(0);
  });

  it('drops a query string before matching', () => {
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}?orgId=1`, { method: 'DELETE' });")).toHaveLength(1);
  });
});

describe('network asset single writer', () => {
  const files = collectSourceFiles(SRC_ROOT);

  it('finds the writer module', () => {
    expect(files.some((f) => relative(SRC_ROOT, f) === WRITER)).toBe(true);
  });

  it('the writer actually covers every guarded shape (no vacuous pass)', () => {
    const source = readFileSync(join(SRC_ROOT, WRITER), 'utf8');
    const covered = new Set(findAssetWrites(source, WRITER).map((v) => v.shape));
    expect([...covered].sort()).toEqual(GUARDED.map((g) => g.shape).sort());
  });

  it('no other module mutates an asset-scoped endpoint', () => {
    const offenders = files
      .filter((f) => relative(SRC_ROOT, f) !== WRITER)
      .flatMap((f) => {
        const rel = relative(SRC_ROOT, f).split(sep).join('/');
        return findAssetWrites(readFileSync(f, 'utf8'), rel).map((v) => `${rel}:${v.line} ${v.method} ${v.shape}`);
      })
      .sort();

    expect(
      offenders,
      offenders.length
        ? `These modules write a network asset directly:\n  ${offenders.join('\n  ')}\n` +
            `Route them through useNetworkAssetMutations() (spec §10, D7).`
        : undefined,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm the RED is the expected one**

```bash
cd apps/web && npx vitest run src/lib/__tests__/network-asset-single-writer.test.ts
```
Expected: the self-checks and the first two `single writer` tests pass; the last one fails listing exactly seven files:
```
components/discovery/AssetDetailModal.tsx:85 DELETE /discovery/assets/*
components/discovery/AssetDetailModal.tsx:111 PATCH /discovery/assets/*
components/discovery/AssetDetailModal.tsx:139 PATCH /discovery/assets/*
components/discovery/AssetMonitoringSection.tsx:107 DELETE /monitoring/assets/*
components/discovery/DiscoveredAssetList.tsx:339 PATCH /discovery/assets/*/approve
components/discovery/DiscoveredAssetList.tsx:354 PATCH /discovery/assets/*/dismiss
components/discovery/EnableMonitoringForm.tsx:94 PUT /monitoring/assets/*/snmp
components/devices/NetworkDeviceDetailPage.tsx:119 DELETE /discovery/assets/*/link
components/devices/NetworkDeviceDetailPage.tsx:149 PATCH /discovery/assets/*
components/devices/networkDevice/LinkManuallyControl.tsx:72 POST /discovery/assets/*/link
components/monitoring/MonitoringAssetsDashboard.tsx:241 PATCH /monitoring/assets/*/snmp
components/monitoring/MonitoringAssetsDashboard.tsx:264 DELETE /monitoring/assets/*
components/monitoring/MonitoringAssetsDashboard.tsx:707 PUT /monitoring/assets/*/snmp
```
If the list differs, re-check `findAssetWrites` before changing any product code — a guard that misses a known caller is worse than none.

- [ ] **Step 3: Commit the red guard**

```bash
git add apps/web/src/lib/__tests__/network-asset-single-writer.test.ts
git commit -m "$(cat <<'EOF'
test(web): add the network-asset single-writer contract test (red until W04 Task 10)

W04 Task 3. Written before the callers move so the red names every surface that
still writes a discovered asset directly. Tasks 8-10 turn it green; Task 10
(the monitoring dashboard) is the last one.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Modal shell + section rail + open/close via hash

**Files:**
- Create: `.../settings/SettingsSectionShell.tsx`
- Create: `.../settings/NetworkAssetSettingsModal.tsx`
- Create: `.../settings/NetworkAssetSettingsModal.test.tsx`

**Interfaces:**
```tsx
// SettingsSectionShell.tsx
export function SettingsSectionShell(props: {
  section: SettingsSection;
  title: string;
  description?: string;
  dirty?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
  children: ReactNode;
}): JSX.Element;

// NetworkAssetSettingsModal.tsx
export type NetworkAssetSettingsModalProps = {
  open: boolean;                                   // locked name
  section: SettingsSection | null;                 // locked name
  assetId: string;                                 // locked name
  onClose: () => void;                             // locked name
  onSaved: () => void | Promise<void>;             // locked name
  // additive, all required for the sections to render:
  asset: DiscoveredAsset;
  extras: NetworkAssetExtras;
  onSectionChange: (section: SettingsSection) => void;
  onAnnounce: (message: string) => void;
};
export function NetworkAssetSettingsModal(props: NetworkAssetSettingsModalProps): JSX.Element | null;
```

The page's `devices` / `devicesError` / `onRetryDevices` are deliberately **not** threaded in: the only device picker inside the modal is `LinkManuallyControl`, which fetches its own site-scoped list (`LinkManuallyControl.tsx:42`), and the page's list is site-scoped-with-unscoped-fallback for the proxy popover — a different set. Passing it would either be dead weight or quietly widen the link picker.

Decisions: `maxWidth="4xl"` rather than the spec's parenthetical `"lg"` — `max-w-lg` is 32rem, which cannot hold a left rail plus the SNMP credential grid that `EditMonitoringModal` already needed `max-w-3xl` for. `Dialog` is modal and focus-trapping (`shared/Dialog.tsx`), so the Chrome `focusout`/null-`relatedTarget` popover hazard does not apply here.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkAssetSettingsModal } from './NetworkAssetSettingsModal';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn().mockResolvedValue({
  ok: true, status: 200, json: vi.fn().mockResolvedValue({ data: [] }),
}) }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const asset: DiscoveredAsset = {
  id: 'asset-1',
  ip: '10.0.0.2',
  mac: 'aa:bb:cc:dd:ee:ff',
  hostname: 'core-sw-01',
  label: 'Main Switch',
  type: 'switch',
  approvalStatus: 'approved',
  isOnline: true,
  manufacturer: 'Cisco',
  typeSource: 'auto',
  tags: ['core'],
  notes: 'Closet A',
};

const baseProps = {
  open: true,
  section: 'identity' as const,
  assetId: asset.id,
  asset,
  extras: { siteId: 'site-1' },
  onSectionChange: vi.fn(),
  onClose: vi.fn(),
  onSaved: vi.fn(),
  onAnnounce: vi.fn(),
};

beforeEach(() => vi.clearAllMocks());

describe('NetworkAssetSettingsModal', () => {
  it('renders nothing when closed', () => {
    render(<NetworkAssetSettingsModal {...baseProps} open={false} section={null} />);
    expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument();
  });

  it('renders nothing when open but no section is selected', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section={null} />);
    expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument();
  });

  it('renders the four-section rail and marks the active one', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section="monitoring" />);

    for (const section of ['identity', 'monitoring', 'link', 'danger']) {
      expect(screen.getByTestId(`network-settings-nav-${section}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('network-settings-nav-monitoring')).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('network-settings-nav-identity')).not.toHaveAttribute('aria-current', 'true');
  });

  it('renders only the active section panel', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section="identity" />);

    expect(screen.getByTestId('network-settings-panel-identity')).toBeInTheDocument();
    expect(screen.queryByTestId('network-settings-panel-danger')).not.toBeInTheDocument();
  });

  it('asks the page to change section instead of owning the selection', () => {
    render(<NetworkAssetSettingsModal {...baseProps} section="identity" />);

    fireEvent.click(screen.getByTestId('network-settings-nav-danger'));
    expect(baseProps.onSectionChange).toHaveBeenCalledWith('danger');
  });

  it('shows the asset name in the dialog title so the operator knows what they are editing', () => {
    render(<NetworkAssetSettingsModal {...baseProps} />);
    expect(screen.getByTestId('network-asset-settings-modal').textContent).toContain('Main Switch');
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `cd apps/web && npx vitest run src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.test.tsx` → unresolved import.

- [ ] **Step 3: Implement `SettingsSectionShell.tsx`**

```tsx
// apps/web/src/components/devices/networkDevice/settings/SettingsSectionShell.tsx
// Per-section frame: heading, optional description, body, and the Save/Cancel
// row that only appears once the section is dirty. Every section in the modal
// saves independently (spec §10), so the footer belongs to the section rather
// than to the dialog.

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { SettingsSection } from './settingsHash';

export function SettingsSectionShell({
  section,
  title,
  description,
  dirty = false,
  saving = false,
  saveDisabled = false,
  onSave,
  onCancel,
  children,
}: {
  section: SettingsSection;
  title: string;
  description?: string;
  dirty?: boolean;
  saving?: boolean;
  saveDisabled?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('devices');
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      data-testid={`network-settings-panel-${section}`}
      aria-labelledby={`network-settings-heading-${section}`}
    >
      <div className="border-b px-5 py-4">
        <h3 id={`network-settings-heading-${section}`} className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {onSave && (
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
          {dirty && (
            <span className="mr-auto text-xs text-muted-foreground" data-testid={`network-settings-${section}-dirty`}>
              {t('networkDeviceDetailPage.settings.unsavedChanges')}
            </span>
          )}
          <button
            type="button"
            data-testid={`network-settings-${section}-cancel`}
            onClick={onCancel}
            disabled={!dirty || saving}
            className="h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            data-testid={`network-settings-${section}-save`}
            onClick={onSave}
            disabled={!dirty || saving || saveDisabled}
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Implement `NetworkAssetSettingsModal.tsx`**

```tsx
// apps/web/src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.tsx
// The one settings surface for a discovered network asset (spec §10, D7).
// Four independently-saved sections behind a left rail; the selected section is
// URL state (`#<tab>/settings/<section>`), owned by the page, so a rail click,
// a deep link from Discovery, and browser back/forward all agree.

import { useTranslation } from 'react-i18next';
import { Info, Link2, Radio, ShieldAlert } from 'lucide-react';

import { Dialog } from '@/components/shared/Dialog';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import type { NetworkAssetExtras } from '../types';
import { SETTINGS_SECTIONS, type SettingsSection } from './settingsHash';
import { IdentitySection } from './IdentitySection';
import { MonitoringSection } from './MonitoringSection';
import { LinkSection } from './LinkSection';
import { DangerSection } from './DangerSection';

const SECTION_META: Record<SettingsSection, { labelKey: string; Icon: typeof Info }> = {
  identity: { labelKey: 'networkDeviceDetailPage.settings.sections.identity', Icon: Info },
  monitoring: { labelKey: 'networkDeviceDetailPage.settings.sections.monitoring', Icon: Radio },
  link: { labelKey: 'networkDeviceDetailPage.settings.sections.link', Icon: Link2 },
  danger: { labelKey: 'networkDeviceDetailPage.settings.sections.danger', Icon: ShieldAlert },
};

export type NetworkAssetSettingsModalProps = {
  open: boolean;
  section: SettingsSection | null;
  assetId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  asset: DiscoveredAsset;
  extras: NetworkAssetExtras;
  onSectionChange: (section: SettingsSection) => void;
  onAnnounce: (message: string) => void;
};

export function NetworkAssetSettingsModal({
  open,
  section,
  assetId,
  onClose,
  onSaved,
  asset,
  extras,
  onSectionChange,
  onAnnounce,
}: NetworkAssetSettingsModalProps) {
  const { t } = useTranslation('devices');
  // `section === null` is the closed state in the hash grammar; rendering the
  // Dialog with no section would show an empty shell on a plain `#overview`.
  if (!open || section === null) return null;

  const displayName = asset.label || asset.hostname || asset.ip;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('networkDeviceDetailPage.settings.title', { name: displayName })}
      maxWidth="4xl"
      alignTop
      className="flex flex-col max-h-[calc(100vh-4rem)]"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="network-asset-settings-modal">
        <div className="border-b px-5 py-4">
          <h2 className="text-base font-semibold">
            {t('networkDeviceDetailPage.settings.title', { name: displayName })}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('networkDeviceDetailPage.settings.subtitle')}
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav
            aria-label={t('networkDeviceDetailPage.settings.navLabel')}
            className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r"
          >
            {SETTINGS_SECTIONS.map((id) => {
              const { labelKey, Icon } = SECTION_META[id];
              const active = id === section;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`network-settings-nav-${id}`}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => onSectionChange(id)}
                  className={`flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                >
                  <Icon aria-hidden="true" className="h-4 w-4" />
                  {t(/* i18n-dynamic */ labelKey)}
                </button>
              );
            })}
          </nav>

          {section === 'identity' && (
            <IdentitySection asset={asset} assetId={assetId} onSaved={onSaved} onAnnounce={onAnnounce} />
          )}
          {section === 'monitoring' && (
            <MonitoringSection asset={asset} assetId={assetId} onSaved={onSaved} onAnnounce={onAnnounce} />
          )}
          {section === 'link' && (
            <LinkSection asset={asset} assetId={assetId} extras={extras} onSaved={onSaved} onAnnounce={onAnnounce} />
          )}
          {section === 'danger' && (
            <DangerSection asset={asset} assetId={assetId} onSaved={onSaved} onClose={onClose} onAnnounce={onAnnounce} />
          )}
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 5: Stub the four section components** so the shell compiles. Each is a `SettingsSectionShell` with its title and a `TODO` body; Tasks 5-7 fill them in. Keep the prop signatures above — later tasks only change the bodies.

- [ ] **Step 6: Add the shell i18n keys to `en/devices.json`** under `networkDeviceDetailPage.settings`: `title` (`"{{name}} settings"`), `subtitle`, `navLabel`, `unsavedChanges`, `sections.{identity,monitoring,link,danger}`.

- [ ] **Step 7: Run green**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/settings/NetworkAssetSettingsModal.test.tsx
```
Expected: 6 tests passing.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/devices/networkDevice/settings apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): add the NetworkAssetSettingsModal shell and section rail

W04 Task 4. Dialog + four-section rail; section selection stays URL state owned
by the page, so a rail click, a Discovery deep link and browser back/forward can
never disagree. Section bodies land in Tasks 5-7.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Identity section

**Files:**
- Create: `.../settings/assetTypeGroups.ts`, `.../settings/assetTypeGroups.test.ts`
- Modify: `.../settings/IdentitySection.tsx` (fill the stub)
- Create: `.../settings/IdentitySection.test.tsx`

**Interfaces:**
```ts
// assetTypeGroups.ts
export const ASSET_TYPE_GROUPS: ReadonlyArray<{ labelKey: string; types: readonly DiscoveredAssetType[] }>;
export const PATCHABLE_ASSET_TYPES: readonly DiscoveredAssetType[];
export function isPatchableAssetType(type: DiscoveredAssetType): boolean;
```
```tsx
// IdentitySection.tsx
export function IdentitySection(props: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}): JSX.Element;
```

**Constraint discovered while reading the API — state it in the code:** `updateAssetSchema` (`apps/api/src/routes/discovery.ts:434-452`) accepts exactly twelve asset types. `website` and `service` exist in the DB enum and in the web's `typeConfig` (added by #5213 W03 for manual assets) but a PATCH carrying either **400s**. The grouped select therefore offers only the twelve, and an asset that already *is* `website`/`service` renders its current type as a selected-but-disabled option plus a one-line note, so the control has a valid value and the operator can still re-classify it into an accepted type.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/components/devices/networkDevice/settings/assetTypeGroups.test.ts
import { describe, expect, it } from 'vitest';

import { ASSET_TYPE_GROUPS, PATCHABLE_ASSET_TYPES, isPatchableAssetType } from './assetTypeGroups';

// Mirrors routes/discovery.ts updateAssetSchema.assetType exactly. If the API
// widens or narrows that enum, this list is the thing that must move with it —
// a select offering a type the PATCH rejects is a 400 with no explanation.
const API_ACCEPTED = [
  'workstation', 'server', 'printer', 'router', 'switch', 'firewall',
  'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown',
] as const;

describe('assetTypeGroups', () => {
  it('covers exactly the types PATCH /discovery/assets/:id accepts', () => {
    expect([...PATCHABLE_ASSET_TYPES].sort()).toEqual([...API_ACCEPTED].sort());
  });

  it('lists each type in exactly one group', () => {
    const flat = ASSET_TYPE_GROUPS.flatMap((g) => g.types);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('excludes website/service, which the PATCH route rejects', () => {
    expect(isPatchableAssetType('website')).toBe(false);
    expect(isPatchableAssetType('service')).toBe(false);
    expect(isPatchableAssetType('switch')).toBe(true);
  });
});
```

```tsx
// apps/web/src/components/devices/networkDevice/settings/IdentitySection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentitySection } from './IdentitySection';
import { fetchWithAuth } from '@/stores/auth';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const ok = (payload: unknown = { success: true }, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01', label: 'Main Switch',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
  typeSource: 'auto', tags: ['core'], notes: 'Closet A',
};

const props = { asset, assetId: asset.id, onSaved: vi.fn(), onAnnounce: vi.fn() };
const patchBody = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
  props.onSaved = vi.fn();
});

describe('IdentitySection', () => {
  it('starts clean — Save and Cancel are disabled until something changes', () => {
    render(<IdentitySection {...props} />);
    expect(screen.getByTestId('network-settings-identity-save')).toBeDisabled();
    expect(screen.getByTestId('network-settings-identity-cancel')).toBeDisabled();
  });

  it('PATCHes only the changed fields', async () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: 'Core Switch' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ label: 'Core Switch' });
    expect(props.onSaved).toHaveBeenCalled();
  });

  it('sends a blank display name as null so the server clears it', async () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ label: null });
  });

  it('splits the tags field into a trimmed array', async () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-tags'), { target: { value: ' core , floor-2 ,, ' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ tags: ['core', 'floor-2'] });
  });

  it('Cancel restores every field and re-disables Save', () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-notes'), { target: { value: 'Moved' } });
    expect(screen.getByTestId('network-settings-identity-save')).toBeEnabled();

    fireEvent.click(screen.getByTestId('network-settings-identity-cancel'));
    expect(screen.getByTestId('network-settings-identity-notes')).toHaveValue('Closet A');
    expect(screen.getByTestId('network-settings-identity-save')).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the consequence line only while a different type is pending', () => {
    render(<IdentitySection {...props} />);
    expect(screen.queryByTestId('network-settings-identity-type-consequence')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'printer' } });
    expect(screen.getByTestId('network-settings-identity-type-consequence')).toHaveTextContent(
      'Changes the suggested SNMP template',
    );
  });

  it('groups the type options and offers exactly the twelve the API accepts', () => {
    render(<IdentitySection {...props} />);
    const select = screen.getByTestId('network-settings-identity-type');

    expect(select.querySelectorAll('optgroup')).toHaveLength(4);
    expect(select.querySelectorAll('option:not([disabled])')).toHaveLength(12);
  });

  it('keeps an unsupported saved type selectable-but-disabled instead of silently rewriting it', () => {
    render(<IdentitySection {...props} asset={{ ...asset, type: 'website' }} />);
    const select = screen.getByTestId('network-settings-identity-type') as HTMLSelectElement;

    expect(select.value).toBe('website');
    expect(select.querySelector('option[value="website"]')).toBeDisabled();
    expect(screen.getByTestId('network-settings-identity-type-fixed')).toBeInTheDocument();
  });

  it('shows the detected-type anchor and Reset only when the type was set manually', () => {
    const { rerender } = render(<IdentitySection {...props} />);
    expect(screen.queryByTestId('network-settings-identity-type-reset')).not.toBeInTheDocument();

    rerender(<IdentitySection {...props} asset={{ ...asset, typeSource: 'manual', detectedType: 'router' }} />);
    expect(screen.getByTestId('network-settings-identity-type-detected')).toHaveTextContent('Router');
    expect(screen.getByTestId('network-settings-identity-type-reset')).toBeInTheDocument();
  });

  it('Reset PATCHes resetTypeToAuto and discards any pending type edit', async () => {
    render(<IdentitySection {...props} asset={{ ...asset, typeSource: 'manual', detectedType: 'router' }} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'printer' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-type-reset'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ resetTypeToAuto: true });
  });

  it('reloads and drops the draft when the save 409s (spec §14)', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'Asset changed' }, 409));
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: 'Core Switch' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(screen.getByTestId('network-settings-identity-name')).toHaveValue('Main Switch');
    expect(await screen.findByTestId('network-settings-identity-conflict')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run both and watch them fail.**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/settings/assetTypeGroups.test.ts \
  src/components/devices/networkDevice/settings/IdentitySection.test.tsx
```

- [ ] **Step 3: Implement `assetTypeGroups.ts`**

```ts
// apps/web/src/components/devices/networkDevice/settings/assetTypeGroups.ts
// The grouped device-type table for the Identity section's select.
//
// The grouping is presentational, but the MEMBERSHIP is a contract: these are
// exactly the twelve values `updateAssetSchema.assetType` accepts in
// apps/api/src/routes/discovery.ts. `website` and `service` exist in the DB
// enum and in typeConfig (#5213 W03, manual URL-identity assets) but the PATCH
// route rejects them, so offering them here would 400 with no explanation.
// assetTypeGroups.test.ts pins the list against the route's enum.

import type { DiscoveredAssetType } from '@/components/discovery/DiscoveredAssetList';

export const ASSET_TYPE_GROUPS = [
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.endpoints',
    types: ['workstation', 'server'],
  },
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.networkGear',
    types: ['router', 'switch', 'firewall', 'access_point'],
  },
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.peripherals',
    types: ['printer', 'camera', 'phone', 'nas'],
  },
  {
    labelKey: 'networkDeviceDetailPage.settings.identity.typeGroups.other',
    types: ['iot', 'unknown'],
  },
] as const satisfies ReadonlyArray<{ labelKey: string; types: readonly DiscoveredAssetType[] }>;

export const PATCHABLE_ASSET_TYPES: readonly DiscoveredAssetType[] =
  ASSET_TYPE_GROUPS.flatMap((group) => group.types);

export function isPatchableAssetType(type: DiscoveredAssetType): boolean {
  return (PATCHABLE_ASSET_TYPES as readonly string[]).includes(type);
}
```

- [ ] **Step 4: Implement `IdentitySection.tsx`**

Shape (write it out in full; the load-bearing parts):

```tsx
export function IdentitySection({ asset, assetId, onSaved, onAnnounce }: IdentitySectionProps) {
  const { t } = useTranslation('devices');
  const { patchIdentity } = useNetworkAssetMutations();

  const baseline = useMemo(() => ({
    label: asset.label ?? '',
    tags: (asset.tags ?? []).join(', '),
    notes: asset.notes ?? '',
    type: asset.type,
  }), [asset.label, asset.tags, asset.notes, asset.type]);

  const [draft, setDraft] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  // A background refresh (or a save) lands a new asset — re-baseline the draft.
  useEffect(() => { setDraft(baseline); }, [baseline]);

  const dirty =
    draft.label.trim() !== baseline.label.trim()
    || draft.notes !== baseline.notes
    || draft.tags !== baseline.tags
    || draft.type !== baseline.type;

  const handleSave = async () => {
    const patch: IdentityPatch = {};
    if (draft.label.trim() !== baseline.label.trim()) patch.label = draft.label.trim() || null;
    if (draft.notes !== baseline.notes) patch.notes = draft.notes.trim() || null;
    if (draft.tags !== baseline.tags) {
      patch.tags = draft.tags.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (draft.type !== baseline.type) patch.assetType = draft.type;
    if (Object.keys(patch).length === 0) return;

    setSaving(true);
    setConflict(false);
    try {
      await patchIdentity(assetId, patch);
      await onSaved();
      onAnnounce(t('networkDeviceDetailPage.settings.toasts.identitySaved'));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;   // auth redirect owns it
      if (err instanceof ActionError && err.status === 409) {
        // Spec §14: someone else changed this asset. Reload and drop the draft
        // rather than letting a stale Save overwrite their change on retry.
        setConflict(true);
        setDraft(baseline);
        await onSaved();
        return;
      }
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.settings.toasts.identitySaveFailed') });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleResetType = async () => {
    setSaving(true);
    setConflict(false);
    try {
      // Reset discards any pending type edit too — throwing away manual
      // overrides is its whole point, so a pending one must not survive it.
      await patchIdentity(assetId, { resetTypeToAuto: true });
      setDraft((d) => ({ ...d, type: baseline.type }));
      await onSaved();
      onAnnounce(t('networkDeviceDetailPage.toasts.typeReset'));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.toasts.typeResetFailed') });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSectionShell
      section="identity"
      title={t('networkDeviceDetailPage.settings.sections.identity')}
      description={t('networkDeviceDetailPage.settings.identity.description')}
      dirty={dirty}
      saving={saving}
      onSave={() => void handleSave()}
      onCancel={() => { setDraft(baseline); setConflict(false); }}
    >
      {/* …fields, in the order below… */}
    </SettingsSectionShell>
  );
}
```

Body markup, in order:
1. **Display name** — labelled `<input data-testid="network-settings-identity-name" maxLength={255}>`.
2. **Type** — a real `<label htmlFor>` (spec §11 a11y) + `<select data-testid="network-settings-identity-type">` built from `ASSET_TYPE_GROUPS` as `<optgroup>`s; when `!isPatchableAssetType(asset.type)`, prepend `<option value={asset.type} disabled>` and render a `network-settings-identity-type-fixed` note. Under it: the detected anchor (`network-settings-identity-type-detected`, only when `typeSource === 'manual' && detectedType`), the **Reset to detected** button (`network-settings-identity-type-reset`, same condition, calls `patchIdentity(assetId, { resetTypeToAuto: true })` then `onSaved()` and clears the draft type), and the consequence line (`network-settings-identity-type-consequence`, only while `draft.type !== baseline.type`).
3. **Tags** — comma-separated input `network-settings-identity-tags`.
4. **Notes** — textarea `network-settings-identity-notes`.
5. **Conflict banner** — `network-settings-identity-conflict`, rendered while `conflict`.

Wrap in `<SettingsSectionShell section="identity" … dirty={dirty} saving={saving} onSave={handleSave} onCancel={() => { setDraft(baseline); setConflict(false); }} />`.

- [ ] **Step 5: Add the Identity i18n keys** to `en/devices.json` under `networkDeviceDetailPage.settings`: `identity.{description,displayName,type,typeFixed,typeDetected,typeConsequence,resetToDetected,tags,tagsHint,notes,conflict}` and `identity.typeGroups.{endpoints,networkGear,peripherals,other}`.

- [ ] **Step 6: Run green**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/settings/assetTypeGroups.test.ts src/components/devices/networkDevice/settings/IdentitySection.test.tsx
```
Expected: 2 files, 14 tests passing.

- [ ] **Step 7: Commit** (`feat(web/network-device): Identity section of the asset settings modal`).

---

### Task 6: Monitoring section

**Files:**
- Create: `.../settings/SnmpConfigForm.tsx`
- Modify: `.../settings/MonitoringSection.tsx` (fill the stub)
- Create: `.../settings/MonitoringSection.test.tsx`

**Interfaces:**
```tsx
// SnmpConfigForm.tsx — presentational only; owns no requests.
export type SnmpDraft = {
  snmpVersion: SnmpVersion; community: string; username: string;
  authProtocol: SnmpAuthProtocol; authPassword: string;
  privProtocol: SnmpPrivProtocol; privPassword: string;
  templateId: string; pollingInterval: number; port: number;
};
export function SnmpConfigForm(props: {
  draft: SnmpDraft;
  onChange: (patch: Partial<SnmpDraft>) => void;
  templates: Array<{ id: string; name: string; vendor?: string }>;
  templatesError: boolean;
  suggestion: TemplateSuggestion | null;
  onUseSuggestion: () => void;
  hasStoredCommunity: boolean;
  hasStoredAuthPassword: boolean;
  hasStoredPrivPassword: boolean;
  disabled: boolean;
}): JSX.Element;

// MonitoringSection.tsx
export function MonitoringSection(props: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}): JSX.Element;
```

Behaviour ported from `EditMonitoringModal` (`MonitoringAssetsDashboard.tsx:636-1038`) and `EnableMonitoringForm`, with the following decisions:
- **PUT vs PATCH**: `PUT` when the asset has no `snmpDevice` yet (create), `PATCH` when it does — the same rule `EditMonitoringModal.handleSave` used (`:706`). `PUT` requires a community (v1/v2c) or username (v3) because the route's `upsertSnmpSchema.refine` rejects a create without one; `PATCH` does not.
- **Masking**: credential inputs always start blank with a "leave blank to keep the current value" hint, and a "stored" marker when `Boolean(snmpDevice.community)` etc. The API already returns `'********'` from `serializeSnmpDevice`; never put that string in an input, or a save would send the mask back as the literal secret.
- **Suggestion (W03, feature-detected)**: on open, `GET /monitoring/templates/suggest?assetId=<id>`; a non-OK response (404 on a pre-W03 API) or a `null` body means "no suggestion" and the line is simply not rendered. After a save, a `templateSuggestion` echoed on the response refreshes it. Nothing about the section depends on W03 having shipped.
- **Reads stay out of the mutation hook** — `GET /monitoring/assets/:id`, `GET /monitors?assetId=`, `GET /snmp/templates` and the suggest call are plain `fetchWithAuth` reads in this component (the single-writer guard only covers mutations).
- **Add a check** reuses `CreateMonitorForm` verbatim (spec §10). **Remove** goes through `deleteCheck` behind a `ConfirmDialog`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/devices/networkDevice/settings/MonitoringSection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MonitoringSection } from './MonitoringSection';
import { fetchWithAuth } from '@/stores/auth';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
};

const props = { asset, assetId: asset.id, onSaved: vi.fn(), onAnnounce: vi.fn() };

type Wiring = {
  snmpDevice?: unknown;
  monitors?: unknown[];
  suggestStatus?: number;
  suggestBody?: unknown;
};

function wire({ snmpDevice = null, monitors = [], suggestStatus = 404, suggestBody = null }: Wiring = {}) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve(res({ success: true }));
    if (url.startsWith('/monitoring/templates/suggest')) return Promise.resolve(res(suggestBody, suggestStatus));
    if (url.startsWith('/monitoring/assets/')) {
      return Promise.resolve(res({ enabled: Boolean(snmpDevice), snmpDevice, networkMonitors: { totalCount: monitors.length, activeCount: monitors.length }, recentMetrics: [] }));
    }
    if (url.startsWith('/monitors?')) return Promise.resolve(res({ data: monitors }));
    if (url === '/snmp/templates') return Promise.resolve(res({ templates: [{ id: 't-1', name: 'Generic Printer (RFC 3805)' }] }));
    return Promise.resolve(res({}));
  });
}

const writeCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method);
const lastWriteBody = () => JSON.parse((writeCalls().at(-1)![1] as RequestInit).body as string);

beforeEach(() => { fetchMock.mockReset(); props.onSaved = vi.fn(); });

describe('MonitoringSection — SNMP configuration', () => {
  it('PUTs a full config when no SNMP device exists yet', async () => {
    wire();
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    fireEvent.change(screen.getByTestId('network-settings-snmp-community'), { target: { value: 'public' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![0]).toBe('/monitoring/assets/asset-1/snmp');
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('PUT');
    expect(lastWriteBody()).toMatchObject({ snmpVersion: 'v2c', community: 'public' });
  });

  it('blocks a create with no community and says why, without firing a request', async () => {
    wire();
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    fireEvent.change(screen.getByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    expect(await screen.findByTestId('network-settings-monitoring-error')).toHaveTextContent(/community/i);
    expect(writeCalls()).toHaveLength(0);
  });

  it('PATCHes an existing device and omits blank credential fields so stored secrets survive', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', community: '********', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);
    await screen.findByTestId('network-settings-snmp-version');

    // The masked value is never echoed into the input.
    expect(screen.getByTestId('network-settings-snmp-community')).toHaveValue('');
    expect(screen.getByTestId('network-settings-snmp-community-stored')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('network-settings-snmp-interval'), { target: { value: '600' } });
    fireEvent.click(screen.getByTestId('network-settings-monitoring-save'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('PATCH');
    expect(lastWriteBody()).not.toHaveProperty('community');
    expect(lastWriteBody()).toMatchObject({ pollingInterval: 600 });
  });

  it('pauses polling with isActive:false and resumes with true', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);

    fireEvent.click(await screen.findByTestId('network-settings-snmp-pause'));
    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(lastWriteBody()).toEqual({ isActive: false });
  });

  it('disables all monitoring behind a confirm', async () => {
    wire({ snmpDevice: { id: 'snmp-1', snmpVersion: 'v2c', templateId: null, pollingInterval: 300, port: 161, isActive: true, lastPolled: null, lastStatus: 'online' } });
    render(<MonitoringSection {...props} />);

    fireEvent.click(await screen.findByTestId('network-settings-monitoring-disable'));
    fireEvent.click(await screen.findByTestId('network-settings-monitoring-disable-confirm'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![0]).toBe('/monitoring/assets/asset-1');
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('DELETE');
  });
});

describe('MonitoringSection — template suggestion is feature-detected (W03)', () => {
  it('renders no suggestion line when the API does not have the route yet', async () => {
    wire({ suggestStatus: 404 });
    render(<MonitoringSection {...props} />);

    await screen.findByTestId('network-settings-snmp-template');
    expect(screen.queryByTestId('network-settings-snmp-suggestion')).not.toBeInTheDocument();
  });

  it('renders the reason and pre-selects the suggested template when the API returns one', async () => {
    wire({ suggestStatus: 200, suggestBody: { templateId: 't-1', templateName: 'Xerox Printer', reason: 'Detected Xerox printer' } });
    render(<MonitoringSection {...props} />);

    expect(await screen.findByTestId('network-settings-snmp-suggestion')).toHaveTextContent('Detected Xerox printer');
    fireEvent.click(screen.getByTestId('network-settings-snmp-suggestion-apply'));
    expect(screen.getByTestId('network-settings-snmp-template')).toHaveValue('t-1');
  });
});

describe('MonitoringSection — network checks', () => {
  it('lists the asset checks with their state and never says a bare "Online"', async () => {
    wire({ monitors: [{ id: 'mon-1', name: 'Ping', monitorType: 'icmp_ping', target: '10.0.0.2', isActive: true, lastStatus: 'online', lastChecked: new Date().toISOString() }] });
    render(<MonitoringSection {...props} />);

    const row = await screen.findByTestId('network-settings-check-mon-1');
    expect(row).toHaveTextContent('Ping');
    expect(row.textContent).toMatch(/Responding · ping/i);
  });

  it('removes a check through DELETE /monitors/:id after a confirm', async () => {
    wire({ monitors: [{ id: 'mon-1', name: 'Ping', monitorType: 'icmp_ping', target: '10.0.0.2', isActive: true, lastStatus: 'online', lastChecked: null }] });
    render(<MonitoringSection {...props} />);

    fireEvent.click(await screen.findByTestId('network-settings-check-remove-mon-1'));
    fireEvent.click(await screen.findByTestId('network-settings-check-remove-confirm'));

    await waitFor(() => expect(writeCalls()).toHaveLength(1));
    expect(writeCalls()[0]![0]).toBe('/monitors/mon-1');
    expect((writeCalls()[0]![1] as RequestInit).method).toBe('DELETE');
  });
});
```

- [ ] **Step 2: Run it and watch it fail** (the stub renders no fields).

- [ ] **Step 3: Implement `SnmpConfigForm.tsx`** — the field block, ported from `EditMonitoringModal` (`MonitoringAssetsDashboard.tsx:807-928`) with real labels, test ids and stored-secret markers:

```tsx
// apps/web/src/components/devices/networkDevice/settings/SnmpConfigForm.tsx
// The SNMP field block. Presentational: it owns no requests and no draft — the
// Monitoring section holds both, so the same fields can serve a create (PUT)
// and an edit (PATCH) without two copies of the markup.
//
// Credential fields are ALWAYS blank on open. The API returns them masked
// (`serializeSnmpDevice`, monitoring.ts:114-122); echoing that mask into an
// input and saving it would send `********` back as the literal secret.

import { useTranslation } from 'react-i18next';

import type { SnmpAuthProtocol, SnmpPrivProtocol, SnmpVersion, TemplateSuggestion } from './useNetworkAssetMutations';

export type SnmpDraft = {
  snmpVersion: SnmpVersion;
  community: string;
  username: string;
  authProtocol: SnmpAuthProtocol;
  authPassword: string;
  privProtocol: SnmpPrivProtocol;
  privPassword: string;
  templateId: string;
  pollingInterval: number;
  port: number;
};

export type SnmpTemplateOption = { id: string; name: string; vendor?: string };

const FIELD_CLASS =
  'mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const LABEL_CLASS = 'block text-xs font-medium text-muted-foreground';

export function SnmpConfigForm({
  draft,
  onChange,
  templates,
  templatesError,
  suggestion,
  onUseSuggestion,
  hasStoredCommunity,
  hasStoredAuthPassword,
  hasStoredPrivPassword,
  disabled,
}: {
  draft: SnmpDraft;
  onChange: (patch: Partial<SnmpDraft>) => void;
  templates: SnmpTemplateOption[];
  templatesError: boolean;
  suggestion: TemplateSuggestion | null;
  onUseSuggestion: () => void;
  hasStoredCommunity: boolean;
  hasStoredAuthPassword: boolean;
  hasStoredPrivPassword: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation('devices');

  const storedHint = (testId: string, stored: boolean) =>
    stored ? (
      <span className="ml-1 text-muted-foreground/70" data-testid={testId}>
        {t('networkDeviceDetailPage.settings.monitoring.leaveBlankToKeep')}
      </span>
    ) : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-version">
            {t('networkDeviceDetailPage.settings.monitoring.snmpVersion')}
          </label>
          <select
            id="network-settings-snmp-version"
            data-testid="network-settings-snmp-version"
            value={draft.snmpVersion}
            disabled={disabled}
            onChange={(e) => onChange({ snmpVersion: e.target.value as SnmpVersion })}
            className={FIELD_CLASS}
          >
            <option value="v1">v1</option>
            <option value="v2c">v2c</option>
            <option value="v3">v3</option>
          </select>
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-interval">
            {t('networkDeviceDetailPage.settings.monitoring.pollingInterval')}
          </label>
          <input
            id="network-settings-snmp-interval"
            data-testid="network-settings-snmp-interval"
            type="number"
            min={30}
            max={86400}
            value={draft.pollingInterval}
            disabled={disabled}
            onChange={(e) => onChange({ pollingInterval: Number(e.target.value) })}
            className={FIELD_CLASS}
          />
        </div>
      </div>

      {(draft.snmpVersion === 'v1' || draft.snmpVersion === 'v2c') && (
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-community">
            {t('networkDeviceDetailPage.settings.monitoring.community')}
            {storedHint('network-settings-snmp-community-stored', hasStoredCommunity)}
          </label>
          <input
            id="network-settings-snmp-community"
            data-testid="network-settings-snmp-community"
            type="text"
            autoComplete="off"
            value={draft.community}
            disabled={disabled}
            onChange={(e) => onChange({ community: e.target.value })}
            className={FIELD_CLASS}
          />
        </div>
      )}

      {draft.snmpVersion === 'v3' && (
        <>
          <div>
            <label className={LABEL_CLASS} htmlFor="network-settings-snmp-username">
              {t('networkDeviceDetailPage.settings.monitoring.username')}
            </label>
            <input
              id="network-settings-snmp-username"
              data-testid="network-settings-snmp-username"
              type="text"
              autoComplete="off"
              value={draft.username}
              disabled={disabled}
              onChange={(e) => onChange({ username: e.target.value })}
              className={FIELD_CLASS}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-auth-protocol">
                {t('networkDeviceDetailPage.settings.monitoring.authProtocol')}
              </label>
              <select
                id="network-settings-snmp-auth-protocol"
                data-testid="network-settings-snmp-auth-protocol"
                value={draft.authProtocol}
                disabled={disabled}
                onChange={(e) => onChange({ authProtocol: e.target.value as SnmpAuthProtocol })}
                className={FIELD_CLASS}
              >
                <option value="md5">MD5</option>
                <option value="sha">SHA</option>
                <option value="sha256">SHA-256</option>
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-auth-password">
                {t('networkDeviceDetailPage.settings.monitoring.authPassword')}
                {storedHint('network-settings-snmp-auth-password-stored', hasStoredAuthPassword)}
              </label>
              <input
                id="network-settings-snmp-auth-password"
                data-testid="network-settings-snmp-auth-password"
                type="password"
                autoComplete="new-password"
                value={draft.authPassword}
                disabled={disabled}
                onChange={(e) => onChange({ authPassword: e.target.value })}
                className={FIELD_CLASS}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-priv-protocol">
                {t('networkDeviceDetailPage.settings.monitoring.privacyProtocol')}
              </label>
              <select
                id="network-settings-snmp-priv-protocol"
                data-testid="network-settings-snmp-priv-protocol"
                value={draft.privProtocol}
                disabled={disabled}
                onChange={(e) => onChange({ privProtocol: e.target.value as SnmpPrivProtocol })}
                className={FIELD_CLASS}
              >
                <option value="des">DES</option>
                <option value="aes">AES</option>
                <option value="aes256">AES-256</option>
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="network-settings-snmp-priv-password">
                {t('networkDeviceDetailPage.settings.monitoring.privacyPassword')}
                {storedHint('network-settings-snmp-priv-password-stored', hasStoredPrivPassword)}
              </label>
              <input
                id="network-settings-snmp-priv-password"
                data-testid="network-settings-snmp-priv-password"
                type="password"
                autoComplete="new-password"
                value={draft.privPassword}
                disabled={disabled}
                onChange={(e) => onChange({ privPassword: e.target.value })}
                className={FIELD_CLASS}
              />
            </div>
          </div>
        </>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-port">
            {t('networkDeviceDetailPage.settings.monitoring.port')}
          </label>
          <input
            id="network-settings-snmp-port"
            data-testid="network-settings-snmp-port"
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            disabled={disabled}
            onChange={(e) => onChange({ port: Number(e.target.value) })}
            className={FIELD_CLASS}
          />
        </div>
        <div>
          <label className={LABEL_CLASS} htmlFor="network-settings-snmp-template">
            {t('networkDeviceDetailPage.settings.monitoring.template')}
          </label>
          {templatesError ? (
            <p className="mt-1 text-xs text-warning">
              {t('networkDeviceDetailPage.settings.monitoring.templatesUnavailable')}
            </p>
          ) : (
            <select
              id="network-settings-snmp-template"
              data-testid="network-settings-snmp-template"
              value={draft.templateId}
              disabled={disabled}
              onChange={(e) => onChange({ templateId: e.target.value })}
              className={FIELD_CLASS}
            >
              <option value="">{t('networkDeviceDetailPage.settings.monitoring.noTemplate')}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}{template.vendor ? ` (${template.vendor})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* W03 only. Absent on a pre-W03 API, and the section works without it —
          the whole block simply does not render (spec §16). */}
      {suggestion && (
        <p className="text-xs text-muted-foreground" data-testid="network-settings-snmp-suggestion">
          {t('networkDeviceDetailPage.settings.monitoring.suggestion', {
            template: suggestion.templateName,
            reason: suggestion.reason,
          })}{' '}
          {draft.templateId !== suggestion.templateId && (
            <button
              type="button"
              data-testid="network-settings-snmp-suggestion-apply"
              onClick={onUseSuggestion}
              disabled={disabled}
              className="text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.settings.monitoring.useSuggestion')}
            </button>
          )}
        </p>
      )}

      {/* No template at all is the F2 failure mode: "SNMP monitoring: Enabled"
          while the poller has no OIDs to ask for and says nothing. */}
      {!draft.templateId && !templatesError && (
        <p className="text-xs text-warning" data-testid="network-settings-snmp-no-template-warning">
          {t('networkDeviceDetailPage.settings.monitoring.noTemplateWarning')}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Implement `MonitoringSection.tsx`** — data loading, draft state, and actions:

```tsx
const { putSnmp, patchSnmp, disableMonitoring, deleteCheck } = useNetworkAssetMutations();
const [detail, setDetail] = useState<AssetMonitoringDetail | null>(null);
const [checks, setChecks] = useState<AssetNetworkCheck[]>([]);
const [templates, setTemplates] = useState<SnmpTemplateOption[]>([]);
const [suggestion, setSuggestion] = useState<TemplateSuggestion | null>(null);

const refresh = useCallback(async () => {
  const [detailRes, checksRes, templatesRes, suggestRes] = await Promise.all([
    fetchWithAuth(`/monitoring/assets/${assetId}`),
    fetchWithAuth(`/monitors?assetId=${encodeURIComponent(assetId)}`),
    fetchWithAuth('/snmp/templates'),
    // W03. A pre-W03 API 404s here; that is a "no suggestion", not an error.
    fetchWithAuth(`/monitoring/templates/suggest?assetId=${encodeURIComponent(assetId)}`).catch(() => null),
  ]);

  setDetail(detailRes.ok ? await detailRes.json() : null);
  setDetailError(!detailRes.ok);
  setChecks(checksRes.ok ? asList<AssetNetworkCheck>(await checksRes.json()) : []);
  setChecksError(!checksRes.ok);
  setTemplates(templatesRes.ok ? asList<SnmpTemplateOption>(await templatesRes.json(), 'templates') : []);
  setTemplatesError(!templatesRes.ok);
  setSuggestion(suggestRes?.ok ? ((await suggestRes.json()) ?? null) : null);
}, [assetId]);

// Re-baseline the draft whenever the loaded config changes (first load, a
// save, or a background refresh landing) — but never echo the masked
// credentials the API returns; those inputs stay blank.
useEffect(() => {
  const snmp = detail?.snmpDevice ?? null;
  setDraft({
    snmpVersion: (snmp?.snmpVersion as SnmpVersion) ?? 'v2c',
    community: '',
    username: snmp?.username ?? '',
    authProtocol: 'sha',
    authPassword: '',
    privProtocol: 'aes',
    privPassword: '',
    templateId: snmp?.templateId ?? '',
    pollingInterval: snmp?.pollingInterval ?? 300,
    port: snmp?.port ?? 161,
  });
}, [detail?.snmpDevice?.id, detail?.snmpDevice?.snmpVersion, detail?.snmpDevice?.templateId,
    detail?.snmpDevice?.pollingInterval, detail?.snmpDevice?.port, detail?.snmpDevice?.username]);
```

`handleSave` builds the payload from the draft, omitting blank credential fields, and picks `putSnmp` (no `detail.snmpDevice`) or `patchSnmp`. On success: `await refresh(); await onSaved(); onAnnounce(...)`. On `ActionError` 409: `setConflict(true); await refresh(); resetDraft();`. On 401: return.

Under the form, in order: a **collection summary line** (`network-settings-monitoring-status`) rendering `detail.snmpDevice.lastStatus` — including W01's new `no_template` value, whose copy is "No template assigned, so nothing is being polled" — plus `lastPolled` as `<state> · SNMP <relative time>`; **Pause/Resume** (`network-settings-snmp-pause` / `-resume`); **Disable all monitoring** (`network-settings-monitoring-disable` → `ConfirmDialog` with `confirmTestId="network-settings-monitoring-disable-confirm"`); the **network-check list** (`network-settings-check-<id>` rows with `network-settings-check-remove-<id>`, remove behind a `ConfirmDialog` with `confirmTestId="network-settings-check-remove-confirm"`); and **Add check** (`network-settings-check-add`) mounting `CreateMonitorForm` with `assetId` and `defaultTarget={asset.ip}`, refreshing on `onCreated`.

- [ ] **Step 5: Add the Monitoring i18n keys** to `en/devices.json` (`networkDeviceDetailPage.settings.monitoring.*`), including `collectionStatus.{ok,failing,no_template,no_agent,asset_moved,never_polled,paused,warning,offline,unknown}` and `checkState.{responding,degraded,notResponding,paused,unverified}`.

- [ ] **Step 6: Run green**, then commit (`feat(web/network-device): Monitoring section — SNMP config, pause/disable, checks`).

---

### Task 7: Link section + Danger section

**Files:**
- Modify: `.../settings/LinkSection.tsx`, `.../settings/DangerSection.tsx` (fill the stubs)
- Create: `.../settings/LinkSection.test.tsx`, `.../settings/DangerSection.test.tsx`
- Modify: `.../networkDevice/LinkManuallyControl.tsx` (route its POST through the hook)

**Interfaces:**
```tsx
export function LinkSection(props: {
  asset: DiscoveredAsset;
  assetId: string;
  extras: NetworkAssetExtras;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}): JSX.Element;

export function DangerSection(props: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | Promise<void>;
  onClose: () => void;
  onAnnounce: (message: string) => void;
}): JSX.Element;
```

Decisions:
- `LinkManuallyControl` keeps its own picker UI and inline error, but its POST becomes `useNetworkAssetMutations().link(assetId, deviceId)` — the control keeps surfacing `ActionError.message` inline as it does today (`LinkManuallyControl.tsx:85`), so nothing regresses and the guard goes quiet for that file.
- Delete's typed confirmation uses `ConfirmDialog`'s `children` slot for the input and `confirmDisabled` for the gate. The phrase to type is the asset's display name (`label || hostname || ip`), compared case-insensitively after trimming.
- The Delete confirm body **enumerates what cascades** — read from `discoveryRoutes.delete('/assets/:id')` (`discovery.ts:1671-1731`): the SNMP device rows and all their metrics and alert thresholds, every network check bound to the asset, and the saved topology position.
- After a successful delete the modal closes and the page navigates to `/devices#deviceClass=network` (the asset no longer exists, so staying would render the not-found state).

- **`ConfirmDialog` disables by `aria-disabled`, not `disabled`** (`ConfirmDialog.tsx:142-147`). Every assertion on the typed-confirm gate must read `toHaveAttribute('aria-disabled', 'true')`; `toBeDisabled()` would pass vacuously against a button that is never `disabled`.

- [ ] **Step 1: Write `LinkSection.test.tsx` (failing)**

```tsx
// apps/web/src/components/devices/networkDevice/settings/LinkSection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkSection } from './LinkSection';
import { fetchWithAuth } from '@/stores/auth';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown = { success: true }, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
  linkedDeviceId: null,
};

const props = {
  asset,
  assetId: asset.id,
  extras: { siteId: 'site-1' as string | null },
  onSaved: vi.fn(),
  onAnnounce: vi.fn(),
};

const writes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(res());
  props.onSaved = vi.fn();
  props.onAnnounce = vi.fn();
});

describe('LinkSection — linked asset', () => {
  const linked: DiscoveredAsset = { ...asset, linkedDeviceId: 'dev-9', linkedDeviceName: 'WS-FRONTDESK' };

  it('links to the managed device and labels an auto link "auto-detected"', () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'auto' }} />);

    const link = screen.getByTestId('network-settings-link-device');
    expect(link).toHaveTextContent('Same device as WS-FRONTDESK');
    expect(link.getAttribute('href')).toBe('/devices/dev-9');
    expect(screen.getByTestId('network-settings-link-provenance')).toHaveTextContent('auto-detected');
  });

  it('labels a manual link "set manually"', () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'manual' }} />);
    expect(screen.getByTestId('network-settings-link-provenance')).toHaveTextContent('set manually');
  });

  it('confirms before unlinking, then DELETEs the link and reloads', async () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'manual' }} />);

    fireEvent.click(screen.getByTestId('network-settings-link-unlink'));
    expect(writes()).toHaveLength(0); // opening the dialog must not write

    fireEvent.click(await screen.findByTestId('network-settings-link-unlink-confirm'));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![0]).toBe('/discovery/assets/asset-1/link');
    expect((writes()[0]![1] as RequestInit).method).toBe('DELETE');
    expect(props.onSaved).toHaveBeenCalled();
    expect(props.onAnnounce).toHaveBeenCalledWith('Device unlinked');
  });

  it('issues no request when the unlink confirmation is cancelled', async () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'manual' }} />);

    fireEvent.click(screen.getByTestId('network-settings-link-unlink'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(writes()).toHaveLength(0);
  });

  it('offers no manual-link picker while already linked', () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'auto' }} />);
    expect(screen.queryByTestId('network-detail-link-manually')).not.toBeInTheDocument();
  });
});

describe('LinkSection — unlinked asset', () => {
  it('explains the unlinked state and offers the manual picker', () => {
    render(<LinkSection {...props} />);

    expect(screen.getByText('Not linked to a managed device yet.')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-link-manually')).toBeInTheDocument();
    expect(screen.queryByTestId('network-settings-link-unlink')).not.toBeInTheDocument();
  });

  it('explains suppressed auto-linking only when the asset carries the stamp', () => {
    const { rerender } = render(<LinkSection {...props} />);
    expect(screen.queryByTestId('network-settings-link-suppressed')).not.toBeInTheDocument();

    rerender(<LinkSection {...props} extras={{ siteId: 'site-1', autoLinkSuppressedAt: '2026-09-01T00:00:00.000Z' }} />);
    expect(screen.getByTestId('network-settings-link-suppressed')).toHaveTextContent(/Auto-linking is off/i);
  });

  it('links manually through the mutation hook (POST /discovery/assets/:id/link)', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (!init?.method) return Promise.resolve(res({ data: [{ id: 'dev-9', displayName: 'WS-FRONTDESK', status: 'online' }] }));
      return Promise.resolve(res());
    });
    render(<LinkSection {...props} />);

    fireEvent.click(screen.getByTestId('network-detail-link-manually'));
    fireEvent.change(await screen.findByTestId('network-detail-link-manually-select'), { target: { value: 'dev-9' } });
    fireEvent.click(screen.getByTestId('network-detail-link-manually-submit'));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![0]).toBe('/discovery/assets/asset-1/link');
    expect((writes()[0]![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((writes()[0]![1] as RequestInit).body as string)).toEqual({ deviceId: 'dev-9' });
  });
});
```

- [ ] **Step 2: Write `DangerSection.test.tsx` (failing)**

```tsx
// apps/web/src/components/devices/networkDevice/settings/DangerSection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DangerSection } from './DangerSection';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);
const res = (payload: unknown = { success: true }, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01', label: 'Main Switch',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
};

const props = { asset, assetId: asset.id, onSaved: vi.fn(), onClose: vi.fn(), onAnnounce: vi.fn() };
const lastCall = () => fetchMock.mock.calls.at(-1)!;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(res());
  navigateMock.mockReset();
  props.onSaved = vi.fn();
  props.onClose = vi.fn();
  props.onAnnounce = vi.fn();
});

describe('DangerSection — approval', () => {
  it('hides Approve for an already-approved asset and offers Dismiss', () => {
    render(<DangerSection {...props} />);
    expect(screen.queryByTestId('network-settings-approve')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-settings-dismiss')).toBeInTheDocument();
  });

  it('explains the pending state and PATCHes /approve', async () => {
    render(<DangerSection {...props} asset={{ ...asset, approvalStatus: 'pending' }} />);

    expect(screen.getByTestId('network-settings-approval-explainer'))
      .toHaveTextContent(/nothing is monitored yet/i);

    fireEvent.click(screen.getByTestId('network-settings-approve'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()[0]).toBe('/discovery/assets/asset-1/approve');
    expect((lastCall()[1] as RequestInit).method).toBe('PATCH');
    expect(props.onSaved).toHaveBeenCalled();
  });

  it('explains the dismissed state, offers only Approve, and PATCHes /dismiss from approved', async () => {
    const { rerender } = render(<DangerSection {...props} asset={{ ...asset, approvalStatus: 'dismissed' }} />);
    expect(screen.getByTestId('network-settings-approval-explainer'))
      .toHaveTextContent(/hidden from device lists/i);
    expect(screen.queryByTestId('network-settings-dismiss')).not.toBeInTheDocument();

    rerender(<DangerSection {...props} />);
    fireEvent.click(screen.getByTestId('network-settings-dismiss'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()[0]).toBe('/discovery/assets/asset-1/dismiss');
    expect((lastCall()[1] as RequestInit).method).toBe('PATCH');
  });
});

describe('DangerSection — delete', () => {
  const openConfirm = () => fireEvent.click(screen.getByTestId('network-settings-delete'));

  it('enumerates what the delete cascades before asking', async () => {
    render(<DangerSection {...props} />);
    openConfirm();

    const dialog = await screen.findByTestId('network-settings-delete-dialog');
    expect(dialog).toHaveTextContent(/SNMP polling configuration/i);
    expect(dialog).toHaveTextContent(/collected metrics/i);
    expect(dialog).toHaveTextContent(/network checks/i);
    expect(dialog).toHaveTextContent(/topology/i);
  });

  it('keeps Confirm inert until the display name is typed exactly', async () => {
    render(<DangerSection {...props} />);
    openConfirm();

    const confirm = await screen.findByTestId('network-settings-delete-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    fireEvent.change(screen.getByTestId('network-settings-delete-confirm-input'), { target: { value: 'Main Swi' } });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('arms on a case-insensitive, trimmed match and then DELETEs, closes and navigates away', async () => {
    render(<DangerSection {...props} />);
    openConfirm();

    fireEvent.change(await screen.findByTestId('network-settings-delete-confirm-input'), {
      target: { value: '  main switch  ' },
    });
    const confirm = screen.getByTestId('network-settings-delete-confirm');
    expect(confirm).not.toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()[0]).toBe('/discovery/assets/asset-1');
    expect((lastCall()[1] as RequestInit).method).toBe('DELETE');
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(navigateMock).toHaveBeenCalledWith('/devices#deviceClass=network');
  });

  it('stays put when the delete fails — no close, no navigation', async () => {
    fetchMock.mockResolvedValue(res({ error: 'Access to this site denied' }, 403));
    render(<DangerSection {...props} />);
    openConfirm();

    fireEvent.change(await screen.findByTestId('network-settings-delete-confirm-input'), {
      target: { value: 'Main Switch' },
    });
    fireEvent.click(screen.getByTestId('network-settings-delete-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('falls back to hostname, then IP, for the phrase when there is no display name', async () => {
    render(<DangerSection {...props} asset={{ ...asset, label: null }} />);
    openConfirm();

    fireEvent.change(await screen.findByTestId('network-settings-delete-confirm-input'), {
      target: { value: 'core-sw-01' },
    });
    expect(screen.getByTestId('network-settings-delete-confirm')).not.toHaveAttribute('aria-disabled', 'true');
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/settings/LinkSection.test.tsx \
  src/components/devices/networkDevice/settings/DangerSection.test.tsx
```
Expected: the stubs from Task 4 render no controls, so every `getByTestId` fails.

- [ ] **Step 4: Implement `LinkSection.tsx`**

```tsx
// apps/web/src/components/devices/networkDevice/settings/LinkSection.tsx
// The identity link between this discovered asset and a managed device. The
// device page has been the single link surface since the 2026-08-08
// asset-link-lifecycle decision; W04 moves the CONTROLS off the page body into
// this section so every asset-scoped write sits behind one modal. The page
// keeps the read-only "Same device as X" line, which is status, not an action.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import { isManualLink } from '@/components/discovery/networkTypes';
import type { NetworkAssetExtras } from '../types';
import { LinkManuallyControl } from '../LinkManuallyControl';
import { SettingsSectionShell } from './SettingsSectionShell';
import { useNetworkAssetMutations } from './useNetworkAssetMutations';

export function LinkSection({
  asset,
  assetId,
  extras,
  onSaved,
  onAnnounce,
}: {
  asset: DiscoveredAsset;
  assetId: string;
  extras: NetworkAssetExtras;
  onSaved: () => void | Promise<void>;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  const { unlink } = useNetworkAssetMutations();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  // Unlink works for auto AND manual links (#3261 Task 2): the server stamps
  // auto_link_suppressed_at so the next scan doesn't silently re-create it.
  const handleUnlink = async () => {
    setConfirmOpen(false);
    setUnlinking(true);
    try {
      await unlink(assetId);
      await onSaved();
      onAnnounce(t('networkDeviceDetailPage.toasts.unlinked'));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect owns it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('networkDeviceDetailPage.toasts.unlinkFailed') });
      }
    } finally {
      setUnlinking(false);
    }
  };

  return (
    <SettingsSectionShell
      section="link"
      title={t('networkDeviceDetailPage.settings.sections.link')}
      description={t('networkDeviceDetailPage.settings.link.description')}
    >
      {asset.linkedDeviceId ? (
        <div className="space-y-4 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <a
              href={`/devices/${asset.linkedDeviceId}`}
              data-testid="network-settings-link-device"
              className="text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.sameDeviceAs', {
                name: asset.linkedDeviceName || t('common:states.unknown'),
              })}
            </a>
            <span className="text-xs text-muted-foreground" data-testid="network-settings-link-provenance">
              {isManualLink(asset.linkSource)
                ? t('networkDeviceDetailPage.provenance.manual')
                : t('networkDeviceDetailPage.provenance.auto')}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.settings.link.unlinkHint')}</p>
          <button
            type="button"
            data-testid="network-settings-link-unlink"
            onClick={() => setConfirmOpen(true)}
            disabled={unlinking}
            className="h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {unlinking ? t('networkDeviceDetailPage.unlinking') : t('networkDeviceDetailPage.unlink')}
          </button>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p>{t('networkDeviceDetailPage.notLinked')}</p>
          {extras.autoLinkSuppressedAt && (
            <p className="text-xs text-muted-foreground" data-testid="network-settings-link-suppressed">
              {t('networkDeviceDetailPage.autoLinkSuppressed')}
            </p>
          )}
          {/* Site-scoped on purpose: the link route requires same-org AND
              same-site, so an unscoped list would offer guaranteed 403s. */}
          <LinkManuallyControl assetId={assetId} siteId={extras.siteId ?? null} onLinked={onSaved} />
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void handleUnlink()}
        title={t('networkDeviceDetailPage.confirmUnlink')}
        message={t('networkDeviceDetailPage.confirmUnlinkMessage')}
        confirmLabel={t('networkDeviceDetailPage.unlink')}
        variant="destructive"
        isLoading={unlinking}
        confirmTestId="network-settings-link-unlink-confirm"
      />
    </SettingsSectionShell>
  );
}
```

- [ ] **Step 5: Repoint `LinkManuallyControl.tsx` at the hook**

Only the request changes; the picker, the inline error and the `onLinked` contract stay exactly as they are (`LinkManuallyControl.tsx:64-93`).

```tsx
// at the top, replacing the runAction/fetchWithAuth imports:
import { ActionError } from '../../../lib/runAction';
import { useNetworkAssetMutations } from './settings/useNetworkAssetMutations';

// inside the component:
const { link } = useNetworkAssetMutations();

const handleLink = useCallback(async () => {
  if (!deviceId) return;
  setLinking(true);
  setError(undefined);
  let linked = false;
  try {
    await link(assetId, deviceId);
    linked = true;
    setOpen(false);
    setDeviceId('');
  } catch (err) {
    // runAction already toasted; reuse its message for the inline error so the
    // picker doesn't show a second, different string.
    setError(err instanceof ActionError ? err.message : t('networkDeviceDetailPage.toasts.linkFailed'));
  } finally {
    setLinking(false);
  }
  // The link succeeded and was toasted; a failed refresh afterwards is not a
  // link failure, so it stays outside the try (the picker is already closed).
  if (linked) await Promise.resolve(onLinked()).catch(() => undefined);
}, [deviceId, assetId, link, onLinked, t]);
```
`fetchWithAuth` stays imported for `openPicker`'s device-list **read**; only the POST moves.

- [ ] **Step 6: Implement `DangerSection.tsx`**

```tsx
// apps/web/src/components/devices/networkDevice/settings/DangerSection.tsx
// Approval triage and destructive removal (spec §10 Danger, D9).
//
// Approve/Dismiss live here as well as on Discovery's rows on purpose: spec F7
// found that the "Approved" badge is the ONLY signal on a deep-linked pending
// asset and carries no action, so an operator who arrived from a topology node
// or a saved link had no way to act on it at all.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { ActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';
import { SettingsSectionShell } from './SettingsSectionShell';
import { useNetworkAssetMutations } from './useNetworkAssetMutations';

type PendingAction = 'approve' | 'dismiss' | 'delete';

export function DangerSection({
  asset,
  assetId,
  onSaved,
  onClose,
  onAnnounce,
}: {
  asset: DiscoveredAsset;
  assetId: string;
  onSaved: () => void | Promise<void>;
  onClose: () => void;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  const { approve, dismiss, deleteAsset } = useNetworkAssetMutations();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [typedName, setTypedName] = useState('');

  const displayName = asset.label || asset.hostname || asset.ip;
  // Case-insensitive and trimmed: the gate exists to prove deliberate intent,
  // not to be a typing exam, and a scan-authored name can carry capitals the
  // operator has no reason to reproduce.
  const deleteArmed = typedName.trim().toLowerCase() === displayName.trim().toLowerCase();

  /** Runs a mutation, returns whether it succeeded. Never leaves a silent failure. */
  const run = async (action: PendingAction, fn: () => Promise<void>, fallback: string): Promise<boolean> => {
    setPending(action);
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return false; // auth redirect owns it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
      return false;
    } finally {
      setPending(null);
    }
  };

  const handleApprove = async () => {
    const okResult = await run('approve', () => approve(assetId),
      t('networkDeviceDetailPage.settings.toasts.approveFailed'));
    if (!okResult) return;
    await onSaved();
    onAnnounce(t('networkDeviceDetailPage.settings.toasts.approved'));
  };

  const handleDismiss = async () => {
    const okResult = await run('dismiss', () => dismiss(assetId),
      t('networkDeviceDetailPage.settings.toasts.dismissFailed'));
    if (!okResult) return;
    await onSaved();
    onAnnounce(t('networkDeviceDetailPage.settings.toasts.dismissed'));
  };

  const handleDelete = async () => {
    setConfirmDeleteOpen(false);
    const okResult = await run('delete', () => deleteAsset(assetId),
      t('networkDeviceDetailPage.settings.toasts.assetDeleteFailed'));
    if (!okResult) return;
    onAnnounce(t('networkDeviceDetailPage.settings.toasts.assetDeleted'));
    onClose();
    // The asset is gone; staying would drop the operator on the page's
    // not-found state with no explanation of why.
    void navigateTo('/devices#deviceClass=network');
  };

  const explainerKey =
    asset.approvalStatus === 'pending'
      ? 'networkDeviceDetailPage.settings.danger.pendingExplainer'
      : asset.approvalStatus === 'dismissed'
        ? 'networkDeviceDetailPage.settings.danger.dismissedExplainer'
        : 'networkDeviceDetailPage.settings.danger.approvedExplainer';

  return (
    <SettingsSectionShell
      section="danger"
      title={t('networkDeviceDetailPage.settings.sections.danger')}
      description={t('networkDeviceDetailPage.settings.danger.description')}
    >
      <div className="space-y-6 text-sm">
        <div className="rounded-md border p-4">
          <h4 className="text-sm font-medium">{t('networkDeviceDetailPage.settings.danger.approvalTitle')}</h4>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="network-settings-approval-explainer">
            {t(/* i18n-dynamic */ explainerKey)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {asset.approvalStatus !== 'approved' && (
              <button
                type="button"
                data-testid="network-settings-approve"
                onClick={() => void handleApprove()}
                disabled={pending !== null}
                className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {pending === 'approve'
                  ? t('common:states.saving')
                  : t('networkDeviceDetailPage.settings.danger.approve')}
              </button>
            )}
            {asset.approvalStatus !== 'dismissed' && (
              <button
                type="button"
                data-testid="network-settings-dismiss"
                onClick={() => void handleDismiss()}
                disabled={pending !== null}
                className="h-8 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {pending === 'dismiss'
                  ? t('common:states.saving')
                  : t('networkDeviceDetailPage.settings.danger.dismiss')}
              </button>
            )}
          </div>
        </div>

        <div className="rounded-md border border-destructive/40 p-4">
          <h4 className="text-sm font-medium text-destructive">
            {t('networkDeviceDetailPage.settings.danger.deleteTitle')}
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('networkDeviceDetailPage.settings.danger.deleteDescription')}
          </p>
          <button
            type="button"
            data-testid="network-settings-delete"
            onClick={() => { setTypedName(''); setConfirmDeleteOpen(true); }}
            disabled={pending !== null}
            className="mt-3 h-8 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.settings.danger.deleteAsset')}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteOpen}
        onClose={() => setConfirmDeleteOpen(false)}
        onConfirm={() => void handleDelete()}
        title={t('networkDeviceDetailPage.settings.danger.deleteConfirmTitle')}
        message={t('networkDeviceDetailPage.settings.danger.deleteConfirmMessage', { name: displayName })}
        confirmLabel={t('networkDeviceDetailPage.settings.danger.deleteAsset')}
        variant="destructive"
        isLoading={pending === 'delete'}
        confirmDisabled={!deleteArmed}
        confirmTestId="network-settings-delete-confirm"
        dialogTestId="network-settings-delete-dialog"
      >
        <div className="space-y-3">
          {/* Enumerated from the route's own transaction
              (routes/discovery.ts:1671-1731) — this is what actually goes. */}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.snmp')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.metrics')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.thresholds')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.checks')}</li>
            <li>{t('networkDeviceDetailPage.settings.danger.cascade.topology')}</li>
          </ul>
          <div>
            <label
              htmlFor="network-settings-delete-confirm-input"
              className="block text-xs font-medium text-muted-foreground"
            >
              {t('networkDeviceDetailPage.settings.danger.deleteConfirmPrompt', { name: displayName })}
            </label>
            <input
              id="network-settings-delete-confirm-input"
              data-testid="network-settings-delete-confirm-input"
              type="text"
              value={typedName}
              autoComplete="off"
              onChange={(e) => setTypedName(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>
      </ConfirmDialog>
    </SettingsSectionShell>
  );
}
```

- [ ] **Step 7: Add the Link/Danger i18n keys** to `en/devices.json` under `networkDeviceDetailPage.settings`:

```json
"link": {
  "description": "Tie this discovered asset to the managed device that is the same machine.",
  "unlinkHint": "Unlinking also stops auto-linking from re-creating this link on the next scan."
},
"danger": {
  "description": "Approval state and permanent removal.",
  "approvalTitle": "Approval",
  "approvedExplainer": "This asset is approved and appears in device lists.",
  "pendingExplainer": "Pending approval: nothing is monitored yet.",
  "dismissedExplainer": "Dismissed: hidden from device lists.",
  "approve": "Approve",
  "dismiss": "Dismiss",
  "deleteTitle": "Delete asset",
  "deleteDescription": "Removes the asset and everything collected for it. Discovery will re-create it on the next scan if the device is still on the network.",
  "deleteAsset": "Delete asset",
  "deleteConfirmTitle": "Delete this asset?",
  "deleteConfirmMessage": "\"{{name}}\" and everything below will be removed. This cannot be undone.",
  "deleteConfirmPrompt": "Type {{name}} to confirm",
  "cascade": {
    "snmp": "Its SNMP polling configuration",
    "metrics": "All collected metrics",
    "thresholds": "Its SNMP alert thresholds",
    "checks": "Every network check bound to this asset",
    "topology": "Its saved position on the topology map"
  }
}
```

- [ ] **Step 8: Run green**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/settings/LinkSection.test.tsx \
  src/components/devices/networkDevice/settings/DangerSection.test.tsx
```
Expected: 2 files, 15 tests passing.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/devices/networkDevice apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): Link and Danger sections of the asset settings modal

W04 Task 7. Unlink and manual link move off the page body; Approve/Dismiss get
an action next to the badge that spec F7 found was signal-only; Delete is gated
on typing the asset name and states what the route's transaction actually
removes. LinkManuallyControl's POST now goes through the mutation hook.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Wire the modal into the page; header Settings button

**Files:**
- Modify: `apps/web/src/components/devices/networkDevice/NetworkDeviceHeader.tsx`
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx`
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx`

What changes on the page:
1. Second hash state:
   ```tsx
   const [activeTab, setActiveTab] = useHashState<Tab>('overview', (h) => parseDetailHash(h).tab);
   const [settingsSection, setSettingsSection] = useHashState<SettingsSection | null>(
     null, (h) => parseDetailHash(h).settings,
   );
   const goTo = (tab: Tab, section: SettingsSection | null) => {
     window.location.hash = buildDetailHash(tab, section);
     setActiveTab(tab);
     setSettingsSection(section);
   };
   ```
   `switchTab(tab)` becomes `goTo(tab, null)`; `openSettings(section)` is `goTo(activeTab, section)`; `closeSettings()` is `goTo(activeTab, null)`.
   (`useHashState`'s parser returning `null` is honoured — only `undefined` falls back to the default — so a tab-only hash closes the modal.)
2. `NetworkDeviceHeader` gains `onOpenSettings: () => void`, renders a **Settings** button (`data-testid="network-detail-settings"`) beside Open Web UI, and **loses** the "Manage in Discovery" link and its `manageInDiscovery` key usage (the page owns the asset now — spec §11).
3. The Overview Identity card's inline type editor (select, Save/Cancel, Reset, `pendingEdit`/`typeAction` state and the three handlers, `NetworkDeviceDetailPage.tsx:83-195` and `:320-381`) is **deleted**. The card renders the type as text plus the existing `manuallySet` / `manuallySetWithDetected` provenance line, and an "Edit in settings" button (`network-detail-edit-identity`) that calls `openSettings('identity')`.
4. The Monitoring tab's **Unlink button and `LinkManuallyControl`** are removed (they live in the Link section now); the read-only "Same device as X" link, the provenance label and the suppressed-auto-link line stay, followed by a `network-detail-edit-link` button that opens `openSettings('link')`. `handleUnlink`, `unlinking`, `confirmUnlinkOpen` and the page-level `ConfirmDialog` go with it.
5. The Monitoring tab's "Configure … from the discovery asset view" footer link is replaced by `network-detail-edit-monitoring` → `openSettings('monitoring')`.
6. `<NetworkAssetSettingsModal …>` is mounted at the bottom, with `onSaved={() => fetchAsset({ background: true })}` (background, so the page never flashes the skeleton mid-save — the reason the existing handlers already pass it).

- [ ] **Step 1: Migrate the existing tests first.** Move — do not delete — these cases out of `NetworkDeviceDetailPage.test.tsx` into the section suites, adapting the selectors:
  - type-editor cases (`:534-763`, six `it`s) → `IdentitySection.test.tsx` (most are already covered by Task 5; keep any case Task 5 does not cover, e.g. "disables the select while a Save is in flight").
  - unlink cases (`:415-513`, three `it`s) → `LinkSection.test.tsx`.
  - `points the "Manage in Discovery" link at the discovery asset deep-link` (`:783`) → **delete**, and add its inverse: the link is gone.

- [ ] **Step 2: Add the new page cases (red first)**

```tsx
it('opens the settings modal from the header button and writes the hash', async () => {
  fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }));
  render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
  await screen.findByTestId('network-device-detail');

  fireEvent.click(screen.getByTestId('network-detail-settings'));

  expect(await screen.findByTestId('network-asset-settings-modal')).toBeInTheDocument();
  expect(window.location.hash).toBe('#overview/settings/identity');
});

it('opens straight to a section from a deep link', async () => {
  window.location.hash = '#overview/settings/monitoring';
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
  render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);

  expect(await screen.findByTestId('network-settings-panel-monitoring')).toBeInTheDocument();
});

it('closing the modal rewrites the hash back to the bare tab', async () => {
  window.location.hash = '#monitoring/settings/link';
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
  render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
  await screen.findByTestId('network-asset-settings-modal');

  fireEvent.keyDown(document, { key: 'Escape' });

  await waitFor(() => expect(window.location.hash).toBe('#monitoring'));
  expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument();
});

it('a browser back to a tab-only hash closes the modal', async () => {
  window.location.hash = '#overview/settings/danger';
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
  render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
  await screen.findByTestId('network-asset-settings-modal');

  window.location.hash = '#overview';
  fireEvent(window, new HashChangeEvent('hashchange'));

  await waitFor(() => expect(screen.queryByTestId('network-asset-settings-modal')).not.toBeInTheDocument());
});

it('no longer edits the type inline and no longer links out to Discovery', async () => {
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: baseAsset }));
  render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
  await screen.findByTestId('network-device-detail');

  expect(screen.queryByTestId('network-asset-type-select')).not.toBeInTheDocument();
  expect(screen.queryByTestId('network-detail-manage-discovery')).not.toBeInTheDocument();
  expect(screen.getByTestId('network-detail-edit-identity')).toBeInTheDocument();
});
```

- [ ] **Step 3: Implement the header change**

In `NetworkDeviceHeader.tsx`: add `onOpenSettings` to the props, import `Settings` from `lucide-react`, drop `ChevronRight`, and replace the whole action block (`NetworkDeviceHeader.tsx:100-124`, including the stale "Approve / reclassify remain in Discovery until slice 3" comment) with:

```tsx
        {/* The device page owns this asset now (spec §10, D7): Settings is the
            one way in, and the old "Manage in Discovery" hand-off is gone —
            Discovery links HERE, not the other way round. */}
        <div className="flex items-center gap-2">
          <ProxyConnectPopover
            variant="header"
            assetId={asset.id}
            assetIp={asset.ip}
            port={defaultWebPort?.port ?? 443}
            service={defaultWebPort?.service}
            suggestedBridgeDeviceId={suggestedBridgeDeviceId}
            devices={devices}
            devicesError={devicesError}
            onRetryDevices={onRetryDevices}
            onAnnounce={onAnnounce}
          />
          <button
            type="button"
            data-testid="network-detail-settings"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
            {t('networkDeviceDetailPage.header.settings')}
          </button>
        </div>
```

- [ ] **Step 4: Implement the page wiring**

`NetworkDeviceDetailPage.tsx`, in order:

```tsx
// imports: drop ConfirmDialog, LinkManuallyControl and isManualLink's unlink
// usage stays for the read-only provenance label; add:
import { NetworkAssetSettingsModal } from './networkDevice/settings/NetworkAssetSettingsModal';
import { buildDetailHash, parseDetailHash, type SettingsSection } from './networkDevice/settings/settingsHash';

// --- hash state -----------------------------------------------------------
// Both halves of `#<tab>[/settings/<section>]` are hash-derived and adopted
// post-mount (#2421). `parse` returning null is honoured by useHashState —
// only `undefined` falls back to the default — so a tab-only hash is what
// CLOSES the modal, which is what makes browser Back close it too.
const [activeTab, setActiveTab] = useHashState<Tab>('overview', (h) => parseDetailHash(h).tab);
const [settingsSection, setSettingsSection] = useHashState<SettingsSection | null>(
  null,
  (h) => parseDetailHash(h).settings,
);

const goTo = useCallback((tab: Tab, section: SettingsSection | null) => {
  window.location.hash = buildDetailHash(tab, section);
  setActiveTab(tab);
  setSettingsSection(section);
}, [setActiveTab, setSettingsSection]);

const switchTab = useCallback((tab: Tab) => goTo(tab, null), [goTo]);
const openSettings = useCallback((section: SettingsSection) => goTo(activeTab, section), [goTo, activeTab]);
const closeSettings = useCallback(() => goTo(activeTab, null), [goTo, activeTab]);
```

Delete outright: `unlinking`, `confirmUnlinkOpen`, `typeAction`, `typeSaving`, `pendingEdit`, the `useEffect` that discards a stale pending edit, `handleUnlink`, `changeType`, `handleResetType`, `handleSaveType`, `handleCancelType`, `selectedType`, `typeDirty` (`NetworkDeviceDetailPage.tsx:83-106` and `:108-195`, `:250-253`), and the page-level `<ConfirmDialog>` (`:509-522`).

Header call site gains one prop:
```tsx
      <NetworkDeviceHeader
        asset={asset}
        /* …unchanged props… */
        onAnnounce={announce}
        onOpenSettings={() => openSettings('identity')}
      />
```

Identity card: replace the whole `<div>` holding the type select (`:320-381`) with a read-only field plus a hand-off:
```tsx
                <div>
                  <div className="text-xs font-medium text-muted-foreground">
                    {t('networkDeviceDetailPage.fields.assetType')}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="font-medium">{typeLabel}</span>
                    <button
                      type="button"
                      data-testid="network-detail-edit-identity"
                      onClick={() => openSettings('identity')}
                      className="text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('networkDeviceDetailPage.editInSettings')}
                    </button>
                  </div>
                  {asset.typeSource === 'manual' && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {asset.detectedType
                        ? t('networkDeviceDetailPage.manuallySetWithDetected', {
                            type: t(/* i18n-dynamic */ typeConfig[asset.detectedType].labelKey),
                          })
                        : t('networkDeviceDetailPage.manuallySet')}
                    </p>
                  )}
                </div>
```

Monitoring tab, monitoring-status card footer (`:443-448`) becomes:
```tsx
            <button
              type="button"
              data-testid="network-detail-edit-monitoring"
              onClick={() => openSettings('monitoring')}
              className="mt-3 border-t pt-3 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.settings.openMonitoringSettings')}
            </button>
```

Monitoring tab, "Linked device" field (`:453-498`) keeps the read-only branches and swaps both action controls for one hand-off:
```tsx
              <Field
                label={t('networkDeviceDetailPage.fields.linkedDevice')}
                value={
                  <div className="space-y-1.5">
                    {asset.linkedDeviceId ? (
                      <span className="flex flex-wrap items-center gap-3">
                        <a
                          href={`/devices/${asset.linkedDeviceId}`}
                          data-testid="network-detail-linked-device"
                          className="text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {t('networkDeviceDetailPage.sameDeviceAs', {
                            name: asset.linkedDeviceName || t('common:states.unknown'),
                          })}
                        </a>
                        <span className="text-xs text-muted-foreground" data-testid="network-detail-link-provenance">
                          {isManualLink(asset.linkSource)
                            ? t('networkDeviceDetailPage.provenance.manual')
                            : t('networkDeviceDetailPage.provenance.auto')}
                        </span>
                      </span>
                    ) : (
                      <>
                        <p>{t('networkDeviceDetailPage.notLinked')}</p>
                        {extras.autoLinkSuppressedAt && (
                          <p className="text-xs text-muted-foreground" data-testid="network-detail-suppressed">
                            {t('networkDeviceDetailPage.autoLinkSuppressed')}
                          </p>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      data-testid="network-detail-edit-link"
                      onClick={() => openSettings('link')}
                      className="text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('networkDeviceDetailPage.settings.openLinkSettings')}
                    </button>
                  </div>
                }
              />
```

Mount the modal where the `ConfirmDialog` used to be, last child of the page root:
```tsx
      <NetworkAssetSettingsModal
        open={settingsSection !== null}
        section={settingsSection}
        assetId={asset.id}
        asset={asset}
        extras={extras}
        onSectionChange={(section) => openSettings(section)}
        onClose={closeSettings}
        // `background: true`: a save must not flip `loading` and swap the whole
        // page for the skeleton under an open modal.
        onSaved={() => fetchAsset({ background: true })}
        onAnnounce={announce}
      />
```

- [ ] **Step 5: Run**

```bash
cd apps/web && npx vitest run \
  src/components/devices/NetworkDeviceDetailPage.test.tsx \
  src/components/devices/networkDevice \
  src/lib/__tests__/network-asset-single-writer.test.ts
```
The single-writer guard should now name five files: `DiscoveredAssetList`, `AssetDetailModal`, `AssetMonitoringSection`, `EnableMonitoringForm`, `MonitoringAssetsDashboard`. `NetworkDeviceDetailPage` and `LinkManuallyControl` have left the list.

- [ ] **Step 6: Add the page's new i18n keys** to `en/devices.json`: `networkDeviceDetailPage.header.settings` ("Settings"), `networkDeviceDetailPage.editInSettings` ("Edit in settings"), `networkDeviceDetailPage.settings.openMonitoringSettings` ("Edit monitoring settings"), `networkDeviceDetailPage.settings.openLinkSettings` ("Manage this link").

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): the device page owns the asset — Settings button + modal wiring

W04 Task 8. Second hash state for the settings section; header Settings button
replaces the "Manage in Discovery" hand-off; the inline type editor, the unlink
flow and the manual-link picker move into the modal's sections. The page's
remaining identity/link/monitoring copy is read-only status with a hand-off.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Discovery — row "Settings…" and the read-only peek

**Files:**
- Modify: `apps/web/src/components/discovery/DiscoveredAssetList.tsx`, `DiscoveredAssetList.test.tsx`
- Modify: `apps/web/src/components/discovery/AssetDetailModal.tsx`, `AssetDetailModal.test.tsx`
- **Delete:** `apps/web/src/components/discovery/AssetMonitoringSection.tsx`, `apps/web/src/components/discovery/EnableMonitoringForm.tsx`

Changes:
1. `DiscoveredAssetList.renderActions` gains a **Settings…** control (`data-testid={`discovered-asset-settings-${asset.id}`}`, `title` from `discovery:discoveredAssetList.actions.settings`) that calls `navigateTo(`/devices/network/${asset.id}${'#'}overview/settings/monitoring`)` — spec §10 names the monitoring section for this entry point because that is what the row's Monitored badge refers to.
2. Approve / Dismiss (single-row) route through `useNetworkAssetMutations().approve|dismiss`, then `fetchAssets()`. The inline `setError` path for those two goes away — `runAction` toasts. Bulk approve/dismiss are untouched.
3. `AssetDetailModal` becomes read-only: keep the header badges, `ip · mac · manufacturer`, a reachability line, the open-ports chips and the SNMP data grid; **delete** the Asset Info form (name/type/notes/tags/Save/Reset), the delete row, and the `<AssetMonitoringSection>` mount. Footer gets `asset-modal-open-device-page` (`/devices/network/:id`) and `asset-modal-settings` (`/devices/network/:id#overview/settings/identity` — the peek is the identity view, so the peek's Settings… lands on Identity while the row's lands on Monitoring).
4. The reachability line uses `asset.reachability` when the API supplies it (W01) and otherwise falls back to `Last seen · scan <relative time>` — never a bare "Online" (spec §10 copy rule).
5. Delete both retired components and their `discovery.json` key blocks.

- [ ] **Step 1: Write the `DiscoveredAssetList` tests (failing)**

Append to `apps/web/src/components/discovery/DiscoveredAssetList.test.tsx`. The file already mocks `@/stores/auth` and has a `jsonResponse` helper; widen its Testing Library import to `{ render, screen, fireEvent, waitFor }` and add the navigation mock at the top:

```tsx
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
// …with the other imports:
import { navigateTo } from '@/lib/navigation';
const navigateMock = vi.mocked(navigateTo);

describe('DiscoveredAssetList — settings hand-off and hook-routed triage (W04)', () => {
  const listAsset: ApiDiscoveryAsset = {
    ...apiAsset,
    id: 'asset-7',
    approvalStatus: 'pending',
  };

  beforeEach(() => {
    fetchMock.mockReset();
    navigateMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ data: [listAsset] }));
  });

  it('opens the device page on the Monitoring section from the row action', async () => {
    render(<DiscoveredAssetList />);
    const button = await screen.findByTestId('discovered-asset-settings-asset-7');

    fireEvent.click(button);

    expect(navigateMock).toHaveBeenCalledWith('/devices/network/asset-7#overview/settings/monitoring');
  });

  it('does not open the peek modal when the settings action is clicked', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click(await screen.findByTestId('discovered-asset-settings-asset-7'));

    expect(screen.queryByTestId('asset-modal-open-device-page')).not.toBeInTheDocument();
  });

  it('approves through the mutation hook and refetches the list', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click(await screen.findByTestId('discovered-asset-approve-asset-7'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) =>
        url === '/discovery/assets/asset-7/approve' && (init as RequestInit)?.method === 'PATCH')).toBe(true),
    );
    // One list load on mount, the PATCH, then the reload.
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => url === '/discovery/assets').length).toBe(2),
    );
  });

  it('dismisses through the mutation hook', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click(await screen.findByTestId('discovered-asset-dismiss-asset-7'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) =>
        url === '/discovery/assets/asset-7/dismiss' && (init as RequestInit)?.method === 'PATCH')).toBe(true),
    );
  });

  it('still bulk-approves through the list-level endpoint (deliberately not the hook)', async () => {
    render(<DiscoveredAssetList />);
    fireEvent.click(await screen.findByLabelText('Select all visible assets'));
    fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/discovery/assets/bulk-approve')).toBe(true),
    );
  });
});
```

- [ ] **Step 2: Rewrite the `AssetDetailModal` tests (failing)**

Delete these describes from `AssetDetailModal.test.tsx`: *"editable device type (#1424)"*, *"server error surfaced on save/reset (#1424)"*, and the delete assertions. Keep *"read-only link state (#3261)"* and *"SNMP data card"* unchanged. Replace the proxy describe with the new hand-off one, and add the peek describes:

```tsx
describe('AssetDetailModal — read-only peek (W04)', () => {
  it('renders no editable control at all', () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
    expect(document.querySelectorAll('select')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-modal-type-select')).not.toBeInTheDocument();
    expect(screen.queryByTestId('asset-modal-type-reset')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete Asset/i })).not.toBeInTheDocument();
  });

  it('issues no mutating request on mount or on any click', async () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    await waitFor(() => expect(true).toBe(true));

    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method)).toEqual([]);
  });

  it('hands off to the device page and to its settings modal', () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);

    expect(screen.getByTestId('asset-modal-open-device-page').getAttribute('href'))
      .toBe('/devices/network/asset-1');
    expect(screen.getByTestId('asset-modal-settings').getAttribute('href'))
      .toBe('/devices/network/asset-1#overview/settings/identity');
  });

  it('no longer mounts the monitoring section (no /monitoring or /monitors fetch)', async () => {
    render(<AssetDetailModal open asset={asset} onClose={() => {}} />);
    await waitFor(() => expect(true).toBe(true));

    expect(fetchMock.mock.calls.some(([url]) =>
      typeof url === 'string' && (url.startsWith('/monitoring') || url.startsWith('/monitors')))).toBe(false);
  });
});

describe('AssetDetailModal — reachability line never says a bare "Online"', () => {
  it('names the source and the age when the API supplies reachability (W01)', () => {
    render(
      <AssetDetailModal
        open
        asset={{
          ...asset,
          reachability: {
            state: 'responding',
            source: 'snmp',
            observedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
            lastKnown: null,
          },
        }}
        onClose={() => {}}
      />,
    );

    const line = screen.getByTestId('asset-modal-reachability');
    expect(line.textContent).toMatch(/Responding · SNMP/);
    expect(line.textContent).not.toBe('Online');
  });

  it('falls back to the scan sighting on a pre-W01 API, still sourced', () => {
    render(
      <AssetDetailModal
        open
        asset={{ ...asset, lastSeen: new Date(Date.now() - 19 * 3600_000).toISOString() }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('asset-modal-reachability').textContent).toMatch(/Last seen · scan/);
  });

  it('renders an explicit unknown when there is nothing to source', () => {
    render(<AssetDetailModal open asset={{ ...asset, lastSeen: undefined }} onClose={() => {}} />);

    const line = screen.getByTestId('asset-modal-reachability');
    expect(line).toHaveTextContent('—');
    expect(line).toHaveAttribute('aria-label', 'unknown');
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

```bash
cd apps/web && npx vitest run src/components/discovery/DiscoveredAssetList.test.tsx src/components/discovery/AssetDetailModal.test.tsx
```

- [ ] **Step 4: Implement the `DiscoveredAssetList` changes**

```tsx
// new imports
import { navigateTo } from '@/lib/navigation';
import { ActionError } from '@/lib/runAction';
import { useNetworkAssetMutations } from '../devices/networkDevice/settings/useNetworkAssetMutations';
import { Settings } from 'lucide-react';

// inside the component, next to the other hooks:
const { approve, dismiss } = useNetworkAssetMutations();

// replace handleApprove / handleDismiss (DiscoveredAssetList.tsx:336-364) with:
// Triage stays on the Discovery rows (spec §10) but the WRITE goes through the
// single writer, so the outcome is a toast instead of a banner the operator has
// to scroll back up to see.
const handleApprove = async (asset: DiscoveredAsset) => {
  try {
    await approve(asset.id);
    await fetchAssets();
  } catch (err) {
    if (err instanceof ActionError) return; // 401 redirects; anything else was toasted
    setError(t('discoveredAssetList.errors.generic'));
  }
};

const handleDismiss = async (asset: DiscoveredAsset) => {
  try {
    await dismiss(asset.id);
    await fetchAssets();
  } catch (err) {
    if (err instanceof ActionError) return;
    setError(t('discoveredAssetList.errors.generic'));
  }
};

// replace renderActions (:516-556) with:
const renderActions = (asset: DiscoveredAsset) => (
  <div className="flex items-center justify-end gap-2">
    <button
      type="button"
      onClick={event => {
        event.stopPropagation();
        setSelectedAsset(toDetail(asset));
      }}
      className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
      title={t('discoveredAssetList.actions.viewDetails')}
    >
      <Info className="h-4 w-4" />
    </button>
    {/* Configuration lives on the device page (spec §10, D7). The row opens the
        Monitoring section because that is what the row's "Monitored" badge is
        about; the peek's own Settings… opens Identity. */}
    <button
      type="button"
      data-testid={`discovered-asset-settings-${asset.id}`}
      onClick={event => {
        event.stopPropagation();
        void navigateTo(`/devices/network/${asset.id}#overview/settings/monitoring`);
      }}
      className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
      title={t('discoveredAssetList.actions.settings')}
    >
      <Settings className="h-4 w-4" />
    </button>
    {asset.approvalStatus !== 'approved' && (
      <button
        type="button"
        data-testid={`discovered-asset-approve-${asset.id}`}
        onClick={event => { event.stopPropagation(); void handleApprove(asset); }}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-green-500/40 text-green-700 hover:bg-green-500/10"
        title={t('discoveredAssetList.actions.approve')}
      >
        <CheckCircle2 className="h-4 w-4" />
      </button>
    )}
    {asset.approvalStatus !== 'dismissed' && (
      <button
        type="button"
        data-testid={`discovered-asset-dismiss-${asset.id}`}
        onClick={event => { event.stopPropagation(); void handleDismiss(asset); }}
        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
        title={t('discoveredAssetList.actions.dismiss')}
      >
        <XCircle className="h-4 w-4" />
      </button>
    )}
  </div>
);
```
`handleBulkApprove` / `handleBulkDismiss` and the `AssetDetailModal` mount are untouched, except that `onUpdated` can go — the peek no longer updates anything.

- [ ] **Step 5: Implement the reduced `AssetDetailModal` — the whole new file**

```tsx
// apps/web/src/components/discovery/AssetDetailModal.tsx
// A READ-ONLY peek at a discovered asset (spec §10, D7).
//
// Everything that writes the asset moved to the device page's
// NetworkAssetSettingsModal — before W04 this modal, EnableMonitoringForm and
// the monitoring dashboard's EditMonitoringModal each edited the same object
// with a different form idiom, and this one reported failure into an inline
// banner below the fold. What remains is the question a click on a list row or
// a topology node actually asks ("what is this?") plus two hand-offs.

import { ExternalLink, Globe, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { DiscoveredAsset, OpenPortEntry } from './DiscoveredAssetList';
import { typeConfig, approvalStatusConfig } from './DiscoveredAssetList';
import { Dialog } from '../shared/Dialog';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatLastSeen } from '@/lib/formatTime';
import { formatNumber } from '@/lib/i18n/format';
import type { DiscoveredAssetLinkSource } from './networkTypes';

/** W01 (spec §4.2). Absent on a pre-W01 API, so every read of it is optional. */
export type AssetReachability = {
  state: 'responding' | 'not_responding' | 'unverified';
  source: 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp' | null;
  observedAt: string | null;
  lastKnown?: { state: 'responding' | 'not_responding'; source: string; observedAt: string } | null;
};

export type AssetDetail = DiscoveredAsset & {
  openPorts?: OpenPortEntry[];
  osFingerprint?: string;
  snmpData?: Record<string, string>;
  linkedDeviceId?: string | null;
  linkSource?: DiscoveredAssetLinkSource | null;
  label?: string | null;
  notes?: string | null;
  tags?: string[];
  reachability?: AssetReachability | null;
};

// Friendly labels for the scalar SNMP system OIDs the discovery scan collects.
const SNMP_FIELD_LABEL_KEYS: Record<string, string> = {
  sysName: 'assetDetailModal.snmpFields.systemName',
  sysDescr: 'common:labels.description',
  sysObjectId: 'assetDetailModal.snmpFields.objectId',
};

function snmpFieldLabel(key: string, t: (key: string) => string): string {
  return SNMP_FIELD_LABEL_KEYS[key] ? t(/* i18n-dynamic */ SNMP_FIELD_LABEL_KEYS[key]) : key;
}

const REACHABILITY_STATE_KEYS: Record<AssetReachability['state'], string> = {
  responding: 'assetDetailModal.peek.state.responding',
  not_responding: 'assetDetailModal.peek.state.notResponding',
  unverified: 'assetDetailModal.peek.state.unverified',
};

const REACHABILITY_SOURCE_KEYS: Record<string, string> = {
  network_check: 'assetDetailModal.peek.source.networkCheck',
  probe: 'assetDetailModal.peek.source.probe',
  scan: 'assetDetailModal.peek.source.scan',
  unifi: 'assetDetailModal.peek.source.unifi',
  snmp: 'assetDetailModal.peek.source.snmp',
};

/**
 * `<state> · <source> <relative time>` — the spec §10 copy rule. A bare
 * "Online" is exactly what this whole spec exists to remove: it read as live
 * health when it was a 19-hour-old subnet sweep.
 *
 * Returns null when there is nothing sourced to say, so the caller can render
 * an explicit unknown rather than inventing one.
 */
export function reachabilityLine(
  asset: AssetDetail,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const reachability = asset.reachability;
  if (reachability?.source && reachability.observedAt) {
    return t('assetDetailModal.peek.reachabilityLine', {
      state: t(/* i18n-dynamic */ REACHABILITY_STATE_KEYS[reachability.state]),
      source: t(/* i18n-dynamic */ REACHABILITY_SOURCE_KEYS[reachability.source] ?? REACHABILITY_SOURCE_KEYS.scan),
      age: formatLastSeen(reachability.observedAt),
    });
  }
  // Pre-W01 API (or an asset nothing has ever observed): the only evidence is
  // the scan's own sighting, and we say so instead of calling it "Online".
  if (asset.lastSeen) {
    return t('assetDetailModal.peek.lastSeenLine', {
      source: t('assetDetailModal.peek.source.scan'),
      age: formatLastSeen(asset.lastSeen),
    });
  }
  return null;
}

type AssetDetailModalProps = {
  open: boolean;
  asset?: AssetDetail | null;
  /** While the detail is being fetched (topology click / deep link). */
  loading?: boolean;
  onClose: () => void;
};

export default function AssetDetailModal({ open, asset, loading = false, onClose }: AssetDetailModalProps) {
  const { t } = useTranslation('discovery');

  // No asset record yet: never render nothing while open, or a node click looks
  // like it did nothing. Loading, then a graceful not-found state (#1728).
  if (!asset) {
    if (!open) return null;
    return (
      <Dialog open={open} onClose={onClose} title={t('assetDetailModal.deviceDetailsTitle')} maxWidth="md">
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          {loading ? (
            <>
              <div className="h-7 w-7 animate-spin rounded-full border-[3px] border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">{t('assetDetailModal.loadingDetails')}</p>
            </>
          ) : (
            <>
              <Globe className="h-7 w-7 text-muted-foreground/60" aria-hidden />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('assetDetailModal.detailsUnavailableTitle')}</p>
                <p className="text-sm text-muted-foreground">{t('assetDetailModal.detailsUnavailableDescription')}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="mt-1 rounded-md border px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-muted"
              >
                {t('common:actions.close')}
              </button>
            </>
          )}
        </div>
      </Dialog>
    );
  }

  const openPorts = asset.openPorts ?? [];
  const osFingerprint = asset.osFingerprint ?? '—';
  const snmpData = asset.snmpData ?? {};
  const tags = asset.tags ?? [];
  const displayName = asset.label || asset.hostname || asset.ip;
  const reachability = reachabilityLine(asset, t);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={displayName}
      maxWidth="3xl"
      alignTop
      className="flex flex-col max-h-[calc(100vh-4rem)]"
    >
      <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{displayName}</h2>
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeConfig[asset.type].color}`}>
              {t(/* i18n-dynamic */ typeConfig[asset.type].labelKey)}
            </span>
            {asset.approvalStatus !== 'approved' && (
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalStatusConfig[asset.approvalStatus].color}`}>
                {t(/* i18n-dynamic */ approvalStatusConfig[asset.approvalStatus].labelKey)}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {asset.ip}
            {asset.mac !== '—' && <> • {asset.mac}</>}
            {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
          </p>
          {/* Spec §10 copy rule: state · source · age, never a bare "Online". */}
          <p
            className="mt-1 text-sm"
            data-testid="asset-modal-reachability"
            aria-label={reachability ? undefined : t('common:states.unknown').toLowerCase()}
            title={asset.lastSeen ? formatDateTime(asset.lastSeen) : undefined}
          >
            {reachability ?? '—'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {t('common:actions.close')}
        </button>
      </div>

      <div className="overflow-y-auto px-6 py-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.networkDetailsTitle')}</h3>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.ping')}</dt>
                  <dd className="font-mono font-medium">
                    {asset.responseTimeMs != null
                      ? asset.responseTimeMs < 1
                        ? '<1 ms'
                        : `${formatNumber(asset.responseTimeMs, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.osFingerprint')}</dt>
                  <dd className="truncate font-medium">{osFingerprint}</dd>
                </div>
              </dl>
              {openPorts.length > 0 ? (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('assetDetailModal.openPorts')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {openPorts.map((p) => (
                      <span key={p.port} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">
                        {p.port}{p.service ? ` (${p.service})` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">{t('assetDetailModal.noOpenPorts')}</p>
              )}
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.snmpDataTitle')}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">{t('assetDetailModal.noSnmpData')}</div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{snmpFieldLabel(key, t)}</dt>
                      <dd className="break-all text-right font-medium">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.assetInfoTitle')}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.displayName')}</dt>
                  <dd className="font-medium">{asset.label || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.notesDescription')}</dt>
                  <dd className="whitespace-pre-wrap font-medium">{asset.notes || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('assetDetailModal.fields.tags')}</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {tags.length === 0
                      ? '—'
                      : tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">
                            {tag}
                          </span>
                        ))}
                  </dd>
                </div>
              </dl>
            </div>

            {asset.linkedDeviceId && (
              <div className="rounded-md border bg-muted/30 px-4 py-3">
                <a
                  href={`/devices/${asset.linkedDeviceId}`}
                  data-testid="asset-modal-same-device-link"
                  className="text-sm text-primary hover:underline"
                >
                  {t('assetDetailModal.sameDeviceAs', { name: asset.linkedDeviceName || t('common:states.unknown') })}
                </a>
              </div>
            )}

            {/* The two hand-offs. This modal deliberately cannot change
                anything — the device page owns the asset (spec §10, D7). */}
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('assetDetailModal.peek.manageTitle')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t('assetDetailModal.peek.manageDescription')}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a
                  href={`/devices/network/${asset.id}`}
                  data-testid="asset-modal-open-device-page"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  {t('assetDetailModal.peek.openDevicePage')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <a
                  href={`/devices/network/${asset.id}#overview/settings/identity`}
                  data-testid="asset-modal-settings"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  <Settings className="h-3.5 w-3.5" />
                  {t('assetDetailModal.peek.settings')}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
```

`onDeleted` / `onUpdated` leave the props type; remove them from the `DiscoveredAssetList` mount too (nothing in the peek can delete or update any more).

- [ ] **Step 6: Delete the two retired components**

```bash
git rm apps/web/src/components/discovery/AssetMonitoringSection.tsx \
       apps/web/src/components/discovery/EnableMonitoringForm.tsx
```

- [ ] **Step 7: Add the new discovery i18n keys** to `en/discovery.json`:

```json
"discoveredAssetList": { "actions": { "settings": "Settings…" } },
"assetDetailModal": {
  "peek": {
    "manageTitle": "Manage this asset",
    "manageDescription": "Identity, monitoring, linking and removal all live on the device page.",
    "openDevicePage": "Open device page",
    "settings": "Settings…",
    "reachabilityLine": "{{state}} · {{source}} {{age}}",
    "lastSeenLine": "Last seen · {{source}} {{age}}",
    "state": { "responding": "Responding", "notResponding": "Not responding", "unverified": "Unverified" },
    "source": { "networkCheck": "network check", "probe": "check now", "scan": "scan", "unifi": "UniFi", "snmp": "SNMP" }
  }
}
```
and delete the now-unreferenced `assetDetailModal.actions.*` write labels, `assetDetailModal.confirmDelete`, `.deleteDescription`, `.placeholders.*`, `.errors.{delete,saveInfo,resetType,link,unlink,selectDeviceToLink,createAllowlist,createProxyTunnel,createTunnel}`, `.options.selectManagedDevice` and `.messages.*` — each only after `grep -rn '<key>' apps/web/src` comes back empty.

- [ ] **Step 8: Run**

```bash
cd apps/web && npx vitest run src/components/discovery src/lib/__tests__/network-asset-single-writer.test.ts
```
Guard should now name only `MonitoringAssetsDashboard.tsx`.

- [ ] **Step 9: Commit**

```bash
git add -A apps/web/src/components/discovery apps/web/src/locales/en/discovery.json
git commit -m "$(cat <<'EOF'
refactor(web/discovery): AssetDetailModal becomes a read-only peek; rows launch settings

W04 Task 9. The peek answers "what is this?" and hands off; every write it used
to do is on the device page now. Row triage keeps Approve/Dismiss but routes
them through the single writer, so a failure toasts instead of landing in a
banner below the fold. EnableMonitoringForm and AssetMonitoringSection deleted.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Monitoring dashboard — delete `EditMonitoringModal`, add columns and Settings…

**Files:**
- Modify: `apps/web/src/components/monitoring/MonitoringAssetsDashboard.tsx`
- Create: `apps/web/src/components/monitoring/MonitoringAssetsDashboard.test.tsx`

Changes:
1. **Delete** `EditMonitoringModal` (`:625-1038`), its props type, the `editingAssetId`/`detail`/`detailLoading`/`openEdit` state and the `CreateMonitorForm` import. The file drops from 1038 to roughly 450 lines.
2. `initialAssetId` (the `?assetId=` deep link from the old flow) now **navigates** to `/devices/network/<id>#overview/settings/monitoring` instead of opening a panel, so the one remaining inbound deep link keeps working.
3. Row actions keep **pause/resume** (`patchSnmp(id, { isActive })`) and **disable** (`disableMonitoring(id)`) — both through the hook — and gain **Settings…** (`monitoring-asset-settings-<id>`) navigating to the same deep link.
4. Two new columns between "Overall" and "SNMP":
   - **Reachability** (`monitoring-asset-reachability-<id>`) — from W01's `asset.reachability`, rendered `<state> · <source> <relative time>`; absent field → `—` with `aria-label` "unknown". Never "Online".
   - **Collection** (`monitoring-asset-collection-<id>`) — derived from what the LIST route carries: `snmp.isActive === false → paused`; `snmp.lastPolled === null → never polled`; else `snmp.lastStatus`, including W01's new `no_template` value ("No template"). *(Spec §6.2's full per-OID `collection` object is on `GET /monitoring/assets/:id`, not the list; the OID table that consumes it is W05's Monitoring tab. This column is the honest list-level summary.)*
5. Mobile `DataCard`s get the same two `CardField`s so the two representations cannot drift.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/monitoring/MonitoringAssetsDashboard.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MonitoringAssetsDashboard from './MonitoringAssetsDashboard';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: (sel: (s: unknown) => unknown) => sel({ currentOrgId: 'org-1' }) }));
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({ ready: true, status: 'resolved', scope: 'org', orgId: 'org-1', org: null, error: null }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);
const res = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const baseAsset = {
  id: 'asset-1',
  hostname: 'core-sw-01',
  ipAddress: '10.0.0.2',
  assetType: 'switch',
  lastSeenAt: minutesAgo(5),
  monitoring: { configured: true, active: true },
  snmp: {
    configured: true, deviceId: 'snmp-1', snmpVersion: 'v2c', templateId: 't-1',
    pollingInterval: 300, port: 161, isActive: true, lastPolled: minutesAgo(2), lastStatus: 'online',
  },
  network: { configured: true, totalCount: 2, activeCount: 2 },
  reachability: { state: 'responding', source: 'snmp', observedAt: minutesAgo(2), lastKnown: null },
};

function wire(assets: unknown[] = [baseAsset]) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method) return Promise.resolve(res({ success: true }));
    if (url.startsWith('/monitoring/assets')) return Promise.resolve(res({ data: assets }));
    if (url === '/snmp/templates') return Promise.resolve(res({ templates: [] }));
    return Promise.resolve(res({}));
  });
}

const writes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method);

beforeEach(() => {
  fetchMock.mockReset();
  navigateMock.mockReset();
});

describe('MonitoringAssetsDashboard — reachability and collection columns (W01 fields)', () => {
  it('names the source and the age, never a bare "Online"', async () => {
    wire();
    render(<MonitoringAssetsDashboard />);

    const cell = await screen.findByTestId('monitoring-asset-reachability-asset-1');
    expect(cell.textContent).toMatch(/Responding · SNMP/);
    expect(cell.textContent).not.toBe('Online');
  });

  it('renders an explicit unknown when the API has no reachability yet (pre-W01)', async () => {
    const { reachability, ...withoutReachability } = baseAsset;
    wire([withoutReachability]);
    render(<MonitoringAssetsDashboard />);

    const cell = await screen.findByTestId('monitoring-asset-reachability-asset-1');
    expect(cell).toHaveTextContent('—');
    expect(cell).toHaveAttribute('aria-label', 'unknown');
  });

  it('reports a collecting device with its poll age', async () => {
    wire();
    render(<MonitoringAssetsDashboard />);

    const cell = await screen.findByTestId('monitoring-asset-collection-asset-1');
    expect(cell.textContent).toMatch(/Collecting/);
  });

  it('reports W01\'s no_template status as its own state, not as a failure', async () => {
    wire([{ ...baseAsset, snmp: { ...baseAsset.snmp, lastStatus: 'no_template' } }]);
    render(<MonitoringAssetsDashboard />);

    expect(await screen.findByTestId('monitoring-asset-collection-asset-1')).toHaveTextContent('No template');
  });

  it('reports a paused poller as paused and a never-polled one as never polled', async () => {
    wire([
      { ...baseAsset, id: 'a-paused', snmp: { ...baseAsset.snmp, isActive: false } },
      { ...baseAsset, id: 'a-new', snmp: { ...baseAsset.snmp, lastPolled: null, lastStatus: null } },
    ]);
    render(<MonitoringAssetsDashboard />);

    expect(await screen.findByTestId('monitoring-asset-collection-a-paused')).toHaveTextContent('Paused');
    expect(screen.getByTestId('monitoring-asset-collection-a-new')).toHaveTextContent('Never polled');
  });
});

describe('MonitoringAssetsDashboard — row actions', () => {
  it('launches the device page settings instead of an in-page editor', async () => {
    wire();
    render(<MonitoringAssetsDashboard />);

    fireEvent.click(await screen.findByTestId('monitoring-asset-settings-asset-1'));

    expect(navigateMock).toHaveBeenCalledWith('/devices/network/asset-1#overview/settings/monitoring');
    expect(screen.queryByText('Configure Monitoring')).not.toBeInTheDocument();
  });

  it('pauses SNMP polling through the mutation hook', async () => {
    wire();
    render(<MonitoringAssetsDashboard />);

    fireEvent.click(await screen.findByTestId('monitoring-asset-pause-asset-1'));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![0]).toBe('/monitoring/assets/asset-1/snmp');
    expect((writes()[0]![1] as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((writes()[0]![1] as RequestInit).body as string)).toEqual({ isActive: false });
  });

  it('resumes a paused poller with isActive:true', async () => {
    wire([{ ...baseAsset, snmp: { ...baseAsset.snmp, isActive: false } }]);
    render(<MonitoringAssetsDashboard />);

    fireEvent.click(await screen.findByTestId('monitoring-asset-resume-asset-1'));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse((writes()[0]![1] as RequestInit).body as string)).toEqual({ isActive: true });
  });

  it('disables all monitoring through the mutation hook', async () => {
    wire();
    render(<MonitoringAssetsDashboard />);

    fireEvent.click(await screen.findByTestId('monitoring-asset-disable-asset-1'));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![0]).toBe('/monitoring/assets/asset-1');
    expect((writes()[0]![1] as RequestInit).method).toBe('DELETE');
  });
});

describe('MonitoringAssetsDashboard — the ?assetId deep link still lands somewhere', () => {
  it('redirects to the device page settings rather than opening a panel', async () => {
    wire();
    render(<MonitoringAssetsDashboard initialAssetId="asset-9" />);

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith('/devices/network/asset-9#overview/settings/monitoring'),
    );
  });

  it('never fetches the per-asset detail endpoint any more', async () => {
    wire();
    render(<MonitoringAssetsDashboard />);
    await screen.findByTestId('monitoring-asset-reachability-asset-1');

    expect(fetchMock.mock.calls.some(([url]) => url === '/monitoring/assets/asset-1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd apps/web && npx vitest run src/components/monitoring/MonitoringAssetsDashboard.test.tsx
```

- [ ] **Step 3: Implement**

Delete `EditMonitoringModal` and `EditModalProps` entirely (`MonitoringAssetsDashboard.tsx:625-1038`), the `AssetMonitoringDetail` type (`:59-84`), the `templates` / `editingAssetId` / `detail` / `detailLoading` state, the `openEdit` callback and its `useEffect`, the `/snmp/templates` effect, the `CreateMonitorForm` import and the `X` / `Settings` icon imports that go with them. Then:

```tsx
// new imports
import { navigateTo } from '@/lib/navigation';
import { ActionError } from '@/lib/runAction';
import { useNetworkAssetMutations } from '../devices/networkDevice/settings/useNetworkAssetMutations';
import { Settings } from 'lucide-react';

// --- types ---------------------------------------------------------------
/** W01 (spec §4.2). Absent on a pre-W01 API — treat every field as optional. */
type Reachability = {
  state: 'responding' | 'not_responding' | 'unverified';
  source: 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp' | null;
  observedAt: string | null;
};

type MonitoringAsset = {
  /* …unchanged fields… */
  reachability?: Reachability | null;
};

const SETTINGS_HASH = '#overview/settings/monitoring';
const settingsHref = (assetId: string) => `/devices/network/${assetId}${SETTINGS_HASH}`;

const REACHABILITY_STATE_KEYS: Record<Reachability['state'], string> = {
  responding: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.responding',
  not_responding: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.notResponding',
  unverified: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.unverified',
};
const REACHABILITY_SOURCE_KEYS: Record<string, string> = {
  network_check: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.networkCheck',
  probe: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.probe',
  scan: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.scan',
  unifi: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.unifi',
  snmp: 'longTail.monitoring.MonitoringAssetsDashboard.reachability.sources.snmp',
};

/**
 * What the LIST route can honestly say about collection. Spec §6.2's per-OID
 * `collection` object lives on GET /monitoring/assets/:id and is W05's OID
 * table; this is the row-level summary derived from the fields the list
 * already carries, including W01's new `no_template` last_status (§6.1).
 */
type CollectionState = 'not_configured' | 'paused' | 'no_template' | 'never_polled' | 'collecting' | 'partial' | 'failing';

function collectionStateOf(snmp: MonitoringAsset['snmp']): CollectionState {
  if (!snmp.configured) return 'not_configured';
  if (!snmp.isActive) return 'paused';
  if (snmp.lastStatus === 'no_template') return 'no_template';
  if (!snmp.lastPolled) return 'never_polled';
  if (snmp.lastStatus === 'online') return 'collecting';
  if (snmp.lastStatus === 'warning') return 'partial';
  return 'failing';
}

const COLLECTION_STYLES: Record<CollectionState, string> = {
  collecting: 'bg-success/15 text-success border-success/30',
  partial: 'bg-warning/15 text-warning border-warning/30',
  no_template: 'bg-warning/15 text-warning border-warning/30',
  failing: 'bg-destructive/15 text-destructive border-destructive/30',
  paused: 'bg-muted text-muted-foreground border-muted',
  never_polled: 'bg-muted text-muted-foreground border-muted',
  not_configured: 'bg-muted text-muted-foreground border-muted',
};
```

Inside the component, replace the two write handlers and add the two cell renderers:

```tsx
  const { patchSnmp, disableMonitoring } = useNetworkAssetMutations();

  // The ?assetId= deep link used to open an in-page editor. That editor is
  // gone, so send the operator to the surface that replaced it rather than
  // silently dropping the parameter.
  useEffect(() => {
    if (!initialAssetId) return;
    void navigateTo(settingsHref(initialAssetId));
  }, [initialAssetId]);

  const handleToggleSnmpActive = async (assetId: string, nextActive: boolean) => {
    setActionLoading(assetId);
    try {
      await patchSnmp(assetId, { isActive: nextActive });
      await fetchAssets();
    } catch (err) {
      if (err instanceof ActionError) return; // 401 redirects; everything else was toasted
      setActionError(t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisableAll = async (assetId: string) => {
    setActionLoading(assetId);
    try {
      await disableMonitoring(assetId);
      await fetchAssets();
    } catch (err) {
      if (err instanceof ActionError) return;
      setActionError(t('longTail.monitoring.MonitoringAssetsDashboard.errors.generic'));
    } finally {
      setActionLoading(null);
    }
  };

  // Spec §10 copy rule: state · source · age. A bare "Online" here is exactly
  // the claim this spec exists to stop making.
  const renderReachabilityCell = (asset: MonitoringAsset) => {
    const r = asset.reachability;
    if (!r?.source || !r.observedAt) {
      return (
        <span
          className="text-xs text-muted-foreground"
          data-testid={`monitoring-asset-reachability-${asset.id}`}
          aria-label={t('common:states.unknown').toLowerCase()}
        >
          —
        </span>
      );
    }
    return (
      <span className="text-xs" data-testid={`monitoring-asset-reachability-${asset.id}`}>
        {t(/* i18n-dynamic */ REACHABILITY_STATE_KEYS[r.state])}
        {' · '}
        {t(/* i18n-dynamic */ REACHABILITY_SOURCE_KEYS[r.source] ?? REACHABILITY_SOURCE_KEYS.scan)}
        {' '}
        {formatRelativeTime(r.observedAt, t)}
      </span>
    );
  };

  const renderCollectionCell = (asset: MonitoringAsset) => {
    const state = collectionStateOf(asset.snmp);
    return (
      <div className="space-y-1" data-testid={`monitoring-asset-collection-${asset.id}`}>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${COLLECTION_STYLES[state]}`}>
          {t(/* i18n-dynamic */ `longTail.monitoring.MonitoringAssetsDashboard.collectionState.${state}`)}
        </span>
        {asset.snmp.configured && asset.snmp.lastPolled && (
          <div className="text-xs text-muted-foreground">
            {t('longTail.monitoring.MonitoringAssetsDashboard.lastPolled', {
              time: formatRelativeTime(asset.snmp.lastPolled, t),
            })}
          </div>
        )}
      </div>
    );
  };
```

`renderActions` (`:330-372`) becomes — Settings… replaces the old pencil-into-modal, pause/resume and disable keep their place, and every control gets a keyed test id:

```tsx
  const renderActions = (asset: MonitoringAsset) => {
    const isLoadingAction = actionLoading === asset.id;
    return (
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          data-testid={`monitoring-asset-settings-${asset.id}`}
          onClick={() => void navigateTo(settingsHref(asset.id))}
          className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          title={t('longTail.monitoring.MonitoringAssetsDashboard.openSettings')}
        >
          <Settings className="h-4 w-4" />
        </button>
        {asset.snmp.configured && (
          <button
            type="button"
            data-testid={`monitoring-asset-${asset.snmp.isActive ? 'pause' : 'resume'}-${asset.id}`}
            onClick={() => void handleToggleSnmpActive(asset.id, !asset.snmp.isActive)}
            disabled={isLoadingAction}
            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
            title={asset.snmp.isActive
              ? t('longTail.monitoring.MonitoringAssetsDashboard.pauseSnmpPolling')
              : t('longTail.monitoring.MonitoringAssetsDashboard.resumeSnmpPolling')}
          >
            {isLoadingAction ? <Loader2 className="h-4 w-4 animate-spin" />
              : asset.snmp.isActive ? <PowerOff className="h-4 w-4 text-yellow-600" />
              : <Power className="h-4 w-4 text-green-600" />}
          </button>
        )}
        {asset.monitoring.active && (
          <button
            type="button"
            data-testid={`monitoring-asset-disable-${asset.id}`}
            onClick={() => void handleDisableAll(asset.id)}
            disabled={isLoadingAction}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-50"
            title={t('longTail.monitoring.MonitoringAssetsDashboard.disableAllActiveMonitoring')}
          >
            <XCircle className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  };
```

Table header (`:516-524`) gains two `<th>`s between "Overall" and "SNMP", and the body rows gain the two cells in the same position — `colSpan` on the empty row goes 7 → 9:

```tsx
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.table.reachability')}</th>
                  <th className="px-4 py-3">{t('longTail.monitoring.MonitoringAssetsDashboard.table.collection')}</th>
```
```tsx
                      <td className="px-4 py-3">{renderReachabilityCell(asset)}</td>
                      <td className="px-4 py-3">{renderCollectionCell(asset)}</td>
```

Mobile `DataCard`s get the same two fields, right after the Type field, so the two representations cannot drift:

```tsx
                    <CardField label={t('longTail.monitoring.MonitoringAssetsDashboard.table.reachability')}>
                      {renderReachabilityCell(asset)}
                    </CardField>
                    <CardField label={t('longTail.monitoring.MonitoringAssetsDashboard.table.collection')}>
                      {renderCollectionCell(asset)}
                    </CardField>
```

Finally, delete the `{editingAssetId && <EditMonitoringModal … />}` block (`:606-620`).

- [ ] **Step 4: Add the dashboard i18n keys** to `en/common.json` under `longTail.monitoring.MonitoringAssetsDashboard`:

```json
"openSettings": "Settings…",
"table": { "reachability": "Reachability", "collection": "Collection" },
"reachability": {
  "responding": "Responding",
  "notResponding": "Not responding",
  "unverified": "Unverified",
  "sources": { "networkCheck": "network check", "probe": "check now", "scan": "scan", "unifi": "UniFi", "snmp": "SNMP" }
},
"collectionState": {
  "collecting": "Collecting",
  "partial": "Partial",
  "no_template": "No template",
  "failing": "Failing",
  "paused": "Paused",
  "never_polled": "Never polled",
  "not_configured": "Not configured"
}
```
`collectionState.*` is reached through a template literal, so the group must exist in `en` or `keyUsage.test.ts`'s `existsGroup` check fails for every value at once.

- [ ] **Step 5: Run the guard — it must now be GREEN**

```bash
cd apps/web && npx vitest run \
  src/components/monitoring/MonitoringAssetsDashboard.test.tsx \
  src/lib/__tests__/network-asset-single-writer.test.ts
```
Expected: `no other module mutates an asset-scoped endpoint` passes with an empty offender list. **This is the task that turns the Task 3 red green.**

- [ ] **Step 6: Add the writer to the no-silent-mutations target set**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, append to `TARGET_GLOBS`:
```ts
  // Network device page truth W04 (#…): the single writer for every
  // asset-scoped mutation (Identity, SNMP, link, approve/dismiss/delete). A
  // bare mutation added here would ship unguarded to the device page,
  // Discovery and /monitoring/network at once.
  'src/components/devices/networkDevice/settings/useNetworkAssetMutations.ts',
```
and bump the count assertion `expect(absoluteFiles.length).toBe(133)` → `134`, with a comment naming this wave (the file's convention: bump deliberately, never by resolving a merge hunk).

```bash
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/monitoring apps/web/src/lib/__tests__/no-silent-mutations.test.ts \
        apps/web/src/locales/en/common.json
git commit -m "$(cat <<'EOF'
refactor(web/monitoring): delete EditMonitoringModal; dashboard launches the device page

W04 Task 10. The fourth surface that edited a network asset is gone. The table
keeps pause/resume/disable (now through the single writer) and gains sourced
Reachability and Collection columns from the W01 fields; the ?assetId deep link
redirects to the device page's Monitoring settings. Turns the Task 3 guard green.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: i18n — all 8 locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json`
- Modify: `.../discovery.json` (add peek + row-action keys; **remove** `assetMonitoringSection.*` and `enableMonitoringForm.*`)
- Modify: `.../common.json` (`longTail.monitoring.MonitoringAssetsDashboard.*` additions)

- [ ] **Step 1: Freeze the English key set.** From `apps/web/src/locales/en/devices.json`, the complete `networkDeviceDetailPage.settings` subtree must now exist: `title`, `subtitle`, `navLabel`, `unsavedChanges`, `sections.*`, `identity.*` (incl. `typeGroups.*`), `monitoring.*` (incl. `collectionStatus.*`, `checkState.*`), `link.*`, `danger.*`, `toasts.*`; plus `networkDeviceDetailPage.header.settings` and `networkDeviceDetailPage.editInSettings`. Remove `networkDeviceDetailPage.manageInDiscovery`, `.configurePrefix`, `.discoveryAssetView`, `.savingType`, `.resettingType` only if nothing references them any more — verify with `grep -rn '<key>' apps/web/src` before deleting each one.

- [ ] **Step 2: Translate — really translate.** Write each string in the target language. A copied English value counts against `namespaceDuplicateBaselines` in `translationCoverage.test.ts`; if a value is legitimately identical (a protocol name like `SNMP`, `v2c`, `AES-256`), keep it as a leaf of an existing acronym-style key rather than raising a baseline. Do not raise any baseline in this wave.

- [ ] **Step 3: Delete the retired blocks** in all 8 `discovery.json` files (`assetMonitoringSection`, `enableMonitoringForm`). `localeParity.test.ts` fails if one locale keeps them.

- [ ] **Step 4: Run the i18n guards**

```bash
cd apps/web && npx vitest run src/lib/i18n
```
Expected green: `localeParity`, `translationCoverage`, `keyUsage`, `terminologyQuality`, `extractionQuality`.

- [ ] **Step 5: Commit** (`i18n(web): network asset settings modal strings in all 8 locales`).

---

### Task 12: Typecheck, full web suite, PR

- [ ] **Step 1: Typecheck**

```bash
cd apps/web && pnpm exec astro check
```
Expected: 0 errors. Common fallout: dangling imports of the two deleted discovery components and the removed `EditMonitoringModal` props type.

- [ ] **Step 2: Lint**

```bash
cd apps/web && pnpm lint
```

- [ ] **Step 3: Full web suite**

```bash
cd apps/web && npx vitest run
```
Everything green. Pay attention to: `no-silent-mutations` (count bumped), `network-asset-single-writer` (empty offenders), `composeBindMounts` (unaffected), and any snapshot of the monitoring dashboard.

- [ ] **Step 4: Rebase on main and re-run.** A stale base is how a green PR reddens main (CLAUDE.md). `git fetch origin && git rebase origin/main`, then repeat Steps 1 and 3.

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --title "Network device page truth W04: one settings surface for a network asset" --body "$(cat <<'EOF'
Closes #<W04 sub-issue>

Spec: `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` §10, §14, §15 (web), §16.
Plan: `docs/superpowers/plans/monitoring/2026-09-16-network-device-page-truth-w04-web-settings.md`.

## What changes

- `NetworkAssetSettingsModal` (Identity · Monitoring · Link · Danger), four sections saved independently, each through `runAction`.
- `useNetworkAssetMutations` is now the ONLY module in `apps/web` that mutates `/discovery/assets/:id*` and `/monitoring/assets/:id*`, enforced by `lib/__tests__/network-asset-single-writer.test.ts`.
- Hash grammar `#<tab>[/settings/<section>]`; tab-only hashes unchanged.
- Entry points: header **Settings**; "Settings…" row actions in Discovery and `/monitoring/network`.
- `AssetDetailModal` is a read-only peek; `EditMonitoringModal`, `EnableMonitoringForm` and `AssetMonitoringSection` are deleted.
- The monitoring table keeps pause/resume/disable and gains Reachability + Collection columns.

## Reviewer notes

- Type select offers exactly the 12 types `updateAssetSchema` accepts; `website`/`service` are shown disabled because the PATCH route rejects them (pre-existing API/UI mismatch, documented in `assetTypeGroups.ts`).
- W03's `templateSuggestion` is feature-detected: a 404 from `/monitoring/templates/suggest` renders no suggestion line.
- `/monitors*` and `/discovery/assets/bulk-*` are deliberately outside the single-writer guard; the reason is in the test file's header.

## Verification

- `cd apps/web && npx vitest run` — full web suite green
- `cd apps/web && pnpm exec astro check` — 0 errors
- `cd apps/web && npx vitest run src/lib/i18n` — parity + coverage green in all 8 locales

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Dispatch CI for the branch if it is stacked**

```bash
gh workflow run CI --ref feature/<parent#>-network-device-page-truth/wave-<W04 sub-issue#>
```
(`ci.yml` triggers on `pull_request: branches: [main]`; a PR based on a sibling branch runs no CI and `gh pr checks` reads green.)

- [ ] **Step 7: Manual QA checklist for the reviewer**
  - `/devices/network/<id>` → **Settings** → each of the four sections saves and cancels independently.
  - Deep link `/devices/network/<id>#overview/settings/monitoring` opens straight to Monitoring; Escape returns the hash to `#overview`; browser Back closes the modal.
  - Discovery row → **Settings…** lands on the device page's Monitoring section.
  - `/monitoring/network` row → pause, resume and disable all still work; Reachability and Collection columns read `<state> · <source> <age>`, never a bare "Online".
  - Saving SNMP with a blank community on a device that already has one keeps polling working (the stored secret survives).
