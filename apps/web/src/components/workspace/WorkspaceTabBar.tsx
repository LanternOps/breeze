import { Plus } from 'lucide-react';
import WorkspaceTab from './WorkspaceTab';
import type { TabState } from '@/stores/workspaceStore';

const MAX_TABS = 5;

interface WorkspaceTabBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

export default function WorkspaceTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: WorkspaceTabBarProps) {
  return (
    <div className="flex items-end gap-0.5 border-b border-gray-200 bg-white px-2 pt-2 dark:border-gray-700 dark:bg-gray-900">
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
        />
      ))}

      {tabs.length < MAX_TABS && (
        <button
          onClick={onNewTab}
          className="mb-0.5 flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="New tab (Cmd+Shift+N)"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New</span>
        </button>
      )}
    </div>
  );
}
