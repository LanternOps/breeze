/**
 * #3198 W01 (spec 3.1a) — partner-owned report visibility is mechanical.
 *
 * `org_access = 'all'` has NO database backstop: `breeze_has_partner_access`
 * is flat partner membership, and `org_access` lives only in the app layer. A
 * 'selected' partner user's RLS context therefore sees partner-owned reports,
 * and is kept out of them purely by call-site discipline. That discipline is
 * one helper module (routes/reports/helpers.ts) and this scan, which checks
 * three things:
 *
 *  1. Every file under routes/, services/, jobs/ that queries `reports` CALLS
 *     `partnerOwnedReportVisibility` (the helper's own declaration does not
 *     count) or is allowlisted as org-only with a reason.
 *  2. The partner-scope tenant predicates themselves — the functions every
 *     by-id read and list goes through — each call it. A per-file check alone
 *     would let one call exempt every other query in the file.
 *  3. A raw `reports.partnerId` PREDICATE appears only inside the gated helper
 *     functions listed in PARTNER_ID_PREDICATE_SITES. Projections
 *     (`partnerId: reports.partnerId` in a select object) and the
 *     `typeof reports.partnerId` type are not predicates and are excluded.
 *
 * Textual, not semantic — the route suites (`core.partnerOwned.test.ts`,
 * `helpers.partnerOwned.test.ts`) assert the behaviour.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/routes', 'src/services', 'src/jobs'].map((p) => join(process.cwd(), p));
const QUERY_SITE = /\.(from|innerJoin|leftJoin)\(\s*reports\b/;
const HELPER_CALL = /(?<!function\s)\bpartnerOwnedReportVisibility\(/;

/** Files whose every `reports` query is org-only BY DESIGN. Each entry needs a reason. */
const ORG_ONLY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['src/routes/reports/recipients.ts', 'schedule recipients are org contacts: every writer refuses a partner-owned definition (409 partner_owned_report) before its only reports query, which is keyed on the resolved non-null org_id; the definition itself is loaded through the owner-aware getReportWithOrgCheck'],
  ['src/services/portal/reportsSelfService.ts', 'portal reads key on org_id + portal_self_service; partner-owned rows are never portal-visible (spec §3.5)'],
  ['src/services/portal/serviceReadModel.ts', 'portal evidence join is `reports.org_id = service_deliverable_evidence.org_id` for the portal org — a NULL-org row cannot match'],
  ['src/services/deliverableAutoEvidence.ts', 'managed evidence is org-owned by construction (#5784); the definition read is `id AND org_id = <deliverable org>`'],
  ['src/services/serviceDeliverableService.ts', 'evidence linkage validates `reports.org_id = <deliverable org>` — a partner-owned row cannot be linked'],
  ['src/services/managedEvidenceDefinitions.ts', 'the org\'s ONE managed evidence definition, keyed on org_id + type + portal_self_service'],
  ['src/services/aiAgents/narrativeReport.ts', 'the weekly AI narrative is system-authored and org-owned; keyed on org_id + source schedule'],
  ['src/services/aiAgents/fleetDesignReport.ts', 'Fleet Design is system-authored and org-owned; every read keys on org_id / orgCondition(reports.org_id) + type ai_fleet_design'],
  ['src/services/fleetDesign/ledger.ts', 'Fleet Design ledger reads type ai_fleet_design under orgCondition(reports.org_id); a partner-owned row is never that type'],
  ['src/routes/fleetDesign.ts', 'lists type ai_fleet_design (system-authored, org-owned) under auth.orgCondition(reports.org_id)'],
  ['src/routes/aiAgents.ts', 'AI-agent run artifacts: `reports.org_id = run.org_id` AND auth.orgCondition(reports.org_id) — agent runs are org-scoped'],
  ['src/services/reportNarrativeDelivery.ts', 'delivers the org-owned AI narrative run by id in system context; report_run_deliveries rows exist only for narrative runs'],
  ['src/services/aiToolsFleet.ts', 'AI fleet/report tools are org-axis: every tenant predicate is reports.org_id (orgWhere / inArray(org_ids)), and by-id reads go through aiReportDefinitionAccess / aiReportRunAccess, which refuse a partner-owned row via requireOrgOwnedReportRow (#3198 W01 Task 5b owner guard)'],
  ['src/jobs/reportScheduleWorker.ts', 'system DB context, reads by id, re-asserts live partner authority per row before generating (#3198 W01 Task 6)'],
  ['src/jobs/reportRunDeliveryReconciler.ts', 'system reconciler maps narrative delivery runs to their org by id; partner-owned runs have no deliveries (#3198 W01 Task 6)'],
]);

/**
 * The partner-scope tenant predicates. Each must call the helper: these are
 * what every by-id definition read, by-id run read, and definition list goes
 * through. (The GET /runs list handler is anonymous; it has its own case.)
 */
const MUST_CALL_HELPER: ReadonlyArray<{ file: string; fn: string }> = [
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedReportCondition' },
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedRunCondition' },
  { file: 'src/routes/reports/core.ts', fn: 'resolveDefinitionListScope' },
];

/**
 * The only functions allowed to build a predicate on `reports.partnerId`. Each
 * is safe because it is reached only behind the partner-wide gate:
 *  - partnerOwnedReportVisibility: IS the gate (FALSE unless the caller may
 *    administer partner-wide state).
 *  - partnerWideListTarget: returns undefined unless the same gate passes.
 *  - reportOwnerCondition / reportOwnerScopePredicate: applied only to an owner
 *    that already passed resolveReportOwnerAuthority (canManage + live
 *    partner authority), ANDed after that gate.
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
  ])],
  ['src/jobs/reportScheduleWorker.ts', new Set([
    'completeExecutableScopePredicate',
    'findDueReports',
  ])],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Source with comments blanked out (offsets preserved), so prose never counts as code. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

/** The `{ … }` body of `function <name>(…)` in `source`, or null. */
function functionBody(source: string, name: string): string | null {
  const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  let i = source.indexOf('(', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const open = source.indexOf('{', i);
  depth = 0;
  for (let j = open; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, j + 1);
    }
  }
  return null;
}

/** Name of the nearest `function <name>(` declared before `index`. */
function enclosingFunction(source: string, index: number): string | null {
  const re = /function\s+(\w+)\s*\(/g;
  let name: string | null = null;
  for (let m = re.exec(source); m && m.index < index; m = re.exec(source)) name = m[1]!;
  return name;
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

describe('partner-owned report visibility is mechanical (#3198 W01)', () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it('finds query sites (guards against a vacuous scan)', () => {
    const hits = files.filter((f) => QUERY_SITE.test(code(f)));
    expect(hits.length).toBeGreaterThan(5);
  });

  it('the helper declaration itself does not count as a call', () => {
    expect(HELPER_CALL.test('export function partnerOwnedReportVisibility(auth) {}')).toBe(false);
    expect(HELPER_CALL.test('or(x, partnerOwnedReportVisibility(auth))')).toBe(true);
  });

  it('every reports query site either calls partnerOwnedReportVisibility or is allowlisted org-only', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = code(file);
      if (!QUERY_SITE.test(text)) continue;
      if (ORG_ONLY_ALLOWLIST.has(rel(file))) continue;
      if (!HELPER_CALL.test(text)) {
        offenders.push(`${rel(file)} queries reports without calling partnerOwnedReportVisibility`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('each partner-scope tenant predicate calls the helper in its own body', () => {
    const offenders: string[] = [];
    for (const { file, fn } of MUST_CALL_HELPER) {
      const body = functionBody(code(join(process.cwd(), file)), fn);
      if (!body) offenders.push(`${file}: function ${fn} not found`);
      else if (!HELPER_CALL.test(body)) offenders.push(`${file}: ${fn} does not call partnerOwnedReportVisibility`);
    }
    expect(offenders).toEqual([]);
  });

  it('the GET /runs list handler calls the helper in its own block', () => {
    const source = code(join(process.cwd(), 'src/routes/reports/runs.ts'));
    const start = source.indexOf("'/runs',");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('runsRoutes.', start);
    expect(HELPER_CALL.test(source.slice(start, end === -1 ? undefined : end))).toBe(true);
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

  it('every allowlist entry still exists, still queries reports, and carries a reason', () => {
    for (const [file, reason] of ORG_ONLY_ALLOWLIST) {
      expect(QUERY_SITE.test(code(join(process.cwd(), file))), file).toBe(true);
      expect(reason.length, file).toBeGreaterThan(20);
    }
    for (const [file, fns] of PARTNER_ID_PREDICATE_SITES) {
      const source = code(join(process.cwd(), file));
      for (const fn of fns) expect(functionBody(source, fn), `${file}:${fn}`).not.toBeNull();
    }
  });
});
