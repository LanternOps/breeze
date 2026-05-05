import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PUBLIC_KEY_ENV_NAMES = [
  "RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS",
  "BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS",
];

type ReleaseArtifactManifestAsset = {
  name?: unknown;
  sha256?: unknown;
  size?: unknown;
  platformTrust?: unknown;
};

type ReleaseArtifactManifest = {
  schemaVersion?: unknown;
  repository?: unknown;
  release?: unknown;
  assets?: unknown;
};

type SelectedReleaseArtifactManifestAsset = ReleaseArtifactManifestAsset & {
  sha256: string;
  size: number;
};

export type VerifiedReleaseArtifact = {
  assetName: string;
  sha256: string;
  size: number;
  release: string;
  repository: string;
  platformTrust: string | null;
};

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function getConfiguredPublicKeyStrings(): string[] {
  return PUBLIC_KEY_ENV_NAMES.map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function publicKeyFromRawEd25519(rawKey: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]),
    format: "der",
    type: "spki",
  });
}

function parsePublicKey(value: string): KeyObject | null {
  try {
    if (value.includes("BEGIN PUBLIC KEY")) {
      return createPublicKey(value);
    }

    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) {
      return publicKeyFromRawEd25519(decoded);
    }

    return createPublicKey({ key: decoded, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

function getConfiguredPublicKeys(): KeyObject[] {
  const configured = getConfiguredPublicKeyStrings();
  const parsed = configured.map(parsePublicKey);
  if (configured.length > 0 && parsed.some((key) => key === null)) {
    throw new Error(
      "Release artifact manifest public key configuration is invalid",
    );
  }
  return parsed.filter((key): key is KeyObject => key !== null);
}

export function isReleaseArtifactManifestVerificationConfigured(): boolean {
  return getConfiguredPublicKeyStrings().length > 0;
}

function releaseArtifactManifestVerificationRequired(): boolean {
  const mode =
    process.env.RELEASE_ARTIFACT_MANIFEST_VERIFICATION?.trim().toLowerCase();
  if (mode === "required" || mode === "true" || mode === "1") {
    return true;
  }
  return process.env.NODE_ENV === "production";
}

function parseSignature(signatureBytes: Buffer): Buffer {
  const trimmed = signatureBytes.toString("utf8").trim();
  const signature = Buffer.from(trimmed, "base64");
  if (signature.length !== 64) {
    throw new Error(
      "Release artifact manifest signature must be a base64 Ed25519 signature",
    );
  }
  return signature;
}

function verifyManifestSignature(
  manifestBytes: Buffer,
  signatureBytes: Buffer,
): void {
  const publicKeys = getConfiguredPublicKeys();
  if (publicKeys.length === 0) {
    throw new Error("Release artifact manifest public key is not configured");
  }

  const signature = parseSignature(signatureBytes);
  const trusted = publicKeys.some((publicKey) => {
    try {
      return verifySignature(null, manifestBytes, publicKey, signature);
    } catch {
      return false;
    }
  });

  if (!trusted) {
    throw new Error("Release artifact manifest signature verification failed");
  }
}

function parseManifest(manifestBytes: Buffer): ReleaseArtifactManifest {
  let parsed: ReleaseArtifactManifest;
  try {
    parsed = JSON.parse(
      manifestBytes.toString("utf8"),
    ) as ReleaseArtifactManifest;
  } catch {
    throw new Error("Release artifact manifest is not valid JSON");
  }

  if (
    parsed.schemaVersion !== 1 ||
    typeof parsed.repository !== "string" ||
    typeof parsed.release !== "string" ||
    !Array.isArray(parsed.assets)
  ) {
    throw new Error("Release artifact manifest has an invalid schema");
  }

  return parsed;
}

function assertStringEqual(
  actual: unknown,
  expected: string,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `Release artifact manifest ${label} mismatch: expected ${expected}, got ${String(actual)}`,
    );
  }
}

function assertSha256Equal(
  actual: string,
  expected: string,
  assetName: string,
): void {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (
    actualBuffer.length !== 32 ||
    expectedBuffer.length !== 32 ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error(
      `Release artifact digest mismatch for ${assetName}: expected ${expected}, got ${actual}`,
    );
  }
}

export async function verifyReleaseArtifactBuffer(args: {
  assetName: string;
  assetBuffer: Buffer;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
}): Promise<VerifiedReleaseArtifact> {
  verifyManifestSignature(args.manifestBytes, args.signatureBytes);
  const manifest = parseManifest(args.manifestBytes);
  const entry = selectManifestAsset({
    manifest,
    assetName: args.assetName,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
  });

  if (entry.size !== args.assetBuffer.length) {
    throw new Error(
      `Release artifact size mismatch for ${args.assetName}: expected ${entry.size}, got ${args.assetBuffer.length}`,
    );
  }

  const actualSha256 = sha256Hex(args.assetBuffer);
  assertSha256Equal(actualSha256, entry.sha256, args.assetName);

  return {
    assetName: args.assetName,
    sha256: actualSha256,
    size: args.assetBuffer.length,
    release: manifest.release as string,
    repository: manifest.repository as string,
    platformTrust:
      typeof entry.platformTrust === "string" ? entry.platformTrust : null,
  };
}

function selectManifestAsset(args: {
  manifest: ReleaseArtifactManifest;
  assetName: string;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
}): SelectedReleaseArtifactManifestAsset {
  const { manifest } = args;
  if (args.expectedRepository) {
    assertStringEqual(
      manifest.repository,
      args.expectedRepository,
      "repository",
    );
  }
  if (args.expectedRelease) {
    assertStringEqual(manifest.release, args.expectedRelease, "release");
  }

  const assets = manifest.assets as ReleaseArtifactManifestAsset[];
  const entry = assets.find((candidate) => candidate.name === args.assetName);
  if (!entry) {
    throw new Error(
      `Release artifact manifest does not include ${args.assetName}`,
    );
  }
  if (
    typeof entry.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  ) {
    throw new Error(
      `Release artifact manifest has invalid sha256 for ${args.assetName}`,
    );
  }
  if (
    typeof entry.size !== "number" ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 0
  ) {
    throw new Error(
      `Release artifact manifest has invalid size for ${args.assetName}`,
    );
  }
  if (
    args.expectedPlatformTrust &&
    entry.platformTrust !== args.expectedPlatformTrust
  ) {
    throw new Error(
      `Release artifact manifest platform trust mismatch for ${args.assetName}: expected ${args.expectedPlatformTrust}, got ${String(entry.platformTrust)}`,
    );
  }

  return {
    ...entry,
    sha256: entry.sha256,
    size: entry.size,
  };
}

export async function verifyReleaseArtifactManifestAsset(args: {
  assetName: string;
  manifestBytes: Buffer;
  signatureBytes: Buffer;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
}): Promise<VerifiedReleaseArtifact> {
  verifyManifestSignature(args.manifestBytes, args.signatureBytes);
  const manifest = parseManifest(args.manifestBytes);
  const entry = selectManifestAsset({
    manifest,
    assetName: args.assetName,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
  });
  return {
    assetName: args.assetName,
    sha256: entry.sha256,
    size: entry.size,
    release: manifest.release as string,
    repository: manifest.repository as string,
    platformTrust:
      typeof entry.platformTrust === "string" ? entry.platformTrust : null,
  };
}

async function fetchSmallBuffer(url: string, label: string): Promise<Buffer> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${label}: ${resp.status}`);
  }

  const contentLength = Number(resp.headers.get("content-length") || "0");
  if (contentLength > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} is too large`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_MANIFEST_BYTES) {
    throw new Error(`${label} is too large`);
  }
  return buffer;
}

export async function verifyGithubReleaseArtifactBuffer(args: {
  assetName: string;
  assetBuffer: Buffer;
  manifestUrl: string;
  signatureUrl: string;
  expectedRepository?: string;
  expectedRelease?: string | null;
  expectedPlatformTrust?: string;
}): Promise<VerifiedReleaseArtifact | null> {
  if (!isReleaseArtifactManifestVerificationConfigured()) {
    if (releaseArtifactManifestVerificationRequired()) {
      throw new Error(
        "Release artifact manifest public key is required for GitHub fallback asset verification in production",
      );
    }
    return null;
  }

  const [manifestBytes, signatureBytes] = await Promise.all([
    fetchSmallBuffer(args.manifestUrl, "release artifact manifest"),
    fetchSmallBuffer(
      args.signatureUrl,
      "release artifact manifest Ed25519 signature",
    ),
  ]);

  return verifyReleaseArtifactBuffer({
    assetName: args.assetName,
    assetBuffer: args.assetBuffer,
    manifestBytes,
    signatureBytes,
    expectedRepository: args.expectedRepository,
    expectedRelease: args.expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
  });
}
