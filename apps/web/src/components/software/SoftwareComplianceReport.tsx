import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type ComplianceEntry = {
  id: string;
  software: string;
  expectedVersion: string;
  devicesOnVersion: number;
  devicesOutdated: number;
  outdatedDevices: string[];
};
const complianceData: ComplianceEntry[] = [
  {
    id: "comp-chrome",
    software: "Google Chrome",
    expectedVersion: "122.0.6261.112",
    devicesOnVersion: 318,
    devicesOutdated: 24,
    outdatedDevices: ["SAL-LT-031", "FIN-LT-021", "HR-MB-011", "ENG-DT-201"],
  },
  {
    id: "comp-firefox",
    software: "Mozilla Firefox",
    expectedVersion: "124.0",
    devicesOnVersion: 142,
    devicesOutdated: 8,
    outdatedDevices: ["OPS-LT-007", "OPS-LT-010"],
  },
  {
    id: "comp-vscode",
    software: "Visual Studio Code",
    expectedVersion: "1.87.2",
    devicesOnVersion: 96,
    devicesOutdated: 12,
    outdatedDevices: ["DEV-MAC-008", "DEV-MAC-011", "DEV-MAC-014"],
  },
  {
    id: "comp-7zip",
    software: "7-Zip",
    expectedVersion: "23.01",
    devicesOnVersion: 280,
    devicesOutdated: 3,
    outdatedDevices: ["FIN-DT-024", "SAL-LT-033"],
  },
];
export default function SoftwareComplianceReport() {
  useTranslation("policies");
  useTranslation("policies");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {i18n.t(
              "policies:software.softwareComplianceReport.softwareComplianceReport",
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.softwareComplianceReport.analyzeSoftwareVersionDriftAcrossManagedDevices",
            )}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          <ShieldCheck className="h-4 w-4" />
          {i18n.t("policies:software.softwareComplianceReport.bulkUpdate")}
        </button>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {i18n.t(
                "policies:software.softwareComplianceReport.versionDriftAnalysis",
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.softwareComplianceReport.clickARowToSeeOutdatedDevices",
              )}
            </p>
          </div>
        </div>

        <div className="mt-5 overflow-x-auto rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:software.softwareComplianceReport.software",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:software.softwareComplianceReport.expectedVersion",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:software.softwareComplianceReport.devicesOnVersion",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:software.softwareComplianceReport.devicesOutdated",
                  )}
                </th>
                <th className="px-4 py-3 text-right">
                  {i18n.t("policies:software.softwareComplianceReport.details")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {complianceData.map((entry) => {
                const isExpanded = expandedId === entry.id;
                return (
                  <tr key={entry.id} className="text-sm">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {entry.software}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.expectedVersion}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {entry.devicesOnVersion}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                          entry.devicesOutdated > 0
                            ? "bg-red-500/20 text-red-700 border-red-500/40"
                            : "bg-emerald-500/20 text-emerald-700 border-emerald-500/40",
                        )}
                      >
                        {entry.devicesOutdated > 0 ? (
                          <AlertTriangle className="h-3.5 w-3.5" />
                        ) : null}
                        {entry.devicesOutdated}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedId(isExpanded ? null : entry.id)
                        }
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary"
                      >
                        {isExpanded
                          ? i18n.t(
                              "policies:software.softwareComplianceReport.hide",
                            )
                          : i18n.t("common:actions.view")}
                        {isExpanded ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {expandedId && (
          <div className="mt-4 rounded-lg border bg-muted/30 p-4">
            <p className="text-xs font-semibold uppercase text-muted-foreground">
              {i18n.t(
                "policies:software.softwareComplianceReport.outdatedDevices",
              )}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {complianceData
                .find((entry) => entry.id === expandedId)
                ?.outdatedDevices.map((device) => (
                  <span
                    key={device}
                    className="inline-flex items-center rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground"
                  >
                    {device}
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
