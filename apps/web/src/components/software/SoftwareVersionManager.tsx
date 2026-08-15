import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  Plus,
  Sparkles,
  CheckCircle,
  Upload,
} from "lucide-react";
import { asList } from '@/lib/asList';
import {
  SOFTWARE_FILE_TYPES,
  deriveSoftwareFileTypeFromUrl,
  type DetectionRule,
  type SoftwareFileType,
} from "@breeze/shared";
import { applySilentArgsPrefill } from "@/lib/installerArgsPrefill";
import { cn } from "@/lib/utils";
import { fetchWithAuth } from "../../stores/auth";
import { usePackageUploadsGate } from "../../stores/featuresStore";
import { findUnknownTokens } from "@/lib/installerVariables";
import { applyOsHint } from "@/lib/installerPackageHints";
import { uploadPackageVersion } from "../../lib/softwarePackageUpload";
import DetectionRulesEditor from "./DetectionRulesEditor";
import VariableInput, { type DeviceCustomField } from "./VariableInput";
import { useTenantVariables } from "@/lib/tenantVariableTokens";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type Architecture = "x64" | "arm64" | "x86";
type VersionEntry = {
  id: string;
  version: string;
  releaseDate: string;
  architecture: Architecture;
  fileType: string;
  originalFileName: string;
  notes: string[];
  isLatest: boolean;
};
function formatDate(dateString: string, timezone?: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString([], { timeZone: timezone });
}
function normalizeVersion(
  raw: Record<string, unknown>,
  index: number,
): VersionEntry {
  const notesRaw = raw.notes ?? raw.releaseNotes ?? raw.changelog;
  let notes: string[] = [];
  if (typeof notesRaw === "string") {
    notes = notesRaw
      .split("\n")
      .map((n) => n.trim())
      .filter(Boolean);
  } else if (Array.isArray(notesRaw)) {
    notes = notesRaw.map((n) => String(n)).filter(Boolean);
  }
  const archRaw = raw.architecture ?? raw.arch ?? raw.platform ?? "x64";
  let architecture: Architecture = "x64";
  if (["arm64", "arm", "aarch64"].includes(String(archRaw).toLowerCase())) {
    architecture = "arm64";
  } else if (
    ["x86", "i386", "i686", "32bit"].includes(String(archRaw).toLowerCase())
  ) {
    architecture = "x86";
  }
  return {
    id: String(raw.id ?? raw.versionId ?? `ver-${index}`),
    version: String(raw.version ?? ""),
    releaseDate: String(raw.releaseDate ?? raw.releasedAt ?? ""),
    architecture,
    fileType: String(raw.fileType ?? ""),
    originalFileName: String(raw.originalFileName ?? ""),
    notes,
    isLatest: Boolean(raw.isLatest ?? raw.is_latest ?? false),
  };
}
/**
 * Server-acknowledged bytes → a percentage safe to render as a CSS width.
 *
 * Progress from the chunked uploader is NOT monotonic: a lost-state resync
 * legitimately reports `bytesReceived: 0` and the transfer restarts from the
 * beginning. That regression is real and worth showing, so it is deliberately
 * not clamped upward to a high-water mark — but it must never produce a
 * negative width, and a zero/unknown total must never produce `NaN%`.
 */
function toPercent(sentBytes: number, totalBytes: number): number {
  if (!Number.isFinite(sentBytes) || !Number.isFinite(totalBytes)) return 0;
  if (totalBytes <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((sentBytes / totalBytes) * 100)));
}
interface SoftwareVersionManagerProps {
  timezone?: string;
  catalogId?: string;
  /** When rendered inside the package detail modal, drop the page heading and
   *  the full-page comparison cards — the modal supplies its own chrome. */
  embedded?: boolean;
}
export default function SoftwareVersionManager({
  timezone,
  catalogId: propCatalogId,
  embedded = false,
}: SoftwareVersionManagerProps) {
  useTranslation("policies");
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [latestId, setLatestId] = useState<string>("");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [promotingVersionId, setPromotingVersionId] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [catalogId, setCatalogId] = useState(propCatalogId ?? "");
  const [customFields, setCustomFields] = useState<DeviceCustomField[]>([]);
  // Tenant variables (#3409) — offered as `{{var.<key>}}` in the same picker.
  const tenantVariables = useTenantVariables();
  // Without S3 configured the upload routes 503, so gray the file picker out
  // up front instead of failing after the user chose a file.
  const { enabled: uploadsEnabled } = usePackageUploadsGate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Owns the in-flight chunked upload so Cancel (and unmount) can actually stop
  // it. A ref, not state: it must survive re-renders without causing one, and
  // the progress bar already re-renders on every acknowledged chunk.
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [formState, setFormState] = useState({
    version: "",
    architecture: "x64" as Architecture,
    notes: "",
    silentInstallArgs: "",
    silentUninstallArgs: "",
    downloadUrl: "",
    // "" = let the server infer from the URL. Only meaningful for the URL
    // source; the upload path derives it from the uploaded filename.
    fileType: "" as "" | SoftwareFileType,
    supportedOs: [] as string[],
    detectionRules: [] as DetectionRule[],
    file: null as File | null,
    fileName: "",
  });
  const fetchVersions = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      let resolvedCatalogId = propCatalogId ?? catalogId;
      if (!resolvedCatalogId) {
        const response = await fetchWithAuth("/software/catalog");
        if (!response.ok)
          throw new Error(
            i18n.t(
              "policies:software.softwareVersionManager.failedToFetchSoftwareCatalog",
            ),
          );
        const payload = await response.json();
        const catalogData = asList(payload);
        if (Array.isArray(catalogData) && catalogData.length > 0) {
          resolvedCatalogId = String(
            (catalogData[0] as Record<string, unknown>).id,
          );
          setCatalogId(resolvedCatalogId);
        }
      }
      if (!resolvedCatalogId) {
        setVersions([]);
        return;
      }
      const versionsResponse = await fetchWithAuth(
        `/software/catalog/${resolvedCatalogId}/versions`,
      );
      if (versionsResponse.ok) {
        const versionsPayload = await versionsResponse.json();
        const versionsList =
          asList(versionsPayload, 'versions');
        const normalizedVersions = Array.isArray(versionsList)
          ? versionsList.map((v: Record<string, unknown>, i: number) =>
              normalizeVersion(v, i),
            )
          : [];
        setVersions(normalizedVersions);
        if (normalizedVersions.length > 0) {
          const latestVersion =
            normalizedVersions.find((version) => version.isLatest) ??
            normalizedVersions[0];
          setLatestId(latestVersion?.id ?? "");
          setSelectedVersionId((current) => current || latestVersion?.id || "");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch versions");
    } finally {
      setLoading(false);
    }
  }, [propCatalogId, catalogId]);
  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth("/custom-fields?limit=100");
        if (!res.ok || cancelled) return;
        const payload = await res.json();
        const rows = asList(payload);
        if (Array.isArray(rows)) {
          setCustomFields(
            rows
              .map((r: Record<string, unknown>) => ({
                fieldKey: String(r.fieldKey ?? ""),
                name: String(r.name ?? r.fieldKey ?? ""),
              }))
              // Only offer keys matching the resolver's token grammar (see AddPackageModal).
              .filter((f: DeviceCustomField) =>
                /^[a-z][a-z0-9_]*$/.test(f.fieldKey),
              ),
          );
        }
      } catch {
        /* custom fields are optional for the variable picker */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const knownCustomKeys = useMemo(
    () => new Set(customFields.map((f) => f.fieldKey)),
    [customFields],
  );
  const knownVariableKeys = useMemo(
    () => new Set(tenantVariables.map((v) => v.key)),
    [tenantVariables],
  );
  const tokenErrors = useMemo(() => {
    const opts = {
      requireKnownCustomKeys: knownCustomKeys.size > 0,
      variableKeys: knownVariableKeys,
      requireKnownVariableKeys: knownVariableKeys.size > 0,
    };
    return [
      formState.downloadUrl,
      formState.silentInstallArgs,
      formState.silentUninstallArgs,
    ].flatMap((s) => findUnknownTokens(s, knownCustomKeys, opts));
  }, [
    formState.downloadUrl,
    formState.silentInstallArgs,
    formState.silentUninstallArgs,
    knownCustomKeys,
    knownVariableKeys,
  ]);
  const latestVersion = useMemo(
    () => versions.find((item) => item.id === latestId) ?? versions[0],
    [versions, latestId],
  );
  const selectedVersion = useMemo(
    () => versions.find((item) => item.id === selectedVersionId) ?? versions[0],
    [versions, selectedVersionId],
  );
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setFormState((prev) => ({
      ...prev,
      file,
      fileName: file.name,
      // Auto-populate MSI silent args (retractable — see applySilentArgsPrefill).
      ...applySilentArgsPrefill(prev, deriveSoftwareFileTypeFromUrl(file.name)),
      ...applyOsHint(prev, file.name),
    }));
  };
  /** The URL source carries no filename, so the installer type has to come from
   *  the URL's extension or from the operator. Without it the server stores
   *  file_type NULL, the dispatcher falls back to 'exe', and the agent execs the
   *  installer directly — which is the bug this whole path exists to prevent. */
  const handleDownloadUrlChange = (value: string) => {
    setFormState((prev) => ({
      ...prev,
      downloadUrl: value,
      ...applySilentArgsPrefill(
        prev,
        prev.fileType || deriveSoftwareFileTypeFromUrl(value),
      ),
      ...applyOsHint(prev, value),
    }));
  };
  const handleFileTypeChange = (value: "" | SoftwareFileType) => {
    setFormState((prev) => ({
      ...prev,
      fileType: value,
      ...applySilentArgsPrefill(
        prev,
        value || deriveSoftwareFileTypeFromUrl(prev.downloadUrl),
      ),
    }));
  };
  const inferredFileType = useMemo(
    () => deriveSoftwareFileTypeFromUrl(formState.downloadUrl),
    [formState.downloadUrl],
  );
  const handlePromoteLatest = useCallback(
    async (versionId: string) => {
      if (!catalogId || versionId === latestId) return;
      try {
        setPromotingVersionId(versionId);
        setError(undefined);
        const response = await fetchWithAuth(
          `/software/catalog/${catalogId}/versions/${versionId}/promote`,
          {
            method: "POST",
          },
        );
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error ?? "Failed to promote version");
        }
        await fetchVersions();
      } catch (err) {
        console.error("Failed to promote version:", err);
        setError(
          err instanceof Error ? err.message : "Failed to promote version",
        );
      } finally {
        setPromotingVersionId("");
      }
    },
    [catalogId, fetchVersions, latestId],
  );
  // Navigating away mid-upload must not leave the chunk loop running against a
  // component that no longer exists.
  useEffect(
    () => () => {
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
    },
    [],
  );
  /** True only when OUR controller aborted — i.e. the user pressed Cancel or
   *  the component unmounted. The uploader's internal per-phase
   *  `AbortSignal.timeout` ceilings abort a different signal and surface as
   *  real failures, which is what we want: a timeout is not a cancel. */
  const wasUserCancelled = (controller: AbortController | null) =>
    controller !== null && controller.signal.aborted;
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!formState.version.trim()) return;
    if (!catalogId) return;
    // Only the file branch is abortable; the metadata-only POST is a single
    // short request and keeps its previous behaviour exactly.
    const controller = formState.file ? new AbortController() : null;
    uploadAbortRef.current = controller;
    try {
      setSaving(true);
      setUploadProgress(0);
      if (formState.file) {
        // Chunked upload (#2951): each chunk is its own short request with a
        // fresh token, so a slow multi-hundred-MB upload can never outlive the
        // access-token TTL. Progress is real bytes acknowledged by the server —
        // the previous 10/90/100 placeholders made a 222MB transfer sit at
        // "10%" for its entire duration, which users read as a stall.
        const response = await uploadPackageVersion({
          catalogId,
          file: formState.file,
          metadata: {
            version: formState.version.trim(),
            architecture: formState.architecture,
            releaseNotes: formState.notes || undefined,
            silentInstallArgs: formState.silentInstallArgs || undefined,
            silentUninstallArgs: formState.silentUninstallArgs || undefined,
            downloadUrl: formState.downloadUrl || undefined,
            supportedOs:
              formState.supportedOs.length > 0
                ? formState.supportedOs
                : undefined,
            detectionRules:
              formState.detectionRules.length > 0
                ? formState.detectionRules
                : undefined,
          },
          onProgress: (sent, total) => setUploadProgress(toPercent(sent, total)),
          signal: controller?.signal,
        });
        // A completion that lands after the user cancelled must not resurrect
        // the version they believe they abandoned. (The uploader rejects on
        // abort, but a chunk loop that finished in the same tick as the click
        // can still resolve.)
        if (wasUserCancelled(controller)) return;
        // A resolved promise is NOT success: the uploader resolves with the
        // first unrecoverable failing Response so callers keep their own
        // response.ok handling (including the #2794 status suffix below).
        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          // Always show the status. Every API failure path returns a JSON body
          // with an `error` key, so the bare fallback means the response was
          // not JSON at all — a reverse-proxy 413/502/504 HTML page or a
          // truncated connection. Including the status makes that case
          // distinguishable from an API-level failure at a glance (#2794).
          // `error` also carries the uploader's own terminal messages (e.g.
          // upload_instance_mismatch, which names load-balancer session
          // affinity as the fix) — pass it through verbatim, never replace it
          // with a generic string, or a self-hoster loses the only actionable
          // hint they get.
          const detail =
            typeof errData.error === "string"
              ? errData.error
              : typeof errData.message === "string"
                ? errData.message
                : "Failed to upload version";
          throw new Error(`${detail} (HTTP ${response.status})`);
        }
        const newVersionData = await response.json();
        const newVersion = normalizeVersion(
          newVersionData.data ?? newVersionData,
          versions.length,
        );
        setVersions((prev) => [newVersion, ...prev]);
        setLatestId(newVersion.id);
        setSelectedVersionId(newVersion.id);
      } else {
        // JSON metadata-only path
        const response = await fetchWithAuth(
          `/software/catalog/${catalogId}/versions`,
          {
            method: "POST",
            body: JSON.stringify({
              version: formState.version.trim(),
              releaseNotes: formState.notes || undefined,
              architecture: formState.architecture,
              silentInstallArgs: formState.silentInstallArgs || undefined,
              silentUninstallArgs: formState.silentUninstallArgs || undefined,
              downloadUrl: formState.downloadUrl || undefined,
              // Omitted on "auto" so the server infers from the URL.
              fileType: formState.fileType || undefined,
              supportedOs:
                formState.supportedOs.length > 0
                  ? formState.supportedOs
                  : undefined,
              detectionRules:
                formState.detectionRules.length > 0
                  ? formState.detectionRules
                  : undefined,
            }),
          },
        );
        if (!response.ok)
          throw new Error(
            i18n.t(
              "policies:software.softwareVersionManager.failedToCreateVersion",
            ),
          );
        const newVersionData = await response.json();
        const newVersion = normalizeVersion(
          newVersionData.data ?? newVersionData,
          versions.length,
        );
        setVersions((prev) => [newVersion, ...prev]);
        setLatestId(newVersion.id);
        setSelectedVersionId(newVersion.id);
      }
      setFormState({
        version: "",
        architecture: "x64",
        notes: "",
        silentInstallArgs: "",
        silentUninstallArgs: "",
        downloadUrl: "",
        fileType: "",
        supportedOs: [],
        detectionRules: [],
        file: null,
        fileName: "",
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      setIsFormOpen(false);
      setAdvancedOpen(false);
    } catch (err) {
      // uploadPackageVersion REJECTS on abort. A cancel the user asked for is
      // not a failure — exit quietly, leaving `versions` untouched and no
      // scary red banner behind.
      if (wasUserCancelled(controller)) return;
      console.error("Failed to create version:", err);
      setError(err instanceof Error ? err.message : "Failed to create version");
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      setSaving(false);
      setUploadProgress(0);
    }
  };
  const handleCancelForm = () => {
    // Aborting BEFORE closing matters: closing unmounts the progress bar, so
    // without this the chunk loop would keep running invisibly and still push
    // a version into the list the user thinks they cancelled.
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    setIsFormOpen(false);
  };
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.softwareVersionManager.loadingSoftwareVersions",
            )}
          </p>
        </div>
      </div>
    );
  }
  if (error && versions.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchVersions}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {i18n.t("policies:software.softwareVersionManager.tryAgain")}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div
        className={cn(
          "flex flex-col gap-4 sm:flex-row sm:items-center",
          embedded ? "sm:justify-end" : "sm:justify-between",
        )}
      >
        {!embedded && (
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {i18n.t(
                "policies:software.softwareVersionManager.softwareVersionManager",
              )}
            </h1>
            <p className="text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.softwareVersionManager.manageVersionHistoryLatestBuildsAndRelease",
              )}
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={() => setIsFormOpen((open) => !open)}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          {i18n.t("policies:software.softwareVersionManager.addVersion")}
          {isFormOpen ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {isFormOpen && (
        <form
          onSubmit={handleSubmit}
          className="rounded-lg border bg-card p-6 shadow-xs"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">
                {i18n.t("policies:software.softwareVersionManager.version")}
              </label>
              <input
                type="text"
                value={formState.version}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    version: event.target.value,
                  }))
                }
                placeholder={i18n.t(
                  "policies:software.softwareVersionManager.eG100",
                )}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase text-muted-foreground">
                {i18n.t(
                  "policies:software.softwareVersionManager.architecture",
                )}
              </label>
              <select
                value={formState.architecture}
                onChange={(event) =>
                  setFormState((prev) => ({
                    ...prev,
                    architecture: event.target.value as Architecture,
                  }))
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="x64">
                  {i18n.t("policies:software.softwareVersionManager.x64")}
                </option>
                <option value="arm64">
                  {i18n.t("policies:software.softwareVersionManager.arm64")}
                </option>
                <option value="x86">
                  {i18n.t("policies:software.softwareVersionManager.x86")}
                </option>
              </select>
            </div>
          </div>

          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              {i18n.t("policies:software.softwareVersionManager.downloadURL")}
            </label>
            <div className="mt-2">
              <VariableInput
                value={formState.downloadUrl}
                onChange={handleDownloadUrlChange}
                placeholder={i18n.t(
                  "policies:software.softwareVersionManager.httpsExampleComPackageV100",
                )}
                customFields={customFields}
                tenantVariables={tenantVariables}
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {i18n.t(
                "policies:software.softwareVersionManager.provideADirectDownloadURLOrUpload",
              )}{" "}
              <code className="font-mono">
                {'{{org.name}}'}
              </code>
              {i18n.t(
                "policies:software.softwareVersionManager.resolvePerOrganizationAtDeployTime",
              )}
            </p>
            {/* Only shown for the URL source: the upload path derives the type
                from the uploaded filename and needs no operator input. */}
            {!formState.file && (
              <div className="mt-3">
                <label
                  className="text-xs font-semibold uppercase text-muted-foreground"
                  htmlFor="version-file-type"
                >
                  {i18n.t(
                    "policies:software.softwareVersionManager.installerType",
                  )}
                </label>
                <select
                  id="version-file-type"
                  data-testid="version-file-type"
                  value={formState.fileType}
                  onChange={(e) =>
                    handleFileTypeChange(e.target.value as "" | SoftwareFileType)
                  }
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">
                    {inferredFileType
                      ? i18n.t(
                          "policies:software.softwareVersionManager.autoDetectedType",
                          { type: inferredFileType.toUpperCase() },
                        )
                      : i18n.t(
                          "policies:software.softwareVersionManager.autoDetectFromUrl",
                        )}
                  </option>
                  {SOFTWARE_FILE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.toUpperCase()}
                    </option>
                  ))}
                </select>
                {formState.downloadUrl.trim() !== "" &&
                  !formState.fileType &&
                  !inferredFileType && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                      {i18n.t(
                        "policies:software.softwareVersionManager.installerTypeUndetected",
                      )}
                    </p>
                  )}
              </div>
            )}
          </div>

          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              {i18n.t("policies:software.softwareVersionManager.supportedOS")}
            </label>
            <div className="mt-2 flex items-center gap-4">
              {[
                i18n.t("policies:software.softwareVersionManager.windows"),
                i18n.t("policies:software.softwareVersionManager.macOS"),
                i18n.t("policies:software.softwareVersionManager.linux"),
              ].map((os) => (
                <label
                  key={os}
                  className="inline-flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={formState.supportedOs.includes(os.toLowerCase())}
                    onChange={(event) => {
                      const value = os.toLowerCase();
                      setFormState((prev) => ({
                        ...prev,
                        supportedOs: event.target.checked
                          ? [...prev.supportedOs, value]
                          : prev.supportedOs.filter((o) => o !== value),
                      }));
                    }}
                    className="h-4 w-4 rounded border"
                  />
                  {os}
                </label>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              {i18n.t("policies:software.softwareVersionManager.packageFile")}
            </label>
            <div className="mt-2 flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".msi,.exe,.dmg,.deb,.pkg"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                type="button"
                disabled={!uploadsEnabled}
                title={
                  uploadsEnabled
                    ? undefined
                    : i18n.t(
                        "policies:software.softwareVersionManager.uploadsRequireS3Storage",
                      )
                }
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background"
              >
                <Upload className="h-4 w-4" />
                {i18n.t("policies:software.softwareVersionManager.chooseFile")}
              </button>
              <span className="text-sm text-muted-foreground">
                {uploadsEnabled
                  ? formState.fileName ||
                    i18n.t(
                      "policies:software.softwareVersionManager.noFileSelectedMsiExeDmgDeb",
                    )
                  : i18n.t(
                      "policies:software.softwareVersionManager.uploadsRequireS3Storage",
                    )}
              </span>
            </div>
          </div>

          <div className="mt-4">
            <label className="text-xs font-semibold uppercase text-muted-foreground">
              {i18n.t(
                "policies:software.softwareVersionManager.silentInstallArgs",
              )}
            </label>
            <div className="mt-2">
              <VariableInput
                value={formState.silentInstallArgs}
                onChange={(value) =>
                  setFormState((prev) => ({
                    ...prev,
                    silentInstallArgs: value,
                  }))
                }
                placeholder={i18n.t(
                  "policies:software.softwareVersionManager.eGMsiexecIFileQnNorestart",
                )}
                customFields={customFields}
                tenantVariables={tenantVariables}
              />
            </div>
          </div>

          {/* Advanced disclosure mirrors AddPackageModal: uninstall args,
              detection rules and release notes stay out of the default view so
              install args no longer reads as a duplicated field. */}
          <div className="mt-4 border-t pt-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
              {i18n.t(
                "policies:software.softwareVersionManager.advancedOptions",
              )}
            </button>

            {advancedOpen && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className="text-xs font-semibold uppercase text-muted-foreground">
                    {i18n.t(
                      "policies:software.softwareVersionManager.silentUninstallArgs",
                    )}
                  </label>
                  <div className="mt-2">
                    <VariableInput
                      value={formState.silentUninstallArgs}
                      onChange={(value) =>
                        setFormState((prev) => ({
                          ...prev,
                          silentUninstallArgs: value,
                        }))
                      }
                      placeholder={i18n.t(
                        "policies:software.softwareVersionManager.eGMsiexecXFileQnNorestart",
                      )}
                      customFields={customFields}
                      tenantVariables={tenantVariables}
                    />
                  </div>
                </div>

                <DetectionRulesEditor
                  rules={formState.detectionRules}
                  onChange={(detectionRules) =>
                    setFormState((prev) => ({ ...prev, detectionRules }))
                  }
                />

                <div>
                  <label className="text-xs font-semibold uppercase text-muted-foreground">
                    {i18n.t(
                      "policies:software.softwareVersionManager.releaseNotes",
                    )}
                  </label>
                  <textarea
                    value={formState.notes}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        notes: event.target.value,
                      }))
                    }
                    placeholder={i18n.t(
                      "policies:software.softwareVersionManager.oneItemPerLine",
                    )}
                    className="mt-2 u-min-h-px-96 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Shown for the whole file transfer, including at 0%. The old
              `uploadProgress > 0` gate would make the bar vanish whenever the
              server reset progress to 0 on a lost-state resync — precisely the
              moment the user most needs to see something is still happening. */}
          {saving && formState.file !== null && (
            <div className="mt-4" data-testid="version-upload-progress">
              <div className="h-2 w-full rounded-full bg-muted">
                <div
                  data-testid="version-upload-progress-bar"
                  className="h-2 rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t("policies:software.softwareVersionManager.uploading")}
                {uploadProgress}%
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid="version-form-cancel"
              onClick={handleCancelForm}
              className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted"
            >
              {i18n.t("common:actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving || tokenErrors.length > 0}
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving
                ? formState.file
                  ? i18n.t("policies:software.softwareVersionManager.uploading")
                  : i18n.t("policies:software.softwareVersionManager.saving")
                : formState.file
                  ? i18n.t(
                      "policies:software.softwareVersionManager.uploadSave",
                    )
                  : i18n.t(
                      "policies:software.softwareVersionManager.saveVersion",
                    )}
            </button>
          </div>
        </form>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {i18n.t(
                "policies:software.softwareVersionManager.versionHistory",
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.softwareVersionManager.trackBuildsAndSetTheLatestPackage",
              )}
            </p>
          </div>
          {latestVersion && (
            <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
              <CheckCircle className="h-4 w-4 text-emerald-500" />
              {i18n.t("policies:software.softwareVersionManager.latest")}
              {latestVersion.version}
            </span>
          )}
        </div>

        <div className="mt-5 overflow-x-auto rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  {i18n.t("policies:software.softwareVersionManager.version2")}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:software.softwareVersionManager.releaseDate",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:software.softwareVersionManager.architecture2",
                  )}
                </th>
                <th className="px-4 py-3">{i18n.t("common:labels.type")}</th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.softwareVersionManager.latest2")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {versions.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-muted-foreground"
                  >
                    {i18n.t(
                      "policies:software.softwareVersionManager.noVersionsFound",
                    )}
                  </td>
                </tr>
              ) : (
                versions.map((entry) => (
                  <tr key={entry.id} className="text-sm">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setSelectedVersionId(entry.id)}
                        className="text-left text-sm font-medium text-foreground hover:text-primary"
                      >
                        {i18n.t("policies:software.softwareVersionManager.v")}
                        {entry.version}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDate(entry.releaseDate, timezone)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full border px-2 py-1 text-xs font-medium text-muted-foreground">
                        {entry.architecture}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.fileType ? entry.fileType.toUpperCase() : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={entry.id === latestId}
                          onChange={() => {
                            void handlePromoteLatest(entry.id);
                          }}
                          disabled={promotingVersionId === entry.id || saving}
                          className="h-4 w-4 rounded border"
                        />
                        {promotingVersionId === entry.id
                          ? i18n.t(
                              "policies:software.softwareVersionManager.saving",
                            )
                          : i18n.t(
                              "policies:software.softwareVersionManager.setAsLatest",
                            )}
                      </label>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!embedded && selectedVersion && latestVersion && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-semibold">
                {i18n.t("policies:software.softwareVersionManager.whatSNew")}
              </h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.softwareVersionManager.selectedReleaseHighlights",
              )}
            </p>
            <div className="mt-4 space-y-3">
              {selectedVersion.notes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {i18n.t(
                    "policies:software.softwareVersionManager.noReleaseNotesForThisBuild",
                  )}
                </p>
              ) : (
                selectedVersion.notes.map((note) => (
                  <div key={note} className="flex items-start gap-2 text-sm">
                    <span className="mt-1 h-2 w-2 rounded-full bg-primary" />
                    <span>{note}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center gap-2">
              <Download className="h-5 w-5 text-primary" />
              <h3 className="text-lg font-semibold">
                {i18n.t(
                  "policies:software.softwareVersionManager.versionComparison",
                )}
              </h3>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.softwareVersionManager.compareTheSelectedBuildAgainstLatest",
              )}
            </p>

            <div className="mt-4 space-y-4">
              <div className="rounded-md border bg-muted/30 p-4">
                <p className="text-xs uppercase text-muted-foreground">
                  {i18n.t(
                    "policies:software.softwareVersionManager.latestBuild",
                  )}
                </p>
                <p className="mt-2 text-lg font-semibold">
                  {i18n.t("policies:software.softwareVersionManager.v2")}
                  {latestVersion.version}
                </p>
                <p className="text-sm text-muted-foreground">
                  {i18n.t("policies:software.softwareVersionManager.released")}
                  {formatDate(latestVersion.releaseDate, timezone)}
                </p>
              </div>
              <div
                className={cn(
                  "rounded-md border p-4",
                  selectedVersion.id === latestVersion.id
                    ? "bg-emerald-500/10 border-emerald-500/30"
                    : "bg-muted/30",
                )}
              >
                <p className="text-xs uppercase text-muted-foreground">
                  {i18n.t(
                    "policies:software.softwareVersionManager.selectedBuild",
                  )}
                </p>
                <p className="mt-2 text-lg font-semibold">
                  {i18n.t("policies:software.softwareVersionManager.v3")}
                  {selectedVersion.version}
                </p>
                <p className="text-sm text-muted-foreground">
                  {i18n.t("policies:software.softwareVersionManager.released2")}
                  {formatDate(selectedVersion.releaseDate, timezone)}
                </p>
                {selectedVersion.id === latestVersion.id && (
                  <p className="mt-2 text-xs text-emerald-600">
                    {i18n.t(
                      "policies:software.softwareVersionManager.upToDate",
                    )}
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
