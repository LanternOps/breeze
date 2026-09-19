import { describe, expect, it, vi } from 'vitest';
import { lockActorAssurance } from './stepUpActorAssurance';
import type { AuthContext } from '../middleware/auth';

// Builds a tx whose select chain resolves to `rows` and records whether
// `.for('share')` was requested — the lock is the point of this helper.
function txResolving(rows: unknown[]) {
  const forMock = vi.fn(async () => rows);
  const limit = vi.fn(() => ({ for: forMock }));
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { tx: { select } as never, forMock };
}

const binding = { userId: 'user-1', operation: 'device_move_org' as const, authEpoch: 3, mfaEpoch: 2, sid: 'sid-1', resourceDigest: '' };
const auth = { user: { id: 'user-1' }, token: { aep: 3, mep: 2 } } as unknown as AuthContext;

describe('lockActorAssurance', () => {
  it('takes a FOR SHARE lock on the actor row', async () => {
    const { tx, forMock } = txResolving([{ status: 'active', authEpoch: 3, mfaEpoch: 2 }]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(true);
    expect(forMock).toHaveBeenCalledWith('share');
  });

  it('is false when the live epochs differ from the grant binding (factor reset after mint)', async () => {
    const { tx } = txResolving([{ status: 'active', authEpoch: 3, mfaEpoch: 3 }]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(false);
  });

  it('is false when the TOKEN epochs differ from the live row (stale session)', async () => {
    const { tx } = txResolving([{ status: 'active', authEpoch: 3, mfaEpoch: 2 }]);
    const staleAuth = { user: { id: 'user-1' }, token: { aep: 2, mep: 2 } } as unknown as AuthContext;
    expect(await lockActorAssurance(tx, staleAuth, binding)).toBe(false);
  });

  it('is false for a non-active actor', async () => {
    const { tx } = txResolving([{ status: 'disabled', authEpoch: 3, mfaEpoch: 2 }]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(false);
  });

  it('is false when the actor row is missing', async () => {
    const { tx } = txResolving([]);
    expect(await lockActorAssurance(tx, auth, binding)).toBe(false);
  });
});
