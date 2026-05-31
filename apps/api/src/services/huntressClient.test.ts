import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// HuntressClient routes every outbound call through `safeFetch` (SSRF-safe:
// DNS-pinned, no redirect following, *.huntress.io re-asserted on the final
// URL). Mock the urlSafety module so the client never touches the real network
// and we can assert on what it asked safeFetch to do.
vi.mock('./urlSafety', () => ({
  safeFetch: vi.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import { HuntressClient } from './huntressClient';
import { safeFetch } from './urlSafety';

const safeFetchMock = vi.mocked(safeFetch);

// Regression coverage for the Huntress sync fixes:
//  1. HTTP Basic auth (not Bearer/X-API-Key).
//  2. Incidents come from /incident_reports (not /incidents).
//  3. Numeric ids (Huntress returns id/agent_id as numbers) survive normalization
//     instead of being dropped as "missing required fields".
//  4. SSRF: outbound calls go through safeFetch (not global fetch); a redirect
//     (3xx) from safeFetch is treated as an error and NOT followed to another host.

type Captured = { url: string; init: { method?: string; headers?: unknown; timeoutMs?: number } };

// Build a minimal Response-shaped object. The client only reads `.ok`,
// `.status`, `.statusText`, `.text()`, and `.headers.get('Retry-After')`.
function fakeResponse(status: number, body: unknown, retryAfter?: string) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `Status ${status}`,
    text: async () => text,
    headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter ?? null : null) },
  } as unknown as Response;
}

// Drive safeFetch by request pathname; default to a 200 with the given body.
function mockSafeFetch(bodyFor: (pathname: string) => unknown) {
  const calls: Captured[] = [];
  safeFetchMock.mockImplementation(async (url: string, init?: unknown) => {
    calls.push({ url, init: (init ?? {}) as Captured['init'] });
    const pathname = new URL(url).pathname;
    return fakeResponse(200, bodyFor(pathname));
  });
  return calls;
}

// A single page with no next-page markers so pagination terminates after one request.
const onePage = (key: string, rows: unknown[]) => ({
  [key]: rows,
  pagination: { current_page: 1, current_page_count: rows.length, limit: 100, total_count: rows.length, next_page: null },
});

beforeEach(() => {
  safeFetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('HuntressClient', () => {
  it('authenticates with HTTP Basic (base64 of the key:secret pair), not Bearer/X-API-Key', async () => {
    const calls = mockSafeFetch((p) => (p.endsWith('/agents') ? onePage('agents', []) : onePage('incident_reports', [])));
    const client = new HuntressClient({ apiKey: 'mykey:mysecret' });
    await client.listAgents();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('mykey:mysecret').toString('base64')}`);
    expect(headers.Authorization).not.toContain('Bearer');
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('reads incidents from /incident_reports, not /incidents', async () => {
    const calls = mockSafeFetch(() => onePage('incident_reports', []));
    const client = new HuntressClient({ apiKey: 'k:s' });
    await client.listIncidents();

    expect(calls.some((c) => new URL(c.url).pathname.endsWith('/incident_reports'))).toBe(true);
    expect(calls.some((c) => new URL(c.url).pathname.endsWith('/incidents'))).toBe(false);
  });

  it('keeps agent records whose id is a number (numeric ids are coerced, not dropped)', async () => {
    mockSafeFetch(() =>
      onePage('agents', [{ id: 12345, hostname: 'HOST-1', platform: 'windows', status: 'active' }])
    );
    const client = new HuntressClient({ apiKey: 'k:s' });
    const agents = await client.listAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0]!.huntressAgentId).toBe('12345');
    expect(agents[0]!.hostname).toBe('HOST-1');
  });

  it('keeps incident records with a numeric id and maps the real fields (subject/body/sent_at)', async () => {
    mockSafeFetch(() =>
      onePage('incident_reports', [
        { id: 678, agent_id: 99, subject: 'Suspicious login', body: 'Details here', severity: 'high', status: 'sent', sent_at: '2026-05-01T00:00:00Z' },
      ])
    );
    const client = new HuntressClient({ apiKey: 'k:s' });
    const incidents = await client.listIncidents();

    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.huntressIncidentId).toBe('678');
    expect(incidents[0]!.title).toBe('Suspicious login'); // from `subject`
    expect(incidents[0]!.description).toBe('Details here'); // from `body`
    expect(incidents[0]!.reportedAt?.toISOString()).toBe('2026-05-01T00:00:00.000Z'); // from `sent_at`
  });

  // --- SSRF regression coverage ---

  it('routes outbound calls through safeFetch with an https *.huntress.io URL (not global fetch)', async () => {
    // Swap global fetch for a spy that throws: if the client ever reaches for
    // raw fetch instead of safeFetch, the test fails loudly.
    const globalFetchSpy = vi.fn(() => {
      throw new Error('global fetch must not be used — call safeFetch');
    });
    vi.stubGlobal('fetch', globalFetchSpy);

    const calls = mockSafeFetch(() => onePage('agents', []));
    const client = new HuntressClient({ apiKey: 'k:s' });
    await client.listAgents();

    expect(safeFetchMock).toHaveBeenCalled();
    expect(globalFetchSpy).not.toHaveBeenCalled();

    const requested = new URL(calls[0]!.url);
    expect(requested.protocol).toBe('https:');
    expect(requested.hostname.endsWith('.huntress.io')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('treats a 3xx from safeFetch as an error and does NOT follow it to another host', async () => {
    // safeFetch never follows redirects: it returns the raw 3xx. The client must
    // reject it rather than chase the Location header into internal address space.
    safeFetchMock.mockResolvedValueOnce(
      fakeResponse(302, '') as Response
    );
    // If the client wrongly followed the redirect, it would call safeFetch again.
    const client = new HuntressClient({ apiKey: 'k:s' });

    await expect(client.listAgents()).rejects.toThrow(/Huntress API request failed \(302/);
    // Exactly one outbound call — the redirect was not followed.
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    // And every call that was made targeted a huntress.io host.
    for (const call of safeFetchMock.mock.calls) {
      const target = new URL(call[0] as string);
      expect(target.hostname.endsWith('.huntress.io')).toBe(true);
    }
  });

  it('does not retry a 3xx (only 429/5xx are retried)', async () => {
    safeFetchMock.mockResolvedValue(fakeResponse(301, '') as Response);
    const client = new HuntressClient({ apiKey: 'k:s' });

    await expect(client.listIncidents()).rejects.toThrow(/Huntress API request failed \(301/);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes a timeout to safeFetch so the SSRF-safe transport enforces it', async () => {
    const calls = mockSafeFetch(() => onePage('agents', []));
    const client = new HuntressClient({ apiKey: 'k:s' });
    await client.listAgents();

    expect(typeof calls[0]!.init.timeoutMs).toBe('number');
    expect(calls[0]!.init.timeoutMs!).toBeGreaterThan(0);
  });

  // The per-request host re-assertion in request() is defense-in-depth. The
  // constructor already rejects any non-HTTPS / non-*.huntress.io base URL, and
  // pathname/query joined onto a validated base cannot change the origin, so we
  // cannot reach the re-assertion via the public API — exercising the
  // constructor guard documents the boundary instead.
  it('rejects a non-huntress base URL at construction (origin can never drift off-host)', () => {
    expect(() => new HuntressClient({ apiKey: 'k:s', baseUrl: 'https://evil.example.com/v1' })).toThrow(
      /Must be HTTPS \*\.huntress\.io/
    );
    expect(() => new HuntressClient({ apiKey: 'k:s', baseUrl: 'http://api.huntress.io/v1' })).toThrow(
      /Must be HTTPS \*\.huntress\.io/
    );
  });
});
