import { Hono } from 'hono';
import { statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { VALID_OS, VALID_ARCH } from './schemas';
import { isS3Configured, getPresignedUrl } from '../../services/s3Storage';
import { getBinarySource, getGithubAgentUrl, getGithubAgentPkgUrl, getGithubHelperUrl, HELPER_FILENAMES } from '../../services/binarySource';

export const downloadRoutes = new Hono();

// ============================================
// Agent Binary Download (public, no auth)
// ============================================

downloadRoutes.get('/download/:os/:arch', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json(
      {
        error: 'Invalid OS',
        message: `Supported values: linux, darwin, windows. Got: ${os}`,
      },
      400
    );
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json(
      {
        error: 'Invalid architecture',
        message: `Supported values: amd64, arm64. Got: ${arch}`,
      },
      400
    );
  }

  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-agent-${os}-${arch}${extension}`;

  // GitHub redirect mode — no local binaries needed
  if (getBinarySource() === 'github') {
    return c.redirect(getGithubAgentUrl(os, arch), 302);
  }

  // Local mode: try S3 presigned redirect first (bandwidth offload)
  if (isS3Configured()) {
    try {
      const s3Key = `agent/${filename}`;
      const url = await getPresignedUrl(s3Key);
      return c.redirect(url, 302);
    } catch (err) {
      const errName = (err as { name?: string }).name;
      const isNotFound = errName === 'NotFound' || errName === 'NoSuchKey';
      const level = isNotFound ? 'warn' : 'error';
      console[level](`[agent-download] S3 presign failed for ${filename}, falling back to disk:`, err);
    }
  }

  // Local mode: serve from disk
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[agent-download] Failed to read binary ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
    }
    console.warn('[agent-download] Local binary missing', { filename });
    return c.json(
      {
        error: 'Binary not found',
        message: `Agent binary "${filename}" is not available.`,
      },
      404
    );
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => {
        controller.close();
      });
      stream.on('error', (err) => {
        console.error(`[agent-download] Stream error while serving ${filename}:`, err);
        controller.error(err);
      });
    },
    cancel() {
      stream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Agent .pkg Installer Download (macOS, public, no auth)
// ============================================

downloadRoutes.get('/download/:os/:arch/pkg', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (os !== 'darwin') {
    return c.json({ error: 'Installer packages are only available for macOS (darwin)' }, 400);
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json({ error: 'Invalid architecture', message: `Supported values: amd64, arm64. Got: ${arch}` }, 400);
  }

  const filename = `breeze-agent-darwin-${arch}.pkg`;

  // GitHub redirect mode — no local packages needed
  if (getBinarySource() === 'github') {
    return c.redirect(getGithubAgentPkgUrl(os, arch), 302);
  }

  // Local mode: try S3 presigned redirect first (bandwidth offload)
  if (isS3Configured()) {
    try {
      const url = await getPresignedUrl(`agent/${filename}`);
      return c.redirect(url, 302);
    } catch (err) {
      const errName = (err as { name?: string }).name;
      const isNotFound = errName === 'NotFound' || errName === 'NoSuchKey';
      const level = isNotFound ? 'warn' : 'error';
      console[level](`[pkg-download] S3 presign failed for ${filename}, falling back to disk:`, err);
    }
  }

  // Local mode: serve from disk
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[pkg-download] Failed to read package ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read installer package' }, 500);
    }
    console.warn('[pkg-download] Local package missing', { filename });
    return c.json(
      {
        error: 'Package not found',
        message: `Installer package "${filename}" is not available.`,
      },
      404
    );
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => { controller.close(); });
      stream.on('error', (err) => {
        console.error(`[pkg-download] Stream error while serving ${filename}:`, err);
        controller.error(err);
      });
    },
    cancel() { stream.destroy(); },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Helper Binary Download (public, no auth)
// ============================================

downloadRoutes.get('/download/helper/:os/:arch', async (c) => {
  const os = c.req.param('os');
  const arch = c.req.param('arch');

  if (!VALID_OS.has(os)) {
    return c.json({ error: 'Invalid OS', message: `Supported values: linux, darwin, windows. Got: ${os}` }, 400);
  }

  if (!VALID_ARCH.has(arch)) {
    return c.json({ error: 'Invalid architecture', message: `Supported values: amd64, arm64. Got: ${arch}` }, 400);
  }

  const filename = HELPER_FILENAMES[os];
  if (!filename) {
    return c.json({ error: 'Invalid OS', message: `No helper binary available for OS: ${os}` }, 400);
  }

  if (getBinarySource() === 'github') {
    return c.redirect(getGithubHelperUrl(os), 302);
  }

  if (isS3Configured()) {
    try {
      const s3Key = `helper/${filename}`;
      const url = await getPresignedUrl(s3Key);
      return c.redirect(url, 302);
    } catch (err) {
      const errName = (err as { name?: string }).name;
      const isNotFound = errName === 'NotFound' || errName === 'NoSuchKey';
      const level = isNotFound ? 'warn' : 'error';
      console[level](`[helper-download] S3 presign failed for ${filename}, falling back to disk:`, err);
    }
  }

  const binaryDir = resolve(process.env.HELPER_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, filename);

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error(`[helper-download] Failed to read binary ${filename}:`, err);
      return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
    }
    console.warn('[helper-download] Local binary missing', { filename });
    return c.json({
      error: 'Binary not found',
      message: `Helper binary "${filename}" is not available.`,
    }, 404);
  }

  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      stream.on('end', () => { controller.close(); });
      stream.on('error', (err) => {
        console.error(`[helper-download] Stream error while serving ${filename}:`, err);
        controller.error(err);
      });
    },
    cancel() { stream.destroy(); },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Install Script (public, no auth)
// ============================================

downloadRoutes.get('/install.sh', async (c) => {
  const serverUrl =
    process.env.BREEZE_SERVER ||
    process.env.PUBLIC_API_URL ||
    new URL(c.req.url).origin;

  const script = generateInstallScript(serverUrl);

  return new Response(script, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

downloadRoutes.get('/uninstall.sh', async () => {
  return new Response(generateUninstallScript(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
});

function generateUninstallScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

AGENT_BINARY="/usr/local/bin/breeze-agent"
WATCHDOG_BINARY="/usr/local/bin/breeze-watchdog"

fatal() {
  echo "Error: $*" >&2
  exit 1
}

warn() {
  echo "Warning: $*" >&2
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    fatal "must run as root (sudo $0)"
  fi
}

uninstall_macos() {
  local agent_plist="/Library/LaunchDaemons/com.breeze.agent.plist"
  local watchdog_plist="/Library/LaunchDaemons/com.breeze.watchdog.plist"
  local user_plist="/Library/LaunchAgents/com.breeze.agent-user.plist"

  echo "Uninstalling Breeze Agent for macOS..."

  if command -v launchctl >/dev/null 2>&1; then
    launchctl bootout system/com.breeze.agent 2>/dev/null || launchctl unload "$agent_plist" 2>/dev/null || true
    launchctl bootout system/com.breeze.watchdog 2>/dev/null || launchctl unload "$watchdog_plist" 2>/dev/null || true
    launchctl unload "$user_plist" 2>/dev/null || true
  else
    warn "launchctl not found; skipping service stop"
  fi

  rm -f "$agent_plist"
  rm -f "$watchdog_plist"
  rm -f "$user_plist"
  rm -f "$AGENT_BINARY"
  rm -f "$WATCHDOG_BINARY"

  echo "Breeze Agent uninstalled."
  echo "Config at /Library/Application Support/Breeze/ was preserved."
  echo "To remove config: sudo rm -rf '/Library/Application Support/Breeze'"
}

uninstall_linux() {
  local agent_service="/etc/systemd/system/breeze-agent.service"
  local watchdog_service="/etc/systemd/system/breeze-watchdog.service"
  local user_service="/usr/lib/systemd/user/breeze-agent-user.service"
  local xdg_autostart="/etc/xdg/autostart/breeze-agent-user.desktop"
  local ipc_dir="/var/run/breeze"

  echo "Uninstalling Breeze Agent for Linux..."

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet breeze-agent 2>/dev/null; then
      systemctl stop breeze-agent
      echo "Service stopped."
    fi
    if systemctl is-enabled --quiet breeze-agent 2>/dev/null; then
      systemctl disable breeze-agent
    fi
    if systemctl is-active --quiet breeze-watchdog 2>/dev/null; then
      systemctl stop breeze-watchdog
      echo "Watchdog service stopped."
    fi
    if systemctl is-enabled --quiet breeze-watchdog 2>/dev/null; then
      systemctl disable breeze-watchdog
    fi
  else
    warn "systemctl not found; skipping service stop and disable"
  fi

  rm -f "$agent_service"
  rm -f "$watchdog_service"
  rm -f "$user_service"
  rm -f "$xdg_autostart"
  rm -f "$AGENT_BINARY"
  rm -f "$WATCHDOG_BINARY"
  rmdir "$ipc_dir" 2>/dev/null || true

  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
  fi

  echo "Breeze Agent uninstalled."
  echo "Config at /etc/breeze/ was preserved."
  echo "To remove config: sudo rm -rf /etc/breeze"
}

require_root

uname_s="$(uname -s)"
case "$uname_s" in
  Darwin*) uninstall_macos ;;
  Linux*) uninstall_linux ;;
  *) fatal "unsupported operating system: $uname_s. Only Linux and macOS are supported by this uninstaller." ;;
esac
`;
}

function generateInstallScript(serverUrl: string): string {
  return `#!/usr/bin/env bash
# ============================================
# Breeze RMM Agent - One-Line Installer
# ============================================
# Usage (enrollment token from the Add Device dialog):
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash -s -- \\
#     --server ${serverUrl} \\
#     --token YOUR_ENROLLMENT_TOKEN
#
# The enrollment token is REQUIRED — it identifies the org/site to enroll into.
# An org enrollment secret (--enrollment-secret) is an OPTIONAL extra gate that
# the server can require IN ADDITION to the token; it is never a substitute for
# it. Pass both when your server is configured with AGENT_ENROLLMENT_SECRET:
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash -s -- \\
#     --server ${serverUrl} \\
#     --token YOUR_ENROLLMENT_TOKEN \\
#     --enrollment-secret YOUR_SECRET
#
# Or with environment variables — pass them through sudo, since a plain
# \`export\` is stripped by sudo's env_reset:
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | \\
#     sudo BREEZE_SERVER="${serverUrl}" BREEZE_ENROLL_TOKEN="YOUR_ENROLLMENT_TOKEN" bash
# ============================================

set -euo pipefail

# ----- Colors -----
RED='\\033[0;31m'
GREEN='\\033[0;32m'
YELLOW='\\033[1;33m'
BLUE='\\033[0;34m'
NC='\\033[0m' # No Color

info()    { echo -e "\${BLUE}[INFO]\${NC}  $*"; }
success() { echo -e "\${GREEN}[OK]\${NC}    $*"; }
warn()    { echo -e "\${YELLOW}[WARN]\${NC}  $*"; }
error()   { echo -e "\${RED}[ERROR]\${NC} $*" >&2; }
fatal()   { error "$*"; exit 1; }

# ----- Parse arguments -----
BREEZE_SERVER="\${BREEZE_SERVER:-}"
BREEZE_ENROLL_TOKEN="\${BREEZE_ENROLL_TOKEN:-}"
BREEZE_ENROLLMENT_SECRET="\${BREEZE_ENROLLMENT_SECRET:-}"
BREEZE_SITE_ID="\${BREEZE_SITE_ID:-}"
BREEZE_DEVICE_ROLE="\${BREEZE_DEVICE_ROLE:-}"

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --server)
      BREEZE_SERVER="\$2"; shift 2 ;;
    --token)
      BREEZE_ENROLL_TOKEN="\$2"; shift 2 ;;
    --enrollment-secret)
      BREEZE_ENROLLMENT_SECRET="\$2"; shift 2 ;;
    --site-id)
      BREEZE_SITE_ID="\$2"; shift 2 ;;
    --device-role)
      BREEZE_DEVICE_ROLE="\$2"; shift 2 ;;
    *)
      warn "Unknown argument: \$1"; shift ;;
  esac
done

# ----- Validate required parameters -----
if [[ -z "\$BREEZE_SERVER" ]]; then
  fatal "BREEZE_SERVER is required. Pass --server URL or export BREEZE_SERVER."
fi

# The enrollment token is mandatory end-to-end: the agent's \`enroll\` command
# takes it as a required positional arg, and the server resolves the org/site
# from it. --enrollment-secret is only a supplementary gate, never a standalone
# credential — accepting it alone here used to pass validation and then die at
# the very last step with cobra's "accepts 1 arg(s), received 0". Fail at the
# first step instead, with actionable guidance.
if [[ -z "\$BREEZE_ENROLL_TOKEN" ]]; then
  fatal "An enrollment token is required. Pass --token TOKEN (or BREEZE_ENROLL_TOKEN through sudo). Generate one from the Add Device dialog. --enrollment-secret is an optional extra gate, not a replacement for the token."
fi

# Strip trailing slash from server URL
BREEZE_SERVER="\${BREEZE_SERVER%/}"

# ----- Detect OS -----
detect_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "\$uname_s" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "darwin" ;;
    *)       fatal "Unsupported operating system: \$uname_s. Only Linux and macOS are supported by this installer." ;;
  esac
}

# ----- Detect Architecture -----
detect_arch() {
  local uname_m
  uname_m="$(uname -m)"
  case "\$uname_m" in
    x86_64|amd64)   echo "amd64" ;;
    aarch64|arm64)   echo "arm64" ;;
    *)               fatal "Unsupported architecture: \$uname_m. Only amd64 and arm64 are supported." ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
INSTALL_DIR="/usr/local/bin"
if [[ "\$OS" == "darwin" ]]; then
  CONFIG_DIR="/Library/Application Support/Breeze"
else
  CONFIG_DIR="/etc/breeze"
fi
BINARY_NAME="breeze-agent"
DOWNLOAD_URL="\${BREEZE_SERVER}/api/v1/agents/download/\${OS}/\${ARCH}"
PKG_URL="\${BREEZE_SERVER}/api/v1/agents/download/\${OS}/\${ARCH}/pkg"
VERSION_METADATA_URL="\${BREEZE_SERVER}/api/v1/agent-versions/latest?platform=\${OS}&arch=\${ARCH}&component=agent"

info "Breeze RMM Agent Installer"
info "  Server:       \$BREEZE_SERVER"
info "  OS:           \$OS"
info "  Architecture: \$ARCH"
info "  Download URL: \$DOWNLOAD_URL"
echo ""

# ----- Check root -----
if [[ "\$(id -u)" -ne 0 ]]; then
  fatal "This installer must be run as root (use sudo)."
fi

# ----- Check for curl -----
if ! command -v curl &>/dev/null; then
  fatal "curl is required but not installed. Install it and try again."
fi

# ----- Pre-flight: verify this machine can actually reach the Breeze API -----
# Catches split-connectivity setups (guest VLANs, no NAT hairpinning, web
# filters) up front, instead of letting a later step fail with a cryptic
# OS-level error after downloading garbage.
#
# Probe the version-metadata endpoint — an /api/* path the install genuinely
# depends on (it is re-fetched below for the checksum) — NOT the apex /health.
# A reverse proxy that forwards /api/* to the API but not bare /health is a
# common self-hosted setup; probing /health there returns the web app's 404 and
# aborts an install that would otherwise succeed (issue #1470).
info "Checking connectivity to \$BREEZE_SERVER..."
PREFLIGHT_FILE="$(mktemp)"
trap 'rm -f "\$PREFLIGHT_FILE"' EXIT
CURL_RC=0
PREFLIGHT_CODE="$(curl -fsSL -m 20 -w '%{http_code}' -o "\$PREFLIGHT_FILE" "\$VERSION_METADATA_URL" 2>/dev/null)" || CURL_RC=\$?
PREFLIGHT_CODE="\${PREFLIGHT_CODE:-000}"

if [[ "\$PREFLIGHT_CODE" != "200" ]]; then
  # curl's exit code names the transport failure precisely — branch on the
  # ones whose remediation differs from generic "check your network".
  case "\$CURL_RC" in
    35|60)
      fatal "TLS problem connecting to \$BREEZE_SERVER — the server certificate could not be verified, or something is intercepting HTTPS on this network." ;;
    28)
      fatal "Connection to \$BREEZE_SERVER timed out. Verify this machine has network access to the server — check DNS, firewall rules, and VLAN restrictions." ;;
  esac
  if [[ "\$PREFLIGHT_CODE" == "000" ]]; then
    # No HTTP status line came back. Distinguish "connected, but the server gave
    # an empty/garbled reply" (API down/crashing behind a working proxy) from a
    # true network-layer failure — the remediation points at different layers.
    case "\$CURL_RC" in
      52|56|18|55)
        fatal "\$BREEZE_SERVER accepted the connection but returned no valid HTTP response (curl error \$CURL_RC). The API may be down or crashing behind your reverse proxy — check the API service logs." ;;
      *)
        fatal "Cannot reach the Breeze server at \$BREEZE_SERVER (no response, curl error \$CURL_RC). Verify this machine has network access to the server — check DNS, firewall rules, and VLAN restrictions." ;;
    esac
  fi
  fatal "Cannot reach the Breeze API at \$BREEZE_SERVER (HTTP \$PREFLIGHT_CODE). Verify the server URL is correct, the API is running, and your reverse proxy forwards /api/* to it (not just the web app)."
fi

# A 200 whose body is HTML means a middlebox answered for the API endpoint
# instead of the Breeze server. Same interception guard as the metadata download
# below (the .pkg path checks xar magic bytes instead).
if grep -qiE '<html|<!doctype' "\$PREFLIGHT_FILE"; then
  fatal "Got a web page instead of an API response from \$BREEZE_SERVER — a captive portal, router, or web filter may be intercepting traffic on this network."
fi

# Positively confirm the Breeze API answered — not merely "not HTML". The
# agent-versions metadata always carries a "version" field; a 200 without it is
# a wrong responder (proxy stub, auth gateway), so don't claim "reachable".
if ! grep -q '"version"[[:space:]]*:' "\$PREFLIGHT_FILE"; then
  fatal "Reached \$BREEZE_SERVER but the agent-versions API returned an unexpected response — something other than the Breeze server may be answering on this network."
fi

rm -f "\$PREFLIGHT_FILE"
trap - EXIT
success "Breeze server is reachable"

sha256_file() {
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  fatal "sha256sum or shasum is required but not installed. Install one and try again."
}

extract_checksum() {
  grep -oE '"checksum"[[:space:]]*:[[:space:]]*"[a-fA-F0-9]{64}"' "$1" | head -1 | sed -E 's/.*"([a-fA-F0-9]{64})".*/\\1/' | tr 'A-F' 'a-f'
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual

  if [[ ! "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then
    fatal "Release metadata did not include a valid SHA-256 checksum for \$OS/\$ARCH."
  fi

  actual="$(sha256_file "$file" | tr 'A-F' 'a-f')"
  if [[ "$actual" != "\${expected,,}" ]]; then
    rm -f "$file"
    fatal "Checksum verification failed for downloaded agent binary. Expected \$expected, got \$actual."
  fi
}

# ----- macOS: use .pkg installer -----
if [[ "\$OS" == "darwin" ]]; then
  info "Downloading macOS installer package..."
  TMPPKG="$(mktemp -d)/breeze-agent.pkg"
  trap 'rm -rf "$(dirname "\$TMPPKG")"' EXIT

  HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$TMPPKG" "\$PKG_URL" 2>/dev/null)" || true

  if [[ "\$HTTP_CODE" != "200" ]]; then
    fatal "Failed to download installer package (HTTP \$HTTP_CODE). Check that the server URL is correct."
  fi

  if [[ ! -s "\$TMPPKG" ]]; then
    fatal "Downloaded package is empty. The installer may not be available for \$ARCH."
  fi

  success "Downloaded installer package ($(wc -c < "\$TMPPKG" | tr -d ' ') bytes)"

  # A path-selective middlebox can pass the connectivity pre-flight and still
  # intercept the download path. macOS .pkg files are xar archives — anything
  # else (typically a portal's HTML) must be blamed on the network, not on
  # Gatekeeper below.
  if [[ "$(head -c 4 "\$TMPPKG")" != 'xar!' ]]; then
    fatal "Downloaded file is not a macOS installer package — something on this network may be intercepting requests to \$BREEZE_SERVER (captive portal, proxy, or web filter)."
  fi

  # Verify Apple notarization/signature before installing as root — the installer
  # CLI does not enforce Gatekeeper on its own, so a tampered/MITM'd download
  # would otherwise be installed with full privileges.
  info "Verifying installer package signature..."
  if ! spctl --assess --type install "\$TMPPKG" >/dev/null 2>&1; then
    fatal "Installer package failed Gatekeeper notarization assessment. Refusing to install."
  fi
  success "Verified installer package notarization"

  info "Installing Breeze Agent..."
  installer -pkg "\$TMPPKG" -target /
  success "Package installed (binary, launchd service, directories)"

  rm -rf "$(dirname "\$TMPPKG")"
  trap - EXIT

  # Enroll agent
  info "Enrolling agent with Breeze server..."
  ENROLL_ARGS=(enroll)
  # The token is mandatory and already validated above as non-empty, so append
  # it unconditionally — there is no token-less enroll path.
  ENROLL_ARGS+=("\$BREEZE_ENROLL_TOKEN")
  ENROLL_ARGS+=(--server "\$BREEZE_SERVER")
  if [[ -n "\$BREEZE_ENROLLMENT_SECRET" ]]; then
    ENROLL_ARGS+=(--enrollment-secret "\$BREEZE_ENROLLMENT_SECRET")
  fi
  if [[ -n "\$BREEZE_SITE_ID" ]]; then
    ENROLL_ARGS+=(--site-id "\$BREEZE_SITE_ID")
  fi
  if [[ -n "\$BREEZE_DEVICE_ROLE" ]]; then
    ENROLL_ARGS+=(--device-role "\$BREEZE_DEVICE_ROLE")
  fi

  if ! "\$INSTALL_DIR/\$BINARY_NAME" "\${ENROLL_ARGS[@]}"; then
    fatal "Enrollment failed. Check the server URL and that the enrollment token is valid and not expired (plus the enrollment secret, if your server requires one)."
  fi
  success "Agent enrolled successfully"

  # Restart the service so it picks up the new enrollment config. Surface a
  # failure instead of swallowing it — otherwise an enrolled device that never
  # starts looks like a success to the operator.
  if ! launchctl kickstart -k system/com.breeze.agent 2>/dev/null; then
    warn "Could not restart the agent service automatically; it will start on next login or reboot."
  fi

  echo ""
  success "Breeze agent installation complete!"
  info "The device should appear in your Breeze dashboard within 60 seconds."
  info "  Check status:  sudo launchctl list | grep breeze"
  info "  View logs:     tail -f /Library/Logs/Breeze/agent.log"
  exit 0
fi

# ----- Linux: download binary directly -----
info "Fetching release integrity metadata..."
METADATA_FILE="$(mktemp)"
trap 'rm -f "\$METADATA_FILE"' EXIT

METADATA_HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$METADATA_FILE" "\$VERSION_METADATA_URL" 2>/dev/null)" || true
if [[ "\$METADATA_HTTP_CODE" != "200" ]]; then
  fatal "Failed to fetch release integrity metadata (HTTP \$METADATA_HTTP_CODE). Refusing to install without a trusted checksum."
fi

# Same path-selective interception guard as the macOS branch: a 200 whose
# body is HTML is a middlebox answering for the metadata endpoint.
if grep -qiE '<html|<!doctype' "\$METADATA_FILE"; then
  fatal "Got a web page instead of release metadata from \$BREEZE_SERVER — something on this network may be intercepting requests (captive portal, proxy, or web filter)."
fi

EXPECTED_SHA256="$(extract_checksum "\$METADATA_FILE")"
if [[ -z "\$EXPECTED_SHA256" ]]; then
  fatal "Release integrity metadata did not include a valid checksum. Refusing to install."
fi
success "Release checksum metadata fetched"

info "Downloading agent binary..."
TMPFILE="$(mktemp)"
trap 'rm -f "\$TMPFILE" "\$METADATA_FILE"' EXIT

HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$TMPFILE" "\$DOWNLOAD_URL" 2>/dev/null)" || true

if [[ "\$HTTP_CODE" != "200" ]]; then
  fatal "Failed to download agent binary (HTTP \$HTTP_CODE). Check that the server URL is correct and the binary is available."
fi

if [[ ! -s "\$TMPFILE" ]]; then
  fatal "Downloaded file is empty. The agent binary may not be built for \$OS/\$ARCH."
fi

success "Downloaded agent binary ($(wc -c < "\$TMPFILE" | tr -d ' ') bytes)"

info "Verifying agent binary checksum..."
verify_sha256 "\$TMPFILE" "\$EXPECTED_SHA256"
success "Verified agent binary checksum"

# ----- Stop existing service before replacing binary (safe for upgrades) -----
if command -v systemctl &>/dev/null && systemctl is-active --quiet breeze-agent 2>/dev/null; then
  info "Stopping existing Breeze Agent service..."
  if ! systemctl stop breeze-agent 2>&1; then
    warn "Failed to stop existing service cleanly — continuing anyway"
  fi
fi

# ----- Install binary -----
info "Installing to \$INSTALL_DIR/\$BINARY_NAME..."
mv "\$TMPFILE" "\$INSTALL_DIR/\$BINARY_NAME"
chmod 755 "\$INSTALL_DIR/\$BINARY_NAME"
# On SELinux-enforcing hosts (Fedora family) the binary inherits the mktemp
# file's user_tmp_t label through the mv, so systemd/init is denied execute
# (203/EXEC) after a reboot. Restore the default context for the install path.
# Guarded by command existence so it is a no-op on non-SELinux systems.
if command -v restorecon &>/dev/null; then
  restorecon -v "\$INSTALL_DIR/\$BINARY_NAME" 2>/dev/null || true
fi
trap - EXIT
success "Installed \$INSTALL_DIR/\$BINARY_NAME"

# ----- Create config directory -----
info "Creating config directory \$CONFIG_DIR..."
mkdir -p "\$CONFIG_DIR"
chmod 0700 "\$CONFIG_DIR"
success "Config directory ready"

# ----- Enroll agent -----
info "Enrolling agent with Breeze server..."
ENROLL_ARGS=(enroll)
# The token is mandatory and already validated above as non-empty, so append
# it unconditionally — there is no token-less enroll path.
ENROLL_ARGS+=("\$BREEZE_ENROLL_TOKEN")
ENROLL_ARGS+=(--server "\$BREEZE_SERVER")
if [[ -n "\$BREEZE_ENROLLMENT_SECRET" ]]; then
  ENROLL_ARGS+=(--enrollment-secret "\$BREEZE_ENROLLMENT_SECRET")
fi
if [[ -n "\$BREEZE_SITE_ID" ]]; then
  ENROLL_ARGS+=(--site-id "\$BREEZE_SITE_ID")
fi
if [[ -n "\$BREEZE_DEVICE_ROLE" ]]; then
  ENROLL_ARGS+=(--device-role "\$BREEZE_DEVICE_ROLE")
fi

if ! "\$INSTALL_DIR/\$BINARY_NAME" "\${ENROLL_ARGS[@]}"; then
  fatal "Enrollment failed. Check the server URL and that the enrollment token is valid and not expired (plus the enrollment secret, if your server requires one)."
fi
success "Agent enrolled successfully"

# ----- Install service -----
if command -v systemctl &>/dev/null; then
  info "Installing systemd service..."
  cat > /etc/systemd/system/breeze-agent.service <<SERVICEEOF
[Unit]
Description=Breeze RMM Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$INSTALL_DIR/$BINARY_NAME run
Restart=always
RestartSec=10
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-agent

# Security hardening
NoNewPrivileges=false
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$CONFIG_DIR

[Install]
WantedBy=multi-user.target
SERVICEEOF

  systemctl daemon-reload
  systemctl enable breeze-agent
  systemctl start breeze-agent
  success "systemd service installed and started"
else
  warn "systemd not found. Please configure the agent to start on boot manually."
  info "Run: $INSTALL_DIR/$BINARY_NAME run"
fi

echo ""
success "Breeze agent installation complete!"
info "The device should appear in your Breeze dashboard within 60 seconds."
info "  Check status:  sudo systemctl status breeze-agent"
info "  View logs:     sudo journalctl -u breeze-agent -f"
`;
}
