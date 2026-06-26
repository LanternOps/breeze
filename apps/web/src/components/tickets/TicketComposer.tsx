import { useState, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import CannedResponsePicker from './CannedResponsePicker';
import type { CannedResponse } from '../../lib/ticketResponseTemplatesApi';

interface Props {
  requesterName: string | null;
  /** Must surface its own failures (runAction). Rejection here only preserves the draft. */
  onSend: (content: string, isPublic: boolean) => Promise<void>;
  disabled?: boolean;
  /** Partner canned responses (empty/omitted hides the picker). */
  templates?: CannedResponse[];
  /** Merge-variable values resolved from the current ticket, applied on insert. */
  templateVars?: Record<string, string>;
}

export default function TicketComposer({ requesterName, onSend, disabled, templates, templateVars }: Props) {
  const [mode, setMode] = useState<'reply' | 'internal'>('reply'); // public reply default (UI brief)
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isPublic = mode === 'reply';

  // Splice canned text in at the caret (append when there's no selection) so an
  // agent can stack snippets and keep editing. Never sends.
  const insertText = useCallback(
    (text: string) => {
      const el = textareaRef.current;
      if (!el) {
        setContent((c) => c + text);
        return;
      }
      const start = el.selectionStart ?? content.length;
      const end = el.selectionEnd ?? content.length;
      setContent(content.slice(0, start) + text + content.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + text.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [content],
  );

  const send = useCallback(async () => {
    if (!content.trim() || sending) return;
    setSending(true);
    try {
      await onSend(content.trim(), isPublic);
      setContent('');
    } catch {
      // failure already surfaced via runAction toast; keep the draft
    } finally {
      setSending(false);
    }
  }, [content, isPublic, onSend, sending]);

  return (
    <div
      className={cn(
        'border-t',
        !isPublic && 'bg-warning/10 dark:bg-warning/15' // unmistakable internal wash
      )}
      data-testid="ticket-composer"
    >
      <div className="flex items-center gap-1 px-3 pt-2">
        <button
          type="button"
          onClick={() => setMode('reply')}
          aria-selected={isPublic}
          data-testid="ticket-composer-tab-reply"
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium', isPublic ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          Reply
        </button>
        <button
          type="button"
          onClick={() => setMode('internal')}
          aria-selected={!isPublic}
          data-testid="ticket-composer-tab-internal"
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium', !isPublic ? 'bg-warning/20 text-warning' : 'text-muted-foreground hover:text-foreground')}
        >
          Internal note
        </button>
        {!isPublic && (
          <span className="ml-2 text-xs font-medium text-warning" data-testid="ticket-composer-internal-banner">
            Internal: not visible to requester
          </span>
        )}
        <div className="ml-auto">
          <CannedResponsePicker
            templates={templates ?? []}
            vars={templateVars ?? {}}
            onInsert={insertText}
            disabled={disabled || sending}
          />
        </div>
      </div>
      <div className="p-3">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={isPublic ? `Reply to ${requesterName ?? 'requester'}…` : 'Add an internal note…'}
          rows={3}
          disabled={disabled || sending}
          data-testid="ticket-composer-input"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!content.trim() || sending || disabled}
            data-testid="ticket-composer-send"
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              isPublic ? 'bg-primary hover:bg-primary/90' : 'bg-warning hover:bg-warning/90 text-warning-foreground'
            )}
          >
            {sending ? 'Sending' : isPublic ? 'Send reply' : 'Add internal note'}
          </button>
        </div>
      </div>
    </div>
  );
}
