import { useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import type { TicketAttachmentMeta } from './ticketConfig';

/**
 * Ticket comment attachments in the web feed (W08 #3902).
 *
 * Bytes are served ONLY from the authenticated API route — there is no public
 * or presigned URL — and `<img src>` cannot carry a Bearer token, so an image
 * thumbnail is fetched through `fetchWithAuth`, turned into an object URL and
 * revoked when the component unmounts. PDFs render as a chip and are fetched
 * only when the viewer actually opens them, so a feed full of documents costs
 * nothing.
 *
 * A failed fetch renders a VISIBLE broken-attachment placeholder rather than an
 * empty box — a silent hide is indistinguishable from "there was no attachment".
 */

const KB = 1024;

function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

function contentUrl(ticketId: string, attachmentId: string): string {
  return `/tickets/${ticketId}/attachments/${attachmentId}/content`;
}

function AttachmentThumb({ ticketId, meta }: { ticketId: string; meta: TicketAttachmentMeta }) {
  const { t } = useTranslation('tickets');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;

    (async () => {
      try {
        const res = await fetchWithAuth(contentUrl(ticketId, meta.id));
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [ticketId, meta.id]);

  if (failed) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
        data-testid={`ticket-attachment-error-${meta.id}`}
      >
        {t('ticketFeed.attachments.broken', { name: meta.originalFilename })}
      </span>
    );
  }

  if (!objectUrl) {
    return (
      <span
        className="inline-block h-20 w-20 animate-pulse rounded-md bg-muted"
        data-testid={`ticket-attachment-loading-${meta.id}`}
      />
    );
  }

  return (
    <a href={objectUrl} target="_blank" rel="noreferrer" data-testid={`ticket-attachment-open-${meta.id}`}>
      <img
        src={objectUrl}
        alt={meta.originalFilename}
        title={meta.originalFilename}
        className="h-20 w-20 rounded-md border object-cover"
        data-testid={`ticket-attachment-thumb-${meta.id}`}
      />
    </a>
  );
}

function AttachmentFileChip({ ticketId, meta }: { ticketId: string; meta: TicketAttachmentMeta }) {
  const { t } = useTranslation('tickets');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Fetched on demand: the chip already shows everything the feed needs, so a
  // ticket with twenty PDFs downloads none of them until one is clicked.
  const open = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetchWithAuth(contentUrl(ticketId, meta.id));
      if (!res.ok) throw new Error(`status ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // The new tab holds its own reference; release ours on the next tick.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
        data-testid={`ticket-attachment-error-${meta.id}`}
      >
        {t('ticketFeed.attachments.broken', { name: meta.originalFilename })}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={open}
      disabled={busy}
      className="inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-60"
      data-testid={`ticket-attachment-file-${meta.id}`}
      title={t('ticketFeed.attachments.open')}
    >
      <span className="font-medium">{meta.originalFilename}</span>
      <span className="text-muted-foreground">{formatSize(meta.byteSize)}</span>
    </button>
  );
}

export function TicketAttachmentList({
  ticketId,
  commentId,
  attachments,
  canDelete,
  onDelete,
}: {
  ticketId: string;
  /** The owning comment. Keys the container test id so a ticket with photos on
   *  two comments does not emit the same `data-testid` twice — the e2e
   *  convention selects by test id only, and a duplicate makes the strip
   *  unaddressable (W08A review). Falls back to the ticket id. */
  commentId?: string;
  attachments: TicketAttachmentMeta[];
  canDelete?: boolean;
  onDelete?: (attachmentId: string) => void;
}) {
  const { t } = useTranslation('tickets');
  // No empty container: a comment without attachments must render EXACTLY as
  // it did before this feature, with no layout shift.
  if (attachments.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid={`ticket-attachments-${commentId ?? ticketId}`}>
      {attachments.map((meta) => (
        <span key={meta.id} className="inline-flex items-center gap-1">
          {meta.contentType.startsWith('image/')
            ? <AttachmentThumb ticketId={ticketId} meta={meta} />
            : <AttachmentFileChip ticketId={ticketId} meta={meta} />}
          {canDelete && onDelete && (
            <button
              type="button"
              onClick={() => onDelete(meta.id)}
              className="text-xs text-muted-foreground hover:text-destructive"
              data-testid={`ticket-attachment-delete-${meta.id}`}
              aria-label={t('ticketFeed.attachments.remove')}
            >
              &times;
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

export default TicketAttachmentList;
