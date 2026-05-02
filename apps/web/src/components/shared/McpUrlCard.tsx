import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';

interface McpUrlCardProps {
  /** Full card with title + description (default) or compact one-liner */
  variant?: 'card' | 'compact';
  className?: string;
}

function resolveMcpUrl(): string {
  const base = (import.meta.env.PUBLIC_API_URL as string | undefined)?.trim() || window.location.origin;
  return `${base.replace(/\/$/, '')}/mcp/sse`;
}

export default function McpUrlCard({ variant = 'card', className }: McpUrlCardProps) {
  const [url, setUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setUrl(resolveMcpUrl());
  }, []);

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
        <p className="mb-1">Connecting an AI agent?</p>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
          <code className="flex-1 truncate font-mono text-[11px]" title={url}>
            {url || '…'}
          </code>
          <button
            type="button"
            onClick={onCopy}
            disabled={!url}
            className="shrink-0 rounded border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('rounded-md border bg-card p-4', className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Direct your AI agent here</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Paste this URL into your MCP client (Claude.ai, ChatGPT, Cursor, …). You'll be sent
            back here to authorize the connection via OAuth.
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <code className="flex-1 truncate font-mono text-xs" title={url}>
          {url || 'Resolving…'}
        </code>
        <button
          type="button"
          onClick={onCopy}
          disabled={!url}
          className="shrink-0 rounded-md border bg-background px-3 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
