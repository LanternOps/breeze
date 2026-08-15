import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Loader2,
  Upload,
  Link2,
  HardDriveUpload,
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
import { Dialog } from "../shared/Dialog";
import { showToast } from "../shared/Toast";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError } from "../../lib/runAction";
import { findUnknownTokens } from "@/lib/installerVariables";
import { uploadPackageVersion } from "../../lib/softwarePackageUpload";
import DetectionRulesEditor from "./DetectionRulesEditor";
import VariableInput, { type DeviceCustomField } from "./VariableInput";
import { useTenantVariables } from "@/lib/tenantVariableTokens";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type Architecture = "x64" | "arm64" | "x86";
type Source = "url" | "file";
export interface CreatedPackage {
  id: string;
  name: string;
  vendor: string;
  category: string;
  description: string;
  createdAt: string;
  versionCount: number;
}
interface AddPackageModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once the package AND its first version are persisted. */
  onCreated: (pkg: CreatedPackage) => void;
}
const CATEGORIES = [
  "browser",
  "utility",
  "compression",
  "productivity",
  "communication",
  "developer",
  "media",
  "security",
] as const;
const OS_OPTIONS = ["Windows", "macOS", "Linux"] as const;
/**
 * Server-acknowledged bytes → a percentage safe to render as a CSS width.
 *
 * Progress from the chunked uploader is NOT monotonic: a lost-state resync
 * legitimately reports 0 bytes and the transfer restarts. That regression is
 * real and worth showing, so it is deliberately not clamped up to a high-water
 * mark — but it must never yield a negative width, and a zero/unknown total
 * must never yield `NaN%`. (Same helper as SoftwareVersionManager; duplicated
 * locally rather than exported, per the repo's shared-helper guidance.)
 */
function toPercent(sentBytes: number, totalBytes: number): number {
  if (!Number.isFinite(sentBytes) || !Number.isFinite(totalBytes)) return 0;
  if (totalBytes <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((sentBytes / totalBytes) * 100)));
}
const blankForm = {
  name: "",
  vendor: "",
  category: "utility",
  description: "",
  version: "",
  architecture: "x64" as Architecture,
  source: "url" as Source,
  downloadUrl: "",
  // "" = infer from the URL's extension server-side. Only meaningful for the URL
  // source; the file source derives it from the uploaded filename.
  fileType: "" as "" | SoftwareFileType,
  supportedOs: [] as string[],
  silentInstallArgs: "",
  silentUninstallArgs: "",
  detectionRules: [] as DetectionRule[],
  notes: "",
  file: null as File | null,
  fileName: "",
};
export default function AddPackageModal({
  open,
  onClose,
  onCreated,
}: AddPackageModalProps) {
  useTranslation("policies");
  const [form, setForm] = useState(blankForm);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [customFields, setCustomFields] = useState<DeviceCustomField[]>([]);
  // Tenant variables (#3409) — offered as `{{var.<key>}}` in the same picker.
  const tenantVariables = useTenantVariables(open);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // If the catalog item was created but the version write failed, keep its id so
  // a retry continues from the version step instead of creating a duplicate.
  const createdCatalogId = useRef<string | null>(null);
  // Owns the in-flight chunked upload so Cancel/close (and unmount) can actually
  // stop it. A ref, not state: it must survive re-renders without causing one.
  const uploadAbortRef = useRef<AbortController | null>(null);
  const titleId = useId();
  // Closing the modal's owner mid-upload must not leave the chunk loop running.
  useEffect(
    () => () => {
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
    },
    [],
  );
  /** True only when OUR controller aborted — i.e. the user cancelled/closed, or
   *  the modal unmounted. The uploader arms its own per-phase
   *  `AbortSignal.timeout` ceilings (30s create, 5min chunk, 10min complete);
   *  those abort a DIFFERENT signal and must stay visible as real failures, so
   *  ownership — not `err.name === 'AbortError'` — is what discriminates. */
  const wasUserCancelled = (controller: AbortController | null) =>
    controller !== null && controller.signal.aborted;
  useEffect(() => {
    if (!open) return;
    setForm(blankForm);
    setAdvancedOpen(false);
    createdCatalogId.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
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
              // Only offer keys that match the token grammar the resolver accepts,
              // so the picker never presents a token it would then flag as unknown.
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
  }, [open]);
  const update = <K extends keyof typeof blankForm>(
    key: K,
    value: (typeof blankForm)[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // A filename is a URL's last path segment as far as the derivation cares.
    const derived = deriveSoftwareFileTypeFromUrl(file.name);
    setForm((prev) => ({
      ...prev,
      file,
      fileName: file.name,
      ...applySilentArgsPrefill(prev, derived),
    }));
  };
  /** URL-source counterpart to handleFile: the extension in the URL is the only
   *  signal we have about what the installer actually is, so prefill the same
   *  MSI defaults from it. The prefill is retractable — see applySilentArgsPrefill
   *  for why leaving a stale msiexec command behind is actively dangerous. */
  const handleDownloadUrl = (value: string) => {
    setForm((prev) => ({
      ...prev,
      downloadUrl: value,
      ...applySilentArgsPrefill(
        prev,
        // An explicit selector choice outranks the URL for prefill purposes too.
        prev.fileType || deriveSoftwareFileTypeFromUrl(value),
      ),
    }));
  };
  /** Selector changes retract or install the prefill the same way a URL edit does. */
  const handleFileTypeChange = (value: "" | SoftwareFileType) => {
    setForm((prev) => ({
      ...prev,
      fileType: value,
      ...applySilentArgsPrefill(
        prev,
        value || deriveSoftwareFileTypeFromUrl(prev.downloadUrl),
      ),
    }));
  };
  /** What the server will infer when the user leaves the selector on "auto" —
   *  shown so an unrecognized URL doesn't silently fall back to exe. */
  const inferredFileType = useMemo(
    () => deriveSoftwareFileTypeFromUrl(form.downloadUrl),
    [form.downloadUrl],
  );
  const knownKeys = useMemo(
    () => new Set(customFields.map((f) => f.fieldKey)),
    [customFields],
  );
  const knownVariableKeys = useMemo(
    () => new Set(tenantVariables.map((v) => v.key)),
    [tenantVariables],
  );
  const tokenErrors = useMemo(() => {
    const opts = {
      requireKnownCustomKeys: knownKeys.size > 0,
      variableKeys: knownVariableKeys,
      requireKnownVariableKeys: knownVariableKeys.size > 0,
    };
    return [
      form.downloadUrl,
      form.silentInstallArgs,
      form.silentUninstallArgs,
    ].flatMap((s) => findUnknownTokens(s, knownKeys, opts));
  }, [
    form.downloadUrl,
    form.silentInstallArgs,
    form.silentUninstallArgs,
    knownKeys,
    knownVariableKeys,
  ]);
  const hasSource =
    form.source === "url" ? form.downloadUrl.trim() !== "" : form.file != null;
  const canSubmit =
    form.name.trim() !== "" &&
    form.version.trim() !== "" &&
    hasSource &&
    tokenErrors.length === 0 &&
    !saving;
  const buildVersionRequest = (
    catalogId: string,
    controller: AbortController | null,
  ): (() => Promise<Response>) => {
    const shared = {
      version: form.version.trim(),
      architecture: form.architecture,
      releaseNotes: form.notes || undefined,
      silentInstallArgs: form.silentInstallArgs || undefined,
      silentUninstallArgs: form.silentUninstallArgs || undefined,
      supportedOs: form.supportedOs.length > 0 ? form.supportedOs : undefined,
      detectionRules:
        form.detectionRules.length > 0 ? form.detectionRules : undefined,
    };
    if (form.source === "file" && form.file) {
      const file = form.file;
      // Chunked upload (#2951): each chunk is its own short request with a fresh
      // access token, so a multi-hundred-MB transfer can never outlive the token
      // TTL, and progress is real acknowledged bytes rather than a placeholder.
      // uploadPackageVersion RESOLVES with a Response (the /complete response,
      // or the first unrecoverable failing one), so it drops straight into
      // runAction's request slot — runAction keeps ownership of parsing the
      // body, deciding success vs failure, and toasting either way.
      return () =>
        uploadPackageVersion({
          catalogId,
          file,
          metadata: {
            ...shared,
            downloadUrl: form.downloadUrl.trim() || undefined,
          },
          onProgress: (sent, total) => setUploadProgress(toPercent(sent, total)),
          signal: controller?.signal,
        }).catch((err: unknown) => {
          // The uploader REJECTS on abort, and runAction toasts on ANY rejection
          // from its request thunk — which would put a red "upload failed" toast
          // on a cancel the user asked for. Resolve a 204 instead: runAction's
          // success path becomes a no-op (empty body, and successMessage returns
          // '' for a cancelled controller so nothing is toasted), and
          // handleSubmit's ownership guard returns before onCreated. Anything
          // NOT owned by our controller — including the uploader's own timeout
          // ceilings — still propagates and is surfaced by runAction.
          if (wasUserCancelled(controller)) return new Response(null, { status: 204 });
          throw err;
        });
    }
    return () =>
      fetchWithAuth(`/software/catalog/${catalogId}/versions`, {
        method: "POST",
        body: JSON.stringify({
          ...shared,
          downloadUrl: form.downloadUrl.trim() || undefined,
          // Omitted when left on "auto" so the server infers from the URL.
          fileType: form.fileType || undefined,
        }),
      });
  };
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    // A FRESH controller per submit: a retry after a cancelled attempt must not
    // inherit the previous (already aborted) signal, or the next genuine failure
    // would be silently swallowed as "the user cancelled". Only the file branch
    // is abortable; the metadata-only POST is a single short request and keeps
    // its previous behaviour exactly.
    const controller = form.source === "file" && form.file ? new AbortController() : null;
    uploadAbortRef.current = controller;
    setSaving(true);
    setUploadProgress(0);
    try {
      // Step 1 — create the catalog item (skip if a prior attempt already did).
      if (!createdCatalogId.current) {
        const item = await runAction<{
          id: string;
        }>({
          request: () =>
            fetchWithAuth("/software/catalog", {
              method: "POST",
              body: JSON.stringify({
                name: form.name.trim(),
                vendor: form.vendor.trim() || undefined,
                category: form.category,
                description: form.description.trim() || undefined,
              }),
            }),
          parseSuccess: (d) => {
            const data =
              (
                d as {
                  data?: {
                    id?: unknown;
                  };
                }
              ).data ??
              (d as {
                id?: unknown;
              });
            return {
              id: String(
                (
                  data as {
                    id?: unknown;
                  }
                ).id ?? "",
              ),
            };
          },
          errorFallback: i18n.t(
            "policies:software.addPackageModal.failedToCreatePackage",
          ),
        });
        createdCatalogId.current = item.id;
        // The cancel affordance opens BEFORE the transfer it cancels: a Cancel
        // during step 1 ran handleClose while this id was still null, so that
        // branch could not surface the package and the catalog row would be
        // exactly the invisible orphan it exists to prevent. Report it here
        // instead, and don't start an upload the user already walked away from.
        // No `await` separates the assignment above from this check, so a click
        // handler cannot interleave between them — either handleClose saw the
        // id (and reported it) or this does. onCreated fires exactly once.
        if (wasUserCancelled(controller)) {
          onCreated({
            id: item.id,
            name: form.name.trim(),
            vendor: form.vendor.trim(),
            category: form.category,
            description: form.description.trim(),
            createdAt: new Date().toISOString(),
            versionCount: 0,
          });
          return;
        }
      }
      const catalogId = createdCatalogId.current;
      if (!catalogId)
        throw new Error(
          i18n.t("policies:software.addPackageModal.missingPackageId"),
        );
      // Step 2 — add the first version. Success toast lands here so the user is
      // only told "added" once the package is actually deployable.
      await runAction({
        request: buildVersionRequest(catalogId, controller),
        errorFallback: i18n.t(
          "policies:software.addPackageModal.packageCreatedButAddingTheFirstVersion",
        ),
        // A cancel is not an "Added" event. runAction skips the toast for an
        // empty message, which is how the cancel path stays silent without
        // taking success/failure surfacing away from runAction.
        successMessage: () =>
          wasUserCancelled(controller)
            ? ""
            : `Added ${form.name.trim()} — v${form.version.trim()}`,
      });
      // A completion that lands after the user cancelled must not resurrect the
      // package they believe they abandoned (handleClose already reported it as
      // a 0-version item and closed the modal).
      if (wasUserCancelled(controller)) return;
      onCreated({
        id: catalogId,
        name: form.name.trim(),
        vendor: form.vendor.trim(),
        category: form.category,
        description: form.description.trim(),
        createdAt: new Date().toISOString(),
        versionCount: 1,
      });
      onClose();
    } catch (err) {
      // A cancel the user asked for is not a failure — exit quietly.
      if (wasUserCancelled(controller)) return;
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({
          type: "error",
          message: err instanceof Error ? err.message : "Failed to add package",
        });
      }
      // Non-401 ActionError already toasted by runAction. Modal stays open; if the
      // catalog item was created, createdCatalogId retries from the version step.
    } finally {
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
      setSaving(false);
      setUploadProgress(0);
    }
  };
  const handleClose = () => {
    // Abort BEFORE closing: closing unmounts the progress bar, so without this
    // the chunk loop would keep running invisibly against a modal the user
    // believes they dismissed.
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    // If step 1 (catalog) succeeded but the version write never did, surface the
    // created package (0 versions) so it isn't an invisible orphan the user would
    // re-create by adding the same name — they can then add a version or delete it.
    if (createdCatalogId.current) {
      onCreated({
        id: createdCatalogId.current,
        name: form.name.trim(),
        vendor: form.vendor.trim(),
        category: form.category,
        description: form.description.trim(),
        createdAt: new Date().toISOString(),
        versionCount: 0,
      });
    }
    onClose();
  };
  const uploadInFlight = saving && form.source === "file" && form.file !== null;
  // Backdrop/Esc close is live during a chunked upload because handleClose
  // aborts the transfer; the short metadata-only save stays blocked as before.
  const dialogCloseHandler =
    saving && !uploadInFlight ? () => {} : handleClose;
  const labelCls = "text-xs font-semibold uppercase text-muted-foreground";
  const inputCls =
    "mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring";
  return (
    <Dialog
      open={open}
      onClose={dialogCloseHandler}
      title={i18n.t("policies:software.addPackageModal.addSoftwarePackage")}
      labelledBy={titleId}
      maxWidth="2xl"
      alignTop
      className="flex max-h-[90vh] flex-col"
    >
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            {i18n.t("policies:software.addPackageModal.addSoftwarePackage2")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.addPackageModal.createThePackageAndItsFirstDeployable",
            )}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* Package identity */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground">
              {i18n.t("policies:software.addPackageModal.package")}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="pkg-name">
                  {i18n.t("common:labels.name")}
                </label>
                <input
                  id="pkg-name"
                  autoFocus
                  type="text"
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder={i18n.t(
                    "policies:software.addPackageModal.eGGoogleChrome",
                  )}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="pkg-vendor">
                  {i18n.t("policies:software.addPackageModal.vendor")}
                </label>
                <input
                  id="pkg-vendor"
                  type="text"
                  value={form.vendor}
                  onChange={(e) => update("vendor", e.target.value)}
                  placeholder={i18n.t(
                    "policies:software.addPackageModal.eGGoogle",
                  )}
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className={labelCls} htmlFor="pkg-category">
                {i18n.t("policies:software.addPackageModal.category")}
              </label>
              <select
                id="pkg-category"
                value={form.category}
                onChange={(e) => update("category", e.target.value)}
                className={inputCls}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* First version */}
          <section className="space-y-4 border-t pt-5">
            <h3 className="text-sm font-semibold text-foreground">
              {i18n.t("policies:software.addPackageModal.firstVersion")}
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="pkg-version">
                  {i18n.t("policies:software.addPackageModal.version")}
                </label>
                <input
                  id="pkg-version"
                  type="text"
                  value={form.version}
                  onChange={(e) => update("version", e.target.value)}
                  placeholder={i18n.t(
                    "policies:software.addPackageModal.eG100",
                  )}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="pkg-arch">
                  {i18n.t("policies:software.addPackageModal.architecture")}
                </label>
                <select
                  id="pkg-arch"
                  value={form.architecture}
                  onChange={(e) =>
                    update("architecture", e.target.value as Architecture)
                  }
                  className={inputCls}
                >
                  <option value="x64">
                    {i18n.t("policies:software.addPackageModal.x64")}
                  </option>
                  <option value="arm64">
                    {i18n.t("policies:software.addPackageModal.arm64")}
                  </option>
                  <option value="x86">
                    {i18n.t("policies:software.addPackageModal.x86")}
                  </option>
                </select>
              </div>
            </div>

            {/* Source: URL or file, one control */}
            <div>
              <span className={labelCls}>
                {i18n.t("policies:software.addPackageModal.source")}
              </span>
              <div
                className="mt-2 inline-flex rounded-md border bg-muted/40 p-0.5"
                role="tablist"
                aria-label={i18n.t(
                  "policies:software.addPackageModal.installerSource",
                )}
              >
                {(
                  [
                    [
                      "url",
                      i18n.t("policies:software.addPackageModal.downloadURL"),
                      Link2,
                    ],
                    [
                      "file",
                      i18n.t("policies:software.addPackageModal.uploadFile"),
                      HardDriveUpload,
                    ],
                  ] as const
                ).map(([val, label, Icon]) => (
                  <button
                    key={val}
                    type="button"
                    role="tab"
                    aria-selected={form.source === val}
                    onClick={() => update("source", val)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors",
                      form.source === val
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>

              {form.source === "url" ? (
                <div className="mt-3">
                  <VariableInput
                    id="pkg-url"
                    value={form.downloadUrl}
                    onChange={handleDownloadUrl}
                    placeholder={i18n.t(
                      "policies:software.addPackageModal.httpsExampleComPackageV100",
                    )}
                    customFields={customFields}
                    tenantVariables={tenantVariables}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:software.addPackageModal.useVariablesLike",
                    )}
                    <code className="font-mono">{"{{org.name}}"}</code>
                    {i18n.t(
                      "policies:software.addPackageModal.resolvedPerOrganizationAtDeployTime",
                    )}
                  </p>
                  {/* The installer type decides whether the agent runs msiexec or
                      execs the file directly, so an MSI behind a URL with no
                      recognizable extension has to be stated explicitly. */}
                  <div className="mt-3">
                    <label className={labelCls} htmlFor="pkg-file-type">
                      {i18n.t(
                        "policies:software.addPackageModal.installerType",
                      )}
                    </label>
                    <select
                      id="pkg-file-type"
                      data-testid="package-file-type"
                      value={form.fileType}
                      onChange={(e) =>
                        handleFileTypeChange(
                          e.target.value as "" | SoftwareFileType,
                        )
                      }
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="">
                        {inferredFileType
                          ? i18n.t(
                              "policies:software.addPackageModal.autoDetectedType",
                              { type: inferredFileType.toUpperCase() },
                            )
                          : i18n.t(
                              "policies:software.addPackageModal.autoDetectFromUrl",
                            )}
                      </option>
                      {SOFTWARE_FILE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t.toUpperCase()}
                        </option>
                      ))}
                    </select>
                    {form.downloadUrl.trim() !== "" &&
                      !form.fileType &&
                      !inferredFileType && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                        {i18n.t(
                          "policies:software.addPackageModal.installerTypeUndetected",
                        )}
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-3 flex items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".msi,.exe,.dmg,.deb,.pkg"
                    onChange={handleFile}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
                  >
                    <Upload className="h-4 w-4" />
                    {i18n.t("policies:software.addPackageModal.chooseFile")}
                  </button>
                  <span className="truncate text-sm text-muted-foreground">
                    {form.fileName ||
                      i18n.t(
                        "policies:software.addPackageModal.noFileSelectedMsiExeDmgDeb",
                      )}
                  </span>
                </div>
              )}
            </div>

            <div>
              <span className={labelCls}>
                {i18n.t("policies:software.addPackageModal.supportedOS")}
              </span>
              <div className="mt-2 flex flex-wrap items-center gap-4">
                {OS_OPTIONS.map((os) => {
                  const val = os.toLowerCase();
                  return (
                    <label
                      key={os}
                      className="inline-flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={form.supportedOs.includes(val)}
                        onChange={(e) =>
                          update(
                            "supportedOs",
                            e.target.checked
                              ? [...form.supportedOs, val]
                              : form.supportedOs.filter((o) => o !== val),
                          )
                        }
                        className="h-4 w-4 rounded border"
                      />
                      {os}
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="pkg-install">
                {i18n.t("policies:software.addPackageModal.silentInstallArgs")}
              </label>
              <div className="mt-2">
                <VariableInput
                  id="pkg-install"
                  value={form.silentInstallArgs}
                  onChange={(v) => update("silentInstallArgs", v)}
                  placeholder={i18n.t(
                    "policies:software.addPackageModal.eGMsiexecIFileQnNorestart",
                  )}
                  customFields={customFields}
                  tenantVariables={tenantVariables}
                />
              </div>
            </div>
          </section>

          {/* Advanced */}
          <section className="border-t pt-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen((o) => !o)}
              aria-expanded={advancedOpen}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
              {i18n.t("policies:software.addPackageModal.advancedOptions")}
            </button>

            {advancedOpen && (
              <div className="mt-4 space-y-4">
                <div>
                  <label className={labelCls} htmlFor="pkg-uninstall">
                    {i18n.t(
                      "policies:software.addPackageModal.silentUninstallArgs",
                    )}
                  </label>
                  <div className="mt-2">
                    <VariableInput
                      id="pkg-uninstall"
                      value={form.silentUninstallArgs}
                      onChange={(v) => update("silentUninstallArgs", v)}
                      placeholder={i18n.t(
                        "policies:software.addPackageModal.eGMsiexecXFileQnNorestart",
                      )}
                      customFields={customFields}
                      tenantVariables={tenantVariables}
                    />
                  </div>
                </div>

                <DetectionRulesEditor
                  rules={form.detectionRules}
                  onChange={(detectionRules) =>
                    update("detectionRules", detectionRules)
                  }
                />

                <div>
                  <label className={labelCls} htmlFor="pkg-notes">
                    {i18n.t("policies:software.addPackageModal.releaseNotes")}
                  </label>
                  <textarea
                    id="pkg-notes"
                    value={form.notes}
                    onChange={(e) => update("notes", e.target.value)}
                    placeholder={i18n.t(
                      "policies:software.addPackageModal.oneItemPerLine",
                    )}
                    className="mt-2 min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className={labelCls} htmlFor="pkg-desc">
                    {i18n.t("common:labels.description")}
                  </label>
                  <textarea
                    id="pkg-desc"
                    value={form.description}
                    onChange={(e) => update("description", e.target.value)}
                    placeholder={i18n.t(
                      "policies:software.addPackageModal.briefDescriptionOfTheSoftware",
                    )}
                    className="mt-2 min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* Sticky footer */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          {/* Shown for the whole file transfer, including at 0%. Gating on
              `uploadProgress > 0` would make the bar VANISH whenever the server
              resets progress on a lost-state resync — precisely the moment the
              user most needs to see something is still happening (it is what
              made the original 222MB upload read as a stall). */}
          {uploadInFlight && (
            <div
              data-testid="package-upload-progress"
              className="mr-auto flex items-center gap-2 text-xs text-muted-foreground"
            >
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                <div
                  data-testid="package-upload-progress-bar"
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              {uploadProgress}%
            </div>
          )}
          <button
            type="button"
            onClick={handleClose}
            // Cancel stays live during a chunked upload — it aborts the transfer
            // (handleClose). The short metadata-only save keeps its previous
            // disabled-while-saving behaviour: there is nothing to abort.
            disabled={saving && !uploadInFlight}
            className="inline-flex h-9 items-center justify-center rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            {i18n.t("common:actions.cancel")}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saving
              ? form.source === "file"
                ? i18n.t("policies:software.addPackageModal.uploading")
                : i18n.t("policies:software.addPackageModal.creating")
              : createdCatalogId.current
                ? i18n.t("policies:software.addPackageModal.retryAddingVersion")
                : i18n.t("policies:software.addPackageModal.createPackage")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
