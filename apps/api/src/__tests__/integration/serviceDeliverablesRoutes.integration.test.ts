/**
 * HTTP-level proof for the service-deliverables surface (#5573 W01): the real
 * routers, services and RLS policies against Postgres, driven through
 * `app.request` with a partner-scoped token. Mocked route tests cannot tell
 * whether the request's DB context reaches the service (memory: public routes
 * need a live-DB test), so this file is the wave's end-to-end smoke:
 *
 *   create deliverable → materialize one occurrence (system scope, W02 owns the
 *   sweep) → deliver with a report-run evidence ref → reopen → waive; key dates
 *   union contract end dates; a contract of another org is refused 400; another
 *   partner's org is a 404, never 403.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contracts, reports, reportRuns } from '../../db/schema';
import { serviceDeliverableRoutes } from '../../routes/serviceDeliverables';
import { orgKeyDateRoutes } from '../../routes/orgKeyDates';
import { contractRoutes } from '../../routes/contracts';
import { createIntegrationTestClient, createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/orgs', serviceDeliverableRoutes);
  app.route('/api/v1/orgs', orgKeyDateRoutes);
  app.route('/api/v1/contracts', contractRoutes);
  return app;
}

type Json = Record<string, any>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

async function seedContract(partnerId: string, orgId: string, name: string, endDate: string | null, status = 'active') {
  return withSystemDbAccessContext(async () => {
    const [c] = await db
      .insert(contracts)
      .values({
        partnerId, orgId, name, status: status as never, intervalMonths: 1,
        startDate: '2026-10-01', endDate, nextBillingAt: '2026-10-01', currencyCode: 'USD', billingTiming: 'advance',
      })
      .returning({ id: contracts.id });
    return c!.id;
  });
}

async function seedReportRun(orgId: string) {
  return withSystemDbAccessContext(async () => {
    const [r] = await db.insert(reports).values({ orgId, name: 'Monthly summary', type: 'ai_org_narrative' }).returning({ id: reports.id });
    const [run] = await db.insert(reportRuns).values({ reportId: r!.id, status: 'completed' }).returning({ id: reportRuns.id });
    return { reportId: r!.id, runId: run!.id };
  });
}

describe('service deliverables routes (live DB, partner token)', () => {
  runDb('deliverable lifecycle: create → occurrence → deliver with report run → reopen → waive', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const orgId = client.env.organization.id;
    const partnerId = client.env.partner.id;
    const contractId = await seedContract(partnerId, orgId, 'Best plan', '2027-09-30');
    const base = `/api/v1/orgs/${orgId}/deliverables`;

    // Empty list first (the request context reaches the service; RLS lets the partner read its org).
    const empty = await client.get(base);
    expect(empty.status).toBe(200);
    expect((await json(empty)).data).toEqual([]);

    const created = await client.post(base, {
      contractId, name: 'Sign-in log review', cadence: 'monthly', anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01',
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const deliverable = (await json(created)).data;
    expect(deliverable).toMatchObject({ orgId, contractId, name: 'Sign-in log review', active: true });

    // Duplicate (org, contract, name) is a 409 from the unique index, not a 500.
    const dup = await client.post(base, {
      contractId, name: 'Sign-in log review', cadence: 'monthly', anchorDueDate: '2026-11-30', effectiveFrom: '2026-10-01',
    });
    expect(dup.status, await dup.clone().text()).toBe(409);
    expect((await json(dup)).code).toBe('DUPLICATE_NAME');

    // Summary joins the contract name and reports on_track with no occurrences.
    const list = await json(await client.get(base));
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ contractName: 'Best plan', nextDue: null, openCount: 0 });

    // The contract-side filtered view resolves the org from the contract.
    const viaContract = await client.get(`/api/v1/contracts/${contractId}/deliverables`);
    expect(viaContract.status).toBe(200);
    expect((await json(viaContract)).data.map((d: Json) => d.id)).toEqual([deliverable.id]);

    // W02 owns materialization; seed one open occurrence the way the sweep will.
    const occurrenceId = await withSystemDbAccessContext(async () => {
      const rows = (await db.execute(sql`
        INSERT INTO service_deliverable_occurrences
          (org_id, deliverable_id, name_snapshot, period_start, period_end, due_at, original_due_at, status)
        VALUES (${orgId}::uuid, ${deliverable.id}::uuid, 'Sign-in log review', '2026-10-01', '2026-10-31', '2026-10-31', '2026-10-31', 'open')
        RETURNING id`)) as unknown as Array<{ id: string }>;
      return rows[0]!.id;
    });

    const occs = await json(await client.get(`${base}/${deliverable.id}/occurrences`));
    expect(occs.data.map((o: Json) => o.id)).toEqual([occurrenceId]);

    // artifact_required defaults true: delivering without evidence is a 400, not a 409.
    const noEvidence = await client.post(`${base}/occurrences/${occurrenceId}/deliver`, { note: 'done' });
    expect(noEvidence.status).toBe(400);
    expect((await json(noEvidence)).code).toBe('EVIDENCE_REQUIRED');

    // A run of ANOTHER org's report is refused as not found (ownership chain), never 403.
    const foreignOrg = await withSystemDbAccessContext(() => createOrganization({ partnerId }));
    const foreign = await seedReportRun(foreignOrg.id);
    const foreignRun = await client.post(`${base}/occurrences/${occurrenceId}/deliver`, {
      evidence: [{ kind: 'report_run', reportRunId: foreign.runId }],
    });
    expect(foreignRun.status).toBe(404);

    const own = await seedReportRun(orgId);
    const delivered = await client.post(`${base}/occurrences/${occurrenceId}/deliver`, {
      note: 'Reviewed 3 risky sign-ins', evidence: [{ kind: 'report_run', reportRunId: own.runId }],
    });
    expect(delivered.status, await delivered.clone().text()).toBe(200);
    const view = (await json(delivered)).data;
    expect(view).toMatchObject({ status: 'delivered', deliveredVia: 'explicit', deliveryNote: 'Reviewed 3 risky sign-ins' });
    expect(view.evidence).toHaveLength(1);
    expect(view.evidence[0]).toMatchObject({ kind: 'report_run', reportId: own.reportId, reportRunId: own.runId });

    // Removing the only evidence of a delivered, artifact-required occurrence is refused.
    const removeLast = await client.delete(`${base}/occurrences/${occurrenceId}/evidence/${view.evidence[0].id}`);
    expect(removeLast.status).toBe(409);

    const reopened = await client.post(`${base}/occurrences/${occurrenceId}/reopen`);
    expect(reopened.status).toBe(200);
    expect((await json(reopened)).data).toMatchObject({ status: 'open', deliveredAt: null, deliveredVia: null, deliveryNote: null });

    const waivedNoReason = await client.post(`${base}/occurrences/${occurrenceId}/waive`, { reason: '' });
    expect(waivedNoReason.status).toBe(400);

    const waived = await client.post(`${base}/occurrences/${occurrenceId}/waive`, { reason: 'Customer paused the service in October' });
    expect(waived.status).toBe(200);
    expect((await json(waived)).data).toMatchObject({ status: 'waived', waivedReason: 'Customer paused the service in October' });

    // Rescheduling a waived occurrence is an illegal transition (409), and the row is untouched.
    const resched = await client.post(`${base}/occurrences/${occurrenceId}/reschedule`, { dueAt: '2026-11-15' });
    expect(resched.status).toBe(409);
    expect((await json(resched)).code).toBe('INVALID_OCCURRENCE_TRANSITION');

    // Deactivate = soft (active=false), row survives with its history.
    const deactivated = await client.delete(`${base}/${deliverable.id}`);
    expect(deactivated.status).toBe(200);
    const after = await json(await client.get(`${base}?includeInactive=true`));
    expect(after.data[0]).toMatchObject({ id: deliverable.id, active: false, status: 'inactive' });
    expect((await json(await client.get(base))).data).toEqual([]);
  });

  runDb('a contract of another org is 400 CONTRACT_NOT_IN_ORG; another partner\'s org is 404 not 403', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const orgId = client.env.organization.id;
    const partnerId = client.env.partner.id;
    const sibling = await withSystemDbAccessContext(() => createOrganization({ partnerId }));
    const siblingContract = await seedContract(partnerId, sibling.id, 'Sibling', null);

    const wrongContract = await client.post(`/api/v1/orgs/${orgId}/deliverables`, {
      contractId: siblingContract, name: 'x', cadence: 'annual', anchorDueDate: '2026-12-31', effectiveFrom: '2026-10-01',
    });
    expect(wrongContract.status).toBe(400);
    expect((await json(wrongContract)).code).toBe('CONTRACT_NOT_IN_ORG');

    const otherPartner = await withSystemDbAccessContext(async () => {
      const p = await createPartner();
      return createOrganization({ partnerId: p.id });
    });
    for (const path of [`/api/v1/orgs/${otherPartner.id}/deliverables`, `/api/v1/orgs/${otherPartner.id}/key-dates`]) {
      const res = await client.get(path);
      expect(res.status, path).toBe(404);
    }
    const forge = await client.post(`/api/v1/orgs/${otherPartner.id}/key-dates`, { label: 'forged', date: '2027-01-01' });
    expect(forge.status).toBe(404);
  });

  runDb('key dates: CRUD plus contract-end union (draft/cancelled/past excluded), sorted by date', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const orgId = client.env.organization.id;
    const partnerId = client.env.partner.id;
    const active = await seedContract(partnerId, orgId, 'Active ends 2027', '2027-06-30');
    await seedContract(partnerId, orgId, 'Draft', '2027-01-15', 'draft');
    await seedContract(partnerId, orgId, 'Cancelled', '2027-02-15', 'cancelled');
    await seedContract(partnerId, orgId, 'Past', '2020-01-01');
    const base = `/api/v1/orgs/${orgId}/key-dates`;

    const created = await client.post(base, {
      label: 'Cyber insurance renewal', kind: 'insurance_renewal', date: '2027-03-01', recursAnnually: true, remindDaysBefore: 60,
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const kd = (await json(created)).data;
    expect(kd).toMatchObject({ orgId, kind: 'insurance_renewal', recursAnnually: true, remindDaysBefore: 60, portalVisible: false });

    const list = (await json(await client.get(base))).data as Json[];
    expect(list.map((r) => [r.source, r.label])).toEqual([
      ['key_date', 'Cyber insurance renewal'],
      ['contract_end', 'Active ends 2027'],
    ]);
    expect(list[1]).toMatchObject({ id: active, contractId: active, kind: 'contract_end', date: '2027-06-30', portalVisible: true });

    const patched = await client.patch(`${base}/${kd.id}`, { notes: 'renewed early', portalVisible: true });
    expect(patched.status).toBe(200);
    expect((await json(patched)).data).toMatchObject({ notes: 'renewed early', portalVisible: true, kind: 'insurance_renewal', recursAnnually: true });

    const bad = await client.patch(`${base}/${kd.id}`, { date: 'March 1' });
    expect(bad.status).toBe(400);

    const deleted = await client.delete(`${base}/${kd.id}`);
    expect(deleted.status).toBe(200);
    expect((await json(await client.get(base))).data.map((r: Json) => r.source)).toEqual(['contract_end']);
    expect((await client.delete(`${base}/${kd.id}`)).status).toBe(404);
  });
});
