import { describe, expect, it, vi } from 'vitest';

import { toDeviceCommandResults } from './AutomationsPage';

describe('toDeviceCommandResults (#3188)', () => {
  it('parses execute_command results from the run-detail payload', () => {
    expect(toDeviceCommandResults([
      { actionIndex: 0, status: 'succeeded', output: 'hi' },
      { actionIndex: 2, status: 'failed', output: 'x', outputTruncated: true, error: 'exit 1', message: null },
    ])).toEqual([
      {
        actionIndex: 0, status: 'succeeded', output: 'hi', outputTruncated: false,
        error: undefined, errorTruncated: false, message: undefined,
      },
      {
        actionIndex: 2, status: 'failed', output: 'x', outputTruncated: true,
        error: 'exit 1', errorTruncated: false, message: undefined,
      },
    ]);
  });

  it('returns undefined for a missing or empty list', () => {
    expect(toDeviceCommandResults(undefined)).toBeUndefined();
    expect(toDeviceCommandResults([])).toBeUndefined();
  });

  it('warns instead of silently dropping a wholly malformed list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toDeviceCommandResults([{ status: 'succeeded' }])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
