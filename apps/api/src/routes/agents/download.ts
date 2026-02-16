import { Hono } from 'hono';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { VALID_OS, VALID_ARCH } from './schemas';

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

  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  const extension = os === 'windows' ? '.exe' : '';
  const filename = `breeze-agent-${os}-${arch}${extension}`;
  const filePath = join(binaryDir, filename);

  if (!existsSync(filePath)) {
    return c.json(
      {
        error: 'Binary not found',
        message: `Agent binary "${filename}" is not available. Ensure the binary has been built and placed in the configured AGENT_BINARY_DIR (${binaryDir}).`,
        hint: `Run "cd agent && GOOS=${os} GOARCH=${arch} make build" to build the binary.`,
      },
      404
    );
  }

  const stat = statSync(filePath);
  const stream = createReadStream(filePath);

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
      'Content-Length': String(stat.size),
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

function generateInstallScript(serverUrl: string): string {
  return `#!/usr/bin/env bash
# ============================================
# Breeze RMM Agent - One-Line Installer
# ============================================
# Usage:
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash -s -- \\
#     --server ${serverUrl} \\
#     --enrollment-secret YOUR_SECRET
#
# Or with environment variables:
#   export BREEZE_SERVER="${serverUrl}"
#   export BREEZE_ENROLLMENT_SECRET="YOUR_SECRET"
#   curl -fsSL ${serverUrl}/api/v1/agents/install.sh | sudo bash
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
BREEZE_ENROLLMENT_SECRET="\${BREEZE_ENROLLMENT_SECRET:-}"
BREEZE_SITE_ID="\${BREEZE_SITE_ID:-}"

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    --server)
      BREEZE_SERVER="\$2"; shift 2 ;;
    --enrollment-secret)
      BREEZE_ENROLLMENT_SECRET="\$2"; shift 2 ;;
    --site-id)
      BREEZE_SITE_ID="\$2"; shift 2 ;;
    *)
      warn "Unknown argument: \$1"; shift ;;
  esac
done

# ----- Validate required parameters -----
if [[ -z "\$BREEZE_SERVER" ]]; then
  fatal "BREEZE_SERVER is required. Pass --server URL or export BREEZE_SERVER."
fi

if [[ -z "\$BREEZE_ENROLLMENT_SECRET" ]]; then
  fatal "BREEZE_ENROLLMENT_SECRET is required. Pass --enrollment-secret SECRET or export BREEZE_ENROLLMENT_SECRET."
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
CONFIG_DIR="/etc/breeze"
BINARY_NAME="breeze-agent"
DOWNLOAD_URL="\${BREEZE_SERVER}/api/v1/agents/download/\${OS}/\${ARCH}"

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

# ----- Download binary -----
info "Downloading agent binary..."
TMPFILE="$(mktemp)"
trap 'rm -f "\$TMPFILE"' EXIT

HTTP_CODE="$(curl -fsSL -w '%{http_code}' -o "\$TMPFILE" "\$DOWNLOAD_URL" 2>/dev/null)" || true

if [[ "\$HTTP_CODE" != "200" ]]; then
  fatal "Failed to download agent binary (HTTP \$HTTP_CODE). Check that the server URL is correct and the binary is available."
fi

# Verify the download is not empty
if [[ ! -s "\$TMPFILE" ]]; then
  fatal "Downloaded file is empty. The agent binary may not be built for \$OS/\$ARCH."
fi

success "Downloaded agent binary ($(wc -c < "\$TMPFILE" | tr -d ' ') bytes)"

# ----- Install binary -----
info "Installing to \$INSTALL_DIR/\$BINARY_NAME..."
mv "\$TMPFILE" "\$INSTALL_DIR/\$BINARY_NAME"
chmod 755 "\$INSTALL_DIR/\$BINARY_NAME"
trap - EXIT
success "Installed \$INSTALL_DIR/\$BINARY_NAME"

# ----- Create config directory -----
info "Creating config directory \$CONFIG_DIR..."
mkdir -p "\$CONFIG_DIR"
chmod 0700 "\$CONFIG_DIR"
success "Config directory ready"

# ----- Enroll agent -----
info "Enrolling agent with Breeze server..."
ENROLL_ARGS=(
  enroll
  --server "\$BREEZE_SERVER"
  --enrollment-secret "\$BREEZE_ENROLLMENT_SECRET"
)
if [[ -n "\$BREEZE_SITE_ID" ]]; then
  ENROLL_ARGS+=(--site-id "\$BREEZE_SITE_ID")
fi

if ! "\$INSTALL_DIR/\$BINARY_NAME" "\${ENROLL_ARGS[@]}"; then
  fatal "Enrollment failed. Check the server URL and enrollment secret."
fi
success "Agent enrolled successfully"

# ----- Install service -----
install_systemd_service() {
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
}

install_launchd_service() {
  info "Installing launchd service..."
  local plist_path="/Library/LaunchDaemons/com.breeze.agent.plist"
  cat > "\$plist_path" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$INSTALL_DIR/$BINARY_NAME</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/breeze-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/breeze-agent.err</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
PLISTEOF

  chmod 644 "\$plist_path"
  launchctl load "\$plist_path"
  success "launchd service installed and started"
}

case "\$OS" in
  linux)
    if command -v systemctl &>/dev/null; then
      install_systemd_service
    else
      warn "systemd not found. Please configure the agent to start on boot manually."
      info "Run: $INSTALL_DIR/$BINARY_NAME run"
    fi
    ;;
  darwin)
    install_launchd_service
    ;;
esac

echo ""
success "Breeze agent installation complete!"
info "The device should appear in your Breeze dashboard within 60 seconds."
info "  Check status:  sudo systemctl status breeze-agent  (Linux)"
info "                 sudo launchctl list | grep breeze    (macOS)"
info "  View logs:     sudo journalctl -u breeze-agent -f  (Linux)"
`;
}
