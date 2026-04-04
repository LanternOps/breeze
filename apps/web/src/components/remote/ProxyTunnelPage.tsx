import { useState, useCallback, useEffect } from 'react';
import { ArrowLeft, Copy, Check, X, Globe, Network } from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';

interface Props {
  tunnelId: string;
  target: string;
  wsUrl: string;
}

/**
 * Proxy tunnel info page. Shows the tunnel status, target, and connection URLs
 * for accessing the proxied service.
 */
export default function ProxyTunnelPage({ tunnelId, target, wsUrl }: Props) {
  const [status, setStatus] = useState<'connecting' | 'active' | 'disconnected' | 'failed'>('connecting');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/tunnels/${tunnelId}`);
      if (res.ok) {
        const data = await res.json();
        setStatus(data.status);
        if (data.status === 'failed') {
          setError(data.errorMessage || 'Tunnel failed');
        }
      }
    } catch { /* ignore */ }
  }, [tunnelId]);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  const handleClose = useCallback(() => {
    fetchWithAuth(`/tunnels/${tunnelId}`, { method: 'DELETE' }).catch(() => {});
    setStatus('disconnected');
  }, [tunnelId]);

  const handleCopyWsUrl = useCallback(() => {
    navigator.clipboard.writeText(wsUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [wsUrl]);

  const statusColor = {
    connecting: 'text-amber-500',
    active: 'text-green-500',
    disconnected: 'text-gray-500',
    failed: 'text-red-500',
  }[status];

  const statusLabel = {
    connecting: 'Connecting...',
    active: 'Active',
    disconnected: 'Disconnected',
    failed: 'Failed',
  }[status];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <a
            href="/remote"
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </a>
          <span className="text-muted-foreground">|</span>
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Network Proxy</span>
        </div>
        <button
          type="button"
          onClick={handleClose}
          disabled={status === 'disconnected' || status === 'failed'}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition disabled:opacity-50"
        >
          <X className="h-4 w-4" />
          Close Tunnel
        </button>
      </div>

      <div className="flex-1 flex items-start justify-center p-8">
        <div className="w-full max-w-lg space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Network className="h-5 w-5" />
              Tunnel Details
            </h2>

            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Status</dt>
                <dd className={`font-medium ${statusColor}`}>{statusLabel}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Target</dt>
                <dd className="font-mono font-medium">{target || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tunnel ID</dt>
                <dd className="font-mono text-xs text-muted-foreground">{tunnelId}</dd>
              </div>
            </dl>

            {error && (
              <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
                {error}
              </div>
            )}
          </div>

          {wsUrl && status !== 'failed' && (
            <div className="rounded-lg border bg-card p-6 shadow-sm">
              <h3 className="text-sm font-semibold">WebSocket Relay URL</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Use this URL to connect to the proxied service via WebSocket relay.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <code className="flex-1 rounded-md border bg-muted px-3 py-2 text-xs font-mono break-all">
                  {wsUrl}
                </code>
                <button
                  type="button"
                  onClick={handleCopyWsUrl}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border hover:bg-muted transition"
                  title="Copy URL"
                >
                  {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
