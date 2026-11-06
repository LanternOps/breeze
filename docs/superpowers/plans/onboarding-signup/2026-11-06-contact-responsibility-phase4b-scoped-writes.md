---
tracking_issue: LanternOps/breeze#7891
---

# Contact Responsibility Phase 4b — Scoped Write API and Editor — Implementation Plan

**Goal:** Let a technician read and replace a contact's scoped responsibilities (Organization / Site / Device Group) from Organization → Contacts, through a Contacts-domain API, so contacts left holding assignments at a stale Site (review of #10941, blocker 2) have a way out.

**Spec:** `docs/superpowers/specs/onboarding-signup/2026-10-06-contact-responsibility-scope-design.md` — §8.2–8.4, §12.1–12.2, §17, §21, §23, §24.6–24.7, §28 Phase 4, §29. Discussion #7891.

**Stacking:** branch `feat/contact-responsibility-phase4b`, created from the tip of `feat/contact-responsibility-phase3-retire` (#10941, `6ae0829aa`), at the maintainer's request ("stack it on that work"). The PR shows #10941's commits until #10941 merges. §8.4 opens the scoped-write gate only after Phase 3, so this work must not reach `main` before #10941.

No migration: `contact_roles` (constraints, `UNIQUE NULLS NOT DISTINCT`, composite DEFERRABLE FKs, RLS) and the cascade / export / merge registrations shipped in Phase 1.

## What exists (verified on the branch)

- `replaceContactResponsibilities(exec, {contactId, orgId, responsibilities})` (`services/contacts/responsibilities.ts`): validates role, duplicates, Site and Device Group membership in the org, then `replaceCanonicalSet` (delete + insert + `contacts.roles[]` projection). **No route calls it.** It reads the contact without a lock and does **not** re-project `organizations.billing_contact`.
- Error type `ResponsibilityValidationError` with codes `site-not-in-org`, `device-group-not-in-org`, `unsupported-role`, `unsupported-scope`, `duplicate-assignment`, `contact-not-in-org`; `orgContacts.ts` `validationResponse` maps it to `400 {error, code}`.
- Lock order for projections: organization (`lockOrganizationForProjection`, FOR NO KEY UPDATE) → contact → sites by id (`crud.ts` `lockProjectionScopes`, #3911).
- GET `/orgs/organizations/:id/contact-responsibilities` (#8785) lives in `routes/orgContactResponsibilities.ts`, already `exempt: 'tool_in_later_wave'` in `services/mcpCoverage.ts`.
- Contact writes: `ORGS_WRITE` + `requireMfa()`; site axis via `canReachContactSite(auth, siteId)`.
- Web: `settings/ContactsCard.tsx` (`draftBody` sends `siteId` + `roles`; role checkboxes), mounted in `OrganizationRecordPage.tsx`.

## Design

### API (Contacts domain, same file as the #8785 GET)

| Route | Gate | Purpose |
|---|---|---|
| `GET /orgs/contacts/:contactId/responsibilities` | `ORGS_READ` | Configured assignments of one contact (`listContactResponsibilities`) |
| `PUT /orgs/contacts/:contactId/responsibilities` | `ORGS_WRITE` + `requireMfa()` | Replace the contact's whole set |

Body (spec §21): `{ responsibilities: [{ role, scope: {type:'organization'} | {type:'site', siteId} | {type:'device_group', deviceGroupId}, isPrimary? }] }`. The scope is a Zod `discriminatedUnion('type')` of `.strict()` objects, so Site + Device Group cannot be expressed; `siteId` / `deviceGroupId` must be UUIDs; `role` is `z.enum(CONTACT_ROLES)`; max 200 entries (**Inference**). Org-ness comes from the contact (`resolveContactOrg`, exported from `orgContacts.ts`), never from the body.

Errors: unknown role / scope type / extra keys → 400 (Zod); foreign Site or Device Group, duplicate → 400 `{error, code}` from the service; unreachable or missing contact → 404 (no existence oracle). Same `{error, code}` shape as the sibling routes; no `ERROR_CODES` (see Out of scope).

### Service: `setContactResponsibilities` (new, `responsibilities.ts`)

One transaction, in this order: `lockOrganizationForProjection` → lock the contact row `FOR NO KEY UPDATE` → `replaceContactResponsibilities` (existing validation + `replaceCanonicalSet`, which re-projects `contacts.roles[]`) → `projectBillingContact(exec, orgId)` when the old or new set holds `billing @ Organization`. Sites are not locked: the editor does not touch `sites.contact` (**Inference**, confirm in Stage B; if the projection reads `contacts.roles`, lock sites by id as `lockProjectionScopes` does).

### Site-axis authorization (**Inference**; §23 only requires tenant isolation)

A caller with `allowedSiteIds` can neither see nor safely replace Organization-wide or foreign-Site rows. PUT is refused with 403 for a site-confined caller; GET omits nothing (read is already reachable by `canReachContactSite` on the contact's pin). Narrowing a site-confined caller to a diff of reachable Sites is deferred.

### Editor (Organization → Contacts only, §12.1–12.2)

In the `ContactsCard` drawer, the role checkboxes become a responsibilities list: each row = Role select, Scope select (Organization / Site / Device Group), and a Site or Device Group select when needed. "Organization needs no subordinate selector; Site needs a Site; Group needs a Group" (§24.7). The Site pin field stays, relabelled as affiliation. `draftBody` stops sending `roles`, so the legacy adapter is no longer exercised by the UI; responsibilities go through the PUT. Mutations use `runAction`; new strings in `en` and `pt-BR` locales. No editor is added to Site, Device Group or Device pages; the #8785 card stays read-only.

Create flow: POST the contact without roles, then PUT. A failure between the two leaves a contact with no responsibilities, reported by `runAction`; the drawer stays open so Save retries the PUT only (**Inference**).

The Device Group picker needs an org-scoped list; reuse the existing device-groups list endpoint (**to confirm in Stage B**, not inventing a new one).

### Escape from the stuck states (review of #10941, blocker 2)

- (a) import row with a Site cell and empty roles, (b) PATCH with only `siteId`: the pin moves, `contact_roles` stay at the old Site, so the legacy gate (`representable`) refuses any later roles change. PUT replaces the whole set, so afterwards the set matches the new pin or is whatever the technician chooses, and legacy saves pass again. The editor is the UI exit; the PUT is the API exit.
- Roles-changed legacy writes keep their 400 (`legacy-write-cannot-represent-scoped-responsibilities`); the UI message points to the editor.

## Tasks

1. **Service** — `setContactResponsibilities` + billing re-projection + lock order; unit tests in `responsibilities.test.ts` (lock order, projection calls, error pass-through).
2. **Routes** — GET and PUT in `routes/orgContactResponsibilities.ts`; export `resolveContactOrg` from `orgContacts.ts`; Zod schema; site-confined 403; audit event for PUT (`writeRouteAudit`-style, same as sibling contact writes; **no PII** in details, role/scope counts only).
3. **Coverage contracts** — walk `writeRoutePermissionGate.contract`, `routerAuthGate.contract`, `site-ceiling-write-coverage` (add the PUT to `ALLOWED_WITHOUT_CEILING_CHECK` with reason only if the inline refusal is not recognised), `partner-wide-write-coverage` (not applicable), `mcpCoverage` (file already exempt), OpenAPI tests. Fix only what they require.
4. **Web** — responsibilities editor, i18n, `ContactsCard` changes, tests.
5. **Verification** — mechanical first: `tsc`, lint, touched unit tests, then integration as `breeze_app`.
6. **Review** — one `breeze-reviewer` round (tenancy / auth blast radius), then the diff review.

## Tests

API unit (`orgContactResponsibilities*.test.ts`, `responsibilities.test.ts`): happy replace; empty set clears; every §21 refusal — Site + Device Group together (400), foreign Site, foreign Device Group, unsupported role, unsupported scope type, duplicate; 404 for another org's contact; 403 without `organizations:write`; MFA required; site-confined caller 403.

API integration as `breeze_app` (`apps/api/src/__tests__/integration/`, new `contactResponsibilitiesWrite.integration.test.ts`, needs `pnpm test-stack up`):
- case (a): import with Site cell + empty roles on a contact holding `admin @ Site A` → stuck (legacy roles change returns 400) → PUT → legacy save succeeds;
- case (b): `siteId`-only PATCH → same;
- cross-org forge of Site and Device Group rejected by the composite FK / service;
- after PUT, `contacts.roles[]` equals the distinct canonical roles and `organizations.billing_contact` follows `billing @ Organization` (set, move, remove); `billing @ Site` does not feed it;
- `admin @ Organization` written by PUT is honoured by caller verification; `admin @ Site` / `@ Device Group` is not (existing regression suite re-run);
- concurrent PUT + legacy PATCH + `deleteContact` on one organization: no 40P01.

Phase 3 suites that must stay green: `crud`, `compat`, `import`, `loginLink`, `responsibilities`, `contactResponsibilities.integration`, `orgAccountReadiness`, `reportSeriesRecipients`, `loginContactLinking`, `orgContactResponsibilitiesRoute`, `callerVerification`.

Web: existing assignments render; Organization scope shows no selector; Site scope requires a Site; Device Group scope requires a Group; Save is blocked on an incomplete row; `runAction` used (the `no-silent-mutations` guard); editor present only in Contacts; `translationCoverage`.

## Risks

- **Whole-set replace is last-writer-wins** between two technicians editing one contact (**Inference**: matches `replaceContactResponsibilities`; no `If-Match` in v1).
- **Billing recipient change**: replacing `billing @ Organization` changes who invoices go to; the re-projection must run under the org lock, and the UI must make that visible.
- **Stack hygiene**: base is #10941. The PR must say "Depends on #10941"; merge only after it.
- **Required CI contracts** (cascade, export, merge) are untouched because no table or column is added; the coverage suites in task 3 are the ones that can still redden.

## Out of scope (not done here)

- Scope-aware display of assignments in the contacts table (it still shows the `roles[]` projection).
- A narrowing path for site-confined callers; partner-wide responsibilities.
- MCP tools for responsibilities (`tool_in_later_wave`).
- `ERROR_CODES` adoption (needs web locale keys).
- Optimistic concurrency (`If-Match`).
- Removing the legacy `roles` input from `POST/PATCH` contacts (spec §30 keeps the projection).
