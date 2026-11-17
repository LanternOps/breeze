import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { users } from '../db/schema';
import { cancelPendingEmailChange } from './pendingEmailCancellation';

function fakeTx() {
  const writes: Array<{ table: unknown; values: Record<string, unknown>; where: SQL | undefined }> = [];
  const update = vi.fn((table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: async (where: SQL | undefined) => {
        writes.push({ table, values, where });
      },
    }),
  }));
  return { tx: { update } as any, writes };
}

describe('cancelPendingEmailChange', () => {
  it('clears the requested address and its timestamp on that user only', async () => {
    const { tx, writes } = fakeTx();

    await cancelPendingEmailChange(tx, 'user-1');

    expect(writes).toHaveLength(1);
    expect(writes[0]!.table).toBe(users);
    expect(writes[0]!.values).toMatchObject({ pendingEmail: null, pendingEmailRequestedAt: null });
    // The confirmation link checks only the pending address and email_epoch;
    // the epoch is left alone so an unfinished signup link keeps working.
    expect(writes[0]!.values).not.toHaveProperty('emailEpoch');
    const where = new PgDialect().sqlToQuery(writes[0]!.where!);
    expect(where.sql).toContain('"users"."id" = $1');
    expect(where.sql).toContain('"users"."pending_email" is not null');
    expect(where.params).toEqual(['user-1']);
  });
});
