import { describe, expect, it } from 'vitest';
import { decideTicketsPage } from './ticketsPage';

describe('decideTicketsPage', () => {
  it('shows support usage without the ticket list when tickets are disabled and usage succeeds', () => {
    expect(decideTicketsPage(
      { statusCode: 403, code: 'PORTAL_TICKETS_DISABLED' },
      { statusCode: 200 },
    )).toEqual({
      ticketsDisabled: true,
      usageStrictlyDisabled: false,
      redirectToDevices: false,
    });
  });

  it('redirects when both tickets and support usage are disabled', () => {
    expect(decideTicketsPage(
      { statusCode: 403, code: 'PORTAL_TICKETS_DISABLED' },
      { statusCode: 403 },
    ).redirectToDevices).toBe(true);
  });

  it('redirects when tickets are disabled and support usage is unavailable', () => {
    expect(decideTicketsPage(
      { statusCode: 403, code: 'PORTAL_TICKETS_DISABLED' },
      { statusCode: 500 },
    ).redirectToDevices).toBe(true);
  });

  it('shows the normal ticket list when tickets are available', () => {
    expect(decideTicketsPage(
      { statusCode: 200 },
      { statusCode: 403 },
    )).toEqual({
      ticketsDisabled: false,
      usageStrictlyDisabled: true,
      redirectToDevices: false,
    });
  });
});
