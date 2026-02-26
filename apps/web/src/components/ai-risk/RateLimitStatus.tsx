import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Clock, Search } from 'lucide-react';
import { formatToolName } from '../../lib/utils';
import { RATE_LIMIT_CONFIGS, groupByCategory } from './tierConfig';
import type { ToolCategory, RateLimitConfig } from './tierConfig';

const TIER_BADGE: Record<number, string> = {
  1: 'bg-green-500/15 text-green-700 border-green-500/30',
  2: 'bg-blue-500/15 text-blue-700 border-blue-500/30',
  3: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
};

export function RateLimitStatus() {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const q = search.toLowerCase().trim();

  const filtered = useMemo(() => {
    if (!q) return RATE_LIMIT_CONFIGS;
    return RATE_LIMIT_CONFIGS.filter(
      (cfg) =>
        cfg.toolName.toLowerCase().includes(q) ||
        cfg.permission.toLowerCase().includes(q) ||
        cfg.category.toLowerCase().includes(q),
    );
  }, [q]);

  const groups = useMemo(() => groupByCategory(filtered), [filtered]);

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">Rate Limit Configuration</h2>
          <span className="text-xs text-muted-foreground">
            {filtered.length} rule{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter rate limits..."
            className="h-8 w-56 rounded-lg border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
          No rate limits match your search.
        </div>
      ) : (
        <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
          {groups.map((group) => {
            const key = `rl-${group.category}`;
            const isCollapsed = collapsed[key] ?? false;

            return (
              <RateLimitCategoryGroup
                key={key}
                category={group.category}
                configs={group.items}
                isCollapsed={isCollapsed}
                onToggle={() => toggle(key)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function RateLimitCategoryGroup({
  category,
  configs,
  isCollapsed,
  onToggle,
}: {
  category: ToolCategory;
  configs: RateLimitConfig[];
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/30 transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        )}
        <span className="font-medium">{category}</span>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {configs.length}
        </span>
      </button>

      {!isCollapsed && (
        <div className="px-4 pb-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-1.5 pl-6 font-medium">Tool</th>
                <th className="pb-1.5 font-medium">Limit</th>
                <th className="pb-1.5 font-medium">Window</th>
                <th className="pb-1.5 font-medium">Tier</th>
                <th className="pb-1.5 font-medium">Permission</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((cfg) => {
                const windowLabel =
                  cfg.windowSeconds >= 60
                    ? `${cfg.windowSeconds / 60} min`
                    : `${cfg.windowSeconds}s`;

                return (
                  <tr
                    key={cfg.toolName}
                    className="border-t border-dashed border-muted hover:bg-muted/20"
                  >
                    <td className="py-2 pl-6 font-medium">
                      {formatToolName(cfg.toolName)}
                    </td>
                    <td className="py-2">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        {cfg.limit} req
                      </span>
                    </td>
                    <td className="py-2 text-muted-foreground">{windowLabel}</td>
                    <td className="py-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${TIER_BADGE[cfg.tier]}`}
                      >
                        T{cfg.tier}
                      </span>
                    </td>
                    <td className="py-2 font-mono text-muted-foreground">
                      {cfg.permission}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
