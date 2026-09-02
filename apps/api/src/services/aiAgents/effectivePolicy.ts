import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import {
  AI_AGENT_LIMIT_DEFAULTS,
  AI_AGENT_POLICY_SNAPSHOT_VERSION,
  aiAgentActAssetsSchema,
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
  | 'actAssets'
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
    actAssets: aiAgentActAssetsSchema.parse(row.actAssets ?? {}),
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
    actAssets: 'partner',
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
  if (!org) {
    return {
      // Wave 6 PR 4 follow-up (#3828) — `anomalyEnabled` is the one field on
      // this policy that must NOT pass through from the partner baseline
      // unchanged, even in this "no org override at all" fast path. Every
      // other field's tighten-only contract is "org can only narrow the
      // partner's ceiling", which correctly degrades to "use the partner's
      // value" when there is no org row to narrow with. A binary opt-in
      // safety gate is different: if the partner baseline alone could turn
      // it on, every org under that partner would start receiving
      // anomaly-triggered runs the moment the partner flips one row, with
      // zero action at any individual org. So this ignores partner.triggers.
      // anomalyEnabled here and always resolves to `undefined` (falsy) —
      // see AiAgentTriggers.anomalyEnabled's docstring for the full account,
      // and the general-merge branch below for the "org override present"
      // case (same rule: only the org's OWN value is ever consulted).
      //
      // P2-4 Task A6 (#4191) — `ticketAutonomousWrites` gets the identical
      // treatment, for the identical reason: a partner-wide baseline row
      // must never blanket-enable unattended ticket writes for every org
      // under it. See AiAgentTriggers.ticketAutonomousWrites's docstring.
      effective: {
        ...partner,
        triggers: { ...partner.triggers, anomalyEnabled: undefined, ticketAutonomousWrites: undefined },
      },
      provenance,
    };
  }

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
      // Wave 6 PR 3 (#3828, Task 4) — same tighten-only intersection as the
      // other narrowing lists above. Unenforced by the admission subscriber
      // this PR (`AiAgentTriggers.ticketCategories`'s docstring), but merged
      // here anyway so the effective policy never silently drops a value an
      // operator configured, ahead of whichever task wires evaluation in.
      ticketCategories: intersectOptional(partner.triggers.ticketCategories, org.triggers.ticketCategories),
      ticketPriorities: intersectOptional(
        partner.triggers.ticketPriorities,
        org.triggers.ticketPriorities,
      ) as AiAgentPolicy['triggers']['ticketPriorities'],
      respectMaintenanceWindows:
        partner.triggers.respectMaintenanceWindows || org.triggers.respectMaintenanceWindows,
      // Wave 6 PR 4 follow-up (#3828) — deliberately NOT tighten-only
      // intersection/AND, and deliberately NOT "either layer true → true".
      // Reads ONLY the org's own override: `partner.triggers.anomalyEnabled`
      // is never consulted in either direction. See this field's docstring
      // on AiAgentTriggers (packages/shared) and the `!org` branch above
      // (same rule applied to the "no org override" fast path).
      anomalyEnabled: org.triggers.anomalyEnabled === true ? true : undefined,
      // P2-4 Task A6 (#4191) — same org-row-only opt-in as anomalyEnabled
      // directly above: reads ONLY org.triggers.ticketAutonomousWrites,
      // partner.triggers.ticketAutonomousWrites is never consulted in
      // either direction. See AiAgentTriggers.ticketAutonomousWrites's
      // docstring (packages/shared) for the full rationale.
      ticketAutonomousWrites: org.triggers.ticketAutonomousWrites === true ? true : undefined,
    }, 'merged'),
    recipients: pick('recipients', {
      userIds: union(partner.recipients.userIds, org.recipients.userIds),
      roleIds: union(partner.recipients.roleIds, org.recipients.roleIds),
    }, 'merged'),
    // Tighten-only, same as toolAllowlist: an org may only NARROW the
    // partner's authorized script set, never add a script the partner never
    // opted in — an org intersecting against an empty partner baseline stays
    // empty, which is exactly "run_script never act-eligible" (Task 6).
    //
    // supervisedActionKeys (wave 5 Part B, #3827) mirrors scriptIds exactly,
    // for the same reason: an org may only narrow the partner's authorized
    // POLICY_DECIDABLE_TIER3 key set, never widen it. `?? []` on both sides is
    // load-bearing, not defensive — the field is optional on AiAgentActAssets
    // because AI_AGENT_POLICY_SNAPSHOT_VERSION was NOT bumped for it (v3 is
    // already tolerant), so a partner or org row written before this deploy
    // has no `supervisedActionKeys` key in its stored `actAssets` jsonb at
    // all. `normalizeAgentPolicy` fills the shared-schema default of `[]`
    // for any row read through it, but `mergeAgentPolicies` is also exported
    // pure and callable directly with a hand-built AiAgentPolicy (as several
    // tests here do), so the merge itself must not assume the key is present.
    actAssets: pick('actAssets', {
      scriptIds: intersect(partner.actAssets.scriptIds, org.actAssets.scriptIds),
      supervisedActionKeys: intersect(
        partner.actAssets.supervisedActionKeys ?? [],
        org.actAssets.supervisedActionKeys ?? [],
      ),
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
