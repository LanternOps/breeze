import { describe, expect, it } from 'vitest';
import {
  planTimeLineRefresh,
  summarizeRefresh,
  type RefreshEntry,
  type RefreshLine,
} from './invoiceTimeLineRefresh';

const ORG = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';

/** A line exactly as assembly would have written it for `entry()` below. */
function line(over: Partial<RefreshLine> = {}): RefreshLine {
  return {
    id: LINE, sourceId: ENTRY, description: 'Replaced toner', descriptionEdited: false,
    quantity: '1.50', workDate: '2026-09-16', workedMinutes: 90, isUnapprovedTime: false,
    ...over,
  };
}
function entry(over: Partial<RefreshEntry> = {}): RefreshEntry {
  return {
    id: ENTRY, orgId: ORG, ticketId: null, description: 'Replaced toner',
    durationMinutes: 90, billableMinutes: null, hourlyRate: '100.00', isApproved: true,
    isBillable: true, billingStatus: 'not_billed', currencyCode: 'USD',
    startedAt: new Date('2026-09-16T15:00:00Z'), endedAt: new Date('2026-09-16T16:30:00Z'),
    ...over,
  };
}
const ctx = { orgId: ORG, currencyCode: 'USD', timeZone: 'UTC', isHeld: () => false };

describe('planTimeLineRefresh (#8606)', () => {
  it('an entry description edited after assembly refreshes the line description', () => {
    const plan = planTimeLineRefresh(line(), entry({ description: 'Replaced toner and drum' }), ctx);
    expect(plan.outcome).toEqual({ lineId: LINE, status: 'refreshed', changed: ['description'] });
    expect(plan.set).toEqual({ description: 'Replaced toner and drum' });
  });

  it('an empty entry description refreshes to the assembly fallback, never an empty line', () => {
    const plan = planTimeLineRefresh(line(), entry({ description: '   ' }), ctx);
    expect(plan.set).toEqual({ description: 'Labor' });
  });

  it('a hand-edited line description survives, but its work date still refreshes', () => {
    const plan = planTimeLineRefresh(
      line({ description: 'Printer service (hand edited)', descriptionEdited: true }),
      entry({ description: 'Replaced toner and drum', startedAt: new Date('2026-09-17T15:00:00Z'), endedAt: new Date('2026-09-17T16:30:00Z') }),
      ctx,
    );
    expect(plan.outcome).toEqual({ lineId: LINE, status: 'refreshed', changed: ['workDate'] });
    expect(plan.set).toEqual({ workDate: '2026-09-17' });
  });

  it('dates a midnight-spanning entry by its START day in a non-UTC partner zone', () => {
    // 2026-09-17T02:30Z is 22:30 on Sep 16 in New York; the entry ends after local midnight.
    const plan = planTimeLineRefresh(
      line({ workDate: '2026-09-10' }),
      entry({ startedAt: new Date('2026-09-17T02:30:00Z'), endedAt: new Date('2026-09-17T04:00:00Z') }),
      { ...ctx, timeZone: 'America/New_York' },
    );
    expect(plan.set).toEqual({ workDate: '2026-09-16' });
  });

  it('refreshes worked minutes and the unapproved marker', () => {
    const plan = planTimeLineRefresh(
      line({ isUnapprovedTime: false, workedMinutes: 90 }),
      entry({ isApproved: false, durationMinutes: 85, billableMinutes: 90 }),
      ctx,
    );
    expect(plan.outcome).toEqual({ lineId: LINE, status: 'refreshed', changed: ['workedMinutes', 'isUnapprovedTime'] });
    expect(plan.set).toEqual({ workedMinutes: 85, isUnapprovedTime: true });
  });

  it('a changed billed duration is reported as quantityDrifted and the line is left alone', () => {
    const plan = planTimeLineRefresh(line(), entry({ durationMinutes: 120, description: 'New note' }), ctx);
    expect(plan.outcome).toEqual({ lineId: LINE, status: 'quantityDrifted', lineQuantity: '1.50', entryQuantity: '2.00' });
    expect(plan.set).toBeUndefined();
  });

  it('a hand-edited line quantity is also drift, never overwritten', () => {
    const plan = planTimeLineRefresh(line({ quantity: '1.00' }), entry(), ctx);
    expect(plan.outcome.status).toBe('quantityDrifted');
    expect(plan.set).toBeUndefined();
  });

  it('never proposes a quantity, unit price or line total change', () => {
    const plan = planTimeLineRefresh(line({ workDate: null, workedMinutes: null, description: 'x' }), entry({ hourlyRate: '250.00' }), ctx);
    expect(Object.keys(plan.set ?? {}).sort()).toEqual(['description', 'workDate', 'workedMinutes']);
  });

  it('an unchanged line is reported unchanged with no write (refresh is idempotent)', () => {
    const plan = planTimeLineRefresh(line(), entry(), ctx);
    expect(plan.outcome).toEqual({ lineId: LINE, status: 'unchanged' });
    expect(plan.set).toBeUndefined();
  });

  it('leaves workDate NULL when the entry has no start time', () => {
    const plan = planTimeLineRefresh(line({ workDate: null }), entry({ startedAt: null }), ctx);
    expect(plan.outcome.status).toBe('unchanged');
  });

  it.each([
    ['source_missing', undefined, line()],
    ['source_missing', entry(), line({ sourceId: null })],
    ['billed_elsewhere', entry({ billingStatus: 'billed' }), line()],
    ['contract', entry({ billingStatus: 'contract' }), line()],
    ['no_charge', entry({ billingStatus: 'no_charge' }), line()],
    ['other_org', entry({ orgId: '44444444-4444-4444-8444-444444444444' }), line()],
    ['not_billable', entry({ isBillable: false }), line()],
    ['not_ended', entry({ endedAt: null }), line()],
    ['currency_mismatch', entry({ currencyCode: 'EUR' }), line()],
    ['missing_rate', entry({ hourlyRate: null }), line()],
  ] as const)('skips with reason %s and writes nothing', (reason, e, l) => {
    const plan = planTimeLineRefresh(l, e, ctx);
    expect(plan.outcome).toEqual({ lineId: LINE, status: 'skipped', reason });
    expect(plan.set).toBeUndefined();
  });

  it('skips an entry a block of hours will bill (held), never refreshing it', () => {
    const plan = planTimeLineRefresh(line(), entry({ description: 'Changed' }), { ...ctx, isHeld: () => true });
    expect(plan.outcome).toEqual({ lineId: LINE, status: 'skipped', reason: 'held_for_hour_block' });
    expect(plan.set).toBeUndefined();
  });

  it('summarizes outcomes by status', () => {
    expect(summarizeRefresh([
      { lineId: 'a', status: 'refreshed', changed: ['description'] },
      { lineId: 'b', status: 'unchanged' },
      { lineId: 'c', status: 'skipped', reason: 'billed_elsewhere' },
      { lineId: 'd', status: 'quantityDrifted', lineQuantity: '1.00', entryQuantity: '2.00' },
      { lineId: 'e', status: 'refreshed', changed: ['workDate'] },
    ])).toEqual({ refreshed: 2, unchanged: 1, skipped: 1, quantityDrifted: 1 });
  });
});
