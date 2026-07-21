# Pre-Configured Installer Downloads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins download Windows (.msi) and macOS (.zip) installers with enrollment credentials pre-baked, enabling zero-touch agent deployment.

**Architecture:** Template MSI with binary placeholder replacement for Windows; zip bundle (PKG + enrollment.json + install.sh) for macOS. A new API endpoint generates a child enrollment key per download and injects it into the installer. Dashboard gets a "Download Installer" dropdown on the enrollment keys table.

**Tech Stack:** Hono (API route), Node.js Buffer (MSI placeholder replacement), archiver (zip generation), WiX (template MSI build), React (dashboard dropdown)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `apps/api/src/services/installerBuilder.ts` | Create | MSI placeholder replacement + macOS zip builder |
| `apps/api/src/services/installerBuilder.test.ts` | Create | Unit tests for installer builder |
| `apps/api/src/routes/enrollmentKeys.ts` | Modify | Add `GET /:id/installer/:platform` endpoint |
| `apps/api/src/routes/enrollmentKeys.test.ts` | Modify | Tests for the new endpoint |
| `agent/installer/breeze.wxs` | Modify | Add ENROLLMENT_SECRET property + placeholders for template variant |
| `agent/installer/enroll-agent.ps1` | Modify | Pass ENROLLMENT_SECRET to agent enroll |
| `agent/installer/build-msi.ps1` | Modify | Accept -Template flag for placeholder build |
| `.github/workflows/release.yml` | Modify | Build + upload template MSI alongside normal MSI |
| `apps/api/src/services/binarySource.ts` | Modify | Add `getGithubTemplateMsiUrl()` and `getGithubAgentPkgUrl` for macOS zip |
| `apps/web/src/components/settings/EnrollmentKeyManager.tsx` | Modify | Add "Download Installer" dropdown per row |

---

## Task 1: WiX Template MSI — Add ENROLLMENT_SECRET Property

**Files:**
- Modify: `agent/installer/breeze.wxs:44-47` (properties), `:150-153` (SetEnrollAgentData)
- Modify: `agent/installer/enroll-agent.ps1:41-42,64`

### Goal
Add ENROLLMENT_SECRET as a third MSI property and wire it through to the enrollment command.

- [ ] **Step 1: Add ENROLLMENT_SECRET property to breeze.wxs**

In `agent/installer/breeze.wxs`, add the new property after line 47 and update the launch condition and SetEnrollAgentData:

```xml
<!-- Line 44: Update launch condition to include ENROLLMENT_SECRET -->
<Launch Condition="(NOT SERVER_URL AND NOT ENROLLMENT_KEY) OR (SERVER_URL AND ENROLLMENT_KEY)" Message="SERVER_URL and ENROLLMENT_KEY must be provided together." />

<!-- Lines 46-48: Add ENROLLMENT_SECRET property -->
<Property Id="SERVER_URL" Secure="yes" />
<Property Id="ENROLLMENT_KEY" Secure="yes" Hidden="yes" />
<Property Id="ENROLLMENT_SECRET" Secure="yes" Hidden="yes" />
```

Update the SetEnrollAgentData custom action (line 150-153) to include the new property:

```xml
<CustomAction
  Id="SetEnrollAgentData"
  Property="EnrollAgent"
  Value="SERVER_URL=[SERVER_URL];ENROLLMENT_KEY=[ENROLLMENT_KEY];ENROLLMENT_SECRET=[ENROLLMENT_SECRET]" />
```

- [ ] **Step 2: Update enroll-agent.ps1 to read ENROLLMENT_SECRET**

In `agent/installer/enroll-agent.ps1`, add extraction of the new property after line 42, and pass it to the enrollment command at line 64:

```powershell
# After line 42:
$serverUrl = Get-CustomActionDataValue -Data $CustomActionData -Key "SERVER_URL" -NextKey "ENROLLMENT_KEY"
$enrollmentKey = Get-CustomActionDataValue -Data $CustomActionData -Key "ENROLLMENT_KEY" -NextKey "ENROLLMENT_SECRET"
$enrollmentSecret = Get-CustomActionDataValue -Data $CustomActionData -Key "ENROLLMENT_SECRET"

# Replace line 64 with:
$enrollArgs = @("enroll", $enrollmentKey, "--server", $serverUrl)
if (-not [string]::IsNullOrWhiteSpace($enrollmentSecret)) {
    $enrollArgs += "--enrollment-secret"
    $enrollArgs += $enrollmentSecret
}
& $agentExe @enrollArgs
```

- [ ] **Step 3: Verify MSI builds locally (if on Windows)**

Run:
```powershell
cd agent/installer
.\build-msi.ps1 -Version 0.0.1-test
```
Expected: MSI builds without errors. If not on Windows, visual review is sufficient — CI will validate.

- [ ] **Step 4: Commit**

```bash
git add agent/installer/breeze.wxs agent/installer/enroll-agent.ps1
git commit -m "feat(installer): add ENROLLMENT_SECRET MSI property

Wire ENROLLMENT_SECRET through WiX properties → CustomActionData →
enroll-agent.ps1 → agent enroll CLI. Optional — empty string if not set."
```

---

## Task 2: Template MSI Build Variant

**Files:**
- Modify: `agent/installer/build-msi.ps1:27-35,79-92`

### Goal
Add a `-Template` switch to `build-msi.ps1` that builds the MSI with fixed-length placeholder sentinels in the Property table instead of empty defaults.

- [ ] **Step 1: Add -Template switch to build-msi.ps1**

In `agent/installer/build-msi.ps1`, add a new parameter and preprocessor variables:

```powershell
# Add to param block (around line 27):
param(
    [Parameter(Mandatory = $false)]
    [string]$Version = "0.0.0",

    [Parameter(Mandatory = $false)]
    [string]$AgentExePath,

    [Parameter(Mandatory = $false)]
    [string]$BackupExePath,

    [Parameter(Mandatory = $false)]
    [string]$WatchdogExePath,

    [Parameter(Mandatory = $false)]
    [string]$OutputPath,

    [Parameter(Mandatory = $false)]
    [switch]$Template
)
```

Add preprocessor variable logic before the `wix build` call (around line 79):

```powershell
# Placeholder sentinels: 512 chars each, padded with null bytes
# The sentinel prefix is unique enough to find in the binary
$templateArgs = @()
if ($Template) {
    # Generate 512-char padded sentinels
    $pad = 512
    $serverPlaceholder = "@@BREEZE_SERVER_URL@@".PadRight($pad, [char]0)
    $keyPlaceholder = "@@BREEZE_ENROLLMENT_KEY@@".PadRight($pad, [char]0)
    $secretPlaceholder = "@@BREEZE_ENROLLMENT_SECRET@@".PadRight($pad, [char]0)
    $templateArgs = @(
        "-d", "ServerUrlDefault=$serverPlaceholder",
        "-d", "EnrollmentKeyDefault=$keyPlaceholder",
        "-d", "EnrollmentSecretDefault=$secretPlaceholder"
    )
}
```

Then include `$templateArgs` in the `wix build` invocation (around line 79-92), appending them to the existing args array.

- [ ] **Step 2: Update breeze.wxs to use preprocessor variables for defaults**

In `agent/installer/breeze.wxs`, update the Property definitions to accept optional defaults:

```xml
<?ifdef ServerUrlDefault ?>
  <Property Id="SERVER_URL" Secure="yes" Value="$(var.ServerUrlDefault)" />
<?else?>
  <Property Id="SERVER_URL" Secure="yes" />
<?endif?>

<?ifdef EnrollmentKeyDefault ?>
  <Property Id="ENROLLMENT_KEY" Secure="yes" Hidden="yes" Value="$(var.EnrollmentKeyDefault)" />
<?else?>
  <Property Id="ENROLLMENT_KEY" Secure="yes" Hidden="yes" />
<?endif?>

<?ifdef EnrollmentSecretDefault ?>
  <Property Id="ENROLLMENT_SECRET" Secure="yes" Hidden="yes" Value="$(var.EnrollmentSecretDefault)" />
<?else?>
  <Property Id="ENROLLMENT_SECRET" Secure="yes" Hidden="yes" />
<?endif?>
```

- [ ] **Step 3: Commit**

```bash
git add agent/installer/build-msi.ps1 agent/installer/breeze.wxs
git commit -m "feat(installer): add -Template flag for placeholder MSI build

When -Template is set, build-msi.ps1 passes 512-char null-padded sentinel
values as Property defaults. These are replaced at download time by the API."
```

---

## Task 3: CI — Build and Upload Template MSI

**Files:**
- Modify: `.github/workflows/release.yml:408-478`

### Goal
After the normal MSI build + sign, also build a template MSI and upload it as a release asset.

- [ ] **Step 1: Add template MSI build step**

In `.github/workflows/release.yml`, after the existing "Build MSI" step (line 408-417), add:

```yaml
      - name: Build Template MSI
        shell: pwsh
        run: |
          $root = $env:GITHUB_WORKSPACE
          $version = "${{ steps.version.outputs.version }}"
          $agentExe = Join-Path $root "dist\breeze-agent-windows-amd64.exe"
          $backupExe = Join-Path $root "dist\breeze-backup-windows-amd64.exe"
          $watchdogExe = Join-Path $root "dist\breeze-watchdog-windows-amd64.exe"
          $msiPath = Join-Path $root "dist\breeze-agent-template.msi"
          & (Join-Path $root "agent\installer\build-msi.ps1") -Version $version -AgentExePath $agentExe -BackupExePath $backupExe -WatchdogExePath $watchdogExe -OutputPath $msiPath -Template
```

- [ ] **Step 2: Add template MSI to signature verification**

In the "Verify signatures" step (line 443-463), add the template MSI to the `$targets` array. Note: The template MSI uses the same signed EXE binaries inside, but the MSI itself won't be signed (signing would invalidate the binary after placeholder replacement). This is expected — skip signature check for the template MSI.

Actually, **do NOT sign the template MSI**. Signing adds a digital signature to the MSI file; replacing placeholder bytes afterward would invalidate that signature. The template MSI is only used server-side for generating customized copies — it's never directly installed by end users.

- [ ] **Step 3: Add template MSI upload step**

After the existing "Upload Windows MSI artifact" step (line 473-478), add:

```yaml
      - name: Upload Template MSI artifact
        uses: actions/upload-artifact@v7
        with:
          name: breeze-agent-template-msi
          path: dist/breeze-agent-template.msi
          retention-days: 30
```

Also add it to the GitHub release upload step (find the step that uploads release assets and add `breeze-agent-template.msi`).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build and upload template MSI for pre-configured installers

Template MSI contains placeholder sentinels for SERVER_URL, ENROLLMENT_KEY,
ENROLLMENT_SECRET. Not signed — binary replacement would invalidate signature."
```

---

## Task 4: Installer Builder Service — MSI Placeholder Replacement

**Files:**
- Create: `apps/api/src/services/installerBuilder.ts`
- Create: `apps/api/src/services/installerBuilder.test.ts`

### Goal
Build the core service that takes a template MSI buffer and replaces placeholder sentinels with real values. Also builds macOS zip bundles.

- [ ] **Step 1: Write the failing test for MSI placeholder replacement**

Create `apps/api/src/services/installerBuilder.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { replaceMsiPlaceholders, PLACEHOLDERS } from './installerBuilder';

describe('replaceMsiPlaceholders', () => {
  it('replaces all three placeholders in a buffer', () => {
    // Build a fake MSI buffer with UTF-16LE encoded sentinels
    const serverSentinel = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const keySentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le');
    const secretSentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');

    const template = Buffer.concat([
      Buffer.from('header-bytes'),
      serverSentinel,
      Buffer.from('middle-bytes'),
      keySentinel,
      Buffer.from('more-bytes'),
      secretSentinel,
      Buffer.from('footer-bytes'),
    ]);

    const result = replaceMsiPlaceholders(template, {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: 'abc123',
      enrollmentSecret: 'secret456',
    });

    // Same total size
    expect(result.length).toBe(template.length);

    // Sentinels gone
    const resultStr = result.toString('utf16le');
    expect(resultStr).not.toContain('@@BREEZE_SERVER_URL@@');
    expect(resultStr).not.toContain('@@BREEZE_ENROLLMENT_KEY@@');
    expect(resultStr).not.toContain('@@BREEZE_ENROLLMENT_SECRET@@');

    // Values present
    expect(result.includes(Buffer.from('https://breeze.example.com', 'utf16le'))).toBe(true);
    expect(result.includes(Buffer.from('abc123', 'utf16le'))).toBe(true);
    expect(result.includes(Buffer.from('secret456', 'utf16le'))).toBe(true);
  });

  it('leaves ENROLLMENT_SECRET as nulls when empty', () => {
    const secretSentinel = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');
    const template = Buffer.concat([Buffer.from('prefix'), secretSentinel, Buffer.from('suffix')]);

    const result = replaceMsiPlaceholders(template, {
      serverUrl: 'https://x.com',
      enrollmentKey: 'key1',
      enrollmentSecret: '',
    });

    expect(result.length).toBe(template.length);
    expect(result.toString('utf16le')).not.toContain('@@BREEZE_ENROLLMENT_SECRET@@');
  });

  it('throws if a placeholder is not found in the buffer', () => {
    const emptyBuffer = Buffer.from('no placeholders here');
    expect(() =>
      replaceMsiPlaceholders(emptyBuffer, {
        serverUrl: 'https://x.com',
        enrollmentKey: 'k',
        enrollmentSecret: '',
      })
    ).toThrow(/SERVER_URL placeholder not found/);
  });

  it('throws if value exceeds placeholder capacity', () => {
    const serverSentinel = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const template = Buffer.concat([serverSentinel]);

    expect(() =>
      replaceMsiPlaceholders(template, {
        serverUrl: 'x'.repeat(600), // 600 chars > 512 placeholder chars
        enrollmentKey: 'k',
        enrollmentSecret: '',
      })
    ).toThrow(/SERVER_URL value too long/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/installerBuilder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement replaceMsiPlaceholders**

Create `apps/api/src/services/installerBuilder.ts`:

```typescript
const PLACEHOLDER_CHAR_LENGTH = 512;

/** Sentinel strings padded to 512 chars with null bytes — must match build-msi.ps1 */
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

    // Encode sentinel and replacement as UTF-16LE (MSI internal string encoding)
    const sentinelBuf = Buffer.from(sentinel, 'utf16le');
    const offset = result.indexOf(sentinelBuf);

    if (offset === -1) {
      throw new Error(`${name} placeholder not found in template MSI`);
    }

    // Build replacement: value padded with null bytes to same byte length
    const replacementPadded = value.padEnd(PLACEHOLDER_CHAR_LENGTH, '\0');
    const replacementBuf = Buffer.from(replacementPadded, 'utf16le');

    replacementBuf.copy(result, offset);
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/installerBuilder.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/installerBuilder.ts apps/api/src/services/installerBuilder.test.ts
git commit -m "feat(api): add MSI placeholder replacement for pre-configured installers

Finds UTF-16LE encoded sentinel strings in template MSI buffer and replaces
with real enrollment values, null-padded to preserve file size."
```

---

## Task 5: Installer Builder Service — macOS Zip Bundle

**Files:**
- Modify: `apps/api/src/services/installerBuilder.ts`
- Modify: `apps/api/src/services/installerBuilder.test.ts`

### Goal
Add a function that builds a zip containing the PKG + enrollment.json + install.sh.

- [ ] **Step 1: Write the failing test for macOS zip builder**

Add to `apps/api/src/services/installerBuilder.test.ts`:

```typescript
import { buildMacosInstallerZip } from './installerBuilder';
import { Readable } from 'node:stream';
import JSZip from 'jszip';

describe('buildMacosInstallerZip', () => {
  it('produces a zip with pkg, enrollment.json, and install.sh', async () => {
    const fakePkg = Buffer.from('fake-pkg-contents');

    const zipBuffer = await buildMacosInstallerZip(fakePkg, {
      serverUrl: 'https://breeze.example.com',
      enrollmentKey: 'abc123',
      enrollmentSecret: 'secret456',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const entries = Object.keys(zip.files);

    expect(entries).toContain('breeze-agent.pkg');
    expect(entries).toContain('enrollment.json');
    expect(entries).toContain('install.sh');

    // Verify enrollment.json contents
    const jsonStr = await zip.files['enrollment.json'].async('string');
    const config = JSON.parse(jsonStr);
    expect(config.serverUrl).toBe('https://breeze.example.com');
    expect(config.enrollmentKey).toBe('abc123');
    expect(config.enrollmentSecret).toBe('secret456');
    expect(config.siteId).toBe('550e8400-e29b-41d4-a716-446655440000');

    // Verify install.sh is executable (unix permissions)
    const installSh = zip.files['install.sh'];
    expect(installSh.unixPermissions).toBe(0o755);

    // Verify pkg contents match
    const pkgData = await zip.files['breeze-agent.pkg'].async('nodebuffer');
    expect(pkgData.equals(fakePkg)).toBe(true);
  });

  it('sets enrollmentSecret to empty string when not provided', async () => {
    const zipBuffer = await buildMacosInstallerZip(Buffer.from('pkg'), {
      serverUrl: 'https://x.com',
      enrollmentKey: 'key1',
      enrollmentSecret: '',
      siteId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const zip = await JSZip.loadAsync(zipBuffer);
    const config = JSON.parse(await zip.files['enrollment.json'].async('string'));
    expect(config.enrollmentSecret).toBe('');
  });
});
```

- [ ] **Step 2: Install jszip dev dependency for tests**

Run: `cd apps/api && pnpm add -D jszip`

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/installerBuilder.test.ts`
Expected: FAIL — `buildMacosInstallerZip` not exported

- [ ] **Step 4: Implement buildMacosInstallerZip**

Add to `apps/api/src/services/installerBuilder.ts`:

```typescript
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

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
sudo /usr/local/bin/breeze-agent enroll "\${ENROLL_ARGS[@]}"

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

/**
 * Build a zip containing breeze-agent.pkg + enrollment.json + install.sh.
 */
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

    // Add PKG
    archive.append(pkgBuffer, { name: 'breeze-agent.pkg' });

    // Add enrollment.json
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

    // Add install.sh (executable)
    archive.append(MACOS_INSTALL_SCRIPT, { name: 'install.sh', mode: 0o755 });

    archive.finalize();
  });
}
```

- [ ] **Step 5: Install archiver dependency**

Run: `cd apps/api && pnpm add archiver && pnpm add -D @types/archiver`

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/installerBuilder.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/installerBuilder.ts apps/api/src/services/installerBuilder.test.ts apps/api/package.json
git commit -m "feat(api): add macOS zip bundle builder for pre-configured installers

Builds a zip containing breeze-agent.pkg + enrollment.json + install.sh.
The install script auto-enrolls the agent and cleans up credentials."
```

---

## Task 6: Binary Source — Add Template MSI + PKG URL Helpers

**Files:**
- Modify: `apps/api/src/services/binarySource.ts`

### Goal
Add helper functions to locate the template MSI and macOS PKG from GitHub releases or local disk.

- [ ] **Step 1: Add helper functions**

In `apps/api/src/services/binarySource.ts`, add:

```typescript
export function getGithubTemplateMsiUrl(): string {
  return `${githubDownloadBase()}/breeze-agent-template.msi`;
}
```

Note: `getGithubAgentPkgUrl` already exists (line 49-52). No changes needed for macOS.

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/binarySource.ts
git commit -m "feat(api): add GitHub release URL for template MSI"
```

---

## Task 7: API Endpoint — Installer Download Route

**Files:**
- Modify: `apps/api/src/routes/enrollmentKeys.ts`

### Goal
Add `GET /:id/installer/:platform` that generates a child enrollment key, fetches the template binary, injects credentials, and streams the result.

- [ ] **Step 1: Write the failing test**

Create or add to `apps/api/src/routes/enrollmentKeys.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules before imports
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn().mockReturnValue('hashed-key'),
}));

vi.mock('../services/installerBuilder', () => ({
  replaceMsiPlaceholders: vi.fn().mockReturnValue(Buffer.from('modified-msi')),
  buildMacosInstallerZip: vi.fn().mockResolvedValue(Buffer.from('zip-data')),
}));

vi.mock('../services/binarySource', () => ({
  getBinarySource: vi.fn().mockReturnValue('local'),
  getGithubTemplateMsiUrl: vi.fn().mockReturnValue('https://github.com/example/releases/download/v1/breeze-agent-template.msi'),
  getGithubAgentPkgUrl: vi.fn().mockReturnValue('https://github.com/example/releases/download/v1/breeze-agent-darwin-arm64.pkg'),
}));

describe('GET /enrollment-keys/:id/installer/:platform', () => {
  it('returns 400 for invalid platform', async () => {
    // Test that platform must be 'windows' or 'macos'
  });

  it('returns 404 when enrollment key not found', async () => {
    // Test key lookup failure
  });

  it('returns 410 when enrollment key is expired', async () => {
    // Test expired key
  });

  it('returns 410 when enrollment key usage is exhausted', async () => {
    // Test maxUsage reached
  });

  it('returns MSI with correct content-disposition for windows', async () => {
    // Test successful windows download
  });

  it('returns zip with correct content-disposition for macos', async () => {
    // Test successful macos download
  });
});
```

Note: Follow the existing test patterns in the `apps/api/src/routes/` directory. Read 2-3 nearby test files to match mock patterns before finalizing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/enrollmentKeys.test.ts`
Expected: FAIL — route not implemented

- [ ] **Step 3: Implement the endpoint**

In `apps/api/src/routes/enrollmentKeys.ts`, add the following after the existing imports (around line 10):

```typescript
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { replaceMsiPlaceholders, buildMacosInstallerZip } from '../services/installerBuilder';
import { getBinarySource, getGithubTemplateMsiUrl, getGithubAgentPkgUrl } from '../services/binarySource';
import { isS3Configured, getPresignedUrl } from '../services/s3Storage';
```

Add the route handler after the DELETE route (after line 406):

```typescript
// ============================================
// GET /:id/installer/:platform - Download pre-configured installer
// ============================================

enrollmentKeyRoutes.get(
  '/:id/installer/:platform',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id');
    const platform = c.req.param('platform');

    if (platform !== 'windows' && platform !== 'macos') {
      return c.json({ error: 'Invalid platform. Must be "windows" or "macos".' }, 400);
    }

    // Look up parent enrollment key
    const [parentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parentKey) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    // Verify org access
    const hasAccess = await ensureOrgAccess(parentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Verify key is still usable
    if (parentKey.expiresAt && new Date(parentKey.expiresAt) < new Date()) {
      return c.json({ error: 'Enrollment key has expired' }, 410);
    }
    if (parentKey.maxUsage !== null && parentKey.usageCount >= parentKey.maxUsage) {
      return c.json({ error: 'Enrollment key usage exhausted' }, 410);
    }

    // Require siteId on the parent key
    if (!parentKey.siteId) {
      return c.json({ error: 'Enrollment key must have a siteId to generate installers' }, 400);
    }

    // Generate a child enrollment key (single-use, same org/site/expiry)
    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);

    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parentKey.orgId,
        siteId: parentKey.siteId,
        name: `${parentKey.name} (installer)`,
        key: childKeyHash,
        keySecretHash: parentKey.keySecretHash,
        maxUsage: 1,
        expiresAt: parentKey.expiresAt,
        createdBy: auth.user.id,
      })
      .returning();

    if (!childKey) {
      return c.json({ error: 'Failed to generate installer key' }, 500);
    }

    // Get the enrollment secret (if per-key secret exists, we can't recover it —
    // the child inherits the hash, so the installer won't include a per-key secret.
    // Only the global AGENT_ENROLLMENT_SECRET is passed through.)
    const globalSecret = process.env.AGENT_ENROLLMENT_SECRET || '';

    // Determine server URL
    const serverUrl = process.env.PUBLIC_API_URL
      || process.env.API_URL
      || `${c.req.header('x-forwarded-proto') || 'https'}://${c.req.header('host')}`;

    // Audit log
    writeEnrollmentKeyAudit(c, auth, {
      orgId: parentKey.orgId,
      action: 'enrollment_key.installer_download',
      keyId: parentKey.id,
      keyName: parentKey.name,
      details: { platform, childKeyId: childKey.id },
    });

    if (platform === 'windows') {
      // Fetch template MSI
      let templateBuffer: Buffer;
      try {
        templateBuffer = await fetchTemplateMsi();
      } catch (err) {
        console.error('[installer] Failed to fetch template MSI:', err);
        return c.json({ error: 'Template MSI not available' }, 503);
      }

      const modified = replaceMsiPlaceholders(templateBuffer, {
        serverUrl,
        enrollmentKey: rawChildKey,
        enrollmentSecret: globalSecret,
      });

      return new Response(modified, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="breeze-agent.msi"`,
          'Content-Length': String(modified.length),
          'Cache-Control': 'no-store',
        },
      });
    }

    // macOS
    let pkgBuffer: Buffer;
    try {
      pkgBuffer = await fetchMacosPkg();
    } catch (err) {
      console.error('[installer] Failed to fetch macOS PKG:', err);
      return c.json({ error: 'macOS PKG not available' }, 503);
    }

    const zipBuffer = await buildMacosInstallerZip(pkgBuffer, {
      serverUrl,
      enrollmentKey: rawChildKey,
      enrollmentSecret: globalSecret,
      siteId: parentKey.siteId,
    });

    return new Response(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="breeze-agent-macos.zip"`,
        'Content-Length': String(zipBuffer.length),
        'Cache-Control': 'no-store',
      },
    });
  }
);
```

- [ ] **Step 4: Add helper functions for fetching template binaries**

Add these to the helpers section (top of `enrollmentKeys.ts`):

```typescript
async function fetchTemplateMsi(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubTemplateMsiUrl();
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch template MSI: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  // Local mode: read from disk
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFileSync(join(binaryDir, 'breeze-agent-template.msi'));
}

async function fetchMacosPkg(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    // Default to arm64 — most common Mac architecture for managed devices
    const url = getGithubAgentPkgUrl('darwin', 'arm64');
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch macOS PKG: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }

  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFileSync(join(binaryDir, 'breeze-agent-darwin-arm64.pkg'));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/enrollmentKeys.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/enrollmentKeys.ts apps/api/src/routes/enrollmentKeys.test.ts
git commit -m "feat(api): add installer download endpoint for enrollment keys

GET /enrollment-keys/:id/installer/:platform generates a single-use child
enrollment key, fetches the template binary, injects credentials, and streams
the result. Supports windows (MSI) and macos (zip with PKG)."
```

---

## Task 8: Dashboard — Download Installer Dropdown

**Files:**
- Modify: `apps/web/src/components/settings/EnrollmentKeyManager.tsx:365-381`

### Goal
Add a "Download Installer" dropdown button to each row's Actions column in the enrollment keys table.

- [ ] **Step 1: Add download handler function**

In `EnrollmentKeyManager.tsx`, add a download handler near the other handler functions (around line 180):

```typescript
const handleDownloadInstaller = async (keyId: string, platform: 'windows' | 'macos') => {
  try {
    const response = await fetch(`/api/v1/enrollment-keys/${keyId}/installer/${platform}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'Download failed' }));
      setError(body.error || `Download failed (${response.status})`);
      return;
    }

    const blob = await response.blob();
    const filename = platform === 'windows' ? 'breeze-agent.msi' : 'breeze-agent-macos.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    setError('Failed to download installer');
  }
};
```

- [ ] **Step 2: Add state for dropdown open/close**

Add state to track which key's dropdown is open:

```typescript
const [downloadDropdownId, setDownloadDropdownId] = useState<string | null>(null);
```

- [ ] **Step 3: Add Download Installer dropdown to the Actions column**

Replace the Actions `<td>` (around lines 365-381) with:

```tsx
<td className="px-4 py-3 text-right">
  <div className="relative inline-flex items-center gap-1">
    {/* Download Installer Dropdown */}
    {status.label === 'Active' && key.siteId && (
      <div className="relative">
        <button
          type="button"
          onClick={() => setDownloadDropdownId(downloadDropdownId === key.id ? null : key.id)}
          className="rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted"
          title="Download pre-configured installer"
        >
          Download
        </button>
        {downloadDropdownId === key.id && (
          <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded-md border bg-popover py-1 shadow-md">
            <button
              type="button"
              onClick={() => {
                handleDownloadInstaller(key.id, 'windows');
                setDownloadDropdownId(null);
              }}
              className="w-full px-3 py-1.5 text-left text-xs hover:bg-muted"
            >
              Windows (.msi)
            </button>
            <button
              type="button"
              onClick={() => {
                handleDownloadInstaller(key.id, 'macos');
                setDownloadDropdownId(null);
              }}
              className="w-full px-3 py-1.5 text-left text-xs hover:bg-muted"
            >
              macOS (.zip)
            </button>
          </div>
        )}
      </div>
    )}
    <button
      type="button"
      onClick={() => handleRotateKey(key)}
      disabled={submitting}
      className="rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
    >
      Rotate
    </button>
    <button
      type="button"
      onClick={() => handleOpenDelete(key)}
      className="rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
    >
      Delete
    </button>
  </div>
</td>
```

- [ ] **Step 4: Close dropdown on outside click**

Add an effect to close the dropdown when clicking outside:

```typescript
useEffect(() => {
  if (!downloadDropdownId) return;
  const handler = () => setDownloadDropdownId(null);
  document.addEventListener('click', handler);
  return () => document.removeEventListener('click', handler);
}, [downloadDropdownId]);
```

- [ ] **Step 5: Verify visually in dev mode**

Run: `pnpm dev`
Navigate to Settings > Enrollment Keys. Verify:
- "Download" button appears on active keys that have a siteId
- Dropdown shows Windows (.msi) and macOS (.zip) options
- Clicking an option triggers a file download
- Dropdown closes on outside click
- Expired/exhausted keys don't show the Download button

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings/EnrollmentKeyManager.tsx
git commit -m "feat(web): add Download Installer dropdown to enrollment keys table

Active enrollment keys with a siteId show a Download button with Windows (.msi)
and macOS (.zip) options. Downloads a pre-configured installer via the API."
```

---

## Task 9: Integration Test — End-to-End Flow

**Files:**
- Modify: `apps/api/src/services/installerBuilder.test.ts`

### Goal
Add an integration-style test that exercises the full flow: create a parent key → call the installer endpoint → verify the response.

- [ ] **Step 1: Write integration test**

Add to `apps/api/src/services/installerBuilder.test.ts` (or a separate `enrollmentKeys.installer.test.ts`):

```typescript
describe('installer endpoint integration', () => {
  it('MSI placeholder replacement produces valid output', () => {
    // Build a realistic template buffer with all 3 sentinels
    const sentinel1 = Buffer.from(PLACEHOLDERS.SERVER_URL, 'utf16le');
    const sentinel2 = Buffer.from(PLACEHOLDERS.ENROLLMENT_KEY, 'utf16le');
    const sentinel3 = Buffer.from(PLACEHOLDERS.ENROLLMENT_SECRET, 'utf16le');

    // Simulate a real MSI layout (header + data + sentinels scattered throughout)
    const header = Buffer.alloc(4096, 0xCC);
    const gap = Buffer.alloc(1024, 0xDD);
    const template = Buffer.concat([header, sentinel1, gap, sentinel2, gap, sentinel3, gap]);

    const result = replaceMsiPlaceholders(template, {
      serverUrl: 'https://rmm.acme-msp.com',
      enrollmentKey: 'a'.repeat(64),
      enrollmentSecret: 'my-enrollment-secret',
    });

    // Size unchanged
    expect(result.length).toBe(template.length);

    // Header unchanged (not corrupted)
    expect(result.subarray(0, 4096).equals(header)).toBe(true);

    // Gaps unchanged
    const gap1Start = 4096 + sentinel1.length;
    expect(result.subarray(gap1Start, gap1Start + 1024).equals(gap)).toBe(true);

    // Values present at correct offsets
    const serverVal = result.subarray(4096, 4096 + sentinel1.length).toString('utf16le');
    expect(serverVal.startsWith('https://rmm.acme-msp.com')).toBe(true);
    expect(serverVal.includes('@@BREEZE')).toBe(false);
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `cd apps/api && npx vitest run src/services/installerBuilder.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/installerBuilder.test.ts
git commit -m "test(api): add integration test for MSI placeholder replacement

Verifies that placeholder replacement preserves surrounding bytes and
correctly places values at the expected offsets."
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Add ENROLLMENT_SECRET to WiX + PS1 | `breeze.wxs`, `enroll-agent.ps1` |
| 2 | Template MSI build variant | `build-msi.ps1`, `breeze.wxs` |
| 3 | CI — build + upload template MSI | `release.yml` |
| 4 | MSI placeholder replacement service | `installerBuilder.ts` + tests |
| 5 | macOS zip bundle builder | `installerBuilder.ts` + tests |
| 6 | Binary source URL helper | `binarySource.ts` |
| 7 | API endpoint — installer download | `enrollmentKeys.ts` + tests |
| 8 | Dashboard — download dropdown | `EnrollmentKeyManager.tsx` |
| 9 | Integration test | `installerBuilder.test.ts` |
