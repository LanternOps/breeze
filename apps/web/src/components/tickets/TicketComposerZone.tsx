import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { Sparkles, X } from 'lucide-react';
import type { TicketTemplateVars } from '@breeze/shared';
import type { CannedResponse } from '../../lib/ticketResponseTemplatesApi';
import type { TicketConfig } from '../../lib/ticketConfigApi';
import { TicketProposalCard } from '../aiAgents/TicketProposalCard';
import TicketComposer from './TicketComposer';
import TicketQuickTimeEntry from './TicketQuickTimeEntry';
import type { TicketDetail } from './ticketConfig';
import type { TicketAiAssist } from './useTicketAiAssist';
import { translatedPriorityLabel } from './ticketWorkbenchTypes';

export interface ResolveFormState {
  open: boolean;
  note: string;
  setNote: (note: string) => void;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  onCancel: () => void;
  onSubmit: () => void;
}

export interface PendingFormState {
  open: 'pending' | 'on_hold' | null;
  reason: string;
  setReason: (reason: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

interface Props {
  ticket: TicketDetail;
  merged: boolean;
  config: TicketConfig | null;
  categories: Array<{ id: string; name: string }>;
  ai: TicketAiAssist;
  resolve: ResolveFormState;
  pending: PendingFormState;
  checklistConfirm: (() => void) | null;
  checklistCounts: { done: number; total: number; known: boolean } | null;
  onChecklistConfirmCancel: () => void;
  onChecklistConfirmAccept: () => void;
  onSend: (content: string, isPublic: boolean, attachmentIds: string[]) => Promise<void>;
  onUploadAttachment: (file: File) => Promise<{ id: string }>;
  templates: CannedResponse[];
  templateVars: TicketTemplateVars;
  toolbarExtra?: ReactNode;
}

const PANEL = 'rounded-md border bg-muted/30 p-2';

/**
 * Everything that is about to be said or decided sits with the composer,
 * pinned under the thread: AI suggestions and drafts, the checklist nudge,
 * and the resolve / pending forms, which take the composer's place while open
 * (the composer stays mounted, so a half-written reply survives).
 */
export default function TicketComposerZone({
  ticket, merged, config, categories, ai, resolve, pending, checklistConfirm, checklistCounts,
  onChecklistConfirmCancel, onChecklistConfirmAccept, onSend, onUploadAttachment, templates, templateVars, toolbarExtra,
}: Props) {
  const { t } = useTranslation('tickets');
  const { triageSuggestion, triageLoading, applyingTriage, rejectingTriage, aiDrafts, draftContent, setDraftContent, sendingDraftId, discardingDraftId } = ai;
  const suggestedCategoryName = triageSuggestion?.categoryId
    ? (categories.find((category) => category.id === triageSuggestion.categoryId)?.name ?? triageSuggestion.categoryName ?? t('ticketWorkbench.triage.suggestedCategory'))
    : null;
  const triageReasons = triageSuggestion?.reasons.filter((reason) => reason.trim().length > 0) ?? [];
  const formOpen = !merged && (resolve.open || pending.open !== null);
  // Log time from the composer: the same entry as Time & billing, one click
  // from the reply at every width.
  const [logTimeOpen, setLogTimeOpen] = useState(false);
  useEffect(() => { setLogTimeOpen(false); }, [ticket.id]);

  const panels = !merged && (
    <>
      {(triageSuggestion || triageLoading) && (
        <div className={PANEL} data-testid="ticket-triage-suggestion">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {t('ticketWorkbench.triage.title')}
              </div>
              {triageLoading ? (
                <p className="mt-1 text-xs text-muted-foreground">{t('ticketWorkbench.triage.checking')}</p>
              ) : triageSuggestion ? (
                <>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    {triageSuggestion.priority && <span>{t('ticketWorkbench.triage.priority', { priority: translatedPriorityLabel(config, triageSuggestion.priority, t) })}</span>}
                    {suggestedCategoryName && <span>{t('ticketWorkbench.triage.category', { category: suggestedCategoryName })}</span>}
                    <span>{t('ticketWorkbench.triage.confidence', { percent: Math.round(triageSuggestion.confidence * 100) })}</span>
                  </div>
                  {triageReasons.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5" data-testid="ticket-triage-reasons">
                      {triageReasons.map((reason) => (
                        <span key={reason} className="rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground">
                          {reason}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </div>
            {triageSuggestion && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void ai.rejectTriageSuggestion()}
                  disabled={applyingTriage || rejectingTriage}
                  className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  data-testid="ticket-triage-reject"
                >
                  {rejectingTriage ? t('common:states.saving') : t('ticketWorkbench.triage.notRight')}
                </button>
                <button
                  type="button"
                  onClick={() => void ai.applyTriageSuggestion()}
                  disabled={applyingTriage || rejectingTriage}
                  className="inline-flex items-center justify-center rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  data-testid="ticket-triage-apply"
                >
                  {applyingTriage ? t('ticketWorkbench.triage.applying') : t('common:actions.apply')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {ai.aiProposal && (
        <TicketProposalCard proposal={ai.aiProposal.proposal} t={t} onPostNote={ai.postAiProposalNote} posting={ai.postingProposal} />
      )}
      {aiDrafts.map((draft) => (
        // At most one `reply` + one `resolution_note` draft can be active at
        // once (ticket_drafts_active_uq) — testids are keyed per kind (not per
        // draft id) so both cards are independently addressable.
        <div key={draft.id} className={PANEL} data-testid={`ticket-ai-draft-${draft.kind}`}>
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            {draft.kind === 'reply' ? t('ticketWorkbench.aiDraft.kindReply') : t('ticketWorkbench.aiDraft.kindResolutionNote')}
          </div>
          <textarea
            value={draftContent[draft.id] ?? draft.content}
            onChange={(e) => setDraftContent((prev) => ({ ...prev, [draft.id]: e.target.value }))}
            rows={3}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid={`ticket-ai-draft-${draft.kind}-content`}
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => void ai.discardAiDraft(draft)}
              disabled={sendingDraftId === draft.id || discardingDraftId === draft.id}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
              data-testid={`ticket-ai-draft-${draft.kind}-discard`}
            >
              {discardingDraftId === draft.id ? t('common:states.saving') : t('ticketWorkbench.aiDraft.discard')}
            </button>
            {draft.kind === 'reply' && (
              <button
                type="button"
                onClick={() => void ai.sendAiDraft(draft)}
                disabled={sendingDraftId === draft.id || discardingDraftId === draft.id || !(draftContent[draft.id] ?? draft.content).trim()}
                className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                data-testid={`ticket-ai-draft-${draft.kind}-send`}
              >
                {sendingDraftId === draft.id ? t('ticketWorkbench.aiDraft.sending') : t('ticketWorkbench.aiDraft.sendAsMe')}
              </button>
            )}
          </div>
        </div>
      ))}
      {checklistConfirm && checklistCounts && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-2" data-testid="ticket-checklist-resolve-confirm">
          <p className="text-xs font-medium">{t('checklists:resolveConfirm.title')}</p>
          <p className="mt-0.5 text-xs text-foreground/80">
            {checklistCounts.known
              ? t('checklists:resolveConfirm.body', {
                  count: checklistCounts.total - checklistCounts.done,
                  total: checklistCounts.total,
                })
              : /* The counts are unknown because the checklist failed to load —
                   say that rather than claiming "0 of 0 steps are unticked". */
                t('checklists:errors.loadFailed')}
          </p>
          <div className="mt-1.5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onChecklistConfirmCancel}
              className="rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
              data-testid="ticket-checklist-resolve-confirm-cancel"
            >
              {t('checklists:resolveConfirm.cancel')}
            </button>
            <button
              type="button"
              onClick={onChecklistConfirmAccept}
              className="rounded-md bg-warning px-2 py-1 text-xs font-medium text-warning-foreground"
              data-testid="ticket-checklist-resolve-confirm-accept"
            >
              {t('checklists:resolveConfirm.confirm')}
            </button>
          </div>
        </div>
      )}
      {logTimeOpen && (
        <section className="rounded-md border p-3" data-testid="ticket-log-time-panel" aria-labelledby="ticket-log-time-heading">
          <div className="mb-2 flex items-center justify-between">
            <h3 id="ticket-log-time-heading" className="text-xs font-medium">{t('ticketTimeBilling.logTime')}</h3>
            <button
              type="button"
              onClick={() => setLogTimeOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('common:actions.close')}
              data-testid="ticket-log-time-close"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <TicketQuickTimeEntry key={ticket.id} ticketId={ticket.id} testIdPrefix="ticket-log-time" onLogged={() => setLogTimeOpen(false)} />
        </section>
      )}
      {resolve.open && (
        <div className="rounded-md border p-3" data-testid="ticket-workbench-resolve-form">
          <label className="text-xs font-medium" htmlFor="resolve-note">{t('ticketWorkbench.resolve.noteLabel')}</label>
          <textarea
            ref={resolve.noteRef}
            id="resolve-note"
            value={resolve.note}
            onChange={(e) => resolve.setNote(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ticket-workbench-resolve-note"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button type="button" onClick={resolve.onCancel} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t('common:actions.cancel')}</button>
            <button
              type="button"
              onClick={resolve.onSubmit}
              disabled={!resolve.note.trim()}
              className="rounded-md bg-success px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              data-testid="ticket-workbench-resolve-submit"
            >
              {t('ticketWorkbench.resolve.submit')}
            </button>
          </div>
        </div>
      )}
      {pending.open && (
        <div className="rounded-md border p-3" data-testid="ticket-workbench-pending-form">
          <label className="text-xs font-medium" htmlFor="pending-reason">{t('ticketWorkbench.pending.reasonLabel')}</label>
          <textarea
            id="pending-reason"
            value={pending.reason}
            onChange={(e) => pending.setReason(e.target.value)}
            rows={2}
            maxLength={500}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            data-testid="ticket-workbench-pending-reason"
          />
          <div className="mt-1.5 flex justify-end gap-2">
            <button type="button" onClick={pending.onCancel} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">{t('common:actions.cancel')}</button>
            <button
              type="button"
              onClick={pending.onSubmit}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white"
              data-testid="ticket-workbench-pending-submit"
            >
              {pending.open === 'pending' ? t('ticketWorkbench.pending.setPending') : t('ticketWorkbench.pending.putOnHold')}
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    // Rules and the internal wash span the column; only what is written keeps
    // the thread's measure (the feed's right edge). On a phone the zone stays
    // pinned while the header scrolls away with the thread.
    <div className="shrink-0 bg-background max-sm:sticky max-sm:bottom-0 max-sm:z-10" data-testid="ticket-composer-zone">
      <div className="max-h-[45vh] overflow-y-auto border-t pb-1 pt-3 [&:has(>div:empty)]:hidden">
        <div className="max-w-[78ch] space-y-2 px-4" data-testid="ticket-composer-panels">{panels}</div>
      </div>
      {merged ? (
        <p className="border-t bg-muted/30 px-4 py-3 text-sm text-muted-foreground" data-testid="ticket-merged-readonly">
          {t('ticketWorkbench.mergedBanner.readOnly')}
        </p>
      ) : (
        <TicketComposer
            key={ticket.id}
            draftKey={ticket.id}
            hidden={formOpen}
            requesterName={ticket.submitterName}
            requesterEmail={ticket.submitterEmail ?? null}
            onSend={onSend}
            onUploadAttachment={onUploadAttachment}
            templates={templates}
            templateVars={templateVars}
            toolbarExtra={toolbarExtra}
            onLogTime={() => setLogTimeOpen((open) => !open)}
            logTimeOpen={logTimeOpen}
            contentClassName="max-w-[78ch]"
          />
      )}
    </div>
  );
}
