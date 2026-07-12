import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import VncViewer from './VncViewer';
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

  useEffect(() => {
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
        if (!cancelled) {
          setWsUrl(buildTunnelWsUrl(tunnelId, ticket));
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('vncViewerPage.errors.connect'));
        }
      }
    };

    mintTicket();
    return () => {
      cancelled = true;
    };
  }, [tunnelId, t]);

  const handleDisconnect = useCallback(() => {
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch((err) => {
      console.error(`[VncViewerPage] Failed to close tunnel ${tunnelId}:`, err);
    });
    window.location.href = '/remote';
  }, [tunnelId]);

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
        ) : wsUrl ? (
          <VncViewer
            wsUrl={wsUrl}
            tunnelId={tunnelId}
            onDisconnect={handleDisconnect}
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
