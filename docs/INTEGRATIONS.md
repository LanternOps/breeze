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
| POST /sites/map | organizations:write | No | organization, partner, system |
| GET /integration | scope-gated only | No | organization, partner, system |
| GET /status | scope-gated only | No | organization, partner, system |
| GET /threats | scope-gated only | No | organization, partner, system |
| GET /sites | scope-gated only | No | organization, partner, system |

### Connector setup

1. Call `POST /api/v1/s1/integration` with:
   - `name` (string, required)
   - `managementUrl` (string URL, required — e.g., `https://<tenant>.sentinelone.net`)
   - `apiToken` (string, required for new integrations — omit on updates to keep existing token)
   - `orgId` (UUID, optional — required for partner/system scope callers)
   - `isActive` (boolean, optional — defaults to `true`)
2. Trigger a manual sync with `POST /api/v1/s1/sync` (optional, auto-sync runs in background).

### Endpoints

- `GET /api/v1/s1/integration` — get current integration config.
- `GET /api/v1/s1/status` — coverage and health summary.
- `GET /api/v1/s1/threats` — threat query/filtering with pagination.
- `GET /api/v1/s1/sites` — list S1 sites with agent counts and org mappings.
- `POST /api/v1/s1/integration` — create or update integration (apiToken optional on update).
- `POST /api/v1/s1/isolate` — device isolation or unisolation.
- `POST /api/v1/s1/threat-action` — threat kill/quarantine/rollback.
- `POST /api/v1/s1/sync` — trigger manual sync.
- `POST /api/v1/s1/sites/map` — map/unmap an S1 site to a Breeze organization.

### Background jobs

- Agent sync: every 15 minutes.
- Threat sync: every 5 minutes.
- Action status poller: every 1 minute.
