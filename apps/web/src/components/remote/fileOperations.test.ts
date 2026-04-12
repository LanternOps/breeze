import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UnverifiedOperationError,
  uploadFile,
  summarizeBulkResults,
  type FileOpResult,
} from './fileOperations';

const mockFetch = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

describe('UnverifiedOperationError', () => {
  it('has name "UnverifiedOperationError"', () => {
    const err = new UnverifiedOperationError('boom');
    expect(err.name).toBe('UnverifiedOperationError');
    expect(err.message).toBe('boom');
    expect(err.unverified).toBe(true);
  });

  it('is catchable via instanceof', () => {
    try {
      throw new UnverifiedOperationError('boom');
    } catch (err) {
      expect(err instanceof UnverifiedOperationError).toBe(true);
      expect(err instanceof Error).toBe(true);
    }
  });
});

describe('uploadFile', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with data on 200', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: { path: '/tmp/x', size: 42 } }),
    });

    const result = await uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' });
    expect(result).toEqual({ path: '/tmp/x', size: 42 });
  });

  it('throws UnverifiedOperationError when server returns unverified: true', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'refresh to verify', unverified: true }),
    });

    await expect(
      uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' }),
    ).rejects.toBeInstanceOf(UnverifiedOperationError);
  });

  it('throws plain Error on a non-unverified failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'permission denied' }),
    });

    await expect(
      uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('falls back to generic message when JSON parse fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => {
        throw new Error('bad json');
      },
    });

    await expect(
      uploadFile('dev-1', { path: '/tmp/x', content: 'Zm9v', encoding: 'base64' }),
    ).rejects.toThrow(/Upload failed/);
  });
});

describe('summarizeBulkResults', () => {
  const ok = (path: string): FileOpResult => ({ path, status: 'success' });
  const fail = (path: string): FileOpResult => ({ path, status: 'failure', error: 'boom' });
  const unv = (path: string): FileOpResult => ({
    path,
    status: 'failure',
    error: 'timed out',
    unverified: true,
  });

  it('returns success outcome with no summary when all items succeeded', () => {
    expect(summarizeBulkResults([ok('a'), ok('b')])).toEqual({ result: 'success' });
  });

  it('returns failure outcome when all items hard-failed', () => {
    const out = summarizeBulkResults([fail('a'), fail('b')]);
    expect(out.result).toBe('failure');
    expect(out.summary).toBe('2 failed');
  });

  it('returns unverified outcome when all failed items are unverified', () => {
    const out = summarizeBulkResults([unv('a'), unv('b')]);
    expect(out.result).toBe('unverified');
    expect(out.summary).toBe('2 unverified — refresh to verify');
  });

  it('returns failure outcome on a mix of fail + unverified, with both counts', () => {
    const out = summarizeBulkResults([fail('a'), unv('b'), unv('c')]);
    expect(out.result).toBe('failure');
    expect(out.summary).toBe('1 failed, 2 unverified — refresh to verify');
  });

  it('returns unverified outcome on success + unverified mix', () => {
    const out = summarizeBulkResults([ok('a'), unv('b')]);
    expect(out.result).toBe('unverified');
    expect(out.summary).toBe('1 unverified — refresh to verify');
  });
});
