# Customer Portal — Onboarding & Invite Flow

**Date:** 2026-07-07
**Status:** Design approved, pending spec review
**Branch:** `feat/portal-customer-onboarding`

## Problem

The customer portal (`apps/portal`, served under `/portal`) is fully built and released
(image published to GHCR by `release.yml`), but its **logged-in customer onboarding is
incomplete**, which blocks deploying it to production as a usable feature:

1. **No accept-invite endpoint.** The portal UI ships `AcceptInviteForm.tsx`, which POSTs
   to `/portal/auth/accept-invite`, but that route is **not mounted** on the API
   (`apps/api/src/routes/portal/auth.ts` has only `login`, `forgot-password`,
   `reset-password`, `logout`). The invite page is dead.
2. **No MSP-side way to invite a portal user.** Portal accounts (`portal_users`) are only
   ever auto-created via inbound-email→ticket (`services/inboundEmail/resolveOrg.ts`,
   `status='active'`, `password_hash=NULL`) and Excel add-in SSO (`routes/clientAi/auth.ts`).
   There is no dashboard action for a tech to invite a customer contact. The existing
   `OrgPortalSettingsEditor.tsx` only toggles portal *features*, not users.
3. **Forgot-password link points at the wrong app.** `/portal/auth/forgot-password` builds
   its reset URL from `DASHBOARD_URL`/`PUBLIC_APP_URL` as `${base}/reset-password`, i.e. the
   **MSP** dashboard's reset page, not the portal's `/portal/reset-password`. The one
   self-serve way in is broken.

Net effect: a customer whose email was captured can't actually get into the portal, and
there is no way to invite one. Public (no-login) surfaces — emailed quote viewing/e-sign and
invoice pay-online — work; the logged-in experience does not.

## Goals

Make logged-in customer onboarding work end-to-end, with **fuller** MSP-side management:
- A customer can accept an invite, set a password, and land logged in.
- A tech can invite customers to the portal from the dashboard, resend invites, edit basic
  profile fields, disable/reactivate, and remove users; and bulk-invite the pre-existing
  auto-created "pending setup" contacts.
- The forgot-password (and invite) links resolve to the portal.

## Non-goals

- Portal custom-domain / visual branding (separate domain-verification project).
- Portal SSO beyond the existing Entra (AI-for-Office) path.
- Notification preferences beyond the existing `receive_notifications` toggle.
- Deploying the portal to production — a separate, already-scoped rollout step (this work
  makes `PUBLIC_PORTAL_URL` load-bearing, so setting it is part of that rollout).

## Architectural decision: invite token storage

**Chosen: Redis + in-memory fallback**, reusing the exact pattern the portal already uses for
password-reset tokens (`PORTAL_REDIS_KEYS`, SHA-256-hashed token value, TTL, dev-only
in-memory `Map`). A new `inviteToken` key namespace with a **7-day TTL**. Revoking an invite
deletes the key.

Rejected:
- **DB `portal_invites` table** — durable/queryable but adds schema, RLS, and a cleanup job
  for no benefit here.
- **Stateless signed JWT** — no storage, but cannot be revoked before expiry, which defeats
  the "Revoke invite" requirement.

## Data model

`portal_users.status` (already `varchar(20)`, default `active`) formalizes a 3-value model:

| status | meaning | can log in? |
|---|---|---|
| `invited` | invited, no password yet, awaiting acceptance | no (auth rejects non-`active`) |
| `active` | normal account | yes (if `password_hash` set) |
| `disabled` | blocked by a tech | no |

No enum migration needed — the column is a varchar, and `portal/auth.ts` already rejects any
`status !== 'active'` at both login and the auth middleware, so `invited`/`disabled` are
enforced for free.

**Migration** (`apps/api/migrations/2026-07-07-portal-user-invites.sql`, idempotent):
- `ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id)`
- `ADD COLUMN IF NOT EXISTS invited_at timestamptz`

`portal_users` already has org-scoped RLS (shape 1, direct `org_id`); adding columns needs no
new policy. No RLS-coverage allowlist change.

**Effective display status.** The pre-existing auto-created contacts are `status='active'`
with `password_hash=NULL` and cannot actually log in. The list endpoint computes an effective
state so these read as **"Pending setup"** rather than a misleading "Active":

```
disabled                       -> "Disabled"
password_hash IS NULL          -> "Pending setup"   (covers invited + auto-created no-pw)
else                           -> "Active"
```

## Customer-facing portal API (`apps/api/src/routes/portal/`)

### New: `POST /portal/auth/accept-invite`
Body `{ token, password, name? }` (new `acceptInviteSchema` in `portal/schemas.ts`).
Flow, mirroring `reset-password` + `login`:
1. Rate-limit by IP + token (reuse `checkRateLimit`).
2. `isPasswordStrong(password)` gate.
3. Look up + consume the invite token (Redis `inviteToken(hash)` / in-memory), yielding
   `portalUserId`. Invalid/expired → 400.
4. Under `withSystemDbAccessContext`: set `password_hash`, `name` (if provided and not already
   set), `status='active'`, `updated_at`. Guard: if the row is already `active` **with** a
   password, treat the token as spent (400) — an invite can't hijack a live account.
5. Mint a session exactly like `/login` (Redis session + cookies + `lastLoginAt`), return
   `{ user, accessToken, expiresAt, tokens }`.

This activates the existing `AcceptInviteForm.tsx` (already wired to this path).

### Fix: portal link base
New helper `buildPortalUrl(path: string): string` (in `portal/helpers.ts`):
`(PUBLIC_PORTAL_URL || `${DASHBOARD_URL || PUBLIC_APP_URL}/portal`)` normalized, no double
slash. Used by:
- `forgot-password` → `buildPortalUrl('/reset-password?token=...')`
- new invite email → `buildPortalUrl('/accept-invite?token=...')`

Add `PORTAL_REDIS_KEYS.inviteToken(hash)` and `INVITE_TTL_MS`/`INVITE_TTL_SECONDS`
(7 days) + a dev `portalInviteTokens` map with cap, mirroring `portalResetTokens`.

## MSP-facing API — new `orgPortalUsers.ts`

A new route module registered on `orgRoutes` (inherits `authMiddleware`), mirroring
`orgPortalSettings.ts` gating precisely: `requireScope('partner','system')`, reads
`requirePermission(ORGS_READ)`, writes `requirePermission(ORGS_WRITE)` + `requireMfa()`,
`resolveAccessibleOrg(c)` for org access + existence (404 on cross-tenant), `writeRouteAudit`
on every mutation. Writes run under the request's RLS context; `portal_users` org RLS admits
partner-scoped techs for their accessible orgs.

| Method + path | Body | Behavior |
|---|---|---|
| `GET /organizations/:id/portal-users` | — | List: id, email, name, effective status, lastLoginAt, receiveNotifications, invitedAt. |
| `POST /organizations/:id/portal-users/invite` | `{email, name?, message?}` | Find-or-create row (`invited` if new; existing pending/no-pw reused). Mint invite token, email link. Sets `invited_by`/`invited_at`. Re-invite = re-issue. 409 if the email is already an active account with a password. |
| `POST /organizations/:id/portal-users/bulk-invite` | `{userIds?: string[]}` | Invite selected (or all) "Pending setup" contacts. Returns per-user results. |
| `PATCH /organizations/:id/portal-users/:userId` | `{name?, receiveNotifications?, status?}` | Edit profile + `disabled`⇄`active` transitions. `status` limited to `active`/`disabled` here (not `invited`). |
| `POST /organizations/:id/portal-users/:userId/resend-invite` | — | Re-mint + re-send. 409 if already an active account with a password. |
| `DELETE /organizations/:id/portal-users/:userId` | — | Hard-delete **only if** the user has no `tickets.submitted_by` / `ticket_comments.portal_user_id` / `asset_checkouts.checked_out_to` references; otherwise **409 "disable instead"** (preserves audit history). |

New email method `emailService.sendPortalInvite({ to, inviteUrl, orgName, inviterName?, message? })`
in `services/email.ts`, following the existing `sendPasswordReset` shape and `renderButton`.

## Web UI — new `OrgPortalUsersEditor.tsx`

Rendered in Org Settings → Portal tab (`OrgSettingsPage.tsx`), alongside
`OrgPortalSettingsEditor`. A table (email, name, status badge, last login) with:
- **Invite** modal: email, name (optional), optional message.
- Row actions: **Resend**, **Disable/Reactivate**, **Revoke/Remove**.
- Bulk **"Invite pending contacts"** action over the "Pending setup" rows.

Every mutation wrapped in `runAction` (`apps/web/src/lib/runAction.ts`) per the repo rule, so
success/failure always surfaces; 401 defers to the auth redirect. New client methods in the
web API client for the endpoints above.

## Validators (`packages/shared`)

- `acceptInviteSchema` — `{ token: string, password: string (min per policy), name?: string }`
- `invitePortalUserSchema` — `{ email: email, name?: string, message?: string (max ~1000) }`
- `bulkInvitePortalUsersSchema` — `{ userIds?: string[] }`
- `updatePortalUserSchema` — `{ name?, receiveNotifications?, status?: 'active'|'disabled' }`

## Error handling

- Invalid/expired/reused invite token → 400 (generic message; no account enumeration).
- Invite for an already-active-with-password email → 409 with a clear message.
- Cross-tenant org access → 404 (matches `orgPortalSettings`).
- `DELETE` on a referenced user → 409 "disable instead".
- Email-send failure on invite → the invite row + token still persist; endpoint returns a
  soft warning so the tech can Resend (don't 500 the whole action). Logged.
- `PUBLIC_PORTAL_URL` unset → `buildPortalUrl` falls back to `${DASHBOARD_URL}/portal`;
  if no host is derivable, log a warning (mirrors `quoteLifecycle` guard) rather than emit a
  hostless link.

## Testing (per `breeze-testing`)

**API (Vitest + Drizzle mocks / integration where RLS matters):**
- `accept-invite`: valid token → active + session issued; expired token → 400; reused token →
  400; already-active-with-password → 400; weak password → 400.
- `forgot-password`: reset link uses the portal base (`/portal/reset-password`), not the MSP app.
- `orgPortalUsers`: invite creates `invited` row + token + email; list returns effective
  status; PATCH disable blocks login; resend re-issues; bulk-invite covers pending only;
  DELETE 409 when referenced, 200 when clean; auth gating (missing perm 403, cross-org 404).
- One integration test proving RLS: a partner-scoped tech can invite/list only within
  accessible orgs.

**Web (Vitest + jsdom):**
- `OrgPortalUsersEditor`: list renders with status badges; Invite calls the endpoint via
  `runAction`; failure surfaces a toast; disable/revoke call through.

**Shared:** zod schema coverage for the four new schemas (valid + boundary + reject cases).

## Rollout / deployment tie-in

This makes `PUBLIC_PORTAL_URL` load-bearing for portal emails. The held production rollout
(add the `portal` service + `/portal` Caddy block on both droplets) must also set
`PUBLIC_PORTAL_URL=https://us.2breeze.app/portal` (and `eu.`) in the API env. Tracked with the
deploy step, not this PR.

## Files touched (summary)

- `apps/api/migrations/2026-07-07-portal-user-invites.sql` (new)
- `apps/api/src/routes/portal/auth.ts` (accept-invite, forgot-password link fix)
- `apps/api/src/routes/portal/schemas.ts` (invite token keys/TTL, acceptInviteSchema)
- `apps/api/src/routes/portal/helpers.ts` (`buildPortalUrl`, invite token map)
- `apps/api/src/routes/orgPortalUsers.ts` (new) + registration next to `orgPortalSettings`
- `apps/api/src/services/email.ts` (`sendPortalInvite`)
- `packages/shared/src/validators/*` (four schemas)
- `apps/web/src/components/settings/OrgPortalUsersEditor.tsx` (new) + `OrgSettingsPage.tsx`
- Web API client method additions
- Co-located test files for each of the above
