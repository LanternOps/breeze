import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User, Wrench, Check, X, Loader2 } from 'lucide-react';
import { useScriptAiStore, type ScriptAiMessage } from '@/stores/scriptAiStore';

function MessageBubble({ message }: { message: ScriptAiMessage }) {
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool_use' || message.role === 'tool_result';

  if (isTool) {
    const isApplyTool = message.toolName?.startsWith('apply_script_');
    return (
      <div className="mx-3 my-1 flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
        <Wrench className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {isApplyTool && message.role === 'tool_result'
            ? `Applied to editor`
            : message.toolName ?? 'Tool call'}
        </span>
        {message.role === 'tool_result' && (
          <Check className="h-3 w-3 shrink-0 text-green-500" />
        )}
      </div>
    );
  }

  return (
    <div className={`flex gap-2 px-3 py-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
        isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'
      }`}>
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </div>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
        isUser
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted'
      }`}>
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-headings:text-sm prose-headings:font-semibold prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-xs prose-code:before:content-none prose-code:after:content-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href && /^https?:\/\//.test(href) ? href : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
            {message.isStreaming && (
              <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-current" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalCard() {
  const { pendingApproval, approveExecution } = useScriptAiStore();
  if (!pendingApproval) return null;

  return (
    <div className="mx-3 my-2 rounded-lg border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
        Approval Required
      </p>
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
        {pendingApproval.description}
      </p>
      <div className="mt-2 flex gap-2">
        <button
          onClick={() => approveExecution(pendingApproval.executionId, true)}
          className="flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
        >
          <Check className="h-3 w-3" /> Approve
        </button>
        <button
          onClick={() => approveExecution(pendingApproval.executionId, false)}
          className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <X className="h-3 w-3" /> Reject
        </button>
      </div>
    </div>
  );
}

export default function ScriptAiMessages() {
  const { messages, isStreaming, isLoading } = useScriptAiStore();
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the chat container (not the page) as messages stream in
  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.content]);

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
        <Bot className="h-8 w-8 text-muted-foreground/50" />
        <p className="mt-2 text-sm font-medium text-muted-foreground">Script AI Assistant</p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Describe what you need and I'll write the script for you.
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      <ApprovalCard />
    </div>
  );
}
