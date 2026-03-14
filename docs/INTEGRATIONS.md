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

## Huntress

### Overview
Breeze supports a per-organization Huntress connector that syncs endpoint agent and incident intelligence into unified incident workflows.

### API Endpoints
- `GET /api/v1/huntress/integration`
- `POST /api/v1/huntress/integration`
- `POST /api/v1/huntress/sync`
- `GET /api/v1/huntress/status`
- `GET /api/v1/huntress/incidents`
- `POST /api/v1/huntress/webhook`

### Setup
1. Create or update the integration via `POST /api/v1/huntress/integration` with:
   - `name`
   - `apiKey`
   - optional `accountId`
   - optional `apiBaseUrl` (must be HTTPS on `*.huntress.io`)
   - `webhookSecret` (required for webhook ingestion)
2. If webhook delivery is enabled in Huntress, configure the Breeze webhook endpoint:
   - `POST /api/v1/huntress/webhook`
   - include either integration id or account id in webhook routing metadata
   - if multiple active integrations use the same account id, include an explicit integration id
3. Trigger an initial sync with `POST /api/v1/huntress/sync`.

### Sync Model
- Scheduled sync runs every 15 minutes (see `DEFAULT_SYNC_INTERVAL_MINUTES` in `huntressSync.ts`).
- Manual sync can be queued via API.
- Incident deduplication is based on `(integration_id, huntress_incident_id)`.
- Agent deduplication is based on `(integration_id, huntress_agent_id)`.

### Correlation Behavior
- Huntress agents are mapped to Breeze devices by normalized hostname.
- Huntress incidents are mapped to devices via:
  1. The Huntress agent's pre-established device mapping (itself based on hostname).
  2. Direct hostname fallback when no agent link exists.

### Troubleshooting
- `lastSyncStatus = error`: inspect `lastSyncError` from the integration record.
- Missing incidents after sync:
  - verify integration is active,
  - verify API key and account scope,
  - run manual sync and inspect queue/job logs.
- Webhook rejected:
  - confirm `webhookSecret` is configured and matches the Huntress signature key,
  - confirm the webhook includes both signature and timestamp headers,
  - confirm request timestamp is within the replay window (default 10 minutes),
  - confirm integration/account routing metadata is present.
