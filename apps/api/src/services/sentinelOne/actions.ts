import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, organizations, s1Actions, s1Agents, s1Integrations, s1OrgMappings, s1Threats } from '../../db/schema';
import {
  dispatchS1Isolation,
  dispatchS1ThreatAction,
  scheduleS1ActionPoll
} from '../../jobs/s1Sync';
import { captureException } from '../sentry';
import { redactLogMessage } from '../logRedaction';
import { SentinelOneHttpError, type S1ThreatAction } from './client';
import { deviceIdSiteDenied } from '../aiToolsSiteScope';
import type { AuthContext } from '../../middleware/auth';

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
  status: 400 | 403 | 404 | 500;
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

export function truncateError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Redact before truncating/persisting. S1 bearer tokens go in headers, but an
  // error message can echo a Cookie/Authorization header; for a SentinelOneHttpError
  // the body lives on `.responseBody` (logged server-side), never on `.message`.
  return redactLogMessage(message).slice(0, 2_000);
}

function formatDispatchError(err: unknown): string {
  return `SentinelOne action dispatch failed: ${truncateError(err)}`;
}

/**
 * Log full failure detail to the SERVER-SIDE log only. For an upstream HTTP error
 * this includes the (redacted) `.responseBody` that we deliberately keep out of
 * the tenant-visible `s1_actions.error` column / action dispatch result. The
 * tenant-visible text is written separately via {@link truncateError}, which
 * reads only the body-free `.message`. Mirrors `logSyncFailureServerSide` in
 * jobs/s1Sync.ts but kept local to avoid a service→job import.
 */
export function logActionDispatchFailureServerSide(
  context: Record<string, unknown>,
  error: unknown
): void {
  if (error instanceof SentinelOneHttpError) {
    console.error(
      '[s1-actions] dispatch failed (upstream HTTP error)',
      JSON.stringify({
        ...context,
        status: error.status,
        responseBody: redactLogMessage(error.responseBody),
      })
    );
    return;
  }
  console.error(
    '[s1-actions] dispatch failed',
    JSON.stringify({
      ...context,
      error: redactLogMessage(error instanceof Error ? error.message : String(error)),
    })
  );
}

export async function getActiveS1IntegrationForOrg(orgId: string): Promise<S1ActiveIntegration | null> {
  // Step 1: Resolve org → partner_id.
  // s1_integrations is now partner-axis (legacyOrgId is often NULL after migration).
  const [orgRow] = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!orgRow) return null;

  // Steps 2 & 3 read partner-axis tables (s1_integrations, s1_org_mappings) gated
  // by breeze_has_partner_access(partner_id). An org-scoped caller's request DB
  // context has no partner access (accessiblePartnerIds = []), so those reads would
  // return 0 rows under RLS. The org lookup above (Step 1) IS the security gate —
  // it runs in the caller's context so org RLS ensures orgRow.partnerId belongs to a
  // partner the caller can see. After that gate, we escalate to system context for
  // the partner-axis reads. Pattern mirrors mobileDeviceBlocked.ts.
  const [integration] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      // Step 2: Fetch the partner's active integration.
      db
        .select({
          id: s1Integrations.id,
          partnerId: s1Integrations.partnerId,
          name: s1Integrations.name,
          lastSyncAt: s1Integrations.lastSyncAt,
          lastSyncStatus: s1Integrations.lastSyncStatus,
          lastSyncError: s1Integrations.lastSyncError
        })
        .from(s1Integrations)
        .where(and(eq(s1Integrations.partnerId, orgRow.partnerId), eq(s1Integrations.isActive, true)))
        .limit(1)
    )
  );

  if (!integration) return null;

  const [mappingRow] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      // Step 3 (defense-in-depth): Confirm the org has at least one s1_org_mappings row
      // under this integration. Prevents acting on orgs the partner hasn't mapped.
      db
        .select({ id: s1OrgMappings.id })
        .from(s1OrgMappings)
        .where(and(eq(s1OrgMappings.integrationId, integration.id), eq(s1OrgMappings.orgId, orgId)))
        .limit(1)
    )
  );

  if (!mappingRow) return null;

  // Preserve the caller's orgId in the return value — callers use this field as
  // "the org I'm operating on"; the integration itself is partner-scoped.
  return {
    id: integration.id,
    orgId,
    name: integration.name,
    lastSyncAt: integration.lastSyncAt,
    lastSyncStatus: integration.lastSyncStatus,
    lastSyncError: integration.lastSyncError,
  };
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
  // Default to 'completed' (untracked) instead of 'failed' when dispatch succeeds but no activityId
  let status: 'in_progress' | 'completed' | 'failed' = 'failed';
  let errorText: string | null = null;
  let httpStatus: 200 | 502 = 200;

  try {
    const dispatch = await dispatchS1Isolation(params.integrationId, uniqueAgentIds, params.isolate);
    providerActionId = dispatch.providerActionId;
    providerRaw = dispatch.raw;

    if (providerActionId) {
      status = 'in_progress';
      try {
        await scheduleS1ActionPoll();
      } catch (pollError) {
        console.error('[s1-actions] Failed to schedule action poll:', pollError);
        captureException(pollError);
        warning = `Action dispatched but status polling could not be scheduled: ${truncateError(pollError)}`;
      }
    } else {
      // Dispatch succeeded but S1 did not return a trackable activity ID
      warning = NO_ACTIVITY_ID_WARNING;
      status = 'completed';
    }
  } catch (error) {
    // Capture full detail (incl. redacted upstream body) server-side BEFORE we
    // build the body-free tenant-visible warning — otherwise the diagnostic
    // `.responseBody` is dropped entirely on a failed isolate dispatch.
    logActionDispatchFailureServerSide(
      { orgId: params.orgId, integrationId: params.integrationId },
      error
    );
    warning = formatDispatchError(error);
    errorText = warning;
    providerRaw = { error: warning };
    httpStatus = 502;
    status = 'failed';
  }

  let actionRows: Array<{ id: string; deviceId: string | null }> = [];
  try {
    actionRows = await db
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
  } catch (dbError) {
    console.error('[s1-actions] Failed to persist action records after dispatch:', dbError);
    captureException(dbError);
    const dbWarning = providerActionId
      ? `Action dispatched (providerActionId: ${providerActionId}) but tracking records could not be saved: ${truncateError(dbError)}`
      : `Failed to persist action records: ${truncateError(dbError)}`;

    // If dispatch itself also failed, propagate as error
    if (httpStatus === 502) {
      return {
        ok: false,
        status: 500,
        error: warning ? `${warning}; ${dbWarning}` : dbWarning
      };
    }

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
        actions: [],
        warning: warning ? `${warning}; ${dbWarning}` : dbWarning
      }
    };
  }

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

/**
 * Threat ids are NOT device ids, so the declarative `deviceArgs` gate in
 * aiTools.ts cannot see what a threat action will actually touch (#6096 #1).
 * Resolve every matched threat back to its device and report the ones the
 * caller may not reach. A threat with no resolvable device fails CLOSED for a
 * restricted caller — `deviceIdSiteDenied` makes the same call for an unknown
 * device id.
 *
 * Returns the s1 threat ids that are out of scope; `[]` for an unrestricted
 * caller (and for callers that forward no `auth` at all, e.g. the HTTP route,
 * which is already gated by `requirePermission` + its own site checks).
 */
async function outOfScopeThreatIds(
  auth: AuthContext,
  threats: Array<{ s1ThreatId: string; deviceId: string | null }>,
): Promise<string[]> {
  if (!auth.allowedDeviceIds && !auth.allowedSiteIds && !auth.canAccessSite) return [];
  const denied: string[] = [];
  const decided = new Map<string, boolean>();
  for (const threat of threats) {
    if (!threat.deviceId) {
      denied.push(threat.s1ThreatId);
      continue;
    }
    let isDenied = decided.get(threat.deviceId);
    if (isDenied === undefined) {
      isDenied = await deviceIdSiteDenied(auth, threat.deviceId);
      decided.set(threat.deviceId, isDenied);
    }
    if (isDenied) denied.push(threat.s1ThreatId);
  }
  return denied;
}

export async function executeS1ThreatActionForOrg(params: {
  orgId: string;
  integrationId: string;
  requestedBy: string;
  action: S1ThreatAction;
  threatIds: string[];
  /**
   * Forwarded by the AI-tool path so the batch can be checked against the
   * caller's exact-device / site allowlists. Omitted by callers that gate
   * elsewhere; omitting it narrows nothing and widens nothing.
   */
  auth?: AuthContext;
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

  // Device axis. A partial dispatch to a machine the caller may not reach is
  // exactly the outcome this exists to prevent, so the WHOLE batch is refused
  // rather than silently narrowed — same contract as remediate_vulnerability's
  // finding_device_mismatch.
  if (params.auth) {
    const denied = await outOfScopeThreatIds(params.auth, matchedThreats);
    if (denied.length > 0) {
      return {
        ok: false,
        status: 403,
        error:
          `${denied.length} of ${matchedThreats.length} matched threat(s) are on devices outside your device access. `
          + 'Nothing was dispatched.',
        details: { deniedThreatIds: denied },
      };
    }
  }

  let providerActionId: string | null = null;
  let providerRaw: unknown = null;
  let warning: string | undefined;
  let status: 'in_progress' | 'completed' | 'failed' = 'failed';
  let errorText: string | null = null;
  let httpStatus: 200 | 502 = 200;

  try {
    const dispatch = await dispatchS1ThreatAction(params.integrationId, params.action, matchedThreatIds);
    providerActionId = dispatch.providerActionId;
    providerRaw = dispatch.raw;

    if (providerActionId) {
      status = 'in_progress';
      try {
        await scheduleS1ActionPoll();
      } catch (pollError) {
        console.error('[s1-actions] Failed to schedule action poll:', pollError);
        captureException(pollError);
        warning = `Action dispatched but status polling could not be scheduled: ${truncateError(pollError)}`;
      }
    } else {
      // Dispatch succeeded but S1 did not return a trackable activity ID
      warning = NO_ACTIVITY_ID_WARNING;
      status = 'completed';
    }
  } catch (error) {
    // Capture full detail (incl. redacted upstream body) server-side BEFORE we
    // build the body-free tenant-visible warning — otherwise the diagnostic
    // `.responseBody` is dropped entirely on a failed threat-action dispatch.
    logActionDispatchFailureServerSide(
      { orgId: params.orgId, integrationId: params.integrationId },
      error
    );
    warning = formatDispatchError(error);
    errorText = warning;
    providerRaw = { error: warning };
    httpStatus = 502;
    status = 'failed';
  }

  let actionRows: Array<{ id: string; deviceId: string | null }> = [];
  try {
    actionRows = await db
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
  } catch (dbError) {
    console.error('[s1-actions] Failed to persist action records after dispatch:', dbError);
    captureException(dbError);
    const dbWarning = providerActionId
      ? `Action dispatched (providerActionId: ${providerActionId}) but tracking records could not be saved: ${truncateError(dbError)}`
      : `Failed to persist action records: ${truncateError(dbError)}`;

    if (httpStatus === 502) {
      return {
        ok: false,
        status: 500,
        error: warning ? `${warning}; ${dbWarning}` : dbWarning
      };
    }

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
        actions: [],
        warning: warning ? `${warning}; ${dbWarning}` : dbWarning
      }
    };
  }

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
