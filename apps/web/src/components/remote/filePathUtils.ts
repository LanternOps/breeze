export type PathBreadcrumb = {
  readonly label: string;
  readonly path: string;
};

export type PathBreadcrumbModel = {
  readonly rootLabel: string;
  readonly rootPath: string;
  readonly segments: readonly PathBreadcrumb[];
};

export type DeviceOs = 'windows' | 'macos' | 'linux';

const WINDOWS_DRIVE_REGEX = /^[A-Za-z]:([\\/]|$)/;
const WINDOWS_DRIVE_ONLY_REGEX = /^[A-Za-z]:$/;
const WINDOWS_UNC_REGEX = /^\\\\/;

export function isWindowsPath(path: string): boolean {
  return WINDOWS_DRIVE_REGEX.test(path) || WINDOWS_DRIVE_ONLY_REGEX.test(path) || WINDOWS_UNC_REGEX.test(path);
}

function normalizeWindowsPath(path: string): string {
  let result = path.replace(/\//g, '\\');
  // Collapse duplicate backslashes, but preserve UNC prefix
  if (result.startsWith('\\\\')) {
    result = '\\\\' + result.slice(2).replace(/\\{2,}/g, '\\');
  } else {
    result = result.replace(/\\{2,}/g, '\\');
  }
  if (WINDOWS_DRIVE_ONLY_REGEX.test(result)) {
    return `${result}\\`;
  }
  return result;
}

function normalizePosixPath(path: string): string {
  if (!path) return '/';
  return path.replace(/\/+/g, '/');
}

function stripTrailingSeparators(path: string, separator: string): string {
  if (!path) return path;
  let result = path;
  while (result.length > 1 && result.endsWith(separator)) {
    result = result.slice(0, -1);
  }
  return result;
}

export function getPathRoot(path: string): string {
  if (isWindowsPath(path)) {
    const normalized = normalizeWindowsPath(path);
    const driveMatch = normalized.match(/^([A-Za-z]:)(?:\\|$)/);
    if (driveMatch) {
      return `${driveMatch[1]}\\`;
    }
    if (normalized.startsWith('\\\\')) {
      return '\\\\';
    }
    return '\\';
  }
  return '/';
}

export function isPathRoot(path: string): boolean {
  if (!path) return true;
  if (isWindowsPath(path)) {
    const normalized = stripTrailingSeparators(normalizeWindowsPath(path), '\\');
    const root = stripTrailingSeparators(getPathRoot(path), '\\');
    return normalized.toLowerCase() === root.toLowerCase();
  }
  return stripTrailingSeparators(normalizePosixPath(path), '/') === '/';
}

export function getParentPath(path: string): string {
  if (!path) return '/';

  if (isWindowsPath(path)) {
    const normalized = normalizeWindowsPath(path);
    const root = getPathRoot(normalized);
    const normalizedLower = normalized.toLowerCase();
    const rootLower = root.toLowerCase();
    if (normalizedLower === rootLower || normalizedLower === rootLower.slice(0, -1)) {
      return root;
    }

    const trimmed = stripTrailingSeparators(normalized, '\\');
    const lastSep = trimmed.lastIndexOf('\\');
    if (lastSep < 0) return root;

    const parent = trimmed.slice(0, lastSep);
    if (!parent) return root;
    if (WINDOWS_DRIVE_ONLY_REGEX.test(parent)) return `${parent}\\`;
    return parent;
  }

  const normalized = normalizePosixPath(path);
  if (normalized === '/') return '/';
  const trimmed = stripTrailingSeparators(normalized, '/');
  const lastSep = trimmed.lastIndexOf('/');
  if (lastSep <= 0) return '/';
  return trimmed.slice(0, lastSep);
}

export function joinRemotePath(basePath: string, name: string): string {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name) || name.includes('\0')) {
    throw new Error(`Invalid path segment: ${JSON.stringify(name)}`);
  }

  if (isWindowsPath(basePath)) {
    const normalized = normalizeWindowsPath(basePath);
    if (normalized.endsWith('\\')) return `${normalized}${name}`;
    return `${normalized}\\${name}`;
  }
  const normalized = normalizePosixPath(basePath);
  if (normalized.endsWith('/')) return `${normalized}${name}`;
  return `${normalized}/${name}`;
}

export function buildBreadcrumbs(path: string): PathBreadcrumbModel {
  if (isWindowsPath(path)) {
    const normalized = normalizeWindowsPath(path);
    const root = getPathRoot(normalized);
    const withoutRoot = normalized.startsWith(root)
      ? normalized.slice(root.length)
      : normalized;
    const parts = withoutRoot.split('\\').filter(Boolean);

    let accumulated = root;
    const segments = parts.map((part) => {
      accumulated = joinRemotePath(accumulated, part);
      return { label: part, path: accumulated };
    });

    return {
      rootLabel: root,
      rootPath: root,
      segments
    };
  }

  const normalized = normalizePosixPath(path);
  const parts = normalized.split('/').filter(Boolean);
  let accumulated = '/';
  const segments = parts.map((part) => {
    accumulated = joinRemotePath(accumulated, part);
    return { label: part, path: accumulated };
  });

  return {
    rootLabel: '/',
    rootPath: '/',
    segments
  };
}

export function getInitialFilePath(os: DeviceOs): string {
  switch (os) {
    case 'windows':
      return 'C:\\';
    case 'macos':
      return '/Users';
    case 'linux':
      return '/home';
    default: {
      const _exhaustive: never = os;
      return '/';
    }
  }
}
