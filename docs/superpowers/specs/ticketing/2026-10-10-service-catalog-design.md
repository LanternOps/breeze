# Specification: On-Demand Service Catalog on Intake Forms

**Date:** 2026-10-10
**Tracking issue:** [Issue #8325](https://github.com/LanternOps/breeze/issues/8325)
**Origin:** [Discussion #7792](https://github.com/LanternOps/breeze/discussions/7792), mainly [the maintainer comment](https://github.com/LanternOps/breeze/discussions/7792#discussioncomment-18844392)
**Status:** Draft for maintainer review. The direction was accepted; this design is not yet approved and implementation is not scheduled.
**Code base:** `4d46c8961af36a0c0a485936c3df64e89a184f5b` (upstream main)
**Deliverable of this PR:** specification only, with no implementation and no migration.

---

## 1. Context

### 1.1 What the maintainer already confirmed

Breeze already covers part of the service management requests:

- **Service requests:** Intake Forms support custom fields, category, default priority, and a title template. They can appear in the portal or remain available only to the team.
- **Changes:** an internal form can collect change type, risk, reason, impact analysis, execution plan, and rollback. Custom statuses, categories, and checklists help organize the process.
- **Problems:** a ticket can be created from an alert, and other alerts can be linked to the same ticket.
- **Maintenance windows:** they exist in configuration policies and can suppress alerts, patches, automations, and scripts on covered devices.

Gaps recognized by the maintainer, with roadmap items:

| Item | Declared scope |
| --- | --- |
| #7900 | Ticket types and links between tickets; dedicated entries in the Service Desk menu with savable views. |
| #7901 | Change records with risk, impact, plans, multiple devices, and a link to maintenance windows. |
| #7902 | Ticket approval by multiple approvers (CAB). |
| Calendar | Synchronization not planned for now. |

Changes still live under **Service Desk → Tickets**; the Change category and its filter are the current alternative (the filter is not yet saved in the link).

### 1.2 Problem

Customers with contract access need to request standardized services without opening a generic free-text ticket. Today there is no way to:

- publish, per partner, a set of on-demand services with friendly names and descriptions;
- make these services available only to organizations with an active contract;
- ensure the request records the SLA commitment agreed for that service.

### 1.3 Goal

Provide a **lightweight on-demand service catalog**, managed by the partner. A customer with access chooses a service, fills in an existing form, and creates a native ticket with the SLA resolved and recorded at creation.

Request flow:

```text
contract → item access → service item → existing form → native ticket → existing SLA engine
```

Recurring flow (outside this delivery):

```text
contract → Service Deliverable → occurrence → due date → execution → evidence
```

### 1.4 Confirmed by the maintainer

- A lightweight catalog layer on top of Intake Forms.
- Reuse of ticket creation and of the response and resolution SLA fields, with no second SLA engine.
- Recurring obligations stay in Service Deliverables.
- One catalog shared per partner, with access defined per organization.
- Initial metadata reduced to the list indicated by the maintainer.
- A first delivery is possible before #7900, using generic tickets.
- Separate scope in #8325; spec before implementation.

The original body of #8325 still mentions vertical, activity type, and out-of-hours eligibility. According to the maintainer's comment, these fields are deferred.

### 1.5 Suggestions given

Table names, routes, contract date rules, SLA precedence, protection of historical values, and work type behavior are **proposals subject to review**, not maintainer commitments.

---

## 2. Sources and instructions

- `CLAUDE.md`, `docs/agents/tenancy-rls.md`, and `docs/agents/settings.md`: configuration first at the partner level, mandatory RLS, one configuration location per concept, and explicit inheritance.
- Earlier form specs describe reads in system context. This documents the existing behavior and **does not authorize** bypassing RLS in the new catalog.

---

## 3. Existing capabilities and integration points

| Confirmed in code | Reference | Consequence |
| --- | --- | --- |
| Commercial catalog (hardware, software, services, prices, billing) | `apps/api/src/db/schema/catalog.ts` | Do not reuse `catalog_items` as the request control. |
| Forms owned by partner/organization, with category, priority, fields, version, and visibility | `apps/api/src/db/schema/ticketForms.ts` | Reuse definition and rendering. |
| Partner forms with a list of allowed organizations | `apps/api/src/db/schema/ticketFormOrgLinks.ts`, `apps/api/src/services/ticketFormService.ts` | Contract access adds a check; it does not bypass form visibility. |
| Native creation validates forms, builds the description, and preserves answers | `apps/api/src/services/ticketService.ts` (`createTicket`) | Extend the common creation path. |
| Portal lists forms and uses native creation | `apps/api/src/routes/portal/tickets.ts`, `apps/portal/src/components/portal/NewTicketForm.tsx` | Preserve session organization, CSRF, ownership, and current answers. |
| SLA targets stored on the ticket and evaluated by the existing worker | `apps/api/src/services/ticketSla.ts`, `apps/api/src/services/ticketService.ts`, `apps/api/src/jobs/ticketSlaWorker.ts` | No new clock, pause rule, or breach worker. |
| Category and priority can recalculate SLA before the first response | `apps/api/src/services/ticketService.ts`, `apps/api/src/services/ticketService.slaRestamp.test.ts` | Protect service-specific commitments. |
| Contracts have organization, partner, status, and dates | `apps/api/src/db/schema/contracts.ts` | Reuse contracts without changing billing. |
| Work Types classify work; categories provide a default | `apps/api/src/db/schema/workTypes.ts`, `apps/api/src/db/schema/tickets.ts` | A work type is not a ticket type, delivery mode, price, or scheduled work. |

---

## 4. Scope and limits

### 4.1 Initial delivery

- Catalog shared per partner, with hierarchy: pillar → service line → activity.
- Reduced initial metadata (section 5).
- Item access by contract and organization.
- Team administration and portal navigation.
- Item → existing form → native ticket, with SLA recorded and traceability.
- Generic tickets, without depending on #7900.

### 4.2 Out of scope

Vertical, activity type, out-of-hours eligibility, calendar synchronization, recurring scheduling, workflow engine, automatic execution of services, price or billing changes, CAB, change record implementation, new SLA clocks, service packages, SLAs that differ per contract, and automatic conversion of forms or commercial items.

In the first delivery, `change` is only **descriptive ITIL classification**. It does not mean CAB approval and does not authorize executing a change.

---

## 5. Service item configuration

| Field | Proposed initial behavior |
| --- | --- |
| Name and description | Activity name and a short explanation for the customer. |
| Pillar | Optional grouping, with no separate taxonomy engine. |
| Service line | Optional grouping within the pillar. Items without a group remain accessible. |
| Activity | The selectable item itself, without duplicating the name in another field. |
| ITIL class | `incident`, `service_request`, `problem`, `change`; descriptive metadata until #7900. |
| Delivery | `remote`, `onsite`, `hybrid`; informational only, with no automatic dispatch. |
| SLA target | Optional pair: `response` or `resolution` + positive whole minutes. Both absent means inherit; zero does not mean inherit. |
| Form | Existing form required; fields are edited only in Intake Forms. |
| Category | Optional override of the form category; must belong to the same partner. |
| Work type | Optional default for time entries; otherwise the current category behavior applies. Same partner, and active in configuration. |
| Active / visible / order | Operational controls; starts hidden until explicitly published. |

Additional rules:

- The item has no priority of its own. The form's current priority and the requester's priority apply.
- Overriding the category in the catalog does not change the form or other tickets.
- A shared item links only to a shared form of the same partner. Organization-specific forms stay on the current path; replacing a form per organization requires another spec.
- The form's allowed-organization lists remain in effect.

---

## 6. Data model and isolation

The names are distinct from the commercial `catalog_items` table.

### 6.1 Configuration

- **`service_catalogs`**: `id`, `partner_id` / `org_id` (XOR), `name`, `is_active`, dates.
- **`service_catalog_items`**: `id`, `catalog_id`, `partner_id` / `org_id` (XOR), `name`, `description`, `pillar`, `service_line`, `itil_class`, `delivery`, `sla_target_kind`, `sla_target_minutes`, `form_id`, `category_id`, `work_type_id`, `is_active`, `show_in_portal`, `sort_order`, `version`, dates.

XOR: exactly one owner is set (partner or organization).

In the initial delivery, creation happens **only at the partner level**, with a single catalog per partner. The API does not create per-customer copies. Creation per organization depends on a resolution policy defined later.

The catalog and the item must have the same owner, enforced by database constraints. Form, category, and work type must belong to the same partner, using composite keys or references where applicable.

### 6.2 Contract access

**`service_catalog_entitlements`**: `id`, `org_id`, `partner_id`, `contract_id`, `item_id`, `created_at`, `updated_at`. Unique on (`contract_id`, `item_id`).

- Contract and organization must match; item, contract, and organization share the same partner.
- Access records do not copy the item configuration.
- No implicit access for everyone, and no direct grant unlinked from a contract.
- Several active contracts can grant the same item. Availability is the union of the grants, without duplicating the item.
- The historical record stores the IDs of the contracts that justified access. This **does not choose a billing contract**, does not allocate hours, and does not consume allowances.
- An empty list of grants never means access to everything.

### 6.3 Security and lifecycle

- Enable and force RLS together with table creation.
- Configuration uses the standard ownership policies plus the additional read access the organizations need.
- Being able to read the configuration does not grant contract access. The portal returns only authorized items.
- Customer sessions do not change configurations or grants.
- Shared changes require `canManagePartnerWidePolicies` and the domain permission; grants require contract management in that organization.
- Ownership is set at creation and does not change on partial update.
- New reads do not use system context. Context derives from authentication.
- Cover RLS, cascade deletion, merge and export of organizations, and ticket movement where applicable. Composite keys with organization follow the constraint deferral required by merges.
- Archiving an item does not invalidate tickets. Contract edits and expiration affect new requests and preserve history.
- Moving a ticket to another organization must not expose contract IDs of the previous organization. Historical access is not authorization in the destination organization.
- Physical deletion of a referenced row may clear the current link only if the historical copy is preserved. Define reference behavior before migrations.

This change does not include a migration. Implementation must read the migrations README and use names after the last published migration.

---

## 7. Access resolution

A single server-side resolver serves the portal list and detail, and catalog-based ticket creation.

An item is available only when:

1. The person can create tickets for the organization, under the current portal and Service Management rules.
2. The catalog and the item are active, belong to the partner of that organization, and are visible in the portal where applicable.
3. There is a grant for that organization with an eligible contract.
4. The form is active and available to the organization, respecting the allowed-organization list and portal visibility.

**Eligibility (suggestion given):** contract `active`, start on or before the organization's current local date, and end date absent or on or after that date. Dates are inclusive. Use the organization's time-zone resolver and its configured fallback, never the server's time zone.

Contracts in `draft`, `paused`, `cancelled`, and `expired` do not grant access. Do not infer access from invoices or `next_billing_at`.

**Revalidation:** access is revalidated on submission. Seen versions of the item and form detect concurrent changes without trusting the configuration sent by the customer. Changes return an identified conflict, letting the customer review the form and SLA and keep compatible answers.

**Transactional order:** creating and changing contracts, grants, and configuration needs a defined order. A revocation completed before the authoritative check must take effect. A successful creation records the state actually used. Locks and revalidation prevent a partially validated ticket.

Inaccessible IDs return unavailability without revealing data. The customer does not choose the organization, justifying contract, form, category, work type, SLA, or ITIL mapping.

---

## 8. Native creation and SLA

### 8.1 Common creation path

Add an optional `serviceCatalogItemId` to the existing submission. The endpoint and current fields stay for tickets outside the catalog.

The common service:

1. Resolves and authorizes the organization.
2. Resolves access and the current versions of the item and form.
3. Uses the linked form and validates answers with the existing validator.
4. Resolves the category: item override → form category, validating the partner.
5. Preserves priority, title, description, tags, and requester identification.
6. Resolves the SLA once, sets `work_kind` to `support`, and preserves historical metadata.
7. Creates the ticket, outbox entry, and audit record in the current transaction.

The server is authoritative: it rejects a divergent `formId` and catalog-controlled fields that conflict. The team can still create generic tickets within its permissions; this does not make the ticket an authorized catalog request.

`support` keeps on-demand services in the current SLA engine. It is different from the future ITIL ticket type and from the work type used in time entries.

### 8.2 SLA precedence

**Confirmed in code**, for tickets outside the catalog: category → organization override by priority → partner configuration by priority → internal default. This behavior is preserved.

**Suggestion given, for catalog tickets, per target:**

- Target selected on the item: organization override → item target → category → partner → internal default.
- Target not selected: current chain category → organization → partner → internal default.
- Item without a target: existing behavior for both.
- Later human edits follow the current permissions.

The interface must explain the exception to the normal chain. An empty field shows the inherited value and its origin.

Reuse `resolveSlaTargets` and the common resolver, extending the inputs without changing the worker. Store `response_sla_minutes` and `resolution_sla_minutes` at creation.

### 8.3 Protection against recalculation

- The selected target is protected from automatic recalculation by category or priority, including when it came from an organization override.
- The other target keeps the current behavior.
- Origin and protection per target are recorded in a reviewed extension of the provenance mechanism. Protection is not inferred from the historical copy alone, and an automatic default is not treated as a human edit.
- An authorized human edit replaces the value and origin and keeps the current protection of human edits.
- Archiving or removing the item does not clear the protection.
- Changing the service of an existing ticket is out of scope for this delivery.
- If the item has no configured target, no target receives catalog protection.
- Editing the catalog, contract, or form does not recalculate old targets. Current rules for business hours, elapsed time, pause, and breach still apply.

**Example:** "Adjust VLAN/Port" has a 240-minute resolution target. Without an organization override, resolution is 240 and response inherits the existing chain. With an explicit resolution override of 180, it uses 180. Changing the item to 300 later does not modify these tickets.

---

## 9. Traceability and work type

### 9.1 Creation evidence

Preserve `custom_fields.intakeForm`. Add `custom_fields.serviceCatalog`, written by the server, containing:

- item and catalog IDs, version, and name;
- pillar, service line, ITIL class, and delivery;
- form and form version, category, work type, and name;
- justifying contracts;
- SLA values and origins.

Prices and private contract terms are not exposed to the portal.

This copy is immutable creation evidence. An authorized SLA edit changes the current ticket and creates an audit record without rewriting the original values. The two structures must be merged, preserving the description and existing consumers.

### 9.2 Work type

Proposed default for time entries: explicit authorized choice (including `null`) → historical catalog work type → current category default.

- Revalidate the work type's use. If archived, use an existing valid alternative and show the reason.
- Do not modify a shared category, create a rate, bill hours, or treat delivery mode as a work type.
- The current creation has no dedicated labor work-type field. Preserve the difference between an omitted `workTypeId` and an explicit `null`. Review `apps/api/src/services/timeEntryService.ts` before changing rules for inactive defaults.

---

## 10. API and interface

Final permissions and route registration belong to the implementation plan. Reuse ticket and contract configuration permissions.

| Screen | Proposed behavior |
| --- | --- |
| Settings → Ticketing → Service Catalog | One partner configuration location; edit and publish items. Fields remain in Intake Forms. |
| Contract detail → Available services | Choose items for the organization; no copy of configurations or commercial lines. |
| Portal → New ticket → Services | Only released items, grouped by pillar and line, with search by activity; selection opens the existing form. |
| Generic ticket / current form | Existing behavior preserved. |
| Ticket detail | Service identity and delivery and SLA read-only; private access evidence omitted in the portal. |

**Proposed routes:**

- Team: `/service-catalog`, `/service-catalog/items`, `/contracts/:id/service-entitlements`.
- Portal (list and detail): `/portal/tickets/services` and `/portal/tickets/services/:id`, registered before dynamic ticket IDs.
- Submission: remains `POST /portal/tickets`.

Reuse request and response formats, pagination, errors, CSRF, session, and rate limits. List and detail use the same authorization. Responses contain only what is needed. Private per-customer caching does not authorize submission without revalidation.

Distinguish no services, loading, service unavailable, and infrastructure error. Unavailability does not silently create a generic ticket. Inputs are preserved after a validation failure.

Follow `runAction`, save conventions, transient state in the hash, navigation, accessibility, and `data-testid`.

### 10.1 Existing forms

Contract access controls the service path through the catalog and its configured commitment. Standalone forms and generic tickets keep their rules. Submitting only a `formId` does not grant the catalog's SLA or history.

A customer without access to the item can still open a generic ticket describing the same work. The proposal does not contractually forbid every free-text request.

---

## 11. Future ITIL integration

- #7900 will provide the mapping to ticket types. Names must align with the contract implemented at that time.
- Until then, tickets are generic and the ITIL class is descriptive only.
- #7901 and #7902 will define change and CAB fields in their own designs. This spec does not implement or approve changes.
- These dependencies do not block the catalog, access, and portal. Integration happens later, in a separate plan.

---

## 12. Pending maintainer decisions

| ID | Decision | Proposal |
| --- | --- | --- |
| R1 | XOR owner tables, or strictly partner-owned, in the first delivery? | XOR, with initial creation only at the partner level. If strictly partner-owned is preferred, record the exception before implementation. |
| R2 | Inclusive dates, union of contracts, and the contract requirement. | As described in section 7. The maintainer confirmed access by active contract, without detailing the edge rules. |
| R3 | Organization override above the item in SLA precedence, and protection against recalculation. | As described in section 8. The maintainer asked for SLA recording at creation, without defining precedence or later edits. |
| R4 | Does the work type fill time entries in this delivery, or stay as metadata only? | Time-entry default as in section 9.2, with a separate change if needed. |
| R5 | Does the linked form remain separately visible in the current selector? | Acceptable in the first delivery. Requiring a contract for every form would change current behavior. |

---

## 13. Acceptance criteria

| Case | Required result |
| --- | --- |
| Shared catalog | Two authorized organizations reuse the same item, with no per-customer copies. |
| Cross-partner references | Database and application reject a form, category, work type, contract, or organization from another partner. |
| RLS with real `breeze_app` | Improper reads and forged writes are denied; ownership and XOR are enforced. |
| No grant or wrong organization | Item absent and direct submission denied, without disclosing another organization's configuration. |
| Contract lifecycle | Ineligible status and dates deny access; limits tested in the organization's time zone. |
| Several contracts | One item; removing a grant keeps access if another grant remains valid. |
| Form restrictions | An inactive, internal, or organization-excluding form denies use even with a grant. |
| Tampered submission | Forged fields do not change the authoritative mapping. |
| SLA resolution | Selected target, organization override, other target inherited, `null`, and invalid or zero minutes tested. |
| SLA recalculation | Protected target remains; the other target and generic tickets keep current behavior. |
| History | Renaming, archiving, or expiring a grant does not rewrite evidence or targets. |
| Concurrency | Revocation or edit versus creation has a tested transactional result; rollback leaves no ticket or outbox entry. |
| Work type | Explicit choice wins; agreed default and inactive-alternative fallback tested. |
| Portal regressions | Session, CSRF, Service Management, generic forms, and requester preserved. |
| Lifecycle | Organization and ticket deletion, merge, export, and movement covered. |

**Tests:** unit, API, and shared tests cover resolution and validation. Real PostgreSQL proves RLS and references; mocks are not enough. Portal components and Playwright cover service → form → ticket, negative cases, and the generic flow. Reuse existing SLA recalculation tests.

**In this PR (documentation only):** verify Markdown, references, scope traceability, and changes. Execution and build tests do not apply, since there is no executable code.

---

## 14. Proposed delivery sequence

1. Maintainer review, including R1 to R5.
2. Implementation plan with accepted decisions, isolated steps, and verifications.
3. Configuration and grants, with RLS and lifecycle coverage.
4. Mapping in the common creation path, SLA protection, and history.
5. Portal navigation and end-to-end validation.
6. Later integration with #7900 and, if approved, change and CAB in separate work.

This is a proposed sequence without a schedule. The specification PR must use `Refs #8325` and state that it delivers only the design, without closing the feature.