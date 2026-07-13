import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

interface McpUrlCardProps {
  /** Full card with title + description (default) or compact one-liner */
  variant?: 'card' | 'compact';
  className?: string;
  /**
   * When true, render nothing unless the API exposes the OAuth 2.1 discovery
   * doc. The sign-in page uses this so we don't direct users to a URL their
   * MCP client can't authenticate against until the server-side flag is on.
   */
  requireOAuth?: boolean;
}

function resolveApiBase(): string {
  return ((import.meta.env.PUBLIC_API_URL as string | undefined)?.trim() || window.location.origin).replace(/\/$/, '');
}

export default function McpUrlCard({ variant = 'card', className, requireOAuth = false }: McpUrlCardProps) {
  const { t } = useTranslation('common');
  const [url, setUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [oauthReady, setOauthReady] = useState<boolean>(!requireOAuth);

  useEffect(() => {
    const base = resolveApiBase();
    setUrl(`${base}/api/v1/mcp/sse`);
    if (!requireOAuth) return;
    let cancelled = false;
    fetch(`${base}/.well-known/oauth-authorization-server`, { method: 'GET' })
      .then((res) => { if (!cancelled) setOauthReady(res.ok); })
      .catch(() => { if (!cancelled) setOauthReady(false); });
    return () => { cancelled = true; };
  }, [requireOAuth]);

  if (!oauthReady) return null;

  const onCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; user can still select the text manually.
    }
  };

  if (variant === 'compact') {
    return (
      <div className={cn('text-xs text-muted-foreground', className)}>
        <p className="mb-1">{t('shared.mcp.connecting')}</p>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
          <code className="flex-1 truncate font-mono chart-legend-xs" title={url}>
            {url || '…'}
          </code>
          <button
            type="button"
            onClick={onCopy}
            disabled={!url}
            className="shrink-0 rounded border bg-background px-2 py-0.5 chart-legend-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {copied ? t('states.copied') : t('actions.copy')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('rounded-md border bg-card p-4', className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{t('shared.mcp.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('shared.mcp.description')}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <code className="flex-1 truncate font-mono text-xs" title={url}>
          {url || t('states.resolving')}
        </code>
        <button
          type="button"
          onClick={onCopy}
          disabled={!url}
          className="shrink-0 rounded-md border bg-background px-3 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {copied ? t('states.copied') : t('actions.copy')}
        </button>
      </div>
    </div>
  );
}
