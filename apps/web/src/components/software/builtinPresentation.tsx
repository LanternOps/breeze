import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { i18n } from "@/lib/i18n";
import type { EdrReadiness } from "./useEdrReadiness";

/**
 * One presentation for every built-in package. A built-in reaches the catalog
 * one of two ways: the partner adds a Breeze-pinned package (Control D,
 * NextDNS; `builtinPackageKey`), or connecting an integration adds its agent
 * (Huntress, SentinelOne; `integrationProvider`). How it got there is the only
 * difference, so the icon tile, the "Built-in" pill and the status chip are
 * shared and none of them is coloured per vendor.
 */
export function isBuiltinItem(item: {
  integrationProvider?: string;
  builtinPackageKey?: string;
}): boolean {
  return Boolean(item.integrationProvider || item.builtinPackageKey);
}

const TILE_SIZES = {
  sm: { tile: "h-9 w-9", icon: "h-4 w-4" },
  md: { tile: "h-10 w-10", icon: "h-5 w-5" },
  lg: { tile: "h-12 w-12", icon: "h-6 w-6" },
} as const;

export function BuiltinIconTile({ size = "md" }: { size?: keyof typeof TILE_SIZES }) {
  const { tile, icon } = TILE_SIZES[size];
  return (
    <div
      data-testid="builtin-icon"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground",
        tile,
      )}
    >
      <ShieldCheck className={icon} aria-hidden="true" />
    </div>
  );
}

const CHIP =
  "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium";

export function BuiltinPill({ testId = "builtin-pill" }: { testId?: string }) {
  useTranslation("policies");
  return (
    <span
      data-testid={testId}
      className={cn(CHIP, "border-primary/30 bg-primary/10 text-primary-ink")}
    >
      {i18n.t("policies:software.softwareCatalog.builtIn")}
    </span>
  );
}

/**
 * Setup state of a built-in whose readiness the console can check (the
 * integration built-ins). A pinned package has no check behind it, so it
 * shows no chip instead of an unbacked "Ready".
 */
export function ReadinessPill({ status }: { status: EdrReadiness["status"] }) {
  useTranslation("policies");
  if (status === "ready")
    return (
      <span className={cn(CHIP, "border-success/30 bg-success/15 text-success-ink")}>
        {i18n.t("policies:software.softwareCatalog.ready")}
      </span>
    );
  if (status === "incomplete")
    return (
      <span className={cn(CHIP, "border-warning/30 bg-warning/15 text-warning-ink")}>
        {i18n.t("policies:software.softwareCatalog.setupNeeded")}
      </span>
    );
  if (status === "loading")
    return (
      <span className="text-xs text-muted-foreground">
        {i18n.t("policies:software.softwareCatalog.checking")}
      </span>
    );
  return null;
}
