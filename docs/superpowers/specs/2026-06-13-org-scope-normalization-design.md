# Org-Scope Normalization — Design

**Date:** 2026-06-13
**Branch:** `fix/org-scope-normalization`
**Status:** Design (pending implementation plan)

## Framing

This is **not** new architecture or added complexity. It clarifies the model the schema
already implies and closes the one RLS gap that clarification opens:

- Nullable `org_id` + system flags already make "a record not tied to one org" representable;
  we make that choice **explicit and visible** in the UI.
- The org selector already exists; we make it **page-aware** instead of a confusing extra pill.
- The only genuinely new element is `partner_id` — and that exists solely to keep `org_id NULL`
  ("available everywhere") records tenant-safe. That column **is** the RLS-gap fix, not extra
  scope.

## Problem

Modules are inconsistent about how they respond to the app-shell org selector. Some
surfaces narrow to the selected org when they shouldn't (Scripts show different results
per selected org); some are partner-wide but the UI implies otherwise (Update Rings,
Patch Approvals). The root cause is a **global Current/All-orgs pill** (PR #985, contributor
Billy Dunn) that imposes an all-or-nothing `orgId` filter on *every* page via the
`fetchWithAuth` injection chokepoint, with individual pages opting out ad-hoc using
`skipOrgIdInjection: true`. There is no single rule for when a page should narrow, so
behavior has drifted.

The contributor's stated intent (#985) was "one global control that every list page
honors," explicitly treating partner-wide pages (`/patches`, `/security/*`) as a
*temporary gap* to be closed later. The actual requirement is the opposite: certain
catalog/library surfaces are **intentionally partner-wide** and must not narrow.

## Key insight from the IA inventory

A full inventory of ~50 nav destinations shows the app is **already ~90% correctly
org-scoped** (`org_id NOT NULL` tables: devices, alerts, tickets, incidents, all of
Security/Operations/Reporting, nearly all Settings). The inconsistency is concentrated
in a small set of **catalog surfaces whose schema already allows a record to be
un-tied to one org** (nullable `org_id` and/or a system flag):

| Surface | Table | Ownership cols today |
|---|---|---|
| Scripts | `scripts` | `org_id` nullable, `is_system` |
| Script categories | `script_categories` | `org_id` nullable |
| Script tags | `script_tags` | `org_id` nullable |
| Alert templates | `alert_templates` | `org_id` nullable, `is_built_in` |
| Update rings | `patch_policies` | `org_id` **NOT NULL** (org-bound) |
| Software/patch catalog | `software_catalog`, `patches` | no `org_id` (already global, read-only) |

A full Global-vs-Org nav re-org is therefore overkill. The fix is a **focused, reusable
pattern**, not a restructure.

## The rule

> **Scope is an explicit, visible property of each catalog record — not something the
> app-shell imposes on the page.** A catalog record is *partner-wide* ("available to all
> my organizations"), *org-specific*, or *system*. The org selector becomes **page-aware**:
> it reflects the page you're on instead of fighting the records it shows.

Test for any future page: *does this answer "what's the state of my fleet?" (→ org-scoped,
honors selector) or "what's in my catalog / what tools have I configured?" (→ global,
ignores selector)?* The `routeScope` map (below) records the answer once per route.

## Components

### 1. Data model (migration)

Add `partner_id uuid REFERENCES partners(id)` to: `scripts`, `script_categories`,
`script_tags`, `alert_templates`.

A catalog row is exactly one of:

- **Partner-wide:** `partner_id` set, `org_id NULL`, system-flag false → usable across all
  orgs under that partner. This is the "create with no org → use everywhere" case.
- **Org-specific:** `org_id` set, `partner_id` populated (denormalized from the org's
  partner for RLS), system-flag false → that customer only.
- **System:** system-flag true (`scripts.is_system` / `alert_templates.is_built_in`),
  `org_id NULL`, `partner_id NULL` → platform-provided, all partners. Unchanged.

**Why `partner_id` is non-negotiable (not just a UI label):** a row with `org_id NULL` and
no partner axis is a tenant-isolation hole — RLS cannot tell which partner owns it, so one
partner's "global" script would be visible to another. This is the exact dual-axis trap hit
on `custom_field_definitions` (shipped org-only policies, route wrote `org_id NULL`
partner-wide rows → 42501 + cross-tenant risk). "Everywhere" must mean "everywhere within
my partner."

**RLS policy** for each table (partner-axis + org-axis + optional system branch), in the same
migration that adds the column. The system branch is **per-table** — only tables that have a
system flag include it: `scripts` → `OR is_system`, `alert_templates` → `OR is_built_in`,
`script_categories` and `script_tags` → **no system branch** (they have no system flag):

```
USING (
  breeze_has_partner_access(partner_id)
  OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
  [OR <table's system flag, if any>]
)
```

- Migration is hand-written, idempotent (`ADD COLUMN IF NOT EXISTS`, `pg_policies`
  existence checks), no inner `BEGIN/COMMIT`.
- **Backfill** `partner_id` from the owning org for existing org-specific rows, wrapped in
  `DO $$ ... GET DIAGNOSTICS n = ROW_COUNT; RAISE WARNING ... $$` for the forensic trail.
  System rows keep `partner_id NULL`.
- Add these tables to the partner-axis / dual-axis allowlist in
  `rls-coverage.integration.test.ts` (`PARTNER_TENANT_TABLES`) **in the same PR**.

### 2. Visibility & permissions

- **Partner user** sees: partner-wide (own partner) + org-specific (accessible orgs) +
  system.
- **Org user** sees: own org's org-specific + own partner's partner-wide + system. Org users
  may **execute** partner-wide records but **cannot edit/delete** them (those belong to the
  MSP). Org-specific records remain editable with the appropriate permission. System records
  are read-only for everyone but platform.
- **Create flow:** partner staff get *"Available to: ⦿ All my organizations (partner-wide) /
  ○ Specific organization [picker]"*, defaulting to all-orgs. Single-org users get no choice
  — always their org.

### 3. Page-aware selector (replaces the pill)

- New central `routeScope` map (web): path-pattern → `'global' | 'scoped'`, single source of
  truth. Catalog routes (`/scripts*`, `/patches*`, update-rings, alert-templates) are
  `global`; everything else defaults to `scoped`.
- The **org dropdown becomes the only control**; the separate Current/All pill and the
  `orgScope: 'current' | 'all'` store field are removed. "All Organizations" becomes the top
  item of the dropdown.
- On a `global` route the dropdown displays "All Organizations" and the registered org-id
  provider returns `null` regardless of the stored org selection; on a `scoped` route it uses
  the remembered org pick. The user's last org choice persists across global pages.
- `fetchWithAuth` injection follows the route class automatically (provider returns `null` on
  global routes). The ad-hoc `skipOrgIdInjection: true` call-site sprinkling is removed in
  favor of this central rule. (`skipOrgIdInjection` may remain as an escape hatch but is no
  longer the mechanism.)

### 4. Patches (no migration)

Update Rings stay org-bound (`patch_policies.org_id NOT NULL`). The list **aggregates across
accessible orgs** and returns each ring's `orgId`. The Patches/Approvals/Compliance routes are
`global` class — patch org is **derived from the selected update ring**, not the shell
selector. The backend ring-org resolution already implemented on this branch
(`patches/helpers.ts`, `approvals.ts`, `compliance.ts`, `updateRings.ts`) is correct and is
retained.

## Data flow

1. User loads a route. The web shell looks up the route in `routeScope`.
2. `global` route → org-id provider returns `null` → `fetchWithAuth` injects no `orgId` →
   backend returns across all accessible orgs (filtered by RLS to the caller's partner/orgs).
3. `scoped` route → provider returns the selected `currentOrgId` → `fetchWithAuth` injects
   `?orgId=` → backend narrows (within accessible set).
4. Catalog list queries union: partner-wide (own partner) ∪ org-specific (accessible orgs) ∪
   system. RLS enforces the same boundary server-side.
5. Patch approvals/compliance resolve `effectiveOrgId` from `ringId` → that ring's `org_id`
   (with `auth.canAccessOrg` check), ignoring the shell selector.

## Error handling

- Cross-partner / cross-org access attempts: RLS rejects writes (`42501`); routes return
  `403` on `!auth.canAccessOrg(...)`.
- Org user attempting to edit a partner-wide or system record: `403` at the route, with the
  UI hiding edit/delete affordances for those rows.
- Migration backfill logs row counts via `RAISE WARNING` even when 0.

## Testing

- **RLS (integration, real DB):** add the four tables to `PARTNER_TENANT_TABLES`; run the
  contract test. **Additionally** add a functional `breeze_app` test that forges a
  cross-partner insert of a partner-wide script and asserts it fails — the contract test alone
  does not catch a missing second axis (the `custom_field_definitions` blind spot).
- **API (unit):** scripts list returns partner-wide + org + system for partner vs org users;
  create as partner-wide vs org-specific; org user 403 on editing partner-wide; patch
  approval/compliance org derived from ring.
- **Web:** `routeScope`-driven selector display ("All Organizations" on global routes, org on
  scoped); `fetchWithAuth` omits/injects `orgId` per route class; scripts create scope picker
  (partner staff sees it, single-org user doesn't); pill removal.
- **Migration:** idempotent re-apply is a no-op; backfill populates `partner_id` correctly.

## Scope legibility & safety (from impeccable critique, 2026-06-13)

A UX critique of the selector scored the build competent (clean slop detector) but flagged
that scope is only legible in the far top-right control and is never reaffirmed at the point
of action — a real safety gap in an RMM where actions touch live customer endpoints. Three
additions make "what's going on" explicit and prevent wrong-tenant mistakes:

1. **Scope-naming confirmations (P0, safety).** Every destructive / fleet-affecting action —
   patch install, patch scan, patch approve, script run, and bulk actions — must surface a
   confirmation that *names the target scope and count* before firing, e.g. "Approve 12 patches
   for **Acme Corp**?" or "Run **Restart-Spooler** on **142 devices** in **Acme Corp**?". Uses
   the existing `apps/web/src/components/shared/ConfirmDialog.tsx`. The org is derived from the
   action's own context (selected ring's org, target device's org), never silently from the
   shell selector.
2. **Page-header scope affordance.** A small, calm indicator in each page header that states the
   page's scope: on global routes "Shared across all organizations"; on scoped routes the active
   org name ("· Acme Corp"). Driven by `routeScope` + the org store. Makes the global-vs-scoped
   rule *visible* rather than inferred from a missing widget.
3. **Scope badges on catalog records.** In catalog lists and detail/edit headers, each record
   shows its scope: `Partner-wide` / `{Org name}` / `System`. Keeps a record's audience visible
   after creation (otherwise the "Available to" choice becomes invisible immediately).

These are calm, on-brand (no loud banners), and consistent with the "calm control,
instantly-scannable" design principles.

## Out of scope (incremental follow-ups)

- Other pages the user may surface later (e.g. Network Discovery). The `routeScope` map +
  scope-as-property pattern make each a small, well-defined change: classify the route, and if
  it needs partner-wide records, add `partner_id` + RLS following this same template.
- A Global-vs-Org nav re-org (deferred; not justified by the current count of global surfaces).

## Implementation note: existing branch changes

The working tree currently holds ~33 uncommitted files from a prior Codex pass. They are
partially aligned (correct backend ring-resolution) but ad-hoc elsewhere (per-call
`skipOrgIdInjection`, pill-hiding rather than page-aware). Before implementing, preserve them
to a patch file, reset to a clean baseline, then reimplement per this spec, cherry-picking the
correct backend ring-resolution logic.
