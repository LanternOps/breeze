> Raw inventory produced by a research agent on 2026-09-17 for the billing + ticketing settings audit
> (`../2026-09-17-billing-ticketing-settings-audit.md`). Agent output: file:line citations were
> checked by the agent, not re-read, unless the audit marks the finding **verified**. A few
> claims here were corrected in the audit (default priority is set in two places, not three;
> `defaultMarkupPercent` has several pre-fill readers).

# Partner-level (MSP-wide) billing & ticketing settings — field inventory

Scope: every PARTNER-scoped web settings surface configuring billing or ticketing behavior. Org-level surfaces (OrgBillingSettings, OrgTicketSettingsEditor, etc.) are explicitly out of scope — noted only where they duplicate a partner-level concept.

All file paths relative to ``.

---

## Navigation map (partner-level billing/ticketing surfaces)

Source: `apps/web/src/components/layout/Sidebar.tsx` (`navSections`), plus each page's own redirect/hash logic.

| Surface | Sidebar path | Notes |
|---|---|---|
| Partner (Company/Regional/Security/…/**Ticketing**) | Settings → Partner (`/settings/partner`) | `partnerScopeOnly`. Ticketing is one tab inside this hub (`#ticketing`), gated additionally by `requiredPermission` on parent item = none (page itself gates on partner scope). |
| Billing (partner subscription/invoice defaults) | Settings → Billing (`/settings/billing`) | `partnerScopeOnly` + `requiredPermission: {invoices, write}` |
| Product Catalog | Billing section → Product Catalog (`/settings/catalog`) | `partnerScopeOnly` + `requiredPermission: {catalog, read}`. **Lives in the top-level "Billing" nav SECTION, not under Settings** — a real split: billing-adjacent config is reachable from two different places in the sidebar hierarchy (top-level Billing section vs. Settings section). |
| Agreements (templates) | Billing section → Agreements (`/agreements/templates`) | `partnerScopeOnly` + `requiredPermission: {agreements, read}`. Signed tab is a sibling route aliased to the same nav highlight. |
| Quotes / Invoices / Contracts | Billing section | Document lists, out of scope (not settings) |
| Integrations (hub) | Settings → Integrations (`/integrations`) | No `partnerScopeOnly` flag on the nav item itself, but the Accounting/Distributors sub-tabs hide for org scope internally. Contains Accounting (QuickBooks, Stripe), PSA connections, Distributors (Pax8, TD SYNNEX), Webhooks, Communication, Security, Identity, Monitoring, Unifi — all as `#hash` sub-tabs of ONE page. |
| Ticket Checklist Templates | **No sidebar entry found** — `/settings/ticket-checklist-templates` only reachable by direct URL | Confirmed: not in `navSections` or `topLevelNav`. Deep-link only. |
| Deliverable Templates | **No sidebar entry found** — `/settings/deliverable-templates` only reachable by direct URL | Same as above (inferred from same absence; not individually re-grepped). |
| Custom Fields | Settings → Custom Fields (`/settings/custom-fields`) | Generic (not billing/ticketing-specific nav item) — may include ticket/invoice custom field defs; not read in this pass beyond the file listing. |
| Variables | Settings → Variables (`/settings/variables`) | Generic; used by ticketing/billing templates via merge-variable pickers seen in InboundEmailCard/CannedResponsesCard. Not read in this pass. |
| Webhooks | Integrations hub → Webhooks tab (`#webhooks`), OR legacy `/settings/webhooks/index.astro` | Two URL entry points for one underlying `WebhooksPage` component — confirm via `apps/web/src/pages/settings/webhooks/index.astro` (not read; likely also a redirect alias, consistent with the ticketing/billing integration pages pattern seen everywhere else in this codebase). **Not fully verified — flag for follow-up.** |

### Redirect aliases confirmed by direct read (all 301, all consolidating legacy standalone pages into hub pages):
- `/settings/ticketing` → `/settings/partner#ticketing`
- `/settings/integrations/psa` → `/integrations#psa`
- `/settings/integrations/ticketing` → `/integrations#psa` (Zendesk/Freshdesk/ServiceNow ticketing integration was retired in favor of PSA Connections)

This is a strong signal the team has ALREADY been consolidating settings sprawl for ticketing/billing integrations — three formerly-standalone pages now redirect into two hub pages (`/settings/partner`, `/integrations`).

---

## Surface: Partner Settings hub — /settings/partner

- component: `apps/web/src/components/settings/PartnerSettingsPage.tsx`
- scope: partner (gated on JWT `scope === 'partner'`, with a JWT-seed fallback)
- permission gate: none found beyond partner scope (every tab renders for any partner user reaching the page; individual tabs may have their own finer gates)
- API: GET/PATCH `/orgs/partners/me` (single endpoint for the whole hub except Ticketing, Login Branding, AI Provider — see below)
- Tabs relevant to this audit: **Ticketing** (embeds `TicketingSettingsTabs`, see below) is the only billing/ticketing tab in this hub. Company/Regional/Security/Notifications/EventLogs/Defaults/Branding/LoginBranding/AiBudgets/AiProvider/RemoteAccess are out of scope (not billing/ticketing).
- Save pattern: ONE page-level "Save Settings" button covers Company/Regional/Security/Notifications/EventLogs/Defaults/Branding via a single PATCH; **Ticketing, Login Branding, and AI Provider tabs are `selfSaving: true`** — the page-level Save button is disabled/hidden and each control inside those tabs saves independently. This is a real inconsistency baked into the tab metadata itself (`TabDef.selfSaving`), not incidental.
- Oddities:
  - **`PartnerModulesCard`** (service-management mode: native / off) is rendered inside the **Company** tab, not Billing or Ticketing, even though this single radio button is what makes the entire Service Desk + Billing nav sections appear or disappear. A user looking for "why is Billing hidden from my nav" would not think to check Company. See its own block below.
  - The Ticketing tab's description text says "partner-wide statuses, priority SLAs, categories, and billing export" — the hub's own code comment names "billing export" as belonging to Ticketing, an explicit acknowledgment in the source that a billing concept lives here.

### PartnerModulesCard — /settings/partner#company (Company tab)
- component: `apps/web/src/components/settings/PartnerModulesCard.tsx`
- scope: partner
- permission gate: none found (any partner user reaching Company tab can change it)
- API: PATCH `/orgs/partners/me` `{ serviceManagementMode }`
- Fields:
  - **Native** (radio) — Breeze's own Service Desk + Billing modules are enabled — `serviceManagementMode: 'native'`
  - **Off** (radio) — Service Desk + Billing nav sections hidden entirely (RMM-only mode) — `serviceManagementMode: 'off'`
  - (`external` is a valid stored value but not offered by this UI — a partner already on `external` sees neither radio checked)
- Save pattern: autosaves immediately on click (optimistic, reverts on failure) — inconsistent with the page's own page-level-Save-button default for the tab it's embedded in (though consistent with the hub's own `selfSaving` convention used elsewhere).
- Oddities: This is the single master switch for whether the ENTIRE Billing/Ticketing feature set (Quotes, Invoices, Contracts, Agreements, Product Catalog, Tickets, Timesheets nav sections) is visible at all — yet it sits as one card at the bottom of the unrelated "Company" tab (name/address/contact info), not on the Billing page or the Ticketing tab where a user would expect a feature on/off switch.

---

## Surface group: Ticketing tab — /settings/partner#ticketing (sub-tabs `#tab=…`)

Rendered by `apps/web/src/components/settings/TicketingSettingsTabs.tsx`. A dead/legacy standalone page (`TicketingSettingsPage.tsx`) wraps the same component but appears unreferenced from any `.astro` route (only `ticketing.astro` exists and it hard-redirects, never rendering `TicketingSettingsPage`) — **confirm whether `TicketingSettingsPage.tsx` is truly dead code**; not fully verified (only checked `.tsx`/`.astro` imports, not test files or Storybook-style harnesses).

8 sub-tabs total: Statuses, Priorities & SLAs, Categories, Export, Intake Forms, Inbound Email, Canned Responses, Time Tracking. Forms/Inbound/Canned/TimeTracking are partner-only (gated on JWT scope==='partner' via a variable literally named `canManageInbound`, reused for all four — a naming leftover from when it may have covered only inbound email).

### Statuses — `#tab=statuses`
- component: `TicketStatusesTab.tsx` · scope: both · permission gate: none found
- API: GET `/ticket-config`; POST `/ticket-config/statuses`; PATCH `/ticket-config/statuses/:id`; POST `/ticket-config/statuses/reorder`
- Fields (per status row, inline edit): **Name** (text), **Core state** (select: new/open/pending/…/closed — canonical bucket), **Color** (color picker), **Active** (toggle via row action), sort order (drag-equivalent up/down buttons)
- Save pattern: per-row inline drawer Save (no page Save)
- Oddities: none beyond what's noted in the group-level oddities below.

### Priorities & SLAs — `#tab=priorities`
- component: `TicketPrioritiesTab.tsx` · scope: both · permission gate: none found
- API: GET `/ticket-config`; PUT `/ticket-config/priorities`
- Fields, one row per urgent/high/normal/low: **Label** (text override), **Response SLA (min)**, **Resolution SLA (min)**
- Save pattern: single page-level Save button (the only sub-tab with this exact pattern)
- Oddities: SLA defaults set here are silently overridable per-category (see Categories tab) with no cross-reference shown on either screen.

### Categories — `#tab=categories`
- component: `TicketCategoriesPage.tsx` · scope: partner-wide records, screen renders for both · permission gate: none found
- API: GET `/ticket-categories`; GET `/orgs/partners/me` (currency label only); POST `/ticket-categories`; PATCH `/ticket-categories/:id`; PUT `/ticket-categories/reorder`
- Fields: **Name**, **Color**, **Parent category** (1 level of nesting), and per-row: **Default Priority**, **Response/Resolution SLA (min)**, **Default time entry (min)**, **Billable by default** (checkbox), **Default hourly rate** (in partner currency, stamps its own `rateCurrency`)
- Save pattern: per-row inline drawer Save
- Oddities (domain-mismatch, high priority for the consolidation effort):
  - **Billing fields embedded in a Ticketing screen**: `defaultBillable`, `defaultHourlyRate`, `defaultTimeEntryMinutes` are per-category BILLING defaults, not ticketing behavior. They duplicate the "billable/hourly rate" concept that also lives in Partner Billing Settings (markup%, tax) and in the Time Tracking sub-tab (auto time-entry suggestion thresholds).
  - **Default Priority** is configurable here AND on Priorities & SLAs AND on Intake Forms — three separate partner-level places, no documented precedence.

### Export (Billables Export) — `#tab=export`
- component: `BillablesExportCard.tsx` · scope: both · permission gate: none found
- API: GET `/orgs/organizations?limit=100`; GET `/tickets/export/billables.csv?from&to&orgId`
- Fields: **From** (date), **To** (date), **Organization** (select, default "All"), **Download CSV** (action button)
- Oddities: this is a **billing report/export action**, not a configurable setting at all — its presence as a tab alongside Statuses/Priorities/Categories is itself an information-architecture inconsistency (a one-off action mixed into a settings-tab list).

### Intake Forms — `#tab=forms` (partner-only)
- component: `TicketFormsCard.tsx` · scope: partner · permission gate: `canManageInbound` (partner JWT scope)
- API: GET `/ticket-forms`, `/ticket-categories`, `/orgs/organizations`; POST/PUT/DELETE `/ticket-forms[/:id]`
- Fields: **Ownership** (All orgs vs This org only, create-only) + **Visibility allowlist** (limit to specific orgs), **Name**, **Description**, **Category**, **Title template** (merge syntax), **Description intro**, **Default priority**, **Show in customer portal**, **Active**, repeating **Fields** editor (label/type/required/help/placeholder/options, auto-derived keys)
- Save pattern: per-form drawer Save
- Oddities:
  - Bespoke partner-wide-vs-org-owned ownership implementation (`ownerScope` + `visibleOrgIds` allowlist) that does NOT follow the repo's documented "Partner-Wide First" `org_id` XOR `partner_id` + dual-axis RLS contract (CLAUDE.md) — worth verifying the backend table's actual tenancy shape against that contract.
  - Default Priority duplicated with Categories and Priorities & SLAs (see above).

### Inbound Email — `#tab=inbound` (partner-only; also deep-linked from M365 OAuth consent return)
- components: `InboundEmailCard.tsx` (native email) + `M365MailboxCard.tsx` (M365 shared mailboxes, its own `ticket_mailbox:read`/`admin` permission gate nested inside the partner-scope gate)
- API (native): GET `/ticket-config`; PATCH `/orgs/partners/me` with `{settings:{ticketing:{inbound:{...}}}}` (most fields autosave individually) AND a separate PATCH `/orgs/partners/me` with a top-level `{inboundLocalPart}` (inconsistent nesting for what is conceptually the same setting group)
- API (M365): GET `/tickets/mailbox/connections`; POST `/tickets/mailbox/connect`; POST `/tickets/mailbox/connections/:id/retest`; DELETE `/tickets/mailbox/connections/:id`
- Fields (native): **Enable inbound email**, **Inbound address (local part)** (explicit Save + confirm() dialog), **Triage organization**, **Unknown senders** (Quarantine/Route to Triage/Drop, radio), **Drop unverified senders (SPF/DKIM)**, **Enable auto-response**, **Auto-response Subject/Body** (merge variables, explicit Save)
- Fields (M365): mailbox address, display name, Connect/Retest/Reconnect/Disconnect actions on a list of connected mailboxes
- Below this card: `CustomerDomainsCard` (domain verification — not read in this pass, flagged for whoever inventories that surface)
- Oddities: **three different save behaviors stacked in one card** — most toggles autosave on change, the address-local-part uses explicit-Save-plus-confirm(), and the auto-response text uses a separate explicit Save button.

### Canned Responses — `#tab=canned` (partner-only)
- component: `CannedResponsesCard.tsx` · scope: partner · permission gate: `canManageInbound` (misleadingly named — unrelated to inbound email)
- API: via `apps/web/src/lib/ticketResponseTemplatesApi.ts` (list/create/update/delete) — underlying REST path not directly grepped
- Fields: **Name**, **Category** (free text — NOT a reference to the structured Ticket Categories entity two tabs over), **Body** (merge variables)
- Save pattern: per-item drawer Save
- Oddities: "Category" here is a naming collision with the first-class Categories entity elsewhere in the same tab group, with no relationship between them.

### Time Tracking — `#tab=timeTracking` (partner-only, W06 #3900)
- component: `TimeTrackingSettingsCard.tsx` · scope: partner · permission gate: `canManageInbound`
- API: GET/PATCH `/orgs/partners/me` `{settings:{timeTracking:{sessionSuggestions:{...}}}}`
- Fields: **Suggest time entries from device sessions** (checkbox), **Minimum session length (sec)** 30–3600, **Merge gap (min)** 0–120
- Save pattern: single page-level Save button
- Oddities: billing-adjacent behavior (auto-suggests billable time entries) sitting in Ticketing settings, same domain-mismatch pattern as Categories' billing fields and the Export tab.

**Cross-tab gate naming oddity**: the boolean `canManageInbound` (= partner JWT scope) gates four semantically unrelated sub-tabs (Forms, Inbound Email, Canned Responses, Time Tracking) under one stale name.

---

## Surface: Partner Billing Settings — /settings/billing

- component: `apps/web/src/components/billing/PartnerBillingSettings.tsx`
- scope: partner (no explicit client-side scope gate in the component itself — relies on nav-level `partnerScopeOnly` + server-side `/partner/billing-settings` route auth)
- permission gate: nav item requires `{resource:'invoices', action:'write'}`; not re-checked inside the component
- API: GET `/orgs/partners/me`; PATCH `/partner/billing-settings` (single PATCH, full payload, one page-level Save button)

### Card: Defaults
- **Currency** — select (all ISO codes; legacy off-list codes preserved) — `currencyCode`
- **Default Tax Rate** (%) — number 0–100 — `defaultTaxRate` (stored as fraction)
- **Invoice Number Prefix** — text, max 12 — `invoiceNumberPrefix`
- **Payment Terms (days)** — number 0–365 — `invoiceTermsDays`
- **Default Markup (%)** — number, pre-fills catalog import prices — `defaultMarkupPercent`
- **Auto-tax hardware on import** — checkbox — `autoTaxHardware`
- **Auto-email invoice on quote accept** — checkbox — `autoEmailInvoiceOnQuoteAccept`
- **Append device list to invoice** — checkbox — `invoiceDeviceAppendix`
- **AI copy style** (Auto-fill/Polish house style) — textarea, max 2000 — `catalogAiStyle`
- **Document theme** — select (classic/condensed) — `documentTheme`
- **Document page size** — select (letter/a4) — `documentPageSize`
- **Invoice footer** — textarea — `invoiceFooter`

### Card: Company (billing letterhead)
- **Company Name**, **Phone**, **Website** (http/https validated client + server), **Address Line 1/2**, **City**, **Region**, **Postal Code**, **Country** (2-letter, uppercased) — all `billing*` prefixed fields
- **Default Terms & Conditions** — textarea — `billingTermsAndConditions`

Oddities:
- **`billingCompanyName`/address fields duplicate the Partner Settings → Company tab's own name/address/contact fields** (`companyName`, `contactName/Email/Phone/Website`, `address.*` in `PartnerSettingsPage.tsx`) — two independent partner-level "who are we" records: one for general partner identity (used presumably for branding/contact), one specifically for billing documents. No visible link or "same as company info" checkbox between them; a partner must enter their address twice.
- **`defaultMarkupPercent`** here is described as "pre-fill catalog import prices" — a pricing default that conceptually belongs beside the Product Catalog's own margin math (`marginMath.ts`, not read in this pass) rather than on the generic Billing Defaults card.
- AI style, document theme/page-size, and invoice footer are document-rendering settings mixed into the same flat card as tax/currency/numbering — no sub-grouping by concern within "Defaults".

### Accounting integrations (mounted at /integrations#accounting, NOT on the Billing settings page itself)
- **QuickBooks** — `apps/web/src/components/integrations/QuickbooksIntegration.tsx`. Fields/actions: Connect/Reconnect/Disconnect (OAuth), **Invoice push mode** (Automatic on issue / Manual), **Pull payments from QuickBooks** (toggle), **Push payments to QuickBooks** (toggle), **Sync now** (action), **Refresh settings** (re-reads QuickBooks realm currency/multi-currency), plus a nested `QuickbooksMappingWorkbench` (account/tax-code mapping, not read) and `QuickbooksCustomerImport` (not read). Permission gates: `invoices:write` AND `accounting:manage` (both required for every mutating control); hidden entirely for org-scoped sessions.
- **Stripe (Payments)** — `apps/web/src/components/integrations/StripePaymentsIntegration.tsx`. Fields: **Stripe secret key** (password input, POST-only, never re-displayed), Refresh/Disconnect actions, read-only account summary (masked account id, live/test mode, settlement currency, cache staleness, session-revocation health banners).
- Oddities: **These are the only two "real" payment/accounting settings for billing, and neither is reachable from `/settings/billing`.** A user configuring Partner Billing Settings has no link to Accounting integrations, and vice versa — two halves of "how billing works for this MSP" live in entirely separate nav sections (Settings → Billing vs. Settings → Integrations → Accounting) with no cross-navigation.
- `AccountingSyncCard.tsx` is NOT a settings surface — it's a per-invoice sync-status widget embedded in `InvoiceDetail.tsx`/`InvoiceWorkspace.tsx`. Confirmed via grep; excluded from this inventory as a document-level control, not a partner setting.

---

## Surface: Product Catalog — /settings/catalog

- component: `CatalogSettingsPage.tsx` (thin wrapper) → `CatalogItemsTab.tsx`
- scope: partner (client-side org-scope block with a clear message; server enforces `requireScope('partner','system')`)
- permission gate: `usePermissions().can('catalog','write'|'delete')` per action (Edit/Archive/Restore buttons individually gated)
- API: `listCatalog`, `getCatalogItem`, `getBundleEconomics`, `archiveCatalogItem`, `updateCatalogItem` (all via `apps/web/src/lib/api/catalog.ts`, not fully enumerated)
- UI: search/type-filter/active-archived toggle table; **Import from TD SYNNEX** and **Import from Pax8** buttons appear conditionally when those distributor integrations are connected (checked via `ecExpressStatus()`/`pax8Status()`); per-item Archive/Restore/Edit; bundle rows expand to show components + rolled-up cost/margin economics.
- Per-item field editor is `CatalogItemEditorDrawer.tsx` — **not read in this pass**; based on the list-view columns it exposes at minimum Name, Type, SKU, per-currency Unit Price(s), Cost/Cost Currency, and bundle composition. Flagged as not fully verified.
- Distributor import drawers: `CatalogDistributorDrawer.tsx` (TD SYNNEX EC Express) and `Pax8CatalogDrawer.tsx` — both **separate from** the Pax8/TD SYNNEX **connection-configuration** panels that live under `/integrations#distributors` (`Pax8Integration.tsx`, `TdSynnexCatalogPanel.tsx`, `TdSynnexEcExpressPanel.tsx`, `TdSynnexSftpPanel.tsx`) — confirmed via grep that these are genuinely different components (no accidental duplication), but they are two halves of one workflow (connect the distributor vs. import into the catalog) split across two different settings hubs (Integrations vs. Catalog) with no in-app link between them.
- Oddities:
  - Product Catalog sits in the sidebar's top-level "Billing" section (`requiresModule: 'service_management'`) while its distributor CONNECTIONS live under Settings → Integrations → Distributors — same duplication-of-navigation-path issue as Accounting above.
  - Margin math (`marginMath.ts`) referenced by this tab was not read in this pass; flagged for whoever reviews pricing/markup consistency, since Partner Billing Settings' `defaultMarkupPercent` and the Catalog's margin/markup display are two different code paths computing related numbers.

---

## Surface: PSA Connections (ticketing) — /integrations#psa

- component: `apps/web/src/components/psa/PsaConnectionsPage.tsx` (plus `PsaConnectionForm.tsx`, `PsaConnectionList.tsx`, `PsaCompanyImport.tsx`, `PsaTicketList.tsx`) — **not read in this pass**, only confirmed to exist and to be the successor to the retired standalone Ticketing-integration and PSA-integration pages (both of which now redirect here).
- This is the SUCCESSOR surface for "ticketing integration" (Jira/ServiceNow/ConnectWise/Autotask/Freshservice/Zendesk per the code comment in the retired `integrations/ticketing.astro`) — worth a full read in a follow-up pass since it is very likely partner-level ticketing config with its own field set (connection credentials, sync direction, company/customer mapping) analogous to QuickBooks' pattern above.

---

## Not fully inventoried in this pass (time-boxed; flagged rather than fabricated)

- `CatalogItemEditorDrawer.tsx` (per-item catalog fields)
- `DeliverableTemplatesPage.tsx` (code comment confirms it shares the exact same "Partner-Wide First" ownership pattern and TWO-flag gate as `TicketChecklistTemplatesPage.tsx`, i.e. Name/Description/Instructions + create-only ownerScope selector + "All orgs" badge — inferred from that comment, not independently read)
- `CustomFieldsPage.tsx`, `TenantVariablesPage.tsx` (billing/ticketing-relevant subset of fields not isolated)
- `apps/web/src/pages/settings/webhooks/index.astro` and its `WebhooksPage` component (may carry ticket/invoice webhook event types)
- `apps/web/src/components/psa/*` (PSA connection field set)
- `apps/web/src/components/agreements/TemplatesPage.tsx` (partner-level agreement templates — reachable via sidebar "Agreements" nav item, not under `/settings/`)
- `apps/web/src/components/integrations/QuickbooksMappingWorkbench.tsx`, `QuickbooksCustomerImport.tsx` (sub-panels of the QuickBooks card)
- `marginMath.ts` (catalog margin/markup formula, to cross-check against Partner Billing Settings' `defaultMarkupPercent`)

---

## Cross-surface observations (partner level)

**(1) Concepts configured in more than one partner-level place:**
- **Default ticket priority**: Categories tab, Intake Forms editor, and Priorities & SLAs tab all set a version of this with no documented precedence.
- **Billing defaults per category vs. globally**: SLA minutes and (bizarrely) billing rate/billable-by-default are set BOTH globally (Priorities & SLAs tab; Partner Billing Settings markup/tax) AND per-category (Categories tab), with per-category silently taking precedence and no UI cross-reference.
- **Partner "who we are" identity**: Company tab (`PartnerSettingsPage` → name/address/contact) vs. Billing Settings' Company card (`billingCompanyName`/`billingAddress*`/`billingPhone`/`billingWebsite`) — two independent address records.
- **Distributor (Pax8, TD SYNNEX) workflow split in two**: connect/configure the distributor under Integrations, import priced items under Catalog — separate UIs, separate nav sections, no cross-link.
- **Markup/margin math**: Partner Billing Settings' `defaultMarkupPercent` vs. Catalog's live margin display (`marginMath.ts`) — related but not verified as the same formula.
- **canManageInbound gate reuse**: one boolean gates four unrelated Ticketing sub-tabs (Forms, Inbound Email, Canned Responses, Time Tracking).

**(2) Partner-level settings with a known org-level override (named only; not inventoried here):**
- `OrgBillingSettings.tsx` (org-level billing override of partner defaults)
- `OrgTicketSettingsEditor.tsx` (org-level ticket settings override)
- Intake Forms' per-form `visibleOrgIds` allowlist and org-owned forms are an org-level carve-out of the partner-wide Forms feature.
- Ticket Checklist Templates: org-owned templates (`orgId !== null`) coexist with partner-wide ones on the same list.

**(3) Counts:**

Billing-domain partner-level screens/tabs (each counted once):
1. Partner Billing Settings page (2 cards: Defaults, Company) — **~19 fields**
2. Product Catalog (Catalog Items list + per-item drawer not fully counted) — list-level config only counted: filters/import actions, not true "settings" fields (0 persisted settings fields at the list level; per-item fields not verified)
3. QuickBooks integration — **~4 persisted settings fields** (pushMode, pullPayments, pushPayments, plus connect/disconnect actions) + nested mapping workbench (not counted)
4. Stripe Payments integration — **1 persisted field** (API key) + read-only status
5. Ticketing tab's Categories sub-tab billing fields (defaultBillable, defaultHourlyRate, defaultTimeEntryMinutes) — **3 fields**, miscategorized as ticketing
6. Ticketing tab's Time Tracking sub-tab — **3 fields**, miscategorized as ticketing
7. Ticketing tab's Export sub-tab — 0 persisted fields (action-only)

→ **Billing screens: at least 5 distinct partner-level surfaces (2 clearly "billing"-labeled + 3 misfiled-under-ticketing) totaling roughly 30 persisted fields**, not counting the unread Catalog item editor.

Ticketing-domain partner-level screens/tabs:
1. Statuses — 3 fields × N rows
2. Priorities & SLAs — 3 fields × 4 rows = **12 fields**
3. Categories (ticketing-proper fields only: name/color/parent) — **3 fields** × N rows (billing fields counted above)
4. Intake Forms — **~10 top-level fields** + repeating field editor
5. Inbound Email — **~8 fields**
6. M365 Mailbox — **2 fields** (address, display name) + connection actions
7. Canned Responses — **3 fields** × N rows
8. Export — 0 persisted fields

→ **Ticketing screens: 8 sub-tabs under 1 hub tab, totaling roughly 40+ persisted fields** (excluding unread PSA Connections page, which is very likely a large additional ticketing-integration field set).

**Total distinct partner-level settings SCREENS/TABS covering billing or ticketing, counted in this pass: 16** (Partner Ticketing tab counted as 8 sub-tabs + Partner Billing Settings page + Product Catalog + QuickBooks + Stripe + PSA Connections [uncounted fields] + PartnerModulesCard [service mode] + Agreements Templates [uncounted] + Ticket Checklist Templates + Deliverable Templates [uncounted fields, inferred structurally identical] = 16 named surfaces, several with fields not fully enumerated).
