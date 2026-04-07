# Pre-Configured Installer Downloads

## Overview

Admins download platform-specific agent installers from the Breeze dashboard with enrollment credentials pre-baked. The agent auto-enrolls on first run with zero manual configuration. Supports both MSP mass deployment (GPO/MDM/SCCM push) and end-user self-install scenarios.

## Platforms

- **Windows**: Single `.msi` file with credentials injected via binary placeholder replacement
- **macOS**: `.zip` bundle containing `.pkg` + `enrollment.json` + `install.sh` wrapper

## Injected Values

| Property | Required | Placeholder (MSI) | Max Length |
|----------|----------|--------------------|------------|
| `SERVER_URL` | Yes | `@@BREEZE_SERVER_URL@@...` | 512 bytes |
| `ENROLLMENT_KEY` | Yes | `@@BREEZE_ENROLLMENT_KEY@@...` | 512 bytes |
| `ENROLLMENT_SECRET` | No | `@@BREEZE_ENROLLMENT_SECRET@@...` | 512 bytes |

All placeholders are null-padded to their fixed length. Empty optional values are replaced with null bytes. Note: MSI Property table stores strings as UTF-16LE internally, so the placeholder replacement operates on the raw binary — find the UTF-16LE encoded sentinel bytes and replace with the UTF-16LE encoded real value (null-padded to the same byte length).

---

## Windows: Template MSI with Binary Replacement

### Build-Time (CI)

1. Update `agent/installer/breeze.wxs` to define three Property elements with fixed-length sentinel default values:
   - `SERVER_URL` = `@@BREEZE_SERVER_URL@@` padded to 512 bytes with null characters
   - `ENROLLMENT_KEY` = `@@BREEZE_ENROLLMENT_KEY@@` padded to 512 bytes
   - `ENROLLMENT_SECRET` = `@@BREEZE_ENROLLMENT_SECRET@@` padded to 512 bytes
2. Build the template MSI during CI alongside the normal MSI
3. Publish as a release asset: `breeze-agent-template.msi`
4. The existing `enroll-agent.ps1` custom action already reads `SERVER_URL` and `ENROLLMENT_KEY` properties — extend it to also read `ENROLLMENT_SECRET`

### Download-Time (API)

1. Load the template MSI into a buffer
2. Find each sentinel byte sequence and replace with the real value (null-padded to same 512-byte length)
3. Stream the modified buffer as the response

### Agent-Side Changes

None required for the agent binary itself. The MSI custom action (`enroll-agent.ps1`) already handles enrollment from MSI properties. Only change: extend it to pass `ENROLLMENT_SECRET` if present.

---

## macOS: Zip Bundle

### Bundle Contents

```
breeze-installer-<orgname>.zip
├── breeze-agent.pkg          # Universal pre-built PKG (unchanged)
├── enrollment.json           # Enrollment credentials
└── install.sh                # Wrapper script
```

### enrollment.json

```json
{
  "serverUrl": "https://breeze.example.com",
  "enrollmentKey": "a1b2c3d4e5f6...",
  "enrollmentSecret": "",
  "siteId": "uuid"
}
```

### install.sh Wrapper

```bash
#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENROLLMENT_JSON="$SCRIPT_DIR/enrollment.json"

# Install the PKG
sudo installer -pkg "$SCRIPT_DIR/breeze-agent.pkg" -target /

# Read enrollment config
SERVER_URL=$(python3 -c "import json; print(json.load(open('$ENROLLMENT_JSON'))['serverUrl'])")
ENROLLMENT_KEY=$(python3 -c "import json; print(json.load(open('$ENROLLMENT_JSON'))['enrollmentKey'])")
ENROLLMENT_SECRET=$(python3 -c "import json; print(json.load(open('$ENROLLMENT_JSON')).get('enrollmentSecret', ''))")
SITE_ID=$(python3 -c "import json; print(json.load(open('$ENROLLMENT_JSON')).get('siteId', ''))")

# Build enrollment command
ENROLL_ARGS=("$ENROLLMENT_KEY" --server "$SERVER_URL")
[ -n "$ENROLLMENT_SECRET" ] && ENROLL_ARGS+=(--enrollment-secret "$ENROLLMENT_SECRET")
[ -n "$SITE_ID" ] && ENROLL_ARGS+=(--site-id "$SITE_ID")

# Enroll
sudo /usr/local/bin/breeze-agent enroll "${ENROLL_ARGS[@]}"

# Clean up enrollment credentials
rm -f "$ENROLLMENT_JSON"

echo "Breeze agent installed and enrolled successfully."
```

### Agent-Side Changes

No changes to the agent binary. The wrapper script handles enrollment by calling the existing `breeze-agent enroll` CLI command.

---

## API Endpoint

### Route

`GET /api/v1/enrollment-keys/:id/installer/:platform`

### Location

New file: `apps/api/src/routes/enrollmentKeys/installer.ts` (or added to existing `enrollmentKeys.ts` if it stays under 500 lines).

### Auth

JWT required, `organizations:read` permission.

### Parameters

| Param | Type | Values |
|-------|------|--------|
| `id` | path | Enrollment key UUID |
| `platform` | path | `windows` \| `macos` |

### Flow

1. Validate JWT and org access
2. Look up enrollment key by ID — verify it belongs to the user's org
3. Verify key is not expired and has remaining usage (don't decrement — downloading isn't enrolling)
4. Retrieve the raw enrollment key value — **Note**: raw keys are not stored. The endpoint needs to return a _new_ key or use a different approach. See [Key Retrieval](#key-retrieval) below.
5. **Windows**: Load template MSI from disk/S3 cache, replace placeholders, stream response
6. **macOS**: Build zip on the fly (PKG + enrollment.json + install.sh), stream response
7. Set response headers:
   - `Content-Type`: `application/octet-stream` (Windows) or `application/zip` (macOS)
   - `Content-Disposition`: `attachment; filename="breeze-agent-<orgname>.msi"` or `.zip`
8. Write audit log entry: who downloaded, which key, which platform

### Key Retrieval

Raw enrollment keys are hashed before storage (SHA-256 + pepper) and cannot be recovered. The "Download Installer" action generates a fresh child enrollment key (same org/site as the parent, `maxUsage: 1`, same expiry) and embeds the raw key in the installer. The child key's hash is stored normally. This means:

- Each downloaded installer gets its own single-use key
- Admins can generate installers any time without saving raw keys
- If an installer file leaks, only one enrollment slot is exposed
- The parent key's usage count is not affected — child keys are independent

---

## Dashboard UI

### Enrollment Keys List Page

- Add a "Download Installer" dropdown button to each row (or the key detail view)
- Dropdown items: "Windows (.msi)" and "macOS (.zip)"
- Disabled with tooltip if key is expired or usage exhausted
- Clicking triggers browser download from the API endpoint

### Enrollment Key Detail Page

- Same "Download Installer" dropdown in the header/actions area
- Shows download history (from audit log) if useful

---

## CI Changes

### Template MSI Build

Add a step to the existing Windows MSI build workflow:

1. Build the normal MSI (existing)
2. Build the template MSI with placeholder properties
3. Upload both as release assets

The template MSI uses the same WiX source with a build flag or property override to inject placeholder sentinels instead of empty defaults.

### Template PKG

No separate template needed — the macOS PKG is used as-is from the existing release assets.

---

## Security

- **Enrollment keys are short-lived and usage-limited** — embedding them in installers adds no new attack surface beyond what exists when pasting keys into terminals
- **Option A (child keys)** scopes each installer to a single use, limiting blast radius if an installer file is leaked
- **Audit trail**: every installer download is logged with user, key ID, platform, and timestamp
- **macOS `install.sh` cleans up** `enrollment.json` after successful enrollment — credentials don't persist on disk
- **Windows MSI**: credentials exist in the MSI binary but are consumed during install and not written to disk separately

---

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `agent/installer/breeze.wxs` | Modify | Add placeholder Property defaults |
| `agent/installer/enroll-agent.ps1` | Modify | Read ENROLLMENT_SECRET property |
| `agent/installer/build-msi.ps1` | Modify | Support template MSI build variant |
| `apps/api/src/routes/enrollmentKeys.ts` | Modify | Add installer download endpoint |
| `apps/api/src/services/installerBuilder.ts` | Create | MSI placeholder replacement + zip generation logic |
| `.github/workflows/ci.yml` (or agent build workflow) | Modify | Build + publish template MSI |
| `apps/web/src/components/EnrollmentKeys*.tsx` | Modify | Add Download Installer button/dropdown |

---

## Out of Scope

- Linux installer generation (future follow-up)
- Auto-update of template MSI when agent version changes (handled by existing release process)
- Installer signing (use existing code-signing setup)
