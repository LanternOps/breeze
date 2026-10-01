/**
 * What the LEGACY code path resolves for one surface — computed by calling the
 * legacy functions themselves (no re-implementation): resolveLlmConfig,
 * resolveWireModel, getLlmBillingSourceForOrg, mergeScriptPolicies,
 * mergeAgentPolicies/normalizeAgentPolicy, the Task 1 pickers,
 * resolveDefaultModel, resolveReviewerDefaultModel, isPricedModel.
 *
 * The CALLER must route the DB reads those functions make to the fixture
 * (see parity.test.ts) and set process.env via withFixtureEnv.
 */
import { resolveReviewerDefaultModel } from '../../../config/env';
import { mergeAgentPolicies, normalizeAgentPolicy } from '../../aiAgents/effectivePolicy';
import { isPricedModel } from '../../aiCostTracker';
import { resolveDefaultModel } from '../../aiModel';
import {
  getLlmBillingSourceForOrg,
  LlmUnavailableError,
  resolveLlmConfig,
  resolveWireModel,
  type ResolvedLlmConfig,
} from '../../llm/llmConfigResolver';
import { mergeScriptPolicies, type ScriptPolicyMergeInput } from '../../scriptProposals/policy';
import { legacyAgentModel, legacyExtensionModel, legacyOfficeChatModel, legacyReviewerModel } from '../legacySurfaceModels';
import type { LegacyAgentRow } from '../legacyProjection';
import type { ParityFixture, ParityQuery, SurfaceUse } from './harness';

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

function use(
  resolved: Exclude<ResolvedLlmConfig, { source: 'unavailable' }>,
  model: string,
  opts: { refuseCatalog?: boolean; funding?: 'platform' | 'partner_key' } = {},
): SurfaceUse {
  if (opts.refuseCatalog && resolved.source === 'partner' && resolved.endpoint.kind === 'catalog') {
    return unavailable('catalog_refused');
  }
  try {
    const wire = resolveWireModel(resolved, model);
    return {
      outcome: 'ok',
      destination: resolved.source === 'partner' ? { connectionId: resolved.configId } : 'platform',
      funding: opts.funding ?? (resolved.source === 'partner' ? 'partner_key' : 'platform'),
      logicalModel: model,
      wireModel: wire.model,
    };
  } catch (error) {
    if (error instanceof LlmUnavailableError) return unavailable('model_unverified');
    throw error;
  }
}

export async function legacySurfaceUse(fixture: ParityFixture, query: ParityQuery): Promise<SurfaceUse> {
  const s = fixture.snapshot;
  if (query.kind === 'surface' && query.surface === 'patch_test') {
    const model = resolveDefaultModel(); // aiPatchTestRunner: new Anthropic() on the ambient platform key
    return { outcome: 'ok', destination: 'platform', funding: 'platform', logicalModel: model, wireModel: model };
  }
  const resolved = await resolveLlmConfig(s.partnerId);
  if (resolved.source === 'unavailable') return unavailable(resolved.reason);

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
    return use(resolved, legacyAgentModel(merged.effective.model, resolved.model), { refuseCatalog: true });
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
      return use(resolved, model, { refuseCatalog: true });
    }
  }
  // patch_test returned above; TS does not narrow query.surface through the compound guard.
  throw new Error(`parity oracle: unhandled surface ${query.surface}`);
}
