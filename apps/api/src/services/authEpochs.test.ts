import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => {
  const rows = [{ authEpoch: 3, mfaEpoch: 7 }];
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    db: { select: () => chain },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { getUserEpochs } from './authEpochs';

describe('getUserEpochs', () => {
  it('returns the live epoch pair', async () => {
    const result = await getUserEpochs('11111111-1111-1111-1111-111111111111');
    expect(result).toEqual({ authEpoch: 3, mfaEpoch: 7 });
  });
});
