import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  CheckCircle2,
  Loader2,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Webhook,
} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { useOrgScope } from "@/hooks/useOrgScope";
import { getJwtClaims } from "../../lib/authScope";
import { extractApiError } from "@/lib/apiError";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type WebhookEndpoint = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
};

type MonitoringSettings = {
  prometheus: {
    enabled: boolean;
    endpointUrl: string;
    scrapeInterval: string;
    scrapeTimeout: string;
    metricsPath: string;
  };
  grafana: {
    enabled: boolean;
    url: string;
    apiKey: string;
    orgId: string;
  };
  pagerDuty: {
    enabled: boolean;
    integrationKey: string;
    serviceId: string;
  };
  opsGenie: {
    enabled: boolean;
    apiKey: string;
    team: string;
  };
  webhooks: {
    enabled: boolean;
    endpoints: WebhookEndpoint[];
  };
  metrics: {
    enabled: boolean;
    selected: string[];
  };
};

type ProviderKey = Exclude<keyof MonitoringSettings, "metrics">;

let webhookIdCounter = 0;
const createWebhookId = () => {
  webhookIdCounter += 1;
  return `wh-${webhookIdCounter}`;
};

type TestResult = {
  state: "idle" | "testing" | "success" | "error";
  message?: string;
};

type SaveState = {
  status: "idle" | "saving" | "saved" | "error";
  message?: string;
};

const metricIds = [
  "device.health",
  "device.performance",
  "patch.compliance",
  "backup.status",
  "security.posture",
  "automation.runs",
  "alerts.incidents",
] as const;

const metricIdSet = new Set<string>(metricIds);

const defaultSettings: MonitoringSettings = {
  prometheus: {
    enabled: true,
    endpointUrl: "https://prometheus.breeze.io",
    scrapeInterval: "30s",
    scrapeTimeout: "10s",
    metricsPath: "/metrics",
  },
  grafana: {
    enabled: true,
    url: "https://grafana.breeze.io",
    apiKey: "",
    orgId: "1",
  },
  pagerDuty: {
    enabled: false,
    integrationKey: "",
    serviceId: "",
  },
  opsGenie: {
    enabled: false,
    apiKey: "",
    team: "",
  },
  webhooks: {
    enabled: true,
    endpoints: [
      {
        id: "wh-1",
        name: "Datadog relay",
        url: "https://hooks.datadoghq.com/services/ABC/123",
        enabled: true,
      },
    ],
  },
  metrics: {
    enabled: true,
    selected: [
      "device.health",
      "patch.compliance",
      "alerts.incidents",
      "automation.runs",
    ],
  },
};

const testStatusStyles: Record<
  TestResult["state"],
  { labelKey: string; className: string; icon: typeof Activity }
> = {
  idle: {
    labelKey: "monitoringIntegration.notTested",
    className: "border-slate-200 bg-slate-50 text-slate-600",
    icon: Activity,
  },
  testing: {
    labelKey: "monitoringIntegration.testing",
    className: "border-blue-200 bg-blue-50 text-blue-700",
    icon: Loader2,
  },
  success: {
    labelKey: "common:states.active",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  error: {
    labelKey: "monitoringIntegration.failed",
    className: "border-rose-200 bg-rose-50 text-rose-700",
    icon: AlertTriangle,
  },
};

function TestStatusBadge({ result }: { result: TestResult }) {
  const { t } = useTranslation("integrations");
  const config = testStatusStyles[result.state];
  const Icon = config.icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${config.className}`}
    >
      <Icon
        className={`h-3.5 w-3.5 ${result.state === "testing" ? "animate-spin" : ""}`}
      />
      {t(/* i18n-dynamic */ config.labelKey)}
    </span>
  );
}

function TogglePill({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("integrations");
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
        enabled
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-slate-200 bg-slate-50 text-slate-600"
      }`}
      aria-pressed={enabled}
    >
      <span
        className={`h-2 w-2 rounded-full ${enabled ? "bg-emerald-500" : "bg-slate-400"}`}
      />
      {enabled ? t("common:states.enabled") : t("common:states.disabled")}
    </button>
  );
}

export default function MonitoringIntegration() {
  const { t } = useTranslation("integrations");
  const metricOptions = [
    {
      id: "device.health",
      label: t("monitoringIntegration.deviceHealth"),
      description: t("monitoringIntegration.heartbeatUptimeAndConnectivity"),
    },
    {
      id: "device.performance",
      label: t("monitoringIntegration.performance"),
      description: t("monitoringIntegration.cpuMemoryAndDiskUtilization"),
    },
    {
      id: "patch.compliance",
      label: t("monitoringIntegration.patchCompliance"),
      description: t("monitoringIntegration.patchInstallRatesAndDrift"),
    },
    {
      id: "backup.status",
      label: t("monitoringIntegration.backupStatus"),
      description: t("monitoringIntegration.jobSuccessRatesAndRestorePoints"),
    },
    {
      id: "security.posture",
      label: t("monitoringIntegration.securityPosture"),
      description: t("monitoringIntegration.riskScoresAndPostureChecks"),
    },
    {
      id: "automation.runs",
      label: t("monitoringIntegration.automationRuns"),
      description: t("monitoringIntegration.runCountsDurationAndFailures"),
    },
    {
      id: "alerts.incidents",
      label: t("monitoringIntegration.alertsIncidents"),
      description: t("monitoringIntegration.openAlertsAndEscalations"),
    },
  ];
  const [settings, setSettings] = useState<MonitoringSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>({ status: "idle" });
  const [testResults, setTestResults] = useState<Record<string, TestResult>>(
    {},
  );
  const [hasChanges, setHasChanges] = useState(false);
  const [newWebhookName, setNewWebhookName] = useState("");
  const [newWebhookUrl, setNewWebhookUrl] = useState("");

  // Two-layer context model: whether this page is accessible is a TOKEN
  // capability, never a header-context question. Monitoring settings are
  // per-organization DATA, so the selected org only decides WHICH org's
  // settings load (fetchWithAuth auto-appends ?orgId=<selected>).
  //
  // - Org-scope tokens carry their org and the API resolves it server-side,
  //   so org users always load — the old bare `!currentOrgId` gate wrongly
  //   blocked them during the transient pre-hydration null.
  // - Partner admins (token capability, regardless of header context) keep
  //   access to configuration; but with no org selected there is no target
  //   org for this per-org data and the GET/PUT would 400, so we show a
  //   pick-an-organization note instead of firing the doomed call.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const orgScope = useOrgScope();
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const isPartnerAdmin = jwtScope === "partner" && !!jwtPartnerId;
  // System tokens can also address many orgs; same missing-data-target state.
  const canAddressManyOrgs = isPartnerAdmin || jwtScope === "system";
  // Show the pick-an-org note only on the RESOLVED no-single-org states
  // (explicit fleet view or a zero-org partner) — gating on the allOrgs intent,
  // not bare `!currentOrgId`, so the transient pre-hydration null no longer
  // flashes the note (and a failed org-context load no longer strands here).
  const needsOrgSelection =
    canAddressManyOrgs && (orgScope.scope === "all" || orgScope.status === "empty");
  // Partner/system with no org yet but context still resolving (or it failed):
  // hold the loading frame instead of firing the doomed org-less GET.
  const awaitingOrgContext =
    canAddressManyOrgs && !currentOrgId && !needsOrgSelection;

  const selectedMetricsCount = settings.metrics.selected.length;

  const normalizeSettings = useCallback(
    (payload?: Partial<MonitoringSettings> | null): MonitoringSettings => {
      const next = payload ?? {};
      const webhookPayload =
        next.webhooks?.endpoints ?? defaultSettings.webhooks.endpoints;
      const selectedMetrics = Array.isArray(next.metrics?.selected)
        ? next.metrics?.selected.filter((metricId) => metricIdSet.has(metricId))
        : defaultSettings.metrics.selected;

      return {
        prometheus: { ...defaultSettings.prometheus, ...next.prometheus },
        grafana: { ...defaultSettings.grafana, ...next.grafana },
        pagerDuty: { ...defaultSettings.pagerDuty, ...next.pagerDuty },
        opsGenie: { ...defaultSettings.opsGenie, ...next.opsGenie },
        webhooks: {
          ...defaultSettings.webhooks,
          ...next.webhooks,
          endpoints: webhookPayload.map((endpoint, index) => ({
            id: endpoint.id ?? `wh-${index + 1}`,
            name: endpoint.name ?? "",
            url: endpoint.url ?? "",
            enabled: endpoint.enabled ?? true,
          })),
        },
        metrics: {
          ...defaultSettings.metrics,
          ...next.metrics,
          selected: selectedMetrics.length
            ? selectedMetrics
            : defaultSettings.metrics.selected,
        },
      };
    },
    [],
  );

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(undefined);
      const response = await fetchWithAuth("/integrations/monitoring");
      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            errData,
            t("monitoringIntegration.failedToLoadMonitoringSettings"),
          ),
        );
      }
      const data = await response.json();
      setSettings(normalizeSettings(data.data ?? data));
      setHasChanges(false);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : "Unable to load monitoring settings",
      );
      setSettings(normalizeSettings());
    } finally {
      setLoading(false);
    }
  }, [normalizeSettings]);

  useEffect(() => {
    if (needsOrgSelection) {
      setLoading(false);
      setLoadError(undefined);
      return;
    }
    // Context not resolved yet — keep the loading frame; don't fire an org-less
    // request that would 400 before auto-select lands.
    if (awaitingOrgContext) {
      setLoading(true);
      setLoadError(undefined);
      return;
    }
    fetchSettings();
  }, [fetchSettings, currentOrgId, needsOrgSelection, awaitingOrgContext]);

  function updateSection<K extends keyof MonitoringSettings>(
    key: K,
    updates: Partial<MonitoringSettings[K]>,
  ) {
    setSettings((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        ...updates,
      },
    }));
    setHasChanges(true);
    setSaveState((prev) =>
      prev.status === "saved" ? { status: "idle" } : prev,
    );
  }

  const updateWebhook = (id: string, updates: Partial<WebhookEndpoint>) => {
    setSettings((prev) => ({
      ...prev,
      webhooks: {
        ...prev.webhooks,
        endpoints: prev.webhooks.endpoints.map((endpoint) =>
          endpoint.id === id ? { ...endpoint, ...updates } : endpoint,
        ),
      },
    }));
    setHasChanges(true);
  };

  const handleAddWebhook = () => {
    if (!newWebhookUrl.trim()) return;
    const nextId = createWebhookId();
    const name =
      newWebhookName.trim() ||
      `Webhook ${settings.webhooks.endpoints.length + 1}`;
    const url = newWebhookUrl.trim();

    setSettings((prev) => ({
      ...prev,
      webhooks: {
        ...prev.webhooks,
        endpoints: [
          ...prev.webhooks.endpoints,
          { id: nextId, name, url, enabled: true },
        ],
      },
    }));
    setNewWebhookName("");
    setNewWebhookUrl("");
    setHasChanges(true);
  };

  const handleRemoveWebhook = (id: string) => {
    setSettings((prev) => ({
      ...prev,
      webhooks: {
        ...prev.webhooks,
        endpoints: prev.webhooks.endpoints.filter(
          (endpoint) => endpoint.id !== id,
        ),
      },
    }));
    setHasChanges(true);
  };

  const handleToggleMetric = (metricId: string) => {
    setSettings((prev) => {
      const selected = prev.metrics.selected.includes(metricId)
        ? prev.metrics.selected.filter((id) => id !== metricId)
        : [...prev.metrics.selected, metricId];
      return {
        ...prev,
        metrics: {
          ...prev.metrics,
          selected,
        },
      };
    });
    setHasChanges(true);
  };

  const handleSave = async () => {
    setSaveState({ status: "saving" });
    try {
      const response = await fetchWithAuth("/integrations/monitoring", {
        method: "PUT",
        body: JSON.stringify(settings),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            errorData,
            t("monitoringIntegration.failedToSaveMonitoringSettings"),
          ),
        );
      }

      setSaveState({
        status: "saved",
        message: t("monitoringIntegration.monitoringSettingsSaved"),
      });
      setHasChanges(false);
    } catch (err) {
      setSaveState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : t("monitoringIntegration.failedToSaveMonitoringSettings"),
      });
    }
  };

  const updateTestResult = (key: string, result: TestResult) => {
    setTestResults((prev) => ({ ...prev, [key]: result }));
  };

  const handleTest = async (provider: ProviderKey, endpointId?: string) => {
    const testKey = endpointId ? `${provider}:${endpointId}` : provider;
    updateTestResult(testKey, { state: "testing" });

    if (provider === "webhooks" && endpointId) {
      const endpoint = settings.webhooks.endpoints.find(
        (item) => item.id === endpointId,
      );
      if (!endpoint) {
        updateTestResult(testKey, {
          state: "error",
          message: t("monitoringIntegration.endpointNotFound"),
        });
        return;
      }
    }

    try {
      const payload = {
        provider,
        config: settings[provider],
        endpointId,
      };

      const response = await fetchWithAuth("/integrations/monitoring/test", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
      };

      if (!response.ok) {
        throw new Error(
          extractApiError(
            data,
            t("monitoringIntegration.connectionTestFailed"),
          ),
        );
      }

      updateTestResult(testKey, {
        state: "success",
        message:
          data.message || t("monitoringIntegration.connectionSuccessful"),
      });
    } catch (err) {
      updateTestResult(testKey, {
        state: "error",
        message:
          err instanceof Error
            ? err.message
            : t("monitoringIntegration.connectionTestFailed"),
      });
    }
  };

  if (needsOrgSelection) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">
            {t("monitoringIntegration.monitoringIntegrations")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "monitoringIntegration.connectObservabilityPlatformsAlertingToolsAndExternalMonitoring",
            )}
          </p>
        </div>
        <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
          {/* Partner/system audience with no org selected: monitoring settings
              are genuinely per-org (a data target), so picking one is the
              correct next step — stated without the old scope-switch framing. */}
          {t("monitoringIntegration.selectOrgToConfigure")}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">
            {t("monitoringIntegration.loadingMonitoringIntegrations")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">
            {t("monitoringIntegration.monitoringIntegrations")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              "monitoringIntegration.connectObservabilityPlatformsAlertingToolsAndExternalMonitoring",
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {hasChanges && (
            <span className="text-xs text-amber-600">
              {t("monitoringIntegration.unsavedChanges")}
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saveState.status === "saving"}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saveState.status === "saving" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {saveState.status === "saving"
              ? t("monitoringIntegration.saving")
              : t("monitoringIntegration.saveSettings")}
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </div>
      )}

      {saveState.status === "saved" && saveState.message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {saveState.message}
        </div>
      )}

      {saveState.status === "error" && saveState.message && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {saveState.message}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-5 rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Activity className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {t("monitoringIntegration.prometheus")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "monitoringIntegration.publishBreezeMetricsWithCustomScrapeSettings",
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <TestStatusBadge
                result={testResults.prometheus ?? { state: "idle" }}
              />
              <button
                type="button"
                onClick={() => handleTest("prometheus")}
                disabled={
                  !settings.prometheus.enabled ||
                  testResults.prometheus?.state === "testing"
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-3.5 w-3.5" />
                {t("monitoringIntegration.testConnection")}
              </button>
              <TogglePill
                enabled={settings.prometheus.enabled}
                onToggle={() =>
                  updateSection("prometheus", {
                    enabled: !settings.prometheus.enabled,
                  })
                }
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.endpointURL")}
              </label>
              <input
                type="url"
                value={settings.prometheus.endpointUrl}
                onChange={(event) =>
                  updateSection("prometheus", {
                    endpointUrl: event.target.value,
                  })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.metricsPath")}
              </label>
              <input
                type="text"
                value={settings.prometheus.metricsPath}
                onChange={(event) =>
                  updateSection("prometheus", {
                    metricsPath: event.target.value,
                  })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.scrapeInterval")}
              </label>
              <input
                type="text"
                value={settings.prometheus.scrapeInterval}
                onChange={(event) =>
                  updateSection("prometheus", {
                    scrapeInterval: event.target.value,
                  })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.scrapeTimeout")}
              </label>
              <input
                type="text"
                value={settings.prometheus.scrapeTimeout}
                onChange={(event) =>
                  updateSection("prometheus", {
                    scrapeTimeout: event.target.value,
                  })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {testResults.prometheus?.message && (
            <p className="text-xs text-muted-foreground">
              {testResults.prometheus.message}
            </p>
          )}
        </section>

        <section className="space-y-5 rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <BarChart3 className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {t("monitoringIntegration.grafana")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "monitoringIntegration.linkDashboardsAndEnableDeepLinksFromBreeze",
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <TestStatusBadge
                result={testResults.grafana ?? { state: "idle" }}
              />
              <button
                type="button"
                onClick={() => handleTest("grafana")}
                disabled={
                  !settings.grafana.enabled ||
                  testResults.grafana?.state === "testing"
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-3.5 w-3.5" />
                {t("monitoringIntegration.testConnection")}
              </button>
              <TogglePill
                enabled={settings.grafana.enabled}
                onToggle={() =>
                  updateSection("grafana", {
                    enabled: !settings.grafana.enabled,
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.dashboardURL")}
              </label>
              <input
                type="url"
                value={settings.grafana.url}
                onChange={(event) =>
                  updateSection("grafana", { url: event.target.value })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t("monitoringIntegration.apiKey")}
                </label>
                <input
                  type="password"
                  value={settings.grafana.apiKey}
                  onChange={(event) =>
                    updateSection("grafana", { apiKey: event.target.value })
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t("monitoringIntegration.organizationID")}
                </label>
                <input
                  type="text"
                  value={settings.grafana.orgId}
                  onChange={(event) =>
                    updateSection("grafana", { orgId: event.target.value })
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>

          {testResults.grafana?.message && (
            <p className="text-xs text-muted-foreground">
              {testResults.grafana.message}
            </p>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-5 rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Bell className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {t("monitoringIntegration.pagerduty")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "monitoringIntegration.triggerOnCallWorkflowsFromCriticalAlerts",
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <TestStatusBadge
                result={testResults.pagerDuty ?? { state: "idle" }}
              />
              <button
                type="button"
                onClick={() => handleTest("pagerDuty")}
                disabled={
                  !settings.pagerDuty.enabled ||
                  testResults.pagerDuty?.state === "testing"
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-3.5 w-3.5" />
                {t("monitoringIntegration.testConnection")}
              </button>
              <TogglePill
                enabled={settings.pagerDuty.enabled}
                onToggle={() =>
                  updateSection("pagerDuty", {
                    enabled: !settings.pagerDuty.enabled,
                  })
                }
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.integrationKey")}
              </label>
              <input
                type="password"
                value={settings.pagerDuty.integrationKey}
                onChange={(event) =>
                  updateSection("pagerDuty", {
                    integrationKey: event.target.value,
                  })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.serviceID")}
              </label>
              <input
                type="text"
                value={settings.pagerDuty.serviceId}
                onChange={(event) =>
                  updateSection("pagerDuty", { serviceId: event.target.value })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {testResults.pagerDuty?.message && (
            <p className="text-xs text-muted-foreground">
              {testResults.pagerDuty.message}
            </p>
          )}
        </section>

        <section className="space-y-5 rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {t("monitoringIntegration.opsgenie")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "monitoringIntegration.routeIncidentResponsesToOpsGenieTeams",
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <TestStatusBadge
                result={testResults.opsGenie ?? { state: "idle" }}
              />
              <button
                type="button"
                onClick={() => handleTest("opsGenie")}
                disabled={
                  !settings.opsGenie.enabled ||
                  testResults.opsGenie?.state === "testing"
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-3.5 w-3.5" />
                {t("monitoringIntegration.testConnection")}
              </button>
              <TogglePill
                enabled={settings.opsGenie.enabled}
                onToggle={() =>
                  updateSection("opsGenie", {
                    enabled: !settings.opsGenie.enabled,
                  })
                }
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.apiKey")}
              </label>
              <input
                type="password"
                value={settings.opsGenie.apiKey}
                onChange={(event) =>
                  updateSection("opsGenie", { apiKey: event.target.value })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {t("monitoringIntegration.team")}
              </label>
              <input
                type="text"
                value={settings.opsGenie.team}
                onChange={(event) =>
                  updateSection("opsGenie", { team: event.target.value })
                }
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {testResults.opsGenie?.message && (
            <p className="text-xs text-muted-foreground">
              {testResults.opsGenie.message}
            </p>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
        <section className="space-y-5 rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Webhook className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {t("monitoringIntegration.customMonitoringWebhooks")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "monitoringIntegration.forwardMonitoringEventsToExternalEndpoints",
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <TestStatusBadge
                result={testResults.webhooks ?? { state: "idle" }}
              />
              <button
                type="button"
                onClick={() => handleTest("webhooks")}
                disabled={
                  !settings.webhooks.enabled ||
                  testResults.webhooks?.state === "testing"
                }
                className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="h-3.5 w-3.5" />
                {t("monitoringIntegration.testAll")}
              </button>
              <TogglePill
                enabled={settings.webhooks.enabled}
                onToggle={() =>
                  updateSection("webhooks", {
                    enabled: !settings.webhooks.enabled,
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-4">
            {settings.webhooks.endpoints.map((endpoint) => {
              const endpointKey = `webhooks:${endpoint.id}`;
              const endpointTest = testResults[endpointKey] ?? {
                state: "idle",
              };

              return (
                <div
                  key={endpoint.id}
                  className="grid gap-3 rounded-lg border bg-background p-4 md:grid-cols-[1fr_1.4fr_auto]"
                >
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase text-muted-foreground">
                      {t("common:labels.name")}
                    </label>
                    <input
                      type="text"
                      value={endpoint.name}
                      onChange={(event) =>
                        updateWebhook(endpoint.id, { name: event.target.value })
                      }
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase text-muted-foreground">
                      {t("monitoringIntegration.endpointURL")}
                    </label>
                    <input
                      type="url"
                      value={endpoint.url}
                      onChange={(event) =>
                        updateWebhook(endpoint.id, { url: event.target.value })
                      }
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <TestStatusBadge result={endpointTest} />
                    <button
                      type="button"
                      onClick={() => handleTest("webhooks", endpoint.id)}
                      disabled={
                        !settings.webhooks.enabled ||
                        endpointTest.state === "testing"
                      }
                      className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {t("monitoringIntegration.test")}
                    </button>
                    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={endpoint.enabled}
                        onChange={(event) =>
                          updateWebhook(endpoint.id, {
                            enabled: event.target.checked,
                          })
                        }
                        className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                      />
                      {t("common:states.active")}
                    </label>
                    <button
                      type="button"
                      onClick={() => handleRemoveWebhook(endpoint.id)}
                      className="inline-flex items-center rounded-md border px-3 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted"
                    >
                      {t("common:actions.remove")}
                    </button>
                  </div>
                  {endpointTest.message && (
                    <p className="md:col-span-3 text-xs text-muted-foreground">
                      {endpointTest.message}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="grid gap-3 rounded-lg border bg-muted/40 p-4 md:grid-cols-[1fr_1.4fr_auto]">
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase text-muted-foreground">
                {t("monitoringIntegration.newName")}
              </label>
              <input
                type="text"
                value={newWebhookName}
                onChange={(event) => setNewWebhookName(event.target.value)}
                placeholder={t("monitoringIntegration.cloudwatchBridge")}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium uppercase text-muted-foreground">
                {t("monitoringIntegration.newEndpointURL")}
              </label>
              <input
                type="url"
                value={newWebhookUrl}
                onChange={(event) => setNewWebhookUrl(event.target.value)}
                placeholder="https://hooks.monitoring.io/breeze"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex items-end">
              <button
                type="button"
                onClick={handleAddWebhook}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("monitoringIntegration.addEndpoint")}
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-5 rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Activity className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">
                  {t("monitoringIntegration.metricExport")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    "monitoringIntegration.selectWhichMetricsAreExposedToExternalMonitors",
                  )}
                </p>
              </div>
            </div>
            <TogglePill
              enabled={settings.metrics.enabled}
              onToggle={() =>
                updateSection("metrics", { enabled: !settings.metrics.enabled })
              }
            />
          </div>

          <div className="space-y-3">
            {metricOptions.map((metric) => (
              <label
                key={metric.id}
                className="flex items-start gap-3 rounded-md border bg-background px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={settings.metrics.selected.includes(metric.id)}
                  onChange={() => handleToggleMetric(metric.id)}
                  className="mt-1 h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
                <span>
                  <span className="block font-medium">{metric.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {metric.description}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            {selectedMetricsCount} {t("monitoringIntegration.metricsSelected")}
          </p>
        </section>
      </div>
    </div>
  );
}
