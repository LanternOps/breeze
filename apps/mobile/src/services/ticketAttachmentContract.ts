/**
 * The client's mirror of the server's ticket-attachment contract: limits,
 * shapes, error codes and the user-facing copy for each.
 *
 * **This module imports nothing native, and must stay that way.** Its sibling
 * `ticketAttachments.ts` pulls in `expo-image-picker`, `expo-file-system` and
 * friends, which transitively load `react-native/index.js` — Flow-typed source
 * that Vitest cannot parse. `apps/mobile/vitest.config.ts` therefore restricts
 * the suite to `.ts` and warns that component imports must never drag RN into
 * the runner. Splitting the pure half out is what lets composer and feed logic
 * be tested without mocking six Expo modules to reach a constant.
 *
 * Limits are duplicated from `packages/shared/src/constants/ticketAttachments.ts`
 * rather than imported, because `apps/mobile` has no `@breeze/shared`
 * dependency and Metro resolves no workspace packages here —
 * `services/tickets.ts` mirrors `TICKET_STATUS_TRANSITIONS` the same way. The
 * server re-validates every value, so this copy is a UX shortcut (fail before
 * spending the upload), never the enforcement point.
 */

export const TICKET_ATTACHMENT_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPerComment: 5,
  maxPendingPerUser: 20,
  allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
} as const;

/** Long-edge cap applied before upload. 2048 keeps a phone photo legible on a
 *  desktop ticket view while cutting a 4032px capture to roughly a tenth. */
export const MAX_IMAGE_EDGE = 2048;

/** Uploads get their own deadline: 15s (the app default) loses a 10 MB photo on cellular. */
export const ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000;

/** Mirrors `TicketAttachmentMeta` in `packages/shared/src/types/tickets.ts`. */
export interface TicketAttachmentMeta {
  id: string;
  /** `null` while the row is pending — i.e. uploaded but not yet claimed by a comment. */
  commentId: string | null;
  contentType: string;
  byteSize: number;
  originalFilename: string;
  createdAt: string;
}

/** A file chosen on the device, normalised across the three pickers. */
export interface PickedAttachment {
  uri: string;
  name: string;
  mimeType: string;
  /** Bytes, or null when the picker did not report a size. */
  size: number | null;
  /** Pixel dimensions when known; null for PDFs. Used to pick the long edge. */
  width: number | null;
  height: number | null;
}

export type PickOutcome =
  | { ok: true; files: PickedAttachment[] }
  /**
   * `failed` is distinct from `cancelled`: a native picker can throw for
   * reasons this union does not otherwise model (a picker already open, an
   * iCloud file that will not download, an unlinked module). Callers dispatch
   * pickers with `void`, so a rejection would be an unhandled promise — the
   * technician taps a button and nothing at all happens, in either direction.
   */
  | { ok: false; reason: 'cancelled' | 'permission-denied' }
  | { ok: false; reason: 'failed'; message: string };

export type AttachmentErrorCode =
  | 'ATTACHMENT_TOO_LARGE'
  | 'UNSUPPORTED_ATTACHMENT_TYPE'
  | 'TOO_MANY_PENDING'
  | 'TICKET_DELETED'
  | 'TICKET_NOT_FOUND'
  | 'STORAGE_UNAVAILABLE'
  | 'ATTACHMENT_NOT_CLAIMABLE'
  | 'INVALID_MULTIPART'
  | 'EMPTY_ATTACHMENT'
  | 'SHARING_UNAVAILABLE'
  | 'ORG_CONTEXT_REQUIRED'
  | 'UPLOAD_FAILED';

/**
 * A failed attachment operation, carrying a message written for a technician
 * rather than the server's own string.
 *
 * `retryable` drives whether the chip offers Retry. Getting this wrong in
 * either direction is bad: offering Retry on a 415 invites an action that can
 * never succeed, and hiding it on a 503 loses a photo to a transient outage.
 */
export class AttachmentUploadError extends Error {
  readonly name = 'AttachmentUploadError';

  constructor(
    readonly code: AttachmentErrorCode,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
  }
}

const ERROR_COPY: Record<AttachmentErrorCode, { message: string; retryable: boolean }> = {
  ATTACHMENT_TOO_LARGE: { message: 'That file is over the 10 MB limit.', retryable: false },
  UNSUPPORTED_ATTACHMENT_TYPE: {
    message: 'Only JPEG, PNG, WebP images and PDFs can be attached.',
    retryable: false,
  },
  TOO_MANY_PENDING: {
    message: 'Too many attachments are waiting to be posted. Send or remove some first.',
    retryable: false,
  },
  TICKET_DELETED: { message: 'This ticket was deleted, so files cannot be attached.', retryable: false },
  TICKET_NOT_FOUND: { message: 'This ticket is no longer available.', retryable: false },
  STORAGE_UNAVAILABLE: {
    message: 'Attachment storage is unavailable right now. Try again shortly.',
    retryable: true,
  },
  ATTACHMENT_NOT_CLAIMABLE: {
    message: 'One or more attachments could not be posted with this comment.',
    retryable: false,
  },
  INVALID_MULTIPART: { message: 'That file could not be read. Pick it again.', retryable: false },
  EMPTY_ATTACHMENT: { message: 'That file is empty.', retryable: false },
  SHARING_UNAVAILABLE: { message: 'This device cannot open that file.', retryable: false },
  ORG_CONTEXT_REQUIRED: {
    message: 'Your sign-in has no organisation selected. Sign out and back in.',
    retryable: false,
  },
  UPLOAD_FAILED: { message: 'Upload failed. Check your connection and try again.', retryable: true },
};

export function attachmentError(code: AttachmentErrorCode): AttachmentUploadError {
  const copy = ERROR_COPY[code];
  return new AttachmentUploadError(code, copy.message, copy.retryable);
}

/**
 * HTTP status → code, for responses that never reached our own error handler.
 *
 * A reverse proxy rejects an oversized body before the API sees it, and answers
 * with its own HTML — `requestWithPrefix` parses no `code` from that, but it
 * always records `statusCode`. Without this fallback a proxy-level 413 reads as
 * a generic retryable "check your connection", so the technician retries a file
 * that can never succeed and is pointed at the wrong cause.
 */
const STATUS_FALLBACK: Record<number, AttachmentErrorCode> = {
  413: 'ATTACHMENT_TOO_LARGE',
  415: 'UNSUPPORTED_ATTACHMENT_TYPE',
  429: 'TOO_MANY_PENDING',
  503: 'STORAGE_UNAVAILABLE',
};

/**
 * Translate whatever `coreRequest` threw into a typed, user-facing failure.
 *
 * Precedence is deliberate: an explicit body `code` wins over the status,
 * because the API is more specific than the transport (a 409 is either
 * `TICKET_DELETED` or `ATTACHMENT_NOT_CLAIMABLE`, and only the body says
 * which — which is why 409 is absent from `STATUS_FALLBACK`).
 *
 * Anything still unrecognised becomes `UPLOAD_FAILED` and stays RETRYABLE: we
 * cannot tell a new server-side rejection from a dropped connection, and
 * offering a retry that fails again is a much cheaper mistake than silently
 * dropping a photo the technician believes they attached.
 */
export function toAttachmentError(err: unknown): AttachmentUploadError {
  if (err instanceof AttachmentUploadError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code in ERROR_COPY) {
    return attachmentError(code as AttachmentErrorCode);
  }
  const statusCode = (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && STATUS_FALLBACK[statusCode]) {
    return attachmentError(STATUS_FALLBACK[statusCode]);
  }
  const rawMessage = (err as { message?: unknown } | null)?.message;
  const detail = typeof rawMessage === 'string' && rawMessage.trim() ? rawMessage.trim() : null;
  // The server ANSWERED — a 401/403/404 from the auth or route layer carries
  // no `code`, but it is a rejection, not a dropped link. Telling the
  // technician to "check your connection" sent them chasing Wi-Fi for a
  // permission problem, and hid the status we needed to diagnose it.
  // 408 is the one 4xx that IS transient (request timed out at the proxy).
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
    return new AttachmentUploadError(
      'UPLOAD_FAILED',
      `Upload rejected (HTTP ${statusCode}${detail ? `: ${detail}` : ''}).`,
      false,
    );
  }
  // Nothing came back at all: a dropped connection, a timeout, or a runtime
  // failure before the request was sent (an unreadable file URI, a picker
  // temp file the OS purged). Keep it retryable, but name the cause so a
  // support screenshot is worth something.
  const copy = ERROR_COPY.UPLOAD_FAILED;
  const message = detail && detail !== copy.message ? `${copy.message} (${detail})` : copy.message;
  return new AttachmentUploadError('UPLOAD_FAILED', message, copy.retryable);
}

export function isAllowedMime(mimeType: string): boolean {
  return (TICKET_ATTACHMENT_LIMITS.allowedMimes as readonly string[]).includes(mimeType);
}

/**
 * React Native's `FormData` accepts this shape as a file part and streams the
 * file off disk; the DOM typings know nothing about it, hence the cast at the
 * call site. Exported so a test can assert the shape without constructing a
 * FormData whose parts Node cannot introspect the same way.
 */
export interface AttachmentFilePart {
  uri: string;
  name: string;
  type: string;
}

export function attachmentFilePart(file: PickedAttachment): AttachmentFilePart {
  return { uri: file.uri, name: file.name, type: file.mimeType };
}
