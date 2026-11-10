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

/**
 * The turn-end capture's lifecycle, kept in a short-lived status key the chip
 * polls: `pending` until the extractor finishes, then `saved` (blocks
 * written), `none` (nothing to keep), `skipped` (daily cap, budget, no model)
 * or `failed`. Never retried.
 */
export const WISP_INSTRUCTION_CAPTURE_STATUSES = ['pending', 'saved', 'none', 'skipped', 'failed'] as const;
export type WispInstructionCaptureStatus = (typeof WISP_INSTRUCTION_CAPTURE_STATUSES)[number];
export type WispInstructionCaptureTerminalStatus = Exclude<WispInstructionCaptureStatus, 'pending'>;

/** One captured instruction (all blocks sharing an `instructionId`) as the chip shows it. */
export type CapturedInstructionDto = {
  instructionId: string;
  /** The turn-end capture that wrote it (one capture can yield several instructions). */
  captureId: string | null;
  /** When it was captured (ISO): places a reloaded chip under its reply. */
  capturedAt: string;
  text: string;
  status: 'unconfirmed' | 'confirmed' | 'retracted';
  /** An unconditional, unexpired deny on resolved devices: the only form ever enforced (spec §5.3). */
  enforceable: boolean;
  verb: StandingVerb | null;
  targetLabels: string[];
  until: string | null;
  /** The one org every target device is in; null for a note or for targets across orgs ("Keep for everyone" is hidden). */
  orgId: string | null;
  orgName: string | null;
  /** Named devices that did not all resolve: saved as a free-text note, never enforced. */
  unmatched: boolean;
  /** "Keep for everyone" was used: the instruction now lives in the org's memory. */
  keptForOrg: boolean;
};

export type WispInstructionCaptureStatusResponse = {
  status: WispInstructionCaptureStatus;
  instructions: CapturedInstructionDto[];
};
