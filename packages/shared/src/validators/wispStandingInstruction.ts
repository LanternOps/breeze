/**
 * Typed `content` of an `ai_memory_blocks` row with
 * `block_type = 'standing_instruction'`, written by Wisp's turn-end
 * instruction capture (#10428, spec
 * docs/superpowers/specs/ai-mcp/2026-11-06-wisp-chat-grant-followups-spec.md §5.3).
 *
 * One block is written per target device, all sharing `instructionId`.
 * `deviceId` is only ever set by server-side name resolution, never taken
 * from model output; a `null` deviceId means a free-text note.
 */
import { z } from 'zod';

export const STANDING_VERBS = ['reboot', 'shutdown', 'run_script', 'patch_install', 'any_change'] as const;
export type StandingVerb = (typeof STANDING_VERBS)[number];

export const STANDING_EFFECTS = ['deny', 'prefer', 'require'] as const;
export type StandingEffect = (typeof STANDING_EFFECTS)[number];

export const standingInstructionContentSchema = z.object({
  instructionId: z.guid(),
  effect: z.enum(STANDING_EFFECTS),
  verb: z.enum(STANDING_VERBS).nullable(),
  deviceId: z.guid().nullable(),
  condition: z.string().max(300).nullable(),
  until: z.iso.datetime({ offset: true }).nullable(),
  text: z.string().min(1).max(500),
  targetLabels: z.array(z.string().max(120)).max(20),
  sourceMessageId: z.guid().nullable(),
  captureId: z.guid().nullable(),
}).strict();

export type StandingInstructionContent = z.infer<typeof standingInstructionContentSchema>;
