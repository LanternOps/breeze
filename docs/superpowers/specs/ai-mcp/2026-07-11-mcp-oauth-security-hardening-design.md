# MCP and OAuth Security Hardening Design

**Date:** 2026-07-11

**Source review:** `internal/security-reviews/2026-07-11-mcp-oauth-security-review.md`

**Scope:** MCP-OAUTH-01 through MCP-OAUTH-12

**Decision:** Revoke all existing MCP OAuth refresh tokens at deployment rather than support a legacy plaintext compatibility path.

## Goal

Close every verified MCP and OAuth finding by making tenant policy, RBAC, token storage, revocation, execution attribution, and audit behavior authoritative at the point of use. Preserve the current OAuth 2.1 authorization-code, PKCE, DCR, and MCP interfaces except where the review requires a fail-closed response or user-visible consent warning.

## Chosen Approach

Use focused shared security helpers and lifecycle wrappers instead of isolated inline patches or a full protocol rewrite.

This approach centralizes each security invariant:

- effective MCP OAuth scopes;
- durable OAuth grant tenancy;
- refresh-token storage identity;
- grant and client revocation;
- MCP resource permissions;
- MCP execution organization resolution;
- Tier 3 ledger and audit behavior.

It deliberately does not redesign oidc-provider integration, normalize the entire OAuth schema, or merge every MCP tool type into a new registry.

## Alternatives Considered

### Surgical patches

Patch each route and adapter method independently. This produces a smaller diff, but retains separate scope, revocation, and sensitive-tool execution paths. Those duplicated paths are the root cause of several findings and would remain vulnerable to drift.

### Full OAuth and MCP pipeline redesign

Normalize token-family storage, add surrogate token IDs and indexed grant columns, and replace ordinary and bootstrap tool registries with one descriptor pipeline. This is a reasonable long-term direction but expands the migration and regression surface beyond the verified findings.

## Architecture

### 1. Authoritative OAuth grant context and scope policy

Create one async grant-context resolver that returns the durable `grantId`, `partnerId`, and `orgId` for token issuance. It may use the in-memory grant metadata cache as a fast path, but a cache miss must load `oauth_grants`. A token request with a grant but no durable partner must fail closed.

Create one effective-scope helper that intersects:

1. provider-supported scopes;
2. client-requested scopes;
3. scopes displayed to the user; and
4. the selected partner's current `mcp_allowed_scopes` policy.

Use the helper in three places:

- consent display;
- consent grant persistence; and
- every resource-server scope calculation, including refresh issuance after restart.

The interaction response will attach effective scopes to each partner option. The consent form will render the scopes for the currently selected partner. The consent POST will recompute the intersection authoritatively instead of trusting the browser or the earlier GET response.

Unknown partner context must never mean “all MCP scopes” when a grant exists. Client-only flows without a grant may retain their documented policy behavior.

This closes MCP-OAUTH-01 and MCP-OAUTH-02.

### 2. Hashed refresh-token persistence and forced legacy revocation

Continue using the existing `oauth_refresh_tokens.id` column, but store a deterministic SHA-256 digest of the raw oidc-provider refresh-token model ID. Refresh tokens are high-entropy opaque values, so an unkeyed digest provides a non-reversible lookup key without introducing a new secret-rotation dependency.

Add adapter helpers with one contract:

```ts
refreshTokenStorageId(rawId: string): string
sanitizeRefreshTokenPayload(payload: OidcPayload): OidcPayload
restoreRefreshTokenPayload(rawId: string, stored: OidcPayload): OidcPayload
```

All refresh-token adapter operations—`upsert`, `find`, `consume`, `destroy`, and revocation-cache lookup—must transform the raw ID through `refreshTokenStorageId`. Persisted payloads must omit `jti`; `find` restores `jti` in memory from the raw ID before returning to oidc-provider. Grant, client, account, expiry, and tenant fields remain available.

Add an idempotent migration that:

1. marks each active grant referenced by a legacy refresh-token row revoked with reason `refresh_token_storage_hardening`;
2. deletes every legacy refresh-token row;
3. reports affected grant and token row counts with migration warnings;
4. adds a constraint requiring refresh-token IDs to be lowercase 64-character hexadecimal digests; and
5. adds a constraint forbidding a `jti` key in refresh-token payload JSON.

The constraints prevent an older application node from writing new plaintext rows during a mixed-version deployment. Such an old-node issuance attempt fails rather than reintroducing plaintext storage. Existing clients must reconnect after deployment, as explicitly approved.

This closes MCP-OAUTH-04.

### 3. Central grant-family and client revocation

Create a revocation service that accepts a client ID plus an explicit scope:

```ts
type OAuthRevocationScope =
  | { kind: 'global' }
  | { kind: 'partner'; partnerId: string }
  | { kind: 'user'; userId: string; partnerId?: string };
```

The service will query `oauth_grants` directly as the authoritative family inventory. Refresh-token rows are supplemental state, not the source of grant discovery.

Revocation ordering is fail closed:

1. resolve all affected grants and active refresh rows;
2. write grant-wide and token JTI Redis markers;
3. abort without hiding or disabling the app if required cache writes fail;
4. transactionally mark grants and refresh rows revoked;
5. delete only the requested partner join row when disconnecting one partner; and
6. disable the shared client only for global registration-management deletion.

Partner disconnect will use partner scope, so code-only grants are revoked while other partners using the shared DCR client remain connected. `BreezeOidcAdapter.destroy` for the Client model will use global scope and will not set `disabledAt` until all families are revoked. Grant-wide markers immediately reject already minted access JWTs, so bearer authentication does not need a new client-table query on every request.

This closes MCP-OAUTH-07 and MCP-OAUTH-10.

### 4. Resource-specific MCP RBAC

Extract the common role-resolution and permission-checking portion of `checkToolPermission` into a helper that accepts an explicit `{ resource, action }` requirement.

Define a fail-closed MCP resource policy map:

| MCP URI | Permission |
|---|---|
| `breeze://devices` | `devices.read` |
| `breeze://devices/{id}` | `devices.read` |
| `breeze://alerts` | `alerts.read` |
| `breeze://scripts` | `scripts.read` |
| `breeze://automations` | `automations.read` |

`resources/read` must authorize the URI before site resolution or a database query. Unknown URI families remain denied. `resources/list` may omit resources the caller cannot read, but `resources/read` is the mandatory enforcement boundary.

This closes MCP-OAUTH-03.

### 5. Organization and partner axis separation

For an organization-scoped OAuth bearer, construct the database access context with:

```ts
accessibleOrgIds: [orgId]
accessiblePartnerIds: []
currentPartnerId: partnerId
```

`currentPartnerId` retains legitimate visibility into the caller's own partner-owned catalog rows. It does not grant the broad partner-axis capability represented by `accessiblePartnerIds`.

Update invite-funnel calculation to accept the full `AuthContext`. Organization scope must filter deployment invites by `org_id`; partner scope may aggregate by `partner_id`. Ambiguous or malformed scope is rejected instead of relying only on RLS.

This closes MCP-OAUTH-06.

### 6. DCR identity and redirect hardening

Treat every dynamically registered client's display name as unverified metadata unless a future server-owned verification registry says otherwise. No verification bit will be accepted from mutable DCR metadata.

Extend the consent interaction contract with:

```ts
client: {
  client_id: string;
  display_name: string;
  verification: 'unverified';
  redirect_uri: string;
  redirect_origin: string;
}
```

The consent form will:

- label the integration as unverified;
- continue showing the client ID;
- show the exact callback origin before approval; and
- render all client-controlled strings as ordinary escaped React text.

Extract a pure DCR redirect validator and apply it to both registration creation and registration management updates. Policy:

- accept HTTPS URLs without credentials or fragments;
- accept HTTP only for literal `127.0.0.1` or `[::1]` loopback callbacks, with an optional ephemeral port;
- reject `localhost`, private-network addresses, public HTTP hosts, protocol-relative URLs, malformed URLs, credentials, fragments, and custom schemes; and
- reject an entire registration when any URI is invalid.

This closes MCP-OAUTH-08 and MCP-OAUTH-09.

### 7. Authoritative MCP execution organization

Replace the synchronous first-accessible-organization attribution for device-targeted tools with async execution-context resolution before ledger creation.

For tools declaring `deviceArgs`:

1. collect every supplied device ID using existing direct and array metadata;
2. resolve each device through the existing organization and site access gate;
3. retain the authoritative device `orgId` values;
4. require exactly one distinct organization;
5. reject an explicit `toolInput.orgId` that differs from the device organization; and
6. use that organization for ledger, execution audit, and downstream execution context.

A mixed-organization device array is rejected before ledger creation or handler execution. Org-scoped API keys and bearers remain pinned to their organization. Non-device tools retain existing safe behavior unless they supply an access-checked explicit organization.

The existing execution function may repeat its device access lookup for defense in depth; the pre-execution context is authoritative for ledger and audit attribution.

This closes MCP-OAUTH-05.

### 8. Bootstrap RBAC and shared Tier 3 ledger/audit lifecycle

Add explicit bootstrap permission mappings:

- `send_deployment_invites`: `devices.write`;
- `configure_defaults`: primary `organizations.write`, plus `devices.write` and `alerts.write`.

These checks apply regardless of `MCP_REQUIRE_EXECUTE_ADMIN`. The execute-admin setting remains an additional production gate, not a replacement for product RBAC. Add a registry parity test so every authenticated bootstrap tool must declare a permission policy.

Extract the current ordinary Tier 3 begin/complete/audit lifecycle into a shared wrapper. The wrapper will receive the resolved organization, tool name, effective tier, target summary, principal, session, and an execution callback. It will:

1. create the execution ledger before mutation and fail closed if creation fails;
2. execute the callback;
3. complete the ledger with success or failure status and duration; and
4. write the uniform `mcp.tool.<name>` audit event for both outcomes.

Ordinary and authenticated bootstrap tools will use the wrapper. Bootstrap handler-specific business audits and deduplication remain intact. The wrapper will explicitly classify returned bootstrap partial-failure results rather than assuming every non-throwing result is successful.

This closes MCP-OAUTH-11 and the verified ledger/uniform-audit portions of MCP-OAUTH-12. It does not add or claim a shared idempotency guarantee.

## Error Handling

Security-state uncertainty fails closed:

- missing durable grant tenancy blocks token minting;
- partner policy lookup failure blocks scope issuance;
- invalid or unknown resource permission mapping denies access;
- revocation cache failure prevents disconnect or client disablement;
- refresh-token storage constraint violations prevent token issuance;
- invalid DCR redirect metadata rejects the registration atomically;
- ambiguous or mixed execution organizations reject the tool call before mutation; and
- ledger creation failure prevents Tier 3 execution.

User-facing OAuth and JSON-RPC errors will remain generic. Detailed diagnostics will use existing structured OAuth error IDs and sanitized MCP audit metadata. Raw bearer tokens, authorization codes, and callback credentials must never be logged.

## Migration and Rollout

1. Create branch from current `origin/main` in the existing isolated worktree.
2. Land the application changes and the idempotent refresh-token hardening migration in one release.
3. Deploy without a prolonged mixed-version window. The database constraints make an old node fail closed if it attempts plaintext refresh-token persistence.
4. Existing OAuth grants and refresh sessions are revoked by the migration. Users reconnect their MCP clients.
5. Verify that new refresh rows contain only digest IDs and sanitized payloads.
6. Verify that a pre-deployment refresh token returns `invalid_grant` and that a newly connected client can refresh normally.

No production data backfill preserves existing refresh sessions.

## Testing Strategy

All behavior changes use red-green-refactor test cycles.

### OAuth scope policy

- Consent for `mcp:read mcp:write mcp:execute` under a read-only partner persists and displays only `mcp:read`.
- Selecting a different partner updates displayed effective scopes.
- Cold-cache refresh resolves grant tenancy from the database and cannot restore removed scopes.
- Missing durable grant tenancy fails token issuance.

### Refresh-token storage and revocation

- Adapter upsert stores a digest ID and no payload JTI.
- Raw input still supports `find`, `consume`, `destroy`, and reuse detection through the digest transform.
- Migration revokes grants referenced by legacy refresh rows, removes those rows, reports row counts, and rejects plaintext inserts.
- Partner disconnect revokes code-only and refresh-enabled grants without affecting another partner using the shared client.
- Global client deletion revokes every family before `disabledAt` and immediately invalidates an already minted access JWT.
- Partially deleted states remain safe and repeatable.

### MCP authorization and tenancy

- Each static and dynamic resource URI requires its exact read permission and performs no database query on denial.
- Org-scoped OAuth bearers have no partner-axis allowlist.
- Org A invite aggregates exclude Org B rows.
- A partner call targeting an Org B device records execution, ledger, and audit under Org B.
- Conflicting explicit organization, mixed-org arrays, and inaccessible sites fail before execution.

### DCR and consent

- Unit tests cover HTTPS, IPv4 loopback, IPv6 loopback, `localhost`, private IP, remote HTTP, credentials, fragments, malformed URLs, custom schemes, and mixed arrays.
- A real-listener integration test confirms remote HTTP registration is rejected and HTTPS registration succeeds.
- Consent tests confirm the unverified warning, exact callback origin, escaped malicious display names, and fail-closed invalid redirect handling.

### Bootstrap execution

- A low-privilege member is denied under `MCP_REQUIRE_EXECUTE_ADMIN=false` even when the tool is allowlisted.
- An appropriately authorized role succeeds.
- Both bootstrap tools create a ledger before handler execution.
- Ledger creation failure prevents the handler.
- Success, thrown failure, and partial-failure results complete the ledger and uniform audit correctly.
- No test asserts a shared idempotency guarantee.

### Verification commands

Run focused API and web tests for every red-green cycle, then execute:

```bash
corepack pnpm@10.33.4 --filter @breeze/api test
corepack pnpm@10.33.4 --filter @breeze/web test
corepack pnpm@10.33.4 --filter @breeze/api typecheck
corepack pnpm@10.33.4 --filter @breeze/web typecheck
corepack pnpm@10.33.4 db:check-drift
```

Run the OAuth integration suite against a real local database when available, including the live DCR registration regression and RLS coverage contract.

## Finding Coverage

| Finding | Design section |
|---|---|
| MCP-OAUTH-01 | Authoritative OAuth grant context and scope policy |
| MCP-OAUTH-02 | Authoritative OAuth grant context and scope policy |
| MCP-OAUTH-03 | Resource-specific MCP RBAC |
| MCP-OAUTH-04 | Hashed refresh-token persistence and forced legacy revocation |
| MCP-OAUTH-05 | Authoritative MCP execution organization |
| MCP-OAUTH-06 | Organization and partner axis separation |
| MCP-OAUTH-07 | Central grant-family and client revocation |
| MCP-OAUTH-08 | DCR identity and redirect hardening |
| MCP-OAUTH-09 | DCR identity and redirect hardening |
| MCP-OAUTH-10 | Central grant-family and client revocation |
| MCP-OAUTH-11 | Bootstrap RBAC and shared Tier 3 ledger/audit lifecycle |
| MCP-OAUTH-12 | Bootstrap RBAC and shared Tier 3 ledger/audit lifecycle |

## Non-Goals

- Supporting legacy plaintext refresh tokens after deployment.
- Adding a general verified-integration administration UI.
- Replacing oidc-provider or changing the authorization-code/PKCE protocol.
- Normalizing every OAuth JSON payload field into dedicated columns.
- Merging ordinary and bootstrap tool registries wholesale.
- Adding a new shared idempotency guarantee to MCP execution.
- Refactoring unrelated API, web, or agent code.
