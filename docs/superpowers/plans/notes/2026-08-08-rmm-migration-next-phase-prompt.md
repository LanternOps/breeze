# Session prompt — RMM migration epic, Phase 2/3

Paste the block below into a fresh Claude Code session in `/home/todd/breeze`.

---

## Prompt

> Continue the RMM migration epic (#3249). Phase 1 shipped: `organization_external_links` + bulk org/site import, partner-API provisioning writes (#3243), the fleet posture report (#3244), script bundles (#3245), and the partner-wide scripts gate (#3262) are all on `main`. Docs are in PR #3250, specs and plans in PR #3279.
>
> **Verify before trusting any of the above** — check `main` directly rather than the issue states, which have lagged reality on this epic. `#3242` is still open despite `apps/api/src/services/orgImport/` and `apps/web/src/components/organizations/BulkOrgImport.tsx` both existing on `main`; work out what remains and either close it or scope the remainder.
>
> Then take Phase 2 in this order:
>
> 1. **#3246 — PSA `getCompanies()` → org import.** Every PSA adapter implements it (`apps/api/src/services/psa/types.ts:62`) and nothing calls it. The `OrgImportSource` seam it plugs into now exists at `apps/api/src/services/orgImport/types.ts`. Also decide what to do about `POST /psa/connections/:id/sync` (`routes/psa.ts`), which writes `lastSyncStatus: 'queued'` with no worker consuming it, and about `halo`/`syncro`/`kaseya` being in the `psa_provider` enum and the connection wizard with no adapter file.
> 2. **Migrate the QuickBooks importer onto the shared seam.** `quickbooksCustomerImport.ts` should keep its provider client but delegate preview/commit to `services/orgImport/`. Confirm it currently dual-writes both `organization_external_links` and the legacy `accounting_provider`/`accounting_external_id` columns — if it does not, that is a live duplicate-organization bug and takes priority over everything else in this list.
> 3. **Drop `accounting_provider` / `accounting_external_id`** (still present on `main`: 2 refs in `db/schema/orgs.ts`) once every reader and writer is on the link table. Contract phase. **This also requires updating the `organizations` entry in `CORE_TENANT_EXPORT_POLICY`** — removing a column from a registered table breaks `tenant-export-policy.integration.test.ts` exactly as adding one does. Sweep first: `grep -rn "accountingExternalId\|accounting_external_id" apps/api/src`.
> 4. **#3247** — one-paragraph docs fix, still open. `reference/api.mdx` documents `X-API-Key` as general-purpose auth with a `/devices` example that returns 401; it is accepted only on the MCP server, dev-push, and device custom-field-value surfaces.
> 5. **#3248** — GPO / Intune / JAMF deployment guide. Note `agent/scripts/install/install-windows.ps1` takes no enrollment parameters, so document the MSI-properties path rather than a PS1 one-liner (or fix the script and say so).
>
> Phase 3 (#3257 custom-field/UDF backfill, #3258 first-class contacts) needs design work before code — #3258 in particular may resolve as "the PSA owns contacts, link read-through" rather than a local table. Do not start either without settling that.
>
> Working rules for this epic, learned the hard way:
> - **Trace the end-to-end data flow, not just the contract checklists.** An adversarial review of the three Phase-1 specs found all three were correct on RLS shapes, cascade lists, and export policy — and all three had a defect in the primary flow that the contract tests would have passed straight through.
> - **Second-order writers are where the bugs are.** The dual-write gap above is the canonical example: moving a reader to a new table without its writer silently mints duplicate tenants.
> - **Run an adversarial reviewer on any consequential design before implementing** — spawn a Fable subagent prompted to refute, since `codex` is not authenticated here. It earned its keep last time: it caught a live authz gap (#3262) plus three spec defects.

---

## State at handoff (2026-08-08)

**Shipped to `main`:** `2026-08-08-organization-external-links.sql`, `db/schema/orgExternalLinks.ts`, `services/orgImport/*`, `web/components/organizations/BulkOrgImport.tsx`, `routes/scriptBundle.ts` + `services/scriptBundle/*`, `services/managementPostureReport.ts`, `routes/partnerApi/writeSurface.test.ts`, and the `canManagePartnerWidePolicies` gate in `routes/scripts.ts` (4 refs).

**Open PRs:** #3250 (migration guides, docs-only, 11 files) · #3279 (specs + plans, 8 files). Both rebased onto current `main` as single commits.

**Open issues:** #3242 (bulk import — likely partly shipped, needs triage), #3246, #3247, #3248, #3257, #3258.

**Closed:** #3243, #3244, #3245, #3262.

### Gotchas that cost time this session

- The working branch was cut from `docs/proxy-linking-specs`, not `main`, and drifted **114 commits** behind while the implementations landed. Always `git fetch origin main` and check `git rev-list --count HEAD..origin/main` before reasoning about what exists.
- `git add docs/superpowers/plans/open/` swept in an unrelated sibling-branch plan. Stage explicit paths on this repo — several parallel doc branches touch the same directories.
- Issue state lagged the code by a lot on this epic. `git ls-tree -r --name-only origin/main | grep <thing>` is the reliable check.
