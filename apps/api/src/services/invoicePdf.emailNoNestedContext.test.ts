/**
 * #9585 — the invoice email's "View & pay" label must not open a second
 * (system-context) connection when the caller can read the partner row itself.
 *
 * deliverInvoiceEmail runs inside an open transaction on every path: the staff
 * send/resend request transactions (partner/system scope) and the accepted-quote
 * auto-email (autoEmailAcceptedInvoice → sendInvoiceEmail, system scope). A nested
 * `runOutsideDbContext(withSystemDbAccessContext(...))` read there takes a SECOND
 * pool connection while the outer backend sits idle in transaction; behind a pending
 * ACCESS EXCLUSIVE request (TRUNCATE, DDL) the two wait on each other. Mirrors
 * invoicePdf.renderNoNestedContext.test.ts (#9454), which covers the PDF render.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { makeFixtureInvoice } from '../testUtils/invoiceRenderFixtures';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  selects: [] as { table: string; nested: boolean }[],
  depth: 0,
  failTable: null as string | null,
}));

vi.mock('../db', () => {
  const select = () => {
    let table = '';
    const chain: Record<string, unknown> = {};
    const settle = () => {
      state.selects.push({ table, nested: state.depth > 0 });
      if (table === state.failTable) return Promise.reject(new Error(`read of ${table} failed`));
      return Promise.resolve(state.rows[table] ?? []);
    };
    chain.from = (t: PgTable) => { table = getTableName(t); return chain; };
    chain.leftJoin = () => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.orderBy = settle;
    chain.limit = settle;
    return chain;
  };
  const nested = async <T>(fn: () => Promise<T>): Promise<T> => {
    state.depth += 1;
    try { return await fn(); } finally { state.depth -= 1; }
  };
  return {
    db: { select },
    runOutsideDbContext: vi.fn(nested),
    withSystemDbAccessContext: vi.fn(nested),
  };
});

vi.mock('./invoiceLinkToken', () => ({
  getOrMintInvoiceLink: vi.fn(async () => ({ token: 'tok-9585' })),
  buildPublicInvoiceUrl: (token: string) => `https://pay.example.test/i/${token}`,
}));

const mail = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => undefined),
  buildInvoiceTemplate: vi.fn((_params: { payEnabled?: boolean }) => ({ subject: 's', html: 'h', text: 't' })),
}));
vi.mock('./email', () => ({
  getEmailService: () => ({ sendEmail: mail.sendEmail }),
  buildInvoiceTemplate: mail.buildInvoiceTemplate,
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { resendInvoiceEmail } from './invoicePdf';

const invoice = {
  ...makeFixtureInvoice({ id: 'inv-9585', partnerId: 'p-1', orgId: 'o-1', status: 'sent', deviceAppendix: false }),
  invoiceNumber: 'INV-9585',
  balance: '100.00',
};
const partner = { name: 'Example MSP', billingEmail: 'billing@example.test', emailSignature: null, settings: {} };
const connected = { status: 'connected', apiKey: 'enc:key' };
const actor = { accessibleOrgIds: null } as unknown as Parameters<typeof resendInvoiceEmail>[1];
const opts = { to: ['customer@example.test'], includePdf: false };

const payEnabled = () => mail.buildInvoiceTemplate.mock.calls.at(-1)?.[0].payEnabled;

beforeEach(() => {
  state.rows = { invoices: [invoice], organizations: [{ name: 'Org', billingContact: null }], partners: [partner], stripe_connect_accounts: [connected] };
  state.selects = [];
  state.depth = 0;
  state.failTable = null;
  vi.mocked(runOutsideDbContext).mockClear();
  vi.mocked(withSystemDbAccessContext).mockClear();
  mail.sendEmail.mockClear();
  mail.buildInvoiceTemplate.mockClear();
});

describe('invoice email online-payment availability (#9585)', () => {
  it('reads it on the caller connection when the partner row is visible: no nested system context', async () => {
    const result = await resendInvoiceEmail(invoice.id, actor, opts);

    expect(result.emailed).toBe(true);
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(state.selects.filter((s) => s.nested)).toEqual([]);
    expect(state.selects.map((s) => s.table)).toContain('stripe_connect_accounts');
    // Behaviour unchanged: a connected partner still gets the "View & pay" CTA.
    expect(payEnabled()).toBe(true);
  });

  it('no usable Stripe key on the caller connection → the View label, still no nested context', async () => {
    state.rows.stripe_connect_accounts = [{ status: 'connected', apiKey: null }];
    await resendInvoiceEmail(invoice.id, actor, opts);

    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(payEnabled()).toBe(false);
  });

  it('a failed availability read never fails the send (label-only)', async () => {
    state.failTable = 'stripe_connect_accounts';
    const result = await resendInvoiceEmail(invoice.id, actor, opts);

    expect(result.emailed).toBe(true);
    expect(payEnabled()).toBe(false);
  });

  it('a paid invoice never reads availability (nothing to pay)', async () => {
    state.rows.invoices = [{ ...invoice, status: 'paid', balance: '0.00' }];
    await resendInvoiceEmail(invoice.id, actor, opts);

    expect(state.selects.map((s) => s.table)).not.toContain('stripe_connect_accounts');
    expect(payEnabled()).toBe(false);
  });

  it('falls back to the system-context read when the partner row is not visible', async () => {
    // Partner-axis RLS hides both the partner row and the stripe_connect row from a
    // caller without partner access, so only a system-context read can answer.
    state.rows.partners = [];
    await resendInvoiceEmail(invoice.id, actor, opts);

    expect(state.selects.filter((s) => s.nested).map((s) => s.table)).toEqual(['stripe_connect_accounts']);
    expect(payEnabled()).toBe(true);
  });
});
