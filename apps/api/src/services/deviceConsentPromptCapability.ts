import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { devices } from '../db/schema';

/**
 * The consent prompt protocol version the device's agent last reported
 * (0 when it reported none, or the device is gone). Read fresh, in system
 * scope, for callers that hold only the device's identity — the remote-WS
 * authorization context carries no capability fields.
 */
export async function loadDeviceConsentPromptProtocolVersion(deviceId: string): Promise<number> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ version: devices.consentPromptProtocolVersion })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1),
    ),
  );
  return Number(row?.version ?? 0);
}
