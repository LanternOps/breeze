import { getReleaseSourceReleaseBase, getReleaseSourceRepository } from './releaseSource';
import { isSigningInputAssetName } from './releaseAssetTrust';

export type BinarySource = 'local' | 'github';

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

/**
 * Controls whether binarySync auto-promotes a newly-registered binary to the
 * fleet upgrade target (agent_versions.isLatest=true). Defaults TRUE so existing
 * self-host behavior is unchanged: publishing/syncing a release immediately
 * becomes the upgrade target. Set AGENT_AUTO_PROMOTE=false to decouple
 * registration from promotion — new binaries become downloadable but the fleet
 * upgrade target only changes via the explicit POST /agent-versions/promote
 * endpoint. See docs/superpowers/specs/agent/2026-06-23-controlled-agent-fleet-rollout.md.
 */
export function getAgentAutoPromote(): boolean {
  const raw = process.env.AGENT_AUTO_PROMOTE?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true; // default: preserve current behavior
  return !['false', '0', 'no', 'off'].includes(raw);
}

export function getGithubReleaseVersion(): string {
  return process.env.BINARY_VERSION || process.env.BREEZE_VERSION || 'latest';
}

export function getGithubReleasePageUrl(): string {
  const version = getGithubReleaseVersion();
  if (version === 'latest') {
    return `${getReleaseSourceReleaseBase()}/latest`;
  }
  return `${getReleaseSourceReleaseBase()}/tag/v${version}`;
}

// `version` overrides the per-process env resolution (BINARY_VERSION /
// BREEZE_VERSION). Callers that must agree with a checksum served from the
// agent_versions row — the public component-download routes, see
// services/promotedAgentVersion.ts and issue #3499 — pass the promoted row's
// version explicitly so the bytes and the checksum come from one source.
// Omitting it preserves the historical env-resolved behavior.
function githubDownloadBase(version?: string): string {
  const resolved = version ?? getGithubReleaseVersion();
  if (resolved === 'latest') {
    return `${getReleaseSourceReleaseBase()}/latest/download`;
  }
  // agent_versions rows store a bare semver ("0.105.1"); the env var is also
  // bare by convention. Normalize either form to the "v"-prefixed release tag.
  const tag = resolved.startsWith('v') ? resolved : `v${resolved}`;
  // The tag is now interpolated into a URL path from a DB row (creatable via
  // POST /agent-versions) rather than only from env, and agent_versions.version
  // has no format constraint. Refuse anything that could escape the release
  // path instead of 404ing mysteriously — the same standard releaseSource.ts
  // applies to the repository segment.
  if (!/^v[0-9A-Za-z._-]+$/.test(tag)) {
    throw new Error(`Refusing to build a download URL for malformed release tag "${tag}"`);
  }
  return `${getReleaseSourceReleaseBase()}/download/${tag}`;
}

// Spec 3c serving-surface guard: routes/agents/download.ts redirects and
// routes/supportPublic.ts proxies whatever URL these builders produce, without
// ever seeing a manifest. All canonical asset filenames are static strings
// today, so this is a tripwire against a future builder (or refactor) leaking
// a signing-input asset onto a public surface.
function githubAssetDownloadUrl(filename: string, version?: string): string {
  if (isSigningInputAssetName(filename)) {
    throw new Error(
      `Refusing to build a download URL for signing-input asset "${filename}"`,
    );
  }
  return `${githubDownloadBase(version)}/${filename}`;
}

export function getGithubReleaseRepository(): string {
  return getReleaseSourceRepository();
}

export function getGithubExpectedReleaseTag(): string | null {
  const version = getGithubReleaseVersion();
  if (version === 'latest') return null;
  return version.startsWith('v') ? version : `v${version}`;
}

export function getGithubReleaseArtifactManifestUrl(): string {
  return `${githubDownloadBase()}/release-artifact-manifest.json`;
}

export function getGithubReleaseArtifactManifestSignatureUrl(): string {
  return `${githubDownloadBase()}/release-artifact-manifest.json.ed25519`;
}

export function getGithubAgentUrl(os: string, arch: string, version?: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-agent-${os}-${arch}${extension}`;
  return githubAssetDownloadUrl(filename, version);
}

export function getGithubBackupUrl(os: string, arch: string, version?: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-backup-${os}-${arch}${extension}`;
  return githubAssetDownloadUrl(filename, version);
}

export function getGithubAgentPkgUrl(os: string, arch: string): string {
  const filename = `breeze-agent-${os}-${arch}.pkg`;
  return githubAssetDownloadUrl(filename);
}

export function getGithubWatchdogUrl(os: string, arch: string, version?: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-watchdog-${os}-${arch}${extension}`;
  return githubAssetDownloadUrl(filename, version);
}

// breeze-user-helper is the GUI-subsystem sibling of breeze-agent. The agent
// only prefetches it on Windows today, but this mirrors the other per-(os,arch)
// asset URL helpers and stays OS-general. It is a distinct release asset from
// the Tauri "helper" app served by HELPER_FILENAMES — don't conflate the two
// (#1878).
export function getGithubUserHelperUrl(os: string, arch: string, version?: string): string {
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-user-helper-${os}-${arch}${extension}`;
  return githubAssetDownloadUrl(filename, version);
}

export function getGithubRegularMsiUrl(): string {
  return githubAssetDownloadUrl('breeze-agent.msi');
}

export const VIEWER_FILENAMES: Record<string, string> = {
  macos: 'breeze-viewer-macos.dmg',
  windows: 'breeze-viewer-windows.msi',
  linux: 'breeze-viewer-linux.AppImage',
};

export function getGithubViewerUrl(platform: string): string {
  const filename = VIEWER_FILENAMES[platform];
  if (!filename) throw new Error(`Unknown viewer platform: ${platform}`);
  return githubAssetDownloadUrl(filename);
}

export const HELPER_FILENAMES: Record<string, string> = {
  darwin: 'breeze-helper-macos.dmg',
  windows: 'breeze-helper-windows.msi',
  linux: 'breeze-helper-linux.AppImage',
};

export function getGithubHelperUrl(os: string, version?: string): string {
  const filename = HELPER_FILENAMES[os];
  if (!filename) throw new Error(`Unknown helper OS: ${os}`);
  return githubAssetDownloadUrl(filename, version);
}

/**
 * URL of the notarized Breeze Installer.app.zip for the current release.
 * Asset is uploaded by the build-macos-installer-app job in release.yml.
 */
export function getGithubInstallerAppUrl(): string {
  // GitHub Releases auto-rewrites spaces in attached asset filenames to dots,
  // so the on-disk artifact "Breeze Installer.app.zip" is served at this URL.
  return githubAssetDownloadUrl('Breeze.Installer.app.zip');
}
