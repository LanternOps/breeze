import type { AuthContext } from '../../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PartnerWideWriteDeniedError,
} from '../partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../siteCeilingAccess';

export class AgentAccessDeniedError extends Error {
  constructor(message = 'Agent not accessible') {
    super(message);
    this.name = 'AgentAccessDeniedError';
  }
}

/**
 * A caller limited to a subset of sites tried to create/modify/delete an
 * agent or schedule. Both are org-wide (an agent acts on every device in its
 * org), so there is no per-site slice to allow. Subclasses
 * AgentAccessDeniedError so every existing caller still treats it as a denial;
 * routes that answer a generic denial with 404 answer this one with 403.
 */
export class AgentSiteCeilingDeniedError extends AgentAccessDeniedError {
  constructor() {
    super(SITE_CEILING_WRITE_DENIED_MESSAGE);
    this.name = 'AgentSiteCeilingDeniedError';
  }
}

/** Single source of truth for who may mutate an ai_agents row (spec §6). */
export function assertAgentWriteAllowed(
  auth: Pick<
    AuthContext,
    'principal' | 'scope' | 'partnerId' | 'partnerOrgAccess' | 'canAccessOrg' | 'allowedSiteIds'
  > &
    Partial<Pick<AuthContext, 'allowedDeviceIds'>>,
  row: { orgId: string | null; partnerId: string | null },
): void {
  if (auth.principal.kind === 'ai_agent') {
    throw new AgentAccessDeniedError('AI agents cannot manage agents');
  }

  // Same ceiling as every other org-wide governance object: a site-restricted
  // caller cannot create or edit something that runs across the whole org.
  if (!canMutateOrgWideGovernance(auth)) {
    throw new AgentSiteCeilingDeniedError();
  }

  // Exactly one owner. Without this the app gate never examines row.orgId on
  // the partner branch, so a caller could pass BOTH axes and pass the OR-shaped
  // RLS WITH CHECK too — leaving ai_agents_one_owner_chk as the only defence,
  // which surfaces as a raw 23514/500 instead of a clean denial.
  if ((row.orgId === null) === (row.partnerId === null)) {
    throw new AgentAccessDeniedError('Agent must have exactly one owner');
  }

  if (row.partnerId !== null) {
    if (auth.scope !== 'system' && auth.partnerId !== row.partnerId) {
      throw new AgentAccessDeniedError();
    }
    if (!canManagePartnerWidePolicies(auth)) {
      throw new PartnerWideWriteDeniedError();
    }
    return;
  }

  if (row.orgId === null || !auth.canAccessOrg(row.orgId)) {
    throw new AgentAccessDeniedError();
  }
}
