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
  accounting.payments accounting.settings.read` were taken from Xero's own
  repositories, not confirmed on the developer portal; a wrong string fails
  every connect at the consent screen.
- **X7 — `authentication_event_id` claim present. BLOCKS MERGE** unless a
  Xero-portal/token check was already recorded for W02a Task 4 Step 1 (it was
  not recorded as of this writing). The callback fails closed with
  `error=auth_event_missing` without it, so a wrong assumption breaks every
  Xero connect.

No environment may set `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` /
`XERO_REDIRECT_URI` until these pass.

- **W03b (wave #7170): do not merge until X14 + X7 (W02c) and **X16** (section
  3) pass — X16 gates the mapping/customerImport capability flip.**

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
| X16 | Picker deadline: connect ticking two organisations; the picker shows "Choose an organisation before <time>" ≈ 29 minutes after the redirect; leave it past that time | The picker switches to the expired message with only **Cancel connection** |
| X17 | With the row in `reauth_required`, the Xero panel shows "Reconnecting keeps your current Xero organisation. Any other organisation you tick on the Xero screen is released." Reconnect ticking the current org plus T2 | Still connected to the current org; T2 no longer lists the Breeze app |
| X18 | After X11 values are saved, disconnect, connect to T2 | Settings step shows the "Choose the defaults…" notice and all four pickers are "Not set" |
| X19 | QuickBooks regression: QuickBooks panel (sandbox) looks and behaves exactly as before | No settings step, no confirmation on disconnect, push/pull/owed controls present |

### Evidence header (fill in per run)

| Field | Value |
|---|---|
| Date | |
| Breeze build SHA | |
| Tester | |
| Xero app (client id prefix) | |
| Organisations used | |

### Results

| # | Result | Notes |
|---|---|---|
| X1 | | |
| X2 | | |
| X3 | | |
| X4 | | |
| X5 | | |
| X6 | | |
| X7 | | |
| X8 | | |
| X9 | | |
| X10 | | |
| X11 | | |
| X12 | | |
| X13 | | |
| X14 | | |
| X15 | | |
| X16 | | |
| X17 | | |
| X18 | | |
| X19 | | |

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
| X32 | Connect to a Demo Company whose base currency differs from an org's currency (or set an org's currency to a different one), then **Create new** for that org; also for a catalog item | Refused with `currency_mismatch`. Review the copy for contacts: it says Xero fixes a record's currency when it is created and never lets it change — accurate for items (base-currency only); for contacts confirm against Xero's behaviour (a contact's default currency can be set) and record whether the wording should change (W03a ruling P6) |
| X33 | Items tab: a Xero item that is purchase-only (IsSold off) with a SKU matching a catalog item | It is offered as a normal candidate/suggestion with no Archived badge (Xero items have no archived state); **Confirm match** then **Sync now** makes it sellable and keeps its purchase details |

### W03 Results

| # | Result | Notes / raw Xero text |
|---|---|---|
| X16 | | |
| X17 | | |
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
| X28 | | |
| X29 | | |
| X30 | | |
| X31 | | |
| X32 | | |
| X33 | | |

## Change log

- W02 — initial checklist (X1–X19); X14 and X7 block the W02c merge.
- W03 — contacts, items and import (X16–X33); X16 gates the mapping capability flip.
