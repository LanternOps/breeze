import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { users } from './users';
import { refreshTokenFamilies } from './refreshTokenFamilies';

describe('authentication security schema', () => {
  it('maps durable user epochs and an absolute refresh-family expiry', () => {
    const userColumns = getTableColumns(users);
    expect(userColumns.authEpoch.notNull).toBe(true);
    expect(userColumns.mfaEpoch.notNull).toBe(true);
    expect(userColumns.emailEpoch.notNull).toBe(true);
    expect(userColumns.passwordResetEpoch.notNull).toBe(true);
    expect(getTableColumns(refreshTokenFamilies).absoluteExpiresAt.notNull).toBe(true);
  });
});
