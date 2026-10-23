/**
 * Pure install-fallback anchor builder (#8874, spec §3.2, plan W1 Task 3).
 *
 * Given the effective fallback source, the deployment edition, the promoted
 * release's signed manifest and the promoted agent_versions rows, returns the
 * schema-1 anchor the one-liners may embed — or null with the exact reason.
 *
 * Every consumed byte is pinned from a manifest whose signature has verified
 * against RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS, and the result is re-validated
 * by parseInstallFallback before it is returned, so this never emits an
 * unvalidated anchor. Any doubt is a null anchor: the commands then stay
 * byte-identical to today's and the primary path is unaffected.
 *
 * No I/O (async only because the per-asset verifier is): the caller (W2b)
 * loads the rows and manifest. Nothing here fetches
 * from the artifact source — the API never does (spec D5(a)).
 */
import {
  INSTALL_FALLBACK_ASSETS,
  INSTALL_FALLBACK_SCHEMA_VERSION,
  parseInstallFallback,
  type InstallFallback,
  type InstallFallbackAssetName,
} from '@breeze/shared';
import {
  ReleaseAssetNotDistributableError,
  ReleaseManifestAssetAbsentError,
  ReleaseManifestSignatureError,
  ReleaseManifestTooOldError,
  readVerifiedManifestInstallFallbackInterface,
  verifyReleaseArtifactManifestAsset,
  verifyReleaseArtifactManifestIdentity,
  verifyReleaseArtifactManifestIntegrity,
  ReleaseManifestAssetLookupError,
  type VerifiedReleaseArtifact,
} from '../releaseArtifactManifest';
import { assertDistributableReleaseAsset } from '../releaseAssetTrust';
import type { InstallFallbackSource } from './source';

export type InstallFallbackNullReason =
  | 'source_off'
  | 'no_manifest'
  | 'signature'
  | 'not_binaries_release'
  | 'interface_missing'
  | 'version_disagreement'
  | 'row_checksum_mismatch'
  | 'repository_mismatch'
  | 'asset_missing'
  | 'asset_duplicate'
  | 'edition_mismatch'
  | 'platform_trust'
  | 'signing_input'
  | 'publisher_missing'
  | 'hosted_not_enabled'
  /** Reserved for W6 (hosted distribution enforcement); never returned in W1. */
  | 'hosted_not_mirrored'
  | 'expired'
  | 'schema';

export type InstallFallbackPromotedRow = {
  platform: 'windows' | 'linux' | 'macos';
  architecture: 'amd64' | 'arm64';
  /** As stored on agent_versions: no `v` prefix (binarySync strips it). */
  version: string;
  /** SHA-256 of the raw agent binary for this platform/arch. */
  checksum: string;
};

export type InstallFallbackBuildInput = {
  source: InstallFallbackSource;
  edition: 'self-host' | 'hosted';
  manifest: { bytes: Buffer; signature: Buffer } | null;
  promotedRows: InstallFallbackPromotedRow[];
  tokenExpiresAt: Date;
  now: Date;
};

export type InstallFallbackBuildResult =
  | { anchor: InstallFallback; reason: null }
  | { anchor: null; reason: InstallFallbackNullReason };

/** D3: an anchor outlives neither its token nor 30 days from mint. */
export const INSTALL_FALLBACK_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `min(tokenExpiresAt, mintedAt + 30 days)`, truncated (never rounded up) to
 * whole seconds, as `YYYY-MM-DDTHH:MM:SSZ` (Gate B #11). Throws RangeError on
 * an invalid Date.
 */
export function computeInstallFallbackValidUntil(tokenExpiresAt: Date, mintedAt: Date): string {
  const ms = Math.min(tokenExpiresAt.getTime(), mintedAt.getTime() + INSTALL_FALLBACK_MAX_LIFETIME_MS);
  const truncated = new Date(Math.floor(ms / 1000) * 1000);
  // toISOString throws RangeError for NaN, which is the documented failure.
  return truncated.toISOString().replace(/\.000Z$/, 'Z');
}

function none(reason: InstallFallbackNullReason): InstallFallbackBuildResult {
  return { anchor: null, reason };
}

/** The asset whose bytes an agent_versions row's checksum describes. */
function rawAgentAssetName(row: InstallFallbackPromotedRow): string {
  const goos = row.platform === 'macos' ? 'darwin' : row.platform;
  return `breeze-agent-${goos}-${row.architecture}${row.platform === 'windows' ? '.exe' : ''}`;
}

type ManifestEntry = {
  name?: unknown;
  sha256?: unknown;
  size?: unknown;
  platformTrust?: unknown;
  intendedUse?: unknown;
  edition?: unknown;
  signingIdentity?: unknown;
  signingTeamId?: unknown;
};

const SHA256_RE = /^[0-9a-f]{64}$/;

export async function buildInstallFallback(
  input: InstallFallbackBuildInput,
): Promise<InstallFallbackBuildResult> {
  const { source, edition, manifest, promotedRows, tokenExpiresAt, now } = input;

  if (source.kind === 'off') return none('source_off');

  let validUntil: string;
  try {
    validUntil = computeInstallFallbackValidUntil(tokenExpiresAt, now);
  } catch {
    return none('expired');
  }
  // Truncation can pull validUntil to or before `now` for a token about to
  // expire; such an anchor would be dead on arrival.
  if (!(Date.parse(validUntil) > now.getTime())) return none('expired');

  if (manifest === null) return none('no_manifest');

  // 1. Signature (and manifest schema). Nothing below reads a field of an
  //    unverified manifest.
  let identity: { release: string; repository: string };
  try {
    identity = verifyReleaseArtifactManifestIntegrity(manifest.bytes, manifest.signature);
  } catch (err) {
    return none(err instanceof ReleaseManifestAssetLookupError ? 'schema' : 'signature');
  }

  // 2. A promoted row always comes from a full (binaries-carrying) release.
  try {
    const kind = verifyReleaseArtifactManifestIdentity({
      manifestBytes: manifest.bytes,
      signatureBytes: manifest.signature,
      expectedRepository: identity.repository,
      expectedRelease: identity.release,
    }).releaseKind;
    if (kind !== 'full') return none('not_binaries_release');
  } catch {
    // Unknown releaseKind, or a server-only manifest with a malformed
    // binaries reference: either way not a binaries release we can pin.
    return none('not_binaries_release');
  }

  // 3. The release's install.sh must honour the fallback flags (Gate B #15).
  if (readVerifiedManifestInstallFallbackInterface(manifest.bytes, manifest.signature) !== 1) {
    return none('interface_missing');
  }

  // 4. Every promoted row present names this release (Gate B #6).
  if (promotedRows.length === 0) return none('version_disagreement');
  for (const row of promotedRows) {
    if (`v${row.version.replace(/^v/, '')}` !== identity.release) return none('version_disagreement');
  }

  // The bytes have verified, so reading the entries directly is safe.
  const assets = (JSON.parse(manifest.bytes.toString('utf8')) as { assets: ManifestEntry[] }).assets;
  const entriesNamed = (name: string) => assets.filter((entry) => entry?.name === name);

  // 5. A GitHub source must be the repository the manifest was published for.
  //    A mirror is an operator promise of identical bytes; the hashes enforce it.
  if (source.kind === 'github' && identity.repository.toLowerCase() !== source.repository.toLowerCase()) {
    return none('repository_mismatch');
  }

  // 6. Every consumed asset: unique, distributable, this edition, publisher.
  const hashes = {} as Record<InstallFallbackAssetName, string>;
  const publishers = new Set<string>();
  let publisher: { teamId: string; identity: string } | null = null;
  for (const name of INSTALL_FALLBACK_ASSETS) {
    const matches = entriesNamed(name);
    if (matches.length === 0) return none('asset_missing');
    if (matches.length > 1) return none('asset_duplicate');
    const entry = matches[0]!;

    // Any intendedUse is non-distributable (unknown future values included).
    if (entry.intendedUse !== undefined && entry.intendedUse !== null) return none('signing_input');
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) return none('schema');
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      return none('schema');
    }
    try {
      assertDistributableReleaseAsset({
        assetName: name,
        platformTrust: typeof entry.platformTrust === 'string' ? entry.platformTrust : null,
        intendedUse: null,
        edition: typeof entry.edition === 'string' ? entry.edition : null,
      });
    } catch {
      return none('platform_trust');
    }
    if (entry.edition !== edition) return none('edition_mismatch');

    const isPkg = name.endsWith('.pkg');
    if (isPkg && (entry.signingTeamId === undefined || entry.signingIdentity === undefined)) {
      return none('publisher_missing');
    }

    // The authoritative per-asset verifier, with every check it supports. The
    // pre-checks above make each remaining failure class unambiguous.
    let verified: VerifiedReleaseArtifact;
    try {
      verified = await verifyReleaseArtifactManifestAsset({
        assetName: name,
        manifestBytes: manifest.bytes,
        signatureBytes: manifest.signature,
        expectedRepository: identity.repository,
        expectedRelease: identity.release,
        expectedEdition: edition,
        requireMacosPublisher: isPkg,
      });
    } catch (err) {
      if (err instanceof ReleaseManifestSignatureError) return none('signature');
      if (err instanceof ReleaseManifestAssetAbsentError) return none('asset_missing');
      if (err instanceof ReleaseManifestTooOldError) return none('publisher_missing');
      if (err instanceof ReleaseAssetNotDistributableError) return none('platform_trust');
      // After the pre-checks, a lookup failure on a pkg can only be its
      // publisher identity (readMacosPublisher).
      return none(isPkg ? 'publisher_missing' : 'schema');
    }
    hashes[name] = verified.sha256;
    if (isPkg) {
      if (!verified.signingTeamId || !verified.signingIdentity) return none('publisher_missing');
      publisher = { teamId: verified.signingTeamId, identity: verified.signingIdentity };
      publishers.add(`${publisher.teamId}\n${publisher.identity}`);
    }
  }
  // The anchor carries ONE publisher; two pkgs signed differently cannot be pinned.
  if (publisher === null || publishers.size !== 1) return none('publisher_missing');

  // 7. Platforms commit independently, so a matching version alone does not
  //    prove matching bytes: each row's checksum must equal its raw agent
  //    entry (breeze-agent-<os>-<arch>[.exe]; for macOS the raw binary, not
  //    the pkg). Runs after the asset loop so a missing consumed asset reports
  //    asset_missing, not a row mismatch.
  for (const row of promotedRows) {
    const matches = entriesNamed(rawAgentAssetName(row));
    if (
      matches.length !== 1 ||
      typeof matches[0]!.sha256 !== 'string' ||
      matches[0]!.sha256 !== row.checksum.toLowerCase()
    ) {
      return none('row_checksum_mismatch');
    }
  }

  // 8. Hosted stays dark in W1. W6 replaces this branch with the signed
  //    `distribution` requirement (Gate B #1).
  if (edition === 'hosted') return none('hosted_not_enabled');

  const baseUrl =
    source.kind === 'github'
      ? `https://github.com/${source.repository.toLowerCase()}/releases/download/${identity.release}/`
      : `${source.base}${identity.release}/`;

  const anchor = parseInstallFallback({
    schema: INSTALL_FALLBACK_SCHEMA_VERSION,
    release: identity.release,
    baseUrl,
    validUntil,
    assets: hashes,
    macosPkgPublisher: {
      teamId: publisher.teamId,
      signingIdentityB64: Buffer.from(publisher.identity, 'utf8').toString('base64'),
    },
  });
  return anchor === null ? none('schema') : { anchor, reason: null };
}
