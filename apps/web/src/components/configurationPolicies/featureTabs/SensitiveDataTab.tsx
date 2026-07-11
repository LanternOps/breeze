import { useState, useEffect } from "react";
import { ScanSearch, Plus, Trash2 } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
const DETECTION_CLASSES = [
  {
    value: "credential",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.credentials",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.aPIKeysPasswordsTokens",
    ),
  },
  {
    value: "pci",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.pCI",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.creditCardNumbersCVVs",
    ),
  },
  {
    value: "phi",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.pHI",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.protectedHealthInformation",
    ),
  },
  {
    value: "pii",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.pII",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.sSNsAddressesPhoneNumbers",
    ),
  },
  {
    value: "financial",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.financial",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.sensitiveDataTab.bankAccountsRoutingNumbers",
    ),
  },
] as const;
type SensitiveDataSettings = {
  detectionClasses: string[];
  includePaths: string[];
  excludePaths: string[];
  fileTypes: string[];
  maxFileSizeBytes: number;
  workers: number;
  timeoutSeconds: number;
  suppressPatternIds: string[];
  scheduleType: "manual" | "interval" | "cron";
  intervalMinutes?: number;
  cron?: string;
  timezone: string;
};
const defaults: SensitiveDataSettings = {
  detectionClasses: ["credential"],
  includePaths: [],
  excludePaths: [],
  fileTypes: [],
  maxFileSizeBytes: 104857600,
  workers: 4,
  timeoutSeconds: 300,
  suppressPatternIds: [],
  scheduleType: "manual",
  intervalMinutes: undefined,
  cron: undefined,
  timezone: "UTC",
};
const arrayKeys = [
  "detectionClasses",
  "includePaths",
  "excludePaths",
  "fileTypes",
  "suppressPatternIds",
] as const;
function normalizeSensitiveData(
  s: SensitiveDataSettings,
): SensitiveDataSettings {
  for (const k of arrayKeys) {
    if (!Array.isArray(s[k])) (s as any)[k] = [...defaults[k]];
  }
  return s;
}
export default function SensitiveDataTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
}: FeatureTabProps) {
  useTranslation("policies");
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const [settings, setSettings] = useState<SensitiveDataSettings>(() => {
    const stored = existingLink?.inlineSettings as
      | Partial<SensitiveDataSettings>
      | undefined;
    return normalizeSensitiveData({ ...defaults, ...stored });
  });
  const [newIncludePath, setNewIncludePath] = useState("");
  const [newExcludePath, setNewExcludePath] = useState("");
  const [newFileType, setNewFileType] = useState("");
  const [newSuppressId, setNewSuppressId] = useState("");
  useEffect(() => {
    if (existingLink?.inlineSettings) {
      setSettings((prev) =>
        normalizeSensitiveData({
          ...prev,
          ...(existingLink.inlineSettings as Partial<SensitiveDataSettings>),
        }),
      );
    }
  }, [existingLink]);
  const meta = FEATURE_META.sensitive_data;
  const update = <K extends keyof SensitiveDataSettings>(
    key: K,
    value: SensitiveDataSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const toggleClass = (cls: string) => {
    const current = settings.detectionClasses;
    if (current.includes(cls)) {
      if (current.length <= 1) return;
      update(
        "detectionClasses",
        current.filter((c) => c !== cls),
      );
    } else {
      update("detectionClasses", [...current, cls]);
    }
  };
  const addToList = (
    key: "includePaths" | "excludePaths" | "fileTypes" | "suppressPatternIds",
    value: string,
    setter: (v: string) => void,
  ) => {
    const trimmed = value.trim();
    if (!trimmed || settings[key].includes(trimmed)) return;
    update(key, [...settings[key], trimmed]);
    setter("");
  };
  const removeFromList = (
    key: "includePaths" | "excludePaths" | "fileTypes" | "suppressPatternIds",
    value: string,
  ) => {
    update(
      key,
      settings[key].filter((item) => item !== value),
    );
  };
  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "sensitive_data",
      featurePolicyId: linkedPolicyId,
      inlineSettings: settings,
    });
    if (result) onLinkChanged(result, "sensitive_data");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "sensitive_data");
  };
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ScanSearch className="h-5 w-5" />}
      isConfigured={!!existingLink}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink ? handleRemove : undefined}
    >
      {/* Detection Classes */}
      <div>
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.detectionClasses",
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.selectWhichTypesOfSensitiveDataTo",
          )}
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {DETECTION_CLASSES.map((cls) => (
            <button
              key={cls.value}
              type="button"
              onClick={() => toggleClass(cls.value)}
              className={`flex flex-col items-start rounded-md border px-4 py-3 text-left transition ${
                settings.detectionClasses.includes(cls.value)
                  ? "border-primary bg-primary/5"
                  : "hover:bg-muted/50"
              }`}
            >
              <span className="text-sm font-medium">{cls.label}</span>
              <span className="text-xs text-muted-foreground">
                {cls.description}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Scan Scope */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ListEditor
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.includePaths",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.directoriesToIncludeInScanEmptyMeans",
          )}
          items={settings.includePaths}
          value={newIncludePath}
          onChange={setNewIncludePath}
          onAdd={() =>
            addToList("includePaths", newIncludePath, setNewIncludePath)
          }
          onRemove={(v) => removeFromList("includePaths", v)}
          placeholder={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.homeVarData",
          )}
        />
        <ListEditor
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.excludePaths",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.directoriesToSkipDuringScan",
          )}
          items={settings.excludePaths}
          value={newExcludePath}
          onChange={setNewExcludePath}
          onAdd={() =>
            addToList("excludePaths", newExcludePath, setNewExcludePath)
          }
          onRemove={(v) => removeFromList("excludePaths", v)}
          placeholder={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.tmpProc",
          )}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ListEditor
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.fileTypes",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.fileExtensionsToScanEmptyMeansAll",
          )}
          items={settings.fileTypes}
          value={newFileType}
          onChange={setNewFileType}
          onAdd={() => addToList("fileTypes", newFileType, setNewFileType)}
          onRemove={(v) => removeFromList("fileTypes", v)}
          placeholder={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.txtCsvLog",
          )}
        />
        <div>
          <label className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.sensitiveDataTab.maxFileSize",
            )}
          </label>
          <p className="text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.sensitiveDataTab.maximumFileSizeToScanMB",
            )}
          </p>
          <input
            type="number"
            min={1}
            max={1024}
            value={Math.round(settings.maxFileSizeBytes / (1024 * 1024))}
            onChange={(e) =>
              update("maxFileSizeBytes", Number(e.target.value) * 1024 * 1024)
            }
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-32"
          />
        </div>
      </div>

      {/* Performance */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.performance",
          )}
        </h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.sensitiveDataTab.workers132",
              )}
            </label>
            <input
              type="range"
              min={1}
              max={32}
              value={settings.workers}
              onChange={(e) => update("workers", Number(e.target.value))}
              className="mt-2 w-full"
            />
            <span className="text-sm text-muted-foreground">
              {settings.workers}
              {i18n.t(
                "policies:configurationPolicies.featureTabs.sensitiveDataTab.workers",
              )}
            </span>
          </div>
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.sensitiveDataTab.timeout51800s",
              )}
            </label>
            <input
              type="range"
              min={5}
              max={1800}
              step={5}
              value={settings.timeoutSeconds}
              onChange={(e) => update("timeoutSeconds", Number(e.target.value))}
              className="mt-2 w-full"
            />
            <span className="text-sm text-muted-foreground">
              {settings.timeoutSeconds}
              {i18n.t(
                "policies:configurationPolicies.featureTabs.sensitiveDataTab.s",
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Suppressions */}
      <div className="mt-6">
        <ListEditor
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.suppressPatternIDs",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.patternIDsToSuppressFromResults",
          )}
          items={settings.suppressPatternIds}
          value={newSuppressId}
          onChange={setNewSuppressId}
          onAdd={() =>
            addToList("suppressPatternIds", newSuppressId, setNewSuppressId)
          }
          onRemove={(v) => removeFromList("suppressPatternIds", v)}
          placeholder={i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.patternId",
          )}
        />
      </div>

      {/* Schedule */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.sensitiveDataTab.schedule",
          )}
        </h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-xs uppercase text-muted-foreground">
              {i18n.t("common:labels.type")}
            </label>
            <select
              value={settings.scheduleType}
              onChange={(e) =>
                update(
                  "scheduleType",
                  e.target.value as SensitiveDataSettings["scheduleType"],
                )
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="manual">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.sensitiveDataTab.manual",
                )}
              </option>
              <option value="interval">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.sensitiveDataTab.interval",
                )}
              </option>
              <option value="cron">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.sensitiveDataTab.cron",
                )}
              </option>
            </select>
          </div>
          {settings.scheduleType === "interval" && (
            <div>
              <label className="text-xs uppercase text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.sensitiveDataTab.intervalMinutes",
                )}
              </label>
              <input
                type="number"
                min={5}
                max={10080}
                value={settings.intervalMinutes ?? 60}
                onChange={(e) =>
                  update("intervalMinutes", Number(e.target.value))
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
          {settings.scheduleType === "cron" && (
            <div>
              <label className="text-xs uppercase text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.sensitiveDataTab.cronExpression",
                )}
              </label>
              <input
                value={settings.cron ?? ""}
                onChange={(e) => update("cron", e.target.value)}
                placeholder="0 2 * * *"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
          {settings.scheduleType !== "manual" && (
            <div>
              <label className="text-xs uppercase text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.sensitiveDataTab.timezone",
                )}
              </label>
              <input
                value={settings.timezone}
                onChange={(e) => update("timezone", e.target.value)}
                placeholder={i18n.t(
                  "policies:configurationPolicies.featureTabs.sensitiveDataTab.uTC",
                )}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
        </div>
      </div>
    </FeatureTabShell>
  );
}
function ListEditor({
  label,
  description,
  items,
  value,
  onChange,
  onAdd,
  onRemove,
  placeholder,
}: {
  label: string;
  description: string;
  items: string[];
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  onRemove: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-2 flex gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) =>
            e.key ===
              i18n.t(
                "policies:configurationPolicies.featureTabs.sensitiveDataTab.enter",
              ) && (e.preventDefault(), onAdd())
          }
          placeholder={placeholder}
          className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          {i18n.t("common:actions.add")}
        </button>
      </div>
      <div className="mt-2 space-y-1">
        {items.map((item) => (
          <div
            key={item}
            className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-sm"
          >
            <span className="truncate">{item}</span>
            <button
              type="button"
              onClick={() => onRemove(item)}
              className="rounded-md border p-1 hover:bg-muted"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
