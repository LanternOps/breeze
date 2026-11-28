import {
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Loader2,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getProviderBranding,
  type IntegrationProvider,
} from "./providerBranding";
import { firstGap, type EdrReadiness } from "./useEdrReadiness";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
/**
 * Detail body for an integration built-in (Huntress, SentinelOne). Same shape
 * as KeyedBuiltinDetail: a line about the package, one setup block, Deploy.
 * The dialog header owns the name, icon and "Built-in" pill.
 */
export interface BuiltinPackageDetailProps {
  provider: IntegrationProvider;
  readiness: EdrReadiness;
  onDeploy: () => void;
}
export default function BuiltinPackageDetail({
  provider,
  readiness,
  onDeploy,
}: BuiltinPackageDetailProps) {
  useTranslation("policies");
  const branding = getProviderBranding(provider);
  const ready = readiness.status === "ready";
  const gap = firstGap(readiness);
  const disabled = readiness.status === "incomplete";
  const deployTitle =
    disabled && gap
      ? `Resolve: ${gap.label}`
      : i18n.t("policies:software.softwareCatalog.deploysToMappedOrganizationsOnly");
  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">{branding.blurb}</p>
        {branding.websiteUrl && (
          <a
            href={branding.websiteUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {branding.label}{" "}
            {i18n.t("policies:software.builtinPackageDetail.website")}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="rounded-md border bg-muted/30 p-4">
        {readiness.status === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t("policies:software.builtinPackageDetail.checkingSetup")}
          </div>
        )}
        {readiness.status === "unknown" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <HelpCircle className="h-4 w-4" />
            {i18n.t(
              "policies:software.builtinPackageDetail.couldnTVerifySetupDeployWillConfirm",
            )}
          </div>
        )}
        {(ready || readiness.status === "incomplete") && (
          <ul className="space-y-2">
            {readiness.checks.map((c) => (
              <li key={c.key} className="flex items-center gap-2 text-sm">
                {c.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-success-ink" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning-strong" />
                )}
                <span className={cn(!c.ok && "font-medium")}>{c.label}</span>
                {/* The first gap's detail is shown in the Next-step box below; don't repeat it here. */}
                {c.detail && c.key !== gap?.key && (
                  <span className="text-xs text-muted-foreground">
                    · {c.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {ready && (
          <p className="mt-3 text-sm font-medium text-success-ink">
            {typeof readiness.mappedOrgCount === "number"
              ? i18n.t("policies:software.builtinPackageDetail.readyToDeployMapped", {
                  count: readiness.mappedOrgCount,
                  suffix: readiness.mappedOrgCount === 1 ? "" : "s",
                })
              : i18n.t("policies:software.builtinPackageDetail.readyToDeployStandalone")}
          </p>
        )}
        {disabled && gap && (
          <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium">
              {i18n.t("policies:software.builtinPackageDetail.nextStep")}
              {gap.label}
            </p>
            {gap.detail && (
              <p className="mt-0.5 text-muted-foreground">{gap.detail}</p>
            )}
            {gap.fixHref && (
              <a
                href={gap.fixHref}
                className="mt-1 inline-flex items-center gap-1 text-xs font-medium underline"
              >
                {gap.fixHref === "/integrations"
                  ? i18n.t(
                      "policies:software.builtinPackageDetail.openIntegrations",
                    )
                  : i18n.t("policies:software.builtinPackageDetail.goToSetup")}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={disabled}
          title={deployTitle}
          onClick={onDeploy}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {i18n.t("policies:software.builtinPackageDetail.deploy")}
        </button>
      </div>
    </div>
  );
}
