# Breeze Helper — Startup Error Messaging

**Date:** 2026-04-04
**Status:** Approved

## Problem

When Breeze Helper is installed manually (not deployed by the agent via policy), users see a raw error like `Failed to read agent config at C:\ProgramData\Breeze\agent.yaml: No such file or directory`. This is unhelpful and confusing.

## Solution

Replace generic IO error strings with specific, user-friendly messages at each failure point in the startup config chain. Log technical details to `helper.log` for admin diagnostics.

## Error Message Matrix

| Failure | User-Facing Message | Log Entry |
|---------|---------------------|-----------|
| `agent.yaml` not found | Breeze Assist requires the Breeze agent. Ensure the Breeze agent is installed and running on this device. | `agent config not found at {path}: {err}` |
| `agent.yaml` parse error | Agent configuration is corrupt. Reinstall the Breeze agent or contact your administrator. | `failed to parse agent config at {path}: {err}` |
| `secrets.yaml` missing + no auth_token in agent.yaml | The Breeze agent is still setting up. Wait a moment and retry, or contact your administrator. | `secrets.yaml not found and no auth_token in agent.yaml` |
| `server_url` or `agent_id` missing | Agent configuration is incomplete. The agent may still be enrolling — wait and retry. | `missing required field '{field}' in agent config` |
| API unreachable | Cannot connect to the Breeze server. Check your network connection. | `HTTP request to {url} failed: {err}` |

## Files Changed

1. **`apps/helper/src-tauri/src/lib.rs`** — `load_agent_config_full()`: return friendly messages, log technical details via `log_helper_error()`
2. **`apps/helper/src/components/App.tsx`** — Error banner: show friendly message, add collapsible "Technical Details" for the raw error
3. **`apps/helper/src/stores/chatStore.ts`** — Pass through structured error if needed

## Scope

No architectural changes. Same config discovery paths, same startup flow. Only error message quality improves.
