/**
 * W16 (#6786, T7): what a four-eyes `manage_ai_agent_schedules:delete` approval
 * is bound to. A baseline delete cascades every override and cannot be undone, so
 * the pin covers the override CONTENTS, not only their ids.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db';
import { scheduleDeleteDigestMaterial } from './scheduleDeleteDigest';

const SCHEDULE = '11111111-1111-4111-8111-111111111111';
const OVERRIDE_A = '22222222-2222-4222-8222-222222222222';
const OVERRIDE_B = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const ORG = '66666666-6666-4666-8666-666666666666';
const ORG_B = '77777777-7777-4777-8777-777777777777';

const state: { rows: Record<string, unknown>[][] } = { rows: [] };
const database = {
  select: () => ({
    from: () => ({
      where: () => {
        const rows = state.rows.shift() ?? [];
        return Object.assign(Promise.resolve(rows), { limit: async () => rows });
      },
    }),
  }),
} as unknown as Database;

const baseline = (over: Record<string, unknown> = {}) => ({
  id: SCHEDULE,
  orgId: null,
  partnerId: PARTNER,
  kind: 'sweep',
  agentId: AGENT,
  cron: '0 2 * * *',
  timezone: 'UTC',
  enabled: true,
  actMode: null,
  sweepKinds: ['disk_pressure', 'stale_agents'],
  ...over,
});
const override = (over: Record<string, unknown> = {}) => ({
  id: OVERRIDE_A,
  orgId: ORG,
  enabled: true,
  sweepKinds: ['disk_pressure'],
  actMode: null,
  ...over,
});

async function pin(row: Record<string, unknown> | null, overrides: Record<string, unknown>[] = []) {
  state.rows = [row ? [row] : [], overrides];
  return scheduleDeleteDigestMaterial(SCHEDULE, database);
}

beforeEach(() => {
  state.rows = [];
});

describe('scheduleDeleteDigestMaterial', () => {
  it('pins the row and its overrides', async () => {
    await expect(pin(baseline(), [override()])).resolves.toEqual({
      v: 1,
      scheduleId: SCHEDULE,
      ownerScope: 'partner',
      ownerId: PARTNER,
      kind: 'sweep',
      agentId: AGENT,
      cron: '0 2 * * *',
      timezone: 'UTC',
      enabled: true,
      actMode: null,
      sweepKinds: ['disk_pressure', 'stale_agents'],
      overrides: [{ id: OVERRIDE_A, orgId: ORG, enabled: true, sweepKinds: ['disk_pressure'], actMode: null }],
    });
  });

  it('a missing row is null, the resolver reports TARGET_ABSENT', async () => {
    await expect(pin(null)).resolves.toBeNull();
  });

  it('names an override by its org', async () => {
    await expect(pin(baseline({ orgId: ORG, partnerId: null }))).resolves.toMatchObject({ ownerScope: 'organization', ownerId: ORG });
  });

  it('is stable across row order and kind order', async () => {
    const a = await pin(baseline(), [override(), override({ id: OVERRIDE_B, orgId: ORG_B })]);
    const b = await pin(baseline({ sweepKinds: ['stale_agents', 'disk_pressure'] }), [override({ id: OVERRIDE_B, orgId: ORG_B }), override()]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it.each([
    ['an override was added', baseline(), [override(), override({ id: OVERRIDE_B, orgId: ORG_B })]],
    ["an override's enabled changed", baseline(), [override({ enabled: false })]],
    ["an override's kinds changed", baseline(), [override({ sweepKinds: [] })]],
    ["an override's act mode changed", baseline(), [override({ actMode: false })]],
    ['the row was armed', baseline({ actMode: true }), [override()]],
    ['the cadence changed', baseline({ cron: '0 3 * * *' }), [override()]],
  ])('changes when %s', async (_label, row, overrides) => {
    const before = await pin(baseline(), [override()]);
    const after = await pin(row, overrides);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });
});
