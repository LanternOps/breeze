> Raw inventory produced by a research agent on 2026-09-17 for the billing + ticketing settings audit
> (`../2026-09-17-billing-ticketing-settings-audit.md`). Agent output: file:line citations were
> checked by the agent, not re-read, unless the audit marks the finding **verified**. A few
> claims here were corrected in the audit (default priority is set in two places, not three;
> `defaultMarkupPercent` has several pre-fill readers).

# Org-level & per-document billing/ticketing settings inventory

Scope: every organization-level and per-document surface that configures or
overrides billing/ticketing behavior. Repo:
`<repo root>`.

## OrgSettingsPage — full tab list (for reference)

`apps/web/src/components/settings/OrgSettingsPage.tsx` (961 lines) groups tabs
into nav groups (`TAB_GROUPS`):

- **Organization**: general, contacts (redirects to record), billing
  (redirects... no, renders `OrgBillingSettings`), pax8, extensions
- **Portal & Branding**: branding, portal
- **Security & Access**: security, approval-security
- (ungrouped ids present in `ALL_TABS` but not shown in a labeled group per the
  grep: ai, remote-access, event-logs, audit-retention)
- **Communications**: notifications, ticketing

Two tabs (`contacts`, `contracts`) are **dead redirects**: the `switchTab`
effect immediately `replace`s the URL to the organization RECORD page's
Contacts / Contracts & Billing tab and renders `null`. They remain resolvable
`TabKey`s only so a stale bookmark/deep-link doesn't 404.

---

### Surface: Org Settings → Billing tab — `/settings/organization#billing` (also standalone `/settings/organizations/[id]/billing`)

- nav path: Settings → pick org → Billing tab; **or** directly via
  `/settings/organizations/[id]/billing.astro`, which mounts the exact same
  `OrgBillingSettings` component standalone (two URLs, one component, no
  redirect between them — a bookmarked "billing.astro" link and the in-page
  tab both exist).
- component: `apps/web/src/components/billing/OrgBillingSettings.tsx` (523
  lines)
- permission gate: none visible in this component (relies on the route/page
  guard upstream — not inspected here)
- API: `GET /orgs/organizations/:id` (load), `PATCH /orgs/:id/billing-settings`
  (tax/contact/address save), `GET /orgs/:id/billing-settings/currency-impact`
  (preview), `PATCH /orgs/:id/billing-settings` (currency-only payload, second
  call site, separate confirm flow)
- Sections & fields:
  - **Currency** — `<select>` — org's billing currency (`currencyCode`) — API
    `currencyCode` (dedicated confirm-only PATCH) — **inherits from:** nothing
    shown as a default; this IS the org-level value quotes/invoices/contracts
    stamp from. Changing it triggers a same-currency-only impact preview
    (draft docs, contracts, unbilled time/parts) before confirming — a 409
    `ORG_CURRENCY_CHANGED` re-arms the precondition against a fresher value.
  - **Tax ID** — text — `taxId`
  - **Tax rate** — number (%) — `taxRate` (stored as fraction) — placeholder
    literally reads "Partner default" (`orgBillingSettings.tax.partnerDefault`)
    — **inherits from:** partner tax rate default, but the UI never shows the
    actual partner value, only the word "default" in the placeholder (blank =
    inherit, user must know to leave it blank).
  - **Tax exempt** — checkbox — `taxExempt` (disables the rate field when on)
  - **Billing contact email / name** — text — `billingContactEmail` /
    `billingContactName`
  - **Billing address** (line1/line2/city/region/postal/country) — text —
    `billingAddress*`
- Oddities:
  - Currency change UX lives entirely inside a "billing settings" screen but
    its impact-preview endpoint enumerates **contracts** and **time/parts**
    counts too — a billing-settings surface reaching into contract and
    ticket-time domains.
  - Reachable by two distinct URLs with no cross-link/redirect
    (`/settings/organization#billing` tab vs.
    `/settings/organizations/[id]/billing.astro`), both mounting the identical
    component — a literal duplicate entry point, not just a duplicate concept.
  - Tax rate's "inherits from partner" is only a placeholder string; nothing
    in the DOM shows the resolved partner numeric default the way
    `OrgTicketSettingsEditor` does for SLAs.

### Surface: Org Settings → Ticketing tab — `/settings/organization#ticketing`

- nav path: Settings → pick org → Ticketing tab (`orgSettingsPage.nav.ticketing`)
- component: `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx`
  (302 lines)
- permission gate: none found in the component itself
- API: `GET /orgs/organizations/:id/ticket-settings`, `GET` partner ticket
  config (`fetchTicketConfig()`), `PATCH /orgs/organizations/:id/ticket-settings`
- Sections & fields:
  - **SLA overrides** — one response/resolution minutes number pair per
    ticket priority (from `PRIORITIES`) — API `slaOverrides[priority]` —
    **inherits from:** partner's per-priority SLA config
    (`partnerConfig.priorities[p].responseSlaMinutes` /
    `resolutionSlaMinutes`), and the UI **does show it** — as the input's
    `placeholder`, computed by `getPlaceholder()`, falling back to the literal
    "Partner default" string only when the partner has no value either.
  - **Default hourly rate** — number, labeled with the org's resolved
    currency (`hourlyRate ({currency})`) — API `defaultHourlyRate` — a
    currency-mismatch banner (`org-ticket-currency-nudge`) appears when
    `orgCurrency !== partnerCurrency`, warning the tech that this org bills in
    a different currency than the partner default. **inherits from:** no
    partner rate is shown numerically; placeholder is just "Partner default"
    text.
  - **Default billable** — 3-way select `inherit` / `billable` /
    `non-billable` — API `defaultBillable` (`null` = inherit) — explicit
    tri-state inheritance UI, the clearest inheritance affordance in the whole
    audit.
- Oddities:
  - This is a **ticketing-tab** screen but two of its three sections
    (`defaultHourlyRate`, `defaultBillable`) are pure billing configuration —
    the file itself is under `components/settings/`, imported by
    `../../lib/ticketConfigApi` for labels, yet titled/tabbed as "Ticketing."
  - Save has a bespoke dirty-diff rule: `defaultHourlyRate` is only sent when
    it actually changed vs. the loaded value (comment cites #3776) — a
    different save discipline than every other screen in this audit, which
    just always PATCHes the full draft.
  - `orgCurrency`/`partnerCurrency` are returned by this ticket-settings GET
    (not the billing-settings GET) specifically so partner-scoped tokens
    still resolve them — a billing fact (currency) is being smuggled through
    a ticketing endpoint's response shape.

### Surface: Org Settings → Portal tab — `/settings/organization#portal`

- nav path: Settings → pick org → Portal Branding group → Portal
- component: `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx`
  (365 lines), plus `OrgPortalUsersEditor` mounted alongside (user management,
  out of scope)
- permission gate: none found in component
- API: `GET/PATCH /orgs/organizations/:id/portal-settings`
- Sections & fields (this is the surface that switches billing/tickets/etc.
  on/off for the customer portal):
  - **Feature toggles** (customer-facing capability switches):
    - Enable ticket submission — checkbox — `enableTickets`
    - Enable asset checkout — checkbox — `enableAssetCheckout`
    - Enable self-service — checkbox — `enableSelfService`
    - Enable password reset — checkbox — `enablePasswordReset`
  - **Visibility toggles** (which portal sections/nav items show):
    - Devices — `enableDevices`
    - Dashboard — `enableDashboard`
    - Security — `enableSecurity`
    - Backups — `enableBackups`
    - Reports — `enableReports`
    - Support usage — `enableSupportUsage`
    - Service — `enableService`
    - Documents — `enableDocuments`
    - Lifecycle — `enableLifecycle`
    - "Enable all" bulk button sets all nine visibility toggles true at once
  - **Support & branding text**: support email, support phone, welcome
    message, footer text — `supportEmail`/`supportPhone`/`welcomeMessage`/
    `footerText`
- Oddities: none of these fields have a visible "inherits from partner"
  affordance or placeholder — every toggle is a flat org-level boolean with no
  partner-level portal-defaults screen found anywhere in this audit (see
  cross-surface section — this may be a genuinely missing inheritance level,
  not just an unshown one).

### Surface: Org Record → Contracts & Billing tab — `/organizations/[id]#billing`

- nav path: Organizations → open an org record → "Contracts & Billing" tab.
  **Reachable a second way conceptually**: this is where
  `OrgSettingsPage`'s dead `contracts` tab redirects to.
- component: `apps/web/src/components/organizations/record/OrgBillingTab.tsx`
  (91 lines) — a pure composition shell stacking four independent full pages
  (`ContractsList`, `InvoicesPage`, `QuotesPage`, `SignedAgreementsPage`),
  each `lockedOrgId`-scoped
- permission gate: `orgRecordTabs.ts` `TAB_PERMISSION.billing` = ANY-of
  `contracts:read`, `invoices:read`, `quotes:read`, `agreements:read`; tab
  hidden entirely if Service Management mode is `off` (native/external modes
  keep it, `off` hides it — see `SERVICE_MANAGEMENT_TABS`)
- API: whatever each embedded list page calls (not separately audited here —
  no bespoke fetch in this file)
- Sections & fields: no config fields of its own — it is a browsing surface
  (contracts / invoices / quotes / signed agreements lists), not a settings
  editor. Included because it is the org-level place a tech reaches
  per-document billing artifacts from, and because it absorbed the Settings
  page's old "Contracts" tab.
- Oddities:
  - All four embedded pages stay mounted regardless of which `<details>` is
    collapsed — opening this tab costs as much as loading all four standalone
    pages at once (documented in-file as a deliberate tradeoff).
  - This is the tab OrgSettingsPage's `billing`/`contracts` keys both
    ultimately point at conceptually (billing tab renders `OrgBillingSettings`
    directly; contracts tab redirects here) — two different "billing" tabs
    across two different pages, one is org financial config, the other is a
    document browser, sharing the word "Billing" in their labels.

### Surface: Org Record → Tickets tab — `/organizations/[id]#tickets`

- component: `apps/web/src/components/organizations/record/OrgTicketsTab.tsx`
- permission gate: `tickets:read`; hidden under Service Management `off`
- No settings fields — a scoped ticket queue view (open/all/closed) with a
  "new ticket" link. Ticket config (priority labels) is fetched via the
  ambient partner-wide cache, deliberately not org-scoped (per in-code
  comment) since ticket config is partner-wide, not per-org.

### Surface: Org Record → Service tab — `/organizations/[id]#service`

- component: `OrgServiceTab.tsx` — service deliverables (SLA-adjacent, not
  billing config) filed under a contract. Gated on `contracts:read`. No
  config fields; a deliverables tracker, out of scope as a settings surface
  but flagged because it sits in the domain and is gated by the billing
  read-grant (`contracts:read`), reinforcing the billing/service coupling.

### Surface: Contract editor — `/contracts/[id]` (per-document overrides)

- component: `apps/web/src/components/contracts/ContractEditor.tsx` (1861
  lines)
- API: contract CRUD routes (not individually traced)
- Fields that override a default (line-items excluded):
  - **Currency** (`contract.currencyCode`) — set once, stamps every line
    price/estimate on the contract (`formatMoney(..., contract.currencyCode)`
    used ~10x for line totals/estimates/errors). **inherits from:** the org's
    currency at contract-creation time (inferred — not independently editable
    after creation in the reviewed code; no currency `<select>` found in this
    file, unlike the quote/invoice editors' read of `quote.currencyCode` /
    `invoice.currencyCode` which are likewise stamped, not chosen, per-doc).
  - **Billing timing / effective months / start–end date / auto-issue /
    auto-renew / renewal term months / renewal notice days** — contract
    lifecycle controls (`billingTiming`, `autoIssue`, `autoRenew`,
    `renewalTermMonths`, `renewalNoticeDays`) — these are per-document
    schedule/behavior overrides, not shown as inheriting from any org/partner
    default in the reviewed code (no placeholder/comment naming a default
    source).
  - **Notes** — freeform textarea, autosaves on blur (`notes`, dirty-tracked
    separately per field with its own ring/saved-state indicator) — content,
    not really a "default override," included per the audit brief's
    footer/notes category.
- Oddities: this file (1861 lines) is the single largest per-document editor
  in the audit and mixes per-field autosave (`savePatch` per key, e.g. notes
  commits independently on blur) with the header-level batched save
  (`canSaveHeader`) — an inconsistent save granularity model versus the
  Quote/Invoice editors' scoped-action pattern (`runScoped`).

### Surface: Quote editor — `/quotes/[id]` (per-document overrides)

- component: `apps/web/src/components/billing/quotes/QuoteEditor.tsx` (very
  large; only override-relevant fields extracted)
- Fields:
  - **Currency** (`quote.currencyCode`) — stamped on the quote, drives every
    price/total format call; no in-editor currency switcher found (contrast
    with `OrgBillingSettings`'s org-level currency-change flow, which is the
    only place currency is actually *changed*, with an impact preview).
    **inherits from:** the org's currency at creation (inferred).
  - **Tax rate** (`quote.taxRate`) — displayed read-only in the live-totals
    rail (`quotes.editor.liveTotals.taxRate`, shows "N/A" if unset) — no input
    control found in this file to edit it directly; it flows in from the org
    default. **inherits from:** org billing settings tax rate (inferred from
    shared field name/shape with `OrgBillingSettings.taxRate`) — UI shows the
    resolved value but not explicitly labeled "inherited."
  - **Deposit type / deposit percent** — `<select>` (none / percent /
    selected_lines) + percent input — API `depositType` / `depositPercent`,
    saved via its own scoped PATCH (`saveDeposit`) independent of the rest of
    the quote body — a genuine per-document billing override with its own
    save/revert cycle and validation (`DEPOSIT_NOT_BELOW_TOTAL`).
  - **Default markup %** — NOT a quote field; it's the *partner's*
    `defaultMarkupPercent` (fetched from `/orgs/partners/me`) pulled into this
    editor purely to pre-price a manually-added line via "Auto-fill from
    web" (cost × (1 + markup)). This is a partner-level billing default
    reaching directly into a per-document editor with no org-level override
    step in between.
- Oddities:
  - The partner default markup is fetched with a bare, silently-swallowed
    try/catch ("optional context" — never blocks the editor); an org-scoped
    token or a failed fetch leaves it `null` with no user-visible indication
    that auto-fill degraded.
  - Deposit config saves through its own isolated action (`saveScoped`) while
    tax rate/currency are read-only display-only fields in the same editor —
    inconsistent editability within one document's billing fields.

### Surface: Invoice editor — `/invoices/[id]` (per-document overrides)

- component: `apps/web/src/components/billing/InvoiceEditor.tsx`
- Fields:
  - **Currency** (`invoice.currencyCode`) — read-only, stamps line
    formatting; no switcher in-file.
  - **Tax rate** (`invoice.taxRate`) — read-only summary display
    (`invoiceEditor.summary.tax`, shows the % only if `noTaxRate` is false) —
    same pattern as quotes: computed/displayed, not directly editable here.
  - **Notes** — textarea, own scoped PATCH (`runScoped('notes', ...)`),
    independent dirty-tracking with a "flash saved" indicator
    (`flashNotesSaved`) — per-document freeform override, saved separately
    from line items.
- Oddities: identical "currency/tax are read-only, notes is the only
  free-editable billing-adjacent field" shape as the quote editor — consistent
  *within* documents, but neither editor exposes WHERE currency/tax actually
  got set, which forces a user hunting for "why is this invoice in the wrong
  currency" back to Org Settings → Billing, a completely different page.

### Surface: Ticket-level & time-entry-level billing config — `/tickets/[id]` (TicketTimeBilling panel)

- component: `apps/web/src/components/tickets/TicketTimeBilling.tsx`
- API: `GET /tickets/:id/billing-summary` (returns `defaults: {hourlyRate,
  currencyCode, isBillable}` — the ticket's *resolved* default, already
  flattened through org/partner), `GET /tickets/:id/time-entries`, `POST
  /time-entries`
- Fields (per time-entry, filed while embedded in a ticket panel):
  - **Billable** — checkbox, defaults to `true` locally, but the server
    resolves the real default (`summary.defaults.isBillable`) — the checkbox
    does NOT read that resolved default into its initial state (hardcoded
    `useState(true)`), a mismatch: rate correctly prefills from the resolved
    default, billable does not.
  - **Hourly rate** — number, prefilled from `summary.defaults.hourlyRate`
    until the tech types over it (explicit "derived, not stored" comment) —
    currency label shown alongside (`rateCurrency`) so the tech knows what
    unit the rate is in. **inherits from:** ticket-level default → org
    default hourly rate (`OrgTicketSettingsEditor.defaultHourlyRate`) →
    partner default, resolved server-side into one number; the UI shows the
    resolved value (good) but not which level it came from.
  - Missing-rate + billable combination surfaces an inline warning
    (`noRateWarning`) that mirrors a real server-side 409
    (`ALL_MISSING_RATE`) at invoice-assembly time — a rare example of a UI
    warning that actually maps to a downstream contract.
- Oddities: this is billing config living entirely inside a ticketing
  component/domain (`components/tickets/`) — the audit brief's "field in the
  wrong domain" case is literal here: `isBillable`/`hourlyRate` per time entry
  are billing fields authored and edited from the ticket workbench, with zero
  presence in `OrgBillingSettings`.

---

## Cross-surface observations (org + document level)

### 1. Concepts editable in more than one org-level place

- **Currency**: shown/derived in `OrgBillingSettings` (the only place it can
  actually be *changed*, with an impact-preview + confirm flow), echoed
  read-only in `OrgTicketSettingsEditor` (as `orgCurrency`/`partnerCurrency`
  for the mismatch nudge), and stamped (read-only) into every Contract/Quote/
  Invoice editor. One canonical write surface, at least four read surfaces.
- **Tax rate**: writable in `OrgBillingSettings` (`taxRate`), read-only
  display in Quote and Invoice editors. No second writable location found.
- **Default hourly rate / default billable**: writable ONLY in
  `OrgTicketSettingsEditor` despite being billing data; read (as resolved
  defaults) in `TicketTimeBilling`'s per-entry panel.
- **"Billing" as a tab label**: exists on `OrgSettingsPage` (financial config:
  currency/tax/contact/address) AND on the org record page (`OrgBillingTab`:
  a document browser for contracts/invoices/quotes/agreements) — same word,
  disjoint content, disjoint components, disjoint URLs, and the Settings
  page's OWN `contracts` tab silently redirects into the record page's
  version, so a partner tech can legitimately end up on either "Billing" tab
  depending which link they clicked.
- **Portal on/off toggles for billing/tickets/documents**: only editable in
  `OrgPortalSettingsEditor`; no equivalent partner-wide portal-defaults screen
  was found anywhere in this audit (see gap below).

### 2. Inheritance chains observed

- `partner tax rate default → org taxRate (OrgBillingSettings, blank = inherit) → quote.taxRate / invoice.taxRate (read-only, resolved)`
- `partner per-priority SLA config → org slaOverrides[priority] (OrgTicketSettingsEditor, placeholder shows the partner number) → (ticket-level SLA, not audited here)`
- `partner defaultMarkupPercent → QuoteEditor "Auto-fill from web" line pricing` — **org level is MISSING** from this chain entirely; the quote editor reads the partner value directly, with no org-level markup override screen in between (Partner-Wide-First pattern from CLAUDE.md would predict an org XOR partner shape here, but no org-scoped markup field was found).
- `partner default hourly rate/billable (ticket config) → org defaultHourlyRate/defaultBillable (OrgTicketSettingsEditor, tri-state 'inherit'/'true'/'false') → ticket billing-summary defaults → per-time-entry hourlyRate/isBillable (TicketTimeBilling, prefilled but overridable)` — the most complete, most legible 4-level chain in the audit.
- `org currencyCode (OrgBillingSettings, only place it's writable) → contract.currencyCode / quote.currencyCode / invoice.currencyCode (stamped at creation, read-only in every document editor reviewed)` — **direction is as expected (org → document)**, but no document editor shows *when/whether* it still matches the org's current value, and `OrgBillingSettings`'s own currency-change flow is the only place that surfaces the blast radius (draft docs/contracts/unbilled time in the impacted currency).
- Portal toggles (`OrgPortalSettingsEditor`) have **no partner-level default** — every org's portal config is independently set with no observed "Partner default" placeholder/inheritance pattern, unlike every billing/ticketing field above.

### 3. Counts

- Distinct **org-level** screens/tabs/cards touching billing or ticketing
  (not counting per-document editors or the ticket-time panel): **6** —
  OrgSettingsPage Billing tab, OrgSettingsPage Ticketing tab, OrgSettingsPage
  Portal tab (billing/ticket-adjacent toggles), org-record Contracts &
  Billing tab, org-record Tickets tab, org-record Service tab. (Standalone
  `/settings/organizations/[id]/billing.astro` is the same component as
  OrgSettingsPage Billing, not counted separately.)
- Total **distinct fields** counted across those org-level screens: **~35**
  (Billing: 9 — currency, taxId, taxRate, taxExempt, contactEmail,
  contactName, line1, line2, city/region/postal/country counted as one
  address group of 4 = effectively 12 if split; Ticketing: 3 groups —
  per-priority SLA response+resolution (counted as 2 fields × N priorities,
  reported as 2 field TYPES), defaultHourlyRate, defaultBillable; Portal: 4
  feature toggles + 9 visibility toggles + 4 text fields = 17).
- Per-document override fields identified (excluding line items): Contract
  ~7 (currency, billingTiming, effectiveMonths, autoIssue, autoRenew,
  renewalTermMonths, renewalNoticeDays, notes), Quote 4 (currency [display],
  taxRate [display], depositType, depositPercent), Invoice 3 (currency
  [display], taxRate [display], notes).
- Ticket/time-entry billing fields: 2 (isBillable, hourlyRate) per time
  entry, resolved through the 4-level chain above.

### Could not determine

- Whether `ContractEditor.currencyCode` is user-editable post-creation (no
  `<select>` found for it in the grepped sections; only read/formatted) —
  inferred read-only, not verified against the full 1861-line file or the API
  schema.
- The exact partner-level screens this all inherits from
  (`/settings/billing.astro`, `/settings/ticketing.astro`) were not opened in
  this pass — labeled here as inferred sources, not verified field-for-field
  against the org-level screens above.
- Permission gates for `OrgBillingSettings`, `OrgTicketSettingsEditor`, and
  `OrgPortalSettingsEditor` — none found inside the components themselves;
  they may be enforced entirely at the route/page layer (not traced).
