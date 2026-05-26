import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestVersion, _resetLatestVersionCache } from './latestVersion';

describe('latestVersion', () => {
  beforeEach(() => {
    _resetLatestVersionCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed tag from GitHub on first call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v0.65.10' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('0.65.10');
    expect(r.source).toBe('github');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('api.github.com/repos/breeze-mm/breeze/releases/latest');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('breeze-rmm-api');
  });

  it('returns cached value on second call within TTL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v0.65.10' }), { status: 200 }),
    );
    await getLatestVersion();
    const r2 = await getLatestVersion();
    expect(r2.latest).toBe('0.65.10');
    expect(r2.source).toBe('cache');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('returns null and source=error on HTTP 5xx', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null and source=error on HTTP 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null on network failure', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ENOTFOUND'));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null on malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('rejects prerelease tags', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v0.65.10-rc1' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('rejects malformed tag', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'release-2026-01-01' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
  });

  it('caches error result for the full TTL (no retry storm)', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    await getLatestVersion();
    await getLatestVersion();
    await getLatestVersion();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('strips leading v from tag', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('1.2.3');
  });

  it('accepts tag without leading v', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: '1.2.3' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('1.2.3');
  });
});
