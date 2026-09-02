/**
 * Multi-currency wave 6 (#3778), review finding 1 — ERROR MAPPING at every
 * `readOrgStampingDefaults` call site.
 *
 * `orgCurrencyCore` is deliberately domain-neutral: it throws
 * `OrgCurrencyServiceError('Organization not found', 404, 'ORG_NOT_FOUND')` and
 * documents that each caller maps it onto its own error class at its boundary.
 * Only `orgCurrencyService` and `catalogService` did. Every other constructor
 * (manual invoice, org/ticket assembly, quote, contract, org ticket settings)
 * used to throw its OWN typed 404 for a missing org and now lets the neutral
 * error escape — and the route boundaries (`handleServiceError`,
 * `handleContractError`, ticketConfig's handler) `throw err` on anything they
 * do not recognise, so it lands in Hono's onError as an unhandled **500**.
 *
 * Reachable whenever the org is missing at the LOCKING read: a system-scope
 * caller passing a bad orgId, or an org deleted between the access check and
 * the transaction. These assertions pin the domain error class + 404, which is
 * what makes the route map it instead of rethrowing.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/quoteEvents', () => ({ emitQuoteEvent: vi.fn().mockResolvedValue(undefined) }));

import { withSystemDbAccessContext } from '../../db';
import { createManualInvoice, assembleDraftFromOrg } from '../../services/invoiceService';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { createQuote } from '../../services/quoteService';
import { QuoteServiceError } from '../../services/quoteTypes';
import { createContract } from '../../services/contractService';
import { ContractServiceError } from '../../services/contractTypes';
import { upsertOrgTicketSettings, TicketConfigServiceError } from '../../services/ticketConfigService';
import { seedGateOrg } from './multiCurrencyWave6GateFixtures';

const RUN = !!process.env.DATABASE_URL;

/** A well-formed uuid that is not an organization — the "org vanished / bad id
 *  from a system-scope caller" shape, evaluated at the locking read. */
const MISSING_ORG = '00000000-0000-4000-8000-0000000000ff';

describe.runIf(RUN)('readOrgStampingDefaults error mapping (#3778, finding 1)', () => {
  it('createManualInvoice maps ORG_NOT_FOUND onto InvoiceServiceError 404', async () => {
    const f = await seedGateOrg('EUR');
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: null };
    const err = await withSystemDbAccessContext(() =>
      createManualInvoice({ orgId: MISSING_ORG }, actor).then(() => null, (e: unknown) => e));
    expect(err).toBeInstanceOf(InvoiceServiceError);
    expect(err).toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
  });

  it('assembleDraftFromOrg maps ORG_NOT_FOUND onto InvoiceServiceError 404', async () => {
    const f = await seedGateOrg('EUR');
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: null };
    const err = await withSystemDbAccessContext(() =>
      assembleDraftFromOrg({ orgId: MISSING_ORG, from: '2026-07-01', to: '2026-07-31' }, actor)
        .then(() => null, (e: unknown) => e));
    expect(err).toBeInstanceOf(InvoiceServiceError);
    expect(err).toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
  });

  it('createQuote maps ORG_NOT_FOUND onto QuoteServiceError 404', async () => {
    const f = await seedGateOrg('EUR');
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: null };
    const err = await withSystemDbAccessContext(() =>
      createQuote({ orgId: MISSING_ORG, title: 'mapping' } as never, actor as never)
        .then(() => null, (e: unknown) => e));
    expect(err).toBeInstanceOf(QuoteServiceError);
    expect(err).toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
  });

  it('createContract maps ORG_NOT_FOUND onto ContractServiceError 404', async () => {
    const f = await seedGateOrg('EUR');
    const actor = { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: null, permissions: new Set<string>() };
    const err = await withSystemDbAccessContext(() =>
      createContract({
        orgId: MISSING_ORG, name: 'mapping MSA', billingTiming: 'advance',
        intervalMonths: 1, startDate: '2026-07-01',
      }, actor).then(() => null, (e: unknown) => e));
    expect(err).toBeInstanceOf(ContractServiceError);
    expect(err).toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
  });

  it('upsertOrgTicketSettings maps ORG_NOT_FOUND onto TicketConfigServiceError 404', async () => {
    const err = await withSystemDbAccessContext(() =>
      upsertOrgTicketSettings(MISSING_ORG, { defaultHourlyRate: 100 })
        .then(() => null, (e: unknown) => e));
    expect(err).toBeInstanceOf(TicketConfigServiceError);
    expect(err).toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
  });
});
