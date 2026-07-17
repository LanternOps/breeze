import { useOrgStore } from '../stores/orgStore';
import { getJwtClaims } from '../lib/authScope';

export type OwnerScope = 'organization' | 'partner';

/**
 * The single source of the create-form ownerScope default (partner-wide vs
 * org-owned) and the gate for showing the selector at all. A partner-scope
 * user in fleet view (All organizations) is configuring "for everyone", so
 * new config objects default to partner-wide; with a concrete org selected
 * they default to org-owned. Org-scope tokens never see the selector and
 * always create org-owned. Previously copy-pasted across 8 config surfaces —
 * change the rule here, nowhere else.
 */
export function getOwnerScopeDefaults(): {
  isPartnerScope: boolean;
  defaultOwnerScope: OwnerScope;
} {
  const { scope, partnerId } = getJwtClaims();
  const isPartnerScope = scope === 'partner' && !!partnerId;
  const { currentOrgId, allOrgs } = useOrgStore.getState();
  return {
    isPartnerScope,
    defaultOwnerScope:
      isPartnerScope && (allOrgs || !currentOrgId) ? 'partner' : 'organization',
  };
}

/** Hook variant for render-time reads (subscribes to the org context). */
export function useDefaultOwnerScope(): {
  isPartnerScope: boolean;
  defaultOwnerScope: OwnerScope;
} {
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const allOrgs = useOrgStore((s) => s.allOrgs);
  const { scope, partnerId } = getJwtClaims();
  const isPartnerScope = scope === 'partner' && !!partnerId;
  return {
    isPartnerScope,
    defaultOwnerScope:
      isPartnerScope && (allOrgs || !currentOrgId) ? 'partner' : 'organization',
  };
}
