import { useEffect, useMemo, useState } from 'react';
import { useOrgScope } from './useOrgScope';
import { useOrgStore, type Organization } from '../stores/orgStore';

export interface FleetOrgOwner {
  /** True only in the explicit All-organizations view, where a pick is required. */
  isFleetScope: boolean;
  /** Org list for the picker, sorted by name. */
  organizations: Organization[];
  /**
   * The effective owner selection — the raw pick, but only while it is still a
   * member of the current org list. A pick that dropped out of the list (partner
   * switch, refetch) collapses back to '' so the UI shows "unselected" and the
   * create cannot proceed with a stale org.
   */
  orgId: string;
  setOrgId: (id: string) => void;
  /**
   * True when the create has no resolvable owner and must be blocked: the fleet
   * view with no valid pick, OR any scope that has not resolved to a concrete
   * org (loading, error, empty, cleared). A focused, resolved org scope is fine
   * — the server gets the injected `?orgId=`.
   */
  needsOrgSelection: boolean;
  /**
   * The orgId to place in the create body: the validated pick in fleet scope,
   * otherwise undefined (a focused scope relies on the `?orgId=` that
   * fetchWithAuth injects, so the body must stay silent there).
   */
  bodyOrgId: string | undefined;
}

/**
 * Backs a fleet-only "Organization" picker for org-owned create forms (DNS
 * integrations, device groups). Those resources must belong to exactly one org;
 * the dashboard normally scopes the create by the `?orgId=` that fetchWithAuth
 * injects from the active org. In the EXPLICIT All-organizations view there is
 * no active org, nothing is injected, and the server rejects the create with
 * "orgId is required for this scope". This hook surfaces the org list, tracks
 * the chosen owner, and reports when a create has no resolvable owner yet.
 *
 * Gate the picker on `useOrgScope().scope === 'all'`, NOT `currentOrgId === null`:
 * the bare-null read also matches the pre-hydration frame before the first org
 * auto-selects, which would flash the picker on a scope that's about to resolve
 * to a concrete org. (Same rule as useDefaultOwnerScope.)
 *
 * `needsOrgSelection` deliberately also blocks the unresolved/degraded scopes
 * (loading, org-list load failure, empty, cleared): those inject no `?orgId=`
 * either, so an unguarded create would hit the same opaque 400. And the picker
 * value is validated against the live org list every render, so a selection
 * that stops being accessible cannot be silently reused as the owner.
 */
export function useFleetOrgOwner(): FleetOrgOwner {
  const scope = useOrgScope();
  const organizations = useOrgStore((s) => s.organizations);
  const [selectedOrgId, setSelectedOrgId] = useState('');

  const isFleetScope = scope.status === 'resolved' && scope.scope === 'all';
  const isFocusedScope = scope.status === 'resolved' && scope.scope === 'org';

  const sortedOrganizations = useMemo(
    () => [...organizations].sort((a, b) => a.name.localeCompare(b.name)),
    [organizations],
  );

  // Only honor a pick that is still a member of the accessible org list.
  const validOrgId = organizations.some((o) => o.id === selectedOrgId)
    ? selectedOrgId
    : '';

  // Actually clear a pick that has dropped out of the list — don't just mask it.
  // Otherwise, if that org later reappears while this (page-level) hook stays
  // mounted, the stale choice would silently resurrect and re-enable submit
  // without a fresh user selection.
  useEffect(() => {
    if (selectedOrgId && !validOrgId) {
      setSelectedOrgId('');
    }
  }, [selectedOrgId, validOrgId]);

  // A create has a resolvable owner when the scope is a concrete focused org
  // (server injects it) or a fleet view with a valid pick.
  const hasOwner = isFocusedScope || (isFleetScope && Boolean(validOrgId));

  return {
    isFleetScope,
    organizations: sortedOrganizations,
    orgId: validOrgId,
    setOrgId: setSelectedOrgId,
    needsOrgSelection: !hasOwner,
    bodyOrgId: isFleetScope ? validOrgId || undefined : undefined,
  };
}
