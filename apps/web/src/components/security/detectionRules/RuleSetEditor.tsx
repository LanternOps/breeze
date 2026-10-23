import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { errorKindOf, type LoadErrorKind } from "@/lib/httpError";
import AccessDenied from "../../shared/AccessDenied";
import { RuleSetBadges } from "./RuleSetList";
import { getRuleSet, type YaraRuleSetDetail } from "./ruleSetsApi";

export type EditorTab = "rules" | "import" | "test";

export default function RuleSetEditor({
  setId,
}: {
  setId: string;
  tab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation("security");
  const [set, setSet] = useState<YaraRuleSetDetail | null>(null);
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");

  const load = useCallback(async () => {
    try {
      setSet(await getRuleSet(setId));
      setErrorKind("none");
    } catch (err) {
      setErrorKind(errorKindOf(err));
    }
  }, [setId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (errorKind === "denied") return <AccessDenied testId="rule-set-editor-denied" />;
  if (!set) {
    return (
      <div data-testid="rule-set-editor" className="flex justify-center py-16">
        {errorKind === "none" && <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
      </div>
    );
  }
  return (
    <div data-testid="rule-set-editor" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold">{set.name}</h3>
        <RuleSetBadges set={set} />
      </div>
      <p className="text-sm text-muted-foreground">{t("detectionRules.rulesLabel", { total: set.ruleCount })}</p>
    </div>
  );
}
