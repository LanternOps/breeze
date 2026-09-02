import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { Layers, FileCog, BarChart3, Plus, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import PatchList, {
  type Patch,
  type PatchApprovalStatus,
} from './PatchList';
import PatchApprovalModal, { type PatchApprovalAction } from './PatchApprovalModal';
import PatchComplianceView from './PatchComplianceView';
import UpdateRingList, { type UpdateRingItem } from './UpdateRingList';
import UpdateRingForm, { type UpdateRingFormValues } from './UpdateRingForm';
import RingSelector, { type UpdateRing } from './RingSelector';
import SourceFilterChips from './SourceFilterChips';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useOrgStore } from '../../stores/orgStore';
import { useJwtClaims } from '../../lib/authScope';
import { normalizePatch, normalizeRing } from './patchHelpers';
import { extractApiError } from '@/lib/apiError';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Dialog } from '../shared/Dialog';
import { runAction, ActionError } from '@/lib/runAction';
import { asList } from '@/lib/asList';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type TabKey = 'rings' | 'patches' | 'compliance';
const validTabs: TabKey[] = ['rings', 'patches', 'compliance'];

// Tab state lives in window.location.hash (`#patches`) per the project
// convention for transient UI state (CLAUDE.md); DiscoveryPage and DeviceDetails
// follow the same convention, but note that neither gates its hash-derived tab
// on a permission — this page is the only one that does, which is what made the
// #4010 ordering bug possible here and nowhere else. The default `compliance`
// tab keeps the hash empty so the URL stays clean.
function getTabFromHash(): TabKey {
  if (typeof window === 'undefined') return 'compliance';
  const hash = window.location.hash.replace(/^#/, '');
  return validTabs.includes(hash as TabKey) ? (hash as TabKey) : 'compliance';
}

function setTabInHash(tab: TabKey) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.hash = tab === 'compliance' ? '' : tab;
  window.history.replaceState({}, '', url.toString());
}

// Resolve a hash-derived tab against the user's access. Rings are partner-scoped:
// an org user landing on #rings (a stale bookmark, a hand-edited URL, or browser
// back/forward) can't see the rings body, so fall back to compliance.
//
// This answers "which tab do we RENDER", never "may we rewrite the URL". Its
// boolean is deliberately fail-closed and so is false both for a real denial and
// for a scope that hasn't resolved yet; a caller that acts destructively on the
// downgrade must consult ringAccess instead (see the sync effect below, #4010).
function resolveTab(tab: TabKey, canManageRings: boolean): TabKey {
  return tab === 'rings' && !canManageRings ? 'compliance' : tab;
}

const DEVICE_SCAN_PAGE_LIMIT = 100;

// Page size used when walking the patch catalog. 200 is MAX_PAGE_LIMIT in
// apps/api/src/routes/patches/helpers.ts — the API clamps anything larger, so
// asking for more just wastes a round trip.
const PATCH_FETCH_PAGE_LIMIT = 200;

// Hard ceiling on how many pages we walk (25 x 200 = 5,000 patches). PatchList
// filters, sorts and paginates the whole array client-side, so an unbounded
// walk would both hammer the API and put an arbitrarily large list in memory.
// Beyond this we stop and tell the user the view is truncated instead of
// silently dropping the tail (which is exactly what #3157 was).
const PATCH_FETCH_MAX_PAGES = 25;

// Ids per POST /patches/bulk-approve request. The route upserts sequentially,
// one awaited round trip per id, so request duration scales with batch size —
// and "Select all N matching" can hand us the whole loaded catalog. Batching
// keeps any single request short enough to finish well inside an edge-proxy
// timeout, and gives each batch its own audit entry.
const BULK_APPROVE_BATCH_SIZE = 200;

export default function PatchesPage() {
  const { t } = useTranslation('patches');
  const { organizations, currentOrgId } = useOrgStore();
  const currentOrg = organizations.find(o => o.id === currentOrgId) ?? null;
  // Reactive claims, not the one-shot getJwtClaims(): access tokens are never
  // persisted, so on a cold load the store is empty at first paint and only
  // fills once the refresh cookie has been exchanged (#4010).
  //
  // Rings + approvals are partner-scoped: only partner/system users manage them.
  // Keep all THREE access states rather than collapsing to a boolean — 'denied'
  // and 'unresolved' both have to hide the rings UI, but only 'denied' may
  // destroy the #rings deep link. Collapsing them is the bug.
  const jwt = useJwtClaims();
  const ringAccess: 'unresolved' | 'allowed' | 'denied' =
    jwt.status === 'unresolved'
      ? 'unresolved'
      : jwt.claims.scope === 'partner' || jwt.claims.scope === 'system'
        ? 'allowed'
        : 'denied';
  // Fail closed for everything that only HIDES or DISABLES ui.
  const canManageRings = ringAccess === 'allowed';
  const RING_SCOPE_HINT = t('patchesPage.ringScopeHint');

  // The Update Rings tab is gated on the client-only JWT scope (canManageRings),
  // which is absent during SSR, so the server renders two tabs and the client
  // three. Render the tab list from an SSR-stable value until after mount so the
  // first client render matches the server markup — companion to the #2421
  // active-tab fix below.
  //
  // `mounted` is NOT a stand-in for "scope known". It flips on the first client
  // effect, which is still well before the access token lands; the tab list is
  // simply allowed to be briefly two-tabbed. What used to be wrong here was the
  // assumption that canManageRings stayed accurate everywhere else — it does not
  // during the pre-token window, and the hash-resolution effect below acting on
  // that assumption is exactly what #4010 was. Anything that DESTROYS state on a
  // falsy canManageRings must branch on ringAccess === 'denied'; anything that
  // merely hides UI (this tab list, the ring action guards) is safe to fail
  // closed on canManageRings.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Start from the SSR-safe default; the hash (with the org-scope guard) is
  // applied post-mount by the sync effect below, avoiding an SSR hydration
  // mismatch (#2421).
  const [activeTab, setActiveTabState] = useState<TabKey>('compliance');
  const setActiveTab = useCallback((tab: TabKey) => {
    setActiveTabState(tab);
    setTabInHash(tab);
  }, [t]);

  // Sync the active tab from the hash on mount and on every hashchange — browser
  // back/forward and manual hash edits re-select the tab, mirroring DiscoveryPage.
  // The org-scope guard is re-applied on each sync (resolveTab): a #rings hash an
  // org user can't access falls back to compliance.
  //
  // Only a *denial* may clear the hash — never an unresolved scope (#4010). The
  // first paint of a cold load always has an empty auth store, so clearing on
  // any falsy canManageRings deletes the `#rings` this very effect needs to
  // re-read when the token lands a beat later, and the deep link can never
  // survive a reload, for anyone. While the scope is unresolved we render the
  // fallback tab but leave the URL untouched, so the re-run (ringAccess is a
  // dep) recovers the requested tab. An org user is unaffected: their downgrade
  // is deferred to the moment it is real, and the rings body is never rendered
  // in the meantime.
  //
  // Deferring on the resolved -> unresolved transition (a token going away) is
  // deliberate too: while /auth/refresh is rate limited the session is valid and
  // yet tokenless for up to 90s (#3696), and wiping the hash there would be
  // #4010 again in slow motion. Logout also lands here, and leaves `#rings`
  // behind — harmless, because every logout path navigates away from the page.
  useEffect(() => {
    const syncFromHash = () => {
      const raw = getTabFromHash();
      const resolved = resolveTab(raw, ringAccess === 'allowed');
      if (resolved === raw) {
        setActiveTabState(resolved);
      } else if (ringAccess === 'denied') {
        setActiveTab(resolved); // real denial — also clears the stale hash
      } else {
        setActiveTabState(resolved); // scope unknown — downgrade the view, keep the hash
      }
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [ringAccess, setActiveTab]);
  const [selectedRingId, setSelectedRingId] = useState<string | null>(null);
  const [selectedPatch, setSelectedPatch] = useState<Patch | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [ringModalOpen, setRingModalOpen] = useState(false);
  const [ringSubmitting, setRingSubmitting] = useState(false);
  const [editingRing, setEditingRing] = useState<UpdateRingItem | null>(null);

  // Data
  const [rings, setRings] = useState<UpdateRingItem[]>([]);
  const [ringsLoading, setRingsLoading] = useState(true);
  const [ringsError, setRingsError] = useState<string>();
  const [patches, setPatches] = useState<Patch[]>([]);
  const [patchesLoading, setPatchesLoading] = useState(true);
  const [patchesError, setPatchesError] = useState<string>();
  const [sourceCounts, setSourceCounts] = useState<Record<string, number>>({});
  // Set when the walk brought back fewer patches than the API reported, i.e.
  // the list on screen is incomplete and the user must be told (#3157). The
  // cause decides the advice: hitting the fetch cap genuinely can't be resolved
  // from this view, whereas a catalog that shifted mid-walk (an agent ingesting
  // patches while we page — rows land at the front under createdAt DESC, so the
  // offset window slides) is fixed by simply reloading.
  const [patchesIncomplete, setPatchesIncomplete] =
    useState<{ total: number; cause: 'cap' | 'shifted' } | null>(null);
  // Monotonic id for the in-flight catalog walk; see fetchPatches.
  const patchFetchGeneration = useRef(0);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'microsoft' | 'apple' | 'linux' | 'third_party'>('all');
  const [scanLoading, setScanLoading] = useState(false);
  const [pendingScan, setPendingScan] = useState<{ deviceIds: string[]; orgNames: string[] } | null>(null);

  const tabs = useMemo(
    () => [
      { id: 'compliance' as TabKey, label: t('patchesPage.tabs.compliance'), icon: <BarChart3 className="h-4 w-4" /> },
      { id: 'patches' as TabKey, label: t('patchesPage.tabs.patches'), icon: <FileCog className="h-4 w-4" /> },
      ...(mounted && canManageRings ? [{ id: 'rings' as TabKey, label: t('patchesPage.tabs.updateRings'), icon: <Layers className="h-4 w-4" /> }] : [])
    ],
    [mounted, canManageRings, t]
  );

  // Ring selector data (simplified for dropdown)
  const ringSelectorItems: UpdateRing[] = useMemo(
    () =>
      rings.map((r) => ({
        id: r.id,
        name: r.name,
        ringOrder: r.ringOrder,
        deferralDays: r.deferralDays,
        enabled: r.enabled,
      })),
    [rings]
  );

  // ---- Data Fetching ----

  const fetchRings = useCallback(async () => {
    try {
      setRingsLoading(true);
      setRingsError(undefined);
      const response = await fetchWithAuth('/update-rings');
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw new Error(t('patchesPage.errors.fetchRings'));
      }
      const data = await response.json();
      const ringData = asList(data);
      const normalized = Array.isArray(ringData)
        ? ringData.map((r: Record<string, unknown>) => normalizeRing(r))
        : [];
      setRings(normalized);
    } catch (err) {
      setRingsError(err instanceof Error ? err.message : t('patchesPage.errors.fetchRings'));
    } finally {
      setRingsLoading(false);
    }
  }, []);

  const fetchPatches = useCallback(async () => {
    // Only the newest walk may write state. A walk is now up to
    // PATCH_FETCH_MAX_PAGES sequential requests, so switching rings (or hitting
    // Refresh) mid-walk leaves a much wider window in which a superseded walk
    // could finish last and repaint the list with the previous ring's patches.
    const generation = patchFetchGeneration.current + 1;
    patchFetchGeneration.current = generation;
    const isStale = () => patchFetchGeneration.current !== generation;

    try {
      setPatchesLoading(true);
      setPatchesError(undefined);
      // Walk every page of the catalog, not just the first. PatchList sorts AND
      // paginates entirely client-side over this array (issue #1316), so
      // whatever isn't fetched here can never be searched, sorted, paged to, or
      // selected. A single `limit=200` request therefore hard-capped the UI at
      // the API's MAX_PAGE_LIMIT: an org with 333 patches could only ever see
      // and approve the first 200 (#3157). Both endpoints return
      // `pagination: { page, limit, total }`, so we page until exhausted — or
      // until PATCH_FETCH_MAX_PAGES, after which the user is told the list is
      // short. Whatever happens, a short list is never presented as complete.
      //
      // Note: this never sends sortBy/sortDir, so the server-side sort added to
      // the API (list.ts / schemas.ts) is NOT yet consumed by the web; wiring it
      // up (along with server-side filtering and select-all) is the scalable
      // follow-up that would let us drop the page walk entirely.
      //
      // Ring-scoped patches use a dedicated endpoint with the same page shape
      // and the same 200 cap, so the walk is identical for both.
      const baseUrl = selectedRingId
        ? `/update-rings/${selectedRingId}/patches?limit=${PATCH_FETCH_PAGE_LIMIT}`
        : `/patches?limit=${PATCH_FETCH_PAGE_LIMIT}`;

      const collected: Patch[] = [];
      const seenIds = new Set<string>();
      let counts: Record<string, number> | null = null;
      let reportedTotal: number | null = null;
      let hitPageCap = false;
      let page = 1;
      let lastPage = 1;

      while (page <= lastPage) {
        // Page 1 keeps the bare `?limit=200` URL it has always used so the
        // request is byte-identical to the pre-fix single-page fetch.
        const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;
        const response = await fetchWithAuth(url);
        // A newer walk started while this request was in flight — abandon this
        // one silently; the newer walk owns the loading/error state now.
        if (isStale()) return;
        if (!response.ok) {
          if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
          throw new Error(t('patchesPage.errors.fetchPatches'));
        }
        const data = await response.json();
        const patchData = asList(data, 'patches', 'items');
        const rows = Array.isArray(patchData) ? patchData : [];
        for (const patch of rows) {
          // normalizePatch's index only seeds a fallback id for rows with no
          // id; offsetting by the running total keeps those unique across pages.
          const normalized = normalizePatch(patch as Record<string, unknown>, collected.length);
          // Offset paging can hand back the same row on two pages if rows are
          // inserted or deleted mid-walk. Duplicates would collide on React
          // keys and inflate the "select all N matching" count, so drop them —
          // the completeness check below is what tells the user rows are short.
          if (seenIds.has(normalized.id)) continue;
          seenIds.add(normalized.id);
          collected.push(normalized);
        }
        // Counts are catalog-wide and identical on every page — keep the first
        // page that supplies them.
        if (counts === null && data && typeof data.counts === 'object' && data.counts !== null) {
          counts = data.counts as Record<string, number>;
        }

        const pagination = (data?.pagination ?? {}) as { total?: unknown; limit?: unknown };
        const total = Number(pagination.total);
        const pageLimit = Number(pagination.limit) || PATCH_FETCH_PAGE_LIMIT;
        if (rows.length > 0 && Number.isFinite(total) && total > 0) {
          reportedTotal = total;
          lastPage = Math.ceil(total / pageLimit);
          if (lastPage > PATCH_FETCH_MAX_PAGES) {
            lastPage = PATCH_FETCH_MAX_PAGES;
            hitPageCap = true;
          }
        } else {
          // On page 1 this is the ordinary "endpoint returned no pagination
          // metadata, or the catalog is empty" case — one page IS the whole
          // answer. From page 2 on it's an anomaly (page 1 already promised
          // more), so stop here and let the completeness check flag the gap
          // rather than silently serving a short list.
          lastPage = page;
        }
        page += 1;
      }

      // A short list must never render as the complete catalog — that silence
      // is precisely what #3157 was. Fires for the page cap, for a mid-walk
      // anomaly, and for rows dropped as duplicates.
      const shortOfTotal = reportedTotal !== null && collected.length < reportedTotal;

      setPatches(collected);
      setSourceCounts(counts ?? {});
      setPatchesIncomplete(
        shortOfTotal && reportedTotal !== null
          ? { total: reportedTotal, cause: hitPageCap ? 'cap' : 'shifted' }
          : null
      );
    } catch (err) {
      if (isStale()) return;
      setPatchesError(err instanceof Error ? err.message : t('patchesPage.errors.fetchPatches'));
    } finally {
      // A superseded walk must not clear the spinner the newer walk turned on.
      if (!isStale()) setPatchesLoading(false);
    }
  }, [selectedRingId, t]);

  useEffect(() => {
    fetchRings();
  }, [fetchRings]);

  useEffect(() => {
    fetchPatches();
  }, [fetchPatches]);

  // ---- Handlers ----

  const handleReview = (patch: Patch) => {
    setSelectedPatch(patch);
    setModalOpen(true);
  };

  const handleApprovalSubmit = async (patchId: string, action: PatchApprovalAction, _notes: string) => {
    const nextStatus: PatchApprovalStatus =
      action === 'approve' ? 'approved' : action === 'decline' ? 'declined' : 'deferred';

    setPatches(prev => prev.map(patch => (patch.id === patchId ? { ...patch, approvalStatus: nextStatus } : patch)));
    setModalOpen(false);
    setSelectedPatch(null);
  };

  // Flip the given ids to approved in the local table.
  const markApproved = useCallback((ids: string[]) => {
    const approved = new Set(ids);
    setPatches(prev =>
      prev.map(patch =>
        approved.has(patch.id) ? { ...patch, approvalStatus: 'approved' as PatchApprovalStatus } : patch
      )
    );
  }, []);

  // NOTE: bulk-approve/decline and update-ring mutations intentionally use the inline bulkError/ringsError
  // feedback pattern (aggregate/partial-success semantics + PatchList-owned error UI) rather than
  // runAction's per-call toast. This is a deliberate, valid feedback pattern — not a silent failure.
  // See spec 2026-05-15-ws-a-action-feedback-design.md (targeted scope; sweeping migration is a non-goal).
  const handleBulkApprove = async (patchIds: string[]) => {
    // Partner/system users can approve partner-wide (the API derives the partner
    // from auth.partnerId) or ring-scoped (when selectedRingId is set). Org-scoped
    // users cannot manage approvals — those are governed at the partner level.
    if (!canManageRings) {
      throw new Error(t('patchesPage.errors.partnerLevel'));
    }
    // Submit in batches. The API applies approvals one awaited upsert at a time
    // (routes/patches/approvals.ts), so a single request for the whole
    // selection scales linearly with it — and "Select all N matching" can now
    // put thousands of ids behind one click. An edge-proxy timeout on such a
    // request would abandon a batch that had already partly committed, and the
    // route's audit entry is written after its loop, so those approvals would
    // land with no audit record. Batching bounds each request, gives each one
    // its own audit row, and keeps partial success attributable.
    const approvedIds: string[] = [];
    const failedIds: string[] = [];
    // Commit what earlier batches achieved, then report the abort — but don't
    // drop per-id rejections those batches already reported, or "40 of your
    // first 200 were refused" vanishes behind the generic abort message.
    const abortError = (message: string): Error => {
      if (approvedIds.length > 0) markApproved(approvedIds);
      return new Error(
        failedIds.length > 0
          ? t('patchesPage.errors.approveAbortedWithFailures', {
              message,
              count: failedIds.length,
            })
          : message
      );
    };
    for (let i = 0; i < patchIds.length; i += BULK_APPROVE_BATCH_SIZE) {
      const batch = patchIds.slice(i, i + BULK_APPROVE_BATCH_SIZE);
      // runaction-exempt: aggregate/partial-success — inline bulkError UI (see NOTE above)
      const response = await fetchWithAuth('/patches/bulk-approve', {
        method: 'POST',
        body: JSON.stringify({
          patchIds: batch,
          ringId: selectedRingId ?? undefined
        })
      });
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw abortError(t('patchesPage.errors.approvePatches'));
      }
      const body = await response.json().catch(() => null) as {
        approved?: string[];
        failed?: string[];
      } | null;
      if (body === null || !Array.isArray(body.approved)) {
        // A 200 whose body we can't read is NOT evidence the approvals landed.
        // Optimistically flipping the rows to "approved" here would assert a
        // result we don't have; report it as indeterminate instead.
        throw abortError(t('patchesPage.errors.approveUnknown'));
      }
      approvedIds.push(...body.approved);
      if (Array.isArray(body.failed)) failedIds.push(...body.failed);
    }

    markApproved(approvedIds);
    if (failedIds.length > 0) {
      throw new Error(
        t(
          /* i18n-dynamic */ failedIds.length === 1
            ? 'patchesPage.errors.approveCountOne'
            : 'patchesPage.errors.approveCountMany',
          { count: failedIds.length }
        )
      );
    }
  };

  const handleBulkDecline = async (patchIds: string[]) => {
    // Same partner-level scope requirement as approve (see handleBulkApprove).
    if (!canManageRings) {
      throw new Error(t('patchesPage.errors.partnerLevel'));
    }
    const failed: string[] = [];
    for (const id of patchIds) {
      // runaction-exempt: aggregate/partial-success — inline bulkError UI (see NOTE above)
      const response = await fetchWithAuth(`/patches/${id}/decline`, {
        method: 'POST',
        body: JSON.stringify({ ringId: selectedRingId ?? undefined })
      });
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        failed.push(id);
      }
    }
    const declined = patchIds.filter(id => !failed.includes(id));
    setPatches(prev =>
      prev.map(patch =>
        declined.includes(patch.id) ? { ...patch, approvalStatus: 'declined' as PatchApprovalStatus } : patch
      )
    );
    if (failed.length > 0) {
      throw new Error(t('patchesPage.errors.declineCount', { count: failed.length }));
    }
  };

  // Gather device IDs across all pages, then surface a scope-naming confirmation
  // before POSTing /patches/scan. The pagination pass is read-only GETs so it
  // is safe to run before the user confirms.
  const handleScan = async () => {
    setScanLoading(true);
    try {
      const ids = new Set<string>();
      // Collect the distinct orgIds reported by the device payloads so the
      // confirmation message names the action's TRUE targets, not the shell
      // selection (currentOrgId is stale on the global /patches route).
      const seenOrgIds = new Set<string>();
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        const devResponse = await fetchWithAuth(`/devices?limit=${DEVICE_SCAN_PAGE_LIMIT}&page=${page}`);
        if (!devResponse.ok) {
          if (devResponse.status === 401) { void navigateTo('/login', { replace: true }); return; }
          throw new Error(t('patchesPage.errors.loadDevicesForScan'));
        }

        const devBody = await devResponse.json();
        const devices = asList(devBody, 'devices', 'items');
        for (const device of Array.isArray(devices) ? devices : []) {
          const rawDevice = device && typeof device === 'object' ? device as Record<string, unknown> : null;
          const rawId = rawDevice?.id ?? rawDevice?.deviceId;
          const id = rawId ? String(rawId) : '';
          if (id) {
            ids.add(id);
            const rawOrgId = rawDevice?.orgId ?? rawDevice?.org_id;
            if (rawOrgId) seenOrgIds.add(String(rawOrgId));
          }
        }

        const total = Number(devBody?.pagination?.total ?? ids.size);
        totalPages = total > 0 ? Math.ceil(total / DEVICE_SCAN_PAGE_LIMIT) : page;
        page += 1;
      }

      const deviceIds = [...ids];
      if (deviceIds.length === 0) throw new Error(t('patchesPage.errors.noDevicesForScan'));

      // Derive org names from the actual device payloads so the confirmation
      // always names the true scope. Map known orgIds to store names; if an
      // orgId has no match (e.g. store not yet loaded) we still count it so
      // scopeConfirmMessage falls through to "across N organizations (...)".
      const orgNamesFromDevices: string[] = [];
      for (const oid of seenOrgIds) {
        const org = organizations.find(o => o.id === oid);
        orgNamesFromDevices.push(org ? org.name : oid);
      }
      // If the device API didn't expose orgId fields at all (older API), fall
      // back to listing all accessible orgs — still better than a stale single org.
      const orgNames = orgNamesFromDevices.length > 0
        ? orgNamesFromDevices
        : organizations.map(o => o.name);

      setPendingScan({ deviceIds, orgNames });
    } catch (err) {
      // Pre-scan errors only (device-list fetch failure, no devices).
      showToast({
        message: err instanceof Error ? err.message : t('patchesPage.scan.failedFallback'),
        type: 'error',
      });
    } finally {
      setScanLoading(false);
    }
  };

  const executeScan = async (deviceIds: string[]) => {
    setPendingScan(null);
    setScanLoading(true);
    try {
      // /patches/scan is an AGGREGATE / partial-success endpoint: a body
      // `success:false` can still mean "most devices were queued", and skipped
      // (missing / inaccessible) devices do NOT flip `success` at all. runAction's
      // binary failure gate would either hide skipped devices behind a clean
      // success toast (false negative) or collapse a partial result into a
      // generic "Patch scan failed". Handle the per-device breakdown explicitly
      // so the user always sees the true outcome. Documented runAction exception
      // — see runActionAllowlist.ts / no-silent-mutations.test.ts.
      // runaction-exempt: aggregate/partial-success — explicit breakdown toast below
      const scanRes = await fetchWithAuth('/patches/scan', {
        method: 'POST',
        body: JSON.stringify({ deviceIds }),
      });
      if (scanRes.status === 401) { void navigateTo('/login', { replace: true }); return; }

      const scanBody = (await scanRes.json().catch(() => null)) as {
        queuedCommandIds?: string[];
        dispatchedCommandIds?: string[];
        failedDeviceIds?: string[];
        skipped?: { missingDeviceIds?: string[]; inaccessibleDeviceIds?: string[] };
      } | null;

      if (!scanRes.ok || !scanBody) {
        showToast({ message: extractApiError(scanBody, t('patchesPage.scan.failedFallback')), type: 'error' });
        return;
      }

      const requested = deviceIds.length;
      const queued = Array.isArray(scanBody.queuedCommandIds) ? scanBody.queuedCommandIds.length : 0;
      const dispatched = Array.isArray(scanBody.dispatchedCommandIds) ? scanBody.dispatchedCommandIds.length : 0;
      const failed = Array.isArray(scanBody.failedDeviceIds) ? scanBody.failedDeviceIds.length : 0;
      const skipped =
        (scanBody.skipped?.missingDeviceIds?.length ?? 0) +
        (scanBody.skipped?.inaccessibleDeviceIds?.length ?? 0);
      const noun = (n: number) => t(/* i18n-dynamic */ n === 1 ? 'patchesPage.scan.deviceOne' : 'patchesPage.scan.deviceMany');
      const shortfall = [
        failed > 0 ? t('patchesPage.scan.failedToQueue', { count: failed }) : null,
        skipped > 0 ? t('patchesPage.scan.skipped', { count: skipped }) : null,
      ].filter(Boolean).join(', ');

      if (queued === 0) {
        // Nothing was queued — a genuine failure even though HTTP is 200.
        showToast({
          message: shortfall
            ? t('patchesPage.scan.failedZeroWithShortfall', { requested, noun: noun(requested), shortfall })
            : t('patchesPage.scan.failedZero', { requested, noun: noun(requested) }),
          type: 'error',
        });
        return;
      }

      if (shortfall) {
        // Partial — be explicit about what did NOT happen. The toast component
        // has no "warning" variant; use error styling so a partial run is not
        // mistaken for a clean success.
        showToast({
          message: t('patchesPage.scan.queuedPartial', { queued, requested, noun: noun(requested), shortfall }),
          type: 'error',
        });
      } else {
        showToast({
          message: t('patchesPage.scan.queuedSuccess', {
            queued,
            noun: noun(queued),
            dispatchSuffix: dispatched > 0 ? t('patchesPage.scan.dispatchedSuffix', { count: dispatched }) : '',
          }),
          type: 'success',
        });
      }
      await fetchPatches();
    } catch (err) {
      // The scan call above surfaces its own outcome and never throws; a 401
      // from the scan POST already redirected and returned before reaching here.
      showToast({
        message: err instanceof Error ? err.message : t('patchesPage.scan.failedFallback'),
        type: 'error',
      });
    } finally {
      setScanLoading(false);
    }
  };

  const handleRingSubmit = async (values: UpdateRingFormValues) => {
    const isEditing = !!editingRing;
    // Rings are partner-scoped: only partner/system users can create/edit them.
    // The UI already hides the rings tab and disables New Ring for org users, but
    // guard here too in case the form is somehow reachable.
    if (!canManageRings) {
      showToast({ message: RING_SCOPE_HINT, type: 'error' });
      return;
    }
    setRingSubmitting(true);
    setRingsError(undefined);
    try {
      const url = isEditing ? `/update-rings/${editingRing.id}` : '/update-rings';
      await runAction({
        request: () =>
          fetchWithAuth(url, {
            method: isEditing ? 'PATCH' : 'POST',
            body: JSON.stringify({
              name: values.name,
              description: values.description,
              ringOrder: values.ringOrder,
              deferralDays: values.deferralDays,
              deadlineDays: values.deadlineDays,
              gracePeriodHours: values.gracePeriodHours,
              autoApprove: values.autoApprove,
              categoryRules: values.categoryRules,
            }),
          }),
        errorFallback: isEditing ? t('patchesPage.errors.updateRing') : t('patchesPage.errors.createRing'),
        successMessage: isEditing ? t('patchesPage.toast.ringSaved') : t('patchesPage.toast.ringCreated'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      await fetchRings();
      setRingModalOpen(false);
      setEditingRing(null);
    } catch (err) {
      // runAction already toasted (and 401 already redirected). Keep the dialog
      // open + actionable by also surfacing the message inline in the form area.
      if (err instanceof ActionError && err.status === 401) return;
      setRingsError(
        err instanceof ActionError
          ? err.message
          : isEditing
            ? t('patchesPage.errors.updateRing')
            : t('patchesPage.errors.createRing')
      );
    } finally {
      setRingSubmitting(false);
    }
  };

  const handleRingDelete = async (ring: UpdateRingItem) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/update-rings/${ring.id}`, { method: 'DELETE' }),
        errorFallback: t('patchesPage.errors.deleteRing'),
        successMessage: t('patchesPage.toast.ringDeleted'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      await fetchRings();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      setRingsError(err instanceof ActionError ? err.message : t('patchesPage.errors.deleteRing'));
    }
  };

  // "Deploy" on an approved patch row: there is no single endpoint that pushes a
  // catalog patch fleet-wide from this list — actual installation happens
  // per-device on the Compliance tab (Select devices → Install) or on a device's
  // own Patches tab. Wiring onDeploy here closes the dead-click (the button
  // previously fired nothing because PatchesPage never passed onDeploy) by
  // routing the user to where deployment is actually performed, with feedback.
  const handleDeploy = useCallback(() => {
    setActiveTab('compliance');
    showToast({
      message: t('patchesPage.toast.chooseDevicesForInstall'),
      type: 'success',
    });
  }, [setActiveTab, t]);

  // ---- Derived ----

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('patchesPage.title')}</h1>
          <p className="text-muted-foreground">{t('patchesPage.description')}</p>
        </div>
        <div className="flex items-center gap-3">
          {(activeTab === 'compliance' || activeTab === 'patches') && (
            <button
              type="button"
              onClick={handleScan}
              disabled={scanLoading}
              data-testid="patch-run-scan"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {scanLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {scanLoading ? t('patchesPage.actions.scanning') : t('patchesPage.actions.runScan')}
            </button>
          )}
          {activeTab === 'rings' && (
            <button
              type="button"
              onClick={() => {
                setEditingRing(null);
                setRingsError(undefined);
                setRingModalOpen(true);
              }}
              disabled={!canManageRings}
              title={!canManageRings ? RING_SCOPE_HINT : undefined}
              data-testid="patch-new-ring"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {t('patchesPage.actions.newRing')}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <nav className="-mb-px flex gap-4 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              data-testid={`patch-tab-${tab.id}`}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Ring selector — visible on Patches & Compliance tabs */}
      {(activeTab === 'patches' || activeTab === 'compliance') && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <RingSelector
            rings={ringSelectorItems}
            selectedRingId={selectedRingId}
            onChange={setSelectedRingId}
            loading={ringsLoading}
          />
        </div>
      )}

      {/* Update Rings tab */}
      {activeTab === 'rings' && (
        <div>
          {ringsLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
                <p className="mt-4 text-sm text-muted-foreground">{t('patchesPage.loadingRings')}</p>
              </div>
            </div>
          ) : ringsError && rings.length === 0 ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
              <p className="text-sm text-destructive">{ringsError}</p>
              <button
                type="button"
                onClick={fetchRings}
                className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                {t('patchesPage.actions.tryAgain')}
              </button>
            </div>
          ) : (
            <UpdateRingList
              rings={rings}
              onEdit={(ring) => {
                setEditingRing(ring);
                setRingsError(undefined);
                setRingModalOpen(true);
              }}
              onDelete={handleRingDelete}
              onSelect={(ring) => {
                setSelectedRingId(ring.id);
                setActiveTab('patches');
              }}
            />
          )}
        </div>
      )}

      {/* Patches tab */}
      {activeTab === 'patches' && (
        <>
          <SourceFilterChips
            counts={sourceCounts}
            value={sourceFilter}
            onChange={setSourceFilter}
          />
          {patchesIncomplete !== null && (
            <div
              data-testid="patches-truncated-notice"
              data-cause={patchesIncomplete.cause}
              className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400"
            >
              <span>
                {t(
                  /* i18n-dynamic */ patchesIncomplete.cause === 'cap'
                    ? 'patchesPage.truncatedNotice'
                    : 'patchesPage.shiftedNotice',
                  { shown: patches.length, total: patchesIncomplete.total }
                )}
              </span>
              {patchesIncomplete.cause === 'shifted' && (
                <button
                  type="button"
                  onClick={fetchPatches}
                  data-testid="patches-reload"
                  className="ml-auto rounded-md border border-amber-500/40 px-2 py-1 text-xs font-medium hover:bg-amber-500/20"
                >
                  {t('patchList.actions.tryAgain')}
                </button>
              )}
            </div>
          )}
          <PatchList
            patches={sourceFilter === 'all' ? patches : patches.filter((p) => p.source === sourceFilter)}
            loading={patchesLoading}
            error={patchesError}
            onRetry={fetchPatches}
            onReview={handleReview}
            onDeploy={handleDeploy}
            onBulkApprove={handleBulkApprove}
            onBulkDecline={handleBulkDecline}
          />
        </>
      )}

      {/* Compliance tab — merged device view with summary */}
      {activeTab === 'compliance' && <PatchComplianceView ringId={selectedRingId} />}

      {/* Approval modal — passes ringId and org context for confirmation */}
      <PatchApprovalModal
        open={modalOpen}
        patch={selectedPatch}
        ringId={selectedRingId}
        orgName={currentOrg?.name ?? null}
        ringDeviceCount={selectedRingId ? (rings.find(r => r.id === selectedRingId)?.deviceCount ?? null) : null}
        onClose={() => {
          setModalOpen(false);
          setSelectedPatch(null);
        }}
        onSubmit={handleApprovalSubmit}
      />

      {/* Scan confirmation — names the scope before POSTing /patches/scan */}
      <ConfirmDialog
        open={pendingScan !== null}
        onClose={() => setPendingScan(null)}
        onConfirm={() => { if (pendingScan) void executeScan(pendingScan.deviceIds); }}
        title={t('patchesPage.scan.confirmTitle')}
        message={
          pendingScan
            ? pendingScan.orgNames.length <= 1
              ? t(
                  /* i18n-dynamic */ pendingScan.deviceIds.length === 1
                    ? 'patchesPage.scan.confirmMessageOne'
                    : 'patchesPage.scan.confirmMessageMany',
                  {
                    count: pendingScan.deviceIds.length,
                    org: pendingScan.orgNames[0] ?? t('patchesPage.scan.selectedOrganization'),
                  }
                )
              : t('patchesPage.scan.confirmMessageMultiOrg', {
                  count: pendingScan.deviceIds.length,
                  orgCount: pendingScan.orgNames.length,
                  orgNames: pendingScan.orgNames.join(', '),
                })
            : ''
        }
        confirmLabel={t('patchesPage.actions.scan')}
        variant="warning"
        isLoading={scanLoading}
        confirmTestId="confirm-fleet-action"
      />

      {/* Create / Edit Ring modal */}
      <Dialog
        open={ringModalOpen}
        onClose={() => { setRingModalOpen(false); setEditingRing(null); }}
        title={editingRing ? t('patchesPage.ringModal.editTitle') : t('patchesPage.ringModal.createTitle')}
        maxWidth="2xl"
        alignTop
        className="flex max-h-[90vh] flex-col"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold">
            {editingRing ? t('patchesPage.ringModal.editTitle') : t('patchesPage.ringModal.createTitle')}
          </h2>
          <button
            type="button"
            aria-label={t('patchesPage.actions.close')}
            onClick={() => { setRingModalOpen(false); setEditingRing(null); }}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            &times;
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-5">
          <UpdateRingForm
            key={editingRing?.id ?? 'new'}
            onSubmit={handleRingSubmit}
            onCancel={() => { setRingModalOpen(false); setEditingRing(null); }}
            submitLabel={
              ringSubmitting
                ? (editingRing ? t('patchesPage.actions.saving') : t('patchesPage.actions.creating'))
                : (editingRing ? t('patchesPage.actions.saveChanges') : t('patchesPage.actions.createRing'))
            }
            loading={ringSubmitting}
            usage={editingRing ? { deviceCount: editingRing.deviceCount } : undefined}
            defaultValues={editingRing ? {
              name: editingRing.name,
              description: editingRing.description ?? undefined,
              ringOrder: editingRing.ringOrder,
              deferralDays: editingRing.deferralDays,
              deadlineDays: editingRing.deadlineDays,
              gracePeriodHours: editingRing.gracePeriodHours,
              autoApprove: editingRing.autoApprove ?? { enabled: false, severities: [], deferralDays: 0 },
              categoryRules: editingRing.categoryRules,
            } : undefined}
          />
        </div>
      </Dialog>
    </div>
  );
}
