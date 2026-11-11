import { useCallback, useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { CallerVerificationEntry } from '../callerVerification/CallerVerificationEntry';
import { TicketVerificationBadge } from '../callerVerification/TicketVerificationBadge';
import OffboardPersonLauncher from '../aiOperator/OffboardPersonLauncher';
import OnboardPersonLauncher from '../aiOperator/OnboardPersonLauncher';
import type { TicketDetail } from './ticketConfig';
import type { UserOption } from './ticketWorkbenchTypes';

// Sentinel for the "type a requester manually" choice in the requester editor.
const MANUAL_REQUESTER = '__manual__';

interface Props {
  ticket: TicketDetail;
  merged: boolean;
  /** Deep-link the caller-verification modal (only where the page does not own the hash). */
  verificationHash?: string;
  callerRevision: number;
  onCallerChanged: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}

/** Who asked: name, reply address, caller verification and the person recipes. */
export default function TicketRequesterBlock({ ticket, merged, verificationHash, callerRevision, onCallerChanged, onSave }: Props) {
  const { t } = useTranslation('tickets');
  // Requester editor: picker options (portal users for the org) + edit state.
  const [requesters, setRequesters] = useState<UserOption[]>([]);
  const [editing, setEditing] = useState(false);
  const [reqSel, setReqSel] = useState('');
  const [reqName, setReqName] = useState('');
  const [reqEmail, setReqEmail] = useState('');

  // Requester options track the ticket's org (a portal user is org-scoped).
  // Failure degrades the editor to free-text only.
  useEffect(() => {
    const orgId = ticket.orgId;
    if (!orgId) return;
    let cancelled = false;
    void fetchWithAuth(`/tickets/requesters?orgId=${orgId}`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const rows = (body as { data?: UserOption[] }).data;
        if (Array.isArray(rows)) setRequesters(rows.filter((u) => u.id));
      })
      .catch(() => { /* free-text fallback */ });
    return () => { cancelled = true; };
  }, [ticket.orgId]);

  const openEditor = useCallback(() => {
    setReqSel(ticket.submittedBy ?? ((ticket.submitterName || ticket.submitterEmail) ? MANUAL_REQUESTER : ''));
    setReqName(ticket.submitterName ?? '');
    setReqEmail(ticket.submitterEmail ?? '');
    setEditing(true);
  }, [ticket]);

  const save = useCallback(() => {
    let patch: Record<string, unknown>;
    if (reqSel && reqSel !== MANUAL_REQUESTER) {
      // Picked a portal user — send its name/email too so the local optimistic
      // patch shows the new requester immediately (the API backfills the same).
      const opt = requesters.find((r) => r.id === reqSel);
      patch = { submittedBy: reqSel, submitterName: opt?.name ?? null, submitterEmail: opt?.email ?? null };
    } else if (reqSel === MANUAL_REQUESTER) {
      patch = { submittedBy: null, submitterName: reqName.trim() || null, submitterEmail: reqEmail.trim() || null };
    } else {
      patch = { submittedBy: null, submitterName: null, submitterEmail: null };
    }
    // Dirty check (#3258 W03). An emailed ticket has no portal login, so the
    // editor opens on "someone else" with the snapshot pre-filled — opening it
    // and saving without touching anything sent a full requester PATCH. That
    // is not a cosmetic no-op: the API treats a requester edit as a statement
    // about WHO the requester is, and the customer's own ticket disappeared
    // from their portal. Send nothing when nothing changed.
    const unchanged =
      patch.submittedBy === (ticket.submittedBy ?? null) &&
      patch.submitterName === (ticket.submitterName ?? null) &&
      patch.submitterEmail === (ticket.submitterEmail ?? null);
    if (!unchanged) onSave(patch);
    setEditing(false);
  }, [ticket, reqSel, reqName, reqEmail, requesters, onSave]);

  return (
    <section aria-labelledby="ticket-requester-heading">
      <h3 id="ticket-requester-heading" className="text-xs text-muted-foreground">{t('ticketWorkbench.requester.label')}</h3>
      {editing && !merged ? (
        <div className="mt-1 space-y-2">
          <select
            value={reqSel}
            onChange={(e) => setReqSel(e.target.value)}
            className="w-full rounded-md border bg-background px-2 py-1 text-xs"
            data-testid="ticket-workbench-requester-select"
            aria-label={t('ticketWorkbench.requester.label')}
          >
            <option value="">{t('common:states.unknown')}</option>
            {requesters.map((r) => (
              <option key={r.id} value={r.id}>{r.name ? `${r.name} (${r.email})` : r.email}</option>
            ))}
            <option value={MANUAL_REQUESTER}>{t('ticketWorkbench.requester.someoneElse')}</option>
          </select>
          {reqSel === MANUAL_REQUESTER && (
            <div className="space-y-1">
              <input
                value={reqName}
                onChange={(e) => setReqName(e.target.value)}
                maxLength={255}
                placeholder={t('common:labels.name')}
                aria-label={t('ticketWorkbench.requester.nameAria')}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                data-testid="ticket-workbench-requester-name"
              />
              <input
                type="email"
                value={reqEmail}
                onChange={(e) => setReqEmail(e.target.value)}
                maxLength={255}
                placeholder={t('ticketWorkbench.requester.emailPlaceholder')}
                aria-label={t('ticketWorkbench.requester.emailAria')}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs"
                data-testid="ticket-workbench-requester-email"
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md border px-2 py-0.5 text-xs hover:bg-muted"
              data-testid="ticket-workbench-requester-cancel"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-white"
              data-testid="ticket-workbench-requester-save"
            >
              {t('common:actions.save')}
            </button>
          </div>
        </div>
      ) : (
        <div className="group mt-0.5 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" data-testid="ticket-workbench-requester">
              {ticket.submitterName ?? ticket.submitterEmail ?? t('common:states.unknown')}
            </p>
            {ticket.submitterEmail && ticket.submitterName && (
              <a href={`mailto:${ticket.submitterEmail}`} className="block truncate text-xs text-muted-foreground hover:underline" data-testid="ticket-workbench-requester-email-link">
                {ticket.submitterEmail}
              </a>
            )}
            {!ticket.submitterEmail && (
              <p className="text-xs text-muted-foreground" data-testid="ticket-workbench-requester-no-email">{t('ticketFocus.requester.noEmail')}</p>
            )}
          </div>
          {!merged && <button
            type="button"
            onClick={openEditor}
            className="shrink-0 rounded px-1 text-xs text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
            data-testid="ticket-workbench-requester-edit"
          >
            {t('common:actions.edit')}
          </button>}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs empty:hidden">
        {ticket.requesterContactId && !merged && (
          // Both render nothing (and fetch nothing) unless the server's
          // caller-verification flag is on.
          <>
            <TicketVerificationBadge orgId={ticket.orgId} ticketId={ticket.id} revision={callerRevision} />
            <CallerVerificationEntry
              orgId={ticket.orgId}
              initialContactId={ticket.requesterContactId}
              lockContact
              ticketId={ticket.id}
              hash={verificationHash}
              onChanged={onCallerChanged}
            />
          </>
        )}
        {/* Renders nothing unless the Operator flag is on and the org can run offboarding. */}
        <OffboardPersonLauncher orgId={ticket.orgId} source="ticket" contactId={ticket.requesterContactId ?? null} personHint={ticket.submitterEmail ?? null} label={ticket.submitterName ?? ticket.submitterEmail ?? null} />
        {/* Same gate, onboarding recipe. The requester pre-fills the new hire's MANAGER, never the new hire. */}
        <OnboardPersonLauncher orgId={ticket.orgId} source="ticket" requesterContactId={ticket.requesterContactId ?? null} requesterLabel={ticket.submitterName ?? ticket.submitterEmail ?? null} />
      </div>
    </section>
  );
}
