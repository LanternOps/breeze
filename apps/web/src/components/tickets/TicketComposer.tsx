import { useState, useCallback, useRef } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { TICKET_ATTACHMENT_LIMITS, type TicketTemplateVars } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { showToast } from '../shared/Toast';
import CannedResponsePicker from './CannedResponsePicker';
import type { CannedResponse } from '../../lib/ticketResponseTemplatesApi';

/**
 * W08 #3902 — one chip per picked file. `status` drives the whole UI: Send is
 * blocked while anything is 'uploading', only 'done' chips contribute an id to
 * the comment, and an 'error' chip stays put with a Retry so a single failed
 * file never costs the user the other four.
 */
interface AttachmentChip {
  key: string;
  file: File;
  status: 'uploading' | 'done' | 'error';
  id?: string;
}

interface Props {
  requesterName: string | null;
  /** Must surface its own failures (runAction). Rejection here only preserves the draft. */
  onSend: (content: string, isPublic: boolean, attachmentIds: string[]) => Promise<void>;
  /**
   * Uploads ONE file and resolves with its pending attachment id. The caller
   * owns the runAction wrapping and the FormData POST; the composer only tracks
   * chips. Omit to hide the attach control entirely.
   */
  onUploadAttachment?: (file: File) => Promise<{ id: string }>;
  disabled?: boolean;
  /** Partner canned responses (empty/omitted hides the picker). */
  templates?: CannedResponse[];
  /** Merge-variable values resolved from the current ticket, applied on insert. */
  templateVars?: TicketTemplateVars;
}

export default function TicketComposer({ requesterName, onSend, onUploadAttachment, disabled, templates, templateVars }: Props) {
  const { t } = useTranslation('tickets');
  const [mode, setMode] = useState<'reply' | 'internal'>('reply'); // public reply default (UI brief)
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isPublic = mode === 'reply';
  const uploading = chips.some((c) => c.status === 'uploading');
  const readyIds = chips.filter((c) => c.status === 'done' && c.id).map((c) => c.id!);

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

  const startUpload = useCallback(async (chip: AttachmentChip) => {
    if (!onUploadAttachment) return;
    try {
      const { id } = await onUploadAttachment(chip.file);
      setChips((cs) => cs.map((c) => (c.key === chip.key ? { ...c, status: 'done', id } : c)));
    } catch {
      // The uploader already toasted through runAction; the chip is the
      // persistent, retryable record of the failure.
      setChips((cs) => cs.map((c) => (c.key === chip.key ? { ...c, status: 'error', id: undefined } : c)));
    }
  }, [onUploadAttachment]);

  const addFiles = useCallback((picked: FileList | null) => {
    if (!picked || picked.length === 0 || !onUploadAttachment) return;
    const files = Array.from(picked);
    const room = TICKET_ATTACHMENT_LIMITS.maxPerComment - chips.length;
    const accepted = files.slice(0, Math.max(room, 0));
    const rejectedCount = files.length - accepted.length;
    const oversize = accepted.filter((f) => f.size > TICKET_ATTACHMENT_LIMITS.maxBytes);
    const fitting = accepted.filter((f) => f.size <= TICKET_ATTACHMENT_LIMITS.maxBytes);

    if (rejectedCount > 0) {
      showToast({
        type: 'error',
        message: t('ticketComposer.attachments.tooMany', { max: TICKET_ATTACHMENT_LIMITS.maxPerComment }),
      });
    }
    if (oversize.length > 0) {
      showToast({
        type: 'error',
        message: t('ticketComposer.attachments.tooLarge', { name: oversize[0]!.name }),
      });
    }

    const added: AttachmentChip[] = fitting.map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      status: 'uploading',
    }));
    if (added.length === 0) return;
    setChips((cs) => [...cs, ...added]);
    for (const chip of added) void startUpload(chip);
  }, [chips.length, onUploadAttachment, startUpload, t]);

  const send = useCallback(async () => {
    // An attachment-only comment is legal (the shared validator allows empty
    // content when attachmentIds is non-empty), so the guard is "nothing at
    // all", not "no text".
    if ((!content.trim() && readyIds.length === 0) || sending || uploading) return;
    setSending(true);
    try {
      await onSend(content.trim(), isPublic, readyIds);
      setContent('');
      setChips([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      // failure already surfaced via runAction toast; keep the draft AND the
      // chips — re-uploading five photos because the POST 500'd is punitive.
    } finally {
      setSending(false);
    }
  }, [content, isPublic, onSend, readyIds, sending, uploading]);

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
          {t('ticketComposer.reply')}
        </button>
        <button
          type="button"
          onClick={() => setMode('internal')}
          aria-selected={!isPublic}
          data-testid="ticket-composer-tab-internal"
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium', !isPublic ? 'bg-warning/20 text-warning' : 'text-muted-foreground hover:text-foreground')}
        >
          {t('ticketComposer.internalNote')}
        </button>
        {!isPublic && (
          <span className="ml-2 text-xs font-medium text-warning" data-testid="ticket-composer-internal-banner">
            {t('ticketComposer.internalBanner')}
          </span>
        )}
        {onUploadAttachment && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={TICKET_ATTACHMENT_LIMITS.allowedMimes.join(',')}
              className="hidden"
              data-testid="ticket-composer-file-input"
              onChange={(e) => addFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || sending || chips.length >= TICKET_ATTACHMENT_LIMITS.maxPerComment}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              data-testid="ticket-composer-attach"
            >
              {t('ticketComposer.attachments.attach')}
            </button>
          </>
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
          placeholder={
            isPublic
              ? t('ticketComposer.replyPlaceholder', { requester: requesterName ?? t('ticketComposer.requesterFallback') })
              : t('ticketComposer.internalPlaceholder')
          }
          rows={3}
          disabled={disabled || sending}
          data-testid="ticket-composer-input"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
        />
        {chips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2" data-testid="ticket-composer-chips">
            {chips.map((chip) => (
              <span
                key={chip.key}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs',
                  chip.status === 'error' && 'border-destructive/40 text-destructive'
                )}
                data-testid={`ticket-composer-chip-${chip.file.name}`}
              >
                <span>{chip.file.name}</span>
                {chip.status === 'uploading' && (
                  <span className="text-muted-foreground" data-testid={`ticket-composer-chip-uploading-${chip.file.name}`}>
                    {t('ticketComposer.attachments.uploading')}
                  </span>
                )}
                {chip.status === 'error' && (
                  <button
                    type="button"
                    onClick={() => {
                      setChips((cs) => cs.map((c) => (c.key === chip.key ? { ...c, status: 'uploading' } : c)));
                      void startUpload(chip);
                    }}
                    className="font-medium underline"
                    data-testid={`ticket-composer-chip-retry-${chip.file.name}`}
                  >
                    {t('ticketComposer.attachments.retry')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setChips((cs) => cs.filter((c) => c.key !== chip.key))}
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t('ticketComposer.attachments.remove')}
                  data-testid={`ticket-composer-chip-remove-${chip.file.name}`}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void send()}
            disabled={(!content.trim() && readyIds.length === 0) || sending || uploading || disabled}
            data-testid="ticket-composer-send"
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              isPublic ? 'bg-primary hover:bg-primary/90' : 'bg-warning hover:bg-warning/90 text-warning-foreground'
            )}
          >
            {sending ? t('ticketComposer.sending') : isPublic ? t('ticketComposer.sendReply') : t('ticketComposer.addInternalNote')}
          </button>
        </div>
      </div>
    </div>
  );
}
