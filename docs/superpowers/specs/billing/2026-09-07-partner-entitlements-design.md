---
title: Partner Entitlements
status: draft
date: 2026-09-07
owner: Todd Hebebrand
area: billing
related:
  - docs/superpowers/specs/onboarding-signup/2026-09-07-zero-touch-onboarding-design.md
  - docs/superpowers/specs/vuln-patch/2026-09-07-verified-software-library-consumer-design.md
  - docs/superpowers/specs/2026-08-11-workspace-ee-merge-design.md
  - docs/superpowers/specs/2026-08-09-selfhost-byo-signing-design.md
  - docs/superpowers/specs/billing/2026-06-14-billing-architecture-overview.md
first_consumers: [onboarding_supervisor, verified_library]
---

# Partner Entitlements

## 1. Summary

One generic, partner-axis feature gate. A typed registry in `@breeze/shared` declares every gateable key, its default state per `partners.plan`, and an optional zod-validated limits shape. A new `partner_entitlements` table stores overrides from three sources — billing, a signed self-hosted licence, and platform-admin manual grants — resolved at read under a fixed precedence. Every consumer asks the same question through `services/entitlements.ts`: routes via `requireEntitlement()`, queued agent work at claim time, the web via `GET /partner/me/entitlements` and `useEntitlement()`. Locked features render locked with an upsell, never hidden.

Breeze already gates features three incompatible ways — a boolean column (`partners.ai_for_office_enabled`), settings-JSONB flags with a precedence chain (`services/mlFeatureFlags.ts`), and a remote allow/deny call to the billing service (`services/aiCostTracker.ts:322`). This is the fourth mechanism, and it is only worth adding if it is explicitly the one the other three migrate onto. §13 sequences that.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Registry is an `as const` array + derived union in `@breeze/shared`, not a table | Mirrors `ML_FEATURE_FLAGS` (`services/mlFeatureFlags.ts:7-21`). Keys are code: a typo must fail `tsc`, not silently deny |
| D2 | RLS Shape 3 (partner-axis), `partner_id` only, no `org_id` | Entitlements are an MSP-level commercial fact. Reference table: `time_suggestion_decisions` (`migrations/2026-09-25-time-entry-source-and-suggestion-decisions.sql:29-67`) |
| D3 | Registration is `PARTNER_TENANT_TABLES` **only** | No `org_id` ⇒ no org-cascade, no export policy, no `orgMergeRegistry` (CLAUDE.md:75; those contract tests actively reject unrequired entries). Partner purge is discovered dynamically from `information_schema` by `cascadeDeletePartner` (`services/tenantCascade.ts:1186`) |
| D4 | `partner_id` FK carries explicit `ON DELETE CASCADE` | The newer convention (`db/schema/abuseSignals.ts:65`, "GDPR erasure boundary"); the ticketing tables' bare `REFERENCES partners(id)` is drift, not a pattern |
| D5 | Precedence `manual > license > billing > plan default` | Manual is the operator escape hatch and must beat a stale billing sync |
| D6 | One row **per source** — unique `(partner_id, feature_key, source)` — precedence resolved at **read** | Collapsing to one row destroys the grant underneath: an expiring manual override would drop to the plan default instead of revealing the billing row beneath it. Per-source rows also remove the read-then-write rank race — each source upserts only its own row |
| D7 | Licence verifies against a **compiled-in** LanternOps key, NOT `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` | That var is deliberately operator-owned and operator-replaceable (`2026-08-09-selfhost-byo-signing-design.md`); an env-configurable licence trust root is self-defeating |
| D8 | Licence signs canonical line-oriented bytes with a domain separator; signature embedded | Template: `services/rollbackDirectiveSigning.ts:39-110`. The release manifest signs raw file bytes with no canonicalisation — right for a file, wrong for a record that round-trips through JSON |
| D9 | The internal billing endpoint is a **new** inbound surface | No billing→API HTTP path exists to reuse (§7) |
| D10 | Feature **controls** fail closed-but-quiet (skeleton, never unlocked UI); **nav items** fail open | Two different questions. A control that flashes unlocked leaks revenue; a nav item hidden by a failed fetch hides something the partner pays for. `Sidebar.tsx`'s `requiresModule` comment already states the nav rule |

## 3. Goals / Non-goals

**Goals.** One check surface for every consumer. Self-hosted instances fully functional on free-tier features with no licence. Entitlement state legible to the partner (state, source, expiry, limits, why). Every change audited. Cross-instance cache coherence.

**Non-goals (v1).** Per-org or per-user entitlements (a future `org_entitlements` sibling, not a nullable column here). Seat metering — `limits` is a static ceiling the feature enforces, not a counter this table decrements. Routing `partners.max_devices` through this system. Self-service purchase. Migrating the three legacy mechanisms (§13 W3, deliberately after the mechanism proves out).

## 4. Data model

Migration **`apps/api/migrations/2026-10-14-100000-partner-entitlements.sql`**. The newest committed migration is `2026-10-13-110000-scripts-security-acknowledgement.sql`, so this sorts last — but that ceiling moves: re-check `git ls-tree -r --name-only origin/main apps/api/migrations | sort | tail -1` and bump before pushing, since the pre-push hook re-runs `check-migration-naming.sh --against-ref origin/main`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid PK default gen_random_uuid()` | |
| `partner_id` | `uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE` | tenancy axis (D4) |
| `feature_key` | `varchar(64) NOT NULL` | registry key; no FK — the registry is code |
| `state` | `varchar(16) NOT NULL` | CHECK `IN ('enabled','disabled')` |
| `source` | `varchar(16) NOT NULL` | CHECK `IN ('billing','license','manual')`; part of the unique key (D6). `plan` is never stored — it is the absence of any live row |
| `limits` | `jsonb` | nullable; zod-validated per key at write |
| `granted_at`, `expires_at`, `revoked_at` | `timestamptz` | `granted_at NOT NULL DEFAULT now()`; `expires_at` NULL = perpetual; revoke sets `revoked_at`, never DELETE |
| `reason` | `text` | CHECK `(source <> 'manual' OR reason IS NOT NULL)`; also carries the licence revocation reason (§8) |
| `updated_by` | `uuid REFERENCES users(id) ON DELETE SET NULL` | NULL for billing/licence writes |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | |

Indexes: `UNIQUE (partner_id, feature_key, source)` and `(partner_id)` — one row per source (D6), so a partner may hold up to three rows for one key and the resolver picks the winner. Varchar+CHECK rather than pg enums — cheap to extend, and what every recent partner-axis table uses.

**RLS.** `ENABLE` + `FORCE`, one `FOR ALL TO breeze_app` policy, shape copied verbatim from `time_suggestion_decisions_partner_access`, plus `GRANT SELECT, INSERT, UPDATE, DELETE ... TO breeze_app`:

```sql
USING      (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
WITH CHECK (public.breeze_current_scope() = 'system' OR public.breeze_has_partner_access(partner_id))
```

There is **no** partner-wide SELECT branch to add. That pattern (`org_id IS NULL AND partner_id = breeze_current_partner_id()`) belongs to org-XOR-partner *config* tables; a partner-AXIS table has no `org_id IS NULL` shape to key on, and `breeze_has_partner_access` also governs writes, so widening it would widen UPDATE/DELETE. Org-scoped and agent contexts reach the table through the service (§9).

**Registration.** Add `['partner_entitlements', 'partner_id']` to `PARTNER_TENANT_TABLES` (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:186`). That is the complete list (D3).

## 5. Registry (`packages/shared/src/entitlements/`)

```ts
export const ENTITLEMENT_KEYS = ['onboarding_supervisor', 'verified_library'] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export type EntitlementDefinition<K extends EntitlementKey = EntitlementKey> = {
  key: K;
  label: string;                                          // Plan & features row + the 403 body
  why: string;                                            // one sentence, the upsell line
  defaults: Record<PartnerPlan, 'enabled' | 'disabled'>;  // EVERY plan_type value
  limits?: z.ZodType<unknown>;                            // absent ⇒ limits must be null
  defaultLimits?: unknown;
};

export const ENTITLEMENTS: { [K in EntitlementKey]: EntitlementDefinition<K> } = { /* … */ };
export function isEntitlementKey(v: string): v is EntitlementKey { /* … */ }
export const ENTITLEMENT_GRACE_DAYS = 14;
```

The mapped-object (not array) shape makes `ENTITLEMENTS[key]` total; `Record<PartnerPlan, …>` makes a new plan value a compile error rather than a silent deny. `PartnerPlan` **must be re-derived from the pg enum** — see §15 Q1. Keep the module browser-safe (no `node:crypto`); the licence verifier lives in the API.

Seed keys: `onboarding_supervisor`, limits `{ maxWakesPerRun, maxRepairsPerStep, perRunCostCents }`, mapping onto the budgets in onboarding §9; `verified_library`, limits `{ maxVerifiedPackages: number | null }`. Both default `disabled` for free/starter/community, `enabled` for pro/enterprise/unlimited.

## 6. Sources & precedence

Resolution is a **read-time fold** over the rows for `(partnerId, key)`: take every row that is non-revoked (`revoked_at IS NULL`) and still live (within grace, below), rank them `manual (3) > license (2) > billing (1)`, and return the highest with its own `state`, `limits` and `source`. No live row ⇒ the registry default for `partners.plan`, tagged `source: 'plan'`.

Folding rather than collapsing is what makes an override **reversible**: when a manual grant expires, the billing row underneath it reappears instead of the key dropping to the plan default. A `state: 'disabled'` row wins its rank exactly like an `enabled` one — a manual deny beats a billing grant — and no fallback path in §12 may discard it.

Each source therefore only ever touches its own row: `INSERT … ON CONFLICT (partner_id, feature_key, source) DO UPDATE`. There is no cross-source read-then-write, so no rank race and no conflict class to surface: a billing resync cannot clobber a manual grant because it cannot address that row.

`expires_at` semantics are shared by all sources: a row stays live for **`ENTITLEMENT_GRACE_DAYS` past `expires_at`** (one shared constant so banner and server agree), during which the API reports `graceUntil` and the web shows a warning. After grace the row drops out of the fold and the next-highest live row — or the plan default — wins. Grace is computed, never written, so renewal is a plain upsert with no repair step.

## 7. Internal billing endpoint

**Finding that reshapes this section.** There is no inbound billing→API surface to reuse. `partners.plan` and `partners.max_devices` are written by the external `breeze-billing` service via **direct database writes** — `routes/orgs.ts:153` says so verbatim ("managed by the billing service (via direct DB writes)"), both columns are excluded from `createPartnerSchema`/`updatePartnerSchema`, and no `db.update(partners)` call site in this repo sets either. Every `BILLING_*` env var is **outbound**. So this is new construction; the reusable pieces are `/internal/synthetic`'s auth shape and the partner-API idempotency convention.

- **Path:** `PUT /api/v1/internal/billing/partners/:partnerId/entitlements`. Not `/internal/partners/:id/…` — that exact shape already exists in the *opposite* direction on the billing side (`services/breezeBillingClient.ts:58`); one extra segment avoids a confusing hour.
- **Auth:** router middleware modelled on `routes/internal/synthetic.ts:57-75` — unset token ⇒ **503** (off by default), then `Authorization: Bearer` via the SHA-256-then-`timingSafeEqual` helper (`synthetic.ts:51-55`), then an optional CSV IP allowlist checked **after** the token so membership cannot be probed unauthenticated. New vars `BILLING_INBOUND_TOKEN` / `BILLING_INBOUND_IP_ALLOWLIST`, declared in `config/validate.ts` (unlike `SYNTHETIC_TEST_TOKEN`, read raw from `process.env` — do not copy that) and mapped explicitly into the `api` service `environment:` block.
- **partnerGuard bypass:** add `if (path.startsWith('/api/v1/internal/billing/')) return next();` beside `apps/api/src/index.ts:725`, or every call 403s on partner status.
- **Body:** `{ entitlements: [{ featureKey, state, limits?, expiresAt? }] }` — the full desired set from billing's view, applied as a diff: keys present upserted `source='billing'`, billing-sourced rows absent from the body revoked, licence and manual rows untouched. Unknown `featureKey` ⇒ 400 listing offenders with **no partial apply**: a billing service one release ahead must fail loudly.
- **Idempotency:** `X-Idempotency-Key`, 1–128 printable ASCII, validated before any I/O — the convention at `routes/partnerApi/provisioning.ts:545-557`. v1 leans on the natural idempotency of a full-set diff plus `409 idempotency_key_reused` on same-key/different-fingerprint; the durable claim table (`db/schema/partnerServicePrincipals.ts:61-83`) is the upgrade path if replay protection is needed.
- **DB context:** `withSystemDbAccessContext` with a low-cardinality label — no `authMiddleware` means no ambient transaction, and the contextless-write guard rejects a bare write (`synthetic.ts:113-124`).
- **Plan stays the fallback.** This never writes `partners.plan`; billing keeps doing that directly.

**Blast radius.** `services/partnerActivation.ts:52-62` records a 2026-07-29 audit where billing's `customer.subscription.updated` handler backfilled `payment_method_attached_at` regardless of subscription status: 34 of 55 stamped partners had zero successful charges and several were auto-upgraded to a 250-device plan having paid nothing. An entitlements upsert is the same blast radius — read that status-veto reasoning before settling the contract, and record `details.subscriptionStatus` on the audit row so the same audit is repeatable.

## 8. Self-hosted licence

One JSON file, embedded signature, `schemaVersion: 1`. Every listed entitlement is a grant; a licence never disables. Keys are partner-independent.

```jsonc
{ "schemaVersion": 1, "licenseId": "uuid", "licensee": "Acme IT Ltd",
  "issuedAt": "2026-09-07T00:00:00Z", "expiresAt": "2027-09-07T00:00:00Z",  // second-precision RFC3339 UTC
  "entitlements": [ { "featureKey": "verified_library", "limits": { "maxVerifiedPackages": 500 } } ],
  "signingKeyId": "lanternops-license-2026", "signature": "<base64 64-byte Ed25519>" }
```

**Canonical bytes.** `canonicalLicenseBytes(unsigned)`, modelled line-for-line on `canonicalRollbackDirectiveBytes` (`services/rollbackDirectiveSigning.ts:79-110`): domain separator `breeze-license-v1` on line 1, one field per line, LF-joined, no trailing newline; `entitlements` folded in as `sha256(canonicalJson(entitlements))` with the same sorted-key `canonicalJson`; `requireSecondPrecisionTimestamp` on both timestamps; `rejectLineSeparators` over the whole object so no value can forge a line boundary. Verify with `crypto.verify(null, bytes, key, sig)` — the `null` digest is mandatory for PureEdDSA.

**Trust root.** Compiled-in `LICENSE_PUBLIC_KEYS` (array, for rotation overlap), raw base64 32-byte Ed25519 wrapped into SPKI with the `302a300506032b6570032100` prefix. Reuse `parsePublicKey`'s three-encoding logic from `services/releaseArtifactManifest.ts:105-197` — that prefix is already copy-pasted in six non-test places, so a seventh is the moment to extract `services/ed25519.ts` with the licence as first consumer.

**Boot** (`services/licenseLoader.ts`, from `bootstrap()` after `initializeDatabaseForStartup`, before `initializeWorkers`), under `withSystemDbAccessContext`. **Reconciliation runs on every start, including the failure paths** — a licence that is deleted, swapped for a forgery, or left to expire must not leave its grants standing:

1. Read `BREEZE_LICENSE_FILE` (path) or `BREEZE_LICENSE` (inline base64).
2. Parse and verify against every configured key.
3. **Absent, unverifiable, or expired beyond `ENTITLEMENT_GRACE_DAYS`** ⇒ revoke **every** live `source='license'` row on the instance (`revoked_at = now()`, `reason` one of `license_missing` / `license_invalid` / `license_expired`), log at **error** with that reason, capture to Sentry, and let resolution fall to the next-highest live row or the plan default. Boot continues — a bad licence must not produce a boot loop — but it grants nothing. The reason is returned by `GET /partner/me/entitlements` so the Plan & features page can name it.
4. Otherwise materialise: for **every** partner, upsert one `source='license'` row per licence entitlement with `expires_at = licence.expiresAt`, and revoke licence rows for keys no longer present. Multi-partner self-host fans out; a partner created later is picked up by the next boot plus a hook in `services/partnerCreate.ts`.
5. Audit `partner.entitlement.license_applied`, or `.license_revoked` carrying the reason, per partner with `licenseId`, `licensee`, `expiresAt`, keys.

**Self-host gate.** `isRecognizedSelfHostSignal(process.env.IS_HOSTED)` (`config/env.ts:314`) — the fail-closed idiom requiring `IS_HOSTED` be *explicitly* false rather than inferring self-host from `!isHosted()`. Polarity is right here: absent/garbage ⇒ licence ignored ⇒ denies rather than grants.

**Signing.** No licence-issuing CLI exists (unverified — nothing under `scripts/`, `apps/api/scripts/`, or the workflows). W2 adds `apps/api/scripts/issue-license.ts` with a **separate** private key from `RELEASE_MANIFEST_ED25519_PRIVATE_KEY`; sharing it would let a licence signature be replayed as a manifest signature, which is what D8's domain separator prevents.

## 9. Check surfaces

```ts
// apps/api/src/services/entitlements.ts
export async function getEntitlements(partnerId: string): Promise<Record<EntitlementKey, ResolvedEntitlement>>;
export async function hasEntitlement(partnerId: string, key: EntitlementKey): Promise<boolean>;
export async function getEntitlementLimits<K extends EntitlementKey>(partnerId: string, key: K): Promise<Limits<K> | null>;
export function invalidateEntitlementCache(partnerId?: string): void;
```

`getEntitlements` is the primitive; the others are thin. **One DB read resolves every key** — `mlFeatureFlags.ts:240-252` documents why per-key resolution self-deadlocks rather than merely slows: each partner-axis escape opens a second pooled connection under the request's own transaction, and eleven `Promise.all`ed escapes against the 25-connection ceiling hang with no acquire timeout.

The read wraps `readWithPartnerAxisVisibility` (`apps/api/src/db/partnerAxisRead.ts:55`): org-scoped, agent, helper, portal and org-OAuth contexts all carry `accessiblePartnerIds = []` and would otherwise get **zero rows with no error**, collapsing every entitlement to its plan default for exactly the population the feature serves. `partnerId` must come from verified auth or a row already resolved under the caller's RLS — never client input.

**Cache and staleness ceiling.** `Map<partnerId, …>`, 60 s TTL, invalidated on write — the shape of `services/remoteAccessPolicy.ts:92-103`. In-process, so publish `entitlements:changed` on Redis with `{ partnerId }` and subscribe at boot, mirroring `services/partnerTrust.ts:361-366`. When the DB is unreachable a cached entry may be served **past its TTL up to a hard ceiling of 5 minutes**; beyond that the resolver reports **failure, not a fallback** (§12). The cache is a correctness measure, not only latency — it is what keeps the claim path off a second pooled connection (below).

**Middleware.** `requireEntitlement(key)`, a factory like `requirePermission` (`middleware/auth.ts:827`), applied after `authMiddleware`. Denial returns `c.json({ code: 'entitlement_required', error: <label>, featureKey: key }, 403)` — a coded body, not an `HTTPException`, since the global `onError` forwards only `err.message` and clients branch on `code` (`requireMfa()` returns `MFA_REQUIRED` the same way). Null `auth.partnerId` ⇒ 403, fail closed. A **resolver failure** (DB unreachable and nothing inside the 5-minute staleness ceiling) is neither "entitled" nor "unentitled": return `c.json({ code: 'entitlement_check_failed', … }, 503)` with `Retry-After`, so a paying partner sees a retryable outage instead of a silent downgrade and an unentitled one still cannot get through.

**Claim time.** Queued work is claimed long after enqueue, so an entitlement revoked in between must not execute. The claim is `claimPendingCommandsForDevice` (`services/commandDispatch.ts:93`) — HTTP heartbeat and poll routes, never the WebSocket (`commandDispatch.ts:107-110`; #2407 removed WS batches) — and its gate is `partitionClaimable` (`services/commandClaimEligibility.ts:180`).

**Hard rule: never open a second pooled connection inside the claim transaction.** `claimPendingCommandsForDevice` opens `db.transaction`, and on the hot heartbeat path that runs inside `withDbAccessContext` with `scope: 'organization'` and `accessiblePartnerIds: []` (`routes/agents/heartbeat.ts:390`). A partner-axis read from in there takes the `runOutsideDbContext` → `withSystemDbAccessContext` escape (`db/partnerAxisRead.ts:33`), acquiring a **second** connection while the claim transaction still holds the first — the exact pattern `heartbeat.ts:383` documents as the cause of a pool self-deadlock under mass reconnect, where postgres-js has no acquire timeout and so hangs rather than errors. Therefore the entitlement set is resolved **before** the transaction is opened: one `getEntitlements(partnerId)` per heartbeat, served from the 60 s cache under the 5-minute staleness ceiling, with the resolved snapshot passed **into** `partitionClaimable` as data. `partitionClaimable` must never call the resolver itself; it reads the snapshot the way `requesterActive` (`commandClaimEligibility.ts:187`) reads its memo.

Denial follows the partner-axis precedent already at this point — `assertDeviceExecuteAllowed` (`services/partnerTrust.commands.ts:12`) throws `TrustDeniedError` → cancel reason `trust_denied`. A resolved `disabled` entitlement is likewise a **cancel**, reason `entitlement_revoked`; a hold would leave the row `pending` and the next heartbeat would re-claim it forever. A **failure to resolve** is the opposite and takes the existing `eligibility_check_failed` **hold** (`commandClaimEligibility.ts:216-247`): the command stays `pending`, is never delivered, and is retried next heartbeat. Fail-closed on both sides — an unresolvable check must not deliver, and must not permanently cancel. Never rethrow, or one deterministic fault aborts the claim transaction, 500s the heartbeat, and the device can never check in again. A cancel writes `status='cancelled'` + `result: { reason, cancelledBy: 'claim_eligibility' }` and erases the payload; no web surface renders those reason strings today (grep `device_moved_org` in `apps/web/src` → nothing), so W3 must add rendering or the denial is invisible. Workers that evaluate policy at execution take the same call under the same before-the-transaction rule — `jobs/softwareRemediationWorker.ts:288` is the in-repo arming-re-check precedent.

**Read API.** `GET /api/v1/partner/me/entitlements` on `routes/partner.ts` — already the canonical partner-axis read surface: `authMiddleware` only, no `requireScope`, exempt from `partnerGuard` (`index.ts:723`), already reading through `readWithPartnerAxisVisibility` for exactly the org-scoped-token reason above. Returns the full resolved set (`{ key, label, why, state, source, limits, expiresAt, graceUntil }` per key) so the web renders locked features without a second call; read-only for every scope. The alternative home, `GET /orgs/partners/me`, already carries `plan`/`maxDevices`/`aiForOfficeEnabled` via `partnerPublicColumns()` — a separate endpoint keeps that payload from growing per feature.

## 10. Web

- **Page:** `apps/web/src/pages/settings/plan.astro` — a `DashboardLayout` wrapper around a `client:load` island, exactly like `settings/partner.astro` — rendering `components/settings/PlanAndFeaturesPage.tsx`. Structural template: `PartnerServicePrincipalsPage.tsx` (partner-scoped, read-mostly, cleanest load/loading/error/retry triad). Add a card beside Billing in `pages/settings/index.astro` and a nav entry in `Sidebar.tsx`. Content: current plan, then one row per registry key — label, state badge, source badge (Plan default / Billing / Licence / Manual), expiry with grace warning, limits, and the one-line `why`.
- **No `components/ui/` exists** — no shadcn Card. Raw Tailwind: page root `space-y-6`, sections `rounded-lg border bg-card p-5`. `components/shared/{PageHeader,EmptyState}.tsx` are available.
- **Fetch:** `fetchWithAuth` in a `useCallback` + `useEffect`; no SWR or react-query in this repo. Three flags (`loading`/`loadError`/data), early returns, Retry button. W2 mutations go through `runAction`.
- **Hook:** `hooks/useEntitlement.ts`, API-shaped like `hooks/useMlFeatureFlags.ts` but with **inverted failure polarity** (D10): `useMlFeatureFlags.isDisabled` returns `loaded && enabled === false`, so a failed fetch leaves the feature enabled — a revenue leak for a paid gate. Expose `{ state: 'loading' | 'enabled' | 'locked', limits, source, reload }`; one shared fetch of the whole set. Compose with the reactive `useJwtClaims()` (`lib/authScope.ts:92`), **not** one-shot `getJwtClaims()`, which freezes the empty-store answer when captured into a `[]`-dep memo (#4010). If cached module-side, copy the **generation counter reset on logout** from `lib/usePartnerCurrency.ts:88` — a stale partner's entitlements leaking across a login is the same bug class.
- **Locked rendering:** the surface stays visible and disabled with the `why` line and an upgrade CTA. **No upsell/lock component exists anywhere in `apps/web`** — Breeze has no monetization UI today. W1 adds `components/shared/FeatureLock.tsx`, extracting the inline affordance copy-pasted across ~7 fields of `AiUsagePage.tsx:298-300` (lucide `Lock`, amber italic caption, `disabled` + `opacity-60 cursor-not-allowed`). `missing_entitlement` already exists as a remote-desktop availability reason (`components/remote/ConnectDesktopButton.tsx:84`) — unrelated to billing, but the established vocabulary.
- **Nav gate:** `NavItem` (`Sidebar.tsx:148-181`) already has `requiresAiForOffice?: boolean`, the exact partner-level flag gate a `requiresEntitlement?: EntitlementKey` field generalises. Keep its `requiresModule` fail-open-on-fetch-failure rule (D10).
- **i18n is mandatory** — `useTranslation('settings')`, and a contract test accepts only **literal** `t()` arguments, so a feature-key → label map must be spelled out literally (`PartnerModulesCard.tsx:98-102`) or marked `/* i18n-dynamic */`. `data-testid` on every state badge and the lock CTA.

## 11. Security

- The partner cannot self-grant. Writes come from exactly three places: the internal billing endpoint (bearer, off by default, IP allowlist), the boot licence loader (signed, system context), and a platform-admin route. `PATCH /partners/me` must never touch this table — the same reasoning that keeps `ai_for_office_enabled` a column rather than a `settings` JSONB key.
- **Manual grants:** mount under `adminRoutes` (`routes/admin/index.ts:15` already applies `platformAdminMiddleware` router-wide) with `requireMfa()` on each mutating verb. Body is a `z.strictObject` — strict, so a caller cannot smuggle `source` or `granted_at` — carrying `reason: z.string().trim().min(10).max(500)`, matching `admin/trust.ts:14` and `admin/abuse.ts:87`. `confirmEmail` is not warranted: this flips a flag, it does not destroy tenant data.
- **Audit** via `createAuditLogAsync` / `writeRouteAudit` (`services/auditService.ts:86,101`, `services/auditEvents.ts:134`). `action` is a free-form `varchar(100)` with no central registry, so no registration is needed; names follow the modern past-tense convention: `partner.entitlement.granted`, `.revoked`, `.limits_updated`, `.license_applied`, `.billing_synced`. `resourceType: 'partner_entitlement'`, `details: { partnerId, featureKey, from, to, source, reason }`. **`audit_logs` has no `partner_id`** and `org_id` is nullable, so a row written with `orgId: null` is invisible in the partner's own org-scoped audit view — see §15 Q4. `platformAdminMiddleware` already writes its own `platform_admin.<route>` row, so the semantic row above is deliberately a second entry.
- Licence signature is verified before any parse of its contents; a licence can only grant, never disable, so a forged-but-unverified file cannot lock a competitor's instance out.
- `limits` is `jsonb` — an open container. Never log it unredacted, and keep credential-shaped values out by construction; the per-key zod schema is the enforcement point.

## 12. Failure handling

| Failure | Behaviour |
|---|---|
| DB unreachable during resolution | Serve a cached entry up to **5 minutes** past its TTL. Beyond that it is a **failure, not a fallback**: gated routes 503 `entitlement_check_failed` with `Retry-After`, claim time takes the `eligibility_check_failed` hold. Never downgrade to the plan default — that path discards an explicit `disabled` row as readily as a grant. Log + Sentry, throttled (`utils/reportThrottle.ts`) |
| Explicit `disabled` row present | Never discarded by any fallback. A `disabled` row at the winning rank denies, and an unreadable DB may not turn it into a plan-default allow |
| Partner row unreadable (`plan` unknown) | Treat as `free` — deny anything above free |
| Key in DB, absent from code | Row ignored, warn once at boot. Happens on rollback; must not throw |
| Key in code, absent from DB | Plan default. Normal, not an error |
| Licence file absent / signature invalid | Every live `source='license'` row revoked with reason `license_missing` or `license_invalid`; error log + Sentry; boot continues, granting nothing (§8 step 3) |
| Licence expired beyond grace | Same reconciliation, reason `license_expired`; resolution falls to the next live row or the plan default, and the page shows the reason, expiry date and licensee so the operator knows what to renew |
| Billing endpoint 5xx / never called | Existing rows stand. No TTL on billing rows — downgrade happens when billing sends the diff. §15 Q3 questions that |
| Claim-time resolve fails | Hold the row (`eligibility_check_failed`) — stays `pending`, undelivered, retried next heartbeat. Never rethrow, never cancel — §9 |
| Redis pub/sub down | Invalidation degrades to the 60 s TTL. Log at warn |

## 13. Rollout waves

**W1 — mechanism.** Migration + Drizzle schema + `PARTNER_TENANT_TABLES` entry; shared registry with both seed keys; `services/entitlements.ts` with cache + Redis invalidation; `requireEntitlement`; `GET /partner/me/entitlements`; platform-admin grant/revoke with MFA + reason; audit; Plan & features page + `useEntitlement` + `FeatureLock`. Ships with **nothing actually gated** — no route calls `requireEntitlement` yet — so W1 cannot break a paying partner.

**W2 — licence + billing.** `services/ed25519.ts` extraction; `canonicalLicenseBytes` + verifier; `services/licenseLoader.ts` wired into `bootstrap()`; `apps/api/scripts/issue-license.ts` and a new signing key; the internal billing endpoint with its middleware, config vars, partnerGuard bypass and compose mapping. Coordinated with a `breeze-billing` change to call it; until then the endpoint is unconfigured and returns 503, the intended off state.

**W3 — consumers and consolidation.** Attach `requireEntitlement('onboarding_supervisor')` at the `mode: off` boundary the onboarding spec names as the gate point, and `verified_library` at the consumer spec's checkpoints; add claim-time gating (per the §9 hard rule) plus operator-visible rendering of the cancel reason. Then absorb the legacy mechanisms, each its own PR with its own backfill:

- **`ai_for_office_enabled` → an `ai_for_office` key.** `PATCH /partners/:id` still writes the legacy column today (`routes/orgs.ts:178`, `updatePartnerSchema.aiForOfficeEnabled`). That operator route is rewired to write **through the entitlements service** as a `manual`-source row (carrying the reason the admin schema already requires), and the column becomes a **read-only mirror the service maintains**, so existing readers (`services/clientAiExchange.ts`, `routes/clientAi/admin.ts:65`, `Sidebar`'s `requiresAiForOffice`) keep working unchanged. The column is dropped in a later wave once those readers move to `hasEntitlement`.
- **ML flags fold in under an absolute ceiling.** `resolveMlFeatureFlag` (`services/mlFeatureFlags.ts:123-150`) applies `orgOverride` **after** `partnerOverride` and unconditionally, so an org-settings write — reachable by any org admin through `PATCH /organizations/:id` (`routes/orgs.ts:2086`) — can flip a partner-level `false` to `true`. Folding entitlements in naively would turn that into a self-grant. The consolidated order is **global kill switch > entitlement ceiling > partner setting > org setting**: settings may only opt **out** below the entitlement, never opt in above it, and `mlFeatureGloballyDisabled` still wins outright. Implement as a clamp (`enabled = entitled && settingsResolved`), not a fourth override slot, so a future settings path cannot re-open the hole.
- **`aiCostTracker`'s remote `{allowed, plan}` check** becomes an `ai_assistant` key so the plan gate and the credit cap stop being one call.

## 14. Testing

**Unit (`Test API` / `test-web`).** Registry totality — every key has a `defaults` entry for **every** value of the pg `plan_type` enum, read from the Drizzle schema so a new plan reds the build. Precedence fold with two and three live rows; a manual override expiring **reveals** the billing row rather than dropping to the plan default; a winning `disabled` row denies and survives every fallback path. Staleness ceiling: a cached entry at 4 min serves, at 6 min the resolver fails and `requireEntitlement` returns 503 `entitlement_check_failed`. Grace boundaries at `expiresAt ±1s` and `+14d ±1s`. Cache TTL + invalidation. `requireEntitlement` 403 body shape and null-`partnerId` fail-closed. **Claim path opens no second connection:** `partitionClaimable` receives a resolved snapshot and a resolver stub that throws if invoked inside the transaction stays uninvoked; a resolve failure before the transaction yields an `eligibility_check_failed` hold with the row still `pending`, never a cancel. Licence canonical-bytes golden vectors plus tamper cases: flipped `featureKey`, extended `expiresAt`, reordered `entitlements`, injected `\n` in `licensee`, 63/65-byte signatures, wrong domain separator. Prove each mutation red **before** trusting the green.

**Integration (real Postgres), `partnerEntitlementsRls.integration.test.ts`.** Cross-partner forge as `breeze_app` fails 42501 on INSERT and UPDATE; `state`/`source`/manual-`reason` CHECKs fail 23514; unique-index conflict; an org-scoped context reads **zero rows** directly and the **correct rows** through `getEntitlements` — the #2822-class assertion, and it must exercise the service, not a bare select. Plus the internal endpoint end-to-end (503 unconfigured, 401 wrong token, unknown-key 400 with no partial apply, full-set diff revoking a billing row while leaving a manual row untouched); `cascadeDeletePartner` removing the rows with no hand-registration (the D3 proof). **Licence reconciliation:** boot with a valid licence, then boot again with the file removed, with a forged signature, and with an expired one — each must revoke every `source='license'` row with the matching `license_missing`/`license_invalid`/`license_expired` reason and let the key fall to the next live row. Concurrent billing and manual upserts for one key land as two rows, neither clobbering the other.

**Contract + web.** `rls-coverage.integration.test.ts` picks the table up once it is in `PARTNER_TENANT_TABLES`; `autoMigrate.test.ts` covers ordering. Confirm the org-cascade and export-policy suites stay green **without** an entry — that green is the assertion, and it only runs under Integration Tests, so run it locally before the PR. Web: each source badge and the grace warning render; `useEntitlement` returns `loading` (not `enabled`) on fetch failure — the D10 regression; `FeatureLock` renders the CTA and keeps the surface visible.

## 15. Open questions

1. **`plan_type` drift — blocks W1 (decision: W1 fixes `@breeze/shared` to the six-value pg enum; the registry totality test enforces it).** The pg enum is `['free','starter','community','pro','enterprise','unlimited']` (`db/schema/orgs.ts:15`), but `@breeze/shared` declares four: `PARTNER_PLANS` (`constants/index.ts:70`) and `PlanType` (`types/index.ts:16`). `starter` and `community` are live — `services/aiCostTracker.ts:322` branches on `'starter'` and its denial message names the Community plan. A registry keyed on the four-value shared type leaves two real plans with **no default**. Fix the shared constant (and sweep its consumers) or derive `PartnerPlan` from the Drizzle enum. **Recommend fixing the shared constant** — it is wrong regardless of this feature.
2. **`verified_library` limits shape.** Resolved: the consumer spec is `docs/superpowers/specs/vuln-patch/2026-09-07-verified-software-library-consumer-design.md` (§4.4 names the key; checked at subscribe, materialisation, and delivery claim). Its `limits` shape (`maxVerifiedPackages`) stays a placeholder until that spec's plan decides whether subscriptions are capped at all; the consumer spec owns the ceiling check (see Q6).
3. **Do billing rows need a TTL?** Still open, and narrowed rather than settled by the fail-closed decision in §12 — that governs a *failed* resolve, whereas this is a *successful* read of a row that has silently gone stale. Today billing rows are perpetual until billing sends a diff, so a missed webhook leaves a cancelled partner entitled indefinitely. A `billing_synced_at` + "stale after N days ⇒ drop out of the fold" rule fails closed instead, at the cost of a self-inflicted outage if billing is unreachable for N days. Per-source rows (D6) make this cheap to add later: expiring the billing row simply reveals whatever is beneath it.
4. **Partner-level audit visibility.** `audit_logs` has no `partner_id`. Accept that entitlement changes are invisible in a partner's own audit view (they are operator actions), or copy `resolveAuditOrgIdForPartner` from `routes/orgs.ts`, which stamps a representative child org? Recommend accepting; revisit if partners ask.
5. **Multi-partner self-host.** The loader grants the licence to *every* partner on the instance — right for the single-partner norm, wrong if a self-hoster runs two MSPs off one file. Optional `partnerIds` allowlist or a `maxPartners` limit? Deferred to W2 unless a real case exists.
6. **Is 5 minutes the right staleness ceiling?** It is a judgement, not a measured number: long enough to ride out a Postgres failover, short enough that a revocation cannot outlive an incident by much. Worth revisiting once there is real data on how long the DB is typically unreachable — the two failure modes it trades between are "paying partner sees a 503" and "revoked partner keeps a feature".
7. **`limits` enforcement is unowned here.** This spec validates the shape and serves the value; nothing enforces that `maxVerifiedPackages` is honoured. Each consuming feature owns its ceiling check, and that obligation should be restated in each consumer's spec.
