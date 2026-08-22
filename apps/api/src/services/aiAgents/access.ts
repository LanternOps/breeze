import type { AuthContext } from '../../middleware/auth';
import {
  canManagePartnerWidePolicies,
  PartnerWideWriteDeniedError,
} from '../partnerWideAccess';

export class AgentAccessDeniedError extends Error {
  constructor(message = 'Agent not accessible') {
    super(message);
    this.name = 'AgentAccessDeniedError';
  }
}

/** Single source of truth for who may mutate an ai_agents row (spec §6). */
export function assertAgentWriteAllowed(
  auth: Pick<
    AuthContext,
    'principal' | 'scope' | 'partnerId' | 'partnerOrgAccess' | 'canAccessOrg'
  >,
  row: { orgId: string | null; partnerId: string | null },
): void {
  if (auth.principal.kind === 'ai_agent') {
    throw new AgentAccessDeniedError('AI agents cannot manage agents');
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
