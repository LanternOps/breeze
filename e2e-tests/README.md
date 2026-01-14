# Breeze E2E Tests

End-to-end testing framework for Breeze RMM using Claude Code as the coordinator.

## Overview

This testing framework enables:
- **UI Testing**: Automated browser testing of Breeze web UI via Playwright MCP
- **Cross-Platform Testing**: Verification on Windows, Linux, and macOS nodes
- **AI-Assisted Debugging**: Claude Code investigates issues on remote machines
- **Conversational Testing**: Run tests by talking to Claude Code

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Machine (Coordinator)                                     │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Claude Code                                                │ │
│  │    ├─ playwright-mcp → Chrome → Breeze UI                  │ │
│  │    ├─ windows-node   → Remote Windows PC                   │ │
│  │    ├─ linux-node     → Remote Linux VM                     │ │
│  │    └─ macos-node     → Remote Mac                          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  e2e-tests/                                                     │
│    ├─ config.yaml        # Environment configuration           │
│    ├─ run.ts             # Test runner CLI                      │
│    └─ tests/                                                    │
│        ├─ agent_install.yaml                                    │
│        ├─ script_execution.yaml                                 │
│        ├─ alert_lifecycle.yaml                                  │
│        └─ remote_session.yaml                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

1. **Claude Code** installed and configured
2. **Playwright MCP** plugin enabled
3. **Remote MCP servers** running on test nodes (see `../tools/remote-mcp/`)
4. **Tailscale** (or other network connectivity) between machines

## Setup

### 1. Configure Remote Nodes

Copy the example settings and configure your node addresses:

```bash
cp ../.claude/settings.example.json ../.claude/settings.json
```

Edit `.claude/settings.json` with your Tailscale hostnames or IPs.

### 2. Set Environment Variables

```bash
export TEST_USER_EMAIL="admin@example.com"
export TEST_USER_PASSWORD="your-password"
export WINDOWS_NODE_TOKEN="your-windows-token"
export LINUX_NODE_TOKEN="your-linux-token"
export MACOS_NODE_TOKEN="your-macos-token"
```

### 3. Install Dependencies

```bash
cd e2e-tests
npm install
```

## Usage

### CLI Runner

```bash
# Run all tests
npm test

# Dry run (preview without executing)
npm run test:dry

# Run critical tests only
npm run test:critical

# Run tests for specific platform
npm run test:linux
npm run test:windows
npm run test:macos

# Run specific test
npx tsx run.ts --test agent_install_linux

# Run tests with specific tags
npx tsx run.ts --tags critical,agent
```

### Conversational Mode

You can also run tests by talking to Claude Code:

```
You: Run the Linux agent installation test

Claude: I'll run the agent_install_linux test for you.
[Executes test steps, shows progress]
...
Test passed! The agent was successfully installed and enrolled.

You: The script execution test failed - can you investigate?

Claude: I'll investigate the failure on the Linux node.
[Connects to remote Claude, checks logs]
...
Found the issue: The script failed because the user doesn't have
execute permissions on /opt/breeze/scripts. Here's the fix...
```

## Test Structure

Tests are defined in YAML files with the following structure:

```yaml
tests:
  - id: unique_test_id
    name: "Human-readable test name"
    description: "What this test does"
    tags: [tag1, tag2]
    nodes: [linux, windows]
    timeout: 120000
    steps:
      # UI step - uses Playwright MCP
      - id: step_1
        action: ui
        description: "Login to dashboard"
        playwright:
          - goto: "/login"
          - fill:
              "[name='email']": "${TEST_USER_EMAIL}"
          - click: "button[type='submit']"

      # Remote step - uses remote MCP node
      - id: step_2
        action: remote
        node: linux
        tool: claude_code
        args:
          prompt: "Check agent status and return JSON"
        expect:
          status: "running"
```

## Available Tests

| Test ID | Description | Nodes |
|---------|-------------|-------|
| `agent_install_windows` | Windows agent installation | windows |
| `agent_install_linux` | Linux agent installation | linux |
| `agent_install_macos` | macOS agent installation | macos |
| `script_execution_single` | Single device script run | linux |
| `script_execution_cross_platform` | Cross-platform scripts | all |
| `alert_cpu_threshold` | CPU alert lifecycle | linux |
| `alert_agent_offline` | Agent offline detection | linux |
| `remote_terminal_session` | Terminal session test | linux |
| `remote_file_transfer` | File upload/download | linux |

## Writing New Tests

1. Create a new YAML file in `tests/` or add to an existing file
2. Define the test with unique ID and steps
3. Use `action: ui` for browser interactions
4. Use `action: remote` for remote machine operations
5. Add `expect` blocks for assertions
6. Use `optional: true` for cleanup steps

### Step Types

**UI Steps** (`action: ui`):
```yaml
- id: login
  action: ui
  playwright:
    - goto: "/login"
    - fill:
        "[name='email']": "user@example.com"
    - click: "button[type='submit']"
    - waitFor: "[data-testid='dashboard']"
    - assert:
        selector: "h1"
        text: "Welcome"
```

**Remote Steps** (`action: remote`):
```yaml
- id: check_service
  action: remote
  node: linux
  tool: claude_code
  args:
    prompt: |
      Check if the service is running:
      1. Run: systemctl status myservice
      2. Return JSON: {running: boolean, status: string}
  expect:
    running: true
```

## Debugging

### Verbose Mode

```bash
npx tsx run.ts --verbose
```

### Investigate Failures

When a test fails, ask Claude to investigate:

```
You: The agent_install_linux test failed at step verify_agent_running.
     Can you check what's happening on the Linux node?

Claude: [Connects to Linux node, investigates logs and service status]
```

### View Remote Logs

```
You: Show me the Breeze agent logs from the Linux node

Claude: [Reads /var/log/breeze/agent.log from remote node]
```

## Troubleshooting

### "Node not reachable"

1. Check Tailscale connection: `tailscale status`
2. Verify remote MCP server is running on the node
3. Check firewall allows port 3100

### "Playwright action failed"

1. Run with `--verbose` to see full action details
2. Check if Breeze UI is running at configured `baseUrl`
3. Verify selectors match current UI

### "Claude Code timeout"

1. Increase timeout in step definition
2. Check if Claude Code CLI is working on remote node
3. Verify `--dangerously-skip-permissions` was accepted
