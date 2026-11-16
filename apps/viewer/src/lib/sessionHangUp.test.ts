import { describe, expect, it, vi } from 'vitest';
import { createSessionHangUp } from './sessionHangUp';

const AUTH = {
  apiUrl: 'https://example.com',
  accessToken: 'viewer-tok',
  sessionId: '11111111-1111-4111-8111-111111111111',
};

describe('createSessionHangUp (#11931)', () => {
  it('ends the session through the viewer-token End route', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    await expect(hangUp(AUTH)).resolves.toBe('ended');
    expect(end).toHaveBeenCalledWith(AUTH.apiUrl, AUTH.accessToken, AUTH.sessionId);
  });

  it('sends End once per session: the hang-up and the window close share one request', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    const first = hangUp(AUTH);
    const second = hangUp({ ...AUTH });
    expect(second).toBe(first);
    await first;
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('ends a new session after a transport switch minted a new one', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    await hangUp(AUTH);
    await hangUp({ ...AUTH, sessionId: '22222222-2222-4222-8222-222222222222' });
    expect(end).toHaveBeenCalledTimes(2);
  });

  it('skips a connection with no desktop session (VNC tunnel, not yet authenticated)', async () => {
    const end = vi.fn(async () => 'ended' as const);
    const hangUp = createSessionHangUp(end);

    await expect(hangUp(null)).resolves.toBe('skipped');
    await expect(hangUp({ ...AUTH, sessionId: '' })).resolves.toBe('skipped');
    await expect(hangUp({ ...AUTH, accessToken: '' })).resolves.toBe('skipped');
    expect(end).not.toHaveBeenCalled();
  });

  it('never rejects, so a close handler awaiting it always lets the window close', async () => {
    const end = vi.fn(async () => { throw new Error('boom'); });
    const hangUp = createSessionHangUp(end as never);

    await expect(hangUp(AUTH)).resolves.toBe('failed');
  });
});
