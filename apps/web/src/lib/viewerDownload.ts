interface ViewerDownloadInfo {
  os: string;
  url: string;
  filename: string;
}

const REPO = 'toddhebebrand/breeze';
const BASE_URL = `https://github.com/${REPO}/releases/latest/download`;

export const VIEWER_DOWNLOADS_FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

const PLATFORMS: ViewerDownloadInfo[] = [
  { os: 'macOS', filename: 'breeze-viewer-macos.dmg', url: `${BASE_URL}/breeze-viewer-macos.dmg` },
  { os: 'Windows', filename: 'breeze-viewer-windows.msi', url: `${BASE_URL}/breeze-viewer-windows.msi` },
  { os: 'Linux', filename: 'breeze-viewer-linux.AppImage', url: `${BASE_URL}/breeze-viewer-linux.AppImage` },
];

function detectOS(): string | null {
  // Modern API (Chromium 93+)
  const uaData = (navigator as any).userAgentData;
  if (uaData?.platform) {
    const p = uaData.platform.toLowerCase();
    if (p.includes('mac')) return 'macOS';
    if (p.includes('win')) return 'Windows';
    if (p.includes('linux')) return 'Linux';
  }

  // Fallback: navigator.platform
  const platform = navigator.platform?.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'macOS';
  if (platform.includes('win')) return 'Windows';
  if (platform.includes('linux')) return 'Linux';

  // Last resort: user agent string
  const ua = navigator.userAgent?.toLowerCase() ?? '';
  if (ua.includes('mac')) return 'macOS';
  if (ua.includes('win')) return 'Windows';
  if (ua.includes('linux')) return 'Linux';

  return null;
}

export function getViewerDownloadInfo(): ViewerDownloadInfo | null {
  const os = detectOS();
  if (!os) return null;
  return PLATFORMS.find(p => p.os === os) ?? null;
}

export function getAllViewerDownloads(): ViewerDownloadInfo[] {
  return PLATFORMS;
}
