---
tracking_issue: LanternOps/breeze#5511
---

# HP Warranty via HP CMSL — W05: Cleanup and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the dead, deliberately-unregistered HP warranty provider (`hpProvider.ts`) and its unique dependencies now that HP coverage comes from the agent-collected CMSL path, add the missing `agent_cmsl` (and `import`) data-source labels to the device warranty card, and correct the two docs pages that still say "HP has no lookup."

**Architecture:** Pure cleanup — no new runtime behavior. Delete one module and its now-orphaned rate limiter, shrink one comment and one test file to match, extend a `switch` statement by two cases, and edit two Starlight docs pages.

**Tech Stack:** TypeScript (Hono API service layer), React (Astro island), Vitest, Starlight/Astro docs.

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md` (see its "Layer 7 — UI and cleanup" section and "Corrections after ground-truth verification"). Cross-wave contract (authoritative on conflicts): `/private/tmp/claude-501/-Users-toddhebebrand--herdr-worktrees-breeze-warranty-testing/4b860881-d3d0-4020-ad1e-65daf215df86/scratchpad/contract-B-hp-cmsl.md`, wave ownership map.

## GATE — read this before starting Task 2

**None of the deletion work in this plan may run until the new HP-CMSL path has actually landed and is verified working.** The comment this wave deletes (`warrantyProviders/index.ts:7-11`) says so explicitly today: *"HP coverage is coming from the agent instead. The module is kept (and unit-tested) until that lands."* Deleting `hpProvider.ts` before W01–W04 (#5512–#5515) ship would leave HP devices with **no path at all** — not the old broken one, not the new one.

Task 1 below is a hard, mechanical gate check. If it fails, **stop the plan** — do not execute Task 2, 3, or 4 — and report which prerequisite is missing. Tasks 3 (web label) and 4 (docs) are also gated the same way: they describe the new agent-collected path as live, which is false until W02–W04 ship.

## Global Constraints

- **Tracking:** `LanternOps/breeze#5511` (parent), this plan implements wave `#5516` (W05).
- **Wave ownership (from the cross-wave contract):** W05 owns *only*: deleting `hpProvider.ts`, `HP_WARRANTY_ENABLED`, the throttle references, and `hpRateLimiter` if unused; the `agent_cmsl` label in `DeviceWarrantyCard.tsx`; `warranty-tracking.mdx`. W05 must **not** touch config policy, agent code, the catalog/built-in package, or `warrantySync.ts` — those belong to W01–W04.
- **Ground truth, verified 2026-09-10 (re-confirm only if a cited file has moved):**
  - `hpProvider.ts` exports exactly one symbol, `hpProvider` (`:4`).
  - `hpProvider.ts` is referenced from exactly three other places in the repo: `warrantyProviders/index.ts:7` (a comment only — never registered/imported), `warrantyProviderThrottle.test.ts:19,42,43,44,50,55` (import + 3 HP-specific `it` bodies).
  - `hpRateLimiter` (`throttle.ts:48`) is referenced from exactly two other places: `hpProvider.ts:2,25` and `warrantyProviderThrottle.test.ts:14` (a `vi.mock` factory entry). Nothing else in `apps/api`, `apps/web`, or `packages/shared` imports it — `dellProvider.ts` uses no rate limiter at all (official OAuth API), and `lenovoProvider.ts` uses only `lenovoRateLimiter`. **Confirmed safe to delete alongside `hpProvider.ts`.**
  - `HP_WARRANTY_ENABLED` is read at exactly one place in the whole repo, `hpProvider.ts:13`. It appears in no `.env.example` (root or any app), no `docker-compose*.yml`, and no `.github/` CI config — confirmed by repo-wide grep. Deleting `hpProvider.ts` removes every reference; no separate deletion step is needed.
  - `DeviceWarrantyCard.tsx`'s `dataSourceLabel` function (`:60-67`) falls through to the **raw string** for any unrecognized `dataSource` (`:65`, `default: return source;`). Today `'agent_cmsl'` and `'import'` are both unrecognized and would render literally.
  - `'import'` is written by `apps/api/src/services/customFields/import/warrantyTarget.ts:216` (`dataSource: 'import' as const`) — an existing, already-shipped data source, unrelated to this feature, that happens to share the same unhandled-fallback bug. **Decision: fix it in the same pass** (Task 3) — it's the same one-line `switch` statement, the same bug class the task is already touching, and leaving it half-fixed would mean re-opening this exact function in a future PR for one more `case`.
  - `apps/docs/src/content/docs/features/warranty-tracking.mdx:14` says *"HP has no lookup yet, so HP devices stay `unknown`."*
  - **Additional finding, in scope:** `apps/docs/src/content/docs/deploy/environment.mdx:790` (inside the Lenovo `<Aside>` in the "Warranty lookups" section) also says *"HP has no lookup yet — HP's Warranty API is not available to MSP or RMM vendors, so HP devices stay `unknown`."* `warranty-tracking.mdx:14` itself sends readers here ("Vendor configuration is described under Environment → Warranty lookups"), so leaving this stale would make the two pages contradict each other the moment `warranty-tracking.mdx` is fixed. In scope for Task 4.
- **Testing command trap:** Never `pnpm --filter <pkg> test -- --run <path>` — the `--` token breaks vitest's flag parsing and it silently runs the whole suite in watch mode. Use `cd apps/api && npx vitest run <path>` / `cd apps/web && npx vitest run <path>`.
- **No migration needed.** This wave touches no database schema — `HP_WARRANTY_ENABLED` is a process env var, and the data-source values (`agent_cmsl`, `import`) already exist as free-form strings against a `varchar(50)` column with no CHECK constraint.
- **No placeholders.** Every step below shows the exact file content, not a description of it.

---

## 0. Ground truth

### `apps/api/src/services/warrantyProviders/hpProvider.ts` (95 lines, to be deleted in full)

```ts
1  import type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';
2  import { hpRateLimiter } from './throttle';
3
4  export const hpProvider: WarrantyProvider = {
5    name: 'hp',
6
7    supports(manufacturer: string): boolean {
8      const lower = manufacturer.toLowerCase();
9      return lower.includes('hp') || lower.includes('hewlett');
10   },
11
12   isConfigured(): boolean {
13     const enabled = process.env.HP_WARRANTY_ENABLED;
14     // Opt-in only — requires explicit enable (consistent with Dell/Lenovo credential requirements)
15     return enabled === 'true' || enabled === '1';
16   },
17
18   async lookup(serialNumbers: string[]): Promise<Map<string, WarrantyLookupResult>> {
     ... (fetches https://support.hp.com/hp-pps-api/os/getWarrantyInfo, rate-limited via hpRateLimiter)
95 };
```
`isConfigured()` (`:12-16`) is the sole reader of `HP_WARRANTY_ENABLED`. `lookup()` (`:18-94`) is the sole caller of `hpRateLimiter.acquire()`.

### `apps/api/src/services/warrantyProviders/index.ts` (34 lines, comment + array to edit)

```ts
1  import type { WarrantyProvider } from './types';
2  import { dellProvider } from './dellProvider';
3  import { lenovoProvider } from './lenovoProvider';
4
5  export type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';
6
7  // hpProvider is deliberately NOT registered: its unofficial support.hp.com
8  // endpoint now returns the site's HTML shell (verified 2026-09-09) and HP's real
9  // backend is captcha-gated, so enabling it only parks devices in `unknown` with
10 // a JSON parse error. HP coverage is coming from the agent instead. The module
11 // is kept (and unit-tested) until that lands.
12 const providers: WarrantyProvider[] = [dellProvider, lenovoProvider];
13
14 export function normalizeManufacturer(raw: string): string {
15   const lower = raw.toLowerCase().trim();
16   if (lower.includes('apple')) return 'apple';
17   if (lower.includes('dell')) return 'dell';
18   if (lower.includes('hp') || lower.includes('hewlett')) return 'hp';
19   if (lower.includes('lenovo')) return 'lenovo';
20   return lower.replace(/[^a-z0-9]/g, '');
21 }
22
23 export function getProviderForManufacturer(manufacturer: string): WarrantyProvider | null {
    ...
30 }
31
32 export function getConfiguredProviders(): WarrantyProvider[] {
33   return providers.filter((p) => p.isConfigured());
34 }
```
`hpProvider` is never imported here — `providers` (`:12`) already omits it. Only the comment (`:7-11`) references the (soon-deleted) module by name and needs rewriting; `normalizeManufacturer` (`:14-21`) already collapses `hp`/`hewlett` → `'hp'` and is untouched — it's used by the agent-reported `manufacturer` field too, not just this file's own providers.

### `apps/api/src/services/warrantyProviders/throttle.ts` (49 lines)

```ts
1  // Per-provider request rate limiter for the third-party warranty lookups (HP's
2  // unofficial support endpoint, Lenovo's pcsupport API).
...
44 export const WARRANTY_LOOKUP_MIN_INTERVAL_MS = 250;
45
46 // One limiter per provider — they hit different vendors, so their rate limits
47 // are independent.
48 export const hpRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
49 export const lenovoRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
```
Line 48 (`hpRateLimiter`) is the only HP-specific line; `createWarrantyRateLimiter`, `WarrantyRateLimiter`, and `WARRANTY_LOOKUP_MIN_INTERVAL_MS` are generic and stay, still used by `lenovoRateLimiter` (`:49`) and, through it, `lenovoProvider.ts:2,338,356`.

### `apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts` (105 lines)

Full current content (reproduced because Task 2 rewrites most of it):

```ts
1   import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
2
3   // Spy on the per-provider limiter INSTANCES so we can prove the providers
4   // acquire once per vendor fetch, while keeping the real createWarrantyRateLimiter
5   // for the spacing unit test below.
6   const { hpAcquire, lenovoAcquire } = vi.hoisted(() => ({
7     hpAcquire: vi.fn().mockResolvedValue(undefined),
8     lenovoAcquire: vi.fn().mockResolvedValue(undefined),
9   }));
10  vi.mock('./throttle', async (importOriginal) => {
11    const actual = await importOriginal<typeof import('./throttle')>();
12    return {
13      ...actual,
14      hpRateLimiter: { acquire: hpAcquire },
15      lenovoRateLimiter: { acquire: lenovoAcquire },
16    };
17  });
18
19  import { hpProvider } from './hpProvider';
20  import { lenovoProvider } from './lenovoProvider';
21  import { createWarrantyRateLimiter } from './throttle';
...
37  describe('warranty provider request throttling (#3201)', () => {
38    // ... 3 HP its at lines 41-57 (acquires per call, per serial, no-serials-no-acquire)
59    // ... 2 Lenovo its at lines 59-73
75  });
76
77  describe('createWarrantyRateLimiter', () => {
    // ... 1 generic it, lines 77-104, no HP/Lenovo dependency
105 });
```
Lines needing to change: `6-9` (drop `hpAcquire`), `14` (drop the `hpRateLimiter` mock entry), `19` (drop the `hpProvider` import), `27` (drop `hpAcquire.mockClear()` in `beforeEach`), and the three HP `it`s inside the first `describe` (`41-57`). The two Lenovo `it`s (`59-73`) and the entire `createWarrantyRateLimiter` `describe` (`77-104`) are untouched.

### `apps/web/src/components/devices/DeviceWarrantyCard.tsx:60-67`

```ts
60 function dataSourceLabel(source: string | null): string {
61   if (!source) return '';
62   switch (source) {
63     case 'agent_plist': return 'Agent (macOS plist)';
64     case 'provider': return 'Vendor API';
65     default: return source;
66   }
67 }
```
Called at `:357` as `dataSourceLabel(warranty.dataSource)`, rendered inside `t('deviceWarrantyCard.source', { source: ... })`. The i18n key resolves (`apps/web/src/locales/en/devices.json:1819`) to `"Source: {{source}}"` — the label itself is plain hardcoded English (matching the existing `'agent_plist'`/`'provider'` cases), not a translation key. The `warranty.dataSource` / `Source: ...` line only renders in the **full (non-compact)** card view (`:354-358`, inside the `// Full expanded view` return block) — `compact` mode never shows it.

### `apps/web/src/components/devices/DeviceWarrantyCard.test.tsx`

Existing pattern: a `warrantyPayload(overrides)` helper (`:40-57`) defaults `dataSource: 'provider'`; tests `render(<DeviceWarrantyCard deviceId={deviceId} />)` (full, non-compact by default) and assert on `screen`. No existing test covers `dataSourceLabel` / the "Source: ..." line at all.

### `apps/docs/src/content/docs/features/warranty-tracking.mdx:14`

```
Breeze stores one warranty record per device (`device_warranty`) with the manufacturer, serial number, coverage status, and start/end dates. A background worker runs every 6 hours and re-checks each device about once every 7 days (50 devices per run), looking the serial number up against the vendor providers your instance has configured — Dell (official API credentials) and Lenovo (official API ClientID and/or the credential-free opt-in); Apple/AppleCare coverage is reported by the macOS agent. HP has no lookup yet, so HP devices stay `unknown`. Vendor configuration is described under [Environment → Warranty lookups](/deploy/environment/#warranty-lookups). The Warranty **tab does not set warranty dates** — it only configures the alert thresholds evaluated against whatever dates the sync has discovered. Devices whose warranty status is still `unknown`, or that have no end date, are skipped.
```
The page imports `{ Steps, Aside }` from `@astrojs/starlight/components` (`:6`) and already uses both — new content should reuse these, not introduce new components.

### `apps/docs/src/content/docs/deploy/environment.mdx:778-791`

```
778 ## Warranty lookups
779
780 The warranty worker looks each physical device's serial number up against its manufacturer so the device page and [warranty-expiry alerts](/features/warranty-tracking/) carry real coverage dates. Every vendor is off until configured; an unconfigured vendor leaves its devices at status `unknown`. Apple coverage is reported by the macOS agent and needs no configuration.
781
782 | Variable | Default | Description |
783 |---|---|---|
784 | `DELL_CLIENT_ID` | — | OAuth client ID from Dell's [TechDirect](https://techdirect.dell.com) Warranty API |
785 | `DELL_CLIENT_SECRET` | — | Matching Dell OAuth client secret. Both are required for Dell lookups. |
786 | `LENOVO_API_KEY` | — | ClientID for Lenovo's official [Warranty API](https://supportapi.lenovo.com/Documentation/Warranty.html) (`supportapi.lenovo.com`), issued through a Lenovo partner manager |
787 | `LENOVO_WARRANTY_ENABLED` | — | `true` enables credential-free Lenovo lookups through the JSON endpoint behind Lenovo's public warranty-lookup page. It is not documented by Lenovo and may stop working without notice, so it is opt-in. |
788
789 <Aside>
790   When both Lenovo settings are present the official API is authoritative: a definite "no warranty found" from it is final, and the public endpoint is only consulted when the official call itself fails (bad key, outage). HP has no lookup yet — HP's Warranty API is not available to MSP or RMM vendors, so HP devices stay `unknown`.
791 </Aside>
```
No `HP_*` row exists in the table (correctly — the agent-collected path is app-configured, not env-var-configured), so the fix is confined to the `<Aside>` prose.

### Repo-wide grep hit lists (run 2026-09-10, sole basis for "safe to delete")

```
$ grep -rn "hpProvider" --include="*.ts" --include="*.tsx" apps/ packages/
apps/api/src/services/warrantyProviders/hpProvider.ts:4:export const hpProvider: WarrantyProvider = {
apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts:19:import { hpProvider } from './hpProvider';
apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts:42:    await hpProvider.lookup(['a']);
apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts:43:    await hpProvider.lookup(['b']);
apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts:44:    await hpProvider.lookup(['c']);
apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts:50:    await hpProvider.lookup(['a', 'b']);
apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts:55:    await hpProvider.lookup([]);
apps/api/src/services/warrantyProviders/index.ts:7:// hpProvider is deliberately NOT registered: its unofficial support.hp.com

$ grep -rn "hpRateLimiter" --include="*.ts" --include="*.tsx" apps/ packages/
apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts:14:    hpRateLimiter: { acquire: hpAcquire },
apps/api/src/services/warrantyProviders/throttle.ts:48:export const hpRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
apps/api/src/services/warrantyProviders/hpProvider.ts:2:import { hpRateLimiter } from './throttle';
apps/api/src/services/warrantyProviders/hpProvider.ts:25:      await hpRateLimiter.acquire();

$ grep -rn "HP_WARRANTY_ENABLED" . --include="*.ts" --include="*.tsx" --include="*.env*" --include="*.yml" --include="*.yaml" --include="*.md"
docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md:285: (the spec's own prose, not code)
apps/api/src/services/warrantyProviders/hpProvider.ts:13:    const enabled = process.env.HP_WARRANTY_ENABLED;
```
Every hit in each list resolves inside a file this plan already touches. There is no fourth file anywhere in the repo.

---

## Task 1: Gate check — confirm the new HP CMSL path has actually landed

**Files:** none modified. Read-only verification.

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first task).
- Produces: a go/no-go decision gating Tasks 2-4.

- [ ] **Step 1: Check the built-in HP CMSL package landed (W04, #5515)**

Run:
```bash
grep -n "hp_cmsl" apps/api/src/services/builtinDeploymentPackages.ts
```
Expected: at least one match (the third `BuiltinPackageDef` union arm / `BUILTIN_PACKAGES` entry). **If zero matches, STOP — do not proceed to Task 2.**

- [ ] **Step 2: Check the agent collector landed (W03, #5514)**

Run:
```bash
ls agent/internal/collectors/hp_warranty_windows.go agent/internal/collectors/hp_warranty_other.go
```
Expected: both files exist. **If either is missing, STOP.**

- [ ] **Step 3: Check the agent config seam landed (W02, #5513)**

Run:
```bash
ls agent/internal/heartbeat/warranty_config.go
grep -n "hpCmsl\|hp_cmsl" apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.tsx
```
Expected: the file exists, and the grep returns at least one match (the opt-in checkbox / consent UI). **If either check comes back empty, STOP.**

- [ ] **Step 4: Check the ingest hardening landed (W01, #5512)**

Run:
```bash
grep -n "AGENT_OWNED_WARRANTY_SOURCES\|isAgentOwnedWarrantySource" apps/api/src/services/warrantySync.ts
```
Expected: at least one match. **If zero matches, STOP** — without this, deleting the old provider removes HP's only *server-side* path while the agent path still can't safely preserve its own rows.

- [ ] **Step 5: Confirm the tracking sub-issues are closed**

Run:
```bash
gh issue view 5512 --repo LanternOps/breeze --json state,title
gh issue view 5513 --repo LanternOps/breeze --json state,title
gh issue view 5514 --repo LanternOps/breeze --json state,title
gh issue view 5515 --repo LanternOps/breeze --json state,title
```
Expected: `"state": "CLOSED"` on all four. If any is still `OPEN`, treat Steps 1-4 as the authoritative signal (code merged but issue not yet closed is a bookkeeping lag, not a blocker) — but if an issue is open **and** its corresponding code check in Steps 1-4 also failed, that confirms STOP is correct.

- [ ] **Step 6: Record the outcome**

If all of Steps 1-4 passed: proceed to Task 2. State in the wave's PR description (or issue #5516 comment) which commit/PR satisfied each check, so the eventual reviewer doesn't have to re-derive it.

If any check failed: do not touch any file. Report exactly which wave is missing (W01/W02/W03/W04) and stop working this plan until it lands — re-run Task 1 later rather than guessing.

---

## Task 2: Delete `hpProvider.ts` and sweep every reference

**Files:**
- Delete: `apps/api/src/services/warrantyProviders/hpProvider.ts`
- Modify: `apps/api/src/services/warrantyProviders/throttle.ts` (remove `hpRateLimiter`)
- Modify: `apps/api/src/services/warrantyProviders/index.ts` (rewrite the non-registration comment)
- Modify: `apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts` (drop HP-specific mocks/tests)
- Test: `apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts` (same file — it IS the test)

**Interfaces:**
- Consumes: Task 1's go-ahead. Nothing else — this task has no dependency on any other wave's code beyond what Task 1 already confirmed exists.
- Produces: nothing later tasks in this plan depend on (Tasks 3 and 4 touch unrelated files).

- [ ] **Step 1: Baseline — confirm the current suite is green before touching anything**

Run:
```bash
cd apps/api && npx vitest run src/services/warrantyProviders/warrantyProviderThrottle.test.ts
```
Expected: PASS, 6 tests (3 HP + 2 Lenovo in the first `describe`, 1 in `createWarrantyRateLimiter`).

- [ ] **Step 2: Delete the module**

```bash
rm apps/api/src/services/warrantyProviders/hpProvider.ts
```

- [ ] **Step 3: Run the test file again to see the break the deletion causes**

Run:
```bash
cd apps/api && npx vitest run src/services/warrantyProviders/warrantyProviderThrottle.test.ts
```
Expected: FAIL — module resolution error on `import { hpProvider } from './hpProvider'` (line 19), since the file no longer exists.

- [ ] **Step 4: Rewrite the test file to drop every HP reference**

Replace the full content of `apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts` with:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Spy on the per-provider limiter INSTANCE so we can prove the provider
// acquires once per vendor fetch, while keeping the real createWarrantyRateLimiter
// for the spacing unit test below.
const { lenovoAcquire } = vi.hoisted(() => ({
  lenovoAcquire: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./throttle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./throttle')>();
  return {
    ...actual,
    lenovoRateLimiter: { acquire: lenovoAcquire },
  };
});

import { lenovoProvider } from './lenovoProvider';
import { createWarrantyRateLimiter } from './throttle';

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

beforeEach(() => {
  lenovoAcquire.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('warranty provider request throttling (#3201)', () => {
  // The bug this guards: production calls lookup([oneSerial]) once per device, so
  // the limiter MUST fire per fetch across separate calls — not just within one
  // multi-serial call.
  it('Lenovo: acquires the limiter on every request when configured', async () => {
    vi.stubEnv('LENOVO_API_KEY', 'test-client-id');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', '');
    await lenovoProvider.lookup(['a']);
    await lenovoProvider.lookup(['b']);
    expect(lenovoAcquire).toHaveBeenCalledTimes(2);
  });

  it('Lenovo: no API key → no vendor calls and no acquire', async () => {
    vi.stubEnv('LENOVO_API_KEY', '');
    vi.stubEnv('LENOVO_WARRANTY_ENABLED', '');
    await lenovoProvider.lookup(['a', 'b', 'c']);
    expect(lenovoAcquire).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createWarrantyRateLimiter', () => {
  it('lets the first acquire through immediately but spaces the next by the interval', async () => {
    vi.useFakeTimers();
    // A realistic clock so the initial lastReleaseAt=0 makes the first wait
    // negative (immediate), as in production.
    vi.setSystemTime(1_700_000_000_000);
    try {
      const limiter = createWarrantyRateLimiter(250);

      let firstDone = false;
      limiter.acquire().then(() => {
        firstDone = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(firstDone).toBe(true);

      let secondDone = false;
      limiter.acquire().then(() => {
        secondDone = true;
      });
      // Not yet — must wait out the interval.
      await vi.advanceTimersByTimeAsync(100);
      expect(secondDone).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(secondDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 5: Remove `hpRateLimiter` from `throttle.ts`**

In `apps/api/src/services/warrantyProviders/throttle.ts`, replace:

```ts
// Per-provider request rate limiter for the third-party warranty lookups (HP's
// unofficial support endpoint, Lenovo's pcsupport API).
```

with:

```ts
// Per-provider request rate limiter for third-party warranty lookups (Lenovo's
// pcsupport API and any future server-side vendor lookup).
```

and replace:

```ts
// One limiter per provider — they hit different vendors, so their rate limits
// are independent.
export const hpRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
export const lenovoRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
```

with:

```ts
export const lenovoRateLimiter = createWarrantyRateLimiter(WARRANTY_LOOKUP_MIN_INTERVAL_MS);
```

`createWarrantyRateLimiter`, `WarrantyRateLimiter`, `WARRANTY_LOOKUP_MIN_INTERVAL_MS`, and `sleep` are untouched — they're generic and `lenovoRateLimiter` still depends on all three.

- [ ] **Step 6: Rewrite the non-registration comment in `index.ts`**

In `apps/api/src/services/warrantyProviders/index.ts`, replace:

```ts
// hpProvider is deliberately NOT registered: its unofficial support.hp.com
// endpoint now returns the site's HTML shell (verified 2026-09-09) and HP's real
// backend is captcha-gated, so enabling it only parks devices in `unknown` with
// a JSON parse error. HP coverage is coming from the agent instead. The module
// is kept (and unit-tested) until that lands.
const providers: WarrantyProvider[] = [dellProvider, lenovoProvider];
```

with:

```ts
// HP has no entry in `providers`: HP's official Warranty API is closed to
// MSP/RMM vendors, and the unofficial support.hp.com endpoint HP once exposed
// now returns the site's HTML shell behind a captcha, not JSON — there is no
// working server-side lookup to register. HP coverage instead comes from the
// agent: it collects warranty and entitlement data on-device via HP's Client
// Management Script Library and reports it through the normal agent
// warranty-info ingest path (data source `agent_cmsl`), bypassing this
// provider/lookup mechanism entirely. See
// docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md.
const providers: WarrantyProvider[] = [dellProvider, lenovoProvider];
```

- [ ] **Step 7: Run the test file again to confirm it's green**

Run:
```bash
cd apps/api && npx vitest run src/services/warrantyProviders/warrantyProviderThrottle.test.ts
```
Expected: PASS, 3 tests (2 Lenovo + 1 `createWarrantyRateLimiter`).

- [ ] **Step 8: Run the full warrantyProviders directory's tests to catch anything adjacent**

Run:
```bash
cd apps/api && npx vitest run src/services/warrantyProviders
```
Expected: PASS — this also exercises `dellProvider.test.ts` / `lenovoProvider.test.ts` / `index.test.ts` if they exist, confirming nothing else in the directory referenced the deleted symbols.

- [ ] **Step 9: Repo-wide grep sweep — prove zero remaining references**

Run:
```bash
grep -rn "hpProvider\|hpRateLimiter\|HP_WARRANTY_ENABLED" apps/ packages/ --include="*.ts" --include="*.tsx"
```
Expected: **no output**. If anything prints, it is a reference this plan's ground-truth pass missed — stop and fix it before committing (do not silently ignore it; the whole point of this wave is not missing one).

- [ ] **Step 10: Typecheck the API package as a belt-and-suspenders check**

Run:
```bash
cd apps/api && npx tsc --noEmit
```
Expected: no new errors attributable to this change (pre-existing unrelated errors, if any, are out of scope — compare against a baseline run on `main` if unsure).

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/warrantyProviders/hpProvider.ts \
  apps/api/src/services/warrantyProviders/throttle.ts \
  apps/api/src/services/warrantyProviders/index.ts \
  apps/api/src/services/warrantyProviders/warrantyProviderThrottle.test.ts
git commit -m "chore(api): delete dead hpProvider now the agent CMSL path has landed

HP warranty coverage moved to the agent-collected HP CMSL path (#5511).
hpProvider.ts was deliberately unregistered and kept only until that
path shipped; it's gone now, along with its unique HP_WARRANTY_ENABLED
flag and hpRateLimiter (unused by anything else)."
```
(Note: this repository's own `hpProvider.ts` deletion is itself a `git rm` picked up by `git add` on the removed path — running `git add` on a deleted file stages the deletion.)

---

## Task 3: Add `agent_cmsl` and `import` data-source labels

**Files:**
- Modify: `apps/web/src/components/devices/DeviceWarrantyCard.tsx:60-67`
- Test: `apps/web/src/components/devices/DeviceWarrantyCard.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 2 — independent file, independent package (`apps/web` vs `apps/api`).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to the end of `apps/web/src/components/devices/DeviceWarrantyCard.test.tsx`, just before the file's closing (after the existing `describe('DeviceWarrantyCard — refresh feedback (#1723)', ...)` block, same top-level nesting):

```tsx
describe('DeviceWarrantyCard — data source labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels an agent_cmsl row as "Agent (HP CMSL)"', async () => {
    fetchWithAuthMock.mockImplementation(async () =>
      jsonResponse(warrantyPayload({ dataSource: 'agent_cmsl' }))
    );

    render(<DeviceWarrantyCard deviceId={deviceId} />);

    await screen.findByText('Source: Agent (HP CMSL)');
  });

  it('labels an import row as "CSV Import"', async () => {
    fetchWithAuthMock.mockImplementation(async () =>
      jsonResponse(warrantyPayload({ dataSource: 'import' }))
    );

    render(<DeviceWarrantyCard deviceId={deviceId} />);

    await screen.findByText('Source: CSV Import');
  });

  it('still falls through to the raw string for a genuinely unknown source', async () => {
    fetchWithAuthMock.mockImplementation(async () =>
      jsonResponse(warrantyPayload({ dataSource: 'some_future_source' }))
    );

    render(<DeviceWarrantyCard deviceId={deviceId} />);

    await screen.findByText('Source: some_future_source');
  });
});
```

- [ ] **Step 2: Run the test file to confirm the new tests fail**

Run:
```bash
cd apps/web && npx vitest run src/components/devices/DeviceWarrantyCard.test.tsx
```
Expected: the first two new tests FAIL (current code renders `'Source: agent_cmsl'` and `'Source: import'` literally — the text the test looks for doesn't exist), the third new test PASSES (it's asserting today's actual fallback behavior), and all pre-existing tests still PASS.

- [ ] **Step 3: Implement the label additions**

In `apps/web/src/components/devices/DeviceWarrantyCard.tsx`, replace:

```ts
function dataSourceLabel(source: string | null): string {
  if (!source) return '';
  switch (source) {
    case 'agent_plist': return 'Agent (macOS plist)';
    case 'provider': return 'Vendor API';
    default: return source;
  }
}
```

with:

```ts
function dataSourceLabel(source: string | null): string {
  if (!source) return '';
  switch (source) {
    case 'agent_plist': return 'Agent (macOS plist)';
    case 'agent_cmsl': return 'Agent (HP CMSL)';
    case 'provider': return 'Vendor API';
    case 'import': return 'CSV Import';
    default: return source;
  }
}
```

- [ ] **Step 4: Run the test file again to confirm everything passes**

Run:
```bash
cd apps/web && npx vitest run src/components/devices/DeviceWarrantyCard.test.tsx
```
Expected: PASS, all tests including the three new ones and every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceWarrantyCard.tsx \
  apps/web/src/components/devices/DeviceWarrantyCard.test.tsx
git commit -m "fix(web): label agent_cmsl and import warranty data sources

Both previously fell through to the raw string ('agent_cmsl', 'import')
in the device warranty card's source line. agent_cmsl is the new
HP-CMSL agent-collected source (#5511); import was an existing,
unrelated gap in the same fallback."
```

---

## Task 4: Fix the two stale "HP has no lookup" docs pages

**Files:**
- Modify: `apps/docs/src/content/docs/features/warranty-tracking.mdx`
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx`

**Interfaces:**
- Consumes: nothing from Tasks 2-3 — pure prose, no code dependency. (Documenting a UI checkbox that Task 1 already confirmed exists.)
- Produces: nothing later tasks depend on.

This is **Manual Mode** under the `update-breeze-docs` skill: a specific, known-stale doc, not a diff-driven sweep. Both pages are in the `features/` and `deploy/` sections respectively — audience is MSP technicians and sysadmins deploying/configuring Breeze, so write in product language (HP's CMSL, the consent checkbox, what happens on the endpoint), not implementation language (no `hpCmsl` JSON key names, no `warrantySync.ts`, no `data_source` column name — that's why the label in Task 3 said "Agent (HP CMSL)" and this doc should say the same, not `agent_cmsl`).

- [ ] **Step 1: Update `warranty-tracking.mdx` — replace the stale HP sentence**

In `apps/docs/src/content/docs/features/warranty-tracking.mdx`, in the "## Where warranty dates come from" section, replace:

```
Breeze stores one warranty record per device (`device_warranty`) with the manufacturer, serial number, coverage status, and start/end dates. A background worker runs every 6 hours and re-checks each device about once every 7 days (50 devices per run), looking the serial number up against the vendor providers your instance has configured — Dell (official API credentials) and Lenovo (official API ClientID and/or the credential-free opt-in); Apple/AppleCare coverage is reported by the macOS agent. HP has no lookup yet, so HP devices stay `unknown`. Vendor configuration is described under [Environment → Warranty lookups](/deploy/environment/#warranty-lookups). The Warranty **tab does not set warranty dates** — it only configures the alert thresholds evaluated against whatever dates the sync has discovered. Devices whose warranty status is still `unknown`, or that have no end date, are skipped.
```

with:

```
Breeze stores one warranty record per device (`device_warranty`) with the manufacturer, serial number, coverage status, and start/end dates. A background worker runs every 6 hours and re-checks each device about once every 7 days (50 devices per run), looking the serial number up against the vendor providers your instance has configured — Dell (official API credentials) and Lenovo (official API ClientID and/or the credential-free opt-in); Apple/AppleCare coverage is reported by the macOS agent. HP works differently — see [HP warranty collection](#hp-warranty-collection-opt-in) below. Vendor configuration for Dell and Lenovo is described under [Environment → Warranty lookups](/deploy/environment/#warranty-lookups). The Warranty **tab does not set warranty dates** — it only configures the alert thresholds evaluated against whatever dates the sync has discovered. Devices whose warranty status is still `unknown`, or that have no end date, are skipped.
```

- [ ] **Step 2: Add a new "HP warranty collection" section**

Insert this new section into `apps/docs/src/content/docs/features/warranty-tracking.mdx` immediately after the closing `</Aside>` of the existing AppleCare note and before `## Configure in a policy` (i.e., right after line 18 in the current file):

```mdx
## HP warranty collection (opt-in)

HP's official Warranty API isn't available to MSP or RMM vendors, so there's no server-side HP lookup the way there is for Dell and Lenovo. Instead, HP coverage is collected **directly on the device** using HP's own Client Management Script Library (CMSL) — the same tool HP ships to IT teams for this purpose.

This is off by default and must be turned on per policy, on the same Warranty tab used for alert thresholds:

<Steps>

1. Open the policy's **Warranty** tab and toggle **Enable HP CMSL collection** on.

2. Accept HP's CMSL licence when prompted. Breeze records who accepted it and when.

3. **Save** and assign the policy. Devices covered by the policy install HP's CMSL software (about 100 MB) the next time they check in, then read HP's own warranty data from the device and report it back to Breeze. A device that already has this data cached locally reports it without a fresh HP lookup.

</Steps>

<Aside type="caution">
Turning this on installs HP's software on every HP endpoint the policy covers, under HP's own licence — not Breeze's. That licence permits HP to collect technical information from the device, including its IP address. Because this causes software installation, enabling it requires the **Execute Devices** permission and multi-factor authentication, the same gate as any other software deployment.
</Aside>

Devices collected this way show **Agent (HP CMSL)** as their warranty data source on the device page.
```

- [ ] **Step 3: Update `environment.mdx`'s stale Aside**

In `apps/docs/src/content/docs/deploy/environment.mdx`, in the "## Warranty lookups" section, replace:

```
<Aside>
  When both Lenovo settings are present the official API is authoritative: a definite "no warranty found" from it is final, and the public endpoint is only consulted when the official call itself fails (bad key, outage). HP has no lookup yet — HP's Warranty API is not available to MSP or RMM vendors, so HP devices stay `unknown`.
</Aside>
```

with:

```
<Aside>
  When both Lenovo settings are present the official API is authoritative: a definite "no warranty found" from it is final, and the public endpoint is only consulted when the official call itself fails (bad key, outage). HP's official Warranty API is still not available to MSP or RMM vendors, so there's no `HP_*` variable to set here. HP coverage instead comes from an opt-in, agent-collected path — see [HP warranty collection](/features/warranty-tracking/#hp-warranty-collection-opt-in), configured per policy rather than by environment variable.
</Aside>
```

- [ ] **Step 4: Build-verify both docs pages**

Run:
```bash
cd apps/docs && npx astro build 2>&1 | tail -30
```
Expected: build succeeds with no new errors (a broken `<Steps>`/`<Aside>` tag or bad frontmatter would fail here). If it fails, fix the MDX before proceeding — do not commit a broken docs build.

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/features/warranty-tracking.mdx \
  apps/docs/src/content/docs/deploy/environment.mdx
git commit -m "docs: describe the agent-collected HP warranty path

Both warranty-tracking.mdx and environment.mdx still said 'HP has no
lookup yet.' HP coverage now comes from an opt-in, agent-collected
path using HP's own CMSL (#5511); document the opt-in checkbox,
consent, and the licence/IP-collection caveat."
```

---

## Self-review

**1. Spec/contract coverage.** Every bullet in the spec's "Layer 7 — UI and cleanup" and the contract's W05 ownership row is covered: `hpProvider.ts` deletion (Task 2), throttle/`hpRateLimiter` sweep (Task 2), `index.ts` comment rewrite (Task 2), `HP_WARRANTY_ENABLED` removal (Task 2, automatic via file deletion, confirmed by grep), `agent_cmsl` label (Task 3), `warranty-tracking.mdx` (Task 4). The gate stated in both the user's brief and the module's own comment is enforced as Task 1, not left as an unstated assumption. The `'import'` fallback bug and the `environment.mdx` staleness were both found during the ground-truth pass and folded in with explicit reasoning rather than silently expanded scope.

**2. Placeholder scan.** Every step shows complete file content or an exact, runnable diff — no "add appropriate handling," no "similar to Task N," no elided code. The one intentionally-elided block is the `hpProvider.ts` `lookup()` body in the Ground Truth section (already fully quoted earlier in this same conversation's research and irrelevant to reconstruct since the whole file is simply deleted, never edited).

**3. Type/name consistency.** `dataSourceLabel` (Task 3) is referenced with the same signature (`(source: string | null): string`) as it already has — no rename. `hpRateLimiter`, `hpProvider`, `HP_WARRANTY_ENABLED` are named identically to their current declarations throughout Tasks 1-2, matching the grep hit list in Global Constraints exactly. `AGENT_OWNED_WARRANTY_SOURCES` / `isAgentOwnedWarrantySource` (Task 1's gate check) are named exactly as the cross-wave contract's D9 specifies, since Task 1 is checking for W01's output, not defining anything itself.

**4. Task independence.** Tasks 2, 3, and 4 touch disjoint files (`apps/api/.../warrantyProviders/*` vs `apps/web/.../DeviceWarrantyCard.*` vs `apps/docs/.../*.mdx`) and none produces an interface another consumes — they can run in any order after Task 1 passes, including in parallel across subagents.
