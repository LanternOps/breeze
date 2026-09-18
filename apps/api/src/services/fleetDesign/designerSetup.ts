/**
 * Fleet Designer setup (#6214) — the one-click path from "no designer agent"
 * to "Fleet Design runs".
 *
 * Before this, running a Fleet Design meant a detour through Settings → AI
 * Agents that nothing on the Fleet Design page explained: create an agent of
 * kind `designer` (partner-wide — an org row alone never resolves, see
 * `resolveEffectiveAgentInner`), notice it defaulted to `enabled: false` /
 * `mode: 'off'`, find that Shadow is greyed out, and pick `act` — which for
 * a read-only kind means "produce designs", not "change devices".
 *
 * `describeDesignerSetup` tells the page what state the org is in and whether
 * THIS caller can fix it; `enableDesigner` does the fix through the same
 * `createAgent` / `updateAgent` the settings form uses, so every guard
 * (partner-wide write access, act prerequisites, recipient validation, the
 * kind-uniqueness pre-check) and every audit row is exactly the one a manual
 * setup would have produced. Nothing here is a new write path.
 */
import { and, eq, isNull } from 'drizzle-orm';
import {
  createAiAgentSchema,
  type FleetDesignerEnableErrorCode,
  type FleetDesignerSetup,
  type FleetDesignerSetupStatus,
} from '@breeze/shared';
import { db } from '../../db';
import { aiAgents, type AiAgentRow } from '../../db/schema';
import { envFlag } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { AgentAccessDeniedError } from '../aiAgents/access';
import {
  ActPrerequisitesNotMetError,
  AgentKindConflictError,
  createAgent,
  getAgent,
  updateAgent,
} from '../aiAgents/agentService';
import { InvalidAgentRecipientsError } from '../aiAgents/recipients';
import { normalizeAgentPolicy, resolveEffectiveAgent, type ResolvedAgent } from '../aiAgents/effectivePolicy';

export const DEFAULT_DESIGNER_AGENT_NAME = 'Fleet Designer';

export type DesignerEnableErrorCode = FleetDesignerEnableErrorCode;

/** The one error shape the route maps. `detail` carries the underlying
 *  service error's actionable payload (`missing`, invalid ids) untouched. */
export class DesignerEnableError extends Error {
  constructor(readonly code: DesignerEnableErrorCode, readonly detail: Record<string, unknown> = {}) {
    super(code);
    this.name = 'DesignerEnableError';
  }
}

/** Translate agentService's write-time refusals into this module's error so
 *  the route never has to import agentService (and its whole dependency
 *  tree) just to recognise them. Anything else propagates unchanged —
 *  `PartnerWideWriteDeniedError` already has its own route mapping. */
function translateEnableError(err: unknown): never {
  if (err instanceof AgentAccessDeniedError) throw new DesignerEnableError('partner_admin_required');
  if (err instanceof AgentKindConflictError) throw new DesignerEnableError('agent_kind_exists');
  if (err instanceof ActPrerequisitesNotMetError) throw new DesignerEnableError('act_prerequisites_not_met', { missing: err.missing });
  if (err instanceof InvalidAgentRecipientsError) {
    throw new DesignerEnableError('invalid_recipients', { invalidUserIds: err.invalidUserIds, invalidRoleIds: err.invalidRoleIds });
  }
  throw err;
}

/** Same call-time read `resolveEffectiveAgentInner` makes, so the status the
 *  page shows and the `enabled: false` the run admission sees agree. */
function killSwitchOff(): boolean {
  return !envFlag('BREEZE_AI_AGENTS_ENABLED', false);
}

function partnerWritable(auth: AuthContext): boolean {
  return auth.partnerId !== null && auth.partnerId !== undefined && canManagePartnerWidePolicies(auth);
}

/** Whether the PARTNER baseline row is (one of) the reason(s) the effective
 *  agent is not runnable. When both rows are off, `mergeAgentPolicies`
 *  attributes the merged value to the partner (`enabled: partner && org` →
 *  'partner' when the partner is off; `mode === partner.mode` → 'partner'),
 *  so this is true whenever the partner row itself needs a change. */
function partnerRowNeedsFix(resolved: ResolvedAgent): boolean {
  return (!resolved.effective.enabled && resolved.provenance.enabled === 'partner')
    || (resolved.effective.mode === 'off' && resolved.provenance.mode === 'partner');
}

function statusOf(resolved: ResolvedAgent | null): FleetDesignerSetupStatus {
  // Checked before `missing`: creating an agent under a platform-wide kill
  // switch would land on the same `enabled: false` the switch forces, so
  // offering "Enable" there would be a button that cannot work.
  if (killSwitchOff()) return 'kill_switch_off';
  if (!resolved) return 'missing';
  if (!resolved.effective.enabled) return 'disabled';
  if (resolved.effective.mode === 'off') return 'off';
  return 'ready';
}

export async function describeDesignerSetup(auth: AuthContext, orgId: string): Promise<FleetDesignerSetup> {
  const resolved = await resolveEffectiveAgent(auth, orgId, 'designer');
  const status = statusOf(resolved);
  let canEnable = false;
  if (status === 'missing') {
    canEnable = partnerWritable(auth);
  } else if (status === 'off' || status === 'disabled') {
    // An org override the caller can already reach is always fixable; a
    // partner baseline only by someone who can write partner-wide policy.
    canEnable = partnerRowNeedsFix(resolved!) ? partnerWritable(auth) : true;
  }
  return { status, agentId: resolved?.agentId ?? null, canEnable };
}

function rowIsOff(row: AiAgentRow): boolean {
  return !row.enabled || row.mode === 'off';
}

/** `act` needs someone to deliver the finished design to
 *  (`assertActPrerequisites`). A row that already names a recipient is left
 *  alone; one that names nobody gets the person who pressed the button. */
function turnOnPatch(row: AiAgentRow, auth: AuthContext) {
  const recipients = normalizeAgentPolicy(row).recipients;
  const hasRecipient = (recipients.userIds?.length ?? 0) > 0 || (recipients.roleIds?.length ?? 0) > 0;
  return {
    enabled: true as const,
    mode: 'act' as const,
    ...(hasRecipient ? {} : { recipients: { userIds: [auth.user.id] } }),
  };
}

export async function enableDesigner(auth: AuthContext, orgId: string): Promise<FleetDesignerSetup> {
  try {
    return await enableDesignerInner(auth, orgId);
  } catch (err) {
    return translateEnableError(err);
  }
}

async function enableDesignerInner(auth: AuthContext, orgId: string): Promise<FleetDesignerSetup> {
  const resolved = await resolveEffectiveAgent(auth, orgId, 'designer');
  if (killSwitchOff()) throw new DesignerEnableError('kill_switch_off');

  if (!resolved) {
    if (!auth.partnerId) throw new DesignerEnableError('partner_scope_required');
    // An org-scoped token carries a partnerId too; createAgent's own
    // assertAgentWriteAllowed would refuse it, but naming the remedy here
    // keeps the answer the same one describeDesignerSetup's canEnable gave.
    if (!partnerWritable(auth)) throw new DesignerEnableError('partner_admin_required');
    // Parsed through the create schema so every nested default the settings
    // form would have materialised (limits, triggers, actAssets, …) is
    // present — createAgent relies on that, see its assertActPrerequisites.
    const input = createAiAgentSchema.parse({
      kind: 'designer',
      name: DEFAULT_DESIGNER_AGENT_NAME,
      ownerScope: 'partner',
      mode: 'act',
      enabled: true,
      recipients: { userIds: [auth.user.id] },
    });
    await createAgent(auth, { orgId: null, partnerId: auth.partnerId }, input);
    return describeDesignerSetup(auth, orgId);
  }

  // Two rows may need a change. The org override goes FIRST: the route
  // answers a refusal with a mapped response (so the request transaction
  // still commits whatever ran before it), and of the two possible partial
  // outcomes only one is consequential — a partner-wide row switched on
  // for every org under the partner, behind a toast saying it failed. With
  // the org row first, a failure on either step leaves the design off
  // everywhere it was off before: the org row alone can never self-enable
  // (`resolveEffectiveAgentInner` needs the partner baseline).
  //
  // The org override (if any) narrows the partner baseline: `enabled` is
  // AND-ed and `mode` is min-ed, so an off org row keeps the design off no
  // matter what the partner row says.
  const [orgRow] = await db
    .select()
    .from(aiAgents)
    .where(and(eq(aiAgents.orgId, orgId), eq(aiAgents.kind, 'designer'), isNull(aiAgents.disabledAt)))
    .limit(1);
  if (orgRow && rowIsOff(orgRow)) await updateAgent(auth, orgRow.id, turnOnPatch(orgRow, auth));

  if (partnerRowNeedsFix(resolved)) {
    // getAgent is bound to the caller's visibility: an org-scoped token
    // cannot see (let alone write) the partner baseline, and updateAgent
    // would refuse anyway — name the real remedy instead of a bare 404.
    const partnerRow = await getAgent(auth, resolved.agentId);
    if (!partnerRow) throw new DesignerEnableError('partner_admin_required');
    if (rowIsOff(partnerRow)) await updateAgent(auth, partnerRow.id, turnOnPatch(partnerRow, auth));
  }

  return describeDesignerSetup(auth, orgId);
}
