import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';

import { API_CORE_PREFIX, coreRequest, FALLBACK_API_BASE_URL, getAuthImageHeaders } from './api';
import { getServerUrl } from './serverConfig';

/**
 * Ticket comment attachments for mobile (W11 of #3206; server half is #4282).
 *
 * Upload is deliberately TWO steps, matching the web client: this module POSTs
 * one file at a time to `/tickets/:id/attachments`, which mints a *pending* row
 * (`commentId: null`); the existing JSON comment POST then carries
 * `attachmentIds[]` and claims those rows inside the comment transaction. A
 * pending row nobody claims is swept by the server's 24h reaper, so an
 * abandoned composer leaks nothing.
 *
 * Nothing here ever touches `timeEntryQueue.ts` (spec D13). That queue exists so
 * billable minutes survive a dead link; an attachment has no such claim on
 * correctness, and a queued upload would replay a file whose local URI the OS
 * may already have reclaimed. Uploads are online-only, and the composer says so.
 */

/**
 * Mirrors `TICKET_ATTACHMENT_LIMITS` in `packages/shared/src/constants/ticketAttachments.ts`.
 *
 * Duplicated rather than imported because `apps/mobile` does not depend on
 * `@breeze/shared` at all — the Metro bundler resolves no workspace packages
 * here, and `services/tickets.ts` already mirrors `TICKET_STATUS_TRANSITIONS`
 * the same way. The server re-validates all of it, so the copy is a UX
 * shortcut (fail before spending the upload), never the enforcement point.
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
  | { ok: false; reason: 'cancelled' | 'permission-denied' };

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
  UPLOAD_FAILED: { message: 'Upload failed. Check your connection and try again.', retryable: true },
};

function attachmentError(code: AttachmentErrorCode): AttachmentUploadError {
  const copy = ERROR_COPY[code];
  return new AttachmentUploadError(code, copy.message, copy.retryable);
}

/**
 * Translate whatever `coreRequest` threw into a typed, user-facing failure.
 *
 * An unrecognised code becomes `UPLOAD_FAILED` and stays RETRYABLE: we cannot
 * tell a new server-side rejection from a dropped connection, and offering a
 * retry that fails again is a much cheaper mistake than silently dropping a
 * photo the technician believes they attached.
 */
export function toAttachmentError(err: unknown): AttachmentUploadError {
  if (err instanceof AttachmentUploadError) return err;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code in ERROR_COPY) {
    return attachmentError(code as AttachmentErrorCode);
  }
  return attachmentError('UPLOAD_FAILED');
}

function isAllowedMime(mimeType: string): boolean {
  return (TICKET_ATTACHMENT_LIMITS.allowedMimes as readonly string[]).includes(mimeType);
}

/** Best-effort filename when a picker gives none — the server re-sanitises it anyway. */
function fallbackName(uri: string, mimeType: string): string {
  const fromUri = uri.split('/').pop()?.split('?')[0];
  if (fromUri) return fromUri;
  return mimeType === 'application/pdf' ? 'document.pdf' : 'photo.jpg';
}

function fromImageAsset(asset: ImagePicker.ImagePickerAsset): PickedAttachment {
  // `mimeType` is absent on some Android providers; the server sniffs magic
  // bytes and ignores what we claim (spec D4), so a guess here is safe.
  const mimeType = asset.mimeType ?? 'image/jpeg';
  return {
    uri: asset.uri,
    name: asset.fileName ?? fallbackName(asset.uri, mimeType),
    mimeType,
    size: asset.fileSize ?? null,
    width: asset.width || null,
    height: asset.height || null,
  };
}

export async function pickFromCamera(): Promise<PickOutcome> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) return { ok: false, reason: 'permission-denied' };

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    // D15: EXIF — and therefore the GPS fix of a customer's premises — never
    // leaves the phone. `prepareImage` re-encodes as a second line of defence.
    exif: false,
  });
  if (result.canceled || !result.assets?.length) return { ok: false, reason: 'cancelled' };
  return { ok: true, files: result.assets.map(fromImageAsset) };
}

/**
 * @param remainingSlots how many more files this comment may carry. Passed to
 * the OS picker as `selectionLimit` so the technician cannot select seven
 * photos and then be told two were dropped.
 */
export async function pickFromLibrary(remainingSlots: number): Promise<PickOutcome> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) return { ok: false, reason: 'permission-denied' };

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.8,
    exif: false,
    allowsMultipleSelection: true,
    selectionLimit: Math.max(1, remainingSlots),
  });
  if (result.canceled || !result.assets?.length) return { ok: false, reason: 'cancelled' };
  return { ok: true, files: result.assets.map(fromImageAsset) };
}

export async function pickDocument(): Promise<PickOutcome> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    // Without this the URI can be a content:// handle that expires before the
    // upload reads it.
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.length) return { ok: false, reason: 'cancelled' };

  return {
    ok: true,
    files: result.assets.map((asset) => ({
      uri: asset.uri,
      name: asset.name || fallbackName(asset.uri, 'application/pdf'),
      mimeType: asset.mimeType ?? 'application/pdf',
      size: asset.size ?? null,
      width: null,
      height: null,
    })),
  };
}

/**
 * Cap the long edge and re-encode to JPEG.
 *
 * The re-encode is NOT optional even when the image is already small enough:
 * writing a fresh JPEG through the manipulator is precisely what discards the
 * EXIF block (D15), so skipping it for a 800px photo would ship that photo's
 * GPS coordinates. Only the resize is conditional.
 *
 * PDFs pass through untouched — there is nothing to re-encode, and the
 * manipulator cannot read them.
 */
export async function prepareImage(file: PickedAttachment): Promise<PickedAttachment> {
  if (!file.mimeType.startsWith('image/')) return file;

  const context = ImageManipulator.manipulate(file.uri);
  const longEdge = Math.max(file.width ?? 0, file.height ?? 0);
  if (longEdge > MAX_IMAGE_EDGE) {
    // Constrain ONE dimension only — the manipulator preserves the aspect ratio
    // for the other. Passing both would distort a non-4:3 photo.
    const portrait = (file.height ?? 0) >= (file.width ?? 0);
    context.resize(portrait ? { height: MAX_IMAGE_EDGE } : { width: MAX_IMAGE_EDGE });
  }

  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });

  return {
    uri: saved.uri,
    name: file.name.replace(/\.[^./\\]*$/, '') + '.jpg',
    mimeType: 'image/jpeg',
    // The manipulator does not report a byte size. Null means "unknown", which
    // the client-side size gate treats as "let the server decide" rather than
    // silently passing a file that may still be over the cap.
    size: null,
    width: saved.width,
    height: saved.height,
  };
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

/**
 * Upload ONE file and return the pending attachment row.
 *
 * The size and type gates run before the request on purpose: a 12 MB photo on
 * cellular costs a minute of upload before the server can say 413, and the
 * answer is knowable here.
 */
export async function uploadTicketAttachment(
  ticketId: string,
  file: PickedAttachment
): Promise<TicketAttachmentMeta> {
  if (!isAllowedMime(file.mimeType)) throw attachmentError('UNSUPPORTED_ATTACHMENT_TYPE');
  if (file.size !== null && file.size > TICKET_ATTACHMENT_LIMITS.maxBytes) {
    throw attachmentError('ATTACHMENT_TOO_LARGE');
  }

  const form = new FormData();
  form.append('file', attachmentFilePart(file) as unknown as Blob);

  let response: { data?: Partial<TicketAttachmentMeta> };
  try {
    response = await coreRequest<{ data?: Partial<TicketAttachmentMeta> }>(
      `/tickets/${ticketId}/attachments`,
      { method: 'POST', body: form },
      ATTACHMENT_UPLOAD_TIMEOUT_MS
    );
  } catch (err) {
    throw toAttachmentError(err);
  }

  const data = response.data;
  // A 2xx with no id is not a success we can act on — the comment POST would
  // then claim nothing, and the chip would show as sent while the photo is
  // stranded as a pending row.
  if (!data?.id) throw attachmentError('UPLOAD_FAILED');

  return {
    id: data.id,
    commentId: data.commentId ?? null,
    contentType: data.contentType ?? file.mimeType,
    byteSize: data.byteSize ?? file.size ?? 0,
    originalFilename: data.originalFilename ?? file.name,
    createdAt: data.createdAt ?? new Date().toISOString(),
  };
}

/** Absolute URL of the authenticated byte route — never a presigned public URL. */
export async function attachmentContentUrl(
  ticketId: string,
  attachmentId: string
): Promise<string> {
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  return `${baseUrl}${API_CORE_PREFIX}/tickets/${ticketId}/attachments/${attachmentId}/content`;
}

/**
 * Download an attachment to the cache and hand it to the OS share sheet.
 *
 * This is how PDFs are "opened": the content route requires an `Authorization`
 * header, so `Linking.openURL` would hand the system browser a URL that 401s.
 * Downloading with the header first and sharing the local file is the only path
 * that works for an authenticated byte route.
 */
export async function openAttachmentExternally(
  ticketId: string,
  attachmentId: string,
  filename: string,
  contentType: string
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw attachmentError('SHARING_UNAVAILABLE');

  const url = await attachmentContentUrl(ticketId, attachmentId);
  const headers = await getAuthImageHeaders();

  try {
    // Namespaced so two attachments with the same original filename cannot
    // collide in the cache directory.
    const destination = new File(new Directory(Paths.cache, 'ticket-attachments'), `${attachmentId}-${filename}`);
    const downloaded = await File.downloadFileAsync(url, destination, {
      headers,
      idempotent: true,
    });
    await Sharing.shareAsync(downloaded.uri, { mimeType: contentType, UTI: uti(contentType) });
  } catch (err) {
    throw toAttachmentError(err);
  }
}

/** iOS needs a UTI alongside the MIME type or the share sheet offers nothing. */
function uti(contentType: string): string {
  switch (contentType) {
    case 'application/pdf': return 'com.adobe.pdf';
    case 'image/png': return 'public.png';
    case 'image/webp': return 'org.webmproject.webp';
    default: return 'public.jpeg';
  }
}
