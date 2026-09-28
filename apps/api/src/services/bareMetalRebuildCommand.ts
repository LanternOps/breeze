// Bare-metal recovery W05a: the `bare_metal_rebuild` device command. A helper
// host runs `breeze-backup rebuild --token` against a server-minted recovery
// token and reports phases to /bmr/recover/progress; this module owns the
// payload contract and the one queue chokepoint (Restore-as-VM engine path,
// DR rehearsals). See docs/superpowers/plans/backup/2026-09-18-bare-metal-w05-restore-as-vm-dr-plans.md
// Task 2.
import { z } from 'zod';
import { createAuditLogAsync } from './auditService';
import { hypervOptionsSchema, isAbsoluteRebuildPath } from './bareMetalRebuildSchemas';
import { queueCommandForExecution, queueCommandForExecutionWithSystemPrecheck } from './commandQueue';
import { CommandTypes } from './commandTypes';
import { encryptSensitivePayloadFields } from './sensitiveCommandPayload';

const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

// The payload carries a RECOVERY TOKEN, never the 9-character code: the
// exchange route is public, so a code in a device_commands row would be a
// bearer credential for anyone who can read the table. `identity` is
// informational — the helper takes it from the bootstrap's `recovery.identity`,
// which the server enforces, exactly as token mode does today.
export const bareMetalRebuildPayloadSchema = z.object({
  recoveryId: z.string().guid(),
  token: z.string().min(1),
  server: z.string().url(),
  target: z.object({
    kind: z.enum(['vhdx', 'image']),
    // POSIX `/…` or a Windows drive-letter `X:\…` (W06d); never UNC.
    path: z.string().min(1).max(1024).refine(isAbsoluteRebuildPath, 'absolute path required (POSIX or a Windows drive letter, no UNC)'),
    imageSizeBytes: z.number().int().positive().optional(),
  }),
  identity: z.enum(['original', 'new']),
  // W06d: create a Hyper-V VM from the rebuilt VHDX (Windows rebuild hosts
  // only — the caller refuses it for any other host before queueing).
  hyperv: hypervOptionsSchema,
});
export type BareMetalRebuildPayload = z.infer<typeof bareMetalRebuildPayloadSchema>;

type QueueBareMetalRebuildInput = {
  orgId: string;
  hostDeviceId: string;
  payload: BareMetalRebuildPayload;
  userId?: string;
};
type QueueBareMetalRebuildResult = { command: { id: string; status: string } | null; error: string | null };

async function queueBareMetalRebuildVia(
  dispatch: (
    deviceId: string,
    type: string,
    payload: Record<string, unknown>,
    options: { userId?: string; expectedOrgId: string },
  ) => Promise<{ command?: { id: string; status: string } | null; error?: string }>,
  input: QueueBareMetalRebuildInput,
): Promise<QueueBareMetalRebuildResult> {
  // `token` is registered in SENSITIVE_PAYLOAD_FIELDS: encrypted at rest here,
  // decrypted just-in-time on delivery, and erased by every terminal writer.
  const payload = encryptSensitivePayloadFields(CommandTypes.BARE_METAL_REBUILD, input.payload);

  const res = await dispatch(input.hostDeviceId, CommandTypes.BARE_METAL_REBUILD, payload, {
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    expectedOrgId: input.orgId,
  });

  const command = res.command ? { id: res.command.id, status: res.command.status } : null;
  const error = res.error ?? (command ? null : 'Failed to queue bare-metal rebuild');

  void createAuditLogAsync({
    orgId: input.orgId,
    actorType: input.userId ? 'user' : 'system',
    actorId: input.userId ?? SYSTEM_ACTOR_ID,
    action: 'bmr.rebuild.command',
    resourceType: 'bare_metal_recovery',
    resourceId: input.payload.recoveryId,
    result: error ? 'failure' : 'success',
    ...(error ? { errorMessage: error } : {}),
    details: {
      recoveryId: input.payload.recoveryId,
      hostDeviceId: input.hostDeviceId,
      commandId: command?.id ?? null,
      target: input.payload.target,
      identity: input.payload.identity,
      ...(input.payload.hyperv ? { hyperv: input.payload.hyperv } : {}),
    },
  }).catch(() => {
    // Already retried + Sentry-captured inside createAuditLogAsync.
  });

  return { command, error };
}

/** Ambient-context callers (e.g. a route already inside a request transaction). */
export async function queueBareMetalRebuild(input: QueueBareMetalRebuildInput): Promise<QueueBareMetalRebuildResult> {
  return queueBareMetalRebuildVia(queueCommandForExecution, input);
}

/**
 * No-ambient-context callers only (e.g. dispatch work run strictly after a
 * caller's own transaction has committed — see drExecutionService.ts's
 * post-commit DR dispatcher, #242 hardening). Commits its own short
 * transaction before socket transport instead of running inside whatever
 * transaction happens to be open, which is what this variant exists to
 * prevent: dispatching from inside an ambient transaction while also holding
 * a second pooled connection open for this call is exactly the double-hold
 * shape that produced #2417 and #6671.
 */
export async function queueBareMetalRebuildWithSystemPrecheck(
  input: QueueBareMetalRebuildInput,
): Promise<QueueBareMetalRebuildResult> {
  return queueBareMetalRebuildVia(
    (deviceId, type, payload, options) =>
      queueCommandForExecutionWithSystemPrecheck(deviceId, type, payload, {
        ...options,
        expectedOrgId: input.orgId,
      }),
    input,
  );
}
