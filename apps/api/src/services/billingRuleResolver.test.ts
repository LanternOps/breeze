import { describe, expect, it } from 'vitest';
import { resolveBillingRule, type ResolvedCard } from './billingRuleResolver';

const card = (o: Partial<ResolvedCard> = {}): ResolvedCard => ({
  id: 'card-1', currencyCode: 'USD', roundingIncrementMinutes: null,
  baseCoverage: 'billable', baseHourlyRate: '150.00', baseMinimumMinutes: null, rules: [], ...o,
});

describe('which card', () => {
  it.each([
    ['no assigned card', null],
    ['wrong-currency assigned card', card({ currencyCode: 'EUR' })],
  ])('rejects a wrong-currency default with %s', (_name, assignedCard) => {
    expect(resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null, assignedCard,
      partnerDefaultCard: card({ currencyCode: 'CAD' }),
    })).toEqual({
      billingProfileId: null, coverage: 'billable', hourlyRate: null,
      minimumMinutes: null, roundingIncrementMinutes: null,
      isBillable: true, billingStatus: 'not_billed', fellBackToNoCard: true,
    });
  });
  it('prefers the ASSIGNED card over the partner default', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null,
      assignedCard: card({ id: 'assigned', baseHourlyRate: '225.00' }),
      partnerDefaultCard: card({ id: 'default', baseHourlyRate: '150.00' }),
    });
    expect(r.billingProfileId).toBe('assigned');
    expect(r.hourlyRate).toBe('225.00');
  });

  it('SKIPS a wrong-currency assigned card and falls to the partner default — never converts', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null,
      assignedCard: card({ id: 'assigned', currencyCode: 'EUR', baseHourlyRate: '200.00' }),
      partnerDefaultCard: card({ id: 'default', baseHourlyRate: '150.00' }),
    });
    expect(r.billingProfileId).toBe('default');
    expect(r.hourlyRate).toBe('150.00');
  });

  it('SKIPS an INACTIVE assigned card', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null,
      assignedCard: null, // an inactive card is filtered by the LOADER; this
                          // case pins that the resolver handles the null it gets
      partnerDefaultCard: card({ id: 'default' }),
    });
    expect(r.billingProfileId).toBe('default');
  });

  it('falls back to "billable, no rate" with fellBackToNoCard when there is NO card at all', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null, partnerDefaultCard: null });
    expect(r).toMatchObject({
      billingProfileId: null, coverage: 'billable', hourlyRate: null,
      isBillable: true, billingStatus: 'not_billed', fellBackToNoCard: true,
    });
  });

  it('a standalone entry with NO org resolves to the no-card safety net', () => {
    const r = resolveBillingRule({ orgCurrency: null, workTypeId: null, assignedCard: null, partnerDefaultCard: card() });
    expect(r.fellBackToNoCard).toBe(true);
    expect(r.billingProfileId).toBeNull();
  });
});

describe('which row', () => {
  it('takes a rate-less assigned row as a unit without inheriting base or default values', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: 'wt-onsite',
      assignedCard: card({
        id: 'assigned', baseMinimumMinutes: 60, roundingIncrementMinutes: 15,
        rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: null, minimumMinutes: null }],
      }),
      partnerDefaultCard: card({
        rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60 }],
      }),
    });
    expect(r).toMatchObject({
      billingProfileId: 'assigned', hourlyRate: null, minimumMinutes: null,
      roundingIncrementMinutes: 15, fellBackToNoCard: false,
    });
  });

  it('uses the assigned base row rather than a matching row on the partner default', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: 'wt-onsite', assignedCard: card({ id: 'assigned' }),
      partnerDefaultCard: card({
        rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60 }],
      }),
    });
    expect(r).toMatchObject({ billingProfileId: 'assigned', hourlyRate: '150.00', minimumMinutes: null });
  });
  it('uses the work-type row when one exists', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: 'wt-onsite', assignedCard: null,
      partnerDefaultCard: card({ rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: 60 }] }),
    });
    expect(r).toMatchObject({ hourlyRate: '225.00', minimumMinutes: 60, coverage: 'billable' });
  });

  it('falls to the BASE row when the card has no row for that work type', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: 'wt-new', assignedCard: null,
      partnerDefaultCard: card({ baseHourlyRate: '150.00', rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: null }] }),
    });
    expect(r.hourlyRate).toBe('150.00');
  });

  it('falls to the BASE row when the entry has NO work type', () => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseHourlyRate: '150.00', rules: [{ workTypeId: 'wt-onsite', coverage: 'billable', hourlyRate: '225.00', minimumMinutes: null }] }),
    });
    expect(r.hourlyRate).toBe('150.00');
  });
});

describe('what gets stamped (spec §3.4)', () => {
  it.each(['included', 'non_billable'] as const)('discards stray rate and minimum values on %s rows', (coverage) => {
    const r = resolveBillingRule({
      orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: coverage, baseHourlyRate: '999.00', baseMinimumMinutes: 60 }),
    });
    expect(r).toMatchObject({ coverage, hourlyRate: null, minimumMinutes: null });
  });
  it('billable @ R → isBillable true, not_billed, rate R', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'billable', baseHourlyRate: '150.00', baseMinimumMinutes: 30, roundingIncrementMinutes: 15 }) });
    expect(r).toMatchObject({ isBillable: true, billingStatus: 'not_billed', hourlyRate: '150.00', minimumMinutes: 30, roundingIncrementMinutes: 15 });
  });

  it('INCLUDED → isBillable TRUE, status contract, rate NULL — the rate must be null or three money readers inflate', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'included', baseHourlyRate: null }) });
    expect(r).toMatchObject({ coverage: 'included', isBillable: true, billingStatus: 'contract', hourlyRate: null });
  });

  it('INCLUDED discards any rate that somehow reached the row — defence in depth over the CHECK', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: 'wt-x', assignedCard: null,
      partnerDefaultCard: card({ rules: [{ workTypeId: 'wt-x', coverage: 'included', hourlyRate: '999.00', minimumMinutes: null }] }) });
    expect(r.hourlyRate).toBeNull();
  });

  it('non_billable → isBillable false, not_billed, rate NULL (today\'s entry minus the pointless rate)', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'non_billable', baseHourlyRate: null }) });
    expect(r).toMatchObject({ coverage: 'non_billable', isBillable: false, billingStatus: 'not_billed', hourlyRate: null });
  });

  it('a billable row with NO rate is legal — "price at invoice review"; assembly buckets it as missingRate', () => {
    const r = resolveBillingRule({ orgCurrency: 'USD', workTypeId: null, assignedCard: null,
      partnerDefaultCard: card({ baseCoverage: 'billable', baseHourlyRate: null }) });
    expect(r).toMatchObject({ isBillable: true, hourlyRate: null, fellBackToNoCard: false });
  });
});
