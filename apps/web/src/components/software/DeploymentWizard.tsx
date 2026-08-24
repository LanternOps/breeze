import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle,
  ChevronRight,
  Loader2,
  Search,
  Server,
  CalendarClock,
  ClipboardList,
} from "lucide-react";
import { asList } from '@/lib/asList';
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError } from "../../lib/runAction";
import { showToast } from "../shared/Toast";
import ProgressBar from "../shared/ProgressBar";
import type { DeploymentTargetConfig } from "@breeze/shared";
import { DeviceTargetSelector } from "../filters/DeviceTargetSelector";
import { DeviceOptionPicker } from "../filters/DeviceOptionPicker";
import { useDeviceOptions } from "../../hooks/useDeviceOptions";
import { ScopeBadge } from "../shared/ScopeBadge";
import { useOrgScope } from "../../hooks/useOrgScope";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type WizardStep = "software" | "targets" | "configure" | "review";
type SoftwareVersionOption = {
  id: string;
  version: string;
  isLatest: boolean;
};
/** One row of GET /software/catalog/:id/install-methods. */
type InstallMethodOption = {
  id: string;
  platform: string;
  kind: string;
  packageId: string;
  enabled: boolean;
};
type SoftwareOption = {
  id: string;
  name: string;
  vendor: string;
  versions: SoftwareVersionOption[];
  /** winget/Homebrew methods linked to this catalog item (Task 2 route). */
  installMethods: InstallMethodOption[];
  category: string;
};
/** Platform buckets the API can serve an install method for. */
type MethodPlatform = "windows" | "macos";
/** Map a device's `osType` onto the install-method platform axis. */
function methodPlatformForOs(osType: string | undefined): MethodPlatform | null {
  const normalized = (osType ?? "").toLowerCase();
  if (normalized.includes("win")) return "windows";
  if (normalized.includes("mac") || normalized.includes("darwin"))
    return "macos";
  return null;
}
/** Human label for the OS-coverage callout ("3 selected Linux devices …"). */
function osLabel(osType: string | undefined): string {
  const platform = methodPlatformForOs(osType);
  if (platform === "windows")
    return i18n.t("policies:software.deploymentWizard.osWindows");
  if (platform === "macos")
    return i18n.t("policies:software.deploymentWizard.osMacos");
  if ((osType ?? "").toLowerCase().includes("linux"))
    return i18n.t("policies:software.deploymentWizard.osLinux");
  return i18n.t("policies:software.deploymentWizard.osUnknown");
}
/** Manager name for a method kind — product names, deliberately untranslated. */
export function methodKindLabel(kind: string): string {
  if (kind === "winget") return "winget";
  if (kind === "homebrew_cask") return "brew cask";
  if (kind === "homebrew_formula") return "brew formula";
  return kind;
}
const enabledMethodsOf = (item: SoftwareOption | undefined) =>
  item?.installMethods.filter((method) => method.enabled) ?? [];
/**
 * A catalog item is deployable when it has an uploaded version OR at least one
 * enabled package-manager method (winget/Homebrew items ship zero versions).
 */
export function isDeployableSoftware(item: SoftwareOption): boolean {
  return item.versions.length > 0 || enabledMethodsOf(item).length > 0;
}
/**
 * Manager path = the item has no uploaded version to deploy, so the install is
 * delegated to winget/Homebrew. An item carrying BOTH keeps the version path
 * (the API accepts exactly one of softwareVersionId / catalogId).
 */
export function usesManagerPath(item: SoftwareOption | undefined): boolean {
  if (!item) return false;
  return item.versions.length === 0 && enabledMethodsOf(item).length > 0;
}
/**
 * A deploy POST returns HTTP 200 even when the server fails the deployment up front
 * (built-in EDR packages: target org unmapped / integration disconnected). runAction's
 * isApiFailure does NOT treat a `{ status: 'failed' }` body as a failure, so callers
 * must check explicitly. Returns the user-facing message, or null on success.
 */
export function extractDeployFailure(
  result:
    | {
        status?: string;
        message?: string;
        [key: string]: unknown;
      }
    | null
    | undefined,
): string | null {
  if (result?.status === "failed") return result.message ?? "Deployment failed";
  return null;
}
const createSteps = (): {
  id: WizardStep;
  label: string;
  icon: typeof CheckCircle;
}[] => [
  {
    id: "software",
    label: i18n.t("policies:software.deploymentWizard.selectSoftware"),
    icon: CheckCircle,
  },
  {
    id: "targets",
    label: i18n.t("policies:software.deploymentWizard.selectTargets"),
    icon: CheckCircle,
  },
  {
    id: "configure",
    label: i18n.t("policies:software.deploymentWizard.configure"),
    icon: CheckCircle,
  },
  {
    id: "review",
    label: i18n.t("policies:software.deploymentWizard.review"),
    icon: CheckCircle,
  },
];
const createScheduleOptions = () => [
  {
    id: "immediate",
    label: i18n.t("policies:software.deploymentWizard.deployImmediately"),
    description: i18n.t(
      "policies:software.deploymentWizard.startRolloutAsSoonAsApproved",
    ),
  },
  {
    id: "scheduled",
    label: i18n.t("policies:software.deploymentWizard.scheduleForLater"),
    description: i18n.t(
      "policies:software.deploymentWizard.pickASpecificDateAndTime",
    ),
  },
  {
    id: "maintenance",
    label: i18n.t("policies:software.deploymentWizard.nextMaintenanceWindow"),
    description: i18n.t(
      "policies:software.deploymentWizard.queueForTheNextMaintenanceWindow",
    ),
  },
];
function normalizeVersion(
  raw: Record<string, unknown>,
  index: number,
): SoftwareVersionOption {
  return {
    id: String(raw.id ?? `version-${index}`),
    version: String(raw.version ?? raw.name ?? ""),
    isLatest: Boolean(raw.isLatest ?? raw.is_latest ?? false),
  };
}
function normalizeInstallMethod(
  raw: Record<string, unknown>,
  index: number,
): InstallMethodOption {
  return {
    id: String(raw.id ?? `method-${index}`),
    platform: String(raw.platform ?? ""),
    kind: String(raw.kind ?? ""),
    packageId: String(raw.packageId ?? raw.package_id ?? ""),
    // Rows are enabled by default server-side; only an explicit false disables.
    enabled: raw.enabled !== false,
  };
}
function normalizeSoftware(
  raw: Record<string, unknown>,
  versions: SoftwareVersionOption[],
  installMethods: InstallMethodOption[],
  index: number,
): SoftwareOption {
  return {
    id: String(raw.id ?? `sw-${index}`),
    name: String(raw.name ?? raw.softwareName ?? "Unknown"),
    vendor: String(raw.vendor ?? raw.publisher ?? ""),
    versions,
    installMethods,
    category: String(raw.category ?? raw.type ?? "Software"),
  };
}
function getSelectedTargetSummary(
  targetMode: "tree" | "advanced",
  selectedDevices: Set<string>,
  targetConfig: DeploymentTargetConfig,
): {
  headline: string;
  detail: string;
  progressTotal?: number;
} {
  if (targetMode === "tree") {
    const count = selectedDevices.size;
    return {
      headline: i18n.t("policies:software.deploymentWizard.deviceCount", {
        count,
      }),
      detail: i18n.t(
        "policies:software.deploymentWizard.selectedDirectlyFromTheHierarchy",
      ),
      progressTotal: count,
    };
  }
  if (targetConfig.type === "all") {
    return {
      headline: i18n.t("policies:software.deploymentWizard.allDevices"),
      detail: i18n.t(
        "policies:software.deploymentWizard.targetsTheFullOrganizationScope",
      ),
    };
  }
  if (targetConfig.type === "groups") {
    const count = targetConfig.groupIds?.length ?? 0;
    return {
      headline: `${count} group${count === 1 ? "" : "s"}`,
      detail: i18n.t(
        "policies:software.deploymentWizard.deviceMembershipIsResolvedWhenTheDeployment",
      ),
    };
  }
  if (targetConfig.type === "filter") {
    return {
      headline: i18n.t("policies:software.deploymentWizard.dynamicFilter"),
      detail: i18n.t(
        "policies:software.deploymentWizard.targetsDevicesMatchingTheSelectedFilter",
      ),
    };
  }
  const count = targetConfig.deviceIds?.length ?? 0;
  return {
    headline: `${count} device${count === 1 ? "" : "s"}`,
    detail: i18n.t(
      "policies:software.deploymentWizard.selectedDirectlyInAdvancedTargeting",
    ),
    progressTotal: count,
  };
}
interface DeploymentWizardProps {
  /** When launched from a specific package's Deploy button, preselect it. */
  initialCatalogId?: string;
  /**
   * Devices to pre-check on the targets step (#2866) — carried over from a
   * device-list bulk selection via the `/software#deploy=<id>,...` hash. The
   * user still picks the package first; these seed both the hierarchy-tree
   * selection and the advanced manual selection so the create payload includes
   * them whichever mode is active.
   */
  initialDeviceIds?: string[];
  /**
   * Invoked when the user clicks "View deployment" on the success card. Hosts
   * that embed the wizard (SoftwareCatalog's modal) close the modal and switch
   * to the Deployments tab; without a handler the wizard falls back to a full
   * navigation to /software#deployment=<id>.
   */
  onViewDeployment?: (id: string) => void;
}
export default function DeploymentWizard({
  initialCatalogId,
  initialDeviceIds,
  onViewDeployment,
}: DeploymentWizardProps = {}) {
  useTranslation("policies");
  const steps = createSteps();
  const scheduleOptions = createScheduleOptions();
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  // The deployment silently inherits the header's customer context (fetchWithAuth
  // injects ?orgId= and the API stamps the deployment's org from it), so state
  // that context explicitly instead of leaving the user to infer it.
  const orgScope = useOrgScope();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [deploying, setDeploying] = useState(false);
  const [deploymentComplete, setDeploymentComplete] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string>("");
  // >1 when a mixed Windows+macOS deploy was split by the API into one
  // deployment per platform (POST /software/deployments always returns a
  // `deployments` array; length is 1 for the common, unsplit case).
  const [deploymentCount, setDeploymentCount] = useState(1);
  const [query, setQuery] = useState("");
  const [softwareOptions, setSoftwareOptions] = useState<SoftwareOption[]>([]);
  const [deviceSearch, setDeviceSearch] = useState("");
  const [selectedSoftwareId, setSelectedSoftwareId] = useState<string>("");
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  // Package-manager deploys pin either the manager's latest, or an exact
  // version (winget only — Homebrew cannot install a specific version).
  const [versionMode, setVersionMode] = useState<"latest" | "exact">("latest");
  const [requestedVersion, setRequestedVersion] = useState("");
  // deviceId → osType, used by the manager OS-coverage callout on the targets
  // step (the target tree only carries ids/names).
  // Seeded from a device-list bulk selection (#2866) so the targets step shows
  // the carried-over devices pre-checked in the default tree mode.
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(
    () => new Set(initialDeviceIds ?? []),
  );
  const [scheduleType, setScheduleType] = useState<
    "immediate" | "scheduled" | "maintenance"
  >("immediate");
  const [scheduledAt, setScheduledAt] = useState("");
  // When true, the agent installs even if the package's detection rule already
  // matches (i.e. bypasses skip-if-already-installed). Default off (#2022).
  const [forceReinstall, setForceReinstall] = useState(false);
  const [targetMode, setTargetMode] = useState<"tree" | "advanced">("tree");
  const [targetConfig, setTargetConfig] = useState<DeploymentTargetConfig>(
    () => ({
      type: "devices",
      // Mirror the seeded selection so switching to advanced targeting keeps
      // the carried-over devices (#2866).
      deviceIds: initialDeviceIds ? [...initialDeviceIds] : [],
    }),
  );
  const [advancedTargetsReady, setAdvancedTargetsReady] = useState(false);
  const deviceOptions = useDeviceOptions({
    search: deviceSearch,
    orgId: orgScope.scope === "org" ? orgScope.orgId : undefined,
    includeIds: Array.from(selectedDevices),
  });
  const deviceOsById = useMemo(
    () => new Map(deviceOptions.options.map((device) => [device.id, device.osType])),
    [deviceOptions.options],
  );
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const catalogResponse = await fetchWithAuth("/software/catalog");
      let normalizedCatalog: SoftwareOption[] = [];
      if (catalogResponse.ok) {
        const catalogPayload = await catalogResponse.json();
        const rawCatalog =
          asList(catalogPayload, 'catalog');
        const catalogRows = Array.isArray(rawCatalog) ? rawCatalog : [];
        // Versions and package-manager install methods are fetched in parallel:
        // a manager-linked item has zero versions but is still deployable.
        const [versionResults, methodResults] = await Promise.all([
          Promise.allSettled(
            catalogRows.map(async (row) => {
              const catalogId = String(
                (row as Record<string, unknown>).id ?? "",
              );
              if (!catalogId) return [] as SoftwareVersionOption[];
              const response = await fetchWithAuth(
                `/software/catalog/${catalogId}/versions`,
              );
              if (!response.ok) return [] as SoftwareVersionOption[];
              const payload = await response.json();
              const rawVersions =
                asList(payload, 'versions');
              if (!Array.isArray(rawVersions))
                return [] as SoftwareVersionOption[];
              return rawVersions
                .map((version: Record<string, unknown>, index: number) =>
                  normalizeVersion(version, index),
                )
                .filter((version) => version.version);
            }),
          ),
          Promise.allSettled(
            catalogRows.map(async (row) => {
              const catalogId = String(
                (row as Record<string, unknown>).id ?? "",
              );
              if (!catalogId) return [] as InstallMethodOption[];
              const response = await fetchWithAuth(
                `/software/catalog/${catalogId}/install-methods`,
              );
              if (!response.ok) return [] as InstallMethodOption[];
              const payload = await response.json();
              const rawMethods = asList(payload, 'installMethods');
              if (!Array.isArray(rawMethods)) return [] as InstallMethodOption[];
              return rawMethods
                .map((method: Record<string, unknown>, index: number) =>
                  normalizeInstallMethod(method, index),
                )
                .filter((method) => method.kind && method.packageId);
            }),
          ),
        ]);
        normalizedCatalog = catalogRows.map((row, index) =>
          normalizeSoftware(
            row as Record<string, unknown>,
            versionResults[index]?.status === "fulfilled"
              ? versionResults[index].value
              : [],
            methodResults[index]?.status === "fulfilled"
              ? methodResults[index].value
              : [],
            index,
          ),
        );
        setSoftwareOptions(normalizedCatalog);
      }
      if (normalizedCatalog.length > 0 && !selectedSoftwareId) {
        // Preselect the package the user launched from (per-card Deploy), falling
        // back to the first deployable one when none was passed or it has no version.
        const preferred = initialCatalogId
          ? normalizedCatalog.find(
              (item) => item.id === initialCatalogId && isDeployableSoftware(item),
            )
          : undefined;
        const firstDeployable =
          preferred ?? normalizedCatalog.find(isDeployableSoftware);
        if (firstDeployable) {
          setSelectedSoftwareId(firstDeployable.id);
          setSelectedVersionId(
            firstDeployable.versions.find((version) => version.isLatest)?.id ??
              firstDeployable.versions[0]?.id ??
              "",
          );
        }
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load deployment data",
      );
    } finally {
      setLoading(false);
    }
  }, [initialCatalogId]);
  useEffect(() => {
    fetchData();
  }, [fetchData]);
  const activeStep = steps[activeStepIndex]?.id ?? "software";
  const filteredSoftware = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return softwareOptions.filter((item) => {
      if (!normalized) return true;
      return (
        item.name.toLowerCase().includes(normalized) ||
        item.vendor.toLowerCase().includes(normalized)
      );
    });
  }, [query, softwareOptions]);
  const selectedSoftware = useMemo(
    () => softwareOptions.find((item) => item.id === selectedSoftwareId),
    [selectedSoftwareId, softwareOptions],
  );
  const selectedVersion = useMemo(
    () =>
      selectedSoftware?.versions.find(
        (item) => item.id === selectedVersionId,
      ) ?? null,
    [selectedSoftware, selectedVersionId],
  );
  useEffect(() => {
    if (!selectedSoftware) return;
    if (selectedSoftware.versions.length === 0) {
      if (selectedVersionId) setSelectedVersionId("");
      return;
    }
    const hasSelectedVersion = selectedSoftware.versions.some(
      (item) => item.id === selectedVersionId,
    );
    if (!hasSelectedVersion) {
      setSelectedVersionId(
        selectedSoftware.versions.find((item) => item.isLatest)?.id ??
          selectedSoftware.versions[0]?.id ??
          "",
      );
    }
  }, [selectedSoftware, selectedVersionId]);
  const selectedMethods = useMemo(
    () => enabledMethodsOf(selectedSoftware),
    [selectedSoftware],
  );
  const isManagerDeploy = useMemo(
    () => usesManagerPath(selectedSoftware),
    [selectedSoftware],
  );
  /** Homebrew cannot pin a version, so "Exact" needs a winget method. */
  const supportsExactVersion = useMemo(
    () => selectedMethods.some((method) => method.kind === "winget"),
    [selectedMethods],
  );
  // Reset the version intent whenever the selected package changes so a stale
  // "exact 3.0.20" can't ride along onto a Homebrew-only item.
  useEffect(() => {
    setVersionMode("latest");
    setRequestedVersion("");
  }, [selectedSoftwareId]);
  useEffect(() => {
    if (!supportsExactVersion && versionMode === "exact")
      setVersionMode("latest");
  }, [supportsExactVersion, versionMode]);
  const targetSummary = useMemo(
    () => getSelectedTargetSummary(targetMode, selectedDevices, targetConfig),
    [targetMode, selectedDevices, targetConfig],
  );
  /**
   * Devices in the current selection whose OS has no enabled install method —
   * the API creates them anyway and pre-fails each with
   * "No install method for this device OS", so warn before the deploy.
   * Only device-id selections can be checked; group/filter/all targeting is
   * resolved server-side and is deliberately not guessed at here.
   */
  const managerCoverageGaps = useMemo(() => {
    if (!isManagerDeploy) return [] as { os: string; count: number }[];
    const servable = new Set(selectedMethods.map((method) => method.platform));
    const deviceIds =
      targetMode === "advanced"
        ? targetConfig.type === "devices"
          ? (targetConfig.deviceIds ?? [])
          : []
        : Array.from(selectedDevices);
    const counts = new Map<string, number>();
    for (const deviceId of deviceIds) {
      const osType = deviceOsById.get(deviceId);
      const platform = methodPlatformForOs(osType);
      if (platform && servable.has(platform)) continue;
      const label = osLabel(osType);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([os, count]) => ({ os, count }));
  }, [
    deviceOsById,
    isManagerDeploy,
    selectedDevices,
    selectedMethods,
    targetConfig,
    targetMode,
  ]);
  const managerCoverageCallout =
    managerCoverageGaps.length > 0 ? (
      <div
        data-testid="manager-os-coverage"
        className="mb-4 rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
      >
        {managerCoverageGaps.map((gap) => (
          <p key={gap.os}>
            {i18n.t("policies:software.deploymentWizard.managerOsCoverage", {
              count: gap.count,
              os: gap.os,
            })}
          </p>
        ))}
      </div>
    ) : null;
  const handleTargetConfigChange = useCallback(
    (config: DeploymentTargetConfig) => {
      setTargetConfig(config);
      if (config.type === "devices" && config.deviceIds) {
        setSelectedDevices(new Set(config.deviceIds));
      }
    },
    [],
  );
  const canProceed = useMemo(() => {
    if (activeStep === "software") {
      if (!selectedSoftwareId) return false;
      if (isManagerDeploy)
        return versionMode === "latest" || requestedVersion.trim().length > 0;
      return Boolean(selectedVersionId);
    }
    if (activeStep === "targets") {
      if (targetMode === "advanced") {
        if (targetConfig.type === "all") return advancedTargetsReady;
        if (targetConfig.type === "devices")
          return advancedTargetsReady && (targetConfig.deviceIds?.length ?? 0) > 0;
        if (targetConfig.type === "groups")
          return (targetConfig.groupIds?.length ?? 0) > 0;
        if (targetConfig.type === "filter") return Boolean(targetConfig.filter);
        return false;
      }
      return deviceOptions.canSubmit && selectedDevices.size > 0;
    }
    if (activeStep === "configure")
      return scheduleType !== "scheduled" || Boolean(scheduledAt);
    return true;
  }, [
    activeStep,
    advancedTargetsReady,
    deviceOptions.canSubmit,
    isManagerDeploy,
    requestedVersion,
    scheduleType,
    scheduledAt,
    selectedDevices.size,
    selectedSoftwareId,
    selectedVersionId,
    targetConfig,
    targetMode,
    versionMode,
  ]);
  const handleDeploy = async () => {
    try {
      if (!selectedVersionId && !isManagerDeploy) {
        throw new Error(
          i18n.t(
            "policies:software.deploymentWizard.selectASoftwareVersionBeforeDeploying",
          ),
        );
      }
      setDeploying(true);
      setError(undefined);
      // Exactly one of softwareVersionId / catalogId — the API rejects both.
      const source = isManagerDeploy
        ? {
            catalogId: selectedSoftwareId,
            versionMode,
            ...(versionMode === "exact"
              ? { requestedVersion: requestedVersion.trim() }
              : {}),
          }
        : { softwareVersionId: selectedVersionId };
      const versionLabel = isManagerDeploy
        ? versionMode === "exact"
          ? requestedVersion.trim()
          : "latest"
        : (selectedVersion?.version ?? "");
      const payload =
        targetMode === "advanced"
          ? {
              name: `${selectedSoftware?.name ?? "Software"} ${versionLabel}`.trim(),
              ...source,
              deploymentType: "install",
              targetType: targetConfig.type,
              targetIds:
                targetConfig.type === "devices"
                  ? targetConfig.deviceIds
                  : targetConfig.type === "groups"
                    ? targetConfig.groupIds
                    : undefined,
              targetFilter:
                targetConfig.type === "filter"
                  ? targetConfig.filter
                  : undefined,
              scheduleType,
              scheduledAt:
                scheduleType === "scheduled"
                  ? new Date(scheduledAt).toISOString()
                  : undefined,
              options: forceReinstall ? { forceReinstall: true } : undefined,
            }
          : {
              name: `${selectedSoftware?.name ?? "Software"} ${versionLabel}`.trim(),
              ...source,
              deploymentType: "install",
              targetType: "devices" as const,
              targetIds: Array.from(selectedDevices),
              scheduleType,
              scheduledAt:
                scheduleType === "scheduled"
                  ? new Date(scheduledAt).toISOString()
                  : undefined,
              options: forceReinstall ? { forceReinstall: true } : undefined,
            };
      const result = await runAction<{
        id?: string;
        status?: string;
        message?: string;
        deployments?: unknown[];
      }>({
        request: () =>
          fetchWithAuth("/software/deployments", {
            method: "POST",
            body: JSON.stringify(payload),
          }),
        errorFallback: i18n.t(
          "policies:software.deploymentWizard.deploymentFailed",
        ),
        parseSuccess: (data) => {
          const raw = data as { data?: unknown; deployments?: unknown[] };
          const d = raw?.data ?? data;
          return {
            ...((d ?? {}) as { id?: string; status?: string; message?: string }),
            deployments: raw?.deployments,
          };
        },
      });
      // Built-in EDR deploys return HTTP 200 with status 'failed' when the target
      // org is unmapped or the integration is disconnected — surface that.
      const failureMessage = extractDeployFailure(result);
      if (failureMessage) {
        setError(failureMessage);
        showToast({ message: failureMessage, type: "error" });
        return;
      }
      // A mixed Windows+macOS deploy is split by the API into one deployment
      // per platform (see createManagerDeployments in routes/software.ts) —
      // reflect that split in the confirmation view and toast rather than
      // silently describing only the first half.
      const splitCount = result?.deployments?.length ?? 1;
      setDeploymentCount(splitCount);
      setDeploymentId(result?.id ?? "deployment-created");
      setDeploymentComplete(true);
      showToast({
        message:
          splitCount > 1
            ? i18n.t(
                "policies:software.deploymentWizard.deploymentsStartedSplit",
                { count: splitCount },
              )
            : i18n.t("policies:software.deploymentWizard.deploymentStarted"),
        type: "success",
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      const msg = err instanceof Error ? err.message : "Deployment failed";
      setError(msg);
      if (!(err instanceof ActionError))
        showToast({ message: msg, type: "error" });
    } finally {
      setDeploying(false);
    }
  };
  const resetWizard = () => {
    const firstDeployable = softwareOptions.find(isDeployableSoftware);
    setDeploymentComplete(false);
    setDeploymentCount(1);
    setActiveStepIndex(0);
    setSelectedSoftwareId(firstDeployable?.id ?? "");
    setSelectedVersionId(
      firstDeployable?.versions.find((version) => version.isLatest)?.id ??
        firstDeployable?.versions[0]?.id ??
        "",
    );
    setSelectedDevices(new Set());
    setVersionMode("latest");
    setRequestedVersion("");
    setScheduleType("immediate");
    setScheduledAt("");
    setTargetMode("tree");
    setTargetConfig({ type: "devices", deviceIds: [] });
  };
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.deploymentWizard.loadingDeploymentOptions",
            )}
          </p>
        </div>
      </div>
    );
  }
  if (error && softwareOptions.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchData}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {i18n.t("policies:software.deploymentWizard.tryAgain")}
        </button>
      </div>
    );
  }
  if (deploymentComplete) {
    // The POST can succeed without echoing an id (older API shapes); the state
    // then holds the "deployment-created" sentinel, which is not linkable.
    const linkableDeploymentId =
      deploymentId && deploymentId !== "deployment-created" ? deploymentId : "";
    return (
      <div className="rounded-lg border bg-card p-6 text-center shadow-xs space-y-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20">
          <CheckCircle className="h-8 w-8 text-emerald-500" />
        </div>
        <h2 className="text-xl font-semibold">
          {i18n.t("policies:software.deploymentWizard.deploymentCreated")}
        </h2>
        <p className="text-sm text-muted-foreground" data-testid="deployment-summary">
          {deploymentCount > 1
            ? i18n.t(
                "policies:software.deploymentWizard.yourDeploymentsWereSplitAndQueuedSuccessfully",
                { count: deploymentCount },
              )
            : i18n.t(
                "policies:software.deploymentWizard.yourDeploymentHasBeenQueuedSuccessfully",
              )}
        </p>
        <div className="flex items-center justify-center gap-2 pt-4">
          {linkableDeploymentId && (
            <button
              type="button"
              data-testid="view-deployment-button"
              onClick={() => {
                if (onViewDeployment) {
                  onViewDeployment(linkableDeploymentId);
                } else {
                  window.location.assign(
                    `/software#deployment=${linkableDeploymentId}`,
                  );
                }
              }}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {i18n.t("policies:software.deploymentWizard.viewDeployment")}
            </button>
          )}
          <button
            type="button"
            onClick={resetWizard}
            className={cn(
              "inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium",
              linkableDeploymentId
                ? "border bg-background hover:bg-muted"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {i18n.t("policies:software.deploymentWizard.startNewDeployment")}
          </button>
        </div>
      </div>
    );
  }
  const renderStepContent = () => {
    if (activeStep === "software") {
      return (
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder={i18n.t(
                  "policies:software.deploymentWizard.searchSoftware",
                )}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-3">
              {filteredSoftware.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {i18n.t(
                    "policies:software.deploymentWizard.noSoftwarePackagesAvailable",
                  )}
                </p>
              ) : (
                filteredSoftware.map((item) => {
                  const isDeployable = isDeployableSoftware(item);
                  const managerOnly = usesManagerPath(item);
                  const defaultVersion =
                    item.versions.find((version) => version.isLatest) ??
                    item.versions[0];
                  return (
                    <button
                      key={item.id}
                      type="button"
                      disabled={!isDeployable}
                      onClick={() => {
                        if (!isDeployable) return;
                        setSelectedSoftwareId(item.id);
                        setSelectedVersionId(defaultVersion?.id ?? "");
                      }}
                      className={cn(
                        "flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition",
                        isDeployable
                          ? "hover:border-primary/50"
                          : "cursor-not-allowed opacity-60",
                        selectedSoftwareId === item.id
                          ? "border-primary bg-primary/5"
                          : "bg-card",
                      )}
                    >
                      <div>
                        <p className="text-sm font-semibold">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.vendor} · {item.category}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {managerOnly
                          ? i18n.t(
                              "policies:software.deploymentWizard.managedByPackageManager",
                            )
                          : isDeployable
                            ? defaultVersion?.version
                            : i18n.t(
                                "policies:software.deploymentWizard.noVersions",
                              )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-xs">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">
                {i18n.t("policies:software.deploymentWizard.selectedSoftware")}
              </h3>
            </div>
            {selectedSoftware ? (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="text-base font-semibold">
                    {selectedSoftware.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {selectedSoftware.vendor}
                  </p>
                </div>
                {isManagerDeploy ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-1.5">
                      {selectedMethods.map((method) => (
                        <span
                          key={method.id}
                          className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] font-medium"
                        >
                          {methodKindLabel(method.kind)}
                          <span className="font-mono text-muted-foreground">
                            {method.packageId}
                          </span>
                        </span>
                      ))}
                    </div>
                    <fieldset className="space-y-2">
                      <legend className="text-xs font-semibold uppercase text-muted-foreground">
                        {i18n.t("policies:software.deploymentWizard.version")}
                      </legend>
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="radio"
                          name="manager-version-mode"
                          value="latest"
                          checked={versionMode === "latest"}
                          onChange={() => setVersionMode("latest")}
                          className="mt-1 h-4 w-4"
                        />
                        <span>
                          {i18n.t(
                            "policies:software.deploymentWizard.versionModeLatest",
                          )}
                        </span>
                      </label>
                      {supportsExactVersion && (
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            type="radio"
                            name="manager-version-mode"
                            value="exact"
                            checked={versionMode === "exact"}
                            onChange={() => setVersionMode("exact")}
                            className="mt-1 h-4 w-4"
                          />
                          <span>
                            {i18n.t(
                              "policies:software.deploymentWizard.versionModeExact",
                            )}
                          </span>
                        </label>
                      )}
                    </fieldset>
                    {versionMode === "exact" && (
                      <input
                        type="text"
                        data-testid="manager-exact-version"
                        value={requestedVersion}
                        onChange={(event) =>
                          setRequestedVersion(event.target.value)
                        }
                        placeholder={i18n.t(
                          "policies:software.deploymentWizard.versionNumberPlaceholder",
                        )}
                        aria-label={i18n.t(
                          "policies:software.deploymentWizard.versionModeExact",
                        )}
                        className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      />
                    )}
                    <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:software.deploymentWizard.managerInstallExplainer",
                      )}
                    </div>
                  </div>
                ) : selectedSoftware.versions.length > 0 ? (
                  <>
                    <div>
                      <label className="text-xs font-semibold uppercase text-muted-foreground">
                        {i18n.t("policies:software.deploymentWizard.version")}
                      </label>
                      <select
                        value={selectedVersionId}
                        onChange={(event) =>
                          setSelectedVersionId(event.target.value)
                        }
                        className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      >
                        {selectedSoftware.versions.map((version) => (
                          <option key={version.id} value={version.id}>
                            {version.version}
                            {version.isLatest
                              ? i18n.t(
                                  "policies:software.deploymentWizard.latest",
                                )
                              : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:software.deploymentWizard.latestBuildIsPreSelectedYouCan",
                      )}
                    </div>
                  </>
                ) : (
                  <div className="rounded-md border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-700">
                    {i18n.t(
                      "policies:software.deploymentWizard.thisPackageCannotBeDeployedUntilAt",
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                {i18n.t(
                  "policies:software.deploymentWizard.selectASoftwarePackageToContinue",
                )}
              </p>
            )}
          </div>
        </div>
      );
    }
    if (activeStep === "targets") {
      const targetModeToggle = (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            {i18n.t("policies:software.deploymentWizard.targetBy")}
          </span>
          <div className="flex rounded-md border">
            <button
              type="button"
              onClick={() => setTargetMode("tree")}
              className={cn(
                "rounded-l-md px-3 py-1.5 text-xs font-medium transition",
                targetMode === "tree"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted",
              )}
            >
              {i18n.t("policies:software.deploymentWizard.hierarchy")}
            </button>
            <button
              type="button"
              onClick={() => setTargetMode("advanced")}
              className={cn(
                "rounded-r-md px-3 py-1.5 text-xs font-medium transition",
                targetMode === "advanced"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted",
              )}
            >
              {i18n.t("policies:software.deploymentWizard.advanced")}
            </button>
          </div>
        </div>
      );
      if (targetMode === "advanced") {
        return (
          <div>
            {targetModeToggle}
            {managerCoverageCallout}
            <DeviceTargetSelector
              value={targetConfig}
              onChange={handleTargetConfigChange}
              modes={["all", "manual", "groups", "filter"]}
              showPreview={true}
              showSavedFilters={true}
              orgId={orgScope.scope === "org" ? orgScope.orgId : undefined}
              onCanSubmitChange={setAdvancedTargetsReady}
            />
          </div>
        );
      }
      return (
        <div>
          {targetModeToggle}
          {managerCoverageCallout}
          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            <div className="rounded-lg border bg-card p-5 shadow-xs">
              <h3 className="text-sm font-semibold">
                {i18n.t(
                  "policies:software.deploymentWizard.organizationTargets",
                )}
              </h3>
              <p className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:software.deploymentWizard.selectGroupsOrDevicesForDeployment",
                )}
              </p>
              <DeviceOptionPicker
                className="mt-4"
                result={deviceOptions}
                selectedIds={Array.from(selectedDevices)}
                onSelectedIdsChange={(ids) => setSelectedDevices(new Set(ids))}
                search={deviceSearch}
                onSearchChange={setDeviceSearch}
                showSelectAll
              />
            </div>
            <div className="space-y-4">
              <div className="rounded-lg border bg-card p-5 shadow-xs">
                <h3 className="text-sm font-semibold">
                  {i18n.t("policies:software.deploymentWizard.selectedTargets")}
                </h3>
                <p className="mt-2 text-2xl font-semibold">
                  {targetSummary.headline}
                </p>
                <p className="text-xs text-muted-foreground">
                  {targetSummary.detail}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:software.deploymentWizard.tipSelectingAGroupAutomaticallyIncludesAll",
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }
    if (activeStep === "configure") {
      return (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">
              {i18n.t("policies:software.deploymentWizard.deploymentSchedule")}
            </h3>
          </div>
          <div className="mt-4 space-y-4">
            {scheduleOptions.map((option) => (
              <label
                key={option.id}
                className="flex items-start gap-3 rounded-md border p-4 text-sm"
              >
                <input
                  type="radio"
                  name="schedule"
                  value={option.id}
                  checked={scheduleType === option.id}
                  onChange={() =>
                    setScheduleType(option.id as typeof scheduleType)
                  }
                  className="mt-1 h-4 w-4"
                />
                <div>
                  <p className="font-medium">{option.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {option.description}
                  </p>
                </div>
              </label>
            ))}
          </div>
          {scheduleType === "scheduled" && (
            <div className="mt-4">
              <label className="text-xs font-semibold uppercase text-muted-foreground">
                {i18n.t("policies:software.deploymentWizard.scheduledDateTime")}
              </label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
          {scheduleType === "maintenance" && (
            <div className="mt-4 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              {i18n.t(
                "policies:software.deploymentWizard.devicesWillBeQueuedForTheNext",
              )}
            </div>
          )}
          <label
            className="mt-4 flex items-start gap-2 text-sm"
            data-testid="force-reinstall-toggle"
          >
            <input
              type="checkbox"
              checked={forceReinstall}
              onChange={(event) => setForceReinstall(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              {i18n.t(
                "policies:software.deploymentWizard.reinstallEvenIfAlreadyPresent",
              )}
              <span className="block text-xs text-muted-foreground">
                {i18n.t(
                  "policies:software.deploymentWizard.bypassesThePackageSDetectionRuleSkip",
                )}
              </span>
            </span>
          </label>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">
              {i18n.t("policies:software.deploymentWizard.reviewDeployment")}
            </h3>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {orgScope.scope === "org" && (
              <div
                className="rounded-md border bg-muted/30 p-4"
                data-testid="deployment-review-customer"
              >
                <p className="text-xs uppercase text-muted-foreground">
                  {i18n.t("policies:software.deploymentWizard.customer")}
                </p>
                <p className="mt-2 text-sm font-semibold">
                  {orgScope.org?.name ?? "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:software.deploymentWizard.allTargetsBelongToThisCustomer",
                  )}
                </p>
              </div>
            )}
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">
                {i18n.t("policies:software.deploymentWizard.software")}
              </p>
              <p className="mt-2 text-sm font-semibold">
                {selectedSoftware?.name ?? "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {i18n.t("policies:software.deploymentWizard.version2")}
                {isManagerDeploy
                  ? versionMode === "exact"
                    ? requestedVersion.trim() || "—"
                    : i18n.t(
                        "policies:software.deploymentWizard.versionModeLatestShort",
                      )
                  : (selectedVersion?.version ?? "—")}
              </p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">
                {i18n.t("policies:software.deploymentWizard.targets")}
              </p>
              <p className="mt-2 text-sm font-semibold">
                {targetSummary.headline}
              </p>
              <p className="text-xs text-muted-foreground">
                {targetSummary.detail}
              </p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">
                {i18n.t("policies:software.deploymentWizard.schedule")}
              </p>
              <p className="mt-2 text-sm font-semibold">
                {scheduleType === "immediate" &&
                  i18n.t("policies:software.deploymentWizard.immediate2")}
                {scheduleType === "scheduled" &&
                  i18n.t("policies:software.deploymentWizard.scheduled2")}
                {scheduleType === "maintenance" &&
                  i18n.t(
                    "policies:software.deploymentWizard.maintenanceWindow",
                  )}
              </p>
              <p className="text-xs text-muted-foreground">
                {scheduleType === "scheduled" && scheduledAt ? scheduledAt : ""}
                {scheduleType === "maintenance"
                  ? i18n.t(
                      "policies:software.deploymentWizard.nextAvailableMaintenanceWindow",
                    )
                  : ""}
                {scheduleType === "immediate"
                  ? i18n.t(
                      "policies:software.deploymentWizard.startsAfterApproval",
                    )
                  : ""}
              </p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">
                {i18n.t("policies:software.deploymentWizard.changeWindow")}
              </p>
              <p className="mt-2 text-sm font-semibold">
                {i18n.t("policies:software.deploymentWizard.standard")}
              </p>
              <p className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:software.deploymentWizard.notificationsEnabled",
                )}
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-4">
          {deploying && (
            <ProgressBar
              current={0}
              total={targetSummary.progressTotal ?? 1}
              label={i18n.t(
                "policies:software.deploymentWizard.creatingDeployment2",
              )}
              showCount={false}
            />
          )}
          <button
            type="button"
            onClick={handleDeploy}
            disabled={deploying}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {deploying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t(
                  "policies:software.deploymentWizard.creatingDeployment",
                )}
              </>
            ) : (
              i18n.t("policies:software.deploymentWizard.createDeployment")
            )}
          </button>
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {i18n.t("policies:software.deploymentWizard.deploymentWizard")}
          </h1>
          {orgScope.scope === "org" && (
            <span
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
              data-testid="deployment-org-context"
            >
              {i18n.t("policies:software.deploymentWizard.deployingTo")}
              <ScopeBadge
                orgId={orgScope.orgId}
                partnerId={null}
                isSystem={false}
                orgName={orgScope.org?.name}
              />
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {i18n.t(
            "policies:software.deploymentWizard.guideADeploymentThroughSelectionTargetingAnd",
          )}
        </p>
      </div>

      {orgScope.scope === "all" && (
        <div
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400"
          data-testid="deployment-all-orgs-notice"
        >
          {i18n.t("policies:software.deploymentWizard.allOrgsSelectCustomer")}
        </div>
      )}

      {error && activeStep !== "review" && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-4 shadow-xs">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {steps.map((step, index) => {
            const isActive = index === activeStepIndex;
            const isCompleted = index < activeStepIndex;
            return (
              <div key={step.id} className="flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold",
                    isCompleted &&
                      "border-emerald-500 bg-emerald-500 text-white",
                    isActive && !isCompleted && "border-primary text-primary",
                    !isActive && !isCompleted && "text-muted-foreground",
                  )}
                >
                  {isCompleted ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    index + 1
                  )}
                </div>
                <div>
                  <p
                    className={cn(
                      "text-sm font-medium",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </p>
                </div>
                {index < steps.length - 1 && (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>{renderStepContent()}</div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setActiveStepIndex((prev) => Math.max(prev - 1, 0))}
          disabled={activeStepIndex === 0}
          className="inline-flex h-10 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {i18n.t("common:actions.back")}
        </button>
        {activeStepIndex < steps.length - 1 && (
          <button
            type="button"
            onClick={() =>
              setActiveStepIndex((prev) => Math.min(prev + 1, steps.length - 1))
            }
            disabled={!canProceed}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {i18n.t("common:actions.next")}
          </button>
        )}
      </div>
    </div>
  );
}
