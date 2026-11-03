import { and, eq, gte, ne, sql } from 'drizzle-orm';
import type { DeviceAiActivityDto } from '@breeze/shared';
import { db } from '../db';
import { deviceCommands, scriptExecutions } from '../db/schema';

/**
 * The de-duplicated count of AI-DISPATCHED mutations on one device in the
 * trailing window (#5022 W02). Moved verbatim out of
 * `routes/devices/aiOrigin.ts` so the route and the `get_device_ai_activity`
 * tool (full-control W10, #6780) share one copy of the rule. The caller has
 * already authorised the device.
 *
 * De-duplication rule: an AI-run script writes BOTH a script_executions row
 * AND a device_commands row of type='script' (scriptDispatch.ts calls
 * queueCommand(device.id, 'script', …) after inserting the execution).
 * Counting both would double-count every AI script dispatch, so the
 * device_commands arm explicitly excludes type='script' — those dispatches
 * are already counted via script_executions. A cancel command IS its own
 * distinct AI mutation and is counted (not excluded).
 */
export async function countDeviceAiActivity(deviceId: string, days: number): Promise<DeviceAiActivityDto> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [executionCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(scriptExecutions)
    .where(
      and(
        eq(scriptExecutions.deviceId, deviceId),
        sql`${scriptExecutions.aiInitiatorKind} IS NOT NULL`,
        gte(scriptExecutions.createdAt, since),
      ),
    );

  const [commandCountRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        sql`${deviceCommands.aiInitiatorKind} IS NOT NULL`,
        gte(deviceCommands.createdAt, since),
        // Excluded: the type='script' command a script dispatch ALSO writes
        // — it's already counted via script_executions above. See the
        // de-duplication rule in this function's docstring.
        ne(deviceCommands.type, 'script'),
      ),
    );

  return {
    dispatchedActions: Number(executionCountRow?.count ?? 0) + Number(commandCountRow?.count ?? 0),
    windowDays: days,
    since: since.toISOString(),
  };
}
