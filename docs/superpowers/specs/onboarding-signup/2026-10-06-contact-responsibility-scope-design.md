# Contact Responsibility and Scope — Design

**Date:** 2026-10-06  
**Status:** Draft — revised after maintainer review; awaiting approval before implementation
**Discussion:** #7891  
**Related:** `2026-08-09-organization-contacts-design.md`

## Summary

Evolve Breeze contacts so the product can represent not only **who a contact is**, but also **what responsibility that contact owns and where that responsibility applies**.

Breeze already has first-class `contacts` and currently stores responsibilities in `contacts.roles[]`. That is sufficient for simple organization-level classification, but it cannot safely express cases such as:

- a technical contact responsible only for one site;
- a technical contact responsible for a specific device group;
- an after-hours contact valid for the whole organization;
- multiple contacts sharing the same responsibility at the same scope;
- deterministic “who should I contact?” resolution for operational context;
- reuse of contact responsibility by reports, workflows, automations, escalation, and future AI tools.

This design normalizes responsibilities into a new `contact_roles` table. Each row represents:

```text
Contact
  +
Responsibility
  +
Scope
```

V1 supports three scopes:

```text
Organization
Site
Device Group
```

Device-level responsibility is explicitly deferred.

Resolution uses specificity precedence:

```text
Device Group
    ↓
Site
    ↓
Organization
```

The most-specific level with one or more matches wins. If multiple contacts match at the same level, all of them are returned.

`contact_roles` becomes the canonical source for scoped responsibilities. `contacts.roles[]` remains temporarily as a compatibility projection while existing readers and writers are migrated.

V1 must include at least one real operational consumer of the resolver so this does not land as unused infrastructure. **Report Series** is the named V1 consumer.

The implementation order is now fixed: **backend/resolver and authorization-sensitive consumers first; scoped editing UI follows only after the authorization boundary is safe** (§14, §28).

## Context — verified against the current contact model and Discussion #7891

The current contact model already provides the person record and customer association. Simplified:

```text
contacts
├── id
├── org_id
├── site_id nullable
├── name
├── email
├── phone
├── roles[]
├── is_primary
└── ...
```

Current roles include:

```text
billing
technical
escalation
admin
site
after_hours
portal
```

The UI label currently shown as **Local** maps semantically to the `site` role.

The current model can represent `Contact A = technical`, but it cannot safely represent all of these at once without duplicating contacts or overloading `contacts.site_id`:

```text
Contact A  technical  Organization
Contact B  technical  Site São Paulo
Contact C  technical  Device Group Servers
```

Discussion #7891 established that the right direction is to **evolve contacts**, not create a parallel “operational contact” entity. The original Organization Contacts design already anticipated eventual normalization of `contacts.roles[]` into a child table; this design formalizes that evolution and adds scope.

---

## 0. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Base entity | **Evolve `contacts`; do not create a second operational-contact entity** | Responsibility belongs to the existing contact identity. |
| Responsibility source of truth | **New `contact_roles` table** | Enables per-role scope, real FKs, and deterministic resolution. |
| V1 scopes | **Organization, Site, Device Group** | All three are already meaningful tenant objects in Breeze. |
| Device scope | **Deferred** | Device user/owner identity is not the same concept as operational responsibility. |
| Organization scope encoding | **`site_id` and `device_group_id` both NULL** | Avoids a redundant `scope_type` column that could disagree with FK state. |
| Site scope | **`site_id` populated** | FK enforces object and tenant validity. |
| Device Group scope | **`device_group_id` populated** | FK enforces object and tenant validity. |
| Multiple scopes | **Multiple rows** | One row remains one responsibility assignment at one scope. |
| Resolution precedence | **Device Group → Site → Organization** | Most-specific assignment wins. |
| Same-level matches | **Return all** | Multiple valid responsible contacts may intentionally exist. |
| `contacts.roles[]` | **Temporary compatibility projection** | Existing consumers and writers must not break during transition. |
| Existing site association | **Preserve during backfill; keep `contacts.site_id` distinct from responsibility scope afterward** | Prevents accidental authority widening while allowing explicit responsibility scope. |
| Scoped-write gate | **No Site/Group writes until authorization-sensitive consumers read `contact_roles`** | Prevents a scoped `admin` from becoming org-wide through the legacy projection. |
| Scope deletion | **`ON DELETE CASCADE` for Site and Device Group assignment FKs** | Deleting a scope deletes the assignment instead of widening it to Organization. |
| Nested groups | **Parent assignments apply transitively; nearest matching group wins** | Device groups nest via `parent_id`; inherited responsibility must be deterministic. |
| Delivery order | **Backend/resolver first; UI follow-up** | Isolates migration and authorization-sensitive behavior before exposing scoped writes. |
| `approver` role | **Deferred** | No concrete current consumer justifies adding it yet. |
| Escalation model | **Reuse existing `escalation_policies`** | Do not create a parallel escalation subsystem. |
| Editing home | **Organization → Contacts** | Follows “one concept, one home”. |
| Other surfaces | **Read-only resolved output** | Site/Group/Device views consume resolution but do not configure it. |
| Tenancy | **Shape 1, `org_id NOT NULL`** | Responsibility assignments are customer data, not partner-wide configuration. |

## 1. Goals

V1 must:

1. normalize contact responsibilities into `contact_roles`;
2. associate each responsibility with Organization, Site, or Device Group scope;
3. preserve existing responsibility semantics during migration;
4. make cross-organization scope references impossible at the database layer;
5. establish one canonical scope resolver;
6. define deterministic specificity and fallback behavior;
7. preserve compatibility with existing `contacts.roles[]` readers during migration;
8. update all current role writers so compatibility cannot drift;
9. define how current role consumers interpret scoped responsibilities;
10. preserve caller-verification authorization boundaries;
11. provide at least one real operational consumer for the resolver;
12. participate correctly in RLS, tenant cascade, organization merge, and tenant export contracts.

## 2. Non-Goals

The following are explicitly outside V1:

- responsibility scoped directly to an individual Device;
- replacing `devices.primary_contact_id` or defining device-user ownership;
- introducing an `approver` responsibility;
- building a new Escalation Plan model;
- replacing `escalation_policies`;
- implementing approval workflows;
- SOP orchestration;
- playbook execution driven directly by responsibility;
- after-hours schedules/calendars;
- timeout-based notification sequencing;
- partner-wide contact responsibilities;
- changing the identity model of `contacts`;
- removing `contacts.roles[]` in the same change.

These capabilities may consume the resolver later, but they must not expand the initial implementation.

## 3. Terminology

### 3.1 Contact

A customer-side person or identity represented by `contacts`.

### 3.2 Responsibility

The function a contact fulfills. V1 reuses the existing role vocabulary, for example:

```text
technical
billing
admin
site
after_hours
escalation
portal
```

### 3.3 Scope

The resource boundary within which a responsibility applies:

```text
Organization
Site
Device Group
```

### 3.4 Assignment

One `contact_roles` row, for example:

```text
Maria Silva
technical
Device Group: Servers
```

### 3.5 Resolved Contact

A contact returned by the canonical responsibility resolver for a responsibility plus target context.

Example:

```text
resolve technical for Device X
→ Device X belongs to Group Servers
→ technical @ Servers
→ Maria Silva
```

## 4. Data Model

### 4.1 `contact_roles`

Introduce an org-scoped table representing one responsibility assignment per row.

Conceptual schema:

```sql
CREATE TABLE IF NOT EXISTS contact_roles (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       uuid NOT NULL,
  org_id           uuid NOT NULL,
  role             text NOT NULL,
  is_primary       boolean NOT NULL DEFAULT false,
  site_id          uuid,
  device_group_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT contact_roles_contact_org_fk
    FOREIGN KEY (contact_id, org_id)
    REFERENCES contacts (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,

  CONSTRAINT contact_roles_site_org_fk
    FOREIGN KEY (site_id, org_id)
    REFERENCES sites (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE,

  CONSTRAINT contact_roles_device_group_org_fk
    FOREIGN KEY (device_group_id, org_id)
    REFERENCES device_groups (id, org_id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);
```

The implementation must verify the actual `(id, org_id)` unique constraints and schema names on `contacts`, `sites`, and `device_groups` before authoring the migration rather than assuming them.

### 4.2 Scope Constraint

A responsibility assignment may target at most one explicit subordinate scope. This is invalid:

```text
site_id != NULL
AND
device_group_id != NULL
```

Conceptually:

```sql
CHECK (
  NOT (
    site_id IS NOT NULL
    AND device_group_id IS NOT NULL
  )
)
```

Interpretation:

```text
site_id NULL + device_group_id NULL  => Organization
site_id SET  + device_group_id NULL  => Site
site_id NULL + device_group_id SET   => Device Group
```

V1 should not store a separate `scope_type` column because that would duplicate information already represented by the FK columns and create a second source of truth.

### 4.2.1 Role Vocabulary Constraint

The database must also protect the existing role vocabulary rather than relying only on application validation. Conceptually:

```sql
CHECK (role IN ('billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal'))
```

If Breeze already exposes a canonical shared role definition, implementation must keep the application validator and database CHECK aligned.

### 4.3 Organization Scope

Organization scope is represented by both subordinate FK columns being NULL.

### 4.4 Site Scope

Site scope is represented by `site_id` populated and `device_group_id` NULL.

### 4.5 Device Group Scope

Device Group scope is represented by `device_group_id` populated and `site_id` NULL.

### 4.6 Device Groups Are Not a Strict Child of Site

The resolver must not assume this is always a strict ownership tree:

```text
Organization
  → Site
    → Device Group
```

`device_groups.site_id` can be nullable, and groups may be dynamic. Group and Site therefore remain independent candidate scopes during resolution. A Group match outranks a Site match for specificity, but the model must not require every Device Group to belong to a Site.

Device Groups also nest through `device_groups.parent_id`. A responsibility assigned to a parent group applies transitively to devices in descendant groups. Within the Device Group specificity level, resolution prefers:

```text
direct matching group
> nearest matching ancestor
> more distant ancestor
```

If multiple unrelated groups match at the same effective specificity, all applicable contacts are returned and deduplicated by contact identity.

## 5. Uniqueness and Assignment Semantics

The database must prevent accidental exact duplicate assignments. PostgreSQL 16 is the project floor, so use `UNIQUE NULLS NOT DISTINCT` over the exact assignment key:

```sql
UNIQUE NULLS NOT DISTINCT (org_id, contact_id, role, site_id, device_group_id)
```

The same combination of organization, contact, role, and exact scope therefore cannot appear twice.

The model must still allow:

```text
Contact A technical @ Organization
Contact B technical @ Organization
```

and:

```text
Contact A technical @ Site A
Contact A technical @ Site B
```

Multiple contacts for the same responsibility and scope are valid. Multiple scopes for the same contact and role are also valid.

## 6. `is_primary`

`is_primary` belongs to the responsibility assignment, not globally to the contact.

That allows future semantics such as:

```text
Technical @ Organization
  Primary: Maria
  Additional: John

Technical @ Site A
  Primary: Robert
```

This must not be conflated with legacy `contacts.is_primary`, whose existing compatibility semantics remain separate unless a later design explicitly changes them.

If no current V1 consumer needs per-role primacy, the column may remain structurally available while resolution continues to return all same-level matches.

V1 does **not** add a partial unique index for `is_primary`. If a future consumer requires one-primary-per-scope uniqueness, `contact_roles` must use a `custom` organization-merge policy comparable to `contacts` rather than plain repointing, because two source rows may otherwise collide during merge.

## 7. Migration and Backfill

The migration must be hand-written, idempotent, and ordered after the latest committed migration according to the repository's migration rules.

The implementation must inspect the current migration ceiling immediately before choosing the migration filename; today's calendar date must not be assumed to sort last.

The migration must not contain its own inner `BEGIN`/`COMMIT` block.

### 7.1 System Scope

Because the migration will backfill tenant rows, it must elect system scope before tenant writes as required by the migration RLS contract.

Conceptually:

```sql
SELECT set_config('breeze.scope', 'system', true);
```

must occur before the first protected `INSERT`, `UPDATE`, `DELETE`, or equivalent write.

### 7.2 Existing Roles

Every role currently present in `contacts.roles[]` must produce corresponding `contact_roles` rows.

### 7.3 Existing Contacts Without Site

For contacts where:

```text
contacts.site_id IS NULL
```

existing roles are backfilled as Organization scope.

Example:

```text
Maria
roles = ['technical', 'billing']
site_id = NULL
```

becomes:

```text
Maria technical @ Organization
Maria billing   @ Organization
```

### 7.4 Existing Contacts With Site

For contacts where:

```text
contacts.site_id = Site A
```

existing roles must retain Site scope.

Example:

```text
Robert
roles = ['admin']
site_id = Site A
```

becomes:

```text
Robert admin @ Site A
```

It MUST NOT become:

```text
Robert admin @ Organization
```

because that would silently widen authority. This is a security-sensitive migration invariant.

After backfill, `contacts.site_id` remains a contact-affiliation/primacy field, while `contact_roles` carries responsibility scope. A site-pinned contact may explicitly hold an Organization-scoped role, a role at its pinned Site, a role at another Site in the same Organization, or a Device-Group role. Changing `contacts.site_id` does **not** rewrite existing `contact_roles`; responsibility scope changes require an explicit responsibility mutation.

### 7.5 Backfill Observability

The migration should report meaningful row counts according to Breeze migration conventions. At minimum, implementation should make it possible to determine:

- contacts examined;
- assignments created;
- unknown or malformed role values encountered;
- rows that could not be migrated, if any.

The migration must not silently broaden or discard responsibilities.

## 8. Source of Truth and Compatibility

### 8.1 New Source of Truth

After migration and application changes, `contact_roles` becomes the canonical model for scoped responsibilities.

All new scope-aware code must read from `contact_roles`.

### 8.2 `contacts.roles[]` Compatibility Projection

`contacts.roles[]` is not removed in V1.

During transition it represents the distinct set of responsibilities assigned to a contact regardless of scope.

Example:

```text
Maria technical @ Site A
Maria technical @ Site B
Maria billing   @ Organization
```

projects to:

```text
contacts.roles = ['technical', 'billing']
```

Scope information is intentionally lost in this legacy projection.

Therefore, **no new scope-aware authorization or routing behavior may read `contacts.roles[]`.**

### 8.3 Dual Write

Every mutation path that creates, updates, or removes contact responsibilities must maintain the legacy projection in the same transaction until all legacy readers are migrated.

The application must not commit a state where `contact_roles` and `contacts.roles[]` visibly disagree.

Conceptually:

```text
contacts.roles[]
=
DISTINCT roles from contact_roles for that contact
```

If any existing API contract depends on stable role ordering, the projection order must be deterministic.

### 8.4 Hard Gate for Scoped Writes

No write path except the migration backfill may write a non-Organization scope until all legacy writers are dual-writing to `contact_roles` and the authorization/routing-sensitive readers have migrated away from `contacts.roles[]` to explicit scope-aware reads. This gate covers at minimum:

```text
Caller Verification
Org Account Readiness
Billing contact resolution
Report Series recipients
```

Writer migration and atomic dual-write must land before any of these readers switch to `contact_roles`; otherwise `contact_roles` can become stale while a migrated reader treats it as authoritative. After the readers switch, this gate prevents a scoped assignment such as `admin @ Site X` or `billing @ Site X` from being flattened into `roles[]` and interpreted as organization-wide authority or routing.

## 9. Writer Inventory

Before implementation is considered complete, perform a repository-wide sweep of every writer of `contacts.roles`.

Known production writers are explicitly:

- `apps/api/src/services/contacts/crud.ts`;
- `compat.ts:159-163`, which directly inserts Site contacts with `roles: ['site']`;
- the direct legacy JSONB synchronization paths in `compat.ts`, including `array_remove`;
- `loginLink.ts` direct role writes;
- `import.ts:864-872`, which directly inserts contacts.

`aiToolsOrgs.ts`, `routes/orgContacts.ts`, and `routes/reports/recipients.ts` call the Contacts service's `createContact` path and are therefore not separate direct writers.

Implementation must still perform a repository-wide sweep so this list is verified against the branch at implementation time rather than treated as permanently exhaustive.

Each writer must be explicitly classified as:

```text
migrated to contact_roles
compatibility-only
removed
not applicable
```

Any production path that continues writing only `contacts.roles[]` after `contact_roles` becomes source of truth is a correctness bug.

## 10. Canonical Responsibility Resolver

There must be **one resolver per concept**, reused by every consumer. Precedence logic must not be independently reimplemented in reports, UI, caller verification, automation, or AI tools.

Conceptual interface:

```ts
resolveContactResponsibility({
  orgId,
  role,
  siteId?,
  deviceGroupIds?,
  deviceId?,
})
```

Exact naming and request shape should follow existing service conventions.

### 10.1 Resolution Algorithm

For one requested responsibility:

#### Step 1 — Device Group

If the target context is associated with one or more Device Groups, find role assignments for those groups.

If one or more matches exist, return all same-level matches and stop.

#### Step 2 — Site

If no Device Group match exists and a Site context exists, find assignments for that Site.

If one or more matches exist, return all same-level matches and stop.

#### Step 3 — Organization

If no more-specific match exists, find Organization-scoped assignments.

Return all matches.

#### Step 4 — No Match

If no assignment exists, return an empty result.

There is no implicit fallback to arbitrary contacts or to legacy `contacts.site_id` outside this resolver contract.

### 10.2 Precedence

Canonical precedence is:

```text
Device Group
    >
Site
    >
Organization
```

This is specificity precedence, not display sorting.

Example:

```text
John  technical @ Organization
Mary  technical @ Site SP
Peter technical @ Servers
```

For a device in `Servers` located at Site SP, the result is Peter, not Peter + Mary + John.

For a device at Site SP without a matching Group assignment, the result is Mary.

For a context with neither matching Group nor matching Site assignment, the result is John.

### 10.3 Multiple Same-Level Matches

If both of these exist:

```text
Peter technical @ Servers
Maria technical @ Servers
```

both are returned. The resolver must not arbitrarily select the first database row.

### 10.4 Multiple and Nested Device Groups

A device may match multiple groups, and groups may be nested. For each membership path, a direct assignment outranks an assignment inherited from a parent; among ancestors, the nearest matching ancestor wins.

Assignments from unrelated groups at the same effective specificity are considered the same specificity level and are all returned. Resolved user-facing results must be deduplicated so a contact reached through multiple matching groups does not unintentionally appear twice.

### 10.5 Dynamic Groups

Dynamic group membership is evaluated at resolution time. Responsibility remains attached to the Device Group entity and is not snapshotted onto individual devices.

### 10.6 Local (`site`) at Organization Scope

A `site` responsibility at Organization scope means **the Organization's default Local contact**. It is used only when no more-specific `site` assignment exists for the target Site. A Site-scoped Local assignment therefore overrides the Organization default for that Site. This preserves existing unpinned `site` contacts without inventing a Site association during backfill.

## 11. Existing Consumer Semantics

Adding scope changes the meaning of current roles. Existing consumers must not infer semantics independently.

Every current reader of roles must be inventoried and classified. Known consumers include at least:

```text
Caller Verification
Report Series
Account Readiness
Billing compatibility
Portal login/linking
```

### 11.1 Caller Verification

Caller verification is security-sensitive.

An `admin @ Organization` assignment may continue to participate in organization-level authorization where current behavior permits it.

However:

```text
admin @ Site
admin @ Device Group
```

MUST NOT automatically become organization-level authorizers.

For example, `Carlos admin @ Site Rio` must not gain organization-wide authorization simply because the compatibility projection contains `roles[] = ['admin']`.

Caller verification must therefore migrate away from the legacy roles projection for authorization decisions and use explicit scope semantics **before Site- or Device-Group-scoped writes are enabled anywhere in the application**.

After this migration, an explicit `admin @ Organization` assignment is authoritative even when the contact has `contacts.site_id` set. The Site pin remains contact affiliation/primacy metadata; it does not suppress an explicitly Organization-scoped admin responsibility. This is an intentional change from the legacy `contact.siteId === null` authorization check and must be covered by regression tests.

### 11.2 Account Readiness

If readiness asks whether an organization has a billing contact, the consumer must define whether that means specifically `billing @ Organization` or any billing assignment.

V1 contract: organization-level readiness checks require an Organization-scoped assignment unless the consumer is explicitly evaluating a Site.

This migration must land before Site- or Device-Group-scoped writes are enabled. It prevents `billing @ one site` from implying organization-wide billing coverage.

### 11.3 Billing Compatibility

Where billing logic needs an organization-level billing identity, it must resolve `billing @ Organization` rather than treating any billing role as organization-wide. The current billing-contact reader in `apps/api/src/services/contacts/compat.ts` must migrate before Site- or Device-Group-scoped writes are enabled so `billing @ Site X` cannot become the Organization invoice recipient through the legacy projection.

### 11.4 Portal Linking

The existence of a `portal` responsibility does not itself change authentication or portal authorization semantics. Contact responsibility scope and login identity remain separate concerns. Any authorization expansion requires its own security design.

### 11.5 Report Series

Report Series is the V1 operational consumer. Its current recipient lookup reads `contacts.roles[]` without scope, so it must migrate to the canonical resolver before Site- or Device-Group-scoped writes are enabled.

Conceptually:

```text
Organization report
→ organization context

Site report
→ Site context

Device/Group-oriented report
→ Group > Site > Organization resolution
```

The exact role-to-recipient mapping remains part of implementation planning for the existing report contract.

## 12. UI and Operational Consumer

The responsibility model should not land as infrastructure with no product consumer.

### 12.1 Configuration Home

Following Breeze's **one concept, one home** rule, responsibility assignments are edited only under:

```text
Organization
  → Contacts
```

A responsibility editor should conceptually support:

```text
Responsibility: Technical
Scope: Organization
```

or:

```text
Responsibility: Technical
Scope: Site
Site: São Paulo
```

or:

```text
Responsibility: Technical
Scope: Device Group
Device Group: Servers
```

Multiple assignments are represented as multiple rows.

### 12.2 No Duplicate Editors

Do not create separate responsibility editors under Site, Device Group, or Device. Those surfaces consume resolved information; they do not own configuration.

### 12.3 Who to Contact

A read-only operational component may display resolved contacts, for example:

```text
Who to Contact

Technical
Maria Silva
Servers

After Hours
João Santos
Entire Organization

Local Contact
Carlos Souza
São Paulo
```

The component should expose enough scope context to explain why a contact was selected without leaking implementation details.

### 12.4 Candidate Surfaces

Potential V1 read-only surfaces include:

```text
Site details
Device details
Device Group details
```

The exact frontend scope is intentionally left for maintainer decision in §14.

## 13. Escalation Integration — Future Consumer, Not V1

Do not introduce a second escalation subsystem.

Breeze already has `escalation_policies`. A future evolution may allow escalation steps to resolve customer responsibilities using the same canonical resolver.

Example:

```text
Escalation Policy

Step 1
→ customer responsibility: technical

Step 2
→ customer responsibility: after_hours

Step 3
→ internal staff/channel
```

This integration is explicitly outside V1.

## 14. Frontend Delivery Decision — Backend/Resolver First

Maintainer review selects **backend/resolver first, frontend follow-up**. This is no longer an open product-scope question.

The first implementation PR contains:

```text
schema
migration/backfill
RLS/tenancy
compatibility
canonical resolver
Caller Verification migration
Org Account Readiness migration
API/backend contract
Report Series as a real scope-aware consumer
```

A follow-up PR may then add:

```text
Organization → Contacts responsibility editor
Who to Contact read-only UI
```

The scoped editor must not be exposed until the authorization-sensitive consumers are reading `contact_roles`; this sequencing is a security invariant, not merely a review-size preference.

## 15. Approver — Deferred

Do not introduce an `approver` responsibility in V1.

Approval responsibilities should be introduced only alongside a concrete approval consumer. A future design may need distinctions such as financial, technical, or administrative approvers; that vocabulary should be driven by the actual approval workflow rather than pre-created speculatively.

## 16. Device-Level Responsibility — Deferred

V1 does not provide `technical @ Device X`.

Existing or proposed device-person relationships answer questions such as “who uses this device?” They do not necessarily answer “who is operationally responsible for this device?” Those concepts must not be conflated.

If device-level responsibility is introduced later, it should extend the scope model explicitly and define precedence in a dedicated follow-up design, likely:

```text
Device
>
Device Group
>
Site
>
Organization
```

## 17. Delete Semantics

Scope deletion must never silently broaden responsibility. V1 pins the lifecycle behavior rather than leaving it open.

### 17.1 Contact Deleted

Deleting a contact removes its responsibility assignments through `contact_roles.contact_id ON DELETE CASCADE`, subject to the existing Contact deletion contracts.

### 17.2 Site Deleted

`contact_roles.site_id` uses the composite `ON DELETE CASCADE` FK. Deleting a Site therefore deletes assignments scoped to that Site. It MUST NOT turn `technical @ Site A` into `technical @ Organization`.

Site deletion already cascades to site-pinned contacts through the existing `contacts_site_org_fk`; the new role assignment follows the same no-widening principle.

### 17.3 Device Group Deleted

`contact_roles.device_group_id` uses the composite `ON DELETE CASCADE` FK. Deleting a Device Group therefore deletes assignments scoped to that Group; the Contact and any other assignments remain.

All Device Group deletes already converge through `deleteDeviceGroup`; no separate ad-hoc cleanup path should be introduced.

## 18. Tenancy and RLS

`contact_roles` is customer data and uses tenancy Shape 1:

```text
org_id NOT NULL
```

The table must enable and force RLS in the same migration that creates it.

Policy must be based on:

```text
breeze_has_org_access(org_id)
```

Application-layer filtering is not an acceptable substitute for RLS.

### 18.1 Composite FKs

Relationships that carry tenant identity must make cross-tenant references unrepresentable at the database layer:

```text
(contact_id, org_id)
→ contacts(id, org_id)

(site_id, org_id)
→ sites(id, org_id)

(device_group_id, org_id)
→ device_groups(id, org_id)
```

Applicable composite FKs MUST be `DEFERRABLE INITIALLY IMMEDIATE` so organization merge can defer them while repointing parent and child rows.

### 18.2 Organization Merge

The table must preserve valid references when an organization merge/rewrite occurs under the existing lifecycle contract. This must be tested against real PostgreSQL, not only mocked/unit behavior.

Because V1 does not add a partial unique index for `is_primary`, normal repoint semantics are sufficient unless implementation discovers another collision-producing constraint. If future work adds one-primary-per-scope uniqueness, `contact_roles` must move to a `custom` merge policy like `contacts`.

### 18.3 Device Organization Moves

No extra device-move integration is required. A Device that moves organizations already drops its Device Group memberships, and `contact_roles` has no `device_id`, so the table stays out of the device-move rewrite lists.

## 19. Tenant Cascade and Erasure

Because `contact_roles` has `org_id`, it must be registered in `CORE_ORG_CASCADE_DELETE_ORDER` at the correct child-before-parent position.

Do not treat alphabetical position alone as sufficient; verify FK direction.

Organization deletion must leave no orphaned responsibility rows and must not fail because the new table was omitted from the cascade contract.

## 20. Tenant Export Policy

`contact_roles` must be registered in `CORE_TENANT_EXPORT_POLICY`.

Every column must be classified. Ordinary customer-data fields are expected to include:

```text
id
contact_id
org_id
role
is_primary
site_id
device_group_id
created_at
updated_at
```

No new `json`, `jsonb`, or `bytea` open container is introduced by this design.

Tenant export/erasure round-trip must include scoped responsibility assignments according to the existing export contract.

## 21. API Contract

Routes should remain within the existing Contacts domain rather than create an unrelated top-level subsystem.

A conceptual API representation may use a discriminated scope object even though the database does not persist `scope_type`:

```json
{
  "responsibilities": [
    {
      "role": "technical",
      "scope": {
        "type": "organization"
      }
    },
    {
      "role": "after_hours",
      "scope": {
        "type": "site",
        "siteId": "..."
      }
    },
    {
      "role": "technical",
      "scope": {
        "type": "device_group",
        "deviceGroupId": "..."
      }
    }
  ]
}
```

The API representation should make invalid combinations structurally difficult to express.

Validation must reject at least:

- Site and Device Group simultaneously;
- Site from another organization;
- Device Group from another organization;
- unsupported role;
- unsupported scope type;
- malformed duplicate assignment where prohibited by the final uniqueness contract.

## 22. Resolved Read Contract

Operational consumers should not reconstruct precedence directly from raw assignments.

Only if required by actual consumers, expose a resolved read contract backed by the canonical resolver.

Conceptual result:

```json
{
  "role": "technical",
  "resolvedScope": {
    "type": "device_group",
    "id": "...",
    "name": "Servers"
  },
  "contacts": [
    {
      "id": "...",
      "name": "Maria Silva",
      "email": "maria@example.com"
    }
  ]
}
```

Consumers must be able to distinguish configured assignments from a responsibility resolved for a specific context. They are different concepts and should not be conflated in API semantics.

## 23. Security Requirements

This feature affects authorization-adjacent customer data. The following invariants are mandatory:

1. a Site assignment never gains Organization authority through migration or fallback;
2. a Device Group assignment never gains Organization authority through deletion;
3. legacy `contacts.roles[]` must not be used to infer scope-aware authorization;
4. cross-org Contact, Site, or Device Group assignments are impossible at the database layer;
5. resolver queries execute inside the correct tenant DB access context;
6. an org-scoped requester cannot resolve contacts from another organization;
7. caller-verification behavior is covered by explicit regression tests;
8. compatibility dual-write is atomic.

A resolver/database failure must never silently fall back to a broader scope for authorization-sensitive behavior.

## 24. Testing

### 24.1 Migration Tests

Cover at minimum:

- migration idempotency;
- Organization-scope backfill;
- Site-scope backfill;
- contacts with multiple roles;
- no authority widening during backfill;
- required RLS policies;
- composite FK behavior;
- required deferrability;
- scope constraint behavior;
- role-vocabulary CHECK behavior;
- `UNIQUE NULLS NOT DISTINCT` exact-duplicate behavior;
- Site/Device Group `ON DELETE CASCADE` behavior;
- tenant cascade registration;
- tenant export registration;
- organization merge behavior.

### 24.2 Resolver Tests

Minimum matrix:

```text
Organization only
Site overrides Organization
Group overrides Site
Group overrides Organization
Site fallback when no Group match
Organization fallback when no Group/Site match
No match
Multiple same-level contacts
Multiple matching groups
Parent Group assignment applies to descendant Group devices
Direct child Group assignment overrides inherited parent assignment
Nearest matching ancestor wins over a more distant ancestor
Same contact across multiple matching groups is deduplicated
Different roles resolve independently
```

### 24.3 RLS Integration Tests

Using real PostgreSQL, prove:

- org A can create/read/update/delete assignments for org A;
- org A cannot access assignments for org B;
- cross-org `contact_id` forge fails;
- cross-org `site_id` forge fails;
- cross-org `device_group_id` forge fails;
- organization merge preserves valid assignments;
- organization erasure removes assignments.

### 24.4 Caller Verification Regression

Explicitly prove that:

```text
admin @ Organization
```

retains expected existing organization-level behavior where currently permitted.

Also prove that:

```text
admin @ Site
admin @ Device Group
```

do not authorize an organization-level protected operation solely because the compatibility projection still contains `admin`.

### 24.5 Compatibility Tests

Prove dual-write behavior:

```text
create first technical assignment
→ contacts.roles[] contains technical

create second technical assignment at another scope
→ contacts.roles[] still contains one technical value

remove one of multiple technical assignments
→ technical remains in contacts.roles[]

remove last technical assignment
→ technical is removed from contacts.roles[]
```

### 24.6 API Validation Tests

Cover invalid inputs including:

- Site + Device Group simultaneously;
- foreign-org Site;
- foreign-org Device Group;
- unsupported role;
- unsupported scope;
- duplicate exact assignment where prohibited by the final uniqueness contract.

### 24.7 Frontend Tests

If frontend is included in the first implementation PR, cover at least:

- existing assignments render correctly;
- Organization scope requires no subordinate selector;
- Site scope requires a Site;
- Device Group scope requires a Group;
- editing exists only under Contacts;
- operational Who to Contact surfaces are read-only;
- resolved scope/fallback displays correctly;
- mutations use the standard `runAction` feedback path.

## 25. Failure Semantics and Observability

Resolver behavior must distinguish:

```text
no matching assignment exists
```

from:

```text
resolution/query failed
```

No-match is a valid business result and should normally produce an empty result.

A database or resolver failure must not silently broaden the lookup to Organization scope because that can route sensitive operational behavior to the wrong customer contact.

Logging and error reporting should follow existing service conventions and avoid logging unnecessary contact PII.

## 26. Performance

Responsibility cardinality is expected to remain small relative to Devices, but the resolver may be called by operational pages, report generation, and future workflow consumers.

Indexes should support the actual implementation queries, expected to include combinations equivalent to:

```text
org_id + role
site_id + role
device_group_id + role
contact_id
```

Final index definitions must follow actual query plans rather than this conceptual list blindly.

Avoid per-device N+1 responsibility lookups in fleet/list views. Bulk consumers should resolve in batches where appropriate.

## 27. Future Consumers

The scoped responsibility model is intentionally reusable. Expected future consumers may include:

```text
Escalation Policies
Notifications
SOP execution
Playbooks
Service Delivery workflows
Customer approvals
Breeze Assistant
AI tools
Ticket routing
Operational reporting
```

Future consumers must call the canonical resolver rather than introduce another scope-precedence implementation.

## 28. Recommended Implementation Sequence

The sequence is security-significant. Scoped editing must not be enabled early.

### Phase 1 — Persistence, Safe Backfill, and Writer Compatibility

```text
contact_roles
role vocabulary CHECK
UNIQUE NULLS NOT DISTINCT
RLS
composite DEFERRABLE FKs
Site/Group ON DELETE CASCADE
migration/backfill
cascade/export/merge contracts
explicit legacy-writer migration/classification
atomic dual-write / compatibility projection
```

All production writers must maintain `contact_roles` and `contacts.roles[]` consistently before any reader is switched to `contact_roles`. No general Site/Group scoped editing is exposed in this phase.

### Phase 2 — Resolver and Scope-Sensitive Readers

```text
canonical resolver
caller verification scope semantics
Org Account Readiness scope semantics
Billing contact resolution
Report Series recipient resolution
```

This phase must complete before any write path except migration backfill may create a non-Organization scope.

### Phase 3 — V1 Consumer Validation and Compatibility Verification

```text
Report Series V1 consumer validation
legacy writer re-sweep
dual-write consistency verification
```

### Phase 4 — Product Surface

Only after Phases 1–3:

```text
Organization → Contacts responsibility editor
Who to Contact read-only UI
```

## 29. Acceptance Criteria

Implementation is complete only when all applicable statements are true:

- [ ] `contact_roles` exists as Shape-1 org-scoped customer data.
- [ ] RLS is enabled and forced in the table-creation migration.
- [ ] composite tenant FKs prevent cross-org assignments.
- [ ] applicable composite FKs are `DEFERRABLE INITIALLY IMMEDIATE`.
- [ ] Organization, Site, and Device Group scopes are supported.
- [ ] a row cannot target Site and Device Group simultaneously.
- [ ] role vocabulary is protected by a database CHECK.
- [ ] exact duplicate assignments are prevented with `UNIQUE NULLS NOT DISTINCT`.
- [ ] Site and Device Group assignment FKs use `ON DELETE CASCADE`.
- [ ] existing `contacts.roles[]` data is backfilled.
- [ ] contacts currently associated with a Site remain Site-scoped during backfill.
- [ ] `contacts.site_id` remains distinct from responsibility scope after backfill.
- [ ] changing `contacts.site_id` does not silently move responsibility assignments.
- [ ] `contact_roles` is the canonical responsibility source.
- [ ] `contacts.roles[]` remains compatible during transition.
- [ ] every existing role writer has been inventoried and migrated/classified, including the known Contacts service, direct `compat.ts`, `loginLink.ts`, and `import.ts` paths.
- [ ] all production writers dual-write consistently before any reader switches to `contact_roles`.
- [ ] there is one canonical resolver.
- [ ] precedence is Group → Site → Organization.
- [ ] all same-level matches are returned.
- [ ] nested Device Group inheritance is defined and tested.
- [ ] a direct/nearer Group assignment outranks a more distant ancestor assignment.
- [ ] duplicate contacts across matching Groups are deduplicated in resolved output.
- [ ] Caller Verification cannot widen Site/Group admins into organization admins.
- [ ] `admin @ Organization` remains authoritative even for a site-pinned contact after Caller Verification migration.
- [ ] Org Account Readiness, Billing contact resolution, and Report Series recipients are migrated to explicit scope semantics before scoped writes are enabled.
- [ ] no write path except migration backfill can create a non-Organization scope before the security gate is satisfied.
- [ ] `contact_roles` participates in organization cascade/erasure.
- [ ] `contact_roles` participates in tenant export.
- [ ] organization merge behavior is verified.
- [ ] device organization moves require no `contact_roles` rewrite integration.
- [ ] deleting a Site/Group cannot broaden an assignment to Organization scope.
- [ ] at least one real operational consumer uses the resolver.
- [ ] Device-level responsibility remains outside V1.
- [ ] `approver` remains outside V1.
- [ ] no parallel escalation model is introduced.
- [ ] frontend delivery follows the backend/resolver-first decision; scoped editing is a follow-up after the security gate.

## 30. Deferred Follow-ups

Explicitly deferred from this design unless separately approved:

1. Device-level responsibility;
2. approval responsibility and approval types;
3. escalation-policy customer-contact targets;
4. after-hours schedules/calendars;
5. SOP/playbook execution integration;
6. Breeze Assistant responsibility-aware tools;
7. ticket-routing integration;
8. eventual removal of `contacts.roles[]`.

Removing the compatibility projection requires a separate repository-wide reader sweep and must not be bundled opportunistically into this work.

## 31. Central Design Principle

This feature does not create a second contact system.

The model remains:

```text
Contact
   ↓
Responsibility
   ↓
Scope
```

Operational consumers use one resolver:

```text
Target Context
     ↓
Responsibility Resolver
     ↓
Most-Specific Match
     ↓
Customer Contact(s)
```

The load-bearing invariant is:

> **Scope may narrow responsibility, but migration, deletion, fallback, compatibility, or legacy code must never silently broaden it.**
