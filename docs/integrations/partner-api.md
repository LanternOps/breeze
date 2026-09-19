# Breeze Partner API v1

The partner API is a partner-wide API for durable reconstruction facts
(documentation and disaster recovery) and machine-to-machine device enrollment. It uses dedicated service
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

The eight read scopes are the minimum set for a complete reconstruction
consumer. A narrower integration may omit scopes only for resources it will
never request. A read-only principal may leave `sourceCidrs` empty and
`expiresAt` null, as above; a principal carrying `enrollment-keys:write` may
not — see the worked example below.

Three further scopes are **write** scopes, for unattended provisioning and
migration integrations. They are create/update only — deleting an organization,
site, or key remains a human, MFA-gated action on the main API — and none of
them is part of any default scope set, including the Weavestream delegation.
They must be granted explicitly, per principal:

| Write scope | Grants |
|---|---|
| `organizations:write` | Create organizations, subject to the partner's `maxOrganizations` quota |
| `sites:write` | Create sites within an accessible organization |
| `enrollment-keys:write` | Mint device-join enrollment credentials |

`enrollment-keys:write` is the most sensitive of the three, because the
credentials it mints let a machine join the tenant. A principal holding it must
additionally set a future expiry **and** at least one source IP/CIDR; Breeze
enforces that pair in the management API, in the web UI, and as a database
CHECK constraint. A request that grants the scope with `"sourceCidrs": []` or
`"expiresAt": null` is rejected — the constraint has no exception, so a minting
principal looks like this instead:

```http
POST /api/v1/partner-service-principals
Authorization: Bearer <operator-access-token>
Content-Type: application/json

{
  "name": "tenant-provisioning",
  "description": "Unattended device enrollment for onboarding",
  "scopes": [
    "organizations:read",
    "sites:read",
    "enrollment-keys:write"
  ],
  "sourceCidrs": ["203.0.113.0/24"],
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

Minting is rate limited and fails closed. Two buckets are charged, both hourly:
per service principal (`PARTNER_API_ENROLLMENT_KEY_WRITE_RATE_LIMIT`, default
10) and per partner (`PARTNER_API_ENROLLMENT_KEY_WRITE_PARTNER_RATE_LIMIT`,
default 100). The partner bucket exists because a partner admin can create
service principals, and a per-principal limit alone would be multiplied by
however many they create. Idempotent replays are answered from the durable
claim and are not charged against either bucket.

Operators can additionally cap how long a partner-minted key may live with
`PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES`. It applies to both `ttlMinutes`
and `expiresAt`, and it may only narrow the built-in 365-day ceiling, never
widen it. Unset means the 365-day ceiling applies — the value is not defaulted
to anything narrower, because that would retroactively cap partners already
minting through this endpoint.

No partner API scope permits command execution, remote access, secret reading,
or user management.

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
| `POST /api/v1/partner-api/organizations` | `organizations:write` |
| `POST /api/v1/partner-api/sites` | `sites:write` |
| `POST /api/v1/partner-api/enrollment-keys` | `enrollment-keys:write` |

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

### Mint an enrollment key

```http
POST /api/v1/partner-api/enrollment-keys
X-API-Key: brz_sp_<service-principal-key>
X-Idempotency-Key: <1-128 printable ASCII characters>
Content-Type: application/json

{
  "orgId": "<organization-uuid>",
  "siteId": "<optional-site-uuid>",
  "name": "Automated device enrollment",
  "maxUsage": 1,
  "ttlMinutes": 60
}
```

Pass either `ttlMinutes` or `expiresAt`, never both. `X-Idempotency-Key` is
optional; supplying it is strongly recommended for automated callers.

The `201` response returns the one-time key outside `data`, which is a strict
no-secret allowlist:

```json
{
  "schemaVersion": "1",
  "data": {
    "id": "<enrollment-key-uuid>",
    "orgId": "<organization-uuid>",
    "siteId": null,
    "name": "Automated device enrollment",
    "usageCount": 0,
    "maxUsage": 1,
    "expiresAt": "2026-08-09T13:00:00.000Z",
    "createdAt": "2026-08-09T12:00:00.000Z"
  },
  "key": "<64-char hex, returned once>",
  "enrollmentSecretSource": "global"
}
```

Store `key` securely and pass it to the agent enrollment flow. It is not
recoverable afterwards.

`enrollmentSecretSource` tells you which secret the agent must present when it
redeems this key — `"global"` for the deployment's `AGENT_ENROLLMENT_SECRET`,
`"per_key"` for the `enrollmentSecret` returned alongside it. It is present on
every response including replays, because the alternative failure is silent and
remote: assume the wrong model and you get a clean `201` here and a
`403 Enrollment secret required` at install time, with nothing connecting the
two.

#### Choosing an enrollment-secret model

An agent enrolling with a key must also present an enrollment secret. There are
two models, and the request chooses which one the key is minted under.

**Global secret (default).** Omit `issueEnrollmentSecret`, or send it as
`false`. `enrollment_keys.key_secret_hash` is left unset and the agent presents
the deployment's configured `AGENT_ENROLLMENT_SECRET`, exactly as it has since
this endpoint shipped in v0.105.1. Use this when your agents already carry the
global secret.

**Per-key secret (opt-in).** Send `issueEnrollmentSecret: true`. Breeze mints a
secret unique to that key, stores its hash, and returns it once:

```jsonc
// request
{ "orgId": "<organization-uuid>", "name": "Automated device enrollment", "issueEnrollmentSecret": true }

// 201 response, abbreviated
{
  "schemaVersion": "1",
  "data": { "id": "<enrollment-key-uuid>", "...": "..." },
  "key": "<64-char hex, returned once>",
  "enrollmentSecret": "<64-char hex, returned once>",
  "enrollmentSecretSource": "per_key"
}
```

The agent must then present **that** secret; the global
`AGENT_ENROLLMENT_SECRET` no longer satisfies this key. `enrollmentSecret` is
returned once and is unrecoverable, so a caller that loses it must mint a new
key. Prefer this model when the enrolling machine should not hold a
deployment-wide credential.

The field is **absent**, not null, when no secret was issued — presence is the
signal that the key requires one.

Idempotency uses a durable database claim keyed by service principal and
`X-Idempotency-Key`. The claim, enrollment-key insert, and result link commit
in one transaction, so concurrent duplicate requests cannot mint two keys. A
completed replay returns `200` with metadata, `idempotencyReplay: true` and the
same `enrollmentSecretSource` as the original create, and never returns either
one-time credential. Replays are answered before the mint
rate limiter is charged, so retrying with the same key cannot exhaust your own
mint budget.

| Status | `code` | Cause |
|---|---|---|
| `400` | `partner_provisioning_invalid_idempotency_key` | `X-Idempotency-Key` is empty, over 128 chars, or non-printable-ASCII |
| `400` | `partner_provisioning_ttl_exceeds_cap` | Requested TTL exceeds the organization's enrollment-key cap or `PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES` |
| `400` | `partner_provisioning_site_mismatch` | `siteId` does not belong to `orgId` |
| `403` | `partner_provisioning_principal_restrictions_required` | Principal lacks an expiry or a source CIDR allowlist |
| `403` | `partner_provisioning_org_access_denied` | `orgId` is outside the principal's accessible organizations |
| `409` | `partner_provisioning_idempotency_key_reused` | Same `X-Idempotency-Key`, different request body |
| `409` | `partner_provisioning_idempotency_in_flight` | A concurrent request holds the claim; retry |
| `429` | `partner_provisioning_rate_limited` | Mint bucket exhausted; honor `Retry-After` |
| `503` | `partner_provisioning_idempotency_state_invalid` | Claim exists but its key row is unreadable |
