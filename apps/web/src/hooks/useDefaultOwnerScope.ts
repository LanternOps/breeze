import { getJwtClaims } from '../lib/authScope';
import { useOrgScope } from './useOrgScope';

export type OwnerScope = 'organization' | 'partner';

/**
 * The single source of the create-form ownerScope default (partner-wide vs
 * org-owned) and the gate for showing the selector at all. A partner-scope user
 * in the EXPLICIT All-organizations view is configuring "for everyone", so new
 * config objects default to partner-wide; with a concrete org selected — or
 * during the unresolved/loading window before one auto-selects — they default
 * to org-owned. Keying on `scope === 'all'` (not `allOrgs || !currentOrgId`)
 * matters: the bare-null branch used to default a partner user's form to
 * partner-wide during the pre-hydration frame, contradicting the org context
 * that was about to resolve. Org-scope tokens never see the selector and always
 * create org-owned. Previously copy-pasted across 8 config surfaces — change
 * the rule here, nowhere else.
 */
export function useDefaultOwnerScope(): {
  isPartnerScope: boolean;
  defaultOwnerScope: OwnerScope;
} {
  const orgScope = useOrgScope();
  const { scope, partnerId } = getJwtClaims();
  const isPartnerScope = scope === 'partner' && !!partnerId;
  return {
    isPartnerScope,
    defaultOwnerScope: isPartnerScope && orgScope.scope === 'all' ? 'partner' : 'organization',
  };
}
