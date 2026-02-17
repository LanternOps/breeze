export type BinarySource = 'local' | 'github';

const GITHUB_RELEASE_BASE = 'https://github.com/lanternops/breeze/releases';

export function getBinarySource(): BinarySource {
  const raw = (process.env.BINARY_SOURCE || 'local').trim().toLowerCase();
  if (raw === 'github') return 'github';
  return 'local';
}

export function getGithubReleaseVersion(): string {
  return process.env.BINARY_VERSION || process.env.BREEZE_VERSION || 'latest';
}

function githubDownloadBase(): string {
  const version = getGithubReleaseVersion();
  if (version === 'latest') {
    return `${GITHUB_RELEASE_BASE}/latest/download`;
  }
  return `${GITHUB_RELEASE_BASE}/download/v${version}`;
}

export function getGithubAgentUrl(os: string, arch: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-agent-${os}-${arch}${extension}`;
  return `${githubDownloadBase()}/${filename}`;
}

const VIEWER_FILENAMES: Record<string, string> = {
  macos: 'breeze-viewer-macos.dmg',
  windows: 'breeze-viewer-windows.msi',
  linux: 'breeze-viewer-linux.AppImage',
};

export function getGithubViewerUrl(platform: string): string {
  const filename = VIEWER_FILENAMES[platform];
  if (!filename) throw new Error(`Unknown viewer platform: ${platform}`);
  return `${githubDownloadBase()}/${filename}`;
}
