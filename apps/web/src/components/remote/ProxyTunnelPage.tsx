import { useState, useCallback, useEffect } from 'react';
import { ArrowLeft, X, Globe, Network, ExternalLink, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { extractApiError } from '@/lib/apiError';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

interface Props {
  tunnelId: string;
  target: string;
  /** Discovered-asset id carried from the entry point, if any — drives Back
   * navigation and is carried forward to any newly created tunnel. */
  assetId?: string;
}

// Terminal statuses returned by GET /tunnels/:id.
type TunnelStatus = 'connecting' | 'active' | 'disconnected' | 'failed';

// Fields needed to re-create a tunnel session from this row's own parameters
// (terminal reconnect / TLS retry). All present on GET /tunnels/:id.
interface SessionFields {
  deviceId: string;
  targetHost: string;
  targetPort: number;
  scheme: 'http' | 'https' | null;
  skipTlsVerify: boolean;
}

// Cookie TTL (300s, tunnelHttp.ts sliding refresh) + throttle/lazy-expiry
// slack (design spec A.5) — an idleSeconds reading past this means the
// client-visible "active" state is no longer honest even if the iframe never
// itself reported failure.
const IDLE_EXPIRY_SECONDS = 330;

/**
 * Network Proxy page. Renders the proxied device's web UI in an iframe served
 * through the API HTTP reverse proxy (`/api/v1/tunnel-http/:id/*`). A one-time
 * http-ticket authorizes the first navigation, which the proxy exchanges for a
 * short-lived, path-scoped cookie used by all sub-resource requests.
 *
 * Note: unlike VNC/terminal there is no long-lived relay WebSocket, so the
 * `tunnel_sessions` status never flips to "active" from a relay's point of
 * view — `tunnelHttp.ts` sets it at ticket->cookie exchange instead. The
 * displayed status is a mix of the iframe's onLoad event and the 5s poll of
 * `GET /tunnels/:id`; the poll is authoritative for expiry (server-computed
 * `idleSeconds` + terminal status) since the iframe's onLoad only ever fires
 * once and cannot un-set a stale green "Connected" badge on its own.
 */
function buildProxyUrl(tunnelId: string, ticket: string): string {
  const apiUrl = import.meta.env.PUBLIC_API_URL || window.location.origin;
  return `${apiUrl}/api/v1/tunnel-http/${tunnelId}/?__bzt=${encodeURIComponent(ticket)}`;
}

export default function ProxyTunnelPage({ tunnelId, target, assetId }: Props) {
  const { t } = useTranslation('remote');
  const [status, setStatus] = useState<TunnelStatus>('connecting');
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Raw `errorMessage` code from the last poll (e.g. 'tls_cert_untrusted') —
  // distinguishes the in-place TLS retry screen from the generic expiry overlay.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [idleSeconds, setIdleSeconds] = useState<number | null>(null);
  const [sessionFields, setSessionFields] = useState<SessionFields | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  // Poll GET /tunnels/:id — authoritative for both a server-side
  // failure/teardown AND honest idle detection (server-computed `idleSeconds`,
  // never diffed against the browser's own clock).
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/tunnels/${tunnelId}`);
      if (res.ok) {
        const data = await res.json();
        if (typeof data.deviceId === 'string') {
          setSessionFields({
            deviceId: data.deviceId,
            targetHost: data.targetHost,
            targetPort: data.targetPort,
            scheme: data.scheme ?? null,
            skipTlsVerify: !!data.skipTlsVerify,
          });
        }
        setIdleSeconds(typeof data.idleSeconds === 'number' ? data.idleSeconds : null);
        if (data.status === 'failed' || data.status === 'disconnected') {
          setStatus(data.status);
          setErrorCode(typeof data.errorMessage === 'string' ? data.errorMessage : null);
          if (data.status === 'failed') {
            setError(
              data.errorMessage === 'tls_cert_untrusted'
                ? t('proxyTunnelPage.errors.tlsUntrusted')
                : extractApiError(data, t('proxyTunnelPage.errors.tunnelFailed')),
            );
          }
        }
      }
    } catch { /* ignore */ }
  }, [tunnelId, t]);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  // Mints (or re-mints) the one-time http-ticket and points the iframe at a
  // fresh `?__bzt=` URL. Reused by the initial mount AND the idle-reconnect
  // branch below — the ticket itself is stripped from the URL by the existing
  // 302 (ticket -> cookie exchange), so re-minting never puts new capability
  // material somewhere it lingers.
  const mintTicket = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetchWithAuth(`/tunnels/${tunnelId}/http-ticket`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('proxyTunnelPage.errors.obtainTicket'));
      }
      const body = await res.json();
      // The mint endpoint wraps the ticket: `{ ticket: { ticket, expiresInSeconds } }`.
      const ticket = typeof body.ticket === 'string' ? body.ticket : body.ticket?.ticket;
      if (!ticket) {
        throw new Error(t('proxyTunnelPage.errors.invalidTicket'));
      }
      setProxyUrl(buildProxyUrl(tunnelId, ticket));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('proxyTunnelPage.errors.prepareConnection'));
      return false;
    }
  }, [tunnelId, t]);

  useEffect(() => {
    mintTicket();
  }, [mintTicket]);

  // Creates a brand-new tunnel from THIS row's own target fields and
  // navigates to it — used by both the terminal-reconnect branch and the
  // TLS self-signed retry (which forces `skipTlsVerify:true` regardless of
  // the row's original value). `target`/`asset` query params are carried
  // forward so Back keeps working on the new page.
  const createTunnelAndNavigate = useCallback(async (forceSkipTlsVerify?: boolean) => {
    if (!sessionFields) return;
    setReconnecting(true);
    setReconnectError(null);
    try {
      const res = await fetchWithAuth('/tunnels', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: sessionFields.deviceId,
          type: 'proxy',
          targetHost: sessionFields.targetHost,
          targetPort: sessionFields.targetPort,
          scheme: sessionFields.scheme ?? undefined,
          skipTlsVerify: forceSkipTlsVerify ?? sessionFields.skipTlsVerify,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(extractApiError(body, t('proxyTunnelPage.errors.tunnelFailed')));
      }
      const newSession = await res.json();
      const params = new URLSearchParams();
      if (target) params.set('target', target);
      if (assetId) params.set('asset', assetId);
      const qs = params.toString();
      window.location.href = `/remote/proxy/${newSession.id}${qs ? `?${qs}` : ''}`;
    } catch (err) {
      setReconnecting(false);
      setReconnectError(err instanceof Error ? err.message : t('proxyTunnelPage.errors.tunnelFailed'));
    }
  }, [sessionFields, target, assetId, t]);

  // Idle-but-connectable branch: re-mint a ticket and reload the iframe in
  // place — no new tunnel row.
  const handleReconnectIdle = useCallback(async () => {
    setReconnecting(true);
    setReconnectError(null);
    const ok = await mintTicket();
    setReconnecting(false);
    if (ok) {
      setIdleSeconds(0);
      // A successful re-mint means the row is genuinely connectable again —
      // clear whatever error/errorCode a prior poll had recorded so the
      // overlay/TLS screen don't linger over a fresh iframe.
      setError(null);
      setErrorCode(null);
    }
  }, [mintTicket]);

  const handleReconnectTerminal = useCallback(() => {
    void createTunnelAndNavigate();
  }, [createTunnelAndNavigate]);

  const handleReconnectSelfSigned = useCallback(() => {
    void createTunnelAndNavigate(true);
  }, [createTunnelAndNavigate]);

  const handleClose = useCallback(() => {
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch(() => {});
    setStatus('disconnected');
  }, [tunnelId]);

  const isTerminal = status === 'failed' || status === 'disconnected';
  const isTlsUntrusted = status === 'failed' && errorCode === 'tls_cert_untrusted';
  const isIdleExpired = idleSeconds !== null && idleSeconds > IDLE_EXPIRY_SECONDS;
  // The TLS-untrusted screen has its own dedicated in-place retry (item 3) —
  // it never also shows the generic expiry overlay.
  const showExpiredOverlay = !isTlsUntrusted && (isTerminal || isIdleExpired);

  const statusColor = {
    connecting: 'text-amber-500',
    active: 'text-green-500',
    disconnected: 'text-gray-500',
    failed: 'text-red-500',
  }[status];

  const statusLabel = {
    connecting: t('proxyTunnelPage.status.connecting'),
    active: t('proxyTunnelPage.status.connected'),
    disconnected: t('proxyTunnelPage.status.disconnected'),
    failed: t('proxyTunnelPage.status.failed'),
  }[status];

  const backHref = assetId ? `/devices/network/${assetId}` : '/remote';

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <a
            href={backHref}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('common:actions.back')}
          </a>
          <span className="text-muted-foreground">|</span>
          <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">{t('proxyTunnelPage.title')}</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{target || '—'}</span>
          {/* A badge left showing "Connected" here would be stale once the row is
              actually terminal or idle-expired — the overlay below is the source
              of truth in that case, so the badge steps aside for it. */}
          {!showExpiredOverlay && (
            <span className={`shrink-0 text-xs font-medium ${statusColor}`}>{statusLabel}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {proxyUrl && (
            <a
              href={proxyUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-4 w-4" />
              {t('proxyTunnelPage.openInNewTab')}
            </a>
          )}
          <button
            type="button"
            onClick={handleClose}
            disabled={status === 'disconnected' || status === 'failed'}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="h-4 w-4" />
            {t('common:actions.close')}
          </button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        {isTlsUntrusted ? (
          <div className="flex h-full items-start justify-center overflow-auto p-8">
            <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Network className="h-5 w-5" />
                {t('proxyTunnelPage.tunnelDetails')}
              </h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('proxyTunnelPage.target')}</dt>
                  <dd className="font-mono font-medium">{target || '—'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('proxyTunnelPage.tunnelId')}</dt>
                  <dd className="font-mono text-xs text-muted-foreground">{tunnelId}</dd>
                </div>
              </dl>
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
                {error}
              </div>
              <button
                type="button"
                onClick={handleReconnectSelfSigned}
                disabled={reconnecting || !sessionFields}
                className="mt-4 flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                {t('proxyTunnelPage.reconnectSelfSigned')}
              </button>
              {reconnectError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">{reconnectError}</p>
              )}
            </div>
          </div>
        ) : error ? (
          <div className="flex h-full items-start justify-center overflow-auto p-8">
            <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xs">
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Network className="h-5 w-5" />
                {t('proxyTunnelPage.tunnelDetails')}
              </h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('proxyTunnelPage.target')}</dt>
                  <dd className="font-mono font-medium">{target || '—'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('proxyTunnelPage.tunnelId')}</dt>
                  <dd className="font-mono text-xs text-muted-foreground">{tunnelId}</dd>
                </div>
              </dl>
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
                {error}
              </div>
            </div>
          </div>
        ) : proxyUrl ? (
          <iframe
            src={proxyUrl}
            title={t('proxyTunnelPage.proxiedService')}
            data-testid="network-proxy-frame"
            // The proxied device is untrusted. Omitting `allow-same-origin` forces
            // the framed content into a null origin so its scripts cannot read this
            // app's cookies/storage or reach the parent frame (defense-in-depth with
            // the server-set sandbox CSP). The proxy auth cookie is HttpOnly and
            // attaches by site, so auth still works.
            sandbox="allow-scripts allow-forms allow-popups"
            className="h-full w-full border-0"
            onLoad={() => setStatus((s) => (s === 'failed' || s === 'disconnected' ? s : 'active'))}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            {t('proxyTunnelPage.preparingConnection')}
          </div>
        )}

        {showExpiredOverlay && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-background/90 p-8 backdrop-blur-sm"
            data-testid="proxy-session-expired-overlay"
          >
            <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center shadow-lg">
              <h2 className="text-lg font-semibold">{t('proxyTunnelPage.sessionExpired.title')}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{t('proxyTunnelPage.sessionExpired.body')}</p>
              <button
                type="button"
                onClick={isTerminal ? handleReconnectTerminal : handleReconnectIdle}
                disabled={reconnecting || (isTerminal && !sessionFields)}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                {t('proxyTunnelPage.sessionExpired.reconnect')}
              </button>
              {reconnectError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">{reconnectError}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
