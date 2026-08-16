/**
 * Create-ticket form (Task 23): org (prefilled from context, editable via
 * `orgOverride`), requester picker (portal-user candidates / "create contact"
 * with an EXPLICIT confirm checkbox / raw), and subject+description that are
 * usable IMMEDIATELY via a deterministic fallback (subject = email subject,
 * description = trimmed body quote, first 2000 chars).
 *
 * `fetchDraft` fires once the form opens (fire-and-forget from the form's
 * perspective — the fields are already editable). Per-field dirty tracking
 * means an AI result only overwrites a field the technician hasn't touched
 * yet; on any AI failure (4xx/5xx/timeout) the fallback just stays, silently.
 */
import { useEffect, useRef, useState } from 'react';
import {
  createTicketFromEmail,
  fetchDraft,
  TechApiError,
  type ContactCandidate,
  type EmailContextResponse,
  type FromEmailRequester,
  type FromEmailResponse,
} from './api';
import type { EmailIdentity } from './emailIdentity';

export interface CreateTicketFormProps {
  context: EmailContextResponse;
  identity: EmailIdentity;
  bodyText: string;
  /** A manual org pick from ContextCard's typeahead, overriding `context.org`. */
  orgOverride: { id: string; name: string } | null;
  onDone: (result: FromEmailResponse) => void;
  onBanner: (message: string | null) => void;
  onCancel?: () => void;
}

type RequesterMode = 'raw' | 'create_contact' | `candidate:${string}`;

function trimmedDescription(bodyText: string): string {
  return bodyText.trim().slice(0, 2000);
}

export function CreateTicketForm({
  context,
  identity,
  bodyText,
  orgOverride,
  onDone,
  onBanner,
  onCancel,
}: CreateTicketFormProps) {
  const org = orgOverride ?? context.org;
  const candidates = context.contacts.filter((c): c is ContactCandidate => c.kind === 'portal_user');

  const [subject, setSubject] = useState(identity.subject);
  const [description, setDescription] = useState(() => trimmedDescription(bodyText));
  const [subjectDirty, setSubjectDirty] = useState(false);
  const [descriptionDirty, setDescriptionDirty] = useState(false);
  const [aiApplied, setAiApplied] = useState(false);
  // Refs mirror the dirty flags so the fetchDraft effect (fired once, deps
  // [org?.id]) reads the CURRENT value at resolution time rather than the
  // value closed over when the effect ran — a technician can edit a field any
  // time before the AI response lands.
  const subjectDirtyRef = useRef(subjectDirty);
  subjectDirtyRef.current = subjectDirty;
  const descriptionDirtyRef = useRef(descriptionDirty);
  descriptionDirtyRef.current = descriptionDirty;

  const [requesterMode, setRequesterMode] = useState<RequesterMode>('raw');
  const [contactEmail, setContactEmail] = useState(identity.from?.email ?? '');
  const [contactName, setContactName] = useState(identity.from?.name ?? '');
  const [contactConfirmed, setContactConfirmed] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const draftRequestedRef = useRef(false);

  useEffect(() => {
    if (draftRequestedRef.current || !org) return;
    draftRequestedRef.current = true;
    fetchDraft({ orgId: org.id, subject: identity.subject, bodyText })
      .then((res) => {
        if (!subjectDirtyRef.current) setSubject(res.draft.subject);
        if (!descriptionDirtyRef.current) setDescription(res.draft.summary);
        setAiApplied(true);
      })
      .catch(() => {
        // 4xx/5xx/timeout — the deterministic fallback already filled the
        // fields; never block or surface an error for an AI-only failure.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per form open, by design
  }, [org?.id]);

  function requesterFromMode(): FromEmailRequester | null {
    if (requesterMode === 'raw') return { kind: 'raw' };
    if (requesterMode.startsWith('candidate:')) {
      const id = requesterMode.slice('candidate:'.length);
      return { kind: 'portal_user', id };
    }
    if (requesterMode === 'create_contact') {
      if (!contactConfirmed || !contactEmail.trim()) return null;
      return { kind: 'create_contact', email: contactEmail.trim(), name: contactName.trim() || undefined };
    }
    return null;
  }

  const requester = requesterFromMode();
  const canSubmit = Boolean(org && identity.from && subject.trim() && description.trim() && requester);

  async function handleSubmit(): Promise<void> {
    if (!org || !identity.from || !requester) return;
    setSubmitting(true);
    setSuccess(null);
    onBanner(null);
    try {
      const result = await createTicketFromEmail({
        orgId: org.id,
        subject: subject.trim(),
        description: description.trim(),
        from: identity.from,
        internetMessageId: identity.internetMessageId,
        requester,
        followUpOf: null,
      });
      setSuccess('Ticket created.');
      onDone(result);
    } catch (err) {
      onBanner(err instanceof TechApiError ? `Failed to create ticket (${err.code}).` : 'Failed to create ticket.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div data-testid="create-ticket-form" className="flex flex-col gap-3 rounded-md border border-gray-200 p-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-600">Organization</span>
        {org ? (
          <span data-testid="create-ticket-org" className="text-sm text-gray-900">
            {org.name}
          </span>
        ) : (
          <span data-testid="create-ticket-no-org" className="text-xs text-red-600">
            Select an organization above before creating a ticket.
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <label htmlFor="create-ticket-subject" className="text-xs font-medium text-gray-600">
            Subject
          </label>
          {aiApplied && !subjectDirty && (
            <span data-testid="ai-draft-badge-subject" className="text-[10px] font-semibold text-blue-600">
              AI draft
            </span>
          )}
        </div>
        <input
          id="create-ticket-subject"
          data-testid="create-ticket-subject"
          type="text"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            setSubjectDirty(true);
          }}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <label htmlFor="create-ticket-description" className="text-xs font-medium text-gray-600">
            Description
          </label>
          {aiApplied && !descriptionDirty && (
            <span data-testid="ai-draft-badge-description" className="text-[10px] font-semibold text-blue-600">
              AI draft
            </span>
          )}
        </div>
        <textarea
          id="create-ticket-description"
          data-testid="create-ticket-description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setDescriptionDirty(true);
          }}
          rows={4}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-600">Requester</span>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="radio"
            name="requester-mode"
            data-testid="requester-mode-raw"
            checked={requesterMode === 'raw'}
            onChange={() => setRequesterMode('raw')}
          />
          No portal record ({identity.from?.email ?? 'unknown sender'})
        </label>
        {candidates.map((c) => (
          <label key={c.id} className="flex items-center gap-1 text-xs">
            <input
              type="radio"
              name="requester-mode"
              data-testid={`requester-candidate-${c.id}`}
              checked={requesterMode === `candidate:${c.id}`}
              onChange={() => setRequesterMode(`candidate:${c.id}`)}
            />
            {c.name ?? c.email} ({c.email})
          </label>
        ))}
        <label className="flex items-center gap-1 text-xs">
          <input
            type="radio"
            name="requester-mode"
            data-testid="requester-mode-create-contact"
            checked={requesterMode === 'create_contact'}
            onChange={() => setRequesterMode('create_contact')}
          />
          Create a new contact
        </label>
        {requesterMode === 'create_contact' && (
          <div className="ml-4 flex flex-col gap-1">
            <input
              data-testid="create-contact-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="Email"
              className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            />
            <input
              data-testid="create-contact-name"
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Name (optional)"
              className="rounded-md border border-gray-300 px-2 py-1 text-xs"
            />
            <label className="flex items-center gap-1 text-xs text-amber-800">
              <input
                type="checkbox"
                data-testid="create-contact-confirm"
                checked={contactConfirmed}
                onChange={(e) => setContactConfirmed(e.target.checked)}
              />
              I confirm this creates a new contact record for {contactEmail || 'this address'}.
            </label>
          </div>
        )}
      </div>

      {success && (
        <div data-testid="action-success" className="text-xs text-green-700">
          {success}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="create-ticket-submit"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit || submitting}
          className="rounded-md border border-blue-300 bg-blue-50 px-2 py-1 text-sm hover:bg-blue-100 disabled:opacity-50"
        >
          Create ticket
        </button>
        {onCancel && (
          <button
            type="button"
            data-testid="create-ticket-cancel"
            onClick={onCancel}
            className="rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
