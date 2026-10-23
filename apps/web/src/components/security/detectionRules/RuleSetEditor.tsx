import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { errorKindOf, type LoadErrorKind } from "@/lib/httpError";
import { ActionError } from "@/lib/runAction";
import { friendlyFetchError } from "@/lib/utils";
import AccessDenied from "../../shared/AccessDenied";
import { ConfirmDialog } from "../../shared/ConfirmDialog";
import { showToast } from "../../shared/Toast";
import RuleSetBadges from "./RuleSetBadges";
import { useOwnerLabel } from "./RuleSetList";
import RuleSetRules from "./RuleSetRules";
import RuleEditorDialog from "./RuleEditorDialog";
import IocImportPanel from "./IocImportPanel";
import RuleTestPanel from "./RuleTestPanel";
import {
  describePublishOutcome,
  formatPublishOutcome,
  publishSuccessMessage,
  ruleSetPatchSuccessMessage,
  staleBannerText,
  type PublishOutcome,
} from "./publishOutcome";
import {
  createRule,
  deleteRule,
  deleteRuleSet,
  getRuleSet,
  updateRule,
  updateRuleSet,
  type PublishCarryingBody,
  type RuleInput,
  type UpdateRuleSetInput,
  type YaraRuleRow,
  type YaraRuleSetDetail,
  type YaraRuleSetSummary,
} from "./ruleSetsApi";

export type EditorTab = "rules" | "import" | "test";

/** Standard caller catch (CLAUDE.md): 401 → auth redirect; ActionError → already toasted. */
function handleMutationError(err: unknown, fallback: string): void {
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: "error", message: fallback });
}

export default function RuleSetEditor({
  setId,
  tab,
  onTabChange,
  onChanged,
  onDeleted,
}: {
  setId: string;
  tab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("security");
  const ownerLabel = useOwnerLabel();
  const [set, setSet] = useState<YaraRuleSetDetail | null>(null);
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const [loadError, setLoadError] = useState<string>();
  const [lastOutcome, setLastOutcome] = useState<PublishOutcome | null>(null);
  const [dialogRule, setDialogRule] = useState<YaraRuleRow | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<{ kind: "set" } | { kind: "rule"; rule: YaraRuleRow } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // A failed RE-fetch (after a mutation) keeps the last known set on screen,
  // so it must say the view may be out of date instead of passing it off as
  // the server's current state.
  const loadedRef = useRef(false);
  const [refreshFailed, setRefreshFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setSet(await getRuleSet(setId));
      loadedRef.current = true;
      setErrorKind("none");
      setLoadError(undefined);
      setRefreshFailed(false);
    } catch (err) {
      console.error("[RuleSetEditor] load:", err);
      if (loadedRef.current && errorKindOf(err) === "other") {
        setRefreshFailed(true);
        return;
      }
      const kind = errorKindOf(err);
      setErrorKind(kind);
      if (kind === "other") setLoadError(friendlyFetchError(err));
    }
  }, [setId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * After a mutation that may have republished: a warning outcome gets one
   * warning toast plus the persistent banner and per-rule errors; a success
   * outcome was already toasted by runAction's successMessage.
   */
  const applyOutcome = useCallback(
    async (outcome: PublishOutcome) => {
      if (outcome.tone === "warning") {
        const { message, detail } = formatPublishOutcome(outcome);
        showToast({ type: "warning", message, ...(detail ? { detail } : {}) });
        setLastOutcome(outcome);
      } else {
        setLastOutcome(null);
      }
      // Re-fetch so stale / currentVersion / stored compileError reflect the server.
      await load();
      onChanged();
    },
    [load, onChanged],
  );

  const afterRuleMutation = useCallback(
    (body: PublishCarryingBody, current: YaraRuleSetSummary) =>
      applyOutcome(describePublishOutcome(body?.publish, current, { expectPublish: true })),
    [applyOutcome],
  );

  if (errorKind === "denied") return <AccessDenied testId="rule-set-editor-denied" />;
  if (!set) {
    return (
      <div data-testid="rule-set-editor" className="py-10">
        {errorKind === "other" ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>{loadError}</span>
            <button
              type="button"
              data-testid="rule-set-editor-retry"
              onClick={() => void load()}
              className="rounded-md border border-destructive/40 bg-background px-3 py-1 text-xs font-medium"
            >
              {t("common:actions.retry")}
            </button>
          </div>
        ) : (
          <div className="flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    );
  }

  const readOnly = set.isBuiltin;
  const ruleSuccess = (body: unknown) => publishSuccessMessage(body, set);

  const patchSet = async (patch: UpdateRuleSetInput) => {
    setBusy(true);
    try {
      const body = await updateRuleSet(set.id, patch, ruleSetPatchSuccessMessage);
      const enabled = body.data?.enabled ?? set.enabled;
      await applyOutcome(describePublishOutcome(body.publish, { enabled }));
      return true;
    } catch (err) {
      handleMutationError(err, t("common:states.error"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitRule = async (input: RuleInput): Promise<boolean> => {
    try {
      let body: PublishCarryingBody;
      if (dialogRule) {
        const patch: Partial<RuleInput> = {};
        if (input.name !== dialogRule.name) patch.name = input.name;
        if (input.source !== dialogRule.source) patch.source = input.source;
        if (input.severity !== dialogRule.severity) patch.severity = input.severity;
        if (JSON.stringify(input.tags ?? []) !== JSON.stringify(dialogRule.tags)) patch.tags = input.tags;
        if (input.enabled !== dialogRule.enabled) patch.enabled = input.enabled;
        if (Object.keys(patch).length === 0) return true;
        body = await updateRule(dialogRule.id, patch, ruleSuccess);
      } else {
        body = await createRule(set.id, input, ruleSuccess);
      }
      await afterRuleMutation(body, set);
      return true;
    } catch (err) {
      handleMutationError(err, t("common:states.error"));
      return false;
    }
  };

  const confirmDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "set") {
        await deleteRuleSet(set.id);
        setConfirm(null);
        onDeleted();
        return;
      }
      const body = await deleteRule(confirm.rule.id, ruleSuccess);
      setConfirm(null);
      await afterRuleMutation(body, set);
    } catch (err) {
      handleMutationError(err, t("common:states.error"));
    } finally {
      setBusy(false);
    }
  };

  const banner =
    lastOutcome && lastOutcome.tone === "warning"
      ? formatPublishOutcome(lastOutcome)
      : set.stale
        ? { message: staleBannerText(set) }
        : null;

  const tabs: EditorTab[] = readOnly ? ["rules", "test"] : ["rules", "import", "test"];

  return (
    <div data-testid="rule-set-editor" className="space-y-5">
      <div className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {renaming ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = nameDraft.trim();
                  if (!name || name === set.name) return setRenaming(false);
                  void patchSet({ name }).then((ok) => ok && setRenaming(false));
                }}
              >
                <input
                  data-testid="rule-set-name-input"
                  value={nameDraft}
                  maxLength={255}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                />
                <button
                  type="submit"
                  data-testid="rule-set-name-save"
                  disabled={busy}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {t("common:actions.save")}
                </button>
                <button type="button" onClick={() => setRenaming(false)} className="rounded-md border px-3 py-1.5 text-sm">
                  {t("common:actions.cancel")}
                </button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold">{set.name}</h3>
                <RuleSetBadges set={set} />
                {!readOnly && (
                  <button
                    type="button"
                    data-testid="rule-set-rename"
                    onClick={() => {
                      setNameDraft(set.name);
                      setRenaming(true);
                    }}
                    aria-label={t("detectionRules.editor.rename")}
                    title={t("detectionRules.editor.rename")}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {ownerLabel(set)} · {t("detectionRules.rulesLabel", { total: set.ruleCount })} ·{" "}
              {set.publishedVersion > 0
                ? t("detectionRules.editor.publishedVersion", { version: set.publishedVersion })
                : t("detectionRules.badges.unpublished")}
            </p>
            {set.description && <p className="text-sm text-muted-foreground">{set.description}</p>}
            {readOnly && (
              <p data-testid="rule-set-readonly" className="text-xs text-muted-foreground">
                {t("detectionRules.editor.readOnlyBuiltin")}
              </p>
            )}
          </div>
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                <input
                  type="checkbox"
                  data-testid="rule-set-toggle-enabled"
                  checked={set.enabled}
                  disabled={busy}
                  onChange={() => void patchSet({ enabled: !set.enabled })}
                />
                {t("detectionRules.editor.enabled")}
              </label>
              <label
                className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
                title={t("detectionRules.editor.autoQuarantineHelp")}
              >
                <input
                  type="checkbox"
                  data-testid="rule-set-toggle-auto-quarantine"
                  checked={set.autoQuarantine}
                  disabled={busy}
                  onChange={() => void patchSet({ autoQuarantine: !set.autoQuarantine })}
                />
                {t("detectionRules.editor.autoQuarantine")}
              </label>
              <button
                type="button"
                data-testid="rule-set-delete"
                onClick={() => setConfirm({ kind: "set" })}
                className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
                {t("detectionRules.editor.deleteSet")}
              </button>
            </div>
          )}
        </div>
      </div>

      {refreshFailed && (
        <div
          data-testid="rule-set-refresh-error"
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span>{t("detectionRules.editor.refreshFailed")}</span>
          <button
            type="button"
            data-testid="rule-set-refresh-retry"
            onClick={() => void load()}
            className="rounded-md border border-destructive/40 bg-background px-3 py-1 text-xs font-medium"
          >
            {t("common:actions.retry")}
          </button>
        </div>
      )}

      {banner && (
        <div
          data-testid="rule-set-publish-banner"
          role="status"
          className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p>{banner.message}</p>
            {banner.detail && <p className="text-xs">{banner.detail}</p>}
            {lastOutcome && lastOutcome.setErrors.length > 0 && (
              <ul className="list-disc pl-4 text-xs" data-testid="rule-set-errors">
                {lastOutcome.setErrors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-2 border-b" role="tablist">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`rule-set-tab-${id}`}
            onClick={() => onTabChange(id)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              tab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(/* i18n-dynamic */ `detectionRules.editor.tabs.${id}`)}
          </button>
        ))}
      </div>

      {tab === "rules" && (
        <div className="space-y-3">
          {!readOnly && (
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="rule-add"
                onClick={() => setDialogRule(null)}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <Plus className="h-4 w-4" />
                {t("detectionRules.editor.addRule")}
              </button>
            </div>
          )}
          <RuleSetRules
            rules={set.rules}
            readOnly={readOnly}
            lastRuleErrors={lastOutcome?.ruleErrors ?? null}
            onEdit={(rule) => setDialogRule(rule)}
            onDelete={(rule) => setConfirm({ kind: "rule", rule })}
          />
        </div>
      )}

      {tab === "import" && !readOnly && (
        <IocImportPanel
          set={set}
          onImported={(body) => {
            onTabChange("rules");
            void afterRuleMutation(body, set);
          }}
        />
      )}

      {tab === "test" && <RuleTestPanel setId={set.id} />}

      {dialogRule !== undefined && (
        <RuleEditorDialog rule={dialogRule} onClose={() => setDialogRule(undefined)} onSubmit={submitRule} />
      )}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => void confirmDelete()}
        isLoading={busy}
        title={confirm?.kind === "set" ? t("detectionRules.editor.deleteSetTitle") : t("detectionRules.editor.deleteRuleTitle")}
        message={
          confirm?.kind === "set" ? t("detectionRules.editor.deleteSetMessage") : t("detectionRules.editor.deleteRuleMessage")
        }
        confirmLabel={t("common:actions.delete")}
        confirmTestId="rule-set-confirm-delete"
      />
    </div>
  );
}
