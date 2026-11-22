import { useEffect, useMemo } from 'react';
import { useOrgStore } from '../../stores/orgStore';

/** The organizations a window may cover: the partner's active ones (not the hidden types). */
const HIDDEN_ORG_TYPES = new Set(['quick_support', 'unassigned_pool']);

export function usePartnerOrgs(): { orgs: Array<{ id: string; name: string }>; nameOf: (id: string) => string } {
  const organizations = useOrgStore((s) => s.organizations);
  const fetchOrganizations = useOrgStore((s) => s.fetchOrganizations);
  useEffect(() => {
    if (organizations.length === 0) void fetchOrganizations();
  }, [organizations.length, fetchOrganizations]);
  return useMemo(() => {
    const orgs = organizations
      .filter((o) => o.status === 'active' && !HIDDEN_ORG_TYPES.has((o as { type?: string }).type ?? ''))
      .map((o) => ({ id: o.id, name: o.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const names = new Map(organizations.map((o) => [o.id, o.name]));
    return { orgs, nameOf: (id: string) => names.get(id) ?? id };
  }, [organizations]);
}
