# Breeze M365 Customer Graph Read Consent Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Deliver the first operational organization-owned M365 profile: customer administrator consent, signed tenant binding, exact Microsoft Graph application-grant reconciliation, safe lifecycle management, and a minimal Breeze UI for `customer-graph-read`.

**Architecture:** Breeze remains the authorization, tenancy, lifecycle, and audit control plane. A separately built and deployed `@breeze/m365-graph-read-executor` is the only workload that can read the version-pinned certificate from Azure Key Vault or receive Microsoft tokens. The API sends only two bounded, short-lived-JWT-authenticated operations to that private executor. Microsoft Graph access tokens stay opaque and inside the executor; Breeze persists only verified tenant metadata, canonical grant observations, timestamps, status, and stable error codes.

**Tech Stack:** TypeScript 5.7, Hono, Drizzle ORM 0.45, PostgreSQL RLS, Zod 4, jose 6, Azure Identity/Key Vault, React 19, Vitest 4, pnpm workspaces, Docker Compose, GitHub Actions.

**Depends on:** PR #2495 at or after `ecf459745153762cedbea601b3a30cef21780cc1`.

## Locked delivery constraints

- Preserve the existing legacy `/m365/connection` behavior and legacy credential card.
- Do not add arbitrary Graph URLs, HTTP verbs, scopes, PowerShell, or general executor passthroughs.
- Do not decode a Microsoft Graph access token. Only Microsoft Graph validates and consumes it.
- The API, browser, database, Hive, and general Breeze workers never receive the Graph application certificate or app-only access token.
- Use a separately packaged executor application and image. The API package must no longer contain Azure Key Vault credential-reading code.
- The executor exposes only `POST /v1/complete-consent` and `POST /v1/retest`; it has no public ingress.
- Use exact, code-owned Graph resource application IDs and app-role IDs. Display names alone never determine grant equality.
- Bind a verified tenant GUID once. A different tenant requires local disconnect and a fresh consent attempt.
- Store only a SHA-256 hash of each one-time callback state. Validate the signed browser binding before atomically consuming it.
- Enable and force RLS on every new tenant-adjacent table; consent sessions are system-scope only.
- Do not hold a database transaction open while calling Microsoft or the executor.
- Initiation is dark by default behind `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED`. Status, callbacks, retest, and disconnect remain usable for existing/in-flight connections.
- Callback UI state uses the URL fragment, never a query parameter: `#m365/customer-graph-read/<allowlisted-result>`, then normalizes to `#m365`.
- Use `runAction` for every web mutation and retain server-side permission, MFA, org-scope, and partner-wide authorization.
- Treat callback text as cosmetic. The refreshed scoped API response is authoritative.
- Follow TDD, run the named focused test after every implementation step, and make the commit shown at the end of each task.

## Stable public outcomes

The callback, persisted `lastErrorCode`, API DTO, and UI share this closed union; no provider string or unknown value crosses the boundary:

```ts
type M365CustomerGraphReadPublicOutcome =
  | 'active'
  | 'degraded'
  | 'consent_expired'
  | 'consent_state_mismatch'
  | 'consent_cancelled'
  | 'admin_role_required'
  | 'tenant_mismatch'
  | 'tenant_already_bound'
  | 'credential_unavailable'
  | 'identity_token_invalid'
  | 'application_token_invalid'
  | 'grant_reconciliation_unavailable'
  | 'grant_missing'
  | 'grant_unexpected'
  | 'manifest_stale'
  | 'organization_probe_failed'
  | 'executor_unavailable';
```

Mapping is deterministic: expired local state maps to `consent_expired`; malformed, mismatched, or replayed state maps to `consent_state_mismatch`; Microsoft cancellation maps to `consent_cancelled`; executor codes retain the same public code; a unique tenant/profile collision maps to `tenant_already_bound`; executor transport/timeout/schema failure maps to `executor_unavailable`; manifest mismatch maps to `manifest_stale`; and complete grant drift maps to `grant_unexpected` when any excess role exists, otherwise `grant_missing`. Successful exact and drifted verification redirect as `active` and `degraded`; a degraded row also retains its specific stable drift code. HTTP uses the repository's generic safe 4xx/5xx envelopes and never reflects Microsoft descriptions.

## Task 1: Move the M365 authority and executor contracts into the shared package

**Files:**

- Create: `packages/shared/src/m365/index.ts`
- Create: `packages/shared/src/m365/profiles.ts`
- Create: `packages/shared/src/m365/profiles.test.ts`
- Create: `packages/shared/src/m365/executorContracts.ts`
- Create: `packages/shared/src/m365/executorContracts.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`
- Modify: `apps/api/src/services/m365ControlPlane/profiles.ts`
- Modify: `apps/api/src/services/m365ControlPlane/profiles.test.ts`

- [ ] **Step 1: Write failing shared manifest and strict-schema tests**

Assert that `customer-graph-read` is manifest version 2 and contains exactly these nine structured grants on Microsoft Graph resource app `00000003-0000-0000-c000-000000000000`:

```ts
export interface M365ApplicationGrant {
  readonly resourceApplicationId: string;
  readonly appRoleId: string;
  readonly value: string;
}

export interface CanonicalAppRoleAssignment {
  readonly resourceApplicationId: string;
  readonly appRoleId: string;
  readonly value: string | null;
}

export function canonicalGrantKey(grant: Pick<M365ApplicationGrant, 'resourceApplicationId' | 'appRoleId'>): string {
  return `${grant.resourceApplicationId}/${grant.appRoleId}`;
}
```

| Value | App role ID |
|---|---|
| `Application.Read.All` | `9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30` |
| `AuditLog.Read.All` | `b0afded3-3588-46d8-8b3d-9842eff778da` |
| `Device.Read.All` | `7438b122-aefc-4978-80ed-43db9fcc7715` |
| `DeviceManagementConfiguration.Read.All` | `dc377aa6-52d8-4e23-b271-2a7ae04cedf3` |
| `DeviceManagementManagedDevices.Read.All` | `2f51be20-0bb4-4fed-bf7b-db946066c75e` |
| `Group.Read.All` | `5b567255-7703-4780-807c-7be8301ae99b` |
| `Organization.Read.All` | `498476ce-e0fe-48b0-b801-37ba7e2685c6` |
| `Sites.Read.All` | `332a536c-c7ef-4017-ab91-336970924f0d` |
| `User.Read.All` | `df021288-bdef-4463-88db-98f22de89214` |

Define strict Zod request/response schemas for:

```ts
type CompleteConsentRequest = {
  correlationId: string;
  consentAttemptId: string;
  tenantHint: string;
  authorizationCode: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
};

type RetestRequest = {
  correlationId: string;
  tenantId: string;
};

type ExecutorFailureCode =
  | 'admin_role_required'
  | 'tenant_mismatch'
  | 'credential_unavailable'
  | 'identity_token_invalid'
  | 'application_token_invalid'
  | 'organization_probe_failed';
```

Retain the existing name-only `applicationPermissions: readonly string[]` for unimplemented future profiles and add `applicationPermissionAssignments?: readonly M365ApplicationGrant[]`; only the operational `customer-graph-read` profile must define the structured field in this phase. The verified response includes tenant ID, application ID, organization display name, manifest version, and `verifiedAt`. Its discriminated outcome is either a complete reconciliation with canonical observed/missing/unexpected assignments and `grantsVerifiedAt`, or verified-but-degraded `grant_reconciliation_unavailable` with `observedGrants: null` and `grantsVerifiedAt: null`. This permits safe first-time tenant binding after signed identity plus organization proof while accurately marking grants unknown. Only complete-consent may include `administratorObjectId`; API DTOs must later omit it.

- [ ] **Step 2: Run the tests and verify they fail because the shared modules do not exist**

```bash
pnpm --filter @breeze/shared exec vitest run \
  src/m365/profiles.test.ts \
  src/m365/executorContracts.test.ts
```

- [ ] **Step 3: Implement the shared registry, canonicalizer, strict schemas, and exports**

Keep `apps/api/src/services/m365ControlPlane/profiles.ts` as a thin compatibility re-export so existing imports remain stable. Do not move the future action/PowerShell profiles to version 2 or invent role IDs for them.

- [ ] **Step 4: Run shared and API profile tests**

```bash
pnpm --filter @breeze/shared exec vitest run src/m365/profiles.test.ts src/m365/executorContracts.test.ts
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/profiles.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api/src/services/m365ControlPlane/profiles.ts apps/api/src/services/m365ControlPlane/profiles.test.ts
git commit -m "feat(m365): share graph read manifest contracts"
```

## Task 2: Evolve connection storage and add system-only consent sessions

**Files:**

- Create: `apps/api/migrations/2026-07-14-m365-customer-graph-read-consent.sql`
- Create: `apps/api/src/db/migration-m365-customer-graph-read-consent.test.ts`
- Modify: `apps/api/src/db/schema/m365.ts`
- Modify: `apps/api/src/db/schema/m365.test.ts`
- Modify: `apps/api/src/__tests__/integration/m365ConnectionsRls.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts`

- [ ] **Step 1: Write failing migration-source, schema, and RLS integration tests**

Cover:

- `tenant_id` becomes nullable; `profile`, `auth_mode`, and `credential_domain` lose defaults.
- Add `consent_attempt_id uuid` and `grants_verified_at timestamptz`.
- Type `observed_grants` as JSON `CanonicalAppRoleAssignment[]`, sorted uniquely by ID-only canonical key; legacy empty arrays remain valid.
- Drop `m365_connections_org_uniq`; preserve owner/profile uniqueness.
- Unique verified ownership uses `(tenant_id, profile)` only where tenant is non-null, `org_id IS NOT NULL`, `user_id IS NULL`, and profile is one of the three organization-owned customer profiles; delegated user rows are explicitly excluded.
- Non-legacy tenant GUIDs must be lowercase canonical values.
- `customer-graph-read` requires organization ownership, vault metadata, and a consent attempt.
- A unique `(id, org_id, profile, consent_attempt_id)` target exists for the consent-session composite foreign key.
- Preflight blocks duplicate/invalid existing rows; legacy secrets are never rewritten or cleared.
- An executable migration test seeds a legacy row and verifies its encrypted secret and metadata remain byte-for-byte unchanged.
- Applying the migration twice succeeds; every new table, constraint, FK, index, and RLS policy uses catalog guards or deterministic drop/recreate behavior.
- Same org can hold legacy plus graph-read; same tenant/profile cannot bind across orgs; a different profile may bind the same tenant.
- Organization, partner, and user scopes cannot CRUD consent sessions; system scope can.

The partial unique-index predicate is exactly:

```sql
WHERE tenant_id IS NOT NULL
  AND org_id IS NOT NULL
  AND user_id IS NULL
  AND profile IN (
    'customer-graph-read',
    'customer-graph-actions',
    'customer-exchange-powershell'
  )
```

- [ ] **Step 2: Run the focused tests and verify the expected missing migration/schema failures**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/db/migration-m365-customer-graph-read-consent.test.ts \
  src/db/schema/m365.test.ts
```

- [ ] **Step 3: Implement the idempotent migration and Drizzle schema**

Create `m365_consent_sessions` with:

```text
id uuid primary key default gen_random_uuid()
state_hash char(64) unique not null
phase varchar(24) not null check in ('admin_consent', 'identity_verification')
connection_id uuid not null
org_id uuid not null
profile varchar(64) not null check = 'customer-graph-read'
consent_attempt_id uuid not null
user_id uuid not null
tenant_hint_hash char(64) null
nonce text null
code_verifier text null
expires_at timestamptz not null
created_at timestamptz not null default now()
```

The composite foreign key targets the connection/organization/profile/attempt identity and uses `ON DELETE CASCADE`. Admin-consent rows require tenant hint, nonce, and verifier to be null; identity-verification rows require all three. Add expiry and connection/attempt indexes. Execute `ALTER TABLE m365_consent_sessions ENABLE ROW LEVEL SECURITY` and `ALTER TABLE m365_consent_sessions FORCE ROW LEVEL SECURITY`; all CRUD policies use only `public.breeze_current_scope() = 'system'`. Name every new database object explicitly and test its idempotency.

- [ ] **Step 4: Run migration, schema, real-role RLS, and migration checks**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/db/migration-m365-customer-graph-read-consent.test.ts \
  src/db/schema/m365.test.ts
pnpm --filter @breeze/api test:docker:up
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365ConnectionsRls.integration.test.ts \
  src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts
pnpm --filter @breeze/api test:docker:down
pnpm --filter @breeze/api check:migrations
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-07-14-m365-customer-graph-read-consent.sql apps/api/src/db apps/api/src/__tests__/integration/m365ConnectionsRls.integration.test.ts apps/api/src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts
git commit -m "feat(m365): add consent lifecycle storage"
```

## Task 3: Implement one-time consent session primitives

**Files:**

- Create: `apps/api/src/services/m365ControlPlane/consentSessionService.ts`
- Create: `apps/api/src/services/m365ControlPlane/consentSessionService.test.ts`

- [ ] **Step 1: Write failing tests for randomness, hashing, PKCE, expiry, and atomic consumption**

Use this public surface:

```ts
createAdminConsentSession(input): Promise<{ rawState: string; session: M365ConsentSession }>;
createIdentityVerificationSession(input): Promise<{
  rawState: string;
  codeChallenge: string;
  session: M365ConsentSession;
}>;
consumeConsentSession(input: {
  rawState: string;
  phase: M365ConsentPhase;
  connectionId: string;
  orgId: string;
  consentAttemptId: string;
}): Promise<M365ConsentSession | null>;
deleteConsentSessionsForAttempt(input): Promise<void>;
hashTenantHint(tenantId: string): string;
```

Assert 32 random bytes, ten-minute TTL, raw state never reaches the DB, collision regeneration, tenant-hint hashing, S256 PKCE, nonce generation, phase/owner/attempt separation, expiry rejection, and replay returning null.

- [ ] **Step 2: Run the test and verify it fails because the service is missing**

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/consentSessionService.test.ts
```

- [ ] **Step 3: Implement short system-scope transactions**

Use `runOutsideDbContext(() => withSystemDbAccessContext(...))`; a nested system context inside an existing request transaction is not sufficient. Expose transaction-scoped insert/delete helpers so Task 10 can rotate the connection attempt and session atomically in one system transaction rather than nesting autonomous transactions. Consumption must be one `DELETE ... RETURNING` constrained by hashed state, phase, expiry, connection, org, profile, and attempt.

- [ ] **Step 4: Run the test and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/consentSessionService.test.ts
git add apps/api/src/services/m365ControlPlane/consentSessionService.*
git commit -m "feat(m365): add one-time consent sessions"
```

## Task 4: Add fail-closed runtime configuration and onboarding rollout

**Files:**

- Create: `apps/api/src/services/m365ControlPlane/runtimeConfig.ts`
- Create: `apps/api/src/services/m365ControlPlane/runtimeConfig.test.ts`
- Modify: `apps/api/src/config/env.ts`
- Modify: `apps/api/src/config/env.test.ts`
- Modify: `apps/api/src/config/validate.ts`
- Modify: `apps/api/src/config/validate.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing configuration tests**

When onboarding is true require:

```text
M365_CUSTOMER_GRAPH_READ_CLIENT_ID
M365_CUSTOMER_GRAPH_READ_VAULT_REF
M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION
M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS
M365_GRAPH_READ_EXECUTOR_URL
M365_GRAPH_READ_EXECUTOR_AUDIENCE
M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE
M365_GRAPH_READ_EXECUTOR_SIGNING_KID
```

Validate a canonical client UUID; exact `akv://<host>/m365-customer-graph-read/<32-hex-version>` reference whose final segment equals `M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION`; HTTPS executor URL; exact audience; an absolute, permission-restricted file containing the Ed25519 private JWK; and `kid`. Resolve the public callback origin in the tested precedence `PUBLIC_URL`, `PUBLIC_APP_URL`, then `PUBLIC_API_URL`; production has no localhost fallback. Append exactly `/api/v1/m365/consent/callback`. Default `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED` to false. When enabled, require `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS` as comma-separated canonical UUIDs or literal `*`; per-org `onboardingEnabled` is global flag AND allowlist match.

- [ ] **Step 2: Run the tests and verify missing-parser failures**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/m365ControlPlane/runtimeConfig.test.ts \
  src/config/env.test.ts \
  src/config/validate.test.ts
```

- [ ] **Step 3: Implement lazy configuration loading and boot validation**

Do not expose descriptor fields through the public config route. The API receives no vault credential or Graph certificate. Keep callback/status/retest/disconnect functional when initiation is disabled.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/runtimeConfig.test.ts src/config/env.test.ts src/config/validate.test.ts
git add apps/api/src/services/m365ControlPlane/runtimeConfig.* apps/api/src/config .env.example
git commit -m "feat(m365): configure graph read onboarding"
```

## Task 5: Scaffold the isolated executor and move Key Vault capability out of the API

**Files:**

- Create: `apps/m365-graph-read-executor/package.json`
- Create: `apps/m365-graph-read-executor/tsconfig.json`
- Create: `apps/m365-graph-read-executor/tsup.config.ts`
- Create: `apps/m365-graph-read-executor/vitest.config.ts`
- Create: `apps/m365-graph-read-executor/src/config.ts`
- Create: `apps/m365-graph-read-executor/src/config.test.ts`
- Create: `apps/m365-graph-read-executor/src/credentials/types.ts`
- Move/adapt: `apps/api/src/executors/m365/credentials/azureKeyVaultProvider.ts` to `apps/m365-graph-read-executor/src/credentials/azureKeyVaultProvider.ts`
- Move/adapt: corresponding provider test
- Delete: `apps/api/src/executors/m365/credentials/types.ts`
- Modify: `apps/api/package.json`
- Create/Modify: `apps/m365-graph-read-executor/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Move the provider test first and add failing executor-config tests**

The executor config requires client ID, exact callback URI, vault URL/ref/version, public internal-auth JWK plus `kid`, issuer/audience, and an explicit Azure credential mode. Accept only the fixed profile-level reference `akv://<vault-host>/m365-customer-graph-read/<32-hex-version>`, whose final segment must equal the separately configured version. Production supports only `managed-identity` or `workload-identity`; do not use `DefaultAzureCredential` or Azure CLI fallback.

```ts
export interface PinnedCertificateProvider {
  getConfiguredCertificate(): Promise<{
    certificatePem: string;
    privateKeyPem: string;
  }>;
}
```

Assert read-only, profile/domain/version-pinned retrieval and fixed secret-free failure codes. Replace the foundation's per-connection `put/get` surface with only `getConfiguredCertificate()`; this executor never writes, deletes, or derives a per-customer secret. The strict version-1 envelope is `{ schemaVersion: 1, domain: 'customer-graph-read', material: { kind: 'certificate', certificatePem, privateKeyPem } }`; omit stored thumbprints because Task 6 derives them from the certificate. Reject extra/malformed fields.

- [ ] **Step 2: Run tests and verify the new workspace initially fails**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run \
  src/config.test.ts \
  src/credentials/azureKeyVaultProvider.test.ts
```

- [ ] **Step 3: Implement the workspace and remove Azure credential dependencies from the API**

Give the package `dev`, `build`, `start`, `test`, `test:run`, and `lint` scripts matching the API's tsup/Vitest/TypeScript conventions. Runtime dependencies are `@azure/identity`, `@azure/keyvault-secrets`, `@breeze/shared`, `@hono/node-server`, `hono`, `jose`, and `zod`; dev dependencies are the repository's existing `@types/node`, `tsup`, `tsx`, `typescript`, and `vitest` versions. Add no Microsoft Graph SDK. Confirm no API production module imports `@azure/keyvault-secrets` or the provider, then remove both Azure dependencies from `@breeze/api` unless another production import is found during implementation.

- [ ] **Step 4: Test, build, and commit**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run src/config.test.ts src/credentials/azureKeyVaultProvider.test.ts
pnpm --filter @breeze/m365-graph-read-executor build
pnpm --filter @breeze/api build
git add apps/m365-graph-read-executor apps/api/package.json apps/api/src/executors pnpm-lock.yaml
git commit -m "feat(m365): isolate graph credentials in executor"
```

## Task 6: Implement certificate assertion and fixed Microsoft token exchange

**Files:**

- Create: `apps/m365-graph-read-executor/src/microsoft/clientAssertion.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/clientAssertion.test.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/tokenClient.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/tokenClient.test.ts`
- Create: `apps/m365-graph-read-executor/src/test/fixtures/client-cert.pem`
- Create: `apps/m365-graph-read-executor/src/test/fixtures/client-key.pem`

- [ ] **Step 1: Write failing crypto and HTTP boundary tests**

Test `RS256`, `iss=sub=clientId`, exact tenant token endpoint audience, unique `jti`, lifetime at most five minutes, and Microsoft `x5t` computed as SHA-1 over the X.509 DER certificate then base64url without padding—not from stored metadata. Use the checked-in test-only certificate/key fixture pair. Test authorization-code exchange with PKCE and client assertion, and app-token acquisition with only fixed scope `https://graph.microsoft.com/.default`.

HTTP tests must cover tenant-specific HTTPS host/path, `redirect: 'error'`, abort timeout, body-size bound, malformed JSON, no `client_secret`, no provider-body logging, and an opaque branded access-token return type.

- [ ] **Step 2: Run tests and verify missing implementations**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run \
  src/microsoft/clientAssertion.test.ts \
  src/microsoft/tokenClient.test.ts
```

- [ ] **Step 3: Implement the minimum fixed token client**

Never export raw response objects or decode the Graph access token. Replace all provider/transport failures with stable internal codes and omit causes, query strings, and response bodies.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run src/microsoft/clientAssertion.test.ts src/microsoft/tokenClient.test.ts
git add apps/m365-graph-read-executor/src/microsoft/clientAssertion.* apps/m365-graph-read-executor/src/microsoft/tokenClient.*
git commit -m "feat(m365): add certificate Microsoft token client"
```

## Task 7: Verify signed administrator identity

**Files:**

- Create: `apps/m365-graph-read-executor/src/microsoft/identity.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/identity.test.ts`

- [ ] **Step 1: Write failing ID-token tests**

Port only the safe identity behavior from `apps/api/src/services/ticketMailbox/microsoftIdentity.ts`: Microsoft remote JWKS, allowed algorithms, client audience, tenant-specific issuer, time claims, nonce, canonical `tid`/`oid`, exact tenant-hint equality, and `wids` containing either:

```text
Global Administrator:          62e90394-69f5-4237-9190-012177145e10
Privileged Role Administrator: e8611ab8-c189-46e8-94e1-60213ab1f814
```

Require both `exp` and `nbf`, not merely validate them when present. Test signature, issuer, audience, nonce, tenant, GUID, missing/invalid `exp` and `nbf`, every other missing claim, and ineligible role failures.

- [ ] **Step 2: Run the failing test**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run src/microsoft/identity.test.ts
```

- [ ] **Step 3: Implement verification without reusing client-secret exchange code**

Return only canonical tenant ID and administrator object ID to the complete-consent operation. Never log token claims or the administrator ID.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run src/microsoft/identity.test.ts
git add apps/m365-graph-read-executor/src/microsoft/identity.*
git commit -m "feat(m365): verify consent administrator identity"
```

## Task 8: Probe the tenant and reconcile exact Graph grants

**Files:**

- Create: `apps/m365-graph-read-executor/src/microsoft/graphClient.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/graphClient.test.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/reconcile.ts`
- Create: `apps/m365-graph-read-executor/src/microsoft/reconcile.test.ts`

- [ ] **Step 1: Write failing bounded-Graph and set-reconciliation tests**

Hardcode only:

```text
GET https://graph.microsoft.com/v1.0/organization?$select=id,displayName
GET https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '<fixed-client-id>'&$select=id,appId
GET https://graph.microsoft.com/v1.0/servicePrincipals/<fixed-id>/appRoleAssignments
GET https://graph.microsoft.com/v1.0/servicePrincipals/<resource-id>?$select=appId,appRoles
```

Test exact organization-tenant equality, unique profile service principal, full pagination, maximum page/item/byte bounds, unresolved resources/roles, malformed responses, and same-origin next-link enforcement: HTTPS, exact `graph.microsoft.com`, `/v1.0/`, and the same expected collection path.

Reconciliation compares sorted unique `(resourceApplicationId, appRoleId)` pairs and returns active, missing, unexpected, or both; `value` is presentation metadata only. Unknown app-role IDs remain unexpected with `value: null` and their GUID-bearing ID key—never drop them. Reconciliation becomes unavailable only when the complete assignment collection or an assignment's resource application ID cannot be resolved, not merely because a role's display value is unknown.

- [ ] **Step 2: Run the failing tests**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run \
  src/microsoft/graphClient.test.ts \
  src/microsoft/reconcile.test.ts
```

- [ ] **Step 3: Implement fixed Graph calls and exact reconciliation**

Use `redirect: 'error'`, abort timeouts, no response-body logging, and the opaque access-token type. If the complete authoritative set cannot be resolved, return a verified-but-degraded `grant_reconciliation_unavailable` result with tenant/application/organization proof, `observedGrants: null`, and no `grantsVerifiedAt`; do not return a partial set.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run src/microsoft/graphClient.test.ts src/microsoft/reconcile.test.ts
git add apps/m365-graph-read-executor/src/microsoft/graphClient.* apps/m365-graph-read-executor/src/microsoft/reconcile.*
git commit -m "feat(m365): reconcile exact Graph application grants"
```

## Task 9: Expose two authenticated executor operations

**Files:**

- Create: `apps/m365-graph-read-executor/src/internalAuth.ts`
- Create: `apps/m365-graph-read-executor/src/internalAuth.test.ts`
- Create: `apps/m365-graph-read-executor/src/operations.ts`
- Create: `apps/m365-graph-read-executor/src/operations.test.ts`
- Create: `apps/m365-graph-read-executor/src/app.ts`
- Create: `apps/m365-graph-read-executor/src/app.test.ts`
- Create: `apps/m365-graph-read-executor/src/index.ts`

- [ ] **Step 1: Write failing operation, auth, and HTTP-contract tests**

The API signs a fresh EdDSA JWT no older than 60 seconds with `iss=breeze-api`, `aud=m365-graph-read-executor`, `sub=breeze-control-plane`, `iat`, `exp`, `jti`, configured `kid`, exact operation, correlation ID, and SHA-256 of the exact UTF-8 request body. The executor holds only the public JWK and verifies the operation/body binding before parsing or executing the request. Expose an `InternalRequestAuthenticator` interface for a future workload-identity verifier.

Test strict bounded request bodies and only:

```text
POST /v1/complete-consent
POST /v1/retest
```

`completeConsentOperation` exchanges the identity code, verifies admin identity, acquires the app token, probes the organization, and reconciles grants. `retestOperation` accepts only a canonical stored tenant ID and reruns application verification. Both must return verified-but-degraded tenant/application/organization evidence when grant reconciliation is unavailable; reserve error results for failures that prevent trustworthy binding/probing. Neither response can contain tokens, certificate material, auth codes, nonce/verifier, raw vault reference, or provider bodies.

- [ ] **Step 2: Run and verify missing-module failures**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run \
  src/internalAuth.test.ts \
  src/operations.test.ts \
  src/app.test.ts
```

- [ ] **Step 3: Implement the operations and Hono server**

Fetch the pinned certificate per operation, drop references promptly, map all failures to shared stable response codes, disable request-body logging, and make `/healthz` reveal no configuration. Bind to the configured private interface only.

- [ ] **Step 4: Test, build, and commit**

```bash
pnpm --filter @breeze/m365-graph-read-executor exec vitest run
pnpm --filter @breeze/m365-graph-read-executor build
git add apps/m365-graph-read-executor/src
git commit -m "feat(m365): serve bounded graph read executor"
```

## Task 10: Implement the API executor client and connection lifecycle CAS

**Files:**

- Create: `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts`
- Create: `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.test.ts`
- Create: `apps/api/src/services/m365ControlPlane/connectionService.ts`
- Create: `apps/api/src/services/m365ControlPlane/connectionService.test.ts`

- [ ] **Step 1: Write failing client and lifecycle tests**

The executor client has only:

```ts
completeIdentityVerification(input): Promise<CompleteConsentResult>;
retestCustomerGraphRead(input): Promise<RetestResult>;
```

It serializes the strict request exactly once, creates a fresh short-lived EdDSA JWT bound to that byte sequence and operation, uses redirect refusal/timeout/body bound, and strict-parses responses. Routes cannot supply client ID, vault ref/version, scopes, manifest, Graph URL, or method.

The connection service exposes:

```ts
listCustomerGraphReadConnections(orgId);
initiateCustomerGraphReadConsent(input);
markAdminConsentReturned(snapshot);
markConsentAttemptFailed(snapshot, errorCode);
applyIdentityVerificationResult(snapshot, result);
loadRetestSnapshot({ id, orgId });
applyRetestResult(snapshot, result);
disconnectCustomerGraphReadConnection({ id, orgId, actorId });
deriveGrantHealth(row, currentManifest);
```

Test immutable tenant binding, unique tenant/profile ownership, exact/missing/unexpected grants, first-time verified-but-reconciliation-unavailable binding, manifest stale, zero-row stale CAS, disconnect winning races, and generic `tenant_already_bound`. On incomplete reconciliation retain prior observed grants and `grantsVerifiedAt` for an existing connection; a new binding stores no observed set/timestamp and becomes degraded. A transient retest failure must not demote an active connection.

Initiation is one system transaction: lock the exact organization/profile row, delete all prior consent sessions, rotate `consent_attempt_id`, insert/update the pending connection, and insert the hashed admin-consent session before commit. Never update an attempt while an old composite-FK session exists, and never use `ON UPDATE CASCADE`. Test rollback at every write and two concurrent initiations; exactly one returned state must remain usable.

Disconnect atomically rotates the attempt, deletes all sessions, sets `revoked`, and clears tenant ID/name, application ID, observed grants, grant/verification timestamps, and current error so the unique ownership claim is released while audit retains history. A revoked row cannot execute; only a subsequent authorized fresh initiation can enter pending state and bind a new tenant. Test that tenant B cannot replace tenant A while connected but can bind only after disconnect plus fresh initiation.

- [ ] **Step 2: Run failing tests**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/m365ControlPlane/graphReadExecutorClient.test.ts \
  src/services/m365ControlPlane/connectionService.test.ts
```

- [ ] **Step 3: Implement short transactions and attempt-aware compare-and-swap updates**

Every mutation predicates on connection ID, organization ID, profile, consent attempt ID, and expected lifecycle status. Tenant binding also requires `tenant_id IS NULL OR tenant_id = verifiedTenantId`. For retest, use `dbAccessContextFromAuth(auth)` and `withDbAccessContext` for a short caller-scoped snapshot transaction, call the executor outside every DB context, then use a new caller-scoped CAS write transaction. Never use system scope for retest. Test cross-org retest denial and prove no transaction is held during HTTP.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/graphReadExecutorClient.test.ts src/services/m365ControlPlane/connectionService.test.ts
git add apps/api/src/services/m365ControlPlane/graphReadExecutorClient.* apps/api/src/services/m365ControlPlane/connectionService.*
git commit -m "feat(m365): manage graph read connection lifecycle"
```

## Task 11: Implement the two-phase public callback

**Files:**

- Create: `apps/api/src/routes/m365ConsentCallback.ts`
- Create: `apps/api/src/routes/m365ConsentCallback.test.ts`
- Create: `apps/api/src/services/m365ControlPlane/browserBinding.ts`
- Create: `apps/api/src/services/m365ControlPlane/browserBinding.test.ts`
- Create: `apps/api/src/services/m365ControlPlane/microsoftAuthorization.ts`
- Create: `apps/api/src/services/m365ControlPlane/microsoftAuthorization.test.ts`
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Write failing callback and browser-binding tests**

Put the browser-binding types/helpers in the neutral `browserBinding.ts` module because both initiation and callback routes need them. The signed HttpOnly cookie contains phase, raw state, connection ID, consent attempt ID, and identity-phase tenant hint; it is `SameSite=Lax`, secure in production, scoped to `/api/v1/m365/consent/callback`, and expires after ten minutes. Sign it with the first configured server cryptographic key from `APP_ENCRYPTION_KEY` or `SECRET_ENCRYPTION_KEY`, using a new domain-separation label; do not fall back to `JWT_SECRET`, enrollment secrets, or an implicit production default. Verify the MAC in constant time and reject malformed encodings/signature lengths before any state lookup.

Reject duplicate or unknown query keys, mixed success/error fields, missing state, malformed GUIDs, admin success other than exact `admin_consent=true`, and identity success other than exact `state` plus `code`. Provider `error_description` must never be logged, audited, persisted, or reflected. Validate the cookie before consuming the state. In identity phase, constant-time compare the hash of the cookie tenant hint to the session's `tenant_hint_hash` before calling the executor; on mismatch make no executor call or connection mutation. Clear the cookie on every terminal callback path.

Test exact Microsoft URL helpers: admin consent is `https://login.microsoftonline.com/common/adminconsent` with fixed client ID, redirect URI, and state; identity authorization is `https://login.microsoftonline.com/<canonical-tenant>/oauth2/v2.0/authorize` with `response_type=code`, `response_mode=query`, fixed `openid profile` scope, nonce, S256 PKCE challenge, state, client ID, and the exact same redirect URI.

Successful admin consent treats callback tenant as an untrusted hint, creates the PKCE/nonce identity phase, and redirects to Microsoft authorization. Successful identity callback calls the private executor, applies the attempt-aware result, and redirects to an allowlisted fragment:

```text
/integrations#m365/customer-graph-read/active
/integrations#m365/customer-graph-read/degraded
/integrations#m365/customer-graph-read/<one-of-the-typed-public-error-codes-above>
```

- [ ] **Step 2: Run and verify missing-router failures**

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/browserBinding.test.ts src/services/m365ControlPlane/microsoftAuthorization.test.ts src/routes/m365ConsentCallback.test.ts
```

- [ ] **Step 3: Implement and mount the public router before authenticated M365 routes**

Use `writeAuditEvent` only with safe IDs/outcomes. Never include state, code, cookie, nonce, verifier, admin object ID, raw vault reference, or provider description.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/browserBinding.test.ts src/services/m365ControlPlane/microsoftAuthorization.test.ts src/routes/m365ConsentCallback.test.ts
git add apps/api/src/services/m365ControlPlane/browserBinding.* apps/api/src/services/m365ControlPlane/microsoftAuthorization.* apps/api/src/routes/m365ConsentCallback.* apps/api/src/index.ts
git commit -m "feat(m365): complete verified consent callback"
```

## Task 12: Add authenticated management routes and legacy regressions

**Files:**

- Create: `apps/api/src/routes/m365CustomerGraphRead.ts`
- Create: `apps/api/src/routes/m365CustomerGraphRead.test.ts`
- Modify: `apps/api/src/routes/m365.ts`
- Modify: `apps/api/src/routes/m365.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts`
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.test.ts`
- Modify: `apps/api/src/services/m365DirectGraph.ts`
- Modify: `apps/api/src/services/m365DirectGraph.test.ts`
- Modify: `apps/api/src/routes/clientAi/adminOrgs.ts`
- Modify: `apps/api/src/routes/clientAi/adminOrgs.test.ts`

- [ ] **Step 1: Write failing route/auth/safety tests**

Add:

```text
GET  /m365/connections?orgId=...
POST /m365/connections/customer-graph-read/consent?orgId=...
POST /m365/connections/:id/retest
POST /m365/connections/:id/disconnect
```

List requires auth plus `ORGS_READ`; mutations require auth, `ORGS_WRITE`, MFA, and a concrete scoped organization. Apply `canManagePartnerWidePolicies(auth)` only when `auth.scope === 'partner'`; organization-scoped administrators remain valid. Test organization-scope success, selected partner-scope denial, authorized partner-scope success, and all-organizations rejection. Scope misses and ownership conflicts are non-oracular.

Define the exact read envelope so the card works before a row exists:

```ts
type CustomerGraphReadEnvelope = {
  profile: {
    id: 'customer-graph-read';
    displayName: string;
    manifestVersion: 2;
    requiredGrants: M365ApplicationGrant[];
  };
  onboardingEnabled: boolean;
  connection: CustomerGraphReadConnectionDto | null;
};
```

`onboardingEnabled` is derived for the resolved organization from both the global flag and org allowlist. A connection DTO contains observed/missing/unexpected assignments, timestamps, status, and safe last error, but never certificate/token/code/verifier/cookie/admin ID/raw vault ref.

Test that onboarding flag gates only new consent. Existing callback/list/retest/disconnect remain available. Narrow the existing router-wide `M365_ENABLED` check to the three singular legacy `/connection` endpoints; legacy routes still select only `legacy-direct`.

Add both exact `GET /api/v1/m365/consent/callback` and retest patterns to `SELF_MANAGED_DB_CONTEXT_ROUTES` so Microsoft/executor HTTP occurs outside any ambient request DB transaction. The callback and retest open only their explicitly scoped short transactions. Add null-tenant regression tests for `m365DirectGraph.ts` and `clientAi/adminOrgs.ts`.

- [ ] **Step 2: Run failing tests**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/routes/m365CustomerGraphRead.test.ts \
  src/routes/m365.test.ts \
  src/middleware/selfManagedDbContextRoutes.test.ts \
  src/services/m365DirectGraph.test.ts \
  src/routes/clientAi/adminOrgs.test.ts
```

- [ ] **Step 3: Implement routes and mounts**

The consent endpoint creates/replaces the pending attempt, creates its one-time session and cookie, then returns only a server-built Microsoft admin-consent URL. Audit through `writeRouteAudit` with safe identifiers.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/m365CustomerGraphRead.test.ts src/routes/m365.test.ts src/middleware/selfManagedDbContextRoutes.test.ts src/services/m365DirectGraph.test.ts src/routes/clientAi/adminOrgs.test.ts
git add apps/api/src/routes apps/api/src/index.ts apps/api/src/middleware/selfManagedDbContextRoutes.* apps/api/src/services/m365DirectGraph.ts
git commit -m "feat(m365): expose graph read connection management"
```

## Task 13: Add safe audit events and low-cardinality metrics

**Files:**

- Create: `apps/api/src/services/m365ControlPlane/metrics.ts`
- Create: `apps/api/src/services/m365ControlPlane/metrics.test.ts`
- Modify: `apps/api/src/routes/metrics.ts`
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.test.ts`
- Modify: `apps/api/src/routes/m365CustomerGraphRead.test.ts`
- Modify: `apps/api/src/routes/m365ConsentCallback.test.ts`

- [ ] **Step 1: Write failing audit and metric tests**

Require exactly:

```text
m365.customer_graph_read.consent_initiated
m365.customer_graph_read.admin_consent_returned
m365.customer_graph_read.tenant_binding_verified
m365.customer_graph_read.verification_failed
m365.customer_graph_read.grant_drift_detected
m365.customer_graph_read.retested
m365.customer_graph_read.disconnected
```

Allow details only from `orgId`, `connectionId`, `profile`, `consentAttemptId`, `manifestVersion`, `outcome`, `correlationId`, and verified tenant ID after signed proof. Add `breeze_m365_customer_graph_read_events_total{event,outcome}` with fixed enum labels.

- [ ] **Step 2: Run failing tests**

```bash
pnpm --filter @breeze/api exec vitest run \
  src/services/m365ControlPlane/metrics.test.ts \
  src/services/m365ControlPlane/connectionService.test.ts \
  src/routes/m365CustomerGraphRead.test.ts \
  src/routes/m365ConsentCallback.test.ts
```

- [ ] **Step 3: Implement a thin recorder without importing routes into services**

Audit-payload tests must prove state, cookies, authorization code, nonce/verifier, executor auth, tokens, certificates, raw vault locators, admin ID, and Microsoft descriptions are absent.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/api exec vitest run src/services/m365ControlPlane/metrics.test.ts src/services/m365ControlPlane/connectionService.test.ts src/routes/m365CustomerGraphRead.test.ts src/routes/m365ConsentCallback.test.ts
git add apps/api/src/services/m365ControlPlane apps/api/src/routes/metrics.ts apps/api/src/routes/m365CustomerGraphRead.test.ts apps/api/src/routes/m365ConsentCallback.test.ts
git commit -m "feat(m365): audit graph read consent lifecycle"
```

## Task 14: Build the customer Graph read integration card

**Files:**

- Create: `apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx`
- Create: `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx`
- Modify: `apps/web/src/locales/en/integrations.json`
- Modify: `apps/web/src/locales/de-DE/integrations.json`
- Modify: `apps/web/src/locales/es-419/integrations.json`
- Modify: `apps/web/src/locales/fr-FR/integrations.json`
- Modify: `apps/web/src/locales/pt-BR/integrations.json`

- [ ] **Step 1: Write failing DTO, lifecycle, and mutation tests**

Test the exact profile envelope with `connection: null`: display the exact nine permissions and per-org onboarding availability with no tenant/client/secret/certificate/vault inputs. Strictly parse and table-test `pending-consent`, `verifying`, `active`, `degraded`, `suspended`, and `revoked`. Unknown or malformed DTOs fail closed. Show tenant name/GUID, manifest version, required/observed/missing/unexpected grants, `grantsVerifiedAt`, `lastVerifiedAt`, and localized copy for only the typed stable codes—never render a raw code. If reconciliation was unavailable, label observations as last-known rather than current.

Test:

- Consent POSTs `/m365/connections/customer-graph-read/consent` and navigates only to the returned Microsoft URL.
- Retest POSTs `/m365/connections/:id/retest`, then reloads.
- Disconnect confirms that tenant-wide Microsoft consent remains, POSTs `/disconnect`, then reloads.
- Every mutation uses `runAction`, prevents duplicate clicks, and is disabled without `organizations:write`.
- Unexpected grants have prominent accessible text; status is not communicated by color alone.
- Switching mounted state from Org A to Org B immediately clears Org A metadata before reloading. Subscribe to `useOrgStore((s) => s.currentOrgId)` and use `getJwtClaims().orgId` only as the concrete-org fallback for organization-scoped sessions.
- All required `m365CustomerGraphRead` translation keys exist with genuinely localized strings in every supported locale before this task becomes green.

- [ ] **Step 2: Run the failing card tests**

```bash
pnpm --filter @breeze/web exec vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
```

- [ ] **Step 3: Implement the strict card using `fetchWithAuth`, `runAction`, `formatDateTime`, and trusted docs links**

Do not build consent URLs in the browser. Do not treat client permissions as authoritative. Do not allow partner-wide mode without a selected organization.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/web exec vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
git add apps/web/src/components/integrations/M365CustomerGraphReadCard.* apps/web/src/locales
git commit -m "feat(m365): add graph read connection card"
```

## Task 15: Integrate hash callback results and legacy coexistence

**Files:**

- Modify: `apps/web/src/components/integrations/IntegrationsPage.tsx`
- Modify: `apps/web/src/components/integrations/IntegrationsPage.test.tsx`
- Modify: `apps/web/src/components/integrations/M365Integration.tsx`
- Modify: `apps/web/src/components/integrations/M365Integration.test.tsx`
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx`
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.test.tsx`

- [ ] **Step 1: Write failing coexistence, fragment-consumption, and locale tests**

`#m365` renders both the legacy `M365Integration` card and the new sibling card. Add a coexistence matrix for legacy-off/new-on, legacy-on/new-off, both-on, and both-off; when legacy is disabled, scope its copy to “Legacy direct connection” so it does not contradict an enabled Graph-read card. Preserve its endpoints and credential fields.

Extend `parseHash` so `#m365/customer-graph-read/<result>` still selects the M365 tab. On initial load and `hashchange`, capture an allowlisted result into React state before calling `history.replaceState`; then refresh the API and normalize to `#m365`. Unknown values render nothing but are still normalized. Test direct-load active/error, every typed result, unknown result, back/forward hash changes, preservation of pathname/search, and absence of raw provider text, codes, tokens, or tenant hints.

- [ ] **Step 2: Run failing component and hash-integration tests**

```bash
pnpm --filter @breeze/web exec vitest run \
  src/components/integrations/M365CustomerGraphReadCard.test.tsx \
  src/components/integrations/M365Integration.test.tsx \
  src/components/integrations/IntegrationsPage.test.tsx
```

- [ ] **Step 3: Implement sibling rendering, fragment normalization, and scoped legacy copy**

Do not alter the legacy card's `/m365/connection` calls or existing `M365_ENABLED` behavior beyond clarifying its disabled label.

- [ ] **Step 4: Test and commit**

```bash
pnpm --filter @breeze/web exec vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx src/components/integrations/M365Integration.test.tsx src/components/integrations/IntegrationsPage.test.tsx
git add apps/web/src/components/integrations
git commit -m "feat(m365): integrate graph read consent status"
```

## Task 16: Package, deploy, and harden the private executor

**Files:**

- Create: `apps/m365-graph-read-executor/Dockerfile`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/security.yml`
- Modify: `scripts/security/check-supply-chain-hardening.sh`
- Modify: `deploy/docker-compose.prod.yml`
- Modify: `docker-compose.yml`
- Modify: `deploy/.env.example`
- Create: `deploy/compose-config-test.env`
- Modify: `.env.example`

- [ ] **Step 1: Write/update failing workflow and supply-chain contract tests**

Require executor unit-test/build jobs in `ci-success`, a separately tagged immutable/digest-addressable executor image in release, image scanning, and supply-chain checks. The executor image runs non-root with read-only filesystem, dropped capabilities, `no-new-privileges`, and tmpfs where required.

Do not add an executor service to the existing generic Compose deployment: it defines no managed/workload-identity source, and an egress-blocking internal network would prevent Key Vault, Microsoft identity, and Graph access. Compose changes expose only disabled-by-default API descriptor variables and the path of a separately mounted signing-key Docker secret. Deploy the executor image on an identity-capable environment with private ingress and controlled HTTPS egress; the API reaches it over private HTTPS. No plaintext production transport is supported. Keep public proxy/tunnel ingress off the executor.

- [ ] **Step 2: Run the current checks and verify missing executor coverage**

```bash
bash scripts/security/check-supply-chain-hardening.sh
docker compose --env-file deploy/compose-config-test.env -f deploy/docker-compose.prod.yml config
```

- [ ] **Step 3: Implement the image, workflows, optional API env contract, and secret-file loading**

Keep self-host onboarding optional/dark and do not make existing deployments require the executor image or configuration. Add a checked non-secret `deploy/compose-config-test.env` fixture containing only syntactically valid placeholders so Compose validation is reproducible. Do not commit internal hostnames, vault names, tenant IDs, credentials, or infrastructure topology beyond generic deployment requirements.

- [ ] **Step 4: Build and verify**

```bash
docker build -f apps/m365-graph-read-executor/Dockerfile -t breeze-m365-graph-read-executor:test .
bash scripts/security/check-supply-chain-hardening.sh
docker compose --env-file deploy/compose-config-test.env -f deploy/docker-compose.prod.yml config
```

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/Dockerfile .github/workflows scripts/security/check-supply-chain-hardening.sh deploy docker-compose.yml .env.example
git commit -m "build(m365): ship isolated graph read executor"
```

## Task 17: Document operations and real-tenant acceptance

**Files:**

- Modify: `apps/docs/src/content/docs/features/identity-integrations.mdx`
- Create: `docs/deploy/m365-customer-graph-read-executor.md`
- Create: `docs/runbooks/m365-customer-graph-read-real-tenant.md`
- Modify: `docs/testing/e2e-coverage-index.md`

- [ ] **Step 1: Write the operational and user documentation**

Document separate Customer Graph Read and legacy-direct methods, exact permissions, local disconnect versus removing Entra consent, certificate version pinning/rotation, dedicated Key Vault identity, private ingress, dark deployment, health/rollback procedure, and the public docs anchor `#remove-customer-graph-read-consent`.

The real-tenant checklist uses a disposable non-production tenant, two Breeze orgs, eligible and ineligible admins, captures the exact Microsoft consent screen permission copy, and records expected state/error/evidence after:

1. Successful consent and tenant binding.
2. Replay of both callback phases.
3. Expired attempt.
4. Ineligible administrator.
5. Cross-org duplicate tenant/profile binding.
6. Missing normal permission (remove one other than `Application.Read.All`).
7. `Application.Read.All` removal causing reconciliation-unavailable/last-known behavior.
8. Unexpected permission drift.
9. Re-consent restoring degraded to active.
10. Removing Microsoft tenant consent and detecting it specifically through Retest.
11. Executor outage/recovery and active-row preservation.
12. Local disconnect and delayed-result rejection.
13. Separate Microsoft consent removal instructions and cleanup.

Include cleanup and explicit checks that tokens, private keys, codes, verifier/nonces, and raw vault locators do not appear in browser state, API responses, DB rows, audit payloads, or logs.

- [ ] **Step 2: Build docs and verify the coverage link**

```bash
pnpm --filter @breeze/docs build
rg -n "m365-customer-graph-read-real-tenant" docs/testing/e2e-coverage-index.md
rg -n 'id="remove-customer-graph-read-consent"' apps/docs/dist
```

- [ ] **Step 3: Commit**

```bash
git add apps/docs/src/content/docs/features/identity-integrations.mdx docs/deploy docs/runbooks docs/testing/e2e-coverage-index.md
git commit -m "docs(m365): add graph read consent runbooks"
```

## Task 18: Full verification, security review, and PR readiness

**Files:** No new production files; fix only failures attributable to this phase and commit each fix separately.

- [ ] **Step 1: Run focused unit and route suites**

```bash
pnpm --filter @breeze/shared exec vitest run src/m365/profiles.test.ts src/m365/executorContracts.test.ts
pnpm --filter @breeze/m365-graph-read-executor exec vitest run
pnpm --filter @breeze/api exec vitest run \
  src/db/migration-m365-customer-graph-read-consent.test.ts \
  src/db/schema/m365.test.ts \
  src/services/m365ControlPlane/profiles.test.ts \
  src/services/m365ControlPlane/runtimeConfig.test.ts \
  src/services/m365ControlPlane/consentSessionService.test.ts \
  src/services/m365ControlPlane/browserBinding.test.ts \
  src/services/m365ControlPlane/microsoftAuthorization.test.ts \
  src/services/m365ControlPlane/connectionService.test.ts \
  src/services/m365ControlPlane/graphReadExecutorClient.test.ts \
  src/services/m365ControlPlane/metrics.test.ts \
  src/routes/m365CustomerGraphRead.test.ts \
  src/routes/m365ConsentCallback.test.ts \
  src/routes/m365.test.ts \
  src/middleware/selfManagedDbContextRoutes.test.ts \
  src/services/m365DirectGraph.test.ts \
  src/routes/clientAi/adminOrgs.test.ts
pnpm --filter @breeze/web exec vitest run \
  src/components/integrations/M365CustomerGraphReadCard.test.tsx \
  src/components/integrations/M365Integration.test.tsx \
  src/components/integrations/IntegrationsPage.test.tsx
```

- [ ] **Step 2: Run real-role integration tests**

```bash
pnpm --filter @breeze/api test:docker:up
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/m365ConnectionsRls.integration.test.ts \
  src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts
pnpm --filter @breeze/api test:docker:down
```

- [ ] **Step 3: Run package regression, lint, build, migration, docs, and supply-chain checks**

```bash
pnpm --filter @breeze/shared exec vitest run
pnpm --filter @breeze/m365-graph-read-executor exec vitest run
pnpm --filter @breeze/m365-graph-read-executor lint
pnpm --filter @breeze/m365-graph-read-executor build
pnpm --filter @breeze/api exec vitest run
pnpm --filter @breeze/api lint
pnpm --filter @breeze/api build
pnpm --filter @breeze/api check:migrations
pnpm --filter @breeze/web exec vitest run
pnpm --filter @breeze/web lint
pnpm --filter @breeze/web build
pnpm --filter @breeze/docs build
bash scripts/security/check-supply-chain-hardening.sh
docker build -f apps/m365-graph-read-executor/Dockerfile -t breeze-m365-graph-read-executor:test .
docker compose --env-file deploy/compose-config-test.env -f deploy/docker-compose.prod.yml config
```

- [ ] **Step 4: Run database drift checks with the repository-required database configuration**

```bash
pnpm db:check-drift
```

- [ ] **Step 5: Apply the `requesting-code-review`, `security-review`, and `verification-before-completion` skills**

Review specifically for tenant/organization authorization, callback replay, cookie/state ordering, CAS races, last-known grant semantics, Graph next-link SSRF, raw provider data leakage, credential-package isolation, internal JWT verification, and public executor exposure. Address actionable findings with tests before implementation changes.

- [ ] **Step 6: Confirm branch scope and commit any verified follow-ups**

```bash
git status --short
git diff --check
git log --oneline ecf459745153762cedbea601b3a30cef21780cc1..HEAD
```

Do not stage generated `.githooks/*` files. Do not remove Delegant in this phase; that remains a later migration after consumers use Breeze-owned tools.
