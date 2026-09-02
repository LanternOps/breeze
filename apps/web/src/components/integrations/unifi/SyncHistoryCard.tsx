// Sync-run ledger, newest first (cloud). Split out of UnifiIntegration.tsx
// (#2382) — verbatim move, no behavior change.

import { History } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { runStatusClasses } from "./unifiHelpers";
import type { SyncRun } from "./unifiTypes";

interface SyncHistoryCardProps {
  syncRuns: SyncRun[];
}

export default function SyncHistoryCard({ syncRuns }: SyncHistoryCardProps) {
  const { t } = useTranslation("integrations");
  return (
    <div
      className="rounded-xl border bg-card p-5 shadow-xs"
      data-testid="unifi-history-card"
    >
      <div className="flex items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">
          {t("unifiIntegration.syncHistory")}
        </h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("unifiIntegration.theMostRecentSyncRunsNewestFirst")}
      </p>

      {syncRuns.length === 0 ? (
        <p
          className="py-6 text-sm text-muted-foreground"
          data-testid="unifi-history-empty"
        >
          {t("unifiIntegration.noSyncRunsYetTriggerASyncTo")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            className="min-w-full divide-y text-sm"
            data-testid="unifi-history-table"
          >
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">
                  {t("unifiIntegration.started")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("unifiIntegration.trigger")}
                </th>
                <th className="px-3 py-2 font-medium">
                  {t("common:labels.status")}
                </th>
                <th
                  className="px-3 py-2 font-medium"
                  title={t("unifiIntegration.hostsSeen")}
                >
                  {t("unifiIntegration.hosts")}
                </th>
                <th
                  className="px-3 py-2 font-medium"
                  title={t("unifiIntegration.devicesCreated")}
                >
                  {t("unifiIntegration.new")}
                </th>
                <th
                  className="px-3 py-2 font-medium"
                  title={t("unifiIntegration.devicesUpdated")}
                >
                  {t("unifiIntegration.upd")}
                </th>
                <th
                  className="px-3 py-2 font-medium"
                  title={t("unifiIntegration.devicesUnchanged")}
                >
                  {t("unifiIntegration.same")}
                </th>
                <th
                  className="px-3 py-2 font-medium"
                  title={t("unifiIntegration.devicesRemovedStale")}
                >
                  {t("unifiIntegration.gone")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {syncRuns.map((run) => (
                <tr key={run.id} data-testid="unifi-history-row">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {formatDateTime(run.startedAt)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {run.trigger}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${runStatusClasses(run.status)}`}
                      title={run.error ?? undefined}
                      data-testid="unifi-history-status"
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{run.hostsSeen}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {run.devicesCreated}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {run.devicesUpdated}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {run.devicesUnchanged}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {run.devicesRemoved}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
