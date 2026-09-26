import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FleetDesignAutomationEntry, FleetDesignLegacyItem, FleetDesignOutcome } from "@breeze/shared";
import { getDeviceFunctionLabel } from "@/lib/deviceFunctions";
import type { UseDesignSelectionResult } from "./useDesignSelection";

/**
 * Fleet Designer W03/W04 (#5653/#5654) — renders the eight
 * `FLEET_DESIGN_SECTION_KEYS` sections of a stored `FleetDesignOutcome` in
 * order. Selectable items (functions, monitoring watches/rules,
 * automation scripts, role corrections) get a checkbox wired through
 * `selection`. Historical retired items, `found`/`baseline` and the
 * non-role-correction parts of `unsure` are read-only. Within automation, playbooks stay read-only (no
 * apply path — only scripts do); legacy is read-only by design — it is an
 * informational inventory, never an apply target (`approval.legacy` is
 * always `[]`, see `useDesignSelection`'s docstring).
 */
export interface FleetDesignViewerProps {
  outcome: FleetDesignOutcome;
  selection: UseDesignSelectionResult;
  unavailable?: string[];
}

function Section({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-3 space-y-2">{children}</div>
    </section>
  );
}

function AppliedBadge() {
  const { t } = useTranslation("fleetDesign");
  return (
    <span className="inline-flex items-center rounded-full border bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {t("items.applied")}
    </span>
  );
}

/** One selectable row: checkbox (or an "applied" badge in its place), label, optional meta line. */
function SelectableRow({
  itemRef,
  label,
  meta,
  selection,
}: {
  itemRef: string;
  label: string;
  meta?: string;
  selection: UseDesignSelectionResult;
}) {
  const applied = selection.isApplied(itemRef);
  return (
    <label
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${applied ? "bg-muted/30" : "cursor-pointer hover:bg-muted/30"}`}
      data-testid={`fleet-design-item-${itemRef}`}
    >
      {applied ? (
        <span className="mt-0.5">
          <AppliedBadge />
        </span>
      ) : (
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-muted"
          checked={selection.isSelected(itemRef)}
          onChange={() => selection.toggle(itemRef)}
          data-testid={`fleet-design-item-${itemRef}-checkbox`}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {meta && <span className="block text-xs text-muted-foreground">{meta}</span>}
      </span>
    </label>
  );
}

/** Read-only playbook label: built-in name, or "custom name — description". */
function playbookLabel(playbook: FleetDesignAutomationEntry["playbooks"][number]): string {
  if ("builtInName" in playbook) return playbook.builtInName;
  return `${playbook.custom.name} — ${playbook.custom.description}`;
}

const LEGACY_BUCKET_CLASS: Record<FleetDesignLegacyItem["bucket"], string> = {
  obsolete: "bg-muted text-muted-foreground",
  covered: "bg-success/15 text-success",
  needed: "bg-warning/15 text-warning",
};

export default function FleetDesignViewer({ outcome, selection, unavailable = [] }: FleetDesignViewerProps) {
  const { t } = useTranslation("fleetDesign");
  const { sections } = outcome;
  const evidenceTitles: Record<string, string> = {
    org: t("evidence.org"),
    devices: t("evidence.devices"),
    software: t("evidence.software"),
    services: t("evidence.services"),
    network: t("evidence.network"),
    posture: t("evidence.posture"),
    health: t("evidence.health"),
    configuration: t("evidence.configuration"),
    automation: t("evidence.automation"),
    logs: t("evidence.logs"),
    counts: t("evidence.counts"),
    precursors: t("evidence.precursors"),
    approvedDesign: t("evidence.drift"),
    drift: t("evidence.drift"),
  };

  return (
    <div className="space-y-4" data-testid="fleet-design-viewer">
      {Array.from(new Set(unavailable)).map((key) => (
        <Section key={key} title={evidenceTitles[key] ?? key} testId={`fleet-design-section-${key}-not-measured`}>
          <p className="text-sm text-muted-foreground">{t("evidence.notMeasured")}</p>
        </Section>
      ))}
      <Section title={t("sections.found")} testId="fleet-design-section-found">
        {sections.found.summary.length === 0 && sections.found.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("items.none")}</p>
        ) : (
          <>
            {sections.found.summary.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {sections.found.summary.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
            {sections.found.findings.map((f, i) => (
              <p key={i} className="text-sm text-muted-foreground">
                {t("items.findingCount", { title: f.title, count: f.deviceCount })}
              </p>
            ))}
          </>
        )}
      </Section>

      <Section title={t("sections.functions")} testId="fleet-design-section-functions">
        {sections.functions.length === 0 && <p className="text-sm text-muted-foreground">{t("items.none")}</p>}
        {sections.functions.map((f) =>
          f.itemRef ? (
            <SelectableRow
              key={f.itemRef}
              itemRef={f.itemRef}
              label={getDeviceFunctionLabel(f.functionKey, f.label)}
              meta={t("items.functionMeta", { count: f.deviceIds.length, pct: Math.round(f.confidence * 100) })}
              selection={selection}
            />
          ) : null,
        )}
      </Section>

      <Section title={t("sections.monitoring")} testId="fleet-design-section-monitoring">
        {sections.monitoring.length === 0 && <p className="text-sm text-muted-foreground">{t("items.none")}</p>}
        {sections.monitoring.map((m) => (
          <div key={m.functionKey} className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {getDeviceFunctionLabel(m.functionKey)}
            </h3>
            {m.watches.map((w) =>
              w.itemRef ? (
                <SelectableRow key={w.itemRef} itemRef={w.itemRef} label={w.name} meta={w.rationale} selection={selection} />
              ) : null,
            )}
            {m.alertRules.map((r) =>
              r.itemRef ? (
                <SelectableRow key={r.itemRef} itemRef={r.itemRef} label={r.name} meta={r.rationale} selection={selection} />
              ) : null,
            )}
          </div>
        ))}
      </Section>

      <Section title={t("sections.retired")} testId="fleet-design-section-retired">
        {sections.retired.length === 0 && <p className="text-sm text-muted-foreground">{t("items.none")}</p>}
        {sections.retired.map((r, index) => (
          <div key={r.itemRef ?? index} className="text-sm">
            <p>{r.itemName}</p>
            <p className="text-muted-foreground">{r.reason}</p>
          </div>
        ))}
      </Section>

      <Section title={t("sections.automation")} testId="fleet-design-section-automation">
        {sections.automation.length === 0 && <p className="text-sm text-muted-foreground">{t("items.none")}</p>}
        {sections.automation.map((a) => (
          <div key={a.functionKey} className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {getDeviceFunctionLabel(a.functionKey)}
            </h3>
            {a.playbooks.map((p, i) => (
              <p key={i} className="text-sm text-muted-foreground">
                {playbookLabel(p)}
              </p>
            ))}
            {a.scripts.map((s, i) =>
              s.itemRef ? (
                <div key={s.itemRef} className="space-y-1">
                  <SelectableRow
                    itemRef={s.itemRef}
                    label={s.name}
                    meta={`${s.language} · ${s.osTypes.join("/")} — ${s.purpose}`}
                    selection={selection}
                  />
                  <details data-testid={`fleet-design-script-content-${s.itemRef}`} className="rounded-md border px-3 py-1.5">
                    <summary className="cursor-pointer text-xs text-muted-foreground">{t("automation.showContent")}</summary>
                    <div className="mt-2 overflow-x-auto">
                      <pre className="text-xs">{s.content}</pre>
                    </div>
                  </details>
                </div>
              ) : (
                <p key={i} className="text-xs text-muted-foreground">
                  {s.name} — {s.purpose}
                </p>
              ),
            )}
          </div>
        ))}
      </Section>

      <Section title={t("sections.legacy")} testId="fleet-design-section-legacy">
        {sections.legacy.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("items.none")}</p>
        ) : (
          <div className="overflow-x-auto" data-testid="fleet-design-legacy-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                  <th className="px-2 py-1">{t("legacy.columns.script")}</th>
                  <th className="px-2 py-1">{t("legacy.columns.bucket")}</th>
                  <th className="px-2 py-1">{t("legacy.columns.coveredBy")}</th>
                  <th className="px-2 py-1">{t("legacy.columns.intent")}</th>
                  <th className="px-2 py-1">{t("legacy.columns.notes")}</th>
                </tr>
              </thead>
              <tbody>
                {sections.legacy.map((l) => (
                  <tr key={l.scriptId} data-testid={`fleet-design-legacy-row-${l.scriptId}`} className="border-b last:border-0">
                    <td className="px-2 py-1.5 font-medium">{l.scriptName}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${LEGACY_BUCKET_CLASS[l.bucket]}`}
                      >
                        {t(/* i18n-dynamic */ `legacy.bucket.${l.bucket}`)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">{l.coveredBy || "—"}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{l.intent}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{l.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title={t("sections.baseline")} testId="fleet-design-section-baseline">
        {sections.baseline.notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("items.none")}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {sections.baseline.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("sections.unsure")} testId="fleet-design-section-unsure">
        {sections.unsure.needsHuman.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {sections.unsure.needsHuman.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {sections.unsure.roleCorrections.map((rc) =>
          rc.itemRef ? (
            <SelectableRow
              key={rc.itemRef}
              itemRef={rc.itemRef}
              label={t("items.roleCorrectionLabel", { from: rc.currentRole, to: rc.proposedRole })}
              meta={t("drawer.billingWarning")}
              selection={selection}
            />
          ) : null,
        )}
        {sections.unsure.lowConfidenceFunctions.length === 0 &&
          sections.unsure.unreachableDevices.length === 0 &&
          sections.unsure.needsHuman.length === 0 &&
          sections.unsure.roleCorrections.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("items.none")}</p>
          )}
      </Section>
    </div>
  );
}
