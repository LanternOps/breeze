# M365 Customer Graph Actions real-tenant acceptance

Use this checklist only with a disposable, non-production Microsoft 365 tenant. It is the narrow companion to the [Customer Graph Read real-tenant runbook](./m365-customer-graph-read-real-tenant.md) — read that first for the shared consent/tenant-binding model, evidence discipline, and the approved tenant-local assignment procedure, all of which apply unchanged here. This runbook does **not** repeat the full read acceptance matrix (drift scenarios, expiry, replay, executor outage, etc.); it validates only what is specific to Customer Graph **Actions**: consent for exactly two write scopes, driving one approved mutation through headless execution, and the one-time temporary-password reveal. It does not authorize production customer testing or broader action-catalog scopes.

## Scope

One allowlisted Breeze organization ("Org A"), one disposable tenant, one shipped mutation end to end (`m365.user.reset_password` / AI tool `m365_reset_password`). This is an acceptance smoke test for the actions-specific surface, not a full regression pass — rely on the read runbook's scenarios 1–13 (already accepted for the shared consent machinery this profile reuses) rather than repeating them here.

## Safety and prerequisites

- A disposable Entra/Microsoft 365 tenant with no production users or data, distinct from (or the same as, if already disposable) the one used for the read runbook. It must contain at least one disposable test user account that is safe to disable and password-reset.
- One eligible test administrator holding **Global Administrator** or **Privileged Role Administrator**.
- Exactly one non-production Breeze organization allowlisted — Org A. Only Org A's canonical UUID may appear in `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS` and `M365_GRAPH_ACTIONS_TOOLS_ORG_IDS` for the duration of this run.
- The isolated actions executor deployed dark per the [executor deployment runbook](../deploy/m365-customer-graph-actions-executor.md), including its own dedicated Entra application/certificate/Key Vault version (never the read executor's), private ingress, controlled egress, and an exact scanned image digest recorded.
- `APP_ENCRYPTION_KEY_ID` set on every API instance (both in `.env` and threaded through the `api` service's `environment:` block) **before** `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true` — see [deploy gotcha (a)](../deploy/m365-customer-graph-actions-executor.md#deploy-gotchas). Confirm this with a boot-log check, not by assuming a prior deploy set it.
- One of `PUBLIC_URL` / `PUBLIC_APP_URL` / `PUBLIC_API_URL` set on every API instance — see [deploy gotcha (b)](../deploy/m365-customer-graph-actions-executor.md#deploy-gotchas).
- A Breeze test operator with `organizations:read`, `organizations:write`, `approvals:decide`, and current MFA.
- Read-only access to sanitized API/log/audit evidence and controlled database inspection. Do not copy secret-bearing rows, provider callback URLs, or the revealed temporary password into the evidence package once the run is closed.

Record tenant/org/user identifiers as redacted aliases plus a one-way digest. Never place raw state, cookie values, authorization codes, PKCE verifiers, nonces, tokens, private keys, certificate PEM, private JWKs, provider error bodies, raw vault references, or the revealed temporary password itself in this document, screenshots, tickets, shell history, or attachments — capture only that a value existed, its shape/length, and that it was cleared.

## Authoritative permission manifest — exactly two grants

The expected profile is `customer-graph-actions`, manifest version `1`, Microsoft Graph resource application `00000003-0000-0000-c000-000000000000`, with **exactly** these two application roles — no more, no fewer:

| Permission | App role ID |
|---|---|
| `User.ReadWrite.All` | `204e0828-b5ca-4ad8-b9f3-f32a958e7cc4` |
| `User-PasswordProfile.ReadWrite.All` | `56760768-b641-451f-8906-e1b8ab31bca7` |

This differs from the read profile's nine-role manifest: the actions app registration should request and be consented for only these two scopes for this acceptance run. Do **not** pre-consent any of the four roadmap scopes documented in the [deploy runbook's permission manifest section](../deploy/m365-customer-graph-actions-executor.md#entra-application-and-permission-manifest) — they are not wired to any shipped action, and consenting them widens the mutation blast radius for no test value.

## Evidence key

Reuse the read runbook's [evidence key](./m365-customer-graph-read-real-tenant.md#evidence-key) conventions (UI/API/DB/Audit/Metric/log/Entra categories, redaction rules) with these actions-specific additions:

- **Consent audit** — `m365.customer_graph_actions.consent_initiated`, `m365.customer_graph_actions.admin_consent_returned`, `m365.customer_graph_actions.tenant_binding_verified`, `m365.customer_graph_actions.retested`. Metrics: `breeze_m365_customer_graph_actions_events_total{event,outcome}`.
- **Mutation audit** — exactly one `m365.customer_graph_actions.action_executed` row per executed attempt, `details` limited to `actionType` and `outcome` — never a Graph request/response body or the temporary password. Metric: `breeze_m365_graph_actions_total{action,outcome}`.
- **Reveal audit** — `action_intent.temp_password.reveal` (success and denial), `details` limited to `intentId`, `actionName`, `revealPath` — never the password.
- **Intent state** — `action_intents.status` transitions (`pending_approval` → `approved` → `executing` → `completed`), visible via the admin tool-executions feed (`intentId` + `tempPasswordState`) and the AI Risk Dashboard's Approval History feed at `/ai-risk`.

## Consent-screen copy capture

Follow the read runbook's [consent-screen copy capture](./m365-customer-graph-read-real-tenant.md#consent-screen-copy-capture) procedure exactly, substituting the actions application and its two permissions. Record:

- tenant alias and operator alias;
- application display name, verified publisher text, and Microsoft timestamp;
- the exact visible heading, warning, and publisher/tenant wording;
- each permission's exact Microsoft display label and explanatory sentence for **both** `User.ReadWrite.All` and `User-PasswordProfile.ReadWrite.All`, transcribed verbatim;
- a pass/fail comparison proving the screen contains **exactly these two** application permission names and no delegated permission, no additional application permission, and none of the four roadmap scopes.

A name/ID mismatch, omitted role, extra role, or presence of any roadmap scope is a stop condition — do not proceed to the mutation scenario.

## Acceptance matrix

| # | Scenario | Expected Breeze state | Expected stable error/outcome | Required evidence |
|---:|---|---|---|---|
| A1 | Successful consent and tenant binding | Org A `active`; verified tenant is the disposable tenant; **exactly two** observed grants; manifest 1; both verification timestamps set | Callback `active`; `last_error_code` null | UI, connections API, DB metadata, Entra assignments, consent copy, binding/audit/metric evidence |
| A2 | Reconciliation shows exactly two grants, no more, no fewer | Connection card and `GET /m365/customer-graph-actions/connections?orgId=...` both report `observedGrants` with exactly the two roles above; `missingGrants` and `unexpectedGrants` both empty | `active`, no drift outcome | UI permission list, safe API response body (redacted), DB `grantHealth` derivation cross-check |
| A3 | Drive one approved `m365_reset_password` intent through headless execution | Org A's disposable test user gets a new temporary password; `action_intents` row transitions `pending_approval` → `approved` → `executing` → `completed`; exactly one `action_executed` audit row with `outcome: 'ok'` | Tool call creates the approval card; approval decision is `approved`; release worker executes without operator involvement | Approval card, intent status transitions, `action_executed` audit + metric, no Graph payload/temp password in any of them |
| A4 | One-time reveal | First `POST /action-intents/:id/reveal-secret` call returns the temporary password exactly once; the UI reveal control shows it, marks it copied/shown, and the state becomes `revoked`/no-longer-available | `200` with `data.temporaryPassword` on first call; a second call returns `already_revealed` (`410`) | Reveal audit success row, second-call denial evidence, UI state transition, confirmation the password is never present in DB `result`, logs, or the `action_executed` audit details |
| A5 | Secret non-observation review | — | — | See table below; run after A3 and A4 |

## Scenario procedure and assertions

### A1. Successful consent and tenant binding

1. Confirm Org A is the only organization present in `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS`.
2. At **Integrations → Identity → Microsoft 365**, confirm the Customer Graph Actions card renders exactly the two required permissions from the API manifest and no tenant/client/secret/certificate field is editable.
3. Choose **Connect**, complete current MFA, sign in as the eligible administrator, capture consent-screen copy per the section above, and accept.
4. Confirm the terminal browser location resolves to the actions card in an `active` state and the card refreshes.
5. Verify status `active`, manifest version 1, the signed tenant GUID, organization display name, exactly two observed assignments, `last_verified_at`, and `grants_verified_at`.
6. Verify `tenant_binding_verified` has outcome `active`; audit details contain only the fixed profile, attempt/correlation identifiers, manifest version, bounded outcome, and verified tenant after proof.

### A2. Exact two-grant reconciliation

1. Call `GET /m365/customer-graph-actions/connections?orgId=<Org A UUID>` as the test operator and record the redacted response body.
2. Confirm `connection.observedGrants` contains exactly `User.ReadWrite.All` and `User-PasswordProfile.ReadWrite.All` (by app-role ID, not just display name) and that `missingGrants`/`unexpectedGrants` are both empty arrays.
3. Cross-check the UI card's rendered permission list against the same two roles.
4. Confirm no roadmap scope (`Group.ReadWrite.All`, `DeviceManagementManagedDevices.PrivilegedOperations.All`, `DeviceManagementConfiguration.ReadWrite.All`, `Sites.ReadWrite.All`) appears anywhere in the observed set — its presence would mean the Entra app registration was over-consented for this run and is itself a stop condition.

### A3. Approved mutation through headless execution

1. Confirm `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true` on every API instance with Org A's canonical UUID present in `M365_GRAPH_ACTIONS_TOOLS_ORG_IDS` (or `*`). This flag is independent of the onboarding flag above — confirm it separately.
2. In an AI chat session scoped to Org A, issue a request that resolves to the `m365_reset_password` tool against the disposable test user (e.g. "reset the password for `<test user>`"). Confirm this creates a `pending_approval` action intent and a corresponding approval card — Tier-3 mutation tools never execute inline.
3. As an approver with `approvals:decide`, review and **approve** the card. Confirm the decision records `approved` and the linked intent transitions to `approved`.
4. Poll the intent's status (via the admin tool-executions feed or the AI Risk Dashboard's Approval History feed) until it reaches `executing` and then `completed`, without further operator action — this proves the durable release worker (BullMQ `action-intents` queue) picked up the approval and executed it headlessly rather than synchronously with the decide call.
5. Confirm exactly one `m365.customer_graph_actions.action_executed` audit row exists with `actionType: 'm365.user.reset_password'` and `outcome: 'ok'`, and that `breeze_m365_graph_actions_total{action="m365.user.reset_password",outcome="ok"}` incremented by exactly one.
6. Confirm the audit row's `details` contains only `actionType` and `outcome` — no Graph request/response body, no user identifier beyond what the connection/resource IDs already carry, and no temporary password.
7. Independently confirm in the disposable tenant (Entra sign-in or a bounded read-only check) that the test user's password was actually changed and `forceChangePasswordNextSignIn` is set — do not rely solely on Breeze's own report of success.

### A4. One-time reveal

1. Confirm the completed intent from A3 carries a sealed temporary-password result (`hasSealedTemporaryPassword`) and that it is within the 7-day reveal window.
2. As the original requester (or, for an API-key/MCP-requested intent, an approver with org access and `approvals:decide`), call `POST /action-intents/:id/reveal-secret` once. Confirm a `200` response with `data.temporaryPassword`, `data.userId`, `data.forceChangeNextSignIn`, and `data.revealedAt` — and that the plaintext appears **only** in this one response body.
3. Immediately call the same endpoint again. Confirm it returns `already_revealed` (`410`) — the CAS burn allows exactly one winner.
4. In the UI (AI Risk Dashboard → Approval History feed), confirm the reveal control transitions from its pre-reveal state to a "already revealed" state that no longer offers the plaintext, and that a page reload does not resurrect it.
5. Confirm the reveal audit trail: one `action_intent.temp_password.reveal` row with `result: 'success'` for the winning call, and (if the denial path was exercised by a second identity in a variant of this scenario) a `result: 'denied'` row — both with `details` limited to `intentId`, `actionName`, `revealPath`.
6. Discard the revealed password locally — do not record it, paste it into a ticket, or leave it in clipboard/terminal history beyond the immediate verification in A3 step 7.

### A5. Secret non-observation review

Run after A3 and A4. Record only pass/fail, query/review method, reviewer, time, and redacted artifact digest.

| Surface | Required assertion |
|---|---|
| Browser | After the reveal call, the temporary password appears only inside the reveal control's rendered UI state, not in the address bar, a query string, local storage, or session storage. Closing/reloading the reveal panel does not re-fetch or re-display it. |
| Safe API responses | The reveal response is the only response, ever, containing `temporaryPassword`. `GET /m365/customer-graph-actions/connections`, approval-list, and tool-execution feed responses never contain it, a client secret, certificate, private JWK, or vault reference. |
| Database | `action_intents.result` for the completed intent contains only sealed (`enc:v3`) ciphertext for the temporary password, never plaintext; after the reveal call, the burn fields are set and a second unseal attempt is refused. The actions connection row contains no client secret, token, certificate/private key, or private JWK — only the opaque version-pinned `vault_ref` and `credential_version` metadata, inspected only via redacted shape/version assertions. |
| Audit | `action_executed` and `action_intent.temp_password.reveal` details are limited to their documented allowlists (`actionType`/`outcome` and `intentId`/`actionName`/`revealPath` respectively). Neither ever carries the password, a Graph payload, or provider body. |
| API/executor logs | Search the bounded test window for known canary markers and the string shape of a generated temporary password. Logs contain stable error codes/correlation IDs only. Do not search by printing the real revealed value into the command or evidence. |
| Executor/runtime | Only the actions-executor identity can read the pinned `m365-customer-graph-actions` Key Vault version; the API/web/general worker identities and the read executor's identity receive access denied. Executor responses to the API never include the temporary password in a form the API doesn't already seal — confirm the API seals before persisting, not merely before returning. |

## Cleanup

1. Restore or reset the disposable test user's credentials as your test-tenant lifecycle requires.
2. Remove Org A from `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS` and `M365_GRAPH_ACTIONS_TOOLS_ORG_IDS` if no further canary is approved, restoring dark mode.
3. Disconnect the actions connection (`POST /m365/customer-graph-actions/connections/:id/disconnect`) or leave it `active` only if a follow-on run is imminently scheduled and approved.
4. Delete disposable screenshots from local machines and revoke temporary operator access.
5. Retain only the sanitized evidence package and change record required by policy — never the revealed temporary password.

## Evidence record template

```text
Run ID:
Date/time (UTC):
Release tag / Git commit:
Executor image digest (sha256):
Credential version digest/alias (never raw locator):
Disposable tenant alias + GUID digest:
Breeze Org A alias + UUID digest:
Eligible admin alias / role:
Operator / reviewer:

Scenario #:
Preconditions:
Action summary (no callback URL, secret, or revealed password value):
Expected status / error / event:
Observed status / error / event:
Sanitized evidence references + hashes:
Secret non-observation result:
Pass / fail / deviation:
Cleanup completed:
Reviewer sign-off:
```

Any secret observation (including the revealed temporary password persisting anywhere beyond the single reveal response and its immediate, undocumented verification use), an observed-grant count other than exactly two, an unexpected/roadmap scope, a second successful reveal, or an `action_executed`/reveal audit row carrying disallowed detail is a failed run. Disable the onboarding and tools flags and preserve only sanitized evidence while the issue is investigated.
