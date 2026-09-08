import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useEventStream } from '../../hooks/useEventStream';
import { useAdvancedFilterIds } from '../../hooks/useAdvancedFilterIds';
import { List, Grid, Plus, AlertCircle, ChevronDown } from 'lucide-react';
import { showToast } from '../shared/Toast';
import { formatDateTime } from '@/lib/dateTimeFormat';
import type { FilterConditionGroup } from '@breeze/shared';
import DeviceList, { type Device, type DeviceClass, type DeviceStatus, type OSType } from './DeviceList';
import type { DeviceRole } from '@/lib/deviceRoles';
import DeviceCard from './DeviceCard';
import DecommissionedHiddenHint from './DecommissionedHiddenHint';
import ScriptPickerModal, { type Script, type ScriptRunAsSelection } from './ScriptPickerModal';
import DeviceSettingsModal from './DeviceSettingsModal';
import RemoveDeviceDialog from './RemoveDeviceDialog';
import { BulkPurgeDialog } from './BulkPurgeDialog';
import AddDeviceModal from './AddDeviceModal';
import ManualAssetModal from './ManualAssetModal';
import AddNetworkAssetModal from './AddNetworkAssetModal';
import RmmCustomFieldImport from './RmmCustomFieldImport';
import CreateGroupModal from './CreateGroupModal';
import LinkVmHostModal from './LinkVmHostModal';
import { DeviceFilterBar } from '../filters/DeviceFilterBar';
import { DeviceFilterToolbar } from './DeviceFilterToolbar';
import { type ListFilters, DEFAULT_LIST_FILTERS } from './deviceListFilters';
import { decodeFilterFromHash, writeFilterToHash, isFiltersV2Enabled } from './filterUrl';
import { useOrgIdFromHash } from './orgHash';
import { DeviceClassSegment } from './DeviceClassSegment';
import {
  filterDevicesByClass,
  countDevicesByClass,
  readDeviceClassFromHash,
  writeDeviceClassToHash,
  type DeviceClassFilter,
} from './deviceClassFilter';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { runAction } from '../../lib/runAction';
import { fetchAllDevices, fetchAllNetworkDevices, fetchAllManualAssets } from '../../lib/devicesFetch';
import { useOrgStore } from '../../stores/orgStore';
import { useOrgScope } from '@/hooks/useOrgScope';
import { OrgLoadFailedState } from '../shared/OrgLoadFailedState';
import { sendDeviceCommand, sendBulkCommand, executeScript, exitMaintenanceMode, decommissionDevice, bulkDecommissionDevices, restoreDevice, permanentDeleteDevice, sendWakeCommand, sendBulkWakeCommand, summarizeBulkWakeFailures, summarizeBulkCommandFailures, watchWakeOutcome, WakeCommandError, wakeFriendlyErrorMessage, linkDevicesMultiboot, linkDevicesVmHost, bulkRestoreDevices, startBulkPurge, fetchPurgeRun, PURGE_POLL_INTERVAL_MS } from '../../services/deviceActions';
import type { BulkMaintenanceResponse } from '../../services/deviceActions';
import MaintenanceModeDialog from './MaintenanceModeDialog';
import { isInMaintenance } from '../../lib/maintenanceResource';
import { navigateTo } from '@/lib/navigation';
import { useHashState } from '@/lib/useHashState';
import { getErrorMessage, getErrorTitle, isAccessDenied } from '@/lib/errorMessages';
import AccessDenied from '../shared/AccessDenied';
import { asRecord, toPercent } from '@/lib/deviceUtils';
import { ENABLE_NETWORK_DEVICES_IN_LIST } from '@/lib/featureFlags';
import ProgressBar from '../shared/ProgressBar';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { scopeConfirmMessage } from '@/lib/scopeConfirmMessage';
import { DECOMMISSION_BLOCKED_BULK_ACTIONS, isCommandQueueable } from './bulkActionGating';
import { matchesMergedListFilters, sortByDisplayName, summarizeHiddenNonAgentDevices, VPN_FACET_FIELD } from './mergedListFilter';
import { COLUMN_LABELS } from './columnVisibility';
import { FILTER_FIELDS } from '../filters/filterFields';
import { asList } from '@/lib/asList';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

// vm_host member role (#2308): unknown values degrade to "ungrouped" (null) by
// design — a wrong nesting would be worse than none — but the degradation must
// be observable, or a future third role silently flattens every affected fleet
// until someone files "VM nesting stopped working". Warn once per value, not
// per row/refetch.
const warnedUnknownLinkGroupRoles = new Set<string>();
function normalizeLinkGroupRole(value: unknown): 'host' | 'guest' | null {
  if (value === 'host' || value === 'guest') return value;
  if (value != null && !warnedUnknownLinkGroupRoles.has(String(value))) {
    warnedUnknownLinkGroupRoles.add(String(value));
    console.warn(`[devices] unknown linkGroupRole ${JSON.stringify(value)} — treating the device as ungrouped`);
  }
  return null;
}

type ViewMode = 'list' | 'grid';

type Org = {
  id: string;
  name: string;
};

type Site = {
  id: string;
  name: string;
  /** Present on every `/orgs/sites` row; declared so the manual-asset modal
   *  (#4622 W04) can filter to the selected org's sites. */
  orgId?: string;
};

type DeviceGroup = {
  id: string;
  name: string;
  type: 'static' | 'dynamic';
  deviceCount: number;
  deviceIds?: string[];
};

// Compact, bounded summary of which devices failed in a per-item bulk loop, so
// a 50-device batch with failures yields one readable toast (not 50 toasts or
// an opaque "some failed"). Caps the named list to avoid an unbounded string.
function summarizeFailedDevices(names: string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

// #3698: destructive single-device actions, confirm-gated to match the device
// detail page. `lock` is deliberately NOT here: it is reversible and does not
// disconnect the machine, which is where DeviceActions.tsx draws the same line.
// `restore` fails the same test and then some: it UNDOES a decommission, so
// gating it would put a dialog in front of the recovery path.
//
// #4009: `decommission` belongs here and was missed by #3698. The dialog copy
// it needs (deviceActions.confirm.decommission.*) already shipped for the
// detail page, which has always gated it; only the list and grid kebabs fired
// it on a single click. A kebab in a dense row/card grid is easier to hit by
// accident than the detail page's own button, so it was the wrong one to leave
// ungated.
// Module scope — these are constant, so there is no reason to rebuild them on
// every render.
//
// #5023: `permanent-delete` belongs here for a stronger reason than any of the
// others. Bulk purge has always made the operator type the device count
// (BulkPurgeDialog), while the single row/card kebab fired the same
// irreversible operation on one click — and unlike `decommission` there is no
// Restore afterwards. The 5s undo toast is not a substitute for a gate: it
// starts a countdown the operator has to NOTICE to stop.
const CONFIRM_REQUIRED_ACTIONS = new Set(['reboot', 'reboot_safe_mode', 'shutdown', 'decommission', 'permanent-delete', 'delete-manual']);

// ConfirmDialog encodes severity by SHAPE as well as colour (stop-octagon vs
// caution-triangle), so the grading has to match the detail page rather than
// drift from it: DeviceActions.tsx marks shutdown and decommission
// `destructive` and every other confirm `warning`. A manual-asset delete
// (#4622 W04) is a hard delete with no undo, so it's graded the same as
// permanent-delete.
const DESTRUCTIVE_CONFIRM_ACTIONS = new Set(['shutdown', 'decommission', 'permanent-delete', 'delete-manual']);

// The command name is snake_case / kebab-case; the locale keys are camelCase.
const CONFIRM_KEY_OVERRIDES: Record<string, string> = {
  reboot_safe_mode: 'rebootSafeMode',
  'permanent-delete': 'permanentDelete',
  'delete-manual': 'deleteManual',
};
const confirmKeyFor = (action: string): string => CONFIRM_KEY_OVERRIDES[action] ?? action;

/**
 * The Devices page's "Add" control (#4622 W04). What was a single "Install
 * agent" button (opens AddDeviceModal — enrollment, creates no row) is now a
 * split menu: *Install agent…* (unchanged) and *Add asset manually…* (new,
 * opens ManualAssetModal). Used in both the header and the empty-state
 * duplicate so the two never drift.
 *
 * The THIRD item — *Add network asset…* (#5213 W02, hand-entered
 * discovered_assets rows, opens AddNetworkAssetModal) — landed on `main` in
 * parallel as its own inline split menu; this merge folds it into this shared
 * component so there is exactly ONE Add control on the page, and so the two
 * instances no longer share a single open/closed flag (main's did, which made
 * the header and empty-state menus open together).
 */
function AddAssetMenu({
  onInstallAgent,
  onAddManualAsset,
  onAddNetworkAsset,
  variant,
  testIdPrefix,
}: {
  onInstallAgent: () => void;
  onAddManualAsset: () => void;
  onAddNetworkAsset: () => void;
  variant: 'primary' | 'secondary';
  /** Distinguishes the header instance from the empty-state duplicate for testids. */
  testIdPrefix: string;
}) {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        data-testid={`${testIdPrefix}-trigger`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          variant === 'primary'
            ? 'flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90'
            : 'flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted'
        }
      >
        <Plus className="h-4 w-4" />
        {t('devicesPage.addMenu.trigger')}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          data-testid={testIdPrefix}
          className="absolute right-0 z-20 mt-1 w-56 rounded-md border bg-card shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            data-testid={`${testIdPrefix}-install-agent`}
            onClick={() => {
              setOpen(false);
              onInstallAgent();
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
          >
            {t('devicesPage.addMenu.installAgent')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid={`${testIdPrefix}-add-manual-asset`}
            onClick={() => {
              setOpen(false);
              onAddManualAsset();
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
          >
            {t('devicesPage.addMenu.addManualAsset')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid={`${testIdPrefix}-network-asset`}
            onClick={() => {
              setOpen(false);
              onAddNetworkAsset();
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
          >
            {t('devicesPage.addMenu.addNetworkAsset')}
          </button>
        </div>
      )}
    </div>
  );
}

export default function DevicesPage() {
  const { t } = useTranslation('devices');
  // Org scope is shown by the always-visible top-bar switcher (scope pill +
  // org picker); the page header no longer repeats it. orgStoreOrgs is still
  // used to name orgs in the run-script confirm dialog.
  const { organizations: orgStoreOrgs } = useOrgStore();

  // #4147 — the list fetch carries no orgId of its own: fetchWithAuth injects
  // the org store's selection synchronously at call time. Logout wipes the
  // persisted `breeze-org` key, so on the FIRST load after a login the store is
  // empty and only resolves once the shell's OrgSwitcher finishes its async
  // fetchOrganizations. A fetch fired at mount therefore went out with no
  // orgId — the API reads that as "every accessible org" — and nothing ever
  // refetched, so the list stayed fleet-wide while the switcher pill showed a
  // single org. (Re-picking an org only "fixed" it because applyOrgSwitch does
  // a full window.location.reload, by which point the org IS persisted and
  // rehydrates synchronously.)
  //
  // So key the fetch on the RESOLVED scope rather than on mount: hold while the
  // context is still loading, then fetch — and refetch — whenever the scope
  // changes. Deliberately keyed, not merely gated: a gate alone would still
  // leave a resolved-later change unobserved.
  const orgScope = useOrgScope();
  const orgScopeResolving = orgScope.status === 'loading';
  // 'error' gets its own render branch (see OrgLoadFailedState below) rather
  // than an unscoped fetch. 'empty' — list loaded, this partner genuinely has
  // zero orgs — is terminal and harmless: there is nothing to scope to, so it
  // fetches and settles instead of spinning.
  const orgContextFailed = orgScope.status === 'error';
  // Prefixed so an org id can never collide with a status/fleet sentinel.
  const orgScopeKey =
    orgScope.status !== 'resolved'
      ? `status:${orgScope.status}`
      : orgScope.scope === 'all'
        ? 'scope:all'
        : `org:${orgScope.orgId}`;

  const [devices, setDevices] = useState<Device[]>([]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  // Issue #5285: each visible org's effective agent-version target (pin or
  // promoted fallback), resolved once per page load — see the fetch below.
  // Absent until it resolves; DeviceList treats a missing entry as "not
  // resolved yet" and renders the column unchanged (no tint).
  const [effectiveAgentVersionByOrgId, setEffectiveAgentVersionByOrgId] =
    useState<Record<string, string | null>>({});
  const [deviceGroups, setDeviceGroups] = useState<DeviceGroup[]>([]);
  const [groupMembershipMap, setGroupMembershipMap] = useState<Map<string, Set<string>>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [actionInProgress, setActionInProgress] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  // The three hash-seeded states below adopt the hash post-mount via
  // useHashState so the first client render matches the SSR markup (#2421).
  const [showAddDevice, setShowAddDevice] = useHashState<boolean>(false, (h) => (h === 'add-device' ? true : undefined));
  // Manual asset add/edit modal (#4622 W04). Add is hash-seeded like every
  // other modal on this page; editing an EXISTING asset carries the full row
  // (needed for the form fields) so it is plain component state, not hash —
  // the hash only needs to say "the add flow is open", never which asset.
  const [showAddManualAsset, setShowAddManualAsset] = useHashState<boolean>(false, (h) => (h === 'add-manual-asset' ? true : undefined));
  const [editingManualAsset, setEditingManualAsset] = useState<Device | null>(null);
  // Manual network asset (#5213 W02) — the third item of the shared
  // AddAssetMenu below. Its own hash entry (not nested under showAddDevice),
  // same shape as the manual-asset flow above.
  const [showAddNetworkAsset, setShowAddNetworkAsset] = useHashState<boolean>(false, (h) =>
    h === 'add-network-asset' ? true : undefined,
  );
  // "Import from another RMM" (#3257 W09): the wizard owns its OWN step hash
  // (#import-definitions / #import-values) internally, so this only tracks
  // whether either of those hashes means the wizard is open at all.
  const [showRmmImport, setShowRmmImport] = useHashState<boolean>(false, (h) =>
    h === 'import-definitions' || h === 'import-values' ? true : undefined,
  );
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);
  // Non-null = MaintenanceModeDialog is open for exactly these devices. Holding
  // the SET (not just a flag) is what lets the completion handler name the
  // devices the server reported back on.
  const [maintenanceDialogDevices, setMaintenanceDialogDevices] = useState<Device[] | null>(null);
  // vm_host link creation (#2308): the bulk action opens a host-picker modal
  // over the selected devices; null = closed.
  const [vmHostPickerDevices, setVmHostPickerDevices] = useState<Device[] | null>(null);
  const [scriptTargetDevices, setScriptTargetDevices] = useState<Device[]>([]);
  type PendingScriptRun = { script: Script; runAs: ScriptRunAsSelection; parameters?: Record<string, unknown>; devices: Device[] };
  const [pendingScriptRun, setPendingScriptRun] = useState<PendingScriptRun | null>(null);
  // #2465: a bulk agent command whose selection included decommissioned devices
  // (the one status the API refuses). `devices` is the eligible subset the action
  // will actually run on — offline devices stay IN, since their command queues
  // and runs on reconnect. The dialog reports what is being dropped so the user
  // confirms the reduced target set rather than having part of their selection
  // silently discarded.
  type PendingDecommissionedSkip = { action: string; devices: Device[]; skippedCount: number; totalCount: number };
  const [pendingDecommissionedSkip, setPendingDecommissionedSkip] = useState<PendingDecommissionedSkip | null>(null);
  // #3698: single-device destructive actions from the row kebab. The device
  // DETAIL page has always confirmed these (DeviceActions.tsx); the list did
  // not, so whether rebooting a production box asked "are you sure?" depended
  // on which screen you were on — and the list is the dense, easy-to-mis-click
  // one, with Reboot sitting next to Run Script and Wake.
  const [pendingDeviceAction, setPendingDeviceAction] = useState<{ action: string; device: Device } | null>(null);
  // #3987: bulk Remove asks the agent question ONCE for the whole selection,
  // then runBulkRemove runs the per-device DELETE loop with that one answer.
  const [pendingBulkRemove, setPendingBulkRemove] = useState<Device[] | null>(null);
  // Manual asset bulk delete (#4622 W04): hard delete, no undo, so it asks
  // once for the whole (already manual-only) selection before the per-item
  // DELETE loop in runBulkDeleteManual.
  const [pendingBulkDeleteManual, setPendingBulkDeleteManual] = useState<Device[] | null>(null);
  // #2787: bulk Delete permanently. The dialog asks for the count to be typed;
  // runBulkPurge then starts the async job and polls it.
  const [pendingBulkPurge, setPendingBulkPurge] = useState<Device[] | null>(null);
  const purgePollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped whenever a poll chain is superseded (a new run, or unmount), so a
  // tick already in flight cannot land its result over a newer run's.
  const purgePollTokenRef = useRef(0);
  const [settingsDevice, setSettingsDevice] = useState<Device | null>(null);
  // v2 chip bar seeds its filter from the URL hash so a filtered view is
  // shareable; the legacy DeviceFilterBar owns its own state and ignores it.
  const [advancedFilter, setAdvancedFilter] = useHashState<FilterConditionGroup | null>(null, (h) => decodeFilterFromHash(h) ?? undefined);
  // [ All | Agent | Network ] class segment (#1424). Seeded from the hash so a
  // chosen class is shareable; a pure client-side narrowing of the merged list.
  // Only meaningful when the network arm is enabled (otherwise the list is
  // agent-only and the segment is hidden).
  const [deviceClassFilter, setDeviceClassFilter] = useHashState<DeviceClassFilter>('all', (h) => readDeviceClassFromHash(h));
  const handleDeviceClassChange = useCallback((next: DeviceClassFilter) => {
    setDeviceClassFilter(next);
    writeDeviceClassToHash(next);
  }, []);
  // Inline ("instant") client-side filters — shared between DeviceFilterToolbar
  // (the controls) and DeviceList (the filtering) so each dimension has a single
  // source of truth. This is the hybrid model's client half; the group above is
  // its server half.
  const [listFilters, setListFilters] = useState<ListFilters>(DEFAULT_LIST_FILTERS);
  const filtersV2 = typeof window !== 'undefined' ? isFiltersV2Enabled() : false;
  // #3205 W06: a coverage-notice deep link pins the org in the hash. Adoption is a
  // LAYOUT effect, and its position above useAdvancedFilterIds is load-bearing:
  // React runs every layout effect in a commit before any passive effect, and the
  // filter preview (useAdvancedFilterIds.ts:40) is a passive effect keyed on the
  // FILTER alone — it never re-runs when the org changes, so a preview that fired
  // first would be computed against the wrong org and never corrected.
  // Pinned by DevicesPage.deepLink.test.tsx.
  useOrgIdFromHash();
  // Resolve the advanced filter to the complete (uncapped) matching id set
  // once, here, so the list AND grid views render the same filtered fleet.
  // The grid previously mapped the raw devices array and ignored the filter.
  const {
    ids: advancedFilterIds,
    loading: advancedFilterLoading,
    error: advancedFilterError,
    // #5023: the resolution is keyed on the FILTER, so it never notices that a
    // mutation changed a filtered attribute. Every post-mutation refresh below
    // goes through `refreshDevices`, which re-resolves the id set as well.
    refetch: refetchAdvancedFilterIds,
  } = useAdvancedFilterIds(advancedFilter);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [autoSelectGroupId, setAutoSelectGroupId] = useState<string | null>(null);

  // #1459 — distinct software names for the filter picker, fetched server-side
  // (debounced) as the user types so the picker searches the real inventory
  // instead of falling back to free-text. Passing a defined array also flips
  // SoftwareMultiSelect out of its `noBackend` CSV fallback.
  const [softwareOptions, setSoftwareOptions] = useState<string[]>([]);
  const softwareSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const softwareSearchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    if (softwareSearchTimerRef.current) clearTimeout(softwareSearchTimerRef.current);
    softwareSearchAbortRef.current?.abort();
  }, []);
  const handleSoftwareSearch = useCallback((q: string) => {
    if (softwareSearchTimerRef.current) clearTimeout(softwareSearchTimerRef.current);
    const term = q.trim();
    if (!term) {
      setSoftwareOptions([]);
      return;
    }
    softwareSearchTimerRef.current = setTimeout(async () => {
      softwareSearchAbortRef.current?.abort();
      const ctrl = new AbortController();
      softwareSearchAbortRef.current = ctrl;
      try {
        const res = await fetchWithAuth(
          `/software-inventory/names?q=${encodeURIComponent(term)}`,
          { signal: ctrl.signal }
        );
        if (!res.ok) return;
        const body = await res.json();
        setSoftwareOptions(Array.isArray(body.data) ? body.data : []);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.warn('Failed to fetch software names:', err);
      }
    }, 250);
  }, []);

  // Track every in-flight wake watcher so navigating away aborts the
  // long-running poll loop. Without this, each wake fired on this page
  // keeps polling /devices/:id for up to 4 minutes after unmount and
  // attempts setState (via showToast + fetchDevices) on a dead component.
  // (Todd's #789 review.) A user can wake several rows in quick
  // succession, hence a Set rather than a single controller.
  const wakeWatchersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    const watchers = wakeWatchersRef.current;
    return () => {
      for (const ctrl of watchers) ctrl.abort();
      watchers.clear();
    };
  }, []);

  const scriptTargetLabel =
    scriptTargetDevices.length === 1
      ? scriptTargetDevices[0].hostname
      : scriptTargetDevices.length > 1
        ? `${scriptTargetDevices.length} devices`
        : 'selected devices';

  const scriptTargetOs = useMemo(() => {
    const unique = [...new Set(scriptTargetDevices.map(d => d.os))];
    return unique.length > 0 ? unique : undefined;
  }, [scriptTargetDevices]);

  // Grid view applies the advanced filter here; the list view passes the id
  // set into DeviceList, which combines it with its local quick-filters
  // (search/status/os/etc. stay list-only).
  //
  // Decommissioned devices are hidden by default (old list behavior). They
  // become visible in two ways: the active filter group explicitly targets
  // the 'decommissioned' status (a user filtering FOR removed devices still
  // sees them), or the tech clicked "show" on the hidden-removed hint, which
  // flips the page-level showRemoved flag. The flag ADDS the removed rows to
  // whatever is on screen — it does not touch the advanced filter (#5023
  // paper cut: "show" used to swap the view to a removed-only status filter,
  // dropping every active device the tech was looking at). Transient session
  // state on purpose: a reload returns to the hidden-by-default view.
  const [showRemoved, setShowRemoved] = useState(false);
  const filterTargetsDecommissioned = useMemo(() => {
    const conds = advancedFilter?.conditions ?? [];
    return conds.some(c => {
      if ('conditions' in c) return false; // nested groups: ignore (rare)
      if (c.field !== 'status') return false;
      return Array.isArray(c.value)
        ? (c.value as unknown[]).includes('decommissioned')
        : c.value === 'decommissioned';
    });
  }, [advancedFilter]);
  const includeDecommissioned = showRemoved || filterTargetsDecommissioned;

  const handleShowDecommissioned = useCallback(() => setShowRemoved(true), []);
  const handleHideDecommissioned = useCallback(() => setShowRemoved(false), []);
  // "hide" is only meaningful while the flag (not an explicit status filter)
  // is what unhid the rows; otherwise clicking it would visibly do nothing.
  const onHideDecommissioned =
    showRemoved && !filterTargetsDecommissioned ? handleHideDecommissioned : undefined;

  // The fleet as the active filters (advanced filter, search, decommissioned
  // rule) leave it — the SAME predicate DeviceList applies, so the segment
  // badges below count exactly the rows a segment will render. Class is not
  // applied here: each badge shows its own class's filtered total.
  const listFilterContext = useMemo(
    () => ({
      serverFilterIds: advancedFilterIds,
      advancedFilter,
      includeDecommissioned,
      query: listFilters.search,
      vpn: listFilters.vpn ?? 'all',
    }),
    [advancedFilterIds, advancedFilter, includeDecommissioned, listFilters.search, listFilters.vpn]
  );
  const fleetFilteredDevices = useMemo(
    () => devices.filter(d => matchesMergedListFilters(d, listFilterContext)),
    [devices, listFilterContext]
  );
  const deviceClassCounts = useMemo(() => countDevicesByClass(fleetFilteredDevices), [fleetFilteredDevices]);
  // The merged list narrowed by class only — what the table receives.
  // DeviceList applies the shared predicate itself (it owns paging), while the
  // grid below applies it here; both start from the same class-narrowed set.
  const classFilteredDevices = useMemo(
    () => filterDevicesByClass(devices, deviceClassFilter),
    [devices, deviceClassFilter]
  );
  // Non-agent rows (network OR manual, #4622) the active filters hide only
  // because they ask about agent-only things (filter fields like
  // patches/alerts/metrics, or the VPN facet). Scoped to the chosen class so
  // the notice matches what the tech is looking at; rows already hidden by
  // search or the decommissioned rule are not counted (see
  // summarizeHiddenNonAgentDevices).
  const hiddenNetwork = useMemo(
    () => summarizeHiddenNonAgentDevices(classFilteredDevices, listFilterContext),
    [classFilteredDevices, listFilterContext]
  );
  const hiddenNetworkFieldLabels = useMemo(
    () =>
      hiddenNetwork.fields
        .map(f => (f === VPN_FACET_FIELD ? COLUMN_LABELS.vpn : FILTER_FIELDS.find(d => d.key === f)?.label ?? f))
        .join(', '),
    [hiddenNetwork.fields]
  );
  // Which non-agent class(es) contributed to the count above, so the notice
  // can say "3 manual assets hidden" instead of defaulting every non-agent
  // row to "network devices" (#4622 W04).
  const hiddenNonAgentClassLabel = useMemo(() => {
    if (hiddenNetwork.classes.length === 1) {
      return t(/* i18n-dynamic */ `devicesPage.hiddenNonAgentClassLabel.${hiddenNetwork.classes[0]}`);
    }
    return t('devicesPage.hiddenNonAgentClassLabel.mixed');
  }, [hiddenNetwork.classes, t]);
  // Rows the filters admit, before the hidden-by-default decommissioned rule —
  // the removed-hint counts come from this set so they only promise rows
  // "show" can actually reveal (#2251/#5023). Same shared predicate as the
  // table, with the decommissioned rule lifted.
  const gridMatchingDevices = useMemo(
    () =>
      classFilteredDevices.filter(d =>
        matchesMergedListFilters(d, { ...listFilterContext, includeDecommissioned: true })
      ),
    [classFilteredDevices, listFilterContext]
  );
  // Grid view: same filtered rows as the table (search included) in the same
  // default order, instead of the raw fetch concatenation.
  const gridDevices = useMemo(
    () =>
      sortByDisplayName(
        includeDecommissioned
          ? gridMatchingDevices
          : gridMatchingDevices.filter(d => d.status !== 'decommissioned')
      ),
    [gridMatchingDevices, includeDecommissioned]
  );
  // How many decommissioned devices the grid is hiding / showing (#2251) —
  // drives the grid view's hint line (the list view computes its own from the
  // same inputs, so the two stay in lockstep). The page fetches with
  // includeDecommissioned: true, so this is a cheap client-side count.
  const decommissionedCount = useMemo(
    () => gridMatchingDevices.filter(d => d.status === 'decommissioned').length,
    [gridMatchingDevices]
  );
  const hiddenDecommissionedCount = includeDecommissioned ? 0 : decommissionedCount;
  const shownDecommissionedCount = includeDecommissioned ? decommissionedCount : 0;

  const fetchDevices = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);

      // Devices walk the cursor (Discussion #742 PR 3); orgs/sites/groups
      // are bounded one-shot fetches. Run all four in parallel so the
      // first paint isn't gated on the slowest one. fetchAllDevices is
      // forward+backward compatible: against the cursor API it walks
      // pages, against the legacy offset API it returns the first
      // capped page and stops — same UX as before, no user-visible cap
      // once the server-side cursor migration lands.
      //
      // `signal` is wired by the mount useEffect's AbortController so a
      // navigate-away mid-walk stops the next page request and prevents
      // setState on an unmounted component (#778 review).
      const [devicesResult, networkResult, manualResult, orgsResponse, sitesResponse, groupsResponse] = await Promise.all([
        fetchAllDevices({
          includeDecommissioned: true,
          signal,
          // Surface the silent-cap case (#778 review). Without this, hitting
          // the safety ceiling would render an incomplete device list and
          // get reported later as "devices are missing."
          onTruncated: ({ actualCount }) => {
            showToast({
              type: 'error',
              message: t('devicesPage.toasts.listTruncated', { count: actualCount }),
              duration: 8000
            });
          }
        }),
        // Network arm of the unified list (#1322) — approved, unlinked
        // discovered_assets. Gated behind ENABLE_NETWORK_DEVICES_IN_LIST and
        // off by default; when disabled we skip the fetch entirely and the list
        // is the agent-only view. Best-effort otherwise: a transient/absent-
        // endpoint failure here must not blank the agent fleet, so we degrade to
        // an empty network set. A 401, however, is a real auth failure and must
        // NOT be masked — re-throw it so it propagates to the outer catch and
        // gets the same auth-redirect/logout handling as the agent arm
        // (fetchWithAuth already triggered logout). Swallowing it would leave the
        // user on a half-rendered, silently-broken page. (The endpoint-absent
        // case is a 404, already degraded to empty inside fetchAllNetworkDevices.)
        ENABLE_NETWORK_DEVICES_IN_LIST
          ? fetchAllNetworkDevices({ signal }).catch((err) => {
              if (err instanceof Error && err.name === 'AbortError') throw err;
              if (err instanceof Response && err.status === 401) throw err;
              console.warn('Failed to fetch network devices:', err);
              return { data: [], total: 0, pagesWalked: 0 };
            })
          : Promise.resolve({ data: [], total: 0, pagesWalked: 0 }),
        // Manual arm of the unified list (#4622 W04) — hand-entered inventory
        // rows with no network identity. Carries NO feature flag: fetched
        // unconditionally, independent of ENABLE_NETWORK_DEVICES_IN_LIST, so
        // an org's manual assets show up even with the network arm off. Same
        // best-effort degrade-to-empty semantics as the network arm above; a
        // 401 is a real auth failure and is re-thrown, never masked.
        fetchAllManualAssets({ signal }).catch((err) => {
          if (err instanceof Error && err.name === 'AbortError') throw err;
          if (err instanceof Response && err.status === 401) throw err;
          console.warn('Failed to fetch manual assets:', err);
          return { data: [], total: 0, pagesWalked: 0 };
        }),
        fetchWithAuth('/orgs', { signal }),
        fetchWithAuth('/orgs/sites', { signal }),
        fetchWithAuth('/device-groups?includeMemberships=true', { signal }).catch((err) => {
          // AbortError on unmount is expected — bubble it up so the outer
          // catch can short-circuit cleanly; don't log it as a real failure.
          if (err instanceof Error && err.name === 'AbortError') throw err;
          console.warn('Failed to fetch device groups:', err);
          return null;
        })
      ]);

      const deviceList = devicesResult.data;

      // Transform API response to match Device type
      const transformedDevices: Device[] = deviceList.map((d: Record<string, unknown>) => {
        const metrics = asRecord(d.metrics);
        const hardware = asRecord(d.hardware);

        return {
          id: d.id as string,
          hostname: (d.hostname ?? t('devicesPage.unknownDevice')) as string,
          displayName: typeof d.displayName === 'string' ? d.displayName : undefined,
          os: (d.osType ?? d.os ?? 'windows') as OSType,
          osVersion: (d.osVersion ?? '') as string,
          status: (d.status ?? 'offline') as DeviceStatus,
          cpuPercent: toPercent(metrics?.cpuPercent ?? d.cpuPercent ?? hardware?.cpuPercent),
          ramPercent: toPercent(metrics?.ramPercent ?? d.ramPercent ?? hardware?.ramPercent),
          lastSeen: (d.lastSeenAt ?? d.lastSeen ?? '') as string,
          orgId: (d.orgId ?? '') as string,
          orgName: '', // Will be resolved from orgs
          siteId: (d.siteId ?? '') as string,
          siteName: '', // Will be resolved from sites
          agentVersion: (d.agentVersion ?? '') as string,
          watchdogVersion: (d.watchdogVersion ?? null) as string | null,
          agentServerUrl: (d.agentServerUrl ?? null) as string | null,
          // Opt-in WAN/LAN IP columns (#2503). Both are string-or-null on the
          // wire; anything else degrades to null so a malformed value renders
          // the dash instead of leaking through the type.
          wanIp: typeof d.wanIp === 'string' ? d.wanIp : null,
          lanIp: typeof d.lanIp === 'string' ? d.lanIp : null,
          tags: (d.tags ?? []) as string[],
          deviceRole: d.deviceRole as DeviceRole | undefined,
          deviceRoleSource: d.deviceRoleSource as string | undefined,
          mainAgentSilentSince: (d.mainAgentSilentSince ?? null) as string | null,
          watchdogStatus: (d.watchdogStatus ?? null) as Device['watchdogStatus'],
          lastUser: d.lastUser as string | undefined,
          uptimeSeconds: typeof d.uptimeSeconds === 'number' ? d.uptimeSeconds : undefined,
          osBuild: d.osBuild as string | undefined,
          architecture: d.architecture as string | undefined,
          isHeadless: typeof d.isHeadless === 'boolean' ? d.isHeadless : undefined,
          pendingReboot: d.pendingReboot === true,
          // RMM-QA-176: the manual maintenance lease end. This transform is an
          // explicit whitelist, so omitting it would silently make every
          // leased device look "not in maintenance" to isInMaintenance while
          // every other test stayed green.
          maintenanceUntil: typeof d.maintenanceUntil === 'string' ? d.maintenanceUntil : null,
          // Collision enrollment (#2764). A non-null uuid means this row may be
          // replacing an earlier device with the same hostname; the list shows
          // a "Possible duplicate" badge and the device page a review banner.
          // Anything non-string degrades to null so a malformed value can never
          // light the badge.
          possibleReplacementOfDeviceId:
            typeof d.possibleReplacementOfDeviceId === 'string'
              ? d.possibleReplacementOfDeviceId
              : null,
          batteryStatus: (d.batteryStatus as Device['batteryStatus']) ?? null,
          activeVpns: (d.activeVpns as Device['activeVpns']) ?? null,
          // Linked multi-boot profiles (#2138): grouping is computed
          // client-side per page in DeviceList from this id alone.
          linkGroupId: typeof d.linkGroupId === 'string' ? d.linkGroupId : null,
          // vm_host member role (#2308): validated against the known values so
          // an unexpected API value degrades to "ungrouped" instead of leaking
          // (warned once per value — see normalizeLinkGroupRole).
          linkGroupRole: normalizeLinkGroupRole(d.linkGroupRole),
          enrolledAt: d.enrolledAt as string | undefined,
          desktopAccess: (d.desktopAccess as Device['desktopAccess']) ?? null,
          hardware: hardware ? {
            cpuModel: hardware.cpuModel as string | undefined,
            cpuCores: typeof hardware.cpuCores === 'number' ? hardware.cpuCores : undefined,
            ramTotalMb: typeof hardware.ramTotalMb === 'number' ? hardware.ramTotalMb : undefined,
            diskTotalGb: typeof hardware.diskTotalGb === 'number' ? hardware.diskTotalGb : undefined,
          } : undefined,
          // Reliability column (#1720): score is null until the reliability
          // worker has computed one for the device; the column renders a dash
          // and sorts those rows last. Trend is validated against the known
          // enum rather than blind-cast, so an unexpected API value falls back
          // to null (no glyph) instead of leaking through the type.
          reliabilityScore: typeof d.reliabilityScore === 'number' ? d.reliabilityScore : null,
          reliabilityTrend:
            d.reliabilityTrend === 'improving' ||
            d.reliabilityTrend === 'stable' ||
            d.reliabilityTrend === 'degrading'
              ? d.reliabilityTrend
              : null,
          // RDS per-session helper mode (Task 12): validated against the known
          // values so an unexpected API value falls back to null rather than
          // leaking through the type — Tasks 13/14 gate the session picker on
          // this being exactly 'on-demand'.
          helperLifecycleMode:
            d.helperLifecycleMode === 'always-on' || d.helperLifecycleMode === 'on-demand'
              ? d.helperLifecycleMode
              : null,
        };
      });

      // Network arm (#1322): normalize discovered_assets rows into the same
      // Device shape so they render in one list. Agent-only fields stay blank.
      const transformedNetworkDevices: Device[] = networkResult.data.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        deviceClass: (d.deviceClass as DeviceClass) ?? 'network',
        assetType: (d.assetType as DeviceRole | undefined) ?? 'unknown',
        hostname: (d.hostname ?? t('devicesPage.unknownDevice')) as string,
        displayName: typeof d.displayName === 'string' ? d.displayName : undefined,
        // No OS for a network device; the OS column renders "—" for network rows.
        os: '' as OSType,
        osVersion: '',
        status: (d.status ?? 'offline') as DeviceStatus,
        cpuPercent: 0,
        ramPercent: 0,
        lastSeen: (d.lastSeenAt ?? '') as string,
        orgId: (d.orgId ?? '') as string,
        orgName: '',
        siteId: (d.siteId ?? '') as string,
        siteName: '',
        agentVersion: '',
        watchdogVersion: null,
        // A discovered asset never authenticates to the control plane, so it
        // has no WAN address; its discovered `ipAddress` IS its LAN address,
        // which is exactly what the LAN IP column wants (#2503).
        wanIp: null,
        lanIp: typeof d.ipAddress === 'string' ? d.ipAddress : null,
        macAddress: typeof d.macAddress === 'string' ? d.macAddress : null,
        tags: (d.tags ?? []) as string[],
        manufacturer: (d.manufacturer ?? null) as string | null,
        model: (d.model ?? null) as string | null,
        responseTimeMs: typeof d.responseTimeMs === 'number' ? d.responseTimeMs : null,
        monitoringEnabled: d.monitoringEnabled === true,
        enrolledAt: d.enrolledAt as string | undefined,
        // #5213 — provenance (scan | unifi | manual) and the website/service
        // identity. Anything else degrades to null rather than leaking an
        // unexpected API value through the type.
        source:
          d.source === 'scan' || d.source === 'unifi' || d.source === 'manual'
            ? d.source
            : null,
        url: typeof d.url === 'string' ? d.url : null,
      }));

      // Manual arm (#4622 W04): normalize manual_assets rows into the same
      // Device shape. No network identity, no reachability — the API already
      // sends status: 'unknown', never a fabricated 'offline'.
      const transformedManualAssets: Device[] = manualResult.data.map((d: Record<string, unknown>) => ({
        id: d.id as string,
        deviceClass: 'manual' as const,
        assetType: (d.assetType as DeviceRole | undefined) ?? 'unknown',
        hostname: (d.hostname ?? t('devicesPage.unknownDevice')) as string,
        displayName: typeof d.displayName === 'string' ? d.displayName : undefined,
        os: '' as OSType,
        osVersion: '',
        status: (d.status as DeviceStatus | undefined) ?? 'unknown',
        cpuPercent: 0,
        ramPercent: 0,
        lastSeen: (d.lastSeenAt ?? '') as string,
        orgId: (d.orgId ?? '') as string,
        orgName: '',
        siteId: (d.siteId ?? '') as string,
        siteName: '',
        agentVersion: '',
        watchdogVersion: null,
        wanIp: null,
        lanIp: null,
        macAddress: null,
        tags: (d.tags ?? []) as string[],
        manufacturer: (d.manufacturer ?? null) as string | null,
        model: (d.model ?? null) as string | null,
        serialNumber: (d.serialNumber ?? null) as string | null,
        assetTag: (d.assetTag ?? null) as string | null,
        location: (d.location ?? null) as string | null,
        assignedContactId: (d.assignedContactId ?? null) as string | null,
        linkedDeviceId: (d.linkedDeviceId ?? null) as string | null,
        linkedDiscoveredAssetId: (d.linkedDiscoveredAssetId ?? null) as string | null,
        notes: (d.notes ?? null) as string | null,
        monitoringEnabled: false,
        enrolledAt: d.enrolledAt as string | undefined,
      }));

      const allTransformed = [...transformedDevices, ...transformedNetworkDevices, ...transformedManualAssets];

      // Fetch orgs for org name lookup
      let orgsList: Org[] = [];
      if (orgsResponse.ok) {
        const orgsData = await orgsResponse.json();
        orgsList = asList(orgsData, 'orgs');
      } else {
        console.warn('Failed to fetch orgs:', orgsResponse.status);
      }

      // Fetch sites for site name lookup
      let sitesList: Site[] = [];
      if (sitesResponse.ok) {
        const sitesData = await sitesResponse.json();
        sitesList = asList(sitesData, 'sites');
      } else {
        console.warn('Failed to fetch sites:', sitesResponse.status);
      }

      // Create lookup maps
      const orgMap = new Map(orgsList.map((o: Org) => [o.id, o.name]));
      const siteMap = new Map(sitesList.map((s: Site) => [s.id, s.name]));

      // Assign org and site names to devices (agent + network arms).
      const devicesWithNames = allTransformed.map(device => ({
        ...device,
        orgName: orgMap.get(device.orgId) ?? t('devicesPage.unknownOrg'),
        siteName: siteMap.get(device.siteId) ?? t('devicesPage.unknownSite')
      }));

      // Fetch groups for group filter
      let groupsList: DeviceGroup[] = [];
      if (groupsResponse && groupsResponse.ok) {
        const groupsData = await groupsResponse.json();
        groupsList = groupsData.data ?? groupsData.groups ?? [];
      } else if (groupsResponse && !groupsResponse.ok) {
        console.warn('Failed to fetch device groups:', groupsResponse.status);
      }

      // Build group membership map: groupId -> Set<deviceId>
      const memberMap = new Map<string, Set<string>>();
      for (const group of groupsList) {
        if (group.deviceIds) {
          memberMap.set(group.id, new Set(group.deviceIds));
        }
      }

      setDeviceGroups(groupsList);
      setGroupMembershipMap(memberMap);
      setDevices(devicesWithNames);
      setOrgs(orgsList);
      setSites(sitesList);

      // Issue #5285: resolve each visible org's effective agent-version
      // target ONCE per page load (not per device row) so the Agent Version
      // column can colour-code by relation to it. Fired after orgsList is
      // known, in parallel with rendering — best-effort: a failure here only
      // means the column stays uncoloured (plain dash), never blocks the
      // device list itself from rendering.
      const orgIdsForVersions = [...new Set(orgsList.map((o) => o.id))];
      if (orgIdsForVersions.length > 0) {
        fetchWithAuth(`/agent-versions/effective?orgIds=${orgIdsForVersions.join(',')}`, { signal })
          .then(async (res) => {
            if (!res.ok) {
              console.warn('Failed to fetch effective agent versions:', res.status);
              return;
            }
            const body = await res.json();
            const data = body?.data;
            if (data && typeof data === 'object' && !Array.isArray(data)) {
              setEffectiveAgentVersionByOrgId(data);
            }
          })
          .catch((err) => {
            if (err instanceof Error && err.name === 'AbortError') return;
            console.warn('Failed to fetch effective agent versions:', err);
          });
      }
    } catch (err) {
      // Aborts are expected when the component unmounts mid-walk — drop
      // them silently rather than rendering a misleading error banner.
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err);
    } finally {
      // setLoading(false) is harmless after unmount (React 18 ignores
      // setState on unmounted components for hook-based components) but
      // we still skip it when we know the call aborted, to avoid a
      // brief flicker if the component remounts on the same key.
      if (!signal?.aborted) setLoading(false);
    }
  }, [t]);

  /**
   * The post-change refresh — use this, not `fetchDevices`, anywhere something
   * has just altered the fleet (#5023).
   *
   * An advanced filter is resolved SERVER-side into an id set
   * (`serverFilterIds`), and that resolution is keyed on the filter alone, so
   * refreshing the device rows on their own leaves the id set describing the
   * fleet as it was BEFORE the mutation. Restoring a device inside a "Status is
   * Removed" filter is the reported case: the row came back with a stale count
   * and only a full page reload cleared it. The same staleness applies to every
   * mutation that touches a filtered attribute, which is why the pairing lives
   * here once rather than at each call site.
   *
   * The mount effect below deliberately keeps calling `fetchDevices` directly:
   * the hook resolves the filter itself on mount, so going through here would
   * just fire a second, redundant /filters/preview.
   */
  const refreshDevices = useCallback(async () => {
    await fetchDevices();
    refetchAdvancedFilterIds();
  }, [fetchDevices, refetchAdvancedFilterIds]);

  useEffect(() => {
    // Org context not usable for scoping yet (#4147). A request now would go
    // out unscoped: `loading` is the sub-second window before the shell's
    // OrgSwitcher resolves the org list (the page already shows its initial
    // loading state, so nothing is gained by racing it), and `error` renders
    // OrgLoadFailedState instead of a misleading fleet-wide list. Both clear
    // via orgScopeKey, which re-runs this effect.
    if (orgScopeResolving || orgContextFailed) return;
    const controller = new AbortController();
    fetchDevices(controller.signal);
    return () => controller.abort();
  }, [fetchDevices, orgScopeResolving, orgContextFailed, orgScopeKey]);

  const handleGroupCreated = useCallback(async (newGroupId: string) => {
    setShowCreateGroup(false);
    setAutoSelectGroupId(newGroupId);
    await refreshDevices();
  }, [refreshDevices]);

  const handleAutoSelectConsumed = useCallback(() => {
    setAutoSelectGroupId(null);
  }, []);

  // Real-time device status updates
  const handleDeviceEvent = useCallback((event: { type: string; payload: Record<string, unknown> }) => {
    const { type, payload } = event;
    const deviceId = payload.deviceId as string;
    if (!deviceId) return;

    if (type === 'device.online' || type === 'device.offline') {
      setDevices(prev => prev.map(d =>
        d.id === deviceId
          ? { ...d, status: (payload.status as string ?? (type === 'device.online' ? 'online' : 'offline')) as DeviceStatus, lastSeen: new Date().toISOString() }
          : d
      ));
    } else if (type === 'device.updated') {
      const fields = payload.fields as string[] | undefined;
      if (fields?.includes('agentVersion')) {
        setDevices(prev => prev.map(d =>
          d.id === deviceId
            ? { ...d, agentVersion: (payload.agentVersion as string) ?? d.agentVersion }
            : d
        ));
      }
      // NOTE: no live watchdogVersion handler — the heartbeat path only
      // publishes `device.updated` with fields:['agentVersion'], never
      // 'watchdogVersion'. The watchdog version refreshes on the next list
      // fetch / device-detail load. Wire a producer in the watchdog heartbeat
      // branch before adding a consumer here.
    } else if (type === 'device.enrolled' || type === 'device.decommissioned') {
      // #4147 review: useEventStream connects as soon as there is an auth
      // token, independent of org resolution, so an enroll/decommission event
      // can land inside the same pre-resolution window the mount effect holds
      // for. Refetching here would issue the very unscoped request that gate
      // exists to prevent — and could land AFTER the scoped one, leaving the
      // fleet-wide list on screen. Nothing is lost by skipping: the mount
      // effect fetches as soon as the scope resolves.
      if (orgScopeResolving || orgContextFailed) return;
      // An enrol/decommission changes `status`, which is a filterable
      // attribute — refresh the resolved id set with the rows (#5023).
      void refreshDevices();
    }
  }, [refreshDevices, orgScopeResolving, orgContextFailed]);

  const { subscribe } = useEventStream({ onEvent: handleDeviceEvent });

  useEffect(() => {
    subscribe(['device.online', 'device.offline', 'device.updated', 'device.enrolled', 'device.decommissioned']);
  }, [subscribe]);

  // A failed advanced-filter preview (403 on a pinned orgId the caller can't
  // access, 500, network error) must never render as a silently unfiltered
  // list (#4732) — useAdvancedFilterIds already fails CLOSED (empty id set),
  // so both the list and grid view already render zero rows; this toast is
  // what tells the user WHY, since the grid view has no DeviceList toolbar to
  // show the inline pill. Effect fires only on the false→true transition (the
  // hook doesn't flip error back to true while the failing filter is
  // unchanged), so this can't spam repeat toasts on unrelated re-renders.
  useEffect(() => {
    if (!advancedFilterError) return;
    showToast({ type: 'error', message: t('devicesPage.toasts.advancedFilterFailed') });
  }, [advancedFilterError, t]);

  // Mirror the chip-bar filter into the URL hash so the view is shareable.
  // Only active under v2; the legacy bar doesn't expect hash interop.
  useEffect(() => {
    if (!filtersV2) return;
    writeFilterToHash(advancedFilter);
  }, [advancedFilter, filtersV2]);

  const handleSelectDevice = (device: Device) => {
    // A manual asset has no detail page in v1 (#4622 W04 — #1424 owns the
    // full three-class detail-page story); it edits in the same modal it was
    // created from.
    if ((device.deviceClass ?? 'agent') === 'manual') {
      setEditingManualAsset(device);
      return;
    }
    // Network-discovered assets get a native, read-only detail/overview page in
    // the Devices section (#1424 slice 2) instead of bouncing out to Discovery.
    if ((device.deviceClass ?? 'agent') === 'network') {
      void navigateTo(`/devices/network/${device.id}`);
      return;
    }
    void navigateTo(`/devices/${device.id}`);
  };

  const openScriptPicker = (targetDevices: Device[]) => {
    if (targetDevices.length === 0) {
      showToast({ type: 'error', message: t('devicesPage.toasts.selectDeviceForScript') });
      return;
    }
    setScriptTargetDevices(targetDevices);
    setScriptPickerOpen(true);
  };

  const closeScriptPicker = () => {
    setScriptPickerOpen(false);
    setScriptTargetDevices([]);
  };

  const handleScriptSelect = (script: Script, runAs: ScriptRunAsSelection, parameters?: Record<string, unknown>, _targetSessionId?: number) => {
    // Gate script execution behind a scope-naming confirm dialog. Capture the
    // target devices now: ScriptPickerModal calls onClose() right after
    // onSelect(), and closeScriptPicker() resets scriptTargetDevices to [] —
    // so doExecuteScript can't read that state later or it sends an empty
    // deviceIds array (API 400 "Array must contain at least one item").
    setPendingScriptRun({ script, runAs, parameters, devices: scriptTargetDevices });
  };

  const doExecuteScript = async (pending: PendingScriptRun) => {
    if (actionInProgress) return;
    try {
      setActionInProgress(true);
      const { script, runAs, parameters, devices } = pending;
      const deviceIds = devices.map(d => d.id);
      const result = await executeScript(script.id, deviceIds, parameters, runAs);
      const admitted = result.targets.filter(target => target.admission === 'admitted');
      const refused = result.targets.filter(target => target.admission !== 'admitted');

      if (admitted.length === 0) {
        const reasons = [...new Set(refused.map(target => target.reasonCode ?? target.admission))].join(', ');
        showToast({ type: 'error', message: `${t('devicesPage.toasts.scriptQueueFailed')}: ${reasons}` });
        return;
      }

      if (refused.length > 0) {
        const reasons = [...new Set(refused.map(target => target.reasonCode ?? target.admission))].join(', ');
        showToast({
          type: 'warning',
          message: `${admitted.length} of ${result.targets.length} script targets queued; ${refused.length} not admitted (${reasons})`,
        });
      } else if (devices.length === 1) {
        showToast({ type: 'success', message: t('devicesPage.toasts.scriptQueuedOne', { script: script.name, hostname: devices[0].hostname }) });
      } else {
        showToast({ type: 'success', message: t('devicesPage.toasts.scriptQueuedMany', { script: script.name, count: admitted.length }) });
      }

      closeScriptPicker();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.scriptQueueFailed') });
    } finally {
      setActionInProgress(false);
    }
  };

  const handleDeviceAction = async (action: string, device: Device) => {
    if (actionInProgress) return;
    // #4014: every branch of runDeviceAction below addresses an enrolled agent
    // through a `/devices/:id` endpoint, but a network row's `id` is a
    // `discovered_assets.id`, NOT a `devices.id` (#1322) — it matches no device
    // row and 404s. handleBulkAction has filtered these out since #1322.
    //
    // Stated as an invariant rather than as a claim about today's UI: this
    // funnel must refuse network AND manual rows on its own, because nothing
    // guarantees that every present and future caller hides the actions
    // first. #4014 was exactly that failure — DeviceList hid them, DeviceCard
    // did not, and the handler trusted its callers. A guard here cannot be
    // re-opened by adding a third surface — which is precisely what adding
    // the manual class did, so the guard is widened alongside it. A manual
    // asset's `id` is a `manual_assets.id`, same foreign-id problem as
    // network. `delete-manual` is the one manual-eligible action and is
    // carved out explicitly rather than by omission.
    if ((device.deviceClass ?? 'agent') === 'network') {
      showToast({ type: 'error', message: t('devicesPage.toasts.agentOnlyAction') });
      return;
    }
    if ((device.deviceClass ?? 'agent') === 'manual' && action !== 'delete-manual') {
      showToast({ type: 'error', message: t('devicesPage.toasts.agentOnlyActionManual') });
      return;
    }
    if (CONFIRM_REQUIRED_ACTIONS.has(action)) {
      setPendingDeviceAction({ action, device });
      return;
    }
    await runDeviceAction(action, device);
  };

  const runDeviceAction = async (
    action: string,
    device: Device,
    // #3987: the Remove dialog's agent answer. Absent for every other
    // action, and absent means UNINSTALL — the web default, deliberately
    // stricter than the API's back-compat `false`.
    opts?: { uninstallAgent?: boolean },
  ) => {
    if (actionInProgress) return;

    try {
      setActionInProgress(true);

      switch (action) {
        case 'reboot':
        case 'reboot_safe_mode':
        case 'shutdown':
        case 'lock': {
          const result = await sendDeviceCommand(device.id, action);
          const label = action === 'reboot_safe_mode'
            ? t('devicesPage.actions.rebootSafeMode')
            : t(/* i18n-dynamic */ `devicesPage.actions.${action}`, { defaultValue: action.charAt(0).toUpperCase() + action.slice(1) });
          // These commands are QUEUED, and #2630 opened them to non-online
          // devices. A 201 means "a row was inserted", not "the machine acted":
          // there is no dispatch step, and for a disconnected device the agent
          // claims it on its next poll (or staleCommandReaper fails it later).
          // Saying "sent" for that is a false success — the user walks away
          // believing it happened. Name the queue explicitly instead.
          //
          // #5128 W2 — `result.delivery` is the dispatch core's own outcome,
          // not the pre-request device.status snapshot: a device that came
          // online between page load and click is reported correctly either
          // way, where the old status heuristic could be stale.
          //
          // 'queued_live' means the device IS online — the immediate socket
          // push just didn't land (no live session, or preferHeartbeat), so
          // the next heartbeat (seconds away) claims it. That is NOT the
          // "wait for it to reconnect" story `queued_offline` tells; treat it
          // as sent, same as 'delivered', or an online device gets told it's
          // offline.
          showToast({
            type: 'success',
            message: result.delivery !== 'queued_offline'
              ? t('devicesPage.toasts.commandSent', { action: label, hostname: device.hostname })
              : result.deliverBy
                ? t('devicesPage.toasts.runsWhenOnline', { date: formatDateTime(result.deliverBy) })
                : t('devicesPage.toasts.runsWhenOnlineNoExpiry'),
          });
          break;
        }

        case 'wake': {
          try {
            const wake = await sendWakeCommand(device.id);
            const hostname = device.hostname;
            showToast({
              type: 'success',
              message: t('devicesPage.toasts.wakeSentWatching', {
                hostname,
                relay: wake.relay.hostname,
                broadcast: wake.broadcast,
              }),
            });
            const wakeController = new AbortController();
            wakeWatchersRef.current.add(wakeController);
            void watchWakeOutcome(device.id, { signal: wakeController.signal })
              .then(async (outcome) => {
                if (outcome === 'online') {
                  showToast({ type: 'success', message: t('devicesPage.toasts.deviceOnline', { hostname }) });
                  await refreshDevices();
                } else if (outcome === 'timeout') {
                  showToast({
                    type: 'error',
                    message: t('devicesPage.toasts.wakeTimeout', { hostname }),
                  });
                }
                // 'aborted' is silent — user navigated away or page reloaded.
              })
              .finally(() => {
                wakeWatchersRef.current.delete(wakeController);
              });
          } catch (err) {
            if (err instanceof WakeCommandError) {
              const friendly = wakeFriendlyErrorMessage(err.code) ?? err.message;
              showToast({ type: 'error', message: t('devicesPage.toasts.deviceError', { hostname: device.hostname, error: friendly }) });
            } else {
              throw err;
            }
          }
          break;
        }

        case 'refresh': {
          await sendDeviceCommand(device.id, 'refresh_inventory');
          showToast({
            type: 'success',
            message: t('devicesPage.toasts.inventoryRefreshRequested', { hostname: device.hostname }),
          });
          break;
        }

        case 'maintenance':
          // RMM-QA-176 D10: exit is a one-click, un-gated operation; ENTRY
          // needs a reason, a duration and possibly a step-up factor, so it
          // opens MaintenanceModeDialog instead of firing a request here.
          if (!isInMaintenance(device)) {
            setMaintenanceDialogDevices([device]);
            break;
          }
          await exitMaintenanceMode(device.id);
          showToast({
            type: 'success',
            message: t('devicesPage.toasts.maintenanceOff', { hostname: device.hostname }),
          });
          // Refetch rather than assume: exit returns the device to its REAL
          // liveness state, never a blind 'online'.
          await refreshDevices();
          break;

        case 'deploy-software':
          // Carry the device into the deploy wizard via the hash (#2866).
          void navigateTo(`/software#deploy=${device.id}`);
          return;

        case 'terminal':
          void navigateTo(`/remote/terminal/${device.id}`);
          return;

        case 'files':
          void navigateTo(`/remote/files/${device.id}`);
          return;

        case 'run-script':
          openScriptPicker([device]);
          break;

        case 'settings':
          setSettingsDevice(device);
          break;

        case 'decommission': {
          // Deferred execution with undo — gives the user 5 seconds to cancel
          let cancelled = false;
          showToast({
            type: 'undo',
            message: t('devicesPage.toasts.decommissioning', { hostname: device.hostname }),
            duration: 5000,
            onUndo: () => {
              cancelled = true;
              showToast({ type: 'success', message: t('devicesPage.toasts.decommissionCancelled'), duration: 2000 });
            }
          });
          setTimeout(async () => {
            if (cancelled) return;
            try {
              await decommissionDevice(device.id, { uninstallAgent: opts?.uninstallAgent ?? true });
              showToast({ type: 'success', message: t('devicesPage.toasts.decommissioned', { hostname: device.hostname }) });
              await refreshDevices();
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.decommissionFailed', { hostname: device.hostname }) });
            }
          }, 5000);
          break;
        }

        case 'restore':
          await restoreDevice(device.id);
          showToast({ type: 'success', message: t('devicesPage.toasts.restored', { hostname: device.hostname }) });
          await refreshDevices();
          break;

        case 'permanent-delete': {
          // Deferred execution with undo — gives the user 5 seconds to cancel
          let pdCancelled = false;
          showToast({
            type: 'undo',
            message: t('devicesPage.toasts.permanentDeleting', { hostname: device.hostname }),
            duration: 5000,
            onUndo: () => {
              pdCancelled = true;
              showToast({ type: 'success', message: t('devicesPage.toasts.permanentDeleteCancelled'), duration: 2000 });
            }
          });
          setTimeout(async () => {
            if (pdCancelled) return;
            try {
              await permanentDeleteDevice(device.id);
              // No warning branch: the API returns `{ success: true }` and
              // nothing else since #2787 (see permanentDeleteDevice).
              showToast({ type: 'success', message: t('devicesPage.toasts.permanentlyDeleted', { hostname: device.hostname }) });
              await refreshDevices();
            } catch (err) {
              showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.deleteFailed', { hostname: device.hostname }) });
            }
          }, 5000);
          break;
        }

        // Manual asset delete (#4622 W04) — hard delete, no undo (the API's
        // own contract; unlike permanent-delete's device-purge flow, there is
        // no soft-decommission step in between for a manual row). The route
        // carries `requireMfa()` like every manual-asset mutator, so the
        // MFA_REQUIRED 403 gets the same friendly copy other MFA-gated device
        // mutations use (ArchiveOrgModal/MergeOrgModal precedent).
        case 'delete-manual': {
          try {
            await runAction({
              request: () => fetchWithAuth(`/devices/manual/${device.id}`, { method: 'DELETE' }),
              errorFallback: t('devicesPage.toasts.deleteManualFailed', { hostname: device.hostname }),
              friendly: (code) => (code === 'MFA_REQUIRED' ? t('devicesPage.toasts.mfaRequired') : undefined),
              onUnauthorized: handleSessionExpired,
              successMessage: t('devicesPage.toasts.manualDeleted', { hostname: device.hostname }),
            });
            await refreshDevices();
          } catch {
            // runAction already toasted (or handled the 401 redirect).
          }
          break;
        }

        default:
          showToast({ type: 'error', message: t('devicesPage.toasts.unknownAction', { action }) });
      }
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.actionFailed', { action, hostname: device.hostname }) });
    } finally {
      setActionInProgress(false);
    }
  };

  // vm_host (#2308): the picker chose a host — create the group. Mirrors the
  // multiboot bulk path's toast/refetch handling.
  const handleVmHostConfirm = async (hostDeviceId: string) => {
    const targets = vmHostPickerDevices;
    if (!targets || actionInProgress) return;
    try {
      setActionInProgress(true);
      await linkDevicesVmHost(hostDeviceId, targets.map(d => d.id));
      const host = targets.find(d => d.id === hostDeviceId);
      showToast({
        type: 'success',
        message: `Linked ${targets.length - 1} guest VM${targets.length - 1 === 1 ? '' : 's'} under ${host?.displayName || host?.hostname || 'the host server'}.`,
      });
      setVmHostPickerDevices(null);
      await refreshDevices();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to link devices' });
    } finally {
      setActionInProgress(false);
    }
  };

  /**
   * Report the outcome of a maintenance ENTRY (RMM-QA-176 D2/D10).
   *
   * `POST /devices/bulk/maintenance` answers **200 even when every device
   * failed preflight** (not found / site denied / decommissioned / state
   * conflict) — an empty eligible set is a legitimate 200 with an all-`failed`
   * body and the grant left unspent. So `succeeded`/`failed`, never the HTTP
   * status, decides whether this was a success: reporting the resolved promise
   * as success would tell the technician N devices are suppressed when none
   * are, and they would find out from the alert storm.
   */
  const reportMaintenanceEntryOutcome = (targets: Device[], result: unknown) => {
    const hostnameFor = (deviceId: string) =>
      targets.find(d => d.id === deviceId)?.hostname || deviceId;
    const bulk = result as Partial<BulkMaintenanceResponse> | null;
    if (bulk && Array.isArray(bulk.succeeded) && Array.isArray(bulk.failed)) {
      const verb = t('devicesPage.maintenanceVerb.on');
      const failedNames = bulk.failed.map(f => hostnameFor(f.deviceId));
      if (failedNames.length === 0) {
        showToast({
          type: 'success',
          message: t('devicesPage.toasts.bulkMaintenanceSuccess', { count: bulk.succeeded.length, verb }),
        });
      } else if (bulk.succeeded.length === 0) {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkMaintenanceAllFailed', {
            count: failedNames.length,
            devices: summarizeFailedDevices(failedNames),
          }),
        });
      } else {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkMaintenanceSomeFailed', {
            succeeded: bulk.succeeded.length,
            verb,
            failed: failedNames.length,
            devices: summarizeFailedDevices(failedNames),
          }),
        });
      }
      return;
    }
    // Single device: every failure arrived as a REJECTED promise inside the
    // dialog (the single route uses status codes, not a failed[] list), so
    // reaching here means that one device entered maintenance.
    showToast({
      type: 'success',
      message: t('devicesPage.toasts.maintenanceOn', { hostname: targets[0]?.hostname ?? '' }),
    });
  };

  const handleBulkAction = async (action: string, allSelectedDevices: Device[]) => {
    if (actionInProgress || allSelectedDevices.length === 0) return;

    // Manual asset delete (#4622 W04) is the mirror image of every action
    // below: it is MANUAL-only, so it must be handled BEFORE the agent-only
    // allowlist a few lines down strips every manual row out. Skipped
    // (non-manual) rows are reported the same "N of M eligible" way the
    // agent-only actions already do, never silently.
    if (action === 'delete-manual') {
      const manualOnly = allSelectedDevices.filter(d => (d.deviceClass ?? 'agent') === 'manual');
      const skippedCount = allSelectedDevices.length - manualOnly.length;
      if (manualOnly.length === 0) {
        showToast({ type: 'error', message: t('devicesPage.toasts.manualOnlyAction') });
        return;
      }
      if (skippedCount > 0) {
        showToast({ type: 'warning', message: t('devicesPage.toasts.manualSkipped', { count: skippedCount }) });
      }
      setPendingBulkDeleteManual(manualOnly);
      return;
    }

    // Every bulk action below talks to an enrolled agent (reboot/shutdown/lock,
    // maintenance, decommission, wake, run-script, deploy-software). A network
    // row's `id` is a `discovered_assets.id`, NOT a `devices.id` — feeding it
    // into an agent-only endpoint 404s (e.g. PATCH /devices/:id/maintenance),
    // and an unhandled throw mid-loop would silently skip every real device
    // after it. So drop network rows up front for these actions and tell the
    // user, rather than letting them flow into the per-device loops (#1322).
    // Explicit agent-only allowlist (#4622 W04): `=== 'agent'` already drops
    // BOTH network and manual rows correctly (the class union now has three
    // members) — the toast wording below is what needs to stay honest, since
    // "N network devices skipped" would mislabel a skipped manual asset.
    const selectedDevices = allSelectedDevices.filter(d => (d.deviceClass ?? 'agent') === 'agent');
    const skippedManualCount = allSelectedDevices.filter(d => (d.deviceClass ?? 'agent') === 'manual').length;
    const skippedNonAgentCount = allSelectedDevices.length - selectedDevices.length;
    const skippedNetworkCount = skippedNonAgentCount - skippedManualCount;
    if (selectedDevices.length === 0) {
      showToast({
        type: 'error',
        message: t('devicesPage.toasts.agentOnlyAction'),
      });
      return;
    }
    if (skippedNonAgentCount > 0) {
      showToast({
        type: 'warning',
        message: skippedManualCount > 0
          ? t('devicesPage.toasts.nonAgentSkipped', { count: skippedNonAgentCount })
          : t('devicesPage.toasts.networkSkipped', { count: skippedNetworkCount }),
      });
    }

    // Compare is navigation, not an agent command — nothing queues, so the
    // decommissioned gate below doesn't apply (comparing a decommissioned
    // device's last-known data is legitimate). The menu gates on a 2-4
    // selection, but that invariant isn't enforced here: the network-row
    // filter above can shrink the set below 2 (a 1-device "comparison" is
    // useless — refuse it with an explanation), and the slice caps at
    // DeviceCompare's 4-device limit rather than trusting the caller.
    if (action === 'compare') {
      if (selectedDevices.length < 2) {
        showToast({ type: 'error', message: t('devicesPage.toasts.compareNeedsTwo') });
        return;
      }
      const ids = selectedDevices.slice(0, 4).map(d => d.id);
      void navigateTo(`/devices/compare?ids=${ids.join(',')}`);
      return;
    }

    // Decommissioned gate (#2465). For the agent-command actions in this Set,
    // commands are QUEUED, not delivered live: the API refuses exactly one
    // status — `decommissioned` — and any other device (offline included) has
    // its command stored `pending` and run on its next check-in. So gate on
    // `decommissioned` ONLY. Filtering to `status === 'online'` here would look
    // like the obvious fix and would in fact discard commands the backend
    // would have honoured — see the verified API contract in
    // bulkActionGating.ts before "tightening" this.
    //
    // `decommission` (bulk Remove) is ALSO in this Set, but not for a queued-
    // command reason — it dispatches an immediate `DELETE`, not an agent
    // command. It is gated here to skip devices that are already removed, so
    // they don't 400 the batch. See the full explanation on
    // DECOMMISSION_BLOCKED_BULK_ACTIONS in bulkActionGating.ts.
    //
    // Decommissioned rows are hidden by default, but a status filter that
    // includes them (or the #2251 "show" hint) puts them back in reach of a
    // select-all, which is how they land in a mixed batch.
    if (DECOMMISSION_BLOCKED_BULK_ACTIONS.has(action)) {
      const eligibleDevices = selectedDevices.filter(d => isCommandQueueable(d.status));
      const skippedDecommissionedCount = selectedDevices.length - eligibleDevices.length;

      if (eligibleDevices.length === 0) {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkAllDecommissioned', { total: selectedDevices.length }),
        });
        return;
      }
      if (skippedDecommissionedCount > 0) {
        setPendingDecommissionedSkip({
          action,
          devices: eligibleDevices,
          skippedCount: skippedDecommissionedCount,
          totalCount: selectedDevices.length,
        });
        return;
      }
    }

    await runBulkAction(action, selectedDevices);
  };

  // Executes a bulk action against an already-vetted device set (network rows
  // dropped, decommissioned targets filtered + confirmed). Offline devices are
  // deliberately still IN this set: for the queued agent-command actions, an
  // offline device's command queues and runs on reconnect; for bulk Remove
  // (`decommission`), an offline device is removed immediately (`DELETE`, not
  // a queued command) — see DECOMMISSION_BLOCKED_BULK_ACTIONS in
  // bulkActionGating.ts. Entered either directly from handleBulkAction
  // (nothing to skip) or from the decommissioned-skip confirm.
  const runBulkAction = async (action: string, selectedDevices: Device[]) => {
    if (actionInProgress || selectedDevices.length === 0) return;

    const deviceIds = selectedDevices.map(d => d.id);
    const deviceCount = selectedDevices.length;

    if (action === 'run-script') {
      openScriptPicker(selectedDevices);
      return;
    }

    if (action === 'deploy-software') {
      // Carry the bulk selection into the deploy wizard via the hash (#2866);
      // SoftwareCatalog consumes #deploy=<id>,... and opens the wizard with
      // those devices pre-selected. Cap at 200 ids for URL-length safety —
      // 200 UUIDs is ~7.4 KB, close to common ~8 KB URL limits.
      let deployIds = deviceIds;
      if (deployIds.length > 200) {
        console.warn(
          `deploy-software: truncating selection from ${deployIds.length} to 200 devices (URL-length safety)`,
        );
        deployIds = deployIds.slice(0, 200);
      }
      void navigateTo(`/software#deploy=${deployIds.join(',')}`);
      return;
    }

    // vm_host (#2308): needs a host decision first — open the picker modal;
    // the POST happens in handleVmHostConfirm once a host is chosen.
    if (action === 'link-vm-host') {
      if (deviceIds.length < 2) {
        showToast({ type: 'error', message: 'Select at least two devices — one host server and its guest VMs.' });
        return;
      }
      setVmHostPickerDevices(selectedDevices);
      return;
    }

    try {
      setActionInProgress(true);

      switch (action) {
        case 'link-multiboot': {
          if (deviceIds.length < 2) {
            showToast({ type: 'error', message: t('devicesPage.toasts.selectTwoForMultiboot') });
            break;
          }
          await linkDevicesMultiboot(deviceIds);
          showToast({
            type: 'success',
            message: t('devicesPage.toasts.multibootLinked', { count: deviceCount }),
          });
          await refreshDevices();
          break;
        }

        case 'reboot':
        case 'reboot_safe_mode':
        case 'shutdown':
        case 'lock': {
          const result = await sendBulkCommand(deviceIds, action);
          const successCount = result.commands?.length ?? 0;
          const failedCount = result.failed?.length ?? 0;
          const skippedCount = result.skipped?.length ?? 0;
          // #5128 W2 — queuedOffline is a subset of `commands`: those devices
          // were offline, so the command was persisted but not delivered yet.
          const queuedCount = result.queuedOffline?.length ?? 0;
          const bulkLabel = action === 'reboot_safe_mode'
            ? t('devicesPage.actions.rebootSafeMode')
            : t(/* i18n-dynamic */ `devicesPage.actions.${action}`, { defaultValue: action.charAt(0).toUpperCase() + action.slice(1) });
          const skippedTail = skippedCount > 0 ? t('devicesPage.toasts.alreadyPendingTail', { count: skippedCount }) : '';
          const queuedTail = queuedCount > 0 ? t('devicesPage.toasts.queuedOfflineTail', { count: queuedCount }) : '';

          if (failedCount === 0) {
            showToast({
              type: 'success',
              message: t('devicesPage.toasts.bulkCommandSent', { action: bulkLabel, count: successCount, queuedTail, skippedTail }),
            });
          } else {
            const failureSummary = summarizeBulkCommandFailures(result.failed ?? []);
            showToast({
              type: 'error',
              message: t('devicesPage.toasts.bulkCommandPartialFailed', {
                action: bulkLabel,
                count: successCount,
                queuedTail,
                skippedTail,
                failed: failedCount,
                failureSummary,
              }),
            });
          }
          break;
        }

        // RMM-QA-176 D2/D10: the two halves are no longer symmetric, so they
        // no longer share a case. ENTRY is ONE server-side call under ONE
        // step-up grant (POST /devices/bulk/maintenance) — the old N-single-
        // calls loop would demand N grants and 403 on every one of them, and
        // it had no way to collect the now-required reason. EXIT is un-gated
        // and stays a loop, because there is no bulk exit route (ending
        // suppression needs no batching).
        case 'maintenance-on': {
          setMaintenanceDialogDevices(selectedDevices);
          break;
        }

        case 'maintenance-off': {
          const mLabel = t('devicesPage.progress.disablingMaintenance');
          setBulkProgress({ current: 0, total: deviceCount, label: mLabel });
          let mDone = 0;
          const mFailed: string[] = [];
          // Per-device try/catch: one device 404'ing/erroring must NOT abort
          // the batch and silently skip every device after it. Collect the
          // failures and report them in a single summary toast (#1322).
          for (const device of selectedDevices) {
            try {
              await exitMaintenanceMode(device.id);
            } catch {
              mFailed.push(device.hostname || device.id);
            }
            mDone++;
            setBulkProgress({ current: mDone, total: deviceCount, label: mLabel });
          }
          setBulkProgress(null);
          const mSucceeded = deviceCount - mFailed.length;
          const mVerb = t('devicesPage.maintenanceVerb.off');
          if (mFailed.length === 0) {
            showToast({ type: 'success', message: t('devicesPage.toasts.bulkMaintenanceSuccess', { count: mSucceeded, verb: mVerb }) });
          } else if (mSucceeded === 0) {
            showToast({ type: 'error', message: t('devicesPage.toasts.bulkMaintenanceAllFailed', { count: mFailed.length, devices: summarizeFailedDevices(mFailed) }) });
          } else {
            showToast({ type: 'error', message: t('devicesPage.toasts.bulkMaintenanceSomeFailed', { succeeded: mSucceeded, verb: mVerb, failed: mFailed.length, devices: summarizeFailedDevices(mFailed) }) });
          }
          await refreshDevices();
          break;
        }

        case 'decommission': {
          // Ask the agent question once for the whole selection (#3987). The
          // actual DELETE loop runs in runBulkRemove once the dialog confirms.
          // `return` inside `try` still runs the `finally` that clears
          // actionInProgress, so the dialog's own Confirm is not dead on arrival.
          setPendingBulkRemove(selectedDevices);
          return;
        }

        case 'restore': {
          // #2787. Synchronous: the API returns the final per-device outcome,
          // so there is nothing to poll. Emitted by the bulk bar ONLY for an
          // all-removed selection (REMOVED_ONLY_BULK_ACTIONS).
          const result = await bulkRestoreDevices(deviceIds);
          const dispatched = result.succeeded.filter(r => r.uninstallAlreadyDispatched).length;
          if (result.failed.length === 0) {
            showToast({ type: 'success', message: t('devicesPage.toasts.bulkRestored', { count: result.succeeded.length }) });
          } else if (result.succeeded.length === 0) {
            showToast({ type: 'error', message: t('devicesPage.toasts.bulkRestoreAllFailed', { count: result.failed.length }) });
          } else {
            showToast({ type: 'error', message: t('devicesPage.toasts.bulkRestoreSomeFailed', { succeeded: result.succeeded.length, failed: result.failed.length }) });
          }
          // A SEPARATE toast, deliberately: the device row came back, but those
          // machines had already been handed the uninstall and may be gone.
          // Folding it into the success line would let it read as "all fine".
          if (dispatched > 0) {
            showToast({ type: 'warning', message: t('devicesPage.toasts.bulkRestoreUninstallAlreadySent', { count: dispatched }) });
          }
          await refreshDevices();
          break;
        }

        case 'permanent-delete': {
          // Confirm first — this is the only irreversible bulk action, and the
          // dialog makes the operator type the count. runBulkPurge starts the
          // job. Prune to rows still present in the current fetch: the
          // selection persists across filter changes, so a stale id would be
          // rejected by the API and counted against the typed total.
          const present = new Set(devices.map(d => d.id));
          setPendingBulkPurge(selectedDevices.filter(d => present.has(d.id)));
          return;
        }

        case 'wake': {
          // One round-trip; server iterates per-device with relay-pick per LAN
          // and returns per-device outcome. We render one summary toast
          // grouped by failure code so a 50-device bulk doesn't spam 50
          // toasts.
          const summary = await sendBulkWakeCommand(deviceIds);
          const failureSummary = summarizeBulkWakeFailures(summary.failed);
          if (summary.failed.length === 0) {
            showToast({
              type: 'success',
              message: t('devicesPage.toasts.bulkWakeSent', { count: summary.succeeded.length }),
            });
          } else if (summary.succeeded.length === 0) {
            showToast({
              type: 'error',
              message: t('devicesPage.toasts.bulkWakeAllFailed', { count: summary.failed.length, failureSummary }),
            });
          } else {
            showToast({
              type: 'error',
              message: t('devicesPage.toasts.bulkWakeSomeFailed', {
                succeeded: summary.succeeded.length,
                total: summary.succeeded.length + summary.failed.length,
                failed: summary.failed.length,
                failureSummary,
              }),
            });
          }
          break;
        }

        default:
          showToast({ type: 'error', message: t('devicesPage.toasts.unknownBulkAction', { action }) });
      }
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.bulkActionFailed', { action }) });
    } finally {
      setActionInProgress(false);
    }
  };

  // -------------------------------------------------------------------------
  // #2787: the second half of bulk Delete permanently.
  //
  // The API returns 202 the moment the job is queued, so the only way the
  // operator learns the outcome is this poll. It is deliberately shaped like
  // MergeOrgModal's: a token ref invalidates a superseded chain so a tick
  // already in flight cannot land its result over a newer run's (or after
  // unmount), and every terminal state stops the chain explicitly rather than
  // relying on the next tick not being scheduled.
  // -------------------------------------------------------------------------
  const stopPurgePolling = useCallback(() => {
    if (purgePollTimeoutRef.current !== null) {
      clearTimeout(purgePollTimeoutRef.current);
      purgePollTimeoutRef.current = null;
    }
    purgePollTokenRef.current += 1;
  }, []);

  useEffect(() => stopPurgePolling, [stopPurgePolling]);

  const pollPurgeRun = useCallback(
    async (jobId: string, token: number) => {
      const scheduleNextTick = () => {
        if (purgePollTokenRef.current !== token) return; // superseded meanwhile
        purgePollTimeoutRef.current = setTimeout(
          () => void pollPurgeRun(jobId, token),
          PURGE_POLL_INTERVAL_MS,
        );
      };

      let run: Awaited<ReturnType<typeof fetchPurgeRun>>;
      try {
        run = await fetchPurgeRun(jobId);
      } catch {
        // A transient blip is not a failed purge — the job is running in the
        // worker either way. Retry on the next tick.
        scheduleNextTick();
        return;
      }
      if (purgePollTokenRef.current !== token) return; // stale — drop silently

      if (run.state === 'completed') {
        stopPurgePolling();
        const purged = run.result?.purged.length ?? 0;
        const skipped = run.result?.skipped ?? [];
        if (skipped.length === 0) {
          showToast({ type: 'success', message: t('devicesPage.toasts.bulkPurgeDone', { count: purged }) });
        } else {
          // Group by refusal code: a 50-device run with 40 UNINSTALL_PENDING
          // must not become 40 toasts, and a bare count would hide WHY.
          const byCode: Record<string, number> = {};
          for (const s of skipped) byCode[s.code] = (byCode[s.code] ?? 0) + 1;
          const reasons = Object.entries(byCode).map(([code, n]) => `${n} ${code}`).join('; ');
          showToast({
            type: 'warning',
            message: purged === 0
              ? t('devicesPage.toasts.bulkPurgeNoneDeleted', { reasons })
              : t('devicesPage.toasts.bulkPurgeDoneWithSkips', { purged, skipped: skipped.length, reasons }),
          });
        }
        await refreshDevices();
        return;
      }

      if (run.state === 'failed') {
        stopPurgePolling();
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkPurgeFailed', {
            reason: run.failedReason ?? t('devicesPage.toasts.bulkActionFailed', { action: 'permanent-delete' }),
          }),
        });
        // The job may have deleted some devices before failing, so the list is
        // stale either way.
        await refreshDevices();
        return;
      }

      scheduleNextTick(); // 'waiting' | 'active' | 'delayed'
    },
    [refreshDevices, stopPurgePolling, t],
  );

  const runBulkPurge = async (targets: Device[]) => {
    if (targets.length === 0) return;
    setActionInProgress(true);
    try {
      const started = await startBulkPurge(targets.map(d => d.id));
      showToast({ type: 'success', message: t('devicesPage.toasts.bulkPurgeStarted', { count: started.accepted }) });
      if (started.rejected.length > 0) {
        // A partial rejection is NOT an error — the accepted devices are being
        // deleted. Say which ones were left out and why, or they silently
        // survive a delete the operator believes they ordered.
        const byCode: Record<string, number> = {};
        for (const r of started.rejected) byCode[r.code] = (byCode[r.code] ?? 0) + 1;
        const reasons = Object.entries(byCode).map(([code, n]) => `${n} ${code}`).join('; ');
        showToast({ type: 'warning', message: t('devicesPage.toasts.bulkPurgeDoneWithSkips', { purged: started.accepted, skipped: started.rejected.length, reasons }) });
      }
      stopPurgePolling(); // drop anything from a previous run
      const token = purgePollTokenRef.current;
      purgePollTimeoutRef.current = setTimeout(
        () => void pollPurgeRun(started.jobId, token),
        PURGE_POLL_INTERVAL_MS,
      );
    } catch (err) {
      showToast({
        type: 'error',
        message: err instanceof Error ? err.message : t('devicesPage.toasts.bulkActionFailed', { action: 'permanent-delete' }),
      });
    } finally {
      setActionInProgress(false);
    }
  };

  // #3987: the second half of bulk Remove. runBulkAction's `decommission` case
  // only opens RemoveDeviceDialog; this runs once the operator has answered the
  // agent question, with the SAME answer applied to every device in the batch.
  const runBulkRemove = async (selectedDevices: Device[], choice: { uninstallAgent: boolean }) => {
    if (selectedDevices.length === 0) return;
    setActionInProgress(true);
    try {
      const result = await bulkDecommissionDevices(
        selectedDevices.map(d => ({ id: d.id, hostname: d.hostname })),
        choice,
      );
      if (result.failed.length === 0) {
        showToast({ type: 'success', message: t('devicesPage.toasts.bulkDecommissioned', { count: result.succeeded }) });
      } else if (result.succeeded === 0) {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkDecommissionAllFailed', {
            count: result.failed.length,
            devices: summarizeFailedDevices(result.failed.map(f => f.hostname)),
          }),
        });
      } else {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkDecommissionFailed', {
            succeeded: result.succeeded,
            failed: result.failed.length,
            devices: summarizeFailedDevices(result.failed.map(f => f.hostname)),
          }),
        });
      }
      await refreshDevices();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.bulkActionFailed', { action: 'decommission' }) });
    } finally {
      setActionInProgress(false);
    }
  };

  // Manual asset bulk delete (#4622 W04). No bulk API route exists for this —
  // a per-item DELETE loop, same shape as maintenance-off above: one item's
  // failure must not abort the batch or silently skip everything after it.
  // Each mutator carries requireMfa(), so a session missing MFA fails every
  // item with the same MFA_REQUIRED code — collected once into its own
  // friendly toast rather than repeated per-device.
  const runBulkDeleteManual = async (selectedDevices: Device[]) => {
    if (selectedDevices.length === 0) return;
    setActionInProgress(true);
    let mfaBlocked = false;
    const failed: string[] = [];
    try {
      for (const device of selectedDevices) {
        try {
          const resp = await fetchWithAuth(`/devices/manual/${device.id}`, { method: 'DELETE' });
          if (resp.status === 401) {
            handleSessionExpired();
            return;
          }
          if (!resp.ok) {
            const body = await resp.json().catch(() => null);
            if (resp.status === 403 && body && (body as { code?: string }).code === 'MFA_REQUIRED') {
              mfaBlocked = true;
            }
            failed.push(device.hostname || device.id);
          }
        } catch (err) {
          // Logged (not silent) — MFA detection above only inspects the
          // response shape, so a network failure or a non-JSON error body
          // would otherwise be invisible beyond "one of N failed".
          console.warn(`[DevicesPage] delete-manual failed for ${device.id}:`, err);
          failed.push(device.hostname || device.id);
        }
      }
      const succeeded = selectedDevices.length - failed.length;
      if (mfaBlocked) {
        showToast({ type: 'error', message: t('devicesPage.toasts.mfaRequired') });
      } else if (failed.length === 0) {
        showToast({ type: 'success', message: t('devicesPage.toasts.bulkManualDeleted', { count: succeeded }) });
      } else if (succeeded === 0) {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkManualDeleteAllFailed', { count: failed.length, devices: summarizeFailedDevices(failed) }),
        });
      } else {
        showToast({
          type: 'error',
          message: t('devicesPage.toasts.bulkManualDeleteSomeFailed', { succeeded, failed: failed.length, devices: summarizeFailedDevices(failed) }),
        });
      }
      await refreshDevices();
    } catch (err) {
      // Mirrors runBulkAction/runBulkPurge/runBulkRemove above: anything that
      // throws AFTER the per-item loop (t(), summarizeFailedDevices(),
      // refreshDevices()) must still surface a toast, or a hard, no-undo
      // delete of several assets reports nothing at all to the operator.
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('devicesPage.toasts.bulkActionFailed', { action: 'delete-manual' }) });
    } finally {
      setActionInProgress(false);
    }
  };

  // The org context itself failed to load (#4147 review). Falling through would
  // fetch with no orgId, and the API reads an absent orgId as "every accessible
  // org" — so a transient /orgs/organizations failure would quietly render a
  // cross-tenant device list indistinguishable from a real org-scoped one
  // (ContextScopeLine deliberately does NOT let the error state read as fleet
  // view, so nothing on screen would say otherwise). Surface it instead, via
  // the shared state whose Retry re-runs the org resolution — which doubles as
  // the escape hatch when the context is stuck. Same treatment as DiscoveryPage
  // and MonitoringAssetsDashboard. Only reachable when there is NO selection at
  // all: deriveOrgScope gives a concrete currentOrgId precedence over a later
  // refetch failure, so a warm session keeps working.
  // #5265: AddNetworkAssetModal's post-create hand-off panel
  // (data-testid="asset-post-create") lets a tech add an HTTP check right
  // after creating the asset. onCreated fires refreshDevices(), which flips
  // `loading` back to true — and every branch below is a SEPARATE `return`,
  // so if the modal were only rendered inside the final (non-loading) branch,
  // that `loading` flip would unmount it along with everything else,
  // resetting AddNetworkAssetModal's internal `createdAsset` state to null
  // and losing the hand-off panel the tech was just shown. Hoisting the modal
  // into a Fragment that wraps EVERY branch — always at the same child
  // position — keeps it mounted across the refresh; only the second child
  // (skeleton / error / real content) swaps out underneath it. Covered by
  // DevicesPage.postCreateHandoff.test.tsx ("keeps the network-asset modal mounted...").
  const addNetworkAssetModal = (
    <AddNetworkAssetModal
      isOpen={showAddNetworkAsset}
      onClose={() => {
        window.location.hash = '';
        setShowAddNetworkAsset(false);
      }}
      onCreated={() => { void refreshDevices(); }}
    />
  );

  if (orgContextFailed) {
    return (
      <>
        {addNetworkAssetModal}
        <OrgLoadFailedState error={orgScope.error} />
      </>
    );
  }

  if (loading) {
    return (
      <>
        {addNetworkAssetModal}
        <div className="space-y-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="h-6 w-32 rounded bg-muted animate-pulse mb-2" />
              <div className="h-4 w-48 rounded bg-muted animate-pulse" />
            </div>
            <div className="flex items-center gap-3">
              <div className="h-10 w-20 rounded-md bg-muted animate-pulse" />
              <div className="h-10 w-28 rounded-md bg-muted animate-pulse" />
            </div>
          </div>
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between mb-6">
              <div className="h-5 w-20 rounded bg-muted animate-pulse" />
              <div className="h-10 w-56 rounded-md bg-muted animate-pulse" />
            </div>
            <div className="space-y-0 divide-y">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex items-center gap-4 py-3">
                  <div className="h-4 w-4 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-40 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-20 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-16 rounded bg-muted animate-pulse" />
                  <div className="hidden md:block h-4 w-16 rounded bg-muted animate-pulse" />
                  <div className="hidden md:block h-4 w-16 rounded bg-muted animate-pulse" />
                  <div className="h-4 w-20 rounded bg-muted animate-pulse" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  }

  // A 403 is a permission denial, not a transient load failure — render the
  // access-denied state (no misleading "session expired / try again" UI).
  if (error && isAccessDenied(error)) {
    return (
      <>
        {addNetworkAssetModal}
        <AccessDenied message={t('devicesPage.accessDenied')} />
      </>
    );
  }

  if (error) {
    return (
      <>
        {addNetworkAssetModal}
        <div className="rounded-lg border bg-card p-6">
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="rounded-full bg-destructive/10 p-3 mb-3">
              <AlertCircle className="h-5 w-5 text-destructive" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">{getErrorTitle(error)}</p>
            <p className="text-xs text-muted-foreground mb-3">{getErrorMessage(error)}</p>
            <button
              type="button"
              onClick={() => void refreshDevices()}
              className="text-xs font-medium text-primary hover:underline"
            >
              {t('devicesPage.tryAgain')}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {addNetworkAssetModal}
      <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 data-testid="devices-heading" className="text-xl font-semibold tracking-tight">{t('devicesPage.title')}</h1>
          <p className="text-muted-foreground">
            {t('devicesPage.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`flex h-10 w-10 items-center justify-center rounded-l-md transition ${
                viewMode === 'list' ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              title={t('devicesPage.listView')}
              aria-label={t('devicesPage.listView')}
            >
              <List className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`flex h-10 w-10 items-center justify-center rounded-r-md transition ${
                viewMode === 'grid' ? 'bg-muted' : 'hover:bg-muted/50'
              }`}
              title={t('devicesPage.gridView')}
              aria-label={t('devicesPage.gridView')}
            >
              <Grid className="h-4 w-4" />
            </button>
          </div>
          <button
            type="button"
            data-testid="devices-page-import-rmm"
            onClick={() => {
              window.location.hash = 'import-definitions';
              setShowRmmImport(true);
            }}
            className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {t('devicesPage.importFromRmm')}
          </button>
          <AddAssetMenu
            variant="primary"
            testIdPrefix="devices-page-add-menu"
            onInstallAgent={() => setShowAddDevice(true)}
            onAddManualAsset={() => setShowAddManualAsset(true)}
            onAddNetworkAsset={() => {
              window.location.hash = 'add-network-asset';
              setShowAddNetworkAsset(true);
            }}
          />
        </div>
      </div>

      {filtersV2 ? (
        <DeviceFilterToolbar
          value={advancedFilter}
          onChange={setAdvancedFilter}
          listFilters={listFilters}
          onListFiltersChange={setListFilters}
          orgs={orgs}
          sites={sites}
          groups={deviceGroups}
          softwareOptions={softwareOptions}
          onSoftwareSearch={handleSoftwareSearch}
          onCreateGroup={() => setShowCreateGroup(true)}
        />
      ) : (
        <DeviceFilterBar
          value={advancedFilter}
          onChange={setAdvancedFilter}
          showSavedFilters={true}
          collapsible={true}
        />
      )}

      {/* Class segment (#1424, #4622) — only meaningful when the merged list
          carries more than the agent arm; hidden entirely in the pure
          agent-only view. The manual arm carries NO feature flag (independent
          of ENABLE_NETWORK_DEVICES_IN_LIST by design), so this must show
          whenever EITHER the network flag is on OR a manual asset exists —
          gating on the network flag alone would hide the Manual segment (and
          its count) on an org that has manual assets but the network arm off.
          Narrows both views: the table via classFilteredDevices, the grid via
          gridDevices (same class rule over the filtered fleet). */}
      {(ENABLE_NETWORK_DEVICES_IN_LIST || deviceClassCounts.manual > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <DeviceClassSegment
            value={deviceClassFilter}
            counts={deviceClassCounts}
            onChange={handleDeviceClassChange}
          />
          {hiddenNetwork.count > 0 && (
            <p role="status" data-testid="hidden-network-notice" className="text-sm text-muted-foreground">
              {t('devicesPage.hiddenNonAgentNotice', {
                count: hiddenNetwork.count,
                class: hiddenNonAgentClassLabel,
                fields: hiddenNetworkFieldLabels,
              })}
            </p>
          )}
        </div>
      )}

      {bulkProgress && (
        <div className="rounded-md border bg-muted/20 px-4 py-3">
          <ProgressBar
            current={bulkProgress.current}
            total={bulkProgress.total}
            label={bulkProgress.label}
          />
        </div>
      )}

      {devices.length === 0 ? (
        <div className="rounded-lg border bg-card p-8">
          <div className="max-w-lg">
            <h2 className="text-lg font-semibold text-foreground mb-2">{t('devicesPage.emptyTitle')}</h2>
            <p className="text-sm text-muted-foreground mb-6">
              {t('devicesPage.emptyDescription')}
            </p>
            <div className="flex gap-3">
              <AddAssetMenu
                variant="primary"
                testIdPrefix="devices-page-empty-add-menu"
                onInstallAgent={() => setShowAddDevice(true)}
                onAddManualAsset={() => setShowAddManualAsset(true)}
                onAddNetworkAsset={() => {
                  window.location.hash = 'add-network-asset';
                  setShowAddNetworkAsset(true);
                }}
              />
              <a href="https://docs.breezermm.com/agents/installation/" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                {t('devicesPage.viewInstallationGuide')}
              </a>
            </div>
          </div>
        </div>
      ) : viewMode === 'list' ? (
        <DeviceList
          devices={classFilteredDevices}
          orgs={orgs}
          sites={sites}
          groups={deviceGroups}
          groupMembershipMap={groupMembershipMap}
          onSelect={handleSelectDevice}
          onAction={handleDeviceAction}
          onBulkAction={handleBulkAction}
          serverFilterIds={advancedFilterIds}
          advancedFilter={advancedFilter}
          serverFilterLoading={advancedFilterLoading}
          serverFilterError={advancedFilterError}
          includeDecommissioned={includeDecommissioned}
          onShowDecommissioned={handleShowDecommissioned}
          onHideDecommissioned={onHideDecommissioned}
          listFilters={listFilters}
          onListFiltersChange={setListFilters}
          onCreateGroup={() => setShowCreateGroup(true)}
          autoSelectGroupId={autoSelectGroupId}
          onAutoSelectConsumed={handleAutoSelectConsumed}
          networkDevicesEnabled={ENABLE_NETWORK_DEVICES_IN_LIST}
          effectiveAgentVersionByOrgId={effectiveAgentVersionByOrgId}
        />
      ) : (
        <div className="space-y-3">
          {/* Grid view has no filter toolbar to host DeviceList's inline
              pill, and the toast fired above is transient (auto-dismisses)
              and one-shot (only fires on the false→true transition) — a user
              who missed it, or who switched into grid view after the error
              already landed, would otherwise see an unexplained empty grid.
              This persistent banner is grid view's equivalent of DeviceList's
              `device-filter-error` pill (#4732). */}
          {advancedFilterError && (
            <div
              className="flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive w-fit"
              data-testid="device-filter-error-grid"
              role="alert"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              {t('devicesPage.toasts.advancedFilterFailed')}
            </div>
          )}
          {hiddenDecommissionedCount > 0 && (
            <p>
              <DecommissionedHiddenHint
                count={hiddenDecommissionedCount}
                onShow={handleShowDecommissioned}
              />
            </p>
          )}
          {onHideDecommissioned && shownDecommissionedCount > 0 && (
            <p>
              <DecommissionedHiddenHint
                mode="shown"
                count={shownDecommissionedCount}
                onHide={onHideDecommissioned}
              />
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {gridDevices.map(device => (
              <DeviceCard
                key={device.id}
                device={device}
                onClick={handleSelectDevice}
                onAction={handleDeviceAction}
              />
            ))}
          </div>
        </div>
      )}

      <AddDeviceModal isOpen={showAddDevice} onClose={() => setShowAddDevice(false)} />

      <ManualAssetModal
        isOpen={showAddManualAsset || editingManualAsset != null}
        onClose={() => {
          setShowAddManualAsset(false);
          setEditingManualAsset(null);
          if (window.location.hash === '#add-manual-asset') window.location.hash = '';
        }}
        onSaved={refreshDevices}
        organizationId={orgScope.status === 'resolved' && orgScope.scope !== 'all' ? orgScope.orgId : null}
        orgs={orgs}
        sites={sites}
        existing={editingManualAsset}
        linkableDevices={devices.filter((d) => (d.deviceClass ?? 'agent') !== 'manual')}
      />

      {showRmmImport && (
        <RmmCustomFieldImport
          organizationId={orgScope.status === 'resolved' && orgScope.scope !== 'all' ? orgScope.orgId : null}
          onClose={() => {
            window.location.hash = '';
            setShowRmmImport(false);
          }}
        />
      )}

      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
        onCreated={handleGroupCreated}
      />

      {vmHostPickerDevices && (
        <LinkVmHostModal
          isOpen={true}
          devices={vmHostPickerDevices}
          busy={actionInProgress}
          onConfirm={hostId => void handleVmHostConfirm(hostId)}
          onClose={() => setVmHostPickerDevices(null)}
        />
      )}

      {maintenanceDialogDevices && (
        <MaintenanceModeDialog
          open={true}
          devices={maintenanceDialogDevices.map(d => ({ id: d.id, hostname: d.hostname }))}
          onClose={() => setMaintenanceDialogDevices(null)}
          onCompleted={result => {
            reportMaintenanceEntryOutcome(maintenanceDialogDevices, result);
            void fetchDevices();
          }}
        />
      )}

      <ScriptPickerModal
        isOpen={scriptPickerOpen}
        onClose={closeScriptPicker}
        onSelect={handleScriptSelect}
        deviceHostname={scriptTargetLabel}
        deviceOs={scriptTargetOs}
      />

      {pendingScriptRun && (() => {
        const distinctOrgIds = [...new Set(pendingScriptRun.devices.map(d => d.orgId).filter(Boolean))];
        const scriptOrgNames = distinctOrgIds.length > 0
          ? distinctOrgIds.map(id => orgStoreOrgs.find(o => o.id === id)?.name ?? id)
          : [t('devicesPage.selectedOrganization')];
        return (
          <ConfirmDialog
            open={true}
            onClose={() => setPendingScriptRun(null)}
            onConfirm={() => {
              const p = pendingScriptRun;
              setPendingScriptRun(null);
              void doExecuteScript(p);
            }}
            title={t('devicesPage.confirmScriptRun')}
            variant="warning"
            confirmLabel={t('common:actions.run')}
            confirmTestId="confirm-fleet-action"
            message={scopeConfirmMessage({
              action: t('devicesPage.confirmRunAction', { script: pendingScriptRun.script.name }),
              deviceCount: pendingScriptRun.devices.length,
              orgNames: scriptOrgNames,
            })}
            isLoading={actionInProgress}
          />
        );
      })()}

      {/* Decommissioned-skip confirm (#2465): the selection contained retired,
          agent-less devices, which the API refuses. Name the count being dropped
          and make the user own the reduced batch. Offline devices are NOT
          dropped: for the queued agent-command actions their command queues
          and runs when they reconnect; for bulk Remove (`decommission`) an
          offline device is removed immediately (an immediate `DELETE`, not a
          queued command) — see DECOMMISSION_BLOCKED_BULK_ACTIONS in
          bulkActionGating.ts. */}
      {pendingDecommissionedSkip && (
        <ConfirmDialog
          open={true}
          onClose={() => setPendingDecommissionedSkip(null)}
          // Double-click safety lives in the shared components now (#3705), not
          // in this call site. ConfirmDialog holds a synchronous ref latch, so
          // the fleet cannot reboot twice even if the dialog stayed mounted;
          // and Dialog swallows the tail of the gesture after its portal is
          // torn out, so the second press cannot hit-test through to a device
          // row underneath. Previously only the unmount protected this, and it
          // protected only the first of those two failures.
          // (The set-state/dispatch ORDER below is not load-bearing either:
          // React batches both.) The click-through half is pinned in
          // DevicesPage.test.tsx; the latch half in ConfirmDialog.test.tsx,
          // which can hold the dialog mounted the way this call site does not.
          onConfirm={() => {
            const p = pendingDecommissionedSkip;
            setPendingDecommissionedSkip(null);
            void runBulkAction(p.action, p.devices);
          }}
          title={t('devicesPage.confirmDecommissionedSkip.title')}
          variant="warning"
          confirmLabel={t('common:actions.confirm')}
          confirmTestId="confirm-decommissioned-skip"
          message={t('devicesPage.confirmDecommissionedSkip.message', {
            skipped: pendingDecommissionedSkip.skippedCount,
            total: pendingDecommissionedSkip.totalCount,
            eligible: pendingDecommissionedSkip.devices.length,
          })}
        />
      )}

      {/* #3698: mirror of the device-detail confirm gate, reusing the SAME
          deviceActions.confirm.* copy so the two screens read identically and
          no new locale keys are needed. Double-click safety is the shared
          components' job (#3705) — see the decommissioned-skip dialog above. */}
      {/* #3987: Remove owns its own dialog — it is the one confirm that has a
          question to ask (uninstall the agent, or leave it?), not just a
          yes/no. Every other gated action keeps the generic ConfirmDialog
          below with the shared deviceActions.confirm.* copy. */}
      {pendingDeviceAction && pendingDeviceAction.action === 'decommission' && (
        <RemoveDeviceDialog
          open
          targets={[{
            hostname: pendingDeviceAction.device.hostname,
            status: pendingDeviceAction.device.status,
          }]}
          onClose={() => setPendingDeviceAction(null)}
          onConfirm={(choice) => {
            const p = pendingDeviceAction;
            setPendingDeviceAction(null);
            void runDeviceAction(p.action, p.device, choice);
          }}
          confirmTestId="confirm-device-action"
        />
      )}

      {pendingDeviceAction && pendingDeviceAction.action !== 'decommission' && (
        <ConfirmDialog
          open={true}
          onClose={() => setPendingDeviceAction(null)}
          onConfirm={() => {
            const p = pendingDeviceAction;
            setPendingDeviceAction(null);
            void runDeviceAction(p.action, p.device);
          }}
          // The hostname is interpolated into the TITLE as well as the message
          // (#5023): permanentDelete names the device up front — "Delete
          // {{hostname}} permanently?" — because that is the last thing the
          // operator reads before an irreversible delete. A no-op for the
          // existing keys, whose titles carry no placeholder.
          title={t(/* i18n-dynamic */ `deviceActions.confirm.${confirmKeyFor(pendingDeviceAction.action)}.title`, {
            hostname: pendingDeviceAction.device.hostname,
          })}
          message={t(/* i18n-dynamic */ `deviceActions.confirm.${confirmKeyFor(pendingDeviceAction.action)}.message`, {
            hostname: pendingDeviceAction.device.hostname,
          })}
          confirmLabel={t(/* i18n-dynamic */ `deviceActions.confirm.${confirmKeyFor(pendingDeviceAction.action)}.confirm`)}
          variant={DESTRUCTIVE_CONFIRM_ACTIONS.has(pendingDeviceAction.action) ? 'destructive' : 'warning'}
          confirmTestId="confirm-device-action"
        />
      )}

      {pendingBulkRemove && (
        <RemoveDeviceDialog
          open
          targets={pendingBulkRemove.map(d => ({ hostname: d.hostname, status: d.status }))}
          onClose={() => setPendingBulkRemove(null)}
          onConfirm={(choice) => {
            const devicesToRemove = pendingBulkRemove;
            setPendingBulkRemove(null);
            void runBulkRemove(devicesToRemove, choice);
          }}
          isLoading={actionInProgress}
          confirmTestId="confirm-bulk-remove"
        />
      )}

      {pendingBulkDeleteManual && (
        <ConfirmDialog
          open
          onClose={() => setPendingBulkDeleteManual(null)}
          onConfirm={() => {
            const targets = pendingBulkDeleteManual;
            setPendingBulkDeleteManual(null);
            void runBulkDeleteManual(targets);
          }}
          title={t('deviceActions.confirm.bulkDeleteManual.title', { count: pendingBulkDeleteManual.length })}
          message={t('deviceActions.confirm.bulkDeleteManual.message', { count: pendingBulkDeleteManual.length })}
          confirmLabel={t('deviceActions.confirm.bulkDeleteManual.confirm')}
          variant="destructive"
          isLoading={actionInProgress}
          confirmTestId="confirm-bulk-delete-manual"
        />
      )}

      {pendingBulkPurge && (
        <BulkPurgeDialog
          open
          targets={pendingBulkPurge.map(d => ({ hostname: d.hostname, orgId: d.orgId }))}
          onClose={() => setPendingBulkPurge(null)}
          onConfirm={() => {
            const devicesToPurge = pendingBulkPurge;
            setPendingBulkPurge(null);
            void runBulkPurge(devicesToPurge);
          }}
          isLoading={actionInProgress}
        />
      )}

      {settingsDevice && (
        <DeviceSettingsModal
          device={settingsDevice}
          isOpen={!!settingsDevice}
          onClose={() => setSettingsDevice(null)}
          onSaved={refreshDevices}
          onAction={handleDeviceAction}
        />
      )}
      </div>
    </>
  );
}
