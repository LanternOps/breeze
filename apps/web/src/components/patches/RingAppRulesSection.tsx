import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { useTranslation } from "react-i18next";
export type RingAppAction = "block" | "pin";
/** One per-app rule an Update Ring enforces (#8187); the shape of an entry in
 *  the API's `ringAppRulesSchema`. */
export type RingAppRule = {
  source: string;
  packageId: string;
  displayName?: string;
  action: RingAppAction;
  pinnedVersion?: string;
};
type AppOption = {
  source: string;
  packageId: string;
  vendor: string | null;
  displayName: string;
  inCatalog: boolean;
};
type Props = {
  rules: RingAppRule[];
  onChange: (rules: RingAppRule[]) => void;
};
// Canonical rule identity used everywhere else in the patch pipeline. The
// evaluator treats third_party and custom as one bucket, so the UI must dedupe
// them the same way before validation.
const ruleKey = (rule: { source: string; packageId: string }) => {
  const source = rule.source === "custom" ? "third_party" : rule.source;
  return `${source}|${rule.packageId.toLowerCase()}`;
};
export default function RingAppRulesSection({ rules, onChange }: Props) {
  const { t } = useTranslation(["patches", "common"]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<AppOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [manualPackageId, setManualPackageId] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!pickerOpen) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetchWithAuth(
          `/patches/app-options?search=${encodeURIComponent(search)}`,
        );
        if (response.ok) {
          const payload = await response.json();
          setOptions(Array.isArray(payload.data) ? payload.data : []);
          setLoadError(false);
        } else {
          console.error(
            "Failed to load application options: HTTP",
            response.status,
          );
          setOptions([]);
          setLoadError(true);
        }
      } catch (err) {
        console.error("Failed to load application options:", err);
        setOptions([]);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [pickerOpen, search]);
  const exists = (source: string, packageId: string) =>
    rules.some((rule) => ruleKey(rule) === ruleKey({ source, packageId }));
  const addRule = (option: {
    source: string;
    packageId: string;
    displayName?: string;
  }) => {
    if (exists(option.source, option.packageId)) return;
    onChange([
      ...rules,
      {
        source: option.source,
        packageId: option.packageId,
        displayName: option.displayName,
        action: "block",
      },
    ]);
    setPickerOpen(false);
    setSearch("");
    setManualPackageId("");
  };
  const updateRule = (key: string, patch: Partial<RingAppRule>) =>
    onChange(
      rules.map((rule) => (ruleKey(rule) === key ? { ...rule, ...patch } : rule)),
    );
  const removeRule = (key: string) =>
    onChange(rules.filter((rule) => ruleKey(rule) !== key));
  return (
    <div data-testid="ring-app-rules-section">
      <h3 className="text-sm font-semibold">
        {t("ringAppRules.applicationRules",
        )}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("ringAppRules.blockSpecificApplicationsFromAutomatedPatchingOr",
        )}{" "}
        {t("ringAppRules.scopeNote")}
      </p>

      {rules.length > 0 && (
        <ul className="mt-2 space-y-2">
          {rules.map((rule) => {
            const key = ruleKey(rule);
            return (
              <li
                key={key}
                className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
              >
                <span className="font-medium">
                  {rule.displayName ?? rule.packageId}
                </span>
                <span className="text-xs text-muted-foreground">
                  {rule.packageId}
                </span>
                <select
                  value={rule.action}
                  data-testid={`app-rule-action-${key}`}
                  onChange={(event) =>
                    updateRule(key, {
                      action: event.target.value as RingAppAction,
                      pinnedVersion:
                        event.target.value === "block"
                          ? undefined
                          : (rule.pinnedVersion ?? ""),
                    })
                  }
                  className="ml-auto h-8 rounded-md border bg-background px-2 text-xs"
                >
                  <option value="block">
                    {t("ringAppRules.blocked",
                    )}
                  </option>
                  <option value="pin">
                    {t("ringAppRules.pinned",
                    )}
                  </option>
                </select>
                {rule.action === "pin" && (
                  <input
                    type="text"
                    placeholder={t("ringAppRules.maxVersion",
                    )}
                    value={rule.pinnedVersion ?? ""}
                    data-testid={`app-rule-pin-version-${key}`}
                    onChange={(event) =>
                      updateRule(key, { pinnedVersion: event.target.value })
                    }
                    className="h-8 w-28 rounded-md border bg-background px-2 text-xs"
                  />
                )}
                <button
                  type="button"
                  aria-label={t("ringAppRules.removeRuleFor", { application: rule.displayName ?? rule.packageId })}
                  data-testid={`app-rule-remove-${key}`}
                  onClick={() => removeRule(key)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {rules.some((rule) => rule.action === "pin" && !rule.pinnedVersion?.trim()) && (
        <p className="mt-1 text-xs text-destructive">
          {t("ringAppRules.pinnedApplicationsNeedAVersion",
          )}
        </p>
      )}

      {!pickerOpen ? (
        <button
          type="button"
          data-testid="app-rules-add"
          onClick={() => setPickerOpen(true)}
          className="mt-2 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("ringAppRules.addApplication",
          )}
        </button>
      ) : (
        <div className="mt-2 rounded-md border p-3">
          <input
            type="text"
            placeholder={t("ringAppRules.searchCatalogAndDetectedApplications",
            )}
            value={search}
            data-testid="app-rules-search"
            onChange={(event) => setSearch(event.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            autoFocus
          />
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {loading && (
              <li className="text-xs text-muted-foreground">
                {t("ringAppRules.searching",
                )}
              </li>
            )}
            {!loading &&
              options.map((option) => (
                <li key={`${option.source}|${option.packageId}`}>
                  <button
                    type="button"
                    data-testid={`app-option-${option.source}-${option.packageId}`}
                    disabled={exists(option.source, option.packageId)}
                    onClick={() => addRule(option)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
                  >
                    <span>{option.displayName}</span>
                    <span className="text-xs text-muted-foreground">
                      {option.vendor ?? option.packageId}
                    </span>
                    {option.inCatalog && (
                      <span className="ml-auto text-[10px] uppercase text-muted-foreground">
                        {t("ringAppRules.catalog",
                        )}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            {!loading && loadError && (
              <li
                className="text-xs text-destructive"
                data-testid="app-rules-load-error"
              >
                {t("ringAppRules.couldnTLoadApplicationsYouCanStill",
                )}
              </li>
            )}
            {!loading && !loadError && options.length === 0 && (
              <li className="text-xs text-muted-foreground">
                {t("ringAppRules.noMatches",
                )}
              </li>
            )}
          </ul>
          <div className="mt-2 flex items-center gap-2 border-t pt-2">
            <input
              type="text"
              placeholder={t("ringAppRules.orEnterAPackageIDManually",
              )}
              value={manualPackageId}
              data-testid="app-rules-manual-id"
              onChange={(event) => setManualPackageId(event.target.value)}
              className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
            />
            <button
              type="button"
              data-testid="app-rules-manual-add"
              disabled={!manualPackageId.trim()}
              // Manual entries use 'third_party'; the evaluator matches third_party/custom as one bucket, so custom-source patches are still covered.
              onClick={() =>
                addRule({
                  source: "third_party",
                  packageId: manualPackageId.trim(),
                })
              }
              className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-50"
            >
              {t("common:actions.add")}
            </button>
            <button
              type="button"
              onClick={() => {
                setPickerOpen(false);
                setSearch("");
              }}
              className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              {t("common:actions.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
