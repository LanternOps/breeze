---
tracking_issue: LanternOps/breeze#5988
---
# Network Device Page Truth W05: Web Page IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/devices/network/:id` so every status claim on it names its source and its age: a reachability badge and stat strip fed by W01's `reachability`, an approval banner that acts instead of decorating, a type-dispatched Health card (printer supplies, page counts, decoded printer status) beside a Reachability & collection card, a condensed Identity block with copy buttons and an "All scan details" disclosure, and a Monitoring tab that shows per-OID collection state, history charts and the checks/thresholds that are actually armed.

**Architecture:** The page keeps its thin-shell shape: `NetworkDeviceDetailPage.tsx` owns tab/hash state and composes modules from `networkDevice/`. All new copy funnels through one pure formatter (`reachabilityCopy.ts`) so the `<state> · <source> <relative time>` rule cannot drift between the header, the strip and the cards. Three data hooks sit beside the existing `useNetworkAsset`: `useAssetProbe` (the only new mutation), `useAssetMonitoring` (collection + checks + thresholds), `useAssetMetrics` (history series). The Health card is a registry lookup on `DiscoveredAssetType` with every printer rule extracted into a pure `printerMib.ts` so the decoding tables are unit-testable without rendering. All writes that own the asset (Approve, Dismiss, anything in the settings modal) go through W04's `useNetworkAssetMutations` — W05 adds no second writer.

**Tech Stack:** Astro + React islands, react-i18next, Tailwind theme tokens, recharts via the shared `ChartWidget`, Vitest + jsdom + Testing Library, Playwright (`data-testid` only). Two small API additions in `apps/api` (Hono + Drizzle) carry the site timezone and the armed SNMP thresholds.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md` (approved 2026-09-16). This wave ships **§11 in full** plus **D9 (§2)**, the §14 probe error lines, the §15 web + E2E test items, and the two read-side API fields those need. §4.2 (`Reachability`), §5 (`probe`), §6.2 (`collection`) and §6.3 (`/metrics`) are consumed as shipped by W01; §10's modal, hash helpers and mutation module are consumed as shipped by W04.

**Depends on:** W01 (merged) and W04 (merged). Branch off `main` after both have landed.

## Global Constraints

- **Copy rule (§10, §11): no bare "Online".** Every status string on this page is `<state> · <source> <relative time>`, produced by `formatReachability` / `formatCollectionSummary` in `networkDevice/reachabilityCopy.ts`. A component that concatenates its own status sentence is a bug; the `reachabilityCopy.test.ts` cases are the contract.
- **No per-type tabs** (D8). Type variation lives *inside* the Health card registry and the stat strip's type slot. The tab set stays `overview | monitoring`.
- **Every mutating `fetchWithAuth` goes through `runAction`** (`apps/web/src/lib/runAction.ts`). W05 introduces exactly one new mutation (`POST /discovery/assets/:id/probe`, in `useAssetProbe.ts`); Approve/Dismiss reuse W04's `useNetworkAssetMutations`. Caller catch pattern:
  ```ts
  } catch (err) {
    // runAction already toasted every non-401 ActionError; a 401 belongs to the
    // auth redirect, and anything that is not an ActionError never got a toast.
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) {
      showToast({ type: 'error', message: t('networkDeviceDetailPage.errors.unexpected') });
    }
  }
  ```
- **W04 owns every asset write.** Do not add a second module that calls `PATCH /discovery/assets/:id`, `PUT|PATCH /monitoring/assets/:id/snmp`, `DELETE /monitoring/assets/:id`, `/discovery/assets/:id/link`, `…/approve`, `…/dismiss` or `DELETE /discovery/assets/:id`. `apps/web/src/lib/__tests__/network-asset-single-writer.test.ts` fails the build if you do.
- **i18n: every new key in all 8 locales** (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) with **real translations**, not English copies. `apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English duplicates per namespace; do not raise the `devices.json` baselines to paper over an untranslated string.
- **Run one web test file:** `cd apps/web && npx vitest run <path>`. Never `pnpm --filter @breeze/web test -- --run <path>` (the `--` is forwarded verbatim and the whole suite runs in watch mode). A trailing-slash path filter silently skips dotted siblings — list files explicitly.
- **Typecheck:** `cd apps/web && pnpm exec astro check` (there is no `typecheck` script in `apps/web/package.json`; this is exactly what CI's `typecheck` job runs). For the two API edits: `pnpm exec tsc --noEmit --project apps/api/tsconfig.json` from the repo root.
- **File size:** keep every component under ~500 lines, **one component per file** under `apps/web/src/components/devices/networkDevice/` and `…/networkDevice/health/`. Pure logic (decoding tables, grouping, copy) lives in its own `.ts` beside the component that uses it, never inline in TSX.
- **`data-testid` on every new interactive element** (buttons, links-as-buttons, selects, disclosures, tab-like controls) and on every card/section/empty/error state the E2E spec asserts. Naming: `<domain>-<element>[-<modifier>]`, kebab-case — this page's domain prefix is `network-detail-`.
- **Charts** (`dataviz`): one measure per chart, never a dual axis; series colors come from CSS theme tokens (`hsl(var(--primary))`, `hsl(var(--info))`), assigned in fixed order and never cycled; a single-series chart gets no legend box (the title names it); the tooltip is the default `ChartWidget` crosshair tooltip, and every numeric value also appears as text somewhere (meter labels, OID table) so nothing is conveyed by color alone. Supply meters are **not** charts — they are labelled bars with the percentage written out, and a low supply carries the word "Low" beside the warning token, never the color alone.
- **Branch / PR / commit:** branch `feature/<parent#>-network-device-page-truth/wave-<W05 sub-issue#>`; PR body contains `Closes #<W05 sub-issue#>`. Because this branch stacks on W04, it gets **no** `pull_request` CI run until W04 merges — run `gh workflow run CI --ref <branch>` before enqueueing. Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/routes/discovery.ts` | `GET /discovery/assets/:id` also selects and returns `siteTimezone` (the `sites` left join already exists) |
| `apps/api/src/routes/monitoring.ts` | new read-only `GET /monitoring/assets/:id/thresholds` |
| `apps/api/src/routes/monitoring_assets_thresholds.test.ts` | route test for the above (happy path, 404, cross-org, site denial) |
| `apps/web/src/components/devices/networkDevice/types.ts` | `Reachability`, `AssetProbe`, `Collection*` types; `NetworkAssetExtras` gains `siteTimezone`, `nicVendor`, `reachability`, `probe` |
| `…/networkDevice/useNetworkAsset.ts` | passes the four new fields through to `extras` |
| `…/networkDevice/reachabilityCopy.ts` (+ `.test.ts`) | `formatReachability`, `formatCollectionSummary`, `resolveAssetTimezone`, `formatAbsolute`, tone lookup |
| `…/networkDevice/format.ts` | `formatTimestamp(value, timezone?)` — no seconds, timezone-aware |
| `…/networkDevice/ApprovalBanner.tsx` (+ `.test.tsx`) | pending/dismissed action banner (Approve · Dismiss) |
| `…/networkDevice/NetworkDeviceHeader.tsx` | restyle: reachability badge, `·` separators, Settings button, approval badge hidden when approved |
| `…/networkDevice/NetworkDeviceStats.tsx` (+ `.test.tsx`) | Reachability · Last poll · type slot · Open ports |
| `…/networkDevice/useAssetProbe.ts` (+ `.test.ts`) | Check-now POST, pending polling, inline error codes |
| `…/networkDevice/ReachabilityCard.tsx` (+ `.test.tsx`) | D1 detail lines, collection summary, Check now, bridging agent |
| `…/networkDevice/CopyButton.tsx` (+ `.test.tsx`) | icon button that copies a value and announces it |
| `…/networkDevice/IdentityCard.tsx` (+ `.test.tsx`) | condensed identity + `nicVendor` + "Same device as" + "All scan details" disclosure |
| `…/networkDevice/health/types.ts` | `HealthCardProps`, `HealthCardComponent` |
| `…/networkDevice/health/index.ts` (+ `index.test.ts`) | `resolveHealthCard` registry |
| `…/networkDevice/health/EmptyHealth.tsx` | the "Set up monitoring" affordance |
| `…/networkDevice/health/GenericHealth.tsx` (+ `.test.tsx`) | the template's key OIDs as a compact table |
| `…/networkDevice/health/printerMib.ts` (+ `.test.ts`) | pure Printer-MIB decoding: supplies grouping, status words, error bitmask, page count |
| `…/networkDevice/health/printerMib.fixtures.ts` | the Xerox C325 `Collection` fixture shared by the decoder and card suites |
| `…/networkDevice/health/PrinterHealth.tsx` (+ `.test.tsx`) | supply meters, page count + deltas, status words |
| `…/networkDevice/useAssetMonitoring.ts` (+ `.test.ts`) | collection + snmpDevice + checks + thresholds |
| `…/networkDevice/useAssetMetrics.ts` (+ `.test.ts`) | `/metrics` series with range → bucket mapping |
| `…/networkDevice/PollConfigSummary.tsx` | poll configuration summary + Edit (opens W04 modal via hash) |
| `…/networkDevice/OidTable.tsx` (+ `.test.tsx`) | name / base OID / mode / state / latest / age, expandable instances |
| `…/networkDevice/MetricHistoryCharts.tsx` (+ `.test.tsx`) | OID picker, 24h/7d/30d toggle, `ChartWidget` per OID |
| `…/networkDevice/NetworkChecksSection.tsx` | network checks with their latest results |
| `…/networkDevice/ThresholdAlertsSection.tsx` | armed SNMP threshold alerts |
| `…/networkDevice/MonitoringTab.tsx` | composes the five monitoring sections |
| `apps/web/src/components/devices/networkDevice/primitives.tsx` | `Section` gains an optional focus `sectionRef`; new `UnknownValue` placeholder |
| `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` | rewired shell: banner, header, strip, overview rows, monitoring tab |
| `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx` | updated for the new header/strip copy |
| `apps/web/src/components/shared/OverflowTabs.tsx` | overflow-menu tab button gains its `id` so `aria-labelledby` resolves (Task 11); the "More" trigger gains a `data-testid` (Task 13) |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | `useAssetProbe.ts` joins `TARGET_GLOBS`; count 133 → 134 |
| `apps/web/src/locales/*/devices.json` | `networkDeviceDetailPage.*` keys in 8 locales |
| `apps/web/src/components/devices/NetworkDeviceDetailPage.a11y.test.tsx` | tabpanel labelling, focus moves, labelled placeholders |
| `e2e-tests/pages/NetworkDevicePage.ts` | page object |
| `e2e-tests/tests/network-device-truth.spec.ts` | Check now, reachability copy, printer Health card |

---

### Task 1: Asset payload types, the site timezone field, and the `useNetworkAsset` passthrough

The page has no timezone source today — `NetworkDeviceStats` hardcodes `Intl.DateTimeFormat().resolvedOptions().timeZone` with a comment saying no site timezone is threaded in. `sites.timezone` exists (`apps/api/src/db/schema/orgs.ts:240`, `varchar(50) NOT NULL DEFAULT 'UTC'`) and `GET /discovery/assets/:id` **already left-joins `sites`** for `siteName`, so this is one extra selected column and one extra response field — no new route, no new join.

**Files:**
- Modify: `apps/api/src/routes/discovery.ts` (the `GET /assets/:id` select ~`:1221` and its response object ~`:1252`)
- Modify: `apps/web/src/components/devices/networkDevice/types.ts`
- Modify: `apps/web/src/components/devices/networkDevice/useNetworkAsset.ts`
- Modify: `apps/web/src/components/devices/networkDevice/useNetworkAsset.test.ts`

**Interfaces:**
```ts
// apps/web/src/components/devices/networkDevice/types.ts — additions
export type ReachabilityState = 'responding' | 'not_responding' | 'unverified';
export type ReachabilitySource = 'network_check' | 'probe' | 'scan' | 'unifi' | 'snmp';

export type Reachability = {
  state: ReachabilityState;
  source: ReachabilitySource | null;
  observedAt: string | null;
  lastKnown: { state: 'responding' | 'not_responding'; source: ReachabilitySource; observedAt: string } | null;
  detail: {
    networkCheck?: { state: 'online' | 'degraded' | 'offline'; observedAt: string; responseMs: number | null; monitorId: string };
    probe?: { state: 'ok' | 'failed' | 'pending'; observedAt: string | null; responseMs: number | null };
    snmp?: { state: 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled'; observedAt: string | null; consecutiveFailures: number };
    scan?: { state: 'seen' | 'missed'; observedAt: string | null; source: 'scan' | 'unifi' };
  };
};

export type AssetProbe = {
  state: 'ok' | 'failed' | 'pending';
  responseMs: number | null;
  observedAt: string | null;
  agentId?: string | null;
};

export type CollectionOidState = 'collecting' | 'unsupported' | 'stale' | 'never_polled' | 'unknown';
export type CollectionOidInstance = { oid: string; instance: string; value: string | null; valueType: string; observedAt: string };
export type CollectionOid = {
  baseOid: string;
  name: string;
  mode: 'get' | 'walk';
  cadence: 'fast' | 'slow';
  state: CollectionOidState;
  observedAt: string | null;
  instances: CollectionOidInstance[];
  error: string | null;
};
export type Collection = {
  templateId: string | null;
  lastPolledAt: string | null;
  pollingInterval: number | null;
  status: 'ok' | 'failing' | 'no_template' | 'no_agent' | 'asset_moved' | 'never_polled' | 'paused';
  consecutiveFailures: number;
  oids: CollectionOid[];
};

// NetworkAssetExtras gains:
//   siteTimezone?: string | null;
//   nicVendor?: string | null;
//   reachability?: Reachability | null;
//   probe?: AssetProbe | null;
```

- [ ] **Step 1: Red — the hook must surface the four new fields**

Append to `apps/web/src/components/devices/networkDevice/useNetworkAsset.test.ts`:

```ts
  it('surfaces reachability, probe, nicVendor and siteTimezone on extras', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          data: {
            ...baseAsset,
            siteTimezone: 'America/Chicago',
            nicVendor: 'LEXMARK INTERNATIONAL, INC.',
            reachability: {
              state: 'responding',
              source: 'snmp',
              observedAt: '2026-09-16T10:00:00.000Z',
              lastKnown: null,
              detail: { snmp: { state: 'ok', observedAt: '2026-09-16T10:00:00.000Z', consecutiveFailures: 0 } },
            },
            probe: { state: 'ok', responseMs: 3.2, observedAt: '2026-09-16T09:59:00.000Z' },
          },
        }),
      )
      .mockResolvedValue(makeJsonResponse({ data: [] }));

    const { result } = renderHook(() => useNetworkAsset(ASSET_ID));

    await waitFor(() => expect(result.current.asset).toBeTruthy());
    expect(result.current.extras.siteTimezone).toBe('America/Chicago');
    expect(result.current.extras.nicVendor).toBe('LEXMARK INTERNATIONAL, INC.');
    expect(result.current.extras.reachability?.state).toBe('responding');
    expect(result.current.extras.reachability?.source).toBe('snmp');
    expect(result.current.extras.probe?.responseMs).toBe(3.2);
  });

  it('leaves the four new fields null when the API omits them (W01 not yet deployed)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ data: baseAsset }))
      .mockResolvedValue(makeJsonResponse({ data: [] }));

    const { result } = renderHook(() => useNetworkAsset(ASSET_ID));

    await waitFor(() => expect(result.current.asset).toBeTruthy());
    expect(result.current.extras.siteTimezone).toBeNull();
    expect(result.current.extras.reachability).toBeNull();
    expect(result.current.extras.probe).toBeNull();
    expect(result.current.extras.nicVendor).toBeNull();
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/useNetworkAsset.test.ts
```
Expected: both new cases fail — `expected undefined to be 'America/Chicago'` and `expected undefined to be null`. (`undefined` is not `null`: the second case is not vacuous.)

- [ ] **Step 3: Add the types**

In `apps/web/src/components/devices/networkDevice/types.ts`, paste the block from **Interfaces** above the existing `NetworkAssetExtras`, then extend that type:

```ts
export type NetworkAssetExtras = {
  model?: string | null;
  netbiosName?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  // The site's IANA zone (`sites.timezone`, always set, defaults to 'UTC').
  // Null only for a site-less asset or an API that predates W05 — the page
  // falls back to the browser zone via `resolveAssetTimezone`.
  siteTimezone?: string | null;
  firstSeenAt?: string | null;
  snmpMonitoringEnabled?: boolean;
  networkMonitoringEnabled?: boolean;
  suggestedBridgeDeviceId?: string | null;
  autoLinkSuppressedAt?: string | null;
  // W01 (spec §4.2, §5, §9). Null on a pre-W01 API, which is why every
  // consumer takes `Reachability | null` rather than assuming presence.
  reachability?: Reachability | null;
  probe?: AssetProbe | null;
  nicVendor?: string | null;
};
```

- [ ] **Step 4: Pass them through the hook**

In `useNetworkAsset.ts`'s `setExtras({ … })` call, add:

```ts
        siteTimezone: raw.siteTimezone ?? null,
        reachability: (raw as NetworkAssetExtras).reachability ?? null,
        probe: (raw as NetworkAssetExtras).probe ?? null,
        nicVendor: (raw as NetworkAssetExtras).nicVendor ?? null,
```

- [ ] **Step 5: Green**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/useNetworkAsset.test.ts
```
Expected: all cases pass.

- [ ] **Step 6: Red — the API must return `siteTimezone`**

Add to `apps/api/src/routes/discovery.test.ts`, inside the existing `describe('GET /discovery/assets/:id')` block (`:827`). It already has a `buildRow()` factory and a `mockSingleAsset()` helper for the five-`leftJoin` chain — extend `buildRow()` with the new column rather than writing a second mock:

```ts
    // In buildRow()'s returned object, beside `siteName`:
        siteTimezone: 'America/Chicago' as string | null,
```

```ts
    it('returns the site timezone alongside the site name', async () => {
      mockSingleAsset([buildRow()]);

      const res = await app.request(`/discovery/assets/${ASSET_ID}`, {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.siteTimezone).toBe('America/Chicago');
    });

    it('returns a null site timezone when the asset has no site', async () => {
      const row = buildRow();
      row.siteId = null as unknown as string;
      row.siteName = null;
      row.siteTimezone = null;
      mockSingleAsset([row]);

      const res = await app.request(`/discovery/assets/${ASSET_ID}`, {
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Null, not the string 'UTC': a site-less asset has no site zone, and
      // the page falls back to the browser's rather than guessing UTC.
      expect(body.data.siteTimezone).toBeNull();
    });
```

- [ ] **Step 7: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/discovery.test.ts
```
Expected: `expected undefined to be 'America/Chicago'`.

- [ ] **Step 8: Add the column to the select and the response**

In `apps/api/src/routes/discovery.ts`, in the `GET /assets/:id` select object, directly after `siteName: sites.name,`:

```ts
        // The site's IANA zone. The page formats every absolute timestamp in
        // it (spec §11 Formatting); `sites` is already left-joined for the
        // name, so this costs one more column and no extra query.
        siteTimezone: sites.timezone,
```

and in the response object, directly after `siteName: row.siteName ?? null,`:

```ts
        siteTimezone: row.siteTimezone ?? null,
```

- [ ] **Step 9: Green + typecheck**

```bash
cd apps/api && npx vitest run src/routes/discovery.test.ts
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c && pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts \
        apps/web/src/components/devices/networkDevice/types.ts \
        apps/web/src/components/devices/networkDevice/useNetworkAsset.ts \
        apps/web/src/components/devices/networkDevice/useNetworkAsset.test.ts
git commit -m "$(cat <<'EOF'
feat(web/network-device): thread reachability, probe, nicVendor and site timezone onto the asset page

Adds the W01 read-side fields to the page's local asset types and passes them
through useNetworkAsset. GET /discovery/assets/:id also returns siteTimezone —
the sites left join already existed for siteName, so this is one column, and it
is what lets the page format absolute timestamps in the site's zone instead of
the technician's browser zone (spec §11 Formatting).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `reachabilityCopy.ts` — the one place status copy is built

Every status sentence on this page is built here so the `<state> · <source> <relative time>` rule has exactly one implementation. `formatTimestamp` also loses seconds and gains a timezone parameter in this task (spec §11: "First seen" drops seconds; every relative time carries an absolute `title`).

**Decision (stated here because the spec leaves it open):** there is **one** set of source labels, sentence-cased (`Network check`, `Probe`, `Scan`, `UniFi`, `SNMP`), reused in both the primary line and the `lastSeenBy` phrase. English therefore renders `Unverified · last seen by Scan 19 hr ago`. A second lowercase set would double the key count in 8 locales for a capital letter; German capitalises the nouns anyway.

**Decision:** `formatTimestamp` drops seconds for *all* callers on this page, not only "First seen" — a page where some absolute stamps carry seconds and others don't reads as a bug, and seconds carry no information at scan/poll cadences.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/reachabilityCopy.ts`
- Create: `apps/web/src/components/devices/networkDevice/reachabilityCopy.test.ts`
- Modify: `apps/web/src/components/devices/networkDevice/format.ts`

**Interfaces:**
```ts
export type TFn = (key: string, options?: Record<string, unknown>) => string;
export type ReachabilityTone = 'success' | 'destructive' | 'muted';
export type ReachabilityCopy = {
  /** `<state> · <source> <relative>` — never a bare state word. */
  label: string;
  /** Absolute stamp for the `title` attribute; '' when nothing was observed. */
  title: string;
  tone: ReachabilityTone;
  /** ISO stamp the relative part was computed from, or null. */
  observedAt: string | null;
};

export function resolveAssetTimezone(siteTimezone?: string | null): string;
export function formatAbsolute(value: string | null | undefined, timezone: string): string;
export function reachabilitySourceKey(source: ReachabilitySource): string;
export function reachabilityToneFor(state: ReachabilityState): ReachabilityTone;
export function formatReachability(r: Reachability | null | undefined, t: TFn, timezone: string): ReachabilityCopy;
export function formatCollectionSummary(collection: Collection | null | undefined, t: TFn): string | null;
export function formatLastPoll(collection: Collection | null | undefined, t: TFn, timezone: string): ReachabilityCopy;
```

- [ ] **Step 1: Red — write the copy contract**

Create `apps/web/src/components/devices/networkDevice/reachabilityCopy.test.ts`:

```ts
import '@/lib/i18n';

import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import {
  formatCollectionSummary,
  formatLastPoll,
  formatReachability,
  resolveAssetTimezone,
} from './reachabilityCopy';
import type { Collection, Reachability } from './types';

const t = ((key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ns: 'devices', ...options })) as (k: string, o?: Record<string, unknown>) => string;

const TZ = 'UTC';
const now = () => new Date();
const minutesAgo = (n: number) => new Date(now().getTime() - n * 60_000).toISOString();
const hoursAgo = (n: number) => new Date(now().getTime() - n * 3_600_000).toISOString();

describe('formatReachability', () => {
  it('names the state, the source and the age — never a bare state word', () => {
    const r: Reachability = {
      state: 'responding',
      source: 'snmp',
      observedAt: minutesAgo(2),
      lastKnown: null,
      detail: { snmp: { state: 'ok', observedAt: minutesAgo(2), consecutiveFailures: 0 } },
    };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Responding');
    expect(copy.label).toContain('·');
    expect(copy.label).toContain('SNMP');
    expect(copy.label).toMatch(/2\s*min/);
    expect(copy.tone).toBe('success');
    // The absolute title must be a real stamp, not the ISO string echoed back.
    expect(copy.title).not.toBe(r.observedAt);
    expect(copy.title.length).toBeGreaterThan(0);
  });

  it('reads not_responding from the negative host observation', () => {
    const r: Reachability = {
      state: 'not_responding',
      source: 'network_check',
      observedAt: minutesAgo(1),
      lastKnown: null,
      detail: {
        networkCheck: { state: 'offline', observedAt: minutesAgo(1), responseMs: null, monitorId: 'm1' },
      },
    };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Not responding');
    expect(copy.label).toContain('Network check');
    expect(copy.tone).toBe('destructive');
  });

  it('falls back to lastKnown when nothing is inside its freshness window', () => {
    const r: Reachability = {
      state: 'unverified',
      source: null,
      observedAt: null,
      lastKnown: { state: 'responding', source: 'scan', observedAt: hoursAgo(19) },
      detail: {},
    };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Unverified');
    expect(copy.label).toContain('last seen by');
    expect(copy.label).toContain('Scan');
    expect(copy.label).toMatch(/19\s*hr/);
    expect(copy.tone).toBe('muted');
  });

  it('says "never observed" when unverified with no observation at all', () => {
    const r: Reachability = { state: 'unverified', source: null, observedAt: null, lastKnown: null, detail: {} };
    const copy = formatReachability(r, t, TZ);
    expect(copy.label).toContain('Unverified');
    expect(copy.label).toContain('never observed');
    expect(copy.title).toBe('');
  });

  it('degrades to Unverified when the API sent no reachability at all', () => {
    const copy = formatReachability(null, t, TZ);
    expect(copy.label).toContain('Unverified');
    expect(copy.tone).toBe('muted');
    expect(copy.observedAt).toBeNull();
  });
});

describe('formatCollectionSummary', () => {
  const oid = (state: Collection['oids'][number]['state'], name: string) => ({
    baseOid: `1.3.6.1.2.1.${name.length}`,
    name,
    mode: 'walk' as const,
    cadence: 'fast' as const,
    state,
    observedAt: minutesAgo(3),
    instances: [],
    error: null,
  });

  it('counts collecting / unsupported / stale', () => {
    const collection: Collection = {
      templateId: 'tpl-1',
      lastPolledAt: minutesAgo(3),
      pollingInterval: 300,
      status: 'ok',
      consecutiveFailures: 0,
      oids: [oid('collecting', 'a'), oid('collecting', 'bb'), oid('unsupported', 'ccc'), oid('stale', 'dddd')],
    };
    const summary = formatCollectionSummary(collection, t)!;
    expect(summary).toContain('2');
    expect(summary).toContain('collecting');
    expect(summary).toContain('1');
    expect(summary).toContain('unsupported');
    expect(summary).toContain('stale');
  });

  it('returns null when there is no SNMP device to summarise', () => {
    expect(formatCollectionSummary(null, t)).toBeNull();
  });
});

describe('formatLastPoll', () => {
  it('states no_template as a cause, not as a bare failure', () => {
    const collection: Collection = {
      templateId: null,
      lastPolledAt: null,
      pollingInterval: 300,
      status: 'no_template',
      consecutiveFailures: 0,
      oids: [],
    };
    const copy = formatLastPoll(collection, t, TZ);
    expect(copy.label).toContain('No template');
    expect(copy.tone).toBe('destructive');
  });

  it('pairs an OK poll with its age', () => {
    const collection: Collection = {
      templateId: 'tpl-1',
      lastPolledAt: minutesAgo(4),
      pollingInterval: 300,
      status: 'ok',
      consecutiveFailures: 0,
      oids: [],
    };
    const copy = formatLastPoll(collection, t, TZ);
    expect(copy.label).toMatch(/4\s*min/);
    expect(copy.tone).toBe('success');
  });
});

describe('resolveAssetTimezone', () => {
  it('prefers the site zone', () => {
    expect(resolveAssetTimezone('America/Chicago')).toBe('America/Chicago');
  });

  it('falls back to the browser zone when the asset has no site', () => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(resolveAssetTimezone(null)).toBe(browserZone);
    expect(resolveAssetTimezone('')).toBe(browserZone);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/reachabilityCopy.test.ts
```
Expected: `Failed to resolve import "./reachabilityCopy"`.

- [ ] **Step 3: Implement `reachabilityCopy.ts`**

```ts
// Every status sentence on the network device page is built here. The spec's
// copy rule (§10, §11) is "no bare Online": each status string is
// `<state> · <source> <relative time>`. Keeping the assembly in one pure module
// is what stops the header badge, the stat strip and the two overview cards
// from drifting into three different phrasings of the same fact.

import { formatLastSeen } from '@/lib/formatTime';
import { formatTimestamp } from './format';
import type {
  Collection,
  Reachability,
  ReachabilitySource,
  ReachabilityState,
} from './types';

export type TFn = (key: string, options?: Record<string, unknown>) => string;
export type ReachabilityTone = 'success' | 'destructive' | 'muted';

export type ReachabilityCopy = {
  label: string;
  title: string;
  tone: ReachabilityTone;
  observedAt: string | null;
};

const SOURCE_KEYS: Record<ReachabilitySource, string> = {
  network_check: 'networkDeviceDetailPage.reachability.source.networkCheck',
  probe: 'networkDeviceDetailPage.reachability.source.probe',
  scan: 'networkDeviceDetailPage.reachability.source.scan',
  unifi: 'networkDeviceDetailPage.reachability.source.unifi',
  snmp: 'networkDeviceDetailPage.reachability.source.snmp',
};

const STATE_KEYS: Record<ReachabilityState, string> = {
  responding: 'networkDeviceDetailPage.reachability.state.responding',
  not_responding: 'networkDeviceDetailPage.reachability.state.notResponding',
  unverified: 'networkDeviceDetailPage.reachability.state.unverified',
};

const COLLECTION_STATUS_KEYS: Record<Collection['status'], string> = {
  ok: 'networkDeviceDetailPage.collection.status.ok',
  failing: 'networkDeviceDetailPage.collection.status.failing',
  no_template: 'networkDeviceDetailPage.collection.status.noTemplate',
  no_agent: 'networkDeviceDetailPage.collection.status.noAgent',
  asset_moved: 'networkDeviceDetailPage.collection.status.assetMoved',
  never_polled: 'networkDeviceDetailPage.collection.status.neverPolled',
  paused: 'networkDeviceDetailPage.collection.status.paused',
};

export function reachabilitySourceKey(source: ReachabilitySource): string {
  return SOURCE_KEYS[source];
}

export function reachabilityToneFor(state: ReachabilityState): ReachabilityTone {
  if (state === 'responding') return 'success';
  if (state === 'not_responding') return 'destructive';
  return 'muted';
}

/**
 * The site's IANA zone when the asset has a site, else the browser's.
 *
 * `sites.timezone` is NOT NULL with a 'UTC' default, so a site-bound asset
 * always has one; null/'' means a site-less (manual) asset or a pre-W05 API.
 * Mirrors `DeviceDetails.tsx`'s `effectiveTimezone` fallback exactly.
 */
export function resolveAssetTimezone(siteTimezone?: string | null): string {
  if (typeof siteTimezone === 'string' && siteTimezone.trim() !== '') return siteTimezone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Absolute stamp for a `title` attribute; '' (never '—') when there is nothing to stamp. */
export function formatAbsolute(value: string | null | undefined, timezone: string): string {
  if (!value) return '';
  const formatted = formatTimestamp(value, timezone);
  return formatted === '—' ? '' : formatted;
}

export function formatReachability(
  r: Reachability | null | undefined,
  t: TFn,
  timezone: string,
): ReachabilityCopy {
  // A pre-W01 API (or a route that forgot the field) must not render as
  // "Offline" — an absent verdict is unverified, which is the honest word.
  if (!r) {
    return {
      label: `${t(STATE_KEYS.unverified)} · ${t('networkDeviceDetailPage.reachability.neverObserved')}`,
      title: '',
      tone: 'muted',
      observedAt: null,
    };
  }

  const stateLabel = t(STATE_KEYS[r.state] ?? STATE_KEYS.unverified);

  if (r.state === 'unverified') {
    if (r.lastKnown) {
      return {
        label: `${stateLabel} · ${t('networkDeviceDetailPage.reachability.lastSeenBy', {
          source: t(/* i18n-dynamic */ reachabilitySourceKey(r.lastKnown.source)),
          relative: formatLastSeen(r.lastKnown.observedAt, timezone),
        })}`,
        title: formatAbsolute(r.lastKnown.observedAt, timezone),
        tone: 'muted',
        observedAt: r.lastKnown.observedAt,
      };
    }
    return {
      label: `${stateLabel} · ${t('networkDeviceDetailPage.reachability.neverObserved')}`,
      title: '',
      tone: 'muted',
      observedAt: null,
    };
  }

  const sourceLabel = r.source
    ? t(/* i18n-dynamic */ reachabilitySourceKey(r.source))
    : t('common:states.unknown');
  const relative = r.observedAt
    ? formatLastSeen(r.observedAt, timezone)
    : t('networkDeviceDetailPage.reachability.neverObserved');

  return {
    label: `${stateLabel} · ${sourceLabel} ${relative}`,
    title: formatAbsolute(r.observedAt, timezone),
    tone: reachabilityToneFor(r.state),
    observedAt: r.observedAt,
  };
}

/** "3 collecting · 1 unsupported · 1 stale" — null when there is no SNMP device. */
export function formatCollectionSummary(
  collection: Collection | null | undefined,
  t: TFn,
): string | null {
  if (!collection) return null;
  const counts = { collecting: 0, unsupported: 0, stale: 0, never_polled: 0, unknown: 0 };
  for (const oid of collection.oids) counts[oid.state] += 1;

  const parts: string[] = [];
  if (counts.collecting > 0) parts.push(t('networkDeviceDetailPage.collection.count.collecting', { count: counts.collecting }));
  if (counts.unsupported > 0) parts.push(t('networkDeviceDetailPage.collection.count.unsupported', { count: counts.unsupported }));
  if (counts.stale > 0) parts.push(t('networkDeviceDetailPage.collection.count.stale', { count: counts.stale }));
  if (counts.unknown > 0) parts.push(t('networkDeviceDetailPage.collection.count.unknown', { count: counts.unknown }));
  if (counts.never_polled > 0) parts.push(t('networkDeviceDetailPage.collection.count.neverPolled', { count: counts.never_polled }));

  if (parts.length === 0) return t('networkDeviceDetailPage.collection.count.noOids');
  return parts.join(' · ');
}

/** The stat strip's "Last poll" cell: a status word paired with its age or its cause. */
export function formatLastPoll(
  collection: Collection | null | undefined,
  t: TFn,
  timezone: string,
): ReachabilityCopy {
  if (!collection) {
    return {
      label: t('networkDeviceDetailPage.collection.status.notConfigured'),
      title: '',
      tone: 'muted',
      observedAt: null,
    };
  }

  const statusLabel = t(/* i18n-dynamic */ COLLECTION_STATUS_KEYS[collection.status]
    ?? COLLECTION_STATUS_KEYS.never_polled);

  // A cause (no template / no agent / moved) is the whole answer — pairing it
  // with "12 hr ago" would suggest something was actually polled 12 hours ago.
  if (collection.status === 'no_template' || collection.status === 'no_agent' || collection.status === 'asset_moved') {
    return { label: statusLabel, title: '', tone: 'destructive', observedAt: null };
  }
  if (collection.status === 'never_polled' || !collection.lastPolledAt) {
    return { label: statusLabel, title: '', tone: 'muted', observedAt: null };
  }

  const tone: ReachabilityTone =
    collection.status === 'ok' ? 'success' : collection.status === 'paused' ? 'muted' : 'destructive';

  return {
    label: `${statusLabel} · ${formatLastSeen(collection.lastPolledAt, timezone)}`,
    title: formatAbsolute(collection.lastPolledAt, timezone),
    tone,
    observedAt: collection.lastPolledAt,
  };
}
```

- [ ] **Step 4: Make `formatTimestamp` timezone-aware and secondless**

Replace `formatTimestamp` in `apps/web/src/components/devices/networkDevice/format.ts`:

```ts
// Absolute stamps on this page never carry seconds: "First seen" explicitly
// drops them (spec §11 Formatting), and a page where some stamps show seconds
// and others don't reads as a bug. Seconds also carry no information at
// scan/poll cadences. `timeZone` is the site's zone when the asset has a site
// (see `resolveAssetTimezone`), else the browser's.
const ABSOLUTE_STAMP_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

export function formatTimestamp(value?: string | null, timezone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(
    date,
    timezone ? { ...ABSOLUTE_STAMP_OPTIONS, timeZone: timezone } : ABSOLUTE_STAMP_OPTIONS,
  );
}
```

- [ ] **Step 5: Add the locale keys (English only for now; Task 12 does the other seven)**

In `apps/web/src/locales/en/devices.json` under `networkDeviceDetailPage`:

```json
  "reachability": {
    "state": {
      "responding": "Responding",
      "notResponding": "Not responding",
      "unverified": "Unverified"
    },
    "source": {
      "networkCheck": "Network check",
      "probe": "Probe",
      "scan": "Scan",
      "unifi": "UniFi",
      "snmp": "SNMP"
    },
    "lastSeenBy": "last seen by {{source}} {{relative}}",
    "neverObserved": "never observed"
  },
  "collection": {
    "status": {
      "ok": "Polling",
      "failing": "Failing",
      "noTemplate": "No template",
      "noAgent": "No agent in site",
      "assetMoved": "Asset moved",
      "neverPolled": "Never polled",
      "paused": "Paused",
      "notConfigured": "Not configured"
    },
    "count": {
      "collecting": "{{count}} collecting",
      "unsupported": "{{count}} unsupported",
      "stale": "{{count}} stale",
      "unknown": "{{count}} unknown",
      "neverPolled": "{{count}} never polled",
      "noOids": "No OIDs in this template"
    }
  },
```

- [ ] **Step 6: Green**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/reachabilityCopy.test.ts
```
Expected: 10 passing. Then confirm nothing that formats a stamp on this page regressed:
```bash
cd apps/web && npx vitest run src/components/devices/NetworkDeviceDetailPage.test.tsx
```
(If a case asserts a stamp with seconds, update the expectation — the secondless format is the intended change, not a break.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/networkDevice/reachabilityCopy.ts \
        apps/web/src/components/devices/networkDevice/reachabilityCopy.test.ts \
        apps/web/src/components/devices/networkDevice/format.ts \
        apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): single source for reachability and collection copy

formatReachability/formatLastPoll/formatCollectionSummary are now the only
place the page builds a status sentence, so the spec's "<state> · <source>
<relative time>" rule has one implementation instead of four. formatTimestamp
takes a timezone and drops seconds.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `ApprovalBanner` + header restyle (D9, §11 Header)

D9: the approval badge is **hidden when approved** (it is always true on list-reachable pages, so it is pure chrome there); pending and dismissed render an action banner *above* the header with real actions. Unknown/out-of-enum approval status renders muted, never as dismissed — the current header falls back to `approvalStatusConfig.dismissed.color`, which mislabels an unknown value as a triage decision.

The header also gains the reachability badge (replacing the `isOnline` Wifi/WifiOff badge), `·` separators on the subtitle line, and the **Settings** button. W04 ships the Settings button; this task only restyles the row around it — if W04's button is already present, keep it and place it as described rather than adding a second one.

**Decision:** the reachability badge keeps the existing `data-testid="network-device-status"`. The element's *meaning* is unchanged (it is the page's status badge) and reusing the id keeps every existing selector working; only its text changes from `Online` to the sourced string.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/ApprovalBanner.tsx`
- Create: `apps/web/src/components/devices/networkDevice/ApprovalBanner.test.tsx`
- Modify: `apps/web/src/components/devices/networkDevice/NetworkDeviceHeader.tsx`
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` (render the banner; pass `reachability`/`timezone`)
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx`

**Interfaces:**
```ts
export type ApprovalBannerProps = {
  approvalStatus: DiscoveredAssetApprovalStatus;
  /** W04's single writer. Both resolve once the server has answered. */
  onApprove: () => Promise<void>;
  onDismiss: () => Promise<void>;
  busy: boolean;
};
export function ApprovalBanner(props: ApprovalBannerProps): JSX.Element | null;
```
`NetworkDeviceHeader` props gain: `reachability: Reachability | null`, `timezone: string`, `nicVendor: string | null`; `approvalMeta`/`approvalLabel` stay but are only rendered when `asset.approvalStatus !== 'approved'`.

- [ ] **Step 1: Red — the banner contract**

Create `apps/web/src/components/devices/networkDevice/ApprovalBanner.test.tsx`:

```ts
import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalBanner } from './ApprovalBanner';

describe('ApprovalBanner', () => {
  it('renders nothing when the asset is approved', () => {
    const { container } = render(
      <ApprovalBanner approvalStatus="approved" onApprove={vi.fn()} onDismiss={vi.fn()} busy={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('explains the consequence and offers both actions when pending', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalBanner approvalStatus="pending" onApprove={onApprove} onDismiss={onDismiss} busy={false} />,
    );

    const banner = screen.getByTestId('network-detail-approval-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner.textContent).toContain('nothing is monitored yet');

    await userEvent.click(screen.getByTestId('network-detail-approve'));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId('network-detail-dismiss'));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('offers only Approve when dismissed', () => {
    render(
      <ApprovalBanner approvalStatus="dismissed" onApprove={vi.fn()} onDismiss={vi.fn()} busy={false} />,
    );
    expect(screen.getByTestId('network-detail-approval-banner').textContent).toContain('hidden from device lists');
    expect(screen.getByTestId('network-detail-approve')).toBeInTheDocument();
    expect(screen.queryByTestId('network-detail-dismiss')).toBeNull();
  });

  it('disables both actions while a decision is in flight', () => {
    render(
      <ApprovalBanner approvalStatus="pending" onApprove={vi.fn()} onDismiss={vi.fn()} busy />,
    );
    expect(screen.getByTestId('network-detail-approve')).toBeDisabled();
    expect(screen.getByTestId('network-detail-dismiss')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/ApprovalBanner.test.tsx
```
Expected: `Failed to resolve import "./ApprovalBanner"`.

- [ ] **Step 3: Implement `ApprovalBanner.tsx`**

```tsx
// D9: the approval badge was dead chrome — always "Approved" on every page
// reachable from a list, and on the pending/dismissed assets Discovery
// deep-links it was the ONLY signal and carried no action. The badge is now
// hidden when approved (see NetworkDeviceHeader) and the two states that
// actually block monitoring get a banner that says what is not happening and
// offers the decision inline.

import { AlertTriangle, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DiscoveredAssetApprovalStatus } from '../../discovery/DiscoveredAssetList';

export function ApprovalBanner({
  approvalStatus,
  onApprove,
  onDismiss,
  busy,
}: {
  approvalStatus: DiscoveredAssetApprovalStatus;
  onApprove: () => Promise<void>;
  onDismiss: () => Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation('devices');
  if (approvalStatus !== 'pending' && approvalStatus !== 'dismissed') return null;

  const pending = approvalStatus === 'pending';
  const Icon = pending ? AlertTriangle : EyeOff;

  return (
    <div
      role="alert"
      data-testid="network-detail-approval-banner"
      className={`flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between ${
        pending
          ? 'border-warning/40 bg-warning/10 text-warning-foreground'
          : 'border-muted bg-muted/50 text-muted-foreground'
      }`}
    >
      <p className="flex items-start gap-2 text-sm">
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {pending
            ? t('networkDeviceDetailPage.approval.pendingBanner')
            : t('networkDeviceDetailPage.approval.dismissedBanner')}
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="network-detail-approve"
          disabled={busy}
          onClick={() => void onApprove()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.approval.approve')}
        </button>
        {pending && (
          <button
            type="button"
            data-testid="network-detail-dismiss"
            disabled={busy}
            onClick={() => void onDismiss()}
            className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.approval.dismiss')}
          </button>
        )}
      </div>
    </div>
  );
}
```

English keys (Task 12 translates the rest):
```json
  "approval": {
    "pendingBanner": "Pending approval: nothing is monitored yet.",
    "dismissedBanner": "Dismissed: hidden from device lists.",
    "approve": "Approve",
    "dismiss": "Dismiss"
  },
```

- [ ] **Step 4: Restyle the header**

In `NetworkDeviceHeader.tsx`: add `reachability`, `timezone` and `nicVendor` to the props; delete the `Wifi`/`WifiOff` import and the `isOnline` badge; render the approval badge only when not approved; join the subtitle line with `·`.

```tsx
  const { t } = useTranslation('devices');
  const reach = formatReachability(reachability, t as TFn, timezone);
  const TONE_CLASSES: Record<ReachabilityTone, string> = {
    success: 'bg-success/15 text-success border-success/30',
    destructive: 'bg-destructive/15 text-destructive border-destructive/30',
    muted: 'bg-muted text-muted-foreground border-muted',
  };
```
Badge (replacing the old status span):
```tsx
              <span
                data-testid="network-device-status"
                title={reach.title || undefined}
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[reach.tone]}`}
              >
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
                {reach.label}
              </span>
```
Approval badge — only when not approved, and an out-of-enum value falls back to the **muted** treatment, not `dismissed`:
```tsx
              {asset.approvalStatus !== 'approved' && (
                <span
                  data-testid="network-detail-approval-badge"
                  className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${approvalMeta?.color ?? 'bg-muted text-muted-foreground border-muted'}`}
                >
                  {approvalLabel}
                </span>
              )}
```
Subtitle line — site · IP · MAC · manufacturer, with `nicVendor` shown only when it differs:
```tsx
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {[
                siteName ? (
                  <span key="site" className="flex items-center gap-1" data-testid="network-detail-site">
                    <MapPin aria-hidden="true" className="h-3.5 w-3.5" />
                    {siteName}
                  </span>
                ) : null,
                <span key="ip" className="font-mono">{asset.ip}</span>,
                asset.mac !== '—' ? <span key="mac" className="font-mono">{asset.mac}</span> : null,
                asset.manufacturer !== '—' ? (
                  <span key="mfr" className="min-w-0 max-w-[16rem] truncate" title={asset.manufacturer}>
                    {asset.manufacturer}
                  </span>
                ) : null,
              ]
                .filter(Boolean)
                .map((node, index) => (
                  <span key={index} className="flex items-center gap-2">
                    {index > 0 && <span aria-hidden="true">·</span>}
                    {node}
                  </span>
                ))}
            </div>
```
Actions row: `ProxyConnectPopover` (primary) then W04's **Settings** button (`data-testid="network-detail-settings"`, calling the `onOpenSettings` prop W04 added). W04 has already removed the "Manage in Discovery" link and its `manageInDiscovery` key — **confirm it is gone rather than removing it again**; if it is still there, remove it here (§11 Header: the page owns the asset now).

- [ ] **Step 5: Wire the banner into the page**

In `NetworkDeviceDetailPage.tsx`, above `<Breadcrumbs>`'s sibling `<NetworkDeviceHeader>`:

```tsx
      <ApprovalBanner
        approvalStatus={asset.approvalStatus}
        busy={approvalBusy}
        onApprove={async () => {
          setApprovalBusy(true);
          try {
            await mutations.approve(asset.id);
            await fetchAsset({ background: true });
            announce(t('networkDeviceDetailPage.approval.approvedAnnouncement'));
          } finally {
            setApprovalBusy(false);
          }
        }}
        onDismiss={async () => {
          setApprovalBusy(true);
          try {
            await mutations.dismiss(asset.id);
            await fetchAsset({ background: true });
            announce(t('networkDeviceDetailPage.approval.dismissedAnnouncement'));
          } finally {
            setApprovalBusy(false);
          }
        }}
      />
```
`mutations` is `useNetworkAssetMutations()` from W04 — the **only** module allowed to call `…/approve` and `…/dismiss`. It already wraps both in `runAction`, so no toast handling belongs here; a rejection is already surfaced, and the `finally` is what clears `busy`.

- [ ] **Step 6: Update the page test**

In `NetworkDeviceDetailPage.test.tsx`, add `reachability` to `baseAsset` and replace the bare-Online assertion:

```ts
const baseReachability = {
  state: 'responding' as const,
  source: 'snmp' as const,
  observedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  lastKnown: null,
  detail: { snmp: { state: 'ok' as const, observedAt: new Date(Date.now() - 2 * 60_000).toISOString(), consecutiveFailures: 0 } },
};
```
```ts
    // The status badge names its source and its age — a bare "Online" is the
    // exact regression this wave exists to remove (spec §1 F1, §10 copy rule).
    const status = screen.getByTestId('network-device-status').textContent ?? '';
    expect(status).toContain('Responding');
    expect(status).toContain('SNMP');
    expect(status).not.toBe('Online');
```
and a new case:
```ts
  it('hides the approval badge when approved and shows the banner when pending', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, reachability: baseReachability } }),
    );
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    expect(screen.queryByTestId('network-detail-approval-badge')).toBeNull();
    expect(screen.queryByTestId('network-detail-approval-banner')).toBeNull();

    cleanup();
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { ...baseAsset, approvalStatus: 'pending', reachability: baseReachability } }),
    );
    render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
    await screen.findByTestId('network-device-detail');
    expect(screen.getByTestId('network-detail-approval-badge')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-approval-banner')).toBeInTheDocument();
  });
```

- [ ] **Step 7: Green**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/ApprovalBanner.test.tsx \
  src/components/devices/NetworkDeviceDetailPage.test.tsx
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/devices/networkDevice/ApprovalBanner.tsx \
        apps/web/src/components/devices/networkDevice/ApprovalBanner.test.tsx \
        apps/web/src/components/devices/networkDevice/NetworkDeviceHeader.tsx \
        apps/web/src/components/devices/NetworkDeviceDetailPage.tsx \
        apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx \
        apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): sourced reachability badge and an actionable approval banner

The header status badge now reads "<state> · <source> <relative time>" instead
of the scan's isOnline flag, the approval badge is hidden when approved (it was
always true on every list-reachable page), and pending/dismissed assets get a
banner that says what is not being monitored and offers Approve/Dismiss through
W04's single writer. "Manage in Discovery" is gone — the page owns the asset.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `useAssetProbe` + the rewritten stat strip

The strip becomes **Reachability · Last poll · type slot · Open ports** (§11). "Linked device" leaves the strip (it lives in Identity). "Check now" calls `POST /discovery/assets/:id/probe`; a 202 `pending` starts a 3-second re-fetch loop capped at 60 s. §14's probe errors render as **inline lines under the reachability cell**, never toast-only.

**Decisions (spec leaves these open):**
- The **type slot** is a registry on `DiscoveredAssetType`: `printer` → lowest supply ("Cyan toner 12 %"); `switch | router | firewall | access_point` → ports up / total from `ifOperStatus` instances when collected; everything else → the freshest host observation's ping. The spec's UPS case has no `DiscoveredAssetType` to key on (`ups` is not in the enum — such a device is typed `iot` or `unknown`), so UPS falls into the default ping slot until an asset type exists for it. Noted as a follow-up, not a gap in this wave.
- The poll **re-fetches the asset** (which carries `probe` and `reachability`) rather than re-POSTing — one probe per asset is the server's own rate limit (`PROBE_IN_FLIGHT`).
- `useAssetProbe.ts` is registered in `no-silent-mutations.test.ts`'s `TARGET_GLOBS` and its count assertion goes **133 → 134**. It is *not* a second asset writer: the probe reads liveness, it does not own the asset. W04's `network-asset-single-writer.test.ts` matches on **exact URL shapes**, and `/discovery/assets/*/probe` is not one of its six `GUARDED` entries, so the probe does not trip it — **verify that in Step 8 rather than assuming it**, since W04 may have widened the list by the time this wave runs.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/useAssetProbe.ts` (+ `.test.ts`)
- Rewrite: `apps/web/src/components/devices/networkDevice/NetworkDeviceStats.tsx` (+ new `.test.tsx`)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`

**Interfaces:**
```ts
export type ProbeErrorCode =
  | 'NO_AGENT_IN_SITE' | 'PROBE_IN_FLIGHT' | 'ASSET_NO_IP' | 'PROBE_TIMED_OUT' | 'UNKNOWN';

export const PROBE_POLL_INTERVAL_MS = 3_000;
export const PROBE_POLL_MAX_MS = 60_000;

export function useAssetProbe(args: {
  assetId: string;
  probe: AssetProbe | null | undefined;
  onRefresh: () => Promise<void> | void;
}): {
  checking: boolean;          // the POST itself is in flight
  pending: boolean;           // server said pending; the poll loop is running
  errorCode: ProbeErrorCode | null;
  checkNow: () => Promise<void>;
};

export type NetworkDeviceStatsProps = {
  asset: DiscoveredAsset;
  reachability: Reachability | null;
  collection: Collection | null;
  probe: AssetProbe | null;
  timezone: string;
  probeState: ReturnType<typeof useAssetProbe>;
  onViewPorts: () => void;
  onViewMonitoring: () => void;
};
```

- [ ] **Step 1: Red — the probe hook contract**

Create `apps/web/src/components/devices/networkDevice/useAssetProbe.test.ts`:

```ts
import '@/lib/i18n';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetProbe } from './useAssetProbe';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ASSET_ID = 'asset-1';

describe('useAssetProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  it('POSTs the probe and refreshes the asset on a synchronous result', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ probe: { state: 'ok', responseMs: 2.1, observedAt: 'now' } }));
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    const { result } = renderHook(() => useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh }));
    await act(async () => { await result.current.checkNow(); });

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/discovery/assets/${ASSET_ID}/probe`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.errorCode).toBeNull();
    expect(result.current.checking).toBe(false);
  });

  it('surfaces NO_AGENT_IN_SITE as an inline code, not only a toast', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(json({ code: 'NO_AGENT_IN_SITE', error: 'no agent' }, 409));
    const { result } = renderHook(() =>
      useAssetProbe({ assetId: ASSET_ID, probe: null, onRefresh: vi.fn() }),
    );
    await act(async () => { await result.current.checkNow(); });
    expect(result.current.errorCode).toBe('NO_AGENT_IN_SITE');
  });

  it('polls every 3s while the probe is pending and stops when it resolves', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const pendingProbe = { state: 'pending' as const, responseMs: null, observedAt: '2026-09-16T10:00:00.000Z' };
    const { rerender } = renderHook(
      ({ probe }) => useAssetProbe({ assetId: ASSET_ID, probe, onRefresh }),
      { initialProps: { probe: pendingProbe as { state: 'pending' | 'ok'; responseMs: number | null; observedAt: string } } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(onRefresh).toHaveBeenCalledTimes(3);

    rerender({ probe: { state: 'ok', responseMs: 4, observedAt: '2026-09-16T10:00:09.000Z' } });
    onRefresh.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('gives up after 60s of pending and reports PROBE_TIMED_OUT', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAssetProbe({
        assetId: ASSET_ID,
        probe: { state: 'pending', responseMs: null, observedAt: '2026-09-16T10:00:00.000Z' },
        onRefresh,
      }),
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(63_000); });
    await waitFor(() => expect(result.current.errorCode).toBe('PROBE_TIMED_OUT'));
    // 60_000 / 3_000 = 20 refreshes and no more.
    expect(onRefresh).toHaveBeenCalledTimes(20);
    expect(result.current.pending).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/useAssetProbe.test.ts
```
Expected: `Failed to resolve import "./useAssetProbe"`.

- [ ] **Step 3: Implement `useAssetProbe.ts`**

```ts
// "Check now" (spec §5, D2). The route waits up to 8s for the agent and then
// answers 202 `pending`; the late result is written by the command-result
// handler, so the page's job is to re-read the asset until the stamp settles.
// Every failure mode (§14) becomes an inline code the strip renders under the
// reachability cell — runAction still toasts, but a toast alone is not the
// feedback for an action whose whole point is a result line.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import type { AssetProbe } from './types';

export type ProbeErrorCode =
  | 'NO_AGENT_IN_SITE'
  | 'PROBE_IN_FLIGHT'
  | 'ASSET_NO_IP'
  | 'PROBE_TIMED_OUT'
  | 'UNKNOWN';

export const PROBE_POLL_INTERVAL_MS = 3_000;
export const PROBE_POLL_MAX_MS = 60_000;
const MAX_POLLS = PROBE_POLL_MAX_MS / PROBE_POLL_INTERVAL_MS;

const KNOWN_CODES: ProbeErrorCode[] = ['NO_AGENT_IN_SITE', 'PROBE_IN_FLIGHT', 'ASSET_NO_IP'];

function toProbeErrorCode(err: unknown): ProbeErrorCode {
  if (err instanceof ActionError) {
    const raw = err.code ?? (typeof err.body === 'object' && err.body !== null
      ? (err.body as { code?: string }).code
      : undefined);
    if (raw && (KNOWN_CODES as string[]).includes(raw)) return raw as ProbeErrorCode;
  }
  return 'UNKNOWN';
}

export function useAssetProbe({
  assetId,
  probe,
  onRefresh,
}: {
  assetId: string;
  probe: AssetProbe | null | undefined;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation('devices');
  const [checking, setChecking] = useState(false);
  const [errorCode, setErrorCode] = useState<ProbeErrorCode | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  const serverPending = probe?.state === 'pending';
  const pending = serverPending && !gaveUp;

  // Latest-ref so the interval below never re-subscribes on a new callback
  // identity (the page passes an inline `fetchAsset` wrapper).
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const checkNow = useCallback(async () => {
    setErrorCode(null);
    setGaveUp(false);
    setChecking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/assets/${assetId}/probe`, { method: 'POST' }),
        errorFallback: t('networkDeviceDetailPage.probe.errors.unknown'),
      });
    } catch (err) {
      // 401 means the session expired — runAction has already handed control
      // to the auth redirect; adding an inline error line on a page that is
      // about to navigate away is noise.
      if (err instanceof ActionError && err.status === 401) return;
      setErrorCode(toProbeErrorCode(err));
      return;
    } finally {
      setChecking(false);
    }
    await refreshRef.current();
  }, [assetId, t]);

  // Poll while the server says pending. Keyed on `probe.observedAt` so a NEW
  // probe restarts the budget instead of inheriting the previous one's ticks.
  const pollKey = serverPending ? (probe?.observedAt ?? 'pending') : null;
  useEffect(() => {
    if (pollKey === null) return;
    setGaveUp(false);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      void refreshRef.current();
      if (ticks >= MAX_POLLS) {
        clearInterval(timer);
        setGaveUp(true);
        setErrorCode('PROBE_TIMED_OUT');
      }
    }, PROBE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollKey]);

  return { checking, pending, errorCode, checkNow };
}
```

- [ ] **Step 4: Green on the hook**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/useAssetProbe.test.ts
```

- [ ] **Step 5: Red — the stat strip contract**

Create `apps/web/src/components/devices/networkDevice/NetworkDeviceStats.test.tsx`:

```ts
import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NetworkDeviceStats } from './NetworkDeviceStats';
import type { Collection, Reachability } from './types';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';

const asset = {
  id: 'a1', ip: '10.0.0.9', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'prn-01', type: 'printer',
  approvalStatus: 'approved', isOnline: true, manufacturer: 'Xerox', responseTimeMs: 3.1,
  openPorts: [{ port: 9100, service: 'jetdirect' }, { port: 443, service: 'https' }],
} as unknown as DiscoveredAsset;

const reachability: Reachability = {
  state: 'responding', source: 'snmp',
  observedAt: new Date(Date.now() - 120_000).toISOString(),
  lastKnown: null,
  detail: { snmp: { state: 'ok', observedAt: new Date(Date.now() - 120_000).toISOString(), consecutiveFailures: 0 } },
};

const AT = '2026-09-16T10:00:00.000Z';

function supplyOid(baseOid: string, name: string, rows: Array<[string, string]>) {
  return {
    baseOid,
    name,
    mode: 'walk' as const,
    cadence: 'fast' as const,
    state: 'collecting' as const,
    observedAt: AT,
    error: null,
    instances: rows.map(([instance, value]) => ({
      oid: `${baseOid}.${instance}`,
      instance,
      value,
      valueType: 'integer',
      observedAt: AT,
    })),
  };
}

const supplyCollection: Collection = {
  templateId: 'tpl',
  lastPolledAt: new Date(Date.now() - 180_000).toISOString(),
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [
    supplyOid('1.3.6.1.2.1.43.11.1.1.6', 'prtMarkerSuppliesDescription', [
      ['1.1', 'Cyan Toner'],
      ['1.2', 'Black Toner'],
    ]),
    supplyOid('1.3.6.1.2.1.43.11.1.1.8', 'prtMarkerSuppliesMaxCapacity', [
      ['1.1', '100'],
      ['1.2', '100'],
    ]),
    supplyOid('1.3.6.1.2.1.43.11.1.1.9', 'prtMarkerSuppliesLevel', [
      ['1.1', '12'],
      ['1.2', '78'],
    ]),
  ],
};

const probeState = { checking: false, pending: false, errorCode: null, checkNow: vi.fn() };

function renderStrip(overrides: Partial<Parameters<typeof NetworkDeviceStats>[0]> = {}) {
  return render(
    <NetworkDeviceStats
      asset={asset}
      reachability={reachability}
      collection={supplyCollection}
      probe={null}
      timezone="UTC"
      probeState={probeState}
      onViewPorts={vi.fn()}
      onViewMonitoring={vi.fn()}
      {...overrides}
    />,
  );
}

describe('NetworkDeviceStats', () => {
  it('names the reachability source and age, never a bare state', () => {
    renderStrip();
    const cell = screen.getByTestId('network-detail-stat-reachability').textContent ?? '';
    expect(cell).toContain('Responding');
    expect(cell).toContain('SNMP');
    expect(cell).toMatch(/2\s*min/);
  });

  it('shows the last poll with its status word and links to the Monitoring tab', async () => {
    const onViewMonitoring = vi.fn();
    renderStrip({ onViewMonitoring });
    expect(screen.getByTestId('network-detail-stat-last-poll').textContent).toContain('Polling');
    await userEvent.click(screen.getByTestId('network-detail-stat-last-poll'));
    expect(onViewMonitoring).toHaveBeenCalledTimes(1);
  });

  it('fills the printer type slot with the lowest supply', () => {
    renderStrip();
    const slot = screen.getByTestId('network-detail-stat-type').textContent ?? '';
    expect(slot).toContain('Cyan Toner');
    expect(slot).toContain('12');
    expect(slot).not.toContain('78'); // the lowest supply, not the first one
  });

  it('calls the probe and renders a pending line while it is in flight', async () => {
    const checkNow = vi.fn().mockResolvedValue(undefined);
    renderStrip({ probeState: { checking: false, pending: true, errorCode: null, checkNow } });
    await userEvent.click(screen.getByTestId('network-detail-check-now'));
    expect(checkNow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('network-detail-probe-status').textContent).toContain('Checking');
  });

  it('renders a probe failure as an inline line under the reachability cell', () => {
    renderStrip({ probeState: { checking: false, pending: false, errorCode: 'NO_AGENT_IN_SITE', checkNow: vi.fn() } });
    const line = screen.getByTestId('network-detail-probe-error');
    expect(line).toHaveAttribute('role', 'status');
    expect(line.textContent).toContain('No online agent');
  });

  it('still renders every cell when the API sent no reachability and no collection', () => {
    renderStrip({ reachability: null, collection: null });
    expect(screen.getByTestId('network-detail-stat-reachability').textContent).toContain('Unverified');
    expect(screen.getByTestId('network-detail-stat-last-poll').textContent).toContain('Not configured');
    expect(screen.getByTestId('network-detail-stat-ports').textContent).toContain('2');
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/NetworkDeviceStats.test.tsx
```
Expected: the file imports a named `NetworkDeviceStats` with props it does not have yet — type errors at runtime show as "Responding" not found in a cell that does not exist.

- [ ] **Step 7: Rewrite `NetworkDeviceStats.tsx`**

Four cells, each `shrink-0` with the existing `sm:block` divider between them. Key points:

```tsx
  const reach = formatReachability(reachability, t as TFn, timezone);
  const poll = formatLastPoll(collection, t as TFn, timezone);
  const typeSlot = resolveTypeSlot(asset, collection, reachability, t as TFn);
```
`resolveTypeSlot` lives at the bottom of the same file (it is 30 lines of pure lookup, not a component):
```tsx
type TypeSlot = { label: string; value: string; title?: string };

const NETWORK_GEAR: DiscoveredAssetType[] = ['switch', 'router', 'firewall', 'access_point'];

function resolveTypeSlot(
  asset: DiscoveredAsset,
  collection: Collection | null,
  reachability: Reachability | null,
  t: TFn,
): TypeSlot {
  if (asset.type === 'printer') {
    const lowest = lowestSupply(collection);
    if (lowest) {
      return {
        label: t('networkDeviceDetailPage.stats.lowestSupply'),
        value: `${lowest.description ?? t('common:states.unknown')} ${
          lowest.percent === null ? t('common:states.unknown') : formatPercent(lowest.percent / 100, { maximumFractionDigits: 0 })
        }`,
      };
    }
  }
  if (NETWORK_GEAR.includes(asset.type)) {
    const ports = portsUp(collection);
    if (ports) {
      return {
        label: t('networkDeviceDetailPage.stats.portsUp'),
        value: t('networkDeviceDetailPage.stats.portsUpValue', { up: ports.up, total: ports.total }),
      };
    }
  }
  // Default: the freshest host observation's ping. `responseTimeMs` on the
  // asset is the scan's; a network check or probe observation is fresher and
  // is what the reachability verdict was actually built from.
  const ms =
    reachability?.detail.probe?.responseMs
    ?? reachability?.detail.networkCheck?.responseMs
    ?? asset.responseTimeMs
    ?? null;
  return { label: t('networkDeviceDetailPage.fields.ping'), value: formatPing(ms) };
}
```
`lowestSupply` and `portsUp` are imported from `./health/printerMib` and a new `./health/ifTable` respectively — **Task 7 creates `printerMib.ts`**, so implement `lowestSupply` there first if you are doing tasks out of order. `portsUp` reads `ifOperStatus` (`1.3.6.1.2.1.2.2.1.8`) instances, counting `value === '1'` as up; returns `null` when the OID is absent.

The reachability cell carries "Check now" and the two inline lines:
```tsx
        <button
          type="button"
          data-testid="network-detail-check-now"
          disabled={probeState.checking || probeState.pending}
          onClick={() => void probeState.checkNow()}
          className="mt-1 text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.probe.checkNow')}
        </button>
        {(probeState.checking || probeState.pending) && (
          <p className="text-xs text-muted-foreground" data-testid="network-detail-probe-status" role="status">
            {t('networkDeviceDetailPage.probe.checking')}
          </p>
        )}
        {probeState.errorCode && (
          <p className="text-xs text-destructive" data-testid="network-detail-probe-error" role="status">
            {t(/* i18n-dynamic */ `networkDeviceDetailPage.probe.errors.${PROBE_ERROR_KEYS[probeState.errorCode]}`)}
          </p>
        )}
```
with
```tsx
const PROBE_ERROR_KEYS: Record<ProbeErrorCode, string> = {
  NO_AGENT_IN_SITE: 'noAgentInSite',
  PROBE_IN_FLIGHT: 'inFlight',
  ASSET_NO_IP: 'noIp',
  PROBE_TIMED_OUT: 'timedOut',
  UNKNOWN: 'unknown',
};
```
The "Last poll" cell is a `<button>` calling `onViewMonitoring` (`data-testid="network-detail-stat-last-poll"`); "Open ports" keeps its existing `network-detail-stat-ports` id and `onViewPorts`.

English keys:
```json
  "probe": {
    "checkNow": "Check now",
    "checking": "Checking…",
    "errors": {
      "noAgentInSite": "No online agent at this site can reach the device. Bring an agent online here, then try again.",
      "inFlight": "A check is already running for this device.",
      "noIp": "This asset has no IP address to check.",
      "timedOut": "The agent didn't answer within a minute. It may be offline or busy.",
      "unknown": "Couldn't check this device right now."
    }
  },
```
and under `stats`: `"lowestSupply": "Lowest supply"`, `"portsUp": "Ports up"`, `"portsUpValue": "{{up}} / {{total}}"`.

- [ ] **Step 8: Register the new mutation file and verify the single-writer guard**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`, add to `TARGET_GLOBS`:
```ts
  // Network device "Check now" (#W05): the only mutating call this page makes
  // outside W04's settings writer. A bare POST here would fail silently on the
  // one control whose entire purpose is producing a visible result line.
  'src/components/devices/networkDevice/useAssetProbe.ts',
```
and bump `expect(absoluteFiles.length).toBe(133)` to `134`.

Then confirm the probe does **not** trip W04's contract:
```bash
cd apps/web && npx vitest run \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/__tests__/network-asset-single-writer.test.ts
```
Both must pass untouched. If `network-asset-single-writer.test.ts` flags `useAssetProbe.ts`, W04's `GUARDED` list has been widened to `/discovery/assets/*` as a prefix — do **not** move the probe into `useNetworkAssetMutations`; instead add `{ shape: '/discovery/assets/*/probe', methods: [] }` to `GUARDED` with the comment "the probe reads liveness; it does not own the asset (spec §5 vs §10)".

- [ ] **Step 9: Green**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/useAssetProbe.test.ts \
  src/components/devices/networkDevice/NetworkDeviceStats.test.tsx \
  src/components/devices/NetworkDeviceDetailPage.test.tsx
```

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/devices/networkDevice/useAssetProbe.ts \
        apps/web/src/components/devices/networkDevice/useAssetProbe.test.ts \
        apps/web/src/components/devices/networkDevice/NetworkDeviceStats.tsx \
        apps/web/src/components/devices/networkDevice/NetworkDeviceStats.test.tsx \
        apps/web/src/components/devices/NetworkDeviceDetailPage.tsx \
        apps/web/src/lib/__tests__/no-silent-mutations.test.ts \
        apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): Check-now probe and a sourced stat strip

The strip is now Reachability · Last poll · type slot · Open ports. "Check now"
POSTs /discovery/assets/:id/probe, polls every 3s for up to 60s while the server
reports pending, and renders each §14 failure as an inline line under the
reachability cell instead of a toast that disappears. Linked device moves out of
the strip into Identity.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `ReachabilityCard` (overview row 1, 1/3 width)

The D1 detail lines, one per contributing source, each with its own age; the collection summary; "Check now"; and the agent that bridges the polls. This is where an operator answers "why does it say that".

**Decision:** the bridging agent is `extras.suggestedBridgeDeviceId` — the agent that ran the last discovery scan, which is also what `selectNetworkExecutor` picks for site-strict work. It is rendered as a link to `/devices/<id>` with the name resolved from the `devices` list the page already loads for the proxy picker; when the list has not resolved it yet, the row renders `—` rather than an id.

**Decision:** `PROBE_ERROR_KEYS` moves out of `NetworkDeviceStats.tsx` and is exported from `useAssetProbe.ts` in this task, because the strip and this card render the same five error lines and two copies would drift.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/ReachabilityCard.tsx`
- Create: `apps/web/src/components/devices/networkDevice/ReachabilityCard.test.tsx`
- Modify: `apps/web/src/components/devices/networkDevice/useAssetProbe.ts` (export `PROBE_ERROR_KEYS`)
- Modify: `apps/web/src/components/devices/networkDevice/NetworkDeviceStats.tsx` (import it instead of declaring it)

**Interfaces:**
```ts
export type ReachabilityCardProps = {
  reachability: Reachability | null;
  collection: Collection | null;
  timezone: string;
  bridgeDeviceId: string | null;
  bridgeDeviceName: string | null;
  probeState: ReturnType<typeof useAssetProbe>;
  onViewMonitoring: () => void;
};
export function ReachabilityCard(props: ReachabilityCardProps): JSX.Element;

/** Exported for the card's own test and for NetworkDeviceStats. */
export type DetailLine = { key: string; label: string; value: string; title: string };
export function detailLines(r: Reachability | null, t: TFn, timezone: string): DetailLine[];
```

- [ ] **Step 1: Red — write the full test file**

Create `apps/web/src/components/devices/networkDevice/ReachabilityCard.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReachabilityCard } from './ReachabilityCard';
import type { Collection, Reachability } from './types';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const idleProbeState = {
  checking: false,
  pending: false,
  errorCode: null as null | 'NO_AGENT_IN_SITE',
  checkNow: vi.fn(),
};

const full: Reachability = {
  state: 'responding',
  source: 'network_check',
  observedAt: ago(1),
  lastKnown: null,
  detail: {
    networkCheck: { state: 'online', observedAt: ago(1), responseMs: 4.2, monitorId: 'm1' },
    snmp: { state: 'failing', observedAt: ago(40), consecutiveFailures: 3 },
    scan: { state: 'seen', observedAt: ago(1140), source: 'scan' },
    probe: { state: 'ok', observedAt: ago(12), responseMs: 3.0 },
  },
};

const collection: Collection = {
  templateId: 'tpl-1',
  lastPolledAt: ago(40),
  pollingInterval: 300,
  status: 'failing',
  consecutiveFailures: 3,
  oids: [
    { baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast', state: 'collecting', observedAt: ago(40), instances: [], error: null },
    { baseOid: '1.3.6.1.2.1.25.3.5.1.1', name: 'hrPrinterStatus', mode: 'walk', cadence: 'fast', state: 'unsupported', observedAt: ago(40), instances: [], error: 'noSuchObject' },
  ],
};

function renderCard(overrides: Partial<React.ComponentProps<typeof ReachabilityCard>> = {}) {
  return render(
    <ReachabilityCard
      reachability={full}
      collection={collection}
      timezone="UTC"
      bridgeDeviceId="dev-1"
      bridgeDeviceName="HQ-AGENT-01"
      probeState={idleProbeState}
      onViewMonitoring={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ReachabilityCard', () => {
  it('leads with the sourced headline, never a bare state word', () => {
    renderCard();
    const headline = screen.getByTestId('network-detail-reach-headline');
    expect(headline.textContent).toContain('Responding');
    expect(headline.textContent).toContain('Network check');
    expect(headline.textContent).toContain('·');
    expect(headline).toHaveAttribute('title', expect.stringContaining('20'));
  });

  it('renders one line per contributing source, each with its own age', () => {
    renderCard();
    const card = screen.getByTestId('network-detail-reachability-card');
    expect(card.textContent).toContain('Network check');
    expect(card.textContent).toContain('SNMP');
    expect(card.textContent).toContain('Scan');
    expect(card.textContent).toContain('Probe');
    expect(screen.getByTestId('network-detail-reach-network_check').textContent).toMatch(/1\s*min/);
    expect(screen.getByTestId('network-detail-reach-probe').textContent).toMatch(/12\s*min/);
    expect(screen.getByTestId('network-detail-reach-scan').textContent).toMatch(/19\s*hr/);
    expect(screen.queryByTestId('network-detail-reach-empty')).toBeNull();
  });

  it('pairs a network-check line with its measured response time', () => {
    renderCard();
    expect(screen.getByTestId('network-detail-reach-network_check').textContent).toContain('4.2 ms');
  });

  it('says an SNMP failure is protocol-level, not a device verdict', () => {
    renderCard();
    const snmp = screen.getByTestId('network-detail-reach-snmp');
    expect(snmp.textContent).toContain('Failing');
    expect(snmp.textContent).toContain('3');
    expect(screen.getByTestId('network-detail-reach-snmp-note').textContent).toContain('bridging agent');
  });

  it('summarises collection and links through to the OID table', async () => {
    const onViewMonitoring = vi.fn();
    renderCard({ onViewMonitoring });
    const summary = screen.getByTestId('network-detail-collection-summary');
    expect(summary.textContent).toContain('1 collecting');
    expect(summary.textContent).toContain('1 unsupported');
    await userEvent.click(screen.getByTestId('network-detail-view-oids'));
    expect(onViewMonitoring).toHaveBeenCalledTimes(1);
  });

  it('names the agent that bridges the polls and links to it', () => {
    renderCard();
    const bridge = screen.getByTestId('network-detail-bridge-agent');
    expect(bridge.textContent).toContain('HQ-AGENT-01');
    expect(bridge.querySelector('a')).toHaveAttribute('href', '/devices/dev-1');
  });

  it('renders a dash, not an id, while the device list is still resolving', () => {
    renderCard({ bridgeDeviceId: 'dev-1', bridgeDeviceName: null });
    const bridge = screen.getByTestId('network-detail-bridge-agent');
    expect(bridge.querySelector('a')).toBeNull();
    expect(bridge.textContent).toContain('—');
    expect(bridge.textContent).not.toContain('dev-1');
  });

  it('runs the probe from the card and shows the in-flight line', async () => {
    const checkNow = vi.fn().mockResolvedValue(undefined);
    renderCard({ probeState: { checking: true, pending: false, errorCode: null, checkNow } });
    await userEvent.click(screen.getByTestId('network-detail-card-check-now'));
    expect(checkNow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('network-detail-card-probe-status').textContent).toContain('Checking');
  });

  it('renders a probe failure inline on the card', () => {
    renderCard({ probeState: { checking: false, pending: false, errorCode: 'NO_AGENT_IN_SITE', checkNow: vi.fn() } });
    const line = screen.getByTestId('network-detail-card-probe-error');
    expect(line).toHaveAttribute('role', 'status');
    expect(line.textContent).toContain('No online agent');
  });

  it('degrades to a single Unverified line with no detail at all', () => {
    renderCard({
      reachability: { state: 'unverified', source: null, observedAt: null, lastKnown: null, detail: {} },
      collection: null,
      bridgeDeviceId: null,
      bridgeDeviceName: null,
    });
    expect(screen.getByTestId('network-detail-reach-headline').textContent).toContain('Unverified');
    expect(screen.getByTestId('network-detail-reach-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('network-detail-collection-summary')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/ReachabilityCard.test.tsx
```
Expected: `Failed to resolve import "./ReachabilityCard"` — eleven failing cases.

- [ ] **Step 3: Move `PROBE_ERROR_KEYS` into `useAssetProbe.ts`**

Append to `apps/web/src/components/devices/networkDevice/useAssetProbe.ts`:

```ts
/**
 * Locale-key suffixes under `networkDeviceDetailPage.probe.errors`. Exported
 * because the stat strip and the reachability card render the same five lines
 * and a second copy of this map would drift the moment a code is added.
 */
export const PROBE_ERROR_KEYS: Record<ProbeErrorCode, string> = {
  NO_AGENT_IN_SITE: 'noAgentInSite',
  PROBE_IN_FLIGHT: 'inFlight',
  ASSET_NO_IP: 'noIp',
  PROBE_TIMED_OUT: 'timedOut',
  UNKNOWN: 'unknown',
};
```
and in `NetworkDeviceStats.tsx` delete the local declaration, importing it instead:
```ts
import { PROBE_ERROR_KEYS, type ProbeErrorCode, type useAssetProbe } from './useAssetProbe';
```

- [ ] **Step 4: Implement `ReachabilityCard.tsx`**

```tsx
// "Why does it say that?" — the card that answers it. One line per source that
// actually contributed an observation, each with its own age, because the whole
// point of D1 is that the page's verdict is derived from several sources whose
// freshness differs. The SNMP line is deliberately phrased as protocol-level:
// consecutive_failures increments at DISPATCH (snmpWorker's markPollDispatched),
// so "SNMP failing" can mean the bridging agent, not the device.

import { useTranslation } from 'react-i18next';
import { useTranslation as useCommon } from 'react-i18next';
import EmptyState from '../../shared/EmptyState';
import { formatLastSeen } from '@/lib/formatTime';
import { formatPing } from '../../discovery/pingFormat';
import { Section } from './primitives';
import {
  formatAbsolute,
  formatCollectionSummary,
  formatReachability,
  reachabilitySourceKey,
  type ReachabilityTone,
  type TFn,
} from './reachabilityCopy';
import { PROBE_ERROR_KEYS, type useAssetProbe } from './useAssetProbe';
import type { Collection, Reachability } from './types';

const TONE_TEXT: Record<ReachabilityTone, string> = {
  success: 'text-success',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
};

const TONE_DOT: Record<ReachabilityTone, string> = {
  success: 'bg-success',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
};

export type DetailLine = { key: string; label: string; value: string; title: string };

/**
 * One line per branch of `reachability.detail` that is actually present.
 * Pure and exported so the copy can be asserted without rendering.
 */
export function detailLines(r: Reachability | null, t: TFn, timezone: string): DetailLine[] {
  if (!r) return [];
  const lines: DetailLine[] = [];
  const { networkCheck, probe, snmp, scan } = r.detail;

  if (networkCheck) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.check.${networkCheck.state}`)];
    if (networkCheck.responseMs !== null) parts.push(formatPing(networkCheck.responseMs));
    parts.push(formatLastSeen(networkCheck.observedAt, timezone));
    lines.push({
      key: 'network_check',
      label: t(/* i18n-dynamic */ reachabilitySourceKey('network_check')),
      value: parts.join(' · '),
      title: formatAbsolute(networkCheck.observedAt, timezone),
    });
  }

  if (probe) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.probe.${probe.state}`)];
    if (probe.responseMs !== null) parts.push(formatPing(probe.responseMs));
    if (probe.observedAt) parts.push(formatLastSeen(probe.observedAt, timezone));
    lines.push({
      key: 'probe',
      label: t(/* i18n-dynamic */ reachabilitySourceKey('probe')),
      value: parts.join(' · '),
      title: formatAbsolute(probe.observedAt, timezone),
    });
  }

  if (snmp) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.snmp.${snmp.state}`)];
    if (snmp.consecutiveFailures > 0) {
      parts.push(t('networkDeviceDetailPage.reachability.detail.snmpFailures', { count: snmp.consecutiveFailures }));
    }
    if (snmp.observedAt) parts.push(formatLastSeen(snmp.observedAt, timezone));
    lines.push({
      key: 'snmp',
      label: t(/* i18n-dynamic */ reachabilitySourceKey('snmp')),
      value: parts.join(' · '),
      title: formatAbsolute(snmp.observedAt, timezone),
    });
  }

  if (scan) {
    const parts = [t(/* i18n-dynamic */ `networkDeviceDetailPage.reachability.detail.scan.${scan.state}`)];
    if (scan.observedAt) parts.push(formatLastSeen(scan.observedAt, timezone));
    lines.push({
      // The testid stays `scan` for both sources — it is the scan/controller
      // branch — while the LABEL distinguishes a UniFi controller from a sweep.
      key: 'scan',
      label: t(/* i18n-dynamic */ reachabilitySourceKey(scan.source)),
      value: parts.join(' · '),
      title: formatAbsolute(scan.observedAt, timezone),
    });
  }

  return lines;
}

export function ReachabilityCard({
  reachability,
  collection,
  timezone,
  bridgeDeviceId,
  bridgeDeviceName,
  probeState,
  onViewMonitoring,
}: {
  reachability: Reachability | null;
  collection: Collection | null;
  timezone: string;
  bridgeDeviceId: string | null;
  bridgeDeviceName: string | null;
  probeState: ReturnType<typeof useAssetProbe>;
  onViewMonitoring: () => void;
}) {
  const { t } = useTranslation('devices');
  const tf = t as unknown as TFn;
  const headline = formatReachability(reachability, tf, timezone);
  const lines = detailLines(reachability, tf, timezone);
  const collectionSummary = formatCollectionSummary(collection, tf);
  const snmpFailing = reachability?.detail.snmp?.state === 'failing';

  return (
    <Section
      title={t('networkDeviceDetailPage.sections.reachability')}
      testId="network-detail-reachability-card"
    >
      <p
        className={`flex items-center gap-2 text-sm font-medium ${TONE_TEXT[headline.tone]}`}
        data-testid="network-detail-reach-headline"
        title={headline.title || undefined}
      >
        <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[headline.tone]}`} />
        {headline.label}
      </p>

      {lines.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-reach-empty"
          title={t('networkDeviceDetailPage.reachability.detail.emptyTitle')}
          description={t('networkDeviceDetailPage.reachability.detail.emptyDescription')}
        />
      ) : (
        <dl className="mt-3 space-y-2 border-t pt-3 text-sm">
          {lines.map((line) => (
            <div key={line.key} className="flex items-baseline justify-between gap-3" data-testid={`network-detail-reach-${line.key}`}>
              <dt className="shrink-0 text-muted-foreground">{line.label}</dt>
              <dd className="min-w-0 text-right" title={line.title || undefined}>{line.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {snmpFailing && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="network-detail-reach-snmp-note">
          {t('networkDeviceDetailPage.reachability.detail.snmpNote')}
        </p>
      )}

      {collectionSummary && (
        <div className="mt-3 border-t pt-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">
            {t('networkDeviceDetailPage.sections.collection')}
          </p>
          <p className="mt-1" data-testid="network-detail-collection-summary">{collectionSummary}</p>
          <button
            type="button"
            data-testid="network-detail-view-oids"
            onClick={onViewMonitoring}
            className="mt-1 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.collection.viewOids')}
          </button>
        </div>
      )}

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t pt-3 text-sm" data-testid="network-detail-bridge-agent">
        <span className="shrink-0 text-muted-foreground">{t('networkDeviceDetailPage.fields.bridgingAgent')}</span>
        {bridgeDeviceId && bridgeDeviceName ? (
          <a
            href={`/devices/${bridgeDeviceId}`}
            className="min-w-0 truncate text-right text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {bridgeDeviceName}
          </a>
        ) : (
          // A raw uuid is not an answer to "which agent" — until the device
          // list resolves the name, say unknown rather than print an id.
          <span aria-label={t('common:states.unknown')}>—</span>
        )}
      </div>

      <div className="mt-3 border-t pt-3">
        <button
          type="button"
          data-testid="network-detail-card-check-now"
          disabled={probeState.checking || probeState.pending}
          onClick={() => void probeState.checkNow()}
          className="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.probe.checkNow')}
        </button>
        {(probeState.checking || probeState.pending) && (
          <p className="mt-1 text-xs text-muted-foreground" role="status" data-testid="network-detail-card-probe-status">
            {t('networkDeviceDetailPage.probe.checking')}
          </p>
        )}
        {probeState.errorCode && (
          <p className="mt-1 text-xs text-destructive" role="status" data-testid="network-detail-card-probe-error">
            {t(/* i18n-dynamic */ `networkDeviceDetailPage.probe.errors.${PROBE_ERROR_KEYS[probeState.errorCode]}`)}
          </p>
        )}
      </div>
    </Section>
  );
}
```

- [ ] **Step 5: Add the English keys**

Under `networkDeviceDetailPage.reachability`:
```json
    "detail": {
      "check": { "online": "Online", "degraded": "Degraded", "offline": "Offline" },
      "probe": { "ok": "Answered", "failed": "No answer", "pending": "Waiting for the agent" },
      "snmp": {
        "ok": "Polling",
        "failing": "Failing",
        "no_template": "No template",
        "no_agent": "No agent in site",
        "asset_moved": "Asset moved",
        "never_polled": "Never polled"
      },
      "snmpFailures": "{{count}} consecutive failures",
      "snmpNote": "An SNMP failure can mean the bridging agent rather than the device — failures are counted when the poll is dispatched.",
      "scan": { "seen": "Seen", "missed": "Missed" },
      "emptyTitle": "Nothing has reported on this device",
      "emptyDescription": "No scan, check, poll or manual probe has produced an observation yet."
    }
```
plus `collection.viewOids: "View OIDs"`, `sections.reachability: "Reachability"`, `sections.collection: "Collection"`, `fields.bridgingAgent: "Bridging agent"`.

- [ ] **Step 6: Green**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/ReachabilityCard.test.tsx \
  src/components/devices/networkDevice/NetworkDeviceStats.test.tsx
```
Expected: 11 + 6 passing; the strip suite must stay green after the `PROBE_ERROR_KEYS` move.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/networkDevice/ReachabilityCard.tsx \
        apps/web/src/components/devices/networkDevice/ReachabilityCard.test.tsx \
        apps/web/src/components/devices/networkDevice/useAssetProbe.ts \
        apps/web/src/components/devices/networkDevice/NetworkDeviceStats.tsx \
        apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): reachability and collection card

One line per contributing source with its own age, the per-OID collection
summary, Check now, and the agent that bridges the polls — so "why does it say
that" is answerable on the page. The SNMP line is phrased as protocol-level
because consecutive_failures increments at dispatch and can mean the agent.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 6: the `health/` registry, `EmptyHealth` and `GenericHealth`

**Decision:** `EmptyHealth` renders when there is **no SNMP device** (`collection === null` or SNMP is not enabled) — that is the "Set up monitoring" affordance. A device that *has* SNMP but no template (`status === 'no_template'`) is a different failure and belongs inside `GenericHealth`/`PrinterHealth`, which explain it and link to the modal's Monitoring section; routing it to `EmptyHealth` would tell an operator to set up monitoring they already set up.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/health/types.ts`
- Create: `apps/web/src/components/devices/networkDevice/health/index.ts`
- Create: `apps/web/src/components/devices/networkDevice/health/index.test.ts`
- Create: `apps/web/src/components/devices/networkDevice/health/EmptyHealth.tsx`
- Create: `apps/web/src/components/devices/networkDevice/health/GenericHealth.tsx`
- Create: `apps/web/src/components/devices/networkDevice/health/GenericHealth.test.tsx`

- [ ] **Step 1: Red — the registry contract**

Create `apps/web/src/components/devices/networkDevice/health/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EmptyHealth, GenericHealth, PrinterHealth, resolveHealthCard } from './index';
import type { Collection } from '../types';

const collection: Collection = {
  templateId: 'tpl-1',
  lastPolledAt: '2026-09-16T10:00:00.000Z',
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [],
};

describe('resolveHealthCard', () => {
  it('returns EmptyHealth when no SNMP device exists', () => {
    expect(resolveHealthCard({ assetType: 'printer', collection: null, snmpEnabled: false })).toBe(EmptyHealth);
    expect(resolveHealthCard({ assetType: 'switch', collection: null, snmpEnabled: true })).toBe(EmptyHealth);
  });

  it('returns EmptyHealth when SNMP is configured but switched off', () => {
    expect(resolveHealthCard({ assetType: 'printer', collection, snmpEnabled: false })).toBe(EmptyHealth);
  });

  it('dispatches printers to PrinterHealth', () => {
    expect(resolveHealthCard({ assetType: 'printer', collection, snmpEnabled: true })).toBe(PrinterHealth);
  });

  it('falls back to GenericHealth for every other type', () => {
    for (const type of ['switch', 'router', 'firewall', 'nas', 'iot', 'camera', 'phone', 'server', 'workstation', 'access_point', 'website', 'service', 'unknown'] as const) {
      expect(resolveHealthCard({ assetType: type, collection, snmpEnabled: true })).toBe(GenericHealth);
    }
  });

  it('keeps the type card (not EmptyHealth) when SNMP is on but the template is missing', () => {
    const noTemplate: Collection = { ...collection, templateId: null, status: 'no_template' };
    expect(resolveHealthCard({ assetType: 'printer', collection: noTemplate, snmpEnabled: true })).toBe(PrinterHealth);
    expect(resolveHealthCard({ assetType: 'switch', collection: noTemplate, snmpEnabled: true })).toBe(GenericHealth);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/health/index.test.ts
```
Expected: `Failed to resolve import "./index"`.

- [ ] **Step 3: `health/types.ts`**

```ts
// Props every Health card receives. The registry hands each card the SAME
// shape so adding a card is one file and one registry entry — the page never
// learns which type it is rendering.

import type { JSX } from 'react';
import type { DiscoveredAssetType } from '../../../discovery/DiscoveredAssetList';
import type { Collection } from '../types';

export type HealthCardProps = {
  assetId: string;
  assetType: DiscoveredAssetType;
  collection: Collection | null;
  snmpEnabled: boolean;
  timezone: string;
  /** Opens W04's settings modal at its Monitoring section. */
  onSetUpMonitoring: () => void;
  /** Switches the page to the Monitoring tab. */
  onViewMonitoring: () => void;
};

export type HealthCardComponent = (props: HealthCardProps) => JSX.Element;
```

- [ ] **Step 4: `health/index.ts`**

```ts
// The Health card is the only place the page varies by device type (D8: no
// per-type tabs). A registry keyed on DiscoveredAssetType keeps that variation
// to one lookup — adding a UPS or NAS card later is one entry and one file,
// not a new tab and not a branch inside the page component.

import type { DiscoveredAssetType } from '../../../discovery/DiscoveredAssetList';
import type { Collection } from '../types';
import type { HealthCardComponent } from './types';
import { EmptyHealth } from './EmptyHealth';
import { GenericHealth } from './GenericHealth';
import { PrinterHealth } from './PrinterHealth';

const REGISTRY: Partial<Record<DiscoveredAssetType, HealthCardComponent>> = {
  printer: PrinterHealth,
};

export function resolveHealthCard({
  assetType,
  collection,
  snmpEnabled,
}: {
  assetType: DiscoveredAssetType;
  collection: Collection | null;
  snmpEnabled: boolean;
}): HealthCardComponent {
  // No SNMP device at all (or one that is switched off) is the set-up case.
  // A device WITH SNMP that has no template is a different failure: the type
  // card explains it, because telling someone to "set up monitoring" they have
  // already set up is how the real fix gets missed.
  if (!snmpEnabled || collection === null) return EmptyHealth;
  return REGISTRY[assetType] ?? GenericHealth;
}

export { EmptyHealth, GenericHealth, PrinterHealth };
export type { HealthCardComponent, HealthCardProps } from './types';
```

- [ ] **Step 5: `health/EmptyHealth.tsx`**

```tsx
// The "Set up monitoring" affordance. Named after what is missing, not after
// what the card would have shown: an operator landing here has an asset that
// nothing is polling, and the only useful thing on the card is the way to fix
// that. The description names what SNMP would add for THIS device type so the
// CTA is an offer, not a chore.

import { Activity } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import EmptyState from '../../../shared/EmptyState';
import { Section } from '../primitives';
import type { HealthCardProps } from './types';

const TYPE_BENEFIT_KEYS: Record<string, string> = {
  printer: 'networkDeviceDetailPage.health.empty.benefit.printer',
  switch: 'networkDeviceDetailPage.health.empty.benefit.switch',
  router: 'networkDeviceDetailPage.health.empty.benefit.switch',
  firewall: 'networkDeviceDetailPage.health.empty.benefit.switch',
  access_point: 'networkDeviceDetailPage.health.empty.benefit.switch',
};

export function EmptyHealth({ assetType, onSetUpMonitoring }: HealthCardProps) {
  const { t } = useTranslation('devices');
  const benefitKey = TYPE_BENEFIT_KEYS[assetType] ?? 'networkDeviceDetailPage.health.empty.benefit.generic';

  return (
    <Section title={t('networkDeviceDetailPage.sections.deviceHealth')} testId="network-detail-health">
      <EmptyState
        variant="plain"
        size="sm"
        testId="network-detail-health-empty"
        icon={<Activity aria-hidden="true" />}
        title={t('networkDeviceDetailPage.health.empty.title')}
        description={t(/* i18n-dynamic */ benefitKey)}
        action={
          <button
            type="button"
            data-testid="network-detail-setup-monitoring"
            onClick={onSetUpMonitoring}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('networkDeviceDetailPage.health.empty.action')}
          </button>
        }
      />
    </Section>
  );
}
```

- [ ] **Step 6: Red — `GenericHealth`**

Create `apps/web/src/components/devices/networkDevice/health/GenericHealth.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GenericHealth } from './GenericHealth';
import type { Collection, CollectionOid } from '../types';

const AT = '2026-09-16T10:00:00.000Z';

function oid(overrides: Partial<CollectionOid> & { baseOid: string; name: string }): CollectionOid {
  return {
    mode: 'get',
    cadence: 'fast',
    state: 'collecting',
    observedAt: AT,
    instances: [{ oid: `${overrides.baseOid}.0`, instance: '', value: '42', valueType: 'integer', observedAt: AT }],
    error: null,
    ...overrides,
  };
}

const base: Collection = {
  templateId: 'tpl-1',
  lastPolledAt: AT,
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [
    oid({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' }),
    oid({ baseOid: '1.3.6.1.2.1.1.5.0', name: 'sysName', instances: [{ oid: '1.3.6.1.2.1.1.5.0', instance: '', value: 'core-sw-01', valueType: 'string', observedAt: AT }] }),
  ],
};

function renderCard(collection: Collection | null = base, overrides: Record<string, unknown> = {}) {
  return render(
    <GenericHealth
      assetId="a1"
      assetType="switch"
      collection={collection}
      snmpEnabled
      timezone="UTC"
      onSetUpMonitoring={vi.fn()}
      onViewMonitoring={vi.fn()}
      {...overrides}
    />,
  );
}

describe('GenericHealth', () => {
  it('lists the template’s OIDs with their latest values', () => {
    renderCard();
    expect(screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.1.3.0').textContent).toContain('sysUpTime');
    expect(screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.1.5.0').textContent).toContain('core-sw-01');
  });

  it('caps the table and offers the full list on the Monitoring tab', async () => {
    const many: Collection = {
      ...base,
      oids: Array.from({ length: 12 }, (_, i) => oid({ baseOid: `1.3.6.1.2.1.99.${i}.0`, name: `metric${i}` })),
    };
    const onViewMonitoring = vi.fn();
    renderCard(many, { onViewMonitoring });
    expect(screen.getAllByTestId(/^network-detail-health-row-/)).toHaveLength(8);
    await userEvent.click(screen.getByTestId('network-detail-health-view-all'));
    expect(onViewMonitoring).toHaveBeenCalledTimes(1);
  });

  it('explains an unsupported OID with its error code instead of a blank cell', () => {
    renderCard({
      ...base,
      oids: [oid({ baseOid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', state: 'unsupported', error: 'noSuchObject', instances: [] })],
    });
    const row = screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.43.11.1.1.9');
    expect(row.textContent).toContain('Unsupported');
    expect(row.textContent).toContain('noSuchObject');
  });

  it('names the agent update as the fix for an unknown table OID', () => {
    renderCard({
      ...base,
      oids: [oid({ baseOid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', state: 'unknown', instances: [] })],
    });
    expect(screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.2.2.1.2').textContent)
      .toContain('update the agent');
  });

  it('explains a missing template and offers the fix instead of an empty table', async () => {
    const onSetUpMonitoring = vi.fn();
    renderCard({ ...base, templateId: null, status: 'no_template', oids: [] }, { onSetUpMonitoring });
    expect(screen.queryByTestId(/^network-detail-health-row-/)).toBeNull();
    expect(screen.getByTestId('network-detail-health-no-template').textContent).toContain('no template');
    await userEvent.click(screen.getByTestId('network-detail-health-pick-template'));
    expect(onSetUpMonitoring).toHaveBeenCalledTimes(1);
  });

  it('renders an accessible unknown for an OID with no value yet', () => {
    renderCard({ ...base, oids: [oid({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', state: 'never_polled', instances: [] })] });
    const row = screen.getByTestId('network-detail-health-row-1.3.6.1.2.1.1.3.0');
    expect(row.querySelector('[aria-label]')).toHaveAttribute('aria-label', 'Unknown');
  });
});
```

- [ ] **Step 7: Run it, watch it fail, implement `GenericHealth.tsx`**

```tsx
// The default Health card: the template's key OIDs with their latest values.
// Deliberately NOT a chart — at this altitude the question is "is anything
// coming back", and a row that says WHY it isn't (unsupported + its error code,
// unknown + "update the agent") is worth more than a sparkline of nothing.

import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import { Section } from '../primitives';
import { formatAbsolute } from '../reachabilityCopy';
import type { CollectionOid, CollectionOidState } from '../types';
import type { HealthCardProps } from './types';

const VISIBLE_ROWS = 8;

const STATE_KEYS: Record<CollectionOidState, string> = {
  collecting: 'networkDeviceDetailPage.collection.oidState.collecting',
  unsupported: 'networkDeviceDetailPage.collection.oidState.unsupported',
  stale: 'networkDeviceDetailPage.collection.oidState.stale',
  never_polled: 'networkDeviceDetailPage.collection.oidState.neverPolled',
  unknown: 'networkDeviceDetailPage.collection.oidState.unknown',
};

const STATE_CLASSES: Record<CollectionOidState, string> = {
  collecting: 'bg-success/15 text-success border-success/30',
  unsupported: 'bg-warning/15 text-warning border-warning/30',
  stale: 'bg-warning/15 text-warning border-warning/30',
  never_polled: 'bg-muted text-muted-foreground border-muted',
  unknown: 'bg-muted text-muted-foreground border-muted',
};

export function latestValue(entry: CollectionOid): string | null {
  const row = entry.instances[0];
  return row?.value ?? null;
}

export function GenericHealth({
  collection,
  timezone,
  onSetUpMonitoring,
  onViewMonitoring,
}: HealthCardProps) {
  const { t } = useTranslation('devices');

  if (collection && collection.status === 'no_template') {
    return (
      <Section title={t('networkDeviceDetailPage.sections.deviceHealth')} testId="network-detail-health">
        <p className="text-sm text-muted-foreground" data-testid="network-detail-health-no-template">
          {t('networkDeviceDetailPage.health.noTemplate')}
        </p>
        <button
          type="button"
          data-testid="network-detail-health-pick-template"
          onClick={onSetUpMonitoring}
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.health.pickTemplate')}
        </button>
      </Section>
    );
  }

  const oids = collection?.oids ?? [];
  const visible = oids.slice(0, VISIBLE_ROWS);

  return (
    <Section title={t('networkDeviceDetailPage.sections.deviceHealth')} testId="network-detail-health">
      {visible.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="network-detail-health-no-oids">
          {t('networkDeviceDetailPage.collection.count.noOids')}
        </p>
      ) : (
        <dl className="space-y-2 text-sm">
          {visible.map((entry) => {
            const value = latestValue(entry);
            return (
              <div
                key={entry.baseOid}
                className="flex items-baseline justify-between gap-3"
                data-testid={`network-detail-health-row-${entry.baseOid}`}
              >
                <dt className="min-w-0 truncate text-muted-foreground" title={entry.baseOid}>{entry.name}</dt>
                <dd className="flex min-w-0 shrink-0 items-center gap-2 text-right">
                  <span className="truncate" title={entry.observedAt ? formatAbsolute(entry.observedAt, timezone) : undefined}>
                    {value === null
                      ? <span aria-label={t('common:states.unknown')}>—</span>
                      : value}
                  </span>
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-xs ${STATE_CLASSES[entry.state]}`}>
                    {t(/* i18n-dynamic */ STATE_KEYS[entry.state])}
                  </span>
                  {entry.state === 'unsupported' && entry.error && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{entry.error}</span>
                  )}
                  {entry.observedAt && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatLastSeen(entry.observedAt, timezone)}
                    </span>
                  )}
                </dd>
                {entry.state === 'unknown' && (
                  <p className="basis-full text-xs text-muted-foreground">
                    {t('networkDeviceDetailPage.collection.unknownNeedsAgentUpdate')}
                  </p>
                )}
              </div>
            );
          })}
        </dl>
      )}
      {oids.length > VISIBLE_ROWS && (
        <button
          type="button"
          data-testid="network-detail-health-view-all"
          onClick={onViewMonitoring}
          className="mt-2 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.health.viewAllOids', { count: oids.length })}
        </button>
      )}
    </Section>
  );
}
```

- [ ] **Step 8: Add the English keys**

```json
  "health": {
    "empty": {
      "title": "Nothing is being monitored yet",
      "action": "Set up monitoring",
      "benefit": {
        "printer": "Turn on SNMP to see toner and ink levels, paper trays, page counts and printer error states.",
        "switch": "Turn on SNMP to see interface status, throughput per port and uptime.",
        "generic": "Turn on SNMP to collect health data from this device, or add a ping or port check."
      }
    },
    "noTemplate": "SNMP is on, but no template is assigned — so nothing is being polled.",
    "pickTemplate": "Choose a template",
    "viewAllOids": "View all {{count}} OIDs"
  },
```
and under `collection`:
```json
    "oidState": {
      "collecting": "Collecting",
      "unsupported": "Unsupported",
      "stale": "Stale",
      "neverPolled": "Never polled",
      "unknown": "Unknown"
    },
    "unknownNeedsAgentUpdate": "This agent version cannot read table values — update the agent on the bridging device.",
    "partialRows": "Partial — the walk hit its row limit.",
```

The `noTemplate` copy must name the *template* as what is missing, not SNMP — an operator who reads "SNMP is off" here will go and re-enable something that is already on (spec §1 F2: "SNMP monitoring: Enabled" can poll nothing).

- [ ] **Step 9: Green + commit**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/health/index.test.ts \
  src/components/devices/networkDevice/health/GenericHealth.test.tsx
git add apps/web/src/components/devices/networkDevice/health apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): health card registry with empty and generic cards

Type variation lives in one registry lookup instead of per-type tabs (D8).
EmptyHealth is the set-up-monitoring affordance for assets with no SNMP device;
a device that HAS SNMP but no template keeps its type card, which explains that
specific failure instead of sending the operator back to setup.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 7: `printerMib.ts` + `PrinterHealth`

Supplies as labelled meters grouped by **instance index across the four supply OIDs**, negative levels rendered as "unknown", lifetime page count with "since yesterday / since last week" deltas from `/metrics?…&delta=1`, and printer status words decoded from `hrPrinterStatus` / `hrDeviceStatus` / `hrPrinterDetectedErrorState`.

All decoding is pure and lives in `printerMib.ts`; `PrinterHealth.tsx` only renders. The OIDs and their names match the shipped built-in template seed (`apps/api/migrations/2026-05-22-snmp-multi-vendor-templates.sql`, "Generic Printer (RFC 3805)"), so they resolve against a real device's `collection` payload, not an invented one.

**Decisions:**
- **Grouping key** is the `instance` string, not the array position — a walk can return supplies in any order and can skip indices.
- **Any negative level is "unknown"** (RFC 3805 uses -1 = other, -2 = unknown, -3 = "some remaining"; the spec collapses all three to unknown). `maxCapacity <= 0` is likewise unknown, so no division by zero and no >100 % meter.
- **`hrPrinterDetectedErrorState` decoding accepts two stored shapes** — a hex string (`"0x0C"`, `"0c"`, `"0c 00"`) or a decimal integer — because `snmp_metrics.value` is `text` and the agent's encoding of an OCTET STRING differs between the legacy path and W02's. Bit 0 is the **MSB of byte 0** (RFC 3805 BITS encoding), so bit index `n` = byte `n >> 3`, mask `0x80 >> (n & 7)`.
- **Delta window**: one request, `from = now − 8 d`, `bucket=1d`, `delta=1`. "Since yesterday" is the last bucket; "since last week" is the sum of the last seven. Deriving both from one series avoids two round trips and guarantees the two numbers agree.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/health/printerMib.ts` (+ `.test.ts`)
- Create: `apps/web/src/components/devices/networkDevice/health/printerMib.fixtures.ts` (the Xerox collection, shared by both suites)
- Create: `apps/web/src/components/devices/networkDevice/health/PrinterHealth.tsx` (+ `.test.tsx`)

**Interfaces:**
```ts
export const PRINTER_OIDS = {
  deviceStatus: '1.3.6.1.2.1.25.3.2.1.5',
  printerStatus: '1.3.6.1.2.1.25.3.5.1.1',
  detectedErrorState: '1.3.6.1.2.1.25.3.5.1.2',
  lifeCount: '1.3.6.1.2.1.43.10.2.1.4',
  suppliesType: '1.3.6.1.2.1.43.11.1.1.5',
  suppliesDescription: '1.3.6.1.2.1.43.11.1.1.6',
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9',
  colorantValue: '1.3.6.1.2.1.43.12.1.1.4',
} as const;

export type SupplyReading = {
  instance: string;
  description: string | null;
  colorant: string | null;
  level: number | null;
  maxCapacity: number | null;
  /** 0-100, or null when either side is unknown. */
  percent: number | null;
  unknown: boolean;
};

export function groupSupplies(collection: Collection | null): SupplyReading[];
export function lowestSupply(collection: Collection | null): SupplyReading | null;
export function readPageCount(collection: Collection | null): { instanceOid: string; value: number } | null;
export function decodeErrorState(raw: string | null | undefined): string[];
export function readStatusWords(collection: Collection | null): {
  printerStatus: string | null;   // 'idle' | 'printing' | …
  deviceStatus: string | null;    // 'running' | 'warning' | …
  errors: string[];               // decoded bit names
};
export function summariseDeltas(points: Array<[string, number]>): { yesterday: number | null; lastWeek: number | null };
```

- [ ] **Step 1: Red — build the fixture from the spec's Xerox example**

Create `apps/web/src/components/devices/networkDevice/health/printerMib.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeErrorState,
  groupSupplies,
  lowestSupply,
  PRINTER_OIDS,
  readPageCount,
  readStatusWords,
  summariseDeltas,
} from './printerMib';
import type { Collection, CollectionOid } from '../types';

const AT = '2026-09-16T10:00:00.000Z';

function walkOid(baseOid: string, name: string, rows: Array<[string, string | null]>): CollectionOid {
  return {
    baseOid,
    name,
    mode: 'walk',
    cadence: 'fast',
    state: 'collecting',
    observedAt: AT,
    error: null,
    instances: rows.map(([instance, value]) => ({
      oid: `${baseOid}.${instance}`,
      instance,
      value,
      valueType: 'integer',
      observedAt: AT,
    })),
  };
}

// Xerox C325 Color MFP (spec §1 F5, §7.2): four supplies, CMYK, the cyan
// cartridge low at 37 %, one supply reporting a negative (unknown) level.
const xerox: Collection = {
  templateId: 'tpl-xerox',
  lastPolledAt: AT,
  pollingInterval: 300,
  status: 'ok',
  consecutiveFailures: 0,
  oids: [
    walkOid(PRINTER_OIDS.suppliesDescription, 'prtMarkerSuppliesDescription', [
      ['1.1', 'Cyan Toner Cartridge'],
      ['1.2', 'Magenta Toner Cartridge'],
      ['1.3', 'Yellow Toner Cartridge'],
      ['1.4', 'Black Toner Cartridge'],
      ['1.5', 'Waste Toner Container'],
    ]),
    walkOid(PRINTER_OIDS.suppliesMaxCapacity, 'prtMarkerSuppliesMaxCapacity', [
      ['1.1', '100'], ['1.2', '100'], ['1.3', '100'], ['1.4', '100'], ['1.5', '-2'],
    ]),
    walkOid(PRINTER_OIDS.suppliesLevel, 'prtMarkerSuppliesLevel', [
      ['1.1', '37'], ['1.2', '82'], ['1.3', '91'], ['1.4', '64'], ['1.5', '-3'],
    ]),
    walkOid(PRINTER_OIDS.colorantValue, 'prtMarkerColorantValue', [
      ['1.1', 'cyan'], ['1.2', 'magenta'], ['1.3', 'yellow'], ['1.4', 'black'],
    ]),
    walkOid(PRINTER_OIDS.lifeCount, 'prtMarkerLifeCount', [['1.1', '184230']]),
    walkOid(PRINTER_OIDS.printerStatus, 'hrPrinterStatus', [['1', '3']]),
    walkOid(PRINTER_OIDS.deviceStatus, 'hrDeviceStatus', [['1', '3']]),
    walkOid(PRINTER_OIDS.detectedErrorState, 'hrPrinterDetectedErrorState', [['1', '0x2000']]),
  ],
};

describe('groupSupplies', () => {
  it('joins the four supply OIDs by instance index, not array position', () => {
    const supplies = groupSupplies(xerox);
    expect(supplies).toHaveLength(5);
    const cyan = supplies.find((s) => s.instance === '1.1')!;
    expect(cyan.description).toBe('Cyan Toner Cartridge');
    expect(cyan.colorant).toBe('cyan');
    expect(cyan.level).toBe(37);
    expect(cyan.maxCapacity).toBe(100);
    expect(cyan.percent).toBe(37);
    expect(cyan.unknown).toBe(false);
  });

  it('treats any negative level or capacity as unknown, never as a percentage', () => {
    const waste = groupSupplies(xerox).find((s) => s.instance === '1.5')!;
    expect(waste.unknown).toBe(true);
    expect(waste.percent).toBeNull();
    // -3 is RFC 3805's "some remaining"; it is still not a number to draw.
    expect(waste.level).toBe(-3);
  });

  it('returns [] when the supply OIDs were never collected', () => {
    expect(groupSupplies({ ...xerox, oids: [] })).toEqual([]);
    expect(groupSupplies(null)).toEqual([]);
  });
});

describe('lowestSupply', () => {
  it('picks the lowest KNOWN supply', () => {
    expect(lowestSupply(xerox)!.instance).toBe('1.1');
  });

  it('returns null when every supply is unknown', () => {
    const allUnknown: Collection = {
      ...xerox,
      oids: [
        walkOid(PRINTER_OIDS.suppliesDescription, 'prtMarkerSuppliesDescription', [['1.1', 'Drum']]),
        walkOid(PRINTER_OIDS.suppliesLevel, 'prtMarkerSuppliesLevel', [['1.1', '-2']]),
      ],
    };
    expect(lowestSupply(allUnknown)).toBeNull();
  });
});

describe('readPageCount', () => {
  it('reads the lifetime count and its instance OID', () => {
    expect(readPageCount(xerox)).toEqual({
      instanceOid: `${PRINTER_OIDS.lifeCount}.1.1`,
      value: 184230,
    });
  });

  it('returns null when the OID is unsupported on this printer', () => {
    expect(readPageCount({ ...xerox, oids: xerox.oids.filter((o) => o.baseOid !== PRINTER_OIDS.lifeCount) })).toBeNull();
  });
});

describe('decodeErrorState', () => {
  it('decodes a hex bitmask, MSB-first per RFC 3805 BITS', () => {
    // 0x80 = bit 0 = lowPaper
    expect(decodeErrorState('0x80')).toEqual(['lowPaper']);
    // 0x24 = bits 2 and 5 = lowToner + jammed
    expect(decodeErrorState('0x24')).toEqual(['lowToner', 'jammed']);
    // Second byte: 0x2000 -> bit 10 = markerSupplyMissing
    expect(decodeErrorState('0x2000')).toEqual(['markerSupplyMissing']);
  });

  it('accepts spaced hex and a bare decimal byte', () => {
    expect(decodeErrorState('24 00')).toEqual(['lowToner', 'jammed']);
    expect(decodeErrorState('128')).toEqual(['lowPaper']);
  });

  it('returns [] for no errors, an empty value, or an unparseable one', () => {
    expect(decodeErrorState('0x00')).toEqual([]);
    expect(decodeErrorState('')).toEqual([]);
    expect(decodeErrorState(null)).toEqual([]);
    expect(decodeErrorState('not-a-bitmask')).toEqual([]);
  });
});

describe('readStatusWords', () => {
  it('decodes both status enums and the error bits', () => {
    expect(readStatusWords(xerox)).toEqual({
      printerStatus: 'idle',
      deviceStatus: 'warning',
      errors: ['markerSupplyMissing'],
    });
  });

  it('returns nulls, not guesses, when the status OIDs were not collected', () => {
    expect(readStatusWords({ ...xerox, oids: [] })).toEqual({
      printerStatus: null,
      deviceStatus: null,
      errors: [],
    });
  });
});

describe('summariseDeltas', () => {
  it('reads yesterday from the last bucket and last week from the last seven', () => {
    const points: Array<[string, number]> = [
      ['2026-09-08', 100], ['2026-09-09', 90], ['2026-09-10', 80], ['2026-09-11', 70],
      ['2026-09-12', 60], ['2026-09-13', 50], ['2026-09-14', 40], ['2026-09-15', 30],
    ];
    expect(summariseDeltas(points)).toEqual({ yesterday: 30, lastWeek: 420 });
  });

  it('returns nulls when there is not enough history to claim either number', () => {
    expect(summariseDeltas([])).toEqual({ yesterday: null, lastWeek: null });
    expect(summariseDeltas([['2026-09-15', 30]])).toEqual({ yesterday: 30, lastWeek: null });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/health/printerMib.test.ts
```
Expected: `Failed to resolve import "./printerMib"`.

- [ ] **Step 3: Implement `printerMib.ts`**

```ts
// Pure RFC 3805 / HOST-RESOURCES-MIB decoding for the printer Health card.
// Kept out of the component so every table below is unit-testable against a
// real device's `collection` payload without rendering anything.
//
// The OIDs and names match the shipped built-in "Generic Printer (RFC 3805)"
// template seed (apps/api/migrations/2026-05-22-snmp-multi-vendor-templates.sql).

import type { Collection, CollectionOid, CollectionOidInstance } from '../types';

export const PRINTER_OIDS = {
  deviceStatus: '1.3.6.1.2.1.25.3.2.1.5',
  printerStatus: '1.3.6.1.2.1.25.3.5.1.1',
  detectedErrorState: '1.3.6.1.2.1.25.3.5.1.2',
  lifeCount: '1.3.6.1.2.1.43.10.2.1.4',
  suppliesType: '1.3.6.1.2.1.43.11.1.1.5',
  suppliesDescription: '1.3.6.1.2.1.43.11.1.1.6',
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9',
  colorantValue: '1.3.6.1.2.1.43.12.1.1.4',
} as const;

// hrPrinterStatus (1.3.6.1.2.1.25.3.5.1.1), RFC 2790.
export const HR_PRINTER_STATUS: Record<number, string> = {
  1: 'other', 2: 'unknown', 3: 'idle', 4: 'printing', 5: 'warmup',
};

// hrDeviceStatus (1.3.6.1.2.1.25.3.2.1.5), RFC 2790.
export const HR_DEVICE_STATUS: Record<number, string> = {
  1: 'unknown', 2: 'running', 3: 'warning', 4: 'testing', 5: 'down',
};

// hrPrinterDetectedErrorState (1.3.6.1.2.1.25.3.5.1.2) is an OCTET STRING of
// BITS: bit 0 is the MOST significant bit of the first byte.
export const PRINTER_ERROR_BITS = [
  'lowPaper', 'noPaper', 'lowToner', 'noToner', 'doorOpen', 'jammed', 'offline', 'serviceRequested',
  'inputTrayMissing', 'outputTrayMissing', 'markerSupplyMissing', 'outputNearFull', 'outputFull',
  'inputTrayEmpty', 'overduePreventMaint',
] as const;

function oidRows(collection: Collection | null, baseOid: string): CollectionOidInstance[] {
  if (!collection) return [];
  const entry: CollectionOid | undefined = collection.oids.find((o) => o.baseOid === baseOid);
  return entry?.instances ?? [];
}

function byInstance(rows: CollectionOidInstance[]): Map<string, string | null> {
  return new Map(rows.map((row) => [row.instance, row.value]));
}

function toInt(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

export type SupplyReading = {
  instance: string;
  description: string | null;
  colorant: string | null;
  level: number | null;
  maxCapacity: number | null;
  percent: number | null;
  unknown: boolean;
};

/**
 * One reading per supply, joined across the four supply OIDs BY INSTANCE
 * INDEX. Position-based joining breaks the moment a walk returns supplies out
 * of order or skips an index, which real printers do.
 */
export function groupSupplies(collection: Collection | null): SupplyReading[] {
  const levels = oidRows(collection, PRINTER_OIDS.suppliesLevel);
  if (levels.length === 0) return [];

  const descriptions = byInstance(oidRows(collection, PRINTER_OIDS.suppliesDescription));
  const capacities = byInstance(oidRows(collection, PRINTER_OIDS.suppliesMaxCapacity));
  const colorants = byInstance(oidRows(collection, PRINTER_OIDS.colorantValue));

  return levels.map((row) => {
    const level = toInt(row.value);
    const maxCapacity = toInt(capacities.get(row.instance) ?? null);
    // RFC 3805 encodes "other"/"unknown"/"some remaining" as -1/-2/-3 on the
    // level and -1/-2 on the capacity. All of them mean "there is no number to
    // draw" — a negative meter or a bar past 100% is worse than saying unknown.
    const unknown = level === null || level < 0 || maxCapacity === null || maxCapacity <= 0;
    return {
      instance: row.instance,
      description: descriptions.get(row.instance) ?? null,
      colorant: colorants.get(row.instance) ?? null,
      level,
      maxCapacity,
      percent: unknown ? null : Math.max(0, Math.min(100, Math.round((level! / maxCapacity!) * 100))),
      unknown,
    };
  });
}

export function lowestSupply(collection: Collection | null): SupplyReading | null {
  const known = groupSupplies(collection).filter((s) => s.percent !== null);
  if (known.length === 0) return null;
  return known.reduce((lowest, s) => (s.percent! < lowest.percent! ? s : lowest));
}

export function readPageCount(collection: Collection | null): { instanceOid: string; value: number } | null {
  const rows = oidRows(collection, PRINTER_OIDS.lifeCount);
  for (const row of rows) {
    const value = toInt(row.value);
    if (value !== null && value >= 0) return { instanceOid: row.oid, value };
  }
  return null;
}

/** Decodes the BITS octet string; tolerates hex ("0x0C", "0c 00") and a decimal byte. */
export function decodeErrorState(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  let bytes: number[] | null = null;
  const hex = trimmed.replace(/^0x/i, '').replace(/\s+/g, '');
  if (/^[0-9a-f]+$/i.test(hex) && (/^0x/i.test(trimmed) || /\s/.test(trimmed) || /[a-f]/i.test(hex))) {
    const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
    bytes = [];
    for (let i = 0; i < padded.length; i += 2) bytes.push(Number.parseInt(padded.slice(i, i + 2), 16));
  } else if (/^\d+$/.test(trimmed)) {
    // A plain decimal is a single byte from a legacy agent's integer parse.
    const n = Number.parseInt(trimmed, 10);
    bytes = n <= 0xff ? [n] : [(n >> 8) & 0xff, n & 0xff];
  }
  if (bytes === null) return [];

  const set: string[] = [];
  PRINTER_ERROR_BITS.forEach((name, bit) => {
    const byte = bytes![bit >> 3];
    if (byte !== undefined && (byte & (0x80 >> (bit & 7))) !== 0) set.push(name);
  });
  return set;
}

export function readStatusWords(collection: Collection | null): {
  printerStatus: string | null;
  deviceStatus: string | null;
  errors: string[];
} {
  const printerRow = oidRows(collection, PRINTER_OIDS.printerStatus)[0];
  const deviceRow = oidRows(collection, PRINTER_OIDS.deviceStatus)[0];
  const errorRow = oidRows(collection, PRINTER_OIDS.detectedErrorState)[0];
  const printerValue = toInt(printerRow?.value);
  const deviceValue = toInt(deviceRow?.value);
  return {
    printerStatus: printerValue === null ? null : (HR_PRINTER_STATUS[printerValue] ?? null),
    deviceStatus: deviceValue === null ? null : (HR_DEVICE_STATUS[deviceValue] ?? null),
    errors: decodeErrorState(errorRow?.value ?? null),
  };
}

/** `points` are already reset-aware deltas (`/metrics?delta=1`, bucket=1d), oldest first. */
export function summariseDeltas(points: Array<[string, number]>): {
  yesterday: number | null;
  lastWeek: number | null;
} {
  if (points.length === 0) return { yesterday: null, lastWeek: null };
  const yesterday = points[points.length - 1][1];
  // Claiming a week from fewer than seven buckets would under-report it as a
  // fact rather than a partial window, so it stays null.
  const lastWeek = points.length >= 7
    ? points.slice(-7).reduce((sum, [, value]) => sum + value, 0)
    : null;
  return { yesterday, lastWeek };
}
```

- [ ] **Step 4: Green on the decoder**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/health/printerMib.test.ts
```
Expected: all cases pass.

- [ ] **Step 5: Extract the fixture**

Both tests need the Xerox collection, so move it out of the decoder test into `apps/web/src/components/devices/networkDevice/health/printerMib.fixtures.ts`, exporting `walkOid` and `xeroxCollection`, and import it from `printerMib.test.ts` in place of the inline `xerox` const. A duplicated fixture is how the two suites end up asserting different devices.

- [ ] **Step 6: Red — the card**

Create `apps/web/src/components/devices/networkDevice/health/PrinterHealth.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrinterHealth } from './PrinterHealth';
import { xeroxCollection } from './printerMib.fixtures';
import { fetchWithAuth } from '../../../../stores/auth';
import type { Collection } from '../types';

vi.mock('../../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const deltaSeries = {
  series: [{
    oid: '1.3.6.1.2.1.43.10.2.1.4.1.1',
    instance: '1.1',
    name: 'prtMarkerLifeCount',
    points: [
      ['2026-09-08', 100], ['2026-09-09', 90], ['2026-09-10', 80], ['2026-09-11', 70],
      ['2026-09-12', 60], ['2026-09-13', 50], ['2026-09-14', 40], ['2026-09-15', 30],
    ],
  }],
};

function renderCard(collection: Collection | null = xeroxCollection) {
  return render(
    <PrinterHealth
      assetId="a1"
      assetType="printer"
      collection={collection}
      snmpEnabled
      timezone="UTC"
      onSetUpMonitoring={vi.fn()}
      onViewMonitoring={vi.fn()}
    />,
  );
}

describe('PrinterHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(json(deltaSeries));
  });

  it('renders one labelled meter per supply with the percentage written out', () => {
    renderCard();
    expect(screen.getAllByTestId(/^network-detail-supply-/)).toHaveLength(5);

    const cyan = screen.getByTestId('network-detail-supply-1.1');
    expect(cyan.textContent).toContain('Cyan Toner Cartridge');
    expect(cyan.textContent).toContain('37');

    // Never color alone: the meter exposes its value to assistive tech too.
    const bar = cyan.querySelector('[role="meter"]')!;
    expect(bar).toHaveAttribute('aria-valuenow', '37');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-label', expect.stringContaining('Cyan Toner Cartridge'));
  });

  it('shows a negative level as unknown and draws no bar for it', () => {
    renderCard();
    const waste = screen.getByTestId('network-detail-supply-1.5');
    expect(waste.textContent).toContain('Waste Toner Container');
    expect(waste.textContent).toContain('Unknown');
    expect(waste.querySelector('[role="meter"]')).toBeNull();
    // -3 ("some remaining") must never be printed as a number.
    expect(waste.textContent).not.toContain('-3');
  });

  it('marks a supply at or below the low threshold with the word Low, not just a color', () => {
    renderCard();
    expect(screen.getByTestId('network-detail-supply-1.1').textContent).toContain('Low');
    expect(screen.getByTestId('network-detail-supply-1.3').textContent).not.toContain('Low');
  });

  it('renders decoded status words and error conditions', () => {
    renderCard();
    const status = screen.getByTestId('network-detail-printer-status').textContent ?? '';
    expect(status).toContain('Idle');
    expect(status).toContain('Warning');
    expect(screen.getByTestId('network-detail-printer-errors').textContent).toContain('Supply missing');
  });

  it('renders no error chips when the bitmask is clear', () => {
    const clean: Collection = {
      ...xeroxCollection,
      oids: xeroxCollection.oids.map((entry) =>
        entry.baseOid === '1.3.6.1.2.1.25.3.5.1.2'
          ? { ...entry, instances: [{ ...entry.instances[0], value: '0x00' }] }
          : entry,
      ),
    };
    renderCard(clean);
    expect(screen.queryByTestId('network-detail-printer-errors')).toBeNull();
  });

  it('requests eight days of daily deltas for the page count', async () => {
    renderCard();
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const url = fetchWithAuthMock.mock.calls[0][0] as string;
    expect(url).toContain('/monitoring/assets/a1/metrics');
    expect(url).toContain(encodeURIComponent('1.3.6.1.2.1.43.10.2.1.4.1.1'));
    expect(url).toContain('bucket=1d');
    expect(url).toContain('delta=1');
  });

  it('renders the page count with both deltas once the metrics call resolves', async () => {
    renderCard();
    expect(await screen.findByTestId('network-detail-page-count')).toHaveTextContent('184,230');
    const deltas = (await screen.findByTestId('network-detail-page-deltas')).textContent ?? '';
    expect(deltas).toContain('30');
    expect(deltas).toContain('420');
  });

  it('does not claim a delta when the metrics call fails', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ error: 'nope' }, 500));
    renderCard();
    expect(await screen.findByTestId('network-detail-page-count')).toHaveTextContent('184,230');
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(screen.queryByTestId('network-detail-page-deltas')).toBeNull();
  });

  it('does not claim a week from fewer than seven buckets', async () => {
    fetchWithAuthMock.mockResolvedValue(json({
      series: [{ oid: 'x', instance: '1.1', name: 'prtMarkerLifeCount', points: [['2026-09-15', 30]] }],
    }));
    renderCard();
    const deltas = (await screen.findByTestId('network-detail-page-deltas')).textContent ?? '';
    expect(deltas).toContain('30');
    expect(deltas).not.toContain('week');
  });

  it('says the OIDs are not collected yet instead of rendering an empty card (pre-W02 agents)', () => {
    renderCard({
      ...xeroxCollection,
      oids: xeroxCollection.oids.map((entry) => ({ ...entry, state: 'unknown' as const, instances: [] })),
    });
    expect(screen.getByTestId('network-detail-health-unavailable').textContent).toContain('update the agent');
    expect(screen.queryAllByTestId(/^network-detail-supply-/)).toHaveLength(0);
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('explains a missing template rather than an agent problem', () => {
    renderCard({ ...xeroxCollection, templateId: null, status: 'no_template', oids: [] });
    expect(screen.getByTestId('network-detail-health-no-template')).toBeInTheDocument();
    expect(screen.queryByTestId('network-detail-health-unavailable')).toBeNull();
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/health/PrinterHealth.test.tsx
```
Expected: `Failed to resolve import "./PrinterHealth"` — eleven failing cases.

- [ ] **Step 8: Implement `PrinterHealth.tsx`**

```tsx
// The printer Health card. Every number here is a claim about a physical
// consumable, so each one is either shown with its unit or shown as unknown —
// there is no in-between. A negative prtMarkerSuppliesLevel (RFC 3805's
// "other"/"unknown"/"some remaining") is the case that used to render as a
// negative bar; it now renders as the word.

import { useTranslation } from 'react-i18next';
import { formatNumber, formatPercent } from '@/lib/i18n/format';
import { Section } from '../primitives';
import { useAssetMetrics } from '../useAssetMetrics';
import {
  groupSupplies,
  readPageCount,
  readStatusWords,
  summariseDeltas,
  type SupplyReading,
} from './printerMib';
import type { HealthCardProps } from './types';

/** At or below this, the supply is called out in words as well as color. */
const LOW_SUPPLY_PERCENT = 20;
/** One request covers both deltas: yesterday is the last bucket, the week is the last seven. */
const PAGE_COUNT_WINDOW_MS = 8 * 86_400_000;

function SupplyMeter({ supply }: { supply: SupplyReading }) {
  const { t } = useTranslation('devices');
  const label =
    supply.description
    ?? supply.colorant
    ?? t('networkDeviceDetailPage.printer.supplyFallback', { instance: supply.instance });
  const low = supply.percent !== null && supply.percent <= LOW_SUPPLY_PERCENT;

  return (
    <div data-testid={`network-detail-supply-${supply.instance}`}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums">
          {supply.percent === null ? (
            <span aria-label={t('common:states.unknown')}>{t('common:states.unknown')}</span>
          ) : (
            <>
              {formatPercent(supply.percent / 100, { maximumFractionDigits: 0 })}
              {/* The word, not only the warning hue — color alone is not a signal. */}
              {low && <span className="ml-1 text-warning">{t('networkDeviceDetailPage.printer.low')}</span>}
            </>
          )}
        </span>
      </div>
      {supply.percent !== null && (
        <div
          role="meter"
          aria-valuenow={supply.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
          className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full rounded-full ${low ? 'bg-warning' : 'bg-primary'}`}
            style={{ width: `${supply.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function PrinterHealth({
  assetId,
  collection,
  onSetUpMonitoring,
}: HealthCardProps) {
  const { t } = useTranslation('devices');
  const supplies = groupSupplies(collection);
  const pageCount = readPageCount(collection);
  const { printerStatus, deviceStatus, errors } = readStatusWords(collection);

  // `oid: null` suspends the hook, so a printer with no page-count OID makes no
  // request at all rather than firing one that can only 400.
  const { series, error: deltaError } = useAssetMetrics({
    assetId,
    oid: pageCount?.instanceOid ?? null,
    range: '7d',
    windowMs: PAGE_COUNT_WINDOW_MS,
    bucket: '1d',
    delta: true,
  });
  const deltas = summariseDeltas(series[0]?.points ?? []);

  if (collection?.status === 'no_template') {
    return (
      <Section title={t('networkDeviceDetailPage.sections.printerHealth')} testId="network-detail-health">
        <p className="text-sm text-muted-foreground" data-testid="network-detail-health-no-template">
          {t('networkDeviceDetailPage.health.noTemplate')}
        </p>
        <button
          type="button"
          data-testid="network-detail-health-pick-template"
          onClick={onSetUpMonitoring}
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.health.pickTemplate')}
        </button>
      </Section>
    );
  }

  // Nothing readable yet. The honest cause on a legacy agent is that it issues
  // a GET against column OIDs and stores nulls (spec §1 F3) — name the fix.
  if (supplies.length === 0 && pageCount === null && printerStatus === null) {
    return (
      <Section title={t('networkDeviceDetailPage.sections.printerHealth')} testId="network-detail-health">
        <p className="text-sm text-muted-foreground" data-testid="network-detail-health-unavailable">
          {t('networkDeviceDetailPage.collection.unknownNeedsAgentUpdate')}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t('networkDeviceDetailPage.sections.printerHealth')} testId="network-detail-health">
      {(printerStatus || deviceStatus) && (
        <p className="text-sm" data-testid="network-detail-printer-status">
          {printerStatus && t(/* i18n-dynamic */ `networkDeviceDetailPage.printer.status.${printerStatus}`)}
          {printerStatus && deviceStatus && ' · '}
          {deviceStatus && t(/* i18n-dynamic */ `networkDeviceDetailPage.printer.deviceStatus.${deviceStatus}`)}
        </p>
      )}

      {errors.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" data-testid="network-detail-printer-errors">
          {errors.map((bit) => (
            <li
              key={bit}
              className="rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-xs text-warning"
            >
              {t(/* i18n-dynamic */ `networkDeviceDetailPage.printer.errors.${bit}`)}
            </li>
          ))}
        </ul>
      )}

      {supplies.length > 0 && (
        <div className="mt-3 space-y-2 border-t pt-3">
          {supplies.map((supply) => (
            <SupplyMeter key={supply.instance} supply={supply} />
          ))}
        </div>
      )}

      {pageCount && (
        <div className="mt-3 border-t pt-3 text-sm">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.printer.pageCount')}</dt>
          <dd className="font-medium tabular-nums" data-testid="network-detail-page-count">
            {formatNumber(pageCount.value)}
          </dd>
          {/* Absent deltas stay absent: "0 since yesterday" is a different
              claim from "we could not read yesterday". */}
          {!deltaError && (deltas.yesterday !== null || deltas.lastWeek !== null) && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="network-detail-page-deltas">
              {[
                deltas.yesterday !== null
                  ? t('networkDeviceDetailPage.printer.sinceYesterday', { count: deltas.yesterday })
                  : null,
                deltas.lastWeek !== null
                  ? t('networkDeviceDetailPage.printer.sinceLastWeek', { count: deltas.lastWeek })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
```

- [ ] **Step 9: English keys**

```json
  "printer": {
    "low": "Low",
    "supplyFallback": "Supply {{instance}}",
    "pageCount": "Lifetime pages",
    "sinceYesterday": "{{count}} since yesterday",
    "sinceLastWeek": "{{count}} in the last week",
    "status": { "other": "Other", "unknown": "Unknown", "idle": "Idle", "printing": "Printing", "warmup": "Warming up" },
    "deviceStatus": { "unknown": "Unknown", "running": "Running", "warning": "Warning", "testing": "Testing", "down": "Down" },
    "errors": {
      "lowPaper": "Paper low", "noPaper": "Out of paper", "lowToner": "Toner low", "noToner": "Out of toner",
      "doorOpen": "Door open", "jammed": "Paper jam", "offline": "Offline", "serviceRequested": "Service required",
      "inputTrayMissing": "Input tray missing", "outputTrayMissing": "Output tray missing",
      "markerSupplyMissing": "Supply missing", "outputNearFull": "Output tray nearly full",
      "outputFull": "Output tray full", "inputTrayEmpty": "Input tray empty",
      "overduePreventMaint": "Maintenance overdue"
    }
  },
```
and `sections.printerHealth: "Printer health"`.

- [ ] **Step 10: Green + commit**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/health/printerMib.test.ts \
  src/components/devices/networkDevice/health/PrinterHealth.test.tsx
git add apps/web/src/components/devices/networkDevice/health apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): printer health card with supplies, page counts and decoded status

Supplies are joined across the four Printer-MIB supply OIDs by instance index
(a walk can reorder or skip indices), any negative level renders as "unknown"
rather than a negative meter, page counts carry since-yesterday/since-last-week
deltas from one /metrics?delta=1 call, and hrPrinterStatus/hrDeviceStatus/
hrPrinterDetectedErrorState are decoded into words and chips. All decoding is
pure and tested against a Xerox C325 fixture built from the spec.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: condensed Identity, copy buttons, and the "All scan details" disclosure

Overview row 2 (§11): name, IP/MAC with copy buttons, make/model, `NIC vendor` **only when it differs from manufacturer**, site, "Same device as X". Everything else — hostname, NetBIOS, OS fingerprint, first seen, discovery methods, profile, raw sysObjectID, the legacy `is_online` verdict — moves behind an "All scan details" disclosure.

**W04 has already deleted the inline type editor** (`pendingEdit`, `changeType`, `handleSaveType`, `handleResetType`, the `network-asset-type-select` control) and replaced it with the type as text plus the `manuallySet` / `manuallySetWithDetected` provenance line and an "Edit in settings" button (`network-detail-edit-identity`). **Keep all three** when you restructure the card — this task condenses and reorganises what W04 left, it does not remove controls again. Start by reading the current `NetworkDeviceDetailPage.tsx` on your branch rather than assuming the pre-W04 shape described in the spec's §1.

**Decision:** there is no shared copy-to-clipboard helper in `apps/web` (nine call sites each hand-roll `navigator.clipboard.writeText`). Rather than a repo-wide refactor inside a page wave, W05 adds a local `networkDevice/CopyButton.tsx` and notes extracting a shared one as a follow-up.

**Decision:** the disclosure is a native `<details>`/`<summary>` — it is keyboard- and screen-reader-correct for free, and there is no shared disclosure component to reuse.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/CopyButton.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/devices/networkDevice/IdentityCard.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` (render `IdentityCard` in place of the inline block)

**Interfaces:**
```ts
export function CopyButton(props: {
  value: string;
  /** Names what is being copied, e.g. "IP address" — becomes the aria-label. */
  label: string;
  testId: string;
  onCopied?: (message: string) => void;
}): JSX.Element;

export function IdentityCard(props: {
  asset: DiscoveredAsset;
  extras: NetworkAssetExtras;
  timezone: string;
  onAnnounce: (message: string) => void;
  onEditIdentity: () => void;
}): JSX.Element;
```

- [ ] **Step 1: Red — `CopyButton`**

Create `apps/web/src/components/devices/networkDevice/CopyButton.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

function setClipboard(writeText: ((value: string) => Promise<void>) | null) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

afterEach(() => {
  setClipboard(null);
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('names what it copies for assistive tech', () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" />);
    expect(screen.getByTestId('copy-ip')).toHaveAttribute('aria-label', expect.stringContaining('IP address'));
  });

  it('copies the value, announces it, and shows a transient confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const onCopied = vi.fn();
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" onCopied={onCopied} />);

    await userEvent.click(screen.getByTestId('copy-ip'));

    expect(writeText).toHaveBeenCalledWith('10.0.0.9');
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith(expect.stringContaining('Copied')));
    expect(screen.getByTestId('copy-ip').textContent).toContain('Copied');
  });

  it('clears the confirmation after two seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" />);

    await user.click(screen.getByTestId('copy-ip'));
    await waitFor(() => expect(screen.getByTestId('copy-ip').textContent).toContain('Copied'));

    await vi.advanceTimersByTimeAsync(2_100);
    await waitFor(() => expect(screen.getByTestId('copy-ip').textContent).not.toContain('Copied'));
  });

  it('does not claim success when the clipboard API is missing', async () => {
    setClipboard(null);
    const onCopied = vi.fn();
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" onCopied={onCopied} />);
    await userEvent.click(screen.getByTestId('copy-ip'));
    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.getByTestId('copy-ip').textContent).not.toContain('Copied');
  });

  it('does not claim success when the write is rejected', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const onCopied = vi.fn();
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" onCopied={onCopied} />);
    await userEvent.click(screen.getByTestId('copy-ip'));
    await waitFor(() => expect(screen.getByTestId('copy-ip').textContent).not.toContain('Copied'));
    expect(onCopied).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/CopyButton.test.tsx
```
Expected: `Failed to resolve import "./CopyButton"`.

- [ ] **Step 3: Implement `CopyButton.tsx`**

```tsx
// A local copy control for the identity card. There is no shared clipboard
// helper in apps/web (nine call sites each hand-roll navigator.clipboard), and
// extracting one is a repo-wide refactor that does not belong in a page wave.
//
// The "Copied" label is a CLAIM: a missing clipboard API (non-secure context,
// an older browser) and a rejected write must both leave it unsaid, or the
// operator pastes nothing and blames the paste target.

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const CONFIRMATION_MS = 2_000;

export function CopyButton({
  value,
  label,
  testId,
  onCopied,
}: {
  value: string;
  label: string;
  testId: string;
  onCopied?: (message: string) => void;
}) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Denied or unavailable — say nothing rather than claim a copy.
      return;
    }
    setCopied(true);
    onCopied?.(t('states.copied'));
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), CONFIRMATION_MS);
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={`${t('actions.copy')} ${label}`}
      onClick={() => void handleCopy()}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : <Copy aria-hidden="true" className="h-3.5 w-3.5" />}
      {copied && <span>{t('states.copied')}</span>}
    </button>
  );
}
```

- [ ] **Step 4: Red — `IdentityCard`**

Create `apps/web/src/components/devices/networkDevice/IdentityCard.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IdentityCard } from './IdentityCard';
import type { NetworkAssetExtras } from './types';
import type { DiscoveredAsset } from '../../discovery/DiscoveredAssetList';

const baseAsset: DiscoveredAsset = {
  id: 'a1',
  ip: '10.0.0.9',
  mac: 'aa:bb:cc:dd:ee:ff',
  hostname: 'prn-01',
  label: 'Front desk printer',
  type: 'printer',
  approvalStatus: 'approved',
  isOnline: true,
  manufacturer: 'Xerox',
  lastSeen: '2026-09-16T10:00:00.000Z',
  openPorts: [],
  osFingerprint: 'IOS-XE',
  snmpData: { sysObjectId: '.1.3.6.1.4.1.253.8.62.1.37.1.4.1.1' },
  responseTimeMs: 3.1,
  linkedDeviceId: null,
  linkedDeviceName: undefined,
  typeSource: 'auto',
  detectedType: 'printer',
  discoveryMethods: ['arp', 'snmp'],
  notes: null,
  tags: [],
  profileName: 'HQ LAN',
};

const baseExtras: NetworkAssetExtras = {
  model: 'C325 Color MFP',
  netbiosName: 'PRN01',
  siteId: 'site-1',
  siteName: 'HQ',
  siteTimezone: 'UTC',
  firstSeenAt: '2026-05-01T10:07:32.000Z',
  nicVendor: 'LEXMARK INTERNATIONAL, INC.',
};

function renderIdentity(
  asset: Partial<DiscoveredAsset> = {},
  extras: Partial<NetworkAssetExtras> = {},
) {
  return render(
    <IdentityCard
      asset={{ ...baseAsset, ...asset }}
      extras={{ ...baseExtras, ...extras }}
      timezone={extras.siteTimezone ?? 'UTC'}
      onAnnounce={vi.fn()}
      onEditIdentity={vi.fn()}
    />,
  );
}

describe('IdentityCard', () => {
  it('copies the IP and the MAC', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderIdentity();

    await userEvent.click(screen.getByTestId('network-detail-copy-ip'));
    expect(writeText).toHaveBeenLastCalledWith('10.0.0.9');

    await userEvent.click(screen.getByTestId('network-detail-copy-mac'));
    expect(writeText).toHaveBeenLastCalledWith('aa:bb:cc:dd:ee:ff');
  });

  it('shows the NIC vendor only when it differs from the manufacturer', () => {
    const { unmount } = renderIdentity();
    expect(screen.getByTestId('network-detail-nic-vendor').textContent).toContain('LEXMARK');
    unmount();

    renderIdentity({ manufacturer: 'Lexmark International, Inc.' }, { nicVendor: 'LEXMARK INTERNATIONAL, INC.' });
    expect(screen.queryByTestId('network-detail-nic-vendor')).toBeNull();
  });

  it('links "Same device as" to the managed device when linked', () => {
    renderIdentity({ linkedDeviceId: 'dev-9', linkedDeviceName: 'PRN-01' });
    const link = screen.getByTestId('network-detail-linked-device');
    expect(link).toHaveAttribute('href', '/devices/dev-9');
    expect(link.textContent).toContain('PRN-01');
  });

  it('keeps scan internals behind the disclosure, closed by default', async () => {
    renderIdentity();
    const details = screen.getByTestId('network-detail-scan-details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByTestId('network-detail-identity-primary').textContent).not.toContain('IOS-XE');

    await userEvent.click(screen.getByTestId('network-detail-scan-details-toggle'));
    expect(details).toHaveAttribute('open');
    expect(details.textContent).toContain('IOS-XE');
    expect(details.textContent).toContain('PRN01');
    expect(details.textContent).toContain('HQ LAN');
    expect(details.textContent).toContain('arp, snmp');
  });

  it('renders First seen without seconds and with an absolute title', async () => {
    renderIdentity();
    await userEvent.click(screen.getByTestId('network-detail-scan-details-toggle'));
    const firstSeen = screen.getByTestId('network-detail-first-seen');
    expect(firstSeen.textContent).toContain('10:07');
    expect(firstSeen.textContent).not.toContain(':32');
  });

  it('exposes the raw sysObjectID and the legacy scan verdict as scan details only', async () => {
    renderIdentity();
    expect(screen.getByTestId('network-detail-identity-primary').textContent).not.toContain('1.3.6.1.4.1.253');

    await userEvent.click(screen.getByTestId('network-detail-scan-details-toggle'));
    expect(screen.getByTestId('network-detail-sys-object-id').textContent).toContain('1.3.6.1.4.1.253');
    // The scan's is_online is a legacy verdict, never the page's status.
    expect(screen.getByTestId('network-detail-legacy-verdict').textContent).toContain('Online');
  });

  it('never renders an OID-shaped model in the Model row', () => {
    renderIdentity({}, { model: null });
    const model = screen.getByTestId('network-detail-model');
    expect(model.textContent).not.toContain('1.3.6.1');
    expect(model.querySelector('[aria-label]')).toHaveAttribute('aria-label', 'Unknown');
  });

  it('keeps W04’s Edit in settings hand-off', async () => {
    const onEditIdentity = vi.fn();
    render(
      <IdentityCard
        asset={baseAsset}
        extras={baseExtras}
        timezone="UTC"
        onAnnounce={vi.fn()}
        onEditIdentity={onEditIdentity}
      />,
    );
    await userEvent.click(screen.getByTestId('network-detail-edit-identity'));
    expect(onEditIdentity).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/IdentityCard.test.tsx
```

- [ ] **Step 6: Implement `IdentityCard.tsx`**

```tsx
// Overview row 2. What is ON the card answers "which device is this"; the
// disclosure below holds what the SCANNER saw, which is troubleshooting detail,
// not identity. Keeping the scan's raw sysObjectID and its is_online verdict
// inside the disclosure is deliberate: both used to read as the device's own
// facts (spec §1 F1, F5) and both are really statements about the last sweep.

import { useTranslation } from 'react-i18next';
import { isManualLink } from '../../discovery/networkTypes';
import { typeConfig, type DiscoveredAsset } from '../../discovery/DiscoveredAssetList';
import { Section, Field } from './primitives';
import { formatTimestamp } from './format';
import { CopyButton } from './CopyButton';
import type { NetworkAssetExtras } from './types';

/** Case- and punctuation-insensitive: "Xerox" and "XEROX CORP." are the same vendor to a reader. */
function sameVendor(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) =>
    (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const left = norm(a);
  const right = norm(b);
  if (left === '' || right === '') return false;
  return left.startsWith(right) || right.startsWith(left);
}

export function IdentityCard({
  asset,
  extras,
  timezone,
  onAnnounce,
  onEditIdentity,
}: {
  asset: DiscoveredAsset;
  extras: NetworkAssetExtras;
  timezone: string;
  onAnnounce: (message: string) => void;
  onEditIdentity: () => void;
}) {
  const { t } = useTranslation('devices');
  const typeMeta = typeConfig[asset.type];
  const typeLabel = typeMeta ? t(/* i18n-dynamic */ typeMeta.labelKey) : asset.type;
  const showNicVendor = Boolean(extras.nicVendor) && !sameVendor(extras.nicVendor, asset.manufacturer);
  const sysObjectId = asset.snmpData?.sysObjectId ?? null;
  const tags = asset.tags ?? [];
  const discoveryMethods = asset.discoveryMethods ?? [];
  const unknown = <span aria-label={t('common:states.unknown')}>—</span>;

  return (
    <Section title={t('networkDeviceDetailPage.sections.identity')} testId="network-detail-identity">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm" data-testid="network-detail-identity-primary">
        <Field label={t('networkDeviceDetailPage.fields.displayName')} value={asset.label || asset.hostname || unknown} />
        <div data-testid="network-detail-identity-type">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.assetType')}</dt>
          <dd className="font-medium">
            {typeLabel}
            {asset.typeSource === 'manual' && (
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {asset.detectedType
                  ? t('networkDeviceDetailPage.manuallySetWithDetected', {
                      type: t(/* i18n-dynamic */ typeConfig[asset.detectedType].labelKey),
                    })
                  : t('networkDeviceDetailPage.manuallySet')}
              </span>
            )}
          </dd>
        </div>

        <div data-testid="network-detail-ip">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.ipAddress')}</dt>
          <dd className="flex items-center gap-1 font-mono font-medium">
            {asset.ip === '—' ? unknown : asset.ip}
            {asset.ip !== '—' && (
              <CopyButton
                value={asset.ip}
                label={t('networkDeviceDetailPage.fields.ipAddress')}
                testId="network-detail-copy-ip"
                onCopied={onAnnounce}
              />
            )}
          </dd>
        </div>
        <div data-testid="network-detail-mac">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.macAddress')}</dt>
          <dd className="flex items-center gap-1 font-mono font-medium">
            {asset.mac === '—' ? unknown : asset.mac}
            {asset.mac !== '—' && (
              <CopyButton
                value={asset.mac}
                label={t('networkDeviceDetailPage.fields.macAddress')}
                testId="network-detail-copy-mac"
                onCopied={onAnnounce}
              />
            )}
          </dd>
        </div>

        <Field
          label={t('networkDeviceDetailPage.fields.manufacturer')}
          value={asset.manufacturer === '—' ? unknown : asset.manufacturer}
        />
        <div data-testid="network-detail-model">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.model')}</dt>
          {/* W01 masks an OID-shaped model server-side; an empty value here is
              an honest "we don't know", never the raw sysObjectID. */}
          <dd className="font-medium break-words">{extras.model || unknown}</dd>
        </div>

        {showNicVendor && (
          <div data-testid="network-detail-nic-vendor">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.nicVendor')}</dt>
            <dd className="font-medium break-words" title={t('networkDeviceDetailPage.fields.nicVendorHint')}>
              {extras.nicVendor}
            </dd>
          </div>
        )}
        <Field label={t('networkDeviceDetailPage.fields.site')} value={extras.siteName || unknown} />

        <div className="col-span-2" data-testid="network-detail-linked">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.linkedDevice')}</dt>
          <dd className="font-medium">
            {asset.linkedDeviceId ? (
              <span className="flex flex-wrap items-center gap-2">
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
              t('networkDeviceDetailPage.notLinked')
            )}
          </dd>
        </div>
      </dl>

      {tags.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.tags')}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <span key={tag} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">{tag}</span>
            ))}
          </div>
        </div>
      )}

      {asset.notes && (
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.notes')}</p>
          <p className="mt-1 text-sm whitespace-pre-wrap">{asset.notes}</p>
        </div>
      )}

      <details className="mt-3 border-t pt-3" data-testid="network-detail-scan-details">
        <summary
          data-testid="network-detail-scan-details-toggle"
          className="cursor-pointer text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.sections.scanDetails')}
        </summary>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Field label={t('networkDeviceDetailPage.fields.hostname')} value={asset.hostname || unknown} />
          <Field label={t('networkDeviceDetailPage.fields.netbiosName')} value={extras.netbiosName || unknown} />
          <Field label={t('networkDeviceDetailPage.fields.osFingerprint')} value={asset.osFingerprint || unknown} />
          <div data-testid="network-detail-first-seen">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.firstSeen')}</dt>
            <dd className="font-medium" title={formatTimestamp(extras.firstSeenAt, timezone)}>
              {formatTimestamp(extras.firstSeenAt, timezone)}
            </dd>
          </div>
          <Field
            label={t('networkDeviceDetailPage.fields.discoveryMethods')}
            value={discoveryMethods.length > 0 ? discoveryMethods.join(', ') : unknown}
          />
          <Field label={t('networkDeviceDetailPage.fields.discoveryProfile')} value={asset.profileName || unknown} />
          <div className="col-span-2" data-testid="network-detail-sys-object-id">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.sysObjectId')}</dt>
            <dd className="font-mono text-xs break-all">{sysObjectId ?? unknown}</dd>
          </div>
          <div className="col-span-2" data-testid="network-detail-legacy-verdict">
            <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.legacyScanVerdict')}</dt>
            <dd className="font-medium">
              {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {t('networkDeviceDetailPage.fields.legacyScanVerdictHint')}
              </span>
            </dd>
          </div>
        </dl>
      </details>

      <button
        type="button"
        data-testid="network-detail-edit-identity"
        onClick={onEditIdentity}
        className="mt-3 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('networkDeviceDetailPage.editInSettings')}
      </button>
    </Section>
  );
}
```

- [ ] **Step 7: Swap the inline block out of the page**

In `NetworkDeviceDetailPage.tsx`, replace the whole Overview `<Section title={…identity}>` block with:

```tsx
            <IdentityCard
              asset={asset}
              extras={extras}
              timezone={timezone}
              onAnnounce={announce}
              onEditIdentity={() => openSettings('identity')}
            />
```
Drop the now-unused `Field`/`typeConfig` imports from the page if nothing else there uses them; `astro check` will name them.

New English keys:
```json
  "fields": {
    "ipAddress": "IP address",
    "macAddress": "MAC address",
    "nicVendor": "NIC vendor",
    "nicVendorHint": "The MAC address's registered vendor, which differs from the device manufacturer when the network card is built by someone else.",
    "site": "Site",
    "sysObjectId": "sysObjectID (raw)",
    "legacyScanVerdict": "Last scan verdict",
    "legacyScanVerdictHint": "— what the last subnet sweep recorded, not live reachability",
    "bridgingAgent": "Bridging agent"
  },
  "editInSettings": "Edit in settings",
  "sections": { "scanDetails": "All scan details" },
```

- [ ] **Step 8: Green + commit**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/CopyButton.test.tsx \
  src/components/devices/networkDevice/IdentityCard.test.tsx \
  src/components/devices/NetworkDeviceDetailPage.test.tsx
git add apps/web/src/components/devices/networkDevice/CopyButton.tsx \
        apps/web/src/components/devices/networkDevice/CopyButton.test.tsx \
        apps/web/src/components/devices/networkDevice/IdentityCard.tsx \
        apps/web/src/components/devices/networkDevice/IdentityCard.test.tsx \
        apps/web/src/components/devices/NetworkDeviceDetailPage.tsx \
        apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx \
        apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): condensed identity with copy buttons and a scan-details disclosure

Identity now shows what identifies the device; hostname, NetBIOS, OS
fingerprint, first seen, discovery methods, profile, the raw sysObjectID and
the legacy is_online verdict move behind "All scan details" — the last two
because both read as device facts when they are really statements about the
last sweep. NIC vendor appears only when it differs from the manufacturer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 9: Monitoring tab — poll config, OID table, checks, thresholds (+ the thresholds route)

The Monitoring tab replaces its two "Enabled / Not configured" rows with what is actually happening. This task ships everything but the charts (Task 10).

**Decision:** there is **no live read route for SNMP threshold alerts** — `GET /snmp/thresholds/:deviceId` is a `410` deprecation stub (`apps/api/src/routes/snmp.ts:608`) and W01 adds none. W05 adds a small read-only `GET /monitoring/assets/:id/thresholds` beside the existing `/monitoring/assets/:id`, reusing its exact org-resolution and site-access guards. Network checks need no new route: `GET /monitors?assetId=<id>` already returns `lastStatus`, `lastChecked`, `lastResponseMs` and `lastError` per monitor.

**Decision:** the template **name** is not on the `/monitoring/assets/:id` response (`serializeSnmpDevice` returns `templateId` only), so `useAssetMonitoring` makes a fourth parallel call to the existing `GET /snmp/templates` and resolves id → name locally. Showing a bare uuid where a template name belongs is the same failure as the raw sysObjectID in Model.

**Files:**
- Modify: `apps/api/src/routes/monitoring.ts`
- Create: `apps/api/src/routes/monitoring_assets_thresholds.test.ts`
- Create: `apps/web/src/components/devices/networkDevice/useAssetMonitoring.ts` (+ `.test.ts`)
- Create: `apps/web/src/components/devices/networkDevice/PollConfigSummary.tsx`
- Create: `apps/web/src/components/devices/networkDevice/OidTable.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/devices/networkDevice/NetworkChecksSection.tsx`
- Create: `apps/web/src/components/devices/networkDevice/ThresholdAlertsSection.tsx`
- Create: `apps/web/src/components/devices/networkDevice/MonitoringTab.tsx`

**Interfaces:**
```ts
export type SnmpDeviceSummary = {
  id: string; templateId: string | null; pollingInterval: number; port: number;
  snmpVersion: string; isActive: boolean; lastPolled: string | null; lastStatus: string | null;
};
export type NetworkCheckSummary = {
  id: string; name: string; monitorType: string; target: string;
  isActive: boolean; lastStatus: string | null; lastChecked: string | null;
  lastResponseMs: number | null; lastError: string | null; consecutiveFailures: number;
};
export type ThresholdSummary = {
  id: string; oid: string; operator: string | null; threshold: string | null;
  severity: string; message: string | null; isActive: boolean;
};
export function useAssetMonitoring(assetId: string): {
  collection: Collection | null;
  snmpDevice: SnmpDeviceSummary | null;
  templateName: string | null;
  checks: NetworkCheckSummary[];
  thresholds: ThresholdSummary[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
};
```

- [ ] **Step 1: Red — the thresholds route**

Create `apps/api/src/routes/monitoring_assets_thresholds.test.ts`. The mock harness is copied from `monitoring_assets_snmp.test.ts` (same router, same `vi.mock` factories) with `snmpAlertThresholds` added to the schema mock:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  deviceSoftware: {},
  deviceChangeLog: {},
  discoveredAssets: {
    id: 'discoveredAssets.id',
    orgId: 'discoveredAssets.orgId',
    siteId: 'discoveredAssets.siteId',
  },
  networkMonitors: { assetId: 'networkMonitors.assetId', orgId: 'networkMonitors.orgId', isActive: 'networkMonitors.isActive' },
  snmpDevices: { id: 'snmpDevices.id', orgId: 'snmpDevices.orgId', assetId: 'snmpDevices.assetId' },
  snmpMetrics: {},
  snmpTemplates: { id: 'snmpTemplates.id' },
  snmpAlertThresholds: {
    id: 'snmpAlertThresholds.id',
    deviceId: 'snmpAlertThresholds.deviceId',
    oid: 'snmpAlertThresholds.oid',
    operator: 'snmpAlertThresholds.operator',
    threshold: 'snmpAlertThresholds.threshold',
    severity: 'snmpAlertThresholds.severity',
    message: 'snmpAlertThresholds.message',
    isActive: 'snmpAlertThresholds.isActive',
  },
  serviceProcessCheckResults: {},
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const siteHeader = c.req.header('x-restrict-site');
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    if (siteHeader) {
      c.set('permissions', { allowedSiteIds: siteHeader === '__empty__' ? [] : siteHeader.split(',') });
    }
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/redis', () => ({ isRedisAvailable: vi.fn(() => true) }));

import { monitoringRoutes } from './monitoring';
import { db } from '../db';

const ORG_ID = 'org-111';
const ASSET_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const SITE_HIDDEN = 'bbbbbbbb-0000-0000-0000-000000000002';
const THRESHOLD_ID = '44444444-4444-4444-4444-444444444444';

/** `db.select().from().where().limit()` — the asset lookup. */
function mockAssetLookup(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any);
}

/** `db.select().from().innerJoin().where()` — the thresholds join. */
function mockThresholdQuery(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any);
}

const request = (headers: Record<string, string> = {}) =>
  monitoringApp().request(`/monitoring/assets/${ASSET_ID}/thresholds`, {
    headers: { Authorization: 'Bearer token', ...headers },
  });

let app: Hono;
function monitoringApp() {
  return app;
}

describe('GET /monitoring/assets/:id/thresholds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    app = new Hono();
    app.route('/monitoring', monitoringRoutes);
  });

  it('returns the thresholds armed on the asset’s SNMP device', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED }]);
    mockThresholdQuery([
      {
        id: THRESHOLD_ID,
        oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
        operator: 'lt',
        threshold: '10',
        severity: 'high',
        message: 'Toner low',
        isActive: true,
      },
    ]);

    const res = await request();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: THRESHOLD_ID,
      oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
      operator: 'lt',
      threshold: '10',
      severity: 'high',
      message: 'Toner low',
      isActive: true,
    });
  });

  it('returns an empty list when the asset has no SNMP device', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_ALLOWED }]);
    mockThresholdQuery([]);

    const res = await request();

    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it('404s for an asset outside the caller’s org', async () => {
    // The org predicate is part of the WHERE, so a cross-org asset returns no row.
    mockAssetLookup([]);

    const res = await request();

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Asset not found');
    // The thresholds query must never run for an asset we could not resolve.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('403s when the caller has no access to the asset’s site', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: SITE_HIDDEN }]);

    const res = await request({ 'x-restrict-site': SITE_ALLOWED });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Access to this site denied');
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('403s for a site-restricted caller when the asset has no site at all', async () => {
    mockAssetLookup([{ id: ASSET_ID, orgId: ORG_ID, siteId: null }]);

    const res = await request({ 'x-restrict-site': SITE_ALLOWED });

    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/monitoring_assets_thresholds.test.ts
```
Expected: every case 404s with Hono's own "not found" — the route does not exist yet. (Confirm the 404 body is Hono's, not the route's `{ error: 'Asset not found' }`, so the first case is genuinely red rather than accidentally green.)

- [ ] **Step 3: Add the route**

Add `snmpAlertThresholds` to the schema import in `apps/api/src/routes/monitoring.ts`, then, directly after the `GET /assets/:id` handler:

```ts
// The armed SNMP threshold alerts for an asset. The only non-deprecated way to
// read them: /snmp/thresholds/:deviceId is a 410 stub, and the device page has
// to be able to say what will actually fire. Read-only — thresholds are still
// created and edited on the SNMP surfaces.
monitoringRoutes.get(
  '/assets/:id/thresholds',
  requireScope('organization', 'partner', 'system'),
  requireMonitoringRead,
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const assetId = c.req.param('id')!;

    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
    const orgId = orgResult.orgId;
    if (!orgId) return c.json({ error: 'Could not determine organization context' }, 400);

    const [asset] = await db
      .select({ id: discoveredAssets.id, orgId: discoveredAssets.orgId, siteId: discoveredAssets.siteId })
      .from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, assetId), eq(discoveredAssets.orgId, orgId)))
      .limit(1);
    if (!asset) return c.json({ error: 'Asset not found' }, 404);

    // Site scope is an app-layer-only authz axis; RLS does not defend it.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && (typeof asset.siteId !== 'string' || !canAccessSite(perms, asset.siteId))) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    const rows = await db
      .select({
        id: snmpAlertThresholds.id,
        oid: snmpAlertThresholds.oid,
        operator: snmpAlertThresholds.operator,
        threshold: snmpAlertThresholds.threshold,
        severity: snmpAlertThresholds.severity,
        message: snmpAlertThresholds.message,
        isActive: snmpAlertThresholds.isActive,
      })
      .from(snmpAlertThresholds)
      .innerJoin(snmpDevices, eq(snmpAlertThresholds.deviceId, snmpDevices.id))
      .where(and(eq(snmpDevices.assetId, assetId), eq(snmpDevices.orgId, asset.orgId)));

    return c.json({ data: rows });
  }
);
```
The `eq(snmpDevices.orgId, asset.orgId)` join predicate is load-bearing: `snmp_alert_thresholds` has no `org_id` of its own, so the device row is what carries the tenant.

- [ ] **Step 4: Green on the API**

```bash
cd apps/api && npx vitest run src/routes/monitoring_assets_thresholds.test.ts
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c && pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

- [ ] **Step 5: Red — `useAssetMonitoring`**

Create `apps/web/src/components/devices/networkDevice/useAssetMonitoring.test.ts`:

```ts
import '@/lib/i18n';

import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetMonitoring } from './useAssetMonitoring';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const ASSET_ID = 'asset-1';

const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const assetPayload = {
  enabled: true,
  snmpDevice: {
    id: 'snmp-1', templateId: 'tpl-1', pollingInterval: 300, port: 161,
    snmpVersion: 'v2c', isActive: true, lastPolled: '2026-09-16T10:00:00.000Z', lastStatus: 'online',
  },
  collection: {
    templateId: 'tpl-1', lastPolledAt: '2026-09-16T10:00:00.000Z', pollingInterval: 300,
    status: 'ok', consecutiveFailures: 0,
    oids: [{ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast', state: 'collecting', observedAt: '2026-09-16T10:00:00.000Z', instances: [], error: null }],
  },
  networkMonitors: { totalCount: 1, activeCount: 1 },
  recentMetrics: [],
};

const monitorsPayload = {
  data: [{
    id: 'mon-1', orgId: 'org-1', assetId: ASSET_ID, name: 'Ping', monitorType: 'icmp_ping',
    target: '10.0.0.9', config: {}, pollingInterval: 60, timeout: 5, isActive: true,
    lastChecked: '2026-09-16T10:01:00.000Z', lastStatus: 'online', lastResponseMs: 4.2,
    lastError: null, consecutiveFailures: 0,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-16T10:01:00.000Z',
  }],
  total: 1,
};

const thresholdsPayload = {
  data: [{ id: 'th-1', oid: '1.3.6.1.2.1.43.11.1.1.9.1.1', operator: 'lt', threshold: '10', severity: 'high', message: 'Toner low', isActive: true }],
};

const templatesPayload = {
  data: [{ id: 'tpl-1', name: 'Generic Printer (RFC 3805)', source: 'builtin', oidCount: 18 }],
};

/** Answers each of the four parallel calls by URL, in any order. */
function routeFetch(overrides: Partial<Record<'asset' | 'monitors' | 'thresholds' | 'templates', Response>> = {}) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url.includes('/thresholds')) return Promise.resolve(overrides.thresholds ?? json(thresholdsPayload));
    if (url.startsWith('/monitors')) return Promise.resolve(overrides.monitors ?? json(monitorsPayload));
    if (url.startsWith('/snmp/templates')) return Promise.resolve(overrides.templates ?? json(templatesPayload));
    return Promise.resolve(overrides.asset ?? json(assetPayload));
  });
}

describe('useAssetMonitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads collection, checks, thresholds and the template name', async () => {
    routeFetch();
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collection?.oids).toHaveLength(1);
    expect(result.current.snmpDevice?.pollingInterval).toBe(300);
    expect(result.current.templateName).toBe('Generic Printer (RFC 3805)');
    expect(result.current.checks[0].name).toBe('Ping');
    expect(result.current.thresholds[0].severity).toBe('high');
    expect(result.current.error).toBeNull();

    const urls = fetchWithAuthMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toContain(`/monitoring/assets/${ASSET_ID}`);
    expect(urls).toContain(`/monitoring/assets/${ASSET_ID}/thresholds`);
    expect(urls).toContain(`/monitors?assetId=${ASSET_ID}`);
    expect(urls.some((u) => u.startsWith('/snmp/templates'))).toBe(true);
  });

  it('keeps the tab usable when only the thresholds call fails', async () => {
    routeFetch({ thresholds: json({ error: 'boom' }, 500) });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collection?.oids).toHaveLength(1);
    expect(result.current.checks).toHaveLength(1);
    expect(result.current.thresholds).toEqual([]);
    // A degraded panel is not a failed tab.
    expect(result.current.error).toBeNull();
  });

  it('reports an error only when the asset call itself fails', async () => {
    routeFetch({ asset: json({ error: 'nope' }, 500) });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeTruthy();
    expect(result.current.collection).toBeNull();
  });

  it('leaves collection null (not a fabricated empty) on a pre-W01 API', async () => {
    routeFetch({ asset: json({ enabled: false, snmpDevice: null, networkMonitors: { totalCount: 0, activeCount: 0 }, recentMetrics: [] }) });
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.collection).toBeNull();
    expect(result.current.snmpDevice).toBeNull();
    expect(result.current.templateName).toBeNull();
  });

  it('refetches all four on reload', async () => {
    routeFetch();
    const { result } = renderHook(() => useAssetMonitoring(ASSET_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const before = fetchWithAuthMock.mock.calls.length;

    await act(async () => { await result.current.reload(); });

    expect(fetchWithAuthMock.mock.calls.length).toBe(before + 4);
  });
});
```

- [ ] **Step 6: Run it, watch it fail, implement `useAssetMonitoring.ts`**

```ts
// The Monitoring tab's data layer. Four reads in parallel, each allowed to fail
// on its own: a broken thresholds call must degrade ONE panel, not blank a tab
// whose main job is telling the operator what is and isn't being collected.
//
// The template NAME needs the fourth call because /monitoring/assets/:id
// returns templateId only (serializeSnmpDevice) — and a bare uuid where a
// template name belongs is the same failure as a raw sysObjectID in Model.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { asList } from '@/lib/asList';
import type { Collection } from './types';

export type SnmpDeviceSummary = {
  id: string;
  templateId: string | null;
  pollingInterval: number;
  port: number;
  snmpVersion: string;
  isActive: boolean;
  lastPolled: string | null;
  lastStatus: string | null;
};

export type NetworkCheckSummary = {
  id: string;
  name: string;
  monitorType: string;
  target: string;
  isActive: boolean;
  lastStatus: string | null;
  lastChecked: string | null;
  lastResponseMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

export type ThresholdSummary = {
  id: string;
  oid: string;
  operator: string | null;
  threshold: string | null;
  severity: string;
  message: string | null;
  isActive: boolean;
};

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export function useAssetMonitoring(assetId: string) {
  const { t } = useTranslation('devices');
  const [collection, setCollection] = useState<Collection | null>(null);
  const [snmpDevice, setSnmpDevice] = useState<SnmpDeviceSummary | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [checks, setChecks] = useState<NetworkCheckSummary[]>([]);
  const [thresholds, setThresholds] = useState<ThresholdSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [assetResult, monitorsResult, thresholdsResult, templatesResult] = await Promise.allSettled([
      fetchWithAuth(`/monitoring/assets/${assetId}`),
      fetchWithAuth(`/monitors?assetId=${encodeURIComponent(assetId)}`),
      fetchWithAuth(`/monitoring/assets/${assetId}/thresholds`),
      fetchWithAuth('/snmp/templates'),
    ]);

    // The asset call is the only one whose failure means the tab has nothing
    // to say — the other three each own a single panel.
    if (assetResult.status !== 'fulfilled' || !assetResult.value.ok) {
      setError(t('networkDeviceDetailPage.errors.monitoringLoad'));
      setCollection(null);
      setSnmpDevice(null);
      setTemplateName(null);
      setChecks([]);
      setThresholds([]);
      setLoading(false);
      return;
    }

    const assetBody = (await readJson(assetResult.value)) as {
      collection?: Collection | null;
      snmpDevice?: SnmpDeviceSummary | null;
    } | null;
    // A pre-W01 API has no `collection`; null means "we don't know", which the
    // cards render as such. Never substitute an empty Collection — that would
    // read as "a template with no OIDs".
    const nextCollection = assetBody?.collection ?? null;
    const nextDevice = assetBody?.snmpDevice ?? null;
    setCollection(nextCollection);
    setSnmpDevice(nextDevice);

    if (monitorsResult.status === 'fulfilled' && monitorsResult.value.ok) {
      const body = await readJson(monitorsResult.value);
      setChecks(asList(body, 'monitors') as NetworkCheckSummary[]);
    } else {
      setChecks([]);
    }

    if (thresholdsResult.status === 'fulfilled' && thresholdsResult.value.ok) {
      const body = await readJson(thresholdsResult.value);
      setThresholds(asList(body, 'thresholds') as ThresholdSummary[]);
    } else {
      setThresholds([]);
    }

    const templateId = nextCollection?.templateId ?? nextDevice?.templateId ?? null;
    if (templateId && templatesResult.status === 'fulfilled' && templatesResult.value.ok) {
      const body = await readJson(templatesResult.value);
      const templates = asList(body, 'templates') as Array<{ id: string; name: string }>;
      setTemplateName(templates.find((entry) => entry.id === templateId)?.name ?? null);
    } else {
      setTemplateName(null);
    }

    setLoading(false);
  }, [assetId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return { collection, snmpDevice, templateName, checks, thresholds, loading, error, reload: load };
}
```

- [ ] **Step 7: `PollConfigSummary.tsx`**

```tsx
// What the poller is configured to do, and whether it is doing it. The Edit
// button hands off to W04's settings modal — this page shows state, the modal
// owns every write (D7).

import { useTranslation } from 'react-i18next';
import { Section } from './primitives';
import { formatLastPoll, type TFn } from './reachabilityCopy';
import { buildDetailHash } from './settings/settingsHash';
import type { Collection } from './types';
import type { SnmpDeviceSummary } from './useAssetMonitoring';

/** 300 → "every 5 min"; 90 → "every 90 sec". */
export function formatInterval(seconds: number | null | undefined, t: TFn): string {
  if (!seconds || seconds <= 0) return t('common:states.unknown');
  if (seconds % 3600 === 0) return t('networkDeviceDetailPage.poll.everyHours', { count: seconds / 3600 });
  if (seconds % 60 === 0) return t('networkDeviceDetailPage.poll.everyMinutes', { count: seconds / 60 });
  return t('networkDeviceDetailPage.poll.everySeconds', { count: seconds });
}

export function PollConfigSummary({
  collection,
  snmpDevice,
  templateName,
  timezone,
  onEdit,
}: {
  collection: Collection | null;
  snmpDevice: SnmpDeviceSummary | null;
  templateName: string | null;
  timezone: string;
  /** W04's `openSettings('monitoring')` when the page exposes it. */
  onEdit?: () => void;
}) {
  const { t } = useTranslation('devices');
  const tf = t as unknown as TFn;
  const poll = formatLastPoll(collection, tf, timezone);
  const unknown = <span aria-label={t('common:states.unknown')}>—</span>;

  const handleEdit = () => {
    if (onEdit) {
      onEdit();
      return;
    }
    // buildDetailHash returns the hash WITHOUT a leading '#'; the browser adds
    // it. Never hand-build this string — parseDetailHash is the only thing that
    // has to agree with the grammar, and it is W04's.
    window.location.hash = buildDetailHash('monitoring', 'monitoring');
  };

  return (
    <Section title={t('networkDeviceDetailPage.sections.pollConfiguration')} testId="network-detail-poll-config">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div data-testid="network-detail-poll-status">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.pollStatus')}</dt>
          <dd className="font-medium" title={poll.title || undefined}>{poll.label}</dd>
        </div>
        <div data-testid="network-detail-poll-template">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.template')}</dt>
          <dd className="font-medium break-words">{templateName ?? unknown}</dd>
        </div>
        <div data-testid="network-detail-poll-interval">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.pollingInterval')}</dt>
          <dd className="font-medium">
            {formatInterval(collection?.pollingInterval ?? snmpDevice?.pollingInterval, tf)}
          </dd>
        </div>
        <div data-testid="network-detail-poll-transport">
          <dt className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.fields.snmpTransport')}</dt>
          <dd className="font-medium">
            {snmpDevice ? `${snmpDevice.snmpVersion} · ${snmpDevice.port}` : unknown}
          </dd>
        </div>
      </dl>
      <button
        type="button"
        data-testid="network-detail-edit-poll-config"
        onClick={handleEdit}
        className="mt-3 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('common:actions.edit')}
      </button>
    </Section>
  );
}
```

- [ ] **Step 8: Red — `OidTable`**

Create `apps/web/src/components/devices/networkDevice/OidTable.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { OidTable } from './OidTable';
import type { Collection, CollectionOid } from './types';

const AT = new Date(Date.now() - 4 * 60_000).toISOString();

function entry(overrides: Partial<CollectionOid> & { baseOid: string; name: string }): CollectionOid {
  return {
    mode: 'get', cadence: 'fast', state: 'collecting', observedAt: AT, instances: [], error: null, ...overrides,
  };
}

const collection: Collection = {
  templateId: 'tpl-1', lastPolledAt: AT, pollingInterval: 300, status: 'ok', consecutiveFailures: 0,
  oids: [
    entry({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', instances: [{ oid: '1.3.6.1.2.1.1.3.0', instance: '', value: '884512', valueType: 'timeticks', observedAt: AT }] }),
    entry({
      baseOid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', mode: 'walk',
      instances: [
        { oid: '1.3.6.1.2.1.43.11.1.1.9.1.1', instance: '1.1', value: '37', valueType: 'integer', observedAt: AT },
        { oid: '1.3.6.1.2.1.43.11.1.1.9.1.2', instance: '1.2', value: '82', valueType: 'integer', observedAt: AT },
      ],
    }),
    entry({ baseOid: '1.3.6.1.2.1.25.3.5.1.1', name: 'hrPrinterStatus', mode: 'walk', state: 'unsupported', error: 'noSuchObject' }),
    entry({ baseOid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr', mode: 'walk', state: 'unknown' }),
    entry({ baseOid: '1.3.6.1.2.1.2.2.1.10', name: 'ifInOctets', mode: 'walk', state: 'collecting', error: 'truncated' }),
  ],
};

describe('OidTable', () => {
  it('renders a row per OID with its mode, state, latest value and age', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    const row = screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.1.3.0');
    expect(row.textContent).toContain('sysUpTime');
    expect(row.textContent).toContain('1.3.6.1.2.1.1.3.0');
    expect(row.textContent).toContain('get');
    expect(row.textContent).toContain('Collecting');
    expect(row.textContent).toContain('884512');
    expect(row.textContent).toMatch(/4\s*min/);
  });

  it('hides instance rows until the OID is expanded', async () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.queryByTestId('network-detail-oid-instance-1.1')).toBeNull();

    const toggle = screen.getByTestId('network-detail-oid-toggle-1.3.6.1.2.1.43.11.1.1.9');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('network-detail-oid-instance-1.1').textContent).toContain('37');
    expect(screen.getByTestId('network-detail-oid-instance-1.2').textContent).toContain('82');
  });

  it('points aria-controls at the instance container it actually toggles', async () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    const toggle = screen.getByTestId('network-detail-oid-toggle-1.3.6.1.2.1.43.11.1.1.9');
    await userEvent.click(toggle);
    const controls = toggle.getAttribute('aria-controls')!;
    expect(document.getElementById(controls)).not.toBeNull();
  });

  it('offers no toggle for a scalar OID with a single unnamed instance', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.queryByTestId('network-detail-oid-toggle-1.3.6.1.2.1.1.3.0')).toBeNull();
  });

  it('shows the error code on an unsupported OID', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    const row = screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.25.3.5.1.1');
    expect(row.textContent).toContain('Unsupported');
    expect(row.textContent).toContain('noSuchObject');
  });

  it('names the agent update as the fix for an unknown table OID', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.2.2.1.2').textContent)
      .toContain('update the agent');
  });

  it('flags a truncated walk as partial rather than complete', () => {
    render(<OidTable collection={collection} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-oid-row-1.3.6.1.2.1.2.2.1.10').textContent).toContain('Partial');
  });

  it('explains a missing template instead of rendering an empty table', () => {
    render(<OidTable collection={{ ...collection, templateId: null, status: 'no_template', oids: [] }} timezone="UTC" />);
    expect(screen.queryByTestId('network-detail-oid-table')).toBeNull();
    expect(screen.getByTestId('network-detail-oid-no-template')).toBeInTheDocument();
  });

  it('says SNMP is not configured when there is no collection at all', () => {
    render(<OidTable collection={null} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-oid-not-configured')).toBeInTheDocument();
  });
});
```

- [ ] **Step 9: Run it, watch it fail, implement `OidTable.tsx`**

```tsx
// Per-OID collection state (spec §6.2). The column that matters is `state`:
// before this wave nothing anywhere said that 145 of the built-in template OIDs
// had never collected a value (spec §1 F3), and a table of blanks reads as
// "quiet" rather than "broken". Every non-collecting state therefore carries
// its own explanation on the row.

import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import { Section } from './primitives';
import { formatAbsolute } from './reachabilityCopy';
import type { Collection, CollectionOid, CollectionOidState } from './types';

const STATE_KEYS: Record<CollectionOidState, string> = {
  collecting: 'networkDeviceDetailPage.collection.oidState.collecting',
  unsupported: 'networkDeviceDetailPage.collection.oidState.unsupported',
  stale: 'networkDeviceDetailPage.collection.oidState.stale',
  never_polled: 'networkDeviceDetailPage.collection.oidState.neverPolled',
  unknown: 'networkDeviceDetailPage.collection.oidState.unknown',
};

const STATE_CLASSES: Record<CollectionOidState, string> = {
  collecting: 'bg-success/15 text-success border-success/30',
  unsupported: 'bg-warning/15 text-warning border-warning/30',
  stale: 'bg-warning/15 text-warning border-warning/30',
  never_polled: 'bg-muted text-muted-foreground border-muted',
  unknown: 'bg-muted text-muted-foreground border-muted',
};

/** A scalar GET returns one unnamed instance; there is nothing to expand. */
function isExpandable(entry: CollectionOid): boolean {
  return entry.instances.length > 1 || (entry.instances.length === 1 && entry.instances[0].instance !== '');
}

function OidRow({ entry, timezone }: { entry: CollectionOid; timezone: string }) {
  const { t } = useTranslation('devices');
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const expandable = isExpandable(entry);
  const latest = entry.instances[0]?.value ?? null;

  return (
    <div className="border-b py-2 last:border-b-0" data-testid={`network-detail-oid-row-${entry.baseOid}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        {expandable ? (
          <button
            type="button"
            data-testid={`network-detail-oid-toggle-${entry.baseOid}`}
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((open) => !open)}
            className="flex shrink-0 items-center gap-1 rounded-sm text-left font-medium hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 transition ${expanded ? 'rotate-90' : ''}`} />
            {entry.name}
            <span className="text-xs font-normal text-muted-foreground">({entry.instances.length})</span>
          </button>
        ) : (
          <span className="shrink-0 font-medium">{entry.name}</span>
        )}

        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={entry.baseOid}>
          {entry.baseOid}
        </span>
        <span className="shrink-0 rounded-sm border px-1 py-0.5 font-mono text-xs text-muted-foreground">{entry.mode}</span>
        <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-xs ${STATE_CLASSES[entry.state]}`}>
          {t(/* i18n-dynamic */ STATE_KEYS[entry.state])}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          {latest === null ? <span aria-label={t('common:states.unknown')}>—</span> : latest}
        </span>
        <span
          className="shrink-0 text-xs text-muted-foreground"
          title={entry.observedAt ? formatAbsolute(entry.observedAt, timezone) : undefined}
        >
          {entry.observedAt ? formatLastSeen(entry.observedAt, timezone) : ''}
        </span>
      </div>

      {entry.state === 'unsupported' && entry.error && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('networkDeviceDetailPage.collection.unsupportedWithCode', { code: entry.error })}
        </p>
      )}
      {entry.state === 'unknown' && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('networkDeviceDetailPage.collection.unknownNeedsAgentUpdate')}
        </p>
      )}
      {entry.error === 'truncated' && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('networkDeviceDetailPage.collection.partialRows')}
        </p>
      )}

      {expandable && expanded && (
        <dl id={panelId} className="mt-2 space-y-1 border-l pl-3 text-xs">
          {entry.instances.map((row) => (
            <div key={row.instance} className="flex items-baseline justify-between gap-3" data-testid={`network-detail-oid-instance-${row.instance}`}>
              <dt className="min-w-0 truncate font-mono text-muted-foreground" title={row.oid}>{row.instance}</dt>
              <dd className="shrink-0 tabular-nums" title={formatAbsolute(row.observedAt, timezone)}>
                {row.value ?? <span aria-label={t('common:states.unknown')}>—</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function OidTable({ collection, timezone }: { collection: Collection | null; timezone: string }) {
  const { t } = useTranslation('devices');

  if (!collection) {
    return (
      <Section title={t('networkDeviceDetailPage.sections.oids')} testId="network-detail-oids">
        <p className="text-xs text-muted-foreground" data-testid="network-detail-oid-not-configured">
          {t('networkDeviceDetailPage.collection.status.notConfigured')}
        </p>
      </Section>
    );
  }

  if (collection.status === 'no_template') {
    return (
      <Section title={t('networkDeviceDetailPage.sections.oids')} testId="network-detail-oids">
        <p className="text-xs text-muted-foreground" data-testid="network-detail-oid-no-template">
          {t('networkDeviceDetailPage.health.noTemplate')}
        </p>
      </Section>
    );
  }

  return (
    <Section title={t('networkDeviceDetailPage.sections.oids')} testId="network-detail-oids">
      <div data-testid="network-detail-oid-table">
        {collection.oids.map((entry) => (
          <OidRow key={entry.baseOid} entry={entry} timezone={timezone} />
        ))}
      </div>
    </Section>
  );
}
```

- [ ] **Step 10: `NetworkChecksSection.tsx`**

```tsx
// The network checks bound to this asset, with their latest result. Uses the
// same "<state> · <relative>" shape as everything else on the page — a check
// row that said only "offline" would be the copy rule's own violation.

import { useTranslation } from 'react-i18next';
import EmptyState from '../../shared/EmptyState';
import { formatLastSeen } from '@/lib/formatTime';
import { formatPing } from '../../discovery/pingFormat';
import { Section } from './primitives';
import { formatAbsolute } from './reachabilityCopy';
import type { NetworkCheckSummary } from './useAssetMonitoring';

const STATUS_CLASSES: Record<string, string> = {
  online: 'text-success',
  degraded: 'text-warning',
  offline: 'text-destructive',
};

export function NetworkChecksSection({
  checks,
  timezone,
  onAddCheck,
}: {
  checks: NetworkCheckSummary[];
  timezone: string;
  onAddCheck: () => void;
}) {
  const { t } = useTranslation('devices');

  return (
    <Section title={t('networkDeviceDetailPage.sections.networkChecks')} testId="network-detail-checks">
      {checks.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-checks-empty"
          title={t('networkDeviceDetailPage.checks.emptyTitle')}
          description={t('networkDeviceDetailPage.checks.emptyDescription')}
          action={
            <button
              type="button"
              data-testid="network-detail-add-check"
              onClick={onAddCheck}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('networkDeviceDetailPage.checks.add')}
            </button>
          }
        />
      ) : (
        <ul className="divide-y text-sm">
          {checks.map((check) => {
            const statusLabel = check.lastStatus
              ? t(/* i18n-dynamic */ `networkDeviceDetailPage.checks.status.${check.lastStatus}`)
              : t('networkDeviceDetailPage.checks.status.never');
            const parts = [statusLabel];
            if (check.lastResponseMs !== null) parts.push(formatPing(check.lastResponseMs));
            if (check.lastChecked) parts.push(formatLastSeen(check.lastChecked, timezone));
            return (
              <li key={check.id} className="py-2" data-testid={`network-detail-check-${check.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {check.name}
                    <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
                      {check.monitorType} · {check.target}
                    </span>
                  </span>
                  <span
                    className={STATUS_CLASSES[check.lastStatus ?? ''] ?? 'text-muted-foreground'}
                    title={check.lastChecked ? formatAbsolute(check.lastChecked, timezone) : undefined}
                  >
                    {parts.join(' · ')}
                  </span>
                </div>
                {!check.isActive && (
                  <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.checks.paused')}</p>
                )}
                {check.lastError && (
                  <p className="text-xs text-destructive" data-testid={`network-detail-check-error-${check.id}`}>
                    {check.lastError}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
```

- [ ] **Step 11: `ThresholdAlertsSection.tsx`**

```tsx
// What will actually fire. The OID is resolved to its template name when the
// collection knows it — a bare 1.3.6.1.2.1.43.11.1.1.9.1.1 in an alert list is
// unreadable to the technician who has to decide whether the rule is right.

import { useTranslation } from 'react-i18next';
import EmptyState from '../../shared/EmptyState';
import { Section } from './primitives';
import type { Collection } from './types';
import type { ThresholdSummary } from './useAssetMonitoring';

const SEVERITY_CLASSES: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  high: 'bg-destructive/10 text-destructive border-destructive/20',
  medium: 'bg-warning/15 text-warning border-warning/30',
  low: 'bg-muted text-muted-foreground border-muted',
  info: 'bg-muted text-muted-foreground border-muted',
};

/** Longest matching base OID wins, so an instance OID resolves to its column's name. */
export function oidDisplayName(oid: string, collection: Collection | null): string | null {
  if (!collection) return null;
  const match = collection.oids
    .filter((entry) => oid === entry.baseOid || oid.startsWith(`${entry.baseOid}.`))
    .sort((a, b) => b.baseOid.length - a.baseOid.length)[0];
  return match?.name ?? null;
}

export function ThresholdAlertsSection({
  thresholds,
  collection,
}: {
  thresholds: ThresholdSummary[];
  collection: Collection | null;
}) {
  const { t } = useTranslation('devices');

  return (
    <Section title={t('networkDeviceDetailPage.sections.thresholds')} testId="network-detail-thresholds">
      {thresholds.length === 0 ? (
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-thresholds-empty"
          title={t('networkDeviceDetailPage.thresholds.emptyTitle')}
          description={t('networkDeviceDetailPage.thresholds.emptyDescription')}
        />
      ) : (
        <ul className="divide-y text-sm">
          {thresholds.map((threshold) => {
            const name = oidDisplayName(threshold.oid, collection);
            return (
              <li key={threshold.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2" data-testid={`network-detail-threshold-${threshold.id}`}>
                <span className="min-w-0">
                  <span className="font-medium">{name ?? threshold.oid}</span>
                  {name && <span className="ml-1 font-mono text-xs text-muted-foreground">{threshold.oid}</span>}
                  {threshold.message && <span className="block text-xs text-muted-foreground">{threshold.message}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs">
                    {threshold.operator ?? '?'} {threshold.threshold ?? '?'}
                  </span>
                  <span className={`rounded-full border px-1.5 py-0.5 text-xs ${SEVERITY_CLASSES[threshold.severity] ?? SEVERITY_CLASSES.info}`}>
                    {t(/* i18n-dynamic */ `alerts:severity.${threshold.severity}`)}
                  </span>
                  {!threshold.isActive && (
                    <span className="text-xs text-muted-foreground">{t('common:states.disabled')}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
```

- [ ] **Step 12: `MonitoringTab.tsx`**

```tsx
// Composes the Monitoring tab. Loading and error live here so one failed read
// cannot take the whole tab down (useAssetMonitoring only sets `error` when the
// asset call itself failed — the other three degrade their own panel).

import { useTranslation } from 'react-i18next';
import { MetricHistoryCharts } from './MetricHistoryCharts';
import { NetworkChecksSection } from './NetworkChecksSection';
import { OidTable } from './OidTable';
import { PollConfigSummary } from './PollConfigSummary';
import { ThresholdAlertsSection } from './ThresholdAlertsSection';
import { useAssetMonitoring } from './useAssetMonitoring';

export function MonitoringTab({
  assetId,
  timezone,
  onOpenMonitoringSettings,
}: {
  assetId: string;
  timezone: string;
  onOpenMonitoringSettings: () => void;
}) {
  const { t } = useTranslation('devices');
  const { collection, snmpDevice, templateName, checks, thresholds, loading, error, reload } =
    useAssetMonitoring(assetId);

  if (loading) {
    return (
      <div
        className="space-y-3 rounded-md border bg-card p-4 animate-pulse motion-reduce:animate-none"
        data-testid="network-detail-monitoring-loading"
        aria-busy="true"
        aria-label={t('networkDeviceDetailPage.loadingMonitoring')}
      >
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-4 w-full rounded bg-muted" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4" data-testid="network-detail-monitoring-error">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          data-testid="network-detail-monitoring-retry"
          onClick={() => void reload()}
          className="mt-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PollConfigSummary
        collection={collection}
        snmpDevice={snmpDevice}
        templateName={templateName}
        timezone={timezone}
        onEdit={onOpenMonitoringSettings}
      />
      <OidTable collection={collection} timezone={timezone} />
      <MetricHistoryCharts assetId={assetId} collection={collection} timezone={timezone} />
      <NetworkChecksSection checks={checks} timezone={timezone} onAddCheck={onOpenMonitoringSettings} />
      <ThresholdAlertsSection thresholds={thresholds} collection={collection} />
    </div>
  );
}
```

- [ ] **Step 13: English keys**

```json
  "poll": {
    "everySeconds": "every {{count}} sec",
    "everyMinutes": "every {{count}} min",
    "everyHours": "every {{count}} hr"
  },
  "checks": {
    "emptyTitle": "No network checks on this device",
    "emptyDescription": "A ping or port check gives this device a reachability verdict of its own, independent of the discovery scan.",
    "add": "Add a check",
    "paused": "Paused",
    "status": { "online": "Online", "degraded": "Degraded", "offline": "Offline", "never": "Never checked" }
  },
  "thresholds": {
    "emptyTitle": "No SNMP threshold alerts are armed",
    "emptyDescription": "Nothing on this device will raise an alert from a polled value yet."
  },
  "loadingMonitoring": "Loading monitoring data…",
  "errors": { "monitoringLoad": "Couldn't load this device's monitoring data. Try again." },
  "collection": { "unsupportedWithCode": "The device answered {{code}} — this OID is not implemented on it." },
  "fields": {
    "pollStatus": "Poll status",
    "template": "Template",
    "pollingInterval": "Polling interval",
    "snmpTransport": "SNMP"
  },
  "sections": {
    "pollConfiguration": "Poll configuration",
    "oids": "OIDs",
    "networkChecks": "Network checks",
    "thresholds": "SNMP threshold alerts"
  },
```

- [ ] **Step 14: Green + commit**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/useAssetMonitoring.test.ts \
  src/components/devices/networkDevice/OidTable.test.tsx
git add apps/api/src/routes/monitoring.ts apps/api/src/routes/monitoring_assets_thresholds.test.ts \
        apps/web/src/components/devices/networkDevice apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): monitoring tab shows per-OID collection state, checks and armed thresholds

Replaces the two "Enabled / Not configured" rows with the poll configuration,
an OID table carrying each OID's state, latest value and age (instances
expandable, every non-collecting state carrying its own explanation), the
network checks with their latest results, and the SNMP threshold alerts. Adds
GET /monitoring/assets/:id/thresholds — the deprecated /snmp/thresholds/:deviceId
is a 410 stub, so there was no way to read what is armed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 10: `useAssetMetrics` + history charts

One chart per selected OID, 24 h / 7 d / 30 d, counters rendered as deltas. Follows the `dataviz` rules: one measure per chart, no dual axis, theme-token colors in fixed order, single-series charts carry no legend (the title names the OID), and the numeric values also exist as text in the OID table above.

**Decisions:**
- **Range → bucket** mirrors `DevicePerformanceGraphs`: `24h → 5m`, `7d → 1h`, `30d → 1d`. The server caps at 90 days / 2 000 points / 64 series (§6.3), and these three stay well inside all three caps.
- **A counter OID is charted with `&delta=1` and `type="bar"`** (a per-bucket magnitude), a gauge with `type="line"`. The client decides from the instance rows' `valueType` (`counter32` / `counter64`, which `processPollResults` writes from the template entry's type); when no instance has landed yet the OID is treated as a gauge — drawing a monotonic lifetime counter as a line is merely dull, whereas drawing a gauge as a delta bar is wrong.
- **Selection** defaults to the first chartable OID and is capped at **4 charts at once** — beyond that the page becomes a wall and each request costs a server-side bucketing pass.
- Each OID's chart owns its own `useAssetMetrics` call, so a failed series renders that chart's error state rather than the tab's.

**Files:**
- Create: `apps/web/src/components/devices/networkDevice/useAssetMetrics.ts` (+ `.test.ts`)
- Create: `apps/web/src/components/devices/networkDevice/MetricHistoryCharts.tsx` (+ `.test.tsx`)

**Interfaces:**
```ts
export type MetricRange = '24h' | '7d' | '30d';
export type MetricBucket = '5m' | '1h' | '1d';
export const RANGE_BUCKET: Record<MetricRange, MetricBucket> = { '24h': '5m', '7d': '1h', '30d': '1d' };
export const RANGE_MS: Record<MetricRange, number> = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
export const MAX_SELECTED_OIDS = 4;

export type MetricSeries = { oid: string; instance: string; name: string; points: Array<[string, number]> };

export type UseAssetMetricsArgs = {
  assetId: string;
  /** null suspends the hook entirely — no request is made. */
  oid: string | null;
  range: MetricRange;
  delta?: boolean;
  /** Overrides the range-derived window; PrinterHealth uses 8 days at bucket 1d. */
  windowMs?: number;
  bucket?: MetricBucket;
};

export function useAssetMetrics(args: UseAssetMetricsArgs): {
  series: MetricSeries[];
  loading: boolean;
  error: string | null;
  reload: () => void;
};
```

- [ ] **Step 1: Red — write the full hook test**

Create `apps/web/src/components/devices/networkDevice/useAssetMetrics.test.ts`:

```ts
import '@/lib/i18n';

import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAssetMetrics } from './useAssetMetrics';
import { fetchWithAuth } from '../../../stores/auth';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status < 400,
    status,
    statusText: status < 400 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const series = [{ oid: '1.3.6.1.2.1.2.2.1.10.1', instance: '1', name: 'ifInOctets', points: [['2026-09-16T10:00:00.000Z', 42]] }];

describe('useAssetMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds the query from the range, with an ISO window and the mapped bucket', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series: [] }));
    renderHook(() => useAssetMetrics({ assetId: 'a1', oid: '1.3.6.1.2.1.2.2.1.10.1', range: '7d' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const url = fetchWithAuthMock.mock.calls[0][0] as string;
    expect(url).toContain('/monitoring/assets/a1/metrics');
    expect(url).toContain(`oid=${encodeURIComponent('1.3.6.1.2.1.2.2.1.10.1')}`);
    expect(url).toContain('bucket=1h');
    expect(url).not.toContain('delta=');

    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const from = new Date(params.get('from')!).getTime();
    const to = new Date(params.get('to')!).getTime();
    expect(Number.isNaN(from)).toBe(false);
    // 7d ± a second of clock drift between the two Date constructions.
    expect(to - from).toBeGreaterThan(604_800_000 - 1_000);
    expect(to - from).toBeLessThan(604_800_000 + 1_000);
  });

  it('maps each range to its own bucket', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series: [] }));
    for (const [range, bucket] of [['24h', '5m'], ['7d', '1h'], ['30d', '1d']] as const) {
      fetchWithAuthMock.mockClear();
      renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range }));
      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
      expect(fetchWithAuthMock.mock.calls[0][0] as string).toContain(`bucket=${bucket}`);
    }
  });

  it('asks for reset-aware deltas when delta is set', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series }));
    renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '24h', delta: true }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(fetchWithAuthMock.mock.calls[0][0] as string).toContain('delta=1');
  });

  it('honours an explicit window and bucket over the range', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series: [] }));
    renderHook(() =>
      useAssetMetrics({ assetId: 'a1', oid: 'x', range: '7d', windowMs: 8 * 86_400_000, bucket: '1d', delta: true }),
    );
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const url = fetchWithAuthMock.mock.calls[0][0] as string;
    expect(url).toContain('bucket=1d');
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const span = new Date(params.get('to')!).getTime() - new Date(params.get('from')!).getTime();
    expect(span).toBeGreaterThan(8 * 86_400_000 - 1_000);
  });

  it('does not fetch at all when no OID is selected', async () => {
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: null, range: '24h' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(result.current.series).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('returns the series on success', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series }));
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '24h' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.series).toEqual(series);
  });

  it('surfaces the cap message from a 400 instead of rendering an empty chart', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ error: 'Range exceeds the 90-day cap' }, 400));
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '30d' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain('90-day');
    expect(result.current.series).toEqual([]);
  });

  it('ignores a superseded response when the range changes mid-flight', async () => {
    let resolveFirst!: (value: Response) => void;
    const firstPromise = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    fetchWithAuthMock.mockReturnValueOnce(firstPromise as unknown as Promise<Response>);

    const { result, rerender } = renderHook(
      ({ range }: { range: '24h' | '7d' }) => useAssetMetrics({ assetId: 'a1', oid: 'x', range }),
      { initialProps: { range: '24h' as const } },
    );

    const laterSeries = [{ oid: 'x', instance: '', name: 'later', points: [['2026-09-16T11:00:00.000Z', 7]] }];
    fetchWithAuthMock.mockResolvedValueOnce(json({ series: laterSeries }));
    rerender({ range: '7d' });
    await waitFor(() => expect(result.current.series).toEqual(laterSeries));

    // The stale 24h response lands last and must be dropped: switching
    // 24h → 7d → 24h is one click each, and the wrong window painting last is
    // indistinguishable from real data.
    await act(async () => {
      resolveFirst(json({ series: [{ oid: 'x', instance: '', name: 'stale', points: [] }] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.series).toEqual(laterSeries);
  });

  it('refetches on reload without changing the query', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ series }));
    const { result } = renderHook(() => useAssetMetrics({ assetId: 'a1', oid: 'x', range: '24h' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstUrl = fetchWithAuthMock.mock.calls[0][0] as string;

    act(() => result.current.reload());

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const secondUrl = fetchWithAuthMock.mock.calls[1][0] as string;
    expect(secondUrl.split('&from=')[0]).toBe(firstUrl.split('&from=')[0]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/useAssetMetrics.test.ts
```
Expected: `Failed to resolve import "./useAssetMetrics"` — nine failing cases.

- [ ] **Step 3: Implement `useAssetMetrics.ts`**

```ts
// History for one OID (spec §6.3). One hook instance per chart, so a failing
// series fails its own chart rather than the tab.

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';

export type MetricRange = '24h' | '7d' | '30d';
export type MetricBucket = '5m' | '1h' | '1d';

/** Mirrors DevicePerformanceGraphs' rangeIntervals so the two pages bucket alike. */
export const RANGE_BUCKET: Record<MetricRange, MetricBucket> = { '24h': '5m', '7d': '1h', '30d': '1d' };
export const RANGE_MS: Record<MetricRange, number> = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};
export const MAX_SELECTED_OIDS = 4;

export type MetricSeries = {
  oid: string;
  instance: string;
  name: string;
  points: Array<[string, number]>;
};

export type UseAssetMetricsArgs = {
  assetId: string;
  oid: string | null;
  range: MetricRange;
  delta?: boolean;
  windowMs?: number;
  bucket?: MetricBucket;
};

export function useAssetMetrics({
  assetId,
  oid,
  range,
  delta,
  windowMs,
  bucket,
}: UseAssetMetricsArgs) {
  const { t } = useTranslation('devices');
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Same stale-response guard as useNetworkAsset.fetchDevices: switching
  // 24h → 7d → 24h is one click each, and an older response landing last paints
  // the wrong window with no visible sign that it is wrong.
  const seqRef = useRef(0);

  useEffect(() => {
    if (!oid) {
      setSeries([]);
      setError(null);
      setLoading(false);
      return;
    }

    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    const to = new Date();
    const from = new Date(to.getTime() - (windowMs ?? RANGE_MS[range]));
    const params = new URLSearchParams({
      oid,
      from: from.toISOString(),
      to: to.toISOString(),
      bucket: bucket ?? RANGE_BUCKET[range],
    });
    if (delta) params.set('delta', '1');

    void (async () => {
      try {
        const response = await fetchWithAuth(`/monitoring/assets/${assetId}/metrics?${params.toString()}`);
        const body = (await response.json().catch(() => null)) as { series?: MetricSeries[]; error?: string } | null;
        if (seq !== seqRef.current) return;
        if (!response.ok) {
          // The 400 carries the cap in its message (§14) — showing it is the
          // whole point; a silent empty chart reads as "no data".
          setError(typeof body?.error === 'string' ? body.error : t('networkDeviceDetailPage.charts.loadFailed'));
          setSeries([]);
          return;
        }
        setSeries(Array.isArray(body?.series) ? body.series : []);
      } catch {
        if (seq !== seqRef.current) return;
        setError(t('networkDeviceDetailPage.charts.loadFailed'));
        setSeries([]);
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    })();
  }, [assetId, oid, range, delta, windowMs, bucket, nonce, t]);

  return { series, loading, error, reload: () => setNonce((n) => n + 1) };
}
```

- [ ] **Step 4: Green on the hook**

```bash
cd apps/web && npx vitest run src/components/devices/networkDevice/useAssetMetrics.test.ts
```

- [ ] **Step 5: Red — write the full charts test**

Create `apps/web/src/components/devices/networkDevice/MetricHistoryCharts.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetricHistoryCharts } from './MetricHistoryCharts';
import { fetchWithAuth } from '../../../stores/auth';
import type { Collection, CollectionOid } from './types';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// recharts needs a measured container; jsdom reports 0×0 and the chart body
// never renders. Stubbing ChartWidget keeps these assertions on OUR logic
// (which OID, which type, which subtitle) instead of on recharts' internals.
vi.mock('../../analytics/ChartWidget', () => ({
  default: ({ title, subtitle, type, data }: { title: string; subtitle?: string; type: string; data: unknown[] }) => (
    <div data-testid={`chart-widget-${title}`} data-type={type} data-points={data.length}>
      {title}
      {subtitle ? <span>{subtitle}</span> : null}
    </div>
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const AT = '2026-09-16T10:00:00.000Z';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function entry(overrides: Partial<CollectionOid> & { baseOid: string; name: string }): CollectionOid {
  return {
    mode: 'walk',
    cadence: 'fast',
    state: 'collecting',
    observedAt: AT,
    error: null,
    instances: [{ oid: `${overrides.baseOid}.1`, instance: '1', value: '10', valueType: 'gauge32', observedAt: AT }],
    ...overrides,
  };
}

const collection: Collection = {
  templateId: 'tpl-1', lastPolledAt: AT, pollingInterval: 300, status: 'ok', consecutiveFailures: 0,
  oids: [
    entry({ baseOid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' }),
    entry({ baseOid: '1.3.6.1.2.1.25.3.5.1.1', name: 'hrPrinterStatus' }),
  ],
};

const counterCollection: Collection = {
  ...collection,
  oids: [
    entry({
      baseOid: '1.3.6.1.2.1.2.2.1.10',
      name: 'ifInOctets',
      instances: [{ oid: '1.3.6.1.2.1.2.2.1.10.1', instance: '1', value: '99', valueType: 'counter64', observedAt: AT }],
    }),
  ],
};

const fiveOidCollection: Collection = {
  ...collection,
  oids: Array.from({ length: 5 }, (_, i) => entry({ baseOid: `1.3.6.1.2.1.99.${i}`, name: `metric${i}` })),
};

describe('MetricHistoryCharts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(json({ series: [{ oid: 'x', instance: '1', name: 'x', points: [[AT, 1]] }] }));
  });

  it('defaults to the first chartable OID and offers a 24h/7d/30d toggle', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);

    expect(screen.getByTestId('network-detail-chart-range-24h')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-chart-range-7d')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-chart-range-30d')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('network-detail-chart-1.3.6.1.2.1.1.3.0')).toBeInTheDocument());
    expect(screen.queryByTestId('network-detail-chart-1.3.6.1.2.1.25.3.5.1.1')).toBeNull();
    await waitFor(() => expect(fetchWithAuthMock.mock.calls[0][0] as string).toContain('bucket=5m'));
  });

  it('re-requests with the new bucket when the range changes', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());

    await userEvent.click(screen.getByTestId('network-detail-chart-range-30d'));

    await waitFor(() => expect(fetchWithAuthMock.mock.calls.at(-1)![0] as string).toContain('bucket=1d'));
  });

  it('charts a gauge OID as a line with no delta', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('chart-widget-sysUpTime')).toHaveAttribute('data-type', 'line'));
    expect(fetchWithAuthMock.mock.calls[0][0] as string).not.toContain('delta=1');
  });

  it('charts a counter OID as per-bucket delta bars', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={counterCollection} timezone="UTC" />);
    await waitFor(() => expect(fetchWithAuthMock.mock.calls.at(-1)![0] as string).toContain('delta=1'));
    const widget = screen.getByTestId('chart-widget-ifInOctets');
    expect(widget).toHaveAttribute('data-type', 'bar');
    // The subtitle must say the value is per bucket, or a delta bar reads as a level.
    expect(widget.textContent).toContain('per');
  });

  it('caps the selection at four OIDs', async () => {
    render(<MetricHistoryCharts assetId="a1" collection={fiveOidCollection} timezone="UTC" />);
    for (const oid of fiveOidCollection.oids) {
      const pick = screen.getByTestId(`network-detail-chart-pick-${oid.baseOid}`);
      if (!(pick as HTMLInputElement).disabled && !(pick as HTMLInputElement).checked) {
        await userEvent.click(pick);
      }
    }
    await waitFor(() =>
      expect(document.querySelectorAll('[data-testid^="network-detail-chart-1.3.6.1.2.1.99."]')).toHaveLength(4),
    );
    expect(screen.getByTestId('network-detail-chart-cap')).toBeInTheDocument();
  });

  it('renders a per-chart error without blanking the others', async () => {
    fetchWithAuthMock.mockImplementation((url: string) =>
      Promise.resolve(
        (url as string).includes(encodeURIComponent('1.3.6.1.2.1.25.3.5.1.1'))
          ? json({ error: 'Range exceeds the 90-day cap' }, 400)
          : json({ series: [{ oid: 'x', instance: '1', name: 'x', points: [[AT, 1]] }] }),
      ),
    );
    render(<MetricHistoryCharts assetId="a1" collection={collection} timezone="UTC" />);

    await userEvent.click(screen.getByTestId('network-detail-chart-pick-1.3.6.1.2.1.25.3.5.1.1'));

    await waitFor(() =>
      expect(screen.getByTestId('network-detail-chart-error-1.3.6.1.2.1.25.3.5.1.1').textContent).toContain('90-day'),
    );
    // The healthy chart is untouched.
    expect(screen.getByTestId('chart-widget-sysUpTime')).toBeInTheDocument();
  });

  it('offers nothing to chart, and says so, when no OID is collecting', () => {
    render(<MetricHistoryCharts assetId="a1" collection={{ ...collection, oids: [] }} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-charts-empty')).toBeInTheDocument();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('says nothing is configured when there is no collection at all', () => {
    render(<MetricHistoryCharts assetId="a1" collection={null} timezone="UTC" />);
    expect(screen.getByTestId('network-detail-charts-empty')).toBeInTheDocument();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it, watch it fail, implement `MetricHistoryCharts.tsx`**

```tsx
// OID history (spec §11 Monitoring tab). One chart per selected OID, never two
// measures on one chart and never a second y-axis: the OIDs on one device span
// percentages, octet counters and timeticks, and a shared axis would make every
// small series invisible. Each chart owns its own request so one failure is one
// chart's error, not the tab's.

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ChartWidget from '../../analytics/ChartWidget';
import EmptyState from '../../shared/EmptyState';
import { Section } from './primitives';
import {
  MAX_SELECTED_OIDS,
  RANGE_BUCKET,
  useAssetMetrics,
  type MetricRange,
} from './useAssetMetrics';
import type { Collection, CollectionOid } from './types';

const RANGES: MetricRange[] = ['24h', '7d', '30d'];

const BUCKET_LABEL_KEYS: Record<string, string> = {
  '5m': 'networkDeviceDetailPage.charts.bucket.fiveMinutes',
  '1h': 'networkDeviceDetailPage.charts.bucket.hour',
  '1d': 'networkDeviceDetailPage.charts.bucket.day',
};

/**
 * Counters are cumulative, so the useful chart is the per-bucket delta, drawn
 * as bars. The value type comes from the stored metric rows (processPollResults
 * writes the template entry's type); with no row yet, treat the OID as a gauge
 * — a counter drawn as a line is merely dull, a gauge drawn as delta bars is
 * wrong.
 */
export function isCounterOid(entry: CollectionOid): boolean {
  return entry.instances.some((row) => (row.valueType ?? '').toLowerCase().startsWith('counter'));
}

/** Only an OID that has produced (or recently produced) a value can be charted. */
export function chartableOids(collection: Collection | null): CollectionOid[] {
  return (collection?.oids ?? []).filter((entry) => entry.state === 'collecting' || entry.state === 'stale');
}

function OidChart({
  assetId,
  entry,
  range,
}: {
  assetId: string;
  entry: CollectionOid;
  range: MetricRange;
}) {
  const { t } = useTranslation('devices');
  const counter = isCounterOid(entry);
  // The instance OID when the walk produced exactly one row, else the base OID
  // (the server fans a base OID out to its instances, capped at 64 series).
  const oid = entry.instances.length === 1 ? entry.instances[0].oid : entry.baseOid;
  const { series, loading, error, reload } = useAssetMetrics({
    assetId,
    oid,
    range,
    delta: counter,
  });

  const data = useMemo(
    () => series.flatMap((s) => s.points.map(([timestamp, value]) => ({ timestamp, value }))),
    [series],
  );

  if (error) {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        data-testid={`network-detail-chart-error-${entry.baseOid}`}
      >
        <p>{error}</p>
        <button
          type="button"
          data-testid={`network-detail-chart-retry-${entry.baseOid}`}
          onClick={reload}
          className="mt-1 text-xs underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('networkDeviceDetailPage.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div data-testid={`network-detail-chart-${entry.baseOid}`} aria-busy={loading || undefined}>
      <ChartWidget
        title={entry.name}
        subtitle={
          counter
            ? t('networkDeviceDetailPage.charts.perBucket', {
                bucket: t(/* i18n-dynamic */ BUCKET_LABEL_KEYS[RANGE_BUCKET[range]]),
              })
            : entry.baseOid
        }
        type={counter ? 'bar' : 'line'}
        data={data}
        xKey="timestamp"
        // One series per chart: no legend box is needed, the title names it.
        // The color is a theme token so both modes resolve their own value.
        series={[{ key: 'value', label: entry.name, color: 'hsl(var(--primary))' }]}
        height={220}
      />
    </div>
  );
}

export function MetricHistoryCharts({
  assetId,
  collection,
  timezone: _timezone,
}: {
  assetId: string;
  collection: Collection | null;
  /** Reserved: the bucketed axis is already localised by ChartWidget. */
  timezone: string;
}) {
  const { t } = useTranslation('devices');
  const options = useMemo(() => chartableOids(collection), [collection]);
  const [range, setRange] = useState<MetricRange>('24h');
  const [selected, setSelected] = useState<string[]>([]);

  // Seed the selection once the collection arrives; never clobber a choice the
  // operator has already made.
  useEffect(() => {
    setSelected((current) => {
      const stillValid = current.filter((oid) => options.some((entry) => entry.baseOid === oid));
      if (stillValid.length > 0) return stillValid;
      return options.slice(0, 1).map((entry) => entry.baseOid);
    });
  }, [options]);

  if (options.length === 0) {
    return (
      <Section title={t('networkDeviceDetailPage.sections.history')} testId="network-detail-charts">
        <EmptyState
          variant="plain"
          size="sm"
          testId="network-detail-charts-empty"
          title={t('networkDeviceDetailPage.charts.emptyTitle')}
          description={t('networkDeviceDetailPage.charts.emptyDescription')}
        />
      </Section>
    );
  }

  const atCap = selected.length >= MAX_SELECTED_OIDS;
  const toggle = (baseOid: string) =>
    setSelected((current) =>
      current.includes(baseOid)
        ? current.filter((oid) => oid !== baseOid)
        : current.length >= MAX_SELECTED_OIDS
          ? current
          : [...current, baseOid],
    );

  return (
    <Section title={t('networkDeviceDetailPage.sections.history')} testId="network-detail-charts">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`network-detail-chart-range-${option}`}
            aria-pressed={range === option}
            onClick={() => setRange(option)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
              range === option
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-muted text-muted-foreground hover:border-muted-foreground hover:text-foreground'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <fieldset className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        <legend className="text-xs font-medium text-muted-foreground">
          {t('networkDeviceDetailPage.charts.pickOids')}
        </legend>
        {options.map((entry) => {
          const checked = selected.includes(entry.baseOid);
          return (
            <label key={entry.baseOid} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                data-testid={`network-detail-chart-pick-${entry.baseOid}`}
                checked={checked}
                disabled={!checked && atCap}
                onChange={() => toggle(entry.baseOid)}
                className="focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              />
              {entry.name}
            </label>
          );
        })}
      </fieldset>
      {atCap && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="network-detail-chart-cap">
          {t('networkDeviceDetailPage.charts.cap', { count: MAX_SELECTED_OIDS })}
        </p>
      )}

      <div className="mt-3 grid gap-4 xl:grid-cols-2">
        {options
          .filter((entry) => selected.includes(entry.baseOid))
          .map((entry) => (
            <OidChart key={entry.baseOid} assetId={assetId} entry={entry} range={range} />
          ))}
      </div>
    </Section>
  );
}
```

- [ ] **Step 7: English keys**

```json
  "charts": {
    "pickOids": "Chart",
    "cap": "Showing the maximum of {{count}} charts — clear one to add another.",
    "perBucket": "Change per {{bucket}}",
    "bucket": { "fiveMinutes": "5 min", "hour": "hour", "day": "day" },
    "loadFailed": "Couldn't load this metric's history.",
    "emptyTitle": "No OID is collecting yet",
    "emptyDescription": "History appears once a poll returns a value for at least one OID."
  },
```
and `sections.history: "History"`.

- [ ] **Step 8: Green + commit**

```bash
cd apps/web && npx vitest run \
  src/components/devices/networkDevice/useAssetMetrics.test.ts \
  src/components/devices/networkDevice/MetricHistoryCharts.test.tsx
git add apps/web/src/components/devices/networkDevice/useAssetMetrics.ts \
        apps/web/src/components/devices/networkDevice/useAssetMetrics.test.ts \
        apps/web/src/components/devices/networkDevice/MetricHistoryCharts.tsx \
        apps/web/src/components/devices/networkDevice/MetricHistoryCharts.test.tsx \
        apps/web/src/components/devices/networkDevice/MonitoringTab.tsx \
        apps/web/src/locales/en/devices.json
git commit -m "$(cat <<'EOF'
feat(web/network-device): OID history charts with a 24h/7d/30d range toggle

One chart per selected OID (max four), gauges as lines and counters as
reset-aware per-bucket deltas, theme-token colors and a single series per chart
so there is never a second y-axis. A failed series fails its own chart, and a
400 renders the server's cap message instead of an empty plot.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 11: accessibility

Spec §11 Accessibility, minus the two items W04 owns (the settings modal's `<label>` on the type select and its Save/Cancel pending announcements — the page's own type select is W04's to delete, so the `<label>` item lands in W04's modal).

**Files:**
- Modify: `apps/web/src/components/shared/OverflowTabs.tsx`
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx`
- Modify: `apps/web/src/components/devices/networkDevice/primitives.tsx`
- Modify: `apps/web/src/components/devices/networkDevice/OpenPortsSection.tsx`
- Create: `apps/web/src/components/devices/NetworkDeviceDetailPage.a11y.test.tsx`

- [ ] **Step 1: Red — write the full a11y test file**

Create `apps/web/src/components/devices/NetworkDeviceDetailPage.a11y.test.tsx`:

```tsx
import '@/lib/i18n';

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import NetworkDeviceDetailPage from './NetworkDeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ASSET_ID = '11111111-1111-1111-1111-111111111111';

const baseAsset = {
  id: ASSET_ID,
  orgId: 'org-1',
  siteId: 'site-1',
  siteName: 'HQ',
  siteTimezone: 'UTC',
  assetType: 'switch',
  approvalStatus: 'approved',
  isOnline: true,
  hostname: 'core-switch-01',
  label: 'Main Switch',
  ipAddress: '10.0.0.2',
  macAddress: 'aa:bb:cc:dd:ee:ff',
  manufacturer: 'Cisco',
  model: null,
  openPorts: [{ port: 22, service: 'ssh' }],
  osFingerprint: null,
  snmpData: {},
  responseTimeMs: 2.4,
  linkedDeviceId: null,
  snmpMonitoringEnabled: false,
  networkMonitoringEnabled: false,
  discoveryMethods: ['arp'],
  profileName: 'HQ LAN',
  tags: [],
  firstSeenAt: '2026-05-01T10:00:00.000Z',
  lastSeenAt: '2026-09-16T10:00:00.000Z',
  reachability: {
    state: 'responding',
    source: 'snmp',
    observedAt: new Date(Date.now() - 120_000).toISOString(),
    lastKnown: null,
    detail: { snmp: { state: 'ok', observedAt: new Date(Date.now() - 120_000).toISOString(), consecutiveFailures: 0 } },
  },
};

// OverflowTabs measures button widths via offsetWidth, which jsdom reports as 0
// against a clientWidth of 0 — that collapses to "fits 1 tab", so with two tabs
// "Monitoring" is ALWAYS inside the "More" dropdown here. That is exactly the
// case the aria-labelledby fix below exists for.
function openMonitoringTab() {
  fireEvent.click(screen.getByText('More'));
  fireEvent.click(screen.getByTestId('network-detail-tab-monitoring'));
}

async function renderLoaded(assetOverrides: Record<string, unknown> = {}) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === `/discovery/assets/${ASSET_ID}`) {
      return Promise.resolve(makeJsonResponse({ data: { ...baseAsset, ...assetOverrides } }));
    }
    return Promise.resolve(makeJsonResponse({ data: [] }));
  });
  render(<NetworkDeviceDetailPage assetId={ASSET_ID} />);
  await screen.findByTestId('network-device-detail');
}

describe('NetworkDeviceDetailPage accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('labels the overview tabpanel by its own tab button, not a duplicate aria-label', async () => {
    await renderLoaded();
    const panel = screen.getByTestId('network-detail-overview');
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).not.toBeNull();
    // A node with BOTH aria-label and aria-labelledby resolves to the label and
    // loses the association — the two must never coexist.
    expect(panel).not.toHaveAttribute('aria-label');
  });

  it('keeps aria-labelledby resolvable for a tab that overflowed into "More"', async () => {
    await renderLoaded();
    openMonitoringTab();
    const panel = await screen.findByTestId('network-detail-monitoring');
    const labelledBy = panel.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).not.toBeNull();
  });

  it('moves focus to the ports section when the Open ports stat is used', async () => {
    await renderLoaded();
    await userEvent.click(screen.getByTestId('network-detail-stat-ports'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('network-detail-ports')));
  });

  it('moves focus to the Monitoring panel when the Last poll stat is used', async () => {
    await renderLoaded();
    await userEvent.click(screen.getByTestId('network-detail-stat-last-poll'));
    const panel = await screen.findByTestId('network-detail-monitoring');
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it('gives every em-dash placeholder an accessible unknown label', async () => {
    await renderLoaded({ model: null, osFingerprint: null, macAddress: null });
    for (const dash of screen.getAllByText('—')) {
      expect(dash.closest('[aria-label]')).not.toBeNull();
    }
  });

  it('keeps the live region a single polite announcer', async () => {
    await renderLoaded();
    const live = screen.getByTestId('network-detail-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'true');
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/web && npx vitest run src/components/devices/NetworkDeviceDetailPage.a11y.test.tsx
```
Expected failures: the two `aria-labelledby` cases (the panels carry `aria-label` today), both focus cases (the ports shortcut only scrolls; the Last poll stat does not move focus at all), and the em-dash case.

- [ ] **Step 3: Fix `OverflowTabs` — the overflow tab button has no `id`**

`overflowTabId` is applied to visible tab buttons (`OverflowTabs.tsx:180`) but **not** to the `role="menuitem"` buttons inside the "More" dropdown, so any panel labelled by a tab in overflow points at a non-existent element. Visible and overflow tabs are disjoint (`overflowTabs = tabs.slice(visibleCount)`), so adding the id cannot duplicate one.

Before:
```tsx
                {overflowTabs.map(tab => (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitem"
                    title={tab.title}
```
After:
```tsx
                {overflowTabs.map(tab => (
                  <button
                    key={tab.id}
                    // Same id the visible branch assigns, so a consumer's
                    // `aria-labelledby={overflowTabId(...)}` keeps resolving
                    // when a tab is pushed into this dropdown. Visible and
                    // overflow tabs are disjoint slices, so never duplicated.
                    id={overflowTabId(tab.id, testIdPrefix)}
                    type="button"
                    role="menuitem"
                    title={tab.title}
```

- [ ] **Step 4: Fix the panels' labelling in `NetworkDeviceDetailPage.tsx`**

Import `overflowTabId` alongside the existing `overflowPanelId`:
```tsx
import { OverflowTabs, overflowPanelId, overflowTabId, type OverflowTab } from '../shared/OverflowTabs';
```

Overview panel — before:
```tsx
          data-testid="network-detail-overview"
          role="tabpanel"
          id={overflowPanelId('overview', TAB_ID_PREFIX)}
          aria-label={t('networkDeviceDetailPage.tabs.overview')}
```
after:
```tsx
          data-testid="network-detail-overview"
          role="tabpanel"
          id={overflowPanelId('overview', TAB_ID_PREFIX)}
          // Labelled BY the tab button, not with a duplicate string: a node
          // carrying both aria-label and aria-labelledby resolves to the label
          // and silently drops the association.
          aria-labelledby={overflowTabId('overview', TAB_ID_PREFIX)}
          tabIndex={-1}
          ref={overviewPanelRef}
```
Monitoring panel — the same swap with `'monitoring'`, `tabIndex={-1}` and `ref={monitoringPanelRef}`.

- [ ] **Step 5: Move focus, don't only scroll**

Add the refs and extend the existing `pendingPortsScroll` effect:

```tsx
  const overviewPanelRef = useRef<HTMLDivElement>(null);
  const monitoringPanelRef = useRef<HTMLDivElement>(null);
  const portsSectionRef = useRef<HTMLDivElement>(null);
```
Before:
```tsx
  useEffect(() => {
    if (!pendingPortsScroll || activeTab !== 'overview') return;
    document.querySelector('[data-testid="network-detail-ports"]')?.scrollIntoView?.({ block: 'start' });
    setPendingPortsScroll(false);
  }, [pendingPortsScroll, activeTab]);
```
After:
```tsx
  // Scrolling alone strands a keyboard user: the viewport moves but the focus
  // ring does not, so the next Tab continues from the stat strip. The section
  // is focusable only as a programmatic target (tabIndex -1), so it never
  // enters the tab order itself.
  useEffect(() => {
    if (!pendingPortsScroll || activeTab !== 'overview') return;
    const section = portsSectionRef.current;
    section?.scrollIntoView?.({ block: 'start' });
    section?.focus?.();
    setPendingPortsScroll(false);
  }, [pendingPortsScroll, activeTab]);

  // The "Last poll" stat is a shortcut to the Monitoring tab; the same rule
  // applies — land the caret where the eye was sent.
  const [pendingMonitoringFocus, setPendingMonitoringFocus] = useState(false);
  const handleViewMonitoring = useCallback(() => {
    setPendingMonitoringFocus(true);
    switchTab('monitoring');
  }, []);
  useEffect(() => {
    if (!pendingMonitoringFocus || activeTab !== 'monitoring') return;
    monitoringPanelRef.current?.focus?.();
    setPendingMonitoringFocus(false);
  }, [pendingMonitoringFocus, activeTab]);
```
`OpenPortsSection` must forward a ref to its `Section`, so give `Section` an optional `sectionRef` prop and pass `tabIndex={-1}` through:

```tsx
export function Section({
  title,
  children,
  testId,
  sectionRef,
}: {
  title: ReactNode;
  children: ReactNode;
  testId?: string;
  /** Set when the section is a focus target for an in-page shortcut. */
  sectionRef?: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={sectionRef}
      tabIndex={sectionRef ? -1 : undefined}
      className="rounded-md border bg-card p-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={testId}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}
```
and in `OpenPortsSection.tsx` add a `sectionRef` prop, forwarding it to `<Section …  sectionRef={sectionRef}>`; the page passes `portsSectionRef`.

- [ ] **Step 6: Label every em-dash**

In `primitives.tsx`, add the shared placeholder and use it from `Field`:

```tsx
/**
 * The page's "we don't know" placeholder. A bare em-dash is announced as
 * "dash" or skipped entirely, so the one cell that says the value is unknown
 * says nothing at all to a screen reader.
 */
export function UnknownValue() {
  const { t } = useTranslation('common');
  return <span aria-label={t('states.unknown')}>—</span>;
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">
        {isBlank(value) || value === null || value === undefined ? <UnknownValue /> : value}
      </dd>
    </div>
  );
}
```
Then replace every remaining literal `'—'` on this page's components with `<UnknownValue />` — `grep -rn "'—'" apps/web/src/components/devices/networkDevice apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` finds them all. (Leave `asset.ip === '—'` / `asset.mac === '—'` **comparisons** alone: those test `mapAsset`'s sentinel, they do not render it.)

- [ ] **Step 7: Green**

```bash
cd apps/web && npx vitest run \
  src/components/devices/NetworkDeviceDetailPage.a11y.test.tsx \
  src/components/devices/NetworkDeviceDetailPage.test.tsx \
  src/components/shared/OverflowTabs.test.tsx
```
`OverflowTabs.test.tsx` must stay green untouched — the id is additive.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/shared/OverflowTabs.tsx \
        apps/web/src/components/devices/NetworkDeviceDetailPage.tsx \
        apps/web/src/components/devices/NetworkDeviceDetailPage.a11y.test.tsx \
        apps/web/src/components/devices/networkDevice/primitives.tsx \
        apps/web/src/components/devices/networkDevice/OpenPortsSection.tsx
git commit -m "$(cat <<'EOF'
fix(web/network-device): tabpanel labelling, stat-strip focus moves, labelled em-dashes

Panels are labelled by their own tab button instead of a duplicate aria-label,
which required giving the overflow dropdown's tab button an id — it had none, so
the association dangled for any tab pushed into "More". The stat-strip shortcuts
now move focus to their target rather than only scrolling, and every "—" carries
an accessible "unknown".

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 12: i18n — every new key in all 8 locales

Tasks 2-11 add English keys as they go. This task translates them into the other seven catalogs **for real** and proves the coverage test is satisfied without raising a baseline.

**Files:**
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json`
- Modify (only if a genuine cognate forces it): `apps/web/src/lib/i18n/translationCoverage.test.ts`

- [ ] **Step 1: Enumerate exactly what English gained**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c
git diff origin/main -- apps/web/src/locales/en/devices.json
```
Every added leaf must appear in all seven other catalogs at the same path. For **removals**, read the diff rather than a hardcoded list: W04 already retired some keys (`manageInDiscovery`) and deliberately kept others it still uses (`manuallySet`, `manuallySetWithDetected`). Delete from all eight catalogs only the keys this wave's own diff removed from `en`, and grep each one first:
```bash
grep -rn "networkDeviceDetailPage.<key>" apps/web/src --include=*.ts --include=*.tsx
```
A key with a surviving reference stays.

- [ ] **Step 2: Translate**

Groups to translate: `reachability.state.*`, `reachability.source.*` (`UniFi` and `SNMP` are proper nouns and stay verbatim — they are legitimate duplicates), `reachability.lastSeenBy`, `reachability.neverObserved`, `reachability.detail.*`, `collection.status.*`, `collection.count.*`, `collection.unknownNeedsAgentUpdate`, `collection.partialRows`, `approval.*`, `probe.*`, `stats.lowestSupply|portsUp|portsUpValue`, `printer.status.*`, `printer.deviceStatus.*`, `printer.errors.*`, `printer.pageCount*`, `health.empty.*`, `charts.*`, `sections.reachability|printerHealth|deviceHealth|pollConfiguration|oids|history|networkChecks|thresholds|scanDetails`, `fields.nicVendor|sysObjectId|legacyScanVerdict`, `identity.copy*`.

`portsUpValue` (`"{{up}} / {{total}}"`) is pure interpolation and will be identical in every locale — that is a legitimate duplicate of the kind the baselines already document; if the coverage test's `devices.json` cap fires only because of it and the proper nouns, raise the cap by exactly that count **with a comment naming each string**, the way every other entry in that file does. Do not raise it to cover an untranslated sentence.

- [ ] **Step 3: Verify**

```bash
cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts
cd apps/web && npx vitest run src/locales/scriptProposalKeys.test.ts
```
Then spot-check one locale end to end:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c
for loc in de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR; do
  node -e "
    const en = require('./apps/web/src/locales/en/devices.json').networkDeviceDetailPage;
    const other = require('./apps/web/src/locales/$loc/devices.json').networkDeviceDetailPage;
    const miss = [];
    (function walk(a, b, p) {
      for (const k of Object.keys(a)) {
        if (typeof a[k] === 'object' && a[k] !== null) walk(a[k], (b ?? {})[k] ?? {}, p ? p + '.' + k : k);
        else if (!b || b[k] === undefined) miss.push(p ? p + '.' + k : k);
      }
    })(en, other, '');
    if (miss.length) { console.log('$loc missing:', miss.join(', ')); process.exit(1); }
  " || exit 1
done
echo 'all 8 locales complete'
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "$(cat <<'EOF'
i18n(web/network-device): translate the page-truth strings into all 8 locales

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Playwright E2E — page object + spec

§15's E2E items that unit tests cannot cover: the real page against the real API. `data-testid` selectors **only** — no text, role, label or CSS.

**Decision:** the printer Health assertion needs a printer asset with SNMP supply metrics, which the shared seed does not have. The spec seeds what it can through the API (create a manual network asset typed `printer`) and asserts the card's **explicit unavailable/empty** state when no poll has landed. The seeded-supplies variant is `test.skip()`-guarded behind `E2E_SNMP_FIXTURE=1` until an SNMP fixture exists — asserting a green supply meter against a stack that never polls would be a test that passes for the wrong reason.

**Files:**
- Create: `e2e-tests/pages/NetworkDevicePage.ts`
- Create: `e2e-tests/tests/network-device-truth.spec.ts`

- [ ] **Step 1: Page object**

Create `e2e-tests/pages/NetworkDevicePage.ts`:

```ts
import type { Locator, Page } from '@playwright/test';

/**
 * `/devices/network/:id` — the network device detail page (#W05).
 *
 * Every locator is a data-testid, per e2e-tests/README.md. The status badge
 * keeps the id it had before the page-truth wave (`network-device-status`);
 * only its TEXT changed, from a bare "Online" to "<state> · <source> <age>".
 */
export class NetworkDevicePage {
  constructor(private page: Page) {}

  goto = (assetId: string, hash = '') => this.page.goto(`/devices/network/${assetId}${hash}`);

  // Shell
  root = () => this.page.getByTestId('network-device-detail');
  loading = () => this.page.getByTestId('network-device-detail-loading');
  name = () => this.page.getByTestId('network-device-name');
  statusBadge = () => this.page.getByTestId('network-device-status');
  approvalBadge = () => this.page.getByTestId('network-detail-approval-badge');
  approvalBanner = () => this.page.getByTestId('network-detail-approval-banner');
  approveButton = () => this.page.getByTestId('network-detail-approve');
  dismissButton = () => this.page.getByTestId('network-detail-dismiss');
  settingsButton = () => this.page.getByTestId('network-detail-settings');

  // Stat strip
  statReachability = () => this.page.getByTestId('network-detail-stat-reachability');
  statLastPoll = () => this.page.getByTestId('network-detail-stat-last-poll');
  statType = () => this.page.getByTestId('network-detail-stat-type');
  statPorts = () => this.page.getByTestId('network-detail-stat-ports');
  checkNow = () => this.page.getByTestId('network-detail-check-now');
  probeStatus = () => this.page.getByTestId('network-detail-probe-status');
  probeError = () => this.page.getByTestId('network-detail-probe-error');

  // Overview
  reachabilityCard = () => this.page.getByTestId('network-detail-reachability-card');
  collectionSummary = () => this.page.getByTestId('network-detail-collection-summary');
  health = () => this.page.getByTestId('network-detail-health');
  healthEmpty = () => this.page.getByTestId('network-detail-health-empty');
  healthUnavailable = () => this.page.getByTestId('network-detail-health-unavailable');
  setUpMonitoring = () => this.page.getByTestId('network-detail-setup-monitoring');
  supplyMeters = (): Locator => this.page.locator('[data-testid^="network-detail-supply-"]');
  pageCount = () => this.page.getByTestId('network-detail-page-count');
  identity = () => this.page.getByTestId('network-detail-identity');
  copyIp = () => this.page.getByTestId('network-detail-copy-ip');
  scanDetails = () => this.page.getByTestId('network-detail-scan-details');
  scanDetailsToggle = () => this.page.getByTestId('network-detail-scan-details-toggle');
  ports = () => this.page.getByTestId('network-detail-ports');

  // Tabs
  tabOverview = () => this.page.getByTestId('network-detail-tab-overview');
  tabMonitoring = () => this.page.getByTestId('network-detail-tab-monitoring');
  monitoringPanel = () => this.page.getByTestId('network-detail-monitoring');

  // Monitoring tab
  pollConfig = () => this.page.getByTestId('network-detail-poll-config');
  editPollConfig = () => this.page.getByTestId('network-detail-edit-poll-config');
  oidTable = () => this.page.getByTestId('network-detail-oid-table');
  oidNoTemplate = () => this.page.getByTestId('network-detail-oid-no-template');
  oidNotConfigured = () => this.page.getByTestId('network-detail-oid-not-configured');
  chartRange = (range: '24h' | '7d' | '30d') => this.page.getByTestId(`network-detail-chart-range-${range}`);
  chartsEmpty = () => this.page.getByTestId('network-detail-charts-empty');
  checks = () => this.page.getByTestId('network-detail-checks');
  thresholds = () => this.page.getByTestId('network-detail-thresholds');

  // W04's settings modal, reached from this page
  settingsModal = () => this.page.getByTestId('network-asset-settings-modal');

  /**
   * The Monitoring tab can be a visible tab or live inside the "More" overflow
   * depending on viewport width, and `OverflowTabs` renders the same testid in
   * both places — so clicking the testid works either way, as long as the
   * dropdown is open first when it is hidden.
   */
  async openMonitoringTab() {
    const tab = this.tabMonitoring();
    if (!(await tab.isVisible())) {
      await this.page.getByTestId('network-detail-tab-more').click();
    }
    await tab.click();
    await this.monitoringPanel().waitFor();
  }
}
```

> `network-detail-tab-more` does not exist yet — `OverflowTabs`'s "More" button carries no `data-testid`. Step 3 adds one; with this page's `testIdPrefix` of `network-detail-tab-` it resolves to exactly `network-detail-tab-more`, so the page object never has to fall back to a text selector.

- [ ] **Step 2: Spec**

Create `e2e-tests/tests/network-device-truth.spec.ts`:

```ts
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { NetworkDevicePage } from '../pages/NetworkDevicePage';

/**
 * Network device page truth (#W05, spec §11 + D9).
 *
 * Covers what unit tests cannot: the real page against the real API — that the
 * status badge is sourced rather than a bare "Online", that Check now produces
 * a visible RESULT LINE whichever way it goes (spec §14: never toast-only),
 * that Settings hands off to W04's modal through the hash, and that the
 * Monitoring tab renders collection state rather than "Enabled".
 *
 * Assets are created through the Devices page's own "Add network asset" flow
 * (the same one manual-network-asset.spec.ts drives) so the specs share no
 * fixture state and can run in any order.
 */
test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

/** Creates a network asset via the real UI and returns its id. */
async function createAsset(
  authedPage: import('@playwright/test').Page,
  type: 'switch' | 'printer',
): Promise<{ id: string; label: string }> {
  const label = `E2E ${type} ${Date.now()}`;
  await authedPage.goto('/devices');
  await authedPage.getByTestId('devices-page-add-menu-trigger').waitFor();
  await authedPage.getByTestId('devices-page-add-menu-trigger').click();
  await authedPage.getByTestId('devices-page-add-menu-network-asset').click();

  await authedPage.getByTestId('asset-label').waitFor();
  await authedPage.getByTestId('asset-label').fill(label);
  await authedPage.getByTestId('asset-type').selectOption(type);
  await authedPage.getByTestId('asset-ip').fill(`10.77.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);

  const siteSelect = authedPage.getByTestId('asset-site');
  if (!(await siteSelect.inputValue())) {
    await siteSelect.selectOption({ index: 1 });
  }

  const [response] = await Promise.all([
    authedPage.waitForResponse((res) => res.url().includes('/devices/network') && res.request().method() === 'POST'),
    authedPage.getByTestId('asset-submit').click(),
  ]);
  expect(response.status()).toBe(201);
  const created = await response.json();

  // Some types offer a post-create hand-off; decline it when present.
  const postCreate = authedPage.getByTestId('asset-post-create-done');
  if (await postCreate.isVisible().catch(() => false)) {
    await postCreate.click();
  }

  return { id: created.id as string, label };
}

test.describe('network device page truth', () => {
  test('the status badge names its source and its age, never a bare Online', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.root().waitFor();

    const badge = page.statusBadge();
    await expect(badge).toBeVisible();
    // The copy rule: every status string is "<state> · <source> <relative>".
    await expect(badge).toContainText('·');
    // A never-scanned manual asset is Unverified, not Offline — an absent
    // verdict must never render as a negative one.
    await expect(badge).not.toHaveText('Online');
    await expect(badge).not.toHaveText('Offline');

    // The strip repeats the same sourced string, not a second phrasing.
    await expect(page.statReachability()).toContainText('·');
  });

  test('Check now produces an inline result line, never a toast alone', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.checkNow().waitFor();

    const [response] = await Promise.all([
      authedPage.waitForResponse((res) => res.url().includes(`/discovery/assets/${id}/probe`) && res.request().method() === 'POST'),
      page.checkNow().click(),
    ]);
    // 200 = answered, 202 = pending, 409 = no agent in this site / already
    // running. On a seeded stack with no agent at the site the honest outcome
    // is 409, and the acceptance criterion is that the page SAYS so inline.
    expect([200, 202, 409]).toContain(response.status());

    await expect(page.probeStatus().or(page.probeError())).toBeVisible({ timeout: 15_000 });
  });

  test('Settings opens W04’s modal and the hash addresses its sections', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);

    await page.settingsButton().click();
    await expect(page.settingsModal()).toBeVisible();
    await expect(authedPage).toHaveURL(/#overview\/settings\/identity$/);

    // Deep-linking straight to a section is how Discovery and /monitoring/network
    // hand off to this page.
    await page.goto(id, '#overview/settings/monitoring');
    await expect(page.settingsModal()).toBeVisible();
    await expect(authedPage).toHaveURL(/#overview\/settings\/monitoring$/);
  });

  test('the Monitoring tab shows collection state and a working range toggle', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.openMonitoringTab();

    await expect(page.pollConfig()).toBeVisible();
    // With no SNMP device yet, the honest state is "not configured" — not an
    // empty table that reads as "nothing to report".
    await expect(page.oidTable().or(page.oidNoTemplate()).or(page.oidNotConfigured())).toBeVisible();
    await expect(page.checks()).toBeVisible();
    await expect(page.thresholds()).toBeVisible();

    // Charts only fetch once something is collecting; otherwise they say so.
    if (await page.chartRange('7d').isVisible().catch(() => false)) {
      const [metricsResponse] = await Promise.all([
        authedPage.waitForResponse((res) => res.url().includes(`/monitoring/assets/${id}/metrics`)),
        page.chartRange('7d').click(),
      ]);
      expect(metricsResponse.url()).toContain('bucket=1h');
    } else {
      await expect(page.chartsEmpty()).toBeVisible();
    }
  });

  test('"All scan details" is closed by default and opens on demand', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'switch');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.identity().waitFor();

    await expect(page.scanDetails()).not.toHaveAttribute('open', /.*/);
    await page.scanDetailsToggle().click();
    await expect(page.scanDetails()).toHaveAttribute('open', /.*/);
  });

  test('the printer Health card states what is not collected yet', async ({ authedPage }) => {
    const { id } = await createAsset(authedPage, 'printer');
    const page = new NetworkDevicePage(authedPage);
    await page.goto(id);
    await page.health().waitFor();

    // No SNMP device yet: the card IS the set-up affordance.
    await expect(page.healthEmpty().or(page.healthUnavailable())).toBeVisible();
    await expect(page.supplyMeters()).toHaveCount(0);
    await expect(page.setUpMonitoring()).toBeVisible();
  });

  test('a polled printer shows supply meters and a page count', async ({ authedPage }) => {
    test.skip(process.env.E2E_SNMP_FIXTURE !== '1', 'needs a seeded SNMP supply fixture');
    const assetId = process.env.E2E_SNMP_PRINTER_ASSET_ID!;
    const page = new NetworkDevicePage(authedPage);
    await page.goto(assetId);
    await page.health().waitFor();

    await expect(page.supplyMeters().first()).toBeVisible();
    await expect(page.pageCount()).toBeVisible();
  });
});
```

- [ ] **Step 3: Add the missing "More" testid**

In `apps/web/src/components/shared/OverflowTabs.tsx`, on the dropdown trigger (`:204`):

```tsx
            <button
              type="button"
              data-testid={testIdPrefix ? `${testIdPrefix}more` : undefined}
              onClick={() => setMoreOpen(!moreOpen)}
```
It is `undefined` without a prefix, so no existing consumer changes.

- [ ] **Step 4: Run**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c && pnpm wt-stack up
cd e2e-tests && pnpm test network-device-truth.spec.ts
```
Read the reported test count — six run, one skips without `E2E_SNMP_FIXTURE=1`. Tear the stack down when finished:
```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c && pnpm wt-stack down
```

- [ ] **Step 5: Commit**

```bash
git add e2e-tests/pages/NetworkDevicePage.ts e2e-tests/tests/network-device-truth.spec.ts \
        apps/web/src/components/shared/OverflowTabs.tsx
git commit -m "$(cat <<'EOF'
test(e2e): network device page truth — sourced status, Check now, settings hash, monitoring tab

Also gives OverflowTabs' "More" trigger a data-testid so the page object never
needs a text selector for it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

---

### Task 14: full verification and the PR

- [ ] **Step 1: Typecheck both apps**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c
pnpm exec tsc --noEmit --project apps/api/tsconfig.json
cd apps/web && pnpm exec astro check
```

- [ ] **Step 2: Full web suite + the two contract tests + the API routes touched**

```bash
cd apps/web && npx vitest run
cd apps/web && npx vitest run \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/__tests__/network-asset-single-writer.test.ts \
  src/lib/i18n/translationCoverage.test.ts
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-lucky-cloud-2f0c/apps/api && npx vitest run \
  src/routes/discovery.test.ts \
  src/routes/monitoring_assets_thresholds.test.ts \
  src/routes/monitoring_assets_snmp.test.ts \
  src/routes/monitoring_assets_list.test.ts
```
Note the file *count* each run reports — a path filter that silently matched nothing reads identical to a clean pass.

- [ ] **Step 3: Lint**

```bash
cd apps/web && pnpm lint
```

- [ ] **Step 4: Rebase on main and re-run the affected suites**

Local green on a stale base is not CI green. Merge `origin/main` first, then re-run step 2's web suite.

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --title "Network device page truth W05: web page IA" --body "$(cat <<'EOF'
Closes #<W05 sub-issue>

Implements §11 and D9 of `docs/superpowers/specs/monitoring/2026-09-16-network-device-page-truth-design.md`.

## What changed

- **Header** — the status badge reads `<state> · <source> <relative time>` from W01's `reachability` instead of the last subnet sweep's `is_online`. The approval badge is hidden when approved; pending/dismissed get an action banner (Approve · Dismiss) through W04's single writer. "Manage in Discovery" is gone — the page owns the asset.
- **Stat strip** — Reachability (with **Check now**) · Last poll · a type slot (printer: lowest supply; network gear: ports up; else ping) · Open ports. "Linked device" moved to Identity.
- **Overview** — a type-dispatched `HealthCard` registry (`PrinterHealth` with supply meters, page counts and decoded printer status; `GenericHealth`; `EmptyHealth` as the set-up affordance) beside a `ReachabilityCard` that shows one line per contributing source, the collection summary and the bridging agent. Identity is condensed with copy buttons and an "All scan details" disclosure; open ports unchanged.
- **Monitoring tab** — poll configuration with Edit (opens W04's modal at its Monitoring section), an OID table with per-OID state/latest/age and expandable instances, history charts (24h/7d/30d, counters as deltas), network checks with their latest results, and the armed SNMP threshold alerts.
- **API (read-only, two fields)** — `GET /discovery/assets/:id` returns `siteTimezone` (the `sites` join already existed) so timestamps render in the site's zone; new `GET /monitoring/assets/:id/thresholds`, because `/snmp/thresholds/:deviceId` is a 410 stub and there was no way to read what is armed.
- **A11y** — tabpanels labelled by their own tab button (required giving the overflow dropdown's tab button an `id`), stat-strip shortcuts move focus, every `—` carries an accessible "unknown".

## Decisions taken here (spec left them open)

- Site timezone comes from a new `siteTimezone` field on the existing asset response; resolution is site → browser.
- SNMP threshold alerts needed a new read route (the old one is deprecated).
- `EmptyHealth` covers "no SNMP device"; a device with SNMP but no template keeps its type card, which explains that failure.
- The UPS type slot folds into the default ping slot — `ups` is not in `DiscoveredAssetType`.
- One capitalised set of reachability source labels, reused in the `lastSeenBy` phrase.
- `formatTimestamp` drops seconds for every caller on this page, not only "First seen".

## Verification

- `apps/web` full vitest suite, `no-silent-mutations` (count 133 → 134 for `useAssetProbe.ts`), `network-asset-single-writer`, `translationCoverage`.
- `apps/api`: `discovery.test.ts`, `monitoring_assets_thresholds.test.ts`.
- `astro check` and `tsc --noEmit` on `apps/api`.
- Playwright `network-device-truth.spec.ts`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Dispatch CI on the branch**

```bash
gh workflow run CI --ref feature/<parent#>-network-device-page-truth/wave-<W05 sub-issue#>
```
Required because a branch stacked on W04 gets no `pull_request` run until W04 has merged and this PR retargets `main`. Once it does target `main`, the `pull_request` run is the one that satisfies `CI Success` — a dispatched run does not.

- [ ] **Step 7: Review, then stop**

Run `/pr-review-toolkit:review-pr` and post the summary on the PR. **Do not merge** — the wave lands through the merge queue once reviewed.

---

## Follow-ups deliberately not in this wave

| Item | Why it is out |
|---|---|
| Shared `CopyButton` / clipboard helper for all nine existing call sites | A repo-wide refactor inside a page wave; `networkDevice/CopyButton.tsx` is local until someone does it properly |
| A `ups` entry in `DiscoveredAssetType` + a `UpsHealth` card | The spec's UPS stat-slot example has no asset type to key on; adding one touches the discovery classifier, the list filters and the type select |
| Seeded SNMP supply fixture for E2E | The positive printer-supplies E2E path is `test.skip`-guarded behind `E2E_SNMP_FIXTURE=1` until one exists |
| `ifTable` switch health card (ports up/down per interface) | The stat slot reads `ifOperStatus`; a full switch Health card is a second registry entry, not part of §11 |
