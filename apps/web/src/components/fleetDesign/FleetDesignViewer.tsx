import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FleetDesignOutcome } from "@breeze/shared";
import { getDeviceFunctionLabel } from "@/lib/deviceFunctions";
import type { UseDesignSelectionResult } from "./useDesignSelection";

/**
 * Fleet Designer W03 (#5653) — renders the eight `FLEET_DESIGN_SECTION_KEYS`
 * sections of a stored `FleetDesignOutcome` in order. Selectable items
 * (functions, monitoring watches/rules, retired items, role corrections) get
 * a checkbox wired through `selection`; `found`/`automation`/`legacy`/
 * `baseline` and the non-role-correction parts of `unsure` are read-only —
 * automation and legacy carry no apply path yet (W04).
 */
export interface FleetDesignViewerProps {
  outcome: FleetDesignOutcome;
  selection: UseDesignSelectionResult;
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

export default function FleetDesignViewer({ outcome, selection }: FleetDesignViewerProps) {
  const { t } = useTranslation("fleetDesign");
  const { sections } = outcome;

  return (
    <div className="space-y-4" data-testid="fleet-design-viewer">
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
        {sections.retired.map((r) =>
          r.itemRef ? (
            <SelectableRow key={r.itemRef} itemRef={r.itemRef} label={r.itemName} meta={r.reason} selection={selection} />
          ) : null,
        )}
      </Section>

      <Section title={t("sections.automation")} testId="fleet-design-section-automation">
        {sections.automation.length === 0 && <p className="text-sm text-muted-foreground">{t("items.none")}</p>}
        {sections.automation.map((a) => (
          <div key={a.functionKey} className="space-y-1 text-sm">
            <p className="font-medium">{getDeviceFunctionLabel(a.functionKey)}</p>
            {a.scripts.map((s, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                {s.name} — {s.purpose}
              </p>
            ))}
          </div>
        ))}
      </Section>

      <Section title={t("sections.legacy")} testId="fleet-design-section-legacy">
        {sections.legacy.length === 0 && <p className="text-sm text-muted-foreground">{t("items.none")}</p>}
        {sections.legacy.map((l) => (
          <p key={l.scriptId} className="text-sm">
            <span className="font-medium">{l.scriptName}</span>{" "}
            <span className="text-xs text-muted-foreground">— {l.bucket}: {l.notes}</span>
          </p>
        ))}
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
