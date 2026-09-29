/**
 * Multi-org report series W02 — the series store in a PARTNER REQUEST
 * context (RLS as breeze_app), exactly as the routes run it. Covers the spec
 * §5 W02 authority tests (narrowed/deactivated owner, transfer-owner
 * re-capture), series delete with history, and Review Focus 1 (detach does
 * not resurrect a child).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { reports, reportSeries, reportSeriesOrgTargets } from '../../db/schema';
import {
  assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions,
} from './db-utils';
import { findSeriesNeedingReconcile, reconcileAllSeries } from '../../services/reportSeries/reconcile';
import { parseSeriesRecipientRule } from '../../services/reportSeries/types';
import { ReportSeriesError } from '../../services/reportSeries/errors';
import {
  createSeries, deleteSeries, detachSeriesChild, finishDetach, getSeriesDetail, replaceSeriesTargets,
  transferSeriesOwner, updateSeries, type CreateSeriesInput, type SeriesAuth,
} from '../../services/reportSeries/store';

const system = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function seedOwner(partnerId: string) {
  const user = await createUser({ partnerId, email: `series-store-${randomUUID()}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'reports', action: 'write' },
    { resource: 'reports', action: 'export' },
  ]);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return user.id;
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: 'Acme Dental' });
  const orgB = await createOrganization({ partnerId: partner.id, name: 'Bolt Legal' });
  const owner = await seedOwner(partner.id);
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id, orgB.id],
    accessiblePartnerIds: [partner.id], currentPartnerId: partner.id, userId: owner,
  };
  const auth = { scope: 'partner', partnerId: partner.id, partnerOrgAccess: 'all', user: { id: owner } } as unknown as SeriesAuth;
  const inPartner = <T>(fn: (tx: typeof db) => Promise<T>) =>
    withDbAccessContext(ctx, () => db.transaction((tx) => fn(tx as unknown as typeof db)));
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, owner, ctx, auth, inPartner };
}

function input(owner: string, overrides: Partial<CreateSeriesInput> = {}): CreateSeriesInput {
  return {
    name: 'Monthly summary', type: 'executive_summary', format: 'pdf', schedule: 'monthly',
    config: {}, targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] },
    internalCc: [], enabled: true, ownerUserId: owner, ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try { await promise; return null; } catch (err) {
    if (err instanceof ReportSeriesError) return err.code;
    throw err;
  }
}

async function childrenOf(seriesId: string) {
  return system(() => db.select().from(reports).where(eq(reports.seriesId, seriesId)));
}

describe('series store (partner request context)', () => {
  it('create writes the series, its targets and one child per org in ONE transaction', async () => {
    const s = await seed();
    const created = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    expect(created.reconcile.created).toBe(2);
    expect(created.series.partnerId).toBe(s.partnerId);
    expect((await childrenOf(created.series.id)).map((c) => c.orgId).sort()).toEqual([s.orgA, s.orgB].sort());
  });

  it('create with an active rule is refused without the delivery gate, and writes nothing', async () => {
    const s = await seed();
    expect(await codeOf(s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
    const count = await system(() => db.select().from(reportSeries).where(eq(reportSeries.partnerId, s.partnerId)));
    expect(count).toHaveLength(0);
    // No rule, no CC: nothing is delivered, so no gate.
    const quiet = input(s.owner, { recipientRule: { primaryContact: false, roles: [] } });
    await expect(s.inPartner((tx) => createSeries(quiet, s.auth, tx, { mayAddDelivery: false }))).resolves.toBeDefined();
  });

  it('create refuses an owner of another partner (series_owner_ineligible) and a selected caller (series_write_denied)', async () => {
    const s = await seed();
    const foreign = await seedOwner((await createPartner()).id);
    expect(await codeOf(s.inPartner((tx) => createSeries(input(foreign), s.auth, tx, { mayAddDelivery: true }))))
      .toBe('series_owner_ineligible');
    const selected = { ...s.auth, partnerOrgAccess: 'selected' } as SeriesAuth;
    expect(await codeOf(s.inPartner((tx) => createSeries(input(s.owner), selected, tx, { mayAddDelivery: true }))))
      .toBe('series_write_denied');
  });

  it('a shared-field PATCH bumps the revision and rewrites children; a rule-only PATCH does not bump', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const renamed = await s.inPartner((tx) => updateSeries(series.id, { name: 'Renamed' }, s.auth, tx, { mayAddDelivery: false }));
    expect(renamed.series.revision).toBe(2);
    expect(renamed.reconcile.updated).toBe(2);
    const ruleOnly = await s.inPartner((tx) => updateSeries(series.id, { recipientRule: { primaryContact: false, roles: [] } }, s.auth, tx, { mayAddDelivery: false }));
    expect(ruleOnly.series.revision).toBe(2);
    expect(await codeOf(s.inPartner((tx) => updateSeries(series.id, { internalCc: ['noc@msp.test'] }, s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
  });

  it('targets: narrowing archives; re-adding an org while a rule is active needs the delivery gate', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const narrowed = await s.inPartner((tx) => replaceSeriesTargets(series.id, { targetMode: 'selected', orgIds: [s.orgA] }, s.auth, tx, { mayAddDelivery: false }));
    expect(narrowed.reconcile.archived).toBe(1);
    expect(await codeOf(s.inPartner((tx) => replaceSeriesTargets(series.id, { targetMode: 'all', orgIds: [] }, s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
  });

  it('a PATCH that widens the rule needs the delivery gate; with it, it succeeds', async () => {
    const s = await seed();
    const quiet = input(s.owner, { recipientRule: { primaryContact: false, roles: [] } });
    const { series } = await s.inPartner((tx) => createSeries(quiet, s.auth, tx, { mayAddDelivery: false }));
    const widen = { recipientRule: { primaryContact: true, roles: [] } };
    expect(await codeOf(s.inPartner((tx) => updateSeries(series.id, widen, s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
    const addRole = { recipientRule: { primaryContact: false, roles: ['billing'] } };
    expect(await codeOf(s.inPartner((tx) => updateSeries(series.id, addRole, s.auth, tx, { mayAddDelivery: false }))))
      .toBe('recipients_need_export_and_mfa');
    const ok = await s.inPartner((tx) => updateSeries(series.id, widen, s.auth, tx, { mayAddDelivery: true }));
    expect(parseSeriesRecipientRule(ok.series.recipientRule).primaryContact).toBe(true);
  });

  it('flipping target_mode drops target rows the caller cannot see (suspended org exclusion is not inverted)', async () => {
    const s = await seed();
    const quiet = input(s.owner, { orgIds: [s.orgB], recipientRule: { primaryContact: false, roles: [] } });
    const { series } = await s.inPartner((tx) => createSeries(quiet, s.auth, tx, { mayAddDelivery: false }));
    await system(() => db.execute(sql`UPDATE organizations SET status = 'suspended' WHERE id = ${s.orgB}`));
    // The suspended org drops out of the caller's accessible orgs (its targets become invisible under RLS).
    const narrowed = { ...s.ctx, accessibleOrgIds: [s.orgA] };
    await withDbAccessContext(narrowed, () => db.transaction((tx) =>
      replaceSeriesTargets(series.id, { targetMode: 'selected', orgIds: [s.orgA] }, s.auth, tx as unknown as typeof db, { mayAddDelivery: true })));
    const rows = await system(() => db.select().from(reportSeriesOrgTargets).where(eq(reportSeriesOrgTargets.seriesId, series.id)));
    expect(rows.map((r) => r.orgId)).toEqual([s.orgA]);
  });

  it('transfer-owner re-captures every child\'s scope for the new owner', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const next = await seedOwner(s.partnerId);
    const moved = await s.inPartner((tx) => transferSeriesOwner(series.id, next, s.auth, tx));
    expect(moved.previousOwnerUserId).toBe(s.owner);
    expect(moved.reconcile.updated).toBe(2);
    for (const child of await childrenOf(series.id)) expect(child.executionScopeUserId).toBe(next);
  });

  it('detail reports excluded / blocked_no_authority / blocked_no_recipients / active per org', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    await system(() => db.execute(sql`
      INSERT INTO contacts (org_id, name, email, is_primary) VALUES (${s.orgA}, 'Owner', 'owner@acme.test', true)`));
    let detail = await withDbAccessContext(s.ctx, () => getSeriesDetail(series.id, s.auth));
    const state = (orgId: string) => detail.orgs.find((o) => o.orgId === orgId)?.state;
    expect(state(s.orgA)).toBe('active');
    expect(state(s.orgB)).toBe('blocked_no_recipients');

    await system(() => db.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${s.owner}`));
    detail = await withDbAccessContext(s.ctx, () => getSeriesDetail(series.id, s.auth));
    expect(state(s.orgA)).toBe('blocked_no_authority');

    await system(() => db.execute(sql`INSERT INTO report_series_org_targets (series_id, org_id) VALUES (${series.id}, ${s.orgB})`));
    detail = await withDbAccessContext(s.ctx, () => getSeriesDetail(series.id, s.auth));
    expect(state(s.orgB)).toBe('excluded');
    expect(detail.targets).toEqual([s.orgB]);
  });

  it('delete archives every child, keeps its runs, and SET NULLs series_id', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const [child] = await childrenOf(series.id);
    const runId = randomUUID();
    await system(() => db.execute(sql`INSERT INTO report_runs (id, report_id, status) VALUES (${runId}, ${child!.id}, 'completed')`));
    const out = await s.inPartner((tx) => deleteSeries(series.id, s.auth, tx));
    expect(out.archivedChildren).toBe(2);
    const after = await system(() => db.select().from(reports).where(eq(reports.id, child!.id)));
    expect(after[0]?.seriesId).toBeNull();
    expect(after[0]?.archivedAt).not.toBeNull();
    expect(await system(() => db.execute(sql`SELECT id FROM report_runs WHERE id = ${runId}`))).toHaveLength(1);
  });

  // Review Focus 1.
  it('detach bookkeeping un-targets the org so the next sweep does not mint a second child', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    await s.inPartner(async (tx) => {
      await tx.update(reports).set({ seriesId: null, seriesRevision: null }).where(eq(reports.id, child.id));
      await finishDetach(tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth);
    });
    await reconcileAllSeries();
    const forA = (await childrenOf(series.id)).filter((c) => c.orgId === s.orgA);
    expect(forA).toHaveLength(0);
    const standalone = await system(() => db.select().from(reports).where(eq(reports.id, child.id)));
    expect(standalone[0]?.archivedAt).toBeNull();
  });

  // Fix round 1: lock order is series row THEN child row (like updateSeries /
  // deleteSeries / reconcile). Hold the SERIES lock on connection A; Detach on
  // connection B must block on the series lock WITHOUT having taken the child
  // lock (a third connection can still NOWAIT-lock the child), then finish.
  it('detach takes the series lock before the child lock (no child-first deadlock)', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = s.inPartner(async (tx) => {
      await tx.execute(sql`SELECT id FROM report_series WHERE id = ${series.id} FOR UPDATE`);
      locked();
      await held;
    });
    await lockTaken;
    let detachDone = false;
    const detaching = s.inPartner((tx) => detachSeriesChild(
      tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth,
    )).then((r) => { detachDone = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(detachDone).toBe(false); // blocked on the series lock
    // The child row is NOT locked by the blocked detach.
    await system(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
      await tx.execute(sql`SELECT id FROM reports WHERE id = ${child.id} FOR UPDATE NOWAIT`);
    }));
    release();
    await holder;
    const out = await detaching;
    expect(out.row.seriesId).toBeNull();
  });

  it('a concurrent detach and series edit both complete (no 40P01)', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    const results = await Promise.allSettled([
      s.inPartner((tx) => detachSeriesChild(tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth)),
      s.inPartner((tx) => updateSeries(series.id, { name: 'Renamed' }, s.auth, tx, { mayAddDelivery: true })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('detaches a blocked_no_authority child (all-NULL execution scope); the standalone keeps NULL scope', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    await system(() => db.execute(sql`
      UPDATE reports SET execution_scope_version = NULL, execution_scope_kind = NULL,
        execution_scope_site_ids = NULL, execution_scope_user_id = NULL,
        execution_scope_fingerprint = NULL, execution_scope_captured_at = NULL,
        execution_scope_principal_kind = NULL WHERE id = ${child.id}`));
    const out = await s.inPartner((tx) => detachSeriesChild(
      tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth,
    ));
    expect(out.row.seriesId).toBeNull();
    expect(out.row.executionScopeKind).toBeNull();
    expect(out.row.archivedAt).toBeNull();
  });

  it('detach refuses a report that is no longer an active child of that series (409 report_not_series_child)', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    await system(() => db.execute(sql`UPDATE reports SET archived_at = now() WHERE id = ${child.id}`));
    expect(await codeOf(s.inPartner((tx) => detachSeriesChild(
      tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth,
    )))).toBe('report_not_series_child');
  });

});

// Final review #1: detach is REMEMBERED on the standalone
// (reports.detached_from_series_id), so a later targets change cannot mint a
// second child next to it; deleting or archiving the standalone re-enables
// targeting.
describe('detach is remembered across later target changes', () => {
  async function activeReportsOf(orgId: string) {
    return system(() => db.select().from(reports).where(and(eq(reports.orgId, orgId), isNull(reports.archivedAt))));
  }

  it("selected: detach X, flip to 'all' -> X keeps only the standalone; deleting it re-targets X", async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(
      input(s.owner, { targetMode: 'selected', orgIds: [s.orgA, s.orgB] }), s.auth, tx, { mayAddDelivery: true },
    ));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    const detached = await s.inPartner((tx) => detachSeriesChild(
      tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth,
    ));
    expect(detached.row.detachedFromSeriesId).toBe(series.id);

    // The target_mode reset trigger drops every target row, so X is back in the 'all' set by rows alone.
    const flipped = await s.inPartner((tx) => replaceSeriesTargets(
      series.id, { targetMode: 'all', orgIds: [] }, s.auth, tx, { mayAddDelivery: true },
    ));
    expect(flipped.reconcile.created).toBe(0);
    await reconcileAllSeries();
    expect((await activeReportsOf(s.orgA)).map((r) => r.id)).toEqual([child.id]);
    // The drift query agrees with the reconciler, so the sweep does not loop on it.
    expect(await system(() => findSeriesNeedingReconcile(10_000))).not.toContain(series.id);

    await system(() => db.delete(reports).where(eq(reports.id, child.id)));
    await reconcileAllSeries();
    const again = await activeReportsOf(s.orgA);
    expect(again).toHaveLength(1);
    expect(again[0]?.seriesId).toBe(series.id);
    expect(again[0]?.id).not.toBe(child.id);
  });

  it("'all': a same-mode replace that drops X's exclusion does not mint a second child; archiving the standalone re-targets X", async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    await s.inPartner((tx) => detachSeriesChild(tx, { seriesId: series.id, orgId: s.orgA, reportId: child.id }, s.auth));

    const replaced = await s.inPartner((tx) => replaceSeriesTargets(
      series.id, { targetMode: 'all', orgIds: [] }, s.auth, tx, { mayAddDelivery: true },
    ));
    expect(replaced.reconcile.created).toBe(0);
    await reconcileAllSeries();
    expect((await activeReportsOf(s.orgA)).map((r) => r.id)).toEqual([child.id]);
    const detail = await withDbAccessContext(s.ctx, () => getSeriesDetail(series.id, s.auth));
    expect(detail.orgs.find((o) => o.orgId === s.orgA)?.state).toBe('excluded');

    await system(() => db.update(reports).set({ archivedAt: new Date() }).where(eq(reports.id, child.id)));
    await reconcileAllSeries();
    const again = await activeReportsOf(s.orgA);
    expect(again).toHaveLength(1);
    expect(again[0]?.seriesId).toBe(series.id);
  });

  it('a row cannot be both a child and a detached standalone (reports_detached_from_series_chk)', async () => {
    const s = await seed();
    const { series } = await s.inPartner((tx) => createSeries(input(s.owner), s.auth, tx, { mayAddDelivery: true }));
    const child = (await childrenOf(series.id)).find((c) => c.orgId === s.orgA)!;
    const err = await system(() => db.execute(sql`
      UPDATE reports SET detached_from_series_id = ${series.id} WHERE id = ${child.id}`)).then(() => null, (e: unknown) => e);
    const pg = err as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | null;
    expect(pg?.cause?.code ?? pg?.code).toBe('23514');
    expect(pg?.cause?.constraint_name ?? pg?.constraint_name).toBe('reports_detached_from_series_chk');
  });
});
