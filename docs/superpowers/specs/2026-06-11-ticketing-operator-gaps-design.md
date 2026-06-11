# Ticketing Operator Gaps — Portal Settings, Alert→Ticket UI, Category Reorder

**Date:** 2026-06-11
**Status:** Approved design, pending implementation
**Context:** Follow-up to the native ticketing core (PR #1245 and predecessors). An audit of backend-supported ticketing options vs. admin UI found three operator-facing gaps worth closing before Phase 2 (SLA engine). Spec for the design phases: `2026-06-09-native-ticketing-design.md`.

## Scope

Three features, one PR:

1. **Portal settings tab** — write API + org-settings UI for the `portal_branding` feature toggles and support-contact fields (today: read-only API, SQL-only writes).
2. **Alert → create ticket UI** — surface the existing `POST /alerts/:id/create-ticket` endpoint on the alert detail page, plus a linked-tickets view.
3. **Category reorder** — up/down arrow reordering for ticket categories, using the existing `sortOrder` column.

No new tables, no migrations, no new dependencies.

## Scoping principle: partner-level vs org-level

These features land on different settings pages because the underlying tables are scoped differently:

- **Partner-level** (`Settings → Ticketing`, `/settings/ticketing`): ticket categories (`ticket_categories.partnerId`) — including the new reorder control. Numbering sequences and role permissions are also partner-level (permissions under Settings → Roles; numbering deliberately UI-less for v1).
- **Org-level** (per-organization settings page): `portal_branding` is keyed on `orgId` — each customer's portal independently controls ticket submission, support contacts, etc. An MSP can enable tickets for Customer A and not Customer B.

## Feature 1: Portal settings (org settings → Portal tab)

### Why a dedicated endpoint

`portal_branding` is its own table (RLS shape 1, direct `org_id`, unique on `orgId`) — not the `organizations.settings` JSONB that the existing Branding tab PATCHes. Options considered:

- **Dedicated org-scoped endpoints (chosen):** keeps the public portal `routes/portal/branding.ts` purely read-only/pre-auth, and doesn't muddy the JSONB-merge handler in `routes/orgs.ts` with a table upsert.
- Folding into `PATCH /organizations/:id`: rejected — mixes a table upsert into the settings-JSONB merge handler.
- Adding PATCH to `routes/portal/branding.ts`: rejected — that file is the unauthenticated customer-portal lookup surface.

### API

New route file `apps/api/src/routes/orgPortalSettings.ts` (mounted under the existing orgs router so paths read consistently; may live in `orgs.ts` only if it stays trivially small):

- `GET /orgs/organizations/:id/portal-settings`
  - Returns the org's `portal_branding` row, or schema defaults when no row exists (do not auto-insert on read).
  - Auth: `requireScope('partner', 'system')` + org read access.
- `PATCH /orgs/organizations/:id/portal-settings`
  - Body (strict Zod, shared validator in `packages/shared/src/validators/`): all fields optional —
    - `enableTickets`, `enableAssetCheckout`, `enableSelfService`, `enablePasswordReset`: boolean
    - `supportEmail`: valid email or null
    - `supportPhone`: string (length-capped, e.g. 50) or null
    - `welcomeMessage`, `footerText`: string (length-capped) or null
  - Upsert via `onConflictDoUpdate` on `orgId`; sets `updatedAt`.
  - Auth mirrors `updateOrgHandler` (`routes/orgs.ts`): `requireScope('partner', 'system')` + `requireOrgWrite` + `requireMfa()`.
  - Audit-logged consistent with other org settings changes.
  - **Not writable here (deferred):** `logoUrl`, `faviconUrl`, colors, `customCss`, `customDomain`, `domainVerified` — visual branding and domain verification are their own project.

### Web

- New `Portal` tab in `OrgSettingsPage.tsx` (hash-based tab state, consistent with the existing tab array).
- New component `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx`:
  - Fetches the GET on mount; renders four toggles + supportEmail/supportPhone/welcomeMessage/footerText fields.
  - Saves through `runAction` PATCHing the new endpoint. It owns its own save (unlike the JSONB-settings tabs that route through `handleSave(section, data)`), because it targets a different endpoint.
- No customer-portal-side changes: the portal read endpoints already return `enableTickets` and the portal gates on it.

## Feature 2: Alert → create ticket

### API

- `POST /alerts/:id/create-ticket` already exists (`routes/alerts/alerts.ts`) with optional `subject`, `categoryId`, `priority`, `assigneeId` overrides; service `createTicketFromAlert` maps severity→priority and links via `ticket_alert_links` (`linkType: 'created_from'`).
- **New:** `GET /alerts/:id/tickets` — tickets linked to the alert through `ticket_alert_links`, returning per ticket: id, internal number, subject, status, priority, linkType, createdAt. Auth: alert read + `tickets:read`.

### Web (`AlertDetailPage.tsx`)

- **Linked tickets section:** lists linked tickets with deep links into the tickets workbench (hash-based selection, matching existing ticket deep-link convention).
- **Create ticket button:** shown only when the user has `tickets:write`. Opens a compact dialog:
  - Subject prefilled from alert title; category select (active categories from `GET /ticket-categories`); priority select defaulted from the severity mapping.
  - Assignee intentionally omitted from the dialog for v1 (endpoint supports it; a user-picker isn't worth the surface yet).
  - If an open (non-closed) linked ticket exists, the dialog shows a warning line — e.g. "This alert already has open ticket T-2026-0042" — but does **not** hard-disable creation; duplicates stay possible but deliberate.
  - Submit POSTs via `runAction`; on success: toast (linking to the new ticket) + refresh the linked-tickets list.

## Feature 3: Category reorder (up/down arrows)

### Why arrows + a bulk endpoint

- The web app has no drag-and-drop dependency; arrows need none, are keyboard-accessible for free, and compose simply with the parent/child hierarchy.
- All existing categories have `sortOrder = 0`, so a "swap the two rows' sortOrder values" approach is a no-op on ties. And paired PATCH calls aren't atomic.

### API

- `PUT /ticket-categories/reorder` — body `{ ids: uuid[] }` (non-empty, deduped).
  - Server validates every id belongs to the caller's partner (reject the whole request otherwise), then assigns `sortOrder = index` sequentially in one transaction.
  - Client sends only the affected sibling group's ids in their new order; the endpoint doesn't need to know about hierarchy.
  - Auth: `requireScope('partner', 'system')` + `tickets:write` (same as the existing category PATCH).

### Web (`TicketCategoriesPage.tsx`)

- ▲/▼ buttons per row, operating within a sibling group (same `parentId`); disabled at first/last position.
- On click: reorder locally (optimistic), PUT the sibling group's id list, refetch on failure.
- Children move with their parent automatically — rendering is already hierarchical via `hierarchyOrder()`.
- The category edit form does **not** get a sortOrder input; the arrows are the only writer.

## Testing

Per the breeze-testing conventions (Drizzle mock pattern for routes, files alongside source):

- **API route tests:**
  - portal-settings GET (row vs defaults) and PATCH (upsert insert + update paths, validation rejects, authz: org-scope rejection, missing MFA, cross-org id).
  - `GET /alerts/:id/tickets` (links returned, empty case, authz).
  - reorder endpoint (sequential assignment, cross-partner id rejection, empty/dup id rejection).
- **Web tests:** reorder move logic (sibling-group computation, edge disabling) in `TicketCategoriesPage.test.tsx`; create-ticket dialog submit + prefill; portal editor save path. All mutations through `runAction` (guarded by the no-silent-mutations test).
- **RLS:** no new tables, no allowlist changes; `portal_branding` policies already exist (shape 1).

## Out of scope / follow-ups

- **Partner-level defaults for portal settings** — there is no partner-level default for `portal_branding`; every new org starts from schema defaults (`enableTickets = true`, etc.). An MSP wanting "tickets off by default for new customers" has no knob. Known gap, deliberate follow-up: would need a partner-level defaults table or settings key applied at org creation.
- Portal visual branding write UI (logo, colors, customCss) and custom-domain verification flow.
- Alert-rule "auto-create ticket" action (spec'd in the ticketing design, both sides unimplemented).
- Ticket number prefix customization (`partner_ticket_sequences` stays UI-less; deliberate v1 decision).
- Drag-and-drop reordering (arrows chosen; revisit if category lists grow long).
- Per-partner AI tool toggle for `manage_tickets` (consistent with other AI tools today).
