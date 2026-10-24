import { Plus } from "lucide-react";
import WorkspaceTab from "./WorkspaceTab";
import { MAX_TABS, type TabState } from "@/stores/workspaceStore";
import { ActionMenu } from "../shared/ActionMenu";
import { useTranslation } from "react-i18next";

interface WorkspaceTabBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, title: string) => void;
  onNewTab: () => void;
  /** #9840 W4: the "+" menu's "Open a past conversation". */
  onOpenPast: () => void;
  /** #9427 W3: the tab menu's "Continue in side panel". */
  onContinueInPanel?: (tabId: string) => void;
}

export default function WorkspaceTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onRenameTab,
  onNewTab,
  onOpenPast,
  onContinueInPanel,
}: WorkspaceTabBarProps) {
  const { t } = useTranslation("ai");
  // At the cap the "+" stays, so the reason is discoverable; its items are
  // disabled rather than evicting a tab (D5).
  const full = tabs.length >= MAX_TABS;
  return (
    <div className="flex items-end gap-0.5 border-b border-gray-200 bg-white px-2 pt-2 dark:border-gray-700 dark:bg-gray-900">
      <div role="tablist" className="contents">
      {tabs.map((tab) => (
        <WorkspaceTab
          key={tab.id}
          id={tab.id}
          title={tab.title}
          isActive={tab.id === activeTabId}
          unreadCount={tab.unreadCount}
          hasApprovalPending={tab.hasApprovalPending}
          isStreaming={tab.isStreaming}
          onSelect={() => onSelectTab(tab.id)}
          onClose={() => onCloseTab(tab.id)}
          onRename={(title) => onRenameTab(tab.id, title)}
          onContinueInPanel={tab.sessionId && onContinueInPanel ? () => onContinueInPanel(tab.id) : undefined}
        />
      ))}
      </div>

      <div className="mb-0.5">
        <ActionMenu
          label={t("workspaceTabBar.newTabShortcut")}
          testId="workspace-new-tab-menu"
          triggerClassName="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          trigger={
            <>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{t("workspaceTabBar.new")}</span>
            </>
          }
          items={[
            { id: "new-chat", label: t("aiConversationMove.newChat"), onSelect: onNewTab, disabled: full, testId: "workspace-new-chat" },
            {
              id: "open-past",
              label: t("aiConversationMove.openPastConversation"),
              onSelect: onOpenPast,
              disabled: full,
              ...(full ? { description: t("aiConversationMove.closeTabToOpen") } : {}),
              testId: "workspace-open-past",
            },
          ]}
        />
      </div>
    </div>
  );
}
