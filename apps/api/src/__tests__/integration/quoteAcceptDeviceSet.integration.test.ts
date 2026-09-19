/**
 * #3205 W05 acceptance: device-set quote lines become ordinary auto-quantity
 * contract lines, with the signed price/stamps preserved and live references
 * protected through acceptance.
 */
import './setup';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  contractLines, contracts, deviceGroups, devices, invoiceLines, invoices,
  organizations, partners, quoteAcceptances, quoteLines, quotes, sites,
} from '../../db/schema';
import { getAcceptanceProvider } from '../../services/acceptanceProvider';
import {
  addContractLineToContract, generateDueInvoice, type ContractActorT,
} from '../../services/contractService';
import { deleteDeviceGroup } from '../../services/deviceGroupDelete';
import { acceptQuote } from '../../services/quoteAcceptService';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture {
  partnerId: string;
  orgId: string;
  site: { id: string; name: string };
  group: { id: string; name: string };
  actor: ContractActorT;
}

async function seed(opts: { deviceCount?: number } = {}): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 9);
    const [partner] = await db.insert(partners).values({
      name: `Accept ${sfx}`, slug: `accept-${sfx}`, type: 'msp', plan: 'pro', status: 'active',
    }).returning({ id: partners.id });
    const [org] = await db.insert(organizations).values({
      partnerId: partner!.id, name: `Accept Org ${sfx}`, slug: `accept-org-${sfx}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({
      orgId: org!.id, name: `Dallas ${sfx}`,
    }).returning({ id: sites.id, name: sites.name });
    const [group] = await db.insert(deviceGroups).values({
      orgId: org!.id, name: `VIP ${sfx}`, type: 'static',
    }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    if ((opts.deviceCount ?? 0) > 0) {
      await db.insert(devices).values(Array.from({ length: opts.deviceCount! }, (_, i) => ({
        orgId: org!.id,
        siteId: site!.id,
        agentId: `accept-${sfx}-${i}`,
        hostname: `accept-${i}`,
        status: 'online' as const,
        deviceRole: 'server' as const,
        osType: 'linux' as const,
        osVersion: '1',
        architecture: 'x86_64',
        agentVersion: '1',
      })));
    }
    return {
      partnerId: partner!.id,
      orgId: org!.id,
      site: site!,
      group: group!,
      actor: { userId: null as unknown as string, partnerId: partner!.id, accessibleOrgIds: [org!.id] },
    };
  });
}

async function createSentQuote(f: Fixture, lineValues: Array<Partial<typeof quoteLines.$inferInsert>>) {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 9);
    const [quote] = await db.insert(quotes).values({
      partnerId: f.partnerId,
      orgId: f.orgId,
      quoteNumber: `Q-${sfx}`,
      status: 'sent',
      currencyCode: 'USD',
      documentLocale: 'en',
      sentAt: new Date(),
    }).returning({ id: quotes.id });
    const inserted = await db.insert(quoteLines).values(lineValues.map((line, i) => ({
      quoteId: quote!.id,
      orgId: f.orgId,
      sourceType: 'manual' as const,
      name: `Line ${i + 1}`,
      quantity: '2.00',
      unitPrice: '40.00',
      taxable: false,
      customerVisible: true,
      recurrence: 'monthly' as const,
      sortOrder: i,
      ...line,
    }))).returning({ id: quoteLines.id });
    return { id: quote!.id, lineIds: inserted.map((line) => line.id) };
  });
}

async function accept(quoteId: string) {
  return withSystemDbAccessContext(() => acceptQuote({ quoteId, signerName: 'Jane Buyer' }));
}

async function contractRows(contractId: string) {
  return withSystemDbAccessContext(() => db.select().from(contractLines)
    .where(eq(contractLines.contractId, contractId)).orderBy(contractLines.sortOrder));
}

async function assertNoAcceptanceWrites(quoteId: string, orgId: string) {
  const state = await withSystemDbAccessContext(async () => ({
    acceptances: await db.select({ id: quoteAcceptances.id }).from(quoteAcceptances)
      .where(eq(quoteAcceptances.quoteId, quoteId)),
    invoices: await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orgId, orgId)),
    contracts: await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.orgId, orgId)),
    quote: await db.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId)),
  }));
  expect(state.acceptances).toHaveLength(0);
  expect(state.invoices).toHaveLength(0);
  expect(state.contracts).toHaveLength(0);
  expect(state.quote[0]?.status).toBe('sent');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#3205 W05 — quote acceptance maps device-set lines', () => {
  runDb('1. maps all four types with frozen prices, references, allowances, and no estimated/manual quantity', async () => {
    const f = await seed();
    const quote = await createSentQuote(f, [
      {
        name: 'Role devices', contractLineType: 'per_device_role', deviceRoles: ['server'],
        siteId: f.site.id, siteName: f.site.name, taxable: true,
      },
      {
        name: 'VIP devices', contractLineType: 'per_device_group',
        deviceGroupId: f.group.id, deviceGroupName: f.group.name,
      },
      {
        name: 'Seats', contractLineType: 'per_seat', includedQuantity: '25.00',
        overageMode: 'bill', overageUnitPrice: '12.00',
      },
      { name: 'All devices', contractLineType: 'per_device' },
    ]);

    const result = await accept(quote.id);
    expect(result.contractIds).toHaveLength(1);
    const lines = await contractRows(result.contractIds[0]!);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      lineType: 'per_device_role', deviceRoles: ['server'], siteId: f.site.id,
      siteName: f.site.name, deviceGroupId: null, manualQuantity: null,
      catalogItemId: null, unitPrice: '40.00', taxable: true,
    });
    expect(lines[1]).toMatchObject({
      lineType: 'per_device_group', deviceGroupId: f.group.id,
      deviceGroupName: f.group.name, siteId: null, siteName: null,
      deviceRoles: null, manualQuantity: null, catalogItemId: null, unitPrice: '40.00',
    });
    expect(lines[2]).toMatchObject({
      lineType: 'per_seat', includedQuantity: '25.00', overageMode: 'bill',
      overageUnitPrice: '12.00', siteId: null, siteName: null,
      manualQuantity: null, catalogItemId: null, unitPrice: '40.00',
    });
    expect(lines[3]).toMatchObject({
      lineType: 'per_device', deviceRoles: null, deviceGroupId: null,
      manualQuantity: null, catalogItemId: null, unitPrice: '40.00',
    });
  });

  runDb('2. re-stamps the live group name but preserves the customer-signed site name', async () => {
    const f = await seed();
    const signedGroupName = f.group.name;
    const signedSiteName = f.site.name;
    const quote = await createSentQuote(f, [
      {
        name: 'Group', contractLineType: 'per_device_group', deviceGroupId: f.group.id,
        deviceGroupName: signedGroupName,
      },
      {
        name: 'Site', contractLineType: 'per_device', siteId: f.site.id, siteName: signedSiteName,
      },
    ]);
    const liveGroupName = `Renamed ${signedGroupName}`;
    const liveSiteName = `Renamed ${signedSiteName}`;
    await withSystemDbAccessContext(async () => {
      await db.update(deviceGroups).set({ name: liveGroupName }).where(eq(deviceGroups.id, f.group.id));
      await db.update(sites).set({ name: liveSiteName }).where(eq(sites.id, f.site.id));
    });

    const result = await accept(quote.id);
    const lines = await contractRows(result.contractIds[0]!);
    expect(lines[0]).toMatchObject({
      lineType: 'per_device_group', deviceGroupId: f.group.id, deviceGroupName: liveGroupName,
    });
    expect(lines[1]).toMatchObject({
      lineType: 'per_device', siteId: f.site.id, siteName: signedSiteName,
    });
    expect(lines[1]!.siteName).not.toBe(liveSiteName);
  });

  runDb('3. keeps ordinary recurring lines manual and one-time lines on the acceptance invoice', async () => {
    const f = await seed();
    const quote = await createSentQuote(f, [
      { name: 'Recurring support', quantity: '7.00', unitPrice: '11.00' },
      { name: 'Onboarding', recurrence: 'one_time', quantity: '2.00', unitPrice: '75.00' },
    ]);
    const result = await accept(quote.id);
    const recurring = await contractRows(result.contractIds[0]!);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]).toMatchObject({
      lineType: 'manual', manualQuantity: '7.00', catalogItemId: null, unitPrice: '11.00',
    });
    const oneTime = await withSystemDbAccessContext(() => db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, result.invoiceId)));
    expect(oneTime).toHaveLength(1);
    expect(oneTime[0]).toMatchObject({ name: 'Onboarding', quantity: '2.00', unitPrice: '75.00' });
  });

  runDb('4. bills the live count on the first contract invoice, not the quote estimate', async () => {
    const f = await seed({ deviceCount: 2 });
    const quote = await createSentQuote(f, [{
      name: 'Managed servers', contractLineType: 'per_device', quantity: '2.00',
      siteId: f.site.id, siteName: f.site.name, unitPrice: '10.00',
    }]);
    await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: f.orgId, siteId: f.site.id, agentId: `third-${quote.id}`, hostname: 'third',
      status: 'online', deviceRole: 'server', osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '1',
    }));
    const accepted = await accept(quote.id);
    const [contract] = await withSystemDbAccessContext(() => db.select().from(contracts)
      .where(eq(contracts.id, accepted.contractIds[0]!)));
    await withSystemDbAccessContext(() => db.update(contracts).set({
      status: 'active', nextBillingAt: contract!.startDate,
    }).where(eq(contracts.id, contract!.id)));
    const generated = await withSystemDbAccessContext(() => generateDueInvoice(
      contract!.id, new Date(`${contract!.startDate}T12:00:00Z`),
    ));
    const [line] = await withSystemDbAccessContext(() => db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, generated.invoiceId!)));
    expect(line).toMatchObject({ quantity: '3.00', unitPrice: '10.00' });
  });
});

describe('#3205 W05 — deleted or forged references abort before writes', () => {
  runDb.each(['group', 'site'] as const)('5. an orphaned %s aborts the whole acceptance with a customer-safe error', async (kind) => {
    const f = await seed();
    const referenceName = kind === 'group' ? f.group.name : f.site.name;
    const quote = await createSentQuote(f, [kind === 'group'
      ? {
          name: 'Group line', contractLineType: 'per_device_group',
          deviceGroupId: f.group.id, deviceGroupName: f.group.name,
        }
      : {
          name: 'Site line', contractLineType: 'per_device',
          siteId: f.site.id, siteName: f.site.name,
        }]);
    await withSystemDbAccessContext(() => kind === 'group'
      ? db.delete(deviceGroups).where(eq(deviceGroups.id, f.group.id))
      : db.delete(sites).where(eq(sites.id, f.site.id)));

    let error: unknown;
    try {
      await accept(quote.id);
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ status: 409, code: 'QUOTE_LINE_REFERENCE_DELETED' });
    expect((error as Error).message).not.toContain(referenceName);
    await assertNoAcceptanceWrites(quote.id, f.orgId);
  });

  runDb('6a. a delete waits on acceptance FOR SHARE locks and is refused after acceptance commits', async () => {
    const f = await seed();
    const quote = await createSentQuote(f, [{
      name: 'Group line', contractLineType: 'per_device_group',
      deviceGroupId: f.group.id, deviceGroupName: f.group.name,
    }]);
    let releaseCapture!: () => void;
    let captureStarted!: () => void;
    const release = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const started = new Promise<void>((resolve) => { captureStarted = resolve; });
    vi.spyOn(getAcceptanceProvider(), 'capture').mockImplementation(async (input) => {
      captureStarted();
      await release;
      return { signerName: input.signerName, signerEmail: null, method: 'typed-signature' };
    });

    const accepting = accept(quote.id);
    await started;
    const deleting = withSystemDbAccessContext(() => deleteDeviceGroup(f.group.id, f.orgId))
      .then(() => ({ settled: true, code: null as string | null }))
      .catch((err: { code?: string }) => ({ settled: true, code: err.code ?? null }));
    const whileCapturePaused = await Promise.race([
      deleting,
      new Promise<{ settled: false; code: null }>((resolve) => setTimeout(() => resolve({ settled: false, code: null }), 100)),
    ]);
    releaseCapture();
    const accepted = await accepting;
    expect(whileCapturePaused.settled).toBe(false);
    expect(accepted.contractIds).toHaveLength(1);
    await expect(deleting).resolves.toMatchObject({ settled: true, code: 'BILLED_BY_CONTRACTS' });
  });

  // The GROUP half of delete-wins is absent because Task 10's QUOTED_BY_QUOTES
  // refusal makes it unreachable through the live service; only SITE can commit first.
  runDb('6b. a site delete that commits first is refused before provider.capture and writes nothing', async () => {
    const f = await seed();
    const quote = await createSentQuote(f, [{
      name: 'Site line', contractLineType: 'per_device', siteId: f.site.id, siteName: f.site.name,
    }]);
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, f.site.id)));
    const captureSpy = vi.spyOn(getAcceptanceProvider(), 'capture');
    await expect(accept(quote.id)).rejects.toMatchObject({
      status: 409, code: 'QUOTE_LINE_REFERENCE_DELETED',
    });
    expect(captureSpy).not.toHaveBeenCalled();
    await assertNoAcceptanceWrites(quote.id, f.orgId);
  });

  runDb('7. a forged group id from another organization is treated as deleted', async () => {
    const f = await seed();
    const other = await seed();
    const quote = await createSentQuote(f, [{
      name: 'Group line', contractLineType: 'per_device_group',
      deviceGroupId: f.group.id, deviceGroupName: f.group.name,
    }]);
    const captureSpy = vi.spyOn(getAcceptanceProvider(), 'capture');

    await expect(withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS quote_lines_device_group_org_fk DEFERRED`);
      await db.update(quoteLines).set({ deviceGroupId: other.group.id })
        .where(eq(quoteLines.quoteId, quote.id));
      return acceptQuote({ quoteId: quote.id, signerName: 'Forged Buyer' });
    })).rejects.toMatchObject({ status: 409, code: 'QUOTE_LINE_REFERENCE_DELETED' });
    expect(captureSpy).not.toHaveBeenCalled();
    await assertNoAcceptanceWrites(quote.id, f.orgId);
  });
});

describe('#3205 W05 × W07 — accepted contract lines need no special billing path', () => {
  runDb('8. preserves ordinary lineage, allowance splitting, and coverage evidence', async () => {
    const f = await seed({ deviceCount: 3 });
    await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: f.orgId, siteId: f.site.id, agentId: `workstation-${f.orgId}`, hostname: 'workstation',
      status: 'online', deviceRole: 'workstation', osType: 'linux', osVersion: '1', architecture: 'x86_64', agentVersion: '1',
    }));
    const quote = await createSentQuote(f, [{
      name: 'Managed servers', contractLineType: 'per_device_role', deviceRoles: ['server'],
      siteId: f.site.id, siteName: f.site.name, quantity: '99.00', unitPrice: '10.00',
      includedQuantity: '2.00', overageMode: 'bill', overageUnitPrice: '12.00',
    }]);
    const accepted = await accept(quote.id);
    const acceptedContractId = accepted.contractIds[0]!;
    const [acceptedContract] = await withSystemDbAccessContext(() => db.select().from(contracts)
      .where(eq(contracts.id, acceptedContractId)));
    const [acceptedLine] = await contractRows(acceptedContractId);

    const [ordinaryContract] = await withSystemDbAccessContext(() => db.insert(contracts).values({
      partnerId: f.partnerId, orgId: f.orgId, name: 'Ordinary contract', status: 'draft',
      intervalMonths: 1, startDate: acceptedContract!.startDate, currencyCode: 'USD', billingTiming: 'advance',
    }).returning({ id: contracts.id }));
    const ordinaryLine = await withSystemDbAccessContext(() => addContractLineToContract(ordinaryContract!.id, {
      lineType: 'per_device_role', description: 'Managed servers', unitPrice: '10.00', taxable: false,
      deviceRoles: ['server'], siteId: f.site.id,
      includedQuantity: '2.00', overageMode: 'bill', overageUnitPrice: '12.00',
    }, f.actor));

    await withSystemDbAccessContext(async () => {
      await db.update(contracts).set({ status: 'active', nextBillingAt: acceptedContract!.startDate })
        .where(eq(contracts.id, acceptedContractId));
      await db.update(contracts).set({ status: 'active', nextBillingAt: acceptedContract!.startDate })
        .where(eq(contracts.id, ordinaryContract!.id));
    });
    const asOf = new Date(`${acceptedContract!.startDate}T12:00:00Z`);
    const acceptedRun = await withSystemDbAccessContext(() => generateDueInvoice(acceptedContractId, asOf));
    const ordinaryRun = await withSystemDbAccessContext(() => generateDueInvoice(ordinaryContract!.id, asOf));

    const readGenerated = (invoiceId: string) => withSystemDbAccessContext(() => db.select({
      sourceType: invoiceLines.sourceType,
      sourceId: invoiceLines.sourceId,
      sourceContractId: invoiceLines.sourceContractId,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
    }).from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).orderBy(invoiceLines.sortOrder));
    const acceptedInvoiceLines = await readGenerated(acceptedRun.invoiceId!);
    const ordinaryInvoiceLines = await readGenerated(ordinaryRun.invoiceId!);

    expect(acceptedInvoiceLines).toEqual([
      { sourceType: 'contract', sourceId: acceptedLine!.id, sourceContractId: acceptedContractId, quantity: '2.00', unitPrice: '10.00' },
      { sourceType: 'contract', sourceId: acceptedLine!.id, sourceContractId: acceptedContractId, quantity: '1.00', unitPrice: '12.00' },
    ]);
    expect(ordinaryInvoiceLines).toEqual([
      { sourceType: 'contract', sourceId: ordinaryLine.id, sourceContractId: ordinaryContract!.id, quantity: '2.00', unitPrice: '10.00' },
      { sourceType: 'contract', sourceId: ordinaryLine.id, sourceContractId: ordinaryContract!.id, quantity: '1.00', unitPrice: '12.00' },
    ]);
    expect(acceptedRun.uncoveredDevices).toEqual(ordinaryRun.uncoveredDevices);
    expect(acceptedRun.uncoveredDevices).toEqual({ total: 1, byRole: { workstation: 1 } });
    expect(acceptedRun.overages.map(({ description, counted, included, overage, mode }) => (
      { description, counted, included, overage, mode }
    ))).toEqual(ordinaryRun.overages.map(({ description, counted, included, overage, mode }) => (
      { description, counted, included, overage, mode }
    )));
  });
});
