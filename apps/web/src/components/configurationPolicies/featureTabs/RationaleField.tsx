import { useState } from "react";
import { Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Fleet Designer W03 (#5653) — read-only rationale display with an "Edit
 * rationale" affordance, shared by MonitoringTab and AlertRuleTab. A Fleet
 * Design writes `rationale` on each watch/rule it creates (why the designer
 * chose it); this lets a technician read that reasoning later and correct it
 * without leaving the tab. Saving is NOT wired to its own request — it calls
 * `onChange` synchronously so the value lands in the tab's own `settings`/
 * `items` state and rides the tab's existing Save button, same as every other
 * field on the card.
 */
const RATIONALE_MAX_CHARS = 2000;

export interface RationaleFieldProps {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  /** Stable per-item id for data-testid suffixes, e.g. `watch-rationale-0`. */
  testId: string;
}

export default function RationaleField({ value, onChange, testId }: RationaleFieldProps) {
  const { t } = useTranslation("policies");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  const beginEdit = () => {
    setDraft(value ?? "");
    setEditing(true);
  };
  const handleSave = () => {
    const trimmed = draft.trim();
    onChange(trimmed.length > 0 ? trimmed : null);
    setEditing(false);
  };
  const handleCancel = () => setEditing(false);

  if (editing) {
    return (
      <div className="mt-2 space-y-1.5" data-testid={`${testId}-editor`}>
        <label className="text-xs font-medium text-muted-foreground">
          {t("configurationPolicies.featureTabs.rationale.label")}
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, RATIONALE_MAX_CHARS))}
          maxLength={RATIONALE_MAX_CHARS}
          rows={2}
          placeholder={t("configurationPolicies.featureTabs.rationale.placeholder")}
          className="w-full rounded-md border bg-background px-2 py-1.5 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          data-testid={`${testId}-textarea`}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            data-testid={`${testId}-save`}
            className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            {t("configurationPolicies.featureTabs.rationale.save")}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            data-testid={`${testId}-cancel`}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            {t("configurationPolicies.featureTabs.rationale.cancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-start justify-between gap-2" data-testid={testId}>
      <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs text-muted-foreground">
        {value ? value : <span className="italic">{t("configurationPolicies.featureTabs.rationale.none")}</span>}
      </p>
      <button
        type="button"
        onClick={beginEdit}
        data-testid={`${testId}-edit`}
        className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Pencil className="h-3 w-3" />
        {t("configurationPolicies.featureTabs.rationale.edit")}
      </button>
    </div>
  );
}
