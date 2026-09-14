import { useTranslation } from 'react-i18next';
import type {
  AiAgentRunIntentSummaryDto,
  AiAgentRunTicketProposalDto,
  TicketTriageSkip,
} from '@breeze/shared';

/** Local copy of RunDetailPage.tsx's `intentStatusLabel` — that function has
 *  a second call site there (the run's own "Linked approvals" section) so it
 *  stays defined there too; duplicating this small literal-switch label
 *  lookup here avoids a circular import (RunDetailPage -> this card -> back
 *  into RunDetailPage) for a few lines of code. */
function intentStatusLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case 'pending_approval':
      return t('aiAgentsPage.runs.statuses.awaiting_approval');
    case 'approved':
      return t('aiAgentsRuns.detail.ledger.statuses.approved');
    case 'executing':
      return t('aiAgentsRuns.detail.ledger.statuses.executing');
    case 'completed':
      return t('aiAgentsRuns.detail.ledger.statuses.completed');
    case 'failed':
      return t('aiAgentsRuns.detail.ledger.statuses.failed');
    case 'rejected':
      return t('aiAgentsRuns.detail.ledger.statuses.rejected');
    case 'expired':
      return t('aiAgentsPage.runs.statuses.expired');
    case 'cancelled':
      return t('aiAgentsPage.runs.statuses.cancelled');
    default:
      return value;
  }
}

/** Issue #4462 — literal switch (not a dynamic key) so the i18n key-usage
 *  scanner can see every key. */
function draftKindLabel(t: (key: string) => string, kind: 'reply' | 'resolution_note'): string {
  return kind === 'reply'
    ? t('aiAgentsPage.runs.triage.draftKinds.reply')
    : t('aiAgentsPage.runs.triage.draftKinds.resolutionNote');
}

/** Same literal-switch convention as `draftKindLabel` above. */
function skipItemLabel(t: (key: string) => string, item: TicketTriageSkip['item']): string {
  switch (item) {
    case 'fields': return t('aiAgentsPage.runs.triage.skipped.item.fields');
    case 'link': return t('aiAgentsPage.runs.triage.skipped.item.link');
    case 'note': return t('aiAgentsPage.runs.triage.skipped.item.note');
    case 'draft-reply': return t('aiAgentsPage.runs.triage.skipped.item.draftReply');
    case 'draft-resolution': return t('aiAgentsPage.runs.triage.skipped.item.draftResolution');
    default: return item;
  }
}

/** Same literal-switch convention as `skipItemLabel` just above. */
function skipReasonLabel(t: (key: string) => string, reason: TicketTriageSkip['reason']): string {
  switch (reason) {
    case 'no_fields_proposed': return t('aiAgentsPage.runs.triage.skipped.reason.noFieldsProposed');
    case 'below_confidence_floor': return t('aiAgentsPage.runs.triage.skipped.reason.belowConfidenceFloor');
    case 'human_set': return t('aiAgentsPage.runs.triage.skipped.reason.humanSet');
    case 'no_device_proposed': return t('aiAgentsPage.runs.triage.skipped.reason.noDeviceProposed');
    case 'device_already_linked': return t('aiAgentsPage.runs.triage.skipped.reason.deviceAlreadyLinked');
    case 'no_draft_reply': return t('aiAgentsPage.runs.triage.skipped.reason.noDraftReply');
    case 'no_draft_resolution': return t('aiAgentsPage.runs.triage.skipped.reason.noDraftResolution');
    case 'resolution_note_exists': return t('aiAgentsPage.runs.triage.skipped.reason.resolutionNoteExists');
    case 'max_actions_per_run': return t('aiAgentsPage.runs.triage.skipped.reason.maxActionsPerRun');
    case 'intent_error': return t('aiAgentsPage.runs.triage.skipped.reason.intentError');
    case 'ticket_not_found': return t('aiAgentsPage.runs.triage.skipped.reason.ticketNotFound');
    default: return reason;
  }
}

/**
 * P2-4 (#4191, Task 12) — a `triage`-profile run's ticket proposal
 * (`AiAgentRunTicketProposalDto`). Same safe-projection posture as the sweep
 * and narrative sections in RunDetailPage.tsx: every field on this DTO is
 * already display-safe by construction (`mapTicketProposal`, runTrace.ts —
 * named-field projection, no raw tool payload).
 *
 * `intentIds` only names ids; the STATUS shown for each comes from the run's
 * own `intents` array (already fetched for the "Linked approvals" section)
 * rather than being duplicated onto the proposal DTO — a live cross-reference
 * by id, falling back to the bare id if the run's intents projection ever
 * disagrees with it (defensive only; in practice `intentIds` is populated
 * FROM the same `action_intents` rows).
 *
 * UI critique finding #6: `fields.categoryId.value` is a raw internal
 * category UUID — the DTO carries no resolved category name anywhere
 * (`TicketTriageProposal` in packages/shared/src/types/ticketTriage.ts only
 * ever ships `{ value, confidence }`). Rather than leak that id to the user,
 * it is hidden; only the confidence is shown, with a note that the name
 * could not be resolved on this surface.
 *
 * #4211 (W01) — extracted out of RunDetailPage.tsx (was `TicketProposalSection`,
 * a private local function) so the ticket-detail surface (TicketWorkbench.tsx)
 * and the run-detail surface can share ONE rendering of this DTO and cannot
 * drift. Every existing `data-testid` is kept VERBATIM so RunDetailPage.test.tsx
 * passes unmodified. The new `onPostNote` prop is optional and renders a
 * "Post as private note" button ONLY when supplied — the run-detail page never
 * passes it, so it never renders there.
 */
export function TicketProposalCard({
  proposal,
  intents = [],
  t,
  onPostNote,
  posting,
}: {
  proposal: AiAgentRunTicketProposalDto;
  intents?: AiAgentRunIntentSummaryDto[];
  t: (key: string, opts?: Record<string, unknown>) => string;
  onPostNote?: (content: string) => void | Promise<void>;
  posting?: boolean;
}) {
  // `t` above is always the CALLER's bound instance (RunDetailPage.tsx via
  // useTranslation('settings'), TicketWorkbench.tsx via the default 'tickets'
  // namespace) — this component never uses its own. The call exists solely so
  // the keyUsage i18n scanner (src/lib/i18n/keyUsage.test.ts), which infers a
  // file's default namespace list from any useTranslation() call anywhere in
  // it regardless of which local binding it targets, resolves the keys below
  // against BOTH namespaces they actually ship in: 'settings' for the
  // aiAgentsPage.*/aiAgentsRuns.* triage keys, 'tickets' for
  // ticketWorkbench.aiProposal.*.
  useTranslation(['settings', 'tickets']);
  const intentsById = new Map(intents.map((intent) => [intent.id, intent]));
  const hasFields = proposal.fields && (proposal.fields.categoryId || proposal.fields.priority);
  const hasDevice = proposal.device && (proposal.device.hostname || proposal.device.serial);

  return (
    <section data-testid="ai-agent-run-triage" className="rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{t('aiAgentsPage.runs.triage.title')}</h2>

      <p className="mt-2 text-sm" data-testid="ai-agent-run-triage-summary">
        {proposal.summary}
      </p>

      {onPostNote && (
        <button
          type="button"
          data-testid="ai-agent-run-triage-post-note"
          className="mt-2 rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50"
          disabled={posting}
          onClick={() => { void onPostNote(proposal.summary); }}
        >
          {t('ticketWorkbench.aiProposal.postAsNote')}
        </button>
      )}

      {hasFields && (
        <div className="mt-3 space-y-1" data-testid="ai-agent-run-triage-fields">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.fieldsTitle')}
          </h3>
          <ul className="space-y-1 text-sm">
            {proposal.fields?.categoryId && (
              <li data-testid="ai-agent-run-triage-field-categoryId">
                <span className="font-medium">{t('aiAgentsRuns.detail.triage.categoryLabel')}</span>
                {': '}
                <span className="text-muted-foreground">{t('aiAgentsRuns.detail.triage.categoryUnresolved')}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {t('aiAgentsPage.runs.triage.confidence', {
                    value: Math.round(proposal.fields.categoryId.confidence * 100),
                  })}
                </span>
              </li>
            )}
            {proposal.fields?.priority && (
              <li data-testid="ai-agent-run-triage-field-priority">
                <span className="font-medium">{t('aiAgentsPage.runs.triage.fields.priority')}</span>
                {': '}
                <span>{proposal.fields.priority.value}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  {t('aiAgentsPage.runs.triage.confidence', {
                    value: Math.round(proposal.fields.priority.confidence * 100),
                  })}
                </span>
              </li>
            )}
          </ul>
        </div>
      )}

      {hasDevice && (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="ai-agent-run-triage-device">
          {t('aiAgentsPage.runs.triage.device', {
            value: [proposal.device?.hostname, proposal.device?.serial].filter(Boolean).join(' / '),
          })}
        </p>
      )}

      {proposal.draftReply && (
        <div className="mt-3" data-testid="ai-agent-run-triage-draft-reply">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.draftReplyTitle')}
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{proposal.draftReply}</p>
        </div>
      )}

      {proposal.draftResolutionNote && (
        <div className="mt-3" data-testid="ai-agent-run-triage-draft-resolution">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.draftResolutionTitle')}
          </h3>
          <p className="mt-1 whitespace-pre-wrap text-sm">{proposal.draftResolutionNote}</p>
        </div>
      )}

      {proposal.notes && proposal.notes.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-notes">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.notesTitle')}
          </h3>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {proposal.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      {proposal.intentIds && proposal.intentIds.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-intents">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.intentsTitle')}
          </h3>
          <ul className="mt-1 space-y-1 text-sm">
            {proposal.intentIds.map((intentId) => {
              const intent = intentsById.get(intentId);
              return (
                <li
                  key={intentId}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`ai-agent-run-triage-intent-${intentId}`}
                >
                  <span className="font-medium">{intent?.actionName ?? intentId}</span>
                  <span className="text-xs text-muted-foreground">
                    {intent ? intentStatusLabel(t, intent.status) : t('aiAgentsPage.runs.triage.intentUnknown')}
                  </span>
                </li>
              );
            })}
          </ul>
          {/* #4468: every intentId above resolves to the SAME /approvals
              inbox — a link repeated once per row added nothing over a
              single link for the whole batchable set, and read as N
              separate destinations rather than one. */}
          <a
            href="/approvals"
            data-testid="ai-agent-run-triage-intents-approvals-link"
            className="mt-1 inline-block text-primary hover:underline"
          >
            {t('aiAgentsPage.runs.detail.intents.viewAll')}
          </a>
        </div>
      )}

      {proposal.draftsWritten && proposal.draftsWritten.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-drafts-written">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.draftsWrittenTitle')}
          </h3>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {proposal.draftsWritten.map((draft) => (
              <li key={draft.draftId} data-testid={`ai-agent-run-triage-draft-${draft.draftId}`}>
                {draftKindLabel(t, draft.kind)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposal.skipped && proposal.skipped.length > 0 && (
        <div className="mt-3" data-testid="ai-agent-run-triage-skipped">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('aiAgentsPage.runs.triage.skippedTitle')}
          </h3>
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {proposal.skipped.map((skip, index) => (
              <li
                key={`${skip.item}-${index}`}
                data-testid={`ai-agent-run-triage-skipped-${skip.item}`}
              >
                <span className="font-medium text-foreground">{skipItemLabel(t, skip.item)}</span>
                {': '}
                {skipReasonLabel(t, skip.reason)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
