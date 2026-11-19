import { describe, expect, it, vi } from 'vitest';
import { RESOLVED_TERMINAL_STATES, UNRESOLVED_TERMINAL_STATES } from '@breeze/shared';
import { findHeartbeatEpisode, writeEpisodeSnapshot, type EpisodeTx } from './episodeStore';
import type { EpisodeSnapshot } from './stateMachine';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

describe('episode snapshot secret erasure', () => {
  it.each([...RESOLVED_TERMINAL_STATES, ...UNRESOLVED_TERMINAL_STATES])('clears the secret on %s through the centralized CAS writer', async state => {
    let fields: Record<string, unknown> = {};
    const tx = { update: () => ({ set: (value: Record<string, unknown>) => { fields = value; return { where: () => ({ returning: async () => [{ id: 'episode' }] }) }; } }) } as unknown as EpisodeTx;
    const prev = { state: 'applied', generation: 1, lastJournalSeq: 1 } as EpisodeSnapshot;
    expect(await writeEpisodeSnapshot(tx, 'episode', prev, { ...prev, state, desiredState: 'released' })).toBe(true);
    expect(fields.breakGlassSecretEnc).toBe('');
  });
  it('retains the secret for an active snapshot', async () => {
    let fields: Record<string, unknown> = {};
    const tx = { update: () => ({ set: (value: Record<string, unknown>) => { fields = value; return { where: () => ({ returning: async () => [{ id: 'episode' }] }) }; } }) } as unknown as EpisodeTx;
    const next = { state: 'applied', generation: 1, lastJournalSeq: 1 } as EpisodeSnapshot;
    await writeEpisodeSnapshot(tx, 'episode', next, next);
    expect(fields).not.toHaveProperty('breakGlassSecretEnc');
  });
});

describe('episode snapshot policy columns (#10100)', () => {
  const capture = () => {
    const seen: { fields: Record<string, unknown>; updates: number } = { fields: {}, updates: 0 };
    const tx = { update: () => ({ set: (value: Record<string, unknown>) => { seen.fields = value; seen.updates++; return { where: () => ({ returning: async () => [{ id: 'episode' }] }) }; } }) } as unknown as EpisodeTx;
    return { seen, tx };
  };
  const snapshot = { state: 'verified', generation: 2, lastJournalSeq: 1 } as EpisodeSnapshot;
  it('writes the generation and the allow snapshot in one UPDATE', async () => {
    const { seen, tx } = capture();
    const allowSnapshot = [{ kind: 'host' as const, host: 'edr.example.test', proto: 'tcp' as const, ports: [443], scope: 'any' as const }];
    await writeEpisodeSnapshot(tx, 'episode', snapshot, { ...snapshot, generation: 3 }, new Date(), { allowSnapshot, allowSnapshotRevision: 'c1:new' });
    expect(seen.updates).toBe(1);
    expect(seen.fields).toMatchObject({ generation: 3, allowSnapshot, allowSnapshotRevision: 'c1:new' });
  });
  it('leaves the allow snapshot alone for every other transition', async () => {
    const { seen, tx } = capture();
    await writeEpisodeSnapshot(tx, 'episode', snapshot, snapshot);
    expect(seen.fields).not.toHaveProperty('allowSnapshot');
    expect(seen.fields).not.toHaveProperty('allowSnapshotRevision');
  });
});

describe('heartbeat episode lookup query budget', () => {
  it('uses one indexed device query combining both live episodes and unconfirmed tombstones, tombstones first', async () => {
    let predicate: SQL | undefined;
    let ordering: SQL[] = [];
    const q: any = {
      from: () => q,
      where: (value: SQL) => { predicate = value; return q; },
      orderBy: (...values: SQL[]) => { ordering = values; return q; },
      limit: vi.fn(async () => []),
    };
    const select = vi.fn(() => q);
    const deviceId = '11111111-1111-4111-8111-111111111111';
    expect(await findHeartbeatEpisode({ select } as unknown as EpisodeTx, deviceId)).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
    expect(q.limit).toHaveBeenCalledOnce();
    expect(q.limit).toHaveBeenCalledWith(1);
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(predicate!);
    expect(query.sql).toContain('"device_id" = $1');
    expect(query.params[0]).toBe(deviceId);
    expect(query.sql).toContain('"state" not in');
    expect(query.sql).toContain(' or ');
    expect(query.sql).toContain('"desired_state" =');
    expect(query.sql).toContain('"release_confirmed_at" is null');
    expect(query.params).toEqual([deviceId, 'released', 'expired', 'failed', 'uninstalled', 'released']);
    const firstOrder = dialect.sqlToQuery(ordering[0]!);
    expect(firstOrder.sql).toContain("\"desired_state\" = 'released'");
    expect(firstOrder.sql).toContain('"release_confirmed_at" IS NULL) desc');
  });
});
