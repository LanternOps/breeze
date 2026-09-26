import { findDuplicateConditions } from "./duplicateConditions";
import { DuplicateConditionNotice } from "./DuplicateConditionNotice";
import { useState, useEffect } from "react";
import { Radar, Trash2 } from "lucide-react";
import ConversionLedger from "../../monitoring/conversion/ConversionLedger";
import NeedsConversionPanel from "../../monitoring/conversion/NeedsConversionPanel";
import type { FeatureLink, FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { fetchWithAuth } from "../../../stores/auth";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";

type MonitorCatalogEntry = {
  id: string;
  name: string;
  kind: string;
  severity: string;
  enabled: boolean;
  builtinKey: string | null;
  condition: Record<string, unknown> | null;
};

// The attachment list this tab edits — mirrors monitorAttachmentItemSchema
// (packages/shared/src/validators/monitors.ts) minus `sortOrder`, which is
// derived from array position at save time rather than tracked per-item here.
type MonitorAttachmentItem = {
  monitorId: string;
  enabled: boolean;
  overrides?: Record<string, unknown>;
};

type InlineSettingsLike = { inlineSettings: Record<string, unknown> | null } | undefined;

type InheritanceMode = "cumulative" | "replace";
function readInheritance(link: InlineSettingsLike): InheritanceMode {
  const raw = (link?.inlineSettings as { inheritance?: unknown } | null | undefined)?.inheritance;
  return raw === "replace" ? "replace" : "cumulative";
}

function seedItems(link: InlineSettingsLike): MonitorAttachmentItem[] {
  const raw = (link?.inlineSettings as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => ({
      monitorId: String(it.monitorId ?? ""),
      enabled: it.enabled !== false,
      overrides:
        it.overrides && typeof it.overrides === "object" && !Array.isArray(it.overrides)
          ? { ...(it.overrides as Record<string, unknown>) }
          : undefined,
    }))
    .filter((it) => it.monitorId.length > 0);
}

const CHECK_INTERVAL_MIN = 10;
const CHECK_INTERVAL_MAX = 3600;
const CHECK_INTERVAL_DEFAULT = 60;

function readCheckInterval(link: InlineSettingsLike): number | undefined {
  const raw = (link?.inlineSettings as { checkIntervalSeconds?: unknown } | null | undefined)?.checkIntervalSeconds;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
// Empty-watch monitoring links carry only the check interval.
function linkHasLegacyRows(link: FeatureLink): boolean {
  if (link.featureType === "alert_rule" || link.featureType === "automation") return true;
  const watches = link.inlineSettings?.watches;
  return link.featureType === "monitoring" && Array.isArray(watches) && watches.length > 0;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: "border-destructive/40 bg-destructive/15 text-destructive",
  warning: "border-warning/40 bg-warning/15 text-warning",
  info: "border-blue-500/30 bg-blue-500/15 text-blue-700",
};

export default function MonitorsTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
  allLinks = [],
  siblingLinks,
}: FeatureTabProps) {
  const { t } = useTranslation("policies");
  const linkOf = (type: string) => allLinks.find((link) => link.featureType === type);
  const inlineRules = (linkOf("alert_rule")?.inlineSettings as { items?: Array<{ name?: string; conditions?: Array<Record<string, unknown>> }> } | undefined)?.items ?? [];
  const watches = (linkOf("monitoring")?.inlineSettings as { watches?: Array<{ watchType?: string; name?: string; enabled?: boolean }> } | undefined)?.watches ?? [];

  const hasLegacyRows = (siblingLinks ?? []).some(linkHasLegacyRows);
  const [ledgerRevision, setLedgerRevision] = useState(0);
  const refreshLinks = async () => {
    setLedgerRevision((n) => n + 1);
    const res = await fetchWithAuth(`/configuration-policies/${policyId}/features`);
    if (!res.ok) return;
    const json = await res.json();
    const links: FeatureLink[] = Array.isArray(json?.data) ? json.data : [];
    for (const type of ["monitors", "alert_rule", "monitoring", "automation"] as const) {
      onLinkChanged(links.find((link) => link.featureType === type) ?? null, type);
    }
  };

  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;

  const [items, setItems] = useState<MonitorAttachmentItem[]>(() =>
    seedItems(existingLink ?? parentLink),
  );
  useEffect(() => {
    setItems(seedItems(existingLink ?? parentLink));
  }, [existingLink, parentLink]);

  const meta = FEATURE_META.monitors;
  const [catalog, setCatalog] = useState<MonitorCatalogEntry[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();

  // Interval inheritance is field-level, independent of attachment inheritance.
  const ownCheckInterval = readCheckInterval(existingLink);
  const parentCheckInterval = readCheckInterval(parentLink);
  const savedCheckInterval = ownCheckInterval ?? parentCheckInterval ?? CHECK_INTERVAL_DEFAULT;
  const [checkInterval, setCheckInterval] = useState<string>(String(savedCheckInterval));
  const [checkIntervalError, setCheckIntervalError] = useState<string>();
  const [checkIntervalEdited, setCheckIntervalEdited] = useState(false);
  const [inheritance, setInheritance] = useState<InheritanceMode>(() => readInheritance(existingLink));
  useEffect(() => { setInheritance(readInheritance(existingLink)); }, [existingLink]);
  const parentItems = seedItems(parentLink);
  useEffect(() => {
    setCheckInterval(String(savedCheckInterval));
    setCheckIntervalEdited(false);
    setCheckIntervalError(undefined);
  }, [savedCheckInterval, policyId, existingLink, parentLink]);
  const isIntervalInherited = !checkIntervalEdited && ownCheckInterval === undefined && parentCheckInterval !== undefined;
  const intervalPayload = () => checkIntervalEdited ? { checkIntervalSeconds: Number(checkInterval) } : {};

  useEffect(() => {
    if (!meta.fetchUrl) {
      setCatalogLoading(false);
      return;
    }
    let cancelled = false;
    setCatalogLoading(true);
    fetchWithAuth(meta.fetchUrl)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            i18n.t(
              "policies:configurationPolicies.featureTabs.monitorsTab.failedToLoadMonitors",
            ),
          );
        }
        const json = await res.json();
        const rows = Array.isArray(json?.data) ? json.data : [];
        if (cancelled) return;
        setCatalog(
          rows.map((r: Record<string, unknown>) => ({
            id: String(r.id),
            name: String(r.name ?? r.id),
            kind: String(r.kind ?? ""),
            severity: String(r.severity ?? ""),
            enabled: Boolean(r.enabled),
            builtinKey: typeof r.builtinKey === "string" ? r.builtinKey : null,
            condition: r.condition && typeof r.condition === "object" && !Array.isArray(r.condition)
              ? r.condition as Record<string, unknown>
              : null,
          })),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setCatalogError(
          err instanceof Error
            ? err.message
            : i18n.t(
                "policies:configurationPolicies.featureTabs.monitorsTab.failedToLoadMonitors",
              ),
        );
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meta.fetchUrl]);

  const catalogById = new Map(catalog.map((c) => [c.id, c]));
  const attachedIds = new Set(items.map((it) => it.monitorId));
  const availableToAttach = catalog.filter((c) => !attachedIds.has(c.id));

  const builtIns = catalog.filter((c) => Boolean(c.builtinKey));
  const anyBuiltInAttached = items.some((item) => builtIns.some((b) => b.id === item.monitorId));
  const attachBuiltIns = () => setItems((previous) => {
    const attached = new Set(previous.map((item) => item.monitorId));
    return [...previous, ...builtIns.filter((b) => !attached.has(b.id))
      .map((b) => ({ monitorId: b.id, enabled: true }))];
  });

  const handleAttach = (monitorId: string) => {
    if (!monitorId || attachedIds.has(monitorId)) return;
    setItems((prev) => [...prev, { monitorId, enabled: true }]);
  };

  const handleDetach = (monitorId: string) => {
    setItems((prev) => prev.filter((it) => it.monitorId !== monitorId));
  };

  const handleToggleEnabled = (monitorId: string) => {
    setItems((prev) =>
      prev.map((it) => (it.monitorId === monitorId ? { ...it, enabled: !it.enabled } : it)),
    );
  };

  const handleOverrideValueChange = (monitorId: string, raw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.monitorId !== monitorId) return it;
        if (raw.trim() === "") {
          if (!it.overrides || !("value" in it.overrides)) return it;
          const rest: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(it.overrides)) {
            if (k !== "value") rest[k] = v;
          }
          return { ...it, overrides: Object.keys(rest).length > 0 ? rest : undefined };
        }
        const parsed = Number(raw);
        if (Number.isNaN(parsed)) return it;
        return { ...it, overrides: { ...(it.overrides ?? {}), value: parsed } };
      }),
    );
  };

  const buildPayloadItems = () =>
    items.map((it, idx) => ({
      monitorId: it.monitorId,
      enabled: it.enabled,
      overrides: it.overrides,
      sortOrder: idx,
    }));

  const saveAttachments = async (): Promise<boolean> => {
    if (!existingLink && items.length === 0 && !checkIntervalEdited && inheritance === "cumulative") return true;
    const result = await save(existingLink?.id ?? null, {
      featureType: "monitors",
      featurePolicyId: null,
      inlineSettings: { items: buildPayloadItems(), inheritance, ...intervalPayload() },
    });
    if (result) {
      setCheckIntervalEdited(false);
      onLinkChanged(result, "monitors");
    }
    return !!result;
  };

  const validateCheckInterval = (): boolean => {
    if (!checkIntervalEdited) return true;
    const parsed = Number(checkInterval);
    const ok = Number.isInteger(parsed) && parsed >= CHECK_INTERVAL_MIN && parsed <= CHECK_INTERVAL_MAX;
    setCheckIntervalError(ok ? undefined : i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.checkIntervalInvalid"));
    return ok;
  };

  const handleSave = async () => {
    clearError();
    if (!validateCheckInterval()) return;
    if (!(await saveAttachments())) return;
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    clearError();
    if (!validateCheckInterval()) return;
    const result = await save(existingLink.id, {
      featureType: "monitors",
      featurePolicyId: null,
      // Remove = stop overriding: an empty `replace` link would block every
      // monitor the parent attaches, so the kept link goes back to cumulative.
      inlineSettings: { items: [], inheritance: "cumulative", ...intervalPayload() },
    });
    if (result) {
      onLinkChanged(result, "monitors");
      setCheckIntervalEdited(false);
      setItems([]);
      setInheritance("cumulative");
    }
  };

  // Creates this policy's own link, seeded with a copy of whatever is
  // currently displayed (the parent's items) — the same one-shot pattern
  // every other inheritance-capable tab uses (see VulnerabilityTab). Once the
  // own link exists, FeatureTabShell stops disabling the editor and the
  // attach/detach/toggle/override controls below become live.
  const handleOverride = async () => {
    clearError();
    if (!validateCheckInterval()) return;
    const result = await save(null, {
      featureType: "monitors",
      featurePolicyId: null,
      inlineSettings: { items: buildPayloadItems(), inheritance, ...intervalPayload() },
    });
    if (result) {
      setCheckIntervalEdited(false);
      onLinkChanged(result, "monitors");
    }
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id, { successMessage: i18n.t("common:states.saved") });
    // D11 retains an empty link when it owns collection settings.
    // Read back the server state so that interval remains visible after revert.
    if (ok) await refreshLinks();
  };

  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<Radar className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error ?? catalogError}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={
        !isInherited && !!linkedPolicyId && !!existingLink ? handleRevert : undefined
      }
    >
      <DuplicateConditionNotice hits={findDuplicateConditions({ attached: items, catalog, inlineRules, watches })} />
      <div className="space-y-6">
        <div>
          <label className="text-sm font-medium" htmlFor="monitors-tab-attach-select">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.monitorsTab.attachMonitor",
            )}
          </label>
          <a data-testid="monitors-tab-create"
            href={`/alerts/monitors/new#policy=${encodeURIComponent(policyId)}`}
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm hover:bg-muted">
            {t('configurationPolicies.featureTabs.monitorsTab.createMonitor')}
          </a>
          <select
            id="monitors-tab-attach-select"
            data-testid="monitors-tab-attach-select"
            value=""
            disabled={catalogLoading || availableToAttach.length === 0}
            onChange={(e) => {
              if (e.target.value) handleAttach(e.target.value);
            }}
            className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="">
              {catalogLoading
                ? i18n.t(
                    "policies:configurationPolicies.featureTabs.monitorsTab.loadingMonitors",
                  )
                : availableToAttach.length === 0
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.monitorsTab.noMoreMonitorsToAttach",
                    )
                  : i18n.t(
                      "policies:configurationPolicies.featureTabs.monitorsTab.selectAMonitorToAttach",
                    )}
            </option>
            {availableToAttach.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.kind})
              </option>
            ))}
          </select>
        </div>

        {!catalogLoading && !catalogError && builtIns.length > 0 && !anyBuiltInAttached && (
          <div data-testid="monitors-tab-recommended" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3 text-sm">
            <div>
              <p className="font-medium">{t('configurationPolicies.featureTabs.monitorsTab.recommended.title')}</p>
              <p className="text-muted-foreground">{t('configurationPolicies.featureTabs.monitorsTab.recommended.body')}</p>
            </div>
            <button type="button" data-testid="monitors-tab-recommended-attach"
              className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-primary-foreground"
              onClick={attachBuiltIns}>
              {t('configurationPolicies.featureTabs.monitorsTab.recommended.action')}
            </button>
          </div>
        )}

        <fieldset className="rounded-md border bg-background p-4" data-testid="monitors-tab-agent-collection">
          <legend className="px-1 text-sm font-medium">
            {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.agentCollectionTitle")}
          </legend>
          <label className="mt-2 block text-sm" htmlFor="monitors-tab-check-interval">
            {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.checkIntervalLabel")}
          </label>
          <input
            id="monitors-tab-check-interval"
            data-testid="monitors-tab-check-interval"
            type="number"
            min={CHECK_INTERVAL_MIN}
            max={CHECK_INTERVAL_MAX}
            step={1}
            value={checkInterval}
            disabled={isInherited}
            onChange={(e) => { setCheckInterval(e.target.value); setCheckIntervalEdited(true); setCheckIntervalError(undefined); }}
            className="mt-1 h-9 w-40 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
          {isIntervalInherited && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="monitors-tab-check-interval-inherited">
              {t("configurationPolicies.featureTabs.monitorsTab.inherited")}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.checkIntervalHint")}
          </p>
          {checkIntervalError && <p className="mt-1 text-xs text-destructive">{checkIntervalError}</p>}
        </fieldset>

        <fieldset className="rounded-md border bg-background p-4" data-testid="monitors-tab-inheritance">
          <legend className="px-1 text-sm font-medium">
            {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.inheritanceTitle")}
          </legend>
          {(["cumulative", "replace"] as const).map((mode) => (
            <label key={mode} className="mt-2 flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="monitors-tab-inheritance"
                data-testid={`monitors-tab-inheritance-${mode}`}
                checked={inheritance === mode}
                disabled={isInherited}
                onChange={() => setInheritance(mode)}
              />
              <span>
                <span className="font-medium">
                  {i18n.t(/* i18n-dynamic */ `policies:configurationPolicies.featureTabs.monitorsTab.inheritance.${mode}`)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {i18n.t(/* i18n-dynamic */ `policies:configurationPolicies.featureTabs.monitorsTab.inheritance.${mode}Hint`)}
                </span>
              </span>
            </label>
          ))}
          {inheritance === "replace" && parentItems.length > 0 && (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-testid="monitors-tab-ignored-inherited">
              <p className="font-medium">
                {i18n.t("policies:configurationPolicies.featureTabs.monitorsTab.ignoredInherited", { count: parentItems.length })}
              </p>
              <ul className="mt-1 list-disc pl-4">
                {parentItems.map((it) => (
                  <li key={it.monitorId}>{catalogById.get(it.monitorId)?.name ?? it.monitorId}</li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>

        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.monitorsTab.noMonitorsAttached",
            )}
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => {
              const monitor = catalogById.get(it.monitorId);
              // #6493: an item can outlive the monitor it points at — the
              // monitor was deleted (its config_policy_monitors row went with
              // it via ON DELETE CASCADE, but a stale copy can still surface
              // here from a link saved before that delete). Once the catalog
              // fetch has actually finished (not still loading, not errored),
              // a missing catalog entry means the monitor is gone, not that
              // the catalog hasn't loaded yet — render that explicitly rather
              // than falling back to a bare, meaningless UUID.
              const isDeleted = !monitor && !catalogLoading && !catalogError;
              const overrideValue =
                typeof it.overrides?.value === "number" ||
                typeof it.overrides?.value === "string"
                  ? String(it.overrides.value)
                  : "";
              return (
                <li
                  key={it.monitorId}
                  data-testid={`monitors-tab-item-${it.monitorId}`}
                  className={`rounded-md border bg-background px-4 py-3 ${isDeleted ? "border-destructive/40" : ""}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      {isDeleted ? (
                        <p
                          className="truncate text-sm font-medium text-destructive"
                          data-testid={`monitors-tab-item-deleted-${it.monitorId}`}
                        >
                          {i18n.t(
                            "policies:configurationPolicies.featureTabs.monitorsTab.monitorDeleted",
                          )}
                        </p>
                      ) : (
                        <p className="truncate text-sm font-medium">{monitor?.name}</p>
                      )}
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {monitor?.kind && <span>{monitor.kind}</span>}
                        {monitor?.severity && (
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${SEVERITY_BADGE[monitor.severity] ?? "border-muted bg-muted text-muted-foreground"}`}
                          >
                            {monitor.severity}
                          </span>
                        )}
                        {isInherited && (
                          <span className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/20 px-2 py-0.5 font-medium text-blue-700">
                            {i18n.t(
                              "policies:configurationPolicies.featureTabs.monitorsTab.inherited",
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        data-testid={`monitors-tab-item-enabled-${it.monitorId}`}
                        onClick={() => handleToggleEnabled(it.monitorId)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${it.enabled ? "bg-emerald-500/80" : "bg-muted"}`}
                      >
                        <span
                          className={`inline-block h-5 w-5 rounded-full bg-white transition ${it.enabled ? "translate-x-5" : "translate-x-1"}`}
                        />
                      </button>
                      <button
                        type="button"
                        data-testid={`monitors-tab-item-detach-${it.monitorId}`}
                        onClick={() => handleDetach(it.monitorId)}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label
                      className="text-xs text-muted-foreground"
                      htmlFor={`monitors-tab-item-override-${it.monitorId}`}
                    >
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.monitorsTab.overrideValue",
                      )}
                    </label>
                    <input
                      id={`monitors-tab-item-override-${it.monitorId}`}
                      type="number"
                      data-testid={`monitors-tab-item-override-${it.monitorId}`}
                      value={overrideValue}
                      onChange={(e) => handleOverrideValueChange(it.monitorId, e.target.value)}
                      className="h-8 w-24 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    {it.overrides && Object.keys(it.overrides).length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {i18n.t(
                          "policies:configurationPolicies.featureTabs.monitorsTab.overridesLabel",
                        )}{" "}
                        {JSON.stringify(it.overrides)}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <NeedsConversionPanel key={policyId} policyId={policyId} hasLegacyRows={hasLegacyRows} onChanged={() => void refreshLinks()} />
        <ConversionLedger policyId={policyId} revision={ledgerRevision} onChanged={() => void refreshLinks()} />
      </div>
    </FeatureTabShell>
  );
}
