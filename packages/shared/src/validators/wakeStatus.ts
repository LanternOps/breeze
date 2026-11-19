import { z } from 'zod';

// Wake readiness snapshot the agent uploads (PUT /agents/:agentId/wake-status).
// Agent-reportable states only; the server adds unsupported_os,
// agent_update_required, no_data and lookup_failed. Keep this list identical to
// WAKE_READINESS_STATES in apps/api/src/db/schema/deviceWake.ts (an API test
// asserts equality).
export const WAKE_AGENT_READINESS_STATES = [
  'ready',
  'needs_reboot',
  'not_configured',
  'apply_failed',
  'firmware_protected',
  'unproven',
  'no_wired_adapter',
  'unsupported_vm',
] as const;
export type WakeAgentReadinessState = (typeof WAKE_AGENT_READINESS_STATES)[number];

const isoDateTime = z.string().datetime({ offset: true });

export const wakeStatusSnapshotSchema = z.object({
  readinessState: z.enum(WAKE_AGENT_READINESS_STATES),
  reasonCodes: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(16),
  vendor: z.string().min(1).max(32).nullable(),
  fingerprint: z.string().min(1).max(128),
  collectedAt: isoDateTime,
  lastApplyAt: isoDateTime.nullable(),
  lastApplyResult: z.string().max(32).nullable(),
  lastWiredAdapterSeenAt: isoDateTime.nullable(),
  details: z.record(z.string(), z.unknown()), // bounded by the route's 64 KiB body limit
}).strict();

export type WakeStatusSnapshot = z.infer<typeof wakeStatusSnapshotSchema>;
