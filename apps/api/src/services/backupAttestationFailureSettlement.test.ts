import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * When a snapshot fails its integrity check, verifications of it that are
 * still waiting are settled right away with the integrity reason, and their
 * queued commands are withdrawn — instead of sitting pending until the
 * verification timeout and then reporting "timed out".
 */

const state = vi.hoisted(() => ({
  settledRows: [] as Array<{ id: string; commandId: string | null }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown>; where: unknown }>,
}));

vi.mock('../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: {
      update: (table: Parameters<typeof getTableName>[0]) => ({
        set: (payload: Record<string, unknown>) => ({
          where: (where: unknown) => {
            const name = getTableName(table);
            state.updates.push({ table: name, payload, where });
            const result = Promise.resolve(undefined) as Promise<undefined> & {
              returning: () => Promise<unknown[]>;
            };
            result.returning = async () => (name === 'backup_verifications' ? state.settledRows : []);
            return result;
          },
        }),
      }),
    },
  };
});

const {
  ATTESTATION_FAILED_VERIFICATION_REASON,
  settleVerificationsForFailedAttestation,
} = await import('./backupAttestationFailureSettlement');

const dialect = new PgDialect();
function sqlOf(where: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(where as SQL);
}

describe('settleVerificationsForFailedAttestation', () => {
  beforeEach(() => {
    state.settledRows = [];
    state.updates.length = 0;
  });

  it('fails the waiting verifications of that snapshot with the integrity reason', async () => {
    state.settledRows = [{ id: 'ver-1', commandId: null }];
    const count = await settleVerificationsForFailedAttestation('snap-row-1');
    expect(count).toBe(1);

    const verificationUpdate = state.updates.find((u) => u.table === 'backup_verifications');
    expect(verificationUpdate?.payload.status).toBe('failed');
    expect(verificationUpdate?.payload.completedAt).toBeInstanceOf(Date);
    const where = sqlOf(verificationUpdate!.where);
    expect(where.params).toContain('snap-row-1');
    expect(where.params).toEqual(expect.arrayContaining(['pending', 'running']));
    const details = sqlOf(verificationUpdate!.payload.details);
    expect(JSON.stringify(details.params)).toContain(ATTESTATION_FAILED_VERIFICATION_REASON);
  });

  it('withdraws the queued commands of the settled verifications', async () => {
    state.settledRows = [
      { id: 'ver-1', commandId: '11111111-1111-4111-8111-111111111111' },
      { id: 'ver-2', commandId: 'not-a-uuid' },
    ];
    await settleVerificationsForFailedAttestation('snap-row-1');

    const commandUpdate = state.updates.find((u) => u.table === 'device_commands');
    expect(commandUpdate?.payload.status).toBe('cancelled');
    const where = sqlOf(commandUpdate!.where);
    expect(where.params).toContain('11111111-1111-4111-8111-111111111111');
    expect(where.params).not.toContain('not-a-uuid');
    // Only a command no helper has claimed yet is withdrawn.
    expect(where.params).toContain('pending');
    expect(where.params).not.toContain('sent');
  });

  it('touches no commands when nothing was waiting', async () => {
    expect(await settleVerificationsForFailedAttestation('snap-row-1')).toBe(0);
    expect(state.updates.some((u) => u.table === 'device_commands')).toBe(false);
  });
});
