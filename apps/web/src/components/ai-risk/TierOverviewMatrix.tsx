import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { formatToolName } from '../../lib/utils';
import { TIER_DEFINITIONS, groupByCategory } from './tierConfig';
import type { ToolCategory } from './tierConfig';

export function TierOverviewMatrix() {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const q = search.toLowerCase().trim();

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Guardrail Tier Matrix</h2>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tools..."
            className="h-8 w-56 rounded-lg border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {TIER_DEFINITIONS.map((tier) => (
          <TierCard
            key={tier.tier}
            tier={tier}
            search={q}
            collapsed={collapsed}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  );
}

function TierCard({
  tier,
  search,
  collapsed,
  onToggle,
}: {
  tier: (typeof TIER_DEFINITIONS)[number];
  search: string;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  const Icon = tier.icon;

  const filteredTools = useMemo(() => {
    if (!search) return tier.tools;
    return tier.tools.filter(
      (t) =>
        t.name.toLowerCase().includes(search) ||
        t.description.toLowerCase().includes(search),
    );
  }, [tier.tools, search]);

  const groups = useMemo(
    () => groupByCategory(filteredTools),
    [filteredTools],
  );

  if (search && filteredTools.length === 0) return null;

  return (
    <div
      className={`rounded-lg border border-l-4 bg-card shadow-sm ${tier.borderColor}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-5 pb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tier.badgeBg} ${tier.badgeText}`}
          >
            Tier {tier.tier}
          </span>
          <h3 className="text-sm font-semibold">{tier.label}</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {filteredTools.length} tool{filteredTools.length !== 1 ? 's' : ''}
          </span>
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      </div>

      <p className="px-5 pb-3 text-xs text-muted-foreground">
        {tier.description}
      </p>

      {/* Category groups */}
      <div className="border-t">
        {groups.map((group) => {
          const key = `${tier.tier}-${group.category}`;
          const isCollapsed = collapsed[key] ?? (tier.tier === 1 && !search);

          return (
            <CategoryGroup
              key={key}
              category={group.category}
              tools={group.items}
              isCollapsed={isCollapsed}
              onToggle={() => onToggle(key)}
            />
          );
        })}
      </div>
    </div>
  );
}

function CategoryGroup({
  category,
  tools,
  isCollapsed,
  onToggle,
}: {
  category: ToolCategory;
  tools: Array<{ name: string; description: string }>;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-5 py-2.5 text-left text-xs hover:bg-muted/30 transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <span className="font-medium">{category}</span>
        <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {tools.length}
        </span>
      </button>

      {!isCollapsed && (
        <div className="px-5 pb-3 space-y-1">
          {tools.map((tool) => (
            <div key={tool.name} className="flex gap-2 text-xs leading-5 pl-5">
              <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground/40" />
              <p>
                <span className="font-medium">
                  {formatToolName(tool.name)}
                </span>
                <span className="ml-1 text-muted-foreground">
                  — {tool.description}
                </span>
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
