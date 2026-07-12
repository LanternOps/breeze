# Core Authentication Wave 3: SSO and OIDC Hardening Design

**Findings:** SR2-10, SR2-11, SR2-12, SR2-13, SR2-14
**Depends on:** Wave 1 lifecycle foundation; Wave 2 token assurance for IdP-MFA AMR
**Parent design:** `docs/superpowers/specs/2026-07-11-core-authentication-hardening-design.md`

## Goal

Bind SSO provisioning and pending transactions to current authority, require positively verified identities, and ensure every OIDC network endpoint uses one SSRF-safe transport.

## Provider and session schema

Add `config_version integer NOT NULL DEFAULT 1` and `default_role_approved_by uuid` to `sso_providers`. The latter records the administrator whose live delegable authority must still cover `defaultRoleId` at JIT time; `createdBy` is not a substitute after later edits.

Add to `sso_sessions`:

- `provider_version integer NOT NULL`
- `link_auth_epoch integer`
- `link_session_id uuid`

Login-mode sessions require only provider version. Link-mode sessions require `link_user_id`, auth epoch, and session ID together. A database check constraint enforces the all-or-none link binding.

Existing pending sessions are deleted by migration rather than backfilled. Their ten-minute lifetime does not justify a compatibility path that would preserve the reviewed weaknesses.

## Role-delegation contract

Extract normal user-management role validation into a reusable service:

```ts
type RoleAssignmentAxis = {
  partnerId: string | null;
  orgId: string | null;
};

async function assertRoleAssignable(input: {
  actorUserId: string;
  targetRoleId: string;
  axis: RoleAssignmentAxis;
}): Promise<void>;
```

The helper verifies that the role belongs to the provider's partner/organization axis, the actor may administer that axis, and the role's effective permissions are a subset of the actor's delegable permissions. It is called when `defaultRoleId` is saved and immediately before JIT user creation. A deleted/moved/escalated role therefore cannot be used by a stale provider configuration.

Provider administration continues to require `sso:admin` plus MFA. These gates are necessary but not a substitute for delegation validation.

## Provider lifecycle and pending transactions

Creating a pending session stores the live provider version. Link-mode creation also stores the initiating user's current `auth_epoch` and access-token `sid`.

Callback processing runs in this order:

1. atomically claim the state/session so only one callback can proceed;
2. reload provider and reject non-active status or version mismatch;
3. for link mode, reload the user, compare auth epoch, verify the bound refresh family is active/unexpired, and confirm current provider/tenant authority;
4. exchange/verify identity through SSRF-safe endpoints;
5. apply email/domain/role rules;
6. link or issue a Wave 1 session.

Provider disablement or any security-relevant configuration change increments `config_version` and deletes outstanding sessions in the same transaction. Cosmetic name changes do not require a version increment.

Logout revokes the `sid` family, making bound link sessions unusable. Password reset, email commitment, status change, and membership removal invalidate them through `auth_epoch`. Both checks remain at callback time even when eager session deletion also occurs.

## Verified email semantics

Normalize OIDC identity into:

```ts
type VerifiedOidcIdentity = {
  subject: string;
  issuer: string;
  email: string;
  emailVerified: true;
  name?: string;
  amr: string[];
};
```

Generic OIDC accepts email only when a trusted ID-token or UserInfo claim explicitly establishes `email_verified === true`. Explicit false and missing verification are rejected. Provider-specific adapters may establish an equivalent guarantee only through dedicated, tested code; no generic configuration flag bypasses the requirement.

The ID-token issuer and subject remain authoritative identity keys. UserInfo cannot replace a mismatched subject. Passwordless auto-linking still requires verified domain ownership and exact normalized email.

## SSRF-safe OIDC transport

Discovery, token exchange, UserInfo, and JWKS retrieval use one OIDC HTTP client built on the existing `urlSafety.safeFetch` controls. The client enforces:

- HTTPS only and default port 443 unless an explicit safe test/development override exists;
- no embedded credentials;
- redirect limit with every target revalidated;
- DNS/IP validation before connection and no private, loopback, link-local, multicast, metadata, or reserved ranges;
- connection and overall timeouts;
- bounded response size and expected content type;
- no proxy/environment bypass outside configured infrastructure;
- structured endpoint-kind telemetry without query strings, tokens, or response bodies.

JWKS verification uses JOSE's supported custom-fetch hook backed by this client, or an equivalently safe local-JWKS cache if the installed JOSE version lacks that hook. Cache refresh and unknown-`kid` lookup must traverse the same safe client; persisted `jwks_url` is revalidated at every network use.

Discovery output is validated before persistence. Authorization, token, UserInfo, and JWKS URLs must share the issuer's origin unless an explicit provider-specific allowlist permits otherwise.

## Token assurance

SSO session issuance uses Wave 1's central issuer. `mfa=true` and factor AMR are set only when the provider has `trustsIdpMfa=true` and the verified ID token contains an accepted multi-factor AMR value under the existing IdP-MFA policy. UserInfo cannot assert MFA.

## Failure behavior

- Claimed state is not restored after callback failure; the user starts a new transaction.
- Provider/version/auth/session mismatch returns a generic expired-or-invalid SSO response.
- SSRF policy violation never falls back to ordinary `fetch` or a stored direct URL.
- Role-validation failure cannot silently substitute another/default role.
- Identity failures are audited without raw assertions, authorization codes, access tokens, or full provider responses.

## Verification

Tests cover role subset/axis validation at save and JIT time; provider disable/config-change races; logout/password-reset/link invalidation; callback single-use; positive/false/missing email verification; subject mismatch; domain and passwordless auto-link requirements; and trusted IdP MFA.

Network tests cover discovery/JWKS/UserInfo/token redirects, private IP literals, DNS rebinding between validation and connection, oversized/malformed responses, unknown `kid` refresh, and persisted endpoint revalidation. No test makes a real external network call.
