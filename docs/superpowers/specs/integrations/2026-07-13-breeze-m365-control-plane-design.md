# Breeze M365 Control Plane and Narrow Executors — Design Spec

**Date:** 2026-07-13
**Status:** Approved design, pre-implementation
**Scope:** Consolidate Microsoft 365 authorization, tenant mapping, policy, approvals, execution, and audit into Breeze; migrate production consumers; remove Delegant as a runtime dependency.

## 1. Summary

Breeze becomes the single control plane for Microsoft 365 work performed by Hive, helpdesk automation, incoming-email triage, and other trusted clients. Breeze owns tenant identity, connection lifecycle, permission profiles, RBAC, policy, human approval, execution intent, and audit. Narrow internal executors acquire Microsoft tokens and perform typed Graph or PowerShell actions.

This design handles two different workload classes without allowing their credentials or privileges to collapse into one security domain:

1. **Communications:** Todd's delegated email and Teams access for customer communication.
2. **Customer administration:** app-only Graph and PowerShell access to customer tenants for Exchange, Intune, Entra, SharePoint, and related administration.

Delegant is a migration source only. The completed system has no Delegant service, database, console, worker, credential, Hive grant, Breeze fallback, or compatibility path.

## 2. Goals

- Give Hive and other clients one stable Breeze MCP surface for M365 work.
- Preserve Breeze's existing action-level approval tiers and durable audit model.
- Keep reusable Microsoft credentials out of Hive, MCP clients, the Breeze API process, chat transcripts, and the primary Breeze database.
- Bind every request to an explicit Breeze organization or user and an immutable Microsoft tenant ID.
- Use least-privilege, versioned permission profiles with customer admin consent per tenant.
- Expose typed actions rather than arbitrary Graph requests or PowerShell scripts.
- Make approvals durable so callers can request work, pause, and retrieve the result later.
- Migrate incrementally and verify each tenant before changing its authoritative execution path.
- Retire Delegant completely after migration.

## 3. Non-goals

- Rebuilding Delegant as a second product inside the Breeze repository.
- Providing a public general-purpose Graph proxy or PowerShell hosting service.
- Allowing agents to select arbitrary tenants, URLs, HTTP methods, scopes, modules, or scripts.
- Supporting customer-supplied executable code in the M365 workers.
- Automatically combining all Microsoft permissions into one application identity.
- Returning reusable credentials or unrestricted sensitive Microsoft responses through MCP.
- Maintaining Delegant indefinitely as a fallback after cutover.

## 4. Locked decisions

| Area | Decision |
|---|---|
| Product boundary | Breeze is the control plane; executors are internal Breeze components, not a separate product. |
| Production consumers | Hive and other automation call Breeze MCP only. |
| Authorization | Breeze resolves organization, user, connection, tenant, RBAC, policy, and approval. Callers do not supply an authoritative tenant. |
| Credential storage | Breeze Postgres stores metadata and vault references only. Reusable secrets live in isolated vault domains. |
| Execution | Workers acquire credentials directly and execute typed actions. The main API never handles reusable Graph tokens or private keys. |
| Microsoft tenancy | Customer connections are bound to immutable Entra tenant GUIDs and verified against acquired-token claims. |
| Permissions | Code-owned, versioned capability profiles describe required Microsoft permissions. Permission changes require explicit consent reconciliation. |
| Approvals | `ai:execute` permits requesting a privileged action; it never substitutes for human approval. |
| Escape hatches | Arbitrary Graph requests, arbitrary PowerShell, raw tenant switching, and runtime permission escalation are blocked. |
| Delegant | Migrate useful metadata and access, revoke credentials, delete integrations, and remove all runtime presence. |

## 5. Architecture and trust boundaries

```text
Hive / helpdesk / triage / trusted MCP client
                  |
                  | Breeze MCP credential
                  v
        Breeze API and control plane
  authn -> tenant/RBAC -> action policy -> immutable intent
                  |
           approval required?
             /          \
           yes           no
           |              |
     durable approval     |
           |              |
           +------> durable execution job
                            |
                  narrow executor selected
                 /          |           \
       communications   Graph admin   EXO PowerShell
           worker          worker          worker
              |              |              |
              +------ isolated vault domains ------+
                            |
                 short-lived Microsoft token
                            |
                 Microsoft 365 customer tenant
                            |
                sanitized result + audit link
                            |
                    Breeze / requesting client
```

The main boundaries are:

- **Client boundary:** MCP clients can request catalogued actions but cannot see secrets or choose an unbound tenant.
- **Control-plane boundary:** Breeze decides whether an action is allowed and persists intent before work is released.
- **Credential boundary:** only the selected executor can read its credential domain.
- **Microsoft boundary:** the executor verifies token `tid`, application identity, and expected permission profile before executing.
- **Result boundary:** executors return structured, sanitized results; sensitive values use a separate one-time delivery mechanism.

## 6. Credential isolation

There is one logical administration surface in Breeze, but credentials are physically compartmentalized.

### 6.1 Storage model

Breeze Postgres stores:

- Breeze partner, organization, or user ownership
- Immutable Microsoft tenant GUID
- Connection type and capability profile
- Microsoft application ID and certificate version
- Opaque vault reference
- Consent/grant version and verification state
- Health, expiry, revocation, and last-check timestamps

It does not store reusable access tokens, refresh tokens, client secrets, or private keys.

Production credentials live behind a provider-neutral `CredentialProvider`, with Azure Key Vault as the production provider. A self-hosted deployment may implement a separately encrypted provider, but the API and database contract remains the same.

The foundation provider exposes version-pinned `put` and `get` operations only. Azure Key Vault deletion is name-wide rather than version-scoped, so deletion must wait for a DB-backed lifecycle workflow that loads the authoritative connection, serializes against rotation, and verifies the current stored reference before deleting all versions. No caller-supplied vault reference can directly trigger deletion.

### 6.2 Credential domains

| Domain | Identity and secret | Accessible by | Intended capability |
|---|---|---|---|
| `communications-delegated` | Todd's delegated refresh token | Communications executor only | Personal mailbox and Teams communication |
| `customer-graph-read` | Dedicated app identity and certificate | Graph read executor only | Read-only Entra, Intune, SharePoint, Exchange/Graph inventory |
| `customer-graph-actions` | Dedicated app identity and certificate | Graph mutation executor only | Approved customer changes through Graph |
| `customer-exchange-powershell` | Exchange app identity and certificate | Isolated PowerShell executor only | Approved, typed Exchange Online runbooks |

Each domain is independently rotatable and revocable. A compromise in one executor must not grant access to another domain. The first implementation uses separate application identities for the domains; combining them later requires an explicit security review and is not an implicit optimization.

Customer tenants normally do not require a unique Breeze client secret. Their administrator grants consent to the appropriate multitenant Breeze application, while Breeze retains the platform certificate in its vault and stores only tenant/grant metadata per customer.

### 6.3 Credential use

1. The executor receives a signed internal job containing an action ID, connection ID, immutable intent ID, and approved argument digest.
2. It resolves the vault reference assigned to its own credential domain.
3. It acquires a short-lived Microsoft access token.
4. It validates tenant and application claims against the connection and job.
5. It executes the typed action.
6. It clears token and session state and returns a sanitized result.

Neither Hive nor the main Breeze API receives the reusable credential or acquired token.

## 7. Canonical M365 connection model

Breeze should converge its direct M365 connections, C2C M365 records, Delegant connection records, and Hive tenant mappings into one authoritative connection model. Existing feature-specific records may reference the canonical connection during migration, but must not remain competing sources of tenant truth.

Each canonical connection contains:

- Breeze ownership axis: organization for customer administration, or user for personal communications
- Immutable Entra tenant GUID
- Connection profile and authentication mode
- Microsoft app identity and vault reference
- Requested permission-manifest version
- Observed grants and consent version
- Verification, health, expiry, suspension, and revocation state
- Created-by, verified-by, and lifecycle audit metadata

Suggested lifecycle states are:

```text
pending_consent -> verifying -> active -> degraded -> suspended -> revoked
                         ^          |
                         +----------+  reconnect / re-consent / rotate
```

A failed permission profile degrades only that connection profile. For example, an expired delegated communications session must not disable an otherwise healthy customer Graph read connection.

The first schema release temporarily retains the legacy unique `org_id` index and discriminator defaults because production applies migrations before replacing the old API, whose upsert still targets `org_id`. This expand phase intentionally permits only one organization-owned profile. Before any writer creates additional organization profiles, a required contract migration must remove the legacy index and defaults after all deployed writers target `(org_id, profile)`.

### 7.1 Capability profiles

Capability profiles are versioned manifests committed with the Breeze code. A manifest specifies:

- Microsoft delegated or application permissions
- Allowed Breeze actions
- Required executor and credential domain
- Verification probes
- Consent copy shown to the administrator
- Manifest version and compatibility rules

The initial profiles are:

- `communications-delegated`
- `customer-graph-read`
- `customer-graph-actions`
- `customer-exchange-powershell`

Adding a permission bumps the manifest version. Breeze marks affected connections as requiring consent reconciliation and does not silently treat old consent as authorization for new actions.

## 8. Consent and connection onboarding

The onboarding flow is profile-specific:

1. An authorized Breeze administrator chooses the organization and connection profile.
2. Breeze displays the requested Microsoft permissions and the operational abilities they enable.
3. Breeze creates signed state bound to the Breeze principal, organization or user, profile, application identity, and browser session.
4. Microsoft performs delegated sign-in or customer admin consent.
5. The callback validates state and records Microsoft's exact tenant GUID.
6. The matching executor acquires a test token and validates tenant and application identity.
7. Breeze verifies the observed grants against the requested manifest and performs read-only probes.
8. The connection becomes `active` only after all checks pass.

The callback never trusts a caller-supplied organization or tenant. A Microsoft tenant GUID maps to the expected Breeze ownership record through the signed connection attempt. Ambiguous or conflicting mappings require manual resolution.

The connection UI shows profiles, exact grants, manifest drift, certificate/session health, verification history, recent executions, and controls to reconnect, re-consent, rotate, suspend, or revoke.

## 9. Typed action catalog

Breeze exposes specific, versioned actions rather than the current generic Graph-request pattern. Every catalog entry defines:

- Stable action name and version
- Input and sanitized output schemas
- Executor and capability profile
- Required Microsoft permissions
- Breeze RBAC permission
- Risk and approval tier
- Idempotency and retry behavior
- Target and impact summarizer
- Redaction and sensitive-result rules

Representative actions include:

- `m365.user.get`
- `m365.signins.list`
- `m365.intune.device.get`
- `m365.mail.list`
- `m365.mail.draft`
- `m365.mail.send`
- `m365.user.disable`
- `m365.group.membership.add`
- `m365.intune.device.retire`
- `m365.exchange.mailbox.convert_shared`

The catalog is an allowlist. There is no production action accepting an arbitrary Graph URL/method/body or arbitrary PowerShell text.

### 9.1 Risk mapping

| Tier | Behavior | Examples |
|---|---|---|
| Tier 1 | Execute immediately after authorization; fully audited | Read user/device/configuration, list mail, inspect sign-ins |
| Tier 2 | Execute according to organization policy; fully audited | Create a draft, categorize an item, other narrow reversible changes |
| Tier 3 | Human approval required | Send/reply/forward/post, disable/reset user, license/group/file/Intune/Exchange mutations |
| Tier 4 | Blocked, not approvable | Arbitrary Graph/PowerShell, tenant switching, app credential creation, permission escalation |

`ai:execute` means the caller may request an executable action. It never means the caller has pre-approved Tier 3 work. The existing external MCP path must be changed so no API-key scope bypasses the durable approval system.

## 10. Durable intent, approval, and execution

### 10.1 Intent creation

For every request, Breeze resolves the principal, organization/user ownership, canonical connection, Microsoft tenant, RBAC, action definition, and current policy. It then persists an immutable intent containing:

- Action name and version
- Canonicalized arguments and argument digest
- Target and human-readable impact summary
- Breeze actor, originating MCP client, organization/user, connection, and tenant
- Reason supplied by the agent or user
- Risk classification and evaluated policy version
- Idempotency key and correlation ID
- Creation and expiration timestamps

Intent persistence and outbox publication occur atomically. No worker may act on an intent that is not durably recorded.

### 10.2 Approval behavior

Tier 3 requests return a structured `pending_approval` response with the intent and approval IDs. Hive can pause, poll, or subscribe without keeping the originating process alive.

The approval UI shows:

- Customer and exact Microsoft tenant
- Requesting person, agent, and MCP client
- Action and exact targets
- Proposed message content or configuration changes
- Blast-radius or item-count summary
- Reason, creation time, and expiration

Approval is bound to the immutable argument digest. A material edit creates a new intent and approval. Decisions are first-wins, recorded with the approver's authentication assurance, and expire closed. Rejection, expiration, or cancellation makes the intent permanently non-executable.

### 10.3 Release and revalidation

After approval, Breeze releases a durable job. The executor revalidates:

- Intent and approval state
- Argument digest
- Current Breeze RBAC and policy
- Connection status and permission-manifest version
- Microsoft tenant and application identity
- Idempotency state

This prevents approval from becoming a timeless bearer capability. If the connection, policy, permission profile, or target has materially changed, execution stops and returns for review rather than proceeding on stale authorization.

### 10.4 Results and resumption

MCP action responses use a stable state model:

- `completed`: sanitized result and execution ID
- `pending_approval`: approval ID, intent ID, and expiration
- `in_progress`: execution ID and status endpoint/tool
- `rejected` or `expired`: terminal approval outcome
- `failed`: categorized, sanitized failure and remediation hint

Clients retrieve final state through an execution-status tool, event, or webhook. Retries use the original idempotency key and cannot create an unapproved duplicate side effect.

## 11. Executor design

### 11.1 Communications executor

- Uses only the delegated communications credential domain.
- Provides typed mail and Teams reads, draft operations, and approved sends/posts.
- Binds approval to exact recipients, destination, subject, and content for sends, replies, forwards, and Teams posts.
- Does not expose general delegated Graph access.

### 11.2 Graph executors

- Accept only signed internal jobs containing catalogued action IDs.
- Do not accept arbitrary URLs, methods, or permission scopes.
- Use Microsoft authentication and Graph egress allowlists.
- Validate token tenant and application claims before each execution.
- Separate read and mutation credential domains and worker identities.
- Enforce per-action request, response, pagination, time, and item-count bounds.

### 11.3 Exchange PowerShell executor

- Runs versioned, code-owned runbooks only.
- Uses an isolated, short-lived PowerShell 7 process or container with required signed modules.
- Creates no interactive shell and accepts no arbitrary script fragments.
- Never reuses an authenticated Exchange session across tenants or jobs.
- Restricts environment variables, filesystem access, network destinations, runtime, and output size.
- Captures a hashed and sanitized transcript linked to the execution record.
- Converts raw module output into the action's structured result schema.

Additional workload-specific PowerShell executors may be added later under the same rules; they do not broaden the Exchange worker by default.

## 12. Sensitive values and data handling

Tokens, private keys, refresh tokens, temporary passwords, recovery codes, and unrestricted message or PowerShell payloads are prohibited from:

- MCP responses
- Hive context
- AI chat transcripts
- Standard application logs and traces
- Approval summaries
- General audit exports

An action that produces a one-time secret stores it as a short-lived protected record with explicit recipient authorization, one-time retrieval, access logging, and automatic destruction. The normal execution result contains only a reference and expiry.

Redaction occurs before logging. Executor exceptions are normalized so authentication headers, Graph bodies, PowerShell environment variables, and vault material cannot be serialized accidentally.

## 13. Failure handling and idempotency

- A failure before provider execution produces no side effect and may mark the connection degraded when appropriate.
- Microsoft throttling honors `Retry-After` and uses tenant/action-aware backoff.
- An ambiguous timeout triggers provider-state verification before retry.
- Provider request IDs and Breeze correlation IDs are retained for diagnosis.
- Duplicate MCP requests converge on the same intent or execution through idempotency keys.
- Composite actions record each step. Partial completion stops for explicit resolution; Breeze does not blindly roll back or replay unrelated steps.
- Approval expiration, connection suspension, policy drift, tenant mismatch, and grant drift all fail closed.
- One tenant's throttling or credential failure must not stall other tenants' queues.

## 14. Operations and audit

The M365 management view presents connection health as an operating system, not a credential list. It shows tenant identity, profiles, grants, consent drift, certificate/session expiry, recent verification, pending approvals, failures, and last successful execution.

Every request receives one correlation chain spanning:

```text
MCP request -> intent -> approval -> executor job -> Microsoft request -> result
```

The audit trail answers:

- Who or what requested the action?
- Which Breeze organization/user and Microsoft tenant were targeted?
- What exact typed action and resources were involved?
- Which policy and approval allowed it?
- Which profile and executor performed it?
- What did Microsoft report?
- Were retries or partial steps involved?

Audit records store hashes, identifiers, and sanitized summaries rather than reusable secrets or unrestricted content.

Alerts cover:

- Certificates or delegated sessions approaching expiration
- Missing or unexpectedly added Microsoft grants
- Repeated authorization failures
- Tenant/application identity mismatch
- Approval backlog or expiration
- Executor unavailability or unusual action volume
- Policy blocks and cross-tenant access attempts
- Consent or permission-manifest drift

## 15. Consolidation and migration

### Phase 1: Build the Breeze foundation

Implement the canonical connection model, credential provider, capability manifests, typed action catalog, durable approval/resume path, and narrow executors. Delegant remains operational but frozen. New connections are created directly in Breeze.

### Phase 2: Inventory existing access

Produce a one-time inventory of:

- Delegant customer tenants and grants
- Breeze direct M365 connections
- C2C backup connections
- Hive tenant mappings and Delegant-specific credentials
- Microsoft application registrations, certificates, refresh tokens, permissions, and expirations

Map every record to a Breeze owner, immutable tenant GUID, capability profile, and migration disposition. Ambiguous records require manual resolution.

### Phase 3: Reauthorize and rotate

Fresh authorization is the default:

- Todd performs a new delegated communications sign-in.
- Platform application certificates are rotated into the production vault.
- Existing customer consent is retained only if Breeze takes control of the same application identity and verifies all grants.
- A new application ID or changed permission profile requires customer re-consent.

Do not bulk-export Delegant refresh tokens or private keys into Breeze Postgres. If a credential must be transferred temporarily, a one-time worker moves it directly between protected stores, verifies it, records only metadata, and destroys transfer material.

### Phase 4: Verify tenant-by-tenant

Before activation, each profile must pass:

- Token tenant/application identity validation
- Permission-manifest reconciliation
- Read-only canary actions
- Approval creation without premature execution
- Organization and executor isolation checks
- Audit correlation and sanitization checks
- Revocation and expiry detection

Breeze becomes authoritative only after verification. A failed tenant remains on its old path while remediation proceeds.

### Phase 5: Cut over consumers

Move Hive, incoming-email triage, helpdesk workflows, and other clients to Breeze MCP credentials and typed Breeze actions. Remove:

- Delegant JWT issuance and validation from Hive
- Hive's Delegant M365 grant handling
- Breeze's Delegant fallback client and routes
- Direct production automation calls to the M365Graph MCP
- Client-side tenant selection and reusable Microsoft credentials

The M365Graph repository may remain a developer troubleshooting tool and a source for typed handler logic. It is not a production authorization boundary.

### Phase 6: Decommission Delegant

Delegant is removed after:

- Every active tenant is migrated, intentionally excluded, or disconnected.
- The observation window contains no production Delegant calls.
- Required metadata and audit history are exported without live reusable secrets.
- Delegant app credentials, certificates, API keys, sessions, and customer grants are revoked.
- Workers, console, database, deployment configuration, DNS, and monitoring are disabled.
- Breeze Delegant tables, compatibility code, environment variables, and documentation are deleted.

Before credential revocation, rollback may temporarily return an unmigrated tenant to its old path. After revocation, rollback means reconnecting through Breeze, not resurrecting Delegant.

## 16. Verification strategy

- **Unit:** permission manifests, risk classification, schema validation, redaction, state transitions, and idempotency.
- **Catalog contracts:** every MCP tool maps to one typed action and one allowed executor/profile combination.
- **Approval:** changed arguments, expired/rejected approval, replay, duplicate decisions, and stale policy cannot execute.
- **Tenant isolation:** deliberate cross-organization connection, intent, approval, job, result, and vault-reference access attempts.
- **Credential leakage:** responses, logs, exceptions, traces, audit records, support exports, and failed jobs contain no reusable secrets.
- **Executor:** Graph URL allowlisting and bounds; PowerShell command/module/network/filesystem/time/output restrictions.
- **Integration:** dedicated Microsoft test tenants for delegated Graph, app-only Graph, and Exchange Online PowerShell.
- **End-to-end:** MCP request -> intent -> approval -> executor -> Microsoft -> sanitized result.
- **Failure:** throttling, expired consent, token mismatch, ambiguous timeout, worker restart, duplicate delivery, and partial composite action.
- **Migration:** compare existing access with new manifests and prove each cutover tenant's old path can be disabled.

Production rollout begins with Breeze's own tenant, then one low-risk customer, then a limited cohort. Mutation profiles remain disabled until tenant binding, read operations, approval/resume, audit, idempotency, and revocation are proven in production.

## 17. Delivery sequence

The implementation should be split into independently reviewable plans and releases:

1. **Foundation:** canonical connection schema, capability manifests, credential-provider abstraction, and management APIs.
2. **Consent and verification:** profile onboarding, tenant binding, grant reconciliation, rotation, and health UI.
3. **Intent and approval:** close the external MCP bypass; add immutable intents, outbox, durable approval/resume, and status contracts.
4. **Read executors:** communications reads and customer Graph read actions; validate isolation and operations in production.
5. **Mutation executors:** Graph actions, exact-content communications approvals, and idempotent execution.
6. **PowerShell executor:** isolated runtime and the first typed Exchange runbooks.
7. **Consumer migration:** Hive, helpdesk, email triage, and other automation move to Breeze actions.
8. **Delegant removal:** revoke, delete compatibility paths, decommission infrastructure, and verify zero runtime traffic.

Each stage must include its tests, audit events, metrics, operational controls, and rollback boundary. Broad tenant migration does not begin until the preceding production gates are satisfied.

## 18. Final security invariant

No M365 executor may act unless all of the following are true at execution time:

1. The request maps to a catalogued, versioned action.
2. The Breeze principal is authorized for the bound organization or user.
3. The canonical connection is active and bound to the expected immutable Microsoft tenant.
4. The required capability profile and observed Microsoft grants are current.
5. The action is permitted by current Breeze policy.
6. Any required human approval is valid and bound to the exact immutable intent.
7. The selected executor is the only component able to access the required credential domain.
8. The execution is idempotent, auditable, and produces only a sanitized result.

If any condition fails, the action does not execute.
