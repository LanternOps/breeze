import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Contract: every AI tool that reads or writes a DEVICE-BEARING table names the
 * device axis (#6096 RC2/RC3).
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
 * Two independent scans:
 *   (a) TABLE scan — `.from/.update/.delete/.insert(<device-bearing table>)`.
 *   (b) SCHEMA scan — a tool whose input schema has an OPTIONAL `deviceId` /
 *       `deviceIds`. `deviceArgs` alone does NOT count: `enforceDeviceArgs`
 *       (aiTools.ts) no-ops when the optional arg is absent, which is the whole
 *       RC2 signal — the un-narrowed call is the one that omits the id.
 *
 * Both carry a FROZEN BASELINE of pre-existing gaps. **Never add an entry.** A
 * new unguarded call site is a fail, not a baseline row. The baselines are also
 * asserted shrink-only: an entry that no longer matches an unguarded call must
 * be deleted, so a fixed site cannot be silently re-broken later.
 */

const SERVICES_DIR = __dirname;
const SCHEMA_DIR = join(__dirname, '..', 'db', 'schema');

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
] as const;

// ---------------------------------------------------------------- utilities

/**
 * Blank out COMMENTS in place, preserving every offset so windows and ordinals
 * stay aligned with the original text. String literals are skipped over (so a
 * `//` inside a URL is not mistaken for a comment) but left intact — the tool
 * names and `required: ['deviceId']` lists that scan (b) reads live in them.
 *
 * Load-bearing: a marker name mentioned in PROSE would otherwise count as a
 * guard. Verified by deleting the real `deviceScopeCondition` call from
 * `buildAgentLogConditions`: the contract stayed green because the comment
 * above it still said "allowedDeviceIds".
 */
function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const end = src.indexOf('\n', i); blank(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2; blank(i, stop); i = stop; continue; }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}


function matchClose(src: string, open: number, o: '(' | '{', c: ')' | '}'): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i;
  }
  return src.length;
}

/** Top-level argument count of a `name(...)` call slice. */
function argCount(call: string): number {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
  let depth = 0;
  let args = 1;
  for (const ch of inner) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) args++;
  }
  return inner.trim() === '' ? 0 : args;
}

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
 * Same-file function DECLARATIONS whose body names the device axis. A handler
 * that delegates its predicate list to one of these (e.g.
 * `buildAgentLogConditions`) is guarded even though the marker is not lexically
 * inside the handler. Declarations only — an arrow-const heuristic matched far
 * too much and would mask real gaps.
 */
function guardedLocalHelpers(src: string): string[] {
  const helpers: string[] = [];
  const re = /(?:export )?(?:async )?function (\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index);
    if (open < 0) continue;
    if (namesDeviceAxis(src.slice(open, matchClose(src, open, '{', '}') + 1))) helpers.push(m[1]!);
  }
  return helpers;
}

function delegatesToGuardedHelper(window: string, helpers: readonly string[]): boolean {
  return helpers.some((h) => new RegExp(`\\b${h}\\s*\\(`).test(window));
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

function verifiedCrossFileDelegates(): string[] {
  const verified: string[] = [];
  for (const [fn, rel] of CROSS_FILE_GUARDED_DELEGATES) {
    const src = blankComments(readFileSync(join(SERVICES_DIR, rel), 'utf8'));
    if (guardedLocalHelpers(src).includes(fn)) verified.push(fn);
  }
  return verified;
}

/**
 * Offsets that start a handler-sized window: a tool `handler:`, or any function
 * declaration. A call's window runs from the nearest preceding start to the next
 * one — the enclosing handler, and nothing of its neighbours.
 */
function windowStarts(src: string): number[] {
  const starts: number[] = [];
  const re = /\bhandler:\s*(?:async|safeHandler)|\basync function \w+\s*\(|\bexport (?:async )?function \w+\s*\(|\bfunction \w+\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) starts.push(m.index);
  return starts;
}

function enclosingWindow(src: string, starts: readonly number[], at: number): string {
  let lo = 0;
  for (const s of starts) {
    if (s <= at) lo = s;
    else break;
  }
  let hi = src.length;
  for (const s of starts) {
    if (s > at) { hi = s; break; }
  }
  return src.slice(lo, hi);
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts') && !p.includes('.test.')) out.push(p);
  }
  return out;
}

const AI_TOOLS_SOURCES = readdirSync(SERVICES_DIR)
  .filter((f) => /^aiTools.*\.ts$/.test(f) && !f.includes('.test.'))
  .sort();

/** Exported Drizzle tables that declare a `deviceId` column. */
function deviceBearingTables(): Set<string> {
  const tables = new Set<string>();
  for (const file of walkTs(SCHEMA_DIR)) {
    const src = blankComments(readFileSync(file, 'utf8'));
    const re = /export const (\w+)\s*=\s*pgTable\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('(', m.index + m[0].length - 1);
      if (/\bdeviceId:\s/.test(src.slice(open, matchClose(src, open, '(', ')')))) tables.add(m[1]!);
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
  // `findAlertWithAccess`: resolves one alert by id on the org axis; every
  // caller re-checks the alert's device before acting.
  'aiTools.ts:alerts#0',
  // `markBackupJobDispatchFailed` / `markRestoreJobFailed`: internal status
  // writes keyed by a job id the same handler just created — no caller input.
  'aiToolsBackup.ts:backupJobs#0',
  'aiToolsBackup.ts:restoreJobs#0',
  'aiToolsBackupVm.ts:restoreJobs#0',
  // `manage_software_policy` delete: cascades compliance rows by policyId after
  // the policy row itself was authorised — device-fan-out, not a device read.
  'aiToolsCompliance.ts:softwareComplianceStatus#1',
  // `query_psa_status`: counts ticket mappings for an already-authorised PSA
  // connection id; the count is org-level, but it is not device-narrowed.
  'aiToolsIntegrations.ts:psaTicketMappings#0',
  // `queryMetricRollupsForAnalysis(orgId, deviceId, …)`: takes an explicit
  // deviceId the caller resolved through a guarded lookup.
  'aiToolsPerformance.ts:metricRollups#0',
];

function unguardedDeviceTableCalls(): { all: string[]; total: number } {
  const all: string[] = [];
  let total = 0;
  for (const file of AI_TOOLS_SOURCES) {
    const src = blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8'));
    const starts = windowStarts(src);
    const helpers = [...guardedLocalHelpers(src), ...verifiedCrossFileDelegates()];
    const ordinals = new Map<string, number>();
    const re = /\.(?:from|update|delete|insert)\(\s*(\w+)\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const table = m[1]!;
      if (!DEVICE_TABLES.has(table)) continue;
      total++;
      const ordinal = ordinals.get(table) ?? 0;
      ordinals.set(table, ordinal + 1);
      const window = enclosingWindow(src, starts, m.index);
      if (namesDeviceAxis(window) || delegatesToGuardedHelper(window, helpers)) continue;
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
  for (const file of AI_TOOLS_SOURCES) {
    const src = blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8'));
    const helpers = [...guardedLocalHelpers(src), ...verifiedCrossFileDelegates()];
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
