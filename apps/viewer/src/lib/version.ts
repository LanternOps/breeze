/**
 * Version check utilities for Breeze Viewer.
 * Checks GitHub Releases for newer versions and provides download links.
 */

import { getVersion } from '@tauri-apps/api/app';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string | null;
  releaseUrl: string;
}

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 */
export function isOutdated(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const c = parse(current);
  const l = parse(latest);

  for (let i = 0; i < 3; i++) {
    const cv = c[i] ?? 0;
    const lv = l[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

/**
 * Get the platform-specific asset name for the viewer download.
 */
function getPlatformAssetName(): string {
  const p = navigator.platform.toLowerCase();
  if (p.includes('mac') || p.includes('darwin')) return 'breeze-viewer-macos.dmg';
  if (p.includes('win')) return 'breeze-viewer-windows.msi';
  return 'breeze-viewer-linux.AppImage';
}

/**
 * Check GitHub Releases for a newer version of the viewer.
 * Returns UpdateInfo if outdated, null otherwise. Silently returns null on any error.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const currentVersion = await getVersion();

    const resp = await fetch(
      'https://api.github.com/repos/LanternOps/breeze/releases/latest',
      { headers: { Accept: 'application/vnd.github.v3+json' } },
    );

    if (!resp.ok) return null;

    const release = await resp.json();
    const tagName: string = release.tag_name ?? '';
    const latestVersion = tagName.replace(/^v/, '');

    if (!latestVersion || !isOutdated(currentVersion, latestVersion)) {
      return null;
    }

    // Find platform-specific asset
    const assetName = getPlatformAssetName();
    const assets: Array<{ name: string; browser_download_url: string }> = release.assets ?? [];
    const asset = assets.find((a) => a.name === assetName);

    return {
      currentVersion,
      latestVersion,
      downloadUrl: asset?.browser_download_url ?? null,
      releaseUrl: release.html_url ?? `https://github.com/LanternOps/breeze/releases/tag/${tagName}`,
    };
  } catch {
    return null;
  }
}
