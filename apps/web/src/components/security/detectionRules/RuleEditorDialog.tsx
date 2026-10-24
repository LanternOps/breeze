import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  YARA_MAX_RULE_SOURCE_BYTES,
  YARA_RULE_NAME_PATTERN,
  YARA_RULE_SEVERITIES,
  type YaraRuleSeverity,
} from "@breeze/shared";
import { Dialog } from "../../shared/Dialog";
import type { RuleInput, YaraRuleRow } from "./ruleSetsApi";

const encoder = new TextEncoder();

/**
 * Add or edit one YARA rule: name, severity, tags and source (monospace; no
 * syntax-highlighter dependency). Compile errors come back from the server's
 * pre-check through the publish outcome, not from this form.
 */
export default function RuleEditorDialog({
  rule,
  onClose,
  onSubmit,
}: {
  /** null = add a new rule. */
  rule: YaraRuleRow | null;
  onClose: () => void;
  /** Resolves true when saved (the dialog closes), false to stay open. */
  onSubmit: (input: RuleInput) => Promise<boolean>;
}) {
  const { t } = useTranslation("security");
  const [name, setName] = useState(rule?.name ?? "");
  const [severity, setSeverity] = useState<YaraRuleSeverity>(rule?.severity ?? "high");
  const [tags, setTags] = useState((rule?.tags ?? []).join(", "));
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [source, setSource] = useState(rule?.source ?? "");
  const [saving, setSaving] = useState(false);

  const nameInvalid = name !== "" && !YARA_RULE_NAME_PATTERN.test(name);
  const sourceTooLarge = encoder.encode(source).length > YARA_MAX_RULE_SOURCE_BYTES;
  const canSave = YARA_RULE_NAME_PATTERN.test(name) && source.trim() !== "" && !sourceTooLarge && !saving;

  const submit = async () => {
    if (!canSave) return;
    const tagList = tags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const input: RuleInput = { name, source, severity, tags: tagList, enabled };
    setSaving(true);
    try {
      if (await onSubmit(input)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={rule ? t("detectionRules.dialog.titleEdit") : t("detectionRules.dialog.titleAdd")}
      maxWidth="3xl"
      className="p-6"
    >
      <form
        data-testid="rule-editor-dialog"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3 className="text-lg font-semibold">
          {rule ? t("detectionRules.dialog.titleEdit") : t("detectionRules.dialog.titleAdd")}
        </h3>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block text-sm md:col-span-2">
            <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.dialog.name")}</span>
            <input
              data-testid="rule-editor-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm"
            />
            <span className={`mt-1 block text-xs ${nameInvalid ? "text-destructive" : "text-muted-foreground"}`}>
              {t("detectionRules.dialog.nameHelp")}
            </span>
          </label>
          <label className="block text-sm">
            <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.dialog.severity")}</span>
            <select
              data-testid="rule-editor-severity"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as YaraRuleSeverity)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {YARA_RULE_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {t(/* i18n-dynamic */ `detectionRules.severity.${s}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block text-sm md:col-span-2">
            <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.dialog.tags")}</span>
            <input
              data-testid="rule-editor-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t("detectionRules.dialog.tagsHelp")}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              data-testid="rule-editor-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("detectionRules.dialog.enabled")}
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-xs uppercase text-muted-foreground">{t("detectionRules.dialog.source")}</span>
          <textarea
            data-testid="rule-editor-source"
            value={source}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
            rows={16}
            className="mt-1 w-full rounded-md border bg-background p-3 font-mono text-xs"
          />
          {sourceTooLarge && (
            <span className="mt-1 block text-xs text-destructive">{t("detectionRules.dialog.sourceTooLarge", { max: YARA_MAX_RULE_SOURCE_BYTES / 1024 })}</span>
          )}
        </label>
        <p className="text-xs text-muted-foreground">{t("detectionRules.dialog.checkedOnSave")}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="rule-editor-cancel"
            onClick={onClose}
            className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            {t("common:actions.cancel")}
          </button>
          <button
            type="submit"
            data-testid="rule-editor-save"
            disabled={!canSave}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("common:actions.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
