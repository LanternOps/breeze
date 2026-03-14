import { useEffect } from 'react';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import WorkspaceTabBar from './WorkspaceTabBar';
import WorkspaceChatPanel from './WorkspaceChatPanel';
import WorkspaceEmptyState from './WorkspaceEmptyState';

export default function WorkspacePage() {
  const {
    tabs,
    activeTabId,
    createTab,
    closeTab,
    switchTab,
    restoreWorkspace,
    cleanupAllStreams,
  } = useWorkspaceStore();

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Restore messages on mount
  useEffect(() => {
    void restoreWorkspace();
    return () => cleanupAllStreams();
  }, [restoreWorkspace, cleanupAllStreams]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd+Shift+N: New tab
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        createTab();
        return;
      }

      // Cmd+W: Close active tab
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault();
        if (activeTabId) closeTab(activeTabId);
        return;
      }

      // Cmd+1-5: Switch to tab by index
      if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '5') {
        const idx = parseInt(e.key) - 1;
        if (idx < tabs.length) {
          e.preventDefault();
          switchTab(tabs[idx].id);
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTabId, tabs, createTab, closeTab, switchTab]);

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      {tabs.length > 0 ? (
        <>
          <WorkspaceTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={switchTab}
            onCloseTab={closeTab}
            onNewTab={() => createTab()}
          />
          {activeTab ? (
            <WorkspaceChatPanel tab={activeTab} />
          ) : (
            <WorkspaceEmptyState onCreateTab={() => createTab()} />
          )}
        </>
      ) : (
        <WorkspaceEmptyState onCreateTab={() => createTab()} />
      )}
    </div>
  );
}
