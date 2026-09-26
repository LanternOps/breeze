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

Further scopes are **write** scopes, for unattended provisioning and
migration integrations. Tenancy writes are create/update only — deleting an
organization, site, or key remains a human, MFA-gated action on the main API.
None of these write scopes is part of any default scope set, including the
Weavestream delegation. They must be granted explicitly, per principal:

| Write scope | Grants |
|---|---|
| `organizations:write` | Create organizations, subject to the partner's `maxOrganizations` quota |
| `sites:write` | Create sites within an accessible organization |
| `enrollment-keys:write` | Mint device-join enrollment credentials |
| `contracts:write` | Create a contract, update header fields, add/patch/remove lines, and GET one contract to confirm contents. Does not grant activate/pause/cancel, documents, or the human JWT `/api/v1/contracts` surface. Line removal is contents, not tenancy deletion. |
| `tickets:write` | Create, update, change status, assign and comment on tickets in any accessible organization (the `/api/v1/partner-api/tickets` surface). Does not grant delete, restore, move-org, bulk actions, attachments, time entries, AI drafts or the mailbox — those stay human, MFA-gated actions on the main API. The principal acts as **itself**: comments and audit rows name the principal, never a person. |

`tickets:read` is a further **opt-in read** scope, like `alerts:read`: ticket
subjects, descriptions and comments are customer-authored data across every
organization the principal can reach, so it is never part of any default scope
set either.

`enrollment-keys:write` is the most sensitive write scope, because the
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

The opt-in MCP scopes (`ai:read`, `ai:write`, `ai:execute`, `ai:execute_admin`)
grant nothing on `/api/v1/partner-api`. They only let the principal's key
authenticate the MCP endpoint (`/api/v1/mcp`) at partner scope, where every tool
call goes through the MCP guardrails: per-tool RBAC bounded by the principal
owner's live role, the Tier 3 approval gate (`MCP_UNATTENDED_TIER3_PRINCIPALS`
`partner_sp:<id>`), rate limits, the Tier 3 execution ledger and the audit log.
See the MCP server documentation.

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
| `GET /api/v1/partner-api/alerts` | `alerts:read` (opt-in) |
| `GET /api/v1/partner-api/tickets` | `tickets:read` (opt-in) |
| `GET /api/v1/partner-api/tickets/ids` | `tickets:read` (opt-in) |
| `GET /api/v1/partner-api/tickets/<ticket-uuid>` | `tickets:read` (opt-in) |
| `GET /api/v1/partner-api/tickets/<ticket-uuid>/comments` | `tickets:read` (opt-in) |
| `GET /api/v1/partner-api/device-status` | `device-status:read` (opt-in) |
| `POST /api/v1/partner-api/tickets` | `tickets:write` (opt-in) |
| `PATCH /api/v1/partner-api/tickets/<ticket-uuid>` | `tickets:write` (opt-in) |
| `POST /api/v1/partner-api/tickets/<ticket-uuid>/status` | `tickets:write` (opt-in) |
| `POST /api/v1/partner-api/tickets/<ticket-uuid>/assign` | `tickets:write` (opt-in) |
| `POST /api/v1/partner-api/tickets/<ticket-uuid>/comments` | `tickets:write` (opt-in) |
| `POST /api/v1/partner-api/organizations` | `organizations:write` |
| `POST /api/v1/partner-api/sites` | `sites:write` |
| `POST /api/v1/partner-api/enrollment-keys` | `enrollment-keys:write` |
| `POST /api/v1/partner-api/contracts` | `contracts:write` |
| `GET /api/v1/partner-api/contracts/<contract-uuid>` | `contracts:write` |
| `PATCH /api/v1/partner-api/contracts/<contract-uuid>` | `contracts:write` |
| `POST /api/v1/partner-api/contracts/<contract-uuid>/lines` | `contracts:write` |
| `PATCH /api/v1/partner-api/contracts/<contract-uuid>/lines/<line-uuid>` | `contracts:write` |
| `DELETE /api/v1/partner-api/contracts/<contract-uuid>/lines/<line-uuid>` | `contracts:write` |

Contract writes use the same field validation and draft/active line-edit rules
as the human editor. A `brz_sp_…` key still cannot call `/api/v1/contracts`
(401). Existing principals without `contracts:write` keep today's behavior.

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

Every resource except `/alerts` returns the same strict envelope (the alerts feed has its own checkpoint envelope, described under "Alerts feed" below):

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

## Alerts feed (`alerts:read`)

`GET /api/v1/partner-api/alerts` is a read-only, latest-state feed of alerts
across every organization the principal can reach. `alerts:read` is an opt-in
scope: it is never part of the default delegation and must be requested
explicitly. There is no acknowledge or resolve through this scope.

Query parameters (all optional): `orgId`, `status` and `severity` (comma
lists), `triggeredSince` (offset ISO timestamp), `limit` (1-500, default
100), and exactly one of `since` or `cursor`.

Sync contract:

1. First sync: call without `since`. Follow `nextCursor` (as `cursor`) while
   `hasMore` is true. The last page returns `checkpoint`.
2. Persist `checkpoint` only after the whole traversal has been processed,
   then pass it as `since` on the next poll to receive every alert inserted
   or changed after that traversal.
3. `409 partner_alerts_resync_required` means the checkpoint no longer
   describes this feed (the principal's organization set changed, or the
   database was restored or recovered). Start again without `since`.
   Restores are detected by the cluster identifier, timeline, database OID
   and alerts table OID, which covers a restore into a new cluster,
   point-in-time recovery, and a logical restore that recreates the database
   or the alerts table in the same cluster. Two cases are NOT detectable from
   inside the database: a filesystem or VM snapshot rollback of the same
   cluster, and a data-only reload into the existing alerts table with
   triggers disabled. After either, discard stored checkpoints and run a
   full sync.

Guarantees and limits:

- Change tracking uses the writing transaction id, bounded by the reading
  snapshot's xmin, so an alert whose transaction commits late is never
  skipped behind a checkpoint you already hold. A long-running transaction
  anywhere in the database delays the feed; it does not lose alerts.
- Latest state only: several transitions of one alert between polls arrive
  as its current row. Compare `changeVersion` for equality to detect change.
- Filters apply to the alert's current row. A feed filtered by
  `status=active` does not report an alert leaving that status; mirror
  consumers should not filter.
- Deleted alerts are not reported. Raw alert `context` is not exported, and
  `deviceHostname` is the device's current hostname, read at request time: a
  device rename does not advance the feed and does not change `revision`. `deviceId` and
  `deviceHostname` are null when the device no longer exists in the alert's
  organization. `deviceHostname` is also null when the hostname itself looks
  like a secret; the alert is still delivered.
- A record whose title or message contains a detected secret is withheld and
  listed in `blocked` instead. A blocked record reappears only when the alert
  itself is written again; reconcile blocked ids with a periodic full sync.
- Checkpoints and cursors are signed, bound to the partner, filters and
  organization set, and cursors expire after 24 hours.

## Tickets feed (`tickets:read`)

`GET /api/v1/partner-api/tickets` is a read-only, **coalesced latest-state**
feed of tickets across every organization the principal can reach, with the
same sync contract as the alerts feed above (`cursor` while `hasMore`, then
persist `checkpoint` and pass it as `since`; `409
partner_tickets_resync_required` means start again without `since`). Delivery
is at-least-once across resyncs: treat every item as an upsert keyed by `id`.
Three companion routes:

| Route | Returns |
|---|---|
| `GET /partner-api/tickets/ids` | `{ schemaVersion, data: [{ id, orgId, changeVersion }], nextCursor, hasMore }` — every **live** ticket in the accessible set, keyset-paged by `id`; `orgId` narrows it. A mirror diffs it on a schedule (daily is enough) and drops anything it holds that is absent — the only way to observe a ticket that moved to an organization outside the principal's set |
| `GET /partner-api/tickets/<ticket-uuid>` | `{ schemaVersion, data }` — one ticket record, or `404 partner_ticket_not_found` for a ticket that is soft-deleted, in another partner, or in an organization the principal cannot reach |
| `GET /partner-api/tickets/<ticket-uuid>/comments` | `{ schemaVersion, ticketId, data, nextCursor, hasMore }` — the ticket's comments and feed entries (status changes, assignments, system notes) in creation order, keyset-paged with a signed `cursor`. Includes the principal's **internal notes** (`isPublic: false`) alongside public replies. `since` (offset ISO timestamp) returns only comments **created** strictly after that instant, so it never surfaces an edit or a delete of an older comment |

`tickets:read` is an opt-in scope: ticket subjects, descriptions and
comments are customer-authored data, so it is never part of the default
delegation and must be requested explicitly. Nothing is written through it.

Feed query parameters (all optional): `orgId`, `status` and `priority`
(comma lists of the core values `new`, `open`, `pending`, `on_hold`,
`resolved`, `closed` / `low`, `normal`, `high`, `urgent`), `assigneeId`,
`externalId` (exact match on **this principal's** correlation key; keys are
namespaced by service principal, so another integration's ids never match),
`limit` (1-500, default 100), and exactly one of `since` or `cursor`.

Each feed item is one of two shapes:

- a **record**: ids for status (`statusId` is the partner's custom status
  row, `status` the core value), category, assignee, device and requester
  (`requester.contactId` / `requester.portalUserId`, plus the name/email
  snapshot taken at creation), `tags`, `externalTicketId` /
  `externalTicketUrl` (this principal's ref), SLA targets and stamps,
  `source`, `workKind`, `changeVersion` and `revision`. Free text
  (`description`, `resolutionNote`, `pendingReason`) is capped at 12,000
  characters with a trailing `…`. Raw `custom_fields`, `field_provenance`,
  attachments and time entries are not exported.
- a **tombstone** `{ id, orgId, removed: true, reason: "deleted", deletedAt,
  changeVersion }` for a ticket that was soft-deleted while still in an
  accessible organization. A restore delivers the record again with a higher
  `changeVersion`.

Removals, precisely:

| The ticket… | The consumer sees |
|---|---|
| is soft-deleted | a tombstone on the feed |
| is restored | the record again |
| moves into the org set, or between two orgs in the set | the record with its new `orgId` |
| moves **out** of the org set | nothing on the feed (its new organization is not readable, and a tombstone would disclose ids the consumer may never have seen); `GET /tickets/ids` no longer lists it |
| its organization leaves or joins the principal's set | `409 partner_tickets_resync_required` |

Guarantees and limits, in addition to the alerts feed's:

- Change tracking uses the writing transaction id bounded by the reading
  snapshot's xmin, so a ticket whose transaction commits late is never
  skipped behind a checkpoint you already hold. Every comment write — new,
  edited, deleted, from the portal, inbound email, AI, staff or this API —
  re-stamps the parent ticket, so comment-only activity re-delivers the
  ticket (with a new `changeVersion`); fetch its comments to see what
  changed. `updatedAt` is untouched by comments.
- Comments carry `originPrincipalKind` (`user`, `ai_agent`, `system`,
  `service_principal`) and `originPrincipalId`: compare the latter to your
  own principal id to skip exactly the comments your integration wrote, even
  when several integrations share one partner. An edited comment carries
  `editedAt` and a changed `revision`; a deleted one is returned in its
  creation-order slot as `{ id, ticketId, orgId, removed: true, deletedAt,
  createdAt }` with no content. Re-read the (bounded) list **without `since`**
  whenever the ticket is re-delivered and you converge exactly: `since` keys on
  creation time, so an edited or deleted older comment re-delivers the ticket but
  never appears in a `since` page.
- Filters apply to the ticket's current row, so a filtered feed does not
  report a ticket leaving the filter.
- A ticket (or comment) whose text contains a detected secret is withheld and
  listed in `blocked` (`GET /tickets/<id>` answers `422
  partner_export_record_blocked`). It reappears only when written again.
- Checkpoints, cursors and comment cursors are signed, bound to the partner
  (and to the filters, organization set, or ticket they were minted for),
  and expire after 24 hours.

## Device status feed (`device-status:read`)

`GET /api/v1/partner-api/device-status` returns live status, last-seen time
and agent version for every device in the organizations the principal can
reach. `device-status:read` is an opt-in scope: it is never part of the
default delegation and is not implied by `devices:read`. Ephemeral Quick
Support devices are excluded, as in `/devices`. Requests are audited like the
other partner-api exports.

Query parameters (all optional): `orgId`, `siteId`, `status` (comma list of
`online`, `offline`, `maintenance`, `decommissioned`, `quarantined`,
`updating`, `pending`), `limit` (1-500, default 100), and `cursor`. An
unknown `orgId` returns `404 partner_export_org_not_found`.

```json
{
  "schemaVersion": "1",
  "data": [
    {
      "deviceId": "<device-uuid>",
      "orgId": "<org-uuid>",
      "siteId": "<site-uuid>",
      "status": "online",
      "lastSeenAt": "2026-01-01T12:00:00.000Z",
      "agentVersion": "1.2.3"
    }
  ],
  "nextCursor": "<signed-cursor>",
  "hasMore": true
}
```

`lastSeenAt` is ISO-8601 or `null`. `blocked` is present only when a record
was withheld, as in the other feeds.

Paging:

- Rows are ordered by device id. Follow `nextCursor` (as `cursor`) while
  `hasMore` is true.
- A traversal covers devices created before it started. Each row is the
  device's state at the moment its page was read, so this is live state and
  not a snapshot: two pages of one traversal can reflect different moments.
- The cursor is signed, bound to the partner and to `orgId`, `siteId` and
  `status`, and expires 24 hours after the traversal started. Changing a
  filter mid-traversal returns `400 invalid_partner_export_cursor`.

Not part of the material-change snapshot or watermark:

- Heartbeats change these fields constantly, so the feed has no `revision`,
  `sourceUpdatedAt` or `snapshotAt`, no `updatedSince` or `since`, and no
  incremental sync. It takes no partner-export advisory locks.
- Poll the whole list at the cadence you need.
- `sourceUpdatedAt` on `/devices` tracks material changes only. It is not a
  last-seen signal.

## Ticket writes (`tickets:write`)

`tickets:write` lets a service principal open and work tickets in any
organization it can reach — the surface a PSA/ITSM mirror or an automation
platform needs. It is opt-in and never part of the default delegation.
Every write runs through the same ticket service the staff UI uses, so the
usual rules apply unchanged: the device, requester contact and portal user
must belong to the ticket's organization, the assignee and category to the
partner, Service Management must be on, and the status FSM is enforced.

| Route | Body | Notes |
|---|---|---|
| `POST /tickets` | `orgId`, `subject`, `description?`, `priority?`, `dueDate?`, `deviceId?`, `categoryId?`, `assigneeId?`, `requesterContactId?`, `submitterName?`, `submitterEmail?`, `externalTicketId?`, `externalTicketUrl?` | `source` is always `api`. `orgId` outside the principal's organizations → `403 partner_tickets_org_access_denied`. Supports `X-Idempotency-Key`. Returns `201` with the record. |
| `PATCH /tickets/<id>` | any of `subject`, `description`, `priority`, `dueDate`, `deviceId`, `categoryId`, `tags`, `requesterContactId`, `submitterName`, `submitterEmail`, `externalTicketId`, `externalTicketUrl` (`null` clears a nullable field) | Not `status` or `assigneeId` (use the dedicated routes), never SLA targets or the portal login. Unknown keys are a `400`. |
| `POST /tickets/<id>/status` | exactly one of `status` (core value) or `statusId` (a custom status of the partner); `resolutionNote` (required when resolving), `pendingReason?` | Same coherence rules as the staff route, without AI drafts. Invalid transitions → `400 INVALID_TRANSITION`. |
| `POST /tickets/<id>/assign` | `assigneeId` (a technician of the partner, or `null` to unassign) | Assigning a `new` ticket opens it. |
| `POST /tickets/<id>/comments` | `content`, `isPublic` (**required**, no default) | `isPublic: true` is a customer-visible reply and emails the requester; `false` is an internal note. Supports `X-Idempotency-Key`. Returns `201` with the comment. |

Every write answers with `{ schemaVersion, id, orgId, data }` (comments add
`ticketId`), where `data` is the same record shape the feed returns — or
`null` with a `blocked` entry when the secret scanner fires on the stored
text; the ids are always present. A ticket in another partner, outside the
principal's organizations, or soft-deleted is a `404 partner_ticket_not_found`
on every by-id route.

**Attribution.** A partner service principal has no human owner and acts as
itself, identified by the principal id (stable across key rotations):
comments and feed entries name the principal (`authorName`,
`originPrincipalKind: "service_principal"`, `originPrincipalId`), users-FK
columns stay empty, and audit rows carry `actor_type = api_key` with the
principal id in their details. Nothing is ever credited to the person who
minted the key. A comment posted this way never triggers an automatic
helpdesk-AI reply, and a field it sets is human-authoritative: the AI triage
never overwrites a category or priority the integration chose.

**External correlation.** `externalTicketId` / `externalTicketUrl` are
**this integration's** correlation key — namespaced by service principal, so
two integrations on one partner may hold the same id on different tickets,
and each only ever reads back its own. The id is unique per principal across
live *and* soft-deleted tickets. Creating (or re-pointing) a ticket to an id
this principal already holds is a `409 EXTERNAL_ID_CONFLICT`:
`details.existingTicketId` names the holder when it is in an organization
the principal can read (`null` otherwise) and `details.existingDeleted`
says whether it is soft-deleted, so the integration can re-link or ask for a
restore instead of duplicating. A conflicting create is rolled back whole. On
`PATCH`, `externalTicketId` re-points the ref (keeping its url unless
`externalTicketUrl` is sent too), `externalTicketId: null` clears it, and
`externalTicketUrl` alone updates the url of an existing ref (`400
partner_tickets_external_url_without_id` when there is none). Find a ticket
again with `GET /tickets?externalId=<id>`. The legacy
`externalTicketId` shown on the staff ticket detail is a different, older
column; this API never writes it.

**Idempotency.** Send `X-Idempotency-Key` (1-128 printable ASCII) on
`POST /tickets` and `POST /tickets/<id>/comments`. The key is scoped to the
service principal and the route, and bound to a fingerprint of the request
— the body **and**, for a comment, the ticket in the path — so reusing a
key with the same body against a different ticket is a reuse, not a replay:

| Status | `code` | Meaning |
|---|---|---|
| `200` + `idempotencyReplay: true` | — | The same request was already committed; this is its result (re-read as it is now) |
| `404` | `partner_ticket_not_found` | The ticket that request created has since been deleted or moved out of the principal's organizations |
| `400` | `partner_tickets_invalid_idempotency_key` | Header is empty, too long, or not printable ASCII |
| `409` | `partner_tickets_idempotency_key_reused` | Same key, different body or different ticket |
| `409` | `partner_tickets_idempotency_in_flight` | A concurrent request holds the claim; retry |

Authorization comes first: an unknown or foreign ticket is a `404` before
any idempotency state is read, so a key cannot probe for existence. The
claim, the resource and their link commit together, so a claim is never
visible without its result. Claims are kept for the retry window
(`PARTNER_API_IDEMPOTENCY_RETENTION_DAYS`, default 7 days) and then reaped
by a daily job (`PARTNER_API_IDEMPOTENCY_RETENTION_ENABLED`); after that a
retry with the old key is a fresh request. A claim follows its ticket: if
the ticket moves to another organization the claim moves with it, and if
that organization leaves the principal's accessible set the claim becomes
unreadable — a retry then answers `409 partner_tickets_idempotency_in_flight`
until it is reaped; use a new key.

**Not offered here.** Delete and restore, moving a ticket between
organizations, bulk actions, attachments, time entries and parts, AI drafts,
the mailbox, and editing or deleting comments stay human, MFA-gated actions
on the main API.

**Rate limits.** Ticket writes have their own hourly buckets, separate from
the 120/hour provisioning write budget, so a busy mirror can neither starve
nor be starved by tenancy provisioning. Two ceilings are charged, narrowest
first: per principal and key (`PARTNER_API_TICKET_WRITE_RATE_LIMIT_PER_HOUR`,
default 1200, always capped by the key's own limit), then partner-wide
(`PARTNER_API_TICKET_WRITE_PARTNER_RATE_LIMIT_PER_HOUR`, default 6000) — a
partner admin can mint service principals, so a per-principal limit alone
would be multiplied by however many they create. Both defaults are
provisional and will be tuned on real traffic.
