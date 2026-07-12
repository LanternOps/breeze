import { describe, it, expect, vi } from 'vitest';

const inserted: Record<string, unknown>[] = [];
vi.mock('../db', () => {
  const chain = { values: (v: Record<string, unknown>) => { inserted.push(v); return Promise.resolve(); } };
  return {
    db: { insert: () => chain },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./tokenRevocation', () => ({ rememberJtiFamily: vi.fn() }));

import { mintRefreshTokenFamily } from './refreshTokenFamily';

describe('mintRefreshTokenFamily', () => {
  it('stamps an absolute expiry ~30d out', async () => {
    await mintRefreshTokenFamily('11111111-1111-1111-1111-111111111111');
    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row.absoluteExpiresAt).toBeInstanceOf(Date);
    const ms = (row.absoluteExpiresAt as Date).getTime() - Date.now();
    expect(ms).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(ms).toBeLessThan(31 * 24 * 3600 * 1000);
  });
});
