import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHashState } from '@/lib/useHashState';
import {
  ArrowLeft,
  Globe,
  ExternalLink,
  ChevronRight,
  Wifi,
  WifiOff,
  Activity,
  Gauge,
  Clock,
  Link2,
  LayoutGrid,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { isManualLink } from '../discovery/networkTypes';
import { extractApiError } from '../../lib/apiError';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatLastSeen } from '@/lib/formatTime';
import Breadcrumbs from '../layout/Breadcrumbs';
import { asList } from '@/lib/asList';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { buildRemoteProxyPageUrl } from '@/lib/remoteTunnelUrls';
import { OverflowTabs, type OverflowTab } from '../shared/OverflowTabs';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import HelpTooltip from '../shared/HelpTooltip';
import { formatPing, pingColor } from '../discovery/pingFormat';
import { assetTypeIcons } from '../discovery/assetTypeIcon';
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

// A wide scan can turn up dozens of open ports; cap the chip grid at this
// many before it dominates the section, behind a "Show all" toggle.
const PORTS_VISIBLE_LIMIT = 12;

function isWebPort(port: number, service?: string): boolean {
  if (WEB_PORTS.has(port)) return true;
  return !!service && /https?/i.test(service);
}

function defaultSchemeForPort(port: number, service?: string): 'http' | 'https' {
  if (port === 443 || port === 8443 || port === 9443) return 'https';
  if (service && /https/i.test(service)) return 'https';
  return 'http';
}

// Translation keys for the scalar SNMP system OIDs the discovery scan
// collects. Values live in locale under `networkDeviceDetailPage.snmpFields`;
// an unrecognized key (a vendor-specific OID the UI doesn't have a friendly
// name for) falls back to the raw key rather than a translation lookup.
const SNMP_FIELD_LABEL_KEYS: Record<string, string> = {
  sysName: 'networkDeviceDetailPage.snmpFields.sysName',
  sysDescr: 'networkDeviceDetailPage.snmpFields.sysDescr',
  sysObjectId: 'networkDeviceDetailPage.snmpFields.sysObjectId',
};

function snmpFieldLabel(key: string, t: (key: string) => string): string {
  const labelKey = SNMP_FIELD_LABEL_KEYS[key];
  return labelKey ? t(/* i18n-dynamic */ labelKey) : key;
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
    <div className="rounded-md border bg-card p-4" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  // A whitespace-only string is functionally empty but is not `null`/`undefined`,
  // so the `??` fallback below never catches it — it used to render as a blank cell.
  const isBlank = typeof value === 'string' && value.trim() === '';
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{isBlank ? '—' : (value ?? '—')}</dd>
    </div>
  );
}

// Values longer than this are clamped behind a "Show more" toggle so one
// oversized SNMP field (a chatty sysDescr) can't push every other field off
// screen or blow out the row's layout.
const SNMP_VALUE_CLAMP_LENGTH = 200;

function SnmpValue({ fieldKey, value }: { fieldKey: string; value: string }) {
  const { t } = useTranslation('devices');
  const [expanded, setExpanded] = useState(false);
  const isLong = value.length > SNMP_VALUE_CLAMP_LENGTH;
  const displayValue = isLong && !expanded ? `${value.slice(0, SNMP_VALUE_CLAMP_LENGTH)}…` : value;
  return (
    <dd className="font-medium break-words">
      {displayValue || '—'}
      {isLong && (
        <button
          type="button"
          data-testid={`snmp-value-toggle-${fieldKey}`}
          onClick={() => setExpanded((e) => !e)}
          className="ml-1.5 text-xs text-primary hover:underline"
        >
          {expanded ? t('networkDeviceDetailPage.showLess') : t('networkDeviceDetailPage.showMore')}
        </button>
      )}
    </dd>
  );
}

// Per-port "Open Web UI" popover: pick a bridge agent, scheme, and optional
// self-signed allowance, then POST /tunnels/proxy-connect and open the result
// in a new tab. Bridge default is `suggestedBridgeDeviceId` (the discovering
// agent) — NEVER `linkedDeviceId` (identity link), which would be a loopback.
function ProxyConnectPopover({
  assetId,
  assetIp,
  port: initialPort,
  service,
  suggestedBridgeDeviceId,
  devices,
  devicesError,
  onRetryDevices,
  variant = 'pill',
}: {
  assetId: string;
  assetIp: string;
  port: number;
  service?: string;
  suggestedBridgeDeviceId: string | null;
  devices: DeviceOption[];
  // True when the most recent bridge-device fetch failed — distinct from a
  // successful fetch that just found zero online agents, so the popover can
  // tell an operator to retry instead of implying no agent will ever work.
  devicesError: boolean;
  onRetryDevices: () => void;
  // 'pill' — icon-only trigger on an open-port chip, port fixed.
  // 'header' — labeled page-level action, port editable. This is the entry
  // point that survives when the scan recorded no (web) ports at all.
  variant?: 'pill' | 'header';
}) {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState(initialPort);
  const [portText, setPortText] = useState(String(initialPort));
  useEffect(() => {
    setPort(initialPort);
    setPortText(String(initialPort));
  }, [initialPort]);
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

  // A suggested bridge that isn't in the online list (still loading, or
  // truly offline) leaves the select on an arbitrary first entry — never
  // silent about it when there's more than one candidate to guess wrong
  // between (a single candidate has no real ambiguity to flag).
  const suggestedFound =
    !!suggestedBridgeDeviceId && onlineDevices.some((d) => d.id === suggestedBridgeDeviceId);
  const showBridgeHint = !suggestedFound && onlineDevices.length > 1;
  // A plain <select> gets unwieldy past a handful of agents; swap in a
  // searchable input+datalist combobox once there are enough candidates
  // that scanning the list stops being the fast path.
  const useBridgeCombobox = onlineDevices.length > 8;

  const labelFor = useCallback(
    (d: DeviceOption) =>
      d.id === suggestedBridgeDeviceId
        ? `${d.name} (${t('discovery:proxyConnect.discoveredThisAsset')})`
        : d.name,
    [suggestedBridgeDeviceId, t],
  );

  // The combobox's <input> shows a label, but the value we act on is the id
  // — keep them in sync whenever the selected device changes (including the
  // default arriving async, same as the plain-select `deviceId` sync above).
  const [bridgeSearchText, setBridgeSearchText] = useState('');
  useEffect(() => {
    const selected = onlineDevices.find((d) => d.id === deviceId);
    setBridgeSearchText(selected ? labelFor(selected) : '');
  }, [deviceId, onlineDevices, labelFor]);

  const [scheme, setScheme] = useState<'http' | 'https'>(() => defaultSchemeForPort(port, service));
  useEffect(() => {
    // The scanned service label only describes the scanned port; once the
    // operator types a different port, derive the scheme from the number alone.
    setScheme(defaultSchemeForPort(port, port === initialPort ? service : undefined));
  }, [port, initialPort, service]);
  const [skipTlsVerify, setSkipTlsVerify] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [inlineError, setInlineError] = useState<string>();

  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;

  const handleConnect = useCallback(async () => {
    if (!deviceId || !portValid) return;
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
  }, [deviceId, assetId, assetIp, port, portValid, scheme, skipTlsVerify, t]);

  return (
    <div className="relative inline-block" ref={containerRef}>
      {variant === 'header' ? (
        <button
          type="button"
          data-testid="network-detail-open-web-ui"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <Globe className="h-3.5 w-3.5" />
          {t('networkDeviceDetailPage.openWebUi')}
        </button>
      ) : (
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
      )}

      {open && (
        <div
          className={`absolute top-full z-30 mt-1 w-72 rounded-md border bg-popover p-3 text-left shadow-lg ${
            variant === 'header' ? 'right-0' : 'left-0'
          }`}
          role="dialog"
          data-testid={variant === 'header' ? 'network-detail-proxy-popover' : `network-detail-proxy-popover-${port}`}
        >
          <div className="mb-2 text-sm font-semibold">
            {t('discovery:proxyConnect.title', { target: `${assetIp}:${portValid ? port : '…'}` })}
          </div>

          {variant === 'header' && (
            <div className="mb-2">
              <label htmlFor={`proxy-port-${assetId}`} className="text-xs font-medium text-muted-foreground">
                {t('networkDeviceDetailPage.proxyPort')}
              </label>
              <input
                id={`proxy-port-${assetId}`}
                type="number"
                min={1}
                max={65535}
                inputMode="numeric"
                data-testid="proxy-popover-port"
                value={portText}
                aria-invalid={!portValid}
                aria-describedby={portValid ? undefined : `proxy-port-error-${assetId}`}
                onChange={(e) => {
                  setPortText(e.target.value);
                  setPort(Number(e.target.value));
                }}
                className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs font-mono focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              {!portValid && (
                <p id={`proxy-port-error-${assetId}`} className="mt-1 text-xs text-destructive" data-testid="proxy-popover-port-error">
                  {t('networkDeviceDetailPage.proxyPortInvalid')}
                </p>
              )}
            </div>
          )}

          {devicesError ? (
            <div className="space-y-1.5">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t('networkDeviceDetailPage.proxyErrors.agentListFailed')}
              </p>
              <button
                type="button"
                data-testid="proxy-popover-retry-agents"
                onClick={() => onRetryDevices()}
                className="text-xs text-primary hover:underline"
              >
                {t('common:actions.retry')}
              </button>
            </div>
          ) : onlineDevices.length === 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t('networkDeviceDetailPage.proxyErrors.noOnlineAgent', { ip: assetIp })}
            </p>
          ) : (
            <div className="space-y-2">
              <div>
                <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  {t('discovery:proxyConnect.throughAgent')}
                  <HelpTooltip text={t('discovery:proxyConnect.throughAgentHelp')} />
                </label>
                {useBridgeCombobox ? (
                  <>
                    <input
                      list={`proxy-bridge-devices-${assetId}-${variant}-${initialPort}`}
                      data-testid="proxy-popover-bridge-select"
                      value={bridgeSearchText}
                      onChange={(e) => {
                        const text = e.target.value;
                        setBridgeSearchText(text);
                        const match = onlineDevices.find((d) => labelFor(d) === text);
                        if (match) setDeviceId(match.id);
                      }}
                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <datalist id={`proxy-bridge-devices-${assetId}-${variant}-${initialPort}`}>
                      {onlineDevices.map((d) => (
                        <option key={d.id} value={labelFor(d)} />
                      ))}
                    </datalist>
                  </>
                ) : (
                  <select
                    data-testid="proxy-popover-bridge-select"
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {onlineDevices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {labelFor(d)}
                      </option>
                    ))}
                  </select>
                )}
                {showBridgeHint && (
                  <p className="mt-1 text-xs text-muted-foreground" data-testid="proxy-popover-bridge-hint">
                    {t('discovery:proxyConnect.pickAgentHint', { ip: assetIp })}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor={`proxy-scheme-${assetId}-${variant}-${initialPort}`}
                  className="text-xs font-medium text-muted-foreground"
                >
                  {t('discovery:proxyConnect.scheme')}
                </label>
                <select
                  id={`proxy-scheme-${assetId}-${variant}-${initialPort}`}
                  data-testid="proxy-popover-scheme-select"
                  value={scheme}
                  onChange={(e) => {
                    const next = e.target.value as 'http' | 'https';
                    setScheme(next);
                    if (next !== 'https') setSkipTlsVerify(false);
                  }}
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                </select>
              </div>

              {scheme === 'https' && (
                <div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={skipTlsVerify}
                      onChange={(e) => setSkipTlsVerify(e.target.checked)}
                      data-testid="proxy-popover-allow-self-signed"
                    />
                    {t('discovery:proxyConnect.allowSelfSigned')}
                  </label>
                  <p className="ml-6 text-xs text-muted-foreground">
                    {t('discovery:proxyConnect.allowSelfSignedHint')}
                  </p>
                </div>
              )}

              <button
                type="button"
                data-testid="proxy-popover-connect"
                onClick={() => void handleConnect()}
                disabled={connecting || !deviceId || !portValid}
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

  // `background: true` is used for the return-to-tab refresh below: it must
  // not flash the loading skeleton over content the operator is already
  // looking at, and a transient failure shouldn't blow away a working page —
  // so it skips both the loading flag and the error state entirely.
  const fetchAsset = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background ?? false;
    try {
      if (!background) {
        setLoading(true);
        setError(undefined);
      }

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
      if (!background) {
        setError(err instanceof Error ? err.message : t('networkDeviceDetailPage.errors.load'));
      }
    } finally {
      if (!background) setLoading(false);
    }
  }, [assetId, t]);

  useEffect(() => {
    void fetchAsset();
  }, [fetchAsset]);

  // Return-to-tab refresh: a technician who tabs away for a while and comes
  // back is looking at status that may be well out of date. Only refetch
  // after a real away-period (60s+), not a quick alt-tab, and never while
  // still on the initial load (no `asset` yet to refresh in place).
  useEffect(() => {
    let hiddenAt: number | null = null;
    const MIN_HIDDEN_MS = 60_000;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (document.visibilityState === 'visible' && hiddenAt !== null) {
        const hiddenDuration = Date.now() - hiddenAt;
        hiddenAt = null;
        if (hiddenDuration >= MIN_HIDDEN_MS) {
          void fetchAsset({ background: true });
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [fetchAsset]);

  // Device list for the proxy "through agent" picker. Site-scoped to the
  // asset's site when known — same call shape LinkManuallyControl already
  // uses above — so an operator only sees agents that can plausibly bridge
  // to this network, instead of an unscoped list across every site. Falls
  // back to the unscoped list when the asset has no site on record.
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [devicesError, setDevicesError] = useState(false);
  const assetLoaded = asset != null;
  const fetchDevices = useCallback(async () => {
    // The site scope isn't known until the asset has loaded; firing early
    // would always (and silently) fall through to the unscoped branch.
    if (!assetLoaded) return;
    setDevicesError(false);
    try {
      const url = extras.siteId
        ? `/devices?siteId=${encodeURIComponent(extras.siteId)}`
        : '/devices';
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        setDevicesError(true);
        return;
      }
      const data = await response.json();
      const raw: any[] = asList(data, 'devices');
      let list: DeviceOption[] = raw.map((d: any) => ({
        id: d.id,
        name: d.displayName || d.hostname || d.id,
        online: d.status === 'online',
      }));

      // The suggested bridge (the agent that ran the discovery scan) can
      // live outside the asset's site-scoped page of results — never
      // silently drop it, or the default bridge target from #proxy-entry
      // quietly regresses to an arbitrary agent.
      const suggestedId = extras.suggestedBridgeDeviceId;
      if (suggestedId && !list.some((d) => d.id === suggestedId)) {
        try {
          const suggestedResponse = await fetchWithAuth(`/devices/${suggestedId}`);
          if (suggestedResponse.ok) {
            const suggestedRaw = await suggestedResponse.json();
            if (suggestedRaw && typeof suggestedRaw.id === 'string') {
              list = [
                {
                  id: suggestedRaw.id,
                  name: suggestedRaw.displayName || suggestedRaw.hostname || suggestedRaw.id,
                  online: suggestedRaw.status === 'online',
                },
                ...list,
              ];
            }
          }
        } catch {
          // Best-effort — the suggested device just won't appear as an option.
        }
      }

      list.sort((a, b) => {
        if (a.id === suggestedId) return -1;
        if (b.id === suggestedId) return 1;
        return a.name.localeCompare(b.name);
      });

      setDevices(list);
    } catch {
      setDevicesError(true);
    }
  }, [assetLoaded, extras.siteId, extras.suggestedBridgeDeviceId]);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  const handleBack = () => {
    void navigateTo('/devices');
  };

  const [unlinking, setUnlinking] = useState(false);
  const [typeSaving, setTypeSaving] = useState(false);
  const [confirmUnlinkOpen, setConfirmUnlinkOpen] = useState(false);
  const [portsExpanded, setPortsExpanded] = useState(false);

  // Unlink now works for both auto and manual links (#3261 Task 2 reverses the
  // old manual-only rule — the server sets auto_link_suppressed_at so a
  // subsequent rescan doesn't just re-create the link). This handler only
  // guards that a link exists; runAction surfaces success/failure via toast.
  // Confirmation lives in the ConfirmDialog rendered at the bottom of this
  // component — this handler runs only after the user has confirmed.
  const handleUnlink = useCallback(async () => {
    if (!asset?.linkedDeviceId) return;
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
    // Mirrors the real layout below (header card, stat strip, tab bar, two
    // section cards) so the page doesn't jump once data arrives — a centered
    // spinner over an otherwise-empty page reads as broken on a slow load.
    return (
      <div
        className="max-w-6xl space-y-6 animate-pulse motion-reduce:animate-none"
        data-testid="network-device-detail-loading"
      >
        <span className="sr-only">{t('networkDeviceDetailPage.loading')}</span>

        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex items-start gap-4">
            <div className="h-14 w-14 shrink-0 rounded-lg bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="h-5 w-48 rounded bg-muted" />
                <div className="h-5 w-16 rounded-full bg-muted" />
                <div className="h-5 w-16 rounded-full bg-muted" />
              </div>
              <div className="h-4 w-64 rounded bg-muted" />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4 sm:flex-row sm:gap-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex-1 space-y-2">
              <div className="h-3 w-16 rounded bg-muted" />
              <div className="h-5 w-20 rounded bg-muted" />
            </div>
          ))}
        </div>

        <div className="flex gap-2 border-b pb-2">
          <div className="h-8 w-24 rounded bg-muted" />
          <div className="h-8 w-24 rounded bg-muted" />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {[0, 1].map((card) => (
            <div key={card} className="space-y-3 rounded-md border bg-card p-4">
              <div className="h-4 w-24 rounded bg-muted" />
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center justify-between gap-4">
                  <div className="h-3 w-20 rounded bg-muted" />
                  <div className="h-3 w-24 rounded bg-muted" />
                </div>
              ))}
            </div>
          ))}
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
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              data-testid="network-detail-retry"
              onClick={() => void fetchAsset()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t('networkDeviceDetailPage.tryAgain')}
            </button>
            <button
              type="button"
              onClick={handleBack}
              className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {t('networkDeviceDetailPage.goBack')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const displayName = asset.label || asset.hostname || asset.ip;
  const openPorts = asset.openPorts ?? [];
  const visiblePorts = portsExpanded ? openPorts : openPorts.slice(0, PORTS_VISIBLE_LIMIT);
  // Page-level proxy entry point: default to the first scanned web-ish port,
  // else 443 — so the action exists even when the scan recorded no ports.
  const defaultWebPort = openPorts.find((p) => isWebPort(p.port, p.service));
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
  const TypeIcon = assetTypeIcons[asset.type] ?? assetTypeIcons.unknown;

  const tabDefs: OverflowTab[] = [
    { id: 'overview', label: t('networkDeviceDetailPage.tabs.overview'), icon: <LayoutGrid className="h-4 w-4" /> },
    { id: 'monitoring', label: t('networkDeviceDetailPage.tabs.monitoring'), icon: <Activity className="h-4 w-4" /> },
  ];

  return (
    <div className="max-w-6xl space-y-6" data-testid="network-device-detail">
      <Breadcrumbs items={[
        { label: t('devicesPage.title'), href: '/devices' },
        { label: displayName || t('networkDeviceDetailPage.networkDevice') },
      ]} />

      {/* Header */}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className={`flex h-14 w-14 items-center justify-center rounded-lg border ${typeMeta?.color ?? typeConfig.unknown.color}`}>
              <TypeIcon className="h-7 w-7" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h1
                  className="truncate text-xl font-semibold tracking-tight"
                  title={displayName}
                  data-testid="network-device-name"
                >
                  {displayName}
                </h1>
                <span
                  data-testid="network-asset-type"
                  className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${typeMeta?.color ?? typeConfig.unknown.color}`}
                >
                  {typeLabel}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${approvalMeta?.color ?? approvalStatusConfig.dismissed.color}`}
                >
                  {approvalLabel}
                </span>
                <span
                  data-testid="network-device-status"
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${
                    asset.isOnline
                      ? 'bg-success/15 text-success border-success/30'
                      : 'bg-muted text-muted-foreground border-muted'
                  }`}
                >
                  {asset.isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                  {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="font-mono">{asset.ip}</span>
                {asset.mac !== '—' && <span className="font-mono">{asset.mac}</span>}
                {asset.manufacturer !== '—' && (
                  <span className="min-w-0 max-w-[16rem] truncate" title={asset.manufacturer}>
                    {asset.manufacturer}
                  </span>
                )}
              </div>
            </div>
          </div>
          {/* Approve / reclassify remain in Discovery until slice 3 of #1424
              brings them inline; unlink for manual links is available inline on
              the Monitoring tab. Other actions link out for now. */}
          <div className="flex items-center gap-2">
            <ProxyConnectPopover
              variant="header"
              assetId={asset.id}
              assetIp={asset.ip}
              port={defaultWebPort?.port ?? 443}
              service={defaultWebPort?.service}
              suggestedBridgeDeviceId={extras.suggestedBridgeDeviceId ?? null}
              devices={devices}
              devicesError={devicesError}
              onRetryDevices={fetchDevices}
            />
            <a
              href={`/discovery?asset=${asset.id}#assets`}
              data-testid="network-detail-manage-discovery"
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {t('networkDeviceDetailPage.manageInDiscovery')}
              <ChevronRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </div>

      {/* Stat strip — answers "is it up, how fast, can I get in" at a glance.
          Status reflects the last scan result, not a live probe, so it always
          pairs with an "as of" timestamp rather than implying real-time health. */}
      <div
        className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4 sm:flex-row sm:gap-6"
        data-testid="network-detail-stats"
      >
        <div className="shrink-0">
          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            {t('networkDeviceDetailPage.fields.status')}
          </div>
          <p className="mt-1 flex items-center gap-1.5 text-lg font-semibold">
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-full ${asset.isOnline ? 'bg-success' : 'bg-muted-foreground'}`}
            />
            {asset.isOnline ? t('common:states.online') : t('common:states.offline')}
          </p>
          {asset.lastSeen && (
            <p className="text-xs text-muted-foreground">
              {t('networkDeviceDetailPage.stats.asOf', { time: formatLastSeen(asset.lastSeen) })}
            </p>
          )}
        </div>
        <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
        <div className="shrink-0">
          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
            <Gauge className="h-3.5 w-3.5" />
            {t('networkDeviceDetailPage.fields.ping')}
          </div>
          <p
            className={`mt-1 text-lg font-semibold tabular-nums ${pingColor(asset.responseTimeMs)}`}
            data-testid="network-detail-ping"
          >
            {formatPing(asset.responseTimeMs)}
          </p>
        </div>
        <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
        <div className="shrink-0">
          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {t('networkDeviceDetailPage.fields.lastSeen')}
          </div>
          <p className="mt-1 whitespace-nowrap text-lg font-semibold" title={formatTimestamp(asset.lastSeen)}>
            {asset.lastSeen ? formatLastSeen(asset.lastSeen) : '—'}
          </p>
        </div>
        <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            {t('networkDeviceDetailPage.fields.linkedDevice')}
          </div>
          <p className="mt-1 truncate text-lg font-semibold">
            {asset.linkedDeviceId ? (
              <a
                href={`/devices/${asset.linkedDeviceId}`}
                data-testid="network-detail-stat-linked"
                className="text-primary hover:underline"
              >
                {asset.linkedDeviceName || t('common:states.unknown')}
              </a>
            ) : (
              '—'
            )}
          </p>
        </div>
      </div>

      <OverflowTabs
        tabs={tabDefs}
        activeTab={activeTab}
        onTabChange={(id) => switchTab(id as Tab)}
        testIdPrefix="network-detail-tab-"
      />

      {activeTab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-2" data-testid="network-detail-overview">
          <div className="space-y-5">
            <Section title={t('networkDeviceDetailPage.sections.identity')}>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label={t('networkDeviceDetailPage.fields.hostname')} value={asset.hostname || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.displayName')} value={asset.label || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.manufacturer')} value={asset.manufacturer} />
                <Field label={t('networkDeviceDetailPage.fields.model')} value={extras.model || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.osFingerprint')} value={asset.osFingerprint || '—'} />
                <Field label={t('networkDeviceDetailPage.fields.firstSeen')} value={formatTimestamp(extras.firstSeenAt)} />
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
              <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
                {Object.keys(snmpData).length === 0 ? (
                  <div className="col-span-2 text-xs text-muted-foreground">
                    {t('networkDeviceDetailPage.emptySnmp')}
                  </div>
                ) : (
                  Object.entries(snmpData).map(([key, value]) => (
                    <Fragment key={key}>
                      <dt className="text-muted-foreground">{snmpFieldLabel(key, t)}</dt>
                      <SnmpValue fieldKey={key} value={String(value ?? '')} />
                    </Fragment>
                  ))
                )}
              </dl>
            </Section>
          </div>

          <div className="space-y-5">
            <Section title={t('networkDeviceDetailPage.sections.openPorts')} testId="network-detail-ports">
              {openPorts.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.emptyPorts')}</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {visiblePorts.map((p, index) => (
                      <span
                        key={`${p.port}-${(p as { protocol?: string }).protocol ?? 'tcp'}-${index}`}
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
                            devicesError={devicesError}
                            onRetryDevices={fetchDevices}
                          />
                        )}
                      </span>
                    ))}
                  </div>
                  {openPorts.length > PORTS_VISIBLE_LIMIT && (
                    <button
                      type="button"
                      data-testid="network-detail-ports-toggle"
                      onClick={() => setPortsExpanded((expanded) => !expanded)}
                      className="mt-2 text-xs text-primary hover:underline"
                    >
                      {portsExpanded
                        ? t('networkDeviceDetailPage.showFewerPorts')
                        : t('networkDeviceDetailPage.showAllPorts', { count: openPorts.length })}
                    </button>
                  )}
                </>
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
                        onClick={() => setConfirmUnlinkOpen(true)}
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

      <ConfirmDialog
        open={confirmUnlinkOpen}
        onClose={() => setConfirmUnlinkOpen(false)}
        onConfirm={() => {
          setConfirmUnlinkOpen(false);
          void handleUnlink();
        }}
        title={t('networkDeviceDetailPage.confirmUnlink')}
        message={t('networkDeviceDetailPage.confirmUnlinkMessage')}
        confirmLabel={t('networkDeviceDetailPage.unlink')}
        variant="destructive"
        isLoading={unlinking}
        confirmTestId="network-detail-unlink-confirm"
      />
    </div>
  );
}
