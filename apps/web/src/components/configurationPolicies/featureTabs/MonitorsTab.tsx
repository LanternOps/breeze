import { findDuplicateConditions } from "./duplicateConditions";
import { DuplicateConditionNotice } from "./DuplicateConditionNotice";
import { useState, useEffect } from "react";
import { Radar, Trash2 } from "lucide-react";
import type { FeatureTabProps } from "./types";
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
}: FeatureTabProps) {
  const { t } = useTranslation("policies");
  const linkOf = (type: string) => allLinks.find((link) => link.featureType === type);
  const inlineRules = (linkOf("alert_rule")?.inlineSettings as { items?: Array<{ name?: string; conditions?: Array<Record<string, unknown>> }> } | undefined)?.items ?? [];
  const watches = (linkOf("monitoring")?.inlineSettings as { watches?: Array<{ watchType?: string; name?: string; enabled?: boolean }> } | undefined)?.watches ?? [];

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

  const handleSave = async () => {
    clearError();
    if (items.length === 0) {
      if (existingLink) {
        const ok = await remove(existingLink.id);
        if (ok) onLinkChanged(null, "monitors");
      }
      return;
    }
    const result = await save(existingLink?.id ?? null, {
      featureType: "monitors",
      featurePolicyId: null, // inline settings — never stamp the parent CONFIG policy's own id
      inlineSettings: { items: buildPayloadItems() },
    });
    if (result) onLinkChanged(result, "monitors");
  };

  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) {
      onLinkChanged(null, "monitors");
      setItems([]);
    }
  };

  // Creates this policy's own link, seeded with a copy of whatever is
  // currently displayed (the parent's items) — the same one-shot pattern
  // every other inheritance-capable tab uses (see VulnerabilityTab). Once the
  // own link exists, FeatureTabShell stops disabling the editor and the
  // attach/detach/toggle/override controls below become live.
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "monitors",
      featurePolicyId: null,
      inlineSettings: { items: buildPayloadItems() },
    });
    if (result) onLinkChanged(result, "monitors");
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "monitors");
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
              const overrideValue =
                typeof it.overrides?.value === "number" ||
                typeof it.overrides?.value === "string"
                  ? String(it.overrides.value)
                  : "";
              return (
                <li
                  key={it.monitorId}
                  data-testid={`monitors-tab-item-${it.monitorId}`}
                  className="rounded-md border bg-background px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {monitor?.name ?? it.monitorId}
                      </p>
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
      </div>
    </FeatureTabShell>
  );
}
