import archiver from 'archiver';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getBinarySource, getGithubAgentPkgUrl, getGithubInstallerAppUrl, getGithubRegularMsiUrl } from './binarySource';

// --- Windows zip bundle builder (fallback when remote signing service is not configured) ---

const WINDOWS_INSTALL_SCRIPT = `@echo off
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
    if "!key!"=="enrollmentKey" set "ENROLLMENT_KEY=!val!"
    if "!key!"=="enrollmentSecret" set "ENROLLMENT_SECRET=!val!"
)

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
    archive.append(WINDOWS_INSTALL_SCRIPT, { name: 'install.bat' });

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

# Install the PKG
echo "Installing Breeze Agent..."
sudo installer -pkg "$SCRIPT_DIR/breeze-agent.pkg" -target /

# Read enrollment config via plutil (ships with macOS, no Xcode CLT required).
# /usr/bin/python3 is only a stub on fresh Macs and triggers the "requires developer tools" popup.
SERVER_URL=$(plutil -extract serverUrl raw -o - "$ENROLLMENT_JSON")
ENROLLMENT_KEY=$(plutil -extract enrollmentKey raw -o - "$ENROLLMENT_JSON")
ENROLLMENT_SECRET=$(plutil -extract enrollmentSecret raw -o - "$ENROLLMENT_JSON" 2>/dev/null || echo "")
SITE_ID=$(plutil -extract siteId raw -o - "$ENROLLMENT_JSON" 2>/dev/null || echo "")

# Build enrollment command
ENROLL_ARGS=("$ENROLLMENT_KEY" --server "$SERVER_URL")
[ -n "$ENROLLMENT_SECRET" ] && ENROLL_ARGS+=(--enrollment-secret "$ENROLLMENT_SECRET")
[ -n "$SITE_ID" ] && ENROLL_ARGS+=(--site-id "$SITE_ID")

echo "Enrolling agent..."
sudo /usr/local/bin/breeze-agent enroll "${'$'}{ENROLL_ARGS[@]}"

# Clean up credentials
rm -f "$ENROLLMENT_JSON"

echo "Breeze agent installed and enrolled successfully."
`;

interface MacosZipValues {
  serverUrl: string;
  enrollmentKey: string;
  enrollmentSecret: string;
  siteId: string;
}

export async function buildMacosInstallerZip(
  pkgBuffer: Buffer,
  values: MacosZipValues
): Promise<Buffer> {
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

    archive.append(pkgBuffer, { name: 'breeze-agent.pkg' });

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
    return Buffer.from(await resp.arrayBuffer());
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFile(join(binaryDir, 'breeze-agent.msi'));
}

export async function fetchMacosPkg(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubAgentPkgUrl('darwin', 'arm64');
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch macOS PKG: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFile(join(binaryDir, 'breeze-agent-darwin-arm64.pkg'));
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
    return Buffer.from(await resp.arrayBuffer());
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
