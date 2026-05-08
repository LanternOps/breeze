const FILENAME_STAR_PREFIX = /^UTF-8''/i;

export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;

  const parts = header.split(';').map((part) => part.trim());
  const filenameStar = parts.find((part) => part.toLowerCase().startsWith('filename*='));
  if (filenameStar) {
    const rawValue = filenameStar.slice(filenameStar.indexOf('=') + 1).trim();
    const value = unquote(rawValue).replace(FILENAME_STAR_PREFIX, '');
    try {
      return sanitizeFilename(decodeURIComponent(value));
    } catch {
      return sanitizeFilename(value);
    }
  }

  const filename = parts.find((part) => part.toLowerCase().startsWith('filename='));
  if (!filename) return null;

  return sanitizeFilename(unquote(filename.slice(filename.indexOf('=') + 1).trim()));
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
