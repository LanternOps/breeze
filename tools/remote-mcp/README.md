# Breeze Remote MCP Server

HTTP wrapper for [claude-code-mcp](https://github.com/steipete/claude-code-mcp) that enables remote Claude Code access over the network.

## Overview

This server runs on each test node (Windows, Linux, macOS) and exposes Claude Code capabilities via HTTP. The central coordinator connects to these servers to:

- Ask remote Claude instances to investigate issues
- Run commands on remote machines
- Check Breeze agent status and logs
- Perform cross-platform E2E testing

## Prerequisites

1. **Claude Code CLI** installed and configured on the node
2. **Node.js 20+** installed
3. **Tailscale** (recommended) or other network connectivity

## Installation

```bash
# Clone or copy to remote machine
cd tools/remote-mcp

# Install dependencies
npm install

# Build
npm run build
```

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
# Basic (no auth)
npm start

# With authentication
AUTH_TOKEN=your-secret-token npm start

# Custom port
PORT=3200 npm start

# Full config
NODE_NAME=windows-pc AUTH_TOKEN=secret PORT=3100 npm start
```

## API Endpoints

### `GET /health`

Health check endpoint.

```bash
curl http://localhost:3100/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2025-01-13T12:00:00.000Z",
  "node": "windows-pc"
}
```

### `POST /mcp`

MCP JSON-RPC endpoint. Forwards requests to claude-code-mcp.

```bash
curl -X POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "claude_code",
      "arguments": {
        "prompt": "Check if the Breeze agent is running and return its status"
      }
    }
  }'
```

## Running as a Service

### Linux (systemd)

Create `/etc/systemd/system/breeze-mcp.service`:

```ini
[Unit]
Description=Breeze Remote MCP Server
After=network.target

[Service]
Type=simple
User=breeze
WorkingDirectory=/opt/breeze/tools/remote-mcp
Environment=NODE_NAME=linux-node
Environment=AUTH_TOKEN=your-secret-token
Environment=PORT=3100
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable breeze-mcp
sudo systemctl start breeze-mcp
```

### macOS (launchd)

Create `~/Library/LaunchAgents/com.breeze.mcp.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.mcp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/opt/breeze/tools/remote-mcp/dist/server.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>NODE_NAME</key>
        <string>macos-node</string>
        <key>AUTH_TOKEN</key>
        <string>your-secret-token</string>
        <key>PORT</key>
        <string>3100</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.breeze.mcp.plist
```

### Windows (as a Service)

Use [node-windows](https://github.com/coreybutler/node-windows) or NSSM:

```powershell
# Using NSSM
nssm install BreezeMCP "C:\Program Files\nodejs\node.exe" "C:\breeze\tools\remote-mcp\dist\server.js"
nssm set BreezeMCP AppEnvironmentExtra NODE_NAME=windows-node AUTH_TOKEN=secret PORT=3100
nssm start BreezeMCP
```

## Connecting from Coordinator

On your development machine, configure Claude Code to use these remote nodes:

```json
// .claude/settings.json
{
  "mcpServers": {
    "windows-node": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://windows.tailnet:3100/mcp"]
    },
    "linux-node": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://linux.tailnet:3100/mcp"]
    },
    "macos-node": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://macos.tailnet:3100/mcp"]
    }
  }
}
```

## Security

1. **Always use AUTH_TOKEN** in production
2. **Use Tailscale** for network security (nodes only accessible via Tailscale IPs)
3. **Configure Tailscale ACLs** to restrict which machines can connect
4. **Rotate tokens** regularly

## Troubleshooting

### Claude Code not found

Ensure Claude Code CLI is installed and in PATH:

```bash
claude --version
```

### Permission denied

Claude Code needs `--dangerously-skip-permissions` acceptance:

```bash
claude --dangerously-skip-permissions
# Accept the terms
```

### Connection refused

Check if the server is running and the port is open:

```bash
curl http://localhost:3100/health
```
