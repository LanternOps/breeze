# Integrations

## SentinelOne

SentinelOne is available through `/api/v1/s1/*` with an encrypted per-org connector.

### Connector setup

1. Call `POST /api/v1/s1/integration` with:
   - `name`
   - `managementUrl` (for example, `https://<tenant>.sentinelone.net`)
   - `apiToken`
2. Trigger a manual sync with `POST /api/v1/s1/sync` (optional, auto-sync runs in background).

### Endpoints

- `GET /api/v1/s1/status` for coverage and health.
- `GET /api/v1/s1/threats` for threat query/filtering.
- `POST /api/v1/s1/isolate` for device isolation or unisolation.
- `POST /api/v1/s1/threat-action` for threat kill/quarantine/rollback.
- `POST /api/v1/s1/sync` for manual sync.

### Background jobs

- Agent sync: every 15 minutes.
- Threat sync: every 5 minutes.
- Action status poller: every 1 minute.
