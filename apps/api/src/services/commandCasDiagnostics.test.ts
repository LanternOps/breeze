import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
}));

vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'device_commands.id',
    status: 'device_commands.status',
    result: 'device_commands.result',
  },
}));

import {
  commandCasPriorStatusTags,
  priorStatusTagValue,
  PRIOR_STATUS_LOOKUP_FAILED,
  PRIOR_STATUS_MISSING,
  PRIOR_STATUS_UNKNOWN,
} from './commandCasDiagnostics';

function selectChain(rows: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

describe('priorStatusTagValue', () => {
  it('folds the stale-command reaper marker into the status value', () => {
    expect(
      priorStatusTagValue({
        status: 'failed',
        result: { status: 'timeout', error: 'no response', timedOutBy: 'server' },
      }),
    ).toBe('failed:server-timeout');
  });

  it('reports a plain terminal status for the REST/WS duplicate-result race', () => {
    expect(priorStatusTagValue({ status: 'completed', result: { exitCode: 0 } })).toBe(
      'completed',
    );
    expect(priorStatusTagValue({ status: 'failed', result: { exitCode: 1 } })).toBe('failed');
  });

  it('reports cancelled for the cancellation paths', () => {
    expect(priorStatusTagValue({ status: 'cancelled', result: null })).toBe('cancelled');
  });

  it('maps a status outside the known set to a bounded sentinel (no passthrough)', () => {
    expect(priorStatusTagValue({ status: 'weird-new-state', result: null })).toBe(
      PRIOR_STATUS_UNKNOWN,
    );
    expect(priorStatusTagValue({ status: 42, result: null })).toBe(PRIOR_STATUS_UNKNOWN);
  });

  it('maps an absent row to a bounded sentinel', () => {
    expect(priorStatusTagValue(undefined)).toBe(PRIOR_STATUS_MISSING);
  });

  it('tolerates a non-object result without leaking its contents', () => {
    expect(priorStatusTagValue({ status: 'failed', result: 'raw string' })).toBe('failed');
    expect(priorStatusTagValue({ status: 'failed', result: ['a'] })).toBe('failed');
  });
});

describe('commandCasPriorStatusTags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('re-reads the command by primary key and tags the prior status', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([{ status: 'failed', result: { timedOutBy: 'server' } }]),
    );

    await expect(commandCasPriorStatusTags('cmd-1')).resolves.toEqual({
      prior_status: 'failed:server-timeout',
    });
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when the diagnostic read fails — the CAS outcome must not change', async () => {
    selectMock.mockImplementationOnce(() => {
      throw new Error('pool exhausted');
    });

    await expect(commandCasPriorStatusTags('cmd-1')).resolves.toEqual({
      prior_status: PRIOR_STATUS_LOOKUP_FAILED,
    });
  });

  it('reports missing when the row is gone', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));

    await expect(commandCasPriorStatusTags('cmd-1')).resolves.toEqual({
      prior_status: PRIOR_STATUS_MISSING,
    });
  });
});
