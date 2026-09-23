/**
 * #3198 W01 (spec 3.1a), hardened in W02 (addendum B1) — partner-owned report
 * visibility is mechanical.
 *
 * `org_access = 'all'` has NO database backstop: `breeze_has_partner_access`
 * is flat partner membership, and `org_access` lives only in the app layer. A
 * 'selected' partner user's RLS context therefore sees partner-owned reports,
 * their runs and their deliveries, and is kept out of them purely by call-site
 * discipline. That discipline is one helper module (routes/reports/helpers.ts)
 * and this scan, which checks, PER QUERY SITE (file + innermost named scope):
 *
 *  1. Every read or mutation of `reports`, `reportRuns` or
 *     `reportRunDeliveries` under routes/, services/, jobs/ — `.from`, any
 *     join, `.update`, `.delete`, `db.query.<table>` — sits in a scope that
 *     calls `partnerOwnedReportVisibility` or one of the GUARD_ENTRYPOINTS
 *     (each proven here to reach the helper), or is allowlisted org-only /
 *     system-only for that one scope with a written reason. One guarded
 *     function no longer exempts the rest of its file.
 *  2. The partner-scope tenant predicates each call the helper directly.
 *  3. A raw `reports.partnerId` PREDICATE appears only inside the gated helper
 *     functions listed in PARTNER_ID_PREDICATE_SITES.
 *
 * A scope is the innermost of: `function name(`, `const|let name = (…) =>`,
 * an object-property arrow `name: (…) =>`, an AI tool `safeHandler('tool', …)`
 * (`tool:<name>`), or a Hono registration `xRoutes.get('/path', …)`
 * (`GET /path`). Anonymous callbacks belong to their enclosing named scope.
 *
 * Textual, not semantic — the route suites (`core.partnerOwned.test.ts`,
 * `helpers.partnerOwned.test.ts`) and reportsPartnerOwned.integration assert
 * the behaviour.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/routes', 'src/services', 'src/jobs'].map((p) => join(process.cwd(), p));

const GUARDED_TABLES = ['reports', 'reportRuns', 'reportRunDeliveries'] as const;
const TABLE_ALT = GUARDED_TABLES.join('|');
/**
 * A read or mutation of a guarded table. `.insert(t)` is excluded: it targets
 * no existing row, so it cannot reveal or alter a partner-owned one.
 */
const QUERY_SITE_SOURCE =
  `\\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin|update|delete)\\(\\s*(?:${TABLE_ALT})\\b`
  + `|\\bquery\\.(?:${TABLE_ALT})\\b`;
const QUERY_SITE = new RegExp(QUERY_SITE_SOURCE);
const HELPER_CALL = /(?<!function\s)\bpartnerOwnedReportVisibility\(/;

/**
 * Functions that reach `partnerOwnedReportVisibility` on every path, so a scope
 * calling one of them is guarded. Each is verified below: its own body calls
 * the helper or an EARLIER entry (or, for `alias`, it is `export const X = Y`
 * with Y an earlier entry).
 */
const GUARD_ENTRYPOINTS: ReadonlyArray<{ file: string; fn: string; alias?: string }> = [
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedReportCondition' },
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedRunCondition' },
  { file: 'src/routes/reports/helpers.ts', fn: 'getReportWithOwnerCheck' },
  { file: 'src/routes/reports/helpers.ts', fn: 'getReportWithOrgCheck', alias: 'getReportWithOwnerCheck' },
  { file: 'src/routes/reports/helpers.ts', fn: 'getReportRunWithOwnerCheck' },
  { file: 'src/routes/reports/helpers.ts', fn: 'getReportRunWithOrgCheck', alias: 'getReportRunWithOwnerCheck' },
  { file: 'src/routes/reports/core.ts', fn: 'resolveDefinitionListScope' },
  { file: 'src/routes/reports/core.ts', fn: 'loadLockedDefinition' },
  { file: 'src/routes/reports/recipients.ts', fn: 'loadOrgOwnedDefinition' },
];

/** The partner-scope tenant predicates: each must call the helper itself. */
const MUST_CALL_HELPER: ReadonlyArray<{ file: string; fn: string }> = [
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedReportCondition' },
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedRunCondition' },
  { file: 'src/routes/reports/core.ts', fn: 'resolveDefinitionListScope' },
  { file: 'src/routes/reports/runs.ts', fn: 'GET /runs' },
];

const ORG_PIN = 'a partner-owned row has org_id NULL and cannot match an org_id equality';

/**
 * Query sites that are org-only or system-only BY DESIGN, keyed per file AND
 * per scope. Each entry needs a reason. A new query in an allowlisted file but
 * a different scope is NOT covered.
 */
const SITE_ALLOWLIST: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map<string, Map<string, string>>([
  ['src/routes/aiAgents.ts', new Map([
    ['GET /runs/:runId', `AI-agent run artifact reads join reports and pin eq(reports.orgId, run.orgId) AND auth.orgCondition(reports.orgId); ${ORG_PIN}`],
  ])],
  ['src/routes/fleetDesign.ts', new Map([
    ['GET /', 'lists type ai_fleet_design (system-authored, org-owned) under auth.orgCondition(reports.orgId)'],
  ])],
  ['src/services/aiAgents/fleetDesignReport.ts', new Map([
    ['persistFleetDesignReport', `Fleet Design is system-authored and org-owned: definition read/update keyed on eq(reports.orgId, run.orgId); the run update targets the artifact row it just inserted; ${ORG_PIN}`],
    ['loadFleetDesignReport', 'by-id run read joined to reports with type ai_fleet_design AND orgCondition(reports.orgId); a partner-owned row is never that type'],
  ])],
  ['src/services/aiAgents/narrativeReport.ts', new Map([
    ['persistNarrativeReport', 'the weekly AI narrative is system-authored and org-owned; keyed on eq(reports.orgId, run.orgId) + source schedule; the run update targets the artifact it just inserted'],
  ])],
  ['src/services/aiToolsFleet.ts', new Map([
    ['aiReportDefinitionAccess', 'refuses a partner-owned row via requireOrgOwnedReportRow before returning access (#3198 W01 Task 5b owner guard); predicates are reports.org_id'],
    ['aiReportRunAccess', 'refuses a partner-owned row via requireOrgOwnedReportRow before returning access (#3198 W01 Task 5b owner guard); predicates are reports.org_id'],
    ['tool:generate_report', 'AI report tool is org-axis: list filters orgWhere/inArray(reports.orgId); every by-id read, update and delete first passes aiReportDefinitionAccess / aiReportRunAccess and pins eq(reports.orgId, access.metadata.orgId)'],
  ])],
  ['src/services/deliverableAutoEvidence.ts', new Map([
    ['generateAutoEvidenceForOccurrence', `managed evidence is org-owned by construction (#5784): definition read is id AND org_id = <deliverable org>; ${ORG_PIN}`],
    ['finishRun', 'generateAutoEvidenceForOccurrence\'s local: updates the run id runGenerator just inserted for the org-owned evidence definition'],
    ['runGenerator', 'generateAutoEvidenceForOccurrence\'s local: inserts a run for the org-owned evidence definition and updates only that run by id'],
  ])],
  ['src/services/evidenceBaseline.ts', new Map([
    ['previousOccurrenceBaselineFor', 'reaches report_runs only through service_deliverable_evidence of one org-owned deliverable (evidence linkage validates reports.org_id = <deliverable org>)'],
  ])],
  ['src/services/fleetDesign/drift.ts', new Map([
    ['loadApprovedDesign', 'reads the run id taken from fleet_design_applied_items pinned to eq(orgId, orgId); applied items only reference org-owned ai_fleet_design runs'],
  ])],
  ['src/services/fleetDesign/ledger.ts', new Map([
    ['lockReportRun', 'Fleet Design ledger reads type ai_fleet_design under orgCondition(reports.org_id); a partner-owned row is never that type'],
  ])],
  ['src/services/managedEvidenceDefinitions.ts', new Map([
    ['loadManagedEvidenceDefinition', `the org's ONE managed evidence definition, keyed on eq(reports.orgId, orgId) + type + portal_self_service; ${ORG_PIN}`],
  ])],
  ['src/services/portal/reportsSelfService.ts', new Map([
    ['provisionPortalReportDefinitions', 'portal definitions keyed on eq(reports.orgId, orgId) + portal_self_service; partner-owned rows are never portal-visible (spec §3.5)'],
    ['hardwareLifecycleConfigWithInheritance', `keyed on eq(reports.orgId, orgId) + type hardware_lifecycle; ${ORG_PIN}`],
    ['listPortalRuns', 'portalRunListPredicate keys on reports.org_id = <portal org> AND portal_self_service; partner-owned rows are never portal-visible (spec §3.5)'],
    ['generatePortalReport', 'portalDefinitionPredicate keys on reports.org_id = <portal org> AND portal_self_service'],
    ['latestPortalHardwareLifecycleRun', `keyed on eq(reports.orgId, orgId) + portal_self_service; ${ORG_PIN}`],
    ['completedRun', 'portalRunPredicate keys on reports.org_id = <portal org> AND portal_self_service'],
  ])],
  ['src/services/portal/serviceReadModel.ts', new Map([
    ['evidenceQuery', 'portal evidence join is `reports.org_id = service_deliverable_evidence.org_id` for the portal org — a NULL-org row cannot match'],
  ])],
  ['src/services/reportGenerationService.ts', new Map([
    ['previousBaselineFor', 'baseline for the definition being generated, keyed on report_id + the run\'s own scope fingerprint; the caller already authorized that definition (preflight)'],
  ])],
  ['src/services/reportNarrativeDelivery.ts', new Map([
    ['loadArtifact', 'delivers the org-owned AI narrative run by id in system context; report_run_deliveries rows exist only for narrative runs'],
  ])],
  ['src/services/reportRunDelivery.ts', new Map([
    ['claimDelivery', 'system-context delivery CAS by delivery id for the narrative delivery pass / reconciler; no caller-supplied visibility'],
    ['settleDelivery', 'system-context delivery settle by delivery id for the narrative delivery pass / reconciler; no caller-supplied visibility'],
    ['recordTransientGateFailure', 'system-context delivery update by delivery id for the narrative delivery pass; no caller-supplied visibility'],
    ['listPendingDeliveriesForRun', 'system-context read for the narrative delivery pass over ONE run it is delivering; nothing is shown to a caller'],
    ['listUnsettledDeliveries', 'system-context reconciler scan; the reconciler settles partner-owned runs as failed and shows nothing to a caller'],
    ['query', 'summarizeDeliveries\' count query: keyed on a run id its caller already authorized (aiAgents run detail pins the run to the agent run\'s org; the delivery pass runs in system context)'],
  ])],
  ['src/services/serviceDeliverableService.ts', new Map([
    ['validateReferences', `evidence linkage validates eq(reports.orgId, <deliverable org>) — ${ORG_PIN}`],
    ['insertEvidenceRef', `run evidence joins reports and pins eq(reports.orgId, orgId); ${ORG_PIN}`],
  ])],
  ['src/jobs/reportScheduleWorker.ts', new Map([
    ['findDueReports', 'system DB context due scan; nothing selected is shown to anyone — every due row is re-authorized per run (#3198 W01 Task 6)'],
    ['claimReportOccurrence', 'system DB context occurrence CAS by report id on a row findDueReports selected'],
    ['processRunScheduledReport', 'system DB context, reads by id, re-asserts live partner authority per row before generating (#3198 W01 Task 6); run updates target the run it inserted'],
  ])],
  ['src/jobs/reportRunDeliveryReconciler.ts', new Map([
    ['loadRunOwners', 'system reconciler maps narrative delivery runs to their owner by id; partner-owned runs are settled failed, never delivered (#3198 W01 Task 6)'],
  ])],
]);

/**
 * The only functions allowed to build a predicate on `reports.partnerId`. Each
 * is safe because it is reached only behind the partner-wide gate:
 *  - partnerOwnedReportVisibility: IS the gate (FALSE unless the caller may
 *    administer partner-wide state).
 *  - partnerWideListTarget: returns undefined unless the same gate passes.
 *  - reportOwnerCondition / reportOwnerScopePredicate: applied only to an owner
 *    that already passed resolveReportOwnerAuthority (canManage + live
 *    partner authority), ANDed after that gate.
 *  - systemPartnerWideListArm (#3198 W02, addendum B7): undefined unless
 *    auth.scope === 'system' (platform admin, who already sees every org);
 *    ORed onto the system list's unrestricted predicate only.
 *  - reportScheduleWorker completeExecutableScopePredicate / findDueReports
 *    (#3198 W01 Task 6): a SYSTEM-context due scan, not a caller-visibility
 *    predicate — `partner_id IS NOT NULL` admits a partner_wide row to the
 *    schedule and the coalesce join picks its timezone. Nothing selected is
 *    shown to anyone: every due row is re-authorized per run through
 *    resolveLivePartnerReportAuthority (org_access = 'all') before it executes.
 */
const PARTNER_ID_PREDICATE_SITES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['src/routes/reports/helpers.ts', new Set([
    'partnerOwnedReportVisibility',
    'partnerWideListTarget',
    'reportOwnerCondition',
    'reportOwnerScopePredicate',
    'systemPartnerWideListArm',
  ])],
  ['src/jobs/reportScheduleWorker.ts', new Set([
    'completeExecutableScopePredicate',
    'findDueReports',
  ])],
]);

// ---------------------------------------------------------------------------
// Textual analysis
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Source with comments blanked out (offsets preserved), so prose never counts as code. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

function code(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

/** Index of the bracket closing the one at `open`, or source.length. */
function matchClose(source: string, open: number): number {
  const opener = source[open]!;
  const closer = ({ '(': ')', '{': '}', '[': ']' } as Record<string, string>)[opener]!;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === opener) depth += 1;
    else if (source[i] === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/**
 * The `{` opening a function body, scanning from just past the parameter list.
 * Braces in a return type (`): { a: T } {`, `Promise<{ … }>`) follow a
 * type-position character and are skipped whole. -1 for a body-less overload.
 */
function functionBodyOpen(source: string, from: number): number {
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === ';') return -1;
    if (ch !== '{') continue;
    const prev = source.slice(from, i).trimEnd().slice(-1);
    if (prev !== '' && ':|&<,('.includes(prev)) {
      i = matchClose(source, i);
      continue;
    }
    return i;
  }
  return -1;
}

/** End of an arrow body starting after `=>`: a `{ … }` block or an expression. */
function arrowBodyEnd(source: string, from: number): number {
  let i = from;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  if (source[i] === '{') return matchClose(source, i);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) return i;
      depth -= 1;
    } else if ((ch === ';' || ch === ',') && depth === 0) return i;
  }
  return source.length;
}

interface Scope { name: string; start: number; end: number }

const PARAMS = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
const RETURN_TYPE = String.raw`(?:\s*:\s*[^=\n]+?)?`;

/** Every named scope in `source`, with its extent. */
function namedScopes(source: string): Scope[] {
  const scopes: Scope[] = [];

  const fnRe = /\bfunction\s*\*?\s*(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  for (let m = fnRe.exec(source); m; m = fnRe.exec(source)) {
    const paramsClose = matchClose(source, m.index + m[0].length - 1);
    const open = functionBodyOpen(source, paramsClose + 1);
    scopes.push({ name: m[1]!, start: m.index, end: open === -1 ? paramsClose : matchClose(source, open) });
  }

  const arrowDecl = new RegExp(
    String.raw`\b(?:const|let)\s+(\w+)(?:\s*:\s*[^=\n]+?)?\s*=\s*(?:async\s+)?(?:${PARAMS}${RETURN_TYPE}|\w+)\s*=>`,
    'g',
  );
  for (let m = arrowDecl.exec(source); m; m = arrowDecl.exec(source)) {
    scopes.push({ name: m[1]!, start: m.index, end: arrowBodyEnd(source, m.index + m[0].length) });
  }

  const propArrow = new RegExp(String.raw`(?<![\w?])(\w+)\s*:\s*(?:async\s+)?${PARAMS}${RETURN_TYPE}\s*=>`, 'g');
  for (let m = propArrow.exec(source); m; m = propArrow.exec(source)) {
    scopes.push({ name: m[1]!, start: m.index, end: arrowBodyEnd(source, m.index + m[0].length) });
  }

  const tool = /\bsafeHandler\(\s*'([\w-]+)'\s*,/g;
  for (let m = tool.exec(source); m; m = tool.exec(source)) {
    scopes.push({ name: `tool:${m[1]}`, start: m.index, end: matchClose(source, source.indexOf('(', m.index)) });
  }

  const route = /\b\w+Routes\.(get|post|put|patch|delete)\(\s*'([^']*)'/g;
  for (let m = route.exec(source); m; m = route.exec(source)) {
    scopes.push({
      name: `${m[1]!.toUpperCase()} ${m[2]}`,
      start: m.index,
      end: matchClose(source, source.indexOf('(', m.index)),
    });
  }
  return scopes;
}

function innermostScope(scopes: Scope[], index: number): Scope | null {
  let best: Scope | null = null;
  for (const s of scopes) {
    if (s.start <= index && index <= s.end && (!best || s.end - s.start < best.end - best.start)) best = s;
  }
  return best;
}

/** Name of the innermost named scope containing `index`, or null (module scope). */
function enclosingFunction(source: string, index: number): string | null {
  return innermostScope(namedScopes(source), index)?.name ?? null;
}

/** Source of the named scope `name` (first declared), or null. */
function scopeBody(source: string, name: string): string | null {
  const scope = namedScopes(source).find((s) => s.name === name);
  return scope ? source.slice(scope.start, scope.end + 1) : null;
}

const ENTRYPOINT_CALL = new RegExp(
  String.raw`(?<!function\s)\b(?:partnerOwnedReportVisibility|${GUARD_ENTRYPOINTS.map((e) => e.fn).join('|')})\(`,
);

/**
 * Offenders among the query sites of one file: sites whose innermost named
 * scope neither calls a guard nor is allowlisted for that scope.
 */
function siteOffenders(
  relPath: string,
  source: string,
  allowlist: ReadonlyMap<string, ReadonlyMap<string, string>> = SITE_ALLOWLIST,
): string[] {
  const scopes = namedScopes(source);
  const allowed = allowlist.get(relPath);
  const offenders: string[] = [];
  const re = new RegExp(QUERY_SITE_SOURCE, 'g');
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const scope = innermostScope(scopes, m.index);
    const body = scope ? source.slice(scope.start, scope.end + 1) : source;
    if (scope && ENTRYPOINT_CALL.test(body)) continue;
    if (scope && allowed?.has(scope.name)) continue;
    const line = source.slice(0, m.index).split('\n').length;
    offenders.push(`${relPath}:${line} (in ${scope?.name ?? 'module scope'}) ${m[0].replace(/\s+/g, '')} is neither guarded by partnerOwnedReportVisibility nor allowlisted for this scope`);
  }
  return offenders;
}

/** `reports.partnerId` occurrences that are predicates (not projections or types). */
function partnerIdPredicateSites(source: string): number[] {
  const hits: number[] = [];
  const re = /reports\.partnerId\b/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const before = source.slice(Math.max(0, m.index - 40), m.index);
    if (/(?<![\w])partnerId:\s*$/.test(before)) continue; // select projection
    if (/typeof\s+$/.test(before)) continue; // type position
    hits.push(m.index);
  }
  return hits;
}

const rel = (file: string) => file.slice(process.cwd().length + 1);

// ---------------------------------------------------------------------------
// The analyzer discriminates (synthetic sources)
// ---------------------------------------------------------------------------

describe('scan analyzer (#3198 W02 B1)', () => {
  it('matches reads, joins, mutations and relational queries on all three tables, not inserts', () => {
    for (const s of [
      '.from(reports)', '.innerJoin(reports, x)', 'db.update(reports)', 'tx.delete(reports)',
      'db.query.reports.findFirst', '.from(reportRuns)', 'tx.update(reportRuns)', 'tx.delete(reportRuns)',
      '.leftJoin(reportRunDeliveries, x)', 'tx.query.reportRunDeliveries.findMany', '.from(\n  reportRuns)',
    ]) {
      expect(QUERY_SITE.test(s), s).toBe(true);
    }
    for (const s of ['.insert(reports)', '.from(reportsSelfService)', '.from(reportScheduleRecipients)', 'reports.orgId']) {
      expect(QUERY_SITE.test(s), s).toBe(false);
    }
  });

  it('attributes arrows, property arrows, tool handlers and routes to their own name', () => {
    const src = [
      'function earlier() { return 1; }',
      'const later = async (tx: Tx): Promise<Row[]> => {',
      '  return tx.select().from(reports);',
      '};',
      'let thunk = () => db.select().from(reportRuns);',
      'const obj = { handler: async (input) => { return db.update(reports); } };',
      "registerTool({ handler: safeHandler('list_things', async (input, auth) => { return db.delete(reports); }) });",
      "xRoutes.get(\n  '/runs/:id',\n  mw,\n  async (c) => { await withCtx(async (tx) => tx.select().from(reportRunDeliveries)); },\n);",
      'function after(a: { b: string }): { c: number } { return db.select().from(reports); }',
    ].join('\n');
    const at = (needle: string) => enclosingFunction(src, src.indexOf(needle));
    expect(at('.from(reports);\n};')).toBe('later');
    expect(at('.from(reportRuns)')).toBe('thunk');
    expect(at('.update(reports)')).toBe('handler');
    expect(at('.delete(reports)')).toBe('tool:list_things');
    expect(at('.from(reportRunDeliveries)')).toBe('GET /runs/:id');
    expect(at('.from(reports); }')).toBe('after');
  });

  it('allowlists per scope: a guarded or allowlisted scope does not exempt a sibling', () => {
    const src = [
      'export async function guarded(auth) {',
      '  return db.select().from(reports).where(tenantAuthorizedReportCondition(id, auth));',
      '}',
      'export const listed = async () => db.select().from(reportRuns);',
      'export async function sibling(id) {',
      '  return db.select().from(reportRuns).where(eq(reportRuns.id, id));',
      '}',
    ].join('\n');
    const allow = new Map([['src/x.ts', new Map([['listed', 'reason long enough to count as one']])]]);
    const offenders = siteOffenders('src/x.ts', src, allow);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('(in sibling)');
    // …and the sibling passes once it goes through a guard entrypoint.
    expect(siteOffenders('src/x.ts', src.replace('eq(reportRuns.id, id)', 'tenantAuthorizedRunCondition(auth)'), allow)).toEqual([]);
  });

  it('a helper or entrypoint DECLARATION is not a call', () => {
    expect(HELPER_CALL.test('export function partnerOwnedReportVisibility(auth) {}')).toBe(false);
    expect(HELPER_CALL.test('or(x, partnerOwnedReportVisibility(auth))')).toBe(true);
    expect(ENTRYPOINT_CALL.test('async function loadLockedDefinition(tx) {}')).toBe(false);
    expect(ENTRYPOINT_CALL.test('await loadLockedDefinition(tx, id, auth, "write")')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

describe('partner-owned report visibility is mechanical (#3198 W01, per-site since W02)', () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it('finds query sites on every guarded table (guards against a vacuous scan)', () => {
    const all = files.map((f) => code(f)).join('\n');
    expect(files.filter((f) => QUERY_SITE.test(code(f))).length).toBeGreaterThan(15);
    for (const t of GUARDED_TABLES) {
      expect(new RegExp(String.raw`\.(?:from|innerJoin|update|delete)\(\s*${t}\b`).test(all), t).toBe(true);
    }
  });

  it('every guarded-table query site is in a guarded scope or allowlisted for that scope', () => {
    const offenders = files.flatMap((f) => siteOffenders(rel(f), code(f)));
    expect(offenders).toEqual([]);
  });

  it('every guard entrypoint reaches the helper', () => {
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const { file, fn, alias } of GUARD_ENTRYPOINTS) {
      const source = code(join(process.cwd(), file));
      if (alias) {
        if (!new RegExp(String.raw`export const ${fn}\s*=\s*${alias}\s*;`).test(source) || !seen.includes(alias)) {
          offenders.push(`${file}: ${fn} is not an alias of earlier entrypoint ${alias}`);
        }
      } else {
        const body = scopeBody(source, fn);
        const earlier = new RegExp(String.raw`(?<!function\s)\b(?:partnerOwnedReportVisibility${seen.map((s) => `|${s}`).join('')})\(`);
        if (!body) offenders.push(`${file}: ${fn} not found`);
        else if (!earlier.test(body)) offenders.push(`${file}: ${fn} reaches neither the helper nor an earlier entrypoint`);
      }
      seen.push(fn);
    }
    expect(offenders).toEqual([]);
  });

  it('each partner-scope tenant predicate calls the helper in its own body', () => {
    const offenders: string[] = [];
    for (const { file, fn } of MUST_CALL_HELPER) {
      const body = scopeBody(code(join(process.cwd(), file)), fn);
      if (!body) offenders.push(`${file}: ${fn} not found`);
      else if (!HELPER_CALL.test(body)) offenders.push(`${file}: ${fn} does not call partnerOwnedReportVisibility`);
    }
    expect(offenders).toEqual([]);
  });

  it('a raw reports.partnerId predicate appears only inside the gated helper functions', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of files) {
      const source = code(file);
      for (const index of partnerIdPredicateSites(source)) {
        found += 1;
        const fn = enclosingFunction(source, index);
        const allowed = PARTNER_ID_PREDICATE_SITES.get(rel(file));
        if (!allowed || !fn || !allowed.has(fn)) {
          const line = source.slice(0, index).split('\n').length;
          offenders.push(`${rel(file)}:${line} (in ${fn ?? 'module scope'}) builds a reports.partnerId predicate outside the gated helpers`);
        }
      }
    }
    expect(found).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry names a scope that still has an unguarded query site, with a reason', () => {
    const stale: string[] = [];
    for (const [file, scopes] of SITE_ALLOWLIST) {
      const source = code(join(process.cwd(), file));
      const live = new Set(siteOffenders(file, source, new Map()).map((o) => /\(in (.+?)\) /.exec(o)?.[1]));
      for (const [fn, reason] of scopes) {
        if (!live.has(fn)) stale.push(`${file}: ${fn}`);
        expect(reason.length, `${file}:${fn}`).toBeGreaterThan(20);
      }
    }
    expect(stale).toEqual([]);
    for (const [file, fns] of PARTNER_ID_PREDICATE_SITES) {
      const source = code(join(process.cwd(), file));
      for (const fn of fns) expect(scopeBody(source, fn), `${file}:${fn}`).not.toBeNull();
    }
  });
});
