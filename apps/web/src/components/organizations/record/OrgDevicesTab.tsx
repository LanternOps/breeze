import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DeviceList, { type Device, type DeviceStatus } from '@/components/devices/DeviceList';
import type { OrgFetch } from './orgRecordFetch';

export interface OrgDevicesTabProps {
  orgId: string;
  orgFetch: OrgFetch;
}

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
 * builder. This is an unenforced assumption, not a hard cap — an org past
 * 200 devices silently loses rows past the limit with no truncation notice.
 * Revisit with real pagination (or `fetchAllDevices`'s cursor walk) if that
 * ever stops being realistic.
 */
export default function OrgDevicesTab({ orgId, orgFetch }: OrgDevicesTabProps) {
  const { t } = useTranslation('organizations');
  const [devices, setDevices] = useState<LoadState<Device>>(null);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setDevices(null);
    void (async () => {
      try {
        const res = await orgFetch('/devices?limit=200');
        if (!res.ok) throw new Error(`devices load failed: ${res.status}`);
        const body = await res.json();
        const rows: Device[] | null = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
        // A 200 whose body isn't a parseable array tells us nothing about the
        // real device count — treating it as `[]` would render "No devices
        // found" (active guidance to adjust filters) for what is actually an
        // API failure. Fail the same way a non-2xx response does.
        if (rows === null) throw new Error('devices load: malformed response body');
        if (!cancelled) setDevices(rows);
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
    return devices.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (siteFilter && d.siteId !== siteFilter) return false;
      if (q && !d.hostname?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [devices, search, statusFilter, siteFilter]);

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

  return (
    <div data-testid="org-devices-tab" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          data-testid="org-devices-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('orgRecord.devices.searchPlaceholder')}
          className="h-9 w-56 rounded-md border bg-background px-3 text-sm"
        />
        <select
          data-testid="org-devices-status-filter"
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
      <DeviceList devices={filteredDevices} sites={sites} forceSingleOrg />
    </div>
  );
}
