import { AlertTriangle, Target } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { AssignmentFilterBadges } from "./AssignmentRoleOsFilters";
import {
  appliesToState,
  formatAppliesToTargets,
  notAppliedTone,
  type ConfigPolicyAppliesToSummary,
  type ConfigPolicyStatus,
} from "./appliesToSummary";

type AppliesToStripProps = {
  /** null = the API did not send a usable summary: claim nothing. */
  summary: ConfigPolicyAppliesToSummary | null;
  status: ConfigPolicyStatus;
  onEdit: () => void;
};

const hasFilters = (roleFilter: string[] | null, osFilter: string[] | null) =>
  (roleFilter?.length ?? 0) > 0 || (osFilter?.length ?? 0) > 0;

// Where this policy applies, always visible above the feature tabs (#12306).
// It reads the API's unfiltered count, so a caller who may not list a row
// still sees the policy as applied ("+1"), never as "Not applied".
export default function AppliesToStrip({ summary, status, onEdit }: AppliesToStripProps) {
  const { t } = useTranslation(["policies", "common"]);
  const state = summary ? appliesToState(summary) : null;
  const tone = state ? notAppliedTone(status, state) : null;
  const showAssign = state === "not_applied" && tone !== null;

  const unknown = (
    <span className="text-sm text-muted-foreground">
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{t("policies:configurationPolicies.appliesToStrip.unknownState")}</span>
    </span>
  );

  let body = unknown;
  if (summary && state === "applied") {
    const { shown, more } = formatAppliesToTargets(summary);
    body = (
      <ul className="flex min-w-0 flex-wrap items-center gap-2">
        {shown.map((target) => (
          <li
            key={target.key}
            data-testid="config-policy-applies-to-target"
            className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-0.5 text-sm"
          >
            <span data-testid="config-policy-applies-to-target-name" className="font-medium text-foreground">
              {target.text}
            </span>
            {hasFilters(target.roleFilter, target.osFilter) && (
              <AssignmentFilterBadges roleFilter={target.roleFilter} osFilter={target.osFilter} />
            )}
          </li>
        ))}
        {more > 0 && (
          <li data-testid="config-policy-applies-to-more" className="text-sm font-medium text-muted-foreground">
            +{more}
            <span className="sr-only">
              {" "}
              {t("policies:configurationPolicies.appliesToStrip.moreTargets", { count: more })}
            </span>
          </li>
        )}
      </ul>
    );
  } else if (summary && state === "in_use_through_children") {
    body = (
      <span data-testid="config-policy-applies-to-in-use" className="text-sm text-foreground">
        {t("policies:configurationPolicies.appliesToStrip.inUseCount", { count: summary.childPolicyCount })}
      </span>
    );
  } else if (state === "not_applied" && tone === "warning") {
    body = (
      <span
        data-testid="config-policy-applies-to-not-applied"
        data-tone="warning"
        className="inline-flex items-start gap-2 text-sm font-medium text-warning"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        {t("policies:configurationPolicies.appliesToStrip.notAppliedWarning")}
      </span>
    );
  } else if (state === "not_applied" && tone === "neutral") {
    body = (
      <span
        data-testid="config-policy-applies-to-not-applied"
        data-tone="neutral"
        className="text-sm text-muted-foreground"
      >
        {t("policies:configurationPolicies.appliesToStrip.notAppliedNeutral")}
      </span>
    );
  }

  return (
    <section
      data-testid="config-policy-applies-to-strip"
      aria-labelledby="config-policy-applies-to-heading"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-card px-4 py-3 shadow-xs",
        tone === "warning" && "border-warning/40 bg-warning/10",
      )}
    >
      <h2
        id="config-policy-applies-to-heading"
        className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-foreground"
      >
        <Target className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {t("policies:configurationPolicies.appliesToStrip.heading")}
      </h2>
      <div className="min-w-0 flex-1">{body}</div>
      {showAssign ? (
        <button
          type="button"
          onClick={onEdit}
          data-testid="config-policy-applies-to-assign"
          className={cn(
            "h-8 shrink-0 rounded-md px-3 text-sm font-medium transition",
            tone === "warning"
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "border hover:bg-muted",
          )}
        >
          {t("policies:configurationPolicies.appliesToStrip.assignButton")}
        </button>
      ) : (
        <button
          type="button"
          onClick={onEdit}
          data-testid="config-policy-applies-to-edit"
          className="h-8 shrink-0 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
        >
          {t("common:actions.edit")}
        </button>
      )}
    </section>
  );
}
