# Billing + ticketing settings — audit and consolidation direction

Status: **approved by Todd 2026-09-17** — all five decisions taken as recommended (§8). Not a
build spec — it ends in five decisions and a ranked list of moves; the approved moves become
one tracked feature (#6164), planned under `docs/superpowers/plans/web-ui/`.
Origin: Todd, 2026-09-17, while reviewing the billing-profiles spec (#4628): "I see
\[spaghetti\] already happening with the billing and ticketing settings and want to
consolidate and simplify it instead of adding mess."
Method: three field-level inventories (partner UI, org + document UI, backend storage and
resolution), then the load-bearing claims re-read in code. Every finding is labelled
**verified** (re-read by the author) or **reported** (an inventory agent cited file:line; not
re-read). Raw inventories: `settings-audit-2026-09-17/` beside this file.
No design quorum was run: nothing here is built from this document; each behaviour-changing
move gets its own spec and review.

---

## 1. The short version

About **26 surfaces, ~90 stored fields, 23 tables**. That is not the problem — an MSP
billing + service desk needs roughly that many knobs. The problem is where they are and how
they behave:

| Class | What it means | Count |
|---|---|---|
| **A. Two homes** | the same thing is edited, or reached, in two places | 6 |
| **B. Wrong home** | a setting sits in a different domain from the one it controls | 7 |
| **C. Orphans and dead ends** | screens with no nav entry, dead code, dead tabs | 6 |
| **D. Inheritance that behaves differently each time** | direction, snapshot timing, missing levels, invisible inherited values | 9 |
| **E. Mechanics** | save patterns, gate naming, untyped blobs | 5 |

Only **six** concepts are genuinely configured at more than one level (SLA, labour rate,
tax, document theme, footer / terms, catalog price) — and they resolve **three different
ways**. Fixing placement and making those six behave identically removes most of the mess
without deleting a single capability. Table merging is *not* recommended (§5).

## 2. Findings

### A. Two homes

1. **The MSP's own identity is entered twice.** Settings → Partner → Company
   (`PartnerCompanyTab.tsx`: name, address, phone, website, in the `partners.settings` blob)
   and Settings → Billing → Company card (`billing_company_name`, `billing_address_*`,
   `billing_phone`, `billing_website` columns). No link, no "same as company". *verified*
2. **The org billing form has two URLs.** `OrgBillingSettings` is mounted in the org
   settings page's Billing tab *and* standalone at `/settings/organizations/[id]/billing`,
   with no redirect between them. *verified*
3. **Two different things answer to `#billing` on an org.** Org *settings* → "Billing"
   (currency, tax, bill-to) vs org *record* → "Contracts & Billing" (a document browser).
   The settings page's own `contracts` and `contacts` tabs silently redirect to the record
   page. *verified (labels), reported (redirects)*
4. **Labour pricing in three places** — ticket category, org ticket settings, the entry.
   Already specced for removal: #4628 r2. *verified*
5. **Default ticket priority in two places** with no stated precedence: ticket category and
   intake form. (An inventory reported three; `ticket_priority_settings` has no default
   column.) *verified*
6. `/settings/webhooks` and `/integrations#webhooks` render the same component. Outside
   this audit's domain; listed because the fix is one redirect. *verified*

### B. Wrong home

7. **Labour rate and billable default are filed under Ticketing twice** — partner
   Categories tab and org Ticketing tab. → #4628. *verified*
8. **The billables CSV export is a tab in Ticketing *settings*.** It is an action, not a
   setting, and it is a billing action. *reported*
9. **The master switch for the whole Service Desk + Billing product** (`serviceManagementMode`)
   is one card at the bottom of the partner **Company** tab, autosaving inside a tab that
   otherwise uses a page-level Save. `external` is a valid stored value the UI cannot
   select. *reported*
10. **Catalog defaults live on the Billing defaults card.** `defaultMarkupPercent`,
    `autoTaxHardware` and `catalogAiStyle` only ever pre-fill catalog import, TD SYNNEX
    import and the quote editor's auto-fill; they never enter price resolution
    (`resolvePrice`). They belong with the catalog. *verified (readers)*
11. **Payments and accounting are unreachable from Billing settings.** Stripe and QuickBooks
    live under Integrations → Accounting with no link either way. *reported*
12. **Distributors are split the same way**: connect Pax8 / TD SYNNEX under Integrations,
    import from them under Catalog, no cross-link. *reported*
13. **Product Catalog sits in the Billing nav section but at `/settings/catalog`**; Billing
    settings sits in the Settings section. Ticketing settings has **no** sidebar entry at
    all — it is a tab inside Settings → Partner, with eight sub-tabs on a second hash level
    (`#ticketing` then `#tab=`). Billing and Ticketing are asymmetric. *verified*

### C. Orphans and dead ends

14. **Ticket checklist templates and deliverable templates have no sidebar entry** — only a
    card on the settings index and deep links. *verified*
15. `TicketingSettingsPage.tsx` is dead: only its own test imports it. *verified*
16. Org settings `contacts` / `contracts` tabs exist only to redirect. *reported*
17. `sites.settings` jsonb: no billing or ticketing reader found. *reported*
18. `partner_inbound_domains` is an unused seam (per its own comment). *reported*
19. Canned responses have a free-text **"Category"** unrelated to the Ticket Categories
    entity two tabs away. *reported*

### D. Inheritance that behaves differently each time

20. **Direction flips inside ticketing.** SLA: category beats org
    (`ticketSla.ts:40-47`). Labour rate: org beats category
    (`timeEntryService.ts:231-265`). After #4628 the rate chain is gone and SLA is the only
    category-vs-org chain left — so this resolves itself if SLA's direction is *documented
    in the UI*. *verified*
21. **Quotes snapshot their theme; invoices do not.** A quote freezes theme and page size at
    send (`presentationSnapshot`). Invoices have no such column and read the partner's
    current theme at every render (`invoicesPublic.ts:165-166`) — changing the theme
    restyles every invoice ever issued. *verified*
    **Narrowed (planning, 2026-09-17):** the restyling reaches the public web view and the
    in-app preview; `services/invoicePdf.ts` has no theme or page-size handling at all, so
    the stored PDF artifact is not themed. *verified*
22. **The invoice footer is resolved twice, differently.** At issue:
    `partner.invoiceFooter`. At render: `invoice.terms → partner.invoiceFooter →
    portal_branding.footerText`. The render path has a fallback the snapshot never
    considered. *verified*
23. **Draft tax differs by document.** Quote drafts resolve org → partner; invoice drafts
    resolve org only and apply the partner default at issue (deliberate per a code comment,
    but a draft invoice shows a different tax from the quote it came from). *reported*
24. **`resolveQuoteTaxRate` escalates to system context for a plain config read**
    (`quoteService.ts:391-400`, `runOutsideDbContext(() => withSystemDbAccessContext(…))`)
    — the pattern CLAUDE.md retired after #2417. *verified*
    **Correction (planning, 2026-09-17):** `partners` is a partner-AXIS table, the one case
    where CLAUDE.md still reserves the escalation — through the sanctioned helper
    `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts`). The defect is narrower than
    first written: the escalation is hand-rolled instead of using the helper, and the
    `organizations` row — visible to the request context — is read under system scope too.
    *verified*
25. **Inherited values are shown inconsistently.** Org SLA overrides show the partner's
    number as the placeholder. Org tax rate shows the words "Partner default" and no number.
    Portal toggles show nothing. *reported*
26. **Levels are missing unevenly.** Payment terms: partner only. Markup default: partner
    only. Deposit: no default at any level. Portal feature toggles: org only, no partner
    default — every org is configured by hand, which is the opposite of Partner-Wide First.
    Auto-email on accept: partner only. *reported*
27. **Currency is three unreconciled facts**: partner `currencyCode`, QuickBooks
    `homeCurrency`, Stripe's cached `defaultCurrency`. *reported*
28. Documents show stamped currency and tax read-only with no pointer to where they came
    from; the only explanation is on the org billing page. *reported*

### E. Mechanics

29. **Save patterns are mixed, sometimes within one card.** Inbound Email stacks autosave
    toggles, an explicit-Save-plus-confirm field and a second Save button. The partner hub
    mixes a page-level Save with three self-saving tabs. `OrgTicketSettingsEditor` has a
    bespoke send-only-if-changed rule (#3776). *reported*
30. One boolean named `canManageInbound` (= partner scope) gates four unrelated tabs. *reported*
31. **No permission gate inside most settings components** — they rely on nav flags and the
    route. Fine if the routes are right; worth one sweep. *reported*
32. `partners.settings` / `organizations.settings` are untyped jsonb with no full zod
    schema; billing already moved off the blob onto columns for exactly this reason
    (`orgs.ts:44-52`), ticketing has not (`inbound`, `timeTracking`). *reported*
33. Inbound email PATCHes the same endpoint with two shapes (`settings.ticketing.inbound.*`
    and top-level `inboundLocalPart`). *reported*

**Expected settings that do not exist at all** (so nothing to consolidate, but worth
knowing before someone adds them in a fourth place): default assignee / routing,
auto-close, business-hours calendars (SLA runs on raw minutes), a require-approval-before-
billing switch. *reported*

## 3. Rules — what "clean" means from here on

1. **One concept, one home.** A setting is edited in exactly one place per level.
2. **Settings live with their domain.** Billing settings under Billing, ticketing under
   Ticketing. Actions and reports are not settings.
3. **Two levels, one direction.** Partner default → org override → snapshotted on the
   document. The org always wins. The single exception (SLA: category beats org) is stated
   in the UI where it applies.
4. **One inheritance control.** Blank = inherit; the field always shows the inherited
   *value* and where it comes from. One shared component.
5. **One resolver per concept**, used by draft, issue and render.
6. **One snapshot moment.** Whatever prints on a customer document is frozen when the
   document becomes customer-visible (quote send, invoice issue).
7. **One save pattern per screen type.** Forms: page Save. Lists: row drawer Save. Switches
   with immediate effect: autosave with a toast. Never mixed in a card.
8. **Every screen is in the nav, at one URL.** Old URLs redirect.
9. **A PR that adds a setting states its home, level, resolver, and the number of places
   the concept is configured before and after.** A count that goes up needs a removal plan.

Rule 9 is the #4628 lesson; rules 8 and 1 can be partly mechanical (§6).

## 4. Target layout

**Partner — two symmetrical settings pages, single-level tabs** (Open Decision 1):

- **Settings → Billing**: *Defaults* (currency, tax rate, payment terms, numbering,
  auto-email) · *Documents* (theme, page size, footer, terms & conditions, device appendix,
  letterhead — "use company details" unless overridden) · *Rates* (#4628) · *Connections*
  (read-only status of Stripe and QuickBooks, linking to Integrations — a link, not a second
  editor).
- **Settings → Ticketing**: *Statuses* · *Priorities & SLAs* · *Categories* (name, colour,
  parent, default priority, SLA, default work type, default minutes) · *Intake forms* ·
  *Email* (inbound, M365 mailboxes, customer domains) · *Templates* (canned responses +
  checklist templates) · *Time capture* (session suggestions).
- **Catalog** keeps its place in the Billing nav section and gains a *Catalog defaults* card
  (markup, auto-tax hardware, AI copy style) and a link to Distributors.
- **Deliverable templates** move under Billing (they belong to service plans), with a nav
  entry.
- **Billables export** moves out of settings to where billables are reviewed.
- **Modules switch** gets a visible home of its own in the partner hub.

**Org — overrides only, each showing what it overrides:**

- Org settings → **Billing**: currency, tax, bill-to, billing profile (#4628), payment terms
  override (Open Decision 4). One URL.
- Org settings → **Ticketing**: SLA overrides — and after #4628, nothing else.
- Org settings → **Portal**: unchanged, optionally seeded from a partner template (Open
  Decision 4).
- Org record → "Contracts & Billing" stays a document browser and links to the settings tab.

## 5. Moves, ranked

**Wave 0 — placement; UI only, no data, no behaviour change**

| # | Move | Size |
|---|---|---|
| M0 | Decision 1A: `Settings → Ticketing` becomes its own page with single-level tabs and a sidebar entry; the partner hub's `#ticketing` tab becomes a link and old `#ticketing` / `#tab=` URLs redirect. (Implied by §4; made explicit at planning, 2026-09-17.) | M |
| M1 | Redirect `/settings/organizations/[id]/billing` to the tab | XS |
| M2 | Delete `TicketingSettingsPage.tsx`; redirect `/settings/webhooks`; drop the dead org tabs after one release | XS |
| M3 | Ticketing → *Templates* tab absorbs checklist templates; deliverable templates get a Billing nav entry | S |
| M4 | Split Billing "Defaults" into Defaults / Documents; move the three catalog fields to the Catalog page | S |
| M5 | Billables export leaves settings | S |
| M6 | Cross-links: Billing ↔ Integrations (accounting, payments), Catalog ↔ Distributors | XS |
| M7 | Modules switch to a visible home; offer `external` or stop storing it | XS |
| M8 | Rename `canManageInbound`; fold customer domains + M365 + inbound into one *Email* tab | XS |
| M9 | Guard test: every `pages/settings/**` page is in the nav, on the settings index, or a redirect | S |

**Wave 1 — one way to inherit; behaviour-preserving**

| # | Move | Size |
|---|---|---|
| M10 | Shared `InheritedField` component; org tax rate shows the partner's number; SLA direction stated on both screens | S |
| M11 | One footer / terms resolver for issue and render (decide the portal-footer fallback once) | S |
| M12 | `resolveQuoteTaxRate`: replace the hand-rolled escalation with `readWithPartnerAxisVisibility` for the `partners` read only; read the org row in the request context — **tenancy-sensitive, full rigor** (see the correction under finding 24) | S |
| M13 | One save pattern per screen type (Inbound Email, partner hub, org ticket editor) | M |
| M14 | zod schemas for the `settings` jsonb sub-objects ticketing still uses | M |

**Wave 2 — behaviour changes; each needs its decision**

| # | Move | Size |
|---|---|---|
| M15 | Labour pricing → one place. **#4628 r2, already specced.** | L |
| M16 | Partner identity: one source; the billing letterhead only overrides | M |
| M17 | Snapshot theme and page size on invoices at issue; backfill existing invoices with the partner's current values so nothing visibly changes | M |
| M18 | Draft invoices resolve tax like draft quotes | S |
| M19 | Org-level payment terms override | M |
| M20 | Partner "portal template" applied to new orgs (not live inheritance) | M |

**Not recommended.** *Merging tables* — `org_ticket_settings` + `portal_branding` into one
`org_settings` row, or the four template families into one generic table. The inventories
flagged both as candidates. The sprawl is an entry-point and behaviour problem, not a
table-count problem; merging buys no user-visible simplification and costs RLS, cascade,
export-policy and org-merge churn on four contracts. After #4628 `org_ticket_settings`
holds only SLA overrides and can simply stay small. *Adding the missing levels wholesale* —
an org markup default (catalog org pricing already covers it) or deposit defaults (nobody
has asked). Each new level is a new place.

## 6. Keeping it clean

- CLAUDE.md gains a short "Settings — one concept, one home" section carrying §3.
- M9's guard test makes rule 8 mechanical (orphans are what code review keeps missing — the
  same lesson as the cascade lists).
- The PR template gains the rule 9 line for PRs touching `pages/settings/**` or a
  `*Settings*` component.

## 7. Sequencing with #4628

#4628's cut-over wave adds a *Rates* tab to Billing settings and deletes fields from the
Categories tab and the org Ticketing tab. It should land in the final layout, not the
current one. **Wave 0 goes first** (it is small and UI-only); #4628 W01 (work types) can run
in parallel; #4628 W02 follows Wave 0.

## 8. Decisions (answered 2026-09-17 — Todd approved the recommendations)

1. **Where do Billing and Ticketing settings live?**
   - **A — two symmetrical pages, `Settings → Billing` and `Settings → Ticketing`, single-
     level tabs**; the partner hub links to Ticketing. Con: partly reverses the recent move
     of Ticketing into the partner hub.
   - **B — both inside the partner hub**: one hub; con: two-level hash tabs for both, and
     Billing's permission gate (`invoices:write`) has to move into the hub.
   - **C — leave as is** (Billing a page, Ticketing a hub tab with sub-tabs).
   **Recommend A.**
   **DECIDED: A** — two symmetrical pages, single-level tabs.

2. **Partner identity (M16).** A — one source, letterhead overrides only when different;
   B — keep two records and add a "copy from company" button. **Recommend A.**
   **DECIDED: A.**

3. **Invoices snapshot their theme at issue (M17).** A — yes, with a no-visible-change
   backfill; B — leave live. **Recommend A** — an issued invoice should not restyle itself.
   **DECIDED: A** — snapshot at issue, no-visible-change backfill.

4. **Missing levels — add only these two?** Org payment terms (M19: net-15 for one client
   is a routine ask) and a partner portal template for new orgs (M20). **Recommend M19 yes,
   M20 optional, nothing else.**
   **DECIDED: M19 yes; M20 stays optional — not in the registered waves, revisit after
   Wave 2; no other new levels.**

5. **Delivery.** A — one tracked feature, "Settings consolidation", three waves as in §5,
   Wave 0 before #4628 W02; B — fold the moves into whatever feature touches each screen
   next. **Recommend A** — B is how it got this way.
   **DECIDED: A** — one tracked feature, three waves, Wave 0 before #4628 W02.

## 9. Limits of this audit

Not read field-by-field: PSA connections, the catalog item editor, the QuickBooks mapping
workbench, agreement templates, Stripe Connect columns, custom fields and variables (custom
fields are device-only; ticket custom fields are an unrelated jsonb). Permission gates were
checked in components, not traced through routes. Counts are approximate. The mobile app and
the customer portal were out of scope.

## 10. Planning corrections (2026-09-17)

Found while the wave plans were written. *verified* = re-read by the orchestrator; *reported*
= a planning agent cited it, not re-read. Findings 21 and 24 carry their corrections inline.

- **Finding 32 / M14 is smaller than written.** `org_ticket_settings.slaOverrides` already
  has an enforced shared zod schema (`packages/shared/src/validators/ticketConfig.ts:61`).
  *verified* `ticket_forms.fields` likewise (`ticketForms.ts`); the real gap is the
  `ticketing.inbound` and `timeTracking.sessionSuggestions` sub-objects, typed only by a
  route-local schema in `routes/orgs.ts`. M14 becomes "promote to shared + tolerant reads".
  *reported*
- **Finding 29 / M13 is smaller than written.** `OrgTicketSettingsEditor` already has one
  page-level Save; the mixed save patterns are inside `InboundEmailCard.tsx`. *reported*
- **Finding 22 / M11.** One render-time computation site (`loadInvoiceForRender`) feeds PDF,
  email, portal and HTML; the defect is only that issue time never considered the
  `portal_branding.footerText` fallback. Unifying changes no issued invoice; a **future**
  invoice with no partner footer snapshots the portal footer at issue instead of tracking it
  live — consistent with rule 6, called out in the plan. *reported*
- **M4 is larger than written.** `PartnerBillingSettings.tsx` has no tab mechanism today; the
  Defaults / Documents / Rates (reserved) / Connections shell is new. *reported*
- **M5 destination decided.** No billables review screen exists; the export becomes an action
  on the Invoices list page (`InvoicesPage.tsx`), not a card in another settings tab.
- **M8.** `canManageInbound` is a local constant in one web file, not a wire contract;
  `CustomerDomainsCard` already renders inside `InboundEmailCard`. *reported*
- **Sequencing against #4628 / #4547.** Critical path is `W01 placement → #4628 W02 →
  #4547 block hours (p1)`. W01 is mount-only on `TicketCategoriesPage.tsx`,
  `OrgTicketSettingsEditor.tsx` and `OrgBillingSettings.tsx`. W02 splits: the API half
  (M11, M12, M14) ships any time; the web half (M10, M13) lands after #4628 W02, which
  rewrites two of its target files. Wave 2 (M16–M19) follows #4547.
