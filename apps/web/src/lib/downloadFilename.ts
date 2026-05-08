// RFC 5987: filename*=<charset>'<lang>'<percent-encoded-value>. Lang is optional.
const FILENAME_STAR_PREFIX = /^[\w-]+'[^']*'/i;

export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;

  const parts = header.split(';').map((part) => part.trim());
  const filenameStar = parts.find((part) => part.toLowerCase().startsWith('filename*='));
  if (filenameStar) {
    const rawValue = filenameStar.slice(filenameStar.indexOf('=') + 1).trim();
    const value = unquote(rawValue).replace(FILENAME_STAR_PREFIX, '');
    try {
      return sanitizeFilename(decodeURIComponent(value));
    } catch (err) {
      if (!(err instanceof URIError)) throw err;
      return sanitizeFilename(value);
    }
  }

  const filename = parts.find((part) => part.toLowerCase().startsWith('filename='));
  if (filename) {
    return sanitizeFilename(unquote(filename.slice(filename.indexOf('=') + 1).trim()));
  }

  console.warn('Content-Disposition header has no filename param; using fallback', header);
  return null;
}

export function fallbackInstallerFilename(platform: 'windows' | 'macos'): string {
  return platform === 'windows' ? 'breeze-agent-windows.zip' : 'breeze-agent-macos.zip';
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function sanitizeFilename(value: string): string | null {
  const filename = value.trim().split(/[\\/]/).pop();
  return filename || null;
}
