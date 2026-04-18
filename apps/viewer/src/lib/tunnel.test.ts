import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVncTunnel, closeTunnel } from './tunnel';

type FetchResponse = { status: number; body: unknown };

function makeFetch(responses: FetchResponse[]) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++];
    return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status });
  });
}

describe('createVncTunnel', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('POSTs /tunnels then /tunnels/:id/ws-ticket and returns a wss:// url for https apiUrl', async () => {
    const fetchMock = makeFetch([
      { status: 201, body: { id: 'tun-123' } },
      { status: 200, body: { ticket: 'tkt-abc' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const res = await createVncTunnel('dev-1', {
      apiUrl: 'https://api.example.com',
      accessToken: 'token-xyz',
    });

    expect(res).toEqual({
      tunnelId: 'tun-123',
      wsUrl: 'wss://api.example.com/api/v1/tunnel-ws/tun-123/ws?ticket=tkt-abc',
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('https://api.example.com/api/v1/tunnels');
    expect(calls[0][1].method).toBe('POST');
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({ deviceId: 'dev-1', type: 'vnc' });
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer token-xyz');
    expect((calls[0][1].headers as Record<string, string>)['Content-Type']).toBe('application/json');

    expect(calls[1][0]).toBe('https://api.example.com/api/v1/tunnels/tun-123/ws-ticket');
    expect(calls[1][1].method).toBe('POST');
    expect((calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer token-xyz');
  });

  it('uses ws:// when apiUrl is http://', async () => {
    vi.stubGlobal('fetch', makeFetch([
      { status: 201, body: { id: 'tun-9' } },
      { status: 200, body: { ticket: 'tkt-9' } },
    ]));
    const res = await createVncTunnel('dev-x', { apiUrl: 'http://localhost:3000', accessToken: 'tok' });
    expect(res.wsUrl).toBe('ws://localhost:3000/api/v1/tunnel-ws/tun-9/ws?ticket=tkt-9');
  });

  it('throws when POST /tunnels returns non-ok with an error message from the body', async () => {
    vi.stubGlobal('fetch', makeFetch([{ status: 403, body: { error: 'policy denied' } }]));
    await expect(createVncTunnel('dev-1', { apiUrl: 'https://x', accessToken: 't' }))
      .rejects.toThrow(/policy denied/);
  });

  it('throws a generic error when POST /tunnels returns non-ok with no parseable body', async () => {
    vi.stubGlobal('fetch', makeFetch([{ status: 500, body: null }]));
    await expect(createVncTunnel('dev-1', { apiUrl: 'https://x', accessToken: 't' }))
      .rejects.toThrow(/500/);
  });

  it('closes the tunnel (best effort) when the ws-ticket call fails', async () => {
    const fetchMock = makeFetch([
      { status: 201, body: { id: 'tun-zz' } },
      { status: 500, body: null },
      { status: 204, body: null }, // DELETE cleanup
    ]);
    vi.stubGlobal('fetch', fetchMock);

    await expect(createVncTunnel('dev-1', { apiUrl: 'https://api.example.com', accessToken: 'tok' }))
      .rejects.toThrow(/ticket/);

    // Third call should be DELETE to clean up the dangling tunnel
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[2][0]).toBe('https://api.example.com/api/v1/tunnels/tun-zz');
    expect(calls[2][1].method).toBe('DELETE');
  });
});

describe('closeTunnel', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('DELETEs /tunnels/:id with Bearer auth', async () => {
    const fetchMock = makeFetch([{ status: 204, body: null }]);
    vi.stubGlobal('fetch', fetchMock);
    await closeTunnel('tun-1', { apiUrl: 'https://api.example.com', accessToken: 'tok' });
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][0]).toBe('https://api.example.com/api/v1/tunnels/tun-1');
    expect(calls[0][1].method).toBe('DELETE');
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('swallows errors so callers can safely call it on cleanup paths', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network gone'); }));
    await expect(closeTunnel('tun-2', { apiUrl: 'https://x', accessToken: 't' })).resolves.toBeUndefined();
  });
});
