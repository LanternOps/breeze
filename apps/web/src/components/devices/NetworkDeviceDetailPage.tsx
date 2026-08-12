import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHashState } from '@/lib/useHashState';
import { ArrowLeft, Globe, ExternalLink, Wifi, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { isManualLink } from '../discovery/networkTypes';
import { extractApiError } from '../../lib/apiError';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import Breadcrumbs from '../layout/Breadcrumbs';
import { formatNumber } from '@/lib/i18n/format';
import { asList } from '@/lib/asList';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { buildRemoteProxyPageUrl } from '@/lib/remoteTunnelUrls';
import {
  mapAsset,
  typeConfig,
  approvalStatusConfig,
  type ApiDiscoveryAsset,
  type DiscoveredAsset,
  type DiscoveredAssetType,
} from '../discovery/DiscoveredAssetList';

type NetworkDeviceDetailPageProps = {
  assetId: string;
};

// Extra fields the single-asset endpoint (`GET /discovery/assets/:id`) returns
// on top of what `mapAsset` normalizes for the list. Kept local so we read the
// monitoring/identity extras without forking the shared mapper.
type AssetDetailExtras = {
  model?: string | null;
  netbiosName?: string | null;
  siteId?: string | null;
  firstSeenAt?: string | null;
  snmpMonitoringEnabled?: boolean;
  networkMonitoringEnabled?: boolean;
  // The agent device that ran this asset's last discovery scan (or null).
  // This is the proxy bridge default — deliberately separate from
  // `linkedDeviceId`, which is an identity link and would be a loopback if
  // used to bridge a proxy connection to the asset it IS.
  suggestedBridgeDeviceId?: string | null;
  // Set by a manual unlink (#3261 Task 2); cleared by any manual link. Only
  // meaningful while unlinked — explains why auto-linking hasn't re-found
  // this asset instead of leaving "Not linked" unexplained.
  autoLinkSuppressedAt?: string | null;
};

type DeviceOption = { id: string; name: string; online: boolean };

// Ports/services that plausibly serve a browsable web UI. Mirrors the design
// spec's list (Architecture D.1): common HTTP(S) ports plus anything whose
// discovered service name looks like http/https.
const WEB_PORTS = new Set([80, 443, 8080, 8443, 8006, 9443]);

function isWebPort(port: number, service?: string): boolean {
  if (WEB_PORTS.has(port)) return true;
  return !!service && /https?/i.test(service);
}

function defaultSchemeForPort(port: number, service?: string): 'http' | 'https' {
  if (port === 443 || port === 8443 || port === 9443) return 'https';
  if (service && /https/i.test(service)) return 'https';
  return 'http';
}

// Friendly labels for the scalar SNMP system OIDs the discovery scan collects.
const SNMP_FIELD_LABELS: Record<string, string> = {
  sysName: 'System Name',
  sysDescr: 'Description',
  sysObjectId: 'Object ID',
};

function snmpFieldLabel(key: string): string {
  return SNMP_FIELD_LABELS[key] ?? key;
}

function formatPing(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1) return '<1 ms';
  return `${formatNumber(ms, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`;
}

function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date);
}

const VALID_TABS = ['overview', 'monitoring'] as const;
type Tab = (typeof VALID_TABS)[number];

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-4" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{value ?? '—'}</dd>
    </div>
  );
}

// Per-port "Open Web UI" popover: pick a bridge agent, scheme, and optional
// self-signed allowance, then POST /tunnels/proxy-connect and open the result
// in a new tab. Bridge default is `suggestedBridgeDeviceId` (the discovering
// agent) — NEVER `linkedDeviceId` (identity link), which would be a loopback.
function ProxyConnectPopover({
  assetId,
  assetIp,
  port,
  service,
  suggestedBridgeDeviceId,
  devices,
}: {
  assetId: string;
  assetIp: string;
  port: number;
  service?: string;
  suggestedBridgeDeviceId: string | null;
  devices: DeviceOption[];
}) {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useClickOutside(open, containerRef, () => setOpen(false));
  useEscapeClose(open, () => setOpen(false));

  const onlineDevices = useMemo(() => devices.filter((d) => d.online), [devices]);

  // Prefer the discovering agent when it's online; else the first online
  // device (same fallback the old AssetDetailModal proxy section used).
  const defaultDeviceId = useMemo(() => {
    if (suggestedBridgeDeviceId && onlineDevices.some((d) => d.id === suggestedBridgeDeviceId)) {
      return suggestedBridgeDeviceId;
    }
    return onlineDevices[0]?.id ?? '';
  }, [suggestedBridgeDeviceId, onlineDevices]);

  const [deviceId, setDeviceId] = useState(defaultDeviceId);
  // The device list loads async after mount, so the real default often
  // arrives after this component's initial render — sync once it does.
  useEffect(() => {
    setDeviceId(defaultDeviceId);
  }, [defaultDeviceId]);

  const [scheme, setScheme] = useState<'http' | 'https'>(() => defaultSchemeForPort(port, service));
  const [skipTlsVerify, setSkipTlsVerify] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [inlineError, setInlineError] = useState<string>();

  const handleConnect = useCallback(async () => {
    if (!deviceId) return;
    setConnecting(true);
    setInlineError(undefined);
    try {
      const data = await runAction<{ tunnel: { id: string } }>({
        request: () =>
          fetchWithAuth('/tunnels/proxy-connect', {
            method: 'POST',
            body: JSON.stringify({
              deviceId,
              discoveredAssetId: assetId,
              port,
              scheme,
              skipTlsVerify: scheme === 'https' ? skipTlsVerify : false,
            }),
          }),
        errorFallback: t('networkDeviceDetailPage.toasts.proxyConnectFailed'),
        friendly: (code) => {
          if (code === 'PROXY_TARGET_DISABLED') return t('networkDeviceDetailPage.proxyErrors.disabled');
          if (code === 'MFA_REQUIRED') return t('networkDeviceDetailPage.proxyErrors.mfaRequired');
          return undefined;
        },
      });
      setOpen(false);
      window.open(buildRemoteProxyPageUrl(data.tunnel.id, `${assetIp}:${port}`, assetId), '_blank');
    } catch (err) {
      // runAction already toasted a generic/friendly message; surface an
      // inline message too for the two codes that need a clear, sticky
      // explanation right next to the control that caused them.
      if (err instanceof ActionError && err.code === 'PROXY_TARGET_DISABLED') {
        setInlineError(t('networkDeviceDetailPage.proxyErrors.disabled'));
      } else if (err instanceof ActionError && err.code === 'MFA_REQUIRED') {
        setInlineError(t('networkDeviceDetailPage.proxyErrors.mfaRequired'));
      }
    } finally {
      setConnecting(false);
    }
  }, [deviceId, assetId, assetIp, port, scheme, skipTlsVerify, t]);

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        type="button"
        data-testid={`network-detail-port-proxy-${port}`}
        aria-label={t('networkDeviceDetailPage.openWebUi')}
        title={t('networkDeviceDetailPage.openWebUi')}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center text-muted-foreground hover:text-foreground"
      >
        <ExternalLink className="h-3 w-3" />
      </button>

      {open && (
        <div
          className="absolute left-0 top-6 z-30 w-72 rounded-md border bg-popover p-3 text-left shadow-lg"
          role="dialog"
          data-testid={`network-detail-proxy-popover-${port}`}
        >
          <div className="mb-2 text-sm font-semibold">
            {t('discovery:proxyConnect.title', { target: `${assetIp}:${port}` })}
          </div>

          {onlineDevices.length === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('networkDeviceDetailPage.proxyErrors.noOnlineAgent', { ip: assetIp })}
            </p>
          ) : (
            <div className="space-y-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  {t('discovery:proxyConnect.throughAgent')}
                </label>
                <select
                  data-testid="proxy-popover-bridge-select"
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  {onlineDevices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              <select
                data-testid="proxy-popover-scheme-select"
                value={scheme}
                onChange={(e) => {
                  const next = e.target.value as 'http' | 'https';
                  setScheme(next);
                  if (next !== 'https') setSkipTlsVerify(false);
                }}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </select>

              {scheme === 'https' && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={skipTlsVerify}
                    onChange={(e) => setSkipTlsVerify(e.target.checked)}
                    data-testid="proxy-popover-allow-self-signed"
                  />
                  {t('discovery:proxyConnect.allowSelfSigned')}
                </label>
              )}

              <button
                type="button"
                data-testid="proxy-popover-connect"
                onClick={() => void handleConnect()}
                disabled={connecting || !deviceId}
                className="mt-1 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70"
              >
                {connecting ? t('networkDeviceDetailPage.connecting') : t('discovery:proxyConnect.connect')}
              </button>
            </div>
          )}

          {inlineError && (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {inlineError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// The one manual-override control this surface adds beyond Unlink: for the
// case auto-link can't handle (cross-subnet discovery — no MAC visible, IPs
// don't match), let a human assert the identity link directly. Site-scoped
// on purpose: the link route requires same-org AND same-site
// (discovery.ts:1458-1464), so an unscoped device list would offer choices
// guaranteed to 403.
function LinkManuallyControl({
  assetId,
  siteId,
  onLinked,
}: {
  assetId: string;
  siteId: string | null;
  onLinked: () => void | Promise<void>;
}) {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string>();

  const openPicker = useCallback(async () => {
    setOpen(true);
    setError(undefined);
    if (!siteId) {
      setError(t('networkDeviceDetailPage.linkManuallyErrors.noSite'));
      return;
    }
    setLoadingDevices(true);
    try {
      const response = await fetchWithAuth(`/devices?siteId=${encodeURIComponent(siteId)}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(extractApiError(body, t('networkDeviceDetailPage.linkManuallyErrors.loadDevices')));
        return;
      }
      const data = await response.json();
      const raw: any[] = asList(data, 'devices');
      setDevices(
        raw.map((d: any) => ({
          id: d.id,
          name: d.displayName || d.hostname || d.id,
          online: d.status === 'online',
        })),
      );
    } catch {
      setError(t('networkDeviceDetailPage.linkManuallyErrors.loadDevices'));
    } finally {
      setLoadingDevices(false);
    }
  }, [siteId, t]);

  const handleLink = useCallback(async () => {
    if (!deviceId) return;
    setLinking(true);
    setError(undefined);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/discovery/assets/${assetId}/link`, {
            method: 'POST',
            body: JSON.stringify({ deviceId }),
          }),
        successMessage: t('networkDeviceDetailPage.toasts.linked'),
        errorFallback: t('networkDeviceDetailPage.toasts.linkFailed'),
      });
      setOpen(false);
      setDeviceId('');
      await onLinked();
    } catch (err) {
      // runAction's message is already extractApiError's output — reuse it
      // for the inline error instead of a second, possibly different string.
      setError(err instanceof ActionError ? err.message : t('networkDeviceDetailPage.toasts.linkFailed'));
    } finally {
      setLinking(false);
    }
  }, [deviceId, assetId, onLinked, t]);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="network-detail-link-manually"
        onClick={() => void openPicker()}
        className="text-xs text-primary hover:underline"
      >
        {t('networkDeviceDetailPage.linkManually')}
      </button>
    );
  }

  return (
    <div className="mt-1 space-y-2 rounded-md border bg-background p-3" data-testid="network-detail-link-manually-picker">
      {loadingDevices ? (
        <p className="text-xs text-muted-foreground">{t('common:states.loading')}</p>
      ) : devices.length === 0 && !error ? (
        <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.linkManuallyErrors.noDevices')}</p>
      ) : (
        <select
          data-testid="network-detail-link-manually-select"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          className="h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="">{t('networkDeviceDetailPage.linkManuallySelectDevice')}</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="network-detail-link-manually-submit"
          onClick={() => void handleLink()}
          disabled={linking || !deviceId}
          className="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {linking ? t('networkDeviceDetailPage.linkManuallyLinking') : t('common:actions.save')}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(undefined); }}
          disabled={linking}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {t('common:actions.cancel')}
        </button>
      </div>
      {error && (
        <p className="text-xs text-destructive" data-testid="network-detail-link-manually-error">
          {error}
        </p>
      )}
    </div>
  );
}

export default function NetworkDeviceDetailPage({ assetId }: NetworkDeviceDetailPageProps) {
  const { t } = useTranslation('devices');
  const [asset, setAsset] = useState<DiscoveredAsset | null>(null);
  const [extras, setExtras] = useState<AssetDetailExtras>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Hash-derived tab adopted post-mount to avoid an SSR hydration mismatch
  // (#2421); the hook also syncs back/forward via hashchange.
  const [activeTab, setActiveTab] = useHashState<Tab>('overview', (h) => {
    const seg = h.split('/')[0] ?? '';
    return (VALID_TABS as readonly string[]).includes(seg) ? (seg as Tab) : undefined;
  });

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  const fetchAsset = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth(`/discovery/assets/${assetId}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(t('networkDeviceDetailPage.errors.notFound'));
        }
        throw new Error(t('networkDeviceDetailPage.errors.load'));
      }

      const body = await response.json();
      const raw: (ApiDiscoveryAsset & AssetDetailExtras) | undefined =
        body?.data ?? body?.asset ?? body;
      // A 200 with an empty/wrong-shaped body would otherwise sail through
      // `mapAsset` (which never returns null) and render a blank "—" shell with
      // an `asset=undefined` deep-link. Treat a missing id as a load failure.
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') {
        throw new Error(t('networkDeviceDetailPage.errors.malformed'));
      }
      setAsset(mapAsset(raw));
      setExtras({
        model: raw.model ?? null,
        netbiosName: raw.netbiosName ?? null,
        siteId: raw.siteId ?? null,
        firstSeenAt: raw.firstSeenAt ?? null,
        snmpMonitoringEnabled: raw.snmpMonitoringEnabled ?? false,
        networkMonitoringEnabled: raw.networkMonitoringEnabled ?? false,
        suggestedBridgeDeviceId: (raw as AssetDetailExtras).suggestedBridgeDeviceId ?? null,
        autoLinkSuppressedAt: (raw as AssetDetailExtras).autoLinkSuppressedAt ?? null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('networkDeviceDetailPage.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [assetId, t]);

  useEffect(() => {
    void fetchAsset();
  }, [fetchAsset]);

  // Device list for the proxy "through agent" picker. Same call shape as
  // DiscoveredAssetList's equivalent fetch for AssetDetailModal's (now
  // removed) bridge picker: unscoped `/devices`, online filtered client-side.
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/devices');
      if (!response.ok) return;
      const data = await response.json();
      const raw: any[] = asList(data, 'devices');
      setDevices(
        raw.map((d: any) => ({
          id: d.id,
          name: d.displayName || d.hostname || d.id,
          online: d.status === 'online',
        })),
      );
    } catch {
      // Best-effort — the popover's bridge picker just shows no online agent.
    }
  }, []);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  const handleBack = () => {
    void navigateTo('/devices');
  };

  const [unlinking, setUnlinking] = useState(false);
  const [typeSaving, setTypeSaving] = useState(false);

  // Unlink now works for both auto and manual links (#3261 Task 2 reverses the
  // old manual-only rule — the server sets auto_link_suppressed_at so a
  // subsequent rescan doesn't just re-create the link). This handler only
  // guards that a link exists; runAction surfaces success/failure via toast.
  const handleUnlink = useCallback(async () => {
    if (!asset?.linkedDeviceId) return;
    if (typeof window !== 'undefined' && !window.confirm(t('networkDeviceDetailPage.confirmUnlink'))) return;
    setUnlinking(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/assets/${asset.id}/link`, { method: 'DELETE' }),
        successMessage: t('networkDeviceDetailPage.toasts.unlinked'),
        errorFallback: t('networkDeviceDetailPage.toasts.unlinkFailed'),
      });
      await fetchAsset();
    } catch {
      // runAction already toasted the failure; leave the linked state in place.
    } finally {
      setUnlinking(false);
    }
  }, [asset, fetchAsset, t]);

  // Manual override of the scan-detected device type. `reset` restores the
  // auto-detected classification; any other value pins the type as a manual
  // override (server stamps type_source='manual'). runAction surfaces the
  // outcome via toast; we refetch on success so the badge/select reflect the
  // server's canonical state.
  const changeType = useCallback(
    async (next: DiscoveredAssetType | 'reset') => {
      if (!asset) return;
      setTypeSaving(true);
      try {
        await runAction({
          request: () =>
            fetchWithAuth(`/discovery/assets/${asset.id}`, {
              method: 'PATCH',
              body: JSON.stringify(
                next === 'reset' ? { resetTypeToAuto: true } : { assetType: next },
              ),
            }),
          successMessage: next === 'reset'
            ? t('networkDeviceDetailPage.toasts.typeReset')
            : t('networkDeviceDetailPage.toasts.typeUpdated'),
          errorFallback:
            next === 'reset'
              ? t('networkDeviceDetailPage.toasts.typeResetFailed')
              : t('networkDeviceDetailPage.toasts.typeUpdateFailed'),
        });
        await fetchAsset();
      } catch {
        // runAction already toasted the failure; leave the current type in place.
      } finally {
        setTypeSaving(false);
      }
    },
    [asset, fetchAsset, t],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="network-device-detail-loading">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('networkDeviceDetailPage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error || !asset) {
    return (
      <div className="space-y-6" data-testid="network-device-detail-error">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('networkDeviceDetailPage.backToDevices')}
        </button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || t('networkDeviceDetailPage.errors.notFound')}</p>
          <button
            type="button"
            onClick={handleBack}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('networkDeviceDetailPage.goBack')}
          </button>
        </div>
      </div>
    );
  }

  const displayName = asset.label || asset.hostname || asset.ip;
  const openPorts = asset.openPorts ?? [];
  const snmpData = asset.snmpData ?? {};
  const tags = asset.tags ?? [];
  const discoveryMethods = asset.discoveryMethods ?? [];
  // `mapAsset` normalizes `type` to a valid key, but `approvalStatus` is passed
  // through raw — guard both lookups so an out-of-enum value from the API can't
  // throw during render (which, with no error boundary, would blank the page).
  const typeMeta = typeConfig[asset.type];
  const approvalMeta = approvalStatusConfig[asset.approvalStatus];
  const typeLabel = typeMeta ? t(/* i18n-dynamic */ typeMeta.labelKey) : asset.type;
  const approvalLabel = approvalMeta ? t(/* i18n-dynamic */ approvalMeta.labelKey) : asset.approvalStatus;

  return (
    <div className="space-y-6" data-testid="network-device-detail">
      <Breadcrumbs items={[
        { label: t('devicesPage.title'), href: '/devices' },
        { label: displayName || t('networkDeviceDetailPage.networkDevice') },
      ]} />

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-md border bg-muted/40 p-2 text-muted-foreground">
            <Globe className="h-6 w-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold" data-testid="network-device-name">{displayName}</h1>
              <span
                data-testid="network-asset-type"
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeMeta?.color ?? typeConfig.unknown.color}`}
              >
                {typeLabel}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${approvalMeta?.color ?? approvalStatusConfig.dismissed.color}`}
              >
                {approvalLabel}
              </span>
              <span
                data-testid="network-device-status"
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                  asset.isOnline
                    ? 'bg-success/15 text-success border-success/30'
                    : 'bg-muted text-muted-foreground border-muted'
                }`}
              >
                {asset.isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {asset.ip}
              {asset.mac !== '—' && <> • {asset.mac}</>}
              {asset.manufacturer !== '—' && <> • {asset.manufacturer}</>}
              {asset.lastSeen && <> • {t('networkDeviceDetailPage.lastSeen', { time: formatTimestamp(asset.lastSeen) })}</>}
            </p>
          </div>
        </div>
        {/* Approve / reclassify remain in Discovery until slice 3 of #1424
            brings them inline; unlink for manual links is available inline on
            the Monitoring tab. Other actions link out for now. */}
        <a
          href={`/discovery?asset=${asset.id}#assets`}
          data-testid="network-detail-manage-discovery"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          {t('networkDeviceDetailPage.manageInDiscovery')}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {VALID_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            data-testid={`network-detail-tab-${tab}`}
            onClick={() => switchTab(tab)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${
              activeTab === tab
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(/* i18n-dynamic */ `networkDeviceDetailPage.tabs.${tab}`)}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="network-detail-overview">
          <div className="space-y-5">
            <Section title={t('networkDeviceDetailPage.sections.identity')}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label={t('networkDeviceDetailPage.fields.hostname')} value={asset.hostname || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.displayName')} value={asset.label || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.ipAddress')} value={<span className="font-mono">{asset.ip}</span>} />
                <Field label={t('networkDeviceDetailPage.fields.macAddress')} value={<span className="font-mono">{asset.mac}</span>} />
                <Field label={t('networkDeviceDetailPage.fields.manufacturer')} value={asset.manufacturer} />
                <Field label={t('networkDeviceDetailPage.fields.model')} value={extras.model || '—'} />
                <div>
                  <div className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.assetType')}</div>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="network-asset-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm disabled:opacity-60"
                      value={asset.type}
                      disabled={typeSaving}
                      onChange={(e) => void changeType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((type) => (
                        <option key={type} value={type}>{t(/* i18n-dynamic */ typeConfig[type].labelKey)}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="network-asset-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-60"
                        disabled={typeSaving}
                        onClick={() => void changeType('reset')}
                      >
                        {t('networkDeviceDetailPage.resetToAutoDetected')}
                      </button>
                    )}
                  </div>
                  {asset.typeSource === 'manual' && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {asset.detectedType
                        ? t('networkDeviceDetailPage.manuallySetWithDetected', { type: t(/* i18n-dynamic */ typeConfig[asset.detectedType].labelKey) })
                        : t('networkDeviceDetailPage.manuallySet')}
                    </p>
                  )}
                </div>
                {extras.netbiosName && <Field label={t('networkDeviceDetailPage.fields.netbiosName')} value={extras.netbiosName} />}
              </dl>
              {tags.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.tags')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <span key={tag} className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {asset.notes && (
                <div className="mt-3 border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground">{t('networkDeviceDetailPage.fields.notes')}</p>
                  <p className="mt-1 text-sm whitespace-pre-wrap">{asset.notes}</p>
                </div>
              )}
            </Section>

            <Section title={t('networkDeviceDetailPage.sections.snmpData')} testId="network-detail-snmp">
              <dl className="space-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {t('networkDeviceDetailPage.emptySnmp')}
                  </div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">{snmpFieldLabel(key)}</dt>
                      <dd className="font-medium text-right break-all">{value}</dd>
                    </div>
                  ))
                )}
              </dl>
            </Section>
          </div>

          <div className="space-y-5">
            <Section title={t('networkDeviceDetailPage.sections.networkReachability')}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label={t('networkDeviceDetailPage.fields.status')} value={asset.isOnline ? t('common:states.online') : t('common:states.offline')} />
                <Field
                  label={t('networkDeviceDetailPage.fields.ping')}
                  value={<span className="font-mono" data-testid="network-detail-ping">{formatPing(asset.responseTimeMs)}</span>}
                />
                <Field label={t('networkDeviceDetailPage.fields.osFingerprint')} value={asset.osFingerprint || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.lastSeen')} value={formatTimestamp(asset.lastSeen)} />
                <Field label={t('networkDeviceDetailPage.fields.firstSeen')} value={formatTimestamp(extras.firstSeenAt)} />
              </dl>
            </Section>

            <Section title={t('networkDeviceDetailPage.sections.openPorts')} testId="network-detail-ports">
              {openPorts.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.emptyPorts')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {openPorts.map((p) => (
                    <span
                      key={p.port}
                      className="inline-flex items-center gap-1 rounded-full border border-muted bg-background px-2 py-0.5 text-xs"
                    >
                      {p.port}{p.service ? ` (${p.service})` : ''}
                      {isWebPort(p.port, p.service) && (
                        <ProxyConnectPopover
                          assetId={asset.id}
                          assetIp={asset.ip}
                          port={p.port}
                          service={p.service}
                          suggestedBridgeDeviceId={extras.suggestedBridgeDeviceId ?? null}
                          devices={devices}
                        />
                      )}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </div>
      )}

      {activeTab === 'monitoring' && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="network-detail-monitoring">
          <Section title={t('networkDeviceDetailPage.sections.monitoringStatus')}>
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{t('networkDeviceDetailPage.fields.snmpMonitoring')}</dt>
                <dd className="font-medium">{extras.snmpMonitoringEnabled ? t('common:states.enabled') : t('networkDeviceDetailPage.notConfigured')}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{t('networkDeviceDetailPage.fields.networkMonitoring')}</dt>
                <dd className="font-medium">{extras.networkMonitoringEnabled ? t('common:states.enabled') : t('networkDeviceDetailPage.notConfigured')}</dd>
              </div>
            </dl>
            <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              {t('networkDeviceDetailPage.configurePrefix')}{' '}
              <a href={`/discovery?asset=${asset.id}#assets`} className="text-primary hover:underline">
                {t('networkDeviceDetailPage.discoveryAssetView')}
              </a>
              .
            </p>
          </Section>

          <Section title={t('networkDeviceDetailPage.sections.discovery')}>
            <dl className="grid grid-cols-1 gap-y-3 text-sm">
              <Field
                label={t('networkDeviceDetailPage.fields.linkedDevice')}
                value={
                  asset.linkedDeviceId ? (
                    <span className="flex flex-wrap items-center gap-3">
                      <a
                        href={`/devices/${asset.linkedDeviceId}`}
                        data-testid="network-detail-linked-device"
                        className="text-primary hover:underline"
                      >
                        {t('networkDeviceDetailPage.sameDeviceAs', {
                          name: asset.linkedDeviceName || t('common:states.unknown'),
                        })}
                      </a>
                      <span className="text-xs text-muted-foreground" data-testid="network-detail-link-provenance">
                        {isManualLink(asset.linkSource)
                          ? t('networkDeviceDetailPage.provenance.manual')
                          : t('networkDeviceDetailPage.provenance.auto')}
                      </span>
                      <button
                        type="button"
                        data-testid="network-detail-unlink"
                        onClick={handleUnlink}
                        disabled={unlinking}
                        className="text-xs text-destructive hover:underline disabled:opacity-50"
                      >
                        {unlinking ? t('networkDeviceDetailPage.unlinking') : t('networkDeviceDetailPage.unlink')}
                      </button>
                    </span>
                  ) : (
                    <div className="space-y-1.5">
                      <p>{t('networkDeviceDetailPage.notLinked')}</p>
                      {extras.autoLinkSuppressedAt && (
                        <p className="text-xs text-muted-foreground" data-testid="network-detail-suppressed">
                          {t('networkDeviceDetailPage.autoLinkSuppressed')}
                        </p>
                      )}
                      <LinkManuallyControl
                        assetId={asset.id}
                        siteId={extras.siteId ?? null}
                        onLinked={fetchAsset}
                      />
                    </div>
                  )
                }
              />
              <Field
                label={t('networkDeviceDetailPage.fields.discoveryMethods')}
                value={discoveryMethods.length > 0 ? discoveryMethods.join(', ') : '—'}
              />
              <Field label={t('networkDeviceDetailPage.fields.discoveryProfile')} value={asset.profileName || '—'} />
            </dl>
          </Section>
        </div>
      )}
    </div>
  );
}
