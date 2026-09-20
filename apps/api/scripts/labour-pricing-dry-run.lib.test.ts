import { describe, expect, it } from 'vitest';
import { buildDryRunReport, formatReport } from './labour-pricing-dry-run.lib';

const partner = { id: 'p1', name: 'Acme MSP', currencyCode: 'USD' };
const cat = (o: Partial<Parameters<typeof buildDryRunReport>[0]['categories'][number]>) => ({
  id: 'c1', partnerId: 'p1', parentId: null, name: 'Support', isActive: true,
  defaultBillable: null, defaultHourlyRate: null, rateCurrency: null, ...o,
});
const org = (o: Partial<Parameters<typeof buildDryRunReport>[0]['orgs'][number]>) => ({
  orgId: 'o1', orgName: 'Customer A', partnerId: 'p1', currencyCode: 'USD',
  defaultBillable: null, defaultHourlyRate: null, rateCurrency: null, uncategorisedEntryCount: 0, ...o,
});

describe('the money-moving difference', () => {
  it('FLAGS an org with a matching-currency rate and a NULL billable default', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'USD', uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([
      { orgId: 'o1', orgName: 'Customer A', orgRate: '150.00', currency: 'USD', recentEntryCount: 42 },
    ]);
  });

  it('does NOT flag an org that explicitly set billable=false — that org keeps its answer', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: false, defaultHourlyRate: '150.00', rateCurrency: 'USD', uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([]);
  });

  it('does NOT flag an org with a NULL billable default but NO rate — billable-at-no-rate bills nothing', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [], orgs: [org({ defaultBillable: null, uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([]);
  });

  it('does NOT flag an org whose rate was entered in a DIFFERENT currency — match-or-skip means it never applied', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'EUR', currencyCode: 'USD', uncategorisedEntryCount: 42 })],
    });
    expect(r.uncategorisedBecomingBillable).toEqual([]);
  });
});

describe('category → work type conversion preview', () => {
  it('converts a category that carries a rate', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ defaultHourlyRate: '200.00', rateCurrency: 'USD' })], orgs: [],
    });
    expect(r.workTypesToCreate).toEqual([{ name: 'Support', fromCategoryIds: ['c1'], inactive: false }]);
    expect(r.rows).toContainEqual({ currency: 'USD', workTypeName: 'Support', coverage: 'billable', rate: '200.00' });
  });

  it('converts an INACTIVE category too — getCategoryDefaults does not filter is_active, so retired categories still price entries today', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ isActive: false, defaultHourlyRate: '200.00', rateCurrency: 'USD' })], orgs: [],
    });
    expect(r.workTypesToCreate).toEqual([{ name: 'Support', fromCategoryIds: ['c1'], inactive: true }]);
  });

  it('IGNORES a category that carries neither a rate nor a non-billable flag', () => {
    const [r] = buildDryRunReport({ partners: [partner], categories: [cat({})], orgs: [] });
    expect(r.workTypesToCreate).toEqual([]);
  });

  it('merges same-name same-pricing categories into ONE work type', () => {
    const [r] = buildDryRunReport({
      partners: [partner],
      categories: [cat({ id: 'c1', defaultHourlyRate: '200.00', rateCurrency: 'USD' }),
                   cat({ id: 'c2', defaultHourlyRate: '200.00', rateCurrency: 'USD' })],
      orgs: [],
    });
    expect(r.workTypesToCreate).toEqual([{ name: 'Support', fromCategoryIds: ['c1', 'c2'], inactive: false }]);
    expect(r.nameCollisions).toEqual([]);
  });

  it('REPORTS a collision when same-name categories price DIFFERENTLY, and suffixes with the parent path', () => {
    const [r] = buildDryRunReport({
      partners: [partner],
      categories: [
        cat({ id: 'parentA', name: 'Hardware', defaultHourlyRate: null }),
        cat({ id: 'c1', parentId: 'parentA', defaultHourlyRate: '200.00', rateCurrency: 'USD' }),
        cat({ id: 'c2', defaultHourlyRate: '250.00', rateCurrency: 'USD' }),
      ],
      orgs: [],
    });
    expect(r.nameCollisions).toHaveLength(1);
    expect(r.nameCollisions[0].resolvedNames).toEqual(expect.arrayContaining([expect.stringContaining('Hardware')]));
  });

  it('SKIPS a wrong-currency category rate — no row in any card, never a converted number', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ defaultHourlyRate: '200.00', rateCurrency: 'GBP' })],
      orgs: [org({ currencyCode: 'USD' })],
    });
    expect(r.rows.filter((x) => x.currency === 'USD' && x.rate !== null)).toEqual([]);
    expect(r.skippedWrongCurrencyRates).toHaveLength(1);
  });

  it('DROPS the rate on a non-billable category and counts it (second declared difference)', () => {
    const [r] = buildDryRunReport({
      partners: [partner], categories: [cat({ defaultBillable: false, defaultHourlyRate: '200.00', rateCurrency: 'USD' })], orgs: [],
    });
    expect(r.rows).toContainEqual({ currency: 'USD', workTypeName: 'Support', coverage: 'non_billable', rate: null });
    expect(r.droppedNonBillableRates).toEqual([{ categoryId: 'c1', name: 'Support', rate: '200.00' }]);
  });
});

describe('default cards', () => {
  it('creates one card per currency in {org currencies} ∪ {category rate currencies} ∪ {partner currency}', () => {
    const [r] = buildDryRunReport({
      partners: [partner],
      categories: [cat({ defaultHourlyRate: '10.00', rateCurrency: 'GBP' })],
      orgs: [org({ currencyCode: 'EUR' })],
    });
    expect(r.cardCurrencies.sort()).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('creates a card even for a partner with no orgs and no priced categories', () => {
    const [r] = buildDryRunReport({ partners: [partner], categories: [], orgs: [] });
    expect(r.cardCurrencies).toEqual(['USD']);
  });
});

describe('formatReport', () => {
  it('puts the money-moving section first and states the org count in its heading', () => {
    const out = formatReport(buildDryRunReport({
      partners: [partner], categories: [],
      orgs: [org({ defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'USD', uncategorisedEntryCount: 42 })],
    }));
    const moneyIdx = out.indexOf('WILL START BILLING');
    expect(moneyIdx).toBeGreaterThanOrEqual(0);
    expect(out.slice(0, moneyIdx + 200)).toMatch(/1 organization/);
    expect(out).toMatch(/Customer A/);
    expect(out).toMatch(/42/);
  });
});

// ---------------------------------------------------------------------------
// PARITY WITH THE LIVE RESOLVER
//
// The report's headline — "these orgs' uncategorised tickets start billing" —
// is a PREDICTION about what timeEntryService does today versus what W02's
// conversion will do. It is computed by a second, independent implementation
// here, so it can drift from the resolver silently and Todd would read a
// confident number that is simply wrong.
//
// This drives the same fixtures through the REAL exported resolver
// (resolveDefaultRate) and the real legacy billable chain from
// resolveTicketLink — `orgSettings?.defaultBillable ?? category?.defaultBillable
// ?? false`, with category = null because these tickets are UNCATEGORISED — and
// asserts the biconditional the report claims:
//
//   flagged  ⟺  the ticket is non-billable TODAY ONLY because of the `?? false`
//               fallback (org.defaultBillable IS NULL)  AND  a default rate
//               would resolve under the org's own currency.
// ---------------------------------------------------------------------------
import { resolveDefaultRate } from '../src/services/timeEntryService';

/** These tickets are UNCATEGORISED, so the category term of the chain is null. */
const CATEGORY_DEFAULT_BILLABLE: boolean | null = null;

/** The legacy billable answer for an UNCATEGORISED ticket, verbatim from resolveTicketLink. */
const legacyBillable = (o: ReturnType<typeof org>): boolean =>
  o.defaultBillable ?? CATEGORY_DEFAULT_BILLABLE ?? false;

describe('dry-run report parity with the live rate/billable resolver', () => {
  const cases = [
    { label: 'null billable + matching-currency rate', defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'USD' },
    { label: 'null billable + wrong-currency rate', defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'EUR' },
    { label: 'null billable + no rate', defaultBillable: null, defaultHourlyRate: null, rateCurrency: null },
    { label: 'explicit false + matching rate', defaultBillable: false, defaultHourlyRate: '150.00', rateCurrency: 'USD' },
    { label: 'explicit false + no rate', defaultBillable: false, defaultHourlyRate: null, rateCurrency: null },
    { label: 'explicit true + matching rate', defaultBillable: true, defaultHourlyRate: '150.00', rateCurrency: 'USD' },
    { label: 'explicit true + no rate', defaultBillable: true, defaultHourlyRate: null, rateCurrency: null },
  ] as const;

  it.each(cases)('$label: the report agrees with the resolver', (c) => {
    const o = org({
      defaultBillable: c.defaultBillable,
      defaultHourlyRate: c.defaultHourlyRate,
      rateCurrency: c.rateCurrency,
      uncategorisedEntryCount: 7,
    });
    const [report] = buildDryRunReport({ partners: [partner], categories: [], orgs: [o] });

    // The live resolver, on the same inputs. `rateCurrency` is non-null in the
    // resolver's org shape whenever a rate exists; a null rate makes it moot.
    const resolvedRate = resolveDefaultRate(
      o.currencyCode,
      { defaultHourlyRate: o.defaultHourlyRate, rateCurrency: o.rateCurrency ?? '' },
      null,
    );
    const nonBillableOnlyByFallback = legacyBillable(o) === false && o.defaultBillable === null;
    const expectedFlag = nonBillableOnlyByFallback && resolvedRate !== null;

    expect(report!.uncategorisedBecomingBillable.length > 0).toBe(expectedFlag);
    if (expectedFlag) {
      expect(report!.uncategorisedBecomingBillable[0]).toMatchObject({
        orgId: o.orgId, orgRate: resolvedRate, currency: o.currencyCode, recentEntryCount: 7,
      });
    }
  });

  // CONTROL: the biconditional above is not vacuously true — the fixture set
  // must exercise BOTH branches, or a report that flagged nothing at all (or
  // everything) would pass every case.
  it('CONTROL: the fixture set produces both flagged and unflagged orgs', () => {
    const flags = cases.map((c) => {
      const [report] = buildDryRunReport({
        partners: [partner],
        categories: [],
        orgs: [org({ defaultBillable: c.defaultBillable, defaultHourlyRate: c.defaultHourlyRate, rateCurrency: c.rateCurrency })],
      });
      return report!.uncategorisedBecomingBillable.length > 0;
    });
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  // The rate the report PRINTS must be the number the resolver would stamp,
  // not a lookalike read straight off the column (which would be wrong for a
  // wrong-currency rate).
  it('prints the resolver\'s rate, never the raw column, when currencies differ', () => {
    const o = org({ defaultBillable: null, defaultHourlyRate: '150.00', rateCurrency: 'EUR', currencyCode: 'USD' });
    const [report] = buildDryRunReport({ partners: [partner], categories: [], orgs: [o] });
    expect(resolveDefaultRate('USD', { defaultHourlyRate: '150.00', rateCurrency: 'EUR' }, null)).toBeNull();
    expect(report!.uncategorisedBecomingBillable).toEqual([]);
  });
});
