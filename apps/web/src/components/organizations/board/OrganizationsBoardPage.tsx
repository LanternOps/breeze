// apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import OrganizationForm from '@/components/settings/OrganizationForm';
import MergeOrgModal from '@/components/settings/MergeOrgModal';
import ArchiveOrgModal from '@/components/settings/ArchiveOrgModal';
import BulkOrgImport from '@/components/organizations/BulkOrgImport';
import { Dialog } from '@/components/shared/Dialog';
import type { ActionMenuItem } from '@/components/shared/ActionMenu';
import { showToast } from '@/components/shared/Toast';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import { useJwtClaims } from '@/lib/authScope';
import { usePermissions } from '@/lib/permissions';
import { runAction, ActionError, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { applyOrgSwitch } from '@/lib/orgSwitch';
import { useHashState } from '@/lib/useHashState';
import { fetchAllOrganizations } from '@/lib/fetchAllOrganizations';
import { formatNumber } from '@/lib/i18n/format';
import { statusLabelKeys } from '@/lib/orgStatus';
import {
  BOARD_LENSES,
  BOARD_SORTS,
  DEFAULT_FILTER,
  DEFAULT_LENS,
  deriveIntegrationBadges,
  deriveReadinessChips,
  isBoardLens,
  isBoardSort,
  lensForFilter,
  matchesFilter,
  parseBoardHash,
  searchMatches,
  serializeBoardHash,
  sortRows,
  visibleColumns,
  visibleFilters,
  type BoardFilter,
  type BoardHashState,
  type BoardLens,
  type BoardRow,
  type BoardSort,
} from '@/lib/orgReadiness';
import { useEventStreamScope } from '@/hooks/useEventStream';
import { useAccountReadiness } from './useAccountReadiness';
import { useManualOrder } from './useManualOrder';
import { useArchivedOrganizations } from './useArchivedOrganizations';
import { RollupBand, type RollupCell } from './RollupBand';
import { AccountBoardTable, REORDER_HINT_ID } from './AccountBoardTable';
import { useStableT } from '@/lib/i18n/useStableT';

type BoardOrganization = Organization & { partnerId?: string };

type ModalMode = 'closed' | 'add' | 'archive' | 'merge';

/** Per-browser conveniences, never authoritative state. Exported for the tests. */
export const ORG_LIST_SORT_STORAGE_KEY = 'breeze.orgList.sort'; // the key #5708 introduced
export const ORG_BOARD_LENS_STORAGE_KEY = 'breeze.orgBoard.lens';
export const ROW_HIGHLIGHT_MS = 2000;
/**
 * The restore route (`apps/api/src/routes/orgArchive.ts`) answers a purging
 * target with a bare `{ error: '<this text>' }, 410` and no machine `code`,
 * so this literal is the only handle `runAction`'s `friendly` lookup has. A
 * copy edit to that route must update this constant too, or the match falls
 * back to the raw (still correct, just unlocalized) backend text.
 */
export const RESTORE_PURGING_ERROR_TEXT = 'Organization is already purging and can no longer be restored';
const ADD_ORG_TITLE_ID = 'org-board-add-dialog-title';
const SKELETON_ROWS = 6;
const noop = () => {};
// The island is server-rendered (`client:load`); localStorage is adopted
// post-commit, pre-paint, so the first client render matches the SSR HTML.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type OrganizationFormValues = {
  name: string;
  slug: string;
  type: 'customer' | 'internal';
  status: 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding';
  maxDevices: number;
  contractStart?: string;
  contractEnd?: string;
};

function readStoredSort(): BoardSort {
  try {
    const stored = window.localStorage.getItem(ORG_LIST_SORT_STORAGE_KEY);
    return stored && isBoardSort(stored) ? stored : 'manual';
  } catch {
    return 'manual';
  }
}

function readStoredLens(): BoardLens {
  try {
    const stored = window.localStorage.getItem(ORG_BOARD_LENS_STORAGE_KEY);
    return stored && isBoardLens(stored) ? stored : DEFAULT_LENS;
  } catch {
    return DEFAULT_LENS;
  }
}

function storeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* per-browser nicety only; nothing depends on it persisting */
  }
}

const PRIMARY_BUTTON =
  'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90';
const SECONDARY_BUTTON =
  'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border bg-background px-3 text-sm font-medium transition hover:bg-muted';
const CHIP_BUTTON = (pressed: boolean) =>
  `inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition ${
    pressed ? 'border-foreground bg-foreground text-background' : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
  }`;

export default function OrganizationsBoardPage() {
  const { t } = useTranslation('organizations');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const { t: tSettings } = useTranslation('settings');
  // Merge is partner-scope only (the API's merge routes require partner/system
  // scope). `useJwtClaims()` so this stays reactive to the token landing after
  // cold load (#4013's lesson).
  const jwt = useJwtClaims();
  const canMergeOrgs = jwt.status === 'resolved' && jwt.claims.scope === 'partner';
  const { can } = usePermissions();
  const workspaceOrgId = useOrgStore((s) => s.currentOrgId);
  const storeMode = useOrgStore((s) => s.serviceManagementMode);

  const [organizations, setOrganizations] = useState<BoardOrganization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [targetOrg, setTargetOrg] = useState<Organization | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useState<BoardSort>('manual');
  const [storedLens, setStoredLens] = useState<BoardLens>(DEFAULT_LENS);
  // Navigable state lives in the hash (#lens=…&filter=…, or a bare #<uuid>
  // row highlight); localStorage supplies the lens default when the hash is empty.
  const [hashState, setHashState] = useHashState<BoardHashState>({}, parseBoardHash);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [highlightedOrgId, setHighlightedOrgId] = useState<string | null>(null);
  const [restoringOrgId, setRestoringOrgId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>());

  useIsomorphicLayoutEffect(() => {
    setStoredLens(readStoredLens());
    setSort(readStoredSort());
  }, []);

  const lens: BoardLens = hashState.lens ?? storedLens;
  const filter: BoardFilter = hashState.filter ?? DEFAULT_FILTER;

  const isSystem = jwt.status === 'resolved' && jwt.claims.scope === 'system';
  const [selectedPartnerId, setSelectedPartnerId] = useState<string>();
  const partnerIds = useMemo(() => [...new Set(organizations.flatMap((org) => org.partnerId ? [org.partnerId] : []))], [organizations]);
  const partnerId = isSystem ? (selectedPartnerId && partnerIds.includes(selectedPartnerId) ? selectedPartnerId : partnerIds[0]) : undefined;
  const boardOrganizations = useMemo(() => isSystem ? organizations.filter((org) => org.partnerId === partnerId) : organizations, [organizations, isSystem, partnerId]);
  useEffect(() => {
    useEventStreamScope.getState().setPartnerId(partnerId);
    return () => useEventStreamScope.getState().setPartnerId(undefined);
  }, [partnerId]);
  const orgIds = useMemo(() => jwt.status === 'unresolved' || (isSystem && !partnerId) ? [] : boardOrganizations.map((o) => o.id), [boardOrganizations, jwt.status, isSystem, partnerId]);
  const readiness = useAccountReadiness(orgIds, partnerId);
  const capabilities = readiness.capabilities;
  const mode = readiness.mode ?? storeMode;
  const archived = useArchivedOrganizations({ enabled: filter === 'archived', search: searchQuery });

  /** `silent` keeps the rows on screen: a reorder reconciliation must not blank the list under its own error toast. */
  const fetchOrganizations = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      try {
        if (!silent) setLoading(true);
        setError(undefined);
        const list = await fetchAllOrganizations<BoardOrganization>(async (page, limit) => {
          const response = await fetchWithAuth(`/orgs/organizations?page=${page}&limit=${limit}`);
          if (!response.ok) {
            if (response.status === 401) {
              // Idempotent: either no-ops into the redirect fetchWithAuth already
              // started, or performs the logout for a 401 that survived a refresh.
              handleSessionExpired();
              return null;
            }
            throw new Error(stableT('orgBoard.errors.fetchOrganizations'));
          }
          return response.json();
        }, { order: 'server' });
        if (list === null) return;
        setOrganizations(list);
      } catch (err) {
        setError(err instanceof Error ? err.message : stableT('orgBoard.errors.generic'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [stableT],
  );
  const refetchSilently = useCallback(() => fetchOrganizations({ silent: true }), [fetchOrganizations]);
  const manualOrder = useManualOrder({ organizations, setOrganizations, refetch: refetchSilently });

  // Refresh both this list and the global org store (side nav / switcher).
  // allSettled so a store hiccup does not undo a create that already committed.
  const refreshOrgs = useCallback(async () => {
    const results = await Promise.allSettled([fetchOrganizations(), useOrgStore.getState().fetchOrganizations()]);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected && rejected.status === 'rejected') console.warn('[OrganizationsBoardPage] org refresh partially failed', rejected.reason);
  }, [fetchOrganizations]);

  useEffect(() => {
    void fetchOrganizations();
  }, [fetchOrganizations]);

  // ---- Derived rows ----
  const rows: BoardRow[] = useMemo(() => {
    const now = new Date();
    return boardOrganizations.map((org) => {
      const r = readiness.byOrg.get(org.id);
      const state = readiness.rowState.get(org.id) ?? 'pending';
      return {
        org,
        readiness: r,
        state,
        chips: deriveReadinessChips(org, r, capabilities, mode, now),
        badges: state === 'ready' ? deriveIntegrationBadges(r, readiness.connectors, capabilities) : null,
      };
    });
  }, [boardOrganizations, readiness.byOrg, readiness.rowState, readiness.connectors, capabilities, mode]);

  const archivedRows: BoardRow[] = useMemo(
    () => archived.archivedOrgs.map((org) => ({ org, readiness: undefined, state: 'ready' as const, chips: null, badges: null })),
    [archived.archivedOrgs],
  );

  const filteredRows = useMemo(() => {
    if (filter === 'archived') {
      // Client-side re-filter of whatever is loaded, in ADDITION to the server-
      // side `search` the hook forwards: rows from the previous query can still
      // be on screen for one round trip.
      const q = searchQuery.trim().toLowerCase();
      return sortRows(archivedRows.filter((row) => !q || row.org.name.toLowerCase().includes(q)), sort);
    }
    return sortRows(rows.filter((row) => matchesFilter(filter, row) && searchMatches(searchQuery, row.org, row.readiness)), sort);
  }, [archivedRows, filter, rows, searchQuery, sort]);

  /** Manual order only means something against the full, server-ordered list. */
  const manualOrderActive = !isSystem && sort === 'manual' && filter === 'all' && searchQuery.trim().length === 0;
  const columns = useMemo(() => visibleColumns(lens, capabilities), [lens, capabilities]);
  const filters = useMemo(() => visibleFilters(capabilities), [capabilities]);
  const readinessKnown = readiness.status === 'ready' || readiness.status === 'partial';

  /** The one row whose controls are in the Tab order, re-resolved against the current filtered list. */
  const activeOrgId = useMemo(() => {
    if (activeRowId && filteredRows.some((r) => r.org.id === activeRowId)) return activeRowId;
    return filteredRows[0]?.org.id ?? null;
  }, [activeRowId, filteredRows]);

  // ---- Hash / lens / filter / sort ----
  const applyHash = useCallback(
    (next: { lens: BoardLens; filter: BoardFilter }) => {
      setHashState(next);
      window.location.hash = serializeBoardHash(next);
    },
    [setHashState],
  );
  const changeLens = useCallback(
    (next: BoardLens) => {
      setStoredLens(next);
      storeLocal(ORG_BOARD_LENS_STORAGE_KEY, next);
      applyHash({ lens: next, filter });
    },
    [applyHash, filter],
  );
  // Applying a filter whose evidence the lens hides switches the lens to Both
  // FOR THIS VIEW (hash only) — the remembered lens is untouched.
  const changeFilter = useCallback((next: BoardFilter) => applyHash({ lens: lensForFilter(next, lens), filter: next }), [applyHash, lens]);
  const changeSort = (next: BoardSort) => {
    setSort(next);
    storeLocal(ORG_LIST_SORT_STORAGE_KEY, next);
  };
  const clearFilters = () => {
    setSearchQuery('');
    applyHash({ lens, filter: DEFAULT_FILTER });
  };

  // Bare `#<uuid>` (the incumbent's selected-org deep link, still produced by
  // OrgSettingsPage/SiteDetailPage bookmarks): scroll to, focus and highlight.
  useEffect(() => {
    const id = hashState.highlightOrgId;
    if (!id || loading) return;
    const el = rowRefs.current.get(id);
    if (!el) return;
    setActiveRowId(id);
    setHighlightedOrgId(id);
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    const timer = window.setTimeout(() => setHighlightedOrgId(null), ROW_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [hashState.highlightOrgId, loading, organizations]);

  // ---- Counts for the band and the filter chips (live, unfiltered list) ----
  const counts = useMemo(() => {
    const count = (f: BoardFilter) => rows.filter((r) => matchesFilter(f, r)).length;
    return {
      trial: count('trial'),
      suspended: rows.filter((r) => r.org.status === 'suspended').length,
      setupIncomplete: readinessKnown ? count('setupIncomplete') : null,
      accountMissing: readinessKnown ? count('accountMissing') : null,
      unlinked: readinessKnown ? count('unlinked') : null,
      openTickets: readinessKnown ? count('openTickets') : null,
      slaBreached: rows.reduce((sum, r) => sum + (r.readiness?.tickets?.slaBreached ?? 0), 0),
      openTicketTotal: rows.reduce((sum, r) => sum + (r.readiness?.tickets?.open ?? 0), 0),
      deviceTotal: boardOrganizations.reduce((sum, o) => sum + (o.deviceCount ?? 0), 0),
      archived: archived.loaded ? archived.archivedOrgs.length : null,
    };
  }, [rows, boardOrganizations, readinessKnown, archived.loaded, archived.archivedOrgs.length]);

  const filterCount = (key: BoardFilter): number | null => {
    switch (key) {
      case 'setupIncomplete':
        return counts.setupIncomplete;
      case 'accountMissing':
        return counts.accountMissing;
      case 'unlinked':
        return counts.unlinked;
      case 'openTickets':
        return counts.openTickets;
      case 'trial':
        return counts.trial;
      case 'archived':
        return counts.archived;
      default:
        return null;
    }
  };

  const bandCells: RollupCell[] = useMemo(
    () =>
      filters
        .filter((key) => key !== 'trial' && key !== 'archived')
        .map((key): RollupCell => {
          const pressed = filter === key;
          const onPress = () => changeFilter(key);
          if (key === 'all') {
            return { key, count: rows.length, sub: t('orgBoard.band.allSub', { trial: counts.trial, suspended: counts.suspended }), pressed, onPress };
          }
          if (key === 'openTickets') {
            return {
              key,
              count: counts.openTickets,
              sub: readinessKnown ? t('orgBoard.band.openTicketsSub', { count: counts.slaBreached }) : null,
              subTone: counts.slaBreached > 0 ? 'destructive' : 'muted',
              pressed,
              onPress,
            };
          }
          if (key === 'unlinked') return { key, count: counts.unlinked, pressed, onPress };
          return { key, count: key === 'setupIncomplete' ? counts.setupIncomplete : counts.accountMissing, pressed, onPress };
        }),
    [filters, filter, rows.length, counts, readinessKnown, changeFilter, t],
  );

  // ---- Keyboard: Arrow/Home/End move the roving stop, never a selection ----
  const handleRowKeyDown = (event: KeyboardEvent<HTMLAnchorElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, filteredRows.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = filteredRows.length - 1;
    if (next === null) return;
    event.preventDefault();
    if (next === index) return;
    const target = filteredRows[next];
    setActiveRowId(target.org.id);
    rowRefs.current.get(target.org.id)?.focus();
  };
  const registerRowRef = useCallback((orgId: string, el: HTMLAnchorElement | null) => {
    if (el) rowRefs.current.set(orgId, el);
    else rowRefs.current.delete(orgId);
  }, []);

  // ---- Row actions ----
  const openRecord = (org: Organization) => void navigateTo(`/organizations/${org.id}`);
  const handleWorkHere = (org: Organization) => void applyOrgSwitch(org.id, t('orgRecord.actions.workHereToast', { orgName: org.name }));
  const handleArchive = (org: Organization) => {
    setTargetOrg(org);
    setModalMode('archive');
  };
  const handleMerge = (org: Organization) => {
    setTargetOrg(org);
    setModalMode('merge');
  };
  const handleCloseModal = () => setModalMode('closed');
  /** LIST-STATE UPDATE ONLY: the modal stays open on its own `done` phase. */
  const handleArchiveComplete = (archivedId: string) => setOrganizations((prev) => prev.filter((o) => o.id !== archivedId));
  const handleArchiveDoneClose = () => {
    setTargetOrg(null);
    handleCloseModal();
  };
  /** NOT a refetch: the loser ends up a terminal `status='merging'` shell that a refetch would still return. */
  const handleMergeComplete = (loserId: string) => setOrganizations((prev) => prev.filter((o) => o.id !== loserId));
  const handleMergeDoneClose = () => {
    setTargetOrg(null);
    handleCloseModal();
  };

  const restoreFriendly = (code: string) => {
    if (code === 'MFA_REQUIRED') return t('orgBoard.restore.errors.mfaRequired');
    if (code === RESTORE_PURGING_ERROR_TEXT) return t('orgBoard.restore.errors.purging');
    return undefined;
  };

  /** Optimistic: drop from the archived rows, add to the live list under the status the API reports; the global store hears about it separately. */
  const handleRestore = async (org: Organization) => {
    setRestoringOrgId(org.id);
    try {
      const data = await runAction<{ status: string; recreateRequired: string[] }>({
        request: () => fetchWithAuth(`/orgs/organizations/${org.id}/restore`, { method: 'POST' }),
        errorFallback: t('orgBoard.restore.errors.restore'),
        friendly: restoreFriendly,
        onUnauthorized: handleSessionExpired,
      });
      const restoredStatus = data.status as Organization['status'];
      const restoredOrg: Organization = { ...org, status: restoredStatus, archived: undefined, purgeAt: undefined, offboardingTarget: undefined };
      archived.remove(org.id);
      setOrganizations((prev) => [...prev, restoredOrg]);
      useOrgStore
        .getState()
        .fetchOrganizations()
        .catch((storeErr: unknown) => console.warn('[OrganizationsBoardPage] org store refresh failed after restore', storeErr));
      const parts = [t('orgBoard.restore.success', { name: org.name, status: tSettings(/* i18n-dynamic */ statusLabelKeys[restoredStatus]) })];
      if (data.recreateRequired.length > 0) parts.push(t('orgBoard.restore.recreateRequiredNote', { items: data.recreateRequired.join('; ') }));
      if (restoredStatus === 'suspended') parts.push(t('orgBoard.restore.suspendedNote'));
      showToast({ message: parts.join(' '), type: 'success' });
    } catch (err) {
      handleActionError(err, t('orgBoard.restore.errors.restore'));
    } finally {
      setRestoringOrgId(null);
    }
  };

  const handleSubmit = async (values: OrganizationFormValues) => {
    setSubmitting(true);
    try {
      // runAction, not setError: the page banner renders behind the dialog overlay.
      const createdOrg = await runAction<{ id?: string } | null>({
        request: () => fetchWithAuth('/orgs/organizations', { method: 'POST', body: JSON.stringify(values) }),
        errorFallback: t('orgBoard.errors.saveOrganization'),
        onUnauthorized: handleSessionExpired,
        parseSuccess: (data) => (data ?? null) as { id?: string } | null,
      });
      await refreshOrgs();
      handleCloseModal();
      if (createdOrg?.id) {
        // The new row's Setup chips ARE the "what next" — highlight it rather than
        // opening a site dialog here (sites are the record's job).
        setHashState({ highlightOrgId: createdOrg.id });
        window.location.hash = createdOrg.id;
        showToast({ type: 'success', message: t('orgBoard.add.created', { name: values.name }) });
      }
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ message: err instanceof Error ? err.message : t('orgBoard.errors.generic'), type: 'error' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const menuItemsFor = useCallback(
    (row: BoardRow): ActionMenuItem[] => {
      const org = row.org;
      const recordHref = `/organizations/${org.id}`;
      if (org.archived === true) {
        return [
          { id: 'open', label: t('orgBoard.actions.openRecord'), href: recordHref, testId: 'org-board-menu-open-record' },
          {
            id: 'restore',
            label: restoringOrgId === org.id ? t('orgBoard.actions.restoring') : t('orgBoard.actions.restore'),
            onSelect: () => void handleRestore(org),
            testId: 'org-board-menu-restore',
          },
        ];
      }
      const items: ActionMenuItem[] = [{ id: 'open', label: t('orgBoard.actions.openRecord'), href: recordHref, testId: 'org-board-menu-open-record' }];
      const primary = row.readiness?.account.primaryContact ?? null;
      const phone = primary?.phone ?? primary?.mobile ?? null;
      if (primary && (primary.email || phone)) {
        // Name, or the email when the contact has no name, or the number when it has neither.
        const displayName = primary.name || primary.email || phone || '';
        items.push({
          id: 'contact',
          label: t('orgBoard.actions.contact', { name: displayName }),
          description: [primary.email, phone].filter(Boolean).join(' · '),
          href: primary.email ? `mailto:${primary.email}` : `tel:${phone}`,
          testId: 'org-board-menu-contact',
        });
      }
      if (mode === 'native' && can('tickets', 'write')) {
        items.push({ id: 'ticket', label: t('orgBoard.actions.newTicket'), href: `/tickets/new#orgId=${org.id}`, testId: 'org-board-menu-new-ticket' });
      }
      items.push({ id: 'work', label: t('orgBoard.actions.workHere'), separatorBefore: true, onSelect: () => handleWorkHere(org), testId: 'org-board-menu-work-here' });
      items.push({ id: 'settings', label: t('orgBoard.actions.settings'), onSelect: () => void navigateTo(`/settings/organizations/${org.id}`), testId: 'org-board-menu-settings' });
      items.push({ id: 'archive', label: t('orgBoard.actions.archive'), separatorBefore: true, onSelect: () => handleArchive(org), testId: 'org-board-menu-archive' });
      if (canMergeOrgs) {
        items.push({ id: 'merge', label: t('orgBoard.actions.merge'), tone: 'destructive', onSelect: () => handleMerge(org), testId: 'org-board-menu-merge' });
      }
      return items;
    },
    // Deps are intentionally narrow: handlers are stable closures over state setters; restoringOrgId/mode/can/canMergeOrgs are the inputs that change
    [t, restoringOrgId, mode, can, canMergeOrgs],
  );

  // ---- Render ----
  const initialLoading = loading && organizations.length === 0;

  if (error && organizations.length === 0) {
    return (
      <div data-testid="org-board-error" className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={() => void fetchOrganizations()} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {t('orgBoard.actions.tryAgain')}
        </button>
      </div>
    );
  }

  const footer = (
    <p data-testid="org-board-footer" className="text-xs text-muted-foreground">
      {capabilities?.tickets && readinessKnown
        ? t('orgBoard.footer.summaryWithTickets', {
            accounts: formatNumber(boardOrganizations.length),
            devices: formatNumber(counts.deviceTotal),
            tickets: formatNumber(counts.openTicketTotal),
          })
        : t('orgBoard.footer.summary', { accounts: formatNumber(boardOrganizations.length), devices: formatNumber(counts.deviceTotal) })}
      {manualOrderActive && <> · {t('orgBoard.footer.manualHint')}</>}
    </p>
  );

  const renderTableRegion = () => {
    if (initialLoading) {
      return (
        <div data-testid="org-board-skeleton" aria-busy="true" className="divide-y rounded-lg border bg-card shadow-xs">
          <p className="sr-only">{t('orgBoard.loading')}</p>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3" aria-hidden="true">
              <div className="skeleton h-4 w-4" />
              <div className="skeleton h-4 w-40" />
              <div className="skeleton h-5 w-24 rounded-full" />
              <div className="skeleton h-5 w-24 rounded-full" />
              <div className="skeleton h-4 w-12" />
            </div>
          ))}
        </div>
      );
    }
    if (filter === 'archived') {
      if (archived.loading && !archived.loaded) {
        return <div className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">{t('orgBoard.archived.loading')}</div>;
      }
      if (archived.error) {
        return <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{archived.error}</div>;
      }
      // The table wrapper (and its `responsive-table-desktop` testid) always renders,
      // even with zero rows: the archived view can go from non-empty to empty in
      // place (the last archived org gets restored) without the row query surface
      // disappearing out from under a caller that just watched a row leave it.
      return (
        <>
          {archived.truncated && (
            <p data-testid="org-board-archived-truncated-note" className="text-xs text-muted-foreground">
              {t('orgBoard.archived.truncatedNote', { count: archived.archivedOrgs.length })}
            </p>
          )}
          <AccountBoardTable
            rows={filteredRows}
            columns={columns}
            sort={sort}
            onSortChange={changeSort}
            activeRowId={activeOrgId}
            onRowKeyDown={handleRowKeyDown}
            registerRowRef={registerRowRef}
            onOpenRecord={openRecord}
            highlightedOrgId={highlightedOrgId}
            workspaceOrgId={workspaceOrgId}
            manualOrder={null}
            menuItemsFor={menuItemsFor}
            archivedView
            now={new Date()}
            connectors={readiness.connectors}
          />
          {filteredRows.length === 0 && (
            // Keyed on whether a search is active: once a term is present the loaded
            // rows ARE the server-filtered result, so empty means "no match".
            <div data-testid="org-board-archived-empty" className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
              {searchQuery.trim() ? t('orgBoard.archived.noMatches') : t('orgBoard.archived.empty')}
            </div>
          )}
        </>
      );
    }
    if (organizations.length === 0) {
      return (
        <div data-testid="org-board-empty" className="rounded-lg border bg-card p-8">
          <div className="max-w-lg">
            <h2 className="mb-2 text-lg font-semibold">{t('orgBoard.empty.title')}</h2>
            <p className="mb-6 text-sm text-muted-foreground">{t('orgBoard.empty.description')}</p>
            <button type="button" onClick={() => setModalMode('add')} className={PRIMARY_BUTTON}>
              {t('orgBoard.actions.addOrganization')}
            </button>
          </div>
        </div>
      );
    }
    if (filteredRows.length === 0) {
      return (
        <div data-testid="org-board-no-matches" className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          <p>{t('orgBoard.empty.noMatches')}</p>
          <button type="button" data-testid="org-board-clear-filters" onClick={clearFilters} className="mt-3 font-medium text-primary hover:underline">
            {t('orgBoard.actions.clearFilters')}
          </button>
        </div>
      );
    }
    return (
      <AccountBoardTable
        rows={filteredRows}
        columns={columns}
        sort={sort}
        onSortChange={changeSort}
        activeRowId={activeOrgId}
        onRowKeyDown={handleRowKeyDown}
        registerRowRef={registerRowRef}
        onOpenRecord={openRecord}
        highlightedOrgId={highlightedOrgId}
        workspaceOrgId={workspaceOrgId}
        manualOrder={manualOrderActive ? manualOrder : null}
        menuItemsFor={menuItemsFor}
        archivedView={false}
        now={new Date()}
        connectors={readiness.connectors}
      />
    );
  };

  return (
    <div className="space-y-6" data-testid="org-board">
      {/* Header — same anatomy as the Devices page. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 data-testid="org-board-heading" className="text-xl font-semibold tracking-tight">
            {t('orgBoard.title')}
          </h1>
          <p className="text-muted-foreground">{t('orgBoard.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" data-testid="bulk-org-import-toggle" onClick={() => setShowBulkImport((v) => !v)} className={SECONDARY_BUTTON}>
            {tSettings('bulkOrgImport.title')}
          </button>
          <button type="button" data-testid="org-board-add" onClick={() => setModalMode('add')} className={PRIMARY_BUTTON}>
            {t('orgBoard.actions.addOrganization')}
          </button>
        </div>
      </div>

      {showBulkImport && (
        <BulkOrgImport onImported={() => void fetchOrganizations()} onClose={() => setShowBulkImport(false)} onUnauthorized={handleSessionExpired} />
      )}

      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

      {isSystem && partnerIds.length > 1 && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm">
            {t('common:nav.partner')}
            <select data-testid="board-partner-select" aria-describedby="board-partner-scope-hint" value={partnerId} onChange={(event) => setSelectedPartnerId(event.target.value)} className="h-9 rounded-md border bg-background py-0 pl-2 pr-7 text-sm">
              {partnerIds.map((id) => (
                <option key={id} value={id}>
                  {t('orgBoard.partnerOption', { id: id.slice(0, 8), count: organizations.filter((org) => org.partnerId === id).length })}
                </option>
              ))}
            </select>
          </label>
          <p id="board-partner-scope-hint" data-testid="board-partner-scope-hint" className="text-xs text-muted-foreground">
            {t('orgBoard.partnerScopeHint')}
          </p>
        </div>
      )}

      <RollupBand cells={bandCells} status={readiness.status} onRetry={readiness.retry} connectors={readiness.connectors} />

      {/* Toolbar: search · filter chips · lens · sort */}
      <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 shadow-xs lg:flex-row lg:items-center lg:justify-between">
        <input
          type="search"
          data-testid="org-board-search"
          placeholder={t('orgBoard.search.label')}
          aria-label={t('orgBoard.search.label')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring lg:w-72"
        />
        <div role="group" aria-label={t('orgBoard.filters.label')} className="flex min-w-0 flex-wrap gap-1">
          {filters.map((key) => {
            const count = filterCount(key);
            return (
              <button key={key} type="button" data-testid={`org-board-filter-${key}`} aria-pressed={filter === key} onClick={() => changeFilter(key)} className={CHIP_BUTTON(filter === key)}>
                {t(/* i18n-dynamic */ `orgBoard.filters.${key}`)}
                {count !== null && (
                  <span data-testid={`org-board-filter-${key}-count`} className="tabular-nums opacity-70">
                    {formatNumber(count)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label={t('orgBoard.lens.label')} className="flex rounded-md border">
            {BOARD_LENSES.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`org-board-lens-${key}`}
                aria-pressed={lens === key}
                onClick={() => changeLens(key)}
                className={`h-9 px-3 text-xs font-medium transition first:rounded-l-md last:rounded-r-md ${lens === key ? 'bg-muted' : 'hover:bg-muted/50'}`}
              >
                {t(/* i18n-dynamic */ `orgBoard.lens.${key}`)}
              </button>
            ))}
          </div>
          <select
            data-testid="org-board-sort"
            aria-label={t('orgBoard.sort.label')}
            value={sort}
            onChange={(e) => changeSort(e.target.value as BoardSort)}
            // `py-0` overrides the forms plugin's vertical padding, which otherwise pushes the text out of the box.
            className="h-9 shrink-0 rounded-md border bg-background py-0 pl-2 pr-7 text-xs leading-none focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {BOARD_SORTS.filter((s) => s !== 'tickets' || capabilities?.tickets === true).map((s) => (
              <option key={s} value={s}>
                {t(/* i18n-dynamic */ `orgBoard.sort.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p id={REORDER_HINT_ID} className="sr-only">
        {t('orgBoard.reorder.hint')}
      </p>
      <div data-testid="org-board-reorder-announcement" role="status" aria-live="polite" className="sr-only">
        {manualOrder.announcement}
      </div>

      {renderTableRegion()}
      {!initialLoading && organizations.length > 0 && filter !== 'archived' && footer}

      {modalMode === 'add' && (
        <Dialog open onClose={submitting ? noop : handleCloseModal} title={t('orgBoard.add.title')} labelledBy={ADD_ORG_TITLE_ID} maxWidth="2xl" alignTop>
          <div className="border-b px-6 py-4">
            <h2 id={ADD_ORG_TITLE_ID} className="text-lg font-semibold">
              {t('orgBoard.add.title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('orgBoard.add.description')}</p>
          </div>
          <OrganizationForm onSubmit={handleSubmit} onCancel={handleCloseModal} submitLabel={t('orgBoard.add.submit')} loading={submitting} className="space-y-6 p-6" />
        </Dialog>
      )}
      {modalMode === 'archive' && targetOrg && (
        <ArchiveOrgModal org={targetOrg} onClose={handleCloseModal} onArchived={handleArchiveComplete} onDoneClose={handleArchiveDoneClose} />
      )}
      {modalMode === 'merge' && targetOrg && (
        <MergeOrgModal loserOrg={targetOrg} orgs={organizations} onClose={handleCloseModal} onMerged={handleMergeComplete} onDoneClose={handleMergeDoneClose} />
      )}
    </div>
  );
}
