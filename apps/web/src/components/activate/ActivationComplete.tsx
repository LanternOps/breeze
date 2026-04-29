import { useEffect, useState } from 'react';
import StatusIcon from '../auth/StatusIcon';

export default function ActivationComplete() {
  // The MCP-bootstrap flow lands here after Stripe payment setup; for that
  // path the user should return to their AI agent chat. Direct (non-MCP)
  // partners should head to the dashboard. The query param signals which.
  const [fromMcp, setFromMcp] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setFromMcp(params.get('source') === 'mcp');
  }, []);

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2 text-center">
        <StatusIcon variant="success" />
        <h2 className="text-lg font-semibold">You're all set</h2>
        <p className="text-sm text-muted-foreground">
          {fromMcp
            ? 'Return to your agent chat. It will detect activation and continue from there.'
            : 'Your Breeze account is ready. Sign in to start adding devices.'}
        </p>
      </div>
      {!fromMcp && (
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Sign in
        </a>
      )}
    </div>
  );
}
