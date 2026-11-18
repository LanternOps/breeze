---
issue: LanternOps/breeze#9246
status: approved by the owner 2026-11-08; registered as feature #11412
tracking_issue: 11412
---
# Partner-wide installer upload for built-in packages (#9246) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-partner admin can upload an installer file (chunked or legacy multipart) to a partner-wide software package, including the built-in SentinelOne package, and a version created with blank install arguments on a built-in integration package gets the package's own argument template (`SITE_TOKEN={s1_site_token} /q /NORESTART` for SentinelOne) instead of the generic `msiexec` line the dispatch resolver refuses.

**Architecture:** `software_upload_sessions` moves from org-only (shape 1) to org XOR partner ownership, mirroring the catalog row it uploads into. The upload routes take the session's owner from the catalog row, never from `?orgId`, and gate partner-owned rows with the existing `authorizeCatalogItemWrite` (which calls `canManagePartnerWidePolicies`). A partner-owned version stores ONE object at `software/partner/<partnerId>/<catalogId>/<versionId>/<fileName>`, which every child org's deployment presigns. Blank-argument defaulting moves into one helper used by all three version-create paths.

**Tech Stack:** Hono, Drizzle (queries only) + one hand-written SQL migration, PostgreSQL RLS, S3/MinIO, Vitest, Astro + React islands.

**Spec:** none. The issue body is the requirement: `gh issue view 9246 -R LanternOps/breeze` (found in security-agents W04, PR #9244; context #8734). Written against `origin/main` at `f84e7d1dc1` (2026-11-08).

PR bodies say `Refs #9246`; only the last wave's PR carries `Closes #9246`. Never write a closing keyword for #8734 or #6960.

## Global Constraints

- Org-owned upload behaviour is unchanged: same object key `software/${orgId}/${catalogId}/${versionId}/${fileName}`, same caps, same error strings, same `?orgId` resolution. Existing org-path tests stay green without edits, except the one noted in Task 1.5.
- Partner-owned writes go through `authorizeCatalogItemWrite` (`services/softwareCatalogOps.ts:111`). Its 403 text stays `Modifying a partner-wide package requires full partner org access (orgAccess must be "all")`.
- Partner-owned object key: `software/partner/${partnerId}/${catalogId}/${versionId}/${fileName}` (the prefix `softwareCatalogPartnerDeleteRls.integration.test.ts:51` already uses).
- Upload limits unchanged: `MAX_UPLOAD_SIZE` 500 MB; chunks 256 KB–8 MB; caps 5 active sessions and 2.5 GB declared size per owner, 2 sessions per user per owner.
- Built-in keyed packages (`builtin_package_key` set, the DNS clients) stay immutable outside system scope (`isImmutableBuiltin`); this plan does not open them.
- Migration: hand-written, idempotent, no inner `BEGIN`/`COMMIT`, writes no rows. Name `2027-01-23-100000-software-upload-sessions-partner-owner.sql` (newest committed at plan time is `2027-01-22-210100-builtin-alert-rule-management-posture.sql`); recheck the slot at preflight and again before merge.
- New or changed `en` locale keys land in all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`.
- Typecheck with a 12 GB heap and read the exit code; never pipe `tsc` to `tail`.

## Review Focus

1. **A partner admin with one child org selected in the org switcher.** `fetchWithAuth` injects `?orgId=<child>` on every chunk request. The upload must still land on the partner-owned session and object. Pinned in Task 1.5 (unit) and Task 1.7 (real Postgres).
2. **A partner user with `orgAccess: 'selected'`.** Must get 403 at session create and cannot push chunks to, complete or abort a full admin's partner session. Pinned in Task 1.5.
3. **An org-scope token from a child org that knows a partner session id.** Must get 404 on every session route; RLS hides the row. Pinned in Tasks 1.1 and 1.7.
4. **A child org is erased while a partner upload is in flight.** The org cascade must leave the partner session alone. Partner erasure must remove it. Pinned in Task 1.1.
5. **An `.exe` uploaded to the SentinelOne package, or blank args on an MSI.** Blank MSI args get the template. An `.exe` gets no template (its type is not the package's), and the existing readiness check still reports it not deployable. Pinned in Task 1.3.

## What already exists (verified at `f84e7d1dc1`)

| Item | Where | State |
|---|---|---|
| S1 built-in row is partner-wide | `services/builtinDeploymentPackages.ts:154-176` | `orgId: null, partnerId, integrationProvider: 'sentinelone'`, `builtinPackageKey` NULL. So `isImmutableBuiltin` does not block it. |
| Chunked create refuses partner rows | `routes/softwareUploads.ts:271-276` | 400 `File upload is not yet available for partner-wide packages — provide a download URL instead.` |
| Chunk/status/complete/delete resolve owner from `?orgId` | `routes/softwareUploads.ts:404-406, 580-581, 620-622, 873-874` | `resolveScopedOrgId`, then filter `eq(sessions.orgId, orgId)`. |
| Legacy multipart filters on org | `routes/software.ts:661-663` | `eq(softwareCatalog.orgId, orgId)`, so partner rows 404. |
| JSON (URL) version create already handles partner rows | `routes/software.ts:594-640` via `prepareSoftwareVersionCreate` (`softwareCatalogOps.ts:331`) | Uses `authorizeCatalogItemWrite`. Blank args → generic `msiexec /i "{file}" /qn /norestart` (`packages/shared/src/utils/softwareFileType.ts:110`). |
| Dispatch refuses S1 args without the placeholder | `services/edrInstallerResolver.ts:230-232` | `SentinelOne install arguments must include SITE_TOKEN={s1_site_token} — edit the installer version`. |
| Dispatch presigns any `s3Key` | `services/softwareDeployment.ts:703-760` | Key layout is never parsed. Nothing else in `apps/api/src` parses a `software/` key (grep at plan time). |
| Erasure deletes objects by key list, not prefix | `services/tenantCascade.ts:150-235`, `softwareCatalogOps.ts:226-228` | Partner branch already exists (`partner_id = …`). |
| Session table is org-only | `migrations/2026-08-11-software-upload-sessions.sql` | `org_id NOT NULL`, four `breeze_has_org_access(org_id)` policies. |
| Session registries | `tenantCascade.ts:997`, `orgMergeRegistry.ts:1301`, `tenantExportPolicyRegistry.ts:935` | Cascade, `repoint`, export policy present. |
| Partner cascade discovers `partner_id` tables itself | `tenantCascade.ts:3015-3030` | information_schema sweep. No static list to edit. |
| Web: AddPackageModal disables file for partner-wide | `components/software/AddPackageModal.tsx:134-170, 921-930` | Keys `partnerWideUrlOnly`, `selectedFileRemoved`. |
| Web: Versions tab knows nothing of ownership | `components/software/SoftwareVersionManager.tsx:180-195`, mounted at `SoftwareCatalog.tsx:1019` | Offers the file picker. The server then answers the 400 above. |
| Web: partner-wide capability flag | `stores/auth.ts:90` `user.canManagePartnerWide` | From `/users/me`. |

## Design decisions

**D1 — Session ownership mirrors the catalog row.** `software_upload_sessions` gets `partner_id` and a `software_upload_sessions_one_owner_chk` CHECK `((org_id IS NULL) <> (partner_id IS NULL))`. This is not a config table, so Partner-Wide First's "default to dual ownership" does not decide it. The ownership has to match the row being uploaded into, and that row can be either. I rejected the alternatives:
- Booking the session under a nominal child org leaks a partner upload into one customer's quota, export and erasure.
- Turning the table into a parent-FK join table (drop `org_id`, RLS `EXISTS` to `software_catalog`) adds a join to every chunk request's RLS check, and churns the cascade, merge and export entries for no gain.

**D2 — No composite FK pinning the session owner to the catalog owner.** Sessions live at most 24 h. The create route copies the owner from the catalog row, and `/complete` re-reads the catalog under that same owner before writing a version. A composite FK would need new `(id, org_id)` / `(id, partner_id)` unique indexes on `software_catalog`, and the org-side FK would have to be `DEFERRABLE INITIALLY IMMEDIATE` for org merge. That is two new invariants protecting a 24-hour row.

**D3 — No partner-wide SELECT branch.** Org tokens must never read partner upload sessions. The precedent is `reports` and `webhooks`: in `DUAL_AXIS_TENANT_TABLES`, deliberately absent from `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`rls-coverage.integration.test.ts:584-616, 1053-1078`).

**D4 — One object per partner-owned version (quorum: see Open Decisions OD1).** Stored at the partner-keyed path above. A per-org copy would need a `(version_id, org_id) → key` table and a copy step on every org join. It would multiply up to 500 MB by every child org, and buy no isolation: the key is never handed to a client, only a presigned URL minted after authorization.

**D5 — Blank args on a built-in integration package default to its template.** This applies when the version's file type equals the package's (`msi` for SentinelOne). Uninstall args keep the generic default. The rule lives in one helper used by the JSON create, the legacy multipart and the chunked complete paths. It also fixes add-by-URL, which today gets the generic line.

**D6 — Owner auth on session routes reads the session first.** Session routes look the session up by `(id, catalog_id)` under RLS, then authorize against its owner. Org sessions keep today's `resolveScopedOrgId` comparison. Partner sessions use `authorizeCatalogItemWrite`. The one observable change: a session that RLS hides now answers 404 even when `?orgId` is forbidden. It used to answer 403. 404 is the don't-reveal-existence behaviour these routes already use.

## Tenancy

| Table | Change | RLS | Registries |
|---|---|---|---|
| `software_upload_sessions` | `+ partner_id uuid REFERENCES partners(id) ON DELETE CASCADE`; `org_id DROP NOT NULL`; `_one_owner_chk`; `software_upload_sessions_partner_id_idx` | Drop the four `breeze_org_isolation_*` policies. Create `software_upload_sessions_dual_isolation_{select,insert,update,delete}` with the predicate `(org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))` in USING, WITH CHECK, or both, as in `2026-06-26-a-software-catalog-partner-axis.sql:56-77`. RLS stays enabled and forced. | **Export:** add `partner_id` to `included` (`tenantExportPolicyRegistry.ts:935`). **rls-coverage:** add to `DUAL_AXIS_TENANT_TABLES` with a D3 comment; not to `XOR_OWNERSHIP_DUAL_AXIS_TABLES`. Org-tenant auto-discovery keeps asserting the org branch. **Org cascade:** entry unchanged; it deletes `WHERE org_id = …` and never touches partner rows. **Org merge:** `repoint` unchanged; it rewrites `org_id` only. **Partner cascade:** information_schema sweep picks up `partner_id` automatically. Prove it in the test, do not assume it. **Device lists:** n/a (no `device_id`). |
| `software_catalog`, `software_versions` | none (only `s3_key` values change shape) | — | — |

`breeze_has_partner_access(partner_id)` is true for any partner-scope token of that partner, whatever its `orgAccess`. So RLS here is weaker than the app gate, and `canManagePartnerWidePolicies` (via `authorizeCatalogItemWrite`) is the load-bearing check for `orgAccess: 'selected'` users. Task 1.5 pins it.

## Open Decisions

- **OD1 — Storage keying.** Recommend a partner-keyed single object (D4). The codex quorum AGREES (see "Advisor quorum"). The only divergence was the prefix spelling, resolved in favour of the existing `software/partner/` fixture.
- **OD2 — Refuse placeholder-less args at write time?** The plan includes Task 1.4: on a built-in integration package whose template has placeholders, a create or PATCH whose args (for the package's file type) lack them answers 400 `install_args_missing_placeholders`. That surfaces at write time what dispatch already refuses. **Recommend include.** Drop Task 1.4 if the owner prefers the dispatch-time refusal plus the W02 UI hint.
- **OD3 — Who may drive a partner session?** Any full-partner admin of the owning partner, matching org sessions, where any org writer can drive any session. Not creator-only. **Recommend parity.**
- **OD4 — Caps bucket.** A partner owner gets its own bucket (5 sessions, 2.5 GB, 2 per user). It does not share a child org's bucket. **Recommend separate.**
- **OD5 — Legacy multipart route.** It gains partner support for parity, since it "remains supported for scripts/API consumers" (`softwareUploads.ts:27-28`). **Recommend include** (Task 1.6).

## Advisor quorum

I asked a read-only `codex exec` (gpt-6-astra, `model_reasoning_effort="xhigh"`, 2026-11-08): partner-keyed single object (A), per-org copy (B), or something better.

**It AGREES with D4 (A).** Its reasons match the plan's. Versions hold one key, dispatch signs it directly, and the S1 token resolves per org apart from the binary. B costs about 50 GB per 500 MB installer across 100 orgs and adds copy synchronization without reducing download traffic. Erasure already deletes by stored key. Its own prefix audit found no code that parses a key's org segment for authorization, GC or quotas, which matches my grep.

**One divergence, resolved:** it proposed `software/partners/…`. The plan keeps `software/partner/…`, the prefix the existing fixture uses (`softwareCatalogPartnerDeleteRls.integration.test.ts:51`). Nothing parses either spelling.

**Points it raised that this plan does not fix (pre-existing, out of scope; recorded for the owner):**
- **Tenant export misses partner rows.** An org export reads rows by `org_id` (`tenantExport.ts:149-160`), and `software_versions` has no export entry (`tenantExportPolicy.test.ts:652-656`). So an org's export never contains partner-wide packages or any installer bytes. This was true before #9246, and per-org copies would not fix it either. **Verified.**
- **The delivery-time refresher re-presigns `payload.s3Key` without re-checking entitlement** (`commandDelivery.ts:136-140`). A queued command keeps working after its package is archived. This is unchanged by this plan. **Verified the code path; impact not assessed.**
- **A future "move org to another partner" feature** would have to revalidate pending installs that point at the old partner's object. No such route exists today: merges stay within one partner. **Inferred from its citation; not checked.**
- **Keep per-org material out of the shared binary.** One object serves every org, so the site token must stay in the args placeholder, never in the uploaded file or its name. The W03 docs say so.

---

## Wave W01 — API: partner-owned upload sessions, partner-keyed storage, template args

Branch `fix/9246-partner-package-upload-api` (or the feature-lifecycle wave branch once registered). PR `Refs #9246`. Full rigor: migration + RLS + auth gate.

## Execution split and parallelism (W01)

- **Seam:** W02 consumes only HTTP behaviour. A partner-owned catalog id accepts the same five upload calls, with or without `?orgId`. A blank `silentInstallArgs` on the S1 package returns a version whose `silentInstallArgs` is the template. No response shape changes.
- **Order:** 1.0, then **PARALLEL GROUP A**, two file-disjoint lanes:
  - {1.1 → 1.2}: migration, RLS suite, registries;
  - {1.3 → 1.4}: `softwareCatalogOps.ts` + its test.

  Then 1.5, which needs 1.1's schema and the 1.3/1.4 helpers and creates `softwareUploadOwner.ts`. Then 1.6, which needs that file. Then 1.7 → 1.8.
- **Sonnet-eligible (contract fully specified here):** 1.2 (registry edits), 1.6. Opus: 1.1 (tests + SQL), 1.3, 1.4, 1.5, 1.7.

### Task 1.0: Preflight

- [ ] `git fetch origin && git rebase origin/main`. Confirm #9246 is still open with no PR (`gh pr list --search 9246 --state open`), and that no open PR touches `routes/softwareUploads.ts`, `routes/software.ts` or `services/softwareCatalogOps.ts` (`gh pr list --state open --json number,files`).
- [ ] `ls apps/api/migrations/*.sql | sort | tail -1`. Rename the planned migration to sort after it if needed.

### Task 1.1: RLS contract tests, then the migration + Drizzle schema

**Files:** Create `__tests__/integration/softwareUploadSessionsPartnerRls.integration.test.ts` (fixture pattern: `softwareUploadSessionsRls.integration.test.ts`; partner context `{ scope: 'partner', orgId: null, accessibleOrgIds: [childA.id], accessiblePartnerIds: [partnerA.id], userId: null }`), `apps/api/migrations/2027-01-23-100000-software-upload-sessions-partner-owner.sql`; modify `apps/api/src/db/schema/software.ts` (the `softwareUploadSessions` block, ~254-290).

**Interfaces — Produces:** `softwareUploadSessions.orgId: uuid | null`, `softwareUploadSessions.partnerId: uuid | null` (`references(() => partners.id, { onDelete: 'cascade' })`), index `software_upload_sessions_partner_id_idx`.

- [ ] **Step 1: failing tests**, in `softwareUploadSessionsPartnerRls.integration.test.ts`:
  - `partner A context reads its partner session` → 1 row.
  - `partner B context cannot read, update or delete partner A's session` → 0 rows, row survives.
  - `forged INSERT with partner_id = partnerA under partner B context` → rejects with code `42501`.
  - `child-org (org scope) context cannot see partner A's session` → 0 rows (D3).
  - `a row with both org_id and partner_id set` and `a row with neither` → each rejects with `23514`, constraint `software_upload_sessions_one_owner_chk`.
  - `cascadeDeleteOrg(childA) leaves partner A's session` → partner session survives, child's org session gone.
  - `the partner sweep discovers the table` → the information_schema query `tenantCascade.ts` runs for `partner_id` columns (~3015-3030) returns `software_upload_sessions`.
- [ ] **Step 2:** `pnpm test-stack up`, `pnpm db:migrate`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/softwareUploadSessionsPartnerRls.integration.test.ts`. Expected: FAIL (no `partner_id` column).
- [ ] **Step 3:** Write the migration per the Tenancy table:
  - guard the CHECK with a `pg_constraint` lookup;
  - use `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`;
  - put `DROP POLICY IF EXISTS` before each `CREATE POLICY`, for both the old `breeze_org_isolation_*` names and the new names;
  - keep `GRANT SELECT, INSERT, UPDATE, DELETE … TO breeze_app`;
  - header comment: tenancy is now dual-axis org XOR partner, with no partner-wide SELECT branch (D3).

  Update the Drizzle block and its comment (the "Tenancy shape 1" line becomes dual-axis).
- [ ] **Step 4:** `pnpm db:migrate` twice (idempotency), then `pnpm db:check-drift`. Expected: clean. Rerun the new suite and the existing `softwareUploadSessionsRls.integration.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(software): upload sessions can be partner-owned (#9246)`.

### Task 1.2: Registries

**Files:** Modify `services/tenantExportPolicyRegistry.ts:935` and `__tests__/integration/rls-coverage.integration.test.ts` (`DUAL_AXIS_TENANT_TABLES`).

- [ ] **Step 1:** With 1.1 applied, run `tenant-export-policy.integration.test.ts`. Expected: FAIL, `software_upload_sessions.partner_id` unclassified.
- [ ] **Step 2:** Add `partner_id` to the export `included` list. Add the `DUAL_AXIS_TENANT_TABLES` entry, with a comment citing D3 and the `reports`/`webhooks` precedent and saying "deliberately NOT in XOR_OWNERSHIP_DUAL_AXIS_TABLES".
- [ ] **Step 3:** Run `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `tenantCascade.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, and `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Expected: all PASS.
- [ ] **Step 4:** Commit `test(software): partner upload session export and RLS-coverage registration (#9246)`.

### Task 1.3: Template-aware default install args

**Files:** Modify `services/softwareCatalogOps.ts` (helper + `prepareSoftwareVersionCreate` ~375-377); test `services/softwareCatalogOps.installArgs.test.ts` (new).

**Interfaces — Produces:**
`defaultSilentArgsForCatalogItem(item: { integrationProvider: string | null }, fileType: string | null | undefined): { install: string | null; uninstall: string | null } | null`. When `isBuiltinProvider(item.integrationProvider)` holds and `fileType` (case-insensitive) equals `getBuiltinPackage(provider).fileType`, it returns `{ install: <silentInstallArgsTemplate>, uninstall: defaultSilentArgsForFileType(fileType)?.uninstall ?? null }`. Otherwise it returns `defaultSilentArgsForFileType(fileType)`.

- [ ] **Step 1: failing tests:**
  - `sentinelone + msi → install 'SITE_TOKEN={s1_site_token} /q /NORESTART', uninstall 'msiexec /x "{file}" /qn /norestart'`
  - `sentinelone + exe → null`
  - `sentinelone + MSI (upper case) → template`
  - `huntress + exe → '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S'`
  - `null provider + msi → generic msiexec pair`
  - `unknown provider string + msi → generic pair`
  - `prepareSoftwareVersionCreate on an S1 row with blank silentInstallArgs and fileType msi → values.silentInstallArgs is the template`
  - `same with non-blank args → args kept verbatim`
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/softwareCatalogOps.installArgs.test.ts`. Expected: FAIL (helper not exported).
- [ ] **Step 3:** Implement the helper. Replace `defaultSilentArgsForFileType(fileType)` in `prepareSoftwareVersionCreate` with `defaultSilentArgsForCatalogItem(catalogItem, fileType)`.
- [ ] **Step 4:** Run the new test plus `src/routes/software.test.ts` and `src/services/aiToolsSoftware.handlers.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(software): blank args on a built-in integration package default to its template (#9246)`.

### Task 1.4: Placeholder refusal at write (OD2 — drop if the owner declines)

**Files:** Modify `services/softwareCatalogOps.ts` (`prepareSoftwareVersionCreate`, `prepareSoftwareVersionUpdate`); test in the 1.3 test file.

**Interfaces — Produces:** `integrationInstallArgsError(item: { integrationProvider: string | null }, fileType: string | null | undefined, silentInstallArgs: string | null | undefined): { error: string; issues: ['install_args_missing_placeholders'] } | null`. It is non-null only when all four hold:
- the provider is built-in;
- `installArgPlaceholders(provider).length > 0`;
- `fileType` equals the package's file type;
- `!installArgsCarryPlaceholders(provider, silentInstallArgs)`.

The error string is `Install arguments for ${pkg.name} must include ${placeholders.join(' and ')}`.

- [ ] **Step 1: failing tests:**
  - `S1 msi with 'msiexec /i "{file}" /qn' → 400 body with issues ['install_args_missing_placeholders']`
  - `S1 msi with 'SITE_TOKEN={{s1_site_token}}' (tenant-variable braces) → refused`
  - `S1 msi with template → null`
  - `S1 exe with anything → null`
  - `PATCH on an S1 msi version setting silentInstallArgs: null → refused`
  - `PATCH changing only releaseNotes → not checked`
  - `org-owned custom package → never refused`
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Call it after the defaulting in `prepareSoftwareVersionCreate`, returning `{ ok: false, status: 400, body }`. In `prepareSoftwareVersionUpdate`, call it only when `payload.silentInstallArgs !== undefined`, judging against the stored `fileType`.
- [ ] **Step 4:** Run the 1.3 file and `src/routes/software.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(software): refuse built-in package args that drop the per-org placeholder (#9246)`.

### Task 1.5: Chunked upload routes accept partner-owned packages

**Files:** Create `services/softwareUploadOwner.ts` (+ `softwareUploadOwner.test.ts`); modify `routes/softwareUploads.ts`, `routes/softwareUploads.test.ts` (schema mock gains `partnerId: 'sus_partner_id'`).

**Interfaces — Produces** (`softwareUploadOwner.ts`):
- `type UploadOwner = { kind: 'organization'; orgId: string } | { kind: 'partner'; partnerId: string }`
- `uploadOwnerOf(row: { orgId: string | null; partnerId: string | null }): UploadOwner`. Throws when neither or both are set; the CHECK makes that unreachable.
- `uploadOwnerColumns(owner: UploadOwner): { orgId: string | null; partnerId: string | null }`
- `uploadOwnerSessionCondition(owner: UploadOwner): SQL`. For an org owner, `eq(sessions.orgId, id)`. For a partner owner, `and(isNull(sessions.orgId), eq(sessions.partnerId, id))`.
- `softwarePackageObjectKey(owner: UploadOwner, catalogId: string, versionId: string, fileName: string): string`. Org: `software/${orgId}/${catalogId}/${versionId}/${fileName}`. Partner: `software/partner/${partnerId}/${catalogId}/${versionId}/${fileName}`.
- `authorizeUploadSessionAccess(auth: AuthContext, session: { orgId: string | null; partnerId: string | null }, requestedOrgId: string | undefined): { error: string; status: 400 | 403 | 404 } | null`. Org session: `resolveScopedOrgId`; its error is returned as is, and a mismatch returns 404 `Upload session not found`. Partner session: `authorizeCatalogItemWrite(auth, { orgId: null, partnerId }, undefined)`; its 404 is rewritten to `Upload session not found`, its 403 passes through.

**Route changes (D6):**
- **Create:** remove the 400 at 271-276. For a partner row: authorize with `authorizeCatalogItemWrite(auth, catalogItem, ?orgId)` and skip the `contextOrg` comparison; an org row keeps today's code. Caps filter on `uploadOwnerSessionCondition(owner)`. A partner owner gets the error strings `Too many concurrent package uploads for this partner` and `Concurrent package uploads exceed the partner upload size budget`; org strings are unchanged. Insert `uploadOwnerColumns(owner)`.
- **Chunk / status / complete / delete:** select the session by `(id, catalogId)` only, 404 if absent, then `authorizeUploadSessionAccess`. Keep every later `where` on `id` (+ `catalogId`).
- **Complete:** re-read the catalog with `eq(id)`, `isNull(deletedAt)` and the owner condition (`eq(orgId)`, or `isNull(orgId) AND eq(partnerId)`). Key via `softwarePackageObjectKey`. Defaults via `defaultSilentArgsForCatalogItem` (and `integrationInstallArgsError` if 1.4 ships, both at create and at complete). The audit `orgId` becomes `catalogItem.orgId` (null for partner), matching `software.ts:630`.

- [ ] **Step 1: failing tests:**
  - **`softwareUploadOwner.test.ts`:** each helper; key strings exact; the auth matrix:
    - system → null;
    - partner `orgAccess:'all'`, same partner → null;
    - partner `'selected'` → 403;
    - other partner → 404 `Upload session not found`;
    - org scope against a partner session → 404;
    - org session with `?orgId` mismatch → 404.
  - **`softwareUploads.test.ts`:** replace `400s with a URL-only hint for a partner-wide catalog item` (~498) with `201 creates a partner-owned session for a full-partner admin`, which asserts the inserted values carry `orgId: null, partnerId: 'partner-123'`. Add:
    - `403 for a partner admin with orgAccess 'selected'`;
    - `create ignores ?orgId=<child> for a partner-owned package` (Review Focus 1);
    - `chunk on a partner session with ?orgId=<child> → 200`;
    - `complete on a partner session uploads to software/partner/partner-123/<catalogId>/<versionId>/installer.msi and stores the S1 template when args are blank` (catalog row `integrationProvider: 'sentinelone'`);
    - `partner caps use the partner bucket and partner error strings`;
    - `org-scope caller gets 404 on status/complete/delete of a partner session`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/softwareUploadOwner.test.ts src/routes/softwareUploads.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers and route changes. Update the module docblock (no "partner-wide is URL-only").
- [ ] **Step 4:** Rerun both files plus `src/jobs/softwareUploadSessionCleanup.test.ts`. Expected: PASS. Every pre-existing org-path test passes unedited. If one pins the old 403-before-lookup order, update it with the D6 rationale in the commit body.
- [ ] **Step 5:** Commit `feat(software): chunked uploads to partner-wide packages (#9246)`.

### Task 1.6: Legacy multipart route

**Files:** Modify `routes/software.ts:645-900` (`POST /catalog/:id/versions/upload`), `routes/software.test.ts` (`describe('POST /software/catalog/:id/versions/upload')` ~1114).

- [ ] **Step 1: failing tests:**
  - `partner admin uploads to a partner-wide package without ?orgId → 201, s3Key software/partner/<partnerId>/…`
  - `partner 'selected' → 403`
  - `org-scope token → 404 on a partner package`
  - `blank args on the S1 package → template`
  - `org-owned upload unchanged (key software/<orgId>/…)`
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/routes/software.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3:** Fetch the catalog by `id` + `activeCatalog`, then call `authorizeCatalogItemWrite(auth, catalogItem, ?orgId)` and keep `isImmutableBuiltin`. Resolve the org from `?orgId` only for an org-owned row. Use `softwarePackageObjectKey(uploadOwnerOf(catalogItem), …)` and `defaultSilentArgsForCatalogItem`. Audit `orgId: catalogItem.orgId`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5:** Commit `feat(software): legacy multipart upload accepts partner-wide packages (#9246)`.

### Task 1.7: Real-router proof on real Postgres

**Files:** Create `__tests__/integration/softwareUploadPartnerWide.integration.test.ts`. Pattern: `softwareCatalogPartnerDeleteRls.integration.test.ts`, for `setupTestEnvironment({ scope: 'partner' })`, `createAccessToken`, and a `vi.mock` of `services/s3Storage` so `uploadBinary`/`isS3Configured` need no MinIO.

- [ ] **Step 1: failing tests** (run as `breeze_app`):
  - `partner admin: create (with ?orgId=<child>) → chunk → complete → 201`. The version row has `s3_key LIKE 'software/partner/<partnerId>/%'`, `silent_install_args = 'SITE_TOKEN={s1_site_token} /q /NORESTART'`, and the session row is gone.
  - `child-org token: GET status of that session → 404`.
  - `partner 'selected' token: create → 403, no session row written`.
- [ ] **Step 2:** Run with `--config vitest.integration.config.ts`. Expected: FAIL before 1.5 lands, PASS after.
- [ ] **Step 3:** Commit `test(software): partner-wide upload end to end under RLS (#9246)`.

### Task 1.8: W01 verification + PR

- [ ] API typecheck the way CI runs it: `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo EXIT=$?`. Expected: `EXIT=0`.
- [ ] Unit files from Tasks 1.3–1.6, in batches, plus the **full** unit suite once (`orgMerge.test.ts` reds only there).
- [ ] Integration suites from Tasks 1.1, 1.2 and 1.7, plus `softwareCatalogPartnerDeleteRls.integration.test.ts` and `softwareCatalogDelete.integration.test.ts`.
- [ ] `pnpm db:check-drift` clean, then `pnpm test-stack down`.
- [ ] One independent review round (`superpowers:requesting-code-review`, Sonnet reviewer) focused on the D6 auth branch and the migration.
- [ ] PR `feat(software): partner-wide installer upload — API (#9246)`, body `Refs #9246`. Recheck the migration slot right before enqueue; a newer merged migration poisons the queue.

---

## Wave W02 — Web: Software Library upload for partner-wide packages

Branch off `main` after W01 merges. PR `Refs #9246`. Low/medium rigor: UI + copy. Tests are still written red first.

## Execution split and parallelism (W02)

- **Seam:** consumes W01's HTTP behaviour only. No new API fields: ownership comes from the catalog item fields the page already has (`orgId`, `partnerId`, `integrationProvider`; `SoftwareCatalog.tsx:204-219`).
- **Order:** 2.0, then **PARALLEL GROUP B** {2.1 `SoftwareVersionManager.tsx` + `SoftwareCatalog.tsx`, 2.2 `AddPackageModal.tsx`}. These are file-disjoint, but both edit `locales/*/policies.json`, so serialize the locale commits or merge them by hand. Then 2.3 (copy) → 2.4.
- **Sonnet-eligible:** 2.2, 2.3 (8-locale copy). Opus reviews 2.1.

### Task 2.0: Preflight

- [ ] Rebase on `main` with W01 merged. Confirm that `POST /software/catalog/<S1 id>/versions/uploads` as a partner admin returns 201 on a wt-stack (`worktree-stack` skill).

### Task 2.1: Versions tab knows the package owner

**Files:** Modify `components/software/SoftwareVersionManager.tsx` (props ~180-195, file picker ~1060-1095, args field ~1099-1120), `components/software/SoftwareCatalog.tsx:1019`; test `SoftwareVersionManager.partnerOwner.test.tsx` (new; pattern `SoftwareVersionManager.upload.test.tsx`); locales.

**Interfaces — Produces:** new optional props `ownerScope?: 'organization' | 'partner'` (default `'organization'`) and `integrationProvider?: 'huntress' | 'sentinelone'`. `SoftwareCatalog` passes `ownerScope={selectedSoftware.orgId ? 'organization' : 'partner'}` and `integrationProvider={selectedSoftware.integrationProvider}`.

Behaviour:
- When `ownerScope === 'partner'` and `useAuthStore(s => s.user?.canManagePartnerWide) === false`, the add-version form shows a disabled reason `partnerWideRequiresFullAccess`. An explicit `false` only; `undefined` (not loaded yet) leaves the form enabled, and the server still answers 403.
- When `integrationProvider` is set, the install-args field shows helper text `builtinArgsDefault`, which says that a blank field uses the package's default arguments, including its per-organization key.
- New en keys under `policies:software.softwareVersionManager`: `partnerWideRequiresFullAccess`, `builtinArgsDefault`.

- [ ] **Step 1: failing tests:**
  - `partner-owned + canManagePartnerWide false → file button and Save disabled, reason shown`
  - `partner-owned + canManagePartnerWide true → upload posts to /software/catalog/cat-1/versions/uploads`
  - `integrationProvider sentinelone → helper text rendered`
  - `org-owned → no new text` (regression)
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/software/SoftwareVersionManager.partnerOwner.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement; add both keys to all 8 locales.
- [ ] **Step 4:** Rerun with every `SoftwareVersionManager.*.test.tsx` and `src/locales`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web/software): Versions tab uploads to partner-wide packages (#9246)`.

### Task 2.2: Add Package modal allows a file for partner-wide

**Files:** Modify `components/software/AddPackageModal.tsx:134-170, 921-930`, `AddPackageModal.ownerScope.test.tsx`; locales (delete `addPackageModal.partnerWideUrlOnly` and `addPackageModal.selectedFileRemoved` from all 8, after `rg` confirms no other reader).

- [ ] **Step 1: failing test:** replace `disables the file source for partner-wide packages (URL-only)` (~70) with `partner-wide keeps the file source and uploads through the chunked API`. Add `switching to partner-wide keeps a picked file`.
- [ ] **Step 2:** Run `cd apps/web && npx vitest run src/components/software/AddPackageModal`. Expected: FAIL.
- [ ] **Step 3:** `uploadsEnabled = s3UploadsEnabled`. Drop the partner branch of `uploadDisabledReason`, the `droppedFileName` state and its notice, and the file-dropping in `setOwnerScope`. Update the comment at 134-136.
- [ ] **Step 4:** Rerun plus `src/locales`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web/software): partner-wide packages accept an uploaded installer (#9246)`.

### Task 2.3: SentinelOne copy says what now works

**Files:** locales `policies.json` keys `sentinelOneMsiNote` and `binaryMissing` (en ~1286-1289; all 8 locales); `SecurityAgentsTab.tsx` only if a test pins the text.

- [ ] **Step 1:** `sentinelOneMsiNote` becomes: "Upload the SentinelOne MSI on the built-in SentinelOne package's Versions tab first. Leave install arguments blank to use SITE_TOKEN={s1_site_token} /q /NORESTART. Breeze does not provide the installer, and SentinelOne cannot be turned on until it is there." `binaryMissing` keeps its meaning; reword only if it contradicts the above.
- [ ] **Step 2:** Run `cd apps/web && npx vitest run src/components/configurationPolicies src/locales`. Expected: PASS.
- [ ] **Step 3:** Commit `docs(web/security-agents): SentinelOne MSI note matches partner upload (#9246)`.

### Task 2.4: W02 verification + PR

- [ ] `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm exec astro check; echo EXIT=$?` (what CI runs). Expected: `EXIT=0`. Then the touched test files.
- [ ] Browser check on a wt-stack as a full-partner admin: upload a small `.msi` to the S1 package from the Versions tab with an org selected in the switcher, then with "All organizations". The version shows the template args. Tear the stack down.
- [ ] PR `feat(web/software): upload installers to partner-wide packages (#9246)`, `Refs #9246`.

---

## Wave W03 — Docs + org-only invariant sweep

The brief put "migration of any org-only invariant" here. The schema invariant itself (`org_id NOT NULL` on sessions) had to move to W01, because W01's routes cannot run without it. W03 carries what is left: code comments, docs, and any reader that still assumes an org-only session or a URL-only partner package. PR `docs(software): partner-wide installer upload (#9246)` with `Closes #9246`.

## Execution split and parallelism (W03)

- **Seam:** none; docs and comments only.
- **Order:** 3.1 ∥ 3.2, then 3.3.
- **Sonnet-eligible:** all three. Opus reviews 3.2's sweep output against its own `rg`.

### Task 3.1: User docs

**Files:** `apps/docs/src/content/docs/features/edr-integrations.mdx:389-404`, `features/deployments.mdx`, `reference/api.mdx` (upload endpoints), regenerated `apps/api/src/data/docsIndex.json` (`npx tsx scripts/build-docs-index.ts`; docs PRs commit it, e.g. #11330).

- [ ] Update the SentinelOne steps:
  - a full-partner admin uploads the MSI once, for all orgs, on the built-in package's Versions tab;
  - blank args default to the template;
  - partner users with selected-org access cannot upload to partner-wide packages;
  - the one uploaded file serves every org, so never upload a site-specific installer or put a token in its name; the site token comes from `{s1_site_token}` at install time.
- [ ] Remove any "partner-wide packages are URL-only" statement. In the API reference, state that upload sessions on a partner-wide package ignore `?orgId`.
- [ ] Add a line to `docs/release-notes/next-release-draft.md` (merge-queue hot spot: rebase right before enqueue).

### Task 3.2: Org-only invariant sweep

- [ ] Run `rg -n "softwareUploadSessions\.orgId|software_upload_sessions.*org_id|URL-only|partner-wide packages use a download URL|software/\$\{orgId\}" apps packages ee docs`. Every hit is either fixed or justified in the PR body (org-owned paths legitimately keep `software/${orgId}`).
- [ ] Fix the stale comments known at plan time:
  - `jobs/softwareUploadSessionCleanup.ts` docblock;
  - `db/schema/software.ts` session comment, if 1.1 missed it;
  - `AddPackageModal.tsx:134-136`;
  - `routes/softwareUploads.ts:268-270`, if 1.5 missed it;
  - `services/securityAgents/securityAgentVendors.ts:34` and `managedPolicyGenerator.ts:55`, only if they say the binary must be added by URL.
- [ ] Check the AI/MCP tools: `rg -n "upload" apps/api/src/services/aiToolsSoftware*.ts`. No tool uploads binaries today, so expect no change; record that in the PR.

### Task 3.3: W03 verification + PR

- [ ] `cd apps/docs && pnpm exec astro check; echo EXIT=$?`. Expected: `EXIT=0`. Then open the PR with `Closes #9246`.

---

## CI traps

- `tenant-export-policy`, `tenantExportErasureRoundtrip`, `tenantCascade` and `orgMergeRegistry` integration suites fail only under **Integration Tests**, never Test API. `rls-coverage` has its own config (`test:rls-coverage`); pointing another config at it prints "No test files found".
- Never `pnpm --filter <pkg> test -- --run <path>`; use `cd apps/<pkg> && npx vitest run <path>`. Path filters are substring matches, so check the file count.
- `orgMerge.test.ts` reds only in the full unit suite.
- A newer migration merged ahead of W01 reds every merge group in Check Migrations. Rename before enqueue.
- A stacked PR (base ≠ main) runs no CI. Cut W02 and W03 from `main` after the previous wave merges.
- `softwareUploads.test.ts` mocks `db/schema`. Any new column a route reads must be added to that mock, or the route reads `undefined` and tests pass for the wrong reason.

## Self-review notes

- Issue coverage: upload to built-in (partner-wide) packages: W01 Tasks 1.5 and 1.6, W02 Tasks 2.1 and 2.2. Template default: Task 1.3. The `{s1_site_token}` requirement: Task 1.4 (OD2). Tab copy: Task 2.3.
- Types: `UploadOwner`, `uploadOwnerOf`, `softwarePackageObjectKey`, `defaultSilentArgsForCatalogItem` and `integrationInstallArgsError` are named identically in Tasks 1.3–1.7.
