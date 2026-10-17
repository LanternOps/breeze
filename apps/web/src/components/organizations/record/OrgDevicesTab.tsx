import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '@/lib/i18n';
import DeviceList, { type Device, type DeviceStatus } from '@/components/devices/DeviceList';
import { ORG_TAB_COLUMN_PRESET } from '@/components/devices/columnVisibility';
import { navigateTo } from '@/lib/navigation';
import { applyOrgSwitch } from '@/lib/orgSwitch';
import { usePermissions } from '@/lib/permissions';
import { toDeviceListRow, type ApiDeviceRow } from '@/components/devices/deviceRowTransform';
import type { OrgFetch } from './orgRecordFetch';

export interface OrgDevicesTabProps {
  orgId: string;
  orgName: string;
  orgFetch: OrgFetch;
}

/** The tab's single bounded page (see the component note). Exported for the test. */
export const ORG_DEVICES_LIMIT = 200;

type SiteOption = { id: string; name: string };

/** `null` = still loading; `'failed'` = the request did not succeed. */
type LoadState<T> = T[] | 'failed' | null;

const STATUS_OPTIONS: DeviceStatus[] = [
  'online',
  'offline',
  'maintenance',
  'decommissioned',
  'quarantined',
  'updating',
  'pending',
];

/**
 * The organization record's Devices tab (#5075 W02).
 *
 * Every row already belongs to the record's org — the request is pinned via
 * `orgFetch` (never the ambient OrgSwitcher scope) — so `DeviceList` renders
 * with `forceSingleOrg`, which hides the Organization column even while the
 * switcher points at "All organizations" or a different org entirely.
 *
 * A single bounded page (`limit=200`) rather than the fleet page's full
 * cursor walk: a customer record's own device count is realistically well
 * under that, and the filter bar here is intentionally the cut-down
 * search/status/site set rather than the fleet page's full chip-based filter
 * builder. An org past the cap is told so (#9023): the cursor response's
 * `nextCursor` says rows were left behind, and the notice hands off to the
 * fleet page in this org's workspace, which walks every page.
 */
export default function OrgDevicesTab({ orgId, orgName, orgFetch }: OrgDevicesTabProps) {
  const { t } = useTranslation('organizations');
  const { can } = usePermissions();
  // Same gate as the fleet page's "Install agent": the enrol flow mints an
  // enrolment key, which the API gates on organizations:write (#7217).
  const canAddDevice = can('organizations', 'write');
  const [devices, setDevices] = useState<LoadState<Device>>(null);
  const [truncated, setTruncated] = useState(false);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setDevices(null);
    setTruncated(false);
    void (async () => {
      try {
        const res = await orgFetch(`/devices?limit=${ORG_DEVICES_LIMIT}`);
        if (!res.ok) throw new Error(`devices load failed: ${res.status}`);
        const body = await res.json();
        const rows: ApiDeviceRow[] | null = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
        // A 200 whose body isn't a parseable array tells us nothing about the
        // real device count — treating it as `[]` would render "No devices
        // found" (active guidance to adjust filters) for what is actually an
        // API failure. Fail the same way a non-2xx response does.
        if (rows === null) throw new Error('devices load: malformed response body');
        if (cancelled) return;
        setDevices(rows.map(toDeviceListRow));
        // Cursor mode (no `page`) returns `nextCursor` when rows remain; a
        // `total` (legacy/offset shape) says the same thing another way.
        const pagination = body?.pagination;
        const total = typeof pagination?.total === 'number' ? pagination.total : null;
        setTruncated(Boolean(pagination?.nextCursor) || (total !== null && total > rows.length));
      } catch (err) {
        console.warn('[OrgDevicesTab] devices load failed', err);
        if (!cancelled) setDevices('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgFetch, orgId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await orgFetch(`/orgs/sites?organizationId=${orgId}&limit=100`);
        if (!res.ok) throw new Error(`sites load failed: ${res.status}`);
        const body = await res.json();
        const rows: SiteOption[] | null = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
        if (rows === null) throw new Error('sites load: malformed response body');
        if (!cancelled) setSites(rows.map((s) => ({ id: s.id, name: s.name })));
      } catch (err) {
        // Site names only feed the filter dropdown — a failed load leaves it
        // absent, the device list itself is unaffected.
        console.warn('[OrgDevicesTab] sites load failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgFetch, orgId]);

  const filteredDevices = useMemo(() => {
    if (devices === null || devices === 'failed') return [];
    const q = search.trim().toLowerCase();
    // Same label /devices shows for a device whose site is not in the lookup.
    const siteNameById = new Map(sites.map((s) => [s.id, s.name]));
    return devices
      .filter((d) => {
        if (statusFilter && d.status !== statusFilter) return false;
        if (siteFilter && d.siteId !== siteFilter) return false;
        if (q && !d.hostname?.toLowerCase().includes(q)) return false;
        return true;
      })
      .map((d) => ({ ...d, siteName: siteNameById.get(d.siteId) ?? i18n.t('devices:devicesPage.unknownSite') }));
  }, [devices, sites, search, statusFilter, siteFilter]);

  const filtersActive = search.trim() !== '' || statusFilter !== '' || siteFilter !== '';
  const clearFilters = () => {
    setSearch('');
    setStatusFilter('');
    setSiteFilter('');
  };
  // Leaving the record is the point of both hand-offs below; the fleet page
  // (and its enrol modal) work in the ambient org, so switch to this one.
  const switchTo = (destination: string) =>
    void applyOrgSwitch(orgId, t('orgRecord.actions.workHereToast', { orgName }), destination);

  if (devices === null) {
    return (
      <div data-testid="org-devices-loading" className="flex items-center justify-center py-12">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (devices === 'failed') {
    return (
      <div data-testid="org-devices-error" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t('orgRecord.devices.loadError')}
      </div>
    );
  }

  // Nothing enrolled at all: no filter bar, no table header, and no "try
  // adjusting your filters" advice for filters nobody set (#9023).
  if (devices.length === 0) {
    return (
      <div data-testid="org-devices-tab" className="space-y-4">
        <div
          data-testid="org-devices-empty"
          className="flex flex-col items-start gap-3 rounded-lg border bg-card p-6 text-sm"
        >
          <p className="text-muted-foreground">{t('orgRecord.devices.noneEnrolled', { orgName })}</p>
          {canAddDevice && (
            <button
              type="button"
              data-testid="org-devices-add"
              onClick={() => switchTo('/devices#add-device')}
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t('orgRecord.devices.addDevice')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="org-devices-tab" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          data-testid="org-devices-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('orgRecord.devices.searchPlaceholder')}
          aria-label={t('orgRecord.devices.searchLabel')}
          className="h-9 w-56 rounded-md border bg-background px-3 text-sm"
        />
        <select
          data-testid="org-devices-status-filter"
          aria-label={t('orgRecord.devices.statusFilterLabel')}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="">{t('orgRecord.devices.allStatuses')}</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {t(/* i18n-dynamic */ `orgRecord.devices.status.${status}`)}
            </option>
          ))}
        </select>
        {sites.length > 0 && (
          <select
            data-testid="org-devices-site-filter"
            aria-label={t('orgRecord.devices.siteFilterLabel')}
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">{t('orgRecord.devices.allSites')}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {truncated && (
        <p data-testid="org-devices-cap-notice" className="text-sm text-muted-foreground">
          {t('orgRecord.devices.capNotice', { limit: ORG_DEVICES_LIMIT })}
          {' · '}
          <button
            type="button"
            data-testid="org-devices-open-in-devices"
            onClick={() => switchTo('/devices')}
            className="font-medium text-primary hover:underline"
          >
            {t('orgRecord.devices.openInDevices')}
          </button>
        </p>
      )}
      {filtersActive && filteredDevices.length === 0 ? (
        <div
          data-testid="org-devices-no-matches"
          className="flex flex-col items-start gap-3 rounded-lg border bg-card p-6 text-sm"
        >
          <p className="text-muted-foreground">{t('orgRecord.devices.noMatches')}</p>
          <button
            type="button"
            data-testid="org-devices-clear-filters"
            onClick={clearFilters}
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
          >
            {t('orgRecord.devices.clearFilters')}
          </button>
        </div>
      ) : (
        <DeviceList
          devices={filteredDevices}
          sites={sites}
          forceSingleOrg
          columnPreset={ORG_TAB_COLUMN_PRESET}
          onSelect={(d) => void navigateTo(`/devices/${d.id}`)}
        />
      )}
    </div>
  );
}
