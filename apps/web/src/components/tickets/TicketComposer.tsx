import { useState, useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { TICKET_ATTACHMENT_LIMITS, type TicketTemplateVars } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { showToast } from '../shared/Toast';
import {
  deleteTicketComposerDraft,
  getTicketComposerDraft,
  setTicketComposerDraft,
  type TicketComposerMode,
} from '@/lib/ticketComposerDrafts';
import { ActionError } from '../../lib/runAction';
import { mergedIntoTicketId, permanentAttachmentRejection } from './ticketAttachmentErrors';
import { navigateTo } from '@/lib/navigation';
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

// Unsent text per ticket lives in lib/ticketComposerDrafts, which auth.ts's
// logout() clears on every sign-out path.
type ComposerMode = TicketComposerMode;

interface Props {
  requesterName: string | null;
  /** Reply address on file. A public reply emails it (ticketNotifyWorker); with
   *  none, the reply is only saved to the ticket. Omit to hide the line. */
  requesterEmail?: string | null;
  /** Extra toolbar controls beside canned responses (the ticket's Ask AI). */
  toolbarExtra?: ReactNode;
  /** Keys the unsent-draft memory (the ticket id). Omit to keep no memory. */
  draftKey?: string;
  /** Hidden but mounted: the resolve/pending form takes the composer's place
   *  without losing what was typed. */
  hidden?: boolean;
  /** Log time beside Attach: the host opens the time entry. Omit to hide it. */
  onLogTime?: () => void;
  logTimeOpen?: boolean;
  /** Caps what is written (toolbar, box, footer) to the host's reading
   *  measure; the rule and the internal wash still run full width. */
  contentClassName?: string;
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
  /** The host asks for the composer (r / n): set this mode and focus the box.
   *  Acted on once per token. */
  focusRequest?: { mode: ComposerMode; token: number } | null;
}

export default function TicketComposer({ requesterName, requesterEmail, toolbarExtra, draftKey, hidden, onLogTime, logTimeOpen = false, contentClassName, onSend, onUploadAttachment, disabled, templates, templateVars, focusRequest }: Props) {
  const { t } = useTranslation('tickets');
  // Public reply is the default (UI brief); a restored draft keeps its own mode.
  const [mode, setMode] = useState<ComposerMode>(() => (draftKey ? getTicketComposerDraft(draftKey)?.mode : undefined) ?? 'reply');
  const [content, setContent] = useState(() => (draftKey ? getTicketComposerDraft(draftKey)?.content ?? '' : ''));
  const [sending, setSending] = useState(false);
  const [chips, setChips] = useState<AttachmentChip[]>([]);
  // #11710: attachment files cannot outlive the composer, but their names can.
  // A restored draft that had attachments says so, and Send waits until the
  // user re-attaches them or dismisses the notice.
  const [lostNames, setLostNames] = useState<string[]>(() => (draftKey ? getTicketComposerDraft(draftKey)?.attachmentNames ?? [] : []));
  const chipNames = chips.map((c) => c.file.name);
  const missingNames = lostNames.filter((n) => !chipNames.includes(n));
  const attachmentNames = [...new Set([...chipNames, ...missingNames])];
  const attachmentNamesKey = attachmentNames.join('\u0000');
  // Mirror the text, its mode and the attachment names into the per-ticket
  // memory; a box with neither text nor attachments forgets it.
  useEffect(() => {
    if (!draftKey) return;
    if (content || attachmentNames.length > 0) {
      setTicketComposerDraft(draftKey, { content, mode, ...(attachmentNames.length > 0 ? { attachmentNames } : {}) });
    } else deleteTicketComposerDraft(draftKey);
    // attachmentNames is covered by attachmentNamesKey
  }, [draftKey, content, mode, attachmentNamesKey]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modeRefs = useRef<Record<ComposerMode, HTMLButtonElement | null>>({ reply: null, internal: null });
  const isPublic = mode === 'reply';

  const handledFocusToken = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest || focusRequest.token === handledFocusToken.current) return;
    handledFocusToken.current = focusRequest.token;
    setMode(focusRequest.mode);
    textareaRef.current?.focus();
  }, [focusRequest]);

  // Radio-group keys: every arrow moves to the other mode and checks it
  // (two options, so it always wraps). The queue's window-level ArrowUp/Down
  // stands aside inside a radiogroup (useQueueKeyboard ARROW_OWNERS).
  const onModeKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = mode === 'reply' ? 'internal' : 'reply';
    setMode(next);
    modeRefs.current[next]?.focus();
  };
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
    } catch (err) {
      const rejection = err instanceof ActionError ? permanentAttachmentRejection(err.status, err.code) : null;
      if (rejection) {
        // The server refused the file itself, so a Retry could never succeed:
        // drop the chip and say why.
        setChips((cs) => cs.filter((c) => c.key !== chip.key));
        const name = chip.file.name;
        const survivorId = rejection === 'ticketMerged' && err instanceof ActionError ? mergedIntoTicketId(err.body) : null;
        const messages: Record<typeof rejection, string> = {
          type: t('ticketComposer.attachments.rejectedType', { name }),
          size: t('ticketComposer.attachments.tooLarge', { name }),
          empty: t('ticketComposer.attachments.rejectedEmpty', { name }),
          ticketDeleted: t('ticketComposer.attachments.rejectedTicketDeleted', { name }),
          ticketMerged: t('ticketComposer.attachments.rejectedTicketMerged', { name }),
          notFound: t('ticketComposer.attachments.rejectedNotFound', { name }),
          malformed: t('ticketComposer.attachments.rejectedMalformed', { name }),
        };
        showToast({
          type: 'error',
          message: messages[rejection],
          ...(survivorId
            ? { action: { label: t('ticketComposer.attachments.openMergedTicket'), onClick: () => void navigateTo(`/tickets/${survivorId}`) } }
            : {}),
        });
        return;
      }
      // Transient: the uploader already toasted through runAction; the chip is
      // the persistent, retryable record of the failure.
      setChips((cs) => cs.map((c) => (c.key === chip.key ? { ...c, status: 'error', id: undefined } : c)));
    }
  }, [onUploadAttachment, t]);

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
    if ((!content.trim() && readyIds.length === 0) || sending || uploading || missingNames.length > 0) return;
    setSending(true);
    try {
      await onSend(content.trim(), isPublic, readyIds);
      // Forget the sent text here, not through the mirror effect: if the
      // composer unmounted while the POST was in flight (j/k, the next-ticket
      // offer), that effect never runs again and the reply would come back as
      // an unsent draft. Only the text that was sent is forgotten.
      if (draftKey && getTicketComposerDraft(draftKey)?.content === content) deleteTicketComposerDraft(draftKey);
      // A chip still sitting in 'error' (a transient failure: network, 429, 5xx) never made
      // it into attachmentIds, so the comment above just posted WITHOUT it.
      // Keep that chip — clearing it here would silently discard the user's
      // file selection and leave the earlier upload-error toast as the only
      // trace that anything went wrong.
      const failedChips = chips.filter((c) => c.status === 'error');
      if (failedChips.length > 0) {
        showToast({
          type: 'warning',
          message: isPublic
            ? t('ticketComposer.attachments.sentWithoutAttachmentReply', { count: failedChips.length })
            : t('ticketComposer.attachments.sentWithoutAttachmentNote', { count: failedChips.length }),
        });
      }
      setContent('');
      setChips(failedChips);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch {
      // failure already surfaced via runAction toast; keep the draft AND the
      // chips — re-uploading five photos because the POST 500'd is punitive.
    } finally {
      setSending(false);
    }
  }, [chips, content, draftKey, isPublic, missingNames.length, onSend, readyIds, sending, t, uploading]);

  return (
    <div
      hidden={hidden}
      className={cn(
        'border-t',
        // Unmistakable internal wash. On it, grey --muted-foreground drops to
        // 4.2–4.4:1, so the wash re-points muted ink at the foreground (the
        // idle mode, Attach, Canned responses, upload chips).
        !isPublic && 'bg-warning/10 dark:bg-warning/15 [--muted-foreground:var(--foreground)_/_0.7]'
      )}
      data-testid="ticket-composer"
    >
      <div className={contentClassName} data-testid="ticket-composer-content">
      <div className="flex flex-wrap items-center gap-1 px-4 pt-2" data-testid="ticket-composer-toolbar">
        {/* The two modes set the visibility of the one message being written —
            a radio group, not tabs (there is no second panel). Attach stays
            outside: it is an action, not a mode. */}
        <div role="radiogroup" aria-label={t('ticketComposer.modeLabel')} className="flex items-center gap-1">
          <button
            ref={(el) => { modeRefs.current.reply = el; }}
            type="button"
            role="radio"
            aria-checked={isPublic}
            tabIndex={isPublic ? 0 : -1}
            onClick={() => setMode('reply')}
            onKeyDown={onModeKeyDown}
            data-testid="ticket-composer-tab-reply"
            className={cn('rounded-md px-2.5 py-1 text-xs font-medium', isPublic ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {t('ticketComposer.reply')}
          </button>
          <button
            ref={(el) => { modeRefs.current.internal = el; }}
            type="button"
            role="radio"
            aria-checked={!isPublic}
            tabIndex={isPublic ? -1 : 0}
            onClick={() => setMode('internal')}
            onKeyDown={onModeKeyDown}
            data-testid="ticket-composer-tab-internal"
            className={cn('rounded-md px-2.5 py-1 text-xs font-medium', !isPublic ? 'bg-warning/20 text-warning-ink' : 'text-muted-foreground hover:text-foreground')}
          >
            {t('ticketComposer.internalNote')}
          </button>
        </div>
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
        {onLogTime && (
          // Billing one click from the reply at every width (the Time & billing
          // section sits behind the Details tab below 1024px).
          <button
            type="button"
            onClick={onLogTime}
            aria-expanded={logTimeOpen}
            className={cn('rounded-md px-2 py-1 text-xs hover:text-foreground', logTimeOpen ? 'bg-muted text-foreground' : 'text-muted-foreground')}
            data-testid="ticket-composer-log-time"
          >
            {t('ticketTimeBilling.logTime')}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <CannedResponsePicker
            templates={templates ?? []}
            vars={templateVars ?? {}}
            onInsert={insertText}
            disabled={disabled || sending}
          />
          {toolbarExtra}
        </div>
      </div>
      <div className="px-4 py-3">
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
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm max-sm:h-16 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary"
        />
        {missingNames.length > 0 && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-ink"
            data-testid="ticket-composer-lost-attachments"
          >
            <p className="min-w-0 flex-1">
              {t('ticketComposer.attachments.notKept', { count: missingNames.length, names: missingNames.join(', ') })}
            </p>
            <button
              type="button"
              onClick={() => setLostNames([])}
              className="shrink-0 font-medium underline"
              data-testid="ticket-composer-lost-attachments-dismiss"
            >
              {t('ticketComposer.attachments.notKeptDismiss')}
            </button>
          </div>
        )}
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
        <div className="mt-2 flex items-center justify-end gap-3">
          {!isPublic && (
            // Who sees it, where the public reply names its recipient. Kept out
            // of the toolbar so the toolbar holds one row.
            <p className="mr-auto min-w-0 text-xs font-medium text-warning-ink" data-testid="ticket-composer-internal-banner">
              {t('ticketComposer.internalBanner')}
            </p>
          )}
          {isPublic && requesterEmail !== undefined && (
            // Says where a public reply goes before it goes there. Without an
            // address the notify worker sends nothing (ticketNotifyWorker
            // collectRequesterEmail returns [] with no submitterEmail).
            <p
              className="mr-auto min-w-0 truncate text-xs text-muted-foreground"
              data-testid="ticket-composer-recipient"
              data-recipient={requesterEmail ? 'email' : 'none'}
              title={requesterEmail ? undefined : t('ticketComposer.recipient.none')}
            >
              {requesterEmail
                ? t('ticketComposer.recipient.emails', {
                    recipient: requesterName && requesterName !== requesterEmail ? `${requesterName} <${requesterEmail}>` : requesterEmail,
                  })
                : t('ticketComposer.recipient.none')}
            </p>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={(!content.trim() && readyIds.length === 0) || sending || uploading || missingNames.length > 0 || disabled}
            data-testid="ticket-composer-send"
            className={cn(
              'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              isPublic ? 'bg-primary hover:bg-primary/90' : 'bg-warning hover:bg-warning/90 text-warning-foreground'
            )}
          >
            {sending ? t('ticketComposer.sending') : isPublic ? t('ticketComposer.sendReply') : t('ticketComposer.addInternalNote')}
          </button>
        </div>
      </div>
      </div>
    </div>
  );
}
