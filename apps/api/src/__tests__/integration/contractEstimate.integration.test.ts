/**
 * Real-DB tests for the contract recurring-value estimate (computeContractEstimate)
 * and the listContracts estimatedPeriodValue enrichment.
 *
 * Exercises per-line-type quantity resolution against a real Postgres:
 *   flat → 1, manual → manualQuantity, per_device → live device count
 *   (optionally site-scoped), per_seat → live active-seat count.
 * The per_device-org-wide vs per_device-site-scoped pair specifically guards the
 * memoization cache key `${orgId}|${siteId ?? 'all'}` — a key that ignored siteId
 * would return the same (wrong) count for both lines and silently mis-bill.
 *
 * Per-test inline seeding (setup.ts TRUNCATEs CASCADE in beforeEach).
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, users, organizationUsers, roles } from '../../db/schema';
import {
  createContract, addContractLineToContract, computeContractEstimate, listContracts,
  type ContractActorT,
} from '../../services/contractService';

interface Fixture { partnerId: string; orgId: string; siteAId: string }

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `EP ${sfx}`, slug: `ep-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: 'EOrg', slug: `eo-${sfx}` })
      .returning({ id: organizations.id });
    const orgId = o!.id;
    const [sA, sB] = await db.insert(sites)
      .values([{ orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` }])
      .returning({ id: sites.id });

    // 3 billable devices (2 on siteA, 1 on siteB) + 1 decommissioned (excluded).
    await db.insert(devices).values([
      { orgId, siteId: sA!.id, agentId: `e1-${sfx}`, hostname: 'e1', status: 'online', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      { orgId, siteId: sA!.id, agentId: `e2-${sfx}`, hostname: 'e2', status: 'offline', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      { orgId, siteId: sB!.id, agentId: `e3-${sfx}`, hostname: 'e3', status: 'online', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      { orgId, siteId: sB!.id, agentId: `e4-${sfx}`, hostname: 'e4', status: 'decommissioned', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
    ]);

    // 2 active seats.
    const [r] = await db.insert(roles)
      .values({ name: `ERole ${sfx}`, scope: 'organization', partnerId: p!.id, orgId })
      .returning({ id: roles.id });
    const [u1, u2] = await db.insert(users).values([
      { partnerId: p!.id, orgId, email: `e1-${sfx}@x.io`, name: 'E1', status: 'active' },
      { partnerId: p!.id, orgId, email: `e2-${sfx}@x.io`, name: 'E2', status: 'active' },
    ]).returning({ id: users.id });
    await db.insert(organizationUsers).values([
      { orgId, userId: u1!.id, roleId: r!.id }, { orgId, userId: u2!.id, roleId: r!.id },
    ]);

    return { partnerId: p!.id, orgId, siteAId: sA!.id };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('computeContractEstimate (breeze_app, real DB)', () => {
  runDb('resolves every line type from live counts and sums the period total', async () => {
    const f = await seedFixture();
    const actor: ContractActorT = { userId: null as unknown as string, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };

    const c = await withSystemDbAccessContext(() => createContract({
      orgId: f.orgId, name: 'Estimate Co', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01',
    }, actor));

    const flat = await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'flat', description: 'Flat', unitPrice: '500.00', taxable: false }, actor));
    const perDevAll = await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'per_device', description: 'Per device (all)', unitPrice: '15.00', taxable: true }, actor));
    const perDevSiteA = await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'per_device', description: 'Per device (siteA)', unitPrice: '10.00', taxable: true, siteId: f.siteAId }, actor));
    const perSeat = await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'per_seat', description: 'Per seat', unitPrice: '20.00', taxable: false }, actor));
    const manual = await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'manual', description: 'Manual', unitPrice: '50.00', taxable: false, manualQuantity: '3' }, actor));

    const est = await withSystemDbAccessContext(() => computeContractEstimate(c.id, actor));
    const byId = new Map(est.lines.map((l) => [l.lineId, l]));

    expect(byId.get(flat.id)).toMatchObject({ quantity: 1, value: '500.00', live: false });
    // org-wide per_device = 3 billable (decommissioned excluded)
    expect(byId.get(perDevAll.id)).toMatchObject({ quantity: 3, value: '45.00', live: true });
    // site-scoped per_device = 2 on siteA — proves the memo key includes siteId
    expect(byId.get(perDevSiteA.id)).toMatchObject({ quantity: 2, value: '20.00', live: true });
    expect(byId.get(perSeat.id)).toMatchObject({ quantity: 2, value: '40.00', live: true });
    expect(byId.get(manual.id)).toMatchObject({ quantity: 3, value: '150.00', live: false });

    // 500 + 45 + 20 + 40 + 150
    expect(est.periodTotal).toBe('755.00');
    expect(est.currencyCode).toBe('USD');
  });

  runDb('listContracts enriches each row with estimatedPeriodValue', async () => {
    const f = await seedFixture();
    const actor: ContractActorT = { userId: null as unknown as string, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };

    const c = await withSystemDbAccessContext(() => createContract({
      orgId: f.orgId, name: 'List Co', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01',
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'flat', description: 'Flat', unitPrice: '100.00', taxable: false }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, { lineType: 'per_device', description: 'Per device', unitPrice: '15.00', taxable: true }, actor));

    const rows = await withSystemDbAccessContext(() => listContracts({}, actor));
    const row = rows.find((r) => r.id === c.id) as (typeof rows[number] & { estimatedPeriodValue?: string });
    // 100 (flat) + 3×15 (per_device org-wide) = 145.00
    expect(row?.estimatedPeriodValue).toBe('145.00');
  });
});
