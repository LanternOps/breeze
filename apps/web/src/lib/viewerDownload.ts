import type { OSType } from '@breeze/shared';

export interface ViewerDownloadInfo {
  readonly os: OSType;
  readonly label: string;
  readonly url: string;
  readonly filename: string;
}

const LEGACY_DOWNLOAD_BASE = (import.meta.env.PUBLIC_VIEWER_DOWNLOAD_URL || '').trim();
const API_BASE = (import.meta.env.PUBLIC_API_URL || '').trim();

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function getDownloadUrl(os: OSType, filename: string): string {
  if (LEGACY_DOWNLOAD_BASE) {
    return `${withoutTrailingSlash(LEGACY_DOWNLOAD_BASE)}/${filename}`;
  }
  return `${withoutTrailingSlash(API_BASE)}/api/v1/viewers/download/${os}`;
}

const PLATFORMS: readonly ViewerDownloadInfo[] = [
  {
    os: 'macos',
    label: 'macOS',
    filename: 'breeze-viewer-macos.dmg',
    url: getDownloadUrl('macos', 'breeze-viewer-macos.dmg')
  },
  {
    os: 'windows',
    label: 'Windows',
    filename: 'breeze-viewer-windows.msi',
    url: getDownloadUrl('windows', 'breeze-viewer-windows.msi')
  },
  {
    os: 'linux',
    label: 'Linux',
    filename: 'breeze-viewer-linux.AppImage',
    url: getDownloadUrl('linux', 'breeze-viewer-linux.AppImage')
  },
];

function detectOS(): OSType | null {
  try {
    // Modern API (Chromium 93+)
    const uaData = (navigator as any).userAgentData;
    if (uaData?.platform) {
      const p = String(uaData.platform).toLowerCase();
      if (p.includes('mac')) return 'macos';
      if (p.includes('win')) return 'windows';
      if (p.includes('linux')) return 'linux';
    }

    // Fallback: navigator.platform
    const platform = navigator.platform?.toLowerCase() ?? '';
    if (platform.includes('mac')) return 'macos';
    if (platform.includes('win')) return 'windows';
    if (platform.includes('linux')) return 'linux';

    // Last resort: user agent string
    const ua = navigator.userAgent?.toLowerCase() ?? '';
    if (ua.includes('mac')) return 'macos';
    if (ua.includes('win')) return 'windows';
    if (ua.includes('linux')) return 'linux';

    console.warn('[viewerDownload] Could not detect OS.',
      'userAgentData.platform:', uaData?.platform,
      'navigator.platform:', navigator.platform);
    return null;
  } catch (err) {
    console.warn('[viewerDownload] OS detection error:', err);
    return null;
  }
}

export function getViewerDownloadInfo(): ViewerDownloadInfo | null {
  const os = detectOS();
  if (!os) return null;
  return PLATFORMS.find(p => p.os === os) ?? null;
}

export function getAllViewerDownloads(): readonly ViewerDownloadInfo[] {
  return PLATFORMS;
}
