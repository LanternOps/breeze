import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import {
  getTicketPushPrefs,
  TICKET_PUSH_PREFERENCE_DEFAULTS,
  updateTicketPushPrefs,
} from './ticketPushPrefs';

beforeEach(() => {
  coreRequest.mockReset();
});

describe('getTicketPushPrefs (#4336)', () => {
  it('reads the CORE endpoint and unwraps `settings`', async () => {
    // Path matters twice over: `coreRequest` prefixes /api/v1, while the
    // default `request` helper prefixes /api/v1/mobile — and there is no
    // ticket-push route under the mobile namespace, so the wrong helper is a
    // silent 404 that looks exactly like "no preferences saved".
    coreRequest.mockResolvedValue({ settings: { assignedEnabled: false, slaScope: 'any' } });

    await expect(getTicketPushPrefs()).resolves.toEqual({
      assignedEnabled: false,
      slaScope: 'any',
    });
    expect(coreRequest).toHaveBeenCalledWith('/users/me/ticket-push-preferences');
  });

  it('falls back to the shipped defaults when the server sends nothing usable', async () => {
    // Defaults live on the server too (resolveTicketPushPrefs); this guard is
    // for a truncated/odd body, so the Settings sheet never renders `undefined`
    // as an unchecked switch and writes a change the user did not make.
    coreRequest.mockResolvedValue({});

    await expect(getTicketPushPrefs()).resolves.toEqual(TICKET_PUSH_PREFERENCE_DEFAULTS);
  });

  it('coerces an unknown slaScope back to the default rather than trusting it', async () => {
    coreRequest.mockResolvedValue({ settings: { assignedEnabled: true, slaScope: 'everything' } });

    await expect(getTicketPushPrefs()).resolves.toEqual({
      assignedEnabled: true,
      slaScope: 'owned',
    });
  });
});

describe('updateTicketPushPrefs (#4336)', () => {
  it('PATCHes only the changed keys and returns the server echo', async () => {
    // The API schema is `.strict()`: sending a key it does not know (a stale
    // field, a userId) is a 400, so the patch must stay minimal.
    coreRequest.mockResolvedValue({ settings: { assignedEnabled: true, slaScope: 'any' } });

    await expect(updateTicketPushPrefs({ slaScope: 'any' })).resolves.toEqual({
      assignedEnabled: true,
      slaScope: 'any',
    });

    expect(coreRequest).toHaveBeenCalledWith('/users/me/ticket-push-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slaScope: 'any' }),
    });
  });

  it('propagates a failure instead of resolving to defaults', async () => {
    // The slice rolls the optimistic value back on a rejection. Swallowing the
    // error here would leave the UI showing a setting the server never stored.
    coreRequest.mockRejectedValue({ message: 'Network down', statusCode: 0 });

    await expect(updateTicketPushPrefs({ assignedEnabled: false })).rejects.toMatchObject({
      message: 'Network down',
    });
  });
});
