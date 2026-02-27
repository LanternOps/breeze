# Integrations

## SentinelOne

SentinelOne is available through `/api/v1/s1/*` with an encrypted per-org connector.

### Authentication requirements

| Endpoint | Permission | MFA | Scopes |
|----------|-----------|-----|--------|
| POST /integration | organizations:write | Yes | organization, partner, system |
| POST /isolate | devices:execute | Yes | organization, partner, system |
| POST /threat-action | devices:execute | Yes | organization, partner, system |
| POST /sync | organizations:write | No | organization, partner, system |
| GET /integration | (read access) | No | organization, partner, system |
| GET /status | (read access) | No | organization, partner, system |
| GET /threats | (read access) | No | organization, partner, system |

### Connector setup

1. Call `POST /api/v1/s1/integration` with:
   - `name` (string, required)
   - `managementUrl` (string URL, required — e.g., `https://<tenant>.sentinelone.net`)
   - `apiToken` (string, required)
   - `orgId` (UUID, optional — required for partner/system scope callers)
   - `isActive` (boolean, optional — defaults to `true`)
2. Trigger a manual sync with `POST /api/v1/s1/sync` (optional, auto-sync runs in background).

### Endpoints

- `GET /api/v1/s1/integration` — get current integration config.
- `GET /api/v1/s1/status` — coverage and health summary.
- `GET /api/v1/s1/threats` — threat query/filtering with pagination.
- `POST /api/v1/s1/isolate` — device isolation or unisolation.
- `POST /api/v1/s1/threat-action` — threat kill/quarantine/rollback.
- `POST /api/v1/s1/sync` — trigger manual sync.

### Background jobs

- Agent sync: every 15 minutes.
- Threat sync: every 5 minutes.
- Action status poller: every 1 minute.
