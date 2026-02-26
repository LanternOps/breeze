import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { devices, s1Actions, s1Agents, s1Integrations, s1Threats } from '../../db/schema';
import {
  dispatchS1Isolation,
  dispatchS1ThreatAction,
  scheduleS1ActionPoll
} from '../../jobs/s1Sync';
import type { S1ThreatAction } from './client';

const NO_ACTIVITY_ID_WARNING = 'Provider did not return activityId; action cannot be tracked';

export interface S1ActiveIntegration {
  id: string;
  orgId: string;
  name: string;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
}

export interface S1ActionErrorResult {
  ok: false;
  status: 400 | 403 | 404;
  error: string;
  details?: Record<string, unknown>;
}

export interface S1IsolateActionData {
  requestedDeviceIds: string[];
  inaccessibleDeviceIds: string[];
  unmappedAccessibleDeviceIds: string[];
  requestedDevices: number;
  mappedAgents: number;
  providerActionId: string | null;
  actions: Array<{ id: string; deviceId: string | null }>;
  warning?: string;
}

export interface S1ThreatActionData {
  action: S1ThreatAction;
  requestedThreats: number;
  matchedThreats: number;
  matchedThreatIds: string[];
  unmatchedThreatIds: string[];
  providerActionId: string | null;
  actions: Array<{ id: string; deviceId: string | null }>;
  warning?: string;
}

export interface S1ActionSuccessResult<TData> {
  ok: true;
  status: 200 | 502;
  data: TData;
}

function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 2_000);
}

function formatDispatchError(err: unknown): string {
  return `SentinelOne action dispatch failed: ${truncateError(err)}`;
}

export async function getActiveS1IntegrationForOrg(orgId: string): Promise<S1ActiveIntegration | null> {
  const [integration] = await db
    .select({
      id: s1Integrations.id,
      orgId: s1Integrations.orgId,
      name: s1Integrations.name,
      lastSyncAt: s1Integrations.lastSyncAt,
      lastSyncStatus: s1Integrations.lastSyncStatus,
      lastSyncError: s1Integrations.lastSyncError
    })
    .from(s1Integrations)
    .where(and(eq(s1Integrations.orgId, orgId), eq(s1Integrations.isActive, true)))
    .limit(1);

  return integration ?? null;
}

export async function executeS1IsolationForOrg(params: {
  orgId: string;
  integrationId: string;
  requestedBy: string;
  deviceIds: string[];
  isolate: boolean;
}): Promise<S1ActionErrorResult | S1ActionSuccessResult<S1IsolateActionData>> {
  const requestedDeviceIds = Array.from(new Set(params.deviceIds));
  const accessibleDevices = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.orgId, params.orgId), inArray(devices.id, requestedDeviceIds)));
  const accessibleDeviceIds = new Set(accessibleDevices.map((device) => device.id));
  const inaccessibleDeviceIds = requestedDeviceIds.filter((deviceId) => !accessibleDeviceIds.has(deviceId));

  if (accessibleDeviceIds.size === 0) {
    return {
      ok: false,
      status: 403,
      error: 'No requested devices are in accessible organization scope',
      details: {
        requestedDeviceIds,
        inaccessibleDeviceIds
      }
    };
  }

  const agents = await db
    .select({
      deviceId: s1Agents.deviceId,
      s1AgentId: s1Agents.s1AgentId
    })
    .from(s1Agents)
    .where(
      and(
        eq(s1Agents.integrationId, params.integrationId),
        inArray(s1Agents.deviceId, Array.from(accessibleDeviceIds))
      )
    );

  const mappedDeviceIds = new Set(agents.map((agent) => agent.deviceId).filter((value): value is string => typeof value === 'string'));
  const unmappedAccessibleDeviceIds = Array.from(accessibleDeviceIds).filter((deviceId) => !mappedDeviceIds.has(deviceId));

  if (agents.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'No SentinelOne agent mappings found for requested devices',
      details: {
        requestedDeviceIds,
        inaccessibleDeviceIds,
        unmappedAccessibleDeviceIds
      }
    };
  }

  const uniqueAgentIds = Array.from(new Set(agents.map((row) => row.s1AgentId)));
  let providerActionId: string | null = null;
  let providerRaw: unknown = null;
  let warning: string | undefined;
  let status: 'in_progress' | 'failed' = 'failed';
  let errorText: string | null = null;
  let httpStatus: 200 | 502 = 200;

  try {
    const dispatch = await dispatchS1Isolation(params.integrationId, uniqueAgentIds, params.isolate);
    providerActionId = dispatch.providerActionId;
    providerRaw = dispatch.raw;

    if (providerActionId) {
      status = 'in_progress';
      await scheduleS1ActionPoll().catch((error) => {
        console.error('[s1-actions] Failed to schedule action poll:', error);
      });
    } else {
      warning = NO_ACTIVITY_ID_WARNING;
      errorText = NO_ACTIVITY_ID_WARNING;
    }
  } catch (error) {
    warning = formatDispatchError(error);
    errorText = warning;
    providerRaw = { error: warning };
    httpStatus = 502;
  }

  const actionRows = await db
    .insert(s1Actions)
    .values(
      agents.map((row) => ({
        orgId: params.orgId,
        deviceId: row.deviceId,
        requestedBy: params.requestedBy,
        action: params.isolate ? 'isolate' : 'unisolate',
        payload: {
          integrationId: params.integrationId,
          s1AgentId: row.s1AgentId,
          providerResponse: providerRaw
        },
        status,
        providerActionId,
        error: errorText
      }))
    )
    .returning({ id: s1Actions.id, deviceId: s1Actions.deviceId });

  return {
    ok: true,
    status: httpStatus,
    data: {
      requestedDeviceIds,
      inaccessibleDeviceIds,
      unmappedAccessibleDeviceIds,
      requestedDevices: requestedDeviceIds.length,
      mappedAgents: uniqueAgentIds.length,
      providerActionId,
      actions: actionRows,
      warning
    }
  };
}

export async function executeS1ThreatActionForOrg(params: {
  orgId: string;
  integrationId: string;
  requestedBy: string;
  action: S1ThreatAction;
  threatIds: string[];
}): Promise<S1ActionErrorResult | S1ActionSuccessResult<S1ThreatActionData>> {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const internalIds = params.threatIds.filter((id) => uuidPattern.test(id));
  const externalIds = params.threatIds;
  const matchCondition: SQL = internalIds.length > 0
    ? (or(inArray(s1Threats.id, internalIds), inArray(s1Threats.s1ThreatId, externalIds)) as SQL)
    : inArray(s1Threats.s1ThreatId, externalIds);

  const matchedThreats = await db
    .select({
      id: s1Threats.id,
      s1ThreatId: s1Threats.s1ThreatId,
      deviceId: s1Threats.deviceId
    })
    .from(s1Threats)
    .where(
      and(
        eq(s1Threats.integrationId, params.integrationId),
        eq(s1Threats.orgId, params.orgId),
        matchCondition
      )
    );

  if (matchedThreats.length === 0) {
    return {
      ok: false,
      status: 404,
      error: 'No matching SentinelOne threats found'
    };
  }

  const matchedRequestedIds = new Set<string>();
  for (const threat of matchedThreats) {
    matchedRequestedIds.add(threat.id);
    matchedRequestedIds.add(threat.s1ThreatId);
  }
  const unmatchedThreatIds = params.threatIds.filter((id) => !matchedRequestedIds.has(id));
  const matchedThreatIds = Array.from(new Set(matchedThreats.map((threat) => threat.s1ThreatId)));

  let providerActionId: string | null = null;
  let providerRaw: unknown = null;
  let warning: string | undefined;
  let status: 'in_progress' | 'failed' = 'failed';
  let errorText: string | null = null;
  let httpStatus: 200 | 502 = 200;

  try {
    const dispatch = await dispatchS1ThreatAction(params.integrationId, params.action, matchedThreatIds);
    providerActionId = dispatch.providerActionId;
    providerRaw = dispatch.raw;

    if (providerActionId) {
      status = 'in_progress';
      await scheduleS1ActionPoll().catch((error) => {
        console.error('[s1-actions] Failed to schedule action poll:', error);
      });
    } else {
      warning = NO_ACTIVITY_ID_WARNING;
      errorText = NO_ACTIVITY_ID_WARNING;
    }
  } catch (error) {
    warning = formatDispatchError(error);
    errorText = warning;
    providerRaw = { error: warning };
    httpStatus = 502;
  }

  const actionRows = await db
    .insert(s1Actions)
    .values(
      matchedThreats.map((threat) => ({
        orgId: params.orgId,
        deviceId: threat.deviceId,
        requestedBy: params.requestedBy,
        action: `threat_${params.action}`,
        payload: {
          integrationId: params.integrationId,
          threatId: threat.id,
          s1ThreatId: threat.s1ThreatId,
          providerResponse: providerRaw
        },
        status,
        providerActionId,
        error: errorText
      }))
    )
    .returning({ id: s1Actions.id, deviceId: s1Actions.deviceId });

  return {
    ok: true,
    status: httpStatus,
    data: {
      action: params.action,
      requestedThreats: params.threatIds.length,
      matchedThreats: matchedThreatIds.length,
      matchedThreatIds,
      unmatchedThreatIds,
      providerActionId,
      actions: actionRows,
      warning
    }
  };
}
