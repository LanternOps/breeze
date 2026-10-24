import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { ownerKind, type YaraRuleSetSummary } from "./ruleSetsApi";

const BADGE = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";

/**
 * Owner + status badges for a rule set, shared by the Detection rules list and
 * editor and the Security tab picker. Status badges ("Has errors", "Not
 * published", "Disabled") describe the set; they never mean "unavailable".
 */
export default function RuleSetBadges({
  set,
  testIdPrefix = "rule-set-badge",
}: {
  set: Pick<YaraRuleSetSummary, "isBuiltin" | "orgId" | "stale" | "publishedVersion" | "enabled">;
  testIdPrefix?: string;
}) {
  const { t } = useTranslation("security");
  const owner = ownerKind(set);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {owner === "builtin" && (
        <span data-testid={`${testIdPrefix}-builtin`} className={`${BADGE} border-primary/40 bg-primary/10 text-primary`}>
          {t("detectionRules.badges.builtin")}
        </span>
      )}
      {owner === "partner" && (
        <span data-testid={`${testIdPrefix}-all-orgs`} className={`${BADGE} border-blue-500/40 bg-blue-500/10 text-blue-700`}>
          {t("detectionRules.badges.allOrgs")}
        </span>
      )}
      {set.stale && (
        <span data-testid={`${testIdPrefix}-errors`} className={`${BADGE} border-destructive/40 bg-destructive/10 text-destructive`}>
          {t("detectionRules.badges.errors")}
        </span>
      )}
      {set.publishedVersion === 0 && (
        <span data-testid={`${testIdPrefix}-unpublished`} className={`${BADGE} border-amber-500/40 bg-amber-500/10 text-amber-700`}>
          {t("detectionRules.badges.unpublished")}
        </span>
      )}
      {!set.enabled && (
        <span data-testid={`${testIdPrefix}-disabled`} className={`${BADGE} bg-muted text-muted-foreground`}>
          {t("detectionRules.badges.disabled")}
        </span>
      )}
    </span>
  );
}
