import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { OEM_LANES, type OemLane } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { replaceUrl } from '@/lib/replaceUrl';
import { useHashState } from '@/lib/useHashState';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { OEM_VENDOR_NAMES, type OemDisplayState } from '../devices/vendorUpdatesApi';
import {
  mergeVendorUpdatesHash,
  parsePatchesHash,
  VENDOR_UPDATE_STATES,
  type VendorUpdateLaneSelection,
  type VendorUpdateStateSelection,
} from './patchesHash';

type PatchesT = TFunction<'patches'>;

type FleetDevice = {
  deviceId: string;
  hostname: string;
  orgName: string;
  siteName: string | null;
  lane: OemLane | null;
  displayState: OemDisplayState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  scheduleNotHandedBack: boolean;
};

type Fleet = { counts: Record<OemDisplayState, number>; total: number; devices: FleetDevice[] };

const PAGE_SIZE = 50;

// Same colours as the device section's badge, so a state looks alike on both.
const STATE_BADGE: Record<OemDisplayState, string> = {
  up_to_date: 'bg-success/15 text-success',
  overdue: 'bg-warning/15 text-warning',
  failing: 'bg-destructive/15 text-destructive',
  not_supported: 'bg-muted text-muted-foreground',
  not_managed: 'bg-muted text-muted-foreground',
  waiting_for_reboot: 'bg-warning/15 text-warning',
  reboot_overdue: 'bg-destructive/15 text-destructive',
};

// Explicit switch rather than a key built from the value: these come from the
// server, and keyUsage.test.ts can only verify a literal key.
function stateLabel(state: OemDisplayState, t: PatchesT): string {
  switch (state) {
    case 'up_to_date':
      return t('vendorUpdates.state.upToDate');
    case 'overdue':
      return t('vendorUpdates.state.overdue');
    case 'failing':
      return t('vendorUpdates.state.failing');
    case 'not_supported':
      return t('vendorUpdates.state.notSupported');
    case 'not_managed':
      return t('vendorUpdates.state.notManaged');
    case 'waiting_for_reboot':
      return t('vendorUpdates.state.waitingForReboot');
    case 'reboot_overdue':
      return t('vendorUpdates.state.rebootOverdue');
  }
}

const stateFromHash = (hash: string): VendorUpdateStateSelection | undefined =>
  parsePatchesHash(hash).vendorState ?? undefined;
const laneFromHash = (hash: string): VendorUpdateLaneSelection | undefined =>
  parsePatchesHash(hash).vendorLane ?? undefined;

type LoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'pick_org' }
  | { status: 'loaded'; fleet: Fleet; orgId: string | null };

/**
 * The Vendor updates tab (#11074): how many machines are in each state, and which.
 * Read-only: a device's own Run vendor updates action is on its page, one click away.
 * Both filters live in the hash, so a link from an alert lands filtered.
 */
export default function VendorUpdatesView() {
  const { t } = useTranslation('patches');
  const { currentOrgId } = useOrgStore();

  const [stateFilter, setStateFilterRaw] = useHashState<VendorUpdateStateSelection>('all', stateFromHash);
  const [laneFilter, setLaneFilterRaw] = useHashState<VendorUpdateLaneSelection>('all', laneFromHash);

  const writeHash = useCallback((patch: { state?: VendorUpdateStateSelection; lane?: VendorUpdateLaneSelection }) => {
    replaceUrl(`${window.location.pathname}${window.location.search}${mergeVendorUpdatesHash(window.location.hash, patch)}`);
  }, []);
  const setStateFilter = useCallback((next: VendorUpdateStateSelection) => {
    setStateFilterRaw(next);
    writeHash({ state: next });
  }, [setStateFilterRaw, writeHash]);
  const setLaneFilter = useCallback((next: VendorUpdateLaneSelection) => {
    setLaneFilterRaw(next);
    writeHash({ lane: next });
  }, [setLaneFilterRaw, writeHash]);

  // An offset belongs to one filter combination, however that combination changed:
  // a click here, or a hash changed from outside.
  const filterKey = `${stateFilter}|${laneFilter}|${currentOrgId ?? ''}`;
  const [paging, setPaging] = useState({ key: filterKey, offset: 0 });
  const offset = paging.key === filterKey ? paging.offset : 0;

  const [reloadCount, setReloadCount] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState(true);
  const latestRequest = useRef(0);

  useEffect(() => {
    latestRequest.current += 1;
    const request = latestRequest.current;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (stateFilter !== 'all') params.set('state', stateFilter);
    if (laneFilter !== 'all') params.set('lane', laneFilter);

    // The counts stay on screen, dimmed, while a new page or filter loads. Another org's do not.
    setBusy(true);
    setLoad((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    void (async () => {
      let next: LoadState;
      try {
        // The org scope is ambient: fetchWithAuth injects the header's org.
        const response = await fetchWithAuth(`/oem-updates/fleet?${params.toString()}`);
        if (response.status === 400) next = { status: 'pick_org' };
        else if (!response.ok) next = { status: 'failed' };
        else next = { status: 'loaded', fleet: await response.json() as Fleet, orgId: currentOrgId };
      } catch (error) {
        console.error('[VendorUpdatesView] load failed', error);
        next = { status: 'failed' };
      }
      // A slow answer for a filter the user has left must not overwrite the current one.
      if (request === latestRequest.current) {
        setLoad(next);
        setBusy(false);
      }
    })();
  }, [stateFilter, laneFilter, offset, currentOrgId, reloadCount]);

  if (load.status === 'failed') {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm">
        <p className="text-destructive">{t('vendorUpdates.loadError')}</p>
        <button
          type="button"
          data-testid="vendor-updates-retry"
          onClick={() => {
            setLoad({ status: 'loading' });
            setReloadCount((count) => count + 1);
          }}
          className="mt-3 rounded-md border px-3 py-1.5 font-medium hover:bg-muted"
        >
          {t('vendorUpdates.retry')}
        </button>
      </div>
    );
  }

  if (load.status === 'pick_org') {
    return (
      <div data-testid="vendor-updates-pick-org" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t('vendorUpdates.pickOrganization')}
      </div>
    );
  }

  const fleet = load.status === 'loaded' && load.orgId === currentOrgId ? load.fleet : null;
  const dimmed = busy && fleet !== null;
  const total = fleet?.total ?? 0;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-4" data-testid="vendor-updates-view" aria-busy={busy}>
      <p className="text-sm text-muted-foreground">{t('vendorUpdates.description')}</p>

      <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7', dimmed && 'opacity-60')}>
        {VENDOR_UPDATE_STATES.map((state) => (
          <button
            key={state}
            type="button"
            data-testid={`vendor-updates-count-${state}`}
            aria-pressed={stateFilter === state}
            onClick={() => setStateFilter(stateFilter === state ? 'all' : state)}
            className={cn(
              'rounded-lg border bg-card p-3 text-left transition hover:border-muted-foreground',
              stateFilter === state && 'border-primary ring-1 ring-primary',
            )}
          >
            <div className="text-2xl font-semibold tabular-nums">{fleet ? fleet.counts[state] : '–'}</div>
            <div className="mt-1 text-xs text-muted-foreground">{stateLabel(state, t)}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="vendor-updates-lane" className="text-sm text-muted-foreground">
          {t('vendorUpdates.vendorFilter')}
        </label>
        <select
          id="vendor-updates-lane"
          data-testid="vendor-updates-lane-filter"
          value={laneFilter}
          onChange={(event) => setLaneFilter(event.target.value as VendorUpdateLaneSelection)}
          className="h-9 rounded-md border bg-background px-3 text-sm"
        >
          <option value="all">{t('vendorUpdates.allVendors')}</option>
          {OEM_LANES.map((lane) => (
            <option key={lane} value={lane}>{OEM_VENDOR_NAMES[lane]}</option>
          ))}
        </select>
      </div>

      <div className={cn('overflow-x-auto rounded-lg border bg-card', dimmed && 'opacity-60')}>
        <table className="min-w-full text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">{t('vendorUpdates.columns.device')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('vendorUpdates.columns.organization')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('vendorUpdates.columns.site')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('vendorUpdates.columns.vendor')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('vendorUpdates.columns.state')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('vendorUpdates.columns.lastRun')}</th>
              <th scope="col" className="px-4 py-2 font-medium">{t('vendorUpdates.columns.lastSuccess')}</th>
            </tr>
          </thead>
          <tbody>
            {!fleet && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label={t('vendorUpdates.loading')} />
                </td>
              </tr>
            )}
            {fleet && fleet.devices.length === 0 && (
              <tr>
                <td colSpan={7} data-testid="vendor-updates-empty" className="px-4 py-8 text-center text-muted-foreground">
                  {t('vendorUpdates.empty')}
                </td>
              </tr>
            )}
            {fleet?.devices.map((device) => (
              <tr key={device.deviceId} data-testid={`vendor-updates-row-${device.deviceId}`} className="border-b last:border-b-0">
                <td className="px-4 py-2 font-medium">
                  <a
                    href={`/devices/${device.deviceId}`}
                    data-testid={`vendor-updates-row-link-${device.deviceId}`}
                    className="hover:underline"
                  >
                    {device.hostname}
                  </a>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{device.orgName}</td>
                <td className="px-4 py-2 text-muted-foreground">{device.siteName ?? '–'}</td>
                <td className="px-4 py-2 text-muted-foreground">{device.lane ? OEM_VENDOR_NAMES[device.lane] : '–'}</td>
                <td className="px-4 py-2">
                  <span
                    data-testid="vendor-updates-row-state"
                    data-state={device.displayState}
                    className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', STATE_BADGE[device.displayState])}
                  >
                    {stateLabel(device.displayState, t)}
                  </span>
                  {device.scheduleNotHandedBack && (
                    <div data-testid="vendor-updates-row-schedule-note" className="mt-1 flex items-center gap-1 text-xs text-warning">
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                      {t('vendorUpdates.scheduleNotHandedBack')}
                    </div>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                  {device.lastAttemptAt ? formatDateTime(device.lastAttemptAt) : t('vendorUpdates.never')}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                  {device.lastSuccessAt ? formatDateTime(device.lastSuccessAt) : t('vendorUpdates.never')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span data-testid="vendor-updates-range">
          {total > 0 ? t('vendorUpdates.range', { from: offset + 1, to: pageEnd, total }) : ''}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="vendor-updates-previous"
            disabled={offset === 0}
            onClick={() => setPaging({ key: filterKey, offset: Math.max(0, offset - PAGE_SIZE) })}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            {t('vendorUpdates.previous')}
          </button>
          <button
            type="button"
            data-testid="vendor-updates-next"
            disabled={pageEnd >= total}
            onClick={() => setPaging({ key: filterKey, offset: offset + PAGE_SIZE })}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('vendorUpdates.next')}
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
