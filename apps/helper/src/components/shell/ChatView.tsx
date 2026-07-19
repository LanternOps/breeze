import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '../../stores/chatStore';

// Extracted verbatim from App.tsx's default return (messages map, composer,
// ThinkingIndicator) — no visual/behavior change. Reads the chat store
// directly, as App did; takes no props.

function ToolCallIndicator({ toolName }: { toolName?: string }) {
  const label = toolName
    ? `Using ${toolName.replace(/_/g, ' ')}...`
    : 'Checking your system...';
  return (
    <div className="helper-tool-indicator text-ws-secondary">
      <span className="helper-spinner" />
      <span>{label}</span>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="helper-message helper-message-assistant bg-ws-surface rounded-surface shadow-[var(--ws-shadow-1)]">
      <div className="helper-thinking">
        <span className="helper-thinking-dot" />
        <span className="helper-thinking-dot" />
        <span className="helper-thinking-dot" />
        <span className="helper-thinking-label text-ws-secondary">Thinking</span>
      </div>
    </div>
  );
}

export default function ChatView() {
  const { messages, isStreaming, username, sendMessage } = useChatStore();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  return (
    <>
      {/* Messages */}
      <div className="helper-messages" data-testid="chat-view">
        {messages.length === 0 && (
          <div className="helper-empty text-ws-secondary">
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
              className={`helper-message helper-message-${msg.role} bg-ws-surface rounded-surface shadow-[var(--ws-shadow-1)]`}
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
      <form onSubmit={handleSubmit} className="helper-input-form bg-ws-surface border-ws-border-subtle shadow-[var(--ws-shadow-1)]">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask me anything..."
          disabled={isStreaming}
          rows={1}
          className="helper-input bg-ws-canvas text-ws-ink"
        />
        <button
          type="submit"
          disabled={isStreaming || !input.trim()}
          className="helper-btn helper-btn-send bg-ws-accent text-[var(--ws-accent-contrast)]"
        >
          Send
        </button>
      </form>
    </>
  );
}
