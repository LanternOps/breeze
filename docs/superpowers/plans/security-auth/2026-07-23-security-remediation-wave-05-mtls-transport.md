# Security Remediation Wave 05: mTLS Identity and Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an agent certificate a durable, tenant-isolated device identity; renew it without a bearer-only minting path; bind both REST and command WebSocket authentication to that identity; and trust HTTPS/proxy metadata only through configured authorities.

**Architecture:** Add an expand-only, forced-RLS certificate-history table while retaining the legacy certificate columns on `devices` for mixed-version readers. Capable agents use issue/save/confirm/activate/revoke; legacy agents keep their response shape but gain durable history and retry. A single API binding service consumes a protected assertion produced by a trusted edge and is called by both agent-auth implementations. HTTPS redirects derive their origin only from `PUBLIC_API_URL`, while forwarded scheme and certificate assertions are accepted only from `TRUSTED_PROXY_CIDRS`.

**Tech Stack:** Hono, TypeScript, Drizzle ORM, PostgreSQL forced RLS, BullMQ/Redis, Vitest, Go, Cloudflare mTLS, Caddy.

**Implementation Branch:** `fix/security-review-mtls-transport`

## Global Constraints

- Implement after Wave 01 CI trust and Wave 04 WebSocket lifecycle are merged and green. Waves 02
  and 03 may proceed concurrently because this plan has no code dependency on them, but do not
  merge the reserved `-d-` migration until their reserved `-a-`, `-b-`, and `-c-` migrations are
  present on `origin/main`.
- Do not edit shipped migration `apps/api/migrations/0013-mtls-cert-management.sql`. The current highest migration is `2026-08-04-widen-device-mac-address-columns.sql`; the centrally reserved Wave 05 slot is `2026-08-06-d-device-mtls-certificate-history.sql`.
- This is an expand-only mixed-version change. Keep `devices.mtls_cert_*` readable and updated until a separately approved contract migration.
- Every request-path database operation uses `withDbAccessContext`; workers use `runOutsideDbContext` followed by `withSystemDbAccessContext`.
- The new table has direct `org_id`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and per-operation `breeze_has_org_access(org_id)` policies in its creation migration.
- Never log PEM, private keys, proof signatures, challenges, certificate serials, fingerprints, bearer tokens, or protected assertion values. Metrics may contain only mode, bounded reason, route template, and deployment class.
- `AGENT_MTLS_BINDING_MODE` defaults to `off` everywhere. Hosted rollout advances `off -> audit -> enforce`; self-hosted remains `off` until an operator explicitly configures a certificate-validating proxy and opts in.
- Reuse `TRUST_PROXY_HEADERS` and `TRUSTED_PROXY_CIDRS`; do not add another proxy CIDR parser or a second fatal-startup authority.
- Treat Cloudflare provider “not found” as completed revocation. Any other provider or queue failure preserves durable retry state.
- Run Go tests with `-race`. Run database gates against a real PostgreSQL role `breeze_app`.
- Apply at most one independent review round. If review changes auth, RLS, migration, worker concurrency, or agent persistence, rerun the complete Wave 05 gate.

## Finding Coverage

| Finding | Owning tasks | Red-green regression | Enforcement acceptance |
|---|---|---|---|
| `P1-MTLS-001` | Tasks 6, 7, and 9 | Start with failing missing/mismatched identity, exact-route, command-WS coverage, broad-exemption, protected-header overwrite, and self-host default tests; make them green with shared binding, exact edge expressions, and opt-in mode wiring. | Hosted enforcement blocks every covered missing or mismatched identity without spoofable headers; self-host remains behaviorally unchanged in `off`. |
| `P1-MTLS-002` | Tasks 4 and 6 | Start with failing bearer-only renewal, expired-proof replay, REST mismatch, WebSocket mismatch, and untrusted-header spoof tests; make them green through proof-of-possession and the shared binding service. | Valid stored identity must match for renewal/auth; expired recovery requires old-key proof or administrator re-enrollment; REST and command WS return the same binding decision. |
| `P1-MTLS-004` | Tasks 1-5 | Start with failing history, two-phase persistence, provider-failure, duplicate-worker, and crash/resume tests; make them green with forced-RLS history and activate-then-revoke lifecycle. | Old identity remains usable until confirmation, failures remain durably due, provider 404 completes, and the due-retry query drains within two sweep intervals after recovery. |
| `TRANSPORT-001` | Task 8 | Start with failing trusted/untrusted forwarded-proto, attacker Host, canonical redirect, direct-origin, Caddy, and Cloudflare cases; make them green with `requestTransport`. | Forwarding is trusted only from configured proxy CIDRs, unknown Host returns 400, and every redirect is rooted at HTTPS `PUBLIC_API_URL`. |

Before implementation, run this migration reservation gate from the Wave 05 worktree:

```bash
git fetch --prune origin
test "$(git merge-base HEAD origin/main)" = "$(git rev-parse origin/main)"
predecessor=2026-08-06-c-quote-response-capability.sql
reserved=2026-08-06-d-device-mtls-certificate-history.sql
test -e "apps/api/migrations/$predecessor"
test ! -e "apps/api/migrations/$reserved"
current_highest="$(find apps/api/migrations -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | LC_ALL=C sort | tail -1)"
test "$current_highest" = "$predecessor"
[[ "$predecessor" < "$reserved" ]]
```

Expected: exit 0 only after rebasing onto current `origin/main` with Wave 03's `-c-` migration as
the exact predecessor. If that predecessor is absent, another migration is newer, the reserved
filename is occupied, or ordering no longer holds, stop and revise the central program plus every
affected wave plan before writing schema or SQL.

---

### Task 1: Add the durable certificate-history model and forced-RLS migration

**Files:**

- Create: `apps/api/src/db/schema/deviceMtlsCertificates.ts`
- Modify: `apps/api/src/db/schema/index.ts`
- Create: `apps/api/migrations/2026-08-06-d-device-mtls-certificate-history.sql`
- Modify: `apps/api/src/db/autoMigrate.test.ts`
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/device-mtls-certificates-rls.integration.test.ts`

Define and export this model:

```ts
export type DeviceMtlsCertificateState =
  | 'pending_activation'
  | 'active'
  | 'pending_revocation'
  | 'revoked';

export const deviceMtlsCertificates = pgTable('device_mtls_certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull(),
  providerCertificateId: varchar('provider_certificate_id', { length: 128 }).notNull(),
  serialNumber: varchar('serial_number', { length: 128 }).notNull(),
  fingerprintSha256: char('fingerprint_sha256', { length: 64 }),
  publicKeySpki: text('public_key_spki'),
  legacyProvenance: boolean('legacy_provenance').notNull().default(false),
  state: varchar('state', { length: 32 }).$type<DeviceMtlsCertificateState>().notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  activationExpiresAt: timestamp('activation_expires_at', { withTimezone: true }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeAttempts: integer('revoke_attempts').notNull().default(0),
  lastRevokeError: varchar('last_revoke_error', { length: 255 }),
  nextRevokeAttemptAt: timestamp('next_revoke_attempt_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    columns: [table.deviceId, table.orgId],
    foreignColumns: [devices.id, devices.orgId],
    name: 'device_mtls_certificates_device_org_fkey',
  }).onDelete('cascade'),
  uniqueIndex('device_mtls_certificates_provider_uq').on(table.providerCertificateId),
  uniqueIndex('device_mtls_certificates_org_serial_uq').on(table.orgId, table.serialNumber),
  uniqueIndex('device_mtls_certificates_one_active_uq')
    .on(table.deviceId)
    .where(sql`${table.state} = 'active'`),
  index('device_mtls_certificates_org_device_state_idx')
    .on(table.orgId, table.deviceId, table.state),
  index('device_mtls_certificates_retry_idx')
    .on(table.state, table.nextRevokeAttemptAt),
  check('device_mtls_certificates_state_chk',
    sql`${table.state} IN ('pending_activation','active','pending_revocation','revoked')`),
  check('device_mtls_certificates_pending_expiry_chk',
    sql`${table.state} <> 'pending_activation' OR ${table.activationExpiresAt} IS NOT NULL`),
  check('device_mtls_certificates_active_time_chk',
    sql`${table.state} <> 'active' OR ${table.activatedAt} IS NOT NULL`),
  check('device_mtls_certificates_revoked_time_chk',
    sql`${table.state} <> 'revoked' OR ${table.revokedAt} IS NOT NULL`),
  check('device_mtls_certificates_fingerprint_chk',
    sql`${table.legacyProvenance} OR ${table.fingerprintSha256} IS NOT NULL`),
]);
```

The table constraints are:

- composite foreign key `(device_id, org_id) -> devices(id, org_id)` with cascade delete;
- `CHECK` restricting `state` to the four literals;
- unique `provider_certificate_id`;
- unique `(org_id, serial_number)`;
- partial unique index allowing one `active` row per device;
- indexes on `(org_id, device_id, state)` and `(state, next_revoke_attempt_at)`;
- pending-activation rows require `activation_expires_at`; active rows require `activated_at`; revoked rows require `revoked_at`.

The migration imports a legacy `devices` certificate only when provider ID, serial, issued time, and expiry time are all non-NULL. Imported rows are `active`, have `fingerprint_sha256 = NULL`, and set `legacy_provenance = true`; do not invent a fingerprint from the serial. New rows set `legacy_provenance = false` and must have a fingerprint through the check constraint. `public_key_spki` is also NULL for imported rows, which deliberately prevents proof-of-possession recovery for those rows. Wrap the import in a `DO` block, use `GET DIAGNOSTICS imported = ROW_COUNT`, and execute `RAISE WARNING 'imported % legacy device mTLS certificate rows', imported` so the forensic row count reaches PostgreSQL logs.

- [ ] Add a failing schema assertion to `autoMigrate.test.ts` for the composite FK, state checks, indexes, RLS enable/force, all four policies, and `breeze_app` grants. Run `pnpm --filter @breeze/api test:run -- src/db/autoMigrate.test.ts`; expect the migration assertions to fail because the file/table do not exist.
- [ ] Add a failing integration test that creates two organizations and devices under `breeze_app`, permits same-org insert/select/update/delete, and rejects cross-org select plus a forged `(device_id, org_id)` insert. Run `pnpm --filter @breeze/api test:rls -- src/__tests__/integration/device-mtls-certificates-rls.integration.test.ts`; expect the new table to be absent.
- [ ] Create the Drizzle model, barrel export, and idempotent migration. Use `CREATE TABLE IF NOT EXISTS`, conditional constraints/indexes/policies, `ENABLE` plus `FORCE ROW LEVEL SECURITY`, four operation-specific policies using `breeze_has_org_access(org_id)`, and grants for `breeze_app`.
- [ ] Add an explicit assertion to `rls-coverage.integration.test.ts` that `device_mtls_certificates` is discovered as a direct-org table; do not add it to a non-direct allowlist.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/db/autoMigrate.test.ts` and the RLS test command above; expect both to pass.
- [ ] Start the test database and run `pnpm --filter @breeze/api check:migrations`, `pnpm --filter @breeze/api check:migrations:nonsuperuser`, `pnpm --filter @breeze/api db:check-drift`, and `pnpm --filter @breeze/api test:rls-coverage`; expect zero ordering, privilege, drift, or coverage failures.
- [ ] Reapply the migration to a database that already contains the table and imported rows; expect no duplicate rows, no duplicate policies, and no errors.
- [ ] Commit this task as `feat(security): add RLS device certificate history`.

### Task 2: Include certificate history in tenant lifecycle controls

**Files:**

- Modify: `apps/api/src/services/tenantCascade.ts`
- Modify: `apps/api/src/services/tenantCascade.test.ts`
- Modify: `apps/api/src/services/tenantExport.ts`
- Modify: `apps/api/src/services/tenantExport.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`

`device_mtls_certificates` is an organization-owned table. Add it to `CORE_ORG_CASCADE_DELETE_ORDER` before `devices`, because its composite FK references the device. Export only non-secret lifecycle metadata:

```ts
const DEVICE_MTLS_CERTIFICATE_EXPORT_COLUMNS = [
  'id', 'org_id', 'device_id', 'state', 'issued_at', 'expires_at',
  'activated_at', 'revoked_at', 'revoke_attempts', 'created_at', 'updated_at',
] as const;
```

Provider IDs, serials, fingerprints, public keys, sanitized provider errors, and next-attempt details stay out of tenant archives. If Wave 07's deny-default export registry has already merged, register the same explicit include/exclude decisions there instead of adding a second local registry.

- [ ] Add failing cascade and export tests proving the new table is discovered, deleted before `devices`, exported with the exact safe keyset, and excluded fields never appear by key or value. Run `pnpm --filter @breeze/api test:run -- src/services/tenantCascade.test.ts src/services/tenantExport.test.ts`; expect discovery/keyset failures.
- [ ] Update the cascade order and export projection. Do not use `SELECT *`.
- [ ] Add round-trip integration fixtures with an unmistakable provider ID, serial, fingerprint, SPKI, and error sentinel; prove erasure removes the row and the archive contains none of those sentinels.
- [ ] Run the focused unit command, then `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`; expect all fixtures to pass.
- [ ] Commit this task as `feat(security): govern certificate history lifecycle`.

### Task 3: Make provider revocation typed, durable, and idempotent

**Files:**

- Modify: `apps/api/src/services/cloudflareMtls.ts`
- Create: `apps/api/src/services/cloudflareMtls.test.ts`
- Create: `apps/api/src/services/deviceMtlsCertificateLifecycle.ts`
- Create: `apps/api/src/services/deviceMtlsCertificateLifecycle.test.ts`
- Create: `apps/api/src/jobs/mtlsCertificateRevocation.ts`
- Create: `apps/api/src/jobs/mtlsCertificateRevocation.test.ts`
- Modify: `apps/api/src/index.ts`

Expose typed provider outcomes rather than parsing exception text:

```ts
export type CertificateRevocationResult = 'revoked' | 'not_found';

export class CloudflareMtlsError extends Error {
  constructor(
    public readonly operation: 'issue' | 'revoke',
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    message: string,
  ) { super(message); }
}

revokeCertificate(providerCertificateId: string): Promise<CertificateRevocationResult>;
```

Cloudflare HTTP 404 returns `not_found`; 2xx returns `revoked`; timeouts, 429, and 5xx throw retryable typed errors. Store only a bounded category such as `timeout`, `rate_limited`, `provider_5xx`, or `provider_4xx` in `last_revoke_error`.

`revokeCertificateNowOrEnqueue(certificateId)` runs only after the replacement-activation transaction commits. It attempts provider revocation inline: `revoked` or `not_found` immediately marks the history row revoked; every other result leaves `pending_revocation`, calculates the first due time, and attempts to enqueue. `queueCertificateRevocation(certificateId)` changes `active` to `pending_revocation` only after a replacement is active. The BullMQ job receives only the history-row UUID. The handler reloads the row in system context and:

1. returns success for an already `revoked` row;
2. calls the provider only for `pending_revocation`;
3. marks `revoked_at` on `revoked` or `not_found`;
4. on failure increments attempts and sets `next_revoke_attempt_at` using `min(60 seconds * 2^attempts, 24 hours)`;
5. is safe under duplicate delivery by locking the row and checking state.

Add a five-minute sweep for due `pending_revocation` rows and expired `pending_activation` rows. Expired pending rows are queued for revoke without changing the prior active row.

- [ ] Add failing service tests for inline 2xx/404 completion, inline timeout/429/5xx durable fallback, sanitization, and no provider ID leakage. Prove a failed inline revoke preserves the new active row and old pending-revocation row. Run `pnpm --filter @breeze/api test:run -- src/services/cloudflareMtls.test.ts src/services/deviceMtlsCertificateLifecycle.test.ts`; expect missing typed outcomes/lifecycle service.
- [ ] Implement the typed provider contract, transaction-scoped state transitions, and post-commit `revokeCertificateNowOrEnqueue`; never hold a database transaction open across the provider call.
- [ ] Add failing worker tests for duplicate delivery, already-revoked rows, provider-not-found, forced provider failure, exponential cap, Redis enqueue failure after DB commit, and pending-activation expiry. Expect no worker module initially.
- [ ] Implement `initializeMtlsCertificateRevocationWorker()` and `shutdownMtlsCertificateRevocationWorker()`. Use `runOutsideDbContext` before every `withSystemDbAccessContext`; register initialization and graceful shutdown in `apps/api/src/index.ts`.
- [ ] On enqueue failure, leave `state='pending_revocation'` and `next_revoke_attempt_at <= now()` so the sweep repairs the handoff.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/cloudflareMtls.test.ts src/services/deviceMtlsCertificateLifecycle.test.ts src/jobs/mtlsCertificateRevocation.test.ts`; expect all failure-injection cases to pass.
- [ ] Commit this task as `feat(security): make certificate revocation durable`.

### Task 4: Add proof-of-possession and two-phase renewal APIs

**Files:**

- Modify: `apps/api/src/routes/agents/mtls.ts`
- Modify: `apps/api/src/routes/agents/mtls.test.ts`
- Create: `apps/api/src/services/mtlsRenewalProof.ts`
- Create: `apps/api/src/services/mtlsRenewalProof.test.ts`
- Modify: `apps/api/src/services/cloudflareMtls.ts`

Keep legacy `POST /api/v1/agents/renew-cert` response compatibility. Add capable-agent request/response shapes:

```ts
type CapableRenewRequest = {
  protocolVersion: 2;
  recoveryProof?: {
    challengeId: string;
    expiresUnix: number;
    signatureBase64: string;
  };
};

type CapableRenewResponse = {
  protocolVersion: 2;
  certificateId: string;
  activationExpiresAt: string;
  mtls: {
    certificate: string;
    privateKey: string;
    expiresAt: string;
    serialNumber: string;
  };
};

type ConfirmRenewRequest = { protocolVersion: 2; certificateId: string };
```

Add these exact routes:

- `POST /api/v1/agents/renew-cert/challenge`: bearer-authenticated, rate-limited, returns a one-use
  5-minute `{challengeId, expiresUnix}` only when the device's active certificate is expired and has
  `public_key_spki`.
- `POST /api/v1/agents/renew-cert`: applies the same `off|audit|enforce` compatibility mode as
  request binding. In `off`, preserve the current bearer-only legacy response while still writing
  durable history. In `audit`, accept that legacy request but emit a bounded
  `renewal_binding_missing`/`renewal_proof_missing` reason; never deny on the observation alone. In
  `enforce`, an unexpired active row requires its matching certificate assertion and an expired row
  requires a valid recovery proof.
- `POST /api/v1/agents/renew-cert/confirm`: requires the new certificate assertion and atomically
  activates the named pending row, updates legacy `devices.mtls_cert_*`, changes the previous active
  row to `pending_revocation`, and attempts the durable enqueue.

The proof signs exactly `['breeze-mtls-renew-v1', deviceId, challengeId, String(expiresUnix)].join('\n')` as UTF-8 bytes.

Store Redis key `mtls:renew-proof:<deviceId>:<challengeId>` with a five-minute TTL. Verify the
signature against stored SPKI, require the body expiry to equal the stored expiry, and consume the
key atomically with a Lua compare/delete script. A replay, wrong device, wrong key, expired
challenge, or malformed signature fails closed whenever a proof is supplied, in every mode. In
`enforce`, a missing proof/SPKI also fails closed and the legacy imported certificate uses
administrator-authorized enrollment/re-enrollment. In `off`/`audit`, missing proof/SPKI follows the
compatibility behavior above so existing self-hosted agents do not lose renewal when the default
remains `off`.

For protocol v2, issue a 15-minute `pending_activation` row and return it without changing the old active row or legacy device columns. Parse the issued leaf certificate server-side to derive serial, SHA-256 DER fingerprint, and base64 SPKI. For a legacy request with no `protocolVersion`, retain the current JSON shape, but write the new row active and the replaced row pending-revocation in one transaction before returning; enqueue failure is repaired by the sweep.

- [ ] Add failing proof-service tests for valid P-256/RSA signatures as supported by the issued certificate, replay, expiry, wrong device/key, tampered canonical bytes, and Redis failure. Run `pnpm --filter @breeze/api test:run -- src/services/mtlsRenewalProof.test.ts`; expect the service to be absent.
- [ ] Implement challenge issue/consume with bounded Redis keys and no proof material in logs.
- [ ] Add failing route tests covering each mode: bearer-only renewal remains compatible in `off`,
  succeeds with a bounded observation in `audit`, and is denied in `enforce`; also cover unexpired
  matching renewal, valid expired proof, invalid supplied proof denial in every mode, enforce-mode
  admin re-enrollment, protocol-v2 pending response, legacy response keyset, confirmation with the
  new assertion, confirmation with the old assertion, timeout expiry, and queue failure after
  activation.
- [ ] Implement the routes and certificate parsing. Ensure a failed issue or DB transaction revokes the orphan provider certificate through the durable lifecycle service.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/routes/agents/mtls.test.ts src/services/mtlsRenewalProof.test.ts`; expect all renewal and compatibility cases to pass.
- [ ] Commit this task as `feat(security): require proof for certificate renewal`.

### Task 5: Teach capable agents to persist and confirm before promotion

**Files:**

- Modify: `agent/internal/config/config.go`
- Modify: `agent/internal/config/config_test.go`
- Modify: `agent/pkg/api/client.go`
- Modify: `agent/pkg/api/client_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`
- Modify: `agent/internal/mtls/mtls.go`
- Modify: `agent/internal/mtls/mtls_test.go`

Add persisted pending fields:

```go
PendingMTLSCertificate   string    `json:"pending_mtls_certificate,omitempty"`
PendingMTLSPrivateKey    string    `json:"pending_mtls_private_key,omitempty"`
PendingMTLSCertificateID string    `json:"pending_mtls_certificate_id,omitempty"`
PendingMTLSExpiresAt     time.Time `json:"pending_mtls_expires_at,omitempty"`
```

`RenewCert` sends `protocolVersion: 2`. After response:

1. write the pending certificate/key/ID/expiry with the existing atomic `SaveTo`;
2. build a one-off TLS client from pending material;
3. call `/agents/renew-cert/confirm`;
4. on success atomically promote pending material into the existing active fields and clear pending fields;
5. on process restart, resume confirmation before requesting another certificate;
6. if the pending certificate has expired, clear it and continue using the old active certificate.

For expired recovery, sign the API's canonical challenge bytes with the old private key and send the proof. Never print the private key, signature, or certificate body.

- [ ] Add failing table-driven config tests proving pending fields survive an atomic save/reload and promotion clears all pending fields without changing unrelated config.
- [ ] Add failing API-client tests for protocol-v2 keysets, one-off pending TLS confirmation, non-2xx confirmation, and recovery proof canonicalization.
- [ ] Add failing heartbeat tests for save-before-confirm ordering, crash/restart resume, confirm-before-promotion, confirmation failure retaining old active material, pending expiry, and no repeated issuance while a valid pending certificate exists.
- [ ] Implement the minimum persistence/client/heartbeat changes. Keep response decoding compatible with a legacy server response during rolling upgrades.
- [ ] Run `cd agent && go test -race ./internal/config ./pkg/api ./internal/mtls ./internal/heartbeat`; expect all tests and the race detector to pass.
- [ ] Kill an agent process after pending save but before confirm in a local integration fixture; restart it and prove it confirms and promotes once while the server queues the old certificate exactly once.
- [ ] Commit this task as `feat(agent): confirm mTLS renewal after durable save`.

### Task 6: Centralize certificate/device binding for REST and command WebSocket

**Files:**

- Create: `apps/api/src/services/agentCertificateBinding.ts`
- Create: `apps/api/src/services/agentCertificateBinding.test.ts`
- Modify: `apps/api/src/middleware/agentAuth.ts`
- Modify: `apps/api/src/middleware/agentAuth.test.ts`
- Modify: `apps/api/src/routes/agentWs.ts`
- Modify: `apps/api/src/routes/agentWs.test.ts`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`

Use one shared decision:

```ts
export type AgentMtlsBindingMode = 'off' | 'audit' | 'enforce';
export type AgentCertificateBindingReason =
  | 'matched'
  | 'mode_off'
  | 'untrusted_assertion'
  | 'missing_assertion'
  | 'legacy_identity'
  | 'serial_mismatch'
  | 'certificate_not_active';

export type AgentCertificateBindingDecision = {
  allowed: boolean;
  reason: AgentCertificateBindingReason;
};

export function checkAgentCertificateBinding(input: {
  mode: AgentMtlsBindingMode;
  assertionTrusted: boolean;
  assertedVerified: boolean;
  assertedSerial: string | null;
  storedSerial: string | null;
  storedState: DeviceMtlsCertificateState | null;
}): AgentCertificateBindingDecision;
```

Read only protected internal headers `X-Breeze-Client-Cert-Verified` and `X-Breeze-Client-Cert-Serial`, and set `assertionTrusted` only when `trustsForwardedHeadersFrom(c)` is true. Never use raw Cloudflare or user-supplied certificate headers in auth code. Normalize serials once as uppercase hexadecimal without separators.

Mode behavior:

- `off`: never denies and emits no per-request metric;
- `audit`: never denies; emits a bounded counter by reason;
- `enforce`: requires a verified matching assertion only when a device has an active stored certificate; a legacy NULL identity remains allowed and separately counted during compatibility.

Both `agentAuthMiddleware` and `validateAgentToken` in `agentWs.ts` load the same active history/legacy identity data and call this service after bearer authentication but before accepting the request/upgrade. No duplicated comparison remains.

- [ ] Add failing pure decision-table tests for all modes, matching/mismatched serials, missing/untrusted/spoofed headers, inactive history, and legacy NULL identity. Run `pnpm --filter @breeze/api test:run -- src/services/agentCertificateBinding.test.ts`; expect the module to be absent.
- [ ] Add `AGENT_MTLS_BINDING_MODE` to config validation as the exact enum with default `off`; reject other values.
- [ ] Implement the pure check and a Hono assertion reader that delegates source trust to `trustsForwardedHeadersFrom`.
- [ ] Add REST and WebSocket tests proving matching identity succeeds, mismatch follows mode, an assertion from an untrusted source is ignored, a bearer token cannot choose another device, and both paths emit the same reason.
- [ ] Replace both auth implementations with the shared service. Metrics contain mode/reason/path class only.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/agentCertificateBinding.test.ts src/middleware/agentAuth.test.ts src/routes/agentWs.test.ts src/config/validate.test.ts`; expect all cases to pass.
- [ ] Commit this task as `feat(security): bind agent auth to certificate identity`.

### Task 7: Normalize protected edge assertions and exact route coverage

**Files:**

- Modify: `docker/Caddyfile.prod`
- Modify: `docs/operations/cloudflare-mtls-setup.md`
- Modify: `apps/docs/src/content/docs/security/mtls.mdx`
- Create: `scripts/check-agent-mtls-edge-policy.sh`
- Modify: `package.json`

Document and test this exact protected set:

- REST identity: `^/api/v1/agents/[0-9a-fA-F]{64}(?:/.*)?$`
- capable confirmation: exact `/api/v1/agents/renew-cert/confirm`
- command WebSocket: `^/api/v1/agent-ws/[0-9a-fA-F]{64}/ws$`
- extension agent mount: `^/api/v1/(?:ext/)?[a-z0-9][a-z0-9-]*/agent/[0-9a-fA-F]{64}(?:/.*)?$`

> **AMENDED after the final whole-branch review (finding C3).** This section originally
> specified a 36-character `[0-9a-fA-F-]{36}` identity segment, i.e. a UUID shape. That was
> wrong in both directions and the wave shipped it into `docker/Caddyfile.prod`, both operator
> docs and the CI check.
>
> The path parameter on every agent route is the **agent ID**, not a device UUID. It is
> `randomBytes(32).toString('hex')` — a **64-character hex string** (`generateAgentId`,
> `apps/api/src/routes/agents/helpers.ts:2071`), matched against `devices.agent_id` by
> `apps/api/src/middleware/agentAuth.ts` and `apps/api/src/routes/agentWs.ts`. A `{36}` pattern
> therefore matches **no** agent route at all, so the rule protected nothing; and it **does**
> match the 36-character UUID **admin** routes (`/api/v1/agents/<deviceId>/approve`, `/reject`,
> `/quarantined` — `apps/api/src/routes/agents/mtls.ts`, user-JWT + `requirePermission`,
> `z.string().guid()`), which would have blocked administrators, whose browsers have no client
> certificate, once the rule went live. `{64}` cannot match a 36-character UUID, so the admin
> surface is now excluded structurally rather than by an exemption entry that could be dropped.
>
> The fourth pattern was added at the same time: extensions declaring `agentRoutes: true` mount
> a second agent-token device-identity surface at `/api/v1/ext/<extension>/agent/<agentId>` and
> `/api/v1/<routeNamespace>/agent/<agentId>` (`apps/api/src/extensions/gateway.ts`,
> `apps/api/src/extensions/loader.ts`), authenticated by the same `agentAuthMiddleware`. The
> original protected set omitted it.

The exact exemptions are `/api/v1/agents/enroll`, `/api/v1/agents/renew-cert`, and `/api/v1/agents/renew-cert/challenge` — **exactly three**, enforced by cardinality, not just by presence. Do not use `contains`, `/renew-cert*`, an inequality (`ne` / `!=`), or another broad substring exemption. Confirmation is protected because it proves the newly issued identity.

At the final trusted reverse proxy:

1. discard inbound `X-Breeze-Client-Cert-Verified` and `X-Breeze-Client-Cert-Serial` — **globally, via a site-level `request_header -...`, never with a `header_up` inside the same `reverse_proxy` that sets them.** Caddy compiles a `reverse_proxy`'s `header_up` lines into one header-operation set and applies deletes **after** sets regardless of source order, so a co-located discard erases the assertion just derived and the origin receives nothing (final-review finding C1, reproduced against real `caddy:2`). Global placement also closes finding I6: `/api/v1/mcp/sse`, `/api/v1/ai/sessions/*/stream`, `/api/v1/helper/chat/sessions/*/messages`, `/oauth/*` and the OAuth `.well-known` endpoints all reach the same `api:3001` origin through their own `handle` blocks and were previously unstripped;
2. discard raw provider certificate headers from untrusted upstreams — on **every** route that reaches the API origin, all four of `Cf-Client-Cert-Verified`, `-Serial`, `-Der-Base64`, `-Sha256`;
3. set the two Breeze headers only from a verified Cloudflare mTLS result or an operator-configured local mTLS verifier;
4. never forward the client certificate PEM or private material.

The shell check parses the Caddy/docs expressions and rejects broad renewal exceptions, missing command-WS coverage, or forwarding of a client-supplied Breeze assertion.

- [ ] Add the failing edge-policy check and `check:agent-mtls-edge-policy` root script. Run `pnpm check:agent-mtls-edge-policy`; expect failure against the existing broad `/renew-cert` expression and missing command-WS coverage.
- [ ] Update Caddy normalization and both operator documents with the exact paths, mode progression, assertion contract, and direct-origin bypass warning.
- [ ] Include self-host instructions: leave mode `off` unless the proxy validates the peer certificate and strips/overwrites both headers; setting headers from arbitrary client input is explicitly unsupported.
- [ ] Run `pnpm check:agent-mtls-edge-policy`; expect a zero exit and all positive/negative fixtures to pass.
- [ ] Commit this task as `docs(security): define exact agent mTLS edge policy`.

### Task 8: Make HTTPS scheme and redirect origin authoritative

**Files:**

- Create: `apps/api/src/services/requestTransport.ts`
- Create: `apps/api/src/services/requestTransport.test.ts`
- Modify: `apps/api/src/middleware/security.ts`
- Modify: `apps/api/src/middleware/security.test.ts`
- Modify: `apps/api/src/routes/auth/helpers.ts`
- Modify: `apps/api/src/routes/auth/helpers.test.ts`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`

Provide:

```ts
export function effectiveRequestScheme(c: Context): 'http' | 'https';
export function canonicalHttpsRedirect(c: Context, publicApiUrl: URL): URL | null;
```

`effectiveRequestScheme` uses `X-Forwarded-Proto` only when `trustsForwardedHeadersFrom(c)` is true; otherwise it uses the direct request URL. Accept only the first normalized value `http` or `https`; malformed or multi-value ambiguity is insecure.

When `FORCE_HTTPS=true`:

- require `PUBLIC_API_URL` to parse as an `https:` URL with no username, password, query, or fragment;
- reject an inbound Host that is neither the canonical host nor an explicitly configured trusted proxy representation;
- build `Location` from `PUBLIC_API_URL` plus the request pathname/query, never from inbound Host;
- return 400 for an unrecognized Host instead of reflecting it.

`isRequestConnectionSecure` in auth helpers and the global security middleware both use the new service. Existing `TRUSTED_PROXY_CIDRS` validation remains the only production proxy-source authority.

- [ ] Add failing table-driven tests for direct HTTPS, direct HTTP, trusted/untrusted forwarded HTTPS, malformed/multi-value proto, canonical Host, attacker Host, IPv6 host formatting, and canonical path/query preservation.
- [ ] Implement the transport service and require canonical HTTPS config when force-HTTPS is enabled.
- [ ] Replace raw `x-forwarded-proto` and request-Host handling in both callers.
- [ ] Run `pnpm --filter @breeze/api test:run -- src/services/requestTransport.test.ts src/middleware/security.test.ts src/routes/auth/helpers.test.ts src/config/validate.test.ts`; expect all positive/negative cases to pass.
- [ ] Run local Caddy/API probes for direct origin, trusted proxy, spoofed forwarded proto, canonical host, and attacker host; expect only canonical insecure requests to redirect and attacker hosts to return 400.
- [ ] Commit this task as `fix(security): trust only canonical request transport`.

### Task 9: Wire configuration without changing self-host defaults

**Files:**

- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `deploy/docker-compose.prod.yml`
- Modify: `docs/operations/cloudflare-mtls-setup.md`
- Modify: `apps/docs/src/content/docs/security/mtls.mdx`
- Modify: `scripts/security/check-supply-chain-hardening.sh`

Map `AGENT_MTLS_BINDING_MODE` explicitly into the API service in both compose files:

```env
# off is the safe mixed-version and self-hosted default.
AGENT_MTLS_BINDING_MODE=off
```

Do not infer `audit` or `enforce` from `NODE_ENV`, `IS_HOSTED`, `CF_MTLS_*`, or proxy headers. The operator must select the mode.

- [ ] Add a failing compose/config contract assertion that the variable is documented, mapped into both API service definitions, and defaults to `off`.
- [ ] Add the mappings and rollout documentation.
- [ ] Run `bash scripts/security/check-supply-chain-hardening.sh`, `docker compose -f docker-compose.yml config`, and `docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build config`; expect valid configuration and no weakened default.
- [ ] Commit this task as `chore(security): wire opt-in agent mTLS binding`.

### Task 10: Execute the Wave 05 rollout and rollback gates

**Hosted canary order:**

1. deploy schema/history and worker with binding `off`;
2. renew a deliberate canary cohort through protocol v2;
3. prove pending-save-confirm-promotion and old-certificate retry;
4. put both exact edge expressions in log mode;
5. set API mode `audit` for seven consecutive days covering REST and command sockets, with at least one deliberate renewal from every hosted canary ring;
6. block direct-origin access and prove assertion spoofing fails;
7. enforce a canary cohort with stored active identities;
8. expand only when mismatch/missing rates are explained and correct-certificate command sockets are healthy.

**Rollback:** Set `AGENT_MTLS_BINDING_MODE=off` and return Cloudflare rules to log mode. Mode `off`
restores legacy bearer-only renewal compatibility without deleting certificate history or durable
revocation state. Stop the revocation worker only after leaving due rows durable; restart it to
resume. If an agent release is faulty, ship a higher-version forward fix so updater downgrade
protection is not bypassed.

- [ ] Run API focused suites:

  ```bash
  pnpm --filter @breeze/api test:run -- \
    src/services/cloudflareMtls.test.ts \
    src/services/deviceMtlsCertificateLifecycle.test.ts \
    src/services/mtlsRenewalProof.test.ts \
    src/services/agentCertificateBinding.test.ts \
    src/services/requestTransport.test.ts \
    src/jobs/mtlsCertificateRevocation.test.ts \
    src/routes/agents/mtls.test.ts \
    src/middleware/agentAuth.test.ts \
    src/routes/agentWs.test.ts \
    src/middleware/security.test.ts
  ```

  Expect zero failures.

- [ ] Run `pnpm --filter @breeze/api test:run`, `pnpm --filter @breeze/api test:integration`, `pnpm --filter @breeze/api test:rls-coverage`, `pnpm --filter @breeze/api db:check-drift`, and `pnpm --filter @breeze/api build`; expect all gates green.
- [ ] Run `cd agent && go test -race ./...`; expect zero failures and no race reports.
- [ ] Force provider revoke timeout, provider 404, duplicate delivery, Redis failure before enqueue, Redis failure after DB commit, and API restart. Expect old identity retained until replacement activation, 404 completed, and the due-retry query to return zero rows within two sweep intervals after dependencies recover.
- [ ] As `breeze_app`, forge a cross-tenant certificate insert/update/select/delete; expect RLS denial or no rows for every operation.
- [ ] Exercise Caddy, Cloudflare, and direct-origin combinations. Expect spoofed assertions and unknown Host rejected, trusted forwarded HTTPS accepted, and redirect `Location` always rooted at `PUBLIC_API_URL`.
- [ ] Prove a no-certificate command socket remains accepted in `audit`, a correct-certificate socket is healthy, and the no-certificate socket is denied only after `enforce`.
- [ ] Prove self-host compose with no new environment override behaves exactly as before because
  the mode is `off`, including a current bearer-only renewal request and its legacy response keyset.
- [ ] Obtain one independent security review covering RLS, renewal proof, activate/revoke ordering, duplicated auth removal, proxy trust, and rollback.
- [ ] Record canary evidence and metric snapshots in the deployment change record; include counts only, with no serial, fingerprint, assertion, token, proof, or path parameter.
- [ ] Commit verification-only adjustments as `test(security): close Wave 05 mTLS gates`.

## Completion Criteria

- The current certificate remains usable until a capable agent has saved and confirmed its replacement.
- Forced revoke failure is durable, retryable, idempotent, and provider-not-found completes it.
- Valid-certificate renewal is certificate-bound; expired recovery requires old-key proof or administrator-authorized re-enrollment.
- REST and command WebSocket authentication use the same certificate/device decision.
- Edge rules cover exact REST/confirmation/command-WS paths and contain no broad renewal exception.
- Forwarded scheme and certificate assertions are trusted only from configured proxy CIDRs.
- Redirects use only canonical `PUBLIC_API_URL`; unknown Host is never reflected.
- Cross-tenant certificate access fails under forced RLS, including a forged composite relationship.
- Hosted enforcement has observation and canary evidence; self-hosted defaults remain unchanged.
