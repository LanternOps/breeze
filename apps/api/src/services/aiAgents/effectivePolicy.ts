import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_POLICY_SNAPSHOT_VERSION,
  aiAgentLimitsSchema,
  aiAgentProtectedResourcesSchema,
  aiAgentRecipientsSchema,
  aiAgentTriggersSchema,
  minAgentMode,
  type AiAgentKind,
  type AiAgentLimits,
  type AiAgentPolicy,
  type AiAgentPolicyProvenance,
  type AiAgentPolicySnapshot,
} from '@breeze/shared';
import { envFlag } from '../../config/env';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
// Direct module imports, NOT the ../../db/schema barrel: this module now sits
// on the intent-release path (wave 3b), and pulling the barrel would force
// every partial-mock unit test of that path to stub the entire schema surface.
import { aiAgents, type AiAgentRow } from '../../db/schema/aiAgents';
import { aiBudgets } from '../../db/schema/ai';
import { organizations } from '../../db/schema/orgs';
import type { AuthContext } from '../../middleware/auth';

type PolicyRowFields = Pick<
  AiAgentRow,
  | 'enabled'
  | 'mode'
  | 'model'
  | 'toolAllowlist'
  | 'protectedResources'
  | 'limits'
  | 'triggers'
  | 'recipients'
  | 'instructions'
  | 'cooldownSeconds'
>;

export function normalizeAgentPolicy(row: PolicyRowFields): AiAgentPolicy {
  return {
    enabled: row.enabled,
    mode: row.mode,
    model: row.model ?? null,
    toolAllowlist: Array.isArray(row.toolAllowlist) ? [...row.toolAllowlist] : [],
    protectedResources: aiAgentProtectedResourcesSchema.parse(row.protectedResources ?? {}),
    limits: aiAgentLimitsSchema.parse(row.limits ?? {}),
    triggers: aiAgentTriggersSchema.parse(row.triggers ?? {}),
    recipients: aiAgentRecipientsSchema.parse(row.recipients ?? {}),
    instructions: row.instructions ?? null,
    cooldownSeconds: row.cooldownSeconds,
  };
}

const union = (a: string[], b: string[]): string[] => Array.from(new Set([...a, ...b]));
const intersect = (a: string[], b: string[]): string[] => a.filter((value) => b.includes(value));
const intersectOptional = (a?: string[], b?: string[]): string[] | undefined =>
  a && b ? intersect(a, b) : a ?? b;

function mergeLimits(partnerLimits: AiAgentLimits, orgLimits: AiAgentLimits): AiAgentLimits {
  const partner = partnerLimits as unknown as Record<keyof AiAgentLimits, number | boolean>;
  const org = orgLimits as unknown as Record<keyof AiAgentLimits, number | boolean>;
  const merged: Partial<Record<keyof AiAgentLimits, number | boolean>> = {};

  for (const key of Object.keys(AI_AGENT_LIMIT_DEFAULTS) as Array<keyof AiAgentLimits>) {
    const partnerValue = partner[key];
    const orgValue = org[key];
    if (typeof partnerValue === 'boolean' && typeof orgValue === 'boolean') {
      merged[key] = partnerValue && orgValue;
      continue;
    }
    // mergeAgentPolicies is exported and pure, so a later caller can hand it a
    // sparse object. Math.min(NaN, x) is NaN, and every downstream
    // `spend > limit` comparison against NaN is false — the limit would stop
    // applying. Fall back to whichever side is a real number, then the default.
    const partnerNumber = Number(partnerValue);
    const orgNumber = Number(orgValue);
    const partnerFinite = Number.isFinite(partnerNumber);
    const orgFinite = Number.isFinite(orgNumber);
    merged[key] = partnerFinite && orgFinite
      ? Math.min(partnerNumber, orgNumber)
      : partnerFinite
        ? partnerNumber
        : orgFinite
          ? orgNumber
          : (AI_AGENT_LIMIT_DEFAULTS as unknown as Record<string, number>)[key]!;
  }

  return merged as AiAgentLimits;
}

function instructionBlocks(partner: string | null, org: string | null): string | null {
  const parts: string[] = [];
  if (partner) parts.push(`[partner guidance]\n${partner}\n[/partner guidance]`);
  if (org) parts.push(`[organization guidance]\n${org}\n[/organization guidance]`);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function partnerProvenance(): AiAgentPolicyProvenance {
  return {
    enabled: 'partner',
    mode: 'partner',
    model: 'partner',
    toolAllowlist: 'partner',
    protectedResources: 'partner',
    limits: 'partner',
    triggers: 'partner',
    recipients: 'partner',
    instructions: 'partner',
    cooldownSeconds: 'partner',
  };
}

/**
 * Tighten-only policy merge. The organization row is only an override and can
 * never enable or widen beyond the partner baseline. Pure: no I/O or clock.
 */
export function mergeAgentPolicies(
  partner: AiAgentPolicy,
  org: AiAgentPolicy | null,
  opts: { allowedModels: string[] | null },
): { effective: AiAgentPolicy; provenance: AiAgentPolicyProvenance } {
  const provenance = partnerProvenance();
  if (!org) return { effective: partner, provenance };

  const pick = <K extends keyof AiAgentPolicy>(
    key: K,
    value: AiAgentPolicy[K],
    source: AiAgentPolicyProvenance[K],
  ): AiAgentPolicy[K] => {
    provenance[key] = source;
    return value;
  };

  const mode = minAgentMode(partner.mode, org.mode);
  // Fail CLOSED when the partner-governed list is absent. spec §5.1 admits the
  // org's model only when it is IN ai_budgets.allowedModels; a missing budget
  // row means there is no such list, so it cannot contain anything. Treating
  // null as "anything goes" inverted the tighten-only rule in exactly the
  // DEFAULT state — no ai_budgets row — letting an org override a model the
  // partner had deliberately pinned.
  const orgModelAllowed = org.model !== null
    && opts.allowedModels !== null
    && opts.allowedModels.includes(org.model);
  const instructionSource = partner.instructions && org.instructions
    ? 'merged'
    : org.instructions
      ? 'org'
      : 'partner';

  const effective: AiAgentPolicy = {
    enabled: pick(
      'enabled',
      partner.enabled && org.enabled,
      !partner.enabled ? 'partner' : !org.enabled ? 'org' : 'partner',
    ),
    mode: pick('mode', mode, mode === partner.mode ? 'partner' : 'org'),
    model: pick('model', orgModelAllowed ? org.model : partner.model, orgModelAllowed ? 'org' : 'partner'),
    toolAllowlist: pick('toolAllowlist', intersect(partner.toolAllowlist, org.toolAllowlist), 'merged'),
    protectedResources: pick('protectedResources', {
      services: union(partner.protectedResources.services, org.protectedResources.services),
      paths: union(partner.protectedResources.paths, org.protectedResources.paths),
      registryKeys: union(partner.protectedResources.registryKeys, org.protectedResources.registryKeys),
      deviceTags: union(partner.protectedResources.deviceTags, org.protectedResources.deviceTags),
    }, 'merged'),
    limits: pick('limits', mergeLimits(partner.limits, org.limits), 'merged'),
    triggers: pick('triggers', {
      alertSeverities: intersect(
        partner.triggers.alertSeverities,
        org.triggers.alertSeverities,
      ) as AiAgentPolicy['triggers']['alertSeverities'],
      alertRuleIds: intersectOptional(partner.triggers.alertRuleIds, org.triggers.alertRuleIds),
      siteIds: intersectOptional(partner.triggers.siteIds, org.triggers.siteIds),
      deviceGroupIds: intersectOptional(partner.triggers.deviceGroupIds, org.triggers.deviceGroupIds),
      deviceTags: intersectOptional(partner.triggers.deviceTags, org.triggers.deviceTags),
      respectMaintenanceWindows:
        partner.triggers.respectMaintenanceWindows || org.triggers.respectMaintenanceWindows,
    }, 'merged'),
    recipients: pick('recipients', {
      userIds: union(partner.recipients.userIds, org.recipients.userIds),
      roleIds: union(partner.recipients.roleIds, org.recipients.roleIds),
    }, 'merged'),
    instructions: pick(
      'instructions',
      instructionBlocks(partner.instructions, org.instructions),
      instructionSource,
    ),
    cooldownSeconds: pick(
      'cooldownSeconds',
      Math.max(partner.cooldownSeconds, org.cooldownSeconds),
      org.cooldownSeconds > partner.cooldownSeconds ? 'org' : 'partner',
    ),
  };

  return { effective, provenance };
}

export type ResolvedAgent = AiAgentPolicySnapshot;

/**
 * Authorized loader. The request context reads the organization and its org
 * policy first. Only the baseline read is elevated, and it is pinned to the
 * partner ID obtained through the caller-authorized organization row.
 */
export async function resolveEffectiveAgent(
  auth: AuthContext,
  orgId: string,
  kind: AiAgentKind,
): Promise<ResolvedAgent | null> {
  if (!auth.canAccessOrg(orgId)) {
    throw new HTTPException(403, { message: 'Organization not accessible' });
  }

  return resolveEffectiveAgentInner(orgId, kind);
}

/**
 * Trigger-path variant of resolveEffectiveAgent. There is no caller
 * AuthContext when an alert or a queue job wakes an agent — the "authority"
 * is the trigger wiring itself, which runs under a system DB context. This
 * MUST only ever be called from run admission (runService) and release
 * tooling; it performs the same org->partner pinning as the authorized
 * loader, minus the canAccessOrg gate.
 */
export async function resolveEffectiveAgentSystem(
  orgId: string,
  kind: AiAgentKind,
): Promise<ResolvedAgent | null> {
  // Already system-scoped (the common case: a BullMQ worker that opened its own
  // system context): read straight through. Re-entering would open a SECOND
  // pooled connection while the first is still held, for no visibility gain —
  // same skip branch, same reason, as readWithPartnerAxisVisibility.
  if (getCurrentDbAccessContext()?.scope === 'system') {
    return resolveEffectiveAgentInner(orgId, kind);
  }

  // Load-bearing: a bare system wrapper is a no-op inside an ambient request
  // context, so exit that context before establishing system visibility.
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => resolveEffectiveAgentInner(orgId, kind)));
}

async function resolveEffectiveAgentInner(
  orgId: string,
  kind: AiAgentKind,
): Promise<ResolvedAgent | null> {
  const [org] = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  // The trigger path treats a missing organization as an error, not a skip.
  if (!org) throw new HTTPException(404, { message: 'Organization not found' });

  const [orgRow] = await db
    .select()
    .from(aiAgents)
    .where(and(
      eq(aiAgents.orgId, orgId),
      eq(aiAgents.kind, kind),
      isNull(aiAgents.disabledAt),
    ))
    .limit(1);

  const [partnerRow] = await readWithPartnerAxisVisibility(() =>
    db
      .select()
      .from(aiAgents)
      .where(and(
        eq(aiAgents.partnerId, org.partnerId),
        isNull(aiAgents.orgId),
        eq(aiAgents.kind, kind),
        isNull(aiAgents.disabledAt),
      ))
      .limit(1));

  // No partner baseline means the org override cannot self-enable the agent.
  if (!partnerRow) return null;

  const [budget] = await db
    .select({ allowedModels: aiBudgets.allowedModels })
    .from(aiBudgets)
    .where(eq(aiBudgets.orgId, orgId))
    .limit(1);
  const allowedModels = Array.isArray(budget?.allowedModels)
    ? budget.allowedModels as string[]
    : null;

  const merged = mergeAgentPolicies(
    normalizeAgentPolicy(partnerRow),
    orgRow ? normalizeAgentPolicy(orgRow) : null,
    { allowedModels },
  );
  // Call-time read: same reason as the guardrail gate — one normalization,
  // and a kill switch a test can actually flip.
  const effective = envFlag('BREEZE_AI_AGENTS_ENABLED', false)
    ? merged.effective
    : { ...merged.effective, enabled: false };

  return {
    schemaVersion: AI_AGENT_POLICY_SNAPSHOT_VERSION,
    agentId: partnerRow.id,
    kind,
    effective,
    provenance: merged.provenance,
    resolvedAt: new Date().toISOString(),
  };
}
