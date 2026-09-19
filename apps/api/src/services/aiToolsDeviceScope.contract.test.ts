import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SCHEMA_DIR,
  SERVICES_DIR,
  aiToolsSources,
  argCount,
  blankComments,
  blankGuardedBlocks,
  delegatesToGuardedHelper,
  enclosingWindow,
  functionBody,
  matchClose,
  splitOr,
  tablesWithColumnIn,
  walkTs,
  windowStarts,
  guardedLocalHelpers as guardedHelpersIn,
  NON_FLEET_DEVICE_ID_COLUMNS,
  DEVICE_COLUMN_RE,
  TARGET_CONTENT_COLUMN_RE,
} from './__testutils__/aiToolScopeScan';

/**
 * Contract: every AI tool that reads or writes a DEVICE-BEARING table names the
 * device axis (#6096 RC2/RC3) — and names it on a path a device-LESS run can
 * actually reach.
 *
 * Why a source contract and not a behavioural test: the bug class is a guard
 * that is *absent*, spread over ~60 `aiTools*.ts` files and ~160 call sites. A
 * behavioural test can only cover the handlers someone remembered to write one
 * for — which is exactly the set that already has the guard. This test is the
 * mechanical grep (cascade-list precedent: contract tests 5/5, review 0/5).
 *
 * What it does NOT claim: naming a marker is not proof the narrowing is
 * correct — only that the handler is aware the axis exists. Correctness is the
 * job of the per-tool `*.siteScope` / `*.deviceScope` behavioural suites.
 *
 * Three independent scans:
 *   (a) TABLE scan — `.from/.update/.delete/.insert(<device-bearing table>)`.
 *   (b) SCHEMA scan — a tool whose input schema has an OPTIONAL `deviceId` /
 *       `deviceIds`. `deviceArgs` alone does NOT count: `enforceDeviceArgs`
 *       (aiTools.ts) no-ops when the optional arg is absent, which is the whole
 *       RC2 signal — the un-narrowed call is the one that omits the id.
 *   (c) REACHABILITY scan — (a) again, but with every SITE-axis-guarded block
 *       blanked first. Marker presence is not reachability: a handler whose
 *       only `resolveSiteAllowedDeviceIds` sits inside
 *       `if (auth.allowedSiteIds && …)` passes (a) while reading ORG-WIDE for
 *       the device-LESS run shape (`allowedDeviceIds` set, `allowedSiteIds`
 *       undefined) that `agentAuthContext.ts` produces for a device-bound
 *       agent. Scan (c) requires a marker OUTSIDE those blocks.
 *
 * All three carry a FROZEN BASELINE of pre-existing gaps. **Never add an
 * entry.** A new unguarded call site is a fail, not a baseline row. The
 * baselines are also asserted shrink-only: an entry that no longer matches an
 * unguarded call must be deleted, so a fixed site cannot be silently re-broken.
 */


/**
 * Identifiers that mean "this handler reasons about the exact-device axis".
 * `deviceArgs` is deliberately absent — see the header.
 */
const DEVICE_AXIS_MARKERS = [
  'allowedDeviceIds',
  'runFrozenDeviceIds',
  'resolveSiteAllowedDeviceIds',
  'resolveSiteDevicePartition',
  'deviceScopeCondition',
  'filterToDeviceScope',
  'deviceIdSiteDenied',
  'verifyDeviceAccess',
  // Ticketing's cross-module equivalent of `deviceIdSiteDenied`: it checks
  // `allowedDeviceIds` FIRST and only then the site axis
  // (`routes/tickets/siteScope.ts`), so naming it is naming the device axis.
  'deviceInSiteScope',
  // `aiToolsSiteScope.ts` — applies BOTH axes to a list of device ids
  // (`auth.allowedDeviceIds` intersection first, then the site allowlist), so
  // naming it is naming the device axis. Its same-file wrappers (e.g.
  // `scopedAffectedDevices` in aiToolsIncident.ts) name nothing else, which is
  // why the cross-file call has to be a marker in its own right.
  'scopeDeviceIdsToCaller',
  // `siteCeilingAccess.ts` — `!hasSiteCeiling(auth) && !hasExactDeviceCeiling(auth)`.
  // The second conjunct IS the device axis: a device-ceilinged caller (every
  // agent run) is denied the org-wide governance write outright. Already a
  // SITE marker in the twin suite; listing it here is exact parity, not a
  // loosening. It gates the WRITE actions of the policy handlers — the
  // list/get reads in the same handler are deliberately org-scoped on BOTH
  // axes (org-wide governance config is not device data), which is the same
  // judgement the site suite makes about the same call sites.
  'canMutateOrgWideGovernance',
  'hasExactDeviceCeiling',
] as const;

// ---------------------------------------------------------------- utilities
//
// The parser itself lives in `__testutils__/aiToolScopeScan.ts`, shared with
// the SITE-axis twin (`aiToolsSiteScope.contract.test.ts`) so the two axes
// cannot drift apart. What stays here is device-axis SEMANTICS.

/**
 * True when `window` names the device axis. `deviceSiteDenied` counts only with
 * THREE arguments: the two-argument form is documented as "this resource has no
 * device axis" and applies the site axis only (see the helper's docstring and
 * `aiToolsDeviceGuard.contract.test.ts`).
 */
function namesDeviceAxis(window: string): boolean {
  if (DEVICE_AXIS_MARKERS.some((marker) => window.includes(marker))) return true;
  const needle = 'deviceSiteDenied(';
  for (let i = window.indexOf(needle); i !== -1; i = window.indexOf(needle, i + 1)) {
    const end = matchClose(window, i + needle.length - 1, '(', ')');
    if (argCount(window.slice(i, end + 1)) >= 3) return true;
  }
  return false;
}

/**
 * True when `window` names the device axis for a SPECIFIC table, i.e. either a
 * generic marker or the column-qualified `deviceScopeCondition(auth, x.<col>)`
 * form for one of that table's own device columns (recorded by
 * `deviceBearingTablesIn`). Today the column-qualified form is subsumed by the
 * generic `deviceScopeCondition` marker; it is spelled out so that narrowing
 * the generic marker list later cannot silently drop it.
 */
function namesDeviceAxisForTable(window: string, columns: readonly string[]): boolean {
  if (namesDeviceAxis(window)) return true;
  return columns.some((col) =>
    new RegExp(`deviceScopeCondition\\s*\\(\\s*auth\\s*,\\s*\\w+\\.${col}\\b`).test(window));
}

/**
 * Same-file function DECLARATIONS whose body names the device axis. A handler
 * that delegates its predicate list to one of these (e.g.
 * `buildAgentLogConditions`) is guarded even though the marker is not lexically
 * inside the handler.
 */
function guardedLocalHelpers(src: string): string[] {
  return guardedHelpersIn(src, namesDeviceAxis);
}

// ------------------------------------------------- site-axis reachability

const SITE_AXIS_REF = /auth\.(?:allowedSiteIds|canAccessSite)\b/;

/**
 * True when the test is true WHENEVER the site axis is absent, regardless of
 * any other state — i.e. every top-level `||` operand is a bare site-axis
 * absence check. `if (<that>) return …;` therefore makes everything after it
 * unreachable for a device-LESS run.
 *
 * Deliberately strict: `if (!auth.canAccessSite && !frozenDeviceIds) return`
 * (aiToolsMonitoring `assertMonitorSiteAccess`) is NOT of this shape — it also
 * consults the device axis, so the code after it is still reachable.
 */
function isSiteAbsentTest(test: string): boolean {
  const parts = splitOr(test);
  if (parts.length === 0) return false;
  return parts.every((p) =>
    /^!\s*auth\.(?:allowedSiteIds|canAccessSite)(?:\?\.length)?$/.test(p)
    || /^auth\.(?:allowedSiteIds|canAccessSite)\s*===\s*undefined$/.test(p)
    || /^!\s*\(\s*auth\.(?:allowedSiteIds|canAccessSite)(?:\?\.length)?\s*\)$/.test(p));
}

/**
 * Blank (offset-preserving) every region that only a SITE-restricted caller
 * reaches, so what survives is what a device-LESS run executes. See
 * `blankGuardedBlocks` in the shared scanner for the three rules.
 */
function blankSiteGuarded(src: string): string {
  return blankGuardedBlocks(src, SITE_AXIS_REF, isSiteAbsentTest);
}

/**
 * Cross-file delegates: `[exported function, module path relative to this dir]`.
 * The same-file `guardedLocalHelpers` scan cannot follow a handler that pushes
 * its whole read into a shared read model, which reads as an un-narrowed
 * handler even when the read model is the thing doing the narrowing.
 *
 * Entries are NOT trusted on their word: `verifiedCrossFileDelegates()` re-runs
 * the marker scan over the named function's own body in its own file, so the
 * delegation only counts while the guard is actually there. Delete the guard
 * and the delegate stops being accepted, the tool reappears as unguarded, and
 * the "no tool outside the frozen baseline" test fails — which is strictly
 * stronger than baselining the tool would have been (a baselined tool's guard
 * can be deleted with the contract still green). Verified by mutation: removing
 * `deviceScopeCondition`/`filterToDeviceScope` from `episodeQueries.ts` reds
 * this suite.
 *
 * Keep this list SHORT and only for a delegate that does the narrowing itself.
 * A wrapper that merely forwards `auth` to something else does not qualify.
 */
const CROSS_FILE_GUARDED_DELEGATES: ReadonlyArray<readonly [string, string]> = [
  // `get_monitor_activity`'s entire read: both functions take `auth` and apply
  // `deviceScopeCondition` in SQL plus `filterToDeviceScope` at the boundary.
  // Behavioural proof through the tool entry point:
  // `aiToolsMonitors.deviceScope.test.ts`.
  ['listMonitorDeviceActivity', join('monitors', 'episodeQueries.ts')],
  ['listMonitorEpisodes', join('monitors', 'episodeQueries.ts')],
];

/**
 * @param siteBlanked when true the delegate's own body is checked for a marker
 * that survives the site-guard blanking, i.e. the delegate narrows on the
 * device-LESS path too (scan (c)).
 */
function verifiedCrossFileDelegates(siteBlanked = false): string[] {
  const verified: string[] = [];
  for (const [fn, rel] of CROSS_FILE_GUARDED_DELEGATES) {
    let src = blankComments(readFileSync(join(SERVICES_DIR, rel), 'utf8'));
    if (siteBlanked) src = blankSiteGuarded(src);
    if (guardedLocalHelpers(src).includes(fn)) verified.push(fn);
  }
  return verified;
}

const AI_TOOLS_SOURCES = aiToolsSources();

/**
 * Exported Drizzle tables in `src` that declare a fleet-device column, mapped to
 * the column names found. The exclusion set and the column pattern are shared
 * with the site suite (`__testutils__/aiToolScopeScan.ts`) — see their
 * docstrings for why each spelling is in or out.
 *
 * Load-bearing (#6096 review): a plain `/\\bdeviceId:\\s/` was blind to
 * `linkedDeviceId`, `collectorDeviceId`, `scopeDeviceId` and `sourceDeviceId`,
 * so e.g. `discoveredAssets` was not device-bearing at all and
 * `aiToolsNetwork.ts` passed the whole contract with no device axis anywhere.
 */
function deviceBearingTablesIn(src: string): Map<string, string[]> {
  // `TARGET_CONTENT_COLUMN_RE` is the SECOND signal, adopted from the site
  // suite by the #6110 review. `DEVICE_COLUMN_RE` is singular-only
  // (`/\w*[Dd]eviceId:\s/`), so every table whose device attribution is an
  // ARRAY or a jsonb target descriptor — `software_policies.target_ids`,
  // `peripheral_policies.target_ids`, `incidents.affected_devices` — was
  // invisible to this suite while the site twin had been scanning them all
  // along. Widening it produced 24 hits, 23 of which resolved to guards this
  // suite's marker list simply did not name (see the three additions above);
  // the one residue is baselined below with its reason.
  const out = tablesWithColumnIn(src, DEVICE_COLUMN_RE, NON_FLEET_DEVICE_ID_COLUMNS);
  for (const [t, cols] of tablesWithColumnIn(src, TARGET_CONTENT_COLUMN_RE, NON_FLEET_DEVICE_ID_COLUMNS)) {
    out.set(t, [...new Set([...(out.get(t) ?? []), ...cols])]);
  }
  return out;
}

function deviceBearingTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const file of walkTs(SCHEMA_DIR)) {
    for (const [t, cols] of deviceBearingTablesIn(blankComments(readFileSync(file, 'utf8')))) {
      tables.set(t, cols);
    }
  }
  return tables;
}

const DEVICE_TABLES = deviceBearingTables();

// -------------------------------------------------------------- (a) tables

/**
 * FROZEN BASELINE — pre-existing `<file>:<table>#<ordinal>` call sites whose
 * enclosing handler does not name the device axis. The ordinal is the Nth call
 * against that table in that file (line-drift proof, unlike a line number).
 *
 * **Adding an entry here is forbidden.** A new unguarded call site means the
 * device axis was skipped; fix the handler instead. Entries are removed as the
 * sites are fixed — the shrink-only test below fails on a stale one.
 */
const DEVICE_TABLE_BASELINE: readonly string[] = [
  // Each entry is a device-bearing read/write whose enclosing window does not
  // itself name the device axis. Reviewed one by one; none is endorsed as
  // "doesn't need the axis" — they are the residue this PR did not own.
  //
  // `markBackupJobDispatchFailed` / `markRestoreJobFailed`: internal status
  // writes keyed by a job id the same handler just created — no caller input.
  'aiToolsBackup.ts:backupJobs#0',
  'aiToolsBackup.ts:restoreJobs#0',
  'aiToolsBackupVm.ts:restoreJobs#0',
  // `create_incident`'s INSERT writes `affectedDevices` straight from
  // `input.affectedDeviceIds`, and the tool declares
  // `deviceArgs: ['affectedDeviceIds']`, so `executeTool` → `enforceDeviceArgs`
  // → `verifyDeviceAccess` (org + exact-device + site) has already run over
  // every id before the handler is entered; omitting the argument creates an
  // incident with no affected devices. Same reasoning, same call site, as the
  // site twin's `aiToolsIncident.ts:incidents#1` exception. Surfaced by the
  // `TARGET_CONTENT_COLUMN_RE` widening, not by a source regression.
  'aiToolsIncident.ts:incidents#1',
  // `query_psa_status`: counts ticket mappings for an already-authorised PSA
  // connection id; the count is org-level, but it is not device-narrowed.
  'aiToolsIntegrations.ts:psaTicketMappings#0',
  // `queryMetricRollupsForAnalysis(orgId, deviceId, …)`: takes an explicit
  // deviceId the caller resolved through a guarded lookup.
  'aiToolsPerformance.ts:metricRollups#0',
];

function unguardedDeviceTableCalls(opts: { reachable?: boolean } = {}): { all: string[]; total: number } {
  const reachable = opts.reachable === true;
  const all: string[] = [];
  let total = 0;
  const crossFile = verifiedCrossFileDelegates(reachable);
  for (const file of AI_TOOLS_SOURCES) {
    // Ordinals and call-site discovery always come from the UN-blanked source so
    // the two scans address the same sites by the same id.
    const src = blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8'));
    const scanned = reachable ? blankSiteGuarded(src) : src;
    const starts = windowStarts(scanned);
    const helpers = [...guardedLocalHelpers(scanned), ...crossFile];
    const ordinals = new Map<string, number>();
    const re = /\.(?:from|update|delete|insert)\(\s*(\w+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const table = m[1]!;
      const columns = DEVICE_TABLES.get(table);
      if (!columns) continue;
      total++;
      const ordinal = ordinals.get(table) ?? 0;
      ordinals.set(table, ordinal + 1);
      // The call site itself sits inside a site-guarded block: a device-LESS run
      // never executes it, so it is not a device-LESS exposure.
      if (reachable && scanned[m.index] === ' ') continue;
      const window = enclosingWindow(scanned, starts, m.index);
      if (namesDeviceAxisForTable(window, columns) || delegatesToGuardedHelper(window, helpers)) continue;
      all.push(`${file}:${table}#${ordinal}`);
    }
  }
  return { all, total };
}

describe('contract: AI tools touching a device-bearing table name the device axis', () => {
  it('discovers the device-bearing tables and the calls to scan', () => {
    // A collapse here means the schema layout or the pgTable spelling changed and
    // the scan went blind — re-derive it rather than lowering these numbers.
    expect(DEVICE_TABLES.size).toBeGreaterThan(100);
    expect(AI_TOOLS_SOURCES.length).toBeGreaterThan(40);
    expect(unguardedDeviceTableCalls().total).toBeGreaterThan(100);
    // The widened column scan must keep seeing the non-`deviceId` spellings that
    // used to be invisible (#6096 review hole 2).
    expect(DEVICE_TABLES.get('discoveredAssets')).toContain('linkedDeviceId');
    // …and the CONTENT signal adopted from the site suite (#6110 review 1):
    // tables whose only device attribution is an array / jsonb target
    // descriptor, invisible to the singular `DEVICE_COLUMN_RE`.
    expect(DEVICE_TABLES.get('softwarePolicies')).toContain('targetIds');
    expect(DEVICE_TABLES.get('peripheralPolicies')).toContain('targetIds');
    expect(DEVICE_TABLES.get('incidents')).toContain('affectedDevices');
  });

  it('no call site outside the frozen baseline', () => {
    const { all } = unguardedDeviceTableCalls();
    const unexpected = all.filter((entry) => !DEVICE_TABLE_BASELINE.includes(entry));
    // A failure here is a NEW unguarded device-table read/write. Narrow the
    // query (deviceScopeCondition / resolveSiteDevicePartition / …) — do not add
    // the entry to DEVICE_TABLE_BASELINE.
    expect(unexpected).toEqual([]);
  });

  it('the baseline is shrink-only (no stale entries)', () => {
    const { all } = unguardedDeviceTableCalls();
    const stale = DEVICE_TABLE_BASELINE.filter((entry) => !all.includes(entry));
    // A fixed site must be removed from the baseline, or nothing stops it from
    // regressing back to unguarded.
    expect(stale).toEqual([]);
  });
});

// --------------------------------------------- (c) device-LESS reachability

/**
 * FROZEN BASELINE — call sites that pass scan (a) but whose ONLY device-axis
 * marker lives inside a site-guarded block, so the device-LESS run shape
 * (`allowedDeviceIds` set, `allowedSiteIds` undefined) reads org-wide. Entries
 * here are IN ADDITION to `DEVICE_TABLE_BASELINE`, which scan (c) inherits
 * (blanking only removes text, so scan (c) ⊇ scan (a)).
 *
 * **Adding an entry here is forbidden.**
 */
const REACHABLE_DEVICE_AXIS_BASELINE: readonly string[] = [
];

function reachableBaseline(): string[] {
  return [...DEVICE_TABLE_BASELINE, ...REACHABLE_DEVICE_AXIS_BASELINE];
}

describe('contract: the device axis is reachable on the device-LESS run shape', () => {
  it('scan (c) is a superset of scan (a)', () => {
    const plain = unguardedDeviceTableCalls().all;
    const reach = unguardedDeviceTableCalls({ reachable: true }).all;
    expect(plain.filter((e) => !reach.includes(e))).toEqual([]);
  });

  it('no call site outside the frozen baseline', () => {
    const { all } = unguardedDeviceTableCalls({ reachable: true });
    const baseline = reachableBaseline();
    // A failure here is a handler that narrows ONLY under
    // `if (auth.allowedSiteIds …)`. Move the device narrowing out of the site
    // branch (`deviceScopeCondition(auth, t.deviceId)` is axis-independent) —
    // do not add the entry to the baseline.
    expect(all.filter((entry) => !baseline.includes(entry))).toEqual([]);
  });

  it('the baseline is shrink-only (no stale entries)', () => {
    const { all } = unguardedDeviceTableCalls({ reachable: true });
    expect(reachableBaseline().filter((entry) => !all.includes(entry))).toEqual([]);
  });
});

// ------------------------------------------------ (b) optional device args

/**
 * FROZEN BASELINE — tools whose input schema takes an OPTIONAL `deviceId` /
 * `deviceIds` but whose handler never names the device axis, so the
 * no-device-argument call reads across the caller's whole org.
 * **Adding an entry here is forbidden** (see the table baseline).
 */
const OPTIONAL_DEVICE_ARG_BASELINE: readonly string[] = [
  // FALSE POSITIVE of the same-file scan, NOT a gap: `export_dataset` delegates
  // to per-dataset adapters in aiToolsExportDatasets.ts and those adapters DO
  // narrow (agent_logs goes through `buildAgentLogConditions`) — the delegation
  // crosses a file boundary this scan cannot follow, and the fan-out is one
  // adapter per dataset rather than a single read model, so it does not fit
  // `CROSS_FILE_GUARDED_DELEGATES` either. Behaviour is pinned by
  // `aiToolsExportDatasets.test.ts`.
  'aiToolsExport.ts:export_dataset',
  // `s1_isolate_device` reaches NO device-bearing table itself: it hands the
  // requested ids to `executeS1IsolationForOrg`, which narrows by org only. The
  // device bound is the dispatch chokepoint, which this source scan does not
  // model: the tool's Zod schema (`aiToolSchemas.ts`) refuses a call with no
  // device target, so the "optional deviceId omitted" shape cannot occur, and
  // `executeTool` → `enforceDeviceArgs` → `verifyDeviceAccess` rejects any id
  // outside `auth.allowedDeviceIds` before the handler runs (whole batch, fail
  // closed). Proven end-to-end, incl. a mutation control, by
  // `aiToolsSentinelOne.deviceScope.test.ts`.
  'aiToolsSentinelOne.ts:s1_isolate_device',
];

/**
 * Tools are read from the `aiTools*.ts` definitions rather than
 * `aiAgentSdkTools.ts` / `aiToolSchemas.ts`: those two re-export the same
 * `AiTool.definition` objects, so scanning the definitions covers both without
 * a second parser.
 */
function optionalDeviceArgTools(): { unguarded: string[]; total: number } {
  const unguarded: string[] = [];
  let total = 0;
  const crossFile = verifiedCrossFileDelegates();
  for (const file of AI_TOOLS_SOURCES) {
    const src = blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8'));
    const helpers = [...guardedLocalHelpers(src), ...crossFile];
    const nameRe = /name:\s*'([a-z0-9_]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(src)) !== null) {
      const schemaIdx = src.indexOf('input_schema', m.index);
      const handlerIdx = src.indexOf('handler', m.index);
      if (schemaIdx < 0 || handlerIdx < 0 || schemaIdx > handlerIdx) continue;
      const propsIdx = src.indexOf('properties:', schemaIdx);
      if (propsIdx < 0 || propsIdx > handlerIdx) continue;
      const propsEnd = matchClose(src, src.indexOf('{', propsIdx), '{', '}');
      const props = src.slice(propsIdx, propsEnd);
      if (!/\bdeviceIds?\s*:/.test(props)) continue;
      // The schema's OWN `required:`, i.e. the first one after the `properties`
      // object closes — a nested property schema can carry its own `required`
      // (aiToolsConfigPolicy.ts does), and reading that one mislabels a
      // mandatory deviceId as optional.
      const reqIdx = src.indexOf('required:', propsEnd);
      const required = reqIdx >= 0 && reqIdx < handlerIdx
        ? src.slice(reqIdx, src.indexOf(']', reqIdx))
        : '';
      if (/'deviceIds?'/.test(required)) continue; // the id is mandatory — not the RC2 shape
      total++;
      // Handler window: from `handler` to the next tool definition's `name:`.
      nameRe.lastIndex = handlerIdx;
      const next = nameRe.exec(src);
      const window = src.slice(handlerIdx, next ? next.index : src.length);
      nameRe.lastIndex = handlerIdx;
      if (namesDeviceAxis(window) || delegatesToGuardedHelper(window, helpers)) continue;
      unguarded.push(`${file}:${m[1]!}`);
    }
  }
  return { unguarded, total };
}

describe('contract: tools with an OPTIONAL deviceId argument still bound the device axis', () => {
  it('finds the optional-device-argument tools to scan', () => {
    expect(optionalDeviceArgTools().total).toBeGreaterThan(25);
  });

  it('no tool outside the frozen baseline', () => {
    const { unguarded } = optionalDeviceArgTools();
    const unexpected = unguarded.filter((t) => !OPTIONAL_DEVICE_ARG_BASELINE.includes(t));
    // A failure here is a tool that reads org-wide when its optional deviceId is
    // omitted. `deviceArgs` does not fix it — `enforceDeviceArgs` no-ops on an
    // absent argument. Narrow the query instead.
    expect(unexpected).toEqual([]);
  });

  it('the baseline is shrink-only (no stale entries)', () => {
    const { unguarded } = optionalDeviceArgTools();
    expect(OPTIONAL_DEVICE_ARG_BASELINE.filter((t) => !unguarded.includes(t))).toEqual([]);
  });
});

// ------------------------------------------- cross-file delegate integrity

describe('contract: every cross-file delegate is actually verified', () => {
  it('each CROSS_FILE_GUARDED_DELEGATES entry resolves to a guarded body', () => {
    // Before #6096's review fix, `functionBody` grabbed the first `{` after the
    // function NAME, which for `listMonitorEpisodes(…, opts: { deviceId?: … })`
    // is the parameter type — so the entry silently verified nothing and the
    // delegation was accepted on trust.
    expect(verifiedCrossFileDelegates()).toHaveLength(CROSS_FILE_GUARDED_DELEGATES.length);
  });

  it('each entry still narrows on the device-LESS path', () => {
    expect(verifiedCrossFileDelegates(true)).toHaveLength(CROSS_FILE_GUARDED_DELEGATES.length);
  });
});

// --------------------------------------------------- scanner self-tests
//
// The scanners above are the only thing standing between a dead guard and a
// green suite, so they are unit-tested on string fixtures rather than on live
// source: a fixture cannot be "fixed" out from under the proof by a concurrent
// PR, which is exactly how the three holes this block pins went unnoticed.

describe('scanner: site-guard blanking discriminates dead guards', () => {
  const marker = 'const allowed = await resolveSiteAllowedDeviceIds(orgId, auth);';

  const survives = (src: string) => namesDeviceAxis(blankSiteGuarded(blankComments(src)));

  it('a marker reachable only under `if (auth.allowedSiteIds && …)` does not survive', () => {
    // This is verbatim the `aiToolsCisBenchmark.ts` / `aiToolsVault.ts` shape.
    expect(survives(`
      handler: async (input, auth) => {
        const conditions = [];
        if (auth.allowedSiteIds && auth.canAccessSite) {
          ${marker}
          conditions.push(inArray(t.deviceId, allowed));
        }
        return db.select().from(t).where(and(...conditions));
      }
    `)).toBe(false);
  });

  it('the same handler passes once the narrowing is unconditional', () => {
    expect(survives(`
      handler: async (input, auth) => {
        const conditions = [deviceScopeCondition(auth, t.deviceId)];
        if (auth.allowedSiteIds && auth.canAccessSite) {
          ${marker}
          conditions.push(inArray(t.deviceId, allowed));
        }
        return db.select().from(t).where(and(...conditions));
      }
    `)).toBe(true);
  });

  it('a braceless site-guarded statement is blanked too', () => {
    expect(survives(`
      handler: async (input, auth) => {
        if (auth.allowedSiteIds) conditions.push(deviceScopeCondition(auth, t.deviceId));
        return db.select().from(t);
      }
    `)).toBe(false);
  });

  it('a site-guarded ternary CONSEQUENT is blanked, the alternate is kept', () => {
    expect(survives(`
      const ids = auth.allowedSiteIds ? await resolveSiteAllowedDeviceIds(o, auth) : null;
    `)).toBe(false);
    expect(survives(`
      const ids = auth.allowedSiteIds ? null : runFrozenDeviceIds(auth);
    `)).toBe(true);
  });

  it('the ELSE branch of a site guard is kept (it is the device-LESS path)', () => {
    expect(survives(`
      if (auth.allowedSiteIds) {
        conditions.push(inArray(t.deviceId, siteIds));
      } else {
        conditions.push(deviceScopeCondition(auth, t.deviceId));
      }
    `)).toBe(true);
  });

  it('`if (!auth.allowedSiteIds) return …` blanks the REST of the block', () => {
    // `aiToolsFleet.ts:alertRuleTargetDenied`: everything after the early return
    // is site-only, so its `deviceIdSiteDenied` never runs for a device-LESS run.
    expect(survives(`
      async function f(auth, rule) {
        if (!auth.allowedSiteIds || !auth.canAccessSite) return false;
        return deviceIdSiteDenied(auth, rule.targetId);
      }
    `)).toBe(false);
  });

  it('an early return that ALSO consults the device axis does not blank the rest', () => {
    // `aiToolsMonitoring.ts:assertMonitorSiteAccess` — the guard is
    // `!auth.canAccessSite && !frozenDeviceIds`, so the body below it is still
    // reachable for a device-bound run.
    expect(survives(`
      async function f(auth, monitor) {
        const frozenDeviceIds = runFrozenDeviceIds(auth);
        if (!auth.canAccessSite && !frozenDeviceIds) return true;
        return check(frozenDeviceIds);
      }
    `)).toBe(true);
  });

  it('a handler with no site guard at all is untouched', () => {
    const src = 'const c = [deviceScopeCondition(auth, t.deviceId)];';
    expect(blankSiteGuarded(src)).toBe(src);
  });
});

describe('scanner: function body detection skips parameter and return types', () => {
  it('an inline object PARAMETER type is not mistaken for the body', () => {
    const src = `export async function listMonitorEpisodes(
  monitorId: string,
  auth: AuthContext,
  opts: { deviceId?: string; limit: number },
): Promise<{ episodes: E[]; nextCursor: string | null }> {
  return deviceScopeCondition(auth, monitorEpisodes.deviceId);
}`;
    expect(guardedLocalHelpers(src)).toEqual(['listMonitorEpisodes']);
  });

  it('a marker that lives ONLY in the parameter type does not count as a guard', () => {
    const src = 'function f(o: { allowedDeviceIds?: string[] }) {\n  return 1;\n}';
    expect(guardedLocalHelpers(src)).toEqual([]);
  });

  it('an object RETURN type is not mistaken for the body', () => {
    const src = 'function f(a: string): { device: D } {\n  return verifyDeviceAccess(a);\n}';
    expect(guardedLocalHelpers(src)).toEqual(['f']);
  });
});

describe('scanner: device-bearing column detection', () => {
  it('sees non-`deviceId` fleet columns and ignores non-fleet ones', () => {
    const found = deviceBearingTablesIn(`
      export const assets = pgTable('assets', {
        id: uuid('id'),
        linkedDeviceId: uuid('linked_device_id').references(() => devices.id),
      });
      export const pushTokens = pgTable('push_tokens', {
        mobileDeviceId: uuid('mobile_device_id').notNull(),
      });
      export const unifiPorts = pgTable('unifi_ports', {
        unifiDeviceId: text('unifi_device_id'),
        collectorDeviceId: uuid('collector_device_id'),
      });
    `);
    expect([...found.keys()].sort()).toEqual(['assets', 'unifiPorts']);
    expect(found.get('assets')).toEqual(['linkedDeviceId']);
    expect(found.get('unifiPorts')).toEqual(['collectorDeviceId']);
  });

  it('sees ARRAY / jsonb target columns the singular pattern misses', () => {
    // The #6110 review hole: `deviceIds:` does NOT match `/\w*[Dd]eviceId:\s/`,
    // so a table attributed only through its content was never scanned here.
    const found = deviceBearingTablesIn(`
      export const policies = pgTable('policies', {
        targetType: varchar('target_type'),
        targetIds: jsonb('target_ids').$type<string[]>(),
      });
      export const incidents = pgTable('incidents', {
        affectedDevices: jsonb('affected_devices').$type<string[]>(),
      });
      export const proposals = pgTable('proposals', {
        targetDeviceIds: jsonb('target_device_ids').$type<string[]>(),
      });
      export const plain = pgTable('plain', {
        name: varchar('name'),
      });
    `);
    expect([...found.keys()].sort()).toEqual(['incidents', 'policies', 'proposals']);
    expect(found.get('policies')).toEqual(['targetIds']);
  });
});
