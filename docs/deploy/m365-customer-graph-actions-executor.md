# M365 Customer Graph Actions executor deployment

This runbook deploys the isolated `@breeze/m365-graph-actions-executor` and enables the Breeze **Customer Graph Actions** (Tier-3 mutation) path. It mirrors the [Customer Graph Read runbook](./m365-customer-graph-read-executor.md); read that first for the shared trust-boundary and identity model. This executor owns a **separate** reusable Microsoft application certificate and app-only Graph tokens with **write** scope; the browser, general API, web app, database, and audit pipeline must never receive them.

The actions executor is **execute-only**. It exposes exactly `POST /v1/execute-action` (behind the same internal EdDSA request authentication as the read executor) and `GET /healthz`. It performs no consent, no browser redirect, and no general Graph proxying.

## Scope and trust boundary

Customer Graph Actions uses one dedicated multitenant Entra application, the fixed `customer-graph-actions` profile (manifest version 1), certificate client authentication, and app-only (application-permission) tokens. It is **separate** from — and must not reuse the application, certificate, vault secret, or signing key of — the Customer Graph Read executor, the legacy direct M365 connector, delegated communications, or PowerShell.

Only the actions-executor deployment receives its vault's data-plane access. The Breeze API owns authorization, org→tenant mapping, the durable approval layer, lifecycle, and audit. It calls only the private operation `POST /v1/execute-action`. `GET /healthz` proves process health, not Key Vault or Microsoft Graph access.

A mutation only runs after Breeze's **durable approval layer** has approved the intent (see the action-intents design). The API resolves the customer tenant from the approved intent's `org_id`, fails closed on any mismatch, and passes the resolved `tenantId` to the executor per call. The executor never selects a tenant on its own.

## Multi-tenant model (how one certificate serves many customers)

There is **one** application and **one** certificate for all customers. Per-customer authority comes from Microsoft consent and tenant-scoped tokens, not from per-customer credentials:

1. **Executor Azure identity** (managed or workload identity) → reads the one shared certificate from Key Vault. Infra-level; unrelated to any customer.
2. **The shared Entra app** (identified by `M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID`, authenticated by the cert) → each customer org **admin-consents** it into their own tenant through Breeze, granting the application permissions below. Consent produces an `active` `customer-graph-actions` connection recording that org's `org_id`, `tenant_id`, `client_id`, and pinned `vault_ref`.
3. **A per-action token** → for each mutation the executor requests an app-only token at that customer's tenant endpoint, `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`. The token is valid only inside a tenant that consented the app.

Isolation is therefore enforced twice: Microsoft only mints a token for a tenant that consented the app, and Breeze independently gates on the RLS-protected `org_id → tenant_id` mapping, an active connection status, and a `wrong-org` fail-closed check before any call is made.

## Audit attribution in the customer tenant

Because mutations use **app-only** authentication (certificate client-credentials, application permissions), they are recorded in the customer's Microsoft 365 / Entra audit logs as performed **by the application's service principal** — the consented Customer Graph Actions app — **not** by a named MSP administrator. There is no per-user or per-MSP-tech attribution on the Microsoft side. The *who requested it, who approved it, and why* attribution lives only in **Breeze's** audit trail (the action-intents chain), joined to the Microsoft-side record by correlation ID. Communicate this to customers: in their logs these actions appear as the Breeze actions application acting on their directory, and the human accountability is retained in Breeze, not in Entra.

## Entra application and permission manifest

Create one dedicated multitenant application for Customer Graph Actions. Do not reuse the read application or any other. The authoritative manifest is the shared code profile `customer-graph-actions` (manifest version 1) in `packages/shared/src/m365/profiles.ts`; configure exactly these Microsoft Graph **application** permissions and grant customer-admin consent through Breeze:

| Permission | App role ID | Purpose |
|---|---|---|
| `User.ReadWrite.All` | `204e0828-b5ca-4ad8-b9f3-f32a958e7cc4` | Disable a user (`accountEnabled=false`); base for user mutations. |
| `User-PasswordProfile.ReadWrite.All` | `56760768-b641-451f-8906-e1b8ab31bca7` | Reset a user's password (`passwordProfile` with `forceChangePasswordNextSignIn`). |

Both belong to the Microsoft Graph resource application `00000003-0000-0000-c000-000000000000`. This is the **complete, exact** current manifest — `applicationPermissionAssignments` in `profiles.ts` carries exactly these two app-role GUIDs, and a real-tenant consent must reconcile to exactly these two grants, no more and no fewer (see the [real-tenant runbook](../runbooks/m365-customer-graph-actions-real-tenant.md)). The only mutations currently shipped are `m365.user.disable` (`m365_disable_user`, needs `User.ReadWrite.All`) and `m365.user.reset_password` (`m365_reset_password`, needs `User-PasswordProfile.ReadWrite.All`).

A **roadmap** of four additional scopes (`Group.ReadWrite.All`, `DeviceManagementManagedDevices.PrivilegedOperations.All`, `DeviceManagementConfiguration.ReadWrite.All`, `Sites.ReadWrite.All`) is recorded as commented-out entries in `profiles.ts` for the planned action catalog. Do **not** request customer-admin consent for any of them yet — each one needs its own manifest version bump, app-role GUID capture, and customer re-consent before its corresponding action ships. Consenting a scope Breeze cannot yet exercise only widens the mutation blast radius for no benefit.

## Key Vault and certificate ownership

Use a **dedicated** vault secret and a **dedicated** managed identity or workload identity for this executor, distinct from the read executor's. Grant that identity only the secret-read capability for the `m365-customer-graph-actions` secret. Do not grant the Breeze API/web identity, CI, general workers, Hive, the database, or the read executor's identity access to it.

Each credential is an immutable Key Vault secret version — exactly 32 lowercase hex characters. Its value is a strict JSON envelope with:

- `schemaVersion` equal to `1`;
- `domain` equal to `customer-graph-actions`;
- `material.kind` equal to `certificate`;
- non-empty `material.certificatePem` and `material.privateKeyPem` strings;
- no additional fields and no stored thumbprint.

The executor derives the Microsoft `x5t` from the certificate. Keep the certificate and private key out of manifests, command history, tickets, examples, and logs.

The fixed reference has the form `akv://<vault-host>/m365-customer-graph-actions/<32-lowercase-hex-version>`. `M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF`, `M365_CUSTOMER_GRAPH_ACTIONS_VAULT_URL`, and `M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION` must identify the same host and version.

### Certificate rotation

Automated rotation is not part of this release; do not replace a pinned version in place. Follow the same controlled-migration sequence as the read runbook (add the new cert to the same Entra app, create a new immutable Key Vault version, deploy a version-pinned dark/canary executor, update the API's matching reference while the tools flag stays disabled, restart API instances, re-consent the canary org, then move remaining orgs before retiring the old version).

## Runtime configuration

Use deployment secret mounts or the platform secret store. Do not put private JWKs or certificate material in images or source-controlled environment files.

### Breeze API

| Name | Required value/constraint |
|---|---|
| `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED` | `false` for dark deployment. Gates the org-facing "Customer Graph Actions" consent card (connect/retest/disconnect). Independent of `M365_GRAPH_ACTIONS_TOOLS_ENABLED` below — either flag alone forces full validation of the executor configuration rows below at boot (see [deploy gotchas](#deploy-gotchas)). |
| `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS` | Canonical lowercase Breeze org UUIDs, comma-separated, or literal `*`. **Required** when the onboarding flag is enabled — boot refuses otherwise. Expand gradually; use `*` only after limited rollout is accepted. |
| `M365_GRAPH_ACTIONS_TOOLS_ENABLED` | `false` for dark deployment. Gates the M365 Tier-3 action AI tools (`m365_disable_user`, `m365_reset_password`) and the durable action-intents release worker's headless dispatch. Enabling it forces full validation of the executor configuration rows below at boot, **and** requires `APP_ENCRYPTION_KEY_ID` (see [Reveal-path prerequisite](#reveal-path-prerequisite-temporary-passwords)). |
| `M365_GRAPH_ACTIONS_TOOLS_ORG_IDS` | Canonical lowercase Breeze org UUIDs, comma-separated, or literal `*`. **Required** when the tools flag is enabled — boot refuses otherwise. Expand gradually; use `*` only after limited rollout is accepted. |
| `M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID` | Canonical lowercase Entra application/client GUID (the actions app; not the read app). |
| `M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION` | Exact 32-character lowercase hex Key Vault version. |
| `M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF` | Exact version-pinned `akv://<host>/m365-customer-graph-actions/<version>` reference. Sensitive operational metadata even though it is not credential material. |
| `M365_GRAPH_ACTIONS_EXECUTOR_URL` | Origin-only private HTTPS URL; no path, query, fragment, or embedded credentials. |
| `M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE` | Exactly `m365-graph-actions-executor`. |
| `M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID` | Key ID shared with the executor's public verification JWK. |
| `M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE` | Absolute path to the API's Ed25519 private signing JWK. The regular file must deny group/other access (`0600` or stricter) and must not be a symlink. |

Unlike the read profile, the API has **no** `M365_CUSTOMER_GRAPH_ACTIONS_CALLBACK_URL` variable of its own: it derives the consent callback origin from whichever of `PUBLIC_URL`, `PUBLIC_APP_URL`, or `PUBLIC_API_URL` is set (first match wins), appends the fixed path `/api/v1/m365/actions-consent/callback`, and requires one of those three to be set in production. See [deploy gotcha (b)](#deploy-gotchas).

### Executor

| Name | Required value/constraint |
|---|---|
| `M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID` | Same canonical client GUID as the API. |
| `M365_CUSTOMER_GRAPH_ACTIONS_CALLBACK_URL` | Exact HTTPS consent callback URI: origin + path pinned to `/api/v1/m365/actions-consent/callback`, no query/fragment/credentials. **Must byte-match** the origin the API derived (`PUBLIC_URL`/`PUBLIC_APP_URL`/`PUBLIC_API_URL`) plus that same path — see [deploy gotcha (c)](#deploy-gotchas). |
| `M365_CUSTOMER_GRAPH_ACTIONS_VAULT_URL` | Exact HTTPS Key Vault origin. |
| `M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF` | Same version-pinned reference as the API. |
| `M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION` | Same 32-character lowercase hex version as the API. |
| `M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PUBLIC_JWK` | Strict Ed25519 **public** verification JWK; never the private signing JWK. |
| `M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID` | Must match the public JWK and the API signing key ID. |
| `M365_GRAPH_ACTIONS_EXECUTOR_ISSUER` | Exactly `breeze-api`. |
| `M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE` | Exactly `m365-graph-actions-executor`. |
| `M365_GRAPH_ACTIONS_EXECUTOR_AZURE_CREDENTIAL_MODE` | `managed-identity` or `workload-identity`; no default/CLI credential fallback. |
| `M365_GRAPH_ACTIONS_EXECUTOR_BIND_HOST` | A private RFC1918 IPv4 or unique-local IPv6 interface, not a hostname or public/loopback address. |
| `M365_GRAPH_ACTIONS_EXECUTOR_PORT` | Integer from 1 through 65535. |

Managed identity may use `AZURE_CLIENT_ID` to select a user-assigned identity. Workload identity requires `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_FEDERATED_TOKEN_FILE`.

### Reveal-path prerequisite (temporary passwords)

`m365.user.reset_password` returns a temporary password that Breeze seals at rest and reveals once through `POST /action-intents/:id/reveal-secret`. Sealing uses the Breeze API's own secret encryption (**not** Key Vault). It requires **both**:

| Name | Required value/constraint |
|---|---|
| `APP_ENCRYPTION_KEY` | Dedicated random secret-encryption key (already required in production). |
| `APP_ENCRYPTION_KEY_ID` | Key id enabling AAD-bound `enc:v3` ciphertext. **Without it, `encryptSecret` falls back to non-AAD `v1`, which the reset-password seal guard refuses — the credential is dropped fail-closed and can never be revealed.** |

Set both in `/opt/breeze/.env` **and** map them explicitly in the API service `environment:` block on every deployment (compose interpolation only happens for listed vars). This is separate from, and additional to, the Key Vault and executor configuration above. **Boot itself now enforces this**: `apps/api/src/config/validate.ts` refuses to start the API when `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true` and `APP_ENCRYPTION_KEY_ID` is unset or empty — this is not only a runtime seal-time failure, it is a boot-time configuration error. See [deploy gotcha (a)](#deploy-gotchas).

### Secret ownership matrix

| Material | Owner/readers | Must not appear in |
|---|---|---|
| Actions Entra certificate + private key | Versioned Key Vault secret; **actions**-executor identity only | API/web environment, DB, browser, audit, logs, image layers, the read executor |
| Per-tenant app-only Graph token | One bounded executor operation | API responses, audit payloads, logs, connection rows |
| API-to-executor private Ed25519 JWK | API secret mount only | Executor, DB, browser, logs, image layers |
| API-to-executor public Ed25519 JWK | Executor configuration | Browser/API responses and customer-visible data |
| Version-pinned vault locator | API/executor configuration and connection metadata | Browser responses, audit payloads, logs |
| Reset-password temporary credential | Sealed (`APP_ENCRYPTION_KEY`) in `action_intents.result`; revealed once to the requester | Audit details, metrics, logs, error bodies |

## Network policy

Place the executor behind private authenticated HTTPS ingress. Only Breeze API workloads may reach it; do not publish it through the public router or a public load balancer. The process binds only to the configured private interface.

Allow controlled HTTPS egress only for the configured Key Vault host, the Microsoft identity endpoints needed for token acquisition, and `graph.microsoft.com`. If managed identity is used, allow only the platform identity endpoint it requires; if workload identity is used, mount the federation token read-only. Deny arbitrary Graph hosts, customer-supplied URLs, generic internet egress, and inbound access from web, worker, agent, or user networks.

The executor has no general Graph proxy: it fixes the per-tenant token endpoint, `https://graph.microsoft.com/.default`, and the specific typed mutations it performs.

## Compose / Docker deployment

The executor itself is **not** a service block in `docker-compose.yml` or `deploy/docker-compose.prod.yml`, and `scripts/security/check-supply-chain-hardening.sh` enforces that a service literally named `m365-graph-read-executor:` never reappears in either file — the same rule the read executor already lives under. Actions follows the identical model for the identical reason: a private-identity workload (managed/workload identity, private authenticated ingress, controlled egress to Key Vault + Microsoft) cannot be represented as an ordinary sidecar on the shared `breeze` bridge network without weakening that isolation. Deploy the executor's separately released, digest-pinned image (`ghcr.io/lanternops/breeze/m365-graph-actions-executor@sha256:<digest>`) in its own identity-capable environment (see `.env.example` / `deploy/.env.example` for the required `--read-only --cap-drop=ALL --security-opt=no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=64m` hardening flags and the numeric `1001:1001`/`0400` file-secret ownership requirement).

What **is** threaded through the generic Compose stack is the API side of the contract — the two onboarding vars, the two tools vars, and the executor-facing config/signing vars from the [Breeze API table above](#breeze-api), plus the `m365_graph_actions_executor_signing_private_jwk` Docker secret. Nothing else about the actions executor is compose-aware; the executor process is provisioned and pointed at by URL/audience/kid entirely out of band.

## Deploy gotchas

Three deploy-time traps were found while wiring this task's compose plumbing. Each one silently makes the feature unusable rather than failing at the point a self-hoster would expect:

**(a) `APP_ENCRYPTION_KEY_ID` must be threaded through compose, not just set in `.env`.** Both `APP_ENCRYPTION_KEY_ID` and (already-present) `APP_ENCRYPTION_KEY` must be present **both** in `/opt/breeze/.env` **and** the `api` service's `environment:` block on EU+US (and in the self-host `docker-compose.yml`) *before* `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true`. Compose only interpolates variables it explicitly lists — a value set only in `.env` with no matching `environment:` line is silently inert (the established `IS_HOSTED`/#570 gap class). Boot now refuses to start outright when `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true` and `APP_ENCRYPTION_KEY_ID` is missing (`apps/api/src/config/validate.ts`), because the reset-password reveal seals its temporary credential with AAD-bound `enc:v3` ciphertext and fails closed without a key id.

**(b) Enabling actions tools-only still requires a `PUBLIC_URL` var.** The boot validator (`validateM365CustomerGraphActionsRuntimeConfigAtBoot`) loads the full actions executor descriptor — including the consent callback URL — whenever **either** `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED` **or** `M365_GRAPH_ACTIONS_TOOLS_ENABLED` is set, not only when onboarding is on. The descriptor's callback-URL parser requires one of `PUBLIC_URL`, `PUBLIC_APP_URL`, or `PUBLIC_API_URL` to be set in production (it has no default). A deployment that enables only the AI tools (leaving onboarding off, e.g. because consent already happened out of band) still needs one of those three vars set or the API refuses to boot — this is easy to miss because nothing about "tools" reads like it should care about a public URL.

**(c) The executor's callback URL must byte-match the API's derived one.** `M365_CUSTOMER_GRAPH_ACTIONS_CALLBACK_URL` on the **executor** is a separate, independently-configured value from the API's derived `{PUBLIC_URL origin}/api/v1/m365/actions-consent/callback`. The executor compares the `redirectUri` it receives per-request against its own configured value with strict equality (`apps/m365-graph-actions-executor/src/operations.ts`); any mismatch — a different origin, a trailing slash, `http` vs `https`, a different `PUBLIC_APP_URL` chosen over `PUBLIC_API_URL` on the API side — fails the identity-verification leg with `identity_token_invalid`. Set both from the same source of truth and verify byte-for-byte equality as part of every deploy that touches either app's public origin configuration.

## Deployment and rollout

1. Deploy the API release carrying the M365 actions control-plane and the reset-password reveal path (PR #2693) to every API instance; verify the running revision.
2. Provision the dedicated actions Entra application, certificate, Key Vault version, executor identity, private ingress, and controlled egress.
3. Deploy the executor **dark** by exact image `sha256` digest (never a mutable tag); verify `GET /healthz` returns only `{"status":"ok"}` and that identity, Key Vault, and Microsoft connectivity succeed from a non-customer test path.
4. Keep `M365_GRAPH_ACTIONS_TOOLS_ENABLED=false`. Confirm no public route reaches `/v1/execute-action` or `/healthz`, and that only the actions-executor identity can read the pinned vault secret.
5. Consent one disposable internal Breeze org so it has an `active` `customer-graph-actions` connection, then enable only that org UUID via `M365_GRAPH_ACTIONS_TOOLS_ORG_IDS`, flip `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true`, and exercise a `disable` and a `reset_password` through the full approve → headless-execute → reveal path.
6. Expand the org allowlist gradually. Use `*` only after limited rollout is accepted.

### Rollback

Disable new execution first by setting `M365_GRAPH_ACTIONS_TOOLS_ENABLED=false` on every API instance (the durable approval layer and everything else are unaffected). If the executor is unhealthy, remove it from service or restore the previous exact digest with its matching pinned credential configuration; an executor outage records `executor_unavailable` and does not prove consent was revoked. If the credential version changed during a failed rollout, restore API and executor as a matched pair and retain the old certificate version through the rollback window.

## Operational signals

The Prometheus counter is `breeze_m365_graph_actions_total{action,outcome}`, registered on the same `/metrics` route as the read counters. The matching audit action is `m365.customer_graph_actions.action_executed`, with `details` limited to an explicit allowlist (`actionType`, `outcome`) — it **never** carries the executor's result payload (e.g. a reset-password temporary password) or any Graph request/response body.

The one-time reveal of a temporary password emits its own audit event `action_intent.temp_password.reveal` (success and denial), with details limited to `intentId`, `actionName`, and `revealPath` — never the password.

Use correlation IDs to join API, executor, and Microsoft-side observations. Never add tokens, certificate data, raw provider bodies, raw vault locators, or any temporary password to metrics, audit, or logs.
