import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resetAllFactorsMock } = vi.hoisted(() => ({ resetAllFactorsMock: vi.fn() }));

vi.mock('./mfaFactorReset', () => ({ resetAllFactors: resetAllFactorsMock }));
vi.mock('../db/schema', () => ({
  users: { id: { __column: 'users.id' } },
  partnerUsers: { id: { __column: 'partner_users.id' }, userId: { __column: 'partner_users.user_id' } },
  organizationUsers: { id: { __column: 'organization_users.id' }, userId: { __column: 'organization_users.user_id' } },
}));

import { partnerUsers, organizationUsers } from '../db/schema';
import { neutralizeUserIfOrphaned } from './userNeutralization';

const USER = '11111111-1111-1111-1111-111111111111';
const INVENTORY = {
  wasEnabled: true,
  previousMethod: 'totp',
  hadTotp: true,
  hadSms: false,
  hadRecoveryCodes: true,
  hadPhone: false,
  passkeys: [],
  passkeysDeleted: 0,
};

function makeTx(links: { partner?: boolean; org?: boolean }) {
  const calls: string[] = [];
  const setValues: Array<Record<string, unknown>> = [];
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          calls.push(
            table === partnerUsers
              ? 'select-partner-link'
              : table === organizationUsers
                ? 'select-org-link'
                : 'select-other'
          );
          if (table === partnerUsers) return links.partner ? [{ id: 'p-link' }] : [];
          if (table === organizationUsers) return links.org ? [{ id: 'o-link' }] : [];
          return [];
        }),
      })),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      setValues.push(values);
      return {
        where: vi.fn(async () => {
          calls.push('update-users');
        }),
      };
    }),
  }));
  return { tx: { select, update } as any, calls, setValues, update };
}

describe('neutralizeUserIfOrphaned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAllFactorsMock.mockImplementation(async () => INVENTORY);
  });

  it('short-circuits when a partner membership remains (no update, no factor reset)', async () => {
    const { tx, update, calls } = makeTx({ partner: true });
    await expect(neutralizeUserIfOrphaned(tx, USER)).resolves.toEqual({ neutralized: false });
    expect(update).not.toHaveBeenCalled();
    expect(resetAllFactorsMock).not.toHaveBeenCalled();
    expect(calls).toEqual(['select-partner-link']);
  });

  it('short-circuits when an organization membership remains', async () => {
    const { tx, update } = makeTx({ org: true });
    await expect(neutralizeUserIfOrphaned(tx, USER)).resolves.toEqual({ neutralized: false });
    expect(update).not.toHaveBeenCalled();
    expect(resetAllFactorsMock).not.toHaveBeenCalled();
  });

  it('neutralizes an orphan (disabled, reason removed, no password) and THEN resets every factor on the same tx', async () => {
    const { tx, calls, setValues } = makeTx({});
    resetAllFactorsMock.mockImplementation(async (passedTx: unknown) => {
      expect(passedTx).toBe(tx);
      calls.push('resetAllFactors');
      return INVENTORY;
    });

    const result = await neutralizeUserIfOrphaned(tx, USER);

    expect(calls).toEqual(['select-partner-link', 'select-org-link', 'update-users', 'resetAllFactors']);
    expect(setValues[0]).toMatchObject({ status: 'disabled', disabledReason: 'removed', passwordHash: null });
    expect(setValues[0]).not.toHaveProperty('authEpoch'); // D3: epochs are the caller's
    expect(resetAllFactorsMock).toHaveBeenCalledWith(tx, USER);
    expect(result).toEqual({ neutralized: true, inventory: INVENTORY });
  });
});
