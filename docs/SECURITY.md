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
  - **Tier 2** (operational): `s1_sync` — approval-gated, no MFA.
  - **Tier 3** (high-risk): `s1_isolate_device`, `s1_threat_action` — approval-gated, MFA required.
- Rate-limited: S1 action tools are limited to 5 invocations per 10 minutes.
- All action requests are persisted to `s1_actions` with provider action IDs for traceability.
- Action status is polled asynchronously and emitted into the event bus.
- Database tables use row-level security via `breeze_has_org_access(org_id)`.

### Events

- `s1.threat_detected` — emitted during threat sync for new active threats.
- `s1.device_isolated` — emitted only when an `isolate` action completes (not unisolate).
- `s1.threat_action_completed` — emitted for all other completed actions (unisolate, threat_kill, threat_quarantine, threat_rollback).
