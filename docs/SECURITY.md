# Security

## SentinelOne EDR action governance

SentinelOne containment/remediation APIs are treated as high-risk operations.

### Controls

- Secrets are encrypted at rest before storage (`api_token_encrypted`).
- Mutating routes require specific scopes (`organization`, `partner`, or `system`):
  - Isolation/threat-action routes require `devices:execute` permission + MFA middleware.
  - Integration management routes require `organizations:write` permission + MFA middleware.
- AI tool tiers:
  - **Tier 1** (read-only): `get_s1_status`, `get_s1_threats` — no approval, no MFA.
  - **Tier 3** (high-risk): `s1_isolate_device`, `s1_threat_action` — approval-gated, MFA required.
  - Note: Sync is a REST-only operation (`POST /api/v1/s1/sync`), not exposed as an AI tool.
- Rate-limited: S1 AI tool invocations are limited to 5 per 10 minutes (does not apply to REST API endpoints).
- All action requests are persisted to `s1_actions` with provider action IDs for traceability.
- Action status is polled asynchronously and emitted into the event bus.
- Database tables use row-level security via `breeze_has_org_access(org_id)`.

### Events

- `s1.threat_detected` — emitted during threat sync for new active threats.
- `s1.device_isolated` — emitted only when an `isolate` action completes (not unisolate).
- `s1.threat_action_completed` — emitted for completed threat remediation actions (threat_kill, threat_quarantine, threat_rollback) and unisolate.

## Huntress Incident Correlation Workflow

### Data Protection
- Huntress API keys and webhook secrets are encrypted at rest.
- Integration-scoped data is protected with tenant RLS policies on:
  - `huntress_integrations`
  - `huntress_agents`
  - `huntress_incidents`

### Ingestion Paths
- Scheduled polling (every 15 minutes, see `DEFAULT_SYNC_INTERVAL_MINUTES` in `huntressSync.ts`) through the Huntress sync worker.
- Signed webhook ingestion through `POST /api/v1/huntress/webhook`.

### Webhook Authenticity Controls
- Webhooks require HMAC-SHA256 signature validation. If `webhookSecret` is not configured on the integration, webhook ingestion is rejected with a 403 error.
- When webhook signing is enabled, signed payloads must include a timestamp header and replay window enforcement is applied (default 10 minutes).
- When webhook signing is enabled, invalid or stale signatures are rejected before persistence.
- If account-level routing is ambiguous, webhook ingestion requires an explicit integration id.

### Event Lifecycle
The integration emits normalized events on the Breeze event bus:
- `huntress.incident_created`
- `huntress.incident_updated`
- `huntress.agent_offline`

### Correlation and Triage
1. Ingest Huntress agents and incidents.
2. Correlate Huntress entities to Breeze devices by hostname matching.
3. Normalize severity and status fields.
4. Persist incident state transitions.
5. Emit integration events for downstream automation and response.

### Operational Guardrails
- Integration management and manual sync endpoints require authenticated org write access and MFA.
- Webhook ingestion is unauthenticated by user session but cryptographically validated via HMAC-SHA256 signature.
- Integration health and incident read APIs remain org-scoped for partner/system contexts.
- The `apiBaseUrl` field is restricted to HTTPS URLs on `*.huntress.io` to prevent SSRF.
