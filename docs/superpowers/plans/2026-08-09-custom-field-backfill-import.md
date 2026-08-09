# Custom-Field / UDF Backfill Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a migrating MSP bring years of hand-entered UDF data (Datto `udf1`–`udf30`, Automate EDFs, Kaseya/Ninja/N-central/Atera custom fields) into Breeze, joined to enrolled devices, with preview→commit and per-row match status.

**Architecture:** Harden the destination first (uniqueness, XOR, partner-wide gate, type validation), then a two-pass importer — field definitions, then values — mirroring the `orgImport` preview→commit pipeline.

**Tech Stack:** PostgreSQL + hand-written SQL migrations, Drizzle ORM, Hono routes, Zod, React (web), Vitest.

**Spec:** `docs/superpowers/specs/onboarding-signup/2026-08-09-custom-field-backfill-import-design.md`
**Issue:** #3257 · **Epic:** #3249

---

## Decision — settled 2026-08-09

**Spec §0 is resolved: Option B.** Promote values to `device_custom_field_values` with a `definition_id` FK, behind a trigger-maintained `devices.custom_fields` projection so 34 of 37 consumers do not change.

Why it mattered: values live in a flat jsonb keyed by a bare string while the definition namespace is dual-axis, so the shipped partner-export query (`routes/partnerApi/configuration.ts:427-440`) emits **two contradictory export records for one datum** when an org-owned and a partner-wide definition share a `field_key` — and a per-org definitions import is exactly what manufactures that collision at scale.

**Sequencing: Task 4 is a prerequisite PR (phase 3a), landing before the importer (phase 3b).** Tasks 1–3 are shared hardening and come first.

---

## Critical implementation notes — read before starting

1. **Migrations must be dated `2026-08-19` or later.** The tree ships migrations through `2026-08-18`; today's date does **not** sort last, contrary to the handoff note. `check-migration-naming.sh` will not catch this case.
2. **A bulk value write takes a per-org EXCLUSIVE advisory lock held until COMMIT** (`2026-07-18-partner-export-org-locks.sql:339` → `pg_advisory_xact_lock(1000201, hashtext(org_id))`), because the devices statement trigger's change tuple includes `custom_fields`. One transaction per org-chunk, never one for the whole import.
3. **RLS is not the backstop here.** Resolving devices across orgs requires system DB context, and `breeze_has_org_access` short-circuits to `TRUE` for system scope (`0001-baseline.sql:1663-1671`). Every isolation guarantee is app-layer and must be proven by a forge test.
4. **Value validation is a security control, not hardening.** Values are substituted into installer command lines (`installerVariables.ts` → `softwareDeployment.ts` → `sendCommandToAgent`) and select deployment/automation targets via `filterEngine` → `deploymentTargetResolver.ts`.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-08-19-custom-field-definition-constraints.sql` | Unique indexes, XOR check, duplicate report |
| `apps/api/migrations/2026-08-20-device-custom-field-values.sql` | Values table, projection trigger, backfill — the phase-3a prerequisite |
| `apps/api/src/services/customFields/validateValue.ts` | `validateCustomFieldValue(definition, value)` — shared |
| `apps/api/src/services/customFields/hardwareIdentity.ts` | Junk-serial denylist ported from the Go agent |
| `apps/api/src/services/deviceCustomFieldImport/index.ts` | Preview / commit for values |
| `apps/api/src/services/deviceCustomFieldImport/resolve.ts` | deviceId → serial → hostname resolution |
| `apps/api/src/services/customFieldDefinitionImport.ts` | Preview / commit for definitions |
| `apps/web/src/components/devices/BulkCustomFieldImport.tsx` | Definitions + values, mapping, preview, chunked commit |
| `apps/api/src/__tests__/integration/customFieldDefinitionsPartnerRls.integration.test.ts` | Partner-wide RLS suite |

### Modified files
| File | Change |
|---|---|
| `apps/api/src/routes/customFields.ts` | `canManagePartnerWidePolicies` gate; definitions import routes |
| `apps/api/src/routes/devices/customFieldValues.ts` | Apply shared value validation |
| `apps/api/src/routes/devices/core.ts` | Same, on the `PATCH /devices/:id` path |
| `apps/web/src/components/settings/CustomFieldsPage.tsx` | `ownerScope` selector + "All orgs" badge |
| `apps/api/src/services/filterEngine.ts` | Rewrite the `custom.<key>` query onto the values table (Task 4) |
| `apps/api/src/routes/partnerApi/configuration.ts` | Rewrite two jsonb queries onto the values table (Task 4) |

---

## Task 1: Definition constraints migration

- [ ] Write `apps/api/migrations/2026-08-19-custom-field-definition-constraints.sql`, idempotent, no inner `BEGIN`/`COMMIT`.
- [ ] Add the XOR constraint, copying `2026-07-01-alert-rules-partner-ownership.sql:38-48` — guarded `DO $$ … pg_constraint` check then `CHECK ((org_id IS NULL) <> (partner_id IS NULL))`. Report any offending row count first; existing data should conform, since the POST route already rejects both malformed shapes.
- [ ] **Detect duplicate `field_key`s and fail loudly rather than resolving them.** Report the count and the affected `(owner, field_key)` pairs via `RAISE WARNING` per CLAUDE.md's row-count rule; create the unique indexes only when the count is zero.
  - Deleting a duplicate silently retypes every stored value (the survivor dictates `type`, and values carry none).
  - Renaming one orphans every stored value instantly and breaks `remoteAccessLauncher.ts:73` (`provider.customFieldKey` in partner settings) and `installerVariables.ts:30,51-53` (`{{device.customField.<key>}}` on software packages).
  - Cleanup is an operator decision made with knowledge of which duplicate carries values.
- [ ] Add the two partial unique indexes (`(org_id, field_key) WHERE org_id IS NOT NULL`, `(partner_id, field_key) WHERE partner_id IS NOT NULL`).
- [ ] Note in the migration that these do **not** cover cross-axis collision — that is spec §0.
- [ ] `pnpm db:migrate && pnpm db:check-drift` — no drift. Existing registrations are unchanged (no new table, no new column), so no cascade/export-policy edit is needed for this task.

## Task 2: Partner-wide gate + UI — must ship together

- [ ] Add `canManagePartnerWidePolicies(auth)` to the partner-wide branches of POST/PATCH/DELETE in `routes/customFields.ts`. Reference implementation: `routes/peripheralControl.ts:508`.
- [ ] **This is a behavioural regression if shipped alone.** The web create modal never sends ownership, so partner-scoped users fall through to `partnerId = auth.partnerId` — in practice essentially every existing custom field is partner-wide, and the gate requires `partnerOrgAccess === 'all'` (`services/partnerWideAccess.ts:25-29`). Ordinary techs with `orgAccess='selected'` would start getting 403s through the plain UI.
- [ ] Therefore, same PR: create-only `ownerScope` selector + "All orgs" badge in `CustomFieldsPage.tsx`, pattern `components/software/PolicyForm.tsx`; hide the partner-wide option for users lacking the capability.
- [ ] Add `customFieldDefinitionsPartnerRls.integration.test.ts`: cross-partner forge → 42501, XOR → 23514, org isolation.
- [ ] Test: a tech with `orgAccess='selected'` cannot create a partner-wide definition and does not see the option.

## Task 3: Value validation — apply to existing paths, not just the importer

- [ ] `services/customFields/validateValue.ts` — `validateCustomFieldValue(definition, value)` enforcing the declared `type`, `options.choices` for `dropdown`, `required`, and that the `fieldKey` resolves to a visible definition.
- [ ] Apply it in `routes/devices/customFieldValues.ts` **and** on the `PATCH /devices/:id` path (`routes/devices/core.ts:1238-1246`). Validating only the importer leaves the trivially scriptable API-key path beside it unvalidated.
- [ ] Commit to snake_case keys explicitly; warn on any mapping to the reserved `asset_tag` / `inventory_id` / `external_id`, which feed `stableIdentifiers` in `routes/partnerApi/devices.ts:123-125`.
- [ ] Tests: a `number` field rejects `"abc"`; a `dropdown` rejects a value outside `options.choices`; an unknown key is rejected; both existing write paths enforce it.

## Task 4: Values table + projection — PREREQUISITE PR (phase 3a)

- [ ] `apps/api/migrations/2026-08-20-device-custom-field-values.sql`: `device_custom_field_values(id, device_id, org_id, definition_id, value_text, value_number, value_bool, value_date, source, created_at, updated_at)`, `UNIQUE (device_id, definition_id)`, FK to definitions with `ON DELETE CASCADE` (fixes the current orphaned-value bug).
- [ ] Backfill from every existing `devices.custom_fields` blob, resolving each key to a definition; report counts, and report keys that resolve to no definition rather than dropping them silently.
- [ ] Projection trigger keeping `devices.custom_fields` in sync so the 17 JS readers, both partner-export triggers, and the MCP projection keep working unchanged.
- [ ] Rewrite the only three SQL consumers: `filterEngine.ts:181-182`, `partnerApi/configuration.ts:433`, `:440`.
- [ ] **Contract registration, same PR:** RLS (shape 5 — `device_id` with denormalized `org_id`), `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES` **and** `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`), `CORE_TENANT_EXPORT_POLICY` with typed columns `included` — which closes the tenant-export gap.
- [ ] Test: a value write updates both the table and the projection, and still bumps `partner_export_updated_at`.

## Task 5: Device resolution

- [ ] `services/deviceCustomFieldImport/resolve.ts` — resolution order `deviceId` → `serialNumber` (via `device_hardware`) → `hostname` (case-insensitive), **always within one organization**. 0 matches = `not-found`; >1 = `ambiguous`; never guess.
- [ ] Port the junk-serial denylist from `agent/internal/collectors/hardware.go:156-190` (`cleanHardwareIdentityValue`) into a shared TS constant — do **not** author a second, divergent list.
- [ ] **Apply it to the DB side of the join as well as the CSV side.** The agent's filter runs only on Windows (`hardware_windows.go:136`); Linux (`hardware_linux.go:35`) and macOS (`hardware_darwin.go:46`) write raw values, so junk serials are already stored.
- [ ] For hostname collisions, surface ranked candidates using enrollment's existing priority chain (token-authenticated > online > non-decommissioned > oldest, `routes/agents/enrollment.ts:514-518`) and require an explicit pick. The rule stays "never auto-pick"; the UI stops being a dead end.
- [ ] Tests: explicit id wins; serial beats hostname; junk serials excluded on **both** sides; cross-org hostname collision never resolves outside the caller's orgs.

## Task 6: Import services

- [ ] `customFieldDefinitionImport.ts` — preview annotations `create | already-exists | type-conflict` (`type` is immutable on update, so a differing type is a conflict, never a silent cast); partner-wide creation gated per Task 2.
- [ ] `deviceCustomFieldImport/index.ts` — preview/commit with annotations `matched | ambiguous | not-found | no-definition | type-error | reserved-key | already-set`. Only `matched` commits; `ambiguous` commits only with an acknowledged `deviceId`.
- [ ] Commit **re-derives** every annotation against fresh state and rejects rows whose annotation changed since preview, with identity pinning — mirror `checkExpectation` (`orgImport/index.ts:407-448`).
- [ ] **Mapping targets** per spec §3: `{kind:'customField', fieldKey}` and `{kind:'warranty', field}`. Warranty writes `device_warranty` with `data_source:'import'` and does not clobber a `data_source:'provider'` row without an explicit opt-in.
- [ ] Stateless — client-held acknowledgement, audits only, exactly like `orgImport` (`services/orgImport/audit.ts`). If a persisted job record is added later it carries `org_id` and must land in the cascade **and** export-policy lists in the same PR.

## Task 7: Routes

- [ ] `POST /custom-fields/import{,/preview}` (definitions) and `POST /devices/custom-fields/import{,/preview}` (values).
- [ ] Both value routes: `requireScope('partner','system')` + `requireOrgWrite` + `requireMfa()`. **Reject `X-API-Key`** — the existing `dualAuth` applies MFA only on the JWT branch and deliberately skips the site allowlist for API keys.
- [ ] Per-row re-authorization against the caller's accessible orgs, plus `canAccessSite(perms, device.siteId)` (a plain boolean — fail closed on false) — `allowedSiteIds` is populated only on the org axis (`services/permissions.ts:171`).
- [ ] Do **not** reuse `getDeviceWithOrgCheck` (`routes/devices/helpers.ts:83-113`) — it selects with no org predicate and checks in JS, which is the only check under a system context.
- [ ] Row cap **1000** (`MAX_IMPORT_ROWS`), and commit **one transaction per org-chunk** — never one transaction for the whole import (see critical note 2).
- [ ] `writeRouteAudit` per definition created and per device backfilled.

## Task 8: Web UI

- [ ] `BulkCustomFieldImport.tsx` modelled on `BulkOrgImport.tsx`: definitions step (upload the incumbent's field list, choose ownership, preview) then values step (CSV → `lib/csvParse.ts` → per-column mapping target + join-key column → preview → chunked commit with progress).
- [ ] `ambiguous` rows expand to ranked candidates and require an explicit pick; select-all spans only `matched`.
- [ ] Results through `runAction` including partial success across chunks.

## Task 9: Tests

- [ ] Isolation: a cross-partner forge under **system DB context** is rejected by the app layer — the test must not rely on RLS.
- [ ] Site gating: a site-restricted org user cannot backfill a device outside their sites.
- [ ] Auth: `X-API-Key` rejected on both import routes; MFA required.
- [ ] Idempotency: re-running an identical import changes nothing and reports every row `already-set`.
- [ ] Batching: an import spanning three orgs commits three transactions, none spanning more than one org's advisory lock.
- [ ] Warranty target: an imported `warranty_end_date` makes `warrantyAlertEvaluator` fire and appears in `routes/partnerApi/inventory.ts`.
- [ ] Prerequisites: the duplicate migration fails loudly with a count when duplicates exist and is a no-op otherwise; XOR rejects both malformed shapes.

## Task 10: Docs + follow-up issues

- [ ] Update `migration/overview.mdx` Phase 5 and each per-vendor guide with the backfill flow and the source field surfaces.
- [ ] File the deferred items rather than losing them: dynamic-group recompute after import (the device-change pipeline is unwired — `initializeDeviceEventHandlers` has no caller, and `'custom'` never overlaps `'custom.<key>'`); incumbent identity at enrollment for late-enrolling devices; org/site-level custom fields.
- [ ] One line each in the spec's §9 surfaces confirmed at review time: MCP exposure (`mcpServer.ts:1875`) and partner-export secret-scanning at volume (`exportSafety.classification.ts:46`).

---

## Verification

- [ ] `apps/api` and `apps/web` unit suites green (package-local `vitest`; `pnpm` is unusable on this machine).
- [ ] Contract suites green against a live DB — required under Option B, and for the partner-RLS suite either way.
- [ ] Dispatch CI on the branch: `gh workflow run CI --ref <branch>`.
- [ ] End-to-end: import a 30-field definition list plus a multi-org value CSV, confirm matched rows land, ambiguous rows are refused until acknowledged, and a re-run is a full no-op.

## Out of scope

- Org/site-level custom fields (#3257 spec §8), per-key expression indexes (moot under Option B), additional first-class mapping targets.
- Contacts (#3258).
