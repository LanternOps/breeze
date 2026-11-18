import { Fragment, useState } from "react";
import { Eye, EyeOff, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import type { RuleError } from "./publishOutcome";
import type { YaraRuleRow } from "./ruleSetsApi";

/**
 * The rule table of the set editor. Per-rule errors come from the last save's
 * publish outcome when there is one (it carries the line number); otherwise
 * from the rule's stored `compileError` text (line numbers are not persisted).
 */
export default function RuleSetRules({
  rules,
  readOnly,
  lastRuleErrors,
  onEdit,
  onDelete,
}: {
  rules: YaraRuleRow[];
  readOnly: boolean;
  lastRuleErrors: Map<string, RuleError[]> | null;
  onEdit: (rule: YaraRuleRow) => void;
  onDelete: (rule: YaraRuleRow) => void;
}) {
  const { t } = useTranslation("security");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (rules.length === 0) {
    return (
      <p data-testid="rule-list-empty" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t("detectionRules.editor.noRules")}
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">{t("detectionRules.editor.columns.name")}</th>
            <th className="px-4 py-2 font-medium">{t("detectionRules.editor.columns.severity")}</th>
            <th className="px-4 py-2 font-medium">{t("detectionRules.editor.columns.tags")}</th>
            <th className="px-4 py-2 font-medium">{t("detectionRules.editor.columns.state")}</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const fresh = lastRuleErrors?.get(rule.id);
            const stored = rule.compileError;
            return (
              <Fragment key={rule.id}>
                <tr data-testid={`rule-row-${rule.id}`} className="border-t align-top">
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs">{rule.name}</span>
                    {(fresh?.length || stored) && (
                      <div
                        data-testid={`rule-error-${rule.id}`}
                        role="alert"
                        className="mt-1 space-y-0.5 text-xs text-destructive"
                      >
                        {fresh && fresh.length > 0
                          ? fresh.map((e, i) => (
                              <p key={i}>
                                {e.line !== undefined && (
                                  <span className="font-medium">{t("detectionRules.editor.errorLine", { line: e.line })} </span>
                                )}
                                <span className="font-mono">{e.code}</span>: {e.message}
                              </p>
                            ))
                          : stored
                              ?.split("\n")
                              .map((line, i) => (
                                <p key={i} className="font-mono">
                                  {line}
                                </p>
                              ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">{t(/* i18n-dynamic */ `detectionRules.severity.${rule.severity}`)}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{rule.tags.join(", ")}</td>
                  <td className="px-4 py-3 text-xs">
                    {rule.enabled ? t("common:states.enabled") : t("common:states.disabled")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        data-testid={`rule-view-${rule.id}`}
                        onClick={() => toggle(rule.id)}
                        aria-label={open.has(rule.id) ? t("detectionRules.editor.hideSource") : t("detectionRules.editor.viewSource")}
                        title={open.has(rule.id) ? t("detectionRules.editor.hideSource") : t("detectionRules.editor.viewSource")}
                        className="rounded-md border p-1.5 hover:bg-muted"
                      >
                        {open.has(rule.id) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      {!readOnly && (
                        <>
                          <button
                            type="button"
                            data-testid={`rule-edit-${rule.id}`}
                            onClick={() => onEdit(rule)}
                            aria-label={t("detectionRules.editor.editRule")}
                            title={t("detectionRules.editor.editRule")}
                            className="rounded-md border p-1.5 hover:bg-muted"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            data-testid={`rule-delete-${rule.id}`}
                            onClick={() => onDelete(rule)}
                            aria-label={t("detectionRules.editor.deleteRule")}
                            title={t("detectionRules.editor.deleteRule")}
                            className="rounded-md border p-1.5 text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {open.has(rule.id) && (
                  <tr className="border-t bg-muted/20">
                    <td colSpan={5} className="px-4 py-3">
                      <pre
                        data-testid={`rule-source-${rule.id}`}
                        className="max-h-96 overflow-auto whitespace-pre rounded-md border bg-background p-3 font-mono text-xs"
                      >
                        {rule.source}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
