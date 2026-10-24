import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '@/lib/permissions';
import { useHashState } from '@/lib/useHashState';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useAiStore } from '@/stores/aiStore';
import { abortHandoff, completeHandoff, takeHandoff } from '@/stores/aiConversationHandoff';
import AccessDenied from '../shared/AccessDenied';
import { showToast } from '../shared/Toast';
import WorkspaceTabBar from './WorkspaceTabBar';
import WorkspaceChatPanel from './WorkspaceChatPanel';
import WorkspaceEmptyState from './WorkspaceEmptyState';
import { parseSessionHash, toastForOpenResult, writeSessionHash } from './sessionHash';

/**
 * #9427 W3 (spec §3.6, D6): `#session=<uuid>` opens or focuses that
 * conversation, completing or aborting a pending side-panel hand-off; once a
 * link is handled the hash follows the active tab. Mounted only with
 * `ai_sessions:use`, so without it the hash is never read and nothing is
 * fetched.
 */
function WorkspaceSessionLink() {
  const { t } = useTranslation('ai');
  const [linked, setLinked] = useHashState<string | null>(null, parseSessionHash);
  const openSession = useWorkspaceStore((s) => s.openSession);
  const activeSessionId = useWorkspaceStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.sessionId ?? null,
  );

  useEffect(() => {
    if (!linked) return;
    const id = linked;
    const handoff = takeHandoff(id);
    void openSession(id, { draft: handoff?.draft, signal: handoff?.signal }).then((result) => {
      // Release the origin only once the tab is there; anything else keeps
      // it at once rather than after the 15 s timeout (D3).
      if (result === 'opened' || result === 'focused') completeHandoff(id);
      else abortHandoff(id);
      const toast = toastForOpenResult(result, {
        t,
        onOpenInPanel: () => { void useAiStore.getState().adoptSession(id); },
      });
      if (toast) showToast(toast);
      // Handled. Point the URL at the active tab now, synchronously, unless a
      // newer link is already there: a hashchange that lands before the next
      // render then reads the new hash instead of re-arming this link.
      if (parseSessionHash(window.location.hash.replace(/^#/, '')) === id) {
        const { tabs, activeTabId } = useWorkspaceStore.getState();
        writeSessionHash(tabs.find((tab) => tab.id === activeTabId)?.sessionId ?? null);
      }
      // Then clear the link (unless a newer one arrived meanwhile) so a later
      // hashchange back to this id re-triggers (Advisor finding 8) and the
      // hash writer below takes over.
      setLinked((current) => (current === id ? null : current));
    });
  }, [linked, openSession, setLinked, t]);

  // The hash follows the active tab — but never before a link is handled.
  // useHashState reads the hash in a layout effect after the first render, so
  // this effect's first run still sees `linked === null`: leave a valid link
  // in the URL for that read instead of overwriting it with the persisted tab.
  const firstWrite = useRef(true);
  useEffect(() => {
    if (linked !== null) return;
    if (firstWrite.current) {
      firstWrite.current = false;
      if (parseSessionHash(window.location.hash.replace(/^#/, '')) !== undefined) return;
    }
    writeSessionHash(activeSessionId);
  }, [linked, activeSessionId]);

  return null;
}

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
      <WorkspaceSessionLink />
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
