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
      {/* Toggle button */}
      {!isOpen && (
        <button
          onClick={toggle}
          className="fixed bottom-6 right-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-purple-600 text-white shadow-lg transition-all hover:bg-purple-500 hover:shadow-xl"
          title="Open AI Assistant (Cmd+Shift+A)"
        >
          <MessageSquare className="h-5 w-5" />
        </button>
      )}

      {/* Sidebar panel */}
      <div
        className={`fixed right-0 top-0 z-40 flex h-full w-[400px] flex-col border-l border-gray-700 bg-gray-900 shadow-2xl transition-transform duration-300 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-700 px-4 py-3">
          <div className="flex items-center gap-2">
            {showHistory ? (
              <button
                onClick={toggleHistory}
                className="rounded p-0.5 text-gray-400 hover:text-gray-200"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : (
              <MessageSquare className="h-4 w-4 text-purple-400" />
            )}
            <span className="text-sm font-semibold text-gray-200">
              {showHistory ? 'History' : 'Breeze AI'}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {!showHistory && (
              <button
                onClick={toggleHistory}
                className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
                title="Conversation history"
              >
                <History className="h-4 w-4" />
              </button>
            )}
            {!showHistory && sessionId && (
              <button
                onClick={handleNewConversation}
                className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
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
                    ? 'text-amber-400 hover:bg-gray-800 hover:text-amber-300'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
                title={isFlagged ? 'Unflag conversation' : 'Flag conversation for review'}
              >
                <Flag className="h-4 w-4" fill={isFlagged ? 'currentColor' : 'none'} />
              </button>
            )}
            <button
              onClick={close}
              className="rounded p-1.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-gray-200"
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
            <div className="border-b border-gray-700/50 px-3 py-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search conversations..."
                  className="w-full rounded-md border border-gray-700 bg-gray-800 py-1.5 pl-8 pr-3 text-xs text-gray-200 placeholder-gray-500 outline-none focus:border-purple-600"
                />
              </div>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto">
              {isSearching && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-gray-500" />
                </div>
              )}

              {searchQuery.length >= 2 && !isSearching && searchResults.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-gray-500">No results found</p>
              )}

              {(searchQuery.length >= 2 ? searchResults : sessions).map((item) => (
                <button
                  key={item.id}
                  onClick={() => switchSession(item.id)}
                  className={`w-full border-b border-gray-800 px-4 py-3 text-left transition-colors hover:bg-gray-800/60 ${
                    item.id === sessionId ? 'bg-gray-800/40 border-l-2 border-l-purple-500' : ''
                  }`}
                >
                  <p className="text-xs font-medium text-gray-300 truncate">
                    {item.title || 'Untitled conversation'}
                  </p>
                  {'matchedContent' in item && item.matchedContent && (
                    <p className="mt-0.5 text-[10px] text-gray-500 truncate">{item.matchedContent}</p>
                  )}
                  <p className="mt-0.5 text-[10px] text-gray-600">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </p>
                </button>
              ))}

              {searchQuery.length < 2 && sessions.length === 0 && !isSearching && (
                <p className="px-4 py-6 text-center text-xs text-gray-500">No conversations yet</p>
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
              <div className="border-b border-gray-700/50 px-4 py-2">
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
