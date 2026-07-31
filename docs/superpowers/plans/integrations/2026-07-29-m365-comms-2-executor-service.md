# M365 Communications-Delegated — Plan 2: Executor Service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/m365-communications-executor/` — the third narrow M365 executor — end to end: shared wire contracts, the app chassis (config / internal auth / Hono app), the fenced-lease CAS token cache, the MSAL confidential client, the operations that verify both digests before touching a credential, and full CI/supply-chain parity with the sibling executors.

**Architecture:** Clone the `m365-graph-actions-executor` chassis at the trust boundary (the read→actions diff proves the clone is a mechanical rename) and diverge only where the credential model demands it: per-user delegated refresh tokens live in an executor-owned Postgres token-cache store (AES-256-GCM under a KEK keyring, fenced leases, CAS writes, tombstones), MSAL `ConfidentialClientApplication` replaces the hand-rolled token client, and the execute path recomputes **both** the envelope digest and the plan digest from the received envelope — against signed JWT claims only — before any credential access.

**Tech Stack:** TypeScript, Hono + @hono/node-server, jose (EdDSA internal auth), `@azure/msal-node` (new dependency — first use in the repo), `@azure/identity` + `@azure/keyvault-secrets`, `postgres` (postgres.js) for the executor-owned store, Vitest, tsup, Docker (digest-pinned node:24-alpine).

## Global Constraints

- **Design spec:** `docs/superpowers/specs/integrations/2026-07-28-breeze-m365-communications-delegated-design.md`. This plan implements §14 tasks **8–11**. Sections cited per task.
- **Audience is `m365-communications-executor`; port is `3005`** (read=3003, actions=3004). Env prefix executor-side is `M365_COMMS_*`, matching Plan 1's API-side vars. Callback path is `/api/v1/m365/comms-consent/callback` and must byte-match Plan 1's `CALLBACK_PATH`.
- **Request body cap is 128 KiB** (`M365_COMMS_MAX_REQUEST_BODY_BYTES` from `@breeze/shared/m365`), NOT the sibling 16 KiB default. Inheriting the sibling constant silently rejects every legal max-size mail (spec §2 item 1).
- **Digest claims are the sole authority.** The executor verifies `effectDigest` and `planDigest` from the signed internal JWT and recomputes both from the received envelope **before any credential access**. A digest read from the request body, or recomputed from the same envelope it authorizes without a stored reference, is a self-consistency check that always passes — never write one (spec §5.2 item 3).
- **One canonicalizer.** Import `canonicalizeArguments`/`computeArgumentDigest` from `@breeze/shared/canonicalize` and the digest pair from `@breeze/shared/m365/commsDigests`. Never reimplement, wrap, or shadow them (spec §5.2, risk #4).
- **The mapper stops mapping.** The executor validates the stored envelope and serializes the Graph body **from the verified plan only** (`buildSendPlan` → `JSON.stringify(plan.body)`). No construction step may exist after digest verification (spec §5.3(a)).
- **Fail closed on the token cache.** An absent row outside the consent path means revoked or superseded — never initialize it. Corrupt ciphertext fails closed and **preserves the row**. Revoke tombstones, never deletes (spec §3.2).
- **No access-token parsing anywhere.** Identity is asserted from MSAL's `account.idTokenClaims` (`tid`/`oid`) pinned at consent, plus the `GET /me` probe. No `appid`/`azp` checks, no decoding the Graph access token (spec §4.2).
- **Redaction is stricter than the siblings.** Message bodies, subjects, and recipient lists must never appear in any log, error message, thrown exception, or failure result. Failure envelopes carry enum codes only. Leak tests are first-class deliverables, not nice-to-haves (spec §9, risk #1).
- **Clone discipline.** Where a step says "copy the sibling file and apply these deltas", copy it — do not re-derive security-critical parsing/validation that has been reviewed twice. The read→actions clone changed only names and strings in 8 source files; that is the template.
- **No network in tests.** Azure/KV/MSAL/Graph/fetch are all injected seams (the sibling suites' style — parameter seams, no `vi.mock` module mocking). The only exception is the Postgres half of the store contract suite, gated on `M365_COMMS_TOKEN_CACHE_TEST_DSN`.
- **The token-cache store is NOT Breeze Postgres.** It is a dedicated store the executor owns (decision recorded 2026-07-29, spec §3.2 — the Breeze-Postgres fallback is *closed*, not deprioritized). Its table therefore registers in **none** of the Breeze tenancy contracts (RLS coverage, cascade lists, export policy) — those govern the tenant database only. Say this in the PR before a reviewer asks.
- **Never commit** real tenant ids, client ids, secrets, or infra hostnames. Fixtures use the same all-1s/2s/3s GUID style as the shipped shared tests.

**Baseline:** branch off `main` at or after `2705fed8c` (the v3 design spec merge). Tasks 0–7 context below; do not re-implement them. This plan is independent of Plan 1 (tasks 6–7, PR #2934) — nothing here imports `commsRuntimeConfig` or the intent binding. Plan 3 consumes both plans.

---

## Already shipped — do not re-plan

| Task | PR | What landed (the parts this plan consumes) |
|---|---|---|
| 0 / 0a / 0b | #2915 / #2917 | Principal kind; single release funnel; persisted origin principal |
| 1 | #2921 | `@breeze/shared/canonicalize` (+ `/vectors`, 18 frozen vectors) |
| 2 | #2922 | `commsActions.ts`, `commsEffect.ts`, `commsPlan.ts`, `commsDigests.ts`, `commsPlanVectors.ts` (10 frozen vectors) |
| 3 | #2924 | `communications-delegated` profile **v2**, mail-only scopes, `offline_access` retained |
| 4 | #2926 | Migration `2026-08-06-f-m365-comms-delegated.sql` — delegated columns, consent sessions, constraint relaxation |
| 5 | #2928 | User-axis RLS behavioural proof |
| 6–7 | planned, #2934 | Intent binding + comms runtime config (Plan 1 — **not merged yet; do not depend on it**) |

Corrections from Plan 1 that bind here: the migration filename is `2026-08-06-f-...` (not the spec's `2026-07-28-a-...`); a new **column** on a Breeze org-cascade table must be registered in `CORE_TENANT_EXPORT_POLICY` — this plan adds no Breeze DB columns, so that contract is untouched (verify with `git diff --stat` against `apps/api/src/db/` at the end: it must be empty except `dockerfileWorkspaceManifests.test.ts`).

## Decisions this plan makes (each resolves a recorded open item)

1. **Send requests carry the envelope, not the action.** The shipped `m365CommsRequestSchema` carries `action: m365CommsActionSchema` for all four actions, but the send variant (`to/cc/bcc/subject/bodyText`) cannot produce a `CommsSendEffect` without the executor re-deriving binding fields — exactly the mapping §5.3 forbids. Task 8a reworks the request into a union: reads/drafts carry `action` (3-variant inline union), sends carry `envelope: commsSendEffectSchema`, with schema-level coherence checks (envelope binding fields must equal the outer request's). The 4-variant `m365CommsActionSchema` survives unchanged as the **tool-input** schema for Plan 3. The schema has zero non-test consumers today, so this is safe.
2. **Two signed claims, resolving the vector-9 `OPEN` flag.** Per the spec's 2026-07-29 revision (§5.3(b)): the JWT carries `effectDigest` (= stored `intent.argumentDigest`) **and** `planDigest` (persisted at creation), plus `consentGeneration`. The executor recomputes both digests from the received envelope via `computeCommsEnvelopeDigest`/`computeCommsPlanDigest` and refuses on either mismatch. Task 8a updates the stale `OPEN — see the PR discussion` comment in `commsPlanVectors.ts` (comment only — digests are untouched).
3. **The store is Postgres behind an interface.** Spec §3.2 names "a small Postgres (or Redis with persistence)". Postgres: the CAS predicate, fenced lease, and tombstone are single SQL statements; Redis needs Lua to get the same atomicity. Task 9 ships `TokenCacheStore` with `PostgresTokenCacheStore` (postgres.js) and `InMemoryTokenCacheStore`, both run through one contract suite — CI runs the Postgres half against a service container.
4. **No CCA pooling in v1.** One `ConfidentialClientApplication` per request, cache continuity via the durable store + `ICachePlugin`. The spec permits per-request explicitly and pooling would require an interleave-proof test for an optimization nothing needs yet. A two-connection isolation test ships anyway.
5. **Missing granted scopes fail the consent closed.** §4.2 orders reconciliation before persistence; a grant missing `Mail.Send` returns `graph_permission_missing` and persists nothing. Extra scopes (pre-existing consents) are ignored.
6. **CI wiring lands in this PR; compose/env-template/runtime-smoke guard entries defer to Plan 3.** Task 8c wires test, build, ci-success, release image, Trivy, Dependabot, and the hardening-guard blocks *for those*. The compose secret plumbing, `.env.example` blocks, and the `check-m365-comms-runtime.sh` smoke assert API-side deploy artifacts that Plan 3 task 18 creates — adding their guard blocks now would fail the guard against files that don't exist.

## Task ordering & dependencies

Spec task 8 is split into 8a (shared contracts — everything imports them), 8b (chassis), and 8c (CI — needs a buildable `dist/index.cjs`, so it runs **last**; the whole plan is one PR, so "CI wired in the same PR" holds).

1. **Task 8a** — shared wire contracts (`packages/shared`)
2. **Task 8b** — executor scaffold: config, internal auth, app, conformance vectors
3. **Task 9** — token-cache store, crypto keyring, lease/CAS semantics
4. **Task 10** — Key Vault providers + MSAL delegated credential broker
5. **Task 11** — Graph client, identity, reconcile, mail actions, operations, final `index.ts` wiring, redaction leak tests
6. **Task 8c** — CI + supply-chain wiring

Strictly sequential (each consumes the previous task's exports). Commit after every task.

---

### Task 8a: Shared wire contracts — envelope-carrying requests, executor consent/revoke contracts

Spec §5.2–§5.3, §9 step 2. All in `packages/shared`.

**Files:**
- Modify: `packages/shared/src/m365/commsActions.ts` — export the 3-variant inline union; **delete** the request/result envelope section (lines 260–315); add the `search`×`sinceHours` exclusivity refine to the list variant
- Create: `packages/shared/src/m365/commsExecutorContracts.ts` — everything deleted above, reworked, plus consent/retest/revoke contracts
- Create: `packages/shared/src/m365/commsExecutorContracts.test.ts`
- Modify: `packages/shared/src/m365/commsActions.test.ts` — move/adapt the request/result tests
- Modify: `packages/shared/src/m365/index.ts` — add `export * from './commsExecutorContracts';`
- Modify: `packages/shared/src/m365/commsPlanVectors.ts` — vector-9 comment only

**Interfaces:**
- Consumes: `commsSendEffectSchema`, `CommsSendEffect` from `./commsEffect`; `m365CommsEmailSchema`, caps, `m365CommsFailureCodeSchema` from `./commsActions`.
- Produces (all consumed by tasks 8b/11 and by Plan 3's task 12 API client):
  - `m365CommsInlineActionSchema` — discriminated union of the `mail.list` / `mail.get` / `mail.draft.create` variants (send excluded); `M365CommsInlineAction`
  - `m365CommsReadRequestSchema` / `m365CommsSendRequestSchema` / `m365CommsRequestSchema` (union) and types `M365CommsReadRequest` / `M365CommsSendRequest` / `M365CommsRequest`
  - `m365CommsResultSchema` / `M365CommsResult` — success variants gain optional `usedCacheGeneration: number` and `rotated: boolean` (§9 step 7)
  - `commsCompleteConsentRequestSchema` / `commsCompleteConsentResultSchema`, `commsRetestRequestSchema` / `commsRetestResultSchema`, `commsRevokeConnectionRequestSchema` / `commsRevokeConnectionResultSchema` + inferred types

⚠️ **Circular-import trap:** `commsEffect.ts` already imports from `commsActions.ts`. The request schema needs `commsSendEffectSchema`, so it CANNOT live in `commsActions.ts` (a back-import would TDZ-crash the module graph). That is why the request/result section **moves** to the new file, which imports from both. Public names are unchanged — the barrel re-exports both files, and the schemas have zero non-test consumers.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/m365/commsExecutorContracts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  m365CommsRequestSchema,
  m365CommsResultSchema,
  commsCompleteConsentRequestSchema,
  commsRetestRequestSchema,
  commsRevokeConnectionRequestSchema,
} from './commsExecutorContracts';
import { buildCommsSendEffect } from './commsEffect';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const G4 = '44444444-4444-4444-8444-444444444444';

const base = {
  correlationId: G1,
  connectionId: G2,
  tenantId: G3,
  expectedUserObjectId: G4,
  consentGeneration: 1,
};

function envelope(overrides: Record<string, unknown> = {}) {
  return buildCommsSendEffect({
    actionVersion: 1,
    connectionId: G2,
    tenantId: G3,
    senderObjectId: G4,
    consentGeneration: 1,
    to: ['a@example.com'],
    subject: 's',
    bodyText: 'b',
    ...overrides,
  });
}

describe('m365CommsRequestSchema', () => {
  it('accepts a read request carrying an inline action', () => {
    const parsed = m365CommsRequestSchema.safeParse({
      ...base,
      action: { type: 'm365.comms.mail.list', folder: 'inbox' },
    });
    expect(parsed.success).toBe(true);
  });

  it('REFUSES a send ride along the action field', () => {
    // The send action variant is tool-input shape only. A send must arrive as
    // the stored envelope, or the executor would have to rebuild it — the
    // mapping design §5.3 forbids.
    const parsed = m365CommsRequestSchema.safeParse({
      ...base,
      action: {
        type: 'm365.comms.mail.send',
        to: ['a@example.com'], subject: 's', bodyText: 'b',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a send request whose envelope agrees with the outer binding', () => {
    const parsed = m365CommsRequestSchema.safeParse({ ...base, envelope: envelope() });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['connectionId', { connectionId: G1 }],
    ['tenantId', { tenantId: G1 }],
    ['senderObjectId', { senderObjectId: G1 }],
    ['consentGeneration', { consentGeneration: 2 }],
  ])('refuses a send whose envelope disagrees with the outer %s', (_field, override) => {
    const parsed = m365CommsRequestSchema.safeParse({ ...base, envelope: envelope(override) });
    expect(parsed.success).toBe(false);
  });

  it('refuses a request carrying both action and envelope, or neither', () => {
    expect(m365CommsRequestSchema.safeParse({
      ...base,
      action: { type: 'm365.comms.mail.get', messageId: 'abc' },
      envelope: envelope(),
    }).success).toBe(false);
    expect(m365CommsRequestSchema.safeParse(base).success).toBe(false);
  });

  it('refuses list requests combining search and sinceHours', () => {
    // Graph rejects $search combined with $filter at runtime; refuse it at the
    // schema so the failure is a 400 here, not a graph_provider_rejected there.
    expect(m365CommsRequestSchema.safeParse({
      ...base,
      action: { type: 'm365.comms.mail.list', folder: 'inbox', search: 'invoice', sinceHours: 24 },
    }).success).toBe(false);
  });
});

describe('m365CommsResultSchema cache-generation metadata', () => {
  it('accepts usedCacheGeneration and rotated on success variants', () => {
    expect(m365CommsResultSchema.safeParse({
      success: true, kind: 'sent', sentAt: '2026-07-29T00:00:00.000Z',
      usedCacheGeneration: 4, rotated: true,
    }).success).toBe(true);
  });
});

describe('consent / retest / revoke contracts', () => {
  it('accepts a first-consent request with a null expectedTenantId', () => {
    expect(commsCompleteConsentRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, consentAttemptId: G3,
      claimedConsentGeneration: 1,
      authorizationCode: 'code', codeVerifier: 'v'.repeat(43),
      nonce: 'n', redirectUri: 'https://app.example.com/api/v1/m365/comms-consent/callback',
      expectedTenantId: null,
    }).success).toBe(true);
  });

  it('retest binds connection, tenant, user, and generation', () => {
    expect(commsRetestRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, tenantId: G3,
      expectedUserObjectId: G4, consentGeneration: 1,
    }).success).toBe(true);
  });

  it('revoke takes an optional attempt condition', () => {
    expect(commsRevokeConnectionRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, consentAttemptId: null,
    }).success).toBe(true);
    expect(commsRevokeConnectionRequestSchema.safeParse({
      correlationId: G1, connectionId: G2, consentAttemptId: G3,
    }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter=@breeze/shared exec vitest run src/m365/commsExecutorContracts.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Export the inline union and the exclusivity refine from `commsActions.ts`**

In `commsActions.ts`, name the three inline variants and compose both unions (the four inline `z.object` literals currently live inside `m365CommsActionSchema` at lines 187–214 — extract them; content is unchanged except the list variant's new refine):

```ts
const mailListActionSchema = z.object({
  type: z.literal('m365.comms.mail.list'),
  folder: z.enum(M365_COMMS_MAIL_FOLDERS),
  search: searchTermSchema.optional(),
  sinceHours: z.number().int().min(1).max(M365_COMMS_MAX_SINCE_HOURS).optional(),
  pageSize: z.number().int().min(1).max(M365_COMMS_MAX_LIST_PAGE_SIZE).optional(),
}).strict().refine(
  (a) => a.search === undefined || a.sinceHours === undefined,
  { message: 'search and sinceHours are mutually exclusive: Graph rejects $search combined with $filter' },
);
```

(`mailGetActionSchema`, `mailDraftCreateActionSchema`, `mailSendActionSchema` are the other three literals, unchanged.) Then:

```ts
/**
 * The Tier-1/2 actions that execute inline without an intent. The send variant is
 * deliberately excluded: a send reaches the executor only as the stored effect
 * envelope (commsExecutorContracts.ts), never as tool-input shape.
 */
export const m365CommsInlineActionSchema = z.discriminatedUnion('type', [
  mailListActionSchema, mailGetActionSchema, mailDraftCreateActionSchema,
]);
export type M365CommsInlineAction = z.infer<typeof m365CommsInlineActionSchema>;

export const m365CommsActionSchema = z.discriminatedUnion('type', [
  mailListActionSchema, mailGetActionSchema, mailDraftCreateActionSchema, mailSendActionSchema,
]);
```

Wait — `.refine()` on a union member breaks `z.discriminatedUnion` in Zod 4 (members must be plain objects). Use `.superRefine` on the **union** instead: keep all four member objects bare `.strict()`, and put the exclusivity check on `m365CommsInlineActionSchema`/`m365CommsActionSchema` via `.superRefine((a, ctx) => { if (a.type === 'm365.comms.mail.list' && a.search !== undefined && a.sinceHours !== undefined) ctx.addIssue({ code: 'custom', message: 'search and sinceHours are mutually exclusive' }); })` on both unions. If Zod 4 in this repo *does* accept refined members in `discriminatedUnion` (check by running the tests), prefer the member-level refine — it is more local. Whichever compiles and passes, use in both unions consistently.

Then **delete** the "Request / result envelopes" section (the `m365CommsRequestSchema`, `M365CommsRequest`, the no-effectDigest NOTE comment, `m365CommsResultSchema`, `M365CommsResult` — lines 260–315) and move the affected tests out of `commsActions.test.ts` (adapt them into the new test file where they aren't already superseded by Step 1's).

- [ ] **Step 4: Create `commsExecutorContracts.ts`**

```ts
/**
 * Wire contracts between the Breeze API and the M365 communications executor
 * (design §9). Lives beside — not inside — commsActions.ts because the send
 * request embeds the effect envelope, and commsEffect.ts already imports from
 * commsActions.ts; a back-import would be circular.
 *
 * NOTE: there is deliberately NO `effectDigest`/`planDigest` field in any
 * request here. The digests the executor verifies arrive as signed JWT claims
 * and nowhere else. A body field would let an implementer compare the envelope
 * against a digest computed from that same envelope — a self-consistency check
 * that always passes while proving nothing (design §5.2). If one is ever added
 * it must be asserted *equal to* the claim, never read instead of it.
 */
import { z } from 'zod';
import { m365CommsInlineActionSchema, m365CommsFailureCodeSchema } from './commsActions';
import { commsSendEffectSchema } from './commsEffect';

const guidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  'must be a canonical lowercase GUID',
);

const baseRequestFields = {
  correlationId: guidSchema,
  connectionId: guidSchema,
  tenantId: guidSchema,
  /** Pinned at consent; the executor asserts MSAL's account `oid` against it. */
  expectedUserObjectId: guidSchema,
  /** Must match the token-cache row's stamped generation, checked twice for sends (design §5.2). */
  consentGeneration: z.number().int().min(0),
  cacheGeneration: z.number().int().min(0).optional(),
  /** = the immutable `action_intents.id`, for audit correlation and future dedup. */
  idempotencyKey: z.string().min(1).max(200).optional(),
} as const;

export const m365CommsReadRequestSchema = z.object({
  ...baseRequestFields,
  action: m365CommsInlineActionSchema,
}).strict();
export type M365CommsReadRequest = z.infer<typeof m365CommsReadRequestSchema>;

/**
 * A send carries the stored effect envelope verbatim — never tool-input shape.
 * The envelope's own binding fields must agree with the outer request's; a
 * disagreement means the API assembled the request from something other than
 * the intent, and the executor must never see it as merely "invalid input"
 * downstream of credential access, so it is refused at the schema.
 */
export const m365CommsSendRequestSchema = z.object({
  ...baseRequestFields,
  envelope: commsSendEffectSchema,
}).strict().superRefine((request, ctx) => {
  const mismatches: Array<[string, unknown, unknown]> = [
    ['connectionId', request.envelope.connectionId, request.connectionId],
    ['tenantId', request.envelope.tenantId, request.tenantId],
    ['senderObjectId', request.envelope.senderObjectId, request.expectedUserObjectId],
    ['consentGeneration', request.envelope.consentGeneration, request.consentGeneration],
  ];
  for (const [field, inEnvelope, inRequest] of mismatches) {
    if (inEnvelope !== inRequest) {
      ctx.addIssue({ code: 'custom', message: `envelope.${field} must equal the request binding` });
    }
  }
});
export type M365CommsSendRequest = z.infer<typeof m365CommsSendRequestSchema>;

export const m365CommsRequestSchema = z.union([
  m365CommsReadRequestSchema,
  m365CommsSendRequestSchema,
]);
export type M365CommsRequest = z.infer<typeof m365CommsRequestSchema>;

const cacheMetaFields = {
  /** The store's cache_version after this call — the API writes it back to `credential_version`. */
  usedCacheGeneration: z.number().int().min(0).optional(),
  /** True when this call redeemed the refresh token (MSAL rotated the cache). */
  rotated: z.boolean().optional(),
} as const;

const commsExecutorFailureSchema = z.object({
  success: z.literal(false),
  errorCode: m365CommsFailureCodeSchema,
  retryAfterSeconds: z.number().int().min(1).max(300).optional(),
}).strict();

export const m365CommsResultSchema = z.union([
  z.object({
    success: z.literal(true),
    kind: z.literal('collection'),
    items: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean(),
    ...cacheMetaFields,
  }).strict(),
  z.object({
    success: z.literal(true),
    kind: z.literal('resource'),
    resource: z.record(z.string(), z.unknown()),
    truncated: z.boolean().optional(),
    ...cacheMetaFields,
  }).strict(),
  z.object({
    success: z.literal(true),
    kind: z.literal('sent'),
    /** Graph's sendMail returns 202 with no body; there is nothing to project. */
    sentAt: z.string().min(1).max(64),
    ...cacheMetaFields,
  }).strict(),
  commsExecutorFailureSchema,
]);
export type M365CommsResult = z.infer<typeof m365CommsResultSchema>;

// ---------------------------------------------------------------------------
// Delegated consent completion (design §4.2) — the app-only contract in
// executorContracts.ts does not fit the user axis (admin object id, app-role
// reconciliation), hence a parallel contract rather than a reuse.
// ---------------------------------------------------------------------------

export const commsCompleteConsentRequestSchema = z.object({
  correlationId: guidSchema,
  connectionId: guidSchema,
  consentAttemptId: guidSchema,
  /** The consent_generation this attempt will claim if promoted (current + 1). */
  claimedConsentGeneration: z.number().int().min(1),
  authorizationCode: z.string().min(1).max(8192),
  codeVerifier: z.string().min(43).max(128),
  nonce: z.string().min(1).max(512),
  redirectUri: z.string().url().max(2048),
  /**
   * Null on first consent (the tenant is learned from the ID token). Set on
   * reconnect: a different returned `tid` is refused with `tenant_mismatch`
   * BEFORE anything is persisted — reconnect must not be a mailbox-substitution
   * primitive (design §4.2 step 4).
   */
  expectedTenantId: guidSchema.nullable(),
}).strict();
export type CommsCompleteConsentRequest = z.infer<typeof commsCompleteConsentRequestSchema>;

export const commsCompleteConsentResultSchema = z.union([
  z.object({
    success: z.literal(true),
    tenantId: guidSchema,
    userObjectId: guidSchema,
    userPrincipalName: z.string().min(1).max(320),
    mail: z.string().min(1).max(320).nullable(),
    grantedScopes: z.array(z.string().min(1).max(200)).max(50),
    /** The cache row's cache_version — becomes `m365_connections.credential_version`. */
    cacheGeneration: z.number().int().min(0),
    verifiedAt: z.string().datetime({ offset: true }),
  }).strict(),
  commsExecutorFailureSchema,
]);
export type CommsCompleteConsentResult = z.infer<typeof commsCompleteConsentResultSchema>;

export const commsRetestRequestSchema = z.object({
  correlationId: guidSchema,
  connectionId: guidSchema,
  tenantId: guidSchema,
  expectedUserObjectId: guidSchema,
  consentGeneration: z.number().int().min(0),
}).strict();
export type CommsRetestRequest = z.infer<typeof commsRetestRequestSchema>;

export const commsRetestResultSchema = z.union([
  z.object({
    success: z.literal(true),
    userPrincipalName: z.string().min(1).max(320),
    usedCacheGeneration: z.number().int().min(0),
    verifiedAt: z.string().datetime({ offset: true }),
  }).strict(),
  commsExecutorFailureSchema,
]);
export type CommsRetestResult = z.infer<typeof commsRetestResultSchema>;

export const commsRevokeConnectionRequestSchema = z.object({
  correlationId: guidSchema,
  connectionId: guidSchema,
  /**
   * When set: tombstone only if the row belongs to this attempt — the
   * consent-supersede cleanup (design §4.1 step 3). Null: unconditional revoke.
   */
  consentAttemptId: guidSchema.nullable(),
}).strict();
export type CommsRevokeConnectionRequest = z.infer<typeof commsRevokeConnectionRequestSchema>;

export const commsRevokeConnectionResultSchema = z.union([
  z.object({ success: z.literal(true), tombstoned: z.boolean() }).strict(),
  commsExecutorFailureSchema,
]);
export type CommsRevokeConnectionResult = z.infer<typeof commsRevokeConnectionResultSchema>;
```

(`z.string().datetime({ offset: true })` mirrors `executorContracts.ts`'s `timestampSchema` — verified at line 4 of that file.)

Add to `packages/shared/src/m365/index.ts`, after the `commsPlan` export:

```ts
export * from './commsExecutorContracts';
```

(`commsExecutorContracts` imports no `node:crypto`, so the barrel is safe — same reasoning as the existing comment block there.)

- [ ] **Step 5: Run the new tests and the full shared suite**

```bash
pnpm --filter=@breeze/shared exec vitest run src/m365/commsExecutorContracts.test.ts
pnpm --filter=@breeze/shared exec vitest run
```

Expected: new file PASSES. `commsActions.test.ts` fails on whatever request/result tests still reference the moved schemas — move those describe blocks into `commsExecutorContracts.test.ts` (adjusting imports only) or delete the ones Step 1 supersedes. Everything else stays green — the action union, caps, and failure-code tests are untouched.

- [ ] **Step 6: Resolve the vector-9 OPEN comment**

In `packages/shared/src/m365/commsPlanVectors.ts` (lines ~142–151), replace the `why` text of `consent-generation-changes-envelope-digest-only` — **only the string; never the frozen digests**:

```ts
    why:
      'Same content as `minimal-single-recipient`, generation 1 instead of 0. It changes the ' +
      'envelope digest and leaves the plan digest BYTE-IDENTICAL, because the plan carries only ' +
      'the Graph operation and none of the binding fields. Resolved 2026-07-29 (design §5.3(b)): ' +
      'the signed JWT carries BOTH digests — effectDigest = the stored intent.argumentDigest ' +
      '(envelope), planDigest persisted at creation — and the executor recomputes both from the ' +
      'received envelope. Neither subsumes the other, which is exactly the asymmetry this vector ' +
      'pins: it fails loudly if the plan starts or stops covering the binding.',
```

Run: `pnpm --filter=@breeze/shared exec vitest run src/m365/commsPlan.test.ts src/m365/commsPlanVectors.ts` — the frozen-vector suite must still pass (proof the digests were not touched).

- [ ] **Step 7: Typecheck both consumers**

```bash
NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json
```

Expected: no errors (the moved schemas had zero API consumers; this proves it).

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/m365/commsActions.ts \
        packages/shared/src/m365/commsActions.test.ts \
        packages/shared/src/m365/commsExecutorContracts.ts \
        packages/shared/src/m365/commsExecutorContracts.test.ts \
        packages/shared/src/m365/commsPlanVectors.ts \
        packages/shared/src/m365/index.ts
git commit -m "feat(shared): comms executor wire contracts — sends carry the envelope

Task 8 (part 1) of the M365 communications-delegated executor (design §9).

The shipped m365CommsRequestSchema carried action for all four catalog
actions, but a send arriving as tool-input shape would force the executor to
rebuild the effect envelope — the exact mapping step §5.3 exists to forbid.
Requests are now a union: reads/drafts carry the 3-variant inline action,
sends carry the stored CommsSendEffect verbatim, with schema-level coherence
checks binding the envelope's connection/tenant/sender/generation to the
outer request. The schemas move to commsExecutorContracts.ts because
commsEffect already imports commsActions and the embed would be circular.

Also: delegated consent/retest/revoke contracts (the app-only shapes in
executorContracts.ts carry admin/app-role fields that have no user-axis
meaning), cache-generation metadata on results, a schema-level refusal of
search+sinceHours (Graph rejects \$search with \$filter at runtime), and the
vector-9 OPEN comment resolved per the two-claim decision (§5.3(b)) —
comment only, frozen digests untouched."
```

---

### Task 8b: Executor scaffold — config, internal auth, app chassis, conformance vectors

Spec §2, §9, §10 (executor column). Clone lineage: the read→actions diff changed only names/strings in 8 source files — follow it.

**Files:**
- Create: `apps/m365-communications-executor/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js`, `Dockerfile`
- Create: `apps/m365-communications-executor/src/test/fixtures/client-cert.pem`, `client-key.pem` (copy from the actions executor byte-for-byte — test-only, 10-year self-signed)
- Create: `src/config.ts` + `src/config.test.ts`
- Create: `src/internalAuth.ts` + `src/internalAuth.test.ts`
- Create: `src/app.ts` + `src/app.test.ts`
- Create: `src/index.ts` (partial — `startExecutorServer` only; `startConfiguredExecutor` + autostart land in Task 11 when operations exist)
- Create: `src/conformance.vectors.test.ts`
- Modify: `apps/api/src/config/dockerfileWorkspaceManifests.test.ts` — insert `'apps/m365-communications-executor/Dockerfile: pinned',` in sorted position (~line 406; `m365-c…` sorts before `m365-g…`). **Skipping this reds the required Test API job the moment the Dockerfile exists.**

**Interfaces:**
- Consumes: everything from Task 8a; `M365_COMMS_MAX_REQUEST_BODY_BYTES` from `@breeze/shared/m365`; frozen vector corpora.
- Produces:
  - `loadExecutorConfig(source?: Environment): M365CommsExecutorConfig` and `createAzureCredential(mode, source?)` (config.ts)
  - `type ExecutorOperation = 'execute-action' | 'complete-consent' | 'retest' | 'revoke-connection'`
  - `interface InternalRequestAuthentication { correlationId: string; effectDigest: string | null; planDigest: string | null; consentGeneration: number | null }` — consumed by Task 11's send verification
  - `createEdDsaInternalRequestAuthenticator(config): Promise<InternalRequestAuthenticator>`
  - `createExecutorApp(dependencies: ExecutorAppDependencies): Hono` where `ExecutorAppDependencies = { authenticator; completeConsent(req): Promise<CommsCompleteConsentResult>; retest(req): Promise<CommsRetestResult>; revokeConnection(req): Promise<CommsRevokeConnectionResult>; executeAction(req, authentication): Promise<M365CommsResult>; maxBodyBytes?: number }` — note `executeAction` takes the **authentication** second argument (the sibling's does not; Task 11's digest checks need the claims)
  - `startExecutorServer(app, binding, serveImpl?)` (index.ts)

- [ ] **Step 1: Package scaffolding (mechanical clone)**

Copy from `apps/m365-graph-actions-executor/` and apply exactly these deltas — nothing else:

| File | Delta |
|---|---|
| `package.json` | name `@breeze/m365-communications-executor`; `M365_GRAPH_ACTIONS_EXECUTOR_AUTOSTART` → `M365_COMMS_EXECUTOR_AUTOSTART` in `dev`/`start`; dependencies **add** `"@azure/msal-node": "^3.5.3"` and `"postgres": "^3.4.9"` (match the API's postgres range; for msal-node accept whatever `pnpm install` resolves for the current major — then pin the caret to it) |
| `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `eslint.config.js` | copied unchanged, except tsup's third entry becomes `'credentials/azureKeyVaultProvider': 'src/credentials/azureKeyVaultProvider.ts'` (same as sibling — the file arrives in Task 10; tsup only resolves entries at build time, and `pnpm build` is not run until Task 8c. If an intermediate build is wanted, drop that entry now and restore it in Task 10) |
| `Dockerfile` | 8 path/filter renames to `m365-communications-executor`; `ENV M365_COMMS_EXECUTOR_AUTOSTART=1`; `EXPOSE 3005`; HEALTHCHECK env names → `M365_COMMS_EXECUTOR_BIND_HOST` / `M365_COMMS_EXECUTOR_PORT`. Keep both digest-pinned `FROM node:24-alpine@sha256:…` lines, `USER node`, `CMD ["node", "dist/index.cjs"]`, the npm-removal `RUN`, and the explicit COPY allowlist byte-identical — the hardening guard greps for each of these shapes |
| `src/test/fixtures/*.pem` | copied byte-identical |

Run `pnpm install` (lockfile gains the new app + two deps). Then update `apps/api/src/config/dockerfileWorkspaceManifests.test.ts` (insert the sorted `'apps/m365-communications-executor/Dockerfile: pinned',` entry) and run:

```bash
pnpm --filter=@breeze/api exec vitest run src/config/dockerfileWorkspaceManifests.test.ts
```

Expected: PASS. This test also verifies the Dockerfile copies every transitively-required workspace manifest before `pnpm install` — the clone already copies `packages/shared/package.json`, keep it.

- [ ] **Step 2: `src/config.ts` — clone with the delegated-credential deltas**

Start from the actions `config.ts` (234 lines) and apply:

1. Rename the interface to `M365CommsExecutorConfig`; constants: `CALLBACK_PATH = '/api/v1/m365/comms-consent/callback'`, `INTERNAL_AUTH_AUDIENCE = 'm365-communications-executor'`.
2. Env renames (same validation rules, same order, same fail-fast `required()`):
   - `M365_COMMS_CLIENT_ID` (canonical UUID)
   - `M365_COMMS_CALLBACK_URL` (byte-exact `origin + CALLBACK_PATH`)
   - `M365_COMMS_VAULT_URL`
   - `M365_COMMS_CLIENT_CERT_VERSION` (32 lowercase hex)
   - `M365_COMMS_CLIENT_CERT_VAULT_REF` — `VAULT_REF` regex secret segment becomes `m365-comms-client-cert`
   - `M365_COMMS_EXECUTOR_SIGNING_KID` / `_SIGNING_PUBLIC_JWK` / `_ISSUER` (=`breeze-api`) / `_AUDIENCE` (=`m365-communications-executor`)
   - `M365_COMMS_EXECUTOR_AZURE_CREDENTIAL_MODE` / `_BIND_HOST` (RFC1918/ULA only, unchanged `privateBindAddress`) / `_PORT`
3. **New block — the token-cache KEK keyring and store DSN** (after the client-cert block):

```ts
  const KEK_VAULT_REF = /^akv:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/m365-comms-token-cache-kek\/([0-9a-f]{32})$/;

  const tokenCacheKekWriterVersion = required(source, 'M365_COMMS_TOKEN_CACHE_KEK_VERSION');
  if (!CREDENTIAL_VERSION.test(tokenCacheKekWriterVersion)) {
    throw new Error('M365_COMMS_TOKEN_CACHE_KEK_VERSION must be a 32-character lowercase hex Key Vault version');
  }
  const tokenCacheKekVaultRef = required(source, 'M365_COMMS_TOKEN_CACHE_KEK_VAULT_REF');
  const kekMatch = KEK_VAULT_REF.exec(tokenCacheKekVaultRef);
  if (!kekMatch || kekMatch[1] !== new URL(vaultUrl).host || kekMatch[2] !== tokenCacheKekWriterVersion) {
    throw new Error(
      'M365_COMMS_TOKEN_CACHE_KEK_VAULT_REF must match M365_COMMS_VAULT_URL and end with /m365-comms-token-cache-kek/<M365_COMMS_TOKEN_CACHE_KEK_VERSION>',
    );
  }

  // The keyring reader set (design §3.2): every KEK version that may still
  // appear in a row's kek_version. Rollover deploys the new version to readers
  // everywhere BEFORE flipping the writer; a reader set that omits the writer
  // is a config that cannot decrypt its own writes, so it is refused at boot.
  const readerVersionsRaw = required(source, 'M365_COMMS_TOKEN_CACHE_KEK_READER_VERSIONS');
  const tokenCacheKekReaderVersions = readerVersionsRaw.split(',').map((entry) => entry.trim());
  if (
    tokenCacheKekReaderVersions.length === 0
    || tokenCacheKekReaderVersions.some((version) => !CREDENTIAL_VERSION.test(version))
    || new Set(tokenCacheKekReaderVersions).size !== tokenCacheKekReaderVersions.length
    || !tokenCacheKekReaderVersions.includes(tokenCacheKekWriterVersion)
  ) {
    throw new Error(
      'M365_COMMS_TOKEN_CACHE_KEK_READER_VERSIONS must be a comma-separated set of 32-character lowercase hex versions that includes M365_COMMS_TOKEN_CACHE_KEK_VERSION',
    );
  }

  const tokenCacheDsn = required(source, 'M365_COMMS_TOKEN_CACHE_DSN');
  let dsnUrl: URL;
  try {
    dsnUrl = new URL(tokenCacheDsn);
  } catch {
    throw new Error('M365_COMMS_TOKEN_CACHE_DSN must be a postgresql:// URL');
  }
  if ((dsnUrl.protocol !== 'postgresql:' && dsnUrl.protocol !== 'postgres:') || dsnUrl.host === '') {
    throw new Error('M365_COMMS_TOKEN_CACHE_DSN must be a postgresql:// URL');
  }
```

4. The config interface:

```ts
export interface M365CommsExecutorConfig {
  clientId: string;
  callbackUrl: string;
  vaultUrl: string;
  clientCertVersion: string;
  clientCertVaultRef: string;
  tokenCacheKekWriterVersion: string;
  tokenCacheKekVaultRef: string;
  tokenCacheKekReaderVersions: readonly string[];
  tokenCacheDsn: string;
  internalAuthKid: string;
  internalAuthPublicJwk: ExecutorInternalAuthPublicJwk;
  azureCredentialMode: AzureCredentialMode;
  bindHost: string;
  port: number;
}
```

`src/config.test.ts`: clone the sibling's (`validEnv(overrides)` helper style, env passed as a plain object, `process.env` never mutated), rename all vars, and add four new cases: keyring reader set missing the writer → throws; a malformed reader entry → throws; duplicate reader entries → throws; a non-postgres DSN → throws.

Run: `pnpm --filter=@breeze/m365-communications-executor exec vitest run src/config.test.ts` — PASS.

- [ ] **Step 3: `src/internalAuth.ts` — clone plus the authenticated claim set**

Clone the actions `internalAuth.ts` (113 lines) and apply:

1. `export type ExecutorOperation = 'execute-action' | 'complete-consent' | 'retest' | 'revoke-connection';`
2. Both audience literals → `'m365-communications-executor'`.
3. The verify result becomes the authenticated claim set (spec §5.2 item 3: `internalAuth.verify` "must be extended to return the authenticated claim set, so operations code cannot accidentally read an unauthenticated copy"):

```ts
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface InternalRequestAuthentication {
  correlationId: string;
  /** sha256 hex over the canonical effect envelope (= the stored intent.argumentDigest). Null when the claim is absent. */
  effectDigest: string | null;
  /** sha256 hex over the canonical Graph operation plan, persisted at intent creation. Null when absent. */
  planDigest: string | null;
  /** The consent generation the release bound. Null when absent. */
  consentGeneration: number | null;
}

function validOptionalDigest(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && SHA256_HEX.test(value));
}
function validOptionalGeneration(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
```

Extend the single `||` rejection chain with three lines (immediately before the final `digestMatches` line, keeping the one-indistinguishable-error property):

```ts
          || !validOptionalDigest(payload.effectDigest)
          || !validOptionalDigest(payload.planDigest)
          || !validOptionalGeneration(payload.consentGeneration)
```

and change the return to:

```ts
        return {
          correlationId: payload.correlationId,
          effectDigest: (payload.effectDigest as string | undefined) ?? null,
          planDigest: (payload.planDigest as string | undefined) ?? null,
          consentGeneration: (payload.consentGeneration as number | undefined) ?? null,
        };
```

Everything else — `exactBearerToken`, 60s lifetime, `jti`, `bodySha256` `timingSafeEqual`, the array-audience rejection, the single `catch { throw unauthorized(); }` — is copied unchanged.

`src/internalAuth.test.ts`: clone the sibling's jose-real fixture (`generateKeyPair('EdDSA')`, `SignJWT` minted exactly as the API signs), rename the audience, and add: a token carrying valid `effectDigest`/`planDigest`/`consentGeneration` claims → verify returns them; an uppercase or 63-char `effectDigest` → rejected; a negative or non-integer `consentGeneration` → rejected; a token with no claims → all three come back `null`.

Run: `pnpm --filter=@breeze/m365-communications-executor exec vitest run src/internalAuth.test.ts` — PASS.

- [ ] **Step 4: `src/app.ts` — clone with four operations and the 128 KiB cap**

Clone the actions `app.ts` (158 lines) and apply:

1. `import { M365_COMMS_MAX_REQUEST_BODY_BYTES } from '@breeze/shared/m365';` and `const DEFAULT_MAX_BODY_BYTES = M365_COMMS_MAX_REQUEST_BODY_BYTES;` — **the load-bearing divergence** (spec §2 item 1). Add the sibling-contrast comment: the 16 KiB default is smaller than one legal comms request.
2. Schema imports from `@breeze/shared/m365`: `m365CommsRequestSchema`, `m365CommsResultSchema`, `commsCompleteConsentRequestSchema`, `commsCompleteConsentResultSchema`, `commsRetestRequestSchema`, `commsRetestResultSchema`, `commsRevokeConnectionRequestSchema`, `commsRevokeConnectionResultSchema`.
3. `ExecutorAppDependencies` as in this task's Produces block — four operation members plus `executeAction(request, authentication)`.
4. Four operation branches in `execute` (complete-consent / retest / revoke-connection identical in shape to the sibling's complete-consent branch; execute-action is the fall-through and passes the claims):

```ts
    const request = m365CommsRequestSchema.safeParse(parsed);
    if (!request.success) return context.json({ error: 'invalid_request' }, 400);
    if (request.data.correlationId !== authentication.correlationId) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    try {
      const result = m365CommsResultSchema.safeParse(
        await dependencies.executeAction(request.data, authentication),
      );
      return result.success
        ? context.json(result.data)
        : context.json({ error: 'internal_error' }, 500);
    } catch {
      return context.json({ error: 'internal_error' }, 500);
    }
```

5. Route table:

```ts
  app.get('/healthz', (context) => context.json({ status: 'ok' }));
  app.post('/v1/complete-consent', (context) => execute(context, 'complete-consent'));
  app.post('/v1/retest', (context) => execute(context, 'retest'));
  app.post('/v1/revoke-connection', (context) => execute(context, 'revoke-connection'));
  app.post('/v1/execute-action', (context) => execute(context, 'execute-action'));
  app.notFound((context) => context.json({ error: 'not_found' }, 404));
  app.onError((_error, context) => context.json({ error: 'internal_error' }, 500));
```

`src/app.test.ts`: clone the sibling's stub-dependency style (`createExecutorApp({ authenticator: { verify: vi.fn() }, … })`, no module mocks) with comms request fixtures, plus three comms-specific cases: a request body larger than 16 KiB but under 128 KiB **succeeds** (pins the cap divergence — build a valid send request with a ~20,000-char `bodyText`); `executeAction` receives the authentication object verify returned (assert the second argument); `/v1/revoke-connection` routes and validates.

`src/index.ts` (partial):

```ts
import type { Hono } from 'hono';
import { serve } from '@hono/node-server';

type Serve = (options: {
  fetch: Hono['fetch'];
  hostname: string;
  port: number;
}) => { close(): void };

export function startExecutorServer(
  app: Hono,
  binding: { bindHost: string; port: number },
  serveImpl: Serve = serve as Serve,
): { close(): void } {
  return serveImpl({ fetch: app.fetch, hostname: binding.bindHost, port: binding.port });
}

// startConfiguredExecutor + the M365_COMMS_EXECUTOR_AUTOSTART block are added
// in Task 11, once the operations factory exists to wire.
```

Run: `pnpm --filter=@breeze/m365-communications-executor exec vitest run src/app.test.ts` — PASS.

- [ ] **Step 5: The conformance vector suite — the second consumer both corpus headers promise**

Create `src/conformance.vectors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CANONICALIZATION_VECTORS } from '@breeze/shared/canonicalize/vectors';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
import { COMMS_PLAN_VECTORS } from '@breeze/shared/m365/commsPlanVectors';
import { buildCommsSendEffect } from '@breeze/shared/m365';
import { computeCommsEnvelopeDigest, computeCommsPlanDigest } from '@breeze/shared/m365/commsDigests';

/**
 * Cross-package agreement. The API runs these corpora through its own import
 * path (canonicalize.vectors.test.ts); this file makes the executor the second
 * consumer. If anything ever shadows, wraps, or re-implements the canonicalizer
 * or the digest pair on this side, the digests the API stored stop matching and
 * this fails — which is the entire content-binding guarantee (design §5.2,
 * risk #4). Expectations are frozen constants, never recomputed here.
 */
describe('canonicalization vectors (executor side)', () => {
  expect(CANONICALIZATION_VECTORS.length).toBeGreaterThan(10);
  for (const vector of CANONICALIZATION_VECTORS) {
    it(vector.name, () => {
      const canonical = canonicalizeArguments(vector.input);
      if (vector.canonical !== undefined) expect(canonical).toBe(vector.canonical);
      expect(computeArgumentDigest(canonical)).toBe(vector.digest);
    });
  }
});

describe('comms plan vectors (executor side)', () => {
  expect(COMMS_PLAN_VECTORS.length).toBeGreaterThan(5);
  for (const vector of COMMS_PLAN_VECTORS) {
    it(vector.name, () => {
      const envelope = buildCommsSendEffect(vector.input);
      expect(computeCommsEnvelopeDigest(envelope)).toBe(vector.envelopeDigest);
      expect(computeCommsPlanDigest(envelope)).toBe(vector.planDigest);
    });
  }
});
```

Run: `pnpm --filter=@breeze/m365-communications-executor exec vitest run src/conformance.vectors.test.ts` — PASS.

- [ ] **Step 6: Full package suite, typecheck, lint**

```bash
pnpm --filter=@breeze/m365-communications-executor test:run
pnpm --filter=@breeze/m365-communications-executor exec tsc --noEmit
pnpm --filter=@breeze/m365-communications-executor lint
```

Expected: all green. (The root `typecheck` job never covers executors — this `tsc --noEmit` is the only pass, and Task 8c makes CI run it.)

- [ ] **Step 7: Commit**

```bash
git add apps/m365-communications-executor pnpm-lock.yaml \
        apps/api/src/config/dockerfileWorkspaceManifests.test.ts
git commit -m "feat(m365): communications executor scaffold — config, internal auth, app chassis

Task 8 (part 2) of the M365 communications-delegated executor (design §2, §9, §10).

Clone of the actions-executor chassis (the read→actions diff proves the
lineage is a mechanical rename) with the deltas the credential model forces:

- Body cap is 128 KiB from the shared constant, not the sibling 16 KiB
  default, which is smaller than one legal max-size mail (§2 item 1). A test
  pins a >16KiB request succeeding.
- internalAuth.verify returns the authenticated claim set — correlationId,
  effectDigest, planDigest, consentGeneration — so operations can only read
  digests that were actually signed (§5.2). Claim shape is validated inside
  the single indistinguishable rejection chain.
- Config parses the KEK keyring (reader set must include the writer — a
  config that cannot decrypt its own writes refuses to boot), the token-cache
  DSN, and two version-pinned vault refs; audience m365-communications-executor,
  port 3005, callback path byte-matching the API side.
- Four POST operations incl. /v1/revoke-connection (revoke is a real code
  path here, not a runbook step — §3.3).
- conformance.vectors.test.ts makes this package the second consumer of both
  frozen corpora, closing the loop both corpus headers were waiting on.

startConfiguredExecutor is deferred to the operations task; index.ts exports
only the server binding until then."
```

---

### Task 9: Token cache — store interface, Postgres + in-memory impls, KEK crypto, fenced-lease semantics

Spec §3.2 in full. This is the highest-risk code in the plan; every semantic the spec defines gets a named test.

**Files:**
- Create: `src/credentials/tokenCacheStore.ts` (types + interface)
- Create: `src/credentials/inMemoryTokenCacheStore.ts`
- Create: `src/credentials/postgresTokenCacheStore.ts`
- Create: `src/credentials/tokenCacheStore.contract.test.ts` (one suite, both impls)
- Create: `src/credentials/tokenCacheCrypto.ts` + `tokenCacheCrypto.test.ts`
- Create: `src/credentials/delegatedTokenCache.ts` + `delegatedTokenCache.test.ts`

**Interfaces:**
- Consumes: nothing from tasks 8a/8b (pure credentials layer).
- Produces (consumed by Tasks 10–11):
  - `interface TokenCacheRow { connectionId: string; cacheVersion: number; fence: number; consentGeneration: number; consentAttemptId: string; state: 'active' | 'tombstoned'; ciphertext: Uint8Array | null; kekVersion: string | null; leaseHolder: string | null; leaseFence: number | null; leaseExpiresAt: Date | null; updatedAt: Date }`
  - `type CasWriteOutcome = 'written' | 'version-conflict' | 'fence-superseded' | 'tombstoned' | 'absent'`
  - `interface TokenCacheStore { ensureSchema(): Promise<void>; read(connectionId): Promise<TokenCacheRow | null>; putConsentRow(input): Promise<{ cacheVersion: number }>; casWrite(input): Promise<CasWriteOutcome>; acquireLease(connectionId, holderId, ttlMs): Promise<{ fence: number } | null>; releaseLease(connectionId, holderId, fence): Promise<void>; tombstone(connectionId, onlyIfAttemptId: string | null): Promise<boolean>; close(): Promise<void> }`
  - `interface KekKeyring { writerVersion: string; keys: ReadonlyMap<string, Uint8Array> }`, `encryptCacheBlob(keyring, connectionId, plaintext): { ciphertext: Uint8Array; kekVersion: string }`, `decryptCacheBlob(keyring, connectionId, ciphertext, kekVersion): string`, `class CorruptCacheCiphertextError`
  - `class DelegatedTokenCache` with `withLease<T>(connectionId, fn: (loaded: LoadedCache) => Promise<T>): Promise<T>`, `commitRotation(connectionId, loaded, newPlaintext): Promise<'written' | 'concurrent'>`, `writeConsentRow(input): Promise<{ cacheGeneration: number }>`, `peekGeneration(connectionId): Promise<{ state: 'active' | 'tombstoned'; consentGeneration: number } | null>`, `tombstone(connectionId, onlyIfAttemptId): Promise<boolean>`; `class TokenCacheUnavailableError extends Error { readonly code: 'delegated_reauth_required' | 'binding_stale' | 'credential_rotation_failed' | 'consent_superseded' }`; `interface LoadedCache { plaintext: string; cacheVersion: number; fence: number; consentGeneration: number; consentAttemptId: string }`

- [ ] **Step 1: The store interface and the Postgres schema**

`src/credentials/tokenCacheStore.ts` — the types above, plus doc comments carrying the spec's semantics verbatim: zero-row CAS is **not** self-evidently concurrent redemption and must be disambiguated by re-read; only the consent path creates rows; tombstone is terminal for a generation but a new consent attempt may replace it.

The Postgres schema (`ensureSchema`, idempotent, run by the executor at boot — **this is the executor's own store, not Breeze Postgres**; no Breeze migration file, no RLS/cascade/export registration, and the plan's PR must say so):

```sql
CREATE TABLE IF NOT EXISTS comms_token_cache (
  connection_id      uuid PRIMARY KEY,
  cache_version      bigint NOT NULL,
  fence              bigint NOT NULL,
  consent_generation integer NOT NULL,
  consent_attempt_id uuid NOT NULL,
  state              text NOT NULL CHECK (state IN ('active', 'tombstoned')),
  ciphertext         bytea,
  kek_version        text,
  lease_holder       uuid,
  lease_fence        bigint,
  lease_expires_at   timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'tombstoned') = (ciphertext IS NULL))
);
```

- [ ] **Step 2: Write the contract suite (failing)**

`src/credentials/tokenCacheStore.contract.test.ts` — one `runTokenCacheStoreContract(name, harnessFactory)` function executed for both impls. The harness carries the store plus two escape hatches the semantics tests need:

```ts
interface StoreHarness {
  store: TokenCacheStore;
  /** Force the current lease to be expired (in-memory: advance the fake clock; Postgres: UPDATE lease_expires_at into the past). */
  expireLease(connectionId: string): Promise<void>;
  cleanup(): Promise<void>;
}
```

Cases (each is an `it`, names verbatim so the suite reads as the spec):

1. `read of an absent connection returns null`
2. `putConsentRow creates an active row at cache_version 1, fence 1`
3. `putConsentRow for a new attempt wholly replaces the row and bumps version and fence` (also proves it revives a tombstoned row — re-consent after revoke)
4. `casWrite with the current version and fence writes and bumps cache_version`
5. `casWrite against a bumped version reports version-conflict` (concurrent redemption — retry silently, spec §3.2)
6. `casWrite against a tombstoned row reports tombstoned` (revoke racing a refresh cannot be undone)
7. `casWrite with a stale fence reports fence-superseded` (write the row with a newer lease first)
8. `casWrite against an absent row reports absent and does NOT create it` (acquireTokenSilent must never initialize)
9. `acquireLease returns a monotonically increasing fence and excludes a second holder`
10. `acquireLease succeeds after the previous lease expires` (via `expireLease`)
11. `releaseLease frees the lease only for the holding fence`
12. `tombstone conditioned on a stale attempt id is a no-op; unconditional tombstone nulls the ciphertext`

Bottom of the file:

```ts
runTokenCacheStoreContract('InMemoryTokenCacheStore', makeInMemoryHarness);

const PG_DSN = process.env.M365_COMMS_TOKEN_CACHE_TEST_DSN;
describe.runIf(!!PG_DSN)('PostgresTokenCacheStore (live)', () => {
  runTokenCacheStoreContract('PostgresTokenCacheStore', () => makePostgresHarness(PG_DSN!));
});
```

The Postgres harness `ensureSchema()`s, `TRUNCATE comms_token_cache`s per test, and `expireLease` runs `UPDATE comms_token_cache SET lease_expires_at = now() - interval '1 second' WHERE connection_id = …`. Locally: `M365_COMMS_TOKEN_CACHE_TEST_DSN="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" pnpm --filter=@breeze/m365-communications-executor test:run` (the table is created in and truncated from the test database only — it never touches Breeze schemas). CI provides a dedicated service container (Task 8c).

Run without the DSN first: FAIL (modules missing), and the PG half reports skipped — **skipped is not passed**; the CI job is what makes the PG half load-bearing.

- [ ] **Step 3: Implement the in-memory store**

`inMemoryTokenCacheStore.ts` — `Map<string, TokenCacheRow>`, constructor takes `{ now?: () => Date }` for the fake clock. Every method implements exactly the SQL semantics of Step 4 (write both from the same doc comments). `putConsentRow` on an existing row: `cacheVersion + 1`, `fence + 1`, `state: 'active'`, lease fields nulled. `casWrite` checks, in order: absent → `'absent'`; tombstoned → `'tombstoned'`; `cacheVersion !== expected` → `'version-conflict'`; `fence > input.fence` → `'fence-superseded'`; else write.

- [ ] **Step 4: Implement the Postgres store**

`postgresTokenCacheStore.ts` with `postgres` (postgres.js), `max: 3`, `prepare: false`. The three load-bearing statements:

```ts
// casWrite — the §3.2 predicate verbatim. Zero rows is then DISAMBIGUATED by
// re-read; assuming "someone else redeemed" is the v2 bug this design fixed.
const updated = await this.sql`
  UPDATE comms_token_cache
     SET ciphertext = ${Buffer.from(input.ciphertext)},
         kek_version = ${input.kekVersion},
         cache_version = cache_version + 1,
         updated_at = now()
   WHERE connection_id = ${input.connectionId}
     AND cache_version = ${input.expectedCacheVersion}
     AND fence <= ${input.fence}
     AND state = 'active'`;
if (updated.count === 1) return 'written';
const row = await this.read(input.connectionId);
if (!row) return 'absent';
if (row.state === 'tombstoned') return 'tombstoned';
if (row.fence > input.fence) return 'fence-superseded';
return 'version-conflict';
```

```ts
// acquireLease — every SET expression reads the OLD row, so fence and
// lease_fence get the same incremented value atomically. This monotonic fence
// is what excludes a paused holder that resumes after expiry (§3.2): expiry
// alone is not mutual exclusion.
const rows = await this.sql`
  UPDATE comms_token_cache
     SET fence = fence + 1,
         lease_holder = ${holderId},
         lease_fence = fence + 1,
         lease_expires_at = now() + make_interval(secs => ${ttlMs / 1000}),
         updated_at = now()
   WHERE connection_id = ${connectionId}
     AND state = 'active'
     AND (lease_holder IS NULL OR lease_expires_at < now() OR lease_holder = ${holderId})
   RETURNING lease_fence`;
return rows.length === 1 ? { fence: Number(rows[0]!.lease_fence) } : null;
```

```ts
// tombstone — terminal for this generation; also bumps version and fence so
// any in-flight CAS write loses. onlyIfAttemptId scopes the consent-supersede
// cleanup to its own attempt's row.
const updated = await this.sql`
  UPDATE comms_token_cache
     SET state = 'tombstoned', ciphertext = NULL, kek_version = NULL,
         lease_holder = NULL, lease_fence = NULL, lease_expires_at = NULL,
         cache_version = cache_version + 1, fence = fence + 1, updated_at = now()
   WHERE connection_id = ${connectionId}
     AND state = 'active'
     AND (${onlyIfAttemptId}::uuid IS NULL OR consent_attempt_id = ${onlyIfAttemptId})`;
return updated.count === 1;
```

`putConsentRow`:

```ts
const rows = await this.sql`
  INSERT INTO comms_token_cache (
    connection_id, cache_version, fence, consent_generation, consent_attempt_id,
    state, ciphertext, kek_version, updated_at
  ) VALUES (
    ${input.connectionId}, 1, 1, ${input.consentGeneration}, ${input.consentAttemptId},
    'active', ${Buffer.from(input.ciphertext)}, ${input.kekVersion}, now()
  )
  ON CONFLICT (connection_id) DO UPDATE SET
    cache_version = comms_token_cache.cache_version + 1,
    fence = comms_token_cache.fence + 1,
    consent_generation = EXCLUDED.consent_generation,
    consent_attempt_id = EXCLUDED.consent_attempt_id,
    state = 'active',
    ciphertext = EXCLUDED.ciphertext,
    kek_version = EXCLUDED.kek_version,
    lease_holder = NULL, lease_fence = NULL, lease_expires_at = NULL,
    updated_at = now()
  RETURNING cache_version`;
return { cacheVersion: Number(rows[0]!.cache_version) };
```

`read` maps snake_case → the row type with `Number(...)` on the bigints (cache versions and fences stay far below 2^53; a doc comment says so).

Run the contract suite both ways:

```bash
pnpm --filter=@breeze/m365-communications-executor exec vitest run src/credentials/tokenCacheStore.contract.test.ts
M365_COMMS_TOKEN_CACHE_TEST_DSN="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  pnpm --filter=@breeze/m365-communications-executor exec vitest run src/credentials/tokenCacheStore.contract.test.ts
```

Expected: 12 cases green in-memory; 12 more green against live Postgres.

- [ ] **Step 5: KEK crypto**

`tokenCacheCrypto.ts` — AES-256-GCM via `node:crypto`, ciphertext layout `iv(12) ‖ tag(16) ‖ data`, AAD `m365-comms-token-cache:v1:<connectionId>` (binds a ciphertext to its connection — a row-content swap across connections fails the tag):

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface KekKeyring {
  writerVersion: string;
  /** version → 32-byte key. Boot guarantees writerVersion ∈ keys (config + loadKekKeyring). */
  keys: ReadonlyMap<string, Uint8Array>;
}

export class CorruptCacheCiphertextError extends Error {
  constructor(readonly reason: 'unknown-kek-version' | 'malformed' | 'decrypt-failed') {
    super(`token cache ciphertext unusable: ${reason}`);
    this.name = 'CorruptCacheCiphertextError';
  }
}

function aad(connectionId: string): Buffer {
  return Buffer.from(`m365-comms-token-cache:v1:${connectionId}`, 'utf8');
}

export function encryptCacheBlob(
  keyring: KekKeyring, connectionId: string, plaintext: string,
): { ciphertext: Uint8Array; kekVersion: string } {
  const key = keyring.keys.get(keyring.writerVersion);
  if (!key || key.byteLength !== 32) throw new Error('keyring writer version has no 32-byte key');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(connectionId));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), data]),
    kekVersion: keyring.writerVersion,
  };
}

export function decryptCacheBlob(
  keyring: KekKeyring, connectionId: string, ciphertext: Uint8Array, kekVersion: string | null,
): string {
  if (kekVersion === null) throw new CorruptCacheCiphertextError('malformed');
  const key = keyring.keys.get(kekVersion);
  if (!key) throw new CorruptCacheCiphertextError('unknown-kek-version');
  if (ciphertext.byteLength <= IV_BYTES + TAG_BYTES) throw new CorruptCacheCiphertextError('malformed');
  const buffer = Buffer.from(ciphertext);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, IV_BYTES));
    decipher.setAuthTag(buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    decipher.setAAD(aad(connectionId));
    return Buffer.concat([
      decipher.update(buffer.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new CorruptCacheCiphertextError('decrypt-failed');
  }
}
```

Tests: round-trip; a reader-only version decrypts what an older writer wrapped (rollover window); tampered byte → `decrypt-failed`; different `connectionId` in AAD → `decrypt-failed`; unknown `kekVersion` → `unknown-kek-version`; null `kekVersion` → `malformed`.

- [ ] **Step 6: The semantics façade — `delegatedTokenCache.ts`**

Composes store + crypto into the behaviors MSAL and operations consume; this is where every §3.2 "defined semantics" lives:

```ts
export class TokenCacheUnavailableError extends Error {
  constructor(
    readonly code: 'delegated_reauth_required' | 'binding_stale' | 'credential_rotation_failed' | 'consent_superseded',
    readonly detail?: string,   // enum-ish words only; never credential or message material
  ) {
    super(`token cache unavailable: ${code}`);
    this.name = 'TokenCacheUnavailableError';
  }
}

export interface LoadedCache {
  plaintext: string;
  cacheVersion: number;
  fence: number;
  consentGeneration: number;
  consentAttemptId: string;
}

export class DelegatedTokenCache {
  constructor(private readonly deps: {
    store: TokenCacheStore;
    keyring: KekKeyring;
    holderId: string;                 // this replica's uuid
    leaseTtlMs?: number;              // default 30_000 (§3.2 "short, ~30s")
    leaseAttempts?: number;           // default 10
    sleep?: (ms: number) => Promise<void>;
  }) {}

  async withLease<T>(connectionId: string, fn: (loaded: LoadedCache) => Promise<T>): Promise<T> {
    // 1. acquireLease with bounded retry (sleep 250ms between attempts);
    //    exhaustion -> TokenCacheUnavailableError('credential_rotation_failed')
    //    — lease contention is transient; the caller maps it to a retryable failure.
    // 2. read the row:
    //    - null        -> 'delegated_reauth_required'  (NEVER initialize — §3.2)
    //    - tombstoned  -> 'delegated_reauth_required'  (revoked; terminal)
    // 3. decryptCacheBlob; CorruptCacheCiphertextError -> 'delegated_reauth_required'
    //    (fail closed, row PRESERVED for forensics — never treat undecryptable as empty)
    // 4. run fn(loaded); finally releaseLease(connectionId, holderId, fence).
  }

  async commitRotation(
    connectionId: string, loaded: LoadedCache, newPlaintext: string,
  ): Promise<'written' | 'concurrent'> {
    const { ciphertext, kekVersion } = encryptCacheBlob(this.deps.keyring, connectionId, newPlaintext);
    const outcome = await this.deps.store.casWrite({
      connectionId, expectedCacheVersion: loaded.cacheVersion, fence: loaded.fence, ciphertext, kekVersion,
    });
    switch (outcome) {
      case 'written': return 'written';
      case 'version-conflict': return 'concurrent';           // retry silent (§3.2)
      case 'fence-superseded':                                 // our lease was superseded; the
        throw new TokenCacheUnavailableError('credential_rotation_failed');  // RT MSAL holds may be lost
      case 'tombstoned':                                       // revoke won the race; never undo it
      case 'absent':
        throw new TokenCacheUnavailableError('delegated_reauth_required');
    }
  }

  async writeConsentRow(input: {
    connectionId: string; consentAttemptId: string; consentGeneration: number; plaintext: string;
  }): Promise<{ cacheGeneration: number }> {
    const { ciphertext, kekVersion } = encryptCacheBlob(this.deps.keyring, input.connectionId, input.plaintext);
    const { cacheVersion } = await this.deps.store.putConsentRow({ ...input, ciphertext, kekVersion });
    return { cacheGeneration: cacheVersion };
  }

  async peekGeneration(connectionId: string) {
    const row = await this.deps.store.read(connectionId);
    return row ? { state: row.state, consentGeneration: row.consentGeneration } : null;
  }

  tombstone(connectionId: string, onlyIfAttemptId: string | null) {
    return this.deps.store.tombstone(connectionId, onlyIfAttemptId);
  }
}
```

`delegatedTokenCache.test.ts` (in-memory store + fake clock + injected `sleep`) — the four spec-mandated scenarios, named as such, plus the base paths:

1. **`a paused lease holder resuming after expiry is rejected by fence`** — A loads under fence 1; A's lease expires; B acquires (fence 2) and commits; A's `commitRotation` → store reports `fence-superseded` → `credential_rotation_failed`. B's write is intact.
2. **`a revoke racing a refresh cannot be undone`** — A loads; `tombstone()` lands; A's `commitRotation` → `delegated_reauth_required`; the row is still tombstoned and `peekGeneration` reports it.
3. **`corrupt ciphertext fails closed and preserves the row`** — flip one ciphertext byte in the store; `withLease` throws `delegated_reauth_required`; a direct `store.read` still returns the original (untouched) ciphertext.
4. **`concurrent redemption yields one winner and no lost write`** — A and B both load version N (interleave via the fake clock/lease expiry); A commits → `'written'`; B commits → `'concurrent'`; a re-load sees A's plaintext at version N+1.
5. `an absent row is never initialized` — `withLease` on an unknown connection → `delegated_reauth_required`; `store.read` still null.
6. `withLease releases the lease on success and on throw`.
7. `writeConsentRow returns the bumped cacheGeneration on reconsent`.

- [ ] **Step 7: Run everything, typecheck, commit**

```bash
pnpm --filter=@breeze/m365-communications-executor test:run
M365_COMMS_TOKEN_CACHE_TEST_DSN="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  pnpm --filter=@breeze/m365-communications-executor test:run
pnpm --filter=@breeze/m365-communications-executor exec tsc --noEmit
git add apps/m365-communications-executor/src/credentials
git commit -m "feat(m365-comms): fenced-lease CAS token cache with KEK keyring

Task 9 of the M365 communications-delegated executor (design §3.2).

TokenCacheStore behind an interface with two implementations — Postgres
(postgres.js; the executor-owned store, NOT Breeze Postgres) and in-memory —
both run through one 12-case contract suite; CI runs the Postgres half
against a service container. The CAS predicate, fenced lease (every SET
reads the old row, so fence and lease_fence increment atomically), and
tombstone are single SQL statements.

Semantics the spec defines get named tests: a zero-row CAS is disambiguated
by re-read, never assumed concurrent; an absent row is never initialized
outside consent; corrupt ciphertext fails closed and preserves the row;
revoke tombstones and cannot be undone by an in-flight refresh; a paused
lease holder resuming after expiry is rejected by fence; concurrent
redemption yields one winner.

Ciphertext is AES-256-GCM under a KEK keyring (reader set + single writer)
with the connection id in the AAD, so a cross-connection row swap fails the
auth tag. This table lives in the executor's own store and is deliberately
absent from every Breeze tenancy contract (RLS coverage, cascades, export
policy) — those govern the tenant database."
```

---

### Task 10: Key Vault providers + MSAL delegated credential broker

Spec §3.2 (MSAL confidential client, per-connection cache partition), §4.2 (ephemeral redemption).

**Files:**
- Create: `src/credentials/azureKeyVaultProvider.ts` + test — clone of the sibling (`SECRET_NAME = 'm365-comms-client-cert'`, envelope `domain: 'communications-delegated'`; everything else unchanged, including the `SecretClientPort` seam)
- Create: `src/credentials/kekKeyringProvider.ts` + test
- Create: `src/microsoft/delegatedClient.ts` + `delegatedClient.test.ts`

**Interfaces:**
- Consumes: `DelegatedTokenCache`, `LoadedCache`, `TokenCacheUnavailableError` (Task 9); `PinnedCertificateProvider` (cloned `credentials/types.ts` — copy it too, unchanged); config fields (Task 8b).
- Produces (consumed by Task 11):
  - `loadKekKeyring(config: { vaultUrl; tokenCacheKekVaultRef; tokenCacheKekWriterVersion; tokenCacheKekReaderVersions }, client: SecretClientPort): Promise<KekKeyring>`
  - `class DelegatedCredentialError extends Error { readonly code: 'delegated_reauth_required' | 'credential_rotation_failed' | 'credential_unavailable' | 'identity_token_invalid' | 'binding_stale' }`
  - `interface DelegatedAcquisition { accessToken: OpaqueAccessToken; tokenTenantId: string; tokenUserObjectId: string; usedCacheGeneration: number; rotated: boolean }`
  - `interface ConsentRedemption { rawIdToken: string; grantedScopes: readonly string[]; accessToken: OpaqueAccessToken; serializedCache: string; accountTenantId: string | null; accountUserObjectId: string | null }`
  - `createDelegatedCredentialBroker(config: { clientId: string; certificateProvider: PinnedCertificateProvider; tokenCache: DelegatedTokenCache }, dependencies?: { createConfidentialClient?: ConfidentialClientFactory }): { acquireForConnection(input: { connectionId; tenantId; expectedUserObjectId; consentGeneration }): Promise<DelegatedAcquisition>; redeemConsentCode(input: { authorizationCode; codeVerifier; redirectUri }): Promise<ConsentRedemption> }`
  - `type OpaqueAccessToken` (branded, cloned from the sibling's `tokenClient.ts` — only the brand, not the client; MSAL replaces it)

- [ ] **Step 1: KV providers (mechanical + one new loader)**

Clone `credentials/types.ts` and `credentials/azureKeyVaultProvider.ts` (+test) with the two-string delta. Then `kekKeyringProvider.ts`:

```ts
/**
 * Loads every reader version of the token-cache KEK at boot (design §3.2
 * keyring: reader set + single writer). Each version is its own AKV secret
 * version of `m365-comms-token-cache-kek`, wrapping envelope:
 *   { schemaVersion: 1, domain: 'communications-delegated',
 *     material: { kind: 'symmetric-key', keyBase64: <44-char base64 of 32 bytes> } }
 * A version that is missing, malformed, or not 32 bytes fails boot — a replica
 * that cannot read the whole reader set would silently fail on rows wrapped
 * under the version it lacks, which is exactly the rolling-deploy hazard the
 * keyring exists to prevent.
 */
export async function loadKekKeyring(
  config: {
    vaultUrl: string;
    tokenCacheKekVaultRef: string;
    tokenCacheKekWriterVersion: string;
    tokenCacheKekReaderVersions: readonly string[];
  },
  client: SecretClientPort,
): Promise<KekKeyring> { /* getSecret('m365-comms-token-cache-kek', { version }) per reader;
                            zod-validate the envelope (.strict(), literal kind);
                            base64-decode, assert 32 bytes; Map<version, key> */ }
```

Tests via the stubbed `SecretClientPort` (the sibling's style): happy path with two readers; missing version → throws; 31-byte key → throws; wrong `kind` literal → throws.

- [ ] **Step 2: Write the failing broker tests**

`delegatedClient.test.ts`. All MSAL behavior arrives through the `createConfidentialClient` seam — a factory returning the minimal surface the broker uses:

```ts
interface ConfidentialClientPort {
  acquireTokenSilent(request: {
    account: MsalAccountLike; scopes: string[]; authority: string; forceRefresh?: boolean;
  }): Promise<MsalAuthResultLike | null>;
  acquireTokenByCode(request: {
    code: string; redirectUri: string; codeVerifier: string; scopes: string[]; authority: string;
  }): Promise<MsalAuthResultLike | null>;
  getTokenCache(): {
    deserialize(blob: string): void;   // hydrate from the durable row
    serialize(): string;
    getAllAccounts(): Promise<MsalAccountLike[]>;
  };
}
type ConfidentialClientFactory = (options: { authority: string }) => ConfidentialClientPort;
```

(Real MSAL's `ICachePlugin` is NOT used: the broker hydrates the CCA's cache from the row via `deserialize` inside `withLease`, and after acquisition compares `serialize()` output — a change means MSAL rotated, and the broker commits it via `commitRotation`. This keeps every store interaction inside the lease and makes rotation-commit outcomes explicit, instead of burying them in plugin callbacks MSAL invokes at times it chooses. Document this divergence from the spec's `ICachePlugin` sketch in the module header: the *semantics* — decrypt-load before access, encrypt-CAS-write after change — are exactly §3.2's; only the invocation point moved to where the lease is held.)

Test cases:

1. `hydrates the CCA from the cache row and returns a token for the pinned account` — stub returns one account with `idTokenClaims: { tid, oid }` matching; result carries `usedCacheGeneration` = loaded `cacheVersion`, `rotated: false` when `serialize()` is unchanged.
2. `commits a rotated cache and reports rotated: true` — stub's `serialize()` returns a new blob after `acquireTokenSilent`; assert the store row changed (via the in-memory store) and `rotated: true`.
3. `maps invalid_grant to delegated_reauth_required` — stub throws `{ errorCode: 'invalid_grant' }`-shaped and an `InteractionRequiredAuthError`-shaped error (name property) → both `DelegatedCredentialError('delegated_reauth_required')`; **nothing is written to the store**.
4. `refuses when no cached account matches the pinned oid/tid` → `identity_token_invalid`.
5. `refuses a generation mismatch before any MSAL call` — row generation 2, request generation 1 → `binding_stale`; the factory was never invoked.
6. `retries once on concurrent rotation commit` — first `commitRotation` → `'concurrent'`; broker re-loads and re-acquires; second commit `'written'`.
7. `two connections never share a client instance` — interleave acquisitions for A and B; assert the factory was called once per connection *per call* and each CCA only ever saw its own row's blob (per-request CCA — decision 4).
8. `redeemConsentCode never touches the durable store` — happy redemption returns `rawIdToken`, `grantedScopes`, `serializedCache`; the store (spied) saw zero reads and zero writes — **this is §4.2's ephemeral-cache mechanism**.
9. `redeemConsentCode maps provider rejection to credential_unavailable and invalid_grant to delegated_reauth_required`.

- [ ] **Step 3: Implement the broker**

`delegatedClient.ts`. Real default factory:

```ts
import { ConfidentialClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { X509Certificate } from 'node:crypto';

const GRAPH_SILENT_SCOPES = ['https://graph.microsoft.com/.default'];

/** The Graph resource scopes from the v2 profile, fully qualified for the
 *  authorize/redeem legs. Derived, not hardcoded — the profile is the source
 *  of truth (a test pins the derived set). openid/profile/offline_access are
 *  OIDC scopes MSAL adds itself. */
const OIDC_SCOPES = new Set(['openid', 'profile', 'offline_access']);
export const DELEGATED_REDEMPTION_SCOPES = getM365PermissionProfile('communications-delegated')
  .delegatedPermissions
  .filter((scope) => !OIDC_SCOPES.has(scope))
  .map((scope) => `https://graph.microsoft.com/${scope}`);

function defaultFactory(credential: { certificatePem: string; privateKeyPem: string }, clientId: string): ConfidentialClientFactory {
  return ({ authority }) => new ConfidentialClientApplication({
    auth: {
      clientId,
      authority,
      clientCertificate: {
        thumbprintSha256: new X509Certificate(credential.certificatePem)
          .fingerprint256.replaceAll(':', ''),
        privateKey: credential.privateKeyPem,
      },
    },
  }) as unknown as ConfidentialClientPort;
}
```

`acquireForConnection` (inside `tokenCache.withLease`):

```ts
async function acquireForConnection(input: AcquireInput): Promise<DelegatedAcquisition> {
  return acquireWithRetry(input, 2);   // 2 = initial + one 'concurrent' retry
}

async function attempt(input: AcquireInput): Promise<DelegatedAcquisition | 'concurrent'> {
  return dependencies.tokenCache.withLease(input.connectionId, async (loaded) => {
    if (loaded.consentGeneration !== input.consentGeneration) {
      throw new DelegatedCredentialError('binding_stale');
    }
    const credential = await fetchCertificate();          // credential_unavailable on throw
    try {
      const cca = createClient(credential, {
        authority: `https://login.microsoftonline.com/${input.tenantId}`,
      });
      cca.getTokenCache().deserialize(loaded.plaintext);
      const accounts = await cca.getTokenCache().getAllAccounts();
      const account = accounts.find((candidate) =>
        candidate.idTokenClaims?.oid === input.expectedUserObjectId
        && candidate.idTokenClaims?.tid === input.tenantId);
      if (!account) throw new DelegatedCredentialError('identity_token_invalid');

      let result;
      try {
        result = await cca.acquireTokenSilent({
          account, scopes: GRAPH_SILENT_SCOPES,
          authority: `https://login.microsoftonline.com/${input.tenantId}`,
        });
      } catch (error) {
        throw mapMsalError(error);
      }
      if (!result?.accessToken) throw new DelegatedCredentialError('credential_unavailable');

      const serialized = cca.getTokenCache().serialize();
      let rotated = false;
      if (serialized !== loaded.plaintext) {
        const outcome = await dependencies.tokenCache.commitRotation(
          input.connectionId, loaded, serialized,
        );
        if (outcome === 'concurrent') return 'concurrent';   // caller re-loads and retries once
        rotated = true;
      }
      return {
        accessToken: result.accessToken as OpaqueAccessToken,
        tokenTenantId: String(account.idTokenClaims?.tid ?? ''),
        tokenUserObjectId: String(account.idTokenClaims?.oid ?? ''),
        usedCacheGeneration: loaded.cacheVersion + (rotated ? 1 : 0),
        rotated,
      };
    } finally {
      credential.certificatePem = '';
      credential.privateKeyPem = '';
    }
  });
}
```

`mapMsalError`: `error.name === 'InteractionRequiredAuthError'` or `errorCode`/`message` containing `invalid_grant` → `delegated_reauth_required`; `TokenCacheUnavailableError` re-thrown as its own code; everything else → `credential_unavailable`. Never include `error.message` content in the thrown error (MSAL messages can embed server text).

`redeemConsentCode`: fresh CCA against `https://login.microsoftonline.com/common` with **no** deserialize call — MSAL's default in-memory cache *is* the §4.2 throwaway; the durable store is not touched here at all. Returns the raw `idToken`, `result.scopes` (the granted set — spec §4.2: source scopes from `AuthenticationResult.scopes`, never an `scp` claim), the access token (for the `/me` probe), `getTokenCache().serialize()` (committed by the consent *operation* only after every check passes), and the account's `tid`/`oid` claims if present.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm --filter=@breeze/m365-communications-executor test:run
pnpm --filter=@breeze/m365-communications-executor exec tsc --noEmit
git add apps/m365-communications-executor/src/credentials apps/m365-communications-executor/src/microsoft
git commit -m "feat(m365-comms): MSAL confidential client broker over the fenced token cache

Task 10 of the M365 communications-delegated executor (design §3.2, §4.2).

ConfidentialClientApplication with a certificate assertion (PKCE is not
client auth — §3.2), one instance per request per connection, hydrated from
the durable row inside the lease and committed back through the CAS write on
rotation. The ICachePlugin sketch became explicit hydrate/serialize at the
lease boundary: the §3.2 semantics are identical, but rotation-commit
outcomes (written/concurrent/superseded/tombstoned) are handled where the
lease is held instead of inside callbacks MSAL times itself. One silent
retry on concurrent rotation.

redeemConsentCode runs on a throwaway in-memory cache and provably never
touches the durable store — the §4.2 verify-then-persist mechanism; the
consent operation commits the serialized cache only after every identity and
scope check passes. invalid_grant / interaction_required map to
delegated_reauth_required; scopes come from AuthenticationResult.scopes,
never token parsing. Also: KV cert provider clone and the KEK keyring
loader (whole reader set at boot; a replica that cannot read every reader
version refuses to start)."
```

---

### Task 11: Operations — digest verification, identity gate, consent, Graph verbs, redaction, final wiring

Spec §9 (the seven-step execute contract), §4.2 (consent checks in order), §5.2–§5.3 (digests + generation re-check), §7 (catalog semantics).

**Files:**
- Create: `src/microsoft/graphClient.ts` + test — copy the **actions** executor's byte-identical, then: delete `patch` (interface member + impl + its tests), add `post` in its place (same shape: fixed `graphUrl` path, `content-type: application/json`, bounded response, non-2xx through `readFailure`; returns `{ status: number; body: unknown | null }` — sendMail answers 202 with no body, createMessage answers 201 with JSON)
- Create: `src/microsoft/identity.ts` + test — `verifyDelegatedUserIdentity` (modified clone, below)
- Create: `src/microsoft/reconcile.ts` + test — `reconcileCommunicationsDelegated`
- Create: `src/microsoft/commsMailActions.ts` + test — the Tier-1/2 inline actions
- Create: `src/operations.ts` + `operations.test.ts`
- Create: `src/operations.redaction.test.ts`
- Modify: `src/index.ts` — `startConfiguredExecutor` + autostart

**Interfaces:**
- Consumes: everything above; `computeCommsEnvelopeDigest` / `computeCommsPlanDigest` from `@breeze/shared/m365/commsDigests`; `buildSendPlan`, `M365_COMMS_ACTION_FIELDS`, `M365_COMMS_ATTACHMENT_FIELDS`, `M365_COMMS_MAX_RETRIEVED_BODY_BYTES` from `@breeze/shared/m365`.
- Produces: `createExecutorOperations(config: { clientId: string; broker; tokenCache: DelegatedTokenCache; graphClient: MicrosoftGraphClient; verifyIdentity?: typeof verifyDelegatedUserIdentity; now?: () => Date }): { completeConsent; retest; revokeConnection; executeAction }` — the shape `createExecutorApp` spreads; `startConfiguredExecutor(): Promise<{ close(): void }>`.

- [ ] **Step 1: `verifyDelegatedUserIdentity` (modified clone of the sibling identity gate)**

Clone the sibling `identity.ts` and change exactly this: drop the `tenantHint` pre-check and the `wids`/admin-role requirement (a delegated user is not an admin and the tenant is *learned*, not hinted — §4.2); `requiredClaims: ['iss', 'aud', 'sub', 'tid', 'oid', 'nonce', 'exp', 'nbf']`; after `jwtVerify`, keep the sibling's re-checks (`iss === https://login.microsoftonline.com/<tid>/v2.0` derived from the token's own `tid`, `aud === clientId`, nonce equality, safe-integer `exp`/`nbf`), then:

```ts
export interface VerifiedDelegatedUserIdentity {
  tenantId: string;
  userObjectId: string;
}

// expected.expectedTenantId: null on first consent; on reconnect a different
// returned tid is refused with tenant_mismatch BEFORE anything persists —
// otherwise reconnect is a mailbox-substitution primitive (§4.2 step 4).
if (expected.expectedTenantId !== null && payload.tid !== expected.expectedTenantId) {
  throw new MicrosoftIdentityFailure('tenant_mismatch');
}
return { tenantId: payload.tid as string, userObjectId: payload.oid as string };
```

Tests: clone the sibling's injected-`verificationKey` RS256 harness; cases — valid first consent returns `tid`/`oid`; reconnect with matching expected tenant passes; reconnect with a different tenant → `tenant_mismatch`; wrong nonce / wrong aud / iss not derived from tid → `identity_token_invalid`; **no `wids` claim required** (a token without it verifies — pins the delta from the admin gate).

- [ ] **Step 2: `reconcileCommunicationsDelegated`**

```ts
const OIDC_SCOPES = new Set(['openid', 'profile', 'offline_access']);
const GRAPH_PREFIX = 'https://graph.microsoft.com/';

/**
 * String-set reconciliation of granted vs profile scopes (§4.2) — NOT
 * appRoleAssignment enumeration; delegated grants have no app roles. Scopes
 * arrive from AuthenticationResult.scopes and may come back either bare
 * (`Mail.Send`) or resource-qualified; normalize both sides, compare
 * case-insensitively. offline_access is load-bearing but is an OIDC scope the
 * token response does not echo as a resource scope — its absence surfaces as
 * the first acquireTokenSilent failing with delegated_reauth_required, which
 * the runbook documents (Plan 3).
 */
export function reconcileCommunicationsDelegated(grantedScopes: readonly string[]): {
  complete: boolean;
  missingScopes: string[];
} {
  const granted = new Set(grantedScopes.map((scope) =>
    (scope.startsWith(GRAPH_PREFIX) ? scope.slice(GRAPH_PREFIX.length) : scope).toLowerCase()));
  const required = getM365PermissionProfile('communications-delegated')
    .delegatedPermissions.filter((scope) => !OIDC_SCOPES.has(scope));
  const missingScopes = required.filter((scope) => !granted.has(scope.toLowerCase()));
  return { complete: missingScopes.length === 0, missingScopes };
}
```

Tests: complete set (bare and qualified forms both); missing `Mail.Send` reported; extra scopes ignored; case-insensitive. One test derives `required` from the real profile so a future profile v3 changes this file's expectations loudly.

- [ ] **Step 3: `commsMailActions.ts` — the Tier-1/2 inline actions**

Same skeleton as the sibling `writeActions.ts` (single `try`/`switch`/`never`, `mapGraphFailure` that **re-throws non-Graph errors**):

```ts
export interface GraphCommsActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
}

const FOLDER_PATHS: Record<M365CommsMailFolder, string> = {
  inbox: 'inbox', sentitems: 'sentitems', drafts: 'drafts', archive: 'archive',
};

export async function executeGraphCommsInlineAction(
  action: M365CommsInlineAction,
  ctx: GraphCommsActionContext,
): Promise<M365CommsResult> {
  try {
    switch (action.type) {
      case 'm365.comms.mail.list': {
        const fields = M365_COMMS_ACTION_FIELDS['m365.comms.mail.list'];
        const query: Record<string, string> = {
          $select: fields.join(','),
          $top: String(action.pageSize ?? 25),
        };
        if (action.search !== undefined) {
          // $search excludes $orderby and $filter at Graph; the schema already
          // refuses search+sinceHours, and we drop $orderby here for the same
          // reason (Graph orders $search results by relevance).
          query.$search = `"${action.search}"`;
        } else {
          query.$orderby = 'receivedDateTime desc';
          if (action.sinceHours !== undefined) {
            query.$filter = `receivedDateTime ge ${sinceIso(action.sinceHours, ctx)}`;
          }
        }
        const { items, truncated } = await ctx.graphClient.readCollection({
          accessToken: ctx.accessToken,
          path: `/me/mailFolders/${FOLDER_PATHS[action.folder]}/messages`,
          query,
          maxItems: action.pageSize ?? 25,
          maxPages: 1,
        });
        return { success: true, kind: 'collection', items: items.map((item) => project(item, fields)), truncated };
      }
      case 'm365.comms.mail.get': {
        const fields = M365_COMMS_ACTION_FIELDS['m365.comms.mail.get'];
        const resource = await ctx.graphClient.readResource({
          accessToken: ctx.accessToken,
          path: `/me/messages/${encodeURIComponent(action.messageId)}`,
          select: fields.filter((field) => field !== 'attachments'),
          expand: `attachments($select=${M365_COMMS_ATTACHMENT_FIELDS.join(',')})`,
        });
        const { projected, truncated } = projectMessageWithBodyCap(resource, fields);
        return { success: true, kind: 'resource', resource: projected, truncated };
      }
      case 'm365.comms.mail.draft.create': {
        const created = await ctx.graphClient.post({
          accessToken: ctx.accessToken,
          path: '/me/messages',
          body: {
            subject: action.subject,
            body: { contentType: 'Text', content: action.bodyText },
            toRecipients: action.to.map((address) => ({ emailAddress: { address } })),
            ccRecipients: (action.cc ?? []).map((address) => ({ emailAddress: { address } })),
          },
        });
        return { success: true, kind: 'resource', resource: project(created.body, ['id', 'webLink']) };
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`unhandled comms action ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    return mapGraphFailure(error);
  }
}
```

Details that get their own tests:
- `project(record, allowlist)` strips every non-allowlisted field — a Graph response smuggling `internetMessageHeaders` comes back without it.
- `projectMessageWithBodyCap`: `body.content` capped at `M365_COMMS_MAX_RETRIEVED_BODY_BYTES` (64 KiB) measured in UTF-8 **bytes**; on truncation, cut at a code-point boundary and set `truncated: true`. HTML bodies pass through as text (`body.contentType` reported as Graph returned it; content is not sanitized — the API/UI layer owns rendering).
- `mapGraphFailure`: `graph_not_found` → `message_not_found` for `mail.get` (comms taxonomy), else pass Graph codes through; `graph_throttled` keeps `retryAfterSeconds`; non-`GraphClientError` re-thrown (surfaces as the app's 500).
- The sibling's `readResource` takes `{ accessToken, path, select }` only (verified — `graphClient.ts:45-49`); add an optional `expand?: string` parameter in the clone, joined into the query as `$expand` exactly like `$select`, same fixed-path rules.
- `sinceIso` uses an injected clock on the context (`ctx.now?.() ?? new Date()`), ISO-8601 UTC.

- [ ] **Step 4: `operations.ts` — the seven-step execute contract and the ordered consent**

```ts
export interface CommsOperationDependencies {
  clientId: string;
  broker: ReturnType<typeof createDelegatedCredentialBroker>;
  tokenCache: DelegatedTokenCache;
  graphClient: MicrosoftGraphClient;
  verifyIdentity: typeof verifyDelegatedUserIdentity;
  now: () => Date;
}

function failed(errorCode: M365CommsFailureCode, retryAfterSeconds?: number): M365CommsResult { … }

function mapCredentialError(error: unknown): M365CommsResult {
  if (error instanceof DelegatedCredentialError || error instanceof TokenCacheUnavailableError) {
    return failed(error.code as M365CommsFailureCode);
  }
  throw error;   // unexpected bugs surface as the app's 500, never a fabricated failure
}

export async function executeActionOperation(
  request: M365CommsRequest,
  authentication: InternalRequestAuthentication,
  dependencies: CommsOperationDependencies,
): Promise<M365CommsResult> {
  const isSend = 'envelope' in request;

  if (isSend) {
    // §9 step 3: digest verification precedes credential access — an
    // unapproved effect must never even cause a token acquisition. Both
    // claims are required for a send; their values were signed by the API
    // from what was STORED at intent creation, never recomputed at release.
    if (
      authentication.effectDigest === null
      || authentication.planDigest === null
      || authentication.consentGeneration === null
    ) {
      return failed('effect_digest_mismatch');
    }
    if (computeCommsEnvelopeDigest(request.envelope) !== authentication.effectDigest) {
      return failed('effect_digest_mismatch');
    }
    if (computeCommsPlanDigest(request.envelope) !== authentication.planDigest) {
      return failed('effect_digest_mismatch');
    }
    // The body's consentGeneration is asserted EQUAL to the claim — never
    // read instead of it (§5.2). The schema already pinned envelope == body.
    if (authentication.consentGeneration !== request.consentGeneration) {
      return failed('binding_stale');
    }
  }

  let acquisition: DelegatedAcquisition;
  try {
    acquisition = await dependencies.broker.acquireForConnection({
      connectionId: request.connectionId,
      tenantId: request.tenantId,
      expectedUserObjectId: request.expectedUserObjectId,
      consentGeneration: request.consentGeneration,
    });
  } catch (error) {
    return mapCredentialError(error);
  }

  // §9 step 5: the identity gate re-asserts the PINNED tid/oid against MSAL's
  // account claims. No Graph-access-token parsing anywhere.
  if (acquisition.tokenTenantId !== request.tenantId) return failed('tenant_mismatch');
  if (acquisition.tokenUserObjectId !== request.expectedUserObjectId) {
    return failed('identity_token_invalid');
  }

  if (!isSend) {
    const result = await executeGraphCommsInlineAction(request.action, {
      accessToken: acquisition.accessToken,
      graphClient: dependencies.graphClient,
      now: dependencies.now,
    });
    return result.success
      ? { ...result, usedCacheGeneration: acquisition.usedCacheGeneration, rotated: acquisition.rotated }
      : result;
  }

  // §5.2 TOCTOU close: the generation is re-checked from the store
  // immediately before the Graph call — a reconnect promoted between
  // acquisition and here must abort the send.
  const current = await dependencies.tokenCache.peekGeneration(request.connectionId);
  if (!current || current.state !== 'active' || current.consentGeneration !== request.consentGeneration) {
    return failed('binding_stale');
  }

  // §5.3(a): the wire payload IS the verified plan. No construction remains
  // after digest verification, so there is nothing left to get wrong.
  const plan = buildSendPlan(request.envelope);
  try {
    await dependencies.graphClient.post({
      accessToken: acquisition.accessToken,
      path: plan.path,
      body: plan.body,
    });
  } catch (error) {
    if (error instanceof GraphClientError) {
      // A timeout mid-send is AMBIGUOUS — the mail may have gone out. Never
      // internally retry a send (§8); the intent terminalizes and Sent Items
      // is the recovery oracle.
      return failed(error.code as M365CommsFailureCode, error.retryAfterSeconds);
    }
    throw error;
  }
  return {
    success: true, kind: 'sent',
    sentAt: dependencies.now().toISOString(),
    usedCacheGeneration: acquisition.usedCacheGeneration,
    rotated: acquisition.rotated,
  };
}
```

`completeConsentOperation` — the §4.2 checks **in order**, nothing persisted until all pass:

```ts
export async function completeConsentOperation(
  request: CommsCompleteConsentRequest,
  dependencies: CommsOperationDependencies,
): Promise<CommsCompleteConsentResult> {
  // 1. Redeem on the throwaway cache. Nothing durable exists yet.
  let redemption: ConsentRedemption;
  try {
    redemption = await dependencies.broker.redeemConsentCode({
      authorizationCode: request.authorizationCode,
      codeVerifier: request.codeVerifier,
      redirectUri: request.redirectUri,
    });
  } catch (error) { return mapCredentialError(error) as CommsCompleteConsentResult; }

  // 2. Validate the ID token: signature, iss derived from the returned tid,
  //    aud, nonce, exp/nbf — and pin tid/oid from the VALIDATED claims.
  let identity: VerifiedDelegatedUserIdentity;
  try {
    identity = await dependencies.verifyIdentity(redemption.rawIdToken, {
      clientId: dependencies.clientId,
      nonce: request.nonce,
      expectedTenantId: request.expectedTenantId,
    });
  } catch (error) {
    if (error instanceof MicrosoftIdentityFailure) return failedConsent(error.code);
    throw error;
  }

  // 3. Probe GET /me?$select=id,userPrincipalName,mail and assert id === oid.
  //    (User.Read covers this; deliberately NOT /me/mailboxSettings — §4.2.)
  const me = await dependencies.graphClient.readResource({
    accessToken: redemption.accessToken,
    path: '/me',
    select: ['id', 'userPrincipalName', 'mail'],
  });   // Graph errors -> mapGraphFailure-style failedConsent
  if (me.id !== identity.userObjectId) return failedConsent('identity_token_invalid');

  // 4. Scope reconciliation from AuthenticationResult.scopes. Fail closed —
  //    a consent missing Mail.Send would produce a mailbox that can never
  //    send; better refused now than degraded on first use.
  const reconciliation = reconcileCommunicationsDelegated(redemption.grantedScopes);
  if (!reconciliation.complete) return failedConsent('graph_permission_missing');

  // 5. ONLY NOW persist: encrypt and commit the serialized cache stamped with
  //    the attempt and the generation this attempt will claim (§4.1 ordering —
  //    the API's promotion UPDATE follows; on supersede it calls
  //    revoke-connection with this attempt id and the row dies inert).
  const { cacheGeneration } = await dependencies.tokenCache.writeConsentRow({
    connectionId: request.connectionId,
    consentAttemptId: request.consentAttemptId,
    consentGeneration: request.claimedConsentGeneration,
    plaintext: redemption.serializedCache,
  });

  return {
    success: true,
    tenantId: identity.tenantId,
    userObjectId: identity.userObjectId,
    userPrincipalName: String(me.userPrincipalName),
    mail: me.mail === undefined || me.mail === null ? null : String(me.mail),
    grantedScopes: [...redemption.grantedScopes],
    cacheGeneration,
    verifiedAt: dependencies.now().toISOString(),
  };
}
```

(A failure at step 3/4 discards a refresh token Microsoft already issued — the recorded §4.2 residual; it is unused, unpersisted, and dies of inactivity. Plan 3's runbook documents it; a comment here points there.)

`retestOperation`: `broker.acquireForConnection` + the same identity gate + `GET /me?$select=id,userPrincipalName` asserting `id === expectedUserObjectId` → `{ success: true, userPrincipalName, usedCacheGeneration, verifiedAt }`; failures map exactly as execute's.

`revokeConnectionOperation`: `tokenCache.tombstone(request.connectionId, request.consentAttemptId)` → `{ success: true, tombstoned }`. Never errors on an absent row (`tombstoned: false`) — revoke is idempotent from the API's perspective.

`createExecutorOperations(config)` wires defaults (`verifyIdentity: verifyDelegatedUserIdentity`, `now: () => new Date()`) and returns the four bound closures, results belt-and-braces re-`parse`d with their result schemas exactly like the sibling.

`operations.test.ts` — the sibling's `deps(overrides)` factory style. Minimum cases, each asserting **order** where the spec demands it:

1. send with matching claims + digests → Graph `post` called with **exactly** `buildSendPlan(envelope).body` (deep-equal), result `sent` with cache metadata
2. send with a tampered envelope (one recipient changed) → `effect_digest_mismatch`, and the broker was **never called** (credential access precedence, §9 step 3)
3. send with digests matching but `planDigest` claim wrong → `effect_digest_mismatch`, broker never called
4. send with absent claims → `effect_digest_mismatch`, broker never called
5. send where `peekGeneration` reports generation+1 (reconnect promoted mid-flight) → `binding_stale`, Graph `post` never called — **the §5.2 TOCTOU test**
6. read action → no digest requirement, result projected, cache metadata attached
7. broker `binding_stale` / `delegated_reauth_required` / `credential_rotation_failed` map through verbatim
8. identity gate: acquisition claims `tid` ≠ request → `tenant_mismatch`; `oid` ≠ → `identity_token_invalid`
9. consent: full order pinned with spies — redeem → verify → probe → reconcile → **then** `writeConsentRow`; a failure at each earlier stage leaves `writeConsentRow` uncalled (four cases)
10. consent with reconnect tenant mismatch → `tenant_mismatch`, nothing persisted
11. consent with missing `Mail.Send` → `graph_permission_missing`, nothing persisted
12. revoke: conditional attempt id honored; absent row → `{ tombstoned: false }`
13. Graph timeout during send → `graph_request_timeout`, `post` called exactly once (no internal retry — §8)

- [ ] **Step 5: Redaction leak tests**

`src/operations.redaction.test.ts` — sentinel strings that must never escape:

```ts
const SENTINELS = ['LEAK-SUBJECT-9f3a', 'leak-recipient-9f3a@example.com', 'LEAK-BODY-9f3a'];
```

Build a send envelope and inline actions from the sentinels, then drive **every failure path** reachable from `operations.ts` (digest mismatch, binding stale, broker throws each `DelegatedCredentialError` code, Graph throws each `GraphClientError` code, consent failures) and assert for each: `JSON.stringify(result)` contains no sentinel; any error the operation throws (`mapCredentialError` re-throw path) stringifies without sentinels. Also assert `GraphClientError` and `DelegatedCredentialError` instances constructed during the tests have `message`s matching `/^[a-z0-9_ :]+$/i` — enum words only. This is risk #1 made mechanical: correspondence must never ride an error path into logs.

- [ ] **Step 6: Finish `src/index.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { SecretClient } from '@azure/keyvault-secrets';
import { createExecutorApp } from './app';
import { createAzureCredential, loadExecutorConfig } from './config';
import { createEdDsaInternalRequestAuthenticator } from './internalAuth';
import { AzureKeyVaultCertificateProvider } from './credentials/azureKeyVaultProvider';
import { loadKekKeyring } from './credentials/kekKeyringProvider';
import { PostgresTokenCacheStore } from './credentials/postgresTokenCacheStore';
import { DelegatedTokenCache } from './credentials/delegatedTokenCache';
import { createDelegatedCredentialBroker } from './microsoft/delegatedClient';
import { createMicrosoftGraphClient } from './microsoft/graphClient';
import { createExecutorOperations } from './operations';

export async function startConfiguredExecutor(): Promise<{ close(): void }> {
  const config = loadExecutorConfig();
  const authenticator = await createEdDsaInternalRequestAuthenticator({
    publicJwk: config.internalAuthPublicJwk,
    kid: config.internalAuthKid,
  });
  const secretClient = new SecretClient(
    config.vaultUrl,
    createAzureCredential(config.azureCredentialMode),
  );
  // fromConfig keeps the sibling's field names (verified: it takes
  // { vaultUrl, vaultRef, credentialVersion, azureCredentialMode }); the comms
  // config's cert fields are adapted at the call site.
  const certificateProvider = AzureKeyVaultCertificateProvider.fromConfig({
    vaultUrl: config.vaultUrl,
    vaultRef: config.clientCertVaultRef,
    credentialVersion: config.clientCertVersion,
    azureCredentialMode: config.azureCredentialMode,
  });
  const keyring = await loadKekKeyring(config, secretClient);
  const store = new PostgresTokenCacheStore(config.tokenCacheDsn);
  await store.ensureSchema();
  const tokenCache = new DelegatedTokenCache({ store, keyring, holderId: randomUUID() });
  const broker = createDelegatedCredentialBroker({
    clientId: config.clientId, certificateProvider, tokenCache,
  });
  const graphClient = createMicrosoftGraphClient({ applicationId: config.clientId });
  const operations = createExecutorOperations({
    clientId: config.clientId, broker, tokenCache, graphClient,
  });
  const app = createExecutorApp({ authenticator, ...operations });
  return startExecutorServer(app, config);
}

if (process.env.M365_COMMS_EXECUTOR_AUTOSTART === '1') {
  void startConfiguredExecutor().catch(() => { process.exitCode = 1; });
}
```


- [ ] **Step 7: Full suite, build, typecheck, lint, commit**

```bash
pnpm --filter=@breeze/m365-communications-executor test:run
M365_COMMS_TOKEN_CACHE_TEST_DSN="postgresql://breeze_test:breeze_test@localhost:5433/breeze_test" \
  pnpm --filter=@breeze/m365-communications-executor test:run
pnpm --filter=@breeze/m365-communications-executor exec tsc --noEmit
pnpm --filter=@breeze/m365-communications-executor build && test -s apps/m365-communications-executor/dist/index.cjs
pnpm --filter=@breeze/m365-communications-executor lint
git add apps/m365-communications-executor
git commit -m "feat(m365-comms): operations — both digests verified before credential access

Task 11 of the M365 communications-delegated executor (design §4.2, §5.2, §5.3, §9).

The execute path recomputes the envelope digest AND the plan digest from the
received envelope and compares against signed JWT claims before any token
acquisition — tests pin that a tampered envelope never reaches the broker.
The consent generation is checked three times: claim-vs-body, at credential
acquisition (broker), and re-read from the store immediately before the
Graph call (the §5.2 TOCTOU window). The wire payload is
JSON.stringify(buildSendPlan(envelope).body) — no construction survives
verification. Sends are never internally retried; a timeout terminalizes.

Consent redeems on the throwaway cache, then validates the ID token
(signature, iss derived from the returned tid, aud, nonce), probes
GET /me?\$select=id,userPrincipalName,mail asserting id === oid, reconciles
granted scopes against profile v2 (missing scopes fail closed), and only
then commits the encrypted cache stamped with the attempt and claimed
generation. Spy tests pin the order; nothing persists on any earlier failure.

Redaction is mechanical: sentinel-string leak tests drive every failure path
and assert bodies, subjects, and recipients never escape into results or
thrown errors. Graph client is the sibling's byte-identical bounds pattern
with post replacing patch; identity gate is the delegated variant (tenant
learned, no admin roles); index.ts wires the full boot path."
```

---

### Task 8c: CI + supply-chain wiring (same PR — an executor without CI is how #2893 happened)

Spec §14 task 8's CI clause. Every snippet clones the actions executor's; the guard additions assert only what this PR wires (compose/env-template/runtime-smoke parity is Plan 3 task 18's, where those files are created).

**Files:**
- Modify: `.github/workflows/ci.yml` — test job (after line ~247), build job (after ~748), `ci-success` (4 places)
- Modify: `.github/workflows/release.yml` — `build-docker-m365-communications-executor` (after ~2607)
- Modify: `.github/workflows/security.yml` — image build + Trivy scan steps
- Modify: `.github/dependabot.yml` — docker ecosystem entry (after ~333)
- Modify: `scripts/security/check-supply-chain-hardening.sh` — comms parity blocks

- [ ] **Step 1: ci.yml test + build jobs**

Clone `test-m365-graph-actions-executor` / `build-m365-graph-actions-executor` with the filter renamed to `@breeze/m365-communications-executor` and every `uses:` SHA pin copied **verbatim** (the `workflow-lint` job rejects unpinned actions). The test job additionally gets the store's service container:

```yaml
  test-m365-communications-executor:
    name: Test M365 Communications Executor
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: comms_cache
          POSTGRES_PASSWORD: comms_cache
          POSTGRES_DB: comms_cache_test
        ports:
          - 5439:5432
        options: >-
          --health-cmd "pg_isready -U comms_cache"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    steps:
      # checkout / pnpm / node / install — verbatim from the actions test job
      - name: Run executor tests
        env:
          # Runs the Postgres half of the token-cache store contract suite.
          # Without this the fenced-lease/CAS SQL is only proven in-memory.
          M365_COMMS_TOKEN_CACHE_TEST_DSN: postgresql://comms_cache:comms_cache@localhost:5439/comms_cache_test
        run: pnpm --filter=@breeze/m365-communications-executor test:run
```

The build job is a pure rename (typecheck → build → `test -s apps/m365-communications-executor/dist/index.cjs`).

- [ ] **Step 2: ci-success — all four edits**

The env var alone is decorative; the `[[ ]]` clause is what blocks:

1. `needs:` — append `test-m365-communications-executor` and `build-m365-communications-executor`
2. `env:` — `TEST_M365_COMMUNICATIONS_EXECUTOR_RESULT: ${{ needs.test-m365-communications-executor.result }}` and `BUILD_M365_COMMUNICATIONS_EXECUTOR_RESULT: ${{ needs.build-m365-communications-executor.result }}` beside their actions siblings
3. + 4. the two blocking clauses beside their siblings:
   `[[ "${TEST_M365_COMMUNICATIONS_EXECUTOR_RESULT}" != "success" ]] || \` and `[[ "${BUILD_M365_COMMUNICATIONS_EXECUTOR_RESULT}" != "success" ]] || \`

- [ ] **Step 3: release.yml image job**

Clone `build-docker-m365-graph-actions-executor` (release.yml:2513–2607) renaming the job to `build-docker-m365-communications-executor`, image path segment to `m365-communications-executor`, Dockerfile path, and artifact names (`m365-communications-executor-image-digest`). **Keep the step id `push-executor-digest` and the literal step names** (`Scan exact executor digest`, `Promote scanned executor digest`, `Record executor digest`, `Upload executor digest`) — the hardening guard greps those names and asserts their order per job block.

- [ ] **Step 4: security.yml Trivy image scan**

Beside the actions steps:

```yaml
      - name: Build M365 Communications Executor image
        run: docker build -f apps/m365-communications-executor/Dockerfile -t breeze-m365-communications-executor:security-scan .
```

and a `Scan M365 Communications Executor image` step cloning the actions scan (same pinned `trivy-action` SHA, `severity: 'HIGH,CRITICAL'`, `exit-code: '1'`, no `continue-on-error` — the guard rejects it).

- [ ] **Step 5: dependabot.yml**

Clone the actions docker entry with `directory: "/apps/m365-communications-executor"` (same schedule, labels, commit-message prefix).

- [ ] **Step 6: Hardening-guard parity blocks**

In `scripts/security/check-supply-chain-hardening.sh`, clone the actions blocks with `ACTIONS`→`COMMUNICATIONS` / `actions`→`communications` renames:

1. Six `require_grep`s against `$ci_success_block` (needs ×2, env ×2, blocking clause ×2)
2. `require_grep 'breeze-m365-communications-executor:security-scan' .github/workflows/security.yml …`
3. A `comms_release_block` with all 11 release-shape assertions (push-by-digest, exact-digest scan, blocking severity/exit-code, imagetools promote, exactly 2 `--tag`s, no mutable tags, build exactly once, the two `require_order`s)
4. `require_grep 'directory: "/apps/m365-communications-executor"' .github/dependabot.yml …`
5. A Dockerfile-shape block cloning the read executor's (`:138–160`) against `apps/m365-communications-executor/Dockerfile` — digest-pinned FROM ×2, `USER node`, HEALTHCHECK on `/healthz`, `CMD ["node", "dist/index.cjs"]`, no apk, no secret COPY, no `COPY . .`. (The actions executor never got one — an acknowledged inconsistency; the comms clone starts consistent.)

**Deliberately absent until Plan 3 task 18** (add a dated comment in the script saying so): the compose-file assertions (secret mount, onboarding-off default, service rejection), the env-template digest-pin grep, and the `check-m365-comms-runtime.sh` smoke + its executable check — each greps files/entries that task 18 creates.

- [ ] **Step 7: Verify every guard locally, then commit**

```bash
bash scripts/security/check-supply-chain-hardening.sh
pnpm test:workflow-security        # SHA-pin lint over the new jobs
pnpm --filter=@breeze/api exec vitest run src/config/dockerfileWorkspaceManifests.test.ts
docker build -f apps/m365-communications-executor/Dockerfile -t breeze-m365-communications-executor:local . \
  && docker rmi breeze-m365-communications-executor:local
git add .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/security.yml \
        .github/dependabot.yml scripts/security/check-supply-chain-hardening.sh
git commit -m "ci(m365-comms): full CI, release-image, Trivy, Dependabot, and hardening-guard parity

Task 8 (part 3) of the M365 communications-delegated executor.

Test + build jobs (the test job carries a Postgres service container so the
fenced-lease/CAS SQL is proven against a live store in CI, not only
in-memory), all four ci-success edits, the digest-first release image job
(scan the exact digest, then promote — step ids and names kept verbatim
because the guard greps them), the security-workflow Trivy scan, the
Dependabot docker entry, and the guard blocks pinning all of it — plus a
Dockerfile-shape block the actions executor never got.

Compose/env-template/runtime-smoke guard entries are deliberately deferred
to plan 3 task 18 with a dated comment in the guard: they grep deploy
artifacts that task creates. #2893 exists because the actions executor
shipped with zero CI; this lands in the same PR as the executor."
```

---

## Verification before PR

1. `pnpm --filter=@breeze/shared exec vitest run` and both executor suite runs (with and without the store DSN) — green.
2. `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit --project apps/api/tsconfig.json` — green (shared changes + the manifest test edit are the only API-side surface).
3. `git diff --stat main -- apps/api/src/db apps/api/migrations` — **empty**. This plan adds no Breeze tables or columns, so no cascade/export-policy/RLS registration applies; the executor-owned `comms_token_cache` is outside those contracts by design (say so in the PR body).
4. `bash scripts/security/check-supply-chain-hardening.sh` — green.
5. Remember the stacked-PR trap: this branch is based on `main`, so `pull_request` CI runs normally — but if it is ever re-based onto an unmerged sibling, dispatch CI per branch (`gh workflow run CI --ref <branch>`) before trusting `gh pr checks`.

## Self-Review

**1. Spec coverage (§14 tasks 8–11).** Task 8: scaffold (8b: config loader, internalAuth with the new audience, Hono app for the 4 operations + healthz, ported sibling suites) + CI in the same PR (8c: test, typecheck-in-build, image build, Trivy, Dependabot, release image, hardening-guard pins) + the wire contracts the spec's task 8 implies but tasks 1–2 left unresolved (8a). Task 9: keyring wrap/unwrap, fenced lease acquire/release/expiry, CAS write, tombstone-on-revoke, defined absent/corrupt semantics, and all four named test scenarios the spec lists verbatim. Task 10: confidential client with cert assertion, per-connection cache partition over task 9, `acquireTokenSilent`, auth-code redemption with PKCE on an ephemeral cache, `invalid_grant → delegated_reauth_required`, all HTTP stubbed. Task 11: plan-digest recomputation before credential access against the authenticated claims only; generation re-check after acquisition and immediately before the Graph call; identity gate from pinned tid/oid via MSAL account claims; consent redeeming ephemeral-then-commit with scopes from `AuthenticationResult.scopes`; Graph body serialized from the verified plan only; projection enforcement; explicit leak tests.

Known deltas from the spec's sketch, each recorded as a decision above: `ICachePlugin` became hydrate/serialize at the lease boundary (identical semantics, explicit outcomes); the §9 request field list's `effectDigest?` body field is omitted per the spec's own §5.2 correction; `retest`/`complete-consent`/`revoke-connection` wire contracts are new (the spec's §7 row names the ops but no shape existed); the §3.2 store sketch's standalone `consent_generation` check rides the row's stamped generation compared against the signed claim.

**2. Placeholder scan.** No TBD/TODO/"handle errors". Clone steps name their source file and enumerate exact deltas (the read→actions diff proves that instruction is executable). Three signatures this plan initially hedged on were verified against the tree and are now stated as facts: `verifiedAt` is `executorContracts.ts`'s `z.string().datetime({ offset: true })`, `fromConfig` takes `{ vaultUrl, vaultRef, credentialVersion, azureCredentialMode }` (adapted at the call site), and `readResource` has no `expand` parameter (the clone adds one). The Zod-4 discriminated-union-with-refine question in Task 8a Step 3 states both outcomes and the rule for choosing — it is the one genuinely version-dependent behavior left to the implementer to observe.

**3. Type consistency.** `M365CommsRequest` union (`action` xor `envelope`) is what `app.ts` parses, `executeAction(request, authentication)` receives, and `operations.ts` discriminates with `'envelope' in request`. `InternalRequestAuthentication` (`effectDigest`/`planDigest`/`consentGeneration`, null-when-absent) is produced in 8b and consumed by name in 11. `LoadedCache`/`CasWriteOutcome`/`TokenCacheStore` signatures are identical in the Produces block, the impl steps, and the broker's usage. `DelegatedAcquisition.usedCacheGeneration` flows into every success result's `usedCacheGeneration`. `commsCompleteConsentRequestSchema.claimedConsentGeneration` is the name used in the consent op and `writeConsentRow`. The audience string is `m365-communications-executor` in config, internalAuth, and 8a's tests; the port is 3005 everywhere it appears.

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks. Tasks are strictly sequential; do not parallelize.

**2. Inline Execution** — `superpowers:executing-plans`, batch execution with checkpoints.

Plan 3 (tasks 12–18: API executor client, comms action service, consent phase + routes + UI, AI tools, approval projection, Tier-3 send + headless release, integration proof, deploy runbook) is not yet written. It consumes this plan's wire contracts and Plan 1's binding + runtime config, so write it after both are merged — and carry forward: the deferred guard entries (compose, env templates, runtime smoke), the `scripts/docs-review/mapping.json` entry, and the §4.2 discarded-grant residual for the runbook.
