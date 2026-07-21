# Live Sign-up Monitoring — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorm) — pending implementation plan
**Owner:** Todd

## Problem

We have no automated, repeatable way to confirm that the **live hosted** partner sign-up
flow (`us.2breeze.app` / `eu.2breeze.app`) actually works end-to-end. Registration spans
the web form → API → DB → auto-login → verification email, and a regression in any layer
(e.g. the `IS_HOSTED` gate, the registration config flag, a broken form field, a dead email
provider) is currently only caught when a real prospect fails to sign up.

We want a synthetic monitor that periodically exercises the real sign-up flow against
production and reports pass/fail — run **on-demand** now, schedulable later.

## Goals

- Exercise the **real production** sign-up flow, not a local/staged copy.
- Cover **both layers**: a fast API smoke (`POST /auth/register-partner`) and the full
  **browser UI** flow against the live `/register-partner` page.
- Complete **email verification** by reading the real verification email back out of Resend.
- **Simulate a successful payment** (no Stripe, no sandbox) and assert the partner's real
  `pending → active` activation reconciliation fires.
- **Auto-clean** every synthetic account it creates, so production data stays clean.
- Run against **both regions** (US then EU) in one invocation, reporting per-region.
- Exit non-zero on any failure so it drops into a cron / GH Action / Slack alert later
  with no code change.

## Non-Goals (deferred)

- Scheduling (cron / GitHub Actions) and Slack/email alerting. Built later; the harness's
  exit code is the integration seam.
- Testing self-hosted registration (setup-admin gate). Hosted SaaS only.
- Load/perf testing. This is a correctness canary, not a load generator.
- **Exercising the real Stripe integration** (Checkout / SetupIntent / webhooks). That lives in
  the separate, out-of-repo `breeze-billing` service and can't be driven against live prod
  without test keys. We simulate the *result* of a payment, not Stripe itself (see the
  `simulate-payment` action under Architecture).

## Key facts established during research

- **Sign-up endpoint:** `POST /auth/register-partner` (`apps/api/src/routes/auth/register.ts:88`).
  Fields: `companyName`, `email`, `password`, `name`, `acceptTerms`. On `IS_HOSTED=true` the
  partner is created `status='pending'`; the call auto-logs-in and returns
  `{ user, partner, tokens.accessToken, verificationEmailSent }`.
- **Registration gate:** UI gates on `GET /api/v1/config` → `registration.enabled`
  (`apps/api/src/routes/config.ts`). Must be `true` on the target.
- **Verification email:** `generateVerificationToken` (`apps/api/src/services/emailVerification.ts:25`)
  issues a 48-char nanoid token (charset `A-Za-z0-9_-`), emailed as a link
  `{DASHBOARD_URL}/auth/verify-email?token=…`. Consumed via `POST /auth/verify-email`
  (`apps/api/src/routes/auth/verifyEmail.ts:25`) → `{ verified: true }`.
- **Resend** exposes `GET /emails` (list sent, limit ≤100, cursor paginated) and a retrieve-by-id
  endpoint returning HTML/text. We filter the sent log client-side by recipient — so the
  canary recipient needs **no real inbox**.
- **Register form** (`apps/web/src/components/auth/PartnerRegisterForm.tsx`) currently has
  **no `data-testid`s** — only input `id`s. The UI layer needs them added.
- **Cleanup:** there is **no** partner self-delete and **no** `cascadeDeletePartner`. The
  only cascade is `cascadeDeleteOrg(orgId, performedBy, performedByEmail?)`
  (`apps/api/src/services/tenantCascade.ts:402`), org-scoped only. Full erasure today needs a
  *platform admin*, which does not exist in production. → we add a purpose-built guarded
  endpoint that composes `cascadeDeleteOrg` + partner/user/axis cleanup.
- **Payment / activation:** Stripe lives entirely in the external `breeze-billing` service; the
  only signal our API reacts to is the `partners.payment_method_attached_at` timestamp
  (`db/schema/orgs.ts:34`) that billing writes. `shouldActivatePendingPartner()`
  (`apps/api/src/services/partnerActivation.ts:57`) returns true iff `status='pending'` **and**
  `emailVerifiedAt != null` **and** `paymentMethodAttachedAt != null`; `partnerGuard`
  (`apps/api/src/middleware/partnerGuard.ts`) self-heals the partner to `active` via
  `activatePartnerRow()` on the next authed request once both are set. → simulating a payment is
  just writing that timestamp on a canary; our real reconciliation does the rest.
- **Secret-gated route pattern** to copy: `apps/api/src/routes/metrics.ts:44` — env-var
  presence check (503 if unset in prod), `timingSafeEqual` Bearer compare, optional IP allowlist.
- **Register rate limit:** 3 attempts/hour per client IP (`register.ts:148`). Each region run
  performs 2 registrations (API + UI), under the limit. Back-to-back runs from one IP within an
  hour WILL trip it — see Known Limitations.

## Architecture

Two deliverables:

### 1. Standalone monitor harness (`e2e-tests/live-signup/`)

A self-contained TypeScript CLI, run via `npx tsx e2e-tests/live-signup/monitor.ts`,
**decoupled from the existing Playwright suite** (whose `global-setup` seeds a local Docker DB
and logs in as a seeded admin — both wrong for live prod). It uses Playwright (chromium) for the
UI layer and `fetch` for everything else.

```
monitor.ts                 # CLI entry: arg parse, per-region orchestration, reporting, exit code
  regions.ts               # region → { baseUrl, apiUrl } map (us, eu)
  phases/
    preflight.ts           # GET /health/ready + /api/v1/config (registration.enabled)
    apiSmoke.ts            # POST /auth/register-partner via fetch
    uiFlow.ts             # Playwright: drive live /register-partner, assert dashboard
    verifyEmail.ts        # Resend poll → token extract → POST /auth/verify-email
    simulatePayment.ts    # call guarded simulate-payment endpoint, then assert activation
    cleanup.ts            # call guarded purge endpoint for each created partner
  resendClient.ts          # list + retrieve sent emails, filter by recipient
  identity.ts              # synthetic identity generator
  report.ts                # per-phase / per-region PASS·FAIL + timings
```

**CLI:**
```
npx tsx e2e-tests/live-signup/monitor.ts [--region us|eu|both] [--skip-ui] [--skip-verify] [--json]
```
Default `--region both` (US then EU, sequential). Exit `0` iff every non-skipped phase passes
for every targeted region; else `1`.

**Run-scoped state:** each run generates a `runId` (timestamp + short random). All created
partner ids are tracked in-memory so cleanup runs for every account created, **even if an
earlier phase throws** (cleanup is in a `finally`).

### 2. Guarded internal synthetic-test router (`apps/api/src/routes/internal/synthetic.ts`)

One small router mounted `api.route('/internal/synthetic', internalSyntheticRoutes)` in
`apps/api/src/index.ts`, exposing **two** actions behind one shared gate + latch:

- `POST /api/v1/internal/synthetic/simulate-payment`
- `POST /api/v1/internal/synthetic/purge-partner`

**Shared gate (copy `metrics.ts`), applied to the whole router:**
1. Env `SYNTHETIC_TEST_TOKEN`. If unset in production → `503` (feature off by default).
2. `Authorization: Bearer <token>` compared with `timingSafeEqual` over SHA-256 digests.
3. Optional `SYNTHETIC_TEST_IP_ALLOWLIST` (comma-sep) → `403` if set and IP not listed.

**Shared synthetic safety latch** (helper used by both actions): given `{ partnerId }`, load the
partner + its admin user email and **refuse with `422`** unless the email matches `^signup-canary\+`
**and** ends with `@2breeze.app`. So even if the secret leaks, neither action can ever touch a
real tenant — only canary accounts.

**`simulate-payment`** — body `{ partnerId: uuid }`:
- Under `withSystemDbAccessContext`, set `partners.payment_method_attached_at = now()` and a
  synthetic `stripe_customer_id = 'cus_canary_<runId>'` on the canary partner — mirroring exactly
  what the billing webhook writes. It does **not** flip `status` itself; that's left to our real
  reconciliation path so the test actually exercises it. Idempotent.
- Emits audit event `test.synthetic_partner.payment_simulated` (actorType `system`).
- Response `{ simulated: true, partnerId }`.

**`purge-partner`** — body `{ partnerId: uuid }`:
- Under `withSystemDbAccessContext`, idempotent:
  1. For each child org of the partner → `cascadeDeleteOrg(orgId, 'synthetic-test-cleanup')`.
  2. Delete partner-axis rows (per `PARTNER_TENANT_TABLES`), `partner_users` links, the admin
     `users` row(s), `email_verification_tokens` for the partner, refresh-token families, then
     the `partners` row.
  3. Emit audit event `test.synthetic_partner.purged` (actorType `system`).
- Response `{ purged: true, partnerId, stats }`.

## Data flow (per region, per run)

```
0. preflight:  GET /health/ready              → site up
               GET /api/v1/config             → registration.enabled === true   (else abort region)
1. apiSmoke:   POST /auth/register-partner     identity A = signup-canary+<runId>-api@2breeze.app
               assert 200 + tokens.accessToken + partner.status; record partnerId_A
2. uiFlow:     Playwright → live /register-partner, fill identity B (…-ui@2breeze.app), submit
               intercept the /auth/register-partner response to capture partnerId_B
               assert authenticated dashboard landing (testid)
3. verify:     poll Resend GET /emails (≤90s, backoff) for recipient = identity B
               retrieve HTML by id → regex /verify-email\?token=([A-Za-z0-9_-]{48})/
               POST /auth/verify-email { token } → assert { verified: true }
4. payment:    POST …/synthetic/simulate-payment { partnerId_B }   (writes payment_method_attached_at)
               then GET /partner/me with identity B's access token  (triggers partnerGuard self-heal)
               assert partner.status === 'active'
5. cleanup:    POST …/synthetic/purge-partner { partnerId_A }       (finally)
               POST …/synthetic/purge-partner { partnerId_B }       (finally)
6. report:     per-phase PASS/FAIL + ms; aggregate region result
```

Identity A and B use **distinct emails** so the two registrations never collide. Email
verification and payment simulation both run against identity **B** (the "real user" UI path);
identity A is a registration-only canary whose verification email is ignored. The activation
assertion is order-sensitive: email must be verified (phase 3) *before* payment is simulated
(phase 4), since `shouldActivatePendingPartner()` needs both — phase 4 is what makes the partner
eligible, and the subsequent authed `GET /partner/me` is what triggers the real reconciliation.
Both A and B are always cleaned up.

## Web change

Add `data-testid` to `PartnerRegisterForm.tsx`:
`register-company-name`, `register-name`, `register-email`, `register-password`,
`register-confirm-password`, `register-accept-terms`, `register-submit`. Add a stable testid on
the post-signup dashboard landing element (or assert on the authenticated URL) so the UI phase has
a deterministic success signal. These are additive, low-risk, and also strengthen the existing
local Playwright auth specs.

## Configuration / secrets

Harness reads from env (via `e2e-tests/.env`, gitignored):

| Var | Purpose |
|---|---|
| `RESEND_API_KEY` | List/retrieve sent emails (read). The prod key, or a read-scoped key. |
| `SYNTHETIC_TEST_TOKEN` | Bearer for the synthetic router (both actions); **must match the API env on each region**. |
| `CANARY_EMAIL_DOMAIN` | Defaults to `2breeze.app`. |

API side (`/opt/breeze/.env` + mapped in the compose `environment:` block per region):
`SYNTHETIC_TEST_TOKEN`, optional `SYNTHETIC_TEST_IP_ALLOWLIST`. Per the deploy rules, a new
required-ish env var must be added to `.env` **and** explicitly mapped in the `api` service
`environment:` block — otherwise compose interpolation drops it.

## Error handling

- Any phase throwing fails that region but **does not** skip cleanup (cleanup in `finally`) and
  does not abort the other region.
- Preflight failure (site down / registration disabled) aborts only the affected region's
  remaining phases; cleanup still runs (no-op if nothing created).
- Resend email not arriving within the poll budget → `verify` fails with a clear "email not
  observed in Resend within 90s" message (distinguishes provider outage from token/logic bugs).
- Cleanup failure is reported loudly (it means a synthetic account leaked) but does not mask an
  earlier phase's failure in the exit code.

## Testing strategy

- **Synthetic router (security-critical) — unit tests** (`synthetic.test.ts`, Vitest + Drizzle
  mocks). Shared gate, asserted on **both** actions: 503 when env unset in prod; 401 missing/wrong
  Bearer; 403 IP not allowlisted; **422 when target email is not a `signup-canary+…@2breeze.app`
  address** (the latch — the one test that must never regress).
  - `purge-partner` happy path: calls `cascadeDeleteOrg` for each child org and deletes
    partner/user rows.
  - `simulate-payment` happy path: writes `payment_method_attached_at` on the canary and does
    **not** flip `status` (proving activation is left to the real reconciliation path); refuses a
    non-canary partner.
- **RLS/tenancy:** endpoint adds no tables; it must leave no orphaned partner-axis rows — verify
  the delete set against `PARTNER_TENANT_TABLES`. Run the RLS coverage + integration suites.
- **Harness:** validated by running on-demand against US/EU. A `--skip-ui --skip-verify` mode
  allows a fast preflight+api+cleanup smoke while iterating.

## Known limitations / future work

- **Rate limit:** 2 registrations/region/run vs a 3/hour/IP cap. Back-to-back runs from a single
  fixed IP within an hour will trip the limiter. Mitigation when we schedule: allowlist the
  monitor's egress IP on the register limiter, or run from rotating IPs (GH Actions). Documented,
  not solved now.
- **Scheduling + alerting** deferred (exit code is the seam).
- **Real Stripe path not covered.** We simulate the *result* of a payment (the
  `payment_method_attached_at` write) and assert our activation reconciliation. The actual
  Stripe Checkout/SetupIntent/webhook in `breeze-billing` is out of scope (separate repo, can't
  run against live prod without test keys). A regression purely inside `breeze-billing`'s Stripe
  wiring would not be caught by this monitor.

## Security note (for explicit sign-off)

The internal synthetic router is the only new attack surface, with **two** mutating actions
(`simulate-payment`, `purge-partner`) behind one shared gate. Both are mitigated by: off-by-default
(503 unless `SYNTHETIC_TEST_TOKEN` set) · timing-safe secret · optional IP allowlist · and a hard
synthetic-email latch so neither action can ever touch a real tenant — only `signup-canary+…@2breeze.app`
accounts. `purge-partner` reuses the audited `cascadeDeleteOrg` path; `simulate-payment` only writes
a timestamp + a fake `cus_canary_*` id and cannot move money or call Stripe. Both emit audit events.
This is in-session work (tenant-isolation sensitive), not delegated.
