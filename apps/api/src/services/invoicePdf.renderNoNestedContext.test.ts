/**
 * #9454 — renderInvoicePdf must not open a second (system-context) connection
 * when the loader could read on the caller's connection.
 *
 * The accepted-quote auto-email runs renderInvoicePdf inside an open system-context
 * transaction (autoEmailAcceptedInvoice → sendInvoiceEmail → renderInvoicePdf). A
 * nested `runOutsideDbContext(withSystemDbAccessContext(...))` read there takes a
 * SECOND pool connection while the outer backend sits idle in transaction; behind a
 * pending ACCESS EXCLUSIVE request (TRUNCATE, DDL, VACUUM FULL) the two wait on each
 * other. W3a moved the partner/branding reads onto the caller's connection (the
 * `preloaded` bundle); this covers the online-payment availability read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { extractPositionedPdfText, makeFixtureInvoice } from '../testUtils/invoiceRenderFixtures';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  selects: [] as { table: string; nested: boolean }[],
  depth: 0,
  failTable: null as string | null,
  inserts: 0,
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
  const insertChain = {
    values: () => insertChain,
    onConflictDoUpdate: () => insertChain,
    returning: () => Promise.resolve([{ id: 'doc-1' }]),
  };
  const updateChain = { set: () => updateChain, where: () => Promise.resolve([]) };
  const nested = async <T>(fn: () => Promise<T>): Promise<T> => {
    state.depth += 1;
    try { return await fn(); } finally { state.depth -= 1; }
  };
  return {
    db: { select, insert: () => { state.inserts += 1; return insertChain; }, update: () => updateChain },
    runOutsideDbContext: vi.fn(nested),
    withSystemDbAccessContext: vi.fn(nested),
  };
});

vi.mock('./invoiceLinkToken', () => ({
  getOrMintInvoiceLink: vi.fn(async () => ({ token: 'tok-9454' })),
  buildPublicInvoiceUrl: (token: string) => `https://pay.example.test/i/${token}`,
}));

import { runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { getOrMintInvoiceLink } from './invoiceLinkToken';
import { renderInvoicePdf } from './invoicePdf';

const invoice = makeFixtureInvoice({ id: 'inv-9454', partnerId: 'p-1', orgId: 'o-1', status: 'sent', deviceAppendix: false });
const partner = { id: 'p-1', name: 'Example MSP', billingEmail: 'billing@example.test', invoiceFooter: null, currencyCode: 'USD', settings: {} };
const connected = { status: 'connected', apiKey: 'enc:key' };

const pdfText = (pdf: Buffer) => extractPositionedPdfText(pdf).map((f) => f.text).join('\n');

beforeEach(() => {
  state.rows = { invoices: [invoice], partners: [partner], portal_branding: [], stripe_connect_accounts: [connected] };
  state.selects = [];
  state.depth = 0;
  state.failTable = null;
  state.inserts = 0;
  vi.mocked(runOutsideDbContext).mockClear();
  vi.mocked(withSystemDbAccessContext).mockClear();
  vi.mocked(getOrMintInvoiceLink).mockClear();
});

describe('renderInvoicePdf online-payment availability (#9454)', () => {
  it('reads it on the caller connection when the partner row is visible: no nested system context', async () => {
    const { pdf } = await renderInvoicePdf(invoice.id);

    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(state.selects.filter((s) => s.nested)).toEqual([]);
    expect(state.selects.map((s) => s.table)).toContain('stripe_connect_accounts');
    // Behaviour unchanged: a connected partner still gets the pay-online line.
    expect(getOrMintInvoiceLink).toHaveBeenCalledTimes(1);
    expect(pdfText(pdf)).toContain('pay.example.test/i/tok-9454');
  });

  it('prints no pay-online line when the caller-connection read finds no usable Stripe key', async () => {
    state.rows.stripe_connect_accounts = [{ status: 'connected', apiKey: null }];
    const { pdf } = await renderInvoicePdf(invoice.id);

    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(getOrMintInvoiceLink).not.toHaveBeenCalled();
    expect(pdfText(pdf)).not.toContain('pay.example.test');
  });

  it('a failed availability read fails the render: nothing frozen without the pay line', async () => {
    // The issued PDF is persisted and frozen, so a transient fault must fail the render
    // (retryable), never bake in a line-less copy.
    state.rows.stripe_connect_accounts = [];
    state.failTable = 'stripe_connect_accounts';
    await expect(renderInvoicePdf(invoice.id)).rejects.toThrow('read of stripe_connect_accounts failed');
    expect(state.inserts).toBe(0);
  });

  it('a failed fallback (system-context) read fails the render too', async () => {
    state.rows.partners = [];
    state.failTable = 'stripe_connect_accounts';
    await expect(renderInvoicePdf(invoice.id)).rejects.toThrow('read of stripe_connect_accounts failed');
    expect(state.inserts).toBe(0);
  });

  it('a draft never reads availability at all (no pay link on a draft)', async () => {
    state.rows.invoices = [{ ...invoice, status: 'draft' }];
    await renderInvoicePdf(invoice.id);

    expect(state.selects.map((s) => s.table)).not.toContain('stripe_connect_accounts');
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(getOrMintInvoiceLink).not.toHaveBeenCalled();
  });

  it('falls back to the system-context read when the partner row is not visible (org-scoped caller)', async () => {
    // Partner-axis RLS hides both the partner row and the stripe_connect row from an
    // org-scoped caller, so only a system-context read can answer — unchanged path.
    // (The assembler's own partner/branding fallback reads are W3a's, also nested here.)
    state.rows.partners = [];
    const { pdf } = await renderInvoicePdf(invoice.id);

    const nested = state.selects.filter((s) => s.nested).map((s) => s.table);
    expect(nested).toContain('stripe_connect_accounts');
    expect(state.selects.filter((s) => !s.nested).map((s) => s.table)).not.toContain('stripe_connect_accounts');
    expect(getOrMintInvoiceLink).toHaveBeenCalledTimes(1);
    expect(pdfText(pdf)).toContain('pay.example.test/i/tok-9454');
  });
});
