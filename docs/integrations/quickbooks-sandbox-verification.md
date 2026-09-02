# QuickBooks Entity-Mapping Sandbox Verification

Phase B (docs/superpowers/plans/2026-08-29-quickbooks-customer-item-mapping.md,
Task 7) exit criteria require both an automated gate and a manual Intuit
sandbox walkthrough. This document is the reusable checklist for both, plus
the evidence record from the most recent run of each.

This is a **living document**: re-run the sandbox walkthrough (Section 2)
before every release that touches QuickBooks mapping/sync code, and append a
new evidence block rather than overwriting the previous one.

---

## 1. Automated gate

Evidence from the run below is real and was captured in this session. See
"Deviations from the brief's literal commands" at the end of this section —
two commands differ from the plan doc's shorthand because the actual repo
config file names split differently; the commands here are what a developer
should actually run.

| Field | Value |
|---|---|
| Date | 2026-09-01 |
| Breeze build SHA | `20a5d14494b7e9e45792982b7e6bc12ba83956d0` (branch `feat/quickbooks-accounting-mappings`) |
| Tester | Final-review fix wave (automated) |
| Environment | Local worktree, ephemeral `pnpm test-stack` Postgres 16 (pgvector) + Redis 7 containers |

The gate was re-run in full against that SHA, which is the head of the
branch's code changes; only this document changed afterwards. See the
[change log](#change-log) for what moved between runs.

### a. API unit/service/route tests

```bash
cd apps/api && npx vitest run src/services/accounting/ src/routes/accounting/ \
  src/middleware/selfManagedDbContextRoutes.test.ts src/db/autoMigrate.test.ts
```

**Result: PASS** — 13 test files, 456 tests, 0 failures.

### b. Web component/i18n/mutation-safety tests

```bash
cd apps/web && npx vitest run \
  src/components/integrations/QuickbooksMappingWorkbench.test.tsx \
  src/components/integrations/QuickbooksCustomerImport.test.tsx \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/__tests__/no-silent-mutations.test.ts
```

**Result: PASS** — 5 test files, 234 tests, 0 failures.

### c. Typechecks

```bash
cd apps/api && NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit -p .
```

**Result: FAIL (1 error) — the known pre-existing one only.**

1. `src/jobs/scheduleRegistry.contract.test.ts(33,20): error TS2307: Cannot
   find module 'cron-parser'` — **pre-existing, unrelated to this branch**
   (missing dependency in the workspace's `node_modules`; not caused by
   accounting-mapping work). Expected per this task's brief.

The second error this section recorded on the previous run —
`src/routes/accounting/index.ts(174,28): error TS2345: Argument of type
'"json"' is not assignable to parameter of type 'never'`, inside
`requireMappingWrite` — was a real production-code compile error introduced
by Task 5 and left unfixed by the Task 7 verification pass (whose contract
was test/doc-only). It has since been fixed on this branch by `e69c9cf01
fix(accounting): type requireMappingWrite against validated mapping input`,
which types the handler against the validated mapping input instead of
declaring it a bare `MiddlewareHandler` (which erased the
`zValidator('json', mappingDecisionSchema)` typing and resolved
`c.req.valid`'s parameter type to `never`). It is gone as of the SHA above.

```bash
cd apps/web && NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit -p .
```

**Result: PASS** — 0 errors.

### d. Integration / RLS suites (real Postgres)

Stack: `pnpm test-stack up` (not the top-level `docker-compose.yml postgres
redis` — see deviation note below), which brought up an ephemeral,
worktree-scoped `pgvector/pgvector:pg16` + `redis:7-alpine` pair via
`docker-compose.test.yml`, both reported healthy. `.env.test` was generated
with:

```
DATABASE_URL=postgresql://breeze_test:breeze_test@localhost:<ephemeral>/breeze_test
DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:<ephemeral>/breeze_test
```

Migrations applied cleanly via `pnpm db:migrate` (613 migration files, no
drift, bootstrap seed completed).

```bash
cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts
```

**Result: PASS** — 1 test file (`rls-coverage.integration.test.ts`), 75
tests, 0 failures.

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts
```

**Result: PASS** — 1 test file, 4 tests, 0 failures. Exercises RLS +
the polymorphic `breeze_entity_id` ownership trigger through the real
unprivileged `breeze_app` pool.

Added for the final-review fix wave — the org-lifecycle contract suites,
because `accounting_entity_mappings` is now cleared by org erasure and by
org merge (see the change log):

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenantCascadeExecution.integration.test.ts \
  src/__tests__/integration/tenantCascadePartner.integration.test.ts \
  src/__tests__/integration/tenantCascadeSso.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts \
  src/__tests__/integration/orgMerge.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts
```

**Result: PASS** — 10 test files, 57 tests, 0 failures. Both new
assertions were confirmed RED first (the two production hunks stashed:
`expected undefined to be 1` for the erasure pre-clear, `expected +0 to be
1` for the merge fixup) before the fixes were restored.

```bash
pnpm db:check-drift
```

**Result: PASS** — "No drift detected — all 613 migration files match the
breeze_migrations ledger."

Stack torn down afterward with `pnpm test-stack down`.

### e. Whitespace/diff hygiene

```bash
git diff --check
```

**Result: PASS** — exit 0, no output (working tree was clean at task start;
no whitespace errors introduced).

### Deviations from the brief's literal commands

The Task 7 brief's Step 4 sketch (and the plan doc's Step 2) give two RLS
commands as:

```bash
pnpm --filter @breeze/api exec vitest run --config vitest.config.rls.ts \
  src/__tests__/integration/accounting-entity-mappings-rls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
```

This does not match the repo as it actually exists:

- `vitest.config.rls.ts` has a fixed `include` of exactly
  `rls.integration.test.ts` and
  `auth-browser-transition-rls.integration.test.ts` — it is the DB
  session-context contract test, not the general RLS-coverage or per-table
  RLS suite.
- `rls-coverage.integration.test.ts` (pg_catalog policy-inventory contract)
  has its own dedicated, read-only config: `vitest.config.rls-coverage.ts`
  (`pnpm test:rls-coverage`). It is deliberately kept off
  `vitest.integration.config.ts`'s `setupFiles` (which TRUNCATEs tenant
  tables per test) because it must never see that hazard.
- `accounting-entity-mappings-rls.integration.test.ts` imports `./setup`
  (the truncate-based integration fixture), so it belongs under the general
  `vitest.integration.config.ts` (`pnpm test:integration`), which globs all
  of `src/__tests__/integration/**/*.test.ts`.

The commands actually run (Section d above) are the correct equivalents. Also
used `pnpm test-stack up`/`down` (`scripts/dev/test-stack/`) instead of the
raw top-level `docker compose up -d postgres redis`, since the top-level
`docker-compose.yml` requires a populated `.env` (Postgres/Redis passwords,
digest-pinned image refs, a `secrets/redis_password` file) that does not
exist in this worktree, whereas `test-stack` is the repo's purpose-built,
per-worktree-isolated mechanism for exactly this (`docker-compose.test.yml`)
and needed no extra setup.

### Concerns raised, not fixed (production code, out of this task's scope)

**RESOLVED as of `20a5d1449` — kept for the record.** The concern below was
raised by the Task 7 verification pass, whose contract was test/doc-only. It
was fixed on this branch by `e69c9cf01`; item (c) above now records a single
pre-existing `tsc` error.

- **`apps/api/src/routes/accounting/index.ts:174`** — `requireMappingWrite`
  fails `tsc --noEmit`. See item (c) above for the exact error and root
  cause. Recommended fix (for whoever picks this up, not applied here): type
  the handler against the specific validated env, e.g. define it as
  `createMiddleware<{ Variables: ... }>()` with the `json`-validated schema
  in scope, or move the `breezeEntityType` narrowing to read from
  `c.req.json()`/a pre-parsed variable instead of re-deriving it through
  `c.req.valid` inside a loosely-typed middleware. This does not fail at
  runtime and none of the automated tests in (a)/(b)/(d) caught it — it is a
  `tsc`-only gap, which is exactly why Phase B's exit criteria list
  typechecks as a separate gate item from the test suites.

---

## 2. Sandbox walkthrough checklist

**Status: EXECUTED 2026-09-01 against a live Intuit sandbox company (results inline below; items 12 and 16 need a second realm) — originally: to be executed against a live Intuit sandbox company
before Phase B is declared shipped.** No Intuit sandbox credentials or
interactive browser session were available in this task's execution
environment, so the walkthrough below was not performed; only the automated
gate (Section 1) was run. Do not treat this section's fields as evidence of a
completed walkthrough — they are the template a tester fills in when they run
it.

Use a **dedicated sandbox company and a dedicated test customer/catalog
item** — never production books. Capture QuickBooks entity IDs and realm ID
only in the tester's private test record (e.g. a private note, ticket, or
password-manager entry) — **never commit them to this repository.** This
document records the realm **label** (a human-readable name the tester
assigns the sandbox company, e.g. "Breeze QBO Sandbox 1"), never the realm ID.

### Evidence header (fill in per run)

| Field | Value |
|---|---|
| Date | 2026-09-01 (evening MDT) |
| Breeze build SHA | a8e6c0ac5 (PR #4492, post-merge of main) |
| Hosted region | self-hosted (per-worktree dev stack, Caddy pinned to localhost:3001) |
| Intuit app environment | sandbox |
| Sandbox company realm label | Intuit default "Sandbox Company_US" (single-currency, USD home, AST sales tax on) |
| Tester | Todd Hebebrand (OAuth consent) + Claude (API/DB/QBO-query driven steps) |

### Checklist (pass/fail + visible Breeze status after each action)

1. **Connect the sandbox company and verify no credentials appear in UI/API
   logs.**
   Result: PASS. Visible status: card `Active`, environment `sandbox`, home currency `USD`, multi-currency `No`. `GET /accounting/quickbooks` carries no token fields; `accounting_connections` stores `realm_id_encrypted` / `access_token_encrypted` / `refresh_token_encrypted` only; API access log shows routes, never bodies.

2. **Select and save an active QuickBooks income account.**
   Result: PASS. Visible status: settings PATCH returned `defaultIncomeAccountRef: "5"` (Fees Billed); income-account list came live from the realm (`GET .../income-accounts`, 20 Income accounts).

3. **Reconcile one existing customer by email and confirm it; verify QBO is
   unchanged.**
   Result: PASS. Visible status: org with billing email `surf@example.com` was proposed to QBO customer 2 with confidence `exact_email`; confirm + sync → `confirmed / synced`, `remote_entity_id=2`, `remote_sync_token=1`, `remote_currency_code=USD`. QBO customer 2 was sparse-updated (DisplayName now follows the Breeze org name).

4. **Choose create-new for a second organization; sync twice; verify one QBO
   Customer exists and the second sync updates it without duplication.**
   Result: PASS. Visible status: `create_new` + two consecutive syncs → one QBO customer (Id 58), `remote_sync_token=0` after both; candidate search shows exactly one "Breeze Create-New Co".

5. **Reconcile one existing Item by SKU and confirm it.**
   Result: PASS (by candidate search, not SKU). Visible status: sandbox items carry no SKU, so the SKU proposal is `none`; picked "Hours" (Id 2) through the workbench candidate search, confirm + sync → `confirmed / synced`, `remote_entity_id=2`, token 1. QBO item 2 now carries the Breeze SKU `HOURS`.

6. **Choose create-new for a second catalog item; verify Service or
   NonInventory type, price, taxability, SKU, income account, remote ID, and
   SyncToken.**
   Result: PASS. Visible status: `create_new` + sync → QBO Service item Id 19 "Breeze Managed Workstation" with `Sku=BRZ-MWS`; `remote_sync_token=0`.

7. **Change the Breeze org/item, sync again, and verify a sparse QBO update
   plus incremented persisted SyncToken.**
   Result: PASS. Visible status: renamed the item to "… v2", sync → still `remote_entity_id=19`, QBO item name updated (sparse update, no second item).

8. **Attempt a duplicate remote claim and verify Breeze returns a visible
   conflict without changing QBO.**
   Result: PASS. Visible status: confirming Default Organization against already-claimed customer 2 → HTTP 409 `{ error: "This QuickBooks record is already mapped to a different Breeze entity", code: "mapping_conflict" }`.

9. **Disconnect/reconnect the same sandbox and verify mappings remain tied to
   the connection lifecycle as designed.**
   Result: PASS (as designed). Visible status: `POST .../disconnect` deleted the connection row and CASCADEd all 8 mapping rows (orgs, items, invoices). Reconnect via OAuth created a fresh row (`connectedAt` new, settings back to null), 0 mappings, and email suggestions immediately re-proposed customers 2 and 58. Design consequence worth knowing: previously pushed invoices show `accountingSync: null` after a reconnect; a re-push relies on the provider's DocNumber lookup to avoid a duplicate. Also: a card left open across an out-of-band disconnect keeps its stale `Active` state until Refresh/reload (not a bug, no live subscription).

### Phase C checklist (invoice push)

Issued-invoice push, void, and the multi-currency seams (Phase C, migration
`apps/api/migrations/2026-09-30-quickbooks-invoice-push.sql`). Same rules as
Section 2 above: dedicated sandbox company, no credentials or realm IDs
committed to this repository.

10. **Push an invoice that mixes a mapped catalog line and an ad-hoc
    (unmapped) line; verify the QBO Invoice has a `SalesItemLineDetail` line
    with an `ItemRef` for the mapped item and one with no `ItemRef` for the
    ad-hoc line, and that both lines' amounts/quantities/descriptions match
    the Breeze invoice.**
    Result: PASS. Visible status: INV-2026-0001 (org 2, 3× mapped "Hours" + one ad-hoc line, 455.00 USD) auto-pushed on issue by the `accounting-sync` worker → invoice detail `accountingSync.syncStatus = synced`, `remoteDocNumber = null` (QBO kept our DocNumber). QBO Invoice 145: mapped line `ItemRef=2`, ad-hoc line landed with the realm's default item `ItemRef=1` ("Services") — the no-ItemRef payload is accepted and QBO fills its default.

11. **With the connection's default tax code set, push a taxable invoice and
    confirm the `TxnTaxDetail` override lands on the QBO Invoice (not QBO's
    own tax engine total); then push an invoice where QBO's returned
    `TxnTaxDetail.TotalTax` differs from Breeze's `tax_total` by more than 1¢
    and verify Breeze flags it `synced_with_tax_variance` rather than plain
    `synced`.**
    Result: PASS (variance path). Visible status: with `defaultTaxCodeRef=TAX` and Breeze tax 8.5%, INV-2026-0005 (198.00 + 16.83 tax) pushed → `syncStatus = synced_with_tax_variance`; QBO Invoice 148 shows `TotalTax 0` (AST realm computed 0 for a customer with no address) with lines at `TaxCodeRef=TAX`. QBO does not echo `TxnTaxCodeRef` back on an AST realm, so the override itself is verified only by the request shape, not the response. Earlier untaxed pushes (INV-2026-0002/0004) synced with no variance.

12. **Push two invoices that collide on `DocNumber` (e.g. by reusing a number
    already present in the sandbox company) and verify Breeze retries once
    without `DocNumber`, then records the QBO-assigned `DocNumber` — not the
    Breeze invoice number — on the mapping row.**
    Result: NOT REPRODUCIBLE in this realm. `Preferences.SalesFormsPrefs.CustomTxnNumbers = false`, so QBO never raises `Duplicate Document Number` and the strip-DocNumber retry cannot fire. What WAS verified: deleting INV-2026-0002's mapping row and pushing again (CREATE path) reused QBO Invoice 146 (provider DocNumber lookup idempotency) — no duplicate invoice. Re-run against a realm with custom transaction numbers on.

13. **Void a previously-pushed invoice and confirm the QBO Invoice shows
    Voided; also void an invoice that was never pushed and confirm Breeze
    resolves without contacting QBO (no mapping row, or one with no
    `remoteEntityId`).**
    Result: PASS. Visible status: `POST /invoices/:id/void` → void job processed → QBO Invoice 145 `TotalAmt 0`, `Balance 0`, `PrivateNote "Voided"`, `SyncToken 1`. The mapping row is left as-is (`synced`, remote 145); Breeze `status=void` is the source of truth.

14. **Fetch realm settings (Preferences) against both a multi-currency-enabled
    sandbox company and a single-currency one; confirm
    `MultiCurrencyEnabled` is visible and correctly read as `true`/`false`
    (not just "present") on both realm types.**
    Result: PASS (single-currency realm only). Visible status: `POST .../settings/refresh` → `{ homeCurrency: "USD", multiCurrencyEnabled: false }`, matching `Preferences.CurrencyPrefs` read straight from QBO; the integration card renders Home currency USD / Multi-currency No after refresh and on cold load (`GET /:provider` now carries the flag). A multi-currency realm was not available this run.

15. **Attempt to push a foreign-currency invoice (an invoice whose
    `currency_code` differs from the realm's home currency) into a
    single-currency realm and confirm Breeze returns a typed error
    (`currency_mismatch` / `home_currency_unknown`) — never a 1:1 silent
    booking at the wrong currency.**
    Result: PASS. Visible status: INV-2026-0003 switched to EUR (`POST /invoices/:id/currency`) and issued. Worker: `terminal failure, not retrying … code=currency_mismatch`, no mapping row created, nothing sent to QBO. Manual push → HTTP 409 `{ error: "currency_mismatch", message: "Invoice currency EUR does not match the connected QuickBooks home currency USD. Cross-currency accounting pushes are not supported. Enable multi-currency in QuickBooks or invoice in USD." }`. UX gap (follow-up): with no mapping row, the invoice detail card renders nothing for the auto-push failure — only the manual push surfaces the error.

16. **Map an organization to a QuickBooks customer whose `CurrencyRef` is a
    different currency than the Breeze invoice being pushed (a
    customer-currency mismatch, distinct from the realm-level mismatch above)
    and capture the exact fault text Breeze surfaces.**
    Result: NOT TESTABLE in this realm (single-currency; every customer is USD, so no non-home `CurrencyRef` exists). Customer currency capture itself is verified: `remote_currency_code=USD` persisted on both org mappings. Re-run against a multi-currency realm.

### Phase D checklist (payment pull-back)

**Status: EXECUTED 2026-09-02 (~16:05–16:19 UTC) against the live Intuit
default US sandbox company ("Sandbox Company_US", USD, single-currency).**
Build: main at `f316986fc` (PR #4531 squash) on a per-worktree dev stack with
Caddy pinned to `localhost:3001`; webhook delivered through a Cloudflare
quick tunnel registered as the Intuit app's **Development** webhook endpoint
(Invoice + Payment event groups, classic payload format). Tester: Todd
Hebebrand (Intuit login + OAuth consent) with Claude driving the API, DB and
QuickBooks-side calls. Results: 17–25 PASS (9/9); 26 NOT REPRODUCIBLE via a
Redis outage (see the item). One cosmetic defect found and fixed in the same
PR: the worker's run line logged `cursorAfter=null` on every run because it
was emitted before the cursor CAS (`accountingReconcileWorker.ts`). Follow-ups
worth filing are listed after item 26. Same rules as Sections 2/2a above:
dedicated sandbox company, no credentials or realm IDs committed to this
repository.

Payment pull-back (Phase D, migration
`apps/api/migrations/2026-10-01-quickbooks-payment-pullback.sql`): QBO-origin
payments mirror into Breeze via the Intuit webhook (latency optimisation, one
region only) and the 15-minute `accounting-reconcile` CDC sweep (the
guaranteed path in every region).

Intuit allows exactly **one webhook URL per app**, and the hosted contract
uses one Intuit app for both regions, so only the US deployment ever receives
webhook notifications — the EU deployment (and any self-hosted install with
no public webhook URL) relies entirely on the 15-minute sweep, which reaches
the same end state on its own. `POST /api/v1/webhooks/quickbooks` verifies
every delivery against `QBO_WEBHOOK_VERIFIER_TOKEN` (HMAC over the raw body);
with the token unset the route answers `503` on every request rather than
`200`, so Intuit keeps retrying instead of an unconfigured region silently
swallowing notifications. Setting up the tunnel for item 17 below requires
`QBO_WEBHOOK_VERIFIER_TOKEN` to be present in the target environment's
`.env` **and** mapped in that environment's compose `environment:` block —
per this repo's rule for new required env vars (CLAUDE.md, "Required env
vars" — a value sitting only in `.env` is not sufficient; compose
interpolation only happens for vars listed in the service's `environment:`
block).

17. **Register the webhook URL through a tunnel and confirm Intuit's verifier
    handshake**, then receive a PARTIAL payment against a pushed invoice in
    QBO and confirm Breeze flips the invoice to `partially_paid` within
    seconds with a "QuickBooks" badge on the payment row.
    Result: PASS. Handshake: with `QBO_WEBHOOK_VERIFIER_TOKEN` unset the
    route answered `503` (local and through the tunnel); after setting it and
    recreating the API, a bogus `intuit-signature` answered `401`. Pushed
    INV-2026-0001 ($200, one mapped catalog item, mapped customer) then
    created an $80 Payment in QBO via the API at 16:09:27Z. Intuit delivered
    within ~1 s (`202`, `entityCounts: { Payment: 1 }`), the reconcile run
    logged `trigger=webhook applied=1`, and the invoice read `partially_paid`
    / `amount_paid 80.00` / `balance 120.00`. Invoice detail page: PAYMENTS
    row "$80.00 · Other · 9/2/2026" with the "QUICKBOOKS / via QuickBooks"
    badge. Audit: `accounting.payment.pulled` with remotePaymentId/
    remoteInvoiceId. Mapping row `payment` = `<PaymentId>/<InvoiceId>`,
    `synced`. `cdc_cursor` advanced to the QBO response time.

18. **Record the remaining balance in QBO** and confirm Breeze flips to
    `paid` with `paid_at` stamped.
    Result: PASS. $120 Payment created in QBO at 16:10:12Z → webhook →
    invoice `paid`, `amount_paid 200.00`, `balance 0.00`, `paid_at` stamped
    `2026-09-02 16:10:13`. UI: Status "Paid", BALANCE DUE $0.00, both payment
    rows badged "via QuickBooks".

19. **Replay the same Intuit notification** (re-deliver from the Intuit
    dashboard, or re-run "Sync now") and confirm NO duplicate payment row
    appears and the run logs `replayed`.
    Result: PASS. "Sync now" (`POST /accounting/quickbooks/reconcile` →
    `{ enqueued: true }`) ran `trigger=manual applied=0 replayed=2`; still
    exactly two `invoice_payments` rows and two `payment` mapping rows.
    (Intuit's dashboard has no re-deliver button for Development webhooks;
    the sweep/manual path exercises the same idempotency claim.)

20. **Delete the payment in QBO** and confirm Breeze deletes only that
    payment row, recomputes the invoice, and writes an
    `accounting.payment.reversed` audit entry — while a manually recorded
    payment on the same invoice survives untouched.
    Result: PASS, in two halves. (a) Deleted Payment 151 ($120) in QBO →
    `reversed=1`; only that row was removed, invoice back to
    `partially_paid` / `amount_paid 80.00`, audit
    `accounting.payment.reversed` `{ reason: "deleted_in_quickbooks",
    amount: "120.00", remotePaymentId: "151" }`, its mapping row gone.
    (b) Recorded a manual $50 check payment in Breeze, then deleted Payment
    150 ($80) in QBO → `reversed=1`; the manual $50 row survived untouched
    (`partially_paid`, `amount_paid 50.00`, zero `payment` mapping rows).
    Observation (follow-up, not Phase D's bug): `invoices.paid_at` keeps its
    original stamp after a reversal drops the status back to
    `partially_paid` — the engine only ever sets `paidAt` on the transition
    to `paid` and nothing clears it; Phase D is the first path that reduces
    `amount_paid`.

21. **Disable the webhook and let the 15-minute sweep run with a stale
    cursor** — confirm the same end state is reached with no webhook at all
    (this is the guaranteed path in every region; only the US deployment
    receives Intuit notifications).
    Result: PASS. Killed the tunnel (so Intuit's deliveries failed), created a
    $30 Payment on the same invoice at 16:12:27Z, and waited: the BullMQ
    repeatable fired at 16:15:05Z with `trigger=sweep applied=1
    cursorBefore=16:11:42Z`, invoice `partially_paid` / `amount_paid 80.00`
    (50 manual + 30). Same end state as the webhook path, with no webhook.

22. **Record the observed CDC paging behaviour**: make more than 1000 payment
    changes in one window if feasible, otherwise capture a normal response's
    `QueryResponse` block verbatim (`startPosition`, `maxResults`,
    `totalCount`) so decision 3's window-halving can be confirmed or replaced
    with a real cursor.
    Result: PASS (captured; >1000 changes not feasible in the sandbox). A
    direct `GET /cdc?entities=Payment,Invoice&changedSince=…` at 16:12:25Z
    returned two `QueryResponse` blocks: Payment
    `{ startPosition: null, maxResults: 2, totalCount: 2 }` (2 entities,
    both `status: "Deleted"` stubs) and Invoice
    `{ startPosition: 1, maxResults: 1, totalCount: 1 }`. Note
    `startPosition` is absent on one block and `1` on the other, and CDC has
    no upper-bound parameter — this is why decision 3's window-halving was
    replaced by `/query` paging with the `overflowed` dirty flag (the shipped
    design), which this run did not trigger.

23. **Toggle `pull_payments` off** and confirm the next sweep no-ops for that
    connection (no QBO call at all), then toggle it back on and confirm the
    backlog lands on the following run.
    Result: PASS. `PATCH settings { pullPayments: false }`, created a $10
    Payment in QBO, "Sync now" → the route still enqueued
    (`{ enqueued: true }`) but the worker returned before any QuickBooks
    call: no run line, `cdc_cursor` unchanged (16:15:35Z), `amount_paid`
    unchanged. `{ pullPayments: true }` + "Sync now" → `applied=1`, the $10
    landed (`amount_paid 90.00`). Observation: the skip is silent (no log
    line at all); a debug-level line would help an operator distinguish
    "disabled" from "never ran".

24. **Void an invoice in QBO** and confirm the Breeze invoice mapping flips
    to `error` / "Deleted in QuickBooks" in the sync card and is never
    auto-resurrected.
    Result: PASS. Voided Invoice 153 (INV-2026-0003) in QBO via the API;
    "Sync now" → `invoicesMarkedDeleted=1`, mapping `error` /
    "Deleted in QuickBooks". Invoice detail sync card: "Sync failed —
    Deleted in QuickBooks". Two further runs re-reported
    `invoicesMarkedDeleted=1` (the void is still inside the CDC window) and
    the mapping stayed `error` — never auto-resurrected. The Breeze invoice
    itself stays `sent` with its balance; the card still offers
    "Push to QuickBooks" (see follow-ups).

25. **Record a QBO payment against an invoice Breeze has voided** and confirm
    the invoice mapping flips to `error` with the message "Payment received
    in QuickBooks against a voided invoice", the void header's `amount_paid`
    and `balance` are left untouched, and the run outcome is `invoice_void`
    (not a retried failure).
    Result: PASS, via the real race. With the tunnel down, created a $40
    Payment against Invoice 152 (INV-2026-0002) in QBO, then voided
    INV-2026-0002 in Breeze. Breeze's void → QBO void job was rejected
    (`accounting-void-… failed: QuickBooks rejected the invoice sync
    (HTTP 400)` — the invoice already had a payment applied), which is exactly
    the divergence this item guards. "Sync now" → `invoiceVoid=1 failed=0`,
    mapping `error` / "Payment pull: Payment received in QuickBooks against
    a voided invoice", no `invoice_payments` row, void header untouched
    (`amount_paid 0.00`, `balance 100.00`). Invoice detail sync card shows
    "Sync failed — Payment pull: Payment received in QuickBooks against a
    voided invoice".

26. **Trigger "Sync now" while Redis/BullMQ is unavailable (or the queue add
    otherwise fails)** and confirm the route still answers HTTP 200 with
    `{ enqueued: false }` rather than a silent success, and that the web UI
    shows the warning toast "Payment sync could not be queued. Try again
    shortly." rather than the success toast — this is the quiet-failure-UI
    guard and is Playwright-worthy as its own regression test independent of
    a live sandbox.
    Result: NOT REPRODUCIBLE via a Redis outage. With the stack's Redis
    container stopped, the API's rate limiter fails closed and every request
    answers `429 { "error": "Too many requests" }` before the reconcile route
    runs; the web app then bounces the session to `/login`, so "Sync now" is
    unreachable. The `200 { enqueued: false }` branch and its warning toast
    are covered by `routes/accounting/reconcile.test.ts` ("200 { enqueued:
    false } … and the audit records it") and
    `QuickbooksIntegration.test.tsx` ("never reports { enqueued: false } as a
    success"). The Playwright regression this item asks for should mock the
    route's `200 { enqueued: false }` response rather than take Redis down.

Follow-ups surfaced by this run (not fixed here):

- `invoices.paid_at` is never cleared when a QuickBooks reversal drops the
  status from `paid` back to `partially_paid` (item 20).
- The `pull_payments = false` skip in the reconcile worker is silent
  (item 23).
- A voided (Breeze) or QBO-deleted invoice's sync card still offers
  "Push to QuickBooks" (items 24/25); the button should probably hide or
  explain itself on a terminal invoice.
- The Intuit Development webhook endpoint was left pointing at the
  now-dead quick-tunnel URL; Intuit will retry and eventually disable it.
  Re-register before the next walk. The Production tab is untouched.

### Phase D2 checklist (payment push)

**Status: PENDING — not yet run.** Items 27-40 below have never been executed
against a live Intuit sandbox. Item 27 is a HARD PREREQUISITE for 28-40:
the Development webhook URL registered during the Phase D walk points at a
dead quick tunnel, so without re-registering it the echo and adoption cases
cannot be observed at webhook latency at all and the 15-minute
`accounting-reconcile` sweep is the only path left — which still reaches the
same end state, but turns every "within seconds" assertion below into "within
one sweep".

Payment push (Phase D2, migration
`apps/api/migrations/2026-10-05-100000-quickbooks-payment-push.sql`): payments
recorded in Breeze against an invoice already pushed to QuickBooks are created
there, and deleted there when the Breeze payment is voided or fully refunded.
The mapping row is the outbox (`pending_op`), so BullMQ is a latency
optimisation on this path too. Same rules as Sections 2/2a above: dedicated
sandbox company, no credentials or realm IDs committed to this repository.

Before starting, confirm the realm's connection is `connected`, that
`push_payments` is **on** (it defaults on) and note the current `push_mode` —
items 34 and 35 change both and must put them back.

27. **Re-register the Development webhook URL in the Intuit developer portal
    (#4545) and confirm the verifier handshake**, exactly as Phase D item 17
    did: tunnel → Intuit app → Webhooks → Development, Invoice + Payment event
    groups, then check that a bogus `intuit-signature` answers `401` (and that
    `503` means `QBO_WEBHOOK_VERIFIER_TOKEN` never reached the container). The
    URL registered during the Phase D walk is dead; every echo case below
    depends on it.
    Result: PENDING.

28. **Record a manual payment in Breeze against an invoice already pushed to
    QuickBooks** and confirm a QuickBooks Payment appears, applied to that
    invoice, with the QuickBooks invoice balance dropping by the payment amount
    and the payment's `PrivateNote` reading exactly `Breeze payment <uuid>`
    (the `invoice_payments.id`).
    Visible status: the payment row on the invoice shows the "In QuickBooks"
    badge (`invoice-payment-qbosync-<id>`); the mapping row is
    `remote_entity_id = '<PaymentId>/<InvoiceId>'`, `sync_status = synced`,
    `pending_op` NULL, `breeze_origin = true`.
    Result: PENDING.

29. **Let the webhook echo of item 28 arrive** and confirm the reconcile run
    logs `replayed` (not `applied`), that NO second payment row appears in
    Breeze, and that the invoice balance and `amount_paid` are unchanged.
    Result: PENDING.

30. **Pay an invoice with a Stripe test card** and confirm the QuickBooks
    Payment carries the GROSS charge amount (not net of the Stripe fee), has no
    `DepositToAccountRef` (so QuickBooks books it to Undeposited Funds), and
    that its `PaymentRefNum` is the `pi_…` reference truncated to QuickBooks'
    21 characters.
    Result: PENDING.

31. **Void the Breeze payment** and confirm the QuickBooks Payment is deleted,
    the QuickBooks invoice balance returns, the mapping row disappears
    entirely, and an `accounting.payment.deleted` audit entry is written.
    Result: PENDING.

32. **Delete the QuickBooks Payment by hand** and confirm the Breeze payment
    row SURVIVES with the invoice's `amount_paid`/`balance` untouched, that its
    mapping flips to `sync_status = error` / `last_error = "Deleted in
    QuickBooks"` with `remote_entity_id` and `remote_sync_token` cleared, and
    that pressing "Push to QuickBooks" on the invoice re-creates the Payment
    (the fan-out re-owns the SAME mapping row rather than inserting a second
    one).
    Visible status: the payment row's badge turns into the red
    "QuickBooks sync failed" badge whose tooltip is `Deleted in QuickBooks`.
    Result: PENDING.

33. **Edit the QuickBooks Payment's amount by hand** and confirm Breeze does
    NOT change its own payment amount or the invoice totals, that the mapping
    goes to `error` / `Edited in QuickBooks; Breeze remains the source of truth
    for this payment` (`breeze_origin_diverged`), that `remote_entity_id` is
    KEPT, and that the stored `remote_sync_token` advances — the advanced token
    is what stops a later delete failing "stale object".
    Result: PENDING.

34. **Set `push_mode = manual`, record a payment, and confirm NOTHING is
    pushed** (no QuickBooks Payment, no mapping row). Then press "Push to
    QuickBooks" on the invoice and confirm the invoice syncs first and the
    payment follows immediately after via the fan-out. Put `push_mode` back.
    Result: PENDING.

35. **Switch `push_payments` off, record a payment** (no QuickBooks Payment and
    no create job should result), **then void an already-pushed payment** and
    confirm the DELETE still propagates to QuickBooks — Breeze owns the removal
    of what it created, regardless of the switch. Then switch `push_payments`
    back on and confirm the payment recorded while it was off is still not
    pushed automatically (only a fan-out or a new payment pushes).
    Result: PENDING.

36. **Record a payment larger than the QuickBooks invoice balance** and confirm
    QuickBooks rejects it, the mapping shows the sanitized
    `QuickBooks rejected the payment sync (HTTP n)` and never an Intuit fault
    body, `pending_op` is KEPT (so the sweep retries) and the job is retried
    rather than marked terminal.
    Result: PENDING.

37. **Void a fully-paid invoice in Breeze** and confirm the QuickBooks Invoice
    is voided while its Payment is LEFT IN PLACE as unapplied customer credit
    (spec decision 11), and that when the void echoes back the invoice mapping
    reads `invoice_void` and does NOT show "Deleted in QuickBooks" (the
    self-void guard).
    Result: PENDING.

38. **Kill the API between the QuickBooks create and phase 2** — stop the
    container while a push job is in flight, e.g. with a breakpoint or by
    stopping it the moment the QuickBooks request is logged — and confirm that
    within one 15-minute sweep the CDC pass ADOPTS the orphaned Payment: the
    mapping gains the remote id and token, no second Payment is created, and
    the reconcile summary reports `adopted=1`.
    Result: PENDING.

39. **Exercise the accepted "Copy" residual risk.** With a Breeze payment
    delete-pending and its remote id not yet known (the item-38 shape: void the
    Breeze payment while the create is in flight), use QuickBooks' **Copy** on
    the original Payment — Copy preserves `PrivateNote`, so the copy carries
    Breeze's marker for a payment it is not. Record what actually happens when
    the copy is the first CDC line to arrive: the documented risk is that the
    adoption takes the COPY's id and the delete worker deletes the copy,
    leaving the original Payment standing. This is an ACCEPTED risk
    (`accountingPaymentPull.ts`, "RESIDUAL RISK"), not a bug to fail the walk
    on — the item exists to confirm the blast radius is exactly this and no
    wider (no Breeze row deleted, no unrelated Payment touched).
    Result: PENDING.

40. **Turn `pull_payments` OFF while leaving `push_payments` ON**, then push a
    payment and let its echo arrive. Confirm the reconcile pass still RUNS
    (the gate is `pull_payments OR push_payments`), that the echo is still
    processed — `replayed`, or `adopted` if it beats phase 2 — and that a
    payment created directly in QuickBooks by hand is NOT imported, logging
    `skipped_pull_disabled` once per run rather than once per payment. Put
    `pull_payments` back on.
    Result: PENDING.

### How to fill this in on the next run

1. Copy the "Evidence header" and "Checklist" blocks above into a new
   dated section below this one (do not overwrite this template) — or, if
   this is the first real run, replace the PENDING values in place and
   change this section's status line to reflect a completed run with a date.
2. For each checklist item, record PASS/FAIL and the exact Breeze-visible
   status text/toast the UI showed (per `runAction` — every mapping mutation
   in this feature surfaces outcome via `runAction`,
   `apps/web/src/lib/runAction.ts`).
3. Confirm no credentials, tokens, or QuickBooks realm IDs were written
   anywhere in this repository as part of the run (grep the diff before
   committing).
4. Migrations referenced by this feature:
   `apps/api/migrations/2026-09-28-quickbooks-entity-mappings.sql` (Phase B),
   `apps/api/migrations/2026-09-30-quickbooks-invoice-push.sql` (Phase C),
   `apps/api/migrations/2026-10-01-quickbooks-payment-pullback.sql` (Phase D),
   `apps/api/migrations/2026-10-05-100000-quickbooks-payment-push.sql`
   (Phase D2).

---

## 3. Phase C dependency contract

Phase C (issued-invoice sync) needs to look up, for one `(integrationId,
breezeEntityType, breezeEntityId)` triple, whether a **confirmed** mapping
exists and, if so, its `remoteEntityId` and `remoteSyncToken` — without ever
reading `organization_external_links` or any QuickBooks fields from core
billing tables. This section proves that query shape exists today and
compiles, by pointing at the real, already-shipped code rather than adding
anything new.

### Schema (real exports, `apps/api/src/db/schema/accounting.ts`)

```ts
// apps/api/src/db/schema/accounting.ts:45-96
export const accountingEntityMappings = pgTable('accounting_entity_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  integrationId: uuid('integration_id').notNull(),
  partnerId: uuid('partner_id').notNull().references(() => partners.id),
  breezeEntityType: varchar('breeze_entity_type', { length: 20 }).notNull(),
  breezeEntityId: uuid('breeze_entity_id').notNull(),
  remoteEntityType: varchar('remote_entity_type', { length: 20 }).notNull(),
  remoteEntityId: text('remote_entity_id'),
  remoteSyncToken: varchar('remote_sync_token', { length: 64 }),
  linkStatus: varchar('link_status', { length: 20 }).notNull().default('suggested'),
  syncStatus: varchar('sync_status', { length: 30 }).notNull().default('pending'),
  // ... lastSyncedAt, lastError, createdAt, updatedAt
}, (table) => ({
  // unique on (integrationId, breezeEntityType, breezeEntityId) —
  // accounting_entity_mappings_breeze_uniq
  ...
}));

export type AccountingEntityMapping = typeof accountingEntityMappings.$inferSelect;
```

`breezeEntityType` is constrained (`accounting_entity_mappings_entity_type_chk`)
to `'org' | 'catalog_item' | 'invoice' | 'payment'`, and `linkStatus` is
constrained (`accounting_entity_mappings_link_status_chk`) to `'suggested' |
'confirmed' | 'unlinked' | 'create_new'` — a worker filtering on
`linkStatus = 'confirmed'` gets exactly the resolved-mapping rows Phase C
needs, with `remoteEntityId`/`remoteSyncToken` guaranteed non-null in
practice for any row that reached `synced` (see
`persistRemoteRef`, below).

### The exact Drizzle query shape (already shipped, `accountingMappingService.ts`)

`apps/api/src/services/accounting/accountingMappingService.ts` already
contains this lookup pattern twice — it is the load-then-narrow-in-JS shape a
Phase C worker should reuse verbatim (either by importing an exported
sibling of `loadMappingRows`, or by copying the same `db.select().from(...)
.where(and(...))` shape into the worker's own module):

```ts
// apps/api/src/services/accounting/accountingMappingService.ts:515-529
async function loadMappingRows(
  partnerId: string,
  integrationId: string,
  breezeEntityType: MappingEntityType,
): Promise<MappingRow[]> {
  const rows = await db
    .select()
    .from(accountingEntityMappings)
    .where(and(
      eq(accountingEntityMappings.partnerId, partnerId),
      eq(accountingEntityMappings.integrationId, integrationId),
      eq(accountingEntityMappings.breezeEntityType, breezeEntityType),
    ));
  return rows as MappingRow[];
}
```

and the narrow-to-one-entity + read-`remoteEntityId`/`remoteSyncToken` step,
already exercised in production code paths (`saveMappingDecision` and
`syncMappedEntity`):

```ts
// apps/api/src/services/accounting/accountingMappingService.ts:622-623
const mappingRows = await loadMappingRows(partnerId, conn.id, breezeEntityType);
const existing = mappingRows.find((m) => m.breezeEntityId === breezeEntityId) ?? null;
```

```ts
// apps/api/src/services/accounting/accountingMappingService.ts:856-858
const existingRef: AccountingEntityMappingSeam | null = mapping.remoteEntityId
  ? { remoteEntityId: mapping.remoteEntityId, remoteSyncToken: mapping.remoteSyncToken ?? null }
  : null;
```

For Phase C, the equivalent one-row-by-triple lookup a worker would issue is:

```ts
const [mapping] = await db
  .select({
    remoteEntityId: accountingEntityMappings.remoteEntityId,
    remoteSyncToken: accountingEntityMappings.remoteSyncToken,
    linkStatus: accountingEntityMappings.linkStatus,
  })
  .from(accountingEntityMappings)
  .where(and(
    eq(accountingEntityMappings.integrationId, integrationId),
    eq(accountingEntityMappings.breezeEntityType, breezeEntityType), // 'org' | 'catalog_item'
    eq(accountingEntityMappings.breezeEntityId, breezeEntityId),
  ));

if (!mapping || mapping.linkStatus !== 'confirmed' || !mapping.remoteEntityId) {
  // no confirmed mapping yet — invoice sync must not assume a remote id
}
```

This is a direct narrowing of the exact `where` clause `loadMappingRows`
already builds (same three predicates, same table, same columns read) — it
compiles under the same Drizzle/schema types already exercised by
`accountingMappingService.test.ts` and the RLS integration suite run in
Section 1.d above (`accounting-entity-mappings-rls.integration.test.ts`), so
no new production code was needed or added to prove this out.

**Confirms:**
- One confirmed Customer mapping (`breezeEntityType = 'org'`) and
  zero-or-more confirmed Item mappings (`breezeEntityType = 'catalog_item'`)
  are each reachable by exactly `(integrationId, breezeEntityType,
  breezeEntityId)` — the table's own unique index
  (`accounting_entity_mappings_breeze_uniq`) guarantees at most one row per
  triple.
- `remoteEntityId` and `remoteSyncToken` are ordinary typed columns on that
  same row — no join to `organization_external_links` or any QuickBooks
  field on a core billing table is required or used anywhere in this query
  path.
- RLS scopes every read to the partner (`breeze_has_partner_access` via
  `partnerId`), matching this feature's tenancy shape (Partner-axis, shape
  #3 in `CLAUDE.md`) — a Phase C worker running in a system DB context still
  needs to filter explicitly by `integrationId`/`partnerId` per row, exactly
  as this query does, since a system context bypasses RLS rather than
  narrowing through it.

---

## Change log

### (this PR) — 2026-09-02, Phase D2 payment push added, sandbox PENDING

Section 2 gains a `### Phase D2 checklist (payment push)` block, items 27-40,
every `Result:` **PENDING** — nothing in it has been run against a live Intuit
sandbox. Item 27 (re-register the dead Development webhook, #4545) gates the
rest: without it the echo and adoption cases only observe the 15-minute sweep.
The Phase D block above is untouched and still records its executed 17-26.
Two items beyond the obvious happy path are deliberate: item 39 exercises the
accepted QuickBooks "Copy" residual risk documented in `accountingPaymentPull.ts`
(Copy preserves `PrivateNote`, so a copy can be adopted into a delete-pending
row), and item 40 covers `pull_payments` off with `push_payments` on, which is
the configuration the reconcile gate was widened for.

### `#4537` — 2026-09-02, first live Phase D sandbox run

Section 2's Phase D checklist executed against the live default US sandbox:
items 17–25 PASS, item 26 not reproducible via a Redis outage (fenced
upstream by the fail-closed rate limiter; branch covered by unit tests).
Fixed inline: `accountingReconcileWorker.ts` logged `cursorAfter=null` on
every run because the run line fired before the cursor CAS. Four follow-ups
recorded under item 26.


Newest first. Each entry records what changed in the branch since the
previous automated-gate run, so a reader can tell whether the recorded
evidence still describes the code they are looking at.

### `20a5d14494b7e9e45792982b7e6bc12ba83956d0` — 2026-09-01, final-review fix wave

Two findings from the whole-branch final review, plus four minors.

- **Org erasure and org merge now clear `accounting_entity_mappings`.** The
  table is partner-axis with a polymorphic `(breeze_entity_type,
  breeze_entity_id)` Breeze side — no `org_id` column, no FK — so it is
  correctly absent from `CORE_ORG_CASCADE_DELETE_ORDER` and from
  `orgMergeRegistry`, and nothing cleaned it. Erasure stranded the deleted
  org's UUID paired with the QuickBooks Customer id it was billed under; a
  merge left the loser org's row holding a permanent claim on that Customer,
  which `claimedRemoteIds` then filtered out of every proposal while a manual
  confirm 409'd forever against `accounting_entity_mappings_remote_uniq` —
  with the orphan row invisible in the UI. Erasure is fixed by an explicit
  pre-clear in `ASSOCIATED_SYSTEM_SCOPED_TABLES` (`tenantCascade.ts`); the
  merge by a `DELETE` (not a repoint) of the loser's `'org'` rows in
  `runPostPassFixups` (`orgMerge.ts`), beside `config_policy_assignments`,
  which is the only place the merge engine can reach a table with no `org_id`
  column. `'catalog_item'` rows are partner-scoped and untouched. **Phase C's
  `'invoice'`/`'payment'` rows will need their own arms in both places, and
  nothing in CI will notice their absence.**
- **`syncMappedEntity` now guards create-time currency.** It never read
  `conn.homeCurrency`, so an org stamped EUR in a USD realm synced green,
  QuickBooks created the Customer at the realm default, and `CurrencyRef` is
  immutable after creation — Phase C's invoice-push guard would then 409 that
  org forever. A pre-flight typed 409 (`currency_mismatch`, same shape as
  `income_account_required`) now fires on the CREATE branch of both the
  customer and item paths, and on a NULL home currency. Updates stay ungated:
  a sparse update cannot change `CurrencyRef`.
- Minors: persisted-mapping `confidence` is derived rather than always
  `existing_link` (the workbench was labelling the operator's own decision a
  "Suggested match"); the item tab's income-account load is isolated from the
  mapping load so one failure no longer hides the list; `accountSubType` is
  optional on the web type, matching the API.

Gate re-run in full against this SHA: (a) 456 tests, (b) 234 tests, (c) one
pre-existing `cron-parser` error only, (d) all suites PASS including the
org-lifecycle contract suites now in scope.

### `d313665b2a50a0f4b38933232901000136c11464` — 2026-09-01, Task 7 initial run

First recorded run of the automated gate. Section (c) recorded two `tsc`
errors: the pre-existing `cron-parser` one, and a real production-code error
in `requireMappingWrite` that the run's test/doc-only contract left unfixed
(fixed later by `e69c9cf01`). The sandbox walkthrough (Section 2) was
PENDING then and is still PENDING now — no Intuit sandbox credentials have
been exercised against this branch.

### `a8e6c0ac5` — 2026-09-01, first live sandbox run (Phase B + Phase C)

Executed the full checklist against the Intuit default US sandbox company on a
per-worktree dev stack (Caddy pinned to `localhost:3001` to match the app's
registered redirect URI; `QBO_*` passed into the API container via a local
compose override). Results are inline above. Summary: 13 PASS, 1 PASS-as-designed
(9), 2 not reproducible/testable in a single-currency realm with custom
transaction numbers off (12, 16). Follow-ups raised, not fixed here:
- Auto-push `currency_mismatch` leaves no mapping row, so the invoice detail
  card shows nothing for the failure; only a manual push surfaces the error.
- Disconnect CASCADEs invoice mapping rows, so pushed invoices read
  `accountingSync: null` after a reconnect; re-push safety rests on the
  provider's DocNumber lookup.
- AST realms do not echo `TxnTaxCodeRef`; the override is verified by request
  shape only.
Verification of the QBO side used a throwaway in-container script issuing
`select * from Invoice where DocNumber in (...)` and `select * from Preferences`
with the stored connection's token; it was deleted, not committed.
