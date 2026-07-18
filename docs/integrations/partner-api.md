# Breeze Partner API v1

The partner API is a read-only, partner-wide export of durable reconstruction
facts for documentation and disaster recovery. It uses dedicated service
principals; human JWTs and ordinary organization API keys are not accepted at
`/api/v1/partner-api`.

## Provision a service principal

An authenticated partner or system operator with organization-write permission
and a current MFA step-up creates and manages principals in **Settings → Service
Principals**. A system operator must also select the partner. The equivalent
management request is:

```http
POST /api/v1/partner-service-principals
Authorization: Bearer <operator-access-token>
Content-Type: application/json

{
  "name": "documentation-export",
  "description": "Read-only reconstruction export",
  "scopes": [
    "organizations:read",
    "sites:read",
    "devices:read",
    "inventory:read",
    "configuration:read",
    "scripts:read",
    "backup-configuration:read",
    "custom-fields:read"
  ],
  "sourceCidrs": [],
  "expiresAt": null
}
```

Those eight scopes are the exact minimum set for a complete reconstruction
consumer. A narrower integration may omit scopes only for resources it will
never request. No partner API scope permits command execution, remote access,
secret reading, user management, or administrative writes.

| Endpoint | Required scope |
|---|---|
| `GET /api/v1/partner-api/organizations` | `organizations:read` |
| `GET /api/v1/partner-api/sites` | `sites:read` |
| `GET /api/v1/partner-api/devices` | `devices:read` |
| `GET /api/v1/partner-api/device-inventory` | `inventory:read` |
| `GET /api/v1/partner-api/device-software` | `inventory:read` |
| `GET /api/v1/partner-api/device-relationships` | `inventory:read` |
| `GET /api/v1/partner-api/configuration-policies` | `configuration:read` |
| `GET /api/v1/partner-api/configuration-assignments` | `configuration:read` |
| `GET /api/v1/partner-api/scripts` | `scripts:read` |
| `GET /api/v1/partner-api/automations` | `configuration:read` |
| `GET /api/v1/partner-api/backup-configurations` | `backup-configuration:read` |
| `GET /api/v1/partner-api/custom-fields` | `custom-fields:read` |
| `GET /api/v1/partner-api/custom-field-values` | `custom-fields:read` |

### Issue and capture the key once

After creating the principal, choose **Issue key**. The management API accepts
an optional expiry and a per-hour rate limit from 1 through 10,000; the default
is 600 requests per hour.

```http
POST /api/v1/partner-service-principals/<partner-service-principal-uuid>/keys
Authorization: Bearer <operator-access-token>
Content-Type: application/json

{
  "name": "documentation-export-primary",
  "expiresAt": null,
  "rateLimit": 600
}
```

The response contains the plaintext `brz_sp_...` key exactly once. Copy it
directly into the consumer's encrypted secret store, verify the stored value,
and close the dialog. Breeze stores only a SHA-256 digest and a non-secret
prefix, so the plaintext cannot be displayed or recovered later. Never put it
in source control, command history, logs, support tickets, or load-test result
files.

Export requests authenticate with the dedicated header:

```bash
curl --fail-with-body \
  -H 'Accept: application/json' \
  -H 'X-API-Key: <partner-service-principal-key>' \
  'https://breeze.example.com/api/v1/partner-api/organizations?limit=500'
```

### Trusted source CIDRs

`sourceCidrs` is optional. An empty array allows any source address that passes
the other authentication controls. When populated, every request must resolve
to one of the listed IP addresses or CIDRs through Breeze's canonical trusted
client-IP resolver. Breeze fails closed when a trusted client address cannot be
resolved. Do not enable an allowlist until the reverse proxy trust boundary is
configured and tested; untrusted forwarded headers never grant access.

## Key rotation and revocation

Use an overlap procedure for a no-downtime rotation:

1. Issue a second key on the same principal with the intended expiry and rate
   limit. Do not revoke the current key yet.
2. Capture the new plaintext once, update the consumer's encrypted secret, and
   deploy it.
3. Run a full authenticated page traversal with the new key and confirm the
   consumer checkpoint advances successfully.
4. Revoke the predecessor in **Settings → Service Principals**, or call
   `DELETE /api/v1/partner-service-principals/<principal-uuid>/keys/<old-key-uuid>`.
5. Confirm the old key returns `401` and retain only its non-secret audit ID.

The **Rotate** action (`POST .../keys/<key-uuid>/rotate`) is atomic and revokes
the predecessor immediately. Use it only when the consumer can perform a
coordinated immediate cutover; it does not provide an overlap window.

Disable the principal to stop all of its keys. Revoke one key to contain a
single credential without affecting another active key. Revocation is
idempotent and cannot be undone; issue a replacement instead.

## Pagination, checkpoints, and versioning

Every resource returns the same strict envelope:

```json
{
  "schemaVersion": "1",
  "snapshotAt": "2026-07-13T18:00:00.000Z",
  "data": [],
  "nextCursor": null,
  "hasMore": false
}
```

- Set `limit` from 1 through 500. Values above 500 are clamped to 500.
- Start a full traversal without `cursor` or `updatedSince`. Continue while
  `hasMore` is true, passing the opaque `nextCursor` unchanged.
- Keep the same filters and `updatedSince` on every page. Cursors bind the
  partner, resource, filters, mode, and `snapshotAt`; mismatch, tampering,
  expiry, or schema disagreement returns a structured `400` and never silently
  restarts. Cursors expire after 24 hours.
- Treat `snapshotAt` from the first page as the upper bound for the complete
  traversal. Every later page must return the same value.
- Advance the consumer checkpoint to `snapshotAt` only after every page of the
  resource succeeds. Use that checkpoint as `updatedSince` on the next
  incremental traversal.
- `orgId` filters every resource. `siteId` is available only for devices,
  device inventory, software, and relationships.

Run a full reconciliation periodically. Only a complete successful full crawl
may prove that a previously known source record disappeared. Authentication
failure, rate limiting, cancellation, blocked output, invalid version, or a
partial page walk must preserve last-known-good downstream data.

`schemaVersion: "1"` is the only current contract. Consumers must reject an
unknown version before applying records. New optional resources or a breaking
envelope/record change require an explicit consumer upgrade rather than
best-effort deserialization.

## Blocked records and completeness

Definitions containing secret-like material are omitted from `data` instead
of being partially redacted. A response can include bounded `blocked` entries
with only the resource, stable IDs, organization ID, `secret_detected` reason,
and safe field paths. A blocked entry is a documentation-completeness gap. It
is not evidence that the source was deleted, and it must never cause stale or
delete processing downstream.

> **Required downstream handoff:** `/custom-fields` contains definition
> records. `/custom-field-values` contains one scalar value record per
> `(deviceId, definitionId, orgId)`, with its own stable `id` and explicit
> `deviceId`, `definitionId`, and `target`. Consumers must cursor-walk every
> page, key values by the supplied stable `id`, and retain the explicit
> binding. Do not expect a nested values array on a device and do not impose a
> 500-definition inner cap.

## Rate limits, retries, and failures

Rate limits are per partner-service-principal key over a one-hour window. Successful
authentication returns `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset`. A `429` response includes `Retry-After`. Honor it with
bounded backoff and jitter; do not start a second overlapping traversal to work
around the limit.

| Status | Consumer action |
|---|---|
| `400` | Stop; correct invalid filters, cursor, timestamp, or schema handling. |
| `401` | Stop; verify key capture, expiry, revocation, principal/partner state, and CIDR trust. |
| `403` | Stop; add only the exact missing read scope. |
| `404` | Stop; the requested organization is not accessible to this partner. |
| `429` | Preserve the checkpoint and retry after `Retry-After`, with a bounded attempt count. |
| `5xx` | Preserve the checkpoint and retry with bounded exponential backoff; alert on exhaustion. |

A 503 or explicit database-pool saturation signal is an operational capacity
failure, not a missing-data result. Record it separately from other 5xx errors
and do not advance any resource checkpoint.

## Disaster recovery

Protect these items in the deployment's normal encrypted backup process:

- `PARTNER_API_CURSOR_SIGNING_KEY`, identical on every API replica and never
  reused as `JWT_SECRET`;
- the consumer's encrypted partner-service-principal plaintext key;
- consumer organization mappings, per-resource checkpoints, and last-known-good
  reconstructed records; and
- the Breeze database, including principal/key IDs and audit history.

After restoring Breeze, verify the same cursor-signing key is present before
starting API replicas. If it was lost, outstanding cursors cannot be validated;
discard those cursors and begin a new full traversal. Never interpret that
restart as source disappearance.

If the consumer credential was lost, Breeze cannot recover it because only its
digest is stored. Issue a new key, install and test it, then revoke the lost key.
If compromise is suspected, revoke the affected key first, issue a replacement,
review bounded partner-service-principal audit events, and complete a full crawl. After
any database point-in-time recovery, run a full reconciliation before resuming
incremental checkpoints and preserve downstream manual notes, uploads,
password references, relations, and history throughout recovery.

## Foundational device group membership

`GET /api/v1/partner-api/devices` includes a bounded, deterministic group-membership summary on each device:

```json
{
  "groupIds": ["00000000-0000-4000-8000-000000000001"],
  "groupMembership": {
    "total": 1,
    "included": 1,
    "complete": true,
    "reason": null
  }
}
```

- `groupIds` contains at most 500 group UUIDs in ascending UUID order.
- `total` is the complete membership count at export time; `included` is the number present in `groupIds`.
- `complete` is true exactly when `included === total`.
- When a device has more than 500 memberships, `complete` is false and `reason` is exactly `membership_limit_exceeded`. Consumers must treat the omitted memberships as an explicit completeness gap, not as absence or deletion.
- Group membership inserts, updates, and deletes advance the device export timestamp, so membership-only changes reappear in incremental device traversals.

The current v1 contract does not expose an unbounded device-group edge
collection. Consumers that receive `membership_limit_exceeded` must record a
completeness gap and must not interpret omitted group IDs as non-membership.

## Cursor filter binding

Every signed v1 cursor binds the traversal to its exact material filters. The signed payload contains a strict `filters` object:

```json
{
  "filters": {
    "orgId": null,
    "siteId": null
  }
}
```

`orgId` is bound for every foundational resource. `siteId` is additionally bound for devices and is always `null` for organizations and sites. Adding, removing, or changing either filter while reusing a cursor returns `400 invalid_partner_export_cursor`; the traversal never silently restarts.

## Foundational incremental consistency

Organizations, sites, devices, and device hardware maintain a dedicated millisecond-precision `partner_export_updated_at` watermark. The columns are database-owned and direct caller updates are ignored. Only durable fields projected by the partner DTO advance them; volatile heartbeat, online/offline, health, and last-seen changes do not. Device group membership changes advance the owning device watermark. Device hardware identity is folded into the effective device watermark, and deleting hardware advances the parent device so the null identity is emitted incrementally.

Foundational exports use transaction-scoped PostgreSQL advisory locks. The fixed hierarchy is:

1. Partner discovery/intent — namespace `1000202`, keyed by the partner UUID hash.
2. Organization material data — namespace `1000201`, keyed by the organization UUID hash.

Readers hold shared partner discovery and organization locks from active-organization discovery through the export query. Material writers hold shared partner intent plus exclusive organization locks; organization visibility changes hold the exclusive partner lock. UUID arrays are de-duplicated and sorted before acquisition. A transaction that attempts a new partner lock after taking an organization lock, or requests UUIDs below its prior maximum, fails deterministically instead of risking a cross-transaction deadlock. Breeze request mutations are normally single-organization; multi-organization statements are supported through the sorted array helpers, while multi-statement jobs must retain ascending partner-then-organization order.

Organization hard deletion participates in the same partner-exclusive discovery protocol. Repeated requests for an already-held organization lock are safe, which allows one transaction to update a device and its denormalized hardware row without relaxing the ascending-order rule for new locks.

The first-page `snapshotAt` is generated by PostgreSQL only after shared locks are held. It is aligned to the public millisecond timestamp contract. Therefore an open material writer either commits before that snapshot and is visible in the current traversal, or stamps after it and is visible in the immediately following traversal.
