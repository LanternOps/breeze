import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from './stores/chatStore';
import type { SessionSummary, PendingApproval, DeviceContext } from './stores/chatStore';

function ToolCallIndicator({ toolName }: { toolName?: string }) {
  const label = toolName
    ? `Using ${toolName.replace(/_/g, ' ')}...`
    : 'Checking your system...';
  return (
    <div className="helper-tool-indicator">
      <span className="helper-spinner" />
      <span>{label}</span>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="helper-message helper-message-assistant">
      <div className="helper-thinking">
        <span className="helper-thinking-dot" />
        <span className="helper-thinking-dot" />
        <span className="helper-thinking-dot" />
        <span className="helper-thinking-label">Thinking</span>
      </div>
    </div>
  );
}

function UsernamePrompt({ osUsername }: { osUsername?: string }) {
  const setUsername = useChatStore((s) => s.setUsername);
  const [name, setName] = useState(osUsername ?? '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) setUsername(trimmed);
  };

  return (
    <div className="helper-container helper-center">
      <div className="helper-username-prompt">
        <p className="helper-username-title">Welcome to Breeze Helper</p>
        <p className="helper-username-subtitle">What's your name?</p>
        <form onSubmit={handleSubmit} className="helper-username-form">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name"
            className="helper-username-input"
            autoFocus
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="helper-btn helper-btn-send"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function SessionHistory({ onClose }: { onClose: () => void }) {
  const { sessions, sessionsLoading, loadSession, loadSessions } = useChatStore();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleSelect = (session: SessionSummary) => {
    loadSession(session.id);
    onClose();
  };

  return (
    <div className="helper-history">
      <div className="helper-history-header">
        <span className="helper-history-title">History</span>
        <button onClick={onClose} className="helper-btn helper-btn-sm">
          Back
        </button>
      </div>
      <div className="helper-history-list">
        {sessionsLoading && (
          <div className="helper-history-loading">
            <span className="helper-spinner" />
            <span>Loading...</span>
          </div>
        )}
        {!sessionsLoading && sessions.length === 0 && (
          <div className="helper-history-empty">No conversations yet</div>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            className="helper-history-item"
            onClick={() => handleSelect(s)}
          >
            <span className="helper-history-item-title">
              {s.title || 'Untitled'}
            </span>
            <span className="helper-history-item-meta">
              {formatDate(s.updatedAt)}
              {s.turnCount > 0 && ` · ${s.turnCount} turns`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const AUTO_DENY_MS = 5 * 60 * 1000; // 5 minutes
const HIDDEN_INPUT_KEYS = new Set(['deviceId', 'orgId', 'siteId', 'sessionId']);

function filterInput(input: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!HIDDEN_INPUT_KEYS.has(k)) filtered[k] = v;
  }
  return filtered;
}

function formatIdle(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDeviceIdle(lastSeenAt: string | undefined): string | null {
  if (!lastSeenAt) return null;
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 60_000) return null;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function DeviceBadge({ ctx }: { ctx: DeviceContext }) {
  const name = ctx.displayName || ctx.hostname;
  const isOnline = ctx.status === 'online';
  const deviceIdleText = !isOnline ? formatDeviceIdle(ctx.lastSeenAt) : null;
  const sessions = ctx.activeSessions ?? [];

  return (
    <div className="helper-approval-device">
      <div className="helper-approval-device-row">
        <span className="helper-approval-device-name">{name}</span>
        <span className="helper-approval-device-sep">&middot;</span>
        <span className={isOnline ? 'helper-approval-device-active' : 'helper-approval-device-idle'}>
          {isOnline ? 'online' : (deviceIdleText ? `offline ${deviceIdleText}` : 'offline')}
        </span>
      </div>
      {sessions.map((s, i) => {
        const state = s.activityState ?? 'unknown';
        const idleText = state !== 'active' && s.idleMinutes != null && s.idleMinutes > 0
          ? `idle ${formatIdle(s.idleMinutes)}`
          : state;
        return (
          <div key={i} className="helper-approval-device-session">
            <span className="helper-approval-device-user">{s.username}</span>
            {s.sessionType !== 'console' && (
              <span className="helper-approval-device-type">{s.sessionType}</span>
            )}
            <span className={state === 'active' ? 'helper-approval-device-active' : 'helper-approval-device-idle'}>
              {idleText}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ToolApprovalPopup({
  approval,
  onApprove,
  onDeny,
}: {
  approval: PendingApproval;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const [remainingMs, setRemainingMs] = useState(AUTO_DENY_MS);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const remaining = AUTO_DENY_MS - elapsed;
      if (remaining <= 0) {
        clearInterval(interval);
        onDeny();
      } else {
        setRemainingMs(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [onDeny]);

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const countdown = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  const visibleInput = filterInput(approval.input);
  const hasVisibleInput = Object.keys(visibleInput).length > 0;

  return (
    <div className="helper-approval-overlay">
      <div className="helper-approval-card">
        <div className="helper-approval-header">
          <span className="helper-approval-icon">&#9888;</span>
          <span className="helper-approval-title">Approval Required</span>
        </div>
        <div className="helper-approval-body">
          <div className="helper-approval-desc">{approval.description}</div>
          {approval.deviceContext && <DeviceBadge ctx={approval.deviceContext} />}
          {hasVisibleInput && (
            <details className="helper-approval-details">
              <summary>Show parameters</summary>
              <pre className="helper-approval-input">
                {JSON.stringify(visibleInput, null, 2)}
              </pre>
            </details>
          )}
        </div>
        <div className="helper-approval-footer">
          <span className="helper-approval-countdown">Auto-deny {countdown}</span>
          <div className="helper-approval-actions">
            <button onClick={onDeny} className="helper-btn helper-btn-deny">
              Deny
            </button>
            <button onClick={onApprove} className="helper-btn helper-btn-allow">
              Allow
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const {
    connectionState,
    connectionError,
    agentConfig,
    messages,
    isStreaming,
    error,
    username,
    pendingApproval,
    initialize,
    sendMessage,
    clearMessages,
    approveExecution,
  } = useChatStore();

  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    sendMessage(input);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Connection states
  if (connectionState === 'connecting') {
    return (
      <div className="helper-container helper-center">
        <span className="helper-spinner" />
        <p>Connecting to Breeze...</p>
      </div>
    );
  }

  if (connectionState === 'error') {
    return (
      <div className="helper-container helper-center">
        <div className="helper-error-banner">
          <p>Failed to connect</p>
          <p className="helper-error-detail">{connectionError}</p>
          <button onClick={initialize} className="helper-btn">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (connectionState === 'disconnected') {
    return (
      <div className="helper-container helper-center">
        <p>Not connected</p>
        <button onClick={initialize} className="helper-btn">
          Connect
        </button>
      </div>
    );
  }

  // Username prompt (shown once before first use)
  if (!username) {
    return <UsernamePrompt osUsername={agentConfig?.os_username} />;
  }

  // Session history view
  if (showHistory) {
    return (
      <div className="helper-container">
        <SessionHistory onClose={() => setShowHistory(false)} />
      </div>
    );
  }

  return (
    <div className="helper-container">
      {/* Header — draggable title bar */}
      <div className="helper-header" data-tauri-drag-region>
        <div className="helper-header-left" data-tauri-drag-region>
          <span className="helper-status-dot helper-status-connected" />
          <span className="helper-title">Breeze Helper</span>
        </div>
        <div className="helper-header-actions">
          <button
            onClick={() => setShowHistory(true)}
            className="helper-btn helper-btn-sm"
            title="Conversation history"
          >
            History
          </button>
          <button
            onClick={clearMessages}
            className="helper-btn helper-btn-sm"
            title="New conversation"
          >
            New
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="helper-error-banner">
          <span>{error}</span>
          <button
            onClick={() => useChatStore.setState({ error: null })}
            className="helper-btn-close"
          >
            ×
          </button>
        </div>
      )}

      {/* Tool Approval Popup */}
      {pendingApproval && (
        <ToolApprovalPopup
          approval={pendingApproval}
          onApprove={() => approveExecution(pendingApproval.executionId, true)}
          onDeny={() => approveExecution(pendingApproval.executionId, false)}
        />
      )}

      {/* Messages */}
      <div className="helper-messages">
        {messages.length === 0 && (
          <div className="helper-empty">
            <p>Hi{username ? `, ${username}` : ''}! I'm Breeze Helper.</p>
            <p>Ask me anything about your computer.</p>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'tool_use') {
            return <ToolCallIndicator key={msg.id} toolName={msg.toolName} />;
          }

          if (msg.role === 'tool_result') {
            return null; // Tool results are internal, not shown to end users
          }

          return (
            <div
              key={msg.id}
              className={`helper-message helper-message-${msg.role}`}
            >
              <div className="helper-message-content">
                {msg.role === 'assistant' ? (
                  <>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                    {msg.isStreaming && <span className="helper-cursor" />}
                  </>
                ) : (
                  msg.content
                )}
              </div>
            </div>
          );
        })}

        {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && (
          <ThinkingIndicator />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="helper-input-form">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask me anything..."
          disabled={isStreaming}
          rows={1}
          className="helper-input"
        />
        <button
          type="submit"
          disabled={isStreaming || !input.trim()}
          className="helper-btn helper-btn-send"
        >
          Send
        </button>
      </form>
    </div>
  );
}
