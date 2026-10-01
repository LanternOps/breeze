/**
 * What the LEGACY code path resolves for one surface — computed by calling the
 * legacy functions themselves (no re-implementation): resolveLlmConfig,
 * resolveWireModel, getLlmBillingSourceForOrg, mergeScriptPolicies,
 * mergeAgentPolicies/normalizeAgentPolicy, the Task 1 pickers,
 * resolveDefaultModel, resolveReviewerDefaultModel, isPricedModel, and the
 * surfaces' transport builders buildAnthropicClient / buildClaudeSdkChildEnv
 * (where legacy refuses a catalog partner).
 *
 * The CALLER must route the DB reads those functions make to the fixture
 * (see parity.test.ts) and set process.env via withFixtureEnv.
 */
import { resolveReviewerDefaultModel } from '../../../config/env';
import { mergeAgentPolicies, normalizeAgentPolicy } from '../../aiAgents/effectivePolicy';
import { isPricedModel } from '../../aiCostTracker';
import { resolveDefaultModel } from '../../aiModel';
import {
  buildAnthropicClient,
  getLlmBillingSourceForOrg,
  LlmUnavailableError,
  resolveLlmConfig,
  resolveWireModel,
  type ResolvedLlmConfig,
} from '../../llm/llmConfigResolver';
import { mergeScriptPolicies, type ScriptPolicyMergeInput } from '../../scriptProposals/policy';
import { buildClaudeSdkChildEnv } from '../../streamingSessionManager';
import { legacyAgentModel, legacyExtensionModel, legacyOfficeChatModel, legacyReviewerModel } from '../legacySurfaceModels';
import type { LegacyAgentRow } from '../legacyProjection';
import { PARTNER_DEFAULT_UNVERIFIED, type ParityFixture, type ParityQuery, type SurfaceUse } from './harness';

export async function withFixtureEnv<T>(env: ParityFixture['env'], fn: () => Promise<T>): Promise<T> {
  const keys = ['ANTHROPIC_MODEL', 'BREEZE_AI_SCRIPT_REVIEWER_MODEL', 'WORKSPACE_CONTENT_LLM_MODEL'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const unavailable = (reason: string): SurfaceUse => ({ outcome: 'unavailable', reason });

function scriptPolicyRow(id: string, orgId: string | null, reviewerModel: string | null): ScriptPolicyMergeInput {
  return {
    id, orgId, proposingEnabled: true, unattendedAllowed: false, unattendedEnabled: false,
    maxUnattendedRiskTier: null, unattendedAllowedClasses: null, maxUnattendedPerHour: null,
    protectedResources: null, reviewerModel,
  } as unknown as ScriptPolicyMergeInput;
}

function agentPolicyRow(row: LegacyAgentRow) {
  return normalizeAgentPolicy({
    enabled: true, mode: 'shadow', model: row.model, toolAllowlist: [], protectedResources: {},
    limits: {}, triggers: {}, recipients: {}, actAssets: {}, instructions: null, cooldownSeconds: 900,
  } as Parameters<typeof normalizeAgentPolicy>[0]);
}

type UsableConfig = Exclude<ResolvedLlmConfig, { source: 'unavailable' }>;

/**
 * Runs the surface's REAL legacy transport builder. A catalog partner is
 * refused there (it throws), which the oracle reports as `catalog_refused`;
 * any throw for a non-catalog config is an oracle bug and propagates.
 */
function refusedByTransport(resolved: UsableConfig, build: (r: UsableConfig) => unknown): boolean {
  try {
    build(resolved);
    return false;
  } catch (error) {
    if (resolved.source === 'partner' && resolved.endpoint.kind === 'catalog') return true;
    throw error;
  }
}

/**
 * ai_agents (aiAgents/runLoop.ts `env: buildClaudeSdkChildEnv(usableLlm)`): the
 * run loop builds the SDK child env with no egress proxy URL, and
 * buildClaudeSdkChildEnv (streamingSessionManager.ts) throws for a catalog
 * endpoint without one. The run loop never calls resolveWireModel.
 */
const agentTransport = (r: UsableConfig) => buildClaudeSdkChildEnv(r, {});

/**
 * extension_content (extensionAi.ts): resolveWireModel first, then
 * buildAnthropicClient(usable), which throws LlmUnavailableError for any
 * non-anthropic partner endpoint (llmConfigResolver.ts).
 */
const extensionTransport = (r: UsableConfig) => buildAnthropicClient(r);

function use(
  resolved: UsableConfig,
  model: string,
  opts: {
    funding?: 'platform' | 'partner_key';
    transportBeforeWire?: (r: UsableConfig) => unknown;
    transportAfterWire?: (r: UsableConfig) => unknown;
  } = {},
): SurfaceUse {
  if (opts.transportBeforeWire && refusedByTransport(resolved, opts.transportBeforeWire)) {
    return unavailable('catalog_refused');
  }
  let wire: { model: string };
  try {
    wire = resolveWireModel(resolved, model);
  } catch (error) {
    if (error instanceof LlmUnavailableError) return unavailable('model_unverified');
    throw error;
  }
  if (opts.transportAfterWire && refusedByTransport(resolved, opts.transportAfterWire)) {
    return unavailable('catalog_refused');
  }
  return {
    outcome: 'ok',
    destination: resolved.source === 'partner' ? { connectionId: resolved.configId } : 'platform',
    funding: opts.funding ?? (resolved.source === 'partner' ? 'partner_key' : 'platform'),
    logicalModel: model,
    wireModel: wire.model,
  };
}

export async function legacySurfaceUse(fixture: ParityFixture, query: ParityQuery): Promise<SurfaceUse> {
  const s = fixture.snapshot;
  if (query.kind === 'surface' && query.surface === 'patch_test') {
    const model = resolveDefaultModel(); // aiPatchTestRunner: new Anthropic() on the ambient platform key
    return { outcome: 'ok', destination: 'platform', funding: 'platform', logicalModel: model, wireModel: model };
  }
  const resolved = await resolveLlmConfig(s.partnerId);
  if (resolved.source === 'unavailable') {
    // resolveLlmConfig's model_unverified keys on the partner DEFAULT alone
    // (resolveCatalogEndpoint); relabel it so it can't be confused with a
    // per-surface resolveWireModel failure (`model_unverified` from use()).
    return unavailable(resolved.reason === 'model_unverified' ? PARTNER_DEFAULT_UNVERIFIED : resolved.reason);
  }

  if (query.kind === 'session') {
    const session = s.liveSessions.find((x) => x.id === query.sessionId)!;
    return use(resolved, session.model);
  }

  if (query.kind === 'agent') {
    const partnerRow = s.agents.find((a) => a.orgId === null && a.kind === query.agentKind)!;
    const orgRow = s.agents.find((a) => a.orgId === query.orgId && a.kind === query.agentKind) ?? null;
    const raw = Object.hasOwn(s.budgetAllowedModels, query.orgId) ? s.budgetAllowedModels[query.orgId] : undefined;
    // Load step copied from effectivePolicy.ts:523 (the merge itself is called for real).
    const allowedModels = Array.isArray(raw) ? (raw as string[]) : null;
    const merged = mergeAgentPolicies(agentPolicyRow(partnerRow), orgRow ? agentPolicyRow(orgRow) : null, { allowedModels });
    return use(resolved, legacyAgentModel(merged.effective.model, resolved.model), { transportBeforeWire: agentTransport });
  }

  switch (query.surface) {
    case 'chat':
    case 'helper':
    case 'script_builder':
    case 'office_ticket':
    case 'catalog_enrichment':
      return use(resolved, resolved.model);
    case 'office_chat':
      return use(resolved, legacyOfficeChatModel(s.officeAllowedModels[query.orgId] ?? [], resolved.model));
    case 'script_reviewer': {
      const partner = s.partnerReviewerModel !== null ? scriptPolicyRow('partner-policy', null, s.partnerReviewerModel) : null;
      const orgModel = Object.hasOwn(s.orgReviewerModels, query.orgId) ? s.orgReviewerModels[query.orgId] : undefined;
      const org = orgModel !== undefined ? scriptPolicyRow('org-policy', query.orgId, orgModel) : null;
      const policy = mergeScriptPolicies(partner, org);
      const funding = await getLlmBillingSourceForOrg(query.orgId);
      return use(resolved, legacyReviewerModel(policy.reviewerModel, resolveReviewerDefaultModel(process.env)), { funding });
    }
    case 'extension_content': {
      const model = legacyExtensionModel(undefined, process.env);
      if (!isPricedModel(model)) return unavailable('unpriced_model');
      return use(resolved, model, { transportAfterWire: extensionTransport });
    }
  }
  // patch_test returned above; TS does not narrow query.surface through the compound guard.
  throw new Error(`parity oracle: unhandled surface ${query.surface}`);
}
