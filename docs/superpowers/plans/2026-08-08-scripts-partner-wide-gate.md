# Scripts: Partner-Wide Creation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the authz gap where any partner-scoped user — including one with `partner_users.org_access = 'selected'` — can create, edit, or delete a **partner-wide script** that executes as SYSTEM on every endpoint of every organization under the partner.

**Architecture:** Add the existing `canManagePartnerWidePolicies(auth)` capability check to the partner-wide branches of `POST/PUT/DELETE /scripts`, matching the pattern already used by nine other routes. No schema change, no migration.

**Tech Stack:** Hono routes, Drizzle ORM, Vitest.

**Issue:** #3262 · **Epic:** #3249 · **Blocks:** #3245 (script bundle import)

> **✅ SHIPPED** — merged via PR #3263 (commit `42a1b9b84`) plus follow-up PR #3272 (commit `b01681907`, same-partner ownership enforcement on partner-wide writes). Beyond plan scope, the PR also hid the partner-wide toggle in the web UI (`ScriptForm.tsx`) for users lacking the capability. **Deferred:** Task 3's audit of pre-existing partner-wide scripts (a query against the deployment's data, left to the operator per the #3262 thread) and Task 5's sibling-table sweep. Task 6's docs note landed with the migration-docs update on PR #3250.

---

## Context

`apps/api/src/routes/scripts.ts:502-506` gates partner-wide creation on scope alone:

```ts
} else if (auth.scope === 'partner') {
  if (data.availability === 'partner') {
    orgId = null;
    partnerId = auth.partnerId ?? null;
    if (!partnerId) return c.json({ error: 'Partner context required' }, 403);
  }
```

Verified absent from the file: `canManagePartnerWidePolicies` (0 hits), `partnerOrgAccess` (0 hits).

`services/partnerWideAccess.ts` is explicit that scope is not a sufficient proxy:

> *Deliberately NOT derivable from accessibleOrgIds: a 'selected' user whose selection happens to cover every current org still must not administer partner-wide state.*

Reference implementation to copy: `apps/api/src/routes/peripheralControl.ts:508`.

**Severity:** partner-confined (RLS still prevents cross-partner reach), so this is privilege escalation *within* a partner — to SYSTEM-level code execution across orgs the user was never granted.

---

## Task 1: Gate partner-wide script creation

- [x] Import `canManagePartnerWidePolicies` and `PARTNER_WIDE_WRITE_DENIED_MESSAGE` from `../services/partnerWideAccess` in `apps/api/src/routes/scripts.ts`.
- [x] In the `auth.scope === 'partner'` / `data.availability === 'partner'` branch (~line 503), return `403` with `PARTNER_WIDE_WRITE_DENIED_MESSAGE` when `!canManagePartnerWidePolicies(auth)`.
- [x] Place the check **before** `orgId = null` is assigned, so a denied request cannot fall through with partner ownership half-applied.
- [x] Confirm system scope still passes (the helper returns true for `auth.scope === 'system'`).

## Task 2: Gate update and delete of partner-owned scripts

A user who cannot create partner-wide state must not be able to edit or remove it.

- [x] In `PUT /scripts/:id`, after loading the existing row, deny with 403 when `existing.orgId === null && existing.partnerId !== null && !canManagePartnerWidePolicies(auth)`.
- [x] Same in `DELETE /scripts/:id` (soft delete — sets `deletedAt`).
- [x] Leave the existing `isSystem && auth.scope !== 'system'` checks (`scripts.ts:592`, `:760`) intact; these are additive, not replacements.
- [x] Verify the ownership test is `orgId === null`, not `partnerId !== null` alone — an org-owned script also carries `partnerId` as an RLS denormalization (`scripts.ts:500-501`), so keying on `partnerId` would wrongly block ordinary org script edits.

## Task 3: Audit existing partner-wide scripts

- [ ] Query partner-owned scripts and their creators:
  ```sql
  SELECT s.id, s.name, s.partner_id, s.created_by, s.created_at, pu.org_access
  FROM scripts s
  LEFT JOIN partner_users pu
    ON pu.user_id = s.created_by AND pu.partner_id = s.partner_id
  WHERE s.org_id IS NULL AND s.partner_id IS NOT NULL AND s.deleted_at IS NULL
  ORDER BY s.created_at DESC;
  ```
- [ ] Flag any row whose creator has `org_access <> 'all'` — those were created through the gap.
- [ ] Report findings on #3262. Do **not** auto-delete: a legitimate script may have been created by a since-downgraded user. Removal is an operator decision.

## Task 4: Tests

- [x] `scripts.test.ts`: partner scope + `partnerOrgAccess: 'selected'` + `availability: 'partner'` → **403**, and no row is written.
- [x] Partner scope + `partnerOrgAccess: 'all'` + `availability: 'partner'` → 201, `orgId` null, `partnerId` set.
- [x] System scope + `availability: 'partner'` → 201 (unchanged).
- [x] Partner scope + `partnerOrgAccess: 'selected'` + `availability: 'org'` → 201 (org scripts are unaffected — regression guard).
- [x] Update and delete of a partner-owned script by a `'selected'` user → 403.
- [x] Update and delete of an **org-owned** script by a `'selected'` user with access to that org → succeeds (guards the `orgId === null` keying from Task 2).

## Task 5: Sweep for the same gap on sibling dual-ownership tables

The nine routes already using the helper are `accessReviews`, `partnerLoginBranding`, `huntress`, `peripheralControl`, `sensitiveData`, `networkKnownGuests`, `pax8`, `roles`, `sso`. Scripts was missed; others may have been too.

- [ ] Enumerate tables with both a nullable `org_id` and a `partner_id` in `apps/api/src/db/schema/` (the dual-ownership shape from CLAUDE.md's Partner-Wide First section).
- [ ] For each, grep its route file for `canManagePartnerWidePolicies`. Record any table whose partner-wide write path lacks it.
- [ ] File a follow-up issue per gap found rather than expanding this PR — each needs its own audit query and tests.
- [ ] If the sweep finds nothing else, say so explicitly on #3262 so the negative result is recorded.

## Task 6: Revisit the migration-docs guidance

- [x] `apps/docs/src/content/docs/migration/toolkit.mdx` Recipe 6 recommends `availability: "partner"` for bulk script import. Once this gate lands the recommendation is safe, but add a one-line note that partner-wide creation requires full partner org access, so a `'selected'` technician following the recipe gets a comprehensible 403 rather than a mystery.

---

## Verification

- [x] `pnpm --filter @breeze/api test -- scripts` green.
- [ ] Manually: create a partner user with `org_access = 'selected'`, confirm the partner-wide toggle is refused with a clear message.
- [x] No migration in this plan — confirm `pnpm db:check-drift` is unchanged.

## Out of scope

- UI changes to hide the partner-wide option from users who lack the capability. Server-side denial is the security boundary; hiding the control is a follow-up polish item.
- Retroactive removal of scripts created through the gap (see Task 3).
