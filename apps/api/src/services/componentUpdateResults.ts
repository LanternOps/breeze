import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';

type ComponentUpdateCommand = {
  deviceId: string;
  type: string;
  targetRole?: string | null;
  payload?: unknown;
};

function payloadVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const version = (payload as Record<string, unknown>).version;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

function reportedUpdatedVersion(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const data = result as Record<string, unknown>;
  const version = data.updated_to ?? data.updatedTo;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

export async function applyCompletedComponentUpdateVersion(
  command: ComponentUpdateCommand,
  resultStatus: string,
  result?: unknown,
): Promise<boolean> {
  if (resultStatus !== 'completed') return false;

  const version = payloadVersion(command.payload);
  if (!version) return false;

  const updatedTo = reportedUpdatedVersion(result);
  if (updatedTo !== version) return false;

  const now = new Date();
  if (command.type === 'update_agent' && command.targetRole === 'watchdog') {
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db
        .update(devices)
        .set({ agentVersion: version, updatedAt: now })
        .where(eq(devices.id, command.deviceId)),
    ));
    return true;
  }

  if (command.type === 'update_watchdog' && command.targetRole === 'agent') {
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db
        .update(devices)
        .set({ watchdogVersion: version, updatedAt: now })
        .where(eq(devices.id, command.deviceId)),
    ));
    return true;
  }

  return false;
}
