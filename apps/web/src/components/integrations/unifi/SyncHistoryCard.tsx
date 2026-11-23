// Sync-run ledger, newest first (cloud). Split out of UnifiIntegration.tsx
// (#2382); the unmapped-sites column was added in #11502.

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, History } from "lucide-react";
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
                <th className="px-3 py-2 font-medium">
                  {t("unifiIntegration.sitesUnmapped")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {syncRuns.map((run) => (
                <Fragment key={run.id}>
                <tr data-testid="unifi-history-row">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {run.keyResults && run.keyResults.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggle(run.id)}
                        aria-expanded={expanded.has(run.id)}
                        aria-label={t("unifiIntegration.runKeyResults")}
                        className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded hover:bg-muted"
                        data-testid="unifi-history-expand"
                      >
                        {expanded.has(run.id) ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    )}
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
                  <td
                    className="px-3 py-2 tabular-nums"
                    data-testid="unifi-sync-run-unmapped"
                  >
                    {run.sitesUnmapped ?? "—"}
                  </td>
                </tr>
                {expanded.has(run.id) && run.keyResults && (
                  <tr data-testid="unifi-history-key-results">
                    <td colSpan={9} className="bg-muted/30 px-3 py-2">
                      <ul className="space-y-1 text-xs">
                        {run.keyResults.map((kr) => (
                          <li
                            key={kr.keyId}
                            className="flex flex-wrap items-center gap-2"
                            data-testid="unifi-history-key-result"
                          >
                            <span className="font-medium">{kr.label}</span>
                            <span
                              className={`inline-flex items-center rounded-full border px-2 py-0.5 ${runStatusClasses(kr.status)}`}
                            >
                              {kr.status}
                            </span>
                            {kr.authFailure && (
                              <span className="text-amber-700">
                                {t("unifiIntegration.runKeyRejected")}
                              </span>
                            )}
                            <span className="text-muted-foreground">
                              {t("unifiIntegration.runKeySeen", {
                                hosts: kr.hostsSeen ?? "—",
                                sites: kr.sitesSeen ?? "—",
                              })}
                            </span>
                            {kr.error && (
                              <span className="text-red-700">{kr.error}</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
