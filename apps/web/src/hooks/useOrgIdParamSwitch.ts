import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../stores/orgStore';
import { applyOrgSwitch } from '../lib/orgSwitch';
import { replaceUrl } from '../lib/replaceUrl';
import { showToast } from '../components/shared/Toast';

/** Drop `orgId` from the address bar in place, keeping every other param and the hash. */
function stripOrgIdParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('orgId');
  replaceUrl(`${url.pathname}${url.search}${url.hash}`);
}

/**
 * Honour an `?orgId=<id>` deep link on a page that scopes by the working org
 * (#9108). Links from an org's record (e.g. `/alerts?orgId=…`) name the org
 * they are about; without this the page would silently show whichever org the
 * header switcher holds.
 *
 * Once the org list has loaded:
 * - the param names an org the user can see that is not the working org (or
 *   the user is in the fleet view) → switch to it through the shared
 *   `applyOrgSwitch` ritual, landing on `destination` (which drops the param),
 *   and the page island remounts under the new org;
 * - it names the working org → no switch; the param is stripped in place;
 * - it names an org the user cannot see, or the org list failed to load → no
 *   switch, a warning toast says the page shows the current selection instead,
 *   and the param is stripped.
 *
 * Returns `true` while the page must hold its org-scoped fetches: the param
 * is still undecided, or a switch is under way. The param is read once, at
 * mount.
 */
export function useOrgIdParamSwitch(destination: string): boolean {
  const { t } = useTranslation('common');
  const [paramOrgId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('orgId'),
  );
  const [settled, setSettled] = useState(paramOrgId === null);
  const switching = useRef(false);

  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const organizationsLoaded = useOrgStore((s) => s.organizationsLoaded);
  const orgListError = useOrgStore((s) => s.error);
  const target = useOrgStore((s) => (paramOrgId ? (s.organizations.find((o) => o.id === paramOrgId) ?? null) : null));

  useEffect(() => {
    if (settled || switching.current || paramOrgId === null) return;
    if (!organizationsLoaded && !orgListError) return; // can't tell yet whether the user can see that org
    if (target && target.id !== currentOrgId) {
      switching.current = true;
      // Rewrite the deep-link entry to the destination first, so the switch's
      // navigation lands on the URL already showing (the router replaces
      // rather than pushes). Otherwise a `?orgId=` entry stays behind in
      // history and Back re-runs this switch.
      replaceUrl(destination);
      applyOrgSwitch(target.id, t('layout.org.toast.switched', { name: target.name }), destination).catch((err) => {
        // The selection already moved to the linked org; release the page so it
        // loads under it rather than holding a spinner on a failed navigation.
        console.error('[useOrgIdParamSwitch] org switch navigation failed', err);
        stripOrgIdParam();
        setSettled(true);
      });
      return;
    }
    if (!target) {
      // Not an org this user can see, or the org list failed to load. The page
      // falls back to the current scope; say so rather than silently showing
      // another org's data under a link that named this one.
      showToast({ type: 'warning', message: t('layout.org.toast.linkedOrgUnavailable') });
    }
    stripOrgIdParam();
    setSettled(true);
  }, [settled, paramOrgId, organizationsLoaded, orgListError, target, currentOrgId, destination, t]);

  return !settled;
}
