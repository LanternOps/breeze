import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bell,
  ChevronRight,
  FileBarChart2,
  Laptop,
  Search,
  ShieldCheck,
  UserPlus,
  Users
} from 'lucide-react';
import { cn, formatNumber, formatRelativeTime } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { formatCurrency, formatNumber as formatLocaleNumber } from '@/lib/i18n/format';

type Device = {
  id?: string | number;
  name?: string;
  status?: string;
  state?: string;
  health?: string;
  alerts?: number;
  alertCount?: number;
  compliance?: number;
  compliancePercent?: number;
  lastSeen?: string | number | Date;
  customerId?: string;
  customerName?: string;
};

type Customer = {
  id?: string | number;
  customerId?: string | number;
  name?: string;
  companyName?: string;
  healthScore?: number;
  health?: {
    score?: number;
    status?: string;
  };
  healthStatus?: string;
  deviceCount?: number;
  devices?: Device[];
  deviceInventory?: Device[];
  deviceList?: Device[];
  inventory?: Device[];
  alertCount?: number;
  alerts?: {
    open?: number;
    count?: number;
  };
  compliancePercent?: number;
  compliance?: number;
  mrr?: number;
  billing?: {
    mrr?: number;
  };
};

type HealthLabel = 'healthy' | 'warning' | 'critical';

type SortKey = 'health' | 'devices' | 'name';

type CustomerOverview = {
  id: string;
  name: string;
  healthScore: number | null;
  healthLabel: HealthLabel;
  deviceCount: number;
  alertCount: number;
  compliance: number;
  mrr: number;
  devices: Device[];
};

type DeviceStatus = 'online' | 'offline' | 'warning' | 'unknown';

type DeviceOverview = {
  id: string;
  name: string;
  status: DeviceStatus;
  alerts: number;
  compliance: number;
  lastSeen: string;
  customerName: string;
};

const healthStyles: Record<HealthLabel, { badge: string; dot: string; text: string }> = {
  healthy: {
    badge: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
    dot: 'bg-emerald-500',
    text: 'text-emerald-700'
  },
  warning: {
    badge: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
    dot: 'bg-amber-500',
    text: 'text-amber-700'
  },
  critical: {
    badge: 'bg-red-500/10 text-red-700 border-red-500/30',
    dot: 'bg-red-500',
    text: 'text-red-700'
  }
};

const deviceStatusStyles: Record<DeviceStatus, { badge: string }> = {
  online: {
    badge: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
  },
  offline: {
    badge: 'bg-red-500/10 text-red-700 border-red-500/30'
  },
  warning: {
    badge: 'bg-amber-500/10 text-amber-700 border-amber-500/30'
  },
  unknown: {
    badge: 'bg-muted text-muted-foreground border-border'
  }
};

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePercent(value: unknown): number {
  const numeric = parseNumber(value);
  if (numeric === null) return 0;
  if (numeric <= 1) return numeric * 100;
  return numeric;
}

function normalizeCustomerId(customer: Customer, fallback: string): string {
  const id = customer.id ?? customer.customerId;
  if (id === undefined || id === null) return fallback;
  return String(id);
}

function normalizeCustomerName(customer: Customer, fallback: string): string {
  return customer.name?.trim() || customer.companyName?.trim() || fallback;
}

function resolveCustomerHealthScore(customer: Customer): number | null {
  const score =
    parseNumber(customer.healthScore) ?? parseNumber(customer.health?.score);
  if (score === null) return null;
  return score <= 1 ? score * 100 : score;
}

function resolveCustomerHealthLabel(customer: Customer, score: number | null): HealthLabel {
  const raw = customer.healthStatus ?? customer.health?.status;
  if (raw) {
    const normalized = String(raw).toLowerCase();
    if (['healthy', 'green', 'ok', 'good'].includes(normalized)) return 'healthy';
    if (['critical', 'red', 'risk', 'at risk'].includes(normalized)) return 'critical';
    if (['warning', 'yellow', 'monitor', 'needs attention'].includes(normalized)) return 'warning';
  }
  if (score !== null) {
    if (score >= 80) return 'healthy';
    if (score >= 60) return 'warning';
    return 'critical';
  }
  return 'warning';
}

function resolveDeviceList(customer: Customer): Device[] {
  const devices =
    customer.devices ??
    customer.deviceInventory ??
    customer.deviceList ??
    customer.inventory ??
    [];
  if (Array.isArray(devices)) return devices;
  if (devices && typeof devices === 'object') {
    const nested =
      (devices as { items?: Device[] }).items ??
      (devices as { devices?: Device[] }).devices ??
      [];
    return Array.isArray(nested) ? nested : [];
  }
  return [];
}

function resolveDeviceCount(customer: Customer, devices: Device[]): number {
  return parseNumber(customer.deviceCount) ?? devices.length ?? 0;
}

function resolveAlertCount(customer: Customer): number {
  return (
    parseNumber(customer.alertCount) ??
    parseNumber(customer.alerts?.open) ??
    parseNumber(customer.alerts?.count) ??
    0
  );
}

function resolveCompliance(customer: Customer): number {
  return normalizePercent(customer.compliancePercent ?? customer.compliance);
}

function resolveMrr(customer: Customer): number {
  return parseNumber(customer.mrr) ?? parseNumber(customer.billing?.mrr) ?? 0;
}

function normalizeDeviceStatus(device: Device): DeviceStatus {
  const raw = device.status ?? device.state ?? device.health;
  if (!raw) return 'unknown';
  const normalized = String(raw).toLowerCase();
  if (['online', 'healthy', 'ok', 'active', 'up'].includes(normalized)) return 'online';
  if (['offline', 'down', 'inactive', 'disconnected'].includes(normalized)) return 'offline';
  if (['warning', 'alert', 'degraded', 'needs attention'].includes(normalized)) return 'warning';
  return 'unknown';
}

function formatLastSeen(value: Device['lastSeen'], unknownLabel: string): string {
  if (!value) return unknownLabel;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return unknownLabel;
  return formatRelativeTime(date);
}

function normalizeCustomerData(customers: Customer[], fallbackCustomerName: (index: number) => string): CustomerOverview[] {
  return customers.map((customer, index) => {
    const fallbackName = fallbackCustomerName(index + 1);
    const name = normalizeCustomerName(customer, fallbackName);
    const id = normalizeCustomerId(customer, name);
    const healthScore = resolveCustomerHealthScore(customer);
    const healthLabel = resolveCustomerHealthLabel(customer, healthScore);
    const devices = resolveDeviceList(customer);
    const deviceCount = resolveDeviceCount(customer, devices);
    const alertCount = resolveAlertCount(customer);
    const compliance = resolveCompliance(customer);
    const mrr = resolveMrr(customer);

    return {
      id,
      name,
      healthScore,
      healthLabel,
      deviceCount,
      alertCount,
      compliance,
      mrr,
      devices
    };
  });
}

function normalizeDeviceData(customers: CustomerOverview[], fallbackDeviceName: (index: number) => string, unknownLabel: string): DeviceOverview[] {
  return customers.flatMap(customer => {
    return customer.devices.map((device, index) => {
      const id = device.id ?? `${customer.id}-device-${index}`;
      const name = device.name?.trim() || fallbackDeviceName(index + 1);
      const alerts = parseNumber(device.alertCount ?? device.alerts) ?? 0;
      const compliance = normalizePercent(device.compliancePercent ?? device.compliance);

      return {
        id: String(id),
        name,
        status: normalizeDeviceStatus(device),
        alerts,
        compliance,
        lastSeen: formatLastSeen(device.lastSeen, unknownLabel),
        customerName: device.customerName ?? customer.name
      };
    });
  });
}

export default function PartnerDashboard() {
  const { t } = useTranslation('common');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [healthFilter, setHealthFilter] = useState<'all' | HealthLabel>('all');
  const [sortKey, setSortKey] = useState<SortKey>('health');

  const fetchCustomers = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/partner/dashboard');
      if (!response.ok) {
        throw new Error(t('longTail.partner.PartnerDashboard.errors.fetchFailed'));
      }
      const payload = await response.json();
      const data = payload?.data ?? payload ?? {};
      const list = Array.isArray(data)
        ? data
        : data.customers ?? data.organizations ?? data.items ?? data.results ?? [];
      setCustomers(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.partner.PartnerDashboard.errors.fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const enrichedCustomers = useMemo(
    () => normalizeCustomerData(customers, (index) => t('longTail.partner.PartnerDashboard.fallbackCustomer', { index })),
    [customers, t]
  );

  const filteredCustomers = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const filtered = enrichedCustomers.filter(customer => {
      const matchesQuery = normalizedQuery
        ? customer.name.toLowerCase().includes(normalizedQuery)
        : true;
      const matchesHealth =
        healthFilter === 'all' ? true : customer.healthLabel === healthFilter;
      return matchesQuery && matchesHealth;
    });

    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortKey === 'name') {
        return a.name.localeCompare(b.name);
      }
      if (sortKey === 'devices') {
        return b.deviceCount - a.deviceCount;
      }
      const aScore = a.healthScore ?? -1;
      const bScore = b.healthScore ?? -1;
      return bScore - aScore;
    });

    return sorted;
  }, [enrichedCustomers, healthFilter, query, sortKey]);

  const allDevices = useMemo(
    () => normalizeDeviceData(
      enrichedCustomers,
      (index) => t('longTail.partner.PartnerDashboard.fallbackDevice', { index }),
      t('common:states.unknown')
    ),
    [enrichedCustomers, t]
  );

  const totalMrr = useMemo(() => {
    return enrichedCustomers.reduce((sum, customer) => sum + customer.mrr, 0);
  }, [enrichedCustomers]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('longTail.partner.PartnerDashboard.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && customers.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchCustomers}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('longTail.partner.PartnerDashboard.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('longTail.partner.PartnerDashboard.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('longTail.partner.PartnerDashboard.description')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href="/partner/customers/new"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:opacity-90"
          >
            <UserPlus className="h-4 w-4" />
            {t('longTail.partner.PartnerDashboard.addCustomer')}
          </a>
          <a
            href="/alerts"
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            <Bell className="h-4 w-4" />
            {t('longTail.partner.PartnerDashboard.viewAllAlerts')}
          </a>
          <a
            href="/reports"
            className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            <FileBarChart2 className="h-4 w-4" />
            {t('longTail.partner.PartnerDashboard.runReport')}
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{t('longTail.partner.PartnerDashboard.customerHealth')}</h2>
                <p className="text-sm text-muted-foreground">
                  {t('longTail.partner.PartnerDashboard.customerCount', {
                    filtered: filteredCustomers.length,
                    total: enrichedCustomers.length,
                  })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-56">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <input
                    type="search"
                    placeholder={t('longTail.partner.PartnerDashboard.searchCustomers')}
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <select
                  value={healthFilter}
                  onChange={event => setHealthFilter(event.target.value as 'all' | HealthLabel)}
                  className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="all">{t('longTail.partner.PartnerDashboard.allHealth')}</option>
                  <option value="healthy">{t('longTail.partner.PartnerDashboard.health.healthy')}</option>
                  <option value="warning">{t('longTail.partner.PartnerDashboard.health.warning')}</option>
                  <option value="critical">{t('longTail.partner.PartnerDashboard.health.critical')}</option>
                </select>
                <select
                  value={sortKey}
                  onChange={event => setSortKey(event.target.value as SortKey)}
                  className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="health">{t('longTail.partner.PartnerDashboard.sort.health')}</option>
                  <option value="devices">{t('longTail.partner.PartnerDashboard.sort.devices')}</option>
                  <option value="name">{t('longTail.partner.PartnerDashboard.sort.name')}</option>
                </select>
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {filteredCustomers.map(customer => {
                const health = healthStyles[customer.healthLabel];
                return (
                  <a
                    key={customer.id}
                    href={`/partner/customers/${encodeURIComponent(customer.id)}`}
                    className="group rounded-lg border bg-background p-4 transition hover:border-primary/40 hover:shadow-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{customer.name}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className={cn('h-2.5 w-2.5 rounded-full', health.dot)} />
                          <span className={cn('font-medium', health.text)}>{t(/* i18n-dynamic */ `longTail.partner.PartnerDashboard.health.${customer.healthLabel}`)}</span>
                          <span className="text-muted-foreground">•</span>
                          <span>
                            {customer.healthScore !== null
                              ? t('longTail.partner.PartnerDashboard.healthScore', {
                                  score: formatLocaleNumber(customer.healthScore, { maximumFractionDigits: 0 }),
                                })
                              : t('longTail.partner.PartnerDashboard.healthScoreUnavailable')}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground transition group-hover:text-foreground" />
                    </div>

                    <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                      <div className="rounded-md border bg-muted/30 p-3">
                        <div className="flex items-center gap-2">
                          <Laptop className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-muted-foreground">{t('longTail.partner.PartnerDashboard.devices')}</span>
                        </div>
                        <p className="mt-2 text-sm font-semibold">
                          {formatNumber(customer.deviceCount)}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 p-3">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-muted-foreground">{t('longTail.partner.PartnerDashboard.alerts')}</span>
                        </div>
                        <p className="mt-2 text-sm font-semibold">
                          {formatNumber(customer.alertCount)}
                        </p>
                      </div>
                      <div className="rounded-md border bg-muted/30 p-3">
                        <div className="flex items-center gap-2">
                          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-muted-foreground">{t('longTail.partner.PartnerDashboard.compliance')}</span>
                        </div>
                        <p className="mt-2 text-sm font-semibold">
                          {formatLocaleNumber(customer.compliance, { maximumFractionDigits: 0 })}%
                        </p>
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>

            {filteredCustomers.length === 0 && (
              <div className="mt-6 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t('longTail.partner.PartnerDashboard.noCustomerMatches')}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{t('longTail.partner.PartnerDashboard.billingSummary')}</h2>
                <p className="text-sm text-muted-foreground">{t('longTail.partner.PartnerDashboard.monthlyRecurringRevenue')}</p>
              </div>
              <div className="rounded-full border bg-muted/30 p-2">
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2">{t('longTail.partner.PartnerDashboard.customer')}</th>
                    <th className="px-3 py-2 text-right">{t('longTail.partner.PartnerDashboard.mrr')}</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichedCustomers.map(customer => (
                    <tr key={`billing-${customer.id}`} className="border-t">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'h-2 w-2 rounded-full',
                              healthStyles[customer.healthLabel].dot
                            )}
                          />
                          <span className="text-sm font-medium text-foreground">{customer.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right text-sm font-semibold text-foreground">
                        {formatCurrency(customer.mrr, 'USD', { maximumFractionDigits: 0 })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t('longTail.partner.PartnerDashboard.totalMrr')}</span>
              <span className="font-semibold text-foreground">
                {formatCurrency(totalMrr, 'USD', { maximumFractionDigits: 0 })}
              </span>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{t('longTail.partner.PartnerDashboard.portfolioSnapshot')}</h2>
                <p className="text-sm text-muted-foreground">{t('longTail.partner.PartnerDashboard.healthAndDeviceCoverage')}</p>
              </div>
              <div className="rounded-full border bg-muted/30 p-2">
                <Users className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div className="mt-4 grid gap-3">
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('longTail.partner.PartnerDashboard.customers')}</span>
                </div>
                <span className="font-semibold text-foreground">
                  {formatNumber(enrichedCustomers.length)}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <Laptop className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('longTail.partner.PartnerDashboard.totalDevices')}</span>
                </div>
                <span className="font-semibold text-foreground">
                  {formatNumber(
                    enrichedCustomers.reduce((sum, customer) => sum + customer.deviceCount, 0)
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('longTail.partner.PartnerDashboard.openAlerts')}</span>
                </div>
                <span className="font-semibold text-foreground">
                  {formatNumber(
                    enrichedCustomers.reduce((sum, customer) => sum + customer.alertCount, 0)
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t('longTail.partner.PartnerDashboard.devicesAcrossCustomers')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('longTail.partner.PartnerDashboard.devicesTracked', {
                count: allDevices.length,
                formattedCount: formatNumber(allDevices.length),
              })}
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {t('common:states.online')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              {t('longTail.partner.PartnerDashboard.status.warning')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              {t('common:states.offline')}
            </span>
          </div>
        </div>

        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('common:labels.device')}</th>
                <th className="px-4 py-3">{t('longTail.partner.PartnerDashboard.customer')}</th>
                <th className="px-4 py-3">{t('common:labels.status')}</th>
                <th className="px-4 py-3 text-right">{t('longTail.partner.PartnerDashboard.alerts')}</th>
                <th className="px-4 py-3 text-right">{t('longTail.partner.PartnerDashboard.compliance')}</th>
                <th className="px-4 py-3 text-right">{t('longTail.partner.PartnerDashboard.lastSeen')}</th>
              </tr>
            </thead>
            <tbody>
              {allDevices.map(device => {
                const statusConfig = deviceStatusStyles[device.status];
                return (
                  <tr key={device.id} className="border-t">
                    <td className="px-4 py-3 font-medium text-foreground">{device.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{device.customerName}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          statusConfig.badge
                        )}
                      >
                        {t(/* i18n-dynamic */ `longTail.partner.PartnerDashboard.status.${device.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-foreground">
                      {formatNumber(device.alerts)}
                    </td>
                    <td className="px-4 py-3 text-right text-foreground">
                      {formatLocaleNumber(device.compliance, { maximumFractionDigits: 0 })}%
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {device.lastSeen}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {allDevices.length === 0 && (
          <div className="mt-6 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('longTail.partner.PartnerDashboard.noDeviceInventory')}
          </div>
        )}
      </div>
    </div>
  );
}
