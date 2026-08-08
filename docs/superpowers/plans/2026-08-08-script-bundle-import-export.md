# Script Library Import / Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move a script library into Breeze from another RMM — or between instances — carrying the metadata that makes it a library rather than a pile of files.

**Architecture:** A versioned JSON bundle format with export, preview, and import endpoints under `/scripts/bundle/*`. Loose `.ps1`/`.sh` files are converted to a bundle client-side, so the API keeps a single JSON intake path. No new tables.

**Tech Stack:** Hono routes, Zod, Drizzle ORM, React (web), Vitest.

**Spec:** `docs/superpowers/specs/onboarding-signup/2026-08-08-script-bundle-import-export-design.md`
**Issue:** #3245 · **Epic:** #3249

> **✅ SHIPPED** — merged to main as `739e8d84b` (PR #3276), unblocked by #3262. All eight tasks landed: bundle schema v1 with per-entry validation, export/preview/import routes (20MB body carve-out), the `scriptWrite.ts` chokepoint shared with `POST /scripts`, unconditional `isSystem`/tenancy stripping, the partner-availability gate, the `ScriptBundleImport` web UI (loose-file folder → bundle conversion client-side), and docs (`features/scripts.mdx`; the toolkit Recipe 6 rewrite landed with the docs branch, PR #3250). **Deferred:** the review's below-the-line cleanups (shared Dialog, downloadBlob/runAction unification for the export GET, shared enums from `@breeze/shared`, audit batching, a preview→import expected-state contract — recorded as follow-ups in the fix commit) and a live-DB end-to-end export→import round-trip; the unit/route suites' round-trip coverage stands in.

---

## BLOCKED ON #3262 — do not start Task 5 until it merges

`POST /scripts` gates partner-wide creation on `auth.scope === 'partner'` alone, with no `canManagePartnerWidePolicies` check (#3262). Importing a bundle with `availability: 'partner'` over that path turns one upload into a SYSTEM-level script fanned out to every organization under the partner.

Tasks 1–4 and 6–7 can proceed. Task 5 (the `'partner'` option) lands only after #3262.

**A bundle is untrusted input regardless of who uploads it, and its contents run as SYSTEM on customer endpoints.** Task 4 is the heart of this plan.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `apps/api/src/services/scriptBundle/index.ts` | `previewBundle` / `importBundle` / `exportBundle` |
| `apps/api/src/services/scriptBundle/schema.ts` | Zod bundle schema, v1 |
| `apps/api/src/services/scriptBundle/index.test.ts` | Unit tests |
| `apps/web/src/components/scripts/ScriptBundleImport.tsx` | Upload → preview → commit |

### Modified files
| File | Change |
|---|---|
| `apps/api/src/routes/scripts.ts` | Three `/scripts/bundle/*` routes |
| `apps/docs/src/content/docs/features/scripts.mdx` | Document bundles |
| `apps/docs/src/content/docs/migration/toolkit.mdx` | Replace Recipe 6 |

---

## Task 1: Bundle schema (v1)

- [x] Define the Zod schema in `scriptBundle/schema.ts`:
  ```jsonc
  { "bundleVersion": 1, "exportedAt": "...", "scripts": [ {
      "name", "description?", "category?", "tags?": [],
      "osTypes": ["windows"], "language": "powershell", "content",
      "parameters?", "timeoutSeconds?", "runAs?", "exitCodeSeverityMapping?"
  } ] }
  ```
- [x] Categories and tags travel **by name**, never by id — ids are meaningless across instances and would leak the source tenant's identifiers.
- [x] Reject an unknown `bundleVersion` with a clear error. Do not best-effort parse.
- [x] The schema must **not** contain `id`, `orgId`, `partnerId`, `createdBy`, or `isSystem`. Use `.strip()`/`.strict()` semantics so their presence in an uploaded file cannot carry through.

## Task 2: Export

- [x] `GET /scripts/bundle/export?ids=…`, scoped to what the caller can already read.
- [x] System-library scripts are exportable (they are not secret) but export with `isSystem` **absent**, so a round-trip cannot launder them back in as system scripts.
- [x] Emit no tenancy identifiers.

## Task 3: Preview + import service

- [x] `previewBundle` annotates each entry `new` / `name-conflict` with the resolved target and any validation error. No writes.
- [x] `importBundle(bundle, { mode, availability }, actor)` where `mode: 'skip' | 'rename' | 'new-version'`:
  1. validate `bundleVersion`, then each entry against the **existing** `createScriptSchema` rules (`osTypes` non-empty, `language` enum, `timeoutSeconds` 1–3600, `runAs` enum) — reuse, don't restate;
  2. resolve categories and tags by name in the target scope, creating what's missing;
  3. apply `mode` against an existing same-name script in scope;
  4. write through the **same service path** `POST /scripts` uses — not raw inserts — so the `isSystem` clamp, audit, and validation cannot diverge;
  5. per-entry failure recorded, remaining entries proceed.
- [x] Response: `{ imported, skipped, renamed, versioned, errors }`.

## Task 4: Security — the part to review hardest

- [x] **Strip `isSystem` unconditionally**, at every caller scope — stricter than `POST /scripts`, which permits it for `auth.scope === 'system'` (`scripts.ts:525`). Never read the field rather than clamping it. This is the #633 hole in a new costume.
- [x] **Ignore all tenancy identifiers** in the bundle. Ownership comes from the caller's auth context only.
- [x] **Bound `parameters` at intake.** `createScriptSchema` types it `z.any()` (`scripts.ts:169`) with no shape, depth, or size limit — the 64KB cap at `scripts.ts:203-206` is *execute-time only*. Import must impose its own size and depth cap; do not inherit `z.any()`.
- [x] **Reject an all-null `exitCodeSeverityMapping`.** A schema-valid mapping sending every exit code to `null` ships a SYSTEM-level script pre-configured never to raise an alert, neutering the abuse detection this design leans on as its backstop. Reject, or strip the mapping and let the importer re-add it deliberately.
- [x] **No automations, schedules, or triggers in a v1 bundle.** A bundle that could carry an automation binding would make import arbitrary *scheduled* remote code execution across a fleet in one click.
- [x] **Import never executes anything.** No "run on import" convenience, ever.
- [x] **Audit every imported script individually**, tagged with the bundle's identity, so a later abuse finding traces back to the import that introduced it.
- [x] Enforce max scripts per bundle and max bytes per `content`, server-side.
- [x] Confirm imported rows are ordinary `scripts` rows so the existing `abuseSignals/sweep` picks them up automatically — that is detection after the fact, which is why the audit trail above matters.

## Task 5: `availability` — BLOCKED ON #3262

- [x] **Default `availability` to `'org'`.** Do not default to `'partner'`.
- [x] Gate `availability: 'partner'` on `canManagePartnerWidePolicies(auth)` at the import route, returning `PARTNER_WIDE_WRITE_DENIED_MESSAGE`.
- [x] Land this task only after #3262 merges; verify the underlying `POST /scripts` path is gated before exposing the option here.

## Task 6: Web UI

- [x] `ScriptBundleImport.tsx` on the script library page: export multi-select → download `.json`.
- [x] Import accepts either a `.json` bundle **or a folder of loose `.ps1` / `.sh` / `.py` / `.bat` files**, which the browser converts into a bundle — inferring `language` and `osTypes` from the extension and `name` from the filename — before anything is sent. Same split as the CSV handling in #3242: the client does format work, the server takes one JSON contract.
- [x] Preview table with per-entry status and a mode selector; commit through `runAction` so partial results surface ("34 imported, 2 renamed, 1 failed").
- [x] State plainly on the import screen that scripts run as SYSTEM and a bundle should only be imported from a trusted source.

## Task 7: Tests

- [x] **`isSystem` is ignored from a bundle — including when the caller is system scope.** Assert the stored row is `isSystem: false`. This is the priority regression test.
- [x] Tenancy fields in a bundle pointing at another tenant are ignored; the script lands in the caller's scope.
- [x] Unknown `bundleVersion` rejected, not best-effort parsed.
- [x] Each `mode`: `skip` leaves the original untouched; `rename` suffixes; `new-version` appends to `scriptVersions` rather than replacing history.
- [x] Oversized / deeply-nested `parameters` rejected **at intake**, not at execute time.
- [x] All-null `exitCodeSeverityMapping` rejected or stripped.
- [x] `availability: 'partner'` denied for a caller failing `canManagePartnerWidePolicies`; default is `'org'`.
- [x] Category/tag resolution by name: existing reused, missing created, hierarchy intact.
- [x] Round-trip: export → import into an empty tenant → exported bundle is equivalent.
- [x] Validation parity: an entry that would fail `POST /scripts` fails import too.
- [x] No new tables — assert the contract suites are unchanged.

## Task 8: Docs

- [x] Replace Recipe 6 in `apps/docs/src/content/docs/migration/toolkit.mdx` with the bundle flow; note the loose-file folder path in the UI.
- [x] Revisit Recipe 6's `availability: "partner"` recommendation in light of #3262 (also tracked in that plan's Task 6).
- [x] Remove the script-import row from the "Known Rough Edges" table.
- [x] Document the bundle format in `apps/docs/src/content/docs/features/scripts.mdx`, including that it is unsigned and trust comes from the importer.

---

## Verification

- [x] `pnpm --filter @breeze/api test -- scriptBundle` and `pnpm --filter @breeze/web test` green.
- [ ] End-to-end: export a library, import into a fresh tenant, confirm parameters/categories/tags/severity mappings survive and no script arrives as `isSystem`.

## Out of scope

- Signed bundles / trusted publishers, a marketplace, bundling automations or monitors, full `scriptVersions` history export, server-side zip intake. All deferred in the spec.
