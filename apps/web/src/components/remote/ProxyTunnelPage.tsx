import { useState, useCallback, useEffect } from 'react';
import { ArrowLeft, X, Globe, Network, ExternalLink } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';
import { extractApiError } from '@/lib/apiError';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

interface Props {
  tunnelId: string;
  target: string;
}

/**
 * Network Proxy page. Renders the proxied device's web UI in an iframe served
 * through the API HTTP reverse proxy (`/api/v1/tunnel-http/:id/*`). A one-time
 * http-ticket authorizes the first navigation, which the proxy exchanges for a
 * short-lived, path-scoped cookie used by all sub-resource requests.
 *
 * Note: unlike VNC/terminal there is no long-lived relay WebSocket, so the
 * `tunnel_sessions` status never flips to "active". The displayed status is
 * driven by the iframe load; the background poll only surfaces a server-side
 * failure/teardown.
 */
function buildProxyUrl(tunnelId: string, ticket: string): string {
  const apiUrl = import.meta.env.PUBLIC_API_URL || window.location.origin;
  return `${apiUrl}/api/v1/tunnel-http/${tunnelId}/?__bzt=${encodeURIComponent(ticket)}`;
}

export default function ProxyTunnelPage({ tunnelId, target }: Props) {
  const { t } = useTranslation('remote');
  const [status, setStatus] = useState<'connecting' | 'active' | 'disconnected' | 'failed'>('connecting');
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll only to surface a server-side failure/teardown. The proxied service's
  // liveness is reflected by the iframe load below — the HTTP proxy issues
  // per-request fetches, so no relay ever flips the session to "active".
  const pollStatus = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/tunnels/${tunnelId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'failed' || data.status === 'disconnected') {
          setStatus(data.status);
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

  useEffect(() => {
    let cancelled = false;

    const mintTicket = async () => {
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
        if (!cancelled) {
          setProxyUrl(buildProxyUrl(tunnelId, ticket));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('proxyTunnelPage.errors.prepareConnection'));
        }
      }
    };

    mintTicket();
    return () => {
      cancelled = true;
    };
  }, [tunnelId, t]);

  const handleClose = useCallback(() => {
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch(() => {});
    setStatus('disconnected');
  }, [tunnelId]);

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

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-4 border-b px-6 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <a
            href="/remote"
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
          <span className={`shrink-0 text-xs font-medium ${statusColor}`}>{statusLabel}</span>
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

      {error ? (
        <div className="flex flex-1 items-start justify-center p-8">
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
          className="w-full flex-1 border-0"
          onLoad={() => setStatus((s) => (s === 'failed' || s === 'disconnected' ? s : 'active'))}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          {t('proxyTunnelPage.preparingConnection')}
        </div>
      )}
    </div>
  );
}
