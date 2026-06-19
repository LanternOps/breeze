---
name: agent-log-debugging
description: Use when debugging agent issues, investigating agent errors, checking agent connectivity, or reviewing agent diagnostic logs. Use when asked to check what an agent is doing or why it is failing.
---

# Agent Log Debugging

## Overview

Query agent diagnostic logs directly via Postgres in Docker. No API auth needed — just `docker exec` + `psql`.

## Quick Reference

### Direct SQL (fastest)

```bash
docker exec breeze-postgres-dev psql -U breeze -d breeze -c "SQL HERE"
```

Common queries:

```sql
-- Recent errors for a device
SELECT timestamp, level, component, message, fields
FROM agent_logs
WHERE device_id = 'DEVICE_UUID'
  AND level IN ('error', 'warn')
ORDER BY timestamp DESC LIMIT 50;

-- All logs for a device in last hour
SELECT timestamp, level, component, message
FROM agent_logs
WHERE device_id = 'DEVICE_UUID'
  AND timestamp > now() - interval '1 hour'
ORDER BY timestamp DESC;

-- Search by message text
SELECT timestamp, level, component, message, fields
FROM agent_logs
WHERE message ILIKE '%connection%'
ORDER BY timestamp DESC LIMIT 30;

-- Logs by component (updater, heartbeat, websocket, main, etc.)
SELECT timestamp, level, message, fields
FROM agent_logs
WHERE device_id = 'DEVICE_UUID'
  AND component = 'websocket'
ORDER BY timestamp DESC LIMIT 50;

-- Find device_id from agent_id
SELECT id, hostname, agent_id, status
FROM devices
WHERE agent_id = 'AGENT_ID_STRING';

-- Log volume by level (health check)
SELECT level, count(*) FROM agent_logs
WHERE timestamp > now() - interval '24 hours'
GROUP BY level ORDER BY count DESC;
```

### Enable Debug Log Shipping

Default shipping level is `warn`. To get all logs for debugging, send a command to the agent:

```json
{
  "type": "set_log_level",
  "payload": { "level": "debug", "durationMinutes": 60 }
}
```

Auto-reverts to `warn` after the duration. Send via device commands endpoint or WebSocket.

**Note:** Log shipping is NOT enabled by default. The `agent_logs` table will be empty until the agent's log shipper is configured and the API endpoint is reachable. If logs are empty, ask the user for logs from the agent's local log file instead.

### Dashboard API Endpoint

`GET /api/v1/devices/:deviceId/diagnostic-logs` (JWT or API key auth)

Query params: `?level=warn,error`, `?component=updater`, `?since=ISO`, `?until=ISO`, `?search=keyword`, `?page=1&limit=100`

### Agent Log File Locations

| Platform | Path |
|----------|------|
| Windows  | `C:\ProgramData\Breeze\logs\agent.log` |
| Windows (user helper) | `C:\ProgramData\Breeze\logs\user-helper.log` |
| macOS    | `/Library/Application Support/Breeze/logs/agent.log` |
| Linux    | `/var/log/breeze/agent.log` |

Configurable via `log_file` in `agent.yaml`. Rotated at 50MB, 3 backups.

### Log Shipping Pipeline

Agent slog handler &rarr; `Shipper.Enqueue()` &rarr; buffer (1000 entries) &rarr; batch every 60s &rarr; gzip POST to `POST /api/v1/agents/:agentId/logs` &rarr; `agent_logs` table

### Key Tables

- `agent_logs` — shipped diagnostic logs (level, component, message, fields, agent_version)
- `devices` — lookup device_id from agent_id
- `device_commands` — command history (check if set_log_level was sent)

### Common Debug Scenarios

| Symptom | Query |
|---------|-------|
| Agent not connecting | Filter component=`websocket`, level=`error` |
| Heartbeat failures | Filter component=`heartbeat`, level=`error` |
| Update failures | Filter component=`updater` |
| mTLS issues | Search message `mTLS` or `certificate` |
| Agent crash loop | Check log volume spike + last messages before gap |
| Remote desktop black screen | Filter component=`heartbeat` or `sessionbroker`, check for IPC/helper messages |
| Helper disconnect | Check `user-helper.log` on device for timeout/IPC errors |

## Dev Push (Build & Deploy)

### Zero-arg dev-push (recommended)

Defaults are read from `/.env.dev` (gitignored). Just run:

```bash
cd agent
make dev-push
```

### .env.dev format

```
BREEZE_API_KEY=brz_...
BREEZE_DEV_DEVICE=<device-uuid>
BREEZE_API_URL=http://<your-dev-host>:3001
```

### Override any default

```bash
make dev-push DEVICE=<other-device> AUTH_TOKEN=<other-key> API_URL=<other-url>
```

### Auth: JWT or API key

The Makefile auto-detects `brz_` prefix and sends via `X-API-Key` header. JWTs are sent via `Authorization: Bearer`. The dev-push API endpoint (`POST /api/v1/dev/push`) accepts both.

### Current dev environment

| Item | Value |
|------|-------|
| Device ID | `<device-uuid>` |
| Agent ID | `<agent-id>` |
| Hostname | `<your-dev-host>` |
| API URL | `http://<your-dev-host>:3001` |
| Platform | windows/amd64 |

### Dev Iteration Loop: Fetch Logs → Fix → Deploy → Check

When debugging agent issues, use this cycle with dev push to iterate fast:

```
1. FETCH LOGS — identify the problem
   docker exec breeze-postgres-dev psql -U breeze -d breeze -c "
     SELECT timestamp, level, component, message
     FROM agent_logs
     WHERE device_id = '<device-uuid>'
       AND level IN ('error','warn')
     ORDER BY timestamp DESC LIMIT 30;"

   If agent_logs is empty, ask user for local log file contents.

2. FIX CODE — edit Go source in agent/internal/...

3. BUILD & DEPLOY — push new binary (agent restarts in ~5s)
   cd agent
   make dev-push

4. CHECK LOGS — verify the fix landed
   docker exec breeze-postgres-dev psql -U breeze -d breeze -c "
     SELECT timestamp, level, component, message, fields
     FROM agent_logs
     WHERE device_id = '<device-uuid>'
       AND timestamp > now() - interval '2 minutes'
     ORDER BY timestamp DESC;"

   → Confirm new agent_version shows 'dev-<timestamp>'
   → Confirm error/warn messages are gone
   → If not fixed, loop back to step 1
```

**Tips:**
- Before starting, bump log level: send `set_log_level` command with `{level: "debug", durationMinutes: 30}` so you get full detail
- After dev-push, `auto_update` is disabled on the agent — re-enable in agent.yaml when done
- The dev push binary includes the version string `dev-<unix-timestamp>` — filter by `agent_version` in logs to confirm which build is running
- Dev push only works in non-production (`NODE_ENV !== 'production'` or `DEV_PUSH_ENABLED=true`)
