import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw, X } from 'lucide-react';
import VncViewer, { type VncDisconnectInfo } from './VncViewer';
import { fetchWithAuth } from '@/stores/auth';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

interface Props {
  tunnelId: string;
}

function buildTunnelWsUrl(tunnelId: string, ticket: string): string {
  const apiUrl = import.meta.env.PUBLIC_API_URL || window.location.origin;
  const wsProtocol = apiUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = apiUrl.replace(/^https?:\/\//, '');
  return `${wsProtocol}://${wsHost}/api/v1/tunnel-ws/${tunnelId}/ws?ticket=${encodeURIComponent(ticket)}`;
}

export default function VncViewerPage({ tunnelId }: Props) {
  const { t } = useTranslation('remote');
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A rejected handshake is recoverable, unlike a hard ticket-mint failure:
  // the tunnel is still there, only the one-time ticket has been spent.
  const [rejected, setRejected] = useState(false);
  // Connection-attempt generation. The tunnel ws-ticket is single use and is
  // consumed by the handshake, so an attempt the server refused is dead — an
  // abandoned noVNC session reporting later must not disturb the live attempt.
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);

  useEffect(() => {
    attemptRef.current = attempt;
    let cancelled = false;

    const mintTicket = async () => {
      try {
        const res = await fetchWithAuth(`/tunnels/${tunnelId}/ws-ticket`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || t('vncViewerPage.errors.obtainTicket'));
        }
        const body = await res.json();
        const ticket = typeof body.ticket === 'string' ? body.ticket : body.ticket?.ticket;
        if (!ticket) {
          throw new Error(t('vncViewerPage.errors.invalidTicket'));
        }
        if (!cancelled && attemptRef.current === attempt) {
          setWsUrl(buildTunnelWsUrl(tunnelId, ticket));
        }
      } catch (err) {
        if (!cancelled && attemptRef.current === attempt) {
          setError(err instanceof Error ? err.message : t('vncViewerPage.errors.connect'));
        }
      }
    };

    mintTicket();
    return () => {
      cancelled = true;
    };
  }, [tunnelId, attempt, t]);

  // The tunnel is released exactly once. noVNC's own `disconnect` event fires
  // in addition to the operator's Disconnect click, so both land here.
  const releasedRef = useRef(false);

  const handleDisconnect = useCallback(() => {
    if (releasedRef.current) return;
    releasedRef.current = true;
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch((err) => {
      console.error(`[VncViewerPage] Failed to close tunnel ${tunnelId}:`, err);
    });
    window.location.href = '/remote';
  }, [tunnelId]);

  /**
   * The viewer's session went away.
   *
   * `opened === false` with an unclean close is a handshake the server refused
   * before the `101` (expired/consumed ticket, revoked access, another
   * connection already owning the tunnel, rate limit). Only the one-time
   * ticket is spent — the tunnel is still good — so discard the URL, keep the
   * tunnel, and offer an explicit retry that mints a fresh ticket. Deleting
   * the tunnel here would destroy the thing the retry needs.
   *
   * Anything else (a session that opened and then ended, or an operator-driven
   * teardown) keeps the original behaviour: release the tunnel and leave.
   * Holding it open would leave a live network path into the device until the
   * server-side reaper eventually closes it.
   */
  const handleSessionDropped = useCallback(
    (forAttempt: number, info: VncDisconnectInfo) => {
      if (attemptRef.current !== forAttempt) return;
      if (!info.opened && !info.clean) {
        setWsUrl(null);
        setRejected(true);
        return;
      }
      handleDisconnect();
    },
    [handleDisconnect],
  );

  const retry = useCallback(() => {
    setRejected(false);
    setError(null);
    setWsUrl(null);
    setAttempt((n) => n + 1);
  }, []);

  // Bound to this attempt so an abandoned viewer's late disconnect is inert.
  const onViewerDisconnect = useCallback(
    (info: VncDisconnectInfo) => handleSessionDropped(attempt, info),
    [handleSessionDropped, attempt],
  );

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-between border-b border-gray-800 bg-gray-950 px-4 py-2">
        <div className="flex items-center gap-3">
          <a
            href="/remote"
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('common:actions.back')}
          </a>
          <span className="text-sm text-gray-500">|</span>
          <span className="text-sm font-medium text-gray-200">
            {t('vncViewerPage.sessionTitle')}
          </span>
          <span className="text-xs text-gray-500">{tunnelId.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleDisconnect}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition"
          >
            <X className="h-4 w-4" />
            {t('vncViewerPage.disconnect')}
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {error ? (
          <div className="flex h-full items-center justify-center text-sm text-red-300">
            {error}
          </div>
        ) : rejected ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-sm text-red-300">{t('vncViewerPage.errors.connect')}</p>
            <button
              type="button"
              onClick={retry}
              className="flex items-center gap-1.5 rounded-md bg-gray-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-700 transition"
            >
              <RefreshCw className="h-4 w-4" />
              {t('common:actions.retry')}
            </button>
          </div>
        ) : wsUrl ? (
          <VncViewer
            key={attempt}
            wsUrl={wsUrl}
            tunnelId={tunnelId}
            onDisconnect={onViewerDisconnect}
            className="h-full"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            {t('vncViewerPage.connecting')}
          </div>
        )}
      </div>
    </div>
  );
}
