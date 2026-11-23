/**
 * Learned networks E9 (#12369, spec §8.2): the attempt record, written before a discovery scan command leaves.
 *
 * A worker job's attempt lives on `discovery_jobs.network_dispatch`; a result or adjacency report is accepted
 * only against it, and a refusal that arrives right after the send is recorded with its code. The AI tool has no
 * job row: its attempt is the persisted `device_commands` row, whose payload the server wrote.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { GUARDED_COMMAND_TYPES } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { deviceCommands, discoveryJobs, discoveryProfiles } from '../../db/schema';
import { DISCOVERY_SCAN_FAMILY } from './scanCommand';

export type NetworkDispatchRecord = {
  version: 1; mode: 'unrestricted' | 'guarded'; agentId: string; deviceId: string;
  allowedNetworkIds: string[]; allowedGatewayIds: string[]; decidedAt: string;
};  // allowedGatewayIds holds the fingerprints actually sent (at most 64): what the agent can prove

const networkDispatchRecordSchema = z.object({
  version: z.literal(1),
  mode: z.enum(['unrestricted', 'guarded']),
  agentId: z.string(),
  deviceId: z.string(),
  allowedNetworkIds: z.array(z.string()),
  allowedGatewayIds: z.array(z.string()),
  decidedAt: z.string(),
});

/** `null` for SQL null (a job dispatched before this shipped); `'invalid'` for any other shape. */
export function parseNetworkDispatchRecord(value: unknown): NetworkDispatchRecord | null | 'invalid' {
  if (value === null || value === undefined) return null;
  const parsed = networkDispatchRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : 'invalid';
}

/**
 * One UPDATE: the record, the agent, status 'running', started_at (and updated_at, which the 15-minute running
 * expiry keys on), only while the job is still 'scheduled'. False: the job left 'scheduled' (cancelled, or
 * resolved by another attempt), so nothing may be sent.
 */
export async function recordDispatchAttempt(jobId: string, record: NetworkDispatchRecord): Promise<boolean> {
  const now = new Date();
  const updated = await db
    .update(discoveryJobs)
    .set({ networkDispatch: record, agentId: record.agentId, status: 'running', startedAt: now, updatedAt: now })
    .where(and(eq(discoveryJobs.id, jobId), eq(discoveryJobs.status, 'scheduled')))
    .returning({ id: discoveryJobs.id });
  return updated.length > 0;
}

/**
 * The live profile row, read FOR SHARE: a profile save holds FOR UPDATE, so its secrets and grants are read from
 * one committed state. The caller already holds the site lock (lock order: site locks, then the profile row).
 */
export async function loadProfileForDispatch(profileId: string): Promise<typeof discoveryProfiles.$inferSelect | null> {
  assertInTransaction('loadProfileForDispatch');
  const [row] = await db
    .select()
    .from(discoveryProfiles)
    .where(eq(discoveryProfiles.id, profileId))
    .limit(1)
    .for('share');
  return row ?? null;
}

const expectedGatewayIdsSchema = z.object({
  expectedNetwork: z.object({ gateways: z.array(z.object({ gatewayId: z.string() })) }),
});

/**
 * The AI tool's attempt: the persisted command row's type and server-written payload. The guarded type yields its
 * `expectedNetwork` gateway ids; the base type is unrestricted; no row is null. Any other type, or a guarded
 * payload that does not parse, fails closed (guarded with nothing allowed).
 */
export async function loadCommandAttempt(commandId: string, deviceId: string):
  Promise<{ mode: 'unrestricted' | 'guarded'; allowedGatewayIds: string[] } | null> {
  const [row] = await db
    .select({ type: deviceCommands.type, payload: deviceCommands.payload })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.id, commandId), eq(deviceCommands.deviceId, deviceId)))
    .limit(1);
  if (!row) return null;
  if (row.type === DISCOVERY_SCAN_FAMILY) return { mode: 'unrestricted', allowedGatewayIds: [] };
  if (row.type === GUARDED_COMMAND_TYPES.network_discovery) {
    const parsed = expectedGatewayIdsSchema.safeParse(row.payload);
    return { mode: 'guarded', allowedGatewayIds: parsed.success ? parsed.data.expectedNetwork.gateways.map((g) => g.gatewayId) : [] };
  }
  return { mode: 'guarded', allowedGatewayIds: [] };
}
