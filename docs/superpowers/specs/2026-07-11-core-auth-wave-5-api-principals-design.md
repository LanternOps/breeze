# Core Authentication Wave 5: API-Key Principals Design

**Finding:** SR2-15
**Depends on:** Wave 1 live user/membership authority patterns
**Parent design:** `docs/superpowers/specs/2026-07-11-core-authentication-hardening-design.md`

## Goal

Ensure human-delegated API keys never exceed their creator's current authority and provide a separate, explicit lifecycle for non-human automation.

## Principal model

Every existing API key migrates to `principal_type='human'`. No existing key is inferred or grandfathered as a service identity.

Create `service_principals` as a direct organization-scoped RLS table:

- `id uuid primary key`
- `org_id uuid not null`
- `name varchar(255) not null`
- `description text`
- `status active|disabled not null`
- `role_id uuid not null`
- `created_by uuid not null`
- `updated_by uuid not null`
- `created_at`, `updated_at`, `disabled_at`

RLS is enabled and forced in the creating migration using `breeze_has_org_access(org_id)`. The RLS coverage allowlist is updated in the same PR. `(org_id, normalized_name)` is unique for active principals.

Extend `api_keys` with:

- `principal_type human|service NOT NULL DEFAULT 'human'`
- `principal_user_id uuid NULL`
- `service_principal_id uuid NULL`

`created_by` remains non-null audit provenance for both types. Existing rows backfill `principal_user_id=created_by`. A check constraint requires exactly one principal matching the type: human means user set/service null; service means service set/user null. A composite/transactional ownership check ensures a service principal and key share `org_id`.

## Scope and permission contract

Use one supported API-key-scope catalog and one resolver:

```ts
type ApiKeyPrincipal =
  | { type: 'human'; userId: string }
  | { type: 'service'; servicePrincipalId: string };

type EffectiveApiKeyAuthority = {
  orgId: string;
  partnerId: string | null;
  allowedScopes: ReadonlySet<string>;
};

async function resolveEffectiveApiKeyAuthority(input: {
  keyId: string;
  principal: ApiKeyPrincipal;
  requestedScopes: string[];
}): Promise<EffectiveApiKeyAuthority>;
```

For human keys the resolver reloads the active creator, matching current organization/partner membership, site/org restrictions, and current permissions. Requested key scopes must remain a subset of the creator's currently delegable scopes. REST, MCP, AI, and provisioning consumers use the same result rather than mixing static and live resolution.

For service keys the resolver reloads the active service principal and its organization-scoped role, then requires key scopes to remain a subset of permissions delegated by that live role. The role is an independently managed ceiling and does not follow the creator's later role. Service principals never receive interactive-login, MFA, password, SSO, recovery, or user-profile capabilities.

Tenant status, key status/expiry, principal status, scope ceiling, and per-key rate limits all pass before request RLS context opens.

## Administration API

Add organization-scoped service-principal endpoints for list, create, update scopes/name, disable, and key issuance/rotation/revocation. Administration requires authenticated human context, MFA, organization access, and a dedicated `api_keys:read` or `api_keys:write` permission. Default administrator roles receive these permissions through the existing role catalog; custom roles do not gain them implicitly.

Key creation returns secret material exactly once. Rotation creates a new key, atomically revokes the prior key, and records both identifiers in audit without secret/hash material. Disabling a principal atomically disables all of its active keys.

Existing API-key endpoints continue to create human-delegated keys and clearly label owner/principal type. They cannot convert a human key into a service key.

## Authentication behavior

API-key middleware performs the key hash/status/expiry lookup, then calls the shared authority resolver under narrowly scoped system context. It builds DB access context only from the resolver's live tenant result.

Human key failures:

- disabled/missing creator;
- missing current membership;
- tenant mismatch;
- permission or org/site ceiling below any requested scope.

Service key failures:

- disabled/missing principal;
- org mismatch;
- principal scope reduction below key scopes.

All failures return generic invalid-or-no-longer-authorized API-key responses. Internal audits identify the reason without exposing the key.

## Migration and rollout

Migration marks all existing keys human and leaves their `created_by` intact. After deployment, keys owned by disabled/offboarded/underprivileged users fail immediately. This behavior is approved even when it interrupts existing automation.

Administrators migrate automation explicitly: create a service principal with a least-privilege organization role, issue a key whose scopes are a subset of that role, update the integration, verify usage, then revoke the human key. No automatic copy of human permissions occurs.

## Failure behavior

- Principal/key lifecycle mutations are transactional.
- Permission-cache failure cannot broaden authority because authorization reloads or version-validates current permission state.
- A deleted creator never cascades into an immortal key; deletion/neutralization disables or otherwise makes human keys unusable before user removal completes.
- Service-principal deletion is soft disable by default to preserve audit history.

## Verification

Tests cover human creator disable, membership removal, permission downgrade, site/org restrictions, tenant suspension, static REST and live MCP parity, service-principal create/scope reduction/disable, key rotation, cross-org forgery, rate limits, and audit redaction.

Real-Postgres tests prove RLS, composite organization ownership, atomic principal disable/key disable, and creator offboarding behavior. Web tests cover principal administration and one-time key display.
