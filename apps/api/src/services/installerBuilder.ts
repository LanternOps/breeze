import archiver from 'archiver';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
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
import { verifyGithubReleaseArtifactBuffer } from './releaseArtifactManifest';
import { isS3Configured } from './s3Storage';

// --- Enrollment key validation ---

const ENROLLMENT_KEY_PATTERN = /^[a-f0-9]{64}$/;

function assertValidEnrollmentKey(key: string): void {
  if (!ENROLLMENT_KEY_PATTERN.test(key)) {
    throw new Error('Invalid enrollment key: must be 64 lowercase hex chars');
  }
}

// --- Windows zip bundle builder (fallback when remote signing service is not configured) ---

function generateWindowsInstallScript(enrollmentKey: string): string {
  return `@echo off
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "ENROLLMENT_JSON=%SCRIPT_DIR%enrollment.json"
set "MSI_PATH=%SCRIPT_DIR%breeze-agent.msi"

if not exist "%ENROLLMENT_JSON%" (
    echo Error: enrollment.json not found
    exit /b 1
)

echo Installing Breeze Agent...
msiexec /i "%MSI_PATH%" /quiet /norestart

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

REM Clean up credentials
del "%ENROLLMENT_JSON%" 2>nul

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

echo "Downloading Breeze Agent installer (\${ARCH})..."
HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "$TMPPKG" "$PKG_URL" 2>/dev/null)" || true
if [ "$HTTP_CODE" != "200" ]; then
  echo "Error: failed to download installer package (HTTP $HTTP_CODE) from $PKG_URL"
  exit 1
fi
if [ ! -s "$TMPPKG" ]; then
  echo "Error: downloaded installer package is empty (architecture \${ARCH} may be unavailable)"
  exit 1
fi

# Verify the package is Apple-notarized and Developer-ID signed BEFORE installing
# as root. The \`installer\` CLI does NOT enforce Gatekeeper/notarization on its
# own (stapling is only checked in the Finder double-click flow), so without this
# an MITM'd or tampered download would be installed with full root privileges.
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

export async function fetchRegularMsi(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubRegularMsiUrl();
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch regular MSI: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    await verifyGithubReleaseArtifactBuffer({
      assetName: 'breeze-agent.msi',
      assetBuffer: buffer,
      manifestUrl: getGithubReleaseArtifactManifestUrl(),
      signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(),
      expectedRepository: getGithubReleaseRepository(),
      expectedRelease: getGithubExpectedReleaseTag(),
      expectedPlatformTrust: 'windows-authenticode-required',
    });
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
  if (getBinarySource() === 'github') {
    for (const arch of arches) {
      const url = getGithubAgentPkgUrl('darwin', arch);
      const resp = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      if (!resp.ok) {
        throw new Error(`macOS ${arch} installer package not reachable: ${resp.status}`);
      }
    }
    return;
  }
  // Local mode: the /download/:os/:arch/pkg endpoint resolves S3 then disk at
  // request time. When S3 is configured we can't verify here without duplicating
  // that logic, so don't false-fail; otherwise confirm both arch packages exist
  // on disk (catches the common "binaries not staged" misconfig).
  if (isS3Configured()) return;
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  for (const arch of arches) {
    await stat(join(binaryDir, `breeze-agent-darwin-${arch}.pkg`));
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
    const resp = await fetch(url, { redirect: 'follow' });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Failed to fetch installer app zip: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    await verifyGithubReleaseArtifactBuffer({
      assetName: 'Breeze Installer.app.zip',
      assetBuffer: buffer,
      manifestUrl: getGithubReleaseArtifactManifestUrl(),
      signatureUrl: getGithubReleaseArtifactManifestSignatureUrl(),
      expectedRepository: getGithubReleaseRepository(),
      expectedRelease: getGithubExpectedReleaseTag(),
      expectedPlatformTrust: 'macos-developer-id-notarization-required',
    });
    return buffer;
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const path = join(binaryDir, 'Breeze Installer.app.zip');
  try {
    return await readFile(path);
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
      const resp = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(5_000),
      });
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
