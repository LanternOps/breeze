import { BrainCircuit, History, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WorkspaceEmptyStateProps {
  onCreateTab: () => void;
  /** #9840 W4: opens the "Open a past conversation" picker. */
  onOpenPast: () => void;
}

export default function WorkspaceEmptyState({
  onCreateTab,
  onOpenPast,
}: WorkspaceEmptyStateProps) {
  const { t } = useTranslation("ai");
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-purple-600/10">
        <BrainCircuit className="h-8 w-8 text-purple-400" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-200">
        {t("workspaceEmptyState.title")}
      </h2>
      <p className="mt-2 max-w-md text-center text-sm text-gray-500 dark:text-gray-500">
        {t("workspaceEmptyState.description")}
      </p>
      <button
        onClick={onCreateTab}
        className="mt-6 flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-purple-500"
      >
        <Plus className="h-4 w-4" />
        {t("workspaceEmptyState.newConversation")}
      </button>
      <button
        type="button"
        onClick={onOpenPast}
        data-testid="workspace-empty-open-past"
        className="mt-2 flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-purple-600 transition-colors hover:bg-purple-600/10 dark:text-purple-400"
      >
        <History className="h-4 w-4" />
        {t("aiConversationMove.openPastConversation")}
      </button>
      <p className="mt-3 text-xs text-gray-400 dark:text-gray-600">
        {t("workspaceEmptyState.limit")}
      </p>
    </div>
  );
}
