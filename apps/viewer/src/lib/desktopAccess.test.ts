import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pollDesktopAccess } from './desktopAccess';

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(body == null ? null : JSON.stringify(body), { status }));
}

const auth = { apiUrl: 'https://api.example.com', accessToken: 'tok' };

describe('pollDesktopAccess', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns ok with mode=user_session + username when agent reports a user session', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { desktopAccess: { mode: 'user_session' }, lastUser: 'alice' }));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toEqual({ ok: true, poll: { mode: 'user_session', username: 'alice' } });
  });

  it('returns ok with mode=login_window when agent reports loginwindow', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { desktopAccess: { mode: 'login_window' }, lastUser: null }));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toEqual({ ok: true, poll: { mode: 'login_window', username: null } });
  });

  it('returns ok with mode=unavailable when agent reports unavailable', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { desktopAccess: { mode: 'unavailable' }, lastUser: null }));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toMatchObject({ ok: true, poll: { mode: 'unavailable' } });
  });

  it('returns ok with mode=null when desktopAccess is missing from the body', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { lastUser: null }));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toEqual({ ok: true, poll: { mode: null, username: null } });
  });

  it('returns ok:false reason=unauthorized on 401', async () => {
    vi.stubGlobal('fetch', mockFetch(401, { error: 'expired' }));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('returns ok:false reason=unauthorized on 403', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { error: 'forbidden' }));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toEqual({ ok: false, reason: 'unauthorized' });
  });

  it('returns ok:false reason=error on 404/500/etc non-2xx', async () => {
    vi.stubGlobal('fetch', mockFetch(500, null));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toEqual({ ok: false, reason: 'error' });
  });

  it('returns ok:false reason=network when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network gone'); }));
    const r = await pollDesktopAccess('dev-1', auth);
    expect(r).toEqual({ ok: false, reason: 'network' });
  });

  it('sends Authorization: Bearer <accessToken>', async () => {
    const fetchMock = mockFetch(200, { desktopAccess: null, lastUser: null });
    vi.stubGlobal('fetch', fetchMock);
    await pollDesktopAccess('dev-1', auth);
    const headers = fetchMock.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
  });
});
