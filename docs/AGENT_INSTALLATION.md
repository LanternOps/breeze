# Breeze Agent Installation Guide

This guide provides comprehensive instructions for installing, configuring, and managing the Breeze RMM agent across all supported platforms.

---

## Table of Contents

1. [Overview](#overview)
2. [System Requirements](#system-requirements)
3. [Quick Install](#quick-install)
4. [Manual Installation](#manual-installation)
5. [Enrollment](#enrollment)
6. [Configuration Options](#configuration-options)
7. [Service Management](#service-management)
8. [Troubleshooting](#troubleshooting)
9. [Uninstallation](#uninstallation)
10. [Security Considerations](#security-considerations)

---

## Overview

The Breeze Agent is a lightweight, cross-platform monitoring and management agent that enables remote administration of endpoints. Once installed, the agent:

- Reports system metrics (CPU, memory, disk, network) to the Breeze server
- Executes remote commands and scripts
- Enables remote desktop access via WebRTC
- Monitors system health and generates alerts
- Supports automated remediation through policies
- Provides real-time and scheduled task execution

### Supported Platforms

| Platform | Architecture | Minimum Version |
|----------|--------------|-----------------|
| Windows | x64, ARM64 | Windows 10 / Server 2016+ |
| macOS | x64 (Intel), ARM64 (Apple Silicon) | macOS 11 (Big Sur)+ |
| Linux | x64, ARM64 | Kernel 4.15+ (Ubuntu 18.04+, RHEL 8+, Debian 10+) |

---

## System Requirements

### Hardware Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 core | 2 cores |
| RAM | 64 MB | 128 MB |
| Disk | 100 MB | 500 MB |

### Network Requirements

The agent requires outbound connectivity to communicate with the Breeze server:

| Protocol | Port | Purpose |
|----------|------|---------|
| HTTPS | 443 | API communication, enrollment, heartbeat |
| WSS | 443 | WebSocket real-time communication |
| UDP | 3478 | STUN/TURN for WebRTC (remote access) |
| UDP | 49152-65535 | WebRTC media (remote access) |

### Firewall Rules

Ensure the following outbound connections are allowed:

```
# API and WebSocket
*.your-breeze-domain.com:443 (TCP)

# WebRTC STUN/TURN (if using remote access)
turn.your-breeze-domain.com:3478 (UDP)
```

---

## Quick Install

### Windows (PowerShell)

Run PowerShell as Administrator and execute:

```powershell
# One-liner install with automatic enrollment
irm https://your-server.com/install.ps1 | iex

# Or with enrollment key
$env:BREEZE_ENROLLMENT_KEY = "your-enrollment-key"
$env:BREEZE_SERVER_URL = "https://your-server.com"
irm https://your-server.com/install.ps1 | iex
```

### macOS (Bash)

Open Terminal and execute:

```bash
# One-liner install with automatic enrollment
curl -fsSL https://your-server.com/install.sh | sudo bash

# Or with enrollment key
curl -fsSL https://your-server.com/install.sh | sudo BREEZE_ENROLLMENT_KEY="your-enrollment-key" BREEZE_SERVER_URL="https://your-server.com" bash
```

### Linux (Bash)

Open a terminal and execute:

```bash
# One-liner install with automatic enrollment
curl -fsSL https://your-server.com/install.sh | sudo bash

# Or with enrollment key
curl -fsSL https://your-server.com/install.sh | sudo BREEZE_ENROLLMENT_KEY="your-enrollment-key" BREEZE_SERVER_URL="https://your-server.com" bash
```

---

## Manual Installation

### Download Locations

Download the appropriate binary for your platform:

| Platform | Architecture | Download URL |
|----------|--------------|--------------|
| Windows | x64 | `https://your-server.com/downloads/breeze-agent-windows-amd64.exe` |
| Windows | ARM64 | `https://your-server.com/downloads/breeze-agent-windows-arm64.exe` |
| macOS | x64 (Intel) | `https://your-server.com/downloads/breeze-agent-darwin-amd64` |
| macOS | ARM64 (Apple Silicon) | `https://your-server.com/downloads/breeze-agent-darwin-arm64` |
| Linux | x64 | `https://your-server.com/downloads/breeze-agent-linux-amd64` |
| Linux | ARM64 | `https://your-server.com/downloads/breeze-agent-linux-arm64` |

### Verifying Downloads

Each download includes a corresponding checksum file. Verify the integrity before installation:

**Windows (PowerShell):**
```powershell
# Download checksum
Invoke-WebRequest -Uri "https://your-server.com/downloads/breeze-agent-windows-amd64.exe.sha256" -OutFile "breeze-agent.exe.sha256"

# Verify
$expected = (Get-Content breeze-agent.exe.sha256).Split(" ")[0]
$actual = (Get-FileHash breeze-agent.exe -Algorithm SHA256).Hash.ToLower()
if ($expected -eq $actual) { Write-Host "Checksum verified" -ForegroundColor Green } else { Write-Host "Checksum mismatch!" -ForegroundColor Red }
```

**macOS / Linux:**
```bash
# Download checksum
curl -fsSL https://your-server.com/downloads/breeze-agent-linux-amd64.sha256 -o breeze-agent.sha256

# Verify
echo "$(cat breeze-agent.sha256)  breeze-agent" | sha256sum -c -
```

---

### Windows Installation

#### Step 1: Download the Agent

```powershell
# Create installation directory
New-Item -ItemType Directory -Force -Path "C:\Program Files\Breeze"

# Download the agent
Invoke-WebRequest -Uri "https://your-server.com/downloads/breeze-agent-windows-amd64.exe" -OutFile "C:\Program Files\Breeze\breeze-agent.exe"
```

#### Step 2: Install the Service

Run Command Prompt or PowerShell as Administrator:

```powershell
# Install the Windows service
& "C:\Program Files\Breeze\breeze-agent.exe" install

# Start the service
& "C:\Program Files\Breeze\breeze-agent.exe" start
```

#### Step 3: Verify Installation

```powershell
# Check service status
& "C:\Program Files\Breeze\breeze-agent.exe" status

# Or via Windows Services
Get-Service -Name "BreezeAgent"
```

#### File Locations (Windows)

| Type | Location |
|------|----------|
| Binary | `C:\Program Files\Breeze\breeze-agent.exe` |
| Configuration | `C:\ProgramData\Breeze\config.yaml` |
| Logs | `C:\ProgramData\Breeze\logs\` |
| Data | `C:\ProgramData\Breeze\data\` |

---

### macOS Installation

#### Step 1: Download the Agent

```bash
# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    BINARY_URL="https://your-server.com/downloads/breeze-agent-darwin-arm64"
else
    BINARY_URL="https://your-server.com/downloads/breeze-agent-darwin-amd64"
fi

# Download
sudo curl -fsSL "$BINARY_URL" -o /usr/local/bin/breeze-agent
sudo chmod +x /usr/local/bin/breeze-agent
```

#### Step 2: Create Configuration Directory

```bash
sudo mkdir -p /etc/breeze
sudo mkdir -p /var/log/breeze
sudo mkdir -p /var/lib/breeze
```

#### Step 3: Install LaunchDaemon

Create the LaunchDaemon plist file:

```bash
sudo tee /Library/LaunchDaemons/com.breeze.agent.plist > /dev/null << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-agent</string>
        <string>run</string>
        <string>--config</string>
        <string>/etc/breeze/config.yaml</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/breeze/agent.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/breeze/agent.error.log</string>
    <key>WorkingDirectory</key>
    <string>/var/lib/breeze</string>
</dict>
</plist>
EOF
```

#### Step 4: Load and Start the Service

```bash
# Load the LaunchDaemon
sudo launchctl load /Library/LaunchDaemons/com.breeze.agent.plist

# Verify it's running
sudo launchctl list | grep breeze
```

#### File Locations (macOS)

| Type | Location |
|------|----------|
| Binary | `/usr/local/bin/breeze-agent` |
| Configuration | `/etc/breeze/config.yaml` |
| Logs | `/var/log/breeze/` |
| Data | `/var/lib/breeze/` |
| LaunchDaemon | `/Library/LaunchDaemons/com.breeze.agent.plist` |

---

### Linux Installation

#### Step 1: Download the Agent

```bash
# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64) BINARY_ARCH="amd64" ;;
    aarch64) BINARY_ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Download
sudo curl -fsSL "https://your-server.com/downloads/breeze-agent-linux-${BINARY_ARCH}" -o /usr/local/bin/breeze-agent
sudo chmod +x /usr/local/bin/breeze-agent
```

#### Step 2: Create Configuration Directory

```bash
sudo mkdir -p /etc/breeze
sudo mkdir -p /var/log/breeze
sudo mkdir -p /var/lib/breeze
```

#### Step 3: Create Systemd Service

```bash
sudo tee /etc/systemd/system/breeze-agent.service > /dev/null << 'EOF'
[Unit]
Description=Breeze RMM Agent
Documentation=https://docs.breeze.io
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/breeze-agent run --config /etc/breeze/config.yaml
Restart=always
RestartSec=10
StandardOutput=append:/var/log/breeze/agent.log
StandardError=append:/var/log/breeze/agent.error.log
WorkingDirectory=/var/lib/breeze

# Security hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/breeze /var/log/breeze /etc/breeze
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
```

#### Step 4: Enable and Start the Service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service to start on boot
sudo systemctl enable breeze-agent

# Start the service
sudo systemctl start breeze-agent

# Check status
sudo systemctl status breeze-agent
```

#### File Locations (Linux)

| Type | Location |
|------|----------|
| Binary | `/usr/local/bin/breeze-agent` |
| Configuration | `/etc/breeze/config.yaml` |
| Logs | `/var/log/breeze/` or `journalctl -u breeze-agent` |
| Data | `/var/lib/breeze/` |
| Systemd Unit | `/etc/systemd/system/breeze-agent.service` |

---

## Enrollment

Before the agent can communicate with your Breeze server, it must be enrolled. Enrollment associates the agent with your organization and configures secure communication.

### Step 1: Generate an Enrollment Key

1. Log in to the Breeze web console
2. Navigate to **Settings** > **Enrollment Keys**
3. Click **Create New Key**
4. Configure the key:
   - **Name**: A descriptive name (e.g., "Windows Workstations")
   - **Organization**: Select the target organization
   - **Site**: (Optional) Assign to a specific site
   - **Device Group**: (Optional) Assign to a device group
   - **Expiration**: Set an expiration date or "Never"
   - **Usage Limit**: Maximum number of enrollments (optional)
5. Click **Create** and copy the enrollment key

### Step 2: Run Enrollment

**Windows (PowerShell as Administrator):**
```powershell
& "C:\Program Files\Breeze\breeze-agent.exe" enroll `
    --key "YOUR_ENROLLMENT_KEY" `
    --server "https://your-server.com"
```

**macOS / Linux:**
```bash
sudo /usr/local/bin/breeze-agent enroll \
    --key "YOUR_ENROLLMENT_KEY" \
    --server "https://your-server.com"
```

### Step 3: Verify Enrollment

**Windows:**
```powershell
& "C:\Program Files\Breeze\breeze-agent.exe" status
```

**macOS / Linux:**
```bash
sudo /usr/local/bin/breeze-agent status
```

Expected output for successful enrollment:
```
Breeze Agent Status
-------------------
Agent ID:       abc12345-6789-def0-1234-567890abcdef
Hostname:       WORKSTATION-01
Status:         Connected
Server:         https://your-server.com
Last Heartbeat: 2024-01-15 10:30:45 UTC
Uptime:         2h 15m 30s
Version:        1.0.0
```

### Enrollment Options

| Option | Description |
|--------|-------------|
| `--key` | Enrollment key from the web console |
| `--server` | Breeze server URL |
| `--tags` | Comma-separated tags for the device |
| `--hostname` | Override detected hostname |
| `--site-id` | Override site assignment |

Example with additional options:
```bash
sudo breeze-agent enroll \
    --key "YOUR_KEY" \
    --server "https://your-server.com" \
    --tags "production,web-server,nginx" \
    --hostname "web-prod-01"
```

---

## Configuration Options

The agent is configured via a YAML file. After enrollment, the configuration file is automatically created.

### Configuration File Location

| Platform | Path |
|----------|------|
| Windows | `C:\ProgramData\Breeze\config.yaml` |
| macOS | `/etc/breeze/config.yaml` |
| Linux | `/etc/breeze/config.yaml` |

### Full Configuration Reference

```yaml
# Breeze Agent Configuration
# ==========================

# Server Connection
# -----------------
server_url: "https://your-server.com"
  # The URL of your Breeze server
  # Required for agent operation

# Agent Identity
# --------------
agent_id: "auto-generated-uuid"
  # Unique identifier assigned during enrollment
  # DO NOT modify this value

device_name: ""
  # Custom device name (overrides hostname)
  # Leave empty to use system hostname

# Heartbeat Settings
# ------------------
heartbeat_interval: 60
  # Interval in seconds between heartbeat messages
  # Range: 10-300
  # Default: 60

heartbeat_timeout: 30
  # Timeout in seconds for heartbeat requests
  # Range: 5-60
  # Default: 30

# Metrics Collection
# ------------------
metrics_enabled: true
  # Enable or disable metrics collection
  # Default: true

metrics_interval: 300
  # Interval in seconds between metrics collection
  # Range: 60-3600
  # Default: 300 (5 minutes)

metrics_collectors:
  # Enable/disable specific metric collectors
  cpu: true
  memory: true
  disk: true
  network: true
  processes: true
  services: true
  # Platform-specific collectors
  windows_events: true  # Windows only
  smart: false          # Requires smartctl

# Logging
# -------
log_level: "info"
  # Logging verbosity
  # Options: debug, info, warn, error
  # Default: info

log_max_size: 100
  # Maximum log file size in MB before rotation
  # Default: 100

log_max_files: 5
  # Number of rotated log files to keep
  # Default: 5

log_format: "json"
  # Log output format
  # Options: json, text
  # Default: json

# TLS / Security
# --------------
tls:
  enabled: true
    # Enable TLS for server communication
    # Default: true (required for production)

  verify_server: true
    # Verify server TLS certificate
    # Default: true
    # WARNING: Only disable for testing

  ca_cert: ""
    # Path to custom CA certificate
    # Leave empty to use system CA store

  client_cert: ""
    # Path to client certificate (for mTLS)
    # Optional

  client_key: ""
    # Path to client private key (for mTLS)
    # Optional

# Proxy Settings
# --------------
proxy:
  enabled: false
    # Enable proxy for server communication
    # Default: false

  url: ""
    # Proxy URL (e.g., http://proxy.example.com:8080)

  username: ""
    # Proxy authentication username

  password: ""
    # Proxy authentication password
    # Consider using environment variable instead

# Remote Access
# -------------
remote_access:
  enabled: true
    # Enable remote desktop/terminal access
    # Default: true

  require_approval: false
    # Require user approval before remote session
    # Default: false

  approval_timeout: 60
    # Seconds to wait for user approval
    # Default: 60

# Script Execution
# ----------------
scripts:
  enabled: true
    # Enable remote script execution
    # Default: true

  allowed_interpreters:
    # Allowed script interpreters
    - powershell  # Windows
    - cmd         # Windows
    - bash        # macOS/Linux
    - sh          # macOS/Linux
    - python3     # All platforms (if installed)

  max_runtime: 3600
    # Maximum script runtime in seconds
    # Default: 3600 (1 hour)

  working_directory: ""
    # Default working directory for scripts
    # Leave empty for system default

# Resource Limits
# ---------------
resources:
  max_cpu_percent: 10
    # Maximum CPU usage for agent operations
    # Default: 10

  max_memory_mb: 256
    # Maximum memory usage in MB
    # Default: 256

# Advanced
# --------
advanced:
  reconnect_interval: 30
    # Seconds between reconnection attempts
    # Default: 30

  max_reconnect_attempts: 0
    # Maximum reconnection attempts (0 = unlimited)
    # Default: 0

  buffer_size: 1000
    # Event buffer size for offline operation
    # Default: 1000
```

### Environment Variable Overrides

Configuration values can be overridden using environment variables:

| Config Key | Environment Variable |
|------------|---------------------|
| `server_url` | `BREEZE_SERVER_URL` |
| `heartbeat_interval` | `BREEZE_HEARTBEAT_INTERVAL` |
| `metrics_interval` | `BREEZE_METRICS_INTERVAL` |
| `log_level` | `BREEZE_LOG_LEVEL` |
| `proxy.url` | `BREEZE_PROXY_URL` |
| `proxy.username` | `BREEZE_PROXY_USERNAME` |
| `proxy.password` | `BREEZE_PROXY_PASSWORD` |

---

## Service Management

### Windows

```powershell
# Check status
& "C:\Program Files\Breeze\breeze-agent.exe" status

# Start service
& "C:\Program Files\Breeze\breeze-agent.exe" start
# Or: Start-Service -Name "BreezeAgent"

# Stop service
& "C:\Program Files\Breeze\breeze-agent.exe" stop
# Or: Stop-Service -Name "BreezeAgent"

# Restart service
& "C:\Program Files\Breeze\breeze-agent.exe" restart
# Or: Restart-Service -Name "BreezeAgent"

# View service in Services.msc
services.msc
```

### macOS

```bash
# Check status
sudo launchctl list | grep breeze

# Start service
sudo launchctl load /Library/LaunchDaemons/com.breeze.agent.plist

# Stop service
sudo launchctl unload /Library/LaunchDaemons/com.breeze.agent.plist

# Restart service
sudo launchctl unload /Library/LaunchDaemons/com.breeze.agent.plist
sudo launchctl load /Library/LaunchDaemons/com.breeze.agent.plist

# View logs
tail -f /var/log/breeze/agent.log
```

### Linux (Systemd)

```bash
# Check status
sudo systemctl status breeze-agent

# Start service
sudo systemctl start breeze-agent

# Stop service
sudo systemctl stop breeze-agent

# Restart service
sudo systemctl restart breeze-agent

# Enable on boot
sudo systemctl enable breeze-agent

# Disable on boot
sudo systemctl disable breeze-agent

# View logs (journald)
sudo journalctl -u breeze-agent -f

# View logs (file)
tail -f /var/log/breeze/agent.log
```

---

## Troubleshooting

### Common Issues

#### Agent Won't Start

**Symptoms:** Service fails to start, exits immediately

**Solutions:**
1. Check the configuration file for syntax errors:
   ```bash
   # Linux/macOS
   sudo /usr/local/bin/breeze-agent validate --config /etc/breeze/config.yaml

   # Windows
   & "C:\Program Files\Breeze\breeze-agent.exe" validate --config "C:\ProgramData\Breeze\config.yaml"
   ```

2. Check file permissions:
   ```bash
   # Linux/macOS
   ls -la /etc/breeze/config.yaml
   # Should be readable by root
   ```

3. Check for port conflicts or firewall issues

4. Review logs for specific error messages

#### Agent Not Connecting

**Symptoms:** Agent starts but shows "Disconnected" status

**Solutions:**
1. Verify network connectivity:
   ```bash
   # Test server reachability
   curl -I https://your-server.com/api/health
   ```

2. Check DNS resolution:
   ```bash
   nslookup your-server.com
   ```

3. Verify firewall rules allow outbound HTTPS (443)

4. If using a proxy, verify proxy settings in config.yaml

5. Check TLS certificate validity:
   ```bash
   openssl s_client -connect your-server.com:443 -servername your-server.com
   ```

#### Enrollment Fails

**Symptoms:** "Enrollment failed" or "Invalid key" error

**Solutions:**
1. Verify the enrollment key hasn't expired
2. Check if the key has reached its usage limit
3. Ensure the server URL is correct (no trailing slash)
4. Verify system clock is accurate (TLS requires correct time)
5. Check server logs for detailed error messages

#### High CPU/Memory Usage

**Symptoms:** Agent consuming excessive resources

**Solutions:**
1. Reduce metrics collection frequency:
   ```yaml
   metrics_interval: 600  # 10 minutes instead of 5
   ```

2. Disable unnecessary collectors:
   ```yaml
   metrics_collectors:
     processes: false  # Disable if not needed
   ```

3. Set resource limits:
   ```yaml
   resources:
     max_cpu_percent: 5
     max_memory_mb: 128
   ```

#### Scripts Not Executing

**Symptoms:** Scripts timeout or fail to run

**Solutions:**
1. Verify script execution is enabled:
   ```yaml
   scripts:
     enabled: true
   ```

2. Check interpreter is in allowed list
3. Verify user permissions for script operations
4. Check script timeout settings
5. Review script output in agent logs

### Diagnostic Commands

**Collect diagnostic information:**
```bash
# Linux/macOS
sudo /usr/local/bin/breeze-agent diagnostics --output /tmp/breeze-diag.zip

# Windows (PowerShell as Admin)
& "C:\Program Files\Breeze\breeze-agent.exe" diagnostics --output "C:\Temp\breeze-diag.zip"
```

**Test server connectivity:**
```bash
sudo /usr/local/bin/breeze-agent test-connection
```

**View real-time debug logs:**
```bash
# Linux/macOS
sudo /usr/local/bin/breeze-agent run --config /etc/breeze/config.yaml --log-level debug

# Windows (stop service first)
& "C:\Program Files\Breeze\breeze-agent.exe" run --config "C:\ProgramData\Breeze\config.yaml" --log-level debug
```

### Log Locations

| Platform | Primary Log | Error Log |
|----------|-------------|-----------|
| Windows | `C:\ProgramData\Breeze\logs\agent.log` | `C:\ProgramData\Breeze\logs\agent.error.log` |
| macOS | `/var/log/breeze/agent.log` | `/var/log/breeze/agent.error.log` |
| Linux | `/var/log/breeze/agent.log` or `journalctl -u breeze-agent` | `/var/log/breeze/agent.error.log` |

### Getting Support

If you're unable to resolve an issue:

1. Collect diagnostics: `breeze-agent diagnostics --output diag.zip`
2. Note your agent version: `breeze-agent version`
3. Document the steps to reproduce the issue
4. Contact support with the diagnostic bundle

---

## Uninstallation

### Windows

**Using the agent uninstaller:**
```powershell
# Stop and remove the service
& "C:\Program Files\Breeze\breeze-agent.exe" stop
& "C:\Program Files\Breeze\breeze-agent.exe" uninstall

# Remove files
Remove-Item -Recurse -Force "C:\Program Files\Breeze"
Remove-Item -Recurse -Force "C:\ProgramData\Breeze"
```

**Complete cleanup (PowerShell as Admin):**
```powershell
# Stop service if running
Stop-Service -Name "BreezeAgent" -ErrorAction SilentlyContinue

# Remove service
sc.exe delete "BreezeAgent"

# Remove program files
Remove-Item -Recurse -Force "C:\Program Files\Breeze" -ErrorAction SilentlyContinue

# Remove configuration and logs
Remove-Item -Recurse -Force "C:\ProgramData\Breeze" -ErrorAction SilentlyContinue

# Remove from registry (if applicable)
Remove-Item -Path "HKLM:\SOFTWARE\Breeze" -Recurse -ErrorAction SilentlyContinue

Write-Host "Breeze Agent uninstalled successfully"
```

### macOS

```bash
# Stop and unload the service
sudo launchctl unload /Library/LaunchDaemons/com.breeze.agent.plist

# Remove LaunchDaemon
sudo rm /Library/LaunchDaemons/com.breeze.agent.plist

# Remove binary
sudo rm /usr/local/bin/breeze-agent

# Remove configuration
sudo rm -rf /etc/breeze

# Remove logs
sudo rm -rf /var/log/breeze

# Remove data
sudo rm -rf /var/lib/breeze

echo "Breeze Agent uninstalled successfully"
```

### Linux

```bash
# Stop and disable service
sudo systemctl stop breeze-agent
sudo systemctl disable breeze-agent

# Remove systemd unit
sudo rm /etc/systemd/system/breeze-agent.service
sudo systemctl daemon-reload

# Remove binary
sudo rm /usr/local/bin/breeze-agent

# Remove configuration
sudo rm -rf /etc/breeze

# Remove logs
sudo rm -rf /var/log/breeze

# Remove data
sudo rm -rf /var/lib/breeze

echo "Breeze Agent uninstalled successfully"
```

### Removing from Breeze Console

After uninstalling the agent from the device:

1. Log in to the Breeze web console
2. Navigate to **Devices**
3. Find the device (it will show as "Offline")
4. Click on the device to open details
5. Click **Actions** > **Delete Device**
6. Confirm deletion

---

## Security Considerations

### Principle of Least Privilege

The agent requires root/administrator privileges for full functionality, but you can restrict capabilities:

```yaml
# Disable features that aren't needed
remote_access:
  enabled: false

scripts:
  enabled: false
```

### Network Security

- All communication uses TLS 1.2+
- Certificate pinning available for high-security environments
- Supports mTLS for mutual authentication
- Works through HTTP proxies with authentication

### Audit Logging

All agent actions are logged and sent to the server:
- Script executions
- Remote access sessions
- Configuration changes
- User interactions

### Hardening Recommendations

1. **Use dedicated enrollment keys** per site or device group
2. **Set key expiration** to limit exposure
3. **Enable approval workflows** for remote access
4. **Restrict script interpreters** to only what's needed
5. **Monitor agent logs** for suspicious activity
6. **Keep agents updated** to receive security patches

---

## Appendix

### Version History

Check your agent version:
```bash
breeze-agent version
```

### Command Reference

```
breeze-agent - Breeze RMM Agent

Usage:
  breeze-agent [command]

Available Commands:
  run         Run the agent in foreground
  install     Install as system service
  uninstall   Remove system service
  start       Start the service
  stop        Stop the service
  restart     Restart the service
  status      Show agent status
  enroll      Enroll with Breeze server
  unenroll    Remove enrollment
  validate    Validate configuration
  diagnostics Collect diagnostic information
  test-connection  Test server connectivity
  version     Show version information
  help        Help about any command

Flags:
  -c, --config string   Configuration file path
  -h, --help            Help for breeze-agent
  -v, --verbose         Verbose output

Use "breeze-agent [command] --help" for more information about a command.
```

---

For additional documentation, visit: https://docs.breeze.io

For support, contact: support@breeze.io
