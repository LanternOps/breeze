# Xero Demo Company Verification

The Xero counterpart of `quickbooks-sandbox-verification.md`. Xero has no
sandbox: every run uses the **Xero Demo Company** (My Xero → Try the Demo
Company), which Xero resets periodically. This is a **living document**:
re-run the relevant section before every release that touches Xero code, and
append a new evidence block rather than overwriting.

Spec: `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md`
("Open verification items"). Plans: `docs/superpowers/plans/billing/2026-09-26-xero-*.md`.

---

## Merge blockers for W02c (PR for wave #7169)

- **X14 — scope strings on the consent screen. BLOCKS MERGE of W02c.** The
  pinned scopes `offline_access accounting.contacts accounting.invoices
  accounting.payments accounting.settings` (was `accounting.settings.read` until lab X16 on 2026-09-28 showed Items cannot be written under it, #7387) were taken from Xero's own
  repositories, not confirmed on the developer portal; a wrong string fails
  every connect at the consent screen.
- **X7 — `authentication_event_id` claim present. BLOCKS MERGE** unless a
  Xero-portal/token check was already recorded for W02a Task 4 Step 1 (it was
  not recorded as of this writing). The callback fails closed with
  `error=auth_event_missing` without it, so a wrong assumption breaks every
  Xero connect.

No environment may set `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` /
`XERO_REDIRECT_URI` until these pass.

- **W03b (wave #7170):** do not merge until X14 + X7 (W02c) and **X16**
  (section 3) pass — X16 gates the mapping/customerImport capability flip.
- **W04b (wave #7171):** do not merge until W02c (X14 + X7) and W03b (X16)
  are merged and **X32, X34/X35 and X38** (section 4) pass — they gate the
  `invoicePush` capability flip, which is W04b's last commit.

---

## 0. Setup

1. A Xero developer account with a **Web app** (developer.xero.com → New app):
   - Redirect URI: `https://<stack-host>/api/v1/accounting/xero/callback`
   - Note the client id / secret; generate a webhook key (W05).
2. Stack: `pnpm wt-stack up` from the W02 branch (see `.claude/skills/worktree-stack`).
   Set in the stack's `.env` **and** confirm the api container sees them
   (`docker exec <api> printenv | grep ^XERO_`):
   `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_DAILY_CALL_LIMIT=1000`.
3. Two Breeze partners (P1, P2), each with a full-partner admin that has MFA
   enrolled. One Xero login (U1) with access to **two** organisations: the
   Demo Company and one real trial organisation (T2). A second Xero login (U2)
   with access to T2 only.

## 1. Automated gate (record the result)

```bash
cd apps/api && npx vitest run src/services/accounting src/routes/accounting src/jobs/accountingReconcileWorker.test.ts \
  src/middleware/selfManagedDbContextRoutes.test.ts src/config src/system/connections
cd apps/web && npx vitest run src/components/integrations src/lib/accountingProviders.test.ts src/lib/orgReadiness src/lib/i18n src/locales src/lib/__tests__/no-silent-mutations.test.ts
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroConnection.integration.test.ts \
  src/__tests__/integration/accountingXeroColumns.integration.test.ts
pnpm test-stack down
```

## 2. W02 checklist — connection

Record PASS / FAIL and the visible Breeze state after each step. "Connected
apps" means Xero → Settings → Connected apps for that organisation.

> **2026-09-28:** Xero's consent screen now offers a **single-select** organisation dropdown, so one consent links one organisation. Rows that tick two organisations in one consent (X2, X3, X4, X6, X67, X68) can no longer be driven from the UI; the tenant picker remains the defensive path for a `/connections` response with more than one link. Run them only if Xero restores multi-select, or reach the picker by forging a second link another way.


| # | Step | Expected |
|---|---|---|
| X1 | P1: Integrations → Accounting → **Connect to Xero**; tick **only** Demo Company | Returns connected; card shows Demo Company + **Demo company** badge; Connected apps lists the Breeze app once |
| X2 | P1 disconnect; connect again ticking Demo Company **and** T2 | Picker lists both; choose Demo Company → connected; **T2 no longer lists the Breeze app** (unchosen link removed) |
| X3 | P1 disconnect; connect ticking both; on the picker press **Cancel connection** | Card returns to "Connect"; neither organisation lists the Breeze app |
| X4 | Connect ticking both, leave the picker; in psql `update accounting_connections set updated_at = now() - interval '2 hours' where status='pending_tenant'`; wait for the 15-min sweep (or trigger `sweep`) | Row gone; both links removed in Xero; QuickBooks card is clickable again |
| X5 | P1 connected to Demo Company. P2 (as U1) connects ticking Demo Company only | Redirect shows "This Xero organisation is connected to another Breeze account"; **P1 still connected and syncing**; Demo Company still lists the Breeze app |
| X6 | P1 and P2 open the picker in two browsers for the same organisation and click Connect within ~1 s | Exactly one connects; the other gets the tenant-held message and stays on the picker |
| X7 | During X1, decode the access token (dev-only: set a breakpoint or temporary log in a local branch, never commit) | Token payload carries `authentication_event_id`; `/connections?authEventId=` returns only this flow's links — **settles open item 4 (merge blocker)** |
| X8 | P1 connected. Force reauth (`update accounting_connections set status='reauth_required' where partner_id=…`); click **Reconnect Xero**, tick Demo Company | Reconnects to the **same** organisation with no picker, mappings intact (no `realm_changed` audit). Record whether the filtered `/connections` list was empty (expected: yes — the link keeps its first authEventId) — **settles refinement 2** |
| X9 | Set `access_token_expires_at = now()` and trigger two concurrent refreshes (two Sync-style calls, or two `settings/refresh` requests) | Both succeed, status stays connected, exactly one refresh token persisted; record whether Xero's second refresh with the old token returned tokens (grace) or `invalid_grant` — **settles refinement 14** |
| X10 | P1 and P2 both connected via the SAME Xero user U1 (to different orgs). P1 disconnects | P1's organisation drops the Breeze app; **P2 stays connected** and its next refresh succeeds (proves no revocation) |
| X11 | Settings step: pick revenue account, taxable rate, exempt rate, bank account; Save; reload | Values persist; lists show only ACTIVE revenue accounts, revenue-capable tax rates, BANK accounts |
| X12 | Xero-side: in Connected apps, disconnect Breeze manually; in Breeze click Refresh settings | A clear error (not a 500); after token expiry the card shows **Reconnect Xero** |
| X13 | Load the settings step 3× and check Redis `acct-rl:xero:day-remaining:<connectionId>` | Present and decreasing (X-DayLimit-Remaining recorded) |
| X14 | On the consent screen, read the requested permissions | Contacts, invoices (incl. items), payments, settings (read) + offline access; **no "transactions" broad scope** — **settles open item 3 (merge blocker)** |
| X15 | Certification UI pass against Xero's current app-partner checklist: branded **Connect to Xero** button, org name shown when connected, **Disconnect** with confirmation, clear error on consent cancel (press Cancel on Xero's consent screen → "You cancelled the Xero sign-in"), no dead ends | All pass; screenshot each |
| X67 | Picker deadline: connect ticking two organisations; the picker shows "Choose an organisation before <time>" ≈ 29 minutes after the redirect; leave it past that time | The picker switches to the expired message with only **Cancel connection** |
| X68 | With the row in `reauth_required`, the Xero panel shows "Reconnecting keeps your current Xero organisation. Any other organisation you tick on the Xero screen is released." Reconnect ticking the current org plus T2 | Still connected to the current org; T2 no longer lists the Breeze app |
| X69 | After X11 values are saved, disconnect, connect to T2 | Settings step shows the "Choose the defaults…" notice and all four pickers are "Not set" |
| X70 | QuickBooks regression: QuickBooks panel (sandbox) looks and behaves exactly as before | No settings step, no confirmation on disconnect, push/pull/owed controls present |

### Evidence header (fill in per run)

| Field | Value |
|---|---|
| Date | 2026-09-28 |
| Breeze build SHA | feature/7167-xero/wave-7172-c-web on main 4bc6093a44 (+ #7387 scope change) |
| Tester | Todd + Claude (Xero calls made as the stack's connection; writes guarded to demo organisations) |
| Xero app (client id prefix) | Web app "Breeze Lab local (7167)", created 2026-09-28 (granular scopes only) |
| Organisations used | Demo Company (US); OliveTech LLC connected once for X7 and disconnected, no data touched |

### Results

| # | Result | Notes |
|---|---|---|
| X1 | PASS | Demo Company (US) connected; card shows org name + Demo company badge; Xero Connection management lists one tenant. |
| X2 | | |
| X3 | | |
| X4 | | |
| X5 | | |
| X6 | | |
| X7 | PASS | Callback 302 → status connected with tenant + access + refresh token; the callback fails closed with auth_event_missing without the claim. |
| X8 | | |
| X9 | | |
| X10 | | |
| X11 | PASS | 400 · Sales / Tax on Sales (9.25%) / Tax Exempt (0%) / Checking Account saved and survive reload. Note: taxable pickers also list purchase-side rates (Tax on Purchases, BOE Use Tax). |
| X12 | | |
| X13 | | |
| X14 | PASS | Consent: View and manage Contacts, Invoices and related documents, Payments; View Organisation settings (after #7387: View and manage Organisation settings). No transactions scope. Refresh token stored (offline_access). |
| X15 | | |
| X67 | | |
| X68 | | |
| X69 | PASS | First connect shows the "Choose the defaults…" notice with all four pickers Not set. |
| X70 | | |

## 3. W03 checklist — contacts, items, import

Run on a `worktree-stack` of the W03b branch **with Task 10's capability flip applied locally** (the flip is committed only after X16 passes). Connected to the Demo Company (section 2 done). Record each result in the table below the checklist.

| # | Step | Expected |
|---|---|---|
| X16 | Items → a catalog item with an income account set → **Create new** | An item appears in Xero → Products and services. **If the sync fails with "did not grant Breeze access", STOP: the pinned scopes cannot write Items (refinement 1). Do not merge W03b; escalate.** The flip is the separate last commit on the W03b branch; if X16 fails, drop that commit (W03b then ships web + server fixes with Xero still connect-only) and escalate the scope choice (`accounting.settings` vs contacts-only). |
| X17 | Customers → an org → **Create new**; then in Xero open the new contact | "Contact Code" shows `breeze:<orgId>`. Time `GET Contacts?where=ContactNumber=="breeze:<orgId>"&includeArchived=true` in the API log: under 2 s |
| X18 | Create a Xero contact named exactly like a second, unmapped org; **Create new** for that org | Row shows "Xero already has a customer named …"; the row search is prefilled and the contact preselected; **Confirm match** links it. Copy the raw Xero message into Results |
| X19 | In Xero, set another contact's Contact Code to `breeze:<orgId of a third org>` via the API (Postman), then **Create new** for that org | No second contact is created; the existing one is adopted and updated. Record the raw duplicate-ContactNumber message if Xero returned one |
| X20 | Create a Xero item with Code = a catalog item's SKU (same name, too); **Create new** for that catalog item | A new item with code `<sku-slug>-<10 hex>` is created; the MSP's item is untouched (it is offered as an exact-SKU suggestion instead). Rename the catalog item and **Sync now** after unlinking and choosing **Create new** again: the same Xero item is adopted, not duplicated. Record Xero's duplicate-code message text if you can provoke one (Postman `PUT` of an existing Code) |
| X21 | Archive the contact created in X17 in Xero; **Sync now** on the (still linked) org; then unlink it and **Create new** again | Both refused: "…is archived — restore it in Xero, then sync again". Record whether `POST {ContactStatus:'ACTIVE'}` via Postman un-archives it, and whether Xero accepts an update to an archived contact at all |
| X22 | Edit a linked item's price in Breeze → **Sync now**; repeat for (a) an MSP-created item that has a purchase side (PurchaseDetails with a cost/account) and (b) a tracked-inventory item linked via Confirm match | Price changes; Code unchanged; (a) the item's purchase details are unchanged after the sync (`POST Items/{id}` without PurchaseDetails keeps the purchase side); (b) Xero accepts the update for a tracked-inventory item, or record the exact refusal text. Record whether a POST without `Code` would be accepted (Postman) |
| X23 | Replay the same `PUT /Contacts` body twice within 60 s with the same `Idempotency-Key` (Postman, copying Breeze's key from the API log); then confirm an update `POST` from Breeze carries no `Idempotency-Key` header | One contact; the second response is a replay; updates are unkeyed. If you can provoke a Xero 5xx, record whether a same-key retry replays it (refinement 9's known limitation) |
| X24 | Mapping row search: type 2 characters of a contact's name | The contact is offered (`searchTerm`) |
| X25 | Import tab → Load | Customers and never-invoiced contacts listed; a supplier-only contact (one bill, no invoices) is hidden behind "Show all contacts (1 supplier-only hidden)"; an archived contact shows the Archived badge |
| X26 | Import one contact | An org + site exist; the org's external link reads `system = xero`; the mapping workbench shows the org as linked on the next load |
| X27 | Set `acct-rl:xero:day-remaining:<connectionId>` in Redis to 10% of `XERO_DAILY_CALL_LIMIT`, then Import → Load | 429 toast: "…daily API allowance … nearly used up…"; clear the key afterwards |
| X28 | Xero connection with the income account set in the settings step | The workbench shows no income-account picker; **Create new** on items is enabled |
| X29 | A contact with an address whose country is written out ("United Kingdom") and a phone with area code | Sync succeeds; Breeze shows the phone as `<country> <area> <number>` |
| X30 | `UpdatedDateUTC` after a sync | The mapping row's remote version is an ISO timestamp (psql: `select remote_sync_token from accounting_entity_mappings where remote_entity_id = '<ContactID>'`) |
| X31 | Delete a linked item in Xero (unused on invoices), then **Sync now** on its catalog item | Refused, terminal: "…no longer exists — unlink it and map it again"; no new item is created |
| X65 | Connect to a Demo Company whose base currency differs from an org's currency (or set an org's currency to a different one), then **Create new** for that org; also for a catalog item | Refused with `currency_mismatch`. Review the copy for contacts: it says Xero fixes a record's currency when it is created and never lets it change — accurate for items (base-currency only); for contacts confirm against Xero's behaviour (a contact's default currency can be set) and record whether the wording should change (W03a ruling P6) |
| X66 | Items tab: a Xero item that is purchase-only (IsSold off) with a SKU matching a catalog item | It is offered as a normal candidate/suggestion with no Archived badge (Xero items have no archived state); **Confirm match** then **Sync now** makes it sellable and keeps its purchase details |

### W03 Results

| # | Result | Notes / raw Xero text |
|---|---|---|
| X16 | PASS (after #7387) | Under accounting.settings.read: Xero item create 401 insufficient_scope → terminal provider_permission. Under accounting.settings: item created, mapping synced. |
| X17 | PASS | Contact created; Contact details → Contact code breeze:<orgId>. |
| X18 | | |
| X19 | | |
| X20 | | |
| X21 | | |
| X22 | | |
| X23 | | |
| X24 | | |
| X25 | | |
| X26 | | |
| X27 | | |
| X28 | PASS | Income account set in the settings step → no per-row income-account picker; Create new enabled. |
| X29 | | |
| X30 | PASS | remote_sync_token is an ISO UpdatedDateUTC for contact and item mappings. |
| X31 | | |
| X65 | | |
| X66 | | |

## 4. W04 checklist — invoice push and void

Run on a `worktree-stack` of the W04b branch **with Task 10's capability flip applied locally** (it is committed only after X32, X34/X35 and X38 pass). Connected to the Demo Company, with sections 2–3 done: the settings step has a revenue account, a taxable tax rate (e.g. 20% VAT on Income) and an exempt one (e.g. No VAT), and at least one org and one catalog item are mapped. Record each result, with Xero's raw text where asked, in the table below.

| # | Step | Expected |
|---|---|---|
| X32 | Issue a Breeze invoice (2 lines: one taxable 100.00, one non-taxable 50.00; 20% tax) with **Push mode = manual**, then **Push to Xero** | One AUTHORISED sales invoice in Xero: same number, contact, dates, currency; lines on the chosen revenue account; tax types VAT / No VAT; **Subtotal 150.00, Tax 20.00, Total 170.00**. Card: "Synced". **GATE** — if this fails, stop and record the raw response |
| X33 | Push mode = auto; issue another invoice, then record a 50.00 payment on it | Invoice appears in Xero without a click. **No** payment appears in Xero, and the payment row shows **no** sync badge (paymentPush is off until W05) |
| X34 | An invoice whose tax does not split evenly: three taxable lines of 1.00, tax 0.10 at a 3.333% rate typed into the invoice. Also a near-cancelling pair: two taxed lines +100.00 and −99.99 (a credit line) at a rate that leaves tax 0.01 (e.g. 50%); Breeze allocates line tax 100.00 / −99.99, far from Xero's own per-line figure. If Breeze cannot enter a negative line, send the same two lines and TaxAmounts from Postman. | Xero shows line tax 0.04 / 0.03 / 0.03 and Tax 0.10; no "tax adjusted" warning blocks approval. **GATE** (open item 1). Record whether Xero shows a "tax adjusted" note. The pair: record whether Xero accepts the opposite-sign shares and totals Tax 0.01; a refusal is handled like X35's. |
| X35 | A taxable line of **10 × 0.50** (line total 5.00) at 20% → line tax 1.00, which exceeds the unit price | Accepted with TaxAmount 1.00. **GATE**. If Xero refuses ("TaxAmount specified cannot be greater than the UnitAmount"), set `XERO_SEND_LINE_TAX_AMOUNT = false`, re-run X32–X35, and record the drift result instead. X34's near-cancelling pair is judged under this gate too. |
| X36 | A line of **1.50 h × 10.95** (Breeze total 16.43). Add a line with **quantity 0** (price 25.00, total 0.00). | Xero shows quantity 1, unit 16.43, description ending "(1.50 × 10.95)"; totals equal Breeze. Separately in Postman, `PUT` a DRAFT with Quantity 1.5 × UnitAmount 10.95 and record Xero's LineAmount (16.42 or 16.43 → its rounding mode). The quantity-0 line is sent as `Quantity: 0`; record whether Xero accepts it and the raw text if not (a refusal would block every invoice with a zero-quantity line). |
| X37 | API log of X32's push | The first call is `GET Invoices?where=Reference=="breeze:<id>"` and returns 200 (record the time taken). If Xero rejects `==`, record the error and try the documented single `=` |
| X38 | Create a Xero invoice by hand numbered like the next Breeze invoice (e.g. INV-2026-0042); then issue and push that Breeze invoice. First, in Postman: create a DRAFT with Reference `breeze:lagtest-<n>`, then immediately `GET Invoices?where=Reference=="breeze:lagtest-<n>"`; repeat 5×. | Pushed **without** the number; Xero assigns its own (e.g. INV-0012); the card shows "Xero document INV-0012". **GATE**. Record the raw duplicate-number message. The Reference search finds the new invoice on the first GET every time (record any lag). If the search lags a create, a lost create can be missed by the lookup and the numberless retry can mint a second invoice; the next push then shows `remote_ambiguous` — record the lag as a gate failure. |
| X39 | In Xero, apply a payment to X32's invoice; then **Void** it in Breeze | Card: "Xero will not void this invoice because a payment is applied to it there — remove or unapply that payment in Xero, then void the invoice again"; no retries in the worker log. Then, in Postman, `POST {Status:'VOIDED'}` on that invoice and record Xero's raw message |
| X40 | Void an unpaid pushed invoice in Breeze; then void it again (re-enqueue from the worker or repeat the void). Then: create a DRAFT in Postman, point a pushed Breeze invoice's mapping at it (`update accounting_entity_mappings set remote_entity_id = '<DraftInvoiceID>' where …`), and void that Breeze invoice | Xero: VOIDED; the second void makes no write (API log: one GET). The DRAFT ends **DELETED**, not VOIDED (Xero cannot void a draft) |
| X41 | Postman: `POST /Invoices` (collection URL, no id) with an existing InvoiceNumber and different lines, on a throwaway DRAFT | Record whether Xero edits that invoice (refinement 1). Breeze never does this — it creates with PUT and updates by InvoiceID |
| X42 | Postman: create an AUTHORISED invoice with Reference `breeze:<id>` for a Breeze invoice that has not been pushed, matching its totals; then push it from Breeze. Then: with Breeze's mapping row set back to `error` and `remote_entity_id` null (psql), void that Breeze invoice | No second invoice: API log shows the lookup GET and a POST resend, no PUT; card "Synced". The void finds the invoice by Reference and voids it; the mapping now holds its InvoiceID (refinement 22) |
| X43 | A tax-exempt organisation's invoice (tax 0.00, lines flagged taxable) | Every line on the exempt tax type; Tax 0.00 |
| X44 | Postman: `PUT /Invoices` of an invalid invoice (bad AccountCode) **without** `summarizeErrors` | Record the status code (200 with HasErrors, or 400) — the real default (refinement 13) |
| X45 | Clear the exempt tax rate in the settings step; push an invoice with a non-taxable line | Card: "Choose a tax rate for non-taxable lines in Integrations → Accounting → Xero, then push again"; API log: **no** Xero call for this push |
| X46 | Open X32's invoice as the customer-facing PDF (Print → PDF) and as the online invoice link a customer receives (default branding theme) | Record whether "breeze:<id>" is visible to the customer on either (refinement 11). Visible = note it for the spec owner; not a gate |

### W04 Results

| # | Result | Notes / raw Xero text |
|---|---|---|
| X32 | PASS | AUTHORISED ACCREC INV-2026-0001, same contact/dates/USD, account 400, TaxType OUTPUT / NONE, SubTotal 150.00, Tax 20.00, Total 170.00, Reference breeze:<id>. |
| X33 | | |
| X34 | PASS | 3 × 1.00 at 3.333% → line tax 0.04 / 0.03 / 0.03, Tax 0.10, no warning. Pair +100.00 / −99.99 with TaxAmount 100.00 / −99.99 (Breeze allocator output) accepted and AUTHORISED, Tax 0.01. |
| X35 | PASS | 10 × 0.50 at 20% → TaxAmount 1.00 accepted; Tax 1.00, Total 6.00. |
| X36 | | |
| X37 | | |
| X38 | PASS | Hand-made INV-2026-0004 → Breeze push retried numberless → Xero INV-0042 recorded. Raw: "Invoice # must be unique." Reference search found the new invoice on the first GET 5/5 (266–824 ms). |
| X39 | | |
| X40 | | |
| X41 | | |
| X42 | | |
| X43 | | |
| X44 | | |
| X45 | | |
| X46 | | |

## 5. W05 checklist — payments

Run on a `worktree-stack` of the W05c branch **with Task 12's capability flip applied locally**; it is committed only after X47, X50, X51, X52 and X58 pass. Set up first:

- The stack must be reachable from the internet over HTTPS on 443, because Xero delivers webhooks. Use a Cloudflare tunnel or the lab host.
- `XERO_WEBHOOK_KEY` must be set.
- Sections 2–4 must be done: the Demo Company is connected, the settings step has a bank account, and an org and an item are mapped.
- Push mode is **auto**: bulk push is a no-op in manual mode until #7251 lands.

Record each result, with Xero's raw text where asked.

| # | Step | Expected |
|---|---|---|
| X47 | Xero app → Webhooks: subscribe to **Invoices**, delivery URL `https://<host>/api/v1/webhooks/xero`, key into `XERO_WEBHOOK_KEY`; press **Send "Intent to receive"** | Xero reports the endpoint OK. **GATE** |
| X48 | `curl -si -X POST https://<host>/api/v1/webhooks/xero -H 'x-xero-signature: AAAA' -d '{"events":[]}'`; then look at Xero's delivery log for X47 | `401`, empty body, **no `Set-Cookie` header**; Xero's log shows a response well under 5 s |
| X49 | Before the flip (W05a/b deployed, capability off): edit a pushed invoice's due date in Xero | Webhook answers 200; API log `[xeroWebhook] processed webhook delivery` with `dropped: 1`; no reconcile run |
| X50 | After the flip: issue + push an invoice from Breeze, then **apply a 50.00 payment to it in Xero** | The payment appears on the Breeze invoice (method "Other", reference as typed in Xero). Record **whether an INVOICE webhook fired for the payment** (API log `categories.INVOICE ≥ 1`, `enqueued: 1`, run ~30 s later) or the payment arrived only with the 15-minute sweep. **GATE** (either path must deliver it; refinement 3) |
| X51 | Delete X50's payment in Xero; press **Sync now** (or wait) | The Breeze payment is reversed and the balance restored. In Postman, `GET Payments` with `If-Modified-Since` a minute before the deletion returns that payment with `Status: DELETED`. **GATE** (refinement 11) |
| X52 | Record a cash payment of 25.00 in Breeze with reference `CHQ 1001` on a pushed invoice | One Xero payment on the chosen bank account, dated as in Breeze, amount 25.00, Reference `Breeze payment <uuid> \| CHQ 1001`; Breeze payment badge "Synced". **GATE** |
| X53 | Reverse (void) X52's payment in Breeze | The Xero payment is DELETED; API log shows `GET Payments/<id>` then `POST Payments/<id>`; mapping gone |
| X54 | Push another payment; then in psql set its mapping back to `pending_op='push', remote_entity_id=null, sync_status='pending'` and wait for the sweep | The mapping is re-adopted with the **same** PaymentID; API log shows the lookup GET and **no** `PUT Payments`; Xero still has one payment |
| X55 | Reconcile a Breeze-pushed payment in the Demo Company's bank reconciliation; then reverse it in Breeze | Payment row: "Xero will not delete this payment because it is reconciled to a bank transaction — unreconcile it in Xero and delete it there"; no retries in the worker log. In Postman, `POST Payments/<id> {"Status":"DELETED"}` and record Xero's raw message (refinement 16). Then unreconcile + delete in Xero → next pull clears the mapping |
| X56 | Turn **pull** off; record a full payment on a pushed invoice **in Xero**; then record the same amount in Breeze | Breeze payment row: "Xero refused the payment because it is more than the amount still due…"; record Xero's raw message |
| X57 | Delete all payments on a pushed invoice in Xero, then **Void** it in Xero | The Breeze invoice's sync card shows "Deleted in Xero" after the next pull |
| X58 | Postman: `PUT Payments` with a Reference of 118 characters (`Breeze payment <uuid> \| ` + 64 × `R`), then 255, then 300 | The 118-character Reference **round-trips unchanged** (`GET Payments/<id>`). **GATE** (refinement 14). Record whether 255/300 are accepted, truncated or refused |
| X59 | Postman: `GET Payments` with `If-Modified-Since` one hour in the future | Record `200` with an empty list, or `304` (refinement 9) |
| X60 | Postman: `GET Payments?where=PaymentType=="ACCRECPAYMENT"` and `?where=Invoice.InvoiceID==guid("<id>")` | Both `200`. If `==` is refused, record the error and retry with the documented single `=` |
| X61 | Clear the bank account in the settings step with payment push on; then record a Breeze payment | The settings step shows "Payments recorded in Breeze are not sent to Xero until you choose a bank account."; the payment row shows "Choose a bank account…"; the API log shows **no** Xero call. Choose the account again → the next sweep (≤ 15 min) pushes it. Also, in Postman, `PUT` a payment to a non-BANK account and record Xero's message |
| X62 | Note `X-DayLimit-Remaining` before and after one **Sync now** with nothing changed; then make five quick edits to pushed invoices in Xero within 30 s | One run costs 2 calls; the five events produce **one** reconcile run (one `[AccountingReconcileWorker]` run line) |
| X63 | Postman: send the same `PUT Payments` body with the same `Idempotency-Key` twice within 6 minutes; then the same key with a different Amount | One payment; the second body gets `400 … is used with a different request.` |
| X64 | Allocate a credit note to a pushed invoice in Xero | Breeze's invoice balance does **not** change (documented v1 limitation, spec "Scope boundaries"); a later Breeze payment for the full amount shows the X56 message |

### Also record (carry-overs from W05a/W05b)

- X50: confirm the tenant-id casing Xero sends in the webhook `tenantId` matches the casing stored at connect (the connection is found by `hmacFingerprint(tenantId)` of the raw string; a case mismatch means the webhook routes nothing and only the sweep delivers). Record both strings.
- X47/X62: record the webhook response time from Xero's delivery log. The route fingerprints and routes up to 50 tenants sequentially inside Xero's 5-second budget; note the timing (a single-tenant delivery is expected; flag anything above ~1 s).
- X55/X56: the refusal-classification regexes in `xeroHttp.ts` (reconciled-delete → `remote_locked`, amount over due → `amount_exceeds_due`) are unconfirmed until these rows record Xero's raw text. If a message does not match, the error falls back to the loud, retryable path — record the raw text for a fix.
- A delete refused for missing scope stays parked and is re-read once per 15-minute sweep until the partner reconnects. If you can reproduce it (connect with a scope removed), record `X-DayLimit-Remaining` across two sweeps to measure the per-sweep call cost.
- #7300: Xero's refusal to delete a payment that is a member of a batch payment is not yet classified. If the Demo Company allows creating a batch payment, void a Breeze payment whose Xero payment is in a batch and record Xero's raw message. #7300 is merged (#7303), so the refusal is now classified; record the raw message anyway.

### W05 Results

| # | Result | Notes / raw Xero text |
|---|---|---|
| X47 | PASS | Intent to receive → Status OK; valid probe 200, invalid probes 401, 13–84 ms. |
| X48 | PASS | 401, no Set-Cookie. |
| X49 | | |
| X50 | PASS (webhook) | INVOICE webhook fired for the payment (categories.INVOICE 1, matched 1, enqueued 1) → run trigger=webhook applied=1; Breeze payment 50.00, method other, reference as typed; ~45 s. Tenant-id casing matched. |
| X51 | PASS | Delete in Xero → run trigger=webhook reversed=1. GET Payments If-Modified-Since returned the payment with Status DELETED. |
| X52 | PASS | Breeze cash 25.00 ref CHQ 1001 → Xero AUTHORISED 25.00 on Checking Account, dated as in Breeze, Reference "Breeze payment <uuid> \| CHQ 1001"; ~5 s. |
| X53 | | |
| X54 | | |
| X55 | | |
| X56 | | |
| X57 | | |
| X58 | PASS | 118-char Reference round-trips unchanged; 255 and 300 also accepted and returned unchanged. |
| X59 | | |
| X60 | | |
| X61 | | |
| X62 | | |
| X63 | | |
| X64 | | |

**If X51 fails** (a deleted payment never comes back from `If-Modified-Since`): stop, do not flip, and escalate. The pull would then need an invoice-level allocation diff (the invoice's `Payments[]` against Breeze's mappings), which is a plan change. **If X58 fails** (Xero alters the 118-character Reference): lower `XERO_PAYMENT_REF_MAX` until the round-trip holds, and re-run X52 and X54.

The capability flip commit is held until X47, X50, X51, X52 and X58 pass (#7300 is merged).

## Change log

- W02 — initial checklist (X1–X19); X14 and X7 block the W02c merge.
- W03 — contacts, items and import (X16–X31, plus X65–X66, numbered after W05 to avoid colliding with W04 X32–X46 and W05 X47–X64); X16 gates the mapping capability flip.
- W04 — invoice push and void (X32–X46); X32, X34/X35 and X38 gate the invoicePush capability flip.
- W05 — payments (X47–X64); X47, X50, X51, X52 and X58 (and #7300) gate the paymentPull/paymentPush flip.
- 2026-09-28 — W02 rows X16–X19 renumbered X67–X70 (W03 owns X16–X31); first full lab run recorded; all flip gates pass (X16 after #7387).
