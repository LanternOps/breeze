import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { ActionError, runAction } from "../../lib/runAction";
import { showToast } from "../shared/Toast";
import { BuiltinIconTile } from "./builtinPresentation";
import {
  INTEGRATION_PROVIDERS,
  getProviderBranding,
  type IntegrationProvider,
} from "./providerBranding";

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
  /**
   * Integration providers whose package is already a catalog card. Leave it
   * undefined until the catalog has loaded: an unknown catalog must not offer
   * "connect Huntress" to a partner who already has it.
   */
  providersInCatalog?: readonly IntegrationProvider[];
  /** Called with the new/restored catalog id after a successful provision, so the catalog list refreshes. */
  onProvisioned?: (catalogId: string) => void;
  /** Hands the loaded rows to the parent (the catalog detail shows requiredVars / uninstallCommand). */
  onPackagesLoaded?: (rows: BuiltinPackageRow[]) => void;
};

function isRow(value: unknown): value is BuiltinPackageRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.key === "string" && typeof row.name === "string" && Array.isArray(row.requiredVars);
}

const ROW_ACTION =
  "inline-flex h-8 items-center justify-center rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

/** A built-in that is not in the catalog yet: what it is, what it needs, the one step that adds it. */
function AvailableRow({
  rowKey,
  name,
  meta,
  requirement,
  action,
}: {
  rowKey: string;
  name: string;
  meta: ReactNode;
  requirement: ReactNode;
  action: ReactNode;
}) {
  return (
    <li
      data-testid={`builtin-package-row-${rowKey}`}
      className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:gap-6"
    >
      <div className="flex min-w-0 items-center gap-3 md:flex-1">
        <BuiltinIconTile size="sm" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">{meta}</p>
        </div>
      </div>
      <div className="text-xs text-muted-foreground md:w-72 md:shrink-0">{requirement}</div>
      <div className="flex shrink-0 items-center gap-3 md:w-48 md:justify-end">{action}</div>
    </li>
  );
}

/**
 * The built-in packages a partner has not added to the catalog yet, both kinds
 * in one list: Breeze-pinned packages (the DNS filtering clients, #6958),
 * added here, and integration agents (Huntress, SentinelOne), added by
 * connecting the integration. Once a built-in is in the catalog its card in
 * the library is its home and it leaves this list, so the panel disappears
 * when there is nothing left to add.
 *
 * Rendered by SoftwareCatalog for partner scope only; org scope never sees it
 * (the API is partner/system only). Provisioning is gated server-side on full
 * partner access, devices.execute and MFA; the button always renders and a
 * denial is toasted. Permissions are not pre-computed client-side.
 */
export default function BuiltinPackagesPanel({ providersInCatalog, onProvisioned, onPackagesLoaded }: Props) {
  useTranslation("policies");
  const [rows, setRows] = useState<BuiltinPackageRow[]>([]);
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

  // Pinned packages still to add (never added, or archived and restorable).
  const pinnedAvailable = rows.filter((row) => !row.catalogId || row.archived);
  const integrationsAvailable = providersInCatalog
    ? INTEGRATION_PROVIDERS.filter((provider) => !providersInCatalog.includes(provider))
    : [];

  // Nothing to offer (or not known yet): no panel. Only a failed load keeps it up on its own.
  if (!loadFailed && pinnedAvailable.length === 0 && integrationsAvailable.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card shadow-xs" data-testid="builtin-packages-panel">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{i18n.t("policies:software.builtinPackagesPanel.title")}</h2>
        <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
          {i18n.t("policies:software.builtinPackagesPanel.description")}
        </p>
      </div>

      {loadFailed && (
        <p className="px-4 py-3 text-sm text-destructive" role="alert" data-testid="builtin-packages-error">
          {i18n.t("policies:software.builtinPackagesPanel.couldNotLoadBuiltinPackages")}
        </p>
      )}

      <ul className="divide-y">
        {pinnedAvailable.map((row) => (
          <AvailableRow
            key={row.key}
            rowKey={row.key}
            name={row.name}
            meta={
              <>
                {row.vendor}
                {" · "}
                {row.os === "macos"
                  ? i18n.t("policies:software.softwareVersionManager.macOS")
                  : i18n.t("policies:software.softwareVersionManager.windows")}
                {" · "}
                <span className="font-mono">{row.version}</span>
              </>
            }
            requirement={
              <>
                <span className="flex flex-wrap gap-1">
                  {row.requiredVars.map((name) => (
                    <code key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {name}
                    </code>
                  ))}
                </span>
                <a
                  href="/settings/variables"
                  data-testid={`builtin-package-vars-link-${row.key}`}
                  className="mt-1 inline-block text-primary hover:underline"
                >
                  {i18n.t("policies:software.builtinPackagesPanel.setVariablesPerOrganization")}
                </a>
              </>
            }
            action={
              <>
                {row.archived && (
                  <span>{i18n.t("policies:software.builtinPackagesPanel.archived")}</span>
                )}
                <button
                  type="button"
                  disabled={busyKey === row.key}
                  onClick={() => void provision(row)}
                  data-testid={`builtin-package-${row.archived ? "restore" : "add"}-${row.key}`}
                  className={ROW_ACTION}
                >
                  {busyKey === row.key
                    ? i18n.t("policies:software.builtinPackagesPanel.adding")
                    : row.archived
                      ? i18n.t("policies:software.builtinPackagesPanel.restoreToCatalog")
                      : i18n.t("policies:software.builtinPackagesPanel.addToCatalog")}
                </button>
              </>
            }
          />
        ))}
        {integrationsAvailable.map((provider) => {
          const branding = getProviderBranding(provider);
          return (
            <AvailableRow
              key={provider}
              rowKey={provider}
              name={branding.label}
              meta={branding.blurb}
              requirement={i18n.t("policies:software.builtinPackagesPanel.addedWhenConnected", {
                provider: branding.label,
              })}
              action={
                <a
                  href={branding.setupHref}
                  data-testid={`builtin-package-connect-${provider}`}
                  className={ROW_ACTION}
                >
                  {i18n.t("policies:software.builtinPackagesPanel.connectInIntegrations")}
                </a>
              }
            />
          );
        })}
      </ul>
    </section>
  );
}
