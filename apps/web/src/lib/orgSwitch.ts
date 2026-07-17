import { useOrgStore } from '../stores/orgStore';
import { waitForPendingRefresh } from '../stores/auth';

// Switching org/scope reloads the page. Stash a confirmation message so the
// destination page can surface "Switched to X" after the reload, landing the
// peak-end of every context switch on a clear success rather than a blank flash.
export const SWITCH_TOAST_KEY = 'breeze.orgSwitch.toast';

export function stashSwitchToast(message: string) {
  try {
    sessionStorage.setItem(SWITCH_TOAST_KEY, message);
  } catch {
    // sessionStorage can throw in private-mode/quota edge cases; the toast is a
    // nicety, never block the switch on it.
  }
}

/** Pop the stashed confirmation (if any) after a reload. */
export function consumeSwitchToast(): string | null {
  try {
    const message = sessionStorage.getItem(SWITCH_TOAST_KEY);
    if (message) sessionStorage.removeItem(SWITCH_TOAST_KEY);
    return message;
  } catch {
    return null;
  }
}

/**
 * When switching organizations, certain detail-view routes show data scoped to
 * the previous org and would render blank or 404 under the new org. For those
 * routes we navigate up to the list view in the destination org instead of
 * reloading the now-inaccessible URL.
 *
 * Returns the destination URL when redirection is needed, otherwise null
 * (meaning the caller should keep the current path and just reload).
 */
export function getOrgSwitchRedirect(pathname: string): string | null {
  // /devices/:id -> /devices (but not /devices, /devices/compare, /devices/groups, etc.)
  const deviceDetail = pathname.match(/^\/devices\/([^/]+)\/?$/);
  if (deviceDetail) {
    const segment = deviceDetail[1];
    // Preserve sibling routes that share the prefix.
    if (segment !== 'compare' && segment !== 'groups') {
      return '/devices';
    }
  }
  return null;
}

/**
 * The one context-switch ritual, shared by the header switcher and any inline
 * affordance (e.g. OrgRequiredState's quick-pick): set the selection (null →
 * fleet view), stash the confirmation toast, wait out any in-flight
 * /auth/refresh (#950 login-bounce race, fixed in #953/#956/#958), then
 * redirect detail routes up to their list — or reload in place — so the new
 * scope propagates everywhere at once.
 */
export async function applyOrgSwitch(orgId: string | null, toastMessage: string): Promise<void> {
  const store = useOrgStore.getState();
  if (orgId) store.selectOrganization(orgId);
  else store.selectAllOrgs();
  stashSwitchToast(toastMessage);
  await waitForPendingRefresh();
  const redirect = getOrgSwitchRedirect(window.location.pathname);
  if (redirect) {
    window.location.href = redirect;
  } else {
    window.location.reload();
  }
}
