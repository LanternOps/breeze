import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { showToast } from "../shared/Toast";
import type { BuiltinPackageRow } from "./BuiltinPackagesPanel";

/**
 * Detail body for a Breeze-pinned built-in (#6958). Same shape as
 * BuiltinPackageDetail: a line about the package, one setup block, Deploy.
 * Edit/delete/new-version are not offered (the API answers 403 outside system
 * scope). The required tenant variables and the documented uninstall command
 * come from GET /software/builtin-packages, which is partner scope only, so an
 * org-scope user gets the hint and Deploy without the setup block.
 */
export default function KeyedBuiltinDetail({
  row,
  onDeploy,
}: {
  row: BuiltinPackageRow | undefined;
  onDeploy: () => void;
}) {
  useTranslation("policies");

  const copyUninstall = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      showToast({
        type: "success",
        message: i18n.t("policies:software.builtinPackagesPanel.uninstallCommandCopied"),
      });
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission);
      // the command stays selectable for a manual copy.
      showToast({
        type: "error",
        message: i18n.t("policies:software.builtinPackagesPanel.copyFailed"),
      });
    }
  };

  return (
    <div data-testid="builtin-catalog-detail" className="space-y-5">
      <p className="text-sm text-muted-foreground">
        {i18n.t("policies:software.softwareCatalog.managedByBreezeHint")}
      </p>
      {row && (
        <div className="rounded-md border bg-muted/30 p-4">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="font-medium">
              {i18n.t("policies:software.softwareCatalog.requiredVariables")}
            </dt>
            <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {row.requiredVars.map((name) => (
                <code key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {name}
                </code>
              ))}
              <a href="/settings/variables" className="text-xs text-primary hover:underline">
                {i18n.t("policies:software.builtinPackagesPanel.setVariablesPerOrganization")}
              </a>
            </dd>
            <dt className="font-medium">
              {i18n.t("policies:software.softwareCatalog.uninstallCommand")}
            </dt>
            <dd>
              <div className="flex items-start gap-1.5">
                <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs select-all">
                  {row.uninstallCommand}
                </code>
                <button
                  type="button"
                  onClick={() => void copyUninstall(row.uninstallCommand)}
                  aria-label={i18n.t("policies:software.builtinPackagesPanel.copyUninstallCommand")}
                  title={i18n.t("policies:software.builtinPackagesPanel.copyUninstallCommand")}
                  data-testid="builtin-detail-copy-uninstall"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border bg-background hover:bg-muted"
                >
                  <Copy className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t("policies:software.builtinPackagesPanel.breezeDoesNotUninstall")}
              </p>
            </dd>
          </dl>
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDeploy}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {i18n.t("policies:software.softwareCatalog.deploy2")}
        </button>
      </div>
    </div>
  );
}
