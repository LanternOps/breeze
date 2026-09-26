/**
 * topology_view_exclusions (M2 Task 7): scoped, reversible per-view hides of a
 * canonical relationship. Seeds go through the breeze_app pool under an org
 * context; the role is asserted non-bypass so every denial below is real RLS
 * or a real composite-FK rejection, never a vacuous pass.
 */
import './setup';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createSite } from './db-utils';
import { createTopologyGraph, createTopologyTenant, orgContext } from './topology-fixtures';

const migrationFile = '2026-11-03-080400-topology-view-exclusions.sql';
const migration = () => readFile(new URL(`../../../migrations/${migrationFile}`, import.meta.url), 'utf8');
const scoped = <T>(orgId: string, action: () => Promise<T>) => withDbAccessContext(orgContext(orgId), action);
const rejected = (work: Promise<unknown>, code: string) => expect(work).rejects.toMatchObject({ cause: { code } });

async function relationshipOf(f: { orgId: string }) {
  const [row] = await scoped(f.orgId, () => db.execute(sql`SELECT id FROM topology_relationships WHERE org_id=${f.orgId}::uuid`));
  return row!.id as string;
}

async function exclude(f: { orgId: string; siteId: string }, relationshipId: string, view = 'physical', reason = 'duplicate uplink') {
  const [row] = await scoped(f.orgId, () => db.execute(sql`INSERT INTO topology_view_exclusions (org_id,site_id,relationship_id,view,reason,created_by)
    VALUES (${f.orgId}::uuid,${f.siteId}::uuid,${relationshipId}::uuid,${view},${reason},gen_random_uuid()) RETURNING id`));
  return row!.id as string;
}

describe('topology_view_exclusions', () => {
  it('runs as a non-bypass breeze_app role with RLS enabled and forced', async () => {
    const role = await db.execute(sql`SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role[0]).toMatchObject({ current_user: 'breeze_app', rolsuper: false, rolbypassrls: false });
    const [cls] = await db.execute(sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.topology_view_exclusions'::regclass`);
    expect(cls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await db.execute(sql`SELECT policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename='topology_view_exclusions' ORDER BY policyname`);
    expect(policies.map(p => p.policyname)).toEqual(['breeze_org_isolation_delete', 'breeze_org_isolation_insert', 'breeze_org_isolation_select', 'breeze_org_isolation_update']);
  });

  it('every FK is deferrable and initially immediate', async () => {
    const fks = await db.execute(sql`SELECT conname, condeferrable, condeferred, confdeltype FROM pg_constraint
      WHERE conrelid='public.topology_view_exclusions'::regclass AND contype='f' ORDER BY conname`);
    expect(fks.map(f => f.conname)).toEqual(['topology_view_exclusions_relationship_scope_fk', 'topology_view_exclusions_site_scope_fk']);
    for (const fk of fks) expect(fk).toMatchObject({ condeferrable: true, condeferred: false, confdeltype: 'c' });
  });

  it('isolates rows across orgs for SELECT/UPDATE/DELETE and rejects forged INSERT', async () => {
    const a = await createTopologyGraph(); const b = await createTopologyTenant();
    const rel = await relationshipOf(a); const id = await exclude(a, rel);
    const own = sql`id = ${id}::uuid`;
    expect(await scoped(a.orgId, () => db.execute(sql`SELECT id FROM topology_view_exclusions WHERE ${own}`))).toHaveLength(1);
    expect(await scoped(b.orgId, () => db.execute(sql`SELECT id FROM topology_view_exclusions WHERE ${own}`))).toHaveLength(0);
    expect(await scoped(b.orgId, () => db.execute(sql`UPDATE topology_view_exclusions SET reason='x' WHERE ${own} RETURNING id`))).toHaveLength(0);
    expect(await scoped(b.orgId, () => db.execute(sql`DELETE FROM topology_view_exclusions WHERE ${own} RETURNING id`))).toHaveLength(0);
    expect(await withSystemDbAccessContext(() => db.execute(sql`SELECT reason FROM topology_view_exclusions WHERE ${own}`))).toEqual([{ reason: 'duplicate uplink' }]);
    await rejected(scoped(b.orgId, () => db.execute(sql`INSERT INTO topology_view_exclusions (org_id,site_id,relationship_id,view,reason)
      VALUES (${a.orgId}::uuid,${a.siteId}::uuid,${rel}::uuid,'logical','forged')`)), '42501');
    await rejected(scoped(a.orgId, () => db.execute(sql`UPDATE topology_view_exclusions SET org_id=${b.orgId}::uuid WHERE ${own}`)), '42501');
  });

  it('rejects a relationship from another site forged with local org/site values', async () => {
    const a = await createTopologyGraph();
    const otherSite = await createSite({ orgId: a.orgId });
    const rel = await relationshipOf(a);
    // Same org, so RLS sees the relationship; only the composite scope FK can reject it.
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_view_exclusions (org_id,site_id,relationship_id,view,reason)
      VALUES (${a.orgId}::uuid,${otherSite.id}::uuid,${rel}::uuid,'physical','forged scope')`)), '23503');
    const b = await createTopologyGraph();
    const foreignRel = await relationshipOf(b);
    await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_view_exclusions (org_id,site_id,relationship_id,view,reason)
      VALUES (${a.orgId}::uuid,${a.siteId}::uuid,${foreignRel}::uuid,'physical','foreign relationship')`)), '23503');
  });

  it('enforces view and reason domains', async () => {
    const a = await createTopologyGraph(); const rel = await relationshipOf(a);
    for (const [view, reason] of [['topology', 'ok'], ['physical', ''], ['physical', 'x'.repeat(501)]] as const) {
      await rejected(scoped(a.orgId, () => db.execute(sql`INSERT INTO topology_view_exclusions (org_id,site_id,relationship_id,view,reason)
        VALUES (${a.orgId}::uuid,${a.siteId}::uuid,${rel}::uuid,${view},${reason})`)), view === 'topology' || reason === '' ? '23514' : '22001');
    }
    await exclude(a, rel, 'overview', 'x'.repeat(500));
  });

  it('allows one active exclusion per view, and re-creation after revoke', async () => {
    const a = await createTopologyGraph(); const rel = await relationshipOf(a);
    const first = await exclude(a, rel, 'physical');
    await exclude(a, rel, 'logical');
    await rejected(exclude(a, rel, 'physical', 'again'), '23505');
    await scoped(a.orgId, () => db.execute(sql`UPDATE topology_view_exclusions SET revoked_at=now(), revoked_by=gen_random_uuid(), updated_at=now() WHERE id=${first}::uuid`));
    const second = await exclude(a, rel, 'physical', 'again');
    expect(second).not.toBe(first);
    const rows = await scoped(a.orgId, () => db.execute(sql`SELECT id FROM topology_view_exclusions WHERE relationship_id=${rel}::uuid AND view='physical' ORDER BY created_at`));
    expect(rows).toHaveLength(2);
  });

  it('cascades when the parent relationship is deleted', async () => {
    const a = await createTopologyGraph(); const rel = await relationshipOf(a);
    await exclude(a, rel, 'physical'); await exclude(a, rel, 'overview');
    await scoped(a.orgId, () => db.execute(sql`DELETE FROM topology_relationships WHERE id=${rel}::uuid`));
    expect(await withSystemDbAccessContext(() => db.execute(sql`SELECT id FROM topology_view_exclusions WHERE relationship_id=${rel}::uuid`))).toHaveLength(0);
  });

  it('re-applying the migration is a no-op', async () => {
    const a = await createTopologyGraph(); const rel = await relationshipOf(a); await exclude(a, rel);
    const snapshot = async () => ({
      constraints: await db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='public.topology_view_exclusions'::regclass ORDER BY conname`),
      policies: await db.execute(sql`SELECT policyname FROM pg_policies WHERE tablename='topology_view_exclusions' ORDER BY policyname`),
      indexes: await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename='topology_view_exclusions' ORDER BY indexname`),
      rows: await withSystemDbAccessContext(() => db.execute(sql`SELECT count(*)::int AS n FROM topology_view_exclusions`)),
    });
    const before = await snapshot();
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      await admin.begin(async tx => { await tx.unsafe(await migration()); });
      await admin.begin(async tx => { await tx.unsafe(await migration()); });
    } finally { await admin.end(); }
    expect(await snapshot()).toEqual(before);
  });
});
