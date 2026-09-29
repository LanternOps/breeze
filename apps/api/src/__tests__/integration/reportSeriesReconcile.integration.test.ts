/**
 * Multi-org report series W02 — reconciler, repair sweep and worker gate
 * against real Postgres (spec §3.3, §3.4, §5 W02 "Reconciler integration").
 * Owner authority is REAL: resolveLiveReportAuthority / the partner resolver
 * read partner_users + role_permissions on their own system connection.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

// Passthrough wrapper over the real live resolvers: lets a test make named
// owners "unverifiable" (a transient resolver failure) without touching the DB.
const unverifiable = vi.hoisted(() => ({ owners: new Set<string>() }));
vi.mock('../../services/siteScope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteScope')>();
  return {
    ...actual,
    resolveLivePartnerReportAuthority: (userId: string, ...rest: [string, never]) =>
      unverifiable.owners.has(userId)
        ? Promise.resolve({ ok: false, reason: 'unverifiable_scope' })
        : actual.resolveLivePartnerReportAuthority(userId, ...rest),
    resolveLiveReportAuthority: (userId: string, ...rest: [string, never]) =>
      unverifiable.owners.has(userId)
        ? Promise.resolve({ ok: false, reason: 'unverifiable_scope' })
        : actual.resolveLiveReportAuthority(userId, ...rest),
  };
});
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { reports, reportSeries } from '../../db/schema';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { SeriesAuthorityUnverifiableError } from '../../services/reportSeries/authority';
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

describe('transient authority failure (review I-1)', () => {
  it('an unverifiable owner aborts the reconcile and leaves captured child scopes intact', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    await system(() => db.update(reportSeries).set({ name: 'Renamed', revision: 2 }).where(eq(reportSeries.id, s.series.id)));
    unverifiable.owners.add(s.owner);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(reconcile(s.series.id)).rejects.toBeInstanceOf(SeriesAuthorityUnverifiableError);
      // Final review minor #7: logged with enough context to diagnose a persistent wedge.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('owner authority could not be verified'),
        expect.objectContaining({ seriesId: s.series.id, ownerUserId: s.owner, reason: 'unverifiable_scope' }),
      );
    } finally {
      warn.mockRestore();
      unverifiable.owners.delete(s.owner);
    }
    for (const row of await children(s.series.id)) {
      expect(row.executionScopeUserId).toBe(s.owner);
      expect(row.executionScopeKind).toBe('unrestricted');
      expect(row.name).toBe('Monthly summary');
      expect(row.seriesRevision).toBe(1);
    }
  });

  it('the gate propagates it (the job retries) instead of deciding blocked', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgA))!;
    unverifiable.owners.add(s.owner);
    try {
      await expect(system(() => seriesChildGate({
        id: child.id, orgId: s.orgA, seriesId: s.series.id, seriesRevision: child.seriesRevision, archivedAt: null,
      }))).rejects.toBeInstanceOf(SeriesAuthorityUnverifiableError);
    } finally {
      unverifiable.owners.delete(s.owner);
    }
  });
});

describe('lock scope (review I-2)', () => {
  it('the sweep commits each series independently, even inside an outer context that later fails', async () => {
    const good = await seedSeries();
    const bad = await seedSeries();
    unverifiable.owners.add(bad.owner);
    try {
      await expect(system(async () => {
        await reconcileAllSeries();
        throw new Error('outer rollback');
      })).rejects.toThrow('outer rollback');
    } finally {
      unverifiable.owners.delete(bad.owner);
    }
    expect((await children(good.series.id)).length).toBe(2);
    expect(await children(bad.series.id)).toHaveLength(0);
  });

  // Final review minor #8: a child row held by a generating job (the worker's
  // claim / lastGeneratedAt stamp) must not stall the whole tick. The
  // per-series transaction bounds its lock waits; the timeout is isolated
  // like any other per-series error.
  it('a lock timeout on one series does not stop the sweep reaching the next', async () => {
    const held = await seedSeries();
    await reconcile(held.series.id);
    await system(() => db.update(reportSeries).set({ name: 'Renamed', revision: 2 }).where(eq(reportSeries.id, held.series.id)));
    const heldChild = (await activeChildFor(held.series.id, held.orgA))!;
    const next = await seedSeries();

    let release!: () => void;
    const releaseLock = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = system(() => db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE reports SET updated_at = now() WHERE id = ${heldChild.id}`);
      locked();
      await releaseLock;
    }));
    await lockTaken;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = await Promise.race([
        reconcileAllSeries().then(() => 'done'),
        new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 20_000)),
      ]);
      expect(outcome).toBe('done');
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('repair sweep failed for one series'),
        expect.objectContaining({ seriesId: held.series.id }),
      );
    } finally {
      release();
      await holder;
      error.mockRestore();
    }
    expect((await children(next.series.id)).length).toBe(2);
    expect((await activeChildFor(held.series.id, held.orgA))?.seriesRevision).toBe(1);
  }, 60_000);

  it('a non-stale gate takes no row lock on the series', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgA))!;
    const decision = await system(() => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM report_series WHERE id = ${s.series.id} FOR UPDATE`);
      return Promise.race([
        runOutsideDbContext(() => system(() => seriesChildGate({
          id: child.id, orgId: s.orgA, seriesId: s.series.id, seriesRevision: child.seriesRevision, archivedAt: null,
        }))),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked_on_lock'), 3000)),
      ]);
    }));
    expect(decision).toBe('run');
  });

  // Final review minor #3: the job loaded the row BEFORE a series edit that
  // has since committed (and reconciled the child). The gate re-reads the
  // child's revision and must not take the series lock for a needless reconcile.
  it('a child the job loaded stale but that is current in the database runs without the series lock', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const loaded = (await activeChildFor(s.series.id, s.orgA))!;
    await system(() => db.update(reportSeries).set({ name: 'Renamed', revision: 2 }).where(eq(reportSeries.id, s.series.id)));
    await reconcile(s.series.id);
    expect((await activeChildFor(s.series.id, s.orgA))?.seriesRevision).toBe(2);
    const decision = await system(() => db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM report_series WHERE id = ${s.series.id} FOR UPDATE`);
      return Promise.race([
        runOutsideDbContext(() => system(() => seriesChildGate({
          id: loaded.id, orgId: s.orgA, seriesId: s.series.id, seriesRevision: loaded.seriesRevision, archivedAt: null,
        }))),
        new Promise<string>((resolve) => setTimeout(() => resolve('blocked_on_lock'), 3000)),
      ]);
    }));
    expect(loaded.seriesRevision).toBe(1);
    expect(decision).toBe('run');
  });

  it('a stale gate inside a transaction that already locked the child row reconciles on the same connection', async () => {
    const s = await seedSeries();
    await reconcile(s.series.id);
    const child = (await activeChildFor(s.series.id, s.orgA))!;
    await system(() => db.update(reportSeries).set({ name: 'Renamed', revision: 2 }).where(eq(reportSeries.id, s.series.id)));
    const decision = await system(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      // The worker's claim / lastGeneratedAt stamp: the outer job txn now holds the child row lock.
      await tx.execute(sql`UPDATE reports SET updated_at = now() WHERE id = ${child.id}`);
      return seriesChildGate({
        id: child.id, orgId: s.orgA, seriesId: s.series.id, seriesRevision: child.seriesRevision, archivedAt: null,
      });
    }));
    expect(decision).toBe('run');
    expect((await activeChildFor(s.series.id, s.orgA))?.name).toBe('Renamed');
  });
});
