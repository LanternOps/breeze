import { useEffect, useRef, useState } from 'react';
import { useChatStore } from './stores/chatStore';

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

export default function App() {
  const {
    connectionState,
    connectionError,
    messages,
    isStreaming,
    error,
    initialize,
    sendMessage,
    clearMessages,
  } = useChatStore();

  const [input, setInput] = useState('');
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

  return (
    <div className="helper-container">
      {/* Header */}
      <div className="helper-header">
        <div className="helper-header-left">
          <span className="helper-status-dot helper-status-connected" />
          <span className="helper-title">Breeze Helper</span>
        </div>
        <button
          onClick={clearMessages}
          className="helper-btn helper-btn-sm"
          title="New conversation"
        >
          New
        </button>
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

      {/* Messages */}
      <div className="helper-messages">
        {messages.length === 0 && (
          <div className="helper-empty">
            <p>Hi! I'm Breeze Helper.</p>
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
                {msg.content}
                {msg.isStreaming && <span className="helper-cursor" />}
              </div>
            </div>
          );
        })}

        {isStreaming && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="helper-message helper-message-assistant">
            <div className="helper-message-content">
              <span className="helper-spinner" />
            </div>
          </div>
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
