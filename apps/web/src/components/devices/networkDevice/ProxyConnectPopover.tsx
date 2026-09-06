// Per-port "Open Web UI" popover: pick a bridge agent, scheme, and optional
// self-signed allowance, then POST /tunnels/proxy-connect and open the result
// in a new tab. Owns its own focus-trap/outside-click/escape wiring since
// it's the one control on this page complex enough to need it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Globe, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { buildRemoteProxyPageUrl } from '@/lib/remoteTunnelUrls';
import { useClickOutside } from '../../../hooks/useClickOutside';
import { useEscapeClose } from '../../../hooks/useEscapeClose';
import HelpTooltip from '../../shared/HelpTooltip';
import { defaultSchemeForPort } from '../../discovery/portCatalog';
import type { DeviceOption } from './types';

// Bridge default is `suggestedBridgeDeviceId` (the discovering agent) — NEVER
// `linkedDeviceId` (identity link), which would be a loopback.
export function ProxyConnectPopover({
  assetId,
  assetIp,
  port: initialPort,
  service,
  suggestedBridgeDeviceId,
  devices,
  devicesError,
  onRetryDevices,
  onAnnounce,
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
  // Posts a message to the page's shared polite live region — used here to
  // tell screen reader users the web UI opened in a new tab, since that
  // outcome is otherwise silent (no visible page change to announce it).
  onAnnounce: (message: string) => void;
  // 'pill' — icon-only trigger on an open-port chip, port fixed.
  // 'header' — labeled page-level action, port editable. This is the entry
  // point that survives when the scan recorded no (web) ports at all.
  variant?: 'pill' | 'header';
}) {
  const { t } = useTranslation('devices');
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState(initialPort);
  const [portText, setPortText] = useState(String(initialPort));
  // Only reseed from `initialPort` while the popover is closed — otherwise a
  // prop change reaching the open header popover (e.g. the default web port
  // shifting after a background asset refresh) would clobber whatever custom
  // port the operator is actively typing.
  useEffect(() => {
    if (!open) {
      setPort(initialPort);
      setPortText(String(initialPort));
    }
  }, [initialPort, open]);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The control "move focus on open" targets first: the port input for the
  // header variant, else the bridge picker (select or combobox input) — NOT
  // just "whatever's first in the DOM", since the "through agent" field's
  // HelpTooltip button sits ahead of it there. Only used for that; the
  // Tab-trap below still walks every real focusable, HelpTooltip included.
  const primaryControlRef = useRef<HTMLElement>(null);
  useClickOutside(open, containerRef, () => setOpen(false));
  useEscapeClose(open, () => setOpen(false));

  // Stable per-instance ids (this component renders once per open port plus
  // once for the header's always-on entry point, so assetId+variant+port
  // keeps them unique — the same scheme the scheme/bridge-combobox ids below
  // already use).
  const titleId = `proxy-popover-title-${assetId}-${variant}-${initialPort}`;
  const popoverId = `proxy-popover-${assetId}-${variant}-${initialPort}`;

  // Every focusable control inside the open panel, in DOM order — reused for
  // both "move focus in on open" and the Tab-trap below so the two can never
  // disagree about what's focusable.
  const getFocusable = useCallback((): HTMLElement[] => {
    const panel = panelRef.current;
    if (!panel) return [];
    return Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
  }, []);

  // Move focus into the popover when it opens (the port input for the header
  // variant, else the bridge picker — whichever is first in the DOM); restore
  // it to the trigger on every close path EXCEPT one: when focus already left
  // the popover on its own (see the focusout handler below), restoring here
  // would fight the user's own Tab navigation by yanking focus back in.
  const wasOpenRef = useRef(false);
  const focusAlreadyMovedRef = useRef(false);
  useEffect(() => {
    if (open) {
      const focusables = getFocusable();
      (primaryControlRef.current ?? focusables[0] ?? panelRef.current)?.focus();
    } else if (wasOpenRef.current) {
      if (focusAlreadyMovedRef.current) {
        focusAlreadyMovedRef.current = false;
      } else {
        triggerRef.current?.focus();
      }
    }
    wasOpenRef.current = open;
  }, [open, getFocusable]);

  // This is a non-modal dialog (`aria-modal="false"`) — it must not hard-trap
  // Tab like a modal would. Instead, close it the moment focus leaves both
  // the panel and the trigger (a real Tab off the last control, or a click on
  // something else entirely), restoring nothing since focus has already
  // moved to wherever the user sent it.
  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    const handleFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && container.contains(next)) return;
      focusAlreadyMovedRef.current = true;
      setOpen(false);
    };
    container.addEventListener('focusout', handleFocusOut);
    return () => container.removeEventListener('focusout', handleFocusOut);
  }, [open]);

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

  // Resolves free-typed combobox text to exactly one online device — an
  // exact (case-insensitive) match on its displayed label OR on its own id.
  // Returns undefined on no match AND on an ambiguous multi-match, since
  // Connect must never bridge through a device the text doesn't uniquely
  // name.
  const matchBridgeDevice = useCallback(
    (text: string): DeviceOption | undefined => {
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      const lower = trimmed.toLowerCase();
      const matches = onlineDevices.filter(
        (d) => labelFor(d).toLowerCase() === lower || d.id.toLowerCase() === lower,
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
    [onlineDevices, labelFor],
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
  const [retryingDevices, setRetryingDevices] = useState(false);
  const handleRetryDevices = useCallback(() => {
    // Move focus into the panel BEFORE disabling the button: a browser moves
    // focus to <body> when the currently-focused element becomes disabled,
    // which would escape the popover's focus containment entirely (jsdom
    // doesn't reproduce that specific move, so this only guards against it).
    panelRef.current?.focus();
    setRetryingDevices(true);
    void Promise.resolve(onRetryDevices()).finally(() => setRetryingDevices(false));
  }, [onRetryDevices]);
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
      onAnnounce(t('networkDeviceDetailPage.live.webUiOpened'));
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
  }, [deviceId, assetId, assetIp, port, portValid, scheme, skipTlsVerify, t, onAnnounce]);

  return (
    <div className="relative inline-block" ref={containerRef}>
      {variant === 'header' ? (
        <button
          type="button"
          ref={triggerRef}
          data-testid="network-detail-open-web-ui"
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Globe aria-hidden="true" className="h-3.5 w-3.5" />
          {t('networkDeviceDetailPage.openWebUi')}
        </button>
      ) : (
        <button
          type="button"
          ref={triggerRef}
          data-testid={`network-detail-port-proxy-${port}`}
          title={t('networkDeviceDetailPage.openWebUi')}
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
          {t('networkDeviceDetailPage.openWebUi')}
        </button>
      )}

      {open && (
        <div
          id={popoverId}
          ref={panelRef}
          tabIndex={-1}
          className={`absolute top-full z-30 mt-1 w-72 rounded-md border bg-popover p-3 text-left shadow-lg ${
            variant === 'header' ? 'right-0' : 'left-0'
          }`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          data-testid={variant === 'header' ? 'network-detail-proxy-popover' : `network-detail-proxy-popover-${port}`}
        >
          <div id={titleId} className="mb-2 text-sm font-semibold">
            {t('discovery:proxyConnect.title', { target: `${assetIp}:${portValid ? port : '…'}` })}
          </div>

          {variant === 'header' && (
            <div className="mb-2">
              <label htmlFor={`proxy-port-${assetId}`} className="text-xs font-medium text-muted-foreground">
                {t('networkDeviceDetailPage.proxyPort')}
              </label>
              <input
                id={`proxy-port-${assetId}`}
                ref={primaryControlRef as React.Ref<HTMLInputElement>}
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
                className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs font-mono [appearance:textfield] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
                onClick={handleRetryDevices}
                disabled={retryingDevices}
                className="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {retryingDevices ? t('common:states.processing') : t('common:actions.retry')}
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
                      ref={variant === 'header' ? undefined : (primaryControlRef as React.Ref<HTMLInputElement>)}
                      data-testid="proxy-popover-bridge-select"
                      value={bridgeSearchText}
                      aria-invalid={!matchBridgeDevice(bridgeSearchText)}
                      onChange={(e) => {
                        const text = e.target.value;
                        setBridgeSearchText(text);
                        // Unmatched text must NOT keep the previous deviceId —
                        // otherwise the field can show one agent's text while
                        // Connect bridges through a different, stale one.
                        const match = matchBridgeDevice(text);
                        setDeviceId(match?.id ?? '');
                      }}
                      className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <datalist id={`proxy-bridge-devices-${assetId}-${variant}-${initialPort}`}>
                      {onlineDevices.map((d) => (
                        <option key={d.id} value={labelFor(d)} />
                      ))}
                    </datalist>
                  </>
                ) : (
                  <select
                    ref={variant === 'header' ? undefined : (primaryControlRef as React.Ref<HTMLSelectElement>)}
                    data-testid="proxy-popover-bridge-select"
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
                  className="mt-1 h-8 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
                      className="focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
                className="mt-1 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                {connecting ? t('networkDeviceDetailPage.connecting') : t('discovery:proxyConnect.connect')}
              </button>
            </div>
          )}

          {inlineError && (
            <div
              role="alert"
              className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            >
              {inlineError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
