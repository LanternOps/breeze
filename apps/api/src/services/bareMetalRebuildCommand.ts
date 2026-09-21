// Bare-metal recovery W05a: the `bare_metal_rebuild` device command. A helper
// host runs `breeze-backup rebuild --token` against a server-minted recovery
// token and reports phases to /bmr/recover/progress; this module owns the
// payload contract and the one queue chokepoint (Restore-as-VM engine path,
// DR rehearsals). See docs/superpowers/plans/backup/2026-09-18-bare-metal-w05-restore-as-vm-dr-plans.md
// Task 2.
import { z } from 'zod';
import { createAuditLogAsync } from './auditService';
import { queueCommandForExecution } from './commandQueue';
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
    path: z.string().min(1).max(1024).refine((p) => p.startsWith('/'), 'absolute path required'),
    imageSizeBytes: z.number().int().positive().optional(),
  }),
  identity: z.enum(['original', 'new']),
});
export type BareMetalRebuildPayload = z.infer<typeof bareMetalRebuildPayloadSchema>;

export async function queueBareMetalRebuild(input: {
  orgId: string;
  hostDeviceId: string;
  payload: BareMetalRebuildPayload;
  userId?: string;
}): Promise<{ command: { id: string; status: string } | null; error: string | null }> {
  // `token` is registered in SENSITIVE_PAYLOAD_FIELDS: encrypted at rest here,
  // decrypted just-in-time on delivery, and erased by every terminal writer.
  const payload = encryptSensitivePayloadFields(CommandTypes.BARE_METAL_REBUILD, input.payload);

  const res = await queueCommandForExecution(input.hostDeviceId, CommandTypes.BARE_METAL_REBUILD, payload, {
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
    },
  }).catch(() => {
    // Already retried + Sentry-captured inside createAuditLogAsync.
  });

  return { command, error };
}
