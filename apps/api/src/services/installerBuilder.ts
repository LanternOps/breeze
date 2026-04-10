import archiver from 'archiver';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getBinarySource, getGithubTemplateMsiUrl, getGithubAgentPkgUrl, getGithubRegularMsiUrl } from './binarySource';

const PLACEHOLDER_CHAR_LENGTH = 512;

/** Sentinel strings padded to 512 chars with spaces -- must match build-msi.ps1 */
export const PLACEHOLDERS = {
  SERVER_URL: '@@BREEZE_SERVER_URL@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, ' '),
  ENROLLMENT_KEY: '@@BREEZE_ENROLLMENT_KEY@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, ' '),
  ENROLLMENT_SECRET: '@@BREEZE_ENROLLMENT_SECRET@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, ' '),
};

interface InstallerValues {
  serverUrl: string;
  enrollmentKey: string;
  enrollmentSecret: string;
}

/** Bare sentinel prefixes (without padding) for fallback matching */
const SENTINEL_PREFIXES = {
  SERVER_URL: '@@BREEZE_SERVER_URL@@',
  ENROLLMENT_KEY: '@@BREEZE_ENROLLMENT_KEY@@',
  ENROLLMENT_SECRET: '@@BREEZE_ENROLLMENT_SECRET@@',
};

/**
 * Replace placeholder sentinels in an MSI buffer with real values.
 * Supports space-padded sentinels (new template builds) and unpadded
 * sentinels (older builds where WiX stripped null padding).
 * Returns a new buffer, or null if placeholders can't be found/replaced safely.
 */
export function replaceMsiPlaceholders(template: Buffer, values: InstallerValues): Buffer | null {
  if (template.length < 1024) {
    throw new Error(`Template MSI is suspiciously small (${template.length} bytes) — may be corrupt or a failed download`);
  }

  const result = Buffer.from(template); // copy

  const replacements: Array<{ name: string; sentinel: string; prefix: string; value: string }> = [
    { name: 'SERVER_URL', sentinel: PLACEHOLDERS.SERVER_URL, prefix: SENTINEL_PREFIXES.SERVER_URL, value: values.serverUrl },
    { name: 'ENROLLMENT_KEY', sentinel: PLACEHOLDERS.ENROLLMENT_KEY, prefix: SENTINEL_PREFIXES.ENROLLMENT_KEY, value: values.enrollmentKey },
    { name: 'ENROLLMENT_SECRET', sentinel: PLACEHOLDERS.ENROLLMENT_SECRET, prefix: SENTINEL_PREFIXES.ENROLLMENT_SECRET, value: values.enrollmentSecret },
  ];

  for (const { name, sentinel, prefix, value } of replacements) {
    if (value.length > PLACEHOLDER_CHAR_LENGTH) {
      throw new Error(`${name} value too long: ${value.length} chars exceeds ${PLACEHOLDER_CHAR_LENGTH} limit`);
    }

    // Try full space-padded sentinel (new template builds) in ASCII then UTF-16LE
    const sentinelAscii = Buffer.from(sentinel, 'ascii');
    const sentinelUtf16 = Buffer.from(sentinel, 'utf16le');
    let offset = result.indexOf(sentinelAscii);
    let encoding: BufferEncoding = 'ascii';
    let sentinelLen = sentinelAscii.length;

    if (offset === -1) {
      offset = result.indexOf(sentinelUtf16);
      encoding = 'utf16le';
      sentinelLen = sentinelUtf16.length;
    }

    // Fallback: try unpadded prefix (old template where WiX stripped null padding)
    if (offset === -1) {
      const prefixAscii = Buffer.from(prefix, 'ascii');
      offset = result.indexOf(prefixAscii);
      if (offset !== -1) {
        encoding = 'ascii';
        sentinelLen = prefixAscii.length;
        // Can only replace if value fits in the sentinel's footprint
        if (Buffer.from(value, 'ascii').length > sentinelLen) {
          console.warn(`[installer] ${name}: value (${value.length} chars) exceeds unpadded sentinel (${prefix.length} chars) — cannot do in-place MSI replacement`);
          return null;
        }
      }
    }

    if (offset === -1) {
      console.warn(`[installer] ${name} placeholder not found in template MSI`);
      return null;
    }

    // Pad replacement with spaces (matches template build-msi.ps1). Null
    // padding would be read back by MSI as U+0000 and truncate the string
    // when it's expanded into a command line for deferred custom actions,
    // silently losing the ENROLLMENT_KEY/ENROLLMENT_SECRET fields that come
    // after SERVER_URL in CustomActionData.
    const replacementPadded = value.padEnd(PLACEHOLDER_CHAR_LENGTH, ' ');
    const replacementBuf = Buffer.from(replacementPadded, encoding);
    // Only write up to the sentinel length to avoid overwriting adjacent data
    const writeLen = Math.min(replacementBuf.length, sentinelLen);
    replacementBuf.copy(result, offset, 0, writeLen);

    // Post-patch validation: decode the sentinel region back and verify it
    // round-trips to the expected value with no embedded nulls. Null bytes
    // in the padding truncate command-line arguments when MSI expands this
    // property into a deferred custom action's CustomActionData.
    const decoded = result.slice(offset, offset + writeLen).toString(encoding);
    if (decoded.includes('\0')) {
      throw new Error(`[installer] ${name}: patched region contains null characters — would truncate downstream (bug in replacement logic)`);
    }
    if (decoded.trimEnd() !== value) {
      throw new Error(`[installer] ${name}: post-patch round-trip failed — expected ${JSON.stringify(value)}, got ${JSON.stringify(decoded.trimEnd())}`);
    }
  }

  return result;
}

// --- Windows zip bundle builder (fallback when MSI placeholder replacement fails) ---

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

# Read enrollment config (macOS ships python3)
SERVER_URL=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['serverUrl'])" "$ENROLLMENT_JSON")
ENROLLMENT_KEY=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['enrollmentKey'])" "$ENROLLMENT_JSON")
ENROLLMENT_SECRET=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('enrollmentSecret',''))" "$ENROLLMENT_JSON")
SITE_ID=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('siteId',''))" "$ENROLLMENT_JSON")

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

export async function fetchTemplateMsi(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubTemplateMsiUrl();
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch template MSI: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFile(join(binaryDir, 'breeze-agent-template.msi'));
}

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
