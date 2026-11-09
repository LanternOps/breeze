import { beforeEach, describe, expect, it, vi } from 'vitest';

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock('./standingInstructionGate', () => ({
  evaluateStandingInstructions: (...args: unknown[]) => evaluate(...args),
}));

import type { GrantCeiling } from './grantAuthority';
import {
  STANDING_INSTRUCTION_DENIED,
  STANDING_INSTRUCTION_RELEASE_MESSAGE,
  checkStandingInstructionsForRelease,
} from './standingInstructionRelease';

const ceiling = { grantId: 'g' } as unknown as GrantCeiling;
const intent = { id: 'intent-1', actionName: 'manage_patches', arguments: { action: 'install', deviceIds: ['d'] } };

beforeEach(() => { evaluate.mockReset(); });

describe('checkStandingInstructionsForRelease', () => {
  it('a refusal at release is standing_instruction_denied with the release copy and the instruction', async () => {
    evaluate.mockResolvedValue({
      action: 'refuse', error: 'x', match: { instructionId: 'i-1', text: "don't reboot PC-01" },
    });
    expect(await checkStandingInstructionsForRelease(intent, ceiling)).toEqual({
      errorCode: STANDING_INSTRUCTION_DENIED,
      details: { instructionId: 'i-1', text: "don't reboot PC-01", reason: STANDING_INSTRUCTION_RELEASE_MESSAGE },
    });
    expect(STANDING_INSTRUCTION_DENIED).toBe('standing_instruction_denied');
    expect(STANDING_INSTRUCTION_RELEASE_MESSAGE).toBe(
      'Refused: this now conflicts with a standing instruction. Ask the user to lift it, or act from the device page.',
    );
    expect(evaluate).toHaveBeenCalledWith({ ceiling, toolName: 'manage_patches', input: intent.arguments });
  });

  it('a warning never blocks at release (a human already decided)', async () => {
    evaluate.mockResolvedValue({ action: 'warn', text: 't', matches: [] });
    expect(await checkStandingInstructionsForRelease(intent, ceiling)).toBeNull();
  });

  it('no match is null', async () => {
    evaluate.mockResolvedValue({ action: 'none' });
    expect(await checkStandingInstructionsForRelease(intent, ceiling)).toBeNull();
  });

  it('an intent with no arguments is checked with an empty input', async () => {
    evaluate.mockResolvedValue({ action: 'none' });
    await checkStandingInstructionsForRelease({ ...intent, arguments: null as never }, ceiling);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ input: {} }));
  });

  it('a lookup failure propagates: each release lane fails closed in its own way', async () => {
    evaluate.mockRejectedValue(new Error('db down'));
    await expect(checkStandingInstructionsForRelease(intent, ceiling)).rejects.toThrow('db down');
  });
});
