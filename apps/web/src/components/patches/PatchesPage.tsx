import { useMemo, useState, useEffect, useCallback } from 'react';
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
import { getJwtClaims } from '../../lib/authScope';
import { normalizePatch, normalizeRing } from './patchHelpers';
import { extractApiError } from '@/lib/apiError';
import { showToast } from '../shared/Toast';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { Dialog } from '../shared/Dialog';
import { runAction, ActionError } from '@/lib/runAction';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type TabKey = 'rings' | 'patches' | 'compliance';
const validTabs: TabKey[] = ['rings', 'patches', 'compliance'];

// Tab state lives in window.location.hash (`#patches`) per the project
// convention for transient UI state (CLAUDE.md), matching DiscoveryPage and
// DeviceDetails. The default `compliance` tab keeps the hash empty so the URL
// stays clean.
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
function resolveTab(tab: TabKey, canManageRings: boolean): TabKey {
  return tab === 'rings' && !canManageRings ? 'compliance' : tab;
}

const DEVICE_SCAN_PAGE_LIMIT = 100;

export default function PatchesPage() {
  const { t } = useTranslation('patches');
  const { organizations, currentOrgId } = useOrgStore();
  const currentOrg = organizations.find(o => o.id === currentOrgId) ?? null;
  const { scope } = getJwtClaims();
  // Rings + approvals are partner-scoped: only partner/system users manage them.
  const canManageRings = scope === 'partner' || scope === 'system';
  const RING_SCOPE_HINT = t('patchesPage.ringScopeHint');

  // The Update Rings tab is gated on the client-only JWT scope (canManageRings),
  // which is absent during SSR, so the server renders two tabs and the client
  // three. Render the tab list from an SSR-stable value until after mount so the
  // first client render matches the server markup — companion to the #2421
  // active-tab fix below. canManageRings itself stays accurate everywhere else
  // (the hash-resolution effect, ring actions) so the #rings deep-link and
  // scope guards are unaffected.
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
  // org user can't access falls back to compliance, and when that downgrade fires
  // we route through setActiveTab so the stale #rings is cleared from the URL
  // rather than left pointing at a tab the user isn't on. Depending on
  // canManageRings also re-runs the guard when scope/permissions arrive after the
  // first render (defense-in-depth).
  useEffect(() => {
    const syncFromHash = () => {
      const raw = getTabFromHash();
      const resolved = resolveTab(raw, canManageRings);
      if (resolved !== raw) {
        setActiveTab(resolved); // downgrade — also clears the stale hash
      } else {
        setActiveTabState(resolved);
      }
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [canManageRings, setActiveTab]);
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
      const ringData = data.data ?? data ?? [];
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
    try {
      setPatchesLoading(true);
      setPatchesError(undefined);
      // Fixed `limit=200` fetch: PatchList sorts AND paginates entirely
      // client-side over this already-loaded array (issue #1316), so the
      // page-size selector (up to 200) is fully populated. Caveat: for an org
      // with >200 patches, only the loaded subset is sorted/searched — the rest
      // are never fetched. Note: this never sends sortBy/sortDir, so the
      // server-side sort added to the API (list.ts / schemas.ts) is NOT yet
      // consumed by the web; wiring it up is a follow-up (see list.ts comment).
      // Ring-scoped patches use a dedicated endpoint; send the same `limit=200`
      // so selecting a ring doesn't collapse the list to the endpoint's default
      // page of 50 (the ring endpoint now shares the /patches 200 cap).
      const url = selectedRingId
        ? `/update-rings/${selectedRingId}/patches?limit=200`
        : '/patches?limit=200';
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw new Error(t('patchesPage.errors.fetchPatches'));
      }
      const data = await response.json();
      const patchData = data.data ?? data.patches ?? data.items ?? data ?? [];
      const normalized = Array.isArray(patchData)
        ? patchData.map((patch: Record<string, unknown>, index: number) => normalizePatch(patch, index))
        : [];
      setPatches(normalized);
      if (data && typeof data.counts === 'object' && data.counts !== null) {
        setSourceCounts(data.counts as Record<string, number>);
      } else {
        setSourceCounts({});
      }
    } catch (err) {
      setPatchesError(err instanceof Error ? err.message : t('patchesPage.errors.fetchPatches'));
    } finally {
      setPatchesLoading(false);
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
    // runaction-exempt: aggregate/partial-success — inline bulkError UI (see NOTE above)
    const response = await fetchWithAuth('/patches/bulk-approve', {
      method: 'POST',
      body: JSON.stringify({
        patchIds,
        ringId: selectedRingId ?? undefined
      })
    });
    if (!response.ok) {
      if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
      throw new Error(t('patchesPage.errors.approvePatches'));
    }
    const body = await response.json().catch(() => ({})) as {
      approved?: string[];
      failed?: string[];
    };
    const approvedIds = Array.isArray(body.approved) ? body.approved : patchIds;
    const failedIds = Array.isArray(body.failed) ? body.failed : [];
    setPatches(prev =>
      prev.map(patch =>
        approvedIds.includes(patch.id) ? { ...patch, approvalStatus: 'approved' as PatchApprovalStatus } : patch
      )
    );
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
        const devices = devBody.devices ?? devBody.data ?? devBody.items ?? devBody ?? [];
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
