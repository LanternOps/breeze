# First-Class Organization Contacts — Design

**Date:** 2026-08-09
**Status:** Ready for review — one decision deliberately surfaced to the user (§0.2)
**Issue:** #3258 (epic #3249, Phase 3)
**Related:** #3242 (org import pipeline this reuses), #3257 (the other Phase-3 doc)

## Summary

Give Breeze a real contact record, so an MSP migrating off Datto RMM / Automate /
NinjaOne / Atera / Syncro can bring their customers' people with them, and so
"who do I tell" stops being a free-text string in a jsonb bag.

Adds `contacts` (org-scoped, RLS shape 1) and `contact_external_links` (re-import
identity, mirroring `organization_external_links`), plus a preview→commit importer
modelled on the shipped `orgImport` pipeline.

**The existing `organizations.billing_contact` and `sites.contact` jsonb columns
are NOT dropped, now or later.** They become a compatibility projection maintained
by dual-write. §2 is the reason, and it is the single most important section here.

## Context — verified 2026-08-09

- **No `contacts` table exists.** `organizations.billingContact` (`db/schema/orgs.ts:118`)
  and `sites.contact` (`:145`) are bare nullable `jsonb` — no `$type<>()`, no default,
  no DB-layer shape.
- **Validation is inconsistent and weakest where it matters.** `sites.contact` has a
  real route-layer shape (`siteContactSchema`, `routes/orgs.ts:215-225`, `.passthrough()`),
  but org create/PATCH validate `billingContact` with **`z.any()`** (`routes/orgs.ts:187`).
  `packages/shared/src/validators/index.ts:110,117` types both as
  `z.record(z.string(), z.unknown())`. There is no shared `Contact` type.
- **`add_contact` is a stub.** `services/aiToolsOrgs.ts:423-437` returns
  `CONTACT_ENTITY_UNDEFINED` guidance and writes nothing; the tool description
  (`:477`) advertises it as "not yet supported" while the input schema (`:488-492`)
  documents `orgId`/`email` params the handler ignores.
- **Contact PII is silently dropped from tenant export.** Both jsonb columns are
  bucketed `excludedOpen` (`tenantExportPolicyRegistry.ts:281,325`) — while the
  *structured* `billing_address_line1…country` columns on the same `organizations`
  row are `included` (`:320`). The exclusion carries no sensitivity rationale; it is
  purely the blanket "open container" rule.
- **QuickBooks is already a contact source.** `quickbooksCustomerImport.ts:143`
  emits `contact: {name,email,phone}` into `orgImport`, landing at
  `orgImport/index.ts:729`. Contacts are not a greenfield import problem.
- **Migration date ordering:** the last shipped migration is
  `2026-08-18-drop-organizations-accounting-columns.sql`. Today's date does **not**
  sort last in this repo (contrary to the Phase-3 handoff note), so a new migration
  must be dated after 2026-08-18 or it replays in a different position on a fresh
  database than on an existing one.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Ownership model | **Local table; PSA/RMM/accounting are import sources** | §0.1 — no PSA adapter has any contact capability at all. |
| Person record | **New `contacts`; `portal_users` becomes a login attached to one** | §0.2 — the contested call, surfaced to the user. |
| Tenancy shape | **Shape 1, `org_id NOT NULL`** | A contact is customer data, not config/policy. #2135's partner-wide default targets policy tables; the partner-side "person" is `users`. |
| Site association | **Nullable `site_id`, composite FK `(site_id, org_id) → sites(id, org_id)`** | `sites_id_org_id_uniq` already exists (`2026-07-23-partner-export-material-state-hardening.sql:39`), so cross-org site pinning is unrepresentable. |
| Re-import identity | **`contact_external_links`, unique `(org_id, system, external_id)`** | §1.2 — email is not a safe unique key, and emailless contacts are exactly the no-natural-key case the link pattern exists for. |
| Email | **Indexed, NOT unique** | Shared mailboxes (`info@`, `accounts@`) are one address for several real people. |
| Legacy jsonb | **Kept forever as a dual-written projection** | §2 — three separate shipped contracts depend on `sites.contact` existing. |
| Role primacy | **Single `is_primary` "headline contact"; per-role primacy deferred** | §1.3 — honest about what this is and is not. |
| Open containers | **No `json`/`jsonb`/`bytea` column on either table** | Would be `excludedOpen` and drop straight back out of tenant export. |

---

## 0. Decisions

### 0.1 Settled — a local table, not PSA read-through

Issue #3258 asks whether the PSA, as the usual system of record, should own contacts
via read-through. **It should not**, and the reason is not a preference:

**There is no PSA contact capability to read through.** `PSAProvider`
(`services/psa/types.ts`) declares exactly six methods — `testConnection`,
`getCompanies`, `createTicket`, `updateTicket`, `getTicket`, `syncTickets`. A sweep
for `contact` across the entire `services/psa/` directory returns **one** hit: a
comment in `companyImport.ts:29` recording that `PSACompany` carries no contact.
Read-through means designing and building a new capability across six adapters
(ConnectWise, Autotask, ServiceNow, Freshservice, Zendesk, and Jira — which has no
company concept at all), with pagination and SSRF-safe walking, before a single
contact appears in the UI. It is the more expensive option, not the cheaper one.

Three further reasons, in decreasing order of force:

1. **The migration sources are RMMs, not PSAs.** This epic exists to get data out of
   Datto RMM, Automate, NinjaOne, Atera and Syncro. Read-through from a *PSA* cannot
   import a *Datto* contact export. It would leave #3258's originating problem unsolved.
2. **Not every Breeze customer has a PSA.** `psa_connections` rows are optional, and
   CLAUDE.md names internal IT teams as a target alongside MSPs. Read-through delivers
   them nothing.
3. **Read-through has no local id.** `tickets.submitted_by` and
   `ticket_comments.portal_user_id` are FKs to a local person row today. Anything that
   later wants to reference a contact — an escalation step, a portal login, a ticket
   requester — needs a stable local id that a remote lookup cannot provide.

**A claim I withdrew.** An earlier draft argued that read-through would couple alert
delivery to PSA availability. That is not true today: no notification code reads any
contact field. Alert recipients resolve from `users` and from free-text strings in
`notification_channels.config`. The coupling argument is about a future that does not
exist yet, and the case does not need it.

**Honest counter-argument.** The PSA genuinely is the system of record, and a local
copy drifts. The answer is that this is replication with local identity — the same
shape the epic already chose for organizations — and that drift is not currently
possible anyway: there is no PSA sync worker (`POST /psa/connections/:id/sync` is a
501 stub with nothing consuming it). Sourcing is one-shot import, exactly like orgs.

### 0.2 Contested — new `contacts` table vs. extending `portal_users`

**This is the one call I am surfacing rather than settling silently**, because an
adversarial review made a strong case against my position and it is expensive to
reverse either way.

**The case for extending `portal_users`** (`db/schema/portal.ts:34-56`) is real:

- It is *already* the de-facto contact store. `services/inboundEmail/resolveOrg.ts:44-73`
  is named `findOrCreateEmailContact`, its docstring says it creates "a password-less
  **contact** for attribution", and the column that governs it is literally
  `customer_email_domains.auto_create_contact` (`db/schema/emailInbound.ts:55`).
- It already has `org_id NOT NULL` (RLS shape 1), nullable `password_hash`,
  non-unique `email`, `name`, and `receive_notifications`.
- **Every contract a new table would have to re-earn is already paid**: it is in
  `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:262`) and in
  `CORE_TENANT_EXPORT_POLICY` with `email` and `name` already in `included`
  (`tenantExportPolicyRegistry.ts:231`) — so contact PII is *not* uniformly dropped
  from export today, only the jsonb halves are.
- It is already a working FK target (`tickets.submitted_by`, `ticket_comments.portal_user_id`).
- The stub's stated reason for refusing to write it — "portal users carry user-invite
  semantics we must not trigger" (`aiToolsOrgs.ts:424-430`) — is **factually wrong**.
  Invite semantics live in the route (`routes/orgPortalUsers.ts:116-148`), not the
  schema, and `resolveOrg.ts` already creates non-invite rows.

**Recommendation: still build `contacts`, but link it.** The deciding argument is
that a contact and a portal login are different cardinalities of different things,
and the repo will keep paying for conflating them:

- A contact needs `site_id`, `title`, `phone`, and `roles`; `portal_users` needs
  `password_hash`, `entra_oid`, `auth_method`, `invited_by`, `status`. Merging gives
  one table where half the columns are meaningless for half the rows.
- **Backfilling a customer's 40 imported contacts into `portal_users` puts them on
  the portal user-management screen** (`routes/orgPortalUsers.ts`), which lists that
  table. Every existing reader would have to learn a distinction it does not have
  today — which is the same second-order-reader trap, merely pointed the other way.
- The industry model that every import source uses (ConnectWise, Autotask, Pax8)
  treats the contact as the parent and portal/login access as a capability of it.

So: **`contacts` is the person; `portal_users` becomes a login attached to a contact.**
To make that true rather than aspirational, this phase must also:

1. add nullable `portal_users.contact_id` FK,
2. backfill one `contacts` row per existing `portal_users` row and link them, and
3. **repoint `findOrCreateEmailContact` to create a `contacts` row** (creating a
   `portal_user` only when portal access is actually granted).

Step 3 is not optional. Without it inbound email keeps minting people in the other
table and "who do I email" is permanently split across two — precisely the objection
that makes this decision close. If the user prefers the cheaper path, extending
`portal_users` is a legitimate answer and §1 collapses to a column-addition migration;
it should be chosen deliberately, not by default.

---

## 1. Data Model

Migration `apps/api/migrations/2026-08-19-contacts.sql` — hand-written, idempotent,
no inner `BEGIN`/`COMMIT`, policies in the same file. Dated after
`2026-08-18-drop-organizations-accounting-columns.sql` so replay order is identical
on a fresh and an existing database.

### 1.1 `contacts`

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  site_id     uuid,
  name        varchar(255) NOT NULL,
  email       varchar(320),
  phone       varchar(64),
  mobile      varchar(64),
  title       varchar(255),
  roles       text[] NOT NULL DEFAULT '{}',
  is_primary  boolean NOT NULL DEFAULT false,
  notes       text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_org_fk FOREIGN KEY (org_id)
    REFERENCES organizations (id) ON DELETE CASCADE,
  CONSTRAINT contacts_site_org_fk FOREIGN KEY (site_id, org_id)
    REFERENCES sites (id, org_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_id_org_id_uniq ON contacts (id, org_id);
CREATE INDEX IF NOT EXISTS contacts_org_idx ON contacts (org_id);
CREATE INDEX IF NOT EXISTS contacts_site_idx ON contacts (site_id) WHERE site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_org_email_idx ON contacts (org_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_primary_uniq  ON contacts (org_id)  WHERE is_primary AND site_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_site_primary_uniq ON contacts (site_id) WHERE is_primary AND site_id IS NOT NULL;
```

Deliberate choices:

- **`contacts_site_org_fk` is composite.** A site pinned from another organization is
  unrepresentable rather than merely validated. The required unique index on
  `sites (id, org_id)` already ships.
- **`contacts_org_email_idx` is NOT unique.** A shared mailbox (`info@`, `accounts@`,
  `helpdesk@`) is one address belonging to several real people at one customer, and a
  unique constraint would make that legitimate shape unimportable. Email is a *match
  hint* in preview (§4), never an authority.
- **No `json`/`jsonb`/`bytea` column.** Any open container is classified `excludedOpen`
  and would drop the row's most interesting fields straight back out of tenant export
  — the exact defect this table exists to fix. Do not add a `metadata` jsonb later
  without accepting that cost.
- **`roles text[]`** rather than an enum: the vocabulary
  (`billing | technical | escalation | admin | site | after_hours`) is validated in the
  app layer and will grow per import source. `text[]` is export-safe; `device_types`
  on `custom_field_definitions` is the in-repo precedent.

### 1.2 `contact_external_links`

```sql
CREATE TABLE IF NOT EXISTS contact_external_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  system      text NOT NULL,
  external_id text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_external_links_contact_org_fk FOREIGN KEY (contact_id, org_id)
    REFERENCES contacts (id, org_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_external_links_uniq
  ON contact_external_links (org_id, system, external_id);
CREATE INDEX IF NOT EXISTS contact_external_links_contact_idx
  ON contact_external_links (contact_id);
```

**Why a link table when I argued against one for contacts initially.** The tempting
shortcut is to dedupe on `(org_id, lower(email))` and skip this. That fails on three
real shapes: shared mailboxes (above), contacts with no email at all (phone-only site
contacts are common in RMM exports), and email changes — which are identity changes
that the repo already paid for once on `users` (`email_epoch`, `pending_email`,
`2026-07-18-pending-email-and-verification-purpose.sql`). Records with no safe natural
key are exactly what `organization_external_links` exists for, and re-import
idempotency is the same requirement. Consistency with the shipped pattern is a bonus,
not the reason.

**Why the unique is `(org_id, …)` and not `(partner_id, …)` as it is for orgs.** A
person can legitimately work for two of an MSP's customers. Partner-scoping the key
would force those two relationships to collapse onto one row spanning two tenants —
unrepresentable under shape 1 and wrong besides. Org-scoping yields one contact row
per org, each linked to the same source id, which is the correct model. This is a
deliberate divergence from `organization_external_links` and is called out so a future
reader does not "fix" it.

### 1.3 What `is_primary` is, and is not

`is_primary` means **"the headline contact for this org (or this site)"** — the one the
compat projection in §2 writes into the jsonb columns, and the one a UI shows first.
The partial unique indexes enforce exactly one per org and one per site.

It is **not** per-role primacy, and per-role primacy is a real requirement in this repo:
`services/pax8CompanyReadiness.ts:26-42` gates ordering on a company having a primary
**admin** *and* a primary **billing** *and* a primary **technical** contact, reading a
`contacts[].types[] = {type, primary}` wire shape. ConnectWise and Autotask model it
the same way.

That is deferred rather than guessed at, because no consumer in this phase needs it and
the retrofit is mechanical: a `contact_roles(contact_id, org_id, role, is_primary)` child
table with `UNIQUE (org_id, role) WHERE is_primary`, populated by `unnest(roles)`. Do
not widen `is_primary` to mean per-role primacy — add the child table.

### 1.4 Contract registration — all in the same PR

| Contract | Action | Enforced by |
|---|---|---|
| RLS | Both tables: shape **1**, `ENABLE` + `FORCE`, four policies `breeze_has_org_access(org_id)`, in the creating migration. Auto-discovered from the `org_id` column, so **no allowlist entry**. Copy `device_mtls_certificates` (`rls-coverage.integration.test.ts:3675-3690`). Must **not** be added to `DUAL_AXIS_TENANT_TABLES` — that asserts a partner branch these tables do not have. | `rls-coverage.integration.test.ts` |
| Org cascade | Add `'contact_external_links'` and `'contacts'` to `CORE_ORG_CASCADE_DELETE_ORDER`, alphabetically. Both sort ahead of `sites` and `organizations`, and the real order is recomputed children-first from `pg_constraint` at delete time (`tenantCascade.ts:473`) — alphabetical placement is a lint, not the delete order. | `tenantCascade.integration.test.ts` |
| Export policy | Both tables: **every column `included`.** No name matches `SUSPICIOUS_NAME_PARTS`; no open containers exist by construction. This is the point of the exercise — it moves contact PII from "silently dropped" into the export. | `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` |
| Device cascade | **N/A** — no `device_id` column. | — |
| Append-only | **N/A** — rows are mutable and deletable. | — |
| Partner export | **Deliberately none in this phase.** See §2. | — |

Both the cascade and export-policy suites need a live database and **cannot fail in the
`Test API` unit job**. Run them locally and dispatch CI on the branch
(`gh workflow run CI --ref <branch>`).

---

## 2. The legacy jsonb columns stay — this is not a deferral

The obvious plan, and the one the Phase-1 spec used for `accounting_*`, is dual-write
now and drop the columns in a later contract phase. **For these two columns that plan
is wrong**, and each of the three reasons was found by adversarial review rather than by
reading the schema:

1. **A partner-export watermark trigger reads `sites.contact` by name.**
   `breeze_partner_export_sites_update()` detects change with a hardcoded tuple —
   `ROW(old_row.org_id, old_row.name, old_row.address, old_row.timezone, old_row.contact)
   IS DISTINCT FROM ROW(new_row…)` (`2026-07-18-partner-export-org-locks.sql:279-284`,
   trigger wired at `:459-462`; no later migration redefines it). The moment site contact
   stops living in that column, a contact-only edit stops bumping
   `sites.partner_export_updated_at` and partner-API consumers polling the sites cursor
   never see it — a silent divergence bug inside the machinery built to prevent exactly that.
2. **`sites.contact` is a published API contract, not an internal blob.**
   `partnerSiteContactSchema` is `.strict()` and embedded in `partnerSiteExportRecordSchema`
   (`routes/partnerApi/schemas.ts:120-131`); it is a write DTO on `POST /partner-api/sites`
   (`provisioning.ts:83-87`), it is in the published OpenAPI (`openapi.ts:247,2009`), and it
   is documented (`apps/docs/.../reference/api.mdx:214`, `migration/toolkit.mdx:116`).
   Export records are additionally content-hashed (`computePartnerExportRevision`,
   `exportSafety.ts:72-74`), so changing the emitted shape re-hashes **every** site record
   and triggers a full re-sync across all partner consumers.
3. **The two columns have deliberately different exposure.** `organizations.billing_contact`
   is explicitly kept out of the partner API with a negative regression test
   (`routes/partnerApi/organizations.test.ts:150,158`) and out of AI model context
   (`aiToolsOrgs.ts:144-149,181-183`), while `sites.contact` *is* exported. Collapsing both
   into one table erases the boundary that makes those two exclusions expressible.

So the columns remain, maintained by dual-write, and `contacts` becomes the richer
superset. Adding a partner-export `contacts` resource later is a separate, deliberate
project — it needs a `RESOURCE_CLASSIFICATION` entry (`exportSafety.classification.ts:25`
is a total `Record<PartnerExportResource, …>`, so omitting it is a compile error), locks,
`breeze_partner_export_next_timestamp`, material state, and canonical parity.

### The compat service is the only writer

New `apps/api/src/services/contacts/compat.ts`, the single place both representations
are written:

```ts
upsertSiteContact(siteId, orgId, contact, actor)      // contacts row + sites.contact jsonb
upsertBillingContact(orgId, patch, actor)             // contacts row (roles ⊇ billing) + organizations.billing_contact
```

Both write inside one transaction. Every existing writer routes through them.

### Writer sweep — the list a grep will not produce

The Phase-1 lesson was "a reader moved without its writer mints duplicates". Here the
readers are deliberately left alone and only writers move, which is strictly safer — but
the sweep still has to be complete:

| Writer | Note |
|---|---|
| `routes/orgs.ts` — org create | `billingContact: data.billingContact`, validated by `z.any()` (`:187`) |
| `routes/orgs.ts` — org PATCH | **Whole-blob replace.** Clobbers the atomic merge below; see the pre-existing race note |
| `routes/orgs.ts` — site create | validated by `siteContactSchema` |
| `routes/orgs.ts` — site PATCH (~`:2028-2038`) | **Writes `contact` via `{...data}` spread. There is no literal `contact:` token at the write site — a grep-driven sweep misses this entirely.** |
| `services/invoiceService.ts:497-506` | Atomic `COALESCE(…) \|\| …::jsonb` merge of `email`/`name` only |
| `routes/invoices/settings.ts:30` | The HTTP route for the above |
| `services/orgImport/index.ts` (~`:702,729,760,860,876`) | Bulk import; `:702` collapses many rows to one contact, first-wins; `:729` writes `billingContact`; `:760`/`:876` write `sites.contact` |
| `services/accounting/quickbooksCustomerImport.ts:143` | Indirect — emits `contact` into `orgImport` |
| `routes/partnerApi/provisioning.ts` | Site create/update via the public partner API |
| Web | `billing/OrgBillingSettings.tsx`, `settings/SiteDetailPage.tsx`, `settings/OrganizationsPage.tsx`, `settings/PartnerSettingsPage.tsx` |

**Pre-existing race, worth fixing here:** org PATCH replaces `billing_contact` wholesale
while `invoiceService` merges into it. A PATCH carrying a partial blob silently drops
keys the merge had written. Routing both through `upsertBillingContact` fixes it as a
side effect; do it deliberately and test it.

**Readers that must keep working unchanged** (all currently read the jsonb):
`invoicePdf.ts:582-586` `resolveBillingEmail` (the single extraction point, called at
`:518` and `quoteLifecycle.ts:165`), the `no_billing_contact` reason code
(`db/schema/quotes.ts:27`, `invoicePdf.ts:453,561`, `quoteLifecycle.ts:324`,
`web/lib/api/quotes.ts:284,292`) and its i18n keys across **all 7 locales**
(`billing.json:851,854,1255,1343,1434`), plus the bare `.select()` org/site readers at
`routes/orgs.ts:1434,1853,1975,2012,2063`.

**Behaviour-pinning tests that will need updating, not deleting:**
`__tests__/integration/orgBillingSettings.integration.test.ts:26-60` (including "clear by
setting email to JSON null"), `__tests__/integration/billing-contact-info.integration.test.ts`,
`invoiceService.test.ts:317-343` (asserts the `set` value is a Drizzle `SQL` merge
expression), `quoteLifecycle.test.ts` fixtures, and the projection-leak guard
`orgs.test.ts:1480-1488`.

---

## 3. Backfill

Same migration, every cleanup statement reporting its row count per CLAUDE.md:

1. **From `sites.contact`** → one contact per site with a non-empty blob,
   `site_id` set, `roles = '{site}'`, `is_primary = true`.
2. **From `organizations.billing_contact`** → one contact per org with a non-empty blob,
   `site_id NULL`, `roles = '{billing}'`, `is_primary = true`.
3. **From `portal_users`** (only if §0.2 is accepted) → one contact per portal user,
   linked via the new `portal_users.contact_id`.

Blobs that are `NULL`, `'{}'`, or carry no `name`/`email`/`phone` are skipped — they are
not contacts. Each step wraps in `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN
RAISE WARNING 'backfilled % <what>', n; END IF; END $$;` so the counts land in Postgres
logs. Re-running the migration must be a no-op.

---

## 4. Routes

Under `orgRoutes`, matching the gating of the org write routes they sit beside —
reads `requireScope('organization','partner','system')` + `orgs:read`; writes additionally
`orgs:write` + `requireMfa()`.

- `GET    /orgs/organizations/:id/contacts` — list, optional `siteId` / `role` filters.
- `POST   /orgs/organizations/:id/contacts`
- `PATCH  /orgs/contacts/:id`
- `DELETE /orgs/contacts/:id`
- `POST   /orgs/contacts/import/preview` — body `{ rows: ContactImportRow[] }`, max 1000
  (`MAX_IMPORT_ROWS`). No writes.
- `POST   /orgs/contacts/import` — returns `{ imported, updated, skipped, errors }`,
  always HTTP 200, per-row detail. Consumed through `runAction`.

```ts
interface ContactImportRow {
  organizationId?: string;      // preferred
  organization?: string;        // else resolved by name within the partner
  site?: string;                // optional site name within that org
  name: string;
  email?: string;
  phone?: string;
  mobile?: string;
  title?: string;
  roles?: string[];
  externalId?: string;          // the source's stable contact id
  externalSystem?: string;      // 'datto_rmm' | 'connectwise' | ... ; defaults to 'csv'
}
```

Annotations, mirroring the shipped pipeline:
`create | link-match | email-match | name-match | conflict | org-not-found`.

- `link-match` resolves through `contact_external_links` and is safe to auto-apply.
- **`email-match` and `name-match` are never committed without explicit
  acknowledgement** — the client must echo `expectedAnnotation`, exactly as
  `checkExpectation` requires today (`orgImport/index.ts:407-448`).
- Commit **re-derives** every annotation against fresh state and rejects any row whose
  annotation changed since preview. Preview is advisory; the unique index is authority.
- Per-row failure is recorded and the remaining rows proceed.

Contacts arriving through the *org* importer's existing `contact` field keep working and
now also create a contact row via §2's compat service. The dedicated importer exists for
the many-contacts-per-org case the org importer cannot express.

---

## 5. `add_contact` becomes real — and must be re-classified

Making the stub write is four coordinated edits plus a guardrail change that is easy to
get silently wrong:

- `services/aiToolsOrgs.ts` — real handler, tool description (`:477`), and an input schema
  that matches what the handler actually consumes (`:486-492` currently documents
  `orgId`/`email` params it ignores).
- `services/aiAgentSdkTools.ts:2051,2053` and `services/aiToolSchemas.ts:307` — the same
  action enum, duplicated. All must change together.
- **`services/aiGuardrails.ts` — add `'add_contact'` to `TIER3_ACTIONS.manage_organizations`
  AND to `TIER3_SUPERVISED_ACTIONS.manage_organizations`.** Both, or it fails in one of two
  silent ways:
  - omitted from `TIER3_ACTIONS` → stays tier 2 and **auto-executes with no approval at
    all** while writing customer PII (the current exemption at `:203-204` exists *because*
    the action is a no-op, and that premise is about to become false);
  - added to `TIER3_ACTIONS` only → `resolveApprovalScope` matches neither `*_ACTIONS`
    table, falls through both whole-tool sets, and hits the closing `return 'four_eyes'`
    — so **creating a contact would demand a second human approver.**

  Supervised is the right scope: `TIER3_FOUR_EYES_ACTIONS.manage_organizations` is
  `['create_org']` only (`:267`) — reserved for tenant creation — and `create_site` /
  `update_org` are supervised.
- `buildApprovalDescription` (`aiGuardrails.ts:1366`; its `manage_organizations` branch at `:1526-1531`) falls through to `Organizations: ${action}`,
  so an approver would see no name or email. Add a contact branch, or approval is blind.
- Extend the enumeration guard `aiGuardrails.approvalScope.contract.test.ts:139-180`,
  which currently pins only four tools and would not catch any of the above.

---

## 6. Web UI

- **Contacts card on the organization detail page** — list, add, edit, delete, role badges,
  a "Primary" marker, and site attribution. Mutations go through `runAction`.
- **Site detail** keeps its existing single-contact editor, which now writes through the
  compat service; the card links to the full contact list.
- **Bulk contact import** modelled on `components/organizations/BulkOrgImport.tsx`:
  drag-drop CSV → client-side parse (`lib/csvParse.ts`) → column mapping → preview table
  with per-row status badges → commit. `email-match` and `name-match` rows are unchecked
  by default; select-all spans only `create` and `link-match`, matching the existing
  guard that a bulk toggle must never opt hundreds of rows into a fuzzy match.

---

## 7. Testing

- **Service**: link-match dedupe; email-match and name-match flagged, not auto-applied;
  shared mailbox (three contacts, one address) imports cleanly; emailless contact
  round-trips; re-import is a no-op; per-row partial success.
- **Compat**: every writer in §2's table produces both a contact row and the jsonb; the
  org-PATCH/invoiceService clobber race is fixed and pinned.
- **Partner export**: editing a site contact through the new path still bumps
  `sites.partner_export_updated_at` — a direct regression test for the trigger in §2.1.
- **Partner API**: `GET /partner-api/sites` contact payload is byte-identical before and
  after, and `organizations` still has no `billingContact` (`organizations.test.ts:150,158`).
- **Contracts**: RLS coverage, cascade ordering, export policy, erasure roundtrip. Forge a
  cross-tenant insert as `breeze_app` — must fail with
  `new row violates row-level security policy`.
- **Composite FKs**: a contact whose `site_id` belongs to another org must be rejected; a
  link row whose `org_id` disagrees with its contact's must be rejected.
- **Guardrails**: `add_contact` resolves to `supervised` — not tier 2, not `four_eyes`.
- **Backfill**: idempotent; blobs with no usable field produce no row.
- **Web**: preview rendering, fuzzy-match rows default-unchecked, `runAction` partial success.

---

## Deferred — with reasons, so they are not lost

| Item | Why not now | Tracked by |
|---|---|---|
| **Per-role primacy** (`contact_roles` child table) | No consumer in this phase; Pax8 readiness (`pax8CompanyReadiness.ts:26-42`) is the named future one. Migration is `unnest(roles)`. | Not filed — file with §1.3's shape |
| **Notification routing to contacts** | The issue's strongest "beyond migration" motivation, but alert recipients are free-text strings in `notification_channels.config` today; rewiring them is its own design. | Not filed |
| **Partner-export `contacts` resource** | Needs `RESOURCE_CLASSIFICATION`, locks, material state, canonical parity. §2. | Not filed |
| **Partner-level contact unification** | `partners.settings.contact` (`routes/orgs.ts:477-482`, with a `website` field) is the MSP's own profile, not a customer contact — and it already diverges from the `partners.billingEmail/Phone/Website` columns `sellerSnapshot.ts:46-48` reads. An `org_id NOT NULL` table cannot hold it. | Not filed |
| **Per-person erasure across orgs** | One human at N customers is N rows by design (§1.2). Org-level cascade is the erasure contract; a partner-wide "erase this person" utility is a separate DSR feature. | Not filed |
| **PSA contact sync** | Requires a `getContacts` capability across six adapters *and* a sync worker (none exists). Once built it is another import source behind the same preview→commit. | #3246 follow-up |

### Explicitly not planned

- **Dropping `organizations.billing_contact` / `sites.contact`.** §2. Not a deferral — a decision.
- **Making `contacts.email` unique.** It breaks shared mailboxes, which are normal.
- **Reusing `users` for contacts.** `users.email` is globally unique
  (`0001-baseline.sql:8427`), so the same person could not be a contact at two MSPs, and
  every row drags an auth-epoch chain.

### Naming note

`'contacts'` and `'gcontacts'` already exist as cloud-to-cloud **backup scope** strings
(`routes/c2c/schemas.ts:53,60`). Different namespace, no code conflict, but the docs
should not use "contacts" unqualified where a reader might be thinking about M365 backup.
