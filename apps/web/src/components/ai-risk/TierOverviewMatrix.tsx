import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { formatToolName } from "../../lib/utils";
import { TIER_DEFINITIONS, groupByCategory } from "./tierConfig";
import type { ToolCategory, TierIconName } from "./tierConfig";

// tierConfig.ts is imported by an api-side contract test (issue #2686) and so
// must stay dependency-free; it names its icons and they are resolved here.
const TIER_ICONS: Record<TierIconName, LucideIcon> = {
  eye: Eye,
  "shield-check": ShieldCheck,
  "shield-alert": ShieldAlert,
  "shield-off": ShieldOff,
};
export function TierOverviewMatrix() {
  const { t } = useTranslation("security");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const q = search.toLowerCase().trim();
  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">
          {t("aiRiskTierOverviewMatrix.guardrailTierMatrix")}
        </h2>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("aiRiskTierOverviewMatrix.filterTools")}
            className="h-8 w-56 rounded-lg border bg-card pl-8 pr-3 text-xs focus:outline-hidden focus:ring-1 focus:ring-primary"
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
  const { t } = useTranslation("security");
  const Icon = TIER_ICONS[tier.iconName];
  const filteredTools = useMemo(() => {
    if (!search) return tier.tools;
    return tier.tools.filter(
      (t) =>
        t.name.toLowerCase().includes(search) ||
        t.description.toLowerCase().includes(search),
    );
  }, [tier.tools, search]);
  const groups = useMemo(() => groupByCategory(filteredTools), [filteredTools]);
  if (search && filteredTools.length === 0) return null;
  return (
    <div
      className={`rounded-lg border border-l-4 bg-card shadow-xs ${tier.borderColor}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-5 pb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tier.badgeBg} ${tier.badgeText}`}
          >
            {t("aiRiskTierOverviewMatrix.tier")}
            {tier.tier}
          </span>
          <h3 className="text-sm font-semibold">{tier.label}</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("aiRiskTierOverviewMatrix.toolCount", {
              count: filteredTools.length,
            })}
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
  tools: Array<{
    name: string;
    description: string;
  }>;
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
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
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
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
              <p>
                <span className="font-medium">{formatToolName(tool.name)}</span>
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
