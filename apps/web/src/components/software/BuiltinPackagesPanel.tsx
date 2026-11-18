import { useCallback, useEffect, useState } from "react";
import { Copy, Loader2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { ActionError, runAction } from "../../lib/runAction";
import { showToast } from "../shared/Toast";

/** One row of GET /software/builtin-packages (#6958 D2). */
export type BuiltinPackageRow = {
  key: string;
  name: string;
  vendor: string;
  os: "windows" | "macos";
  version: string;
  fileType: string;
  requiredVars: string[];
  uninstallCommand: string;
  catalogId: string | null;
  archived: boolean;
};

type Props = {
  /** Called with the new/restored catalog id after a successful provision, so the catalog list refreshes. */
  onProvisioned?: (catalogId: string) => void;
  /** Opens the provisioned catalog card. */
  onOpenCatalogItem?: (catalogId: string) => void;
  /** Hands the loaded rows to the parent (the catalog detail shows requiredVars / uninstallCommand). */
  onPackagesLoaded?: (rows: BuiltinPackageRow[]) => void;
};

function isRow(value: unknown): value is BuiltinPackageRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.key === "string" && typeof row.name === "string" && Array.isArray(row.requiredVars);
}

/**
 * Breeze-pinned built-in packages (the DNS filtering clients, #6958). Rendered by
 * SoftwareCatalog for partner scope only; org scope never sees it (the API is
 * partner/system only). Provisioning is gated server-side on full partner access,
 * devices.execute and MFA; the button always renders and a denial is toasted —
 * permissions are not pre-computed client-side.
 */
export default function BuiltinPackagesPanel({ onProvisioned, onOpenCatalogItem, onPackagesLoaded }: Props) {
  useTranslation("policies");
  const [rows, setRows] = useState<BuiltinPackageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/software/builtin-packages");
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { data?: unknown };
      const raw: unknown[] = Array.isArray(payload?.data) ? payload.data : [];
      const next = raw.filter(isRow);
      // A shape drift must surface, never quietly hide the panel.
      if (next.length !== raw.length) {
        throw new Error(`unexpected row shape (${raw.length - next.length} of ${raw.length} rows)`);
      }
      setRows(next);
      setLoadFailed(false);
      onPackagesLoaded?.(next);
    } catch (err) {
      console.error("[BuiltinPackagesPanel] loading built-in packages failed:", err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [onPackagesLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const provision = async (row: BuiltinPackageRow) => {
    setBusyKey(row.key);
    try {
      const result = await runAction<{ catalogId: string; versionId: string }>({
        request: () =>
          fetchWithAuth(`/software/builtin-packages/${encodeURIComponent(row.key)}`, { method: "POST" }),
        errorFallback: i18n.t("policies:software.builtinPackagesPanel.couldNotAddToCatalog", { name: row.name }),
        successMessage: i18n.t("policies:software.builtinPackagesPanel.addedToCatalog", { name: row.name }),
      });
      await load();
      onProvisioned?.(result.catalogId);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({
          type: "error",
          message: i18n.t("policies:software.builtinPackagesPanel.couldNotAddToCatalog", { name: row.name }),
        });
      }
    } finally {
      setBusyKey(null);
    }
  };

  const copyUninstall = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      showToast({ type: "success", message: i18n.t("policies:software.builtinPackagesPanel.uninstallCommandCopied") });
    } catch {
      // Clipboard can be unavailable (insecure context, denied permission);
      // the command stays selectable for a manual copy.
      showToast({ type: "error", message: i18n.t("policies:software.builtinPackagesPanel.copyFailed") });
    }
  };

  if (!loading && !loadFailed && rows.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card" data-testid="builtin-packages-panel">
      <div className="flex items-start gap-3 border-b px-4 py-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div>
          <h2 className="font-semibold">{i18n.t("policies:software.builtinPackagesPanel.title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {i18n.t("policies:software.builtinPackagesPanel.description")}
          </p>
        </div>
      </div>

      {loading && (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {i18n.t("policies:software.builtinPackagesPanel.loadingBuiltinPackages")}
        </p>
      )}

      {!loading && loadFailed && (
        <p className="px-4 py-4 text-sm text-destructive" role="alert" data-testid="builtin-packages-error">
          {i18n.t("policies:software.builtinPackagesPanel.couldNotLoadBuiltinPackages")}
        </p>
      )}

      {!loading && !loadFailed && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{i18n.t("policies:software.builtinPackagesPanel.colPackage")}</th>
                <th className="px-4 py-2 font-medium">{i18n.t("policies:software.builtinPackagesPanel.colPlatform")}</th>
                <th className="px-4 py-2 font-medium">{i18n.t("policies:software.builtinPackagesPanel.colPinnedVersion")}</th>
                <th className="px-4 py-2 font-medium">{i18n.t("policies:software.builtinPackagesPanel.colRequiredVariables")}</th>
                <th className="px-4 py-2 font-medium">{i18n.t("policies:software.builtinPackagesPanel.colUninstallCommand")}</th>
                <th className="px-4 py-2 font-medium text-right">{i18n.t("policies:software.builtinPackagesPanel.colStatus")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.key} data-testid={`builtin-package-row-${row.key}`} className="align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">{row.vendor}</p>
                  </td>
                  <td className="px-4 py-3">
                    {row.os === "macos"
                      ? i18n.t("policies:software.softwareVersionManager.macOS")
                      : i18n.t("policies:software.softwareVersionManager.windows")}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{row.version}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {row.requiredVars.map((name) => (
                        <code key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {name}
                        </code>
                      ))}
                    </div>
                    <a
                      href="/settings/variables"
                      data-testid={`builtin-package-vars-link-${row.key}`}
                      className="mt-1 inline-block text-xs text-primary hover:underline"
                    >
                      {i18n.t("policies:software.builtinPackagesPanel.setVariablesPerOrganization")}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-1">
                      <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs select-all">
                        {row.uninstallCommand}
                      </code>
                      <button
                        type="button"
                        onClick={() => void copyUninstall(row.uninstallCommand)}
                        aria-label={i18n.t("policies:software.builtinPackagesPanel.copyUninstallCommand")}
                        title={i18n.t("policies:software.builtinPackagesPanel.copyUninstallCommand")}
                        data-testid={`builtin-package-copy-${row.key}`}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border hover:bg-muted"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {i18n.t("policies:software.builtinPackagesPanel.breezeDoesNotUninstall")}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {row.catalogId && !row.archived ? (
                      <button
                        type="button"
                        onClick={() => onOpenCatalogItem?.(row.catalogId!)}
                        data-testid={`builtin-package-in-catalog-${row.key}`}
                        className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400"
                      >
                        {i18n.t("policies:software.builtinPackagesPanel.inCatalog")}
                      </button>
                    ) : row.catalogId && row.archived ? (
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-xs text-muted-foreground">
                          {i18n.t("policies:software.builtinPackagesPanel.archived")}
                        </span>
                        <button
                          type="button"
                          disabled={busyKey === row.key}
                          onClick={() => void provision(row)}
                          data-testid={`builtin-package-restore-${row.key}`}
                          className="inline-flex h-8 items-center justify-center rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                        >
                          {busyKey === row.key
                            ? i18n.t("policies:software.builtinPackagesPanel.adding")
                            : i18n.t("policies:software.builtinPackagesPanel.restoreToCatalog")}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busyKey === row.key}
                        onClick={() => void provision(row)}
                        data-testid={`builtin-package-add-${row.key}`}
                        className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                      >
                        {busyKey === row.key
                          ? i18n.t("policies:software.builtinPackagesPanel.adding")
                          : i18n.t("policies:software.builtinPackagesPanel.addToCatalog")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
