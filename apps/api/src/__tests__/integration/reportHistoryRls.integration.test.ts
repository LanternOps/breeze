/**
 * #6771 — the report-history RLS read branch, proven against real Postgres as
 * the forced-RLS `breeze_app` role.
 *
 * Migration under test: 2026-10-28-130000-report-history-read-policies.sql.
 *
 * An active partner may READ report definitions and run metadata of its own
 * out-of-service orgs. Those orgs are never in `breeze.accessible_org_ids`
 * (the auth middleware admits only active/trial orgs), so the read needs its
 * own grant: the `breeze.report_history_org_ids` GUC, set only for the
 * report-history GET routes, and two additive FOR SELECT policies on
 * `reports` and `report_runs`. The existing FOR ALL / per-command owner
 * policies are untouched, so a write can never reach these rows.
 *
 * Every assertion here runs through the real postgres.js driver and the real
 * `withDbAccessContext` GUC writer — the same path a request takes.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, reportRuns, reports, scripts, sites } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

interface Fixture {
  partnerId: string;
  userId: string;
  activeOrgId: string;
  historyOrgId: string;
  foreignHistoryOrgId: string;
  reportIds: { active: string; history: string; foreign: string };
  runIds: { active: string; history: string; foreign: string };
  historyDeviceId: string;
  historyScriptId: string;
  historySiteId: string;
}

async function seedReport(orgId: string, userId: string, name: string) {
  const [report] = await getTestDb()
    .insert(reports)
    .values({ orgId, name, type: 'device_inventory', createdBy: userId })
    .returning({ id: reports.id });
  const [run] = await getTestDb()
    .insert(reportRuns)
    .values({ reportId: report!.id, status: 'completed', rowCount: 3, result: { rows: [{ secret: 'stored-result' }] } })
    .returning({ id: reportRuns.id });
  return { reportId: report!.id, runId: run!.id };
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id, email: `rh-rls-${randomUUID()}@example.com` });
  const activeOrg = await createOrganization({ partnerId: partner.id });
  const historyOrg = await createOrganization({ partnerId: partner.id, status: 'suspended' });

  const foreignPartner = await createPartner();
  const foreignUser = await createUser({ partnerId: foreignPartner.id, email: `rh-rls-f-${randomUUID()}@example.com` });
  const foreignOrg = await createOrganization({ partnerId: foreignPartner.id, status: 'suspended' });

  const active = await seedReport(activeOrg.id, user.id, 'Active inventory');
  const history = await seedReport(historyOrg.id, user.id, 'History inventory');
  const foreign = await seedReport(foreignOrg.id, foreignUser.id, 'Foreign inventory');

  const site = await createSite({ orgId: historyOrg.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: historyOrg.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: `rh-${randomUUID().slice(0, 8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
    })
    .returning({ id: devices.id });
  const [script] = await getTestDb()
    .insert(scripts)
    .values({
      // An ORG-owned script (partner_id NULL): a partner_id-bearing script is
      // readable through the scripts table's own partner-access branch
      // regardless of org status, which is unrelated to this capability.
      orgId: historyOrg.id,
      name: 'History org script',
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Write-Output 1',
      createdBy: user.id,
    })
    .returning({ id: scripts.id });

  return {
    partnerId: partner.id,
    userId: user.id,
    activeOrgId: activeOrg.id,
    historyOrgId: historyOrg.id,
    foreignHistoryOrgId: foreignOrg.id,
    reportIds: { active: active.reportId, history: history.reportId, foreign: foreign.reportId },
    runIds: { active: active.runId, history: history.runId, foreign: foreign.runId },
    historyDeviceId: device!.id,
    historyScriptId: script!.id,
    historySiteId: site.id,
  };
}

/** Exactly the context authMiddleware builds for an opted-in partner request. */
function historyContext(f: Fixture, historyOrgIds: string[] = [f.historyOrgId]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [f.activeOrgId],
    accessiblePartnerIds: [f.partnerId],
    userId: f.userId,
    currentPartnerId: f.partnerId,
    reportHistoryOrgIds: historyOrgIds,
  };
}

function plainPartnerContext(f: Fixture): DbAccessContext {
  const { reportHistoryOrgIds: _omit, ...rest } = historyContext(f);
  return rest;
}

async function visibleReportIds(context: DbAccessContext, ids: string[]): Promise<string[]> {
  const rows = await withDbAccessContext(context, () =>
    db.select({ id: reports.id }).from(reports).where(inArray(reports.id, ids)),
  );
  return rows.map((r) => r.id).sort();
}

async function visibleRunIds(context: DbAccessContext, ids: string[]): Promise<string[]> {
  const rows = await withDbAccessContext(context, () =>
    db.select({ id: reportRuns.id }).from(reportRuns).where(inArray(reportRuns.id, ids)),
  );
  return rows.map((r) => r.id).sort();
}

/** postgres.js wraps the server error; the SQLSTATE lives on the cause chain. */
function sqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

let f: Fixture;

beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  f = await seedFixture();
});

describe('report-history RLS read branch (#6771)', () => {
  runDb('the history policies are permissive FOR SELECT only (never FOR ALL / a write command)', async () => {
    const rows = await getTestDb().execute<{ tablename: string; policyname: string; cmd: string; permissive: string }>(sql`
      SELECT tablename, policyname, cmd, permissive
        FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname IN ('reports_report_history_select', 'report_runs_report_history_select')
       ORDER BY tablename`);
    expect([...rows].map((r) => ({ ...r }))).toEqual([
      { tablename: 'report_runs', policyname: 'report_runs_report_history_select', cmd: 'SELECT', permissive: 'PERMISSIVE' },
      { tablename: 'reports', policyname: 'reports_report_history_select', cmd: 'SELECT', permissive: 'PERMISSIVE' },
    ]);
    // No other policy on any table references the history helper.
    const users = await getTestDb().execute<{ tablename: string; policyname: string }>(sql`
      SELECT tablename, policyname FROM pg_policies
       WHERE (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%report_history%'
       ORDER BY tablename`);
    expect([...users].map((r) => r.policyname).sort()).toEqual([
      'report_runs_report_history_select',
      'reports_report_history_select',
    ]);
  });

  runDb('grants SELECT on reports and report_runs of the listed org only', async () => {
    const allReports = Object.values(f.reportIds);
    const allRuns = Object.values(f.runIds);

    expect(await visibleReportIds(historyContext(f), allReports))
      .toEqual([f.reportIds.active, f.reportIds.history].sort());
    expect(await visibleRunIds(historyContext(f), allRuns))
      .toEqual([f.runIds.active, f.runIds.history].sort());
  });

  runDb('without the GUC the inactive org is invisible (the grant is the new policy, nothing else)', async () => {
    expect(await visibleReportIds(plainPartnerContext(f), [f.reportIds.history])).toEqual([]);
    expect(await visibleRunIds(plainPartnerContext(f), [f.runIds.history])).toEqual([]);
  });

  runDb('a foreign org is invisible unless its id is in the GUC (it never is: discovery is partner-bound)', async () => {
    expect(await visibleReportIds(historyContext(f), [f.reportIds.foreign])).toEqual([]);
    expect(await visibleRunIds(historyContext(f), [f.runIds.foreign])).toEqual([]);
  });

  runDb('an organization-scope context gains nothing from the GUC', async () => {
    const orgCtx: DbAccessContext = {
      scope: 'organization',
      orgId: f.activeOrgId,
      accessibleOrgIds: [f.activeOrgId],
      accessiblePartnerIds: [],
      userId: f.userId,
      currentPartnerId: f.partnerId,
      reportHistoryOrgIds: [f.historyOrgId],
    };
    expect(await visibleReportIds(orgCtx, [f.reportIds.history])).toEqual([]);
    expect(await visibleRunIds(orgCtx, [f.runIds.history])).toEqual([]);
  });

  runDb('an empty or malformed GUC returns zero rows (fail closed on the whole list)', async () => {
    for (const raw of ['', '*', 'not-a-uuid', `${f.historyOrgId},not-a-uuid`, `${f.historyOrgId};DROP`, ` ${f.historyOrgId}`]) {
      const rows = await withDbAccessContext(plainPartnerContext(f), async () => {
        await db.execute(sql`select set_config('breeze.report_history_org_ids', ${raw}, true)`);
        return db.select({ id: reports.id }).from(reports).where(eq(reports.id, f.reportIds.history));
      });
      expect(rows, `GUC value ${JSON.stringify(raw)}`).toEqual([]);
    }
    // Control: the well-formed value through the same raw path DOES grant.
    const control = await withDbAccessContext(plainPartnerContext(f), async () => {
      await db.execute(sql`select set_config('breeze.report_history_org_ids', ${f.historyOrgId}, true)`);
      return db.select({ id: reports.id }).from(reports).where(eq(reports.id, f.reportIds.history));
    });
    expect(control).toHaveLength(1);
  });

  runDb('writes to reports under the capability fail: INSERT 42501, UPDATE/DELETE reach zero rows', async () => {
    let insertError: unknown;
    try {
      await withDbAccessContext(historyContext(f), () =>
        db.insert(reports).values({
          orgId: f.historyOrgId,
          name: 'forged',
          type: 'device_inventory',
          createdBy: f.userId,
        }),
      );
    } catch (err) {
      insertError = err;
    }
    expect(sqlState(insertError)).toBe('42501');

    const updated = await withDbAccessContext(historyContext(f), () =>
      db.update(reports).set({ name: 'renamed' }).where(eq(reports.id, f.reportIds.history)).returning({ id: reports.id }),
    );
    expect(updated).toEqual([]);

    const deleted = await withDbAccessContext(historyContext(f), () =>
      db.delete(reports).where(eq(reports.id, f.reportIds.history)).returning({ id: reports.id }),
    );
    expect(deleted).toEqual([]);

    const [row] = await getTestDb().select({ name: reports.name }).from(reports).where(eq(reports.id, f.reportIds.history));
    expect(row?.name).toBe('History inventory');
  });

  runDb('writes to report_runs under the capability fail: INSERT 42501, UPDATE/DELETE reach zero rows', async () => {
    let insertError: unknown;
    try {
      await withDbAccessContext(historyContext(f), () =>
        db.insert(reportRuns).values({ reportId: f.reportIds.history, status: 'pending' }),
      );
    } catch (err) {
      insertError = err;
    }
    expect(sqlState(insertError)).toBe('42501');

    const updated = await withDbAccessContext(historyContext(f), () =>
      db.update(reportRuns).set({ status: 'failed' }).where(eq(reportRuns.id, f.runIds.history)).returning({ id: reportRuns.id }),
    );
    expect(updated).toEqual([]);

    const deleted = await withDbAccessContext(historyContext(f), () =>
      db.delete(reportRuns).where(eq(reportRuns.id, f.runIds.history)).returning({ id: reportRuns.id }),
    );
    expect(deleted).toEqual([]);

    const [row] = await getTestDb().select({ status: reportRuns.status }).from(reportRuns).where(eq(reportRuns.id, f.runIds.history));
    expect(row?.status).toBe('completed');
  });

  runDb('devices, scripts and sites of the inactive org stay invisible under the capability', async () => {
    const [deviceRows, scriptRows, siteRows] = await withDbAccessContext(historyContext(f), async () => [
      await db.select({ id: devices.id }).from(devices).where(eq(devices.id, f.historyDeviceId)),
      await db.select({ id: scripts.id }).from(scripts).where(eq(scripts.id, f.historyScriptId)),
      await db.select({ id: sites.id }).from(sites).where(eq(sites.id, f.historySiteId)),
    ]);
    expect(deviceRows).toEqual([]);
    expect(scriptRows).toEqual([]);
    expect(siteRows).toEqual([]);
  });
});
