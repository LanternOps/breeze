import {
  TICKET_ATTACHMENT_LIMITS,
  type PickedAttachment,
  type TicketAttachmentMeta,
} from '../../services/ticketAttachmentContract';

/**
 * Composer attachment state, decided outside React.
 *
 * Same split as `timerActions.ts`/`timerOutcomeEffects.ts`: the screen owns
 * rendering and effects, this module owns the rules. That is not only taste —
 * `apps/mobile/vitest.config.ts` deliberately includes `.ts` and NOT `.tsx`
 * ("the mobile app has no React Native test runtime configured"), so logic left
 * inside a component is logic no test can reach.
 *
 * The load-bearing rule: an upload is ONLINE-ONLY and never queued. Nothing
 * here touches `timeEntryQueue.ts` (spec D13) — that queue protects billable
 * minutes, and replaying an upload later would re-send a local file URI the OS
 * may have reclaimed. A regression test asserts this module never names it.
 */

export type ChipStatus = 'uploading' | 'uploaded' | 'failed';

export interface AttachmentChip {
  /**
   * Stable local key, distinct from the server id. It exists before the upload
   * resolves and survives a retry, so React never remounts a row mid-flight.
   */
  localId: string;
  /** Kept even after a failure — this is what Retry re-sends. */
  file: PickedAttachment;
  status: ChipStatus;
  /** Server id once uploaded; only these may be claimed by the comment. */
  attachmentId: string | null;
  error: string | null;
  retryable: boolean;
}

export function chipFromPick(file: PickedAttachment, localId: string): AttachmentChip {
  return { localId, file, status: 'uploading', attachmentId: null, error: null, retryable: false };
}

export function remainingSlots(chips: readonly AttachmentChip[]): number {
  return Math.max(0, TICKET_ATTACHMENT_LIMITS.maxPerComment - chips.length);
}

/**
 * Append picks up to the per-comment cap.
 *
 * Overflow is reported rather than uploaded: the server would reject the sixth
 * file anyway, and spending a cellular upload to learn that is worse than
 * telling the technician up front. `selectionLimit` on the picker makes this
 * rare, but a camera shot and a library multi-select can still race past it.
 */
export function addPickedFiles(
  chips: readonly AttachmentChip[],
  files: readonly PickedAttachment[]
): { chips: AttachmentChip[]; rejected: number } {
  const room = remainingSlots(chips);
  const accepted = files.slice(0, room);
  const next = accepted.map((file, i) =>
    chipFromPick(file, `${Date.now()}-${chips.length + i}-${Math.random().toString(36).slice(2, 8)}`)
  );
  return { chips: [...chips, ...next], rejected: files.length - accepted.length };
}

function update(
  chips: readonly AttachmentChip[],
  localId: string,
  patch: (chip: AttachmentChip) => AttachmentChip
): AttachmentChip[] {
  // Identity is preserved for untouched chips so a re-render does not churn
  // every row when one upload resolves.
  return chips.map((chip) => (chip.localId === localId ? patch(chip) : chip));
}

export function markUploading(
  chips: readonly AttachmentChip[],
  localId: string
): AttachmentChip[] {
  return update(chips, localId, (chip) => ({
    ...chip, status: 'uploading', error: null, retryable: false,
  }));
}

export function markUploaded(
  chips: readonly AttachmentChip[],
  localId: string,
  attachmentId: string
): AttachmentChip[] {
  return update(chips, localId, (chip) => ({
    ...chip, status: 'uploaded', attachmentId, error: null, retryable: false,
  }));
}

export function markFailed(
  chips: readonly AttachmentChip[],
  localId: string,
  error: string,
  retryable: boolean
): AttachmentChip[] {
  return update(chips, localId, (chip) => ({ ...chip, status: 'failed', error, retryable }));
}

export function removeChip(
  chips: readonly AttachmentChip[],
  localId: string
): AttachmentChip[] {
  return chips.filter((chip) => chip.localId !== localId);
}

/** Only uploaded chips carry a server id, and only those may be claimed. */
export function claimableIds(chips: readonly AttachmentChip[]): string[] {
  return chips
    .filter((chip) => chip.status === 'uploaded' && chip.attachmentId !== null)
    .map((chip) => chip.attachmentId as string);
}

/**
 * Send is allowed when there is something to send and nothing is mid-flight.
 *
 * A FAILED chip does not block Send: it simply is not claimed. Blocking would
 * leave a technician with a dead upload and no way to post the comment at all —
 * they can remove the chip or retry it, but they are never trapped.
 */
export function canSend(input: {
  chips: readonly AttachmentChip[];
  text: string;
  busy: boolean;
}): boolean {
  if (input.busy) return false;
  if (input.chips.some((chip) => chip.status === 'uploading')) return false;
  return input.text.trim().length > 0 || claimableIds(input.chips).length > 0;
}

/**
 * "Sending 1 of 2…" rather than a byte-level progress bar (open question 7):
 * one file per request makes a file count honest and a percentage a guess.
 */
export function sendButtonLabel(input: {
  chips: readonly AttachmentChip[];
  busy: boolean;
}): string {
  const uploading = input.chips.filter((chip) => chip.status === 'uploading').length;
  if (uploading > 0) return `Sending ${uploading} of ${input.chips.length}…`;
  if (input.busy) return 'Working…';
  return 'Post comment';
}

/** Why the attach button is unavailable, or null when it is available. */
export function attachDisabledReason(input: {
  connected: boolean;
  chips: readonly AttachmentChip[];
}): string | null {
  // Offline first: it is the reason the technician can act on.
  if (!input.connected) return 'Attachments need a connection.';
  if (remainingSlots(input.chips) === 0) {
    return `Up to ${TICKET_ATTACHMENT_LIMITS.maxPerComment} files per comment.`;
  }
  return null;
}

/**
 * Split a comment's attachments for rendering: images go in a thumbnail grid,
 * everything else (PDFs) in named rows. A PDF has no thumbnail to show, and
 * rendering it as a broken tile reads as a failed image.
 */
export function groupCommentAttachments(
  attachments: readonly TicketAttachmentMeta[] | undefined
): { images: TicketAttachmentMeta[]; documents: TicketAttachmentMeta[] } {
  const images: TicketAttachmentMeta[] = [];
  const documents: TicketAttachmentMeta[] = [];
  for (const attachment of attachments ?? []) {
    (attachment.contentType.startsWith('image/') ? images : documents).push(attachment);
  }
  return { images, documents };
}

/**
 * How a tapped attachment should be presented.
 *
 * Only images render inline. A PDF is downloaded and handed to the OS share
 * sheet instead (`openAttachmentExternally`) — React Native has no PDF view,
 * and the content route needs an `Authorization` header, so handing a URL to
 * the system browser would 401.
 */
export function viewerMode(contentType: string): 'image' | 'external' {
  return contentType.startsWith('image/') ? 'image' : 'external';
}

/** Human byte size for a document row. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
