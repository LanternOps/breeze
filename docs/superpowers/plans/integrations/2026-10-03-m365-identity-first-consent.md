---
tracking_issue: LanternOps/breeze#7910
---
# M365 Customer Graph — Identity-First Admin Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse the Customer Graph consent flow (both `customer-graph-read` and `customer-graph-actions`) so Breeze first proves *who* the administrator is and *which tenant* they belong to, and only then sends them to a tenant-pinned Microsoft consent screen, followed by an application-token proof before the tenant is ever bound to the org.

**Architecture:** Today the flow is `/common/adminconsent` (returns an unauthenticated `tenant` hint) → v2 PKCE identity check pinned to that hint → executor `complete-consent` (redeem code, verify id_token, app-token probe) → bind. The new flow is (1) v2 OIDC + PKCE at `/organizations` (or the already-bound tenant) → executor `verify-identity` returns a cryptographically verified `tid`/`oid`, stored server-side on a rotated one-use session; (2) v1 tenant-specific `/{verifiedTid}/oauth2/authorize?…&prompt=admin_consent` whose returned code is discarded; (3) executor `retest` (app token + organization probe + grant reconciliation) against the verified tenant, and only then the existing CAS binding write. The executor change is additive (W1), the API reversal is one PR (W2), UX and docs follow (W3), and legacy-compat code is removed one release later (W4).

**Tech Stack:** TypeScript, Hono (API + executors), Drizzle ORM + hand-written SQL migrations (Postgres, forced RLS), Zod (`@breeze/shared/m365`), `jose` (executor JWT verification), Vitest (unit + integration), React 19 + Astro islands + i18next (web).

**Spec:** No separate spec document. The design decision is recorded in [Decision record](#decision-record) below (Option C, approved by Todd 2026-10-03 after a Claude + Codex advisor quorum). Prior plans this builds on: `2026-07-14-m365-customer-graph-read-consent.md`, `2026-07-22-m365-customer-graph-actions-consent.md`, `2026-09-08-m365-tenant-sync-1-manifest-v3-upgrade-consent.md` (same directory).

---

## Decision record

**Problem.** Microsoft's `/common/adminconsent` and `/organizations/v2.0/adminconsent` endpoints stop on the AADSTS50097 device-authentication interrupt that Conditional Access raises for policies with device filters (for example a "no persistent browser session" policy). The interactive authorize endpoint continues past that interrupt. Observed in production 2026-10-03: v1 `/{tenant}/oauth2/authorize` with `prompt=admin_consent` reached the consent screen; v2 `/authorize` rejects `prompt=admin_consent` with AADSTS901001.

**Option C — identity first, then tenant-specific consent** (chosen):

1. **Identity.** v2 OIDC authorize at `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize` (or `/{boundTenantId}/…` for reconnect of a still-bound row and for manifest upgrade), `scope=openid profile`, `nonce`, PKCE S256. The callback hands the code to the executor, which redeems it at the matching token endpoint (`/organizations/oauth2/v2.0/token` or `/{tenant}/oauth2/v2.0/token`, client-assertion audience equal to that endpoint) and fully validates the id_token: RS256 signature against Microsoft JWKS, issuer derived from `tid`, audience = client id, `exp`/`nbf`, nonce, `oid`, and `wids` containing Global Administrator or Privileged Role Administrator. The verified `tid`/`oid` are stored server-side against org/profile/attempt with an expiry; the one-use state is rotated between phases.
2. **Consent.** v1 tenant-specific `https://login.microsoftonline.com/{verifiedTid}/oauth2/authorize?client_id&response_type=code&redirect_uri&resource=https://graph.microsoft.com&prompt=admin_consent&state`. Microsoft records consent before it issues the code. **The returned code is discarded, never redeemed, never logged.**
3. **Finalize.** Executor application-token proof + grant reconciliation against the verified tenant (the existing `retestOperation` does exactly this), then the existing authoritative tenant binding write (`applyIdentityVerificationResult` today, `connectionService.ts:690-727`).

**Why.** Consent can only land in the tenant whose identity was cryptographically verified, so a forged or swapped tenant hint is impossible by construction, and this is Microsoft's documented recommended pattern ("sign the user into your app" first; learn.microsoft.com/entra/identity-platform/v2-admin-consent).

---

## Global Constraints

- **Both profiles, one implementation.** Every change goes through the shared `createConnectionService` factory (`apps/api/src/services/m365ControlPlane/connectionService.ts:319`) and the shared callback router factory (`apps/api/src/routes/m365ConsentCallback.ts:524`). No per-profile forks of lifecycle logic.
- **Credential-domain separation is unchanged.** Read and actions keep separate app registrations, certificates, executors, cookie names/paths/HMAC contexts. Never call the read executor for the actions profile or vice versa.
- **The phase-2 authorization code is never redeemed, forwarded to an executor, persisted, logged, or audited.**
- **Binding happens only after identity proof AND application-token proof**, inside the existing CAS write with `tenant_id IS NULL OR tenant_id = verifiedTenantId`.
- **Upgrade failure stays a no-op on the row** (`applyUpgradeVerificationResult` contract, `connectionService.ts:778-858`). Upgrade and bound-tenant reconnect pin both phases to the bound tenant.
- **Migrations** (CLAUDE.md): hand-written SQL in `apps/api/migrations/`, `YYYY-MM-DD-HHMMSS-<slug>.sql`, idempotent, no inner `BEGIN;`/`COMMIT;`, never edit a shipped one, and the filename must sort after the newest committed migration on `origin/main` **at commit time** (at plan time that is `2026-12-05-100000-device-live-session-indexes.sql`). Any migration that writes rows elects `breeze.scope = 'system'` first and reports row counts via `GET DIAGNOSTICS … RAISE WARNING`.
- **Column changes on `m365_consent_sessions`** (an org-cascade table, `tenantCascade.ts:630`) require a `CORE_TENANT_EXPORT_POLICY` update (`tenantExportPolicyRegistry.ts:496`) in the same PR. No new table, so no RLS/cascade/merge list changes.
- **Audit/metric enums are append-only**: `metrics.test.ts` pins array order; new events/outcomes go at the END of `M365_CUSTOMER_GRAPH_READ_EVENTS`, the actions event list, and `M365_CUSTOMER_GRAPH_READ_OUTCOMES`.
- **Web**: mutations through `runAction`; i18n key parity across every locale directory under `apps/web/src/locales/` that already carries the `m365CustomerGraphRead` / `m365CustomerGraphActions` blocks (CI-enforced).
- **Public repo**: no customer names, tenant IDs, hostnames, IPs, or Azure resource names in code, tests, docs, or runbooks. Test GUIDs use the repeating-digit pattern already used in the suites (`11111111-1111-4111-8111-111111111111`).
- **Release ordering**: W1's executor images must be deployed to every region before an API build containing W2 is released (W2's API calls `/v1/verify-identity`, which an old executor 404s → `executor_unavailable`, a safe but broken onboarding).

## Review Focus

1. **Guest administrator signing in at `/organizations`** — Entra authenticates against the account's *home* tenant, so an MSP technician who is a guest GA in the customer tenant verifies as their own home tenant, and consent + binding would target that tenant. Expected: never silently bind a tenant the operator didn't intend. Pinned by Task 11 (callback test "guest admin home tenant") and Task 14/15 (confirm-tenant interstitial shows tenant + UPN domain before consent).
2. **Microsoft adds an unexpected parameter to the v1 consent-phase redirect** (e.g. `admin_consent`, `client_info`). Expected: a strict parser fails closed with `consent_state_mismatch` rather than accepting unknown authority-bearing params; the real-tenant acceptance step (Task 17) records the actual param set and widens the allowlist only with evidence. Pinned by Task 11 parser tests.
3. **Old in-flight attempts across the deploy** (a browser holding a v1 binding cookie, or a row left in `verifying` by the old flow). Expected: `consent_expired` and an explicit restart, never a 500, never a partial binding. Pinned by Task 7 (legacy cookie inspection) and Task 13 (legacy row integration test).
4. **CA device-filter tenants (AADSTS50097)** — expected: identity phase and consent phase both complete; if Microsoft still returns an error redirect, it is classified without binding anything. Pinned by Task 11 (production 50097 error-shape test) and Task 17 (real-tenant scenario).
5. **Executor version skew** (API W2 against a pre-W1 executor). Expected: `executor_unavailable`, attempt marked failed, no binding. Pinned by Task 11 ("verify-identity 404").

---

## File Structure

| File | Responsibility | Wave |
|---|---|---|
| `packages/shared/src/m365/executorContracts.ts` | `verifyConsentIdentityRequestSchema` / `verifyConsentIdentityResultSchema` | W1 |
| `apps/m365-graph-{read,actions}-executor/src/microsoft/clientAssertion.ts` | assertion audience for `organizations` authority | W1 |
| `apps/m365-graph-{read,actions}-executor/src/microsoft/tokenClient.ts` | code redemption at `organizations` or tenant authority; app token stays GUID-only | W1 |
| `apps/m365-graph-{read,actions}-executor/src/microsoft/identity.ts` | optional expected-tenant equality; `preferred_username` extraction | W1 |
| `apps/m365-graph-{read,actions}-executor/src/operations.ts` | `verifyIdentityOperation`; `completeConsentOperation` recomposed from it + retest core | W1 |
| `apps/m365-graph-{read,actions}-executor/src/{app,internalAuth}.ts` | `POST /v1/verify-identity`, operation claim `verify-identity` | W1 |
| `apps/api/src/services/m365ControlPlane/graph{Read,Actions}ExecutorClient.ts` | `verifyConsentIdentity()` | W1 |
| `apps/api/migrations/<sorts-last>-m365-consent-identity-first.sql` | new session columns, `flow_version`, phase/field CHECKs | W2 |
| `apps/api/src/db/schema/m365.ts` | Drizzle mirror of the migration | W2 |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | classify the new columns | W2 |
| `apps/api/src/services/m365ControlPlane/browserBinding.ts` | binding v2 (`tenantId` per phase), legacy-v1 detection | W2 |
| `apps/api/src/services/m365ControlPlane/microsoftAuthorization.ts` | the only two Microsoft URL builders | W2 |
| `apps/api/src/services/m365ControlPlane/consentSessionService.ts` | v2 identity / verified-consent session rows | W2 |
| `apps/api/src/services/m365ControlPlane/connectionService.ts` | identity-first initiate, phase transition, finalization apply | W2 |
| `apps/api/src/routes/m365ConsentCallback.ts` | reversed phase handling for both profiles | W2 |
| `apps/api/src/routes/m365CustomerGraph{Read,Actions}.ts` | initiate routes set the v2 binding cookie | W2 (+W3 interstitial endpoints) |
| `apps/api/src/services/m365ControlPlane/metrics.ts` | new audit event/outcomes, `verifiedAdministratorObjectId` | W2 |
| `apps/web/src/components/integrations/M365CustomerGraph{Read,Actions}Card.tsx` + locales | step copy, confirm-tenant view | W3 |
| `docs/deploy/m365-customer-graph-{read,actions}-executor.md`, `docs/runbooks/m365-customer-graph-{read,actions}-real-tenant.md`, `apps/docs/src/content/docs/features/identity-integrations.mdx` | flow + operation docs, acceptance scenarios | W3 |

**Out of scope (verified unaffected):** the delegated communications flow (`m365_user_consent_sessions`, `apps/m365-communications-executor`) — it already signs users in at `/common` v2 with PKCE and has no admin-consent phase; `services/c2cM365.ts` and `routes/clientAi/adminOrgs.ts` also build `/adminconsent` URLs for *other* applications and may hit the same 50097 interrupt — file a follow-up issue, do not change them here.

---

## Wave breakdown

| Wave | PR | Releasable state after merge |
|---|---|---|
| **W1** | Executors + shared contract: `verify-identity` operation, `organizations` authority, optional expected tenant; API client methods (unused). | Old flow unchanged and working. New endpoint deployed dark. |
| **W2** | API reversal: migration, binding v2, URL builders, session v2, connection-service state machine, callback router reversal (both profiles), initiate routes, audit. | New flow live for both profiles; auto-continues from identity to consent. Web unchanged (response key and outcomes unchanged). Requires W1 executors deployed. |
| **W3** | Confirm-tenant interstitial (if Q1 = yes), card copy + i18n, deploy docs, runbooks, public docs, real-tenant acceptance. | Full UX. |
| **W4** | Cleanup ≥ one release after W2: tighten CHECK to `flow_version = 2`, delete legacy rows, drop v1 cookie detection, remove `/v1/complete-consent` + `CompleteConsent*` contract + client methods. | No legacy paths. |

W1 → W2 → W3 serial. W4 after a release containing W2 has been deployed to both regions.

---

# Wave 1 — Executors and shared contract (backward compatible)

### Task 1: Shared `verify-identity` contract

**Files:**
- Modify: `packages/shared/src/m365/executorContracts.ts:6-105`
- Test: `packages/shared/src/m365/executorContracts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const verifyConsentIdentityRequestSchema: z.ZodObject<…>;   // strict
  export const identityFailureCodeSchema: z.ZodEnum<['admin_role_required','tenant_mismatch','credential_unavailable','identity_token_invalid']>;
  export const verifyConsentIdentityResultSchema: z.ZodUnion<…>;
  export type VerifyConsentIdentityRequest = {
    correlationId: string; consentAttemptId: string;
    expectedTenantId: string | null;          // null => authority 'organizations'
    authorizationCode: string; codeVerifier: string; nonce: string; redirectUri: string;
  };
  export type VerifyConsentIdentityResult =
    | { success: true; tenantId: string; administratorObjectId: string; administratorUsername: string | null; verifiedAt: string }
    | { success: false; errorCode: 'admin_role_required' | 'tenant_mismatch' | 'credential_unavailable' | 'identity_token_invalid' };
  ```

- [ ] **Step 1: Write the failing tests** (append to `executorContracts.test.ts`)

```ts
import {
  verifyConsentIdentityRequestSchema,
  verifyConsentIdentityResultSchema,
} from './executorContracts';

const GUID_A = '11111111-1111-4111-8111-111111111111';
const GUID_B = '22222222-2222-4222-8222-222222222222';

function verifyRequest(overrides: Record<string, unknown> = {}) {
  return {
    correlationId: GUID_A,
    consentAttemptId: GUID_B,
    expectedTenantId: null,
    authorizationCode: 'code',
    codeVerifier: 'v'.repeat(43),
    nonce: 'n',
    redirectUri: 'https://breeze.example/api/v1/m365/consent/callback',
    ...overrides,
  };
}

describe('verify-identity contract', () => {
  it('accepts a null expected tenant (organizations authority) and a GUID', () => {
    expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest()).success).toBe(true);
    expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest({ expectedTenantId: GUID_A })).success).toBe(true);
  });

  it('rejects the literal organizations, a domain, a missing key, and extra keys', () => {
    for (const expectedTenantId of ['organizations', 'common', 'contoso.example']) {
      expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest({ expectedTenantId })).success).toBe(false);
    }
    const { expectedTenantId: _omit, ...missing } = verifyRequest();
    expect(verifyConsentIdentityRequestSchema.safeParse(missing).success).toBe(false);
    expect(verifyConsentIdentityRequestSchema.safeParse(verifyRequest({ tenantHint: GUID_A })).success).toBe(false);
  });

  it('accepts only identity-scoped success and failure results', () => {
    expect(verifyConsentIdentityResultSchema.safeParse({
      success: true, tenantId: GUID_A, administratorObjectId: GUID_B,
      administratorUsername: 'admin@tenant.example', verifiedAt: '2026-10-03T12:00:00.000Z',
    }).success).toBe(true);
    expect(verifyConsentIdentityResultSchema.safeParse({
      success: true, tenantId: GUID_A, administratorObjectId: GUID_B,
      administratorUsername: null, verifiedAt: '2026-10-03T12:00:00.000Z',
    }).success).toBe(true);
    // application-proof failures belong to retest, never to identity
    expect(verifyConsentIdentityResultSchema.safeParse({ success: false, errorCode: 'application_token_invalid' }).success).toBe(false);
    expect(verifyConsentIdentityResultSchema.safeParse({ success: false, errorCode: 'organization_probe_failed' }).success).toBe(false);
    // no grant/probe fields on an identity result
    expect(verifyConsentIdentityResultSchema.safeParse({
      success: true, tenantId: GUID_A, administratorObjectId: GUID_B, administratorUsername: null,
      verifiedAt: '2026-10-03T12:00:00.000Z', observedGrants: [],
    }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/m365/executorContracts.test.ts`
Expected: FAIL — `verifyConsentIdentityRequestSchema` is not exported.

- [ ] **Step 3: Implement** (insert after `retestRequestSchema`, `executorContracts.ts:19`)

```ts
export const verifyConsentIdentityRequestSchema = z.object({
  correlationId: guidSchema,
  consentAttemptId: guidSchema,
  expectedTenantId: guidSchema.nullable(),
  authorizationCode: z.string().min(1).max(8192),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(1).max(512),
  redirectUri: z.string().url().max(2048),
}).strict();

export const identityFailureCodeSchema = z.enum([
  'admin_role_required',
  'tenant_mismatch',
  'credential_unavailable',
  'identity_token_invalid',
]);

export const verifyConsentIdentityResultSchema = z.union([
  z.object({
    success: z.literal(true),
    tenantId: guidSchema,
    administratorObjectId: guidSchema,
    administratorUsername: z.string().min(1).max(256).nullable(),
    verifiedAt: timestampSchema,
  }).strict(),
  z.object({
    success: z.literal(false),
    errorCode: identityFailureCodeSchema,
  }).strict(),
]);

export type VerifyConsentIdentityRequest = z.infer<typeof verifyConsentIdentityRequestSchema>;
export type VerifyConsentIdentityResult = z.infer<typeof verifyConsentIdentityResultSchema>;
```

Export the four new names from `packages/shared/src/m365/index.ts` if it re-exports explicitly (check; it currently re-exports `executorContracts`).

- [ ] **Step 4: Run to verify it passes** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/m365/executorContracts.ts packages/shared/src/m365/executorContracts.test.ts packages/shared/src/m365/index.ts
git commit -m "feat(m365): shared verify-identity executor contract"
```

### Task 2: `organizations` authority for authorization-code redemption (both executors)

**Files:**
- Modify: `apps/m365-graph-read-executor/src/microsoft/clientAssertion.ts:16-34`, `apps/m365-graph-read-executor/src/microsoft/tokenClient.ts:30-36,55-58,165-191`
- Modify: the identical files under `apps/m365-graph-actions-executor/src/microsoft/` (also fix the stale comment at actions `tokenClient.ts:40-44`, which claims this executor never exchanges codes — it does, `operations.ts:137`)
- Test: `…/microsoft/clientAssertion.test.ts`, `…/microsoft/tokenClient.test.ts` in both executors

**Interfaces:**
- Produces:
  ```ts
  export type MicrosoftAuthority = string; // canonical lowercase tenant GUID, or exactly 'organizations'
  createClientAssertion(input: { clientId; authority: MicrosoftAuthority; certificatePem; privateKeyPem; now? }): Promise<string>
  MicrosoftTokenClient.exchangeAuthorizationCode(input: { authority: MicrosoftAuthority; code: string; codeVerifier: string }): Promise<OpaqueIdentityToken>
  MicrosoftTokenClient.acquireGraphAppToken(input: { tenantId: string }) // UNCHANGED: GUID only
  ```

- [ ] **Step 1: Write the failing tests** (read executor; copy verbatim into the actions executor tests)

```ts
// clientAssertion.test.ts
it('targets the organizations token endpoint when the authority is organizations', async () => {
  const jwt = await createClientAssertion({ clientId: CLIENT_ID, authority: 'organizations', certificatePem, privateKeyPem, now: NOW });
  const payload = decodeJwt(jwt);
  expect(payload.aud).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
});

it.each(['common', 'consumers', 'Organizations', 'contoso.example', '../x'])(
  'rejects authority %s', async (authority) => {
    await expect(createClientAssertion({ clientId: CLIENT_ID, authority, certificatePem, privateKeyPem })).rejects.toThrow('client_assertion_failed');
  },
);

// tokenClient.test.ts
it('redeems a code at the organizations endpoint with a matching assertion audience', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ id_token: 'id' }), { status: 200 }));
  const client = createMicrosoftTokenClient(config, { fetch });
  await client.exchangeAuthorizationCode({ authority: 'organizations', code: 'c', codeVerifier: 'v'.repeat(43) });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
  const assertion = new URLSearchParams(String(init!.body)).get('client_assertion')!;
  expect(decodeJwt(assertion).aud).toBe(url);
});

it('never requests an application token from the organizations authority', async () => {
  const fetch = vi.fn();
  const client = createMicrosoftTokenClient(config, { fetch });
  await expect(client.acquireGraphAppToken({ tenantId: 'organizations' })).rejects.toMatchObject({ code: 'token_request_invalid' });
  expect(fetch).not.toHaveBeenCalled();
});
```

Update every existing `exchangeAuthorizationCode({ tenantId: … })` call in the tests to `{ authority: … }`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/m365-graph-read-executor && npx vitest run src/microsoft/clientAssertion.test.ts src/microsoft/tokenClient.test.ts`
Expected: FAIL — `authority` unknown / audience is a GUID endpoint.

- [ ] **Step 3: Implement**

`clientAssertion.ts`:
```ts
const ORGANIZATIONS = 'organizations';
export type MicrosoftAuthority = string;

export function tokenEndpointForAuthority(authority: MicrosoftAuthority): string {
  if (authority !== ORGANIZATIONS && !CANONICAL_UUID.test(authority)) throw new ClientAssertionError();
  return `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;
}
// createClientAssertion: input.tenantId -> input.authority; audience = tokenEndpointForAuthority(input.authority)
```

`tokenClient.ts`: `request(authority, body)` uses `tokenEndpointForAuthority` (map `ClientAssertionError` to `token_request_invalid`); `exchangeAuthorizationCode` takes `authority`; `acquireGraphAppToken` first checks `CANONICAL_UUID.test(input.tenantId)` and throws `token_request_invalid` otherwise, then calls `request(input.tenantId, …)`. Update `completeConsentOperation` (`operations.ts`) to pass `authority: request.tenantHint`.

- [ ] **Step 4: Run both executors' full suites**

Run: `cd apps/m365-graph-read-executor && npx vitest run && cd ../m365-graph-actions-executor && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/m365-graph-read-executor/src/microsoft apps/m365-graph-actions-executor/src/microsoft apps/m365-graph-*/src/operations.ts
git commit -m "feat(m365-executors): redeem identity codes at the organizations authority"
```

### Task 3: Identity verification with optional expected tenant (both executors)

**Files:**
- Modify: `apps/m365-graph-read-executor/src/microsoft/identity.ts:37-40,62-125` and the identical actions-executor file
- Test: `…/microsoft/identity.test.ts` in both

**Interfaces:**
- Produces:
  ```ts
  export interface VerifiedMicrosoftAdminIdentity {
    tenantId: string; administratorObjectId: string; administratorUsername: string | null;
  }
  verifyMicrosoftAdminIdentity(
    idToken: OpaqueIdentityToken,
    expected: { expectedTenantId: string | null; clientId: string; nonce: string },
    dependencies?: VerificationDependencies,
  ): Promise<VerifiedMicrosoftAdminIdentity>
  ```
  Every other check (`identity.ts:84-118`) is kept byte-for-byte: RS256 only, JWKS, audience, required claims, issuer = `https://login.microsoftonline.com/${tid}/v2.0`, `sub`, nonce, integer `exp`/`nbf`, `wids` array, accepted roles.

- [ ] **Step 1: Write the failing tests** (rename the `verify()` helper option `tenantHint` → `expectedTenantId`, default `TENANT_ID`)

```ts
const OTHER_TENANT = '44444444-4444-4444-8444-4444444444ef';

it('accepts any verified tenant when no tenant is expected (organizations sign-in)', async () => {
  const identity = await verify(await sign({ tid: OTHER_TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }), { expectedTenantId: null });
  expect(identity.tenantId).toBe(OTHER_TENANT);
});

it('still rejects a different tenant when one is expected (reconnect / upgrade)', async () => {
  await expect(verify(await sign({ tid: OTHER_TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }), { expectedTenantId: TENANT_ID }))
    .rejects.toMatchObject({ code: 'tenant_mismatch' });
});

it('derives the issuer from tid even without an expected tenant', async () => {
  // tid says OTHER, issuer says TENANT: a token minted for one tenant cannot claim another
  await expect(verify(await sign({ tid: OTHER_TENANT }), { expectedTenantId: null }))
    .rejects.toMatchObject({ code: 'identity_token_invalid' });
});

it.each([
  ['wrong audience', { aud: '99999999-9999-4999-8999-999999999999' }],
  ['wrong nonce', { nonce: 'replayed' }],
  ['missing oid', { oid: undefined }],
  ['missing wids', { wids: undefined }],
  ['expired', { exp: NOW_SECONDS - 1 }],
  ['v1 issuer', { iss: `https://sts.windows.net/${TENANT_ID}/` }],
])('rejects %s with no expected tenant', async (_label, claims) => {
  await expect(verify(await sign(claims), { expectedTenantId: null })).rejects.toMatchObject({ code: 'identity_token_invalid' });
});

it('rejects an ineligible role set with no expected tenant', async () => {
  await expect(verify(await sign({ wids: ['fe930be7-5e62-47db-91af-98c3a49a38b1'] /* User Administrator */ }), { expectedTenantId: null }))
    .rejects.toMatchObject({ code: 'admin_role_required' });
  await expect(verify(await sign({ wids: [] }), { expectedTenantId: null }))
    .rejects.toMatchObject({ code: 'admin_role_required' });
});

it('returns preferred_username when it is a bounded string, else null', async () => {
  expect((await verify(await sign({ preferred_username: 'admin@tenant.example' }), { expectedTenantId: null })).administratorUsername)
    .toBe('admin@tenant.example');
  expect((await verify(await sign({ preferred_username: 'x'.repeat(300) }), { expectedTenantId: null })).administratorUsername).toBeNull();
  expect((await verify(await sign({ preferred_username: 42 }), { expectedTenantId: null })).administratorUsername).toBeNull();
});

it('rejects a non-canonical expected tenant before verifying the token', async () => {
  await expect(verify(await sign(), { expectedTenantId: 'organizations' as string })).rejects.toMatchObject({ code: 'identity_token_invalid' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/m365-graph-read-executor && npx vitest run src/microsoft/identity.test.ts`
Expected: FAIL — `expectedTenantId` ignored / `administratorUsername` undefined.

- [ ] **Step 3: Implement**

```ts
// precondition (replaces identity.ts:67)
if (
  (expected.expectedTenantId !== null && !canonicalExpectedGuid(expected.expectedTenantId))
  || !canonicalExpectedGuid(expected.clientId)
  || /* nonce + idToken checks unchanged */
) throw failure('identity_token_invalid');

// replaces identity.ts:120
if (expected.expectedTenantId !== null && tenantId !== expected.expectedTenantId) throw failure('tenant_mismatch');

// after the role check
const username = typeof payload.preferred_username === 'string'
  && payload.preferred_username.length > 0
  && payload.preferred_username.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(payload.preferred_username)
  ? payload.preferred_username
  : null;
return { tenantId, administratorObjectId, administratorUsername: username };
```

Update `completeConsentOperation` to pass `{ expectedTenantId: request.tenantHint, … }` (keeps the old flow's mandatory equality, since the old contract's `tenantHint` is a required GUID).

- [ ] **Step 4: Run both executors' identity + operations tests** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(m365-executors): optional expected tenant in admin identity verification"
```

### Task 4: `verifyIdentityOperation` and `POST /v1/verify-identity` (both executors)

**Files:**
- Modify: `apps/m365-graph-read-executor/src/operations.ts:124-178,322-344`, `src/app.ts:30-35,140-160,225-230`, `src/internalAuth.ts:8`
- Modify: the same three files in `apps/m365-graph-actions-executor/src/` (`operations.ts:120-174,250-269`, `app.ts:104-155`, `internalAuth.ts:8`)
- Test: `operations.test.ts`, `app.test.ts`, `internalAuth.test.ts` in both

**Interfaces:**
- Consumes: Task 1 schemas, Task 2 `authority`, Task 3 `expectedTenantId`.
- Produces:
  ```ts
  export async function verifyIdentityOperation(
    request: VerifyConsentIdentityRequest,
    dependencies: ExecutorOperationDependencies,
  ): Promise<VerifyConsentIdentityResult>;
  // createExecutorOperations(...) gains: verifyIdentity(request) => verifyIdentityOperation(request, dependencies)
  // ExecutorAppDependencies gains: verifyIdentity(request: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>
  // ExecutorOperation union gains 'verify-identity'
  ```
  `completeConsentOperation` is re-expressed as: `verifyIdentityOperation({...request, expectedTenantId: request.tenantHint})` then the private `applicationProof(tenantId, deps)` helper extracted from `retestOperation`, adding `administratorObjectId`. Behavior identical (existing tests stay green).

- [ ] **Step 1: Write the failing tests** (`operations.test.ts`, read executor; mirror in actions)

```ts
import { verifyIdentityOperation } from './operations';

function verifyRequest(overrides: Partial<VerifyConsentIdentityRequest> = {}): VerifyConsentIdentityRequest {
  return {
    correlationId: CORRELATION_ID,
    consentAttemptId: '66666666-6666-4666-8666-666666666666',
    expectedTenantId: null,
    authorizationCode: 'code',
    codeVerifier: 'v'.repeat(43),
    nonce: 'nonce',
    redirectUri: CALLBACK_URL,
    ...overrides,
  };
}

describe('verifyIdentityOperation', () => {
  it('redeems at organizations when no tenant is expected and returns the verified identity', async () => {
    const deps = dependencies();
    deps.verifyIdentity.mockResolvedValue({ tenantId: TENANT_ID, administratorObjectId: ADMIN_ID, administratorUsername: 'a@t.example' });
    const result = await verifyIdentityOperation(verifyRequest(), deps);
    const tokenClient = deps.createTokenClient.mock.results[0]!.value;
    expect(tokenClient.exchangeAuthorizationCode).toHaveBeenCalledWith({ authority: 'organizations', code: 'code', codeVerifier: 'v'.repeat(43) });
    expect(deps.verifyIdentity).toHaveBeenCalledWith('identity-token', { expectedTenantId: null, clientId: CLIENT_ID, nonce: 'nonce' });
    expect(result).toMatchObject({ success: true, tenantId: TENANT_ID, administratorObjectId: ADMIN_ID, administratorUsername: 'a@t.example' });
  });

  it('redeems at the expected tenant authority for reconnect/upgrade', async () => {
    const deps = dependencies();
    await verifyIdentityOperation(verifyRequest({ expectedTenantId: TENANT_ID }), deps);
    expect(deps.createTokenClient.mock.results[0]!.value.exchangeAuthorizationCode)
      .toHaveBeenCalledWith(expect.objectContaining({ authority: TENANT_ID }));
  });

  it('never acquires an application token or probes Graph', async () => {
    const deps = dependencies();
    await verifyIdentityOperation(verifyRequest(), deps);
    expect(deps.createTokenClient.mock.results[0]!.value.acquireGraphAppToken).not.toHaveBeenCalled();
    expect(deps.graphClient.probeTenant).not.toHaveBeenCalled();
  });

  it('fails closed on a redirect URI that does not byte-match configuration', async () => {
    const deps = dependencies();
    expect(await verifyIdentityOperation(verifyRequest({ redirectUri: `${CALLBACK_URL}/` }), deps))
      .toEqual({ success: false, errorCode: 'identity_token_invalid' });
    expect(deps.createTokenClient).not.toHaveBeenCalled();
  });

  it.each([
    ['token endpoint rejected the code (replayed code)', new MicrosoftTokenClientError('token_provider_rejected'), 'identity_token_invalid'],
    ['tenant mismatch', new MicrosoftIdentityFailure('tenant_mismatch'), 'tenant_mismatch'],
    ['role missing', new MicrosoftIdentityFailure('admin_role_required'), 'admin_role_required'],
  ])('maps %s', async (_label, error, code) => {
    const deps = dependencies();
    deps.verifyIdentity.mockRejectedValue(error);
    expect(await verifyIdentityOperation(verifyRequest(), deps)).toEqual({ success: false, errorCode: code });
  });

  it('wipes the credential PEMs on every exit path', async () => {
    const credential = { certificatePem: 'cert', privateKeyPem: 'key' };
    const deps = { ...dependencies(), certificateProvider: { getConfiguredCertificate: vi.fn().mockResolvedValue(credential) } };
    deps.verifyIdentity.mockRejectedValue(new Error('boom'));
    await verifyIdentityOperation(verifyRequest(), deps);
    expect(credential).toEqual({ certificatePem: '', privateKeyPem: '' });
  });
});
```

`app.test.ts`:
```ts
it('routes POST /v1/verify-identity with a verify-identity operation claim only', async () => {
  const verifyIdentity = vi.fn().mockResolvedValue({ success: false, errorCode: 'identity_token_invalid' });
  const app = createExecutorApp({ ...appDeps(), verifyIdentity });
  const ok = await post(app, '/v1/verify-identity', verifyRequestBody, { operation: 'verify-identity' });
  expect(ok.status).toBe(200);
  const crossOp = await post(app, '/v1/verify-identity', verifyRequestBody, { operation: 'complete-consent' });
  expect(crossOp.status).toBe(401);
  const wrongBody = await post(app, '/v1/verify-identity', { ...verifyRequestBody, tenantHint: verifyRequestBody.consentAttemptId }, { operation: 'verify-identity' });
  expect(wrongBody.status).toBe(400);
});
```
(`post`/`appDeps` are the existing helpers in each `app.test.ts`; add `verifyIdentity` to `appDeps()`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/m365-graph-read-executor && npx vitest run src/operations.test.ts src/app.test.ts src/internalAuth.test.ts`
Expected: FAIL — `verifyIdentityOperation` not exported, route 404.

- [ ] **Step 3: Implement**

```ts
export async function verifyIdentityOperation(
  request: VerifyConsentIdentityRequest,
  dependencies: ExecutorOperationDependencies,
): Promise<VerifyConsentIdentityResult> {
  if (request.redirectUri !== dependencies.callbackUrl) return { success: false, errorCode: 'identity_token_invalid' };
  const credential = await fetchCredential(dependencies);
  if (typeof credential === 'string') return { success: false, errorCode: 'credential_unavailable' };
  let tokenClient: MicrosoftTokenClient | undefined;
  try {
    try { tokenClient = dependencies.createTokenClient(credential); }
    catch { return { success: false, errorCode: 'credential_unavailable' }; }
    try {
      const idToken = await tokenClient.exchangeAuthorizationCode({
        authority: request.expectedTenantId ?? 'organizations',
        code: request.authorizationCode,
        codeVerifier: request.codeVerifier,
      });
      const identity = await dependencies.verifyIdentity(idToken, {
        expectedTenantId: request.expectedTenantId,
        clientId: dependencies.clientId,
        nonce: request.nonce,
      });
      return verifyConsentIdentityResultSchema.parse({
        success: true, ...identity, verifiedAt: new Date().toISOString(),
      });
    } catch (error) {
      const code = mappedFailure(error, 'identity');
      return {
        success: false,
        errorCode: code === 'admin_role_required' || code === 'tenant_mismatch' ? code : 'identity_token_invalid',
      };
    }
  } finally {
    tokenClient = undefined;
    credential.certificatePem = '';
    credential.privateKeyPem = '';
  }
}
```
Extract `applicationProof(tenantId, tokenClient, dependencies)` from `retestOperation` (the `acquireGraphAppToken` → `probeTenant` → `proofFailure` → `verifiedResult` block) and use it from both `retestOperation` and the recomposed `completeConsentOperation`. Add the `verify-identity` branch in `app.ts` mirroring the `retest` branch (`safeParse` request → correlation check → `safeParse` result → 500 on schema mismatch), mount `app.post('/v1/verify-identity', …)`, extend `ExecutorOperation` in `internalAuth.ts`.

- [ ] **Step 4: Run both executors' full suites** — Expected: PASS (all existing `completeConsentOperation` tests unchanged and green).

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(m365-executors): add verify-identity operation; recompose complete-consent"
```

### Task 5: API executor clients — `verifyConsentIdentity`

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/graphReadExecutorClient.ts:32,109-116,230-250`, `graphActionsExecutorClient.ts:22-35,73-80,200-215`
- Test: `graphReadExecutorClient.test.ts`, `graphActionsExecutorClient.test.ts`

**Interfaces:**
- Produces: `GraphReadExecutorClient.verifyConsentIdentity(input: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>` and the same on `GraphActionsExecutorClient`; `ExecutorOperation` gains `'verify-identity'` → `'/v1/verify-identity'`.

- [ ] **Step 1: Failing tests** (both client test files; follow the file's existing `completeIdentityVerification` test shape)

```ts
it('posts verify-identity with a verify-identity operation claim and parses the result', async () => {
  const fetch = mockFetchJson({ success: true, tenantId: TENANT_ID, administratorObjectId: ADMIN_ID, administratorUsername: null, verifiedAt: '2026-10-03T12:00:00.000Z' });
  const client = createClient({ fetch });
  const result = await client.verifyConsentIdentity(verifyRequest());
  expect(fetch).toHaveBeenCalledWith(`${EXECUTOR_URL}/v1/verify-identity`, expect.anything());
  expect(decodeInternalJwt(fetch).operation).toBe('verify-identity');
  expect(result.success).toBe(true);
});

it('rejects a request carrying the legacy tenantHint field before any network call', async () => {
  const fetch = vi.fn();
  const client = createClient({ fetch });
  await expect(client.verifyConsentIdentity({ ...verifyRequest(), tenantHint: TENANT_ID } as never)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/m365ControlPlane/graphReadExecutorClient.test.ts src/services/m365ControlPlane/graphActionsExecutorClient.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — add the endpoint map entry and a method mirroring `completeIdentityVerification` (`verifyConsentIdentityRequestSchema.safeParse` → `invoke('verify-identity', …, verifyConsentIdentityResultSchema.parse)`).
- [ ] **Step 4: Run** — Expected: PASS. Also `cd apps/api && npx tsc --noEmit -p .` (or the repo's API typecheck task).
- [ ] **Step 5: Commit + open W1 PR**

```bash
git commit -am "feat(m365): API executor clients can call verify-identity"
```
W1 PR body: executors gain a dark endpoint; old flow untouched; **deploy W1 executor images to every region before releasing W2**.

---

# Wave 2 — API reversal (both profiles)

### Task 6: Migration, Drizzle schema, export-policy registry

**Files:**
- Create: `apps/api/migrations/2026-12-06-090000-m365-consent-identity-first.sql` (rename at commit time if `origin/main` has anything sorting later: `git fetch && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1`)
- Modify: `apps/api/src/db/schema/m365.ts:101-182`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:496`
- Test: `apps/api/src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts` (new cases), plus `pnpm db:check-drift`

**Interfaces:**
- Produces (Drizzle, `m365ConsentSessions`):
  ```ts
  export type M365ConsentPhase = 'admin_consent' | 'identity_verification' | 'tenant_confirmation';
  flowVersion: smallint('flow_version').notNull().default(1)          // new code always writes 2
  verifiedTenantId: uuid('verified_tenant_id')
  verifiedAdminObjectId: uuid('verified_admin_object_id')
  verifiedAdminUsername: varchar('verified_admin_username', { length: 256 })
  identityVerifiedAt: timestamp('identity_verified_at', { withTimezone: true })
  ```
  v2 row shapes (enforced by CHECK):
  - `identity_verification`: `nonce`, `code_verifier` NOT NULL; `tenant_hint_hash` = sha256 of the expected tenant, or NULL for `/organizations`; all `verified_*` NULL.
  - `tenant_confirmation` | `admin_consent`: `nonce`, `code_verifier`, `tenant_hint_hash` NULL; `verified_tenant_id`, `verified_admin_object_id`, `identity_verified_at` NOT NULL.
  - v1 rows keep the old rule (in-flight rows at deploy time; removed in W4).

- [ ] **Step 1: Write the failing integration tests** (append to `m365ConsentSessionsRls.integration.test.ts`; reuse its existing fixture helpers for an org, user, and connection row and its system-scope insert helper)

```ts
describe('identity-first session shapes (flow_version 2)', () => {
  it('accepts a v2 identity row with no expected tenant', async () => {
    await expect(insertSession({ flowVersion: 2, phase: 'identity_verification', tenantHintHash: null, nonce: 'n', codeVerifier: 'v'.repeat(43) })).resolves.toBeDefined();
  });
  it('accepts a v2 admin_consent row carrying the verified identity', async () => {
    await expect(insertSession({ flowVersion: 2, phase: 'admin_consent', verifiedTenantId: TENANT_A, verifiedAdminObjectId: ADMIN, identityVerifiedAt: new Date() })).resolves.toBeDefined();
  });
  it('rejects a v2 admin_consent row without a verified tenant (23514)', async () => {
    await expect(insertSession({ flowVersion: 2, phase: 'admin_consent' })).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects a v2 admin_consent row that still carries a PKCE verifier (23514)', async () => {
    await expect(insertSession({ flowVersion: 2, phase: 'admin_consent', verifiedTenantId: TENANT_A, verifiedAdminObjectId: ADMIN, identityVerifiedAt: new Date(), codeVerifier: 'v'.repeat(43) }))
      .rejects.toMatchObject({ code: '23514' });
  });
  it('rejects a v2 identity row with verified fields pre-filled (23514)', async () => {
    await expect(insertSession({ flowVersion: 2, phase: 'identity_verification', nonce: 'n', codeVerifier: 'v'.repeat(43), verifiedTenantId: TENANT_A }))
      .rejects.toMatchObject({ code: '23514' });
  });
  it('still accepts both legacy v1 shapes (in-flight rows at deploy time)', async () => {
    await expect(insertSession({ flowVersion: 1, phase: 'admin_consent' })).resolves.toBeDefined();
    await expect(insertSession({ flowVersion: 1, phase: 'identity_verification', tenantHintHash: 'a'.repeat(64), nonce: 'n', codeVerifier: 'v'.repeat(43) })).resolves.toBeDefined();
  });
  it('rejects flow_version 3 (23514)', async () => {
    await expect(insertSession({ flowVersion: 3, phase: 'identity_verification', nonce: 'n', codeVerifier: 'v'.repeat(43) })).rejects.toMatchObject({ code: '23514' });
  });
  it('remains unreadable to an org-scoped breeze_app context', async () => {
    await insertSession({ flowVersion: 2, phase: 'admin_consent', verifiedTenantId: TENANT_A, verifiedAdminObjectId: ADMIN, identityVerifiedAt: new Date() });
    expect(await selectSessionsAsOrg(ORG_ID)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts`
Expected: FAIL — column `flow_version` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- M365 Customer Graph identity-first admin consent.
-- The consent-session phases are reversed: identity verification (v2 OIDC +
-- PKCE) now runs FIRST, and the admin-consent phase carries the tenant and
-- administrator that phase cryptographically verified. flow_version tells the
-- two layouts apart; v1 rows are in-flight sessions from before this deploy
-- (10-minute TTL) and are removed by a later fix-forward migration.
--
-- DDL only: no rows are written, so no breeze.scope election is required.

ALTER TABLE m365_consent_sessions
  ADD COLUMN IF NOT EXISTS flow_version smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS verified_tenant_id uuid,
  ADD COLUMN IF NOT EXISTS verified_admin_object_id uuid,
  ADD COLUMN IF NOT EXISTS verified_admin_username varchar(256),
  ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm365_consent_sessions_flow_version_check'
      AND conrelid = 'public.m365_consent_sessions'::regclass
  ) THEN
    ALTER TABLE m365_consent_sessions
      ADD CONSTRAINT m365_consent_sessions_flow_version_check
      CHECK (flow_version IN (1, 2));
  END IF;
END $$;

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_phase_check
  CHECK (phase IN ('admin_consent', 'identity_verification', 'tenant_confirmation'));

ALTER TABLE m365_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_consent_sessions_phase_fields_check;
ALTER TABLE m365_consent_sessions
  ADD CONSTRAINT m365_consent_sessions_phase_fields_check CHECK (
    (
      flow_version = 1
      AND verified_tenant_id IS NULL
      AND verified_admin_object_id IS NULL
      AND verified_admin_username IS NULL
      AND identity_verified_at IS NULL
      AND (
        (phase = 'admin_consent'
          AND tenant_hint_hash IS NULL AND nonce IS NULL AND code_verifier IS NULL)
        OR (phase = 'identity_verification'
          AND tenant_hint_hash IS NOT NULL AND nonce IS NOT NULL AND code_verifier IS NOT NULL)
      )
    ) OR (
      flow_version = 2
      AND phase = 'identity_verification'
      AND nonce IS NOT NULL
      AND code_verifier IS NOT NULL
      AND verified_tenant_id IS NULL
      AND verified_admin_object_id IS NULL
      AND verified_admin_username IS NULL
      AND identity_verified_at IS NULL
    ) OR (
      flow_version = 2
      AND phase IN ('tenant_confirmation', 'admin_consent')
      AND tenant_hint_hash IS NULL
      AND nonce IS NULL
      AND code_verifier IS NULL
      AND verified_tenant_id IS NOT NULL
      AND verified_admin_object_id IS NOT NULL
      AND identity_verified_at IS NOT NULL
    )
  );
```

Mirror in `m365.ts` (columns above; `phaseCheck` and `phaseFieldsCheck` SQL identical to the migration; new `flowVersionCheck`). `tenant_confirmation` is only written by W3 Task 14; it is admitted now so W3 needs no migration (if Q1 = no, W4 drops it from the CHECK).

Export policy (`tenantExportPolicyRegistry.ts:496`) — add `flow_version`, `verified_tenant_id`, `verified_admin_object_id`, `verified_admin_username`, `identity_verified_at` to `included` (identifiers and timestamps; none contains a `SUSPICIOUS_NAME_PARTS` fragment from `tenantExportPolicy.ts:42`; none is json/jsonb/bytea).

- [ ] **Step 4: Run**

```bash
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
cd ../.. && DATABASE_URL=… pnpm db:check-drift
```
Expected: all PASS; drift clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/*m365-consent-identity-first.sql apps/api/src/db/schema/m365.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/m365ConsentSessionsRls.integration.test.ts
git commit -m "feat(m365): consent session columns for identity-first consent"
```

### Task 7: Browser binding v2

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/browserBinding.ts:10-58,180-281`
- Test: `apps/api/src/services/m365ControlPlane/browserBinding.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface M365ConsentBrowserBinding {
    phase: 'identity_verification' | 'admin_consent';
    rawState: string;
    connectionId: string;
    consentAttemptId: string;
    /** identity_verification: tenant the authority was pinned to, or null for /organizations.
     *  admin_consent: the tenant verified in the identity phase (required). */
    tenantId: string | null;
  }
  export type M365ConsentBindingInspection =
    | { status: 'valid'; binding: M365ConsentBrowserBinding }
    | { status: 'expired' }
    | { status: 'legacy' }      // a correctly-signed v1 cookie from the old flow
    | { status: 'invalid' };
  ```
  HMAC contexts become `breeze:m365-customer-graph-read:browser-binding:v2` and `…-actions:browser-binding:v2`; v1 contexts are retained **only** for `legacy` detection (removed in W4). Cookie names and paths unchanged.

- [ ] **Step 1: Failing tests**

```ts
it('requires a verified tenant on the admin_consent phase and allows null on identity', () => {
  expect(() => readBinding.buildBindingCookie({ ...base, phase: 'admin_consent', tenantId: null }, env)).toThrow('m365_consent_binding_invalid');
  expect(() => readBinding.buildBindingCookie({ ...base, phase: 'identity_verification', tenantId: null }, env)).not.toThrow();
  expect(() => readBinding.buildBindingCookie({ ...base, phase: 'identity_verification', tenantId: TENANT }, env)).not.toThrow();
});

it('reports a v1-signed cookie as legacy, not valid', () => {
  const v1 = signWithContext('breeze:m365-customer-graph-read:browser-binding:v1', { ...v1Payload, phase: 'admin_consent', tenantHint: null });
  expect(inspectM365ConsentBindingCookie(v1, env).status).toBe('legacy');
});

it('reports an expired v1 cookie as legacy too (restart is the only remedy either way)', () => { /* same, expiresAt in the past */ });

it('never accepts a v2 read cookie on the actions instance', () => {
  const read = buildM365ConsentBindingCookie({ ...base, phase: 'identity_verification', tenantId: null }, env);
  expect(inspectM365ActionsConsentBindingCookie(rename(read, ACTIONS_COOKIE_NAME), env).status).toBe('invalid');
});
```
(`signWithContext` is a local test helper computing the same base64url payload + HMAC as `createM365ConsentBinding`; `rename` swaps the cookie name.)

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/m365ControlPlane/browserBinding.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — rename `tenantHint` → `tenantId` in the type and `validBinding` key list; phase rule: `admin_consent` ⇒ GUID, `identity_verification` ⇒ `null | GUID`; add `legacyHmacContext` to `M365ConsentBindingConfig` and in `inspectBindingCookie`, when the v2 MAC fails, recompute with the legacy context and return `{ status: 'legacy' }` on a match (no payload is decoded or trusted).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(m365): browser binding v2 for identity-first consent"`

### Task 8: Centralized Microsoft URL builders

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/microsoftAuthorization.ts` (whole file)
- Test: `apps/api/src/services/m365ControlPlane/microsoftAuthorization.test.ts`

Note: `buildMicrosoftAdminConsentUrl` (`microsoftAuthorization.ts:49`) is already unused in production code — `connectionService.ts:497-501` and `:572-576` build the `/common/adminconsent` URL inline. Both inline copies and that builder are deleted; these two functions become the only URL construction.

**Interfaces:**
- Produces:
  ```ts
  export type MicrosoftIdentityAuthority = 'organizations' | string; // or a canonical tenant GUID
  export function buildMicrosoftIdentityAuthorizationUrl(input: {
    authority: MicrosoftIdentityAuthority; clientId: string; redirectUri: string;
    expectedCallbackPath: string; state: string; nonce: string; codeChallenge: string;
  }): string; // v2 /{authority}/oauth2/v2.0/authorize, scope 'openid profile', response_mode query, S256
  export function buildMicrosoftTenantAdminConsentUrl(input: {
    tenantId: string; clientId: string; redirectUri: string; expectedCallbackPath: string; state: string;
  }): string; // v1 /{tenantId}/oauth2/authorize, response_type code, resource graph, prompt admin_consent
  ```
  `expectedCallbackPath` becomes required (both profiles pass it; the default to the read path is a latent footgun for the actions profile).

- [ ] **Step 1: Failing tests**

```ts
const CLIENT = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';
const READ_CB = 'https://breeze.example/api/v1/m365/consent/callback';
const PATH = '/api/v1/m365/consent/callback';

it('builds the organizations identity URL', () => {
  const url = new URL(buildMicrosoftIdentityAuthorizationUrl({ authority: 'organizations', clientId: CLIENT, redirectUri: READ_CB, expectedCallbackPath: PATH, state: 's', nonce: 'n', codeChallenge: 'c' }));
  expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: CLIENT, response_type: 'code', redirect_uri: READ_CB, response_mode: 'query',
    scope: 'openid profile', state: 's', nonce: 'n', code_challenge: 'c', code_challenge_method: 'S256',
  });
  expect(url.searchParams.has('prompt')).toBe(false);
});

it.each(['common', 'consumers', 'contoso.example', 'ORGANIZATIONS'])('rejects identity authority %s', (authority) => {
  expect(() => buildMicrosoftIdentityAuthorizationUrl({ authority, clientId: CLIENT, redirectUri: READ_CB, expectedCallbackPath: PATH, state: 's', nonce: 'n', codeChallenge: 'c' }))
    .toThrow('m365_authorization_invalid');
});

it('builds the v1 tenant-pinned admin-consent URL with exactly the decided parameters', () => {
  const url = new URL(buildMicrosoftTenantAdminConsentUrl({ tenantId: TENANT, clientId: CLIENT, redirectUri: READ_CB, expectedCallbackPath: PATH, state: 's2' }));
  expect(url.origin + url.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/authorize`);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: CLIENT, response_type: 'code', redirect_uri: READ_CB,
    resource: 'https://graph.microsoft.com', prompt: 'admin_consent', state: 's2',
  });
});

it.each(['organizations', 'common', 'not-a-guid'])('refuses to build a consent URL for non-tenant %s', (tenantId) => {
  expect(() => buildMicrosoftTenantAdminConsentUrl({ tenantId, clientId: CLIENT, redirectUri: READ_CB, expectedCallbackPath: PATH, state: 's' })).toThrow('m365_authorization_invalid');
});

it('rejects a redirect URI whose path is not the profile callback', () => {
  expect(() => buildMicrosoftTenantAdminConsentUrl({ tenantId: TENANT, clientId: CLIENT, redirectUri: READ_CB, expectedCallbackPath: '/api/v1/m365/actions-consent/callback', state: 's' }))
    .toThrow('m365_authorization_invalid');
});

it('no longer exports the /common/adminconsent builder', async () => {
  expect('buildMicrosoftAdminConsentUrl' in (await import('./microsoftAuthorization'))).toBe(false);
});
```

- [ ] **Step 2: Run** `npx vitest run src/services/m365ControlPlane/microsoftAuthorization.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — `requireAuthority(v)` accepts exactly `'organizations'` or the `UUID` regex; `buildMicrosoftTenantAdminConsentUrl` uses `requireUuid`; delete `buildMicrosoftAdminConsentUrl` and the `CALLBACK_PATH` default.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(m365): tenant-pinned v1 admin-consent and authority-aware identity URL builders"`

### Task 9: Consent-session service v2

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/consentSessionService.ts:53-210,255-272`
- Test: `apps/api/src/services/m365ControlPlane/consentSessionService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VerifiedConsentIdentity {
    tenantId: string; administratorObjectId: string; administratorUsername: string | null; verifiedAt: Date;
  }
  export interface CreatedIdentitySession extends CreatedConsentSession {
    nonce: string; codeChallenge: string;
  }
  export function createIdentitySessionInTransaction(
    input: ConsentSessionOwnerInput & { expectedTenantId: string | null },
  ): Promise<CreatedIdentitySession>;                       // phase identity_verification, flow_version 2
  export function insertVerifiedConsentSessionInTransaction(
    input: ConsentSessionOwnerInput & { phase: 'admin_consent' | 'tenant_confirmation'; verified: VerifiedConsentIdentity },
  ): Promise<CreatedConsentSession>;                        // flow_version 2, nonce/verifier/hint NULL
  export function verifiedIdentityFromSession(session: M365ConsentSession): VerifiedConsentIdentity | null;
  ```
  `consumeConsentSessionInTransaction` and `readConsentSessionPurpose` add `eq(m365ConsentSessions.flowVersion, 2)` — a legacy v1 row can never be consumed by new code. Delete `createAdminConsentSessionInTransaction`, `createAdminConsentSession`, `createIdentityVerificationSession*`, `prepareIdentityVerificationSession`, `insertPreparedIdentityVerificationSessionInTransaction`, `PreparedIdentityVerificationSession` (all callers are rewritten in Tasks 10–11; `tsc` proves it).

- [ ] **Step 1: Failing tests** (this file mocks Drizzle per `breeze-testing`; assert on captured insert values / where-clause SQL)

```ts
it('creates a flow-2 identity session with a null hint hash for /organizations', async () => {
  const created = await createIdentitySessionInTransaction({ ...owner, expectedTenantId: null });
  expect(lastInsertValues()).toMatchObject({ phase: 'identity_verification', flowVersion: 2, tenantHintHash: null });
  expect(lastInsertValues().codeVerifier).toHaveLength(43);
  expect(created.codeChallenge).toBe(createHash('sha256').update(lastInsertValues().codeVerifier).digest('base64url'));
  expect(created.nonce).toBe(lastInsertValues().nonce);
});

it('hashes the expected tenant when one is pinned', async () => {
  await createIdentitySessionInTransaction({ ...owner, expectedTenantId: TENANT });
  expect(lastInsertValues().tenantHintHash).toBe(hashTenantHint(TENANT));
});

it('stores the verified identity on a flow-2 admin_consent row and nothing PKCE-shaped', async () => {
  await insertVerifiedConsentSessionInTransaction({ ...owner, phase: 'admin_consent', verified });
  expect(lastInsertValues()).toMatchObject({
    phase: 'admin_consent', flowVersion: 2, tenantHintHash: null, nonce: null, codeVerifier: null,
    verifiedTenantId: verified.tenantId, verifiedAdminObjectId: verified.administratorObjectId,
    verifiedAdminUsername: verified.administratorUsername, identityVerifiedAt: verified.verifiedAt,
  });
});

it('rotates state: the verified row never reuses the identity state', async () => {
  const identity = await createIdentitySessionInTransaction({ ...owner, expectedTenantId: null });
  const consent = await insertVerifiedConsentSessionInTransaction({ ...owner, phase: 'admin_consent', verified });
  expect(consent.rawState).not.toBe(identity.rawState);
});

it('only ever consumes flow-2 rows', async () => {
  await consumeConsentSessionInTransaction({ ...attemptInput, rawState: 's', phase: 'admin_consent' });
  expect(lastDeleteWhereSql()).toContain('"flow_version" = ');
});
```

- [ ] **Step 2: Run** `npx vitest run src/services/m365ControlPlane/consentSessionService.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — `insertConsentSessionInTransaction` gains `flowVersion: 2` and the verified columns in its `Pick`; `createIdentitySessionInTransaction` generates verifier/challenge/nonce (same generators as today's `prepareIdentityVerificationSession`) and calls it with `tenantHintHash: expectedTenantId ? hashTenantHint(expectedTenantId) : null`; `verifiedIdentityFromSession` returns null unless `flowVersion === 2` and all three NOT-NULL verified fields are present.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(m365): v2 consent sessions carry the verified identity"`

### Task 10: Connection-service state machine

**Files:**
- Modify: `apps/api/src/services/m365ControlPlane/connectionService.ts:208-300` (interfaces), `:421-503` (`initiateConsent`), `:516-578` (`initiateUpgradeConsent`), `:594-646` (delete `transitionAdminConsentToIdentity`), `:665-728` (`applyIdentityVerificationResult` → finalization), `:743-858` (upgrade transition/apply), `:1060-1097` (exports)
- Modify: `apps/api/src/services/m365ControlPlane/writeActionConnectionService.ts` (re-export the renamed members)
- Test: `apps/api/src/services/m365ControlPlane/connectionService.test.ts`, `writeActionConnectionService.test.ts`

**Interfaces:**
- Consumes: Task 7 `M365ConsentBrowserBinding`, Task 8 builders, Task 9 session functions, shared `RetestResult`.
- Produces (on `ConnectionService<P, Client>`; read aliases exported with the same names minus nothing — `initiateCustomerGraphReadConsent` etc. keep their names):
  ```ts
  interface InitiatedConsent<P> {
    connection: M365ConnectionSnapshot<P>;
    binding: M365ConsentBrowserBinding;   // phase identity_verification
    authorizationUrl: string;             // v2 identity URL
  }
  initiateConsent(input: InitiateConsentInput): Promise<InitiatedConsent<P>>;
  initiateUpgradeConsent(input: InitiateUpgradeConsentInput): Promise<InitiatedConsent<P>>;

  transitionIdentityToConsent(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    purpose: M365ConsentPurpose;
    actorId: string;
    verified: VerifiedConsentIdentity;
    nextPhase: 'admin_consent' | 'tenant_confirmation';   // W2 always passes 'admin_consent'
  }): Promise<{ rawState: string; verifiedTenantId: string }>;

  beginConsentFinalization(input: {
    attempt: M365ConsentAttemptSnapshot<P>;
    rawConsentState: string;
  }): Promise<{ attempt: M365ConsentAttemptSnapshot<P>; purpose: M365ConsentPurpose; verified: VerifiedConsentIdentity; actorId: string }>;

  applyConsentFinalizationResult(
    input: M365ConsentAttemptSnapshot<P>,               // status 'verifying'
    finalization: { verifiedTenantId: string; result: RetestResult },
  ): Promise<M365ConnectionSnapshot<P>>;

  applyUpgradeFinalizationResult(
    input: M365ConsentAttemptSnapshot<P>,               // status active|degraded
    finalization: { verifiedTenantId: string; result: RetestResult },
  ): Promise<AppliedUpgradeVerification<P>>;

  finalizeWithExecutor(client: Client, request: RetestRequest): Promise<RetestResult>; // = deps.retest
  ```
  Removed: `markAdminConsentReturned` (no production caller — confirm with `grep -rn markAdminConsentReturned apps/api/src`), `transitionAdminConsentToIdentity`, `transitionUpgradeConsentToIdentity`, `applyIdentityVerificationResult`, `applyUpgradeVerificationResult` (renamed above).

Behavior contract:

| Step | initial (`purpose='initial'`) | upgrade (`purpose='upgrade'`) |
|---|---|---|
| initiate | existing rotation + `pending-consent` (unchanged); authority = `existing.tenantId ?? 'organizations'` | no row write (unchanged); authority = bound `tenantId` (required) |
| `transitionIdentityToConsent` | system txn, advisory lock `${orgId}/${profile}`, row `FOR UPDATE` via `attemptPredicate` with status `pending-consent`; if row `tenantId` is set it must equal `verified.tenantId` else `tenant_mismatch` lifecycle error; insert v2 session. **No status write** (consent not yet given) | same lock; status must be executable; `verified.tenantId` must equal bound `tenantId`; insert v2 session with `purpose:'upgrade'`; no row write |
| `beginConsentFinalization` | system txn: consume v2 `admin_consent` session (must have verified identity); CAS `pending-consent → verifying`, `consentedAt = now()` | consume only; status must still be executable; no row write |
| finalize | executor `retest({ tenantId: verified.tenantId })` | same |
| apply | `!success` → `pending-consent` + code; `applicationId ≠ clientId` → `application_token_invalid`; **`result.tenantId ≠ verifiedTenantId` → `tenant_mismatch`**; else existing binding write with `tenantId: verifiedTenantId` and `tenantId IS NULL OR = verified` (`tenant_already_bound` on 23505 / conflict) | existing no-op-on-failure semantics; additionally `verifiedTenantId ≠ current.tenantId` → `tenant_mismatch` no-op |

- [ ] **Step 1: Failing tests** (`connectionService.test.ts`; existing Drizzle mock harness. Run every case for both factories — the file already builds read via aliases; build an actions instance with `createConnectionService({ profile: 'customer-graph-actions', … })` and `describe.each([['customer-graph-read', read], ['customer-graph-actions', actions]])`)

```ts
describe.each(PROFILES)('%s identity-first lifecycle', (profile, service) => {
  it('initial connect starts at the organizations authority and writes an identity session', async () => {
    mockNoExistingRow();
    const initiated = await service.initiateConsent({ orgId: ORG, actorId: USER });
    const url = new URL(initiated.authorizationUrl);
    expect(url.pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect(initiated.binding).toMatchObject({ phase: 'identity_verification', tenantId: null });
    expect(capturedSessionInsert()).toMatchObject({ phase: 'identity_verification', flowVersion: 2, tenantHintHash: null, purpose: 'initial' });
  });

  it('reconnect of a still-bound row pins identity to the bound tenant', async () => {
    mockExistingRow({ status: 'degraded', tenantId: TENANT_A });
    const initiated = await service.initiateConsent({ orgId: ORG, actorId: USER });
    expect(new URL(initiated.authorizationUrl).pathname).toBe(`/${TENANT_A}/oauth2/v2.0/authorize`);
    expect(initiated.binding.tenantId).toBe(TENANT_A);
  });

  it('reconnect after disconnect (tenant cleared) uses organizations again', async () => {
    mockExistingRow({ status: 'revoked', tenantId: null });
    expect(new URL((await service.initiateConsent({ orgId: ORG, actorId: USER })).authorizationUrl).pathname)
      .toBe('/organizations/oauth2/v2.0/authorize');
  });

  it('upgrade pins identity to the bound tenant and writes nothing to the row', async () => {
    mockExecutableRow({ tenantId: TENANT_A, permissionManifestVersion: CURRENT - 1 });
    const initiated = await service.initiateUpgradeConsent({ connectionId: CONN, orgId: ORG, auth });
    expect(new URL(initiated.authorizationUrl).pathname).toBe(`/${TENANT_A}/oauth2/v2.0/authorize`);
    expect(capturedConnectionUpdates()).toHaveLength(0);
    expect(capturedSessionInsert()).toMatchObject({ purpose: 'upgrade', tenantHintHash: hashTenantHint(TENANT_A) });
  });

  it('identity → consent writes a verified session and does NOT move status or bind', async () => {
    mockLockedRow({ status: 'pending-consent', tenantId: null });
    const out = await service.transitionIdentityToConsent({ attempt: pending, purpose: 'initial', actorId: USER, verified: verifiedA, nextPhase: 'admin_consent' });
    expect(out.verifiedTenantId).toBe(TENANT_A);
    expect(capturedConnectionUpdates()).toHaveLength(0);
    expect(capturedSessionInsert()).toMatchObject({ phase: 'admin_consent', verifiedTenantId: TENANT_A });
  });

  it('identity in tenant B cannot continue an attempt on a row bound to tenant A', async () => {
    mockLockedRow({ status: 'pending-consent', tenantId: TENANT_A });
    await expect(service.transitionIdentityToConsent({ attempt: pending, purpose: 'initial', actorId: USER, verified: verifiedB, nextPhase: 'admin_consent' }))
      .rejects.toMatchObject({ code: 'tenant_mismatch' });
    expect(capturedSessionInsert()).toBeUndefined();
  });

  it('a superseded attempt cannot continue (concurrent re-initiate rotated the attempt)', async () => {
    mockLockedRow(undefined); // attemptPredicate matched nothing
    await expect(service.transitionIdentityToConsent({ attempt: pending, purpose: 'initial', actorId: USER, verified: verifiedA, nextPhase: 'admin_consent' }))
      .rejects.toMatchObject({ code: 'stale_attempt' });
  });

  it('finalization start consumes the consent session and moves pending-consent → verifying', async () => {
    mockConsumedSession({ phase: 'admin_consent', flowVersion: 2, verifiedTenantId: TENANT_A, verifiedAdminObjectId: ADMIN, identityVerifiedAt: NOW, purpose: 'initial', userId: USER });
    const started = await service.beginConsentFinalization({ attempt: pending, rawConsentState: 's2' });
    expect(started.verified.tenantId).toBe(TENANT_A);
    expect(started.attempt.status).toBe('verifying');
    expect(capturedConnectionUpdates()[0]).toMatchObject({ status: 'verifying' });
    expect(capturedConnectionUpdates()[0]).not.toHaveProperty('tenantId');
  });

  it('a replayed consent state is rejected (session already consumed)', async () => {
    mockConsumedSession(undefined);
    await expect(service.beginConsentFinalization({ attempt: pending, rawConsentState: 's2' })).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(capturedConnectionUpdates()).toHaveLength(0);
  });

  it('binds the VERIFIED tenant only after a successful application proof', async () => {
    const applied = await service.applyConsentFinalizationResult(verifying, { verifiedTenantId: TENANT_A, result: retestOk(TENANT_A) });
    expect(capturedConnectionUpdates()[0]).toMatchObject({ tenantId: TENANT_A, status: 'active' });
    expect(applied.status).toBe('active');
  });

  it('refuses to bind when the application proof reports a different tenant', async () => {
    await service.applyConsentFinalizationResult(verifying, { verifiedTenantId: TENANT_A, result: retestOk(TENANT_B) });
    expect(capturedConnectionUpdates()[0]).toMatchObject({ status: 'pending-consent', lastErrorCode: 'tenant_mismatch' });
    expect(capturedConnectionUpdates()[0]).not.toHaveProperty('tenantId');
  });

  it.each([
    [{ success: false, errorCode: 'application_token_invalid' }, 'application_token_invalid'],
    [{ success: false, errorCode: 'organization_probe_failed' }, 'organization_probe_failed'],
  ])('does not bind on a failed application proof (%o)', async (result, code) => {
    await service.applyConsentFinalizationResult(verifying, { verifiedTenantId: TENANT_A, result: result as RetestResult });
    expect(capturedConnectionUpdates()[0]).toMatchObject({ status: 'pending-consent', lastErrorCode: code });
  });

  it('upgrade finalization with a different tenant is a no-op reporting tenant_mismatch', async () => {
    mockExecutableRow({ tenantId: TENANT_A });
    const out = await service.applyUpgradeFinalizationResult(active, { verifiedTenantId: TENANT_B, result: retestOk(TENANT_B) });
    expect(out.failureCode).toBe('tenant_mismatch');
    expect(capturedConnectionUpdates()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/services/m365ControlPlane/connectionService.test.ts src/services/m365ControlPlane/writeActionConnectionService.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** per the contract table. `initiateConsent`/`initiateUpgradeConsent` call `createIdentitySessionInTransaction({ …owner, expectedTenantId })` then `buildMicrosoftIdentityAuthorizationUrl({ authority: expectedTenantId ?? 'organizations', clientId: config.clientId, redirectUri: config.callbackUrl, expectedCallbackPath: new URL(config.callbackUrl).pathname, state, nonce, codeChallenge })`, and return `binding = { phase: 'identity_verification', rawState, connectionId, consentAttemptId, tenantId: expectedTenantId }`. `applyConsentFinalizationResult` is today's `applyIdentityVerificationResult` body with the `RetestResult` branches (`connectionService.ts:690-727`) plus the tenant-equality guard before the write; `applyUpgradeFinalizationResult` is today's upgrade apply with the input type changed and the guard comparing `verifiedTenantId` and `result.tenantId` to `current.tenantId`.
- [ ] **Step 4: Run** — Expected: PASS. Then `npx tsc --noEmit -p apps/api` — the callback and initiate routes fail to compile; that is fixed in Tasks 11–12 (commit Task 10–12 together if CI per-commit matters; the PR is the unit).
- [ ] **Step 5: Commit** `git commit -am "feat(m365): identity-first consent state machine in connection service"`

### Task 11: Callback router reversal (both profiles) + audit

**Files:**
- Modify: `apps/api/src/routes/m365ConsentCallback.ts` (phase handling `:544-836`, parser `:72-125`, deps `:211-292`, defaults `:349-449`)
- Modify: `apps/api/src/services/m365ControlPlane/metrics.ts` (events/outcomes append; `verifiedAdministratorObjectId` audit field)
- Test: `apps/api/src/routes/m365ConsentCallback.test.ts` (rewrite the phase-ordering tests; keep the cross-profile, cookie-layer, sync-lifecycle suites with updated fixtures), `apps/api/src/services/m365ControlPlane/metrics.test.ts`

**Interfaces:**
- Consumes: Tasks 7–10.
- Produces:
  ```ts
  export type ParsedM365ConsentCallback =
    | { kind: 'code_success'; state: string; code: string }      // same shape for both phases
    | { kind: 'provider_error'; state: string };
  // CallbackDependencies replaces prepareIdentitySession/buildIdentityUrl/transitionAdminPhase/
  // transitionUpgradePhase/completeIdentity/applyIdentityResult/applyUpgradeResult with:
  verifyIdentity(input: VerifyConsentIdentityRequest): Promise<VerifyConsentIdentityResult>;
  transitionIdentityToConsent: ConnectionService['transitionIdentityToConsent'];
  buildConsentUrl(input: Parameters<typeof buildMicrosoftTenantAdminConsentUrl>[0]): string;
  beginFinalization: ConnectionService['beginConsentFinalization'];
  finalize(input: RetestRequest): Promise<RetestResult>;
  applyFinalization: ConnectionService['applyConsentFinalizationResult'];
  applyUpgradeFinalization: ConnectionService['applyUpgradeFinalizationResult'];
  ```
  New audit events appended at the END of each profile's events array: `m365.customer_graph_read.admin_identity_verified`, `m365.customer_graph_actions.admin_identity_verified`. New outcomes appended at the END of `M365_CUSTOMER_GRAPH_READ_OUTCOMES` and added to `SUCCESS_OUTCOMES`: `identity_verified`, `application_verification_started`. `M365ConsentAuditInput` gains `verifiedAdministratorObjectId?: string` written as `details.verifiedAdministratorObjectId`.

Route flow:

```
binding = verifyBindingCookie(cookie)
  'legacy' | 'expired' → terminalFailure('consent_expired')        // old in-flight attempts restart explicitly
  invalid               → terminalFailure('consent_state_mismatch')
parsed = parse(binding.phase, query); state must constant-time-equal binding.rawState
purpose = readSessionPurpose(...)   // flow-2 rows only
attempt = loadAttempt(binding); statusAllowed(status, isUpgrade): initial ⇒ 'pending-consent' in BOTH phases; upgrade ⇒ active|degraded

PHASE identity_verification:
  session = consumeSession(phase identity_verification)  → null ⇒ consent_state_mismatch (no executor call)
  provider_error ⇒ initial: markAttemptFailed('consent_cancelled'); upgrade: no-op; redirect consent_cancelled
  hint check: session.tenantHintHash === null  ⇔ binding.tenantId === null; else hash(binding.tenantId) must equal (constant-time) ⇒ tenant_mismatch
  result = verifyIdentity({ expectedTenantId: binding.tenantId, code, codeVerifier, nonce, redirectUri: config.callbackUrl })
     throw ⇒ executor_unavailable (initial marks failed)
     !success ⇒ initial: markAttemptFailed(code); redirect code
  audit admin_identity_verified { outcome 'identity_verified', verifiedTenantId, verifiedAdministratorObjectId, actorId: session.userId }
  { rawState } = transitionIdentityToConsent({ attempt, purpose, actorId: session.userId, verified, nextPhase: 'admin_consent' })
     lifecycle tenant_mismatch ⇒ redirect tenant_mismatch ; stale ⇒ consent_state_mismatch
  Set-Cookie binding { phase admin_consent, rawState, tenantId: verified.tenantId }
  302 → buildConsentUrl({ tenantId: verified.tenantId, ... })

PHASE admin_consent:
  provider_error ⇒ consume + (initial: markAttemptFailed('consent_cancelled')) ⇒ consent_cancelled
  code_success: the code is DROPPED here (never read past the parser)
  started = beginFinalization({ attempt, rawConsentState: binding.rawState })  → stale ⇒ consent_state_mismatch
  constant-time: started.verified.tenantId === binding.tenantId  else ⇒ tenant_mismatch (initial: mark failed)
  audit admin_consent_returned { outcome 'application_verification_started' }
  result = finalize({ correlationId, tenantId: started.verified.tenantId }) ; throw ⇒ executor_unavailable (initial: mark failed)
  apply (initial|upgrade) with { verifiedTenantId: started.verified.tenantId, result }
  success ⇒ audit tenant_binding_verified { verifiedTenantId, verifiedAdministratorObjectId, actorId } (+ drift event), sync hooks unchanged
```

`parseM365ConsentCallbackQuery`: both phases accept success keys exactly `{state, code}` or `{state, code, session_state}`; error keys unchanged (`state, error, error_description`). A legacy `/adminconsent` return (`tenant`, `admin_consent`) parses as null. **Dependency:** a separate in-flight change loosens the *error* branch (provider error classification, a `conditional_access_blocked` outcome). Do not touch the error branch here beyond what this table needs; rebase onto it if it lands first, and if it lands after, its author must apply the classification to both phases.

- [ ] **Step 1: Failing tests** (replace `consumes admin state and starts tenant-bound PKCE identity verification` and siblings; run each scenario for both instances via `describe.each([['read', readHarness], ['actions', actionsHarness]])`, where each harness supplies the profile, callback path, attempt factory, and redirect base already used in the file)

```ts
describe.each(HARNESSES)('%s identity-first callback', (_name, h) => {
  it('identity phase verifies via executor, rotates state, and redirects to the v1 consent URL for the VERIFIED tenant', async () => {
    const verifyIdentity = vi.fn().mockResolvedValue({ success: true, tenantId: TENANT_A, administratorObjectId: ADMIN, administratorUsername: 'a@t.example', verifiedAt: NOW_ISO });
    const transitionIdentityToConsent = vi.fn().mockResolvedValue({ rawState: 'consent-state', verifiedTenantId: TENANT_A });
    const buildBindingCookie = vi.fn(() => 'b=consent');
    const app = h.app({
      verifyBindingCookie: () => ({ phase: 'identity_verification', rawState: 'id-state', connectionId: CONN, consentAttemptId: ATTEMPT, tenantId: null }),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity, transitionIdentityToConsent, buildBindingCookie,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });
    const res = await app.request(`${h.path}?state=id-state&code=id-code&session_state=ss`, { headers: { cookie: 'x' } });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(`https://login.microsoftonline.com/${TENANT_A}/oauth2/authorize`);
    expect(loc.searchParams.get('prompt')).toBe('admin_consent');
    expect(loc.searchParams.get('state')).toBe('consent-state');
    expect(verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({ expectedTenantId: null, authorizationCode: 'id-code' }));
    expect(buildBindingCookie).toHaveBeenCalledWith(expect.objectContaining({ phase: 'admin_consent', rawState: 'consent-state', tenantId: TENANT_A }));
  });

  it('consent phase never forwards the Microsoft code and binds only after application proof', async () => {
    const finalize = vi.fn().mockResolvedValue(retestOk(TENANT_A));
    const applyFinalization = vi.fn().mockResolvedValue({ ...h.snapshot(), status: 'active', tenantId: TENANT_A });
    const app = h.app({
      verifyBindingCookie: () => ({ phase: 'admin_consent', rawState: 'consent-state', connectionId: CONN, consentAttemptId: ATTEMPT, tenantId: TENANT_A }),
      beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verifiedA, actorId: USER }),
      finalize, applyFinalization, verifyIdentity: vi.fn(),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });
    const res = await app.request(`${h.path}?state=consent-state&code=SECRET-CONSENT-CODE`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/active`);
    expect(finalize).toHaveBeenCalledWith({ correlationId: expect.any(String), tenantId: TENANT_A });
    expect(JSON.stringify([finalize.mock.calls, applyFinalization.mock.calls, auditCalls()])).not.toContain('SECRET-CONSENT-CODE');
    expect(applyFinalization).toHaveBeenCalledWith(h.attempt('verifying'), { verifiedTenantId: TENANT_A, result: retestOk(TENANT_A) });
  });

  it('a binding cookie naming tenant A cannot finalize a session verified for tenant B', async () => {
    const finalize = vi.fn();
    const app = h.app({
      verifyBindingCookie: () => ({ phase: 'admin_consent', rawState: 's', connectionId: CONN, consentAttemptId: ATTEMPT, tenantId: TENANT_A }),
      beginFinalization: vi.fn().mockResolvedValue({ attempt: h.attempt('verifying'), purpose: 'initial', verified: verifiedB, actorId: USER }),
      finalize, markAttemptFailed: vi.fn().mockResolvedValue(h.snapshot()),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });
    const res = await app.request(`${h.path}?state=s&code=c`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/tenant_mismatch`);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('forged tenant hint: an identity cookie whose tenant does not hash to the session hint fails before the executor', async () => {
    const verifyIdentity = vi.fn();
    const app = h.app({
      verifyBindingCookie: () => ({ phase: 'identity_verification', rawState: 'id', connectionId: CONN, consentAttemptId: ATTEMPT, tenantId: TENANT_B }),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: hashTenantHint(TENANT_A) })),
      verifyIdentity, markAttemptFailed: vi.fn().mockResolvedValue(h.snapshot()),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    });
    const res = await app.request(`${h.path}?state=id&code=c`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/tenant_mismatch`);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it('forged tenant hint: a query `tenant` parameter is rejected outright', async () => {
    const res = await h.app({ verifyBindingCookie: () => identityBinding(null) })
      .request(`${h.path}?state=id-state&code=c&tenant=${TENANT_B}`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
  });

  it.each([
    ['identity_token_invalid'], ['admin_role_required'], ['tenant_mismatch'],
  ])('identity failure %s marks an initial attempt failed and never reaches consent', async (code) => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const transitionIdentityToConsent = vi.fn();
    const res = await h.app({
      verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity: vi.fn().mockResolvedValue({ success: false, errorCode: code }),
      markAttemptFailed, transitionIdentityToConsent,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')),
    }).request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/${code}`);
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), code);
    expect(transitionIdentityToConsent).not.toHaveBeenCalled();
  });

  it('replayed identity state: consumed session ⇒ mismatch, executor not called', async () => {
    const verifyIdentity = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => identityBinding(null), consumeSession: vi.fn().mockResolvedValue(null), verifyIdentity,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')) })
      .request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_state_mismatch`);
    expect(verifyIdentity).not.toHaveBeenCalled();
  });

  it('concurrent duplicate consent callbacks: only one finalizes', async () => {
    let consumed = false;
    const beginFinalization = vi.fn(async () => {
      if (consumed) throw Object.assign(new Error('stale_attempt'), { code: 'stale_attempt' });
      consumed = true;
      return { attempt: h.attempt('verifying'), purpose: 'initial' as const, verified: verifiedA, actorId: USER };
    });
    const finalize = vi.fn().mockResolvedValue(retestOk(TENANT_A));
    const app = h.app({ verifyBindingCookie: () => consentBinding(TENANT_A), beginFinalization, finalize,
      applyFinalization: vi.fn().mockResolvedValue({ ...h.snapshot(), status: 'active', tenantId: TENANT_A }),
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')) });
    const [a, b] = await Promise.all([1, 2].map(() => app.request(`${h.path}?state=consent-state&code=c`, { headers: { cookie: 'x' } })));
    expect([a.headers.get('location'), b.headers.get('location')].sort()).toEqual([`${h.redirectBase}/active`, `${h.redirectBase}/consent_state_mismatch`].sort());
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('upgrade: identity pinned to bound tenant; cancel at consent leaves the row untouched', async () => {
    const markAttemptFailed = vi.fn();
    const res = await h.app({ readSessionPurpose: vi.fn(async () => 'upgrade' as const),
      verifyBindingCookie: () => consentBinding(TENANT_A),
      consumeSession: vi.fn().mockResolvedValue(consentSession({ purpose: 'upgrade' })), markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('active')) })
      .request(`${h.path}?state=consent-state&error=access_denied&error_description=AADSTS65004`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_cancelled`);
    expect(markAttemptFailed).not.toHaveBeenCalled();
  });

  it('guest admin home tenant: identity verified in the admin\'s home tenant targets consent at THAT tenant, never the org\'s intended one, and the audit records it', async () => {
    // /organizations resolved the admin's home tenant HOME; Breeze cannot know the intent.
    const audit = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity: vi.fn().mockResolvedValue({ success: true, tenantId: HOME, administratorObjectId: ADMIN, administratorUsername: 'tech@msp.example', verifiedAt: NOW_ISO }),
      transitionIdentityToConsent: vi.fn().mockResolvedValue({ rawState: 'cs', verifiedTenantId: HOME }), audit,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')) })
      .request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });
    expect(new URL(res.headers.get('location')!).pathname).toBe(`/${HOME}/oauth2/authorize`);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: h.events.adminIdentityVerified, verifiedTenantId: HOME }));
    // W3 Task 14 replaces this redirect with the confirm-tenant interstitial for organizations sign-ins.
  });

  it('production AADSTS50097 error redirect is a terminal provider error that binds nothing', async () => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const query = new URLSearchParams({
      // Sanitized capture of the real production redirect (2026-10-01): note admin_consent=True
      // arrives ALONGSIDE the error and must never be read as success.
      error: 'invalid_grant',
      error_description: 'AADSTS50097: Device authentication is required. Trace ID: 00000000-0000-0000-0000-000000000000 Correlation ID: 00000000-0000-0000-0000-000000000000 Timestamp: 2026-10-01 17:11:50Z',
      error_uri: 'https://login.microsoftonline.com/error?code=50097',
      admin_consent: 'True',
      state: 'id-state',
    });
    const res = await h.app({ verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })), markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')) })
      .request(`${h.path}?${query}`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_cancelled`); // conditional_access_blocked once the error-parser change lands
    expect(markAttemptFailed).toHaveBeenCalledWith(h.attempt('pending-consent'), 'consent_cancelled');
  });

  it('a legacy v1 browser binding restarts with consent_expired and touches nothing', async () => {
    const loadAttempt = vi.fn();
    const res = await h.app({ verifyBindingCookie: () => 'legacy' as const, loadAttempt })
      .request(`${h.path}?state=old&tenant=${TENANT_A}&admin_consent=True`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/consent_expired`);
    expect(loadAttempt).not.toHaveBeenCalled();
  });

  it('a pre-W1 executor (verify-identity 404 → client throws) is executor_unavailable and marks the attempt failed', async () => {
    const markAttemptFailed = vi.fn().mockResolvedValue(h.snapshot());
    const res = await h.app({ verifyBindingCookie: () => identityBinding(null),
      consumeSession: vi.fn().mockResolvedValue(identitySession({ tenantHintHash: null })),
      verifyIdentity: vi.fn().mockRejectedValue(new Error('m365_executor_http_404')), markAttemptFailed,
      loadAttempt: vi.fn().mockResolvedValue(h.attempt('pending-consent')) })
      .request(`${h.path}?state=id-state&code=c`, { headers: { cookie: 'x' } });
    expect(res.headers.get('location')).toBe(`${h.redirectBase}/executor_unavailable`);
  });
});

it('parser: both phases accept {state, code[, session_state]} and reject the old admin-consent shape', () => {
  for (const phase of ['identity_verification', 'admin_consent'] as const) {
    expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c'))).toEqual({ kind: 'code_success', state: 's', code: 'c' });
    expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c&session_state=x'))).toMatchObject({ kind: 'code_success' });
    expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams(`state=s&tenant=${TENANT_A}&admin_consent=True`))).toBeNull();
    expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c&admin_consent=True'))).toBeNull();
    expect(parseM365ConsentCallbackQuery(phase, new URLSearchParams('state=s&code=c&code=d'))).toBeNull();
  }
});
```

`metrics.test.ts`: extend the pinned arrays with the two new events (end of each profile list) and the two new outcomes (end); add a test that `recordEvent` writes `details.verifiedAdministratorObjectId` and drops unknown fields.

- [ ] **Step 2: Run** `npx vitest run src/routes/m365ConsentCallback.test.ts src/services/m365ControlPlane/metrics.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the route flow above. Default deps: `verifyIdentity` → `createExecutorClient(loadRuntimeConfig()).verifyConsentIdentity`; `finalize` → read client `retestCustomerGraphRead` / actions client `retestCustomerGraphActions` (extend `CallbackExecutorClient` with `verifyConsentIdentity` and `retest`, adapted per profile in `defaultCreateExecutorClient`). `expectedCallbackPath` already computed at `:544` is passed to `buildConsentUrl`. Remove `hashTenantHint`-based phase-2 logic (`:678-682`). Keep `runSyncLifecycleHook` calls and `upgradeOutcome` exactly as today.
- [ ] **Step 4: Run** — Expected: PASS. Run `npx tsc --noEmit -p apps/api` (still red until Task 12).
- [ ] **Step 5: Commit** `git commit -am "feat(m365): reverse consent callback to identity-first for both profiles"`

### Task 12: Initiate routes set the v2 binding

**Files:**
- Modify: `apps/api/src/routes/m365CustomerGraphRead.ts:246-357`, `apps/api/src/routes/m365CustomerGraphActions.ts:229-282`
- Test: `apps/api/src/routes/m365CustomerGraphRead.test.ts`, `apps/api/src/routes/m365CustomerGraphActions.test.ts`

The response body key stays `adminConsentUrl` in W2 (both web cards validate exactly that key and only the `login.microsoftonline.com` host, `M365CustomerGraphReadCard.tsx:341-350`), so W2 ships no web change.

- [ ] **Step 1: Failing tests** (in each route test, update the initiate mock to return `{ connection, binding, authorizationUrl }`)

```ts
it('sets an identity-phase binding cookie from the service and returns the identity URL', async () => {
  initiateMock.mockResolvedValue({ connection, binding: { phase: 'identity_verification', rawState: 'r', connectionId: CONN, consentAttemptId: ATTEMPT, tenantId: null },
    authorizationUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1' });
  const res = await post('/connections/customer-graph-read/consent?orgId=' + ORG);
  expect(await res.json()).toEqual({ adminConsentUrl: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?x=1' });
  expect(buildCookieMock).toHaveBeenCalledWith({ phase: 'identity_verification', rawState: 'r', connectionId: CONN, consentAttemptId: ATTEMPT, tenantId: null });
});
```
Same for `/connections/:id/upgrade-consent` (read) with `tenantId: TENANT_A`, and the actions consent route.

- [ ] **Step 2: Run** `npx vitest run src/routes/m365CustomerGraphRead.test.ts src/routes/m365CustomerGraphActions.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — `c.header('Set-Cookie', buildM365ConsentBindingCookie(initiated.binding), { append: true })`; `return c.json({ adminConsentUrl: initiated.authorizationUrl })`.
- [ ] **Step 4: Run** the two files, then the whole M365 unit surface and typecheck:

```bash
cd apps/api && npx vitest run src/routes/m365 src/services/m365ControlPlane && npx tsc --noEmit -p .
```
Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `git commit -am "feat(m365): initiate routes start identity-first consent"`

### Task 13: Integration — both profiles × initial / reconnect / upgrade against real Postgres

**Files:**
- Modify: `apps/api/src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts`, `apps/api/src/__tests__/integration/m365CustomerGraphActionsConsent.integration.test.ts`

These drive the real connection service + session service + callback router against Postgres with only the executor client mocked.

- [ ] **Step 1: Failing tests** (shape; use each file's existing org/user/auth fixtures and app harness)

```ts
describe.each(['customer-graph-read', 'customer-graph-actions'] as const)('%s identity-first (real DB)', (profile) => {
  it('initial: identity → consent → finalize binds the verified tenant exactly once', async () => {
    const { cookie, url } = await initiate(profile, orgA);
    expect(new URL(url).pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect((await connectionRow(orgA, profile)).tenantId).toBeNull();

    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'id-code' });
    const consentUrl = new URL(step1.location);
    expect(consentUrl.pathname).toBe(`/${TENANT_A}/oauth2/authorize`);
    expect((await connectionRow(orgA, profile))).toMatchObject({ status: 'pending-consent', tenantId: null });
    expect(await sessionRows(orgA, profile)).toEqual([expect.objectContaining({ phase: 'admin_consent', flowVersion: 2, verifiedTenantId: TENANT_A, codeVerifier: null })]);

    executor.retest.mockResolvedValue(retestOk(TENANT_A, profile));
    const step2 = await callback(profile, step1.cookie, { state: consentUrl.searchParams.get('state')!, code: 'discarded' });
    expect(step2.location).toMatch(/\/active$/);
    expect(await connectionRow(orgA, profile)).toMatchObject({ status: 'active', tenantId: TENANT_A });
    expect(await sessionRows(orgA, profile)).toEqual([]);
    expect(executor.retest).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A }));
  });

  it('replaying either phase after success changes nothing and calls no executor', async () => { /* re-send step1 and step2 requests; row snapshot identical; executor call counts unchanged */ });

  it('reconnect on a bound degraded row: identity pinned to bound tenant; a different verified tenant never reaches consent', async () => {
    await seedBound(orgA, profile, TENANT_A, 'degraded');
    const { cookie, url } = await initiate(profile, orgA);
    expect(new URL(url).pathname).toBe(`/${TENANT_A}/oauth2/v2.0/authorize`);
    executor.verifyConsentIdentity.mockResolvedValue({ success: false, errorCode: 'tenant_mismatch' });
    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });
    expect(step1.location).toMatch(/\/tenant_mismatch$/);
    expect(await connectionRow(orgA, profile)).toMatchObject({ tenantId: TENANT_A, status: 'pending-consent', lastErrorCode: 'tenant_mismatch' });
  });

  it('upgrade (manifest bump): pinned to bound tenant, stays executable throughout, promotes on success', async () => {
    await seedBound(orgA, profile, TENANT_A, 'active', { manifestVersion: CURRENT[profile] - 1 });
    const { cookie, url } = await initiateUpgrade(profile, orgA);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });
    expect((await connectionRow(orgA, profile)).status).toBe('active');
    executor.retest.mockResolvedValue(retestOk(TENANT_A, profile));
    await callback(profile, step1.cookie, { state: new URL(step1.location).searchParams.get('state')!, code: 'x' });
    expect(await connectionRow(orgA, profile)).toMatchObject({ status: 'active', permissionManifestVersion: CURRENT[profile] });
  });

  it('upgrade failure at finalize leaves the row byte-identical', async () => { /* retest -> application_token_invalid; compare full row before/after */ });

  it('cross-org: a tenant bound to org A cannot be bound to org B', async () => {
    await seedBound(orgA, profile, TENANT_A, 'active');
    const flow = await runToFinalize(profile, orgB, TENANT_A);
    expect(flow.location).toMatch(/\/tenant_already_bound$/);
    expect(await connectionRow(orgB, profile)).toMatchObject({ tenantId: null });
  });

  it('cross-profile: a read-phase cookie cannot drive the actions callback', async () => { /* initiate read, replay its cookie (renamed) at actions path → consent_state_mismatch */ });

  it('re-initiate during identity supersedes the old attempt (concurrent tabs)', async () => {
    const first = await initiate(profile, orgA);
    const second = await initiate(profile, orgA);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    expect((await callback(profile, first.cookie, { state: stateOf(first.url), code: 'c' })).location).toMatch(/consent_state_mismatch$/);
    expect(executor.verifyConsentIdentity).not.toHaveBeenCalled();
    expect((await callback(profile, second.cookie, { state: stateOf(second.url), code: 'c' })).location).toContain('/oauth2/authorize');
  });

  it('legacy in-flight row: a flow_version 1 session can be neither read for purpose nor consumed', async () => {
    await insertLegacyV1AdminSession(orgA, profile);
    expect(await readConsentSessionPurpose(legacyLookup)).toBeNull();
    expect(await consumeConsentSession(legacyConsume)).toBeNull();
  });

  it('a row left in verifying by the old flow is restartable by initiating again', async () => {
    await seedRow(orgA, profile, { status: 'verifying', tenantId: null });
    const { url } = await initiate(profile, orgA);
    expect(new URL(url).pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect((await connectionRow(orgA, profile)).status).toBe('pending-consent');
  });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365ConnectionLifecycle.integration.test.ts src/__tests__/integration/m365CustomerGraphActionsConsent.integration.test.ts` — Expected: FAIL before Tasks 10–12 are complete; PASS after.
- [ ] **Step 3:** Fix any defects found (no new production code is planned here).
- [ ] **Step 4: Run the full contract set for this PR** (the session table changed):

```bash
pnpm test-stack up
cd apps/api
npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365 \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm --filter=@breeze/api test:rls
npx vitest run       # full API unit suite (orgMerge.test.ts only reds in the full run)
pnpm test-stack down
```
Expected: all PASS.
- [ ] **Step 5: Commit + open W2 PR** `git commit -am "test(m365): identity-first consent lifecycle against real Postgres"`. PR body states the release gate (W1 executors deployed first) and that the old `/v1/complete-consent` path is now unused but kept until W4.

---

# Wave 3 — UX, docs, real-tenant acceptance

### Task 14: Confirm-tenant interstitial (API) — only if Q1 = yes

**Files:**
- Modify: `apps/api/src/routes/m365ConsentCallback.ts` (phase-1 branch), `apps/api/src/services/m365ControlPlane/connectionService.ts` (new `continueToConsent`, `readPendingTenantConfirmation`), `apps/api/src/routes/m365CustomerGraphRead.ts`, `apps/api/src/routes/m365CustomerGraphActions.ts`
- Test: matching `.test.ts` files + `m365ConnectionLifecycle.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  readPendingTenantConfirmation(input: { orgId: string; auth: AuthContext }):
    Promise<{ tenantId: string; administratorUsername: string | null; expiresAt: Date } | null>;
  continueToConsent(input: { orgId: string; auth: AuthContext }):
    Promise<{ binding: M365ConsentBrowserBinding; consentUrl: string }>;
  // GET  /m365/connections/<profile>/consent/pending?orgId=   -> 200 {tenantId, administratorUsername, expiresAt} | 404
  // POST /m365/connections/<profile>/consent/continue?orgId=  -> 200 {adminConsentUrl} + Set-Cookie (phase admin_consent)
  ```
  Rule: for `purpose = 'initial'` sign-ins whose authority was `organizations` (binding `tenantId === null`), the phase-1 callback calls `transitionIdentityToConsent({ …, nextPhase: 'tenant_confirmation' })`, clears the cookie, and redirects to `/integrations#m365/<profile>/confirm-tenant`. Bound-tenant reconnect and upgrade keep W2's direct redirect (the tenant is already pinned). `continueToConsent` (system txn, same advisory lock) consumes the `tenant_confirmation` row matching `(connection, org, profile, current attempt, user_id = auth.user.id, flow_version 2, unexpired)`, inserts a fresh `admin_consent` row carrying the same verified identity (state rotated again), and returns the v1 consent URL. Both endpoints require the same permissions as the consent route (org write, MFA, `canMutateOrgWideGovernance`, onboarding gate) and return non-oracular 404s.

- [ ] **Step 1: Failing tests**

```ts
it('organizations sign-in parks at confirm-tenant instead of jumping to consent', async () => {
  const res = await callbackPhase1({ bindingTenant: null, verified: TENANT_A });
  expect(res.headers.get('location')).toBe('/integrations#m365/customer-graph-read/confirm-tenant');
  expect(transitionIdentityToConsent).toHaveBeenCalledWith(expect.objectContaining({ nextPhase: 'tenant_confirmation' }));
});
it('a pinned-tenant reconnect still goes straight to consent', async () => { /* bindingTenant TENANT_A → location host login.microsoftonline.com */ });
it('pending returns the verified tenant and username to the same user only', async () => { /* other user in same org → 404 */ });
it('continue rotates state, sets an admin_consent cookie for the verified tenant, and is one-shot', async () => {
  const first = await post('/connections/customer-graph-read/consent/continue?orgId=' + ORG);
  expect(new URL((await first.json()).adminConsentUrl).pathname).toBe(`/${TENANT_A}/oauth2/authorize`);
  expect(first.headers.get('set-cookie')).toContain('Path=/api/v1/m365/consent/callback');
  expect((await post('/connections/customer-graph-read/consent/continue?orgId=' + ORG)).status).toBe(404);
});
it('continue after the 10-minute TTL is 404 and binds nothing', async () => { /* expired row */ });
it('continue for org B cannot use org A\'s pending confirmation', async () => { /* 404 */ });
```

- [ ] **Step 2: Run** the route/service/callback tests — Expected: FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run** unit + `m365ConnectionLifecycle.integration.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(m365): confirm the verified tenant before Microsoft consent"`

### Task 15: Web cards — step copy and confirm-tenant view

**Files:**
- Modify: `apps/web/src/components/integrations/M365CustomerGraphReadCard.tsx`, `M365CustomerGraphActionsCard.tsx`
- Modify: every locale's `integrations.json` that carries `m365CustomerGraphRead` / `m365CustomerGraphActions` (`apps/web/src/locales/*/integrations.json`)
- Test: `M365CustomerGraphReadCard.test.tsx`, an actions-card test (create `M365CustomerGraphActionsCard.test.tsx` if absent, following the read card test's harness)

Copy (en; translate the same keys in every locale):
```json
"preflight": {
  "stepsTitle": "Two Microsoft steps",
  "stepIdentity": "Sign in as a Global Administrator or Privileged Role Administrator of the customer's tenant. Breeze verifies who you are and which tenant you belong to.",
  "stepConsent": "Approve Breeze's permissions for that tenant on Microsoft's consent screen.",
  "guestNote": "Use an account that belongs to the customer's tenant. A guest account signs in to its own home tenant."
},
"confirmTenant": {
  "title": "Confirm the Microsoft tenant",
  "body": "You signed in as {{username}}. Breeze will request consent in tenant {{tenantId}}.",
  "continue": "Continue to Microsoft consent",
  "cancel": "Start over",
  "expired": "This confirmation expired. Start consent again."
}
```
`errors.tenant_mismatch` (both cards) changes to: "The administrator you signed in with belongs to a different Microsoft tenant than this connection. Sign in with an administrator of the connected tenant."

- [ ] **Step 1: Failing tests**

```tsx
it('shows both Microsoft steps in the pre-flight before redirecting', async () => {
  render(<M365CustomerGraphReadCard {...props} />);
  await user.click(screen.getByRole('button', { name: /connect tenant/i }));
  expect(screen.getByText(/verifies who you are and which tenant/i)).toBeInTheDocument();
  expect(screen.getByText(/approve breeze's permissions for that tenant/i)).toBeInTheDocument();
});

it('on #m365/customer-graph-read/confirm-tenant shows the verified tenant and continues via runAction', async () => {
  window.location.hash = '#m365/customer-graph-read/confirm-tenant';
  mockFetch({ 'GET /m365/connections/customer-graph-read/consent/pending': { tenantId: TENANT_A, administratorUsername: 'admin@tenant.example', expiresAt: FUTURE } ,
              'POST /m365/connections/customer-graph-read/consent/continue': { adminConsentUrl: `https://login.microsoftonline.com/${TENANT_A}/oauth2/authorize?state=s` } });
  render(<M365CustomerGraphReadCard {...props} />);
  expect(await screen.findByText(TENANT_A, { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/admin@tenant\.example/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /continue to microsoft consent/i }));
  expect(assignSpy).toHaveBeenCalledWith(`https://login.microsoftonline.com/${TENANT_A}/oauth2/authorize?state=s`);
});

it('confirm-tenant with no pending confirmation shows the expired copy', async () => { /* pending → 404 */ });
```
Plus `pnpm --filter @breeze/web test --run src/lib/__tests__/no-silent-mutations.test.ts` and the locale parity test.

- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphReadCard.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** — the continue POST goes through `runAction`; reuse `parseConsentUrl` for its response; hash handling follows the card's existing outcome-fragment parsing.
- [ ] **Step 4: Run** the card tests, `no-silent-mutations`, locale parity, `npx tsc --noEmit -p apps/web` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(web): identity-first consent steps and tenant confirmation"`

### Task 16: Deploy docs, runbooks, public docs

**Files:**
- Modify: `docs/deploy/m365-customer-graph-read-executor.md` (operation list `:13`, `:160`, `:260`; consent-flow description; callback section `:239-246`; audit list `:279+`)
- Modify: `docs/deploy/m365-customer-graph-actions-executor.md` (`:5` is already wrong — the actions executor serves consent operations; correct it to list `verify-identity`, `retest`, `execute-action` [+ `complete-consent` until W4]; gotcha (c) `:147` now applies to the `verify-identity` leg)
- Modify: `docs/runbooks/m365-customer-graph-read-real-tenant.md`, `docs/runbooks/m365-customer-graph-actions-real-tenant.md` (audit names `:50`, consent-screen capture `:52-62`, scenarios table `:98+`)
- Modify: `apps/docs/src/content/docs/features/identity-integrations.mdx:68-76` (steps 3–5 describe consent-then-identity; reverse them) and the actions section near `:151`

Required content:
- Flow: identity (v2, `/organizations` or bound tenant, PKCE, nonce, `wids`) → [confirm tenant] → v1 tenant-pinned admin consent (code discarded) → application-token proof + reconciliation → binding.
- Entra app registration: no new redirect URI; the existing Web redirect URI serves both phases; the `wids` claim must already be emitted (unchanged requirement). Note the v1 authorize endpoint is used for consent only.
- Executor operations: `POST /v1/verify-identity` (internal only; add to "confirm no public route reaches…" checks).
- Release ordering gate (executor before API).
- Runbook scenarios to add (both profiles): (A) tenant with a CA policy using a device filter — both phases complete; (B) guest administrator — confirm screen shows the home tenant; operator cancels; nothing bound; (C) identity as an ineligible role → `admin_role_required` before any consent screen; (D) reconnect of a bound tenant signing in with another tenant's admin → `tenant_mismatch` before consent; (E) replay of each phase; (F) cancel at the consent screen (initial → `consent_cancelled`, upgrade → row unchanged). Update scenario 2 ("Replay both callback phases") wording for the new phase order.
- Audit list gains `…admin_identity_verified`; `tenant_binding_verified` records `verifiedAdministratorObjectId` = the administrator whose identity Breeze verified, **not** a claim that this person clicked the consent screen (Microsoft does not report who approved).

- [ ] **Step 1:** `grep -rn "adminconsent\|complete-consent\|second Microsoft identity check\|admin_consent_returned" docs apps/docs/src/content` and list every hit in the PR description.
- [ ] **Step 2:** Edit each hit; `cd apps/docs && pnpm astro check && pnpm build`.
- [ ] **Step 3:** Verify no tenant IDs/hostnames: `git diff --cached | grep -Ei '[0-9a-f]{8}-[0-9a-f]{4}' ` shows only the repeating-digit placeholders and Microsoft well-known IDs.
- [ ] **Step 4: Commit** `git commit -am "docs(m365): identity-first consent flow, operations, and acceptance scenarios"`

### Task 17: Real-tenant acceptance (both profiles)

**Files:**
- Modify: the two runbooks (record results in the internal evidence location the runbooks already name, never in the repo)

- [ ] **Step 1:** Deploy W1 executors + W2/W3 API/web to a non-production stack wired to the dedicated test app registrations.
- [ ] **Step 2:** For each profile run runbook scenarios 1–8 plus A–F above in a disposable tenant, including one tenant with a device-filter CA policy. Record, for the consent-phase redirect, the **exact set of query parameter names** Microsoft returned. If it is anything other than `state, code[, session_state]`, stop: widen the parser in a follow-up commit with that evidence, re-run.
- [ ] **Step 3:** Confirm in DB that no session row outlives its flow and that `tenant_binding_verified` carries `verifiedAdministratorObjectId`.
- [ ] **Step 4:** Confirm the consent-phase code appears in no API, executor, or proxy log line (`grep` the stack logs for the `code=` value captured from the browser network panel, then discard it).
- [ ] **Step 5:** Mark the W3 PR ready only after both profiles pass; then the wave can close.

---

# Wave 4 — Legacy removal (≥ one release after W2 is deployed to every region)

### Task 18: Tighten schema, drop v1 compatibility, remove `complete-consent`

**Files:**
- Create: `apps/api/migrations/<sorts-last>-m365-consent-sessions-v2-only.sql`
- Modify: `apps/api/src/db/schema/m365.ts`, `browserBinding.ts` (remove legacy context + `'legacy'` status → callback maps nothing special), both executors (`operations.ts`, `app.ts`, `internalAuth.ts`: delete `completeConsentOperation`, `/v1/complete-consent`, `'complete-consent'`), both API executor clients (`completeIdentityVerification`), `packages/shared/src/m365/executorContracts.ts` (`completeConsentRequestSchema`, `completeConsentResultSchema`, types), deploy docs
- Test: the migration's integration test (v1 shapes now 23514), executor `app.test.ts` (`/v1/complete-consent` → 404), shared contract tests

Migration:
```sql
-- Remove the pre-identity-first consent-session layout. Any remaining
-- flow_version 1 row expired long ago (10-minute TTL).
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  DELETE FROM m365_consent_sessions WHERE flow_version = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'deleted % legacy m365_consent_sessions rows', n; END IF;
END $$;

ALTER TABLE m365_consent_sessions DROP CONSTRAINT IF EXISTS m365_consent_sessions_flow_version_check;
ALTER TABLE m365_consent_sessions ADD CONSTRAINT m365_consent_sessions_flow_version_check CHECK (flow_version = 2);
ALTER TABLE m365_consent_sessions ALTER COLUMN flow_version SET DEFAULT 2;
-- phase_fields_check: re-create with only the two flow_version = 2 branches from the W2 migration.
-- If Q1 was answered "no", also drop 'tenant_confirmation' from m365_consent_sessions_phase_check here.
```

- [ ] **Step 1:** Failing tests: v1 insert → 23514; `/v1/complete-consent` → 404 in both executors; `completeConsentRequestSchema` no longer exported; a v1-signed cookie → `consent_state_mismatch`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; `grep -rn "complete-consent\|completeConsent\|CompleteConsent\|tenantHint" apps packages docs` must return only historical plan/spec docs.
- [ ] **Step 4:** Run executors' suites, API unit suite, `m365` integration tests, `test:rls-coverage`, export-policy suites, `autoMigrate.test.ts`, `migrationRlsScope.test.ts` — PASS.
- [ ] **Step 5:** Commit `chore(m365): remove pre-identity-first consent compatibility`; PR.

---

## Self-review notes

- **Decision coverage:** identity at `/organizations` or bound tenant (Tasks 2, 8, 10); full id_token validation retained + optional expected tenant (Task 3); verified tid/oid server-side with expiry and rotated state (Tasks 6, 9, 10); v1 tenant consent with discarded code (Tasks 8, 11, 17); finalize = retest proof + reconciliation before binding (Tasks 10, 11, 13); upgrade/reconnect pinned, upgrade no-op preserved (Tasks 10, 13); audit semantics (Tasks 11, 16); UI shows verified tenant before consent (Tasks 14–15); docs/runbooks + real-tenant acceptance (Tasks 16–17).
- **Required test classes:** both profiles × initial/reconnect/upgrade (Tasks 10, 13); 50097 response (Task 11); forged hints (Task 11); consent-in-A/identity-in-B (Tasks 10, 11); wrong issuer/audience/nonce (Task 3); missing/ineligible wids (Task 3); replayed state/codes (Tasks 4, 11, 13); cross-org/profile (Tasks 7, 13); concurrent callbacks (Tasks 11, 13); no binding before identity + proof (Tasks 10, 11, 13); guest admin (Tasks 11, 14, 17); session migration + old in-flight attempts (Tasks 6, 7, 11, 13).
- **Contract suites:** W2 runs integration (`m365*`, export-policy ×2, tenantCascade, orgMergeRegistry), `test:rls-coverage`, `test:rls`, full API unit suite. `m365_consent_sessions` stays system-only RLS with no allowlist change; it is already in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry`, and `CORE_TENANT_EXPORT_POLICY` — only the export policy needs the new columns.

## Open questions (for Todd)

1. **Confirm-tenant interstitial (W3 Task 14)?** Recommend yes for `/organizations` sign-ins only — it is the only guard against a guest administrator binding their own home tenant. If no, W2's direct redirect stands and Task 14 is dropped.
2. **Guest administrators:** offer an optional "customer tenant ID" field on Connect that pins the identity authority to that tenant (lets a guest GA authenticate as a guest of the customer tenant)? Recommend deferring until a real request; runbook + interstitial copy cover it.
3. **AADSTS50097 fixture:** RESOLVED — Task 11 uses the sanitized production capture (`error=invalid_grant`, `error_description=AADSTS50097…`, `error_uri`, `admin_consent=True`, `state`).
4. **W4 timing:** one release after W2 is deployed to both regions, or bundle with the next M365 wave.
