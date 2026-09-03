# Billing Evidence Per Invoice

**Date:** 2026-09-03
**Status:** Fable-reviewed + Codex quorum folded 2026-09-03
**Tracking issue:** LanternOps/breeze#3205, wave 7 (LanternOps/breeze#4656)
**Roadmap:** `docs/superpowers/specs/billing/2026-09-02-device-set-billing-roadmap.md` (§"W07", §"Settled across all waves")
**Predecessors assumed merged:** W01 `per_device_role` (`2026-09-02-contract-lines-per-device-role-design.md`, PR #4585); W02 `per_device_group` (`2026-09-02-contract-lines-per-device-group-design.md`); W03 line editing (`2026-09-03-contract-line-editing-design.md`); W04 allowance + overage (`2026-09-03-contract-line-allowance-overage-design.md`); W06 device coverage lookup (`2026-09-03-device-coverage-lookup-design.md` §"Hand-off to W07")
**Hand-offs consumed:** W06 mandates `matchingDevicesForLine(snapshot, line)` over the shared `coverageMatch` core and the GENERATION snapshot gaining `hostname`. This wave does not re-derive matching.

## Problem

An invoice line says "Servers × 12". Nothing anywhere records *which twelve*. The device set is resolved live at generation (`quantityFor(snapshot, l)`, `contractService.ts:1122-1145`) and thrown away; `snapshotContractDevices` is an in-memory read with no persistence. A device reclassified the day after billing, a group whose filter changed, a decommission — each silently rewrites what the invoice appears to have meant, and a customer dispute is settled by guesswork.

The operator side is no better. W01–W04 built three "silence is a bug" signals — `uncoveredDevices`, `overages[]` with `mode: 'flag'`, and the price-book gaps — and every one of them lives only in a `GenerateResult` return value, a worker `console.warn` and a toast. Once the request ends, nothing says what a past period did not bill. The roadmap's own rule ("Silence is a bug … From W07 on it is also persisted per period") has no storage behind it.

## Findings that shape the design (verified 2026-09-03, this worktree at `billing-by-units`)

### Generation, exactly as it runs

Updated 2026-09-03 to match #3205 W07 as shipped.

- `generateDueInvoice` (`apps/api/src/services/contractService.ts:1054-1187`) runs as ONE caller-supplied transaction and does not self-wrap; W04 adds `assertInTransaction('generateDueInvoice')` as its first statement (W04 decision 14). Both callers comply (`jobs/contractWorker.ts:72-74`, `routes/contracts/generate.ts:26-28`).
- The order is **draft invoice → add lines → CLAIM the period → advance the pointer**. The claim is `insert(contractBillingPeriods) … onConflictDoNothing … returning({ id })` (`contractService.ts:1163-1170`); a run that loses the race calls `deleteDraftInvoice(inv.id, actor)` and returns `skipped: 'already_billed'` (`:1172-1175`). **The `contract_billing_periods.id` that this wave keys its outcome row on does not exist until after every invoice line is written.**
- Generation calls the shared `materializeContractLineOntoInvoice(...)` once per resolved contract line. It returns `{ baseLine, overageLine, overage, pricedFrom }`; evidence reads the base and optional overage invoice-line ids directly from that result.
- `materializeContractLineOntoInvoice(...)` owns the base and optional bill-mode overage writes inside the ambient transaction. Its nested transaction is a savepoint on the AsyncLocalStorage-routed connection, so evidence written by the outer scope commits or rolls back with the lines.
- `snapshotContractDevices(orgId)` (`contractQuantities.ts:51-58`) is called once per generation when `lines.some(isDeviceLine)` (`contractService.ts:1119-1120`). W02 made it per-device rows; W06 adds `hostname` — verified present as `hostname: varchar('hostname', { length: 255 }).notNull()` (`apps/api/src/db/schema/devices.ts:60`), which is why the evidence stamp below is `varchar(255) NOT NULL` and never has to tolerate a null. There is **no persisted per-device billing record anywhere in the schema today** — this wave creates the first one.
- `uncoveredByRole(snapshot, lines)` returns `UncoveredDevices` (`contractCoverage.ts:15-19`) and is computed at `contractService.ts:1185`, *after* the claim. Its shape is `{ total, byRole }`, which is exactly the pair of columns the outcome row needs.
- W04 produces `overages: OverageSummary[]` — `{ contractLineId, description, counted, included, overage, mode }` — for **both** modes, and `applyAllowance` returns `{ counted, billed, included, overage, overageMode }`. The materializer returns the overage invoice line as a **sibling** (`parentLineId: null`) sharing `sourceId` with its base line, so evidence distinguishes base and overage rows by the returned lines' own `invoice_lines.id` values and never by lineage columns.

### Tenancy contracts this wave must satisfy

- **Cascade list.** `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:68-…`) is alphabetised by `localeCompare` with `organizations` last (`__tests__/integration/tenantCascade.integration.test.ts:45-53`); the real DELETE order is computed at runtime from `pg_constraint` (`tenantCascade.ts:690-704`), so membership and alphabetisation are what the list owes. Verified by `node --eval` on `localeCompare`: `contract_billing_period_outcomes` sorts **before** `contract_billing_periods` (`:188`) and `invoice_line_devices` sorts **before** `invoice_lines` (`:277`) — the `_`-before-`s` prefix-extension trap the file already documents for `contact_external_links`/`contacts` (`:184-187`).
- **Device lists.** `cascadeDelete.test.ts:139-176` fails unless every table with a `device_id` FK to `devices.id` is in **exactly one** of cascade / detach / linked. `DEVICE_DETACH_DEVICE_ID_TABLES` (`routes/devices/core.ts:153-155`) is the detach set, and `deviceDeletion.ts:238-240` loops it with a generic `UPDATE <t> SET device_id = NULL WHERE device_id = …`. Adding the evidence table to that list buys the detach for free — **but that loop is an UPDATE, so the table must not be append-only-immutable.**
- **Move-org has a DB-side restamp that runs BEFORE any route code, and it discovers tables dynamically.** `breeze_cascade_device_org_id()` is an `AFTER UPDATE` trigger on `devices` (`SECURITY DEFINER`, newest definition in `migrations/2026-10-04-100000-ticket-requester-contact.sql:138-186`). Its final loop is:

  ```sql
  FOR child_table IN SELECT public.breeze_device_child_orgid_tables() LOOP
    EXECUTE format('UPDATE public.%I SET org_id = $1 WHERE device_id = $2 AND org_id IS DISTINCT FROM $1', child_table)
      USING NEW.org_id, NEW.id;
  END LOOP;
  ```

  and `breeze_device_child_orgid_tables()` (newest definition `migrations/2026-09-17-pam-device-move-guard.sql`) returns **every** `public` table that has a uuid `device_id` **and** a uuid `org_id`, minus a hard-coded exclusion list (`ai_agent_runs`, `pam_actuations`, `pam_actuation_results`). It is a `pg_class`/`pg_attribute` scan, so a new table is enrolled the moment it exists — **no registration step, no test, no opt-in.**

  **This is the blocking interaction.** `invoice_line_devices` has both columns, so the trigger would issue `UPDATE invoice_line_devices SET org_id = <target> WHERE device_id = <device>` *during the `devices` UPDATE itself*, before `moveOrg.ts` runs a single statement. The evidence row's invoice and invoice line stay in the source org, so both `DEFERRABLE INITIALLY IMMEDIATE` composite FKs are checked at the end of that statement and raise **23503 — the device move fails outright**. It is exactly the `tickets_requester_contact_org_fk` failure the same migration documents at `:100-116` ("The detach must run BEFORE the generic loop: the loop's own statement is what trips the constraint, so a cleanup placed after it never executes"). Decision 10a is the fix.
- **Move-org (app side).** `moveOrg.coverage.test.ts:33-63, 93-109` fails when a table in cascade ∪ detach has an `org_id` column and is absent from both `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`core.ts:205-244`) and the test's `INTENTIONALLY_NO_ORG_ID` set. `ai_agent_runs` is the precedent for "history stays with the source org": it is in `INTENTIONALLY_NO_ORG_ID` (`:34-37`), documented in the `core.ts` comment block, and gets an **explicit hand-written detach** in the move transaction (`routes/devices/moveOrg.ts:251-254`) because the generic loop only visits denormalized tables.
- **Export policy.** `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) classifies every column of every org-cascade table; `contract_billing_periods` is at `:146`, `contract_lines` at `:148`, `invoice_lines` at `:224`, `invoices` at `:227`. **Any `json`/`jsonb` column is `excludedOpen`** — which means a fact recorded *only* in jsonb is absent from a tenant export.
- **Org merge.** `orgMergeRegistry.ts` needs exactly one policy per cascade table. `invoices`, `invoice_lines`, `contract_lines` and `contract_billing_periods` are all plain `REPOINT_TABLES` entries (`:484`, `:486`, `:555`, `:558`).
- **Deferrable composite FKs.** Every composite FK referencing an `org_id` column must be `DEFERRABLE INITIALLY IMMEDIATE` (`CLAUDE.md`; `orgLifecycleFoundations.integration.test.ts` "merge contract"); org merge runs `SET CONSTRAINTS ALL DEFERRED` and repoints parent and child in separate statements (`orgMerge.ts:1019-1022`). W01's site FK tripped this on #4585.
- **Composite-FK targets.** `invoices_id_org_uq` exists (`db/schema/invoices.ts:93`, migration `2026-06-15-b:12`); `contracts_id_org_uq` (`contracts.ts:54`) and `contract_lines_id_org_uq` (`contracts.ts:79`) exist; `sites_id_org_id_uniq` and `devices_id_org_id_uniq` exist (`2026-07-23-partner-export-material-state-hardening.sql:38-39`). **`invoice_lines (id, org_id)` and `contract_billing_periods (id, org_id)` do NOT exist** and must be created by this wave's migration.
- **Shape-1 template.** `2026-10-01-100000-ai-agents-graduation-evidence.sql` is the reference: table → composite FK in a `DO $$ … EXCEPTION WHEN duplicate_object` block → indexes → `ENABLE`+`FORCE ROW LEVEL SECURITY` → four `breeze_org_isolation_*` policies over `public.breeze_has_org_access(org_id)` → `GRANT SELECT, INSERT, UPDATE, DELETE … TO breeze_app`. It also carries the PG15 lesson that matters here: **`ON DELETE SET NULL` must name its column list** (`… SET NULL (run_id)`), or Postgres nulls every FK column including the `NOT NULL org_id` and aborts the parent delete with 23502 (`:29-35`).

### Invoice lifecycle

- **Void/reissue** (`invoiceService.ts:1580-1690`): void flips status and releases source rows; with `reissue` it inserts a new draft, then clones lines in **two passes** — parents (`parentLineId IS NULL`) first, building `oldToNew: Map<oldLineId, newLineId>` (`:1665-1669`), then children with a remapped parent (`:1670-1673`). **The children insert does not `.returning()`, so `oldToNew` covers parents only.** W04's overage line is a sibling, so both legs are parents and both land in the map today.
- **Issue** (`invoiceService.ts:1154-1210`) locks lines and dedupes `source_id` per source type; it neither adds nor removes lines, so evidence is untouched by issue.
- **Customer serialization** (`getCustomerInvoice`, `invoiceService.ts:780-801`) projects six columns per customer-visible line into `CustomerInvoiceLine` (`:694-707`). The portal and the public pay link read only this. Not extended by this wave (roadmap: portal exposure is a #4562 wave).

### PDF and settings

- `renderInvoicePdfBuffer(invoice, lines, branding)` (`services/invoicePdf.ts:301`) is a **pure** pdfkit draw with a running `y` cursor and a page-break idiom at `:373`; there is no section abstraction. `renderInvoicePdf(invoiceId)` (`:521`) loads via `loadInvoiceForRender` (`:472`), renders, and **upserts one row per invoice** into `invoice_documents` (`:551-558`, unique on `invoice_id`), stamping `invoices.pdf_document_ref` / `pdf_sha256`. Drafts render for preview and persist nothing (`:544-549`).
- **`renderInvoicePdf` takes only an id — there is no options parameter, and there must not be one.** The PDF is rendered by an async BullMQ job enqueued at issue (`enqueueInvoicePdfRender`, called from `invoiceService.ts:1335`, `quoteAcceptService.ts:463`, `routes/invoices/lifecycle.ts:140`), and `deliverInvoiceEmail` (`invoicePdf.ts:687-701`) reuses a stored PDF rather than re-rendering. A send-time flag passed as a function argument would therefore be **ignored whenever the async job already rendered** — and a later re-render (branding change, lost document) would silently drop it. Any per-invoice choice must be a **persisted column read inside `loadInvoiceForRender`**.
- Partner-level billing settings are **dedicated columns on `partners`**, not `settings` jsonb — `autoTaxHardware`, `autoEmailInvoiceOnQuoteAccept`, `documentTheme`, `invoiceFooter` (`db/schema/orgs.ts:47`, `:101-132`), with the schema comment stating the reason: "settings cards replace sub-objects wholesale (#3597), and a column keeps gate === read-back". Surface: `partnerBillingSettingsSchema` (`packages/shared/src/validators/invoices.ts:100`) → `updatePartnerBillingSettings` (`invoiceService.ts:833`) → `PATCH /partner/billing-settings` (`routes/invoices/settings.ts:22`) → `apps/web/src/components/billing/PartnerBillingSettings.tsx` (root `data-testid="partner-billing-settings"` at `:184`; the `autoEmailInvoiceOnQuoteAccept` checkbox at `:266-272`, `data-testid="partner-billing-auto-email-invoice"`, loaded at `:85` as `p.autoEmailInvoiceOnQuoteAccept !== false` and saved at `:136`, with the state listed in the save-deps array at `:170`). The `partners.settings` jsonb path carries the #3608 hazard (a stored `false` must be read as intent, `services/timeSuggestionSettings.ts:32-34`); a `NOT NULL DEFAULT` column has no unset state and no hazard.
- The send composer schema is `.strict()` (`lib/sendComposer.ts:21-27`, mapped by `routes/invoices/lifecycle.ts:27-35`) — a new field must be added there explicitly or the request 400s.
- **There are exactly TWO issuance writers.** `issueInvoice` (`invoiceService.ts:1135`) writes `status: 'sent'` at `:1275` and is the chokepoint for all six of its callers (`routes/invoices/lifecycle.ts:38`, `routes/invoices/bulk.ts:29`, `invoicePdf.ts:824` = the send path, `routes/contracts/generate.ts:42`, `jobs/contractWorker.ts:111`, `aiToolsBilling.ts:349`). The quote-acceptance deposit invoice is the second: `quoteAcceptService.ts:295` states outright "This IS the invoice's issue moment (it never goes through issueInvoice)" and stamps `documentLocale` there for the same reason. Any value that must be frozen at issue has to be written in **both** places — `document_locale` is the precedent.

### Web

- `InvoiceDetail.tsx:313-370` renders the line table; each row is `data-testid={`invoice-detail-line-${l.id}`}` with the W04-relevant child indentation at `:341-345`.
- `ContractDetail.tsx:398-425` already renders billing-period history — `data-testid="contract-periods"`, rows `period-row-${p.id}`, columns Period / Generated / Invoice — fed by `detail.periods` (`:96`). This is the natural home for the per-period outcome.
- Eight locales under `apps/web/src/locales/` (`de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`), billing keys in each `billing.json` / `contracts` namespace.

## Decisions

1. **Two tables, both RLS shape 1, both created with their policies in one migration.** `invoice_line_devices` (device-level evidence, one row per counted device per invoice line) and `contract_billing_period_outcomes` (one row per claimed period). Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — no allowlist entry — but forced RLS, four policies and the `breeze_app` grant ship in the creating migration, never deferred.

2. **Representation (the roadmap's open question): device rows carry only evidence that HAS an invoice line; "uncovered" stays an aggregate on the period outcome.** `counted_as` is `included | overage | flagged`, and **`invoice_line_id` is `NOT NULL` in every case**.
   - *Rejected: `invoice_line_devices` rows with `counted_as = 'uncovered'` and a null `invoice_line_id`.* Three reasons, in order of weight. (a) It makes the table's only lineage column nullable, which turns the composite `(invoice_line_id, org_id)` FK into a MATCH-SIMPLE no-op for exactly the rows that have no other tenant anchor, and forces a CHECK to re-state what the FK should have enforced. (b) "Uncovered" is not a property of an invoice — it is *this contract's* view of the org's device set, so with three contracts on a 500-device org the same 400 devices are written three times every period, in a table named for invoice lines, to answer a question W06 already answers live and better. (c) The volume is unbounded in the wrong variable: it scales with the org's fleet, not with what was billed.
   - **Flagged overage is the part that genuinely needs device identity, and it gets it.** Under `flag` mode the tail is `counted − included` devices that a human must adjudicate — small, bounded, and the exact thing a customer disputes. Those rows attach to the **base** invoice line (the line whose allowance they exceeded) with `counted_as = 'flagged'`; under `bill` mode the same tail attaches to the **overage** invoice line as `counted_as = 'overage'`. So the disputable set is always device-level, and `invoice_line_id` never needs to be null.
   - **The trade-off, stated plainly: uncovered device IDENTITY is not persisted.** A past period records *how many* devices this contract did not bill and *by which role* (`uncovered_total`, `uncovered_by_role`), never *which ones*. "Which devices are uncovered?" is answered live by W06's coverage lookup (`contractLinesCoveringDevice` / the device Billing panel), against today's fleet — which is the honest answer to a question about configuration, as opposed to a question about a bill. Accepted knowingly: a device that was uncovered in March and covered since cannot be re-identified from the March period row.
   - **If row-level uncovered is ever wanted**, it is a third table keyed by `contract_billing_period_id` — not a nullable column on this one. Stated so the extension does not arrive as a retrofit.

3. **The jsonb digests are deliberately NON-PORTABLE, and the scalars are the exported facts.** Every `json`/`jsonb` column is `excludedOpen`, so `uncovered_by_role` and `overages` **do not appear in a tenant export at all** — accepted explicitly rather than worked around. What survives the export is the set of scalars beside them (`uncovered_total`, `flagged_total`, `billed_overage_total`, `snapshot_device_total`), plus the thing that actually matters commercially: **the invoice lines themselves, which carry the billed overage as a real priced line** (W04's sibling overage line, `invoice_lines` is fully exported at `tenantExportPolicyRegistry.ts:224`). So a tenant export can always reconstruct what was charged and how much silence there was; only the per-role and per-line *breakdown* of that silence is UI-only. Stated in the export-policy row comment and again in Rollout so nobody reads the omission as an oversight and "fixes" it by promoting a jsonb column to `included`.

4. **The write happens after the period claim, in the same transaction, from state collected during the line loop.** The line loop appends to an in-memory `pendingEvidence` array (it has `baseLine.id` / the overage line's id already); nothing is inserted until `claimed.length > 0` at `contractService.ts:1170`, because the period id does not exist before then and a lost claim deletes the draft anyway. One `insert().values(rows)` for the evidence, one for the outcome row, both before the `next_billing_at` advance. A throw anywhere rolls back the invoice, the claim and the evidence together, exactly as today.
   *Rejected: writing evidence inside the loop and letting the FK cascade clean up after a lost claim.* It works, but it makes the lost-race path depend on a cascade firing through `deleteDraftInvoice`, and it writes rows for a period that was never billed.

5. **`matchingDevicesForLine(snapshot, line)` is the only device source, and the count is its length.** W06's hand-off mandates it and makes `quantityFor(snapshot, line) === matchingDevicesForLine(snapshot, line).length` true by construction, which is what forbids an invoice saying "12" beside eleven rows. Generation calls it **once** per device line and uses that one array for both the quantity and the evidence — never `quantityFor` and then a second walk. No runtime cross-check is added in the billing path: with one array there is nothing to disagree, and a guard comparing the length to its own stringified quantity would assert nothing. The invariant is pinned instead by a `quantityFor` ⇔ `matchingDevicesForLine` parity test over the shared W02/W06 fixtures, plus the integration assertion that `invoice_lines.quantity` equals the persisted row count.

6. **Canonical ordering is UTF-16 code-unit comparison of `hostname`, then `device_id` — never `localeCompare`.** The sort is `a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : (a.id < b.id ? -1 : 1)`. `localeCompare` is locale- and ICU-version-dependent (`'a'` vs `'B'` flips with collation, and Node's ICU data changes between releases), so it cannot underwrite a reproducibility promise; `<`/`>` on strings is a fixed code-unit comparison with no environment input.
   **The promise is an identical assignment PROJECTION, not identical rows.** Two generations over the same snapshot produce the same `(device_id → counted_as)` mapping and the same base/overage split. They do not produce byte-identical rows — `id` is a fresh uuid and `created_at` a fresh timestamp on every insert, so "byte-identical evidence" would be false as written.
   The tiebreak on `device_id` matters because hostnames are not unique in a fleet. The assignment is persisted in `counted_as`, so read paths need only a stable *display* order and use `ORDER BY hostname, id` (the SQL collation there affects presentation only, never which device was billed).

7. **Which line types produce evidence.** `per_device`, `per_device_role`, `per_device_group` — yes. `flat`, `manual` — no (nothing was counted). `per_seat` — **no**: seats are users, and seat evidence is explicitly out of scope in the roadmap; a `per_seat` line with an allowance still contributes to `overages`/`flagged_total` on the outcome row, it just has no device rows. A W02 `unresolved: 'group_deleted'` line cannot reach generation (it throws `GROUP_DELETED` first), so it needs no evidence branch.

8. **An outcome row is written for EVERY claimed period, including a flat-only contract with nothing to report.** "No row" then means exactly one thing — the period was billed before W07 — which is precisely the backfill boundary, and it keeps "did this period report zero uncovered, or report nothing?" from being ambiguous. A contract with no device-counted line gets `snapshot_device_total = 0`, `uncovered_total = 0`, `uncovered_by_role = '{}'`, `overages = '[]'`.
   **`snapshot_device_total = 0` means "no snapshot was evaluated", not "the org owns zero devices".** Generation only builds a snapshot when `lines.some(isDeviceLine)` (`contractService.ts:1119-1120`), so a flat-only contract records a zero that is an absence of measurement, not a measurement of zero. Any reader (UI, report, future analytics) must treat it that way; the column is deliberately not nullable because a NOT NULL zero with a documented meaning beats a three-valued column every consumer would have to branch on. The contract-detail row for such a period renders "No device lines" rather than "0 devices".

9. **No immutability trigger, and two service rules about draft lines.** Evidence is mutable-by-one-column and therefore NOT append-only. It is deliberately absent from `AUDIT_ADMIN_REQUIRED_TABLES`: the device hard-delete detach (`deviceDeletion.ts:238-240`) and the move-org detach are `UPDATE`s that `breeze_app` must be able to run, and an immutability trigger or a `REVOKE UPDATE` would turn a device delete into a 500. Immutability is a *service* property — there is no update route, no service function mutates a row after generation, and the only writes after insert are the two detaches. A `BEFORE UPDATE` trigger permitting only `device_id → NULL` is **rejected outright, not deferred**: the org-merge repoint (decision 11) is itself an `org_id` UPDATE on these rows, so a column-immutability trigger would break the merge as surely as it would break the detach.
    Two consequences for draft invoices, both stated so a later reader does not "fix" them:
    - **Deleting a draft invoice line deletes its evidence**, by the `(invoice_line_id, org_id)` FK's `ON DELETE CASCADE`. Correct: the line no longer exists, so evidence for it would be orphaned history about a charge nobody made.
    - **Editing a draft line's quantity does NOT alter its evidence.** Evidence records what the *generation* counted; an operator who hand-edits the quantity afterwards is overriding the bill, not rewriting history, and the period outcome row remains the record of what the run actually measured. Nothing in `updateLine` (`invoiceService.ts:453`) touches evidence, and nothing should.

10. **Device delete detaches; device org move detaches and keeps the invoice's org.** `invoice_line_devices` joins `DEVICE_DETACH_DEVICE_ID_TABLES` (`core.ts:153-155`), which buys the generic detach loop, backed by a single-column `device_id … ON DELETE SET NULL` FK. The FK is **single-column, not composite with `org_id`** — a composite `(device_id, org_id) → devices(id, org_id)` would break every cross-org device move, since the evidence must stay in the invoice's org while the device leaves it. For the move, the table goes in `INTENTIONALLY_NO_ORG_ID` (`moveOrg.coverage.test.ts:33-63`) plus the mirrored comment block in `core.ts`, and gets an **explicit `UPDATE invoice_line_devices SET device_id = NULL WHERE device_id = …`** in `moveOrg.ts` beside the `ai_agent_runs` one (`:251-254`) — the generic loop only visits denormalized tables and would otherwise leave a cross-tenant pointer. `hostname` is why this is survivable: the row still names what was billed.

10a. **BLOCKING FIX — `invoice_line_devices` is excluded from `breeze_device_child_orgid_tables()`.** Without this the device-move trigger restamps evidence `org_id` mid-`UPDATE devices` and the initially-immediate composite FKs raise 23503, failing every cross-org move of a billed device (Findings). A migration `CREATE OR REPLACE`s the discovery function, copying the newest definition verbatim (`migrations/2026-09-17-pam-device-move-guard.sql`) and adding one name to the existing exclusion list beside `ai_agent_runs` / `pam_actuations` / `pam_actuation_results`:

    ```sql
    AND t.relname NOT IN (
      'ai_agent_runs',
      'pam_actuations',
      'pam_actuation_results',
      -- Billing evidence stays in its INVOICE's org on a device move; the
      -- invoice and its lines do not move, so restamping the evidence row's
      -- org_id here trips invoice_line_devices_{line,invoice}_org_fk
      -- (DEFERRABLE INITIALLY IMMEDIATE) at the end of the trigger's own
      -- statement. moveOrg.ts detaches device_id instead (#3205 W07).
      'invoice_line_devices'
    )
    ```

    The exclusion means the trigger leaves the row entirely alone, and **`moveOrg.ts`'s explicit `UPDATE invoice_line_devices SET device_id = NULL WHERE device_id = …` is load-bearing, not a mirror** — unlike the `ai_agent_runs` statement at `:251-254`, which normally matches nothing because the trigger already ran it. Adding the detach to the trigger as well (so a direct SQL device move is also safe) is a sound hardening and is explicitly out of scope here; the route is the only supported move path today.

11. **Org merge repoints both tables; org erasure deletes them.** Plain `{ kind: 'repoint' }` entries in `REPOINT_TABLES` (alphabetically `invoice_documents` < `invoice_line_devices` < `invoice_lines`; `contract_billing_period_outcomes` < `contract_billing_periods`). Evidence follows its invoice's org, which under a merge is the survivor org — the same policy `invoices` and `invoice_lines` already carry, so evidence can never diverge from the document it evidences.

12. **Void keeps evidence; reissue clones it through a PRE-GENERATED id map.** A voided invoice is history and keeps every row. For reissue, the clone stops inferring new ids from `RETURNING` and generates them up front: a uuid is minted in application code for **every** source line, parents and children alike, the complete `oldToNew` map is built **before any insert**, and the ids are passed explicitly in the insert values. A lookup miss throws rather than inserting a null or mismatched `invoice_line_id`.
    *Why the current shape cannot carry evidence:* `invoiceService.ts:1665-1669` builds the map positionally — `.returning({ id })` then `parents.forEach((l, i) => oldToNew.set(l.id, inserted[i]!.id))` — which assumes `RETURNING` rows come back in input order. Postgres does not guarantee that, and today the consequence is invisible (the map is only used to re-point `parentLineId` among sibling bundle rows). Attach evidence to it and a reordered `RETURNING` silently files device rows under the wrong line. The children insert also never returned ids at all, so the map was parents-only. Pre-generated uuids remove the ordering assumption instead of adding a second one.
    Evidence rows are then cloned with `invoice_line_id` and `invoice_id` remapped and **every device pointer copied verbatim** — `device_id`, `hostname`, `device_role`, `site_id`, `counted_as` — so a row detached before the reissue (deleted or moved device) stays detached on the clone rather than being resurrected. `invoices.evidence_version` is copied too (decision 15a).

13. **Two read endpoints, both keyset-paged.** `GET /invoices/:id/lines/:lineId/devices` under `invoices:read` and `GET /contracts/:id/periods/:periodId/outcome` under `contracts:read`, using the existing `requirePermission(PERMISSIONS.X.resource, PERMISSIONS.X.action)` idiom (`routes/invoices/invoices.ts:21`). Both 404 (never 403) on a cross-tenant id, matching `getInvoice`/`getCustomerInvoice`. The device list is paged on `(hostname, id)` with `limit` ≤ 500 and carries `total` so the UI can say "showing 100 of 1,240".

14. **The PDF appendix is gated by a persisted pair, never by a render-time argument, and the gate is frozen at issue.** `partners.invoice_device_appendix boolean NOT NULL DEFAULT false` is the partner default (a dedicated column, per `autoEmailInvoiceOnQuoteAccept`'s stated rationale — a column keeps gate === read-back and has no #3608 unset/false ambiguity). `invoices.device_appendix boolean NULL` is the per-invoice override, `NULL` meaning "inherit". `loadInvoiceForRender` resolves `inv.deviceAppendix ?? partner.invoiceDeviceAppendix` and loads the rows; `renderInvoicePdfBuffer` gains a fourth argument and stays pure. `POST /:id/send` accepts `includeDeviceAppendix?: boolean` in `sendComposerSchema` and the route **persists it onto `invoices.device_appendix` before `issueInvoice`** — the only ordering that survives the async render job (Findings).
    *Rejected: threading the flag through `renderInvoicePdf(invoiceId, opts)`.* Verified dead: three call sites enqueue the render asynchronously at issue and `deliverInvoiceEmail` reuses a stored PDF, so the option would be dropped in the common path and silently lost on any later re-render.

14a. **The appendix choice is FROZEN AT ISSUANCE by stamping the resolved boolean, and the renderer reads only the stamp.** Inheritance (`invoice.deviceAppendix ?? partner.invoiceDeviceAppendix`) is resolved **once, at issue**, and written to `invoices.device_appendix` as a concrete `true`/`false`. After issuance the column is no longer an override-or-inherit tri-state but a settled fact, and `loadInvoiceForRender` reads **only** `invoice.deviceAppendix` — never the partner row. Consequence: a later change to the partner default cannot alter what a sanctioned re-render produces.
    **Both issuance writers stamp it** (Findings): `issueInvoice`'s update at `invoiceService.ts:1275-1282`, and the quote-acceptance deposit path at `quoteAcceptService.ts:295-302`, which explicitly never goes through `issueInvoice`. This is the same two-writer rule `document_locale` already follows, for the same reason.
    **The pre-issue override is a draft-guarded atomic update**, not a read-then-write: `UPDATE invoices SET device_appendix = $1 WHERE id = $2 AND status = 'draft'`, and **0 affected rows -> 409 `INVOICE_ALREADY_ISSUED`**. A check-then-write would race a concurrent issue and mutate an issued invoice.
    The guarantee is therefore not "byte-stable forever" — which would be false, since a reset-link re-render legitimately rewrites the PDF (`invoicePdf.ts:526-540` mints the public link into the document) — but: **the appendix choice is frozen at issuance and stable across every sanctioned re-render.** A re-render reproduces the same appendix decision the customer's first copy had.

15. **No backfill, and the absence is visible rather than silent.** Invoices generated before W07 have no evidence rows and no outcome row (roadmap, out of scope). The UI renders "Device detail was not recorded for this invoice" rather than an empty list, and the endpoint returns `{ recorded: false }` rather than `{ devices: [] }` — an empty list must keep meaning "zero devices were counted".

15a. **`invoices.evidence_version smallint NULL` is the recorded flag, and it lives at INVOICE level.** `1` means "evidence was written at generation by W07"; `NULL` means a pre-W07 invoice, or one never generated from a contract. It is copied verbatim onto a reissued draft (decision 12), so a clone does not read as historical.
     Both read endpoints return `recorded: invoice.evidenceVersion !== null` — **an invoice-level answer, deliberately not a per-line one.** Deriving `recorded` from "this line has zero evidence rows" would make a genuinely zero-device line (a `per_device_role` line matching nothing, which is a real and reportable outcome) indistinguishable from a pre-W07 invoice. The historical-absence message therefore renders once, at the top of the invoice's line table; inside a recorded invoice, an empty device list means exactly "zero devices counted".
     The column is a `smallint` version rather than a boolean so a future change to what generation records (seat evidence, a different disposition set) can be told apart from version 1 without a second column.

16. **Volume is bounded, chunked and indexed.** **Sizing: rows per period ≈ the number of devices counted across that contract's device lines** (a device matched by two lines produces two rows — it was billed twice). A 500-device org on a monthly all-devices contract writes 500 rows/month, 6k/year; two device lines double it. Concretely: inserts are **chunked at 500 rows per statement** inside the generation transaction, so a 5,000-device line is ten statements rather than one enormous parameter list; every FK child column carries an index (`invoice_line_id`, `invoice_id`, partial `device_id`) so the org cascade, an invoice-line delete and the device detach are all index scans; the outcome table's `contract_billing_period_id` is its primary key, which is the unique index the 1:1 relation needs. No retention or pruning — the rows are invoice evidence and share the invoice's lifetime. The PDF appendix filters `flagged` rows in SQL and then caps at 2,000 with an explicit truncation line, so a large fleet cannot produce a 100-page attachment.

## Design

### Schema

**Three migrations**, sorting after the newest committed file. W04's floor is `2026-10-07-100000-contract-lines-allowance-overage.sql`; W06 adds none. **Re-run `ls apps/api/migrations | sort | tail -3` before creating them** and bump past whatever is there.

The split exists because the two prerequisite unique indexes are built on **existing, live tables**. `invoice_lines` is one of the larger billing tables on a busy tenant, and a plain `CREATE UNIQUE INDEX` takes a `SHARE` lock that blocks every invoice write for the duration — the exact hazard `autoMigrate`'s `-- @no-transaction` directive exists for (`apps/api/src/db/autoMigrate.ts:652-670`: the marker runs the file **outside** a transaction, statement by statement, so `CREATE INDEX CONCURRENTLY` is legal, and its idempotency contract is why `IF NOT EXISTS` is mandatory — a failed `CONCURRENTLY` leaves an invalid index an operator must `DROP INDEX` before the next deploy).

**Migration A** `2026-10-08-100000-billing-evidence-fk-targets.sql`:

```sql
-- @no-transaction
-- #3205 wave 7 / #4656. Composite-FK targets on EXISTING hot tables, built
-- CONCURRENTLY so invoice writes are not blocked. IF NOT EXISTS is required by
-- the no-transaction idempotency contract (autoMigrate.ts:652-670).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS invoice_lines_id_org_uq
  ON invoice_lines (id, org_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS contract_billing_periods_id_org_uq
  ON contract_billing_periods (id, org_id);
```

**Migration B** `2026-10-08-100100-billing-evidence.sql` (transactional — it references the indexes Migration A built):

```sql
-- #3205 wave 7 / #4656: per-invoice billing evidence + per-period outcomes.
-- Shape-1 org tenancy on both tables (auto-discovered by rls-coverage).

DO $$ BEGIN
  CREATE TYPE invoice_line_device_counted_as AS ENUM ('included', 'overage', 'flagged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------ 1. device evidence
CREATE TABLE IF NOT EXISTS invoice_line_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_line_id uuid NOT NULL,
  -- Denormalized so the appendix and the per-invoice read need no join, and so
  -- the org cascade has a direct handle. Composite FK below proves it agrees
  -- with the line's invoice.
  invoice_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- SINGLE-column FK on purpose. A composite (device_id, org_id) would forbid
  -- every cross-org device move: the evidence stays in the INVOICE's org while
  -- the device leaves it (see moveOrg detach + INTENTIONALLY_NO_ORG_ID).
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  -- Stamps, captured from the generation snapshot. hostname is what keeps a
  -- detached row legible; device_role is what makes a later reclassification
  -- visible instead of silent. Width/nullability mirror devices.hostname
  -- (db/schema/devices.ts:60, varchar(255) NOT NULL).
  hostname varchar(255) NOT NULL,
  device_role text NOT NULL,
  site_id uuid,
  counted_as invoice_line_device_counted_as NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Lineage. DEFERRABLE: org merge repoints parent and child org_id separately.
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_line_org_fk
    FOREIGN KEY (invoice_line_id, org_id) REFERENCES invoice_lines (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_invoice_org_fk
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- PG15 column list is mandatory: without it SET NULL nulls org_id too (NOT NULL
-- -> 23502 on the parent delete). Same lesson as ai_agent_op_evidence.
DO $$ BEGIN
  ALTER TABLE invoice_line_devices ADD CONSTRAINT invoice_line_devices_site_org_fk
    FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
    ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One row per device per line. device_id NULLs do not collide, so a detached
-- row never blocks a later insert.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_line_devices_line_device_uq
  ON invoice_line_devices (invoice_line_id, device_id);
-- Per-line read (the disclosure endpoint) AND the FK-child index for
-- invoice_line_devices_line_org_fk: without it every invoice_lines DELETE
-- seq-scans this table. The unique index above leads on the same column but is
-- (invoice_line_id, device_id); this one carries the read's sort key.
CREATE INDEX IF NOT EXISTS invoice_line_devices_line_read_idx
  ON invoice_line_devices (invoice_line_id, hostname, id);
-- Per-invoice read (the PDF appendix) and the FK-child index for
-- invoice_line_devices_invoice_org_fk.
CREATE INDEX IF NOT EXISTS invoice_line_devices_invoice_read_idx
  ON invoice_line_devices (invoice_id, hostname, id);
-- Detach path (device delete + move-org) and "which invoices billed this device".
CREATE INDEX IF NOT EXISTS invoice_line_devices_device_idx
  ON invoice_line_devices (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoice_line_devices_org_idx ON invoice_line_devices (org_id);

ALTER TABLE invoice_line_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_update ON invoice_line_devices;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON invoice_line_devices;
CREATE POLICY breeze_org_isolation_select ON invoice_line_devices
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON invoice_line_devices
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON invoice_line_devices
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON invoice_line_devices
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE is required: the device hard-delete and move-org detaches are UPDATEs
-- run as breeze_app (deviceDeletion.ts:238-240). This table is deliberately NOT
-- append-only for that reason (decision 9).
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line_devices TO breeze_app;

-- ------------------------------------------------------------ 2. period outcome
CREATE TABLE IF NOT EXISTS contract_billing_period_outcomes (
  contract_billing_period_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contract_id uuid NOT NULL,
  invoice_id uuid,
  -- Scalars first: jsonb is excludedOpen and never reaches a tenant export, so
  -- no fact may live only in the digests below (decision 3).
  snapshot_device_total integer NOT NULL DEFAULT 0,
  uncovered_total integer NOT NULL DEFAULT 0,
  flagged_total integer NOT NULL DEFAULT 0,
  billed_overage_total integer NOT NULL DEFAULT 0,
  -- role -> count, mirroring UncoveredDevices.byRole.
  uncovered_by_role jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- W04 OverageSummary[] verbatim, BOTH modes.
  overages jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_period_org_fk
    FOREIGN KEY (contract_billing_period_id, org_id)
    REFERENCES contract_billing_periods (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_contract_org_fk
    FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Mirrors contract_billing_periods.invoice_id, which is itself SET NULL: a
-- deleted draft must not take the outcome with it.
DO $$ BEGIN
  ALTER TABLE contract_billing_period_outcomes ADD CONSTRAINT cbp_outcomes_invoice_org_fk
    FOREIGN KEY (invoice_id, org_id) REFERENCES invoices (id, org_id)
    ON DELETE SET NULL (invoice_id) DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS cbp_outcomes_contract_idx
  ON contract_billing_period_outcomes (contract_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS cbp_outcomes_org_idx ON contract_billing_period_outcomes (org_id);

ALTER TABLE contract_billing_period_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_billing_period_outcomes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contract_billing_period_outcomes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contract_billing_period_outcomes;
CREATE POLICY breeze_org_isolation_select ON contract_billing_period_outcomes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON contract_billing_period_outcomes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON contract_billing_period_outcomes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON contract_billing_period_outcomes
  FOR DELETE USING (public.breeze_has_org_access(org_id));
-- UPDATE for the org-merge repoint, same as the evidence table.
GRANT SELECT, INSERT, UPDATE, DELETE ON contract_billing_period_outcomes TO breeze_app;

-- ------------------------------------------------------------ 3. appendix gate
ALTER TABLE partners ADD COLUMN IF NOT EXISTS
  invoice_device_appendix boolean NOT NULL DEFAULT false;
-- Pre-issue: NULL = inherit the partner default, set only while status='draft'.
-- AT issue: both issuance writers stamp the RESOLVED boolean here, and the
-- renderer reads only this column thereafter (decision 14a).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS device_appendix boolean;
-- 1 = evidence written at generation by W07; NULL = pre-W07 or never generated
-- from a contract. Invoice-level `recorded` flag (decision 15a).
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS evidence_version smallint;
```

**Migration C** `2026-10-08-100200-device-move-exclude-billing-evidence.sql` (transactional) `CREATE OR REPLACE`s `public.breeze_device_child_orgid_tables()`, copying the newest definition verbatim from `migrations/2026-09-17-pam-device-move-guard.sql` with `'invoice_line_devices'` added to the `NOT IN` exclusion list and the rationale comment from decision 10a. It must sort **after** Migration B: the exclusion is meaningless until the table exists, and a fresh database replays them in filename order.

**Drizzle** (`apps/api/src/db/schema/invoices.ts`, `contracts.ts`, `orgs.ts`): both tables, the enum `invoiceLineDeviceCountedAsEnum`, the two new unique indexes on `invoiceLines`/`contractBillingPeriods` (declared as ordinary `uniqueIndex(...)` — `db:check-drift` compares definitions, not how they were built), `partners.invoiceDeviceAppendix`, `invoices.deviceAppendix`, `invoices.evidenceVersion`. The composite FKs and the `ON DELETE SET NULL (col)` column lists are **SQL-only** with a Drizzle comment saying so, following W01's site FK and W02's group FK. `pnpm db:check-drift` must be clean.

**Locks.** Migration A takes no blocking lock (both builds are `CONCURRENTLY`, outside a transaction). Migration B creates two empty tables and adds one `ADD COLUMN` with a non-volatile default on `partners` plus two nullable `ADD COLUMN`s on `invoices` — all metadata-only in PG11+. Migration C is a function replace. Sub-second on every tenant apart from Migration A's concurrent builds, which are online.

### Registration (the step that gets missed)

| List | Entry | File |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `contract_billing_period_outcomes` before `contract_billing_periods`; `invoice_line_devices` before `invoice_lines` | `services/tenantCascade.ts:188`, `:277` |
| `CORE_TENANT_EXPORT_POLICY` | both new tables, **plus** `device_appendix` **and** `evidence_version` added to the existing `invoices` row (`:227`) | `services/tenantExportPolicyRegistry.ts` |
| `REPOINT_TABLES` | both, alphabetically placed | `services/orgMergeRegistry.ts:484`, `:555` |
| `DEVICE_DETACH_DEVICE_ID_TABLES` | `invoice_line_devices` | `routes/devices/core.ts:153-155` |
| `INTENTIONALLY_NO_ORG_ID` + `core.ts` comment block | `invoice_line_devices` | `routes/devices/moveOrg.coverage.test.ts:33-63`, `core.ts:205-244` |
| `AUDIT_ADMIN_REQUIRED_TABLES` | **neither** (decision 9) | `services/tenantCascade.ts:674-682` |
| `breeze_device_child_orgid_tables()` exclusion list | `invoice_line_devices` (**blocking**, decision 10a) | Migration C; proved by the cross-org move integration test |
| `rls-coverage` allowlists | **none** — shape 1 is auto-discovered | — |

Export classification:

```ts
"contract_billing_period_outcomes": tablePolicy("org_id", {
  included: ["contract_billing_period_id","org_id","contract_id","invoice_id",
             "snapshot_device_total","uncovered_total","flagged_total",
             "billed_overage_total","generated_at"],
  reviewedIncluded: [], excludedSensitive: [],
  // DELIBERATE non-portability (decision 3), not an oversight: these two are
  // jsonb, so the open-container rule excludes them from every tenant export.
  // The scalar totals above are the exported facts, and the billed overage is
  // additionally a real priced row in invoice_lines. Do NOT "fix" this by
  // promoting either column to `included`.
  excludedOpen: ["uncovered_by_role","overages"],
}),
"invoice_line_devices": tablePolicy("org_id", {
  included: ["id","invoice_line_id","invoice_id","org_id","device_id","hostname",
             "device_role","site_id","counted_as","created_at"],
  reviewedIncluded: [], excludedSensitive: [], excludedOpen: [],
}),
```

`hostname` is ordinary customer inventory data (the same value `devices.hostname` already exports) and stays `included`.

### Generation (`apps/api/src/services/contractService.ts`)

`GenerateResult` gains nothing customer-visible; the shape it already returns (`priceBookGaps`, `uncoveredDevices`, W04's `overages`) is what gets persisted. New module-local types:

```ts
interface PendingEvidence {
  invoiceLineId: string;
  deviceId: string;
  hostname: string;
  deviceRole: string;
  siteId: string | null;
  countedAs: 'included' | 'overage' | 'flagged';
}
```

Inside W04's line loop, for a device line only:

```ts
// ONE call. `counted` IS the length of the evidence array — there is no second
// walk to disagree with, which is why no runtime cross-check is written here (a
// `matched.length !== Number(quantity)` guard would compare a value to its own
// stringification and assert nothing). The real guarantee is W06's
// `quantityFor === matchingDevicesForLine(...).length`, pinned by a parity test
// over the shared fixtures rather than by a tautology in the billing path.
const matched = matchingDevicesForLine(snapshot, l);          // W06 hand-off
quantity = String(matched.length);                            // = counted, pre-allowance
// UTF-16 code-unit order, NOT localeCompare: collation is locale- and
// ICU-version-dependent and cannot underwrite a reproducibility promise
// (decision 6).
const ordered = [...matched].sort((a, b) =>
  a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : (a.id < b.id ? -1 : 1));
```

after `applyAllowance` and after the base (and optional overage) lines are inserted:

```ts
const cut = r.included === null ? ordered.length : Math.min(r.included, ordered.length);
for (const [i, row] of ordered.entries()) {
  const countedAs = i < cut ? 'included'
    : r.overageMode === 'bill' ? 'overage' : 'flagged';
  pending.push({
    invoiceLineId: countedAs === 'overage' ? overageLine!.id : baseLine.id,
    deviceId: row.id, hostname: row.hostname, deviceRole: row.role, siteId: row.siteId,
    countedAs,
  });
}
```

**The invariants, stated in the terms W04 actually bills in.** For a device line matching `M` devices with allowance `N` (`included_quantity`):

| | `included` rows | `overage`/`flagged` rows | base invoice line quantity |
|---|---|---|---|
| no allowance (`N = null`) | `M` | 0 | `M` |
| `M < N` | `M` | 0 | **`N`** |
| `M = N` | `N` | 0 | `N` |
| `M > N`, `overage_mode='bill'` | `N` | `M − N` on the **overage** line | `N` |
| `M > N`, `overage_mode='flag'` | `N` | `M − N` on the **base** line | `N` |

In general: `included` rows = `min(M, N)`, tail rows = `max(0, M − N)`, base quantity = `N` under a fixed allowance **regardless of `M`**. The `M < N` row is the one that matters: W04's fixed allowance bills 25 while only 3 devices exist, so **evidence row count ≠ invoice quantity** and any test asserting "quantity equals row count" is wrong for every allowance line. The only unconditional identity is `included + tail = M`, and (without an allowance) `included = M = quantity`. `cut` uses `min(included, length)` precisely to produce this.

Immediately after the claim succeeds (`contractService.ts:1170`) and before the pointer advance:

```ts
const periodId = claimed[0]!.id;
// Chunked at 500 rows/statement (decision 16): one statement for a 5,000-device
// line would build a single enormous parameter list inside the billing
// transaction. All chunks are in the same transaction, so the all-or-nothing
// property is unchanged.
for (const chunk of chunksOf(pending, 500)) {
  await db.insert(invoiceLineDevices).values(chunk.map((p) => ({ ...p, invoiceId: inv.id, orgId: c.orgId })));
}
await db.update(invoices).set({ evidenceVersion: 1 }).where(eq(invoices.id, inv.id));  // decision 15a
const uncovered = hasDeviceLine ? uncoveredByRole(snapshot, lines) : null;
await db.insert(contractBillingPeriodOutcomes).values({
  contractBillingPeriodId: periodId, orgId: c.orgId, contractId, invoiceId: inv.id,
  snapshotDeviceTotal: snapshot.devices.length,
  uncoveredTotal: uncovered?.total ?? 0,
  uncoveredByRole: uncovered?.byRole ?? {},
  flaggedTotal: overages.filter((o) => o.mode === 'flag').reduce((n, o) => n + o.overage, 0),
  billedOverageTotal: overages.filter((o) => o.mode === 'bill').reduce((n, o) => n + o.overage, 0),
  overages,
});
```

`uncoveredByRole` moves from `:1185` to here; the returned `uncoveredDevices` is the same object, so callers are unchanged.

### Reissue (`apps/api/src/services/invoiceService.ts`)

The positional map at `:1665-1669` is replaced by pre-generated ids. Today:

```ts
// REPLACED — assumes RETURNING comes back in input order, which SQL does not promise.
const inserted = await db.insert(invoiceLines).values(parents.map((l) => cloneValues(l, null))).returning({ id: invoiceLines.id });
parents.forEach((l, i) => oldToNew.set(l.id, inserted[i]!.id));
```

becomes:

```ts
// Mint every new line id up front — parents AND children — so the map is
// complete and order-independent before a single row is written.
const oldToNew = new Map(srcLines.map((l) => [l.id, randomUUID()]));
const newId = (oldLineId: string): string => {
  const id = oldToNew.get(oldLineId);
  if (!id) throw new InvoiceServiceError(`Reissue clone: no mapping for line ${oldLineId}`, 500, 'INVALID_STATE');
  return id;
};
const parents = srcLines.filter((l) => l.parentLineId === null);
if (parents.length) {
  await db.insert(invoiceLines).values(parents.map((l) => ({ id: newId(l.id), ...cloneValues(l, null) })));
}
const children = srcLines.filter((l) => l.parentLineId !== null);
if (children.length) {
  await db.insert(invoiceLines).values(children.map((l) => ({ id: newId(l.id), ...cloneValues(l, newId(l.parentLineId!)) })));
}
```

Note the second behavioural fix hiding in there: the old child clone used `oldToNew.get(l.parentLineId!) ?? null`, silently promoting a child to a top-level line when its parent was missing. `newId` throws instead.

Then, after both passes, evidence clones through the same map — device pointers verbatim, so a detached row stays detached:

```ts
const srcEvidence = await db.select().from(invoiceLineDevices)
  .where(eq(invoiceLineDevices.invoiceId, invoiceId));
for (const chunk of chunksOf(srcEvidence, 500)) {
  await db.insert(invoiceLineDevices).values(chunk.map((e) => ({
    invoiceLineId: newId(e.invoiceLineId), invoiceId: draft!.id, orgId: e.orgId,
    deviceId: e.deviceId, hostname: e.hostname, deviceRole: e.deviceRole,
    siteId: e.siteId, countedAs: e.countedAs,
  })));
}
```

and the draft's insert (`:1657`) carries `evidenceVersion: inv.evidenceVersion` so the clone does not read as a pre-W07 invoice.

### Reads (`apps/api/src/services/billingEvidence.ts`, new)

```ts
export interface InvoiceLineDeviceRow {
  /** The EVIDENCE row's own id — the stable React key and cursor component.
   *  `deviceId ?? hostname` would collide across two detached rows sharing a
   *  hostname, which is exactly what a fleet with duplicate names produces. */
  id: string;
  deviceId: string | null; hostname: string; deviceRole: string;
  siteId: string | null; countedAs: 'included' | 'overage' | 'flagged';
}
/** Keyset-paged on (hostname, id). `recorded:false` distinguishes a pre-W07
 *  invoice from a line that genuinely counted zero devices (decision 15). */
export async function listInvoiceLineDevices(
  invoiceId: string, lineId: string, opts: { limit: number; cursor?: string }, actor: InvoiceActor
): Promise<{ recorded: boolean; total: number; devices: InvoiceLineDeviceRow[]; nextCursor: string | null }>;

export async function getPeriodOutcome(
  contractId: string, periodId: string, actor: ContractActor
): Promise<{ recorded: boolean; outcome: PeriodOutcome | null }>;
```

Both re-assert org access against the parent document and throw 404 (never 403) on a mismatch, matching `getInvoice`. **Both also assert same-parent ownership** — the line's `invoice_id` must equal the `:id` in the path, and the period's `contract_id` must equal the `:id` — so a valid line id from a *different* invoice in the same org is a 404 rather than a read of someone else's evidence through a mismatched path. Ownership is asserted in the SQL predicate, not after the fetch.

`recorded` comes from the **invoice** (`invoices.evidence_version !== null`), never from the row count (decision 15a): a recorded invoice with an empty device list means "this line counted zero devices", and only a pre-W07 invoice reports `recorded: false`. `getPeriodOutcome` reports `recorded: false` when the period predates W07 and has no outcome row.

### Routes

- `GET /invoices/:id/lines/:lineId/devices` — new `routes/invoices/evidence.ts`, mounted in `routes/invoices/index.ts` **before** `invoiceCrudRoutes` (param matchers last, per the file's existing ordering comment). `readPerm` = `requirePermission(PERMISSIONS.INVOICES_READ.…)`. Query: `limit` (default 100, max 500), `cursor`.
- `GET /contracts/:id/periods/:periodId/outcome` — new `routes/contracts/periods.ts`, mounted before `contractCrudRoutes`, gated on `PERMISSIONS.CONTRACTS_READ`.
- `POST /:id/send` (`routes/invoices/lifecycle.ts:45-50`): `sendComposerSchema` (`lib/sendComposer.ts:21-27`) gains `includeDeviceAppendix: z.boolean().optional()`; the handler applies it **before** calling `sendInvoiceEmail` (which issues, which enqueues the render) as the draft-guarded atomic update of decision 14a — `UPDATE invoices SET device_appendix = $1 WHERE id = $2 AND status = 'draft'`, **0 rows → 409 `INVOICE_ALREADY_ISSUED`** (the send is refused, rather than sending while silently ignoring the flag). Omitting the field on an issued invoice is unaffected. `composerOptions()` does **not** forward it — the column is the channel.
- **Issuance stamping** (decision 14a), the two writers found in Findings: `issueInvoice`'s update at `invoiceService.ts:1275-1282` and the quote-acceptance issue moment at `quoteAcceptService.ts:295-302` each resolve `invoice.deviceAppendix ?? partner.invoiceDeviceAppendix` and write the concrete boolean into the same update that sets `status`. Both already load the partner row for `terms` / branding, so this costs no extra query.
- `PATCH /partner/billing-settings` (`routes/invoices/settings.ts:22`): `partnerBillingSettingsSchema` gains `invoiceDeviceAppendix: z.boolean().optional()`, persisted by `updatePartnerBillingSettings` (`invoiceService.ts:833`) in the existing only-provided-fields shape.

### PDF (`apps/api/src/services/invoicePdf.ts`)

- `loadInvoiceForRender` (`:472`) reads `includeDeviceAppendix = invoice.deviceAppendix === true` — the **stamped** value only, never the partner row (decision 14a) — and when true loads evidence for the invoice ordered by `(hostname, id)` with their line descriptions. **The `counted_as <> 'flagged'` filter is in the SQL, applied BEFORE the 2,001-row cap**, so a line with 1,900 billed and 500 flagged devices does not spend its cap on rows that will never be printed and then falsely claim truncation.
- `renderInvoicePdfBuffer(invoice, lines, branding, appendix?)` — a fourth optional argument keeps the function pure and its existing pure-buffer test unchanged. When present and non-empty it emits `doc.addPage()` then a "Billed devices" section: one sub-heading per invoice line (`description`, counted total) and a three-column table (Hostname / Role / Counted as), reusing the `y > doc.page.height - 140 → addPage()` idiom at `:373`. Row 2,001 becomes "… and N more devices — see the invoice in Breeze."
- `flagged` rows are **not** printed (ruling 4): they were not charged, and putting them on the customer's document would read as a charge. They are operator evidence, surfaced on the internal invoice detail under a separate "Flagged, not billed" heading. Only `included` and `overage` reach the appendix.
- Drafts render the appendix in preview and still persist nothing (`:544-549`, unchanged).
- **No re-render path is added.** `renderInvoicePdf` keeps its single-argument signature and its existing upsert; because the gate is frozen at issue (decision 14a), an issued invoice's stored bytes and `pdf_sha256` are never rewritten by an appendix setting change.

### Web

- **`InvoiceDetail.tsx`** (`:313-370`): each line row gains a disclosure button when `line.deviceCount > 0`. Expanding lazily calls `GET /invoices/:id/lines/:lineId/devices` and renders a nested table — `data-testid="invoice-line-devices-${l.id}"`, rows `invoice-line-device-${deviceId ?? hostname}` — keyed by the evidence row `id` (decision 15a — `deviceId ?? hostname` collides across two detached rows sharing a hostname), with a "device removed" marker for a null `deviceId` and a "showing N of M" footer. The **"Device detail was not recorded for this invoice" notice renders once above the line table**, driven by the invoice's `evidenceVersion === null` — not per line, so a line that genuinely counted zero devices still expands to an explicit empty list. Devices with `counted_as = 'flagged'` render **below** the billed rows under their own "Flagged, not billed" sub-heading (ruling 4), `data-testid="invoice-line-devices-flagged-${l.id}"`, so an unbilled device can never be misread as a charge. Read-only: no `runAction` involvement.
- **`deviceCount` is computed on the invoice DETAIL read only (ruling 3)** — one grouped `count(*) … GROUP BY invoice_line_id` per detail view inside `getInvoice`. It is deliberately **not** added to `listInvoices` or any other list endpoint, where it would put a per-row aggregate on the invoice index. A line whose count is 0 renders no toggle at all, so a pre-W07 invoice shows an unchanged line table.
- **`ContractDetail.tsx`** (`:398-425`): the `contract-periods` table gains an **Outcome** column — "All billed", "37 uncovered", "3 flagged", or "—" for a pre-W07 period — and each row expands to the full outcome (`data-testid="period-outcome-${p.id}"`): the uncovered breakdown reusing W06's `DeviceCoverageNotice` role links, and the per-line overage digest reusing W04's `OverageNotice`. Both components already take the exact shapes the outcome row persists, so nothing new is rendered by hand.
- **`PartnerBillingSettings.tsx`**: an "Include billed devices appendix on invoice PDFs" checkbox beside `autoEmailInvoiceOnQuoteAccept`, read back as `p.invoiceDeviceAppendix === true`.
- **Send dialog**: an "Include billed devices appendix" checkbox defaulting to the partner setting, sent as `includeDeviceAppendix` only when the operator changes it.
- **Types** (`apps/web/src/lib/api/invoices.ts`, `contracts.ts`): `InvoiceLine` gains `deviceCount: number`; new `InvoiceLineDevice`, `PeriodOutcome`.
- **i18n**: all new strings in all eight locales (`de-DE`, `en`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`).

### Docs

`apps/docs/src/content/docs/features/contracts.mdx` and `.../invoices.mdx`: that Breeze records the exact devices behind every auto-counted line at generation and never re-derives them; that a device deleted or moved later keeps its hostname on past invoices; that the appendix is off by default and can be turned on per partner or per invoice; that invoices generated before this release have no device detail. Release notes entry under billing.

## Out of scope

- **Backfilling evidence for invoices generated before W07** (roadmap). There is no source to backfill from — the snapshot was never stored — so any "backfill" would be a re-derivation against today's fleet, which is exactly the lie this wave exists to remove.
- **Seat evidence.** `per_seat` counts users, not devices; a `contract_billing_period_user_seats` table is its own question (roadmap).
- **Portal and public-pay-link exposure** (#4562). `getCustomerInvoice` (`invoiceService.ts:780-801`) and `invoicesPublic.ts` are untouched.
- **QuickBooks.** The accounting push serializes invoice header + lines; evidence is not pushed and no mapping changes.
- **Row-level uncovered devices** (decision 2). If ever wanted, a third table keyed by `contract_billing_period_id`.
- **An immutability trigger / `REVOKE UPDATE`** on the evidence table (decision 9) — it would break the device-delete detach as written.
- **Retention or pruning** of evidence rows; they share their invoice's lifetime.
- **Re-rendering already-issued PDFs** for any reason. Ruling 2 makes this absolute: the appendix gate is draft-only, and neither the override nor the partner default touches a document that has issued.
- **A "which invoices billed this device" panel** on the device detail page. The index supports it; the surface is W06/#4562 territory.
- **Evidence for `flat` / `manual` lines** — nothing was counted, so there is nothing to evidence.

## Testing

Red first for each unit, then implement.

**The five (here, seven) contract suites this wave must satisfy — all needing a live DB except the two device ones:**

1. `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — both tables auto-discovered as shape 1; forced RLS, four policies, `breeze_app` grants present. **No allowlist edit** — an allowlist entry appearing for either table means the shape was got wrong.
2. `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts` — both tables present, alphabetisation intact (the `_` < `s` pair is the trap), FK children before parents under the runtime topo sort, and an org erasure with a generated invoice removes every evidence and outcome row.
3. `apps/api/src/routes/devices/cascadeDelete.test.ts` — `invoice_line_devices` in **exactly one** set (detach), and a device hard-delete emits exactly one `UPDATE invoice_line_devices SET device_id = NULL`.
4. `apps/api/src/routes/devices/moveOrg.coverage.test.ts` — the table is in `INTENTIONALLY_NO_ORG_ID`, the mirrored `core.ts` comment exists, and `moveOrg.test.ts` asserts the explicit detach statement is emitted.

**Cross-org device move, real DB** (`billingEvidenceDeviceMove.integration.test.ts` — the BLOCKING regression, decision 10a): seed org A with a generated invoice whose line carries evidence for device D, then move D to org B through the move-org path. Assert **the move succeeds** (a red here is the 23503 the exclusion exists to prevent); the evidence rows still carry **org A's** `org_id` and their invoice's `invoice_id`; `device_id` is `NULL`; `hostname` and `device_role` are unchanged; and the invoice's own `org_id` is untouched. Plus a direct assertion that `SELECT public.breeze_device_child_orgid_tables()` does **not** return `invoice_line_devices` — so a future `CREATE OR REPLACE` of that function which drops the exclusion fails here rather than in production.
5. `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` — every column classified (both jsonb columns `excludedOpen`), `invoices.device_appendix` added to the existing row, and the round-trip archive carries `invoice_line_devices.json` with hostnames plus the outcome row's scalar counters.
6. `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` — both tables classified `repoint`, neither in `SPECIAL`.
7. `apps/api/src/__tests__/integration/orgLifecycleFoundations.integration.test.ts` — **all six new composite FKs report `condeferrable = true`**. This is the suite W01 went red on (#4585) and it runs only in Integration Tests.

**Migration + constraints** (`billingEvidenceConstraints.integration.test.ts`, real DB as `breeze_app`): both unique indexes created (and `autoMigrate.test.ts` asserts Migration A carries the `-- @no-transaction` directive and that A → B → C sort in that order); the `(invoice_line_id, org_id)` FK rejects a line from another org (23503); the `(invoice_id, org_id)` FK rejects a cross-org invoice; `device_id` `ON DELETE SET NULL` nulls only `device_id` and keeps `org_id` and `hostname` (the 23502 regression the PG15 column list exists for); the same for `site_id`; deleting an invoice line cascades its evidence; deleting a `contract_billing_periods` row cascades its outcome; deleting a draft invoice leaves the outcome with a null `invoice_id`; `invoice_line_devices_line_device_uq` rejects a duplicate and permits two detached (null-`device_id`) rows; `autoMigrate.test.ts` covers the filename ordering.

**RLS isolation** (`billingEvidenceRls.integration.test.ts`): as `breeze_app` in org A's context, a forged insert carrying org B's `org_id` fails with `new row violates row-level security policy` (42501); org B's rows are invisible to a SELECT in org A's context; the system context sees both.

**Generation** (`billingEvidence.integration.test.ts`, real DB — the headline suite):
- **The disposition matrix (decision 4's invariants), one case per row** — for each, assert the `included` row count, the tail row count, which invoice line each row points at, and the base line's `quantity`:
  - no allowance, M = 12 → 12 `included` on the base line, 0 tail, quantity `'12.00'` (the "never 12 beside eleven rows" case);
  - M = 3, N = 25, `bill` → 3 `included`, 0 tail, **quantity `'25.00'`** — the case that proves row count ≠ quantity under a fixed allowance;
  - M = 25, N = 25, either mode → 25 `included`, 0 tail, quantity `'25.00'`, and **no overage invoice line**;
  - M = 30, N = 25, `bill` → 25 `included` on the base line, 5 `overage` on the **overage** line, quantity `'25.00'`;
  - M = 30, N = 25, `flag` → 25 `included` + 5 `flagged`, **both on the base line**, quantity `'25.00'`, no overage invoice line, `flagged_total = 5`.
  The unconditional identity `included + tail === M` is asserted in every case.
- Determinism as an **assignment projection**, not byte equality: generate the same fixture twice (second contract, same snapshot) and assert the two runs produce the same `device_id → counted_as` map and the same base/overage split. Row `id` and `created_at` differ by construction and are excluded from the comparison.
- Canonical ordering (decision 6) over a fixture containing **duplicate hostnames** (the `device_id` tiebreak decides the split), **mixed case** (`Alpha` vs `alpha` — code-unit order puts uppercase first, and the test pins that, so a later switch to `localeCompare` fails), and **non-ASCII hostnames** (`zürich-01`, `ZÜRICH-02`, a CJK name) where collation and code-unit order disagree.
- W04 `bill` mode at counted 30 / included 25: 25 `included` rows on the base line, 5 `overage` rows on the **overage** line, and the tail is the last five by `(hostname, id)`.
- W04 `flag` mode at counted 30 / included 25: 25 `included` + 5 `flagged`, **all on the base line**, no overage invoice line, `flagged_total = 5`.
- Allowance above the count (included 25, counted 3): three `included` rows, no tail, `overage = 0`.
- `per_seat`, `flat` and `manual` lines write **zero** evidence rows and still produce an outcome row.
- A flat-only contract still writes an outcome row with all-zero scalars.
- A lost claim race (pre-insert the period row on a second connection) leaves **zero** evidence rows and zero outcome rows, and the draft is deleted.
- A `GROUP_EVALUATION_FAILED` throw mid-generation leaves no invoice, no claim, no evidence.
- `uncovered_total` / `uncovered_by_role` equal what `uncoveredByRole` returns for the same fixture, and `snapshot_device_total` equals the snapshot length.
- A flat-only contract records `snapshot_device_total = 0` **and** `evidence_version = 1` on its invoice — the pair that says "measured nothing" rather than "not recorded" (decisions 8, 15a).
- A 1,200-row line writes all 1,200 rows across chunked statements in one transaction, and a throw injected on the third chunk leaves **zero** evidence rows, no claim and no invoice.

**Reissue** (`invoiceService.reissue.integration.test.ts`, extended): voiding with reissue clones every evidence row onto the new draft's lines with remapped `invoice_line_id` and the draft's `invoice_id`; the voided invoice keeps its own rows unchanged; a bundle child carrying evidence clones too; `evidence_version` is copied so the clone does not read as pre-W07; void **without** reissue clones nothing. Ordering-independence is asserted directly: with **three** parent lines whose evidence sets are distinguishable (different hostnames per line), every cloned row lands under the line that matches its hostnames — a test that fails if the map is ever rebuilt positionally from `RETURNING`. A **detached** source row (null `device_id`) clones as detached, hostname intact, and is not resurrected. A child line whose parent is absent from the map throws rather than silently cloning as a top-level line.

**Pure-helper parity** (`contractCoverage.test.ts`, extended — decision 5's real guarantee): for every W02/W06 fixture line and snapshot, `quantityFor(snapshot, line) === matchingDevicesForLine(snapshot, line).length`, and `matchingDevicesForLine` returns exactly the rows for which `coverageMatch(line, row, snapshot) !== null`. The deterministic sort is table-driven, including two devices sharing a hostname (the `id` tiebreak) and a null `siteId`.

**Draft-line service rules** (decision 9, real DB): deleting a draft invoice line deletes its evidence rows via the FK cascade; editing that line's `quantity` through `updateLine` leaves every evidence row and the period outcome untouched.

**Service unit** (`billingEvidence.test.ts`, Drizzle mocks): `recorded` follows `invoices.evidence_version` and **not** the row count — a recorded invoice with zero rows for a line returns `recorded: true, devices: []`, while a pre-W07 invoice returns `recorded: false`; a line id belonging to a different invoice in the same org is 404 (the same-parent ownership predicate), as is a period id belonging to a different contract; keyset paging on `(hostname, id)` is stable across a page boundary with duplicate hostnames; a cross-tenant `lineId` under a valid `invoiceId` is 404, not 403; a `limit` above 500 is clamped.

**Routes** (`routes/invoices/evidence.test.ts`, `routes/contracts/periods.test.ts`): both endpoints 401 unauthenticated, 403 without `invoices:read` / `contracts:read`, 404 cross-tenant, 200 with the paged shape; the send route persists `device_appendix` before issuing, 409s `INVOICE_ALREADY_ISSUED` when the flag is present on a non-draft invoice, and 400s on an unknown composer field (the `.strict()` guard); a line id from another invoice and a period id from another contract are both 404 (same-parent ownership).

**PDF** (`invoicePdf.appendix.test.ts` + integration): appendix absent with both flags false; present with the partner flag on; present with the partner flag off and the per-invoice override on; **absent with the partner flag on and the per-invoice override explicitly `false`**; `flagged` rows never appear in the rendered bytes (ruling 4); the 2,000-row cap emits the truncation line; the pure `renderInvoicePdfBuffer` still produces `%PDF-` with no appendix argument (the existing test, unchanged).

**Appendix frozen at issuance** (`invoicePdf.appendix.integration.test.ts`, real DB — decision 14a's guard):
- Both issuance writers stamp: an invoice issued via `issueInvoice` **and** a quote-acceptance deposit invoice each land a concrete `true`/`false` in `invoices.device_appendix`, inherited from the partner default at that moment.
- Freeze: issue with the partner default `false`, then flip `partners.invoice_device_appendix` to `true` and force a sanctioned **re-render** (the reset-link path). The re-rendered PDF still has **no** appendix — the renderer read the stamp, not the partner row. The mirror case (issued with `true`, partner later `false`) still renders the appendix.
- Draft guard: `POST /:id/send` with `includeDeviceAppendix: true` on an **issued** invoice is refused 409 `INVOICE_ALREADY_ISSUED` and writes nothing; on a **draft** it is accepted and the invoice issues with the appendix present. The atomic `WHERE status = 'draft'` is exercised by asserting 0 affected rows produces the 409 (not a pre-read).
- Flagged-before-cap: a line with 1,900 `included` and 500 `flagged` rows prints 1,900 device rows and **no** truncation line, proving the filter precedes the cap.

**Worker** (`contractWorker.test.ts`): a contract whose evidence insert throws rolls that contract back entirely and the sweep continues to the next.

**Web**: the invoice line disclosure fetches once, renders the device table, shows "device removed" for a null id, shows "showing N of M", and renders `flagged` devices under their own "Flagged, not billed" sub-heading below the billed rows; the not-recorded notice renders **once above the line table** for an invoice with `evidenceVersion === null` and **not at all** for a recorded invoice whose line has zero devices (which expands to an explicit empty list); rows are keyed by evidence id, proven by two detached rows sharing a hostname rendering as two rows; a line with `deviceCount === 0` renders no toggle; the invoice **list** payload carries no `deviceCount` (ruling 3, asserted against the list fetch mock); the contract period row renders each outcome variant and expands; the partner settings checkbox round-trips; the send dialog defaults to the partner setting and sends the field only when changed; `tr-TR` locale parity.

**Manual**: as `breeze_app` in psql, forge an `invoice_line_devices` insert carrying another org's `org_id` (must fail 42501) and one with a `NULL invoice_line_id` (must fail 23502). Hard-delete a billed device through the UI and confirm the past invoice still lists it by hostname with "device removed". Run `pnpm db:check-drift`.

## Rollout

No feature flag. Both tables start empty; `invoices.evidence_version` is NULL on every existing row, so every read path distinguishes "not recorded" from "zero devices" and pre-W07 invoices render honestly rather than as an empty list. The appendix is off for every partner until turned on.

**Migration order matters on a fresh database and on an upgrade alike:** A (`-- @no-transaction`, concurrent index builds) → B (tables, RLS, columns) → C (device-move exclusion). All three are additive and idempotent. If A's concurrent build fails, an operator must `DROP INDEX` the invalid index before redeploying — the standard `-- @no-transaction` recovery contract (`autoMigrate.ts:652-670`), and the reason B is a separate file that simply will not apply until A has succeeded.

**Deploying B without C is the one unsafe interleaving**, since the evidence table would then be auto-enrolled in `breeze_device_child_orgid_tables()` and every cross-org device move of a billed device would fail with 23503. They ship in the same release and the same PR; C's integration test is what proves the window is closed.

**Tenant export deliberately omits the two jsonb digests** (decision 3). Support should expect `uncovered_by_role` and `overages` to be absent from a customer archive and to answer breakdown questions from the UI; the scalar totals and the invoice lines are what the archive carries.

Self-hosters get it with the next release; their historical invoices stay without evidence, which the docs state plainly.

## Predecessor contract required from W04

W07 depends on one thing W04 must not drop, recorded here because it is a change to *W04's* code that only W07's tests would catch:

**W04's `generateDueInvoice` must keep the OVERAGE invoice line's id in scope.** W04 already destructures `const { line: baseLine, pricedFrom } = await addContractLine(...)` for the base leg (it needs `baseLine.taxable` and `baseLine.costBasis`). The second `addContractLine` call — the `bill`-mode overage sibling — currently discards its return value. W07's bill-mode path files `counted_as = 'overage'` rows against that line, so it must be captured as well:

```ts
const { line: overageLine } = await addContractLine(inv.id, { /* overage leg */ }, actor);
```

Flagged to be added to the W04 spec so the two waves cannot land out of step; without it W07's bill-mode branch has no `invoice_line_id` for the tail and the disposition matrix's fourth row is unimplementable.

## Resolved questions (Fable rulings + Codex quorum, 2026-09-03)

### Fable rulings (five questions carried out of the draft)

All five are ruled and folded into the design above; recorded here so a reviewer sees the decision and its consequence without re-reading the whole spec.

1. **Three roadmap column-level deviations — ALL RATIFIED.** The roadmap fixed W07's scope; these were the column-level choices it delegated ("The spec picks one representation", "which columns").
   - **No `device_group_id` on the evidence row.** The invoice line reaches its contract line via `source_id`, and W02 stamps both `device_group_id` and `device_group_name` there — so the group and its name are already named once per line, and repeating a line-constant on every device row would add an export-policy entry plus a dangling-uuid question (the group may be deleted) while answering nothing new.
   - **`overages jsonb` replaces the roadmap's `flagged_overage`, covering both W04 modes.** W04 emits one `OverageSummary[]` spanning `bill` and `flag`; persisting only the flag subset would drop the billed-overage digest the same contract-detail UI renders and fork W04's vocabulary.
   - **`counted_as = included | overage | flagged` with `invoice_line_id` NOT NULL; uncovered stays aggregate.** `uncovered_total` is a scalar and is exported; `uncovered_by_role` is jsonb and therefore `excludedOpen`. **The trade-off is explicit and accepted: uncovered device identity is not persisted.** A period row says how many devices this contract did not bill and by which role, never which ones; W06's coverage lookup answers "which devices are uncovered *right now*" against the live fleet. A device uncovered in March and covered since cannot be re-identified from the March row. (Decision 2.)

2. **Issued-PDF immutability — the appendix override is DRAFT-ONLY.** It may be set only while the invoice is a draft; once issued, the write is refused with 409 `INVOICE_ALREADY_ISSUED`, and neither the override nor a change to the partner default alters what an issued invoice renders. The partner setting applies to invoices issued after it changes, never retroactively.
   **Refined by Codex item 8 below — read that version.** This ruling's original wording ("issued PDFs are byte-stable; `invoice_documents` and `pdf_sha256` are never rewritten") is **withdrawn as factually wrong**: the reset-link path legitimately re-renders and rewrites the stored document (`invoicePdf.ts:526-540`). The mechanism that actually delivers this ruling's intent is stamping the resolved boolean at issuance and having the renderer read only the stamp, so the guarantee is *frozen at issuance and stable across sanctioned re-renders* (decisions 14/14a, the Routes and PDF sections, and the "Appendix frozen at issuance" integration test).

3. **`InvoiceLine.deviceCount` is a DETAIL-read-only aggregate.** One grouped `count(*) … GROUP BY invoice_line_id` per invoice detail view inside `getInvoice`; never added to `listInvoices` or any other list endpoint, where it would put a per-row aggregate on the invoice index. The disclosure toggle renders when `deviceCount > 0`. (Web section; asserted in the web tests.)

4. **Flagged devices are excluded from the customer-facing PDF appendix.** They were not charged, so printing them on the customer's document would read as a charge. They appear on the internal invoice detail under a separate "Flagged, not billed" heading below the billed rows. (PDF and Web sections.)

5. **`devices.hostname` verified, and the second-hand web cites corrected.** `hostname: varchar('hostname', { length: 255 }).notNull()` at `apps/api/src/db/schema/devices.ts:60` — which is why the evidence stamp is `varchar(255) NOT NULL` and never needs a null branch. `PartnerBillingSettings.tsx` re-read directly: root `data-testid="partner-billing-settings"` at `:184`, the `autoEmailInvoiceOnQuoteAccept` checkbox at `:266-272` (`data-testid="partner-billing-auto-email-invoice"`), loaded at `:85` as `p.autoEmailInvoiceOnQuoteAccept !== false`, saved at `:136`, state in the save-deps array at `:170`. That `!== false` read is the #3608 pattern in the flesh and is why the new partner flag is a `NOT NULL DEFAULT false` column rather than a jsonb key.

### Codex quorum (xhigh) — "proceed with changes", one blocking item

All twelve are folded in above. Verified against code, with the citation that settled each.

1. **Migration split.** Prerequisite unique indexes on the live `invoice_lines` / `contract_billing_periods` move to a `-- @no-transaction` Migration A using `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS` (`autoMigrate.ts:652-670` — the marker runs the file outside a transaction and imposes the `IF NOT EXISTS` idempotency contract). Migration B creates both tables with **complete** RLS — enable, force, all four command policies and the `breeze_app` grants written out for each table; the outcome table's placeholder comment is gone.
2. **BLOCKING — device org move.** Confirmed real: `breeze_cascade_device_org_id()` (AFTER trigger on `devices`, `2026-10-04-100000-ticket-requester-contact.sql:138-186`) loops `breeze_device_child_orgid_tables()` (`2026-09-17-pam-device-move-guard.sql`), which **dynamically discovers every public table with uuid `device_id` + uuid `org_id`** and restamps `org_id` during the `devices` UPDATE, before any route code. `invoice_line_devices` would be auto-enrolled and the initially-immediate composite FKs would raise 23503, failing the move — the same shape as the `tickets_requester_contact_org_fk` case that migration documents at `:100-116`. Fix: Migration C `CREATE OR REPLACE`s the discovery function with `'invoice_line_devices'` added to its exclusion list (decision 10a); the move route's detach then runs as designed and is **load-bearing rather than a mirror**. Guarded by a real-DB move test that also asserts the function does not return the table.
3. **jsonb non-portability accepted explicitly** (decision 3), stated in the export-policy row comment ("Do NOT 'fix' this by promoting either column to `included`") and in Rollout.
4. **Evidence invariants are disposition counts, not "quantity === row count"** (decision 4 table): `included` = `min(M, N)`, tail = `max(0, M − N)`, base quantity = `N` under a fixed allowance regardless of `M`; without an allowance `included = M = quantity`. Five test cases, including the `M < N` case that makes the old assertion false.
5. **Canonical ordering is UTF-16 code-unit comparison then id** (decision 6), and the promise is an identical assignment *projection*, not byte-identical rows. Tested against duplicate, mixed-case and non-ASCII hostnames.
6. **Reissue pre-generates every line uuid** (parents and children), builds the complete map before any insert and throws on a miss, replacing the positional `RETURNING` map at `invoiceService.ts:1665-1669`; evidence then clones with remapped line/invoice ids and verbatim device pointers, so a detached row stays detached.
7. **`invoices.evidence_version smallint NULL`** is the invoice-level recorded flag (decision 15a), copied on reissue; the historical-absence notice renders once above the line table so a zero-device line stays distinguishable; device rows are keyed by the evidence row id; both endpoints assert same-parent ownership in SQL.
8. **The appendix boolean is stamped at both issuance writers** — `invoiceService.ts:1275-1282` and `quoteAcceptService.ts:295-302`, which never goes through `issueInvoice` — the pre-issue override is a draft-guarded atomic UPDATE (0 rows → 409), and the renderer reads only the stamp. "Byte-stable" is replaced by **"frozen at issuance and stable across sanctioned re-renders"**, since the reset-link path legitimately rewrites the PDF (`invoicePdf.ts:526-540`).
9. **No immutability trigger** — rejected outright, not deferred: the org-merge repoint is itself an `org_id` UPDATE, so such a trigger would break the merge as well as the detach. The two draft-line rules (delete cascades evidence; a quantity edit does not touch it) are stated in decision 9 and the cascade is tested.
10. **Volume**: 500-row insert chunks inside the transaction, FK/read indexes on `invoice_line_devices(invoice_line_id, …)`, `(invoice_id, …)`, partial `(device_id)` and the outcome table's PK, the appendix's flagged filter moved ahead of the 2,001-row cap, and a sizing note (rows per period ≈ devices counted, a device on two lines counting twice).
11. **W04 predecessor contract** recorded in its own section: W04's generation must capture the overage `addContractLine`'s returned `line`, which W07's bill-mode path needs for `invoice_line_id`.
12. **`snapshot_device_total = 0` means "no snapshot evaluated"**, not "the org owns zero devices" — generation only builds a snapshot when a device-counted line exists (`contractService.ts:1119-1120`). Stated in decision 8, with the contract-detail row rendering "No device lines".
