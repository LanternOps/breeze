import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentinelOneClient } from './client';

const ORIGINAL_MAX_PAGES = process.env.S1_SYNC_MAX_PAGES;
const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
}));

vi.mock('../urlSafety', () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...(args as [])),
}));

afterEach(() => {
  if (ORIGINAL_MAX_PAGES === undefined) {
    delete process.env.S1_SYNC_MAX_PAGES;
  } else {
    process.env.S1_SYNC_MAX_PAGES = ORIGINAL_MAX_PAGES;
  }
  vi.restoreAllMocks();
  safeFetchMock.mockReset();
});

describe('SentinelOneClient pagination safeguards', () => {
  it('warns when the configured page limit is reached', async () => {
    process.env.S1_SYNC_MAX_PAGES = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    safeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'agent-1', computerName: 'DESKTOP-1' }],
        pagination: { nextCursor: 'cursor-2' }
      })
    });

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token'
    });
    const { results, truncated } = await client.listAgents();

    expect(results).toHaveLength(1);
    expect(truncated).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Pagination limit reached'));
  });

  it('allows overriding page limit per client instance', async () => {
    process.env.S1_SYNC_MAX_PAGES = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    safeFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'agent-1', computerName: 'DESKTOP-1' }],
          pagination: { nextCursor: 'cursor-2' }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'agent-2', computerName: 'DESKTOP-2' }],
          pagination: {}
        })
      });

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
      maxPages: 2
    });
    const { results, truncated } = await client.listAgents();

    expect(results).toHaveLength(2);
    expect(truncated).toBe(false);
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('SentinelOneClient error handling', () => {
  it('rejects non-HTTPS management URLs before sending tokens', () => {
    expect(() => new SentinelOneClient({
      managementUrl: 'http://attacker.example.test',
      apiToken: 'token',
    })).toThrow('managementUrl must use HTTPS');
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('throws on non-OK HTTP response with status and body', async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized: Invalid API token',
    });

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'bad-token',
    });

    await expect(client.listAgents()).rejects.toThrow('failed (401)');
    await expect(client.listAgents()).rejects.toThrow('Unauthorized');
  });

  it('throws on non-object JSON response', async () => {
    safeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => 'not-an-object',
    });

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
    });

    await expect(client.listAgents()).rejects.toThrow('non-object');
  });

  it('returns empty activityId when isolating with no agent IDs', async () => {
    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
    });

    const result = await client.isolateAgents([]);
    expect(result.activityId).toBeNull();
  });

  it('returns empty activityId when running threat action with no threat IDs', async () => {
    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
    });

    const result = await client.runThreatAction('kill', []);
    expect(result.activityId).toBeNull();
  });

  it('drops agent records with no recognizable ID and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'agent-1', computerName: 'DESKTOP-1' },
          { computerName: 'NO-ID-AGENT' }, // no id, agentId, or uuid
        ],
        pagination: {}
      }),
    });

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
    });
    const { results } = await client.listAgents();

    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('agent-1');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Dropping agent record'));
  });

  it('warns when payload.data is not an array', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    safeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { agents: [{ id: 'agent-1' }] }, // object instead of array
        pagination: {}
      }),
    });

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
    });
    const { results } = await client.listAgents();

    expect(results).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Expected array at payload.data'));
  });
});

describe('SentinelOneClient activity status mapping', () => {
  it('maps SentinelOne activity status to internal statuses', async () => {
    const makeClient = () => new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
    });

    const cases = [
      ['failed', 'failed'],
      ['error_occurred', 'failed'],
      ['done', 'completed'],
      ['success', 'completed'],
      ['completed', 'completed'],
      ['in_progress', 'in_progress'],
      ['running', 'in_progress'],
      ['active', 'in_progress'],
      ['unknown_status', 'queued'],
    ] as const;

    for (const [input, expected] of cases) {
      safeFetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { status: input } }),
      });

      const client = makeClient();
      const result = await client.getActivityStatus('activity-1');
      expect(result.status).toBe(expected);
      safeFetchMock.mockReset();
    }
  });

  it('uses safeFetch so SentinelOne tokens are not sent to blocked internal hosts', async () => {
    safeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
    });
    await client.listAgents();

    expect(safeFetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/example\.sentinelone\.net\/web\/api\/v2\.1\/agents/),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'ApiToken token' }),
        timeoutMs: expect.any(Number),
      })
    );
  });
});
