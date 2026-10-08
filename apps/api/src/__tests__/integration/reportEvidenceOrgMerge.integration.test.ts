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
    // Controls: a loser definition with NO survivor twin (an ordinary report of
    // the same type — the portal pass only matches flagged definitions on both
    // sides) and the survivor's own evidence. Neither may be re-pointed.
    const reportOnlyL = randomUUID();
    const runOnlyL = randomUUID();
    const deliverableOnlyL = randomUUID();
    const occurrenceOnlyL = randomUUID();
    const evidenceOnlyL = randomUUID();
    const deliverableS = randomUUID();
    const occurrenceS = randomUUID();
    const evidenceS = randomUUID();
    // #4247: a partner-owned definition of the same partner, with a run. An org
    // merge must never touch it (org_id NULL is never `= loser`).
    const reportPartner = randomUUID();
    const runPartner = randomUUID();

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
        INSERT INTO reports (id, org_id, name, type, portal_self_service)
        VALUES (${reportOnlyL}::uuid, ${loser}::uuid, 'Board pack', 'executive_summary', false)`);
      await db.execute(sql`
        INSERT INTO reports (id, org_id, partner_id, name, type)
        VALUES (${reportPartner}::uuid, NULL, ${partner}::uuid, 'Partner aging', 'ar_aging')`);
      await db.execute(sql`
        INSERT INTO report_runs (id, report_id, partner_id, status)
        VALUES (${runPartner}::uuid, ${reportPartner}::uuid, ${partner}::uuid, 'completed')`);
      // Owner columns are filled from the parent by report_runs_fill_owner.
      await db.execute(sql`
        INSERT INTO report_runs (id, report_id, status) VALUES
          (${runL}::uuid, ${reportL}::uuid, 'completed'),
          (${runS}::uuid, ${reportS}::uuid, 'completed'),
          (${runOnlyL}::uuid, ${reportOnlyL}::uuid, 'completed')`);

      // Each deliverable is bound to a definition and has one delivered
      // occurrence citing that definition's run as its evidence. deliverableL
      // is the case under test: bound to the loser's colliding definition.
      await db.execute(sql`
        INSERT INTO service_deliverables
          (id, org_id, name, cadence, anchor_due_date, effective_from, auto_evidence_report_id)
        VALUES
          (${deliverableL}::uuid,     ${loser}::uuid,    'Monthly executive summary', 'monthly', '2026-09-30', '2026-09-01', ${reportL}::uuid),
          (${deliverableOnlyL}::uuid, ${loser}::uuid,    'Monthly board pack',        'monthly', '2026-09-30', '2026-09-01', ${reportOnlyL}::uuid),
          (${deliverableS}::uuid,     ${survivor}::uuid, 'Survivor summary',          'monthly', '2026-09-30', '2026-09-01', ${reportS}::uuid)`);
      await db.execute(sql`
        INSERT INTO service_deliverable_occurrences
          (id, org_id, deliverable_id, name_snapshot, period_start, period_end, due_at, original_due_at, status)
        VALUES
          (${occurrenceL}::uuid,     ${loser}::uuid,    ${deliverableL}::uuid,     'Monthly executive summary', '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-30', 'delivered'),
          (${occurrenceOnlyL}::uuid, ${loser}::uuid,    ${deliverableOnlyL}::uuid, 'Monthly board pack',        '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-30', 'delivered'),
          (${occurrenceS}::uuid,     ${survivor}::uuid, ${deliverableS}::uuid,     'Survivor summary',          '2026-09-01', '2026-09-30', '2026-09-30', '2026-09-30', 'delivered')`);
      await db.execute(sql`
        INSERT INTO service_deliverable_evidence (id, org_id, occurrence_id, kind, report_id, report_run_id) VALUES
          (${evidenceL}::uuid,     ${loser}::uuid,    ${occurrenceL}::uuid,     'report_run', ${reportL}::uuid,     ${runL}::uuid),
          (${evidenceOnlyL}::uuid, ${loser}::uuid,    ${occurrenceOnlyL}::uuid, 'report_run', ${reportOnlyL}::uuid, ${runOnlyL}::uuid),
          (${evidenceS}::uuid,     ${survivor}::uuid, ${occurrenceS}::uuid,     'report_run', ${reportS}::uuid,     ${runS}::uuid)`);
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

    // The loser's colliding portal definition is gone; the survivor's and the
    // loser's twin-less ordinary definition both remain, under the survivor.
    const definitions = rows<{ id: string; org_id: string }>(await testDb.execute(sql`
      SELECT id, org_id FROM reports
       WHERE id IN (${reportL}::uuid, ${reportS}::uuid, ${reportOnlyL}::uuid) ORDER BY id`));
    expect(definitions).toEqual(
      [{ id: reportS, org_id: survivor }, { id: reportOnlyL, org_id: survivor }].sort((a, b) => a.id.localeCompare(b.id)),
    );

    // Runs of the colliding definition continue under the survivor's; the
    // twin-less definition keeps its own run.
    const runs = rows<{ id: string; report_id: string }>(await testDb.execute(sql`
      SELECT id, report_id FROM report_runs
       WHERE id IN (${runL}::uuid, ${runS}::uuid, ${runOnlyL}::uuid)`));
    expect(new Map(runs.map((r) => [r.id, r.report_id]))).toEqual(
      new Map([[runL, reportS], [runS, reportS], [runOnlyL, reportOnlyL]]),
    );

    // #4247: every run's owner followed its (re-homed or repointed) parent —
    // runL via the reports executor's re-home, runOnlyL via the report_runs
    // repoint — and the partner-owned run was left alone.
    const owners = rows<{ id: string; org_id: string | null; partner_id: string | null }>(await testDb.execute(sql`
      SELECT id, org_id, partner_id FROM report_runs
       WHERE id IN (${runL}::uuid, ${runS}::uuid, ${runOnlyL}::uuid, ${runPartner}::uuid)`));
    expect(new Map(owners.map((r) => [r.id, [r.org_id, r.partner_id]]))).toEqual(new Map([
      [runL, [survivor, null]],
      [runS, [survivor, null]],
      [runOnlyL, [survivor, null]],
      [runPartner, [null, partner]],
    ]));

    // Every evidence row survived and is under the survivor. Only the one
    // citing the dropped definition's run was re-pointed.
    const evidence = rows<{ id: string; org_id: string; occurrence_id: string; report_id: string; report_run_id: string }>(
      await testDb.execute(sql`
        SELECT id, org_id, occurrence_id, report_id, report_run_id
          FROM service_deliverable_evidence
         WHERE id IN (${evidenceL}::uuid, ${evidenceOnlyL}::uuid, ${evidenceS}::uuid)`),
    );
    expect(new Map(evidence.map((e) => [e.id, e]))).toEqual(new Map([
      [evidenceL, { id: evidenceL, org_id: survivor, occurrence_id: occurrenceL, report_id: reportS, report_run_id: runL }],
      [evidenceOnlyL, {
        id: evidenceOnlyL, org_id: survivor, occurrence_id: occurrenceOnlyL, report_id: reportOnlyL, report_run_id: runOnlyL,
      }],
      [evidenceS, { id: evidenceS, org_id: survivor, occurrence_id: occurrenceS, report_id: reportS, report_run_id: runS }],
    ]));

    // deliverableL still auto-produces evidence, now from the survivor's
    // definition; the other bindings are unchanged.
    const deliverables = rows<{ id: string; org_id: string; auto_evidence_report_id: string | null }>(
      await testDb.execute(sql`
        SELECT id, org_id, auto_evidence_report_id FROM service_deliverables
         WHERE id IN (${deliverableL}::uuid, ${deliverableOnlyL}::uuid, ${deliverableS}::uuid)`),
    );
    expect(new Map(deliverables.map((d) => [d.id, [d.org_id, d.auto_evidence_report_id]]))).toEqual(new Map([
      [deliverableL, [survivor, reportS]],
      [deliverableOnlyL, [survivor, reportOnlyL]],
      [deliverableS, [survivor, reportS]],
    ]));

    const occurrences = rows<{ org_id: string; status: string }>(await testDb.execute(sql`
      SELECT org_id, status FROM service_deliverable_occurrences
       WHERE id IN (${occurrenceL}::uuid, ${occurrenceOnlyL}::uuid, ${occurrenceS}::uuid)`));
    expect(occurrences).toEqual([
      { org_id: survivor, status: 'delivered' },
      { org_id: survivor, status: 'delivered' },
      { org_id: survivor, status: 'delivered' },
    ]);
  }, 120_000);
});
