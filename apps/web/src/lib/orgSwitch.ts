import { useOrgStore } from '../stores/orgStore';
import { waitForPendingRefresh } from '../stores/auth';
import { navigateTo } from './navigation';
import { showToast } from '../components/shared/Toast';

// Switching org/scope re-navigates the page. Stash a confirmation message so
// the destination page can surface "Switched to X" if that navigation turns
// out to be a full reload (the router fallback), landing the peak-end of every
// context switch on a clear success rather than a blank flash. On the normal
// soft path applyOrgSwitch pops the stash and shows the toast itself.
export const SWITCH_TOAST_KEY = 'breeze.orgSwitch.toast';

export function stashSwitchToast(message: string) {
  try {
    sessionStorage.setItem(SWITCH_TOAST_KEY, message);
  } catch {
    // sessionStorage can throw in private-mode/quota edge cases; the toast is a
    // nicety, never block the switch on it.
  }
}

/** Pop the stashed confirmation (if any). Fired from OrgSwitcher's mount after
 *  a hard load, and by applyOrgSwitch itself once a soft navigation settles. */
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
 * re-navigating to the now-inaccessible URL.
 *
 * Returns the destination URL when redirection is needed, otherwise null
 * (meaning the caller should keep the current path and just re-navigate).
 */
// Static pages under src/pages/devices that share the /devices/:id shape but
// are fleet views, not a device record — they stay in place on an org switch.
// Kept in sync with the pages directory by the drift guard in orgSwitch.test.ts.
const DEVICE_STATIC_SIBLINGS: ReadonlySet<string> = new Set(['compare', 'groups', 'posture', 'time', 'unassigned']);

export function getOrgSwitchRedirect(pathname: string): string | null {
  // /devices/:id -> /devices (but not /devices or a static sibling page)
  const deviceDetail = pathname.match(/^\/devices\/([^/]+)\/?$/);
  if (deviceDetail && !DEVICE_STATIC_SIBLINGS.has(deviceDetail[1])) {
    return '/devices';
  }
  // /organizations/:id (the org RECORD) -> the organizations board. The record's
  // subject is the org in the URL, so re-navigating to it after a switch would leave
  // the user on the customer they just switched away from (#5075).
  if (/^\/organizations\/[^/]+\/?$/.test(pathname)) {
    return '/organizations';
  }
  return null;
}

/**
 * A page whose URL hash names a TAB — not an org-specific record or row — can
 * ask an in-place switch to keep it (#9954: Integrations' "Change" used to drop
 * the user from Microsoft 365 back on the default tab). Opt-in, because most
 * hashes elsewhere select something that does not exist in the other org.
 *
 * The provider is asked at switch time and returns the hash to keep (with or
 * without the leading `#`), or null to keep nothing. One page owns the slot at a
 * time; the returned release only clears the slot if it is still this
 * provider's, so the outgoing page's late unmount cannot drop the incoming
 * page's claim.
 */
type KeptHashProvider = () => string | null;
let keptHashProvider: KeptHashProvider | null = null;

export function keepHashAcrossOrgSwitch(provider: KeptHashProvider): () => void {
  keptHashProvider = provider;
  return () => {
    if (keptHashProvider === provider) keptHashProvider = null;
  };
}

/** The hash the current page asked to keep (no leading `#`), or null. */
export function orgSwitchKeptHash(): string | null {
  try {
    const hash = keptHashProvider?.()?.replace(/^#/, '');
    return hash ? hash : null;
  } catch (err) {
    // Keeping the tab is a nicety; a broken provider must never stop the switch.
    console.warn('[orgSwitch] kept-hash provider threw; switching without it', err);
    return null;
  }
}

/**
 * The one context-switch ritual, shared by the header switcher and any inline
 * affordance (e.g. OrgRequiredState's quick-pick): set the selection (null →
 * fleet view), stash the confirmation toast, wait out any in-flight
 * /auth/refresh (#950 login-bounce race, fixed in #953/#956/#958), then
 * redirect detail routes up to their list — or re-navigate to the current
 * path — so the new scope propagates everywhere at once.
 *
 * The navigation is a SOFT one through Astro's view-transition router rather
 * than `location.reload()`: the page island is swapped and remounts under the
 * new org (every page reads the ambient org on mount, so a remount is the
 * propagation mechanism), while the shell islands marked `transition:persist`
 * — sidebar, header, AI chat, toasts — stay put. Pages do not need to
 * subscribe to the store.
 *
 * The in-place target drops the URL hash on purpose: the router treats a
 * same-path navigation that carries a hash as a scroll-to-anchor and does not
 * swap the document, and hash state (a selected row) is usually org-specific.
 * A page whose hash is only a tab can opt back in with keepHashAcrossOrgSwitch:
 * the navigation still goes out hashless, and the kept hash is written onto the
 * swapped-in URL at `astro:after-swap` — before the new page island hydrates
 * and reads it — then announced with a `hashchange` for an island that
 * hydrated first. A hard-load fallback keeps nothing.
 *
 * `destination` overrides both: for a switch that is itself a navigation (e.g.
 * the org record's "Open in Devices"), the caller knows where the user is
 * going and the redirect table has nothing to add. A destination equal to the
 * current URL *including a hash* means "switch and stay": no navigation
 * happens at all (a hashless same-path destination still soft-navigates so
 * the page re-renders under the new org).
 */
export async function applyOrgSwitch(
  orgId: string | null,
  toastMessage: string,
  destination?: string,
): Promise<void> {
  // Read before the await: the caller built `destination` from the URL at
  // click time, and a tab change during the refresh must not turn "stay"
  // into a navigation back to the old hash.
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const store = useOrgStore.getState();
  if (orgId) {
    store.selectOrganization(orgId);
    store.recordRecentOrg(orgId);
  } else store.selectAllOrgs();
  stashSwitchToast(toastMessage);
  await waitForPendingRefresh();
  // "Switch and stay" (#9019: the org record's own URL, hash included). The
  // router treats a same-page URL with a hash as an anchor move and never
  // swaps, so navigating would report 'hard' and strand the toast. The caller
  // owns re-rendering here — its view must already be independent of the
  // ambient org, as the org record's (every read pinned to the URL's org) is.
  if (destination !== undefined && destination === here && here.includes('#')) {
    const message = consumeSwitchToast();
    if (message) showToast({ type: 'success', message });
    return;
  }
  const redirect = destination ?? getOrgSwitchRedirect(window.location.pathname);
  const target = redirect ?? `${window.location.pathname}${window.location.search}`;
  // Only an in-place switch keeps a hash: a redirect or destination is another page.
  const keptHash = redirect === null ? orgSwitchKeptHash() : null;
  let hashRestored = false;
  const restoreHash = () => {
    if (window.location.pathname !== target.split('?')[0]) return;
    window.history.replaceState(window.history.state, '', `${target}#${keptHash}`);
    hashRestored = true;
  };
  if (keptHash) document.addEventListener('astro:after-swap', restoreHash, { once: true });
  let mode: Awaited<ReturnType<typeof navigateTo>>;
  try {
    mode = await navigateTo(target, { replace: !destination });
  } finally {
    document.removeEventListener('astro:after-swap', restoreHash);
  }
  if (mode !== 'soft') return; // a full load is under way; the next mount pops the stash
  if (hashRestored) window.dispatchEvent(new HashChangeEvent('hashchange'));
  // The persisted switcher never remounts on a soft navigation, so its
  // mount-time consume would never fire — surface the confirmation here.
  const message = consumeSwitchToast();
  if (message) showToast({ type: 'success', message });
}
