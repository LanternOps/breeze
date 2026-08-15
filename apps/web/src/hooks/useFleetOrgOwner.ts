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
   * org (loading, error, empty, cleared). A focused, resolved org scope always
   * has an owner (the selected org).
   */
  needsOrgSelection: boolean;
  /**
   * The concrete owner org to place in the create body: the selected org in a
   * focused scope, or the validated pick in fleet scope. Undefined only while
   * the scope is unresolved (which `needsOrgSelection` also blocks).
   *
   * The body must carry it in BOTH scopes: some org-owned create routes read
   * only `body.orgId` and never the `?orgId=` query that fetchWithAuth injects
   * (e.g. DNS integrations — #3505 fails in a focused view too), so relying on
   * the injected query alone leaves a multi-org partner 400ing when focused.
   */
  bodyOrgId: string | undefined;
}

/**
 * Backs a fleet "Organization" picker for org-owned create forms (DNS
 * integrations, device groups). Those resources must belong to exactly one org.
 * In a focused view the owner is the selected org; in the EXPLICIT
 * All-organizations view there is no active org, so the form must ask which org
 * should own the resource — otherwise the server rejects the create with
 * "orgId is required for this scope". This hook surfaces the org list, tracks
 * the chosen owner, and always reports the concrete owner to send in the body.
 *
 * Gate the picker on `useOrgScope().scope === 'all'`, NOT `currentOrgId === null`:
 * the bare-null read also matches the pre-hydration frame before the first org
 * auto-selects, which would flash the picker on a scope that's about to resolve
 * to a concrete org. (Same rule as useDefaultOwnerScope.)
 *
 * `needsOrgSelection` deliberately blocks the unresolved/degraded scopes
 * (loading, org-list load failure, empty, cleared): those have no owner to send,
 * so an unguarded create would hit the same opaque 400. And the picker value is
 * validated against the live org list every render, so a selection that stops
 * being accessible cannot be silently reused as the owner.
 */
export function useFleetOrgOwner(): FleetOrgOwner {
  const scope = useOrgScope();
  const organizations = useOrgStore((s) => s.organizations);
  const organizationsLoaded = useOrgStore((s) => s.organizationsLoaded);
  const [selectedOrgId, setSelectedOrgId] = useState('');

  const isFleetScope = scope.status === 'resolved' && scope.scope === 'all';
  // The concrete org in a focused, resolved scope (undefined otherwise).
  // Narrowed here so `scope.orgId` is typed as string.
  const focusedOrgId =
    scope.status === 'resolved' && scope.scope === 'org' ? scope.orgId : undefined;

  const sortedOrganizations = useMemo(
    () => [...organizations].sort((a, b) => a.name.localeCompare(b.name)),
    [organizations],
  );

  const inList = (id: string) => organizations.some((o) => o.id === id);

  // Fleet pick: always a current member of the loaded list — it was chosen from
  // that list, and a pick that drops out must not resurrect.
  const fleetPick = isFleetScope && selectedOrgId && inList(selectedOrgId) ? selectedOrgId : '';

  // Focused owner: the selected org. Drop it ONLY when the list is LOADED and
  // proves it absent (stale / access revoked). While the list is unloaded —
  // still loading OR the cold-load fetch failed — keep trusting the concrete
  // selection: useOrgScope's contract is that a concrete selection stays usable
  // after a refetch failure, and the server authorizes the owner anyway.
  // Requiring list membership unconditionally would strand a legitimately
  // focused user whose org-list fetch failed, with no retry on these forms.
  const focusedOwner =
    focusedOrgId && (!organizationsLoaded || inList(focusedOrgId)) ? focusedOrgId : '';

  const ownerOrgId = isFleetScope ? fleetPick : focusedOwner;

  // Actually clear a fleet pick that has dropped out of the loaded list — don't
  // just mask it. Otherwise, if that org later reappears while this (page-level)
  // hook stays mounted, the stale choice would silently resurrect and re-enable
  // submit without a fresh selection. Gate on `organizationsLoaded` so a
  // transient/failed empty list never wipes a valid pick. (Focused ids aren't
  // local state, so they need no clearing.)
  useEffect(() => {
    if (
      selectedOrgId &&
      organizationsLoaded &&
      !organizations.some((o) => o.id === selectedOrgId)
    ) {
      setSelectedOrgId('');
    }
  }, [selectedOrgId, organizationsLoaded, organizations]);

  return {
    isFleetScope,
    organizations: sortedOrganizations,
    orgId: ownerOrgId,
    setOrgId: setSelectedOrgId,
    needsOrgSelection: !ownerOrgId,
    bodyOrgId: ownerOrgId || undefined,
  };
}
