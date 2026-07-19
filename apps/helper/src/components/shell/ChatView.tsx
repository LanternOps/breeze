import { useEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStore } from '../../stores/chatStore';
import ChatFileCard, {
  openWorkspaceFile,
  type WorkspaceFileSummary,
} from '../workspace/ChatFileCard';

// Extracted from App.tsx's default return (messages map, composer,
// ThinkingIndicator). Reads the chat store directly, as App did. The composer
// draft is owned by the shell (single definition) and threaded through props so
// text survives a panel <-> full-swap conversion across the breakpoint.

// Citation token the model is instructed to emit for every passage it cites
// (see workspaceChatTools.ts's get_file_passages description): [file:<id>|<relPath>].
const CITATION_RE = /\[file:([^|\]]+)\|([^\]]+)\]/g;

interface FileResolution {
  relPath: string;
  openPath: string | null;
}

/**
 * Resolves citation tokens to an openable file: scans every tool_result in
 * the session for `search_workspace_files`/`get_file_passages` output rows
 * (duck-typed by an output `files`/`passages` array — robust to toolName
 * being unset on live-streamed tool_result messages, since the wire's
 * `tool_result` SSE event carries no toolName, only toolUseId) and keeps the
 * last row seen per fileIndexId.
 */
function buildFileResolutionMap(messages: { role: string; toolOutput?: unknown }[]) {
  const map = new Map<string, FileResolution>();
  for (const msg of messages) {
    if (msg.role !== 'tool_result') continue;
    const output = msg.toolOutput as
      | { files?: WorkspaceFileSummary[]; passages?: WorkspaceFileSummary[] }
      | undefined;
    const rows = output?.files ?? output?.passages;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && typeof row.fileIndexId === 'string' && typeof row.relPath === 'string') {
        map.set(row.fileIndexId, { relPath: row.relPath, openPath: row.openPath ?? null });
      }
    }
  }
  return map;
}

function fileBaseName(relPath: string): string {
  const parts = relPath.split('/');
  return parts[parts.length - 1] || relPath;
}

function CitationChip({
  fileIndexId,
  resolution,
  username,
}: {
  fileIndexId: string;
  resolution: FileResolution;
  username: string | null;
}) {
  return (
    <button
      type="button"
      className="helper-citation-chip"
      title={resolution.relPath}
      onClick={() => {
        openWorkspaceFile(fileIndexId, resolution.openPath, username);
      }}
    >
      {fileBaseName(resolution.relPath)}
    </button>
  );
}

/**
 * Replaces `[file:<id>|<relPath>]` citation tokens found in markdown text
 * children with clickable chips; an id that doesn't resolve (not seen in any
 * tool_result this session) is left as plain text — no chip. Only string
 * children are scanned; nested markdown elements (links, code, bold) pass
 * through untouched.
 */
function withCitations(
  children: React.ReactNode,
  resolveMap: Map<string, FileResolution>,
  username: string | null,
): React.ReactNode {
  const items = Array.isArray(children) ? children : [children];
  const out: React.ReactNode[] = [];

  items.forEach((child, itemIndex) => {
    if (typeof child !== 'string') {
      out.push(child);
      return;
    }

    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let matchIndex = 0;
    CITATION_RE.lastIndex = 0;
    while ((match = CITATION_RE.exec(child))) {
      const [full, fileIndexId] = match;
      if (match.index > lastIndex) out.push(child.slice(lastIndex, match.index));

      const resolution = resolveMap.get(fileIndexId);
      if (resolution) {
        out.push(
          <CitationChip
            key={`cite-${itemIndex}-${matchIndex}`}
            fileIndexId={fileIndexId}
            resolution={resolution}
            username={username}
          />,
        );
      } else {
        out.push(full);
      }
      lastIndex = match.index + full.length;
      matchIndex += 1;
    }
    if (lastIndex < child.length) out.push(child.slice(lastIndex));
  });

  return out;
}

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

export default function ChatView({
  draft,
  setDraft,
}: {
  draft: string;
  setDraft: (value: string) => void;
}) {
  const { messages, isStreaming, username, sendMessage } = useChatStore();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileResolutionMap = useMemo(() => buildFileResolutionMap(messages), [messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || isStreaming) return;
    sendMessage(draft);
    setDraft('');
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
            // Only search_workspace_files results render as cards (duck-typed
            // via an output `files` array — get_file_passages and any other
            // tool result stay internal, today's behavior, rendering nothing).
            const output = msg.toolOutput as { files?: WorkspaceFileSummary[] } | undefined;
            if (Array.isArray(output?.files)) {
              return <ChatFileCard key={msg.id} files={output.files} />;
            }
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
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p>{withCitations(children, fileResolutionMap, username)}</p>,
                        li: ({ children }) => <li>{withCitations(children, fileResolutionMap, username)}</li>,
                      }}
                    >
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
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask me anything..."
          disabled={isStreaming}
          rows={1}
          className="helper-input bg-ws-canvas text-ws-ink"
        />
        <button
          type="submit"
          disabled={isStreaming || !draft.trim()}
          className="helper-btn helper-btn-send bg-ws-accent text-[var(--ws-accent-contrast)]"
        >
          Send
        </button>
      </form>
    </>
  );
}
