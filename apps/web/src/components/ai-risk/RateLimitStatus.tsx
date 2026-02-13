import { Clock, ShieldAlert } from 'lucide-react';
import { formatToolName } from '../../lib/utils';
import { RATE_LIMIT_CONFIGS } from './tierConfig';

export function RateLimitStatus() {
  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold">Rate Limit Configuration</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {RATE_LIMIT_CONFIGS.map((cfg) => {
          const windowLabel = cfg.windowSeconds >= 60
            ? `${cfg.windowSeconds / 60} min`
            : `${cfg.windowSeconds}s`;

          return (
            <div
              key={cfg.toolName}
              className="rounded-lg border bg-card p-4 shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-medium">
                    {formatToolName(cfg.toolName)}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {cfg.permission}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                    cfg.tier === 3
                      ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
                      : 'bg-blue-500/15 text-blue-700 border-blue-500/30'
                  }`}
                >
                  Tier {cfg.tier}
                </span>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-semibold">
                  {cfg.limit} req / {windowLabel}
                </span>
              </div>

              <div className="mt-2 flex items-center gap-2">
                <ShieldAlert className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">
                  Redis sliding window per user
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
