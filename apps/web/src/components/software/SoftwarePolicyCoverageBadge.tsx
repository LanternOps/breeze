import { useEffect, useState } from "react";
import { AlertTriangle, MonitorCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "../../stores/auth";
import { competitorList, type SoftwarePolicyCoverage } from "./softwarePolicyCompetitors";

/**
 * #9635 — how many devices a software policy actually governs. A device
 * follows ONE software policy (closest assignment, then priority, then age), so
 * a policy can be assigned yet apply to no device; this says so, and names the
 * policy that wins instead. Read-only; renders nothing until it has an answer.
 */
export default function SoftwarePolicyCoverageBadge({ policyId }: { policyId: string }) {
  const { t } = useTranslation("policies");
  const [coverage, setCoverage] = useState<SoftwarePolicyCoverage | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCoverage(null);
    // Promise.resolve().then: a synchronous throw from the fetch helper lands in
    // .catch instead of crashing the row the badge sits in.
    Promise.resolve()
      .then(() => fetchWithAuth(`/software-policies/${policyId}/coverage`))
      .then(async (res) => {
        if (!res?.ok) {
          if (!cancelled) {
            console.warn(`[SoftwarePolicyCoverageBadge] coverage for ${policyId} answered ${res?.status}`);
          }
          return;
        }
        const json = await res.json();
        const data = json?.data;
        if (
          !data ||
          typeof data.appliesToDeviceCount !== "number" ||
          typeof data.assignedDeviceCount !== "number" ||
          !Array.isArray(data.overriddenBy)
        ) {
          console.warn(`[SoftwarePolicyCoverageBadge] malformed coverage for ${policyId}`);
          return;
        }
        if (!cancelled) setCoverage(data as SoftwarePolicyCoverage);
      })
      .catch((err) => {
        console.warn(`[SoftwarePolicyCoverageBadge] failed to load coverage for ${policyId}:`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [policyId]);

  if (!coverage) return null;

  const names = competitorList(coverage.overriddenBy);
  const chip = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium";

  if (coverage.appliesToDeviceCount > 0) {
    return (
      <span
        data-testid="software-policy-coverage"
        data-state="applies"
        className={`${chip} border-muted bg-muted/40 text-muted-foreground`}
        title={
          coverage.overriddenBy.length > 0
            ? t("software.policyCoverage.partlyOverriddenHint", { names })
            : undefined
        }
      >
        <MonitorCheck className="h-3 w-3" />
        {t("software.policyCoverage.appliesTo", { count: coverage.appliesToDeviceCount })}
      </span>
    );
  }

  if (coverage.overriddenBy.length === 0) {
    return (
      <span
        data-testid="software-policy-coverage"
        data-state="unassigned"
        className={`${chip} border-muted bg-muted/40 text-muted-foreground`}
        title={t("software.policyCoverage.notAssigned")}
      >
        {t("software.policyCoverage.appliesToNone")}
      </span>
    );
  }

  return (
    <span
      data-testid="software-policy-coverage"
      data-state="overridden"
      className={`${chip} border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300`}
      title={t("software.policyCoverage.overriddenHint", { names })}
    >
      <AlertTriangle className="h-3 w-3" />
      {t("software.policyCoverage.appliesToNone")}
      <span aria-hidden="true">·</span>
      <span data-testid="software-policy-overridden-by">
        {t("software.policyCoverage.overriddenBy", { names })}
      </span>
    </span>
  );
}
