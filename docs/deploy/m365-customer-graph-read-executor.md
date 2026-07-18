# M365 Customer Graph Read executor deployment

This runbook deploys the isolated `@breeze/m365-graph-read-executor` and enables the Breeze **Customer Graph Read** consent flow. It does not configure the legacy direct M365 connection. The executor owns the reusable Microsoft application certificate and app-only Graph tokens; the browser, general API, web app, database, and audit pipeline must never receive them.

## Scope and trust boundary

Customer Graph Read uses one dedicated multitenant Entra application, the fixed `customer-graph-read` profile, certificate client authentication, and manifest version 2. It is separate from:

- the legacy direct M365 connector, where each Breeze organization supplies a tenant ID, client ID, and encrypted client secret;
- user-owned delegated mail and Teams communications;
- future Graph mutation and Exchange PowerShell executors.

Only the executor deployment receives Key Vault data-plane access. The Breeze API owns authorization, organization mapping, consent sessions, lifecycle, and audit. It calls only the private executor operations `POST /v1/complete-consent`, `POST /v1/retest`, and `POST /v1/read-action`. `GET /healthz` is the executor's process health endpoint; it does not prove Key Vault or Microsoft Graph access.

`POST /v1/read-action` executes one typed Microsoft Graph read (the twelve actions behind the `m365_query_*` AI tools) and uses the same internal EdDSA request authentication as the other two operations — no separate trust boundary. It is additive, so deploy order is safe in either direction: an executor deployed before this operation exists returns a plain `404` for the route, and the API's executor client treats that the same as any other unreachable/unhealthy executor, surfacing the existing `executor_unavailable` outcome rather than failing insecurely or leaking a raw transport error.

## Release and migration gate

Do not apply the Phase 2 migration until every API instance is running the M365 control-plane foundation release from PR #2495, at or after commit `ecf459745153762cedbea601b3a30cef21780cc1`. Database state cannot prove that an old API writer is gone.

Deploy in this order:

1. Deploy the foundation release to every API instance and verify the running revision on each instance.
2. Provision the dedicated Entra application, certificate, Key Vault version, executor identity, private ingress, and controlled egress.
3. Deploy the executor dark by exact image digest and verify `/healthz` plus identity, Key Vault, and Microsoft connectivity from a non-customer test path.
4. Apply `apps/api/migrations/2026-07-14-m365-customer-graph-read-consent.sql`, then deploy the Phase 2 API and UI with onboarding disabled.
5. Verify the fixed application/configuration descriptors agree in the API and executor.
6. Enable only a disposable internal Breeze organization and complete the [real-tenant checklist](../runbooks/m365-customer-graph-read-real-tenant.md).
7. Expand the organization allowlist gradually. Use `*` only after the limited rollout is accepted.

The migration deliberately aborts on incompatible M365 rows, noncanonical observed grants, or duplicate verified tenant/profile ownership. Resolve the reported data; do not bypass or rewrite the preflight.

## Entra application and permission manifest

Create one dedicated multitenant application for Customer Graph Read. Register the exact public callback URI derived by the API: the selected public origin followed by `/api/v1/m365/consent/callback`. Do not reuse an application used for mutations, PowerShell, delegated communications, or legacy direct connections.

Configure only these Microsoft Graph **application** permissions and grant customer-admin consent through Breeze:

| Permission | App role ID |
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

All nine roles belong to the Microsoft Graph resource application `00000003-0000-0000-c000-000000000000`. The shared code manifest is authoritative. `Application.Read.All` is required for authoritative app-role-assignment reconciliation; it is not exposed as a general application-directory query tool.

## Key Vault and certificate ownership

Use a dedicated vault where practical and a dedicated managed identity or workload identity for this executor. Grant that identity only the Key Vault secret-read capability required for the `m365-customer-graph-read` secret. Do not grant the Breeze API/web identity, CI jobs, general workers, Hive, or database access to the vault.

Each credential is an immutable Key Vault secret version. The version must be exactly 32 lowercase hexadecimal characters. Its value is a strict JSON envelope with:

- `schemaVersion` equal to `1`;
- `domain` equal to `customer-graph-read`;
- `material.kind` equal to `certificate`;
- non-empty `material.certificatePem` and `material.privateKeyPem` strings;
- no additional fields and no stored thumbprint.

The executor derives the Microsoft `x5t` from the certificate. Keep the certificate and private key out of deployment manifests, command history, tickets, examples, and logs.

The fixed reference has the form `akv://<vault-host>/m365-customer-graph-read/<32-lowercase-hex-version>`. `M365_CUSTOMER_GRAPH_READ_VAULT_REF`, `M365_CUSTOMER_GRAPH_READ_VAULT_URL`, and `M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION` must identify the same host and version.

### Certificate rotation

Automated certificate rotation and an operator rotation UI are not part of this release. Do not replace a pinned Key Vault version in place.

For a planned rotation:

1. Add the new public certificate to the same dedicated Entra application before changing Breeze.
2. Create a new immutable Key Vault secret version and validate its strict envelope without printing the value.
3. Build and scan the intended executor release, then deploy it by exact digest to a dark/canary executor with the new version-pinned descriptor.
4. Update the API's matching vault reference and credential version while onboarding remains disabled, then restart all API instances so configuration is consistent.
5. Re-enable only the internal canary organization, start a fresh consent attempt so its connection records the new pinned version, and run consent/retest acceptance.
6. Move remaining organizations through fresh re-consent before retiring the old Entra certificate or vault version.
7. Retain the old version through the rollback window. Remove it only after inventory proves that no connection or rollback deployment depends on it.

Treat rotation as a controlled migration. Do not assume a mutable alias, a changed “current” secret, or a normal Retest updates a connection's stored credential version.

## Runtime configuration

Use deployment secret mounts or the platform secret store. Do not put private JWKs or certificate material in images or source-controlled environment files.

### Breeze API

| Name | Required value/constraint |
|---|---|
| `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED` | `false` for dark deployment; enable only with an allowlist. |
| `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS` | Canonical lowercase Breeze organization UUIDs separated by commas, or literal `*`. Required when onboarding is enabled. |
| `M365_CUSTOMER_GRAPH_READ_CLIENT_ID` | Canonical lowercase Entra application/client GUID. |
| `M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION` | Exact 32-character lowercase hex Key Vault version. |
| `M365_CUSTOMER_GRAPH_READ_VAULT_REF` | Exact version-pinned `akv://` reference described above. This locator is sensitive operational metadata even though it is not credential material. |
| `M365_GRAPH_READ_EXECUTOR_URL` | Origin-only private HTTPS URL; no path, query, fragment, or embedded credentials. |
| `M365_GRAPH_READ_EXECUTOR_AUDIENCE` | Exactly `m365-graph-read-executor`. |
| `M365_GRAPH_READ_EXECUTOR_SIGNING_KID` | Key ID shared with the executor's public verification JWK. |
| `M365_GRAPH_READ_EXECUTOR_SIGNING_PRIVATE_JWK_FILE` | Absolute path to the API's Ed25519 private signing JWK. The regular file must deny group/other access (`0600` or stricter) and must not be a symlink. |
| `M365_GRAPH_READ_TOOLS_ENABLED` | `false` for dark deployment. Independently gates the six `m365_query_*` AI tools (`POST /v1/read-action`); it is not coupled to `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED` — enabling one does not enable the other. Enabling this flag also forces full validation of the executor configuration rows above at boot, even if onboarding itself stays disabled. |
| `M365_GRAPH_READ_TOOLS_ORG_IDS` | Canonical lowercase Breeze organization UUIDs separated by commas, or literal `*`. Required when the tools flag is enabled — boot refuses to start otherwise. Expand gradually; use `*` only after the limited rollout is accepted, matching the onboarding allowlist's rollout discipline. |

The callback origin is selected in this precedence order: `PUBLIC_URL`, `PUBLIC_APP_URL`, then `PUBLIC_API_URL`. Production requires one of them. The API appends `/api/v1/m365/consent/callback`; configure the resulting exact URI in Entra and as the executor callback URI.

### Executor

| Name | Required value/constraint |
|---|---|
| `M365_CUSTOMER_GRAPH_READ_CLIENT_ID` | Same canonical client GUID as the API. |
| `M365_CUSTOMER_GRAPH_READ_CALLBACK_URL` | Exact public HTTPS callback URI ending `/api/v1/m365/consent/callback`. |
| `M365_CUSTOMER_GRAPH_READ_VAULT_URL` | Exact HTTPS Key Vault origin. |
| `M365_CUSTOMER_GRAPH_READ_VAULT_REF` | Same version-pinned reference as the API. |
| `M365_CUSTOMER_GRAPH_READ_CREDENTIAL_VERSION` | Same 32-character lowercase hex version as the API. |
| `M365_GRAPH_READ_EXECUTOR_SIGNING_PUBLIC_JWK` | Strict Ed25519 public verification JWK; never the private signing JWK. |
| `M365_GRAPH_READ_EXECUTOR_SIGNING_KID` | Must match the public JWK and API signing key ID. |
| `M365_GRAPH_READ_EXECUTOR_ISSUER` | Exactly `breeze-api`. |
| `M365_GRAPH_READ_EXECUTOR_AUDIENCE` | Exactly `m365-graph-read-executor`. |
| `M365_GRAPH_READ_EXECUTOR_AZURE_CREDENTIAL_MODE` | `managed-identity` or `workload-identity`; there is no default/CLI credential fallback. |
| `M365_GRAPH_READ_EXECUTOR_BIND_HOST` | A private RFC1918 IPv4 or unique-local IPv6 interface, not a hostname or public/loopback address. |
| `M365_GRAPH_READ_EXECUTOR_PORT` | Integer from 1 through 65535. |

Managed identity may use `AZURE_CLIENT_ID` to select a user-assigned identity. Workload identity requires `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_FEDERATED_TOKEN_FILE`.

### Secret ownership matrix

| Material | Owner/readers | Must not appear in |
|---|---|---|
| Entra certificate + private key | Versioned Key Vault secret; executor identity only | API/web environment, DB, browser, audit, logs, image layers |
| Microsoft authorization code, PKCE verifier, nonce, ID/app tokens | One bounded consent/executor operation; hashed or one-time session fields where designed | API responses, audit payloads, logs, connection rows |
| API-to-executor private Ed25519 JWK | API secret mount only | Executor, DB, browser, logs, image layers |
| API-to-executor public Ed25519 JWK | Executor configuration | Browser/API responses and customer-visible data |
| Version-pinned vault locator | API/executor configuration and connection metadata | Browser responses, audit payloads, logs |

## Network policy

Place the executor behind private authenticated HTTPS ingress. Only Breeze API workloads may reach its ingress; do not publish it through the Breeze public router or a public load balancer. The process itself binds only to the configured private interface, so terminate TLS or enforce workload identity at the private ingress without broadening reachability.

Allow controlled HTTPS egress only for the configured Key Vault host, Microsoft identity endpoints needed for token/JWKS validation, and `graph.microsoft.com`. If managed identity is used, allow only the platform identity endpoint it requires; if workload identity is used, mount the federation token read-only. Deny arbitrary Graph hosts, customer-supplied URLs, generic internet egress, and inbound access from web, worker, agent, or user networks.

The executor has no general Graph proxy. It fixes the Microsoft tenant token endpoint, `https://graph.microsoft.com/.default`, the organization probe, profile service-principal lookup, app-role assignments, and referenced resource service principals.

## Control-plane routes and lifecycle

The narrow Breeze route templates are:

- `GET /m365/connections?orgId=...`
- `POST /m365/connections/customer-graph-read/consent?orgId=...`
- public `GET /m365/consent/callback`
- `POST /m365/connections/:id/retest?orgId=...`
- `POST /m365/connections/:id/disconnect?orgId=...`

The API mounts the callback at `/api/v1/m365/consent/callback`. Authenticated reads require organization read permission. Mutations require organization write permission, current MFA, concrete organization scope, and the partner-wide management guard when applicable. Normal list/consent/retest/disconnect success is HTTP 200; malformed organization queries are 400, denied partner-wide management is 403, and disabled onboarding, scope misses, ownership conflicts, revoked/non-executable rows, and stale attempts are deliberately non-oracular 404 responses where applicable.

Connection statuses are exactly `pending-consent`, `verifying`, `active`, `degraded`, `suspended`, and `revoked`. Stable failure/outcome codes exposed by this slice are `consent_expired`, `consent_state_mismatch`, `consent_cancelled`, `admin_role_required`, `tenant_mismatch`, `tenant_already_bound`, `credential_unavailable`, `identity_token_invalid`, `application_token_invalid`, `grant_reconciliation_unavailable`, `grant_missing`, `grant_unexpected`, `manifest_stale`, `organization_probe_failed`, and `executor_unavailable`.

## Exact-digest deployment

Release automation builds the executor image, pushes an unadvertised digest, scans that exact digest for high/critical vulnerabilities, promotes the already-scanned manifest, and uploads `m365-graph-read-executor-image-digest.txt` for 90 days.

Deploy the repository plus the recorded `sha256` digest, not a mutable version or `latest` tag. Record the release tag, Git commit, digest, environment, certificate version, and deployment time in the change ticket. Before promotion and rollback, verify the runtime reports the intended image digest through the platform's workload metadata; do not print runtime secrets.

## Health, rollout, and rollback

### Dark and canary checks

1. Keep `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED=false` and confirm the legacy M365 card/routes still work.
2. Confirm the executor process is healthy at private `GET /healthz` and returns only `{"status":"ok"}`.
3. Confirm no public route reaches `/v1/complete-consent`, `/v1/retest`, or `/healthz`.
4. Confirm the executor identity can read only the pinned Key Vault secret version and API/general identities cannot.
5. Confirm controlled egress permits the fixed Microsoft/Key Vault dependencies and blocks an unrelated destination.
6. Enable one internal organization UUID, complete the real-tenant checklist, and watch `breeze_m365_customer_graph_read_events_total{event,outcome}` plus the seven fixed audit event names.

### Rollback

1. Disable new initiation first by setting `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ENABLED=false` on every API instance. Existing metadata remains visible; legacy direct is unaffected.
2. If the executor is unhealthy, remove it from service or restore the previous exact digest and matching pinned credential configuration. An executor outage during Retest records `executor_unavailable` while preserving the existing lifecycle status; it does not prove Microsoft consent was revoked.
3. Roll API/UI back only to the fully deployed foundation release. Do not roll back to a writer older than PR #2495.
4. Do not reverse the contract migration during an incident. Forward-fix it so legacy rows, connection state, and consent/audit evidence remain intact.
5. After recovery, run Retest on the canary. Confirm status, `last_error_code`, `last_verified_at`, `grants_verified_at`, and observed grants before reopening onboarding.

If the credential version changed during the failed rollout, restore the API and executor as a matched pair. Do not delete either certificate version until rollback validation is complete.

## Operational signals

The Prometheus counter is `breeze_m365_customer_graph_read_events_total` with bounded `event` and `outcome` labels. Audit actions are exactly:

- `m365.customer_graph_read.consent_initiated`
- `m365.customer_graph_read.admin_consent_returned`
- `m365.customer_graph_read.tenant_binding_verified`
- `m365.customer_graph_read.verification_failed`
- `m365.customer_graph_read.grant_drift_detected`
- `m365.customer_graph_read.retested`
- `m365.customer_graph_read.disconnected`

A second, independent Prometheus counter, `breeze_m365_graph_read_actions_total{action,outcome}`, covers per-call typed Graph read outcomes (the `m365_query_*` AI tools going through `POST /v1/read-action`), not connection lifecycle events — it does not replace the counter above. Its matching audit action is `m365.customer_graph_read.action_executed`, with details limited to `actionType`, `outcome`, `itemCount`, and `truncated`; it never carries the read's Graph payload. Both counters are registered on the same `/metrics` route.

Use correlation IDs to join API and executor observations. Never add state, cookies, authorization codes, tokens, verifier/nonces, certificate data, raw provider bodies, or raw vault locators to metrics, audit, or logs.
