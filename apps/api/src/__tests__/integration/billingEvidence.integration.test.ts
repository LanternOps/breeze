/**
 * #3205 W07 (#4656) — the headline suite. Every assertion is about what
 * generateDueInvoice PERSISTED, never about what it returned.
 *
 * The disposition invariants, in the terms W04 bills in, for a device line
 * matching M devices with allowance N:
 *   included rows = min(M, N);  tail rows = max(0, M - N);
 *   base invoice-line quantity = N under a fixed allowance, REGARDLESS of M.
 * `included + tail === M` is the only unconditional identity — evidence row
 * count != invoice quantity for every allowance line.
 */
import './setup';
import { getTestDb } from './setup';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { sql, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, sites, devices, deviceGroups, contracts, contractLines, invoices, invoiceLines,
  invoiceLineDevices, contractBillingPeriods, contractBillingPeriodOutcomes,
  users, roles, organizationUsers,
} from '../../db/schema';
import { computeContractEstimate, getContract, materializeContractLineOntoInvoice, generateDueInvoice } from '../../services/contractService';
import { createManualInvoice, removeLine, updateLine } from '../../services/invoiceService';
import type { DeviceRole } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';

// Endpoint-level pagination uses the real route and service against Postgres;
// auth itself is covered by the route-unit suite, so these two gates simply
// admit the system actor installed by the local Hono harness below.
vi.mock('../../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/auth')>()),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
}));

import { invoiceEvidenceRoutes } from '../../routes/invoices/evidence';

/** The generation path is system-scoped; these two draft-line writers are not. */
const ACTOR = { userId: null, partnerId: null, accessibleOrgIds: null } as const;

interface Seeded { partnerId: string; orgId: string; siteId: string; contractId: string }

interface LineSpec {
  lineType: 'per_device' | 'per_device_role' | 'per_seat' | 'flat' | 'manual';
  includedQuantity?: string | null;
  overageMode?: 'bill' | 'flag' | null;
  overageUnitPrice?: string | null;
  deviceRoles?: DeviceRole[] | null;
  manualQuantity?: string | null;
}

async function seedContract(hostnames: string[], line: LineSpec): Promise<Seeded> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `EV ${sfx}`, slug: `ev-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: `EO ${sfx}`, slug: `eo-${sfx}` })
      .returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: `ES-${sfx}` }).returning({ id: sites.id });
    if (hostnames.length) {
      await db.insert(devices).values(hostnames.map((h, i) => ({
        orgId: o!.id, siteId: s!.id, agentId: `agent-${sfx}-${i}`, hostname: h,
        status: 'online' as const, deviceRole: 'server' as const, osType: 'linux' as const, osVersion: '22.04',
        architecture: 'x86_64', agentVersion: '1.0.0',
      })));
    }
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: `C ${sfx}`, status: 'active', intervalMonths: 1,
      startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({
      contractId: c!.id, orgId: o!.id, lineType: line.lineType, description: 'Endpoints',
      unitPrice: '10.00', taxable: false, sortOrder: 0,
      includedQuantity: line.includedQuantity ?? null,
      overageMode: line.overageMode ?? null,
      overageUnitPrice: line.overageMode === 'flag' ? null : line.overageUnitPrice ?? null,
      deviceRoles: line.deviceRoles ?? null,
      manualQuantity: line.manualQuantity ?? null,
    });
    return { partnerId: p!.id, orgId: o!.id, siteId: s!.id, contractId: c!.id };
  });
}

async function seedContractWithSeats(count: number, line: LineSpec): Promise<Seeded> {
  const seeded = await seedContract([], line);
  await withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [role] = await db.insert(roles).values({
      partnerId: seeded.partnerId, orgId: seeded.orgId, scope: 'organization', name: `Seat ${sfx}`,
    }).returning({ id: roles.id });
    const seatUsers = await db.insert(users).values(Array.from({ length: count }, (_, i) => ({
      partnerId: seeded.partnerId, orgId: seeded.orgId, email: `ev-${sfx}-${i}@example.test`,
      name: `Evidence Seat ${i}`, status: 'active' as const,
    }))).returning({ id: users.id });
    await db.insert(organizationUsers).values(seatUsers.map((user) => ({
      orgId: seeded.orgId, userId: user.id, roleId: role!.id,
    })));
  });
  return seeded;
}

async function seedContractWithUnevaluableGroupLine(): Promise<Seeded> {
  const seeded = await seedContract([], { lineType: 'flat' });
  await withSystemDbAccessContext(async () => {
    const [group] = await db.insert(deviceGroups).values({
      orgId: seeded.orgId, name: 'Malformed evidence group', type: 'dynamic', filterConditions: { broken: true },
    }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    await db.update(contractLines).set({
      lineType: 'per_device_group', deviceGroupId: group!.id, deviceGroupName: group!.name,
    }).where(eq(contractLines.contractId, seeded.contractId));
  });
  return seeded;
}

const generate = (contractId: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(() =>
    generateDueInvoice(contractId, new Date('2026-07-01T12:00:00Z'))));

async function evidenceFor(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({
      lineId: invoiceLineDevices.invoiceLineId, hostname: invoiceLineDevices.hostname,
      countedAs: invoiceLineDevices.countedAs, deviceId: invoiceLineDevices.deviceId,
      siteId: invoiceLineDevices.siteId, deviceRole: invoiceLineDevices.deviceRole,
      orgId: invoiceLineDevices.orgId, invoiceId: invoiceLineDevices.invoiceId,
    })
    .from(invoiceLineDevices)
    .where(eq(invoiceLineDevices.invoiceId, invoiceId))
    .orderBy(invoiceLineDevices.hostname, invoiceLineDevices.deviceId));
}

async function linesFor(invoiceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: invoiceLines.id, description: invoiceLines.description, quantity: invoiceLines.quantity })
    .from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));
}

const hosts = (n: number, prefix = 'host') =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('billing evidence at generation (real DB) #3205 W07', () => {
  runDb('interactive materialization records devices on manual and generated drafts without changing period outcomes (#4837)', async () => {
    const f = await seedContract(['zulu', 'alpha'], { lineType: 'per_device', includedQuantity: '1.00', overageMode: 'bill', overageUnitPrice: '12.00' });
    const generated = await generate(f.contractId);
    const actor = { ...ACTOR, partnerId: f.partnerId };
    await withSystemDbAccessContext(async () => {
      const manual = await createManualInvoice({ orgId: f.orgId }, actor);
      const before = await db.select().from(contractBillingPeriodOutcomes);
      const { contract, lines } = await getContract(f.contractId, { ...actor, userId: '00000000-0000-4000-8000-000000000001' });
      for (const invoiceId of [manual.id, generated.invoiceId!]) {
        const evidence = new Map<string, readonly import('../../services/contractQuantities').DeviceSnapshotRow[]>();
        const estimate = await computeContractEstimate(f.contractId, { ...actor, userId: '00000000-0000-4000-8000-000000000001' }, evidence);
        const est = estimate.lines[0]!;
        const added = await materializeContractLineOntoInvoice(actor, {
          invoiceId, contract, line: lines[0]!, currencyCode: contract.currencyCode,
          resolved: { counted: est.counted, billed: est.quantity, included: est.included, overage: est.overage, overageMode: est.overageMode },
          deviceEvidence: evidence.get(lines[0]!.id),
        });
        const rows = await db.select().from(invoiceLineDevices).where(eq(invoiceLineDevices.invoiceLineId, added.baseLine.id));
        expect(rows).toMatchObject([{ hostname: 'alpha', countedAs: 'included', orgId: f.orgId }]);
        const tail = await db.select().from(invoiceLineDevices).where(eq(invoiceLineDevices.invoiceLineId, added.overageLine!.id));
        expect(tail).toMatchObject([{ hostname: 'zulu', countedAs: 'overage' }]);
        const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
        expect(invoice!.evidenceVersion).toBe(1);
      }
      expect(await db.select().from(contractBillingPeriodOutcomes)).toEqual(before);
    });
  });

  runDb('interactive evidence failure rolls back the base line and invoice marker (#4837)', async () => {
    const f = await seedContract(['alpha'], { lineType: 'per_device' });
    const actor = { ...ACTOR, partnerId: f.partnerId };
    const manual = await withSystemDbAccessContext(() => createManualInvoice({ orgId: f.orgId }, actor));
    await expect(withSystemDbAccessContext(async () => {
      const { contract, lines } = await getContract(f.contractId, { ...actor, userId: '00000000-0000-4000-8000-000000000001' });
      // A nonexistent device violates the FK after the base line was written.
      await materializeContractLineOntoInvoice(actor, {
        invoiceId: manual.id, contract, line: lines[0]!, currencyCode: contract.currencyCode,
        resolved: { counted: 1, billed: 1, included: null, overage: 0, overageMode: null },
        deviceEvidence: [{ id: '00000000-0000-4000-8000-000000000099', hostname: 'missing', role: 'server', siteId: null }],
      });
    })).rejects.toThrow();
    await withSystemDbAccessContext(async () => {
      expect(await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, manual.id))).toEqual([]);
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, manual.id));
      expect(invoice!.evidenceVersion).toBeNull();
    });
  });

  runDb('GET evidence pages by (hostname, evidence-row id) without overlap across duplicate hostnames', async () => {
    const f = await seedContract(['dup', 'dup', 'dup'], { lineType: 'per_device' });
    const generated = await generate(f.contractId);
    const [line] = await linesFor(generated.invoiceId!);

    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use('*', async (c, next) => {
      c.set('auth', {
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          email: 'billing-evidence@example.test',
          name: 'Billing Evidence',
          isPlatformAdmin: true,
        },
        scope: 'system', partnerId: null, orgId: null, accessibleOrgIds: null,
      } as AuthContext);
      await next();
    });
    app.route('/', invoiceEvidenceRoutes);

    const page1Res = await withSystemDbAccessContext(async () => app.request(
      `/${generated.invoiceId}/lines/${line!.id}/devices?limit=2`,
    ));
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json() as any).data;
    expect(page1.devices).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2Res = await withSystemDbAccessContext(async () => app.request(
      `/${generated.invoiceId}/lines/${line!.id}/devices?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
    ));
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json() as any).data;
    expect(page2.devices).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect([...page1.devices, ...page2.devices].map((d: any) => d.hostname)).toEqual(['dup', 'dup', 'dup']);
    expect(new Set([...page1.devices, ...page2.devices].map((d: any) => d.id)).size).toBe(3);
  });

  // ---------------------------------------------------------------- matrix
  runDb('no allowance, M=12 -> 12 included on the base line, 0 tail, quantity 12.00', async () => {
    const f = await seedContract(hosts(12), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    expect(res.generated).toBe(true);
    const [base, ...rest] = await linesFor(res.invoiceId!);
    expect(rest).toEqual([]);
    expect(base!.quantity).toBe('12.00');
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev).toHaveLength(12);
    expect(ev.every((r) => r.countedAs === 'included' && r.lineId === base!.id)).toBe(true);
    expect(Number(base!.quantity)).toBe(ev.length);
  });

  runDb('M=3, N=25, bill -> 3 included, 0 tail, but quantity is 25.00 (row count != quantity)', async () => {
    const f = await seedContract(hosts(3), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });
    const res = await generate(f.contractId);
    const lines = await linesFor(res.invoiceId!);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe('25.00');
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev).toHaveLength(3);
    expect(ev.every((r) => r.countedAs === 'included')).toBe(true);
  });

  runDb('M=25, N=25, either mode -> 25 included, 0 tail, quantity 25.00, no overage line', async () => {
    for (const mode of ['bill', 'flag'] as const) {
      const f = await seedContract(hosts(25), {
        lineType: 'per_device', includedQuantity: '25', overageMode: mode, overageUnitPrice: '12.00',
      });
      const res = await generate(f.contractId);
      const lines = await linesFor(res.invoiceId!);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.quantity).toBe('25.00');
      const ev = await evidenceFor(res.invoiceId!);
      expect(ev).toHaveLength(25);
      expect(ev.filter((r) => r.countedAs === 'included')).toHaveLength(25);
    }
  });

  runDb('M=30, N=25, bill -> 25 included on the base line + 5 overage on the OVERAGE line', async () => {
    const f = await seedContract(hosts(30), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });
    const res = await generate(f.contractId);
    const lines = await linesFor(res.invoiceId!);
    expect(lines).toHaveLength(2);
    const [base, overage] = lines;
    expect(base!.quantity).toBe('25.00');
    expect(overage!.quantity).toBe('5.00');
    const ev = await evidenceFor(res.invoiceId!);
    const included = ev.filter((r) => r.countedAs === 'included');
    const tail = ev.filter((r) => r.countedAs === 'overage');
    expect(included).toHaveLength(25);
    expect(tail).toHaveLength(5);
    expect(included.every((r) => r.lineId === base!.id)).toBe(true);
    expect(tail.every((r) => r.lineId === overage!.id)).toBe(true);
    expect(included.length + tail.length).toBe(30);
    expect(ev.length).toBe(Number(base!.quantity) + Number(overage!.quantity));
    expect(tail.map((r) => r.hostname)).toEqual(['host-026', 'host-027', 'host-028', 'host-029', 'host-030']);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.billedOverageTotal).toBe(5);
    expect(outcome!.flaggedTotal).toBe(0);
  });

  runDb('M=30, N=25, flag -> 25 included + 5 flagged, BOTH on the base line, no overage invoice line', async () => {
    const f = await seedContract(hosts(30), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'flag', overageUnitPrice: null,
    });
    const res = await generate(f.contractId);
    const lines = await linesFor(res.invoiceId!);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe('25.00');
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev.filter((r) => r.countedAs === 'included')).toHaveLength(25);
    const flagged = ev.filter((r) => r.countedAs === 'flagged');
    expect(flagged).toHaveLength(5);
    expect(flagged.every((r) => r.lineId === lines[0]!.id)).toBe(true);
    expect(ev).toHaveLength(30);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.flaggedTotal).toBe(5);
    expect(outcome!.billedOverageTotal).toBe(0);
  });

  // ---------------------------------------------------------------- ordering
  runDb('canonical order is code-unit hostname then device id — duplicates, mixed case, non-ASCII', async () => {
    const f = await seedContract(['dup', 'dup', 'Alpha', 'zürich'], {
      lineType: 'per_device', includedQuantity: '2', overageMode: 'flag',
    });
    const res = await generate(f.contractId);
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev.map((r) => r.hostname)).toEqual(['Alpha', 'dup', 'dup', 'zürich']);
    expect(ev.map((r) => r.countedAs)).toEqual(['included', 'included', 'flagged', 'flagged']);
    const dups = ev.filter((r) => r.hostname === 'dup');
    expect(dups[0]!.deviceId! < dups[1]!.deviceId!).toBe(true);
  });

  runDb('determinism is an assignment PROJECTION: two runs over the same fleet agree on device -> counted_as', async () => {
    const f = await seedContract(hosts(30), {
      lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
    });
    const first = await generate(f.contractId);
    const second = await withSystemDbAccessContext(async () => {
      const [c2] = await db.insert(contracts).values({
        partnerId: f.partnerId, orgId: f.orgId, name: 'C2', status: 'active', intervalMonths: 1,
        startDate: '2026-07-01', nextBillingAt: '2026-07-01', currencyCode: 'USD', billingTiming: 'advance',
      }).returning({ id: contracts.id });
      await db.insert(contractLines).values({
        contractId: c2!.id, orgId: f.orgId, lineType: 'per_device', description: 'Endpoints',
        unitPrice: '10.00', taxable: false, sortOrder: 0,
        includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00',
      });
      return c2!.id;
    });
    const other = await generate(second);
    const proj = async (invoiceId: string) =>
      Object.fromEntries((await evidenceFor(invoiceId)).map((r) => [r.deviceId!, r.countedAs]));
    expect(await proj(other.invoiceId!)).toEqual(await proj(first.invoiceId!));
  });

  // ---------------------------------------------------------------- non-device lines
  runDb('per_seat, flat and manual lines write ZERO evidence rows and still get an outcome row', async () => {
    for (const spec of [
      { lineType: 'per_seat' as const, includedQuantity: '5', overageMode: 'flag' as const },
      { lineType: 'flat' as const },
      { lineType: 'manual' as const, manualQuantity: '3' },
    ]) {
      const f = await seedContract(hosts(4), spec);
      const res = await generate(f.contractId);
      expect(await evidenceFor(res.invoiceId!)).toEqual([]);
      const outcomes = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes)
        .where(eq(contractBillingPeriodOutcomes.invoiceId, res.invoiceId!)));
      expect(outcomes).toHaveLength(1);
    }
  });

  runDb('an OVER per_seat line contributes to flagged_total and overages with NO device rows (decision 7)', async () => {
    const f = await seedContractWithSeats(8, { lineType: 'per_seat', includedQuantity: '5', overageMode: 'flag' });
    const res = await generate(f.contractId);
    expect(await evidenceFor(res.invoiceId!)).toEqual([]);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.flaggedTotal).toBe(3);
    expect(outcome!.overages).toMatchObject([{ counted: 8, included: 5, overage: 3, mode: 'flag' }]);
    expect(outcome!.snapshotDeviceTotal).toBe(0);
  });

  runDb('a flat-only contract records snapshot_device_total = 0 AND evidence_version = 1', async () => {
    const f = await seedContract(hosts(7), { lineType: 'flat' });
    const res = await generate(f.contractId);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.snapshotDeviceTotal).toBe(0);
    expect(outcome!.uncoveredTotal).toBe(0);
    expect(outcome!.uncoveredByRole).toEqual({});
    expect(outcome!.overages).toEqual([]);
    const [inv] = await withSystemDbAccessContext(() => db.select({ v: invoices.evidenceVersion })
      .from(invoices).where(eq(invoices.id, res.invoiceId!)));
    expect(inv!.v).toBe(1);
  });

  runDb('uncovered totals equal uncoveredByRole for the same fixture, and snapshot_device_total is the snapshot length', async () => {
    const f = await seedContract([], { lineType: 'per_device_role', deviceRoles: ['server'] });
    await withSystemDbAccessContext(async () => {
      await db.insert(devices).values([
        ...['s1', 's2', 's3'].map((h, i) => ({ orgId: f.orgId, siteId: f.siteId, agentId: `a-s-${i}`, hostname: h,
          status: 'online' as const, deviceRole: 'server' as const, osType: 'linux' as const, osVersion: '22.04',
          architecture: 'x86_64', agentVersion: '1.0.0' })),
        ...['p1', 'p2'].map((h, i) => ({ orgId: f.orgId, siteId: f.siteId, agentId: `a-p-${i}`, hostname: h,
          status: 'online' as const, deviceRole: 'printer' as const, osType: 'linux' as const, osVersion: '22.04',
          architecture: 'x86_64', agentVersion: '1.0.0' })),
      ]);
    });
    const res = await generate(f.contractId);
    const [outcome] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcome!.snapshotDeviceTotal).toBe(5);
    expect(outcome!.uncoveredTotal).toBe(2);
    expect(outcome!.uncoveredByRole).toEqual({ printer: 2 });
    expect(res.uncoveredDevices).toEqual({ total: 2, byRole: { printer: 2 } });
    expect(await evidenceFor(res.invoiceId!)).toHaveLength(3);
  });

  // ---------------------------------------------------------------- atomicity
  runDb('a LOST claim race leaves zero evidence, zero outcomes, and no draft', async () => {
    const f = await seedContract(hosts(5), { lineType: 'per_device' });
    await withSystemDbAccessContext(() => db.insert(contractBillingPeriods).values({
      contractId: f.contractId, orgId: f.orgId, periodStart: '2026-07-01', periodEnd: '2026-07-31',
    }));
    const res = await generate(f.contractId);
    expect(res.generated).toBe(false);
    expect(res.skipped).toBe('already_billed');
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0 }]);
  });

  runDb('a throw AFTER the lines are written leaves no invoice, no claim, no evidence', async () => {
    const f = await seedContract(hosts(5), { lineType: 'per_device' });
    const adminDb = getTestDb();
    await adminDb.execute(sql`CREATE OR REPLACE FUNCTION billing_evidence_fail_outcome()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected outcome failure'; END $$`);
    await adminDb.execute(sql`CREATE TRIGGER billing_evidence_fail_outcome_trigger
      BEFORE INSERT ON contract_billing_period_outcomes
      FOR EACH ROW EXECUTE FUNCTION billing_evidence_fail_outcome()`);
    try {
      await expect(generate(f.contractId)).rejects.toThrow();
    } finally {
      await adminDb.execute(sql`DROP TRIGGER IF EXISTS billing_evidence_fail_outcome_trigger ON contract_billing_period_outcomes`);
      await adminDb.execute(sql`DROP FUNCTION IF EXISTS billing_evidence_fail_outcome()`);
    }
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv,
             (SELECT count(*) FROM contract_billing_periods)::int AS per
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0, per: 0 }]);
  });

  runDb('1,200 rows land across chunked statements in one transaction', async () => {
    const f = await seedContract(hosts(1200), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    const ev = await evidenceFor(res.invoiceId!);
    expect(ev).toHaveLength(1200);
    expect(new Set(ev.map((r) => r.deviceId)).size).toBe(1200);
    const [base] = await linesFor(res.invoiceId!);
    expect(base!.quantity).toBe('1200.00');
  }, 60_000);

  runDb('a throw injected on the THIRD chunk leaves zero evidence, no claim and no invoice', async () => {
    const f = await seedContract(hosts(1200), { lineType: 'per_device' });
    const adminDb = getTestDb();
    await adminDb.execute(sql`CREATE OR REPLACE FUNCTION billing_evidence_fail_third_chunk()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM invoice_line_devices) >= 1000 THEN
          RAISE EXCEPTION 'injected chunk failure';
        END IF;
        RETURN NEW;
      END $$`);
    await adminDb.execute(sql`CREATE TRIGGER billing_evidence_fail_third_chunk_trigger
      BEFORE INSERT ON invoice_line_devices
      FOR EACH ROW EXECUTE FUNCTION billing_evidence_fail_third_chunk()`);
    try {
      await expect(generate(f.contractId)).rejects.toThrow();
    } finally {
      await adminDb.execute(sql`DROP TRIGGER IF EXISTS billing_evidence_fail_third_chunk_trigger ON invoice_line_devices`);
      await adminDb.execute(sql`DROP FUNCTION IF EXISTS billing_evidence_fail_third_chunk()`);
    }
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv,
             (SELECT count(*) FROM contract_billing_periods)::int AS per
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0, per: 0 }]);
  }, 60_000);

  runDb('a GROUP_EVALUATION_FAILED throw leaves no invoice, no claim and no evidence', async () => {
    const f = await seedContractWithUnevaluableGroupLine();
    await expect(generate(f.contractId)).rejects.toMatchObject({ code: 'GROUP_EVALUATION_FAILED' });
    const counts = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT (SELECT count(*) FROM invoice_line_devices)::int AS ev,
             (SELECT count(*) FROM contract_billing_period_outcomes)::int AS oc,
             (SELECT count(*) FROM invoices)::int AS inv,
             (SELECT count(*) FROM contract_billing_periods)::int AS per
    `));
    expect(counts).toEqual([{ ev: 0, oc: 0, inv: 0, per: 0 }]);
  });

  // ---------------------------------------------------------------- draft-line rules
  runDb('deleting a draft invoice LINE deletes its evidence (FK cascade)', async () => {
    const f = await seedContract(hosts(4), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    const [base] = await linesFor(res.invoiceId!);
    await withSystemDbAccessContext(() => removeLine(res.invoiceId!, base!.id, ACTOR));
    expect(await evidenceFor(res.invoiceId!)).toEqual([]);
  });

  runDb('editing a draft line QUANTITY leaves every evidence row and the period outcome untouched', async () => {
    const f = await seedContract(hosts(4), { lineType: 'per_device' });
    const res = await generate(f.contractId);
    const [base] = await linesFor(res.invoiceId!);
    const before = await evidenceFor(res.invoiceId!);
    const [outcomeBefore] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    await withSystemDbAccessContext(() => updateLine(res.invoiceId!, base!.id, { quantity: '2.00' } as never, ACTOR));
    expect(await evidenceFor(res.invoiceId!)).toEqual(before);
    const [outcomeAfter] = await withSystemDbAccessContext(() => db.select().from(contractBillingPeriodOutcomes));
    expect(outcomeAfter).toEqual(outcomeBefore);
  });
});
