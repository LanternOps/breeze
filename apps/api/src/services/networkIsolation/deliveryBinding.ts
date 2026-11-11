import { and, eq } from 'drizzle-orm';
import { isResolvedTerminalIsolationState } from '@breeze/shared';
import type { db } from '../../db';
import { deviceNetworkIsolations } from '../../db/schema';
import { captureMessage } from '../sentry';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DeliveryBindingReader = Pick<Tx, 'select'>;
export type DeliveryBindingRow = { id: string; type: string; deviceId: string; payload: unknown };

/** The stable claim-cancel reason for an isolation command the episode does not own. */
export const ISOLATION_EPISODE_MISMATCH = 'isolation_episode_mismatch' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type UnboundReason = 'no_binding' | 'no_episode' | 'not_episode_command';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Not the episode's own command: nothing a running service would produce. A legacy row from before
 * W1c, a row written past every issuing gate, or a forged payload naming a real episode. Reported
 * once per row (the cancel is terminal), never with payload contents.
 */
function unbound(row: DeliveryBindingRow, reason: UnboundReason, isolationId?: string): typeof ISOLATION_EPISODE_MISMATCH {
  const tags = { deviceId: row.deviceId, commandId: row.id, commandType: row.type, reason, ...(isolationId ? { isolationId } : {}) };
  console.error('[isolation] refused a command that is not the episode\'s own', tags);
  captureMessage('Network isolation command refused at delivery: it is not the episode\'s own command', {
    eventCode: 'network_isolation_command_unbound', level: 'error', tags,
  });
  return ISOLATION_EPISODE_MISMATCH;
}

/**
 * #10919: an isolation command is delivered only when it is the row the isolation service issued,
 * named by the episode's server-held `command_id` (isolate) or `release_command_id` (release). The
 * payload's `isolationId` only says which episode to read; it is never authority by itself. Runs on
 * both delivery legs through `revalidateCommandForDelivery`, so a row that reached `device_commands`
 * any other way is cancelled here whatever wrote it. Never writes.
 */
export async function isolationDeliveryRefusal(
  reader: DeliveryBindingReader,
  row: DeliveryBindingRow,
): Promise<typeof ISOLATION_EPISODE_MISMATCH | null> {
  const release = row.type === 'release_containment';
  const payload = record(row.payload);
  const binding = release ? payload : record(payload?.parameters);
  const isolationId = binding?.isolationId;
  const generation = binding?.generation;
  if (typeof isolationId !== 'string' || !UUID.test(isolationId)
    || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
    return unbound(row, 'no_binding');
  }
  const [episode] = await reader.select({
    id: deviceNetworkIsolations.id, deviceId: deviceNetworkIsolations.deviceId,
    generation: deviceNetworkIsolations.generation, state: deviceNetworkIsolations.state,
    desiredState: deviceNetworkIsolations.desiredState, commandId: deviceNetworkIsolations.commandId,
    releaseCommandId: deviceNetworkIsolations.releaseCommandId,
  }).from(deviceNetworkIsolations)
    .where(and(eq(deviceNetworkIsolations.id, isolationId), eq(deviceNetworkIsolations.deviceId, row.deviceId)))
    .limit(1);
  if (!episode || episode.id !== isolationId || episode.deviceId !== row.deviceId) return unbound(row, 'no_episode', isolationId);

  if (release) {
    if (episode.releaseCommandId === row.id) return null;
    // A re-release replaced this row on the episode, and that newer row is the one delivered.
    // Ordinary lifecycle, so it is cancelled without raising an alarm.
    if (episode.desiredState === 'released' && episode.releaseCommandId) return ISOLATION_EPISODE_MISMATCH;
    return unbound(row, 'not_episode_command', isolationId);
  }

  if (episode.commandId !== row.id) return unbound(row, 'not_episode_command', isolationId);
  // The episode's own isolate, overtaken by an extend, a release or a resolution before delivery.
  if (episode.generation !== generation || isResolvedTerminalIsolationState(episode.state) || episode.desiredState !== 'isolated') {
    return ISOLATION_EPISODE_MISMATCH;
  }
  return null;
}
