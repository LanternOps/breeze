import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HardDrive,
  RefreshCw,
  Loader2,
  AlertCircle,
  Sparkles,
  Clock,
  FolderOpen,
} from "lucide-react";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { fetchWithAuth } from "../../stores/auth";
import type { OSType } from "./DeviceList";
import { formatNumber } from "@/lib/i18n/format";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type DeviceFilesystemTabProps = {
  deviceId: string;
  osType: OSType;
  onOpenFiles?: () => void;
};

type FilesystemSummary = {
  filesScanned?: number;
  dirsScanned?: number;
  bytesScanned?: number;
  maxDepthReached?: number;
  permissionDeniedCount?: number;
};

type FilesystemSnapshot = {
  id: string;
  capturedAt: string;
  trigger: "on_demand" | "threshold";
  partial: boolean;
  reason?: string | null;
  path?: string | null;
  scanMode?: string | null;
  summary: FilesystemSummary;
  cleanupCandidates?: Array<{
    path?: string;
    category?: string;
    sizeBytes?: number;
  }>;
  topLargestFiles?: Array<{ path?: string; sizeBytes?: number }>;
  topLargestDirectories?: Array<{
    path?: string;
    sizeBytes?: number;
    estimated?: boolean;
  }>;
  oldDownloads?: Array<{
    path?: string;
    sizeBytes?: number;
    modifiedAt?: string;
  }>;
  unrotatedLogs?: Array<{
    path?: string;
    sizeBytes?: number;
    modifiedAt?: string;
  }>;
  trashUsage?: Array<{ path?: string; sizeBytes?: number }>;
  duplicateCandidates?: Array<{
    key?: string;
    sizeBytes?: number;
    count?: number;
  }>;
  errors?: Array<{ path?: string; error?: string }>;
};

type FilesystemCleanupPreview = {
  cleanupRunId: string | null;
  estimatedBytes: number;
  candidateCount: number;
  categories: Array<{
    category: string;
    count: number;
    estimatedBytes: number;
  }>;
  candidates: Array<{ path: string; category: string; sizeBytes: number }>;
};

type CommandRow = {
  id: string;
  type?: string;
  status?: string;
  createdAt?: string;
  payload?: unknown;
};

type CommandDetail = {
  id: string;
  status?: string;
  result?: unknown;
};

type ThresholdEvent = {
  id: string;
  status: string;
  createdAt: string;
  path: string;
};

const categoryLabels: Record<string, string> = {
  temp_files: "Temp Files",
  browser_cache: "Browser Cache",
  package_cache: "Package Cache",
  trash: "Trash",
};

const statusBadgeClasses: Record<string, string> = {
  pending: "bg-gray-500/15 text-gray-700 border-gray-500/30",
  sent: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  completed: "bg-green-500/15 text-green-700 border-green-500/30",
  failed: "bg-red-500/15 text-red-700 border-red-500/30",
};

function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "-";
  if (value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024)
    return `${formatNumber(value / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  if (value < 1024 * 1024 * 1024)
    return `${formatNumber(value / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
  if (value < 1024 * 1024 * 1024 * 1024)
    return `${formatNumber(value / (1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`;
  return `${formatNumber(value / (1024 * 1024 * 1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} TB`;
}

function normalizeHierarchyPath(path: string): string {
  let normalized = path.trim().replace(/\\/g, "/");
  while (normalized.includes("//"))
    normalized = normalized.replaceAll("//", "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    const isWindowsDriveRoot =
      normalized.length === 3 && normalized[1] === ":" && normalized[2] === "/";
    if (!isWindowsDriveRoot) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized.toLowerCase();
}

function isDescendantPath(path: string, ancestor: string): boolean {
  const normalizedPath = normalizeHierarchyPath(path);
  const normalizedAncestor = normalizeHierarchyPath(ancestor);
  if (
    !normalizedPath ||
    !normalizedAncestor ||
    normalizedPath === normalizedAncestor
  )
    return false;
  if (normalizedAncestor === "/")
    return normalizedPath.startsWith("/") && normalizedPath !== "/";
  if (
    normalizedAncestor.length === 3 &&
    normalizedAncestor[1] === ":" &&
    normalizedAncestor[2] === "/"
  ) {
    return (
      normalizedPath.startsWith(normalizedAncestor) &&
      normalizedPath !== normalizedAncestor
    );
  }
  return normalizedPath.startsWith(`${normalizedAncestor}/`);
}

function collapseAncestorDirectories<
  T extends { path?: string; sizeBytes?: number },
>(directories: T[], limit: number, descendantRatio = 0.7): T[] {
  if (limit <= 0 || directories.length === 0) return [];
  const items = directories
    .filter((item) => typeof item.path === "string" && item.path.length > 0)
    .slice()
    .sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));

  const pruned = new Set<number>();
  for (let i = 0; i < items.length; i += 1) {
    if (pruned.has(i)) continue;
    const ancestorPath = items[i].path ?? "";
    const ancestorBytes = items[i].sizeBytes ?? 0;
    if (!ancestorPath || ancestorBytes <= 0) continue;

    for (let j = 0; j < items.length; j += 1) {
      if (i === j || pruned.has(j)) continue;
      const childPath = items[j].path ?? "";
      const childBytes = items[j].sizeBytes ?? 0;
      if (!childPath || childBytes <= 0) continue;
      if (!isDescendantPath(childPath, ancestorPath)) continue;
      const ancestorEstimated = Boolean(
        (items[i] as { estimated?: boolean }).estimated,
      );
      const childEstimated = Boolean(
        (items[j] as { estimated?: boolean }).estimated,
      );
      let effectiveRatio = descendantRatio;
      if (ancestorEstimated && !childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.45);
      } else if (ancestorEstimated && childEstimated) {
        effectiveRatio = Math.min(effectiveRatio, 0.6);
      } else if (!ancestorEstimated && childEstimated) {
        effectiveRatio = Math.max(effectiveRatio, 0.85);
      }
      if (childBytes >= ancestorBytes * effectiveRatio) {
        pruned.add(i);
        break;
      }
    }
  }

  return items.filter((_, index) => !pruned.has(index)).slice(0, limit);
}

function formatDateTime(value: string | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatUserDateTime(parsed, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getDefaultScanPath(osType: OSType): string {
  if (osType === "windows") return "C:\\";
  return "/";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readThresholdEvents(commands: CommandRow[]): ThresholdEvent[] {
  const events = commands
    .filter((command) => command.type === "filesystem_analysis")
    .map((command) => {
      const payload = asRecord(command.payload);
      const trigger =
        typeof payload?.trigger === "string" ? payload.trigger : "";
      if (trigger !== "threshold") {
        return null;
      }
      const path = typeof payload?.path === "string" ? payload.path : "-";
      return {
        id: command.id,
        status: command.status ?? "pending",
        createdAt: command.createdAt ?? "",
        path,
      };
    })
    .filter((event): event is ThresholdEvent => event !== null)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  return events.slice(0, 8);
}

export default function DeviceFilesystemTab({
  deviceId,
  osType,
  onOpenFiles,
}: DeviceFilesystemTabProps) {
  const { t } = useTranslation("devices");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState<"scan" | "preview" | null>(
    null,
  );
  const [error, setError] = useState<string | undefined>();
  const [snapshot, setSnapshot] = useState<FilesystemSnapshot | null>(null);
  const [cleanupPreview, setCleanupPreview] =
    useState<FilesystemCleanupPreview | null>(null);
  // The cleanup-preview result renders at the bottom of a long page. Without
  // this, clicking "Cleanup Preview" succeeds silently below the fold and reads
  // as "nothing happened". Scroll the freshly-rendered panel into view.
  const cleanupPreviewRef = useRef<HTMLDivElement | null>(null);
  const [thresholdEvents, setThresholdEvents] = useState<ThresholdEvent[]>([]);
  const [scanCommand, setScanCommand] = useState<{
    id: string;
    status: string;
  } | null>(null);

  const fetchSnapshot = useCallback(async () => {
    const response = await fetchWithAuth(`/devices/${deviceId}/filesystem`);
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({
          error: t("deviceFilesystemTab.failedToFetchFilesystemStatus"),
        }));
      throw new Error(body.error || "Failed to fetch filesystem status");
    }
    const body = await response.json();
    return (body.data ?? null) as FilesystemSnapshot | null;
  }, [deviceId]);

  const fetchThresholdEvents = useCallback(async () => {
    const response = await fetchWithAuth(
      `/devices/${deviceId}/commands?limit=100`,
    );
    if (!response.ok) {
      const body = await response
        .json()
        .catch(() => ({
          error: t("deviceFilesystemTab.failedToFetchCommandHistory"),
        }));
      throw new Error(body.error || "Failed to fetch command history");
    }
    const body = await response.json();
    const rows = Array.isArray(body.data) ? (body.data as CommandRow[]) : [];
    return readThresholdEvents(rows);
  }, [deviceId]);

  const loadAll = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
      }
      setError(undefined);
      try {
        const [latestSnapshot, events] = await Promise.all([
          fetchSnapshot(),
          fetchThresholdEvents(),
        ]);
        setSnapshot(latestSnapshot);
        setThresholdEvents(events);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("deviceFilesystemTab.failedToLoadFilesystemStatus"),
        );
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [fetchSnapshot, fetchThresholdEvents],
  );

  const pollScanCommand = useCallback(
    async (commandId: string, timeoutMs: number) => {
      const startedAt = Date.now();
      // Back off between status polls (2s → 10s) rather than hammering a fixed
      // 2s for the whole scan window; a baseline scan can run for minutes.
      let delayMs = 2000;
      const maxDelayMs = 10000;

      while (Date.now() - startedAt < timeoutMs) {
        const response = await fetchWithAuth(
          `/devices/${deviceId}/commands/${commandId}`,
        );
        if (!response.ok) {
          const body = await response
            .json()
            .catch(() => ({
              error: t("deviceFilesystemTab.failedToFetchScanStatus"),
            }));
          throw new Error(body.error || "Failed to fetch scan status");
        }

        const body = await response.json();
        const command = (body.data ?? null) as CommandDetail | null;
        if (!command) {
          throw new Error("Scan command was not found");
        }

        const status = command.status ?? "pending";
        setScanCommand({ id: commandId, status });

        if (status === "completed") {
          return;
        }

        if (status === "failed") {
          const result = asRecord(command.result);
          const error =
            typeof result?.error === "string"
              ? result.error
              : t("deviceFilesystemTab.filesystemScanFailed");
          throw new Error(error);
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.5));
      }

      throw new Error(
        "Filesystem scan is still running. Click Refresh in a few moments.",
      );
    },
    [deviceId],
  );

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const runAnalyze = useCallback(async () => {
    setActionLoading("scan");
    setError(undefined);
    setScanCommand(null);
    try {
      const timeoutSeconds = 300;
      const response = await fetchWithAuth(
        `/devices/${deviceId}/filesystem/scan`,
        {
          method: "POST",
          body: JSON.stringify({
            path: getDefaultScanPath(osType),
            maxDepth: 32,
            topFiles: 50,
            topDirs: 30,
            maxEntries: 10000000,
            workers: 6,
            timeoutSeconds,
          }),
        },
      );
      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({
            error: t("deviceFilesystemTab.filesystemScanFailed"),
          }));
        throw new Error(body.error || "Filesystem scan failed");
      }
      const body = await response.json();
      const commandId =
        typeof body?.data?.commandId === "string" ? body.data.commandId : null;
      if (!commandId) {
        throw new Error("Scan command was not queued");
      }

      setScanCommand({ id: commandId, status: "pending" });
      await pollScanCommand(
        commandId,
        Math.max(120_000, (timeoutSeconds + 90) * 1000),
      );
      setCleanupPreview(null);
      await loadAll(true);
      setScanCommand(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceFilesystemTab.filesystemScanFailed"),
      );
      setScanCommand(null);
    } finally {
      setActionLoading(null);
    }
  }, [deviceId, loadAll, osType, pollScanCommand]);

  const runCleanupPreview = useCallback(async () => {
    setActionLoading("preview");
    setError(undefined);
    try {
      const response = await fetchWithAuth(
        `/devices/${deviceId}/filesystem/cleanup-preview`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({
            error: t("deviceFilesystemTab.cleanupPreviewFailed"),
          }));
        throw new Error(body.error || "Cleanup preview failed");
      }
      const body = await response.json();
      setCleanupPreview((body.data ?? null) as FilesystemCleanupPreview | null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceFilesystemTab.cleanupPreviewFailed"),
      );
    } finally {
      setActionLoading(null);
    }
  }, [deviceId]);

  // Bring the preview panel into view once it renders. Optional-chain the
  // method so jsdom (no scrollIntoView impl) doesn't throw in tests.
  useEffect(() => {
    if (cleanupPreview) {
      cleanupPreviewRef.current?.scrollIntoView?.({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [cleanupPreview]);

  const summary = snapshot?.summary ?? {};
  const cleanupCandidateCount = snapshot?.cleanupCandidates?.length ?? 0;
  const previewTopCandidates = cleanupPreview?.candidates.slice(0, 6) ?? [];
  const previewCategorySummary = useMemo(
    () => cleanupPreview?.categories ?? [],
    [cleanupPreview],
  );
  const topLargestFiles = snapshot?.topLargestFiles?.slice(0, 8) ?? [];
  const topLargestDirectories = collapseAncestorDirectories(
    snapshot?.topLargestDirectories ?? [],
    8,
  );
  const oldDownloadsCount = snapshot?.oldDownloads?.length ?? 0;
  const unrotatedLogCount = snapshot?.unrotatedLogs?.length ?? 0;
  const duplicateGroupCount = snapshot?.duplicateCandidates?.length ?? 0;
  const scanErrorCount = snapshot?.errors?.length ?? 0;
  const totalTrashBytes = (snapshot?.trashUsage ?? []).reduce(
    (sum, item) => sum + (item.sizeBytes ?? 0),
    0,
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t("deviceFilesystemTab.loadingDiskIntelligence")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-lg font-semibold">
              {t("deviceFilesystemTab.be1DiskCleanupIntelligence")}
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runAnalyze}
              disabled={actionLoading !== null}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {actionLoading === "scan" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {t("deviceFilesystemTab.analyzeNow")}{" "}
            </button>
            <button
              type="button"
              onClick={runCleanupPreview}
              disabled={actionLoading !== null || !snapshot}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {actionLoading === "preview" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {t("deviceFilesystemTab.cleanupPreview")}{" "}
            </button>
            <button
              type="button"
              onClick={async () => {
                setRefreshing(true);
                await loadAll(true);
                setRefreshing(false);
              }}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
              />
              {t("deviceFilesystemTab.refresh")}{" "}
            </button>
            <button
              type="button"
              onClick={() => onOpenFiles?.()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("deviceFilesystemTab.openFileManager")}{" "}
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          </div>
        )}

        {scanCommand && (
          <div className="mt-4 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                {t("deviceFilesystemTab.scanRunning")}
                {scanCommand.status})
              </span>
            </div>
          </div>
        )}

        {snapshot?.partial && (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              <span>
                {t("deviceFilesystemTab.partialScanResult")}
                {snapshot.reason ? `: ${snapshot.reason}` : "."}
              </span>
            </div>
          </div>
        )}

        {!snapshot ? (
          <div className="mt-4 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("deviceFilesystemTab.noFilesystemSnapshotYetRunAnalyze")}{" "}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("deviceFilesystemTab.lastScan")}
                </p>
                <p className="mt-1 text-sm font-medium">
                  {formatDateTime(snapshot.capturedAt)}
                </p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("deviceFilesystemTab.trigger")}
                </p>
                <p className="mt-1 text-sm font-medium">
                  {snapshot.trigger === "threshold"
                    ? t("deviceFilesystemTab.threshold")
                    : t("deviceFilesystemTab.onDemand")}
                </p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("deviceFilesystemTab.runMode")}
                </p>
                <p className="mt-1 text-sm font-medium">
                  {snapshot.scanMode === "incremental"
                    ? t("deviceFilesystemTab.incremental")
                    : t("deviceFilesystemTab.baseline")}
                </p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("deviceFilesystemTab.scanPath")}
                </p>
                <p className="mt-1 truncate text-sm font-medium">
                  {snapshot.path ?? "-"}
                </p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("deviceFilesystemTab.scannedDataInPath")}
                </p>
                <p className="mt-1 text-sm font-medium">
                  {formatBytes(summary.bytesScanned)}
                </p>
              </div>
              <div className="rounded-md border bg-muted/20 p-3">
                <p className="text-xs text-muted-foreground">
                  {t("deviceFilesystemTab.cleanupCandidates")}
                </p>
                <p className="mt-1 text-sm font-medium">
                  {formatNumber(cleanupCandidateCount)}
                </p>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("deviceFilesystemTab.scanSummary")}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.filesScanned")}
                  </span>
                  <span className="text-right font-medium">
                    {formatNumber(summary.filesScanned ?? 0)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.directoriesScanned")}
                  </span>
                  <span className="text-right font-medium">
                    {formatNumber(summary.dirsScanned ?? 0)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.maxDepthReached")}
                  </span>
                  <span className="text-right font-medium">
                    {summary.maxDepthReached ?? 0}
                  </span>
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.permissionDenials")}
                  </span>
                  <span className="text-right font-medium">
                    {summary.permissionDeniedCount ?? 0}
                  </span>
                </div>
              </div>

              <div className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("deviceFilesystemTab.collectedSignals")}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.oldDownloads")}
                  </span>
                  <span className="text-right font-medium">
                    {formatNumber(oldDownloadsCount)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.unrotatedLogs")}
                  </span>
                  <span className="text-right font-medium">
                    {formatNumber(unrotatedLogCount)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.trashSize")}
                  </span>
                  <span className="text-right font-medium">
                    {formatBytes(totalTrashBytes)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.duplicateGroups")}
                  </span>
                  <span className="text-right font-medium">
                    {formatNumber(duplicateGroupCount)}
                  </span>
                  <span className="text-muted-foreground">
                    {t("deviceFilesystemTab.scanErrors")}
                  </span>
                  <span className="text-right font-medium">
                    {formatNumber(scanErrorCount)}
                  </span>
                </div>
              </div>

              <div className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("deviceFilesystemTab.recentThresholdTriggers")}
                </p>
                <div className="mt-2 space-y-2">
                  {thresholdEvents.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("deviceFilesystemTab.noRecentThresholdTriggeredScans")}
                    </p>
                  ) : (
                    thresholdEvents.slice(0, 5).map((event) => (
                      <div
                        key={event.id}
                        className="flex items-start justify-between gap-2 rounded bg-muted/20 px-2 py-1.5 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{event.path}</p>
                          <p className="text-muted-foreground">
                            {formatDateTime(event.createdAt)}
                          </p>
                        </div>
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 ${statusBadgeClasses[event.status] ?? "bg-muted/30 text-muted-foreground border-muted"}`}
                        >
                          {event.status}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-md border p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("deviceFilesystemTab.largestFiles")}
                </p>
                <div className="mt-2 space-y-1">
                  {topLargestFiles.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("deviceFilesystemTab.noFileDataAvailable")}
                    </p>
                  ) : (
                    topLargestFiles.map((item) => (
                      <div
                        key={item.path}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="truncate">{item.path}</span>
                        <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                          {formatBytes(item.sizeBytes)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-md border p-3 lg:col-span-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("deviceFilesystemTab.largestDirectories")}
                </p>
                {topLargestDirectories.some((item) => item.estimated) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {">="}{" "}
                    {t(
                      "deviceFilesystemTab.indicatesLowerBoundSizeFromPartial",
                    )}
                  </p>
                )}
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {topLargestDirectories.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("deviceFilesystemTab.noDirectoryDataAvailable")}
                    </p>
                  ) : (
                    topLargestDirectories.map((item) => (
                      <div
                        key={item.path}
                        className="flex items-center justify-between gap-2 rounded bg-muted/20 px-2 py-1.5 text-sm"
                      >
                        <span className="truncate">{item.path}</span>
                        <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                          {item.estimated ? t("deviceFilesystemTab.text") : ""}
                          {formatBytes(item.sizeBytes)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {cleanupPreview && (
        <div
          ref={cleanupPreviewRef}
          className="rounded-lg border bg-card p-6 shadow-xs scroll-mt-4"
        >
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <h4 className="font-semibold">
              {t("deviceFilesystemTab.latestCleanupPreview")}
            </h4>
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">
                {t("deviceFilesystemTab.estimatedRecovery")}
              </p>
              <p className="mt-1 text-sm font-medium">
                {formatBytes(cleanupPreview.estimatedBytes)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">
                {t("deviceFilesystemTab.candidateCount")}
              </p>
              <p className="mt-1 text-sm font-medium">
                {formatNumber(cleanupPreview.candidateCount)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-xs text-muted-foreground">
                {t("deviceFilesystemTab.categories")}
              </p>
              <p className="mt-1 text-sm font-medium">
                {cleanupPreview.categories.length}
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-md border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("deviceFilesystemTab.byCategory")}
              </p>
              <div className="mt-2 space-y-1">
                {previewCategorySummary.map((item) => (
                  <div
                    key={item.category}
                    className="flex items-center justify-between text-sm"
                  >
                    <span>
                      {categoryLabels[item.category] ?? item.category}
                    </span>
                    <span className="font-medium">
                      {formatBytes(item.estimatedBytes)}
                    </span>
                  </div>
                ))}
                {previewCategorySummary.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {t("deviceFilesystemTab.noSafeCleanupCategoriesFound")}
                  </p>
                )}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("deviceFilesystemTab.topCandidates")}
              </p>
              <div className="mt-2 space-y-1">
                {previewTopCandidates.map((item) => (
                  <div
                    key={item.path}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate">{item.path}</span>
                    <span className="shrink-0 whitespace-nowrap text-right font-medium tabular-nums">
                      {formatBytes(item.sizeBytes)}
                    </span>
                  </div>
                ))}
                {previewTopCandidates.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    {t("deviceFilesystemTab.noCandidatesAvailable")}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
