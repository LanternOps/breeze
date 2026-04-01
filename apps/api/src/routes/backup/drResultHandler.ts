import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { drExecutions } from '../../db/schema';

type HandleDrCommandResultParams = {
  commandId: string;
  commandType: string;
  deviceId: string;
  status: string;
  result: unknown;
  payload: Record<string, unknown>;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as JsonRecord) }
    : {};
}

function asRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is JsonRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry));
}

function getGroupId(entry: JsonRecord): string | null {
  const value = typeof entry.groupId === 'string'
    ? entry.groupId
    : typeof entry.id === 'string'
      ? entry.id
      : null;
  return value && value.trim() ? value : null;
}

function getDeviceId(entry: JsonRecord): string | null {
  const value = typeof entry.deviceId === 'string'
    ? entry.deviceId
    : typeof entry.id === 'string'
      ? entry.id
      : null;
  return value && value.trim() ? value : null;
}

function getExpectedDeviceCount(entry: JsonRecord): number {
  if (typeof entry.deviceCount === 'number' && Number.isFinite(entry.deviceCount)) {
    return Math.max(0, Math.trunc(entry.deviceCount));
  }

  if (Array.isArray(entry.devices)) {
    return entry.devices.filter((value): value is string => typeof value === 'string').length;
  }

  return 0;
}

function isTerminalDeviceStatus(status: string | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'timeout';
}

export async function handleDrCommandResult(params: HandleDrCommandResultParams): Promise<void> {
  const drExecutionId = typeof params.payload.drExecutionId === 'string' ? params.payload.drExecutionId : null;
  const drGroupId = typeof params.payload.drGroupId === 'string' ? params.payload.drGroupId : null;

  if (!drExecutionId || !drGroupId) {
    return;
  }

  const groupName = typeof params.payload.groupName === 'string' ? params.payload.groupName : null;
  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();

  const [updatedExecution] = await db
    .update(drExecutions)
    .set({
      results: sql`
        (
          with current_results as (
            select coalesce(${drExecutions.results}, '{}'::jsonb) as doc
          ),
          new_device as (
            select jsonb_build_object(
              'deviceId', ${params.deviceId},
              'commandId', ${params.commandId},
              'commandType', ${params.commandType},
              'status', ${params.status},
              'completedAt', ${completedAtIso}
            ) as doc
          ),
          existing_group as (
            select value as doc
            from jsonb_array_elements(coalesce((select doc->'groupResults' from current_results), '[]'::jsonb)) as value
            where value->>'groupId' = ${drGroupId}
            limit 1
          ),
          merged_group as (
            select case
              when exists(select 1 from existing_group) then (
                select jsonb_set(
                  case
                    when ${groupName} is not null then jsonb_set(existing_group.doc, '{groupName}', to_jsonb(${groupName}::text), true)
                    else existing_group.doc
                  end,
                  '{devices}',
                  case
                    when exists(
                      select 1
                      from jsonb_array_elements(coalesce(existing_group.doc->'devices', '[]'::jsonb)) as device
                      where coalesce(device->>'deviceId', device->>'id') = ${params.deviceId}
                    ) then (
                      select coalesce(
                        jsonb_agg(
                          case
                            when coalesce(device->>'deviceId', device->>'id') = ${params.deviceId}
                              then (select doc from new_device)
                            else device
                          end
                        ),
                        '[]'::jsonb
                      )
                      from jsonb_array_elements(coalesce(existing_group.doc->'devices', '[]'::jsonb)) as device
                    )
                    else coalesce(existing_group.doc->'devices', '[]'::jsonb) || jsonb_build_array((select doc from new_device))
                  end,
                  true
                )
                from existing_group
              )
              else jsonb_build_object(
                'groupId', ${drGroupId},
                'groupName', ${groupName},
                'devices', jsonb_build_array((select doc from new_device))
              )
            end as doc
          )
          select jsonb_set(
            (select doc from current_results),
            '{groupResults}',
            case
              when exists(select 1 from existing_group) then (
                select coalesce(
                  jsonb_agg(
                    case
                      when value->>'groupId' = ${drGroupId} then (select doc from merged_group)
                      else value
                    end
                  ),
                  '[]'::jsonb
                )
                from jsonb_array_elements(coalesce((select doc->'groupResults' from current_results), '[]'::jsonb)) as value
              )
              else coalesce((select doc->'groupResults' from current_results), '[]'::jsonb) || jsonb_build_array((select doc from merged_group))
            end,
            true
          )
        )
      `,
    })
    .where(eq(drExecutions.id, drExecutionId))
    .returning({
      id: drExecutions.id,
      results: drExecutions.results,
      status: drExecutions.status,
    });

  if (!updatedExecution) {
    return;
  }

  const results = asRecord(updatedExecution.results);
  const plannedGroups = asRecordArray(results.plannedGroups);
  const groupResults = asRecordArray(results.groupResults);

  if (plannedGroups.length === 0) {
    return;
  }

  const groupResultsById = new Map<string, JsonRecord>();
  for (const groupResult of groupResults) {
    const groupId = getGroupId(groupResult);
    if (groupId) {
      groupResultsById.set(groupId, groupResult);
    }
  }

  let allGroupsReported = true;
  let hasFailedDevice = false;

  for (const plannedGroup of plannedGroups) {
    const plannedGroupId = getGroupId(plannedGroup);
    if (!plannedGroupId) {
      allGroupsReported = false;
      break;
    }

    const expectedDeviceCount = getExpectedDeviceCount(plannedGroup);
    const reportedGroup = groupResultsById.get(plannedGroupId);
    if (!reportedGroup) {
      allGroupsReported = false;
      break;
    }

    const deviceEntries = asRecordArray(reportedGroup.devices);
    const latestByDeviceId = new Map<string, JsonRecord>();
    for (const deviceEntry of deviceEntries) {
      const reportedDeviceId = getDeviceId(deviceEntry);
      if (reportedDeviceId) {
        latestByDeviceId.set(reportedDeviceId, deviceEntry);
      }
    }

    if (latestByDeviceId.size < expectedDeviceCount) {
      allGroupsReported = false;
      break;
    }

    for (const deviceEntry of latestByDeviceId.values()) {
      const deviceStatus = typeof deviceEntry.status === 'string' ? deviceEntry.status : null;
      if (!isTerminalDeviceStatus(deviceStatus)) {
        allGroupsReported = false;
        break;
      }
      if (deviceStatus !== 'completed') {
        hasFailedDevice = true;
      }
    }

    if (!allGroupsReported) {
      break;
    }
  }

  if (!allGroupsReported) {
    return;
  }

  await db
    .update(drExecutions)
    .set({
      status: hasFailedDevice ? 'failed' : 'completed',
      completedAt,
    })
    .where(and(eq(drExecutions.id, updatedExecution.id), eq(drExecutions.status, 'pending')));
}
