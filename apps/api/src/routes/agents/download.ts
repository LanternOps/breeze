import { Hono } from 'hono';
import { statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { VALID_OS, VALID_ARCH } from './schemas';
import { isS3Configured, getPresignedUrl, isS3NotFound } from '../../services/s3Storage';
import { getBinarySource, getGithubAgentUrl, getGithubAgentPkgUrl, getGithubHelperUrl, getGithubUserHelperUrl, getGithubWatchdogUrl, getGithubBackupUrl, HELPER_FILENAMES } from '../../services/binarySource';
import { getPromotedComponentVersion, type PromotedComponent } from '../../services/promotedAgentVersion';

export const downloadRoutes = new Hono();

// ============================================
// Shared component-binary download handler
// ============================================
// The agent/helper/watchdog/backup/user-helper routes below are five
// near-verbatim copies of the same ~90-line shape: validate os/arch → GitHub
// redirect (BINARY_SOURCE=github) → S3 presign (404-falls-to-disk,
// non-404→500) → disk stream. registerComponentDownloadRoute hoists that
// shape into one place so a future fix (e.g. stream backpressure) lands
// once. The .pkg and install.sh/uninstall.sh routes have real behavioral
// differences (macOS-only, different validation/response shape) and are
// deliberately NOT folded in here.
interface ComponentDownloadConfig {
  /** Route path registered on downloadRoutes, e.g. '/download/watchdog/:os/:arch'. */
  path: string;
  /** Log-line prefix, e.g. 'watchdog-download' → '[watchdog-download] ...'. */
  logTag: string;
  /** S3 key prefix, e.g. 'watchdog' → 'watchdog/breeze-watchdog-linux-amd64'. */
  s3Prefix: string;
  /** Human label used in the 404 body, e.g. 'Watchdog binary "..." is not available.' */
  entityLabel: string;
  /** Resolves the on-disk filename for a validated (os, arch) pair. */
  filenameFor: (os: string, arch: string) => string | undefined;
  /** 400 message when filenameFor returns undefined (helper's per-OS lookup table). */
  invalidOsMessage?: (os: string) => string;
  /**
   * agent_versions.component value for this route, used to resolve the
   * promoted (isLatest) release the bytes must come from (#3499).
   */
  component: PromotedComponent;
  /**
   * Canonical GitHub release asset URL for BINARY_SOURCE=github. `version`
   * pins the release tag to the promoted agent_versions row; when omitted the
   * builder falls back to the env-resolved BINARY_VERSION/BREEZE_VERSION.
   */
  githubUrlFor: (os: string, arch: string, version?: string) => string;
  /** Local binary directory to serve from in non-github mode. */
  binaryDir: () => string;
}

// breeze-{component}-{os}-{arch}[.exe] — the shape shared by agent, watchdog,
// backup, and user-helper (helper uses its own HELPER_FILENAMES lookup instead).
function perArchFilename(component: string) {
  return (os: string, arch: string) =>
    `breeze-${component}-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
}

function registerComponentDownloadRoute(config: ComponentDownloadConfig): void {
  downloadRoutes.get(config.path, async (c) => {
    // config.path is a runtime string (not a literal), so Hono can't narrow
    // the param keys at the type level the way it does for the inline
    // `.get('/download/:os/:arch', ...)` routes this replaced — every
    // registered path always includes :os/:arch, so this is safe at runtime.
    const os = c.req.param('os') as string;
    const arch = c.req.param('arch') as string;

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

    const filename = config.filenameFor(os, arch);
    if (!filename) {
      return c.json(
        { error: 'Invalid OS', message: config.invalidOsMessage!(os) },
        400
      );
    }

    // GitHub redirect mode — no local binaries needed.
    //
    // #3499: pin the release tag to the same agent_versions isLatest row that
    // GET /agent-versions/latest serves the checksum from. Resolving it from
    // per-process env here instead let the bytes and the checksum drift a full
    // release apart whenever the binary sync stalled, which install.sh reports
    // as "Checksum verification failed for downloaded agent binary".
    //
    // null means "no promoted row at all" — the cold-start state of a
    // deployment that has never synced — so fall back to the env-resolved URL
    // and keep those deployments working exactly as they did. A lookup FAULT
    // is different and throws: serving the env version then would reintroduce
    // the very mismatch this fixes and report a server-side DB fault to the
    // end user as a checksum failure.
    if (getBinarySource() === 'github') {
      let redirectUrl: string;
      try {
        const promotedVersion = await getPromotedComponentVersion(
          config.component,
          os,
          arch,
        );
        // Inside the try on purpose: the URL builder ALSO throws — on a
        // malformed release tag, which a promoted row can carry because
        // agent_versions.version has no format constraint. That is the same
        // "we cannot determine a release to serve" condition, so it belongs on
        // the same 503 rather than falling through to a bare 500.
        redirectUrl = config.githubUrlFor(os, arch, promotedVersion ?? undefined);
      } catch (err) {
        console.error(
          `[${config.logTag}] refusing to serve ${filename}: could not resolve a release to redirect to`,
          err,
        );
        return c.json(
          {
            error: 'Service unavailable',
            message:
              'Could not determine the current release. Retry shortly; if this persists, check the API logs.',
          },
          503,
          { 'Retry-After': '30' },
        );
      }
      return c.redirect(redirectUrl, 302);
    }

    // Local mode: try S3 presigned redirect first (bandwidth offload)
    if (isS3Configured()) {
      try {
        const s3Key = `${config.s3Prefix}/${filename}`;
        const url = await getPresignedUrl(s3Key);
        return c.redirect(url, 302);
      } catch (err) {
        if (!isS3NotFound(err)) {
          // Real S3 transport/auth fault — surface it instead of masking it as a
          // disk-fallback 404. The binary may well exist in S3; we just couldn't reach it.
          console.error(`[${config.logTag}] S3 presign failed for ${filename}:`, err);
          return c.json({ error: 'Internal server error', message: 'Failed to retrieve binary file' }, 500);
        }
        console.warn(`[${config.logTag}] S3 object missing for ${filename}, falling back to disk:`, err);
      }
    }

    // Local mode: serve from disk
    const binaryDir = config.binaryDir();
    const filePath = join(binaryDir, filename);

    let fileStat: ReturnType<typeof statSync>;
    let stream: ReturnType<typeof createReadStream>;
    try {
      fileStat = statSync(filePath);
      stream = createReadStream(filePath);
    } catch (err) {
      const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isNotFound) {
        console.error(`[${config.logTag}] Failed to read binary ${filename}:`, err);
        return c.json({ error: 'Internal server error', message: 'Failed to read binary file' }, 500);
      }
      console.warn(`[${config.logTag}] Local binary missing`, { filename });
      return c.json(
        {
          error: 'Binary not found',
          message: `${config.entityLabel} "${filename}" is not available.`,
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
          console.error(`[${config.logTag}] Stream error while serving ${filename}:`, err);
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
}

// ============================================
// Agent Binary Download (public, no auth)
// ============================================

registerComponentDownloadRoute({
  path: '/download/:os/:arch',
  logTag: 'agent-download',
  s3Prefix: 'agent',
  entityLabel: 'Agent binary',
  component: 'agent',
  filenameFor: perArchFilename('agent'),
  githubUrlFor: getGithubAgentUrl,
  binaryDir: () => resolve(process.env.AGENT_BINARY_DIR || './agent/bin'),
});

// ============================================
// Raw Agent MSI Download (Windows, public, no auth)
// ============================================
// Serves the staged installer VERBATIM — unlike the enrollment installer
// routes (routes/enrollmentKeys.ts), no per-download bootstrap token is
// embedded, so the bytes have a stable sha256. That stability is the point:
// the automatic edition migration (#4072, services/agentEditionAutoMigrate.ts)
// pins the download to a sha256 it computes from this same file, and the
// migration script verifies before touching the installed agent. A raw MSI
// enrolls nothing on its own (no token, no server config), so like the other
// binary routes above it is safe to serve unauthenticated.
//
// Deliberately DISK-ONLY (no S3 presign, no github redirect): the sha pin is
// computed from the local staged file, and serving any other source could
// hand out bytes that don't match it. BINARY_SOURCE=github deployments get a
// 404 here and auto edition migration stays inert.
downloadRoutes.get('/download/windows/amd64/msi', async (c) => {
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const filePath = join(binaryDir, 'breeze-agent.msi');

  let fileStat: ReturnType<typeof statSync>;
  let stream: ReturnType<typeof createReadStream>;
  try {
    fileStat = statSync(filePath);
    stream = createReadStream(filePath);
  } catch (err) {
    const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      console.error('[agent-msi-download] Failed to read breeze-agent.msi:', err);
      return c.json({ error: 'Internal server error', message: 'Failed to read installer file' }, 500);
    }
    console.warn('[agent-msi-download] Staged MSI missing', { filePath });
    return c.json(
      { error: 'Installer not found', message: 'The agent MSI installer is not staged on this server.' },
      404
    );
  }

  // Readable.toWeb (not the hand-rolled bridge the older routes in this file
  // still use) gets backpressure and zero-copy chunk transfer for free — same
  // as the ticket-attachment streams.
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="breeze-agent.msi"',
      'Content-Length': String(fileStat.size),
      'Cache-Control': 'no-cache',
    },
  });
});

// ============================================
// Agent .pkg Installer Download (macOS, public, no auth)
// ============================================
// Deliberately NOT version-pinned to the promoted agent_versions row the way
// the five component routes above are (#3499). install.sh's macOS branch never
// sha256-checks the .pkg against /agent-versions/latest — it verifies xar magic
// bytes and Apple notarization via `spctl --assess` instead — so there is no
// checksum/bytes pair here to keep consistent, and no install-time failure to
// prevent. The tradeoff is that a macOS install lands on the env-resolved
// release while Linux lands on the promoted one; the agent reconciles on its
// first heartbeat, which offers the promoted version through the normal
// verified updater path.
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
      if (!isS3NotFound(err)) {
        console.error(`[pkg-download] S3 presign failed for ${filename}:`, err);
        return c.json({ error: 'Internal server error', message: 'Failed to retrieve installer package' }, 500);
      }
      console.warn(`[pkg-download] S3 object missing for ${filename}, falling back to disk:`, err);
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

registerComponentDownloadRoute({
  path: '/download/helper/:os/:arch',
  logTag: 'helper-download',
  s3Prefix: 'helper',
  entityLabel: 'Helper binary',
  component: 'helper',
  filenameFor: (os) => HELPER_FILENAMES[os],
  invalidOsMessage: (os) => `No helper binary available for OS: ${os}`,
  githubUrlFor: (os, _arch, version) => getGithubHelperUrl(os, version),
  binaryDir: () => resolve(process.env.HELPER_BINARY_DIR || './agent/bin'),
});

// ============================================
// Watchdog Binary Download (public, no auth)
// ============================================
// Per-arch like the agent (breeze-watchdog-{os}-{arch}[.exe]). The agent's
// reconcileWatchdog and the watchdog's own failover self-update fetch this via
// /agent-versions/:version/download?component=watchdog, which hands back this
// same-origin URL so the downloader's host-match guard passes (see
// buildServerRelativeAgentDownloadUrl + issue #646).
registerComponentDownloadRoute({
  path: '/download/watchdog/:os/:arch',
  logTag: 'watchdog-download',
  s3Prefix: 'watchdog',
  entityLabel: 'Watchdog binary',
  component: 'watchdog',
  filenameFor: perArchFilename('watchdog'),
  githubUrlFor: getGithubWatchdogUrl,
  binaryDir: () => resolve(process.env.AGENT_BINARY_DIR || './agent/bin'),
});

// ============================================
// Backup Binary Download (public, no auth)
// ============================================
// Per-arch like the agent (breeze-backup-{os}-{arch}[.exe]). install.sh fetches
// this as a non-fatal post-install step, and /agent-versions/:version/download
// hands back this same-origin URL for component=backup so any future verified
// self-heal fetch passes the downloader's host-match guard (see
// buildServerRelativeAgentDownloadUrl). Mirrors the watchdog route exactly.
registerComponentDownloadRoute({
  path: '/download/backup/:os/:arch',
  logTag: 'backup-download',
  s3Prefix: 'backup',
  entityLabel: 'Backup binary',
  component: 'backup',
  filenameFor: perArchFilename('backup'),
  githubUrlFor: getGithubBackupUrl,
  binaryDir: () => resolve(process.env.AGENT_BINARY_DIR || './agent/bin'),
});

// breeze-user-helper: the GUI-subsystem sibling of breeze-agent (Windows in
// practice; route stays OS-general like the watchdog route it mirrors),
// spawned by the agent's sessionbroker into the interactive user session. It is
// a distinct binary from the Tauri "helper" app (/download/helper) and is
// fetched by the agent's verified updater (component=user-helper). Without this
// server-relative route the agent-versions response handed back the canonical
// github.com asset URL, which the updater's host-equality check rejects (#1878).
// Mirrors the watchdog route: github redirect / S3 presign / local disk.
registerComponentDownloadRoute({
  path: '/download/user-helper/:os/:arch',
  logTag: 'user-helper-download',
  s3Prefix: 'user-helper',
  entityLabel: 'User-helper binary',
  component: 'user-helper',
  filenameFor: perArchFilename('user-helper'),
  githubUrlFor: getGithubUserHelperUrl,
  binaryDir: () => resolve(process.env.AGENT_BINARY_DIR || './agent/bin'),
});

// ============================================
// Install Script (public, no auth)
// ============================================

function resolveInstallScriptServerUrl(requestUrl: string): string | null {
  const configured =
    process.env.BREEZE_SERVER ||
    process.env.PUBLIC_API_URL ||
    process.env.API_URL;
  if (configured) return configured.replace(/\/$/, '');

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  return new URL(requestUrl).origin.replace(/\/$/, '');
}

downloadRoutes.get('/install.sh', async (c) => {
  const serverUrl = resolveInstallScriptServerUrl(c.req.url);
  if (!serverUrl) {
    return c.json(
      { error: 'Installer script unavailable: server URL is not configured' },
      503
    );
  }

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
BACKUP_BINARY="/usr/local/bin/breeze-backup"

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
  rm -f "$BACKUP_BINARY"

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
  rm -f "$BACKUP_BINARY"
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
BACKUP_DOWNLOAD_URL="\${BREEZE_SERVER}/api/v1/agents/download/backup/\${OS}/\${ARCH}"
BACKUP_VERSION_METADATA_URL="\${BREEZE_SERVER}/api/v1/agent-versions/latest?platform=\${OS}&arch=\${ARCH}&component=backup"

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

# ----- Install breeze-backup (non-fatal) -----
# breeze-backup runs scheduled backup jobs; it is a separate release asset from
# the agent and its absence does not block enrollment or monitoring. The whole
# step runs in a subshell so \`fatal\` (which calls exit) only aborts backup
# installation, not the rest of this script — reuses the same
# fetch/extract_checksum/verify_sha256 helpers as the agent binary above.
info "Fetching breeze-backup..."
if (
  BACKUP_METADATA_FILE="$(mktemp)"
  trap 'rm -f "\$BACKUP_METADATA_FILE"' EXIT

  BACKUP_METADATA_HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$BACKUP_METADATA_FILE" "\$BACKUP_VERSION_METADATA_URL" 2>/dev/null)" || true
  if [[ "\$BACKUP_METADATA_HTTP_CODE" != "200" ]]; then
    fatal "Failed to fetch breeze-backup release metadata (HTTP \$BACKUP_METADATA_HTTP_CODE)."
  fi

  BACKUP_EXPECTED_SHA256="$(extract_checksum "\$BACKUP_METADATA_FILE")"
  if [[ -z "\$BACKUP_EXPECTED_SHA256" ]]; then
    fatal "breeze-backup release metadata did not include a valid checksum."
  fi

  BACKUP_TMPFILE="$(mktemp)"
  trap 'rm -f "\$BACKUP_TMPFILE" "\$BACKUP_METADATA_FILE"' EXIT

  BACKUP_HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$BACKUP_TMPFILE" "\$BACKUP_DOWNLOAD_URL" 2>/dev/null)" || true
  if [[ "\$BACKUP_HTTP_CODE" != "200" ]]; then
    fatal "Failed to download breeze-backup binary (HTTP \$BACKUP_HTTP_CODE)."
  fi
  if [[ ! -s "\$BACKUP_TMPFILE" ]]; then
    fatal "Downloaded breeze-backup binary is empty."
  fi

  verify_sha256 "\$BACKUP_TMPFILE" "\$BACKUP_EXPECTED_SHA256"

  # This subshell is the test of an \`if\`, so \`set -e\` is ignored inside it —
  # mv/chmod failures would otherwise be silently swallowed instead of tripping
  # the subshell's exit status. Check each explicitly and route through fatal
  # (an unconditional \`exit\`, unaffected by -e) so a real failure here is
  # reported as "could not be installed", not a false success.
  if ! mv "\$BACKUP_TMPFILE" "\$INSTALL_DIR/breeze-backup"; then
    fatal "Failed to install breeze-backup binary to \$INSTALL_DIR/breeze-backup."
  fi
  if ! chmod 755 "\$INSTALL_DIR/breeze-backup"; then
    fatal "Failed to set permissions on \$INSTALL_DIR/breeze-backup."
  fi
  if command -v restorecon &>/dev/null; then
    restorecon -v "\$INSTALL_DIR/breeze-backup" 2>/dev/null || true
  fi
  trap - EXIT
); then
  success "Installed \$INSTALL_DIR/breeze-backup"
else
  warn "breeze-backup helper could not be installed; backups will not run until it is present"
fi

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
