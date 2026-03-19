export type BinarySource = 'local' | 'github';

const GITHUB_RELEASE_BASE = 'https://github.com/lanternops/breeze/releases';

let binarySourceWarned = false;

export function getBinarySource(): BinarySource {
  const raw = (process.env.BINARY_SOURCE || 'github').trim().toLowerCase();
  if (raw === 'local') return 'local';
  if (raw !== 'github' && !binarySourceWarned) {
    console.warn(`[binarySource] Unrecognized BINARY_SOURCE="${raw}", defaulting to "github"`);
    binarySourceWarned = true;
  }
  return 'github';
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

export function getGithubAgentPkgUrl(os: string, arch: string): string {
  const filename = `breeze-agent-${os}-${arch}.pkg`;
  return `${githubDownloadBase()}/${filename}`;
}

export const VIEWER_FILENAMES: Record<string, string> = {
  macos: 'breeze-viewer-macos.dmg',
  windows: 'breeze-viewer-windows.msi',
  linux: 'breeze-viewer-linux.AppImage',
};

export function getGithubViewerUrl(platform: string): string {
  const filename = VIEWER_FILENAMES[platform];
  if (!filename) throw new Error(`Unknown viewer platform: ${platform}`);
  return `${githubDownloadBase()}/${filename}`;
}

export const HELPER_FILENAMES: Record<string, string> = {
  darwin: 'breeze-helper-macos.dmg',
  windows: 'breeze-helper-windows.msi',
  linux: 'breeze-helper-linux.AppImage',
};

export function getGithubHelperUrl(os: string): string {
  const filename = HELPER_FILENAMES[os];
  if (!filename) throw new Error(`Unknown helper OS: ${os}`);
  return `${githubDownloadBase()}/${filename}`;
}
