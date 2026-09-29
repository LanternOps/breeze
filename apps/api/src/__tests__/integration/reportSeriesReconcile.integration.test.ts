/**
 * Multi-org report series W02 — reconciler, repair sweep and worker gate
 * against real Postgres (spec §3.3, §3.4, §5 W02 "Reconciler integration").
 * Owner authority is REAL: resolveLiveReportAuthority / the partner resolver
 * read partner_users + role_permissions on their own system connection.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { reports, reportSeries } from '../../db/schema';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import {
  reconcileAllSeries,
  reconcileSeries,
  seriesChildGate,
} from '../../services/reportSeries/reconcile';

const system = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function seedOwner(partnerId: string, orgAccess: 'all' | 'selected' = 'all') {
  const user = await createUser({ partnerId, email: `series-owner-${randomUUID()}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'reports', action: 'write' },
    { resource: 'reports', action: 'export' },
  ]);
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  return user.id;
}

async function seedSeries(opts: { targetMode?: 'all' | 'selected'; internalCc?: string[] } = {}) {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme Dental' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Bolt Legal' });
  const owner = await seedOwner(partner.id);
  const series = await system(async () => {
    const [row] = await db.insert(reportSeries).values({
      partnerId: partner.id,
      name: 'Monthly summary',
      type: 'executive_summary',
      schedule: 'monthly',
      format: 'pdf',
      config: { columns: ['hostname'] },
      targetMode: opts.targetMode ?? 'all',
      internalCc: opts.internalCc ?? ['noc@msp.test'],
      ownerUserId: owner,
      createdBy: owner,
    }).returning();
    return row!;
  });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, owner, series };
}

const reconcile = (seriesId: string) => system(() => db.transaction((tx) => reconcileSeries(seriesId, tx)));

async function children(seriesId: string) {
  return system(() => db.select().from(reports).where(eq(reports.seriesId, seriesId)));
}
async function activeChildFor(seriesId: string, orgId: string) {
  return (await children(seriesId)).find((row) => row.orgId === orgId && row.archivedAt === null);
}

describe('reconcileSeries', () => {
  it('creates one org-owned child per eligible targeted org, capturing the owner scope per org', async () => {
    const s = await seedSeries();
    const result = await reconcile(s.series.id);
    expect(result).toMatchObject({ created: 2, updated: 0, archived: 0, unarchived: 0, blocked: [] });

    const rows = await children(s.series.id);
    expect(rows.map((row) => row.orgId).sort()).toEqual([s.orgA, s.orgB].sort());
    for (const row of rows) {
      expect(row.partnerId).toBeNull();
      expect(row.seriesRevision).toBe(1);
      expect(row.archivedAt).toBeNull();
      expect(row.portalSelfService).toBe(false);
      expect(row.type).toBe('executive_summary');
      expect(row.config).toEqual({ columns: ['hostname'], emailRecipients: ['noc@msp.test'] });
      expect(row.executionScopeUserId).toBe(s.owner);
      expect(row.executionScopeKind).toBe('unrestricted');
      expect(row.executionScopePrincipalKind).toBe('user');
    }
    // Idempotent.
    expect(await reconcile(s.series.id)).toMatchObject({ created: 0, updated: 0, archived: 0, unarchived: 0 });
  });

  it("'all' mode picks up a newly created org within one repair sweep", async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const late = await createOrganization({ partnerId: s.partnerId, name: 'Cobalt Dental' });
    await reconcileAllSeries();
    expect(await activeChildFor(s.series.id, late.id)).toBeDefined();
  });

  it('exclusion archives the child and keeps its runs; re-inclusion unarchives the SAME row', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgA))!;
    const runId = randomUUID();
    await system(() => db.execute(sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${child.id}, 'completed')`));

    await system(() => db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${s.series.id}, ${s.orgA})`));
    expect(await reconcile(s.series.id)).toMatchObject({ archived: 1 });
    expect(await activeChildFor(s.series.id, s.orgA)).toBeUndefined();
    expect(await system(() => db.execute(sql`SELECT id FROM report_runs WHERE id = ${runId}`))).toHaveLength(1);

    await system(() => db.execute(sql`DELETE FROM report_series_org_targets WHERE series_id = ${s.series.id}`));
    expect(await reconcile(s.series.id)).toMatchObject({ unarchived: 1, created: 0 });
    expect((await activeChildFor(s.series.id, s.orgA))?.id).toBe(child.id);
  });

  it('a revision bump rewrites every child; a sentinel-0 child is treated as stale', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const childB = (await activeChildFor(s.series.id, s.orgB))!;
    await system(() => db.update(reports).set({ seriesRevision: 0 }).where(eq(reports.id, childB.id)));
    await system(() => db.update(reportSeries)
      .set({ name: 'Monthly executive summary', revision: 2 })
      .where(eq(reportSeries.id, s.series.id)));

    expect(await reconcile(s.series.id)).toMatchObject({ updated: 2 });
    for (const row of await children(s.series.id)) {
      expect(row.name).toBe('Monthly executive summary');
      expect(row.seriesRevision).toBe(2);
    }
  });

  it('an org that leaves active status is archived by the sweep and unarchived (same row) when it returns', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgB))!;

    await system(() => db.execute(sql`UPDATE organizations SET status = 'suspended' WHERE id = ${s.orgB}`));
    await reconcileAllSeries();
    expect(await activeChildFor(s.series.id, s.orgB)).toBeUndefined();

    await system(() => db.execute(sql`UPDATE organizations SET status = 'active' WHERE id = ${s.orgB}`));
    await reconcileAllSeries();
    expect((await activeChildFor(s.series.id, s.orgB))?.id).toBe(child.id);
  });

  it("an owner demoted to org_access='selected' blocks every child (all-NULL scope), never a fallback", async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.execute(sql`
      UPDATE partner_users SET org_access = 'selected', org_ids = ${`{${s.orgA},${s.orgB}}`}::uuid[]
       WHERE user_id = ${s.owner}`));

    const result = await reconcile(s.series.id);
    expect([...result.blocked].sort()).toEqual([s.orgA, s.orgB].sort());
    for (const row of await children(s.series.id)) {
      expect(row.executionScopeUserId).toBeNull();
      expect(row.executionScopeKind).toBeNull();
      expect(row.executionScopePrincipalKind).toBeNull();
    }
  });

  it('a deactivated owner blocks new children too', async () => {
    const s = await seedSeries();
    await system(() => db.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${s.owner}`));
    const result = await reconcile(s.series.id);
    expect(result.created).toBe(2);
    expect(result.blocked).toHaveLength(2);
  });
});

describe('seriesChildGate', () => {
  async function gateFor(s: Awaited<ReturnType<typeof seedSeries>>, orgId: string) {
    const child = (await children(s.series.id)).find((row) => row.orgId === orgId)!;
    return system(() => seriesChildGate({
      id: child.id,
      orgId: child.orgId!,
      seriesId: child.seriesId!,
      seriesRevision: child.seriesRevision,
      archivedAt: child.archivedAt,
    }));
  }

  it('runs a current child of an enabled series', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    expect(await gateFor(s, s.orgA)).toBe('run');
  });

  it('skips a disabled series', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.update(reportSeries).set({ enabled: false }).where(eq(reportSeries.id, s.series.id)));
    expect(await gateFor(s, s.orgA)).toBe('skip_disabled');
  });

  it('skips a child whose org was excluded after the job was queued (the row is still active)', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${s.series.id}, ${s.orgA})`));
    expect(await gateFor(s, s.orgA)).toBe('skip_untargeted');
  });

  it('reconciles a stale child first, then runs it', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.update(reportSeries).set({ name: 'Renamed', revision: 2 }).where(eq(reportSeries.id, s.series.id)));
    expect(await gateFor(s, s.orgA)).toBe('run');
    expect((await activeChildFor(s.series.id, s.orgA))?.name).toBe('Renamed');
  });

  // Review Focus 4.
  it("owner demoted to 'selected' still covering the org → blocked_no_authority", async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.execute(sql`
      UPDATE partner_users SET org_access = 'selected', org_ids = ${`{${s.orgA},${s.orgB}}`}::uuid[]
       WHERE user_id = ${s.owner}`));
    expect(await gateFor(s, s.orgA)).toBe('blocked_no_authority');
  });

  it('an archived child is skipped without touching the series', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgA))!;
    await system(() => db.update(reports).set({ archivedAt: new Date() }).where(eq(reports.id, child.id)));
    expect(await gateFor(s, s.orgA)).toBe('skip_archived');
  });
});
