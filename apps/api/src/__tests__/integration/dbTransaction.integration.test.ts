import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, db, getCurrentDbAccessContext, hasDbAccessContext, withDbAccessContext, withDbTransaction, withDbTransactionIfHeld, withSystemDbAccessContextIsolated } from '../../db';
import { topologyManualNodes, sites } from '../../db/schema';
import { createTopologyTenant, orgContext } from './topology-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());
describe('ambient services in a driver-owned nested transaction', () => {
  // #11225: helpers for code that runs with or without a held context.
  it.each([
    ['withDbTransactionIfHeld', withDbTransactionIfHeld],
    ['withSystemDbAccessContextIsolated', withSystemDbAccessContextIsolated],
  ] as const)('%s isolates a caught failure in a held context and keeps its scope', async (_name, helper) => {
    const tenant = await createTopologyTenant(); const foreign = await createTopologyTenant();
    const context = orgContext(tenant.orgId);
    const [manual] = await getTestDb().insert(topologyManualNodes).values({ orgId: tenant.orgId, siteId: tenant.siteId, label: 'Before', role: 'switch' }).returning();
    await withDbAccessContext(context, async () => {
      await expect(helper(async () => {
        expect(getCurrentDbAccessContext()).toBe(context);
        // Still org scope: the foreign site stays invisible, so nothing escalated.
        expect(await db.select().from(sites).where(eq(sites.id, foreign.siteId))).toHaveLength(0);
        await db.update(topologyManualNodes).set({ label: 'Must roll back' }).where(eq(topologyManualNodes.id, manual!.id));
        await db.execute(sql`SELECT 1/0`);
      })).rejects.toThrow(/SELECT 1\/0/);
      await db.update(topologyManualNodes).set({ label: 'Outer commit' }).where(eq(topologyManualNodes.id, manual!.id));
    });
    expect((await getTestDb().select().from(topologyManualNodes).where(eq(topologyManualNodes.id, manual!.id)))[0]!.label).toBe('Outer commit');
  });
  it('withSystemDbAccessContextIsolated opens a system context when none is held', async () => {
    const scope = await withSystemDbAccessContextIsolated(async () => getCurrentDbAccessContext()?.scope);
    expect(scope).toBe('system');
    expect(getCurrentDbAccessContext()).toBeUndefined();
  });
  it('withDbTransactionIfHeld opens nothing when none is held, so a contextless caller keeps its scope', async () => {
    await expect(withDbTransactionIfHeld(async () => hasDbAccessContext())).resolves.toBe(false);
  });
  it('rejects a missing context before opening a transaction', async () => {
    await expect(withDbTransaction(async () => 1)).rejects.toThrow(/must run inside/);
    expect(getCurrentDbAccessContext()).toBeUndefined();
  });
  it('rolls back composed db helpers after a caught SQL failure and still commits the outer transaction', async () => {
    const tenant = await createTopologyTenant(); const foreign = await createTopologyTenant();
    const context = orgContext(tenant.orgId);
    const [manual] = await getTestDb().insert(topologyManualNodes).values({ orgId: tenant.orgId, siteId: tenant.siteId, label: 'Before', role: 'switch' }).returning();
    const updateFromHelper = (label: string) => db.update(topologyManualNodes).set({ label }).where(eq(topologyManualNodes.id, manual!.id));
    await withDbAccessContext(context, async () => {
      await expect(withDbTransaction(async () => {
        expect(getCurrentDbAccessContext()).toBe(context);
        expect(await db.select().from(sites).where(eq(sites.id, foreign.siteId))).toHaveLength(0);
        await updateFromHelper('Must roll back');
        await db.execute(sql`SELECT 1/0`);
      })).rejects.toThrow();
      expect(getCurrentDbAccessContext()).toBe(context);
      expect((await db.select().from(topologyManualNodes).where(eq(topologyManualNodes.id, manual!.id)))[0]!.label).toBe('Before');
      await updateFromHelper('Outer commit');
    });
    expect((await getTestDb().select().from(topologyManualNodes).where(eq(topologyManualNodes.id, manual!.id)))[0]!.label).toBe('Outer commit');
    expect(getCurrentDbAccessContext()).toBeUndefined();
  });
  it('CONTROL (#11203): db.transaction with a callback that ignores tx does not isolate, the ambient db stays on the outer scope', async () => {
    const tenant = await createTopologyTenant();
    await expect(withDbAccessContext(orgContext(tenant.orgId), async () => {
      await db.transaction(async () => { await db.execute(sql`SELECT 1/0`); }).catch(() => undefined);
      return 'caught';
    })).rejects.toThrow(/division by zero/);
  });
  it('restores the immediate executor after nested failures without changing RLS authority', async () => {
    const tenant = await createTopologyTenant(); const context = orgContext(tenant.orgId);
    const [manual] = await getTestDb().insert(topologyManualNodes).values({ orgId: tenant.orgId, siteId: tenant.siteId, label: 'Root', role: 'switch' }).returning();
    await withDbAccessContext(context, async () => {
      await expect(withDbTransaction(async () => {
        await db.update(topologyManualNodes).set({ label: 'Middle' }).where(eq(topologyManualNodes.id, manual!.id));
        await expect(withDbTransaction(async () => {
          await db.update(topologyManualNodes).set({ label: 'Inner' }).where(eq(topologyManualNodes.id, manual!.id));
          await db.execute(sql`SELECT 1/0`);
        })).rejects.toThrow();
        expect((await db.select().from(topologyManualNodes).where(eq(topologyManualNodes.id, manual!.id)))[0]!.label).toBe('Middle');
        expect(getCurrentDbAccessContext()).toBe(context);
        throw new Error('roll back middle');
      })).rejects.toThrow('roll back middle');
      expect((await db.select().from(topologyManualNodes).where(eq(topologyManualNodes.id, manual!.id)))[0]!.label).toBe('Root');
      expect(getCurrentDbAccessContext()).toBe(context);
    });
  });
});
