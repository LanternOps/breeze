# Breeze M365 Customer Graph Read Consent and Verification — Design Spec

**Date:** 2026-07-14

**Status:** Approved design

**Depends on:** PR #2495, `agent/m365-control-plane-foundation`, deployed at or after `ecf459745153762cedbea601b3a30cef21780cc1`

**Scope:** Deliver the first operational organization-owned M365 profile, `customer-graph-read`, with customer admin consent, verified tenant binding, exact grant reconciliation, health/retest behavior, and a minimal Breeze management UI.

## 1. Summary

Phase 2 proves the Breeze control-plane and narrow-executor architecture with one read-only vertical slice. An authorized Breeze administrator connects a customer organization to the dedicated multitenant `customer-graph-read` Entra application. Breeze owns the consent attempt, organization mapping, lifecycle, and audit. A private Graph-read executor owns the application certificate, performs Microsoft identity and token verification, reconciles the exact permission manifest, and returns only a bounded verification result.

The browser, Breeze database, Hive, and general Breeze API code never receive the reusable private certificate or an app-only Microsoft access token. The customer connection stores only public application metadata, an opaque version-pinned vault reference, verified tenant identity, observed grants, lifecycle state, and audit metadata.

This phase does not add M365 mutations, delegated communications, Exchange PowerShell, arbitrary Graph access, or action approvals. It establishes the safe connection that later read-only tools can consume.

## 2. Goals

- Onboard one customer Entra tenant per Breeze organization and `customer-graph-read` profile through administrator consent.
- Keep the profile's private certificate inside the Graph-read executor's credential domain.
- Bind a connection to an immutable Entra tenant GUID using signed Microsoft identity evidence, not callback query parameters.
- Verify the application's tenant and exact service-principal app-role assignments before marking a connection active.
- Detect missing, unexpected, or version-stale grants and expose them as actionable health state.
- Preserve the existing `legacy-direct` M365 connection and API during migration.
- Provide a small administrator UI for connect/re-consent, status, grant drift, retest, and local disconnect.
- Make callback replay, stale attempts, cross-organization access, and duplicate tenant ownership fail closed and auditable.

## 3. Non-goals

- `customer-graph-actions`, `customer-exchange-powershell`, or `communications-delegated` onboarding.
- M365 read tools or MCP catalog entries; those follow after the connection is trustworthy.
- Human approval execution flows; this slice creates no customer mutation capability.
- A general M365 administration console.
- Automatic Entra app registration or one certificate per customer.
- Bring-your-own application secrets for the new profile.
- Deleting the service principal or tenant-wide grant from Microsoft. Local disconnect revokes Breeze's use; the UI explains how a customer administrator can remove Microsoft consent.
- Certificate rotation UI or automated rotation. The connection remains version-pinned so rotation can be added safely later.
- Removing the legacy direct connection.

## 4. Locked decisions

| Area | Decision |
|---|---|
| Application identity | One dedicated multitenant Entra application for `customer-graph-read`, separate from future mutation and PowerShell applications. |
| Credential | Certificate-based client authentication. The private certificate is readable only by the private Graph-read executor. |
| Customer secret | No per-customer client secret. Customer administrators grant tenant-specific consent to the profile application. |
| Control plane | Breeze API owns authorization, consent sessions, organization mapping, lifecycle, and audit. |
| Executor | A private, allowlisted executor surface performs identity-code exchange, app-token acquisition, claim validation, grant reconciliation, and the organization probe. It never returns Microsoft tokens. |
| Tenant proof | The admin-consent callback's `tenant` value is a hint only. A second authorization-code flow with PKCE and nonce provides the signed tenant and administrator identity. |
| Admin role | Initial onboarding requires a signed `wids` claim containing Global Administrator or Privileged Role Administrator. This deliberately favors a clear, fail-closed rule for the Graph application permissions in this profile. |
| Grant source | Microsoft Graph's service-principal `appRoleAssignments` API is the authoritative observed grant set. A Microsoft Graph access token is used only as a bearer token to Graph, not decoded or validated by Breeze as an authorization artifact. |
| Active state | A connection is active only when tenant/application claims match and observed roles equal the code-owned manifest exactly. Missing or unexpected roles produce `degraded`. |
| Tenant ownership | For organization-owned non-legacy profiles, one `(tenant_id, profile)` can belong to only one Breeze organization. Different profiles may bind the same tenant. |
| Tenant immutability | A pending connection may move from no tenant to one verified GUID exactly once. A different tenant requires local disconnect and a fresh consent attempt. |
| Legacy compatibility | Existing `/m365/connection` routes continue to select only `legacy-direct`. |

## 5. Trust boundaries and flow

```text
Authorized Breeze admin browser
        |
        | POST initiate (authenticated, ORGS_WRITE, MFA)
        v
Breeze control plane
  - resolves the organization
  - creates pending connection + one-time consent session
  - sets signed HttpOnly browser binding
        |
        v
Microsoft admin-consent endpoint
        |
        | callback tenant is an unverified hint
        v
Breeze public callback
  - validates exact callback shape
  - validates browser binding
  - atomically consumes the one-time session
  - starts PKCE + nonce identity verification
        |
        v
Microsoft administrator sign-in
        |
        | authorization code
        v
Breeze public callback
  - validates/consumes second one-time session
        |
        | bounded internal verification request
        v
Private Graph-read executor
  - exchanges code using executor-owned certificate
  - validates ID token and administrator role
  - obtains an app-only Graph bearer token
  - reads exact service-principal app-role assignments
  - reconciles assignments with manifest
  - probes /organization
  - returns sanitized verification result, never tokens
        |
        v
Breeze control plane
  - compare-and-set binds verified tenant
  - records observed grants and lifecycle
  - writes audit event
        |
        v
Minimal M365 integration UI
```

### 5.1 Control-plane boundary

The control plane accepts only a Breeze organization ID resolved through the authenticated scope. It creates a connection for the fixed `customer-graph-read` profile from code-owned profile metadata. The browser cannot choose an application ID, credential domain, vault reference, permission list, executor, or authoritative tenant.

The public callback runs without a Breeze login because Microsoft redirects to it. Its authority comes only from a valid browser-bound state and a matching, unexpired, single-use database session. Callback data never selects a Breeze organization directly.

### 5.2 Executor boundary

The Graph-read executor exposes only bounded operations needed by this slice:

- complete administrator identity verification for a specific consent attempt;
- verify the configured `customer-graph-read` application against one tenant;
- retest an already-bound connection.

It rejects arbitrary tenant-independent token requests, arbitrary scopes, Graph URLs, HTTP methods, and permission manifests. The executor selects the application ID, credential domain, vault reference, version, Graph audience, and verification rules from its trusted profile configuration and the signed internal request.

Production transport is private and authenticated with workload identity or an equivalently short-lived service identity. It is not exposed through the public Breeze router. The executor returns a typed result containing tenant ID, administrator object ID, application ID, organization display name, observed roles, manifest version, verification timestamp, and a stable outcome code. It never returns authorization codes, ID tokens, app tokens, certificate material, or provider error bodies.

## 6. Credential model

The profile uses the foundation's `customer-graph-read` credential domain and version-pinned vault provider. A non-secret runtime descriptor supplies:

- expected Entra application/client ID;
- opaque vault reference;
- exact credential version;
- executor endpoint/audience;
- consent and callback configuration.

Only the Graph-read executor deployment receives Key Vault data-plane access. The general API and web deployments do not. The executor retrieves the pinned certificate version for each operation, uses it only to exchange or acquire short-lived tokens, and discards token/certificate buffers after the bounded operation.

All customer connections may reference the same profile credential version. This intentionally limits credential-management overhead while bounding compromise to the read-only application profile. Future action and PowerShell profiles use different applications, certificates, vault domains, and executor deployments.

Phase 2 bumps `customer-graph-read` to manifest version 2 and adds Microsoft Graph `Application.Read.All`. This permission is required to read the customer service principal's authoritative app-role assignments. It is broader than the runtime inventory probes alone require, so it is shown explicitly in consent copy and is confined by the executor's fixed operation allowlist. The application remains read-only, and later profiles must not reuse this credential.

## 7. Data model and contract migration

### 7.1 Deployment gate

The contract migration is safe only after the foundation API from PR #2495 is deployed everywhere, because that API explicitly writes all discriminators and targets `(org_id, profile)` for legacy upserts. Database state alone cannot prove which application version is still running. Release automation and the deployment runbook must therefore enforce this order:

1. merge and deploy PR #2495;
2. verify all API instances run the foundation release;
3. deploy the private executor dark and verify its health;
4. apply the Phase 2 contract migration and deploy the Phase 2 API/UI with onboarding disabled;
5. configure the profile application and pinned certificate version;
6. enable onboarding for an internal test organization, then expand rollout.

The migration itself still validates compatible row shape and aborts on duplicate `(org_id, profile)` or invalid discriminator data, but it cannot replace the application-version deployment gate.

### 7.2 `m365_connections` changes

The Phase 2 contract migration:

- drops `m365_connections_org_uniq`;
- preserves `m365_connections_org_profile_uniq` and `m365_connections_user_profile_uniq`;
- removes database defaults from `profile`, `auth_mode`, and `credential_domain` so every writer must choose them explicitly;
- makes `tenant_id` nullable for the pre-verification lifecycle;
- adds `consent_attempt_id UUID` for compare-and-set callback protection;
- adds `grants_verified_at` so a last-known observed set is distinguishable from a currently authoritative reconciliation;
- adds a partial unique index on `(tenant_id, profile)` for organization-owned, non-legacy connections with a verified tenant;
- preserves all existing `legacy-direct` rows and encrypted `client_secret` values;
- keeps lifecycle and collection defaults that are not ownership discriminators.

For `customer-graph-read` rows:

- `org_id` is required by service validation and RLS;
- `user_id` is null;
- `tenant_id` begins null and is set once after verification;
- `client_id`, `profile`, `auth_mode`, `credential_domain`, `vault_ref`, `credential_version`, and `permission_manifest_version` are explicitly populated from trusted profile configuration;
- `client_secret` is null;
- `observed_grants` contains sorted, unique permission values;
- `grants_verified_at` is set only after a complete authoritative app-role-assignment read;
- `consent_attempt_id` changes on every fresh consent attempt.

### 7.3 Consent sessions

A new service-only `m365_consent_sessions` table stores one-time consent state. It contains:

- hashed random state;
- phase: `admin_consent` or `identity_verification`;
- connection ID, organization ID, profile, consent-attempt ID, and initiating Breeze user ID;
- hashed tenant hint for the identity phase;
- nonce and PKCE verifier for the identity phase;
- creation and expiration timestamps.

Raw state is returned only to the initiating browser and is never stored. Consumption is an atomic delete-and-return operation constrained by state hash, phase, expiry, connection, and attempt ID. Expired rows are ignored and removed by normal cleanup. The table has no user-facing RLS policy; only explicit system-context service functions may access it.

## 8. Consent protocol

### 8.1 Initiation

An authenticated `ORGS_WRITE` administrator with current MFA initiates consent for an organization. Breeze also applies its existing partner-wide management guard where the caller is operating at partner scope.

The control plane:

1. resolves the organization through the caller's scope;
2. rejects a conflicting active connection or creates/restarts the profile connection with a new consent-attempt ID;
3. copies only trusted public profile metadata into the pending connection;
4. creates a ten-minute `admin_consent` session;
5. sets an HttpOnly, Secure-in-production, SameSite=Lax browser cookie containing an HMAC binding of phase, state, and attempt;
6. writes `m365.customer_graph_read.consent_initiated`;
7. returns Microsoft's admin-consent URL.

### 8.2 Admin-consent callback

The callback parser accepts exactly one of:

- a valid success shape containing `tenant` and `admin_consent=true`; or
- a provider-error shape containing no success fields.

Mixed or ambiguous shapes fail. Provider descriptions are not reflected to the browser or persisted as connection errors.

On success, the tenant GUID is normalized and retained only as a hint. Breeze creates a second ten-minute session containing a hash of that hint, nonce, and PKCE verifier; replaces the browser binding; and redirects to the authorization-code flow for administrator identity verification.

### 8.3 Identity callback and executor verification

The identity callback accepts only a code success shape or a provider-error shape. It validates the browser binding, consumes the matching identity session, and checks the hashed tenant hint before asking the executor to verify.

The executor:

1. exchanges the authorization code with the stored PKCE verifier and executor-owned certificate;
2. validates ID-token signature, issuer, audience, expiration/not-before, nonce, and canonical GUID claims;
3. requires the ID-token `tid` to equal the admin-consent tenant hint;
4. requires Global Administrator or Privileged Role Administrator in signed `wids`;
5. acquires an app-only Microsoft Graph bearer token from the verified tenant's exact token endpoint using the pinned certificate;
6. uses that token only against fixed Microsoft Graph endpoints; it does not decode or independently validate a Graph access token intended for Microsoft Graph;
7. calls `/organization?$select=id,displayName` and requires the returned organization ID to equal the signed ID-token `tid`;
8. resolves the customer service principal by the fixed profile application ID and reads its `appRoleAssignments`;
9. resolves each assignment's resource service principal and canonicalizes it to resource application ID, app-role ID, and human-readable value;
10. compares that complete assignment set with the exact code-owned `customer-graph-read` manifest version;
11. returns a sanitized result.

The control plane then performs a compare-and-set update constrained by connection ID, organization ID, profile, consent-attempt ID, and current pending/verifying state. It sets `tenant_id` only when null or already equal to the verified GUID. A unique-index or immutability conflict fails closed without changing ownership.

### 8.4 State outcome

- Exact grant equality plus a successful probe produces `active`.
- Valid tenant/application identity with missing, unexpected, or version-stale grants produces `degraded` and retains the verified binding so the UI can explain re-consent.
- Invalid identity, administrator role, token, tenant, application, or ownership proof leaves the connection non-active and records only a stable error code.
- Provider cancellation leaves the connection `pending-consent` or marks the attempt failed without binding a tenant; a new attempt is required.

## 9. Grant reconciliation and health

`M365_PERMISSION_PROFILES['customer-graph-read']` remains the only permission authority. The executor does not accept a browser- or API-supplied manifest.

Microsoft documents that access tokens are validated by the resource API for which they were issued; only Microsoft Graph can validate a Microsoft Graph access token. Breeze therefore does not treat decoded Graph token claims as proof of tenant or permissions. Token acquisition from the exact tenant endpoint plus the signed administrator ID token establishes the requested context; successful fixed Graph calls establish actual token usability; `/organization` establishes the tenant returned by Graph; and Graph's service-principal assignment API provides the authoritative grant inventory.

Relevant Microsoft contracts:

- [Microsoft Graph tokens are validated only by Microsoft Graph](https://learn.microsoft.com/en-us/troubleshoot/entra/entra-id/app-integration/troubleshooting-signature-validation-errors)
- [List app-role assignments granted to a service principal](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-list-approleassignments?view=graph-rest-1.0)
- [Only Privileged Role Administrator and Global Administrator can consent to Microsoft Graph application permissions](https://learn.microsoft.com/en-gb/graph/permissions-overview)

The manifest records each required assignment with its resource application ID, app-role ID, and display value. Phase 2 adds `Application.Read.All` and bumps the manifest version to 2 because Graph requires that permission to list a service principal's app-role assignments. The executor queries only:

- the profile application's service principal by its fixed client ID;
- that service principal's `appRoleAssignments` collection;
- the finite set of resource service principals referenced by those assignments; and
- the fixed organization probe.

It does not expose `Application.Read.All` as a general application-directory query surface.

For each verification it computes:

- `requiredGrants`: exact fully qualified app-role assignments from the current manifest;
- `observedGrants`: complete assignments returned for the customer service principal by Microsoft Graph;
- `missingGrants = required - observed`;
- `unexpectedGrants = observed - required`.

Both missing and unexpected grants degrade the connection. Unexpected grants are important because they detect a profile application or customer service principal that has accumulated broader access than Breeze's current design permits.

The database persists observed grants, current manifest version, `grants_verified_at`, `last_verified_at`, display name, status, and one stable `last_error_code`. Missing and unexpected sets are derived for responses from the last authoritative observed set and current manifest so they cannot become mutually inconsistent columns. If Graph denies or cannot complete the assignment query—for example, because `Application.Read.All` was removed—the executor does not overwrite the last-known observed set, does not advance `grants_verified_at`, and degrades the connection with `grant_reconciliation_unavailable`. The UI labels that retained set as last known rather than current.

Retest uses only an already-bound connection selected through the authenticated organization scope. The executor must acquire a token for that exact stored tenant and re-run the same validation and probe. Retest never accepts a tenant, client ID, vault reference, credential version, scopes, or Graph URL from the browser.

Recommended stable error codes for this slice are:

- `consent_expired`
- `consent_state_mismatch`
- `consent_cancelled`
- `admin_role_required`
- `tenant_mismatch`
- `tenant_already_bound`
- `credential_unavailable`
- `identity_token_invalid`
- `application_token_invalid`
- `grant_reconciliation_unavailable`
- `grant_missing`
- `grant_unexpected`
- `manifest_stale`
- `organization_probe_failed`
- `executor_unavailable`

## 10. Lifecycle

```text
not connected
      |
      | initiate
      v
pending-consent --admin success--> verifying
      ^                              |
      |                              +-- exact grants + probe --> active
      |                              |
      |                              +-- valid identity, drift --> degraded
      |                              |
      +--------- fresh consent ------+

active <------ successful retest/re-consent ------ degraded
  |                                                   |
  +---------------- local disconnect ----------------+
                          |
                          v
                       revoked

active/degraded/revoked --operator control--> suspended
```

Lifecycle updates use compare-and-set predicates over connection and consent-attempt identity so delayed callbacks and concurrent retests cannot overwrite a newer attempt. Local disconnect marks the connection `revoked`, clears any pending sessions, records `revoked_at`, and prevents token acquisition. It does not hard-delete the audit history or claim that Microsoft consent was removed.

## 11. API surface

The existing legacy routes remain unchanged:

- `GET /m365/connection`
- `POST /m365/connection`
- `DELETE /m365/connection`

New profile-specific routes are deliberately narrow:

- `GET /m365/connections?orgId=...` — list safe connection metadata and derived grant health for the caller's resolved organization.
- `POST /m365/connections/customer-graph-read/consent?orgId=...` — authenticated, `ORGS_WRITE`, MFA; create or restart consent and return the Microsoft URL.
- `GET /m365/consent/callback` — public Microsoft redirect target protected by browser-bound one-time state.
- `POST /m365/connections/:id/retest` — authenticated, `ORGS_WRITE`, MFA; retest only the scoped stored connection.
- `POST /m365/connections/:id/disconnect` — authenticated, `ORGS_WRITE`, MFA; locally revoke only the scoped stored connection.

Mutation routes use existing organization resolution and partner-wide management guards. Reads return no client secret, token, certificate, raw vault locator, nonce, verifier, provider error description, or administrator object ID. The safe response includes profile, display name, verified tenant ID, status, manifest version, observed/missing/unexpected grants, last verification time, and stable error code.

The callback route is registered as a self-managed database-context route because it has no authenticated Breeze request context. Its service functions establish explicit system context and always constrain database access by the consumed session's organization, connection, profile, and attempt ID.

## 12. Management UI

The existing M365 integrations page retains its legacy direct-connection card. It gains a separate **Customer Graph Read** card with:

- a concise explanation that the connection is read-only and uses customer administrator consent;
- the exact requested permission list from the API's code-owned profile metadata;
- Connect or Re-consent;
- status badge for pending, verifying, active, degraded, suspended, or revoked;
- verified tenant name and GUID;
- required, observed, missing, and unexpected grant groups;
- manifest version and last verification timestamp;
- Retest and Disconnect controls;
- callback outcome messaging using stable, localized result codes.

The UI never asks for a tenant ID, application ID, secret, certificate, scope, or vault reference for this profile. It cannot edit observed or required grants. It distinguishes local disconnect from removal of tenant-wide Microsoft consent and links to concise removal instructions.

## 13. Audit and observability

At minimum, the control plane emits:

- `m365.customer_graph_read.consent_initiated`
- `m365.customer_graph_read.admin_consent_returned`
- `m365.customer_graph_read.tenant_binding_verified`
- `m365.customer_graph_read.verification_failed`
- `m365.customer_graph_read.grant_drift_detected`
- `m365.customer_graph_read.retested`
- `m365.customer_graph_read.disconnected`

Events include Breeze organization, connection, profile, attempt ID, initiating/acting Breeze user where available, verified tenant only after proof, manifest version, outcome, and correlation ID. They never include state, cookie values, authorization codes, tokens, PKCE verifiers, nonces, certificate data, or raw Microsoft error bodies.

Metrics distinguish consent starts, successful verified bindings, callback validation failures, role failures, duplicate-tenant conflicts, executor availability, token verification failures, grant drift, and retest outcomes. Logs use stable codes and correlation IDs rather than customer secrets or provider payloads.

## 14. Failure and concurrency behavior

- Expired or replayed state returns a generic failure and cannot update a connection.
- A missing or mismatched browser cookie fails before consuming another organization's state.
- A stale attempt may be consumed but its compare-and-set update changes no connection; it is audited as stale.
- A second organization attempting to bind the same tenant/profile receives a generic ownership conflict. The response does not reveal the owning organization.
- Executor timeouts leave the connection retryable and non-active. The control plane never infers success from Microsoft redirect parameters.
- An active connection remains active during a manual retest until a completed authoritative result is recorded; transient executor unavailability records health telemetry without falsely revoking Microsoft consent.
- A completed token or probe result showing invalid consent or grant drift transitions active to degraded.
- Concurrent disconnect wins over a delayed callback or retest because revoked state and attempt identity are included in update predicates.

## 15. Verification strategy

### 15.1 Automated tests

- Contract migration tests prove the legacy index/default removal, nullable pre-verification tenant, new uniqueness constraint, and legacy-row preservation.
- Schema and RLS integration tests prove organization/profile isolation and service-only consent sessions.
- Consent-session tests cover randomness, hashed storage, expiry, one-time consumption, phase separation, and attempt binding.
- Callback route tests cover exact query shapes, signed cookie binding, state replay, mixed success/error parameters, tenant-hint hashing, stale attempts, and sanitized errors.
- Executor contract tests cover fixed profile selection, internal authentication, input rejection, and token-free responses.
- Identity tests cover issuer/audience/nonce/time validation, malformed GUID claims, mismatched `tid`, and eligible/ineligible `wids`.
- App-token tests prove Graph tokens remain opaque bearer values and are never logged or returned. Graph-assignment tests cover fixed endpoints, complete pagination, resource/app-role canonicalization, missing/unexpected assignments, reconciliation denial, and manifest changes.
- Service tests cover immutable binding, duplicate tenant/profile ownership, lifecycle compare-and-set behavior, retest, disconnect, and derived grant health.
- Route tests cover authentication, organization scope, permissions, MFA, partner-wide management guard, audit events, and absence of sensitive response fields.
- UI tests cover every lifecycle state, callback result, drift presentation, button authorization/disabled state, and retention of the legacy card.

Network calls, Microsoft keys, token responses, executor transport, Key Vault, time, and randomness are injected or intercepted at the narrowest boundary. Route tests do not depend on live Microsoft services.

### 15.2 Real-tenant verification

A documented non-production Microsoft tenant runbook verifies:

1. exact consent copy and requested permissions;
2. approved administrator-role behavior;
3. successful tenant and organization binding;
4. exact observed service-principal assignments and `/organization` probe;
5. removal of one permission causing degraded state;
6. re-consent restoring active state;
7. duplicate Breeze organization binding failing without information disclosure;
8. local disconnect preventing executor use;
9. removal of Microsoft consent being detected by retest;
10. absence of secrets and tokens from API/UI responses, logs, audit details, and database rows.

## 16. Rollout and rollback

Rollout is feature-flagged separately from the legacy `M365_ENABLED` behavior. The executor and callback may deploy dark before administrators can initiate consent.

Recommended sequence:

1. verify the foundation release is fully deployed;
2. provision the dedicated read-only Entra application, certificate, vault permissions, and callback URLs;
3. deploy the private executor and validate its workload identity and health;
4. apply the contract/session migration and deploy API/UI dark;
5. enable one internal test organization;
6. complete the real-tenant runbook and inspect audit/metrics;
7. expand to selected customer organizations;
8. enable generally after stable observation.

Rollback disables new consent initiation first. Existing active connections remain metadata-only and unusable when the executor is disabled. The Phase 2 API/UI can roll back to the deployed foundation version because the contract migration preserves legacy rows and the foundation writers already use explicit discriminators and `(org_id, profile)`. The database migration is not destructively reversed during an incident; forward remediation preserves consent/audit evidence.

## 17. Acceptance criteria

Phase 2 is complete when:

- an authorized administrator can connect a test customer tenant without entering or exposing a reusable secret;
- the private certificate and app-only token remain confined to the Graph-read executor;
- Breeze binds the organization only to the independently verified Microsoft `tid`;
- active status requires exact current-manifest grants and a successful fixed probe;
- missing, unexpected, stale, revoked, and unavailable conditions are visible and auditable;
- cross-organization access, duplicate tenant/profile binding, replay, stale callbacks, and tenant substitution fail closed;
- the minimal UI supports connect/re-consent, health/drift, retest, and local disconnect;
- the legacy direct connection continues to work unchanged;
- all automated tests pass and the real-tenant verification runbook is completed successfully.
