import { AlertTriangle, PauseCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

type IntegrationHealth = "healthy" | "degraded" | "paused";

type IntegrationStatusRow = {
  id: string;
  name: string;
  categoryKey: string;
  health: IntegrationHealth;
  lastActivityKey: string;
  errorCount: number;
};

const activeIntegrations: IntegrationStatusRow[] = [
  {
    id: "int-1",
    name: "ConnectWise",
    categoryKey: "connectorStatusPanel.category.psa",
    health: "healthy",
    lastActivityKey: "connectorStatusPanel.activity.threeMinutesAgo",
    errorCount: 0,
  },
  {
    id: "int-2",
    name: "Grafana Cloud",
    categoryKey: "connectorStatusPanel.category.monitoring",
    health: "degraded",
    lastActivityKey: "connectorStatusPanel.activity.elevenMinutesAgo",
    errorCount: 2,
  },
  {
    id: "int-3",
    name: "Ops Pager",
    categoryKey: "connectorStatusPanel.category.webhooks",
    health: "healthy",
    lastActivityKey: "connectorStatusPanel.activity.fiveMinutesAgo",
    errorCount: 0,
  },
  {
    id: "int-4",
    name: "Veeam",
    categoryKey: "connectorStatusPanel.category.backup",
    health: "paused",
    lastActivityKey: "connectorStatusPanel.activity.oneDayAgo",
    errorCount: 4,
  },
];

const healthConfig: Record<
  IntegrationHealth,
  { labelKey: string; className: string }
> = {
  healthy: {
    labelKey: "connectorStatusPanel.healthy",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  degraded: {
    labelKey: "connectorStatusPanel.degraded",
    className: "border-amber-200 bg-amber-50 text-amber-700",
  },
  paused: {
    labelKey: "connectorStatusPanel.paused",
    className: "border-slate-200 bg-slate-50 text-slate-600",
  },
};

export default function ConnectorStatusPanel() {
  const { t } = useTranslation("integrations");
  return (
    <div className="rounded-xl border bg-card p-6 shadow-xs">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {t("connectorStatusPanel.connectorStatus")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "connectorStatusPanel.trackIntegrationHealthAndRecentActivityAtA",
            )}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" />
          {t("connectorStatusPanel.refreshAll")}
        </button>
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border bg-background">
        <table className="min-w-full divide-y text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-semibold">
                {t("connectorStatusPanel.integration")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("connectorStatusPanel.health")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("connectorStatusPanel.lastActivity")}
              </th>
              <th className="px-4 py-3 text-left font-semibold">
                {t("connectorStatusPanel.errors")}
              </th>
              <th className="px-4 py-3 text-right font-semibold">
                {t("common:labels.actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {activeIntegrations.map((integration) => {
              const health = healthConfig[integration.health];
              return (
                <tr key={integration.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <div className="font-medium">{integration.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t(/* i18n-dynamic */ integration.categoryKey)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs ${health.className}`}
                    >
                      {t(/* i18n-dynamic */ health.labelKey)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {t(/* i18n-dynamic */ integration.lastActivityKey)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                      {integration.errorCount}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                      >
                        {t("connectorStatusPanel.syncNow")}
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                      >
                        <PauseCircle className="h-3.5 w-3.5" />
                        {t("common:actions.disable")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
