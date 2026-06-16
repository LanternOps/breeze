# AI for Office — per-partner entitlement

**Date:** 2026-06-15
**Status:** Approved (design)
**Related:** PR #1426 (introduced the build-time `PUBLIC_ENABLE_AI_FOR_OFFICE` nav flag this replaces)

## Problem

AI for Office is a governed Excel/Word/etc. add-in whose AI usage (LLM tokens)
is paid by the platform operator. PR #1426 gated the left-nav entry behind a
**global build-time flag** (`PUBLIC_ENABLE_AI_FOR_OFFICE`), which is all-or-nothing
for an entire instance. That doesn't match the business need: the operator wants
to enable AI for Office **per partner** (and only for partners they choose), so
they aren't paying for every partner's customers' AI use by default.

## Goal

Make AI for Office a **per-partner entitlement that only the platform operator
can grant**. Off by default for every partner. Flippable via API and direct SQL
(matching how partners are managed in prod today — there is no platform-admin UI).
No partner-facing self-enable.

Non-goals: a platform-admin UI (API/SQL only); per-partner spend caps/metering
(the existing `settings.aiBudgets` is untouched and can be a later follow-up);
changes to the existing per-org policy/DLP governance.

## Gating model (three layers, top to bottom)

1. **Instance prerequisite (unchanged):** `CLIENT_AI_ENTRA_CLIENT_ID` env var.
   If unset, the whole feature is dark on that instance — the `/client-ai/admin`
   route group already returns 404 (`apps/api/src/routes/clientAi/admin.ts:42-47`).
2. **Partner entitlement (NEW, operator-controlled):** a partner must be
   explicitly enabled. Off by default. This is the cost gate.
3. **Org policy (unchanged):** `clientAiOrgPolicies.enabled` + DLP remain the
   partner's own finer-grained, per-org governance *within* an enabled partner.

A partner's orgs can only use AI for Office when all three are satisfied.

## Storage

Add a dedicated column to the `partners` table:

```
ai_for_office_enabled boolean NOT NULL DEFAULT false
```

**Why a column, not `settings` JSONB:** `partners.settings` is partner-writable
via `PATCH /orgs/partners/me` (partner scope). Storing the entitlement there would
let a partner enable themselves and defeat the cost gate. A top-level column is
only mutated through the system-scope admin path, so the operator stays in control.

**Migration:** hand-written, idempotent (`ADD COLUMN IF NOT EXISTS`), date-prefixed
per the repo convention. The `partners` table already has partner-axis RLS
(`breeze_has_partner_access(partner_id)`); a new non-tenant-key column inherits the
existing row policies, so no RLS change is required. (Confirm with the
rls-coverage contract test; no new table = no allowlist change.)

## Components & changes

### DB / schema
- `apps/api/src/db/schema/orgs.ts` — add `aiForOfficeEnabled` to the `partners`
  table definition (`boolean('ai_for_office_enabled').notNull().default(false)`).
- `apps/api/migrations/<date>-partners-ai-for-office-enabled.sql` — idempotent
  `ADD COLUMN IF NOT EXISTS`. Use a `YYYY-MM-DD` prefix that sorts **after** the
  latest existing migration (verify against `apps/api/migrations/` at build time;
  the `autoMigrate.test` ordering test must stay green).

### API — operator sets it
- `apps/api/src/routes/orgs.ts` — extend `updatePartnerSchema` (system-scope
  `PATCH /orgs/partners/:id`) with `aiForOfficeEnabled: z.boolean().optional()`,
  mapped to the column in the update set. The existing `partner.update` audit
  event already records `changedFields`, so the toggle is audit-logged for free.
- The partner-scope `PATCH /orgs/partners/me` is **not** changed — partners cannot
  set this field.

### API — server enforcement (the real gate)
- `apps/api/src/routes/clientAi/admin.ts` — extend the group gate
  (`clientAiAdminRoutes.use('*', …)`) so it returns 404 unless
  **both** `CLIENT_AI_ENTRA_CLIENT_ID` is set **and** the caller's partner has
  `ai_for_office_enabled = true`. Load the flag by `auth.partnerId` (single
  indexed lookup; partners are few and the result can be read inside the gate).
  System-scope callers with no `partnerId` are handled explicitly (see Edge cases).

### API — read for the web
- `/orgs/partners/me` already returns the full partner row, so the new column
  rides along automatically — no endpoint change. (Verify the column isn't
  stripped by any response serializer.)

### Web — nav gating
- `apps/web/src/components/layout/Sidebar.tsx` — gate the "AI for Office" nav item
  on the partner's `aiForOfficeEnabled` (read from `/orgs/partners/me`, which the
  Sidebar already fetches for branding) instead of the build-time flag. The
  existing `partnerScopeOnly` check stays.

### Web — retire the build-time flag
- Remove `ENABLE_AI_FOR_OFFICE` from `apps/web/src/lib/featureFlags.ts`.
- Remove `PUBLIC_ENABLE_AI_FOR_OFFICE` from `apps/web/src/env.d.ts`.
- Remove the `PUBLIC_ENABLE_AI_FOR_OFFICE` ARG/ENV from `apps/web/Dockerfile` and
  `docker/Dockerfile.web`.
- The `featureEnabled` NavItem mechanism added in #1426 is **kept** (generic and
  harmless), but the AI-for-Office item no longer uses it; nav gating moves to the
  partner-flag check. (Leave `featureEnabled` in place for future use, or drop it
  if no other item uses it — implementation decides; keeping it is fine.)
- The network-devices flag (`PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST`) from #1426 is
  **untouched**.

## Data flow

```
Operator: PATCH /orgs/partners/:id { aiForOfficeEnabled: true }   (system scope)
          └─ or: UPDATE partners SET ai_for_office_enabled = true WHERE id = …
                         │
                         ▼
              partners.ai_for_office_enabled = true   (audit: partner.update)
                         │
          ┌──────────────┴───────────────┐
          ▼                               ▼
Web: GET /orgs/partners/me        API: /client-ai/admin/* gate
  → partner.aiForOfficeEnabled       → CLIENT_AI_ENTRA_CLIENT_ID set
  → Sidebar shows the nav item          AND partner.ai_for_office_enabled
                                        else 404 (dark)
```

## Edge cases

- **System-scope caller with no `partnerId`** hitting `/client-ai/admin`: the gate
  has no partner to check. Preserve current behavior — system scope is the
  platform operator; do not 404 them solely for lack of a partner flag (they pass
  the instance prerequisite). Decision: gate checks the partner flag only when a
  `partnerId` is present; system callers without one are allowed through the
  partner layer (org-layer policy still applies downstream). This is called out so
  the implementer doesn't accidentally lock the operator out.
- **Partner enabled but instance has no `CLIENT_AI_ENTRA_CLIENT_ID`:** still dark
  (instance prerequisite wins). The operator wouldn't enable a partner on an
  unconfigured instance, but the layering makes it safe either way.
- **Nav shows but server closed (or vice versa):** the server gate is the source
  of truth for cost. The nav check is a UX nicety; an out-of-sync nav can only
  ever lead to a dark page, never to uncontrolled spend.
- **Existing enabled partners at rollout:** column defaults to `false`, so every
  partner starts disabled. If any partner was relying on the just-shipped build
  flag, the operator re-enables them explicitly via SQL/API (expected, since the
  build flag default was also off).

## Testing

- **API gate** (`clientAi/admin` tests): enabled partner → passes; disabled
  partner → 404; `CLIENT_AI_ENTRA_CLIENT_ID` unset → 404; system caller without
  partnerId → not locked out by the partner layer.
- **API update** (`orgs` route tests): system-scope PATCH sets the column;
  partner-scope PATCH cannot (field absent from partner schema); audit event
  records the change.
- **Schema/migration:** `autoMigrate` ordering test stays green; `db:check-drift`
  clean; idempotent re-apply is a no-op.
- **Web** (`Sidebar` tests): nav item shown when `partner.aiForOfficeEnabled` is
  true, hidden when false/absent — replacing the build-flag test from #1426.

## Rollout

Pure additive column + gate; no data backfill. After merge, the operator enables
specific partners via SQL/API. Self-hosted/community instances without
`CLIENT_AI_ENTRA_CLIENT_ID` are unaffected (feature stays dark).
