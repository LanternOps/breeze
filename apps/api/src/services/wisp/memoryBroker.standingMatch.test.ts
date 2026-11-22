/**
 * #10428 W06 Task 2: the standing-instruction matcher's in-code half — content
 * parsing, verb and expiry filtering, strength, and the refuse/warn decision.
 * The SQL owner filters are pinned against real Postgres in
 * __tests__/integration/memoryBroker.standingMatch.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rowsQueue, captureException } = vi.hoisted(() => ({
  rowsQueue: [] as unknown[][],
  captureException: vi.fn(),
}));

vi.mock('../../db', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => rowsQueue.shift() ?? [],
  };
  return {
    db: { select: () => chain },
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  };
});
vi.mock('../sentry', () => ({ captureException }));

import type { GrantCeiling } from './grantAuthority';
import {
  findStandingInstructionMatches,
  standingInstructionDecision,
  standingInstructionRefusalMessage,
  STANDING_MATCH_MAX_ROWS,
  type StandingInstructionMatch,
} from './memoryBroker';

const PARTNER = '00000000-0000-4000-8000-0000000000aa';
const GRANTOR = '00000000-0000-4000-8000-0000000000bb';
const ORG = '00000000-0000-4000-8000-0000000000cc';
const PC01 = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-09T12:00:00Z');

const ceiling: GrantCeiling = {
  grantId: '00000000-0000-4000-8000-0000000000dd',
  revisionId: '00000000-0000-4000-8000-0000000000ee',
  partnerId: PARTNER,
  grantorUserId: GRANTOR,
  scopeOrgId: null,
  partnerWide: false,
  orgIds: new Set([ORG]),
  siteIds: null,
  permissionKeys: new Set(),
  toolAllowlist: null,
  deniedTools: new Set(),
  orgTerms: new Map(),
  status: 'active',
} as GrantCeiling;

let seq = 0;
function row(content: Record<string, unknown>, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    status: 'confirmed',
    content: {
      instructionId: '20000000-0000-4000-8000-000000000001',
      effect: 'deny',
      verb: 'reboot',
      deviceId: PC01,
      condition: null,
      until: null,
      text: "don't reboot PC-01",
      targetLabels: ['PC-01'],
      sourceMessageId: null,
      captureId: null,
      ...content,
    },
    ...over,
  };
}

const find = (exact: string[], possible: string[] = []) => findStandingInstructionMatches({
  ceiling,
  deviceIds: [PC01],
  exact: exact as never,
  possible: possible as never,
  now: NOW,
});

beforeEach(() => {
  rowsQueue.length = 0;
  captureException.mockReset();
});

describe('findStandingInstructionMatches (in-code filters)', () => {
  it('a confirmed unconditional deny on an exact verb is an enforceable exact match', async () => {
    rowsQueue.push([row({})]);
    const matches = await find(['reboot', 'any_change']);
    expect(matches).toEqual([expect.objectContaining({
      status: 'confirmed', verb: 'reboot', deviceId: PC01, enforceable: true, strength: 'exact', text: "don't reboot PC-01",
    })]);
    expect(standingInstructionDecision(matches)).toEqual({ action: 'refuse', match: matches[0] });
  });

  it('a verb the call cannot break does not match', async () => {
    rowsQueue.push([row({ verb: 'shutdown' })]);
    expect(await find(['patch_install', 'any_change'])).toEqual([]);
  });

  it('a possible verb matches with strength possible', async () => {
    rowsQueue.push([row({})]);
    const matches = await find(['run_script', 'any_change'], ['reboot']);
    expect(matches[0]).toMatchObject({ strength: 'possible', enforceable: true });
  });

  it('an expired until never matches; a future until does', async () => {
    rowsQueue.push([row({ until: '2026-11-08T00:00:00Z' }), row({ until: '2026-11-10T00:00:00+00:00' })]);
    const matches = await find(['reboot']);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.enforceable).toBe(true);
  });

  it('content that fails its schema on a matched device warns (fails toward a human), and is reported', async () => {
    rowsQueue.push([row({ effect: 'obliterate' }), row({ verb: 'teleport', text: 42 })]);
    const matches = await find(['patch_install', 'any_change']);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ strength: 'possible', enforceable: false, text: "don't reboot PC-01", deviceId: PC01 });
    expect(matches[1]).toMatchObject({ strength: 'possible', enforceable: false, text: 'a remembered instruction for this device' });
    expect(standingInstructionDecision(matches).action).toBe('warn');
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('a block for another device than the ones asked for is ignored (belt over the SQL filter)', async () => {
    rowsQueue.push([row({ deviceId: '00000000-0000-4000-8000-000000000002' })]);
    expect(await find(['reboot'])).toEqual([]);
  });

  it('no devices or no verbs runs no query', async () => {
    expect(await findStandingInstructionMatches({ ceiling, deviceIds: [], exact: ['reboot'], possible: [] })).toEqual([]);
    expect(await findStandingInstructionMatches({ ceiling, deviceIds: [PC01], exact: [], possible: [] })).toEqual([]);
    expect(rowsQueue).toHaveLength(0);
  });

  it('a lookup that hits its row cap fails closed (throws) rather than deciding on a partial set', async () => {
    rowsQueue.push(Array.from({ length: STANDING_MATCH_MAX_ROWS + 1 }, () => row({})));
    await expect(find(['reboot'])).rejects.toThrow(/standing-instruction lookup/);
  });
});

describe('standingInstructionDecision', () => {
  const m = (over: Partial<StandingInstructionMatch>): StandingInstructionMatch => ({
    blockId: 'b', instructionId: 'i', status: 'confirmed', text: 't', deviceId: PC01, verb: 'reboot',
    enforceable: true, strength: 'exact', ...over,
  });

  it('refuses only on confirmed + enforceable + exact', () => {
    expect(standingInstructionDecision([m({})]).action).toBe('refuse');
  });

  it('an unconfirmed match warns', () => {
    expect(standingInstructionDecision([m({ status: 'unconfirmed' })])).toEqual({ action: 'warn', matches: [m({ status: 'unconfirmed' })] });
  });

  it('a confirmed possible match warns', () => {
    expect(standingInstructionDecision([m({ strength: 'possible' })]).action).toBe('warn');
  });

  it('a confirmed conditional (not enforceable) match warns', () => {
    expect(standingInstructionDecision([m({ enforceable: false })]).action).toBe('warn');
  });

  it('a refusal wins over warnings in the same set', () => {
    const refuse = m({ blockId: 'r' });
    expect(standingInstructionDecision([m({ status: 'unconfirmed' }), refuse])).toEqual({ action: 'refuse', match: refuse });
  });

  it('no match is none', () => {
    expect(standingInstructionDecision([])).toEqual({ action: 'none' });
  });

  it('the refusal message quotes the instruction', () => {
    expect(standingInstructionRefusalMessage(m({ text: "don't reboot PC-01" })))
      .toBe("Refused: matches a standing instruction ('don't reboot PC-01'). Ask the user to lift it.");
  });
});
