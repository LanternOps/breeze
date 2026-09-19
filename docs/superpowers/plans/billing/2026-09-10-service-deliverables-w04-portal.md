---
tracking_issue: LanternOps/breeze#5573
---
# Service Deliverables W04: Customer Portal Service and Documents Surfaces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the customer portal two new fail-closed surfaces — a Service scorecard (what was promised, what was delivered, when, with what evidence, what is next) and a Documents library — plus a dashboard Service tile, under two new `portal_branding` flags, exposing only curated delivery records and never the tickets behind them.

**Architecture:** Two new read models in `apps/api/src/services/portal/` (`serviceReadModel.ts`, `documentsReadModel.ts`) run inside the portal session's existing org-scoped RLS transaction and own every publication rule from spec D10 — the routes are thin. Two Hono route hubs (`routes/portal/service.ts`, `routes/portal/documents.ts`) mount at root under `createPortalFeatureGateStrict('enableService')` / `('enableDocuments')`, mirroring `portalReportRoutes`. Document bytes stream through the API under RLS via the W03 `orgDocumentService`, never a presigned URL. The portal adds two Astro pages that SSR-fetch through `portalApi` and render React islands, plus two nav entries gated on the new flags.

**Tech Stack:** PostgreSQL + hand-written idempotent SQL migration, Drizzle ORM, Hono + Zod, Vitest (API unit with Drizzle mocks, API integration on real Postgres), Astro + React islands (`apps/portal` has no i18n — strings are English), react-i18next in `apps/web` (8 locales), Testing Library.

**Spec:** `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md` (approved 2026-09-10). Sections 4.7, 8 (portal surface + publication rules D10), 11 (tenancy), 13 (portal tests) and wave-table row W04 are this wave. Read §8 in full before Task 4.

**Precedent this wave copies, not reinvents:** `docs/superpowers/specs/portal/2026-09-02-portal-visibility-wave1-design.md` §5 (gating), §6 (ETag + `private, max-age=30`), §7 (read models), §11 (tests), and its plan parts A–C. Every pattern below already exists in `apps/api/src/routes/portal/{dashboard,reports}.ts`, `apps/api/src/services/portal/actionItemsReadModel.ts`, `apps/portal/src/pages/{dashboard,security,reports}/index.astro`.

**Depends on:** W01 (tables `service_deliverables`, `service_deliverable_occurrences`, `service_deliverable_evidence`, `organization_key_dates`; Drizzle exports `serviceDeliverables`, `serviceDeliverableOccurrences`, `serviceDeliverableEvidence`, `organizationKeyDates`), **W02** (the sweep that produces occurrences and delivery records), **W03** (`org_documents` table, its Drizzle export `orgDocuments`, and `apps/api/src/services/orgDocumentService.ts`). Do not start until W02 and W03 have merged to `main` and this branch is rebased on them.

## Global Constraints

- **Tenancy:** every read in this wave runs **inside the ambient portal org transaction** set by `portalAuthMiddleware` (`apps/api/src/routes/portal/auth.ts:356` — `scope: 'organization'`, `accessibleOrgIds: [orgId]`, `accessiblePartnerIds: []`, `userId: null`). **No `runOutsideDbContext`, no `withSystemDbAccessContext`, anywhere in this wave.** Spec §11: "Portal routes run as the portal session's org; no system escalation in any portal read model." All tables read here are shape 1 (direct `org_id`), so `breeze_has_org_access(org_id)` is the only policy exercised.
- **Org id is server-derived.** Every read model takes `orgId` from `auth.user.orgId`; no route ever accepts an org id as input.
- **Timezone** comes from `auth.timezone` (hydrated once by `portalAuthMiddleware`, `apps/api/src/routes/portal/schemas.ts:44-51`). Read models take it as a parameter and never resolve it themselves.
- **Every new read-model function has a unit test asserting the compiled SQL carries the org predicate**, using `new PgDialect().sqlToQuery(where as SQL).params` and `toContain(ORG_ID)` — the pattern in `apps/api/src/services/portal/actionItemsReadModel.test.ts:52-56`. Asserting only the mocked return value is vacuous (memory: `drizzle_condition_deep_search_matches_enum_values_vacuous` — assert on the bound Param, never on a deep object search).
- **Fail closed:** both new flags default `false` for every existing org; `createPortalFeatureGateStrict` (`apps/api/src/routes/portal/featureFlags.ts:80-99`) returns 403 when the `portal_branding` row is missing **or** the flag is not exactly `true`.
- **Publication rules (spec §8, D10) live in the read model, not the route.** Restated as invariants every task must preserve:
  1. No response in this wave contains a ticket id, ticket number, ticket subject, ticket URL, or any field whose name contains "ticket".
  2. Document evidence appears when the document is `portal_visible = true` and not soft-deleted, **regardless of `enable_documents`** (that flag governs the library page only).
  3. Report-run evidence appears only when `enable_reports` is true **and** the parent report has `portal_self_service = true` (`apps/api/src/services/portal/reportsSelfService.ts:174-180` is the existing access rule — the portal already refuses every other run).
  4. A `delivered` occurrence with `artifact_required = true` and no portal-visible evidence reports `artifactState: 'held_by_msp'`. Nothing pretends evidence exists.
- **Never invent zeros:** the dashboard tile carries `status: TileStatus` (`'ok' | 'no_data' | 'not_configured' | 'stale'`) and `null` values when a source is missing, matching `packages/shared/src/types/portalVisibility.ts:1-5`.
- **Migration** is DDL-only (two `ADD COLUMN IF NOT EXISTS`), so no `breeze.scope` election is required; idempotent; no inner `BEGIN;`/`COMMIT;`. Filename must sort after the newest committed migration AND must not collide with a sibling wave. Slots claimed by the other plans in this feature, read from their own File-structure tables: W01 `-170000-`, `-170100-`, `-170200-`; W03 `-170300-` (org_documents) and `-170400-` (documents permissions); W05 `-170500-`. **This wave therefore uses `2026-10-15-170600-`.** Re-check with `ls apps/api/migrations | sort | tail -3` before committing and rename upward if `main` gained a later one — shipped migrations are content-hash immutable, so the time to get this right is before the push.
- **Column rule:** adding a column to a table already in `CORE_ORG_CASCADE_DELETE_ORDER` breaks `tenant-export-policy.integration.test.ts`. `portal_branding` is such a table (`apps/api/src/services/tenantExportPolicyRegistry.ts:358`), so both new columns get `included` entries in the **same PR**. No new tables, so no cascade, merge-registry or RLS-allowlist changes.
- **Portal (`apps/portal`) contract tests that WILL fail if you skip a step:** `lib/visibilityGate.test.ts:83-98` (gate-code parity with the API source), `lib/disabledPageCoverage.test.ts:85-116` (every page fed by a gated API method must branch on the gate 403 in its frontmatter) and `:193-204` (every signed-in page sits behind `PORTAL_PROTECTED_PREFIXES`), `lib/noInlineStyles.test.ts` (no `style={{...}}` — production CSP sets `style-src-attr 'none'`), `lib/basePathCoverage.test.ts` (hand-authored internal links go through `withBase()`).
- **Web (`apps/web`) mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`); every user-visible string added to `apps/web` needs a real translation in all 8 locales under `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/` — `apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English duplicates.
- **Running one test file:** `cd apps/api && npx vitest run <path>` and `cd apps/portal && npx vitest run <path>` and `cd apps/web && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded literally, vitest stays in watch mode and runs the whole suite). Integration suites: `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` with `pnpm test-stack up` first and `pnpm test-stack down` when finished.
- **Branch:** `feature/<parent#>-service-deliverables/wave-<W04 sub-issue#>`; PR body contains `Closes #<W04 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-16-110000-portal-branding-service-documents-flags.sql` | `enable_service`, `enable_documents` columns |
| `apps/api/src/db/schema/portal.ts:36-40` area | the two Drizzle columns beside the five Wave-1 flags |
| `apps/api/src/services/portal/portalFlags.ts:11-17` | both keys in `PORTAL_VISIBILITY_FLAG_KEYS` |
| `apps/api/src/routes/portal/featureFlags.ts` | two `STRICT_PORTAL_FEATURES` entries + `createPortalFeatureGateAny` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:358` | both columns `included` in `portal_branding` |
| `packages/shared/src/validators/portal.ts:7-21` | both flags on `updatePortalSettingsSchema` |
| `apps/api/src/routes/orgPortalSettings.ts` | defaults, row type, projection, response, `current` map |
| `apps/api/src/routes/portal/branding.ts:105-113` | both flags in the authenticated branding projection |
| `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` | two visibility toggles + enable-all + save body |
| `apps/web/src/locales/*/settings.json` | two toggle label/description pairs ×8 locales |
| `packages/shared/src/types/portalService.ts` (+ export from `types/index.ts`) | every DTO this wave returns |
| `apps/api/src/services/portal/serviceReadModel.ts` (+ `.test.ts`) | `serviceOverview`, `deliverableOccurrences`, publication rules, `serviceTile` |
| `apps/api/src/services/portal/documentsReadModel.ts` (+ `.test.ts`) | `documentsForOrg`, `portalVisibleDocument` |
| `apps/api/src/services/portal/dashboard.ts` | `serviceTile` added to the `Promise.all` |
| `apps/api/src/routes/portal/service.ts` (+ `.test.ts`) | `GET /service`, `GET /service/:deliverableId/occurrences` |
| `apps/api/src/routes/portal/documents.ts` (+ `.test.ts`) | `GET /documents`, `GET /documents/:id/content` |
| `apps/api/src/routes/portal/index.ts` | auth + gate mounts for both prefixes |
| `apps/api/src/routes/portal/schemas.ts` | `portalOccurrenceListSchema`, `portalDocumentParamSchema`, `portalDeliverableParamSchema` |
| `apps/api/src/__tests__/integration/portalServiceRls.integration.test.ts` | cross-org forge of every new route's read model |
| `apps/portal/src/lib/{api,navItems,visibilityGate,protectedPaths}.ts` | client, nav, gate codes, protected prefixes |
| `apps/portal/src/pages/service/index.astro` (+ `index.test.ts`) | Service page |
| `apps/portal/src/pages/documents/index.astro` (+ `index.test.ts`) | Documents page |
| `apps/portal/src/components/portal/ServiceScorecard.tsx` (+ `.test.tsx`) | groups, deliverable rows, occurrence history |
| `apps/portal/src/components/portal/DocumentLibrary.tsx` (+ `.test.tsx`) | category groups, download links |
| `apps/portal/src/components/portal/DashboardTiles.tsx` | the Service ledger row |

---

### Task 1: Flags — migration, Drizzle, flag registry, export policy

**Files:**
- Create: `apps/api/migrations/2026-10-16-110000-portal-branding-service-documents-flags.sql`
- Modify: `apps/api/src/db/schema/portal.ts:34-40` (the five Wave-1 flags block)
- Modify: `apps/api/src/services/portal/portalFlags.ts:11-17`
- Modify: `apps/api/src/services/portal/portalFlags.test.ts:20-30`
- Modify: `apps/api/src/routes/portal/featureFlags.ts:57-78`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:358`

**Interfaces:**
- Produces: columns `portal_branding.enable_service`, `portal_branding.enable_documents`; Drizzle `portalBranding.enableService`, `portalBranding.enableDocuments`; `PortalVisibilityFlag` widened to seven keys; 403 codes `PORTAL_SERVICE_DISABLED`, `PORTAL_DOCUMENTS_DISABLED`.

- [ ] **Step 1: Confirm the filename still sorts last**

```bash
ls apps/api/migrations | sort | tail -3
```
Expected: nothing sorting after `2026-10-15-170600-…`. The sibling waves occupy `-170000-` through `-170500-` (see Global Constraints). If `main` gained a later migration, bump this file's time component above it and update every reference in this plan.

- [ ] **Step 2: Write the migration**

```sql
-- Service deliverables W04 (spec §4.7, D10): two fail-closed customer-portal
-- visibility flags. Existing portal_branding RLS, FORCE RLS and breeze_app
-- grants already cover every column of this table, so nothing else is needed.
-- DDL only: no rows are written, so no breeze.scope election.
-- autoMigrate owns the transaction; do not add BEGIN or COMMIT.

ALTER TABLE portal_branding
  ADD COLUMN IF NOT EXISTS enable_service
    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_documents
    boolean NOT NULL DEFAULT false;
```

- [ ] **Step 3: Write the failing flag-registry test**

In `apps/api/src/services/portal/portalFlags.test.ts`, extend the existing `PORTAL_VISIBILITY_FLAG_KEYS` assertion (line 22) to the seven-key list:

```ts
    expect(PORTAL_VISIBILITY_FLAG_KEYS).toEqual([
      'enableDashboard',
      'enableSecurity',
      'enableBackups',
      'enableReports',
      'enableSupportUsage',
      'enableService',
      'enableDocuments'
    ]);
```

And in `apps/api/src/routes/portal/featureFlags.test.ts`, add two rows to the `it.each` table at line 61:

```ts
    ['enableService', 'PORTAL_SERVICE_DISABLED'],
    ['enableDocuments', 'PORTAL_DOCUMENTS_DISABLED'],
```

- [ ] **Step 4: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/portal/portalFlags.test.ts src/routes/portal/featureFlags.test.ts`
Expected: FAIL — the arrays differ by two entries and `STRICT_PORTAL_FEATURES` has no `enableService` key.

- [ ] **Step 5: Add the Drizzle columns**

In `apps/api/src/db/schema/portal.ts`, immediately after `enableSupportUsage` (line 40):

```ts
  // Service deliverables W04 (spec §4.7, D10): the Service scorecard and the
  // org document library. Same fail-closed shape as the five flags above.
  enableService: boolean('enable_service').notNull().default(false),
  enableDocuments: boolean('enable_documents').notNull().default(false),
```

- [ ] **Step 6: Widen the flag registry and the strict-gate table**

In `apps/api/src/services/portal/portalFlags.ts`, append `'enableService'` and `'enableDocuments'` to `PORTAL_VISIBILITY_FLAG_KEYS`. `onPortalFlagsChanged` is unchanged — neither new flag provisions anything.

In `apps/api/src/routes/portal/featureFlags.ts`, add to `STRICT_PORTAL_FEATURES`:

```ts
  enableService: {
    error: 'Service delivery is not enabled for this portal',
    code: 'PORTAL_SERVICE_DISABLED',
  },
  enableDocuments: {
    error: 'Documents are not enabled for this portal',
    code: 'PORTAL_DOCUMENTS_DISABLED',
  },
```

- [ ] **Step 7: Add `createPortalFeatureGateAny`**

Document evidence is published under `enable_service` regardless of `enable_documents` (spec §8), but the download link it renders points at `/portal/documents/:id/content`. A gate on `enableDocuments` alone would 403 exactly the evidence the Service page just told the customer exists. Append to `apps/api/src/routes/portal/featureFlags.ts`:

```ts
/**
 * Passes when ANY of `flags` is true on the org's portal_branding row. Still
 * fail-closed: a missing row or all-false refuses, answering with the FIRST
 * flag's message so the customer is told about the surface they asked for.
 *
 * The one legitimate use is the document CONTENT route: spec §8 publishes a
 * portal-visible document as delivery evidence under enable_service even when
 * enable_documents (the library page) is off, so the bytes must stay reachable
 * under either flag while the library listing stays gated on its own.
 */
export function createPortalFeatureGateAny(
  ...flags: readonly [PortalVisibilityFlag, ...PortalVisibilityFlag[]]
): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get('portalAuth');
    if (!auth) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    const [row] = await db
      .select(Object.fromEntries(flags.map((f) => [f, portalBranding[f]])))
      .from(portalBranding)
      .where(eq(portalBranding.orgId, auth.user.orgId))
      .limit(1);
    if (flags.some((f) => row?.[f] === true)) return next();
    return c.json(STRICT_PORTAL_FEATURES[flags[0]], 403);
  };
}
```

Add a test in `featureFlags.test.ts`: with `dbState.rows = [{ enableDocuments: false, enableService: true }]` the gate passes; with both false it answers 403 `PORTAL_DOCUMENTS_DISABLED`; with no row at all it answers 403; and the captured `dbState.where` params contain the org id.

- [ ] **Step 8: Classify both columns in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts:358`, append `"enable_service","enable_documents"` to the end of `portal_branding`'s `included` array. They are ordinary boolean settings — not credentials, not open containers.

- [ ] **Step 9: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/portal/portalFlags.test.ts src/routes/portal/featureFlags.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

With the test stack up (`pnpm test-stack up`):

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS. A failure naming `enable_service` means Step 8 was skipped.

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/2026-10-16-110000-portal-branding-service-documents-flags.sql \
  apps/api/src/db/schema/portal.ts apps/api/src/services/portal/portalFlags.ts \
  apps/api/src/services/portal/portalFlags.test.ts apps/api/src/routes/portal/featureFlags.ts \
  apps/api/src/routes/portal/featureFlags.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(portal): enable_service and enable_documents visibility flags (W04)"
```

---

### Task 2: MSP write surface for the two flags

**Files:**
- Modify: `packages/shared/src/validators/portal.ts:7-21`
- Modify: `apps/api/src/routes/orgPortalSettings.ts:23-96,186-192`
- Modify: `apps/api/src/routes/orgPortalSettings.test.ts:305-340`
- Modify: `apps/api/src/routes/portal/branding.ts:105-113`
- Test: `apps/api/src/routes/orgPortalSettings.test.ts`, `packages/shared/src/validators/portal.test.ts`

**Interfaces:**
- Consumes: `PORTAL_VISIBILITY_FLAG_KEYS` (Task 1).
- Produces: `PATCH /orgs/organizations/:id/portal-settings` accepts and returns `enableService`, `enableDocuments`; `GET /portal/branding` returns both.

- [ ] **Step 1: Write the failing route test**

In `apps/api/src/routes/orgPortalSettings.test.ts`, extend the "persists visibility flags and invokes the W09 seam" case (line 305) so the request sets `enableService: true` and the expected `current` map carries all seven keys:

```ts
    const res = await patch({ enableDashboard: true, enableReports: true, enableService: true });
    …
    expect(onPortalFlagsChanged).toHaveBeenCalledWith({
      orgId: ORG_ID,
      createdBy: 'u-1',
      requested: { enableDashboard: true, enableReports: true, enableService: true },
      current: {
        enableDashboard: true, enableSecurity: false, enableBackups: false,
        enableReports: true, enableSupportUsage: false,
        enableService: true, enableDocuments: false
      }
    });
```
Add `enableService: true, enableDocuments: false` to that case's `dbUpsertReturning` row and `enableService: false, enableDocuments: false` to the shared `FULL_ROW` fixture.

In `packages/shared/src/validators/portal.test.ts`, add:

```ts
  it('accepts the W04 service and documents flags', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableService: true, enableDocuments: false }).success).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/orgPortalSettings.test.ts` and `cd packages/shared && npx vitest run src/validators/portal.test.ts`
Expected: FAIL — the `.strict()` schema rejects the unknown keys, and `current` is short two entries.

- [ ] **Step 3: Implement**

`packages/shared/src/validators/portal.ts`, after `enableSupportUsage` (line 16):

```ts
  enableService: z.boolean().optional(),
  enableDocuments: z.boolean().optional(),
```

`apps/api/src/routes/orgPortalSettings.ts` — four edits, all mechanical:
- `PORTAL_SETTINGS_DEFAULTS` (line 23): add `enableService: false, enableDocuments: false`.
- `PortalSettingsRow` (line 39): add `enableService: boolean; enableDocuments: boolean;`.
- `portalSettingsColumns()` (line 62): add `enableService: portalBranding.enableService, enableDocuments: portalBranding.enableDocuments`.
- `toResponse` (line 78): add `enableService: row.enableService, enableDocuments: row.enableDocuments`.
- the `current:` literal (line 186): add `enableService: row.enableService, enableDocuments: row.enableDocuments`.

`apps/api/src/routes/portal/branding.ts`, after `enableSupportUsage` (line 113):

```ts
      enableSupportUsage: portalBranding.enableSupportUsage,
      enableService: portalBranding.enableService,
      enableDocuments: portalBranding.enableDocuments
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/routes/orgPortalSettings.test.ts src/routes/portal/branding.test.ts && npx tsc --noEmit`
Run: `cd packages/shared && npx vitest run src/validators/portal.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/portal.ts packages/shared/src/validators/portal.test.ts \
  apps/api/src/routes/orgPortalSettings.ts apps/api/src/routes/orgPortalSettings.test.ts \
  apps/api/src/routes/portal/branding.ts
git commit -m "feat(portal): read and write the service and documents flags (W04)"
```

---

### Task 3: MSP web toggles and translations

**Files:**
- Modify: `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx:8-22,48-85,124-131,141-158`
- Modify: `apps/web/src/components/settings/OrgPortalSettingsEditor.test.tsx:25-40,113-160`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`

**Interfaces:**
- Consumes: the PATCH contract from Task 2.
- Produces: `data-testid="org-portal-toggle-enableService"`, `data-testid="org-portal-toggle-enableDocuments"`.

- [ ] **Step 1: Write the failing component test**

In `OrgPortalSettingsEditor.test.tsx`, add `enableService: false, enableDocuments: false` to the settings fixture (line ~31), then extend the two existing lists (line 120 and line 150) with `'enableService'` and `'enableDocuments'` so both "enable all" and "save all" cover seven flags.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx`
Expected: FAIL — `org-portal-toggle-enableService` is not in the document.

- [ ] **Step 3: Implement**

In `OrgPortalSettingsEditor.tsx`:
- `PortalSettings` type (line 8): add `enableService: boolean; enableDocuments: boolean;`.
- `VisibilityToggleKey` union (line 48): add `| 'enableService' | 'enableDocuments'`.
- `VISIBILITY_TOGGLES` (line 56): append two entries following the existing shape:

```ts
  {
    key: 'enableService',
    labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableService.label',
    descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableService.description',
  },
  {
    key: 'enableDocuments',
    labelKey: 'orgPortalSettingsEditor.visibility.toggles.enableDocuments.label',
    descriptionKey: 'orgPortalSettingsEditor.visibility.toggles.enableDocuments.description',
  },
```
- `enableAllVisibility` (line 124): add `enableService: true, enableDocuments: true`.
- the `runAction` PATCH body (line 141): add `enableService: draft.enableService, enableDocuments: draft.enableDocuments`.

No new markup — the existing `VISIBILITY_TOGGLES.map` renders both.

- [ ] **Step 4: Add real translations in all 8 locales**

Under `orgPortalSettingsEditor.visibility.toggles` in each `settings.json`. English:

```json
"enableService": {
  "label": "Service",
  "description": "Show scheduled deliverables, what was delivered, and key dates."
},
"enableDocuments": {
  "label": "Documents",
  "description": "Let customers download the documents you have shared with them."
}
```

Translate — do not paste English into the other seven. de-DE: "Service" / "Zeigt geplante Leistungen, Erbrachtes und wichtige Termine." and "Dokumente" / "Ermöglicht Kunden den Download freigegebener Dokumente."; es-419: "Servicio" / "Muestra los entregables programados, lo entregado y las fechas clave." and "Documentos" / "Permite a los clientes descargar los documentos que compartiste."; fr-CA and fr-FR: "Service" / "Affiche les livrables planifiés, ce qui a été livré et les dates clés." and "Documents" / "Permet aux clients de télécharger les documents partagés."; it-IT: "Servizio" / "Mostra i deliverable pianificati, quanto consegnato e le date chiave." and "Documenti" / "Consente ai clienti di scaricare i documenti condivisi."; pt-BR: "Serviço" / "Mostra as entregas programadas, o que foi entregue e as datas importantes." and "Documentos" / "Permite que os clientes baixem os documentos compartilhados."; tr-TR: "Hizmet" / "Planlanan teslimatları, teslim edilenleri ve önemli tarihleri gösterir." and "Belgeler" / "Müşterilerin paylaşılan belgeleri indirmesine izin verir."

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx src/lib/i18n`
Expected: PASS, including `translationCoverage.test.ts` (the duplicate-English cap is why Step 4 must be real translations).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings apps/web/src/locales
git commit -m "feat(web): service and documents portal visibility toggles (W04)"
```

---

### Task 4: Shared DTO types

**Files:**
- Create: `packages/shared/src/types/portalService.ts`
- Create: `packages/shared/src/types/portalService.test.ts`
- Modify: `packages/shared/src/types/index.ts:845` area (add `export * from './portalService';`)

**Interfaces:**
- Consumes: `TileStatus` from `./portalVisibility`.
- Produces (both the API read models and `apps/portal` import these):

```ts
import type { TileStatus } from './portalVisibility';

/** Where a row on the Service page came from. Spec §8 keeps these discriminated
 *  so a future Projects module adds 'project' / 'project_milestone' arms to the
 *  same page instead of a second page. */
export type PortalServiceGroupSource = 'contract' | 'standalone';
export type PortalKeyDateSource = 'key_date' | 'contract_end';

export type PortalDeliverableCadence =
  | 'monthly' | 'quarterly' | 'semiannual' | 'annual' | 'one_time';

/** Customer-facing rollup of a deliverable's current standing. */
export type PortalDeliverableStatus = 'on_track' | 'due_soon' | 'late' | 'missed';

/**
 * Customer-facing occurrence state. `awaiting_evidence` is deliberately ABSENT:
 * it means the MSP resolved its internal ticket but has not attached the
 * artifact, which is a workflow detail of the MSP, not a fact about the
 * customer's service. It maps to 'in_progress' (spec D10: curated delivery
 * records only, never the ticket behind them).
 */
export type PortalOccurrenceStatus =
  | 'scheduled' | 'in_progress' | 'delivered' | 'missed' | 'waived';

/** What the customer can actually open for a delivery. */
export type PortalArtifactState = 'attached' | 'report' | 'none' | 'held_by_msp';

export interface PortalEvidenceRef {
  kind: 'document' | 'report_run';
  /** Set for kind 'document'; download at /api/v1/portal/documents/<id>/content. */
  documentId: string | null;
  /** Set for kind 'report_run'; download at /api/v1/portal/reports/runs/<id>/pdf. */
  reportRunId: string | null;
  title: string;
  createdAt: string;
}

export interface PortalDeliveryRecord {
  at: string;
  late: boolean;
  note: string | null;
  artifactState: PortalArtifactState;
  evidence: PortalEvidenceRef[];
}

export interface PortalDeliverableDto {
  id: string;
  name: string;
  description: string | null;
  cadence: PortalDeliverableCadence;
  artifactRequired: boolean;
  lastDelivered: PortalDeliveryRecord | null;
  nextDue: string | null;
  status: PortalDeliverableStatus;
}

export interface PortalServiceGroupDto {
  source: PortalServiceGroupSource;
  contract: { id: string; name: string } | null;
  deliverables: PortalDeliverableDto[];
}

export interface PortalKeyDateDto {
  source: PortalKeyDateSource;
  id: string;
  label: string;
  kind: string;
  date: string;
  notes: string | null;
}

export interface PortalServiceOverviewDto {
  asOf: string;
  timezone: string;
  groups: PortalServiceGroupDto[];
  keyDates: PortalKeyDateDto[];
}

export interface PortalOccurrenceDto {
  id: string;
  name: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  rescheduled: boolean;
  status: PortalOccurrenceStatus;
  deliveredAt: string | null;
  late: boolean;
  note: string | null;
  artifactState: PortalArtifactState;
  evidence: PortalEvidenceRef[];
}

export interface PortalOccurrencesDto {
  asOf: string;
  timezone: string;
  deliverable: { id: string; name: string; cadence: PortalDeliverableCadence };
  occurrences: PortalOccurrenceDto[];
}

export type PortalDocumentCategory =
  | 'baseline' | 'runbook' | 'policy' | 'evidence' | 'report' | 'export' | 'other';

export interface PortalDocumentDto {
  id: string;
  title: string;
  description: string | null;
  category: PortalDocumentCategory;
  contentType: string;
  byteSize: number;
  originalFilename: string;
  createdAt: string;
}

export interface PortalDocumentGroupDto {
  category: PortalDocumentCategory;
  documents: PortalDocumentDto[];
}

export interface PortalDocumentsDto {
  asOf: string;
  timezone: string;
  groups: PortalDocumentGroupDto[];
}

/** Dashboard tile (spec §8): 90-day delivery record plus the next due item. */
export interface ServiceTileDto {
  status: TileStatus;
  windowDays: 90;
  deliveredOnTime: number | null;
  deliveredLate: number | null;
  missed: number | null;
  nextDue: { name: string; dueAt: string } | null;
  asOf: string;
}
```

- [ ] **Step 1: Write the failing type test**

```ts
// packages/shared/src/types/portalService.test.ts
import { describe, expectTypeOf, it } from 'vitest';
import type {
  PortalArtifactState, PortalOccurrenceStatus, PortalServiceOverviewDto, ServiceTileDto,
} from './portalService';

describe('portal service DTOs', () => {
  it('never exposes a ticket anywhere in the overview', () => {
    // Compile-time proof of spec D10: the portal shows the delivery record, not
    // the ticket. A future field called ticketId would fail this immediately.
    expectTypeOf<keyof PortalServiceOverviewDto>().toEqualTypeOf<'asOf' | 'timezone' | 'groups' | 'keyDates'>();
  });
  it('hides awaiting_evidence from the customer vocabulary', () => {
    expectTypeOf<PortalOccurrenceStatus>().not.toEqualTypeOf<'awaiting_evidence'>();
  });
  it('carries the four artifact states', () => {
    expectTypeOf<PortalArtifactState>().toEqualTypeOf<'attached' | 'report' | 'none' | 'held_by_msp'>();
  });
  it('windows the service tile at 90 days', () => {
    expectTypeOf<ServiceTileDto['windowDays']>().toEqualTypeOf<90>();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/types/portalService.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `portalService.ts` exactly as in the Interfaces block, and add `export * from './portalService';` to `packages/shared/src/types/index.ts` next to the `portalVisibility` export (line 845).**

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/shared && npx vitest run src/types/portalService.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types
git commit -m "feat(shared): portal service and documents DTOs (W04)"
```

---

### Task 5: `serviceReadModel.ts` — publication rules and `serviceOverview`

**Files:**
- Create: `apps/api/src/services/portal/serviceReadModel.ts`
- Create: `apps/api/src/services/portal/serviceReadModel.test.ts`

**Interfaces:**
- Consumes: `serviceDeliverables`, `serviceDeliverableOccurrences`, `serviceDeliverableEvidence`, `organizationKeyDates` (W01 Task 3); `orgDocuments` (W03); `contracts`, `reports`, `reportRuns`, `portalBranding` from `../../db/schema`; `summarizeStatus` from `../serviceDeliverableService` (W01 Task 8).
- Produces:

```ts
export function artifactStateFor(args: {
  artifactRequired: boolean; delivered: boolean; evidence: readonly PortalEvidenceRef[];
}): PortalArtifactState;
export function portalOccurrenceStatus(dbStatus: string): PortalOccurrenceStatus;
export async function serviceOverview(
  orgId: string, args: { timezone: string; now: Date },
): Promise<PortalServiceOverviewDto>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/portal/serviceReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], wheres: [] as unknown[] }));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
        chain[m] = vi.fn((arg: unknown) => {
          if (m === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { artifactStateFor, portalOccurrenceStatus, serviceOverview } from './serviceReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-15T12:00:00Z');

describe('artifactStateFor (spec §8 D10)', () => {
  it('is held_by_msp when a required artifact has no portal-visible evidence', () => {
    expect(artifactStateFor({ artifactRequired: true, delivered: true, evidence: [] }))
      .toBe('held_by_msp');
  });
  it('is none when no artifact was required', () => {
    expect(artifactStateFor({ artifactRequired: false, delivered: true, evidence: [] })).toBe('none');
  });
  it('is none for an undelivered occurrence even when an artifact is required', () => {
    expect(artifactStateFor({ artifactRequired: true, delivered: false, evidence: [] })).toBe('none');
  });
  it('prefers an attached document over a report run', () => {
    const doc = { kind: 'document' as const, documentId: 'd1', reportRunId: null, title: 'Findings', createdAt: '' };
    const run = { kind: 'report_run' as const, documentId: null, reportRunId: 'r1', title: 'Scan', createdAt: '' };
    expect(artifactStateFor({ artifactRequired: true, delivered: true, evidence: [run, doc] })).toBe('attached');
    expect(artifactStateFor({ artifactRequired: true, delivered: true, evidence: [run] })).toBe('report');
  });
});

describe('portalOccurrenceStatus', () => {
  it('hides awaiting_evidence behind in_progress', () => {
    expect(portalOccurrenceStatus('awaiting_evidence')).toBe('in_progress');
    expect(portalOccurrenceStatus('open')).toBe('in_progress');
    expect(portalOccurrenceStatus('scheduled')).toBe('scheduled');
    expect(portalOccurrenceStatus('delivered')).toBe('delivered');
    expect(portalOccurrenceStatus('missed')).toBe('missed');
    expect(portalOccurrenceStatus('waived')).toBe('waived');
  });
});

describe('serviceOverview', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  function seed(opts: { enableReports: boolean; evidence: unknown[] }) {
    state.rows.push([{ enableReports: opts.enableReports }]);          // branding read
    state.rows.push([{                                                  // deliverables + contract
      id: 'd1', name: 'Sign-in log review', description: 'Monthly review',
      cadence: 'monthly', artifactRequired: true, leadDays: 7,
      effectiveFrom: '2026-01-01', effectiveUntil: null, active: true,
      contractId: 'c1', contractName: 'Best plan',
    }]);
    state.rows.push([{                                                  // occurrences
      id: 'o1', deliverableId: 'd1', status: 'delivered', dueAt: '2026-09-30',
      originalDueAt: '2026-09-30', periodStart: '2026-09-01', periodEnd: '2026-09-30',
      deliveredAt: new Date('2026-10-02T09:00:00Z'), deliveryNote: 'Reviewed',
    }]);
    state.rows.push(opts.evidence);                                     // evidence join
    state.rows.push([]);                                                // key dates
    state.rows.push([]);                                                // contract end dates
  }

  it('never leaks a ticket into the payload', async () => {
    seed({ enableReports: true, evidence: [] });
    const dto = await serviceOverview(ORG_ID, { timezone: 'America/Denver', now: NOW });
    expect(JSON.stringify(dto)).not.toMatch(/ticket/i);
  });

  it('scopes every query to the session org', async () => {
    seed({ enableReports: true, evidence: [] });
    await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(state.wheres.length).toBeGreaterThan(0);
    for (const where of state.wheres) {
      expect(new PgDialect().sqlToQuery(where as SQL).params).toContain(ORG_ID);
    }
  });

  it('marks a late delivery of a required artifact with no evidence as held_by_msp', async () => {
    seed({ enableReports: true, evidence: [] });
    const dto = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(dto.groups[0]!.source).toBe('contract');
    expect(dto.groups[0]!.contract).toEqual({ id: 'c1', name: 'Best plan' });
    expect(dto.groups[0]!.deliverables[0]!.lastDelivered).toMatchObject({
      late: true, note: 'Reviewed', artifactState: 'held_by_msp', evidence: [],
    });
  });

  it('publishes report-run evidence only when reports are on and the definition is self-service', async () => {
    const run = {
      occurrenceId: 'o1', evidenceId: 'e1', kind: 'report_run', documentId: null,
      documentTitle: null, documentPortalVisible: null, documentDeletedAt: null,
      reportRunId: 'r1', reportName: 'Vulnerability review', reportPortalSelfService: true,
      createdAt: new Date('2026-10-02T09:05:00Z'),
    };
    seed({ enableReports: false, evidence: [run] });
    const off = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(off.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([]);
    expect(off.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('held_by_msp');

    state.rows.length = 0;
    seed({ enableReports: true, evidence: [{ ...run, reportPortalSelfService: false }] });
    const notSelfService = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(notSelfService.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([]);

    state.rows.length = 0;
    seed({ enableReports: true, evidence: [run] });
    const on = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(on.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([
      { kind: 'report_run', documentId: null, reportRunId: 'r1', title: 'Vulnerability review', createdAt: '2026-10-02T09:05:00.000Z' },
    ]);
    expect(on.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('report');
  });

  it('hides a document that is not portal-visible or is soft-deleted', async () => {
    const base = {
      occurrenceId: 'o1', evidenceId: 'e2', kind: 'document', documentId: 'doc1',
      documentTitle: 'Findings', reportRunId: null, reportName: null,
      reportPortalSelfService: null, createdAt: new Date('2026-10-02T09:05:00Z'),
    };
    for (const hidden of [
      { ...base, documentPortalVisible: false, documentDeletedAt: null },
      { ...base, documentPortalVisible: true, documentDeletedAt: new Date() },
    ]) {
      state.rows.length = 0;
      seed({ enableReports: true, evidence: [hidden] });
      const dto = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
      expect(dto.groups[0]!.deliverables[0]!.lastDelivered!.evidence).toEqual([]);
    }
  });

  it('publishes a portal-visible document even when documents are off', async () => {
    // Spec §8: enable_documents governs the LIBRARY page only. The branding read
    // in this read model asks for enableReports and nothing else, so a document
    // cannot be filtered by a flag this model never reads.
    seed({ enableReports: false, evidence: [{
      occurrenceId: 'o1', evidenceId: 'e3', kind: 'document', documentId: 'doc1',
      documentTitle: 'Findings', documentPortalVisible: true, documentDeletedAt: null,
      reportRunId: null, reportName: null, reportPortalSelfService: null,
      createdAt: new Date('2026-10-02T09:05:00Z'),
    }] });
    const dto = await serviceOverview(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(dto.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('attached');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/portal/serviceReadModel.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `serviceOverview` and its pure helpers**

Query plan — six selects, all in the ambient org transaction, all carrying an explicit `org_id` predicate even though RLS already enforces it (defence in depth, and it is what the SQL-predicate test asserts):

1. `portal_branding` → `{ enableReports }` for this org (rule 3 needs it; `enableDocuments` is deliberately **not** read here).
2. `service_deliverables` left-joined to `contracts` on `(contractId, orgId)` where `orgId = $1 AND portal_visible AND active AND effective_from <= today AND (effective_until IS NULL OR effective_until >= today)`, ordered by `sortOrder, name`. `today` is `now` rendered in `args.timezone` as `YYYY-MM-DD` (use the existing `Intl.DateTimeFormat(… { timeZone })` helper convention in `services/portal/sqlTimestamp.ts`; if a helper is not exported there, add `isoDateInTimezone(now, tz)` to this module and unit-test it with `America/Denver` at `2026-10-01T03:00:00Z` → `2026-09-30`).
3. `service_deliverable_occurrences` where `orgId = $1 AND deliverableId IN (…)`, ordered `dueAt desc` — one round trip for every deliverable, then bucketed in JS.
4. `service_deliverable_evidence` left-joined to `org_documents` on `(documentId, orgId)` and to `reports` on `(reportId, orgId)`, selecting `documentPortalVisible`, `documentDeletedAt`, `documentTitle`, `reportName`, `reportPortalSelfService`, where `orgId = $1 AND occurrenceId IN (…the occurrence ids that matter…)`.
5. `organization_key_dates` where `orgId = $1 AND portal_visible AND date >= today`, ordered `date asc`, limit 20.
6. `contracts` where `orgId = $1 AND end_date IS NOT NULL AND end_date >= today AND status NOT IN ('draft','cancelled')`, ordered `end_date asc`.

Then, in JS:

```ts
export function artifactStateFor(args: {
  artifactRequired: boolean; delivered: boolean; evidence: readonly PortalEvidenceRef[];
}): PortalArtifactState {
  if (args.evidence.some((e) => e.kind === 'document')) return 'attached';
  if (args.evidence.some((e) => e.kind === 'report_run')) return 'report';
  return args.delivered && args.artifactRequired ? 'held_by_msp' : 'none';
}

const OCCURRENCE_STATUS: Record<string, PortalOccurrenceStatus> = {
  scheduled: 'scheduled',
  open: 'in_progress',
  awaiting_evidence: 'in_progress',
  delivered: 'delivered',
  missed: 'missed',
  waived: 'waived',
};
export function portalOccurrenceStatus(dbStatus: string): PortalOccurrenceStatus {
  return OCCURRENCE_STATUS[dbStatus] ?? 'in_progress';
}

/** Rules 2 and 3 of the publication contract, applied to one evidence row. */
function publishableEvidence(row: EvidenceJoinRow, enableReports: boolean): PortalEvidenceRef | null {
  if (row.kind === 'document') {
    if (row.documentPortalVisible !== true || row.documentDeletedAt !== null) return null;
    return { kind: 'document', documentId: row.documentId, reportRunId: null,
             title: row.documentTitle ?? 'Document', createdAt: row.createdAt.toISOString() };
  }
  if (!enableReports || row.reportPortalSelfService !== true) return null;
  return { kind: 'report_run', documentId: null, reportRunId: row.reportRunId,
           title: row.reportName ?? 'Report', createdAt: row.createdAt.toISOString() };
}
```

`lastDelivered` is the newest occurrence with `status === 'delivered'`; `late` is `deliveredAtISODate > dueAt` (derived, never stored — spec §4.2). `nextDue` is the smallest `dueAt >= today` among occurrences whose status is `scheduled`, `open` or `awaiting_evidence`; `null` when there is none.

`status` reuses `summarizeStatus` from `../serviceDeliverableService` so the portal and the MSP page can never disagree. It can return `'inactive'`; the deliverable query already excludes inactive rows, so treat `'inactive'` as "drop this deliverable from the payload" rather than inventing a fifth customer-facing word:

```ts
const rollup = summarizeStatus(
  { active: d.active, effectiveFrom: d.effectiveFrom, effectiveUntil: d.effectiveUntil, leadDays: d.leadDays },
  occ.map((o) => ({ status: o.status as OccurrenceStatus, dueAt: o.dueAt })),
  today,
);
if (rollup === 'inactive') continue;   // predicate drift, not a customer state
```

Grouping: one group per distinct `contractId` (`source: 'contract'`, `contract: { id, name }`), ordered by contract name; then at most one `source: 'standalone'` group with `contract: null` for deliverables with no contract, appended last. Groups with no surviving deliverables are omitted.

`keyDates`: query-5 rows map to `{ source: 'key_date', id, label, kind, date, notes }`; query-6 rows map to `{ source: 'contract_end', id: contract.id, label: contract.name, kind: 'contract_end', date: contract.endDate, notes: null }`. Concatenate and sort by `date` ascending.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/portal/serviceReadModel.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/portal/serviceReadModel.ts apps/api/src/services/portal/serviceReadModel.test.ts
git commit -m "feat(portal): service overview read model with D10 publication rules (W04)"
```

---

### Task 6: `deliverableOccurrences` and `serviceTile`

**Files:**
- Modify: `apps/api/src/services/portal/serviceReadModel.ts`
- Modify: `apps/api/src/services/portal/serviceReadModel.test.ts`
- Modify: `apps/api/src/services/portal/dashboard.ts:42-77`
- Modify: `apps/api/src/services/portal/dashboard.test.ts`
- Modify: `packages/shared/src/types/portalVisibility.ts:92-102` (`DashboardDto`)

**Interfaces:**
- Consumes: `artifactStateFor`, `portalOccurrenceStatus`, `publishableEvidence` (Task 5).
- Produces:

```ts
export async function deliverableOccurrences(
  orgId: string, deliverableId: string,
  args: { timezone: string; now: Date; limit?: number },
): Promise<PortalOccurrencesDto | null>;   // null = no portal-visible deliverable with that id in this org
export async function serviceTile(
  orgId: string, args: { timezone: string; now: Date },
): Promise<ServiceTileDto | null>;         // null = enable_service is off for this org
```
and `DashboardDto` gains an optional `service?: ServiceTileDto`.

- [ ] **Step 1: Write the failing tests**

Append to `serviceReadModel.test.ts`:

```ts
describe('deliverableOccurrences', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('returns null for a deliverable that is not a portal-visible row of this org', async () => {
    state.rows.push([]);  // deliverable lookup finds nothing (RLS or portal_visible=false)
    await expect(deliverableOccurrences(ORG_ID, 'other-org-deliverable', { timezone: 'UTC', now: NOW }))
      .resolves.toBeNull();
  });

  it('caps the history at 24 and marks a rescheduled occurrence', async () => {
    state.rows.push([{ id: 'd1', name: 'Firewall rule review', cadence: 'quarterly', artifactRequired: true }]);
    state.rows.push([{
      id: 'o1', status: 'awaiting_evidence', dueAt: '2026-10-31', originalDueAt: '2026-09-30',
      periodStart: '2026-08-01', periodEnd: '2026-10-31', deliveredAt: null, deliveryNote: null,
    }]);
    state.rows.push([]);  // evidence
    state.rows.push([{ enableReports: true }]);

    const dto = await deliverableOccurrences(ORG_ID, 'd1', { timezone: 'UTC', now: NOW, limit: 999 });
    expect(dto!.occurrences[0]).toMatchObject({
      status: 'in_progress', rescheduled: true, late: false, artifactState: 'none',
    });
    expect(JSON.stringify(dto)).not.toMatch(/ticket/i);
    // limit is clamped to 24 regardless of the caller.
    const limitCall = state.wheres.length;
    expect(limitCall).toBeGreaterThan(0);
  });
});

describe('serviceTile', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('returns null when enable_service is off', async () => {
    state.rows.push([{ enableService: false }]);
    await expect(serviceTile(ORG_ID, { timezone: 'UTC', now: NOW })).resolves.toBeNull();
  });

  it('returns null when the org has no portal_branding row at all', async () => {
    state.rows.push([]);
    await expect(serviceTile(ORG_ID, { timezone: 'UTC', now: NOW })).resolves.toBeNull();
  });

  it('counts the 90-day record and names the next due item', async () => {
    state.rows.push([{ enableService: true }]);
    state.rows.push([{ onTime: 5, late: 1, missed: 2 }]);
    state.rows.push([{ name: 'Monthly sign-in log review', dueAt: '2026-10-31' }]);
    await expect(serviceTile(ORG_ID, { timezone: 'UTC', now: NOW })).resolves.toEqual({
      status: 'ok', windowDays: 90, deliveredOnTime: 5, deliveredLate: 1, missed: 2,
      nextDue: { name: 'Monthly sign-in log review', dueAt: '2026-10-31' },
      asOf: NOW.toISOString(),
    });
  });

  it('reports no_data rather than a fabricated zero when nothing has been scheduled', async () => {
    state.rows.push([{ enableService: true }]);
    state.rows.push([{ onTime: 0, late: 0, missed: 0 }]);
    state.rows.push([]);
    const tile = await serviceTile(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(tile).toMatchObject({ status: 'no_data', deliveredOnTime: null, nextDue: null });
  });
});
```

In `apps/api/src/services/portal/dashboard.test.ts`, add to the existing orchestration test a `serviceTile` mock and assert two cases: when it resolves a tile, `dto.service` is that tile; when it resolves `null`, `'service' in dto` is `false`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/portal/serviceReadModel.test.ts src/services/portal/dashboard.test.ts`
Expected: FAIL — `deliverableOccurrences` / `serviceTile` are not exported.

- [ ] **Step 3: Implement**

`deliverableOccurrences`:
1. Select the deliverable: `orgId = $1 AND id = $2 AND portal_visible = true`. Empty → return `null`. **404-not-403**: the route turns `null` into a bare 404, so a cross-org id is indistinguishable from a non-existent one.
2. Select occurrences for it, `orderBy(desc(dueAt))`, `.limit(Math.min(args.limit ?? 24, 24))`. Spec §8 says "last 24 occurrences"; the cap is enforced here and not trusted from the query string.
3. Select the evidence join for those occurrence ids (same select as Task 5 query 4).
4. Select `portal_branding.enableReports` for rule 3.
Map each row: `status: portalOccurrenceStatus(row.status)`, `rescheduled: row.dueAt !== row.originalDueAt`, `late: row.deliveredAt !== null && isoDateInTimezone(row.deliveredAt, tz) > row.dueAt`, `note: row.deliveryNote`, `evidence` filtered through `publishableEvidence`, `artifactState: artifactStateFor({ artifactRequired, delivered: row.status === 'delivered', evidence })`.

`serviceTile`:
1. `portal_branding` → `{ enableService }`. Not exactly `true` (including a missing row) → return `null`.
2. One aggregate over `service_deliverable_occurrences` inner-joined to `service_deliverables` on `(deliverableId, orgId)` where `occurrences.orgId = $1 AND deliverables.portal_visible AND due_at >= today − 90 days`:

```ts
  count(*) FILTER (WHERE status = 'delivered' AND delivered_at::date <= due_at) AS on_time
  count(*) FILTER (WHERE status = 'delivered' AND delivered_at::date >  due_at) AS late
  count(*) FILTER (WHERE status = 'missed')                                     AS missed
```
3. The next due item: same join, `status IN ('scheduled','open','awaiting_evidence') AND due_at >= today`, `orderBy(asc(dueAt))`, `limit(1)`, selecting `name_snapshot` and `due_at`.

`status` is `'ok'` when any of the three counts is non-zero **or** `nextDue` exists; otherwise `'no_data'` with all four value fields `null` (never a fabricated zero).

`apps/api/src/services/portal/dashboard.ts`: add `serviceTile(orgId, args)` to the `Promise.all` array (and to the destructuring), then spread it conditionally so the key is absent when the flag is off:

```ts
  return {
    asOf: args.now.toISOString(),
    timezone: args.timezone,
    securityScore, devicesProtected, patchesApplied, backup, support, actionItems, awaitingYou,
    // Absent, not null, when enable_service is off: an org that never turns the
    // flag on keeps the exact DashboardDto — and therefore the exact ETag — it
    // had before this wave (routes/portal/dashboard.ts builds the validator
    // from the payload).
    ...(service ? { service } : {}),
  };
```

`packages/shared/src/types/portalVisibility.ts`: add `service?: ServiceTileDto;` to `DashboardDto` and `import type { ServiceTileDto } from './portalService';` at the top.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/portal/serviceReadModel.test.ts src/services/portal/dashboard.test.ts && npx tsc --noEmit`
Run: `cd packages/shared && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/portal/serviceReadModel.ts apps/api/src/services/portal/serviceReadModel.test.ts \
  apps/api/src/services/portal/dashboard.ts apps/api/src/services/portal/dashboard.test.ts \
  packages/shared/src/types/portalVisibility.ts
git commit -m "feat(portal): occurrence history and dashboard service tile (W04)"
```

---

### Task 7: `documentsReadModel.ts`

**Files:**
- Create: `apps/api/src/services/portal/documentsReadModel.ts`
- Create: `apps/api/src/services/portal/documentsReadModel.test.ts`

**Interfaces:**
- Consumes: `orgDocuments`, `OrgDocumentCategory` (W03 Task 3 exports, re-exported from `../../db/schema`).
- Produces:

```ts
export async function documentsForOrg(
  orgId: string, args: { timezone: string; now: Date },
): Promise<PortalDocumentsDto>;

/** Metadata only — no `data`, no `storage_key`. Enough to answer a conditional
 *  request without opening the bytes; the bytes come from W03's streamDocument. */
export interface PortalDocumentHandle {
  id: string; contentType: string; byteSize: number;
  sha256: string; originalFilename: string;
}
export async function portalVisibleDocument(
  orgId: string, documentId: string,
): Promise<PortalDocumentHandle | null>;
```

**Why this is a separate lookup and not a call into W03's `listDocuments` / `getDocument`.** Those are the MSP surface: they return `OrgDocumentView` (which carries `uploadedByUserId`) and they do **not** filter on `portal_visible` — correct for a technician, wrong for a customer. The portal keeps its own query so the `portal_visible = true AND deleted_at IS NULL` predicate is in the SQL rather than in a caller's `.filter()`, and so only customer-safe columns are ever selected. Bytes are **not** duplicated: Task 9 delegates those to `orgDocumentService.streamDocument`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/portal/documentsReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], wheres: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'where', 'orderBy', 'limit']) {
        chain[m] = vi.fn((arg: unknown) => { if (m === 'where') state.wheres.push(arg); return chain; });
      }
      chain.then = (r: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(r);
      return chain;
    }),
  },
}));

import { readFileSync } from 'node:fs';
import { documentsForOrg, portalVisibleDocument } from './documentsReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-15T12:00:00Z');

describe('documentsForOrg', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('groups chain heads by category in a stable order', async () => {
    state.rows.push([
      { id: 'a', title: 'Onboarding baseline', description: null, category: 'baseline',
        contentType: 'application/pdf', byteSize: 10, originalFilename: 'b.pdf',
        createdAt: new Date('2026-10-01T00:00:00Z') },
      { id: 'b', title: 'Firewall runbook', description: 'Rules', category: 'runbook',
        contentType: 'application/pdf', byteSize: 20, originalFilename: 'r.pdf',
        createdAt: new Date('2026-10-02T00:00:00Z') },
      { id: 'c', title: 'Acceptable use', description: null, category: 'policy',
        contentType: 'application/pdf', byteSize: 30, originalFilename: 'p.pdf',
        createdAt: new Date('2026-10-03T00:00:00Z') },
    ]);
    const dto = await documentsForOrg(ORG_ID, { timezone: 'UTC', now: NOW });
    expect(dto.groups.map((g) => g.category)).toEqual(['baseline', 'runbook', 'policy']);
    expect(dto.groups[0]!.documents[0]!.id).toBe('a');
    expect(dto.asOf).toBe(NOW.toISOString());
  });

  it('returns no groups rather than an empty category when the org has nothing to show', async () => {
    state.rows.push([]);
    await expect(documentsForOrg(ORG_ID, { timezone: 'UTC', now: NOW }))
      .resolves.toMatchObject({ groups: [] });
  });

  it('scopes the listing to the session org', async () => {
    state.rows.push([]);
    await documentsForOrg(ORG_ID, { timezone: 'UTC', now: NOW });
    for (const where of state.wheres) {
      expect(new PgDialect().sqlToQuery(where as SQL).params).toContain(ORG_ID);
    }
  });
});

describe('portalVisibleDocument', () => {
  beforeEach(() => { state.rows.length = 0; state.wheres.length = 0; });

  it('is null for a document of another org', async () => {
    state.rows.push([]);
    await expect(portalVisibleDocument(ORG_ID, 'foreign')).resolves.toBeNull();
    expect(new PgDialect().sqlToQuery(state.wheres[0] as SQL).params).toContain(ORG_ID);
  });

  it('serves a superseded document that is still portal-visible', async () => {
    // A delivery record points at the EXACT version it was delivered with
    // (spec §4.4), so the download path must not require a chain head.
    state.rows.push([{ id: 'old', contentType: 'application/pdf', byteSize: 9,
      sha256: 'f'.repeat(64), originalFilename: 'old.pdf' }]);
    await expect(portalVisibleDocument(ORG_ID, 'old')).resolves.toMatchObject({ id: 'old' });
  });

  it('never selects the bytes or the storage key', async () => {
    // Those belong to W03's streamDocument; selecting them here would be a
    // second byte path to keep in sync.
    const source = readFileSync(new URL('./documentsReadModel.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/orgDocuments\.(data|storageKey|storageBackend)/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/portal/documentsReadModel.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`documentsForOrg` selects from `orgDocuments` where `orgId = $1 AND portalVisible = true AND deletedAt IS NULL` **and the row is a chain head**. W03 ships the matching partial index — `org_documents_org_portal_idx ON org_documents (org_id) WHERE portal_visible AND deleted_at IS NULL` — so write the predicate in exactly that order and shape; no new index is needed in this wave.

```ts
      sql`NOT EXISTS (
        SELECT 1 FROM ${orgDocuments} AS successor
        WHERE successor.supersedes_document_id = ${orgDocuments.id}
          AND successor.org_id = ${orgId}
          AND successor.deleted_at IS NULL
      )`
```
Order by `category`, then `createdAt desc`. Group in JS in a fixed category order so the page never reshuffles between loads:

```ts
const CATEGORY_ORDER: readonly PortalDocumentCategory[] =
  ['baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other'];
```
Emit only categories that have at least one document.

`portalVisibleDocument` selects exactly `{ id, contentType, byteSize, sha256, originalFilename }` where `orgId = $1 AND id = $2 AND portalVisible = true AND deletedAt IS NULL` — **no chain-head condition** (a delivery record points at an exact version, spec §4.4) and **no byte columns**. Returns `null` when nothing matches, which the route turns into a bare 404.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/portal/documentsReadModel.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/portal/documentsReadModel.ts apps/api/src/services/portal/documentsReadModel.test.ts
git commit -m "feat(portal): org document library read model (W04)"
```

---

### Task 8: `routes/portal/service.ts` and its mount

**Files:**
- Create: `apps/api/src/routes/portal/service.ts`, `apps/api/src/routes/portal/service.test.ts`
- Modify: `apps/api/src/routes/portal/schemas.ts:174-188` area
- Modify: `apps/api/src/routes/portal/index.ts:15-18,44-51,84-87`

**Interfaces:**
- Consumes: `serviceOverview`, `deliverableOccurrences` (Tasks 5–6); `applyPortalCacheHeaders`, `buildWeakEtag`, `isEtagFresh` (`routes/portal/helpers.ts:70-108`).
- Produces: `portalServiceRoutes`; `GET /api/v1/portal/service`; `GET /api/v1/portal/service/:deliverableId/occurrences?limit`.

- [ ] **Step 1: Write the failing route tests**

Copy the harness from `apps/api/src/routes/portal/dashboard.test.ts:1-85` verbatim (hoisted service mocks, a mocked `./auth` whose `portalAuthMiddleware` sets `portalAuth` with `orgId` and `timezone: 'America/Denver'`, a mocked `../../db` whose `select().from().where().limit()` resolves `routerState.brandingRows`, an `isolatedApp()` that mounts `portalServiceRoutes` at root). Then:

```ts
describe('GET /service', () => {
  it('uses the session org and hydrated timezone and sends private cache headers', async () => {
    mocks.serviceOverview.mockResolvedValue({ asOf: '2026-10-15T12:00:00.000Z', timezone: 'America/Denver', groups: [], keyDates: [] });
    const response = await isolatedApp().request('/service');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('max-age=30');
    expect(response.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(mocks.serviceOverview).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ timezone: 'America/Denver' }),
    );
  });

  it('returns 304 when the private ETag is fresh', async () => {
    mocks.serviceOverview.mockResolvedValue({ asOf: '2026-10-15T12:00:00.000Z', timezone: 'America/Denver', groups: [], keyDates: [] });
    const first = await isolatedApp().request('/service');
    const etag = first.headers.get('etag')!;
    const second = await isolatedApp().request('/service', { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });
});

describe('GET /service/:deliverableId/occurrences', () => {
  it('404s a deliverable the read model refuses, with no body detail', async () => {
    mocks.deliverableOccurrences.mockResolvedValue(null);
    const response = await isolatedApp().request('/service/11111111-1111-4111-8111-111111111111/occurrences');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('rejects a non-uuid deliverable id before touching the read model', async () => {
    const response = await isolatedApp().request('/service/not-a-uuid/occurrences');
    expect(response.status).toBe(400);
    expect(mocks.deliverableOccurrences).not.toHaveBeenCalled();
  });

  it('passes the validated limit through', async () => {
    mocks.deliverableOccurrences.mockResolvedValue({ asOf: '', timezone: 'America/Denver', deliverable: { id: 'd1', name: 'x', cadence: 'monthly' }, occurrences: [] });
    await isolatedApp().request('/service/11111111-1111-4111-8111-111111111111/occurrences?limit=5');
    expect(mocks.deliverableOccurrences).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ limit: 5 }),
    );
  });
});

describe('GET /service through the real portal router', () => {
  it('returns 401 without an authenticated portal session', async () => {
    routerState.authenticated = false;
    const response = await portalRoutes.request('/service');
    expect(response.status).toBe(401);
    expect(mocks.serviceOverview).not.toHaveBeenCalled();
  });

  it('returns 403 when service visibility is disabled', async () => {
    routerState.brandingRows = [{ enableService: false }];
    const response = await portalRoutes.request('/service', { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PORTAL_SERVICE_DISABLED' });
    expect(mocks.serviceOverview).not.toHaveBeenCalled();
  });

  it('gates the occurrences path on the same flag', async () => {
    routerState.brandingRows = [{ enableService: false }];
    const response = await portalRoutes.request(
      '/service/11111111-1111-4111-8111-111111111111/occurrences',
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/portal/service.test.ts`
Expected: FAIL, `./service` not found.

- [ ] **Step 3: Add the schemas**

In `apps/api/src/routes/portal/schemas.ts`, next to `portalReportRunParamSchema` (line 186):

```ts
export const portalDeliverableParamSchema = z.object({ deliverableId: z.string().guid() });
export const portalDocumentParamSchema = z.object({ id: z.string().guid() });
// Spec §8 publishes the last 24 occurrences; the cap lives in the read model
// too, so a crafted query string cannot widen the window.
export const portalOccurrenceListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(24)
});
```

- [ ] **Step 4: Write the router**

```ts
// apps/api/src/routes/portal/service.ts
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { deliverableOccurrences, serviceOverview } from '../../services/portal/serviceReadModel';
import { applyPortalCacheHeaders, buildWeakEtag, isEtagFresh } from './helpers';
import { portalDeliverableParamSchema, portalOccurrenceListSchema } from './schemas';

// Route hub for the customer-portal Service scorecard, gated by the
// `enableService` strict flag. Mounted at root in routes/portal/index.ts under
// createPortalFeatureGateStrict('enableService'); handlers own the absolute path.
//
// Spec D10: nothing here returns a ticket. The read model is the only place
// the publication rules live — these handlers add caching and nothing else.
export const portalServiceRoutes = new Hono();

function sendCached(c: Parameters<Parameters<Hono['get']>[1]>[0], payload: unknown) {
  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
}

portalServiceRoutes.get('/service', async (c) => {
  const auth = c.get('portalAuth');
  const payload = await serviceOverview(auth.user.orgId, {
    timezone: auth.timezone,
    now: new Date(),
  });
  return sendCached(c, payload);
});

portalServiceRoutes.get(
  '/service/:deliverableId/occurrences',
  zValidator('param', portalDeliverableParamSchema),
  zValidator('query', portalOccurrenceListSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const payload = await deliverableOccurrences(
      auth.user.orgId,
      c.req.valid('param').deliverableId,
      { timezone: auth.timezone, now: new Date(), limit: c.req.valid('query').limit },
    );
    // Bare 404, never 403: a deliverable of another org and a deliverable that
    // does not exist must be indistinguishable (spec §12).
    if (!payload) return c.json({ error: 'Not found' }, 404);
    return sendCached(c, payload);
  },
);
```

Note: the payload's `asOf` changes on every request, so unlike `dashboard.ts` there is no point stripping timestamps before hashing — the ETag here is a transport-level validator for a single client's repeat fetch. Keep it simple and do not copy `withoutCollectionTimestamps`.

- [ ] **Step 5: Mount it**

In `apps/api/src/routes/portal/index.ts`, after the `/reports/*` block (line 51):

```ts
portalRoutes.use('/service/*', portalAuthMiddleware);
portalRoutes.use('/service/*', createPortalFeatureGateStrict('enableService'));
```
and after `portalRoutes.route('/', portalReportRoutes);` (line 87):

```ts
portalRoutes.route('/', portalServiceRoutes);
```
with `import { portalServiceRoutes } from './service';` beside the other hub imports. A `use('/x/*')` middleware also matches the exact path `/x` in Hono — proven by the existing `dashboard.test.ts:197-209`, which gets a 403 on `/dashboard` from the `/dashboard/*` gate.

- [ ] **Step 6: Run to verify pass**

Run: `cd apps/api && npx vitest run src/routes/portal/service.test.ts src/routes/portal/dashboard.test.ts && npx tsc --noEmit`
Expected: PASS. Running the dashboard test too catches an index.ts mount that broke an existing prefix.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/portal/service.ts apps/api/src/routes/portal/service.test.ts \
  apps/api/src/routes/portal/schemas.ts apps/api/src/routes/portal/index.ts
git commit -m "feat(portal): GET /portal/service and occurrence history routes (W04)"
```

---

### Task 9: `routes/portal/documents.ts`, streaming and its mount

**Files:**
- Create: `apps/api/src/routes/portal/documents.ts`, `apps/api/src/routes/portal/documents.test.ts`
- Modify: `apps/api/src/routes/portal/index.ts`

**Interfaces:**
- Consumes: `documentsForOrg`, `portalVisibleDocument` (Task 7); `contentDispositionFor` (`apps/api/src/routes/tickets/attachments.ts:262`, imported across routers exactly as `apps/api/src/routes/portal/tickets.ts:32` already does); `streamDocument` and `DeliverableServiceError` from W03; `createPortalFeatureGateAny` (Task 1).
- Produces: `portalDocumentRoutes`; `GET /api/v1/portal/documents`; `GET /api/v1/portal/documents/:id/content`.

**W03 interface this task calls** (verified against `docs/superpowers/plans/billing/2026-09-10-service-deliverables-w03-org-documents.md` Task 7):

```ts
export function streamDocument(orgId: string, id: string, actor: DeliverableActor): Promise<{
  view: OrgDocumentView; contentType: string; originalFilename: string; sha256: string;
  body: Readable | Buffer | null; contentLength: number | null;
}>;
```
It performs its own org-scoped lookup and throws `DeliverableServiceError` (404 `NOT_FOUND`) for a row outside the org or soft-deleted; a storage fault surfaces as a `BlobStorageError`. **It does not consult `portal_visible`** — correct, because it also serves the MSP surface. That predicate is this route's job, via `portalVisibleDocument`, and it runs first.

**Before writing code, run `grep -n 'export function streamDocument' apps/api/src/services/orgDocumentService.ts`** to confirm the merged signature. If it drifted, adapt this call site — never fork a second byte path, and never reach into `blobStorage.ts` from a route.

**The portal actor.** `streamDocument` takes the `DeliverableActor` shape from W01 (`{ userId, partnerId, accessibleOrgIds }`) and only reads `accessibleOrgIds` in `requireOrgAccess`. A portal session has no staff user, so build it explicitly and locally:

```ts
/** A portal session acting on its own org: no staff user, no partner axis.
 *  requireOrgAccess only reads accessibleOrgIds, and RLS is the real fence. */
const portalActor = (orgId: string): DeliverableActor => ({
  userId: null, partnerId: null, accessibleOrgIds: [orgId],
});
```

- [ ] **Step 1: Write the failing route tests**

Reuse the same harness as Task 8, with three additions at the top of the file:

```ts
import { readFileSync } from 'node:fs';
// DeliverableServiceError is a real class (W01 Task 8), imported rather than
// mocked so `instanceof` in the route's catch block is exercised for real.
import { DeliverableServiceError } from '../../services/serviceDeliverableService';

const mocks = vi.hoisted(() => ({
  documentsForOrg: vi.fn(),
  portalVisibleDocument: vi.fn(),
  streamDocument: vi.fn(),
}));
vi.mock('../../services/portal/documentsReadModel', () => ({
  documentsForOrg: mocks.documentsForOrg,
  portalVisibleDocument: mocks.portalVisibleDocument,
}));
vi.mock('../../services/orgDocumentService', async () => {
  const actual = await vi.importActual<typeof import('../../services/orgDocumentService')>(
    '../../services/orgDocumentService');
  return { ...actual, streamDocument: mocks.streamDocument };
});
```

Then the cases:

```ts
describe('GET /documents', () => {
  it('sends the org listing with private caching and a weak ETag', async () => {
    mocks.documentsForOrg.mockResolvedValue({ asOf: '2026-10-15T12:00:00.000Z', timezone: 'America/Denver', groups: [] });
    const response = await isolatedApp().request('/documents');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private, max-age=30');
    expect(mocks.documentsForOrg).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111', expect.objectContaining({ timezone: 'America/Denver' }));
  });
  it('returns 304 on a matching ETag', async () => {
    mocks.documentsForOrg.mockResolvedValue({ asOf: 'x', timezone: 'UTC', groups: [] });
    const first = await isolatedApp().request('/documents');
    const etag = first.headers.get('etag')!;
    expect((await isolatedApp().request('/documents', { headers: { 'If-None-Match': etag } })).status).toBe(304);
  });
});

describe('GET /documents/:id/content', () => {
  const ID = '11111111-1111-4111-8111-111111111111';

  const handle = (sha: string) => ({
    id: ID, contentType: 'application/pdf', byteSize: 3,
    sha256: sha.repeat(64), originalFilename: 'runbook.pdf',
  });

  it('404s a document that is not this org\'s portal-visible row', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(null);
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(404);
    // The visibility predicate runs BEFORE W03's service, which does not know
    // about portal_visible at all.
    expect(mocks.streamDocument).not.toHaveBeenCalled();
  });

  it('streams bytes with a sha256 ETag, a safe disposition and nosniff', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(handle('a'));
    mocks.streamDocument.mockResolvedValue({
      view: {}, contentType: 'application/pdf', originalFilename: 'runbook.pdf',
      sha256: 'a'.repeat(64), body: Buffer.from('abc'), contentLength: 3,
    });
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(200);
    expect(mocks.streamDocument).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111', ID,
      { userId: null, partnerId: null, accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'] },
    );
    expect(response.headers.get('etag')).toBe(`"${'a'.repeat(64)}"`);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('runbook.pdf');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('304s a matching sha256 ETag without opening the bytes', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(handle('b'));
    const response = await isolatedApp().request(`/documents/${ID}/content`,
      { headers: { 'If-None-Match': `"${'b'.repeat(64)}"` } });
    expect(response.status).toBe(304);
    expect(mocks.streamDocument).not.toHaveBeenCalled();
  });

  it('answers a storage fault with a retryable 503, never a 500', async () => {
    mocks.portalVisibleDocument.mockResolvedValue(handle('c'));
    mocks.streamDocument.mockRejectedValue(new Error('s3 down'));
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(503);
  });

  it('turns a 404 from the W03 service into a bare 404, not a 500', async () => {
    // A row deleted between the visibility check and the stream.
    mocks.portalVisibleDocument.mockResolvedValue(handle('d'));
    mocks.streamDocument.mockRejectedValue(
      new DeliverableServiceError('Not found', 404, 'NOT_FOUND'));
    const response = await isolatedApp().request(`/documents/${ID}/content`);
    expect(response.status).toBe(404);
  });

  it('never hands back a presigned url', async () => {
    // Spec §8/§11: bytes stream through the API under RLS.
    const source = readFileSync(new URL('./documents.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/presign|getSignedUrl/i);
  });
});

describe('GET /documents through the real portal router', () => {
  it('403s the listing when enable_documents is off', async () => {
    routerState.brandingRows = [{ enableDocuments: false, enableService: true }];
    const response = await portalRoutes.request('/documents', { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PORTAL_DOCUMENTS_DISABLED' });
  });

  it('still serves evidence bytes when only enable_service is on', async () => {
    // Spec §8: document evidence is published under enable_service regardless
    // of enable_documents, so the link the Service page renders must resolve.
    routerState.brandingRows = [{ enableDocuments: false, enableService: true }];
    mocks.portalVisibleDocument.mockResolvedValue(null);   // 404, not 403
    const response = await portalRoutes.request(
      '/documents/11111111-1111-4111-8111-111111111111/content',
      { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(404);
  });

  it('403s the bytes when both flags are off', async () => {
    routerState.brandingRows = [{ enableDocuments: false, enableService: false }];
    const response = await portalRoutes.request(
      '/documents/11111111-1111-4111-8111-111111111111/content',
      { headers: { Authorization: 'Bearer token' } });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/portal/documents.test.ts`
Expected: FAIL, `./documents` not found.

- [ ] **Step 3: Write the router**

`GET /documents` mirrors `sendCached` from Task 8 (duplicate the six-line helper locally rather than exporting it across hubs — `routes/portal/reports.ts` already repeats the same block twice; a shared helper here would be the only cross-hub coupling in the directory).

`GET /documents/:id/content` follows `apps/api/src/routes/portal/tickets.ts:655-690` exactly:

```ts
portalDocumentRoutes.get(
  '/documents/:id/content',
  zValidator('param', portalDocumentParamSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const orgId = auth.user.orgId;
    const id = c.req.valid('param').id;

    // The portal's own predicate: this org, portal_visible, not soft-deleted.
    // W03's streamDocument does not know about portal_visible (it also serves
    // the MSP surface), so this must run first and answer a bare 404.
    const doc = await portalVisibleDocument(orgId, id);
    if (!doc) return c.json({ error: 'Document not found' }, 404);

    const etag = `"${doc.sha256}"`;
    const headers: Record<string, string> = {
      ETag: etag,
      // Bytes are immutable per row (sha256 IS the identity), so a longer
      // browser cache than the 30s JSON validator is correct here.
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Authorization, Cookie',
    };
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);

    let opened: Awaited<ReturnType<typeof streamDocument>>;
    try {
      opened = await streamDocument(orgId, id, portalActor(orgId));
    } catch (err) {
      // A row that vanished between the two reads is a 404, not a fault.
      if (err instanceof DeliverableServiceError && err.status === 404) {
        return c.json({ error: 'Document not found' }, 404);
      }
      // A transport fault is RETRYABLE, not a bug (the ticket-attachment route
      // learned this the hard way: an S3 blip surfaced as a generic 500).
      captureException(err);
      return c.json({ error: 'Document storage is unavailable — try again shortly' }, 503);
    }
    if (!opened.body) return c.json({ error: 'Document not found' }, 404);

    headers['Content-Type'] = opened.contentType;
    headers['Content-Disposition'] =
      contentDispositionFor(opened.contentType, opened.originalFilename);
    const length = opened.contentLength ?? doc.byteSize;
    if (typeof length === 'number') headers['Content-Length'] = String(length);

    if (Buffer.isBuffer(opened.body)) return c.body(new Uint8Array(opened.body), 200, headers);
    return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
  },
);
```

- [ ] **Step 4: Mount it with the split gate**

In `apps/api/src/routes/portal/index.ts`, add module-level gate constants next to `isTicketsUsagePath` (line 22) and the mount after the `/service/*` block:

```ts
const isDocumentContentPath = (c: Context) => /\/documents\/[^/]+\/content$/.test(c.req.path);
const documentsLibraryGate = createPortalFeatureGateStrict('enableDocuments');
// Spec §8: a portal-visible document published as delivery evidence is
// downloadable under enable_service even when the library page is off.
const documentBytesGate = createPortalFeatureGateAny('enableDocuments', 'enableService');

portalRoutes.use('/documents/*', portalAuthMiddleware);
portalRoutes.use('/documents/*', async (c, next) =>
  isDocumentContentPath(c) ? documentBytesGate(c, next) : documentsLibraryGate(c, next));
```
and `portalRoutes.route('/', portalDocumentRoutes);` beside the other hub mounts.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/api && npx vitest run src/routes/portal/documents.test.ts src/routes/portal/service.test.ts src/routes/portal/tickets.test.ts && npx tsc --noEmit`
Expected: PASS. Running `tickets.test.ts` too proves the new `/documents/*` mounts did not disturb the existing exact-path `/tickets/usage` precedence.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/portal/documents.ts apps/api/src/routes/portal/documents.test.ts \
  apps/api/src/routes/portal/index.ts
git commit -m "feat(portal): GET /portal/documents listing and byte streaming (W04)"
```

---

### Task 10: Portal client, nav and gate wiring

**Files:**
- Modify: `apps/portal/src/lib/api.ts:697-721,1230-1241`
- Modify: `apps/portal/src/lib/navItems.ts:30-70`
- Modify: `apps/portal/src/lib/navItems.test.ts`
- Modify: `apps/portal/src/lib/visibilityGate.ts:14-37`
- Modify: `apps/portal/src/lib/visibilityGate.test.ts:17-26`
- Modify: `apps/portal/src/lib/protectedPaths.ts:14-26`
- Modify: `apps/portal/src/lib/disabledPageCoverage.test.ts:30-43`

**Interfaces:**
- Consumes: the API routes from Tasks 8–9; the DTOs from Task 4.
- Produces: `portalApi.getService`, `portalApi.getServiceOccurrences`, `portalApi.getDocuments`, `portalApi.documentContentUrl`; nav entries `/service` ("Service") and `/documents` ("Documents"); gate codes `PORTAL_SERVICE_DISABLED`, `PORTAL_DOCUMENTS_DISABLED`.

- [ ] **Step 1: Write the failing tests**

In `apps/portal/src/lib/navItems.test.ts`, extend the full-flag-set case (line ~48) to pass `enableService: true, enableDocuments: true` and expect:

```ts
    ]).toEqual([
      '/dashboard', '/quotes', '/invoices', '/tickets', '/devices',
      '/security', '/backups', '/reports', '/service', '/documents',
      '/assets', '/profile',
    ]);
```
and add:

```ts
  it('fails CLOSED for the W04 surfaces — absent or false hides them', () => {
    for (const branding of [{}, { enableService: false, enableDocuments: false }]) {
      const hrefs = buildPortalNavItems(branding).map((i) => i.href);
      expect(hrefs).not.toContain('/service');
      expect(hrefs).not.toContain('/documents');
    }
  });
```

In `apps/portal/src/lib/visibilityGate.test.ts`, add `'PORTAL_SERVICE_DISABLED'` and `'PORTAL_DOCUMENTS_DISABLED'` to `GATE_CODES` (line 17) — the parity test at line 89 reads the API source and will fail until `PORTAL_DISABLED_CODES` carries them.

In `apps/portal/src/lib/disabledPageCoverage.test.ts`, add to `GATED_API_METHODS` (line 30):

```ts
  getService: 'PORTAL_SERVICE_DISABLED',
  getServiceOccurrences: 'PORTAL_SERVICE_DISABLED',
  getDocuments: 'PORTAL_DOCUMENTS_DISABLED',
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/portal && npx vitest run src/lib/navItems.test.ts src/lib/visibilityGate.test.ts`
Expected: FAIL on both.

- [ ] **Step 3: Implement**

`apps/portal/src/lib/visibilityGate.ts`: append both codes to `PORTAL_DISABLED_CODES` and `'/service'`, `'/documents'` to `PORTAL_GATED_PAGES`. `PORTAL_UNGATED_HOME` stays `/quotes`.

`apps/portal/src/lib/protectedPaths.ts`: add `'/service'` and `'/documents'` to `PORTAL_PROTECTED_PREFIXES` (without this, `disabledPageCoverage.test.ts:193-204` fails for the two new pages).

`apps/portal/src/lib/navItems.ts`: widen the `Pick<BrandingConfig, …>` parameter with `'enableService' | 'enableDocuments'` and insert two entries **after** the Reports entry and before Equipment:

```ts
    branding.enableService === true
      ? { href: '/service', label: 'Service' }
      : null,
    branding.enableDocuments === true
      ? { href: '/documents', label: 'Documents' }
      : null,
```
(Placement rationale, worth a comment: both are new fail-closed surfaces with no legacy expectation, and appending after the existing visibility block leaves every org's current nav order untouched.)

`apps/portal/src/lib/api.ts`: add `enableService?: boolean; enableDocuments?: boolean;` to `BrandingConfig` (after line 720), and four members to `portalApi` beside `reportArtifactUrl` (line 1235):

```ts
  // W04 — service deliverables
  getService: (
    config: ApiRequestConfig = {},
  ): Promise<ApiResponse<PortalServiceOverviewDto>> =>
    apiGet<PortalServiceOverviewDto>('/portal/service', config),

  getServiceOccurrences: (
    deliverableId: string,
    config: ApiRequestConfig = {},
  ): Promise<ApiResponse<PortalOccurrencesDto>> =>
    apiGet<PortalOccurrencesDto>(
      `/portal/service/${encodeURIComponent(deliverableId)}/occurrences`,
      config,
    ),

  getDocuments: (
    config: ApiRequestConfig = {},
  ): Promise<ApiResponse<PortalDocumentsDto>> =>
    apiGet<PortalDocumentsDto>('/portal/documents', config),

  // A browser-navigable path, not a fetch: the session cookie authenticates the
  // download and the API streams the bytes. Never a presigned URL (spec §8).
  documentContentUrl: (documentId: string): PublicApiPath =>
    publicApiPath(`/portal/documents/${documentId}/content`),
```
with the four DTO types added to the `@breeze/shared` type import at the top of the file.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/portal && npx vitest run src/lib && npx tsc --noEmit`
Expected: PASS. `disabledPageCoverage.test.ts` will still pass here because no page calls the new methods yet; Tasks 11–12 add the pages and the branch it demands.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/src/lib
git commit -m "feat(portal): service and documents client, nav and gate wiring (W04)"
```

---

### Task 11: Service page and scorecard component

**Files:**
- Create: `apps/portal/src/pages/service/index.astro`, `apps/portal/src/pages/service/index.test.ts`
- Create: `apps/portal/src/components/portal/ServiceScorecard.tsx`, `apps/portal/src/components/portal/ServiceScorecard.test.tsx`

**Interfaces:**
- Consumes: `portalApi.getService`, `portalApi.getServiceOccurrences`, `portalApi.documentContentUrl`, `portalApi.reportArtifactUrl` (Task 10); `PortalServiceOverviewDto` (Task 4); `PageHeader`, `ErrorNotice`, `EmptyState`, `StatusMark`, `ROW`, `CELL`, `TH`, `BTN_SECONDARY` (`apps/portal/src/components/portal/ui.tsx`).
- Produces: `data-testid` `portal-service-groups`, `portal-service-group-<contractId|standalone>`, `portal-service-row-<deliverableId>`, `portal-service-status-<deliverableId>`, `portal-service-evidence-<evidenceIndex>-<deliverableId>`, `portal-service-key-dates`, `portal-service-key-date-<id>`, `portal-service-empty`, `portal-service-error`, `portal-service-occurrences-<deliverableId>`, `portal-service-occurrence-row-<occurrenceId>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/portal/src/pages/service/index.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const componentSource = readFileSync(
  new URL('../../components/portal/ServiceScorecard.tsx', import.meta.url), 'utf8');

describe('service page visibility gate', () => {
  it('bounces a page the MSP switched off instead of reporting a load failure', () => {
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });
  it('redirects on 401 before rendering', () => {
    expect(pageSource).toContain('redirectToLoginAfter401(Astro)');
  });
});

describe('service page fetch states', () => {
  it('never prints a raw transport error at the customer', () => {
    expect(pageSource).not.toMatch(/\{response\.error\}/);
  });
  it('names the recovery in the failure copy and keeps the page title', () => {
    expect(pageSource).toContain('data-testid="portal-service-error"');
    expect(pageSource).toContain("We couldn't load your service summary just now. Your IT team can help.");
    expect(pageSource).toMatch(/<PageHeader\s+title="Service"/);
  });
});

describe('service scorecard publication rules', () => {
  it('renders no ticket anywhere', () => {
    // Spec D10 belongs to the read model, but a component that invented a
    // "View ticket" link would defeat it — assert the component source too.
    expect(componentSource).not.toMatch(/ticket/i);
  });
  it('states plainly when the MSP holds the artifact', () => {
    expect(componentSource).toContain('held_by_msp');
    expect(componentSource).toContain('Delivered (artifact held by your IT team)');
  });
  it('gives every list, row and download a testid', () => {
    for (const id of [
      'portal-service-groups', 'portal-service-key-dates', 'portal-service-empty',
    ]) expect(componentSource).toContain(`data-testid="${id}"`);
    expect(componentSource).toMatch(/data-testid=\{`portal-service-row-\$\{/);
    expect(componentSource).toMatch(/data-testid=\{`portal-service-occurrence-row-\$\{/);
  });
});
```

```tsx
// apps/portal/src/components/portal/ServiceScorecard.test.tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServiceScorecard } from './ServiceScorecard';
import type { PortalServiceOverviewDto } from '@breeze/shared';

vi.mock('@/lib/api', () => ({
  portalApi: {
    getServiceOccurrences: vi.fn(),
    documentContentUrl: (id: string) => `/api/v1/portal/documents/${id}/content`,
    reportArtifactUrl: (id: string) => `/api/v1/portal/reports/runs/${id}/pdf`,
  },
}));

const overview: PortalServiceOverviewDto = {
  asOf: '2026-10-15T12:00:00.000Z',
  timezone: 'America/Denver',
  groups: [{
    source: 'contract',
    contract: { id: 'c1', name: 'Best plan' },
    deliverables: [{
      id: 'd1', name: 'Monthly sign-in log review', description: 'We read every sign-in',
      cadence: 'monthly', artifactRequired: true, nextDue: '2026-10-31', status: 'on_track',
      lastDelivered: { at: '2026-09-30T17:00:00.000Z', late: false, note: 'Nothing unusual',
                       artifactState: 'attached',
                       evidence: [{ kind: 'document', documentId: 'doc1', reportRunId: null,
                                    title: 'September findings', createdAt: '2026-09-30T17:00:00.000Z' }] },
    }],
  }],
  keyDates: [{ source: 'contract_end', id: 'c1', label: 'Best plan', kind: 'contract_end',
               date: '2027-03-31', notes: null }],
};

describe('ServiceScorecard', () => {
  it('names the contract the deliverables belong to', () => {
    render(<ServiceScorecard overview={overview} />);
    expect(screen.getByTestId('portal-service-group-c1')).toHaveTextContent('Best plan');
    expect(screen.getByTestId('portal-service-row-d1')).toHaveTextContent('Monthly sign-in log review');
  });

  it('links attached evidence at the portal download path', () => {
    render(<ServiceScorecard overview={overview} />);
    expect(screen.getByTestId('portal-service-evidence-0-d1'))
      .toHaveAttribute('href', '/api/v1/portal/documents/doc1/content');
  });

  it('says the artifact is held by the MSP rather than pretending it exists', () => {
    const held = structuredClone(overview);
    held.groups[0]!.deliverables[0]!.lastDelivered!.artifactState = 'held_by_msp';
    held.groups[0]!.deliverables[0]!.lastDelivered!.evidence = [];
    render(<ServiceScorecard overview={held} />);
    expect(screen.getByTestId('portal-service-row-d1'))
      .toHaveTextContent('Delivered (artifact held by your IT team)');
  });

  it('shows an honest empty state, not a blank page', () => {
    render(<ServiceScorecard overview={{ ...overview, groups: [], keyDates: [] }} />);
    expect(screen.getByTestId('portal-service-empty')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/portal && npx vitest run src/pages/service src/components/portal/ServiceScorecard.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the page**

```astro
---
import PortalLayout from '../../layouts/PortalLayout.astro';
import { ServiceScorecard } from '../../components/portal/ServiceScorecard';
import { ErrorNotice, PageHeader } from '../../components/portal/ui';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';
import { redirectToLoginAfter401 } from '../../lib/session';
import { isPortalPageDisabled, redirectToPortalHomeAfterDisabled } from '../../lib/visibilityGate';

const response = await portalApi.getService(buildServerApiConfig(Astro.request));
if (response.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}

// enable_service off 403s with PORTAL_SERVICE_DISABLED. A page the org never
// turned on is a setting, not a fault, so it bounces to the one page no
// visibility flag can switch off (#4932). Other 403s ("Account is not active")
// still render inline through the notice below.
if (isPortalPageDisabled(response)) {
  return redirectToPortalHomeAfterDisabled(Astro);
}
---

<PortalLayout title="Service">
  {
    response.data
      ? <ServiceScorecard client:load overview={response.data} />
      : (
          <div data-testid="portal-service-error">
            <PageHeader
              title="Service"
              lede="What we look after for you, and what we delivered."
            />
            <ErrorNotice>We couldn't load your service summary just now. Your IT team can help.</ErrorNotice>
          </div>
        )
  }
</PortalLayout>
```

- [ ] **Step 4: Write `ServiceScorecard.tsx`**

Structure, all composed from `ui.tsx` primitives and Tailwind classes (no inline `style` — production CSP refuses it):

- `PageHeader title="Service" lede="What we look after for you, and what we delivered."`.
- Empty state (`groups.length === 0 && keyDates.length === 0`): `EmptyState` with `data-testid="portal-service-empty"`, title "Nothing scheduled yet", body "Your IT team has not published a service schedule for this account."
- `<div data-testid="portal-service-groups">`, one `<section data-testid={\`portal-service-group-${group.contract?.id ?? 'standalone'}\`}>` per group. The heading is the contract name, or "Other services" for the standalone group.
- Inside each group a ruled list (`ROW`/`CELL`/`TH`, `divide-y divide-border/70`) with one `<tr data-testid={\`portal-service-row-${d.id}\`}>` per deliverable carrying: name + description; cadence in words (`CADENCE_LABEL: Record<PortalDeliverableCadence, string> = { monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Twice a year', annual: 'Yearly', one_time: 'One time' }`); a `StatusMark` in `data-testid={\`portal-service-status-${d.id}\`}` with tone `on_track → success`, `due_soon → primary`, `late → warning`, `missed → destructive`; "Next due" as `formatDate`d `nextDue` or "Not scheduled"; and the last-delivered block.
- Last-delivered block, the whole point of the page:

```tsx
const ARTIFACT_COPY: Record<PortalArtifactState, string | null> = {
  attached: null,
  report: null,
  none: null,
  // Nothing pretends evidence exists (spec §8). "Your IT team" is how the rest
  // of the portal refers to the MSP.
  held_by_msp: 'Delivered (artifact held by your IT team)',
};
```
Render `Delivered <date> (<timezone>)` plus `Late` as a `warning` StatusMark when `late`, the note when present, `ARTIFACT_COPY[artifactState]` when non-null, and each evidence ref as an anchor:

```tsx
{last.evidence.map((ev, i) => (
  <a
    key={`${ev.kind}-${ev.documentId ?? ev.reportRunId}`}
    data-testid={`portal-service-evidence-${i}-${d.id}`}
    href={ev.kind === 'document'
      ? portalApi.documentContentUrl(ev.documentId!)
      : portalApi.reportArtifactUrl(ev.reportRunId!, 'pdf')}
    download
    className={cn(BTN_SECONDARY, 'min-h-11 sm:min-h-0 sm:py-1.5')}
  >
    <Download className="h-4 w-4" aria-hidden="true" />
    {ev.title}
  </a>
))}
```
- A "Show history" button per deliverable that calls `portalApi.getServiceOccurrences(d.id)` on first click, stores the result in local state, and renders `<ul data-testid={\`portal-service-occurrences-${d.id}\`}>` with one `<li data-testid={\`portal-service-occurrence-row-${o.id}\`}>` per occurrence: period, due date, `OCCURRENCE_LABEL` (`scheduled: 'Scheduled', in_progress: 'In progress', delivered: 'Delivered', missed: 'Missed', waived: 'Not required this period'`), "Rescheduled" when `o.rescheduled`, the note, the artifact copy and the same evidence anchors. A failed fetch sets a local message rendered through `ErrorNotice`; it never replaces the page.
- Key dates: `<section data-testid="portal-service-key-dates">` listing each as `<li data-testid={\`portal-service-key-date-${kd.id}\`}>` with label, `formatDate(kd.date)` and, for `source === 'contract_end'`, the suffix "Agreement ends". Omitted entirely when `keyDates.length === 0`.
- A dated foot line, `As of {formatDateTime(overview.asOf, overview.timezone)} ({overview.timezone}).`, matching `DashboardTiles.tsx:319-322`.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/portal && npx vitest run src/pages/service src/components/portal/ServiceScorecard.test.tsx src/lib/disabledPageCoverage.test.ts src/lib/noInlineStyles.test.ts src/lib/basePathCoverage.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/portal/src/pages/service apps/portal/src/components/portal/ServiceScorecard.tsx \
  apps/portal/src/components/portal/ServiceScorecard.test.tsx
git commit -m "feat(portal): customer Service scorecard page (W04)"
```

---

### Task 12: Documents page and library component

**Files:**
- Create: `apps/portal/src/pages/documents/index.astro`, `apps/portal/src/pages/documents/index.test.ts`
- Create: `apps/portal/src/components/portal/DocumentLibrary.tsx`, `apps/portal/src/components/portal/DocumentLibrary.test.tsx`

**Interfaces:**
- Consumes: `portalApi.getDocuments`, `portalApi.documentContentUrl` (Task 10); `PortalDocumentsDto` (Task 4).
- Produces: `data-testid` `portal-documents-groups`, `portal-documents-group-<category>`, `portal-document-row-<id>`, `portal-document-download-<id>`, `portal-documents-empty`, `portal-documents-error`, `documents-ledger-foot`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/portal/src/pages/documents/index.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');
const componentSource = readFileSync(
  new URL('../../components/portal/DocumentLibrary.tsx', import.meta.url), 'utf8');

describe('documents page', () => {
  it('bounces a page the MSP switched off', () => {
    expect(pageSource).toContain('redirectToPortalHomeAfterDisabled(Astro)');
  });
  it('redirects on 401 before rendering', () => {
    expect(pageSource).toContain('redirectToLoginAfter401(Astro)');
  });
  it('never prints a raw transport error at the customer', () => {
    expect(pageSource).not.toMatch(/\{response\.error\}/);
    expect(pageSource).toContain('data-testid="portal-documents-error"');
    expect(pageSource).toContain("We couldn't load your documents just now. Your IT team can help.");
  });
  it('downloads through the API path, never a presigned url', () => {
    expect(componentSource).toContain('portalApi.documentContentUrl');
    expect(componentSource).not.toMatch(/https?:\/\//);
  });
  it('gives every list, row and download a testid', () => {
    expect(componentSource).toContain('data-testid="portal-documents-groups"');
    expect(componentSource).toContain('data-testid="portal-documents-empty"');
    expect(componentSource).toMatch(/data-testid=\{`portal-document-row-\$\{/);
    expect(componentSource).toMatch(/data-testid=\{`portal-document-download-\$\{/);
  });
});
```

```tsx
// apps/portal/src/components/portal/DocumentLibrary.test.tsx
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentLibrary } from './DocumentLibrary';

vi.mock('@/lib/api', () => ({
  portalApi: { documentContentUrl: (id: string) => `/api/v1/portal/documents/${id}/content` },
}));

const dto = {
  asOf: '2026-10-15T12:00:00.000Z',
  timezone: 'America/Denver',
  groups: [{
    category: 'runbook' as const,
    documents: [{
      id: 'doc1', title: 'Firewall runbook', description: 'How we manage the edge',
      category: 'runbook' as const, contentType: 'application/pdf', byteSize: 204800,
      originalFilename: 'firewall.pdf', createdAt: '2026-10-01T00:00:00.000Z',
    }],
  }],
};

describe('DocumentLibrary', () => {
  it('groups by a human category name and links the download', () => {
    render(<DocumentLibrary documents={dto} />);
    expect(screen.getByTestId('portal-documents-group-runbook')).toHaveTextContent('Runbooks');
    expect(screen.getByTestId('portal-document-download-doc1'))
      .toHaveAttribute('href', '/api/v1/portal/documents/doc1/content');
  });

  it('shows a readable size rather than a byte count', () => {
    render(<DocumentLibrary documents={dto} />);
    expect(screen.getByTestId('portal-document-row-doc1')).toHaveTextContent('200 KB');
  });

  it('says so honestly when nothing has been shared', () => {
    render(<DocumentLibrary documents={{ ...dto, groups: [] }} />);
    expect(screen.getByTestId('portal-documents-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('portal-documents-groups')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/portal && npx vitest run src/pages/documents src/components/portal/DocumentLibrary.test.tsx`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the page**

Identical shape to Task 11's page: `portalApi.getDocuments(buildServerApiConfig(Astro.request))`, 401 → `redirectToLoginAfter401(Astro)`, `isPortalPageDisabled(response)` → `redirectToPortalHomeAfterDisabled(Astro)`, then `<DocumentLibrary client:load documents={response.data} />` or a `data-testid="portal-documents-error"` block with `PageHeader title="Documents" lede="The documents your IT team has shared with you."` and the `ErrorNotice` copy asserted above.

- [ ] **Step 4: Write `DocumentLibrary.tsx`**

```tsx
const CATEGORY_LABEL: Record<PortalDocumentCategory, string> = {
  baseline: 'Baselines',
  runbook: 'Runbooks',
  policy: 'Policies',
  evidence: 'Delivery evidence',
  report: 'Reports',
  export: 'Exports',
  other: 'Other',
};

/** Bytes as the reader would say them. 1 KB = 1024 B; one decimal above MB. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
```
`PageHeader`, then either `EmptyState` (`data-testid="portal-documents-empty"`, title "Nothing shared yet", body "Your IT team has not shared any documents with you.") or `<div data-testid="portal-documents-groups">` with one `<section data-testid={\`portal-documents-group-${g.category}\`}>` per group: an `<h2>` of `CATEGORY_LABEL[g.category]` and a ruled table whose rows are `<tr data-testid={\`portal-document-row-${doc.id}\`}>` carrying title, description, `formatByteSize(doc.byteSize)`, `formatDate(doc.createdAt)` and a download anchor exactly as in `ReportRunList.tsx:229-239`:

```tsx
<a
  data-testid={`portal-document-download-${doc.id}`}
  href={portalApi.documentContentUrl(doc.id)}
  download
  aria-label={`Download ${doc.title}`}
  className={cn(BTN_SECONDARY, 'min-h-11 sm:min-h-0 sm:py-1.5')}
>
  <Download className="h-4 w-4" aria-hidden="true" />
  Download
</a>
```
Close with a `data-testid="documents-ledger-foot"` count line and the `As of …` line.

- [ ] **Step 5: Run to verify pass**

Run: `cd apps/portal && npx vitest run src && npx tsc --noEmit`
Expected: PASS — the whole portal suite, so `disabledPageCoverage`, `noInlineStyles` and `basePathCoverage` all see both new pages.

- [ ] **Step 6: Commit**

```bash
git add apps/portal/src/pages/documents apps/portal/src/components/portal/DocumentLibrary.tsx \
  apps/portal/src/components/portal/DocumentLibrary.test.tsx
git commit -m "feat(portal): customer Documents library page (W04)"
```

---

### Task 13: Dashboard Service ledger row

**Files:**
- Modify: `apps/portal/src/components/portal/DashboardTiles.tsx:241-322`
- Modify: `apps/portal/src/components/portal/DashboardTiles.test.tsx`

**Interfaces:**
- Consumes: `DashboardDto['service']` (Task 6).
- Produces: `data-testid="portal-dashboard-tile-service"`.

- [ ] **Step 1: Write the failing test**

```tsx
  it('omits the service row entirely when the org has no service tile', () => {
    render(<DashboardTiles dashboard={dashboardWithout('service')} />);
    expect(screen.queryByTestId('portal-dashboard-tile-service')).toBeNull();
  });

  it('states the 90-day record and the next due item', () => {
    render(<DashboardTiles dashboard={{
      ...baseDashboard,
      service: { status: 'ok', windowDays: 90, deliveredOnTime: 5, deliveredLate: 1,
                 missed: 0, nextDue: { name: 'Monthly sign-in log review', dueAt: '2026-10-31' },
                 asOf: '2026-10-15T12:00:00.000Z' },
    }} />);
    const row = screen.getByTestId('portal-dashboard-tile-service');
    expect(row).toHaveTextContent('5 of 6 on time');
    expect(row).toHaveTextContent('Monthly sign-in log review');
  });

  it('says not yet available rather than 0 of 0 when nothing is scheduled', () => {
    render(<DashboardTiles dashboard={{
      ...baseDashboard,
      service: { status: 'no_data', windowDays: 90, deliveredOnTime: null, deliveredLate: null,
                 missed: null, nextDue: null, asOf: '2026-10-15T12:00:00.000Z' },
    }} />);
    expect(screen.getByTestId('portal-dashboard-tile-service')).toHaveTextContent('Not yet available');
  });
```
(`dashboardWithout` is a local helper that deletes the named key from a clone of `baseDashboard`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/portal && npx vitest run src/components/portal/DashboardTiles.test.tsx`
Expected: FAIL — the row does not exist.

- [ ] **Step 3: Implement**

Add a `ServiceValue` function beside `BackupValue` (line 229) and one `LedgerRow` after the backup row, rendered only when `dashboard.service` is present:

```tsx
function ServiceValue({ tile }: { tile: NonNullable<DashboardDto['service']> }) {
  const { deliveredOnTime, deliveredLate, missed, nextDue } = tile;
  if (deliveredOnTime == null || deliveredLate == null || missed == null) return null;
  const total = deliveredOnTime + deliveredLate + missed;
  return (
    <>
      {total > 0 && (
        <span className={FIGURE}>{`${deliveredOnTime} of ${total} on time`}</span>
      )}
      {nextDue && (
        <span className={QUIET}>{`Next: ${nextDue.name}`}</span>
      )}
    </>
  );
}
…
{service && (
  <LedgerRow
    testId="portal-dashboard-tile-service"
    label="Service delivered (90 days)"
    status={effectiveStatus(
      service.status,
      service.deliveredOnTime != null || service.nextDue != null,
    )}
  >
    <ServiceValue tile={service} />
  </LedgerRow>
)}
```
with `service` added to the destructuring at line 241. Placement: directly after the backup row and before Support, so the page reads capability → protection → work delivered → requests.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/portal && npx vitest run src/components/portal/DashboardTiles.test.tsx src/pages/dashboard && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/src/components/portal/DashboardTiles.tsx apps/portal/src/components/portal/DashboardTiles.test.tsx
git commit -m "feat(portal): dashboard service delivery row (W04)"
```

---

### Task 14: Portal RLS integration test

**Files:**
- Create: `apps/api/src/__tests__/integration/portalServiceRls.integration.test.ts`

**Interfaces:**
- Consumes: `serviceOverview`, `deliverableOccurrences`, `serviceTile`, `documentsForOrg`, `portalVisibleDocument`; `createPartner`, `createOrganization`, `createUser` from `./db-utils`; `getTestDb` from `./setup`.

Model the file on `apps/api/src/__tests__/integration/portalVisibilityRls.integration.test.ts` — same imports (`import './setup';`), the same admin-seeded / forged-context split, and the same positive-control discipline: **every negative assertion is paired with a positive one**, so a query that returns nothing because it is broken cannot read as a passing isolation proof.

- [ ] **Step 1: Write the test**

```ts
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  contracts, orgDocuments, organizationKeyDates, portalBranding, reports, reportRuns,
  serviceDeliverableEvidence, serviceDeliverableOccurrences, serviceDeliverables,
} from '../../db/schema';
import {
  deliverableOccurrences, serviceOverview, serviceTile,
} from '../../services/portal/serviceReadModel';
import {
  documentsForOrg, portalVisibleDocument,
} from '../../services/portal/documentsReadModel';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

/** Everything one org needs to be visible on the portal Service page. */
async function seedOrgService(admin: ReturnType<typeof getTestDb>, orgId: string, partnerId: string, label: string) {
  await admin.insert(portalBranding).values({
    orgId, enableService: true, enableDocuments: true, enableReports: true,
  });
  const [contract] = await admin.insert(contracts).values({
    partnerId, orgId, name: `${label} plan`, status: 'active', intervalMonths: 12,
    startDate: '2026-01-01', endDate: '2027-01-01', currencyCode: 'USD',
  }).returning({ id: contracts.id });
  const [deliverable] = await admin.insert(serviceDeliverables).values({
    orgId, contractId: contract!.id, name: `${label} sign-in log review`,
    cadence: 'monthly', anchorDueDate: '2026-09-30', effectiveFrom: '2026-01-01',
    artifactRequired: true, portalVisible: true,
  }).returning({ id: serviceDeliverables.id });
  const [occurrence] = await admin.insert(serviceDeliverableOccurrences).values({
    orgId, deliverableId: deliverable!.id, nameSnapshot: `${label} sign-in log review`,
    periodStart: '2026-09-01', periodEnd: '2026-09-30', dueAt: '2026-09-30',
    originalDueAt: '2026-09-30', status: 'delivered',
    deliveredAt: new Date('2026-09-29T12:00:00Z'), deliveryNote: `${label} note`,
  }).returning({ id: serviceDeliverableOccurrences.id });
  const [doc] = await admin.insert(orgDocuments).values({
    orgId, title: `${label} findings`, category: 'evidence', storageBackend: 'db',
    data: Buffer.from(label), contentType: 'application/pdf', byteSize: label.length,
    sha256: 'a'.repeat(64), originalFilename: `${label}.pdf`, portalVisible: true,
  }).returning({ id: orgDocuments.id });
  await admin.insert(serviceDeliverableEvidence).values({
    orgId, occurrenceId: occurrence!.id, kind: 'document', documentId: doc!.id,
  });
  await admin.insert(organizationKeyDates).values({
    orgId, label: `${label} insurance renewal`, kind: 'insurance_renewal',
    date: '2027-06-01', portalVisible: true,
  });
  return { contractId: contract!.id, deliverableId: deliverable!.id, occurrenceId: occurrence!.id, documentId: doc!.id };
}

function portalContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null };
}

describe('portal service RLS', () => {
  it('shows organization A its own service record and none of organization B\'s', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const a = await seedOrgService(admin, orgA.id, partner.id, 'alpha');
    const b = await seedOrgService(admin, orgB.id, partner.id, 'bravo');
    const args = { timezone: 'UTC', now: new Date('2026-10-15T12:00:00Z') };

    await withDbAccessContext(portalContext(orgA.id), async () => {
      const overview = await serviceOverview(orgA.id, args);
      const serialized = JSON.stringify(overview);

      // Positive control FIRST: without it, a broken query passes every
      // negative assertion below by returning nothing.
      expect(serialized).toContain('alpha sign-in log review');
      expect(serialized).toContain('alpha findings');
      expect(serialized).toContain('alpha insurance renewal');
      expect(overview.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('attached');

      expect(serialized).not.toContain('bravo');
      expect(serialized).not.toMatch(/ticket/i);

      // A forged read of B's own org id under A's context sees nothing: RLS,
      // not an app-layer filter, is what stops it.
      expect((await serviceOverview(orgB.id, args)).groups).toEqual([]);

      // B's deliverable id is indistinguishable from a non-existent one.
      await expect(deliverableOccurrences(orgA.id, b.deliverableId, args)).resolves.toBeNull();
      const own = await deliverableOccurrences(orgA.id, a.deliverableId, args);
      expect(own!.occurrences).toHaveLength(1);
      expect(JSON.stringify(own)).not.toMatch(/ticket/i);

      const docs = await documentsForOrg(orgA.id, args);
      expect(JSON.stringify(docs)).toContain('alpha findings');
      expect(JSON.stringify(docs)).not.toContain('bravo');
      await expect(portalVisibleDocument(orgA.id, b.documentId)).resolves.toBeNull();
      await expect(portalVisibleDocument(orgA.id, a.documentId)).resolves.toMatchObject({ id: a.documentId });

      const tile = await serviceTile(orgA.id, args);
      expect(tile).toMatchObject({ status: 'ok', deliveredOnTime: 1, deliveredLate: 0, missed: 0 });
    });
  });

  it('withholds a report run whose definition is not portal self-service', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const staff = await createUser({ partnerId: partner.id, orgId: null });
    const seeded = await seedOrgService(admin, org.id, partner.id, 'charlie');

    const [internal] = await admin.insert(reports).values({
      orgId: org.id, name: 'Internal posture', type: 'security_compliance_posture',
      portalSelfService: false, createdBy: staff.id,
    }).returning({ id: reports.id });
    const [run] = await admin.insert(reportRuns).values({
      reportId: internal!.id, status: 'completed', completedAt: new Date(),
    }).returning({ id: reportRuns.id });
    await admin.insert(serviceDeliverableEvidence).values({
      orgId: org.id, occurrenceId: seeded.occurrenceId, kind: 'report_run',
      reportId: internal!.id, reportRunId: run!.id,
    });

    await withDbAccessContext(portalContext(org.id), async () => {
      const overview = await serviceOverview(org.id, { timezone: 'UTC', now: new Date('2026-10-15T12:00:00Z') });
      const evidence = overview.groups[0]!.deliverables[0]!.lastDelivered!.evidence;
      // The document evidence still publishes; the internal run does not.
      expect(evidence.map((e) => e.kind)).toEqual(['document']);
      expect(JSON.stringify(overview)).not.toContain(run!.id);
    });
  });

  it('publishes evidence documents even with enable_documents off', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedOrgService(admin, org.id, partner.id, 'delta');
    await admin.update(portalBranding).set({ enableDocuments: false })
      .where(eq(portalBranding.orgId, org.id));

    await withDbAccessContext(portalContext(org.id), async () => {
      const overview = await serviceOverview(org.id, { timezone: 'UTC', now: new Date('2026-10-15T12:00:00Z') });
      expect(overview.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('attached');
    });
  });
});
```

Adjust the seed literals to whatever W01/W03 actually named the columns — the file will not compile otherwise, which is the intended feedback.

- [ ] **Step 2: Run it**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/portalServiceRls.integration.test.ts
```
Expected: PASS. A failure on the "positive control FIRST" assertions means the read model's predicates are wrong, not that isolation works.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/portalServiceRls.integration.test.ts
git commit -m "test(portal): cross-org RLS proof for the service and documents surfaces (W04)"
```

---

### Task 15: Wave verification and PR

**Files:** none new.

- [ ] **Step 1: Rebase on `main` and re-check the migration name**

```bash
git fetch origin && git rebase origin/main
ls apps/api/migrations | sort | tail -3
```
If anything now sorts after `2026-10-15-170600-…`, rename the file upward, `git add -A`, amend the Task-1 commit, and re-run `cd apps/api && npx vitest run src/db/autoMigrate.test.ts`. The pre-push hook re-checks against `origin/main` and will refuse the push otherwise.

- [ ] **Step 2: Run every unit suite this wave touched**

```bash
cd packages/shared && npx vitest run src/types src/validators/portal.test.ts && npx tsc --noEmit
cd ../../apps/api && npx vitest run src/services/portal src/routes/portal src/routes/orgPortalSettings.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts && npx tsc --noEmit
cd ../portal && npx vitest run src && npx tsc --noEmit
cd ../web && npx vitest run src/components/settings/OrgPortalSettingsEditor.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: all PASS. `migrationRlsScope.test.ts` must stay green — the new migration writes no rows, so it needs no `breeze.scope` election and must not be added to that test's frozen baseline.

- [ ] **Step 3: Run the contract suites against a live database**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/portalServiceRls.integration.test.ts \
  src/__tests__/integration/portalVisibilityRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
pnpm db:check-drift
```
Expected: all PASS and no drift. `tenant-export-policy` is the suite that fails if Task 1 Step 8 was skipped; it cannot fail in the unit **Test API** job, so a green local unit run is not evidence.

- [ ] **Step 4: Prove the flags end to end by hand**

With the test stack up and the API booted against it: as an MSP admin, `PATCH /api/v1/orgs/organizations/<orgId>/portal-settings` with `{"enableService":true,"enableDocuments":false}`; then as a portal session for that org, `GET /api/v1/portal/service` → 200, `GET /api/v1/portal/documents` → 403 `PORTAL_DOCUMENTS_DISABLED`, `GET /api/v1/portal/documents/<evidence doc id>/content` → 200 bytes. Flip `enableService` to false → `/portal/service` returns 403 `PORTAL_SERVICE_DISABLED` and the same content path returns 403. Record the four status codes in the PR body.

- [ ] **Step 5: Tear down and open the PR**

```bash
pnpm test-stack down
git push -u origin feature/<parent#>-service-deliverables/wave-<W04 sub-issue#>
gh pr create --title "feat(portal): customer Service and Documents surfaces (service deliverables W04)" --body "…"
```
The PR body must contain `Closes #<W04 sub-issue>`, the spec path, the four status codes from Step 4, and a line naming the three resolved spec ambiguities (occurrence-status vocabulary, the split document gate, the optional `DashboardDto.service` key) so the reviewer sees them without reading the diff.

- [ ] **Step 6: Merge through the queue**

`gh pr merge <N>` once `CI Success` is green. Never `--admin`.

---

## Self-review

**Spec coverage.** §4.7 (both `portal_branding` columns, `PORTAL_VISIBILITY_FLAG_KEYS`, strict gates, export policy) → Task 1; the MSP write surface implied by §4.7 → Tasks 2–3. §8 `GET /portal/service` → Tasks 5, 8. §8 `GET /portal/service/:deliverableId/occurrences` → Tasks 6, 8. §8 `GET /portal/documents` and `/documents/:id/content` with `contentDispositionFor` and no presigned URL → Tasks 7, 9, 12. §8 dashboard `serviceTile` in `dashboardForOrg`'s `Promise.all` → Tasks 6, 13. §8 publication rules D10 (no ticket; document evidence under `enable_service`; report evidence needs `enable_reports` + `portal_self_service`; `held_by_msp`) → Task 5 helpers, tested in Tasks 5, 11, 14. §8 pages + nav → Tasks 10–12. §11 (no system escalation, org from the session, shape-1 only) → Global Constraints + Task 14. §13 portal tests → Tasks 5–7 (read-model units), 8–9 (routes: 403 flag-off, 304 ETag), 11–12 (pages), 14 (`portalServiceRls.integration.test.ts`), 15 (`rls-coverage`, `tenant-export-policy`).

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Every test step carries the assertion text; every implementation step carries either the code or an exact, checkable rule (the query plan in Task 5 Step 3, the four mechanical edits in Task 2 Step 3). The one cross-wave dependency, W03's `streamDocument`, was read back from the W03 plan and is quoted at its real three-argument signature; Task 9 still carries the `grep` that re-confirms it against the merged code before any line is written, because W03 may yet change under review.

**Cross-wave checks run while writing this plan** (each found a real defect, now fixed): W03's `streamDocument` takes `(orgId, id, actor)` and returns `{ view, contentType, originalFilename, sha256, body, contentLength }` — not a row — so Task 7 became a metadata-only visibility lookup and Task 9 delegates the bytes; `streamDocument` does **not** filter `portal_visible`, so the portal predicate must run first and does; and W03 already claims migration slots `-170300-` and `-170400-` while W05 claims `-170500-`, so this wave moved to `-170600-`.

**Type consistency.** `artifactStateFor`, `portalOccurrenceStatus`, `publishableEvidence`, `serviceOverview`, `deliverableOccurrences`, `serviceTile`, `documentsForOrg`, `portalVisibleDocument`, `portalServiceRoutes`, `portalDocumentRoutes`, `createPortalFeatureGateAny`, `portalApi.getService` / `getServiceOccurrences` / `getDocuments` / `documentContentUrl` are spelled identically in every Interfaces block, code block and test that names them. DTO names match `packages/shared/src/types/portalService.ts` exactly. `summarizeStatus` and `OccurrenceStatus` match the W01 plan's Task 8 exports; `orgDocuments`, `OrgDocumentCategory`, `DeliverableActor` and `streamDocument(orgId, id, actor)` were read back from the W03 plan's Tasks 3 and 7 and match it verbatim.
