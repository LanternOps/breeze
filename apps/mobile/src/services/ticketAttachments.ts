import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';

import { API_CORE_PREFIX, coreRequest, FALLBACK_API_BASE_URL, getAuthImageHeaders } from './api';
import { getServerUrl } from './serverConfig';
import {
  ATTACHMENT_UPLOAD_TIMEOUT_MS,
  attachmentError,
  attachmentFilePart,
  isAllowedMime,
  MAX_IMAGE_EDGE,
  TICKET_ATTACHMENT_LIMITS,
  toAttachmentError,
  type PickedAttachment,
  type PickOutcome,
  type TicketAttachmentMeta,
} from './ticketAttachmentContract';

// Re-exported so a caller that already needs the native functions has one
// import site. Anything that needs ONLY the contract (composer/feed logic, and
// every test of it) must import `./ticketAttachmentContract` directly — going
// through this module drags six Expo packages, and therefore Flow-typed
// `react-native` source, into the Vitest runner.
export * from './ticketAttachmentContract';

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

/**
 * Run a native picker, converting a throw into a `failed` outcome.
 *
 * The pickers are TOTAL by contract — they resolve, never reject. Their call
 * sites dispatch them with `void`, so a rejection would become an unhandled
 * promise: no toast, no Sentry breadcrumb, no chip, and a technician who tapped
 * Camera and saw nothing happen at all.
 */
async function runPicker(pick: () => Promise<PickOutcome>): Promise<PickOutcome> {
  try {
    return await pick();
  } catch (err: unknown) {
    return { ok: false, reason: 'failed', message: toAttachmentError(err).message };
  }
}

export async function pickFromCamera(): Promise<PickOutcome> {
  return runPicker(async () => {
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
  });
}

/**
 * @param remainingSlots how many more files this comment may carry. Passed to
 * the OS picker as `selectionLimit` so the technician cannot select seven
 * photos and then be told two were dropped.
 */
export async function pickFromLibrary(remainingSlots: number): Promise<PickOutcome> {
  return runPicker(async () => {
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
  });
}

export async function pickDocument(): Promise<PickOutcome> {
  return runPicker(async () => {
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
  });
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
