/**
 * BRZ-8807 PR 3a: background jobs skip partners with billing off. Two partners
 * (A: billing_enabled=false, B: true) against real Postgres, per the repo rule
 * "one integration test must prove the fan-out fires against real Postgres".
 * setup.ts TRUNCATEs before every test: seed per test.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const { captureException, send } = vi.hoisted(() => ({
  captureException: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/sentry', async (orig) => ({
  ...(await orig<typeof import('../../services/sentry')>()),
  captureException,
}));
vi.mock('../../services/email', () => ({ getEmailService: () => ({ sendEmail: send }) }));
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/autopay/consentText', () => ({
  buildAutopayDisclosure: vi.fn(async () => ({ partnerName: 'Example MSP', scheduleText: 'On the due date.', feeText: 'No fee applies.' })),
}));
vi.mock('../../services/autopay/renderBillingNotice', () => ({
  renderBillingNotice: vi.fn(async () => ({ subject: 'Update your card', html: '<p>x</p>', text: 'x', frozen: {} })),
}));

import { db, withSystemDbAccessContext } from '../../db';
import {
  billingNoticeOutbox, contractHourPeriods, contractLines, contractSkippedBillingPeriods, contracts,
  invoices, orgAutopayEnrollments, orgPaymentMethods, organizations, partners, stripeConnectAccounts,
} from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { seedBlockFixture, seedEntry } from './hourBlockFixtures';
import { generateDueInvoice } from '../../services/contractService';
import { runHourBlockCloseOutSweep } from '../../services/contractHourBlockClose';
import { runContractBillingSweep } from '../../jobs/contractWorker';
import { checkExpiringAutopayCards } from '../../services/autopay/cardExpiryCheck';
import { dispatchPendingBillingNotices, enqueueBillingNotice } from '../../services/autopay/noticeOutbox';

const at = (d: string) => new Date(`${d}T06:00:00Z`);
const setBilling = (partnerId: string, enabled: boolean) =>
  withSystemDbAccessContext(() => db.update(partners).set({ billingEnabled: enabled }).where(eq(partners.id, partnerId)));

describe('BRZ-8807 background jobs honour partners.billing_enabled (real DB)', () => {
  it('contract billing sweep bills only the billing-on partner and reports nothing for the off one', async () => {
    const seed = async (sfx: string) => withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({ name: `P ${sfx}`, slug: `p-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
      const [o] = await db.insert(organizations).values({ currencyCode: 'USD', partnerId: p!.id, name: `O ${sfx}`, slug: `o-${sfx}` }).returning({ id: organizations.id });
      const [c] = await db.insert(contracts).values({
        partnerId: p!.id, orgId: o!.id, name: 'Due', status: 'active', billingTiming: 'advance', intervalMonths: 1,
        startDate: '2026-07-01', currencyCode: 'USD', nextBillingAt: '2026-07-01',
      }).returning({ id: contracts.id });
      await db.insert(contractLines).values({ contractId: c!.id, orgId: o!.id, lineType: 'flat', description: 'svc', unitPrice: '100.00' });
      return { partnerId: p!.id, orgId: o!.id, contractId: c!.id };
    });
    const sfx = Math.random().toString(36).slice(2, 8);
    const a = await seed(`a${sfx}`);
    const b = await seed(`b${sfx}`);
    await setBilling(a.partnerId, false);
    captureException.mockClear();

    const res = await runContractBillingSweep(at('2026-07-02'));
    expect(res).toMatchObject({ billed: 1, failed: 0 });
    expect(captureException).not.toHaveBeenCalled();

    const invs = await withSystemDbAccessContext(() => db.select({ orgId: invoices.orgId }).from(invoices).where(inArray(invoices.orgId, [a.orgId, b.orgId])));
    expect(invs.map((i) => i.orgId)).toEqual([b.orgId]);
    const [ca] = await withSystemDbAccessContext(() => db.select({ n: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, a.contractId)));
    expect(ca!.n).toBe('2026-07-01');
    const [cb] = await withSystemDbAccessContext(() => db.select({ n: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, b.contractId)));
    expect(cb!.n).not.toBe('2026-07-01');
  }, 30000);

  it('hour-block close-out closes only the billing-on partner; the off partner closes after re-enable', async () => {
    const mk = async () => {
      const f = await seedBlockFixture({ timing: 'advance', nextBillingAt: '2026-07-01', endDate: '2026-08-01' });
      await withSystemDbAccessContext(() => generateDueInvoice(f.contractId, at('2026-07-01')));
      await seedEntry(f, { minutes: 60, endedAt: '2026-07-20T12:00:00Z' });
      return f;
    };
    const a = await mk();
    const b = await mk();
    await setBilling(a.partnerId, false);
    captureException.mockClear();
    const invCount = (orgId: string) => withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.orgId, orgId))).then((r) => r.length);
    const aInvoicesBefore = await invCount(a.orgId);
    const ledger = (lineId: string) => withSystemDbAccessContext(() => db.select().from(contractHourPeriods).where(eq(contractHourPeriods.contractLineId, lineId)));

    expect(await runHourBlockCloseOutSweep(at('2026-08-02'))).toMatchObject({ contracts: 1, closes: 1, errors: 0 });
    expect(await ledger(b.blockLineId)).toHaveLength(1);
    expect(await ledger(a.blockLineId)).toHaveLength(0);
    expect(await withSystemDbAccessContext(() => db.select().from(contractSkippedBillingPeriods).where(eq(contractSkippedBillingPeriods.orgId, a.orgId)))).toHaveLength(0);
    expect(await invCount(a.orgId)).toBe(aInvoicesBefore);
    expect(captureException).not.toHaveBeenCalled();

    await setBilling(a.partnerId, true);
    expect(await runHourBlockCloseOutSweep(at('2026-08-03'))).toMatchObject({ closes: 1, errors: 0 });
    expect(await ledger(a.blockLineId)).toHaveLength(1);
  }, 30000);

  it('card-expiry check enqueues card_expiring only for the billing-on partner', async () => {
    const testDb = getTestDb();
    const orgs: string[] = [];
    const seed = async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      orgs.push(org.id);
      await testDb.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
      const [connection] = await testDb.insert(stripeConnectAccounts).values({ partnerId: partner.id, stripeAccountId: `acct_${randomUUID()}`, status: 'connected', apiKey: 'enc:synthetic', keyLast4: 'test', accountCountry: 'US' }).returning();
      const [enrollment] = await testDb.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id, status: 'active', generation: 1,
        stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId, requestRecipientEmail: 'billing@example.test', effectiveFrom: new Date('2026-09-01T00:00:00Z') }).returning();
      await testDb.insert(orgPaymentMethods).values({ orgId: org.id, enrollmentId: enrollment!.id, stripePaymentMethodId: `pm_${randomUUID()}`, type: 'card', status: 'active',
        isAutopayMethod: true, cardBrand: 'visa', cardLast4: '1234', cardFunding: 'debit', cardExpMonth: 10, cardExpYear: 2026 });
      return partner.id;
    };
    const aPartner = await seed();
    await seed();
    await testDb.update(partners).set({ billingEnabled: false }).where(eq(partners.id, aPartner));

    expect(await checkExpiringAutopayCards(new Date('2026-10-02T06:28:00Z'))).toEqual({ enqueued: 1 });
    const notices = await testDb.select().from(billingNoticeOutbox);
    expect(notices.map((n) => n.orgId)).toEqual([orgs[1]]);
    expect(notices[0]!.kind).toBe('card_expiring');
  });

  it('notice outbox cancels money-movement notices for the off partner, keeps payment_receipt, and leaves the on partner alone', async () => {
    const seed = async (billingEnabled: boolean) => withSystemDbAccessContext(async () => {
      const sfx = randomUUID();
      const [p] = await db.insert(partners).values({ name: 'Outbox', slug: `ob-${sfx}`, type: 'msp', plan: 'pro', status: 'active', billingEmail: 'billing@example.test', billingEnabled }).returning();
      const [o] = await db.insert(organizations).values({ name: 'Outbox org', slug: `oo-${sfx}`, currencyCode: 'USD', partnerId: p!.id }).returning();
      const kinds = ['autopay_request', 'card_expiring', 'invoice_autopay', 'payment_receipt'] as const;
      const rows: Record<string, string> = {};
      for (const kind of kinds) {
        const r = await enqueueBillingNotice(db, { partnerId: p!.id, orgId: o!.id, kind, seq: 1, dedupeKey: `t:${kind}:${sfx}`, toEmail: `${kind}@example.test`,
          rendered: { subject: kind, html: '<p>x</p>', text: 'x', frozen: {} } });
        rows[kind] = r.id;
      }
      return rows;
    });
    const a = await seed(false);
    const b = await seed(true);
    send.mockClear();

    await dispatchPendingBillingNotices();
    const state = async (rows: Record<string, string>) => {
      const found = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(inArray(billingNoticeOutbox.id, Object.values(rows))));
      return Object.fromEntries(found.map((r) => [r.kind, r]));
    };
    const sa = await state(a);
    for (const kind of ['autopay_request', 'card_expiring', 'invoice_autopay']) {
      expect(sa[kind]).toMatchObject({ status: 'cancelled', lastError: 'Billing is disabled', sentAt: null });
    }
    expect(sa.payment_receipt!.sentAt).not.toBeNull();
    const sb = await state(b);
    for (const kind of Object.keys(sb)) expect(sb[kind]!.sentAt).not.toBeNull();

    const recipients = send.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual([
      'autopay_request@example.test', 'card_expiring@example.test', 'invoice_autopay@example.test',
      'payment_receipt@example.test', 'payment_receipt@example.test',
    ].sort());
  });
});
