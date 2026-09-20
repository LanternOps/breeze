---
tracking_issue: (set by feature-lifecycle after registration)
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05c2 Conversion (web, tools, docs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put W05c1's converter in front of a technician — the per-policy **Needs conversion** panel, the library **Needs conversion** filter and banner, the partner-level **Convert everything** action (and the platform-admin page hosted ops run it from) — and move every remaining writer and reader of legacy alert rows onto monitors: the Jobs **Alert workflows** typed filter, the device page **Monitoring** tab, Fleet Designer, the two AI tools, the Alert Templates screens (deleted, 301), the docs and the release notes.

**Architecture:** Everything in this wave consumes W05c1's `/monitor-definitions/conversion/*` routes and the `PolicyConversionPreview` / `ConversionPreviewItem` shapes with binding D2/D3/D10 refinements; the one place their paths appear on the web is a single client module (`apps/web/src/components/monitoring/conversion/conversionApi.ts`), so a W05c1 path rename is a one-file change. The policy Monitors tab gains three additive blocks (Needs-conversion panel, inheritance switch, Check-interval field) and nothing is removed from the legacy tabs — `featureTypeParity.test.ts` still holds until W05d. Two small API additions belong to this wave because no contract covers them: a device-scoped `GET /devices/:id/monitors` (effective monitors joined to `monitor_device_state` and the open `monitor_episodes` row) for the device tab, and a platform-admin `/admin/monitor-conversion/*` wrapper over `convertPartnerLegacy` for the hosted sweep. Fleet Designer and the AI tools stop writing `alert_rule` / `monitoring` links and go through `createMonitorDefinition` + the `monitors` feature-link attachment path instead.

**Tech Stack:** React 19 + react-i18next (8 locales), Astro pages (`Astro.redirect` 301s), `runAction` for every mutation, Vitest + jsdom (`apps/web`), Hono + Drizzle + zod (`apps/api`, `packages/shared`), Vitest with Drizzle mocks (unit) and the integration setup (`apps/api/src/__tests__/integration/setup`) for the one live-DB proof, Astro Starlight docs (`apps/docs`).

**Spec:** docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md (§End state "Monitors (library)", "Config policy editor", "Jobs", "Device page", "Removed screens and routes"; §Conversion "Who runs it" and "Other writers of legacy rows"; §AI / MCP tools rows marked W05c; §Docs and release notes; §Waves W05c row; §Risks "Fleet Designer and AI tools keep writing legacy features", "`inheritance: replace` surprises a tech")

## Ordering assumptions (read first)

- **W05a, W05b and W05c1 have shipped on `main`.** This plan does not re-plan any of them. W05a already added **Create monitor**, the **Recommended** strip, the duplicate-condition warning and the creation freeze to the policy tabs; this wave adds the Needs-conversion panel, persistent history, the inheritance switch and Check-interval write-through to `MonitorsTab.tsx`; Tasks 12–13 supply the editor controls and separate library Recommended strip. W05b already shipped the Delivery page and the `/alerts/channels` 301, which Task 11 copies as the redirect pattern.
- **W05c1 routes are fixed by D2/D3/D10.** Task 1 mirrors the exact conversion subrouter contracts; do not invent alternate leaf paths. C1 produces `routes/monitorDefinitions.conversion.ts` (new prerequisite file, absent on this base).
- **Async previews ship in PR1 (D10).** W05c1 returns 200 `{ data: PolicyConversionPreview }` or 202 `{ data: { status: 'running', progress: { checked, total } } }`; poll the same GET. Tasks 1 and 5 implement polling, cancellation, blocked-empty handling and disabling confirmation during refresh.
- **Persistent ledger is required in PR1 (D2/D4).** Consume `GET /monitor-definitions/conversion/ledger?orgId&policyId&cursor&limit`; history remains accessible after the conversion panel disappears. `revertable` controls Undo; W05d returns `409 conversion_revert_unavailable` before mutation for removed runtimes.
- **Standalone template groups (D13).** One conversion includes every rule of its template and one ledger entry, with reference-aware reversal and preserved alert provenance. The client refreshes the whole table after conversion; it never promises one monitor per rule. Standalone `alert_rules` keep the existing `POST /monitor-definitions/convert-from-rule/:id` path. `ConversionSourceTable` covers `alert_templates` (an unmanaged template *and* its rules) but not a bare `alert_rules` row, so the library's Needs-conversion view reuses `LegacyRulesPage`'s table (extracted, Task 6) for those and W05c1's per-policy routes for everything else. `/alerts/rules` itself stays until W05d, rendering the same extracted table.
- **Which policies "need conversion" is decided by the API count, not by the client.** `GET /monitor-definitions/conversion/pending?orgId` returns counts only. The library view lists candidate policies from the org's policy list filtered on an unretired-capable legacy link (`featureType in ('alert_rule','monitoring','automation')`); that over-approximates after conversion (the link row survives, only its child rows are retired), which is why the per-policy panel hides itself when the preview returns zero items. The banner text always uses the API's counts.
- **Three PRs:** PR1 = Tasks 1–8; PR2 = Tasks 9–13; PR3 = Tasks 14–18. PR3 depends on merged PR1 and PR2 for aggregate verification. Every PR targets `main`; never branch from an unmerged sibling.
- **Tabs are not removed in this wave.** `AlertRuleTab.tsx` and `MonitoringTab.tsx` stay mounted; `featureTypeParity.test.ts` (every `CONFIG_FEATURE_TYPES` entry has a tab) must stay green untouched. Their removal, the `#alert_rule`/`#monitoring` hash redirects and `RETIRED_CONFIG_FEATURE_TYPES` are W05d.

## Global Constraints

- **No migration in this wave.** Every schema change conversion needs landed in W05c1. The two API additions here are read routes plus one wrapper route over an existing W05c1 service; if you find yourself writing SQL DDL, stop — it belongs to W05c1 or W05d.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`): every Convert / Retire / Revert / Save / Reset button wraps its `fetchWithAuth` in `runAction({ request, successMessage, errorFallback })`; the catch pattern from CLAUDE.md (`err instanceof ActionError && err.status === 401` → return; non-`ActionError` → `showToast`). `no-silent-mutations.test.ts` guards the adopted set — do not add new files to `runActionAllowlist.ts`.
- **Every new i18n key needs a real translation in all 8 locales** (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}`); the coverage test fails on a missing or English-echoed key. Deleted components take their keys out of all 8 files in the same commit (`titles.settingsAlertTemplates`, `titles.settingsAlertTemplatesDetail` in `pages.json`, plus whatever `AlertTemplateList` / `AlertTemplateEditor` own). Platform-admin pages follow the `SendingDomainsAdmin.tsx` precedent (English-only, unlisted, reached by URL) except for the one `titles.*` key the Astro layout needs.
- **Hash for tab state, never query params** for transient UI (CLAUDE.md "URL State in Components"): the library's Needs-conversion filter is `#needs-conversion` via `useHashState`; the policy editor keeps `#monitors`.
- **Retired web routes return a 301** from the Astro page (`return Astro.redirect('/alerts/monitors', 301)`), and every registry that lists the retired page (`settingsPageRegistry`, `routeScope.ts`, `Sidebar.nav.test.tsx` expectations) loses its entry in the same commit — `settingsPageRegistry.test.ts` asserts every settings screen is in the nav at one URL and old URLs redirect.
- **AI tools change behaviour, not surface, in this wave.** `manage_policy_feature_link` *warns* on `alert_rule` / `monitoring` (refusal is W05d); `manage_service_monitors.list` reads via the resolver. `aiAgentSdkTools.mcpCoverage.test.ts` pins the tool surface — a changed description or input schema must update that pin in the same commit, and no tool is added or removed here.
- **Fleet Designer writes monitors on the same axis as the policy** (org-owned policy → org monitor; partner-wide → partner monitor), through `createMonitorDefinition` and the `monitors` feature-link attachment path — never a direct insert into `monitor_definitions` / `config_policy_monitors`, and never an `alert_rule` or `monitoring` link. Partner-wide writes stay gated on `canManagePartnerWidePolicies(auth)` exactly where the legacy branch gated them.
- **The device endpoint is read-only and device-scoped.** `GET /devices/:id/monitors` runs under the request's `withDbAccessContext` and the existing device-access check of the devices router; the reset action reuses the W03 episode reset route (Task 10 names it after verifying) — no new writer, no new RLS shape, no registration-list change.
- Every task: **red test first**, then typecheck (`cd apps/web && npx tsc --noEmit -p .` / `cd apps/api && npx tsc --noEmit -p .` / `cd packages/shared && npx tsc --noEmit -p .`), then the task's targeted tests with `npx vitest run <path>` — never `pnpm --filter … test -- --run <path>` (the `--` is swallowed and the whole suite runs in watch mode), never a trailing-slash path filter (substring match silently skips dotted siblings).
- `pnpm test` does **not** run the integration suites. Task 10's live proof and Task 18 need `pnpm test-stack up` … `pnpm test-stack down` — nothing reaps it for you.
- Do not commit from a subagent; the orchestrator commits. Each task's Step 5 gives the commit message.

## File Structure (what changes where)

| File or group | Change and task coverage |
|---|---|
| `apps/web/src/components/monitoring/conversion/{conversionApi,NeedsConversionPanel,ConversionPendingBanner,PendingPoliciesList}.*` | Conversion client/panel/library, Tasks 1, 5, 6; async preview implementation in PR1, Tasks 1 and 5 |
| `apps/web/src/components/monitoring/conversion/ConversionLedger.*` | Persistent paginated history, retirement entries and lifecycle-aware Undo, Task 8 |
| `apps/web/src/components/monitoring/{MonitorAuthoringFields.*,MonitorConditionFields.tsx,monitorKindFields.*,MonitorEditor.*}` | Composite children, restart parameters and failure-count bounds, Task 12 |
| `apps/web/src/components/monitoring/RecommendedMonitors.*` | Library built-in deployment detection and policy picker, Task 13 |
| `apps/web/src/components/configurationPolicies/{ConfigPolicyDetailPage,featureTabs/types,featureTabs/MonitorsTab,featureTabs/useFeatureLink}.*` | Policy tab props, interval, inheritance, conversion mount, Tasks 2–5 |
| `apps/web/src/components/monitoring/{LegacyRulesPage,LegacyRulesTable,MonitorsListPage}.*` | Needs-conversion view and shared legacy table, Task 6 |
| `apps/api/src/services/monitors/conversion/partnerBacklog.*`, `apps/api/src/routes/admin/{monitorConversion.*,index.ts}` | Hosted conversion backlog/wrapper, Task 7 |
| `apps/web/src/components/admin/MonitorConversionAdmin.*`, `apps/web/src/pages/admin/monitor-conversion.astro` | Hosted admin UI, Task 7 |
| `apps/web/src/components/automations/{alertWorkflowFilter,AutomationForm,AutomationEditPage}.*`, `AutomationsPage.tabs.test.tsx`, `apps/api/src/jobs/automationWorker.test.ts` | Typed workflow filter and runtime contract, Task 9 |
| `apps/api/src/routes/devices/{monitors.ts,index.ts}`, `apps/api/src/__tests__/integration/deviceMonitors.integration.test.ts`, `apps/web/src/components/devices/DeviceMonitoringTab.*` | Effective device monitoring and isolation, Task 10 |
| `apps/web/src/pages/settings/alert-templates/*.astro`, `apps/web/src/components/alerts/AlertTemplate*` | Redirect stubs and deleted editors/tests, Task 11 |
| `apps/web/src/lib/{routeScope.*,runActionAllowlist.ts}`, `apps/web/src/lib/__tests__/{settingsPageRegistry,alertTemplatesRetired,no-silent-mutations}.test.ts`, `Sidebar.nav.test.tsx` | Registry, navigation, deletion and mutation coverage, Tasks 1, 7–10 |
| `apps/web/src/locales/*/{policies,monitoring,pages,scripts,alerts}.json` | Real translations or removal of retired keys, Tasks 3–13 |
| `apps/api/src/services/{aiToolsConfigPolicy.*,aiToolsFleet.ts,aiAgentSdkTools.ts,aiAgentSdkTools.mcpCoverage.test.ts,aiAgentSystemPrompt.ts,aiGuardrails.ts}`, `monitors/listServiceMonitors.*` | Canonical monitor AI behavior and schemas, Task 14 |
| `packages/shared/src/{types/fleetDesign.ts,validators/fleetDesign.*}`, `apps/api/src/services/aiAgents/{outcomeTools.*,runLoop.design.test.ts,fleetDesignReport.test.ts}`, `FleetDesignViewer.test.tsx` | Monitor-shaped model proposals, Task 15 |
| `apps/api/src/services/fleetDesign/{monitorProposalCompatibility.*,preview.ts,monitorAttachments.*,apply.*,drift.*,rollback.*}` | Historical report guard, apply, drift, rollback, Tasks 15–16 |
| `apps/api/src/services/monitors/{monitorService.*,monitorCompiler.ts}`, `packages/shared/src/types/fleetDesignApply.ts`, `apps/api/src/__tests__/integration/fleetDesignApply.integration.test.ts` | Savepoint-aware monitor service, ledger provenance and live proof, Task 16 |
| `apps/docs/src/content/docs/features/{alerts,monitors,notifications,configuration-policies,alert-templates,service-monitoring}.mdx`, `apps/docs/astro.config.mjs` | Domain docs, removals and redirects, Task 17 |
| `apps/docs/src/content/docs/migration/{overview,ninjaone,syncro,other-rmms,atera,datto-rmm,n-central,kaseya-vsa,connectwise-automate,scripts-from-datto}.mdx`, `docs/release-notes/next-release-draft.md` | All ten affected guides and release checklist, Task 17 |
| `apps/web/src/lib/__tests__/{alertingDocs,alertingVerification}.test.ts`, `scripts/verify-alerting-consolidation-w05c2.sh` | Documentation contract and complete final verification, Tasks 17–18 |

---

### Task 1: Conversion client module — one home for W05c1's paths and shapes (PR1)

**Files:**
- Create: `apps/web/src/components/monitoring/conversion/conversionApi.ts`
- Create: `apps/web/src/components/monitoring/conversion/conversionApi.test.ts`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`, lines 35–59) — register the three new component files with Task 7 (`src/components/monitoring/conversion/NeedsConversionPanel.tsx`, `ConversionPendingBanner.tsx`, `src/components/admin/MonitorConversionAdmin.tsx`, `src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` is **not** added: it saves through `useFeatureLink`, registered with `runAction` in Task 3)

**Interfaces:**
- Consumes (W05c1, exact): `GET /monitor-definitions/conversion/pending?orgId` → `{ data: { policies: number; rows: number } }`; the policy preview/convert, revert, retire and partner convert-all leaves under `/monitor-definitions/conversion/*`; `PolicyConversionPreview` and `ConversionPreviewItem` (with `notes: string[]`, `openAlerts: number`).
- Produces: `conversionPaths` (the only place the leaf paths appear), the TS mirrors of the contract types, `fetchPolicyPreview(policyId)`, `fetchPendingCounts(orgId)`, `convertBody(previewHash, sourceIds?)`, `retireBody(sourceTable, sourceId, reason)`, `readConvertResult(body)`, `readPartnerConvertResult(body)`. D2 ledger queries return `{ items, nextCursor }`; D3 preview POST returns `PartnerConversionPreview` and convert-all requires `{ previewHash }`. Mutations are **not** issued from this module — components call `fetchWithAuth` inside `runAction` with these paths and bodies, so the syntactic `runAction` guard sees every write.

- [ ] **Step 0: Pin the leaf paths against what W05c1 actually shipped.**
  ```bash
  rg -n "\.(get|post)\(" apps/api/src/routes/monitorDefinitions.conversion.ts
  ```
  Expect eight handlers (including ledger GET and partner preview POST): policy preview (GET), policy convert (POST), revert (POST), retire (POST), partner convert-all (POST), pending (GET). The fixed leaves are `policies/:policyId/preview`, `policies/:policyId/convert`, `:conversionId/revert`, `retire`, `partner/preview`, `partner/convert-all`, `pending`, `ledger` (D2/D3/D10). A prerequisite implementation missing one must be corrected to the binding contract before this PR ships.

- [ ] **Step 1: Write the failing test** — `conversionApi.test.ts`:
  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';

  vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  import { fetchWithAuth } from '../../../stores/auth';
  import {
    conversionPaths, convertBody, fetchPendingCounts, fetchPolicyPreview,
    readConvertResult, readPartnerConvertResult, retireBody,
  } from './conversionApi';

  const fetchMock = vi.mocked(fetchWithAuth);
  const json = (body: unknown, status = 200): Response =>
    ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

  beforeEach(() => vi.clearAllMocks());

  describe('conversionApi (W05c1 contract)', () => {
    it('keeps every leaf under /monitor-definitions/conversion/', () => {
      const leaves = [
        conversionPaths.preview('p1'), conversionPaths.convert('p1'), conversionPaths.revert('c1'),
        conversionPaths.retire(), conversionPaths.partnerConvertAll(), conversionPaths.pending('o1'), conversionPaths.pending(null),
      ];
      for (const leaf of leaves) expect(leaf.startsWith('/monitor-definitions/conversion/')).toBe(true);
      expect(conversionPaths.pending('org 1')).toBe('/monitor-definitions/conversion/pending?orgId=org%201');
      expect(conversionPaths.pending(null)).toBe('/monitor-definitions/conversion/pending');
    });

  it('polls a large-policy preview until complete and reports progress', async () => {
    vi.useFakeTimers();
    const complete = { policyId: 'p1', previewHash: 'ready', items: [], inheritanceMode: 'cumulative',
      equivalence: { devicesChecked: 700, deltas: [] } };
    fetchMock.mockResolvedValueOnce(json({ data: { status: 'running', progress: { checked: 200, total: 700 } } }, 202))
      .mockResolvedValueOnce(json({ data: complete }));
    const onProgress = vi.fn();
    try {
      const promise = fetchPolicyPreview('p1', { onProgress });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toEqual(complete);
      expect(onProgress).toHaveBeenCalledWith({ checked: 200, total: 700 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('never accepts a pending result as a confirmation hash', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchPolicyPreview('p1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

    it('fetchPolicyPreview unwraps { data } and returns the PolicyConversionPreview', async () => {
      const preview = { policyId: 'p1', previewHash: 'h', items: [], inheritanceMode: 'cumulative', equivalence: { devicesChecked: 0, deltas: [] } };
      fetchMock.mockResolvedValue(json({ data: preview }));
      await expect(fetchPolicyPreview('p1')).resolves.toEqual(preview);
      expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/conversion/policies/p1/preview');
    });

    it('fetchPolicyPreview throws the API message on a non-2xx', async () => {
      fetchMock.mockResolvedValue(json({ error: 'PREREQUISITE_MISSING', message: 'offline fix not deployed' }, 409));
      await expect(fetchPolicyPreview('p1')).rejects.toThrow(/offline fix not deployed/);
    });

    it('fetchPendingCounts returns { policies, rows }', async () => {
      fetchMock.mockResolvedValue(json({ data: { policies: 3, rows: 12 } }));
      await expect(fetchPendingCounts('org-1')).resolves.toEqual({ policies: 3, rows: 12 });
      expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/conversion/pending?orgId=org-1');
    });

    it('builds the convert and retire bodies exactly as the contract names them', () => {
      expect(convertBody('h')).toEqual({ previewHash: 'h' });
      expect(convertBody('h', ['s1', 's2'])).toEqual({ previewHash: 'h', sourceIds: ['s1', 's2'] });
      expect(retireBody('config_policy_alert_rules', 's1', 'operator')).toEqual({ sourceTable: 'config_policy_alert_rules', sourceId: 's1', reason: 'operator' });
    });

    it('reads convert results from a wrapped or bare body', () => {
      const result = { conversionIds: ['c1'], retired: 1, monitorsCreated: 2 };
      expect(readConvertResult({ data: result })).toEqual(result);
      expect(readConvertResult(result)).toEqual(result);
      expect(readPartnerConvertResult({ data: { policies: 2, converted: 5, unconvertible: 1 } })).toEqual({ policies: 2, converted: 5, unconvertible: 1 });
    });
  });
  ```

- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/conversion/conversionApi.test.ts` → `Failed to resolve import "./conversionApi"`.

- [ ] **Step 3: Implement** — `conversionApi.ts`:
  ```ts
  import { fetchWithAuth } from '../../../stores/auth';
  import { extractApiError } from '@/lib/apiError';

  // Mirrors of apps/api/src/services/monitors/conversion/ (W05c1). Do not widen
  // them here — a field the API does not send is a lie the panel will render.
  export type ConversionSourceTable =
    | 'config_policy_alert_rules' | 'config_policy_monitoring_watches' | 'alert_templates'
    | 'automations' | 'config_policy_automations' | 'network_monitors';
  export type ProposedRole = 'primary' | 'resource_cpu' | 'resource_memory' | 'response';
  export type ProposedMonitor = {
    role: ProposedRole; kind: string; name: string; condition: Record<string, unknown>; severity: string;
    deliveryMode: 'inherit' | 'channels' | 'none'; deliveryChannelIds: string[];
    escalationPolicyId: string | null; responses: unknown[]; enabled: boolean; cooldownMinutes: number; autoResolve: boolean;
  };
  export type RetirementReason = 'operator' | `unconvertible:${string}`;
  export type ConversionPreviewItem = {
    sourceTable: ConversionSourceTable; sourceId: string; name: string;
    outcome: 'convertible' | 'unconvertible'; reason?: string;
    proposed: ProposedMonitor[]; notes: string[]; openAlerts: number;
  };
  export type PolicyConversionPreview = {
    policyId: string; previewHash: string; items: ConversionPreviewItem[];
    inheritanceMode: 'cumulative' | 'replace';
    equivalence: { devicesChecked: number; deltas: Array<{ deviceId: string; detail: string }> };
    blockedBy?: 'parent_unconverted' | 'prerequisite_missing';
  };
  export type ConversionLedgerEntry = {
    id: string; sourceTable: ConversionSourceTable; sourceId: string; sourceName: string;
    policyId: string | null; convertedBy: string | null; convertedAt: string;
    revertedAt: string | null; revertable: boolean;
    outputs: Array<{ monitorId: string; role: string; reused: boolean }>;
  };
  export type LedgerPage = { items: ConversionLedgerEntry[]; nextCursor: string | null };
  export type PartnerConversionPreview = {
    partnerId: string; previewHash: string; policies: number; rows: number; convertible: number;
    unconvertible: Array<{ policyId: string | null; policyName: string | null;
      sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string }>;
  };
  export const readPartnerPreview = (body: unknown): PartnerConversionPreview => unwrap(body);
  export const readRetireResult = (body: unknown): { conversionId: string } => unwrap(body);
  export type PendingCounts = { policies: number; rows: number };
  export type ConvertResult = { conversionIds: string[]; retired: number; monitorsCreated: number };
  export type PartnerConvertResult = { policies: number; converted: number; unconvertible: number };

  export const CONVERSION_BASE = '/monitor-definitions/conversion';
  // The ONLY place W05c1's leaf paths appear on the web. Verified in Task 1 Step 0.
  export const conversionPaths = {
    preview: (policyId: string) => `${CONVERSION_BASE}/policies/${encodeURIComponent(policyId)}/preview`,
    convert: (policyId: string) => `${CONVERSION_BASE}/policies/${encodeURIComponent(policyId)}/convert`,
    revert: (conversionId: string) => `${CONVERSION_BASE}/${encodeURIComponent(conversionId)}/revert`,
    retire: () => `${CONVERSION_BASE}/retire`,
    partnerPreview: () => `${CONVERSION_BASE}/partner/preview`,
    ledger: (filters: { orgId?: string; policyId?: string; cursor?: string; limit?: number } = {}) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value != null) query.set(key, String(value));
      return `${CONVERSION_BASE}/ledger?${query}`;
    },
    partnerConvertAll: () => `${CONVERSION_BASE}/partner/convert-all`,
    pending: (orgId: string | null) =>
      orgId ? `${CONVERSION_BASE}/pending?orgId=${encodeURIComponent(orgId)}` : `${CONVERSION_BASE}/pending`,
  } as const;

  function unwrap<T>(body: unknown): T {
    return (body && typeof body === 'object' && 'data' in (body as object) ? (body as { data: T }).data : body) as T;
  }

  async function readJson<T>(response: Response, fallback: string): Promise<T> {
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(extractApiError(body, fallback));
    return unwrap<T>(body);
  }

  export type PreviewProgress = { checked: number; total: number };
  export interface PreviewOptions { signal?: AbortSignal; onProgress?: (progress: PreviewProgress) => void }
  function waitForPreview(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException('Preview cancelled', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  export async function fetchPolicyPreview(policyId: string, options: PreviewOptions = {}): Promise<PolicyConversionPreview> {
    for (;;) {
      if (options.signal?.aborted) throw new DOMException('Preview cancelled', 'AbortError');
      const response = options.signal
        ? await fetchWithAuth(conversionPaths.preview(policyId), { signal: options.signal })
        : await fetchWithAuth(conversionPaths.preview(policyId));
      const value = await readJson<PolicyConversionPreview | {
        status: 'running'; progress: PreviewProgress;
      }>(response, 'Failed to load the conversion preview');
      if ('status' in value && value.status === 'running') {
        options.onProgress?.(value.progress);
        await waitForPreview(options.signal);
        continue;
      }
      return value as PolicyConversionPreview;
    }
  }

  export async function fetchPendingCounts(orgId: string | null): Promise<PendingCounts> {
    return readJson(await fetchWithAuth(conversionPaths.pending(orgId)), 'Failed to count pending conversions');
  }

  export const convertBody = (previewHash: string, sourceIds?: string[]) =>
    sourceIds ? { previewHash, sourceIds } : { previewHash };
  export const retireBody = (sourceTable: ConversionSourceTable, sourceId: string, reason: 'operator' | `unconvertible:${string}`) =>
    ({ sourceTable, sourceId, reason });

  export const readConvertResult = (body: unknown): ConvertResult => unwrap<ConvertResult>(body);
  export const readPartnerConvertResult = (body: unknown): PartnerConvertResult => unwrap<PartnerConvertResult>(body);
  ```
  Then add to `TARGET_GLOBS` in `no-silent-mutations.test.ts`:
  ```ts
    'src/components/monitoring/conversion/NeedsConversionPanel.tsx',
    'src/components/monitoring/conversion/ConversionPendingBanner.tsx',
    'src/components/admin/MonitorConversionAdmin.tsx',
  ```
  (Add these entries with Task 7, after all three files exist; `no-silent-mutations.test.ts:694–695` asserts every target exists.)

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/monitoring/conversion/conversionApi.test.ts && npx tsc --noEmit -p .`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring/conversion/ apps/web/src/lib/__tests__/no-silent-mutations.test.ts && git commit -m "feat(web): conversion client — W05c1 paths and shapes in one module"`

---

### Task 2: `siblingLinks` — a tab can see the policy's other feature links (PR1)

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/types.ts` (`FeatureTabProps`, lines 38–53)
- Modify: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (`renderFeatureTab`, lines 421-428)
- Test: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx`

**Interfaces:** Produces `FeatureTabProps.siblingLinks?: FeatureLink[]` — every link on the policy (including the tab's own), read-only. `MonitorsTab` uses it in Tasks 3 and 5 to find the `monitoring` link and to decide whether the Needs-conversion panel may render. Every other tab ignores it.

- [ ] **Step 1: Write the failing test** — append to `ConfigPolicyDetailPage.test.tsx` (after the existing `vi.mock('./featureTabs/BackupTab', …)` block, line 30):
  ```tsx
  vi.mock('./featureTabs/MonitorsTab', () => ({
    default: (props: { siblingLinks?: Array<{ featureType: string }> }) => (
      <div data-testid="monitors-tab-editor" data-sibling-types={(props.siblingLinks ?? []).map((l) => l.featureType).join(',')} />
    ),
  }));
  ```
  and a case:
  ```tsx
  it('passes every feature link on the policy to the Monitors tab as siblingLinks (W05c2)', async () => {
    mockPolicy({ orgId: 'org-1', partnerId: null }, [
      { id: 'l-mon', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items: [] } },
      { id: 'l-svc', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [] } },
    ]);
    window.location.hash = '#monitors';
    render(<ConfigPolicyDetailPage policyId="pol-1" />);
    const tab = await screen.findByTestId('monitors-tab-editor');
    expect(tab.getAttribute('data-sibling-types')).toBe('monitors,monitoring');
  });
  ```
  (Use whatever prop name the existing cases pass to `ConfigPolicyDetailPage` — check the first `render(` in the file and mirror it.)
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx` → `expected '' to be 'monitors,monitoring'`.
- [ ] **Step 3: Implement.** `types.ts`, inside `FeatureTabProps`:
  ```ts
    /**
     * Every feature link on the policy, including this tab's own. Read-only:
     * a tab that needs to WRITE a sibling link (MonitorsTab's Check interval
     * writes the `monitoring` link) still goes through useFeatureLink and
     * reports it with onLinkChanged(link, thatFeatureType). (W05c2)
     */
    siblingLinks?: FeatureLink[];
  ```
  `ConfigPolicyDetailPage.tsx` `renderFeatureTab` props object: add `siblingLinks: featureLinks,` after `parentLink: parentLinkFor(ft),`.
- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts && npx tsc --noEmit -p .`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/configurationPolicies/featureTabs/types.ts apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx && git commit -m "feat(web): feature tabs receive the policy's sibling links"`

---

### Task 3: Check interval on the Monitors tab, written through to the `monitoring` link (PR1)

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (props 52-58; state after 73; `handleSave` 168-183; render after the attach `<select>` block, ~line 262)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts:1–85` (runAction at the shared mutation boundary); `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35–59`.
- Modify: `apps/web/src/locales/*/policies.json` (8 files, `configurationPolicies.featureTabs.monitorsTab`)
- Test: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx`

**Interfaces:**
- Consumes: `siblingLinks` (Task 2); `useFeatureLink.save(linkId | null, { featureType: 'monitoring', featurePolicyId: null, inlineSettings })` → `POST/PATCH /configuration-policies/:policyId/features[/:linkId]`; `monitoringInlineSettingsSchema` (`packages/shared/src/validators/index.ts:924`): `{ checkIntervalSeconds: int 10..3600 default 60, watches: [...] }` — the API decomposes it into `config_policy_monitoring_settings` + `config_policy_monitoring_watches` (`services/configurationPolicy.ts:907-931`), which is the row the agent config builder reads (`routes/agents/helpers.ts:2304-2313`). Spec §Data model: this row stays keyed by the `monitoring` link until W05d.
- Produces: an **Agent collection** block on the Monitors tab with one field, *Check interval (seconds)*; on Save, if changed, PATCHes the existing `monitoring` link with its watches untouched or POSTs `{ checkIntervalSeconds, watches: [] }` when the policy has none, then `onLinkChanged(result, 'monitoring')`.

- [ ] **Step 1: Write the failing tests** — append to `MonitorsTab.test.tsx`:
  ```tsx
  const monitoringLink = (over: Partial<{ id: string; inlineSettings: Record<string, unknown> }> = {}) => ({
    id: 'link-svc', featureType: 'monitoring' as const, featurePolicyId: null,
    inlineSettings: { checkIntervalSeconds: 60, watches: [{ watchType: 'service', name: 'Spooler' }] },
    ...over,
  });
  const ownMonitorsLink = { id: 'link-1', featureType: 'monitors' as const, featurePolicyId: null, inlineSettings: { items: [{ monitorId: 'm1', enabled: true }] } };

  describe('MonitorsTab — check interval write-through (W05c2)', () => {
    it('PATCHes the existing monitoring link with the new interval and its watches untouched', async () => {
      render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink, monitoringLink()]} />);
      const input = (await screen.findByTestId('monitors-tab-check-interval')) as HTMLInputElement;
      expect(input.value).toBe('60');
      fireEvent.change(input, { target: { value: '120' } });
      clickSave();
      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
      const [linkId, payload] = saveMock.mock.calls[1] as unknown as [string | null, { featureType: string; inlineSettings: Record<string, unknown> }];
      expect(linkId).toBe('link-svc');
      expect(payload.featureType).toBe('monitoring');
      expect(payload.inlineSettings).toEqual({ checkIntervalSeconds: 120, watches: [{ watchType: 'service', name: 'Spooler' }] });
      expect(baseProps.onLinkChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'link-1' }), 'monitoring');
    });

    it('creates an empty-watch monitoring link when the policy has none', async () => {
      render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink]} />);
      fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '30' } });
      clickSave();
      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
      const [linkId, payload] = saveMock.mock.calls[1] as unknown as [string | null, { inlineSettings: Record<string, unknown> }];
      expect(linkId).toBeNull();
      expect(payload.inlineSettings).toEqual({ checkIntervalSeconds: 30, watches: [] });
    });

    it('leaves the monitoring link alone when the interval did not change', async () => {
      render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink, monitoringLink()]} />);
      await screen.findByTestId('monitors-tab-check-interval');
      clickSave();
      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    });

    it('refuses an interval outside 10–3600 without saving anything', async () => {
      render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} siblingLinks={[ownMonitorsLink]} />);
      fireEvent.change(await screen.findByTestId('monitors-tab-check-interval'), { target: { value: '5' } });
      clickSave();
      expect(await screen.findByText(/between 10 and 3600/i)).toBeInTheDocument();
      expect(saveMock).not.toHaveBeenCalled();
    });
  });
  ```
  (The `saveMock` in this file returns `{ id: 'link-1' }` for every call — that is why the `onLinkChanged` assertion matches `id: 'link-1'` for the monitoring save too.)
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx` → `Unable to find an element by: [data-testid="monitors-tab-check-interval"]`.
- [ ] **Step 3: Implement.** In `MonitorsTab.tsx`:
  ```tsx
  // props
  export default function MonitorsTab({ policyId, existingLink, onLinkChanged, linkedPolicyId, parentLink, siblingLinks }: FeatureTabProps) {
  …
  const CHECK_INTERVAL_MIN = 10;
  const CHECK_INTERVAL_MAX = 3600;
  const CHECK_INTERVAL_DEFAULT = 60;

  function readCheckInterval(link: InlineSettingsLike): number {
    const raw = (link?.inlineSettings as { checkIntervalSeconds?: unknown } | null | undefined)?.checkIntervalSeconds;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : CHECK_INTERVAL_DEFAULT;
  }
  function readWatches(link: InlineSettingsLike): unknown[] {
    const raw = (link?.inlineSettings as { watches?: unknown } | null | undefined)?.watches;
    return Array.isArray(raw) ? raw : [];
  }
  ```
  state (after the catalog state):
  ```tsx
  // Spec §Data model: until W05d the agent reads check_interval_seconds off the
  // `monitoring` link's settings row, so the Monitors tab writes THAT link —
  // creating an empty-watch one when the policy has none.
  const monitoringLink = siblingLinks?.find((l) => l.featureType === "monitoring");
  const savedCheckInterval = readCheckInterval(monitoringLink);
  const [checkInterval, setCheckInterval] = useState<string>(String(savedCheckInterval));
  const [checkIntervalError, setCheckIntervalError] = useState<string>();
  const [inheritance, setInheritance] = useState<"cumulative" | "replace">(
    (existingLink?.inlineSettings as { inheritance?: string })?.inheritance === "replace" ? "replace" : "cumulative");
  useEffect(() => { setCheckInterval(String(savedCheckInterval)); }, [savedCheckInterval]);
  ```
  save (replace `handleSave`):
  ```tsx
  const saveAttachments = async (): Promise<boolean> => {
    if (items.length === 0 && inheritance === "cumulative") {
      if (existingLink) {
        const ok = await remove(existingLink.id);
        if (!ok) return false;
        onLinkChanged(null, "monitors");
      }
      return true;
    }
    const result = await save(existingLink?.id ?? null, {
      featureType: "monitors",
      featurePolicyId: null, // inline settings — never stamp the parent CONFIG policy's own id
      inlineSettings: { items: buildPayloadItems(), inheritance },
    });
    if (result) onLinkChanged(result, "monitors");
    return !!result;
  };

  const saveCheckInterval = async (): Promise<void> => {
    const parsed = Number(checkInterval);
    if (parsed === savedCheckInterval) return;
    const result = await save(monitoringLink?.id ?? null, {
      featureType: "monitoring",
      featurePolicyId: null,
      inlineSettings: { ...(monitoringLink?.inlineSettings ?? {}), checkIntervalSeconds: parsed, watches: readWatches(monitoringLink) },
    });
    if (result) onLinkChanged(result, "monitoring");
  };

  const validateCheckInterval = (): boolean => {
    const parsed = Number(checkInterval);
    const ok = Number.isInteger(parsed) && parsed >= CHECK_INTERVAL_MIN && parsed <= CHECK_INTERVAL_MAX;
    setCheckIntervalError(ok ? undefined : i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.checkIntervalInvalid"));
    return ok;
  };

  const handleSave = async () => {
    clearError();
    if (!validateCheckInterval()) return;
    if (!(await saveAttachments())) return;
    await saveCheckInterval();
  };
  ```
  render — a new block after the attach `<select>` `</div>` and before the `items.length === 0` ternary:
  ```tsx
  <fieldset className="rounded-md border bg-background p-4" data-testid="monitors-tab-agent-collection">
    <legend className="px-1 text-sm font-medium">
      {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.agentCollectionTitle")}
    </legend>
    <label className="mt-2 block text-sm" htmlFor="monitors-tab-check-interval">
      {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.checkIntervalLabel")}
    </label>
    <input
      id="monitors-tab-check-interval"
      data-testid="monitors-tab-check-interval"
      type="number"
      min={CHECK_INTERVAL_MIN}
      max={CHECK_INTERVAL_MAX}
      step={1}
      value={checkInterval}
      disabled={isInherited}
      onChange={(e) => { setCheckInterval(e.target.value); setCheckIntervalError(undefined); }}
      className="mt-1 h-9 w-40 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
    />
    <p className="mt-1 text-xs text-muted-foreground">
      {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.checkIntervalHint")}
    </p>
    {checkIntervalError && <p className="mt-1 text-xs text-destructive">{checkIntervalError}</p>}
  </fieldset>
  ```
  Also pass `error={error ?? catalogError ?? checkIntervalError}` is **not** needed — the field shows its own error; keep the shell's `error` as is.
  `useFeatureLink.ts` currently performs raw mutations (verified lines 25–43, 63–73). Route those same requests through `runAction` without changing its `{ save, remove, saving, error, clearError }` contract. Import:
  ```ts
  import { runAction, ActionError } from '@/lib/runAction';
  import { showToast } from '../../shared/Toast';
  import { i18n } from '@/lib/i18n';
  ```
  In `save`, retain the existing `url`, `method` and `body` construction (the argument is `existingLinkId`); replace only the request/response-check/parse block with:
  ```ts
  const data = await runAction<FeatureLink>({
    request: () => fetchWithAuth(url, { method, body: JSON.stringify(body) }),
    parseSuccess: (value) => (value as { data: FeatureLink }).data ?? value as FeatureLink,
    successMessage: i18n.t('common:states.saved'), errorFallback: i18n.t('monitoring:editor.errors.save'),
  });
  return data;
  ```
  In `remove`, replace the request/response-check block (retain `return true`) with:
  ```ts
  await runAction({
    request: () => fetchWithAuth(`/configuration-policies/${policyId}/features/${linkId}`, { method: 'DELETE' }),
    successMessage: i18n.t('common:states.saved'), errorFallback: i18n.t('monitoring:editor.errors.save'),
  });
  ```
  At the start of `save` catch, retain existing inline `setError` and null return, adding:
  ```ts
  if (err instanceof ActionError && err.status === 401) return null;
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: i18n.t('monitoring:editor.errors.save') });
  ```
  At the start of `remove` catch add:
  ```ts
  if (err instanceof ActionError && err.status === 401) return false;
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: i18n.t('monitoring:editor.errors.save') });
  ```
  Register `src/components/configurationPolicies/featureTabs/useFeatureLink.ts` in TARGET_GLOBS. Existing localized `states.saved` and `editor.errors.save` need no new keys. Remove the unused `extractApiError` import.
  i18n (`policies.json` → `configurationPolicies.featureTabs.monitorsTab`, all 8 locales):

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | `agentCollectionTitle` | Agent collection | Agent-Erfassung | Recolección del agente | Collecte par l'agent | Raccolta dell'agente | Coleta do agente | Aracı toplama |
  | `checkIntervalLabel` | Check interval (seconds) | Prüfintervall (Sekunden) | Intervalo de comprobación (segundos) | Intervalle de vérification (secondes) | Intervallo di controllo (secondi) | Intervalo de verificação (segundos) | Kontrol aralığı (saniye) |
  | `checkIntervalHint` | How often agents under this policy check service and process monitors (10–3600). | Wie oft Agenten unter dieser Richtlinie Dienst- und Prozessmonitore prüfen (10–3600). | Con qué frecuencia los agentes bajo esta política comprueban los monitores de servicios y procesos (10–3600). | Fréquence à laquelle les agents sous cette politique vérifient les moniteurs de services et de processus (10–3600). | Ogni quanto gli agenti sotto questa policy controllano i monitor di servizi e processi (10–3600). | Com que frequência os agentes desta política verificam os monitores de serviços e processos (10–3600). | Bu ilkedeki aracıların hizmet ve süreç monitörlerini ne sıklıkla kontrol ettiği (10–3600). |
  | `checkIntervalInvalid` | Check interval must be between 10 and 3600 seconds. | Das Prüfintervall muss zwischen 10 und 3600 Sekunden liegen. | El intervalo de comprobación debe estar entre 10 y 3600 segundos. | L'intervalle de vérification doit être compris entre 10 et 3600 secondes. | L'intervallo di controllo deve essere compreso tra 10 e 3600 secondi. | O intervalo de verificação deve ficar entre 10 e 3600 segundos. | Kontrol aralığı 10 ile 3600 saniye arasında olmalıdır. |

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx src/lib/i18n && npx tsc --noEmit -p .`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales/*/policies.json && git commit -m "feat(web): policy Monitors tab owns the agent check interval (writes the monitoring link until W05d)"`

---

### Task 4: Inheritance switch — *Add to inherited monitors* / *Replace inherited monitors* (PR1)

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (state next to `items`; `saveAttachments` and `handleOverride` payloads; render before the attached list)
- Modify: `apps/web/src/locales/*/policies.json` (8 files)
- Test: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx`

**Interfaces:**
- Consumes (W05c1): `monitors` link `inlineSettings.inheritance: 'cumulative' | 'replace'` (default `cumulative`); `resolveMonitorsForDevice` honours `replace` (closest policy's attachment set wins, parent attachments not consulted).
- Produces: the switch on the tab; every save of the `monitors` link carries `inheritance`; in `replace` mode the tab lists the parent's attachments that are being ignored (spec §Risks: "the policy Monitors tab shows the switch state and, in replace mode, lists the inherited monitors being ignored"). The list is the **direct parent's** attachments (`parentLink`), which is what the tab can see; the resolver's full chain is not re-derived client-side.

- [ ] **Step 1: Write the failing tests** — append to `MonitorsTab.test.tsx`:
  ```tsx
  describe('MonitorsTab — inheritance switch (W05c2)', () => {
    const parentLink = { id: 'link-parent', featureType: 'monitors' as const, featurePolicyId: null, inlineSettings: { items: [{ monitorId: 'm2', enabled: true }] } };

    it('defaults to cumulative and saves the choice with the items', async () => {
      render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} />);
      const cumulative = (await screen.findByTestId('monitors-tab-inheritance-cumulative')) as HTMLInputElement;
      expect(cumulative.checked).toBe(true);
      fireEvent.click(screen.getByTestId('monitors-tab-inheritance-replace'));
      clickSave();
      await waitFor(() => expect(saveMock).toHaveBeenCalled());
      expect(inlineSettingsFromCall(saveMock.mock.calls[0] as unknown[])).toEqual({
        items: [{ monitorId: 'm1', enabled: true, overrides: undefined, sortOrder: 0 }],
        inheritance: 'replace',
      });
    });

    it('saves an empty replacement so inherited monitors stay suppressed', async () => {
      render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink,
        inlineSettings: { items: [], inheritance: 'replace' } }} parentLink={parentLink} />);
      await screen.findByTestId('monitors-tab-inheritance-replace');
      clickSave();
      await waitFor(() => expect(saveMock).toHaveBeenCalled());
      expect(inlineSettingsFromCall(saveMock.mock.calls[0])).toEqual({ items: [], inheritance: 'replace' });
      expect(removeMock).not.toHaveBeenCalled();
    });
    it('seeds the switch from the saved link', async () => {
      render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink, inlineSettings: { ...ownMonitorsLink.inlineSettings, inheritance: 'replace' } }} parentLink={parentLink} />);
      expect(((await screen.findByTestId('monitors-tab-inheritance-replace')) as HTMLInputElement).checked).toBe(true);
    });

    it('lists the parent monitors being ignored while replacing', async () => {
      render(<MonitorsTab {...baseProps} existingLink={{ ...ownMonitorsLink, inlineSettings: { ...ownMonitorsLink.inlineSettings, inheritance: 'replace' } }} parentLink={parentLink} />);
      const ignored = await screen.findByTestId('monitors-tab-ignored-inherited');
      await waitFor(() => expect(ignored.textContent).toContain('Disk full')); // m2's catalog name
    });

    it('shows no ignored list in cumulative mode', async () => {
      render(<MonitorsTab {...baseProps} existingLink={ownMonitorsLink} parentLink={parentLink} />);
      await screen.findByTestId('monitors-tab-inheritance-cumulative');
      expect(screen.queryByTestId('monitors-tab-ignored-inherited')).toBeNull();
    });
  });
  ```
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx` → `Unable to find … monitors-tab-inheritance-cumulative`.
- [ ] **Step 3: Implement.** `MonitorsTab.tsx`:
  ```tsx
  type InheritanceMode = "cumulative" | "replace";
  function readInheritance(link: InlineSettingsLike): InheritanceMode {
    const raw = (link?.inlineSettings as { inheritance?: unknown } | null | undefined)?.inheritance;
    return raw === "replace" ? "replace" : "cumulative";
  }
  …
  // Task 3 already declares inheritance; retain that state and add the reset below.
  useEffect(() => { setInheritance(readInheritance(existingLink)); }, [existingLink]);
  const parentItems = seedItems(parentLink);
  ```
  D11: retain an empty replacement link; delete only empty cumulative links. W05d additionally preserves links owning settings/historical watches. Payloads — in `saveAttachments` and `handleOverride` replace `inlineSettings: { items: buildPayloadItems() }` with `inlineSettings: { items: buildPayloadItems(), inheritance }`.
  Render — a fieldset placed **after** the Agent collection block (Task 3) and before the attached list:
  ```tsx
  <fieldset className="rounded-md border bg-background p-4" data-testid="monitors-tab-inheritance">
    <legend className="px-1 text-sm font-medium">
      {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.inheritanceTitle")}
    </legend>
    {(["cumulative", "replace"] as const).map((mode) => (
      <label key={mode} className="mt-2 flex items-start gap-2 text-sm">
        <input
          type="radio"
          name="monitors-tab-inheritance"
          data-testid={`monitors-tab-inheritance-${mode}`}
          checked={inheritance === mode}
          disabled={isInherited}
          onChange={() => setInheritance(mode)}
        />
        <span>
          <span className="font-medium">
            {i18n.t(`policies:configurationPolicies.featureTabs.monitorsTab.inheritance.${mode}`)}
          </span>
          <span className="block text-xs text-muted-foreground">
            {i18n.t(`policies:configurationPolicies.featureTabs.monitorsTab.inheritance.${mode}Hint`)}
          </span>
        </span>
      </label>
    ))}
    {inheritance === "replace" && parentItems.length > 0 && (
      <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-testid="monitors-tab-ignored-inherited">
        <p className="font-medium">
          {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.ignoredInherited", { count: parentItems.length })}
        </p>
        <ul className="mt-1 list-disc pl-4">
          {parentItems.map((it) => (
            <li key={it.monitorId}>{catalogById.get(it.monitorId)?.name ?? it.monitorId}</li>
          ))}
        </ul>
      </div>
    )}
  </fieldset>
  ```
  i18n (`policies.json` → `configurationPolicies.featureTabs.monitorsTab`, 8 locales):

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | `inheritanceTitle` | Inherited monitors | Vererbte Monitore | Monitores heredados | Moniteurs hérités | Monitor ereditati | Monitores herdados | Devralınan monitörler |
  | `inheritance.cumulative` | Add to inherited monitors | Zu vererbten Monitoren hinzufügen | Agregar a los monitores heredados | Ajouter aux moniteurs hérités | Aggiungi ai monitor ereditati | Adicionar aos monitores herdados | Devralınan monitörlere ekle |
  | `inheritance.cumulativeHint` | Devices get the parent policies' monitors plus these. | Geräte erhalten die Monitore der übergeordneten Richtlinien plus diese. | Los dispositivos reciben los monitores de las políticas superiores más estos. | Les appareils reçoivent les moniteurs des politiques parentes en plus de ceux-ci. | I dispositivi ricevono i monitor delle policy superiori più questi. | Os dispositivos recebem os monitores das políticas superiores mais estes. | Cihazlar üst ilkelerin monitörlerini ve bunları alır. |
  | `inheritance.replace` | Replace inherited monitors | Vererbte Monitore ersetzen | Reemplazar los monitores heredados | Remplacer les moniteurs hérités | Sostituisci i monitor ereditati | Substituir os monitores herdados | Devralınan monitörleri değiştir |
  | `inheritance.replaceHint` | Only this policy's monitors apply; parent attachments are ignored. Set by conversion to keep inline rules' behavior. | Nur die Monitore dieser Richtlinie gelten; übergeordnete Zuordnungen werden ignoriert. Wird bei der Konvertierung gesetzt, um das Verhalten von Inline-Regeln zu erhalten. | Solo se aplican los monitores de esta política; se ignoran los adjuntos superiores. La conversión lo establece para conservar el comportamiento de las reglas en línea. | Seuls les moniteurs de cette politique s'appliquent ; les rattachements parents sont ignorés. Défini par la conversion pour conserver le comportement des règles intégrées. | Si applicano solo i monitor di questa policy; gli allegati superiori vengono ignorati. Impostato dalla conversione per mantenere il comportamento delle regole inline. | Só os monitores desta política se aplicam; os anexos superiores são ignorados. Definido pela conversão para manter o comportamento das regras embutidas. | Yalnızca bu ilkenin monitörleri geçerlidir; üst ekler yok sayılır. Satır içi kuralların davranışını korumak için dönüştürme tarafından ayarlanır. |
  | `ignoredInherited_one` / `_other` | {{count}} inherited monitor is ignored while replacing: / {{count}} inherited monitors are ignored while replacing: | {{count}} vererbter Monitor wird beim Ersetzen ignoriert: / {{count}} vererbte Monitore werden beim Ersetzen ignoriert: | Se ignora {{count}} monitor heredado al reemplazar: / Se ignoran {{count}} monitores heredados al reemplazar: | {{count}} moniteur hérité est ignoré lors du remplacement : / {{count}} moniteurs hérités sont ignorés lors du remplacement : | {{count}} monitor ereditato viene ignorato durante la sostituzione: / {{count}} monitor ereditati vengono ignorati durante la sostituzione: | {{count}} monitor herdado é ignorado ao substituir: / {{count}} monitores herdados são ignorados ao substituir: | Değiştirme sırasında {{count}} devralınan monitör yok sayılıyor: / Değiştirme sırasında {{count}} devralınan monitör yok sayılıyor: |

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx src/lib/i18n && npx tsc --noEmit -p .`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx apps/web/src/locales/*/policies.json && git commit -m "feat(web): Monitors tab inheritance switch (cumulative / replace) with the ignored-inherited list"`

---

### Task 5: Needs-conversion panel on the policy Monitors tab (PR1)

**Files:**
- Create: `apps/web/src/components/monitoring/conversion/NeedsConversionPanel.tsx`
- Create: `apps/web/src/components/monitoring/conversion/NeedsConversionPanel.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx` (mount below the attached list; `hasLegacyRows` from `siblingLinks`; `refreshLinks` after a change)
- Modify: `apps/web/src/locales/*/monitoring.json` (8 files, new `conversion` block)
- Test: `MonitorsTab.test.tsx` (mount gate)

**Interfaces:**
- Consumes: `fetchPolicyPreview`, `conversionPaths.convert/retire/revert`, `convertBody`, `retireBody`, `readConvertResult` (Task 1); `GET /configuration-policies/:id/features` → `{ data: FeatureLink[] }` (`routes/configurationPolicies/featureLinks.ts:86-101`) for the post-change refresh; the persistent ledger (Task 8) owns Undo.
- Produces: `NeedsConversionPanel({ policyId, hasLegacyRows, onChanged })`. Renders nothing when `hasLegacyRows` is false or the completed, unblocked preview returns zero items (spec: "the tab never shows it on a fresh policy", "disappears when the policy has nothing left"). Each item: name, source-table badge, outcome, reason (unconvertible), `notes`, `openAlerts`, the proposed monitors with their roles; **Convert** per convertible item, **Retire** (with reason) per unconvertible item, **Convert all convertible**; `blockedBy` banners; equivalence deltas refuse conversion and list every delta; after conversion or retirement, refresh the persistent ledger (Task 8); its **Undo** control obeys `revertable`.

- [ ] **Step 1: Write the failing tests** — `NeedsConversionPanel.test.tsx`:
  ```tsx
  import '@/lib/i18n';
  import { fireEvent, render, screen, waitFor } from '@testing-library/react';
  import { beforeEach, describe, expect, it, vi } from 'vitest';

  const { fetchWithAuth, runAction, showToast, fetchPolicyPreview } = vi.hoisted(() => ({
    fetchWithAuth: vi.fn(),
    runAction: vi.fn(async ({ request, parseSuccess }: { request: () => Promise<Response>; parseSuccess?: (d: unknown) => unknown }) => {
      const res = await request();
      const body = await res.json();
      return parseSuccess ? parseSuccess(body) : body;
    }),
    showToast: vi.fn(),
    fetchPolicyPreview: vi.fn(),
  }));
  vi.mock('../../../stores/auth', () => ({ fetchWithAuth }));
  vi.mock('@/lib/runAction', () => ({
    runAction,
    ActionError: class ActionError extends Error { constructor(message: string, public status: number) { super(message); } },
  }));
  vi.mock('../../shared/Toast', () => ({ showToast }));
  vi.mock('./conversionApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./conversionApi')>();
    return { ...actual, fetchPolicyPreview };
  });

  import NeedsConversionPanel from './NeedsConversionPanel';

  const json = (body: unknown, status = 200): Response =>
    ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

  const item = (over: Partial<import('./conversionApi').ConversionPreviewItem> = {}) => ({
    sourceTable: 'config_policy_alert_rules' as const, sourceId: 'src-1', name: 'CPU > 80', outcome: 'convertible' as const,
    proposed: [{ role: 'primary' as const, kind: 'cpu', name: 'CPU > 80', condition: { threshold: 80 }, severity: 'high', enabled: true, cooldownMinutes: 5, autoResolve: true, deliveryMode: 'inherit' as const, deliveryChannelIds: [], escalationPolicyId: null, responses: [] }],
    notes: ['Delivery: inherit (rule had no channels)'], openAlerts: 2, ...over,
  });
  const preview = (over: Record<string, unknown> = {}) => ({
    policyId: 'pol-1', previewHash: 'hash-1', items: [item()], inheritanceMode: 'replace',
    equivalence: { devicesChecked: 12, deltas: [] }, ...over,
  });

  beforeEach(() => { vi.clearAllMocks(); fetchPolicyPreview.mockResolvedValue(preview()); });

  describe('NeedsConversionPanel', () => {
  it('shows missing prerequisites even when the blocked preview has no items', async () => {
    fetchPolicyPreview.mockResolvedValue(preview({ items: [], blockedBy: 'prerequisite_missing' }));
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    expect(await screen.findByTestId('conversion-blocked')).toHaveTextContent(/prerequisite/i);
  });

    it('cancels an in-flight preview when the policy changes or the panel unmounts', async () => {
      fetchPolicyPreview.mockImplementation(() => new Promise(() => {}));
      const view = render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
      await waitFor(() => expect(fetchPolicyPreview).toHaveBeenCalledTimes(1));
      const first = fetchPolicyPreview.mock.calls[0]![1].signal as AbortSignal;
      view.rerender(<NeedsConversionPanel policyId="pol-2" hasLegacyRows onChanged={vi.fn()} />);
      await waitFor(() => expect(fetchPolicyPreview).toHaveBeenCalledTimes(2));
      expect(first.aborted).toBe(true);
      const second = fetchPolicyPreview.mock.calls[1]![1].signal as AbortSignal;
      view.unmount(); expect(second.aborted).toBe(true);
    });
    it('renders nothing and calls no API when the policy has no legacy rows', () => {
      const { container } = render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows={false} onChanged={vi.fn()} />);
      expect(container).toBeEmptyDOMElement();
      expect(fetchPolicyPreview).not.toHaveBeenCalled();
    });

    it('renders nothing once the preview has no items left', async () => {
      fetchPolicyPreview.mockResolvedValue(preview({ items: [] }));
      const { container } = render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
      await waitFor(() => expect(fetchPolicyPreview).toHaveBeenCalled());
      await waitFor(() => expect(container).toBeEmptyDOMElement());
    });

    it('lists each item with its source, proposed monitors, notes and open alerts', async () => {
      render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
      const row = await screen.findByTestId('conversion-item-src-1');
      expect(row.textContent).toContain('CPU > 80');
      expect(row.textContent).toContain('Inline alert rule');
      expect(row.textContent).toContain('Delivery: inherit');
      expect(row.textContent).toMatch(/2 open alerts/);
      expect(screen.getByTestId('conversion-proposed-src-1-primary').textContent).toContain('cpu');
      expect(screen.getByText(/12 devices checked/)).toBeInTheDocument();
    });

    it('converts one item with the preview hash, shows success and reloads the ledger', async () => {
      const onChanged = vi.fn();
      fetchWithAuth.mockResolvedValue(json({ data: { conversionIds: ['conv-1'], retired: 1, monitorsCreated: 1 } }));
      render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={onChanged} />);
      fireEvent.click(await screen.findByTestId('conversion-convert-src-1'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
        '/monitor-definitions/conversion/policies/pol-1/convert',
        { method: 'POST', body: JSON.stringify({ previewHash: 'hash-1', sourceIds: ['src-1'] }) },
      ));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      expect(fetchPolicyPreview).toHaveBeenCalledTimes(2);
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    });

    it('Convert all sends every convertible id and none of the unconvertible ones', async () => {
      fetchPolicyPreview.mockResolvedValue(preview({ items: [item(), item({ sourceId: 'src-2', name: 'Custom', outcome: 'unconvertible', reason: 'unconvertible:custom', proposed: [] })] }));
      fetchWithAuth.mockResolvedValue(json({ data: { conversionIds: ['conv-1'], retired: 1, monitorsCreated: 1 } }));
      render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
      fireEvent.click(await screen.findByTestId('conversion-convert-all'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
        '/monitor-definitions/conversion/policies/pol-1/convert',
        { method: 'POST', body: JSON.stringify({ previewHash: 'hash-1', sourceIds: ['src-1'] }) },
      ));
    });

    it('shows the reason and a Retire action for an unconvertible item', async () => {
      fetchPolicyPreview.mockResolvedValue(preview({ items: [item({ outcome: 'unconvertible', reason: 'unconvertible:nested_group', proposed: [] })] }));
      fetchWithAuth.mockResolvedValue(json({ data: { conversionId: 'retire-1' } }));
      render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
      const row = await screen.findByTestId('conversion-item-src-1');
      expect(row.textContent).toMatch(/nested/i);
      expect(screen.queryByTestId('conversion-convert-src-1')).toBeNull();
      expect(screen.queryByTestId('conversion-retire-reason-src-1')).toBeNull();
      fireEvent.click(screen.getByTestId('conversion-retire-src-1'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
        '/monitor-definitions/conversion/retire',
        { method: 'POST', body: JSON.stringify({ sourceTable: 'config_policy_alert_rules', sourceId: 'src-1', reason: 'unconvertible:nested_group' }) },
      ));
    });

    it('refuses to convert while the equivalence check reports deltas, and lists them', async () => {
      fetchPolicyPreview.mockResolvedValue(preview({ equivalence: { devicesChecked: 3, deltas: [{ deviceId: 'dev-9', detail: 'gains CPU > 80 (warning)' }] } }));
      render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
      expect((await screen.findByTestId('conversion-convert-src-1')) as HTMLButtonElement).toBeDisabled();
      expect(screen.getByTestId('conversion-deltas').textContent).toContain('gains CPU > 80');
    });

    it('explains a blocked preview instead of offering Convert', async () => {
      fetchPolicyPreview.mockResolvedValue(preview({ blockedBy: 'parent_unconverted' }));
      render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
      expect(await screen.findByTestId('conversion-blocked')).toHaveTextContent(/parent policy/i);
      expect((screen.getByTestId('conversion-convert-src-1') as HTMLButtonElement)).toBeDisabled();
    });
  });
  ```
  And in `MonitorsTab.test.tsx`:
  ```tsx
  vi.mock('../../monitoring/conversion/NeedsConversionPanel', () => ({
    default: (p: { hasLegacyRows: boolean }) => <div data-testid="needs-conversion-panel" data-legacy={String(p.hasLegacyRows)} />,
  }));
  describe('MonitorsTab — Needs-conversion mount gate (W05c2)', () => {
    it('passes hasLegacyRows=true when the policy carries an alert_rule, a watch-bearing monitoring or an automation link', async () => {
      render(<MonitorsTab {...baseProps} siblingLinks={[{ id: 'l1', featureType: 'alert_rule', featurePolicyId: null, inlineSettings: { items: [{ name: 'x' }] } }]} />);
      expect((await screen.findByTestId('needs-conversion-panel')).getAttribute('data-legacy')).toBe('true');
    });
    it('includes an automation-only policy using the canonical singular feature type', async () => {
      render(<MonitorsTab {...baseProps} siblingLinks={[{ id: 'workflow', featureType: 'automation', featurePolicyId: null,
        inlineSettings: { items: [{ triggerType: 'event', eventType: 'alert.triggered' }] } }]} />);
      expect(await screen.findByTestId('needs-conversion-panel')).toHaveAttribute('data-legacy', 'true');
    });
    it('passes hasLegacyRows=false for a monitoring link with no watches (the Check-interval carrier)', async () => {
      render(<MonitorsTab {...baseProps} siblingLinks={[{ id: 'l1', featureType: 'monitoring', featurePolicyId: null, inlineSettings: { checkIntervalSeconds: 60, watches: [] } }]} />);
      expect((await screen.findByTestId('needs-conversion-panel')).getAttribute('data-legacy')).toBe('false');
    });
  });
  ```
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/conversion src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx` → `Failed to resolve import "./NeedsConversionPanel"`.
- [ ] **Step 3: Implement.** `NeedsConversionPanel.tsx`:
  ```tsx
  import { useCallback, useEffect, useRef, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth } from '../../../stores/auth';
  import { ActionError, runAction } from '@/lib/runAction';
  import { showToast } from '../../shared/Toast';
  import {
    conversionPaths, convertBody, fetchPolicyPreview, readConvertResult, readRetireResult, retireBody,
    type ConversionPreviewItem, type ConvertResult, type PolicyConversionPreview, type PreviewProgress,
  } from './conversionApi';

  export interface NeedsConversionPanelProps {
    policyId: string;
    /** False when the policy has no legacy link — nothing renders and nothing is fetched. */
    hasLegacyRows: boolean;
    /** Fired after a successful convert, retire or undo so the tab reloads its links. */
    onChanged: () => void;
  }

  type Load = { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };

  export default function NeedsConversionPanel({ policyId, hasLegacyRows, onChanged }: NeedsConversionPanelProps) {
    const { t } = useTranslation(['monitoring', 'common']);
    const [preview, setPreview] = useState<PolicyConversionPreview | null>(null);
    const [load, setLoad] = useState<Load>({ status: 'idle' });
    const [busy, setBusy] = useState<string | null>(null);
const activePreview = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<PreviewProgress | null>(null);

  const reload = useCallback(async () => {
    activePreview.current?.abort();
    const controller = new AbortController(); activePreview.current = controller;
    setPreview(null); setProgress(null); setLoad({ status: 'loading' });
    try {
      const next = await fetchPolicyPreview(policyId, { signal: controller.signal, onProgress: (value) => { if (!controller.signal.aborted) setProgress(value); } });
      if (!controller.signal.aborted) { setPreview(next); setLoad({ status: 'ready' }); }
    } catch (err) {
      if (!controller.signal.aborted) setLoad({ status: 'error', error: err instanceof Error ? err.message : t('monitoring:conversion.errors.preview') });
    }
  }, [policyId, t]);
  useEffect(() => {
    if (hasLegacyRows) void reload();
    return () => activePreview.current?.abort();
  }, [hasLegacyRows, reload]);

    const handleActionFailure = (err: unknown, fallback: string) => {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
      // A stale previewHash (409) or any refused write means the preview moved: re-read it.
      void reload();
    };

    const convert = async (sourceIds: string[]) => {
      if (!preview || sourceIds.length === 0) return;
      setBusy(sourceIds.length === 1 ? sourceIds[0]! : 'all');
      try {
        const result = await runAction<ConvertResult>({
          request: () => fetchWithAuth(conversionPaths.convert(policyId), {
            method: 'POST',
            body: JSON.stringify(convertBody(preview.previewHash, sourceIds)),
          }),
          parseSuccess: readConvertResult,
          errorFallback: t('monitoring:conversion.errors.convert'),
        });
        showToast({
          type: 'success',
          message: t('monitoring:conversion.converted', { rows: result.retired, monitors: result.monitorsCreated }),
        });
        onChanged();
        await reload();
      } catch (err) {
        handleActionFailure(err, t('monitoring:conversion.errors.convert'));
      } finally {
        setBusy(null);
      }
    };

    const retire = async (item: ConversionPreviewItem) => {
      setBusy(item.sourceId);
      try {
        await runAction<{ conversionId: string }>({
          request: () => fetchWithAuth(conversionPaths.retire(), {
            method: 'POST',
            body: JSON.stringify(retireBody(item.sourceTable, item.sourceId, item.reason?.startsWith('unconvertible:') ? item.reason as `unconvertible:${string}` : 'operator')),
          }),
          parseSuccess: readRetireResult,
          errorFallback: t('monitoring:conversion.errors.retire'),
          successMessage: t('monitoring:conversion.retired', { name: item.name }),
        });
        onChanged();
        await reload();
      } catch (err) {
        handleActionFailure(err, t('monitoring:conversion.errors.retire'));
      } finally {
        setBusy(null);
      }
    };

    if (!hasLegacyRows) return null;
    if (load.status === 'ready' && preview && !preview.blockedBy && preview.items.length === 0) return null;

    const deltas = preview?.equivalence.deltas ?? [];
    const blocked = preview?.blockedBy;
    const canConvert = load.status === 'ready' && !!preview && !blocked && deltas.length === 0 && busy === null;
    const convertible = (preview?.items ?? []).filter((it) => it.outcome === 'convertible');
    const reasonKey = (reason?: string) => `monitoring:conversion.reasons.${(reason ?? '').replace(/^unconvertible:/, '') || 'unknown'}`;

    return (
      <section className="rounded-md border border-warning/40 bg-warning/5 p-4" data-testid="needs-conversion-panel">
        <h3 className="text-sm font-semibold">{t('monitoring:conversion.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('monitoring:conversion.description')}</p>

        {load.status === 'loading' && <p className="mt-3 text-sm" data-testid="conversion-loading">{t('monitoring:conversion.checking')}{progress && <progress value={progress.checked} max={Math.max(1, progress.total)} aria-label={t('monitoring:conversion.checking')} data-testid="conversion-progress" />}</p>}
        {load.status === 'error' && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {load.error}
            <button type="button" className="ml-2 underline" onClick={() => void reload()}>{t('common:actions.retry')}</button>
          </div>
        )}

        {preview && (
          <>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('monitoring:conversion.devicesChecked', { count: preview.equivalence.devicesChecked })}
            </p>
            {blocked && (
              <div className="mt-3 rounded-md border px-3 py-2 text-sm" data-testid="conversion-blocked">
                {t(`monitoring:conversion.blocked.${blocked}`)}
              </div>
            )}
            {deltas.length > 0 && (
              <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="conversion-deltas">
                <p className="font-medium">{t('monitoring:conversion.refusedTitle', { count: deltas.length })}</p>
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {deltas.map((d) => <li key={`${d.deviceId}:${d.detail}`}>{d.deviceId}: {d.detail}</li>)}
                </ul>
              </div>
            )}

            <ul className="mt-3 space-y-2">
              {preview.items.map((item) => (
                <li key={`${item.sourceTable}:${item.sourceId}`} data-testid={`conversion-item-${item.sourceId}`} className="rounded-md border bg-background px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t(`monitoring:conversion.sourceTables.${item.sourceTable}`)}
                        {' · '}
                        {t(`monitoring:conversion.outcomes.${item.outcome}`)}
                        {item.openAlerts > 0 && <> · {t('monitoring:conversion.openAlerts', { count: item.openAlerts })}</>}
                      </p>
                    </div>
                    {item.outcome === 'convertible' ? (
                      <button
                        type="button"
                        data-testid={`conversion-convert-${item.sourceId}`}
                        disabled={!canConvert}
                        onClick={() => void convert([item.sourceId])}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {t('monitoring:conversion.convert')}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          data-testid={`conversion-retire-${item.sourceId}`}
                          disabled={busy !== null}
                          onClick={() => void retire(item)}
                          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60"
                        >
                          {t('monitoring:conversion.retire')}
                        </button>
                      </div>
                    )}
                  </div>
                  {item.outcome === 'unconvertible' && (
                    <p className="mt-1 text-xs text-destructive">{t([reasonKey(item.reason), 'monitoring:conversion.reasons.unknown'], { code: item.reason ?? '' })}</p>
                  )}
                  {item.notes.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                      {item.notes.map((n) => <li key={n}>{n}</li>)}
                    </ul>
                  )}
                  {item.proposed.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {item.proposed.map((p) => (
                        <li key={`${p.role}:${p.name}`} data-testid={`conversion-proposed-${item.sourceId}-${p.role}`} className="rounded-full border px-2 py-0.5 text-xs">
                          <span className="font-medium">{t(`monitoring:conversion.roles.${p.role}`)}</span>{' '}
                          {p.name} · {p.kind} · {t(`monitoring:severities.${p.severity}`, { defaultValue: p.severity })}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-3 flex justify-end">
              <button
                type="button"
                data-testid="conversion-convert-all"
                disabled={!canConvert || convertible.length === 0}
                onClick={() => void convert(convertible.map((it) => it.sourceId))}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
              >
                {t('monitoring:conversion.convertAll', { count: convertible.length })}
              </button>
            </div>
          </>
        )}
      </section>
    );
  }
  ```
  `MonitorsTab.tsx` — the gate and the refresh:
  ```tsx
  import NeedsConversionPanel from "../../monitoring/conversion/NeedsConversionPanel";
  …
  // A legacy link "has rows" when it can still hold an unretired inline rule,
  // watch or alert-triggered automation. An empty-watch `monitoring` link is
  // the Check-interval carrier (Task 3), not legacy config.
  function linkHasLegacyRows(link: { featureType: string; inlineSettings: Record<string, unknown> | null }): boolean {
    if (link.featureType === "alert_rule" || link.featureType === "automation") return true;
    if (link.featureType === "monitoring") return readWatches(link).length > 0;
    return false;
  }
  const hasLegacyRows = (siblingLinks ?? []).some(linkHasLegacyRows);

  const refreshLinks = async () => {
    const res = await fetchWithAuth(`/configuration-policies/${policyId}/features`);
    if (!res.ok) return;
    const json = await res.json();
    const links: Array<{ id: string; featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> | null }> =
      Array.isArray(json?.data) ? json.data : [];
    for (const type of ["monitors", "alert_rule", "monitoring", "automation"] as const) {
      const link = links.find((l) => l.featureType === type);
      onLinkChanged(link ? (link as FeatureLink) : null, type);
    }
  };
  ```
  (`FeatureLink` is imported as a type from `./types`; `onLinkChanged(null, type)` removes a link that the converter retired entirely — `ConfigPolicyDetailPage.tsx:315-318` handles the null branch.) Mount, as the last child of the `space-y-6` div:
  ```tsx
  <NeedsConversionPanel policyId={policyId} hasLegacyRows={hasLegacyRows} onChanged={() => void refreshLinks()} />
  ```
  i18n — `monitoring.json` gains a `conversion` block. `en`:
  ```json
  "conversion": {
    "title": "Needs conversion",
    "description": "Inline alert rules, service/process watches and alert-triggered automations on this policy have not been converted to monitors yet. Converting retires the source row in place; nothing is deleted.",
    "checking": "Checking devices…",
    "devicesChecked_one": "{{count}} device checked for identical behavior.",
    "devicesChecked_other": "{{count}} devices checked for identical behavior.",
    "blocked": {
      "parent_unconverted": "Convert the parent policy first — its inline rules decide what this policy inherits.",
      "prerequisite_missing": "A prerequisite fix is not deployed on this server yet. Conversion is disabled until it is."
    },
    "refusedTitle_one": "Conversion refused: {{count}} device would change behavior.",
    "refusedTitle_other": "Conversion refused: {{count}} devices would change behavior.",
    "convert": "Convert",
    "convertAll_one": "Convert {{count}} convertible",
    "convertAll_other": "Convert all {{count}} convertible",
    "retire": "Retire",
    "converted": "Converted {{rows}} legacy rows into {{monitors}} monitors.",
    "retired": "Retired {{name}}.",
    "undone_one": "Reverted {{count}} conversion.",
    "undone_other": "Reverted {{count}} conversions.",
    "openAlerts_one": "{{count}} open alert moves to the monitor",
    "openAlerts_other": "{{count}} open alerts move to the monitor",
    "sourceTables": {
      "config_policy_alert_rules": "Inline alert rule",
      "config_policy_monitoring_watches": "Service/process watch",
      "alert_templates": "Alert template",
      "automations": "Alert-triggered automation",
      "config_policy_automations": "Policy automation",
      "network_monitors": "Network check"
    },
    "outcomes": { "convertible": "Convertible", "unconvertible": "Cannot convert" },
    "roles": { "primary": "Monitor", "resource_cpu": "CPU monitor", "resource_memory": "Memory monitor", "response": "Response" },
    "reasons": {
      "unknown": "Cannot convert ({{code}}).",
      "nested_group": "The rule nests condition groups; a composite monitor is one flat group.",
      "no_condition": "The template has no evaluable condition and never fired.",
      "escalation_policy_axis": "The escalation policy is org-owned but the policy is partner-wide.",
      "custom": "Custom conditions have no monitor kind.",
      "process_count": "Process-count conditions have no monitor kind."
    },
    "errors": {
      "preview": "Failed to load the conversion preview",
      "convert": "Failed to convert",
      "retire": "Failed to retire",
      "revert": "Failed to revert the conversion"
    }
  }
  ```
  Translations (same keys, all 7 locales — write them in full; `_one`/`_other` pairs everywhere `en` has them):
  - **de-DE**: title "Konvertierung erforderlich"; description "Inline-Alarmregeln, Dienst-/Prozessüberwachungen und alarmausgelöste Automatisierungen dieser Richtlinie wurden noch nicht in Monitore konvertiert. Beim Konvertieren wird die Quellzeile an Ort und Stelle stillgelegt; nichts wird gelöscht."; checking "Geräte werden geprüft…"; devicesChecked "{{count}} Gerät auf identisches Verhalten geprüft." / "{{count}} Geräte auf identisches Verhalten geprüft."; blocked.parent_unconverted "Konvertieren Sie zuerst die übergeordnete Richtlinie — ihre Inline-Regeln bestimmen, was diese Richtlinie erbt."; blocked.prerequisite_missing "Eine erforderliche Korrektur ist auf diesem Server noch nicht bereitgestellt. Die Konvertierung ist bis dahin deaktiviert."; refusedTitle "Konvertierung abgelehnt: {{count}} Gerät würde sein Verhalten ändern." / "…{{count}} Geräte würden ihr Verhalten ändern."; convert "Konvertieren"; convertAll "{{count}} konvertierbare konvertieren" / "Alle {{count}} konvertierbaren konvertieren"; retire "Stilllegen"; converted "{{rows}} Altzeilen in {{monitors}} Monitore konvertiert."; retired "{{name}} stillgelegt."; undone "{{count}} Konvertierung rückgängig gemacht." / "{{count}} Konvertierungen rückgängig gemacht."; openAlerts "{{count}} offener Alarm wechselt zum Monitor" / "{{count}} offene Alarme wechseln zum Monitor"; sourceTables: "Inline-Alarmregel", "Dienst-/Prozessüberwachung", "Alarmvorlage", "Alarmausgelöste Automatisierung", "Richtlinienautomatisierung", "Netzwerkprüfung"; outcomes "Konvertierbar" / "Nicht konvertierbar"; roles "Monitor", "CPU-Monitor", "Speicher-Monitor", "Reaktion"; reasons.unknown "Nicht konvertierbar ({{code}})."; nested_group "Die Regel verschachtelt Bedingungsgruppen; ein zusammengesetzter Monitor ist eine flache Gruppe."; no_condition "Die Vorlage hat keine auswertbare Bedingung und hat nie ausgelöst."; escalation_policy_axis "Die Eskalationsrichtlinie gehört einer Organisation, die Richtlinie ist aber partnerweit."; custom "Benutzerdefinierte Bedingungen haben keine Monitorart."; process_count "Prozessanzahl-Bedingungen haben keine Monitorart."; errors "Konvertierungsvorschau konnte nicht geladen werden", "Konvertierung fehlgeschlagen", "Stilllegen fehlgeschlagen", "Konvertierung konnte nicht rückgängig gemacht werden".
  - **es-419**: "Requiere conversión"; "Las reglas de alerta en línea, las vigilancias de servicios/procesos y las automatizaciones activadas por alertas de esta política aún no se convirtieron en monitores. Convertir retira la fila de origen en su lugar; no se elimina nada."; "Comprobando dispositivos…"; "{{count}} dispositivo comprobado para un comportamiento idéntico." / "{{count}} dispositivos comprobados para un comportamiento idéntico."; "Convierta primero la política superior: sus reglas en línea deciden lo que hereda esta política."; "Una corrección previa aún no está implementada en este servidor. La conversión está deshabilitada hasta entonces."; "Conversión rechazada: {{count}} dispositivo cambiaría de comportamiento." / "…{{count}} dispositivos cambiarían de comportamiento."; "Convertir"; "Convertir {{count}} convertible" / "Convertir los {{count}} convertibles"; "Retirar"; "Se convirtieron {{rows}} filas heredadas en {{monitors}} monitores."; "Se retiró {{name}}."; "Se revirtió {{count}} conversión." / "Se revirtieron {{count}} conversiones."; "{{count}} alerta abierta pasa al monitor" / "{{count}} alertas abiertas pasan al monitor"; sourceTables "Regla de alerta en línea", "Vigilancia de servicio/proceso", "Plantilla de alerta", "Automatización activada por alerta", "Automatización de política", "Comprobación de red"; "Convertible" / "No se puede convertir"; roles "Monitor", "Monitor de CPU", "Monitor de memoria", "Respuesta"; reasons "No se puede convertir ({{code}}).", "La regla anida grupos de condiciones; un monitor compuesto es un solo grupo plano.", "La plantilla no tiene una condición evaluable y nunca se activó.", "La política de escalamiento pertenece a una organización, pero la política es de todo el partner.", "Las condiciones personalizadas no tienen tipo de monitor.", "Las condiciones de cantidad de procesos no tienen tipo de monitor."; errors "No se pudo cargar la vista previa de conversión", "No se pudo convertir", "No se pudo retirar", "No se pudo revertir la conversión".
  - **fr-FR / fr-CA** (identical): "Conversion requise"; "Les règles d'alerte intégrées, les surveillances de services/processus et les automatisations déclenchées par alerte de cette politique n'ont pas encore été converties en moniteurs. La conversion retire la ligne source sur place ; rien n'est supprimé."; "Vérification des appareils…"; "{{count}} appareil vérifié pour un comportement identique." / "{{count}} appareils vérifiés pour un comportement identique."; "Convertissez d'abord la politique parente : ses règles intégrées déterminent ce que cette politique hérite."; "Un correctif prérequis n'est pas encore déployé sur ce serveur. La conversion est désactivée jusque-là."; "Conversion refusée : {{count}} appareil changerait de comportement." / "… {{count}} appareils changeraient de comportement."; "Convertir"; "Convertir {{count}} convertible" / "Convertir les {{count}} convertibles"; "Retirer"; "{{rows}} lignes héritées converties en {{monitors}} moniteurs."; "{{name}} retiré."; "{{count}} conversion annulée." / "{{count}} conversions annulées."; "{{count}} alerte ouverte passe au moniteur" / "{{count}} alertes ouvertes passent au moniteur"; sourceTables "Règle d'alerte intégrée", "Surveillance de service/processus", "Modèle d'alerte", "Automatisation déclenchée par alerte", "Automatisation de politique", "Vérification réseau"; "Convertible" / "Non convertible"; roles "Moniteur", "Moniteur CPU", "Moniteur mémoire", "Réponse"; reasons "Non convertible ({{code}}).", "La règle imbrique des groupes de conditions ; un moniteur composite est un seul groupe plat.", "Le modèle n'a aucune condition évaluable et ne s'est jamais déclenché.", "La politique d'escalade appartient à une organisation alors que la politique est à l'échelle du partenaire.", "Les conditions personnalisées n'ont pas de type de moniteur.", "Les conditions de nombre de processus n'ont pas de type de moniteur."; errors "Impossible de charger l'aperçu de conversion", "Échec de la conversion", "Échec du retrait", "Impossible d'annuler la conversion".
  - **it-IT**: "Conversione necessaria"; "Le regole di avviso inline, i controlli di servizi/processi e le automazioni attivate da avvisi di questa policy non sono ancora stati convertiti in monitor. La conversione ritira la riga di origine sul posto; nulla viene eliminato."; "Verifica dei dispositivi…"; "{{count}} dispositivo verificato per un comportamento identico." / "{{count}} dispositivi verificati per un comportamento identico."; "Converti prima la policy superiore: le sue regole inline decidono cosa eredita questa policy."; "Una correzione prerequisita non è ancora distribuita su questo server. La conversione è disabilitata fino ad allora."; "Conversione rifiutata: {{count}} dispositivo cambierebbe comportamento." / "… {{count}} dispositivi cambierebbero comportamento."; "Converti"; "Converti {{count}} convertibile" / "Converti tutti i {{count}} convertibili"; "Ritira"; "Convertite {{rows}} righe legacy in {{monitors}} monitor."; "{{name}} ritirato."; "Annullata {{count}} conversione." / "Annullate {{count}} conversioni."; "{{count}} avviso aperto passa al monitor" / "{{count}} avvisi aperti passano al monitor"; sourceTables "Regola di avviso inline", "Controllo servizio/processo", "Modello di avviso", "Automazione attivata da avviso", "Automazione della policy", "Controllo di rete"; "Convertibile" / "Non convertibile"; roles "Monitor", "Monitor CPU", "Monitor memoria", "Risposta"; reasons "Non convertibile ({{code}}).", "La regola annida gruppi di condizioni; un monitor composito è un unico gruppo piatto.", "Il modello non ha una condizione valutabile e non si è mai attivato.", "La policy di escalation appartiene a un'organizzazione ma la policy è a livello di partner.", "Le condizioni personalizzate non hanno un tipo di monitor.", "Le condizioni sul numero di processi non hanno un tipo di monitor."; errors "Impossibile caricare l'anteprima della conversione", "Conversione non riuscita", "Ritiro non riuscito", "Impossibile annullare la conversione".
  - **pt-BR**: "Precisa de conversão"; "Regras de alerta embutidas, monitoramentos de serviços/processos e automações acionadas por alerta desta política ainda não foram convertidos em monitores. A conversão aposenta a linha de origem no lugar; nada é excluído."; "Verificando dispositivos…"; "{{count}} dispositivo verificado para comportamento idêntico." / "{{count}} dispositivos verificados para comportamento idêntico."; "Converta primeiro a política superior — as regras embutidas dela decidem o que esta política herda."; "Uma correção pré-requisito ainda não foi implantada neste servidor. A conversão fica desabilitada até lá."; "Conversão recusada: {{count}} dispositivo mudaria de comportamento." / "… {{count}} dispositivos mudariam de comportamento."; "Converter"; "Converter {{count}} convertível" / "Converter todos os {{count}} convertíveis"; "Aposentar"; "{{rows}} linhas legadas convertidas em {{monitors}} monitores."; "{{name}} aposentado."; "{{count}} conversão revertida." / "{{count}} conversões revertidas."; "{{count}} alerta aberto passa para o monitor" / "{{count}} alertas abertos passam para o monitor"; sourceTables "Regra de alerta embutida", "Monitoramento de serviço/processo", "Modelo de alerta", "Automação acionada por alerta", "Automação da política", "Verificação de rede"; "Convertível" / "Não pode ser convertido"; roles "Monitor", "Monitor de CPU", "Monitor de memória", "Resposta"; reasons "Não pode ser convertido ({{code}}).", "A regra aninha grupos de condições; um monitor composto é um único grupo plano.", "O modelo não tem condição avaliável e nunca disparou.", "A política de escalonamento pertence a uma organização, mas a política é de todo o parceiro.", "Condições personalizadas não têm tipo de monitor.", "Condições de contagem de processos não têm tipo de monitor."; errors "Falha ao carregar a prévia da conversão", "Falha ao converter", "Falha ao aposentar", "Falha ao reverter a conversão".
  - **tr-TR**: "Dönüştürme gerekiyor"; "Bu ilkedeki satır içi uyarı kuralları, hizmet/süreç izlemeleri ve uyarıyla tetiklenen otomasyonlar henüz monitöre dönüştürülmedi. Dönüştürme, kaynak satırı yerinde emekliye ayırır; hiçbir şey silinmez."; "Cihazlar kontrol ediliyor…"; "{{count}} cihaz aynı davranış için kontrol edildi." / "{{count}} cihaz aynı davranış için kontrol edildi."; "Önce üst ilkeyi dönüştürün — satır içi kuralları bu ilkenin neyi devralacağını belirler."; "Ön koşul olan bir düzeltme bu sunucuda henüz dağıtılmadı. Dönüştürme o zamana kadar devre dışı."; "Dönüştürme reddedildi: {{count}} cihazın davranışı değişirdi." / "Dönüştürme reddedildi: {{count}} cihazın davranışı değişirdi."; "Dönüştür"; "{{count}} dönüştürülebiliri dönüştür" / "{{count}} dönüştürülebilirin tümünü dönüştür"; "Emekliye ayır"; "{{rows}} eski satır {{monitors}} monitöre dönüştürüldü."; "{{name}} emekliye ayrıldı."; "{{count}} dönüştürme geri alındı." / "{{count}} dönüştürme geri alındı."; "{{count}} açık uyarı monitöre taşınıyor" / "{{count}} açık uyarı monitöre taşınıyor"; sourceTables "Satır içi uyarı kuralı", "Hizmet/süreç izleme", "Uyarı şablonu", "Uyarıyla tetiklenen otomasyon", "İlke otomasyonu", "Ağ denetimi"; "Dönüştürülebilir" / "Dönüştürülemez"; roles "Monitör", "CPU monitörü", "Bellek monitörü", "Yanıt"; reasons "Dönüştürülemez ({{code}}).", "Kural, koşul gruplarını iç içe kullanıyor; bileşik bir monitör tek bir düz gruptur.", "Şablonun değerlendirilebilir bir koşulu yok ve hiç tetiklenmedi.", "Yükseltme ilkesi bir kuruluşa ait ancak ilke iş ortağı genelinde.", "Özel koşulların monitör türü yok.", "Süreç sayısı koşullarının monitör türü yok."; errors "Dönüştürme ön izlemesi yüklenemedi", "Dönüştürme başarısız", "Emekliye ayırma başarısız", "Dönüştürme geri alınamadı".

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/monitoring/conversion src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p .`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring/conversion/NeedsConversionPanel.tsx apps/web/src/components/monitoring/conversion/NeedsConversionPanel.test.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx apps/web/src/locales/*/monitoring.json && git commit -m "feat(web): Needs-conversion panel on the policy Monitors tab (preview, convert, retire, undo)"`

---

### Task 6: Monitors library — pending banner, Needs-conversion view, partner **Convert everything** (PR1)

**Files:**
- Create: `apps/web/src/components/monitoring/LegacyRulesTable.tsx` (extracted from `LegacyRulesPage.tsx` lines 12-160: the `LegacyRule` type, fetch, `handleConvert`, the table)
- Modify: `apps/web/src/components/monitoring/LegacyRulesPage.tsx` (keeps the tab strip + heading, renders `<LegacyRulesTable />`)
- Create: `apps/web/src/components/monitoring/conversion/ConversionPendingBanner.tsx`, `ConversionPendingBanner.test.tsx`
- Create: `apps/web/src/components/monitoring/conversion/PendingPoliciesList.tsx`, `PendingPoliciesList.test.tsx`
- Modify: `apps/web/src/components/monitoring/MonitorsListPage.tsx` (lines 32-37 state; header 136-152; body 154-175)
- Modify: `apps/web/src/components/monitoring/MonitorsListPage.test.tsx`
- Modify: `apps/web/src/locales/*/monitoring.json` (8 files: `conversion.banner.*`, `conversion.pendingPolicies.*`, `list.views.*`)

**Interfaces:**
- Consumes: `fetchPendingCounts(orgId)` and `conversionPaths.partnerConvertAll()` + `readPartnerConvertResult` (Task 1); `GET /configuration-policies?limit=100` → `{ data: [{ id, name, orgId, partnerId, featureLinks: [{ id, featureType }] }] }` (`services/configurationPolicy.ts` `listConfigPolicies`, the `featureLinks` badge array; `orgId` is injected by `fetchWithAuth` for the `org-or-all` route class, `routeScope.ts:152`); `useOrgStore((s) => s.currentOrgId)`; `useJwtClaims()` (`@/lib/authScope`) for partner scope; `useAuthStore((s) => s.user?.canManagePartnerWide)` for the partner-wide gate (`stores/auth.ts:74`); `POST /alerts/rules`-era convert path stays exactly `POST /monitor-definitions/convert-from-rule/:ruleId` for standalone rules.
- Produces: `ConversionPendingBanner({ orgId, onReview, onConverted? })` — hidden at zero rows; "N legacy rules across M policies have not been converted" + **Review**; for a partner-scope caller with `canManagePartnerWide`, **Convert everything…** → inline confirmation (counts restated, "unconvertible rows remain for review/manual retirement; W05d sweeps leftovers") → `POST …/partner/convert-all` via `runAction` → toast with `{ policies, converted, unconvertible }`. `PendingPoliciesList()` — the org's policies whose `featureLinks` contain `alert_rule`, `monitoring` or `automation`, each linking to `/configuration-policies/<id>#monitors`. `MonitorsListPage` — `#needs-conversion` hash view (`useHashState`) showing `PendingPoliciesList` + `LegacyRulesTable` instead of the monitors table; view toggle buttons.

- [ ] **Step 1: Write the failing tests.**
  `ConversionPendingBanner.test.tsx`:
  ```tsx
  import '@/lib/i18n';
  import { fireEvent, render, screen, waitFor } from '@testing-library/react';
  import { beforeEach, describe, expect, it, vi } from 'vitest';

  const { fetchWithAuth, runAction, showToast, fetchPendingCounts, claims, canManagePartnerWide } = vi.hoisted(() => ({
    fetchWithAuth: vi.fn(),
    runAction: vi.fn(async ({ request, parseSuccess }: { request: () => Promise<Response>; parseSuccess?: (d: unknown) => unknown }) => {
      const body = await (await request()).json();
      return parseSuccess ? parseSuccess(body) : body;
    }),
    showToast: vi.fn(),
    fetchPendingCounts: vi.fn(),
    claims: { scope: 'partner' as 'partner' | 'organization', orgId: null as string | null, partnerId: 'p-1' },
    canManagePartnerWide: { value: true },
  }));
  vi.mock('../../../stores/auth', () => ({
    fetchWithAuth,
    useAuthStore: (sel: (s: { user: { canManagePartnerWide: boolean } }) => unknown) => sel({ user: { canManagePartnerWide: canManagePartnerWide.value } }),
  }));
  vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims }) }));
  vi.mock('@/lib/runAction', () => ({ runAction, ActionError: class ActionError extends Error { constructor(m: string, public status: number) { super(m); } } }));
  vi.mock('../../shared/Toast', () => ({ showToast }));
  vi.mock('./conversionApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('./conversionApi')>()), fetchPendingCounts }));

  import ConversionPendingBanner from './ConversionPendingBanner';
  const json = (body: unknown) => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

  beforeEach(() => { vi.clearAllMocks(); claims.scope = 'partner'; canManagePartnerWide.value = true; fetchPendingCounts.mockResolvedValue({ policies: 3, rows: 12 }); });

  describe('ConversionPendingBanner', () => {
    it('renders nothing when nothing is pending', async () => {
      fetchPendingCounts.mockResolvedValue({ policies: 0, rows: 0 });
      const { container } = render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
      await waitFor(() => expect(fetchPendingCounts).toHaveBeenCalledWith('org-1'));
      expect(container).toBeEmptyDOMElement();
    });
    it('states the counts and Review hands off to the caller', async () => {
      const onReview = vi.fn();
      render(<ConversionPendingBanner orgId="org-1" onReview={onReview} />);
      expect(await screen.findByTestId('conversion-pending-banner')).toHaveTextContent(/12 legacy rules across 3 policies/);
      fireEvent.click(screen.getByTestId('conversion-pending-review'));
      expect(onReview).toHaveBeenCalled();
    });
    it('previews all partner policies even with one org selected, confirms the hash and reports the result', async () => {
      const onConverted = vi.fn();
      fetchWithAuth.mockResolvedValueOnce(json({ data: { partnerId: 'p-1', previewHash: 'partner-h', policies: 9, rows: 40, convertible: 39, unconvertible: [{ sourceTable: 'alert_templates', sourceId: 's1', name: 'Custom', policyId: null, policyName: null, reason: 'unconvertible:custom' }] } }))
        .mockResolvedValueOnce(json({ data: { policies: 9, converted: 39, unconvertible: 1 } }));
      render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} onConverted={onConverted} />);
      fireEvent.click(await screen.findByTestId('conversion-convert-everything'));
      expect(await screen.findByTestId('conversion-convert-everything-confirm')).toHaveTextContent(/40 legacy rules/);
      expect(screen.getByTestId('conversion-convert-everything-confirm')).toHaveTextContent('Custom');
      fireEvent.click(screen.getByTestId('conversion-convert-everything-run'));
      await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/monitor-definitions/conversion/partner/convert-all', { method: 'POST', body: JSON.stringify({ previewHash: 'partner-h' }) }));
      await waitFor(() => expect(onConverted).toHaveBeenCalled());
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/39.*9.*1/) }));
      expect(fetchPendingCounts).toHaveBeenCalledTimes(2);
    });
    it('hides Convert everything for an org-scoped caller and for a partner user without partner-wide rights', async () => {
      claims.scope = 'organization';
      const { unmount } = render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
      await screen.findByTestId('conversion-pending-banner');
      expect(screen.queryByTestId('conversion-convert-everything')).toBeNull();
      unmount();
      claims.scope = 'partner'; canManagePartnerWide.value = false;
      render(<ConversionPendingBanner orgId="org-1" onReview={vi.fn()} />);
      await screen.findByTestId('conversion-pending-banner');
      expect(screen.queryByTestId('conversion-convert-everything')).toBeNull();
    });
  });
  ```
  `PendingPoliciesList.test.tsx`:
  ```tsx
  import '@/lib/i18n';
  import { render, screen } from '@testing-library/react';
  import { describe, expect, it, vi } from 'vitest';
  vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  import { fetchWithAuth } from '../../../stores/auth';
  import PendingPoliciesList from './PendingPoliciesList';
  const json = (body: unknown) => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

  describe('PendingPoliciesList', () => {
    it('lists only policies that still carry a legacy link, deep-linking to their Monitors tab', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [
        { id: 'p-1', name: 'Servers', orgId: 'org-1', partnerId: null, featureLinks: [{ id: 'l1', featureType: 'alert_rule' }, { id: 'l2', featureType: 'monitors' }] },
        { id: 'p-2', name: 'Clean', orgId: 'org-1', partnerId: null, featureLinks: [{ id: 'l3', featureType: 'monitors' }] },
        { id: 'p-3', name: 'Partner base', orgId: null, partnerId: 'pt-1', featureLinks: [{ id: 'l4', featureType: 'monitoring' }] },
      ] }));
      render(<PendingPoliciesList />);
      const first = await screen.findByTestId('pending-policy-p-1');
      expect(first.querySelector('a')).toHaveAttribute('href', '/configuration-policies/p-1#monitors');
      expect(first.textContent).toContain('Inline alert rule');
      expect(screen.getByTestId('pending-policy-p-3').textContent).toContain('Service/process watch');
      expect(screen.queryByTestId('pending-policy-p-2')).toBeNull();
      expect(fetchWithAuth).toHaveBeenCalledWith('/configuration-policies?limit=100');
    });
    it('says so when no policy carries legacy links', async () => {
      vi.mocked(fetchWithAuth).mockResolvedValue(json({ data: [] }));
      render(<PendingPoliciesList />);
      expect(await screen.findByTestId('pending-policies-empty')).toBeInTheDocument();
    });
  });
  ```
  `MonitorsListPage.test.tsx` — add these mocks at the top and a describe:
  ```tsx
  vi.mock('./conversion/ConversionPendingBanner', () => ({ default: (p: { onReview: () => void }) => <button data-testid="banner" onClick={p.onReview} /> }));
  vi.mock('./conversion/PendingPoliciesList', () => ({ default: () => <div data-testid="pending-policies" /> }));
  vi.mock('./LegacyRulesTable', () => ({ default: () => <div data-testid="legacy-rules-table" /> }));
  vi.mock('../../stores/orgStore', () => ({ useOrgStore: (sel: (s: { currentOrgId: string | null }) => unknown) => sel({ currentOrgId: 'org-1' }) }));

  describe('MonitorsListPage — Needs-conversion view (W05c2)', () => {
    beforeEach(() => { window.location.hash = ''; fetchMock.mockResolvedValue(json({ data: rows })); });
    it('shows the monitors table by default and the pending banner above it', async () => {
      render(<MonitorsListPage />);
      expect(await screen.findByTestId('monitors-list-page')).toBeInTheDocument();
      expect(screen.getByTestId('banner')).toBeInTheDocument();
      expect(screen.queryByTestId('pending-policies')).toBeNull();
    });
    it('#needs-conversion swaps the table for the pending policies and the legacy rules', async () => {
      window.location.hash = '#needs-conversion';
      render(<MonitorsListPage />);
      expect(await screen.findByTestId('pending-policies')).toBeInTheDocument();
      expect(screen.getByTestId('legacy-rules-table')).toBeInTheDocument();
      expect(screen.queryByTestId('monitors-list-enabled-m-org')).toBeNull();
    });
    it('the banner Review action and the view toggle both write the hash', async () => {
      render(<MonitorsListPage />);
      fireEvent.click(await screen.findByTestId('banner'));
      expect(window.location.hash).toBe('#needs-conversion');
      fireEvent.click(screen.getByTestId('monitors-list-view-all'));
      expect(window.location.hash).toBe('');
    });
  });
  ```
- [ ] **Step 2: Run them, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/conversion src/components/monitoring/MonitorsListPage.test.tsx src/components/monitoring/LegacyRulesPage.test.tsx` → `Failed to resolve import "./ConversionPendingBanner"`, `"./PendingPoliciesList"`, `"./LegacyRulesTable"`.
- [ ] **Step 3: Implement.**
  `LegacyRulesTable.tsx` — move `LegacyRule`, `UNAUTHORIZED`, `fetchRules`, `handleConvert`, the error/empty blocks and the `<div className="overflow-x-auto …">` table out of `LegacyRulesPage.tsx` verbatim into `export default function LegacyRulesTable()`; `LegacyRulesPage` becomes:
  ```tsx
  export default function LegacyRulesPage() {
    const { t } = useTranslation(['monitoring', 'common']);
    return (
      <div className="space-y-6" data-testid="legacy-rules-page">
        <AlertsTabStrip currentPath="/alerts/rules" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('monitoring:legacy.title')}</h1>
          <p className="text-muted-foreground">{t('monitoring:legacy.description')}</p>
        </div>
        <LegacyRulesTable />
      </div>
    );
  }
  ```
  `ConversionPendingBanner.tsx`:
  ```tsx
  import { useCallback, useEffect, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth, useAuthStore } from '../../../stores/auth';
  import { useJwtClaims } from '@/lib/authScope';
  import { ActionError, runAction } from '@/lib/runAction';
  import { showToast } from '../../shared/Toast';
  import { conversionPaths, fetchPendingCounts, readPartnerConvertResult, readPartnerPreview, type PartnerConversionPreview, type PartnerConvertResult, type PendingCounts } from './conversionApi';

  export interface ConversionPendingBannerProps {
    orgId: string | null;
    onReview: () => void;
    onConverted?: () => void;
  }

  export default function ConversionPendingBanner({ orgId, onReview, onConverted }: ConversionPendingBannerProps) {
    const { t } = useTranslation(['monitoring', 'common']);
    const claims = useJwtClaims();
    const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
    const isPartnerScope = claims.status === 'resolved' && claims.claims?.scope === 'partner';
    const [counts, setCounts] = useState<PendingCounts | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [partnerPreview, setPartnerPreview] = useState<PartnerConversionPreview | null>(null);
    const [running, setRunning] = useState(false);

    const load = useCallback(async () => {
      try { setCounts(await fetchPendingCounts(orgId)); } catch { setCounts(null); }
    }, [orgId]);
    useEffect(() => { void load(); }, [load]);

    if (!counts || counts.rows === 0) return null;

    const previewEverything = async () => {
      setRunning(true); setPartnerPreview(null); setConfirming(false);
      try {
        const result = await runAction<PartnerConversionPreview>({
          request: () => fetchWithAuth(conversionPaths.partnerPreview(), { method: 'POST' }),
          parseSuccess: readPartnerPreview, errorFallback: t('monitoring:conversion.errors.preview'),
        });
        setPartnerPreview(result); setConfirming(true);
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:conversion.errors.preview') });
      } finally { setRunning(false); }
    };
    const convertEverything = async () => {
      if (!partnerPreview) return;
      setRunning(true);
      try {
        const result = await runAction<PartnerConvertResult>({
          request: () => fetchWithAuth(conversionPaths.partnerConvertAll(), { method: 'POST', body: JSON.stringify({ previewHash: partnerPreview.previewHash }) }),
          parseSuccess: readPartnerConvertResult,
          errorFallback: t('monitoring:conversion.banner.errors.convertAll'),
        });
        showToast({ type: 'success', message: t('monitoring:conversion.banner.convertedAll', result) });
        setConfirming(false);
        onConverted?.();
        await load();
      } catch (err) {
        setPartnerPreview(null); setConfirming(false); // 409 requires a new preview and confirmation.
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:conversion.banner.errors.convertAll') });
      } finally {
        setRunning(false);
      }
    };

    return (
      <div className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm" data-testid="conversion-pending-banner">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>{t('monitoring:conversion.banner.text', { rows: counts.rows, policies: counts.policies })}</p>
          <div className="flex gap-2">
            <button type="button" data-testid="conversion-pending-review" onClick={onReview} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted">
              {t('monitoring:conversion.banner.review')}
            </button>
            {isPartnerScope && canManagePartnerWide && !confirming && (
              <button type="button" data-testid="conversion-convert-everything" disabled={running} onClick={() => void previewEverything()} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:opacity-90">
                {t('monitoring:conversion.banner.convertEverything')}
              </button>
            )}
          </div>
        </div>
        {confirming && partnerPreview && (
          <div className="mt-3 rounded-md border bg-background p-3" data-testid="conversion-convert-everything-confirm">
            <p className="font-medium">{t('monitoring:conversion.banner.confirmTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('monitoring:conversion.banner.confirmBody', partnerPreview)}</p>
            <ul>{partnerPreview.unconvertible.map((item) => <li key={`${item.sourceTable}:${item.sourceId}`}>
              {item.policyName ?? item.policyId ?? '—'} · {item.name} · {item.reason}
            </li>)}</ul>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(false)} className="rounded-md border px-3 py-1.5">{t('common:actions.cancel')}</button>
              <button type="button" data-testid="conversion-convert-everything-run" disabled={running} onClick={() => void convertEverything()} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-60">
                {t('monitoring:conversion.banner.confirmRun')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
  ```
  `PendingPoliciesList.tsx`:
  ```tsx
  import { useEffect, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth } from '../../../stores/auth';
  import { ScopeBadge } from '../../shared/ScopeBadge';

  const LEGACY_LINK_TYPES = ['alert_rule', 'monitoring', 'automation'] as const;
  const SOURCE_LABEL_KEY: Record<(typeof LEGACY_LINK_TYPES)[number], string> = {
    alert_rule: 'monitoring:conversion.sourceTables.config_policy_alert_rules',
    monitoring: 'monitoring:conversion.sourceTables.config_policy_monitoring_watches',
    automation: 'monitoring:conversion.sourceTables.config_policy_automations',
  };
  type PolicyRow = { id: string; name: string; orgId: string | null; partnerId: string | null; featureLinks: Array<{ id: string; featureType: string }> };

  /**
   * Which policies still carry a legacy link. The API's `pending` count is the
   * truth for the banner; this list over-approximates after a conversion (the
   * link row survives, its rows are retired) — the policy's own panel then
   * shows nothing, which is the honest answer.
   */
  export default function PendingPoliciesList() {
    const { t } = useTranslation(['monitoring', 'policies']);
    const [rows, setRows] = useState<PolicyRow[] | null>(null);
    useEffect(() => {
      let cancelled = false;
      fetchWithAuth('/configuration-policies?limit=100')
        .then(async (res) => (res.ok ? res.json() : { data: [] }))
        .then((json) => { if (!cancelled) setRows(Array.isArray(json?.data) ? json.data : []); })
        .catch(() => { if (!cancelled) setRows([]); });
      return () => { cancelled = true; };
    }, []);
    const pending = (rows ?? []).filter((p) => p.featureLinks.some((l) => (LEGACY_LINK_TYPES as readonly string[]).includes(l.featureType)));
    if (rows === null) return <p className="text-sm text-muted-foreground">{t('monitoring:conversion.pendingPolicies.loading')}</p>;
    if (pending.length === 0) return <p className="text-sm text-muted-foreground" data-testid="pending-policies-empty">{t('monitoring:conversion.pendingPolicies.empty')}</p>;
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t('monitoring:conversion.pendingPolicies.title')}</h2>
        <ul className="divide-y rounded-md border bg-card">
          {pending.map((p) => (
            <li key={p.id} data-testid={`pending-policy-${p.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <a href={`/configuration-policies/${p.id}#monitors`} className="font-medium underline-offset-2 hover:underline">{p.name}</a>
                <ScopeBadge orgId={p.orgId} partnerId={p.partnerId} isSystem={false} />
              </div>
              <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                {p.featureLinks
                  .filter((l): l is { id: string; featureType: (typeof LEGACY_LINK_TYPES)[number] } => (LEGACY_LINK_TYPES as readonly string[]).includes(l.featureType))
                  .map((l) => <span key={l.id} className="rounded-full border px-2 py-0.5">{t(SOURCE_LABEL_KEY[l.featureType])}</span>)}
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  ```
  `MonitorsListPage.tsx`:
  ```tsx
  import { useHashState } from '@/lib/useHashState';
  import { useOrgStore } from '../../stores/orgStore';
  import ConversionPendingBanner from './conversion/ConversionPendingBanner';
  import PendingPoliciesList from './conversion/PendingPoliciesList';
  import LegacyRulesTable from './LegacyRulesTable';
  …
  type ListView = 'all' | 'needs-conversion';
  const [view] = useHashState<ListView>('all', (hash) => (hash === 'needs-conversion' ? 'needs-conversion' : undefined));
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const showView = (next: ListView) => { window.location.hash = next === 'all' ? '' : next; };
  ```
  Render — after the header `div` and before `{error && …}`:
  ```tsx
  <ConversionPendingBanner orgId={currentOrgId} onReview={() => showView('needs-conversion')} onConverted={() => void fetchMonitors()} />
  <div className="flex gap-2" role="tablist" aria-label={t('monitoring:list.views.ariaLabel')}>
    {(['all', 'needs-conversion'] as const).map((v) => (
      <button
        key={v}
        type="button"
        role="tab"
        aria-selected={view === v}
        data-testid={`monitors-list-view-${v}`}
        onClick={() => showView(v)}
        className={`rounded-md border px-3 py-1.5 text-sm ${view === v ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}
      >
        {t(`monitoring:list.views.${v === 'all' ? 'all' : 'needsConversion'}`)}
      </button>
    ))}
  </div>
  {view === 'needs-conversion' ? (
    <div className="space-y-6" data-testid="monitors-list-needs-conversion">
      <PendingPoliciesList />
      <LegacyRulesTable />
    </div>
  ) : (
    <>
      {/* existing error / empty / ResponsiveTable blocks, unchanged */}
    </>
  )}
  ```
  i18n (`monitoring.json`, 8 locales):

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | `list.views.ariaLabel` | Monitor views | Monitoransichten | Vistas de monitores | Vues des moniteurs | Viste dei monitor | Visualizações de monitores | Monitör görünümleri |
  | `list.views.all` | All monitors | Alle Monitore | Todos los monitores | Tous les moniteurs | Tutti i monitor | Todos os monitores | Tüm monitörler |
  | `list.views.needsConversion` | Needs conversion | Konvertierung erforderlich | Requiere conversión | Conversion requise | Conversione necessaria | Precisa de conversão | Dönüştürme gerekiyor |
  | `conversion.banner.text` | {{rows}} legacy rules across {{policies}} policies have not been converted to monitors. | {{rows}} Altregeln in {{policies}} Richtlinien wurden noch nicht in Monitore konvertiert. | {{rows}} reglas heredadas en {{policies}} políticas aún no se convirtieron en monitores. | {{rows}} règles héritées dans {{policies}} politiques n'ont pas encore été converties en moniteurs. | {{rows}} regole legacy in {{policies}} policy non sono ancora state convertite in monitor. | {{rows}} regras legadas em {{policies}} políticas ainda não foram convertidas em monitores. | {{policies}} ilkedeki {{rows}} eski kural henüz monitöre dönüştürülmedi. |
  | `conversion.banner.review` | Review | Prüfen | Revisar | Examiner | Esamina | Revisar | İncele |
  | `conversion.banner.convertEverything` | Convert everything… | Alles konvertieren… | Convertir todo… | Tout convertir… | Converti tutto… | Converter tudo… | Tümünü dönüştür… |
  | `conversion.banner.confirmTitle` | Convert every legacy rule, watch and alert-triggered automation across all your policies? | Alle Altregeln, Überwachungen und alarmausgelösten Automatisierungen in allen Ihren Richtlinien konvertieren? | ¿Convertir todas las reglas heredadas, vigilancias y automatizaciones activadas por alertas de todas sus políticas? | Convertir toutes les règles héritées, surveillances et automatisations déclenchées par alerte de toutes vos politiques ? | Convertire tutte le regole legacy, i controlli e le automazioni attivate da avvisi in tutte le policy? | Converter todas as regras legadas, monitoramentos e automações acionadas por alerta em todas as suas políticas? | Tüm ilkelerinizdeki her eski kural, izleme ve uyarıyla tetiklenen otomasyon dönüştürülsün mü? |
  | `conversion.banner.confirmBody` | {{rows}} legacy rules in {{policies}} policies across the whole partner. Converted rows retire in place. Unconvertible rows remain for review or manual retirement in W05c; W05d converts leftovers and retires those it cannot convert. | {{rows}} Altregeln in {{policies}} Richtlinien des gesamten Partners. Konvertierte Zeilen werden stillgelegt. Nicht konvertierbare Zeilen bleiben in W05c zur Prüfung oder manuellen Stilllegung; W05d konvertiert Reste und legt nicht konvertierbare still. | {{rows}} reglas heredadas en {{policies}} políticas de todo el partner. Las filas convertidas se retiran en su lugar. Las demás quedan para revisión o retiro manual en W05c; W05d convierte las restantes y retira las que no puede convertir. | {{rows}} règles héritées dans {{policies}} politiques de tout le partenaire. Les lignes converties sont retirées sur place. Les autres restent à examiner ou retirer manuellement en W05c ; W05d convertit les restantes et retire celles non convertibles. | {{rows}} regole legacy in {{policies}} policy dell’intero partner. Le righe convertite vengono ritirate sul posto. Le altre restano da esaminare o ritirare manualmente in W05c; W05d converte le rimanenti e ritira quelle non convertibili. | {{rows}} regras legadas em {{policies}} políticas de todo o parceiro. Linhas convertidas são aposentadas no lugar. As demais ficam para revisão ou aposentadoria manual em W05c; W05d converte as restantes e aposenta as não convertíveis. | İş ortağının tümünde {{policies}} ilkede {{rows}} eski kural. Dönüştürülen satırlar yerinde emekliye ayrılır. Diğerleri W05c’de inceleme veya elle emekliye ayırma için kalır; W05d kalanları dönüştürür ve dönüştürülemeyenleri emekliye ayırır. |
  | `conversion.banner.confirmRun` | Convert everything | Alles konvertieren | Convertir todo | Tout convertir | Converti tutto | Converter tudo | Tümünü dönüştür |
  | `conversion.banner.convertedAll` | Converted {{converted}} rows across {{policies}} policies; {{unconvertible}} could not be converted. | {{converted}} Zeilen in {{policies}} Richtlinien konvertiert; {{unconvertible}} nicht konvertierbar. | Se convirtieron {{converted}} filas en {{policies}} políticas; {{unconvertible}} no se pudieron convertir. | {{converted}} lignes converties dans {{policies}} politiques ; {{unconvertible}} n'ont pas pu l'être. | Convertite {{converted}} righe in {{policies}} policy; {{unconvertible}} non convertibili. | {{converted}} linhas convertidas em {{policies}} políticas; {{unconvertible}} não puderam ser convertidas. | {{policies}} ilkede {{converted}} satır dönüştürüldü; {{unconvertible}} dönüştürülemedi. |
  | `conversion.banner.errors.convertAll` | Failed to convert everything | Konvertierung aller Einträge fehlgeschlagen | No se pudo convertir todo | Échec de la conversion globale | Conversione completa non riuscita | Falha ao converter tudo | Tümü dönüştürülemedi |
  | `conversion.pendingPolicies.title` | Policies with legacy rules | Richtlinien mit Altregeln | Políticas con reglas heredadas | Politiques avec règles héritées | Policy con regole legacy | Políticas com regras legadas | Eski kuralları olan ilkeler |
  | `conversion.pendingPolicies.loading` | Loading policies… | Richtlinien werden geladen… | Cargando políticas… | Chargement des politiques… | Caricamento delle policy… | Carregando políticas… | İlkeler yükleniyor… |
  | `conversion.pendingPolicies.empty` | No policy carries inline alert rules, watches or alert-triggered automations. | Keine Richtlinie enthält Inline-Alarmregeln, Überwachungen oder alarmausgelöste Automatisierungen. | Ninguna política tiene reglas de alerta en línea, vigilancias ni automatizaciones activadas por alertas. | Aucune politique ne porte de règles d'alerte intégrées, de surveillances ou d'automatisations déclenchées par alerte. | Nessuna policy contiene regole di avviso inline, controlli o automazioni attivate da avvisi. | Nenhuma política tem regras de alerta embutidas, monitoramentos ou automações acionadas por alerta. | Hiçbir ilke satır içi uyarı kuralı, izleme veya uyarıyla tetiklenen otomasyon taşımıyor. |

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/monitoring src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p .`
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring apps/web/src/locales/*/monitoring.json && git commit -m "feat(web): Monitors library — pending-conversion banner, Needs-conversion view, partner Convert everything"`

---

### Task 7: Platform-admin conversion page — the hosted sweep runs from the admin UI (PR1)

**Files:**
- Create: `apps/api/src/services/monitors/conversion/partnerBacklog.ts`, `partnerBacklog.test.ts`
- Create: `apps/api/src/routes/admin/monitorConversion.ts`, `monitorConversion.test.ts`
- Modify: `apps/api/src/routes/admin/index.ts` (mount after `/sending-domains`)
- Create: `apps/web/src/components/admin/MonitorConversionAdmin.tsx`, `MonitorConversionAdmin.test.tsx`, `apps/web/src/pages/admin/monitor-conversion.astro`
- Modify: `apps/web/src/locales/*/pages.json` (`titles.adminMonitorConversion`, 8 locales)

**Interfaces:**
- Consumes (W05c1): `previewPartnerConversion(partnerId, auth): Promise<PartnerConversionPreview>` and `convertPartnerLegacy(partnerId, previewHash, auth): Promise<{ policies; converted; unconvertible }>` from `apps/api/src/services/monitors/conversion/`; the `retired_at` columns on the six source tables. Also `platformAdminMiddleware` (applied once by `routes/admin/index.ts:16` — never re-applied in the sub-router, `sendingDomains.ts:12-19`), `requireMfa()` on the mutating verb, `writeRouteAudit`, `runOutsideDbContext` + `withSystemDbAccessContext` (`db/index.ts`), `createSystemAuthContext` (`services/featureConfigResolver.ts:52`).
- Produces: `GET /api/v1/admin/monitor-conversion/partners` → `{ data: Array<{ partnerId; partnerName; pendingRows; pendingPolicies }> }` (every partner, pending-first); `POST /api/v1/admin/monitor-conversion/partners/:partnerId/convert` (MFA) → `{ data: { policies, converted, unconvertible } }`. The admin preview POST `/partners/:partnerId/preview` returns `PartnerConversionPreview`; confirm POST `/partners/:partnerId/convert` requires `{ previewHash }`. The converter runs under a **system-scope** auth that carries the platform admin's real `user` (so `converted_by` / `created_by` reference a real `users` row — `createSystemAuthContext`'s zero UUID is not one, memory `monitors_w02_defects…`) and the target `partnerId`; `canManagePartnerWidePolicies` passes on `scope: 'system'`. Web: `/admin/monitor-conversion` — unlisted (reached by URL, the `SendingDomainsAdmin` precedent), one row per partner with the counts and a **Convert** button; results printed inline so the release checklist can record them.

- [ ] **Step 0: Verify the converter's entry points.** `ls apps/api/src/services/monitors/conversion/ && grep -n "export async function convertPartnerLegacy" -A 3 apps/api/src/services/monitors/conversion/*.ts`. Import `convertPartnerLegacy` from the file that exports it (the plan assumes an `index.ts` barrel; use the real path).
- [ ] **Step 1: Write the failing tests.**
  `partnerBacklog.test.ts` (Drizzle `db.execute` mock; the SQL is the unit under test — assert the row mapping and that every source table is named):
  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
  vi.mock('../../../db', () => ({
    db: { execute },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  }));
  import { listPartnerConversionBacklog, PARTNER_BACKLOG_SQL_SOURCES } from './partnerBacklog';

  beforeEach(() => vi.clearAllMocks());

  describe('listPartnerConversionBacklog', () => {
    it('counts every legacy source table exactly once', () => {
      expect([...PARTNER_BACKLOG_SQL_SOURCES].sort()).toEqual([
        'alert_templates', 'automations', 'config_policy_alert_rules', 'config_policy_automations', 'config_policy_monitoring_watches',
      ]);
    });
    it('maps rows to camelCase and orders pending partners first', async () => {
      execute.mockResolvedValue([
        { partner_id: 'p-2', partner_name: 'Beta', pending_rows: 0, pending_policies: 0 },
        { partner_id: 'p-1', partner_name: 'Acme', pending_rows: 7, pending_policies: 2 },
      ]);
      const rows = await listPartnerConversionBacklog();
      expect(rows).toEqual([
        { partnerId: 'p-1', partnerName: 'Acme', pendingRows: 7, pendingPolicies: 2 },
        { partnerId: 'p-2', partnerName: 'Beta', pendingRows: 0, pendingPolicies: 0 },
      ]);
    });
  });
  ```
  `monitorConversion.test.ts` (mirror `sendingDomains.test.ts:1-50`):
  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  import { Hono } from 'hono';

  const mocks = vi.hoisted(() => ({
    mfaAllowed: { value: true },
    requireMfa: vi.fn(() => async (c: any, next: any) => (mocks.mfaAllowed.value ? next() : c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403))),
    audit: vi.fn(),
    backlog: vi.fn(),
    convertPartnerLegacy: vi.fn(), previewPartnerConversion: vi.fn(),
  }));
  vi.mock('../../middleware/auth', () => ({ requireMfa: mocks.requireMfa }));
  vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
  vi.mock('../../services/monitors/conversion/partnerBacklog', () => ({ listPartnerConversionBacklog: mocks.backlog }));
  vi.mock('../../services/monitors/conversion', () => ({ convertPartnerLegacy: mocks.convertPartnerLegacy, previewPartnerConversion: mocks.previewPartnerConversion }));
  vi.mock('../../db', () => ({
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  }));

  import { adminMonitorConversionRoutes } from './monitorConversion';

  const PARTNER = '44444444-4444-4444-8444-444444444444';
  const ADMIN = '55555555-5555-4555-8555-555555555555';

  function buildApp(): Hono {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { scope: 'system', partnerId: null, orgId: null, user: { id: ADMIN, email: 'admin@lanternops.test', name: 'Admin', isPlatformAdmin: true } } as never);
      await next();
    });
    app.route('/admin/monitor-conversion', adminMonitorConversionRoutes);
    return app;
  }

  beforeEach(() => { vi.clearAllMocks(); mocks.mfaAllowed.value = true; });

  describe('admin monitor-conversion routes', () => {
    it('GET /partners lists the backlog', async () => {
      mocks.backlog.mockResolvedValue([{ partnerId: PARTNER, partnerName: 'Acme', pendingRows: 3, pendingPolicies: 1 }]);
      const res = await buildApp().request('/admin/monitor-conversion/partners');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [{ partnerId: PARTNER, partnerName: 'Acme', pendingRows: 3, pendingPolicies: 1 }] });
    });
    it('POST /partners/:id/convert runs the converter as system scope carrying the admin user and the partner, then audits', async () => {
      mocks.convertPartnerLegacy.mockResolvedValue({ policies: 1, converted: 3, unconvertible: 0 });
      const res = await buildApp().request(`/admin/monitor-conversion/partners/${PARTNER}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewHash: 'partner-h' }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { policies: 1, converted: 3, unconvertible: 0 } });
      const [partnerId, previewHash, auth] = mocks.convertPartnerLegacy.mock.calls[0]!;
      expect(previewHash).toBe('partner-h');
      expect(partnerId).toBe(PARTNER);
      expect(auth).toEqual(expect.objectContaining({ scope: 'system', partnerId: PARTNER, partnerOrgAccess: 'all', user: expect.objectContaining({ id: ADMIN }) }));
      expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'monitor_conversion.admin_partner_convert', resourceId: PARTNER }));
    });
    it('previews the whole partner and rejects conversion without its hash', async () => {
      mocks.previewPartnerConversion.mockResolvedValue({ partnerId: PARTNER, previewHash: 'h1', policies: 2, rows: 4, convertible: 4, unconvertible: [] });
      const app = buildApp();
      const preview = await app.request(`/admin/monitor-conversion/partners/${PARTNER}/preview`, { method: 'POST' });
      expect(preview.status).toBe(200);
      expect((await preview.json()).data.previewHash).toBe('h1');
      const missing = await app.request(`/admin/monitor-conversion/partners/${PARTNER}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(missing.status).toBe(400);
      expect(mocks.convertPartnerLegacy).not.toHaveBeenCalled();
    });
    it('POST is MFA-gated', async () => {
      mocks.mfaAllowed.value = false;
      const res = await buildApp().request(`/admin/monitor-conversion/partners/${PARTNER}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewHash: 'partner-h' }) });
      expect(res.status).toBe(403);
      expect(mocks.convertPartnerLegacy).not.toHaveBeenCalled();
    });
    it('POST rejects a non-uuid partner id', async () => {
      const res = await buildApp().request('/admin/monitor-conversion/partners/not-a-uuid/convert', { method: 'POST' });
      expect(res.status).toBe(400);
    });
  });
  ```
  `MonitorConversionAdmin.test.tsx`:
  ```tsx
  import { fireEvent, render, screen, waitFor } from '@testing-library/react';
  import { expect, it, vi } from 'vitest';
  vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
  import { fetchWithAuth } from '../../stores/auth';
  import MonitorConversionAdmin from './MonitorConversionAdmin';
  it('requires a full preview before confirming and submits its hash', async () => {
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    const request = vi.mocked(fetchWithAuth);
    request.mockReset();
    request.mockResolvedValueOnce(json([{ partnerId: 'p1', partnerName: 'Acme', pendingRows: 3, pendingPolicies: 1 }]))
      .mockResolvedValueOnce(json({ partnerId: 'p1', previewHash: 'h1', rows: 5, policies: 2, convertible: 4,
        unconvertible: [{ sourceTable: 'alert_templates', sourceId: 's1', name: 'Nested rule', reason: 'unconvertible:nested_group', policyId: null, policyName: null }] }))
      .mockResolvedValueOnce(json({ policies: 2, converted: 4, unconvertible: 1 }))
      .mockResolvedValueOnce(json([]));
    render(<MonitorConversionAdmin />);
    fireEvent.click(await screen.findByTestId('admin-preview-p1'));
    expect(await screen.findByTestId('admin-conversion-confirm')).toHaveTextContent('5 rows across 2 policies');
    expect(screen.getByText(/Nested rule/)).toBeInTheDocument();
    expect(request.mock.calls.some(([url]) => String(url).endsWith('/convert'))).toBe(false);
    fireEvent.click(screen.getByTestId('admin-conversion-run'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/admin/monitor-conversion/partners/p1/convert', {
      method: 'POST', body: JSON.stringify({ previewHash: 'h1' }),
    }));
  });
  ```

- [ ] **Step 2: Run them, expect FAIL.** `cd apps/api && npx vitest run src/services/monitors/conversion/partnerBacklog.test.ts src/routes/admin/monitorConversion.test.ts` → `Failed to load url ./partnerBacklog` / `./monitorConversion`; `cd apps/web && npx vitest run src/components/admin/MonitorConversionAdmin.test.tsx` → resolve error.
- [ ] **Step 3: Implement.**
  `partnerBacklog.ts`:
  ```ts
  import { sql } from 'drizzle-orm';
  import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';

  export interface PartnerConversionBacklogRow {
    partnerId: string; partnerName: string; pendingRows: number; pendingPolicies: number;
  }

  /** The source tables this count reads — pinned by partnerBacklog.test.ts. */
  export const PARTNER_BACKLOG_SQL_SOURCES = [
    'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_templates', 'automations', 'config_policy_automations',
  ] as const;

  type Row = { partner_id: string; partner_name: string; pending_rows: number | string; pending_policies: number | string };

  /**
   * Unretired legacy rows per partner, for the hosted post-deploy sweep. Reads
   * every partner, so it runs under the system DB context (this is a
   * platform-admin surface; the caller is gated by platformAdminMiddleware).
   * `retired_at` columns land in W05c1's `2026-10-23-120000-legacy-source-retirement-columns.sql`.
   */
  export async function listPartnerConversionBacklog(): Promise<PartnerConversionBacklogRow[]> {
    const rows = await runOutsideDbContext(() => withSystemDbAccessContext(async () => db.execute<Row>(sql`
      WITH policy_partner AS (
        SELECT cp.id AS policy_id, COALESCE(cp.partner_id, o.partner_id) AS partner_id
        FROM configuration_policies cp
        LEFT JOIN organizations o ON o.id = cp.org_id
      ),
      pending AS (
        SELECT pp.partner_id, fl.config_policy_id AS policy_id
          FROM config_policy_alert_rules r
          JOIN config_policy_feature_links fl ON fl.id = r.feature_link_id
          JOIN policy_partner pp ON pp.policy_id = fl.config_policy_id
         WHERE r.retired_at IS NULL
        UNION ALL
        SELECT pp.partner_id, fl.config_policy_id
          FROM config_policy_monitoring_watches w
          JOIN config_policy_monitoring_settings s ON s.id = w.settings_id
          JOIN config_policy_feature_links fl ON fl.id = s.feature_link_id
          JOIN policy_partner pp ON pp.policy_id = fl.config_policy_id
         WHERE w.retired_at IS NULL
        UNION ALL
        SELECT pp.partner_id, fl.config_policy_id
          FROM config_policy_automations ca
          JOIN config_policy_feature_links fl ON fl.id = ca.feature_link_id
          JOIN policy_partner pp ON pp.policy_id = fl.config_policy_id
         WHERE ca.retired_at IS NULL AND ca.trigger_type = 'event' AND ca.event_type = 'alert.triggered'
        UNION ALL
        SELECT COALESCE(t.partner_id, o.partner_id), NULL::uuid
          FROM alert_templates t
          LEFT JOIN organizations o ON o.id = t.org_id
         WHERE t.retired_at IS NULL AND t.managed_by_monitor_id IS NULL
        UNION ALL
        SELECT COALESCE(a.partner_id, o.partner_id), NULL::uuid
          FROM automations a
          LEFT JOIN organizations o ON o.id = a.org_id
         WHERE a.retired_at IS NULL AND a.managed_by_monitor_id IS NULL
           AND a.trigger->>'type' = 'event'
           AND COALESCE(a.trigger->>'event', a.trigger->>'eventType') = 'alert.triggered'
           AND (a.trigger->'filter'->>'ruleId' IS NOT NULL OR a.trigger->'filter'->>'configPolicyAlertRuleId' IS NOT NULL)
      )
      SELECT p.id AS partner_id, p.name AS partner_name,
             count(pd.partner_id)::int AS pending_rows,
             count(DISTINCT pd.policy_id)::int AS pending_policies
        FROM partners p
        LEFT JOIN pending pd ON pd.partner_id = p.id
       GROUP BY p.id, p.name
       ORDER BY pending_rows DESC, p.name ASC
    `)));
    return [...rows].map((r) => ({
      partnerId: r.partner_id, partnerName: r.partner_name,
      pendingRows: Number(r.pending_rows), pendingPolicies: Number(r.pending_policies),
    }));
  }
  ```
  (Column names verified: `config_policy_alert_rules.feature_link_id`, `config_policy_monitoring_watches.settings_id` → `config_policy_monitoring_settings.feature_link_id`, `config_policy_automations.feature_link_id/trigger_type/event_type`, `automations.org_id/partner_id/trigger/managed_by_monitor_id`, `alert_templates.org_id/partner_id/managed_by_monitor_id` — `db/schema/configurationPolicies.ts:190-408`, `automations.ts:46-69`, `alerts.ts:40-70`.)
  `routes/admin/monitorConversion.ts`:
  ```ts
  import { Hono } from 'hono';
  import { z } from 'zod';
  import { zValidator } from '../../lib/validation';
  import { requireMfa } from '../../middleware/auth';
  import type { AuthContext } from '../../middleware/auth';
  import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
  import { writeRouteAudit } from '../../services/auditEvents';
  import { createSystemAuthContext } from '../../services/featureConfigResolver';
  import { convertPartnerLegacy, previewPartnerConversion } from '../../services/monitors/conversion';
  import { listPartnerConversionBacklog } from '../../services/monitors/conversion/partnerBacklog';

  /**
   * Platform-admin surface for the W05c hosted sweep (spec §Conversion "Who runs
   * it"): list every partner's unretired legacy rows and run the partner-level
   * converter for one partner. Mounted UNDER platformAdminMiddleware by
   * routes/admin/index.ts — the gate is deliberately not repeated here
   * (routes/admin/index.ts:16). MFA on the mutating verb, like tenant-erasure.
   */
  export const adminMonitorConversionRoutes = new Hono();

  const partnerParam = z.object({ partnerId: z.string().uuid() });

  /**
   * The converter needs a partner-scoped capability and a real actor. System
   * scope passes canManagePartnerWidePolicies; the platform admin's own user
   * row is what converted_by / created_by reference (the synthetic system
   * user id is not a users row).
   */
  export function adminAuthForPartner(auth: AuthContext, partnerId: string): AuthContext {
    return {
      ...createSystemAuthContext(),
      user: auth.user,
      partnerId,
      partnerOrgAccess: 'all',
    };
  }

  adminMonitorConversionRoutes.get('/partners', async (c) => {
    const data = await listPartnerConversionBacklog();
    return c.json({ data });
  });

  adminMonitorConversionRoutes.post('/partners/:partnerId/preview', requireMfa(), zValidator('param', partnerParam), async (c) => {
    const { partnerId } = c.req.valid('param');
    const data = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      previewPartnerConversion(partnerId, adminAuthForPartner(c.get('auth') as AuthContext, partnerId))));
    return c.json({ data });
  });

  adminMonitorConversionRoutes.post('/partners/:partnerId/convert', requireMfa(), zValidator('param', partnerParam), zValidator('json', z.object({ previewHash: z.string().min(1) })), async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { partnerId } = c.req.valid('param');
    const result = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => convertPartnerLegacy(partnerId, c.req.valid('json').previewHash, adminAuthForPartner(auth, partnerId))),
    );
    writeRouteAudit(c as never, {
      orgId: null,
      action: 'monitor_conversion.admin_partner_convert',
      resourceType: 'partner',
      resourceId: partnerId,
      details: result,
    });
    return c.json({ data: result });
  });
  ```
  Keep the system principal from `createSystemAuthContext`; the admin user remains the real audited actor. D7 uses null for unattended system writes, never the synthetic zero UUID. `routes/admin/index.ts`, after the sending-domains mount:
  ```ts
  import { adminMonitorConversionRoutes } from './monitorConversion';
  // Alerting consolidation W05c2: the hosted post-deploy conversion sweep.
  // Reads every partner (system scope) and runs W05c1's partner converter per
  // partner with the admin as the actor; MFA on the POST.
  adminRoutes.route('/monitor-conversion', adminMonitorConversionRoutes);
  ```
  `MonitorConversionAdmin.tsx`:
  ```tsx
  import { useEffect, useState } from 'react';
  import { fetchWithAuth } from '../../stores/auth';
  import { ActionError, runAction } from '@/lib/runAction';
  import { showToast } from '../shared/Toast';
  import { readPartnerPreview, readPartnerConvertResult, type PartnerConversionPreview } from '../monitoring/conversion/conversionApi';
  type Row = { partnerId: string; partnerName: string; pendingRows: number; pendingPolicies: number };
  export default function MonitorConversionAdmin() {
    const [rows, setRows] = useState<Row[]>([]);
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<PartnerConversionPreview | null>(null);
    const [results, setResults] = useState<Record<string, string>>({});
    const load = async () => {
      try {
        const response = await fetchWithAuth('/admin/monitor-conversion/partners');
        if (!response.ok) throw new Error(response.status === 403 ? 'Platform administrator required' : 'Failed to load backlog');
        setRows((await response.json()).data); setError(undefined);
      } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load backlog'); }
    };
    useEffect(() => { void load(); }, []);
    const act = async (partnerId: string, confirm: boolean) => {
      if (confirm && preview?.partnerId !== partnerId) return;
      setBusy(true);
      try {
        if (!confirm) {
          setPreview(null);
          setPreview(await runAction({
            request: () => fetchWithAuth(`/admin/monitor-conversion/partners/${partnerId}/preview`, { method: 'POST' }),
            errorFallback: 'Preview failed', parseSuccess: readPartnerPreview,
          }));
        } else {
          const result = await runAction({
            request: () => fetchWithAuth(`/admin/monitor-conversion/partners/${partnerId}/convert`, {
              method: 'POST', body: JSON.stringify({ previewHash: preview!.previewHash }),
            }), errorFallback: 'Conversion failed', parseSuccess: readPartnerConvertResult,
            successMessage: 'Conversion complete',
          });
          setResults((old) => ({ ...old, [partnerId]: `Converted ${result.converted} · ${result.unconvertible} unconvertible` }));
          setPreview(null); await load();
        }
      } catch (err) {
        setPreview(null); // stale hash requires a fresh preview and deliberate confirmation
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Conversion request failed' });
      } finally { setBusy(false); }
    };
    return <section><h1>Legacy alert conversion</h1>
      <p>Preview each partner and record conversion results in the release checklist.</p>
      {error && <p role="alert">{error}<button onClick={() => void load()}>Retry</button></p>}
      <table><thead><tr><th>Partner</th><th>Pending rows</th><th>Pending policies</th><th>Last result</th><th>Action</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.partnerId}><td>{row.partnerName}</td><td>{row.pendingRows}</td><td>{row.pendingPolicies}</td>
          <td>{results[row.partnerId]}</td><td><button data-testid={`admin-preview-${row.partnerId}`} disabled={busy}
            onClick={() => void act(row.partnerId, false)}>Preview</button></td></tr>)}</tbody></table>
      {preview && <div data-testid="admin-conversion-confirm">
        <p>{preview.rows} rows across {preview.policies} policies; {preview.convertible} convertible.</p>
        <ul>{preview.unconvertible.map((item) => <li key={`${item.sourceTable}:${item.sourceId}`}>
          {item.policyName ?? 'Standalone'} · {item.name} · {item.reason}
        </li>)}</ul>
        <p>Unconvertible sources remain for review or manual retirement in W05c. W05d processes leftovers.</p>
        <button disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
        <button data-testid="admin-conversion-run" disabled={busy} onClick={() => void act(preview.partnerId, true)}>Convert reviewed scope</button>
      </div>}
    </section>;
  }
  ```
  Astro `admin/monitor-conversion.astro` uses the existing admin layout pattern:
  ```astro
  ---
  import DashboardLayout from '../../layouts/DashboardLayout.astro';
  import MonitorConversionAdmin from '../../components/admin/MonitorConversionAdmin';
  ---
  <DashboardLayout titleKey="titles.adminMonitorConversion"><MonitorConversionAdmin client:load /></DashboardLayout>
  ```
  `pages.json` `titles.adminMonitorConversion`: en "Legacy Alert Conversion" · de-DE "Konvertierung alter Alarmregeln" · es-419 "Conversión de alertas heredadas" · fr "Conversion des alertes héritées" · it-IT "Conversione avvisi legacy" · pt-BR "Conversão de alertas legados" · tr-TR "Eski uyarı dönüştürme".
- [ ] **Step 4: Run, expect PASS.**
  ```bash
  cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/monitors/conversion/partnerBacklog.test.ts src/routes/admin/monitorConversion.test.ts src/routes/admin/sendingDomains.test.ts \
    src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts
  cd ../web && npx tsc --noEmit -p . && npx vitest run src/components/admin/MonitorConversionAdmin.test.tsx src/lib/i18n src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts
  ```
  (`partner-wide-write-coverage` and `site-ceiling-write-coverage` scan files that mutate dual-axis tables; neither new API file writes one directly — if a scanner still flags `monitorConversion.ts`, add the allowlist entry with the reason "delegates to W05c1's converter under system scope; platform-admin + MFA gated".)
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/conversion/partnerBacklog.ts apps/api/src/services/monitors/conversion/partnerBacklog.test.ts apps/api/src/routes/admin/monitorConversion.ts apps/api/src/routes/admin/monitorConversion.test.ts apps/api/src/routes/admin/index.ts apps/web/src/components/admin/MonitorConversionAdmin.tsx apps/web/src/components/admin/MonitorConversionAdmin.test.tsx apps/web/src/pages/admin/monitor-conversion.astro apps/web/src/locales/*/pages.json && git commit -m "feat(admin): legacy alert conversion page — per-partner backlog and Convert (hosted sweep)"`

---

### Task 8: Persistent conversion history and lifecycle-aware Undo (PR1)

**Files:**
- Create: `apps/web/src/components/monitoring/conversion/ConversionLedger.tsx`, `ConversionLedger.test.tsx`.
- Modify: Task 6 `LegacyRulesTable.tsx` (new planned file, refresh callback); Task 1 `conversionApi.ts` / `conversionApi.test.ts` (planned files); Task 5 `MonitorsTab.tsx` integration (`apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx:52–58,210–214` on base); Task 6 `MonitorsListPage.tsx:32–59,136–154`.
- Modify: `apps/web/src/locales/*/monitoring.json` (all eight locales), `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35–59`.

**Interfaces:**
- Consumes D2 `GET /monitor-definitions/conversion/ledger?orgId&policyId&cursor&limit` → `{ items: ConversionLedgerEntry[]; nextCursor: string | null }`, scoped and authorized by C1 Task 14. Uses Task 1 mirrors and `conversionPaths.ledger/revert`. API query parameters are server-side filters/pagination, not transient UI state.
- Produces `ConversionLedger({ orgId?, policyId?, revision?, onChanged? })`, mounted independently of `hasLegacyRows` or pending counts; pagination and retry; every entry lists source, actor (null = system), date and outputs; zero-output manual retirement entries remain visible. D4 `revertable` disables Undo; HTTP 409 invalidates the stale ledger and displays the error via `runAction`.

- [ ] **Step 1: Write the failing tests.** `ConversionLedger.test.tsx`:
  ```tsx
  import '@/lib/i18n';
  import { fireEvent, render, screen, waitFor } from '@testing-library/react';
  import { beforeEach, expect, it, vi } from 'vitest';
  vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
  import { fetchWithAuth } from '../../../stores/auth';
  import ConversionLedger from './ConversionLedger';
  const request = vi.mocked(fetchWithAuth);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const entry = { id: 'c1', sourceTable: 'alert_templates', sourceId: 's1', sourceName: 'Retired template',
    policyId: null, convertedBy: null, convertedAt: '2026-09-19T00:00:00Z', revertedAt: null,
    revertable: true, outputs: [] };
  beforeEach(() => vi.resetAllMocks());
  it('loads retirement history on a later visit and reverts then refreshes it', async () => {
    request.mockResolvedValueOnce(json({ items: [entry], nextCursor: null }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({ items: [{ ...entry, revertedAt: '2026-09-20', revertable: false }], nextCursor: null }));
    const changed = vi.fn();
    render(<ConversionLedger policyId="p1" onChanged={changed} />);
    fireEvent.click(await screen.findByTestId('ledger-undo-c1'));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/monitor-definitions/conversion/c1/revert', { method: 'POST' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('ledger-undo-c1')).toBeDisabled());
  });
  it('paginates and disables Undo when the runtime is retired', async () => {
    request.mockResolvedValueOnce(json({ items: [{ ...entry, revertable: false }], nextCursor: 'next' }))
      .mockResolvedValueOnce(json({ items: [{ ...entry, id: 'c2' }], nextCursor: null }));
    render(<ConversionLedger />);
    expect(await screen.findByTestId('ledger-undo-c1')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ledger-more'));
    expect(await screen.findByTestId('ledger-undo-c2')).toBeEnabled();
    expect(String(request.mock.calls[1]![0])).toContain('cursor=next');
  });
  it('refreshes lifecycle state after a 409 and never reports successful Undo', async () => {
    request.mockResolvedValueOnce(json({ items: [entry], nextCursor: null }))
      .mockResolvedValueOnce(json({ error: 'conversion_revert_unavailable' }, 409))
      .mockResolvedValueOnce(json({ items: [{ ...entry, revertable: false }], nextCursor: null }));
    const changed = vi.fn(); render(<ConversionLedger onChanged={changed} />);
    fireEvent.click(await screen.findByTestId('ledger-undo-c1'));
    await waitFor(() => expect(screen.getByTestId('ledger-undo-c1')).toBeDisabled());
    expect(changed).not.toHaveBeenCalled();
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/conversion/ConversionLedger.test.tsx` → missing `./ConversionLedger`.
- [ ] **Step 3: Implement.** `ConversionLedger.tsx`:
  ```tsx
  import { useCallback, useEffect, useRef, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth } from '../../../stores/auth';
  import { ActionError, runAction } from '@/lib/runAction';
  import { showToast } from '../../shared/Toast';
  import { conversionPaths, type ConversionLedgerEntry, type LedgerPage } from './conversionApi';
  export default function ConversionLedger({ orgId, policyId, revision = 0, onChanged }: {
    orgId?: string; policyId?: string; revision?: number; onChanged?: () => void;
  }) {
    const { t } = useTranslation(['monitoring', 'common']);
    const [rows, setRows] = useState<ConversionLedgerEntry[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);
    const generation = useRef(0);
    const load = useCallback(async (next?: string) => {
      const current = ++generation.current;
      setLoading(true); setError(false);
      try {
        const response = await fetchWithAuth(conversionPaths.ledger({ orgId, policyId, cursor: next, limit: 25 }));
        if (!response.ok) throw new Error('ledger_read_failed');
        const page: LedgerPage = await response.json();
        if (current !== generation.current) return;
        setRows((old) => next ? [...old, ...page.items] : page.items); setCursor(page.nextCursor);
      } catch { if (current === generation.current) setError(true); }
      finally { if (current === generation.current) setLoading(false); }
    }, [orgId, policyId]);
    useEffect(() => { setRows([]); void load(); return () => { generation.current++; }; }, [load, revision]);
    const undo = async (row: ConversionLedgerEntry) => {
      if (!row.revertable || row.revertedAt || busy) return;
      setBusy(true);
      try {
        await runAction({ request: () => fetchWithAuth(conversionPaths.revert(row.id), { method: 'POST' }),
          errorFallback: t('monitoring:conversion.errors.revert'), successMessage: t('monitoring:conversion.undone', { count: 1 }) });
        onChanged?.();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:conversion.errors.revert') });
      } finally { setBusy(false); await load(); }
    };
    return <section data-testid="conversion-ledger" className="space-y-3 rounded border p-4">
      <h3>{t('monitoring:conversion.ledger.title')}</h3>
      <p>{t('monitoring:conversion.ledger.deadline')}</p>
      {loading && <p>{t('common:states.loading')}</p>}
      {error && <button onClick={() => void load()}>{t('common:actions.retry')}</button>}
      {!loading && !error && rows.length === 0 && <p>{t('monitoring:conversion.ledger.empty')}</p>}
      <ul>{rows.map((row) => <li key={row.id}>
        <p>{row.sourceName} · {row.convertedAt} · {row.convertedBy ?? t('monitoring:conversion.ledger.system')}</p>
        <ul>{row.outputs.map((output) => <li key={`${output.monitorId}:${output.role}`}>
          <a href={`/alerts/monitors/${output.monitorId}`}>{output.monitorId}</a> · {output.role}
        </li>)}</ul>
        <button data-testid={`ledger-undo-${row.id}`} disabled={loading || error || busy || !row.revertable || !!row.revertedAt}
          onClick={() => void undo(row)}>{t('monitoring:conversion.ledger.undo')}</button>
      </li>)}</ul>
      {cursor && <button data-testid="ledger-more" disabled={loading} onClick={() => void load(cursor)}>{t('monitoring:conversion.ledger.more')}</button>}
    </section>;
  }
  ```
  In `MonitorsTab`, import the ledger and add `const [ledgerRevision, setLedgerRevision] = useState(0);`. At the beginning of Task 5's `refreshLinks`, call `setLedgerRevision((n) => n + 1);`. Render independently after the panel:
  ```tsx
  <ConversionLedger policyId={policyId} revision={ledgerRevision} onChanged={() => void refreshLinks()} />
  ```
  In `MonitorsListPage`, add `const [ledgerRevision, setLedgerRevision] = useState(0);`, increment it after each successful `fetchMonitors` response, import the ledger and render `<ConversionLedger orgId={currentOrgId ?? undefined} revision={ledgerRevision} onChanged={() => void fetchMonitors()} />` outside the conditional table/filter content. In `LegacyRulesTable`, accept optional `onConverted?: () => void`, call it after a successful conversion, and mount `<LegacyRulesTable onConverted={() => void fetchMonitors()} />` so template-group conversions refresh persistent history too. Add its component path to the mutation guard. All eight `monitoring.json` files gain `conversion.ledger`:

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | title | Conversion history | Konvertierungsverlauf | Historial de conversión | Historique des conversions | Cronologia conversioni | Histórico de conversão | Dönüştürme geçmişi |
  | undo | Undo | Rückgängig | Deshacer | Annuler | Annulla | Desfazer | Geri al |
  | more | Load more | Mehr laden | Cargar más | Charger plus | Carica altro | Carregar mais | Daha fazla yükle |
  | empty | No conversion history. | Kein Konvertierungsverlauf. | No hay historial de conversión. | Aucun historique de conversion. | Nessuna conversione precedente. | Nenhum histórico de conversão. | Dönüştürme geçmişi yok. |
  | system | System | System | Sistema | Système | Sistema | Sistema | Sistem |
  | deadline | Undo is unavailable after W05d removes the source runtime. | Rückgängig ist nach Entfernung der Quelllaufzeit durch W05d nicht verfügbar. | Deshacer no está disponible cuando W05d elimina el evaluador de origen. | L'annulation est indisponible après la suppression du moteur source par W05d. | Annullamento non disponibile dopo la rimozione del motore di origine in W05d. | Desfazer fica indisponível após W05d remover o avaliador de origem. | W05d kaynak değerlendiriciyi kaldırdıktan sonra geri alma kullanılamaz. |

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/monitoring/conversion src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring/conversion apps/web/src/components/monitoring/MonitorsListPage.tsx apps/web/src/components/configurationPolicies/featureTabs/MonitorsTab.tsx apps/web/src/locales/*/monitoring.json apps/web/src/lib/__tests__/no-silent-mutations.test.ts && git commit -m "feat(alerts): persist conversion history and lifecycle-aware Undo"`

---

### Task 9: Alert workflows — typed severity and monitor-kind filters with lossless saves (PR2)

**Files:**
- Create: `apps/web/src/components/automations/alertWorkflowFilter.ts`, `alertWorkflowFilter.test.ts`.
- Modify: `apps/web/src/components/automations/AutomationForm.tsx` (schema 111–125, defaults 244–257, event controls 452–471), `AutomationForm.test.tsx` (existing form harness 1–105).
- Modify: `apps/web/src/components/automations/AutomationEditPage.tsx` (load 201–247, trigger builder 323–349, mutation 373–393), `AutomationEditPage.test.tsx` (fixtures 38–61).
- Modify: `apps/web/src/components/automations/AutomationsPage.tabs.test.tsx` (41–54); `apps/web/src/locales/*/scripts.json` (all eight locales, `automationsPage.tabs.event-rules` and new `automationForm.alertWorkflow` keys; English tab label at line 364).
- Modify: `apps/api/src/jobs/automationWorker.test.ts` (trigger tests 40–84); production matcher at `automationWorker.ts:136–181` remains unchanged.
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (TARGET_GLOBS).

**Interfaces:**
- Consumes: W05c1 `alert.triggered` payload `{ severity, kind, monitorId }`; `MONITOR_KINDS` and existing `monitoring:kinds.*` / `monitoring:severities.*` translations; `AutomationTrigger.filter?: Record<string, unknown>` and existing `valuesEqual` array-membership behavior (`automationWorker.ts:145–150`).
- D12: C1 rehomes broad policy workflows into standalone policy-assigned workflows; these stay visible under Jobs and are never unconvertible/retirement candidates. The UI refreshes the singular `automation` feature link after rehoming.
- Produces: optional UI multiselects serialized as `trigger.filter.severity: string[]` and `trigger.filter.kind: MonitorKind[]`. Empty selection removes that key, meaning any value; a selected kind rejects a sourced alert with no kind. Existing `ruleId`, `configPolicyAlertRuleId`, nested filters and unknown compatibility keys round-trip unchanged. The API keeps its free-form record; do not introduce plural payload keys `severities` or `monitorKinds` that the matcher cannot read. `#event-rules` remains the URL hash; its label becomes **Alert workflows**. No new API route or trigger type.

- [ ] **Step 1: Write the failing tests.** Create `alertWorkflowFilter.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { readWorkflowSelection, writeWorkflowSelection } from './alertWorkflowFilter';
  describe('alert workflow filter editing', () => {
    it('reads legacy scalar values and updates only the chosen dimension', () => {
      const stored = { severity: 'critical', ruleId: 'rule-a', 'device.tags': ['prod'] };
      expect(readWorkflowSelection(stored, 'severity')).toEqual(['critical']);
      expect(writeWorkflowSelection(stored, 'kind', ['cpu', 'memory'])).toEqual({
        ...stored, kind: ['cpu', 'memory'],
      });
      expect(stored).not.toHaveProperty('kind');
    });
    it('empty selection removes a restriction without deleting compatibility filters', () => {
      expect(writeWorkflowSelection({ severity: ['high'], ruleId: 'r' }, 'severity', []))
        .toEqual({ ruleId: 'r' });
      expect(readWorkflowSelection(undefined, 'kind')).toEqual([]);
    });
  });
  ```
  Append to `AutomationForm.test.tsx`:
  ```tsx
  it('submits typed alert filters without erasing a ruleId restriction', async () => {
    const onSubmit = vi.fn();
    render(<AutomationForm onSubmit={onSubmit} defaultValues={{
      name: 'Critical CPU', triggerType: 'event', eventType: 'alert.triggered',
      eventFilter: { ruleId: 'r1', severity: ['critical'] },
      actions: [{ type: 'execute_command', command: 'echo triage' }],
    }} />);
    fireEvent.click(screen.getByTestId('workflow-kind-cpu'));
    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].eventFilter).toEqual({
      ruleId: 'r1', severity: ['critical'], kind: ['cpu'],
    });
  });
  ```
  Append to `AutomationEditPage.test.tsx` (existing imports and `mockEndpoints`):
  ```tsx
  it('preserves the loaded filter on an unrelated edit', async () => {
    const filter = { ruleId: 'r1', severity: ['critical'], kind: ['cpu'] };
    mockEndpoints({ ...baseAutomation, trigger: { ...baseAutomation.trigger, filter },
      actions: [{ type: 'execute_command', command: 'echo test' }] });
    render(<AutomationEditPage automationId="automation-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(JSON.parse(String(call[1]!.body)).trigger.filter).toEqual(filter);
  });
  ```
  Append to `automationWorker.test.ts` using its imported `shouldTriggerEventAutomation`:
  ```ts
  it('matches alert dimensions conjunctively, choices disjunctively, and preserves ruleId', () => {
    const trigger = { type: 'event' as const, eventType: 'alert.triggered',
      filter: { severity: ['critical', 'high'], kind: ['cpu', 'memory'], ruleId: 'r1' } };
    for (const severity of ['critical', 'high']) {
      expect(shouldTriggerEventAutomation(trigger, 'alert.triggered', { severity, kind: 'cpu', ruleId: 'r1' })).toBe(true);
    }
    for (const payload of [
      { severity: 'low', kind: 'cpu', ruleId: 'r1' },
      { severity: 'high', ruleId: 'r1' },
      { severity: 'high', kind: 'cpu', ruleId: 'r2' },
    ]) expect(shouldTriggerEventAutomation(trigger, 'alert.triggered', payload)).toBe(false);
    expect(shouldTriggerEventAutomation({ ...trigger, filter: {} }, 'alert.triggered', {})).toBe(true);
  });
  ```
  Replace both role queries for `Event rules` in `AutomationsPage.tabs.test.tsx` with `Alert workflows`; keep the hash assertion unchanged.

- [ ] **Step 2: Run it, expect FAIL.** From the repo root:
  ```bash
  cd apps/web && npx vitest run src/components/automations/alertWorkflowFilter.test.ts src/components/automations/AutomationForm.test.tsx src/components/automations/AutomationEditPage.test.tsx src/components/automations/AutomationsPage.tabs.test.tsx
  ```
  Expected: `Failed to resolve import "./alertWorkflowFilter"`, missing `workflow-kind-cpu`, and `expected undefined to deeply equal` the saved filter. The new API matcher test already passes; it pins existing behavior rather than requiring an unnecessary worker rewrite.

- [ ] **Step 3: Implement.** `alertWorkflowFilter.ts`:
  ```ts
  export type WorkflowFilter = Record<string, unknown>;
  export function readWorkflowSelection(filter: WorkflowFilter | undefined, key: 'severity' | 'kind'): string[] {
    const value = filter?.[key];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
  export function writeWorkflowSelection(filter: WorkflowFilter | undefined, key: 'severity' | 'kind', values: string[]): WorkflowFilter {
    const next = { ...filter };
    if (values.length) next[key] = [...new Set(values)];
    else delete next[key];
    return next;
  }
  ```
  In `AutomationForm.tsx`, import `MONITOR_KINDS` from `@breeze/shared` and the two helpers. Add `eventFilter: z.record(z.string(), z.unknown()).optional(),` beside `eventType` in the schema. Preserve it through the existing `...defaultValues`; do not default it to `{}`. Add after the event `<select>`:
  ```tsx
  {watch('eventType') === 'alert.triggered' && (
    <div className="space-y-3" data-testid="workflow-filter">
      <p className="text-xs text-muted-foreground">{t('automationForm.alertWorkflow.hint')}</p>
      {(['severity', 'kind'] as const).map((dimension) => {
        const selected = readWorkflowSelection(watch('eventFilter'), dimension);
        const options = dimension === 'kind' ? MONITOR_KINDS : ['critical', 'high', 'medium', 'low', 'info'];
        return <fieldset key={dimension} className="rounded border p-3">
          <legend>{t(`automationForm.alertWorkflow.${dimension}`)}</legend>
          <div className="flex flex-wrap gap-3">
            {options.map((value) => <label key={value} className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid={`workflow-${dimension}-${value}`}
                checked={selected.includes(value)} onChange={(event) => {
                  const values = event.target.checked ? [...selected, value] : selected.filter((v) => v !== value);
                  setValue('eventFilter', writeWorkflowSelection(watch('eventFilter'), dimension, values), { shouldDirty: true });
                }} />
              {t(`monitoring:${dimension === 'kind' ? 'kinds' : 'severities'}.${value}`)}
            </label>)}
          </div>
        </fieldset>;
      })}
    </div>
  )}
  ```
  In `AutomationEditPage.tsx`, load `eventType: asString(trigger.eventType) ?? asString(trigger.event),` and `eventFilter: isPlainRecord(trigger.filter) ? trigger.filter : undefined,`. In the event trigger object add `...(values.eventFilter ? { filter: values.eventFilter } : {}),`. Existing non-alert filters stay intact even though their controls are hidden. Add imports for `ActionError, runAction` from `@/lib/runAction` and `showToast` from `../shared/Toast`; replace the fetch-and-response-check block with:
  ```ts
  await runAction({
    request: () => fetchWithAuth(url, { method, body: JSON.stringify(payload) }),
    errorFallback: t('automationEditPage.errors.save'),
    successMessage: t('common:states.saved'),
  });
  void navigateTo('/jobs');
  ```
  The existing `common:states.saved` key (English `common.json:158`) is already translated in all eight locales. Replace the save catch body with:
  ```ts
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('automationEditPage.errors.generic') });
  setError(err instanceof Error ? err.message : t('automationEditPage.errors.generic'));
  ```
  Register `src/components/automations/AutomationEditPage.tsx` in TARGET_GLOBS. Locale values (write both French files independently; first row replaces the existing tab key, others are under `automationForm.alertWorkflow`):

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | `automationsPage.tabs.event-rules` | Alert workflows | Alarmabläufe | Flujos de alertas | Flux d'alertes | Flussi degli avvisi | Fluxos de alertas | Uyarı iş akışları |
  | `severity` | Severities | Schweregrade | Severidades | Gravités | Gravità | Severidades | Önem dereceleri |
  | `kind` | Monitor kinds | Monitorarten | Tipos de monitor | Types de moniteur | Tipi di monitor | Tipos de monitor | Monitör türleri |
  | `hint` | Leave a group empty to match any value. Existing advanced filters are preserved. | Eine leere Gruppe passt auf jeden Wert. Bestehende erweiterte Filter bleiben erhalten. | Deje un grupo vacío para aceptar cualquier valor. Se conservan los filtros avanzados existentes. | Laissez un groupe vide pour accepter toute valeur. Les filtres avancés existants sont conservés. | Lascia un gruppo vuoto per accettare qualsiasi valore. I filtri avanzati esistenti vengono conservati. | Deixe um grupo vazio para aceitar qualquer valor. Os filtros avançados existentes são preservados. | Her değeri eşleştirmek için grubu boş bırakın. Mevcut gelişmiş filtreler korunur. |

- [ ] **Step 4: Run, expect PASS.** Each command starts at the repo root:
  ```bash
  (cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/automations/alertWorkflowFilter.test.ts src/components/automations/AutomationForm.test.tsx src/components/automations/AutomationEditPage.test.tsx src/components/automations/AutomationsPage.tabs.test.tsx src/components/automations/AutomationsPage.managed.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts)
  (cd apps/api && npx tsc --noEmit -p . && npx vitest run src/jobs/automationWorker.test.ts)
  ```
- [ ] **Step 5: Commit.** `git add apps/web/src/components/automations/alertWorkflowFilter* apps/web/src/components/automations/AutomationForm* apps/web/src/components/automations/AutomationEditPage* apps/web/src/components/automations/AutomationsPage.tabs.test.tsx apps/web/src/locales/*/scripts.json apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/api/src/jobs/automationWorker.test.ts && git commit -m "feat(jobs): author typed alert workflow filters without losing advanced filters"`

---

### Task 10: Device Monitoring tab — effective monitors, episodes and escalation reset (PR2)

**Files:**
- Create: `apps/api/src/routes/devices/monitors.ts` and `apps/api/src/__tests__/integration/deviceMonitors.integration.test.ts`.
- Modify: `apps/api/src/routes/devices/index.ts` (mounts 132–145).
- Replace: `apps/web/src/components/devices/DeviceMonitoringTab.tsx` (1–200), `DeviceMonitoringTab.test.tsx` (1–94).
- Modify: `apps/web/src/locales/*/monitoring.json` (eight files, new `device` block), `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (TARGET_GLOBS).
- Read/reuse: `DeviceDetails.tsx:472–475,918–922` (already mounts this component on `#monitoring`); `routes/devices/helpers.ts:187–239`; `services/monitors/monitorResolver.ts:40–69,97–99`; `db/schema/monitorEpisodes.ts:88–125`; `routes/monitorDefinitions.ts:690–724`; `MonitorActivityTab.tsx:134–142`.

**Interfaces:**
- Consumes: `resolveMonitorsForDevice(deviceId, executor = db): Promise<MonitorResolution>` where resolution is `{ kind: 'device_missing' } | { kind: 'resolved'; monitors: EffectiveMonitor[] }`. `EffectiveMonitor` supplies attachment provenance, overrides and enabled state, not definition names or conditions. Joins `monitorDefinitions`, `configurationPolicies`, `monitorDeviceState`, and open `monitorEpisodes` under the request DB context.
- Produces: `GET /devices/:id/monitors → { data: DeviceEffectiveMonitorRow[] }` with row type below. Unknown evidence renders unknown; disabled effective winners remain visible. Device missing/inaccessible org → 404, denied site → 403, invalid UUID → 400, no auth → 401, no device-read permission → 403.
- Consumes existing mutation: `POST /monitor-definitions/:id/devices/:deviceId/reset` with no body. Existing route owns alert-write permission, MFA and tenant/site authorization. Reset clears the recurrence latch and resumes responses; it does not close the episode or resolve its alert. UI uses `location.hash` through the unchanged device shell.

- [ ] **Step 1: Write the failing tests.** Replace the watch test with `DeviceMonitoringTab.test.tsx`:
  ```tsx
  import '@/lib/i18n';
  import { fireEvent, render, screen, waitFor } from '@testing-library/react';
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
  vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
  import { fetchWithAuth } from '../../stores/auth';
  import { showToast } from '../shared/Toast';
  import DeviceMonitoringTab from './DeviceMonitoringTab';
  const fetchMock = vi.mocked(fetchWithAuth);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const row = { monitorId: 'm1', name: 'CPU high', kind: 'cpu', enabled: true,
    sourcePolicyId: 'p1', sourcePolicyName: 'Servers', lastState: 'breach',
    openEpisode: { id: 'ep1', alertId: 'a1', startedAt: '2026-09-19T10:00:00Z' },
    escalatedAt: '2026-09-19T11:00:00Z', responsesPaused: true };
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(window, 'confirm').mockReturnValue(true); });
  describe('effective device monitors', () => {
    it('loads effective monitors and shows policy, state and episode', async () => {
      fetchMock.mockResolvedValue(json({ data: [row] }));
      render(<DeviceMonitoringTab deviceId="d1" />);
      expect(await screen.findByText('CPU high')).toHaveAttribute('href', '/alerts/monitors/m1');
      expect(fetchMock).toHaveBeenCalledWith('/devices/d1/monitors');
      expect(screen.getByText('Servers')).toHaveAttribute('href', '/configuration-policies/p1#monitors');
      expect(screen.getByTestId('device-monitoring-row')).toHaveTextContent('Breach');
      expect(screen.getByTestId('device-monitor-episode-m1')).toHaveAttribute('href', '/alerts/a1');
    });
    it('shows unknown evidence and disabled effective attachments without a reset action', async () => {
      fetchMock.mockResolvedValue(json({ data: [{ ...row, enabled: false, lastState: 'unknown',
        openEpisode: null, escalatedAt: null, responsesPaused: false }] }));
      render(<DeviceMonitoringTab deviceId="d1" />);
      expect(await screen.findByTestId('device-monitoring-row')).toHaveTextContent('Unknown');
      expect(screen.getByTestId('device-monitoring-row')).toHaveTextContent('Disabled');
      expect(screen.queryByTestId('device-monitor-reset-m1')).toBeNull();
    });
    it('resets a latch through runAction and reloads', async () => {
      fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST' ? json({ success: true }) : json({ data: [row] }));
      render(<DeviceMonitoringTab deviceId="d1" />);
      fireEvent.click(await screen.findByTestId('device-monitor-reset-m1'));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/m1/devices/d1/reset', { method: 'POST' }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
      expect(fetchMock.mock.calls.filter(([url]) => url === '/devices/d1/monitors')).toHaveLength(2);
    });
    it('reports a logical failure without a false success or reload', async () => {
      fetchMock.mockImplementation(async (_url, init) => init?.method === 'POST'
        ? json({ success: false, error: 'Reset refused' }) : json({ data: [row] }));
      render(<DeviceMonitoringTab deviceId="d1" />);
      fireEvent.click(await screen.findByTestId('device-monitor-reset-m1'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
      expect(fetchMock.mock.calls.filter(([url]) => url === '/devices/d1/monitors')).toHaveLength(1);
    });
    it('distinguishes no effective monitors from a failed read', async () => {
      fetchMock.mockResolvedValue(json({ data: [] }));
      const view = render(<DeviceMonitoringTab deviceId="d1" />);
      expect(await screen.findByTestId('device-monitoring-empty')).toBeInTheDocument();
      view.unmount();
      fetchMock.mockResolvedValue(json({ error: 'Denied' }, 403));
      render(<DeviceMonitoringTab deviceId="d2" />);
      expect(await screen.findByTestId('device-monitoring-error')).toBeInTheDocument();
    });
  });
  ```
  Create the live endpoint proof (read the existing `monitoringKnownServicesSiteScope.integration.test.ts` and `monitorDefinitionsPartnerRls.integration.test.ts` fixtures before editing):
  ```ts
  import './setup';
  import { randomUUID } from 'node:crypto';
  import { describe, expect, it } from 'vitest';
  import { Hono } from 'hono';
  import { eq } from 'drizzle-orm';
  import { getTestDb } from './setup';
  import { createSite, setupTestEnvironment } from './db-utils';
  import { clearPermissionCache } from '../../services/permissions';
  import { monitorsRoutes } from '../../routes/devices/monitors';
  import { devices, organizationUsers, configurationPolicies, configPolicyFeatureLinks,
    configPolicyMonitors, configPolicyAssignments, monitorDefinitions, monitorEpisodes,
    monitorDeviceState } from '../../db/schema';
  describe('device effective monitors under request RLS', () => {
    it('joins provenance and episodes without crossing org or site boundaries', async () => {
      const env = await setupTestEnvironment({ scope: 'organization',
        rolePermissions: [{ resource: 'devices', action: 'read' }] });
      const hidden = await createSite({ orgId: env.organization.id });
      const testDb = getTestDb();
      const [visible, denied] = await testDb.insert(devices).values([env.site.id, hidden.id].map((siteId) => ({
        orgId: env.organization.id, siteId, agentId: randomUUID(), hostname: siteId,
        osType: 'linux' as const, osVersion: '1', architecture: 'amd64', agentVersion: '1',
      }))).returning();
      const [monitor] = await testDb.insert(monitorDefinitions).values({
        orgId: env.organization.id, name: 'CPU test', kind: 'cpu',
        condition: { operator: 'gt', value: 90 }, severity: 'high',
      }).returning();
      const [policy] = await testDb.insert(configurationPolicies).values({
        orgId: env.organization.id, name: 'Test policy', status: 'active',
      }).returning();
      const [link] = await testDb.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy!.id, featureType: 'monitors',
      }).returning();
      await testDb.insert(configPolicyMonitors).values({ featureLinkId: link!.id, monitorId: monitor!.id });
      await testDb.insert(configPolicyAssignments).values({
        configPolicyId: policy!.id, level: 'organization', targetId: env.organization.id,
      });
      const [episode] = await testDb.insert(monitorEpisodes).values({
        monitorId: monitor!.id, deviceId: visible!.id, orgId: env.organization.id,
      }).returning();
      await testDb.insert(monitorDeviceState).values({ monitorId: monitor!.id,
        deviceId: visible!.id, orgId: env.organization.id, currentEpisodeId: episode!.id,
        lastState: 'breach', responsesPaused: true, escalatedAt: new Date(),
      });
      await testDb.update(organizationUsers).set({ siteIds: [env.site.id] })
        .where(eq(organizationUsers.userId, env.user.id));
      await clearPermissionCache(env.user.id);
      const app = new Hono().route('/devices', monitorsRoutes);
      const get = (id: string, token = env.token) => app.request(`/devices/${id}/monitors`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const response = await get(visible!.id);
      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual([expect.objectContaining({
        monitorId: monitor!.id, sourcePolicyId: policy!.id, sourcePolicyName: 'Test policy',
        lastState: 'breach', responsesPaused: true,
        openEpisode: expect.objectContaining({ id: episode!.id }),
      })]);
      expect((await get(denied!.id)).status).toBe(403);
      const foreign = await setupTestEnvironment({ scope: 'organization',
        rolePermissions: [{ resource: 'devices', action: 'read' }] });
      expect((await get(visible!.id, foreign.token)).status).toBe(404);
      expect((await get(randomUUID())).status).toBe(404);
      expect((await get('not-a-uuid')).status).toBe(400);
      expect((await app.request(`/devices/${visible!.id}/monitors`)).status).toBe(401);
      const noRead = await setupTestEnvironment({ scope: 'organization', rolePermissions: [] });
      expect((await get(visible!.id, noRead.token)).status).toBe(403);
    });
  });
  ```

- [ ] **Step 2: Run it, expect FAIL.** Web: `cd apps/web && npx vitest run src/components/devices/DeviceMonitoringTab.test.tsx` → missing `CPU high` / wrong `/monitoring/results/d1/summary` request. Integration (implementation-time only):
  ```bash
  pnpm test-stack up
  trap 'pnpm test-stack down' EXIT
  (cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceMonitors.integration.test.ts)
  ```
  Expected before implementation: `Failed to load url ../../routes/devices/monitors`. These commands are instructions for the implementer, not part of writing this plan.

- [ ] **Step 3: Implement.** New `routes/devices/monitors.ts`:
  ```ts
  import { Hono } from 'hono';
  import { z } from 'zod';
  import { and, eq, inArray, isNull } from 'drizzle-orm';
  import { zValidator } from '../../lib/validation';
  import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
  import { db } from '../../db';
  import { configurationPolicies, monitorDefinitions, monitorDeviceState, monitorEpisodes } from '../../db/schema';
  import { resolveMonitorsForDevice } from '../../services/monitors/monitorResolver';
  import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
  export const monitorsRoutes = new Hono();
  monitorsRoutes.use('*', authMiddleware);
  monitorsRoutes.get('/:id/monitors', requireScope('organization', 'partner', 'system'),
    requirePermission('devices', 'read'), zValidator('param', z.object({ id: z.string().uuid() })), async (c) => {
      const { id } = c.req.valid('param');
      const device = await getDeviceWithOrgAndSiteCheck(c, id, c.get('auth'));
      if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
      if (!device) return c.json({ error: 'Device not found' }, 404);
      const resolution = await resolveMonitorsForDevice(id);
      if (resolution.kind === 'device_missing') return c.json({ error: 'Device not found' }, 404);
      if (!resolution.monitors.length) return c.json({ data: [] });
      const rows = await db.select({ definition: monitorDefinitions, state: monitorDeviceState, episode: monitorEpisodes })
        .from(monitorDefinitions)
        .leftJoin(monitorDeviceState, and(eq(monitorDeviceState.monitorId, monitorDefinitions.id),
          eq(monitorDeviceState.deviceId, id), eq(monitorDeviceState.orgId, device.orgId)))
        .leftJoin(monitorEpisodes, and(eq(monitorEpisodes.monitorId, monitorDefinitions.id),
          eq(monitorEpisodes.deviceId, id), eq(monitorEpisodes.orgId, device.orgId), isNull(monitorEpisodes.endedAt)))
        .where(inArray(monitorDefinitions.id, resolution.monitors.map((m) => m.monitorId)));
      const policies = await db.select({ id: configurationPolicies.id, name: configurationPolicies.name })
        .from(configurationPolicies).where(inArray(configurationPolicies.id,
          [...new Set(resolution.monitors.map((m) => m.sourcePolicyId))]));
      const byId = new Map(rows.map((row) => [row.definition.id, row]));
      const names = new Map(policies.map((policy) => [policy.id, policy.name]));
      return c.json({ data: resolution.monitors.flatMap((match) => {
        const row = byId.get(match.monitorId);
        if (!row) return [];
        return [{ ...match, name: row.definition.name, kind: row.definition.kind,
          enabled: match.enabled && row.definition.enabled,
          sourcePolicyName: names.get(match.sourcePolicyId) ?? null,
          lastState: row.state?.lastState ?? 'unknown',
          lastEvaluatedAt: row.state?.lastEvaluatedAt ?? null,
          openEpisode: row.episode ? { id: row.episode.id, startedAt: row.episode.startedAt, alertId: row.episode.alertId } : null,
          escalatedAt: row.state?.escalatedAt ?? null,
          escalationAlertId: row.state?.escalationAlertId ?? null,
          responsesPaused: row.state?.responsesPaused ?? false }];
      }) });
    });
  ```
  In `routes/devices/index.ts`, import `{ monitorsRoutes } from './monitors'` and mount `deviceRoutes.route('/', monitorsRoutes)` beside `alertsRoutes`, using that file's existing router variable (`deviceRoutes`). No system-context escalation; auth middleware supplies the request context.

  Replace `DeviceMonitoringTab.tsx`:
  ```tsx
  import { useCallback, useEffect, useRef, useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth } from '../../stores/auth';
  import { ActionError, runAction } from '@/lib/runAction';
  import { formatDateTime } from '@/lib/dateTimeFormat';
  import { showToast } from '../shared/Toast';
  import '../../lib/i18n';
  export interface DeviceEffectiveMonitorRow {
    monitorId: string; name: string; kind: string; enabled: boolean;
    sourcePolicyId: string; sourcePolicyName: string | null;
    lastState: 'ok' | 'breach' | 'unknown'; lastEvaluatedAt: string | null;
    openEpisode: { id: string; startedAt: string; alertId: string | null } | null;
    escalatedAt: string | null; escalationAlertId: string | null; responsesPaused: boolean;
  }
  export default function DeviceMonitoringTab({ deviceId, timezone }: { deviceId: string; timezone?: string }) {
    const { t } = useTranslation(['monitoring', 'common']);
    const [rows, setRows] = useState<DeviceEffectiveMonitorRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [resetting, setResetting] = useState<string | null>(null);
    const generation = useRef(0);
    const load = useCallback(async () => {
      const request = ++generation.current;
      setLoading(true); setError(false);
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}/monitors`);
        if (!response.ok) throw new Error('read_failed');
        const body = await response.json();
        if (request === generation.current) setRows(body.data);
      } catch {
        if (request === generation.current) setError(true);
      } finally {
        if (request === generation.current) setLoading(false);
      }
    }, [deviceId]);
    useEffect(() => { setRows([]); void load(); return () => { generation.current++; }; }, [load]);
    const reset = async (row: DeviceEffectiveMonitorRow) => {
      if (!window.confirm(t('monitoring:activity.reset.confirm', { device: row.name }))) return;
      setResetting(row.monitorId);
      try {
        await runAction({
          request: () => fetchWithAuth(`/monitor-definitions/${row.monitorId}/devices/${deviceId}/reset`, { method: 'POST' }),
          successMessage: t('monitoring:activity.reset.success'), errorFallback: t('monitoring:activity.reset.error'),
        });
        await load();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:activity.reset.error') });
      } finally { setResetting(null); }
    };
    return <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">{t('monitoring:device.title')}</h2>
        <button type="button" onClick={() => void load()} disabled={loading}>{t('common:actions.refresh')}</button>
      </div>
      {loading ? <p>{t('common:states.loading')}</p> : error ? (
        <p role="alert" data-testid="device-monitoring-error">{t('monitoring:device.error')}</p>
      ) : rows.length === 0 ? <p data-testid="device-monitoring-empty">{t('monitoring:device.empty')}</p> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr>{['monitor', 'kind', 'policy', 'state', 'episode', 'escalation'].map((key) =>
            <th key={key} className="p-3">{t(`monitoring:device.${key}`)}</th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr key={row.monitorId} data-testid="device-monitoring-row" className="border-t">
            <td className="p-3"><a href={`/alerts/monitors/${row.monitorId}`}>{row.name}</a>
              {!row.enabled && <span className="ml-2">{t('common:states.disabled')}</span>}</td>
            <td className="p-3">{t(`monitoring:kinds.${row.kind}`)}</td>
            <td className="p-3"><a href={`/configuration-policies/${row.sourcePolicyId}#monitors`}>{row.sourcePolicyName ?? row.sourcePolicyId}</a></td>
            <td className="p-3">{t(`monitoring:activity.state.${row.lastState}`)}</td>
            <td className="p-3">{row.openEpisode ? (
              <a data-testid={`device-monitor-episode-${row.monitorId}`}
                href={row.openEpisode.alertId ? `/alerts/${row.openEpisode.alertId}` : `/alerts/monitors/${row.monitorId}#activity`}>
                {formatDateTime(row.openEpisode.startedAt, { timeZone: timezone })}
              </a>) : '—'}</td>
            <td className="p-3">
              {row.escalatedAt ? formatDateTime(row.escalatedAt, { timeZone: timezone }) : '—'}
              <span className="block">{t(`monitoring:activity.responses.${row.responsesPaused ? 'paused' : 'active'}`)}</span>
              {(row.escalatedAt || row.responsesPaused) && <button type="button"
                data-testid={`device-monitor-reset-${row.monitorId}`} disabled={resetting !== null}
                onClick={() => void reset(row)}>{t('monitoring:activity.reset.button')}</button>}
            </td>
          </tr>)}</tbody>
        </table></div>
      )}
    </section>;
  }
  ```
  Add `src/components/devices/DeviceMonitoringTab.tsx` to TARGET_GLOBS. Add this complete `device` block's values to every locale's `monitoring.json`:

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | title | Effective monitors | Wirksame Monitore | Monitores efectivos | Moniteurs effectifs | Monitor effettivi | Monitores efetivos | Etkin monitörler |
  | empty | No monitors apply to this device. | Für dieses Gerät gelten keine Monitore. | No hay monitores aplicados a este dispositivo. | Aucun moniteur ne s'applique à cet appareil. | Nessun monitor si applica a questo dispositivo. | Nenhum monitor se aplica a este dispositivo. | Bu cihaza uygulanan monitör yok. |
  | error | Could not load effective monitors. | Wirksame Monitore konnten nicht geladen werden. | No se pudieron cargar los monitores efectivos. | Impossible de charger les moniteurs effectifs. | Impossibile caricare i monitor effettivi. | Não foi possível carregar os monitores efetivos. | Etkin monitörler yüklenemedi. |
  | monitor | Monitor | Monitor | Monitor | Moniteur | Monitor | Monitor | Monitör |
  | kind | Kind | Art | Tipo | Type | Tipo | Tipo | Tür |
  | policy | Source policy | Quellrichtlinie | Política de origen | Politique source | Policy di origine | Política de origem | Kaynak ilke |
  | state | State | Zustand | Estado | État | Stato | Estado | Durum |
  | episode | Open episode | Offene Episode | Episodio abierto | Épisode ouvert | Episodio aperto | Episódio aberto | Açık olay |
  | escalation | Escalation | Eskalation | Escalamiento | Escalade | Escalation | Escalonamento | Yükseltme |

- [ ] **Step 4: Run, expect PASS.** From root, web and API typechecks followed by the live proof:
  ```bash
  (cd apps/web && npx tsc --noEmit -p . && npx vitest run src/components/devices/DeviceMonitoringTab.test.tsx src/components/monitoring/MonitorActivityTab.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts)
  (cd apps/api && npx tsc --noEmit -p .)
  pnpm test-stack up
  trap 'pnpm test-stack down' EXIT
  (cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deviceMonitors.integration.test.ts src/__tests__/integration/monitoringKnownServicesSiteScope.integration.test.ts)
  ```
- [ ] **Step 5: Commit.** `git add apps/api/src/routes/devices/monitors.ts apps/api/src/routes/devices/index.ts apps/api/src/__tests__/integration/deviceMonitors.integration.test.ts apps/web/src/components/devices/DeviceMonitoringTab.tsx apps/web/src/components/devices/DeviceMonitoringTab.test.tsx apps/web/src/locales/*/monitoring.json apps/web/src/lib/__tests__/no-silent-mutations.test.ts && git commit -m "feat(devices): show effective monitors and reset escalation from Monitoring"`

---

### Task 11: Remove Alert Templates editors and redirect both settings routes (PR2)

**Files:**
- Replace with redirect-only pages: `apps/web/src/pages/settings/alert-templates/index.astro:1–8`, `[id].astro:1–10`.
- Delete: `apps/web/src/components/alerts/AlertTemplateList.tsx:1–274`, `AlertTemplateEditor.tsx:1–1549`, `AlertTemplateList.test.tsx:1–95`, `AlertTemplateEditor.create.test.tsx:1–128`, `AlertTemplateEditor.managed.test.tsx:1–85`.
- Modify: `apps/web/src/lib/routeScope.ts:55`, `routeScope.test.ts:40–44,63`; `apps/web/src/lib/__tests__/settingsPageRegistry.test.ts:27–31`; `apps/web/src/lib/runActionAllowlist.ts:30–31` (delete stale backlog entries, not add exceptions).
- Modify: `apps/web/src/locales/*/alerts.json` (`alertTemplateEditor`, `alertTemplateList` blocks, English 433–525), `apps/web/src/locales/*/pages.json:133–134`.
- Modify: `apps/web/src/components/layout/Sidebar.nav.test.tsx:1–371` (negative navigation contract); create `apps/web/src/lib/__tests__/alertTemplatesRetired.test.ts`.

**Interfaces:**
- Consumes: W05b's redirect-only Astro pattern; `/alerts/monitors` is the destination for list, `new`, and detail URLs. Existing API `/alert-templates/*` classification and reads stay for compatibility until W05d.
- Produces: HTTP 301 from both settings routes, no editor imports, no template navigation or translation keys. Remove only the `/settings/alert-templates` scope exception; the generic `/settings/*` classification covers these redirect stubs. API tables, compliance bridge templates and historical alert joins are untouched.

- [ ] **Step 1: Write the failing test.** `alertTemplatesRetired.test.ts`:
  ```ts
  import { existsSync, readFileSync, readdirSync } from 'node:fs';
  import { resolve } from 'node:path';
  import { describe, expect, it } from 'vitest';
  const root = resolve(import.meta.dirname, '../..');
  describe('Alert Templates retirement', () => {
    it.each(['index', '[id]'])('%s redirects without hydrating an editor', (page) => {
      const source = readFileSync(resolve(root, `pages/settings/alert-templates/${page}.astro`), 'utf8');
      expect(source).toContain("return Astro.redirect('/alerts/monitors', 301)");
      expect(source).not.toMatch(/AlertTemplate|DashboardLayout|client:load/);
    });
    it('removes both executable editor components', () => {
      for (const component of ['AlertTemplateList', 'AlertTemplateEditor'])
        expect(existsSync(resolve(root, `components/alerts/${component}.tsx`))).toBe(false);
    });
    it('removes owned keys in every locale without deleting common alert vocabulary', () => {
      for (const locale of readdirSync(resolve(root, 'locales'), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
        const read = (file: string) => JSON.parse(readFileSync(resolve(root, 'locales', locale.name, file), 'utf8'));
        expect(read('alerts.json')).not.toHaveProperty('alertTemplateEditor');
        expect(read('alerts.json')).not.toHaveProperty('alertTemplateList');
        expect(read('pages.json').titles).not.toHaveProperty('settingsAlertTemplates');
        expect(read('pages.json').titles).not.toHaveProperty('settingsAlertTemplatesDetail');
      }
    });
  });
  ```
  Append to `Sidebar.nav.test.tsx`, using its existing `navSections` import:
  ```ts
  it('does not advertise the retired Alert Templates authoring surface', () => {
    expect(JSON.stringify(navSections)).not.toContain('/settings/alert-templates');
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/lib/__tests__/alertTemplatesRetired.test.ts` → `expected ... to contain "return Astro.redirect('/alerts/monitors', 301)"` and `expected true to be false` for component existence.
- [ ] **Step 3: Implement.** Entire contents of each `.astro` page:
  ```astro
  ---
  return Astro.redirect('/alerts/monitors', 301);
  ---
  ```
  Remove exactly the five component/test files listed above. Delete the settings-specific scope row and the two settings registry allowlist entries. Replace the settings route-scope test with:
  ```ts
  it('classifies retired settings stubs through the general settings scope', () => {
    for (const path of ['/settings/alert-templates', '/settings/alert-templates/new', '/settings/alert-templates/abc-123']) {
      expect(getRouteScope(path)).toBe(getRouteScope('/settings/unused-redirect'));
    }
    expect(ROUTE_SCOPES.some((entry) => entry.pattern.source.includes('settings\\/alert-templates'))).toBe(false);
  });
  ```
  Delete the separate `getRouteScope('/settings/alert-templates') === 'catalog'` assertion. Keep the top-level API `/alert-templates` catalog rule and its reachability exception. Remove the two deleted components from `RUN_ACTION_MIGRATION_BACKLOG`. Locale cleanup, run from root:
  ```python
  from pathlib import Path
  import json
  for directory in Path('apps/web/src/locales').iterdir():
      if not directory.is_dir():
          continue
      alerts = directory / 'alerts.json'
      data = json.loads(alerts.read_text())
      data.pop('alertTemplateEditor', None)
      data.pop('alertTemplateList', None)
      alerts.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
      pages = directory / 'pages.json'
      data = json.loads(pages.read_text())
      data['titles'].pop('settingsAlertTemplates', None)
      data['titles'].pop('settingsAlertTemplatesDetail', None)
      pages.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
  ```
- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx tsc --noEmit -p . && npx vitest run src/lib/__tests__/alertTemplatesRetired.test.ts src/lib/__tests__/settingsPageRegistry.test.ts src/lib/routeScope.test.ts src/components/layout/Sidebar.nav.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts`.
- [ ] **Step 5: Commit.** `git add apps/web/src/pages/settings/alert-templates 'apps/web/src/components/alerts/AlertTemplate*' apps/web/src/components/layout/Sidebar.nav.test.tsx apps/web/src/lib/routeScope* apps/web/src/lib/runActionAllowlist.ts apps/web/src/lib/__tests__/settingsPageRegistry.test.ts apps/web/src/lib/__tests__/alertTemplatesRetired.test.ts apps/web/src/locales/*/alerts.json apps/web/src/locales/*/pages.json && git commit -m "refactor(alerts): remove Alert Templates editors and redirect to Monitors"`

---

### Task 12: Composite children and service-restart response controls (PR2)

**Files:**
- Create: `apps/web/src/components/monitoring/MonitorAuthoringFields.tsx`, `MonitorAuthoringFields.test.tsx`.
- Modify: `apps/web/src/components/monitoring/MonitorConditionFields.tsx:32–48,77–223` (route composite to child editor, nested input ids/errors); `monitorKindFields.ts:50–100,277–293,302–345`, `monitorKindFields.test.ts:1–87`.
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx:96–113,691–701,766–774`, `MonitorEditor.test.tsx` (existing submit harness); `apps/web/src/locales/*/monitoring.json` (all eight locales).

**Interfaces:**
- Consumes W05c1 shared `monitorConditionSchemas`, `monitorResponsesSchema`, `composite` `{ match: 'all' | 'any'; children: [{ kind, condition }] }`, 2–10 server-evaluated children, no nesting. Existing renderer accepts any react-hook-form path via its `name` prop.
- Produces `CompositeConditionFields({ name })`, `RestartResponseFields()` under the monitor form provider. An execute-command response can explicitly become an agent-local restart (`kind: 'restart_service', command: ''`); maxAttempts 0–50/default 3 and cooldownSeconds 30–86400/default 300 round-trip. Service/process/network-check failure fields accept 1–100. Existing unknown condition properties (including future W05e packetSize/headers) remain in form state on unrelated edits.

- [ ] **Step 1: Write the failing tests.** `MonitorAuthoringFields.test.tsx`:
  ```tsx
  import '@/lib/i18n';
  import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
  import { useForm, FormProvider } from 'react-hook-form';
  import { expect, it, vi } from 'vitest';
  import { monitorConditionSchemas, monitorResponsesSchema } from '@breeze/shared';
  import { CompositeConditionFields, RestartResponseFields } from './MonitorAuthoringFields';
  const child = { kind: 'cpu', condition: { operator: 'gt', value: 80 } };
  function Harness({ submit }: { submit: (v: unknown) => void }) {
    const methods = useForm({ defaultValues: { condition: { match: 'all', children: [child, child] },
      responses: [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 0, cooldownSeconds: 86400 }] } });
    return <FormProvider {...methods}><form onSubmit={methods.handleSubmit(submit)}>
      <CompositeConditionFields name="condition" /><RestartResponseFields /><button>Save</button>
    </form></FormProvider>;
  }
  it('edits child fields and restart bounds without losing zero attempts', async () => {
    const submit = vi.fn(); render(<Harness submit={submit} />);
    expect(screen.getByTestId('restart-0-maxAttempts')).toHaveValue(0);
    const first = screen.getByTestId('composite-child-0');
    fireEvent.change(within(first).getByTestId('condition-field-value'), { target: { value: '91' } });
    fireEvent.change(screen.getByTestId('composite-match'), { target: { value: 'any' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(submit).toHaveBeenCalled());
    const value = submit.mock.calls[0]![0];
    expect(value.condition.children[0].condition.value).toBe(91);
    expect(value.condition.match).toBe('any');
    expect(monitorConditionSchemas.composite.safeParse(value.condition).success).toBe(true);
    expect(value.responses[0]).toMatchObject({ maxAttempts: 0, cooldownSeconds: 86400 });
    expect(monitorResponsesSchema.safeParse(value.responses).success).toBe(true);
  });
  it('enforces child count and excludes kinds that cannot supply child evidence', () => {
    render(<Harness submit={vi.fn()} />);
    expect(screen.getByTestId('composite-remove-0')).toBeDisabled();
    for (let n = 2; n < 10; n++) fireEvent.click(screen.getByTestId('composite-add'));
    expect(screen.getByTestId('composite-add')).toBeDisabled();
    const options = within(screen.getByTestId('composite-kind-0')).getAllByRole('option').map((o) => o.getAttribute('value'));
    for (const kind of ['composite', 'service', 'process', 'process_resource', 'script', 'network_check']) expect(options).not.toContain(kind);
  });
  ```
  Append this real metadata regression to `monitorKindFields.test.ts` (existing imports supply the field map):
  ```ts
  it.each(['service', 'process', 'network_check'] as const)('%s allows 100 consecutive failures', (kind) => {
    expect(MONITOR_KIND_FIELDS[kind].find((field) => field.key === 'consecutiveFailures')).toMatchObject({ min: 1, max: 100 });
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/MonitorAuthoringFields.test.tsx src/components/monitoring/monitorKindFields.test.ts` → missing module and max 20 differs from 100.
- [ ] **Step 3: Implement.** `MonitorAuthoringFields.tsx`:
  ```tsx
  import { useFieldArray, useFormContext } from 'react-hook-form';
  import { useTranslation } from 'react-i18next';
  import type { MonitorKind } from '@breeze/shared';
  import MonitorConditionFields from './MonitorConditionFields';
  import { defaultConditionFor } from './monitorKindFields';
  export const COMPOSITE_CHILD_KINDS = ['cpu', 'memory', 'disk', 'offline', 'event_log', 'patch_compliance',
    'cert_expiry', 'bandwidth', 'disk_io', 'network_errors', 'antivirus', 'software_presence', 'backup_continuity'] as const;
  export function CompositeConditionFields({ name }: { name: string }) {
    const { t } = useTranslation(['monitoring', 'common']);
    const { control, register, watch, setValue } = useFormContext();
    const { fields, append, remove } = useFieldArray({ control, name: `${name}.children` });
    return <fieldset className="space-y-3 rounded border p-3">
      <legend>{t('monitoring:editor.composite.children')}</legend>
      <select data-testid="composite-match" {...register(`${name}.match`)}>
        <option value="all">{t('monitoring:editor.composite.all')}</option>
        <option value="any">{t('monitoring:editor.composite.any')}</option>
      </select>
      {fields.map((field, index) => {
        const prefix = `${name}.children.${index}`;
        const kind = watch(`${prefix}.kind`) as MonitorKind;
        return <div key={field.id} data-testid={`composite-child-${index}`} className="space-y-2 rounded border p-3">
          <select aria-label={t('monitoring:device.kind')} data-testid={`composite-kind-${index}`} value={kind}
            onChange={(event) => {
              const next = event.target.value as typeof COMPOSITE_CHILD_KINDS[number];
              setValue(`${prefix}.kind`, next, { shouldDirty: true });
              setValue(`${prefix}.condition`, defaultConditionFor(next), { shouldDirty: true });
            }}>
            {COMPOSITE_CHILD_KINDS.map((value) => <option key={value} value={value}>{t(`monitoring:kinds.${value}`)}</option>)}
          </select>
          <MonitorConditionFields kind={kind} name={`${prefix}.condition`} />
          <button type="button" data-testid={`composite-remove-${index}`} disabled={fields.length <= 2}
            onClick={() => remove(index)}>{t('common:actions.remove')}</button>
        </div>;
      })}
      <button type="button" data-testid="composite-add" disabled={fields.length >= 10}
        onClick={() => append({ kind: 'cpu', condition: defaultConditionFor('cpu') })}>{t('monitoring:editor.composite.add')}</button>
    </fieldset>;
  }
  export function RestartResponseFields() {
    const { t } = useTranslation('monitoring');
    const { watch, setValue, register } = useFormContext();
    const responses: Array<Record<string, unknown>> = watch('responses') ?? [];
    return <div className="space-y-3">{responses.map((response, index) => response.type !== 'execute_command' ? null : (
      <fieldset key={index} className="rounded border p-3">
        <label><input type="checkbox" checked={response.kind === 'restart_service'} onChange={(event) => {
          const next = { ...response };
          if (event.target.checked) Object.assign(next, { kind: 'restart_service', command: '', maxAttempts: 3, cooldownSeconds: 300 });
          else { delete next.kind; delete next.maxAttempts; delete next.cooldownSeconds; }
          setValue(`responses.${index}`, next, { shouldDirty: true });
        }} />{t('editor.restart.label')}</label>
        {response.kind === 'restart_service' && ([['maxAttempts', 0, 50, 3], ['cooldownSeconds', 30, 86400, 300]] as const).map(([key, min, max, fallback]) => (
          <label key={key} className="block">{t(`editor.restart.${key}`)}
            <input type="number" data-testid={`restart-${index}-${key}`} min={min} max={max} step={1}
              defaultValue={Number(response[key] ?? fallback)} {...register(`responses.${index}.${key}`, { valueAsNumber: true, min, max })} />
          </label>
        ))}
      </fieldset>
    ))}</div>;
  }
  ```
  Route composite before scalar hooks and retain existing scalar implementation under a private name:
  ```tsx
  import { CompositeConditionFields } from './MonitorAuthoringFields';
  export default function MonitorConditionFields(props: MonitorConditionFieldsProps) {
    return props.kind === 'composite' ? <CompositeConditionFields name={props.name} /> : <ScalarConditionFields {...props} />;
  }
  // Rename the existing default function to this signature; keep its existing body.
  function ScalarConditionFields({ kind, name }: MonitorConditionFieldsProps) {
  ```
  In that body, obtain nested errors with `name.split('.').reduce<any>((node, part) => node?.[part], errors) ?? {}`. Set `const fieldId = (key: string) => `${name.replaceAll('.', '-')}-${key}`;` and replace each input `id`/label `htmlFor` expression with `fieldId(field.key)`; keep existing `data-testid` values, scoped by each child wrapper in tests.

  In `monitorKindFields.ts`, retain C1's `composite: []` map/default, or add the exact defaults if absent:
  ```ts
  // MONITOR_KIND_FIELDS entry
  composite: [],
  // defaultConditionFor switch
  case 'composite': return { match: 'all', children: [
    { kind: 'cpu', condition: defaultConditionFor('cpu') },
    { kind: 'memory', condition: defaultConditionFor('memory') },
  ] };
  ```
  Replace all three `max: 20` consecutive-failure fields with `max: 100`. In `MonitorEditor`, import `RestartResponseFields`, render `<RestartResponseFields />` immediately after the responses `ActionsEditor`; remove C1's temporary composite exclusion so the picker is `MONITOR_KINDS.map(...)`. The existing form save remains through `runAction`. Add `monitorConditionSchemas` and `monitorResponsesSchema` imports, and refine the existing local form schema without changing recurrence's form-only units:
  ```ts
  .superRefine((value, ctx) => {
    const condition = monitorConditionSchemas[value.kind].safeParse(value.condition);
    if (!condition.success) ctx.addIssue({ code: 'custom', path: ['condition'], message: 'Invalid condition' });
    const responses = monitorResponsesSchema.safeParse(value.responses);
    if (!responses.success) ctx.addIssue({ code: 'custom', path: ['responses'], message: 'Invalid responses' });
  })
  ```
  After `<MonitorConditionFields ... />` render:
  ```tsx
  {errors.condition && <p role="alert">{t('monitoring:editor.errors.save')}</p>}
  ```
  After `<RestartResponseFields />` render:
  ```tsx
  {errors.responses && <p role="alert">{t('monitoring:editor.errors.save')}</p>}
  ``` Preserve the entire loaded condition and response records on unrelated changes; do not reconstruct them from the visible field map. Translations under `editor` in all eight `monitoring.json` files:

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | composite.children | Child conditions | Teilbedingungen | Condiciones secundarias | Conditions enfants | Condizioni figlie | Condições filhas | Alt koşullar |
  | composite.all | All conditions | Alle Bedingungen | Todas las condiciones | Toutes les conditions | Tutte le condizioni | Todas as condições | Tüm koşullar |
  | composite.any | Any condition | Beliebige Bedingung | Cualquier condición | Toute condition | Qualsiasi condizione | Qualquer condição | Herhangi bir koşul |
  | composite.add | Add condition | Bedingung hinzufügen | Agregar condición | Ajouter une condition | Aggiungi condizione | Adicionar condição | Koşul ekle |
  | restart.label | Restart service on the device | Dienst auf dem Gerät neu starten | Reiniciar servicio en el dispositivo | Redémarrer le service sur l'appareil | Riavvia servizio sul dispositivo | Reiniciar serviço no dispositivo | Cihazdaki hizmeti yeniden başlat |
  | restart.maxAttempts | Maximum restart attempts | Maximale Neustartversuche | Máximo de intentos de reinicio | Nombre maximal de redémarrages | Tentativi massimi di riavvio | Máximo de tentativas de reinício | En fazla yeniden başlatma denemesi |
  | restart.cooldownSeconds | Restart cooldown (seconds) | Neustartwartezeit (Sekunden) | Espera entre reinicios (segundos) | Délai entre redémarrages (secondes) | Attesa tra riavvii (secondi) | Espera entre reinícios (segundos) | Yeniden başlatma bekleme süresi (saniye) |

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/monitoring/MonitorAuthoringFields.test.tsx src/components/monitoring/MonitorEditor.test.tsx src/components/monitoring/monitorKindFields.test.ts src/lib/i18n && npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring/MonitorAuthoringFields* apps/web/src/components/monitoring/MonitorConditionFields.tsx apps/web/src/components/monitoring/monitorKindFields* apps/web/src/components/monitoring/MonitorEditor* apps/web/src/locales/*/monitoring.json && git commit -m "feat(monitors): edit composite conditions and service restart limits"`

---

### Task 13: Library Recommended strip and policy attachment picker (PR2)

**Files:**
- Create: `apps/web/src/components/monitoring/RecommendedMonitors.tsx`, `RecommendedMonitors.test.tsx`.
- Modify: `apps/web/src/components/monitoring/MonitorsListPage.tsx:20–29,40–59,136–154`, `MonitorsListPage.test.tsx` (real list-response mapping); `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35–59`.
- Modify: `apps/web/src/locales/*/monitoring.json` (all eight locales).
- Read: `apps/api/src/routes/monitorDefinitions.ts:94–117` (attachment counts); `apps/web/src/components/monitoring/DeployMonitorDialog.tsx:50–58,82–117` (policy picker/attachment request); `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts:39–81` (feature-link writes).

**Interfaces:**
- Consumes library rows `{ id, builtinKey?, partnerId, orgId, attachmentCount? }`. Show recommendations only after a successful catalog load, for partner-owned built-ins with a known zero attachment count; never treat absent counts as zero. Use actual shipped built-ins, not invented CPU/disk/offline identities. Attached built-ins are omitted.
- Produces `RecommendedMonitors({ rows, onAttached })`, loading/error/Retry policy picker, one feature-link save attaching selected recommendations together while preserving existing items and `inheritance` (including empty replacement). Existing API enforces owner/site/write authorization; errors surface through `runAction`. A library strip is independent of W05a's policy-tab strip.

- [ ] **Step 1: Write the failing tests.** `RecommendedMonitors.test.tsx`:
  ```tsx
  import '@/lib/i18n';
  import { fireEvent, render, screen, waitFor } from '@testing-library/react';
  import { beforeEach, expect, it, vi } from 'vitest';
  vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
  vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
  import { fetchWithAuth } from '../../stores/auth';
  import RecommendedMonitors from './RecommendedMonitors';
  const fetchMock = vi.mocked(fetchWithAuth);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const monitor = { id: '33333333-3333-4333-8333-333333333333', builtinKey: 'shipped-key',
    orgId: null, partnerId: '22222222-2222-4222-8222-222222222222', attachmentCount: 0 };
  const policyId = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => vi.resetAllMocks());
  it('attaches built-ins to a chosen policy without discarding replacement mode', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ id: policyId, name: 'Servers' }], pagination: { total: 1 } }))
      .mockResolvedValueOnce(json({ data: [{ id: 'link', featureType: 'monitors', inlineSettings: { items: [], inheritance: 'replace' } }] }))
      .mockResolvedValueOnce(json({ data: { id: 'link' } }));
    const onAttached = vi.fn(); render(<RecommendedMonitors rows={[monitor]} onAttached={onAttached} />);
    fireEvent.click(screen.getByTestId('recommended-open'));
    await screen.findByText('Servers');
    fireEvent.change(screen.getByTestId('recommended-policy'), { target: { value: policyId } });
    fireEvent.click(screen.getByTestId('recommended-attach'));
    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(write[1]!.body)).inlineSettings).toEqual({ inheritance: 'replace',
      items: [{ monitorId: monitor.id, enabled: true, sortOrder: 0 }] });
  });
  it('hides deployed or unknown-count built-ins and never uses ordinary definitions', () => {
    const { container } = render(<RecommendedMonitors rows={[
      { ...monitor, attachmentCount: 1 }, { ...monitor, attachmentCount: undefined },
      { ...monitor, builtinKey: null },
    ]} onAttached={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('keeps attachment disabled on a failed policy read', async () => {
    fetchMock.mockResolvedValue(json({ error: 'unavailable' }, 500));
    render(<RecommendedMonitors rows={[monitor]} onAttached={vi.fn()} />);
    fireEvent.click(screen.getByTestId('recommended-open'));
    expect(await screen.findByTestId('recommended-retry')).toBeInTheDocument();
    expect(screen.getByTestId('recommended-attach')).toBeDisabled();
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/RecommendedMonitors.test.tsx` → missing `./RecommendedMonitors`.
- [ ] **Step 3: Implement.** `RecommendedMonitors.tsx`:
  ```tsx
  import { useState } from 'react';
  import { useTranslation } from 'react-i18next';
  import { fetchWithAuth } from '../../stores/auth';
  import { ActionError, runAction } from '@/lib/runAction';
  import { showToast } from '../shared/Toast';
  type Recommendation = { id: string; orgId: string | null; partnerId: string | null;
    builtinKey?: string | null; attachmentCount?: number };
  type Policy = { id: string; name: string };
  export default function RecommendedMonitors({ rows, onAttached }: { rows: Recommendation[]; onAttached: () => void }) {
    const { t } = useTranslation(['monitoring', 'common']);
    const candidates = rows.filter((row) => row.builtinKey && row.partnerId && !row.orgId && row.attachmentCount === 0);
    const [open, setOpen] = useState(false);
    const [policies, setPolicies] = useState<Policy[]>([]);
    const [policyId, setPolicyId] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);
    const loadPolicies = async () => {
      setOpen(true); setLoading(true); setError(false); setPolicies([]); setPolicyId('');
      try {
        const all: Policy[] = [];
        for (let page = 1; ; page++) {
          const response = await fetchWithAuth(`/configuration-policies?status=active&limit=100&page=${page}`);
          if (!response.ok) throw new Error('policy_read_failed');
          const body = await response.json();
          all.push(...body.data);
          if (body.data.length < 100 || all.length >= body.pagination.total) break;
        }
        setPolicies(all);
      } catch { setError(true); } finally { setLoading(false); }
    };
    const attach = async () => {
      if (!policyId || busy || !candidates.length) return;
      setBusy(true);
      try {
        const response = await fetchWithAuth(`/configuration-policies/${policyId}/features`);
        if (!response.ok) throw new Error('feature_read_failed');
        const body = await response.json();
        const link = body.data.find((value: { featureType: string }) => value.featureType === 'monitors');
        if (link?.featurePolicyId) throw new Error('linked_feature_not_editable');
        const settings = link?.inlineSettings ?? { items: [], inheritance: 'cumulative' };
        const items = [...(settings.items ?? [])];
        for (const row of candidates) if (!items.some((item) => item.monitorId === row.id))
          items.push({ monitorId: row.id, enabled: true, sortOrder: items.length });
        await runAction({
          request: () => fetchWithAuth(`/configuration-policies/${policyId}/features${link ? `/${link.id}` : ''}`, {
            method: link ? 'PATCH' : 'POST', body: JSON.stringify({ featureType: 'monitors', featurePolicyId: null,
              inlineSettings: { ...settings, items } }),
          }), errorFallback: t('monitoring:deploy.errors.attach'), successMessage: t('monitoring:deploy.attached'),
        });
        setOpen(false); onAttached();
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return;
        if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:deploy.errors.attach') });
      } finally { setBusy(false); }
    };
    if (!candidates.length) return null;
    return <section className="space-y-3 rounded border p-4" data-testid="library-recommended">
      <h2>{t('monitoring:list.recommended.title')}</h2>
      <p>{t('monitoring:list.recommended.description', { count: candidates.length })}</p>
      <button data-testid="recommended-open" onClick={() => void loadPolicies()} disabled={loading || busy}>{t('monitoring:deploy.selectPolicy')}</button>
      {open && <div>
        {loading && <p>{t('common:states.loading')}</p>}
        {error && <button data-testid="recommended-retry" onClick={() => void loadPolicies()}>{t('common:actions.retry')}</button>}
        <select aria-label={t('monitoring:deploy.selectPolicy')} data-testid="recommended-policy" value={policyId} onChange={(event) => setPolicyId(event.target.value)}>
          <option value="">{t('monitoring:deploy.selectPolicy')}</option>
          {policies.map((policy) => <option value={policy.id} key={policy.id}>{policy.name}</option>)}
        </select>
        <button data-testid="recommended-attach" disabled={!policyId || loading || error || busy} onClick={() => void attach()}>{t('monitoring:deploy.attach')}</button>
        <button disabled={busy} onClick={() => setOpen(false)}>{t('common:actions.cancel')}</button>
      </div>}
    </section>;
  }
  ```
  Import it in `MonitorsListPage` and render immediately after the header:
  ```tsx
  {!loading && !error && <RecommendedMonitors rows={rows} onAttached={() => void fetchMonitors()} />}
  ```
  The existing `setRows(data.data)` retains `builtinKey` and `attachmentCount`; do not replace it with a lossy mapping. Append to `MonitorsListPage.test.tsx` using its actual `fetchMock`, `json`, `rows` and render imports:
  ```tsx
  it('retains built-in deployment status from the actual library response', async () => {
    fetchMock.mockImplementation(async (url) => url === '/monitor-definitions'
      ? json({ data: [{ ...rows[0], builtinKey: 'shipped-key', orgId: null, partnerId: 'p1', attachmentCount: 0 }] })
      : json({ items: [], nextCursor: null, data: { rows: 0, policies: 0 } }));
    render(<MonitorsListPage />);
    expect(await screen.findByTestId('library-recommended')).toBeInTheDocument();
  });
  ```
 Add the new component to the mutation guard. Translations:

  | key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
  |---|---|---|---|---|---|---|---|
  | list.recommended.title | Recommended | Empfohlen | Recomendados | Recommandés | Consigliati | Recomendados | Önerilenler |
  | list.recommended.description | Attach the built-in monitors to a policy. | Integrierte Monitore einer Richtlinie zuordnen. | Adjunte los monitores integrados a una política. | Rattachez les moniteurs intégrés à une politique. | Associa i monitor integrati a una policy. | Anexe os monitores integrados a uma política. | Yerleşik monitörleri bir ilkeye ekleyin. |

- [ ] **Step 4: Run, expect PASS.** `cd apps/web && npx vitest run src/components/monitoring/RecommendedMonitors.test.tsx src/components/monitoring/MonitorsListPage.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit.** `git add apps/web/src/components/monitoring/RecommendedMonitors* apps/web/src/components/monitoring/MonitorsListPage* apps/web/src/locales/*/monitoring.json apps/web/src/lib/__tests__/no-silent-mutations.test.ts && git commit -m "feat(monitors): recommend undeployed built-ins in the library"`

---

### Task 14: AI tools — legacy-write warnings and resolver-backed service monitor reads (PR3)

**Files:**
- Create: `apps/api/src/services/monitors/listServiceMonitors.ts`, `listServiceMonitors.test.ts`.
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts:870–1084`, `aiToolsConfigPolicy.test.ts:145–203,310–378`.
- Modify: `apps/api/src/services/aiToolsFleet.ts:3154–3230`, `aiAgentSdkTools.ts:2018–2034`, `aiAgentSdkTools.mcpCoverage.test.ts:34–55`.
- Modify: `apps/api/src/services/aiAgentSystemPrompt.ts:70–75`, `aiGuardrails.ts:2438`.
- Read: `apps/api/src/services/aiToolSchemasFleet.ts:217–220` (already list-only); `aiToolsSiteScope.ts:54–75,198–208`; `monitors/monitorResolver.ts:40–69,97`.

**Interfaces:**
- Consumes: existing `registerConfigPolicyTools`, `getConfigPolicy`, `canManagePartnerWidePolicies`, site-ceiling and MFA gates. Successful `manage_policy_feature_link` add/update gets `{ warning, useTool: 'manage_monitor_definitions' }` when the stored feature type is `alert_rule` or `monitoring`. W05d replaces this warning with refusal; no early 410 here.
- Produces: `listEffectiveServiceMonitors(auth: AuthContext, configPolicyId?: string)` returning effective per-device service/process rows; `manage_service_monitors` remains `{ action: 'list', configPolicyId?: string } → { monitors, showing }`. Policy filter means the effective winning source policy. Unassigned definitions are absent; per-device overrides stay distinct. Schema names and tool names remain unchanged, and PR3 does not import PR2's device route.

- [ ] **Step 1: Write the failing tests.** Append inside the existing config-policy tools describe:
  ```ts
  it.each(['alert_rule', 'monitoring'])('warns while preserving authorized %s writes', async (featureType) => {
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'Policy' } as any);
    vi.mocked(addFeatureLink).mockResolvedValue({ id: 'link-1' } as any);
    const registry = new Map<string, any>();
    registerConfigPolicyTools(registry);
    const body = JSON.parse(await registry.get('manage_policy_feature_link').handler({
      action: 'add', configPolicyId: POLICY_ID, featureType,
    }, makeAuth()));
    expect(body).toMatchObject({ success: true, useTool: 'manage_monitor_definitions' });
    expect(body.warning).toContain(featureType);
    expect(addFeatureLink).toHaveBeenCalled();
  });
  it('warns from the stored link type on update, not a caller-supplied replacement', async () => {
    vi.mocked(getConfigPolicy).mockResolvedValue({ id: POLICY_ID, orgId: ORG_ID, name: 'Policy' } as any);
    mockSelectRows([{ featureType: 'monitoring' }]);
    vi.mocked(updateFeatureLink).mockResolvedValue({ id: 'link-1' } as any);
    const registry = new Map<string, any>(); registerConfigPolicyTools(registry);
    const body = JSON.parse(await registry.get('manage_policy_feature_link').handler({
      action: 'update', configPolicyId: POLICY_ID, featureLinkId: 'link-1', featureType: 'patch',
    }, makeAuth()));
    expect(body.warning).toContain('monitoring');
  });
  ```
  Create `listServiceMonitors.test.ts` (also read `monitorResolver.test.ts` and `aiToolsConfigPolicy.test.ts` to retain local mocking conventions):
  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  import type { AuthContext } from '../../middleware/auth';
  const mocks = vi.hoisted(() => ({ select: vi.fn(), resolve: vi.fn(), denied: vi.fn() }));
  vi.mock('../../db', () => ({ db: { select: mocks.select } }));
  vi.mock('./monitorResolver', () => ({ resolveMonitorsForDevice: mocks.resolve }));
  vi.mock('../aiToolsSiteScope', () => ({
    siteScopeCondition: vi.fn(), deviceScopeCondition: vi.fn(), deviceSiteDenied: mocks.denied,
  }));
  import { listEffectiveServiceMonitors } from './listServiceMonitors';
  const auth = { canAccessOrg: (id: string) => id === 'o1', orgCondition: () => undefined } as unknown as AuthContext;
  const query = (rows: unknown[]) => ({ from: () => ({ where: async () => rows }) });
  beforeEach(() => { vi.resetAllMocks(); mocks.denied.mockReturnValue(null); });
  describe('effective service monitor AI listing', () => {
    it('reads device-effective overrides and retains disabled attachments', async () => {
      mocks.select.mockReturnValueOnce(query([{ id: 'd1', orgId: 'o1', siteId: 's1' }]))
        .mockReturnValueOnce(query([{ id: 'm1', name: 'Spooler', kind: 'service', enabled: true, condition: { serviceName: 'Spooler', consecutiveFailures: 2 } }]));
      mocks.resolve.mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: 'm1', enabled: false, sourcePolicyId: 'p1', overrides: { consecutiveFailures: 5 } }] });
      expect(await listEffectiveServiceMonitors(auth, 'p1')).toEqual([expect.objectContaining({
        deviceId: 'd1', monitorId: 'm1', sourcePolicyId: 'p1', enabled: false,
        condition: { serviceName: 'Spooler', consecutiveFailures: 5 },
      })]);
    });
    it('does not resolve foreign-org or forbidden-site devices', async () => {
      mocks.select.mockReturnValue(query([{ id: 'd1', orgId: 'o2', siteId: 's1' }, { id: 'd2', orgId: 'o1', siteId: 's2' }]));
      mocks.denied.mockReturnValue('denied');
      expect(await listEffectiveServiceMonitors(auth)).toEqual([]);
      expect(mocks.resolve).not.toHaveBeenCalled();
    });
    it('filters winning source policies and reports resolver failures', async () => {
      mocks.select.mockReturnValue(query([{ id: 'd1', orgId: 'o1', siteId: 's1' }]));
      mocks.resolve.mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: 'm1', sourcePolicyId: 'other' }] });
      expect(await listEffectiveServiceMonitors(auth, 'p1')).toEqual([]);
      mocks.resolve.mockRejectedValueOnce(new Error('database unavailable'));
      await expect(listEffectiveServiceMonitors(auth)).rejects.toThrow('database unavailable');
    });
  });
  ```
  Append to `aiAgentSdkTools.mcpCoverage.test.ts`:
  ```ts
  it('advertises service monitors as resolver-backed reads and points writes at definitions', () => {
    expect(declaredDescription('manage_service_monitors')).toContain('manage_monitor_definitions');
    const block = SOURCE.split("'manage_service_monitors',")[1]!.split("makeHandler('manage_service_monitors'")[0]!;
    expect(block).toContain("action: z.enum(['list'])");
    expect(block).not.toContain('watchType:');
    expect(validateToolInput('manage_service_monitors', { action: 'add' }).success).toBe(false);
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/api && npx vitest run src/services/aiToolsConfigPolicy.test.ts src/services/monitors/listServiceMonitors.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts` → missing `./listServiceMonitors`, warning is undefined, SDK advertises add/remove.
- [ ] **Step 3: Implement.** Add to `aiToolsConfigPolicy.ts`:
  ```ts
  export function legacyFeatureWarning(featureType: string | undefined) {
    return featureType === 'alert_rule' || featureType === 'monitoring' ? {
      warning: `Feature type "${featureType}" is legacy. Use manage_monitor_definitions and attach via featureType "monitors". Existing writes remain available until W05d.`,
      useTool: 'manage_monitor_definitions',
    } : {};
  }
  ```
  Successful add response becomes `JSON.stringify({ success: true, featureLink: link, ...legacyFeatureWarning(featureType) })`; successful update uses `...legacyFeatureWarning(existingFeatureType)`. Keep every earlier refusal unchanged. Import `CONFIG_FEATURE_TYPES` from `./configFeatureTypes` and replace the handwritten feature enum with `[...CONFIG_FEATURE_TYPES]`, including `monitors` while preserving legacy values until W05d.

  `listServiceMonitors.ts`:
  ```ts
  import { and, inArray } from 'drizzle-orm';
  import { db } from '../../db';
  import { devices, monitorDefinitions } from '../../db/schema';
  import type { AuthContext } from '../../middleware/auth';
  import { deviceScopeCondition, deviceSiteDenied, siteScopeCondition } from '../aiToolsSiteScope';
  import { resolveMonitorsForDevice } from './monitorResolver';
  export async function listEffectiveServiceMonitors(auth: AuthContext, configPolicyId?: string) {
    const candidates = await db.select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId })
      .from(devices).where(and(auth.orgCondition(devices.orgId), siteScopeCondition(auth, devices.siteId), deviceScopeCondition(auth, devices.id)));
    const rows: Array<{ deviceId: string; monitorId: string; name: string; kind: 'service' | 'process';
      sourcePolicyId: string; enabled: boolean; condition: Record<string, unknown> }> = [];
    for (const device of candidates) {
      if (!auth.canAccessOrg(device.orgId) || deviceSiteDenied(auth, device.siteId, device.id)) continue;
      const resolution = await resolveMonitorsForDevice(device.id);
      if (resolution.kind === 'device_missing') throw new Error('Device disappeared while resolving monitors; retry the list.');
      const effective = resolution.monitors.filter((m) => !configPolicyId || m.sourcePolicyId === configPolicyId);
      if (!effective.length) continue;
      const definitions = await db.select().from(monitorDefinitions).where(and(
        inArray(monitorDefinitions.id, effective.map((m) => m.monitorId)), inArray(monitorDefinitions.kind, ['service', 'process'])));
      for (const definition of definitions) {
        if (definition.kind !== 'service' && definition.kind !== 'process') continue;
        const match = effective.find((m) => m.monitorId === definition.id)!;
        rows.push({ deviceId: device.id, monitorId: definition.id, name: definition.name, kind: definition.kind,
          sourcePolicyId: match.sourcePolicyId, enabled: definition.enabled && match.enabled,
          condition: { ...definition.condition, ...match.overrides } });
      }
    }
    return rows;
  }
  ```
  Replace only the service-monitor list branch in `aiToolsFleet.ts` with:
  ```ts
  if (action === 'list') {
    const monitors = await listEffectiveServiceMonitors(auth,
      typeof input.configPolicyId === 'string' ? input.configPolicyId : undefined);
    return JSON.stringify({ monitors, showing: monitors.length });
  }
  return JSON.stringify({ error: `Unknown action: ${action}. Only "list" is supported. Use manage_monitor_definitions to author monitors.` });
  ```
  Import the new helper; remove this handler's now-unused `orgId`. Replace the descriptions in this registration and SDK registration with the same literal:
  ```ts
  'List effective service/process monitors per accessible device via the monitor resolver. Optional configPolicyId filters the winning source policy. Use manage_monitor_definitions to author monitors, then attach them with manage_policy_feature_link featureType "monitors".'
  ```
  SDK input shape becomes `{ action: z.enum(['list']), configPolicyId: uuid.optional() }`. Keep the canonical schema's list-only surface. Replace the system prompt's three watch-writing instructions with:
  ```text
  To monitor a service or process, create its definition with manage_monitor_definitions.
  Attach the definition to a configuration policy with manage_policy_feature_link,
  featureType "monitors", preserving the link's existing items and inheritance setting.
  manage_service_monitors is read-only and lists effective service/process monitors per device.
  ```
  Replace the `aiGuardrails.ts` redirect hint with:
  ```ts
  manage_service_monitors: 'Use manage_monitor_definitions to author service/process monitors, then manage_policy_feature_link with featureType "monitors" to attach them to a policy.',
  ```
- [ ] **Step 4: Run, expect PASS.** `cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/aiToolsConfigPolicy.test.ts src/services/monitors/listServiceMonitors.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiToolsFleet src/services/aiGuardrails src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts`.
- [ ] **Step 5: Commit.** `git add apps/api/src/services/monitors/listServiceMonitors* apps/api/src/services/aiToolsConfigPolicy* apps/api/src/services/aiToolsFleet.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiAgentSdkTools.mcpCoverage.test.ts apps/api/src/services/aiAgentSystemPrompt.ts apps/api/src/services/aiGuardrails.ts && git commit -m "feat(ai): direct alert authoring to monitors and resolve effective service monitors"`

---

### Task 15: Fleet Designer proposals use the monitor-definition condition contract (PR3)

**Files:**
- Modify: `packages/shared/src/validators/fleetDesign.ts:1–2,63–74`, `fleetDesign.test.ts:23–51`; `packages/shared/src/types/fleetDesign.ts:53–64`.
- Modify: `apps/api/src/services/aiAgents/outcomeTools.ts:564–581,599` and fixtures in `outcomeTools.test.ts`, `runLoop.design.test.ts:367–370`, `fleetDesignReport.test.ts:239–242`.
- Modify: `apps/web/src/components/fleetDesign/FleetDesignViewer.test.tsx:16–48`; read `FleetDesignViewer.tsx:156–174` (names/rationales and stable item references already render both shapes).
- Modify: `apps/api/src/services/fleetDesign/apply.ts:323–333` (`toRuleItem` adapts to the new typed proposal; persistence switches in Task 16).
- Create: `apps/api/src/services/fleetDesign/monitorProposalCompatibility.ts`, `monitorProposalCompatibility.test.ts`; modify `apps/api/src/services/fleetDesign/preview.ts:169–188`.

**Interfaces:**
- Consumes: shared `monitorKindSchema`, `monitorConditionSchemas`, `monitorResponsesSchema`, `monitorDeliveryModeSchema`; W05c1 `composite` validation and restart action parameters.
- Produces: `fleetDesignRuleFields`, `fleetDesignRuleSchema`; `FleetDesignRule` has `kind`, `condition`, `responses`, `deliveryMode`, `deliveryChannelIds` instead of `conditions`/`sourceTemplateId`. Keep `monitoring[].alertRules` and `watches` collection names, `itemRef`, `action`, `paging` and report schema version stable for historic readers. `action`/`paging` are retained recommendation metadata; only explicit `responses` and `deliveryMode` fields are executable. No implicit script execution or business-hours paging is invented.
- Historical reports remain readable. A selected legacy rule proposal cannot be applied by the new writer: `legacySelectedMonitorRefs` identifies incompatible selections; preview throws `FleetDesignApplyError('blocked', { reason: 'legacy_monitor_proposal', itemRefs, message })` before any write and asks for a refreshed report. This is explicit, item-specific, and prevents silently rewriting previously approved conditions. Existing applied ledger rows remain available to rollback and drift.

- [ ] **Step 1: Write the failing tests.** Add imports and tests in shared `fleetDesign.test.ts`:
  ```ts
  import { fleetDesignRuleSchema } from './fleetDesign';
  const monitorProposal = {
    name: 'Disk capacity', kind: 'disk',
    condition: { operator: 'gt', value: 85, durationMinutes: 15 }, severity: 'high',
    cooldownMinutes: 60, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [],
    rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
  };
  it('accepts a validated monitor-definition proposal', () => {
    expect(fleetDesignRuleSchema.parse(monitorProposal)).toMatchObject(monitorProposal);
  });
  it('rejects legacy fields, invalid kind conditions and empty explicit delivery', () => {
    expect(fleetDesignRuleSchema.safeParse({ ...monitorProposal, conditions: [] }).success).toBe(false);
    expect(fleetDesignRuleSchema.safeParse({ ...monitorProposal, kind: 'service' }).success).toBe(false);
    expect(fleetDesignRuleSchema.safeParse({ ...monitorProposal, deliveryMode: 'channels' }).success).toBe(false);
  });
  ```
  New `monitorProposalCompatibility.test.ts`:
  ```ts
  import { describe, expect, it } from 'vitest';
  import { legacySelectedMonitorRefs } from './monitorProposalCompatibility';
  describe('historical Fleet Design approvals', () => {
    const section = [{ functionKey: 'file_server', alertRules: [
      { name: 'Old CPU', conditions: [{ type: 'metric' }] },
      { name: 'New CPU', kind: 'cpu', condition: { operator: 'gt', value: 80 } },
    ] }];
    it('blocks only selected legacy proposals and preserves stable identities', () => {
      expect(legacySelectedMonitorRefs(section, ['monitoring:file_server:rule:0']))
        .toEqual(['monitoring:file_server:rule:0']);
      expect(legacySelectedMonitorRefs(section, ['monitoring:file_server:rule:1'])).toEqual([]);
      expect(legacySelectedMonitorRefs(section, [])).toEqual([]);
    });
  });
  ```
  Add to `FleetDesignViewer.test.tsx`:
  ```tsx
  it('keeps the approval identity of a monitor-shaped rule proposal', () => {
    const outcome = structuredClone(OUTCOME);
    outcome.sections.monitoring[0]!.alertRules = [{
      name: 'CPU monitor', kind: 'cpu', condition: { operator: 'gt', value: 80 },
      severity: 'high', cooldownMinutes: 5, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [],
      rationale: 'Protect interactive sessions', action: 'none', paging: 'none',
      itemRef: 'monitoring:shared_workstation:rule:0',
    }];
    render(<Harness outcome={outcome} />);
    expect(screen.getByText('CPU monitor')).toBeInTheDocument();
    expect(screen.getByText('Protect interactive sessions')).toBeInTheDocument();
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `(cd packages/shared && npx vitest run src/validators/fleetDesign.test.ts)` → `fleetDesignRuleSchema` missing export; `(cd apps/api && npx vitest run src/services/fleetDesign/monitorProposalCompatibility.test.ts)` → missing module. Shared typecheck also rejects `kind` on `FleetDesignRule` before the edit.
- [ ] **Step 3: Implement.** Replace the shared rule declaration, exporting the unrefined field map for the model-facing JSON schema:
  ```ts
  import { monitorKindSchema, monitorConditionSchemas, monitorResponsesSchema, monitorDeliveryModeSchema } from './monitors';
  export const fleetDesignRuleFields = {
    name: z.string().trim().min(1).max(200),
    kind: monitorKindSchema,
    condition: z.record(z.string(), z.unknown()),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    cooldownMinutes: z.number().int().min(0).max(1440),
    responses: monitorResponsesSchema.default([]),
    deliveryMode: monitorDeliveryModeSchema.default('inherit'),
    deliveryChannelIds: z.array(uuid).max(20).default([]),
    rationale: fleetDesignText(),
    action: z.union([z.literal('none'), z.object({ kind: z.enum(['playbook', 'script']), ref: z.string().min(1).max(200) }).strict()]),
    paging: z.enum(['none', 'business_hours', 'always']),
  };
  export const fleetDesignRuleSchema = z.object(fleetDesignRuleFields).strict().superRefine((value, ctx) => {
    const parsed = monitorConditionSchemas[value.kind].safeParse(value.condition);
    if (!parsed.success) ctx.addIssue({ code: 'custom', path: ['condition'], message: 'condition does not match kind' });
    if (value.deliveryMode === 'channels' && !value.deliveryChannelIds.length)
      ctx.addIssue({ code: 'custom', path: ['deliveryChannelIds'], message: 'deliveryChannelIds required when deliveryMode is channels' });
  });
  const rule = fleetDesignRuleSchema;
  ```
  Remove the now-unused `alertRuleConditionSchema` import. In `types/fleetDesign.ts`, use type-only imports from `../validators/monitors` and replace the interface:
  ```ts
  import type { CreateMonitorDefinitionInput, MonitorKind } from '../validators/monitors';
  export interface FleetDesignRule {
    name: string; kind: MonitorKind; condition: Record<string, unknown>;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info'; cooldownMinutes: number;
    responses: CreateMonitorDefinitionInput['responses'];
    deliveryMode: CreateMonitorDefinitionInput['deliveryMode']; deliveryChannelIds: string[];
    rationale: string; action: 'none' | { kind: 'playbook' | 'script'; ref: string };
    paging: 'none' | 'business_hours' | 'always'; itemRef?: string;
  }
  ```
  `outcomeTools.ts` imports `fleetDesignRuleFields` from `@breeze/shared` and replaces its independent legacy rule schema with:
  ```ts
  const FLEET_DESIGN_RULE_SHAPE = z.object(fleetDesignRuleFields).describe(
    'A monitor definition. kind and condition must match. Only responses execute; action and paging are recommendation notes. Delivery inherits routing unless explicitly overridden.',
  );
  ```
  Its `alertRules` description becomes `'Monitor-definition proposals for this function; the collection name is retained for stable approval references.'`. Existing final `fleetDesignSubmissionSchema` parsing still performs cross-field validation. Use this concrete replacement in every new-report fixture listed in Files (retain names, severities, rationales and itemRefs):
  ```ts
  kind: 'disk',
  condition: { operator: 'gt', value: 85, durationMinutes: 15 },
  responses: [], deliveryMode: 'inherit', deliveryChannelIds: [],
  ```
  Historical compatibility fixtures deliberately retain `conditions`. New monitor rule validation tests use `fleetDesignRuleSchema`, not a second duplicated condition schema. In `apply.ts`'s `toRuleItem`, replace `conditions: r.conditions,` with:
  ```ts
  kind: r.kind,
  condition: r.condition,
  responses: r.responses,
  deliveryMode: r.deliveryMode,
  deliveryChannelIds: r.deliveryChannelIds,
  ```
  This is the typed read adaptation only; Task 16 changes where these proposals are written before PR3 is mergeable.


  `monitorProposalCompatibility.ts`:
  ```ts
  export function legacySelectedMonitorRefs(
    sections: Array<{ functionKey: string; alertRules: unknown[] }>, selected: readonly string[],
  ): string[] {
    const selectedSet = new Set(selected);
    return sections.flatMap((section) => section.alertRules.flatMap((rule, index) => {
      const ref = `monitoring:${section.functionKey}:rule:${index}`;
      if (!selectedSet.has(ref)) return [];
      const value = rule as { kind?: unknown; condition?: unknown };
      return typeof value?.kind === 'string' && value.condition && typeof value.condition === 'object' ? [] : [ref];
    }));
  }
  ```
  In `preview.ts`, after `monitoringByFunction` has been built from validated approvals and before returning context, insert:
  ```ts
  const selectedMonitorRefs = [...monitoringByFunction].flatMap(([key, items]) =>
    items.rules.map((index) => `monitoring:${key}:rule:${index}`)).filter((ref) => !appliedRefs.has(ref));
  const legacyRefs = legacySelectedMonitorRefs(outcome.sections.monitoring, selectedMonitorRefs);
  if (legacyRefs.length) throw new FleetDesignApplyError('blocked', {
    reason: 'legacy_monitor_proposal', itemRefs: legacyRefs,
    message: 'This report proposes legacy alert rules. Generate a new Fleet Design report to preview monitor definitions before applying.',
  });
  ```
  Import the helper. Do not rewrite stored report JSON or existing ledgers. `FleetDesignViewer.tsx` needs no edit: it consumes only the preserved display fields.
- [ ] **Step 4: Run, expect PASS.**
  ```bash
  (cd packages/shared && npx tsc --noEmit -p . && npx vitest run src/validators/fleetDesign.test.ts)
  (cd apps/api && npx vitest run src/services/fleetDesign/monitorProposalCompatibility.test.ts src/services/aiAgents/outcomeTools.test.ts src/services/aiAgents/runLoop.design.test.ts src/services/aiAgents/fleetDesignReport.test.ts)
  (cd apps/web && npx vitest run src/components/fleetDesign/FleetDesignViewer.test.tsx)
  ```
  Run `cd apps/api && npx tsc --noEmit -p .` and `cd apps/web && npx tsc --noEmit -p .` as well. Task 16 changes persistence before PR3 is mergeable; Task 15 keeps the proposal readers type-correct.
- [ ] **Step 5: Commit.** `git add packages/shared/src/types/fleetDesign.ts packages/shared/src/validators/fleetDesign* apps/api/src/services/aiAgents/outcomeTools.ts apps/api/src/services/aiAgents/outcomeTools.test.ts apps/api/src/services/aiAgents/runLoop.design.test.ts apps/api/src/services/aiAgents/fleetDesignReport.test.ts apps/api/src/services/fleetDesign/monitorProposalCompatibility* apps/api/src/services/fleetDesign/preview.ts apps/api/src/services/fleetDesign/apply.ts apps/web/src/components/fleetDesign/FleetDesignViewer.test.tsx && git commit -m "feat(fleet-design): validate monitor proposals and block stale legacy approvals"`

---

### Task 16: Fleet Designer apply, drift and rollback follow monitor attachments atomically (PR3)

**Files:**
- Create: `apps/api/src/services/fleetDesign/monitorAttachments.ts`, `monitorAttachments.test.ts`.
- Modify: `apps/api/src/services/fleetDesign/apply.ts:316–460,535–580`, `apply.test.ts:210–220` and monitoring cases; `drift.ts:237–269`, `drift.test.ts`; `rollback.ts:201–204`, `rollback.test.ts`.
- Modify: `apps/api/src/services/monitors/monitorService.ts:119–153,226–378`, `monitorService.test.ts`; `apps/api/src/services/monitors/monitorCompiler.ts:287–341` (CompileOptions); `packages/shared/src/types/fleetDesignApply.ts:135–150`.
- Modify: `apps/api/src/__tests__/integration/fleetDesignApply.integration.test.ts:212–245,425–478` and tests for idempotency, step rollback and script provenance.
- Read/reuse: `configurationPolicy.ts:1655–1720,1752–1800,1901` executor arguments; `fleetDesign/preview.ts:348–358` partner-wide retirement gate; W05c1 watch mapping contract (`command: ''` denotes agent-local restart).

**Interfaces:**
- Consumes: Task 15 monitor-shaped `FleetDesignRule`; `createMonitorDefinition`, `updateMonitorDefinition`, `addFeatureLink`, `updateFeatureLink`, `listFeatureLinks`; Fleet Design's step savepoint `ApplyTransaction`.
- Produces: `attachFleetMonitors(policyId, proposals, auth, tx): Promise<Record<itemRef, monitorId>>`, `snapshotFleetMonitors(ids, executor = db)`; same-axis monitor definitions and one cumulative `monitors` link, preserving existing attachments and inheritance. An existing `replace` setting is preserved. No new `alert_rule` or watch-bearing `monitoring` link is written.
- Monitor service adds an optional executor: `getMonitorDefinition(id, auth, executor = db)`, `updateMonitorDefinition(id, input, auth, executor = db)`, `createMonitorDefinition(input, auth, options = {}, executor = db)`. Argument 3 is `options: CompileOptions = {}` and argument 4 is `executor?: DbExecutor` (default `db`). Export `CompileOptions` from `monitorCompiler.ts` now as `Record<string, never>`; W05e extends that same type with adoption options and preserves all executor-aware operations. Do not invent a competing compiler.
- Ledger JSON `FleetDesignCreatedRefs` gains `monitorId?`, `monitorIdsByItemRef?`, `monitorSnapshots?`, `monitorLinkId?`; `linksSnapshot.monitors?`. Existing JSON column classification stays `excludedOpen`; no migration or new table. Re-applying skips existing itemRefs; failure rolls back monitor definitions, compiled children, attachments and ledger rows in that step together.

- [ ] **Step 1: Write the failing tests.** New `monitorAttachments.test.ts`:
  ```ts
  import { beforeEach, describe, expect, it, vi } from 'vitest';
  const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), add: vi.fn(), update: vi.fn(), manage: vi.fn() }));
  vi.mock('../monitors/monitorService', () => ({ createMonitorDefinition: mocks.create }));
  vi.mock('../configurationPolicy', () => ({ listFeatureLinks: mocks.list, addFeatureLink: mocks.add,
    updateFeatureLink: mocks.update, policyAccessCondition: () => undefined }));
  vi.mock('../partnerWideAccess', () => ({ canManagePartnerWidePolicies: mocks.manage }));
  import { attachFleetMonitors, watchMonitorInput } from './monitorAttachments';
  import type { AuthContext } from '../../middleware/auth';
  import type { db } from '../../db';
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const ORG = '11111111-1111-4111-8111-111111111111';
  const PARTNER = '22222222-2222-4222-8222-222222222222';
  const MONITOR = '33333333-3333-4333-8333-333333333333';
  const definition = { name: 'CPU', kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high' };
  const executor = (owner: { orgId: string | null; partnerId: string | null }) => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'policy', ...owner }] }) }) }),
  }) as unknown as Tx;
  beforeEach(() => {
    vi.resetAllMocks(); mocks.manage.mockReturnValue(true); mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: MONITOR }); mocks.add.mockResolvedValue({ id: 'link' });
  });
  describe('Fleet Design monitor attachments', () => {
    it('creates through the service on the policy axis and passes the savepoint everywhere', async () => {
      const tx = executor({ orgId: ORG, partnerId: null });
      const auth = { partnerId: PARTNER } as AuthContext;
      const ids = await attachFleetMonitors('policy', [{ itemRef: 'monitoring:file_server:rule:0', definition }], auth, tx);
      expect(ids).toEqual({ 'monitoring:file_server:rule:0': MONITOR });
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'organization', orgId: ORG }), auth, {}, tx);
      expect(mocks.add).toHaveBeenCalledWith('policy', 'monitors', null,
        expect.objectContaining({ inheritance: 'cumulative', items: [{ monitorId: MONITOR, enabled: true, sortOrder: 0 }] }), undefined, tx);
    });
    it('refuses partner writes without capability before creating a definition', async () => {
      mocks.manage.mockReturnValue(false);
      await expect(attachFleetMonitors('policy', [{ itemRef: 'x', definition }], {} as AuthContext,
        executor({ orgId: null, partnerId: PARTNER }))).rejects.toThrow('partner_wide_write_denied');
      expect(mocks.create).not.toHaveBeenCalled();
    });
    it('does not create for an invisible policy', async () => {
      const tx = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Tx;
      await expect(attachFleetMonitors('missing', [{ itemRef: 'x', definition }], {} as AuthContext, tx)).rejects.toThrow('policy_missing');
      expect(mocks.create).not.toHaveBeenCalled();
    });
    it('maps restart intent to the W05c1 agent-local response', () => {
      expect(watchMonitorInput({ watchType: 'service', name: 'Spooler', alertOnStop: false, autoRestart: true, rationale: 'Print queue' }))
        .toMatchObject({ kind: 'service', condition: { serviceName: 'Spooler' },
          responses: [{ type: 'execute_command', kind: 'restart_service', command: '', maxAttempts: 3, cooldownSeconds: 300, whenOffline: 'queue' }] });
    });
  });
  ```
  Append to existing `apply.test.ts` (which already imports `snapshotLinks`):
  ```ts
  it('includes monitor attachments in the rollback snapshot without changing old snapshots', () => {
    expect(snapshotLinks([])).toEqual({ monitoring: null, alertRule: null });
    expect(snapshotLinks([{ featureType: 'monitors', featurePolicyId: null,
      inlineSettings: { inheritance: 'cumulative', items: [{ monitorId: 'm1', enabled: true }] } }]))
      .toEqual({ monitoring: null, alertRule: null, monitors: {
        inheritance: 'cumulative', items: [{ monitorId: 'm1', enabled: true }],
      } });
  });
  ```
  Extend integration case 3 after `policyId` is known; import `monitorDefinitions`, `configPolicyMonitors` and replace its assertions that a new policy carries watch/rule links:
  ```ts
  const links = await withDbAccessContext(f.dbCtxA, () => listFeatureLinks(policyId));
  expect(links.map((link) => link.featureType)).toEqual(['monitors']);
  const made = await getTestDb().select({ definition: monitorDefinitions })
    .from(configPolicyMonitors).innerJoin(monitorDefinitions, eq(monitorDefinitions.id, configPolicyMonitors.monitorId))
    .where(eq(configPolicyMonitors.featureLinkId, links[0]!.id));
  expect(made.map((row) => row.definition.kind).sort()).toEqual(['disk', 'service']);
  expect(made.every((row) => row.definition.orgId === f.envA.orgId && row.definition.partnerId === null)).toBe(true);
  expect(made.every((row) => row.definition.compiledAlertRuleId !== null)).toBe(true);
  ```
  Add a real savepoint failure test to the same suite using its existing fixture/auth helpers:
  ```ts
  runDb('Fleet monitor creation rolls back when attachment validation fails', async () => {
    const f = await seedFixture();
    const policy = await withDbAccessContext(f.dbCtxA, () => createConfigPolicy(
      { orgId: f.envA.orgId }, { name: 'Atomic monitor apply', status: 'inactive' }, f.envA.userId));
    const name = `Atomic ${randomUUID()}`;
    await expect(withDbAccessContext(f.dbCtxA, () => db.transaction(async (tx) => {
      await attachFleetMonitors(policy.id, [{ itemRef: 'x', definition: {
        name, kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high',
      } }], f.authA, tx);
      throw new Error('force_step_failure');
    }))).rejects.toThrow('force_step_failure');
    const rows = await getTestDb().select().from(monitorDefinitions).where(eq(monitorDefinitions.name, name));
    expect(rows).toEqual([]);
    expect(await withDbAccessContext(f.dbCtxA, () => listFeatureLinks(policy.id))).toEqual([]);
  });
  ```
  Import `attachFleetMonitors` in this suite. Existing org-erasure, cross-tenant apply, repeat apply and partial-step tests remain and now exercise compiled monitor children as well.
  Also add this test to the live suite, importing `updateMonitorDefinition` from `../../services/monitors/monitorService`:
  ```ts
  runDb('rollback preserves a monitor edited after Fleet apply', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds,
      roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));
    await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    const ledger = await readLedger(runId);
    const created = ledger.find((row) => row.itemRef === 'policy:file_server')!.createdRefs!;
    const ids = created.monitorIdsByItemRef as Record<string, string>;
    const monitorId = ids['monitoring:file_server:rule:0']!;
    await withDbAccessContext(f.dbCtxA, () => updateMonitorDefinition(monitorId, {
      condition: { operator: 'gt', value: 92, durationMinutes: 15 },
    }, f.authA));
    const result = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));
    expect(result.refused).toContainEqual({ itemRef: 'policy:file_server', reason: 'modified_since_apply' });
    const [row] = await getTestDb().select().from(monitorDefinitions).where(eq(monitorDefinitions.id, monitorId));
    expect(row!.condition).toMatchObject({ value: 92 });
  });
  ```

- [ ] **Step 2: Run it, expect FAIL.** `cd apps/api && npx vitest run src/services/fleetDesign/monitorAttachments.test.ts src/services/fleetDesign/apply.test.ts` → missing helper and `monitors` snapshot field. Live suite, under `pnpm test-stack up` and EXIT teardown: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/fleetDesignApply.integration.test.ts` → newly created feature types are `monitoring, alert_rule`, not `monitors`.

- [ ] **Step 3a: Implement transaction-aware service calls.** Apply these exact edits to `monitorService.ts` using this script from root. Each replacement asserts the inspected source anchor, preserves the full existing validation/insert/update/compile body, and changes only the executor plumbing:
  ```python
  from pathlib import Path
  p = Path('apps/api/src/services/monitors/monitorService.ts')
  s = p.read_text()
  alias = "type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];\n\n"
  s = s.replace('export async function getMonitorDefinition(', alias + 'export async function getMonitorDefinition(', 1)
  def patch_block(start, end, replacements):
      global s
      a = s.index(start)
      b = s.index(end, a + len(start))
      block = s[a:b]
      for old, new in replacements:
          assert old in block, (start, old)
          block = block.replace(old, new)
      s = s[:a] + block + s[b:]
  patch_block('async function assertEscalationPolicyCompatible(', '/**', [
      ('owner: MonitorOwner,\n', 'owner: MonitorOwner,\n  executor: DbExecutor = db,\n'),
      ('await db\n', 'await executor\n'),
  ])
  patch_block('export async function getMonitorDefinition(', 'export async function createMonitorDefinition(', [
      ('auth: AuthContext,\n', 'auth: AuthContext,\n  executor: DbExecutor = db,\n'),
      ('await db\n', 'await executor\n'),
  ])
  patch_block('export async function createMonitorDefinition(', 'export async function updateMonitorDefinition(', [
      ('auth: AuthContext,\n', 'auth: AuthContext,\n  options: CompileOptions = {},\n  executor: DbExecutor = db,\n'),
      ('input.escalationPolicyId ?? null, owner)', 'input.escalationPolicyId ?? null, owner, executor)'),
      ('return db.transaction(', 'return executor.transaction('),
  ])
  patch_block('export async function updateMonitorDefinition(', 'export async function deleteMonitorDefinition(', [
      ('auth: AuthContext,\n', 'auth: AuthContext,\n  executor: DbExecutor = db,\n'),
      ('getMonitorDefinition(id, auth)', 'getMonitorDefinition(id, auth, executor)'),
      ('partnerId: existing.partnerId,\n  });', 'partnerId: existing.partnerId,\n  }, executor);'),
      ('return db.transaction(', 'return executor.transaction('),
  ])
  p.write_text(s)
  ```
  In `monitorCompiler.ts:35,287`, export the options type and update the signature, retaining the compiler body:
  ```ts
  export type CompileOptions = Record<string, never>;
  export async function compileMonitorInTx(tx: DbTx, def: MonitorDefinitionRow, options: CompileOptions = {}): Promise<CompiledRefs> {
  ```
  In `monitorService.ts`, import `type CompileOptions` from `./monitorCompiler` and replace the create path's compile call with:
  ```ts
  const refs = await compileMonitorInTx(tx, created, options);
  ```
 Both escalation-policy reads now use the supplied executor. Existing two-argument callers still compile. When W05e extends this contract, keep its `CompileOptions` third argument and `compileMonitorInTx(tx, created, options)` call while applying the same executor edits; never replace its adoption option with the pre-W05e empty options type.

- [ ] **Step 3b: Implement attachment and snapshot helpers.** `monitorAttachments.ts`:
  ```ts
  import { and, eq, inArray } from 'drizzle-orm';
  import { createMonitorDefinitionSchema, monitorsInlineSettingsSchema, type FleetDesignRule, type FleetDesignWatch } from '@breeze/shared';
  import { db } from '../../db';
  import { configurationPolicies, monitorDefinitions } from '../../db/schema';
  import type { AuthContext } from '../../middleware/auth';
  import { addFeatureLink, listFeatureLinks, policyAccessCondition, updateFeatureLink } from '../configurationPolicy';
  import { canManagePartnerWidePolicies } from '../partnerWideAccess';
  import { createMonitorDefinition } from '../monitors/monitorService';
  import { getMonitorKindSpec } from '../monitors/kinds';
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  export function watchMonitorInput(watch: FleetDesignWatch): Record<string, unknown> {
    return { name: watch.name, kind: watch.watchType, description: watch.rationale,
      condition: { [watch.watchType === 'service' ? 'serviceName' : 'processName']: watch.name, consecutiveFailures: 2 },
      severity: getMonitorKindSpec(watch.watchType).defaultSeverity, autoResolve: false,
      deliveryMode: 'inherit', responses: watch.autoRestart ? [{ type: 'execute_command',
        kind: 'restart_service', command: '', maxAttempts: 3, cooldownSeconds: 300, whenOffline: 'queue' }] : [] };
  }
  export function ruleMonitorInput(rule: FleetDesignRule, description: string): Record<string, unknown> {
    return { name: rule.name, kind: rule.kind, condition: rule.condition, severity: rule.severity,
      cooldownMinutes: rule.cooldownMinutes, responses: rule.responses, deliveryMode: rule.deliveryMode,
      deliveryChannelIds: rule.deliveryChannelIds, description };
  }
  export async function attachFleetMonitors(policyId: string,
    proposals: Array<{ itemRef: string; definition: Record<string, unknown> }>, auth: AuthContext, tx: Tx,
  ): Promise<Record<string, string>> {
    const [policy] = await tx.select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId })
      .from(configurationPolicies).where(and(eq(configurationPolicies.id, policyId), policyAccessCondition(auth))).limit(1);
    if (!policy) throw new Error('policy_missing');
    if (policy.orgId === null && !canManagePartnerWidePolicies(auth)) throw new Error('partner_wide_write_denied');
    if (policy.orgId === null && policy.partnerId !== auth.partnerId) throw new Error('partner_axis_mismatch');
    const links = await listFeatureLinks(policyId, tx);
    const link = links.find((value) => value.featureType === 'monitors' && !value.featurePolicyId);
    const settings = monitorsInlineSettingsSchema.parse(link?.inlineSettings ?? { items: [] });
    const ids: Record<string, string> = {};
    for (const proposal of proposals) {
      const input = createMonitorDefinitionSchema.parse({ ...proposal.definition,
        ownerScope: policy.orgId === null ? 'partner' : 'organization',
        ...(policy.orgId === null ? {} : { orgId: policy.orgId }) });
      const monitor = await createMonitorDefinition(input, auth, {}, tx);
      ids[proposal.itemRef] = monitor.id;
      settings.items.push({ monitorId: monitor.id, enabled: true, sortOrder: settings.items.length });
    }
    const saved = link ? await updateFeatureLink(link.id, { inlineSettings: settings }, policyId, undefined, tx)
      : await addFeatureLink(policyId, 'monitors', null, settings, undefined, tx);
    if (!saved) throw new Error('monitor_link_missing');
    return ids;
  }
  export async function snapshotFleetMonitors(ids: string[], executor: typeof db | Tx = db): Promise<Record<string, unknown>> {
    if (!ids.length) return {};
    const rows = await executor.select().from(monitorDefinitions).where(inArray(monitorDefinitions.id, ids));
    return Object.fromEntries(rows.map((row) => [row.id, JSON.parse(JSON.stringify(row))]));
  }
  ```
  Watch restart remains agent-local; `alertOnStop` is not mapped to severity/delivery because W05c1 specifies it was inert. Proposal UI already shows `autoRestart`; the executable rule response array is separate from descriptive action metadata.

- [ ] **Step 3c: Wire the existing apply transaction and ledger.** Import the helper functions into `apply.ts`. Keep Task 15's `toRuleItem` projection (`kind`, `condition`, `responses`, `deliveryMode`, `deliveryChannelIds`, name/severity/cooldown/rationale) for its descriptive callers. In `stepMonitoring`, replace the `newWatches`/`newRules` construction with:
  ```ts
  const proposals = [
    ...items.watches.filter((n) => newWatchRefs.includes(`monitoring:${functionKey}:watch:${n}`)).map((n) => ({
      itemRef: `monitoring:${functionKey}:watch:${n}`, definition: watchMonitorInput(section.watches[n]!),
    })),
    ...items.rules.filter((n) => newRuleRefs.includes(`monitoring:${functionKey}:rule:${n}`)).map((n) => {
      const rule = section.alertRules[n]!;
      return { itemRef: `monitoring:${functionKey}:rule:${n}`,
        definition: ruleMonitorInput(rule, toRuleItem(rule, createdScriptIdFor(ctx, rule, functionKey)).rationale) };
    }),
  ];
  ```
  For the reused-policy branch, replace both legacy-link append blocks through creation of `createdRefs` with:
  ```ts
  policyId = existingRow.createdRefs.policyId;
  const newIds = await attachFleetMonitors(policyId, proposals, ctx.auth, tx);
  const monitorIdsByItemRef = { ...existingRow.createdRefs.monitorIdsByItemRef, ...newIds };
  const after = await listFeatureLinks(policyId, tx);
  createdRefs = { ...existingRow.createdRefs, monitorIdsByItemRef,
    monitorLinkId: after.find((link) => link.featureType === 'monitors')?.id,
    monitorSnapshots: await snapshotFleetMonitors(Object.values(monitorIdsByItemRef), tx),
    linksSnapshot: snapshotLinks(after) };
  ```
  Retain `updateCreatedRefs(..., tx)` and the in-memory ledger update. For the new-policy branch retain creation, assignment and activation, but replace the two `addFeatureLink` calls with `const monitorIdsByItemRef = await attachFleetMonitors(policyId, proposals, ctx.auth, tx);`. Replace `createdRefs` with:
  ```ts
  createdRefs = { policyId, groupId: resolvedGroupId, assignmentId: assignment?.id,
    monitorIdsByItemRef, monitorLinkId: after.find((link) => link.featureType === 'monitors')?.id,
    monitorSnapshots: await snapshotFleetMonitors(Object.values(monitorIdsByItemRef), tx),
    linksSnapshot: snapshotLinks(after) };
  ```
  Each watch/rule `recordApplied` call now uses `createdRefs: { policyId, monitorId: createdRefs.monitorIdsByItemRef?.[ref] }`. Keep item kind, step, actor and audit fields. `snapshotLinks` becomes:
  ```ts
  export function snapshotLinks(links: Array<{ featureType: string; featurePolicyId: string | null; inlineSettings: unknown }>) {
    const read = (kind: string) => links.find((link) => link.featureType === kind && !link.featurePolicyId);
    const monitors = read('monitors');
    return { monitoring: canonical(read('monitoring')?.inlineSettings ?? null),
      alertRule: canonical(read('alert_rule')?.inlineSettings ?? null),
      ...(monitors ? { monitors: canonical(monitors.inlineSettings) } : {}) };
  }
  ```
  Add the ledger fields to `FleetDesignCreatedRefs`:
  ```ts
  monitorId?: string;
  monitorLinkId?: string;
  monitorIdsByItemRef?: Record<string, string>;
  monitorSnapshots?: Record<string, unknown>;
  linksSnapshot?: { monitoring: unknown; alertRule: unknown; monitors?: unknown };
  ```
  Replace the old `linksSnapshot` declaration, not duplicate it.

  In `linkRulesToCreatedScripts`, add this monitor-ledger branch immediately after `if (!policyId || !section) continue;`; keep the legacy branch only for old applied ledgers. Import `getMonitorDefinition` / `updateMonitorDefinition`:
  ```ts
  if (policyRow.createdRefs?.monitorIdsByItemRef) {
    let changed = false;
    for (const [index, rule] of section.alertRules.entries()) {
      const proposalRef = proposalRefForRule(ctx.outcome, rule.action, functionKey);
      const scriptId = proposalRef && createdRefs.has(proposalRef) ? ctx.createdScriptIds.get(proposalRef) : undefined;
      const monitorId = policyRow.createdRefs.monitorIdsByItemRef[`monitoring:${functionKey}:rule:${index}`];
      if (!scriptId || !monitorId) continue;
      const current = await getMonitorDefinition(monitorId, ctx.auth, tx);
      const original = toRuleItem(rule).rationale;
      if (!current || current.description !== original) continue;
      await updateMonitorDefinition(monitorId, { description: withScriptCreated(original, scriptId) }, ctx.auth, tx);
      changed = true;
    }
    if (changed) {
      const next = { ...policyRow.createdRefs,
        monitorSnapshots: await snapshotFleetMonitors(Object.values(policyRow.createdRefs.monitorIdsByItemRef), tx) };
      await updateCreatedRefs(policyRow.id, ctx.orgId, next, tx);
      policyRow.createdRefs = next;
    }
    continue;
  }
  ```
  This preserves script provenance without turning the old text-only proposal action into execution.

- [ ] **Step 3d: Make drift and rollback understand new definitions.** In `drift.ts`, after loading `rules` and `watches`, before their grouping loops, load attachments from the already org-scoped `policyIds`. Classify design-created watches from ledger item kind, not monitor kind (a service definition can be a rule proposal):
  ```ts
  type LiveMonitorRow = { policy_id: string; name: string; kind: string; condition: Record<string, unknown>;
    severity: string; cooldown_minutes: number; enabled: boolean; item_kind: string | null };
  const monitorRows = policyIds.length === 0 ? [] : [...await db.execute<LiveMonitorRow>(sql`
    SELECT fl.config_policy_id AS policy_id, md.name, md.kind, md.condition, md.severity,
           md.cooldown_minutes, (md.enabled AND pm.enabled) AS enabled,
           origin.item_kind
      FROM config_policy_monitors pm
      JOIN config_policy_feature_links fl ON fl.id = pm.feature_link_id
      JOIN monitor_definitions md ON md.id = pm.monitor_id
      LEFT JOIN LATERAL (
        SELECT li.item_kind FROM fleet_design_applied_items li
         WHERE li.org_id = ${orgId} AND li.status = 'applied'
           AND li.created_refs->>'monitorId' = md.id::text
           AND li.item_kind IN ('watch', 'rule')
         ORDER BY li.applied_at DESC LIMIT 1
      ) origin ON true
     WHERE fl.config_policy_id = ANY(${uuidArray(policyIds)})
  `)];
  for (const monitor of monitorRows) {
    if (monitor.item_kind === 'watch') watches.push({ policy_id: monitor.policy_id,
      name: String(monitor.condition.serviceName ?? monitor.condition.processName ?? monitor.name),
      watch_type: monitor.kind, enabled: monitor.enabled });
    else rules.push({ policy_id: monitor.policy_id, name: monitor.name,
      severity: monitor.severity, cooldown_minutes: monitor.cooldown_minutes });
  }
  ```
  Keep legacy rows in the comparison for old applied reports, but add `WHERE w.retired_at IS NULL` and `WHERE r.retired_at IS NULL` to their respective SQL queries. The existing pure `computeDrift` contract retains display-field comparison; full monitor definition changes are covered by rollback snapshots.

  In `rollbackPolicy`, before deleting any assignment, compare definition snapshots as well as links:
  ```ts
  if (row.createdRefs?.monitorIdsByItemRef) {
    const currentMonitors = await snapshotFleetMonitors(Object.values(row.createdRefs.monitorIdsByItemRef));
    if (JSON.stringify(canonical(currentMonitors)) !== JSON.stringify(canonical(row.createdRefs.monitorSnapshots)))
      throw new RollbackRefused('modified_since_apply');
  }
  ```
  Import `snapshotFleetMonitors` from `./monitorAttachments`. Rollback keeps its existing archive-and-unassign semantics; historical alerts and definitions survive. Never delete a manually edited monitor during rollback.

- [ ] **Step 4: Run, expect PASS.** Update the existing Fleet unit mocks to mock `attachFleetMonitors`/`snapshotFleetMonitors` and include their calls in the existing final-argument savepoint assertion; change new-report fixtures from `conditions` to the concrete Task 15 monitor shape. Keep legacy fixtures in historical rollback cases. In live integration tests replace new-policy watch/rule-link expectations with monitor attachment assertions above, and keep old baseline fixtures to prove coexistence. Run:
  ```bash
  (cd packages/shared && npx tsc --noEmit -p . && npx vitest run src/validators/fleetDesign.test.ts)
  (cd apps/api && npx tsc --noEmit -p . && npx vitest run src/services/fleetDesign src/services/monitors/monitorService.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts)
  pnpm test-stack up
  trap 'pnpm test-stack down' EXIT
  (cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/fleetDesignApply.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts)
  ```
  PASS requires no unmanaged alert-rule inserts from new Fleet proposals, no legacy feature links on the new policy, stable ledger IDs on repeat apply, and zero orphan definitions after the forced savepoint rollback.
- [ ] **Step 5: Commit.** `git add apps/api/src/services/fleetDesign apps/api/src/services/monitors/monitorService.ts apps/api/src/services/monitors/monitorService.test.ts apps/api/src/services/monitors/monitorCompiler.ts packages/shared/src/types/fleetDesignApply.ts apps/api/src/__tests__/integration/fleetDesignApply.integration.test.ts && git commit -m "feat(fleet-design): apply monitor attachments within step transactions"`

---

### Task 17: Publish the three-facet docs, migration instructions and W05c release notes (PR3)

**Files:**
- Modify: `apps/docs/src/content/docs/features/alerts.mdx:1–252`, `monitors.mdx:8–173`, `notifications.mdx:8,352–403,614–616`, `configuration-policies.mdx:68–115,160–180,375`.
- Delete: `apps/docs/src/content/docs/features/alert-templates.mdx:1–513`, `service-monitoring.mdx:1–97`; modify `apps/docs/astro.config.mjs:4–6,120–126` (redirects and sidebar).
- Modify the nine guides: `apps/docs/src/content/docs/migration/overview.mdx:51,88–92`, `ninjaone.mdx:168`, `syncro.mdx:109,124`, `other-rmms.mdx:99,156`, `atera.mdx:116,120–121`, `datto-rmm.mdx:170`, `n-central.mdx:150`, `kaseya-vsa.mdx:125–127`, `connectwise-automate.mdx:148–149`; also `scripts-from-datto.mdx:142`, a tenth actual caller found while reading the repository.
- Modify: `docs/release-notes/next-release-draft.md:15–21`.
- Create: `apps/web/src/lib/__tests__/alertingDocs.test.ts` (Vitest harness for static documentation contracts; docs package has no Vitest script).

**Interfaces:**
- Consumes: the shipped W05b Delivery page/resolver and W05c1 conversion routes, Tasks 9–16 user behavior. Old docs URLs redirect to `/features/monitors/`. Preserve provider-specific channel setup instructions and sourced-alert producers (warranty, compliance, backup, security, patches).
- Produces: domain documentation with Inbox · Monitors · Delivery, conversion preview/blocked reasons/Undo and manual Retire, policy inheritance and check interval, effective device monitoring, Alert workflows, Fleet Designer guidance. W05c deadline is **before the W05d retirement release, which must be at least one release later**; do not invent a date or release version. The hosted release checklist records per-partner counts without committing infrastructure hostnames or regions.

- [ ] **Step 1: Write the failing test.** `alertingDocs.test.ts`:
  ```ts
  import { existsSync, readFileSync, readdirSync } from 'node:fs';
  import { resolve } from 'node:path';
  import { describe, expect, it } from 'vitest';
  const root = resolve(import.meta.dirname, '../../../../..');
  const docs = resolve(root, 'apps/docs/src/content/docs');
  const read = (path: string) => readFileSync(resolve(docs, path), 'utf8');
  describe('alerting consolidation documentation', () => {
    it('has one authoring guide and redirects retired feature guides', () => {
      for (const name of ['alert-templates', 'service-monitoring']) {
        expect(existsSync(resolve(docs, `features/${name}.mdx`))).toBe(false);
        const config = readFileSync(resolve(root, 'apps/docs/astro.config.mjs'), 'utf8');
        expect(config).toContain(`'/features/${name}'`);
        expect(config).not.toContain(`slug: 'features/${name}'`);
      }
      const alerts = read('features/alerts.mdx');
      for (const heading of ['## Inbox', '## Monitors', '## Delivery']) expect(alerts).toContain(heading);
    });
    it('documents explicit defaults, conversion and effective monitoring', () => {
      expect(read('features/notifications.mdx')).toContain('Everything else');
      expect(read('features/notifications.mdx')).not.toContain('falls back to all enabled org channels');
      const monitors = read('features/monitors.mdx');
      expect(monitors).toContain('Needs conversion');
      expect(monitors).toContain('Replace inherited monitors');
      expect(monitors).toContain('Reset escalation');
      expect(monitors).not.toContain("Responses target every device");
    });
    it('updates every migration guide, including the extra script-porting guide', () => {
      const files = readdirSync(resolve(docs, 'migration')).filter((name) => name.endsWith('.mdx'));
      for (const file of files) {
        const body = read(`migration/${file}`);
        expect(body, file).not.toMatch(/\/features\/(service-monitoring|alert-templates)\//);
        expect(body, file).not.toMatch(/monitors and alert rules|point alert rules|\[alert rules\]/i);
      }
    });
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/lib/__tests__/alertingDocs.test.ts` → retired pages still exist; domain headings absent; stale default and migration links found.

- [ ] **Step 3a: Write the domain guide and monitor guide.** Replace `features/alerts.mdx` with:
  ```mdx
  ---
  title: Alerts
  description: Use the inbox to act on problems, monitors to define conditions and responses, and delivery to decide who is notified.
  ---

  Alerts is one domain with three facets: **Inbox**, **Monitors**, and **Delivery**.
  Configuration policies select the devices a monitor reaches.

  ## Inbox

  Open **Alerts** to review active problems. Filter by severity, device, status or
  time, then open an alert to see its context and history. Acknowledge an alert
  when someone takes responsibility; resolve it when the problem is fixed.
  Suppression and maintenance windows affect notification/evaluation behavior
  according to their configured scope. Correlations remain available when enabled.

  Condition-based alerts trace to a monitor. Feature engines such as compliance,
  warranty, security, patching and backup also raise alerts; their configuration
  remains with those features.

  ## Monitors

  Open **Alerts → Monitors** to create a condition, choose its severity and noise
  settings, add device-bound responses, and choose delivery and escalation.
  Attach the monitor to a configuration policy and assign that policy to devices.
  See [Monitors](/features/monitors/) for kinds, deployment and conversion.

  Per-monitor responses run on the device whose alert triggered them. For a broad
  workflow such as “any critical CPU alert → triage,” open **Jobs → Alert workflows**.
  Optional severity and monitor-kind filters narrow which alerts start that workflow.
  Compiler-managed automations are hidden from the Jobs list.

  ## Delivery

  Open **Alerts → Delivery** for **Channels**, **Routing**, and **Escalation policies**.
  A monitor's Notify setting takes precedence; otherwise routing selects the first
  matching row. The explicit **Everything else** row supplies the default. New
  channels receive no alerts until added to a routing row or monitor override.
  See [Notifications and delivery](/features/notifications/).

  ## Converting existing configuration

  Open **Alerts → Monitors → Needs conversion**, or a policy's **Monitors** tab.
  Preview the proposed monitors and the device equivalence result. Convert only
  when the preview has no differences or blockers. Unconvertible items show their
  reason; replace their behavior deliberately or use **Retire** with a reason.
  Successful conversion preserves source rows and alert history. The persistent
  **Conversion history → Undo** reverses an available ledger entry, including manual retirement, after revisiting the page. Undo becomes unavailable for legacy runtimes removed by W05d.

  Authorized partner managers can use **Convert everything** after reviewing the
  affected policies. Resolve unconvertible rows before the W05d retirement release,
  which ships at least one release after W05c. Legacy policy tabs remain available
  during this conversion release; the Alert Templates settings screens redirect
  to Monitors now.
  ```
  Replace `features/monitors.mdx` with:
  ```mdx
  ---
  title: Monitors
  description: Define alert conditions, device responses and delivery once, then attach them to configuration policies.
  ---

  A monitor combines **what to watch**, **severity and noise**, **responses**,
  **delivery**, and **escalation**. Author it at **Alerts → Monitors**.

  ## Create and deploy

  1. Select **New monitor**, choose a kind and configure its condition.
  2. Choose severity, cooldown and automatic resolution.
  3. Add up to ten responses. Responses execute on the device that breached.
  4. In **Notify**, use **Inherit**, **use these channels instead**, or **inbox only**.
     The inherited preview shows eligible channels, skipped destinations with their reasons, escalation and the winning source.
  5. Choose an escalation policy if needed and configure recurrence escalation.
  6. Save, test on a device, and attach to a configuration policy. Assign that
     policy to an organization, site, group or device.

  Policy **Monitors** tabs also offer **Attach existing**, **Create monitor** and
  recommendations for unattached built-ins. Creating a definition alone does not
  deploy it. Definitions retain their organization or partner ownership; incompatible
  attachments are refused rather than widening access.

  ## Conditions

  The kind picker includes resource thresholds, offline state, event logs,
  patch compliance, service/process state and resources, certificate expiry,
  bandwidth, disk I/O, network errors, software/security/backup conditions,
  script probes and network checks. `GET /monitor-definitions/kinds` returns the
  exact kinds and supported condition fields on your server.

  Composite monitors contain two to ten server-evaluated child conditions,
  matching all or any. They cannot nest or contain agent-delivered/worker-provisioned
  children. Composite conditions do not support per-policy threshold overrides.

  Service/process monitors run on the device; no separate legacy watch is required.
  Their consecutive-failure setting accepts 1–100. A service restart response carries
  its own maximum attempts (0–50, default 3) and cooldown (30–86400 seconds, default
  300). Agent-local restarts continue through the delivered watch configuration.
  The policy's **Agent collection → Check interval** accepts 10–3600 seconds, default 60.

  ## Inheritance and overrides

  **Add to inherited monitors** is cumulative. A policy contributes its attachments
  alongside inherited monitors; the resolver chooses the effective attachment for
  each monitor using assignment scope and priority, including role and OS filters.
  A closer attachment can disable or override a monitor without editing its definition.

  **Replace inherited monitors** preserves converted inline rules' replacement
  behavior. The policy tab shows inherited attachments being ignored. Conversion may
  set this mode automatically; change it only after reviewing the resulting device
  coverage. The device Monitoring tab shows the effective result.

  ## Needs conversion

  Preview the legacy rows on a policy's **Monitors** tab. A watch may produce a
  state monitor plus separate CPU and memory monitors. Preview reports proposed
  definitions, delivery, open alerts and unconvertible reasons. Convert the parent
  first when required. Missing prerequisite fixes, behavioral differences or a stale
  preview block confirmation; refresh and review before retrying.

  Conversion retires source rows in place. Active, acknowledged and suppressed
  alerts move to the compiled monitor path with their provenance retained. No source
  row is deleted. **Conversion history → Undo** restores an available ledger entry,
  including retirement entries. W05d disables Undo for sources whose runtime was removed. A flat supported AND/OR group can become a composite;
  nested groups, unsupported process-count conditions and templates with no evaluable
  condition show an explicit reason. **Retire** is a deliberate operator action.

  Complete conversion before the W05d retirement release, at least one release after
  W05c. W05d will process leftovers and list unconvertible retirements for review.
  Until then, review pending rows; a zero count is the completion signal.

  ## Device Monitoring and recurrence

  Open a device's **Monitoring** tab (`#monitoring`) to see effective monitor, kind,
  source policy, healthy/breaching/unknown state, open episode and escalation status.
  No evidence means unknown. Disabled winning attachments remain visible.

  Recurrence counts breach episodes rather than repeated samples of one continuous
  breach. When escalation pauses responses, **Reset escalation** clears the latch and
  resumes responses. Reset does not close the open episode or resolve its alert.
  The server enforces alert-write permission and MFA for the reset action.

  ## Automation and AI tools

  Use **Jobs → Alert workflows** for broad event-triggered behavior. Severity and kind
  filters are optional; monitor responses stay device-bound. Fleet Designer proposes
  monitor definitions and applies them as policy attachments. Historical proposals
  using the old rule shape must be regenerated before applying.

  `manage_monitor_definitions` authors monitors. Attach through
  `manage_policy_feature_link` with `featureType: "monitors"`.
  `manage_service_monitors` lists effective service/process monitors only.

  ## API and troubleshooting

  Monitor CRUD, attachments, device tests and activity live under
  `/monitor-definitions`. Conversion routes live under
  `/monitor-definitions/conversion`. The device view reads `/devices/:id/monitors`;
  escalation reset posts to `/monitor-definitions/:id/devices/:deviceId/reset`.

  If a monitor does not appear on a device, check policy assignment, role/OS filters,
  inheritance and enabled state. If notifications are missing, inspect the resolved
  delivery preview and [Delivery](/features/notifications/). If a response is paused,
  inspect recurrence escalation before resetting it. Compiler-managed rows are
  implementation details; change the monitor definition rather than editing them.
  ```

- [ ] **Step 3b: Replace obsolete sections, redirects and migration links with exact edits.** Add to the top-level Astro config (next to `site`):
  ```js
  redirects: {
    '/features/alert-templates': { status: 301, destination: '/features/monitors/' },
    '/features/service-monitoring': { status: 301, destination: '/features/monitors/' },
  },
  ```
  Delete both retired `.mdx` files and their two sidebar slug entries. Existing deployment must serve Astro's generated redirect output; inspect generated destinations during verification. Preserve W05b's redirects if present by adding these entries to the existing object.

  Use this exact replacement script from root for the surviving feature and migration pages; it edits only the named documentation files:
  ```python
  from pathlib import Path
  import re
  base = Path('apps/docs/src/content/docs')
  def section(text, start, end, replacement):
      a, b = text.index(start), text.index(end, text.index(start) + len(start))
      return text[:a] + replacement.strip() + '\n\n' + text[b:]
  p = base / 'features/notifications.mdx'
  s = p.read_text()
  s = section(s, '### From alerts', '### From automations', '''### From alerts

  Open **Alerts → Delivery** to manage Channels, Routing and Escalation policies.
  In-app notifications remain independent of channel routing.

  1. A monitor set to **inbox only** sends no channel notifications or escalation.
  2. **Use these channels instead** replaces routing with the monitor's channels.
  3. Otherwise the first matching routing row wins: ascending priority, organization
     rows before partner rows at equal priority. Match severity, monitor kind and site.
  4. The organization's **Everything else** row wins over the partner's default row.
     Empty default channels mean inbox only. With neither default, delivery is inbox only.

  Escalation resolves independently: the monitor's explicit policy, then the winning
  routing row's policy. During W05c, unconverted legacy sources retain their existing
  overrides; conversion carries them onto the monitor.

  New channels receive no alerts until added to a routing row or monitor override.
  The monitor's resolved preview uses the same delivery decision as dispatch. Eligible
  channels are sent; skipped disabled, missing or wrong-owner references are listed.
  Escalation steps can target channels or users, repeat at the configured interval,
  and cancel when the alert is acknowledged or resolved.''')
  s = s.replace('additional channels (email, webhook, Slack, Teams, PagerDuty, SMS, Pushover) are routed based on alert rule configuration or organization defaults.',
                'additional channels are selected by monitor overrides and the explicit Delivery routing rows.')
  s = s.replace('Alert rules can reference an escalation policy via `escalationPolicyId` in their override settings.',
                'Monitors and routing rows can reference an escalation policy. Manage policies on Alerts → Delivery.')
  s = re.sub(r'^- \*\*Delivery\*\*.*$', '- **Delivery** -- non-default rows run in priority order, organization before partner at equal priority. The organization Everything else row shadows the partner default. Adding a channel never subscribes it automatically.', s, flags=re.M)
  s = s.replace('Escalation policies support the same `ownerScope` field via the API.', 'Escalation policies use the same ownership selector on Delivery.')
  s = s.replace('**Alerts > Channels** page', '**Alerts → Delivery** page')
  s = re.sub(r'^Verify that notification channels exist.*$', 'Inspect the monitor Notify preview and the matching Delivery row. Confirm its channels are enabled and subscribed, and test the destination. An empty Everything else row intentionally means inbox only.', s, flags=re.M)
  p.write_text(s)

  p = base / 'features/configuration-policies.mdx'
  s = p.read_text()
  s = re.sub(r'^\| \*\*Alert Rules\*\*.*\n', '', s, flags=re.M)
  s = re.sub(r'^\| \*\*Monitoring\*\*.*\n', '', s, flags=re.M)
  s = section(s, '## Alerts vs. Monitoring', '## Enforcement modes', '''## Monitors and alerting

  Author conditions and responses in [Monitors](/features/monitors/). A policy's
  **Monitors** tab attaches definitions, controls inheritance and the agent check
  interval, and previews pending legacy conversion. New conditions have one home.
  The legacy Alerts and Service & Process Monitoring tabs remain during W05c for
  conversion compatibility; do not create new conditions there.

  Select **Add to inherited monitors** for cumulative deployment, or review
  **Replace inherited monitors** when preserving converted inline-rule behavior.
  Broad reactive automation belongs to **Jobs → Alert workflows**.''')
  s = section(s, '### Alert Rules', '### Maintenance Windows', '''### Monitors

  Open **Monitors**, attach an existing definition or create one, then save the
  policy. Configure the condition, responses and Notify settings on that monitor.
  Use [Delivery](/features/notifications/) for shared notification routing.
  During conversion, review **Needs conversion** before confirming; resolve every
  blocked or unconvertible row deliberately.''')
  s = s.replace('(e.g., an existing alert rule)', '(e.g., an existing update ring)')
  s = s.replace('`monitors` (plural) is the [Monitors](/features/monitors/) feature -- distinct from `monitoring` (singular), which is the agent-side service/process watch feature.',
                '`monitors` is the authoring/deployment feature. `alert_rule` and `monitoring` remain accepted only for transitional compatibility during W05c; use the conversion panel for their existing rows.')
  p.write_text(s)

  for p in (base / 'migration').glob('*.mdx'):
      s = p.read_text()
      s = s.replace('/features/service-monitoring/', '/features/monitors/')
      s = s.replace('/features/alert-templates/', '/features/monitors/')
      s = re.sub(r'(\[(?:Monitors|monitors)\]\(/features/monitors/\)) (?:\+|plus|and) \[alert rules\]\(/features/alerts/\)',
                 r'\1 with [Delivery](/features/notifications/)', s)
      s = s.replace('Alert rules and [alert templates](/features/monitors/)', '[Monitors](/features/monitors/) and [Delivery](/features/notifications/)')
      s = s.replace('Components ported; monitors are re-authored as Breeze monitors and alert rules.',
                    'Components ported; monitoring conditions are re-authored as Breeze [monitors](/features/monitors/) and attached to configuration policies.')
      s = s.replace('Alert rule bound to [Breeze ticketing](/features/ticketing/) or a [PSA integration](/features/psa-integrations/)',
                    'Connect [Breeze ticketing](/features/ticketing/) or a [PSA integration](/features/psa-integrations/) and configure its supported alert integration')
      s = s.replace('and point alert rules at them', 'and configure its supported alert integration')
      s = s.replace('and point alert rules there', 'and configure its supported alert integration')
      s = s.replace('[Event log forwarding](/features/event-log-forwarding/) with alert rules',
                    '[Event log monitors](/features/monitors/) for conditions; [forwarding](/features/event-log-forwarding/) for external log delivery')
      s = s.replace('Alert rules bound to a [PSA integration](/features/psa-integrations/)',
                    'Configure the supported alert integration in your [PSA integration](/features/psa-integrations/)')
      if p.name == 'datto-rmm.mdx':
          s = re.sub(r'^Datto monitors live inside.*$', 'Rebuild Datto conditions as Breeze [monitors](/features/monitors/). Each monitor carries its condition, responses and delivery settings; attach it to a configuration policy to choose the devices it reaches.', s, flags=re.M)
      if s != p.read_text(): p.write_text(s)
  ```
  No new ticket delivery channel is promised. The ten guide paths in Files cover every legacy match found by the source audit.

- [ ] **Step 3c: Append release content.** Add these checklist entries to `Release to-do` and the paragraphs to `Self-Hosting / Upgrade Notes`, preserving existing release notes:
  ```md
  - [ ] Deploy prerequisites and W05c1 before enabling the conversion UI.
  - [ ] Run the platform-admin conversion page for each hosted partner. Record
    pending policies/rows before and after, converted and unconvertible counts,
    actor and run time in the release checklist. Review every non-zero remainder.
  - [ ] Announce the W05d retirement release at least one release after W05c.
    Self-hosters must review Needs conversion before upgrading to that release.

  - **Alerting conversion (W05c):** Alerts now has Inbox, Monitors and Delivery.
    Open Alerts → Monitors → Needs conversion, then review each policy preview.
    Convert only after reviewing device equivalence and the proposed delivery.
    Unconvertible rows show reasons and require deliberate replacement or retirement.
    Source rows and alert history are retained. Conversion history provides persistent
    Undo until W05d removes the source runtime; unavailable entries disable Undo. Partner managers can Convert everything;
    review the returned unconvertible count afterward.
  - **Deadline:** complete review before W05d, which will ship at least one release
    later. W05d performs the remaining sweep and lists unconvertible retirements.
    The legacy policy tabs still exist during W05c. Alert Templates settings URLs
    redirect to Monitors immediately; condition authoring belongs to Monitors.
  - **Delivery defaults:** the explicit Everything else row controls fallback.
    New channels are not subscribed until added to a routing row or monitor override.
  - **Device and automation views:** device Monitoring shows effective monitors,
    source policy, episodes and escalation. Reset escalation resumes responses but
    does not resolve an alert. Jobs → Alert workflows supports severity/kind filters.
    Fleet Designer applies monitor attachments; regenerate old rule-shaped proposals.
  ```
- [ ] **Step 4: Run, expect PASS.** `(cd apps/web && npx vitest run src/lib/__tests__/alertingDocs.test.ts)`; `pnpm --filter @breeze/docs check`; `pnpm --filter @breeze/docs build`. Inspect `apps/docs/dist/features/{alert-templates,service-monitoring}/index.html`: each generated redirect names `/features/monitors/`; inspect the built sidebar for no retired slug. `rg -n 'service-monitoring/|alert-templates/|point alert rules|monitors and alert rules' apps/docs/src/content/docs/migration` must exit 1 (no matches). Preserve the configuration API's transitional enum until W05d.
- [ ] **Step 5: Commit.** `git add apps/docs/src/content/docs/features/alerts.mdx apps/docs/src/content/docs/features/monitors.mdx apps/docs/src/content/docs/features/notifications.mdx apps/docs/src/content/docs/features/configuration-policies.mdx apps/docs/src/content/docs/features/alert-templates.mdx apps/docs/src/content/docs/features/service-monitoring.mdx apps/docs/src/content/docs/migration apps/docs/astro.config.mjs docs/release-notes/next-release-draft.md apps/web/src/lib/__tests__/alertingDocs.test.ts && git commit -m "docs(alerts): explain monitor conversion, delivery and retirement timing"`

---

### Task 18: Verify cross-wave contracts and all three PRs (PR3)

**Files:**
- Read/verify Task 1 and Task 5 async-preview files; polling and cancellation ship in PR1, not in this verification task.
- Create: `scripts/verify-alerting-consolidation-w05c2.sh`, `apps/web/src/lib/__tests__/alertingVerification.test.ts`.
- Verify all Files entries in Tasks 1–17, including shared validators, API routes/tools/services, eight locale directories, web route registries, docs redirects and release notes. No migration is introduced by W05c2.

**Interfaces:**
- Consumes exact W05c1 leaf contracts from its Task 14: GET `/monitor-definitions/conversion/policies/:policyId/preview` returns 200 `{ data: PolicyConversionPreview }` or 202 `{ data: PolicyConversionPreviewPending }`; poll the same GET. W05c1 `PolicyConversionPreviewPending` contains `status: 'running'`, `progress: { checked, total }`. Tasks 1 and 5 already implement this in PR1; this task verifies the merged behavior.
- Produces: one reproducible verification command covering PR1 completed previews, polling progress, cancellation on unmount/policy change, and stale-preview confirmation disabled during refresh. Verification is local on the final integration of all three PRs, not evidence borrowed from a green sibling branch.

- [ ] **Step 1: Write the failing test.** Create `alertingVerification.test.ts`:
  ```ts
  import { existsSync, readFileSync } from 'node:fs';
  import { resolve } from 'node:path';
  import { expect, it } from 'vitest';
  const root = resolve(import.meta.dirname, '../../../../..');
  it('provides an executable verification manifest including real isolation proofs', () => {
    const path = resolve(root, 'scripts/verify-alerting-consolidation-w05c2.sh');
    expect(existsSync(path), 'missing W05c2 verification script').toBe(true);
    const source = readFileSync(path, 'utf8');
    for (const required of ['tsc --noEmit', 'vitest.integration.config.ts', 'deviceMonitors.integration.test.ts',
      'fleetDesignApply.integration.test.ts', 'rls-coverage.integration.test.ts', 'test-stack down'])
      expect(source).toContain(required);
    expect(source).not.toContain('test -- --run');
  });
  ```
- [ ] **Step 2: Run it, expect FAIL.** `cd apps/web && npx vitest run src/components/monitoring/conversion/conversionApi.test.ts src/components/monitoring/conversion/NeedsConversionPanel.test.tsx src/lib/__tests__/alertingVerification.test.ts` → `missing W05c2 verification script`; the PR1 progress and blocked-empty tests already pass.

- [ ] **Step 3: Implement the verification runner.**
  New `scripts/verify-alerting-consolidation-w05c2.sh` (from root, `chmod +x` before committing):
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  root_dir="$(git rev-parse --show-toplevel)"
  cd "$root_dir"
  (cd packages/shared && npx tsc --noEmit -p . && npx vitest run src/validators/fleetDesign.test.ts src/validators/monitors.test.ts)
  (cd apps/api && npx tsc --noEmit -p . && npx vitest run \
    src/services/monitors src/services/fleetDesign src/services/aiToolsConfigPolicy.test.ts \
    src/services/aiToolsFleet src/services/aiAgentSdkTools.mcpCoverage.test.ts \
    src/services/aiAgents/outcomeTools.test.ts src/services/aiAgents/runLoop.design.test.ts \
    src/services/aiAgents/fleetDesignReport.test.ts src/jobs/automationWorker.test.ts \
    src/routes/admin/monitorConversion.test.ts src/routes/monitorDefinitions \
    src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts)
  (cd apps/web && npx tsc --noEmit -p . && npx vitest run \
    src/components/monitoring src/components/automations src/components/fleetDesign \
    src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx \
    src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx \
    src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts \
    src/components/devices/DeviceMonitoringTab.test.tsx src/components/admin/MonitorConversionAdmin.test.tsx \
    src/components/layout/Sidebar.nav.test.tsx src/lib/routeScope.test.ts src/lib/i18n \
    src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts \
    src/lib/__tests__/alertTemplatesRetired.test.ts src/lib/__tests__/alertingDocs.test.ts \
    src/lib/__tests__/alertingVerification.test.ts)
  pnpm --filter @breeze/docs check
  pnpm --filter @breeze/docs build
  # Register teardown before startup so partial startup failure also gets cleaned up.
  trap 'pnpm test-stack down' EXIT
  pnpm test-stack up
  (cd apps/api && npx vitest run -c vitest.integration.config.ts \
    src/__tests__/integration/deviceMonitors.integration.test.ts \
    src/__tests__/integration/fleetDesignApply.integration.test.ts \
    src/__tests__/integration/monitorDefinitionsPartnerRls.integration.test.ts \
    src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts \
    src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts \
    src/__tests__/integration/rls-coverage.integration.test.ts \
    src/__tests__/integration/tenantCascade.integration.test.ts \
    src/__tests__/integration/tenant-export-policy.integration.test.ts \
    src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
    src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
  git diff --check
  ```
  The two conversion integration suites are W05c1 outputs; fail if the prerequisite checkout lacks them. Do not use `--passWithNoTests` or silently omit live proofs. This script starts Docker only when the implementer executes the verification task; plan preparation never executes it.

- [ ] **Step 4: Run, expect PASS and review the result.** `bash scripts/verify-alerting-consolidation-w05c2.sh`. Expected: all typechecks and targeted suites pass, docs build produces both redirect artifacts, live tenant/cascade/export proofs pass, test stack is torn down, `git diff --check` exits 0. Review the final change list with `git diff --stat` and `git status --short`; no migration, credentials, internal hosts or unrelated edits.

  Verify these actual browser/API scenarios against the implementation checkout using an authorized test account: a >500-device preview reports progress and cannot confirm stale results; an empty blocked preview still names its prerequisite; conversion updates pending counts and persistent history; retirement creates a zero-output ledger entry; unavailable Undo stays disabled; partner confirmation displays full-scope refusals and sends its preview hash; empty replacement saves retain suppression; composite/restart edits round-trip; the library attaches undeployed built-ins; Alert workflows saves and reloads both filters and retains `ruleId`; a device in a forbidden site cannot be read or reset; a latched accessible device resets with feedback; both retired settings URLs return 301; a Fleet apply creates only `monitors` links and a second apply creates no duplicate definitions. Record actual command outcomes and any blocker in the PR description, never pre-fill “PASS” from this plan. These observations supplement, rather than replace, the executable tests above.

  W05c2 owns no migrations. Before pushing the program's migration PRs, run `git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | grep -E '^apps/api/migrations/[0-9]{4}-[^/]+\.sql$' | sort | tail -1` and `scripts/check-migration-naming.sh --against-ref origin/main` and preserve the brief's assigned ordering; do not rename a shipped W05b/W05c1 migration from this wave. PR branches use the project's `feat/` or `fix/` patterns, and each PR targets `main` with its own checks.

- [ ] **Step 5: Commit.** `git add scripts/verify-alerting-consolidation-w05c2.sh apps/web/src/lib/__tests__/alertingVerification.test.ts && git commit -m "test(alerting): verify conversion progress and web tools integration"`

---

## Open questions

None. D1–D19 settle the reviewed questions; their applicable resolutions are incorporated in the tasks.
