/**
 * Learned networks E6 (#12369, spec §8.2): which agents may run a guarded discovery scan.
 *
 * Eligible means: assigned to the site, online, not ephemeral (Quick Support), not parked in the partner's
 * holding org, agent token not suspended, an `is_current` membership for an allowed fingerprint
 * (`learned_network_devices.gateway_id`, never merely the network), `network_attachments_confirmed_at` inside
 * the freshness window, and at or above the guarded command's minimum agent version. Attachment is filtered
 * in SQL; version is prefiltered in SQL (a superset) and decided exactly with `agentSupportsGuardedCommand`.
 * The same rule serves requested, pinned and AI-tool targets.
 *
 * Callers hold a DB context (worker phases, the AI tool's db phase) and the shared site lock.
 */
import { and, asc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import {
  GUARDED_COMMAND_TYPES, type IneligibleReason, type NoAgentReason,
} from '@breeze/shared';
import { db } from '../../db';
import { devices, learnedNetworkDevices } from '../../db/schema';
import { notParkedDeviceCondition } from '../unassignedPool/selectorPredicate';
import { COMMAND_MIN_AGENT_VERSION, agentSupportsGuardedCommand } from '../commandMinVersion';
import { NETWORK_ATTACHMENT_FRESHNESS_MS } from './constants';

/** Upper bound on site candidates per dispatch; same cap as unrestricted selection. */
const MAX_GUARDED_AGENT_CANDIDATES = 500;

type GuardedCommandFamily = keyof typeof GUARDED_COMMAND_TYPES;

export type EligibleAgent = {
  deviceId: string; agentId: string; hostname: string | null; displayName: string | null;
  /** Allowed fingerprints it is behind now, ascending. */
  gatewayIds: string[];
};

function freshAttachmentsCondition(): SQL {
  return sql`${devices.networkAttachmentsConfirmedAt} >= now() - make_interval(secs => ${NETWORK_ATTACHMENT_FRESHNESS_MS / 1000}::double precision)`;
}

/** [major, minor, patch] of the family's minimum, or null when it has none (fails closed). */
function minimumVersionParts(commandType: GuardedCommandFamily): [number, number, number] | null {
  const min = COMMAND_MIN_AGENT_VERSION[GUARDED_COMMAND_TYPES[commandType]];
  const m = min ? /^(\d+)\.(\d+)\.(\d+)/.exec(min) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Prefilter for `agentSupportsGuardedCommand`, so the candidate cap is applied after the version cut, not before.
 * It passes every version with three numeric parts of at most 9 digits each that the exact check accepts (and a
 * few it does not, such as `1.2.3.4`). Each part is bounded and the triple must end at a non-digit, so the int cast
 * can never overflow: an agent-reported version is free text, and one bad value must not fail the site's query. A
 * part longer than 9 digits (or zero-padded past 9) is filtered out, which fails closed.
 */
function versionPrefilterCondition(parts: [number, number, number]): SQL {
  const [maj, min, patch] = parts;
  return sql`case when ${devices.agentVersion} ~ '^\\s*\\d{1,9}\\.\\d{1,9}\\.\\d{1,9}(\\D|$)'
    then string_to_array(substring(${devices.agentVersion} from '^\\s*(\\d{1,9}\\.\\d{1,9}\\.\\d{1,9})(?:\\D|$)'), '.')::int[]
         >= array[${maj}::int, ${min}::int, ${patch}::int]
    else false end`;
}

function deviceLabel(row: { displayName: string | null; hostname: string | null; deviceId: string }): string {
  return row.displayName?.trim() || row.hostname?.trim() || row.deviceId;
}

/** The site's eligible agents, ordered by device id, at most `limit`. Empty `allowedGatewayIds`: none. */
export async function loadEligibleGuardedAgents(input: {
  orgId: string; siteId: string; allowedGatewayIds: readonly string[];
  commandType: GuardedCommandFamily; limit?: number;
}): Promise<EligibleAgent[]> {
  const parts = minimumVersionParts(input.commandType);
  if (input.allowedGatewayIds.length === 0 || !parts) return [];

  const rows = await db
    .select({
      deviceId: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      agentVersion: devices.agentVersion,
      gatewayIds: sql<string[]>`array_agg(distinct ${learnedNetworkDevices.gatewayId}::text order by ${learnedNetworkDevices.gatewayId}::text)::text[]`,
    })
    .from(devices)
    .innerJoin(learnedNetworkDevices, and(
      eq(learnedNetworkDevices.deviceId, devices.id),
      eq(learnedNetworkDevices.orgId, devices.orgId),
      eq(learnedNetworkDevices.isCurrent, true),
      inArray(learnedNetworkDevices.gatewayId, [...input.allowedGatewayIds]),
    ))
    .where(and(
      eq(devices.orgId, input.orgId),
      eq(devices.siteId, input.siteId),
      eq(devices.status, 'online'),
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
      isNull(devices.agentTokenSuspendedAt),
      isNotNull(devices.agentId),
      freshAttachmentsCondition(),
      versionPrefilterCondition(parts),
    ))
    .groupBy(devices.id)
    .orderBy(asc(devices.id))
    .limit(input.limit ?? MAX_GUARDED_AGENT_CANDIDATES);

  return rows
    .filter((row): row is typeof row & { agentId: string } =>
      Boolean(row.agentId) && agentSupportsGuardedCommand(input.commandType, row.agentVersion))
    .map((row) => ({
      deviceId: row.deviceId,
      agentId: row.agentId,
      hostname: row.hostname,
      displayName: row.displayName,
      gatewayIds: row.gatewayIds,
    }));
}

/**
 * Whether one named agent (by device or agent id) may run the scan, and why not. Reads the device with no org
 * filter so a device of another org reads as `not_found`; another org's names are never echoed (`not_found` and
 * `parked` label with the id the caller passed). Needs-update is decided before not-on-network because an agent
 * below the guard version may not report attachments at all.
 */
export async function explainGuardedAgent(input: {
  orgId: string; siteId: string; allowedGatewayIds: readonly string[];
  commandType: GuardedCommandFamily; deviceId?: string; agentId?: string;
}): Promise<{ eligible: true; agent: EligibleAgent } | { eligible: false; reason: IneligibleReason; label: string }> {
  const passedId = input.deviceId ?? input.agentId ?? '';
  if (!input.deviceId && !input.agentId) return { eligible: false, reason: 'not_found', label: passedId };

  const [device] = await db
    .select({
      deviceId: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      displayName: devices.displayName,
      orgId: devices.orgId,
      siteId: devices.siteId,
      status: devices.status,
      isEphemeral: devices.isEphemeral,
      tokenSuspended: sql<boolean>`${devices.agentTokenSuspendedAt} is not null`,
      agentVersion: devices.agentVersion,
      fresh: sql<boolean>`coalesce(${freshAttachmentsCondition()}, false)`,
      parked: sql<boolean>`not (${notParkedDeviceCondition()})`,
    })
    .from(devices)
    .where(input.deviceId ? eq(devices.id, input.deviceId) : eq(devices.agentId, input.agentId!))
    .limit(1);

  if (!device) return { eligible: false, reason: 'not_found', label: passedId };
  if (device.parked) return { eligible: false, reason: 'parked', label: passedId };
  if (device.orgId !== input.orgId || !device.agentId) return { eligible: false, reason: 'not_found', label: passedId };

  const label = deviceLabel(device);
  if (device.isEphemeral) return { eligible: false, reason: 'ephemeral', label };
  if (device.siteId !== input.siteId) return { eligible: false, reason: 'other_site', label };
  // B2 has no reason for a suspended token; such an agent cannot take a command, so it reads as offline.
  if (device.status !== 'online' || device.tokenSuspended) return { eligible: false, reason: 'offline', label };
  if (!agentSupportsGuardedCommand(input.commandType, device.agentVersion)) {
    return { eligible: false, reason: 'needs_update', label };
  }
  if (!device.fresh || input.allowedGatewayIds.length === 0) return { eligible: false, reason: 'not_on_network', label };

  const memberships = await db
    .select({ gatewayId: learnedNetworkDevices.gatewayId })
    .from(learnedNetworkDevices)
    .where(and(
      eq(learnedNetworkDevices.deviceId, device.deviceId),
      eq(learnedNetworkDevices.orgId, input.orgId),
      eq(learnedNetworkDevices.isCurrent, true),
      inArray(learnedNetworkDevices.gatewayId, [...input.allowedGatewayIds]),
    ))
    .orderBy(asc(learnedNetworkDevices.gatewayId));
  if (memberships.length === 0) return { eligible: false, reason: 'not_on_network', label };

  return {
    eligible: true,
    agent: {
      deviceId: device.deviceId,
      agentId: device.agentId,
      hostname: device.hostname,
      displayName: device.displayName,
      gatewayIds: [...new Set(memberships.map((m) => m.gatewayId))].sort(),
    },
  };
}

/**
 * Why a gated site has no eligible agent. Called only after `loadEligibleGuardedAgents` found none, so an agent
 * that is on the network failed only on its version.
 */
export async function explainNoEligibleAgent(input: {
  orgId: string; siteId: string; allowedGatewayIds: readonly string[];
  commandType: GuardedCommandFamily;
}): Promise<NoAgentReason> {
  const allowed = input.allowedGatewayIds.length > 0
    ? sql`exists (
        select 1 from ${learnedNetworkDevices}
         where ${learnedNetworkDevices.deviceId} = ${devices.id}
           and ${learnedNetworkDevices.orgId} = ${devices.orgId}
           and ${learnedNetworkDevices.isCurrent}
           and ${inArray(learnedNetworkDevices.gatewayId, [...input.allowedGatewayIds])})`
    : sql`false`;
  const [summary] = await db
    .select({
      agents: sql<number>`count(*)::int`,
      anyOnNetwork: sql<boolean>`coalesce(bool_or(coalesce(${freshAttachmentsCondition()}, false) and ${allowed}), false)`,
      versions: sql<Array<string | null>>`coalesce(array_agg(distinct ${devices.agentVersion}), '{}')::text[]`,
    })
    .from(devices)
    .where(and(
      eq(devices.orgId, input.orgId),
      eq(devices.siteId, input.siteId),
      eq(devices.status, 'online'),
      eq(devices.isEphemeral, false),
      notParkedDeviceCondition(),
      isNull(devices.agentTokenSuspendedAt),
      isNotNull(devices.agentId),
    ));

  if (!summary || summary.agents === 0) return 'none_online';
  if (summary.anyOnNetwork) return 'agents_need_update';
  if (summary.versions.every((v) => !agentSupportsGuardedCommand(input.commandType, v))) return 'agents_need_update';
  return 'none_on_network';
}
