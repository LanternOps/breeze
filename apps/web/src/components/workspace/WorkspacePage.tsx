import { useCallback, useEffect, useRef, useState } from 'react';
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
import WorkspaceConversationPicker from './WorkspaceConversationPicker';
import type { ConversationRow } from '../ai/useAiConversationSource';
import { parseSessionHash, toastForOpenResult, writeSessionHash } from './sessionHash';
import { useContinueInPanel } from './useContinueInPanel';

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

  // The session id the URL shows because this component put it there (or a
  // link it already handled). Any other valid `#session=` in the URL is a link
  // whose hashchange has not been delivered yet, and must not be overwritten.
  const ownedHash = useRef<string | null>(null);
  const currentHashSession = () => parseSessionHash(window.location.hash.replace(/^#/, ''));
  const writeOwned = (sessionId: string | null) => {
    writeSessionHash(sessionId);
    ownedHash.current = sessionId;
  };

  useEffect(() => {
    if (!linked) return;
    const id = linked;
    const handoff = takeHandoff(id);
    void openSession(id, { draft: handoff?.draft, signal: handoff?.signal })
      .catch((err): 'error' => {
        // Never leave the origin waiting out the timeout, or the link un-cleared.
        console.error('[Workspace] Opening a linked conversation failed:', err);
        return 'error';
      })
      .then((result) => {
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
      if (currentHashSession() === id) {
        const { tabs, activeTabId } = useWorkspaceStore.getState();
        writeOwned(tabs.find((tab) => tab.id === activeTabId)?.sessionId ?? null);
      }
      // Then clear the link (unless a newer one arrived meanwhile) so a later
      // hashchange back to this id re-triggers (Advisor finding 8) and the
      // hash writer below takes over.
      setLinked((current) => (current === id ? null : current));
    });
  }, [linked, openSession, setLinked, t]);

  // The hash follows the active tab, only while no link is being handled and
  // never over a link still on its way (see ownedHash). This also covers the
  // first render, before useHashState's layout effect has read the hash.
  useEffect(() => {
    if (linked !== null) return;
    const inUrl = currentHashSession();
    if (inUrl !== undefined && inUrl !== ownedHash.current && inUrl !== activeSessionId) return;
    writeOwned(activeSessionId);
  }, [linked, activeSessionId]);

  return null;
}

/**
 * #9840 W4 (spec §3.7, D3): "Open a past conversation". A pick closes the
 * picker at once; one pick at a time (openSession on an id that already has a
 * tab appends the draft, so a second pick would carry it twice). The row the
 * side panel holds MOVES: the tab opens first with the panel's draft, and the
 * panel is released only once openSession resolved 'opened' or 'focused'
 * (resolved on the tab's attach being ready). Any other result leaves the
 * panel as it was. Never a DELETE: release is local.
 */
function useOpenPastConversation() {
  const { t } = useTranslation('ai');
  const openSession = useWorkspaceStore((s) => s.openSession);
  const [pickerOpen, setPickerOpen] = useState(false);
  const picking = useRef(false);

  const pickPast = useCallback((row: ConversationRow) => {
    setPickerOpen(false);
    if (picking.current) return;
    picking.current = true;
    const id = row.id;
    const fromPanel = row.openIn === 'panel';
    const opening = fromPanel
      ? openSession(id, { draft: useAiStore.getState().composerDraft })
      : openSession(id);
    void opening
      .catch((err): 'error' => {
        console.error('[Workspace] Opening a past conversation failed:', err);
        return 'error';
      })
      .then((result) => {
        if (fromPanel && (result === 'opened' || result === 'focused')) {
          useAiStore.getState().releaseSession(id);
        }
        const toast = toastForOpenResult(result, {
          t,
          onOpenInPanel: () => { void useAiStore.getState().adoptSession(id); },
        });
        if (toast) showToast(toast);
      })
      .finally(() => { picking.current = false; });
  }, [openSession, t]);

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const closePicker = useCallback(() => setPickerOpen(false), []);

  const picker = <WorkspaceConversationPicker open={pickerOpen} onClose={closePicker} onPick={pickPast} />;
  return { openPicker, picker };
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
  const { continueInPanel, replaceDialog } = useContinueInPanel();
  const { openPicker, picker } = useOpenPastConversation();

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
            onOpenPast={openPicker}
            onContinueInPanel={continueInPanel}
          />
          {activeTab ? (
            <WorkspaceChatPanel tab={activeTab} onContinueInPanel={() => continueInPanel(activeTab.id)} />
          ) : (
            <WorkspaceEmptyState onCreateTab={() => createTab()} onOpenPast={openPicker} />
          )}
        </>
      ) : (
        <WorkspaceEmptyState onCreateTab={() => createTab()} onOpenPast={openPicker} />
      )}
      {picker}
      {replaceDialog}
    </div>
  );
}
