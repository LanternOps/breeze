import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { FleetDesignDrift } from "@breeze/shared";
import { formatDate } from "@/lib/dateTimeFormat";

/**
 * Fleet Designer W05 (#5655): the server-computed drift between the approved
 * (applied) design and the live fleet, rendered above the design itself on a
 * scheduled re-run. Nothing here is actionable — drift is a finding for the
 * technician; the design below it is what they review and apply.
 */
export default function DriftPanel({ drift }: { drift: FleetDesignDrift }) {
  const { t } = useTranslation("fleetDesign");
  const rows: Array<{ key: string; kind: string; item: string; scope: string; detail: string; drift: string }> = [
    ...drift.missing.map((m, i) => ({
      key: `missing-${i}`, drift: t("drift.rows.missing"), kind: m.kind, item: m.name, scope: m.functionKey, detail: "—",
    })),
    ...drift.changed.map((c, i) => ({
      key: `changed-${i}`, drift: t("drift.rows.changed"), kind: c.kind, item: c.name, scope: c.functionKey,
      detail: `${c.field}: ${c.approved} → ${c.live}`,
    })),
    ...drift.extra.map((e, i) => ({
      key: `extra-${i}`, drift: t("drift.rows.extra"), kind: e.kind, item: e.name, scope: e.policyName,
      detail: t("drift.deviceCount", { count: e.deviceCount }),
    })),
  ];

  return (
    <div className="space-y-2" data-testid="fleet-design-drift">
      <div
        className="flex items-start gap-2 rounded-md border border-amber-400/50 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="fleet-design-drift-banner"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          {t("drift.banner", {
            date: formatDate(drift.appliedAt),
            missing: drift.missing.length,
            extra: drift.extra.length,
            changed: drift.changed.length,
          })}
        </p>
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm" data-testid="fleet-design-drift-table">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                <th className="px-3 py-2">{t("drift.columns.drift")}</th>
                <th className="px-3 py-2">{t("drift.columns.kind")}</th>
                <th className="px-3 py-2">{t("drift.columns.item")}</th>
                <th className="px-3 py-2">{t("drift.columns.scope")}</th>
                <th className="px-3 py-2">{t("drift.columns.detail")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b last:border-0">
                  <td className="px-3 py-2 font-medium">{r.drift}</td>
                  <td className="px-3 py-2">{r.kind}</td>
                  <td className="px-3 py-2">{r.item}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.scope}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
