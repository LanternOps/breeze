# RMM migration epic (#3249) — Phase 3 design session prompt

> **Paste everything below the line into a fresh session.** It is written to be
> self-contained: it carries the verified state of the code, the decisions
> already made, and the working rules this epic has earned the hard way.

---

## Mission

Design — **do not implement** — Phase 3 of the RMM migration epic (#3249):

- **#3258 — first-class contacts.** A data-model decision. It may resolve as
  *"the PSA owns contacts, link read-through"* rather than a local table.
  **Settle this first**: it gates the shape of everything else, and building the
  wrong thing here is expensive to unwind.
- **#3257 — custom-field / UDF backfill import.** The largest chunk of genuine
  customer data an MSP abandons when migrating: warranty expiry, asset tag,
  purchase date, primary user, contract reference — hand-entered over years.

The deliverable is **specs and plans, reviewed and committed** — not code. Two
design docs under `docs/superpowers/specs/<area>/2026-08-XX-<slug>-design.md`
with matching implementation plans under `docs/superpowers/plans/`, following the
Phase-1 pattern (e.g. `specs/onboarding-signup/2026-08-08-bulk-org-site-import-design.md`
and `plans/2026-08-08-org-external-links-and-bulk-import.md`).

Stop and check in with the user before writing implementation code.

## Working rules for this epic (learned the hard way — binding)

- **Trace the end-to-end data flow, not just the contract checklists.** An
  adversarial review of the three Phase-1 specs found all three were correct on
  RLS shapes, cascade lists, and export policy — and all three had a defect in
  the *primary flow* that the contract tests would have passed straight through.
- **Second-order writers are where the bugs are.** Moving a reader to a new
  table without its writer silently mints duplicate tenants. When you introduce a
  new home for data, sweep for everyone who writes the old one.
- **Run an adversarial reviewer on any consequential design before implementing.**
  Spawn a subagent prompted to *refute*, since `codex` is not authenticated on
  this machine. It has earned its keep every single time: last session it caught
  a live authz gap (#3262), three spec defects, and pre-empted an SSRF hole in
  PSA pagination cursors.
- **Never take a subagent's "done" at face value.** Verify the claim yourself —
  the commit exists, on the right branch, and the mechanism is what was described.
- **Ask the right question, not the familiar one.** Phase 2's worst bug was an
  authz gate copied from a sibling route: it asked "is this connection
  partner-owned?" when the correct question was "how wide does this write reach?"
  A refactor in the same PR also silently dropped a guard added earlier in the
  same epic. Both passed review once before being caught.

## State at handoff (2026-08-09) — Phase 2 is COMPLETE

Everything below is merged to `main` with CI green.

| Issue | PR | Shipped |
|---|---|---|
| #3242 | #3283 | org-import hardening; closed with a won't-fix note on CSV-body parsing |
| #3246 | #3311 | PSA `getCompanies()` wired into org import via the `OrgImportSource` seam |
| #3247 | #3284 | X-API-Key docs across all **four** surfaces + `openapi.ts` |
| #3248 | #3285 | `migration/mass-deployment.mdx` (GPO/Intune/JAMF) |

Also landed: `psa_connections` dual ownership (org XOR partner) per the #2135
playbook, a real `/test` route, an honest 501 on the dead `/sync`, origin-pinned
PSA pagination, the QuickBooks importer migrated onto the shared seam, and the
legacy `accounting_provider` / `accounting_external_id` columns dropped.

**Open in the epic:** #3257 and #3258 only. Epic #3249 has a Phase 2 completion
comment with the full detail.

**The import pipeline you will design against exists and is proven:**
`services/orgImport/` — `OrgImportSource { system, list(ctx) }`, plus
`previewOrgImport` / `commitOrgImport`, annotations
`create | link-match | name-match | matched-soft-deleted | conflict`, a
`checkExpectation` TOCTOU guard, and `organization_external_links` for external
identity. `services/psa/companyImport.ts` is the reference implementation of the
seam; `apps/web/src/components/organizations/OrgImportPreviewTable.tsx` is the
shared preview table both importers render.

## Ground truth verified 2026-08-09 (don't re-derive this)

**Custom fields (#3257) — the destination exists, the import path does not.**

- `apps/api/src/db/schema/customFields.ts` — `custom_field_definitions` is the
  only table in the file. It already carries **both** `org_id` and `partner_id`
  as nullable FKs. Columns: `name`, `fieldKey`, `type`
  (`text|number|boolean|dropdown|date` enum), `options` jsonb, `required`,
  `defaultValue` jsonb, `deviceTypes` text[].
  *Check whether it has a `one_owner_chk` XOR constraint and a dual-axis RLS
  policy — if not, it predates the #2135 playbook and this is the moment to fix it.*
- **Values are NOT a table.** They live in `devices.customFields` — a
  `jsonb('custom_fields').default({})` column (`db/schema/devices.ts:105`).
  The write path (`routes/devices/customFieldValues.ts:230`) does
  `{ ...existing, ...updates }` and writes the merged blob, so **overwrite-on-
  rerun idempotency (#3257 requirement 4) already falls out of the storage model**.
  A jsonb column is `excludedOpen` under the export policy — relevant if you
  propose promoting values to a real table.
- Routes: `routes/customFields.ts` (definitions) and
  `routes/devices/customFieldValues.ts` (values, incl. an X-API-Key surface).

**Contacts (#3258) — nothing exists.**

- No `contacts` table. `organizations.billingContact` (`db/schema/orgs.ts:119`)
  and `sites.contact` (`:151`) are bare `jsonb` columns — no shape enforced at
  the DB layer.
- `services/aiToolsOrgs.ts:431` — `add_contact` returns a structured
  `CONTACT_ENTITY_UNDEFINED` "needs a product decision" note and writes nothing.
  The tool description at `:478` advertises it as "not yet supported".
- Every migration guide under `apps/docs/src/content/docs/migration/` currently
  tells the reader to enter contacts by hand or keep them in the PSA. Those pages
  need updating by whatever this design concludes.

## Design questions to settle

**#3258 — decide this one first.**

1. Real `contacts` table (org-scoped, shape 1) with a role/type and optional site
   association — or keep JSONB and merely allow an array?
2. **Or read-through from the PSA**, which is usually the system of record. The
   issue itself flags this as possibly the real answer. Phase 2 shipped the PSA
   connection plumbing that would make it feasible; weigh it honestly rather than
   defaulting to a table because a table is the familiar move.
3. If a table: the full tenancy contract in the creating migration — RLS
   policies, `CORE_ORG_CASCADE_DELETE_ORDER`, and `CORE_TENANT_EXPORT_POLICY`.
   Contact details are personal data, so the export/erasure classification
   matters more here than usual. This is squarely GDPR-relevant.
4. Migration path for existing `billingContact` / `contact` JSONB values.
5. Does `add_contact` become real as part of this, or stay stubbed?

**#3257.**

1. **The join key is the hard part.** The only key available across every source
   is **hostname** — not unique across a partner, and it changes when a machine
   is renamed. Ambiguous match: reject the row, or require an explicit `deviceId`?
2. Import the incumbent's field *types*, or land everything as text and let the
   operator retype? (Breeze types are `text|number|boolean|dropdown|date`.)
3. Scope: device-level only, or also org/site-level fields? ConnectWise Automate
   and N-central both have them; Breeze's definitions table has no site axis.
4. This runs **after** enrollment (devices must exist), so it is inherently a
   second pass — see `apps/docs/src/content/docs/migration/overview.mdx` Phase 4.
   It cannot share a transaction, payload, or UI flow with the org importer.
5. Source field surfaces are enumerated in the issue body (Datto `udf1`–`udf30`,
   Automate EDFs, Kaseya VSA, NinjaOne, N-central, Atera).

## Repo gotchas that cost time last session

- **`rg -na`, never bare `grep -r`.** `services/orgImport/index.ts` contains a
  literal NUL byte, so `grep` classifies it as binary and prints nothing — no
  match, no warning. It held the *only* production reader of a column I was
  about to drop, and the sweep reported zero hits.
- **`gh pr checks` lies about Integration Tests.** Those shards are
  `continue-on-error` on pull requests, so a genuine failure renders as a pass.
  Read the real values:
  `gh api repos/LanternOps/breeze/actions/runs/<id>/jobs --jq '.jobs[] | select(.conclusion!="success")'`.
- **Stacked PRs run no CI at all.** `ci.yml` triggers on
  `pull_request: branches: [main]`, so a PR based on a sibling branch runs only
  the two smoke workflows — and `gh pr checks` reads green. Branch from `main`,
  or dispatch per branch: `gh workflow run CI --ref <branch>`.
- **`2026-08-06` is a CLOSED migration date block.** Never add `-g-`. Use a plain
  `YYYY-MM-DD-<slug>.sql` on a later date — today's date already sorts last,
  which is the property you actually want.
- Issue state lags the code on this epic. `git ls-tree -r --name-only origin/main | rg <thing>`
  is the reliable check.
- `pnpm` is unusable on this machine (Node 20 vs the required 22) — run
  package-local `vitest` / `tsc` directly; the api `tsc` needs a larger heap.
- Cap concurrent subagents at 2–3. Twelve parallel `tsc`/`vitest` runs crashed
  the session twice.

## Suggested shape for the session

1. Read both issue bodies in full (`gh issue view 3257` / `3258`) — they contain
   source-by-source field tables not reproduced here.
2. Settle #3258's question 2 (local table vs PSA read-through) **before**
   designing either doc. Form a position, then have an adversarial subagent try
   to refute it. If the two disagree, weigh it on the merits and surface the
   disagreement to the user with a recommendation rather than silently picking.
3. Write both design docs, then run one adversarial review pass over them.
4. Present the plan and the open product decisions to the user. Do not start
   implementation without a green light.
