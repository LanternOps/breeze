> Raw inventory produced by a research agent on 2026-09-17 for the billing + ticketing settings audit
> (`../2026-09-17-billing-ticketing-settings-audit.md`). Agent output: file:line citations were
> checked by the agent, not re-read, unless the audit marks the finding **verified**. A few
> claims here were corrected in the audit (default priority is set in two places, not three;
> `defaultMarkupPercent` has several pre-fill readers).

# Billing/Ticketing Settings Backend Audit (Part 3 of 3 — Backend)

Scope: storage + resolution only. Web UI is inventoried by other agents.
All line numbers verified against the working tree at
`<repo root>` on 2026-09-17.

---

## PART A — STORAGE INVENTORY

### 1. `partners` table (`apps/api/src/db/schema/orgs.ts:24-165`)
Route: `apps/api/src/services/invoiceService.ts` `updatePartnerBillingSettings()` (billing fields),
`apps/api/src/routes/orgs.ts` (partner profile / PATCH /partners/me), `apps/api/src/routes/ticketConfig.ts` (service-management mode not here, see below).

| column | type | default | level | meaning | writer |
|---|---|---|---|---|---|
| `timezone` | varchar(64) | 'UTC' | partner | canonical tz default | routes/orgs.ts |
| `settings` jsonb | jsonb | `{}` | partner | untyped blob (security/notifications/eventLogs/defaults/branding categories + `aiBudgets`) | routes/orgs.ts, various |
| `billingEmail` | varchar | null | partner | AR contact address | routes/orgs.ts |
| `emailSignature` | text | null | partner | quote-send email signature | routes/orgs.ts |
| `autoEmailInvoiceOnQuoteAccept` | bool | true | partner | auto-email issued invoice on quote acceptance | invoiceService.ts `updatePartnerBillingSettings` |
| `aiImpactWeights` jsonb | jsonb\|null | null | partner | AI impact-score weight overrides (not billing/ticketing; noted for scope boundary) | — |
| `stripeCustomerId` | text | null | partner | Breeze's own Stripe customer for this MSP's subscription (not Stripe Connect) | billing service (external repo) |
| `currencyCode` | char(3) | 'USD' | partner | partner default currency | invoiceService.ts |
| `defaultTaxRate` | numeric(8,5) | null | partner | fallback tax rate | invoiceService.ts `updatePartnerBillingSettings:909-911` |
| `invoiceNumberPrefix` | varchar(12) | 'INV' | partner | invoice numbering prefix | invoiceService.ts |
| `invoiceTermsDays` | int | 30 | partner | due-date offset (net terms) | invoiceService.ts |
| `invoiceFooter` | text | null | partner | short invoice footer/terms line | invoiceService.ts |
| `documentTheme` | varchar(32) | 'classic' | partner | quote/invoice PDF theme preset | invoiceService.ts, quoteBranding.ts |
| `documentPageSize` | varchar(8) | 'letter' | partner | quote/invoice PDF page size | invoiceService.ts, quoteBranding.ts |
| `billingCompanyName/Phone/Website` | varchar | null | partner | seller identity on documents | invoiceService.ts |
| `billingAddressLine1/2/City/Region/PostalCode/Country` | varchar/char | null | partner | seller address on documents | invoiceService.ts |
| `billingTermsAndConditions` | text | null | partner | full T&C block | invoiceService.ts |
| `defaultMarkupPercent` | numeric(6,2) | null | partner | pre-fill markup % on catalog import only (see Part C — dead-ish config) | invoiceService.ts, routes/catalog/distributors.ts |
| `autoTaxHardware` | bool | true | partner | pre-flag imported hardware as taxable | invoiceService.ts |
| `invoiceDeviceAppendix` | bool | false | partner | default for "Billed devices" invoice appendix (resolved once at issue) | invoiceService.ts |
| `catalogAiStyle` | text | null | partner | AI copy style for catalog enrich | invoiceService.ts |
| `serviceManagementMode` | text enum | 'native' | partner | native / external PSA / off — gates ticket creation & nav | routes for partner settings (native/off/external) |
| `serviceManagementPsaConnectionId` | uuid | null | partner | which PSA connection is "the" one when external | same |
| `inboundLocalPart` | varchar(63) | null | partner | inbound ticket-mailbox local-part | routes for mailbox setup |

### 2. `organizations` table (`apps/api/src/db/schema/orgs.ts:180-233`)
| column | type | default | level | meaning | writer |
|---|---|---|---|---|---|
| `settings` jsonb | jsonb | `{}` | org | same untyped-blob categories as partner, merged via effectiveSettings.ts | routes/orgs.ts |
| `billingContact` jsonb | jsonb | null | org | contact snapshot for invoices | routes/orgs.ts |
| `taxId` | varchar(100) | null | org | tax ID printed on documents | routes/orgs.ts |
| `taxExempt` | bool | false | org | exemption flag (wins tax chain) | routes/orgs.ts |
| `taxRate` | numeric(8,5) | null | org | per-org override rate | routes/orgs.ts |
| `billingAddressLine1/2/City/Region/PostalCode/Country` | varchar/char | null | org | bill-to address | routes/orgs.ts |
| `currencyCode` | char(3) | not null, no default | org | org billing currency (inherited from partner at creation, immutable after wave 6 until currency-change flow) | org creation path, `orgCurrencyService.ts changeOrgCurrency` |

### 3. `sites` table (`orgs.ts:235-249`) — `settings` jsonb default `{}`, site level; no billing/ticket keys identified as read anywhere (candidate dead jsonb — not confirmed).

### 4. `ticketConfig.ts`
- `ticket_statuses` (partner-axis): name, coreStatus, color, sortOrder, isSystem/isActive. Route: `apps/api/src/routes/ticketConfig.ts`.
- `ticket_priority_settings` (partner-axis, one row per priority): `label`, `responseSlaMinutes`, `resolutionSlaMinutes`. Route: `apps/api/src/routes/ticketConfig.ts`.
- `org_ticket_settings` (**1:1 org**): `slaOverrides` jsonb (`{"<priority>":{"responseMinutes":n|null,"resolutionMinutes":n|null}}`, shape owned by shared zod), `defaultHourlyRate` numeric, `rateCurrency` char(3) (stamped from org, never client), `defaultBillable` bool|null. Route: `apps/api/src/routes/ticketConfig.ts` (org-scoped settings endpoint).

### 5. `tickets.ts` (extension tables)
- `ticket_categories` (partner-axis): `defaultPriority`, `responseSlaMinutes`, `resolutionSlaMinutes`, `defaultBillable` (default true), `defaultHourlyRate`, `rateCurrency`, `defaultTimeEntryMinutes` (AI time-entry prefill). Route: `apps/api/src/routes/ticketCategories.ts`.
- `partner_ticket_sequences` (partner+year, counter) — numbering sequence, partner level. Written by ticket-number allocator inside ticketService.ts.

### 6. `timeTracking.ts`
No dedicated "time-tracking settings" table exists. Per-entry columns only (`isBillable`, `hourlyRate`, `isApproved`, `source`). No config row for "require approval" or "auto-capture threshold" was found — see Part C (item exists conceptually in the prompt but not in the backend).

### 7. `contracts.ts`
Contract-level fields that mirror/duplicate partner or org defaults, but are captured once per contract (not resolved from settings): `billingTiming`, `autoIssue`, `autoRenew`, `renewalTermMonths`, `renewalNoticeDays`, `currencyCode` (stamped from org at creation). These are document-level configuration, not resolved defaults. Route: `apps/api/src/services/contractService.ts`.

### 8. `invoices.ts` / `quotes.ts` — header fields that snapshot a default (document level, not settings):
- `invoices.currencyCode`, `taxRate`, `documentLocale`, `deviceAppendix` (NULL pre-issue = inherit `partners.invoice_device_appendix`), `terms` (snapshots `partners.invoiceFooter`), `termsAndConditions` (snapshots `partners.billingTermsAndConditions`).
- `quotes.presentationSnapshot` jsonb (`{theme,pageSize}` snapshotted at send from partner document theme/page size), `quotes.documentLocale`, `quotes.depositType`/`depositPercent` (document-level, no partner/org default exists — see Part B).

### 9. `catalog.ts`
- `catalog_items`: `taxable` (bool, default true), `taxCategory` (varchar), `markupPercent`, `costCurrency` — item-level, partner-axis.
- `catalog_item_prices` (per-currency partner sell price) and `catalog_item_org_pricing` (per-org override price) — this IS a genuine 2-level pricing override (partner price book → org override), resolved by `resolvePrice()` in `catalogService.ts`.
- `td_synnex_*_integrations.settings` jsonb — untyped distributor-connector config blobs (partner level).

### 10. `accounting.ts`
- `accounting_connections`: `homeCurrency`, `multiCurrencyEnabled`, `defaultIncomeAccountRef`, `defaultTaxCodeRef`, `pushMode` ('auto'/'manual'), `pullPayments`, `pushPayments`, `pushPaymentsSince` — all partner-level QuickBooks/Xero mapping & sync-policy settings. Route: `apps/api/src/routes/accounting/index.ts`.
- `accounting_entity_mappings` — per-entity link/sync state, not settings.

### 11. `portal.ts`
- `portal_branding` (**1:1 org**): `logoUrl/faviconUrl/primaryColor/secondaryColor/accentColor/customDomain/welcomeMessage/supportEmail/supportPhone/footerText/customCss` (branding) + 10 `enable*` booleans gating portal nav sections (`enableTickets`, `enableAssetCheckout`, `enableDevices`, `enableSelfService`, `enablePasswordReset`, `enableDashboard`, `enableSecurity`, `enableBackups`, `enableReports`, `enableSupportUsage`, `enableService`, `enableDocuments`, `enableLifecycle`). Route: `apps/api/src/routes/portal/branding.ts`, `apps/api/src/routes/orgPortalSettings.ts`, `apps/api/src/routes/portal/featureFlags.ts`.

### 12. `ticketMailbox.ts` (partner level, inbound ticket email)
`ticket_mailbox_connections`: `mailboxAddress`, `strictSenderAuth` (bool). `ticket_mailbox_tenant_ownerships`, `ticket_mailbox_consent_sessions` — OAuth/consent state, not settings.

### 13. `emailInbound.ts`
- `partner_inbound_domains` — custom inbound-domain config (partner level, currently unused seam per comment).
- `customer_email_domains` (partner + denormalized org): `domain`, `autoCreateContact` (bool) — sender-domain-to-org routing config.

### 14. `ticketResponseTemplates.ts` — partner-axis canned responses (`name`, `body`, `category`, `sortOrder`, `isActive`). Not a "setting" per se but a config library. Route: likely `apps/api/src/routes/ticketConfig.ts` or a dedicated route (not confirmed by file name search — search turned up no dedicated route file; **not verified**).

### 15. `ticketChecklists.ts` — **dual-owned (org XOR partner)** template tables: `ticket_checklist_templates` + `ticket_checklist_template_items`. Candidate for "settings tables keyed 1:1 to org" list is NOT applicable here (dual-axis, not 1:1 org) but is a config-sprawl candidate regardless.

### 16. `ticketForms.ts` + `ticketFormOrgLinks.ts` — **dual-owned (org XOR partner)** ticket intake forms: `fields` jsonb (self-contained, zod-validated `TicketFormField[]`), `titleTemplate`, `descriptionIntro`, `defaultPriority`, `defaultTags`, `showInPortal`. `ticket_form_org_links` is an allowlist join table for partner-wide forms.

### 17. `deliverableTemplates.ts` — **dual-owned (org XOR partner)** deliverable template sets/items: `cadence`, `leadDays`, `graceDays`, `artifactRequired`, `completionMode`, `autoEvidenceReportType`.

### 18. `customFields.ts` — `custom_field_definitions`, **dual-owned (org XOR partner)**, applies to devices (per file comment: "device-only system"), NOT tickets/invoices. `tickets.customFields` jsonb exists on the ticket row itself but has no separate definition table — confirms ticket custom fields are NOT wired into `custom_field_definitions` (Part C smell candidate: two unrelated "custom field" concepts under one name).

### 19. `notifications.ts` — `user_notifications` is a delivery table, not a preference table. No dedicated "notification preferences for ticket/billing events" table was found in schema/ (searched `notificationPreferences`, `notification_prefs` — no hits other than `ticketPushPreferences.ts`, below). This is a **not-found** item vs. the prompt's ask.

### 20. `ticketPushPreferences.ts` — **1:1 user**, mobile push prefs: `assignedEnabled`, `slaScope` ('off'/'owned'/'any'). Default via `resolveTicketPushPrefs` in `@breeze/shared` when row missing.

### 21. `partnerLoginBranding.ts` — **1:1 partner**, technician-login branding only (`logoUrl`, `accentColor`, `headline`) — distinct from `portal_branding` (customer login) despite similar shape.

### 22. `invoiceDocuments.ts` / `orgDocuments.ts` — generated PDF artifact storage, not settings.

### 23. Stripe / payment settings
`stripePayments.ts` was read only at a high level via grep; contains Stripe Connect account/connection state (`getConnection` in `stripeConnectService.ts`, `defaultCurrency` referenced in `invoiceService.ts:731`). **Not fully enumerated column-by-column** — time-boxed; flagged as partially verified.

---

## PART B — RESOLUTION CHAINS

1. **SLA (response/resolution minutes)** — `apps/api/src/services/ticketSla.ts:40-47` `resolveSlaTargets()`:
   `ticket override → ticket_categories → org_ticket_settings.slaOverrides[priority] → ticket_priority_settings (partner) → PRIORITY_SLA_DEFAULTS (hardcoded)`.
   Direction: **category beats org**.

2. **Labour rate / billable default** — `apps/api/src/services/timeEntryService.ts`:
   - `resolveDefaultRate()` (:231-239): `entry override → org_ticket_settings.defaultHourlyRate (match-or-skip on currency) → ticket_categories.defaultHourlyRate (match-or-skip on currency) → null`.
   - `defaultBillable` (`resolveTicketLink`, :265): `entry override (applied by caller) → org_ticket_settings.defaultBillable → ticket_categories.defaultBillable → false`.
   Direction: **org beats category** — **opposite direction from SLA (#1)**. This is the inconsistency already known and independently confirmed at these line numbers.

3. **Tax rate / taxability** — `apps/api/src/services/invoiceMath.ts:60-69` `resolveEffectiveTaxRate()`:
   `org.taxExempt (wins, →0) → org.taxRate → partner.defaultTaxRate → '0'`.
   - Invoice **draft-time** call (`invoiceService.ts:153-158 effectiveRateForOrg`) hardcodes `partnerRate: null` — deliberate per inline comment ("partner default applied authoritatively at issue"), i.e. **draft = READ org-only**, **issue = READ full chain and SNAPSHOT onto `invoices.taxRate`** (`invoiceService.ts:1303`).
   - Quote tax (`quoteService.ts:391-400 resolveQuoteTaxRate`) reads the full chain (org+partner) even in draft, via `runOutsideDbContext(() => withSystemDbAccessContext(...))` — **inconsistent with the invoice draft path**, and this system-context escalation pattern is exactly what CLAUDE.md's tenancy section flags as no-longer-sanctioned for a plain config read (risk: pooled-connection double-hold under the request's own transaction, RLS bypass) — see Part C smell.
   Direction: org beats partner in both, consistent with SLA/rate not being at issue here (only 2 levels).

4. **Document theme & page size** — `apps/api/src/services/quoteBranding.ts:38-40,105-106` `resolveThemeId/resolvePageSize`:
   Quotes: `quote.presentationSnapshot.theme/pageSize (SNAPSHOT at send) → partner.documentTheme/documentPageSize → hardcoded 'classic'/'a4'`.
   Invoices: **no invoice-level snapshot column exists** — `routes/invoicesPublic.ts:165-166` and `routes/orgs.ts:454-455` read `partner.documentTheme/documentPageSize` directly at **render/READ time**, no per-invoice override, no snapshot.
   **Inconsistency**: quotes snapshot the theme at send (immune to later partner changes); invoices resolve it live at every render (a partner theme change retroactively restyles every past invoice PDF, but not past quote PDFs).

5. **Invoice footer / terms text** — `apps/api/src/services/invoiceService.ts:1336-1340` (at issue, SNAPSHOT): `terms: partner.invoiceFooter`, `termsAndConditions: invoice.termsAndConditions (draft-set) → partner.billingTermsAndConditions`.
   Also independently re-resolved at **render time** in `apps/api/src/services/invoicePdf.ts:626`: `invoice.terms → partner.invoiceFooter → portal_branding.footerText`. This is the same fallback logic implemented twice (issue-time snapshot writer + render-time reader), with the render-time version adding a third fallback (`portal_branding.footerText`) that the issue-time snapshot writer does not consider — a **copy-pasted-logic smell** (Part C #6).

6. **Payment terms / due date** — `invoiceService.ts:1305`: `dueDate = issueDate + (partner.invoiceTermsDays ?? 30) days`. **Single level only** (partner), no org override column exists despite `invoiceTermsDays` living only on `partners`. Not a multi-level chain.

7. **Pricing / markup** — `catalogService.ts resolvePrice()`: `catalog_item_org_pricing (org override, by currency) → catalog_item_prices (partner price book, by currency)`. Direction: **org beats partner** (consistent with labour rate, not SLA).
   `partners.defaultMarkupPercent` is **not** part of this chain — it only pre-fills the markup field in the distributor-import UI (`routes/catalog/distributors.ts:268`) at import time; never read again afterward (Part C dead-ish config).

8. **Deposit defaults** — **no chain found**. `quotes.depositType`/`depositPercent` are pure document-level fields with no partner/org default column anywhere in schema or `quoteService.ts`. Every quote starts at `depositType='none'` unconditionally.

9. **Invoice/quote numbering** — `partners.invoiceNumberPrefix` + `partner_invoice_sequences` (partner+year counter); `partner_ticket_sequences` likewise. **Single level** (partner only), no org override.

10. **Default assignee / routing** — **no config found**. Grepped ticketService.ts and the wider services directory for `defaultAssignee`/`autoAssign`/routing config columns; none exist. Ticket assignment is manual or AI-triage driven, not settings-resolved.

11. **Auto-close / status automation** — **no config found**. Grepped for `autoClose`/`auto_close` across services and schema; zero hits. Not implemented as a setting.

12. **Business hours** — **no ticketing/billing table found**. The only `businessHours` hits are in `packages/shared/src/validators/fleetDesign.ts` (unrelated Fleet Designer feature). SLA math (`ticketSla.ts`) works in raw minutes with no business-hours calendar factored in.

13. **Portal visibility** — `portal_branding.enable*` flags, resolved by `apps/api/src/services/portal/portalFlags.ts`. **Single level (org only)** — no partner-wide default/override exists for these flags, unlike the dual-axis pattern CLAUDE.md prescribes for config tables generally.

14. **Time-entry approval requirement** — **no config found**. `timeEntries.isApproved` is a plain per-entry flag set by an explicit approve action (`timeEntryService.ts:747-751,926-927`); no partner/org toggle requiring approval before billing was found.

15. **Time auto-capture / default duration** — `apps/api/src/services/aiTimeEntryProposal.ts:123`: `ticket_categories.defaultTimeEntryMinutes → AI_TIME_ENTRY_DEFAULT_MINUTES (hardcoded 15)`. Two-level chain, category-only, no org/partner level — narrower than the other chains but not inconsistent with anything (nothing else to compare direction against).

16. **Auto-email on issue (quote acceptance → invoice)** — `partners.autoEmailInvoiceOnQuoteAccept`, single partner-level boolean, no per-org override, consulted directly where the invoice is auto-issued.

### Direction-consistency summary
- **Org beats category/partner**: labour rate & billable default (#2), pricing/markup (#7), tax rate org-vs-partner (#3).
- **Category beats org**: SLA (#1) — **the flagged inconsistency**, same shape (ticket-category vs org-level settings) resolved in opposite order from labour rate/billable, in the same ticketing subsystem, by two different services (`ticketSla.ts` vs `timeEntryService.ts`).
- **Snapshot vs read-time inconsistency**: document theme is snapshotted for quotes but read live for invoices (#4); tax rate is read-only-org at invoice draft time but full-chain at quote draft time (#3).

---

## PART C — SMELLS

1. **jsonb blobs vs typed columns**: `partners.settings` / `organizations.settings` / `sites.settings` are untyped jsonb guarded only by the app-layer merge in `apps/api/src/services/effectiveSettings.ts` (no zod schema found for the full `PartnerSettings`/`OrgSettings` shape — searched `packages/shared/src/validators` for `partnerSettingsSchema`/`orgSettingsSchema`, zero hits). The billing-specific settings deliberately moved OFF this blob onto dedicated `partners.*` columns specifically because "settings cards replace sub-objects wholesale" (comments at `orgs.ts:44-52,130-135`) — i.e. the codebase already treats the jsonb blob as unsafe for anything that must not silently drop on a partial PATCH, but ticketing config still has several untyped jsonb fields with no top-level zod contract: `org_ticket_settings.slaOverrides`, `ticket_forms.fields`, `custom_field_definitions.options`/`defaultValue`, `td_synnex_*.settings`.

2. **Settings tables keyed 1:1 to org** (merge candidates): `org_ticket_settings`, `portal_branding`, `ticket_push_preferences` (1:1 *user*, not org), and effectively `organizations.settings` itself (jsonb, 1:1 by definition). `org_ticket_settings` and `portal_branding` are the two clearest ticket/billing-adjacent 1:1-org tables that could be folded into one `org_settings` row per the audit's consolidation goal.

3. **Same concept, different names / shapes**:
   - `partners.defaultTaxRate` vs `organizations.taxRate` (no naming clash, but two different column-name conventions — `default*` prefix at partner level, bare name at org level — repeats across `defaultMarkupPercent`/no-org-equivalent, `defaultHourlyRate` used identically at BOTH `org_ticket_settings` and `ticket_categories` without a `default` vs override naming distinction).
   - `invoiceTermsDays` (partner) has no org-level twin at all, unlike almost every other billing default, which breaks the "org can always override partner" pattern the rest of billing settings follow.
   - "Custom fields": `custom_field_definitions` (dual-owned, device-only per its own comment) vs `tickets.customFields` jsonb (ticket-only, no definition table) — same term, two unconnected mechanisms.
   - `partnerLoginBranding` vs `portalBranding` — both "branding" tables, disjoint purposes (technician login vs customer portal), easy to conflate during consolidation.

4. **Copy-pasted resolver logic instead of one function**: invoice footer/terms fallback is implemented twice — once at issue time (`invoiceService.ts:1336-1340`, snapshot) and again at render time (`invoicePdf.ts:626`, live fallback, with an extra `portal_branding.footerText` fallback the first version lacks). Recommend consolidating into one resolver function.

5. **Sanctioned-pattern violation flagged by CLAUDE.md**: `quoteService.ts:391-400 resolveQuoteTaxRate` uses `runOutsideDbContext(() => withSystemDbAccessContext(...))` to read `partners.defaultTaxRate` for a plain org-XOR-partner-shaped read. CLAUDE.md's tenancy section explicitly says this escalation pattern is "no longer the sanctioned pattern" for this exact shape of config table (should instead use the partner-wide SELECT-only RLS branch) and calls out the concrete risk (pooled-connection double-hold under the request's own `withDbAccessContext` transaction, RLS bypass, citing #2417). **Not independently verified whether a partner-wide SELECT branch exists for `partners` table reads from org scope** — worth a follow-up check before consolidation work touches this code path.

6. **Dead-ish / narrow-use config**: `partners.defaultMarkupPercent` only feeds one UI pre-fill (distributor import), never consulted again at quote/invoice pricing time — effectively write-only outside that one import flow. Candidate to either wire into `resolvePrice()` properly or retire.

7. **UI-field-with-no-backend-setting** (inferred from grep absence, not confirmed against the other two agents' UI inventories): default assignee/routing, auto-close/status-automation, business-hours calendars, and time-entry-approval-requirement all appear in the prompt's checklist as expected settings but have **no corresponding schema column or resolver** anywhere in `apps/api/src/db/schema` or `apps/api/src/services`. If the web UI inventory finds toggles for any of these, they are either purely client-side, computed some other way not found by this grep pass, or dead UI — flag for cross-check with the other two agents.

8. **Ticket response templates / checklist / form / deliverable-template tables** are four structurally near-identical "reusable content library, dual/partner-owned" patterns (`ticketResponseTemplates`, `ticketChecklistTemplates`+items, `ticketForms`, `deliverableTemplateSets`+items) implemented as four separate table families rather than one generic templated-content table — sprawl candidate for consolidation, though each has distinct enough shape (forms have typed `fields`, checklists have ordered labels, deliverables have cadence/lead/grace days) that merging may not be worth it.

---

## WHAT COULD NOT BE DETERMINED (time-boxed)

- Full column-by-column inventory of `stripePayments.ts` (Stripe Connect settings) — only grepped, not read in full.
- Whether a web UI field exists for every stored setting, or vice versa (explicitly out of scope for this backend-only slice; flagged in smell #7 for cross-check).
- The API route file that writes `ticketResponseTemplates` — no dedicated route file was found by name search; likely folded into `ticketConfig.ts` or a route not covered by the filename patterns searched.
- Whether `sites.settings` jsonb carries any live billing/ticket keys (grep found no readers, but this was not exhaustively confirmed — could not rule out a reader under a different property name).
- Full precedence position of `catalog_item_org_pricing`/`catalog_item_prices` relative to `catalog_items.costBasis`/markupPercent inside `resolvePrice()` — direction (org beats partner) was confirmed by table existence and column comments, but the exact `resolvePrice()` function body in `catalogService.ts` was not read line-by-line.
