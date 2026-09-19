import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SERVICES_DIR,
  SCHEMA_DIR,
  aiToolsSources,
  blankComments,
  blankGuardedBlocks,
  delegatesToGuardedHelper,
  enclosingWindow,
  guardedLocalHelpers,
  matchClose,
  siteAttributableTables,
  tablesWithColumnIn,
  windowStarts,
  DEVICE_COLUMN_RE,
  NON_FLEET_DEVICE_ID_COLUMNS,
  NON_FLEET_SITE_ID_COLUMNS,
  SITE_COLUMN_RE,
} from './__testutils__/aiToolScopeScan';

/**
 * Contract: every AI tool that reads or writes a SITE-ATTRIBUTABLE table names
 * the SITE axis — and names it on a path a site-restricted human actually
 * reaches (private audit 2026-09-17 §5.1).
 *
 * The SITE twin of `aiToolsDeviceScope.contract.test.ts`, sharing its parser
 * (`__testutils__/aiToolScopeScan.ts`) so the two axes cannot drift apart.
 *
 * Why this axis needs a source contract of its own. Postgres RLS does NOT
 * defend the site axis: `organization_users.site_ids` feeds
 * `auth.allowedSiteIds` / `auth.canAccessSite` and is enforced APP-SIDE only,
 * in every handler, one at a time. A missing site guard is therefore invisible
 * to the RLS contract suite and to every per-tool behavioural test that nobody
 * wrote. This is the mechanical grep (cascade-list precedent: contract tests
 * 5/5, review 0/5).
 *
 * What it does NOT claim: naming a marker is not proof the narrowing is
 * correct — only that the handler is aware the axis exists. Correctness is the
 * job of the per-tool `*.siteScope.test.ts` behavioural suites.
 *
 * Three scans, mirroring the device suite:
 *   (a) TABLE scan — `.from/.update/.delete/.insert(<site-attributable table>)`
 *       where site-attributable = carries its own `site_id`, OR carries a fleet
 *       `device_id` (a device HAS a site, so a device-keyed row is site
 *       attributable through it).
 *   (b) OPTIONAL-ARGUMENT scan — a tool whose input schema has an OPTIONAL
 *       `deviceId` / `deviceIds` / `siteId` / `siteIds`. `deviceArgs` does NOT
 *       count: `enforceDeviceArgs` (aiTools.ts) no-ops when the optional arg is
 *       absent, so the un-narrowed call is exactly the one that omits the id.
 *   (c) REACHABILITY scan — (a) again with every DEVICE-axis-guarded block
 *       blanked first. This is the inverse of the device suite's scan (c) and
 *       it is the one that catches the audit's dominant finding: a guard that
 *       intersects `auth.allowedDeviceIds` and nothing else narrows correctly
 *       for an agent run and is a COMPLETE NO-OP for the site-restricted human
 *       the axis exists to constrain (`scopedAffectedDevices`,
 *       `scopedTargetDeviceIds`, the monitor episode queries).
 *
 * All three carry FROZEN baselines, asserted shrink-only so a fixed site cannot
 * silently regress. Two kinds, and the difference is the point:
 *   - `*_EXCEPTIONS` — reviewed and judged to need no site axis (org-level
 *     table with no site attribution, internal status write keyed by an id the
 *     same handler just created, cascade under an already-authorised parent).
 *   - `KNOWN_OPEN_GAPS` — REAL, UNFIXED exposure, recorded so the suite is
 *     green while remaining loudly visible. Never move a new finding here to
 *     make a build pass.
 */

// ------------------------------------------------------------ site markers

/**
 * Identifiers that mean "this handler reasons about the SITE axis".
 *
 * Deliberately EXCLUDED, because they are the exact-device axis and the audit's
 * dominant bug is one standing in for the other: `deviceScopeCondition`,
 * `filterToDeviceScope`, `allowedDeviceIds`, `runFrozenDeviceIds`, `deviceArgs`.
 */
const SITE_AXIS_MARKERS = [
  'allowedSiteIds',
  'canAccessSite',
  'resolveSiteAllowedDeviceIds',
  'resolveSiteDevicePartition',
  'deviceSiteDenied',
  // NOT a substring of the above ('deviceId…' vs 'device…') — it must be listed
  // separately. Omitting it flagged `findAlertWithAccess` in BOTH aiTools.ts
  // and aiToolsAlerts.ts, whose only site gate is this call.
  'deviceIdSiteDenied',
  'siteScopeCondition',
  'scopeDeviceIdsToCaller',
  'verifyDeviceAccess', // org + exact-device + site, all three (aiTools.ts)
  'canMutateOrgWideGovernance',
  'hasSiteCeiling',
  // `routes/tickets/siteScope.ts` — checks the device axis first and THEN the
  // site axis, so naming it is naming the site axis.
  'deviceInSiteScope',
  'ticketSiteScopeCondition',
  // `services/siteScope.ts` — the reports subsystem expresses the SAME axis as
  // a resolved `SiteScopeV1` authority (`{kind:'restricted', siteIds}`) derived
  // from the caller's live grants, rather than as `auth.allowedSiteIds`.
  // `scope.siteIds` is what a consumer of that authority reads, and is how
  // `aiAuthorityDeviceIds` / the `manage_reports` report bodies narrow.
  'aiLiveReportAuthority',
  'resolveRequestReportAuthority',
  'scope.siteIds',
] as const;

function namesSiteAxis(window: string): boolean {
  return SITE_AXIS_MARKERS.some((marker) => window.includes(marker));
}

// ------------------------------------------- device-axis reachability (c)

const DEVICE_AXIS_REF = /auth\.allowedDeviceIds\b/;

/**
 * True when the test is true WHENEVER the device axis is absent, regardless of
 * any other state — i.e. every top-level `||` operand is a bare device-axis
 * absence check. `if (<that>) return …;` therefore makes everything after it
 * unreachable for a caller that carries no `allowedDeviceIds` (every human,
 * including the site-restricted one).
 */
import { splitOr } from './__testutils__/aiToolScopeScan';

function isDeviceAbsentTest(test: string): boolean {
  const parts = splitOr(test);
  if (parts.length === 0) return false;
  return parts.every((p) =>
    /^!\s*auth\.allowedDeviceIds(?:\?\.length)?$/.test(p)
    || /^auth\.allowedDeviceIds\s*===\s*undefined$/.test(p)
    || /^!\s*\(\s*auth\.allowedDeviceIds(?:\?\.length)?\s*\)$/.test(p));
}

function blankDeviceGuarded(src: string): string {
  return blankGuardedBlocks(src, DEVICE_AXIS_REF, isDeviceAbsentTest);
}

// -------------------------------------------------- cross-file delegates

/**
 * Cross-file delegates: `[exported function, module path relative to services/]`.
 *
 * Same semantics as the device suite's `CROSS_FILE_GUARDED_DELEGATES` and the
 * same non-negotiable rule: an entry is NOT trusted on its word. Each is
 * re-scanned in its own file and counts ONLY while its own body names a SITE
 * marker. Delete the guard and the delegate stops being accepted, the caller
 * reappears as unguarded, and the baseline test fails — strictly stronger than
 * baselining the caller, whose guard could then be deleted with the suite green.
 *
 * Keep it SHORT and only for a delegate that does the narrowing ITSELF. A
 * wrapper that merely forwards `auth` does not qualify.
 */
const CROSS_FILE_GUARDED_DELEGATES: ReadonlyArray<readonly [string, string]> = [
  // `get_monitor_activity`'s entire read.
  ['listMonitorDeviceActivity', join('monitors', 'episodeQueries.ts')],
  ['listMonitorEpisodes', join('monitors', 'episodeQueries.ts')],
  // `remediate_vulnerability`'s execution core: it re-resolves each finding's
  // device and denies on `deviceSiteDenied(auth, device.siteId, device.id)`
  // (`vulnerabilityRemediation.ts`), reporting out-of-site findings as skipped.
  ['remediateVulnerabilities', 'vulnerabilityRemediation.ts'],
];

/**
 * @param deviceBlanked when true the delegate's own body is checked for a site
 * marker that survives the DEVICE-guard blanking, i.e. the delegate narrows on
 * the site axis independently of the device axis (scan (c)).
 */
function verifiedCrossFileDelegates(deviceBlanked = false): string[] {
  const verified: string[] = [];
  for (const [fn, rel] of CROSS_FILE_GUARDED_DELEGATES) {
    let src = blankComments(readFileSync(join(SERVICES_DIR, rel), 'utf8'));
    if (deviceBlanked) src = blankDeviceGuarded(src);
    if (guardedLocalHelpers(src, namesSiteAxis).includes(fn)) verified.push(fn);
  }
  return verified;
}

// --------------------------------------------- site-attributable tables

const SITE_TABLES = siteAttributableTables();
const AI_TOOLS_SOURCES = aiToolsSources();

// -------------------------------------------------------------- (a) tables

/**
 * REVIEWED EXCEPTIONS — `<file>:<table>#<ordinal>` call sites that genuinely
 * need no site axis. The ordinal is the Nth call against that table in that
 * file (line-drift proof, unlike a line number). One reason per entry.
 *
 * A NEW entry needs a written justification of the same shape. If you cannot
 * write one, it is a gap, not an exception.
 */
const SITE_TABLE_EXCEPTIONS: readonly string[] = [
  // `markBackupJobDispatchFailed` / `markRestoreJobFailed`: internal status
  // writes keyed by a job id the SAME handler just created — no caller input,
  // nothing to attribute to a site.
  'aiToolsBackup.ts:backupJobs#0',
  'aiToolsBackup.ts:restoreJobs#0',
  'aiToolsBackupVm.ts:restoreJobs#0',
  // `query_psa_status`: counts ticket mappings under a PSA connection id the
  // same handler already authorised. PSA connections are org- or
  // partner-owned and carry no site attribution.
  'aiToolsIntegrations.ts:psaTicketMappings#0',
  // `create_incident`: the INSERT writes `affectedDevices` straight from
  // `input.affectedDeviceIds`, and the tool declares `deviceArgs:
  // ['affectedDeviceIds']`, so `executeTool` -> `enforceDeviceArgs` has already
  // run `verifyDeviceAccess` (org + exact-device + SITE) over every id before
  // the handler is entered. Omitting the argument creates an incident with no
  // affected devices — nothing site-attributable to narrow.
  'aiToolsIncident.ts:incidents#1',
  // `create_org`: the default 'Main Office' site inserted into an org created
  // three statements earlier. There is no pre-existing site to be restricted to.
  'aiToolsOrgs.ts:sites#1',
  // `create_site`: a site-restricted tech holding `sites:write` can create a
  // NEW site — deliberate PARITY with `routes/orgs.ts` (audit 2026-09-17 §1.3,
  // "design notes, not defects"). The new site is not added to the caller's
  // allowlist, so it does not widen their reach. Flagged there for a product
  // decision; if that decision lands, this entry goes, not the guard.
  'aiToolsOrgs.ts:sites#2',
  // `loadEnabledPamRules(device, auth)`: rules are selected BY the device's own
  // `siteId` (`pamRules.siteId = device.siteId OR IS NULL`), and that device was
  // resolved by the loader immediately above, which denies on
  // `auth.canAccessSite(device.siteId)`. Authorised-parent cascade.
  'aiToolsPam.ts:pamRules#0',
  // `queryMetricRollupsForAnalysis(orgId, deviceId, …)`: takes an explicit
  // deviceId the caller resolved through a guarded lookup.
  'aiToolsPerformance.ts:metricRollups#0',
  // `readFindingDevices`: deliberately NOT narrowed, so a finding on an
  // out-of-reach device comes BACK and `remediate_vulnerability` refuses the
  // whole batch rather than silently thinning it. The site denial itself is
  // `vulnerabilityRemediation.ts` (`deviceSiteDenied(auth, device.siteId,
  // device.id)`), registered as a cross-file delegate above.
  'aiToolsVulnerability.ts:deviceVulnerabilities#0',
  // `readDeviceFindings(orgId, {…, allowedDeviceIds})`: a parameterised read
  // model, not a handler — the narrowing is the caller's, and all three callers
  // do it: `get_vulnerability_report` passes `resolveSiteAllowedDeviceIds`,
  // `get_device_vulnerabilities` is `deviceArgs`-gated through
  // `verifyDeviceAccess`, and the export adapter calls `verifyDeviceAccess`
  // per device.
  'aiToolsVulnerability.ts:deviceVulnerabilities#1',
];

/**
 * KNOWN OPEN GAPS — real, UNFIXED site-axis exposure, recorded so this suite is
 * green while the gap stays loudly visible. Each entry names what a
 * site-restricted human reaches. **Never add to this list to make a build
 * pass**; it shrinks only.
 */
const SITE_TABLE_KNOWN_OPEN_GAPS: readonly string[] = [
  // EMPTY — and it must stay that way. The last entry
  // (`aiToolsScripts.ts:scriptExecutions#1`, `get_script_details`'s
  // `includeExecutionStats` aggregate) was closed by joining `devices` and
  // adding `siteScopeCondition(auth, devices.siteId)` alongside the existing
  // exact-device narrowing. A new finding belongs in the SOURCE, not here.
];

function siteTableBaseline(): string[] {
  return [...SITE_TABLE_EXCEPTIONS, ...SITE_TABLE_KNOWN_OPEN_GAPS];
}

/**
 * Scan ONE source string. Exposed separately from the file walk so the fixture
 * self-tests below can drive the whole pipeline — ordinals, handler windows,
 * local-helper delegation, device-guard blanking — on a string that a
 * concurrent PR cannot "fix" out from under the proof.
 *
 * @param rawSrc source with comments already blanked.
 */
function scanSource(
  file: string,
  rawSrc: string,
  opts: { reachable?: boolean; tables?: ReadonlyMap<string, string[]>; crossFile?: readonly string[] } = {},
): { hits: string[]; total: number } {
  const reachable = opts.reachable === true;
  const tables = opts.tables ?? SITE_TABLES;
  const crossFile = opts.crossFile ?? [];
  const hits: string[] = [];
  let total = 0;
  // Ordinals and call-site discovery always come from the UN-blanked source so
  // the two scans address the same sites by the same id.
  const scanned = reachable ? blankDeviceGuarded(rawSrc) : rawSrc;
  const starts = windowStarts(scanned);
  const helpers = [...guardedLocalHelpers(scanned, namesSiteAxis), ...crossFile];
  const ordinals = new Map<string, number>();
  const re = /\.(?:from|update|delete|insert)\(\s*(\w+)\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawSrc)) !== null) {
    const table = m[1]!;
    if (!tables.has(table)) continue;
    total++;
    const ordinal = ordinals.get(table) ?? 0;
    ordinals.set(table, ordinal + 1);
    // The call site itself sits inside a device-guarded block: a caller with
    // no device axis never executes it, so it is not a site exposure.
    if (reachable && scanned[m.index] === ' ') continue;
    const window = enclosingWindow(scanned, starts, m.index);
    if (namesSiteAxis(window) || delegatesToGuardedHelper(window, helpers)) continue;
    hits.push(`${file}:${table}#${ordinal}`);
  }
  return { hits, total };
}

function unguardedSiteTableCalls(opts: { reachable?: boolean } = {}): { all: string[]; total: number } {
  const all: string[] = [];
  let total = 0;
  const crossFile = verifiedCrossFileDelegates(opts.reachable === true);
  for (const file of AI_TOOLS_SOURCES) {
    const src = blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8'));
    const { hits, total: n } = scanSource(file, src, { ...opts, crossFile });
    all.push(...hits);
    total += n;
  }
  return { all, total };
}

describe('contract: AI tools touching a site-attributable table name the site axis', () => {
  it('discovers the site-attributable tables and the calls to scan', () => {
    // A collapse here means the schema layout or the pgTable spelling changed
    // and the scan went blind — re-derive it rather than lowering these numbers.
    expect(SITE_TABLES.size).toBeGreaterThan(100);
    expect(AI_TOOLS_SOURCES.length).toBeGreaterThan(40);
    expect(unguardedSiteTableCalls().total).toBeGreaterThan(100);
    // All three edges must be present: the id-keyed site table itself, a table
    // with its OWN site_id, and one that is site-attributable only through its
    // fleet device_id.
    expect(SITE_TABLES.get('sites')).toEqual(['id']);
    expect(SITE_TABLES.get('devices')).toContain('siteId');
    expect(SITE_TABLES.get('discoveredAssets')).toContain('linkedDeviceId');
    // …and one attributable only through its CONTENT (no site_id, no device_id).
    expect(SITE_TABLES.get('incidents')).toContain('affectedDevices');
    expect(SITE_TABLES.get('deployments')).toContain('targetConfig');
    expect(SITE_TABLES.get('slaDefinitions')).toContain('targetIds');
    // …and one attributable only through a PLURAL / suffixed site column
    // (#6110 review 1). `organization_users.site_ids` is the column that FEEDS
    // `auth.allowedSiteIds`; a singular-only pattern could not see it, nor any
    // of the array site columns below.
    expect(SITE_TABLES.get('organizationUsers')).toContain('siteIds');
    expect(SITE_TABLES.get('maintenanceWindows')).toContain('siteIds');
    expect(SITE_TABLES.get('networkBaselines')).toContain('authoritySiteIds');
    expect(SITE_TABLES.get('fleetRemediationRunTargets')).toContain('siteIdSnapshot');
    // The UniFi vendor-id columns must NOT make their table site-attributable
    // on their own (`local_site_id` is a controller-local string, not a FK).
    expect(SITE_TABLES.get('unifiControllerSites')).toBeUndefined();
  });

  it('no call site outside the frozen baseline', () => {
    const { all } = unguardedSiteTableCalls();
    const unexpected = all.filter((entry) => !siteTableBaseline().includes(entry));
    // A failure here is a NEW site-unguarded read/write. Narrow the query
    // (siteScopeCondition / resolveSiteAllowedDeviceIds / deviceSiteDenied / …)
    // — do not add the entry to a baseline.
    expect(unexpected).toEqual([]);
  });

  it('the baseline is shrink-only (no stale entries)', () => {
    const { all } = unguardedSiteTableCalls();
    const stale = siteTableBaseline().filter((entry) => !all.includes(entry));
    expect(stale).toEqual([]);
  });
});

// ----------------------------------------------- (c) site-axis reachability

/**
 * REVIEWED EXCEPTIONS for scan (c) — IN ADDITION to the scan (a) baseline,
 * which scan (c) inherits (blanking only removes text, so scan (c) ⊇ scan (a)).
 */
const REACHABLE_SITE_AXIS_EXCEPTIONS: readonly string[] = [
];

/** KNOWN OPEN GAPS for scan (c). See `SITE_TABLE_KNOWN_OPEN_GAPS`. */
const REACHABLE_SITE_AXIS_KNOWN_OPEN_GAPS: readonly string[] = [
];

function reachableBaseline(): string[] {
  return [
    ...siteTableBaseline(),
    ...REACHABLE_SITE_AXIS_EXCEPTIONS,
    ...REACHABLE_SITE_AXIS_KNOWN_OPEN_GAPS,
  ];
}

describe('contract: the site axis is reachable for a caller with no device axis', () => {
  it('scan (c) is a superset of scan (a)', () => {
    const plain = unguardedSiteTableCalls().all;
    const reach = unguardedSiteTableCalls({ reachable: true }).all;
    expect(plain.filter((e) => !reach.includes(e))).toEqual([]);
  });

  it('no call site outside the frozen baseline', () => {
    const { all } = unguardedSiteTableCalls({ reachable: true });
    const baseline = reachableBaseline();
    // A failure here is a handler whose ONLY site marker sits inside an
    // `if (auth.allowedDeviceIds …)` block — the device axis standing in for a
    // site guard (audit §1.1). Move the site narrowing OUT of the device
    // branch; `siteScopeCondition` / `scopeDeviceIdsToCaller` are axis-independent.
    expect(all.filter((entry) => !baseline.includes(entry))).toEqual([]);
  });

  it('the baseline is shrink-only (no stale entries)', () => {
    const { all } = unguardedSiteTableCalls({ reachable: true });
    expect(reachableBaseline().filter((entry) => !all.includes(entry))).toEqual([]);
  });
});

// ------------------------------------- (b) optional device / site arguments

/** REVIEWED EXCEPTIONS — tools whose optional id genuinely needs no site axis. */
const OPTIONAL_SITE_ARG_EXCEPTIONS: readonly string[] = [
  // FALSE POSITIVE of the same-file scan: `export_dataset` fans out to
  // per-dataset adapters in `aiToolsExportDatasets.ts`, each of which narrows
  // (the device-scoped ones call `verifyDeviceAccess` per device). One adapter
  // per dataset rather than a single read model, so it does not fit
  // `CROSS_FILE_GUARDED_DELEGATES` either. Pinned by
  // `aiToolsExportDatasets.test.ts`.
  'aiToolsExport.ts:export_dataset',
  // `m365_query_sites`' `siteId` is a Microsoft Graph composite SHAREPOINT site
  // id read live from the customer tenant — unrelated to `sites.id` and to the
  // Breeze site axis (audit §3.1 "no site-attributable data").
  'aiToolsM365.ts:m365_query_sites',
  // `s1_isolate_device` reaches no site-attributable Breeze table itself: it
  // hands the ids to `executeS1IsolationForOrg`. Its Zod schema refuses a call
  // with no device target, so the "optional id omitted" shape cannot occur, and
  // `executeTool` -> `enforceDeviceArgs` -> `verifyDeviceAccess` applies org +
  // exact-device + SITE to every id before the handler runs (whole batch, fail
  // closed). Proven by `aiToolsSentinelOne.deviceScope.test.ts`.
  'aiToolsSentinelOne.ts:s1_isolate_device',
];

/** KNOWN OPEN GAPS for scan (b). See `SITE_TABLE_KNOWN_OPEN_GAPS`. */
const OPTIONAL_SITE_ARG_KNOWN_OPEN_GAPS: readonly string[] = [
];

function optionalArgBaseline(): string[] {
  return [...OPTIONAL_SITE_ARG_EXCEPTIONS, ...OPTIONAL_SITE_ARG_KNOWN_OPEN_GAPS];
}

/**
 * Scan ONE source string for scan (b). Pure, exactly like `scanSource` above,
 * so the fixtures below drive the LIVE scanner rather than a re-typed copy
 * (#6110 review 3: this scan read files directly and had no fixture at all —
 * the one scanner in this file whose discrimination nothing proved).
 *
 * @param src source with comments already blanked.
 */
function scanOptionalArgTools(
  file: string,
  src: string,
  crossFile: readonly string[] = [],
): { unguarded: string[]; total: number } {
  const unguarded: string[] = [];
  let total = 0;
  const helpers = [...guardedLocalHelpers(src, namesSiteAxis), ...crossFile];
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
    if (!/\b(?:deviceIds?|siteIds?)\s*:/.test(props)) continue;
    // The schema's OWN `required:`, i.e. the first one after the `properties`
    // object closes — a nested property schema can carry its own `required`.
    const reqIdx = src.indexOf('required:', propsEnd);
    const required = reqIdx >= 0 && reqIdx < handlerIdx
      ? src.slice(reqIdx, src.indexOf(']', reqIdx))
      : '';
    // Only a tool where EVERY id it declares is mandatory escapes the scan: a
    // mandatory `deviceId` alongside an optional `siteId` is still the shape.
    const declared = [...props.matchAll(/\b(deviceIds?|siteIds?)\s*:/g)].map((d) => d[1]!);
    if (declared.every((d) => new RegExp(`'${d}'`).test(required))) continue;
    total++;
    // Handler window: from `handler` to the next tool definition's `name:`.
    nameRe.lastIndex = handlerIdx;
    const next = nameRe.exec(src);
    const window = src.slice(handlerIdx, next ? next.index : src.length);
    nameRe.lastIndex = handlerIdx;
    if (namesSiteAxis(window) || delegatesToGuardedHelper(window, helpers)) continue;
    unguarded.push(`${file}:${m[1]!}`);
  }
  return { unguarded, total };
}

function optionalSiteArgTools(): { unguarded: string[]; total: number } {
  const unguarded: string[] = [];
  let total = 0;
  const crossFile = verifiedCrossFileDelegates();
  for (const file of AI_TOOLS_SOURCES) {
    const src = blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8'));
    const { unguarded: hits, total: n } = scanOptionalArgTools(file, src, crossFile);
    unguarded.push(...hits);
    total += n;
  }
  return { unguarded, total };
}

describe('contract: tools with an OPTIONAL device/site argument still bound the site axis', () => {
  it('finds the optional-id tools to scan', () => {
    expect(optionalSiteArgTools().total).toBeGreaterThan(25);
  });

  it('no tool outside the frozen baseline', () => {
    const { unguarded } = optionalSiteArgTools();
    const unexpected = unguarded.filter((t) => !optionalArgBaseline().includes(t));
    // A failure here is a tool that reads across every site when its optional id
    // is omitted. `deviceArgs` does not fix it — `enforceDeviceArgs` no-ops on
    // an absent argument.
    expect(unexpected).toEqual([]);
  });

  it('the baseline is shrink-only (no stale entries)', () => {
    const { unguarded } = optionalSiteArgTools();
    expect(optionalArgBaseline().filter((t) => !unguarded.includes(t))).toEqual([]);
  });
});

// ------------------------------------------- cross-file delegate integrity

describe('contract: every cross-file site delegate is actually verified', () => {
  it('each CROSS_FILE_GUARDED_DELEGATES entry resolves to a site-guarded body', () => {
    expect(verifiedCrossFileDelegates()).toHaveLength(CROSS_FILE_GUARDED_DELEGATES.length);
  });

  it('each entry still narrows on the no-device-axis path', () => {
    expect(verifiedCrossFileDelegates(true)).toHaveLength(CROSS_FILE_GUARDED_DELEGATES.length);
  });
});

// --------------------------------------------------- scanner self-tests
//
// The scanners are the only thing standing between a dead guard and a green
// suite, so they are unit-tested on string FIXTURES rather than on live source:
// a fixture cannot be "fixed" out from under the proof by a concurrent PR.

describe('scanner: device-guard blanking discriminates device-only guards', () => {
  const survives = (src: string) => namesSiteAxis(blankDeviceGuarded(blankComments(src)));

  it('the audit’s dominant pattern: a device-only intersection is not a site guard', () => {
    // `scopedAffectedDevices` / `scopedTargetDeviceIds` verbatim in shape.
    expect(survives(`
      function scopedTargetDeviceIds(auth, ids) {
        if (!auth.allowedDeviceIds) return null;
        const allowed = new Set(auth.allowedDeviceIds);
        return ids.filter((id) => allowed.has(id));
      }
    `)).toBe(false);
  });

  it('the same helper passes once it also applies the site axis', () => {
    expect(survives(`
      async function scopedTargetDeviceIds(auth, orgId, ids) {
        return scopeDeviceIdsToCaller(auth, orgId, ids);
      }
    `)).toBe(true);
  });

  it('a site marker reachable only under `if (auth.allowedDeviceIds && …)` does not survive', () => {
    expect(survives(`
      handler: async (input, auth) => {
        const conditions = [];
        if (auth.allowedDeviceIds) {
          conditions.push(siteScopeCondition(auth, devices.siteId));
        }
        return db.select().from(t).where(and(...conditions));
      }
    `)).toBe(false);
  });

  it('the same handler passes once the site narrowing is unconditional', () => {
    expect(survives(`
      handler: async (input, auth) => {
        const conditions = [siteScopeCondition(auth, devices.siteId)];
        if (auth.allowedDeviceIds) {
          conditions.push(inArray(t.deviceId, [...auth.allowedDeviceIds]));
        }
        return db.select().from(t).where(and(...conditions));
      }
    `)).toBe(true);
  });

  it('a braceless device-guarded statement is blanked too', () => {
    expect(survives(`
      handler: async (input, auth) => {
        if (auth.allowedDeviceIds) conditions.push(siteScopeCondition(auth, d.siteId));
        return db.select().from(t);
      }
    `)).toBe(false);
  });

  it('a device-guarded ternary CONSEQUENT is blanked, the alternate is kept', () => {
    expect(survives(`
      const ids = auth.allowedDeviceIds ? await resolveSiteAllowedDeviceIds(o, auth) : null;
    `)).toBe(false);
    expect(survives(`
      const ids = auth.allowedDeviceIds ? null : await resolveSiteAllowedDeviceIds(o, auth);
    `)).toBe(true);
  });

  it('the ELSE branch of a device guard is kept (it is the human path)', () => {
    expect(survives(`
      if (auth.allowedDeviceIds) {
        conditions.push(inArray(t.deviceId, [...auth.allowedDeviceIds]));
      } else {
        conditions.push(siteScopeCondition(auth, d.siteId));
      }
    `)).toBe(true);
  });

  it('`if (!auth.allowedDeviceIds) return …` blanks the REST of the block', () => {
    expect(survives(`
      async function f(auth, row) {
        if (!auth.allowedDeviceIds) return false;
        return deviceSiteDenied(auth, row.siteId, row.deviceId);
      }
    `)).toBe(false);
  });

  it('an early return that ALSO consults the site axis does not blank the rest', () => {
    expect(survives(`
      async function f(auth, row) {
        if (!auth.allowedDeviceIds && !auth.allowedSiteIds) return false;
        return deviceSiteDenied(auth, row.siteId, row.deviceId);
      }
    `)).toBe(true);
  });

  it('a handler with no device guard at all is untouched', () => {
    const src = 'const c = [siteScopeCondition(auth, d.siteId)];';
    expect(blankDeviceGuarded(src)).toBe(src);
  });
});

describe('scanner: site-axis markers exclude the exact-device axis', () => {
  it('device-axis identifiers are NOT site markers', () => {
    expect(namesSiteAxis('conditions.push(deviceScopeCondition(auth, t.deviceId));')).toBe(false);
    expect(namesSiteAxis('return filterToDeviceScope(auth, rows, (r) => r.deviceId);')).toBe(false);
    expect(namesSiteAxis('const ids = auth.allowedDeviceIds;')).toBe(false);
    expect(namesSiteAxis('const ids = runFrozenDeviceIds(auth);')).toBe(false);
    expect(namesSiteAxis('deviceArgs: { deviceId: true },')).toBe(false);
  });

  it('site-axis identifiers are markers', () => {
    for (const marker of SITE_AXIS_MARKERS) {
      expect(namesSiteAxis(`x = f(${marker});`)).toBe(true);
    }
  });

  it('`deviceIdSiteDenied` is not covered by the `deviceSiteDenied` entry', () => {
    // It is NOT a substring of it. Listing only `deviceSiteDenied` made
    // `findAlertWithAccess` — whose sole site gate is this call — read as
    // unguarded in two files.
    expect('deviceIdSiteDenied'.includes('deviceSiteDenied')).toBe(false);
    expect(namesSiteAxis('if (await deviceIdSiteDenied(auth, id)) return null;')).toBe(true);
  });

  it('a marker named only in a COMMENT does not count', () => {
    const src = blankComments(`
      handler: async (input, auth) => {
        // site scope: we rely on canAccessSite upstream
        return db.select().from(t);
      }
    `);
    expect(namesSiteAxis(src)).toBe(false);
  });
});

describe('scanner: site-attributable column detection', () => {
  it('sees own-site and device-edge columns and ignores vendor site ids', () => {
    const src = `
      export const siteRows = pgTable('site_rows', {
        id: uuid('id'),
        siteId: uuid('site_id').references(() => sites.id),
      });
      export const unifiSites = pgTable('unifi_sites', {
        unifiSiteId: text('unifi_site_id').notNull(),
      });
      export const assets = pgTable('assets', {
        linkedDeviceId: uuid('linked_device_id').references(() => devices.id),
      });
      export const pushTokens = pgTable('push_tokens', {
        mobileDeviceId: uuid('mobile_device_id').notNull(),
      });
    `;
    const bySite = tablesWithColumnIn(src, SITE_COLUMN_RE, NON_FLEET_SITE_ID_COLUMNS);
    const byDevice = tablesWithColumnIn(src, DEVICE_COLUMN_RE, NON_FLEET_DEVICE_ID_COLUMNS);
    expect([...bySite.keys()]).toEqual(['siteRows']);
    expect([...byDevice.keys()]).toEqual(['assets']);
  });

  it('sees PLURAL and snapshot site columns, and no pgTable INDEX declaration', () => {
    // #6110 review 1. A singular-only `/\w*[Ss]iteId:\s/` was blind to every
    // ARRAY site column — including `organization_users.site_ids`, the column
    // `auth.allowedSiteIds` is loaded FROM. The `siteIdIdx` / `uniqueSiteIdx`
    // cases pin the other side: the index block of a `pgTable`'s second
    // argument is inside the scanned slice and must not read as a column.
    const found = tablesWithColumnIn(`
      export const orgUsers = pgTable('organization_users', {
        siteIds: uuid('site_ids').array(),
      });
      export const reportRuns = pgTable('report_runs', {
        executionScopeSiteIds: uuid('execution_scope_site_ids').array(),
      });
      export const findings = pgTable('findings', {
        siteIdSnapshot: uuid('site_id_snapshot'),
      });
      export const indexedOnly = pgTable('indexed_only', {
        orgId: uuid('org_id'),
      }, (t) => ({
        siteIdIdx: index('site_id_idx').on(t.orgId),
        uniqueSiteIdx: uniqueIndex('unique_site_idx').on(t.orgId),
      }));
    `, SITE_COLUMN_RE, NON_FLEET_SITE_ID_COLUMNS);
    expect([...found.keys()].sort()).toEqual(['findings', 'orgUsers', 'reportRuns']);
    expect(found.get('orgUsers')).toEqual(['siteIds']);
    expect(found.get('findings')).toEqual(['siteIdSnapshot']);
  });
});

describe('scanner: the table scan discriminates a present guard from an absent one', () => {
  // A synthetic `aiTools*.ts` with two handlers over the same table. Only the
  // second names the site axis.
  const FIXTURE_TABLES = new Map([['alerts', ['deviceId']]]);
  const fixture = (guard: string) => blankComments(`
    export function registerFixtureTools(aiTools) {
      registerTool({
        definition: { name: 'unguarded_read' },
        handler: async (input, auth) => {
          return db.select().from(alerts).where(eq(alerts.orgId, auth.orgId));
        },
      });
      registerTool({
        definition: { name: 'second_read' },
        handler: async (input, auth) => {
          ${guard}
          return db.select().from(alerts).where(and(...conditions));
        },
      });
    }
  `);

  it('reports BOTH call sites when neither handler names the axis', () => {
    expect(scanSource('f.ts', fixture('const conditions = [];'), { tables: FIXTURE_TABLES }).hits)
      .toEqual(['f.ts:alerts#0', 'f.ts:alerts#1']);
  });

  it('reports only the unguarded one once the second handler narrows', () => {
    const guarded = fixture('const conditions = [siteScopeCondition(auth, devices.siteId)];');
    expect(scanSource('f.ts', guarded, { tables: FIXTURE_TABLES }).hits).toEqual(['f.ts:alerts#0']);
  });

  it('a DEVICE-axis guard does NOT stand in for the site guard', () => {
    // The audit's dominant finding, exercised through the whole pipeline.
    const deviceOnly = fixture('const conditions = [deviceScopeCondition(auth, alerts.deviceId)];');
    expect(scanSource('f.ts', deviceOnly, { tables: FIXTURE_TABLES }).hits)
      .toEqual(['f.ts:alerts#0', 'f.ts:alerts#1']);
  });

  it('ordinals are stable when a call is added ABOVE an existing one', () => {
    // The whole reason entries are `<table>#<n>` and not line numbers.
    const withExtra = blankComments(`
      function helper() { return db.select().from(alerts); }
      function later() { return db.select().from(alerts); }
    `);
    expect(scanSource('f.ts', withExtra, { tables: FIXTURE_TABLES }).hits)
      .toEqual(['f.ts:alerts#0', 'f.ts:alerts#1']);
  });

  it('a local helper that narrows covers the handler that delegates to it', () => {
    const delegating = blankComments(`
      async function scopedRows(auth, orgId) {
        const allowed = await resolveSiteAllowedDeviceIds(orgId, auth);
        return allowed;
      }
      handler: async (input, auth) => {
        const ids = await scopedRows(auth, orgId);
        return db.select().from(alerts).where(inArray(alerts.deviceId, ids ?? []));
      }
    `);
    expect(scanSource('f.ts', delegating, { tables: FIXTURE_TABLES }).hits).toEqual([]);
  });

  it('and stops covering it the moment the helper loses its guard', () => {
    const deadHelper = blankComments(`
      async function scopedRows(auth, orgId) {
        return auth.allowedDeviceIds ?? null;
      }
      handler: async (input, auth) => {
        const ids = await scopedRows(auth, orgId);
        return db.select().from(alerts).where(inArray(alerts.deviceId, ids ?? []));
      }
    `);
    expect(scanSource('f.ts', deadHelper, { tables: FIXTURE_TABLES }).hits).toEqual(['f.ts:alerts#0']);
  });

  it('scan (c) additionally reports a guard reachable only under the device axis', () => {
    const deviceGated = blankComments(`
      handler: async (input, auth) => {
        const conditions = [];
        if (auth.allowedDeviceIds) {
          conditions.push(siteScopeCondition(auth, devices.siteId));
        }
        return db.select().from(alerts).where(and(...conditions));
      }
    `);
    expect(scanSource('f.ts', deviceGated, { tables: FIXTURE_TABLES }).hits).toEqual([]);
    expect(scanSource('f.ts', deviceGated, { tables: FIXTURE_TABLES, reachable: true }).hits)
      .toEqual(['f.ts:alerts#0']);
  });
});

describe('scanner: the optional-argument scan discriminates the optional-id shape', () => {
  // #6110 review 3: scan (b) used to read the live files inline, so nothing
  // proved it could tell a reported tool from a clean one.
  const tool = (opts: { props: string; required: string; body: string }) => blankComments(`
    registerTool({
      definition: {
        name: 'fixture_tool',
        input_schema: {
          type: 'object',
          properties: {
            ${opts.props}
          },
          required: [${opts.required}],
        },
      },
      handler: async (input, auth) => {
        ${opts.body}
      },
    });
  `);

  const OPTIONAL_DEVICE = { props: `deviceId: { type: 'string' },`, required: `'orgId'` };

  it('an OPTIONAL deviceId with no site marker is reported', () => {
    const src = tool({ ...OPTIONAL_DEVICE, body: 'return db.select().from(alerts);' });
    expect(scanOptionalArgTools('f.ts', src)).toEqual({ unguarded: ['f.ts:fixture_tool'], total: 1 });
  });

  it('the same tool is clean once the handler names the site axis', () => {
    const src = tool({
      ...OPTIONAL_DEVICE,
      body: 'return db.select().from(alerts).where(siteScopeCondition(auth, devices.siteId));',
    });
    expect(scanOptionalArgTools('f.ts', src)).toEqual({ unguarded: [], total: 1 });
  });

  it('a MANDATORY deviceId is not the shape at all — not even counted', () => {
    const src = tool({
      props: `deviceId: { type: 'string' },`,
      required: `'deviceId'`,
      body: 'return db.select().from(alerts);',
    });
    expect(scanOptionalArgTools('f.ts', src)).toEqual({ unguarded: [], total: 0 });
  });

  it('a mandatory deviceId alongside an OPTIONAL siteId is still the shape', () => {
    const src = tool({
      props: `deviceId: { type: 'string' },\n            siteId: { type: 'string' },`,
      required: `'deviceId'`,
      body: 'return db.select().from(alerts);',
    });
    expect(scanOptionalArgTools('f.ts', src)).toEqual({ unguarded: ['f.ts:fixture_tool'], total: 1 });
  });

  it('a `required` nested INSIDE a property schema does not mislabel the id', () => {
    // `aiToolsConfigPolicy.ts` has this shape. Reading the nested `required`
    // would report a mandatory deviceId as optional (or the reverse).
    const src = tool({
      props: `deviceId: { type: 'string' },\n            filter: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },`,
      required: `'deviceId'`,
      body: 'return db.select().from(alerts);',
    });
    expect(scanOptionalArgTools('f.ts', src)).toEqual({ unguarded: [], total: 0 });
  });

  it('a local helper that narrows covers the handler that delegates to it', () => {
    const src = blankComments(`
      async function scopedIds(auth, orgId) {
        return scopeDeviceIdsToCaller(auth, orgId, []);
      }
      registerTool({
        definition: {
          name: 'fixture_tool',
          input_schema: {
            type: 'object',
            properties: { deviceId: { type: 'string' } },
            required: ['orgId'],
          },
        },
        handler: async (input, auth) => {
          const ids = await scopedIds(auth, input.orgId);
          return db.select().from(alerts);
        },
      });
    `);
    expect(scanOptionalArgTools('f.ts', src)).toEqual({ unguarded: [], total: 1 });
  });

  it('a site marker named only in a COMMENT does not clear the tool', () => {
    const src = tool({
      ...OPTIONAL_DEVICE,
      body: '// canAccessSite is applied upstream\n        return db.select().from(alerts);',
    });
    expect(scanOptionalArgTools('f.ts', src)).toEqual({ unguarded: ['f.ts:fixture_tool'], total: 1 });
  });
});
