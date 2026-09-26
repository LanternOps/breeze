import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { topologyGloballyDisabled } from '../../config/env';
import { db } from '../../db';
import { organizations, partners, topologyCollectionSources, topologyMonitoringPolicies, users } from '../../db/schema';
import { evaluateCapabilityContinuationForState } from '../partnerTrust';
import { getPermissionAuthorityVersion } from '../permissions';
import type { TopologyRequestContext } from './access';
import { resolveTopologyFlags } from './flags';
import { TopologyOperationError } from './operationErrors';

/**
 * M3-D13 live authority boundary, applied to the routed-trace path.
 *
 * M1 checks the requester once, at acceptance; delivery then re-derives only
 * the ORIGIN's authority. A trace sends up to 60 TTL-limited probes from a
 * customer machine, so its requester authority is frozen at acceptance and
 * re-derived at every later boundary — enqueue (dispatch), both delivery
 * transports (claim revalidation) and result publication — so a revoked
 * requester, a changed permission set, a disabled feature or a withdrawn agent
 * capability fences the run independently of sweeper timing.
 *
 * The frozen record holds only what a later boundary compares against; the
 * permission set itself is re-verified through its authority version, so an
 * unchanged version means the permissions verified at acceptance still hold.
 */
/** The agent capability a routed trace requires; advertised only where a native trace transport opens. */
export const TOPOLOGY_TRACE_CAPABILITY = 'network_trace';

export const topologyTraceRequesterAuthoritySchema = z.object({
  version: z.literal(1),
  userId: z.uuid(),
  authEpoch: z.number().int(),
  mfaEpoch: z.number().int(),
  permissionVersion: z.string().min(1).max(256),
  orgId: z.uuid().nullable(),
  partnerId: z.uuid().nullable(),
}).strict();
export type TopologyTraceRequesterAuthority = z.infer<typeof topologyTraceRequesterAuthoritySchema>;

export type TopologyTraceAuthorityDenial =
  | 'authority_unavailable'
  | 'requester_changed'
  | 'permission_changed'
  | 'diagnostics_disabled'
  | 'trace_capability_withdrawn'
  | 'policy_disarmed'
  | 'trust_denied';

type Reader = Pick<typeof db, 'select'>;

async function readRequester(reader: Reader, userId: string) {
  const [row] = await reader
    .select({
      id: users.id,
      status: users.status,
      authEpoch: users.authEpoch,
      mfaEpoch: users.mfaEpoch,
      orgId: users.orgId,
      partnerId: users.partnerId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Freeze the requester's current authority for a new trace run. Reads through
 * the caller's own (request) context: the requester can always see their own
 * user row, and no second pooled connection is opened under the request.
 */
export async function freezeTopologyTraceRequester(
  ctx: Pick<TopologyRequestContext, 'auth'>,
  deps: { reader?: Reader; permissionVersion?: (userId: string) => Promise<string | null> } = {},
): Promise<TopologyTraceRequesterAuthority> {
  const userId = ctx.auth.user.id;
  const user = await readRequester(deps.reader ?? db, userId);
  if (!user || user.status !== 'active') throw new TopologyOperationError('permission_changed', 403);
  const version = await (deps.permissionVersion ?? getPermissionAuthorityVersion)(userId);
  if (version === null) throw new TopologyOperationError('topology_authority_unavailable', 503);
  return topologyTraceRequesterAuthoritySchema.parse({
    version: 1,
    userId,
    authEpoch: user.authEpoch,
    mfaEpoch: user.mfaEpoch,
    permissionVersion: version,
    orgId: user.orgId ?? null,
    partnerId: user.partnerId ?? null,
  });
}

function explicitOverride(settings: unknown, key: 'materialization' | 'diagnostics'): boolean | undefined {
  const flags = (settings as { topologyFeatureFlags?: Record<string, unknown> } | null)?.topologyFeatureFlags;
  return typeof flags?.[key] === 'boolean' ? (flags[key] as boolean) : undefined;
}

/**
 * Diagnostics flags read through the SUPPLIED reader, never a second
 * connection. The agent-heartbeat claim context cannot see the partner row
 * (agent contexts carry no partner access); there a partner-level setting is
 * deferred to the enqueue and publication fences, which pass
 * `requirePartnerFlags` — but an org-level or global disable still fences.
 */
async function diagnosticsEnabled(reader: Reader, orgId: string, requirePartnerFlags: boolean): Promise<boolean> {
  if (topologyGloballyDisabled()) return false;
  const [org] = await reader
    .select({ partnerId: organizations.partnerId, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return false;
  const [partner] = await reader
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, org.partnerId))
    .limit(1);
  if (partner) {
    const flags = resolveTopologyFlags({ partnerSettings: partner.settings, orgSettings: org.settings });
    return flags.materialization && flags.diagnostics;
  }
  if (requirePartnerFlags) return false;
  return explicitOverride(org.settings, 'materialization') !== false && explicitOverride(org.settings, 'diagnostics') !== false;
}

/**
 * Partner-trust `device_execute` verdict read through the SUPPLIED reader.
 *
 * The enqueue and publication fences run inside a system-context transaction
 * they already hold. `deviceExecuteAllowedForOrg` resolves the partner and its
 * trust row in their OWN system contexts — a second pooled connection taken
 * while the first is held, the #6671 wedge shape (postgres-js has no acquire
 * timeout). Both rows are visible to the system-context reader, so read them
 * there and decide purely. No denial audit is written from inside the fence:
 * the run's own `authority_trust_denied` failure reason records it.
 */
async function trustAllowsDiagnostics(reader: Reader, orgId: string): Promise<boolean> {
  const [org] = await reader.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const [row] = org
    ? await reader
      .select({ trustState: partners.trustState, probationEnrollments: partners.probationEnrollments })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .limit(1)
    : [];
  const decision = evaluateCapabilityContinuationForState(
    'device_execute',
    { partnerId: org?.partnerId ?? '', orgId, commandType: 'network_diagnostic' },
    row ?? null,
  );
  return decision.allow;
}

const capabilityEnvelopeSchema = z.object({
  capabilities: z.array(z.object({ name: z.string(), version: z.number(), supported: z.boolean() }).passthrough()),
}).passthrough();

async function originAdvertisesTrace(
  reader: Reader,
  run: { orgId: string; siteId: string; originSnapshot: { deviceId: string; producerEpoch: string } },
): Promise<boolean> {
  const [root] = await reader
    .select({ currentBaseline: topologyCollectionSources.currentBaseline })
    .from(topologyCollectionSources)
    .where(and(
      eq(topologyCollectionSources.orgId, run.orgId),
      eq(topologyCollectionSources.siteId, run.siteId),
      eq(topologyCollectionSources.producerKind, 'agent'),
      eq(topologyCollectionSources.producerId, run.originSnapshot.deviceId),
      eq(topologyCollectionSources.protocol, 'envelope'),
      eq(topologyCollectionSources.producerEpoch, run.originSnapshot.producerEpoch),
      isNull(topologyCollectionSources.revokedAt),
    ))
    .limit(1);
  const envelope = capabilityEnvelopeSchema.safeParse(root?.currentBaseline);
  return envelope.success && envelope.data.capabilities.some(
    (capability) => capability.name === TOPOLOGY_TRACE_CAPABILITY && capability.version === 1 && capability.supported,
  );
}

/**
 * M3-D13 generalized: the same frozen requester authority is carried by every
 * run that executes without a live human request behind each boundary — a
 * routed trace (requester = the human) and a scheduled policy occurrence
 * (requester = the policy's arming actor). Aliases keep the trace call sites.
 */
export const topologyRequesterAuthoritySchema = topologyTraceRequesterAuthoritySchema;
export const freezeTopologyRequesterAuthority = freezeTopologyTraceRequester;

export type TopologyTraceAuthorityInput = {
  reader: Reader;
  run: {
    orgId: string;
    siteId: string;
    requesterId: string;
    requesterAuthority: unknown;
    originSnapshot: { deviceId: string; producerEpoch: string };
    recipeId?: string;
    policyId?: string | null;
    policyRevision?: bigint | null;
  };
  /** Only a routed trace needs the agent's trace capability (default: required). */
  requireTraceCapability?: boolean;
  /** Delivery claims already evaluate partner trust generically; the other fences ask here. */
  checkTrust?: boolean;
  /** Fail closed when the partner flag row is not visible to `reader`. */
  requirePartnerFlags?: boolean;
  permissionVersion?: (userId: string) => Promise<string | null>;
  trustAllowed?: (orgId: string, commandType: string, userId: string) => Promise<boolean>;
};

/** Null when the run may proceed; otherwise the fence reason. Never throws for a denial. */
export async function revalidateTopologyTraceAuthority(
  input: TopologyTraceAuthorityInput,
): Promise<TopologyTraceAuthorityDenial | null> {
  const frozen = topologyTraceRequesterAuthoritySchema.safeParse(input.run.requesterAuthority);
  if (!frozen.success || frozen.data.userId !== input.run.requesterId) return 'authority_unavailable';
  const authority = frozen.data;

  const user = await readRequester(input.reader, authority.userId);
  if (
    !user ||
    user.status !== 'active' ||
    user.authEpoch !== authority.authEpoch ||
    user.mfaEpoch !== authority.mfaEpoch ||
    (user.orgId ?? null) !== authority.orgId ||
    (user.partnerId ?? null) !== authority.partnerId
  ) {
    return 'requester_changed';
  }

  const version = await (input.permissionVersion ?? getPermissionAuthorityVersion)(authority.userId);
  if (version === null) return 'authority_unavailable';
  if (version !== authority.permissionVersion) return 'permission_changed';

  if (!await diagnosticsEnabled(input.reader, input.run.orgId, input.requirePartnerFlags ?? false)) {
    return 'diagnostics_disabled';
  }
  if ((input.requireTraceCapability ?? true) && !await originAdvertisesTrace(input.reader, input.run)) return 'trace_capability_withdrawn';
  if (input.run.policyId) {
    const [policy] = await input.reader
      .select({ enabled: topologyMonitoringPolicies.enabled, revision: topologyMonitoringPolicies.revision, deletedAt: topologyMonitoringPolicies.deletedAt })
      .from(topologyMonitoringPolicies)
      .where(and(eq(topologyMonitoringPolicies.id, input.run.policyId), eq(topologyMonitoringPolicies.orgId, input.run.orgId), eq(topologyMonitoringPolicies.siteId, input.run.siteId)))
      .limit(1);
    if (!policy || !policy.enabled || policy.deletedAt !== null || policy.revision !== input.run.policyRevision) return 'policy_disarmed';
  }

  if (input.checkTrust) {
    const allowed = input.trustAllowed
      ? await input.trustAllowed(input.run.orgId, 'network_diagnostic', authority.userId)
      : await trustAllowsDiagnostics(input.reader, input.run.orgId);
    if (!allowed) return 'trust_denied';
  }
  return null;
}

/**
 * Whether a run carries a frozen requester authority that every boundary must
 * re-derive: a routed trace, a scheduled occurrence, and ANY run that froze one
 * at acceptance (an approved AI proposal, topology M4 Task 4). A run that
 * carries a frozen authority is always fenced on it — the record is never
 * decorative.
 */
export function runRequiresRequesterRevalidation(run: { recipeId: string; policyId?: string | null; requesterAuthority?: unknown }): boolean {
  return run.recipeId === 'trace_route' || !!run.policyId || (run.requesterAuthority !== null && run.requesterAuthority !== undefined);
}

export const revalidateTopologyRequesterAuthority = (input: Omit<TopologyTraceAuthorityInput, 'requireTraceCapability'>) =>
  revalidateTopologyTraceAuthority({ ...input, requireTraceCapability: input.run.recipeId === 'trace_route' });
