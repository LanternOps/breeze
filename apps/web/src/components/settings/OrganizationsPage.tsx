import { useState, useEffect, useCallback, useMemo, useRef, type DragEvent, type KeyboardEvent } from 'react';
import { useHashState } from '@/lib/useHashState';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from './organizationTypes';
import OrganizationForm from './OrganizationForm';
import SiteList from './SiteList';
import SiteModals from './SiteModals';
import { useSiteCrud } from './useSiteCrud';
import MergeOrgModal from './MergeOrgModal';
import ArchiveOrgModal from './ArchiveOrgModal';
import BulkOrgImport from '../organizations/BulkOrgImport';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useJwtClaims } from '../../lib/authScope';
import { extractApiError } from '@/lib/apiError';
import { runAction, ActionError, handleActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { isArchiveLifecycleOrg } from '@/lib/archiveLifecycle';
import { Dialog } from '../shared/Dialog';
import { ActionMenu } from '../shared/ActionMenu';
import { applyOrgSwitch } from '@/lib/orgSwitch';
import { makeOrgFetch, useLatest, type OrgSummary } from '../organizations/record/orgRecordFetch';
import { formatDate } from '@/lib/dateTimeFormat';
import { formatNumber } from '@/lib/i18n/format';
import { Building2, ChevronDown, ChevronRight, GripVertical, Settings } from 'lucide-react';

type ModalMode = 'closed' | 'add' | 'edit' | 'archive' | 'merge';

/** `aria-describedby` target for every row's reorder handle: one hidden
 *  sentence explaining the arrow-key alternative to dragging. */
const REORDER_HINT_ID = 'org-list-reorder-hint';
const ADD_ORG_TITLE_ID = 'org-add-dialog-title';
const noop = () => {};

/** localStorage key for the list's sort choice: a per-browser convenience,
 *  never authoritative state. Exported for the test. */
export const ORG_LIST_SORT_STORAGE_KEY = 'breeze.orgList.sort';
type SortMode = 'manual' | 'name' | 'devices';
const SORT_MODES: SortMode[] = ['manual', 'name', 'devices'];

function readStoredSortMode(): SortMode {
  try {
    const stored = window.localStorage.getItem(ORG_LIST_SORT_STORAGE_KEY);
    return stored === 'name' || stored === 'devices' ? stored : 'manual';
  } catch {
    return 'manual';
  }
}

/** Chip order for the status filter: lifecycle order, `active` excluded —
 *  it is the steady state the other chips are the exceptions to, the same
 *  rule that keeps the active rows free of a status pill. */
const FILTERABLE_STATUSES: Organization['status'][] = ['trial', 'suspended', 'churned', 'offboarding', 'merging'];

type OrganizationFormValues = {
  name: string;
  slug: string;
  type: 'customer' | 'internal';
  status: 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding';
  maxDevices: number;
  contractStart?: string;
  contractEnd?: string;
};

/**
 * Whether the org card should render its `{{count}} devices` label.
 *
 * The count is absent for organization-scoped callers — that branch of
 * `GET /orgs/organizations` returns a deliberately minimal projection. Rendering
 * the label anyway interpolated `undefined` and produced a bare " devices",
 * which reads as a loading bug or an empty tenant (#3699). `0` is a real value
 * and must render, so this cannot be a truthiness check.
 *
 * Exported for test, like `fetchAllOrganizations` below it.
 */
export function shouldShowDeviceCount(count: number | undefined): boolean {
  return typeof count === 'number' && Number.isFinite(count);
}

// The status pill maps moved to lib/ (#5075) so the organization RECORD header
// can share them without importing this whole page component — the same reason
// `fetchAllOrganizations` moved. Re-exported here so this page stays the
// documented home of the status contract and its tests
// (OrganizationsPage.statusMaps.test.tsx).
export { statusLabelKeys, statusColors } from '../../lib/orgStatus';
import { statusColors, statusLabelKeys } from '../../lib/orgStatus';

/**
 * Days remaining until an archived org's scheduled purge, rounded UP so a
 * countdown reading "1 day" never flips to "0 days" while any part of that day
 * remains — the operator's read of "1 day left" must stay true until it
 * actually is zero. `null` covers both `purgeAt: null` ("kept indefinitely",
 * `retentionDays` was Never) and an unparseable timestamp, so callers can
 * treat the two identically instead of rendering `NaN`.
 *
 * Exported for test. `now` defaults to `new Date()` — real callers never pass
 * it; tests pin it (or the global clock via `vi.setSystemTime`) for a
 * deterministic countdown.
 */
export function purgeCountdownDays(purgeAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!purgeAt) return null;
  const target = new Date(purgeAt);
  if (Number.isNaN(target.getTime())) return null;
  return Math.ceil((target.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * The archived-org restore route (`apps/api/src/routes/orgArchive.ts`) answers
 * a purging target with a bare `{ error: '<this text>' }, 410` — no machine
 * `code` field the way its MFA rejection carries `code: 'MFA_REQUIRED'`. That
 * makes this literal string the only handle `runAction`'s `friendly` lookup
 * has to give the purging case its own localized copy instead of the raw
 * backend sentence; a copy edit to that route's message must update this
 * constant too, or the match silently stops firing (degrading gracefully back
 * to the raw — still correct, just unlocalized — backend text).
 */
export const RESTORE_PURGING_ERROR_TEXT = 'Organization is already purging and can no longer be restored';

/**
 * Debounce for the Archived section's search-driven refetch. Mirrors
 * `DistributorLookup.tsx`'s `NIGHTLY_DEBOUNCE_MS` — a per-keystroke full page
 * walk (`fetchAllOrganizations`) is expensive enough, and slow enough to
 * overlap the NEXT keystroke's own fetch, that firing on every change is both
 * wasteful and (without the request-token guard below) a genuine race: an
 * older, broader request resolving after a newer, narrower one would clobber
 * results the user already found. Exported for the test.
 */
export const ARCHIVED_SEARCH_DEBOUNCE_MS = 300;

// Walking every page of GET /orgs/organizations moved to lib/ (#3446 follow-up)
// so the org-switcher store — a second reader with the same first-50 truncation
// — can share it without importing this page component. Re-exported here to
// keep this page the documented home of the pagination contract and its tests.
export {
  fetchAllOrganizations,
  ORGANIZATIONS_PAGE_SIZE,
  ORGANIZATIONS_MAX_PAGES,
} from '../../lib/fetchAllOrganizations';
import { fetchAllOrganizations } from '../../lib/fetchAllOrganizations';

export default function OrganizationsPage() {
  const { t } = useTranslation('settings');
  // Merge is a partner-scope-only action (the API's org-merge routes require
  // `requireScope('partner', 'system')`, and only a partner token's own
  // partner org list is ever eligible as a survivor). `useJwtClaims()`
  // (not the one-shot `getJwtClaims()`) so this stays reactive to the token
  // landing after cold load instead of freezing the pre-token "unresolved"
  // answer for the life of the mount (#4013's lesson, TicketingSettingsTabs).
  const jwt = useJwtClaims();
  const canMergeOrgs = jwt.status === 'resolved' && jwt.claims.scope === 'partner';
  // The workspace org (the OrgSwitcher's selection) is a separate axis from
  // the org selected on this page, and the two disagree constantly on a
  // two-monitor desk: a tech acts on OliveTech here while the switcher says
  // Liggett. The page never used to read it at all. Both are read through
  // store selectors so the chip re-renders when the org list lands after
  // mount (the name lives in the store's list, not on the token).
  const workspaceOrgId = useOrgStore((s) => s.currentOrgId);
  const workspaceOrgName = useOrgStore((s) =>
    s.currentOrgId ? (s.organizations.find((o) => o.id === s.currentOrgId)?.name ?? null) : null,
  );
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null);
  // Deep-linked org id adopted post-mount (#2421); later hash writes are
  // harmless because the consumer effect only fires while nothing is selected.
  const [initialOrgId] = useHashState<string | null>(null, (h) => h || undefined);
  const [submitting, setSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // List controls for a long list (the stated persona has 60+ customers):
  // a status filter that only offers the statuses actually present, and a
  // sort that defaults to the partner's own manual (drag) order.
  const [sortMode, setSortMode] = useState<SortMode>(readStoredSortMode);
  const [statusFilter, setStatusFilter] = useState<'all' | Organization['status']>('all');
  const changeSortMode = (mode: SortMode) => {
    setSortMode(mode);
    try {
      window.localStorage.setItem(ORG_LIST_SORT_STORAGE_KEY, mode);
    } catch {
      /* per-browser nicety only; nothing depends on it persisting */
    }
  };
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [draggedOrgId, setDraggedOrgId] = useState<string | null>(null);
  /**
   * True from the moment a reorder PATCH is issued until its reconciliation
   * settles. Dragging is disabled meanwhile, which SERIALIZES reorders: every
   * stale-order race on this page needs a second drag to start while the first
   * request (or its reconciling GET) is still in flight, so removing that
   * overlap removes the class rather than guarding each instance.
   *
   * Before this change the overlap was blocked only as a side effect of the
   * full-page loading spinner unmounting the draggable rows — which the silent
   * reconciliation above deliberately no longer does.
   */
  const [reorderPending, setReorderPending] = useState(false);
  const [dragOverOrgId, setDragOverOrgId] = useState<string | null>(null);
  /**
   * Roving tabindex for the org list. Exactly one row's controls are in the
   * Tab order at a time (`activeOrgId` below); the arrow keys move that row
   * without selecting it, so a keyboard user can walk 60 rows in 60
   * keystrokes instead of 240 Tab stops, and only fires the sites fetch on
   * Enter/Space. A ref map, not `document.querySelector`, finds the button
   * to focus.
   */
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const rowSelectRefs = useRef(new Map<string, HTMLButtonElement>());
  /** Last keyboard reorder, read out by the polite live region below the
   *  list — the visual row move is invisible to a screen reader. */
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');

  // Archived-organizations section state. Collapsed by default and fetched
  // ONLY on expand (`includeArchived=true`) — deliberately NOT threaded through
  // `fetchOrganizations`/the org store's own page walk (orgStore.ts), which
  // stays on the plain unarchived query every other reader of it relies on.
  // Archived orgs live in their own array rather than merged into
  // `organizations`, so the active list, its search, drag-reorder, and the
  // hash-based deep-link effect never have to know archived rows exist.
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [archivedOrgs, setArchivedOrgs] = useState<Organization[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState<string>();
  // Mirrors the list endpoint's own `archivedTruncated` (archived rows are
  // capped at the page limit rather than paginated — see orgs.ts) so the
  // section can say "there are more" instead of silently showing a short list.
  const [archivedTruncated, setArchivedTruncated] = useState(false);
  // Which archived org id is mid-restore, so only THAT row's button shows a
  // busy state — `submitting`/`siteSubmitting` are page/site-modal-scoped and
  // would incorrectly disable every other control if reused here.
  const [restoringOrgId, setRestoringOrgId] = useState<string | null>(null);
  // Monotonic request id for the archived fetch. The search-driven refetch
  // (see the debounced effect below) can overlap: a full page walk is slow
  // enough that an OLDER (e.g. broader, pre-search) request can still be
  // in flight when a NEWER (narrower) one is fired, and nothing guarantees
  // they resolve in request order. Every call captures the id current at its
  // own start and re-checks it before touching state, so a stale response
  // — even one that resolves last — can never clobber a newer one's results
  // (or its loading flag). A `ref`, not state: it's pure bookkeeping and must
  // never itself trigger a re-render.
  const archivedRequestIdRef = useRef(0);

  // Sites state — CRUD state and handlers moved to `useSiteCrud` (#5075 W02) so
  // the organization record's Sites tab can share the exact same behaviour.
  const siteCrud = useSiteCrud(selectedOrg?.id ?? null, { onUnauthorized: handleSessionExpired, t });

  // The selected org's summary counts (`GET /orgs/organizations/:id/summary`,
  // the same read the record page's overview tiles use). "N devices" was the
  // only fleet fact this page had; a manager could not read health from it
  // and a tech could not triage from it. Sections the caller cannot read are
  // absent from the payload, so the strip hides a tile rather than showing a
  // false zero. Latest-wins guarded: arrowing through rows fires overlapping
  // reads, and a slow one must not repaint a stale customer's counts.
  const [summary, setSummary] = useState<OrgSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const summaryLatest = useLatest<OrgSummary | null>();
  const loadSummary = useCallback(
    async (orgId: string) => {
      const next = await summaryLatest.run(
        makeOrgFetch(orgId)(`/orgs/organizations/${orgId}/summary`)
          .then(async (res) => (res.ok ? ((await res.json()) as OrgSummary) : null))
          .catch(() => null),
      );
      if (next === undefined) return; // superseded by a newer selection
      // A payload without the always-present `sites` block is not a summary
      // (e.g. an unexpected envelope); treat it as unavailable, not as empty.
      const usable = next && typeof next === 'object' && next.sites ? next : null;
      setSummary(usable);
      setSummaryFailed(usable === null);
    },
    [summaryLatest],
  );
  // Partner's configured timezone, used to pre-select the timezone for new sites
  // instead of falling back to UTC. Undefined until loaded / if unavailable.
  const [partnerTimezone, setPartnerTimezone] = useState<string>();
  // When org creation has already fetched sites synchronously for a freshly
  // created org, record its id here so the selectedOrg effect skips the
  // redundant duplicate GET it would otherwise fire (#1978 follow-up).
  const skipSiteFetchForOrgId = useRef<string | null>(null);

  const presentStatuses = useMemo(
    () => FILTERABLE_STATUSES.filter((status) => organizations.some((org) => org.status === status)),
    [organizations],
  );

  // A filter whose status just left the list (its last org was archived or
  // merged away) would leave an empty list behind a chip that no longer
  // exists; fall back to the full list instead.
  useEffect(() => {
    if (statusFilter !== 'all' && !presentStatuses.includes(statusFilter)) setStatusFilter('all');
  }, [presentStatuses, statusFilter]);

  const filteredOrgs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let rows = organizations;
    if (q) rows = rows.filter(org => org.name.toLowerCase().includes(q));
    if (statusFilter !== 'all') rows = rows.filter(org => org.status === statusFilter);
    if (sortMode === 'name') {
      rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === 'devices') {
      rows = [...rows].sort((a, b) => (b.deviceCount ?? 0) - (a.deviceCount ?? 0) || a.name.localeCompare(b.name));
    }
    return rows;
  }, [organizations, searchQuery, statusFilter, sortMode]);

  /** Manual (drag / arrow-key) ordering only means something against the
   *  full, server-ordered list: a search, a filter or another sort hides
   *  rows, so a move's neighbours would not be its real neighbours. */
  const manualOrderActive = sortMode === 'manual' && statusFilter === 'all' && searchQuery.trim().length === 0;

  /**
   * Client-side re-filter of whatever archived rows are already loaded, using
   * the SAME search box as `filteredOrgs` above. This is deliberately in
   * addition to — not instead of — forwarding `search` to the server fetch
   * (see `fetchArchivedOrganizations`): the network round trip means
   * `archivedOrgs` can briefly still hold the previous query's results after a
   * keystroke, and filtering client-side too avoids flashing those stale rows
   * before the fresh, server-filtered set lands. Once it lands this filter is
   * a no-op (the loaded rows already match), so it costs nothing steady-state.
   */
  const filteredArchivedOrgs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return archivedOrgs;
    return archivedOrgs.filter(org => org.name.toLowerCase().includes(q));
  }, [archivedOrgs, searchQuery]);

  /** The one row whose controls are in the Tab order: the last row the
   *  arrow keys landed on, else the selected org, else the first row —
   *  always re-resolved against the CURRENT filtered list so a search that
   *  hides the remembered row never leaves the list with no tab stop. */
  const activeOrgId = useMemo(() => {
    if (activeRowId && filteredOrgs.some(org => org.id === activeRowId)) return activeRowId;
    if (selectedOrg && filteredOrgs.some(org => org.id === selectedOrg.id)) return selectedOrg.id;
    return filteredOrgs[0]?.id ?? null;
  }, [activeRowId, filteredOrgs, selectedOrg]);

  /** Renders an archived org's purge countdown, shared by the row and the
   *  read-only detail pane. `purgeAt: null` (retention "Never") and an
   *  unparseable timestamp both collapse to "kept indefinitely" via
   *  `purgeCountdownDays` — see its own doc comment for why those two cases
   *  are deliberately indistinguishable here. */
  const renderPurgeCountdown = (purgeAt: string | null | undefined): string => {
    const days = purgeCountdownDays(purgeAt);
    if (days === null) return t('organizationsPage.archived.keptIndefinitely');
    if (days <= 0) return t('organizationsPage.archived.purgeToday');
    return t('organizationsPage.archived.purgeCountdown', { count: days });
  };

  /**
   * Label + colour for an archive-lifecycle row's badge, shared by the list row
   * and the read-only detail pane. An org still DRAINING toward `archived`
   * reads "Archiving…" in the offboarding colour; a settled one reads
   * "Archived". Both are read-only and both live in the Archived section — the
   * distinction is only whether the agent uninstall is still running (#4166),
   * which is what tells an operator "the Archive click DID take effect" instead
   * of leaving them staring at a list the org vanished from.
   */
  const archiveBadge = (org: Pick<Organization, 'status'>) =>
    org.status === 'offboarding'
      ? { label: t('organizationsPage.archived.archivingBadge'), color: statusColors.offboarding }
      : { label: t('organizationsPage.archived.badge'), color: statusColors.archived };

  /**
   * `silent` skips the page-level loading flag. `loading` is an EARLY RETURN
   * that replaces the whole page with a spinner, which is right for the first
   * load and wrong for a background reconciliation: the reorder catch would
   * otherwise blank the list the user is looking at, right as its error toast
   * appears, and take their scroll position and selected org with it.
   */
  const fetchOrganizations = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    try {
      if (!silent) setLoading(true);
      setError(undefined);
      const organizations = await fetchAllOrganizations<Organization>(async (page, limit) => {
        const response = await fetchWithAuth(`/orgs/organizations?page=${page}&limit=${limit}`);
        if (!response.ok) {
          if (response.status === 401) {
            // handleSessionExpired, NOT a bare navigateTo('/login'): this GET
            // runs immediately after a successful create/delete (via
            // refreshOrgs), so its 401 lands while fetchWithAuth may already
            // have started the real expiry redirect — which carries `next` and
            // `reason`. A second, bare navigation replaces that destination
            // with a plain /login. handleSessionExpired is idempotent
            // (sessionExpiryInFlight), so calling it here either no-ops into
            // the redirect already running, or performs the full logout for a
            // 401 that survived a SUCCESSFUL refresh — the case where
            // fetchWithAuth returns the 401 without handling it at all.
            handleSessionExpired();
            return null;
          }
          throw new Error(t('organizationsPage.errors.fetchOrganizations'));
        }
        return response.json();
      });
      if (organizations === null) return;
      setOrganizations(organizations);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  /**
   * Fetches the Archived section's contents. Reuses `fetchAllOrganizations`
   * (the same page-walking helper `fetchOrganizations` above uses) rather than
   * a bespoke single-page GET: archived orgs ride along on only the LAST live
   * page (`isFinalOrganizationsPage`, orgs.ts), so a partner with more than one
   * page of live orgs would silently see an empty Archived section on a
   * single-page fetch. Walking every page and filtering to `archived === true`
   * costs nothing extra for the common case (one page) and stays correct for
   * the uncommon one, at the cost of one throwaway array per open — cheap next
   * to a GDPR-relevant tenant silently going missing from its own purge queue.
   *
   * Deliberately NOT threaded through the org store's own page walk
   * (`orgStore.ts`) or `fetchOrganizations` above: both stay on the plain
   * unarchived query every other caller of them expects, and this is the one
   * reader that opts in to `includeArchived=true`.
   *
   * `search` is forwarded as the API's own `search` query param (same one
   * `fetchOrganizations`'s active-list query would use, and the one
   * `listArchivedOrgs` filters archived rows by server-side — orgs.ts,
   * archivedOrgReads.ts). Without this, the truncation note's "search to
   * narrow the list" was a dead end: the page's search box only filtered
   * whatever was already loaded, so an archived org past the truncation cap
   * could never be reached by any partner with more archived orgs than the
   * page limit.
   */
  const fetchArchivedOrganizations = useCallback(async (search: string) => {
    // Claim this call as "current" BEFORE the first await — a later call
    // (another keystroke) bumps this again and thereby supersedes it. Every
    // state-touching point below re-checks `requestId === archivedRequestIdRef.current`
    // so a stale response is inert even if it resolves after the current one.
    const requestId = ++archivedRequestIdRef.current;
    setArchivedLoading(true);
    setArchivedError(undefined);
    let truncated = false;
    try {
      const all = await fetchAllOrganizations<Organization>(async (page, limit) => {
        const searchParam = search ? `&search=${encodeURIComponent(search)}` : '';
        const response = await fetchWithAuth(`/orgs/organizations?page=${page}&limit=${limit}&includeArchived=true${searchParam}`);
        if (!response.ok) {
          if (response.status === 401) {
            handleSessionExpired();
            return null;
          }
          throw new Error(t('organizationsPage.archived.errors.fetch'));
        }
        const body = await response.json();
        // Present only on the page that actually carries the archived block
        // (orgs.ts) — a page that never looked must not overwrite a `true`
        // already captured from an earlier page in this same walk.
        if (typeof body?.archivedTruncated === 'boolean') truncated = body.archivedTruncated;
        return body;
      });
      // A newer search/expand superseded this request while its page walk was
      // still in flight. Applying these results now — even though they just
      // arrived — would clobber whatever the newer request already rendered
      // (or is about to): the exact race this guard exists to close.
      if (requestId !== archivedRequestIdRef.current) return;
      if (all === null) return;
      setArchivedOrgs(all.filter((org) => org.archived === true));
      setArchivedTruncated(truncated);
    } catch (err) {
      if (requestId !== archivedRequestIdRef.current) return;
      setArchivedError(err instanceof Error ? err.message : t('organizationsPage.errors.generic'));
    } finally {
      // Only the current request may clear the busy flag — an old request's
      // finally firing after a newer one started must not flip the spinner
      // off out from under the request that's still actually in flight.
      if (requestId === archivedRequestIdRef.current) setArchivedLoading(false);
    }
  }, [t]);

  // Refresh both the local list and the global org store (consumed by the
  // side nav). Using allSettled so a sidebar-refresh hiccup doesn't undo the
  // user-visible success of the create/delete that already committed.
  const refreshOrgs = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchOrganizations(),
      useOrgStore.getState().fetchOrganizations(),
    ]);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected && rejected.status === 'rejected') {
      console.warn('[OrganizationsPage] org refresh partially failed', rejected.reason);
    }
  }, [fetchOrganizations]);

  useEffect(() => {
    fetchOrganizations();
  }, [fetchOrganizations]);

  // Fetch-on-expand: the Archived section starts collapsed and empty, and only
  // issues the `includeArchived=true` request the moment it's opened — not on
  // page mount. Also re-fires whenever the page's own search box changes
  // while expanded, forwarding the term as the API's `search` param — the
  // same box that filters the active list above doubles as the archived
  // section's search, so a >100-row partner can still reach an archived org
  // past the truncation cap. No "already fetched" cache: every expand/search
  // change re-issues the request, which is cheap next to a stale purge
  // countdown or an unreachable archived tenant.
  //
  // Debounced (mirrors `DistributorLookup.tsx`'s nightly search): a full page
  // walk is real network work, expensive enough to still be in flight when
  // the next keystroke fires another one. The debounce cuts the number of
  // overlapping requests way down; the request-token guard inside
  // `fetchArchivedOrganizations` is what makes an overlap that DOES still
  // happen (e.g. a slow response outliving the 300ms window) harmless rather
  // than a race where a stale reply can clobber a fresher one.
  useEffect(() => {
    if (!archivedExpanded) return;
    const timer = setTimeout(() => {
      void fetchArchivedOrganizations(searchQuery.trim());
    }, ARCHIVED_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [archivedExpanded, searchQuery, fetchArchivedOrganizations]);

  // Load the partner's default timezone once so new sites pre-select it.
  // Best-effort: on any failure we silently fall back to the form's UTC default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth('/orgs/partners/me');
        if (!response.ok) return;
        const data = await response.json();
        // Mirror PartnerSettingsPage's resolution order: the partner timezone
        // is a first-class `partners.timezone` column (#1318) that the settings
        // JSONB key only shadows. Reading the key alone silently pre-selects
        // UTC for every new site of a partner whose zone reached the column —
        // the same wrong-default symptom as #2856, one layer up.
        const tz = data?.settings?.timezone || data?.timezone;
        if (!cancelled && typeof tz === 'string' && tz) setPartnerTimezone(tz);
      } catch {
        /* best-effort; keep UTC default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-select org from URL param on initial load
  useEffect(() => {
    if (initialOrgId && organizations.length > 0 && !selectedOrg) {
      const match = organizations.find(o => o.id === initialOrgId);
      if (match) setSelectedOrg(match);
    }
  }, [initialOrgId, organizations, selectedOrg]);

  useEffect(() => {
    if (selectedOrg) {
      // An archive-lifecycle org (archived, or mid-archive-drain — #4166) is
      // outside the request's own accessible-org set by design (RLS excludes it
      // from `accessibleOrgIds`), so its sites read would come back an empty
      // array regardless of the real count — reading that as "confirmed zero
      // sites" would be a lie. The read-only detail pane has no sites section
      // anyway, so skip the request outright.
      if (isArchiveLifecycleOrg(selectedOrg)) {
        siteCrud.clear();
        setSummary(null);
        setSummaryFailed(false);
        return;
      }
      void loadSummary(selectedOrg.id);
      // Skip the fetch if org creation already fetched sites for this org
      // synchronously — avoids a redundant concurrent GET per create.
      if (skipSiteFetchForOrgId.current === selectedOrg.id) {
        skipSiteFetchForOrgId.current = null;
        return;
      }
      siteCrud.refresh();
    } else {
      siteCrud.clear();
      setSummary(null);
      setSummaryFailed(false);
    }
  }, [selectedOrg, siteCrud.refresh, siteCrud.clear, loadSummary]);

  // Org handlers
  const handleAdd = () => {
    setModalMode('add');
  };

  const handleEdit = (org: Organization) => {
    void navigateTo(`/settings/organizations/${org.id}`);
  };

  const handleArchive = (org: Organization) => {
    setSelectedOrg(org);
    setModalMode('archive');
  };

  /**
   * Called by ArchiveOrgModal the moment its archive POST reports 202.
   * LIST-STATE UPDATE ONLY — mirrors handleMergeComplete: the modal stays open
   * on its own `done` phase so the operator can see the purge-date summary,
   * so this must not close the modal or touch `selectedOrg`.
   */
  const handleArchiveComplete = (archivedId: string) => {
    setOrganizations(prev => prev.filter(o => o.id !== archivedId));
  };

  /**
   * The done-phase summary's explicit Close button. `selectedOrg` here is the
   * org that was just archived (handleArchiveComplete already dropped it from
   * the active list), so it's cleared too — mirrors handleMergeDoneClose.
   */
  const handleArchiveDoneClose = () => {
    setSelectedOrg(null);
    handleCloseModal();
  };

  const handleMerge = (org: Organization) => {
    setSelectedOrg(org);
    setModalMode('merge');
  };

  /**
   * Called by MergeOrgModal once its merge-runs poll reports a genuine
   * `completed` result. LIST-STATE UPDATE ONLY — deliberately does not close
   * the modal or touch `selectedOrg`. MergeOrgModal stays open on its own
   * `done` phase so the operator can actually see the result summary; if this
   * closed the modal too, the summary would be unmounted the instant it
   * appeared (React 18 batches this call with the child's own `setPhase`
   * update into one render).
   *
   * NOT a `refreshOrgs()` — the merged-away org is not soft-deleted, it ends
   * up a terminal `status='merging'` shell with `deleted_at IS NULL`
   * (services/orgMerge.ts), so a refetch would still return it. The local
   * filter is the only way to actually drop it from this screen.
   */
  const handleMergeComplete = (loserId: string) => {
    setOrganizations(prev => prev.filter(o => o.id !== loserId));
  };

  /**
   * The done-phase summary's explicit Close button. Unlike a plain
   * `handleCloseModal()`, `selectedOrg` here is known to be the org that was
   * JUST merged away (handleMergeComplete already dropped it from the list),
   * so it's cleared too — mirrors handleArchiveDoneClose's selectedOrg-clearing
   * behavior. A plain Cancel out of the pick/failed phases (before anything
   * merged) must NOT clear it, which is why this is a separate handler
   * rather than folded into `onClose`.
   */
  const handleMergeDoneClose = () => {
    setSelectedOrg(null);
    handleCloseModal();
  };

  const handleSelectOrg = (org: Organization) => {
    setSelectedOrg(prev => prev?.id === org.id ? prev : org);
    setActiveRowId(org.id);
    siteCrud.close();
    window.location.hash = org.id;
  };

  /** Same ritual as the record page's "Work in this org": the switch
   *  re-navigates this page under the new scope, so no local state to keep. */
  const handleWorkHere = (org: Organization) => {
    void applyOrgSwitch(org.id, t('organizations:orgRecord.actions.workHereToast', { orgName: org.name }));
  };

  /** Arrow/Home/End on a row's select button: move focus and the roving tab
   *  stop, never the selection (see `activeRowId`). */
  const handleRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, filteredOrgs.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = filteredOrgs.length - 1;
    if (next === null) return;
    event.preventDefault();
    if (next === index) return;
    const target = filteredOrgs[next];
    setActiveRowId(target.id);
    rowSelectRefs.current.get(target.id)?.focus();
  };

  const handleToggleArchived = () => {
    setArchivedExpanded(prev => !prev);
  };

  /** Maps the restore route's error tokens to localized copy. MFA is a real
   *  machine `code`; the purging refusal is matched on its literal backend
   *  text (see `RESTORE_PURGING_ERROR_TEXT`'s comment for why). Anything else
   *  (e.g. a plain 409 for a status that can't be restored) falls through to
   *  the raw backend message via `runAction`'s default handling. */
  const restoreFriendly = (code: string) => {
    if (code === 'MFA_REQUIRED') return t('organizationsPage.restore.errors.mfaRequired');
    if (code === RESTORE_PURGING_ERROR_TEXT) return t('organizationsPage.restore.errors.purging');
    return undefined;
  };

  /**
   * Restores an archived org. This page's OWN list state is updated
   * synchronously/optimistically, mirroring the archive/merge complete
   * handlers above: drop it from `archivedOrgs`, add it back to the active
   * `organizations` list under the status the API reports (its PRE-archive
   * status — restoring a suspended org lands it back suspended, not active),
   * and re-select it so the detail pane switches out of read-only
   * immediately. Deliberately not a `refreshOrgs()` (which also re-fetches
   * this page's OWN list): that would re-fetch the plain list and could race
   * this optimistic update, and everything the active list needs
   * (id/name/status/deviceCount/createdAt) already rode along on the archived
   * row itself.
   *
   * The global org store (`orgStore.ts`, feeds the org-switcher/sidebar) is a
   * SEPARATE concern from this page's own state and doesn't share that
   * optimistic update — it has to hear about the restored org from the server
   * to pick up fields this page never had (partnerId, currencyCode, trial
   * end date). Fired fire-and-forget, same as `refreshOrgs` does for org
   * create: it must not block clearing `restoringOrgId` or block/replace the
   * success toast, and a failure here is a stale switcher entry, not a
   * failed restore — the restore itself already committed.
   */
  const handleRestore = async (org: Organization) => {
    setRestoringOrgId(org.id);
    try {
      const data = await runAction<{ status: string; recreateRequired: string[] }>({
        request: () => fetchWithAuth(`/orgs/organizations/${org.id}/restore`, { method: 'POST' }),
        errorFallback: t('organizationsPage.restore.errors.restore'),
        friendly: restoreFriendly,
        onUnauthorized: handleSessionExpired,
      });

      const restoredStatus = data.status as Organization['status'];
      // Clear every archive-lifecycle marker, not just `archived`: a restored
      // archive DRAIN keeps `offboardingTarget: 'archive'` in the stale local
      // object otherwise, and the server has already reset it.
      const restoredOrg: Organization = {
        ...org,
        status: restoredStatus,
        archived: undefined,
        purgeAt: undefined,
        offboardingTarget: undefined,
      };

      setArchivedOrgs(prev => prev.filter(o => o.id !== org.id));
      setOrganizations(prev => [...prev, restoredOrg]);
      setSelectedOrg(restoredOrg);
      useOrgStore.getState().fetchOrganizations().catch((storeErr) => {
        console.warn('[OrganizationsPage] org store refresh failed after restore', storeErr);
      });

      const parts = [t('organizationsPage.restore.success', { name: org.name, status: t(/* i18n-dynamic */ statusLabelKeys[restoredStatus]) })];
      if (data.recreateRequired.length > 0) {
        parts.push(t('organizationsPage.restore.recreateRequiredNote', { items: data.recreateRequired.join('; ') }));
      }
      if (restoredStatus === 'suspended') {
        parts.push(t('organizationsPage.restore.suspendedNote'));
      }
      showToast({ message: parts.join(' '), type: 'success' });
    } catch (err) {
      // runAction already toasted (the friendly copy above for MFA/purging, or
      // the raw backend message for anything else, e.g. a 409). onUnauthorized
      // handles a 401 redirect. Only a non-ActionError escape needs a fallback.
      handleActionError(err, t('organizationsPage.restore.errors.restore'));
    } finally {
      setRestoringOrgId(null);
    }
  };

  const persistOrganizationOrder = useCallback(async (orderedIds: string[]) => {
    setReorderPending(true);
    try {
      // runAction, not setError: this handler was SILENT. It set the page error
      // and then called fetchOrganizations() to revert the optimistic order —
      // and that function calls setError(undefined) before its first await, so
      // React batches the two updates and renders no failure at all. A toast
      // survives the refetch.
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/organizations/order', {
            method: 'PATCH',
            body: JSON.stringify({ orderedIds })
          }),
        errorFallback: t('organizationsPage.errors.saveOrder'),
        onUnauthorized: handleSessionExpired,
      });
    } catch {
      // Re-fetch the authoritative order. Two earlier attempts were wrong in
      // instructive ways, so the reasoning is worth keeping:
      //
      //   1. Skipping reconciliation for status 0 (to dodge a redirect race)
      //      left an ordinary dropped connection showing an order the server
      //      never accepted, with only a transient toast and no correction.
      //   2. Restoring a locally captured pre-drag array fixes that but CANNOT
      //      be correct: `runAction` collapses every request-side throw to
      //      status 0, so a PATCH that COMMITTED and then lost its response is
      //      indistinguishable from one that never arrived. Restoring locally
      //      would then show an order the server does not have — the same
      //      lie, in the other direction. It also races an in-flight
      //      authoritative GET and can clobber newer data with an older
      //      snapshot.
      //
      // Only the server knows what actually persisted, so the closest thing to
      // a correct answer is to ask it. Two limits, stated rather than implied:
      //
      //   - A slow GET could install an order that a later reorder already
      //     superseded. That needs a SECOND drag to overlap the first request,
      //     which `reorderPending` now prevents by disabling dragging until
      //     this settles. A client generation counter was tried first and
      //     reverted: it discarded genuinely current create/delete/import
      //     refreshes — leaving a newly created org invisible — while still
      //     not covering a GET resolving during an in-flight PATCH.
      //     Serializing the drags removes the overlap those guards were
      //     chasing. Two reorders from SEPARATE TABS can still interleave;
      //     that one needs a revision or compare-and-swap on the endpoint,
      //     which has neither.
      //   - Reconciliation used to be authoritative only up to the FIRST page:
      //     the list endpoint paged by `created_at, id` and applied the
      //     partner's preferred order only WITHIN each page, so a drag that
      //     crossed a page boundary could not survive the refetch. Fixed
      //     server-side in #4004 — the preferred order is now the leading
      //     ORDER BY term of the paginated query, so the page walk returns the
      //     stored order end to end and this GET is authoritative for the whole
      //     list.
      //
      // The refetch was previously unsafe purely because fetchOrganizations
      // answered its own 401 with a bare navigateTo('/login'), which raced the
      // richer session-expiry redirect. That is fixed at its source above, so
      // the 401 path of this second GET is idempotent.
      await fetchOrganizations({ silent: true });
    } finally {
      setReorderPending(false);
    }
  }, [fetchOrganizations, t]);

  const handleOrgDragStart = (event: DragEvent<HTMLLIElement>, org: Organization) => {
    setDraggedOrgId(org.id);
    event.dataTransfer.effectAllowed = 'move';
    // Firefox requires data to be set or the drag won't fire.
    try { event.dataTransfer.setData('text/plain', org.id); } catch { /* noop */ }
  };

  const handleOrgDragOver = (event: DragEvent<HTMLLIElement>, org: Organization) => {
    if (!draggedOrgId || draggedOrgId === org.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dragOverOrgId !== org.id) setDragOverOrgId(org.id);
  };

  const handleOrgDragLeave = (event: DragEvent<HTMLLIElement>) => {
    // Only clear when leaving the row entirely, not when entering a child.
    const related = event.relatedTarget as Node | null;
    if (!related || !(event.currentTarget as Node).contains(related)) {
      setDragOverOrgId(null);
    }
  };

  const handleOrgDrop = (event: DragEvent<HTMLLIElement>, targetOrg: Organization) => {
    event.preventDefault();
    setDragOverOrgId(null);
    const sourceId = draggedOrgId;
    setDraggedOrgId(null);
    if (!sourceId || sourceId === targetOrg.id) return;

    const sourceIndex = organizations.findIndex(o => o.id === sourceId);
    const targetIndex = organizations.findIndex(o => o.id === targetOrg.id);
    if (sourceIndex === -1 || targetIndex === -1) return;

    const next = [...organizations];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    setOrganizations(next);
    void persistOrganizationOrder(next.map(o => o.id));
  };

  const handleOrgDragEnd = () => {
    setDraggedOrgId(null);
    setDragOverOrgId(null);
  };

  /**
   * Keyboard reorder: the same splice-and-persist as `handleOrgDrop`, one
   * step at a time. Only offered when dragging is (the handle is not
   * rendered while a search filter is active or a reorder is in flight), so
   * the two paths can never disagree about whether a move is allowed. The
   * moved row keeps focus across the re-render because React keys the rows
   * by id, so a held arrow key walks the org through the list.
   */
  const moveOrganization = (org: Organization, delta: -1 | 1) => {
    const sourceIndex = organizations.findIndex(o => o.id === org.id);
    if (sourceIndex === -1) return;
    const targetIndex = sourceIndex + delta;
    if (targetIndex < 0 || targetIndex >= organizations.length) return;
    const next = [...organizations];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    setOrganizations(next);
    setReorderAnnouncement(
      t('organizationsPage.list.movedAnnouncement', {
        name: org.name,
        position: targetIndex + 1,
        total: next.length,
      }),
    );
    void persistOrganizationOrder(next.map(o => o.id));
  };

  const handleReorderKeyDown = (event: KeyboardEvent<HTMLButtonElement>, org: Organization) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    moveOrganization(org, event.key === 'ArrowUp' ? -1 : 1);
  };

  const handleCloseModal = () => {
    setModalMode('closed');
  };

  const handleSubmit = async (values: OrganizationFormValues) => {
    setSubmitting(true);
    try {
      // runAction, not setError. The failure has to be VISIBLE, and the page
      // error banner is not: it renders outside this modal, which stays open on
      // failure behind a `fixed inset-0 z-50` overlay, so the message landed
      // underneath the form the user is still looking at. Nothing is rendered
      // inside the dialog itself. The toast container is mounted after the page
      // slot in DashboardLayout at the same z-50, so it paints above the
      // overlay — which is what makes the API's own text reachable at all.
      const createdOrg = await runAction<{ id?: string } | null>({
        request: () =>
          fetchWithAuth('/orgs/organizations', {
            method: 'POST',
            body: JSON.stringify(values)
          }),
        errorFallback: t('organizationsPage.errors.saveOrganization'),
        onUnauthorized: handleSessionExpired,
        parseSuccess: (data) => (data ?? null) as { id?: string } | null,
      });

      await refreshOrgs();
      handleCloseModal();

      // Select the new org. Only nudge the user into the "add the first site"
      // flow when we positively confirm the org has zero sites — a default site
      // may already exist (e.g. the partner's bootstrap org ships with one), in
      // which case the first-site nag would be misleading. We need the count
      // synchronously to make this decision, so call fetchSites directly rather
      // than rely on the selectedOrg effect's fire-and-forget refresh. On a
      // fetch failure (null) we skip the nag rather than guess.
      if (createdOrg?.id) {
        const newOrg: Organization = {
          id: createdOrg.id,
          name: values.name,
          status: values.status,
          deviceCount: 0,
          createdAt: new Date().toISOString()
        };
        // We fetch sites synchronously just below, so tell the selectedOrg
        // effect to skip the duplicate GET it would otherwise fire for this org.
        skipSiteFetchForOrgId.current = createdOrg.id;
        setSelectedOrg(newOrg);
        window.location.hash = createdOrg.id;

        // Explicit override, not the hook's bound orgId: `setSelectedOrg` above
        // hasn't re-rendered yet, so `siteCrud` is still closed over the
        // PREVIOUS selected org at this point in the handler.
        const existingSites = await siteCrud.refresh(createdOrg.id);
        if (existingSites?.length === 0) {
          siteCrud.openAdd();
          siteCrud.setGuidingFirstSite(true);
        }
      }
    } catch (err) {
      // runAction already surfaced an ActionError as a toast, and onUnauthorized
      // is redirecting on 401 — re-storing either in the page banner would be a
      // second, INVISIBLE copy (it renders behind this modal). Only a
      // non-ActionError escaped runAction untoasted, so only that is surfaced.
      if (!(err instanceof ActionError)) {
        // A toast, NOT setError. The modal is still open on failure and the
        // page banner renders behind its `fixed inset-0 z-50` overlay, so
        // routing an unexpected error there reproduces the exact invisibility
        // this change removes. Reachable in practice: `runAction` calls
        // `onUnauthorized` OUTSIDE its request try/catch, so a throw from
        // handleSessionExpired's logout or location.replace arrives here as a
        // non-ActionError.
        showToast({
          message: err instanceof Error ? err.message : t('organizationsPage.errors.generic'),
          type: 'error'
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Site handlers — moved to `useSiteCrud` (#5075 W02); `siteCrud` above.

  // The first load keeps the page frame (header, actions, empty panel) and
  // shows a skeleton list where the rows will land, instead of replacing the
  // whole page with a spinner. Later non-silent refreshes (after a create or
  // import) already have rows to show and never flash the skeleton.
  const initialLoading = loading && organizations.length === 0;

  if (error && organizations.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => void fetchOrganizations()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('organizationsPage.actions.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header. Actions drop under the title on narrow screens instead
          of squeezing it into a two-line wrap beside two-line buttons. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('organizationsPage.title')}</h1>
          <p className="text-muted-foreground">{t('organizationsPage.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="bulk-org-import-toggle"
            onClick={() => setShowBulkImport((v) => !v)}
            className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-muted"
          >
            {t('bulkOrgImport.title')}
          </button>
          <button
            type="button"
            onClick={handleAdd}
            className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {t('organizationsPage.actions.addOrganization')}
          </button>
        </div>
      </div>

      {showBulkImport && (
        <BulkOrgImport
          onImported={() => void fetchOrganizations()}
          onClose={() => setShowBulkImport(false)}
          onUnauthorized={handleSessionExpired}
        />
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Split view: org list (left) + detail panel (right). The list is the
          navigator: it keeps its own scroll box and stays put while the
          panel scrolls, and the panel is only as tall as its content rather
          than stretched to the list's height with nothing in it. */}
      {/* `minmax(0, 1fr)` on purpose: a bare `1fr` (and the implicit single
          column below `lg`) has an `auto` minimum, so any non-wrapping content
          — a row of action buttons — widened the track past the viewport and
          the whole page scrolled sideways on a phone. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(320px,26%)_minmax(0,1fr)] lg:items-start">
        {/* Left panel - Organization list */}
        <div className="rounded-lg border bg-card shadow-xs lg:sticky lg:top-6">
          <div className="border-b px-4 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('organizationsPage.list.title')}
            </h2>
            <input
              type="search"
              placeholder={t('organizationsPage.list.searchLabel')}
              aria-label={t('organizationsPage.list.searchLabel')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="mt-2 h-8 w-full rounded-md border bg-background px-2.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            {/* Status chips only for statuses present (exception-only, like
                the row pills); the sort select sits at the end of the row.
                Both hide manual reordering while they narrow or reorder the
                list. */}
            <div className="mt-2 flex items-start gap-2">
              {presentStatuses.length > 0 && (
                <div
                  role="group"
                  aria-label={t('organizationsPage.list.filter.label')}
                  className="flex min-w-0 flex-1 flex-wrap gap-1"
                >
                  {(['all', ...presentStatuses] as const).map((status) => {
                    const pressed = statusFilter === status;
                    return (
                      <button
                        key={status}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() => setStatusFilter(status)}
                        className={`inline-flex h-8 items-center rounded-full border px-2.5 text-xs font-medium transition ${
                          pressed
                            ? 'border-foreground bg-foreground text-background'
                            : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                        }`}
                      >
                        {status === 'all'
                          ? t('organizationsPage.list.filter.all')
                          : t(/* i18n-dynamic */ statusLabelKeys[status])}
                      </button>
                    );
                  })}
                </div>
              )}
              <select
                aria-label={t('organizationsPage.list.sort.label')}
                value={sortMode}
                onChange={(e) => changeSortMode(e.target.value as SortMode)}
                // `py-0` overrides the forms plugin's vertical padding, which
                // otherwise pushes a 28px select's text out of its own box.
                className="ml-auto h-8 shrink-0 rounded-md border bg-background py-0 pl-2 pr-7 text-xs leading-none focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                {SORT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(/* i18n-dynamic */ `organizationsPage.list.sort.${mode}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p id={REORDER_HINT_ID} className="sr-only">
            {t('organizationsPage.list.reorderHint')}
          </p>
          <div
            data-testid="org-reorder-announcement"
            role="status"
            aria-live="polite"
            className="sr-only"
          >
            {reorderAnnouncement}
          </div>

          {/* One scroll region for the active list AND the Archived section:
              the Archived bar sits sticky at the bottom of the box and its
              rows flow on underneath, so there is never a second, stacked
              scroller pushing off the bottom of a 1080p screen. */}
          <div data-testid="org-list-scroll" className="max-h-[calc(100vh-320px)] overflow-y-auto">
            {initialLoading ? (
              <div data-testid="org-list-skeleton" aria-busy="true" className="divide-y">
                <p className="sr-only">{t('organizationsPage.loading')}</p>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="px-3 py-3" aria-hidden="true">
                    <div className="skeleton h-3.5 w-2/3" />
                    <div className="skeleton mt-2 h-3 w-1/3" />
                  </div>
                ))}
              </div>
            ) : filteredOrgs.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {organizations.length === 0
                  ? t('organizationsPage.list.empty')
                  : t('organizationsPage.list.noMatches')}
              </div>
            ) : (
              <ul className="divide-y" aria-label={t('organizationsPage.list.title')}>
                {filteredOrgs.map((org, index) => {
                  const dragEnabled = manualOrderActive && !reorderPending;
                  const isDragging = draggedOrgId === org.id;
                  const isDropTarget = dragOverOrgId === org.id && draggedOrgId !== org.id;
                  const isSelected = selectedOrg?.id === org.id;
                  const rowTabIndex = activeOrgId === org.id ? 0 : -1;
                  return (
                  /* The <li> keeps a click handler as a whole-row hit area for
                     the mouse; the select button inside it is the keyboard
                     and assistive-tech path to the same action, so the row's
                     click is a convenience, never the only route. */
                  <li
                    key={org.id}
                    data-testid={`org-row-${org.id}`}
                    onClick={() => handleSelectOrg(org)}
                    draggable={dragEnabled}
                    onDragStart={dragEnabled ? (e) => handleOrgDragStart(e, org) : undefined}
                    onDragOver={dragEnabled ? (e) => handleOrgDragOver(e, org) : undefined}
                    onDragLeave={dragEnabled ? handleOrgDragLeave : undefined}
                    onDrop={dragEnabled ? (e) => handleOrgDrop(e, org) : undefined}
                    onDragEnd={dragEnabled ? handleOrgDragEnd : undefined}
                    className={`group relative flex cursor-pointer items-start gap-1.5 px-3 py-3 transition [contain-intrinsic-size:auto_60px] [content-visibility:auto] hover:bg-muted/50 ${
                      isSelected
                        ? 'bg-muted/60 border-l-2 border-l-primary'
                        : 'border-l-2 border-l-transparent'
                    } ${isDragging ? 'opacity-50' : ''} ${isDropTarget ? 'border-t-2 border-t-primary' : ''}`}
                  >
                    {dragEnabled && (
                      /* Always visible (dimmed) so manual ordering is
                         discoverable; a real button so it takes focus and
                         moves the row with the arrow keys. */
                      <button
                        type="button"
                        data-testid="org-drag-handle"
                        aria-label={t('organizationsPage.list.reorderHandle', { name: org.name })}
                        aria-describedby={REORDER_HINT_ID}
                        title={t('organizationsPage.list.dragToReorder')}
                        tabIndex={rowTabIndex}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => handleReorderKeyDown(e, org)}
                        className="mt-0.5 shrink-0 cursor-grab rounded p-0.5 text-muted-foreground/40 transition group-hover:text-muted-foreground group-focus-within:text-muted-foreground active:cursor-grabbing"
                      >
                        <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      ref={el => {
                        if (el) rowSelectRefs.current.set(org.id, el);
                        else rowSelectRefs.current.delete(org.id);
                      }}
                      data-testid={`org-select-${org.id}`}
                      aria-current={isSelected ? 'true' : undefined}
                      tabIndex={rowTabIndex}
                      onClick={e => {
                        e.stopPropagation();
                        handleSelectOrg(org);
                      }}
                      onKeyDown={e => handleRowKeyDown(e, index)}
                      className="min-w-0 flex-1 rounded text-left"
                    >
                      <span className="block truncate text-sm font-medium">{org.name}</span>
                      <span className="mt-1 flex items-center gap-2">
                        {/* Exception-only: an org's status is worth a glance
                            only when it's NOT the steady state every other
                            row is in. `active` is the overwhelming majority
                            of rows, so giving it the same pill as every
                            other status just added visual noise the eye had
                            to filter past to spot the rows that actually
                            need attention (trial/suspended/churned/etc). */}
                        {org.status !== 'active' && (
                          <span
                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium leading-none ${statusColors[org.status]}`}
                          >
                            {t(/* i18n-dynamic */ statusLabelKeys[org.status])}
                          </span>
                        )}
                        {/* The one row that IS the current workspace — the
                            same exception-only rule: at most one row ever
                            carries it, so it reads as a landmark, not noise. */}
                        {workspaceOrgId === org.id && (
                          <span
                            data-testid="org-workspace-marker"
                            className="inline-flex items-center rounded-full border border-primary/30 bg-primary/5 px-1.5 py-0.5 text-xs font-medium leading-none text-primary"
                          >
                            {t('organizationsPage.list.workspaceMarker')}
                          </span>
                        )}
                        {shouldShowDeviceCount(org.deviceCount) && (
                          <span className="text-xs text-muted-foreground">
                            {t('organizationsPage.deviceCount', { count: org.deviceCount })}
                          </span>
                        )}
                      </span>
                    </button>

                    {/* Row actions mirror the detail header's two routes —
                        Settings and Open record — and nothing else; the rare
                        lifecycle actions live in the header's More menu.
                        Settings is revealed on hover AND on keyboard focus
                        within the row, so it is never focusable-but-invisible;
                        the record link stays visible so the destination is
                        discoverable without hovering. */}
                    <button
                      type="button"
                      aria-label={t('organizationsPage.actions.openSettingsFor', { name: org.name })}
                      title={t('organizationsPage.actions.openSettings')}
                      tabIndex={rowTabIndex}
                      onClick={e => {
                        e.stopPropagation();
                        handleEdit(org);
                      }}
                      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                    >
                      <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <a
                      href={`/organizations/${org.id}`}
                      data-testid={`org-open-record-${org.id}`}
                      aria-label={t('organizationsPage.actions.openRecordFor', { name: org.name })}
                      title={t('organizationsPage.actions.openRecord')}
                      tabIndex={rowTabIndex}
                      onClick={e => e.stopPropagation()}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                  </li>
                  );
                })}
              </ul>
            )}

            {/* Archived organizations — collapsed by default, fetched only on
                expand. The bar is sticky at the bottom of the shared scroll
                box; expanded rows continue below it in the same box. */}
            <div className="sticky bottom-0 z-10 border-t bg-card">
              <button
                type="button"
                data-testid="org-archived-toggle"
                onClick={handleToggleArchived}
                aria-expanded={archivedExpanded}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50"
              >
                <span>{t('organizationsPage.archived.sectionTitle')}</span>
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${archivedExpanded ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>

            {archivedExpanded && (
              <div data-testid="org-archived-section" className="border-t">
                {archivedLoading ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('organizationsPage.archived.loading')}
                  </div>
                ) : archivedError ? (
                  <div className="px-4 py-4 text-sm text-destructive">
                    {archivedError}
                  </div>
                ) : filteredArchivedOrgs.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {/* Keyed on whether a search is active, NOT on `archivedOrgs.length`:
                        once a search term is present, `archivedOrgs` IS the
                        server-filtered result (see fetchArchivedOrganizations), so an
                        empty array there no longer means "there are truly zero
                        archived orgs" — it means "zero matched this search". */}
                    {searchQuery.trim()
                      ? t('organizationsPage.archived.noMatches')
                      : t('organizationsPage.archived.empty')}
                  </div>
                ) : (
                  <>
                    {archivedTruncated && (
                      <p data-testid="org-archived-truncated-note" className="px-4 py-2 text-xs text-muted-foreground">
                        {t('organizationsPage.archived.truncatedNote', { count: archivedOrgs.length })}
                      </p>
                    )}
                    <ul className="divide-y" aria-label={t('organizationsPage.archived.sectionTitle')}>
                      {filteredArchivedOrgs.map(org => (
                        <li
                          key={org.id}
                          data-testid="org-archived-row"
                          onClick={() => handleSelectOrg(org)}
                          className={`cursor-pointer px-4 py-3 transition hover:bg-muted/50 ${
                            selectedOrg?.id === org.id ? 'bg-muted/60 border-l-2 border-l-primary' : 'border-l-2 border-l-transparent'
                          }`}
                        >
                          <button
                            type="button"
                            data-testid="org-archived-select"
                            aria-current={selectedOrg?.id === org.id ? 'true' : undefined}
                            onClick={e => {
                              e.stopPropagation();
                              handleSelectOrg(org);
                            }}
                            className="block w-full min-w-0 rounded text-left"
                          >
                            <span className="block truncate text-sm font-medium">{org.name}</span>
                            <span className="mt-1 flex items-center gap-2">
                              <span
                                data-testid="org-archived-badge"
                                className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium leading-none ${archiveBadge(org).color}`}
                              >
                                {archiveBadge(org).label}
                              </span>
                              <span data-testid="org-archived-purge" className="text-xs text-muted-foreground">
                                {renderPurgeCountdown(org.purgeAt)}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right panel - Detail view */}
        <div className="rounded-lg border bg-card shadow-xs" data-testid="org-detail-panel">
          {selectedOrg ? (
            isArchiveLifecycleOrg(selectedOrg) ? (
              /* Archive-lifecycle detail — READ-ONLY. No edit/merge/archive
               * buttons: an archived org (and, since #4166, one mid-archive-drain)
               * is outside the request's own accessible-org set by design (RLS),
               * so none of those mutations could succeed against it anyway, and
               * offering them would just produce a confusing 404/409 after the
               * fact. Restore is the only action, and the only way back to the
               * normal (mutable) detail pane — for a drain it is the abort edge
               * `restoreOrgFromArchive` implements, which is the whole reason
               * this row has to be reachable at all. */
              <>
                <div className="border-b px-6 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold">{selectedOrg.name}</h2>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                        <span
                          data-testid="org-archived-detail-badge"
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${archiveBadge(selectedOrg).color}`}
                        >
                          {archiveBadge(selectedOrg).label}
                        </span>
                        <span data-testid="org-archived-detail-purge">
                          {renderPurgeCountdown(selectedOrg.purgeAt)}
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid="org-restore"
                        onClick={() => void handleRestore(selectedOrg)}
                        disabled={restoringOrgId === selectedOrg.id}
                        className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {restoringOrgId === selectedOrg.id
                          ? t('organizationsPage.restore.restoring')
                          : t('organizationsPage.restore.action')}
                      </button>
                    </div>
                  </div>
                </div>
                <div className="p-6 text-sm text-muted-foreground" data-testid="org-archived-readonly-notice">
                  {selectedOrg.status === 'offboarding'
                    ? t('organizationsPage.archived.drainNotice')
                    : t('organizationsPage.archived.readOnlyNotice')}
                </div>
              </>
            ) : (
              <>
                {/* Org header */}
                <div className="border-b px-6 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold">{selectedOrg.name}</h2>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusColors[selectedOrg.status]}`}
                        >
                          {t(/* i18n-dynamic */ statusLabelKeys[selectedOrg.status])}
                        </span>
                        {shouldShowDeviceCount(selectedOrg.deviceCount) && (
                          <span>
                            {t('organizationsPage.deviceCount', { count: selectedOrg.deviceCount })}
                          </span>
                        )}
                        {/* Stated, never implied: when the workspace is a
                            different org, say which — the same chip and
                            wording as the record page — and offer the switch
                            right here. Nothing renders in the fleet view or
                            when the two agree. */}
                        {workspaceOrgId && workspaceOrgId !== selectedOrg.id && workspaceOrgName && (
                          <span className="inline-flex items-center gap-2">
                            <span
                              data-testid="org-scope-chip"
                              title={t('organizationsPage.scope.hint', { orgName: workspaceOrgName })}
                              className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              <Building2 className="h-3 w-3" aria-hidden="true" />
                              {t('organizations:orgRecord.header.scopeChip', { orgName: workspaceOrgName })}
                            </span>
                            <button
                              type="button"
                              data-testid="org-work-here"
                              onClick={() => handleWorkHere(selectedOrg)}
                              className="text-xs font-medium text-primary hover:underline"
                            >
                              {t('organizations:orgRecord.actions.workHere')}
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                    {/* One primary, one secondary, one overflow. Archive and
                        merge are quarterly actions; as permanent red-outline
                        buttons they outweighed Settings and taught the eye to
                        skip the header. Merge (irreversible) keeps the
                        destructive tone inside the menu; archive is reversible
                        and reads as an ordinary item. */}
                    <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                      <button
                        type="button"
                        data-testid="org-open-record"
                        onClick={() => void navigateTo(`/organizations/${selectedOrg.id}`)}
                        className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                      >
                        {t('organizationsPage.actions.openRecord')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEdit(selectedOrg)}
                        className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-muted"
                      >
                        <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('organizationsPage.actions.openSettings')}
                      </button>
                      <ActionMenu
                        label={t('organizationsPage.actions.more')}
                        testId="org-more-actions"
                        items={[
                          {
                            id: 'archive',
                            label: t('organizationsPage.actions.archiveOrganization'),
                            onSelect: () => handleArchive(selectedOrg),
                            testId: 'org-archive-open',
                          },
                          ...(canMergeOrgs
                            ? [
                                {
                                  id: 'merge',
                                  label: t('organizationsPage.merge.openButton'),
                                  onSelect: () => handleMerge(selectedOrg),
                                  tone: 'destructive' as const,
                                  testId: 'org-merge-open',
                                },
                              ]
                            : []),
                        ]}
                      />
                    </div>
                  </div>
                </div>

                {/* Facts strip: the customer at a glance, in the record
                    overview's own words. Tiles come and go with the payload;
                    a failed read says so in one line with a retry, and an
                    empty payload renders nothing rather than zeros. */}
                {summaryFailed ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-6 py-3 text-sm text-muted-foreground">
                    <span>{t('organizations:orgRecord.overview.noSummary')}</span>
                    <button
                      type="button"
                      data-testid="org-facts-retry"
                      onClick={() => void loadSummary(selectedOrg.id)}
                      className="font-medium text-primary hover:underline"
                    >
                      {t('organizationsPage.actions.tryAgain')}
                    </button>
                  </div>
                ) : (
                  summary && (
                    <dl
                      data-testid="org-facts"
                      className="flex flex-wrap gap-x-8 gap-y-3 border-b px-6 py-4"
                    >
                      {summary.devices && (
                        <div className="min-w-32">
                          <dt className="text-xs text-muted-foreground">{t('organizations:orgRecord.overview.tiles.devices')}</dt>
                          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatNumber(summary.devices.total)}</dd>
                          <dd className="text-xs text-muted-foreground tabular-nums">
                            {t('organizations:orgRecord.overview.tiles.devicesSub', {
                              online: formatNumber(summary.devices.online),
                              total: formatNumber(summary.devices.total),
                            })}
                          </dd>
                        </div>
                      )}
                      {summary.alerts && (
                        <div className="min-w-32">
                          <dt className="text-xs text-muted-foreground">{t('organizations:orgRecord.overview.tiles.alerts')}</dt>
                          <dd className={`mt-0.5 text-sm font-semibold tabular-nums ${summary.alerts.critical > 0 ? 'text-destructive' : ''}`}>
                            {formatNumber(summary.alerts.open)}
                          </dd>
                          <dd className="text-xs text-muted-foreground tabular-nums">
                            {t('organizations:orgRecord.overview.tiles.alertsSub', {
                              critical: formatNumber(summary.alerts.critical),
                              high: formatNumber(summary.alerts.high),
                            })}
                          </dd>
                        </div>
                      )}
                      {summary.contracts && (
                        <div className="min-w-32">
                          <dt className="text-xs text-muted-foreground">{t('organizations:orgRecord.overview.tiles.contracts')}</dt>
                          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatNumber(summary.contracts.active)}</dd>
                          <dd className="text-xs text-muted-foreground">
                            {summary.contracts.nextRenewalAt
                              ? t('organizations:orgRecord.overview.tiles.contractsSub', { date: formatDate(summary.contracts.nextRenewalAt) })
                              : t('organizations:orgRecord.overview.tiles.contractsNoRenewal')}
                          </dd>
                        </div>
                      )}
                      <div className="min-w-32">
                        <dt className="text-xs text-muted-foreground">{t('organizations:orgRecord.overview.tiles.sites')}</dt>
                        <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatNumber(summary.sites.count)}</dd>
                      </div>
                      {summary.lastActivityAt && (
                        <div className="min-w-32">
                          <dt className="text-xs text-muted-foreground">{t('organizations:orgRecord.overview.tiles.lastActivity')}</dt>
                          <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatDate(summary.lastActivityAt)}</dd>
                        </div>
                      )}
                    </dl>
                  )
                )}

                {/* Sites section — flat inside the panel (the panel is the
                    card); count and search appear only once the list is long
                    enough to need them. */}
                <div className="px-6 py-5">
                  {siteCrud.sitesLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                      <span className="ml-3 text-sm text-muted-foreground">{t('organizationsPage.sites.loading')}</span>
                    </div>
                  ) : (
                    <SiteList
                      variant="section"
                      sites={siteCrud.sites}
                      onAddSite={siteCrud.openAdd}
                      onEdit={siteCrud.openEdit}
                      onDelete={siteCrud.openDelete}
                      onSiteClick={(site) => void navigateTo(`/settings/sites/${site.id}`)}
                    />
                  )}
                </div>
              </>
            )
          ) : (
            /* Empty state */
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="rounded-full bg-muted/50 p-4">
                <Building2 className="h-8 w-8 text-muted-foreground/60" strokeWidth={1.5} aria-hidden="true" />
              </div>
              <h3 className="mt-4 text-sm font-medium">{t('organizationsPage.emptySelection.title')}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('organizationsPage.emptySelection.description')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Org Add dialog. Escape and the backdrop are inert while the create
          POST is in flight so a half-submitted form cannot be dismissed. */}
      {modalMode === 'add' && (
        <Dialog
          open
          onClose={submitting ? noop : handleCloseModal}
          title={t('organizationsPage.add.title')}
          labelledBy={ADD_ORG_TITLE_ID}
          maxWidth="2xl"
          alignTop
        >
          <div className="border-b px-6 py-4">
            <h2 id={ADD_ORG_TITLE_ID} className="text-lg font-semibold">{t('organizationsPage.add.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('organizationsPage.add.description')}
            </p>
          </div>
          <OrganizationForm
            onSubmit={handleSubmit}
            onCancel={handleCloseModal}
            submitLabel={t('organizationsPage.add.submit')}
            loading={submitting}
            className="space-y-6 p-6"
          />
        </Dialog>
      )}

      {/* Org Archive Modal */}
      {modalMode === 'archive' && selectedOrg && (
        <ArchiveOrgModal
          org={selectedOrg}
          onClose={handleCloseModal}
          onArchived={handleArchiveComplete}
          onDoneClose={handleArchiveDoneClose}
        />
      )}

      {/* Org Merge Modal */}
      {modalMode === 'merge' && selectedOrg && (
        <MergeOrgModal
          loserOrg={selectedOrg}
          orgs={organizations}
          onClose={handleCloseModal}
          onMerged={handleMergeComplete}
          onDoneClose={handleMergeDoneClose}
        />
      )}

      <SiteModals
        mode={siteCrud.siteModalMode}
        selectedSite={siteCrud.selectedSite}
        guidingFirstSite={siteCrud.guidingFirstSite}
        orgName={selectedOrg?.name}
        partnerTimezone={partnerTimezone}
        submitting={siteCrud.siteSubmitting}
        onSubmit={siteCrud.submit}
        onClose={siteCrud.close}
        onConfirmDelete={siteCrud.confirmDelete}
        getSiteFormDefaults={siteCrud.getSiteFormDefaults}
      />
    </div>
  );
}
