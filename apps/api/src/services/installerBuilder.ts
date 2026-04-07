import archiver from 'archiver';

const PLACEHOLDER_CHAR_LENGTH = 512;

/** Sentinel strings padded to 512 chars with null bytes -- must match build-msi.ps1 */
export const PLACEHOLDERS = {
  SERVER_URL: '@@BREEZE_SERVER_URL@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0'),
  ENROLLMENT_KEY: '@@BREEZE_ENROLLMENT_KEY@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0'),
  ENROLLMENT_SECRET: '@@BREEZE_ENROLLMENT_SECRET@@'.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0'),
};

interface InstallerValues {
  serverUrl: string;
  enrollmentKey: string;
  enrollmentSecret: string;
}

/**
 * Replace UTF-16LE encoded placeholder sentinels in an MSI buffer with real values.
 * Returns a new buffer of the same size (values are null-padded to match placeholder length).
 */
export function replaceMsiPlaceholders(template: Buffer, values: InstallerValues): Buffer {
  if (template.length < 1024) {
    throw new Error(`Template MSI is suspiciously small (${template.length} bytes) — may be corrupt or a failed download`);
  }

  const result = Buffer.from(template); // copy

  const replacements: Array<{ name: string; sentinel: string; value: string }> = [
    { name: 'SERVER_URL', sentinel: PLACEHOLDERS.SERVER_URL, value: values.serverUrl },
    { name: 'ENROLLMENT_KEY', sentinel: PLACEHOLDERS.ENROLLMENT_KEY, value: values.enrollmentKey },
    { name: 'ENROLLMENT_SECRET', sentinel: PLACEHOLDERS.ENROLLMENT_SECRET, value: values.enrollmentSecret },
  ];

  for (const { name, sentinel, value } of replacements) {
    if (value.length > PLACEHOLDER_CHAR_LENGTH) {
      throw new Error(`${name} value too long: ${value.length} chars exceeds ${PLACEHOLDER_CHAR_LENGTH} limit`);
    }

    // WiX stores MSI property values as ASCII/UTF-8 in the internal database
    // tables, not UTF-16LE. Try ASCII first, fall back to UTF-16LE for
    // compatibility with any future WiX version changes.
    const sentinelAscii = Buffer.from(sentinel, 'ascii');
    const sentinelUtf16 = Buffer.from(sentinel, 'utf16le');
    let offset = result.indexOf(sentinelAscii);
    let encoding: BufferEncoding = 'ascii';

    if (offset === -1) {
      offset = result.indexOf(sentinelUtf16);
      encoding = 'utf16le';
    }

    if (offset === -1) {
      throw new Error(`${name} placeholder not found in template MSI`);
    }

    const replacementPadded = value.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0');
    const replacementBuf = Buffer.from(replacementPadded, encoding);

    replacementBuf.copy(result, offset);
  }

  return result;
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
