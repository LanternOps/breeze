import { describe, expect, it } from 'vitest';
import { decideTicketsPage, hourBlockPanelState, shouldLoadHourBlock } from './ticketsPage';

describe('decideTicketsPage', () => {
  it('shows support usage without the ticket list when tickets are disabled and usage succeeds', () => {
    expect(decideTicketsPage(
      { statusCode: 403, code: 'PORTAL_TICKETS_DISABLED' },
      { statusCode: 200 },
    )).toEqual({
      ticketsDisabled: true,
      usageStrictlyDisabled: false,
      redirectHome: false,
    });
  });

  it('redirects when both tickets and support usage are disabled', () => {
    expect(decideTicketsPage(
      { statusCode: 403, code: 'PORTAL_TICKETS_DISABLED' },
      { statusCode: 403 },
    ).redirectHome).toBe(true);
  });

  it('redirects when tickets are disabled and support usage is unavailable', () => {
    expect(decideTicketsPage(
      { statusCode: 403, code: 'PORTAL_TICKETS_DISABLED' },
      { statusCode: 500 },
    ).redirectHome).toBe(true);
  });

  it('shows the normal ticket list when tickets are available', () => {
    expect(decideTicketsPage(
      { statusCode: 200 },
      { statusCode: 403 },
    )).toEqual({
      ticketsDisabled: false,
      usageStrictlyDisabled: true,
      redirectHome: false,
    });
  });
});

describe('shouldLoadHourBlock', () => {
  it('loads only when the branding flag is strictly true AND Support usage itself loaded', () => {
    expect(shouldLoadHourBlock({ enableHourBlock: true }, { statusCode: 200 })).toBe(true);
    expect(shouldLoadHourBlock({ enableHourBlock: true }, { statusCode: 403 })).toBe(false);
    expect(shouldLoadHourBlock({ enableHourBlock: true }, { statusCode: 500 })).toBe(false);
    expect(shouldLoadHourBlock({ enableHourBlock: false }, { statusCode: 200 })).toBe(false);
    expect(shouldLoadHourBlock({}, { statusCode: 200 })).toBe(false);
  });
});

describe('hourBlockPanelState', () => {
  const dto = {
    periodStart: '2026-12-01', periodEnd: '2027-01-01', includedHours: 10, carriedInHours: 0,
    usedHours: 1, remainingHours: 9, overageHours: 0, overageRate: '150.00',
    currencyCode: 'USD', billingTiming: 'advance' as const,
  };

  it('passes the block through on success', () => {
    expect(hourBlockPanelState({ statusCode: 200, data: { hourBlock: dto, startsOn: null } }))
      .toEqual({ hourBlock: dto, hourBlockStartsOn: null, hourBlockError: undefined });
  });

  it('carries the start date of a block that has not started yet (no card)', () => {
    expect(hourBlockPanelState({ statusCode: 200, data: { hourBlock: null, startsOn: '2026-12-01' } }))
      .toEqual({ hourBlock: null, hourBlockStartsOn: '2026-12-01', hourBlockError: undefined });
  });

  it('is empty (no card, no error) when not requested, when there is no block, or when the flag raced to 403', () => {
    const empty = { hourBlock: null, hourBlockStartsOn: null, hourBlockError: undefined };
    expect(hourBlockPanelState(null)).toEqual(empty);
    expect(hourBlockPanelState({ statusCode: 200, data: { hourBlock: null, startsOn: null } })).toEqual(empty);
    expect(hourBlockPanelState({ statusCode: 403 })).toEqual(empty);
  });

  it('reports a load failure instead of silently dropping the card', () => {
    expect(hourBlockPanelState({ statusCode: 500 }).hourBlockError)
      .toBe('Your support hours could not be loaded right now.');
  });
});
