import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';

/**
 * Add a run artifact to a ticket as an internal note
 * (execution-plane spec §6.3). Reference only — no bytes move, which is why a
 * 128 MiB analysis output can be attached at all.
 *
 * Every outcome is surfaced: `runAction` toasts both the success and the
 * non-401 failure, so an attach that silently did nothing is not a state this
 * control can reach (the `no-silent-mutations` guard covers this file).
 *
 * On failure the form stays OPEN with the ticket id intact. The most likely
 * failure is a mistyped or wrong-org ticket id, and closing the form would make
 * the technician retype it to find that out.
 */
export default function AttachArtifactToTicket({
  artifactId,
  artifactName,
}: {
  artifactId: string;
  artifactName: string;
}) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [ticketId, setTicketId] = useState('');
  const [busy, setBusy] = useState(false);
  // A failed comment can retry against the existing pending reference row
  // (from `/attachments/from-artifact`, below) without creating a duplicate —
  // nothing is uploaded here, it's a reference, not a copy.
  const pending = useRef(new Map<string, string>());

  const submit = async () => {
    const id = ticketId.trim();
    if (!id || busy) return;
    setBusy(true);
    try {
      let attachmentId = pending.current.get(id);
      if (!attachmentId) {
        attachmentId = await runAction<string>({
          request: () => fetchWithAuth(`/tickets/${id}/attachments/from-artifact`, {
            method: 'POST',
            body: JSON.stringify({ handle: artifactId }),
          }),
          parseSuccess: (data) => {
            const attachment = (data as { data?: { id?: unknown } } | null)?.data?.id;
            if (typeof attachment !== 'string' || !attachment) throw new Error('Missing attachment id');
            return attachment;
          },
          errorFallback: t('aiAgentsPage.runs.detail.artifacts.attachFailed'),
          onUnauthorized: handleSessionExpired,
        });
        pending.current.set(id, attachmentId);
      }
      await runAction({
        request: () =>
          fetchWithAuth(`/tickets/${id}/comments`, {
            method: 'POST',
            body: JSON.stringify({ content: '', isPublic: false, attachmentIds: [attachmentId] }),
          }),
        successMessage: t('aiAgentsPage.runs.detail.artifacts.attachedToTicket'),
        // The attachment reference already exists by this point (the call
        // above succeeded) — only the internal-note comment failed.
        // "attachFailed" would be a false claim here; it is reserved for the
        // reference-creation call.
        errorFallback: t('aiAgentsPage.runs.detail.artifacts.attachedButCommentFailed'),
        onUnauthorized: handleSessionExpired,
      });
      pending.current.delete(id);
      setOpen(false);
      setTicketId('');
    } catch (err) {
      // 401 is handled by the redirect above; any other ActionError has already
      // been toasted by runAction. Anything else is a programming fault and
      // should keep propagating.
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        data-testid={`attach-artifact-open-${artifactId}`}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 text-xs underline"
      >
        <Paperclip className="h-3 w-3" />
        {t('aiAgentsPage.runs.detail.artifacts.attachToTicket')}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        data-testid={`attach-artifact-ticket-${artifactId}`}
        value={ticketId}
        disabled={busy}
        onChange={(e) => setTicketId(e.target.value)}
        placeholder={t('aiAgentsPage.runs.detail.artifacts.ticketIdPlaceholder')}
        aria-label={t('aiAgentsPage.runs.detail.artifacts.ticketIdPlaceholder')}
        className="w-48 rounded border px-1.5 py-0.5 text-xs"
      />
      <button
        type="button"
        data-testid={`attach-artifact-submit-${artifactId}`}
        onClick={() => void submit()}
        disabled={busy}
        className="rounded border px-1.5 py-0.5 text-xs"
      >
        {t('aiAgentsPage.runs.detail.artifacts.attach', { name: artifactName })}
      </button>
    </span>
  );
}
