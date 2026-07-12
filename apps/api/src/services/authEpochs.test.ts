import { describe, it, expect, vi, beforeEach } from 'vitest';

// Rows returned by the ambient `db` mock's select chain — reassigned per test.
let ambientRows: Array<{ authEpoch: number; mfaEpoch: number }> = [];

vi.mock('../db', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(ambientRows),
  };
  return {
    db: { select: () => chain },
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

import { withSystemDbAccessContext } from '../db';
import { getUserEpochs } from './authEpochs';

const USER_ID = '11111111-1111-1111-1111-111111111111';

// Fake tx-style executor whose select chain resolves the given rows.
function fakeExecutor(rows: Array<{ authEpoch: number; mfaEpoch: number }>) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return { select: () => chain } as never;
}

describe('getUserEpochs', () => {
  beforeEach(() => {
    ambientRows = [];
    vi.mocked(withSystemDbAccessContext).mockClear();
  });

  it('returns the live epoch pair', async () => {
    ambientRows = [{ authEpoch: 3, mfaEpoch: 7 }];
    const result = await getUserEpochs(USER_ID);
    expect(result).toEqual({ authEpoch: 3, mfaEpoch: 7 });
  });

  it('resolves null (not undefined, no throw) when the user does not exist', async () => {
    ambientRows = [];
    const result = await getUserEpochs(USER_ID);
    expect(result).toBeNull();
    expect(result).not.toBeUndefined();
  });

  it('reads through a provided executor without opening a system context', async () => {
    // Ambient db would return a different row — proves values come from the executor.
    ambientRows = [{ authEpoch: 3, mfaEpoch: 7 }];
    const result = await getUserEpochs(USER_ID, fakeExecutor([{ authEpoch: 7, mfaEpoch: 9 }]));
    expect(result).toEqual({ authEpoch: 7, mfaEpoch: 9 });
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
