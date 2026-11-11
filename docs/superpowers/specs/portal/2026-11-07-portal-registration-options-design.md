---
title: Customer portal registration options (invite, contacts, self-registration, Microsoft, Google, SCIM)
supersedes_issue: "#8278 (Entra SCIM + sign-in) — absorbed as W4 and W9"
status: draft r2 (defaults chosen by Claude; advisor quorum AGREE WITH CHANGES, all findings adopted; awaiting Todd approval)
date: 2026-11-07
---

# Customer portal registration options

## 1. Why

The only way a customer's staff get into the customer portal today is a manual,
per-person invite from the MSP. The invite always ends in a password. That is fine
for a five-person dental office. It does not work for:

- a 300-seat customer on Microsoft 365 or Google Workspace, where nobody wants
  a second password and the MSP cannot invite people one by one;
- an internal IT team whose "customer" *is* its own tenant (#8278);
- an MSP that already has the customer's people as **contacts** and has to retype each
  address into a different screen to invite them;
- a customer whose staff should be able to ask for access themselves, with the MSP
  approving.

Leavers matter just as much as new joiners. Today, disabling someone in Entra or Google
does nothing to their portal login.

**Success:** an MSP can turn on one or more registration methods per customer org
in one place. A customer's staff can get in using whatever identity they already have.
New people show up in an approval queue or are let in, as the MSP chose. People who
leave lose access without anyone remembering to do it. None of this lets one MSP pull
another MSP's customer's people into its portal.

## 2. Current state (verified on main 95a3e48db5, 2026-11-07)

| # | Fact | Source |
|---|---|---|
| F1 | The only creation path for browser portal users is `POST /organizations/:id/portal-users/invite`. It creates a `status='invited'` row with no password and emails a 7-day Redis token to `/accept-invite`, where the user sets a password. Bulk invite moves *every* passwordless, non-disabled password-method row in the org to `invited` and re-sends. The invite token stores only the user id and is read and deleted in separate steps. | `routes/orgPortalUsers.ts`, `routes/portal/auth.ts:802-914`, `routes/portal/helpers.ts:526` |
| F2 | The invite links the login to a contact through `linkLoginToContact`, whose outcomes are `linked`, `created`, `ambiguous` and `unusable-address`; the invite route adds `kept`. No contact screen has a portal action. | `services/contacts/loginLink.ts`, `ContactsCard.tsx` |
| F3 | `portal_users.email` is **not unique**, either per org or globally. Password login considers password-method rows and rejects the request when more than one row matches, even within one org, unless `orgId` is sent, in which case the first match is used. The portal host plays no part in resolving the org; the custom domain is used for branding only. | `portal.ts:114-166`, `auth.ts:473-483`, `branding.ts:45-92` |
| F4 | `portal_users.auth_method ∈ {password, entra}`. The browser session middleware refuses anything that is not `password` (`auth.ts:255`). Entra rows are created just-in-time, **active**, only by the AI for Office token exchange (gated by partner flag + org policy), and they only mint add-in sessions, which slide with no absolute cap. `entra_tenant_id` and `entra_oid` live on the row. | `clientAiExchange.ts:274-461`, `middleware/clientAiAuth.ts:124` |
| F5 | The Entra tenant → org mapping is `client_ai_tenant_mappings`: org-only, 1:1 and globally unique on tenant. It is set by hand by the MSP; the tenant id is suggested from `m365_connections` or `delegant_m365_connections`. The admin-consent callback stores nothing. Org merge keeps only the survivor's mapping. | `clientAi.ts:29-40`, `routes/clientAi/admin.ts`, `adminOrgs.ts:84-121`, `orgMergeRegistry.ts:557` |
| F6 | Contact linking for Entra users takes the address from `preferred_username` (treated as UPN) or from `email` with `xms_edov=true`, and requires its domain to match `customer_email_domains`. `preferred_username` is mutable and Microsoft documents it as unsuitable for authorization, so **this design does not reuse the rule for account linking.** | `clientAiEntraAddress.ts`, `clientAiEntraJwt.ts:163` |
| F7 | `customer_email_domains(partner_id, org_id, domain, auto_create_contact, is_active)` is unique on `(partner_id, domain)` and partner-axis RLS. It has no verification, and its CRUD can repoint a domain to another org. It is edited in Ticketing → Inbound email. | `schema/emailInbound.ts:50-63`, `ticketConfigService.ts:976` |
| F8 | `m365_users` caches the Entra directory, including `account_enabled`, for orgs with a `customer-graph-read` connection. Snapshots can be truncated, and disconnect deletes the cache. Nothing links it to portal users. | `schema/m365Sync.ts:94-131`, `m365Sync/domains/users.ts:232`, `m365Sync/lifecycle.ts:104` |
| F9 | `google_workspace_connections` stores a **caller-supplied** `customer_domain` next to domain-wide-delegation credentials; the domain is not proven. Staff SSO has a Google OIDC preset; there is no portal Google sign-in and no Google OAuth client env. | `schema/google.ts:28-60`, `routes/google.ts:115-140`, `services/sso.ts:903` |
| F10 | Staff SSO has `sso_providers` (OIDC; SAML is parsed but refused at login), `user_sso_identities` and `sso_verified_domains` (DNS TXT; verification is never cleared). All of it applies to `users` only. | `schema/sso.ts`, `ssoDomainVerification.ts:70` |
| F11 | Portal users have no MFA and the portal has no bot protection. Login is rate-limited per IP and per account. | `auth.ts`, `schemas.ts:111-127` |
| F12 | There is no SCIM implementation. | grep |
| F13 | The M365 consent flow is already identity-first: it proves the admin and tenant with a v2 OIDC sign-in, and deliberately ignores consent-callback query parameters as authority. | `m365ControlPlane/microsoftAuthorization.ts`, `routes/m365ConsentCallback.ts:75,226` |

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. **Invite from contacts.** Grant portal access from the contacts list (one or many); the login binds to *that* contact.
- G2. **Self-registration by email domain.** A person on one of the org's verified domains can request access from the portal; the MSP approves, or lets them straight in.
- G3. **Sign in with Microsoft** on the browser portal.
- G4. **Sign in with Google** on the browser portal.
- G5. **New-person policy.** People arriving through G2, G3 or G4 without browser access become an access request or are granted, as the MSP chose.
- G6. **Password off** per org once an identity provider is on.
- G7. **Leavers lose access:** absolute SSO session limits, directory deprovisioning, and Entra SCIM (#8278).
- G8. **One place** per org for all of this, with partner defaults.

**Non-goals (this feature)**
- Generic SAML or OIDC IdPs for customers (Okta, JumpCloud, …). The identity model is issuer/subject keyed, so they can be added later.
- Customer-side delegated admin, where a customer's manager invites or approves colleagues. This is the follow-up, and the request queue is built so it can be re-routed.
- Portal MFA for password users (F11). It is a separate gap.
- Google push provisioning (Google has no SCIM push to arbitrary apps).
- SCIM Groups. Users only in this feature; scoping is done by Entra *Assignment required*.
- Changing what a portal user can see.

**Anti-goals: failure even if it "works"**
- A person lands in the **wrong org**, or an MSP can pull another MSP's customer's staff into its portal by claiming their domain or tenant.
- Unauthenticated portal endpoints become an oracle for "is this domain a customer here" or "does this address have a login".
- An SSO sign-in takes over an existing login because an email matched (the nOAuth class of bug).
- Using the AI for Office add-in silently grants browser portal access, or the reverse.
- Two sources of truth for "which external identity is this login".
- A second home for customer domains.

## 4. The MSP-facing model

Per org, a **Sign-in & registration** card sits on the org settings **Portal** tab above the
portal users list:

```
Sign-in & registration — Contoso Ltd               (blank = inherit partner default)

How people sign in
  Microsoft     Tenant contoso.onmicrosoft.com ✓ proven     [ On ]
  Google        hd contoso.com ✓ verified                   [ Off ]
  Password      ( ) Allowed   (•) Off — Microsoft/Google only     ← only selectable when an SSO method is on

How new people get browser access
  Invites from the MSP                always on
  Self-registration (email domain)    (•) Off  ( ) Request → approval  ( ) Instant
  First Microsoft / Google sign-in    ( ) Invited people only  (•) Request → approval  ( ) Instant

Domains        contoso.com ✓ DNS · contoso.co.uk (declared — mail routing only)   → Organization › Domains
Requests (3)   → queue below: Approve / Deny
```

Default values (Claude's call; partner default → org override):

| Setting | Default | Why |
|---|---|---|
| Password | allowed | Today's behaviour |
| Microsoft / Google | off | Needs a proven tenant or verified domain |
| Self-registration | off | Opt-in public form |
| First SSO sign-in | request → approval | Safe, and still removes the per-person invite. An internal-IT partner flips the partner default once |

`password_mode` is **one** setting (`allowed | sso_only`), not two independent switches, so
inheritance can never produce "password disabled and also required". `sso_only` is valid
only while the effective policy has an SSO method on. If an inherited change turns the last
SSO method off, the effective value falls back to `allowed` and the card shows why.

## 5. Design

### 5.1 Accounts, credentials and browser access (separated)

Three things that are mixed together today get separated:

| Concept | Where | Values |
|---|---|---|
| **Account lifecycle** | `portal_users.status` (+ CHECK) | `invited`, `active`, `disabled` |
| **Password credential** | `portal_users.password_hash` (+ existing `auth_method` guard, renamed in code to "password-eligible") | present / absent |
| **External identities** | `portal_user_identities` (§5.2) | 0..n per account |
| **Browser portal access** | `portal_users.browser_access` (new) | `granted`, `none` |

- Backfill: existing password-method rows get `granted`. Existing Entra JIT rows, created by the
  add-in, get `none`, because they have no browser access today. Nothing changes for anyone on deploy.
- A browser session (any method) requires `status='active' AND browser_access='granted'`, the
  org active gate, and the method allowed by the effective policy. An add-in session keeps its own
  gates (partner flag, org policy, `user_access`). **Neither product grants the other.**
- Pending requests live in **`portal_access_requests`**, not in `portal_users`. They hold org,
  email, name, source (`self | entra | google | addin_user`), the identity claims when
  SSO-originated, status (`pending | approved | denied | expired`), timestamps and the decider.
  This keeps an add-in user's account untouched while they wait for browser access, and keeps a
  denial history.
- **State machine: every writer is enumerated and tested.** Allowed transitions:
  - `invited → active` via accept-invite, or an invitation-bound SSO sign-in (§5.6). **Never** via an MSP
    PATCH. Today's PATCH allows it (`orgPortalUsers.ts:235-239`), and W2 refuses it with 409.
  - `active ↔ disabled` (MSP, deprovisioning, SCIM). `invited → disabled` (MSP).
  - Reactivating a disabled account that has no password and no identity returns it to `invited`, not `active`.
  - `active → invited` and `invited → invited` (re-invite / resend; existing behaviour, `orgPortalUsers.ts:204`).
  - `browser_access none → granted` only via MSP grant, approval of a request, an instant-mode policy, or SCIM.
  - Bulk invite is narrowed to password-method rows with no password and no identity, in `status IN ('invited','active')`.
    `active` is included because pre-#3258 inbound email created active passwordless rows that the UI shows as
    "pending setup". Bulk invite can no longer touch identity-only or add-in accounts.
  - Accept-invite also checks that the org is active, and reset refuses disabled accounts (W2 closes both at token consume).

### 5.2 `portal_user_identities` (single source of truth for external identity)

```
portal_user_identities
  id uuid pk
  org_id uuid not null              -- shape 1, breeze_has_org_access(org_id), FORCE RLS
  portal_user_id uuid not null      -- FK (portal_user_id, org_id) → portal_users(id, org_id) DEFERRABLE INITIALLY IMMEDIATE, ON DELETE CASCADE
                                    --   (adds UNIQUE (id, org_id) on portal_users as the FK target)
  provider text not null            -- 'entra' | 'google' (CHECK)
  issuer text not null              -- Entra: https://login.microsoftonline.com/{tid}/v2.0 ; Google: https://accounts.google.com
  subject text not null             -- Entra oid ; Google sub
  entra_tenant_id text              -- Entra only; used to check the tenant mapping
  linked_via text not null          -- 'jit' | 'invite' | 'self_link' | 'scim' | 'migrated' | 'msp'
  last_used_at timestamptz
  created_at timestamptz not null default now()
  unique (issuer, subject)
  unique (portal_user_id, provider)
```

- Google `hd` is a per-sign-in **domain assertion**, checked every time. It is not part of the identity key.
- **Cutover is writer-fenced**, so there is never a window where the old instance writes columns the new one doesn't read:
  1. Release A: create the table, backfill from `portal_users.entra_*`, and make `clientAiExchange` dual-write.
  2. Release B: reads switch to identities, a reconciliation job reports and repairs drift, and the `authMethod === 'entra'` gate, admin counts and pickers (`adminOrgs.ts:108`) switch over.
  3. Release C: the old columns are dropped.

  A grep on main found the only production readers and writers in `clientAiExchange`, plus the fixed `portal_users` entry in the export registry (`tenantExportPolicyRegistry.ts:780`).
- Registration: `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry` (repoint, plus a defined
  rule for tenant preservation, §5.4), and `CORE_TENANT_EXPORT_POLICY` (every column classified).
  The same applies to `portal_access_requests` and `portal_access_policies`.

### 5.3 Access policy: `portal_access_policies`

Partner-wide first (#2135): `org_id` XOR `partner_id`, with a unique singleton per owner, FORCE RLS,
SELECT-only partner read branch, and write gate `canManagePartnerWidePolicies`. Columns:
`entra_enabled`, `google_enabled`, `password_mode`, `self_registration_mode`,
`sso_new_person_mode`, and `sso_session_max_hours`. They are nullable on org rows (null = inherit).
There is one resolver, `resolvePortalAccessPolicy(orgId)`, which returns effective values plus the
source of each. Org merge: the survivor's policy wins and the merge is audited.

**Policy is enforced at use, not only at save.** Session middleware, password login, reset,
accept-invite and every token consume re-resolve the effective policy (cached briefly with an
invalidation hook on policy writes). Turning a method off, switching to `sso_only`, or revoking a
mapping or domain proof therefore kills outstanding sessions and tokens for that method on the
next request.

Settings rule 9 statement: home = org settings › Portal › Sign-in & registration (org) and
partner settings › Customer portal (partner default); resolver = `resolvePortalAccessPolicy`;
places configured before = 0, after = 2 (one per level).

### 5.4 Proof of ownership (tenants and domains)

**Nothing typed by an MSP is ever proof.** Proof records *what* (tenant or domain), *which
org*, *how*, the *evidence*, and *when*. It is invalidated whenever the claim is repointed,
deleted or re-verified unsuccessfully.

**Entra tenant proof:**
- (a) an `m365_connections` row for that org whose tenant was verified by the existing
  identity-first consent flow (F13); or
- (b) a new **identity-first proof run**, reusing `microsoftAuthorization`: a tenant admin signs in
  with OIDC + PKCE, the verified id_token's `tid` is the tenant, and admin rights are confirmed by a
  live check (not `wids`, per #5487); then the portal app's admin consent is granted for that tenant.
  Callback query parameters are never authority.
- Proof is stored on the org's tenant mapping (`proven_at`, `proven_via`, `proven_by`).
- **Transfer:** a proven claim displaces an unproven mapping of the same tenant in another org
  (audited, and the displaced MSP is notified). A proven claim can only be displaced by a newer
  proof from a different org, plus the same audit and notification. Today's unproven mappings keep
  working for AI for Office exactly as now. They cannot enable portal sign-in.
- Org merge: if the absorbed org held a proven mapping and the survivor holds none, the mapping
  moves to the survivor, so repointed identities are not stranded. If both hold one, the merge is
  refused until the MSP resolves it.

**Domain verification** (on `customer_email_domains`; new columns `verified_at`, `verified_method`,
`verification_token`, `verified_evidence`):
- `dns_txt`: a TXT record `breeze-verification=<token>`, re-checked periodically. Verification is
  cleared when the record disappears, or when the row is repointed to another org.
- `entra_tenant`: the domain is a verified domain of the org's **proven** tenant, read via Graph through that org's proven connection.
- `google_directory`: the domain appears as `verified` in the Workspace **Directory API domains
  list** for the customer behind the org's Google connection. The stored `customer_domain` string is not enough (F9).
- A domain can be verified for at most one org platform-wide (a partial unique index). A declared
  but unverified row stays usable for **mail routing only**.

| Method | Requirement |
|---|---|
| Self-registration (approval **or** instant) | verified domain |
| Sign in with Microsoft | proven tenant |
| Sign in with Google | verified domain equal to the `hd` claim |

**UI home** for domains moves to **Organization › Domains**. Ticketing › Inbound email keeps a read-only summary with a link. Partner governance (who may edit) is unchanged.

### 5.5 Invite from contacts (G1)

- `POST …/portal-users/invite` accepts an optional `contactId`. The invite email must equal the
  contact's email (case-insensitive), or the request is refused, because binding a contact grants its
  ticket history. With `contactId`, the bind is direct and `ambiguous` cannot happen. An existing
  binding on the login is never replaced silently: a conflict is refused, and the MSP unbinds first.
- `POST …/portal-users/invite-contacts { contactIds[] }` (capped batch) returns a per-contact outcome:
  `invited`, `already_has_access`, `no_email`, `email_bound_to_other_contact`, `duplicate_email_in_batch`.
- Contacts UI: a **Portal** column (none / invited / active / disabled / requested), row actions
  *Give portal access* / *Resend*, bulk *Give portal access*, and a checkbox on create.
- Invite email adapts in W4/W6. When an SSO method covers the invitee, the email offers
  "Sign in with Microsoft/Google" through an **invitation-bound** link (§5.6). With `sso_only`, it never
  offers a password.

### 5.6 OIDC sign-in, common rules (Microsoft and Google)

- Authorization code + PKCE + nonce. State is **server-side, single-use, short-lived (10 min) and
  bound to the browser** (a cookie) and to its purpose (`login | invite:<inviteId> | link:<portalUserId>`).
  The return URL comes from an allowlist of portal paths. Callback URIs are fixed per provider.
- **Host binding:** on an org's verified custom domain, the resolved org must equal that domain's org.
  On the shared host, the org comes from the proof (tenant or `hd`) only.
- **Finding the account, in this order. There is no automatic linking by email to an existing account.**
  1. An identity `(issuer, subject)` exists → that account, which must be in the resolved org (else deny).
  2. The state's purpose is `invite:<id>`: the invite must be unexpired, for this org, and the account must be
     `invited` with no identity of this provider. Link the identity and activate. The invite is consumed
     atomically. (The invite is the proof of continuity, not the email.)
  3. The state's purpose is `link:<portalUserId>`: the person is already signed in to the portal
     (any method, same org). Link the identity. This is how existing password users move to SSO.
  4. Otherwise, it is a **new person**. If an account with the same verified email already exists in
     the org, the sign-in does **not** link to it. The person sees "You already have an account. Sign in
     with your password and connect Microsoft, or ask your IT provider to re-invite you." The MSP
     sees a re-invite (SSO) action. Otherwise, apply `sso_new_person_mode`:
     - `invited_only` → deny.
     - `approval` → create a `portal_access_requests` row (no account yet) and show "Request sent".
     - `instant` → create the account (`active`, `browser_access=granted`), the identity, and the contact via `linkLoginToContact`.
  5. An existing add-in account (identity found in step 1, `browser_access='none'`) is a new person for
     browser purposes, and step 4's policy applies. In approval mode the request references the existing account.
- Linking is atomic: the unique `(issuer, subject)` and `(portal_user_id, provider)` constraints plus one
  transaction mean concurrent sign-ins cannot create two accounts or two links.
- Guests: Entra tokens whose issuer tenant ≠ the user's home tenant (guest accounts, detected via the
  `idp`/`acct` claims) are refused for portal sign-in.

### 5.7 Sign in with Microsoft (G3)

- **A separate portal Entra app registration** (multi-tenant, web, confidential credential), not the
  AI for Office app. Env (names left to the builder): `PORTAL_ENTRA_CLIENT_ID` + secret or certificate.
  This gives independent *Assignment required* scoping, credentials and conditional access; the cost is a
  second admin consent, folded into the proof run in §5.4(b). Hosted uses LanternOps' registration;
  self-hosters register their own (docs).
- The token is verified with `jose` against the Microsoft JWKS: aud = the portal app, `iss == …/{tid}/v2.0`,
  nonce, exp and iat. The org comes from `tid` → **proven** mapping with `entra_enabled`. Any failure shows
  the same generic "not set up for Microsoft sign-in here".
- Customer-side scoping: docs tell the customer admin to turn on *Assignment required* on the Breeze
  Portal enterprise app.

### 5.8 Sign in with Google (G4)

- A new Google OAuth web client per deployment (env names left to the builder). Scopes are `openid email profile`.
- The token is verified with `jose` against Google's JWKS (iss `https://accounts.google.com`), plus aud, nonce and
  `email_verified=true`. `hd` is required (personal Gmail is always refused) and must equal a domain verified
  for exactly one org with `google_enabled`.

### 5.9 Self-registration by email domain (G2)

- The **Request access** link is shown on the shared host whenever the deployment has portal
  self-registration available, regardless of the address, so its presence reveals nothing. On an org's
  verified custom domain, it is shown only if that org has self-registration on.
- Flow:
  1. The person enters name + email.
  2. **Always the same response and the same timing envelope** (the work is done asynchronously): "If this address can request access, we've emailed you."
  3. Async, the exact domain is matched to the one org where it is **verified** and `self_registration_mode != off`.
  4. If there is no account, a single-use 30-minute link is emailed. The capability token is bound to purpose,
     org, email and issued policy version, and is consumed atomically (GETDEL).
  5. If an account exists, a "you already have access" email is sent instead.
- Opening the link proves the mailbox, and the policy is re-checked at that point.
  - `approval` → a `portal_access_requests` row.
  - `instant` → an account `invited` → set-password (or SSO via invitation-bound link if `sso_only`).
- Abuse: per-IP, per-email and per-domain-per-day limits that are applied identically to eligible and
  ineligible addresses (throttling must not reveal eligibility), a pending-request cap per org, and
  14-day expiry. Turnstile is the builder's call.

### 5.10 Request queue

- MSP surfaces: a **Requests** list at the top of the org's portal users (Approve / Deny, bulk), and a
  partner-wide count. Notification fan-out beyond the count is deferred.
- Approve → the account is created or its browser access granted. SSO-origin requests can sign in
  immediately; self-registration requests get a set-password or SSO invite. Deny → the request is
  marked `denied` and the requester gets a neutral email.
- Audit:
  - `organization.portal_user.access_request.approve` and `.deny`
  - `portal.auth.self_register.request` and `.verify`
  - `portal.auth.oidc.login` (provider in details) and `portal.auth.identity.link`
  - `organization.portal_identity_proof.*`

### 5.11 Sessions and leavers (G6, G7)

- **Shipped with the first SSO wave (W4), not later:**
  - SSO browser sessions get an absolute lifetime of `sso_session_max_hours` (default 12) on top of
    today's sliding 24 h, then return through the IdP.
  - Add-in sessions get an absolute cap too. The default, chosen by the builder with Todd, is listed in the W4 PR.
  - Durable checks (epoch, revocation table, policy re-resolve) stay authoritative. Redis deletion is cleanup only.
- `password_mode = sso_only`: password login, forgot-password and accept-invite fail for that org with
  the same generic error as a bad password, and outstanding reset/invite tokens die on use (policy re-resolve).
  Turning it on first shows how many active accounts have no identity, and offers to send each one an
  invitation-bound "connect Microsoft/Google" email. Saving clears password hashes and bumps epochs only
  for accounts that **have** an identity. The rest are listed as stranded until they link or are re-invited.
- **Directory deprovisioning (W8):**
  - Entra: only from **complete, current-tenant** `m365_users` snapshots (truncated runs never establish
    absence; a disconnect never counts as deletion), with run deduplication. An identity whose `oid` is
    `account_enabled=false`, or absent from two consecutive complete snapshots, is acted on.
  - Google: the same, from a daily Directory API pass (`suspended`, deleted).
  - **Effect:** the provider disables the **identity**. If the account has no other usable credential
    (no other identity, and no password or `sso_only`), the account is disabled (epoch bumped, sessions purged,
    audit with source). An MSP-set `disabled` is never reversed by a provider. Re-enabling in the IdP
    does not auto-reactivate.
- **SCIM (W9, absorbs #8278):** a per-org SCIM 2.0 Users endpoint, authenticated by a bearer token bound
  to org + proven tenant and stored hashed and rotatable.
  - Matching is idempotent on `externalId` = Entra `oid` (writes identities with `linked_via='scim'`).
  - An `externalId` already bound in another org → 409.
  - Deactivate/delete → identity disabled → the account rule above.
  - Precedence: an MSP disable beats a SCIM activate.
  - SCIM-created accounts are `active`, `browser_access=granted` and identity-only.

## 6. Security invariants (each needs a test)

1. A sign-in never lands in an org other than the one resolved from a **proven** tenant or a **verified** `hd` domain; on a custom-domain host, that org must also equal the host's org.
2. No MSP-entered value (tenant id, domain, Workspace `customer_domain`, callback query param) is ever treated as proof.
3. Proof is invalidated when the claim is repointed, deleted or fails re-verification, and features depending on it stop on the next request.
4. An identity's org always equals its account's org (composite FK), and a token from a tenant mapped to org A never uses an account in org B.
5. An external identity is linked to an existing account only via an invitation-bound state, an authenticated link state, SCIM, or an MSP action — **never by email match** — and linking is atomic.
6. OIDC state/nonce/PKCE are server-side, single-use, expiring and browser-bound; callback and return URLs come from allowlists.
7. Capability tokens (invite, self-registration, reset, link) are purpose-bound (purpose, org, email/account, issued epoch or policy version), consumed atomically, and re-check effective policy at consume.
8. Unauthenticated discovery and failure responses (login failure, self-registration, forgot-password) are identical in body, status and throttling for eligible, ineligible, existing and unknown addresses. Login must not reveal that an address has more than one account.
9. Browser sessions require `status='active'`, `browser_access='granted'`, active org/partner, and a method allowed by current effective policy, re-checked per request. Add-in sessions never grant browser access and vice versa.
10. Every writer of `status` and `browser_access` follows the §5.1 transition table; no legacy path (accept-invite, bulk invite, add-in JIT) can activate an account or grant browser access outside it.
11. `sso_only` makes every password-path endpoint fail for that org, and kills password sessions and outstanding password tokens for accounts that have an identity.
12. Deprovisioning acts only on complete snapshots, never reverses an MSP disable, and bumps epoch and purges sessions (browser and add-in).
13. Guest and cross-tenant Entra tokens never sign in to the portal.

## 7. Waves

| Wave | Scope | Depends on | Risk |
|---|---|---|---|
| W1 | Invite from contacts (§5.5 minus the SSO email variant), including the email-equals-contact rule, conflict refusal and batch outcomes | — | Medium (grants ticket history) |
| W2 | Account foundations: `status` CHECK, `browser_access` + backfill, state-machine enforcement across all writers (incl. narrowing bulk invite), purpose-bound tokens, uniform login failure response, `portal_user_identities` release A (table + backfill + dual-write) | — | **High** |
| W3 | Policy + requests: `portal_access_policies` + resolver + enforcement at use, `portal_access_requests` + queue UI, Sign-in & registration card (password options live), identities release B (read switch + reconciliation) | W2 | **High** |
| W4 | Proof + Microsoft: tenant proof run, transfer and merge rules, portal Entra app, OIDC common layer (§5.6), Microsoft sign-in, link-from-signed-in flow, invitation-bound invites, absolute session caps (browser + add-in), `sso_only` | W3 | **High** |
| W5 | Domains: verification columns + DNS/Entra/Google-directory methods, re-check job, move UI home to Organization › Domains | W3 (Entra method needs W4) | Medium |
| W6 | Self-registration | W3, W5 | **High** (public) |
| W7 | Sign in with Google | W4 (OIDC layer), W5 | **High** |
| W8 | Directory deprovisioning (Entra snapshots, Google Directory) | W4 or W7 | High |
| W9 | Entra SCIM Users (#8278) | W4 | High |
| — | Identities release C (drop `portal_users.entra_*`) | W3 shipped and reconciled for one release | Medium |

W1 and W2 can run in parallel. After W4, W5 → W6/W7 and W8/W9 can overlap.

## 8. Docs

- Customer-facing: "Getting your team into the portal" (one page per method, *Assignment required*, SCIM setup).
- Self-hoster: portal Entra app registration, Google OAuth client, env vars.
- MSP: the Sign-in & registration card, proving a tenant, verifying domains, and the request queue.

## 9. Decisions (quorum-resolved)

| # | Question | Decision | Note |
|---|---|---|---|
| Q1 | Reuse the AI for Office Entra app, or a separate one? | **Separate portal app** | Changed from the r1 default after quorum: independent assignment, credentials and conditional access outweigh one extra consent. |
| Q2 | Pending requests in `portal_users`, or a separate table? | **Separate `portal_access_requests` + explicit `browser_access`** | Keeps add-in accounts' lifecycle untouched. |
| Q3 | Move the domain UI home? | **Move to Organization › Domains** | Ticketing keeps a read-only summary. |
| Q4 | Default for a first SSO sign-in | **Request → approval** at partner level | Internal IT flips it once. |

## 10. Left to the builder

Route paths, env var names, migration file names (after the newest on main), UI copy and
layout, rate-limit numbers, Turnstile, the add-in absolute-cap default (stated in the W4 PR),
re-check cadence for DNS, the policy cache TTL, and whether deprovisioning runs inline after
sync or as its own BullMQ job.
