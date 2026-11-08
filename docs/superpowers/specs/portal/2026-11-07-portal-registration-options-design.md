---
title: Customer portal registration options (invite, contacts, self-registration, Microsoft, Google, SCIM)
supersedes_issue: "#8278 (Entra SCIM + sign-in) — absorbed as W7 and W4"
status: draft (defaults chosen by Claude; advisor quorum pending; awaiting Todd approval)
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
- an MSP that already has the customer's people as **contacts** (tickets, imports,
  inbound email) and has to retype each address into a different screen to invite them;
- a customer whose staff should be able to ask for access themselves, with the MSP
  (or nobody) approving.

Leavers matter just as much as new joiners. Today, disabling someone in Entra or Google
does nothing to their portal login.

**Success:** an MSP can turn on one or more registration methods per customer org
in one place. A customer's staff can get in using whatever identity they already have.
New people show up in an approval queue or are let in, as the MSP chose. People who
leave lose access without anyone remembering to do it.

## 2. Current state (verified on main 95a3e48db5, 2026-11-07)

| # | Fact | Source |
|---|---|---|
| F1 | The only creation path for browser portal users is `POST /organizations/:id/portal-users/invite`. It creates a `status='invited'` row with no password and emails a 7-day Redis token to `/accept-invite`, where the user sets a password. Bulk invite only re-sends links to existing rows that have no password. | `routes/orgPortalUsers.ts`, `routes/portal/auth.ts:802-914` |
| F2 | The invite links the login to a contact through `linkLoginToContact`. The outcomes are `linked`, `created`, `ambiguous` (two or more contacts share the address, so the login is left unlinked) and `unusable-address`. No contact screen has a portal action. | `services/contacts/loginLink.ts`, `ContactsCard.tsx` |
| F3 | `portal_users.email` is **not unique**, either per org or globally. Login looks the email up globally and needs `?orgId=` when two orgs match, otherwise it returns 400. The portal host plays no part in resolving the org; the custom domain is used for branding only. | `portal.ts:114-166`, `auth.ts:473-483`, `branding.ts:45-92` |
| F4 | `portal_users.auth_method ∈ {password, entra}`. The browser session middleware refuses anything that is not `password` (`auth.ts:255`). Entra rows are created just-in-time only by the AI for Office token exchange and only mint add-in sessions. `entra_tenant_id` and `entra_oid` live on the row, with a partial unique index on the pair. | `clientAiExchange.ts:274-461` |
| F5 | The Entra tenant → org mapping is `client_ai_tenant_mappings`: org-only, 1:1, and set by hand by the MSP (the tenant id is suggested from `m365_connections`). The admin-consent callback stores nothing. All of it is gated by `CLIENT_AI_ENTRA_CLIENT_ID` and `partners.ai_for_office_enabled`. Tokens are verified with `jose`: JWKS, aud, and `iss == …/{tid}/v2.0`. | `clientAi.ts:29-40`, `routes/clientAi/admin.ts`, `clientAiEntraJwt.ts` |
| F6 | Entra addresses are trusted for contact linking only when the address is the UPN or an `email` with `xms_edov=true`, and its domain exactly matches a `customer_email_domains` row for the org. | `clientAiEntraAddress.ts:33-105` |
| F7 | `customer_email_domains(partner_id, org_id, domain, auto_create_contact, is_active)` is unique on `(partner_id, domain)` and partner-axis RLS. It has no DNS verification. It is edited in Ticketing → Inbound email (`CustomerDomainsCard`). | `schema/emailInbound.ts:50-63` |
| F8 | `m365_users` caches the Entra directory, including `account_enabled`, for orgs with a `customer-graph-read` connection. Nothing links it to portal users. | `schema/m365Sync.ts:94-131` |
| F9 | `google_workspace_connections` exists, one per org, with `customer_domain` and domain-wide delegation. No Google OAuth client is configured anywhere, and there is no Google sign-in. | `schema/google.ts:28-60` |
| F10 | Staff SSO already has `sso_providers` (OIDC; SAML is parsed but refused at login), `user_sso_identities` and `sso_verified_domains` (DNS TXT). All of it applies to the `users` table only. | `schema/sso.ts` |
| F11 | Portal users have no MFA and the portal has no bot protection. Login is rate-limited per IP and per account. | `auth.ts`, `schemas.ts:111-127` |
| F12 | There is no SCIM anywhere. | grep |

## 3. Goals, non-goals, anti-goals

**Goals**
- G1. **Invite from contacts.** Grant portal access from the contacts list (one or many), so nobody retypes addresses, and the login binds to *that* contact (no more `ambiguous`).
- G2. **Self-registration by email domain.** A person whose address is on one of the org's domains can request access from the portal login page. The MSP picks *approve each request* or *let them straight in*.
- G3. **Sign in with Microsoft** on the browser portal, for orgs whose Entra tenant is connected.
- G4. **Sign in with Google** on the browser portal, for orgs on Google Workspace.
- G5. **New-person policy per method.** People who arrive through G2, G3 or G4 without an existing login are either created as *pending approval* or created *active*, as the MSP chose.
- G6. **Require SSO** per org: once an identity provider is on, password sign-in for that org can be switched off.
- G7. **Leavers lose access:** session limits for SSO users, deprovisioning from the existing directory caches, and Entra SCIM (#8278) for real pre-provisioning and deprovisioning.
- G8. **One place** per org to see and change all of the above, with partner-level defaults.

**Non-goals (this feature)**
- Generic SAML or OIDC IdPs for customers (Okta, JumpCloud, …). The identity model in §5.1 must not preclude them.
- Customer-side delegated admin, where a customer's own manager invites or approves colleagues. This is the natural follow-up and the approval queue is built so it can be re-routed later. A follow-up issue will be filed.
- Portal MFA for password users. It is a separate, real gap (F11).
- Google directory push provisioning; Google has no SCIM push to arbitrary apps. Google deprovisioning is pull-based (§7.3).
- Changing what a portal user can *see* once signed in. Visibility flags are untouched.

**Anti-goals: failure even if it "works"**
- A person ends up in the **wrong org**, or an MSP can pull another MSP's customer's staff into its portal by claiming their domain or tenant.
- Self-registration becomes an enumeration oracle ("is contoso.com a customer here?", "does bob@contoso.com have a login?").
- An SSO sign-in silently attaches to an existing password account based on an address the IdP does not vouch for (the nOAuth class of bug).
- Two sources of truth for "which external identity is this login", meaning the Entra columns *and* a new table both get read for auth decisions.
- A second home for customer domains.

## 4. Concepts and the MSP-facing model

Per org, the MSP sees a **Sign-in & registration** card on the org settings **Portal**
tab, above the portal users list:

```
Sign-in & registration — Contoso Ltd                (inherits Partner default where blank)

How people sign in
  [x] Email + password                    (off only when an SSO method is on: "Require SSO")
  [x] Microsoft     Tenant: contoso.onmicrosoft.com ✓ verified   [Change]
  [ ] Google        Domain: —   (connect Google Workspace or verify a domain)

How new people get access
  Invites from the MSP               always on
  Self-registration (email domain)   ( ) Off  (•) Request → approval  ( ) Instant
  First Microsoft / Google sign-in   ( ) Invited people only  (•) Request → approval  ( ) Instant

Domains for this customer            contoso.com ✓ DNS-verified   contoso.co.uk (declared)
                                     → managed in Organization › Domains

Pending requests (3)                 → list below, Approve / Deny
```

Default values (Claude's call; partner default → org override per settings rule 3):

| Setting | Default for new orgs | Why |
|---|---|---|
| Email + password | on | Today's behaviour, nothing breaks |
| Microsoft / Google sign-in | off | Needs a verified tenant or domain first |
| Self-registration | off | Opt-in; it exposes a public request form |
| New-person policy for SSO | Request → approval | A safe default that still removes the per-person invite |
| Require SSO | off | Turned on deliberately, after the MSP sees how many logins it would strand |

## 5. Design

### 5.1 Identity model: `portal_user_identities` (decided: new table, single source of truth)

```
portal_user_identities
  id uuid pk
  org_id uuid not null            -- shape 1, breeze_has_org_access(org_id)
  portal_user_id uuid not null    -- composite FK (portal_user_id, org_id) → portal_users(id, org_id) DEFERRABLE INITIALLY IMMEDIATE, ON DELETE CASCADE
  provider text not null          -- 'entra' | 'google'  (CHECK; extensible to 'oidc:<provider_id>' later)
  issuer_tenant text not null     -- Entra tid | Google hd
  subject text not null           -- Entra oid | Google sub
  email_at_link text              -- the address that justified the link (audit only)
  linked_via text not null        -- 'jit' | 'invite_match' | 'scim' | 'migrated' | 'manual'
  last_used_at timestamptz
  created_at timestamptz not null default now()
  unique (provider, issuer_tenant, subject)
  unique (portal_user_id, provider)   -- one Microsoft and one Google identity per login
```

- The W2 migration backfills it from `portal_users.entra_tenant_id/entra_oid`. `clientAiExchange` then reads and writes identities instead of the columns. The columns stop being read in W2 and are dropped in a later cleanup migration, so there is never a period where both are read for auth decisions (anti-goal).
- `portal_users.auth_method` is narrowed to mean **"has a password credential"** (`password`) versus **"identity-only"** (`entra`, or the new value `sso`). Its security role from #5471, where an identity-only row can never use password login, reset or accept-invite, is preserved. The session middleware stops refusing non-password rows. Instead it accepts a session minted by either path, and the session records `method: 'password'|'entra'|'google'`.
- Org move, merge, cascade and export registration: `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry` (repoint), and `CORE_TENANT_EXPORT_POLICY` (subject and tenant are identifiers, so classify as exported; there is no json).

### 5.2 Access policy: `portal_access_policies` (partner default + org override)

Partner-wide first (#2135): `org_id` XOR `partner_id`. Columns are the toggles in §4:
`password_enabled`, `entra_enabled`, `google_enabled`, `self_registration_mode`
(`off|approval|instant`), `sso_new_person_mode` (`invited_only|approval|instant`),
`require_sso`, and `sso_session_max_hours`. Every column is nullable on the org row
(null = inherit). There is **one resolver**, `resolvePortalAccessPolicy(orgId)`,
which returns the effective values plus a `source` per field for the UI. It
follows the 7-step partner-wide playbook (write gate `canManagePartnerWidePolicies`,
SELECT-only partner read branch, tests, and a repo-wide `.orgId` sweep).

Settings rule 9 statement for the PR: home = org settings › Portal ›
Sign-in & registration (org level) and partner settings › Customer portal (partner
default); resolver = `resolvePortalAccessPolicy`; places configured before = 0, after = 2
(one per level).

### 5.3 Domains: one list, with a verification state

`customer_email_domains` stays the **single** list of a customer's domains. Inbound email
routing, Entra address trust (F6) and now portal registration all read it. Changes:

- Add `verification_token`, `verified_at` and `verified_method` (`dns_txt | m365_tenant | google_workspace`).
  A domain is *verified* when any of these holds:
  1. A DNS TXT record `breeze-verification=<token>` has been seen, reusing the `sso_verified_domains` checker.
  2. The domain is a verified domain of the org's proven Entra tenant (§5.5).
  3. The domain equals `google_workspace_connections.customer_domain` for a working connection.
- **The UI home moves** from Ticketing › Inbound email to **Organization › Domains**
  (one card on the org record). The Ticketing card becomes a read-only summary with a link.
  That satisfies rule 1 because the concept is no longer ticketing-only. Removal plan:
  `CustomerDomainsCard` editing is deleted in the same wave, and the old URL redirects.
- **Cross-partner rule:** `(partner_id, domain)` uniqueness stays for declared domains.
  A domain can be **verified** for at most one org platform-wide (a partial unique index on
  `domain WHERE verified_at IS NOT NULL`). Verifying a domain that another partner has
  only declared is allowed and wins. The loser's declared row is kept for mail routing
  but is ignored for registration.

What each method needs:

| Method | Domain requirement |
|---|---|
| Self-registration, approval | declared domain (a human approves) |
| Self-registration, instant | **verified** domain |
| Microsoft / Google sign-in, any mode | proven tenant (§5.5), or a verified `hd` domain (§5.6) |

### 5.4 Invite from contacts (G1)

- `POST /organizations/:id/portal-users/invite` accepts an optional `contactId`. When it is
  given, the login binds to that contact directly. This skips `linkLoginToContact`'s
  email resolution and removes `ambiguous` for this path. The contact must be in the
  same org, which the composite FK enforces anyway. Email defaults to the contact's.
- New `POST /organizations/:id/portal-users/invite-contacts { contactIds[] }` invites a
  batch, capped (say 200 per call), and returns a per-contact outcome (`invited`, `already_active`,
  `no_email`, `email_in_use_by_other_contact`).
- Contacts UI (org record › Contacts): a **Portal** column (none / invited / active /
  disabled / pending approval), a row action *Give portal access* / *Resend invite*, a
  bulk *Give portal access* on selection, and a *Give portal access* checkbox on contact create.
- **Invite email adapts.** If the org has Microsoft or Google sign-in on and the invitee's
  domain is covered, the email says "Sign in with Microsoft/Google" and links to the
  login page, not set-password. With `require_sso`, no password link is ever sent.

### 5.5 Sign in with Microsoft (G3)

- **App registration:** reuse the AI for Office multi-tenant app (`CLIENT_AI_ENTRA_CLIENT_ID`),
  so one customer admin consent covers both. Add a *Web* redirect
  `<PORTAL_URL>/api/v1/portal/auth/oidc/entra/callback` and a confidential credential (a new
  env var, e.g. `CLIENT_AI_ENTRA_CLIENT_SECRET`, or a certificate). Scopes are `openid profile
  email`. Self-hosters add the redirect and the secret to their existing registration;
  hosted uses LanternOps' registration. *(Quorum question Q1: reuse or a separate app.)*
- **Generalize the tenant mapping.** `client_ai_tenant_mappings` becomes the org's
  *Microsoft tenant* (rename at the code level; the table can keep its name). It is
  readable without `ai_for_office_enabled`, and the portal sign-in gate is
  `portal_access_policies.entra_enabled`, not the AI flag.
- **Proof of tenant (new).** A mapping counts as *proven* only when one of these holds:
  - (a) an `m365_connections` row for that org has a consent-verified `tenant_id` equal to it, or
  - (b) the admin-consent callback, carrying a signed `state` that names the org, returns
    `tenant=<tid>&admin_consent=True` and records `proven_at` on the mapping.
  An unproven, hand-typed mapping keeps working for AI for Office as today (no regression).
  It **cannot** enable portal sign-in. This closes "MSP squats a tenant id" for the portal.
- **Flow:** standard OIDC authorization code + PKCE + nonce against `/organizations`.
  The id_token is verified with the existing `clientAiEntraJwt` logic (JWKS, aud,
  `iss == …/{tid}/v2.0`). The org comes from `tid` → proven mapping. If there is no
  mapping, the mapping is unproven, or `entra_enabled` is off, show a generic
  "Your organization isn't set up for Microsoft sign-in here. Ask your IT provider."
- **Finding the login, in this order:**
  1. An identity `(entra, tid, oid)` exists → that login. If its org ≠ the mapped org, deny (the existing `org_mismatch`).
  2. Else, exactly one portal user in the org has `lower(email) =` a **trusted address**
     (the F6 rule: UPN, or email with `xms_edov=true`, *and* the domain verified or declared for the org) →
     link it (`linked_via='invite_match'`) and activate it if it was `invited`.
  3. Else, apply `sso_new_person_mode`: `invited_only` → deny with "ask your IT provider for access";
     `approval` → create login `status='pending_approval'` + identity, show "Request sent";
     `instant` → create it active. New logins run `linkLoginToContact` (contact created if none).
- Customer-side scoping without code: docs tell the customer admin to set
  *Assignment required* on the Breeze enterprise app in Entra, so only assigned
  users or groups can get a token. Group scoping in Breeze itself comes with SCIM (W7).

### 5.6 Sign in with Google (G4)

- **New Google OAuth client** (web) per deployment: `PORTAL_GOOGLE_CLIENT_ID` and `_SECRET`,
  scopes `openid email profile`. Hosted uses LanternOps' client; self-hosters bring their own.
- **The org comes from the `hd` claim only.** Personal Gmail (no `hd`) is always refused.
  `hd` must equal a **verified** domain of exactly one org (§5.3: DNS TXT or the Workspace
  connection domain) with `google_enabled`. A declared-only domain is not enough, because
  Google sign-in otherwise lets any MSP pull a domain's users into its portal.
- The id_token is verified with `jose` against Google's JWKS (iss `https://accounts.google.com`,
  aud, nonce), and `email_verified` must be true.
- Login resolution is the same three steps as §5.5, using `(google, hd, sub)` and `email`.

### 5.7 Self-registration by email domain (G2)

- The portal login page gets a **Request access** link (shown only when the deployment has
  any org with self-registration on; it is never org-specific on the shared host). On an org's
  verified custom domain, it is shown only if *that* org has it on.
- Flow:
  1. The person enters name + email.
  2. The response is always the same: "If this address can request access, we've emailed a link."
  3. In the background, the domain is matched exactly to one org with
     `self_registration_mode != off`, honouring the domain requirement in §5.3. On the
     shared host, a domain that matches more than one org (across partners) is treated as no match.
  4. If there is a match and no active login exists for that email in that org, a 30-minute
     single-use verification link is emailed (a Redis token, the same pattern as invite).
     If a login already exists, a "you already have access — sign in / reset password"
     email is sent instead. Nothing is revealed on screen.
  5. Opening the link proves the mailbox.
     - `approval` → create `status='pending_approval'`, `registration_source='self'`, and show "Your request is with <MSP name>".
     - `instant` → create `invited`, and land on set-password (or "Sign in with Microsoft/Google" when `require_sso`).
- Abuse controls: per-IP, per-email and per-domain-per-day limits, plus a cap on pending
  requests per org (oldest auto-expire after 14 days). Bot protection is not in the portal
  today (F11). Builder's call whether to add Turnstile here; per-domain limits are mandatory.

### 5.8 Approval queue

- `portal_users.status` gets a CHECK constraint (`active | invited | pending_approval | disabled`)
  and a new `registration_source` (`invite | contact_invite | self | entra | google | scim`).
  Login already refuses anything that isn't `active`, so a pending row cannot sign in.
- MSP surfaces:
  - a **Pending requests** list at the top of the org's portal users (Approve / Deny, bulk);
  - a partner-wide count in the existing notification channel ("3 portal access requests across 2 customers");
  - an MSP-side audit for every decision.
- Approve → `active`. For SSO-origin rows, the person can sign in immediately; self-registered rows get a set-password email. Deny → row deleted and the requester emailed a neutral "your request wasn't approved".
- New audit actions: `organization.portal_user.approve`, `.deny`,
  `portal.auth.self_register.request`, `.verify`, `portal.auth.oidc.login` (provider in details),
  `portal.auth.identity.link`.

### 5.9 Require SSO and leavers (G6, G7)

- **Require SSO** (only settable when Microsoft or Google is on): password login,
  forgot-password and accept-invite all refuse that org's users with the same generic error as a bad
  password. Turning it on shows a count first: "12 logins have no Microsoft/Google identity yet.
  They will be able to sign in with Microsoft only if their address matches." Their
  passwords are cleared and the epoch is bumped (sessions die) when the setting is saved.
- **SSO session cap:** SSO-minted portal sessions have an absolute lifetime of
  `sso_session_max_hours` (default 12) on top of today's sliding 24h, then go back
  through the IdP (silent if the IdP session is alive). An IdP-disabled account therefore loses access within the cap.
- **Directory deprovisioning (no SCIM needed):**
  - Entra: after each `m365_users` sync for an org with a proven tenant, any portal login whose
    Entra identity `oid` is `account_enabled=false`, or missing for two consecutive successful syncs, is
    set `disabled` (epoch bumped, audit `organization.portal_user.deprovision`, source `m365_sync`).
  - Google: the same, on a daily job over `google_workspace_connections` using the
    Directory API's `suspended`/deleted state.
  - Re-enabling in the IdP does **not** auto-reactivate. The MSP reactivates.
- **SCIM (W7, absorbs #8278):** a per-org SCIM 2.0 endpoint (`/scim/v2/…`, Users; Groups
  optional for scoping), with a bearer token minted on the org's Sign-in card and stored hashed
  (rotatable). The Entra enterprise app (the same one as §5.5) pushes create, update and deactivate.
  `externalId` = Entra `oid`, which writes `portal_user_identities` with `linked_via='scim'`.
  Deactivate or delete → `disabled`. SCIM-created logins are `active` and identity-only.

## 6. Security invariants (each needs a test)

1. A sign-in never lands in an org other than the one resolved from a **proven** tenant or a **verified** `hd` domain.
2. An identity row's org always equals its login's org (composite FK), and a token whose tenant maps to org A can never use a login in org B.
3. Linking to an existing login happens only on an IdP-vouched address (UPN / `xms_edov` / Google `email_verified` + `hd`) in the resolved org, and only when exactly one login matches.
4. Self-registration and the login page return byte-identical responses for eligible, ineligible, existing and unknown addresses.
5. `pending_approval`, `invited` and `disabled` logins cannot mint a session by any path (password, Entra, Google, add-in).
6. `require_sso` makes every password-path endpoint fail for that org, and saving it kills existing password sessions.
7. Deprovisioning and SCIM deactivate bump `auth_epoch` and purge Redis sessions (browser and add-in).
8. A partner can verify a domain or prove a tenant only through DNS, admin consent, or a working connection, never by typing it.

## 7. Waves

| Wave | Scope | Depends on | Risk |
|---|---|---|---|
| W1 | Invite from contacts (§5.4 minus the SSO email variant): `contactId` on invite, batch invite, Portal column + actions on Contacts | — | Low |
| W2 | Foundations: `portal_user_identities` + backfill + switch `clientAiExchange` to it; `portal_access_policies` + resolver + Sign-in card (password-only options live); `status` CHECK + `registration_source`; approval queue UI/API; session middleware accepts identity sessions | — | **High** (auth, migration, add-in) |
| W3 | Domains: verification columns + DNS check, move UI home to Organization › Domains, cross-partner verified uniqueness | W2 | Medium |
| W4 | Sign in with Microsoft: tenant proof, OIDC flow, login resolution, invite email variant | W2, W3 | **High** |
| W5 | Self-registration by domain | W2, W3 | **High** (public, unauthenticated) |
| W6 | Sign in with Google | W2, W3 | **High** |
| W7 | Require SSO + SSO session cap + directory deprovisioning (Entra via `m365_users`, Google via Directory API) | W4 or W6 | High |
| W8 | Entra SCIM (#8278) | W4 | High |

W1 can ship immediately and independently. W4, W5 and W6 can run in parallel after W3.

## 8. Docs

- Customer-facing: "Getting your team into the portal" (one page per method, plus Entra
  *Assignment required* and SCIM setup).
- Self-hoster: new env vars, the extra redirect URI on the existing Entra app, and creating a Google OAuth client.
- MSP: the Sign-in & registration card, domains and verification, and the approval queue.

## 9. Open questions for quorum / Todd

- Q1. Reuse the AI for Office Entra app for portal sign-in (one consent) or register a separate portal app (cleaner blast radius, a second consent)? Default: reuse.
- Q2. Approval-queue rows in `portal_users` (status `pending_approval`) versus a separate `portal_access_requests` table. Default: `portal_users`, because self-registration only creates a row after mailbox proof.
- Q3. Move the domain UI home from Ticketing to Organization › Domains (§5.3). Default: move.
- Q4. Default `sso_new_person_mode` = approval (safe) versus instant (frictionless for internal IT). Default: approval at partner level, so an internal-IT partner flips it once.
- Q5. Does Require SSO also block the AI for Office add-in's password-less rows? Not applicable: those are already identity-only. Listed so nobody re-asks.

## 10. Left to the builder

Exact route paths, env var names, migration file names (after the newest on main), UI copy
and layout within the card, rate-limit numbers, whether to add Turnstile, notification channel
wiring, and whether deprovisioning runs inline after sync or as its own BullMQ job.
