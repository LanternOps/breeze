const CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F]/;
const DATA_IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]{4,}={0,2}$/;
const MAX_DATA_URI_LENGTH = 400_000;

function isSafeRelativePath(value: string): boolean {
  if (!value.startsWith('/')) {
    return false;
  }

  if (value.startsWith('//') || value.startsWith('/\\')) {
    return false;
  }

  return !CONTROL_CHARS_PATTERN.test(value);
}

export function sanitizeImageSrc(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const candidate = value.trim();
  if (!candidate || CONTROL_CHARS_PATTERN.test(candidate)) {
    return null;
  }

  if (candidate.startsWith('data:')) {
    if (candidate.length > MAX_DATA_URI_LENGTH) return null;
    return DATA_IMAGE_PATTERN.test(candidate) ? candidate : null;
  }

  if (candidate.startsWith('blob:')) {
    return candidate;
  }

  if (isSafeRelativePath(candidate)) {
    return candidate;
  }

  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();

    if (protocol === 'https:' || protocol === 'http:') {
      return parsed.toString();
    }

    return null;
  } catch {
    return null;
  }
}

export function isSafeImageSrc(value: string | null | undefined): boolean {
  return sanitizeImageSrc(value) !== null;
}
