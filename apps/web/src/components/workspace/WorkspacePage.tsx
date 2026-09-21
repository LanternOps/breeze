import { useEffect } from 'react';
import { usePermissions } from '@/lib/permissions';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import AccessDenied from '../shared/AccessDenied';
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
    renameTab,
    restoreWorkspace,
    cleanupAllStreams,
  } = useWorkspaceStore();

  // #6498: every /ai/sessions route this page drives requires ai_sessions:use
  // (#6396). Without it the composer rendered fine and only failed on send with
  // a bare "Permission denied", so the page is gated the same way the docked
  // sidebar and the header button are. UX only — the routes re-check.
  const { permissions, can } = usePermissions();
  const canUseAi = can('ai_sessions', 'use');
  // `can` is false while /users/me is still in flight, which is indistinguishable
  // from a genuine denial; hold the page blank until the grants are known rather
  // than flashing "Access denied" at a user who does have it.
  const permissionsLoaded = permissions !== undefined;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Restore messages on mount
  useEffect(() => {
    if (!canUseAi) return;
    void restoreWorkspace();
    return () => cleanupAllStreams();
  }, [canUseAi, restoreWorkspace, cleanupAllStreams]);

  // Keyboard shortcuts — not bound without the permission, so Cmd+Shift+N
  // cannot open a tab that would 403 on the first request.
  useEffect(() => {
    if (!canUseAi) return;
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
  }, [canUseAi, activeTabId, tabs, createTab, closeTab, switchTab]);

  if (!canUseAi) {
    if (!permissionsLoaded) return null;
    return (
      <div className="flex h-full flex-col justify-center bg-white p-6 dark:bg-gray-900">
        <AccessDenied testId="workspace-access-denied" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-gray-900">
      {tabs.length > 0 ? (
        <>
          <WorkspaceTabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={switchTab}
            onCloseTab={closeTab}
            onRenameTab={(tabId, title) => void renameTab(tabId, title)}
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
