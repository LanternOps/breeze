import { afterEach, describe, expect, it, vi } from 'vitest';
import { HuntressClient } from './huntressClient';

// Regression coverage for the Huntress sync fixes:
//  1. HTTP Basic auth (not Bearer/X-API-Key).
//  2. Incidents come from /incident_reports (not /incidents).
//  3. Numeric ids (Huntress returns id/agent_id as numbers) survive normalization
//     instead of being dropped as "missing required fields".

type Captured = { url: URL; init: RequestInit };

function mockFetch(bodyFor: (pathname: string) => unknown) {
  const calls: Captured[] = [];
  const fn = vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    const body = bodyFor(url.pathname);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

// A single page with no next-page markers so pagination terminates after one request.
const onePage = (key: string, rows: unknown[]) => ({
  [key]: rows,
  pagination: { current_page: 1, current_page_count: rows.length, limit: 100, total_count: rows.length, next_page: null },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('HuntressClient', () => {
  it('authenticates with HTTP Basic (base64 of the key:secret pair), not Bearer/X-API-Key', async () => {
    const calls = mockFetch((p) => (p.endsWith('/agents') ? onePage('agents', []) : onePage('incident_reports', [])));
    const client = new HuntressClient({ apiKey: 'mykey:mysecret' });
    await client.listAgents();

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from('mykey:mysecret').toString('base64')}`);
    expect(headers.Authorization).not.toContain('Bearer');
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('reads incidents from /incident_reports, not /incidents', async () => {
    const calls = mockFetch(() => onePage('incident_reports', []));
    const client = new HuntressClient({ apiKey: 'k:s' });
    await client.listIncidents();

    expect(calls.some((c) => c.url.pathname.endsWith('/incident_reports'))).toBe(true);
    expect(calls.some((c) => c.url.pathname.endsWith('/incidents'))).toBe(false);
  });

  it('keeps agent records whose id is a number (numeric ids are coerced, not dropped)', async () => {
    mockFetch(() =>
      onePage('agents', [{ id: 12345, hostname: 'HOST-1', platform: 'windows', status: 'active' }])
    );
    const client = new HuntressClient({ apiKey: 'k:s' });
    const agents = await client.listAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0]!.huntressAgentId).toBe('12345');
    expect(agents[0]!.hostname).toBe('HOST-1');
  });

  it('keeps incident records with a numeric id and maps the real fields (subject/body/sent_at)', async () => {
    mockFetch(() =>
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
});
