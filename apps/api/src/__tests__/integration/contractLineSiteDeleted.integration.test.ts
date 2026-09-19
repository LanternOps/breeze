/**
 * #4693, the headline regression: deleting a site must not silently widen a
 * site-scoped contract line to the whole organization.
 *
 * Before this wave: deleting a site nulls contract_lines.site_id (the FK's
 * ON DELETE SET NULL) and resolveLineQty then counts EVERY device in the org,
 * with nothing to distinguish it from a line that never had a site.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, sites, devices, contracts, contractLines, invoices,
  invoiceLines, contractBillingPeriods,
} from '../../db/schema';
import {
  computeContractEstimate, generateDueInvoice, listContracts,
  summarizeActiveContractMrrByOrg, type ContractActorT,
} from '../../services/contractService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed(opts: { scoped: boolean }) {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners).values({ name: `SD ${sfx}`, slug: `sd-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: 'SDO', slug: `sdo-${sfx}` }).returning({ id: organizations.id });
    const [dallas] = await db.insert(sites).values({ orgId: o!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [austin] = await db.insert(sites).values({ orgId: o!.id, name: `Austin ${sfx}` }).returning({ id: sites.id });
    const rows = [
      { siteId: dallas!.id, n: 2 }, { siteId: austin!.id, n: 3 },
    ].flatMap(({ siteId, n }) => Array.from({ length: n }, (_, i) => ({
      orgId: o!.id, siteId, agentId: `${siteId}-${i}-${sfx}`, hostname: `h${i}`, status: 'online' as const,
      osType: 'linux' as const, osVersion: '1', architecture: 'x86_64', agentVersion: '1', deviceRole: 'server' as const,
    })));
    await db.insert(devices).values(rows);
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: `C ${sfx}`, status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-08-01', currencyCode: 'USD',
    }).returning({ id: contracts.id, nextBillingAt: contracts.nextBillingAt });
    const [line] = await db.insert(contractLines).values({
      contractId: c!.id, orgId: o!.id, lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: false,
      ...(opts.scoped ? { siteId: dallas!.id, siteName: dallas!.name } : {}),
    }).returning({ id: contractLines.id });
    const actor: ContractActorT = {
      userId: null as unknown as string, partnerId: p!.id, accessibleOrgIds: [o!.id],
    };
    return { partnerId: p!.id, orgId: o!.id, dallas: dallas!, austin: austin!, contract: c!, lineId: line!.id, actor };
  });
}

async function deleteDallas(f: Awaited<ReturnType<typeof seed>>) {
  await withSystemDbAccessContext(async () => {
    // A site containing devices cannot be deleted. The product's delete flow
    // first reassigns them; preserve all five billable devices for the widening
    // regression, then exercise the contract-line FK directly.
    await db.update(devices).set({ siteId: f.austin.id }).where(eq(devices.siteId, f.dallas.id));
    await db.delete(sites).where(eq(sites.id, f.dallas.id));
  });
}

describe('#4693 — a deleted site stops billing instead of widening it', () => {
  runDb('estimate counts only the scoped site before the delete', async () => {
    const f = await seed({ scoped: true });
    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contract.id, f.actor));
    expect(est.lines[0]).toMatchObject({ quantity: 2 });
  });

  runDb('after the delete: id nulled, stamp kept, estimate unresolved, generation refuses, nothing written', async () => {
    const f = await seed({ scoped: true });
    await deleteDallas(f);

    const [line] = await withSystemDbAccessContext(() =>
      db.select({ siteId: contractLines.siteId, siteName: contractLines.siteName })
        .from(contractLines).where(eq(contractLines.id, f.lineId)));
    expect(line).toEqual({ siteId: null, siteName: f.dallas.name });

    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contract.id, f.actor));
    expect(est.lines[0]).toMatchObject({ quantity: 0, unresolved: 'site_deleted' });
    // The dead line covers nothing, so every live device in the org is uncovered —
    // the coverage notice must NOT say "all devices covered" beside a site-deleted line.
    const liveDevices = await withSystemDbAccessContext(() =>
      db.select({ id: devices.id }).from(devices).where(eq(devices.orgId, f.orgId)));
    expect(liveDevices.length).toBeGreaterThan(0);
    expect(est.uncoveredDevices).toMatchObject({ total: liveDevices.length });

    await expect(withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contract.id, new Date('2026-08-01T06:00:00Z')))))
      .rejects.toMatchObject({ name: 'ContractServiceError', status: 409, code: 'SITE_DELETED' });
    const written = await withSystemDbAccessContext(async () => ({
      invoices: await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, f.orgId)),
      lines: await db.select({ id: invoiceLines.id }).from(invoiceLines).where(eq(invoiceLines.orgId, f.orgId)),
      periods: await db.select({ id: contractBillingPeriods.id }).from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contract.id)),
      contract: await db.select({ nextBillingAt: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, f.contract.id)),
    }));
    expect(written.invoices).toHaveLength(0);
    expect(written.lines).toHaveLength(0);
    expect(written.periods).toHaveLength(0);
    expect(written.contract[0]!.nextBillingAt).toEqual(f.contract.nextBillingAt);
  });

  runDb('the list degrades to null and the MRR rollup skips the contract with one warning', async () => {
    const f = await seed({ scoped: true });
    await deleteDallas(f);
    const rows = await withSystemDbAccessContext(() => listContracts({ partnerId: f.partnerId } as never, f.actor));
    expect(rows.find((r) => r.id === f.contract.id)!.estimatedPeriodValue).toBeNull();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mrr = await withSystemDbAccessContext(() => summarizeActiveContractMrrByOrg([f.orgId]));
      expect(mrr.get(f.orgId) ?? []).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  runDb('a line that never had a site still bills org-wide — all five devices', async () => {
    const f = await seed({ scoped: false });
    const est = await withSystemDbAccessContext(() => computeContractEstimate(f.contract.id, f.actor));
    expect(est.lines[0]).toMatchObject({ quantity: 5 });
    expect(est.lines[0]).not.toHaveProperty('unresolved');
    const inv = await withSystemDbAccessContext(() => db.transaction(() => generateDueInvoice(f.contract.id, new Date('2026-08-01T06:00:00Z'))));
    expect(inv).toMatchObject({ generated: true });
  });
});
