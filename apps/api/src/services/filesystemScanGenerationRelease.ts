import { eq } from 'drizzle-orm';
import { normalizeScanPath, osRootScanPath } from '@breeze/shared';
import { db } from '../db';
import { devices } from '../db/schema/devices';
import { clearFilesystemScanGeneration } from './filesystemAnalysis';

/**
 * #8509/#8945/#9105: a filesystem_analysis command ended without a result
 * (agent refusal, agent-reported failed/timeout, or a server-side timeout from
 * staleCommandReaper). Producers register the command as its volume's scan
 * generation when they queue it, so a dead command left as the generation makes
 * other scans' (or older good) results look superseded. Release it
 * conditionally so a newer producer's registration is never cleared.
 *
 * Shared by the agent-result handler and the stale-command reaper.
 */
export async function releaseFilesystemScanGenerationForCommand(command: {
  id: string;
  deviceId: string;
  payload: unknown;
}, reason: string): Promise<void> {
  const [deviceRow] = await db
    .select({ osType: devices.osType })
    .from(devices)
    .where(eq(devices.id, command.deviceId))
    .limit(1);
  if (!deviceRow) {
    console.warn(
      `[filesystemScanGenerationRelease] filesystem_analysis command ${command.id} ended ${reason} but device ${command.deviceId} has no devices row; scan generation not released`
    );
    return;
  }
  const payload =
    command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
      ? (command.payload as Record<string, unknown>)
      : {};
  const rawPath = typeof payload.path === 'string' ? payload.path : undefined;
  const scanPath = normalizeScanPath(deviceRow.osType, rawPath ?? osRootScanPath(deviceRow.osType));
  await clearFilesystemScanGeneration(command.deviceId, scanPath, command.id);
}
