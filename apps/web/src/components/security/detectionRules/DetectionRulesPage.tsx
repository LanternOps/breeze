import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useHashState } from "@/lib/useHashState";
import { errorKindOf, type LoadErrorKind } from "@/lib/httpError";
import { friendlyFetchError } from "@/lib/utils";
import AccessDenied from "../../shared/AccessDenied";
import SecurityPageHeader from "../SecurityPageHeader";
import RuleSetList from "./RuleSetList";
import RuleSetEditor, { type EditorTab } from "./RuleSetEditor";
import CreateRuleSetForm from "./CreateRuleSetForm";
import { listRuleSets, type YaraRuleSetSummary } from "./ruleSetsApi";

type Selection = { setId: string; tab: EditorTab } | null;

/**
 * Hash format: empty = list; `#<setId>` = that set's rules; `#<setId>/import`
 * and `#<setId>/test` = the editor's import and test tabs.
 */
export function parseDetectionRulesHash(hash: string): Selection | undefined {
  if (!hash) return undefined;
  const [setId, tab, ...rest] = hash.split("/");
  if (!setId || rest.length > 0) return undefined;
  if (tab === undefined) return { setId, tab: "rules" };
  if (tab === "import" || tab === "test") return { setId, tab };
  return undefined;
}

export function detectionRulesHash(sel: Selection): string {
  if (!sel) return "";
  return sel.tab === "rules" ? sel.setId : `${sel.setId}/${sel.tab}`;
}

export default function DetectionRulesPage() {
  const { t } = useTranslation("security");
  const [selection, setSelection] = useHashState<Selection>(null, parseDetectionRulesHash);
  const [sets, setSets] = useState<YaraRuleSetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listRuleSets();
      setSets(rows);
      setErrorKind("none");
      setError(undefined);
    } catch (err) {
      console.error("[DetectionRulesPage] list:", err);
      const kind = errorKindOf(err);
      setErrorKind(kind);
      if (kind === "other") setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback(
    (next: Selection) => {
      window.location.hash = detectionRulesHash(next);
      setSelection(next);
    },
    [setSelection],
  );

  const header = (
    <SecurityPageHeader title={t("detectionRules.title")} subtitle={t("detectionRules.subtitle")} />
  );

  if (errorKind === "denied") {
    return (
      <div className="space-y-6">
        {header}
        <AccessDenied testId="detection-rules-denied" />
      </div>
    );
  }

  if (selection) {
    return (
      <div className="space-y-6">
        {header}
        <button
          type="button"
          data-testid="rule-set-back"
          onClick={() => select(null)}
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("detectionRules.back")}
        </button>
        <RuleSetEditor
          key={selection.setId}
          setId={selection.setId}
          tab={selection.tab}
          onTabChange={(tab) => select({ setId: selection.setId, tab })}
          onChanged={() => void load()}
          onDeleted={() => {
            select(null);
            void load();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("detectionRules.listHelp")}</p>
        <button
          type="button"
          data-testid="rule-set-new"
          onClick={() => setCreating(true)}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t("detectionRules.newRuleSet")}
        </button>
      </div>

      {creating && (
        <CreateRuleSetForm
          onCancel={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            void load();
            select({ setId: created.id, tab: "rules" });
          }}
        />
      )}

      {errorKind === "other" ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span>{error ?? t("detectionRules.loadFailed")}</span>
          <button
            type="button"
            data-testid="detection-rules-retry"
            onClick={() => void load()}
            className="rounded-md border border-destructive/40 bg-background px-3 py-1 text-xs font-medium"
          >
            {t("common:actions.retry")}
          </button>
        </div>
      ) : loading && sets.length === 0 ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <RuleSetList sets={sets} onSelect={(id) => select({ setId: id, tab: "rules" })} />
      )}
    </div>
  );
}
