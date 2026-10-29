/**
 * Integration test — W14 PR B (#6784): manage_contracts preview_invoice / generate_invoice and manage_accounting_sync
 * against real Postgres as the unprivileged `breeze_app` role, through `executeTool`.
 *
 * Pins: the class each action is raised at; the contract gate (another partner's contract is not found and nothing is
 * written); preview <-> generator parity (the draft's total equals the preview's); drift refusal (effect digest and
 * handler PREVIEW_MISMATCH); hour_block refusal; the accounting status projection never carries a token column
 * value; another partner's invoice never reaches pushInvoiceToAccounting; the push digest moves with the invoice.
 * Only the provider registry (no live QuickBooks) and the push service are stubbed; the DB is real.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const pushSpy = vi.hoisted(() => vi.fn());
vi.mock('../../services/accounting/accountingInvoicePush', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingInvoicePush')>()),
  pushInvoiceToAccounting: pushSpy,
}));
vi.mock('../../services/accounting/providerRegistry', async (orig) => {
  const actual = await orig<typeof import('../../services/accounting/providerRegistry')>();
  const fake = { displayName: 'FakeBooks', capabilities: { connect: true, invoicePush: true }, configError: () => null };
  return {
    ...actual,
    findAccountingProvider: () => fake,
    getAccountingProvider: () => fake,
    providerSupports: () => true,
  };
});

import type { DbAccessContext } from '../../db';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  accountingConnections, accountingEntityMappings, contractBillingPeriods, contractLines, contracts, invoices, organizations,
} from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { computeEffectDigestOutcome } from '../../services/actionIntents/effectDigest';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const AI_SESSION_ID = randomUUID();

function makeAuth(opts: { userId: string; partnerId: string; orgIds: string[] }): AuthContext {
  const { orgIds } = opts;
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId, orgId: null, scope: 'partner', partnerOrgAccess: 'all',
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: AI_SESSION_ID },
  } as unknown as AuthContext;
}

function ctxFor(auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id,
  });
}

async function run(tool: string, input: Record<string, unknown>, auth: AuthContext) {
  const raw = await withDbAccessContext(ctxFor(auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

const digest = (tool: string, args: Record<string, unknown>) =>
  withSystemDbAccessContext(() => computeEffectDigestOutcome(tool, args, db));

const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;
const cents = (s: string) => Math.round(Number(s) * 100);
const N_DEVICES = 2;

/** An active contract that is due today: flat 100 + per_device 10 + manual 3 x 5 (+ an optional live hour_block). */
async function seedContract(o: { partnerId: string; orgId: string; userId: string; hourBlock?: boolean }): Promise<string> {
  const t = getTestDb();
  const [c] = await t.insert(contracts).values({
    partnerId: o.partnerId, orgId: o.orgId, name: `W14B ${randomUUID().slice(0, 6)}`, status: 'active',
    billingTiming: 'advance', intervalMonths: 1, startDate: monthStart, nextBillingAt: monthStart,
    currencyCode: 'USD', autoIssue: false, createdBy: o.userId,
  } as typeof contracts.$inferInsert).returning({ id: contracts.id });
  const base = { contractId: c!.id, orgId: o.orgId };
  await t.insert(contractLines).values([
    { ...base, lineType: 'flat', description: 'Flat', unitPrice: '100.00', taxable: true, sortOrder: 0 },
    { ...base, lineType: 'per_device', description: 'Per device', unitPrice: '10.00', sortOrder: 1 },
    { ...base, lineType: 'manual', description: 'Manual', unitPrice: '5.00', manualQuantity: '3', sortOrder: 2 },
    ...(o.hourBlock ? [{
      ...base, lineType: 'hour_block', description: 'Hours', unitPrice: '1000.00', taxable: true, includedQuantity: '10.00',
      overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none', hourBlockFirstPeriodStart: monthStart, sortOrder: 3,
    }] : []),
  ] as Array<typeof contractLines.$inferInsert>);
  return c!.id;
}

async function seedInvoice(partnerId: string, orgId: string, total = '100.00'): Promise<string> {
  const [row] = await getTestDb().insert(invoices).values({
    partnerId, orgId, status: 'sent', currencyCode: 'USD', invoiceNumber: `W14B-${randomUUID().slice(0, 8)}`,
    issueDate: monthStart, dueDate: monthStart, subtotal: total, total, balance: total,
  } as typeof invoices.$inferInsert).returning({ id: invoices.id });
  return row!.id;
}

const writes = async (contractId: string, orgId: string) => ({
  periods: await getTestDb().select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, contractId)),
  invoices: await getTestDb().select().from(invoices).where(eq(invoices.orgId, orgId)),
});

interface Fixture {
  partnerId: string; orgA: string; siteA: string; userId: string; contractA: string;
  otherPartnerId: string; orgB: string; contractB: string; invoiceA: string; invoiceB: string;
  auth: AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const other = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: other.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W14B A' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w14b-${randomUUID()}@example.com` });
  const otherUser = await createUser({ partnerId: other.id, orgId: orgB.id, email: `w14b-${randomUUID()}@example.com` });
  for (let i = 0; i < N_DEVICES; i++) await createDevice({ orgId: orgA.id, siteId: siteA.id });
  return {
    partnerId: partner.id, orgA: orgA.id, siteA: siteA.id, userId: user.id, otherPartnerId: other.id, orgB: orgB.id,
    contractA: await seedContract({ partnerId: partner.id, orgId: orgA.id, userId: user.id }),
    contractB: await seedContract({ partnerId: other.id, orgId: orgB.id, userId: otherUser.id }),
    invoiceA: await seedInvoice(partner.id, orgA.id),
    invoiceB: await seedInvoice(other.id, orgB.id),
    auth: makeAuth({ userId: user.id, partnerId: partner.id, orgIds: [orgA.id] }),
  };
}

let f: Fixture;
const pushOutcome = { mappingId: null, remoteEntityId: 'r-1', docNumber: 'D-1', syncStatus: 'synced', taxVarianceCents: 0, totalVarianceCents: 0 };
beforeEach(async () => {
  clearPermissionCache();
  pushSpy.mockReset();
  pushSpy.mockResolvedValue(pushOutcome);
  f = await seedFixture();
});

const previewOf = async (contractId = f.contractA) =>
  (await run('manage_contracts', { action: 'preview_invoice', contractId }, f.auth)).body;
const generateWith = (p: Record<string, any>) => ({ action: 'generate_invoice', ...p.generateWith });

describe('the class each action is raised at', () => {
  runDb('generate_invoice and push / push_bulk are four-eyes; link_mapping supervised; preview_invoice is a t2 read', () => {
    expect(checkGuardrails('manage_contracts', { action: 'generate_invoice', contractId: f.contractA })).toMatchObject({ tier: 3, approvalScope: 'four_eyes' });
    expect(checkGuardrails('manage_accounting_sync', { action: 'push', provider: 'quickbooks' })).toMatchObject({ approvalScope: 'four_eyes' });
    expect(checkGuardrails('manage_accounting_sync', { action: 'push_bulk', provider: 'quickbooks' })).toMatchObject({ approvalScope: 'four_eyes' });
    expect(checkGuardrails('manage_accounting_sync', { action: 'link_mapping', provider: 'quickbooks' })).toMatchObject({ approvalScope: 'supervised' });
    expect(checkGuardrails('manage_contracts', { action: 'preview_invoice', contractId: f.contractA })).toMatchObject({ tier: 2 });
  });
});

describe('preview_invoice', () => {
  runDb('an in-org contract previews its period, lines and total (CONTROL); another partner\'s is not found', async () => {
    const p = await previewOf();
    expect(p.due, JSON.stringify(p)).toBe(true);
    expect(p.period.start).toBe(monthStart);
    expect(p.lines).toHaveLength(3);
    expect(cents(p.subtotal)).toBe(10000 + 1000 * N_DEVICES + 1500);
    expect(cents(p.total)).toBe(cents(p.subtotal) + cents(p.taxTotal));

    const other = await run('manage_contracts', { action: 'preview_invoice', contractId: f.contractB }, f.auth);
    expect(other.body.error, other.raw).toBeTruthy();
    expect(other.body.due).toBeUndefined();
    expect(other.raw).not.toContain(f.orgB);
    const w = await writes(f.contractB, f.orgB);
    expect(w.periods).toHaveLength(0);
    expect(w.invoices.filter((i) => i.id !== f.invoiceB)).toHaveLength(0);
  });
});

describe('generate_invoice', () => {
  runDb('another partner\'s contract is refused and nothing is written (CONTROL: the in-org call lands)', async () => {
    const own = await previewOf();
    const asserted = generateWith(own);
    // Assertions that match contract B exactly (no devices: 100.00 + 0 + 15.00), so only the gate can refuse it.
    const matchesB = { ...asserted, expectedTotal: '115.00' };
    const cross = await run('manage_contracts', { ...matchesB, contractId: f.contractB }, f.auth);
    expect(cross.body.code, cross.raw).not.toBe('PREVIEW_MISMATCH');
    expect(cross.body.generated, cross.raw).toBeUndefined();
    expect(cross.body.error, cross.raw).toBeTruthy();
    const w = await writes(f.contractB, f.orgB);
    expect(w.periods).toHaveLength(0);
    expect(w.invoices.filter((i) => i.id !== f.invoiceB)).toHaveLength(0);
    expect((await getTestDb().select({ n: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, f.contractB)))[0]!.n).toBe(monthStart);

    const ok = await run('manage_contracts', { ...asserted, contractId: f.contractA }, f.auth);
    expect(ok.body.generated, ok.raw).toBe(true);
  });

  runDb('in-org generation yields a draft whose total equals the preview total, and one billing period', async () => {
    const p = await previewOf();
    const out = await run('manage_contracts', { ...generateWith(p), contractId: f.contractA }, f.auth);
    expect(out.body.generated, out.raw).toBe(true);
    expect(out.body.status).toBe('draft');
    const [inv] = await getTestDb().select().from(invoices).where(eq(invoices.id, out.body.invoiceId));
    expect(inv!.status).toBe('draft');
    expect(inv!.total).toBe(p.total);
    expect(cents(inv!.subtotal)).toBe(cents(p.subtotal));
    expect(cents(inv!.taxTotal)).toBe(cents(p.taxTotal));
    const periods = await getTestDb().select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.contractA));
    expect(periods).toHaveLength(1);
    expect(periods[0]!.periodStart).toBe(monthStart);
  });

  runDb('drift: the effect digest moves when a device is added, and the handler refuses the old total', async () => {
    const args = { action: 'generate_invoice', contractId: f.contractA };
    const first = await digest('manage_contracts', args);
    expect(first.kind).toBe('pinned');
    expect(await digest('manage_contracts', args)).toEqual(first);

    const p = await previewOf();
    await createDevice({ orgId: f.orgA, siteId: f.siteA });
    const after = await digest('manage_contracts', args);
    expect(after.kind).toBe('pinned');
    expect(after).not.toEqual(first);

    const out = await run('manage_contracts', { ...generateWith(p), contractId: f.contractA }, f.auth);
    expect(out.body.code, out.raw).toBe('PREVIEW_MISMATCH');
    expect(out.body.mismatched).toContain('expectedTotal');
    const w = await writes(f.contractA, f.orgA);
    expect(w.periods).toHaveLength(0);
    expect(w.invoices.filter((i) => i.id !== f.invoiceA)).toHaveLength(0);

    // CONTROL: the fresh preview's assertions land.
    const fresh = await previewOf();
    expect(cents(fresh.total)).toBe(cents(p.total) + 1000);
    const ok = await run('manage_contracts', { ...generateWith(fresh), contractId: f.contractA }, f.auth);
    expect(ok.body.generated, ok.raw).toBe(true);
  });

  runDb('a live hour_block line blocks preview generate and writes nothing', async () => {
    const id = await seedContract({ partnerId: f.partnerId, orgId: f.orgA, userId: f.userId, hourBlock: true });
    const p = await previewOf(id);
    expect(p.blocked?.code, JSON.stringify(p)).toBe('HOUR_BLOCK_NOT_SUPPORTED');
    const out = await run('manage_contracts', {
      action: 'generate_invoice', contractId: id, periodStart: p.period.start, expectedTotal: p.total,
      autoIssue: p.autoIssue, expectedRecipients: p.recipients,
    }, f.auth);
    expect(out.body.code, out.raw).toBe('HOUR_BLOCK_NOT_SUPPORTED');
    expect((await writes(id, f.orgA)).periods).toHaveLength(0);
  });
});

describe('manage_accounting_sync', () => {
  const SECRETS = {
    accessTokenEncrypted: 'enc:access-SECRET-aaa111', refreshTokenEncrypted: 'enc:refresh-SECRET-bbb222',
    realmIdEncrypted: 'enc:realm-SECRET-ccc333', webhookVerifierTokenEncrypted: 'enc:webhook-SECRET-ddd444',
  };
  const connect = () => getTestDb().insert(accountingConnections).values({
    partnerId: f.partnerId, provider: 'quickbooks', status: 'connected', ...SECRETS,
  } as typeof accountingConnections.$inferInsert);

  runDb('status never returns a token value or column name (CONTROL: the connection itself is reported)', async () => {
    await connect();
    const out = await run('manage_accounting_sync', { action: 'status', provider: 'quickbooks' }, f.auth);
    expect(out.body.status, out.raw).toBe('connected');
    expect(out.body.connection).toBeTruthy();
    for (const [col, val] of Object.entries(SECRETS)) {
      expect(out.raw, col).not.toContain(val);
      expect(out.raw, col).not.toContain(col);
    }
    expect(out.raw).not.toMatch(/SECRET/);
  });

  runDb('push of another partner\'s invoice is NOT_FOUND and never reaches the push service (CONTROL: own invoice does)', async () => {
    await connect();
    pushSpy.mockImplementation(() => { throw new Error('pushInvoiceToAccounting must not be reached'); });
    const cross = await run('manage_accounting_sync', { action: 'push', provider: 'quickbooks', invoiceId: f.invoiceB }, f.auth);
    expect(cross.body.code, cross.raw).toBe('NOT_FOUND');
    expect(pushSpy).not.toHaveBeenCalled();

    pushSpy.mockReset();
    pushSpy.mockResolvedValue(pushOutcome);
    const own = await run('manage_accounting_sync', { action: 'push', provider: 'quickbooks', invoiceId: f.invoiceA }, f.auth);
    expect(own.body.syncStatus, own.raw).toBe('synced');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0]![0]).toBe(f.invoiceA);
  });

  runDb('the push digest is stable until the invoice changes', async () => {
    await connect();
    const args = { action: 'push', provider: 'quickbooks', invoiceId: f.invoiceA };
    const first = await digest('manage_accounting_sync', args);
    expect(first.kind).toBe('pinned');
    expect(await digest('manage_accounting_sync', args)).toEqual(first);
    await getTestDb().update(invoices).set({ total: '175.00', updatedAt: new Date() }).where(eq(invoices.id, f.invoiceA));
    const after = await digest('manage_accounting_sync', args);
    expect(after.kind).toBe('pinned');
    expect(after).not.toEqual(first);
  });

  // Review (PR B, test analyzer): the push pin covers the destination, the mappings and the customer payload, not
  // only the invoice row — and never the token columns.
  runDb('the push digest moves with the destination settings, the customer mapping and the customer payload, never with a token', async () => {
    const [conn] = await getTestDb().insert(accountingConnections).values({
      partnerId: f.partnerId, provider: 'quickbooks', status: 'connected', ...SECRETS,
    } as typeof accountingConnections.$inferInsert).returning({ id: accountingConnections.id });
    const args = { action: 'push', provider: 'quickbooks', invoiceId: f.invoiceA };
    let last = await digest('manage_accounting_sync', args);
    expect(last.kind).toBe('pinned');
    const moved = async (why: string, change: () => Promise<unknown>) => {
      await change();
      const next = await digest('manage_accounting_sync', args);
      expect(next.kind, why).toBe('pinned');
      expect(next, why).not.toEqual(last);
      last = next;
    };
    await moved('income account', () => getTestDb().update(accountingConnections)
      .set({ defaultIncomeAccountRef: 'ACC-77' }).where(eq(accountingConnections.id, conn!.id)));
    await moved('customer mapping appears', () => getTestDb().insert(accountingEntityMappings).values({
      integrationId: conn!.id, partnerId: f.partnerId, breezeEntityType: 'org', breezeEntityId: f.orgA,
      remoteEntityType: 'Customer', remoteEntityId: 'QB-1', linkStatus: 'confirmed', syncStatus: 'synced',
    } as typeof accountingEntityMappings.$inferInsert));
    await moved('customer mapping retargeted', () => getTestDb().update(accountingEntityMappings)
      .set({ remoteEntityId: 'QB-2' }).where(eq(accountingEntityMappings.breezeEntityId, f.orgA)));
    await moved('customer billing address', () => getTestDb().update(organizations)
      .set({ billingAddressLine1: '1 Changed Street' }).where(eq(organizations.id, f.orgA)));
    // A token refresh is not a change of what lands in the books.
    await getTestDb().update(accountingConnections)
      .set({ accessTokenEncrypted: 'enc:access-ROTATED' }).where(eq(accountingConnections.id, conn!.id));
    expect(await digest('manage_accounting_sync', args)).toEqual(last);
  });
});
