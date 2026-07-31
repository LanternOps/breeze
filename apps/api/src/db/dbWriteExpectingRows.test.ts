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
      expect.any(Object),
      expect.any(Object),
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

  // BREEZE-X: scrubEvent deletes message/logentry/extra before the event
  // leaves the process, so the label only survives as a TAG. Without it every
  // call site collapses into one unfilterable Sentry bucket.
  it('emits the label as the cas_label tag, not only inside the message', async () => {
    await dbWriteExpectingRows('users.last_login_at', async () => []);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      'warning',
      expect.any(Object),
      expect.objectContaining({ cas_label: 'users.last_login_at' }),
    );
  });

  it('merges resolved diagnostic tags alongside cas_label on the 0-row branch', async () => {
    await dbWriteExpectingRows(
      'device_commands.ws_result_terminal_cas',
      async () => [],
      async () => ({ prior_status: 'failed:server-timeout' }),
    );
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      'warning',
      expect.any(Object),
      {
        cas_label: 'device_commands.ws_result_terminal_cas',
        prior_status: 'failed:server-timeout',
      },
    );
  });

  // The two call sites are hot agent paths under connection-pool pressure
  // (#1105). The evidence read must be paid for ONLY when the CAS misses.
  it('never invokes the diagnostic resolver when the write moved rows', async () => {
    const resolver = vi.fn(async () => ({ prior_status: 'completed' }));
    await dbWriteExpectingRows(
      'device_commands.ws_result_terminal_cas',
      async () => [{ id: 'cmd-1' }],
      resolver,
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('still captures with cas_label when the diagnostic resolver throws', async () => {
    const out = await dbWriteExpectingRows(
      'device_commands.ws_result_terminal_cas',
      async () => [],
      async () => {
        throw new Error('pool exhausted');
      },
    );
    expect(out).toEqual([]);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      'warning',
      expect.any(Object),
      { cas_label: 'device_commands.ws_result_terminal_cas' },
    );
  });

  // routes/auth/login.ts passes no resolver — its behaviour must not change.
  it('leaves the two-argument call shape working (routes/auth/login.ts)', async () => {
    await expect(
      dbWriteExpectingRows('users.last_login_at', async () => [{ id: 'u-1' }]),
    ).resolves.toEqual([{ id: 'u-1' }]);
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
