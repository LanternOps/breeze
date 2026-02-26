# Security

## SentinelOne EDR action governance

SentinelOne containment/remediation APIs are treated as high-risk operations.

### Controls

- Secrets are encrypted at rest before storage (`api_token_encrypted`).
- Mutating routes (`/api/v1/s1/isolate`, `/api/v1/s1/threat-action`) require:
  - authenticated scope
  - execute permissions
  - MFA middleware
- AI tools that invoke SentinelOne actions are Tier 3 (approval-gated).
- All action requests are persisted to `s1_actions` with provider action IDs for traceability.
- Action status is polled asynchronously and emitted into the event bus.

### Events

- `s1.threat_detected`
- `s1.device_isolated`
- `s1.threat_action_completed`
