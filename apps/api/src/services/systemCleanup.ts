/**
 * Server-side contract for the OS-native cleanup engine (Disk Cleanup v2 §5.3).
 *
 * Two jobs, both about not trusting things:
 *   1. the agent-version gate, which fails CLOSED, and
 *   2. Zod shapes for the two agent payloads, so nothing the agent sends
 *      reaches the UI (and therefore a subsequent run request) unvalidated.
 */

import { z } from 'zod';
import { SYSTEM_CLEANUP_ACTION_IDS, SYSTEM_CLEANUP_RISK_FLAGS } from '@breeze/shared/validators';
import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';

/**
 * The agent release that introduced system_cleanup_list / system_cleanup_run.
 *
 * Newest tag on the branch this wave was planned from is v0.114.0 (verified
 * 2026-09-19), so W04 ships in the next minor. If a release lands before this
 * merges, bump it here in the same PR — the pin in systemCleanup.test.ts is
 * its only other mention.
 */
export const MIN_AGENT_VERSION_SYSTEM_CLEANUP = '0.115.0';

/** Machine token both system-cleanup routes answer a stale agent with. */
export const AGENT_UPDATE_REQUIRED_ERROR = 'agent_update_required';

/** The agent's fallback for a command type it has no handler for. */
export const UNKNOWN_COMMAND_TYPE_PREFIX = 'unknown command type:';

/**
 * Does this device's agent understand the two command types?
 *
 * Fails CLOSED on anything unparseable. That is not defensive padding:
 * `compareAgentVersions` returns 0 when either side fails to parse, so the
 * obvious `compareAgentVersions(device.agentVersion, MIN) >= 0` lets '' and
 * 'dev' through as "equal to the minimum" — and `devices.agent_version` is
 * `varchar(50) NOT NULL`, so '' is a real value.
 *
 * Only the CORE is compared (spec §5.3's "core semver"): `0.115.0-rc1` is the
 * lab build W05 runs the acceptance gate on, and a prerelease-aware comparison
 * would rank it below `0.115.0` and gate the gate out.
 */
export function agentSupportsSystemCleanup(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const core = agentVersion.trim().split('-', 1)[0] ?? '';
  if (!parseComparableVersion(core)) return false;
  return compareAgentVersions(core, MIN_AGENT_VERSION_SYSTEM_CLEANUP) >= 0;
}

/**
 * Defensive half of the 409 (spec §5.3). A device can report a new-enough
 * version and still lack the handler — a hand-built binary, an update that
 * reported success and rolled back. Matching the agent's own fallback string
 * turns "the command failed for an unreadable reason" into "update the agent",
 * which is the only action that helps.
 *
 * Prefix-anchored on the TRIMMED string: the phrase appearing mid-message in
 * some other error is not this condition.
 */
export function isUnknownCommandTypeError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.trimStart().startsWith(UNKNOWN_COMMAND_TYPE_PREFIX);
}

/** Shared 409-or-go decision for routes and the AI lane. */
export function systemCleanupAgentGate(device: { agentVersion: string | null }):
  | { ok: true }
  | { ok: false; status: 409; error: 'agent_update_required'; minAgentVersion: string } {
  if (agentSupportsSystemCleanup(device.agentVersion)) return { ok: true };
  return {
    ok: false,
    status: 409,
    error: AGENT_UPDATE_REQUIRED_ERROR,
    minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
  };
}

const actionIdSchema = z.enum(SYSTEM_CLEANUP_ACTION_IDS);
const riskFlagSchema = z.enum(SYSTEM_CLEANUP_RISK_FLAGS);

const subActionSchema = z.object({
  id: actionIdSchema,
  label: z.string().max(200),
  estimateBytes: z.number().int().min(0).optional(),
  estimateKnown: z.boolean(),
});

const catalogActionSchema = z.object({
  id: actionIdSchema,
  label: z.string().max(200),
  description: z.string().max(1000),
  os: z.enum(['windows', 'darwin', 'linux']),
  subActions: z.array(subActionSchema).max(SYSTEM_CLEANUP_ACTION_IDS.length).optional(),
  available: z.boolean(),
  unavailableReason: z.string().max(500).optional(),
  estimateBytes: z.number().int().min(0).optional(),
  estimateKnown: z.boolean(),
  estimateDetail: z.string().max(500).optional(),
  riskFlags: z.array(riskFlagSchema).max(SYSTEM_CLEANUP_RISK_FLAGS.length),
  affectsVolumes: z.array(z.string().max(500)).max(64),
});

/** system_cleanup_list's result (spec §7.3). */
export const systemCleanupCatalogSchema = z.object({
  catalogVersion: z.number().int().min(1),
  actions: z.array(catalogActionSchema).max(SYSTEM_CLEANUP_ACTION_IDS.length),
  volumesBefore: z.array(z.object({
    mount: z.string().max(500),
    freeBytes: z.number().int().min(0),
  })).max(64),
});

export type SystemCleanupCatalog = z.infer<typeof systemCleanupCatalogSchema>;

/** system_cleanup_run's result (spec §7.3). */
export const systemCleanupRunResultSchema = z.object({
  runId: z.string().max(64),
  actions: z.array(z.object({
    id: actionIdSchema,
    subActions: z.array(z.object({
      id: actionIdSchema,
      status: z.enum(['completed', 'failed', 'timed_out', 'unavailable', 'busy', 'not_started']),
    })).max(SYSTEM_CLEANUP_ACTION_IDS.length).optional(),
    status: z.enum(['completed', 'failed', 'timed_out', 'unavailable', 'busy', 'not_started']),
    exitCode: z.number().int(),
    durationMs: z.number().int().min(0).optional(),
    outputTail: z.string().max(64_000).optional(),
    error: z.string().max(4_000).optional(),
  })).max(SYSTEM_CLEANUP_ACTION_IDS.length),
  volumes: z.array(z.object({
    mount: z.string().max(500),
    freeBefore: z.number().int().min(0),
    freeAfter: z.number().int().min(0),
  })).max(64),
  freedBytes: z.number().int().min(0),
});

export type SystemCleanupRunResult = z.infer<typeof systemCleanupRunResultSchema>;

/**
 * Parse an agent stdout payload, or null.
 *
 * NULL, not an empty object. The W01 lesson (spec defect 5) is that a blank
 * record written on unparseable output becomes the "latest" answer and zeroes
 * everything downstream; here it would present an empty catalogue as "this
 * device has no cleanup actions", which is indistinguishable from the truth
 * and wrong.
 */
export function parseAgentJson<T>(schema: z.ZodType<T>, stdout: string | null | undefined): T | null {
  if (typeof stdout !== 'string' || stdout.trim() === '') return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
