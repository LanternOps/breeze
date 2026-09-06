import { beforeEach, describe, expect, it, vi } from 'vitest';

const coreRequest = vi.fn();
const launchCameraAsync = vi.fn();
const launchImageLibraryAsync = vi.fn();
const requestCameraPermissionsAsync = vi.fn();
const requestMediaLibraryPermissionsAsync = vi.fn();
const getDocumentAsync = vi.fn();
const manipulate = vi.fn();
const downloadFileAsync = vi.fn();
const shareAsync = vi.fn();
const isAvailableAsync = vi.fn();

vi.mock('./api', () => ({
  coreRequest: (...args: unknown[]) => coreRequest(...args),
  getAuthImageHeaders: vi.fn(async () => ({ Authorization: 'Bearer token-1' })),
  FALLBACK_API_BASE_URL: 'http://localhost:3001',
  API_CORE_PREFIX: '/api/v1',
}));
vi.mock('./serverConfig', () => ({ getServerUrl: vi.fn(async () => 'https://api.example.test') }));
vi.mock('expo-image-picker', () => ({
  launchCameraAsync: (...a: unknown[]) => launchCameraAsync(...a),
  launchImageLibraryAsync: (...a: unknown[]) => launchImageLibraryAsync(...a),
  requestCameraPermissionsAsync: () => requestCameraPermissionsAsync(),
  requestMediaLibraryPermissionsAsync: () => requestMediaLibraryPermissionsAsync(),
}));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: (...a: unknown[]) => getDocumentAsync(...a),
}));
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: (...a: unknown[]) => manipulate(...a) },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));
vi.mock('expo-file-system', () => {
  // `File` and `Directory` are real classes upstream and `downloadFileAsync` is
  // a STATIC on File — a plain-object double would let `new File(...)` throw
  // only at runtime on a device, which is exactly the bug this suite exists for.
  class Directory {
    constructor(...segments: unknown[]) { this.segments = segments; }
    segments: unknown[];
  }
  class File {
    constructor(...segments: unknown[]) { this.segments = segments; }
    segments: unknown[];
    static downloadFileAsync = (...a: unknown[]) => downloadFileAsync(...a);
  }
  return { File, Directory, Paths: { cache: { uri: 'file:///cache/' } } };
});
vi.mock('expo-sharing', () => ({
  shareAsync: (...a: unknown[]) => shareAsync(...a),
  isAvailableAsync: () => isAvailableAsync(),
}));

import {
  attachmentContentUrl,
  attachmentFilePart,
  AttachmentUploadError,
  MAX_IMAGE_EDGE,
  openAttachmentExternally,
  pickDocument,
  pickFromCamera,
  pickFromLibrary,
  prepareImage,
  TICKET_ATTACHMENT_LIMITS,
  uploadTicketAttachment,
  type PickedAttachment,
} from './ticketAttachments';

const jpeg: PickedAttachment = {
  uri: 'file:///tmp/shot.jpg',
  name: 'shot.jpg',
  mimeType: 'image/jpeg',
  size: 1024,
  width: 4032,
  height: 3024,
};

/** The manipulator chain: manipulate() → .resize() → .renderAsync() → .saveAsync(). */
function mockManipulator(saved: { uri: string; width: number; height: number }) {
  const resize = vi.fn();
  const saveAsync = vi.fn(async () => saved);
  const renderAsync = vi.fn(async () => ({ ...saved, saveAsync }));
  const context = { resize, renderAsync };
  resize.mockReturnValue(context);
  manipulate.mockReturnValue(context);
  return { resize, renderAsync, saveAsync };
}

function apiError(code: string, statusCode: number, message = 'server said no') {
  return { code, statusCode, message };
}

beforeEach(() => {
  vi.clearAllMocks();
  requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
  requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
  isAvailableAsync.mockResolvedValue(true);
});

describe('limits mirror the server contract', () => {
  it('matches TICKET_ATTACHMENT_LIMITS in packages/shared', () => {
    expect(TICKET_ATTACHMENT_LIMITS).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxPerComment: 5,
      maxPendingPerUser: 20,
      allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    });
  });
});

describe('pickers', () => {
  it('never lets EXIF (and therefore GPS) leave the phone', async () => {
    launchCameraAsync.mockResolvedValue({ canceled: true, assets: null });
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });

    await pickFromCamera();
    await pickFromLibrary(5);

    expect(launchCameraAsync.mock.calls[0]![0]).toMatchObject({ exif: false });
    expect(launchImageLibraryAsync.mock.calls[0]![0]).toMatchObject({ exif: false });
  });

  it('asks the library for at most the remaining comment slots', async () => {
    launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });

    await pickFromLibrary(2);

    expect(launchImageLibraryAsync.mock.calls[0]![0]).toMatchObject({
      mediaTypes: ['images'],
      selectionLimit: 2,
      allowsMultipleSelection: true,
    });
  });

  it('reports a denied camera permission distinctly from a cancel', async () => {
    requestCameraPermissionsAsync.mockResolvedValue({ granted: false });

    await expect(pickFromCamera()).resolves.toEqual({ ok: false, reason: 'permission-denied' });
    expect(launchCameraAsync).not.toHaveBeenCalled();
  });

  it('reports a cancelled camera pick as cancelled', async () => {
    launchCameraAsync.mockResolvedValue({ canceled: true, assets: null });

    await expect(pickFromCamera()).resolves.toEqual({ ok: false, reason: 'cancelled' });
  });

  it('maps a camera asset onto the upload shape', async () => {
    launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [{
        uri: 'file:///tmp/IMG_1.jpg', fileName: 'IMG_1.jpg', mimeType: 'image/jpeg',
        fileSize: 2048, width: 100, height: 50,
      }],
    });

    await expect(pickFromCamera()).resolves.toEqual({
      ok: true,
      files: [{
        uri: 'file:///tmp/IMG_1.jpg', name: 'IMG_1.jpg', mimeType: 'image/jpeg',
        size: 2048, width: 100, height: 50,
      }],
    });
  });

  it.each([
    ['camera', () => pickFromCamera(), launchCameraAsync],
    ['library', () => pickFromLibrary(5), launchImageLibraryAsync],
    ['document', () => pickDocument(), getDocumentAsync],
  ])('reports a thrown native %s picker as a failure instead of rejecting', async (_name, run, native) => {
    // A native picker can throw for reasons the outcome union does not model —
    // a picker already open, an iCloud file that will not download, a module
    // that failed to link. The call site fires these with `void`, so a
    // rejection here is an unhandled promise: no toast, no Sentry, no chip,
    // and a technician who tapped a button and saw absolutely nothing happen.
    native.mockRejectedValue(new Error('native picker exploded'));

    await expect(run()).resolves.toMatchObject({ ok: false, reason: 'failed' });
  });

  it('reports a thrown permission request as a failure, not a denial', async () => {
    requestCameraPermissionsAsync.mockRejectedValue(new Error('boom'));

    await expect(pickFromCamera()).resolves.toMatchObject({ ok: false, reason: 'failed' });
  });

  it('asks the document picker for PDFs only, copied to the cache', async () => {
    getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });

    await pickDocument();

    expect(getDocumentAsync.mock.calls[0]![0]).toMatchObject({
      type: 'application/pdf',
      copyToCacheDirectory: true,
      multiple: false,
    });
  });
});

describe('prepareImage', () => {
  it('caps the long edge and re-encodes to JPEG, which is what drops the EXIF block', async () => {
    const { resize, saveAsync } = mockManipulator({
      uri: 'file:///cache/out.jpg', width: MAX_IMAGE_EDGE, height: 1536,
    });

    const out = await prepareImage(jpeg);

    // Landscape source: the WIDTH is the long edge, so only width is constrained
    // and the manipulator preserves the ratio itself.
    expect(resize).toHaveBeenCalledWith({ width: MAX_IMAGE_EDGE });
    expect(saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.8 });
    expect(out).toMatchObject({ uri: 'file:///cache/out.jpg', mimeType: 'image/jpeg' });
    expect(out.name.endsWith('.jpg')).toBe(true);
  });

  it('constrains the height instead when the image is portrait', async () => {
    const { resize } = mockManipulator({ uri: 'file:///cache/out.jpg', width: 1536, height: MAX_IMAGE_EDGE });

    await prepareImage({ ...jpeg, width: 3024, height: 4032 });

    expect(resize).toHaveBeenCalledWith({ height: MAX_IMAGE_EDGE });
  });

  it('still re-encodes a small image, because that is what strips EXIF', async () => {
    const { resize, saveAsync } = mockManipulator({ uri: 'file:///cache/out.jpg', width: 800, height: 600 });

    await prepareImage({ ...jpeg, width: 800, height: 600 });

    expect(resize).not.toHaveBeenCalled();
    expect(saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.8 });
  });

  it('passes a PDF through untouched — there is nothing to re-encode', async () => {
    const pdf: PickedAttachment = {
      uri: 'file:///tmp/report.pdf', name: 'report.pdf', mimeType: 'application/pdf',
      size: 5000, width: null, height: null,
    };

    await expect(prepareImage(pdf)).resolves.toBe(pdf);
    expect(manipulate).not.toHaveBeenCalled();
  });
});

describe('uploadTicketAttachment', () => {
  it('rejects an oversized file client-side, before any network call', async () => {
    const tooBig = { ...jpeg, size: TICKET_ATTACHMENT_LIMITS.maxBytes + 1 };

    await expect(uploadTicketAttachment('t-1', tooBig)).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
    });
    expect(coreRequest).not.toHaveBeenCalled();
  });

  it('rejects an unsupported type client-side, before any network call', async () => {
    await expect(
      uploadTicketAttachment('t-1', { ...jpeg, mimeType: 'image/gif', name: 'a.gif' })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ATTACHMENT_TYPE' });
    expect(coreRequest).not.toHaveBeenCalled();
  });

  it('POSTs multipart to the attachment route with the long upload timeout', async () => {
    coreRequest.mockResolvedValue({ data: { id: 'att-1', byteSize: 1024 } });

    await uploadTicketAttachment('t-1', jpeg);

    const [endpoint, options, timeoutMs] = coreRequest.mock.calls[0]!;
    expect(endpoint).toBe('/tickets/t-1/attachments');
    expect((options as RequestInit).method).toBe('POST');
    expect((options as RequestInit).body).toBeInstanceOf(FormData);
    expect(timeoutMs).toBe(120_000);
  });

  it('sends the file under the field name the server expects', () => {
    expect(attachmentFilePart(jpeg)).toEqual({
      uri: 'file:///tmp/shot.jpg', name: 'shot.jpg', type: 'image/jpeg',
    });
  });

  it('returns the attachment metadata the server minted', async () => {
    coreRequest.mockResolvedValue({
      data: {
        id: 'att-1', commentId: null, contentType: 'image/jpeg', byteSize: 1024,
        originalFilename: 'shot.jpg', createdAt: '2026-09-01T00:00:00.000Z',
      },
    });

    await expect(uploadTicketAttachment('t-1', jpeg)).resolves.toMatchObject({ id: 'att-1' });
  });

  it.each([
    ['ATTACHMENT_TOO_LARGE', 413],
    ['UNSUPPORTED_ATTACHMENT_TYPE', 415],
    ['TOO_MANY_PENDING', 429],
    ['TICKET_DELETED', 409],
    ['STORAGE_UNAVAILABLE', 503],
  ])('maps %s to its own message rather than one generic failure', async (code, status) => {
    coreRequest.mockRejectedValue(apiError(code, status));

    const err = await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttachmentUploadError);
    expect((err as AttachmentUploadError).code).toBe(code);
    // The message must be specific, not the server's raw string and not shared.
    expect((err as AttachmentUploadError).message).not.toBe('server said no');
  });

  it('gives every mapped code a distinct message', async () => {
    const codes = [
      'ATTACHMENT_TOO_LARGE', 'UNSUPPORTED_ATTACHMENT_TYPE', 'TOO_MANY_PENDING',
      'TICKET_DELETED', 'STORAGE_UNAVAILABLE', 'ATTACHMENT_NOT_CLAIMABLE',
    ];
    const messages: string[] = [];
    for (const code of codes) {
      coreRequest.mockRejectedValueOnce(apiError(code, 400));
      const err = await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e);
      messages.push((err as AttachmentUploadError).message);
    }

    expect(new Set(messages).size).toBe(codes.length);
  });

  it('marks a storage outage retryable and a rejected file not', async () => {
    coreRequest.mockRejectedValueOnce(apiError('STORAGE_UNAVAILABLE', 503));
    const transient = await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e);
    coreRequest.mockRejectedValueOnce(apiError('UNSUPPORTED_ATTACHMENT_TYPE', 415));
    const permanent = await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e);

    expect((transient as AttachmentUploadError).retryable).toBe(true);
    expect((permanent as AttachmentUploadError).retryable).toBe(false);
  });

  it.each([
    [413, 'ATTACHMENT_TOO_LARGE', false],
    [415, 'UNSUPPORTED_ATTACHMENT_TYPE', false],
    [429, 'TOO_MANY_PENDING', false],
    [503, 'STORAGE_UNAVAILABLE', true],
  ])('falls back to HTTP %i when the body carries no code', async (status, expected, retryable) => {
    // A proxy or load balancer can reject the body before the API sees it — a
    // 413 from Caddy has an HTML body, so `response.json()` yields {} and there
    // is no `code` at all. Collapsing that to a retryable "check your
    // connection" tells the technician to retry a file that can never succeed.
    coreRequest.mockRejectedValue({ statusCode: status, message: 'Request Entity Too Large' });

    const err = await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e);

    expect((err as AttachmentUploadError).code).toBe(expected);
    expect((err as AttachmentUploadError).retryable).toBe(retryable);
  });

  it('prefers an explicit body code over the status code', async () => {
    coreRequest.mockRejectedValue(apiError('STORAGE_UNAVAILABLE', 413));

    const err = await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e);

    expect((err as AttachmentUploadError).code).toBe('STORAGE_UNAVAILABLE');
  });

  it('treats an unrecognised transport failure as retryable, not as success', async () => {
    coreRequest.mockRejectedValue(new Error('Network request failed'));

    const err = await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttachmentUploadError);
    expect((err as AttachmentUploadError).code).toBe('UPLOAD_FAILED');
    expect((err as AttachmentUploadError).retryable).toBe(true);
  });

  it('refuses a response with no attachment id rather than reporting a phantom success', async () => {
    coreRequest.mockResolvedValue({ data: {} });

    await expect(uploadTicketAttachment('t-1', jpeg)).rejects.toBeInstanceOf(AttachmentUploadError);
  });
});

describe('attachmentContentUrl', () => {
  it('builds an absolute URL against the configured server', async () => {
    await expect(attachmentContentUrl('t-1', 'att-1')).resolves.toBe(
      'https://api.example.test/api/v1/tickets/t-1/attachments/att-1/content'
    );
  });
});

describe('openAttachmentExternally', () => {
  it('downloads with the auth headers before sharing — the route is never public', async () => {
    downloadFileAsync.mockResolvedValue({ uri: 'file:///cache/report.pdf' });

    await openAttachmentExternally('t-1', 'att-1', 'report.pdf', 'application/pdf');

    const [url, , options] = downloadFileAsync.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/v1/tickets/t-1/attachments/att-1/content');
    expect((options as { headers: Record<string, string> }).headers).toMatchObject({
      Authorization: 'Bearer token-1',
    });
    expect(shareAsync).toHaveBeenCalledWith('file:///cache/report.pdf', expect.objectContaining({
      mimeType: 'application/pdf',
    }));
  });

  it('does not claim to have opened anything when sharing is unavailable', async () => {
    isAvailableAsync.mockResolvedValue(false);

    await expect(
      openAttachmentExternally('t-1', 'att-1', 'report.pdf', 'application/pdf')
    ).rejects.toBeInstanceOf(AttachmentUploadError);
    expect(downloadFileAsync).not.toHaveBeenCalled();
  });
});

describe('uploadTicketAttachment — failures that are NOT a bad connection', () => {
  const jpeg = { uri: 'file:///tmp/a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', size: 1000, width: 10, height: 10 };
  const GENERIC = 'Upload failed. Check your connection and try again.';

  it.each([
    [401, 'Not authenticated'],
    [403, 'Insufficient permissions'],
    [404, 'Not Found'],
  ])('surfaces the server\'s own reason for an HTTP %i instead of blaming the connection', async (status, message) => {
    coreRequest.mockRejectedValue({ statusCode: status, message });

    const err = (await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e)) as AttachmentUploadError;

    expect(err).toBeInstanceOf(AttachmentUploadError);
    expect(err.message).not.toBe(GENERIC);
    expect(err.message).toContain(message);
    expect(err.message).toContain(String(status));
    // A stale token or a permission gap does not get better by tapping Retry.
    expect(err.retryable).toBe(false);
  });

  it('maps ORG_CONTEXT_REQUIRED to its own non-retryable copy', async () => {
    coreRequest.mockRejectedValue(apiError('ORG_CONTEXT_REQUIRED', 403));
    const err = (await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e)) as AttachmentUploadError;
    expect(err.code).toBe('ORG_CONTEXT_REQUIRED');
    expect(err.retryable).toBe(false);
    expect(err.message).not.toBe(GENERIC);
  });

  it('names the underlying cause for a failure that never produced a response', async () => {
    // RN's fetch rejects with a TypeError when it cannot read the file URI or
    // build the multipart body; that is not a connectivity problem either, and
    // hiding the message is what made the camera-upload defect undiagnosable.
    coreRequest.mockRejectedValue(new TypeError('Network request failed'));
    const err = (await uploadTicketAttachment('t-1', jpeg).catch((e: unknown) => e)) as AttachmentUploadError;
    expect(err.code).toBe('UPLOAD_FAILED');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Network request failed');
  });
});
