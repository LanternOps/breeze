---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W6: Self-Registration by Verified Email Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer's staff member whose address is on one of the org's **verified** domains can ask for portal access from the portal's public **Request access** page. They prove the mailbox through a single-use 30-minute link. Then the org's access policy either queues them for MSP approval or lets them in to set a password (or sign in with Microsoft under `sso_only`). The public surface never reveals whether an address, an account or a domain exists.

**Architecture:**
- **Public submit, async work.** `POST /portal/auth/self-register` validates, rate-limits per IP, email and domain, then enqueues one BullMQ job carrying the address, the name and the request's normalized `Host`. It returns a constant 200. It does no DB read of its own; the only write is the `/auth/*` wrapper's anonymous audit row, which is address-independent. Eligible, ineligible, existing and unknown addresses therefore get the same work, body, status and throttling (spec §5.9 step 2, inv. 8).
- **Worker decides.** The `portal-self-registration` worker:
  1. maps the address's exact domain to the one org it is **currently verified** for, through W5's read API (`findOrgByVerifiedDomain`, which re-checks evidence at use);
  2. resolves the job's `Host` to a custom-domain org (`resolvePortalHostOrgId`) and applies the host binding;
  3. resolves the W3 policy;
  4. then emails one of two things: a purpose-bound `self_register` link, or a neutral "you already have an account". An ineligible address gets nothing.
- **The link is the mailbox proof.** It carries a W2-family capability token, `{purpose:'self_register', orgId, email, name, domain, policyFingerprint}`, in the URL **fragment** of a portal page. The token is stored hashed, lives 30 min and is consumed atomically (GETDEL) by an explicit POST from the verify page, never on page load. At consume time, the service re-checks:
  - the org is active;
  - the domain is still verified **for that org**;
  - the policy fingerprint is unchanged;
  - the mode is not `off`.

  The mode then decides the outcome. `approval` creates a `portal_access_requests` row (`source:'self'`, the W3 queue). `instant` creates an `invited` + `granted` account linked to its contact and hands the browser straight to `/accept-invite` with a fresh invite token. That page already offers a password or the invitation-bound Microsoft sign-in, depending on policy (W4).
- **Domain loss is enforced at every step.** The steps are submit → worker, worker → email, email → click, and click → MSP approval. Each re-reads W5's read API, so a domain that lapses, is removed, is displaced to another org or is deactivated stops self-registration on the next step. An approval refuses a `self` request whose domain is no longer verified for the org (`PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED`, like W4's `ENTRA_TENANT_NOT_PROVEN`). The MSP can still invite the person directly.
- **No migration, no new table, no new setting.** `self_registration_mode` (W3), `portal_access_requests.source = 'self'` and its approve path (W3), the verified-domain columns and read API (W5), and the policy fingerprint (W3/W4) all exist on main. W6 builds the producer. W06b (Task 10) flips `getPortalSignInCapabilities().selfRegistration` once the portal pages exist.

**Tech Stack:** Hono, Drizzle (queries only), Redis (`ioredis`, tokens and rate limits), BullMQ, PostgreSQL forced RLS, Astro + React (portal and web), Vitest (unit plus `vitest.integration.config.ts`), Playwright MCP for the browser check.

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`. Relevant sections:
- §3: G2, G5 and the anti-goals ("an oracle for 'is this domain a customer here' or 'does this address have a login'", "a person lands in the wrong org");
- §4: the card's self-registration row and its `off` default;
- §5.1: the transition table (`browser_access none → granted` via "an instant-mode policy");
- §5.4: the requirements table (self-registration needs a verified domain);
- **§5.9: the whole section;**
- §5.10: the queue and audit names;
- §6: invariants 1, 5, 7, 8, 9 and 10;
- §7: the W6 row;
- §10: Turnstile and the rate-limit numbers.

The wave index is `2026-11-08-portal-registration-options-index.md`.

**Builds on (all merged on `main` at `0ff7c14f6e`):**
- **W5a #11577 / W5b #11576.** `services/portalDomainVerification/index.ts` provides:
  - `findOrgByVerifiedDomain(domain): Promise<VerifiedDomainFact | null>`, `isDomainVerifiedForOrg(domain, orgId): Promise<boolean>` and `listVerifiedDomainsForOrg(orgId): Promise<VerifiedDomainFact[]>`, where `VerifiedDomainFact = { domain, orgId, partnerId, method, verifiedAt }`.
  - All three run in system scope and **throw inside a request transaction**. Call them with no DB context held, or through `runOutsideDbContext`.
  - A row counts only when `verified_at IS NOT NULL`, `is_active = true`, it has a pass within `PORTAL_DOMAIN_STALE_DAYS` (7), and its evidence is structurally current (W5 D6). Matching is exact and lowercase, with no subdomain match. At most one org per domain platform-wide (partial unique index).
  - The re-check worker clears lapsed rows: two consecutive definitive misses, a structural fail at once, or 7 days with no pass.
  - `OrgDomainsSummaryRow.tsx` on the Sign-in & registration card.
- **W4a #11557 / W4b #11568:**
  - `routes/portal/oidc.ts`: private `requestHost(c)` / `hostOrgIdFor(c)` (host binding, D5 of W4), built on `resolvePortalHostOrgId(host)` (`routes/portal/branding.ts`; a DB read of verified branding domains), and `GET /auth/methods`.
  - The invitation-bound Microsoft accept on `/accept-invite` (`AcceptInviteForm.tsx`, `peekPortalCapabilityToken` + `validatePortalCapability(..., { requirePasswordMethod: false })`).
  - `resolveInviteSignInMethods` used by `issueAndSendInvite` (`routes/orgPortalUsers.ts:155`).
- **W3a #11528 / W3b #11523:**
  - `services/portalAccessPolicy.ts`: `resolvePortalAccessPolicy(orgId)` (no cache, reads under a held context or opens a system one). Its `fingerprint` is sha256 over the effective values plus the proven tenant id, documented as "W6 binds self-registration tokens to it".
  - `getPortalSignInCapabilities()` with `selfRegistration: false` (W6 flips it), and the capability mask that forces the effective `selfRegistrationMode` to `off` while it is false.
  - `services/portalAccessRequests.ts`:
    - `createPortalAccessRequest({ source:'self', orgId, email, name })` → `created | already_pending | capped`. It takes a per-org admission lock, allows one pending row per (org, email), caps at `PORTAL_ACCESS_REQUEST_PENDING_CAP = 200`, expires rows after `PORTAL_ACCESS_REQUEST_TTL_DAYS = 14`, and joins a held context or opens a system one.
    - `approvePortalAccessRequest`: for `self` → `createInvitedAccount` (address lock, refuse an existing account, `linkLoginToContact`, `initialPortalAccountState('self_request_approved')`). The route then sends the normal invite.
    - `denyPortalAccessRequest` (the route sends `sendPortalAccessDeclined`).
  - `routes/orgPortalAccessRequests.ts` (list, approve, deny, bulk; audit `organization.portal_user.access_request.{approve,deny}`).
  - Web: `PortalAccessPolicyForm.tsx` renders the self-registration row only when `capabilities.selfRegistration`. `PortalAccessRequestsList.tsx` already labels `source: 'self'`.
- **W2:**
  - `routes/portal/capabilityTokens.ts`: hashed, atomic GETDEL consume (`luaGetDel`), in-memory fallback maps and `capMapByOldest`.
  - `services/portalAccountState.ts` (`initialPortalAccountState`, the writer census in `__tests__/portalAccountWriters.contract.test.ts`).
  - `services/contacts/portalInvite.ts` (`lockPortalInviteAddresses`, `portalLoginEmailEquals`).
  - `services/contacts/loginLink.ts` (`linkLoginToContact`, actor `{ userId: null }` allowed, as W4 instant mode uses).
- **Existing public-route patterns:**
  - `POST /auth/forgot-password` (`routes/portal/auth.ts:603`), the uniform-200 template;
  - `checkRateLimit` (`services/portal/rateLimit.ts`), `rateLimitIpKey` (`services/clientIp.ts`), `getClientIp` / `normalizeEmail` / `luaGetDel` (`routes/portal/helpers.ts`);
  - the `/auth/*` audit wrapper and `PORTAL_AUTH_AUDIT_ACTIONS` (`auth.ts:112-160`, resource type `portal_auth`);
  - `jobs/quoteSendQueue.ts`, the template for an event-driven (non-repeatable) BullMQ queue and worker.

**Rigor: high.** This is an unauthenticated public surface that creates accounts and queue rows, and its rule is "never reveal existence". It consumes the domain proof, which is W5's security boundary. Full TDD, one independent review round per PR, contract and integration suites before each PR. The advisor quorum (`codex exec`, xhigh, read-only) reviews D1–D12 before the W06a PR opens.

## PR split

| PR | Tasks | Branch | Body | Depends on |
|---|---|---|---|---|
| **W06a: API** | 1–7 | `feature/11377-portal-registration/wave-11383` | `Part of #11383` (never `Closes`) | W5a + W5b merged (they are) |
| **W06b: Portal + web + docs** | 8–10 | `feature/11377-portal-registration/wave-11383-b` | `Closes #11383` | W06a **merged to main**. Branch from fresh main; do not stack, because a stacked PR runs no CI. |

**W06a ships dark.** `getPortalSignInCapabilities().selfRegistration` stays `false` in W06a, so:
- the effective mode is `off` for every org, the card hides the row, and a policy write that turns it on is refused (W3 `METHOD_UNAVAILABLE`);
- both public endpoints return 404 and `requestAccess` is `false`;
- W06a's tests turn the capability on with `portalAccessPolicy.__testOnly.setCapabilities`.

The verify email links to a portal page that only W06b creates. That is why the capability flip is the last step of W06b (Task 10), not part of W06a. Nothing user-visible changes on the W06a deploy.

## Decisions taken in this plan (flag in each PR body)

- **D1: No migration, no new table, no new setting.**
  - Every row W6 writes goes into an existing table: `portal_access_requests` (`source 'self'`, CHECK and claims shape already allow it), `portal_users` and `contacts`.
  - Tokens, rate-limit counters and queue jobs live in Redis.
  - The four org-cascade registrations are therefore untouched.
  - If review forces a column (for example a stored `domain` on requests), it gets slot `apps/api/migrations/2027-01-22-2338xx-<slug>.sql`. The `xx` is assigned at enqueue and must sort after `2027-01-22-233700-portal-domain-verification.sql`. Add the export-policy classification in the same PR (`docs/agents/tenancy-rls.md`; `jsonb` → `excludedOpen`). That is a plan change; re-run the quorum.
- **D2: Capability.** The deployment can run self-registration when `isPortalSelfRegistrationEnabled()` holds:
  - Env `PORTAL_SELF_REGISTRATION_ENABLED`, default **on**. Unset, `true` or `1` → on; `false` or `0` → off; any other value fails boot in `config/validate.ts`. The variable is a deployment kill switch for abuse emergencies, not a setting.
  - **And** an email service is configured (`getEmailService() !== null`). Mailbox proof is impossible without one.
  - Both legs live in one predicate, `isPortalSelfRegistrationAvailable()` (`config/portalSelfRegistration.ts`). From Task 10 on, the capability is exactly that predicate, and every 404 below reads the capability, never the env directly.
  - When the capability is false:
    - every org's effective mode is masked to `off` (W3 already does this);
    - the card hides the row (W3b already does this);
    - `requestAccess` is `false` on every host;
    - both public endpoints return 404. That is a deployment fact, identical for every address.
  - Template: `config/portalEntra.ts`. If importing `services/email` into `config/` creates an import cycle, inject the email check from `portalAccessPolicy.ts` instead; the predicate's name and meaning stay.
  - The W3 write refusal copy ("Self-registration is not available on this server yet.") stays as is. The card cannot tell a kill switch from a missing email service, and does not need to.
- **D3: The submit route does no DB read and no verification work** (inv. 8, spec §5.9 step 2).
  - Order: zod validation (400 for malformed input, identical for all valid-looking addresses), capability (404), three rate limits, enqueue `{ email, name, host: requestHost(c) }`, then the constant 200 `{ success: true, message: 'If this address can request access, we\'ve emailed you.' }`.
  - **No branch depends on the address beyond its syntax.** The host-to-org lookup is deliberately done in the worker (D6), so the handler's own code touches neither `db` nor the domain read API. The `/auth/*` audit wrapper still writes its anonymous row after the handler; that write is the same for every address.
  - Enqueue failure (Redis down) is logged with no PII, and the same 200 is returned, matching forgot-password's "state backend went away" leg.
  - With `PORTAL_USE_REDIS` and no Redis client at all, the route returns 503 before the rate limits, the same as forgot-password. That is identical for every address.
- **D4: Rate limits** (spec §10 leaves the numbers to the builder; OD3). All go through `checkRateLimit`, are applied **before** anything address-specific, and give the same 429 body + `Retry-After` for every address:
  - per IP: `portal:selfreg:ip:<rateLimitIpKey>`, 5 / 15 min, block 30 min;
  - per email: `portal:selfreg:email:<sha256 hex of the normalized email>`, 3 / 24 h, block 24 h (hashed, so addresses do not sit in Redis keys);
  - per domain: `portal:selfreg:domain:<lowercased domain>`, 50 / 24 h, block 24 h;
  - verify: `portal:selfreg-verify:ip:<rateLimitIpKey>`, 10 / 15 min, block 30 min.
  - The per-domain limit is the spec's "per-domain-per-day". It caps how many verification emails one domain can be sent per day. Its known cost: someone can spend a domain's daily budget with addresses at that domain and block that domain's real requesters for a day. That is the trade for not revealing eligibility (OD2 is the mitigation path).
- **D5: Eligibility is W5's read API and nothing else.** The worker:
  - normalizes the address (`trim().toLowerCase()`; domain = the text after the last `@`);
  - calls `findOrgByVerifiedDomain(domain)` exactly once.
  - It never queries `customer_email_domains` directly and never adds a stricter local rule. A row in W5's one-miss grace (`check_failures = 1`) still counts, because W5 D10 decided a single DNS blip never revokes, and a second definition of "verified" would drift. Declared (unverified) rows never count (spec §5.4 "mail routing only").
  - An address on a subdomain of a verified domain does not match (W5 exact matching).
- **D6: Host binding** (spec §5.9 "On an org's verified custom domain…", inv. 1).
  - The submit route puts the normalized `requestHost(c)` (port stripped, lowercased, null for a non-DNS name) in the job. The worker resolves it with `resolvePortalHostOrgId(host)`. A non-null `hostOrgId` with `fact.orgId !== hostOrgId` is ineligible; a null `hostOrgId` (shared host, or a host that is not a verified portal domain) applies no binding.
  - `requestHost` / `hostOrgIdFor` move from `oidc.ts` to `routes/portal/requestHost.ts`, and both route files import them.
  - The verify step does not re-bind the host. The org was fixed by the worker and is re-checked at consume through the domain (D8). The link is built with `buildPortalUrl`, like every portal email link.
- **D7: The worker's outcomes** (spec §5.9 steps 3–5). For a matched, host-bound org whose org is active (`getActiveOrgTenant`) and whose effective `selfRegistrationMode !== 'off'`:
  - **any** `portal_users` row in that org at the address (any status, any `browser_access`) → `sendPortalSelfRegistrationExistingAccount`. Self-registration never touches an existing account (spec §5.9 step 5). An add-in user who wants browser access is the W4 §5.6 step-5 path, through Microsoft sign-in. Forgot-password does not work for an add-in-only account (it requires browser access), so the email copy covers both: "Sign in with your password or with Microsoft. If you can't sign in, contact your IT provider." State this limitation in the W06a PR.
  - otherwise → issue the `self_register` token and send `sendPortalSelfRegistrationLink`.
  - Not matched, host mismatch, inactive org, or mode `off` → nothing is sent and nothing is audited against an org. A debug log carries the reason and the domain only, never the address.
- **D8: The `self_register` token** (spec §5.9 step 4, inv. 7). It is a second payload family in `routes/portal/capabilityTokens.ts`, kept beside invite/reset so that one module owns every portal capability token:
  - **Payload:** `{ v: 2, purpose: 'self_register', orgId, email, name, domain, policyFingerprint }`. It has no `portalUserId` / `authEpoch` because no account exists yet. `policyFingerprint` is the spec's "issued policy version": the W3 fingerprint covers the effective values and the proven tenant.
  - **Storage:** `PORTAL_REDIS_KEYS.selfRegisterToken(sha256)` = `portal:self-register:<hash>`, TTL 1800 s (30 min). The in-memory fallback map `portalSelfRegisterTokens` is capped by `PORTAL_SELF_REGISTER_TOKEN_CAP` (10 000).
  - **Consume:** the shared `luaGetDel`, so exactly one consumer wins.
  - **Re-validation at consume** lives in the service (Task 4), not the token module. Every leg must hold:
    - the org is active;
    - `isDomainVerifiedForOrg(domain, orgId)`;
    - `resolvePortalAccessPolicy(orgId).fingerprint === policyFingerprint`;
    - the effective mode is not `off`. This check is defensive: turning the mode off also changes the fingerprint, so in practice that case is refused as `policy_changed`. Tests assert only the generic refusal.
  - Any failure gives the same 400 `{ error: 'This link is invalid or has expired. Request access again.' }` that an unknown token gets.
- **D9: Consume only on an explicit POST.** The email links to the **portal page** `/request-access/verify#token=…` (a GET of a static page, never an API URL). It renders a confirmation page with a **Confirm my request** button. Only the button posts the token to the API.
  - Mail security scanners prefetch GET links. Consuming on page load would burn the link before the person clicks it, and in `instant` mode would create the account on the scanner's visit.
  - The token rides in the URL **fragment**, as `/trust/access/` does. Browsers never send a fragment to the server, so it is not in access logs, referrers or a scanner's request. The page reads it into memory and removes it from the address bar (`history.replaceState`).
  - `apps/portal/src/middleware.ts` overwrites page-level `Referrer-Policy` with its base headers. So `/request-access/verify` joins the token-page branch there (`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow, noarchive`).
- **D10: The two outcomes at consume.** Every leg runs in system scope (public route, no context held):
  - **Existing account first.** Any `portal_users` row in the org at the address (`portalLoginEmailEquals`) → `{ outcome: 'existing_account' }`, and the page says "You already have an account. Sign in or reset your password." An invite may have raced the email. The person has proven the mailbox, so telling them is not an oracle.
  - **`approval`** → `createPortalAccessRequest({ source: 'self', orgId, email, name })`:
    - `created` or `already_pending` → `{ outcome: 'request_sent' }`;
    - `capped` → `{ outcome: 'request_unavailable' }`, and the page says "We couldn't record your request right now. Contact your IT provider."
  - **`instant`** → `createSelfRegisteredAccount` runs in one system transaction:
    - `lockPortalInviteAddresses`, then refuse an existing account (→ `existing_account`);
    - `linkLoginToContact(…, actor { userId: null }, roles ['portal'])`;
    - insert `portal_users` with `authMethod 'password'`, `passwordHash null`, `initialPortalAccountState('self_registration_instant')` (= `invited` + `granted`) and `invitedAt now`. `invitedBy` is null because there is no inviting staff user.
    - After commit: `issuePortalCapabilityToken({ purpose: 'invite', … })` → `{ outcome: 'account_created', next: '/accept-invite?token=<raw>' }` (the existing accept-invite page reads the query string).
    - The person proved the mailbox seconds ago, so a second email adds nothing. `/accept-invite` then applies the policy itself: password, or the invitation-bound Microsoft sign-in under `sso_only` (spec §5.9 "SSO via invitation-bound link if `sso_only`").
    - The route pre-checks the token store before consuming, as forgot-password does. If the token is still not minted, the account stays `invited` and visible in the MSP's portal-users list (Resend works). The response is 503 "Try again in a few minutes". A repeat request then gets the existing-account email, and the MSP's Resend is the recovery. This residual is documented in the PR.
  - **New account-state writer** `self_registration_instant`. It is an alias of `self_request_approved` (`invited` + `granted`), the §5.1 "instant-mode policy" grant, and it is added to the writer census.
- **D11: Domain loss mid-flow** (feature RF2 in the index; Review Focus 3 below; spec inv. 3):

  | Moment | Check | Effect |
  |---|---|---|
  | Submit → worker | `findOrgByVerifiedDomain` in the worker | Ineligible: nothing sent |
  | Worker → click (≤ 30 min) | `isDomainVerifiedForOrg(domain, token.orgId)` at consume | Generic invalid-link 400 |
  | A domain displaced to another org, or a row repointed | The same consume check: the org no longer matches | Generic 400; nobody lands in the old org |
  | Request pending → MSP approves (≤ 14 d) | The route pre-checks `isDomainVerifiedForOrg` outside the request transaction and passes `selfDomainVerified` into `approvePortalAccessRequest` | 409 `PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED`: "This person's email domain is no longer verified for this organization. Invite them directly if they should have access." The request stays pending until it expires or is denied |
  | Policy changes (mode off, instant ↔ approval, partner default, proven tenant) between email and click | Fingerprint mismatch at consume | Generic 400 |

  - The approval check runs **outside** the transaction because the W5 read API throws inside one. The window between the pre-check and the approve commit is milliseconds, and an approval is an MSP action equivalent to an invite (D12).
  - The request list gains `domainVerified: boolean | null` (null for non-`self` sources) so the UI can disable **Approve** with the reason.
- **D12: Audit** (spec §5.10, resource types already labelled in all 8 web locales: `portal_auth` "Portal sign-in", `portal_access_request`, `portal_user`):
  - `portal.auth.self_register.request`: added to `PORTAL_AUTH_AUDIT_ACTIONS`, so the `/auth/*` wrapper writes one anonymous row per submit, whatever the outcome (no org, `details: { httpStatus }`). It is uniform by construction.
  - `portal.auth.self_register.email_sent`: worker, org-scoped, actor anonymous, `actorEmail` the address, resource `portal_auth`, `details: { kind: 'verify_link' | 'existing_account', domain, mode }`. MSPs see who tried to register. Ineligible submits leave no org row.
  - `portal.auth.self_register.verify`: verify handler, `writeAuditEvent`:
    - org-scoped when a token resolved, `details: { outcome, mode, reason? }`, with resource `portal_access_request` (request id) or `portal_user` (account id);
    - an unknown token writes an anonymous `denied` row with no org.
  - The approve and deny audits are unchanged (W3).
  - All rows go through `writeAuditEvent` / `writeAuditEventAsync` (they mark the request tracked). **No direct `audit_logs` insert.** If an implementer adds one, it calls `markRequestAuditWritten()` right after (`auditDirectInsertTracking.test.ts`).
  - No new resource type. If one is added, label it in all 8 web locales (`audit.resourceTypes.*` in `admin.json`; `auditResourceTypeLabels.test.ts`).
- **Emails.** Neither email contains attacker-supplied text. The submitted **name is never put in an email**. A person can type anyone's address, so the email goes to that mailbox carrying only fixed copy, the org name and the link. Two new mail purposes on the partner lane, the same lane as `portal.password_reset`:
  - `portal.self_registration.verify`: "Confirm your request for access to {orgName}'s portal". The link and a "If you didn't ask for this, ignore this email" line.
  - `portal.self_registration.existing_account`: "You already have an account for {orgName}'s portal". Links to sign in and forgot-password.
  - Sender: the org's partner, read by the worker from the matched org (never request input).

## Open decisions (Todd)

- **OD1: Instant mode hands the browser straight to `/accept-invite`** (D10). Plan default: no second email, because the mailbox was just proven. Alternative: also email the invite (as MSP approval does), at the cost of one more email and a slower first sign-in.
- **OD2: Turnstile** (spec §10: builder's call). Plan default: **not in W6**. There is no Turnstile integration in the repo (no site key env, no verify client). Abuse is bounded by:
  - D4's limits;
  - the email-only effect of a submit;
  - queue rows that exist only after mailbox proof;
  - the 200-per-org pending cap.

  Follow-up issue if the per-domain DoS in D4 is seen in practice. Alternative: add Turnstile in W06a/W06b (new env, portal widget, server verify).
- **OD3: Rate-limit numbers** (D4): 5/15 min per IP, 3/day per email, 50/day per domain, 10/15 min verify.
- **OD4: The capability default** (D2). Plan default: on, with `PORTAL_SELF_REGISTRATION_ENABLED=false` as the kill switch. The per-org policy defaults to `off`, so nothing is exposed until an MSP opts in. Alternative: off by default (self-hosters opt in).
- **OD5: Approving a `self` request whose domain is no longer verified is refused** (D11). Alternative: allow it with a warning (an approval equals an invite). The refusal mirrors W4's tenant rule and feature RF2 in the index ("nobody lands in the old org").
- **OD6: The card warns but does not refuse** when `selfRegistrationMode` is on and the org has no verified domain (Task 5). W4 refuses `entraEnabled` without a proven tenant. Here a domain can lapse after save anyway, and enforcement is at use. Alternative: refuse an org override that turns self-registration on with zero verified domains (`PORTAL_ACCESS_POLICY_DOMAIN_NOT_VERIFIED`).

## Settings rule 9 statement (copy into both PR bodies)

- **Concept:** whether, and how, a customer org's staff may self-register (`self_registration_mode`: `off | approval | instant`).
- **Home:** org settings › Portal › **Sign-in & registration** (org override) and partner settings › Customer portal (partner default). Both are W3 surfaces; W6 makes the row visible by flipping the capability.
- **Level:** partner default → org override, field by field (W3).
- **Resolver:** `resolvePortalAccessPolicy(orgId).effective.selfRegistrationMode`. Use also requires a verified domain (W5 read API), which is not a setting.
- **Places configured:** before 2, after 2. No new setting. `PORTAL_SELF_REGISTRATION_ENABLED` is deployment configuration (env), not a setting.
- **Nav:** no new settings page, so `settingsPageRegistry.test.ts` passes unchanged.

## Global Constraints

- **Uniformity** (inv. 8): for eligible, ineligible, existing and unknown addresses, `POST /auth/self-register` returns the same status, body and headers, does the same work (no DB read), and applies the same rate limits. Only syntax (400), the deployment capability (404), throttling (429, applied identically) and a missing Redis client (503, identical for every address) can change the response.
- **Proof** (inv. 1, 2): an org comes only from `findOrgByVerifiedDomain` on the address's exact domain, then the host binding. Nothing from the request body names an org: no `orgId` field is accepted.
- **Never link by email** (inv. 5): self-registration never modifies an existing account and never attaches an identity.
- **Tokens** (inv. 7): `self_register` is purpose-bound (purpose, org, email, policy fingerprint), lives 30 min, is consumed atomically by POST, and re-checks domain and policy at consume.
- **State machine** (inv. 10): the only new `status` / `browser_access` writer is `initialPortalAccountState('self_registration_instant')`, added to `portalAccountWriters.contract.test.ts`.
- **Context:**
  - Public routes and the worker hold no request context. W5 read API calls run with none held.
  - The approval pre-check uses `runOutsideDbContext`.
  - A route that catches a `PortalAccessRequestError` around a query keeps the query inside the service's own `withDbTransaction`, with the catch outside it (W3 shape).
  - Never `Promise.all` siblings that open transactions.
- **Copy (exact):**
  - submit 200: `If this address can request access, we've emailed you.`;
  - invalid link 400: `This link is invalid or has expired. Request access again.`;
  - 429: `Too many requests. Please try again later.`
- **PII:**
  - Logs carry the domain and org id, never the address or name.
  - BullMQ jobs use `removeOnComplete: true` and `removeOnFail: { age: 86400 }`, so addresses do not linger in Redis.
  - Test addresses use `example.com` / `*.example.com` / `.test` only (`scripts/security/check-customer-pii.sh`).
- **No infrastructure details** in code, docs or PR bodies. Docs use `<your-breeze-domain>`.
- **Web:** mutations through `runAction`; new locale keys in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`); dynamic keys via a static `Record` + `/* i18n-dynamic */`; tests select by `data-testid`. The portal app has no i18n (English copy, like the W4 portal changes).
- **CPU budget** (host shared with other sessions):
  - Vitest with `--pool=forks --poolOptions.forks.maxForks=4` on touched files. Use `--changed origin/main` for the sweep.
  - One `tsc` at a time with `NODE_OPTIONS=--max-old-space-size=20480`. Check `echo "exit=$?"`, never `| tail`.
  - No background CI pollers.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Numbering: "Review Focus n" (RFn in test comments) is this list. "Feature RFn" is the index's feature-wide list.

1. **The response is an oracle** (spec anti-goal, inv. 8). Expected:
   - An address on a verified domain with self-registration on, one in an org with it off, one with an existing account, one on an unknown domain and one on a declared-only domain all get byte-identical 200s with identical headers.
   - Each passes through the same three rate-limit calls and one `enqueue`. The route touches neither `db` nor the domain read API.
   - The 6th submit from one IP is the same 429 for every class.

   *(Task 6: `submit responses are identical for eligible, ineligible, existing, unknown and declared-only addresses`, `the submit handler performs no DB read and no domain lookup`, `throttling is identical for eligible and ineligible addresses`.)*
2. **An email that exists in two orgs** (feature RF1, owned by W2 and W6). `pat@contoso.example.com` has a login in org B (another customer of the same or another partner), and `contoso.example.com` is verified for org A. Expected:
   - The worker sends org A's verify link, not the existing-account email. Org B's row is irrelevant.
   - Consuming the link creates org A's request or account only.
   - No response or email mentions org B.

   *(Task 3: `an account at the same address in another org does not count as existing`. Task 7 integration: `two orgs, one address: only the verified org gets a request`.)*
3. **The domain changes state mid-flow** (feature RF2, D11). Expected:
   - Verification cleared between submit and worker → no email.
   - Cleared, displaced or repointed between email and click → generic 400, no row written.
   - Cleared while the request is pending → approval 409 `PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED`, and the list shows `domainVerified: false`.
   - The row toggled `is_active = false` → the same as cleared (W5 OD5).

   *(Task 3: `a domain cleared before the job runs sends nothing`. Task 4: `consume refuses when the domain was cleared after issue`, `consume refuses when the domain moved to another org`. Task 5: `approve refuses a self request whose domain is no longer verified`. Task 7 integration: `displacement between email and click lands nobody in the old org`.)*
4. **Link scanners and double clicks** (D9, inv. 7). Expected:
   - Rendering `/request-access/verify#token=…` consumes nothing (and the token never reaches the server on that GET).
   - Two concurrent POSTs of one token produce exactly one request or account. The second gets the generic 400.
   - A token reused after success gets the generic 400.

   *(Task 1: `concurrent consumes of one self_register token: exactly one wins`. Task 8: `the verify page does not post on load`.)*
5. **The policy moves between email and click** (feature RF4). Expected: mode set to `off`, `approval` ↔ `instant`, a partner-default change that changes the org's effective values, or the proven tenant changing → generic 400 at consume. An unrelated org's change does nothing. *(Task 4: `consume refuses after a policy change (fingerprint)`, `consume succeeds when an unrelated org's policy changes`.)*

Invariants re-run as named tests:
- **1:** Task 3 `a custom-domain host for org X never yields org Y's link`.
- **5:** Task 4 `instant mode never modifies an existing account at the address`.
- **7:** Review Focus 4 and 5.
- **8:** Review Focus 1.
- **9:** Task 7 `an instant-mode account holds no browser session before it accepts the invite`.
- **10:** Task 1 `self_registration_instant is in the writer census and yields invited + granted`.

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| Create `apps/api/src/config/portalSelfRegistration.ts` (+ test); modify `config/validate.ts`, `.env.example` | Env kill switch + email leg (D2) | a |
| Modify `services/portalAccessPolicy.ts` (+ test) and capability-dependent tests | `selfRegistration` capability flip | **b** (Task 10) |
| Modify `routes/portal/capabilityTokens.ts` (+ test), `routes/portal/helpers.ts`, `routes/portal/schemas.ts` | `self_register` token family, Redis key, TTL, cap, rate-limit constants, request schemas (D4, D8) | a |
| Modify `services/portalAccountState.ts` (+ test), `__tests__/portalAccountWriters.contract.test.ts` | `self_registration_instant` writer (D10) | a |
| Create `services/portalSelfRegistration/{types,eligibility,complete,queue,worker,index}.ts` (+ tests) | Eligibility (D5–D7), consume outcomes (D8, D10), queue + worker | a |
| Modify `services/email.ts` (+ golden test), `services/emailDomains/mailPurposes.ts` (+ test) | Two emails, two mail purposes | a |
| Modify `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, `workerEntrypointClosure.contract.test.ts`, `workerRegistry.test.ts` | Worker registration | a |
| Create `routes/portal/requestHost.ts`; modify `routes/portal/oidc.ts` (import it), `routes/portal/auth.ts` (`PORTAL_AUTH_AUDIT_ACTIONS`); create `routes/portal/selfRegistration.ts` (+ test); modify `routes/portal/index.ts` | Public routes, host binding, discovery (`/auth/methods.requestAccess`) | a |
| Modify `services/portalAccessRequests.ts` (+ test), `routes/orgPortalAccessRequests.ts` (+ test), `services/portalAccessPolicyWrites.ts` (+ test); modify `packages/shared/src/validators/portalAccessPolicy.ts`; `PortalAccessRequestListItem` lives in `services/portalAccessRequests.ts` | Approval domain check, `domainVerified`, `verifiedDomainCount` (D11, OD6) | a |
| Create `__tests__/integration/portalSelfRegistration.integration.test.ts` | Real-DB proofs (matched by the `portal[!a-z0-9]*` glob) | a |
| Create `apps/portal/src/pages/request-access/index.astro`, `request-access/verify.astro`, `components/portal/{RequestAccessForm,VerifyAccessRequest}.tsx` (+ tests); modify `LoginForm.tsx` (+ test), `lib/oidc.ts` (`SignInMethods`), `middleware.ts` (+ test), `lib/disabledPageCoverage.test.ts`, `lib/protectedPaths.test.ts` | Portal pages | b |
| Modify `apps/web/src/components/settings/portalAccess/{PortalAccessPolicyForm,PortalAccessRequestsList}.tsx` (+ tests), `types.ts`; locale keys | Card warning, queue domain badge | b |
| Create `apps/docs/src/content/docs/features/portal-self-registration.mdx`; modify `features/portal.mdx`, `portal-domain-verification.mdx`, `astro.config.mjs` sidebar; regenerate `apps/api/src/data/docsIndex.json` | Docs | b |

---

## W06a — API

Test commands:
- Unit: from `apps/api`, `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. Never `pnpm --filter <pkg> test -- --run <path>`.
- Integration: `pnpm test-stack up`, then `npx vitest run -c vitest.integration.config.ts <file>`. Tear down with `pnpm test-stack down` and say so.

### Task 1: Availability predicate, token family, account-state writer

**Files:**
- Create: `apps/api/src/config/portalSelfRegistration.ts`, `config/portalSelfRegistration.test.ts`. Modify `config/validate.ts`, `.env.example` (`PORTAL_SELF_REGISTRATION_ENABLED=true`, with one comment line: "Set to false to turn customer-portal self-registration off for every org").
- Modify: `routes/portal/schemas.ts`:
  - `PORTAL_REDIS_KEYS.selfRegisterToken`;
  - `SELF_REGISTER_TTL_SECONDS = 1800` / `_MS`;
  - `PORTAL_SELF_REGISTER_TOKEN_CAP = 10_000`;
  - `SELF_REGISTER_IP_RATE_LIMIT`, `SELF_REGISTER_EMAIL_RATE_LIMIT`, `SELF_REGISTER_DOMAIN_RATE_LIMIT` and `SELF_REGISTER_VERIFY_RATE_LIMIT` (D4 values);
  - `selfRegisterSchema`: `{ email, name }`, strict (no `orgId`). `email` uses the same validator as `forgotPasswordSchema`, ≤ 254. `name` is trimmed, 1–120 chars, and refuses control characters.
  - `selfRegisterVerifySchema`: `{ token: string 1–512 }`, strict.
- Modify: `routes/portal/helpers.ts`. Add `portalSelfRegisterTokens` (`Map<string, PortalTokenEntry>`) and include it in `sweepPortalState`.
- Modify: `routes/portal/capabilityTokens.ts` (+ test).
- Modify: `services/portalAccountState.ts` (+ test) and `__tests__/portalAccountWriters.contract.test.ts`.

**Interfaces — Produces:**

```ts
// config/portalSelfRegistration.ts
export function isPortalSelfRegistrationEnabled(): boolean;     // env only: unset|'true'|'1' → true; 'false'|'0' → false (validate.ts refuses anything else at boot)
export function isPortalSelfRegistrationAvailable(): boolean;   // isPortalSelfRegistrationEnabled() && an email service is configured (D2)
// routes/portal/capabilityTokens.ts
export interface PortalSelfRegistrationPayload {
  v: 2; purpose: 'self_register';
  orgId: string; email: string /* normalized */; name: string; domain: string /* lowercase */;
  policyFingerprint: string;
}
export async function issuePortalSelfRegistrationToken(p: Omit<PortalSelfRegistrationPayload, 'v' | 'purpose'>): Promise<string | null>; // null = store unavailable
export async function consumePortalSelfRegistrationToken(rawToken: string): Promise<PortalSelfRegistrationPayload | null>;     // atomic; null = unknown/expired/malformed
// services/portalAccountState.ts
initialPortalAccountState(writer: … | 'self_registration_instant') // → { status: 'invited', browserAccess: 'granted' }
```

- [ ] **Step 1: Write the failing tests**

```ts
// config/portalSelfRegistration.test.ts
it('unset, true and 1 enable; false and 0 disable; any other value fails validation');
it('isPortalSelfRegistrationAvailable is false without an email service even when enabled');
// capabilityTokens.test.ts
it('issues a self_register token stored only by sha256 under portal:self-register:<hash> with a 1800 s TTL');
it('consume returns the payload once; a second consume returns null');
it('concurrent consumes of one self_register token: exactly one wins');                          // RF4
it('a self_register token is never accepted by the invite or reset consumers, and vice versa');  // purpose binding
it('rejects a stored payload with a wrong purpose, version or shape (logged, never the token)');
it('the in-memory fallback map is capped and swept');
// portalAccountState.test.ts + portalAccountWriters.contract.test.ts
it('self_registration_instant is in the writer census and yields invited + granted');            // inv. 10
// routes/portal/schemas.test.ts (create if absent)
it('selfRegisterSchema refuses orgId, control characters in name, and names over 120 chars');
```

- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement.** Reuse `luaGetDel`, `capMapByOldest` and the parse/reject helpers. The family shares the parser shape, but `parseCapability` keeps its two-purpose union. Add a sibling `parseSelfRegistration`.
- [ ] **Step 4: Run** `config/portalSelfRegistration.test.ts`, `routes/portal/capabilityTokens.test.ts`, `services/portalAccountState.test.ts`, `__tests__/portalAccountWriters.contract.test.ts` and `routes/portal/schemas.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): self-registration availability predicate, token family and account-state writer (W6)`

### Task 2: Emails and mail purposes

**Files:**
- Modify: `services/email.ts`, adding `sendPortalSelfRegistrationLink` and `sendPortalSelfRegistrationExistingAccount`. Template: `sendPasswordReset` with `purpose: 'portal.password_reset'` (partner lane, `partnerId` / `partnerName`).
- Modify: `services/emailDomains/mailPurposes.ts` (+ test). Register `'portal.self_registration.verify'` and `'portal.self_registration.existing_account'` as `{ lane: 'partner', stream: 'support', fallbackFrom: 'partner_display_name' }`.
- Test: `services/email.portalSelfRegistration.test.ts`; `email.golden.test.ts` goldens if it enumerates purposes.

**Interfaces — Produces:**

```ts
sendPortalSelfRegistrationLink(p: { to: string; verifyUrl: string; orgName: string; partnerId: string | null; partnerName: string | null }): Promise<void>;
sendPortalSelfRegistrationExistingAccount(p: { to: string; loginUrl: string; forgotPasswordUrl: string; orgName: string; partnerId: string | null; partnerName: string | null }): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('the verify email carries the link, the org name and the ignore line, and no requester-supplied text');
it('the existing-account email links to sign in and forgot password');
it('both use the partner lane with the org partner as sender');
it('mail purposes register both self_registration purposes on the partner/support lane');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.** Copy: subject `Confirm your request for access to {orgName}'s portal`, body "Someone, hopefully you, asked for access to {orgName}'s customer portal with this address. Confirm within 30 minutes: [Confirm my request]. If you didn't ask for this, ignore this email." Existing-account subject: `You already have an account for {orgName}'s portal`.
- [ ] **Step 4: Run** the files → PASS.
- [ ] **Step 5: Commit**: `feat(portal): self-registration emails and mail purposes (W6)`

### Task 3: Eligibility and the worker

**Files:**
- Create: `services/portalSelfRegistration/types.ts`, `eligibility.ts` (+ `eligibility.test.ts`), `queue.ts`, `worker.ts` (+ `worker.test.ts`, template `jobs/quoteSendQueue.ts` and its test), `index.ts`.
- Modify: `services/workerRegistry.ts`, adding `{ name: 'portalSelfRegistrationWorker', placement: 'global', load }` where `load` imports `./portalSelfRegistration/worker` and returns `{ init: initializePortalSelfRegistrationWorker, shutdown: shutdownPortalSelfRegistrationWorker }` (the `quoteSendWorker` entry shape). Also modify `jobs/workerReadinessManifest.ts` (`consumers('portalSelfRegistrationWorker')`) and insert the name **in registry order** in the order-sensitive lists in `workerEntrypointClosure.contract.test.ts` and `workerRegistry.test.ts`.

**Interfaces:**
- Consumes: `findOrgByVerifiedDomain` (W5), `resolvePortalHostOrgId` (`routes/portal/branding.ts`), `resolvePortalAccessPolicy` (W3), `getActiveOrgTenant`, `issuePortalSelfRegistrationToken` (T1), the T2 emails, `buildPortalUrl`, `writeAuditEvent`.
- Produces:

```ts
// types.ts
export const PORTAL_SELF_REGISTRATION_QUEUE = 'portal-self-registration';
export interface PortalSelfRegistrationJobData { email: string; name: string; host: string | null }   // host = requestHost(c) at submit
export type SelfRegistrationTarget =
  | { kind: 'ineligible'; reason: 'no_verified_domain' | 'host_mismatch' | 'org_inactive' | 'mode_off' }
  | { kind: 'existing_account'; orgId: string; partnerId: string; orgName: string; domain: string; mode: 'approval' | 'instant' }
  | { kind: 'eligible'; orgId: string; partnerId: string; orgName: string; domain: string; mode: 'approval' | 'instant'; policyFingerprint: string };
// eligibility.ts — no DB context held; opens system contexts itself
export function emailDomainOf(email: string): string | null;     // lowercase text after the last '@'; null if empty
export async function resolveSelfRegistrationTarget(input: { email: string; host: string | null }): Promise<SelfRegistrationTarget>;
// queue.ts
export async function enqueuePortalSelfRegistration(data: PortalSelfRegistrationJobData): Promise<boolean>; // false = not enqueued (logged, no PII)
// worker.ts
export async function processPortalSelfRegistration(data: PortalSelfRegistrationJobData): Promise<'link_sent' | 'existing_account_sent' | 'ineligible' | 'not_sent'>;
export async function initializePortalSelfRegistrationWorker(): Promise<void>;
export async function shutdownPortalSelfRegistrationWorker(): Promise<void>;
```

Rules (D5–D7):
1. `emailDomainOf`, then `findOrgByVerifiedDomain(domain)`. Null → `ineligible no_verified_domain`.
2. `hostOrgId = host ? await resolvePortalHostOrgId(host) : null`; `hostOrgId !== null && fact.orgId !== hostOrgId` → `host_mismatch`.
3. `getActiveOrgTenant(fact.orgId)` null → `org_inactive`.
4. `resolvePortalAccessPolicy(fact.orgId)`. Effective `selfRegistrationMode === 'off'` → `mode_off`.
5. Any `portal_users` row with `org_id = fact.orgId` and `portalLoginEmailEquals(email)` → `existing_account`. Otherwise `eligible`, with `policy.fingerprint`.

The worker then:
- `eligible` → issue the token (null → `not_sent`, logged), then send the link (`buildPortalUrl('/request-access/verify') + '#token=' + encodeURIComponent(raw)`);
- `existing_account` → send the existing-account email;
- either one → audit `portal.auth.self_register.email_sent` against `orgId`.

An email send failure is logged and returns `not_sent`. It is not retried, so a retry cannot send a second email. Queue options: `attempts: 1`, `removeOnComplete: true`, `removeOnFail: { age: 86400 }`, worker concurrency 5.

- [ ] **Step 1: Write the failing tests**

```ts
// eligibility.test.ts (mocked read API / policy / db)
it('an address on a verified domain with approval mode is eligible with the policy fingerprint');
it('a declared-only or unknown domain is ineligible');                                   // D5
it('a subdomain of a verified domain is ineligible');                                    // D5
it('mode off, an inactive org and a host mismatch are ineligible');
it('a custom-domain host for org X never yields org Y\'s link');                          // inv. 1
it('an account at the same address in another org does not count as existing');         // RF2
it('any status of account in the matched org counts as existing (invited, active, disabled, add-in)');
it('a domain cleared before the job runs sends nothing');                                // RF3
// worker.test.ts
it('eligible: issues one token and sends one verify link with the token in the fragment; audits email_sent verify_link');
it('existing account: sends the existing-account email, issues no token');
it('ineligible: sends nothing, writes no org audit, logs the domain but never the address');
it('a send failure is logged and not retried');
it('token store unavailable: no email, logged not_sent');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement**, plus the registry and manifest edits.
- [ ] **Step 4: Run** both files, `workerRegistry.test.ts`, `workerEntrypointClosure.contract.test.ts`, `src/__tests__/parkedFanout.contract.test.ts` and `src/__tests__/dbTransactionPromiseAll.contract.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): self-registration eligibility and worker (W6)`

### Task 4: Consume outcomes

**Files:**
- Create: `services/portalSelfRegistration/complete.ts` (+ `complete.test.ts`); export it from `index.ts`.
- No change to `routes/orgPortalUsers.ts`: the instant path mints the invite token itself (D10), so `issueAndSendInvite` needs no refactor.

**Interfaces:**
- Consumes: `PortalSelfRegistrationPayload` (T1); `isDomainVerifiedForOrg`; `resolvePortalAccessPolicy`; `getActiveOrgTenant`; `createPortalAccessRequest`; `lockPortalInviteAddresses`, `portalLoginEmailEquals`; `linkLoginToContact`; `initialPortalAccountState('self_registration_instant')`; `issuePortalCapabilityToken`.
- Produces:

```ts
export type SelfRegistrationRefusal = 'org_inactive' | 'domain_not_verified' | 'policy_changed' | 'mode_off';
export type CompleteSelfRegistrationOutcome =
  | { outcome: 'refused'; reason: SelfRegistrationRefusal }                        // route → generic 400
  | { outcome: 'existing_account'; orgId: string }
  | { outcome: 'request_sent'; orgId: string; requestId: string; created: boolean }
  | { outcome: 'request_unavailable'; orgId: string }                               // capped
  | { outcome: 'account_created'; orgId: string; portalUserId: string; inviteToken: string | null };
/** No DB context held (public route). Re-validates per D8, then applies D10. */
export async function completePortalSelfRegistration(payload: PortalSelfRegistrationPayload, now?: Date): Promise<CompleteSelfRegistrationOutcome>;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('approval mode creates a self request and returns request_sent');
it('a repeat within 14 days bumps the pending request (created: false)');
it('a capped org returns request_unavailable');
it('instant mode creates an invited, browser-granted password account linked to its contact and returns an invite token');
it('instant mode never modifies an existing account at the address');                 // inv. 5
it('an account created between email and click returns existing_account in both modes');
it('consume refuses when the domain was cleared after issue');                         // RF3
it('consume refuses when the domain moved to another org');                            // RF3
it('consume refuses after a policy change (fingerprint)');                             // RF5
it('consume succeeds when an unrelated org\'s policy changes');                         // RF5
it('consume refuses for an inactive org, and for mode off (as a generic refusal)');
it('an ambiguous contact match creates the account with contactId null, as an invite does');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.** Order: active org → domain → policy (fingerprint, then mode) → existing account → mode branch. The instant branch is one `withSystemDbAccessContext` transaction. The invite token is minted after commit.
- [ ] **Step 4: Run** the file and `portalAccountWriters.contract.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): self-registration consume — request or instant account (W6)`

### Task 5: Approval domain check, queue and policy-view facts

**Files:**
- Modify: `services/portalAccessRequests.ts` (+ test):
  - new code `'PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED'` (409, D11 copy);
  - `DecisionInput` gains `selfDomainVerified?: boolean`. For `source 'self'`, `false` throws before any write. `undefined` is treated as `false` for `self`, so a caller that forgets the pre-check fails closed. Other sources ignore it.
- Modify: `routes/orgPortalAccessRequests.ts` (+ test):
  - Before each approve (single and bulk, per id), read the request's `source` and `email` (the existing RLS read).
  - For `self`, compute `await runOutsideDbContext(() => isDomainVerifiedForOrg(emailDomainOf(email), orgId))` and pass it in.
  - The list response gains `domainVerified`: one `listVerifiedDomainsForOrg(orgId)` call (outside context) → a set → per row, `null` for non-`self`.
  - A bulk refusal maps to the per-id result code `domain_not_verified`.
- Modify: `PortalAccessRequestListItem` (`services/portalAccessRequests.ts`; its web mirror changes in Task 9's `types.ts`) and `packages/shared/src/validators/portalAccessPolicy.ts`. Add `verifiedDomainCount: number | null` to `PortalAccessPolicyView` (org view: `listVerifiedDomainsForOrg(orgId).length`, read outside the request context; partner view: `null`).
- Modify: `services/portalAccessPolicyWrites.ts` (+ test). The org view builder fills it in.

- [ ] **Step 1: Write the failing tests**

```ts
// portalAccessRequests.test.ts
it('approve refuses a self request whose domain is no longer verified (409 DOMAIN_NOT_VERIFIED), request stays pending');  // RF3
it('approve of a self request without selfDomainVerified fails closed');
it('entra, google and addin_user approvals ignore selfDomainVerified');
// orgPortalAccessRequests.test.ts
it('the route pre-checks the domain outside the request transaction and passes it to approve');
it('bulk approve reports domain_not_verified per id and keeps deciding the rest');
it('the list carries domainVerified for self rows and null for others');
// portalAccessPolicyWrites.test.ts
it('the org view carries verifiedDomainCount; the partner view carries null');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files plus `src/__tests__/dbTransactionPromiseAll.contract.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): approval re-checks the self-registration domain; queue and card facts (W6)`

### Task 6: Public routes and discovery

**Files:**
- Create: `routes/portal/requestHost.ts`. Move `requestHost(c)` and `hostOrgIdFor(c)` out of `oidc.ts` unchanged and export them. `oidc.ts` imports them, and `oidc.test.ts` keeps passing unchanged.
- Create: `routes/portal/selfRegistration.ts` (+ `selfRegistration.test.ts`) exporting `selfRegistrationRoutes`. Mount it in `routes/portal/index.ts` with the other public routes (after `authRoutes`, before any `portalAuthMiddleware` use).
- Modify: `routes/portal/auth.ts`. Add `['/auth/self-register', 'portal.auth.self_register.request']` to `PORTAL_AUTH_AUDIT_ACTIONS`. The wrapper is registered on `/auth/*`, so it covers the new route.
- Modify: `routes/portal/oidc.ts` `GET /auth/methods`. Add `requestAccess`:
  - shared host → `getPortalSignInCapabilities().selfRegistration` (a constant);
  - custom host → the org's effective `selfRegistrationMode !== 'off' && (await listVerifiedDomainsForOrg(orgId)).length > 0`;
  - `PortalAccessPolicyOrgNotFoundError` → the shared answer.

**Interfaces:**
- Consumes: T1 schemas, limits and token consume; T3 `enqueuePortalSelfRegistration`; T4 `completePortalSelfRegistration`; `getPortalSignInCapabilities().selfRegistration` (both 404s); `checkRateLimit`, `rateLimitIpKey` (`services/clientIp.ts`), `getClientIp`, `normalizeEmail`, `sweepPortalState` (`routes/portal/helpers.ts`).
- Produces:
  - `POST /portal/auth/self-register` `{ email, name }` → 200 `{ success: true, message }`, or 400 / 404 / 429 / 503 (D3).
  - `POST /portal/auth/self-register/verify` `{ token }` → 200 one of:
    - `{ outcome: 'request_sent' }`
    - `{ outcome: 'request_unavailable' }`
    - `{ outcome: 'existing_account' }`
    - `{ outcome: 'account_created', next: '/accept-invite?token=…' }`

    Or 400 (generic invalid link), 404 (capability off), 429, or 503 (token store unavailable, pre-checked before consume).
  - `GET /portal/auth/methods` → `{ password, microsoft, requestAccess }`.

Verify handler:
1. Rate limit, capability, store pre-check.
2. `consumePortalSelfRegistrationToken`; null → audit anonymous `denied`, then 400.
3. `completePortalSelfRegistration`. `refused` → org-scoped `denied` audit, then the **same** 400. Otherwise audit `success` with the outcome, then the response. `account_created` with a null `inviteToken` → 503 (D10 residual).

- [ ] **Step 1: Write the failing tests**

```ts
it('submit responses are identical for eligible, ineligible, existing, unknown and declared-only addresses');   // RF1
it('the submit handler performs no DB read and no domain lookup');                                               // RF1 (db and read-API mocks assert zero calls)
it('throttling is identical for eligible and ineligible addresses: IP, email and domain limits, same 429 body'); // RF1
it('submit enqueues email, name and the normalized host; an enqueue failure still returns the uniform 200');
it('submit refuses orgId in the body (400) and returns 404 when the capability is off');
it('submit writes one anonymous portal.auth.self_register.request audit row');
it('verify: unknown, expired and reused tokens get the same 400');                                                // RF4
it('verify: a refused completion returns the same 400 body as an unknown token');
it('verify maps request_sent, request_unavailable, existing_account and account_created to their responses');
it('verify: account_created returns next=/accept-invite?token=… and audits portal.auth.self_register.verify');
it('/auth/methods: requestAccess is the capability constant on the shared host');
it('/auth/methods: on a custom host, requestAccess needs mode != off and a verified domain');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `selfRegistration.test.ts`, `oidc.test.ts`, `auth.test.ts`, `routes/portal/featureFlags.test.ts`, `portalSectionGates.contract.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): public self-registration routes and requestAccess discovery (W6)`

### Task 7: Integration proofs and the W06a gate

**Files:**
- Create: `apps/api/src/__tests__/integration/portalSelfRegistration.integration.test.ts`:
  - real DB as `breeze_app`, with superuser seeding;
  - verified rows seeded by SQL (`verified_at`, method `dns_txt`, evidence `{recordName}`, `last_passed_at = now()`);
  - the queue job run by calling `processPortalSelfRegistration` directly;
  - the email service mocked at the transport.

- [ ] **Step 1: Write the failing tests**

```ts
it('approval: submit → job → link → verify creates one pending self request in the verified org');
it('instant: verify creates an invited, granted password account with a portal contact; accept-invite activates it');
it('instant under sso_only: the invite token is accepted by the Microsoft invite start (requirePasswordMethod false) and refused by the password accept');
it('two orgs, one address: only the verified org gets a request');                         // RF2
it('displacement between email and click lands nobody in the old org');                    // RF3 (W5 transfer: clear A, verify B)
it('a domain set is_active=false between email and click refuses the link');               // RF3
it('MSP approval of a self request after the domain is cleared: 409, request still pending'); // RF3
it('MSP approval of a self request while verified sends the normal invite (W3 path unchanged)');
it('the pending cap returns request_unavailable at 200 live requests');
it('an instant-mode account holds no browser session before it accepts the invite');      // inv. 9 (status invited)
it('a request on org X\'s custom portal host for an address on org Y\'s verified domain sends nothing');  // inv. 1, D6
```

- [ ] **Step 2: Run them; verify they fail, then pass once Tasks 1–6 are in.**
- [ ] **Step 3: Typecheck and sweep**

```bash
NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"   # exit=0
cd packages/shared && npx tsc --noEmit; echo "exit=$?"
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/__tests__/
```

- [ ] **Step 4: Integration and contract suites.** Run:
  - the new file;
  - `portalAccessRequests`, `portalAccessPolicyEnforcement`, `portalAccessPolicyResolver`, `portalDomainVerification`, `portalOidcSignIn`, `portalContactInvite`, `loginContactLinking`, `portalPasswordResetPartnerLane`;
  - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`;
  - `pnpm --filter @breeze/api test:integration-suite-coverage`. New sources sit under `services/portal*` and `routes/portal*` (already globbed). `config/portalSelfRegistration.ts` needs a `suite portal sources` line only if the coverage check names it.
- [ ] **Step 5: Review and PR.**
  - One independent review round (`superpowers:requesting-code-review`) and the advisor quorum on D1–D12.
  - `pnpm test-stack down`, and say so.
  - PR body:
    - `Part of #11383`;
    - the rule-9 statement;
    - D1–D12, and OD1–OD6 as resolved;
    - the D10 residual (an account with no minted invite token);
    - "no migration".

---

## W06b — Portal + web + docs

### Task 8: Portal Request access and verify pages

**Files:**
- Create: `apps/portal/src/pages/request-access/index.astro` (`AuthLayout`, `RequestAccessForm client:load`) and `request-access/verify.astro` (`VerifyAccessRequest client:load`).
- Create: `components/portal/RequestAccessForm.tsx` and `VerifyAccessRequest.tsx`, each with a `*.test.tsx`. Template: `ForgotPasswordForm.tsx` (react-hook-form + zod, `BTN_PRIMARY`, `INPUT`).
- Modify: `LoginForm.tsx` (+ `LoginForm.microsoft.test.tsx` or a new test) and `lib/oidc.ts` (`SignInMethods` gains `requestAccess: boolean`). Show a **Request access** link (`data-testid="login-request-access"`) only when `methods.requestAccess === true`. A failed methods fetch shows no link.
- Modify: `middleware.ts` (+ `middleware.test.ts`). Pages are public by default (`isProtectedPath` is a prefix list of protected areas), so `lib/protectedPaths.ts` does not change. Add `/request-access` to `authOnlyPaths`, so a signed-in user is sent to their landing page. Add `/request-access/verify` to the token-page header branch (D9).
- Modify: `lib/disabledPageCoverage.test.ts` (add `request-access/index.astro` and `request-access/verify.astro` to `UNAUTHENTICATED_PAGES`) and `lib/protectedPaths.test.ts` (its public-path list).

Behaviour:
- **Form:** name + email, then submit. **Whatever the 200 says**, it renders the same confirmation (`data-testid="request-access-sent"`) with the server's message. A 429 shows "Too many requests…". A 400 shows field errors.
- **Verify:**
  - On mount, read `token` from `location.hash` (`#token=…`), keep it in state, and `history.replaceState` it away.
  - Render "Confirm your request" with **Confirm my request** (`data-testid="request-access-confirm"`). **No request on load.**
  - On click, POST `/auth/self-register/verify` and render the outcome:
    - `request_sent`: "Your request was sent. You'll get an email when your IT provider decides.";
    - `request_unavailable`: the D10 copy;
    - `existing_account`: links to `/login` and `/forgot-password`;
    - `account_created`: `navigateTo(next)`.
  - 400 → "This link is invalid or has expired." with a link back to `/request-access`.

- [ ] **Step 1: Write the failing tests**

```ts
it('the form shows the same confirmation for every 200');
it('the verify page does not post on load');                                     // RF4
it('the verify page removes the token from the address bar');
it('confirm posts the token once and renders each outcome');
it('account_created navigates to the returned accept-invite path');
it('the login page shows Request access only when methods.requestAccess is true');
it('/request-access is public and redirects a signed-in user to their landing');
it('/request-access/verify is served with no-referrer, no-store and noindex headers');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new tests, the `LoginForm` tests, `middleware.test.ts`, `lib/disabledPageCoverage.test.ts` and `lib/protectedPaths.test.ts` from `apps/portal` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Request access and verify pages (W6)`

### Task 9: Web card warning and queue domain badge

**Files:**
- Modify: `components/settings/portalAccess/PortalAccessPolicyForm.tsx` (+ test). When the org view's effective `selfRegistrationMode !== 'off'` and `verifiedDomainCount === 0`, show an inline warning (`data-testid="self-registration-no-domain"`): "No verified domain: nobody can register until you verify one." It links to `#domains`. The partner view (`verifiedDomainCount === null`) shows no warning.
- Modify: `PortalAccessRequestsList.tsx` (+ test) and `types.ts`. For a `self` row with `domainVerified === false`, show a "Domain no longer verified" badge (`data-testid="access-request-domain-unverified"`). Disable its **Approve** button with that reason. The bulk result code `domain_not_verified` gets a label.
- Locale keys in all 8 locales:
  - `portalAccessPolicy.selfRegistration.noVerifiedDomain`;
  - `portalAccessRequests.domainUnverified`;
  - `portalAccessRequests.results.domain_not_verified`;
  - the self-registration option help text if W3b left it as a placeholder.

  Sonnet-eligible fan-out.

- [ ] **Step 1: Write the failing tests**

```ts
it('the org form warns when self-registration is on with no verified domain and links to #domains');
it('the partner form never shows the no-domain warning');
it('a self request with domainVerified false shows the badge and a disabled Approve');
it('bulk results label domain_not_verified');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement; fan out the locale keys.**
- [ ] **Step 4: Run** the tests, `no-silent-mutations.test.ts`, the locale parity tests, `translationCoverage.test.ts`, `keyUsage.test.ts`, `humanizedKeyRegression.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(web): self-registration domain warning and queue badge (W6)`

### Task 10: Capability flip, docs, browser check, W06b gate

**Files:**
- Modify: `apps/api/src/services/portalAccessPolicy.ts` (`getPortalSignInCapabilities`: `selfRegistration: isPortalSelfRegistrationAvailable()`) and `portalAccessPolicy.test.ts`. Sweep tests that assumed `selfRegistration: false` without the test seam (`grep -rln selfRegistration apps/api/src`) and pin each to `__testOnly.setCapabilities`, so none depends on the host's email configuration. Tests: `selfRegistration capability is isPortalSelfRegistrationAvailable()`; `effective selfRegistrationMode is off while the capability is off, whatever the rows say`.
- Create: `apps/docs/src/content/docs/features/portal-self-registration.mdx`, covering:
  - what it is;
  - the requirements: a verified domain (link to `portal-domain-verification`) and the mode on the Sign-in & registration card;
  - approval vs instant;
  - what the requester sees;
  - the 30-minute link;
  - "the page never says whether an address is eligible";
  - the 14-day request expiry;
  - what happens when a domain loses verification;
  - self-hoster: `PORTAL_SELF_REGISTRATION_ENABLED` and the email-service requirement.
- Modify: `features/portal.mdx` and `portal-domain-verification.mdx` (link it), and the `apps/docs/astro.config.mjs` sidebar. Regenerate the index from the repo root with `npx tsx scripts/build-docs-index.ts`.

Steps:
- [ ] **Step 0:** Write the two capability tests, watch them fail, flip the capability, sweep, and run `portalAccessPolicy.test.ts`, `portalAccessPolicyWrites.test.ts`, `routes/portal/oidc.test.ts`, `routes/portal/selfRegistration.test.ts` → PASS. Commit: `feat(portal): turn on the self-registration capability (W6)`.
- [ ] **Step 1:** Write the docs and regenerate the index. Sonnet-eligible.
- [ ] **Step 2: Browser check** with the `feature-testing` skill on a `worktree-stack` (seed a verified domain by SQL; Mailpit or log transport for the emails). Check:
  - the login page shows **Request access** (shared host);
  - a submit shows the confirmation;
  - the verify link renders without consuming;
  - Confirm in approval mode → the request appears in the org's queue → Approve sends the invite;
  - instant mode → lands on accept-invite → set a password → signed in;
  - clearing the domain makes the pending request's Approve disabled with the badge.

  Tear the stack down and say so.
- [ ] **Step 3: Gate.**
  - `astro check` and `tsc` exit 0 in `apps/web` and `apps/portal`;
  - `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main` green in `apps/web` and `apps/portal`;
  - API docs-index tests green;
  - one independent review round.
  - PR body: `Closes #11383`, the rule-9 statement, screenshots of the portal pages, the card warning and the queue badge.
- [ ] **Step 4: Commit**: `docs(portal): customer self-registration (W6)`

---

## Execution split and parallelism

**W06a (API)**
- **SERIAL first:** T1. The token family, schemas, availability predicate and writer gate everything else.
- **PARALLEL GROUP A1 (file-disjoint):**
  - **T2** (`email.ts`, `mailPurposes.ts`);
  - **T3** (`services/portalSelfRegistration/{types,eligibility,queue,worker}.ts`, the worker registry files). It mocks the T2 send functions by their Interfaces signatures.
  - **T5** (`portalAccessRequests.ts`, `orgPortalAccessRequests.ts`, `portalAccessPolicyWrites.ts`, shared validators). It needs only `emailDomainOf`, which it imports from T3's `eligibility.ts`. Land T3's `emailDomainOf` first (a 5-line commit) or inline it in T5 and dedupe at review.
- **PARALLEL GROUP A2 (after A1):**
  - **T4** (`complete.ts`);
  - **T6** (`requestHost.ts`, `selfRegistration.ts`, `oidc.ts`, `auth.ts`, `index.ts`). It codes against T4's Interfaces block and wires the real function when T4 lands.
- **SERIAL last:** T7.
- **Sonnet-eligible:**
  - T1's env config, schemas constants and memory map;
  - T2 entirely (Opus reviews the copy against the "no requester text" rule);
  - T3's queue and registry/manifest edits;
  - T5's `verifiedDomainCount` and list `domainVerified` plumbing;
  - T6's `requestHost.ts` move.
- **Opus:**
  - T1's token consume and parse;
  - T3's eligibility rules and worker outcomes;
  - T4 entirely;
  - T5's approval refusal and route pre-check;
  - T6's uniform-response handler and verify mapping;
  - T7;
  - review of all Sonnet output.

**W06b (portal + web + docs)**, branched from fresh main after W06a merges
- **PARALLEL GROUP B1 (file-disjoint):**
  - **T8** (`apps/portal/**`);
  - **T9** (`apps/web/**`, locale files).
- **SERIAL last:** T10 (the capability flip lands only after T8's pages exist).
- **Sonnet-eligible:** T8's forms; T9's locale fan-out and badge; T10's capability-test sweep and docs.
- **Opus:** T8's verify page (no-consume-on-load, token scrubbing), the T10 browser check, review of B1.

**CPU:** never run more than one `tsc` at a time across the parallel group. Each implementer runs only its own files with `maxForks=4`. The sweep (`--changed origin/main`) runs once, in T7 / T10.

## CI traps

- **Premise.** W5a and W5b are on main (`findOrgByVerifiedDomain`, `isDomainVerifiedForOrg`, `listVerifiedDomainsForOrg`, `OrgDomainsSummaryRow`). Re-check every W3/W4/W5 name in the Interfaces blocks against main before T1.
- **Stacked PRs get no CI.** W06b branches from main after W06a merges. If it must be opened early, `gh workflow run CI --ref <branch>`.
- **Integration suites do not run under `pnpm test`.** `portalSelfRegistration.integration.test.ts`, `portalAccessRequests`, `rls-coverage` and `tenant-export-policy` run only under the Integration Tests job (`vitest.integration.config.ts`). Run them locally on the test stack in T7.
- **Integration-suite ownership map** (`.github/scripts/integration-suites.txt`):
  - The new test file matches `suite portal tests apps/api/src/__tests__/integration/portal[!a-z0-9]*`.
  - New sources match `suite portal sources apps/api/src/services/portal*` and `routes/portal*`. `routes/orgPortalAccessRequests.ts` is already listed.
  - `config/portalSelfRegistration.ts` and any other new import outside those globs need a `suite portal sources <file>` line, or `test:integration-suite-coverage` fails.
- **W5 read API inside a transaction throws** ("must not run inside a request transaction"). Call it from public routes and the worker with no context held; from org routes via `runOutsideDbContext` (T5). A call inside `approvePortalAccessRequest`'s `withDbTransaction` is the bug D11 avoids.
- **Caught queries.** `approvePortalAccessRequest` owns one `withDbTransaction`, and the route catches outside it. Adding the domain refusal inside it keeps that shape. Do not add a try/catch around a query inside it.
- **Writer census.** `portalAccountWriters.contract.test.ts` fails if the instant-mode insert writes `status` / `browser_access` without `initialPortalAccountState('self_registration_instant')`.
- **Workers.** A new worker needs a `workerRegistry` entry (`load` → `{ init, shutdown }`), `workerReadinessManifest`, and the name inserted in registry order in the order-sensitive lists in `workerEntrypointClosure.contract.test.ts` and `workerRegistry.test.ts`. It is event-driven, so there is no `scheduleRegistry` entry.
- **BullMQ job ids** must not contain colons. Let BullMQ assign them; never put the address in a job id.
- **No network in tests.** Mock the email transport and the queue. The DNS resolver is not touched (W6 never checks DNS; the W5 worker does).
- **Customer-PII guard.** `scripts/security/check-customer-pii.sh` fails on any test or doc email domain outside its allowlist. Use `example.com`, `*.example.com` or `.test`.
- **Audit.** No direct `audit_logs` insert. If one appears, it calls `markRequestAuditWritten()` (`auditDirectInsertTracking.test.ts`). Any new resource type needs labels in all 8 web locales (`auditResourceTypeLabels.test.ts`).
- **Mail purposes.** An unregistered purpose throws at send. `mailPurposes.test.ts` enumerates them.
- **`.env.example` and config validation.** The new env var must be added to `.env.example` with a generic comment, and parsed in `config/validate.ts`.
- **Typecheck heap.** API `tsc` needs a 20 GB heap. Check `exit=$?`, never `| tail`.
- **Web.** `no-silent-mutations` `TARGET_GLOBS` (only if a new mutating component is added), 8-locale parity, `keyUsage.test.ts`, `humanizedKeyRegression.test.ts`.
- **Portal page coverage.** Portal pages are public unless their prefix is in `PORTAL_PROTECTED_PREFIXES`. A new public page must be listed in `UNAUTHENTICATED_PAGES` (`lib/disabledPageCoverage.test.ts`), or "every signed-in page sits behind the guard" fails. `lib/protectedPaths.test.ts` enumerates public paths too. The middleware's base headers overwrite page-level `Referrer-Policy`, so token pages get their headers in `middleware.ts` only.
- **Capability flip.** W06a keeps `selfRegistration: false`; its tests use `__testOnly.setCapabilities`. After Task 10, a test that reads the real capability depends on `getEmailService()`, so pin it.
- **Docs index.** Changing any `.mdx` without regenerating `docsIndex.json` fails the docs-index test.
- **No infrastructure details** in docs or PR bodies.

## Out of scope

- **W7:** Google sign-in. W6's `/auth/methods` shape leaves room for `google`.
- **OD2:** Turnstile or any CAPTCHA.
- Customer-side delegated approval (spec non-goal; the queue stays MSP-routed).
- Self-registration for add-in accounts that lack browser access (the W4 Microsoft path, spec §5.6 step 5).
- Notification fan-out to MSP staff beyond the queue count (spec §5.10 defers it).
- Requests from a subdomain of a verified domain (exact match only, W5).
- An AI tool for self-registration or the queue.

## Self-review

1. **Spec coverage (§5.9, §7 W6 row):**
   - Request-access link visibility (shared host constant, custom host gated) → T6 `/auth/methods`, T8; turned on by T10's capability flip.
   - Name + email form → T8.
   - Same response and timing envelope, work async → D3, T3, T6.
   - Exact domain → the one verified org with mode ≠ off → D5, T3.
   - Single-use 30-min link bound to purpose, org, email and policy version, consumed atomically → D8, T1, T4.
   - "You already have access" email → D7, T2, T3.
   - Mailbox proof and policy re-check at open → D8–D10, T4.
   - Approval → request (T4). Instant → invited → set password or SSO under `sso_only` (D10, T4, T7).
   - Per-IP, per-email and per-domain-per-day limits, identical across classes → D4, T6.
   - Pending cap (existing 200) and 14-day expiry (existing) → T4, T7.
   - Turnstile → OD2.
   - §5.4: self-registration needs a verified domain → D5.
   - §5.10: audit names → D12. Approve sends the set-password or SSO invite (W3, unchanged) → T7.
   - §8 docs → T10.
   - Invariants 1, 5, 7, 8, 9 and 10 → named tests.
2. **Step scan:** every code step names its file and signature. Route, worker and component bodies are left to the implementer. The copy is fixed where the spec or uniformity needs it.
3. **Type consistency.** Used identically across T1–T10:
   - types: `PortalSelfRegistrationPayload`, `PortalSelfRegistrationJobData`, `SelfRegistrationTarget`, `CompleteSelfRegistrationOutcome`, `SelfRegistrationRefusal`;
   - functions: `issuePortalSelfRegistrationToken`, `consumePortalSelfRegistrationToken`, `emailDomainOf`, `resolveSelfRegistrationTarget`, `enqueuePortalSelfRegistration`, `processPortalSelfRegistration`, `completePortalSelfRegistration`, `isPortalSelfRegistrationEnabled`, `isPortalSelfRegistrationAvailable`, `initializePortalSelfRegistrationWorker`, `shutdownPortalSelfRegistrationWorker`, `requestHost`, `hostOrgIdFor`;
   - names and fields: `self_registration_instant`, `PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED`, `domainVerified`, `verifiedDomainCount`, `requestAccess`.
4. **Review Focus:** all five lines have named tests in their owning tasks (T1, T3, T4, T5, T6, T7, T8).
5. **Proportion:** decisions, interfaces and test names. No migration SQL (none needed) and no transcribed bodies.
6. **Review round (PR #11584):** two reviewers (code, doc accuracy) found 0 Critical issues. Their fixes are applied: the host lookup moved to the worker, the token rides in a fragment with middleware headers, one availability predicate, the capability flip moved to W06b, the worker registry shape, the portal page-coverage test, the hashed email rate-limit key, an invariant-9 test, and consistent RF numbering.
