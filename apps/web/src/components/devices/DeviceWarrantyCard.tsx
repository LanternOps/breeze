import { useState, useEffect, useRef } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type WarrantyEntitlement = {
  provider: string;
  serviceLevelDescription: string;
  entitlementType: string;
  startDate: string;
  endDate: string;
};

type WarrantyData = {
  id: string;
  deviceId: string;
  manufacturer: string;
  serialNumber: string;
  status: 'active' | 'expiring' | 'expired' | 'unknown' | 'subscription_active';
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  isSubscription?: boolean;
  entitlements: WarrantyEntitlement[];
  dataSource: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
};

type DeviceWarrantyCardProps = {
  deviceId: string;
  compact?: boolean;
  /** Override the refresh poll timeout (ms). Test seam only — defaults to
   *  REFRESH_POLL_TIMEOUT_MS in production. */
  pollTimeoutMs?: number;
};

const statusConfig: Record<string, { label: string; color: string }> = {
  active: { label: 'active', color: 'bg-success/15 text-success border-success/30' },
  expiring: { label: 'expiring', color: 'bg-warning/15 text-warning border-warning/30' },
  expired: { label: 'expired', color: 'bg-destructive/15 text-destructive border-destructive/30' },
  unknown: { label: 'unknown', color: 'bg-muted text-muted-foreground border-border' },
  // Active AppleCare subscription: renewing coverage with no fixed end date — the
  // stored end date is the next renewal, not an expiry (#1320).
  subscription_active: { label: 'appleCareSubscription', color: 'bg-success/15 text-success border-success/30' },
};

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function dataSourceLabel(source: string | null): string {
  if (!source) return '';
  switch (source) {
    case 'agent_plist': return 'Agent (macOS plist)';
    case 'provider': return 'Vendor API';
    default: return source;
  }
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// The refresh runs asynchronously in a BullMQ worker (the route returns 200 the
// moment the job is queued), so we poll the warranty endpoint after queuing and
// stop as soon as the worker stamps a newer lastSyncAt — that way the card
// updates on its own instead of leaving the user to reload (#1723).
const REFRESH_POLL_INTERVAL_MS = 2000;
const REFRESH_POLL_TIMEOUT_MS = 30000;

// The worker stamps lastSyncAt on BOTH success and failure (a failed provider
// lookup populates lastSyncError but still advances the timestamp), so a fresher
// lastSyncAt alone does not mean the refresh succeeded — we must inspect
// lastSyncError to avoid reporting a failed refresh as success (#1723).
// The legacy "No configured provider" string is an expected, non-error outcome
// (the manufacturer simply has no warranty provider) and is shown inline, not
// toasted as an error.
function isProviderNotConfigured(err: string | null): boolean {
  return !!err && err.includes('No configured provider');
}

export default function DeviceWarrantyCard({
  deviceId,
  compact = false,
  pollTimeoutMs = REFRESH_POLL_TIMEOUT_MS,
}: DeviceWarrantyCardProps) {
  const { t } = useTranslation('devices');
  const [warranty, setWarranty] = useState<WarrantyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  // Cleared on unmount / deviceId change so a late poll tick can't setState on
  // an unmounted card or bleed across devices.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const clearPoll = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const fetchWarranty = async (): Promise<WarrantyData | null> => {
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/warranty`);
      if (res.ok) {
        const data = await res.json();
        if (mountedRef.current) {
          setWarranty(data.warranty);
          setError(false);
        }
        return data.warranty ?? null;
      }
      if (mountedRef.current) setError(true);
      return null;
    } catch {
      if (mountedRef.current) setError(true);
      return null;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    fetchWarranty();
    return () => {
      mountedRef.current = false;
      clearPoll();
    };
    // Re-run only when the device changes; fetchWarranty/clearPoll are stable
    // closures recreated each render and intentionally excluded.
  }, [deviceId]);

  const handleRefresh = async () => {
    if (refreshing) return;
    clearPoll();
    setRefreshing(true);
    // Capture the pre-refresh sync timestamp so we can detect when the worker
    // produces a fresher result.
    const previousSyncAt = warranty?.lastSyncAt ?? null;
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/${deviceId}/warranty/refresh`, { method: 'POST' }),
        errorFallback: t('deviceWarrantyCard.toasts.queueFailed'),
        successMessage: t('deviceWarrantyCard.toasts.refreshing'),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch (err) {
      handleActionError(err, t('deviceWarrantyCard.toasts.queueFailed'));
      if (mountedRef.current) setRefreshing(false);
      return;
    }

    // Poll until the worker stamps a newer lastSyncAt or we hit the timeout,
    // then surface the outcome and stop the spinner. A fresher timestamp can
    // mean success OR a worker-side failure, so inspect lastSyncError before
    // declaring success — otherwise a failed refresh reads as success.
    const startedAt = Date.now();
    const poll = async () => {
      const next = await fetchWarranty();
      const advanced = !!next?.lastSyncAt && next.lastSyncAt !== previousSyncAt;
      if (advanced) {
        if (mountedRef.current) {
          setRefreshing(false);
          if (next?.lastSyncError && !isProviderNotConfigured(next.lastSyncError)) {
            showToast({ message: t('deviceWarrantyCard.toasts.refreshFailed', { error: next.lastSyncError }), type: 'error' });
          } else if (isProviderNotConfigured(next?.lastSyncError ?? null)) {
            showToast({ message: t('deviceWarrantyCard.toasts.noProvider'), type: 'warning' });
          } else {
            showToast({ message: t('deviceWarrantyCard.toasts.updated'), type: 'success' });
          }
        }
        return;
      }
      if (Date.now() - startedAt >= pollTimeoutMs) {
        // Timed out before the worker produced a fresher result. Don't settle
        // silently (that's the #1723 confusion) — tell the user it's still
        // running and will update on its own.
        if (mountedRef.current) {
          setRefreshing(false);
          showToast({
            message: t('deviceWarrantyCard.toasts.stillInProgress'),
            type: 'warning',
          });
        }
        return;
      }
      if (mountedRef.current) {
        pollTimerRef.current = setTimeout(poll, REFRESH_POLL_INTERVAL_MS);
      }
    };
    pollTimerRef.current = setTimeout(poll, REFRESH_POLL_INTERVAL_MS);
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs animate-pulse">
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="mt-3 h-6 w-48 rounded bg-muted" />
      </div>
    );
  }

  if (!warranty) {
    if (compact) {
      return (
        <div className="rounded-lg border bg-card p-4 shadow-xs">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            {t('deviceWarrantyCard.compactTitle')}
          </div>
          {error ? (
            // A fetch failure is distinct from a device that genuinely has no
            // warranty record — surface it with a retry rather than the
            // identical "No warranty information" empty state.
            <p className="mt-2 text-sm text-muted-foreground">
              {t('deviceWarrantyCard.loadFailed')}{' '}
              <button
                type="button"
                onClick={() => { setError(false); setLoading(true); fetchWarranty(); }}
                className="font-medium text-primary hover:underline"
              >
                {t('common:actions.retry')}
              </button>
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{t('deviceWarrantyCard.noInformation')}</p>
          )}
        </div>
      );
    }
    return null;
  }

  const cfg = statusConfig[warranty.status] ?? statusConfig.unknown;
  const primaryEntitlement = warranty.entitlements?.[0];
  // For a renewing subscription the stored end date is the next renewal, not an expiry.
  const isSubscription = warranty.isSubscription || warranty.status === 'subscription_active';
  const endDateLabel = isSubscription ? t('deviceWarrantyCard.renews') : t('deviceWarrantyCard.expires');

  if (compact) {
    return (
      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            {t('deviceWarrantyCard.compactTitle')}
          </div>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.color}`}>
            {t(/* i18n-dynamic */ `deviceWarrantyCard.status.${cfg.label}`)}
          </span>
        </div>
        <p className="mt-2 text-sm font-medium">
          {primaryEntitlement
            ? `${warranty.manufacturer?.toUpperCase()} ${primaryEntitlement.serviceLevelDescription}`
            : warranty.manufacturer?.toUpperCase() ?? t('deviceWarrantyCard.status.unknown')}
        </p>
        {warranty.warrantyEndDate && (
          <p className="text-xs text-muted-foreground">
            {endDateLabel} {formatDate(warranty.warrantyEndDate)}
          </p>
        )}
      </div>
    );
  }

  // Full expanded view
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-lg font-semibold">{t('deviceWarrantyCard.title')}</h3>
          <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${cfg.color}`}>
            {t(/* i18n-dynamic */ `deviceWarrantyCard.status.${cfg.label}`)}
          </span>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? t('deviceWarrantyCard.checking') : t('common:actions.refresh')}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">{t('deviceWarrantyCard.manufacturer')}</p>
          <p className="text-sm font-medium">{warranty.manufacturer?.toUpperCase() ?? '\u2014'}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t('deviceWarrantyCard.serialNumber')}</p>
          <p className="text-sm font-medium font-mono">{warranty.serialNumber ?? '\u2014'}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t('deviceWarrantyCard.startDate')}</p>
          <p className="text-sm font-medium">{formatDate(warranty.warrantyStartDate)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{isSubscription ? t('deviceWarrantyCard.renews') : t('deviceWarrantyCard.endDate')}</p>
          <p className="text-sm font-medium">{formatDate(warranty.warrantyEndDate)}</p>
        </div>
      </div>

      {warranty.entitlements && warranty.entitlements.length > 0 && (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">{t('deviceWarrantyCard.table.serviceLevel')}</th>
                <th className="px-4 py-2">{t('deviceWarrantyCard.table.type')}</th>
                <th className="px-4 py-2">{t('deviceWarrantyCard.table.startDate')}</th>
                <th className="px-4 py-2">{t('deviceWarrantyCard.table.endDate')}</th>
              </tr>
            </thead>
            <tbody>
              {warranty.entitlements.map((e, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="px-4 py-2">{e.serviceLevelDescription}</td>
                  <td className="px-4 py-2">{e.entitlementType}</td>
                  <td className="px-4 py-2">{formatDate(e.startDate)}</td>
                  <td className="px-4 py-2">{formatDate(e.endDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span>{t('deviceWarrantyCard.lastChecked', { time: timeAgo(warranty.lastSyncAt) })}</span>
        {warranty.dataSource && (
          <span>{t('deviceWarrantyCard.source', { source: dataSourceLabel(warranty.dataSource) })}</span>
        )}
        {/* Legacy: pre-v0.13.9 syncs stored "No configured provider..." as lastSyncError.
            Post-v0.13.9, lastSyncError is null for no-provider cases. Remove after re-sync cycle. */}
        {warranty.lastSyncError && (
          warranty.lastSyncError.includes('No configured provider')
            ? <span className="text-muted-foreground">{t('deviceWarrantyCard.lookupUnavailable')}</span>
            : <span className="text-red-500">{t('deviceWarrantyCard.error', { error: warranty.lastSyncError })}</span>
        )}
      </div>
    </div>
  );
}
