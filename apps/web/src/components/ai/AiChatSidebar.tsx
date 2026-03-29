import { useEffect, useState, useCallback, useRef } from 'react';
import { X, MessageSquare, Plus, History, Search, ArrowLeft, Loader2, Flag } from 'lucide-react';
import { useAiStore } from '@/stores/aiStore';
import AiChatMessages from './AiChatMessages';
import AiChatInput from './AiChatInput';
import AiContextBadge from './AiContextBadge';
import AiCostIndicator from './AiCostIndicator';

export default function AiChatSidebar() {
  const {
    isOpen,
    toggle,
    close,
    messages,
    isStreaming,
    isLoading,
    error,
    pageContext,
    pendingApproval,
    pendingPlan,
    activePlan,
    approvalMode,
    isPaused,
    sessionId,
    showHistory,
    sessions,
    searchResults,
    isSearching,
    sendMessage,
    approveExecution,
    approvePlan,
    abortPlan,
    pauseAi,
    createSession,
    closeSession,
    clearError,
    toggleHistory,
    loadSessions,
    loadSession,
    searchConversations,
    switchSession,
    interruptResponse,
    isInterrupting,
    isFlagged,
    flagSession,
    unflagSession
  } = useAiStore();

  const [searchQuery, setSearchQuery] = useState('');
  const restoredSessionIdRef = useRef<string | null>(null);

  // Keyboard shortcut: Cmd+Shift+A to toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'a') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

  // Restore session history when sidebar opens with a persisted sessionId
  useEffect(() => {
    if (!isOpen || !sessionId) {
      restoredSessionIdRef.current = null;
      return;
    }

    // Prevent fetch loops when a valid session has no messages yet.
    // Load persisted session content at most once per open/session pair.
    if (messages.length === 0 && !isLoading && restoredSessionIdRef.current !== sessionId) {
      restoredSessionIdRef.current = sessionId;
      void loadSession(sessionId);
    }
  }, [isOpen, sessionId, messages.length, isLoading, loadSession]);

  // Load sessions when history panel opens
  useEffect(() => {
    if (showHistory) loadSessions();
  }, [showHistory, loadSessions]);

  // Debounced search
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) return;
    const timer = setTimeout(() => searchConversations(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchConversations]);

  const handleNewConversation = useCallback(async () => {
    await closeSession();
    await createSession();
  }, [closeSession, createSession]);

  return (
    <>
      {/* Sidebar panel */}
      <div
        className={`fixed right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l bg-card shadow-2xl transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b bg-card px-4 py-3">
          <div className="flex items-center gap-2">
            {showHistory ? (
              <button
                onClick={toggleHistory}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : (
              <MessageSquare className="h-4 w-4 text-primary" />
            )}
            <span className="text-sm font-semibold text-foreground">
              {showHistory ? 'History' : 'Breeze AI'}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {!showHistory && (
              <button
                onClick={toggleHistory}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Conversation history"
              >
                <History className="h-4 w-4" />
              </button>
            )}
            {!showHistory && sessionId && (
              <button
                onClick={handleNewConversation}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="New conversation"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
            {!showHistory && sessionId && (
              <button
                onClick={() => isFlagged ? unflagSession() : flagSession()}
                className={`rounded p-1.5 transition-colors ${
                  isFlagged
                    ? 'text-amber-400 hover:bg-muted hover:text-amber-300'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
                title={isFlagged ? 'Unflag conversation' : 'Flag conversation for review'}
              >
                <Flag className="h-4 w-4" fill={isFlagged ? 'currentColor' : 'none'} />
              </button>
            )}
            <button
              onClick={close}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Close (Cmd+Shift+A)"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {showHistory ? (
          /* History panel */
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Search input */}
            <div className="border-b px-3 py-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search conversations..."
                  className="w-full rounded-md border bg-muted py-1.5 pl-8 pr-3 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary"
                />
              </div>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto">
              {isSearching && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {searchQuery.length >= 2 && !isSearching && searchResults.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">No results found</p>
              )}

              {(searchQuery.length >= 2 ? searchResults : sessions).map((item) => (
                <button
                  key={item.id}
                  onClick={() => switchSession(item.id)}
                  className={`w-full border-b px-4 py-3 text-left transition-colors hover:bg-muted ${
                    item.id === sessionId ? 'bg-muted border-l-2 border-l-primary' : ''
                  }`}
                >
                  <p className="text-xs font-medium text-foreground truncate">
                    {item.title || 'Untitled conversation'}
                  </p>
                  {'matchedContent' in item && item.matchedContent && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground truncate">{item.matchedContent}</p>
                  )}
                  <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </p>
                </button>
              ))}

              {searchQuery.length < 2 && sessions.length === 0 && !isSearching && (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">No conversations yet</p>
              )}
            </div>
          </div>
        ) : (
          /* Chat panel */
          <>
            {/* Cost indicator */}
            <AiCostIndicator enabled={isOpen} />

            {/* Context badge */}
            {pageContext && (
              <div className="border-b px-4 py-2">
                <AiContextBadge context={pageContext} />
              </div>
            )}

            {/* Error banner */}
            {error && (
              <div className="flex items-center justify-between border-b border-red-800/50 bg-red-900/20 px-4 py-2">
                <span className="text-xs text-red-400">{error}</span>
                <button
                  onClick={clearError}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Messages area */}
            <AiChatMessages
              messages={messages}
              pendingApproval={pendingApproval}
              pendingPlan={pendingPlan}
              activePlan={activePlan}
              approvalMode={approvalMode}
              isPaused={isPaused}
              onApprove={(id) => approveExecution(id, true)}
              onReject={(id) => approveExecution(id, false)}
              onApprovePlan={approvePlan}
              onAbortPlan={abortPlan}
              onPauseAi={pauseAi}
              onSendQuickAction={sendMessage}
            />

            {/* Input */}
            <AiChatInput
              onSend={sendMessage}
              onInterrupt={interruptResponse}
              disabled={isLoading}
              isStreaming={isStreaming}
              isInterrupting={isInterrupting}
            />
          </>
        )}
      </div>

      {/* Backdrop overlay when open on small screens */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={close}
        />
      )}
    </>
  );
}
