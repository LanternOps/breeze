import {
  CheckCircle2,
  Cloud,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Server,
  Shield,
  XCircle,
} from "lucide-react";
import { deriveS3RegionFromEndpoint } from "@breeze/shared";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { i18n } from "@/lib/i18n";
import { ToggleRow, FieldError } from "./backupTabPrimitives";

// ── Shared types ───────────────────────────────────────────────────────────────
export type BackupProvider = "s3" | "local";

export type BackupConfig = {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  details: Record<string, unknown>;
  encryption?: {
    enabled?: boolean;
    status?: string;
    mode?: string;
    reason?: string;
  } | null;
  providerCapabilities?: {
    objectLock: {
      supported: boolean;
      checkedAt: string;
      error: string | null;
    };
  } | null;
  createdAt: string;
  updatedAt: string;
};

// All state for the create/edit destination sub-form lives in one object so it
// can never leak into policy-settings state (the s3Prefix bug class, 7db8b7c14).
export type ConfigFormState = {
  name: string;
  provider: BackupProvider;
  bucket: string;
  region: string;
  regionTouched: boolean;
  accessKey: string;
  secretKey: string;
  endpoint: string;
  prefix: string;
  localPath: string;
  encryption: boolean;
  // SSE settings carried through edits so a rename/region fix never strips
  // serverSideEncryption/kmsKeyId from an encrypted config (the API's
  // preserveSecretFields only re-merges secret keys, and its encryption
  // re-check 400s when they go missing). Enabling encryption on a config
  // without an algorithm defaults to SSE-S3 (AES256) — the only mode the
  // API can enforce without a KMS key.
  sseAlgorithm: string | null;
  kmsKeyId: string | null;
};

export const emptyConfigForm: ConfigFormState = {
  name: "",
  provider: "s3",
  bucket: "",
  region: "us-east-1",
  regionTouched: false,
  accessKey: "",
  secretKey: "",
  endpoint: "",
  prefix: "",
  localPath: "/var/backups/breeze",
  encryption: false,
  sseAlgorithm: null,
  kmsKeyId: null,
};

export type DestinationMode = "select" | "create" | "edit";

export type TestStatus = "idle" | "testing" | "success" | "failed";

// ── Capability helpers (also used by the Protection section) ───────────────────
export function getObjectLockCapability(config?: BackupConfig | null) {
  return config?.providerCapabilities?.objectLock ?? null;
}

export function supportsProviderImmutability(
  config?: BackupConfig | null,
): boolean {
  return (
    config?.provider === "s3" &&
    getObjectLockCapability(config)?.supported === true
  );
}

export function capabilitySummary(config?: BackupConfig | null): string {
  if (!config) {
    return i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.capabilitySelectConfig",
    );
  }
  const capability = getObjectLockCapability(config);
  if (config.provider !== "s3") {
    return i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.capabilityS3Only",
    );
  }
  if (!capability) {
    return i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.capabilityRunTest",
    );
  }
  if (capability.supported) {
    return i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.capabilityVerifiedOn",
      { date: formatDateTime(capability.checkedAt) },
    );
  }
  return (
    capability.error ??
    i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.capabilityUnavailable",
    )
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  s3: "Amazon S3",
  local: "Local / NAS",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function objectLockText(config: BackupConfig): string {
  if (config.provider !== "s3") {
    return i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.notSupported",
    );
  }
  const capability = getObjectLockCapability(config);
  if (!capability) {
    return i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.untested",
    );
  }
  return capability.supported
    ? i18n.t("policies:configurationPolicies.featureTabs.backupTab.verified")
    : i18n.t(
        "policies:configurationPolicies.featureTabs.backupTab.unavailable",
      );
}

// ── Destination card ───────────────────────────────────────────────────────────
function DestinationCard({
  config,
  selected,
  onSelect,
  onEdit,
  onTest,
  testStatus,
}: {
  config: BackupConfig;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onTest: () => void;
  testStatus: TestStatus;
}) {
  const detailLine =
    config.provider === "s3"
      ? [config.details.bucket, config.details.region]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .join(" · ")
      : typeof config.details.path === "string"
        ? config.details.path
        : "";
  return (
    <label
      className={`relative flex cursor-pointer flex-col gap-2 rounded-md border p-3 transition ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/40"
          : "border-muted hover:border-muted-foreground/30"
      }`}
    >
      <input
        type="radio"
        name="backupDestination"
        className="peer sr-only"
        checked={selected}
        onChange={onSelect}
        aria-label={config.name}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
      />
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {config.provider === "s3" ? (
            <Cloud className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium">{config.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {config.encryption?.enabled === true &&
            config.encryption?.status !== "unsupported" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Lock className="h-3 w-3" />
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.encryptedBadge",
              )}
            </span>
          )}
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              config.enabled
                ? "bg-emerald-500/15 text-emerald-700"
                : "bg-yellow-500/15 text-yellow-700"
            }`}
          >
            {config.enabled
              ? i18n.t("common:states.active")
              : i18n.t("common:states.disabled")}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{providerLabel(config.provider)}</span>
        {detailLine && (
          <span className="truncate font-mono text-foreground/80">
            {detailLine}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.objectLock",
          )}{" "}
          <span className="font-mono text-foreground/80">
            {objectLockText(config)}
          </span>
        </span>
        {selected && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onEdit();
              }}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition hover:bg-muted"
            >
              <Pencil className="h-3 w-3" />
              {i18n.t("common:actions.edit")}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onTest();
              }}
              disabled={testStatus === "testing"}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
            >
              {testStatus === "testing" && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {testStatus === "success" && (
                <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              )}
              {testStatus === "failed" && (
                <XCircle className="h-3 w-3 text-destructive" />
              )}
              {testStatus === "idle" && <Shield className="h-3 w-3" />}
              {testStatus === "testing"
                ? i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.testing2",
                  )
                : testStatus === "success"
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.connected",
                    )
                  : testStatus === "failed"
                    ? i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.failed2",
                      )
                    : i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.test",
                      )}
            </button>
          </div>
        )}
      </div>
    </label>
  );
}

// ── Main section ───────────────────────────────────────────────────────────────
export default function BackupDestinationSection({
  configs,
  configsLoading,
  selectedConfigId,
  onSelect,
  mode,
  onStartCreate,
  onCancelForm,
  onBeginEdit,
  form,
  onFormChange,
  fieldErrors,
  testStatus,
  testMessage,
  onTest,
}: {
  configs: BackupConfig[];
  configsLoading: boolean;
  selectedConfigId: string;
  onSelect: (id: string) => void;
  mode: DestinationMode;
  onStartCreate: () => void;
  onCancelForm: () => void;
  onBeginEdit: (config: BackupConfig) => void;
  form: ConfigFormState;
  onFormChange: (patch: Partial<ConfigFormState>) => void;
  fieldErrors: Record<string, string>;
  testStatus: TestStatus;
  testMessage?: string;
  onTest: () => void;
}) {
  const selectedConfig = configs.find((c) => c.id === selectedConfigId);
  const showForm = mode === "create" || mode === "edit";

  if (configsLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
        {[0, 1].map((n) => (
          <div
            key={n}
            className="h-24 animate-pulse rounded-md border border-muted bg-muted/30"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {configs.length === 0 && !showForm && (
        <div className="rounded-md border border-dashed p-4 text-sm">
          <p className="font-medium">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.noDestinationsTitle",
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.noDestinationsBody",
            )}
          </p>
        </div>
      )}

      {/* The picker and the create/edit form are mutually exclusive: leaving the
          cards clickable while the form edits a specific config lets selection
          and edit target silently desync. */}
      {configs.length > 0 && !showForm && (
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
          {configs.map((config) => (
            <DestinationCard
              key={config.id}
              config={config}
              selected={config.id === selectedConfigId}
              onSelect={() => onSelect(config.id)}
              onEdit={() => onBeginEdit(config)}
              onTest={onTest}
              testStatus={config.id === selectedConfigId ? testStatus : "idle"}
            />
          ))}
          <button
            type="button"
            onClick={onStartCreate}
            className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed p-3 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-primary"
          >
            <Plus className="h-4 w-4" />
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.newDestination",
            )}
          </button>
        </div>
      )}

      {selectedConfig &&
        !showForm &&
        capabilitySummary(selectedConfig) !== testMessage && (
          <p className="text-xs text-muted-foreground">
            {capabilitySummary(selectedConfig)}
          </p>
        )}

      {testMessage && !showForm && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            testStatus === "failed"
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
          }`}
        >
          {testMessage}
        </div>
      )}

      {showForm && (
        <div className="space-y-4 rounded-md border bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium">
                {mode === "edit"
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.editingStorageConfiguration",
                    )
                  : i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.newDestination",
                    )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.destinationInfraNote",
                )}
              </p>
            </div>
            {(configs.length > 0 || mode === "edit") && (
              <button
                type="button"
                onClick={onCancelForm}
                className="shrink-0 text-xs text-primary hover:underline"
              >
                {i18n.t("common:actions.cancel")}
              </button>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.configurationName",
              )}
            </label>
            <input
              value={form.name}
              onChange={(e) => onFormChange({ name: e.target.value })}
              placeholder={i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.eGProductionS3Backups",
              )}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <FieldError message={fieldErrors.configName} />
          </div>

          {/* Provider is immutable once created — hide the picker while editing */}
          {mode !== "edit" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.provider",
                )}
              </label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {(
                  [
                    {
                      value: "s3" as const,
                      label: i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.amazonS3S3Compatible",
                      ),
                      description: i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.aWSS3MinIOWasabiBackblazeB2",
                      ),
                      icon: Cloud,
                    },
                    {
                      value: "local" as const,
                      label: i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.localNetworkPath",
                      ),
                      description: i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.localDiskNASOrUNCShare",
                      ),
                      icon: Server,
                    },
                  ] as const
                ).map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <label
                      key={opt.value}
                      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition has-focus-visible:ring-2 has-focus-visible:ring-ring ${
                        form.provider === opt.value
                          ? "border-primary/40 bg-primary/10"
                          : "border-muted hover:border-muted-foreground/30"
                      }`}
                    >
                      <input
                        type="radio"
                        name="backupProvider"
                        value={opt.value}
                        checked={form.provider === opt.value}
                        onChange={() => onFormChange({ provider: opt.value })}
                        className="sr-only"
                      />
                      <Icon
                        className={`mt-0.5 h-5 w-5 shrink-0 ${form.provider === opt.value ? "text-primary" : "text-muted-foreground"}`}
                      />
                      <div>
                        <span className="font-medium text-foreground">
                          {opt.label}
                        </span>
                        <p className="text-xs text-muted-foreground">
                          {opt.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {form.provider === "s3" && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.bucketName",
                    )}
                  </label>
                  <input
                    value={form.bucket}
                    onChange={(e) => onFormChange({ bucket: e.target.value })}
                    placeholder={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.myBackupBucket",
                    )}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <FieldError message={fieldErrors.bucket} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.region2",
                    )}
                  </label>
                  <input
                    value={form.region}
                    onChange={(e) =>
                      onFormChange({
                        region: e.target.value,
                        regionTouched: true,
                      })
                    }
                    placeholder={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.usEast1",
                    )}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <FieldError message={fieldErrors.region} />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.accessKeyID",
                    )}
                  </label>
                  <input
                    value={form.accessKey}
                    onChange={(e) =>
                      onFormChange({ accessKey: e.target.value })
                    }
                    placeholder={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.aKIA",
                    )}
                    autoComplete="off"
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.secretAccessKey",
                    )}
                  </label>
                  <input
                    type="password"
                    value={form.secretKey}
                    onChange={(e) =>
                      onFormChange({ secretKey: e.target.value })
                    }
                    placeholder={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.secretKey",
                    )}
                    autoComplete="off"
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
              {mode === "edit" && (
                <p className="chart-legend-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.secretsUnchangedHint",
                  )}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.pathPrefix",
                    )}
                    <span className="text-muted-foreground/60">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.optional",
                      )}
                    </span>
                  </label>
                  <input
                    value={form.prefix}
                    onChange={(e) => onFormChange({ prefix: e.target.value })}
                    placeholder={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.backupsBreeze",
                    )}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <p className="mt-1 chart-legend-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.keyPrefixForOrganizingObjectsInThe",
                    )}
                  </p>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.customEndpoint",
                    )}
                    <span className="text-muted-foreground/60">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.optional2",
                      )}
                    </span>
                  </label>
                  <input
                    value={form.endpoint}
                    onChange={(e) => {
                      const value = e.target.value;
                      // Providers like Backblaze B2 encode the signing region
                      // in the endpoint — fill it in unless the user set one.
                      const derived = deriveS3RegionFromEndpoint(value);
                      if (
                        derived &&
                        (!form.regionTouched || !form.region.trim())
                      ) {
                        onFormChange({ endpoint: value, region: derived });
                      } else {
                        onFormChange({ endpoint: value });
                      }
                    }}
                    placeholder={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.httpsS3UsWest002Backblazeb2Com",
                    )}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <p className="mt-1 chart-legend-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.forMinIOWasabiBackblazeB2Etc",
                    )}
                  </p>
                </div>
              </div>
            </div>
          )}

          {form.provider === "local" && (
            <div>
              <label className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.backupPath",
                )}
              </label>
              <input
                value={form.localPath}
                onChange={(e) => onFormChange({ localPath: e.target.value })}
                placeholder={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.varBackupsBreezeOrNasBackups",
                )}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 chart-legend-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.localDiskPathMountedNASOrUNC",
                )}
              </p>
              <FieldError message={fieldErrors.localPath} />
            </div>
          )}

          {/* Encryption is enforceable only for S3 (SSE); the API rejects it for
              local paths, so don't offer a control that can never save. */}
          {form.provider === "s3" && (
            <ToggleRow
              label={i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.encryptionLabel",
              )}
              description={i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.encryptionDescription",
              )}
              checked={form.encryption}
              onChange={(checked) => onFormChange({ encryption: checked })}
            />
          )}
        </div>
      )}
    </div>
  );
}
