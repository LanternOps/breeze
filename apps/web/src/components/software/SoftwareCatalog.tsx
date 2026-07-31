import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Package,
  X,
  Rocket,
  Plus,
  Trash2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError } from "../../lib/runAction";
import { useHashState } from "@/lib/useHashState";
import { Dialog } from "../shared/Dialog";
import DeploymentWizard from "./DeploymentWizard";
import DeploymentList from "./DeploymentList";
import DeploymentProgress from "./DeploymentProgress";
import SoftwareVersionManager from "./SoftwareVersionManager";
import AddPackageModal, { type CreatedPackage } from "./AddPackageModal";
import {
  getProviderBranding,
  isIntegrationProvider,
  type IntegrationProvider,
} from "./providerBranding";
import { asList } from '@/lib/asList';
import { useEdrReadiness, type EdrReadiness } from "./useEdrReadiness";
import BuiltinPackageDetail from "./BuiltinPackageDetail";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type SoftwareItem = {
  id: string;
  /** Owning org for an org-scoped (non-built-in) package; unset for partner-scoped built-ins. */
  orgId?: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  createdAt: string;
  /** Set for built-in integration packages (e.g. Huntress, SentinelOne). */
  integrationProvider?: IntegrationProvider;
  partnerId?: string;
  /** Number of uploaded versions; built-in S1 needs >=1 before it can deploy. */
  versionCount?: number;
};
/**
 * A built-in package whose installer binary must be uploaded before it can deploy
 * (SentinelOne ships no derivable download URL — the partner uploads the MSI once).
 */
const needsInstallerUpload = (item: SoftwareItem): boolean =>
  item.integrationProvider === "sentinelone" && (item.versionCount ?? 0) === 0;
/**
 * Hash grammar for /software (URL state lives in the hash per repo convention):
 *   (empty) | #catalog     → Catalog tab (default)
 *   #deployments           → Deployments tab: summary cards + deployment list
 *   #deployment=<id>       → Deployments tab: a single deployment's progress
 *   #deploy=<id>,<id>,...  → consumed on arrival (#2866): opens the deploy
 *                            wizard with those devices pre-selected, then the
 *                            hash is cleared via replaceState so a refresh
 *                            doesn't re-open the wizard.
 */
type CatalogView =
  | { tab: "catalog" }
  | { tab: "deployments"; deploymentId?: string };
function parseCatalogView(hash: string): CatalogView | undefined {
  if (hash === "catalog") return { tab: "catalog" };
  if (hash === "deployments") return { tab: "deployments" };
  if (hash.startsWith("deployment=")) {
    const id = hash.slice("deployment=".length);
    if (id) return { tab: "deployments", deploymentId: id };
  }
  return undefined;
}
/** Shape of GET /software/deployments/summary → data. */
type DeploymentSummary = {
  active: number;
  scheduled: number;
  completedLast7d: number;
  failedLast7d: number;
};
const categoryStyles: Record<string, string> = {
  browser: "bg-blue-500/20 text-blue-700 border-blue-500/40",
  utility: "bg-amber-500/20 text-amber-700 border-amber-500/40",
  developer: "bg-purple-500/20 text-purple-700 border-purple-500/40",
  communication: "bg-emerald-500/20 text-emerald-700 border-emerald-500/40",
  security: "bg-red-500/20 text-red-700 border-red-500/40",
  productivity: "bg-slate-500/20 text-slate-700 border-slate-500/40",
  compression: "bg-orange-500/20 text-orange-700 border-orange-500/40",
  media: "bg-pink-500/20 text-pink-700 border-pink-500/40",
};
/** Small at-a-glance readiness chip for a built-in EDR card. */
function ReadinessPill({ status }: { status: EdrReadiness["status"] }) {
  useTranslation("policies");
  if (status === "ready")
    return (
      <span className="inline-flex items-center rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
        {i18n.t("policies:software.softwareCatalog.ready")}
      </span>
    );
  if (status === "incomplete")
    return (
      <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
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
export default function SoftwareCatalog() {
  useTranslation("policies");
  useTranslation("policies");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [selectedSoftware, setSelectedSoftware] = useState<SoftwareItem | null>(
    null,
  );
  const [showDeployWizard, setShowDeployWizard] = useState(false);
  const [deployCatalogId, setDeployCatalogId] = useState<string | undefined>();
  // Devices carried over from a device-list bulk selection (#2866); seeds the
  // wizard's target step when the modal was opened via #deploy=<ids>.
  const [deployDeviceIds, setDeployDeviceIds] = useState<
    string[] | undefined
  >();
  const [showAddModal, setShowAddModal] = useState(false);
  const [detailTab, setDetailTab] = useState<"details" | "versions">("details");
  const [catalogItems, setCatalogItems] = useState<SoftwareItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState<SoftwareItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Catalog vs. Deployments tab (+ selected deployment), driven by the URL
  // hash so deep links and back/forward work (see parseCatalogView).
  const [view, setView] = useHashState<CatalogView>(
    { tab: "catalog" },
    parseCatalogView,
  );
  const [summary, setSummary] = useState<DeploymentSummary | null>(null);
  const openDeploy = (catalogId?: string) => {
    setDeployCatalogId(catalogId);
    setDeployDeviceIds(undefined);
    setShowDeployWizard(true);
  };
  const closeDeployWizard = () => {
    setShowDeployWizard(false);
    setDeployCatalogId(undefined);
    setDeployDeviceIds(undefined);
  };
  const selectTab = (next: "catalog" | "deployments") => {
    if (typeof window !== "undefined") window.location.hash = next;
    setView(next === "catalog" ? { tab: "catalog" } : { tab: "deployments" });
  };
  const openDeploymentDetail = (id: string) => {
    if (typeof window !== "undefined")
      window.location.hash = `deployment=${id}`;
    setView({ tab: "deployments", deploymentId: id });
  };
  const backToDeployments = () => {
    if (typeof window !== "undefined") window.location.hash = "deployments";
    setView({ tab: "deployments" });
  };
  // "View deployment" from the wizard's success card: close the modal and jump
  // straight to that deployment's progress view.
  const handleViewDeployment = (id: string) => {
    closeDeployWizard();
    openDeploymentDetail(id);
  };
  // #2866: consume a #deploy=<id>,<id>,... hash (bulk selection carried over
  // from the devices pages) — open the wizard with those devices pre-selected,
  // then clear the hash so a refresh doesn't re-open it.
  useEffect(() => {
    const consumeDeployHash = () => {
      const raw = window.location.hash.replace(/^#/, "");
      if (!raw.startsWith("deploy=")) return;
      const ids = raw
        .slice("deploy=".length)
        .split(",")
        .filter(Boolean);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
      if (ids.length === 0) return;
      setDeployCatalogId(undefined); // no package preselected — user picks first
      setDeployDeviceIds(ids);
      setShowDeployWizard(true);
    };
    consumeDeployHash();
    window.addEventListener("hashchange", consumeDeployHash);
    return () => window.removeEventListener("hashchange", consumeDeployHash);
  }, []);
  // Summary cards for the Deployments tab. Re-runs whenever the list view
  // becomes active again (e.g. returning from a deployment's detail), so the
  // counts stay fresh without a manual refresh control.
  const deploymentsListActive =
    view.tab === "deployments" && !view.deploymentId;
  useEffect(() => {
    if (!deploymentsListActive) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth("/software/deployments/summary");
        if (!response.ok) return;
        const payload = await response.json();
        const data = (payload?.data ?? payload) as Record<
          string,
          unknown
        > | null;
        if (cancelled || !data) return;
        setSummary({
          active: Number(data.active ?? 0),
          scheduled: Number(data.scheduled ?? 0),
          completedLast7d: Number(data.completedLast7d ?? 0),
          failedLast7d: Number(data.failedLast7d ?? 0),
        });
      } catch {
        // Non-fatal read: the cards simply don't render; the list below still
        // loads (and surfaces its own errors).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deploymentsListActive]);
  const fetchCatalog = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth("/software/catalog");
      if (!response.ok)
        throw new Error(
          i18n.t(
            "policies:software.softwareCatalog.failedToFetchSoftwareCatalog",
          ),
        );
      const payload = await response.json();
      const data = asList(payload);
      if (Array.isArray(data)) {
        setCatalogItems(
          data.map((item: Record<string, unknown>) => ({
            id: String(item.id),
            orgId: item.orgId ? String(item.orgId) : undefined,
            name: String(item.name ?? ""),
            vendor: String(item.vendor ?? ""),
            category: String(item.category ?? "utility"),
            description: String(item.description ?? ""),
            createdAt: String(item.createdAt ?? ""),
            integrationProvider:
              item.integrationProvider === "huntress" ||
              item.integrationProvider === "sentinelone"
                ? item.integrationProvider
                : undefined,
            partnerId: item.partnerId ? String(item.partnerId) : undefined,
            versionCount:
              item.versionCount != null ? Number(item.versionCount) : undefined,
          })),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load catalog");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);
  const categories = useMemo(() => {
    const unique = new Set(catalogItems.map((item) => item.category));
    return Array.from(unique);
  }, [catalogItems]);
  const filteredSoftware = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return catalogItems.filter((item) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        item.name.toLowerCase().includes(normalizedQuery) ||
        item.vendor.toLowerCase().includes(normalizedQuery);
      const matchesCategory =
        category === "all" ? true : item.category === category;
      return matchesQuery && matchesCategory;
    });
  }, [query, category, catalogItems]);
  // Built-in EDR readiness: one fetch per present provider (there's one
  // integration per partner), shared by the cards and the detail panel.
  const builtinProviders = useMemo(
    () =>
      Array.from(
        new Set(
          catalogItems
            .map((i) => i.integrationProvider)
            .filter(isIntegrationProvider),
        ),
      ),
    [catalogItems],
  );
  const s1VersionCount = useMemo(
    () =>
      catalogItems.find((i) => i.integrationProvider === "sentinelone")
        ?.versionCount ?? 0,
    [catalogItems],
  );
  const readinessMap = useEdrReadiness(builtinProviders, { s1VersionCount });
  const handleCreated = (pkg: CreatedPackage) => {
    setCatalogItems((prev) => [
      {
        id: pkg.id,
        name: pkg.name,
        vendor: pkg.vendor,
        category: pkg.category,
        description: pkg.description,
        createdAt: pkg.createdAt,
        versionCount: pkg.versionCount,
      },
      ...prev,
    ]);
    setShowAddModal(false);
  };
  const handleDeletePackage = async (item: SoftwareItem) => {
    try {
      setDeleting(true);
      // Scope the DELETE to the package's own org. fetchWithAuth only auto-injects
      // an orgId when one is actively selected in the org switcher, so a
      // partner/system user in "All organizations" mode would otherwise send no
      // orgId and hit "orgId is required for this scope" (resolveScopedOrgId).
      const deleteUrl = item.orgId
        ? `/software/catalog/${item.id}?orgId=${item.orgId}`
        : `/software/catalog/${item.id}`;
      await runAction({
        request: () => fetchWithAuth(deleteUrl, { method: "DELETE" }),
        errorFallback: i18n.t(
          "policies:software.softwareCatalog.failedToDeletePackage",
        ),
        successMessage: `Deleted "${item.name}"`,
      });
      setCatalogItems((prev) => prev.filter((i) => i.id !== item.id));
      setConfirmDelete(null);
      setSelectedSoftware((prev) => (prev?.id === item.id ? null : prev));
    } catch (err) {
      handleActionError(
        err,
        i18n.t("policies:software.softwareCatalog.failedToDeletePackage"),
      );
    } finally {
      setDeleting(false);
    }
  };
  // Only the Catalog tab depends on the catalog fetch — a deep link to
  // #deployments must render immediately, not wait behind it.
  if (loading && view.tab === "catalog") {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            {i18n.t("policies:software.softwareCatalog.loadingSoftwareCatalog")}
          </p>
        </div>
      </div>
    );
  }
  const tabs: {
    key: "catalog" | "deployments";
    label: string;
    icon: typeof Package;
  }[] = [
    {
      key: "catalog",
      label: i18n.t("policies:software.softwareCatalog.catalogTab"),
      icon: Package,
    },
    {
      key: "deployments",
      label: i18n.t("policies:software.deploymentList.deployments"),
      icon: Rocket,
    },
  ];
  const summaryCards = summary
    ? [
        {
          key: "active",
          label: i18n.t("policies:software.deploymentList.inProgress"),
          value: summary.active,
        },
        {
          key: "scheduled",
          label: i18n.t("policies:software.deploymentList.scheduled"),
          value: summary.scheduled,
        },
        {
          key: "completed-7d",
          label: i18n.t("policies:software.softwareCatalog.summaryCompleted7d"),
          value: summary.completedLast7d,
        },
        {
          key: "failed-7d",
          label: i18n.t("policies:software.softwareCatalog.summaryFailed7d"),
          value: summary.failedLast7d,
        },
      ]
    : [];
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {i18n.t("policies:software.softwareCatalog.softwareLibrary")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.softwareCatalog.browseAndDeployApprovedSoftwarePackages",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            {i18n.t("policies:software.softwareCatalog.addPackage")}
          </button>
          <button
            type="button"
            onClick={() => openDeploy(undefined)}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <Rocket className="h-4 w-4" />
            {i18n.t("policies:software.softwareCatalog.bulkDeploy")}
          </button>
        </div>
      </div>

      {/* Catalog | Deployments tab bar (styling per SoftwarePage's tabs). */}
      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid={`software-tab-${t.key}`}
            onClick={() => selectTab(t.key)}
            className={cn(
              "inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors",
              view.tab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-muted hover:text-foreground",
            )}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>

      {view.tab === "deployments" &&
        (view.deploymentId ? (
          <DeploymentProgress
            deploymentId={view.deploymentId}
            onBack={backToDeployments}
          />
        ) : (
          <div className="space-y-6">
            {summaryCards.length > 0 && (
              <div
                className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
                data-testid="deployment-summary-cards"
              >
                {summaryCards.map((card) => (
                  <div
                    key={card.key}
                    data-testid={`deployment-summary-${card.key}`}
                    className="rounded-lg border bg-card p-4 shadow-xs"
                  >
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      {card.label}
                    </p>
                    <p className="mt-1 text-2xl font-semibold">{card.value}</p>
                  </div>
                ))}
              </div>
            )}
            <DeploymentList onSelectDeployment={openDeploymentDetail} />
          </div>
        ))}

      {view.tab === "catalog" && error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
          <button
            type="button"
            onClick={() => setError(undefined)}
            className="ml-2 underline"
          >
            {i18n.t("policies:software.softwareCatalog.dismiss")}
          </button>
        </div>
      )}

      {view.tab === "catalog" && (
      <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={i18n.t(
              "policies:software.softwareCatalog.searchSoftwareVendor",
            )}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
        >
          <option value="all">
            {i18n.t("policies:software.softwareCatalog.allCategories")}
          </option>
          {categories.map((item) => (
            <option key={item} value={item}>
              {item.charAt(0).toUpperCase() + item.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {filteredSoftware.length === 0 && !loading ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <Package className="mx-auto h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-sm text-muted-foreground">
            {catalogItems.length === 0
              ? i18n.t(
                  "policies:software.softwareCatalog.noSoftwarePackagesYetAddOneTo",
                )
              : i18n.t(
                  "policies:software.softwareCatalog.noPackagesMatchYourSearch",
                )}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filteredSoftware.map((item) => (
            <div
              key={item.id}
              className="group rounded-lg border bg-card p-5 shadow-xs transition hover:-translate-y-1 hover:shadow-md"
              role="button"
              tabIndex={0}
              onClick={() => {
                setDetailTab("details");
                setSelectedSoftware(item);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  setDetailTab("details");
                  setSelectedSoftware(item);
                }
              }}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  {isIntegrationProvider(item.integrationProvider) ? (
                    (() => {
                      const branding = getProviderBranding(
                        item.integrationProvider,
                      );
                      const Icon = branding.icon;
                      return (
                        <div
                          className={cn(
                            "flex h-10 w-10 items-center justify-center rounded-md border",
                            branding.accent,
                          )}
                        >
                          <Icon className="h-5 w-5" />
                        </div>
                      );
                    })()
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                      <Package className="h-5 w-5 text-muted-foreground" />
                    </div>
                  )}
                  <div>
                    <p className="text-sm font-semibold">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.vendor ||
                        i18n.t(
                          "policies:software.softwareCatalog.unknownVendor",
                        )}
                    </p>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  {isIntegrationProvider(item.integrationProvider) && (
                    <div className="flex items-center gap-1.5">
                      <ReadinessPill
                        status={readinessMap[item.integrationProvider].status}
                      />
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                          getProviderBranding(item.integrationProvider).accent,
                        )}
                      >
                        {i18n.t("policies:software.softwareCatalog.builtIn")}
                      </span>
                    </div>
                  )}
                  {item.category && (
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                        categoryStyles[item.category] ??
                          "bg-muted text-muted-foreground",
                      )}
                    >
                      {item.category.charAt(0).toUpperCase() +
                        item.category.slice(1)}
                    </span>
                  )}
                </div>
              </div>

              {item.description && (
                <p className="mt-3 text-xs text-muted-foreground line-clamp-2">
                  {item.description}
                </p>
              )}

              <div className="mt-4 flex items-center justify-between gap-2">
                {needsInstallerUpload(item) ? (
                  <p className="text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:software.softwareCatalog.uploadInstallerToEnableDeploy",
                    )}
                  </p>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  disabled={needsInstallerUpload(item)}
                  title={
                    needsInstallerUpload(item)
                      ? i18n.t(
                          "policies:software.softwareCatalog.uploadTheSentinelOneInstallerVersionsTabTo",
                        )
                      : item.integrationProvider
                        ? i18n.t(
                            "policies:software.softwareCatalog.deploysToMappedOrganizationsOnly",
                          )
                        : undefined
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    openDeploy(item.id);
                  }}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {i18n.t("policies:software.softwareCatalog.deploy")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}

      {/* Detail modal */}
      {selectedSoftware && (
        <Dialog
          open={!!selectedSoftware}
          onClose={() => setSelectedSoftware(null)}
          title={selectedSoftware.name}
          labelledBy="software-detail-title"
          maxWidth="4xl"
          alignTop
          className="flex max-h-[90vh] flex-col"
        >
          {/* Sticky header: identity + tabs + close */}
          <div className="border-b px-6 pt-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-muted">
                  <Package className="h-6 w-6 text-muted-foreground" />
                </div>
                <div>
                  <h2
                    id="software-detail-title"
                    className="text-lg font-semibold"
                  >
                    {selectedSoftware.name}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {selectedSoftware.vendor ||
                      i18n.t("policies:software.softwareCatalog.unknownVendor")}
                  </p>
                </div>
                {selectedSoftware.category && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                      categoryStyles[selectedSoftware.category] ??
                        "bg-muted text-muted-foreground",
                    )}
                  >
                    {selectedSoftware.category.charAt(0).toUpperCase() +
                      selectedSoftware.category.slice(1)}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedSoftware(null)}
                aria-label={i18n.t("common:actions.close")}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 flex items-center gap-1">
              <button
                type="button"
                onClick={() => setDetailTab("details")}
                className={cn(
                  "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                  detailTab === "details"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {i18n.t("policies:software.softwareCatalog.details")}
              </button>
              <button
                type="button"
                onClick={() => setDetailTab("versions")}
                className={cn(
                  "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                  detailTab === "versions"
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {i18n.t("policies:software.softwareCatalog.versions")}
              </button>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {detailTab === "details" &&
              (isIntegrationProvider(selectedSoftware.integrationProvider) ? (
                <BuiltinPackageDetail
                  name={selectedSoftware.name}
                  provider={selectedSoftware.integrationProvider}
                  readiness={readinessMap[selectedSoftware.integrationProvider]}
                  onDeploy={() => {
                    const id = selectedSoftware.id;
                    setSelectedSoftware(null);
                    openDeploy(id);
                  }}
                />
              ) : (
                <div>
                  {selectedSoftware.description && (
                    <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
                      {selectedSoftware.description}
                    </div>
                  )}
                  <div className="mt-5 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(selectedSoftware)}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-destructive/40 bg-background px-4 text-sm font-medium text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      {i18n.t("common:actions.delete")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const id = selectedSoftware.id;
                        setSelectedSoftware(null);
                        openDeploy(id);
                      }}
                      className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                    >
                      {i18n.t("policies:software.softwareCatalog.deploy2")}
                    </button>
                  </div>
                </div>
              ))}

            {detailTab === "versions" && (
              <SoftwareVersionManager
                catalogId={selectedSoftware.id}
                embedded
              />
            )}
          </div>
        </Dialog>
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <Dialog
          open={!!confirmDelete}
          onClose={() => (deleting ? undefined : setConfirmDelete(null))}
          title={i18n.t("policies:software.softwareCatalog.deletePackage")}
          labelledBy="delete-package-title"
          maxWidth="md"
          className="p-6"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </div>
            <div>
              <h2 id="delete-package-title" className="text-lg font-semibold">
                {i18n.t("policies:software.softwareCatalog.deletePackage2")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {i18n.t("policies:software.softwareCatalog.thisRemoves")}
                <span className="font-medium text-foreground">
                  {confirmDelete.name}
                </span>
                {i18n.t(
                  "policies:software.softwareCatalog.fromTheSoftwareLibraryAlongWithAll",
                )}
              </p>
            </div>
          </div>
          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              disabled={deleting}
              className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {i18n.t("common:actions.cancel")}
            </button>
            <button
              type="button"
              onClick={() => handleDeletePackage(confirmDelete)}
              disabled={deleting}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-destructive px-4 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />}
              {deleting
                ? i18n.t("policies:software.softwareCatalog.deleting")
                : i18n.t("common:actions.delete")}
            </button>
          </div>
        </Dialog>
      )}

      <AddPackageModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        onCreated={handleCreated}
      />

      {showDeployWizard && (
        <Dialog
          open={showDeployWizard}
          onClose={closeDeployWizard}
          title={i18n.t("policies:software.softwareCatalog.softwareDeployment")}
          labelledBy="deploy-wizard-title"
          maxWidth="4xl"
          alignTop
          className="flex max-h-[90vh] flex-col"
        >
          <div className="flex items-center justify-between border-b px-6 py-4">
            <h2 id="deploy-wizard-title" className="text-lg font-semibold">
              {deployCatalogId
                ? i18n.t("policies:software.softwareCatalog.deploySoftware")
                : i18n.t(
                    "policies:software.softwareCatalog.bulkSoftwareDeployment",
                  )}
            </h2>
            <button
              type="button"
              onClick={closeDeployWizard}
              aria-label={i18n.t("common:actions.close")}
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <DeploymentWizard
              initialCatalogId={deployCatalogId}
              initialDeviceIds={deployDeviceIds}
              onViewDeployment={handleViewDeployment}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}
