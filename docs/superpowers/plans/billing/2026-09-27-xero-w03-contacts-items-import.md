---
spec: docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md
index: docs/superpowers/plans/billing/2026-09-26-xero-accounting-integration-index.md
tracking_issue: LanternOps/breeze#7167
wave_issue: LanternOps/breeze#7170
---

# Xero W03: Contacts, Items and Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner connected to Xero can map Breeze organisations to Xero contacts and catalog items to Xero items (link, create-with-adoption, update), and can import Xero contacts as organisations — after which Xero declares `mapping` and `customerImport`.

**Architecture:** The provider-neutral mapping service, import service, routes, sweep and web workbench already exist (QuickBooks is the reference). W03 fills the five Xero provider stubs W02a left (`listRemoteCustomers`, `listRemoteItems`, `listRemoteIncomeAccounts`, `upsertCustomer`, `upsertItem`) through two new Xero-only modules (`xeroContacts.ts`, `xeroItems.ts`) on top of a new tenant-scoped write helper in `xeroHttp.ts` that stamps a request-derived `Idempotency-Key`. Adoption is the primary duplicate guard: before every create, and after every uncertain outcome, the provider looks the record up by its adoption key (`ContactNumber = breeze:<orgId>` for contacts; for items, a `Code` ending in a 10-hex hash of the catalog item id, found by suffix). The core gains only neutral pieces: a small set of structured refusal codes (`duplicate_name`, `duplicate_key`, `remote_archived`, `remote_missing`, `insufficient_scope`), two optional single-record lookups, a `supplierOnly` flag, and provider-labelled operator messages. Capabilities flip only in the last PR, after the lab proves item writes work with the pinned scopes.

**Tech Stack:** TypeScript, Hono, Drizzle ORM on PostgreSQL (partner-axis RLS), BullMQ + ioredis, Vitest, React (Astro islands) + react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md` (the "W03 — Contacts, items, import" section, the cross-wave adoption rule in "W04 → Idempotency", "Rate limiting" for the import-paging deferral, and "Scope boundaries"). W01 contract: `2026-09-26-xero-w01-core-neutralization.md`. W02 contract: `2026-09-26-xero-w02-connection.md`.

---

## Preconditions (hard gates, check before Task 0)

1. **W02a and W02b are merged to `main`.** W03a builds on `xeroHttp.ts`, `xeroProvider.ts`, `retryAfter.ts`, the three new `accounting_connections` columns (W02a, PR #7226 when this plan was written) and on Xero being **registered** in `providerRegistry.ts` plus the `capability_unavailable` mapping code and the `features` status block (W02b). W03a does not stack on either.
2. **W02c is merged before W03b starts.** W03b edits `AccountingConnectionPanel.tsx` after W02c's capability gating (`caps.mapping`, `caps.customerImport`) and reads `status.features.settingsOptions`, which W02c's panel consumes.
3. **Feature-lifecycle:** run `get_feature_status` for #7167; branch `feature/7167-xero/wave-7170-a-server` (then `…-b-web`); run `start_wave` for #7170 when W03a starts — **not before** (this plan's author did not start the wave).
4. **The Xero scope decision is known.** W02c lab step X14 (portal scope check) either confirmed `XERO_SCOPES` or changed it. W03 does not change scopes. W03b's lab step X16 (item create) is a **merge gate** for the capability flip — see "Where this plan refines the spec", item 1.

```bash
git fetch origin main
git log origin/main --oneline | grep -iE 'xero w02|#7169' | head
git ls-tree --name-only origin/main apps/api/src/services/accounting/ | grep -E 'xero(Http|Provider)\.ts|retryAfter\.ts'
```

Expected: the W02a and W02b squash commits are listed (and W02c before W03b); the three files exist on `main`. Anything missing: stop — the premise does not hold.

## Interface assumptions (re-verify every line in Task 0)

W03 calls these by the exact names below. **M** rows were read from `main` (`16b3ab2283`, 2026-09-27). **A** rows were read from W02a's branch (`feature/7167-xero/wave-7169-a-foundation` @ `461bbb8c72`, review-fix round in flight). **B/C** rows come from the W02 plan text (W02b/W02c were not built when this was written). If a name or shape differs on `main`, follow `main`: adapt the task's code and record the difference in the PR body. Never rename the upstream symbol back.

| # | Symbol (file) | Shape W03 relies on | Source |
|---|---|---|---|
| M1 | `AccountingProvider` (`services/accounting/types.ts:365-429`) | `listRemoteCustomers(conn, query?)`, `listRemoteItems(conn, query?)`, `listRemoteIncomeAccounts(conn)`, `upsertCustomer(conn, customer, mapping)`, `upsertItem(conn, item, mapping)`; every public async method throws only `AccountingProviderError` | main |
| M2 | `RemoteCustomer`, `RemoteItem`, `RemoteIncomeAccount`, `RemoteRef`, `RemoteAddress`, `AccountingEntityMapping`, `AccountingCustomerPayload`, `AccountingItemPayload` (`types.ts`) | as quoted in Tasks 3–4; `AccountingItemPayload.taxable: boolean`, `.incomeAccountRef?: string`, `.unitPrice: string` | main |
| M3 | `AccountingProviderError` + `AccountingProviderErrorKind` (`accountingProviderError.ts:16-18`) | kinds `reauth \| rate_limited \| validation \| not_found \| stale_version \| payment_linked \| duplicate_doc_number \| transient`; `providerCode?: string`; `isAccountingProviderError(err)` | main |
| M4 | `AccountingMappingError(code, status, message, opts)` + `AccountingMappingErrorCode` (`accountingMappingService.ts:112-150`) | `status: 404 \| 409 \| 429 \| 502`; `opts: { retryAfterMs?, throttleSource?, cause? }` | main |
| M5 | `callProviderOrThrow(action, errorMessage)` (`accountingMappingService.ts:325`) | throttle → 429; else Sentry + 502 `provider_error` | main |
| M6 | `syncMappedEntity` failure block (`accountingMappingService.ts:1386-1430`) | `if (err instanceof AccountingMappingError) throw err;` then throttle/sanitize → `markMappingError` in its own `runInDbContext` → throw | main |
| M7 | `MAPPING_TERMINAL_CODES` (`jobs/accountingSyncWorker.ts:175`) | `ReadonlySet<AccountingMappingErrorCode>` | main |
| M8 | `AccountingImportError(message, code, status)` + `fetchCustomers` (`accountingCustomerImport.ts:35-130`) | status `400 \| 404 \| 409 \| 502`; `[qb-import]` at `:377` | main |
| M9 | `handleImportError`, `handleMappingError`, `setRetryAfter` (`routes/accounting/index.ts:211-240`); `remote-candidates` handler (`:1293-1325`) | as quoted in Task 5 | main |
| M10 | `shouldDeferBackgroundWork(provider, spec, connectionId)`, `withProviderCallSlot`, `noteDailyRemaining` (`accountingRateLimit.ts`) | as named | main |
| M11 | `neutralCore.guard.test.ts` | flags the literal `'quickbooks'` and `qbo*`/`quickbooksFault`/`quickbooksProvider` imports in `services/accounting`, `jobs`, `routes/accounting`; exempts `*Provider.ts`; `'xero'` literals are not flagged | main |
| M12 | `quickbooksIdempotency.test.ts` | pins `customer-<organizationId>` / `item-<catalogItemId>` requestids | main |
| M13 | Web `AccountingMappingWorkbench.tsx` props `{ provider, onUnauthorized?, defaultIncomeAccountRef, onSettingsChanged? }`; `RemoteCandidate` interface `:77`; `handleSyncFailure` `:293`; `createGated` `:417`; picker search effect `:712-748` | as quoted in Task 8 | main |
| M14 | Web `AccountingCustomerImport.tsx` `AnnotatedCustomer` `:14`; `load()` `:46` | as quoted in Task 9 | main |
| M15 | Web `ActionError { code?, status, body? }` (`lib/runAction.ts:6`) | `body` is the parsed JSON response | main |
| M16 | `CONNECTOR_SETTINGS_HREF.xero === '/integrations#accounting'` (`lib/orgReadiness.ts`) | W01d deferral | main |
| A1 | `xeroApiGet<T>(ctx, path, operation)` (`xeroHttp.ts:353`) | path is appended raw to `XERO_API_BASE`; slot wraps `xeroRoundTrip`; `X-DayLimit-Remaining` → `noteDailyRemaining` | W02a |
| A2 | `XeroCallContext { connectionId, tenantId, accessToken, rate, timeoutMs? }` | as named | W02a |
| A3 | `xeroApiError(operation, status, headers, text)`, `xeroFaultMessage(text)`, private `providerError`, `xeroRoundTrip`, `XeroRawError` | 400 → `validation`, 404 → `not_found`, 429 → `rate_limited`, else `transient`; `providerCode` only on 429 | W02a |
| A4 | `xeroProvider.ts` private `requireBody`, `asArray`, `normalizeCurrency`, `callContext(conn, timeoutMs?)`, `XERO_RATE_LIMIT`; stubs for the five W03 methods with `_`-prefixed params (`:188-200`) | as named; `callContext` throws `AccountingProviderError{validation}` after W02a's fix round | W02a |
| A5 | `listSettingsOptions` income-account filter: ACTIVE, `Type` REVENUE or SALES, has `Code`; `ref = Code`, `label = "Code · Name"` | as named | W02a |
| A6 | `xeroProvider.test.ts`: `slotMock`, `conn()` factory, `json()` helper, `describe('methods behind later waves')` `it.each` table, `'declares only the connect capability'` test | as named | W02a |
| A7 | `AccountingConnection.defaultExemptTaxCodeRef`, `.defaultTaxCodeRef`, `.defaultIncomeAccountRef` hold Xero `TaxType` / `TaxType` / Account `Code` | as named | W02a |
| B1 | `providerRegistry.ts` registers `xero: xeroProvider`; `providerRegistry.test.ts` asserts Xero supports only `connect` | W03b Task 10 edits both | W02b Task 10 |
| B2 | `AccountingMappingErrorCode` includes `'capability_unavailable'` | W03 appends after it | W02b Task 8 |
| B3 | Status route `GET /:provider` returns `features: { tenantSelection: boolean; settingsOptions: boolean }` and `capabilities` | W03b reads `features.settingsOptions` | W02b Task 8 |
| C1 | `AccountingConnectionPanel.tsx`: `const caps = status?.capabilities ?? ALL_CAPABILITIES`; workbench rendered under `caps.mapping`, import under `caps.customerImport`; `AccountingSettingsStep` rendered when `status?.features?.settingsOptions` | W03b Task 8 passes one new prop | W02c Task 11/12 |
| C2 | `docs/integrations/xero-demo-verification.md` sections 0–2, rows X1–X15, `### Results`, `## Change log` | W03b Task 11 appends section 3 | W02c Task 13 |

**That is 16 main, 7 W02a, 3 W02b and 2 W02c assumptions (28).**

## Where this plan refines the spec (read before implementing)

Each item was checked against the code on `main`/W02a, or against Xero's published documentation, on 2026-09-27. Xero sources: Contacts <https://developer.xero.com/documentation/api/accounting/contacts>, Items <https://developer.xero.com/documentation/api/accounting/items>, Types <https://developer.xero.com/documentation/api/accounting/types#contacts>, Requests and responses (paging, dates) <https://developer.xero.com/documentation/api/accounting/requests-and-responses>, Response codes <https://developer.xero.com/documentation/api/accounting/responsecodes>, Idempotency <https://developer.xero.com/documentation/guides/idempotent-requests/idempotency>, Limits <https://developer.xero.com/documentation/guides/oauth2/limits>, Scopes <https://developer.xero.com/documentation/guides/oauth2/scopes>, Granular-scopes FAQ <https://developer.xero.com/faq/granular-scopes>, Contact best practice <https://developer.xero.com/documentation/best-practices/data-integrity/contacts>, OpenAPI <https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml>.

1. **Item writes may need a scope W02 does not request.** Xero's Scopes page lists `/Items` under the granular `accounting.invoices` (which W02 pins), but Xero's own OpenAPI spec (commit 448060d7, 2026-09-03) still requires `accounting.settings` for `PUT/POST /Items` and lists no granular scopes at all. W03 does **not** widen `XERO_SCOPES` (that is a consent change for every connected partner and a much larger grant: `accounting.settings` also writes Accounts, Organisation and TaxRates). Instead: (a) an insufficient-scope refusal is classified (`401/403` with a `WWW-Authenticate` header naming `insufficient_scope` — Xero's FAQ spells it `insufficent_scope`, so the pattern accepts both) as `validation` + `insufficient_scope` and surfaced as a terminal `provider_permission` refusal, never a retry loop (Task 2); (b) lab step **X16** creates an item with the pinned scopes and **blocks the capability flip** (Task 10). If X16 fails, stop and escalate to the owner with the choice "add `accounting.settings`" vs "ship contacts-only mapping" — do not flip `mapping`.
2. **Contact `ContactNumber` is the adoption key, looked up with `where` + `includeArchived`.** `ContactNumber` is API-settable only, max 50 (`breeze:` + a UUID is 43), shown read-only in Xero as "Contact Code", and unique (PUT "will error if an existing contact matches your ContactName or ContactNumber"). It is **not** an optimised `where` filter, but `where` "can reference most elements"; the record filter `GET /Contacts/{ContactNumber}` exists but its handling of a `:` in the path is unverified. The plan uses `GET Contacts?where=ContactNumber=="breeze:<orgId>"&includeArchived=true` and re-checks the value client-side. Lab step **X17** confirms it (and times it on the Demo Company).
3. **ContactNumber is written on create only.** Xero's best practice says a contact carries one number and an integration must not overwrite another integration's. So an update — including the update after adoption and every update of a linked (user-confirmed) contact — omits `ContactNumber`, which a Xero `POST` leaves unchanged.
4. **Adopting our own archived contact is refused, not silently linked.** Archived and `GDPRREQUEST` contacts "can no longer be used in transactions". If the adoption lookup finds our `ContactNumber` on an `ARCHIVED` contact, the provider throws `validation` + `remote_archived` ("restore it in Xero, then sync again"). Un-archiving through the API is unverified (lab **X21** records whether `ContactStatus: 'ACTIVE'` works; a later wave may automate it). `GDPRREQUEST` contacts are dropped from every listing — they are never suggested, never importable. The same rule covers an **already-mapped** contact: an update whose response shows `ARCHIVED`/`GDPRREQUEST` raises `remote_archived` (the update itself is harmless), and a mapped contact or item that Xero answers `404` for raises `not_found` + `remote_missing`, which the core turns into a terminal "unlink and map it again" (quorum findings 4 and 6).
5. **Duplicate names are classified from the full, untruncated message list, and still trigger one adoption look.** `xeroFaultMessage` truncates to 200 characters and returns only the first message, and a contact name can be 255 characters, so matching its output could lose the suffix. Task 2 classifies over **all** `Elements[].ValidationErrors[].Message` values, untruncated. Patterns (all anchored at the start; the first is verified in Xero's OpenAPI 400 examples and in `XeroAPI/xero-command-line`, the other two are lab items **X18–X20**): `The contact name … is already assigned to another contact` → `duplicate_name`; `The contact number … is already assigned to another contact` → `duplicate_key`; `Price List Item with Code … already exists` or `Item code … already exists` → `duplicate_key`. `duplicate_key` never reaches the core from a contact create: the provider answers it with an adoption lookup. A `duplicate_name` also gets one `ContactNumber` look before it is surfaced: a previous uncertain create of ours owns both the name and the number, and Xero may report the name first (quorum finding 5). Only when that look misses is `duplicate_name` surfaced (an archived hit surfaces `remote_archived`).
6. **Item codes end in a hash of the catalog item id; a SKU is never an adoption key.** Items have no external-id field and no archive; `Code` (≤30, unique) is the only key. The spec's "catalog SKU if it fits, else slug + 6-char hash; on collision adopt if ours" is replaced, because the quorum showed two ways it duplicates or overwrites (findings 2 and 3): a SKU hit cannot prove it is ours (adopting it can overwrite an MSP's own item, or an item another Breeze item already maps to), and a code derived from the mutable name/SKU changes after a rename, so a lost-response retry looks under a new code and creates a second item. The rule is `Code = prefix + '-' + h`, where `h = sha256(catalogItemId)` hex `[0..10]` (40 bits) and `prefix = slug(sku || name)` truncated to 19 characters (`fw-100-3fa9c1b2d4`, still readable in Xero). The adoption lookup reads the whole price list (`GET Items` is one unpaged call) and matches any `Code` ending in `-<h>`, case-insensitively — so it survives renames and SKU edits. Exactly one hit → adopt (update, keeping its code); more than one → `validation` + `duplicate_key`, surfaced (never guess). An MSP's pre-existing item with the same SKU is **never** auto-adopted: the workbench already offers it as an `exact_sku` suggestion for explicit linking. Collision odds within one tenant are about n²/2⁴¹ (200 items ≈ 2·10⁻⁸; 5,000 ≈ 10⁻⁵).
7. **An item update reads the item first.** Whether `POST /Items/{ItemID}` requires `Code` is unverified. The update path does `GET Items/{ItemID}` (which also proves the item still exists — a 404 is `remote_missing`) and posts back the item's own `Code`, never a new one — a linked item keeps the code its owner chose. Lab **X22**.
8. **`IsPurchased: false` is sent on create only.** Setting it false nulls `PurchaseDescription`/`PurchaseDetails`; a linked item the MSP also buys must not lose its purchase side on update.
9. **Only creates carry an `Idempotency-Key`, derived from the request itself.** Xero stores a key for 6 minutes, scopes keys per app (not per tenant) and rejects a reused key whose URL, body or method differ. `xeroApiWrite` sends `Idempotency-Key: breeze-` + `sha256(tenantId, method, path, body)` hex (71 chars, under Xero's 128) on **`PUT` (create) only**. An update (`POST` with the full field set) is naturally idempotent, and keying it would be wrong: an A → B → A edit inside 6 minutes would replay A's first cached response and leave B in Xero while Breeze records success (quorum finding 1). A create body contains the adoption key (`ContactNumber` or the hashed `Code`), so one org or catalog item maps to one create request, and an identical retry replays the first result. W04 may pass an explicit key (the helper accepts one). The key only protects fast retries; adoption is the real guard. **Known limitation:** Xero caches and replays an internal error under the same key, and the sync job's 5 attempts (exponential from 5 s, about 75 s in total) all fall inside one 6-minute window, so a genuine Xero 5xx on a create fails every attempt; the row reads `error`, and the next **Sync now** after 6 minutes succeeds (the sweep does not retry `error` rows). Lab **X23** records it.
10. **Remote version is the ISO form of `UpdatedDateUTC`.** Xero returns `/Date(1503348544227+0000)/` (or without the offset). `parseXeroDate` converts it to an ISO-8601 string (24 chars; `remote_sync_token` is `varchar(64)`). Xero has no optimistic-concurrency token, so there is no stale-version retry.
11. **`supplierOnly` is a per-row flag and the web hides those rows.** Xero sets `IsCustomer`/`IsSupplier` only after the first sales invoice/bill, so a brand-new contact has neither flag and must stay visible. `RemoteCustomer` gains an optional `supplierOnly` (`IsSupplier && !IsCustomer`). The import route's response shape is unchanged; the panel hides flagged rows behind "Show all contacts (N hidden)". QuickBooks never sets the flag. Paged Contacts responses carry `IsCustomer`/`IsSupplier` (`summaryOnly` drops them, so W03 never sends `summaryOnly`).
12. **Import listing defers below 20% of the daily budget.** The spec lists "import paging" among the background work that defers when `X-DayLimit-Remaining` is under 20%. The import list and the import commit both call `shouldDeferBackgroundWork` before listing and answer 429 `daily_budget_low` (no `Retry-After`: Xero's day window is per-tenant and not UTC-midnight). QuickBooks declares `dailyPerConnection: null`, so the ratio is null and it never defers. The check is not repeated between pages (quorum finding 8, adopted as a documented bound rather than an interface change): one listing costs `ceil(contacts / 1000)` calls — 10 for a 10k-contact organisation, 1% of the Starter budget — so the overshoot past 20% is bounded by one listing. A paging hook on the neutral `listRemoteCustomers` signature is not worth the interface churn for that bound; revisit if lab X27 or production shows otherwise.
13. **A throttled import now answers 429, not 502/500 — this changes QuickBooks too.** Today every import-listing failure, a throttle included, is a 502 `provider_error`, and a throttle during the token refresh escapes as an HTTP 500. W03 maps both to 429 `rate_limited` with `Retry-After`, exactly as the mapping routes already do (quorum finding 11). Intended; list it in the W03a PR body. Requestids and payloads are untouched.
14. **The `[qb-import]` Sentry prefix becomes `[accounting-import:<provider>]`** (W01d ruling R13 parked it "until a later wave"). QuickBooks events get `[accounting-import:quickbooks]`. `grep -rn "qb-import"` finds no alert rule, dashboard or test that keys on it (Task 0 re-checks). Telemetry-only; list it in the PR body.
15. **Confirming a link reads one record, not the whole contact book.** `saveMappingDecision('confirmed')` lists every remote customer to find one id — 10 pages for a 10k-contact Xero org against a 1,000/day budget. `AccountingProvider` gains two **optional** lookups, `getRemoteCustomer?` / `getRemoteItem?`; the service uses them when present and keeps the list-and-find path otherwise (QuickBooks declares neither, so its behaviour is unchanged).
16. **Operator messages are labelled by provider.** About 15 strings in `accountingMappingService.ts` still say "QuickBooks" (W01d deferral R3). Every one reachable by Xero is rebuilt from `accountingProviderDisplayName(conn.provider)`; the QuickBooks text stays byte-identical (the existing assertions pin it).
17. **For a provider with a settings step, the income account lives there.** Settings rule 1 ("one concept, one home"): W02c made `AccountingSettingsStep` the Xero home of `defaultIncomeAccountRef`. The workbench's income-account picker is therefore hidden when `status.features.settingsOptions` is true, and its "create gated" hint points at the settings step. QuickBooks keeps its single home in the workbench.
18. **Export/erasure/RLS registries: nothing to add.** No table, no column, no migration. Mapping rows keep `remote_entity_type` `Customer`/`Item` (spec D6); import links use `organization_external_links.system = 'xero'` (free-form, unique on `(partner_id, system, external_id)`). If an executor finds a column is needed after all, the migration must sort after the newest committed file (re-check with the command in Global Constraints) and the plan must be amended first.

19. **Contact paging follows Xero's `pageCount`; it never truncates silently.** Xero's 100k figure limits a single response or unoptimised query, not a tenant's size (quorum finding 9). The loop reads until `page >= pagination.pageCount` (or a short page when `pagination` is absent), with a runaway guard of 1,000 pages that throws `transient` ("pagination did not terminate") instead of returning a partial list.
20. **User-resolvable refusals are terminal and silent.** `duplicate_name`, `remote_archived`, `remote_missing` and `provider_permission` join the sync worker's terminal set **and** a new `MAPPING_USER_RESOLVABLE_CODES` set for which the worker skips its Sentry capture (quorum finding 12). The existing terminal codes keep their capture, so QuickBooks telemetry is unchanged.
21. **Provider labels are threaded, not guessed.** The label variable is named `providerLabel` everywhere (the service already uses `label` for the entity noun, `accountingMappingService.ts:1142`), and the helpers that build operator messages without a connection in scope — `upsertMappingRow`, `resolveItemSellPrice`, `persistRemoteRef` — gain a `providerLabel: string` parameter (quorum finding 13).

## Global Constraints

- Xero's capabilities after W03 are exactly `{ connect: true, mapping: true, customerImport: true, invoicePush: false, paymentPull: false, paymentPush: false }`, flipped **only** in Task 10 (W03b). Through W03a they stay `connect`-only.
- **QuickBooks is byte-identical.** `git diff origin/main -- apps/api/src/services/accounting/quickbooks*.ts` is empty at the end of every PR. `buildCustomerPayload`, `buildItemPayload` and every QuickBooks requestid stay untouched; `quickbooksIdempotency.test.ts`, `quickbooksProvider*.test.ts` and every QuickBooks message assertion in `accountingMappingService.test.ts` pass **without edits**. The only intended QuickBooks-visible changes are refinements 13 and 14.
- Contact adoption key: `ContactNumber = 'breeze:' + organizationId`, written on create only. Item adoption key: the `-<h>` suffix of the item `Code`, `h = sha256(catalogItemId)[0..10]` (refinement 6). A SKU is never an adoption key.
- `Idempotency-Key` on creates (`PUT`) only (refinement 9).
- Adoption lookup runs before every create **and** after every uncertain outcome (`transient`, `duplicate_key`, and — for contacts — `duplicate_name`). A hit is adopted (then updated), never re-created. A `duplicate_name` is never retried as a create.
- Every tenant-scoped write goes through `xeroApiWrite` (slot, day-remaining note, error translation, `Idempotency-Key`). No Xero module calls `fetch` directly except `xeroHttp.ts`.
- Paging: Contacts `page` + `pageSize=1000`, stop when `page >= pagination.pageCount` or a page returns fewer than 1000 rows; a runaway guard at 1,000 pages throws, never truncates (refinement 19). Items are not paged.
- `unitdp=4` on every Items read and write (unit prices keep 4 decimals).
- The neutral-core guard stays green. New Xero wire logic lives only in `xeroHttp.ts`, `xeroContacts.ts`, `xeroItems.ts`, `xeroProvider.ts`. No core file gains a `'quickbooks'` or `'xero'` literal.
- No new tables, columns, migrations, env vars, Sentry tags or `SELF_MANAGED_DB_CONTEXT_ROUTES` entries. Migration rule if one ever becomes necessary: its filename sorts after `git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep '^20' | sort | tail -1` (the newest on 2026-09-27 is `2026-11-05-101500-command-requester-active-resolver.sql`; W02a adds `2026-11-05-120000-accounting-connections-xero-columns.sql`).
- `routes/accounting/index.ts` must not grow: `wc -l` at the end of each PR ≤ its Task 0 count. Error-response helpers move to `routes/accounting/errorResponses.ts` (Task 5).
- Every provider HTTP call runs with no held DB context (the existing `resolveConnectionAndToken` / `runOutsideDbContext` pattern).
- Web: every mutation goes through `runAction`. Every QuickBooks `data-testid` and English string stays byte-identical. New i18n keys land in all 8 locales (`de-DE en es-419 fr-CA fr-FR it-IT pt-BR tr-TR`).
- Tests: one file with `cd apps/api && npx vitest run <path>` (never `pnpm … test -- --run`). Integration: `pnpm test-stack up`, `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`, `pnpm test-stack down`.
- Every PR runs, before opening: the full API unit suite, `npx tsc --noEmit -p apps/api`, the accounting integration set (W01/W02 plan lists plus the W03 file), `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`; W03b also runs `cd apps/web && npx vitest run` and `npx astro check` in `apps/web`.

## Review Focus

The failure modes most likely to bite a real partner that no single task tests by itself, most likely first. Each has a pinned test in the task that owns the code.

1. **A contact create whose response is lost (timeout, 5xx) and is retried minutes later.** Expected: exactly one Xero contact. The retry's adoption lookup finds `ContactNumber = breeze:<orgId>` and adopts it; a replay inside 6 minutes carries the same `Idempotency-Key`. *(Task 3 "adopts after a timed-out create"; Task 2 "identical requests carry identical keys".)*
2. **An organisation whose name is already used by a different, unlinked Xero contact.** Expected: no create, no retry; the mapping row reads `error` with "Xero already has a customer named "Acme" — link this organization to it instead"; the route answers 409 `duplicate_name` with `details.remoteName`; the sync worker treats it as terminal; the workbench offers **Link it**. *(Task 2 classification; Task 5 service + worker; Task 8 UI.)*
3. **A catalog item whose SKU matches an item the MSP already has in Xero, or that is renamed between a lost create and its retry.** Expected: the MSP's item is **never** adopted or overwritten (it stays available as an `exact_sku` suggestion for explicit linking); Breeze creates its own item under `prefix-<h>`; a retry after a rename or SKU edit finds that item by its `-<h>` suffix and adopts it — exactly one Xero item per catalog item. *(Task 4 "never adopts an MSP item that only shares the SKU" / "a retry after a rename adopts by suffix" / "two suffix hits are refused".)*
4. **Archived and GDPR-erased contacts.** Expected: `GDPRREQUEST` contacts never appear in suggestions, candidates or import; archived contacts appear with an "Archived" badge and are never auto-suggested; adopting our own archived contact refuses with `remote_archived` instead of linking an unusable contact. *(Task 3 listing + adoption; Task 5 service; Tasks 8–9 badges.)*
5. **Item writes refused for a missing scope.** Expected: a 401/403 carrying `insufficient_scope` becomes a terminal 409 `provider_permission` ("Reconnect Xero and approve every requested permission") from the sync route, the remote-candidates route and the import routes alike; the worker neither retries it nor reports it to Sentry. *(Task 2 classification; Task 5 service + route + worker; Task 6 import; lab X16.)*

---

## PR split

| PR | Branch | Tasks | What ships | Stands alone because |
|---|---|---|---|---|
| **W03a** Server | `feature/7167-xero/wave-7170-a-server` | 0–7 (8 tasks) | neutral validation codes + optional lookups + `supplierOnly`; `xeroApiWrite` + query builder + classification; `xeroContacts.ts`; `xeroItems.ts`; provider methods; mapping-service refusals + labels; import throttle/permission/budget; error-response extraction | Xero's capabilities stay `connect`-only, so no route (`providerGateResponse`), producer, sweep (`providerSupports`) or UI (`caps.mapping`) reaches the new methods. QuickBooks sees only refinements 13 and 14. |
| **W03b** Web, flip, lab | `feature/7167-xero/wave-7170-b-web` | 8–11 (4 tasks) | workbench income-account home, archived badges, duplicate-name link flow, import supplier toggle, readiness link; capability flip + registry test + real-DB proof; lab section 3 | The server contract is complete and proven; the flip is gated on lab X16. |

Merge order a → b. Each targets `main`; W03b is rebased after W03a merges. **Do not stack** (a stacked PR runs no CI).

**W03b PR body must carry the settings-rule-9 statement** (it changes where the Xero income account is edited):
- **Home:** Integrations → Accounting → Xero → settings step (unchanged from W02c).
- **Level:** partner (the connection row).
- **Resolver:** the connection row (`defaultIncomeAccountRef`).
- **Count:** the Xero income account goes from **2 → 1** place (W02c's settings step **and** the workbench picker → the settings step only). QuickBooks stays at 1 (the workbench).

---

## File structure

**Created**

| File | Responsibility | PR |
|---|---|---|
| `apps/api/src/services/accounting/xeroContacts.ts` (+ `.test.ts`) | Contact wire mapping (Xero ↔ `RemoteCustomer`), paged listing, single read, adoption lookup, create/update with adoption | a |
| `apps/api/src/services/accounting/xeroItems.ts` (+ `.test.ts`) | Item code derivation, wire mapping, listing, single read, adoption, create/update, income accounts | a |
| `apps/api/src/routes/accounting/errorResponses.ts` (+ `.test.ts`) | `setRetryAfter`, `handleImportError`, `handleMappingError` moved out of `index.ts`, plus `details`/429 support | a |
| `apps/api/src/__tests__/integration/accountingXeroMapping.integration.test.ts` | Real-DB proof: Xero import → org + `system='xero'` link; proposal backfill `Customer` row; create-new sync with adoption | b |

**Modified:** see each task's **Files** block.

---

## Task 0: Baseline and interface re-verification (every PR starts here)

**Files:** none.

- [ ] **Step 1: Confirm the branch and preconditions**

```bash
cd <worktree>
git fetch origin main && git status -sb
git log origin/main --oneline | grep -iE 'xero w0[12]|#716[89]' | head -20
```

Expected: a clean tree on the W03 branch, based on current `origin/main`; W01 (4 PRs) and W02a + W02b (and, for W03b, W02c) listed.

- [ ] **Step 2: Re-verify every assumption (M1–C2)**

```bash
cd apps/api/src
grep -n "listRemoteCustomers\|listRemoteItems\|listRemoteIncomeAccounts\|upsertCustomer\|upsertItem\|getRemoteCustomer\|interface RemoteCustomer\|interface RemoteItem\|interface AccountingItemPayload" services/accounting/types.ts
grep -n "export type AccountingProviderErrorKind" -A3 services/accounting/accountingProviderError.ts
grep -n "export type AccountingMappingErrorCode" -A20 services/accounting/accountingMappingService.ts | grep -n "capability_unavailable\|rate_limited"
grep -n "async function callProviderOrThrow\|function sanitizeSyncErrorMessage\|if (err instanceof AccountingMappingError) throw err" services/accounting/accountingMappingService.ts
grep -n "QuickBooks" services/accounting/accountingMappingService.ts | grep -v "^\s*[0-9]*:\s*//\|\*" 
grep -n "MAPPING_TERMINAL_CODES" -A4 jobs/accountingSyncWorker.ts
grep -n "terminal mapping failure, not retrying" -B2 -A6 jobs/accountingSyncWorker.ts
grep -n "async function upsertMappingRow\|async function resolveItemSellPrice\|async function persistRemoteRef\|const label = " services/accounting/accountingMappingService.ts
grep -n "beforeEach\|TRUNCATE\|truncate" __tests__/integration/setup.ts | head
grep -n "qb-import\|class AccountingImportError\|AccountingImportErrorStatus" services/accounting/accountingCustomerImport.ts
grep -rn "qb-import" ../../ ../../../../docs ../../../../.github 2>/dev/null | grep -v node_modules
grep -n "function handleImportError\|function handleMappingError\|function setRetryAfter\|'/:provider/remote-candidates'" routes/accounting/index.ts
grep -n "export async function xeroApiGet\|export interface XeroCallContext\|export function xeroApiError\|export function xeroFaultMessage\|async function xeroRoundTrip\|function providerError\|interface XeroRawError" services/accounting/xeroHttp.ts
grep -n "function requireBody\|function asArray\|function normalizeCurrency\|function callContext\|notYet('contact\|notYet('item\|notYet('income" services/accounting/xeroProvider.ts
grep -n "xero: xeroProvider" services/accounting/providerRegistry.ts
grep -n "features" routes/accounting/*.ts | head
cd ../../web/src
grep -n "interface RemoteCandidate\|function handleSyncFailure\|const createGated\|defaultIncomeAccountRef: string | null" components/integrations/AccountingMappingWorkbench.tsx
grep -n "caps.mapping\|caps.customerImport\|features?.settingsOptions\|<AccountingMappingWorkbench" components/integrations/AccountingConnectionPanel.tsx
grep -n "xero:" lib/orgReadiness.ts
ls ../../../docs/integrations/xero-demo-verification.md && grep -n "^## \|X15" ../../../docs/integrations/xero-demo-verification.md
```

Expected: every symbol found. The `grep -rn qb-import` lists only `accountingCustomerImport.ts` (refinement 14). The `QuickBooks` grep lists the ~15 operator strings Task 5 labels (write the list into the PR body). For each difference, note it in the PR body and adapt the task that uses it.

- [ ] **Step 3: Record the baseline**

```bash
cd apps/api && npx vitest run src/services/accounting src/jobs/accountingSyncWorker.test.ts src/routes/accounting 2>&1 | tail -4
wc -l src/routes/accounting/index.ts src/services/accounting/xeroProvider.ts
```

Expected: all pass. Write down the `Test Files` count and both line counts. `index.ts` must never exceed its count.

---

# PR W03a — Server (Xero capabilities stay `connect`-only)

### Task 1: Neutral refusal codes, optional single-record lookups, `supplierOnly`

**Files:**
- Modify: `apps/api/src/services/accounting/accountingProviderError.ts` (append after `providerErrorKindOf`)
- Modify: `apps/api/src/services/accounting/types.ts` (`RemoteCustomer`, `AccountingProvider`)
- Test: `accountingProviderError.test.ts`, `types.test.ts`

**Interfaces:**
- Consumes: M1–M3.
- Produces (`accountingProviderError.ts`):
  ```ts
  export const ACCOUNTING_REFUSAL_CODES = ['duplicate_name', 'duplicate_key', 'remote_archived', 'remote_missing', 'insufficient_scope'] as const;
  export type AccountingRefusalCode = typeof ACCOUNTING_REFUSAL_CODES[number];
  /** The code when `err` is a provider error of kind `validation` or `not_found` carrying one; else null. */
  export function refusalCodeOf(err: unknown): AccountingRefusalCode | null;
  ```
- Produces (`types.ts`):
  ```ts
  // RemoteCustomer gains:
  /** True when the provider knows this contact only as a supplier (Xero: IsSupplier && !IsCustomer). Never set by QuickBooks. */
  supplierOnly?: boolean;
  // AccountingProvider gains (both OPTIONAL; QuickBooks declares neither):
  /** One remote customer by id, or null when it does not exist. Lets a link confirm read one record instead of the whole list. */
  getRemoteCustomer?(conn: AccountingConnection, id: string): Promise<RemoteCustomer | null>;
  getRemoteItem?(conn: AccountingConnection, id: string): Promise<RemoteItem | null>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `accountingProviderError.test.ts`:

```ts
import { ACCOUNTING_REFUSAL_CODES, refusalCodeOf } from './accountingProviderError';

describe('refusalCodeOf (Xero W03)', () => {
  const err = (kind: 'validation' | 'not_found' | 'transient' | 'rate_limited', providerCode?: string) =>
    new AccountingProviderError({ kind, provider: 'xero', operation: 'op', providerCode });

  it.each(ACCOUNTING_REFUSAL_CODES)('returns %s for a validation error carrying it', (code) => {
    expect(refusalCodeOf(err('validation', code))).toBe(code);
  });
  it('returns remote_missing for a not_found error carrying it', () => {
    expect(refusalCodeOf(err('not_found', 'remote_missing'))).toBe('remote_missing');
  });
  it('ignores a bare not_found (a QuickBooks 610 carries its own fault code)', () => {
    expect(refusalCodeOf(err('not_found', '610'))).toBeNull();
    expect(refusalCodeOf(err('not_found'))).toBeNull();
  });
  it('ignores a provider fault code that is not a neutral validation code (e.g. a QuickBooks 6240)', () => {
    expect(refusalCodeOf(err('validation', '6240'))).toBeNull();
  });
  it('ignores the code on any non-validation kind (a 429 carries X-Rate-Limit-Problem in providerCode)', () => {
    expect(refusalCodeOf(err('rate_limited', 'minute'))).toBeNull();
    expect(refusalCodeOf(err('transient', 'duplicate_name'))).toBeNull();
  });
  it('returns null for a non-provider error', () => {
    expect(refusalCodeOf(new Error('duplicate_name'))).toBeNull();
    expect(refusalCodeOf(null)).toBeNull();
  });
});
```

Append to `types.test.ts`:

```ts
describe('single-record lookups and supplierOnly (Xero W03)', () => {
  it('declares the optional lookups', () => {
    expectTypeOf<AccountingProvider['getRemoteCustomer']>()
      .toEqualTypeOf<((conn: AccountingConnection, id: string) => Promise<RemoteCustomer | null>) | undefined>();
    expectTypeOf<AccountingProvider['getRemoteItem']>()
      .toEqualTypeOf<((conn: AccountingConnection, id: string) => Promise<RemoteItem | null>) | undefined>();
  });
  it('declares supplierOnly as an optional boolean', () => {
    expectTypeOf<RemoteCustomer['supplierOnly']>().toEqualTypeOf<boolean | undefined>();
  });
});
```

(`types.test.ts` imports neither `RemoteCustomer` nor `RemoteItem` today — add both to its `./types` import.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingProviderError.test.ts && npx tsc --noEmit -p .`
Expected: FAIL — vitest: `refusalCodeOf` is not exported; tsc: the new `expectTypeOf` assertions in `types.test.ts` fail. (Vitest does not typecheck `expectTypeOf` at runtime, so tsc is the red for the type pins.)

- [ ] **Step 3: Implement**

Append to `accountingProviderError.ts`:

```ts
/**
 * Structured refusals a provider may attach as `providerCode` on a `kind:
 * 'validation'` (or, for remote_missing, `kind: 'not_found'`) error (Xero W03).
 * The core branches on these, never on a provider's own fault numbers or text:
 *  - duplicate_name     — the remote system refuses a second record with this name
 *                         (Xero: unique contact names). Surfaced; never auto-retried.
 *  - duplicate_key      — the provider's adoption key is already taken. The provider
 *                         answers it with an adoption lookup; it should not reach core.
 *  - remote_archived    — the record Breeze would adopt, or is mapped to, is archived.
 *  - remote_missing     — the MAPPED remote record no longer exists (kind not_found).
 *                         A bare not_found without this code keeps its old meaning.
 *  - insufficient_scope — the grant does not cover this call; reconnecting (or a
 *                         scope change) is the only fix. Surfaced; never retried.
 */
export const ACCOUNTING_REFUSAL_CODES = ['duplicate_name', 'duplicate_key', 'remote_archived', 'remote_missing', 'insufficient_scope'] as const;
export type AccountingRefusalCode = typeof ACCOUNTING_REFUSAL_CODES[number];

export function refusalCodeOf(err: unknown): AccountingRefusalCode | null {
  if (!isAccountingProviderError(err) || (err.kind !== 'validation' && err.kind !== 'not_found')) return null;
  const code = err.providerCode;
  return (ACCOUNTING_REFUSAL_CODES as readonly string[]).includes(code ?? '') ? (code as AccountingRefusalCode) : null;
}
```

In `types.ts`, add `supplierOnly?: boolean;` (with the doc comment above) to `RemoteCustomer` after `currencyCode`, and add the two optional members to `AccountingProvider` directly after `listRemoteIncomeAccounts`.

- [ ] **Step 4: Run to verify they pass, then typecheck**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingProviderError.test.ts src/services/accounting/types.test.ts && npx tsc --noEmit -p .`
Expected: PASS; tsc clean (both members are optional, so `QuickbooksProvider` and `XeroProvider` still satisfy the interface).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/accountingProviderError.ts apps/api/src/services/accounting/accountingProviderError.test.ts apps/api/src/services/accounting/types.ts apps/api/src/services/accounting/types.test.ts
git commit -m "feat(accounting): neutral refusal codes, optional single-record lookups, supplierOnly (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `xeroHttp.ts`: query builder, write helper with `Idempotency-Key`, validation classification, dates

**Files:**
- Modify: `apps/api/src/services/accounting/xeroHttp.ts`
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (import `requireXeroBody`/`xeroArray` instead of its private copies)
- Test: `apps/api/src/services/accounting/xeroHttp.test.ts`

**Interfaces:**
- Consumes: A1–A3, Task 1 (`AccountingRefusalCode`).
- Produces (`xeroHttp.ts`):
  ```ts
  export function xeroQuery(params: Record<string, string | number | boolean | undefined>): string; // '' or '?a=1&b=x%20y'
  export function xeroIdempotencyKey(tenantId: string, method: string, path: string, body: string): string; // 'breeze-' + 64 hex
  // Idempotency-Key only on PUT (create) unless an explicit key is passed (refinement 9):
  export async function xeroApiWrite<T>(ctx: XeroCallContext, method: 'PUT' | 'POST', path: string, body: unknown, operation: string, opts?: { idempotencyKey?: string }): Promise<T>;
  export function classifyXeroValidation(text: string): AccountingRefusalCode | undefined;
  export function parseXeroDate(value: unknown): string | null; // ISO-8601 or null
  export function requireXeroBody<T extends object>(body: T | null, operation: string): T;   // moved from xeroProvider
  export function xeroArray<T>(value: unknown): T[];                                         // moved from xeroProvider (was asArray)
  ```
- Changes: `xeroApiError` sets `providerCode` from `classifyXeroValidation` on 400s, and classifies `401/403` + `WWW-Authenticate: …insuff(i)cient_scope…` as `validation` + `insufficient_scope`. `xeroApiGet` keeps its signature and delegates to a private `xeroApiCall`.

- [ ] **Step 1: Write the failing tests**

Append to `xeroHttp.test.ts` (reuse the file's `slotMock`, `noteMock`, `SPEC`, `json` helpers and its `beforeEach`/`afterEach`):

```ts
// Add these names to the file's EXISTING `import { … } from './xeroHttp'` at the top (it already
// imports xeroApiGet — a second import of it is a duplicate declaration and the file will not compile):
//   classifyXeroValidation, parseXeroDate, xeroApiWrite, xeroIdempotencyKey, xeroQuery

describe('xeroQuery (Xero W03)', () => {
  it('encodes values and drops undefined', () => {
    expect(xeroQuery({ page: 2, pageSize: 1000, includeArchived: true, searchTerm: 'a b&c', skip: undefined }))
      .toBe('?page=2&pageSize=1000&includeArchived=true&searchTerm=a%20b%26c');
  });
  it('encodes a where clause with quotes and a colon', () => {
    expect(xeroQuery({ where: 'ContactNumber=="breeze:0f0e"' })).toBe('?where=ContactNumber%3D%3D%22breeze%3A0f0e%22');
  });
  it('returns an empty string for no params', () => {
    expect(xeroQuery({})).toBe('');
  });
});

describe('xeroIdempotencyKey (Xero W03)', () => {
  it('is deterministic and within Xero\'s 128-char limit', () => {
    const a = xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', '{"Contacts":[{"Name":"Acme"}]}');
    expect(a).toBe(xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', '{"Contacts":[{"Name":"Acme"}]}'));
    expect(a).toMatch(/^breeze-[0-9a-f]{64}$/);
  });
  it.each<[string, string, string, string, string]>([
    ['tenant', 'ten-B', 'PUT', 'Contacts', '{}'],
    ['method', 'ten-A', 'POST', 'Contacts', '{}'],
    ['path', 'ten-A', 'PUT', 'Items', '{}'],
    ['body', 'ten-A', 'PUT', 'Contacts', '{"x":1}'],
  ])('changes when the %s changes', (_label, tenant, method, path, body) => {
    expect(xeroIdempotencyKey(tenant, method, path, body)).not.toBe(xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', '{}'));
  });
});

describe('xeroApiWrite (Xero W03)', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };

  it('sends JSON through the slot with tenant, auth and a request-derived Idempotency-Key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [{ ContactID: 'x' }] }, 200, { 'x-daylimit-remaining': '900' }));
    const body = { Contacts: [{ Name: 'Acme' }] };
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', body, 'Xero contact create')).resolves.toEqual({ Contacts: [{ ContactID: 'x' }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Contacts');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(JSON.stringify(body));
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer at', 'xero-tenant-id': 'ten-A', Accept: 'application/json', 'Content-Type': 'application/json',
      'Idempotency-Key': xeroIdempotencyKey('ten-A', 'PUT', 'Contacts', JSON.stringify(body)),
    });
    expect(slotMock).toHaveBeenCalledWith('xero', SPEC, 'c1', expect.any(Function));
    expect(noteMock).toHaveBeenCalledWith('xero', 'c1', 900);
  });

  it('identical requests carry identical keys (a replay inside 6 minutes is deduplicated by Xero)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    const body = { Contacts: [{ Name: 'Acme', ContactNumber: 'breeze:o1' }] };
    await xeroApiWrite(ctx, 'PUT', 'Contacts', body, 'op');
    await xeroApiWrite(ctx, 'PUT', 'Contacts', body, 'op');
    const keyOf = (i: number) => ((fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key'];
    expect(keyOf(0)).toBe(keyOf(1));
  });

  it('a POST update carries no key, so an A → B → A edit inside 6 minutes is never replayed (quorum 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    await xeroApiWrite(ctx, 'POST', 'Contacts/xc-1', { Contacts: [{ ContactID: 'xc-1', Name: 'A' }] }, 'op');
    await xeroApiWrite(ctx, 'POST', 'Contacts/xc-1', { Contacts: [{ ContactID: 'xc-1', Name: 'A' }] }, 'op');
    for (const i of [0, 1]) {
      const headers = (fetchMock.mock.calls[i] as [string, RequestInit])[1].headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Idempotency-Key');
      expect(headers['Content-Type']).toBe('application/json');
    }
  });

  it('uses an explicit key when one is given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}));
    await xeroApiWrite(ctx, 'POST', 'Items', {}, 'op', { idempotencyKey: 'breeze-explicit' });
    expect(((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key']).toBe('breeze-explicit');
  });

  it('translates a duplicate-name 400 to validation + duplicate_name, with the full message kept out of the thrown message', async () => {
    const longName = 'A'.repeat(240);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({
      ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred',
      Elements: [{ ValidationErrors: [{ Message: `The contact name ${longName} is already assigned to another contact. The contact name must be unique across all active contacts.` }] }],
    }, 400));
    const err = await xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'Xero contact create').catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'validation', provider: 'xero', providerCode: 'duplicate_name', httpStatus: 400 });
    expect((err as Error).message).toBe('Xero contact create failed with 400');
  });

  it.each(['insufficent_scope', 'insufficient_scope'])('classifies a 401/403 whose WWW-Authenticate names %s as validation + insufficient_scope', async (spelling) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 401, headers: { 'www-authenticate': `Bearer error="${spelling}"` } }))
      .mockResolvedValueOnce(new Response('', { status: 403, headers: { 'www-authenticate': `Bearer error="${spelling}"` } }));
    await expect(xeroApiWrite(ctx, 'PUT', 'Items', {}, 'Xero item create')).rejects.toMatchObject({ kind: 'validation', providerCode: 'insufficient_scope', httpStatus: 401 });
    await expect(xeroApiWrite(ctx, 'PUT', 'Items', {}, 'Xero item create')).rejects.toMatchObject({ kind: 'validation', providerCode: 'insufficient_scope', httpStatus: 403 });
  });

  it('keeps a bare 401 transient (link removed) — unchanged W02 behaviour', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 401 }));
    await expect(xeroApiWrite(ctx, 'PUT', 'Items', {}, 'op')).rejects.toMatchObject({ kind: 'transient', providerCode: undefined });
  });

  it('propagates a limiter refusal untouched', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'op')).rejects.toBe(refusal);
  });

  it('a timeout is a Xero-attributed transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('t', 'TimeoutError'));
    await expect(xeroApiWrite(ctx, 'PUT', 'Contacts', {}, 'Xero contact create')).rejects.toMatchObject({ kind: 'transient', message: 'Xero contact create timed out' });
  });

  it('xeroApiGet still sends no body, no Content-Type and no Idempotency-Key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Items: [] }));
    await xeroApiGet(ctx, 'Items?unitdp=4', 'op');
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
    expect(init.headers).not.toHaveProperty('Content-Type');
  });
});

describe('classifyXeroValidation (Xero W03)', () => {
  const body = (...messages: string[]) => JSON.stringify({ Elements: [{ ValidationErrors: messages.map((Message) => ({ Message })) }] });
  it.each([
    ['The contact name Acme is already assigned to another contact. The contact name must be unique across all active contacts.', 'duplicate_name'],
    ['The contact number breeze:o1 is already assigned to another contact. The contact number must be unique across all contacts.', 'duplicate_key'],
    ["Price List Item with Code 'abc' already exists", 'duplicate_key'],
    ["Item code 'abc' already exists", 'duplicate_key'],
    ['Account code is invalid', undefined],
  ] as const)('%s → %s', (message, expected) => {
    expect(classifyXeroValidation(body(message))).toBe(expected);
  });
  it('finds the verdict in any element, not only the first message', () => {
    expect(classifyXeroValidation(body('Email address must be valid.', 'The contact name Acme is already assigned to another contact.'))).toBe('duplicate_name');
  });
  it('returns undefined for a non-JSON or empty body', () => {
    expect(classifyXeroValidation('<html>')).toBeUndefined();
    expect(classifyXeroValidation('')).toBeUndefined();
  });
});

describe('parseXeroDate (Xero W03)', () => {
  it.each([
    ['/Date(1503348544227+0000)/', '2017-08-21T20:49:04.227Z'],
    ['/Date(1573755038314)/', '2019-11-14T18:10:38.314Z'],
    ['/Date(1503348544227-0800)/', '2017-08-21T20:49:04.227Z'],
    ['2026-09-27T10:00:00', '2026-09-27T10:00:00.000Z'],
  ])('%s → %s', (input, expected) => {
    expect(parseXeroDate(input)).toBe(expected);
  });
  it.each([[undefined], [null], [''], ['/Date(abc)/'], [42]])('returns null for %s', (input) => {
    expect(parseXeroDate(input)).toBeNull();
  });
});
```

(The `-0800` case pins that the millisecond epoch is the instant; the offset is only display information in Microsoft JSON dates.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement**

In `xeroHttp.ts`:

1. Add `import { createHash } from 'node:crypto';` and extend the error import with `type AccountingRefusalCode`.
2. Move `requireBody` and `asArray` from `xeroProvider.ts` into `xeroHttp.ts`, exported as `requireXeroBody` and `xeroArray` (bodies unchanged, `provider: 'xero'` kept). In `xeroProvider.ts` delete the private copies and import the two names; rename call sites (`requireBody(` → `requireXeroBody(`, `asArray<` → `xeroArray<`).
3. Add after `xeroFaultMessage`:

```ts
function allValidationMessages(text: string): string[] {
  try {
    const body = JSON.parse(text) as XeroRawError | null;
    if (!body || typeof body !== 'object') return [];
    return (body.Elements ?? [])
      .flatMap((e) => e?.ValidationErrors ?? [])
      .map((v) => v?.Message)
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
  } catch {
    return [];
  }
}

/**
 * Structured verdict for a Xero 400 (refinement 5). Runs over EVERY validation
 * message, untruncated — `xeroFaultMessage` keeps only the first, cut at 200
 * chars, and a contact name alone may be 255.
 */
export function classifyXeroValidation(text: string): AccountingRefusalCode | undefined {
  for (const message of allValidationMessages(text)) {
    if (/^The contact name .+ is already assigned to another contact/is.test(message)) return 'duplicate_name';
    if (/^The contact number .+ is already assigned to another contact/is.test(message)) return 'duplicate_key';
    if (/^(Price List Item|Item code) .+ already exists/is.test(message)) return 'duplicate_key';
  }
  return undefined;
}

/** Matches `insufficient_scope` and Xero's documented misspelling `insufficent_scope` (the optional `i`). */
const INSUFFICIENT_SCOPE_RE = /insuffici?ent_scope/i;
```

4. Change `apiKindFor` and `xeroApiError`:

```ts
function apiKindFor(status: number, headers: Headers): AccountingProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if ((status === 401 || status === 403) && INSUFFICIENT_SCOPE_RE.test(headers.get('www-authenticate') ?? '')) return 'validation';
  if (status === 400) return 'validation';
  if (status === 404) return 'not_found';
  return 'transient'; // 401/403 (link removed), 5xx, anything else
}

export function xeroApiError(operation: string, status: number, headers: Headers, text: string): AccountingProviderError {
  const kind = apiKindFor(status, headers);
  const providerCode = kind === 'rate_limited'
    ? headers.get('x-rate-limit-problem') ?? undefined // 'minute' | 'day' | 'appminute' | 'concurrent'
    : kind === 'validation'
      ? (status === 400 ? classifyXeroValidation(text) : 'insufficient_scope')
      : undefined;
  return providerError({
    kind,
    operation,
    message: `${operation} failed with ${status}`,
    httpStatus: status,
    providerMessage: xeroFaultMessage(text) ?? undefined,
    providerCode,
    retryAfterMs: kind === 'rate_limited' ? retryAfterFor(headers) : undefined,
    logBody: text.slice(0, 500),
  });
}
```

Leave `xeroTokenError` unchanged.

5. Replace `xeroApiGet` with a shared core plus two thin exports. Keep the merged W02a body of the day-remaining note exactly as it is on `main` (with or without `.catch`):

```ts
export function xeroQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * One key per immutable request (refinement 9): an identical retry replays inside
 * Xero's 6-minute window; any change to tenant, method, path or body yields a new
 * key, so Xero's "used with a different request" 400 cannot happen. Keys are
 * per-app at Xero, so the tenant is part of the input.
 */
export function xeroIdempotencyKey(tenantId: string, method: string, path: string, body: string): string {
  return `breeze-${createHash('sha256').update([tenantId, method, path, body].join('\n')).digest('hex')}`;
}

async function xeroApiCall<T>(
  ctx: XeroCallContext, method: 'GET' | 'PUT' | 'POST', path: string, operation: string,
  write?: { body: string; idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    'xero-tenant-id': ctx.tenantId,
    Accept: 'application/json',
  };
  if (write) headers['Content-Type'] = 'application/json';
  if (write?.idempotencyKey) headers['Idempotency-Key'] = write.idempotencyKey;
  const { response, text } = await withProviderCallSlot('xero', ctx.rate, ctx.connectionId, () => xeroRoundTrip(
    operation,
    `${XERO_API_BASE}/${path}`,
    { method, headers, body: write?.body, signal: AbortSignal.timeout(ctx.timeoutMs ?? XERO_REQUEST_TIMEOUT_MS) },
  ));

  const remainingHeader = response.headers.get('x-daylimit-remaining');
  const remaining = remainingHeader === null || remainingHeader.trim() === '' ? NaN : Number(remainingHeader);
  if (Number.isFinite(remaining)) {
    await noteDailyRemaining('xero', ctx.connectionId, remaining); // keep main's exact form here
  }

  if (!response.ok) {
    const err = xeroApiError(operation, response.status, response.headers, text);
    console.error(`[xeroHttp] ${operation} failed`, `status=${response.status}`, `kind=${err.kind}`);
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw providerError({ kind: 'transient', operation, message: `${operation} returned invalid JSON` });
  }
}

/** A tenant-scoped Accounting API GET through the rate-limit slot. */
export async function xeroApiGet<T>(ctx: XeroCallContext, path: string, operation: string): Promise<T> {
  return xeroApiCall<T>(ctx, 'GET', path, operation);
}

/**
 * A tenant-scoped Accounting API write (PUT = create only, POST = create or
 * update) through the same slot, day-remaining note and error translation as
 * reads. Only a create carries an Idempotency-Key by default (refinement 9): an
 * update is idempotent by content, and keying it would let an A → B → A edit
 * inside Xero's 6-minute window replay A's stale response.
 */
export async function xeroApiWrite<T>(
  ctx: XeroCallContext, method: 'PUT' | 'POST', path: string, body: unknown, operation: string,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const json = JSON.stringify(body);
  return xeroApiCall<T>(ctx, method, path, operation, {
    body: json,
    idempotencyKey: opts.idempotencyKey ?? (method === 'PUT' ? xeroIdempotencyKey(ctx.tenantId, method, path, json) : undefined),
  });
}

const MS_DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** Xero's Microsoft JSON date (or a bare ISO timestamp, which Xero treats as UTC) → ISO-8601, else null. */
export function parseXeroDate(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = MS_DATE_RE.exec(value);
  const date = ms ? new Date(Number(ms[1])) : new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
```

- [ ] **Step 4: Run the Xero boundary tests and the provider tests**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts src/services/accounting/xeroProvider.test.ts && npx tsc --noEmit -p .`
Expected: PASS (the W02a tests still pass — `xeroApiGet` is behaviour-identical; the moved helpers keep their messages).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroHttp.ts apps/api/src/services/accounting/xeroHttp.test.ts apps/api/src/services/accounting/xeroProvider.ts
git commit -m "feat(accounting): Xero write helper with create-only request-derived Idempotency-Key, refusal classification, dates (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: `xeroContacts.ts`: listing, single read, adoption, create/update; provider wiring

**Files:**
- Create: `apps/api/src/services/accounting/xeroContacts.ts`, `xeroContacts.test.ts`
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (`listRemoteCustomers`, `getRemoteCustomer`, `upsertCustomer`)
- Test: `xeroProvider.test.ts` (later-waves table, delegation)

**Interfaces:**
- Consumes: Task 1 (`refusalCodeOf`, `RemoteCustomer.supplierOnly`, `getRemoteCustomer?`), Task 2 (`xeroApiGet`, `xeroApiWrite`, `xeroQuery`, `parseXeroDate`, `requireXeroBody`, `xeroArray`), A2, A4 (`callContext`).
- Produces (`xeroContacts.ts`):
  ```ts
  export const XERO_CONTACT_PAGE_SIZE = 1000;
  export const XERO_CONTACT_PAGE_GUARD = 1000;                                 // runaway guard: throws, never truncates
  export function contactNumberFor(organizationId: string): string;           // 'breeze:<uuid>'
  export function xeroContactName(displayName: string): string;               // Xero-safe name (throws validation when empty)
  export function toRemoteCustomer(contact: XeroContact): RemoteCustomer | null; // null for GDPRREQUEST / no id
  export async function listXeroContacts(ctx: XeroCallContext, query?: string): Promise<RemoteCustomer[]>;
  export async function getXeroContact(ctx: XeroCallContext, contactId: string): Promise<RemoteCustomer | null>;
  export async function findXeroContactByNumber(ctx: XeroCallContext, contactNumber: string): Promise<XeroContact | null>;
  export async function upsertXeroContact(ctx: XeroCallContext, customer: AccountingCustomerPayload, mapping: AccountingEntityMapping | null): Promise<RemoteRef>;
  ```

- [ ] **Step 1: Write the failing tests**

`xeroContacts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import { AccountingProviderError } from './accountingProviderError';
import {
  contactNumberFor, getXeroContact, listXeroContacts, toRemoteCustomer, upsertXeroContact, xeroContactName,
  XERO_CONTACT_PAGE_GUARD,
} from './xeroContacts';
import type { AccountingCustomerPayload } from './types';

const ORG = '0f0e0d0c-0b0a-4908-8706-050403020100';
const NUMBER = `breeze:${ORG}`;
const ctx = {
  connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at',
  rate: { perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5, appWide: null, dailyPerConnection: null },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const payload = (over: Partial<AccountingCustomerPayload> = {}): AccountingCustomerPayload => ({
  organizationId: ORG, displayName: 'Acme Ltd', billingEmail: 'ap@acme.test', taxId: null,
  phone: '+44 20 7946 0000', billAddr: { line1: '1 High St', city: 'London', postalCode: 'N1 1AA', country: 'GB' },
  currencyCode: 'GBP', ...over,
});
const contact = (over: Record<string, unknown> = {}) => ({
  ContactID: 'xc-1', ContactNumber: NUMBER, ContactStatus: 'ACTIVE', Name: 'Acme Ltd',
  EmailAddress: 'ap@acme.test', UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});
const urlOf = (fetchMock: ReturnType<typeof vi.spyOn>, i: number) => (fetchMock.mock.calls[i] as [string, RequestInit])[0];
const initOf = (fetchMock: ReturnType<typeof vi.spyOn>, i: number) => (fetchMock.mock.calls[i] as [string, RequestInit])[1];
const LOOKUP_URL = `https://api.xero.com/api.xro/2.0/Contacts?where=ContactNumber%3D%3D%22breeze%3A${ORG}%22&includeArchived=true`;

afterEach(() => { vi.restoreAllMocks(); slotMock.mockClear(); });

describe('contact wire mapping', () => {
  it('maps a paged Contacts row, POBOX → billAddr and STREET → shipAddr', () => {
    expect(toRemoteCustomer(contact({
      FirstName: 'Pat', LastName: 'Lee', DefaultCurrency: 'gbp',
      Phones: [{ PhoneType: 'FAX', PhoneNumber: '1' }, { PhoneType: 'DEFAULT', PhoneCountryCode: '44', PhoneAreaCode: '20', PhoneNumber: '7946 0000' }],
      Addresses: [
        { AddressType: 'POBOX', AddressLine1: 'PO Box 9', City: 'Leeds' },
        { AddressType: 'STREET', AddressLine1: '1 High St', AddressLine2: 'Floor 2', AddressLine3: 'Unit 4', PostalCode: 'N1 1AA', Country: 'United Kingdom' },
      ],
    }))).toEqual({
      id: 'xc-1', displayName: 'Acme Ltd', email: 'ap@acme.test', companyName: 'Acme Ltd', contactName: 'Pat Lee',
      phone: '44 20 7946 0000',
      billAddr: { line1: 'PO Box 9', city: 'Leeds' },
      shipAddr: { line1: '1 High St', line2: 'Floor 2, Unit 4', postalCode: 'N1 1AA', country: 'United Kingdom' },
      active: true, remoteVersion: new Date(1790000000000).toISOString(), currencyCode: 'GBP',
    });
  });
  it('flags archived contacts inactive and supplier-only contacts supplierOnly', () => {
    expect(toRemoteCustomer(contact({ ContactStatus: 'ARCHIVED' }))).toMatchObject({ active: false });
    expect(toRemoteCustomer(contact({ IsSupplier: true, IsCustomer: false }))).toMatchObject({ supplierOnly: true });
    expect(toRemoteCustomer(contact({ IsSupplier: true, IsCustomer: true }))).not.toHaveProperty('supplierOnly');
    expect(toRemoteCustomer(contact({}))).not.toHaveProperty('supplierOnly'); // no transactions yet: stays visible
  });
  it('drops GDPR-erased contacts and rows without an id', () => {
    expect(toRemoteCustomer(contact({ ContactStatus: 'GDPRREQUEST' }))).toBeNull();
    expect(toRemoteCustomer(contact({ ContactID: undefined }))).toBeNull();
  });
  it('makes a Xero-safe name and refuses one that is empty after cleaning', () => {
    expect(xeroContactName('  <Acme>   Ltd  ')).toBe('Acme Ltd');
    expect(xeroContactName('x'.repeat(300))).toHaveLength(255);
    expect(() => xeroContactName(' <> ')).toThrow(expect.objectContaining({ kind: 'validation', provider: 'xero' }));
  });
  it('builds the ContactNumber from a UUID only', () => {
    expect(contactNumberFor(ORG)).toBe(NUMBER);
    expect(() => contactNumberFor('x" or 1==1')).toThrow(expect.objectContaining({ kind: 'validation' }));
  });
});

describe('listXeroContacts', () => {
  it('pages at 1000 with archived included until pageCount, dropping GDPR rows', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ pagination: { page: 1, pageSize: 1000, pageCount: 2, itemCount: 1002 }, Contacts: [contact(), contact({ ContactID: 'gdpr', ContactStatus: 'GDPRREQUEST' })] }))
      .mockResolvedValueOnce(json({ pagination: { page: 2, pageSize: 1000, pageCount: 2, itemCount: 1002 }, Contacts: [contact({ ContactID: 'xc-2', Name: 'Beta' })] }));
    const rows = await listXeroContacts(ctx);
    expect(rows.map((r) => r.id)).toEqual(['xc-1', 'xc-2']);
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts?page=1&pageSize=1000&includeArchived=true');
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Contacts?page=2&pageSize=1000&includeArchived=true');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('honours the query through searchTerm', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ pagination: { pageCount: 1 }, Contacts: [] }));
    await listXeroContacts(ctx, '  acme co ');
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts?page=1&pageSize=1000&includeArchived=true&searchTerm=acme%20co');
  });
  it('stops on a short page when the pagination object is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await listXeroContacts(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('follows pageCount past 100 pages — a large tenant is never silently truncated (quorum 9)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 150 }, Contacts: [contact()] }));
    await expect(listXeroContacts(ctx)).resolves.toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(150);
  });
  it('throws instead of returning a partial list when pagination never ends', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 999_999 }, Contacts: [contact()] }));
    await expect(listXeroContacts(ctx)).rejects.toMatchObject({ kind: 'transient', provider: 'xero' });
    expect(fetchMock).toHaveBeenCalledTimes(XERO_CONTACT_PAGE_GUARD);
  });
});

describe('getXeroContact', () => {
  it('reads one contact by id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(getXeroContact(ctx, 'xc-1')).resolves.toMatchObject({ id: 'xc-1' });
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts/xc-1');
  });
  it('returns null on 404 and for a GDPR-erased contact', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Title: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ Contacts: [contact({ ContactStatus: 'GDPRREQUEST' })] }));
    await expect(getXeroContact(ctx, 'nope')).resolves.toBeNull();
    await expect(getXeroContact(ctx, 'xc-1')).resolves.toBeNull();
  });
});

describe('upsertXeroContact', () => {
  it('creates with ContactNumber after a lookup miss', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Contacts: [contact({ DefaultCurrency: 'GBP' })] }));
    const ref = await upsertXeroContact(ctx, payload(), null);
    expect(urlOf(fetchMock, 0)).toBe(LOOKUP_URL);
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Contacts');
    expect(initOf(fetchMock, 1).method).toBe('PUT');
    expect(JSON.parse(initOf(fetchMock, 1).body as string)).toEqual({ Contacts: [{
      Name: 'Acme Ltd', EmailAddress: 'ap@acme.test',
      Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '+44 20 7946 0000' }],
      Addresses: [{ AddressType: 'POBOX', AddressLine1: '1 High St', City: 'London', PostalCode: 'N1 1AA', Country: 'GB' }],
      ContactNumber: NUMBER,
    }] });
    expect(ref).toMatchObject({ id: 'xc-1', remoteVersion: new Date(1790000000000).toISOString(), currencyCode: 'GBP' });
  });

  it('adopts a lookup hit instead of creating, and updates it WITHOUT ContactNumber', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await upsertXeroContact(ctx, payload(), null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Contacts/xc-1');
    expect(initOf(fetchMock, 1).method).toBe('POST');
    const body = JSON.parse(initOf(fetchMock, 1).body as string);
    expect(body.Contacts[0]).toMatchObject({ ContactID: 'xc-1', Name: 'Acme Ltd' });
    expect(body.Contacts[0]).not.toHaveProperty('ContactNumber');
  });

  it('refuses to adopt our own archived contact (remote_archived) and writes nothing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact({ ContactStatus: 'ARCHIVED' })] }));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_archived', provider: 'xero' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a lookup row whose ContactNumber is not ours (where-clause is only a hint)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [contact({ ContactNumber: 'breeze:other' })] }))
      .mockResolvedValueOnce(json({ Contacts: [contact({ ContactID: 'xc-new' })] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-new' });
    expect(initOf(fetchMock, 1).method).toBe('PUT');
  });

  it('adopts after a timed-out create (Review Focus 1): exactly one PUT, then lookup, then update', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockRejectedValueOnce(new DOMException('t', 'TimeoutError'))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-1' });
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('adopts after a duplicate ContactNumber refusal (a concurrent create won)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Elements: [{ ValidationErrors: [{ Message: `The contact number ${NUMBER} is already assigned to another contact.` }] }] }, 400))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-1' });
  });

  it('rethrows the original transient when the re-lookup finds nothing (never a blind second create)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  const DUP_NAME = { Elements: [{ ValidationErrors: [{ Message: 'The contact name Acme Ltd is already assigned to another contact. The contact name must be unique across all active contacts.' }] }] };

  it('surfaces duplicate_name after one ContactNumber look misses — never a second create (Review Focus 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json(DUP_NAME, 400))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_name' });
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('adopts when the duplicate name belongs to our own earlier create (quorum 5)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json(DUP_NAME, 400))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-1' });
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it.each(['ARCHIVED', 'GDPRREQUEST'])('a mapped contact whose update comes back %s is remote_archived (quorum 4)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact({ ContactID: 'xc-9', ContactStatus: status })] }));
    await expect(upsertXeroContact(ctx, payload(), { remoteEntityId: 'xc-9', remoteSyncToken: null }))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_archived' });
  });

  it('a mapped contact Xero answers 404 for is not_found + remote_missing (quorum 6)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Title: 'Not Found' }, 404));
    await expect(upsertXeroContact(ctx, payload(), { remoteEntityId: 'gone', remoteSyncToken: null }))
      .rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing', httpStatus: 404 });
  });

  it('updates a mapped contact by ContactID with no lookup and no ContactNumber', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact({ ContactID: 'xc-9' })] }));
    await upsertXeroContact(ctx, payload({ billAddr: undefined, phone: undefined, billingEmail: null }), { remoteEntityId: 'xc-9', remoteSyncToken: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts/xc-9');
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({ Contacts: [{ ContactID: 'xc-9', Name: 'Acme Ltd' }] });
  });

  it.each([
    ['list', () => listXeroContacts(ctx)],
    ['get', () => getXeroContact(ctx, 'xc-1')],
    ['upsert', () => upsertXeroContact(ctx, payload(), null)],
  ])('propagates a limiter refusal untouched (%s)', async (_name, call) => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(call()).rejects.toBe(refusal);
  });
});
```

In `xeroProvider.test.ts`: delete the `listRemoteCustomers` and `upsertCustomer` rows from `describe('methods behind later waves')`, and add:

```ts
describe('contacts (Xero W03)', () => {
  it('listRemoteCustomers delegates with the connection tenant and query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ pagination: { pageCount: 1 }, Contacts: [] }));
    await xeroProvider.listRemoteCustomers(conn(), 'ac');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/Contacts?page=1&pageSize=1000&includeArchived=true&searchTerm=ac');
    expect(init.headers).toMatchObject({ 'xero-tenant-id': 'ten-A', Authorization: 'Bearer at' });
  });
  it('declares getRemoteCustomer', () => {
    expect(typeof xeroProvider.getRemoteCustomer).toBe('function');
  });
  it('still declares only the connect capability through W03a', () => {
    expect(xeroProvider.capabilities).toMatchObject({ connect: true, mapping: false, customerImport: false });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroContacts.test.ts src/services/accounting/xeroProvider.test.ts`
Expected: FAIL — `./xeroContacts` does not exist; the provider still refuses with `capability_unavailable`.

- [ ] **Step 3: Implement `xeroContacts.ts`**

```ts
/**
 * Xero contacts (Xero W03): wire mapping between Xero Contacts and Breeze's
 * neutral RemoteCustomer, paged listing, single read, and create/update with
 * ADOPTION. Adoption key: ContactNumber = `breeze:<orgId>` (API-only field,
 * ≤50, unique). It is written on create only — Xero's guidance is one number per
 * contact, never overwrite another integration's — so every update omits it.
 * Adoption runs before every create and after every uncertain outcome; a hit is
 * adopted and updated, never re-created. A duplicate NAME is surfaced to the
 * user (structured `duplicate_name`), never retried.
 */
import { AccountingProviderError, isAccountingProviderError, refusalCodeOf } from './accountingProviderError';
import {
  parseXeroDate, requireXeroBody, xeroApiGet, xeroApiWrite, xeroArray, xeroQuery, type XeroCallContext,
} from './xeroHttp';
import type { AccountingCustomerPayload, AccountingEntityMapping, RemoteAddress, RemoteCustomer, RemoteRef } from './types';

export interface XeroAddress {
  AddressType?: string; AddressLine1?: string; AddressLine2?: string; AddressLine3?: string; AddressLine4?: string;
  City?: string; Region?: string; PostalCode?: string; Country?: string;
}
export interface XeroPhone { PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string }
export interface XeroContact {
  ContactID?: string; ContactNumber?: string; ContactStatus?: string; Name?: string; FirstName?: string; LastName?: string;
  EmailAddress?: string; TaxNumber?: string; Addresses?: XeroAddress[]; Phones?: XeroPhone[];
  IsCustomer?: boolean; IsSupplier?: boolean; DefaultCurrency?: string; UpdatedDateUTC?: string;
}
interface ContactsBody { Contacts?: XeroContact[]; pagination?: { page?: number; pageSize?: number; pageCount?: number; itemCount?: number } }

export const XERO_CONTACT_PAGE_SIZE = 1000;
/**
 * Runaway guard only. Xero's 100k figure limits one response or unoptimised
 * query, not a tenant's size, so the loop follows pageCount and THROWS if it
 * ever passes this — it never returns a silently truncated list (refinement 19).
 */
export const XERO_CONTACT_PAGE_GUARD = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validation(operation: string, message: string, providerCode?: string): AccountingProviderError {
  return new AccountingProviderError({ kind: 'validation', provider: 'xero', operation, message, providerCode });
}

/** The value interpolated into a `where` clause, so it must never carry a quote: organisation ids are UUIDs. */
export function contactNumberFor(organizationId: string): string {
  if (!UUID_RE.test(organizationId)) throw validation('Xero contact number', 'Xero contact number needs an organization UUID');
  return `breeze:${organizationId.toLowerCase()}`;
}

/** Xero refuses angle brackets, leading/trailing and repeated whitespace; Name is ≤255. */
export function xeroContactName(displayName: string): string {
  const name = displayName.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 255).trim();
  if (!name) throw validation('Xero contact name', 'Xero contact name is empty after removing characters Xero refuses');
  return name;
}

function currencyOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

function fromXeroAddress(address: XeroAddress | undefined): RemoteAddress | undefined {
  if (!address) return undefined;
  const line2 = [address.AddressLine2, address.AddressLine3, address.AddressLine4].map((s) => s?.trim()).filter(Boolean).join(', ');
  const out: RemoteAddress = {
    ...(address.AddressLine1?.trim() ? { line1: address.AddressLine1.trim() } : {}),
    ...(line2 ? { line2 } : {}),
    ...(address.City?.trim() ? { city: address.City.trim() } : {}),
    ...(address.Region?.trim() ? { region: address.Region.trim() } : {}),
    ...(address.PostalCode?.trim() ? { postalCode: address.PostalCode.trim() } : {}),
    ...(address.Country?.trim() ? { country: address.Country.trim() } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

function toXeroAddress(type: 'POBOX' | 'STREET', address: RemoteAddress | undefined): XeroAddress | null {
  if (!address) return null;
  const out: XeroAddress = {
    AddressType: type,
    ...(address.line1 ? { AddressLine1: address.line1.slice(0, 500) } : {}),
    ...(address.line2 ? { AddressLine2: address.line2.slice(0, 500) } : {}),
    ...(address.city ? { City: address.city.slice(0, 255) } : {}),
    ...(address.region ? { Region: address.region.slice(0, 255) } : {}),
    ...(address.postalCode ? { PostalCode: address.postalCode.slice(0, 50) } : {}),
    ...(address.country ? { Country: address.country.slice(0, 50) } : {}),
  };
  return Object.keys(out).length > 1 ? out : null;
}

function phoneOf(phones: XeroPhone[] | undefined): string | undefined {
  const list = xeroArray<XeroPhone>(phones);
  const pick = list.find((p) => p.PhoneType === 'DEFAULT' && p.PhoneNumber?.trim())
    ?? list.find((p) => p.PhoneType === 'MOBILE' && p.PhoneNumber?.trim());
  if (!pick) return undefined;
  return [pick.PhoneCountryCode, pick.PhoneAreaCode, pick.PhoneNumber].map((s) => s?.trim()).filter(Boolean).join(' ');
}

function addressOf(contact: XeroContact, type: 'POBOX' | 'STREET'): RemoteAddress | undefined {
  return fromXeroAddress(xeroArray<XeroAddress>(contact.Addresses).find((a) => a.AddressType === type));
}

export function toRemoteCustomer(contact: XeroContact): RemoteCustomer | null {
  if (!contact.ContactID || contact.ContactStatus === 'GDPRREQUEST') return null;
  const person = [contact.FirstName, contact.LastName].map((s) => s?.trim()).filter(Boolean).join(' ');
  const phone = phoneOf(contact.Phones);
  const billAddr = addressOf(contact, 'POBOX');
  const shipAddr = addressOf(contact, 'STREET');
  const remoteVersion = parseXeroDate(contact.UpdatedDateUTC);
  const currencyCode = currencyOf(contact.DefaultCurrency);
  return {
    id: contact.ContactID,
    displayName: contact.Name?.trim() || contact.ContactID,
    ...(contact.EmailAddress ? { email: contact.EmailAddress } : {}),
    ...(contact.Name?.trim() ? { companyName: contact.Name.trim() } : {}),
    ...(person ? { contactName: person } : {}),
    ...(phone ? { phone } : {}),
    ...(billAddr ? { billAddr } : {}),
    ...(shipAddr ? { shipAddr } : {}),
    active: contact.ContactStatus === undefined || contact.ContactStatus === 'ACTIVE',
    ...(remoteVersion ? { remoteVersion } : {}),
    ...(currencyCode ? { currencyCode } : {}),
    ...(contact.IsSupplier === true && contact.IsCustomer !== true ? { supplierOnly: true } : {}),
  };
}

function toRef(contact: XeroContact | undefined, operation: string): RemoteRef {
  if (!contact?.ContactID) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} returned no contact` });
  }
  const remoteVersion = parseXeroDate(contact.UpdatedDateUTC);
  const currencyCode = currencyOf(contact.DefaultCurrency);
  const billAddr = addressOf(contact, 'POBOX');
  const shipAddr = addressOf(contact, 'STREET');
  return {
    id: contact.ContactID,
    ...(remoteVersion ? { remoteVersion } : {}),
    ...(currencyCode ? { currencyCode } : {}),
    ...(billAddr ? { billAddr } : {}),
    ...(shipAddr ? { shipAddr } : {}),
  };
}

/** Everything we send on create AND update. ContactNumber is added by the create path only (refinement 3). */
function contactFields(customer: AccountingCustomerPayload): XeroContact {
  const addresses = [toXeroAddress('POBOX', customer.billAddr), toXeroAddress('STREET', customer.shipAddr)]
    .filter((a): a is XeroAddress => a !== null);
  return {
    Name: xeroContactName(customer.displayName),
    ...(customer.billingEmail ? { EmailAddress: customer.billingEmail.slice(0, 255) } : {}),
    ...(customer.taxId ? { TaxNumber: customer.taxId.slice(0, 50) } : {}),
    ...(customer.phone ? { Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: customer.phone.slice(0, 50) }] } : {}),
    ...(addresses.length ? { Addresses: addresses } : {}),
  };
}

export async function listXeroContacts(ctx: XeroCallContext, query?: string): Promise<RemoteCustomer[]> {
  const operation = 'Xero contact list';
  const searchTerm = query?.trim() || undefined;
  const out: RemoteCustomer[] = [];
  for (let page = 1; ; page++) {
    if (page > XERO_CONTACT_PAGE_GUARD) {
      throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} pagination did not terminate` });
    }
    // Paged requests return every field (IsCustomer/IsSupplier included); summaryOnly would drop them.
    const body = requireXeroBody(await xeroApiGet<ContactsBody | null>(
      ctx, `Contacts${xeroQuery({ page, pageSize: XERO_CONTACT_PAGE_SIZE, includeArchived: true, searchTerm })}`, operation,
    ), operation);
    const rows = xeroArray<XeroContact>(body.Contacts);
    for (const row of rows) {
      const customer = toRemoteCustomer(row);
      if (customer) out.push(customer);
    }
    const pageCount = body.pagination?.pageCount;
    if (typeof pageCount === 'number' ? page >= pageCount : rows.length < XERO_CONTACT_PAGE_SIZE) break;
  }
  return out;
}

export async function getXeroContact(ctx: XeroCallContext, contactId: string): Promise<RemoteCustomer | null> {
  const operation = 'Xero contact read';
  let body: ContactsBody | null;
  try {
    body = await xeroApiGet<ContactsBody | null>(ctx, `Contacts/${encodeURIComponent(contactId)}`, operation);
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') return null;
    throw err;
  }
  const row = xeroArray<XeroContact>(requireXeroBody(body, operation).Contacts)[0];
  return row ? toRemoteCustomer(row) : null;
}

export async function findXeroContactByNumber(ctx: XeroCallContext, contactNumber: string): Promise<XeroContact | null> {
  const operation = 'Xero contact lookup';
  const body = requireXeroBody(await xeroApiGet<ContactsBody | null>(
    ctx, `Contacts${xeroQuery({ where: `ContactNumber=="${contactNumber}"`, includeArchived: true })}`, operation,
  ), operation);
  // The where clause is a hint; the exact value is the proof.
  return xeroArray<XeroContact>(body.Contacts).find((c) => c.ContactID && c.ContactNumber === contactNumber) ?? null;
}

async function updateContact(ctx: XeroCallContext, contactId: string, fields: XeroContact): Promise<RemoteRef> {
  const operation = 'Xero contact update';
  let body: ContactsBody | null;
  try {
    body = await xeroApiWrite<ContactsBody | null>(
      ctx, 'POST', `Contacts/${encodeURIComponent(contactId)}`, { Contacts: [{ ContactID: contactId, ...fields }] }, operation,
    );
  } catch (err) {
    // The contact Breeze is linked to is gone: terminal, "unlink and map it again" (refinement 4).
    if (isAccountingProviderError(err) && err.kind === 'not_found') {
      throw new AccountingProviderError({
        kind: 'not_found', provider: 'xero', operation, message: `${operation} found no contact`,
        httpStatus: 404, providerCode: 'remote_missing', cause: err,
      });
    }
    throw err;
  }
  const contact = xeroArray<XeroContact>(requireXeroBody(body, operation).Contacts)[0];
  // An archived / GDPR-erased contact cannot be invoiced: the (harmless) update must not read as success.
  if (contact?.ContactStatus && contact.ContactStatus !== 'ACTIVE') {
    throw validation(operation, `${operation} found an archived contact`, 'remote_archived');
  }
  return toRef(contact, operation);
}

async function adoptContact(ctx: XeroCallContext, contact: XeroContact, fields: XeroContact): Promise<RemoteRef> {
  if (contact.ContactStatus && contact.ContactStatus !== 'ACTIVE') {
    throw validation('Xero contact adoption', 'Xero contact adoption found an archived contact', 'remote_archived');
  }
  return updateContact(ctx, contact.ContactID as string, fields);
}

/**
 * An outcome after which our create may have landed (or a peer's did): look
 * before acting again. duplicate_name is included because our own earlier
 * create owns both the name and the ContactNumber, and Xero may report the name
 * first (refinement 5); a miss still surfaces the duplicate_name.
 */
function shouldLookAgain(err: unknown): boolean {
  if (isAccountingProviderError(err) && err.kind === 'transient') return true;
  const code = refusalCodeOf(err);
  return code === 'duplicate_key' || code === 'duplicate_name';
}

export async function upsertXeroContact(
  ctx: XeroCallContext,
  customer: AccountingCustomerPayload,
  mapping: AccountingEntityMapping | null,
): Promise<RemoteRef> {
  const fields = contactFields(customer);
  if (mapping) return updateContact(ctx, mapping.remoteEntityId, fields);

  const contactNumber = contactNumberFor(customer.organizationId);
  const existing = await findXeroContactByNumber(ctx, contactNumber);
  if (existing) return adoptContact(ctx, existing, fields);

  const operation = 'Xero contact create';
  try {
    const body = requireXeroBody(await xeroApiWrite<ContactsBody | null>(
      ctx, 'PUT', 'Contacts', { Contacts: [{ ...fields, ContactNumber: contactNumber }] }, operation,
    ), operation);
    return toRef(xeroArray<XeroContact>(body.Contacts)[0], operation);
  } catch (err) {
    if (!shouldLookAgain(err)) throw err;
    const landed = await findXeroContactByNumber(ctx, contactNumber).catch(() => null);
    if (!landed) throw err;
    return adoptContact(ctx, landed, fields);
  }
}
```

- [ ] **Step 4: Wire the provider**

In `xeroProvider.ts`, import `getXeroContact, listXeroContacts, upsertXeroContact` from `./xeroContacts` and replace the two stubs:

```ts
  async listRemoteCustomers(conn: AccountingConnection, query?: string): Promise<RemoteCustomer[]> {
    return listXeroContacts(callContext(conn), query);
  }

  async getRemoteCustomer(conn: AccountingConnection, id: string): Promise<RemoteCustomer | null> {
    return getXeroContact(callContext(conn), id);
  }

  async upsertCustomer(
    conn: AccountingConnection,
    customer: AccountingCustomerPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    return upsertXeroContact(callContext(conn), customer, mapping);
  }
```

Update the provider's header comment: "W03 implements contacts and items; the `mapping`/`customerImport` capabilities flip in W03b."

- [ ] **Step 5: Run the tests, the guard and typecheck**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroContacts.test.ts src/services/accounting/xeroProvider.test.ts src/services/accounting/neutralCore.guard.test.ts && npx tsc --noEmit -p .`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/accounting/xeroContacts.ts apps/api/src/services/accounting/xeroContacts.test.ts apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts
git commit -m "feat(accounting): Xero contacts — paged listing, single read, ContactNumber adoption (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `xeroItems.ts`: hash-suffix codes, listing, adoption, create/update; income accounts

**Files:**
- Create: `apps/api/src/services/accounting/xeroItems.ts`, `xeroItems.test.ts`
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (`listRemoteItems`, `getRemoteItem`, `upsertItem`, `listRemoteIncomeAccounts`; extract `incomeAccountOptions`)
- Test: `xeroProvider.test.ts`

**Interfaces:**
- Consumes: Task 1 (`refusalCodeOf`, `getRemoteItem?`), Task 2, A4, A5, A7. (Task 3's `shouldLookAgain` is re-implemented locally; the two modules stay independent.)
- Produces (`xeroItems.ts`):
  ```ts
  export const XERO_ITEM_UNITDP = 4;
  export function xeroItemSuffix(catalogItemId: string): string;                    // sha256 hex [0..10]
  export function xeroItemCode(item: Pick<AccountingItemPayload, 'catalogItemId' | 'sku' | 'name'>): string; // prefix(≤19) + '-' + suffix, ≤30
  export function xeroItemName(name: string): string;                               // ≤50, whitespace-collapsed
  export function toRemoteItem(item: XeroItem): RemoteItem | null;
  export async function listXeroItems(ctx: XeroCallContext, query?: string): Promise<RemoteItem[]>;
  export async function getXeroItem(ctx: XeroCallContext, itemId: string): Promise<RemoteItem | null>;
  export async function upsertXeroItem(
    ctx: XeroCallContext, item: AccountingItemPayload, mapping: AccountingEntityMapping | null,
    tax: { taxCodeRef: string | null; exemptTaxCodeRef: string | null },
  ): Promise<RemoteRef>;
  ```
- Produces (`xeroProvider.ts`, private): `function incomeAccountOptions(accounts: XeroAccount[]): ProviderSettingsOption[]`, used by both `listSettingsOptions` and `listRemoteIncomeAccounts`.

- [ ] **Step 1: Write the failing tests**

`xeroItems.test.ts` (copy the rate-limit mock, `ctx`, `json`, `urlOf`, `initOf` helpers from `xeroContacts.test.ts`):

```ts
import { createHash } from 'node:crypto';
import { AccountingProviderError } from './accountingProviderError';
import { getXeroItem, listXeroItems, toRemoteItem, upsertXeroItem, xeroItemCode, xeroItemName, xeroItemSuffix } from './xeroItems';
import type { AccountingItemPayload } from './types';

const ITEM = '11111111-2222-4333-8444-555555555555';
const H = createHash('sha256').update(ITEM).digest('hex').slice(0, 10);
const TAX = { taxCodeRef: 'OUTPUT2', exemptTaxCodeRef: 'EXEMPTOUTPUT' };
const ALL_ITEMS_URL = 'https://api.xero.com/api.xro/2.0/Items?unitdp=4';
const payload = (over: Partial<AccountingItemPayload> = {}): AccountingItemPayload => ({
  catalogItemId: ITEM, name: 'Managed Firewall', sku: 'FW-100', description: 'Per site, monthly',
  type: 'Service', unitPrice: '49.9950', currencyCode: 'GBP', taxable: true, active: true, incomeAccountRef: '200', ...over,
});
const xitem = (over: Record<string, unknown> = {}) => ({
  ItemID: 'xi-1', Code: `fw-100-${H}`, Name: 'Managed Firewall', Description: 'Per site, monthly', IsSold: true,
  SalesDetails: { UnitPrice: 49.995, AccountCode: '200', TaxType: 'OUTPUT2' }, UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});
const createBody = (code: string) => ({ Items: [{
  Code: code, IsPurchased: false, Name: 'Managed Firewall', Description: 'Per site, monthly', IsSold: true,
  SalesDetails: { UnitPrice: 49.995, AccountCode: '200', TaxType: 'OUTPUT2' },
}] });
const methods = (fetchMock: ReturnType<typeof vi.spyOn>) => fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method);

describe('item codes and names', () => {
  it('builds prefix-<10 hex> from the SKU, else the name, within 30 chars', () => {
    expect(xeroItemSuffix(ITEM)).toBe(H);
    expect(xeroItemCode(payload())).toBe(`fw-100-${H}`);
    expect(xeroItemCode(payload({ sku: undefined }))).toBe(`managed-firewall-${H}`);
    // prefix is 19 chars: 'microsoft' (9) + '-365-' (5) + 'busin' (5)
    expect(xeroItemCode(payload({ sku: undefined, name: 'Microsoft 365 Business Premium (annual)' }))).toBe(`microsoft-365-busin-${H}`);
  });
  it.each([
    ['Microsoft 365 Business Premium (annual)'], ['★★★'], ['Café Wi-Fi'], ['x'.repeat(200)], ['  --  '],
  ])('never exceeds 30 chars and always ends in -<suffix> (%s)', (name) => {
    const code = xeroItemCode(payload({ sku: undefined, name }));
    expect(code.length).toBeLessThanOrEqual(30);
    expect(code.endsWith(`-${H}`)).toBe(true);
    expect(code).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
  it('falls back to "item" and strips accents', () => {
    expect(xeroItemCode(payload({ sku: undefined, name: '★★★' }))).toBe(`item-${H}`);
    expect(xeroItemCode(payload({ sku: undefined, name: 'Café Wi-Fi' }))).toBe(`cafe-wi-fi-${H}`);
  });
  it('truncates names to 50', () => {
    expect(xeroItemName(`  ${'N'.repeat(80)} `)).toHaveLength(50);
  });
});
```

```ts
describe('toRemoteItem', () => {
  it('maps Code to sku and UpdatedDateUTC to an ISO version', () => {
    expect(toRemoteItem(xitem())).toEqual({
      id: 'xi-1', displayName: 'Managed Firewall', sku: `fw-100-${H}`, description: 'Per site, monthly',
      unitPrice: 49.995, active: true, remoteVersion: new Date(1790000000000).toISOString(),
    });
    expect(toRemoteItem(xitem({ IsSold: false }))).toMatchObject({ active: false });
    expect(toRemoteItem(xitem({ ItemID: undefined }))).toBeNull();
  });
});

describe('listXeroItems / getXeroItem', () => {
  it('reads all items once with unitdp=4 and filters by query client-side', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ Items: [xitem(), xitem({ ItemID: 'xi-2', Code: 'AV-1', Name: 'Antivirus' })] }));
    await expect(listXeroItems(ctx)).resolves.toHaveLength(2);
    await expect(listXeroItems(ctx, 'fire')).resolves.toEqual([expect.objectContaining({ id: 'xi-1' })]);
    await expect(listXeroItems(ctx, 'av-1')).resolves.toEqual([expect.objectContaining({ id: 'xi-2' })]);
    expect(urlOf(fetchMock, 0)).toBe(ALL_ITEMS_URL);
  });
  it('getXeroItem returns null on 404', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 404));
    await expect(getXeroItem(ctx, 'xi-9')).resolves.toBeNull();
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Items/xi-9?unitdp=4');
  });
});

describe('upsertXeroItem', () => {
  it('creates under prefix-<suffix> after the suffix look misses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'other', Code: 'AV-1', Name: 'Antivirus' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem()] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).resolves.toMatchObject({ id: 'xi-1', remoteVersion: new Date(1790000000000).toISOString() });
    expect(urlOf(fetchMock, 0)).toBe(ALL_ITEMS_URL);
    expect(urlOf(fetchMock, 1)).toBe(ALL_ITEMS_URL);
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(initOf(fetchMock, 1).body as string)).toEqual(createBody(`fw-100-${H}`));
  });

  it('never adopts an MSP item that only shares the SKU (Review Focus 3)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'msp', Code: 'FW-100', Name: 'Managed Firewall' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-new' })] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).resolves.toMatchObject({ id: 'xi-new' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
    expect(fetchMock.mock.calls.some((_c, i) => urlOf(fetchMock, i).includes('/Items/msp'))).toBe(false);
  });

  it('a retry after a rename adopts by suffix and keeps the existing Code (Review Focus 3)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-ours', Code: `old-name-${H.toUpperCase()}`, Name: 'Old name' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-ours' })] }));
    await upsertXeroItem(ctx, payload({ name: 'Managed Firewall', sku: 'FW-200' }), null, TAX);
    expect(methods(fetchMock)).toEqual(['GET', 'POST']);
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Items/xi-ours?unitdp=4');
    const sent = JSON.parse(initOf(fetchMock, 1).body as string).Items[0];
    expect(sent).toMatchObject({ ItemID: 'xi-ours', Code: `old-name-${H.toUpperCase()}`, Name: 'Managed Firewall' });
    expect(sent).not.toHaveProperty('IsPurchased');
  });

  it('two suffix hits are refused with duplicate_key and nothing is written (Review Focus 3)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Items: [
      xitem({ ItemID: 'a', Code: `x-${H}` }), xitem({ ItemID: 'b', Code: `y-${H}` }),
    ] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adopts after a timed-out create whose item did land', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockRejectedValueOnce(new DOMException('t', 'TimeoutError'))
      .mockResolvedValueOnce(json({ Items: [xitem()] }))
      .mockResolvedValueOnce(json({ Items: [xitem()] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).resolves.toMatchObject({ id: 'xi-1' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('rethrows the original transient when the re-look finds nothing', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503))
      .mockResolvedValueOnce(json({ Items: [] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503 });
  });

  it('uses the exempt TaxType for a non-taxable item and omits a null one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] })).mockResolvedValueOnce(json({ Items: [xitem()] }))
      .mockResolvedValueOnce(json({ Items: [] })).mockResolvedValueOnce(json({ Items: [xitem()] }));
    await upsertXeroItem(ctx, payload({ taxable: false }), null, TAX);
    expect(JSON.parse(initOf(fetchMock, 1).body as string).Items[0].SalesDetails.TaxType).toBe('EXEMPTOUTPUT');
    await upsertXeroItem(ctx, payload({ taxable: false }), null, { taxCodeRef: 'OUTPUT2', exemptTaxCodeRef: null });
    expect(JSON.parse(initOf(fetchMock, 3).body as string).Items[0].SalesDetails).not.toHaveProperty('TaxType');
  });

  it('updates a mapped item by reading it first and posting back its own Code', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-7', Code: 'MSP-OWN' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-7' })] }));
    await upsertXeroItem(ctx, payload(), { remoteEntityId: 'xi-7', remoteSyncToken: null }, TAX);
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Items/xi-7?unitdp=4');
    const sent = JSON.parse(initOf(fetchMock, 1).body as string).Items[0];
    expect(sent).toMatchObject({ ItemID: 'xi-7', Code: 'MSP-OWN', Name: 'Managed Firewall', IsSold: true });
    expect(sent).not.toHaveProperty('IsPurchased');
  });

  it('a mapped item deleted in Xero is not_found + remote_missing — never silently re-created (quorum 6)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 404));
    await expect(upsertXeroItem(ctx, payload(), { remoteEntityId: 'gone', remoteSyncToken: null }, TAX))
      .rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-numeric unit price before any call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(upsertXeroItem(ctx, payload({ unitPrice: 'abc' }), null, TAX)).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces insufficient_scope from the create (Review Focus 5)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer error="insufficent_scope"' } }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toMatchObject({ kind: 'validation', providerCode: 'insufficient_scope' });
  });

  it.each([
    ['list', () => listXeroItems(ctx)],
    ['get', () => getXeroItem(ctx, 'xi-1')],
    ['upsert', () => upsertXeroItem(ctx, payload(), null, TAX)],
  ])('propagates a limiter refusal untouched (%s)', async (_name, call) => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(call()).rejects.toBe(refusal);
  });
});
```

In `xeroProvider.test.ts`: delete the remaining W03 rows (`listRemoteItems`, `listRemoteIncomeAccounts`, `upsertItem`) from the later-waves table, and add:

```ts
describe('items and income accounts (Xero W03)', () => {
  it('upsertItem passes the connection tax defaults', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(json({ Items: [{ ItemID: 'xi-1', Code: 'fw-100-0000000000' }] }));
    await xeroProvider.upsertItem(conn({ defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'EXEMPTOUTPUT' }), {
      catalogItemId: '11111111-2222-4333-8444-555555555555', name: 'FW', sku: 'FW-100', description: null,
      type: 'Service', unitPrice: '10', currencyCode: 'GBP', taxable: false, active: true, incomeAccountRef: '200',
    }, null);
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string).Items[0].SalesDetails)
      .toEqual({ UnitPrice: 10, AccountCode: '200', TaxType: 'EXEMPTOUTPUT' });
  });
  it('listRemoteIncomeAccounts returns the same accounts the settings picker offers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Accounts: [
      { Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' },
      { Code: '260', Name: 'Other Revenue', Type: 'SALES', Status: 'ACTIVE' },
      { Code: '090', Name: 'Bank', Type: 'BANK', Status: 'ACTIVE', AccountID: 'b1' },
      { Code: '201', Name: 'Old', Type: 'REVENUE', Status: 'ARCHIVED' },
      { Name: 'No code', Type: 'REVENUE', Status: 'ACTIVE' },
    ] }));
    await expect(xeroProvider.listRemoteIncomeAccounts(conn())).resolves.toEqual([
      { id: '200', displayName: '200 · Sales', accountType: 'REVENUE' },
      { id: '260', displayName: '260 · Other Revenue', accountType: 'SALES' },
    ]);
  });
  it('has no W03 method left behind a capability_unavailable refusal', async () => {
    // a fresh Response per call: a body reads once
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ Items: [], Contacts: [], Accounts: [] }));
    for (const call of [
      () => xeroProvider.listRemoteCustomers(conn()), () => xeroProvider.listRemoteItems(conn()),
      () => xeroProvider.listRemoteIncomeAccounts(conn()),
    ]) {
      await expect(call()).resolves.toBeDefined();
    }
    expect(fetchMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroItems.test.ts src/services/accounting/xeroProvider.test.ts`
Expected: FAIL — `./xeroItems` does not exist; the item stubs still refuse.

- [ ] **Step 3: Implement `xeroItems.ts`**

```ts
/**
 * Xero items (Xero W03). Items have no external-id field and no archive, so
 * the item Code (≤30, unique) is the only key (refinement 6):
 *   Code = slug(sku || name)[0..19] + '-' + sha256(catalogItemId)[0..10]
 * The adoption lookup reads the whole price list (one unpaged GET) and matches
 * the `-<hash>` SUFFIX, so it survives renames and SKU edits, and it can never
 * pick up an MSP's own item that merely shares a SKU (that one is offered to the
 * user as an exact_sku suggestion instead). More than one suffix hit is refused.
 * Updates read the item first and post back its own Code (a linked item keeps the
 * code its owner chose) and never touch the purchase side.
 */
import { createHash } from 'node:crypto';
import { AccountingProviderError, isAccountingProviderError, refusalCodeOf } from './accountingProviderError';
import {
  parseXeroDate, requireXeroBody, xeroApiGet, xeroApiWrite, xeroArray, xeroQuery, type XeroCallContext,
} from './xeroHttp';
import type { AccountingEntityMapping, AccountingItemPayload, RemoteItem, RemoteRef } from './types';

export interface XeroItem {
  ItemID?: string; Code?: string; Name?: string; Description?: string;
  IsSold?: boolean; IsPurchased?: boolean; IsTrackedAsInventory?: boolean;
  SalesDetails?: { UnitPrice?: number; AccountCode?: string; TaxType?: string };
  UpdatedDateUTC?: string;
}
interface ItemsBody { Items?: XeroItem[] }

export const XERO_ITEM_UNITDP = 4;
const UNITDP = xeroQuery({ unitdp: XERO_ITEM_UNITDP });
const SUFFIX_LEN = 10;
const PREFIX_MAX = 30 - 1 - SUFFIX_LEN; // 19

function normalized(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function xeroItemSuffix(catalogItemId: string): string {
  return createHash('sha256').update(catalogItemId).digest('hex').slice(0, SUFFIX_LEN);
}

export function xeroItemCode(item: Pick<AccountingItemPayload, 'catalogItemId' | 'sku' | 'name'>): string {
  const source = item.sku?.trim() || item.name;
  const prefix = source.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, PREFIX_MAX).replace(/-+$/, '') || 'item';
  return `${prefix}-${xeroItemSuffix(item.catalogItemId)}`;
}

export function xeroItemName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 50).trim();
}

export function toRemoteItem(item: XeroItem): RemoteItem | null {
  if (!item.ItemID) return null;
  const remoteVersion = parseXeroDate(item.UpdatedDateUTC);
  return {
    id: item.ItemID,
    displayName: item.Name?.trim() || item.Code || item.ItemID,
    ...(item.Code ? { sku: item.Code } : {}),
    ...(item.Description ? { description: item.Description } : {}),
    ...(typeof item.SalesDetails?.UnitPrice === 'number' ? { unitPrice: item.SalesDetails.UnitPrice } : {}),
    active: item.IsSold !== false,
    ...(remoteVersion ? { remoteVersion } : {}),
  };
}

function toRef(item: XeroItem | undefined, operation: string): RemoteRef {
  if (!item?.ItemID) {
    throw new AccountingProviderError({ kind: 'transient', provider: 'xero', operation, message: `${operation} returned no item` });
  }
  const remoteVersion = parseXeroDate(item.UpdatedDateUTC);
  return { id: item.ItemID, ...(remoteVersion ? { remoteVersion } : {}) };
}

function remoteMissing(operation: string, cause?: unknown): AccountingProviderError {
  return new AccountingProviderError({
    kind: 'not_found', provider: 'xero', operation, message: `${operation} found no item`, httpStatus: 404, providerCode: 'remote_missing', cause,
  });
}

function itemFields(item: AccountingItemPayload, tax: { taxCodeRef: string | null; exemptTaxCodeRef: string | null }): XeroItem {
  const unitPrice = Number(item.unitPrice);
  if (!Number.isFinite(unitPrice)) {
    throw new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'Xero item payload', message: 'Xero item payload has no numeric unit price' });
  }
  const taxType = item.taxable ? tax.taxCodeRef : tax.exemptTaxCodeRef;
  return {
    Name: xeroItemName(item.name),
    ...(item.description ? { Description: item.description.slice(0, 4000) } : {}),
    IsSold: true,
    SalesDetails: {
      UnitPrice: unitPrice,
      ...(item.incomeAccountRef ? { AccountCode: item.incomeAccountRef } : {}),
      ...(taxType ? { TaxType: taxType } : {}),
    },
  };
}

async function readAllItems(ctx: XeroCallContext, operation: string): Promise<XeroItem[]> {
  // /Items is not paged: one call returns the whole price list.
  return xeroArray<XeroItem>(requireXeroBody(await xeroApiGet<ItemsBody | null>(ctx, `Items${UNITDP}`, operation), operation).Items);
}

export async function listXeroItems(ctx: XeroCallContext, query?: string): Promise<RemoteItem[]> {
  const items = (await readAllItems(ctx, 'Xero item list')).map(toRemoteItem).filter((i): i is RemoteItem => i !== null);
  const q = normalized(query);
  if (!q) return items;
  return items.filter((i) => [i.displayName, i.sku, i.description].some((v) => normalized(v).includes(q)));
}

async function readItem(ctx: XeroCallContext, itemId: string): Promise<XeroItem | null> {
  const operation = 'Xero item read';
  let body: ItemsBody | null;
  try {
    body = await xeroApiGet<ItemsBody | null>(ctx, `Items/${encodeURIComponent(itemId)}${UNITDP}`, operation);
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') return null;
    throw err;
  }
  return xeroArray<XeroItem>(requireXeroBody(body, operation).Items)[0] ?? null;
}

export async function getXeroItem(ctx: XeroCallContext, itemId: string): Promise<RemoteItem | null> {
  const item = await readItem(ctx, itemId);
  return item ? toRemoteItem(item) : null;
}

/** Every item whose Code ends in `-<suffix>` (case-insensitive): ours by construction. */
async function findOurItems(ctx: XeroCallContext, suffix: string): Promise<XeroItem[]> {
  const tail = `-${suffix}`.toLowerCase();
  return (await readAllItems(ctx, 'Xero item lookup')).filter((i) => i.ItemID && i.Code?.toLowerCase().endsWith(tail));
}

async function updateItem(ctx: XeroCallContext, existing: XeroItem, fields: XeroItem): Promise<RemoteRef> {
  const operation = 'Xero item update';
  const itemId = existing.ItemID as string;
  let body: ItemsBody | null;
  try {
    body = await xeroApiWrite<ItemsBody | null>(
      ctx, 'POST', `Items/${encodeURIComponent(itemId)}${UNITDP}`, { Items: [{ ItemID: itemId, Code: existing.Code, ...fields }] }, operation,
    );
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'not_found') throw remoteMissing(operation, err);
    throw err;
  }
  return toRef(xeroArray<XeroItem>(requireXeroBody(body, operation).Items)[0], operation);
}

function shouldLookAgain(err: unknown): boolean {
  return (isAccountingProviderError(err) && err.kind === 'transient') || refusalCodeOf(err) === 'duplicate_key';
}

function ambiguous(suffix: string): AccountingProviderError {
  return new AccountingProviderError({
    kind: 'validation', provider: 'xero', operation: 'Xero item adoption',
    message: `Xero has more than one item whose code ends in -${suffix}`, providerCode: 'duplicate_key',
  });
}

export async function upsertXeroItem(
  ctx: XeroCallContext,
  item: AccountingItemPayload,
  mapping: AccountingEntityMapping | null,
  tax: { taxCodeRef: string | null; exemptTaxCodeRef: string | null },
): Promise<RemoteRef> {
  const fields = itemFields(item, tax);
  if (mapping) {
    const existing = await readItem(ctx, mapping.remoteEntityId);
    if (!existing?.ItemID) throw remoteMissing('Xero item update');
    return updateItem(ctx, existing, fields);
  }

  const suffix = xeroItemSuffix(item.catalogItemId);
  const ours = await findOurItems(ctx, suffix);
  if (ours.length > 1) throw ambiguous(suffix);
  if (ours.length === 1) return updateItem(ctx, ours[0]!, fields);

  const operation = 'Xero item create';
  try {
    const body = requireXeroBody(await xeroApiWrite<ItemsBody | null>(
      ctx, 'PUT', `Items${UNITDP}`, { Items: [{ Code: xeroItemCode(item), IsPurchased: false, ...fields }] }, operation,
    ), operation);
    return toRef(xeroArray<XeroItem>(body.Items)[0], operation);
  } catch (err) {
    if (!shouldLookAgain(err)) throw err;
    const landed = await findOurItems(ctx, suffix).catch(() => [] as XeroItem[]);
    if (landed.length === 1) return updateItem(ctx, landed[0]!, fields);
    if (landed.length > 1) throw ambiguous(suffix);
    throw err;
  }
}
```

- [ ] **Step 4: Wire the provider and share the income-account filter**

In `xeroProvider.ts`, import `getXeroItem, listXeroItems, upsertXeroItem` from `./xeroItems`. Extract the income-account filter from `listSettingsOptions` into:

```ts
/** Revenue accounts an invoice line or item can post to. Shared by the settings picker and the workbench listing. */
function incomeAccountOptions(accounts: XeroAccount[]): ProviderSettingsOption[] {
  return accounts
    .filter((a) => a.Status === 'ACTIVE' && (a.Type === 'REVENUE' || a.Type === 'SALES') && a.Code)
    .map((a) => ({ ref: a.Code as string, label: a.Name ? `${a.Code} · ${a.Name}` : (a.Code as string), detail: a.Type ?? null }));
}
```

In `listSettingsOptions`, replace the inline `incomeAccounts: active.filter(...).map(...)` with `incomeAccounts: incomeAccountOptions(accounts)`. Replace the three stubs:

```ts
  async listRemoteItems(conn: AccountingConnection, query?: string): Promise<RemoteItem[]> {
    return listXeroItems(callContext(conn), query);
  }

  async getRemoteItem(conn: AccountingConnection, id: string): Promise<RemoteItem | null> {
    return getXeroItem(callContext(conn), id);
  }

  async listRemoteIncomeAccounts(conn: AccountingConnection): Promise<RemoteIncomeAccount[]> {
    const operation = 'Xero account list';
    const body = requireXeroBody(await xeroApiGet<{ Accounts?: XeroAccount[] } | null>(callContext(conn), 'Accounts', operation), operation);
    return incomeAccountOptions(xeroArray<XeroAccount>(body.Accounts))
      .map((o) => ({ id: o.ref, displayName: o.label, accountType: o.detail ?? 'REVENUE' }));
  }

  async upsertItem(
    conn: AccountingConnection,
    item: AccountingItemPayload,
    mapping: AccountingEntityMapping | null,
  ): Promise<RemoteRef> {
    return upsertXeroItem(callContext(conn), item, mapping, {
      taxCodeRef: conn.defaultTaxCodeRef,
      exemptTaxCodeRef: conn.defaultExemptTaxCodeRef,
    });
  }
```

- [ ] **Step 5: Run the Xero suites, the guard, typecheck, and the provider line count**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroItems.test.ts src/services/accounting/xeroContacts.test.ts src/services/accounting/xeroProvider.test.ts src/services/accounting/xeroHttp.test.ts src/services/accounting/neutralCore.guard.test.ts && npx tsc --noEmit -p . && wc -l src/services/accounting/xeroProvider.ts`
Expected: PASS; tsc clean; `xeroProvider.ts` stays under ~260 lines (it only delegates).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/accounting/xeroItems.ts apps/api/src/services/accounting/xeroItems.test.ts apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts
git commit -m "feat(accounting): Xero items — hash-suffix codes, suffix adoption, read-before-update, income accounts (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Mapping service — coded refusals, single-record confirm, provider-labelled messages; worker terminal codes; error-response module

**Files:**
- Modify: `apps/api/src/services/accounting/accountingProviderError.ts` (`providerPermissionMessage`)
- Modify: `apps/api/src/services/accounting/accountingMappingService.ts`
- Modify: `apps/api/src/jobs/accountingSyncWorker.ts` (`MAPPING_TERMINAL_CODES`)
- Create: `apps/api/src/routes/accounting/errorResponses.ts`, `errorResponses.test.ts`
- Modify: `apps/api/src/routes/accounting/index.ts` (import the moved helpers; `archived` on remote candidates)
- Test: `accountingMappingService.test.ts`, `jobs/accountingSyncWorker.test.ts`, `routes/accounting/invoicePush.test.ts` (its remote-candidates block, `:506`)

**Interfaces:**
- Consumes: Task 1 (`refusalCodeOf`, `getRemoteCustomer?`, `getRemoteItem?`), M4–M7, M9, B2.
- Produces:
  ```ts
  // accountingProviderError.ts
  export function providerPermissionMessage(label: string): string;
  // accountingMappingService.ts
  export type AccountingMappingErrorCode = … | 'duplicate_name' | 'remote_archived' | 'remote_missing' | 'provider_permission';
  export class AccountingMappingError { readonly details?: Readonly<Record<string, string>>; /* opts gains details? */ }
  // routes/accounting/errorResponses.ts
  export function setRetryAfter(c: Context, err: unknown): number | null;
  export function handleImportError(c: Context, err: unknown): Response;
  export function handleMappingError(c: Context, err: unknown): Response; // body gains `details` when set; a raw insufficient_scope → 409 provider_permission
  // jobs/accountingSyncWorker.ts
  const MAPPING_USER_RESOLVABLE_CODES: ReadonlySet<AccountingMappingErrorCode>; // terminal AND no Sentry capture
  ```
- Response contract used by W03b: a 409 `{ error, code: 'duplicate_name', details: { remoteName } }` from `POST /:provider/mappings/sync`; `GET /:provider/remote-candidates` rows gain `archived: boolean`.

- [ ] **Step 1: Write the failing tests**

In `accountingMappingService.test.ts`:

1. Make the mocked provider extensible. Add `providerExtras` to the `vi.hoisted` block (`providerExtras: {} as Record<string, unknown>`), change the registry mock to `getAccountingProvider: () => ({ listRemoteCustomers: listRemoteCustomersMock, …existing…, ...providerExtras })`, and in the file's top-level `beforeEach` add `for (const k of Object.keys(providerExtras)) delete providerExtras[k];`. (`AccountingProviderError` is already imported at `:107` — do not import it again.)

2. Append:

```ts
describe('provider refusals the user resolves (Xero W03)', () => {
  const refusal = (providerCode: string) =>
    new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'Xero contact update', httpStatus: 400, providerCode });

  beforeEach(() => {
    getConnectionMock.mockResolvedValue(connectedConn({ provider: 'xero' }));
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ linkStatus: 'confirmed', remoteEntityId: 'xc-1', remoteSyncToken: null, syncStatus: 'synced' })],
    });
  });

  it('duplicate_name → 409 with the name in details, persisted, no Sentry (Review Focus 2)', async () => {
    upsertCustomerMock.mockRejectedValueOnce(refusal('duplicate_name'));
    const err: unknown = await syncMappedEntity(syncOrg({ provider: 'xero' }), runCtx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'duplicate_name', status: 409, details: { remoteName: 'Acme' },
      message: 'Xero already has a customer named "Acme" — link this organization to it instead of creating a new one',
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
    expect(currentMappingRows.find((r) => r.id === 'm1')).toMatchObject({ syncStatus: 'error', lastError: (err as Error).message });
  });

  it('remote_archived → 409 remote_archived', async () => {
    upsertCustomerMock.mockRejectedValueOnce(refusal('remote_archived'));
    await expect(syncMappedEntity(syncOrg({ provider: 'xero' }), runCtx)).rejects.toMatchObject({
      code: 'remote_archived', status: 409,
      message: 'The Xero customer for "Acme" is archived — restore it in Xero, then sync again',
    });
  });

  it('remote_missing → 409 remote_missing (a mapped record deleted in the provider)', async () => {
    upsertCustomerMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'not_found', provider: 'xero', operation: 'Xero contact update', httpStatus: 404, providerCode: 'remote_missing' }));
    await expect(syncMappedEntity(syncOrg({ provider: 'xero' }), runCtx)).rejects.toMatchObject({
      code: 'remote_missing', status: 409,
      message: 'The Xero customer linked to "Acme" no longer exists — unlink it and map it again',
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('a bare not_found (e.g. QuickBooks 610) is still the sanitized 502 — QuickBooks unchanged', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ provider: 'quickbooks' }));
    upsertCustomerMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'not_found', provider: 'quickbooks', operation: 'QuickBooks customer upsert', httpStatus: 400, providerCode: '610' }));
    await expect(syncMappedEntity(syncOrg(), runCtx)).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  });

  it('duplicate_key (two provider records claim this item) → 409 mapping_conflict', async () => {
    upsertCustomerMock.mockRejectedValueOnce(refusal('duplicate_key'));
    await expect(syncMappedEntity(syncOrg({ provider: 'xero' }), runCtx)).rejects.toMatchObject({ code: 'mapping_conflict', status: 409 });
  });

  it('insufficient_scope → 409 provider_permission (Review Focus 5)', async () => {
    upsertCustomerMock.mockRejectedValueOnce(refusal('insufficient_scope'));
    await expect(syncMappedEntity(syncOrg({ provider: 'xero' }), runCtx)).rejects.toMatchObject({
      code: 'provider_permission', status: 409,
      message: 'Xero did not grant Breeze access to this data — reconnect Xero and approve every requested permission',
    });
  });

  it('a QuickBooks validation fault (e.g. 6240 duplicate name) is still the sanitized 502 — QuickBooks unchanged', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ provider: 'quickbooks' }));
    upsertCustomerMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'validation', provider: 'quickbooks', operation: 'QuickBooks customer upsert', httpStatus: 400, providerCode: '6240' }));
    await expect(syncMappedEntity(syncOrg(), runCtx)).rejects.toMatchObject({
      code: 'provider_error', status: 502, message: 'QuickBooks rejected the customer sync (HTTP 400)',
    });
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('a listing refused for scope → 409 provider_permission, not a 502', async () => {
    listRemoteItemsMock.mockRejectedValueOnce(refusal('insufficient_scope'));
    await expect(listMappingProposals({ partnerId: PARTNER, provider: 'xero', entityType: 'catalog_item' }, runCtx))
      .rejects.toMatchObject({ code: 'provider_permission', status: 409 });
  });
});

describe('confirm reads one record when the provider can (Xero W03)', () => {
  it('uses getRemoteCustomer instead of listing every customer', async () => {
    const getRemoteCustomer = vi.fn().mockResolvedValue({ id: 'xc-1', displayName: 'Acme', remoteVersion: '2026-09-27T10:00:00.000Z', currencyCode: 'GBP' });
    providerExtras.getRemoteCustomer = getRemoteCustomer;
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    const row = await saveMappingDecision(confirmOrg('xc-1'), runCtx);
    expect(getRemoteCustomer).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }), 'xc-1');
    expect(listRemoteCustomersMock).not.toHaveBeenCalled();
    expect(row).toMatchObject({ remoteEntityId: 'xc-1', remoteSyncToken: '2026-09-27T10:00:00.000Z', remoteCurrencyCode: 'GBP' });
  });
  it('a null single read is entity_not_found (404)', async () => {
    providerExtras.getRemoteCustomer = vi.fn().mockResolvedValue(null);
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    await expect(saveMappingDecision(confirmOrg('xc-9'), runCtx)).rejects.toMatchObject({ code: 'entity_not_found', status: 404 });
  });
  it('uses getRemoteItem for a catalog item', async () => {
    const getRemoteItem = vi.fn().mockResolvedValue({ id: 'xi-1', displayName: 'Widget', remoteVersion: '2026-09-27T10:00:00.000Z' });
    providerExtras.getRemoteItem = getRemoteItem;
    stubReads({ items: [{ id: ITEM_A, name: 'Widget', sku: 'W-1' }] });
    await saveMappingDecision({
      partnerId: PARTNER, provider: 'quickbooks', breezeEntityType: 'catalog_item', breezeEntityId: ITEM_A, decision: 'confirmed', remoteEntityId: 'xi-1',
    }, runCtx);
    expect(getRemoteItem).toHaveBeenCalledWith(expect.anything(), 'xi-1');
    expect(listRemoteItemsMock).not.toHaveBeenCalled();
  });
});

describe('operator messages name the connected provider (Xero W03)', () => {
  it('entity_not_found names Xero for a Xero connection', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ provider: 'xero' }));
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([]);
    await expect(saveMappingDecision(confirmOrg('xc-9', { provider: 'xero' }), runCtx))
      .rejects.toMatchObject({ code: 'entity_not_found', message: 'Xero Customer xc-9 was not found' });
  });
  it('no string literal in the mapping or import service names QuickBooks', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const file of ['accountingMappingService.ts', 'accountingCustomerImport.ts']) {
      const code = readFileSync(join(__dirname, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect({ file, hits: code.match(/.*QuickBooks.*/g) ?? [] }).toEqual({ file, hits: [] });
    }
  });
});
```

(`confirmOrg(id, overrides)` already accepts overrides; `ITEM_A`, `PARTNER`, `currentMappingRows` are the file's existing fixtures.)

In `jobs/accountingSyncWorker.test.ts`, add a **separate** test next to the "does not retry terminal %s" `it.each` (`:536`) — do not extend that list, because it asserts the Sentry capture that these codes must skip (refinement 20). Copy its setup verbatim and change only the codes and the capture assertion:

```ts
  it.each<AccountingMappingErrorCode>(['duplicate_name', 'remote_archived', 'remote_missing', 'provider_permission'])(
    'does not retry user-resolvable %s and does not report it to Sentry (Xero W03)',
    async (code) => {
      // …same arrange/act as the terminal test above, with new AccountingMappingError(code, 409, 'x')…
      // expect(<the job promise>).resolves (not rethrown), exactly as the terminal test asserts
      expect(captureExceptionMock).not.toHaveBeenCalled();
    },
  );
```

(Use the terminal test's real mock names; the two assertions are fixed.)

`routes/accounting/errorResponses.test.ts`:

```ts
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AccountingImportError } from '../../services/accounting/accountingCustomerImport';
import { AccountingMappingError } from '../../services/accounting/accountingMappingService';
import { handleImportError, handleMappingError } from './errorResponses';

function appThrowing(err: unknown, handler: typeof handleMappingError) {
  const app = new Hono();
  app.get('/', (c) => handler(c, err));
  return app;
}

describe('handleMappingError', () => {
  it('passes details through when the error carries them', async () => {
    const res = await appThrowing(new AccountingMappingError('duplicate_name', 409, 'dup', { details: { remoteName: 'Acme' } }), handleMappingError).request('/');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'dup', code: 'duplicate_name', details: { remoteName: 'Acme' } });
  });
  it('keeps the old body exactly when there are no details', async () => {
    const res = await appThrowing(new AccountingMappingError('mapping_conflict', 409, 'x'), handleMappingError).request('/');
    expect(await res.json()).toEqual({ error: 'x', code: 'mapping_conflict' });
  });
});

describe('handleMappingError — raw provider refusals (remote-candidates calls the provider directly)', () => {
  it('maps a raw insufficient_scope to 409 provider_permission instead of a 500', async () => {
    const { AccountingProviderError } = await import('../../services/accounting/accountingProviderError');
    const err = new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'Xero contact list', providerCode: 'insufficient_scope', httpStatus: 401 });
    const res = await appThrowing(err, handleMappingError).request('/');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Xero did not grant Breeze access to this data — reconnect Xero and approve every requested permission',
      code: 'provider_permission',
    });
  });
});

describe('handleImportError', () => {
  it('answers 429 with Retry-After in whole seconds', async () => {
    const res = await appThrowing(new AccountingImportError('slow down', 'rate_limited', 429, { retryAfterMs: 1500 }), handleImportError).request('/');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('2');
    expect(await res.json()).toEqual({ error: 'slow down', code: 'rate_limited' });
  });
  it('answers daily_budget_low with no Retry-After', async () => {
    const res = await appThrowing(new AccountingImportError('later', 'daily_budget_low', 429), handleImportError).request('/');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});
```

(The two `handleImportError` tests need Task 6's `AccountingImportError` changes; write them now, they go green in Task 6.)

The remote-candidates route is tested in `routes/accounting/invoicePush.test.ts` (its `describe` at `:506`), not `mappings.test.ts`. Adding `archived` changes the row shape, so first update the two existing exact assertions there — `:518` becomes `{ id, displayName, email, currencyCode, archived: false }` and `:531` becomes `{ id, displayName, sku, archived: false }` (QuickBooks lists active rows only, so `archived` is always `false` for it) — then add, inside that `describe`, using its own request helper and provider mock:

```ts
it('marks archived remote candidates (Xero W03)', async () => {
  // provider listRemoteCustomers mock returns: [{ id: 'a', displayName: 'Live', active: true }, { id: 'b', displayName: 'Old', active: false }]
  // GET /accounting/quickbooks/remote-candidates?entityType=org&q=ol
  // expect body.data toEqual [
  //   { id: 'a', displayName: 'Live', email: null, currencyCode: null, archived: false },
  //   { id: 'b', displayName: 'Old', email: null, currencyCode: null, archived: true },
  // ]
});
```

Write the body with the file's real helper; the assertion is exactly the commented `toEqual`. Record the two edited assertions in the PR body next to the declared `archived` change.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingMappingService.test.ts src/jobs/accountingSyncWorker.test.ts src/routes/accounting/errorResponses.test.ts src/routes/accounting/invoicePush.test.ts`
Expected: FAIL — unknown codes, `details` absent, `errorResponses` missing, messages still say QuickBooks, confirm lists every customer.

- [ ] **Step 3: Implement the service changes**

`accountingProviderError.ts`, next to `providerRateLimitedTryAgainMessage`:

```ts
/** A scope/permission refusal: only reconnecting (and approving every permission) fixes it. */
export function providerPermissionMessage(label: string): string {
  return `${label} did not grant Breeze access to this data — reconnect ${label} and approve every requested permission`;
}
```

`accountingMappingService.ts`:

a) Append to `AccountingMappingErrorCode` (after `'rate_limited'` and W02b's `'capability_unavailable'`):

```ts
  // Xero W03 — provider verdicts only the user can resolve (409, terminal, never Sentry):
  // a same-named remote record exists (`details.remoteName`), the record Breeze would
  // adopt (or is mapped to) is archived, the mapped record no longer exists, or the
  // grant lacks the scope for this call.
  | 'duplicate_name'
  | 'remote_archived'
  | 'remote_missing'
  | 'provider_permission'
```

b) `AccountingMappingError` gains `readonly details?: Readonly<Record<string, string>>;`, its `opts` type gains `details?: Readonly<Record<string, string>>`, and the constructor sets `this.details = opts.details;`.

c) In `callProviderOrThrow`, before `captureException`:

```ts
    if (refusalCodeOf(err) === 'insufficient_scope' && isAccountingProviderError(err)) {
      throw new AccountingMappingError('provider_permission', 409, providerPermissionMessage(accountingProviderDisplayName(err.provider)), { cause: err });
    }
```

d) Add near `sanitizeSyncErrorMessage`:

```ts
/**
 * A provider verdict that is the USER's to resolve, not an upstream fault (Xero W03):
 * persisted on the row, answered 409, terminal in the worker, never sent to Sentry.
 * Null for everything else — including every QuickBooks fault, which carries its own
 * fault number in providerCode, never one of these neutral codes.
 */
function providerRefusal(err: unknown, entityType: MappingEntityType, label: string, breezeName: string): AccountingMappingError | null {
  const noun = entityType === 'org' ? 'customer' : 'item';
  const local = entityType === 'org' ? 'organization' : 'catalog item';
  switch (refusalCodeOf(err)) {
    case 'duplicate_name':
      return new AccountingMappingError('duplicate_name', 409,
        `${label} already has a ${noun} named "${breezeName}" — link this ${local} to it instead of creating a new one`,
        { details: { remoteName: breezeName }, cause: err });
    case 'remote_archived':
      return new AccountingMappingError('remote_archived', 409,
        `The ${label} ${noun} for "${breezeName}" is archived — restore it in ${label}, then sync again`, { cause: err });
    case 'remote_missing':
      return new AccountingMappingError('remote_missing', 409,
        `The ${label} ${noun} linked to "${breezeName}" no longer exists — unlink it and map it again`, { cause: err });
    case 'duplicate_key':
      // Reuses the existing terminal conflict code: more than one remote record claims this entity.
      return new AccountingMappingError('mapping_conflict', 409,
        `${label} has more than one ${noun} that could be this ${local} — link the right one explicitly`, { cause: err });
    case 'insufficient_scope':
      return new AccountingMappingError('provider_permission', 409, providerPermissionMessage(label), { cause: err });
    default:
      return null;
  }
}
```

e) In the `syncMappedEntity` failure block (M6), after `if (err instanceof AccountingMappingError) throw err;`, compute the refusal first and let it take precedence over the throttle/sanitize branches:

```ts
    const providerLabel = accountingProviderDisplayName(conn.provider);
    const refusal = providerRefusal(err, breezeEntityType, providerLabel, prep.kind === 'org' ? prep.payload.displayName : prep.payload.name);
    const retryAfterMs = refusal ? null : rateLimitRetryAfterMs(err);
    const throttleSource = rateLimitSourceOf(err) ?? undefined;
    const message = refusal?.message ?? (retryAfterMs !== null
      ? providerRateLimitedRetryLaterMessage(providerLabel, 'sync', throttleSource)
      : sanitizeSyncErrorMessage(err, breezeEntityType, providerLabel));
    if (!refusal && retryAfterMs === null) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        service: 'accountingMappingService', accounting_mapping_id: mapping.id, breeze_entity_type: breezeEntityType,
      });
    }
```

Keep the existing `markMappingError` try/catch unchanged, then before the existing `if (retryAfterMs !== null)` throw add `if (refusal) throw refusal;`.

f) In `saveMappingDecision`'s `confirmed` branch, replace the list-and-find with:

```ts
    const liveConn = await resolveLiveConnection(conn);
    const remoteProvider = getAccountingProvider(conn.provider);
    const providerLabel = accountingProviderDisplayName(conn.provider);
    const found: RemoteCustomer | RemoteItem | null = await callProviderOrThrow(
      async () => {
        // One record when the provider can (Xero W03 refinement 15); the whole list otherwise (QuickBooks).
        if (remoteEntityType === 'Customer' && remoteProvider.getRemoteCustomer) return remoteProvider.getRemoteCustomer(liveConn, remoteEntityId);
        if (remoteEntityType === 'Item' && remoteProvider.getRemoteItem) return remoteProvider.getRemoteItem(liveConn, remoteEntityId);
        const list: Array<RemoteCustomer | RemoteItem> = remoteEntityType === 'Customer'
          ? await remoteProvider.listRemoteCustomers(liveConn)
          : await remoteProvider.listRemoteItems(liveConn);
        return list.find((r) => r.id === remoteEntityId) ?? null;
      },
      `${providerLabel} returned an error while listing ${remoteEntityType === 'Customer' ? 'customers' : 'items'}`,
    );
    if (!found) {
      throw new AccountingMappingError('entity_not_found', 404, `${providerLabel} ${remoteEntityType} ${remoteEntityId} was not found`);
    }
```

(Import `RemoteItem` from `./types` if it is not imported yet.)

g) **Label every remaining operator string (refinement 21).** Run `grep -n "QuickBooks" src/services/accounting/accountingMappingService.ts`. For each hit inside a string literal (not a comment), replace the word `QuickBooks` with `${providerLabel}` — **never `${label}`**: `label` already names the entity noun in this file (`:1142`), and reusing it would silently change QuickBooks text. Change no other word; convert `'…'` literals to template literals where needed. Where `conn`/`input.provider` is in scope, declare `const providerLabel = accountingProviderDisplayName(conn.provider);` (or `(input.provider)`) at the top of that function. Three helpers build messages with no provider in scope — `upsertMappingRow` (`:852`, the `mapping_conflict` text), `resolveItemSellPrice` (`:1088`, `item_price_required`) and `persistRemoteRef` (`:1232`, the `record_failed`/persist text): give each a trailing `providerLabel: string` parameter and pass `accountingProviderDisplayName(conn.provider)` from every call site (`grep -n "upsertMappingRow(\|resolveItemSellPrice(\|persistRemoteRef(" src/services/accounting/accountingMappingService.ts`). The QuickBooks output is byte-identical, which the existing assertions prove — they must pass **without edits**; if one needs an edit, the replacement is wrong. Record the changed lines in the PR body.

h) Import `refusalCodeOf` and `providerPermissionMessage` from `./accountingProviderError`.

`jobs/accountingSyncWorker.ts`: add `'duplicate_name', 'remote_archived', 'remote_missing', 'provider_permission'` to `MAPPING_TERMINAL_CODES`, and add next to it:

```ts
/**
 * Terminal refusals the USER resolves in the workbench (Xero W03): logged, never
 * retried, and not reported to Sentry — they are expected outcomes, not incidents.
 * Every other terminal code keeps its capture (QuickBooks telemetry unchanged).
 */
const MAPPING_USER_RESOLVABLE_CODES: ReadonlySet<AccountingMappingErrorCode> = new Set([
  'duplicate_name', 'remote_archived', 'remote_missing', 'provider_permission',
]);
```

and in the terminal branch (`:266-271`) wrap the existing `captureException(err, undefined, {…})` in `if (!MAPPING_USER_RESOLVABLE_CODES.has(err.code)) { … }`, keeping the `console.error` line.

- [ ] **Step 4: Extract the route error helpers**

Create `routes/accounting/errorResponses.ts` by **moving** `setRetryAfter`, `handleImportError` and `handleMappingError` out of `index.ts` verbatim (with their comments and imports), exporting all three, then:

```ts
export function handleImportError(c: Context, err: unknown): Response {
  if (err instanceof AccountingImportError) {
    // Only a provider/limiter throttle carries retryAfterMs; daily_budget_low deliberately
    // does not (Xero's day window is per-tenant and not UTC-midnight).
    if (err.retryAfterMs !== undefined) c.header('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}
```

and in `handleMappingError` change the first return to:

```ts
    return c.json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status);
```

and, before the existing raw-throttle branch, translate a raw scope refusal (`remote-candidates` calls the provider directly, so it never passes through `callProviderOrThrow`):

```ts
  if (refusalCodeOf(err) === 'insufficient_scope' && isAccountingProviderError(err)) {
    return c.json({ error: providerPermissionMessage(accountingProviderDisplayName(err.provider)), code: 'provider_permission' }, 409);
  }
```

(import `refusalCodeOf` and `providerPermissionMessage` from `../../services/accounting/accountingProviderError` alongside the helpers the moved code already imports).

In `index.ts`, import the three from `./errorResponses` (every other caller of `setRetryAfter` keeps working), and in the `remote-candidates` handler add `archived: r.active === false` to both row shapes:

```ts
        ? (await runOutsideDbContext(() => providerImpl.listRemoteCustomers(liveConn, q))).map((r) => ({
          id: r.id, displayName: r.displayName, email: r.email ?? null, currencyCode: r.currencyCode ?? null, archived: r.active === false,
        }))
        : (await runOutsideDbContext(() => providerImpl.listRemoteItems(liveConn, q))).map((r) => ({
          id: r.id, displayName: r.displayName, sku: r.sku ?? null, archived: r.active === false,
        }));
```

- [ ] **Step 5: Run the tests, typecheck and the line-count rule**

Run: `cd apps/api && npx vitest run src/services/accounting src/jobs/accountingSyncWorker.test.ts src/routes/accounting && npx tsc --noEmit -p . && wc -l src/routes/accounting/index.ts`
Expected: all pass except the two `handleImportError` tests (they need Task 6); tsc may flag `new AccountingImportError(…, 429, …)` in the test file — also Task 6. `index.ts` is shorter than its Task 0 count. **Every QuickBooks message assertion passed without an edit.**

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/accounting/accountingProviderError.ts apps/api/src/services/accounting/accountingMappingService.ts apps/api/src/services/accounting/accountingMappingService.test.ts apps/api/src/jobs/accountingSyncWorker.ts apps/api/src/jobs/accountingSyncWorker.test.ts apps/api/src/routes/accounting/errorResponses.ts apps/api/src/routes/accounting/errorResponses.test.ts apps/api/src/routes/accounting/index.ts apps/api/src/routes/accounting/invoicePush.test.ts
git commit -m "feat(accounting): user-resolvable provider refusals, single-record confirm, provider-labelled mapping messages (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Customer import — throttle 429, permission 409, daily-budget deferral, neutral Sentry prefix

**Files:**
- Modify: `apps/api/src/services/accounting/accountingCustomerImport.ts`
- Test: `accountingCustomerImport.test.ts`, `routes/accounting/errorResponses.test.ts` (already written), `routes/accounting/customers.test.ts`

**Interfaces:**
- Consumes: Task 5 (`providerPermissionMessage`, `handleImportError`), M8, M10.
- Produces:
  ```ts
  export type AccountingImportErrorCode = 'not_connected' | 'reauth_required' | 'provider_error' | 'capability_unavailable'
    | 'rate_limited' | 'daily_budget_low' | 'provider_permission';
  type AccountingImportErrorStatus = 400 | 404 | 409 | 429 | 502;
  export class AccountingImportError extends Error {
    readonly retryAfterMs?: number;
    constructor(message: string, code: AccountingImportErrorCode, status: AccountingImportErrorStatus, opts?: { retryAfterMs?: number });
  }
  ```

- [ ] **Step 1: Write the failing tests**

In `accountingCustomerImport.test.ts`:

1. Give the registry mock's provider a `limits` member and mock the limiter:

```ts
const { shouldDeferMock } = vi.hoisted(() => ({ shouldDeferMock: vi.fn(async () => false) }));
vi.mock('./accountingRateLimit', () => ({ shouldDeferBackgroundWork: shouldDeferMock }));
// in the existing registry mock:
//   getAccountingProvider: () => ({ listRemoteCustomers: listRemoteCustomersMock, limits: { paymentRefMax: 21, rate: RATE } }),
// with `const RATE = { perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5, appWide: null, dailyPerConnection: { limit: () => 1000 } };` hoisted alongside.
```

2. Append (reuse the file's connection/token fixtures — its partner id is `'p1'`, `accountingCustomerImport.test.ts:75`; `AccountingProviderError` imported from `./accountingProviderError`):

```ts
describe('import throttling, permissions and budget (Xero W03)', () => {
  it('maps a provider throttle to 429 rate_limited with retryAfterMs, no Sentry', async () => {
    listRemoteCustomersMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'Xero contact list', retryAfterMs: 30_000, throttleSource: 'provider' }));
    const err = await listAccountingCustomersAnnotated('p1', 'quickbooks').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 30_000 });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
  it('maps insufficient_scope to 409 provider_permission', async () => {
    listRemoteCustomersMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'op', providerCode: 'insufficient_scope' }));
    await expect(listAccountingCustomersAnnotated('p1', 'quickbooks')).rejects.toMatchObject({ code: 'provider_permission', status: 409 });
  });
  it('maps a throttled token refresh to 429 rate_limited instead of an HTTP 500 (quorum 11)', async () => {
    getValidAccessTokenMock.mockRejectedValueOnce(new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'Xero token refresh', retryAfterMs: 5_000, throttleSource: 'provider' }));
    await expect(listAccountingCustomersAnnotated('p1', 'quickbooks')).rejects.toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 5_000 });
  });
  it('defers below 20% of the daily budget before refreshing a token or listing', async () => {
    shouldDeferMock.mockResolvedValueOnce(true);
    await expect(listAccountingCustomersAnnotated('p1', 'quickbooks')).rejects.toMatchObject({ code: 'daily_budget_low', status: 429, retryAfterMs: undefined });
    expect(getValidAccessTokenMock).not.toHaveBeenCalled();
    expect(listRemoteCustomersMock).not.toHaveBeenCalled();
  });
  it('asks the limiter with the provider\'s own rate spec and the connection id', async () => {
    listRemoteCustomersMock.mockResolvedValueOnce([]);
    await listAccountingCustomersAnnotated('p1', 'quickbooks');
    expect(shouldDeferMock).toHaveBeenCalledWith('quickbooks', RATE, expect.any(String));
  });
  it('tags a non-Error seam failure with the neutral prefix', async () => {
    // Drive one commit row to a `write-failed` seam error whose `cause` is not an Error,
    // using the file's existing seam-failure setup (see "records a per-customer error…").
    // expect(captureExceptionMock).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/^\[accounting-import:quickbooks\] /) }))
  });
});
```

Write the last test's body with the file's existing seam-failure helper; the assertion is the commented `expect`.

In `routes/accounting/customers.test.ts`, first widen the file's stand-in `AccountingImportError` (`:8`, a 3-argument class) to `constructor(m, c, s, opts?: { retryAfterMs?: number })` assigning `this.retryAfterMs = opts?.retryAfterMs` — otherwise the fourth argument is dropped and no `Retry-After` can appear. Then add: a service rejection `new AccountingImportError('slow', 'rate_limited', 429, { retryAfterMs: 2000 })` from the mocked `listAccountingCustomersAnnotated` → `GET /accounting/quickbooks/customers` answers 429 with `Retry-After: 2` and `{ error: 'slow', code: 'rate_limited' }`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingCustomerImport.test.ts src/routes/accounting/customers.test.ts src/routes/accounting/errorResponses.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `accountingCustomerImport.ts`:

```ts
import {
  isAccountingProviderError, providerPermissionMessage, providerRateLimitedTryAgainMessage,
  rateLimitRetryAfterMs, rateLimitSourceOf, refusalCodeOf,
} from './accountingProviderError';
import { shouldDeferBackgroundWork } from './accountingRateLimit';

export type AccountingImportErrorCode =
  | 'not_connected' | 'reauth_required' | 'provider_error' | 'capability_unavailable'
  // Xero W03: a provider/limiter throttle (Retry-After), the daily budget reserved for
  // pushes, and a grant that lacks the scope.
  | 'rate_limited' | 'daily_budget_low' | 'provider_permission';
type AccountingImportErrorStatus = 400 | 404 | 409 | 429 | 502;

export class AccountingImportError extends Error {
  /** Set on `rate_limited` only. */
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    readonly code: AccountingImportErrorCode,
    readonly status: AccountingImportErrorStatus,
    opts: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'AccountingImportError';
    this.retryAfterMs = opts.retryAfterMs;
  }
}
```

In `fetchCustomers`, after the `reauth_required` check and **before** `getValidAccessToken`:

```ts
  // Import paging is background-class work (spec "Rate limiting"): below 20% of the
  // provider's daily budget it waits, so invoice and payment pushes keep the budget.
  // Providers without a daily budget (QuickBooks) never defer.
  if (await shouldDeferBackgroundWork(provider, getAccountingProvider(provider).limits.rate, conn.id)) {
    throw new AccountingImportError(
      `${label}'s daily API allowance for this organisation is nearly used up — customer import is paused so invoice and payment sync keep working. Try again later.`,
      'daily_budget_low', 429,
    );
  }
```

Extend the token-refresh `catch` (today it maps only `ReauthRequiredError` and rethrows everything else, so a throttled refresh escapes as a 500):

```ts
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      throw new AccountingImportError(`${label} needs to be reconnected`, 'reauth_required', 409);
    }
    const retryAfterMs = rateLimitRetryAfterMs(err);
    if (retryAfterMs !== null) {
      throw new AccountingImportError(
        providerRateLimitedTryAgainMessage(label, rateLimitSourceOf(err) ?? undefined), 'rate_limited', 429, { retryAfterMs },
      );
    }
    throw err;
  }
```

Replace the listing `catch`:

```ts
  } catch (err) {
    const retryAfterMs = rateLimitRetryAfterMs(err);
    if (retryAfterMs !== null && isAccountingProviderError(err)) {
      throw new AccountingImportError(
        providerRateLimitedTryAgainMessage(label, rateLimitSourceOf(err) ?? undefined), 'rate_limited', 429, { retryAfterMs },
      );
    }
    if (refusalCodeOf(err) === 'insufficient_scope') {
      throw new AccountingImportError(providerPermissionMessage(label), 'provider_permission', 409);
    }
    // Upstream API failures (401/403/5xx, unparseable body) are upstream, not a
    // Breeze bug — map to a typed 502 so the route doesn't 500 + Sentry-spam.
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw new AccountingImportError(`${label} returned an error while listing customers`, 'provider_error', 502);
  }
```

`mergeSummary` gains a `provider: AccountingProviderId` parameter (pass `conn.provider` from `importAccountingCustomers`), and the fallback error becomes `` new Error(`[accounting-import:${provider}] ${row.error}`) ``.

Also rewrite the comment in `refusalMessage` that says "another QuickBooks customer" to "another customer in the provider" (comment-only).

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd apps/api && npx vitest run src/services/accounting/accountingCustomerImport.test.ts src/routes/accounting && npx tsc --noEmit -p .`
Expected: PASS (including Task 5's `handleImportError` tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/accountingCustomerImport.ts apps/api/src/services/accounting/accountingCustomerImport.test.ts apps/api/src/routes/accounting/customers.test.ts
git commit -m "feat(accounting): import answers throttles with 429, scope refusals with 409, defers on low daily budget (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: W03a gate and PR

**Files:** none new.

- [ ] **Step 1: Prove QuickBooks is untouched**

```bash
git diff --stat origin/main -- 'apps/api/src/services/accounting/quickbooks*'
git diff origin/main -- apps/api/src/services/accounting/quickbooksIdempotency.test.ts apps/api/src/services/accounting/quickbooksProvider.test.ts
git diff origin/main -- apps/api/src/services/accounting/accountingMappingService.ts | grep -E '^\+.*(buildCustomerPayload|buildItemPayload)' || echo "payload builders untouched"
```

Expected: the first two print nothing; the third prints `payload builders untouched`.

- [ ] **Step 2: Full gate**

```bash
cd apps/api && npx vitest run 2>&1 | tail -5
npx tsc --noEmit -p .
cd ../.. && pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accounting src/__tests__/integration/tenantCascade 2>&1 | tail -5
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage 2>&1 | tail -3
cd ../.. && pnpm test-stack down
wc -l apps/api/src/routes/accounting/index.ts
```

Expected: all green (the unit file count ≥ Task 0's plus the 4 new files); `index.ts` ≤ the Task 0 count; the stack is down. If the unit suite runs out of heap, run it in the three batches the W01d result used (`src/services`, `src/routes`, the rest).

- [ ] **Step 3: Open PR W03a**

Title: `feat(accounting): Xero W03a — contacts, items and import (server; capabilities still off)`. Body:
- `Part of #7170` (not `Closes`: W03b closes it).
- What ships, and "Xero still declares only `connect`; no route/worker/UI reaches the new methods until W03b flips `mapping`/`customerImport` after lab X16."
- **QuickBooks-visible changes (intended):** a throttled customer import (listing or token refresh) answers 429 + Retry-After instead of 502/500 (refinement 13); the import Sentry fallback prefix `[qb-import]` → `[accounting-import:quickbooks]` (refinement 14); remote candidates gain `archived`. **Unchanged:** every requestid, payload and message — `quickbooks*.ts` diff is empty, the idempotency pins pass unedited.
- The Task 5g list of relabelled message lines.
- Any Task 0 interface differences.

Run `/pr-review-toolkit:review-pr`, fix confirmed findings in one round, post the summary. Merge through the queue when green (`gh pr merge <N>`, never `--admin`).

---
# PR W03b — Web, capability flip, lab

### Task 8: Workbench — income-account home, archived candidates, duplicate-name link flow, `#xero-*` deep links

**Files:**
- Modify: `apps/web/src/components/integrations/AccountingMappingWorkbench.tsx`
- Modify: `apps/web/src/components/integrations/AccountingConnectionPanel.tsx` (one prop)
- Modify: `apps/web/src/locales/*/integrations.json` (8 locales)
- Test: `AccountingMappingWorkbench.test.tsx`, `AccountingConnectionPanel.test.tsx`, `apps/web/src/components/integrations/IntegrationsPage.test.tsx`

**Interfaces:**
- Consumes: Task 5's response contract (`details.remoteName` on 409 `duplicate_name`; `archived` on candidates), M13, M15, B3, C1.
- Produces: workbench prop `incomeAccountHome?: 'workbench' | 'settings'` (default `'workbench'`); picker prop `seedTerm?: string`; test ids `` `${provider}-income-account-in-settings` ``, `` `${provider}-mapping-duplicate-hint-${id}` ``, `` `${provider}-candidate-archived-${remoteId}` `` (on the `<option>`); i18n keys `accountingMapping.incomeAccountInSettings`, `accountingMapping.archived`, `accountingMapping.duplicateNameHint`.

- [ ] **Step 1: Write the failing tests**

Append to `AccountingMappingWorkbench.test.tsx` (reuse the file's `renderWorkbench`/fetch-mock helpers — find them with `grep -n "function render\|mockFetch\|fetchWithAuth" AccountingMappingWorkbench.test.tsx` and use their real names):

```tsx
describe("Xero W03", () => {
  it("hides the income-account picker and does not fetch income accounts when the settings step owns it", async () => {
    // render with provider="xero", incomeAccountHome="settings", defaultIncomeAccountRef={null}; open the Items tab
    // expect(screen.queryByTestId("xero-income-account-select")).toBeNull();
    // expect(screen.getByTestId("xero-income-account-in-settings")).toHaveTextContent("settings step");
    // expect(fetched URLs).not.toContain(accountingPath("xero", "/income-accounts"));
    // expect(screen.getAllByTestId(/^xero-mapping-create-/)[0]).toBeDisabled();
  });

  it("re-enables Create new when the parent's income account arrives after mount", async () => {
    // render with incomeAccountHome="settings", defaultIncomeAccountRef={null}; Items tab
    // rerender with defaultIncomeAccountRef="200"
    // expect(screen.getAllByTestId(/^xero-mapping-create-/)[0]).toBeEnabled();
    // expect(screen.queryByTestId("xero-income-account-in-settings")).toBeNull();
  });

  it("keeps the QuickBooks income-account picker exactly as before (default home)", async () => {
    // render provider="quickbooks" without incomeAccountHome; Items tab
    // expect(screen.getByTestId("quickbooks-income-account-select")).toBeInTheDocument();
  });

  it("labels archived candidates and lists them after live ones", async () => {
    // remote-candidates responds { data: [{ id: "old", displayName: "Acme", archived: true }, { id: "live", displayName: "Acme Ltd", archived: false }] }
    // type "acme" into xero-mapping-search-<row>
    // const options = within(select).getAllByRole("option").map((o) => o.textContent);
    // expect(options.indexOf("Acme Ltd")).toBeLessThan(options.findIndex((t) => t?.startsWith("Acme · Archived")));
    // expect(screen.getByTestId("xero-candidate-archived-old")).toBeInTheDocument();
  });

  it("on duplicate_name, shows the hint, seeds the row search with the name and preselects the one exact match", async () => {
    // POST /mappings/sync responds 409 { error: 'Xero already has a customer named "Acme" — link…', code: "duplicate_name", details: { remoteName: "Acme" } }
    // remote-candidates?…&q=Acme responds { data: [{ id: "xc-7", displayName: "acme", archived: false }, { id: "xc-8", displayName: "Acme Holdings", archived: false }] }
    // click xero-mapping-sync-<row>
    // expect(await screen.findByTestId("xero-mapping-duplicate-hint-<row>")).toBeInTheDocument();
    // expect(screen.getByTestId("xero-mapping-search-<row>")).toHaveValue("Acme");
    // expect(select).toHaveValue("xc-7");            // exact normalised match preselected
    // click xero-mapping-confirm-<row> → PUT /mappings with { decision: "confirmed", remoteEntityId: "xc-7" }
  });

  it("a seeded search runs exactly once — no request loop from the preselect (quorum 7)", async () => {
    // same arrange as above; after the preselect settles, re-render the parent twice (e.g. toggle an unrelated row's busy state)
    // expect(number of remote-candidates requests with q=Acme).toBe(1);
  });

  it("an ordinary QuickBooks search does not refetch when the parent re-renders", async () => {
    // provider="quickbooks"; type "acme" → 1 request; re-render the parent (new onSelect identity)
    // expect(number of remote-candidates requests).toBe(1);
  });

  it("does not preselect when two candidates match the name exactly", async () => {
    // same as above with two candidates named "Acme"
    // expect(select).toHaveValue("");
  });

  it("the #xero-items hash opens the Items tab", async () => {
    // window.location.hash = "#xero-items"; render provider="xero"
    // expect(screen.getByTestId("xero-mapping-tab-items")).toHaveAttribute("aria-selected", "true");
  });
});
```

Write each body with the file's real helpers; the commented `expect`s are the assertions, verbatim. In `AccountingConnectionPanel.test.tsx` add: a Xero status with `features: { settingsOptions: true, tenantSelection: true }` and `capabilities.mapping: true` renders the workbench without `xero-income-account-select`; a QuickBooks status (no `features`) still renders `quickbooks-income-account-select`. In `IntegrationsPage.test.tsx`, next to the existing `#quickbooks-items` test (`:759`), add the same test for `#xero-items` (asserting the page stays on Accounting → Xero).

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/integrations/AccountingMappingWorkbench.test.tsx src/components/integrations/AccountingConnectionPanel.test.tsx src/components/integrations/IntegrationsPage.test.tsx`
Expected: FAIL (the `#xero-items` routing test may already pass — `parseHash` is generic; keep it as a pin).

- [ ] **Step 3: Implement**

In `AccountingMappingWorkbench.tsx`:

1. `RemoteCandidate` gains `archived?: boolean`. `Props` gains:

```tsx
  /** Where this provider's income account is edited (settings rule 1). "settings" = the
   *  connection's settings step owns it (providers with `features.settingsOptions`):
   *  the workbench shows no picker, never fetches /income-accounts, and points there. */
  incomeAccountHome?: "workbench" | "settings";
```

2. Destructure `incomeAccountHome = "workbench"`. Keep `savedIncomeAccountRef` in step with the prop (today it is read once at mount, so a save in the settings step would leave "Create new" disabled):

```tsx
  useEffect(() => {
    setSavedIncomeAccountRef(defaultIncomeAccountRef);
    setIncomeAccountRef(defaultIncomeAccountRef ?? "");
  }, [defaultIncomeAccountRef]);
```

3. In `load()`, wrap the income-accounts fetch block in `if (incomeAccountHome === "workbench") { … }`.

4. Replace the `{entityType === "catalog_item" && (` income-account section opener with `{entityType === "catalog_item" && incomeAccountHome === "workbench" && (`, and add after that block:

```tsx
      {entityType === "catalog_item" && incomeAccountHome === "settings" && !savedIncomeAccountRef && (
        <p data-testid={`${provider}-income-account-in-settings`} className="rounded-md border bg-muted/30 p-3 text-sm">
          {t("accountingMapping.incomeAccountInSettings", { provider: providerName })}
        </p>
      )}
```

5. Duplicate-name flow. Add state `const [searchSeed, setSearchSeed] = useState<Record<string, string>>({});` and change `handleSyncFailure`:

```tsx
  function handleSyncFailure(id: string, err: unknown) {
    if (err instanceof ActionError && err.status !== 401) {
      setRowError((prev) => ({ ...prev, [id]: err.message }));
      if (err.code === "duplicate_name") {
        const remoteName = (err.body as { details?: { remoteName?: unknown } } | undefined)?.details?.remoteName;
        if (typeof remoteName === "string" && remoteName) setSearchSeed((prev) => ({ ...prev, [id]: remoteName }));
      }
    } else {
      handleActionError(err, t("accountingMapping.failedToSyncEntity", { provider: providerName }));
    }
  }
```

Clear `searchSeed[id]` wherever `rowError[id]` is cleared at the start of `decide`/`sync`. Under the row's error paragraph render:

```tsx
                    {searchSeed[id] && (
                      <p data-testid={`${provider}-mapping-duplicate-hint-${id}`} className="mt-1 text-xs text-muted-foreground">
                        {t("accountingMapping.duplicateNameHint", { provider: providerName })}
                      </p>
                    )}
```

and pass `seedTerm={searchSeed[id]}` to `RemoteCandidatePicker`.

6. In `RemoteCandidatePicker`: add `seedTerm?: string` to `PickerProps`, then

```tsx
  useEffect(() => {
    if (seedTerm) setTerm(seedTerm);
  }, [seedTerm]);
```

Keep `onSelect` **out** of the search effect's dependencies: the parent passes a fresh arrow every render (`AccountingMappingWorkbench.tsx:615`), and a preselect updates parent state, so depending on it would re-run the search on every render — a request loop, and a behaviour change for every QuickBooks search (quorum finding 7). Read it through a ref, and preselect at most once per seed:

```tsx
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // `value` is read through a ref too: the preselect changes it, and as a dependency it
  // would re-run the search (a second request, and a refetch on every QuickBooks pick).
  const valueRef = useRef(value);
  valueRef.current = value;
  const appliedSeed = useRef<string | null>(null);
```

and after `setCandidates(res.data)` in the search effect:

```tsx
          if (!cancelled && seedTerm && q === seedTerm.trim() && appliedSeed.current !== seedTerm) {
            appliedSeed.current = seedTerm;
            const wanted = normalizeName(seedTerm);
            const exact = res.data.filter((c) => normalizeName(c.displayName) === wanted);
            if (exact.length === 1 && exact[0]!.id !== valueRef.current) onSelectRef.current(exact[0]!.id);
          }
```

with a module-level `const normalizeName = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");` (the same normalisation the API's `normalizeMatchValue` uses). Add only `seedTerm` to the effect's dependency list — never `onSelect` or `value`; the existing dependency list is otherwise unchanged. Import `useRef` if the file does not already.

7. Options: build the candidate list with live rows first, archived after, and label archived ones:

```tsx
  const ordered = [...(candidates ?? [])].sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
  for (const candidate of [
    ...(proposed ? [{ id: proposed.id, displayName: proposed.displayName }] : []),
    ...ordered,
  ]) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const suffix = "sku" in candidate && candidate.sku ? ` (${candidate.sku})`
      : "email" in candidate && candidate.email ? ` (${candidate.email})` : "";
    const archived = "archived" in candidate && candidate.archived ? ` · ${t("accountingMapping.archived")}` : "";
    options.push({ id: candidate.id, label: `${candidate.displayName}${suffix}${archived}`, archived: !!archived });
  }
```

and render `data-testid={opt.archived ? `${provider}-candidate-archived-${opt.id}` : undefined}` on the `<option>` (widen the `options` element type with `archived: boolean`; the stale-value `unshift` pushes `archived: false`).

In `AccountingConnectionPanel.tsx`, pass to `<AccountingMappingWorkbench …>`:

```tsx
            incomeAccountHome={status?.features?.settingsOptions ? "settings" : "workbench"}
```

i18n (`integrations.json`, under `accountingMapping`), one entry per locale:

| key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|
| `incomeAccountInSettings` | Set the {{provider}} income account in the settings step above before creating items. | Legen Sie vor dem Anlegen von Artikeln im Einstellungsschritt oben das {{provider}}-Erlöskonto fest. | Configura la cuenta de ingresos de {{provider}} en el paso de configuración de arriba antes de crear artículos. | Définissez le compte de revenus {{provider}} dans l'étape des paramètres ci-dessus avant de créer des articles. | Imposta il conto ricavi di {{provider}} nel passaggio delle impostazioni qui sopra prima di creare articoli. | Defina a conta de receita do {{provider}} na etapa de configurações acima antes de criar itens. | Ürün oluşturmadan önce yukarıdaki ayarlar adımında {{provider}} gelir hesabını belirleyin. |
| `archived` | Archived | Archiviert | Archivado | Archivé | Archiviato | Arquivado | Arşivlendi |
| `duplicateNameHint` | Pick the existing {{provider}} record below, then choose Confirm match. | Wählen Sie unten den vorhandenen {{provider}}-Datensatz aus und bestätigen Sie die Zuordnung. | Elige abajo el registro existente de {{provider}} y confirma la coincidencia. | Choisissez ci-dessous l'enregistrement {{provider}} existant, puis confirmez la correspondance. | Scegli qui sotto il record {{provider}} esistente, poi conferma l'abbinamento. | Escolha abaixo o registro existente do {{provider}} e confirme a correspondência. | Aşağıdan mevcut {{provider}} kaydını seçin, ardından eşleşmeyi onaylayın. |

The non-English strings are machine translations; say so in the PR body (same convention as W02c).

- [ ] **Step 4: Run the web tests, locale parity and typecheck**

Run: `cd apps/web && npx vitest run src/components/integrations src/locales && npx astro check 2>&1 | tail -3`
Expected: PASS; every existing QuickBooks workbench test passes unedited; astro check 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/AccountingMappingWorkbench.tsx apps/web/src/components/integrations/AccountingMappingWorkbench.test.tsx apps/web/src/components/integrations/AccountingConnectionPanel.tsx apps/web/src/components/integrations/AccountingConnectionPanel.test.tsx apps/web/src/components/integrations/IntegrationsPage.test.tsx apps/web/src/locales
git commit -m "feat(web): mapping workbench — settings-step income account, archived candidates, duplicate-name link flow (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Import panel — supplier-only toggle and archived badge; readiness link

**Files:**
- Modify: `apps/web/src/components/integrations/AccountingCustomerImport.tsx`
- Modify: `apps/web/src/lib/orgReadiness.ts` (`CONNECTOR_SETTINGS_HREF.xero`, only if W02c left it at `#accounting`)
- Modify: `apps/web/src/locales/*/integrations.json`
- Test: `AccountingCustomerImport.test.tsx`, `lib/orgReadiness.test.ts`

**Interfaces:**
- Consumes: Task 1's `supplierOnly` / `active` on each `GET /:provider/customers` row, M14, M16.
- Produces: test ids `` `${provider}-import-show-all` `` (checkbox), `` `${provider}-import-archived-${id}` `` (badge); i18n keys `accountingCustomerImport.showAllContacts`, `accountingCustomerImport.archived`.

- [ ] **Step 1: Write the failing tests**

Append to `AccountingCustomerImport.test.tsx` (use the file's fetch-mock helper):

```tsx
describe("Xero W03", () => {
  const rows = [
    { id: "c1", displayName: "Acme", alreadyImported: false, organizationId: null },
    { id: "c2", displayName: "Paper Supplies Ltd", alreadyImported: false, organizationId: null, supplierOnly: true },
    { id: "c3", displayName: "Old Client", alreadyImported: false, organizationId: null, active: false },
  ];
  it("hides supplier-only contacts behind a toggle that states how many are hidden", async () => {
    // GET /customers → { data: rows }; click xero-import-load
    // expect(screen.queryByText("Paper Supplies Ltd")).toBeNull();
    // const toggle = screen.getByTestId("xero-import-show-all");
    // expect(toggle.closest("label")).toHaveTextContent("1");
    // click toggle → expect(screen.getByText("Paper Supplies Ltd")).toBeInTheDocument();
  });
  it("select-all only selects visible rows", async () => {
    // load rows; click the select-all control; click import
    // expect POST body customerIds toEqual ["c1", "c3"]
  });
  it("badges archived contacts", async () => {
    // expect(screen.getByTestId("xero-import-archived-c3")).toHaveTextContent("Archived");
  });
  it("shows no toggle when nothing is hidden (QuickBooks rows never carry supplierOnly)", async () => {
    // provider="quickbooks", rows without supplierOnly → expect(screen.queryByTestId("quickbooks-import-show-all")).toBeNull();
  });
});
```

(The commented lines are the assertions; use the file's real load/select-all test ids — `grep -n "data-testid" AccountingCustomerImport.tsx`.)

In `lib/orgReadiness.test.ts`: `expect(CONNECTOR_SETTINGS_HREF.xero).toBe('/integrations#xero')`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/integrations/AccountingCustomerImport.test.tsx src/lib/orgReadiness.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `AccountingCustomerImport.tsx`:

```tsx
interface AnnotatedCustomer {
  id: string;
  displayName: string;
  email?: string;
  companyName?: string;
  alreadyImported: boolean;
  organizationId: string | null;
  /** false = archived in the provider (still importable, badged). */
  active?: boolean;
  /** Known to the provider only as a supplier (Xero); hidden unless "show all". */
  supplierOnly?: boolean;
}
```

Add `const [showAll, setShowAll] = useState(false);`, then derive:

```tsx
  const all = customers ?? [];
  const hiddenCount = showAll ? 0 : all.filter((c) => c.supplierOnly).length;
  const visible = showAll ? all : all.filter((c) => !c.supplierOnly);
  const importable = visible.filter((c) => !c.alreadyImported);
```

Render the list from `visible` instead of `customers`. When `all.some((c) => c.supplierOnly)`, render above the list:

```tsx
        <label className="mt-3 flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            data-testid={`${provider}-import-show-all`}
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              selection.clear();
            }}
          />
          {t("accountingCustomerImport.showAllContacts", { count: all.filter((c) => c.supplierOnly).length })}
        </label>
```

Next to each row's display name:

```tsx
            {c.active === false && (
              <span data-testid={`${provider}-import-archived-${c.id}`} className="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase text-gray-600">
                {t("accountingCustomerImport.archived")}
              </span>
            )}
```

In `orgReadiness.ts`, set `xero: '/integrations#xero'` (D12: `#xero` selects the Xero panel). Skip if W02c already changed it.

i18n (`accountingCustomerImport`):

| key | en | de-DE | es-419 | fr-CA / fr-FR | it-IT | pt-BR | tr-TR |
|---|---|---|---|---|---|---|---|
| `showAllContacts` | Show all contacts ({{count}} supplier-only hidden) | Alle Kontakte anzeigen ({{count}} reine Lieferanten ausgeblendet) | Mostrar todos los contactos ({{count}} solo proveedores ocultos) | Afficher tous les contacts ({{count}} fournisseurs uniquement masqués) | Mostra tutti i contatti ({{count}} solo fornitori nascosti) | Mostrar todos os contatos ({{count}} apenas fornecedores ocultos) | Tüm kişileri göster ({{count}} yalnızca tedarikçi gizli) |
| `archived` | Archived | Archiviert | Archivado | Archivé | Archiviato | Arquivado | Arşivlendi |

- [ ] **Step 4: Run and typecheck**

Run: `cd apps/web && npx vitest run src/components/integrations src/lib src/locales && npx astro check 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/integrations/AccountingCustomerImport.tsx apps/web/src/components/integrations/AccountingCustomerImport.test.tsx apps/web/src/lib/orgReadiness.ts apps/web/src/lib/orgReadiness.test.ts apps/web/src/locales
git commit -m "feat(web): import panel hides supplier-only contacts behind a toggle, badges archived ones (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Flip `mapping` + `customerImport`; real-DB proof

**Gate:** lab step **X16** (Task 11) has passed on this branch's `worktree-stack` — an item was created in the Demo Company with the pinned scopes. If X16 returned `insufficient_scope`, **stop**: do not flip, and escalate per refinement 1.

**Files:**
- Modify: `apps/api/src/services/accounting/xeroProvider.ts` (`capabilities`)
- Test: `xeroProvider.test.ts`, `providerRegistry.test.ts`
- Create: `apps/api/src/__tests__/integration/accountingXeroMapping.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 3–6; B1; W02b's `accountingXeroConnection.integration.test.ts` seeding helpers (partner + a `connected` Xero row with encrypted tokens that expire in the future, so no refresh runs).
- Produces: `xeroProvider.capabilities = { connect: true, mapping: true, customerImport: true, invoicePush: false, paymentPull: false, paymentPush: false }`.

- [ ] **Step 1: Write the failing tests**

`xeroProvider.test.ts` — replace `'still declares only the connect capability through W03a'` and W02's `'declares only the connect capability'` with:

```ts
it('declares connect, mapping and customerImport (Xero W03)', () => {
  expect(xeroProvider.capabilities).toEqual({
    connect: true, mapping: true, customerImport: true, invoicePush: false, paymentPull: false, paymentPush: false,
  });
});
```

`providerRegistry.test.ts` — change W02b's Xero assertion to:

```ts
it('Xero supports connect, mapping and customerImport only (Xero W03)', () => {
  expect(ACCOUNTING_CAPABILITIES.filter((cap) => providerSupports('xero', cap))).toEqual(['connect', 'mapping', 'customerImport']);
});
```

(Use the file's capability list constant; if it has none, inline `['connect','mapping','customerImport','invoicePush','paymentPull','paymentPush'] as const`.)

`accountingXeroMapping.integration.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingEntityMappings, organizationExternalLinks, organizations } from '../../db/schema';
import { importAccountingCustomers } from '../../services/accounting/accountingCustomerImport';
import { listMappingProposals, saveMappingDecision, syncMappedEntity } from '../../services/accounting/accountingMappingService';
// Seeding: reuse W02b's helpers from accountingXeroConnection.integration.test.ts (or the shared
// integration fixtures it imports). They must give: a partner id, a connected Xero connection id with
// realm (tenant) 'ten-A', homeCurrency 'GBP', an access token valid for > 5 minutes, and a
// partner-scoped DbContextRunner. homeCurrency matters: create_new runs assertCreateCurrencyMatchesRealm
// (accountingMappingService.ts:1139-1160) and refuses with currency_mismatch before any fetch otherwise.
import { seedPartner, seedXeroConnection, partnerRunner } from './accountingXeroFixtures';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const contact = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  ContactID: id, Name: name, ContactStatus: 'ACTIVE', UpdatedDateUTC: '/Date(1790000000000+0000)/', ...extra,
});

let partnerId: string;
let connectionId: string;

// The integration harness truncates every table before EACH test (__tests__/integration/setup.ts),
// so seeding happens per test and no test depends on another's rows (quorum finding 14).
beforeEach(async () => {
  vi.restoreAllMocks();
  partnerId = await seedPartner();
  connectionId = await seedXeroConnection(partnerId, { tenantId: 'ten-A', homeCurrency: 'GBP' });
});

async function importOne(contactId: string, name: string) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 1 }, Contacts: [contact(contactId, name)] }));
  const summary = await importAccountingCustomers({ partnerId, provider: 'xero', customerIds: [contactId] });
  vi.restoreAllMocks();
  return summary;
}

describe('Xero mapping and import against real Postgres (Xero W03)', () => {
  it('imports a contact as an org + site linked with system = "xero"', async () => {
    const summary = await importOne('xc-1', 'Imported Co');
    expect(summary.imported).toHaveLength(1);
    const links = await withSystemDbAccessContext(() => db.select().from(organizationExternalLinks)
      .where(and(eq(organizationExternalLinks.partnerId, partnerId), eq(organizationExternalLinks.externalId, 'xc-1'))));
    expect(links).toEqual([expect.objectContaining({ system: 'xero', orgId: summary.imported[0]!.organizationId })]);
  });

  it('backfills a confirmed Customer mapping row for the imported org on the next proposal load', async () => {
    await importOne('xc-1', 'Imported Co'); // this test's own prerequisite
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 1 }, Contacts: [contact('xc-1', 'Imported Co')] }));
    await listMappingProposals({ partnerId, provider: 'xero', entityType: 'org' }, partnerRunner(partnerId));
    const rows = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings)
      .where(and(eq(accountingEntityMappings.integrationId, connectionId), eq(accountingEntityMappings.remoteEntityId, 'xc-1'))));
    expect(rows).toEqual([expect.objectContaining({ remoteEntityType: 'Customer', linkStatus: 'confirmed', remoteSyncToken: new Date(1790000000000).toISOString() })]);
  });

  it('create-new sync adopts an existing breeze: ContactNumber instead of creating (no PUT)', async () => {
    const [org] = await withSystemDbAccessContext(() => db.insert(organizations)
      .values({ partnerId, name: 'Adopt Me', slug: `adopt-me-${Date.now()}`, currencyCode: 'GBP' }).returning());
    await saveMappingDecision({ partnerId, provider: 'xero', breezeEntityType: 'org', breezeEntityId: org!.id, decision: 'create_new' }, partnerRunner(partnerId));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [contact('xc-adopt', 'Adopt Me', { ContactNumber: `breeze:${org!.id}` })] }))
      .mockResolvedValueOnce(json({ Contacts: [contact('xc-adopt', 'Adopt Me')] }));
    await syncMappedEntity({ partnerId, provider: 'xero', breezeEntityType: 'org', breezeEntityId: org!.id }, partnerRunner(partnerId));
    expect(fetchMock.mock.calls.map((c) => (c[1] as RequestInit).method)).toEqual(['GET', 'POST']);
    const [row] = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings)
      .where(and(eq(accountingEntityMappings.integrationId, connectionId), eq(accountingEntityMappings.breezeEntityId, org!.id))));
    expect(row).toMatchObject({ remoteEntityType: 'Customer', remoteEntityId: 'xc-adopt', linkStatus: 'confirmed', syncStatus: 'synced' });
  });
});
```

If W02b's fixtures live inline in its test file rather than a shared module, move them into `apps/api/src/__tests__/integration/accountingXeroFixtures.ts` in this task (a pure move; W02b's suite then imports them) and name the move in the PR body. `organizations` may require more NOT NULL columns than shown — copy the org insert from the fixtures module the other accounting integration suites use.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/accounting/xeroProvider.test.ts src/services/accounting/providerRegistry.test.ts` → FAIL (capabilities still false). Then `pnpm test-stack up` and `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroMapping.integration.test.ts` → FAIL with `capability_unavailable` from the import service.

- [ ] **Step 3: Flip the capabilities**

```ts
  readonly capabilities = {
    connect: true,
    // Xero W03: contacts/items mapping and contact import.
    mapping: true,
    customerImport: true,
    invoicePush: false,
    paymentPull: false,
    paymentPush: false,
  } as const;
```

- [ ] **Step 4: Run to verify they pass**

Run the two unit files and the integration file again, then `pnpm test-stack down`.
Expected: PASS. The mapping sweep now reaches Xero rows (`providerSupports('xero','mapping')`), gated by `shouldDeferBackgroundWork` on Xero's daily budget — no code change needed; `jobs/accountingSyncWorker.test.ts` passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/accounting/xeroProvider.ts apps/api/src/services/accounting/xeroProvider.test.ts apps/api/src/services/accounting/providerRegistry.test.ts apps/api/src/__tests__/integration/accountingXeroMapping.integration.test.ts apps/api/src/__tests__/integration/accountingXeroFixtures.ts
git commit -m "feat(accounting): Xero declares mapping and customerImport; real-DB proof of import and adoption (Xero W03)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Lab checklist section 3, W03b gate and PR

**Files:**
- Modify: `docs/integrations/xero-demo-verification.md` (append section 3 after section 2's `### Results`; add a change-log line)

- [ ] **Step 1: Append the W03 checklist**

Insert before `## Change log`:

````markdown
## 3. W03 checklist — contacts, items, import

Run on a `worktree-stack` of the W03b branch **with Task 10's capability flip applied locally** (the flip is committed only after X16 passes). Connected to the Demo Company (section 2 done). Record each result in the table below the checklist.

| # | Step | Expected |
|---|---|---|
| X16 | Items → a catalog item with an income account set → **Create new** | An item appears in Xero → Products and services. **If the sync fails with "did not grant Breeze access", STOP: the pinned scopes cannot write Items (refinement 1). Do not merge W03b; escalate.** |
| X17 | Customers → an org → **Create new**; then in Xero open the new contact | "Contact Code" shows `breeze:<orgId>`. Time `GET Contacts?where=ContactNumber=="breeze:<orgId>"&includeArchived=true` in the API log: under 2 s |
| X18 | Create a Xero contact named exactly like a second, unmapped org; **Create new** for that org | Row shows "Xero already has a customer named …"; the row search is prefilled and the contact preselected; **Confirm match** links it. Copy the raw Xero message into Results |
| X19 | In Xero, set another contact's Contact Code to `breeze:<orgId of a third org>` via the API (Postman), then **Create new** for that org | No second contact is created; the existing one is adopted and updated. Record the raw duplicate-ContactNumber message if Xero returned one |
| X20 | Create a Xero item with Code = a catalog item's SKU (same name, too); **Create new** for that catalog item | A new item with code `<sku-slug>-<10 hex>` is created; the MSP's item is untouched (it is offered as an exact-SKU suggestion instead). Rename the catalog item and **Sync now** after unlinking and choosing **Create new** again: the same Xero item is adopted, not duplicated. Record Xero's duplicate-code message text if you can provoke one (Postman `PUT` of an existing Code) |
| X21 | Archive the contact created in X17 in Xero; **Sync now** on the (still linked) org; then unlink it and **Create new** again | Both refused: "…is archived — restore it in Xero, then sync again". Record whether `POST {ContactStatus:'ACTIVE'}` via Postman un-archives it, and whether Xero accepts an update to an archived contact at all |
| X22 | Edit a linked item's price in Breeze → **Sync now** | The Xero item's price changes; its Code is unchanged. Record whether a POST without `Code` would be accepted (Postman) |
| X23 | Replay the same `PUT /Contacts` body twice within 60 s with the same `Idempotency-Key` (Postman, copying Breeze's key from the API log); then confirm an update `POST` from Breeze carries no `Idempotency-Key` header | One contact; the second response is a replay; updates are unkeyed. If you can provoke a Xero 5xx, record whether a same-key retry replays it (refinement 9's known limitation) |
| X24 | Mapping row search: type 2 characters of a contact's name | The contact is offered (`searchTerm`) |
| X25 | Import tab → Load | Customers and never-invoiced contacts listed; a supplier-only contact (one bill, no invoices) is hidden behind "Show all contacts (1 supplier-only hidden)"; an archived contact shows the Archived badge |
| X26 | Import one contact | An org + site exist; the org's external link reads `system = xero`; the mapping workbench shows the org as linked on the next load |
| X27 | Set `acct-rl:xero:day-remaining:<connectionId>` in Redis to 10% of `XERO_DAILY_CALL_LIMIT`, then Import → Load | 429 toast: "…daily API allowance … nearly used up…"; clear the key afterwards |
| X28 | Xero connection with the income account set in the settings step | The workbench shows no income-account picker; **Create new** on items is enabled |
| X29 | A contact with an address whose country is written out ("United Kingdom") and a phone with area code | Sync succeeds; Breeze shows the phone as `<country> <area> <number>` |
| X30 | `UpdatedDateUTC` after a sync | The mapping row's remote version is an ISO timestamp (psql: `select remote_sync_token from accounting_entity_mappings where remote_entity_id = '<ContactID>'`) |
| X31 | Delete a linked item in Xero (unused on invoices), then **Sync now** on its catalog item | Refused, terminal: "…no longer exists — unlink it and map it again"; no new item is created |

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
````

Append to `## Change log`: `- W03 — contacts, items and import (X16–X31); X16 gates the mapping capability flip.`

- [ ] **Step 2: Full W03b gate**

```bash
git diff --stat origin/main -- 'apps/api/src/services/accounting/quickbooks*'   # expect: empty
cd apps/api && npx vitest run 2>&1 | tail -5 && npx tsc --noEmit -p .
cd ../web && npx vitest run 2>&1 | tail -5 && npx astro check 2>&1 | tail -3
cd ../.. && pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accounting src/__tests__/integration/tenantCascade 2>&1 | tail -5
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage 2>&1 | tail -3
cd ../.. && pnpm test-stack down
```

Expected: all green; the stack is down.

- [ ] **Step 3: Commit, then open PR W03b**

```bash
git add docs/integrations/xero-demo-verification.md
git commit -m "docs(accounting): Xero W03 lab checklist (X16–X31)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Title: `feat(accounting): Xero W03b — mapping workbench, import and capability flip`, with `Closes #7170`. The body must include:
- the settings-rule-9 statement from "PR split";
- the machine-translation line for the 5 new keys × 7 locales;
- X16–X31 results, **or** "lab pending" with the owner named. **X16 blocks merge** (it gates the flip);
- the Xero capabilities after merge: `connect, mapping, customerImport`.

Run `/pr-review-toolkit:review-pr`, fix confirmed findings in one round, post the summary. After merge, run `complete_wave` for #7170.

---
## Advisor quorum (2026-09-27)

Fable draft, then an independent Codex review (`codex exec -s read-only -c model_reasoning_effort=high`, model `gpt-6-astra`) against the plan, the spec, the seam files on `main` and W02a's `xeroHttp.ts`/`xeroProvider.ts`. Codex raised 15 findings (0 critical, 14 important, 1 minor). Each was checked against the code; all 15 are real. 14 are adopted in full; finding 8 is adopted as a documented bound instead of the proposed interface change. The drafter's own finding (a cached Xero 5xx replayed across the sync job's retries) is row 16.

| # | Finding | Disposition |
|---|---|---|
| 1 | A request-derived key on **updates** replays a stale response for an A → B → A edit inside 6 minutes | **Adopted.** Keys on `PUT` (create) only; updates are idempotent by content (refinement 9; Task 2 test "a POST update carries no key") |
| 2 | Item adoption does not prove ownership: a SKU/name hit can be an MSP's item, and the 6-hex hash collides (demonstrated) | **Adopted.** Code = `prefix-<10 hex of catalogItemId>`, adoption by suffix only; SKU never an adoption key; two hits refused (refinement 6; Task 4) |
| 3 | A code derived from the mutable name/SKU changes after a rename, so a retry creates a second item | **Adopted** by the same redesign — the suffix survives renames (Task 4 "a retry after a rename adopts by suffix") |
| 4 | Mapped archived/GDPR contacts bypass the archive guard | **Adopted.** Update responses are checked; `remote_archived` (refinement 4; Task 3) |
| 5 | A `duplicate_name` from our own earlier uncertain create becomes terminal without an adoption look | **Adopted.** One `ContactNumber` look on `duplicate_name` (refinement 5; Task 3 "adopts when the duplicate name belongs to our own earlier create") |
| 6 | A deleted mapped item/contact stays a retryable 502 | **Adopted.** `not_found` + `remote_missing` → terminal 409 `remote_missing`; a bare `not_found` (QuickBooks 610) is unchanged (Tasks 1, 3, 4, 5) |
| 7 | The duplicate-name preselect loops (fresh `onSelect` each render) and would refetch every QuickBooks search | **Adopted.** `onSelect` via a ref, once per seed, never in effect deps; request-count tests (Task 8) |
| 8 | Import paging keeps consuming the reserved budget after crossing 20% mid-list | **Adopted as a documented bound**, not an interface change: overshoot ≤ one listing (`ceil(contacts/1000)` calls). A paging hook on the neutral `listRemoteCustomers` signature is churn for a bounded cost (refinement 12); revisit on lab/production evidence |
| 9 | The 100-page cap silently truncates large tenants | **Adopted.** Follow `pageCount`; a 1,000-page runaway guard throws (refinement 19; Task 3) |
| 10 | `remote-candidates` calls the provider directly, so a scope refusal becomes a 500 | **Adopted.** `handleMappingError` translates a raw `insufficient_scope` (Task 5) |
| 11 | A throttled token refresh during import escapes as a 500 | **Adopted.** Mapped to 429 + Retry-After; listed as a QuickBooks-visible change (refinement 13; Task 6) |
| 12 | The worker reports every terminal code to Sentry, so the new user-resolvable ones would too (and the prescribed test asserted capture) | **Adopted.** `MAPPING_USER_RESOLVABLE_CODES` skips capture; separate test; existing terminal telemetry unchanged (refinement 20; Task 5) |
| 13 | The relabel recipe collides with the existing `label` (entity noun) and assumes provider context in three helpers that lack it | **Adopted.** `providerLabel` everywhere; `upsertMappingRow`/`resolveItemSellPrice`/`persistRemoteRef` gain a parameter (refinement 21; Task 5g) |
| 14 | Integration fixtures seeded in `beforeAll` vanish (the harness truncates before each test); test 2 depended on test 1 | **Adopted.** Per-test seeding and an `importOne` prerequisite (Task 10) |
| 15 | Two test snippets do not compile (readonly tuple spread; undefined `PARTNER`) | **Adopted.** Typed `it.each` tuple; the import suite's `'p1'` partner (Tasks 2, 6) |
| 16 | *(drafter)* Xero caches and replays an internal error under the same key; the job's 5 attempts (≈75 s) all fall inside one 6-minute window | **Accepted limitation, documented** (refinement 9); the row reads `error` and the next **Sync now** after 6 minutes succeeds. Lab X23 records Xero's actual behaviour |

**PR review round (PR #7236, one focused plan-vs-code review, Opus):** 4 important + 3 minor findings, all verified and fixed in the plan: the remote-candidates tests live in `invoicePush.test.ts` (and two exact assertions there gain `archived: false`); the picker reads `value` through a ref (as a dependency it re-fetched after the preselect); Task 2's appended import duplicated `xeroApiGet`; `customers.test.ts`'s stand-in `AccountingImportError` needed the 4th argument; Task 1's type-pin red is `tsc`, not vitest; Task 10's fixture needs `homeCurrency` to pass the create-time currency guard; a duplicate `AccountingProviderError` import instruction was dropped.

---

## Self-review (done while writing; kept for the executor)

**Spec coverage (§W03):** `listRemoteCustomers` honours `query` via `searchTerm`, pages at 1000, returns archived contacts flagged (Task 3; the badge and "not suggested" in Tasks 5, 8, 9 — the service already drops `active === false` from suggestions). Idempotent create via `ContactNumber = breeze:<orgId>` with lookup-before-create (Task 3). Duplicate-name → `validation` + `duplicate_name` → "link it?" in the workbench, never auto-retried (Tasks 2, 3, 5, 8; worker terminal in Task 5). Addresses/phones POBOX/STREET, DEFAULT/MOBILE (Task 3 — in `xeroContacts.ts`, not `addressMapping.ts`, whose only export maps RemoteAddress → site and is still what the importer uses). Update sends `ContactID`; `UpdatedDateUTC` is the remote version (Tasks 2, 3). Item `Code`: the spec's "SKU if it fits, else slug + 6-char hash" is **replaced** by `prefix-<10-hex hash of the catalog item id>` with suffix adoption (refinement 6, quorum findings 2–3) — the spec's intent (idempotent create, never duplicate, adopt only what is ours) is kept; the SKU stays visible as the code's prefix. `Name` ≤50, `IsSold=true`, never tracked inventory, `SalesDetails` with `UnitPrice`/`AccountCode`/`TaxType` (Task 4). Lookup-by-Code first (Task 4). Import via `accountingCustomerImport.ts` with `system = 'xero'` (unchanged seam; proven against Postgres in Task 10). Supplier-only hidden by default with a toggle (Tasks 1, 3, 9). Cross-wave: adoption after uncertain outcomes (Tasks 3, 4); provider-owned keys and byte-identical QuickBooks (Global Constraints, Task 7 Step 1); capabilities gate routes/producers/workers/UI (unchanged gates; flip in Task 10); no new tables (refinement 18). Rate limiting: import paging defers below 20% (Task 6); the mapping sweep already defers (Task 10 note). W01d deferrals taken: `[qb-import]` (Task 6), `#quickbooks-items` / workbench provider-awareness (Task 8), remaining QuickBooks wording in mapping/import (Task 5g), `orgReadiness` Xero link (Task 9).

**Placeholder scan:** no TBD or "similar to". Four test bodies are given as exact assertions plus the instruction to use the existing file's real helper names (`AccountingMappingWorkbench.test.tsx`, `AccountingCustomerImport.test.tsx`, `invoicePush.test.ts`, the import seam-failure test) — the same convention the W02 plan used for helpers it could not see. Task 10's fixtures module name is an assumption on W02b and is flagged there.

**Type consistency:** `AccountingRefusalCode` / `refusalCodeOf` (Task 1; kinds `validation` and `not_found`) are used by Tasks 2–6; `remote_missing` flows provider (Tasks 3–4) → `providerRefusal` (Task 5) → worker `MAPPING_USER_RESOLVABLE_CODES` (Task 5). `xeroApiWrite`, `xeroQuery`, `parseXeroDate`, `requireXeroBody`, `xeroArray` (Task 2) are used by Tasks 3–4. `getRemoteCustomer` / `getRemoteItem` (Task 1) are implemented in Tasks 3–4 and consumed in Task 5. `providerPermissionMessage` (Task 5) is used by Task 6. `AccountingMappingError.details` (Task 5) is read by `handleMappingError` (Task 5) and the workbench (Task 8, via `ActionError.body.details`). `AccountingImportError.retryAfterMs` (Task 6) is read by `handleImportError` (Task 5). `incomeAccountHome` (Task 8) is set by the panel from B3's `features.settingsOptions`.

**Review Focus → tests:** 1 → Task 3 "adopts after a timed-out create", Task 2 "identical requests carry identical keys", Task 10 "create-new sync adopts". 2 → Task 2 duplicate-name classification, Task 3 "surfaces duplicate_name without a re-lookup", Task 5 "duplicate_name → 409 …" + worker terminal, Task 8 duplicate flow. 3 → Task 4 "never adopts an MSP item that only shares the SKU" / "a retry after a rename adopts by suffix" / "two suffix hits are refused"; lab X20. 4 → Task 3 GDPR/archived mapping + "refuses to adopt our own archived contact" + "a mapped contact whose update comes back ARCHIVED/GDPRREQUEST", Task 5 `remote_archived`, Task 8 archived candidates, Task 9 archived badge. 5 → Task 2 insufficient-scope classification (both spellings), Task 4 "surfaces insufficient_scope", Task 5 `provider_permission` (service, raw route translation, worker terminal + no Sentry), Task 6 import 409, lab X16.

**Deliberately not in W03:**
- scope changes (`XERO_SCOPES`) — escalated by X16 if needed (refinement 1);
- API un-archiving of an adopted contact (X21 records whether it works);
- a per-item income account (items use the connection default, as QuickBooks does);
- QuickBooks mapping its own duplicate-name fault (6240) to `duplicate_name` — a candidate follow-up for both providers; W03 keeps QuickBooks byte-identical;
- invoice push, tax allocation, invoice idempotency variants (W04); payments, webhook, `paymentRefMax`/`paymentMarker` (W05);
- the Xero apps/docs feature page (spec "Rollout");
- the tr-TR glued-suffix review (W01d R11; W02's scope).
