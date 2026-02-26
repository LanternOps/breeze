import { afterEach, describe, expect, it, vi } from 'vitest';
import { SentinelOneClient } from './client';

const ORIGINAL_MAX_PAGES = process.env.S1_SYNC_MAX_PAGES;

afterEach(() => {
  if (ORIGINAL_MAX_PAGES === undefined) {
    delete process.env.S1_SYNC_MAX_PAGES;
  } else {
    process.env.S1_SYNC_MAX_PAGES = ORIGINAL_MAX_PAGES;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SentinelOneClient pagination safeguards', () => {
  it('warns when the configured page limit is reached', async () => {
    process.env.S1_SYNC_MAX_PAGES = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'agent-1', computerName: 'DESKTOP-1' }],
        pagination: { nextCursor: 'cursor-2' }
      })
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token'
    });
    const rows = await client.listAgents();

    expect(rows).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Pagination limit reached'));
  });

  it('allows overriding page limit per client instance', async () => {
    process.env.S1_SYNC_MAX_PAGES = '1';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fetchMock = vi.fn()
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
    vi.stubGlobal('fetch', fetchMock as any);

    const client = new SentinelOneClient({
      managementUrl: 'https://example.sentinelone.net',
      apiToken: 'token',
      maxPages: 2
    });
    const rows = await client.listAgents();

    expect(rows).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
