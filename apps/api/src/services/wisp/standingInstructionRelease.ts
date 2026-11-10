/**
 * #10428 W06 (spec §5.3, Review Focus 3): standing instructions at RELEASE of
 * a pending action intent from a Wisp origin.
 *
 * An approval card raised before the user confirmed "don't reboot PC-01" must
 * not release the reboot afterwards. Both release lanes already resolve the
 * grant's live ceiling — `checkWispCeilingForRelease` for a chat intent (the
 * session's pinned grant), `checkAgentReleaseAuthority` for a worker intent
 * (the run's grant) — and each calls this with it, so the intent's Wisp origin
 * is resolved once. An intent with no Wisp origin never reaches here.
 *
 * Only a refusal blocks; a warning is ignored at release, because a human has
 * already decided the card. A lookup failure throws, and each lane fails
 * closed in its own vocabulary (chat: `wisp_gate_unavailable`, terminal;
 * worker: `grant_ceiling_unavailable`, pausable).
 */
import type { ActionIntent } from '../../db/schema/actionIntents';
import type { GrantCeiling } from './grantAuthority';
import { evaluateStandingInstructions } from './standingInstructionGate';

export const STANDING_INSTRUCTION_DENIED = 'standing_instruction_denied' as const;

/** The release refusal the chat and the approvals surface show. */
export const STANDING_INSTRUCTION_RELEASE_MESSAGE =
  'Refused: this now conflicts with a standing instruction. Ask the user to lift it, or act from the device page.';

export type StandingInstructionReleaseRefusal = {
  errorCode: typeof STANDING_INSTRUCTION_DENIED;
  details: { instructionId: string; text: string; reason: string };
};

export async function checkStandingInstructionsForRelease(
  intent: Pick<ActionIntent, 'id' | 'actionName' | 'arguments'>,
  ceiling: GrantCeiling,
): Promise<StandingInstructionReleaseRefusal | null> {
  const check = await evaluateStandingInstructions({
    ceiling,
    toolName: intent.actionName,
    input: (intent.arguments ?? {}) as Record<string, unknown>,
  });
  if (check.action !== 'refuse') return null;
  return {
    errorCode: STANDING_INSTRUCTION_DENIED,
    details: { instructionId: check.match.instructionId, text: check.match.text, reason: STANDING_INSTRUCTION_RELEASE_MESSAGE },
  };
}
