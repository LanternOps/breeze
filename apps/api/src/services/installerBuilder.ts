import type { Context } from 'hono';
import archiver from 'archiver';
import type { Readable } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import {
  getBinarySource,
  getGithubAgentPkgUrl,
  getGithubExpectedReleaseTag,
  getGithubInstallerAppUrl,
  getGithubRegularMsiUrl,
  getGithubReleaseArtifactManifestSignatureUrl,
  getGithubReleaseArtifactManifestUrl,
  getGithubReleaseRepository,
} from './binarySource';
import {
  fetchVerifiedGithubReleaseArtifact,
  probeSafeReleaseArtifact,
  verifyGithubReleaseArtifactBuffer,
  verifyReleaseArtifactBuffer,
  verifyReleaseArtifactManifestAsset,
  type VerifiedReleaseArtifact,
} from './releaseArtifactManifest';
import { assertGithubFetchableEdition } from './releaseAssetTrust';
import { getBinaryEdition } from './binaryEdition';
import {
  InstallerFilenameHostError,
  isEncodedWindowsFilenameApiHost,
} from './installerFilenameHost';
import { getObjectStream, isS3Configured } from './s3Storage';

// --- Enrollment key validation ---

const ENROLLMENT_KEY_PATTERN = /^[a-f0-9]{64}$/;

function assertValidEnrollmentKey(key: string): void {
  if (!ENROLLMENT_KEY_PATTERN.test(key)) {
    throw new Error('Invalid enrollment key: must be 64 lowercase hex chars');
  }
}

// --- Windows zip bundle builder ---

function generateWindowsInstallScript(enrollmentKey: string): string {
  return `@echo off
setlocal EnableDelayedExpansion

REM This installer runs msiexec, which requires elevation. Run unelevated it
REM silently fails, the agent binary never lands in %ProgramFiles%\\Breeze, and
REM the enroll step below then errors with a confusing "path not found" -- yet
REM the script used to still print "installed successfully" (#1832). Fail fast
REM with a clear message instead.
net session >nul 2>&1
if errorlevel 1 (
    echo Error: this installer must be run as Administrator.
    echo Right-click install.bat and choose "Run as administrator", or run it from an elevated command prompt.
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"
set "ENROLLMENT_JSON=%SCRIPT_DIR%enrollment.json"
set "MSI_PATH=%SCRIPT_DIR%breeze-agent.msi"

if not exist "%ENROLLMENT_JSON%" (
    echo Error: enrollment.json not found
    exit /b 1
)

echo Installing Breeze Agent...
msiexec /i "%MSI_PATH%" /quiet /norestart
REM msiexec: 0 = success, 3010 = success but reboot pending; anything else failed.
set "MSI_RC=!errorlevel!"
if not "!MSI_RC!"=="0" if not "!MSI_RC!"=="3010" (
    echo Error: agent installation failed ^(msiexec exit code !MSI_RC!^).
    exit /b 1
)

REM Wait for install to complete
timeout /t 5 /nobreak >nul

REM Read enrollment config and enroll
for /f "usebackq tokens=1,* delims=:" %%a in (\`type "%ENROLLMENT_JSON%"\`) do (
    set "key=%%~a"
    set "val=%%~b"
    set "key=!key: =!"
    set "key=!key:"=!"
    set "val=!val: =!"
    set "val=!val:"=!"
    set "val=!val:,=!"
    if "!key!"=="serverUrl" set "SERVER_URL=!val!"
    if "!key!"=="enrollmentSecret" set "ENROLLMENT_SECRET=!val!"
)

set ENROLLMENT_KEY="${enrollmentKey}"
set ENROLL_CMD="%ProgramFiles%\\Breeze\\breeze-agent.exe" enroll "%ENROLLMENT_KEY%" --server "%SERVER_URL%"
if defined ENROLLMENT_SECRET if not "%ENROLLMENT_SECRET%"=="" (
    set ENROLL_CMD=%ENROLL_CMD% --enrollment-secret "%ENROLLMENT_SECRET%"
)

echo Enrolling agent...
%ENROLL_CMD%
set "ENROLL_RC=!errorlevel!"

REM Clean up credentials regardless of outcome (they must not be left behind).
del "%ENROLLMENT_JSON%" 2>nul

if not "!ENROLL_RC!"=="0" (
    echo Error: agent enrollment failed ^(exit code !ENROLL_RC!^).
    exit /b 1
)

echo Breeze agent installed and enrolled successfully.
`;
}

interface WindowsZipValues {
  serverUrl: string;
  enrollmentKey: string;
  enrollmentSecret: string;
  siteId: string;
}

export async function buildWindowsInstallerZip(
  msiBuffer: Buffer,
  values: WindowsZipValues
): Promise<Buffer> {
  assertValidEnrollmentKey(values.enrollmentKey);
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    archive.append(msiBuffer, { name: 'breeze-agent.msi' });

    const enrollmentJson = JSON.stringify(
      {
        serverUrl: values.serverUrl,
        enrollmentKey: values.enrollmentKey,
        enrollmentSecret: values.enrollmentSecret,
        siteId: values.siteId,
      },
      null,
      2
    );
    archive.append(enrollmentJson, { name: 'enrollment.json' });
    const installScript = generateWindowsInstallScript(values.enrollmentKey);
    archive.append(installScript, { name: 'install.bat' });

    archive.finalize().catch(reject);
  });
}

// --- macOS zip bundle builder ---

const MACOS_INSTALL_SCRIPT = `#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENROLLMENT_JSON="$SCRIPT_DIR/enrollment.json"

if [ ! -f "$ENROLLMENT_JSON" ]; then
  echo "Error: enrollment.json not found in $SCRIPT_DIR"
  exit 1
fi

# Read enrollment config via plutil (ships with macOS, no Xcode CLT required).
# /usr/bin/python3 is only a stub on fresh Macs and triggers the "requires developer tools" popup.
SERVER_URL=$(plutil -extract serverUrl raw -o - "$ENROLLMENT_JSON")
ENROLLMENT_KEY=$(plutil -extract enrollmentKey raw -o - "$ENROLLMENT_JSON")
ENROLLMENT_SECRET=$(plutil -extract enrollmentSecret raw -o - "$ENROLLMENT_JSON" 2>/dev/null || echo "")
SITE_ID=$(plutil -extract siteId raw -o - "$ENROLLMENT_JSON" 2>/dev/null || echo "")
SERVER_URL="\${SERVER_URL%/}"

case "$SERVER_URL" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Error: macOS privileged installer downloads require HTTPS. Refusing insecure transport."; exit 1 ;;
esac

# Detect CPU architecture so Intel and Apple Silicon Macs each receive a
# compatible binary. A single-arch bundle cannot serve both, and shipping the
# wrong one causes "Bad CPU type in executable" on enroll (the bug this fixes).
case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Error: unsupported CPU architecture: $(uname -m)"; exit 1 ;;
esac

# Download the architecture-matched installer package from the server.
# Clean up BOTH the temp pkg and the credential file on any exit — every guard
# below can abort under \`set -e\`, and enrollment.json holds the enrollment
# secret, so it must never be left behind in the extracted download folder.
PKG_URL="\${SERVER_URL}/api/v1/agents/download/darwin/\${ARCH}/pkg"
TMPPKG_DIR="$(mktemp -d)"
trap 'rm -rf "$TMPPKG_DIR"; rm -f "$ENROLLMENT_JSON"' EXIT
TMPPKG="$TMPPKG_DIR/breeze-agent.pkg"
PKG_HEADERS="$TMPPKG_DIR/headers"

echo "Downloading Breeze Agent installer (\${ARCH})..."
HTTP_CODE="$(curl -fsSL -D "$PKG_HEADERS" -w '%{http_code}' -o "$TMPPKG" "$PKG_URL" 2>/dev/null)" || true
if [ "$HTTP_CODE" != "200" ]; then
  echo "Error: failed to download installer package (HTTP $HTTP_CODE) from $PKG_URL"
  exit 1
fi
if [ ! -s "$TMPPKG" ]; then
  echo "Error: downloaded installer package is empty (architecture \${ARCH} may be unavailable)"
  exit 1
fi

header_value() {
  grep -i "^$1:" "$PKG_HEADERS" | tail -1 | cut -d ':' -f 2- | sed -e 's/^[[:space:]]*//' -e 's/\r$//' || true
}
EXPECTED_SHA256="$(header_value X-Breeze-Artifact-SHA256)"
EXPECTED_TEAM_ID="$(header_value X-Breeze-MacOS-Team-ID)"
EXPECTED_SIGNING_IDENTITY_B64="$(header_value X-Breeze-MacOS-Signing-Identity-Base64)"
EXPECTED_SIGNING_IDENTITY="$(printf '%s' "$EXPECTED_SIGNING_IDENTITY_B64" | /usr/bin/base64 -D 2>/dev/null || true)"
if ! [[ "$EXPECTED_SHA256" =~ ^[a-f0-9]{64}$ ]] ||
   ! [[ "$EXPECTED_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] ||
   [ -z "$EXPECTED_SIGNING_IDENTITY" ]; then
  echo "Error: server did not provide authenticated installer metadata. Refusing to install."
  exit 1
fi
ACTUAL_SHA256="$(shasum -a 256 "$TMPPKG" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Error: installer package checksum verification failed. Refusing to install."
  exit 1
fi

# Verify the package is Apple-notarized and Developer-ID signed BEFORE installing
# as root. The \`installer\` CLI does NOT enforce Gatekeeper/notarization on its
# own (stapling is only checked in the Finder double-click flow), so without this
# an MITM'd or tampered download would be installed with full root privileges.
SIGNATURE_DETAILS="$(pkgutil --check-signature "$TMPPKG" 2>&1)" || {
  echo "Error: installer package signature is invalid. Refusing to install."
  exit 1
}
ACTUAL_SIGNING_IDENTITY="$(printf '%s\n' "$SIGNATURE_DETAILS" | sed -n 's/^[[:space:]]*1\. //p' | head -1)"
if [ "$ACTUAL_SIGNING_IDENTITY" != "$EXPECTED_SIGNING_IDENTITY" ] ||
   [[ "$ACTUAL_SIGNING_IDENTITY" != *" ($EXPECTED_TEAM_ID)" ]]; then
  echo "Error: installer package publisher identity does not match the signed release policy. Refusing to install."
  exit 1
fi
if ! spctl --assess --type install "$TMPPKG" >/dev/null 2>&1; then
  echo "Error: installer package failed Gatekeeper notarization assessment. Refusing to install."
  exit 1
fi

# Install the PKG
echo "Installing Breeze Agent..."
sudo installer -pkg "$TMPPKG" -target /

# Build enrollment command
ENROLL_ARGS=("$ENROLLMENT_KEY" --server "$SERVER_URL")
[ -n "$ENROLLMENT_SECRET" ] && ENROLL_ARGS+=(--enrollment-secret "$ENROLLMENT_SECRET")
[ -n "$SITE_ID" ] && ENROLL_ARGS+=(--site-id "$SITE_ID")

echo "Enrolling agent..."
sudo /usr/local/bin/breeze-agent enroll "\${ENROLL_ARGS[@]}"

# Restart the service so it picks up the new enrollment config. Surface a failure
# rather than swallowing it — a silent kickstart failure leaves an enrolled
# device that never checks in, with the user told everything succeeded.
if ! sudo launchctl kickstart -k system/com.breeze.agent 2>/dev/null; then
  echo "Note: could not restart the agent service automatically; it will start on next login or reboot."
fi

# Credentials are removed by the EXIT trap above.
echo "Breeze agent installed and enrolled successfully."
`;

interface MacosZipValues {
  serverUrl: string;
  enrollmentKey: string;
  enrollmentSecret: string;
  siteId: string;
}

// The pkg is no longer bundled — install.sh downloads the architecture-matched
// package at install time, so one zip works on both Intel and Apple Silicon.
export async function buildMacosInstallerZip(
  values: MacosZipValues
): Promise<Buffer> {
  assertValidEnrollmentKey(values.enrollmentKey);
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`Zip archive warning (entry missing): ${err.message}`));
      } else {
        console.error('[installer] Archiver warning during macOS zip build:', err);
      }
    });

    const enrollmentJson = JSON.stringify(
      {
        serverUrl: values.serverUrl,
        enrollmentKey: values.enrollmentKey,
        enrollmentSecret: values.enrollmentSecret,
        siteId: values.siteId,
      },
      null,
      2
    );
    archive.append(enrollmentJson, { name: 'enrollment.json' });
    archive.append(MACOS_INSTALL_SCRIPT, { name: 'install.sh', mode: 0o755 });

    archive.finalize().catch(reject);
  });
}

// --- Binary fetch helpers (moved from enrollmentKeys.ts) ---

const MAX_MACOS_INSTALLER_BYTES = 128 * 1024 * 1024;
const MACOS_PLATFORM_TRUST = 'macos-developer-id-notarization-required';
const VERIFIED_MACOS_PKG_CACHE_MS = 5 * 60 * 1000;
const verifiedMacosPkgCache = new Map<
  'amd64' | 'arm64',
  { expiresAt: number; value: Promise<VerifiedMacosPackage> }
>();

export function __resetVerifiedMacosPkgCache(): void {
  verifiedMacosPkgCache.clear();
}

export interface VerifiedMacosPackage {
  buffer: Buffer;
  artifact: VerifiedReleaseArtifact;
}

function localReleaseManifestPaths(binaryDir: string): {
  manifestPath: string;
  signaturePath: string;
} {
  const root = dirname(resolve(binaryDir));
  return {
    manifestPath: join(root, 'release-artifact-manifest.json'),
    signaturePath: join(root, 'release-artifact-manifest.json.ed25519'),
  };
}

async function readBoundedStream(
  stream: Readable,
  expectedSize: number,
  assetName: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > expectedSize) {
      stream.destroy();
      throw new Error(`Release artifact ${assetName} exceeded its signed size`);
    }
    chunks.push(bytes);
  }
  if (size !== expectedSize) {
    throw new Error(
      `Release artifact ${assetName} size mismatch: expected ${expectedSize}, got ${size}`,
    );
  }
  return Buffer.concat(chunks, size);
}

async function loadLocalManifestPair(binaryDir: string): Promise<{
  manifestBytes: Buffer;
  signatureBytes: Buffer;
}> {
  const paths = localReleaseManifestPaths(binaryDir);
  try {
    const [manifestBytes, signatureBytes] = await Promise.all([
      readFile(paths.manifestPath),
      readFile(paths.signaturePath),
    ]);
    return { manifestBytes, signatureBytes };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Signed release manifest pair is not staged for local installers');
    }
    throw err;
  }
}

async function fetchVerifiedLocalArtifact(args: {
  assetName: string;
  diskPath: string;
  s3Key?: string;
  expectedPlatformTrust: string;
  requireMacosPublisher: boolean;
}): Promise<{ buffer: Buffer; verified: VerifiedReleaseArtifact }> {
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const { manifestBytes, signatureBytes } = await loadLocalManifestPair(binaryDir);
  const expectedRepository = getGithubReleaseRepository();
  const expectedRelease = getGithubExpectedReleaseTag();
  const expectedEdition = getBinaryEdition();
  const selected = await verifyReleaseArtifactManifestAsset({
    assetName: args.assetName,
    manifestBytes,
    signatureBytes,
    expectedRepository,
    expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
    expectedEdition,
    requireMacosPublisher: args.requireMacosPublisher,
  });
  if (selected.size <= 0 || selected.size > MAX_MACOS_INSTALLER_BYTES) {
    throw new Error(`Release artifact ${args.assetName} is outside the allowed size range`);
  }

  let buffer: Buffer | null = null;
  if (args.s3Key && isS3Configured()) {
    const remote = await getObjectStream(args.s3Key);
    if (remote.body) {
      if (remote.contentLength !== null && remote.contentLength !== selected.size) {
        remote.body.destroy();
        throw new Error(
          `Release artifact ${args.assetName} content length does not match its signed size`,
        );
      }
      buffer = await readBoundedStream(remote.body, selected.size, args.assetName);
    }
  }
  if (!buffer) {
    const diskStat = await stat(args.diskPath);
    if (diskStat.size !== selected.size || diskStat.size > MAX_MACOS_INSTALLER_BYTES) {
      throw new Error(`Release artifact ${args.assetName} disk size does not match its signed size`);
    }
    buffer = await readFile(args.diskPath);
  }

  const verified = await verifyReleaseArtifactBuffer({
    assetName: args.assetName,
    assetBuffer: buffer,
    manifestBytes,
    signatureBytes,
    expectedRepository,
    expectedRelease,
    expectedPlatformTrust: args.expectedPlatformTrust,
    expectedEdition,
    requireMacosPublisher: args.requireMacosPublisher,
  });
  return { buffer, verified };
}

export async function fetchVerifiedMacosPkg(
  arch: 'amd64' | 'arm64',
): Promise<VerifiedMacosPackage> {
  const cached = verifiedMacosPkgCache.get(arch);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = fetchVerifiedMacosPkgUncached(arch).catch((err) => {
    verifiedMacosPkgCache.delete(arch);
    throw err;
  });
  verifiedMacosPkgCache.set(arch, {
    expiresAt: Date.now() + VERIFIED_MACOS_PKG_CACHE_MS,
    value,
  });
  return value;
}

async function fetchVerifiedMacosPkgUncached(
  arch: 'amd64' | 'arm64',
): Promise<VerifiedMacosPackage> {
  const assetName = `breeze-agent-darwin-${arch}.pkg`;
  if (getBinarySource() === 'github') {
    const result = await fetchVerifiedGithubReleaseArtifact({
      assetName,
      assetUrl: getGithubAgentPkgUrl('darwin', arch),
      manifestUrl: getGithubReleaseArtifactManifestUrl(),
      signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(),
      expectedRepository: getGithubReleaseRepository(),
      expectedRelease: getGithubExpectedReleaseTag(),
      expectedPlatformTrust: MACOS_PLATFORM_TRUST,
      expectedEdition: 'self-host',
      requireMacosPublisher: true,
      maxAssetBytes: MAX_MACOS_INSTALLER_BYTES,
    });
    assertGithubFetchableEdition({ assetName, edition: result.verified.edition });
    return { buffer: result.buffer, artifact: result.verified };
  }

  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const result = await fetchVerifiedLocalArtifact({
    assetName,
    diskPath: join(binaryDir, assetName),
    s3Key: `agent/${assetName}`,
    expectedPlatformTrust: MACOS_PLATFORM_TRUST,
    requireMacosPublisher: true,
  });
  return { buffer: result.buffer, artifact: result.verified };
}

export async function fetchRegularMsi(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubRegularMsiUrl();
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch regular MSI: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    // No expectedPlatformTrust here: the public self-host release ships this
    // MSI unsigned (platformTrust "none") by default, while a BYO-re-signed
    // repo still ships it Authenticode-signed. Both are legitimate for
    // edition "self-host" — the edition-aware accept/reject decision lives in
    // assertDistributableReleaseAsset (releaseAssetTrust.ts), which
    // verifyGithubReleaseArtifactBuffer runs on every manifest-verified asset.
    const verified = await verifyGithubReleaseArtifactBuffer({
      assetName: 'breeze-agent.msi',
      assetBuffer: buffer,
      manifestUrl: getGithubReleaseArtifactManifestUrl(),
      signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(),
      expectedRepository: getGithubReleaseRepository(),
      expectedRelease: getGithubExpectedReleaseTag(),
    });
    if (verified) {
      assertGithubFetchableEdition({ assetName: 'breeze-agent.msi', edition: verified.edition });
    }
    return buffer;
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFile(join(binaryDir, 'breeze-agent.msi'));
}

/**
 * Pre-flight reachability check for the macOS installer, run at link-creation
 * time so a broken installer fails fast for the admin instead of silently at
 * install time on the end user's Mac. The installer downloads the arch-matched
 * pkg at install time, so BOTH architectures are validated here (not just arm64
 * — an amd64-only outage must not pass a probe that Intel customers then hit).
 */
export async function assertMacosInstallerPkgsReachable(): Promise<void> {
  const arches = ['amd64', 'arm64'] as const;
  for (const arch of arches) {
    try {
      await fetchVerifiedMacosPkg(arch);
    } catch (err) {
      throw new Error(`macOS ${arch} installer package failed release verification`, {
        cause: err,
      });
    }
  }
}

/**
 * Fetches the notarized Breeze Installer.app.zip from the GitHub release.
 * Returns null if the asset is not available (e.g. first release after
 * Plan B merged but before the next tag is cut). Caller falls back to
 * the legacy install.sh zip in that case.
 */
export async function fetchMacosInstallerAppZip(): Promise<Buffer | null> {
  if (getBinarySource() === 'github') {
    const url = getGithubInstallerAppUrl();
    let result: Awaited<ReturnType<typeof fetchVerifiedGithubReleaseArtifact>>;
    try {
      result = await fetchVerifiedGithubReleaseArtifact({
        assetName: 'Breeze Installer.app.zip',
        assetUrl: url,
        manifestUrl: getGithubReleaseArtifactManifestUrl(),
        signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(),
        expectedRepository: getGithubReleaseRepository(),
        expectedRelease: getGithubExpectedReleaseTag(),
        expectedPlatformTrust: 'macos-developer-id-notarization-required',
        expectedEdition: 'self-host',
        maxAssetBytes: MAX_MACOS_INSTALLER_BYTES,
      });
    } catch (err) {
      if (err instanceof Error && /status 404$/.test(err.message)) return null;
      throw err;
    }
    if (result.verified) {
      assertGithubFetchableEdition({
        assetName: 'Breeze Installer.app.zip',
        edition: result.verified.edition,
      });
    }
    return result.buffer;
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const path = join(binaryDir, 'Breeze Installer.app.zip');
  try {
    await stat(path);
    const result = await fetchVerifiedLocalArtifact({
      assetName: 'Breeze Installer.app.zip',
      diskPath: path,
      expectedPlatformTrust: MACOS_PLATFORM_TRUST,
      requireMacosPublisher: false,
    });
    return result.buffer;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * HEAD probe for the installer app asset. Mirrors probeMacosPkg.
 * Returns true if reachable, false if 404, throws otherwise.
 */
export async function probeMacosInstallerApp(): Promise<boolean> {
  if (getBinarySource() === 'github') {
    const url = getGithubInstallerAppUrl();
    try {
      const resp = await probeSafeReleaseArtifact(url);
      if (resp.status === 404) return false;
      return resp.ok;
    } catch (err) {
      console.warn('[installer] probeMacosInstallerApp: GitHub HEAD failed, treating as unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  try {
    await stat(join(binaryDir, 'Breeze Installer.app.zip'));
    return true;
  } catch (err) {
    console.warn('[installer] probeMacosInstallerApp: filesystem stat failed, treating as unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Serves the static, CI-signed MSI with the bootstrap token embedded in the
 * download filename — the Windows analogue of the macOS renamed-app zip. The
 * MSI bytes are never modified, so the Authenticode signature stays intact and
 * every customer shares one file hash (SmartScreen reputation accrues).
 *
 * The token is wrapped in PARENTHESES, not square brackets. At install time the
 * download path travels through MSI's Formatted-field engine (OriginalDatabase
 * -> SetBootstrapData -> CustomActionData), and a "[...]" substring (brackets
 * are that engine's property-reference delimiter) gets stripped along the way,
 * silently dropping the token — agents then log "no bootstrap token present"
 * and never enroll (observed in #1956). Parens are not special in MSI Formatted
 * fields, so they survive. The agent parser (installer_filename.go) accepts
 * both forms; the macOS download carries the token in bootstrap.json instead.
 *
 * `apiHost` must already be in the encoded filename form produced by
 * windowsFilenameApiHost() — `host` or `host_PORT`, never `host:port`. A `:`
 * is illegal in Windows filenames: the browser rewrites it at save time, the
 * agent parser stops matching, and the install silently never enrolls
 * (#2341). Reject outright rather than serve an MSI that cannot enroll.
 * Callers pre-validate via windowsFilenameApiHost(), so this throw should be
 * unreachable; if it ever fires it surfaces through the app's generic
 * onError handler as a 500 (with Sentry capture), not the friendly 400 the
 * routes return for an invalid configured URL.
 */
export function serveWindowsBootstrapMsi(
  c: Context,
  args: { msi: Buffer; token: string; apiHost: string },
): Response {
  if (!isEncodedWindowsFilenameApiHost(args.apiHost)) {
    throw new InstallerFilenameHostError(
      `apiHost "${args.apiHost}" is not safe for a Windows installer filename`,
    );
  }
  const filename = `Breeze Agent (${args.token}@${args.apiHost}).msi`;
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Content-Length', String(args.msi.length));
  c.header('Cache-Control', 'no-store');
  return c.body(args.msi as unknown as ArrayBuffer);
}
