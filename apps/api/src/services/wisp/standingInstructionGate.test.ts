/**
 * #10428 W06: the standing-instruction gate shared by the chat pre-tool, the
 * worker proposal sites and release. The matcher's own filters are pinned in
 * memoryBroker.standingMatch(.integration).test.ts; here it is a collaborator.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findMatches, captureException, normalizeGroup } = vi.hoisted(() => ({
  findMatches: vi.fn(),
  captureException: vi.fn(),
  normalizeGroup: vi.fn(),
}));
vi.mock('../actionIntents/runScriptGroupTarget', () => {
  class RunScriptGroupTargetError extends Error {
    constructor(message: string, readonly code: string) { super(message); }
  }
  return { normalizeRunScriptGroupTarget: (...args: unknown[]) => normalizeGroup(...args), RunScriptGroupTargetError };
});

vi.mock('./memoryBroker', async (importOriginal) => ({
  ...await importOriginal<typeof import('./memoryBroker')>(),
  findStandingInstructionMatches: (...args: unknown[]) => findMatches(...args),
}));
vi.mock('../sentry', () => ({ captureException }));
vi.mock('../aiTools', () => ({
  aiTools: new Map<string, { deviceArgs?: readonly string[] }>([
    ['run_script', { deviceArgs: ['deviceIds'] }],
    ['manage_patches', { deviceArgs: ['deviceIds', 'deviceId'] }],
    ['manage_services', { deviceArgs: ['deviceId'] }],
    ['take_screenshot', { deviceArgs: ['deviceId'] }],
  ]),
}));

import type { GrantCeiling } from './grantAuthority';
import type { StandingInstructionMatch } from './memoryBroker';
import {
  STANDING_CHECK_UNAVAILABLE_MESSAGE,
  checkStandingInstructionsForCall,
  evaluateStandingInstructions,
  standingConflictDescription,
  suppliedStandingDeviceIds,
} from './standingInstructionGate';

const PC01 = '00000000-0000-4000-8000-000000000001';
const PC02 = '00000000-0000-4000-8000-000000000002';
const ceiling = { grantId: 'g', partnerId: 'p', grantorUserId: 'u', orgIds: new Set(['o']) } as unknown as GrantCeiling;

const match = (over: Partial<StandingInstructionMatch> = {}): StandingInstructionMatch => ({
  blockId: 'b1', instructionId: 'i1', status: 'confirmed', text: "don't reboot PC-01", deviceId: PC01,
  verb: 'reboot', enforceable: true, strength: 'exact', ...over,
});

beforeEach(() => {
  findMatches.mockReset();
  captureException.mockReset();
  normalizeGroup.mockReset();
});

describe('suppliedStandingDeviceIds', () => {
  it('collects string and array device args, uuid-shaped only, deduplicated', () => {
    expect(suppliedStandingDeviceIds(['deviceIds', 'deviceId'], { deviceIds: [PC01, PC02, 'nope'], deviceId: PC01 }))
      .toEqual([PC01, PC02]);
    expect(suppliedStandingDeviceIds([], { deviceId: PC01 })).toEqual([]);
  });
});

describe('evaluateStandingInstructions', () => {
  it('a confirmed exact deny refuses with the instruction text', async () => {
    findMatches.mockResolvedValue([match()]);
    const out = await evaluateStandingInstructions({ ceiling, toolName: 'manage_patches', input: { action: 'install', deviceIds: [PC01] } });
    expect(out).toMatchObject({ action: 'refuse', error: "Refused: matches a standing instruction ('don't reboot PC-01'). Ask the user to lift it." });
    expect(findMatches).toHaveBeenCalledWith(expect.objectContaining({
      ceiling, deviceIds: [PC01], exact: ['patch_install', 'reboot', 'any_change'], possible: [],
    }));
  });

  it('an unconfirmed match warns with its text', async () => {
    findMatches.mockResolvedValue([match({ status: 'unconfirmed' })]);
    const out = await evaluateStandingInstructions({ ceiling, toolName: 'run_script', input: { deviceIds: [PC01] } });
    expect(out).toMatchObject({ action: 'warn', text: "don't reboot PC-01" });
  });

  it('several warnings join their distinct texts', async () => {
    findMatches.mockResolvedValue([
      match({ status: 'unconfirmed' }),
      match({ status: 'unconfirmed', blockId: 'b2' }),
      match({ status: 'unconfirmed', blockId: 'b3', text: 'never touch PC-02' }),
    ]);
    const out = await evaluateStandingInstructions({ ceiling, toolName: 'run_script', input: { deviceIds: [PC01, PC02] } });
    expect(out).toMatchObject({ action: 'warn', text: "don't reboot PC-01; never touch PC-02" });
  });

  it('a tool that changes nothing, a read action, or a call with no device runs no lookup', async () => {
    expect(await evaluateStandingInstructions({ ceiling, toolName: 'take_screenshot', input: { deviceId: PC01 } })).toEqual({ action: 'none' });
    expect(await evaluateStandingInstructions({ ceiling, toolName: 'manage_services', input: { action: 'list', deviceId: PC01 } })).toEqual({ action: 'none' });
    expect(await evaluateStandingInstructions({ ceiling, toolName: 'run_script', input: { scriptId: 'x' } })).toEqual({ action: 'none' });
    expect(findMatches).not.toHaveBeenCalled();
  });
});

describe('a mapped tool missing from the registry', () => {
  it('throws (never reads as "no devices")', async () => {
    await expect(evaluateStandingInstructions({ ceiling, toolName: 'trigger_agent_restart', input: { deviceIds: [PC01] } }))
      .rejects.toThrow(/registry/);
    expect(findMatches).not.toHaveBeenCalled();
  });
});

describe('checkStandingInstructionsForCall (fail closed)', () => {
  it('a matcher error refuses with the retry text and is reported', async () => {
    findMatches.mockRejectedValue(new Error('db down'));
    const out = await checkStandingInstructionsForCall({ ceiling, toolName: 'run_script', input: { deviceIds: [PC01] } });
    expect(out).toEqual({ action: 'refuse', error: STANDING_CHECK_UNAVAILABLE_MESSAGE });
    expect(STANDING_CHECK_UNAVAILABLE_MESSAGE).toBe("Couldn't check remembered instructions; try again.");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('passes a decision through', async () => {
    findMatches.mockResolvedValue([match({ strength: 'possible' })]);
    expect(await checkStandingInstructionsForCall({ ceiling, toolName: 'run_script', input: { deviceIds: [PC01] } }))
      .toMatchObject({ action: 'warn' });
  });
});

describe('standingConflictDescription', () => {
  it('prefixes the card description so every channel shows the conflict', () => {
    expect(standingConflictDescription("don't reboot PC-01", 'Install 3 patches on PC-01'))
      .toBe("Conflicts with a remembered instruction: 'don't reboot PC-01'. Install 3 patches on PC-01");
  });
});

describe('run_script { groupId } (the group is expanded to its devices)', () => {
  const GROUP = '00000000-0000-4000-8000-0000000000a9';
  const ORG = '00000000-0000-4000-8000-0000000000b9';
  const reach = { scope: 'organization', orgId: ORG } as never;

  it('checks the group members, resolved under the caller reach in the write org', async () => {
    normalizeGroup.mockResolvedValue({ args: { deviceIds: [PC01, PC02] } });
    findMatches.mockResolvedValue([match()]);
    const out = await evaluateStandingInstructions({ ceiling, auth: reach, toolName: 'run_script', input: { scriptId: 's', groupId: GROUP } });
    expect(normalizeGroup).toHaveBeenCalledWith(reach, { scriptId: 's', groupId: GROUP }, ORG);
    expect(findMatches).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [PC01, PC02] }));
    expect(out.action).toBe('refuse');
  });

  it('a group the reach cannot resolve refuses with the resolver message', async () => {
    const { RunScriptGroupTargetError } = await import('../actionIntents/runScriptGroupTarget');
    normalizeGroup.mockRejectedValue(new RunScriptGroupTargetError('Device group not found', 'group_target_not_found'));
    const out = await checkStandingInstructionsForCall({ ceiling, auth: reach, toolName: 'run_script', input: { scriptId: 's', groupId: GROUP } });
    expect(out).toEqual({ action: 'refuse', error: 'Device group not found' });
    expect(findMatches).not.toHaveBeenCalled();
  });

  it('without a caller reach a group target fails closed (never "no devices")', async () => {
    await expect(evaluateStandingInstructions({ ceiling, toolName: 'run_script', input: { scriptId: 's', groupId: GROUP } }))
      .rejects.toThrow(/group/);
  });
});
