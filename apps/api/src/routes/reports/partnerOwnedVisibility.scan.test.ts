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
 *     `reportRunDeliveries` under routes/, services/, jobs/ — `.from`, every
 *     join incl. `crossJoin` / `*JoinLateral`, `.update`, `.delete`,
 *     `db.$count`, `db.query.<table>`, `${table}` interpolated into a sql
 *     template, raw SQL inside template-literal text (`FROM|JOIN|UPDATE|
 *     USING|DELETE FROM|INSERT INTO|MERGE INTO|TRUNCATE [TABLE]` + the table,
 *     optionally `"public".`-qualified and/or quoted, plus comma joins
 *     `FROM a x, report_runs`), and `sql.identifier('<table>')` /
 *     `sql.raw('… FROM <table> …')` with a quoted-string argument — sits in a
 *     scope that calls `partnerOwnedReportVisibility` or
 *     one of the GUARD_ENTRYPOINTS (each proven here to reach the helper), or
 *     is allowlisted org-only / system-only for that one scope with a written
 *     reason AND a pinned site count (a new query in a broad allowlisted
 *     scope goes red). One guarded function no longer exempts its file.
 *  1b. No file re-binds a table symbol (aliased import/re-export,
 *     `const t = reportRuns`, destructure): the arms key on the names.
 *  2. The partner-scope tenant predicates each call the helper directly.
 *  3. A raw `reports.partnerId` PREDICATE appears only inside the gated helper
 *     functions listed in PARTNER_ID_PREDICATE_SITES.
 *
 * A scope is the innermost of: `function name(`, `const|let name = (…) =>`,
 * an object-property arrow `name: (…) =>`, an AI tool `safeHandler('tool', …)`
 * (`tool:<name>`), or a Hono registration `xRoutes.get('/path', …)`
 * (`GET /path`). Anonymous callbacks belong to their enclosing named scope.
 *
 * The template scanner skips regex literals (a backtick or quote inside
 * /…/ used to flip its state for the rest of the file) and the tree test
 * asserts every scanned file ends with a balanced template stack.
 *
 * NOT covered (textual limits): a table passed as a function argument and
 * queried through the parameter (`reportOwnerScopePredicate(reports, …)`);
 * SQL assembled from string concatenation, a table name held in a variable,
 * or `sql.raw(<non-literal>)`; a comma join whose earlier list item is not a
 * bare name/alias (`FROM (SELECT …) x, report_runs`, `… JOIN b ON …, reports`);
 * a regex literal the heuristic misreads as division (after `)`, e.g.
 * `if (x) /re/.test(y)`) — or any regex misdetection confined to one line
 * that swallows an EVEN number of backticks: the stack ends balanced, so the
 * EOF balance guard does not catch it, though the template ranges in between
 * are wrong; and code outside the three roots. Those rely on
 * review, the route suites and RLS.
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
/** A table symbol, optionally through a namespace import (`schema.reportRuns`). */
const TABLE_REF = `(?:\\w+\\.)?(?:${TABLE_ALT})\\b`;
/**
 * A Drizzle read or mutation of a guarded table: `.from`, every join kind
 * (incl. `crossJoin` and the `*JoinLateral` forms), `.update`, `.delete`,
 * `db.$count(t…)`, the relational `db.query.<t>`, and a table interpolated
 * into a sql template (`${reportRuns}`). `.insert(t)` is excluded: it targets
 * no existing row, so it cannot reveal or alter a partner-owned one.
 */
const QUERY_SITE_SOURCE =
  `\\.(?:from|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin|innerJoinLateral|leftJoinLateral|crossJoinLateral|update|delete|\\$count)\\(\\s*${TABLE_REF}`
  + `|\\bquery\\.(?:${TABLE_ALT})\\b`
  + `|\\$\\{\\s*${TABLE_REF}\\s*\\}`;
/**
 * A raw-SQL reference to a guarded table, counted only inside the literal
 * text of a template string (so comments and ordinary strings never count).
 */
/** A guarded table name in SQL text: optional (quoted) `public.` schema, optional quotes. */
const RAW_TABLE = String.raw`(?:"?public"?\.)?"?(?:report_runs|report_run_deliveries|reports)"?(?![\w-])`;
/** The statement keywords that read or change rows of the table they precede. */
const RAW_KEYWORD = String.raw`(?:FROM|JOIN|UPDATE|USING|DELETE\s+FROM|INSERT\s+INTO|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)`;
const RAW_SQL_SITE = new RegExp(
  String.raw`\b${RAW_KEYWORD}\s+(?:ONLY\s+)?${RAW_TABLE}`
  // A comma join: `FROM devices d, report_runs rr` (each earlier list item is
  // a name, an optional alias, then a comma).
  + String.raw`|\bFROM\s+(?:[\w."]+(?:\s+(?:AS\s+)?\w+)?\s*,\s*)+${RAW_TABLE}`,
  'gi',
);
/**
 * Guarded-table SQL built OUTSIDE template text: `sql.identifier('report_runs')`
 * and `sql.raw('… FROM report_runs …')` with a quoted-string argument.
 */
const CODE_SQL_SITE = new RegExp(
  String.raw`\bsql\.identifier\(\s*['"](?:report_runs|report_run_deliveries|reports)['"]`
  + String.raw`|\bsql\.raw\(\s*(['"])[^'"\n]*?\b${RAW_KEYWORD}\s+(?:ONLY\s+)?${RAW_TABLE}`,
  'gi',
);
/**
 * Re-binding a table symbol hides every later query from the scan (the site
 * regexes key on the symbol name), so ANY rename is a hard failure: an
 * aliased import/re-export, `const t = reportRuns`, or a destructure.
 */
const TABLE_REBINDS: ReadonlyArray<RegExp> = [
  new RegExp(`\\b(?:import|export)\\s+(?:type\\s+)?\\{[^{}]*\\b(?:${TABLE_ALT})\\s+as\\s+\\w+`),
  new RegExp(`\\b(?:const|let|var)\\s+\\w+(?:\\s*:[^=;]+)?\\s*=\\s*${TABLE_REF}\\s*(?:[;,)\\n]|as\\b)`),
  new RegExp(`\\b(?:const|let|var)\\s*\\{[^{}]*\\b(?:${TABLE_ALT})\\b[^{}]*\\}\\s*=`),
];
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

/**
 * Ruling F1 (#3198 W02): the org-scope tenant predicates — the only places an
 * ORGANIZATION-scope caller's report/run reads are built — must each apply
 * `reportAudienceCondition` (reports.type NOT IN the msp_staff types) in their
 * own body. Every other guarded route site reaches one of these transitively:
 * getReportWithOwnerCheck, loadLockedDefinition and loadOrgOwnedDefinition go
 * through tenantAuthorizedReportCondition; getReportRunWithOwnerCheck through
 * tenantAuthorizedRunCondition (GUARD_ENTRYPOINTS proves each reaches its
 * helper). Allowlisted scopes answer the audience question per entry instead
 * (AllowEntry.audience).
 */
const MUST_CALL_AUDIENCE: ReadonlyArray<{ file: string; fn: string }> = [
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedReportCondition' },
  { file: 'src/routes/reports/helpers.ts', fn: 'tenantAuthorizedRunCondition' },
  { file: 'src/routes/reports/core.ts', fn: 'resolveDefinitionListScope' },
  { file: 'src/routes/reports/runs.ts', fn: 'GET /runs' },
  // The org-axis AI report tool builds its own org-scope reads (allowlisted
  // above for the partner-owned rule); each applies the exclusion itself.
  { file: 'src/services/aiToolsFleet.ts', fn: 'aiReportDefinitionAccess' },
  { file: 'src/services/aiToolsFleet.ts', fn: 'aiReportRunAccess' },
  { file: 'src/services/aiToolsFleet.ts', fn: 'tool:generate_report' },
];
const AUDIENCE_CALL = /(?<!function\s)\breportAudienceCondition\(/;

/**
 * Ruling P8b (#3198 W02 fix round): the per-type permission gate extends to
 * reads on EVERY scope. Every scope that applies the F1 audience exclusion is,
 * by construction, a report reader building its own tenant predicate — so it
 * must also apply the per-type permission filter: the SQL twin
 * `reportTypePermissionCondition`, or the by-id belt
 * `reportTypeHiddenByPermission` (the AI tool's lazy
 * `aiReportTypeHiddenByPermission` wraps it). Together with the mechanical
 * MUST_CALL_AUDIENCE rule, a new reader that forgets it goes red.
 */
const TYPE_PERMISSION_CALL = /(?<!function\s)\b(?:reportTypePermissionCondition|reportTypeHiddenByPermission|aiReportTypeHiddenByPermission)\(/;

const ORG_PIN = 'a partner-owned row has org_id NULL and cannot match an org_id equality';

/**
 * Query sites that are org-only or system-only BY DESIGN, keyed per file AND
 * per scope. Each entry needs a reason. A new query in an allowlisted file but
 * a different scope is NOT covered.
 */
/** `sites` = exact count of unguarded query sites in that scope (pinned). */
const pinned = (sites: number, reason: string, audience = ''): AllowEntry => ({ sites, reason, audience });

/**
 * Ruling F1 (#3198 W02): why an org-scope caller cannot reach an msp_staff
 * (business) report through an allowlisted scope. Every allowlist entry names
 * one — a new entry has to answer the audience question, not only the
 * partner-owned one.
 */
const AUD_SYSTEM = 'system context only; nothing selected is returned to an org-scope caller';
const AUD_WORKER = 'system context; org-owned msp_staff rows are re-checked on the PARTNER axis only (resolveLiveReportTypePermissions partnerAxisOnly)';
const AUD_TYPE_PINNED = 'pinned to a system-authored or managed-evidence type whose registry audience is any';
const AUD_PORTAL = 'portal definitions are never business types (reportRegistry.test pins BUSINESS ∉ portal definitions)';
const AUD_AI_TOOL = 'org-axis AI report tool: the metadata reads and the list apply reportAudienceCondition (MUST_CALL_AUDIENCE)';
const AUD_AI_AGENT_ARTIFACT = 'reads only narrative / fleet-design scalars of the run an AI agent linked; reportRunId is set only by those persisters';
const AUD_EVIDENCE_REFUSES = 'deliverable evidence refuses msp_staff definitions/runs before any link, attach or run (ruling F1)';
const AUD_EVIDENCE_LINKED = 'reaches report_runs only through deliverable evidence, which can never reference an msp_staff run (ruling F1)';
const AUD_CALLER_AUTHORIZED = 'keyed on a definition its caller already authorized, audience included';

const SITE_ALLOWLIST: SiteAllowlist = new Map<string, Map<string, AllowEntry>>([
  ['src/routes/aiAgents.ts', new Map([
    ['GET /runs/:runId', pinned(4, `AI-agent run artifact reads join reports and pin eq(reports.orgId, run.orgId) AND auth.orgCondition(reports.orgId); ${ORG_PIN}`, AUD_AI_AGENT_ARTIFACT)],
  ])],
  ['src/routes/fleetDesign.ts', new Map([
    ['GET /', pinned(2, 'lists type ai_fleet_design (system-authored, org-owned) under auth.orgCondition(reports.orgId)', AUD_TYPE_PINNED)],
  ])],
  ['src/services/aiAgents/fleetDesignReport.ts', new Map([
    ['persistFleetDesignReport', pinned(3, `Fleet Design is system-authored and org-owned: definition read/update keyed on eq(reports.orgId, run.orgId); the run update targets the artifact row it just inserted; ${ORG_PIN}`, AUD_TYPE_PINNED)],
    ['loadFleetDesignReport', pinned(2, 'by-id run read joined to reports with type ai_fleet_design AND orgCondition(reports.orgId); a partner-owned row is never that type', AUD_TYPE_PINNED)],
  ])],
  ['src/services/aiAgents/narrativeReport.ts', new Map([
    ['persistNarrativeReport', pinned(3, 'the weekly AI narrative is system-authored and org-owned; keyed on eq(reports.orgId, run.orgId) + source schedule; the run update targets the artifact it just inserted', AUD_TYPE_PINNED)],
  ])],
  ['src/services/aiToolsFleet.ts', new Map([
    ['aiReportDefinitionAccess', pinned(2, 'refuses a partner-owned row via requireOrgOwnedReportRow before returning access (#3198 W01 Task 5b owner guard); predicates are reports.org_id', AUD_AI_TOOL)],
    ['aiReportRunAccess', pinned(2, 'refuses a partner-owned row via requireOrgOwnedReportRow before returning access (#3198 W01 Task 5b owner guard); predicates are reports.org_id', AUD_AI_TOOL)],
    ['tool:generate_report', pinned(8, 'AI report tool, org-axis: the list keys on reports.org_id (eq / inArray / org-axis scope predicates); update and delete pin eq(reports.orgId, existing.orgId) + access.predicate after aiReportDefinitionAccess; run reads pin reports.org_id after aiReportRunAccess. The generate-branch lastGeneratedAt update keys on reports.id ONLY — safe because that id is reportDef.id returned by aiReportDefinitionAccess, which refuses a partner-owned row (requireOrgOwnedReportRow)', AUD_AI_TOOL)],
  ])],
  ['src/services/deliverableAutoEvidence.ts', new Map([
    ['generateAutoEvidenceForOccurrence', pinned(1, `managed evidence is org-owned by construction (#5784): definition read is id AND org_id = <deliverable org>; ${ORG_PIN}`, AUD_EVIDENCE_REFUSES)],
    ['finishRun', pinned(1, 'generateAutoEvidenceForOccurrence\'s local: updates the run id runGenerator just inserted for the org-owned evidence definition', AUD_EVIDENCE_REFUSES)],
    ['runGenerator', pinned(1, 'generateAutoEvidenceForOccurrence\'s local: inserts a run for the org-owned evidence definition and updates only that run by id', AUD_EVIDENCE_REFUSES)],
  ])],
  ['src/services/evidenceBaseline.ts', new Map([
    ['previousOccurrenceBaselineFor', pinned(1, 'reaches report_runs only through service_deliverable_evidence of one org-owned deliverable (evidence linkage validates reports.org_id = <deliverable org>)', AUD_EVIDENCE_LINKED)],
  ])],
  ['src/services/fleetDesign/drift.ts', new Map([
    ['loadApprovedDesign', pinned(1, 'reads the run id taken from fleet_design_applied_items pinned to eq(orgId, orgId); applied items only reference org-owned ai_fleet_design runs', AUD_TYPE_PINNED)],
  ])],
  ['src/services/fleetDesign/ledger.ts', new Map([
    ['lockReportRun', pinned(2, 'Fleet Design ledger reads type ai_fleet_design under orgCondition(reports.org_id); a partner-owned row is never that type', AUD_TYPE_PINNED)],
  ])],
  ['src/services/managedEvidenceDefinitions.ts', new Map([
    ['loadManagedEvidenceDefinition', pinned(1, `the org's ONE managed evidence definition, keyed on eq(reports.orgId, orgId) + type + portal_self_service; ${ORG_PIN}`, AUD_TYPE_PINNED)],
  ])],
  ['src/services/portal/reportsSelfService.ts', new Map([
    ['provisionPortalReportDefinitions', pinned(1, 'portal definitions keyed on eq(reports.orgId, orgId) + portal_self_service; partner-owned rows are never portal-visible (spec §3.5)', AUD_PORTAL)],
    ['hardwareLifecycleConfigWithInheritance', pinned(1, `keyed on eq(reports.orgId, orgId) + type hardware_lifecycle; ${ORG_PIN}`, AUD_PORTAL)],
    ['listPortalRuns', pinned(4, 'portalRunListPredicate keys on reports.org_id = <portal org> AND portal_self_service; partner-owned rows are never portal-visible (spec §3.5)', AUD_PORTAL)],
    ['generatePortalReport', pinned(1, 'portalDefinitionPredicate keys on reports.org_id = <portal org> AND portal_self_service', AUD_PORTAL)],
    ['latestPortalHardwareLifecycleRun', pinned(2, `keyed on eq(reports.orgId, orgId) + portal_self_service; ${ORG_PIN}`, AUD_PORTAL)],
    ['completedRun', pinned(2, 'portalRunPredicate keys on reports.org_id = <portal org> AND portal_self_service', AUD_PORTAL)],
  ])],
  ['src/services/portal/serviceReadModel.ts', new Map([
    ['evidenceQuery', pinned(1, 'portal evidence join is `reports.org_id = service_deliverable_evidence.org_id` for the portal org — a NULL-org row cannot match', AUD_EVIDENCE_LINKED)],
  ])],
  ['src/services/reportGenerationService.ts', new Map([
    ['previousBaselineFor', pinned(1, 'baseline for the definition being generated, keyed on report_id + the run\'s own scope fingerprint; the caller already authorized that definition (preflight)', AUD_CALLER_AUTHORIZED)],
  ])],
  ['src/services/reportNarrativeDelivery.ts', new Map([
    ['loadArtifact', pinned(2, 'delivers the org-owned AI narrative run by id in system context; report_run_deliveries rows exist only for narrative runs', AUD_SYSTEM)],
  ])],
  ['src/services/reportRunDelivery.ts', new Map([
    ['claimDelivery', pinned(1, 'system-context delivery CAS by delivery id for the narrative delivery pass / reconciler; no caller-supplied visibility', AUD_SYSTEM)],
    ['settleDelivery', pinned(1, 'system-context delivery settle by delivery id for the narrative delivery pass / reconciler; no caller-supplied visibility', AUD_SYSTEM)],
    ['recordTransientGateFailure', pinned(1, 'system-context delivery update by delivery id for the narrative delivery pass; no caller-supplied visibility', AUD_SYSTEM)],
    ['listPendingDeliveriesForRun', pinned(1, 'system-context read for the narrative delivery pass over ONE run it is delivering; nothing is shown to a caller', AUD_SYSTEM)],
    ['listUnsettledDeliveries', pinned(1, 'system-context reconciler scan; the reconciler settles partner-owned runs as failed and shows nothing to a caller', AUD_SYSTEM)],
    ['query', pinned(1, 'summarizeDeliveries\' count query: keyed on a run id its caller already authorized (aiAgents run detail pins the run to the agent run\'s org; the delivery pass runs in system context)', AUD_SYSTEM)],
  ])],
  ['src/services/serviceDeliverableService.ts', new Map([
    ['validateReferences', pinned(1, `evidence linkage validates eq(reports.orgId, <deliverable org>) — ${ORG_PIN}`, AUD_EVIDENCE_REFUSES)],
    ['insertEvidenceRef', pinned(2, `run evidence joins reports and pins eq(reports.orgId, orgId); ${ORG_PIN}`, AUD_EVIDENCE_REFUSES)],
  ])],
  ['src/jobs/reportScheduleWorker.ts', new Map([
    ['findDueReports', pinned(2, 'system DB context due scan; nothing selected is shown to anyone — every due row is re-authorized per run (#3198 W01 Task 6)', AUD_WORKER)],
    ['claimReportOccurrence', pinned(1, 'system DB context occurrence CAS by report id on a row findDueReports selected', AUD_WORKER)],
    ['processRunScheduledReport', pinned(4, 'system DB context, reads by id, re-asserts live partner authority per row before generating (#3198 W01 Task 6); run updates target the run it inserted', AUD_WORKER)],
  ])],
  ['src/jobs/reportRunDeliveryReconciler.ts', new Map([
    ['loadRunOwners', pinned(2, 'system reconciler maps narrative delivery runs to their owner by id; partner-owned runs are settled failed, never delivered (#3198 W01 Task 6)', AUD_SYSTEM)],
  ])],
  // Raw-SQL sites (fix round 1): system-context tenant lifecycle, never a caller read.
  ['src/services/tenantCascade.ts', new Map([
    ['clearSql', pinned(2, 'org erasure pre-clear in system context: DELETE FROM report_runs WHERE report_id IN (SELECT id FROM reports WHERE org_id = <erased org>) — a partner-owned definition has org_id NULL and never matches; its runs go with the partner sweep via ON DELETE CASCADE', AUD_SYSTEM)],
  ])],
  ['src/services/orgMergeCustomExecutors.ts', new Map([
    ['rehomeReportChildrenThenDelete', pinned(8, 'org merge (platform admin, system context): every statement keys on t.org_id = <loser> and s.org_id = <survivor>; a partner-owned definition has org_id NULL and is never re-homed, deduplicated or deleted', AUD_SYSTEM)],
    ['reports', pinned(1, 'org merge preview counter: SELECT count(*) FROM reports t WHERE t.org_id = <loser> — a NULL-org partner-owned row never matches, and only a count is returned to the admin', AUD_SYSTEM)],
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
 * [start, end) ranges of template-literal TEXT (not the `${…}` expressions).
 * Runs on comment-stripped source. '…' / "…" strings are skipped and never
 * span a newline, which bounds the damage a quote inside a regex literal can
 * do.
 */
function templateTextRanges(source: string): Array<[number, number]> {
  return templateScan(source).ranges;
}

/**
 * If a regex literal starts at `start` (code context), the index of its last
 * character (closing `/` plus flags); else -1. A `/` opens a regex only where
 * an expression may begin — after an operator/punctuator or a keyword such as
 * `return` — never after an identifier, number or `)` / `]` (division). The
 * literal must close on the same line; `[...]` classes and `\` escapes are
 * honoured. Without this, a backtick or quote inside a regex (/[`$'"]/,
 * /`+/g, /"/g) flips the scanner's string/template state for the rest of the
 * file.
 */
function regexLiteralEnd(source: string, start: number): number {
  const next = source[start + 1];
  if (next === '/' || next === '*') return -1;
  let j = start - 1;
  while (j >= 0 && /\s/.test(source[j]!)) j -= 1;
  const prev = j >= 0 ? source[j]! : '';
  if (/[\w$)\]]/.test(prev)) {
    const word = /(\w+)$/.exec(source.slice(Math.max(0, j - 10), j + 1))?.[1];
    if (!word || !['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'yield', 'await', 'else'].includes(word)) {
      return -1;
    }
  }
  let inClass = false;
  for (let k = start + 1; k < source.length; k += 1) {
    const c = source[k]!;
    if (c === '\n') return -1;
    if (c === '\\') { k += 1; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') {
      let f = k + 1;
      while (f < source.length && /[a-z]/i.test(source[f]!)) f += 1;
      return f - 1;
    }
  }
  return -1;
}

/** `templateTextRanges` plus whether the context stack is empty at EOF. */
function templateScan(source: string): { ranges: Array<[number, number]>; balanced: boolean } {
  const ranges: Array<[number, number]> = [];
  // Stack of contexts: 'tpl' = inside template text; a number = inside a
  // `${…}` expression at that brace depth.
  const stack: Array<'tpl' | number> = [];
  let textStart = -1;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '`') { ranges.push([textStart, i]); stack.pop(); continue; }
      if (ch === '$' && source[i + 1] === '{') {
        ranges.push([textStart, i]);
        stack.push(0);
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      for (i += 1; i < source.length && source[i] !== ch && source[i] !== '\n'; i += 1) {
        if (source[i] === '\\') i += 1;
      }
      continue;
    }
    if (ch === '/') {
      const end = regexLiteralEnd(source, i);
      if (end !== -1) { i = end; continue; }
    }
    if (ch === '`') { stack.push('tpl'); textStart = i + 1; continue; }
    if (typeof top === 'number') {
      if (ch === '{') stack[stack.length - 1] = top + 1;
      else if (ch === '}') {
        if (top === 0) { stack.pop(); textStart = i + 1; } else stack[stack.length - 1] = top - 1;
      }
    }
  }
  return { ranges, balanced: stack.length === 0 };
}

/** Every guarded-table query site in `source`: Drizzle forms + raw SQL in template text. */
function querySiteMatches(source: string): Array<{ index: number; text: string }> {
  const hits: Array<{ index: number; text: string }> = [];
  const re = new RegExp(QUERY_SITE_SOURCE, 'g');
  for (let m = re.exec(source); m; m = re.exec(source)) hits.push({ index: m.index, text: m[0] });
  const ranges = templateTextRanges(source);
  const raw = new RegExp(RAW_SQL_SITE.source, 'gi');
  for (let m = raw.exec(source); m; m = raw.exec(source)) {
    const at = m.index;
    if (ranges.some(([a, b]) => at >= a && at < b)) hits.push({ index: at, text: `sql\`${m[0]}\`` });
  }
  const codeSql = new RegExp(CODE_SQL_SITE.source, 'gi');
  for (let m = codeSql.exec(source); m; m = codeSql.exec(source)) {
    if (!ranges.some(([a, b]) => m!.index >= a && m!.index < b)) hits.push({ index: m.index, text: m[0] });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** An allowlisted scope: its written reason and the exact number of unguarded sites it holds. */
interface AllowEntry {
  sites: number;
  reason: string;
  /** Ruling F1: why an org-scope caller cannot reach an msp_staff report here. */
  audience: string;
}
type SiteAllowlist = ReadonlyMap<string, ReadonlyMap<string, AllowEntry>>;

/**
 * Offenders among the query sites of one file: sites whose innermost named
 * scope neither calls a guard nor is allowlisted for that scope, plus
 * allowlisted scopes whose unguarded-site count no longer equals the pinned
 * `sites` (a new query inside a broad allowlisted scope must be reviewed).
 */
function siteOffenders(
  relPath: string,
  source: string,
  allowlist: SiteAllowlist = SITE_ALLOWLIST,
): string[] {
  const scopes = namedScopes(source);
  const allowed = allowlist.get(relPath);
  const counts = new Map<string, number>();
  const offenders: string[] = [];
  for (const { index, text } of querySiteMatches(source)) {
    const scope = innermostScope(scopes, index);
    const body = scope ? source.slice(scope.start, scope.end + 1) : source;
    if (scope && ENTRYPOINT_CALL.test(body)) continue;
    if (scope && allowed?.has(scope.name)) {
      counts.set(scope.name, (counts.get(scope.name) ?? 0) + 1);
      continue;
    }
    const line = source.slice(0, index).split('\n').length;
    offenders.push(`${relPath}:${line} (in ${scope?.name ?? 'module scope'}) ${text.replace(/\s+/g, ' ')} is neither guarded by partnerOwnedReportVisibility nor allowlisted for this scope`);
  }
  for (const [fn, entry] of allowed ?? []) {
    const found = counts.get(fn) ?? 0;
    if (found !== entry.sites) {
      offenders.push(`${relPath} (in ${fn}) has ${found} unguarded guarded-table sites; the allowlist pins ${entry.sites}`);
    }
  }
  return offenders;
}

/** Table re-bindings (aliased import, `const t = reportRuns`, destructure) in `source`. */
function rebindOffenders(relPath: string, source: string): string[] {
  const offenders: string[] = [];
  for (const re of TABLE_REBINDS) {
    const g = new RegExp(re.source, 'g');
    for (let m = g.exec(source); m; m = g.exec(source)) {
      const line = source.slice(0, m.index).split('\n').length;
      offenders.push(`${relPath}:${line} re-binds a guarded table symbol: ${m[0].replace(/\s+/g, ' ')}`);
    }
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
    const allow = new Map([['src/x.ts', new Map([['listed', pinned(1, 'reason long enough to count as one')]])]]);
    const offenders = siteOffenders('src/x.ts', src, allow);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('(in sibling)');
    // …and the sibling passes once it goes through a guard entrypoint.
    expect(siteOffenders('src/x.ts', src.replace('eq(reportRuns.id, id)', 'tenantAuthorizedRunCondition(auth)'), allow)).toEqual([]);
  });

  it('flags raw SQL, interpolated tables, $count, crossJoin and lateral joins (fix round 1)', () => {
    const cases: Record<string, string> = {
      rawFrom: 'export async function a() { return db.execute(sql`SELECT id FROM report_runs WHERE x = ${y}`); }',
      rawDelete: 'export async function a() { return db.execute(sql`\n  DELETE FROM reports WHERE id = ${id}`); }',
      rawQuoted: 'export async function a() { return db.execute(sql`UPDATE "report_run_deliveries" SET state = 1`); }',
      rawJoin: 'export async function a() { return db.execute(sql`SELECT 1 FROM x JOIN reports r ON r.id = x.id`); }',
      interpolated: 'export async function a() { return db.execute(sql`SELECT * FROM ${reportRuns} WHERE 1=1`); }',
      count: 'export async function a() { return db.$count(reportRuns, eq(reportRuns.reportId, id)); }',
      crossJoin: 'export async function a() { return db.select().from(x).crossJoin(reports); }',
      lateral: 'export async function a() { return db.select().from(x).leftJoinLateral(reportRunDeliveries, sql`true`); }',
      namespaced: 'export async function a() { return db.select().from(schema.reportRuns); }',
    };
    for (const [name, src] of Object.entries(cases)) {
      expect(siteOffenders('src/x.ts', src, new Map()), name).toHaveLength(1);
    }
    // Prose and non-SQL templates do not count.
    for (const src of [
      'export function a() { return `/api/reports/runs/${id}/download`; }',
      "export function a() { return 'rows from reports are listed'; }",
      'export function a() { return `${reportRuns.result}`; }',
    ]) {
      expect(siteOffenders('src/x.ts', src, new Map()), src).toEqual([]);
    }
  });

  it('pins the site count per allowlisted scope: a second query in a broad scope goes red (fix round 1)', () => {
    const one = 'export async function worker(id) {\n  return db.select().from(reports).where(eq(reports.id, id));\n}';
    const two = one.replace('return db', 'await db.update(reportRuns).set({});\n  return db');
    const allow = new Map([['src/x.ts', new Map([['worker', pinned(1, 'reason long enough to count as one')]])]]);
    expect(siteOffenders('src/x.ts', one, allow)).toEqual([]);
    expect(siteOffenders('src/x.ts', two, allow)).toEqual([
      'src/x.ts (in worker) has 2 unguarded guarded-table sites; the allowlist pins 1',
    ]);
  });

  it('flags schema-quoted, comma-joined, TRUNCATE/MERGE and sql.identifier / sql.raw forms (Task 15)', () => {
    const cases: Record<string, string> = {
      quotedSchema: 'export async function a() { return db.execute(sql`SELECT 1 FROM "public"."report_runs" r`); }',
      quotedSchemaJoin: 'export async function a() { return db.execute(sql`SELECT 1 FROM x JOIN "public".reports r ON true`); }',
      commaJoin: 'export async function a() { return db.execute(sql`SELECT 1 FROM devices d, report_runs rr WHERE d.id = rr.id`); }',
      commaJoinAliased: 'export async function a() { return db.execute(sql`SELECT 1 FROM devices AS d, public.reports r`); }',
      truncate: 'export async function a() { return db.execute(sql`TRUNCATE TABLE report_run_deliveries`); }',
      truncateBare: 'export async function a() { return db.execute(sql`TRUNCATE reports CASCADE`); }',
      merge: 'export async function a() { return db.execute(sql`MERGE INTO report_runs t USING x ON true`); }',
      identifier: "export async function a() { return db.execute(sql`SELECT 1 FROM ${sql.identifier('report_runs')}`); }",
      raw: "export async function a() { return db.execute(sql.raw('DELETE FROM report_run_deliveries WHERE true')); }",
    };
    for (const [name, src] of Object.entries(cases)) {
      expect(siteOffenders('src/x.ts', src, new Map()), name).toHaveLength(1);
    }
    for (const src of [
      'export function a() { return `Loaded devices, reports and alerts`; }',
      "export function a() { return 'reports, runs'; }",
      'export function a() { return `Choose from: runs, reports`; }',
    ]) {
      expect(siteOffenders('src/x.ts', src, new Map()), src).toEqual([]);
    }
  });

  it('template scanning survives regex literals holding backticks or quotes, and reports an unbalanced EOF (Task 15)', () => {
    const withRegex = [
      'const SHELL_META = /[;&|><`$\'"]/;',
      "const strip = (s) => s.replace(/`+/g, '').replace(/\"/g, '\\\"');",
      'const q = `${x.replace(/"/g, "")}`;',
      'export async function a() { return db.execute(sql`DELETE FROM reports WHERE id = ${id}`); }',
    ].join('\n');
    expect(templateScan(withRegex).balanced).toBe(true);
    expect(siteOffenders('src/x.ts', withRegex, new Map())).toHaveLength(1);
    // Division is not a regex.
    expect(templateScan('const r = a / b / c; const t = `x`;').balanced).toBe(true);
    expect(templateScan('const t = `never closed;').balanced).toBe(false);
  });

  it('hard-fails any re-binding of a table symbol (fix round 1)', () => {
    for (const src of [
      "import { reportRuns as runs } from '../db/schema';",
      "import {\n  reports,\n  reportRunDeliveries as deliveries,\n} from '../db/schema';",
      "export { reports as reportDefinitions } from '../db/schema';",
      'const t = reportRuns;',
      'const t: typeof reports = reports;',
      'const t = schema.reportRunDeliveries;',
      'const { reportRuns: runs } = schema;',
      'let { reports } = schema;',
    ]) {
      expect(rebindOffenders('src/x.ts', src), src).toHaveLength(1);
    }
    for (const src of [
      "import { reportRuns, reports } from '../db/schema';",
      'const id = reports.id;',
      'const rows = await db.select().from(reports);',
      'const total = reportRuns.length > 0 ? 1 : 0;',
    ]) {
      expect(rebindOffenders('src/x.ts', src), src).toEqual([]);
    }
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

  it('no file re-binds a guarded table symbol (the scan keys on the symbol names)', () => {
    expect(files.flatMap((f) => rebindOffenders(rel(f), code(f)))).toEqual([]);
  });

  // An unbalanced stack at EOF means the scanner lost track of which text is
  // template SQL — raw-SQL sites after that point are misread. Asserted for
  // EVERY scanned file (stronger than only those naming a guarded table): a
  // file that gains a report query later must not inherit a broken state.
  // Before Task 15 the regex-literal gap left softwareActions.ts, docs.ts and
  // aiAgents/runFindings.ts unbalanced.
  it('template scanning ends balanced in every scanned file (Task 15)', () => {
    const unbalanced = files
      .filter((f) => !templateScan(code(f)).balanced)
      .map(rel);
    expect(unbalanced).toEqual([]);
  });

  it('finds raw-SQL sites in template text (guards against a vacuous raw arm)', () => {
    const raw = files.flatMap((f) => querySiteMatches(code(f)).filter((h) => h.text.startsWith('sql`')).map(() => rel(f)));
    expect(new Set(raw)).toEqual(new Set(['src/services/tenantCascade.ts', 'src/services/orgMergeCustomExecutors.ts']));
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

  it('each org-scope tenant predicate applies the msp_staff audience exclusion (ruling F1)', () => {
    const offenders: string[] = [];
    for (const { file, fn } of MUST_CALL_AUDIENCE) {
      const body = scopeBody(code(join(process.cwd(), file)), fn);
      if (!body) offenders.push(`${file}: ${fn} not found`);
      else if (!AUDIENCE_CALL.test(body)) offenders.push(`${file}: ${fn} does not call reportAudienceCondition`);
    }
    expect(offenders).toEqual([]);
  });

  // Fix round 1: MUST_CALL_AUDIENCE is mechanical, not a hand-kept list. A
  // direct partnerOwnedReportVisibility caller is, by construction, a tenant
  // predicate that also builds an org branch; if it is not listed (and so not
  // required to call reportAudienceCondition) a new one could hand org-scope
  // callers msp_staff rows without going red.
  it('every direct partnerOwnedReportVisibility caller is listed in MUST_CALL_AUDIENCE (ruling F1)', () => {
    const listed = new Set(MUST_CALL_AUDIENCE.map(({ file, fn }) => `${file}#${fn}`));
    const unlisted: string[] = [];
    let callers = 0;
    for (const file of files) {
      const source = code(file);
      const scopes = namedScopes(source);
      const re = new RegExp(HELPER_CALL.source, 'g');
      for (let m = re.exec(source); m; m = re.exec(source)) {
        callers += 1;
        const key = `${rel(file)}#${innermostScope(scopes, m.index)?.name ?? 'module scope'}`;
        if (!listed.has(key)) unlisted.push(key);
      }
    }
    expect(callers).toBeGreaterThanOrEqual(4);
    expect(unlisted).toEqual([]);
  });

  it('every scope applying reportAudienceCondition also applies the per-type permission filter (ruling P8b)', () => {
    const offenders: string[] = [];
    let callers = 0;
    for (const file of files) {
      const source = code(file);
      const scopes = namedScopes(source);
      const re = new RegExp(AUDIENCE_CALL.source, 'g');
      for (let m = re.exec(source); m; m = re.exec(source)) {
        callers += 1;
        const scope = innermostScope(scopes, m.index);
        const body = scope ? source.slice(scope.start, scope.end + 1) : source;
        if (!TYPE_PERMISSION_CALL.test(body)) {
          offenders.push(`${rel(file)}#${scope?.name ?? 'module scope'} applies reportAudienceCondition without reportTypePermissionCondition / reportTypeHiddenByPermission`);
        }
      }
    }
    // helpers.ts (2), core.ts resolveDefinitionListScope, runs.ts GET /runs,
    // aiToolsFleet.ts (3): a drop means the scan stopped seeing them.
    expect(callers).toBeGreaterThanOrEqual(7);
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
      for (const [fn, { reason, sites, audience }] of scopes) {
        if (!live.has(fn)) stale.push(`${file}: ${fn}`);
        expect(reason.length, `${file}:${fn}`).toBeGreaterThan(20);
        expect(audience.length, `${file}:${fn} audience (ruling F1)`).toBeGreaterThan(20);
        expect(sites, `${file}:${fn}`).toBeGreaterThan(0);
      }
    }
    expect(stale).toEqual([]);
    for (const [file, fns] of PARTNER_ID_PREDICATE_SITES) {
      const source = code(join(process.cwd(), file));
      for (const fn of fns) expect(scopeBody(source, fn), `${file}:${fn}`).not.toBeNull();
    }
  });
});
