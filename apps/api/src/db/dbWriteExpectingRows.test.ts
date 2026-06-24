import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/sentry', () => ({
  captureMessage: vi.fn(),
}));

import { captureMessage } from '../services/sentry';
import { dbWriteExpectingRows } from './dbWriteExpectingRows';

describe('dbWriteExpectingRows', () => {
  beforeEach(() => {
    vi.mocked(captureMessage).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns rows untouched and does NOT warn when ≥1 row moved', async () => {
    const out = await dbWriteExpectingRows('users.last_login_at', async () => [{ id: 'u-1' }]);
    expect(out).toEqual([{ id: 'u-1' }]);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns via captureMessage when 0 rows moved', async () => {
    const out = await dbWriteExpectingRows('users.last_login_at', async () => []);
    expect(out).toEqual([]);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('users.last_login_at'),
      'warning',
      expect.any(Object)
    );
  });

  it('returns empty array and calls console.warn when 0 rows affected', async () => {
    const result = await dbWriteExpectingRows('test.label', () => Promise.resolve([]));
    expect(result).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('test.label'),
    );
  });

  it('does not throw when 0 rows are returned', async () => {
    await expect(
      dbWriteExpectingRows('test.label', () => Promise.resolve([]))
    ).resolves.toEqual([]);
  });
});
