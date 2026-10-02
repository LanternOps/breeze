/**
 * The chat / agent model pickers' read model (AI model registry W05, #7603,
 * spec §11 "Chat composer"). It judges every candidate with W03's own rule
 * table through the resolver's exported context, so the picker can never
 * offer a model the turn claim would refuse — with one deliberate
 * exception: an offering whose ONLY failing rule is `permission_required`
 * is listed disabled, "requires <role>". The turn claim re-checks
 * everything; this is a convenience, never the gate.
 *
 * Tenancy: every candidate is loaded with `loadOfferingCandidate(id,
 * partnerId)` (null for another partner's offering or connection) AND judged
 * by `checkEligibility`, whose first rule is ownership — so an id from a
 * permitted list, a stale session or a forged `current` can never surface
 * another partner's offering.
 */
import type { AiModelChoiceDto, AiModelChoicesDto } from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { LlmUnavailableError } from '../llm/llmUnavailableError';
import { getEffectiveAssignment, isPermitted } from './assignments';
import { loadOfferingCandidate, type LoadedCandidate } from './candidateLoader';
import { checkEligibility, type EligibilityContext } from './eligibility';
import { listOfferings } from './offerings';
import { rolesGrantingPermission } from './permissionRoles';
import { ensurePartnerCutover } from './registryCutover';
import { defaultOptionsFor, eligibilityContextFor, pickerOptionSupport, unavailableMessage } from './resolveModel';
import { defaultTransport, type DispatchTransport } from './transport';

/**
 * Every permitted id is judged (W04 caps a permitted list at 200); only an
 * unbounded `all` set is capped, after the default and the current choice
 * (Codex review finding 17: a cap BEFORE the eligibility filter could hide
 * every usable model behind ineligible old ones).
 */
export const MAX_MODEL_CHOICE_CANDIDATES = 200;

function inSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

export async function listModelChoices(input: {
  partnerId: string;
  orgId: string | null;
  userId: string | null;
  surface: 'chat' | 'ai_agents';
  /**
   * Chat: the session's stamped choice — `ai_sessions.offering_id` /
   * `options` as `stampSessionBinding` wrote them, i.e. the offering and the
   * APPLIED (clamped, merged) options the last turn ran with, the fallen-back
   * default when that turn fell back. That is what the composer starts from.
   * Echoed back as-is; it is only ever LISTED when it passes the same gates
   * as every other candidate.
   */
  current?: AiModelChoicesDto['current'];
}): Promise<AiModelChoicesDto> {
  if (!(await ensurePartnerCutover(input.partnerId))) {
    throw new LlmUnavailableError(unavailableMessage('registry_unavailable'), 'registry_unavailable');
  }
  const assignment = await inSystem(() => getEffectiveAssignment({
    partnerId: input.partnerId, orgId: input.orgId, surface: input.surface, role: 'default',
  }));
  // Agent policies are configuration (origin 'policy'): the per-turn lock does not apply.
  const allowUserChoice = input.surface === 'ai_agents' ? true : assignment.allowUserChoice;
  const head = {
    surface: input.surface,
    allowUserChoice,
    defaultOfferingId: assignment.defaultOfferingId,
    current: input.current ?? null,
  };
  if (!allowUserChoice) return { ...head, choices: [] };

  const permittedIds = assignment.permitted.kind === 'list'
    ? assignment.permitted.offeringIds
    // Not filtered by connection health: checkEligibility below drops a
    // disconnected / unusable connection (connection_unavailable).
    : (await inSystem(() => listOfferings(input.partnerId, { enabledOnly: true }))).map((o) => o.id);
  // The default is always reachable (resolveModel skips the permitted check
  // for it). The session's current choice is kept visible ahead of the cap,
  // but only when the assignment still permits it: a user-origin pick of a
  // non-permitted, non-default offering is refused `not_permitted`.
  const currentId = input.current?.offeringId ?? null;
  const currentListable = currentId !== null
    && (currentId === assignment.defaultOfferingId || isPermitted(assignment.permitted, currentId));
  const ids = [...new Set([
    ...(assignment.defaultOfferingId ? [assignment.defaultOfferingId] : []),
    ...(currentListable ? [currentId] : []),
    ...permittedIds,
  ])].slice(0, MAX_MODEL_CHOICE_CANDIDATES);

  const transport = defaultTransport(input.surface);
  const ctx = await eligibilityContextFor({
    partnerId: input.partnerId, orgId: input.orgId, userId: input.userId, surface: input.surface, transport,
  });
  const asIfPermitted: EligibilityContext = { ...ctx, userHoldsPermission: () => true };
  const roleNames = new Map<string, Promise<string[]>>();

  const choices: AiModelChoiceDto[] = [];
  for (const id of ids) {
    // Sequential on purpose: each load opens short system transactions;
    // a parallel fan-out would take that many pooled connections at once.
    const c = await loadOfferingCandidate(id, input.partnerId);
    if (!c || !c.offeringId) continue;
    if (checkEligibility(c.facts, asIfPermitted) !== null) continue;   // fails a rule other than permission
    const reason = checkEligibility(c.facts, ctx);
    let disabled: AiModelChoiceDto['disabled'] = null;
    if (reason === 'permission_required' && c.facts.requiredPermission) {
      const key = c.facts.requiredPermission;
      if (!roleNames.has(key)) {
        roleNames.set(key, rolesGrantingPermission({ partnerId: input.partnerId, orgId: input.orgId, permission: key }));
      }
      disabled = { reason: 'permission_required', permission: key, roleNames: await roleNames.get(key)! };
    } else if (reason !== null) {
      continue;   // defensive: asIfPermitted differs from ctx only in the permission rule
    }
    choices.push(toChoice(c, transport, assignment.options, disabled));
  }

  choices.sort((a, b) => {
    if (a.offeringId === assignment.defaultOfferingId) return -1;
    if (b.offeringId === assignment.defaultOfferingId) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
  return { ...head, choices };
}

function toChoice(
  c: LoadedCandidate,
  transport: DispatchTransport,
  assignmentOptions: Parameters<typeof defaultOptionsFor>[1],
  disabled: AiModelChoiceDto['disabled'],
): AiModelChoiceDto {
  // Eligible (or permission-only) ⇒ the rate rule passed ⇒ rate is non-null.
  const standard = c.facts.rate!.standard;
  const options = pickerOptionSupport(c, transport);
  const fastRate = options.speed.includes('fast') ? c.optionRates?.['speed:fast'] ?? null : null;
  return {
    offeringId: c.offeringId!,
    displayName: c.displayName,
    contextTokens: c.limits.maxInputTokens,
    funding: c.funding,
    priceHint: {
      inputCentsPerM: standard.inputCentsPerM,
      outputCentsPerM: standard.outputCentsPerM,
      fast: fastRate ? { inputCentsPerM: fastRate.inputCentsPerM, outputCentsPerM: fastRate.outputCentsPerM } : null,
    },
    thinkingMode: c.capabilities.thinkingMode,
    options,
    defaults: defaultOptionsFor(c, assignmentOptions, transport),
    disabled,
  };
}
