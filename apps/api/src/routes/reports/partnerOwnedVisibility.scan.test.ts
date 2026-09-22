/**
 * #3198 W01 (spec 3.1a) — partner-owned report visibility is mechanical.
 *
 * `org_access = 'all'` has NO database backstop: `breeze_has_partner_access`
 * is flat partner membership, and `org_access` lives only in the app layer. A
 * 'selected' partner user's RLS context therefore sees partner-owned reports,
 * and is kept out of them purely by call-site discipline. That discipline is
 * one helper, `partnerOwnedReportVisibility` (routes/reports/helpers.ts), and
 * this scan: every `reports` query site under routes/, services/, jobs/ must
 * either call it or be allowlisted as org-only with a reason a reviewer would
 * accept.
 *
 * Textual, not semantic — it proves the author was made to think about the
 * partner axis, not that the call is placed correctly. The route suites
 * (`core.partnerOwned.test.ts`, `helpers.partnerOwned.test.ts`) assert the
 * behaviour.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/routes', 'src/services', 'src/jobs'].map((p) => join(process.cwd(), p));
const QUERY_SITE = /\.(from|innerJoin|leftJoin)\(\s*reports\b/;

/** Files whose every `reports` query is org-only BY DESIGN. Each entry needs a reason. */
const ORG_ONLY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  ['src/routes/reports/recipients.ts', 'schedule recipients are org contacts: every writer refuses a partner-owned definition (409 partner_owned_report) before its only reports query, which is keyed on the resolved non-null org_id; the definition itself is loaded through getReportWithOwnerCheck'],
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
  ['src/services/aiToolsFleet.ts', 'AI fleet/report tools are org-axis: every tenant predicate is reports.org_id (orgWhere / inArray(org_ids)); the system-scope by-id path gets an explicit owner guard in #3198 W01 Task 5b'],
  ['src/jobs/reportScheduleWorker.ts', 'system DB context, reads by id, re-asserts live partner authority per row before generating (#3198 W01 Task 6)'],
  ['src/jobs/reportRunDeliveryReconciler.ts', 'system reconciler maps narrative delivery runs to their org by id; partner-owned runs have no deliveries (#3198 W01 Task 6)'],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('partner-owned report visibility is mechanical (#3198 W01)', () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it('finds query sites (guards against a vacuous scan)', () => {
    const hits = files.filter((f) => QUERY_SITE.test(readFileSync(f, 'utf8')));
    expect(hits.length).toBeGreaterThan(5);
  });

  it('every reports query site either calls partnerOwnedReportVisibility or is allowlisted org-only', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!QUERY_SITE.test(text)) continue;
      const rel = file.slice(process.cwd().length + 1);
      if (ORG_ONLY_ALLOWLIST.has(rel)) continue;
      if (!/partnerOwnedReportVisibility\(/.test(text)) {
        offenders.push(`${rel} queries reports without partnerOwnedReportVisibility`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still exists, still queries reports, and carries a reason', () => {
    for (const [rel, reason] of ORG_ONLY_ALLOWLIST) {
      expect(QUERY_SITE.test(readFileSync(join(process.cwd(), rel), 'utf8')), rel).toBe(true);
      expect(reason.length, rel).toBeGreaterThan(20);
    }
  });
});
