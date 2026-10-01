/**
 * Org merge × service-deliverable evidence (#7443).
 *
 * Both orgs own the canonical portal self-service definition of the same report
 * type (reports_portal_self_service_org_type_uniq), so the reports pass drops
 * the merged-away org's definition and re-homes its runs onto the survivor's.
 * Two things point at that doomed definition besides its runs:
 *
 *  - service_deliverable_evidence (report_id, report_run_id): a run cited as
 *    deliverable evidence. sd_evidence_report_run_fk (report_run_id, report_id)
 *    -> report_runs(id, report_id) used to be NOT DEFERRABLE, so moving the run
 *    aborted the whole merge with 23503. And sd_evidence_report_org_fk is
 *    ON DELETE CASCADE, so evidence still naming the dropped definition would
 *    be deleted silently instead.
 *  - service_deliverables.auto_evidence_report_id: the managed-evidence binding.
 *    Its FK is ON DELETE SET NULL, so a deliverable still naming the dropped
 *    definition would silently stop producing evidence.
 *
 * Driven through the real `executeOrgMerge` against a COMMITTED fixture: the
 * failure depends on the order the registry walk runs the reports pass and the
 * service_deliverable* repoints, which only the real engine reproduces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { executeOrgMerge } from '../../services/orgMerge';

function rows<T>(result: unknown): T[] {
  return result as T[];
}

describe('org merge — report runs cited as deliverable evidence (#7443)', () => {
  let priorDrain: string | undefined;

  beforeEach(() => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
  });

  afterEach(() => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  it('re-homes evidence and the auto-evidence binding with the runs instead of aborting or dropping them', async () => {
    const partner = randomUUID();
    const loser = randomUUID();
    const survivor = randomUUID();
    const actor = randomUUID();
    const suffix = loser.slice(0, 8);
    const actorEmail = `actor-${suffix}@x.test`;
    const reportL = randomUUID();
    const reportS = randomUUID();
    const runL = randomUUID();
    const runS = randomUUID();
    const deliverableL = randomUUID();
    const occurrenceL = randomUUID();
    const evidenceL = randomUUID();

    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        INSERT INTO partners (id, name, slug) VALUES (${partner}::uuid, 'Evidence merge MSP', ${`evidence-merge-${suffix}`})`);
      await db.execute(sql`
        INSERT INTO organizations (id, partner_id, name, slug, status, currency_code) VALUES
          (${loser}::uuid,    ${partner}::uuid, 'Loser Co',    ${`ev-loser-${suffix}`},    'active', 'USD'),
          (${survivor}::uuid, ${partner}::uuid, 'Survivor Co', ${`ev-survivor-${suffix}`}, 'active', 'USD')`);
      await db.execute(sql`
        INSERT INTO users (id, email, name, partner_id, org_id)
        VALUES (${actor}::uuid, ${actorEmail}, 'Actor', ${partner}::uuid, NULL)`);

      // The canonical portal self-service definition of one type, in both orgs.
      await db.execute(sql`
        INSERT INTO reports (id, org_id, name, type, portal_self_service) VALUES
          (${reportL}::uuid, ${loser}::uuid,    'Executive summary', 'executive_summary', true),
          (${reportS}::uuid, ${survivor}::uuid, 'Executive summary', 'executive_summary', true)`);
      await db.execute(sql`
        INSERT INTO report_runs (id, report_id, status) VALUES
          (${runL}::uuid, ${reportL}::uuid, 'completed'),
          (${runS}::uuid, ${reportS}::uuid, 'completed')`);

      // A loser deliverable bound to the loser's definition, with one delivered
      // occurrence that cites the loser's run as its evidence.
      await db.execute(sql`
        INSERT INTO service_deliverables
          (id, org_id, name, cadence, anchor_due_date, effective_from, auto_evidence_report_id)
        VALUES
          (${deliverableL}::uuid, ${loser}::uuid, 'Monthly executive summary', 'monthly',
           '2026-09-30', '2026-09-01', ${reportL}::uuid)`);
      await db.execute(sql`
        INSERT INTO service_deliverable_occurrences
          (id, org_id, deliverable_id, name_snapshot, period_start, period_end, due_at, original_due_at, status)
        VALUES
          (${occurrenceL}::uuid, ${loser}::uuid, ${deliverableL}::uuid, 'Monthly executive summary',
           '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-30', 'delivered')`);
      await db.execute(sql`
        INSERT INTO service_deliverable_evidence (id, org_id, occurrence_id, kind, report_id, report_run_id)
        VALUES (${evidenceL}::uuid, ${loser}::uuid, ${occurrenceL}::uuid, 'report_run', ${reportL}::uuid, ${runL}::uuid)`);
    });

    const result = await executeOrgMerge({
      loserOrgId: loser,
      survivorOrgId: survivor,
      partnerId: partner,
      performedBy: actor,
      performedByEmail: actorEmail,
    });
    expect(result.mergeEventId).toBeTruthy();

    const testDb = getTestDb();

    // The survivor's canonical definition is the only one left.
    const definitions = rows<{ id: string; org_id: string }>(await testDb.execute(sql`
      SELECT id, org_id FROM reports WHERE id IN (${reportL}::uuid, ${reportS}::uuid)`));
    expect(definitions).toEqual([{ id: reportS, org_id: survivor }]);

    // Both runs continue under the survivor's definition.
    const runs = rows<{ id: string; report_id: string }>(await testDb.execute(sql`
      SELECT id, report_id FROM report_runs WHERE id IN (${runL}::uuid, ${runS}::uuid) ORDER BY id`));
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.report_id === reportS)).toBe(true);

    // The evidence row survived, moved with its run, and is re-tenanted.
    const evidence = rows<{ id: string; org_id: string; occurrence_id: string; report_id: string; report_run_id: string }>(
      await testDb.execute(sql`
        SELECT id, org_id, occurrence_id, report_id, report_run_id
          FROM service_deliverable_evidence WHERE id = ${evidenceL}::uuid`),
    );
    expect(evidence).toEqual([{
      id: evidenceL,
      org_id: survivor,
      occurrence_id: occurrenceL,
      report_id: reportS,
      report_run_id: runL,
    }]);

    // The deliverable still auto-produces evidence, now from the survivor's definition.
    const deliverables = rows<{ org_id: string; auto_evidence_report_id: string | null }>(await testDb.execute(sql`
      SELECT org_id, auto_evidence_report_id FROM service_deliverables WHERE id = ${deliverableL}::uuid`));
    expect(deliverables).toEqual([{ org_id: survivor, auto_evidence_report_id: reportS }]);

    const occurrences = rows<{ org_id: string; status: string }>(await testDb.execute(sql`
      SELECT org_id, status FROM service_deliverable_occurrences WHERE id = ${occurrenceL}::uuid`));
    expect(occurrences).toEqual([{ org_id: survivor, status: 'delivered' }]);
  }, 120_000);
});
