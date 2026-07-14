# M365 Customer Graph Read real-tenant acceptance

Use this checklist only with a disposable, non-production Microsoft 365 tenant. It validates administrator consent, immutable tenant ownership, exact permission reconciliation, last-known grant semantics, outage behavior, and secret confinement for the `customer-graph-read` profile. It does not authorize production customer testing, Graph mutations, or external deployment changes.

## Safety and prerequisites

- A disposable Entra/Microsoft 365 tenant with no production users or data.
- One eligible test administrator holding **Global Administrator** or **Privileged Role Administrator**, and one ineligible test administrator holding neither role.
- Two non-production Breeze organizations, called Org A and Org B in this runbook. Both must be accessible to the test operator; only the intended canary IDs may be in `M365_CUSTOMER_GRAPH_READ_ONBOARDING_ORG_IDS`.
- A dedicated multitenant Customer Graph Read application and the exact manifest/version shown below. Do not reuse a legacy direct, delegated communications, mutation, or PowerShell application.
- The isolated executor deployed dark according to [the executor deployment runbook](../deploy/m365-customer-graph-read-executor.md), with private ingress, controlled egress, a dedicated Key Vault identity, and an exact scanned image digest recorded.
- A Breeze test operator with `organizations:read`, `organizations:write`, and current MFA. If operating at partner scope, the operator must also pass the partner-wide management guard.
- Read-only access to sanitized API/log/audit evidence and controlled database inspection. Do not copy secret-bearing rows or provider callback URLs into the evidence package.

Record tenant/org/user identifiers as redacted aliases plus a one-way digest. Never place raw state, cookie values, authorization codes, PKCE verifiers, nonces, tokens, private keys, certificate PEM, private JWKs, provider error bodies, or raw vault references in this document, screenshots, tickets, shell history, or attachments.

## Authoritative permission manifest

The expected profile is `customer-graph-read`, manifest version `2`, Microsoft Graph resource application `00000003-0000-0000-c000-000000000000`, with exactly these nine application roles:

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

Do not use `Application.Read.All` as the ordinary “remove one permission” test. Without it, Microsoft Graph may deny the authoritative assignment query, so Breeze cannot truthfully calculate a current missing set. Scenario 7 tests that distinct last-known behavior.

## Evidence key

For every scenario capture only sanitized evidence:

- **UI** — Customer Graph Read card status, stable message, tenant alias/GUID digest, manifest version, required/observed/missing/unexpected permission names, and displayed timestamps. Screenshots must not include the address bar or developer tools.
- **API** — HTTP method, route template, status, and response field names/values after redaction. Never save callback query strings or cookies.
- **DB** — connection status, `last_error_code`, manifest version, timestamps, grant names/IDs, and whether a session/attempt row exists. Query secret-bearing columns only for boolean/type/shape assertions and redact query output.
- **Audit** — fixed action name, bounded outcome, resource ID digest, attempt/correlation ID digest, result, and actor alias.
- **Metric/log** — counter delta for bounded `event`/`outcome`, correlation digest, and proof that logs contain stable codes rather than provider bodies.
- **Entra** — service-principal existence and exact assignment names/IDs. Capture the consent screen separately as described below.

Expected audit action names are `m365.customer_graph_read.consent_initiated`, `m365.customer_graph_read.admin_consent_returned`, `m365.customer_graph_read.tenant_binding_verified`, `m365.customer_graph_read.verification_failed`, `m365.customer_graph_read.grant_drift_detected`, `m365.customer_graph_read.retested`, and `m365.customer_graph_read.disconnected`. Metrics use `breeze_m365_customer_graph_read_events_total{event,outcome}`.

## Consent-screen copy capture

During the first eligible consent, capture the Microsoft screen before accepting it. Record:

- tenant alias and operator alias;
- application display name, verified publisher text, and Microsoft timestamp;
- the exact visible heading, warning, and publisher/tenant wording;
- each permission's exact Microsoft display label and explanatory sentence, transcribed verbatim into the restricted evidence record;
- a pass/fail comparison proving the screen contains exactly the nine manifest permission names above and no delegated or additional application permission.

Screenshots may contain tenant/test account identity but must not contain an address bar, query string, code, state, cookie, token, or developer-tools panel. Microsoft may change explanatory copy; preserve what was actually displayed rather than substituting this runbook's wording. A name/ID mismatch, omitted role, or extra role is a stop condition.

## Acceptance matrix

Run the scenarios in order. Restore the exact nine-grant manifest whenever a scenario says to restore it.

| # | Scenario | Expected Breeze state | Expected stable error/outcome | Required evidence |
|---:|---|---|---|---|
| 1 | Successful consent and tenant binding | Org A `active`; verified tenant is the disposable tenant; exact nine observed grants; manifest 2; both verification timestamps set | Callback `active`; `last_error_code` null | UI, safe list API, DB metadata, Entra assignments, consent copy, binding/audit/metric evidence |
| 2 | Replay both callback phases | Org A remains `active`; no connection, ownership, grant, or timestamp rollback | Each replay ends `consent_state_mismatch`; executor is not invoked | Sanitized redirect outcome, unchanged DB snapshot, failure metric/audit where an attempt is available, executor request-count delta zero |
| 3 | Expired attempt | Attempt never becomes active or binds a tenant; start a fresh attempt afterward | Callback `consent_expired` for an expired signed browser binding | Start/expiry times, sanitized redirect, no executor call, no verified tenant binding |
| 4 | Ineligible administrator | Fresh attempt remains `pending-consent`; tenant is not bound | `admin_role_required` | UI message, safe API/DB state, verification-failed audit/metric, signed-in role evidence without token/claims dump |
| 5 | Cross-org duplicate tenant/profile | Org A remains `active`; Org B is not active and cannot own the same tenant/profile | Org B callback `tenant_already_bound`; no owning-org disclosure | Both org status snapshots, generic Org B message, unique ownership DB assertion, audit/metric |
| 6 | Remove a normal required permission (not `Application.Read.All`) | Org A becomes `degraded`; authoritative observed set and `grants_verified_at` advance; missing list names the removed permission | `grant_missing` | Before/after Entra roles, Retest response, timestamps, drift/retest audit and metric |
| 7 | Remove `Application.Read.All` | Org A becomes `degraded`; observed grants and `grants_verified_at` remain the prior **last-known** values; `last_verified_at` may advance for the bounded tenant probe | `grant_reconciliation_unavailable`, not `grant_missing` | UI “Last-known” label, before/after DB digests/timestamps, no fabricated current missing set, retest audit/metric |
| 8 | Add an unexpected application permission | Org A becomes `degraded`; complete observed set contains the extra role and `grants_verified_at` advances | `grant_unexpected` | Entra extra role, UI/API unexpected group, DB metadata, drift/retest audit and metric |
| 9 | Re-consent restores exact grants | Org A returns `active`; observed equals the exact nine; timestamps advance | Callback `active`; `last_error_code` null | Consent, UI/API/DB exact equality, binding/retest audit as applicable |
| 10 | Remove tenant-wide Microsoft consent and detect with Retest | Org A becomes `degraded`; prior observed grants and verification timestamp are retained, and no new Microsoft consent is inferred | `application_token_invalid` | Enterprise-app removal evidence, Retest result, unchanged last-known grant digest, retest audit/metric |
| 11 | Executor outage and recovery | During outage an existing `active` row stays `active`; after recovery a successful Retest is `active` | During outage `executor_unavailable`; after recovery null | Health/reachability evidence, pre/outage/recovery DB state, executor request/metric evidence |
| 12 | Local disconnect and delayed-result rejection | Org A becomes `revoked`; tenant/client/display/grant/verification execution state is cleared; consent attempt rotates; Microsoft consent remains until separately removed | Disconnect outcome `revoked`; delayed callback `consent_state_mismatch` or delayed scoped mutation `404 Connection not found` | UI/API/DB, disconnected audit/metric, unchanged Entra consent before separate removal, delayed-result rejection |
| 13 | Separate Microsoft consent removal and cleanup | Breeze remains `revoked`; disposable Entra service principal/consent and test artifacts are removed | No Breeze claim that local disconnect removed Microsoft consent | Entra removal confirmation, final safe DB/audit retention check, cleanup sign-off |

## Scenario procedure and assertions

### 1. Successful consent and immutable tenant binding

1. Select Org A at **Integrations → Identity → Microsoft 365**. Confirm the legacy direct card remains separate and unchanged.
2. On the Customer Graph Read card, verify all nine required permissions are rendered from the API manifest and no tenant/client/secret/certificate field is editable.
3. Choose **Connect**, complete current MFA, sign in as the eligible administrator, capture consent-screen copy, and accept.
4. Complete the administrator identity step. Confirm the terminal browser location is `/integrations#m365/customer-graph-read/active` and the card refreshes.
5. Verify status `active`, manifest version 2, the signed tenant GUID, organization display name, exact observed assignments, `last_verified_at`, and `grants_verified_at`.
6. Verify `tenant_binding_verified` has outcome `active`; audit details contain only the fixed profile, attempt/correlation identifiers, manifest version, bounded outcome, and verified tenant after proof.

### 2. Replay both callback phases

Use browser Back/Reload or a controlled test proxy that keeps sensitive query values only in memory. Do not save callback URLs, HAR files, request headers, or clipboard contents.

1. Replay the admin-consent callback after it has transitioned to identity verification.
2. Replay the identity callback after its terminal single-use consumption.
3. Confirm each ends at the `consent_state_mismatch` hash, clears the binding cookie on the terminal path, and makes no executor request.
4. Confirm Org A remains active with the same tenant ownership, grants, and verified timestamps.

### 3. Expired attempt

1. Start a fresh attempt and do not submit its Microsoft callback for more than ten minutes.
2. Resume using only the original browser session; do not copy the callback URL.
3. Confirm an expired valid binding redirects to `consent_expired` before state lookup, does not call the executor, and does not bind a tenant.
4. Start a new attempt for subsequent scenarios.

### 4. Ineligible administrator

1. Start fresh consent and complete both Microsoft steps using the ineligible administrator.
2. Confirm `admin_role_required`, `pending-consent`, and no verified tenant binding.
3. Confirm neither ID-token claims nor administrator object ID appears in UI, safe API, audit, or logs.

### 5. Duplicate ownership across Breeze organizations

1. Restore/confirm Org A is active for the disposable tenant.
2. Enable onboarding for Org B and attempt consent to the same tenant/profile with the eligible administrator.
3. Confirm `tenant_already_bound`, that the response does not identify Org A, and that only Org A owns the verified `(tenant_id, customer-graph-read)` pair.

### 6. Missing ordinary grant

1. Record the current observed-grant digest and timestamps.
2. In Entra, remove exactly one manifest permission other than `Application.Read.All`; record its name and app-role ID.
3. Choose **Retest**. Confirm `degraded`, `grant_missing`, the removed grant in the missing group, an authoritative updated observed set, and a newer `grants_verified_at`.
4. Restore the grant and admin consent before continuing.

### 7. Reconciliation unavailable after `Application.Read.All` removal

1. Return Org A to active and record the observed-grant digest plus `grants_verified_at`.
2. Remove only `Application.Read.All`, then choose **Retest**.
3. Confirm `degraded` and `grant_reconciliation_unavailable`. The UI must say **Last-known observed permissions**.
4. Confirm Breeze did not overwrite observed grants, did not advance `grants_verified_at`, and did not report `Application.Read.All` as an authoritative current `grant_missing` result. A successful bounded organization probe may advance `last_verified_at`.
5. Restore `Application.Read.All` before continuing.

### 8. Unexpected drift

1. Add one harmless read-only Microsoft Graph application permission that is not in the nine-role manifest and grant it only in this disposable tenant.
2. Choose **Retest**. Confirm `degraded`, `grant_unexpected`, complete observed grants, and the extra role in the unexpected alert.
3. Confirm both `retested` and `grant_drift_detected` use the bounded `grant_unexpected` outcome.
4. Remove the extra role before continuing.

### 9. Re-consent recovery

1. Confirm Entra is configured with exactly the nine manifest roles.
2. Choose **Re-consent** and complete both Microsoft steps with the eligible administrator.
3. Confirm `active`, no stable error, exact observed equality, and newer authoritative verification timestamps.

### 10. Microsoft tenant-wide consent removal detected by Retest

1. Record active status and the last-known grant/timestamp digests.
2. In Entra **Enterprise applications**, remove the tenant's service principal/tenant-wide consent for the dedicated Customer Graph Read application. Do not use **Disconnect from Breeze** yet.
3. Choose **Retest**. Confirm `degraded` with `application_token_invalid`; Breeze must not claim success from prior metadata.
4. Confirm the last-known observed set is not replaced by an empty fabricated set and no grant verification timestamp advances.
5. Recreate consent with **Re-consent** before scenario 11.

### 11. Executor outage and recovery

1. With Org A active, make only the private executor unavailable to the API. Do not change Entra consent or database state.
2. Choose **Retest**. Confirm the request records `executor_unavailable` while preserving status `active`, tenant binding, observed grants, and verification timestamps.
3. Restore the same approved exact-digest deployment and matching pinned credential configuration.
4. Confirm private `/healthz`, then choose **Retest**. Confirm `active` and a successful authoritative timestamp advance.

### 12. Local disconnect and delayed result rejection

1. Start a fresh consent attempt and retain only an in-memory ability to release its delayed callback/result; do not store its sensitive values.
2. Choose **Disconnect from Breeze** and accept the warning.
3. Confirm status `revoked`; consent sessions are removed; the attempt ID rotates; tenant/client/display/grants/verification execution fields are cleared; audit history remains.
4. Confirm the Entra service principal/consent still exists. Local disconnect is not Microsoft consent removal.
5. Release the delayed callback/result. Confirm it cannot revive or bind the connection: callback outcome is `consent_state_mismatch`, or a scoped delayed mutation receives `404` with `Connection not found`.

### 13. Separate Microsoft removal and cleanup

1. Follow the public [Microsoft consent removal instructions](../../apps/docs/src/content/docs/features/identity-integrations.mdx#remove-customer-graph-read-consent) using the disposable tenant's Entra **Enterprise applications** entry.
2. Confirm the service principal and tenant-wide application consent are gone. Do not remove `Application.Read.All` from an unrelated app or alter a production tenant.
3. Leave the Breeze connection `revoked` so audit evidence remains, unless the approved test-data retention procedure requires broader cleanup.
4. Remove Org A/Org B from the onboarding allowlist, restore dark mode if no other canary is approved, delete temporary test users/roles, delete disposable screenshots from local machines, and revoke temporary operator access.
5. Retain only the sanitized evidence package and change record required by policy.

## Secret non-observation review

Run this review after scenarios 1, 9, 11, and 12. Record only pass/fail, query/review method, reviewer, time, and redacted artifact digest.

| Surface | Required assertion |
|---|---|
| Browser | After terminal redirect, the current URL, DOM, React state, local storage, and session storage contain no state, cookie, authorization code, PKCE verifier, nonce, token, private key/certificate, private JWK, or vault reference. Do not persist network captures used during the protocol. |
| Safe API responses | `GET /m365/connections?orgId=...`, consent initiation, Retest, and Disconnect responses contain only their strict DTOs. They contain no client secret, token, certificate, private JWK, state/cookie, authorization code, verifier/nonce, provider body, administrator object ID, credential version, or vault reference. |
| Database | Connection rows contain no client secret for `customer-graph-read`, token, certificate/private key, private JWK, authorization code, PKCE verifier, or nonce. Completed/disconnected attempt sessions are absent. The connection's code-designed `vault_ref` is an opaque version-pinned locator and `credential_version` is metadata; inspect them only through a redacted shape/version assertion and never copy their raw values into evidence. |
| Audit | Details contain only profile, attempt ID, manifest version, outcome, correlation ID, and verified tenant after proof. No state/cookie, code, verifier/nonce, token, certificate/private key, private JWK, raw provider body, administrator object ID, or vault locator appears. |
| API/executor logs | Search the bounded test window for known canary markers and sensitive field names. Logs contain stable error codes/correlation IDs only, not values or provider bodies. Do not search by printing real secret values into the command or evidence. |
| Executor/runtime | Image history/config contains no credential material. Only the executor identity can read the pinned Key Vault version; the API/web/general worker identities receive access denied. Executor responses never include Microsoft tokens or certificate material. |

The database exception above is intentional and must not be hidden: the design stores an opaque version-pinned `vault_ref` and version on the connection, and temporarily stores nonce/verifier only in a system-only one-time consent session. Acceptance requires the session to be consumed/deleted and the raw locator to remain confined to database/configuration boundaries, not a false assertion that these designed fields never exist.

## Evidence record template

```text
Run ID:
Date/time (UTC):
Release tag / Git commit:
Executor image digest (sha256):
Credential version digest/alias (never raw locator):
Disposable tenant alias + GUID digest:
Breeze Org A alias + UUID digest:
Breeze Org B alias + UUID digest:
Eligible admin alias / role:
Ineligible admin alias / role:
Operator / reviewer:

Scenario #: 
Preconditions:
Action summary (no callback URL or secret values):
Expected status / error / event:
Observed status / error / event:
Sanitized evidence references + hashes:
Secret non-observation result:
Pass / fail / deviation:
Cleanup completed:
Reviewer sign-off:
```

Any secret observation, unexpected permission, tenant mismatch, duplicate ownership disclosure, stale-result state change, or inability to prove exact assignments is a failed run. Disable onboarding and preserve only sanitized evidence while the issue is investigated.
