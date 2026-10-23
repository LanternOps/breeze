import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useOrgStore } from "@/stores/orgStore";
import { ownerKind, type YaraRuleSetSummary } from "./ruleSetsApi";
import RuleSetBadges from "./RuleSetBadges";

export function useOwnerLabel() {
  const { t } = useTranslation("security");
  const organizations = useOrgStore((s) => s.organizations);
  return (set: Pick<YaraRuleSetSummary, "isBuiltin" | "orgId">): string => {
    const kind = ownerKind(set);
    if (kind === "builtin") return t("detectionRules.owner.builtin");
    if (kind === "partner") return t("detectionRules.owner.allOrgs");
    return organizations.find((o) => o.id === set.orgId)?.name ?? t("detectionRules.owner.organization");
  };
}

export default function RuleSetList({
  sets,
  onSelect,
}: {
  sets: YaraRuleSetSummary[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("security");
  const ownerLabel = useOwnerLabel();

  if (sets.length === 0) {
    return (
      <p data-testid="rule-set-list-empty" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t("detectionRules.empty")}
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid="rule-set-list">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">{t("detectionRules.columns.name")}</th>
            <th className="px-4 py-2 font-medium">{t("detectionRules.columns.owner")}</th>
            <th className="px-4 py-2 font-medium">{t("detectionRules.columns.rules")}</th>
            <th className="px-4 py-2 font-medium">{t("detectionRules.columns.published")}</th>
          </tr>
        </thead>
        <tbody>
          {sets.map((set) => (
            <tr
              key={set.id}
              data-testid={`rule-set-row-${set.id}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(set.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(set.id);
                }
              }}
              className="cursor-pointer border-t hover:bg-muted/40 focus:bg-muted/40 focus:outline-hidden"
            >
              <td className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{set.name}</span>
                  <RuleSetBadges set={set} />
                </div>
                {set.description && (
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{set.description}</p>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{ownerLabel(set)}</td>
              <td className="px-4 py-3 tabular-nums">{set.ruleCount}</td>
              <td className="px-4 py-3 tabular-nums text-muted-foreground">
                {set.publishedVersion > 0
                  ? t("detectionRules.publishedVersion", { version: set.publishedVersion })
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
