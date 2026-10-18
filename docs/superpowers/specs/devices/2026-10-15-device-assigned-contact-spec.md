---
tracking_issue: LanternOps/breeze#8835
---
# Assigned Contact on Devices — Design Spec

**Date:** 2026-10-15
**Issue:** #8835 (`enhancement`, `category:devices`, `category:tenancy`, `effort:m`, `priority:p2`). It is slice 1 of #5905.
**Status:** APPROVED 2026-10-17. The owner approved all nine decisions as recommended (see **Decisions**). The advisor quorum has run: Claude (Opus 5.5) wrote a position, then Codex `xhigh` (`gpt-6-astra`, read-only) critiqued it independently. Codex's corrections are folded into the design. The one residual difference (Decision 4) was resolved by the owner in favour of sharing #8836's table.
**Related:** #5905 (parent; its network/location slices stay there), #8833 (bulk edit; bulk assign reuses its pattern), #8836 (asset lifecycle state; the boundary is defined below), #8832 (dynamic-group re-evaluation; this feature must not repeat that bug), #4623 (licence tracking; a future consumer), #4622 (manual assets; `assigned_contact_id` is the precedent).

All file:line references were checked against `origin/main` at `601877a6ef`.

## Problem

Asset inventory needs to answer "who has this device", and ticketing needs the same link. Today an agent device has no person attached.

- `contacts` (`apps/api/src/db/schema/contacts.ts:40-99`) and `contact_roles` (`contactRoles.ts:30-60`) scope *responsibilities* to an org, site or device group, never to a single device. `ContactResponsibilitiesCard` (`apps/web/src/components/shared/ContactResponsibilitiesCard.tsx`, rendered at `DeviceDetails.tsx:857`) is read-only and lists only inherited responsible contacts. Those are the people to call about the device, not the person who uses it.
- The only person-to-asset link is `manual_assets.assigned_contact_id` (`manualAssets.ts:39`), and it covers non-agent assets only. Its FK is `(assigned_contact_id, org_id) → contacts(id, org_id) ON DELETE SET NULL (assigned_contact_id) DEFERRABLE INITIALLY IMMEDIATE` (`migrations/2026-10-14-100000-manual-assets.sql:80-86`).
- `asset_checkouts` (`schema/portal.ts:349-364`) records a temporary *loan* to a portal user. It is not a standing assignment, and its target is `portal_users` rather than `contacts`.
- The raw evidence exists but nothing joins it together:
  - `devices.last_user` (`devices.ts:161`) is the username of the most recent active session (`agent/internal/collectors/sessions.go:149-164`). On Windows it is the unqualified `WTSUserName` (`session_principal_windows.go:39-43`), such as `jane`, never an email address.
  - The agent sends a session **principal** (SID or UID, plus the UPN when the OS can translate it; `sessions.go:25-51`, `session_principal_windows.go:45-48`). **The API does not persist the UPN.** `device_sessions` stores only `username` (`schema/sessions.ts:24-41`). The principal is consumed at ingest by `observeSessionPrincipal` (`routes/agents/sessions.ts:172-180` → `services/callerVerification/loginObservation.ts:29-42`), which records an OS principal onto a caller-verification binding only when exactly one directory-bound contact in the org has that UPN.
  - `m365_intune_devices.user_principal_name` together with `breeze_device_id` (`schema/m365Sync.ts:129-173`), linked 1:1 by serial in `services/m365Sync/links.ts:44`.
  - `caller_verification_subject_bindings` (`schema/callerVerification.ts:54-79`) ties an Entra OID/UPN snapshot and an OS principal/username to a contact. It deliberately has no device column.
  - `portal_users.contact_id` (`schema/portal.ts:147`) has a composite same-org FK.

## Users & scope

- **MSP technicians** set, review and report on assignments. **Customer end users** see their own devices in the portal, and tickets about a device default to its user.
- **Tenancy axis: org.** An assignment is customer inventory data on an org-owned row (`devices`) that points at an org-owned row (`contacts`). Partner-Wide First (#2135) does not apply because this is not config or policy.
- **Assigning a contact from another org is impossible, not merely rejected.** The composite FK `(primary_contact_id, org_id) → contacts(id, org_id)` makes such a row unrepresentable. A person who works for two of an MSP's customers has two `contacts` rows by design (`contacts.ts:109-113`), and each customer's devices point at that customer's row.
- **Permissions.** Changing an assignment uses the same guards as `PATCH /devices/:id`: `requireScope(org|partner|system)` plus `devices:write` plus `requireMfa()` (`routes/devices/core.ts:2099-2313`). Reading follows `devices:read`. Contact RLS is org-axis only, and site confinement for contacts is enforced in the app (`routes/orgContacts.ts:94-112`: an org-level contact with `site_id IS NULL` is always reachable, and a site-pinned contact needs site reach). Assignment, suggestion and contact-device reads must therefore check **both** device reach and contact reach (Codex finding 2):
  - A site-confined technician cannot assign a contact pinned to a site they cannot reach.
  - The device DTO returns contact `name`/`email` only when the caller can reach the contact. Otherwise it returns `{ id, restricted: true }`.
- **Out of scope:** see the section below.

## Proposed design

### Data model

There is one current assignment per device, stored on the row (Decision 1).

```
devices
  primary_contact_id      uuid         NULL   -- composite FK (primary_contact_id, org_id) → contacts(id, org_id)
  primary_contact_source  varchar(32)  NULL   -- 'manual' | 'suggestion_accepted' | 'directory'
  primary_contact_set_at  timestamptz  NULL
```

- **ON DELETE SET NULL (primary_contact_id)**, using the PG ≥15 column-list form. A plain composite `SET NULL` would also null the NOT NULL `org_id` (`contacts.ts:74-76`). This form has three shipped precedents: `manual_assets_assigned_contact_org_fk`, `portal_users_contact_org_fk` and `tickets_requester_contact_org_fk` (`portal.ts:138-147,176-183`). The FK is **DEFERRABLE INITIALLY IMMEDIATE** because org merge runs `SET CONSTRAINTS ALL DEFERRED`. RESTRICT vs SET NULL is Decision 2.
- **Provenance stays consistent through a trigger.** An earlier draft deliberately left `source`/`set_at` populated after the FK nulled the id. Codex objected (finding 8), and the objection is adopted:
  - A `BEFORE UPDATE` row trigger, `devices_primary_contact_clear`, has `WHEN (NEW.primary_contact_id IS NULL AND OLD.primary_contact_id IS NOT NULL)` and nulls `source` and `set_at`.
  - A CHECK, `devices_primary_contact_coherent_chk`, enforces `(primary_contact_id IS NULL) = (primary_contact_source IS NULL) AND (primary_contact_id IS NULL) = (primary_contact_set_at IS NULL)`.
  - The trigger fires on the FK's RI-generated update too, because RI actions run an ordinary `UPDATE` and user row triggers fire on it.
  - The `WHEN` clause is evaluated before any plpgsql runs, so the heartbeat hot path pays nothing.
- **`source` is a `varchar` plus a CHECK, not a pg enum.** That keeps adding `'directory'` writers additive without `ALTER TYPE`. It matches the `device_role_source` and `purchase_date_source` convention (`devices.ts:95-96`).
  - `manual`: picked by a technician.
  - `suggestion_accepted`: a technician accepted a server-recomputed suggestion.
  - `directory`: reserved for the deferred Intune auto-accept setting (Decision 3). v1 never writes it.
- **Repeating the same assignment is a no-op.** It keeps the original `set_at` and writes no audit row.
- **Index:** `devices_org_primary_contact_idx ON devices(org_id, primary_contact_id) WHERE primary_contact_id IS NOT NULL`. It serves the contact's device list, the filter and the "unassigned" counts.

**Assignment ≠ responsibility ≠ loan ≠ lifecycle.** These four concepts stay separate:

| Concept | Where | Meaning |
|---|---|---|
| Assignment (this spec) | `devices.primary_contact_id` | The person who uses this device day to day |
| Responsibility | `contact_roles` | Who to call about devices in this org/site/group |
| Loan | `asset_checkouts` | Temporarily lent to a portal user, with an expected return date. Does not change the assignment |
| Lifecycle (#8836) | `devices.lifecycle_state` | The asset's state (in service, spare, pending disposal, disposed) |

**Boundary with #8836.** An assignment is a link to a person, and lifecycle is a state. They are independent columns with no automatic coupling. #8836's transition dialog *offers* to clear the assignment when the device moves to `spare`, `pending_disposal` or `disposed`, and it never clears silently. A `spare` device that still has an assignee is allowed, and reports show it. That combination is how "laptop returned but not yet re-imaged" looks. The asset report filters on both: Assigned / Unassigned × lifecycle state. Assignment history is Decision 4, and the recommendation there is to share #8836's history table.

**Linked manual assets.** A `manual_assets` row linked to a device (`linked_device_id`) carries its own `assigned_contact_id`. The device's assignment is authoritative.
- When the operator links a manual asset to an **unassigned** device, the link dialog offers to copy the manual asset's contact onto the device.
- When both sides are set and they disagree, the "Manual record" card shows the difference. Nothing syncs automatically.

### Suggestion engine

Suggestions are **computed on read and never persisted**. The only exception is dismissals, described below. No job writes assignments.

**Evidence, strongest first.** Each source produces a *normalised identity* that is resolved to contacts.

1. **Intune primary user (`intune:upn:<lower(upn)>`).** Requires `m365_intune_devices.breeze_device_id = device.id` with `is_stale = false` and `last_intune_sync_at` within 30 days. Stale or old rows are ignored (Codex finding 4: the earlier draft gave Intune unconditional precedence). Intune `owner_type = 'company'` devices with a shared or kiosk UPN fall out naturally, because the UPN resolves to zero or several contacts.
2. **Dominant session UPN (`session:upn:<lower(upn)>`).** Needs the new `device_sessions.principal_upn varchar(320) NULL` column (Decision 7). It is written at session ingest **only after the same consistency predicate `isObservablePrincipal` applies** (UPN present, principal username equal to the session username, exactly one of SID or UID) (`loginObservation.ts:24-27`). Console sessions only, never RDP or SSH. The rule:
   - Window: the last 30 days, with session intervals clipped to the window. An open session counts up to now.
   - Minimum evidence: 8 hours of total observed time.
   - Dominance: the leading UPN has at least 70% of the clipped time and at least 2× the runner-up. Otherwise there is no suggestion.
   - Only sessions recorded while the device was in its **current** org count. Session rows carry `org_id`, so this is a predicate on `device_sessions.org_id = devices.org_id`, and it excludes evidence from before a move (Codex finding 5).
3. **Bare OS username (`os:username:<lower(last_user)>`).** Matched **only** against an active `caller_verification_subject_bindings.os_username` in the same org that resolves to exactly one contact. It is never matched against an email local-part, because `jane` matching `jane@…` is a guess, not evidence. It is labelled low confidence in the UI.

**Resolving an identity to a contact.** A UPN identity matches a contact when either (a) an active, Entra-bound binding has `lower(upn_snapshot) = upn` (`callerVerification.ts:58-63`), or (b) `lower(contacts.email) = upn`, which uses `contacts_org_email_idx` (`contacts.ts:89-90`). The rules:
- **Ambiguity is resolved across the whole org before any visibility check.** If the union of matches is not exactly one contact in the device's org, there is no suggestion. That covers shared mailboxes, which are legal (`contacts.ts:86-88`).
- Only after a unique contact is found is the caller's contact reach checked. A caller who cannot reach that contact gets no suggestion, rather than a different one. Filtering by visibility first would turn an ambiguous mailbox into a false unique match (Codex finding 2).
- The highest-precedence source that resolves uniquely wins. When two sources resolve uniquely to **different** contacts, the engine abstains and shows both as "conflicting evidence" with no accept button.

**When the banner shows:**
- The device is unassigned and a suggestion exists: "Looks like **Jane Doe** (jane@acme.com) uses this device. Source: Intune primary user. [Assign] [Dismiss]"
- The device is assigned, but source 1 or 2 resolves uniquely to a **different** contact: "Intune now lists **Jane Doe** as the primary user. Reassign?" Source 3 never proposes a reassignment.

**Endpoints:**
- `GET /devices/:id/primary-contact-suggestion` returns `{ suggestion: { contactId, contactName, contactEmail, source, identity, confidence } | null, conflicts?: [...] }`.
- `GET /devices/primary-contact-suggestions?orgId=&page=&limit=` returns the set-based "Review suggestions" list for one org: unassigned devices with a unique suggestion, plus reassign candidates. It is one SQL statement per evidence source joined in, and it is paginated. **This list is the backfill:** after the feature ships, an MSP works through it and bulk-accepts. No migration or job writes assignments.

**Accepting a suggestion is recomputed on the server and guarded against concurrent changes** (Codex finding 6). `PATCH /devices/:id` with `{ primaryContactId, acceptSuggestion: true, expectedPrimaryContactId }` re-runs the engine for that device inside the transaction.
- If the current unique suggestion is not `primaryContactId`, it returns 409 `SUGGESTION_CHANGED`.
- If the device's current `primary_contact_id` is not `expectedPrimaryContactId` (null allowed), it returns 409 `ASSIGNMENT_CHANGED`. This is the same pattern as `expectedSiteId` (`core.ts:2177`).
- A stale banner can therefore never overwrite a newer manual decision. `acceptSuggestion` is the only way to get `source = 'suggestion_accepted'`, so the client cannot claim that source.

**Dismissal memory.** A new table, Decision 9:

```
device_primary_contact_dismissals
  id            uuid  PK
  org_id        uuid  NOT NULL
  device_id     uuid  NOT NULL      -- composite FK (device_id, org_id) → devices(id, org_id) ON DELETE CASCADE, DEFERRABLE INITIALLY IMMEDIATE
  identity      varchar(400) NOT NULL  -- namespaced: 'intune:upn:…' | 'session:upn:…' | 'os:username:…'
  dismissed_by  uuid  NULL → users(id) ON DELETE SET NULL
  dismissed_at  timestamptz NOT NULL DEFAULT now()
  UNIQUE (device_id, identity)
```

- Dismissals are **keyed on the evidence identity, not on a contact.** Dismissing "session user jane@acme.com" stops that identity from being suggested again. If Intune later names someone else, that is a different identity and is suggested. The table has no contact FK.
- Namespacing by authority means dismissing the low-confidence username match does not also suppress the Intune match (Codex finding 5).
- **Device move-org deletes them.** A dismissal is the source customer's decision about the source customer's people. Codex finding 5 rejected the earlier "portable raw identity, restamp it" design. Org merge repoints them, because the people move with the merge.
- The device page has a "Show dismissed" link that can undo a dismissal. There is no time-based expiry in v1.

**Agent-reported evidence never writes the column.** `primaryContactId` is added to `SERVER_CONTROLLED_FILTER_FIELDS` (`services/filterEngine.ts:232`), so execution targeting may use it. That classification only holds while every write comes from a human (or, later, from Graph). An auto-accept driven by session UPN or `last_user` would let a device choose its own assignee and, through that, its own targeting group. That is why such an auto-accept is ruled out permanently, not merely deferred (Decision 3).

### API

| Route | Guard | Notes |
|---|---|---|
| `PATCH /devices/:id` | existing | Add `primaryContactId: uuid \| null`, `acceptSuggestion?: boolean` and `expectedPrimaryContactId?: uuid \| null` to `updateDeviceSchema` (`routes/devices/schemas.ts:207-228`). Checks contact reach. Audits `device.primary_contact.set` / `.cleared` with `{ from, to, source }`. |
| `GET /devices/:id/primary-contact-suggestion` | `devices:read` | As above |
| `GET /devices/primary-contact-suggestions` | `devices:read` | As above, one org per call |
| `POST /devices/bulk/primary-contact` | `devices:write` + MFA | `{ deviceIds: bulkDeviceIdsSchema (≤500, schemas.ts:450-454), contactId: uuid \| null }`. **Single org:** every device must be in the contact's org; a mixed selection gets 400 with the offending ids. One audit row and one re-evaluation per changed device. Mounted before `coreRoutes` (`routes/devices/index.ts:133-143`, pinned by `bulkLifecycle.mountorder.test.ts`). |
| `POST /devices/bulk/primary-contact/accept-suggestions` | `devices:write` + MFA | `{ items: [{ deviceId, contactId, expectedPrimaryContactId }] }` (≤500). Recomputes per device and returns per-item outcomes (`accepted` / `suggestion_changed` / `assignment_changed` / `forbidden`). |
| `GET /orgs/contacts/:contactId/devices` | `organizations:read` + `devices:read` | Devices assigned to the contact, filtered by the caller's site reach. Feeds the contact drawer. |
| `GET /orgs/organizations/:id/contacts?q=` | existing | Adds a `q` (name/email `ILIKE`) param. The list accepts only `siteId`/`role`/`page`/`limit` today (`orgContacts.ts:47-55`), and the device-page typeahead needs server search. |

- **DTO.** Add `primaryContactId`, `primaryContactSource` and `primaryContactSetAt` to `PUBLIC_DEVICE_FIELDS` (`routes/devices/helpers.ts:20-50`, pinned by `devicePublicProjection.contract.test.ts`).
  - The detail and list responses add `primaryContact: { id, name, email } | { id, restricted: true } | null`, resolved with a joined lookup as `siteName`/`orgName` are (`core.ts:1773-1775`).
  - The list select is at `core.ts:1276`, with the mapper at `:1512`.

**Re-evaluation.**
- `PATCH /devices/:id` calls `requestDeviceGroupReevaluation` (`jobs/deviceGroupJobs.ts:246-256`) today **only** for this field. #8832 owns the existing gap for tags and custom fields; this spec must not add a new instance of it.
- `changedFields` is passed explicitly as `['primaryContactId']`. `mapChangedFieldsToFilterFields` passes unknown device fields through unchanged (`events/deviceEvents.ts:179-186`), but the spec does not rely on that implicitly.
- The bulk routes call it once per changed device.

**Contact delete pre-clears.** The FK action alone is not enough, because it bypasses the app: no audit, no re-evaluation, and partner-export locks taken by a trigger instead of in the required order (Codex findings 1 and 7).
- `deleteContact` (`services/contacts/crud.ts:736`) first pre-locks the org (see *Partner-export triggers*), then runs `UPDATE devices SET primary_contact_id = NULL WHERE org_id = $org AND primary_contact_id = $contact RETURNING id` in the same transaction, then deletes the contact.
- It writes one `device.primary_contact.cleared` audit row per device (`reason: 'contact_deleted'`) and requests re-evaluation for the returned ids after commit.
- The FK `SET NULL` stays as the backstop for the paths that delete contacts without going through `deleteContact`: the compat projection (`services/contacts/compat.ts:145`) and the site cascade (`contacts_site_org_fk ON DELETE CASCADE`, `contacts.ts:77-81`). On those paths re-evaluation is not requested. That is the residual gap, which a durable outbox would close (Codex finding 7). It is listed as a known limitation; the outbox belongs to #8832's follow-up, not here.

**Device move-org clears the assignment.**
- The single `UPDATE devices SET org_id` in `moveDeviceOrgInTransaction` (`services/deviceOrgMove/moveDeviceOrgInTransaction.ts:471-487`) gains `primaryContactId: null`. The trigger then clears the provenance.
- This copies the `linkGroupId: null` precedent in the same statement. Without it, the composite FK would fail the org flip.
- Dismissals for the device are deleted earlier in the same transaction.
- The move audit records `primaryContactCleared: <old id>`.
- The unassigned-pool path goes through the same function (`services/unassignedPool/assignParkedDevice.ts:285`), so no second change is needed.
- A site change inside the org leaves the assignment alone.

### Partner-export triggers

`devices` carries `breeze_partner_export_devices_update` (`migrations/2026-07-18-partner-export-org-locks.sql:310-330`). It compares an explicit column list and advances `partner_export_updated_at` only when a listed column changes. Codex finding 1 points out that adding these columns does not by itself make them export material: the Partner API's incremental export would never see an assignment change.
- **v1 waves 1 to 3 do not touch that trigger.** Assignment writes then fall outside the trigger's list, so they need no pre-lock beyond what the existing single-device PATCH does.
- `breeze_partner_export_custom_values_update` does fire on every devices UPDATE statement, but it no-ops when `custom_fields` and `org_id` are unchanged (`2026-07-24-partner-export-configuration-material-state.sql`, function body). The plan must re-verify every statement-level trigger on `devices` against an assignment-only UPDATE.
- **Wave 4 (Partner API)** redefines `breeze_partner_export_devices_update` to include `primary_contact_id` in both ROW comparisons. From then on, every set-based assignment write (bulk assign, bulk accept, the contact-delete pre-clear) takes **partner shared, then org exclusive** pre-locks in ascending UUID order, as `migrations/README.md` § "Set-based writes on partner-export material tables require pre-locks" requires.
- The bulk routes are single-org by construction, so the lock set is one partner plus one org.
- An RI-fired `SET NULL` on a backstop path fires the trigger immediately. PostgreSQL fires triggers for RI actions even with a deferred FK (Codex finding 1). That case is a single org and is acceptable, but the plan must cover it with a test.

### Web UI

- **Device page, System section of `DeviceInfoTab.tsx`.** Add an "Assigned to" row beside Display name, using the same inline-edit pattern (`:865-925`) and saving through `runAction` with `PATCH /devices/:id`.
  - The picker is a **shared `ContactTypeahead`** extracted from `ManualAssetModal.tsx:164-198,576-603`, which loads contacts once and filters on the client. It is switched to the new `q` server search. `ManualAssetModal` is migrated to the same component.
  - `callerVerification/ContactPicker.tsx` is a paged `<select>` and stays as it is.
  - "Unassigned" is the explicit null state. The suggestion banner sits above the System section, and Dismiss posts to a dismissal endpoint (`POST /devices/:id/primary-contact-dismissals { identity }`, `DELETE …/:identity` to undo).
  - The read-only "Last user" row (`:1374-1377`) stays, because it is evidence, not assignment.
- **Device list.**
  - An opt-in `assignedTo` column. Register it in `COLUMN_IDS`/`COLUMN_LABELS` (`columnVisibility.ts:9-58`) but not in `DEFAULT_VISIBLE_COLUMNS`. It needs a `Device` type field (`DeviceList.tsx:252`), a `sortValue` entry (`:705`) and a `columnDefs` renderer (`:1586`). Both records are keyed on `ColumnId`, so the compiler enforces the last two.
  - It is **not** in `AGENT_ONLY_COLUMNS` (`:446-474`), because manual-asset rows answer it from `assigned_contact_id` and that symmetry is free.
  - The device-list search matches the assignee's name and email.
- **Bulk menu.** "Assign to contact…" opens a typeahead dialog with a "Clear assignment" option, reusing #8833's bulk-dialog pattern. Add it to the menu (`DeviceList.tsx:2926-3094`) and the `runBulkAction` switch (`DevicesPage.tsx:1729`).
  - Classify it in `bulkActionGating.ts` as `INTENTIONALLY_UNGATED_BULK_ACTIONS` (`:130`). Inventory data stays editable on removed devices that are waiting for disposal.
  - A selection spanning orgs is refused before the request, with an "N devices are in other organizations" message.
- **Review suggestions.** A page-level entry on the Devices page, "N assignment suggestions", opens a drawer with the paginated list, per-row Assign/Dismiss, and "Accept all on this page". The selection state lives in the hash.
- **Filter.** `primaryContactId` is added to `filterFields.ts` and to the backend `FILTER_FIELDS` (`filterEngine.ts:73`) as a string field with `['equals','in','isNull','isNotNull']`. `getColumnForField` defaults to `devices[field]` (`:434`), so no mapping is needed.
  - The filter builder gets a contact-picker value input for this field, because no reference value type exists today (`packages/shared/src/types/filters.ts:55-77`).
  - Label: "Assigned contact". The "Unassigned" quick chip maps to `isNull`. Name/email filter fields are Decision 5.
- **Contacts.** There is no contact detail surface today. `ContactsCard.tsx` is a table with an inline form, and the only per-contact drawer is the caller-verification one (`:713-718`).
  - Add a "Devices" count column and a hash-addressed contact drawer (`#contact=<id>`) with an "Assigned devices" section fed by `GET /orgs/contacts/:id/devices`. Each row links to the device.
  - The drawer is built so the caller-verification panel can move into it later. This spec does not move it.
- **Every new en locale key goes into all 7 locales** (`localeParity`).

### Portal "My devices"

Today `GET /portal/devices` and its CSV export return **every device in the org** (`routes/portal/devices.ts:21,61-80` → `services/portal/deviceReadModel.ts:18`). They are gated only by `portal_branding.enable_devices`, and a missing settings row means enabled (`routes/portal/featureFlags.ts:61-72`). A "My devices" tab layered on top would therefore isolate nothing (Codex finding 3).

The design replaces the boolean control with a scope (Decision 6):
- `portal_branding.devices_scope varchar(16) NOT NULL DEFAULT 'organization'`, with CHECK values `'organization' | 'assigned'`.
- `enable_devices` still decides whether the page exists. When it is enabled, `devices_scope` decides what the page shows.
- In `assigned` mode the server filters on `devices.primary_contact_id = portalUser.contact_id AND devices.org_id = portalUser.org_id`, for both the list and the CSV export.
- **A portal user with a null `contact_id` sees an empty list**, with no fallback to the whole org.
- In `organization` mode the existing view gains a "Mine" filter chip.
- The portal DTO is unchanged: it already returns a limited projection.
- **Settings rule 9.** Home: the org Portal settings card, `OrgPortalSettingsEditor.tsx`. Level: org (`portal_branding` is one row per org, `portal.ts:20`). Resolver: `portalDevicesEnabledMiddleware` plus the new scope read. Places the concept "which devices a portal user sees" is configured: **1 before** (the `enable_devices` toggle) and **1 after**, because the toggle becomes a three-way control (Off / Assigned devices only / All organization devices) in the same card. No count goes up.
- `GET /portal/assets` (loanable devices) is unchanged.

### Tickets

There is no device-originated ticket entry point today. `DeviceTicketsTab.tsx` only lists tickets. `CreateTicketPage.tsx:223-240,385` posts `deviceId` from a select and never sends `requesterContactId`, although the API accepts it (`packages/shared/src/validators/tickets.ts:66-97`; `services/ticketService.ts:1067,1165`).

1. Add a "New ticket" button on the device's Tickets tab. It opens `CreateTicketPage` with `#orgId=…&deviceId=…`.
2. When a device is chosen and no requester is set yet, `CreateTicketPage` **visibly** prefills the requester with the device's assigned contact ("Requester: Jane Doe, assigned user of LAPTOP-12 ×"). The technician can edit or clear it.
3. **Prefill happens only in that human staff flow.** Alert, automation, AI and Partner API ticket creation never derive the requester from the assignment. `requester_contact_id` grants the contact's portal login visibility of the ticket (`routes/portal/ticketOwnership.ts:31-41`), and an internal "replace this user's disk" ticket must not appear in that user's portal without a technician choosing it (Codex finding 3; Decision 8).
4. Portal submission is unchanged: the requester is derived from the authenticated portal user. In `assigned` scope the device picker lists only the user's devices, and the server re-checks the device's assignment on submit.

### Partner API, reports, AI

- **Partner API (wave 4).** `GET /devices` is read-only (`routes/partnerApi/devices.ts:28`; select `:61-101`; mapper `makeRecord` `:107-129`; `deviceExportEnvelopeSchema`). It adds `primaryContactId`, `primaryContactSource` and `primaryContactSetAt`, plus the trigger change described under *Partner-export triggers*. It exposes the id only, with no contact name or email in the device record. There is no write endpoint: the Partner API has no device writes today, and adding the first one is out of scope.
- **Reports.** The `device_inventory` row type and select (`services/reportGenerationService.ts:375-412`) gain `assignedContactName` and `assignedContactEmail` through a left join to `contacts`. The manual-asset branch (`:483-500`) fills the same columns from `manual_assets.assigned_contact_id`, so the report answers "who has it" across both arms. A report filter `assignment: 'any' | 'assigned' | 'unassigned'` is added.
- **AI.** `query_devices` takes bespoke params, not filter-engine conditions (`services/aiToolsDevice.ts:160-264`). It gains `assignedContactId?: uuid` and `unassigned?: boolean`, mirrored in `aiToolSchemas.ts:204-211` and `aiAgentSdkTools.ts:1589-1598`. Optional fields use `.optional()`, never `z.undefined()`, which strips every tool from the model. The returned rows gain `assignedContactName`.
  - Separate pre-existing bug: `query_devices` declares `tags` but its handler never applies it. Note it in the plan and file it separately; do not fix it silently in this PR.
  - No assignment *write* tool in v1. Write tools are approval-gated, and the value does not justify one yet.

## Tenancy & data model impact

**Migration sketch.** Name each file to sort **after the newest migration on `origin/main` at implementation time**. Today that is `2026-12-28-130000-pam-reconciliation-reset-capability.sql`; shipped names run ahead of real time, so do not use today's date. Each file is idempotent with no inner `BEGIN`/`COMMIT`. None of them write rows, so none need `breeze.scope`; `migrationRlsScope.test.ts` must agree.

```sql
-- file A: devices columns + FK + trigger + check
ALTER TABLE devices ADD COLUMN IF NOT EXISTS primary_contact_id uuid;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS primary_contact_source varchar(32);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS primary_contact_set_at timestamptz;
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_primary_contact_source_chk
    CHECK (primary_contact_source IN ('manual','suggestion_accepted','directory'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_primary_contact_coherent_chk CHECK (
    (primary_contact_id IS NULL) = (primary_contact_source IS NULL)
    AND (primary_contact_id IS NULL) = (primary_contact_set_at IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE devices ADD CONSTRAINT devices_primary_contact_org_fk
    FOREIGN KEY (primary_contact_id, org_id) REFERENCES contacts(id, org_id)
    ON DELETE SET NULL (primary_contact_id) DEFERRABLE INITIALLY IMMEDIATE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE devices VALIDATE CONSTRAINT devices_primary_contact_org_fk;  -- all-NULL column; SHARE UPDATE EXCLUSIVE, not a write-blocking validation
CREATE OR REPLACE FUNCTION devices_primary_contact_clear() RETURNS trigger ... -- NEW.primary_contact_source := NULL; NEW.primary_contact_set_at := NULL
DROP TRIGGER IF EXISTS devices_primary_contact_clear ON devices;
CREATE TRIGGER devices_primary_contact_clear BEFORE UPDATE OF primary_contact_id ON devices
  FOR EACH ROW WHEN (NEW.primary_contact_id IS NULL AND OLD.primary_contact_id IS NOT NULL)
  EXECUTE FUNCTION devices_primary_contact_clear();
ALTER TABLE device_sessions ADD COLUMN IF NOT EXISTS principal_upn varchar(320);
-- portal_branding.devices_scope varchar(16) NOT NULL DEFAULT 'organization' + CHECK

-- file B (-- @no-transaction): CREATE INDEX CONCURRENTLY IF NOT EXISTS devices_org_primary_contact_idx
--   ON devices(org_id, primary_contact_id) WHERE primary_contact_id IS NOT NULL;

-- file C (wave 2): device_primary_contact_dismissals — CREATE TABLE IF NOT EXISTS, composite
--   (device_id, org_id) → devices(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
--   dismissed_by → users ON DELETE SET NULL, UNIQUE (device_id, identity), index (org_id),
--   ENABLE + FORCE RLS, four policies `breeze_current_scope()='system' OR breeze_has_org_access(org_id)`
--   in the same file.

-- file D (wave 4): CREATE OR REPLACE FUNCTION breeze_partner_export_devices_update() adding
--   primary_contact_id to both ROW(...) comparisons.
```

The plan must confirm that the `UPDATE OF primary_contact_id` trigger also fires for the FK's RI update. PostgreSQL's RI `SET NULL` issues an UPDATE of that column, so it should; the plan proves it with an integration test rather than assuming it.

**Org merge.** No remap is needed. `contacts` is a custom repoint that keeps ids (it clears the loser's `is_primary`, `orgMergeRegistry.ts:705`), and `devices` is a plain repoint (`REPOINT_TABLES`, `orgMergeRegistry.ts:951`). Both rows keep their ids, and the merge repoints parent and child `org_id` in separate statements under `SET CONSTRAINTS ALL DEFERRED`. That is exactly why the FK must be deferrable. The dismissal table is a plain `repoint`; there is no dedupe key collision, because `UNIQUE(device_id, identity)` cannot collide across two orgs' devices. The issue's "org merge must remap" therefore resolves to "must be deferrable", and `orgLifecycleFoundations.integration.test.ts` (merge contract) proves it.

**Registration lists.**

| List | Entry |
|---|---|
| `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | `devices` (`:436`): add `primary_contact_id`, `primary_contact_source`, `primary_contact_set_at` → `included`. `device_sessions` (`:406`): `principal_upn` → `included` (the same class as `username`). `portal_branding` (`:698`): `devices_scope` → `included`. New `device_primary_contact_dismissals`: all columns `included` (`identity` does not match `SUSPICIOUS_NAME_PARTS`, `services/tenantExportPolicy.ts:42-62`); no json/jsonb/bytea. |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | Add `device_primary_contact_dismissals` in its alphabetical slot (the plan pins it). `devices` and `contacts` are already registered (`:503`, `:601`). The new `devices → contacts` FK edge is SET NULL, and `tenantCascade.integration.test.ts` orders by `topologicalCascadeOrder()`, so `devices` sorts before `contacts`. Verify there is no cycle. |
| `orgMergeRegistry.ts` | `device_primary_contact_dismissals` → `REPOINT_TABLES`. No change for `devices` or `contacts`. |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts`) | `device_primary_contact_dismissals` (it has a `device_id`; the FK is ON DELETE CASCADE, and the plan confirms against `cascadeDelete.test.ts`). |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | **Check, don't assume.** The design says move-org *deletes* dismissals rather than restamping them. If `moveOrg.coverage.test.ts` requires every `device_id`+`org_id` table in the restamp list, the explicit delete must run before the restamp loop and the test's exemption mechanism must be used. #4622's plan hit the inverse surprise, so treat this as a known trap. |
| `rls-coverage` allowlists | None. Shape 1 is auto-discovered. |
| `AUDIT_ADMIN_REQUIRED_TABLES` | None. The table is not append-only. |

## Out of scope

- **Directory-driven automatic assignment** ("auto-assign from the Intune primary user"). See Decision 3. v1 suggests; a human accepts.
- **#5905's network/location slices** (known-networks registry, gateway collection, WFH classification, network-scoped policies). They stay on #5905.
- **More than one assignee per device** (Decision 1), and **assigning MSP technicians** (`users`). A technician who holds a device gets a contact row, as in #4622 Decision 7.
- **Assignment write tools for AI, and Partner API writes.**
- **Licence/seat linkage (#4623).** When it is built, "assignable to user" should resolve to the device's assigned contact where the licence is per-user.
- **A durable re-evaluation outbox** for contact deletes that bypass `deleteContact` (see API). That belongs to #8832's follow-up.
- **Moving caller-verification UI into the new contact drawer.**

## Decisions (approved 2026-10-17)

The owner approved every decision below **as recommended** on 2026-10-17. Each keeps its original number; the options are retained for the record, and the **Approved** line is binding.

**1. One contact per device, or many?**
- (a) A single `devices.primary_contact_id`.
- (b) A `device_contacts` join table with a role (primary, secondary).

**Recommend (a).** "Who has this device" and "who is the ticket requester" each need exactly one answer. A single column keeps the filter, column, report and portal predicate trivial, and it matches `manual_assets.assigned_contact_id`. Shared, kiosk and lab devices stay Unassigned, or are tagged. If a real multi-user need appears, a join table can be added with `primary_contact_id` kept as the "primary" projection. *Codex agrees.*

**Approved (2026-10-17): (a).** One `devices.primary_contact_id` per device.

**2. What happens to the assignment when its contact is deleted: SET NULL or RESTRICT?**
- (a) Column-list `ON DELETE SET NULL (primary_contact_id)`, plus an explicit, audited pre-clear in `deleteContact`.
- (b) `RESTRICT`: deleting a contact that still has assigned devices fails until they are reassigned.

**Recommend (a).** RESTRICT would block deleting a contact, and with it GDPR person erasure, behind an inventory chore. It would also break the contact importer and compat paths that delete contacts today. The pre-clear gives the audit trail and re-evaluation that RESTRICT would have forced, and the FK backstop keeps the other deletion paths safe. *Codex agrees.*

**Approved (2026-10-17): (a).** Column-list `ON DELETE SET NULL (primary_contact_id)` as the backstop, plus the audited pre-clear in `deleteContact`.

**3. Should directory (Intune) matches be accepted automatically, as a setting?**
- (a) Not in v1. Suggestions plus human acceptance only.
- (b) Ship a setting "Auto-assign from the Intune primary user" that writes `source='directory'`.

**Recommend (a), and if it is built later:** home is the M365 integration settings (settings rule 2: it lives with the domain that supplies the evidence), level is a partner default with an org override, resolver is one `resolveDirectoryAutoAssign(orgId)`, and the place count goes from 0 to 1. It would apply only to **unassigned** devices or to rows whose source is already `directory`, and never overwrite `manual` or `suggestion_accepted`. **Session-UPN and `last_user` evidence must never auto-accept** (it would let a device choose its own targeting group; see *Agent-reported evidence never writes the column*). *Codex agrees.*

**Approved (2026-10-17): (a).** No auto-accept in v1. Session-UPN and `last_user` evidence may never auto-accept. If directory auto-accept is built later it follows the home/level/resolver stated above.

**4. How should assignment history be kept?**
- (a) Audit log only. Its retention is configurable (`schema/audit.ts:82`), so it is not reliable custody history.
- (b) Record assignment changes as events in #8836's device history table, generalised to "device asset events" (lifecycle state changes plus assignment changes).
- (c) A dedicated `device_contact_assignment_events` table.

**Recommend (b)** if #8836 is approved (it was, 2026-10-17), and (c) if #8836 slips past this feature's wave 3. Asset reporting ("who had this laptop before disposal") wants one timeline, not two tables joined by time. The device columns remain the current projection either way, and history rows must not be restamped on device move-org: source-org custody stays with the source org. *Codex: add a history table if temporal reporting is required. It agrees on the projection-plus-history shape and did not weigh in on sharing #8836's table.*

**Approved (2026-10-17): (b).** Assignment changes are recorded as `kind = 'assignment'` events in #8836's `device_lifecycle_events` table. #8836's waves therefore land first. History rows are never restamped on device move-org (they detach and stay with the source org, as lifecycle events do), and they inherit #8836 Decision 6's detach, access and retention rules. The combined implementation plan fixes the column shape (contact ids, no contact-name snapshots, so contact erasure stays complete).

**5. Which assignment filter fields should the filter engine get?**
- (a) Id only: `primaryContactId` (equals/in/isNull/isNotNull) with a contact-picker value input. Name and email are matched by device-list search only.
- (b) The issue's `assignedContactName contains` and `assignedContactEmail contains` as well.

**Recommend (a).** Name and email fields make every dynamic group's membership depend on edits to the *contacts* table, so every contact rename or email change would have to fan out a re-evaluation to that contact's devices. Several writers bypass the route that would trigger it (`compat.ts`, the importer), so the result is #8832 again. The id field answers "devices assigned to Jane" exactly. *This diverges from the issue body.* Codex did not object to name fields as such, but flagged the same invalidation fan-out (finding 7).

**Approved (2026-10-17): (a).** `primaryContactId` only (`equals | in | isNull | isNotNull`) with a contact-picker value input. Name/email are matched by device-list search, not by filter fields. This diverges from the issue body on purpose.

**6. How should portal device visibility work: a scope setting, or a tab?**
- (a) Replace the `enable_devices` toggle with an Off / Assigned only / All org control (the new `devices_scope` column, defaulting to `organization` so existing portals do not change).
- (b) A "My devices" tab only, leaving the org-wide view as it is.
- (c) (a), but with `assigned` as the default for new portals.

**Recommend (a).** Option (b) isolates nothing, because the org-wide list and CSV stay reachable. Option (c) changes behaviour for new customers without anyone opting in. The place count stays at 1. *Codex wants a default-off gate, which (a) is for `assigned` mode. It also insists on no fallback for a null contact and on a server-side filter for the list and CSV; both are adopted.*

**Approved (2026-10-17): (a).** `portal_branding.devices_scope` (`organization` default | `assigned`), surfaced with `enable_devices` as one three-way control (Off / Assigned devices only / All organization devices) in `OrgPortalSettingsEditor.tsx`. Null `contact_id` in `assigned` mode sees an empty list; list and CSV are filtered server-side.

**7. Should the session principal UPN be persisted on `device_sessions`?**
- (a) Add `device_sessions.principal_upn`, written only after the `isObservablePrincipal` consistency check.
- (b) No session evidence in v1: Intune plus the binding-based `last_user` match only.

**Recommend (a).** The agent already sends the UPN; ships nothing new. Without it, devices outside Intune (the majority for many MSPs) get almost no usable suggestions. The column is the same class of data as `username`, which is already exported. *Codex agrees, with the consistency check as a condition (adopted).*

**Approved (2026-10-17): (a).** `device_sessions.principal_upn`, written only after `isObservablePrincipal`, console sessions only.

**8. When should a new ticket's requester be prefilled from the device's assigned contact?**
- (a) Visible, editable prefill in the staff create flow only. Never for alert, automation, AI or Partner API tickets.
- (b) Prefill on every ticket that has a device.

**Recommend (a).** `requester_contact_id` grants the contact's portal login visibility of the ticket (`ticketOwnership.ts:31-41`). Under (b), every alert ticket about Jane's laptop, including internal-only work, would appear in Jane's portal without anyone deciding that. *Codex agrees (finding 3).*

**Approved (2026-10-17): (a).** Visible, editable requester prefill in the staff create flow only.

**9. Where should dismissed suggestions be remembered?**
- (a) The identity-keyed `device_primary_contact_dismissals` table: namespaced by authority, deleted on device move-org, repointed on merge.
- (b) No server memory: dismissal is per browser (`localStorage`), so the banner comes back on another machine.
- (c) A single `primary_contact_suggestion_dismissed_identity` column on `devices`, which holds the last dismissal only.

**Recommend (a).** Under (b), the review-suggestions list keeps re-offering rows a colleague already rejected. Under (c), alternating users re-suggest each other. The table costs one more full registration, all of it mechanical and covered by contract tests. *Codex accepted a table but rejected the first draft's "portable identity restamped on move". Clearing on move and namespacing are adopted from its critique.*

**Approved (2026-10-17): (a).** Identity-keyed `device_primary_contact_dismissals` table: namespaced, deleted on device move-org, repointed on merge.

## Advisor note (quorum)

Claude (Opus 5.5) formed the position first. Codex `xhigh` (`gpt-6-astra`, read-only, static review with no live database) then critiqued it.

- **Agreed:** one contact per device; column-list SET NULL over RESTRICT; computing suggestions on read; persisting the validated session UPN; deferring directory auto-accept; no remap on org merge (only deferrability); clearing the assignment inside the move-org UPDATE.
- **Codex corrections adopted:**
  1. The partner-export trigger's explicit column list, and the pre-lock duty once assignment becomes export material.
  2. Checking contact site reach in addition to device reach, with ambiguity resolved org-wide before visibility.
  3. Portal isolation needs a server-side scope; a tab is not enough.
  4. Freshness, clipped windows, a dominance margin and abstention for evidence; Intune is not unconditional.
  5. Clearing dismissals on move-org and namespacing identities.
  6. Server recompute plus an `expectedPrimaryContactId` guard on accept; idempotent repeats.
  7. Explicit `changedFields`, and the contact-delete pre-clear; route hooks alone are not enough.
  8. Coherent provenance through a trigger plus CHECK.
- **Residual disagreement:** none on the core design. On assignment history (Decision 4), Codex wants a history table when temporal reporting is required, while Claude recommends sharing #8836's table rather than adding a second one. That is recorded for the owner.

## Test & rollout notes

**Test API (unit and route) suites:**
- **PATCH:** set, clear and idempotent repeat (no audit, `set_at` unchanged); cross-org contact rejected (400, and the FK backstop); site-confined caller assigning an unreachable site-pinned contact gets 403; `acceptSuggestion` returns 409 for both `SUGGESTION_CHANGED` and `ASSIGNMENT_CHANGED`; `requestDeviceGroupReevaluation` called with `['primaryContactId']`.
- **Suggestion engine** (pure functions plus SQL fixtures): precedence; stale Intune ignored; dominance threshold, margin and minimum evidence; evidence from before a move excluded; shared mailbox abstains; ambiguity decided before visibility (a hidden duplicate still blocks); a username matches only through a binding and never through an email local-part; conflicting sources abstain.
- **Bulk:** the 500 cap; mixed-org refused; per-item outcomes for accept-suggestions; mount order (`bulkLifecycle.mountorder.test.ts`).
- **Contracts:** `devicePublicProjection.contract.test.ts` (new fields); `cascadeDelete.test.ts` and `moveOrg.coverage.test.ts` (dismissals table, statically, in this job); `migrationRlsScope.test.ts`; `autoMigrate.test.ts` ordering; `orgMerge.test.ts` (full unit suite only: a missing merge policy reds only there).
- **Web:** `ContactTypeahead`; the column registry; `bulkActionGating` classification; `no-silent-mutations` (every new mutation through `runAction`); `localeParity`.

**Integration Tests suites.** These are the only place the tenancy contracts fail; they cannot go red in Test API.
- `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts`: new columns on `devices`, `device_sessions` and `portal_branding`, plus the new table.
- `tenantCascade.integration.test.ts`: the dismissals table is present and placed correctly; topological order with the new `devices → contacts` edge.
- `orgMergeRegistry.integration.test.ts`, and `orgLifecycleFoundations.integration.test.ts` (merge contract: both new composite FKs are deferrable).
- `rls-coverage` via `test:rls-coverage` (its own config). Plus a `devicePrimaryContactDismissalsRls.integration.test.ts`: a forged cross-tenant insert as `breeze_app` gets 42501, with a positive control.
- New `devicePrimaryContact.integration.test.ts`:
  - contact delete through `deleteContact` clears, audits and re-evaluates;
  - contact delete through the site cascade nulls through the FK, **and the trigger clears provenance** (proves that RI updates fire the trigger);
  - device move-org clears the assignment and deletes dismissals;
  - org merge keeps the assignment;
  - a dynamic group on `primaryContactId isNull` gains and loses the device on assign and clear (in `dynamicGroupReevaluation.integration.test.ts`).
- Wave 4: `partnerApiExportWatermark.integration.test.ts` shows that an assignment change, and a contact-delete clear, advance the device watermark.

**Backfill.** No data migration. Every device starts Unassigned, and the review-suggestions list is the backfill tool. Release notes should say so ("Devices → N assignment suggestions"). Session-UPN evidence builds up only from the deploy onward, because `principal_upn` is not backfilled: there is no source for history. Intune and binding evidence work on day one.

**Feature flag.** None. The feature is additive: unassigned is the null state, the column is opt-in, and portal scope defaults to the current behaviour.

**Docs.** Devices page (assignment, suggestions), portal settings (device scope), and ticket creation (requester prefill). The release notes describe a user-visible feature.

**Suggested wave split:**
1. Migration A/B (columns, FK, trigger, CHECK, `principal_upn`, `devices_scope` column unused), export-policy entries, PATCH, DTO, audit, re-evaluation, move-org clear, contact-delete pre-clear, filter field, `ContactTypeahead`, device page editor, list column.
2. Suggestion engine: session ingest writes `principal_upn`; the suggestion endpoints; migration C (dismissals) with all its registrations; banner; review-suggestions drawer; bulk accept.
3. Bulk assign; contact drawer and Devices list; report columns; AI params; ticket prefill and the device "New ticket" entry point; portal `devices_scope` control.
4. Partner API fields, migration D (trigger list), and set-based pre-locks.
