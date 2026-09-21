---
tracking_issue: LanternOps/breeze#5511
---

# Wave 04 — Built-in HP CMSL catalog package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HP's Client Management Script Library (CMSL) a first-class built-in Breeze deployment package — a third, package-manager-shaped arm of `BuiltinPackageDef` that provisions a partner-scoped `software_catalog` row plus a `winget`/`HP.HPCMSL` install method — and separate it cleanly from EDR credential readiness on both sides of the wire so the catalog page renders it without crashing.

**Architecture:** The `software_catalog_integration_provider_chk` CHECK is widened forward-only to admit `hp_cmsl`. `BuiltinPackageDef`'s discriminant changes from the boolean `requiresBinaryUpload` (which cannot express three shapes) to an explicit `installSource: 'derived_url' | 'partner_upload' | 'package_manager'`; `ensureBuiltinPackage` gains a `package_manager` branch that upserts one `software_install_methods` row under system DB context. `BuiltinProvider` splits into `BuiltinEdrProvider` (the credential-backed pair that `edrInstallerResolver` is typed against) and the wider `BuiltinProvider`, so HP can never be routed into EDR secret resolution. The web mirrors that split exactly: `EDR_PROVIDERS` ⊂ `INTEGRATION_PROVIDERS`, `useEdrReadiness` narrows to `EdrProvider`, and the catalog's readiness pill is gated on `isEdrProvider` while branding and the "Built-in" chip stay on `isIntegrationProvider`.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS), Vitest (unit + `vitest.integration.config.ts`), React + Vitest/jsdom + Testing Library, zod.

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md` — Layer 3 ("Getting CMSL onto the device"), plus its "Corrections after ground-truth verification" section, which supersedes the body wherever the two disagree.

**Cross-wave contract:** `contract-B-hp-cmsl.md` (coordinator, locked). The parts this wave needs are copied verbatim into Global Constraints below.

**Depends on:** W01 #5512 (lab probe — see Gate 1), Feature A #5505 wave W03 = issue **#5508** (see Gate 2). W02 #5513 lands before this wave and owns the `hpCmsl` inline-settings block that Task 6 reads.

---

## ⛔ TWO HARD GATES — read before writing any code

### Gate 1 — W01's lab probe must have answered the namespace question, and Todd must have ruled on it

W01 (#5512) probes real HP hardware for: **does `root/HP/InstrumentedServices/v1` exist and carry `HP_Warranty` / `HP_Entitlements` rows WITHOUT CMSL installed?**

If HP's factory image populates that namespace broadly, a large fraction of the fleet yields warranty data at **zero install and zero EULA exposure**, and most of this wave stops being worth building — the collector (W03) alone would cover those devices, and a built-in package would only serve the remainder.

**That is a scope decision for Todd, not for the implementer.** Before starting Task 1:

1. Read the recorded answer on issue **#5512** (the contract requires W01 to record all three answers there, not only in its plan doc).
2. If the answer is "populated without CMSL on a meaningful share of hardware", **stop and surface it**. Do not narrow, re-scope, or delete tasks on your own judgement.
3. If #5512 has no recorded answer yet, this wave is not startable. Say so and stop.

### Gate 2 — Feature A #5505 wave W03 (issue **#5508**) must have MERGED

Issue #5508 is *"W03: Remediation worker: policy-owned deployment creation, dispatch, dedup, `software_policy_id` column and its registrations"*. Verified 2026-09-10: **#5508 is OPEN.**

That wave is the machinery that turns a `missing` software-policy violation into an actual install. Without it:

- `SoftwarePolicyRemediationOptions` has exactly one verb, `autoUninstall?: boolean` (`apps/api/src/db/schema/softwarePolicies.ts:65-71`). There is no `autoInstall` field to set.
- `remediationOptionsSchema` (`softwarePolicies.ts:79-85`) is a non-strict `z.object`, so an `autoInstall` key written today is **silently stripped**, not rejected — a policy would look armed and install nothing.
- The compliance worker's remediation gate requires at least one `unauthorized` violation before it queues anything, so a device with only `missing` violations is unreachable (per Feature A's own corrections section, `softwareComplianceWorker.ts:423-444`).

**Consequence for task ordering:** Tasks 1–8 of this plan build the catalog package and its UI. They have **no dependency on #5508** and are independently valuable — an MSP can deploy CMSL to HP devices in one click through the existing Deploy wizard, using `targetType: 'filter'` on `hardware.manufacturer` (which *is* supported: `apps/api/src/services/deploymentTargetResolver.ts:60-62` → `evaluateFilter`). **Task 9 — the policy that keeps CMSL present — is blocked on #5508 and must not be started until it has merged.** Ship Tasks 1–8 as one PR if #5508 has not landed; Task 9 follows as a second PR.

### A third thing that is not a gate but bounds the design: the HP CMSL EULA

HP's CMSL licence states verbatim: *"You do not have the right to distribute the Software Product."*

**Breeze must NEVER mirror or host the CMSL installer.** That rules out the `winget_bootstrap` pattern, where Breeze serves pinned artifacts from disk over `/agents/:id/...` (`apps/api/src/routes/agents/wingetBootstrap.ts:22-30`). Installing via **winget**, or via an **HP-hosted URL**, satisfies the licence because the bytes come from HP. This constraint is written into a code comment in Task 2 on purpose: a future change that copies the installer into S3, into the winget-bootstrap artifact set, or into any Breeze-served path is a licence violation, not a performance win.

---

## Global Constraints

Copied verbatim from the coordinator's contract (`contract-B-hp-cmsl.md`) except where marked **[ground-truth correction]**.

- **Migration slot.** Newest committed migration verified 2026-09-10 by `ls apps/api/migrations/*.sql | sort | tail -1`: `apps/api/migrations/2026-10-15-150300-remote-session-revocation-lease.sql` (730 files total). The contract's slot for this wave is `apps/api/migrations/2026-10-15-150402-software-catalog-hp-cmsl-provider.sql`, which sorts after it. **Re-run `ls apps/api/migrations/*.sql | sort | tail -1` at implementation time and rename upward if anything now sorts after that slot** — #5508 must merge first (Gate 2) and it ships its own migration. Filenames in this repo run ahead of real time; today's date does NOT sort last. `2026-08-06` is a closed date block — never add `-g-` or later to it.
- **Never edit a shipped migration.** `2026-07-02-builtin-catalog-partner-read-rls.sql` is content-hash immutable. Widening its CHECK means a new forward-only file that `DROP CONSTRAINT IF EXISTS` + re-`ADD`s.
- **Migration idempotency.** `IF NOT EXISTS` / `DROP ... IF EXISTS` / guarded `DO $$` blocks. Re-applying must be a true no-op. **No inner `BEGIN;`/`COMMIT;`** — `autoMigrate` wraps each file in `client.begin(...)`.
- **`breeze.scope` elevation.** Any migration statement that `UPDATE`/`DELETE`/`INSERT`/`MERGE`s rows must be preceded by `SELECT set_config('breeze.scope', 'system', true);` in the same file (and, in a `-- @no-transaction` file, the same statement). This wave's migration performs **no DML** — it only drops and re-adds a CHECK constraint — so no elevation is required. `apps/api/src/db/migrationRlsScope.test.ts` must still be run (Task 1, step 6).
- **`BuiltinPackageDef` is a THREE-armed union.** A winget package is a third arm — no URL, no upload, just a package id. Extend the union; do not force HP into an existing arm.
- **Keep HP out of the EDR secret branch** at `apps/api/src/services/softwareDeployment.ts:554-584`. That path injects Huntress/SentinelOne account and site tokens and has nothing to do with HP.
- **HP has no credential-readiness concept and must be SEPARATED from EDR readiness, not folded into it.** `INTEGRATION_PROVIDERS` (`apps/web/src/components/software/providerBranding.ts:5`) is the single source both the union and the type guard derive from; adding `hp_cmsl` there without touching readiness is what crashes the catalog page.
- **Non-negotiable testing gates (contract):**
  - Web: a test that renders the catalog with an `hp_cmsl` item present. Mandatory.
  - Integration suites need a live DB and run only in the **Integration Tests** job; a locally-green branch proves nothing about them.
  - Scoped test runs: `cd apps/api && npx vitest run <path>` / `cd apps/web && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` into argv, vitest stops flag parsing there, and the full suite runs in watch mode. Vitest's path filter is a plain substring match, so a trailing slash silently skips sibling `foo.test.ts` files.
- **No new i18n keys.** `apps/web/src/lib/i18n/localeParity.test.ts` enforces parity across nine locales (`de-DE, en, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`). Existing built-in branding strings (`providerBranding.ts` `label`/`blurb`) are plain untranslated literals; HP's follow that precedent, and Task 8 removes rather than adds rendered strings. Verified: this wave introduces zero `i18n.t()` keys.
- **`software_catalog` needs no new registry entry.** It is already in `DUAL_AXIS_TENANT_TABLES` (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:382`) and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (`:592`); `software_install_methods` is already in `PARENT_FK_JOIN_POLICY_TABLES` (`:692`). This wave adds **no table and no column**, so `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` and `CORE_TENANT_EXPORT_POLICY` are all untouched. (Task 9 also adds no column — it inserts rows into existing tables.)
- **`hp_cmsl` is the provider string everywhere**, on both sides of the wire: DB CHECK value, `BuiltinProvider` member, `INTEGRATION_PROVIDERS` member, `software_catalog.integration_provider` value. `integration_provider` is `varchar(20)`; `'hp_cmsl'` is 7 characters.
- **The winget package id is `HP.HPCMSL`.** It satisfies `WINGET_PACKAGE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` (`apps/api/src/routes/softwareInstallMethods.ts:22`).

---

## 0. Ground truth

Every file below was re-opened in the worktree at `/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing` on 2026-09-10. Citations are mine, not copied from the spec or the contract. **Four contract/spec citations were found wrong and are flagged inline.**

### The DB CHECK

`apps/api/migrations/2026-07-02-builtin-catalog-partner-read-rls.sql:13-25` — verbatim (contract's `:13-25` **confirmed**; the `CHECK` line itself is `:23`):

```sql
-- Also pin integration_provider to the known set (defense-in-depth; no shipped rows).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'software_catalog_integration_provider_chk'
      AND conrelid = 'software_catalog'::regclass
  ) THEN
    ALTER TABLE software_catalog
      ADD CONSTRAINT software_catalog_integration_provider_chk
      CHECK (integration_provider IS NULL OR integration_provider IN ('huntress', 'sentinelone'));
  END IF;
END $$;
```

Note the `IF NOT EXISTS` guard: the shipped file will **not** re-narrow the constraint after this wave widens it, because the constraint will already exist. Re-applying the whole migration set stays correct.

### The union and the provisioner

`apps/api/src/services/builtinDeploymentPackages.ts` (full file read, 123 lines). Contract citations **confirmed**: `BuiltinProvider` `:5`; union doc comment `:19-23` and the union itself `:24-26`; `BUILTIN_PACKAGES` `:28-54`; `ensureBuiltinPackage` doc comment `:60-65` and function `:66-123`; `originalFileName: 'HuntressInstaller.exe'` at `:112`.

```ts
// :5
export type BuiltinProvider = 'huntress' | 'sentinelone';
// :19-26
/**
 * Discriminated on `requiresBinaryUpload` so the two valid shapes can't drift:
 *  - false → installer URL is derivable, `downloadUrlTemplate` is required (Huntress)
 *  - true  → no derivable URL; the partner uploads the binary (SentinelOne)
 */
export type BuiltinPackageDef =
  | (BuiltinPackageBase & { requiresBinaryUpload: false; downloadUrlTemplate: string })
  | (BuiltinPackageBase & { requiresBinaryUpload: true; downloadUrlTemplate?: never });
```

```ts
// :99-118 — the version-row branch, with the hardcoded filename at :112
      // Templated version only when the binary URL is derivable (Huntress).
      if (!def.requiresBinaryUpload && def.downloadUrlTemplate) {
        const versions = await db
          .select({ id: softwareVersions.id })
          .from(softwareVersions)
          .where(eq(softwareVersions.catalogId, catalogId))
          .limit(1);
        if (versions.length === 0) {
          await db.insert(softwareVersions).values({
            catalogId,
            version: 'latest',
            downloadUrl: def.downloadUrlTemplate,
            fileType: def.fileType,
            originalFileName: 'HuntressInstaller.exe',
            supportedOs: def.supportedOs,
            silentInstallArgs: def.silentInstallArgsTemplate,
            isLatest: true,
          });
        }
      }
```

`BuiltinPackageBase` (`:7-17`) carries `fileType`, `supportedOs` and `silentInstallArgsTemplate` — all three meaningless for a winget package, which is why Task 2 splits the base rather than adding a fourth optional field.

`ensureBuiltinPackage` runs `runOutsideDbContext(() => withSystemDbAccessContext(async () => { ... }))` (`:72-73`). Confirmed sanctioned here: `software_catalog` is a partner-axis (dual-axis) table and this is a partner-axis WRITE, which is the case CLAUDE.md keeps the escalation for. Both existing call sites fire it **after** their own write has returned, outside any request transaction (`apps/api/src/routes/huntress.ts:454-461`, `apps/api/src/routes/sentinelOne.ts:435`). Task 6 keeps that shape.

Callers today (`grep -rn 'ensureBuiltinPackage' apps/api/src`): `routes/huntress.ts:25,456`, `routes/sentinelOne.ts:13,435`, and the two test files. **There is no HP trigger anywhere** — HP has no integration to connect, which is why Task 6 exists.

`apps/api/src/services/builtinDeploymentPackages.test.ts:29-31` — the assertion this wave turns red first:

```ts
  it('exposes both providers', () => {
    expect(Object.keys(BUILTIN_PACKAGES).sort()).toEqual(['huntress', 'sentinelone']);
  });
```

### The EDR resolver — a latent trap the contract does not mention

`apps/api/src/services/edrInstallerResolver.ts:54-62` — verbatim:

```ts
export async function resolveEdrInstaller(params: {
  provider: BuiltinProvider;
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  if (params.provider === 'huntress') return resolveHuntress(params);
  return resolveSentinelOne(params);
}
```

`params.provider` is typed `BuiltinProvider` (`:5` of the imported module, `:55` here). **Widening `BuiltinProvider` to include `'hp_cmsl'` silently widens this function too, and the `return resolveSentinelOne(params)` fall-through would route HP into SentinelOne's site-token resolver.** TypeScript cannot catch it — there is no exhaustive switch. This is the same class of trap as the hardcoded `HuntressInstaller.exe`, and it is why Task 3 splits `BuiltinEdrProvider` out of `BuiltinProvider` instead of just widening the one type.

### The dispatch path — HP structurally cannot reach the EDR branch

`apps/api/src/services/softwareDeployment.ts:521-531` — verbatim:

```ts
  // Package-manager deploys take a completely different (and much shorter)
  // path: no installer to presign, no checksum, no destination policy to
  // evaluate and no `{{...}}` templates to resolve.
  if (installMethod) {
    return dispatchManagerInstalls(input, installMethod, fanoutDeviceIds);
  }
  if (!versionRecord) {
    throw new Error(
      `Software deployment ${deploymentId} has neither a version record nor an install method`,
    );
  }
```

The EDR secret branch is at `:554-584`, gated by `:558-561`:

```ts
  if (
    catalogItem.integrationProvider === 'huntress' ||
    catalogItem.integrationProvider === 'sentinelone'
  ) {
```

So an `hp_cmsl` deployment (which always carries an `installMethod`, never a `versionRecord`) returns at `:525`, **before** `:558` is ever evaluated. `dispatchManagerInstalls`'s own doc comment says so (`:361-366`: *"there is no installer binary, so presign, EDR resolution, checksum … are all inapplicable"*). This is stronger than the spec's "keep HP out of the EDR secret branch" — it is already structurally impossible via the manager path. Task 3 pins that with a regression test rather than changing behaviour.

### The install-method API boundary

`apps/api/src/routes/softwareInstallMethods.ts:39-53` (`installMethodBodySchema`) — confirmed. Field is **`kind`**, not `manager`; values `winget | homebrew_cask | homebrew_formula`; platform `windows | macos` only (no `linux`); a `superRefine` at `:44-53` requires `winget ⇔ windows`. `{ platform: 'windows', kind: 'winget', packageId: 'HP.HPCMSL' }` is valid.

`:110-114` — the built-in rejection, **POST only**:

```ts
    const item = await loadOwnedCatalogItem(c.req.param('id'), orgResult.orgId);
    if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);
    if (item.integrationProvider !== null) {
      return c.json({ error: 'Built-in packages cannot carry install methods' }, 400);
    }
```

**NEW FINDING — the guard is missing on PATCH and DELETE.** `:144-183` (PATCH) and `:272-308` (DELETE) call `loadOwnedCatalogItem` and then `loadInstallMethod`, with no `integrationProvider` check at all. `loadOwnedCatalogItem` (`:69-74`) is:

```ts
async function loadOwnedCatalogItem(catalogId: string, orgId: string) {
  const [item] = await db.select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId)).limit(1);
  // RLS restricts visibility; extra guard mirrors software.ts deploy handlers.
  if (!item || (item.orgId !== null && item.orgId !== orgId)) return null;
  return item;
}
```

A built-in row has `org_id IS NULL`, so `item.orgId !== null` is false and the item passes. RLS does not close the gap either: `software_install_methods`'s UPDATE and DELETE policies (`apps/api/migrations/2026-08-16-a-software-install-methods.sql:89-119`) admit `breeze_has_org_access(sc.org_id) OR (sc.partner_id IS NOT NULL AND breeze_has_partner_access(sc.partner_id))`. For a **partner-scoped** caller the second branch is TRUE. So today a partner admin with `devices.write` + MFA can PATCH a built-in's install method to an arbitrary winget package id, or DELETE it. Once HP CMSL ships an install method, that becomes "install anything you like on every device this built-in reaches". Task 5 closes it.

(Org-scoped callers are already blocked by RLS — `breeze_has_org_access(NULL)` is FALSE and `breeze_has_partner_access(P)` is FALSE for an org token — so this is a partner-scope hole, not an org-scope one.)

`apps/api/migrations/2026-08-16-a-software-install-methods.sql:16-51` — the table, its three CHECKs and the unique index the upsert keys on:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS software_install_methods_catalog_platform_kind_uq
  ON software_install_methods (catalog_id, platform, kind);
```

Mirrored in Drizzle at `apps/api/src/db/schema/software.ts:262` (`catalogPlatformKindUq`). The table cascades from `software_catalog` (`ON DELETE CASCADE`, `:55`) and has no `org_id` — parent-FK join tenancy, already registered.

`breeze_has_partner_access` short-circuits for system scope (`apps/api/migrations/2026-04-11-partners-rls.sql:63-67`: `WHEN public.breeze_current_scope() = 'system' THEN TRUE`), so the provisioner's insert under `withSystemDbAccessContext` passes the INSERT policy. Verified, not assumed.

### The catalog list feed — already generic

`apps/api/src/routes/software.ts:719-732` — the list WHERE already unions in *any* built-in for an org caller (`isNotNull(softwareCatalog.integrationProvider)`), and `:774-775` already computes `methodCount` / `methodKinds` from `software_install_methods`. **No API list change is needed** for an HP CMSL card to appear with a `winget` badge.

`software.ts:939` and `:978` already refuse catalog UPDATE and DELETE on any row with a non-null `integrationProvider` for non-system scope.

`apps/web/src/components/software/DeploymentWizard.tsx:374-393` fetches `/software/catalog/:id/install-methods` for every catalog row generically, so a built-in carrying a winget method is deployable through the existing wizard with no wizard change.

### The web crash — the contract's claim is conditional, not unconditional

`apps/web/src/components/software/providerBranding.ts` (full file, 41 lines). Contract citations **confirmed**: `INTEGRATION_PROVIDERS` `:5`, `BRANDING` `:18` (not exported), `getProviderBranding` `:35`, `isIntegrationProvider` `:39-41`.

`apps/web/src/components/software/useEdrReadiness.ts:123-135` — verbatim:

```ts
export function useEdrReadiness(
  providers: IntegrationProvider[],
  opts?: { s1VersionCount?: number },
): Record<IntegrationProvider, EdrReadiness> {
  const s1VersionCount = opts?.s1VersionCount ?? 0;
  const key = useMemo(
    () => `${Array.from(new Set(providers)).sort().join(',')}|${s1VersionCount}`,
    [providers, s1VersionCount],
  );
  const [map, setMap] = useState<Record<IntegrationProvider, EdrReadiness>>({
    huntress: LOADING,
    sentinelone: LOADING,
  });
```

`apps/web/src/components/software/SoftwareCatalog.tsx:637-641` and `:824-828` — the two unguarded dereferences, both **confirmed**:

```tsx
                  {isIntegrationProvider(item.integrationProvider) && (
                    <div className="flex items-center gap-1.5">
                      <ReadinessPill
                        status={readinessMap[item.integrationProvider].status}
                      />
```

```tsx
              (isIntegrationProvider(selectedSoftware.integrationProvider) ? (
                <BuiltinPackageDetail
                  name={selectedSoftware.name}
                  provider={selectedSoftware.integrationProvider}
                  readiness={readinessMap[selectedSoftware.integrationProvider]}
```

**NEW FINDING — a third site the contract does not name, and it is the one that gates the other two.** `SoftwareCatalog.tsx:271-275`, inside the catalog loader's row mapping:

```tsx
            integrationProvider:
              item.integrationProvider === "huntress" ||
              item.integrationProvider === "sentinelone"
                ? item.integrationProvider
                : undefined,
```

This hardcodes the pair. As written, adding `hp_cmsl` to `INTEGRATION_PROVIDERS` **does not crash the page** — an `hp_cmsl` row arrives from the API, is narrowed to `undefined` here, and renders as an ordinary *org* package: no branding, no "Built-in" chip, and a **Delete** button in the detail panel (`:843-850`) that the API would refuse with a 400 (`software.ts:978`). That is a worse outcome than a crash, because it is silent. The crash the contract describes is real but only becomes reachable once `:271-275` is widened, which Task 8 must do. Task 8 exercises both states in sequence so the red is genuine at each step.

`builtinProviders` (`:314-324`) filters with `isIntegrationProvider` and feeds `useEdrReadiness` at `:331` — that filter must become `isEdrProvider`.

`apps/web/src/components/software/BuiltinPackageDetail.tsx:16-37` — `readiness: EdrReadiness` is required today and `:31-33` reads `.status` three times; `:77-146` is the readiness box. Its existing suite `BuiltinPackageDetail.test.tsx` passes a non-null `EdrReadiness`, which stays assignable after Task 8 widens the prop to `EdrReadiness | null`.

Blast radius, from `grep -rn 'providerBranding\|IntegrationProvider\|useEdrReadiness\|EdrReadiness' apps/web/src`: exactly three source files (`providerBranding.ts`, `useEdrReadiness.ts`, `SoftwareCatalog.tsx`, `BuiltinPackageDetail.tsx`) and three test files. Nothing outside `apps/web/src/components/software/`.

`SoftwareCatalog.test.tsx:226-297` is the existing built-in test block, including the `routeBuiltin(items, huntress?, s1?)` URL-routing fetch helper (`:237-245`) that Task 8's new test reuses.

### The policy half — three findings that change Task 9

**[ground-truth correction 1] `filterEngine.ts:88` and `:94` are off by one.** The real lines are `apps/api/src/services/filterEngine.ts:89` (`{ key: 'osType', ... }`) and `:95` (`{ key: 'hardware.manufacturer', ... }`). `:88` and `:94` are the `// OS fields` and `// Hardware fields` section comments. Both fields do exist.

**[ground-truth correction 2] the spec's `software.ts:287` citation for "`targetType: 'sites'` is unimplemented" is wrong.** `software.ts:287` is a status-count sum inside `computeSoftwareDeploymentAggregateStatus`. The real refusal is `apps/api/src/routes/software.ts:400-405`:

```ts
  if (payload.targetType === 'sites') {
    return {
      error: 'Site targeting is not implemented for software deployments',
      deviceIds: [] as string[],
    };
  }
```

**[ground-truth correction 3 — the substantive one] a software policy does NOT target devices through the filter engine, or through its own `targetType`/`targetIds` columns.** The compliance worker resolves devices via `resolveDeviceIdsForSoftwarePolicy` (`apps/api/src/jobs/softwareComplianceWorker.ts:324` → `apps/api/src/services/featureConfigResolver.ts:1044-1171`), which:

1. finds **configuration policies** that carry a `software_policy` feature link pointing at this software policy (`:1048-1067`),
2. reads those config policies' **assignments** (`:1072-1078`),
3. fans each assignment out by `level` — `device`, `device_group`, `site`, `organization`, `partner` (`:1088-1138`); there is **no `filter` level**,
4. keeps a device only if this is the *closest-winning* software policy for it (`:1150-1168`).

`softwarePolicies.targetType` / `targetIds` (`apps/api/src/db/schema/softwarePolicies.ts:91-92`) are read by **nothing** on this path — `grep -rn 'targetType' apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/services/softwarePolicyService.ts` returns zero hits.

The only narrowing an assignment can carry is `roleFilter` and `osFilter` (`apps/api/src/db/schema/configurationPolicies.ts:170-171`), applied by `buildRoleOsFilterConditions` (`featureConfigResolver.ts:134-139`). **There is no manufacturer filter.** And `device_groups.orgId` is `NOT NULL` (`apps/api/src/db/schema/devices.ts:478`), so a partner-wide "HP hardware" device group cannot exist either.

So the spec's Layer-3 sentence *"Targeting is expressible with existing filters: `osType` and `hardware.manufacturer` are both supported by the filter engine"* is true of **deployments** (`deploymentTargetResolver.ts:60-62` runs `evaluateFilter`) and false of **software policies**. Task 9 is written around that.

**[NEW FINDING] `allowUnknown: true` is mandatory on the built-in policy.** `evaluateSoftwareInventory` (`apps/api/src/services/softwarePolicyService.ts:306-350`), allowlist arm:

```ts
  if (mode === 'allowlist') {
    for (const installed of inventory) {
      const allowed = softwareRules.some((rule) => matchesSoftwareRule(installed, rule));
      if (!allowed && !allowUnknown) {
        violations.push({ type: 'unauthorized', ... severity: 'medium', detectedAt });
      }
    }
```

and `normalizeSoftwarePolicyRules` (`:265-268`) defaults `allowUnknown: raw.allowUnknown === true` — i.e. **false unless explicitly set**. A one-rule allowlist policy without `allowUnknown: true` marks *every other installed application on every targeted device* as `unauthorized`, at severity `medium`, every 15 minutes. The spec never mentions this. Task 9 sets it and tests it.

`config_policy_feature_links` carries `uniqueFeaturePerPolicy` on `(configPolicyId, featureType)` (`apps/api/src/db/schema/configurationPolicies.ts:127`), so **one `software_policy` link per configuration policy** — the built-in cannot piggyback on an MSP's existing config policy without displacing their own software policy. Task 9 provisions a dedicated configuration policy.

### Auth building blocks (used by Task 6)

- `AuthContext.partnerId: string | null` — `apps/api/src/middleware/auth.ts:95`. Present on org tokens too.
- `hasSatisfiedMfa(auth)` — `apps/api/src/middleware/auth.ts:915`. Contract citation **confirmed**.
- `hasPermission(userPerms, resource, action)` — `apps/api/src/services/permissions.ts:210`. Contract citation **confirmed**.
- `PERMISSIONS.DEVICES_EXECUTE` — `packages/shared/src/constants/permissions.ts:24`. Contract citation **confirmed**.
- `MFA_GATED_FEATURE_TYPES` — `apps/api/src/routes/configurationPolicies/featureLinks.ts:91` (contract **confirmed**; the spec body's `:86` is wrong and its own corrections section already says so).
- `featureLinks.ts` POST returns the created link at `:279-307`; PATCH returns `updated` at `:460-480`. Both give Task 6 a post-write link object, which is what D4's "gate on POST-WRITE state" principle wants.
- `captureException` is imported from `'../services/sentry'` (`apps/api/src/routes/huntress.ts:29`).

### Test infrastructure

- `apps/api/vitest.integration.config.ts:11-12` — `include` carries the standing glob `'src/__tests__/integration/**/*.test.ts'`. New files there need **no** config edit.
- `apps/api/src/__tests__/integration/builtinDeploymentPackages.integration.test.ts` (full file, 60 lines) — the convention Task 4's integration test extends: `import './setup'`, `createPartner()` from `./db-utils` (`:176`), exercise the real function, verify via a second `withSystemDbAccessContext` read.
- `apps/api/src/routes/softwareInstallMethods.test.ts` — `chainMock` proxy (`:17-22`), the `vi.mock('../db')` shape (`:24-35`), `ownedCatalogItem(overrides)` (`:84-92`), and the existing built-in POST rejection test (`:241-252`). Task 5's tests mirror `:291-340` (PATCH) and `:342-373` (DELETE).
- `apps/api/src/services/softwareDeployment.test.ts` — `sel(rows)` (`:138-144`), `resolveEdrInstaller` mocked wholesale (`:39-44`), `resolveEdrMock` (`:130`), the manager-dispatch describe block starting `:1900` with `primeSelects(method, targetDevices)` (`:1933-1939`) which primes selects in the order *install method → catalog item → devices*.
- `apps/api/src/services/edrInstallerResolver.test.ts` (full file, 35 lines) — mocks `../db` to `{ withSystemDbAccessContext, runOutsideDbContext, db: {} }` and imports only the pure substitution helpers today.
- `apps/api/package.json:26` and `apps/web/package.json:17` are both `"test": "vitest"` (bare, watch-mode). Use `npx vitest run <path>` from inside the package.
- `apps/web/vitest.config.ts` — jsdom, `include: ['src/**/*.test.{ts,tsx}']`, setup at `src/__tests__/setup.ts`. New co-located tests need no config edit.

---

## File structure

**Create**

- `apps/api/migrations/2026-10-15-150402-software-catalog-hp-cmsl-provider.sql` — forward-only CHECK widening. DDL only.
- `apps/api/src/services/hpCmslProvisioning.ts` — the HP-specific glue: the `hpCmsl.enabled` predicate, the partner resolution, and the fire-and-forget provisioning call. Kept out of `builtinDeploymentPackages.ts` so that module stays a provider-agnostic registry.
- `apps/api/src/services/hpCmslProvisioning.test.ts` — unit tests for the predicate and the trigger decision.
- `apps/api/src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts` — real-DB provisioning: catalog row + install-method row, idempotent, self-healing.
- *(Task 9 only)* `apps/api/src/services/hpCmslPolicyProvisioning.ts` + `apps/api/src/services/hpCmslPolicyProvisioning.test.ts` + `apps/api/src/__tests__/integration/hpCmslPolicyProvisioning.integration.test.ts`.

**Modify**

- `apps/api/src/services/builtinDeploymentPackages.ts` — three-armed union, `BuiltinEdrProvider`/`BuiltinProvider` split, `hp_cmsl` def, `package_manager` provisioning branch, `originalFileName` moved onto the def.
- `apps/api/src/services/edrInstallerResolver.ts` — narrow to `BuiltinEdrProvider`, exhaustive switch.
- `apps/api/src/routes/softwareInstallMethods.ts` — one shared built-in-denied constant, applied to POST, PATCH and DELETE.
- `apps/api/src/routes/configurationPolicies/featureLinks.ts` — provisioning trigger on the warranty feature link's post-write state (POST + PATCH).
- `apps/web/src/components/software/providerBranding.ts` — `EDR_PROVIDERS` / `INTEGRATION_PROVIDERS` split, `isEdrProvider`, `hp_cmsl` branding.
- `apps/web/src/components/software/useEdrReadiness.ts` — narrow the signature to `EdrProvider`.
- `apps/web/src/components/software/SoftwareCatalog.tsx` — widen the row-mapping narrowing, gate the readiness pill on `isEdrProvider`, pass `null` readiness for non-EDR built-ins.
- `apps/web/src/components/software/BuiltinPackageDetail.tsx` — `readiness: EdrReadiness | null`.

**Test (modify)**

- `apps/api/src/services/builtinDeploymentPackages.test.ts`
- `apps/api/src/services/edrInstallerResolver.test.ts`
- `apps/api/src/services/softwareDeployment.test.ts`
- `apps/api/src/routes/softwareInstallMethods.test.ts`
- `apps/api/src/__tests__/integration/builtinDeploymentPackages.integration.test.ts`
- `apps/web/src/components/software/providerBranding.test.ts`
- `apps/web/src/components/software/SoftwareCatalog.test.tsx`

---

### Task 1: Migration — widen `software_catalog_integration_provider_chk` to admit `hp_cmsl`

**Files:**
- Create: `apps/api/migrations/2026-10-15-150402-software-catalog-hp-cmsl-provider.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: the DB precondition for every later task — `software_catalog.integration_provider` may hold `'hp_cmsl'`.

- [ ] **Step 1: Confirm the slot still sorts last, and rename upward if not**

```bash
ls apps/api/migrations/*.sql | sort | tail -1
```

Expected as of 2026-09-10: `apps/api/migrations/2026-10-15-150300-remote-session-revocation-lease.sql`. If anything now sorts at or after `2026-10-15-150402` (Gate 2 requires #5508 to merge first, and it ships its own migration), pick the next free slot **after the newest committed file** and use that name for the rest of this task. Do not reuse a lower number, and do not touch `2026-08-06-*` (closed block).

- [ ] **Step 2: Write the failing check**

This migration has no unit-testable TypeScript surface; the red is the constraint refusing the value against a real database.

```bash
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'software_catalog_integration_provider_chk';"
```

- [ ] **Step 3: Run it, expect FAIL (the constraint does not admit `hp_cmsl`)**

Expected output contains `integration_provider IN ('huntress'::text, 'sentinelone'::text)` and **not** `hp_cmsl`. That is the baseline red.

- [ ] **Step 4: Write the migration**

```sql
-- apps/api/migrations/2026-10-15-150402-software-catalog-hp-cmsl-provider.sql
-- Feature #5511 W04 (#5515): admit the built-in HP CMSL package as a third
-- integration provider on software_catalog.
--
-- The shipped constraint (2026-07-02-builtin-catalog-partner-read-rls.sql:13-25)
-- pins integration_provider to NULL / 'huntress' / 'sentinelone'. HP CMSL is a
-- THIRD built-in shape: a package-manager (winget) package with no derivable
-- installer URL and no partner binary upload — see BuiltinPackageDef's
-- `installSource: 'package_manager'` arm in
-- services/builtinDeploymentPackages.ts. The CHECK has to admit 'hp_cmsl'
-- before ensureBuiltinPackage can write its catalog row.
--
-- FORWARD-ONLY. The shipped file is content-hash immutable and is never edited;
-- DROP + re-ADD is the only way to widen a CHECK in Postgres. Note that the
-- shipped file guards its ADD with `IF NOT EXISTS (SELECT 1 FROM pg_constraint
-- ...)`, so replaying the full migration set after this file will NOT re-narrow
-- the constraint.
--
-- NO DML: this file only drops and re-adds a constraint, so no
-- `SELECT set_config('breeze.scope','system', true)` elevation is required.
-- db/migrationRlsScope.test.ts requires the wrapper only before
-- UPDATE/DELETE/INSERT/MERGE. ALTER TABLE ... ADD CONSTRAINT validates existing
-- rows as the table owner and is not row-level-security filtered.
--
-- Idempotent: DROP ... IF EXISTS then an unconditional ADD inside one guarded
-- DO block, so re-applying is a true no-op. No inner BEGIN/COMMIT — autoMigrate
-- wraps each file in its own transaction.

DO $$
BEGIN
  ALTER TABLE software_catalog
    DROP CONSTRAINT IF EXISTS software_catalog_integration_provider_chk;

  ALTER TABLE software_catalog
    ADD CONSTRAINT software_catalog_integration_provider_chk
    CHECK (
      integration_provider IS NULL
      OR integration_provider IN ('huntress', 'sentinelone', 'hp_cmsl')
    );

  RAISE NOTICE 'software_catalog_integration_provider_chk widened to include hp_cmsl';
END $$;
```

- [ ] **Step 5: Apply and re-run the check, expect PASS**

```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate
docker exec -i breeze-postgres psql -U breeze_app -d breeze -c \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'software_catalog_integration_provider_chk';"
```

Expected: the definition now lists all three values. Then prove idempotency — a second `pnpm db:migrate` must report zero newly-applied migrations:

```bash
pnpm db:migrate
```

- [ ] **Step 6: Run the migration guards**

```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
```

Expected: PASS. `migrationRlsScope.test.ts` carries a frozen baseline of 122 pre-existing offenders — this file must **not** be added to it. `autoMigrate.test.ts` asserts filename ordering and that every migration path referenced from a test resolves.

- [ ] **Step 7: Verify drift**

```bash
pnpm db:check-drift
```

Expected: PASS. (This only verifies that the hand-written migration set applies cleanly and that `breeze_migrations` has one row per file — it does **not** diff the Drizzle schema against the live DB.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-10-15-150402-software-catalog-hp-cmsl-provider.sql
git commit -m "feat(software): admit hp_cmsl as a built-in catalog integration provider (#5515)"
```

---

### Task 2: Three-armed `BuiltinPackageDef` + the `hp_cmsl` definition

**Files:**
- Modify: `apps/api/src/services/builtinDeploymentPackages.ts:1-58` (types + registry)
- Test: `apps/api/src/services/builtinDeploymentPackages.test.ts`

**Interfaces:**
- Consumes: Task 1's widened CHECK (needed only at insert time, in Task 4).
- Produces:
  - `export const BUILTIN_EDR_PROVIDERS: readonly ['huntress', 'sentinelone']`
  - `export type BuiltinEdrProvider = 'huntress' | 'sentinelone'`
  - `export const BUILTIN_PROVIDERS: readonly ['huntress', 'sentinelone', 'hp_cmsl']`
  - `export type BuiltinProvider = 'huntress' | 'sentinelone' | 'hp_cmsl'`
  - `export interface BuiltinInstallMethodDef { platform: 'windows' | 'macos'; kind: 'winget' | 'homebrew_cask' | 'homebrew_formula'; packageId: string }`
  - `export type BuiltinPackageDef` — discriminated on `installSource: 'derived_url' | 'partner_upload' | 'package_manager'`. **`requiresBinaryUpload` is removed.**
  - `BUILTIN_PACKAGES.hp_cmsl` with `installMethod = { platform: 'windows', kind: 'winget', packageId: 'HP.HPCMSL' }`
  - `getBuiltinPackage(provider: BuiltinProvider): BuiltinPackageDef` (unchanged signature, widened parameter)

- [ ] **Step 1: Write the failing tests**

Replace `apps/api/src/services/builtinDeploymentPackages.test.ts` in full:

```ts
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_EDR_PROVIDERS,
  BUILTIN_PACKAGES,
  BUILTIN_PROVIDERS,
  getBuiltinPackage,
} from './builtinDeploymentPackages';

// Note: the DB-backed ensureBuiltinPackage tests live in
// src/__tests__/integration/builtinDeploymentPackages.integration.test.ts and
// src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts
// (real partner fixture, runs as breeze_app). This file stays pure-unit.

describe('builtin deployment packages', () => {
  it('defines a Windows-only Huntress package with derivable URL + keys', () => {
    const pkg = getBuiltinPackage('huntress');
    expect(pkg.installSource).toBe('derived_url');
    expect(pkg.vendor).toBe('Huntress');
    if (pkg.installSource !== 'derived_url') throw new Error('narrowing failed');
    expect(pkg.fileType).toBe('exe');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.downloadUrlTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_acct_key}');
    expect(pkg.silentInstallArgsTemplate).toContain('{huntress_org_key}');
    // Moved off the provisioner's hardcode (spec "Also noted", :112) and onto
    // the definition, so the next derived-URL package can't inherit it.
    expect(pkg.originalFileName).toBe('HuntressInstaller.exe');
  });

  it('defines a SentinelOne package that needs a binary upload and a site token', () => {
    const pkg = getBuiltinPackage('sentinelone');
    expect(pkg.installSource).toBe('partner_upload');
    expect(pkg.vendor).toBe('SentinelOne');
    if (pkg.installSource !== 'partner_upload') throw new Error('narrowing failed');
    expect(pkg.fileType).toBe('msi');
    expect(pkg.supportedOs).toEqual(['windows']);
    expect(pkg.silentInstallArgsTemplate).toContain('{s1_site_token}');
  });

  it('defines HP CMSL as a package-manager built-in with no URL and no upload', () => {
    const pkg = getBuiltinPackage('hp_cmsl');
    expect(pkg.installSource).toBe('package_manager');
    expect(pkg.vendor).toBe('HP Inc.');
    if (pkg.installSource !== 'package_manager') throw new Error('narrowing failed');
    expect(pkg.installMethod).toEqual({
      platform: 'windows',
      kind: 'winget',
      packageId: 'HP.HPCMSL',
    });
    // EULA: Breeze never hosts or mirrors the CMSL installer, so there is no
    // downloadUrlTemplate and no artifact metadata on this arm at all.
    expect(pkg).not.toHaveProperty('downloadUrlTemplate');
    expect(pkg).not.toHaveProperty('fileType');
    expect(pkg).not.toHaveProperty('silentInstallArgsTemplate');
  });

  it('exposes all three providers, with the EDR pair as a strict subset', () => {
    expect(Object.keys(BUILTIN_PACKAGES).sort()).toEqual([
      'hp_cmsl',
      'huntress',
      'sentinelone',
    ]);
    expect([...BUILTIN_PROVIDERS].sort()).toEqual(['hp_cmsl', 'huntress', 'sentinelone']);
    expect([...BUILTIN_EDR_PROVIDERS].sort()).toEqual(['huntress', 'sentinelone']);
    for (const p of BUILTIN_EDR_PROVIDERS) {
      expect(BUILTIN_PROVIDERS).toContain(p);
    }
    // hp_cmsl is a built-in but NOT an EDR provider — this is the whole point of
    // the split (edrInstallerResolver is typed against BuiltinEdrProvider).
    expect(BUILTIN_EDR_PROVIDERS as readonly string[]).not.toContain('hp_cmsl');
  });

  it('keys every registry entry by its own provider value', () => {
    for (const provider of BUILTIN_PROVIDERS) {
      expect(BUILTIN_PACKAGES[provider].provider).toBe(provider);
    }
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd apps/api && npx vitest run src/services/builtinDeploymentPackages.test.ts
```

Expected: FAIL — the import of `BUILTIN_EDR_PROVIDERS` / `BUILTIN_PROVIDERS` is undefined, `getBuiltinPackage('hp_cmsl')` is a type error and returns `undefined` at runtime, and `Object.keys(BUILTIN_PACKAGES).sort()` is `['huntress','sentinelone']`.

- [ ] **Step 3: Replace the type block and registry**

Replace `apps/api/src/services/builtinDeploymentPackages.ts:1-58` (everything from the imports down to and including `getBuiltinPackage`) with:

```ts
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { softwareCatalog, softwareInstallMethods, softwareVersions } from '../db/schema';

/**
 * Built-in providers whose installer is a BINARY and whose per-org secrets are
 * resolved server-side at dispatch (services/edrInstallerResolver.ts).
 *
 * Keep this set narrow. `resolveEdrInstaller` is typed against it, so a built-in
 * that has no credentials can never be routed into EDR secret resolution by
 * accident — which is exactly what a single widened `BuiltinProvider` would have
 * allowed, silently, via that function's `return resolveSentinelOne(params)`
 * fall-through.
 */
export const BUILTIN_EDR_PROVIDERS = ['huntress', 'sentinelone'] as const;
export type BuiltinEdrProvider = (typeof BUILTIN_EDR_PROVIDERS)[number];

/**
 * Every built-in provider. `hp_cmsl` (feature #5511) is a package-manager
 * built-in: HP's Client Management Script Library, installed by the winget
 * package id `HP.HPCMSL`. It carries no installer URL, no uploaded binary and
 * no credentials, so it is deliberately NOT a BuiltinEdrProvider.
 *
 * EULA CONSTRAINT — do not "optimise" this away. HP's CMSL licence states
 * verbatim: "You do not have the right to distribute the Software Product."
 * Breeze must NEVER mirror or host the CMSL installer. That rules out serving
 * it through the pinned-artifact pattern in routes/agents/wingetBootstrap.ts.
 * Installing via winget (or an HP-hosted URL) satisfies the licence because the
 * bytes come from HP. A future change that copies the installer into S3, into
 * the winget-bootstrap artifact set, or into any Breeze-served path is a licence
 * violation, not a performance win.
 */
export const BUILTIN_PROVIDERS = [...BUILTIN_EDR_PROVIDERS, 'hp_cmsl'] as const;
export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];

/** Identity fields every built-in carries, whatever its install shape. */
interface BuiltinPackageIdentity {
  provider: BuiltinProvider;
  name: string;
  vendor: string;
  category: string;
  iconUrl?: string;
  websiteUrl?: string;
}

/** Fields that only mean anything when there IS an installer artifact. */
interface BuiltinArtifactFields {
  fileType: string;
  supportedOs: string[];
  silentInstallArgsTemplate: string;
}

/** One package-manager install method, mirroring a software_install_methods row. */
export interface BuiltinInstallMethodDef {
  platform: 'windows' | 'macos';
  kind: 'winget' | 'homebrew_cask' | 'homebrew_formula';
  packageId: string;
}

/**
 * Discriminated on `installSource` so all THREE valid shapes can't drift:
 *  - 'derived_url'     → installer URL is derivable from per-org secrets; a
 *                        templated software_versions row is created (Huntress)
 *  - 'partner_upload'  → no derivable URL; the partner uploads the binary and
 *                        the version row appears then (SentinelOne)
 *  - 'package_manager' → no URL and no upload at all; a software_install_methods
 *                        row carries the package id (HP CMSL / winget)
 *
 * The previous discriminant was the boolean `requiresBinaryUpload`, which cannot
 * express a third arm. It is gone; `installSource` replaces it. The artifact
 * fields (fileType / supportedOs / silentInstallArgsTemplate) live only on the
 * two artifact arms — a winget package has no file, no silent-install args and
 * no per-OS artifact list.
 */
export type BuiltinPackageDef =
  | (BuiltinPackageIdentity & BuiltinArtifactFields & {
      installSource: 'derived_url';
      downloadUrlTemplate: string;
      /**
       * Filename stamped on the templated version row. Provider-specific: it
       * used to be hardcoded to 'HuntressInstaller.exe' inside an otherwise
       * provider-generic branch of ensureBuiltinPackage (the trap the spec's
       * "Also noted, not blocking" section names). It lives on the definition
       * now so the next derived-URL package cannot inherit Huntress's filename.
       */
      originalFileName: string;
    })
  | (BuiltinPackageIdentity & BuiltinArtifactFields & {
      installSource: 'partner_upload';
      downloadUrlTemplate?: never;
    })
  | (BuiltinPackageIdentity & {
      installSource: 'package_manager';
      installMethod: BuiltinInstallMethodDef;
      downloadUrlTemplate?: never;
    });

export const BUILTIN_PACKAGES: Record<BuiltinProvider, BuiltinPackageDef> = {
  huntress: {
    provider: 'huntress',
    name: 'Huntress EDR Agent',
    vendor: 'Huntress',
    category: 'security',
    websiteUrl: 'https://www.huntress.com',
    installSource: 'derived_url',
    fileType: 'exe',
    supportedOs: ['windows'],
    downloadUrlTemplate:
      'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe',
    silentInstallArgsTemplate:
      '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S',
    originalFileName: 'HuntressInstaller.exe',
  },
  sentinelone: {
    provider: 'sentinelone',
    name: 'SentinelOne Agent',
    vendor: 'SentinelOne',
    category: 'security',
    websiteUrl: 'https://www.sentinelone.com',
    installSource: 'partner_upload',
    fileType: 'msi',
    supportedOs: ['windows'],
    silentInstallArgsTemplate: 'SITE_TOKEN={s1_site_token} /q /NORESTART',
  },
  hp_cmsl: {
    provider: 'hp_cmsl',
    name: 'HP Client Management Script Library',
    vendor: 'HP Inc.',
    // 'utility' is a member of the catalog's category enum
    // (routes/software.ts:461-464), so the category filter keeps working.
    category: 'utility',
    websiteUrl:
      'https://developers.hp.com/hp-client-management/doc/client-management-script-library',
    installSource: 'package_manager',
    installMethod: { platform: 'windows', kind: 'winget', packageId: 'HP.HPCMSL' },
  },
};

export function getBuiltinPackage(provider: BuiltinProvider): BuiltinPackageDef {
  return BUILTIN_PACKAGES[provider];
}
```

- [ ] **Step 4: Fix the one existing consumer of `requiresBinaryUpload`**

In the same file, `ensureBuiltinPackage`'s version branch currently reads `if (!def.requiresBinaryUpload && def.downloadUrlTemplate) {`. Change that line and the hardcoded filename:

```ts
      // Templated version only when the binary URL is derivable (Huntress).
      if (def.installSource === 'derived_url') {
```

```ts
            originalFileName: def.originalFileName,
```

(The `package_manager` branch is added in Task 4; this step only keeps the file compiling.)

- [ ] **Step 5: Run the tests, expect PASS**

```bash
cd apps/api && npx vitest run src/services/builtinDeploymentPackages.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Typecheck — expect ONE remaining error, in `edrInstallerResolver.ts`**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: clean **except** nothing yet — `resolveEdrInstaller`'s `provider: BuiltinProvider` still compiles, it has just silently widened. That is precisely the trap Task 3 closes; do not stop here.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/builtinDeploymentPackages.ts apps/api/src/services/builtinDeploymentPackages.test.ts
git commit -m "feat(software): three-armed BuiltinPackageDef with an hp_cmsl package-manager arm (#5515)"
```

---

### Task 3: Narrow `resolveEdrInstaller` to `BuiltinEdrProvider`, and pin the dispatch path

**Files:**
- Modify: `apps/api/src/services/edrInstallerResolver.ts:5,54-62`
- Test: `apps/api/src/services/edrInstallerResolver.test.ts`
- Test: `apps/api/src/services/softwareDeployment.test.ts`

**Interfaces:**
- Consumes: `BuiltinEdrProvider` from Task 2.
- Produces: `resolveEdrInstaller(params: { provider: BuiltinEdrProvider; orgId: string; downloadUrlTemplate: string | null; silentInstallArgsTemplate: string | null })` — same return type; a non-EDR provider is now a **compile error**, and (if forced through with a cast) a **throw**, never a silent SentinelOne resolution.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/edrInstallerResolver.test.ts`:

```ts
import { resolveEdrInstaller } from './edrInstallerResolver';
import type { BuiltinEdrProvider } from './builtinDeploymentPackages';

describe('resolveEdrInstaller provider exhaustiveness', () => {
  it('throws rather than silently resolving a non-EDR built-in as SentinelOne', async () => {
    // hp_cmsl is a BuiltinProvider but NOT a BuiltinEdrProvider, so this cast is
    // the only way to get it here. Before the exhaustive switch, the function's
    // `return resolveSentinelOne(params)` fall-through accepted it — an HP
    // package would have been handed SentinelOne's site-token resolver.
    await expect(
      resolveEdrInstaller({
        provider: 'hp_cmsl' as unknown as BuiltinEdrProvider,
        orgId: '00000000-0000-4000-8000-000000000001',
        downloadUrlTemplate: null,
        silentInstallArgsTemplate: null,
      }),
    ).rejects.toThrow(/unhandled EDR provider: hp_cmsl/);
  });
});
```

And append to the manager-dispatch describe block in `apps/api/src/services/softwareDeployment.test.ts` (the block that starts at `:1900` and defines `primeSelects`), a regression that fixes today's structural behaviour in place:

```ts
  it('never resolves EDR secrets for an hp_cmsl built-in on the manager path', async () => {
    resolveEdrMock.mockClear();
    // Same shape as wingetMethod, but the catalog item is the HP CMSL built-in.
    // primeSelects primes: install method -> catalog item -> devices.
    selectMock
      .mockReturnValueOnce(sel([{ ...wingetMethod, packageId: 'HP.HPCMSL' }]))
      .mockReturnValueOnce(sel([{ name: 'HP Client Management Script Library', integrationProvider: 'hp_cmsl' }]))
      .mockReturnValueOnce(sel([{ id: 'dev-1', agentId: 'agent-1', osType: 'windows' }]));
    insertMock.mockReturnValueOnce(insCapture([deployment])).mockReturnValueOnce(ins());

    const result = await createSoftwareDeployment({
      orgId: 'org-1',
      installMethodId: 'method-win',
      deploymentType: 'install',
      deviceIds: ['dev-1'],
      scheduleType: 'immediate',
      createdBy: null,
      name: 'HP CMSL',
    });

    expect(result.status).toBe('pending');
    // buildAndDispatchSoftwareInstalls returns at the `if (installMethod)`
    // branch (softwareDeployment.ts:524-526), BEFORE the EDR branch at :558.
    // If a future refactor moves the EDR check above that return, this fails.
    expect(resolveEdrMock).not.toHaveBeenCalled();
    const payload = dispatchDeviceCommandMock.mock.calls[0]![0].payload;
    expect(payload.installMethod).toEqual({ kind: 'winget', packageId: 'HP.HPCMSL' });
    expect(payload).not.toHaveProperty('downloadUrl');
  });
```

- [ ] **Step 2: Run them, expect the first to FAIL and the second to PASS**

```bash
cd apps/api && npx vitest run src/services/edrInstallerResolver.test.ts src/services/softwareDeployment.test.ts
```

Expected:
- `edrInstallerResolver.test.ts` → **FAIL**: the promise resolves (or rejects with a DB error from the empty `db: {}` mock) instead of throwing `unhandled EDR provider: hp_cmsl`. Record the actual failure text — it is what proves the fall-through exists.
- `softwareDeployment.test.ts` → **PASS**. That is expected and correct: this assertion documents a structural property that already holds; it is a regression fence, not a red-first driver. Do not manufacture a fake red for it.

- [ ] **Step 3: Implement the exhaustive switch**

In `apps/api/src/services/edrInstallerResolver.ts`, change the import at `:5`:

```ts
import type { BuiltinEdrProvider } from './builtinDeploymentPackages';
```

and replace `:54-62`:

```ts
/**
 * Resolve the per-org installer URL + silent args for a credential-backed
 * built-in EDR package.
 *
 * The parameter is `BuiltinEdrProvider`, NOT `BuiltinProvider`: HP CMSL and any
 * future non-credential built-in must never reach here. This used to end in a
 * bare `return resolveSentinelOne(params)`, so widening the provider union
 * would have routed a new provider into SentinelOne's site-token resolver with
 * no compile error and no runtime complaint.
 */
export async function resolveEdrInstaller(params: {
  provider: BuiltinEdrProvider;
  orgId: string;
  downloadUrlTemplate: string | null;
  silentInstallArgsTemplate: string | null;
}): Promise<ResolvedInstaller | EdrResolveError> {
  switch (params.provider) {
    case 'huntress':
      return resolveHuntress(params);
    case 'sentinelone':
      return resolveSentinelOne(params);
    default: {
      // Exhaustiveness fence: adding a BuiltinEdrProvider without a branch here
      // is a COMPILE error, not a silent fall-through.
      const unreachable: never = params.provider;
      throw new Error(`resolveEdrInstaller: unhandled EDR provider: ${String(unreachable)}`);
    }
  }
}
```

- [ ] **Step 4: Run both files, expect PASS**

```bash
cd apps/api && npx vitest run src/services/edrInstallerResolver.test.ts src/services/softwareDeployment.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: clean. `softwareDeployment.ts:558-563` passes a narrowed `'huntress' | 'sentinelone'` literal (the `if` at `:558-561` proves it), so the call site still type-checks against the narrower parameter.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/edrInstallerResolver.ts apps/api/src/services/edrInstallerResolver.test.ts apps/api/src/services/softwareDeployment.test.ts
git commit -m "fix(software): type EDR resolution against BuiltinEdrProvider with an exhaustive switch (#5515)"
```

---

### Task 4: `ensureBuiltinPackage` — the `package_manager` provisioning branch

**Files:**
- Modify: `apps/api/src/services/builtinDeploymentPackages.ts` (`ensureBuiltinPackage` body)
- Create: `apps/api/src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts`
- Test (modify): `apps/api/src/__tests__/integration/builtinDeploymentPackages.integration.test.ts`

**Interfaces:**
- Consumes: `BUILTIN_PACKAGES.hp_cmsl` (Task 2), the widened CHECK (Task 1).
- Produces: `ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId })` → `{ catalogId: string }`, having ensured exactly one `software_catalog` row (`org_id NULL`, `partner_id` set, `integration_provider = 'hp_cmsl'`, `is_managed = true`) **and** exactly one `software_install_methods` row (`platform 'windows'`, `kind 'winget'`, `package_id 'HP.HPCMSL'`, `enabled true`), repaired to the built-in definition on every call.

**DECISION — the install-method API boundary (the spec asks for this explicitly): the system provisioner inserts directly, and the route's built-in rejection becomes absolute across POST, PATCH and DELETE (Task 5).** Reasons, in order of weight:

1. **A built-in's definition is server-owned, and an editable install method makes it caller-owned.** The `software_catalog` row is already written under system DB context and is already un-editable and un-deletable through the API for non-system scope (`software.ts:939`, `:978`). An install method is not metadata about the built-in — it *is* the built-in's payload. Letting `POST`/`PATCH` write it would let a partner admin with `devices.write` + MFA retarget "HP CMSL" at any winget package id, and that package would then be installed on every device the HP policy reaches. That is a privilege problem, not a hypothetical.
2. **The relaxation would have to be scope-gated, and there is no scope that wants it.** A `system`-scope exception would be dead code (nothing calls it); a `partner`-scope exception is exactly the hole in (1).
3. **The provisioner is already the idempotent repair path.** Making it upsert (below) means an out-of-band edit is corrected on the next enable, which a route-based exception could not offer.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts`:

```ts
/**
 * Integration test for the HP CMSL built-in package (feature #5511 W04, #5515).
 *
 * hp_cmsl is the first `installSource: 'package_manager'` built-in: it creates a
 * PARTNER-scoped software_catalog row (org_id NULL, partner_id set,
 * integration_provider 'hp_cmsl') and one software_install_methods row carrying
 * the winget package id — and NO software_versions row, because Breeze never
 * hosts or mirrors the CMSL installer (HP's licence: "You do not have the right
 * to distribute the Software Product").
 *
 * Runs as breeze_app so RLS, the widened
 * software_catalog_integration_provider_chk, and the parent-FK-join policies on
 * software_install_methods are all genuinely exercised.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { softwareCatalog, softwareInstallMethods, softwareVersions } from '../../db/schema';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { createPartner } from './db-utils';

describe('ensureBuiltinPackage — hp_cmsl (db)', () => {
  it('creates one catalog row and one winget install method, and no version row', async () => {
    const partner = await createPartner();

    const { catalogId } = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });

    const { catalogRows, methods, versions } = await withSystemDbAccessContext(async () => {
      const catalogRows = await db
        .select()
        .from(softwareCatalog)
        .where(and(
          eq(softwareCatalog.partnerId, partner.id),
          eq(softwareCatalog.integrationProvider, 'hp_cmsl'),
        ));
      const methods = await db
        .select()
        .from(softwareInstallMethods)
        .where(eq(softwareInstallMethods.catalogId, catalogId));
      const versions = await db
        .select()
        .from(softwareVersions)
        .where(eq(softwareVersions.catalogId, catalogId));
      return { catalogRows, methods, versions };
    });

    expect(catalogRows).toHaveLength(1);
    expect(catalogRows[0]!.orgId).toBeNull();
    expect(catalogRows[0]!.isManaged).toBe(true);
    expect(catalogRows[0]!.vendor).toBe('HP Inc.');

    expect(methods).toHaveLength(1);
    expect(methods[0]!.platform).toBe('windows');
    expect(methods[0]!.kind).toBe('winget');
    expect(methods[0]!.packageId).toBe('HP.HPCMSL');
    expect(methods[0]!.enabled).toBe(true);

    // Breeze never hosts the installer — no artifact row of any kind.
    expect(versions).toHaveLength(0);
  });

  it('is idempotent: a second call reuses the catalog row and adds no second method', async () => {
    const partner = await createPartner();

    const first = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });
    const second = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });
    expect(second.catalogId).toBe(first.catalogId);

    const methods = await withSystemDbAccessContext(() =>
      db.select().from(softwareInstallMethods).where(eq(softwareInstallMethods.catalogId, first.catalogId)),
    );
    expect(methods).toHaveLength(1);
  });

  it('repairs an out-of-band edit to the install method on the next call', async () => {
    const partner = await createPartner();
    const { catalogId } = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });

    // Simulate a partner admin retargeting the built-in through the API before
    // Task 5's guard existed (RLS allows a partner-scoped UPDATE on this table).
    await withSystemDbAccessContext(() =>
      db
        .update(softwareInstallMethods)
        .set({ packageId: 'Evil.Package', enabled: false })
        .where(eq(softwareInstallMethods.catalogId, catalogId)),
    );

    await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });

    const methods = await withSystemDbAccessContext(() =>
      db.select().from(softwareInstallMethods).where(eq(softwareInstallMethods.catalogId, catalogId)),
    );
    expect(methods).toHaveLength(1);
    expect(methods[0]!.packageId).toBe('HP.HPCMSL');
    expect(methods[0]!.enabled).toBe(true);
  });
});
```

Also extend `apps/api/src/__tests__/integration/builtinDeploymentPackages.integration.test.ts` so the two artifact arms are pinned as *not* creating install methods. Add inside its `describe`:

```ts
  it('creates no install method for the artifact-shaped built-ins', async () => {
    const partner = await createPartner();

    const huntress = await ensureBuiltinPackage({ provider: 'huntress', partnerId: partner.id });
    const s1 = await ensureBuiltinPackage({ provider: 'sentinelone', partnerId: partner.id });

    const methods = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(softwareInstallMethods)
        .where(inArray(softwareInstallMethods.catalogId, [huntress.catalogId, s1.catalogId])),
    );
    expect(methods).toHaveLength(0);
  });
```

and widen that file's imports to `import { and, eq, inArray } from 'drizzle-orm';` and `import { softwareCatalog, softwareInstallMethods, softwareVersions } from '../../db/schema';`.

- [ ] **Step 2: Run them, expect FAIL**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts \
  src/__tests__/integration/builtinDeploymentPackages.integration.test.ts
```

Requires a live test database — bring up `docker-compose.test.yml` first if it is not running (the suite defaults `DATABASE_URL` to `postgresql://breeze_test:breeze_test@localhost:5433/breeze_test`). Expected: the three `hp_cmsl` tests FAIL (no install-method row is created); the artifact-arm test PASSES.

- [ ] **Step 3: Add the `package_manager` branch**

In `apps/api/src/services/builtinDeploymentPackages.ts`, immediately after the `installSource === 'derived_url'` block and before `return { catalogId };`:

```ts
      if (def.installSource === 'package_manager') {
        // Re-asserted on EVERY call, not only at creation. The install method is
        // the entire definition of a package-manager built-in — it is what the
        // agent is told to install — so it is server-owned state, not a
        // user-editable row. routes/softwareInstallMethods.ts refuses to create,
        // edit or delete methods on built-in catalog items; this upsert is the
        // repair path for anything that got through before that guard existed,
        // or through a direct DB edit.
        //
        // onConflictDoUpdate keys on the shipped unique index
        // software_install_methods_catalog_platform_kind_uq
        // (2026-08-16-a-software-install-methods.sql:48-49).
        await db
          .insert(softwareInstallMethods)
          .values({
            catalogId,
            platform: def.installMethod.platform,
            kind: def.installMethod.kind,
            packageId: def.installMethod.packageId,
            enabled: true,
          })
          .onConflictDoUpdate({
            target: [
              softwareInstallMethods.catalogId,
              softwareInstallMethods.platform,
              softwareInstallMethods.kind,
            ],
            set: { packageId: def.installMethod.packageId, enabled: true },
          });
      }
```

Also update the function's doc comment (`:60-65`) to describe all three shapes:

```ts
/**
 * Idempotently upsert the partner-scoped built-in package and whatever its
 * install shape needs:
 *   - 'derived_url'     → a templated software_versions row (Huntress)
 *   - 'partner_upload'  → nothing else; the partner uploads the binary later
 *   - 'package_manager' → one software_install_methods row, re-asserted on
 *                         every call (HP CMSL / winget)
 *
 * Safe to call on every integration connect, and on every HP CMSL opt-in. Runs
 * in a system DB context because the caller's request scope is partner- or
 * org-level and we are writing partner-axis rows; breeze_has_partner_access
 * short-circuits to TRUE under system scope
 * (2026-04-11-partners-rls.sql:63-67), which is what lets the
 * software_install_methods INSERT policy pass.
 */
```

- [ ] **Step 4: Run the integration tests, expect PASS**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts \
  src/__tests__/integration/builtinDeploymentPackages.integration.test.ts
```

Expected: PASS, all five tests.

- [ ] **Step 5: Re-run the unit suite and typecheck**

```bash
cd apps/api && npx vitest run src/services/builtinDeploymentPackages.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/builtinDeploymentPackages.ts \
        apps/api/src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts \
        apps/api/src/__tests__/integration/builtinDeploymentPackages.integration.test.ts
git commit -m "feat(software): provision the HP CMSL winget install method from ensureBuiltinPackage (#5515)"
```

---

### Task 5: Make the built-in install-method rejection absolute (POST + PATCH + DELETE)

**Files:**
- Modify: `apps/api/src/routes/softwareInstallMethods.ts:112-114` (POST), `:150-158` (PATCH), `:277-285` (DELETE)
- Test: `apps/api/src/routes/softwareInstallMethods.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is an independent hardening of the boundary Task 4's decision relies on).
- Produces: `BUILTIN_INSTALL_METHOD_DENIED` (module-private const) applied at all three write verbs; any request naming a catalog row with a non-null `integration_provider` gets `400 { error: 'Built-in packages cannot carry install methods' }` before any DB write.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/softwareInstallMethods.test.ts`, inside the `PATCH` describe (after `:325`):

```ts
    it('rejects updating a method on a built-in item (integrationProvider set)', async () => {
      // Regression for #5515: only POST carried this guard. A partner-scoped
      // caller passes both loadOwnedCatalogItem (built-ins have org_id NULL) and
      // the RLS UPDATE policy (breeze_has_partner_access on the parent's
      // partner_id), so this route could retarget a server-provisioned built-in
      // — e.g. the HP CMSL winget package id — at anything.
      vi.mocked(db.select)
        .mockReturnValueOnce(chainMock([ownedCatalogItem({ orgId: null, integrationProvider: 'hp_cmsl' })]) as any)
        .mockReturnValueOnce(chainMock([installedMethod({ packageId: 'HP.HPCMSL' })]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods/${METHOD_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ packageId: 'Evil.Package' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Built-in packages cannot carry install methods/);
      expect(db.update).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
```

and inside the `DELETE` describe (after `:360`):

```ts
    it('rejects deleting a method on a built-in item (integrationProvider set)', async () => {
      // Same regression as the PATCH case: deleting the HP CMSL winget method
      // would leave the built-in undeployable until the next provisioning call.
      vi.mocked(db.select)
        .mockReturnValueOnce(chainMock([ownedCatalogItem({ orgId: null, integrationProvider: 'hp_cmsl' })]) as any)
        .mockReturnValueOnce(chainMock([installedMethod({ packageId: 'HP.HPCMSL' })]) as any);

      const res = await app.request(`/software/catalog/${CATALOG_ID}/install-methods/${METHOD_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Built-in packages cannot carry install methods/);
      expect(db.delete).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
cd apps/api && npx vitest run src/routes/softwareInstallMethods.test.ts
```

Expected: both new tests FAIL with `expected 200 to be 400` (the PATCH succeeds and calls `db.update`; the DELETE succeeds and calls `db.delete`).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/softwareInstallMethods.ts`, add above `loadOwnedCatalogItem` (`:69`):

```ts
/**
 * Built-in (integration-provider) catalog rows are SERVER-provisioned: their
 * install methods are written by ensureBuiltinPackage under system DB context
 * and re-asserted on every provisioning call
 * (services/builtinDeploymentPackages.ts). Creating, editing or deleting them
 * through this router would let a partner admin with devices.write + MFA
 * retarget a built-in at an arbitrary winget package id — installing anything
 * they like on every device that built-in's policy reaches.
 *
 * RLS does NOT close this on its own: the UPDATE/DELETE policies on
 * software_install_methods (2026-08-16-a-software-install-methods.sql:89-119)
 * admit `sc.partner_id IS NOT NULL AND breeze_has_partner_access(sc.partner_id)`,
 * which is TRUE for a partner-scoped caller against a partner-owned built-in.
 * (Org-scoped callers are already blocked there: breeze_has_org_access(NULL) and
 * breeze_has_partner_access(P) are both FALSE for an org token.)
 *
 * The string is unchanged from the original POST-only guard so existing clients
 * and tests keep matching on it.
 */
const BUILTIN_INSTALL_METHOD_DENIED = 'Built-in packages cannot carry install methods';
```

Replace the POST guard at `:112-114` with the shared constant:

```ts
    if (item.integrationProvider !== null) {
      return c.json({ error: BUILTIN_INSTALL_METHOD_DENIED }, 400);
    }
```

Add the same three lines to PATCH, immediately after its `if (!item) return c.json({ error: 'Catalog item not found or access denied' }, 404);` (currently `:155`) and **before** `loadInstallMethod`:

```ts
    if (item.integrationProvider !== null) {
      return c.json({ error: BUILTIN_INSTALL_METHOD_DENIED }, 400);
    }
```

And to DELETE, immediately after its `if (!item) ...` (currently `:282`) and before `loadInstallMethod`:

```ts
    if (item.integrationProvider !== null) {
      return c.json({ error: BUILTIN_INSTALL_METHOD_DENIED }, 400);
    }
```

> The new tests prime **two** `db.select` calls each, so placing the guard before `loadInstallMethod` leaves the second mock unconsumed — harmless, and it keeps the fixtures readable if the guard ever moves.

- [ ] **Step 4: Run, expect PASS**

```bash
cd apps/api && npx vitest run src/routes/softwareInstallMethods.test.ts
```

Expected: PASS, including the pre-existing POST rejection test at `:241-252`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/softwareInstallMethods.ts apps/api/src/routes/softwareInstallMethods.test.ts
git commit -m "fix(software): refuse install-method PATCH/DELETE on built-in catalog items (#5515)"
```

---

### Task 6: Provision the HP CMSL package when a warranty policy turns `hpCmsl` on

**Files:**
- Create: `apps/api/src/services/hpCmslProvisioning.ts`
- Create: `apps/api/src/services/hpCmslProvisioning.test.ts`
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts` (POST tail `:294-307`, PATCH tail `:469-480`)

**Interfaces:**
- Consumes: `ensureBuiltinPackage` (Task 4); W02's `hpCmsl` inline-settings block on the `warranty` feature link (contract D1: `{ enabled: boolean; consent?: {...} }`).
- Produces:
  - `export function warrantyLinkEnablesHpCmsl(inlineSettings: unknown): boolean`
  - `export async function provisionHpCmslForFeatureLink(input: { featureType: string; inlineSettings: unknown; policyPartnerId: string | null; authPartnerId: string | null; policyOrgId: string | null }): Promise<void>` — fire-and-forget, never throws.

**Why here.** `ensureBuiltinPackage` has exactly two call sites today, both "the partner just connected the thing this package belongs to" (`huntress.ts:456`, `sentinelOne.ts:435`). HP has no integration to connect; the equivalent moment is the partner (or org) turning `hpCmsl.enabled` on for a warranty feature link, which is also the moment W02 records the EULA consent. Provisioning earlier would put a 100 MB HP module in every partner's catalog unasked; provisioning later would mean the policy in Task 9 references a catalog item that does not exist.

**Why duck-typed.** W02 (#5513) owns `WarrantyHpCmslSettings` and lands before this wave, but its export name is not pinned by the contract (D1 gives the shape, not the module). `warrantyLinkEnablesHpCmsl` reads the shape D1 specifies without importing W02's type, so a rename in W02 cannot silently disable provisioning. If W02 exported the type under a stable name, importing it is a fine follow-up — the predicate's behaviour must not change either way.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/hpCmslProvisioning.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ensureBuiltinPackageMock } = vi.hoisted(() => ({ ensureBuiltinPackageMock: vi.fn() }));
vi.mock('./builtinDeploymentPackages', () => ({ ensureBuiltinPackage: ensureBuiltinPackageMock }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { provisionHpCmslForFeatureLink, warrantyLinkEnablesHpCmsl } from './hpCmslProvisioning';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

describe('warrantyLinkEnablesHpCmsl', () => {
  it('is true only for an explicit hpCmsl.enabled === true', () => {
    expect(warrantyLinkEnablesHpCmsl({ hpCmsl: { enabled: true } })).toBe(true);
  });

  it('is false for every other shape', () => {
    expect(warrantyLinkEnablesHpCmsl(null)).toBe(false);
    expect(warrantyLinkEnablesHpCmsl(undefined)).toBe(false);
    expect(warrantyLinkEnablesHpCmsl({})).toBe(false);
    expect(warrantyLinkEnablesHpCmsl({ hpCmsl: null })).toBe(false);
    expect(warrantyLinkEnablesHpCmsl({ hpCmsl: {} })).toBe(false);
    expect(warrantyLinkEnablesHpCmsl({ hpCmsl: { enabled: false } })).toBe(false);
    // Truthy-but-not-true must not arm it: the existing `enabled` on this block
    // means expiry ALERTING, and a coercing check would conflate the two.
    expect(warrantyLinkEnablesHpCmsl({ hpCmsl: { enabled: 'yes' } })).toBe(false);
    expect(warrantyLinkEnablesHpCmsl({ hpCmsl: { enabled: 1 } })).toBe(false);
    // The alerting flag on the OUTER block is not the collection flag.
    expect(warrantyLinkEnablesHpCmsl({ enabled: true })).toBe(false);
  });
});

describe('provisionHpCmslForFeatureLink', () => {
  beforeEach(() => {
    ensureBuiltinPackageMock.mockReset();
    ensureBuiltinPackageMock.mockResolvedValue({ catalogId: 'cat-1' });
  });

  it('provisions for a partner-wide warranty link using the policy partner', async () => {
    await provisionHpCmslForFeatureLink({
      featureType: 'warranty',
      inlineSettings: { hpCmsl: { enabled: true } },
      policyPartnerId: PARTNER,
      authPartnerId: null,
      policyOrgId: null,
    });
    expect(ensureBuiltinPackageMock).toHaveBeenCalledWith({ provider: 'hp_cmsl', partnerId: PARTNER });
  });

  it('falls back to the authenticated partner for an org-scoped policy', async () => {
    await provisionHpCmslForFeatureLink({
      featureType: 'warranty',
      inlineSettings: { hpCmsl: { enabled: true } },
      policyPartnerId: null,
      authPartnerId: PARTNER,
      policyOrgId: ORG,
    });
    expect(ensureBuiltinPackageMock).toHaveBeenCalledWith({ provider: 'hp_cmsl', partnerId: PARTNER });
  });

  it('does nothing for a non-warranty feature type', async () => {
    await provisionHpCmslForFeatureLink({
      featureType: 'patch',
      inlineSettings: { hpCmsl: { enabled: true } },
      policyPartnerId: PARTNER,
      authPartnerId: null,
      policyOrgId: null,
    });
    expect(ensureBuiltinPackageMock).not.toHaveBeenCalled();
  });

  it('does nothing when hpCmsl is off — turning it off never provisions', async () => {
    await provisionHpCmslForFeatureLink({
      featureType: 'warranty',
      inlineSettings: { hpCmsl: { enabled: false }, enabled: true, warnDays: 90 },
      policyPartnerId: PARTNER,
      authPartnerId: null,
      policyOrgId: null,
    });
    expect(ensureBuiltinPackageMock).not.toHaveBeenCalled();
  });

  it('does nothing when no partner can be resolved', async () => {
    await provisionHpCmslForFeatureLink({
      featureType: 'warranty',
      inlineSettings: { hpCmsl: { enabled: true } },
      policyPartnerId: null,
      authPartnerId: null,
      policyOrgId: ORG,
    });
    expect(ensureBuiltinPackageMock).not.toHaveBeenCalled();
  });

  it('never throws when provisioning fails — the policy write already succeeded', async () => {
    ensureBuiltinPackageMock.mockRejectedValue(new Error('boom'));
    await expect(
      provisionHpCmslForFeatureLink({
        featureType: 'warranty',
        inlineSettings: { hpCmsl: { enabled: true } },
        policyPartnerId: PARTNER,
        authPartnerId: null,
        policyOrgId: null,
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd apps/api && npx vitest run src/services/hpCmslProvisioning.test.ts
```

Expected: FAIL — `Failed to resolve import "./hpCmslProvisioning"`.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/hpCmslProvisioning.ts`:

```ts
import { ensureBuiltinPackage } from './builtinDeploymentPackages';
import { captureException } from './sentry';

/**
 * HP CMSL built-in provisioning, triggered from the `warranty` configuration
 * feature link (feature #5511 W04, #5515).
 *
 * HP has no integration to connect, so there is no equivalent of
 * huntress.ts:456 / sentinelOne.ts:435. The moment that means "this partner
 * wants HP CMSL" is the moment a warranty feature link's `hpCmsl.enabled` goes
 * true — which is also the moment W02 records the EULA consent. Provisioning
 * any earlier would push a ~100 MB HP module into every partner's catalog
 * unasked; any later and the software policy in W04 Task 9 would reference a
 * catalog item that does not exist.
 */

/**
 * True only when a warranty feature link's inline settings explicitly turn HP
 * CMSL COLLECTION on.
 *
 * Deliberately duck-typed against contract D1's shape rather than importing
 * W02's `WarrantyHpCmslSettings`: a rename over there must not silently stop
 * provisioning here.
 *
 * `=== true` and not a truthy check, on purpose. The warranty block already has
 * an outer `enabled` that means expiry ALERTING; conflating the two — or
 * accepting `'yes'` / `1` from a hand-rolled API client — would arm software
 * installation from a value that never meant that.
 */
export function warrantyLinkEnablesHpCmsl(inlineSettings: unknown): boolean {
  if (!inlineSettings || typeof inlineSettings !== 'object') return false;
  const hpCmsl = (inlineSettings as Record<string, unknown>).hpCmsl;
  if (!hpCmsl || typeof hpCmsl !== 'object') return false;
  return (hpCmsl as Record<string, unknown>).enabled === true;
}

/**
 * Ensure the partner's built-in HP CMSL catalog package exists, if this feature
 * link write turned HP CMSL on.
 *
 * Fire-and-forget by contract: the caller's policy write has ALREADY committed
 * by the time this runs, so a provisioning failure must never turn a successful
 * write into an error response. The package is re-ensured on every subsequent
 * enable, so a transient failure self-heals. Same shape as huntress.ts:454-461.
 *
 * MUST be called AFTER the feature-link write returns and OUTSIDE any request
 * transaction: ensureBuiltinPackage opens its own system DB context, and
 * nesting that inside the request's own withDbAccessContext transaction
 * double-holds a pooled connection (a hang at concurrency >= pool size).
 */
export async function provisionHpCmslForFeatureLink(input: {
  featureType: string;
  inlineSettings: unknown;
  /** configuration_policies.partner_id — set only for a partner-wide policy. */
  policyPartnerId: string | null;
  /** AuthContext.partnerId — present on org tokens too (middleware/auth.ts:95). */
  authPartnerId: string | null;
  /** configuration_policies.org_id — for the log line only. */
  policyOrgId: string | null;
}): Promise<void> {
  if (input.featureType !== 'warranty') return;
  if (!warrantyLinkEnablesHpCmsl(input.inlineSettings)) return;

  const partnerId = input.policyPartnerId ?? input.authPartnerId;
  if (!partnerId) {
    // A system-scope caller acting on an org-owned policy with no partner in
    // context. Say so rather than guessing an owner for a partner-axis row.
    console.warn(
      `[hp-cmsl] warranty link enabled hpCmsl for org ${input.policyOrgId ?? 'unknown'} but no partner is in context — built-in package not provisioned`,
    );
    return;
  }

  try {
    await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId });
  } catch (error) {
    console.error('[hp-cmsl] failed to provision the built-in HP CMSL package:', error);
    captureException(error instanceof Error ? error : new Error(String(error)));
    // Non-fatal: the policy is saved; the package is re-ensured on the next enable.
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

```bash
cd apps/api && npx vitest run src/services/hpCmslProvisioning.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Wire the two call sites**

In `apps/api/src/routes/configurationPolicies/featureLinks.ts`, add to the imports:

```ts
import { provisionHpCmslForFeatureLink } from '../../services/hpCmslProvisioning';
```

In the **POST** handler, between the `writeRouteAudit(...)` call (`:298-305`) and `return c.json(link, 201);` (`:307`):

```ts
    // #5515: enabling HP CMSL collection is what asks Breeze for the built-in HP
    // CMSL catalog package. Gated on the POST-WRITE state (`link`), not the
    // request body, and awaited AFTER addFeatureLink returned so this never runs
    // inside the write's own DB context. It never throws.
    await provisionHpCmslForFeatureLink({
      featureType: data.featureType,
      inlineSettings: link.inlineSettings,
      policyPartnerId: policy.partnerId ?? null,
      authPartnerId: auth.partnerId ?? null,
      policyOrgId: policy.orgId ?? null,
    });
```

In the **PATCH** handler, between its `writeRouteAudit(...)` (`:471-478`) and `return c.json(updated);` (`:480`):

```ts
    // Same trigger as the POST route: a PATCH that flips hpCmsl on is the same
    // event. Reads `updated` (post-write state), not `data`, because a PATCH
    // body may be partial.
    await provisionHpCmslForFeatureLink({
      featureType: existingLink.featureType,
      inlineSettings: updated.inlineSettings,
      policyPartnerId: policy.partnerId ?? null,
      authPartnerId: auth.partnerId ?? null,
      policyOrgId: policy.orgId ?? null,
    });
```

- [ ] **Step 6: Run the feature-link route suite and typecheck**

```bash
cd apps/api && npx vitest run src/routes/configurationPolicies
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: PASS / clean. If any existing feature-link test mocks `../../services/hpCmslProvisioning` implicitly by mocking the whole services directory, add an explicit `vi.mock('../../services/hpCmslProvisioning', () => ({ provisionHpCmslForFeatureLink: vi.fn() }))` to that file — the new import must not drag `ensureBuiltinPackage`'s real DB access into a unit test. Check the reported file count: `src/routes/configurationPolicies` is a substring filter, not a directory glob.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/hpCmslProvisioning.ts \
        apps/api/src/services/hpCmslProvisioning.test.ts \
        apps/api/src/routes/configurationPolicies/featureLinks.ts
git commit -m "feat(warranty): provision the HP CMSL built-in when a warranty link enables hpCmsl (#5515)"
```

---

### Task 7: Web — split the provider taxonomy so HP is a built-in but not an EDR provider

**Files:**
- Modify: `apps/web/src/components/software/providerBranding.ts`
- Modify: `apps/web/src/components/software/useEdrReadiness.ts:1-3,123-135,137-155`
- Test: `apps/web/src/components/software/providerBranding.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the web reads `integrationProvider` off the API's existing catalog feed).
- Produces:
  - `export const EDR_PROVIDERS: readonly ['huntress', 'sentinelone']`
  - `export type EdrProvider = 'huntress' | 'sentinelone'`
  - `export const INTEGRATION_PROVIDERS: readonly ['huntress', 'sentinelone', 'hp_cmsl']`
  - `export type IntegrationProvider = 'huntress' | 'sentinelone' | 'hp_cmsl'`
  - `export function isEdrProvider(v: unknown): v is EdrProvider`
  - `isIntegrationProvider` unchanged in name, widened in meaning
  - `getProviderBranding(p: IntegrationProvider)` — now covers `hp_cmsl`
  - `useEdrReadiness(providers: EdrProvider[], opts?): Record<EdrProvider, EdrReadiness>` — **narrowed**, so the two-key seed is type-correct rather than a hazard

This mirrors, exactly, the `BuiltinEdrProvider` ⊂ `BuiltinProvider` split Task 2 made on the API side. Same reason, same shape, both ends of the wire.

- [ ] **Step 1: Write the failing tests**

Replace `apps/web/src/components/software/providerBranding.test.ts` in full:

```ts
import { describe, expect, it } from 'vitest';
import {
  EDR_PROVIDERS,
  INTEGRATION_PROVIDERS,
  getProviderBranding,
  isEdrProvider,
  isIntegrationProvider,
} from './providerBranding';

describe('providerBranding', () => {
  it('returns label, icon, accent, and blurb for huntress', () => {
    const b = getProviderBranding('huntress');
    expect(b.label).toBe('Huntress');
    // lucide icons are forwardRef components (objects in this version), not plain functions
    expect(b.icon).toBeDefined();
    expect(['function', 'object']).toContain(typeof b.icon);
    expect(b.accent).toMatch(/\S/);
    expect(b.blurb.length).toBeGreaterThan(0);
  });

  it('returns branding for sentinelone', () => {
    expect(getProviderBranding('sentinelone').label).toBe('SentinelOne');
  });

  it('returns branding for hp_cmsl', () => {
    const b = getProviderBranding('hp_cmsl');
    expect(b.label).toBe('HP CMSL');
    expect(b.icon).toBeDefined();
    expect(b.accent).toMatch(/\S/);
    expect(b.blurb.length).toBeGreaterThan(0);
  });

  it('brands every member of the provider set', () => {
    for (const p of INTEGRATION_PROVIDERS) {
      expect(getProviderBranding(p)).toBeDefined();
    }
  });

  it('type-guards provider strings', () => {
    expect(isIntegrationProvider('huntress')).toBe(true);
    expect(isIntegrationProvider('hp_cmsl')).toBe(true);
    expect(isIntegrationProvider('nope')).toBe(false);
    expect(isIntegrationProvider(undefined)).toBe(false);
  });

  it('separates EDR providers from the wider built-in set', () => {
    // hp_cmsl is a built-in with branding, but it holds no credentials and has
    // nothing to be "ready" about — useEdrReadiness is typed against EdrProvider
    // so it can never be folded into EDR readiness.
    expect(isEdrProvider('huntress')).toBe(true);
    expect(isEdrProvider('sentinelone')).toBe(true);
    expect(isEdrProvider('hp_cmsl')).toBe(false);
    expect(isEdrProvider(undefined)).toBe(false);
    for (const p of EDR_PROVIDERS) {
      expect(INTEGRATION_PROVIDERS).toContain(p);
    }
    expect(EDR_PROVIDERS.length).toBeLessThan(INTEGRATION_PROVIDERS.length);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd apps/web && npx vitest run src/components/software/providerBranding.test.ts
```

Expected: FAIL — `EDR_PROVIDERS` and `isEdrProvider` are not exported; `getProviderBranding('hp_cmsl')` returns `undefined`.

- [ ] **Step 3: Implement `providerBranding.ts`**

Replace `apps/web/src/components/software/providerBranding.ts:1-41` with:

```ts
import { Laptop, ShieldCheck, type LucideIcon } from 'lucide-react';

/** Built-in providers that are credential-backed EDR integrations: they have a
 *  readiness concept (integration connected? key configured? orgs mapped?) that
 *  useEdrReadiness fetches. `useEdrReadiness` is typed against THIS set, so a
 *  built-in with no credentials can never be folded into EDR readiness — which
 *  is what would leave its card stuck on "Checking" forever, or crash on an
 *  unseeded readiness lookup. */
export const EDR_PROVIDERS = ['huntress', 'sentinelone'] as const;

export type EdrProvider = (typeof EDR_PROVIDERS)[number];

/** Single source of truth for the FULL built-in provider set — the union and the
 *  type guard both derive from this, so adding a provider can't leave one of
 *  them stale. `hp_cmsl` is a built-in (branded, "Built-in" chip, not deletable)
 *  but NOT an EdrProvider: it installs from winget, holds no credentials, and
 *  has nothing to configure before it can deploy. */
export const INTEGRATION_PROVIDERS = [...EDR_PROVIDERS, 'hp_cmsl'] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export interface ProviderBranding {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the tinted icon tile + chip (theme-aware). NOT a logo. */
  accent: string;
  blurb: string;
  websiteUrl?: string;
}

const BRANDING: Record<IntegrationProvider, ProviderBranding> = {
  huntress: {
    label: 'Huntress',
    icon: ShieldCheck,
    accent: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/40',
    blurb: 'Managed endpoint detection & response — installs the latest agent automatically.',
    websiteUrl: 'https://www.huntress.com',
  },
  sentinelone: {
    label: 'SentinelOne',
    icon: ShieldCheck,
    accent: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/40',
    blurb: 'Autonomous EDR agent deployed from your uploaded installer.',
    websiteUrl: 'https://www.sentinelone.com',
  },
  hp_cmsl: {
    label: 'HP CMSL',
    icon: Laptop,
    accent: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/40',
    blurb:
      "HP's Client Management Script Library, installed from winget on HP business hardware so the agent can read warranty and entitlement data. Installed from HP — Breeze never hosts a copy.",
    websiteUrl:
      'https://developers.hp.com/hp-client-management/doc/client-management-script-library',
  },
};

export function getProviderBranding(p: IntegrationProvider): ProviderBranding {
  return BRANDING[p];
}

export function isIntegrationProvider(v: unknown): v is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly unknown[]).includes(v);
}

/** Narrower guard: is this built-in one of the credential-backed EDR providers,
 *  i.e. does it have an EDR readiness entry at all? */
export function isEdrProvider(v: unknown): v is EdrProvider {
  return (EDR_PROVIDERS as readonly unknown[]).includes(v);
}
```

- [ ] **Step 4: Narrow `useEdrReadiness` to `EdrProvider`**

In `apps/web/src/components/software/useEdrReadiness.ts`, change the type import at `:3`:

```ts
import type { EdrProvider } from './providerBranding';
```

and the hook signature + seed at `:123-135`:

```ts
/**
 * EDR readiness for the credential-backed built-ins only.
 *
 * The parameter and return type are `EdrProvider`, NOT `IntegrationProvider`:
 * the seed below is a hardcoded two-key literal, so a widened key type would
 * either fail to compile or — worse, if someone "fixed" it by adding a key —
 * leave a non-EDR built-in permanently reporting `loading`. HP CMSL has no
 * credential readiness concept and must not appear in this map at all; the
 * catalog gates its readiness UI on `isEdrProvider` instead.
 */
export function useEdrReadiness(
  providers: EdrProvider[],
  opts?: { s1VersionCount?: number },
): Record<EdrProvider, EdrReadiness> {
  const s1VersionCount = opts?.s1VersionCount ?? 0;
  const key = useMemo(
    () => `${Array.from(new Set(providers)).sort().join(',')}|${s1VersionCount}`,
    [providers, s1VersionCount],
  );
  const [map, setMap] = useState<Record<EdrProvider, EdrReadiness>>({
    huntress: LOADING,
    sentinelone: LOADING,
  });
```

and the one cast inside the effect at `:140`:

```ts
    const wanted = provPart ? (provPart.split(',') as EdrProvider[]) : [];
```

- [ ] **Step 5: Run the branding + readiness tests, expect PASS**

```bash
cd apps/web && npx vitest run src/components/software/providerBranding.test.ts src/components/software/useEdrReadiness.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Typecheck — expect a failure in `SoftwareCatalog.tsx`, which is correct**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
```

Expected: **FAIL** at `SoftwareCatalog.tsx:331` (`builtinProviders` is `IntegrationProvider[]`, the hook now wants `EdrProvider[]`) and at `:640` / `:828` (indexing a `Record<EdrProvider, …>` with an `IntegrationProvider`). Record those errors — they are the compiler pointing at exactly the three sites Task 8 fixes. Do not paper over them here.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/software/providerBranding.ts \
        apps/web/src/components/software/useEdrReadiness.ts \
        apps/web/src/components/software/providerBranding.test.ts
git commit -m "feat(web): split EdrProvider out of IntegrationProvider and brand hp_cmsl (#5515)"
```

---

### Task 8: Web — render an `hp_cmsl` catalog item without crashing

**Files:**
- Modify: `apps/web/src/components/software/SoftwareCatalog.tsx:22-28,271-275,312-331,637-651,824-828`
- Modify: `apps/web/src/components/software/BuiltinPackageDetail.tsx:9-37,77-146`
- Test: `apps/web/src/components/software/SoftwareCatalog.test.tsx`

**Interfaces:**
- Consumes: `isEdrProvider`, `isIntegrationProvider`, `EdrProvider` (Task 7).
- Produces: `BuiltinPackageDetailProps.readiness: EdrReadiness | null` — `null` means "this built-in has no credential readiness concept": no readiness box, and Deploy is never disabled.

This is the wave's mandatory regression. It is staged so the red is genuine **twice**: once for the silent misrender that exists today, and once for the crash the contract describes.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/components/software/SoftwareCatalog.test.tsx`, after the existing `describe('SoftwareCatalog built-in packages', ...)` block:

```tsx
const HP_CMSL_ITEM = {
  id: 'builtin-hp-cmsl',
  name: 'HP Client Management Script Library',
  vendor: 'HP Inc.',
  category: 'utility',
  description: 'HP CMSL, installed from winget.',
  createdAt: '2026-09-10T00:00:00Z',
  integrationProvider: 'hp_cmsl',
  partnerId: 'partner-1',
  versionCount: 0,
  methodCount: 1,
  methodKinds: ['winget'],
};

describe('SoftwareCatalog non-EDR built-in (hp_cmsl)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    showToast.mockReset();
  });

  it('renders the built-in chip and no readiness pill, and never dereferences EDR readiness', async () => {
    // The crash this guards: useEdrReadiness seeds only {huntress, sentinelone},
    // while the card and the detail panel index readinessMap by the item's
    // provider. Adding hp_cmsl to INTEGRATION_PROVIDERS without separating
    // readiness makes `readinessMap['hp_cmsl'].status` throw during render.
    routeBuiltin([HP_CMSL_ITEM]);

    render(<SoftwareCatalog />);

    await waitFor(() =>
      expect(screen.getByText('HP Client Management Script Library')).toBeInTheDocument(),
    );
    // It IS a built-in: branded chip, and no EDR readiness pill of any kind.
    expect(screen.getByText(/^Built-in$/)).toBeInTheDocument();
    expect(screen.queryByText(/^Ready$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Setup needed$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Checking$/)).not.toBeInTheDocument();
    // The winget install method still badges the card.
    expect(screen.getByTestId('package-manager-badges').textContent).toMatch(/winget/);
    // Deploy is enabled: there is no credential to configure first.
    expect(screen.getByRole('button', { name: /^Deploy$/ })).not.toBeDisabled();
  });

  it('opens a Managed built-in detail panel with no Delete control and no readiness checklist', async () => {
    routeBuiltin([HP_CMSL_ITEM]);

    render(<SoftwareCatalog />);
    await waitFor(() =>
      expect(screen.getByText('HP Client Management Script Library')).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText('HP Client Management Script Library'));

    expect(await screen.findByText(/Managed built-in/i)).toBeInTheDocument();
    // A built-in is never deletable through the catalog UI.
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();
    // ...and there is no EDR readiness box to render.
    expect(screen.queryByText(/Checking setup/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Next step:/i)).not.toBeInTheDocument();
  });

  it('still fetches EDR readiness for an EDR built-in shown alongside it', async () => {
    // Regression fence for the readiness split: narrowing the readiness fetch to
    // EdrProvider must not stop Huntress readiness from loading.
    routeBuiltin([HP_CMSL_ITEM, BUILTIN_ITEM], HUNTRESS_READY);

    render(<SoftwareCatalog />);

    await waitFor(() => expect(screen.getByText(/^Ready$/)).toBeInTheDocument());
    expect(screen.getAllByText(/^Built-in$/)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL (the silent misrender)**

```bash
cd apps/web && npx vitest run src/components/software/SoftwareCatalog.test.tsx
```

Expected: the first two tests FAIL — no "Built-in" chip, and a **Delete** button IS present in the detail panel. That is `SoftwareCatalog.tsx:271-275` narrowing `hp_cmsl` to `undefined`: the built-in renders as an ordinary org package. Record it.

- [ ] **Step 3: Widen the row-mapping narrowing ONLY**

In `apps/web/src/components/software/SoftwareCatalog.tsx`, replace `:271-275`:

```tsx
            // Derived from INTEGRATION_PROVIDERS via the type guard, not a
            // hardcoded pair: a hardcoded list here silently demoted any new
            // built-in to an ordinary org package (no branding, no Built-in
            // chip, a Delete button the API refuses with a 400).
            integrationProvider: isIntegrationProvider(item.integrationProvider)
              ? item.integrationProvider
              : undefined,
```

- [ ] **Step 4: Run it again, expect FAIL — and this time it is THE CRASH**

```bash
cd apps/web && npx vitest run src/components/software/SoftwareCatalog.test.tsx
```

Expected: FAIL with `TypeError: Cannot read properties of undefined (reading 'status')`, thrown from `SoftwareCatalog.tsx:640` during render (`readinessMap['hp_cmsl']` is `undefined` — `useEdrReadiness` seeds only `huntress` and `sentinelone`). **This is the exact defect the contract names. Record the message before fixing it** — it is the proof that the readiness separation in the next step is load-bearing rather than cosmetic. (Vitest transpiles without type-checking, so Task 7's `tsc` errors do not stop this run; the runtime crash is what surfaces here.)

- [ ] **Step 5: Separate readiness from branding**

In `apps/web/src/components/software/SoftwareCatalog.tsx`:

Imports (`:22-26`):

```tsx
import {
  getProviderBranding,
  isEdrProvider,
  isIntegrationProvider,
  type IntegrationProvider,
} from "./providerBranding";
```

The readiness fetch set (`:312-331`) — rename and re-guard:

```tsx
  // Built-in EDR readiness: one fetch per present EDR provider (there's one
  // integration per partner), shared by the cards and the detail panel.
  // Filtered by isEdrProvider, NOT isIntegrationProvider: a non-EDR built-in
  // (hp_cmsl) has no credentials and no readiness endpoint to ask.
  const edrProviders = useMemo(
    () =>
      Array.from(
        new Set(
          catalogItems
            .map((i) => i.integrationProvider)
            .filter(isEdrProvider),
        ),
      ),
    [catalogItems],
  );
  const s1VersionCount = useMemo(
    () =>
      catalogItems.find((i) => i.integrationProvider === "sentinelone")
        ?.versionCount ?? 0,
    [catalogItems],
  );
  const readinessMap = useEdrReadiness(edrProviders, { s1VersionCount });
```

The card's chip row (`:637-651`) — split the readiness pill off the built-in chip:

```tsx
                  {isIntegrationProvider(item.integrationProvider) && (
                    <div className="flex items-center gap-1.5">
                      {/* Readiness is an EDR-only concept: hp_cmsl has no
                          credentials to check, so it wears the Built-in chip
                          with no pill rather than a pill that never resolves. */}
                      {isEdrProvider(item.integrationProvider) && (
                        <ReadinessPill
                          status={readinessMap[item.integrationProvider].status}
                        />
                      )}
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                          getProviderBranding(item.integrationProvider).accent,
                        )}
                      >
                        {i18n.t("policies:software.softwareCatalog.builtIn")}
                      </span>
                    </div>
                  )}
```

The detail panel (`:824-828`):

```tsx
              (isIntegrationProvider(selectedSoftware.integrationProvider) ? (
                <BuiltinPackageDetail
                  name={selectedSoftware.name}
                  provider={selectedSoftware.integrationProvider}
                  readiness={
                    isEdrProvider(selectedSoftware.integrationProvider)
                      ? readinessMap[selectedSoftware.integrationProvider]
                      : null
                  }
```

In `apps/web/src/components/software/BuiltinPackageDetail.tsx`, widen the prop (`:16-33`):

```tsx
export interface BuiltinPackageDetailProps {
  name: string;
  provider: IntegrationProvider;
  /** EDR readiness, or `null` for a built-in that has no credential readiness
   *  concept (hp_cmsl). A null readiness renders no readiness box and never
   *  disables Deploy — there is nothing to configure first. */
  readiness: EdrReadiness | null;
  onDeploy: () => void;
}
export default function BuiltinPackageDetail({
  name,
  provider,
  readiness,
  onDeploy,
}: BuiltinPackageDetailProps) {
  useTranslation("policies");
  const branding = getProviderBranding(provider);
  const Icon = branding.icon;
  const ready = readiness?.status === "ready";
  const gap = readiness ? firstGap(readiness) : undefined;
  const disabled = readiness?.status === "incomplete";
```

and wrap the readiness box (currently `:77-146`) so it renders only when there is a readiness to render. Change its opening line from:

```tsx
      <div className="rounded-md border bg-muted/30 p-4">
```

to:

```tsx
      {readiness && (
      <div className="rounded-md border bg-muted/30 p-4">
```

and its closing `</div>` (the one immediately before `<div className="flex items-center justify-end">`) to:

```tsx
      </div>
      )}
```

Inside that block, `readiness` is narrowed to non-null, so `readiness.status` and `readiness.checks` need no further change.

- [ ] **Step 6: Run the web software suite, expect PASS**

```bash
cd apps/web && npx vitest run src/components/software/SoftwareCatalog.test.tsx src/components/software/BuiltinPackageDetail.test.tsx src/components/software/providerBranding.test.ts src/components/software/useEdrReadiness.test.tsx
```

Expected: PASS. Check the reported file count is 4 — vitest's filter is substring matching, so a typo silently narrows the run.

- [ ] **Step 7: Typecheck and lint**

```bash
pnpm --filter @breeze/web exec tsc --noEmit
pnpm lint
```

Expected: clean. Task 7's three recorded errors are now gone.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/software/SoftwareCatalog.tsx \
        apps/web/src/components/software/BuiltinPackageDetail.tsx \
        apps/web/src/components/software/SoftwareCatalog.test.tsx
git commit -m "fix(web): render non-EDR built-ins without dereferencing EDR readiness (#5515)"
```

---

### Task 9: The policy that keeps CMSL present — **BLOCKED ON #5508**

> **Do not start this task until issue #5508 (Feature A W03) has merged.** Verify with `gh pr list --repo LanternOps/breeze --search "5508" --state merged` or `gh issue view 5508 --repo LanternOps/breeze --json state`. Until then, `remediationOptionsSchema` (`apps/api/src/db/schema/softwarePolicies.ts:79-85`) is a non-strict `z.object` that **silently strips** an `autoInstall` key, and the compliance worker cannot act on a `missing` violation at all. A policy written before #5508 lands would look armed and install nothing. Tasks 1–8 ship as their own PR; this is the second.

**Files:**
- Create: `apps/api/src/services/hpCmslPolicyProvisioning.ts`
- Create: `apps/api/src/services/hpCmslPolicyProvisioning.test.ts`
- Create: `apps/api/src/__tests__/integration/hpCmslPolicyProvisioning.integration.test.ts`
- Modify: `apps/api/src/services/hpCmslProvisioning.ts` (chain the policy provisioner after the package)

**Interfaces:**
- Consumes: `ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId })` → `{ catalogId }` (Task 4); `SoftwarePolicyRemediationOptions.autoInstall?: boolean` (#5508).
- Produces: `export async function ensureHpCmslSoftwarePolicy(params: { partnerId: string; catalogId: string }): Promise<{ softwarePolicyId: string; configPolicyId: string }>` — idempotent, system DB context.

#### Two constraints this task must respect, both discovered in the ground-truth pass

**(a) `allowUnknown: true` is mandatory.** `evaluateSoftwareInventory` (`softwarePolicyService.ts:316-331`) flags every non-matching installed application as `unauthorized` at severity `medium` when `allowUnknown` is falsy, and `normalizeSoftwarePolicyRules` (`:265-268`) defaults it to `false`. A one-rule allowlist policy without it would flood compliance for every targeted device, every 15 minutes.

**(b) A software policy cannot be targeted at HP hardware.** Device resolution goes through **configuration-policy assignments only** (`featureConfigResolver.ts:1044-1171`); assignments carry `roleFilter` and `osFilter` and nothing else (`configurationPolicies.ts:170-171`); `device_groups.orgId` is `NOT NULL` so a partner-wide hardware group cannot exist; and `softwarePolicies.targetType`/`targetIds` are read by nothing on this path. `hardware.manufacturer` targeting exists only for **deployments** (`deploymentTargetResolver.ts:60-62`). The spec's Layer-3 sentence conflates the two models.

**DECISION: provision the policy, but provision NO assignment.** `ensureHpCmslSoftwarePolicy` creates the partner-owned `software_policies` row and a dedicated partner-owned `configuration_policies` row carrying the single `software_policy` feature link — and stops there. The MSP assigns that configuration policy to the orgs, sites, groups or devices they choose, through the existing assignment UI, exactly like every other configuration policy.

Rejected alternatives, and why:

- **A `partner`-level assignment with `osFilter: ['windows']`.** This is the only broad targeting the machinery can express, and it would auto-install a ~100 MB HP module on *every Windows endpoint under the partner*, Dell and Lenovo included, plus the HP EULA and HP's telemetry rights that go with it. Not acceptable, and it is not what the spec's "HP devices" language describes.
- **Adding a `manufacturer_filter` to `config_policy_assignments`.** This is the change that would make hardware-scoped policy targeting real, and it is genuinely reusable ("apply this policy only to Dell/HP/Lenovo hardware" is a plain MSP primitive). But it is a cross-module change to shared policy machinery — a migration, a `device_hardware` join in two resolvers, and a NULL-manufacturer semantics decision for devices that have not reported inventory yet. Per CLAUDE.md that is a consequential design choice needing an advisor quorum, not something a wave plan slips in. **Filed as the follow-up below.**
- **Piggybacking the link onto the MSP's existing configuration policy.** Impossible: `config_policy_feature_links` is unique on `(config_policy_id, feature_type)` (`configurationPolicies.ts:127`), so it would displace their own software policy.

**Open question for Todd, to be raised with this PR (do not decide it inside the wave):** should hardware-scoped policy targeting be built (`manufacturer_filter` on `config_policy_assignments`), or is "the MSP assigns the built-in configuration policy to the orgs they want CMSL on" the intended end state? The second is what this task ships, and it is also the more defensible EULA posture — the MSP chooses where HP software lands rather than Breeze choosing for them.

**Also state plainly in the PR body (the spec asks for this):** because `software_deployments` are org-owned, a partner-wide policy produces **one deployment run per organisation**. That is inherent to the schema, not a defect to work around.

- [ ] **Step 1: Confirm the gate, and read #5508's landed shape**

```bash
gh issue view 5508 --repo LanternOps/breeze --json state,title
```

Expected: `CLOSED`. Then re-read the three things #5508 defines, because this task writes against them and the plan cannot pin their final spelling:

```bash
grep -n "autoInstall" apps/api/src/db/schema/softwarePolicies.ts
grep -n "autoInstall" apps/api/src/services/softwarePolicyService.ts
```

Expected: `SoftwarePolicyRemediationOptions.autoInstall?: boolean` and `remediationOptionsSchema` accepting it. If either is absent, #5508 did not land what this task needs — stop and report.

- [ ] **Step 2: Write the failing unit test**

Create `apps/api/src/services/hpCmslPolicyProvisioning.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildHpCmslPolicyRows, HP_CMSL_POLICY_NAME, HP_CMSL_CONFIG_POLICY_NAME } from './hpCmslPolicyProvisioning';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const CATALOG = '33333333-3333-4333-8333-333333333333';

describe('buildHpCmslPolicyRows', () => {
  it('builds a partner-owned allowlist policy armed for install only', () => {
    const { softwarePolicy } = buildHpCmslPolicyRows({ partnerId: PARTNER, catalogId: CATALOG });

    expect(softwarePolicy.partnerId).toBe(PARTNER);
    expect(softwarePolicy.orgId).toBeNull();
    expect(softwarePolicy.name).toBe(HP_CMSL_POLICY_NAME);
    expect(softwarePolicy.mode).toBe('allowlist');
    expect(softwarePolicy.enforceMode).toBe(true);
    expect(softwarePolicy.isActive).toBe(true);
    expect(softwarePolicy.remediationOptions).toMatchObject({ autoInstall: true });
    // Arming install must NOT arm uninstall — different verbs, different flags.
    expect(softwarePolicy.remediationOptions.autoUninstall).toBeUndefined();
  });

  it('sets allowUnknown so the one-rule allowlist does not flag every other app', () => {
    const { softwarePolicy } = buildHpCmslPolicyRows({ partnerId: PARTNER, catalogId: CATALOG });
    // evaluateSoftwareInventory (softwarePolicyService.ts:316-331) emits an
    // 'unauthorized' violation for EVERY installed app that matches no rule
    // unless allowUnknown is true, and normalizeSoftwarePolicyRules defaults it
    // to false. Without this the policy would flood compliance every 15 minutes.
    expect(softwarePolicy.rules.allowUnknown).toBe(true);
  });

  it('carries exactly one rule, pointed at the HP CMSL catalog item', () => {
    const { softwarePolicy } = buildHpCmslPolicyRows({ partnerId: PARTNER, catalogId: CATALOG });
    expect(softwarePolicy.rules.software).toHaveLength(1);
    expect(softwarePolicy.rules.software[0]).toMatchObject({
      vendor: 'HP Inc.',
      catalogId: CATALOG,
    });
    // The rule name is matched against Add/Remove Programs display names via a
    // '*'-to-'.*' anchored regex (matchesSoftwareRule, :283-287), so it is a
    // wildcard, not an exact string.
    expect(softwarePolicy.rules.software[0]!.name).toContain('*');
  });

  it('builds a partner-owned configuration policy with one software_policy link and NO assignment', () => {
    const { configPolicy, featureLink, assignments } = buildHpCmslPolicyRows({
      partnerId: PARTNER,
      catalogId: CATALOG,
    });

    expect(configPolicy.partnerId).toBe(PARTNER);
    expect(configPolicy.orgId).toBeNull();
    expect(configPolicy.name).toBe(HP_CMSL_CONFIG_POLICY_NAME);
    expect(featureLink.featureType).toBe('software_policy');

    // The load-bearing assertion. Assignments carry only roleFilter/osFilter
    // (configurationPolicies.ts:170-171) — there is NO manufacturer filter — so
    // any assignment Breeze created for the partner would install a ~100 MB HP
    // module on every non-HP Windows endpoint under it. The MSP assigns this
    // policy themselves, to the orgs they chose to enable HP collection for.
    expect(assignments).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it, expect FAIL**

```bash
cd apps/api && npx vitest run src/services/hpCmslPolicyProvisioning.test.ts
```

Expected: FAIL — `Failed to resolve import "./hpCmslPolicyProvisioning"`.

- [ ] **Step 4: Implement**

Create `apps/api/src/services/hpCmslPolicyProvisioning.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import {
  configPolicyFeatureLinks,
  configurationPolicies,
  softwarePolicies,
} from '../db/schema';
import type {
  SoftwarePolicyRemediationOptions,
  SoftwarePolicyRulesDefinition,
} from '../db/schema/softwarePolicies';

/**
 * The built-in "keep HP CMSL installed" policy pair (feature #5511 W04, #5515).
 *
 * WHAT THIS CREATES
 *   1. a partner-owned software_policies row: allowlist mode, enforceMode on,
 *      remediationOptions.autoInstall armed, ONE rule pointed at the partner's
 *      HP CMSL catalog item;
 *   2. a partner-owned configuration_policies row carrying the single
 *      `software_policy` feature link to (1).
 *
 * WHAT THIS DELIBERATELY DOES NOT CREATE: an assignment.
 *
 * A software policy resolves its devices ONLY through configuration-policy
 * assignments (services/featureConfigResolver.ts:1044-1171 — softwarePolicies'
 * own targetType/targetIds are read by nothing on that path). An assignment can
 * narrow by device role and OS (db/schema/configurationPolicies.ts:170-171) and
 * by NOTHING ELSE — there is no manufacturer filter, and device_groups.orgId is
 * NOT NULL so a partner-wide hardware group cannot exist either. The broadest
 * assignment Breeze could create is therefore "every Windows device under this
 * partner", which would push a ~100 MB HP module (and HP's licence and its
 * telemetry rights) onto every Dell and Lenovo endpoint the partner manages.
 *
 * hardware.manufacturer targeting DOES exist, but only for one-shot deployments
 * (services/deploymentTargetResolver.ts:60-62 → evaluateFilter). The spec's
 * Layer-3 claim that policy targeting can use it conflates the two models.
 *
 * So the MSP assigns this configuration policy, to the orgs/sites/groups they
 * chose to enable HP warranty collection for, through the normal assignment UI.
 * That is also the right EULA posture: the MSP decides where HP software lands.
 *
 * Follow-up under discussion with Todd: a `manufacturer_filter` column on
 * config_policy_assignments would make hardware-scoped policy targeting real and
 * is plainly reusable, but it is a cross-module change to shared policy
 * machinery and needs its own design pass.
 *
 * NOTE ON BLAST RADIUS: because software_deployments are org-owned, a
 * partner-wide policy produces one deployment run per organisation. That is
 * inherent to the schema, not a defect to work around.
 */

export const HP_CMSL_POLICY_NAME = 'HP CMSL (built-in)';
export const HP_CMSL_CONFIG_POLICY_NAME = 'HP warranty collection (built-in)';

/**
 * Add/Remove Programs display name pattern for HP CMSL.
 *
 * matchesSoftwareRule (services/softwarePolicyService.ts:283-287) turns the rule
 * name into an ANCHORED regex with '*' → '.*', case-insensitive. A wildcard is
 * required because the exact DisplayName HP's InnoSetup installer registers is
 * a lab observation (W01 gate question 3), not documentation, and it carries a
 * version suffix on some builds.
 */
export const HP_CMSL_RULE_NAME = 'HP Client Management Script Library*';

export interface HpCmslPolicyRows {
  softwarePolicy: {
    orgId: null;
    partnerId: string;
    name: string;
    description: string;
    mode: 'allowlist';
    rules: SoftwarePolicyRulesDefinition;
    priority: number;
    isActive: boolean;
    enforceMode: boolean;
    remediationOptions: SoftwarePolicyRemediationOptions;
  };
  configPolicy: {
    orgId: null;
    partnerId: string;
    name: string;
    description: string;
  };
  featureLink: { featureType: 'software_policy' };
  /** Always empty — see the module docstring. Typed as an array so a future
   *  change that starts creating assignments has to change this contract, and
   *  the test that asserts it is empty, visibly. */
  assignments: never[];
}

export function buildHpCmslPolicyRows(params: {
  partnerId: string;
  catalogId: string;
}): HpCmslPolicyRows {
  return {
    softwarePolicy: {
      orgId: null,
      partnerId: params.partnerId,
      name: HP_CMSL_POLICY_NAME,
      description:
        "Keeps HP's Client Management Script Library installed on assigned devices so the Breeze agent can read HP warranty and entitlement data. Installed from winget — Breeze never hosts a copy of the installer.",
      mode: 'allowlist',
      rules: {
        software: [
          { name: HP_CMSL_RULE_NAME, vendor: 'HP Inc.', catalogId: params.catalogId },
        ],
        // MANDATORY. Without it, evaluateSoftwareInventory's allowlist arm
        // (softwarePolicyService.ts:316-331) marks every OTHER installed
        // application on every targeted device 'unauthorized' at severity
        // medium, every 15 minutes. normalizeSoftwarePolicyRules defaults it to
        // false (:265-268), so it has to be set explicitly.
        allowUnknown: true,
      },
      priority: 50,
      isActive: true,
      enforceMode: true,
      remediationOptions: {
        // Install only. Arming install must never arm uninstall — a policy that
        // keeps software present is not thereby armed to remove anything.
        autoInstall: true,
      },
    },
    configPolicy: {
      orgId: null,
      partnerId: params.partnerId,
      name: HP_CMSL_CONFIG_POLICY_NAME,
      description:
        'Assign this policy to the organizations, sites or device groups where HP warranty collection is enabled. Breeze does not assign it for you: policy targeting cannot narrow to HP hardware, so a partner-wide assignment would install HP CMSL on non-HP Windows devices too.',
    },
    featureLink: { featureType: 'software_policy' },
    assignments: [],
  };
}

/**
 * Idempotently ensure the built-in HP CMSL policy pair for one partner.
 *
 * Keyed on (partner_id, name) for both rows — neither table has a natural unique
 * key for "the built-in one", and adding one would be a schema change for a
 * single feature. Renaming either constant would orphan the existing rows, so
 * the names are exported constants and must not be edited casually.
 */
export async function ensureHpCmslSoftwarePolicy(params: {
  partnerId: string;
  catalogId: string;
}): Promise<{ softwarePolicyId: string; configPolicyId: string }> {
  const rows = buildHpCmslPolicyRows(params);

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const existingPolicy = await db
        .select({ id: softwarePolicies.id })
        .from(softwarePolicies)
        .where(and(
          eq(softwarePolicies.partnerId, params.partnerId),
          isNull(softwarePolicies.orgId),
          eq(softwarePolicies.name, HP_CMSL_POLICY_NAME),
        ))
        .limit(1);

      let softwarePolicyId = existingPolicy[0]?.id;
      if (!softwarePolicyId) {
        const [row] = await db
          .insert(softwarePolicies)
          .values(rows.softwarePolicy)
          .returning({ id: softwarePolicies.id });
        softwarePolicyId = row!.id;
      } else {
        // Re-assert the server-owned shape: the catalogId can change if the
        // built-in package was re-provisioned, and allowUnknown must never drift
        // to false.
        await db
          .update(softwarePolicies)
          .set({ rules: rows.softwarePolicy.rules, updatedAt: new Date() })
          .where(eq(softwarePolicies.id, softwarePolicyId));
      }

      const existingConfig = await db
        .select({ id: configurationPolicies.id })
        .from(configurationPolicies)
        .where(and(
          eq(configurationPolicies.partnerId, params.partnerId),
          isNull(configurationPolicies.orgId),
          eq(configurationPolicies.name, HP_CMSL_CONFIG_POLICY_NAME),
        ))
        .limit(1);

      let configPolicyId = existingConfig[0]?.id;
      if (!configPolicyId) {
        const [row] = await db
          .insert(configurationPolicies)
          .values(rows.configPolicy)
          .returning({ id: configurationPolicies.id });
        configPolicyId = row!.id;
      }

      // One software_policy link per configuration policy
      // (config_feature_links_unique on (config_policy_id, feature_type)).
      await db
        .insert(configPolicyFeatureLinks)
        .values({
          configPolicyId,
          featureType: 'software_policy',
          featurePolicyId: softwarePolicyId,
          inlineSettings: null,
        })
        .onConflictDoUpdate({
          target: [configPolicyFeatureLinks.configPolicyId, configPolicyFeatureLinks.featureType],
          set: { featurePolicyId: softwarePolicyId, updatedAt: new Date() },
        });

      // NO assignment is created. See the module docstring.
      return { softwarePolicyId, configPolicyId };
    })
  );
}
```

> Before running: confirm `configurationPolicies`'s insert shape against `apps/api/src/db/schema/configurationPolicies.ts` — if `status` is `NOT NULL` without a default, add `status: 'active'` to `rows.configPolicy` (the resolver joins on `configurationPolicies.status = 'active'`, `featureConfigResolver.ts:1057`, so an inactive policy resolves nothing). Fix it in `buildHpCmslPolicyRows` and add an assertion for it to the unit test rather than patching only the insert.

- [ ] **Step 5: Run the unit test, expect PASS**

```bash
cd apps/api && npx vitest run src/services/hpCmslPolicyProvisioning.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Write and run the real-DB integration test**

Create `apps/api/src/__tests__/integration/hpCmslPolicyProvisioning.integration.test.ts`:

```ts
/**
 * Real-DB provisioning of the built-in HP CMSL policy pair (#5515, Task 9).
 *
 * Runs as breeze_app so the partner-axis RLS on software_policies,
 * configuration_policies and config_policy_feature_links is genuinely
 * exercised, and so the XOR owner CHECKs on both policy tables are hit.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  softwarePolicies,
} from '../../db/schema';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import {
  ensureHpCmslSoftwarePolicy,
  HP_CMSL_CONFIG_POLICY_NAME,
  HP_CMSL_POLICY_NAME,
} from '../../services/hpCmslPolicyProvisioning';
import { createPartner } from './db-utils';

describe('ensureHpCmslSoftwarePolicy (db)', () => {
  it('creates the partner-owned policy pair, links them, and creates NO assignment', async () => {
    const partner = await createPartner();
    const { catalogId } = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });

    const { softwarePolicyId, configPolicyId } = await ensureHpCmslSoftwarePolicy({
      partnerId: partner.id,
      catalogId,
    });

    const { policies, configs, links, assignments } = await withSystemDbAccessContext(async () => {
      const policies = await db
        .select()
        .from(softwarePolicies)
        .where(and(
          eq(softwarePolicies.partnerId, partner.id),
          isNull(softwarePolicies.orgId),
          eq(softwarePolicies.name, HP_CMSL_POLICY_NAME),
        ));
      const configs = await db
        .select()
        .from(configurationPolicies)
        .where(and(
          eq(configurationPolicies.partnerId, partner.id),
          eq(configurationPolicies.name, HP_CMSL_CONFIG_POLICY_NAME),
        ));
      const links = await db
        .select()
        .from(configPolicyFeatureLinks)
        .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId));
      const assignments = await db
        .select()
        .from(configPolicyAssignments)
        .where(eq(configPolicyAssignments.configPolicyId, configPolicyId));
      return { policies, configs, links, assignments };
    });

    expect(policies).toHaveLength(1);
    expect(policies[0]!.id).toBe(softwarePolicyId);
    expect(policies[0]!.orgId).toBeNull();
    expect(policies[0]!.mode).toBe('allowlist');
    expect(policies[0]!.enforceMode).toBe(true);
    expect(policies[0]!.rules.allowUnknown).toBe(true);
    expect(policies[0]!.rules.software[0]!.catalogId).toBe(catalogId);
    expect(policies[0]!.remediationOptions).toMatchObject({ autoInstall: true });

    expect(configs).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(links[0]!.featureType).toBe('software_policy');
    expect(links[0]!.featurePolicyId).toBe(softwarePolicyId);

    // The load-bearing one: Breeze must not decide where HP software lands.
    expect(assignments).toHaveLength(0);
  });

  it('is idempotent and never duplicates the pair or the link', async () => {
    const partner = await createPartner();
    const { catalogId } = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });

    const first = await ensureHpCmslSoftwarePolicy({ partnerId: partner.id, catalogId });
    const second = await ensureHpCmslSoftwarePolicy({ partnerId: partner.id, catalogId });

    expect(second.softwarePolicyId).toBe(first.softwarePolicyId);
    expect(second.configPolicyId).toBe(first.configPolicyId);

    const links = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(configPolicyFeatureLinks)
        .where(eq(configPolicyFeatureLinks.configPolicyId, first.configPolicyId)),
    );
    expect(links).toHaveLength(1);
  });

  it('does not survive a partner-scoped caller re-pointing the link (RLS + system-only writes)', async () => {
    // An MSP-visible policy is fine; a Breeze-owned link that a partner can
    // silently retarget is not. Re-provisioning restores it.
    const partner = await createPartner();
    const { catalogId } = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId: partner.id });
    const { softwarePolicyId, configPolicyId } = await ensureHpCmslSoftwarePolicy({
      partnerId: partner.id,
      catalogId,
    });

    await withSystemDbAccessContext(() =>
      db
        .update(configPolicyFeatureLinks)
        .set({ featurePolicyId: null })
        .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId)),
    );

    await ensureHpCmslSoftwarePolicy({ partnerId: partner.id, catalogId });

    const links = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(configPolicyFeatureLinks)
        .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicyId)),
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.featurePolicyId).toBe(softwarePolicyId);
  });
});
```

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/hpCmslPolicyProvisioning.integration.test.ts
```

Expected: PASS, 3 tests. If the first run fails on an XOR CHECK (`software_policies_one_owner_chk` or `configuration_policies`' equivalent) or on a `NOT NULL status`, fix `buildHpCmslPolicyRows` and re-run the unit test too — the row shape is the unit test's subject.

- [ ] **Step 7: Chain the policy provisioner after the package provisioner**

In `apps/api/src/services/hpCmslProvisioning.ts`, extend the `try` block of `provisionHpCmslForFeatureLink`:

```ts
  try {
    const { catalogId } = await ensureBuiltinPackage({ provider: 'hp_cmsl', partnerId });
    // The catalog item alone installs nothing. The policy pair is what keeps
    // CMSL present — but Breeze creates NO assignment for it; the MSP assigns
    // the configuration policy to the orgs they enabled HP collection for.
    // See services/hpCmslPolicyProvisioning.ts for why.
    await ensureHpCmslSoftwarePolicy({ partnerId, catalogId });
  } catch (error) {
```

and add the import:

```ts
import { ensureHpCmslSoftwarePolicy } from './hpCmslPolicyProvisioning';
```

Then extend `apps/api/src/services/hpCmslProvisioning.test.ts` — add the mock and one assertion:

```ts
const { ensureHpCmslSoftwarePolicyMock } = vi.hoisted(() => ({ ensureHpCmslSoftwarePolicyMock: vi.fn() }));
vi.mock('./hpCmslPolicyProvisioning', () => ({ ensureHpCmslSoftwarePolicy: ensureHpCmslSoftwarePolicyMock }));
```

```ts
  it('provisions the policy pair with the catalog id the package call returned', async () => {
    ensureBuiltinPackageMock.mockResolvedValue({ catalogId: 'cat-hp' });
    ensureHpCmslSoftwarePolicyMock.mockResolvedValue({ softwarePolicyId: 'sp-1', configPolicyId: 'cp-1' });

    await provisionHpCmslForFeatureLink({
      featureType: 'warranty',
      inlineSettings: { hpCmsl: { enabled: true } },
      policyPartnerId: PARTNER,
      authPartnerId: null,
      policyOrgId: null,
    });

    expect(ensureHpCmslSoftwarePolicyMock).toHaveBeenCalledWith({ partnerId: PARTNER, catalogId: 'cat-hp' });
  });
```

Add `ensureHpCmslSoftwarePolicyMock.mockReset()` to that file's `beforeEach`.

- [ ] **Step 8: Run everything this wave touched**

```bash
cd apps/api && npx vitest run \
  src/services/hpCmslProvisioning.test.ts \
  src/services/hpCmslPolicyProvisioning.test.ts \
  src/services/builtinDeploymentPackages.test.ts \
  src/services/edrInstallerResolver.test.ts \
  src/services/softwareDeployment.test.ts \
  src/routes/softwareInstallMethods.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/hpCmslBuiltinPackage.integration.test.ts \
  src/__tests__/integration/hpCmslPolicyProvisioning.integration.test.ts \
  src/__tests__/integration/builtinDeploymentPackages.integration.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: PASS / clean. Check the reported file counts.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/hpCmslPolicyProvisioning.ts \
        apps/api/src/services/hpCmslPolicyProvisioning.test.ts \
        apps/api/src/services/hpCmslProvisioning.ts \
        apps/api/src/services/hpCmslProvisioning.test.ts \
        apps/api/src/__tests__/integration/hpCmslPolicyProvisioning.integration.test.ts
git commit -m "feat(warranty): built-in HP CMSL allowlist policy with autoInstall, assigned by the MSP (#5515)"
```

---

## Pre-PR checklist

- [ ] Gate 1: #5512's three lab answers are recorded on the issue, and Todd has ruled on the namespace-coverage question.
- [ ] Gate 2 (Task 9 only): #5508 is merged, and `SoftwarePolicyRemediationOptions.autoInstall` plus its schema entry exist on `main`.
- [ ] Migration filename still sorts after the newest file on `origin/main`:
  ```bash
  git fetch origin main && git diff --name-only origin/main -- apps/api/migrations/
  ls apps/api/migrations/*.sql | sort | tail -3
  ```
  The pre-push hook re-checks against `origin/main` (`scripts/check-migration-naming.sh --against-ref origin/main`); a name that was fine at commit time can fail at push time.
- [ ] Full API unit suite: `cd apps/api && npx vitest run`
- [ ] Full web unit suite: `cd apps/web && npx vitest run`
- [ ] Contract suites (live DB required; they run only in the **Integration Tests** CI job, so a locally-green branch proves nothing about them):
  ```bash
  cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
  ```
  Expected PASS with no edits: this wave adds no table and no column.
- [ ] `pnpm lint`
- [ ] Cross-tenant forge, by hand, as `breeze_app` — the CHECK widening did not touch RLS, but the new install-method write path is new:
  ```bash
  docker exec -it breeze-postgres psql -U breeze_app -d breeze
  -- with no breeze.scope set, an insert naming another partner's built-in must fail
  INSERT INTO software_install_methods (catalog_id, platform, kind, package_id)
  VALUES ('<some other partner''s hp_cmsl catalog id>', 'windows', 'winget', 'Evil.Package');
  -- expected: new row violates row-level security policy
  ```
- [ ] PR body states: (a) the install-method boundary decision and its reasoning; (b) that a partner-wide policy produces one deployment run per organisation, inherent to the schema; (c) the open question on hardware-scoped policy targeting; (d) the EULA constraint, so no reviewer suggests mirroring the installer.

---

## Self-review

**1. Spec coverage (Layer 3 + the corrections section).**

| Spec item | Task |
|---|---|
| DB CHECK widening, forward-only | 1 |
| `BuiltinPackageDef` third arm ("do not force HP into an existing arm") | 2 |
| `ensureBuiltinPackage` creates an install-method row, not a version row | 4 |
| Install-method API boundary — "decide which in the plan" | 4 (decision) + 5 (implementation) |
| Install-method validation shape (`kind`, `winget`, `windows`, `HP.HPCMSL`) | 2 (definition), 4 (test), 5 (route) |
| Web readiness separation + branding entry | 7, 8 |
| Catalog renders with an `hp_cmsl` item (mandatory test) | 8 |
| Keep HP out of the EDR secret branch | 3 |
| `originalFileName` hardcode — "guard or fix it" | 2 (fixed: moved onto the def) |
| Partner-wide allowlist policy, `catalogId` rule, `enforceMode`, `autoInstall` | 9 |
| "one deployment run per organisation … say so" | 9 (module docstring + PR checklist) |
| EULA: never mirror or host the installer | Gates section + Task 2 code comment |
| Targeting via `osType` / `hardware.manufacturer` | 9 — **spec claim does not hold for software policies; corrected, with the alternative recorded as an open question for Todd** |

No spec item is unassigned.

**2. Placeholder scan.** No `TBD`, no "similar to Task N", no "add appropriate error handling". Every code step carries complete code. Two places defer to a runtime observation rather than inventing a value, and both say so explicitly and carry a fallback: Task 9's `HP_CMSL_RULE_NAME` wildcard (the exact Add/Remove Programs DisplayName is W01 gate question 3) and Task 9 Step 4's note to confirm `configurationPolicies`' required columns. Neither is a placeholder — both are named unknowns with a stated default and a test.

**3. Type consistency.** `BuiltinEdrProvider` / `BuiltinProvider` (Task 2) are consumed by name in Tasks 3 and 4. `installSource` is spelled identically in Tasks 2 and 4 and in the tests. `BuiltinInstallMethodDef`'s field names (`platform`, `kind`, `packageId`) match `software_install_methods` columns and `installMethodBodySchema`. `EdrProvider` / `IntegrationProvider` / `isEdrProvider` (Task 7) are consumed by name in Task 8. `warrantyLinkEnablesHpCmsl` and `provisionHpCmslForFeatureLink` (Task 6) match their call sites and Task 9's extension. `ensureHpCmslSoftwarePolicy(params: { partnerId, catalogId })` returns `{ softwarePolicyId, configPolicyId }` in the implementation, the unit test and the integration test. `ensureBuiltinPackage` keeps its existing `{ provider, partnerId } → { catalogId }` signature throughout.

**4. Contract facts found wrong (reported, plan written to the corrected facts).** `filterEngine.ts:88`/`:94` are off by one (real: `:89`, `:95`). The spec's `software.ts:287` for the unimplemented `sites` targeting is wrong (real: `:400-405`). The claim that `hardware.manufacturer` targeting is available to a software policy is wrong — it is available to deployments only. The claim that adding `hp_cmsl` to `INTEGRATION_PROVIDERS` crashes the catalog is conditional: `SoftwareCatalog.tsx:271-275` currently narrows it away, so the first symptom is a silent misrender, and the crash only appears once that line is widened. Everything else the contract asserts was re-opened and confirmed.
