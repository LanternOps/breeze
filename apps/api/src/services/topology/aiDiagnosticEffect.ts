/**
 * Topology M4 Task 4 / amendment M4-D3 (#6000): the deterministic EFFECT of one
 * AI-proposed diagnostic, as the action-intent effect digest pins it.
 *
 * Three separated stages, never mixed:
 *
 *   1. SCOPED LOADING — `loadTopologyDiagnosticPlanningSnapshotForScope`
 *      (originEligibility.ts) reads the planning snapshot for an explicit
 *      (org, site) with NO caller authority, so the digest can be recomputed
 *      identically by the system-scoped release paths and by the requester's
 *      own RLS context at acceptance.
 *   2. PURE EXTRACTION — `extractTopologyDiagnosticEffect` compiles the plan
 *      with the ordinary M1 compiler and projects the parts that decide WHAT
 *      EXECUTES into canonical material. The compiler embeds `now` and random
 *      step/destination ids (diagnosticPlanner.ts), so a digest over its raw
 *      output would never reproduce; the projection drops every timestamp and
 *      replaces ids with their ordinal positions.
 *   3. LIVE AUTHORIZATION — never here. aiDiagnosticApproval.ts authorizes the
 *      requester, the fresh approver factor and the flags at release.
 *
 * What the material pins: the materialized proposal itself (site, subject,
 * recipe/version, the EXPLICIT origin device/context/family — an auto-selected
 * origin is written into the proposal at creation, shown in the approval text
 * and pinned here — and the immutable proposal expiry), the site's settings
 * revision, template versions and template revisions, the origin's identity
 * (device, agent, node, binding, interface id/epoch/key, source, producer
 * epoch), every destination's target (configured target id + revision +
 * definition, observed gateway/resolver address/zone/port), every step's
 * method/bounds and its destination ordinal, the limits and the compiler's
 * refusal reasons.
 *
 * What it deliberately does NOT pin: the graph revision (label/layout churn is
 * not an executable change), the collection sequence and evidence/snapshot ids
 * (provenance counters that advance on every unchanged publication — the
 * content they version is pinned directly), and all times. A change to any
 * pinned input — a moved or re-bound origin, a changed route/gateway, a revised
 * target, a settings or template change, a different eligible origin — makes
 * the release recompute differ and the release fails closed (`content_changed`)
 * without ever re-selecting an origin.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  topologyDiagnosticSubjectSchema,
  topologyRecipeIdSchema,
  topologyRevisionSchema,
  type CreateTopologyDiagnosticRequest,
  type TopologyDiagnosticPlan,
  type TopologyScope,
} from '@breeze/shared';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';

import type { Database } from '../../db';
import { sites } from '../../db/schema';
import { compileTopologyDiagnosticPlan } from './diagnosticPlanner';
import type { DiagnosticPlanningSnapshot } from './diagnosticTypes';
import { loadTopologyDiagnosticPlanningSnapshotForScope } from './originEligibility';
import { TopologyOperationError } from './operationErrors';

export const DIAGNOSE_CONNECTIVITY_TOOL = 'diagnose_connectivity';

/** How long an approved-but-unreleased proposal stays executable. Immutable once written. */
export const TOPOLOGY_AI_PROPOSAL_TTL_MS = 15 * 60_000;

const uuid = z.string().guid();
/** Same bound as the shared topology UTF-8 key (1..255 bytes). */
const contextKeySchema = z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 255, 'Maximum 255 UTF-8 bytes');

/**
 * The MATERIALIZED proposal — exactly what `action_intents.arguments` holds
 * (immutable by trigger) and what the approver approved. The origin, context,
 * family and expiry are written by the server at proposal time; a model value
 * for any of them is only a request the server may confirm or refuse.
 */
export const topologyDiagnosticProposalSchema = z.object({
  site_id: uuid,
  subject: topologyDiagnosticSubjectSchema,
  recipe_id: topologyRecipeIdSchema,
  recipe_version: z.literal(1),
  graph_revision: topologyRevisionSchema,
  origin_device_id: uuid,
  context_key: contextKeySchema,
  family: z.enum(['ipv4', 'ipv6']),
  proposal_expires_at: z.string().datetime(),
}).strict();
export type TopologyDiagnosticProposal = z.infer<typeof topologyDiagnosticProposalSchema>;

/**
 * Release material a release path verified against the pinned digest and
 * hands to the handler (never model input, never an auth claim). Carries no
 * credential and no plan the handler could execute without re-deriving it.
 */
export type VerifiedTopologyDiagnostic = {
  scope: TopologyScope;
  proposal: TopologyDiagnosticProposal;
  effectDigest: string;
  expiresAt: string;
};

export function topologyDiagnosticRequestFromProposal(proposal: TopologyDiagnosticProposal): CreateTopologyDiagnosticRequest {
  return {
    recipeId: proposal.recipe_id,
    recipeVersion: 1,
    subject: proposal.subject,
    graphRevision: proposal.graph_revision,
    originDeviceId: proposal.origin_device_id,
    contextKey: proposal.context_key,
    family: proposal.family,
  };
}

/** Timestamp- and id-free projection of what the compiled plan executes. */
function executableEffect(plan: TopologyDiagnosticPlan) {
  const ordinal = new Map(plan.destinations.map((destination, index) => [destination.id, index]));
  const ref = (id: string | null) => (id === null ? null : ordinal.get(id) ?? -1);
  const { sequence: _sequence, ...origin } = plan.origin;
  return {
    recipeId: plan.recipeId,
    recipeVersion: plan.recipeVersion,
    scope: plan.scope,
    subject: plan.subject,
    origin,
    family: plan.family,
    settingsRevision: plan.settingsRevision,
    templateVersions: plan.templateVersions,
    destinations: plan.destinations.map(({ target }) => {
      if (target.kind === 'observed_gateway') {
        const { evidenceId: _evidence, ...rest } = target;
        return rest;
      }
      if (target.kind === 'observed_resolver') {
        const { evidenceId: _evidence, ...rest } = target;
        return rest;
      }
      return target;
    }),
    steps: plan.steps.map((step) => {
      const { id: _id, destinationId, ...rest } = step;
      const projected: Record<string, unknown> = { ...rest, destination: ref(destinationId) };
      if ('resolverDestinationIds' in rest) projected.resolverDestinationIds = rest.resolverDestinationIds.map(ref);
      return projected;
    }),
    limits: plan.limits,
    reasons: plan.reasons,
  };
}

/** Canonical effect material (stage 2). Pure; any key order, any clock, any ids. */
export function topologyDiagnosticEffectMaterial(
  proposal: TopologyDiagnosticProposal,
  plan: TopologyDiagnosticPlan,
  templateRevisions: Record<string, string>,
): string {
  return canonicalizeArguments({
    v: 1,
    tool: DIAGNOSE_CONNECTIVITY_TOOL,
    proposal,
    templateRevisions,
    effect: executableEffect(plan),
  });
}

/**
 * Stage 2: compile the pinned proposal against a loaded snapshot and project
 * its material. Refuses (throws) when the pinned origin is not the eligible
 * candidate the compiler picks, when the site cannot plan it, or when the
 * compiled plan carries a refusal reason — an approval can only ever pin an
 * executable plan.
 */
export function extractTopologyDiagnosticEffect(
  scope: TopologyScope,
  proposal: TopologyDiagnosticProposal,
  snapshot: DiagnosticPlanningSnapshot,
  clock: { now: Date; newId: () => string } = { now: new Date(), newId: randomUUID },
): { plan: TopologyDiagnosticPlan; material: string } {
  if (proposal.site_id !== scope.siteId) throw new TopologyOperationError('topology_site_mismatch', 409);
  // A pristine site has no binding yet; inject only the explicit scope (as planTopologyDiagnostic does).
  const settings = { ...snapshot.settings, binding: snapshot.settings.binding ?? ({ orgId: scope.orgId } as NonNullable<typeof snapshot.settings.binding>) };
  const plan = compileTopologyDiagnosticPlan({
    request: topologyDiagnosticRequestFromProposal(proposal),
    snapshot: { ...snapshot, settings },
    now: clock.now,
    newId: clock.newId,
  });
  if (plan.reasons.length > 0) throw new TopologyOperationError('diagnostic_not_plannable', 409, plan.reasons[0]!);
  if (
    plan.scope.orgId !== scope.orgId || plan.scope.siteId !== scope.siteId
    || plan.origin.deviceId !== proposal.origin_device_id
    || plan.origin.contextKey !== proposal.context_key
    || plan.family !== proposal.family
  ) {
    throw new TopologyOperationError('origin_changed', 409);
  }
  return { plan, material: topologyDiagnosticEffectMaterial(proposal, plan, snapshot.settings.templateRevisions) };
}

export type TopologyDiagnosticEffectResolution =
  | { kind: 'material'; material: string; verified: Omit<VerifiedTopologyDiagnostic, 'effectDigest'> }
  | { kind: 'missing_arg' }
  | { kind: 'target_absent' };

/**
 * The effect-digest resolver (effectDigest.ts) — stages 1 and 2, auth-free.
 * The caller runs it system-scoped (creation transaction, both release paths);
 * the site's org comes from the stored site row, never from the arguments.
 * Anything that cannot be planned now resolves `target_absent`, which the
 * creation path refuses (the digest is REQUIRED for this tool) and the release
 * paths see as a changed effect.
 */
export async function resolveTopologyDiagnosticEffect(
  args: Record<string, unknown>,
  database: Database,
  now: Date = new Date(),
): Promise<TopologyDiagnosticEffectResolution> {
  const parsed = topologyDiagnosticProposalSchema.safeParse(args);
  if (!parsed.success) return { kind: 'missing_arg' };
  const proposal = parsed.data;
  const [site] = await database
    .select({ id: sites.id, orgId: sites.orgId })
    .from(sites)
    .where(eq(sites.id, proposal.site_id))
    .limit(1);
  if (!site) return { kind: 'target_absent' };
  const scope = { orgId: site.orgId, siteId: site.id };
  try {
    const snapshot = await loadTopologyDiagnosticPlanningSnapshotForScope(scope, topologyDiagnosticRequestFromProposal(proposal), { now: now.getTime() });
    const { material } = extractTopologyDiagnosticEffect(scope, proposal, snapshot, { now, newId: randomUUID });
    return { kind: 'material', material, verified: { scope, proposal, expiresAt: proposal.proposal_expires_at } };
  } catch (error) {
    if (error instanceof TopologyOperationError) return { kind: 'target_absent' };
    throw error;
  }
}
