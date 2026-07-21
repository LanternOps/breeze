# Weavestream Native Reconstruction Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Weavestream’s existing pull-integration framework so one Breeze connection produces a complete, native, searchable, lifecycle-safe reconstruction dossier for every explicitly mapped company and a standalone company PDF.

**Architecture:** Keep the existing `Integration`, encrypted `IntegrationSecret`, explicit `IntegrationCompanyMapping`, BullMQ scheduling, run history, and field-ownership behavior. Generalize asset-only resources into typed targets backed by native foreign keys and target writers. The Breeze driver validates versioned partner-API DTOs and emits typed reconstruction inputs. Workers execute a resource DAG: assets/articles/subnets, then IP reservations, then relations, then full-reconciliation/completeness. A successful full crawl marks unseen source bindings stale without deleting manual content.

**Tech Stack:** NestJS, TypeScript, Prisma/PostgreSQL, BullMQ/Redis, Zod, Next.js/React, Jest, PDFKit.

## Global Constraints

- Execute this plan in the Weavestream repository, not the Breeze repository that stores this cross-project plan.
- Use the existing integration controllers, encrypted secret service, organization mappings, queues, run history, asset search indexing, IPAM service, relations service, articles service, export service, and PDF worker. Do not build a Breeze-specific side service.
- One Breeze integration holds one encrypted `apiKey` and `baseUrl`; `listSourceOrgs` discovers all partner organizations. Mapping from Breeze organization UUID to Weavestream company UUID is always explicit.
- No automatic company creation and no name/slug-based tenant mapping. Unmapped organizations remain visible and skipped.
- Breeze sites are location assets, never child companies.
- Exclude live state: device online/offline, heartbeat/last-seen, uptime, alerts, metrics, vulnerabilities, patch posture, logs, sockets, sessions, commands, and backup execution history.
- Never persist raw Breeze payloads, source credentials, secret values, secret-derived checksums, or rejected secret-bearing values in records, gaps, conflicts, audit, logs, exports, or PDFs.
- Do not create a Weavestream password from Breeze. Missing credential requirements become relations to manually managed password records or completeness gaps.
- There is no new expiration table. Warranty/support/license dates use expiry-marked asset DATE/DATETIME fields so the existing expiration aggregator continues to work.
- Source-owned fields may use `source_wins`; rebuild facts that an operator may refine use `preserve_manual`; `manual_only` is never written. Manual records/relations/articles are never candidates for source stale handling.
- Stable binding identity is `(integrationCompanyMappingId, resourceId, externalId)` where `externalId` is namespaced as `${externalOrgId}:${resourceKey}:${sourceId}`. Display names, serials, hostnames, and IPs are not identity.
- An incremental checkpoint advances only after all pages succeed. Only a complete successful full crawl may mark unseen source bindings stale.
- Commit after each green task. Every task starts with a failing adjacent test.

## Target and Resource Contract

Use native target kinds that preserve referential integrity:

```ts
export const integrationTargetKindSchema = z.enum([
  'asset',
  'subnet',
  'ip_reservation',
  'article',
  'relation',
]);

export type ReconstructionInput =
  | AssetReconstructionInput
  | SubnetReconstructionInput
  | IpReservationReconstructionInput
  | ArticleReconstructionInput
  | RelationReconstructionInput;
```

The Breeze descriptor initially advertises these dependency-ordered resources:

| Resource key | Target | Depends on | Destination behavior |
|---|---|---|---|
| `sites` | `asset` | — | Location assets |
| `devices` | `asset` | `sites` | Server/workstation/network/virtual assets |
| `device-inventory` | `asset` | `devices` | Update the bound device’s hardware, disk, firmware, OS, interface, and warranty fields |
| `device-software` | `asset` | `devices` | Update the bound device’s structured installed-software table |
| `subnets` | `subnet` | `devices` | Derived from `/device-inventory`; native IPAM subnets/VLAN/gateway/DNS facts |
| `ip-reservations` | `ip_reservation` | `subnets`, `devices` | Derived from `/device-inventory`; durable static/reserved assignments only |
| `configuration-policies` | `article` | — | Versioned non-secret desired-state articles |
| `scripts` | `article` | — | Versioned rebuild-safe script articles |
| `automations` | `article` | `scripts` | Versioned automation/procedure articles |
| `backup-configurations` | `article` | — | Versioned schedule/retention/restore-metadata articles |
| `custom-fields` | `asset` | `devices` | Update only configured asset fields |
| `device-relationships` | `relation` | all entity resources | Native company/site/device/network/VM/config/procedure relationships |

`device-inventory`, `device-software`, and `custom-fields` use `targetConfig.bindingResourceKey = 'devices'` so multiple source resources may update the same native asset while retaining independent provenance/checkpoints.

Driver resource keys are destination-oriented and do not imply matching Breeze endpoints. `subnets` and `ip-reservations` both page the versioned `/device-inventory` source endpoint and select different normalized records; no nonexistent Breeze `/subnets` or `/ip-reservations` route is introduced. The driver descriptor records `sourceEndpoint` in target configuration so this derivation is visible and testable.

---

### Task 1: Generalize shared schemas and persist native target bindings

**Files:**

- Modify: `packages/shared/src/schemas/integration.ts`
- Modify: `packages/shared/src/queues/index.ts`
- Modify: `apps/api/src/integrations/integration-schemas.spec.ts`
- Create: `packages/db/prisma/migrations/0055_integration_native_reconstruction/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`
- Modify: `apps/api/src/prisma/tenant-scoped-models.ts`
- Modify: `apps/api/src/prisma/tenant-scoped-models.spec.ts`

**Schema changes:**

- `IntegrationResource`: add required `targetKind`, JSON `targetConfig`, and descriptor-owned dependency keys; retain asset layout/match keys only for asset resources.
- `IntegrationFieldMapping`: make `targetFieldId` nullable and add nullable `targetPath`; enforce exactly one target destination.
- `IntegrationSyncRecord`: make `assetId` nullable; add nullable `subnetId`, `ipReservationId`, `articleId`, `relationId`, plus `targetKind`, `state`, `lastSeenAt`, `staleSince`, `sourceUpdatedAt`, and sanitized `provenance` JSON.
- Add tenant-scoped `IntegrationSyncCheckpoint`, `IntegrationReconstructionSummary`, and `IntegrationReconstructionGap` models.

```ts
type IntegrationSyncState = 'active' | 'stale' | 'blocked';
type ReconstructionGapKind =
  | 'secret_blocked'
  | 'missing_dependency'
  | 'validation'
  | 'unsupported'
  | 'ambiguous'
  | 'synchronization_error';
```

- [ ] **Step 1: Write failing schema and tenant-scope tests**

Test backward parsing for existing descriptors (default `targetKind: 'asset'`), valid target-specific configs, invalid dependency cycles/shapes, bounded transforms, new totals/gap DTOs, and registration of all three new tenant-scoped models. Test that a field mapping cannot have both/neither `targetFieldId` and `targetPath`.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @weavestream/api test -- --runInBand apps/api/src/integrations/integration-schemas.spec.ts apps/api/src/prisma/tenant-scoped-models.spec.ts
```

- [ ] **Step 3: Add the Prisma migration and model definitions**

The migration must:

1. Create `IntegrationTargetKind` and `IntegrationSyncState` enums.
2. Backfill every existing resource/record as `asset` and every existing record as `active` with `last_seen_at = last_synced_at`.
3. Add native target FKs with `ON DELETE CASCADE`/`SET NULL` consistent with current asset binding lifecycle.
4. Add a check constraint requiring exactly one target FK and requiring that FK to match `target_kind`.
5. Add a check constraint requiring asset mappings to use `target_field_id` and native scalar mappings to use `target_path`.
6. Create checkpoint, summary, and gap tables with `company_id`, mapping/resource FKs, bounded JSON details, timestamps, and uniqueness/indexes for active evaluation.

Do not replace native FKs with an unchecked polymorphic string target.

- [ ] **Step 4: Implement the Zod and queue contracts**

Add `targetKind`, `targetConfig`, `dependsOnResourceKeys`, staged job metadata, stale/restored/blocked/secretBlocked/missingDependency totals, provenance DTOs, and bounded gap DTOs. Keep target kind driver-declared and not operator-editable.

- [ ] **Step 5: Generate Prisma and run focused verification**

```bash
pnpm --filter @weavestream/db prisma:generate
pnpm --filter @weavestream/api test -- --runInBand apps/api/src/integrations/integration-schemas.spec.ts apps/api/src/prisma/tenant-scoped-models.spec.ts
pnpm --filter @weavestream/shared typecheck
pnpm --filter @weavestream/db typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schemas/integration.ts packages/shared/src/queues/index.ts packages/db/prisma apps/api/src/integrations/integration-schemas.spec.ts apps/api/src/prisma
git commit -m "feat(integrations): add native reconstruction targets"
```

---

### Task 2: Add bounded transforms and typed target writers

**Files:**

- Create: `apps/api/src/integrations/transforms/integration-transform.service.ts`
- Create: `apps/api/src/integrations/transforms/integration-transform.service.spec.ts`
- Create: `apps/api/src/integrations/reconstruction/reconstruction-target.ts`
- Create: `apps/api/src/integrations/reconstruction/reconstruction-writer.registry.ts`
- Create: `apps/api/src/integrations/reconstruction/asset-target.writer.ts`
- Create: `apps/api/src/integrations/reconstruction/asset-target.writer.spec.ts`
- Create: `apps/api/src/integrations/reconstruction/ipam-target.writer.ts`
- Create: `apps/api/src/integrations/reconstruction/ipam-target.writer.spec.ts`
- Create: `apps/api/src/integrations/reconstruction/article-target.writer.ts`
- Create: `apps/api/src/integrations/reconstruction/article-target.writer.spec.ts`
- Create: `apps/api/src/integrations/reconstruction/relation-target.writer.ts`
- Create: `apps/api/src/integrations/reconstruction/relation-target.writer.spec.ts`

**Writer contract:**

```ts
export interface ReconstructionWriteOutcome {
  targetKind: IntegrationTargetKind;
  targetId: string;
  checksum: string;
  change: 'created' | 'updated' | 'unchanged' | 'restored' | 'blocked';
  provenance: SafeIntegrationProvenance;
  gaps: ReconstructionGapInput[];
}

export interface ReconstructionWriter<T extends ReconstructionInput> {
  readonly targetKind: T['targetKind'];
  validate(input: T): ValidatedReconstructionInput<T>;
  write(ctx: ReconstructionWriteContext, input: T): Promise<ReconstructionWriteOutcome>;
}
```

- [ ] **Step 1: Write failing transform tests**

Cover trim/case, number/boolean/date coercion, enum lookup, first-nonempty, join, byte formatting, CIDR/IP normalization, and Markdown table generation. Reject unknown operations, unbounded recursion/output, invalid dates/IPs/CIDRs, and transforms that produce secret-like content. Assert canonical transform descriptors affect the mapping fingerprint.

- [ ] **Step 2: Write failing writer tests**

For every writer cover create/update/unchanged, wrong company, missing dependency, validation, source identity collision, manual ownership, restore, and bounded provenance. Asset updates must use the current field checksum rules; IPAM writes must preserve native validation; relation writes must call the idempotent relation service; article writes must create version history without overwriting a manual article.

- [ ] **Step 3: Run and confirm missing modules**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integration-transform|target.writer'
```

- [ ] **Step 4: Implement transforms and writer registry**

Apply transforms before native validation. Include the canonical transform object in `computeMappingFingerprint`. Use explicit system-level writer inputs with `companyId` and integration audit attribution; do not fabricate an interactive `AuthedUser` to call request-only service APIs.

- [ ] **Step 5: Implement target semantics**

- Asset: create or bind through layout/match rules; support `bindingResourceKey` updates to an existing device asset.
- Subnet/reservation: use native `Subnet`/`IpReservation` constraints and normalize CIDR/IP before lookup.
- Article: create/update a source-owned Markdown article with source revision/fingerprint and a published article version; keep manual notes in separate manual articles/sections.
- Relation: resolve both endpoint bindings inside the same company and use the existing idempotent composite key.

- [ ] **Step 6: Run focused tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integration-transform|target.writer'
pnpm --filter @weavestream/api typecheck
git add apps/api/src/integrations/transforms apps/api/src/integrations/reconstruction
git commit -m "feat(integrations): write typed reconstruction targets"
```

---

### Task 3: Generalize resource readiness, matching, runner dispatch, and dependency stages

**Files:**

- Modify: `apps/api/src/integrations/drivers/integration-driver.ts`
- Modify: `apps/api/src/integrations/integrations.service.ts`
- Create: `apps/api/src/integrations/integrations.service.spec.ts`
- Modify: `apps/api/src/integrations/match-resolver.service.ts`
- Modify: `apps/api/src/integrations/match-resolver.service.spec.ts`
- Modify: `apps/api/src/integrations/integration-sync-runner.service.ts`
- Create: `apps/api/src/integrations/integration-sync-runner.service.spec.ts`
- Modify: `apps/api/src/integrations/integration-sync.service.ts`
- Create: `apps/api/src/integrations/integration-sync.service.spec.ts`
- Modify: `apps/api/src/integrations/integrations-core.module.ts`
- Modify: `apps/worker/src/integration-sync/integration-sync-orchestrator.processor.ts`
- Create: `apps/worker/src/integration-sync/integration-sync-orchestrator.processor.spec.ts`
- Modify: `apps/worker/src/integration-sync/integration-sync-mapping.processor.ts`
- Create: `apps/worker/src/integration-sync/integration-sync-mapping.processor.spec.ts`

- [ ] **Step 1: Write failing DAG/readiness tests**

Assert descriptor cycles, missing dependency keys, or target-writer absence fail during registry/resource reconciliation. Assert asset resources require layout/mappings, native resources require valid target config, update resources require their binding resource, and disabled dependencies disable downstream execution with a bounded gap.

- [ ] **Step 2: Write failing runner/worker tests**

Cover binding-first resolution, target natural-key ambiguity, writer dispatch, page atomicity, dry run, mapping/resource isolation, stage ordering, one-company failure isolation, invalid queue payloads, retries, and totals. Specifically prove reservations cannot run before subnets/devices and relations cannot run before all entity stages.

- [ ] **Step 3: Run and confirm failures**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integrations.service|match-resolver|integration-sync'
pnpm --filter @weavestream/worker test -- --runInBand --testPathPattern='integration-sync'
```

- [ ] **Step 4: Refactor runner through the writer registry**

Remove direct asset/field/audit/search writes from the generic loop. The runner validates the driver page, transforms each typed input, resolves an existing binding/target, invokes the matching writer, atomically persists its binding and page checkpoint, and accumulates bounded outcomes/gaps.

Extend `FetchRecordsContext` with `mode: 'incremental' | 'full'`, `updatedSince`, and the committed snapshot/cursor state. Extend `DriverFetchPage` with schema version, bounded `snapshotAt`, blocked inputs, and a source high-water value. Preserve backward defaults for existing drivers; only a page marked complete after the terminal cursor may advance the high-water/full-crawl marker.

- [ ] **Step 5: Execute a per-mapping dependency DAG**

Topologically sort enabled resources, group them into stages, and fan out companies while processing each company’s stages sequentially. Preserve existing top-level/manual/scheduled run IDs and per-company results. A resource warning does not erase successful prior-stage writes; a hard failed dependency skips dependents visibly.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integrations.service|match-resolver|integration-sync'
pnpm --filter @weavestream/worker test -- --runInBand --testPathPattern='integration-sync'
git add apps/api/src/integrations apps/worker/src/integration-sync
git commit -m "refactor(integrations): execute native resource DAG"
```

---

### Task 4: Breeze Partner API client, driver, recommended layouts, and registry

**Files:**

- Create: `apps/api/src/integrations/drivers/breeze/breeze.schemas.ts`
- Create: `apps/api/src/integrations/drivers/breeze/breeze-partner-api.client.ts`
- Create: `apps/api/src/integrations/drivers/breeze/breeze-partner-api.client.spec.ts`
- Create: `apps/api/src/integrations/drivers/breeze/breeze.transforms.ts`
- Create: `apps/api/src/integrations/drivers/breeze/breeze.driver.ts`
- Create: `apps/api/src/integrations/drivers/breeze/breeze.driver.spec.ts`
- Modify: `apps/api/src/integrations/drivers/integration-driver.registry.ts`
- Modify: `apps/api/src/integrations/integrations.service.ts`
- Modify: `apps/api/src/integrations/integrations.service.spec.ts`
- Add: `apps/web/public/integrations/drivers/breeze.svg`

**Client surface:**

```ts
export class BreezePartnerApiClient {
  testConnection(ctx: BreezePartnerApiContext): Promise<void>;
  listOrganizations(ctx: BreezePartnerApiContext): Promise<BreezeOrganization[]>;
  fetchPage(
    ctx: BreezePartnerApiContext,
    input: {
      resource: BreezeResourceKey;
      externalOrgId: string;
      cursor: string | null;
      updatedSince: string | null;
    },
  ): Promise<BreezePartnerEnvelope<unknown>>;
}
```

- [ ] **Step 1: Write failing client tests**

Cover safe URL construction, `X-API-Key`, no credential logging, schema version `1`, Zod envelope validation, organization pagination, per-resource pagination, stable snapshot, repeated/non-advancing cursor rejection, a hard page cap, empty data, 401/403 → `DriverAuthError`, 429/5xx retry with `Retry-After`, timeout, malformed JSON, and unknown schema version before writes.

- [ ] **Step 2: Write failing driver/descriptor tests**

Cover connection test, organization discovery, static field catalogs, all resource transforms, dependencies, recommended layouts, target configs, unknown resource rejection, stable namespaced external IDs, NUL-safe text, secret-blocked inputs, and explicit absence of monitoring fields.

- [ ] **Step 3: Run and confirm missing driver failures**

```bash
pnpm --filter @weavestream/api test -- --runInBand apps/api/src/integrations/drivers/breeze/breeze-partner-api.client.spec.ts apps/api/src/integrations/drivers/breeze/breeze.driver.spec.ts
```

- [ ] **Step 4: Implement the client on guarded transport**

Use `fetchWithRetry`/`safeFetch` from `driver-utils.ts`; retain private-network blocking unless an administrator has explicitly configured the existing egress CIDR policy. Never bypass guarded outbound transport for self-hosted Breeze.

- [ ] **Step 5: Implement and register `BreezeDriver`**

Descriptor config is `baseUrl`; secret is `apiKey`; capabilities remain pull/list-source-orgs/dry-run. Do not add Breeze-specific controllers. The generic integration gallery, credential test, org mapping, scheduler, manual run, and run history must work through the registry.

- [ ] **Step 6: Bootstrap recommended asset layouts idempotently**

Extend `IntegrationsService.create`/`reconcileResources` with `ensureResourceDestination`. Create/reuse global layout/field definitions and initial mappings only when the resource has no existing layout/mappings. Never overwrite an administrator-customized layout, field mapping, direction, or transform.

Recommended device fields include stable Breeze ID, hostname/display name, type/role, site, vendor/model/serial, OS edition/build/architecture, install facts, CPU/memory/firmware/disks/interfaces, installed-software table, warranty/support expiry, virtualization role, and selected custom fields. Do not include status or last-seen.

- [ ] **Step 7: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand apps/api/src/integrations/drivers/breeze/breeze-partner-api.client.spec.ts apps/api/src/integrations/drivers/breeze/breeze.driver.spec.ts apps/api/src/integrations/integrations.service.spec.ts
pnpm --filter @weavestream/api typecheck
git add apps/api/src/integrations apps/web/public/integrations/drivers/breeze.svg
git commit -m "feat(integrations): add Breeze reconstruction driver"
```

---

### Task 5: Credential, organization-mapping, schedule, and foundational asset verification

**Files:**

- Create: `apps/api/src/integrations/integrations.controller.spec.ts`
- Create: `apps/api/src/integrations/company-mapping.service.spec.ts`
- Create: `apps/api/src/integrations/integration-sync-scheduler.service.spec.ts`
- Modify: `apps/api/src/integrations/integration-sync-runner.service.spec.ts`
- Create: `apps/web/src/app/admin/(global)/integrations/create-integration-button.test.tsx`
- Create: `apps/web/src/app/admin/(global)/integrations/[id]/integration-tabs.test.tsx`
- Create: `apps/web/src/app/admin/(global)/integrations/[id]/orgs-tab.test.tsx`
- Create: `apps/web/src/app/admin/(global)/integrations/[id]/credentials-tab.test.tsx`

- [ ] **Step 1: Write failing security/mapping tests**

Verify existing integration routes enforce permissions/step-up, secrets are AES-GCM encrypted with integration AAD, only masks enter DTOs, logs/audit contain no plaintext, duplicate external organization mapping is rejected, cross-company mapping is rejected, unmapped organizations are returned but skipped, and a source organization cannot silently move to another company.

- [ ] **Step 2: Write failing schedule/foundational sync tests**

Verify default 15-minute cron (`*/15 * * * *`), ACTIVE registration as `scheduled-<integrationId>`, PAUSED/DISABLED removal, manual and dry-run actions, sites-before-devices, one location/device create, idempotent second run, rename/update by stable UUID, multi-partner/display-name collision isolation, source-wins, preserve-manual, and manual-only behavior.

- [ ] **Step 3: Run and confirm gaps**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integrations.controller|company-mapping|integration-sync-scheduler|integration-sync-runner'
pnpm --filter @weavestream/web test -- --runInBand --testPathPattern='integration'
```

- [ ] **Step 4: Make only test-driven framework/UI corrections**

Reuse existing controllers/components. Add Breeze-specific UI code only when the generic descriptor cannot express the behavior. All credential and mapping mutation feedback must use the existing Weavestream action/toast conventions.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integrations.controller|company-mapping|integration-sync-scheduler|integration-sync-runner'
pnpm --filter @weavestream/web test -- --runInBand --testPathPattern='integration'
git add apps/api/src/integrations apps/web/src/app/admin/\(global\)/integrations
git commit -m "test(integrations): verify Breeze foundation"
```

---

### Task 6: Reconstruction inventory, native IPAM, and dependency relations

**Files:**

- Modify: `apps/api/src/integrations/drivers/breeze/breeze.transforms.ts`
- Modify: `apps/api/src/integrations/drivers/breeze/breeze.driver.spec.ts`
- Modify: `apps/api/src/integrations/reconstruction/asset-target.writer.spec.ts`
- Modify: `apps/api/src/integrations/reconstruction/ipam-target.writer.spec.ts`
- Modify: `apps/api/src/integrations/reconstruction/relation-target.writer.spec.ts`
- Modify: `apps/api/src/ipam/ipam.service.ts`
- Modify: `apps/api/src/ipam/ipam.service.spec.ts`
- Modify: `apps/api/src/relations/relations.service.ts`
- Modify: `apps/api/src/relations/relations.service.spec.ts`

- [ ] **Step 1: Add failing end-to-end transformation tests**

Feed hardware, disk, firmware, interface/MAC, OS/install, software, warranty, network device, VLAN/subnet/gateway/DNS, static assignment, Hyper-V host/VM, site/device, device/interface/IP, configuration assignment, and backup/procedure edges. Assert dynamic addresses remain informational asset fields, not reservations; event-only clients/peripherals do not become durable entities.

- [ ] **Step 2: Run and confirm missing mapping/dependency failures**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='breeze.driver|asset-target|ipam-target|relation-target|ipam.service|relations.service'
```

- [ ] **Step 3: Implement inventory normalization**

Group inventory/software by device source UUID and update the device binding. Use structured asset field values instead of a monolithic raw JSON blob. Mark warranty/support dates as expiry fields. Normalize network addresses and create only durable subnets/static or reserved assignments.

- [ ] **Step 4: Implement two-pass relationship resolution**

Resolve endpoint bindings after entity stages. Create only same-company relations and attach source provenance/external edge key. Missing endpoints create `missing_dependency` gaps and warnings; never create dangling or cross-tenant edges.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='breeze.driver|asset-target|ipam-target|relation-target|ipam.service|relations.service'
git add apps/api/src/integrations apps/api/src/ipam apps/api/src/relations
git commit -m "feat(integrations): reconstruct inventory and topology"
```

---

### Task 7: Desired-state articles and secret-blocked gaps

**Files:**

- Modify: `apps/api/src/integrations/drivers/breeze/breeze.transforms.ts`
- Modify: `apps/api/src/integrations/drivers/breeze/breeze.driver.spec.ts`
- Modify: `apps/api/src/integrations/reconstruction/article-target.writer.ts`
- Modify: `apps/api/src/integrations/reconstruction/article-target.writer.spec.ts`
- Modify: `apps/api/src/articles/articles.service.ts`
- Modify: `apps/api/src/articles/articles.service.spec.ts`

- [ ] **Step 1: Write failing desired-state tests**

Cover configuration policy/assignment, rebuild-safe script/parameters, automation dependencies, backup target/schedule/retention/exclusions/restore metadata, installation sources, ordered rebuild steps, and post-build validation. Assert the rendered article is complete enough without a Breeze link and includes source revision/fingerprint/date as provenance.

- [ ] **Step 2: Write failing secret-safety tests**

Pass blocked metadata from Breeze and malicious inline values that resemble password/token/private-key/authorization/provider credentials. Assert no article/version/gap/conflict/audit/log contains the secret, raw source definition, or secret-derived hash. Assert a safe `secret_blocked` gap still identifies resource/source/org and remediation reason.

- [ ] **Step 3: Run and confirm failures**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='breeze.driver|article-target|articles.service'
```

- [ ] **Step 4: Implement versioned Markdown destinations**

Create a deterministic source-owned folder/article slug per resource and source UUID. Refresh only source-owned content when its fingerprint changes. Preserve manual articles, relations, attachments, and manual notes. Relate articles to affected assets in the relation stage.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='breeze.driver|article-target|articles.service'
git add apps/api/src/integrations apps/api/src/articles
git commit -m "feat(integrations): sync reconstruction procedures"
```

---

### Task 8: Checkpoints, full reconciliation, provenance, stale/restore, and completeness

**Files:**

- Create: `apps/api/src/integrations/reconstruction/integration-provenance.service.ts`
- Create: `apps/api/src/integrations/reconstruction/integration-provenance.service.spec.ts`
- Create: `apps/api/src/integrations/reconstruction/integration-completeness.service.ts`
- Create: `apps/api/src/integrations/reconstruction/integration-completeness.service.spec.ts`
- Modify: `apps/api/src/integrations/integration-sync-runner.service.ts`
- Modify: `apps/api/src/integrations/integration-sync-runner.service.spec.ts`
- Modify: `apps/api/src/integrations/integration-sync.service.ts`
- Modify: `apps/api/src/assets/assets.service.ts`
- Modify: `apps/api/src/articles/articles.service.ts`
- Modify: `apps/api/src/ipam/ipam.service.ts`
- Modify: `apps/api/src/relations/relations.service.ts`

- [ ] **Step 1: Write failing checkpoint/reconciliation tests**

Cover page commit/resume, crash after write/before checkpoint, repeated page, high-water advance only after all pages, independent mapping/resource checkpoints, full snapshot marker, no stale after partial/auth/rate-limit/schema/cancel failure, stale after successful full crawl, restoration to the same target, and move/quarantine behavior across mapped/unmapped organizations.

- [ ] **Step 2: Write failing completeness tests**

Evaluate per company/layout/resource: credential reference, installation source/media, license/activation, physical location, IP/firewall requirements, backup destination/restore procedure, dependencies, ordered rebuild steps, validation steps, vendor/escalation contact. Classify current synchronized, manually documented, secret-blocked, missing, stale, and synchronization error. A failed sync must not downgrade the previous last-known-good summary.

- [ ] **Step 3: Run and confirm failures**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integration-provenance|integration-completeness|integration-sync-runner'
```

- [ ] **Step 4: Replace destructive disappearance behavior**

Change `archiveDisappearedRecords`: do not delete the binding or clear asset external identity. After a complete successful full crawl only, set unseen bindings to `stale`, set `staleSince`, preserve provenance/history/manual content, and apply a target-specific visible stale/archive policy. A returning source sets `active`, clears `staleSince`, and updates the same native target.

- [ ] **Step 5: Persist bounded provenance and gaps**

Store integration ID, source org/resource/external ID, source revision/fingerprint, first/last seen, last sync, ownership, and state. Upsert current gaps, resolve absent gaps after a successful evaluation, cap detail/message/count sizes, and exclude raw values.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integration-provenance|integration-completeness|integration-sync-runner'
git add apps/api/src/integrations apps/api/src/assets apps/api/src/articles apps/api/src/ipam apps/api/src/relations
git commit -m "feat(integrations): reconcile reconstruction lifecycle"
```

---

### Task 9: Completeness, provenance, and target-aware administration UI

**Files:**

- Modify: `apps/api/src/integrations/integrations.controller.ts`
- Modify: `apps/web/src/app/admin/(global)/integrations/[id]/page.tsx`
- Modify: `apps/web/src/app/admin/(global)/integrations/[id]/integration-tabs.tsx`
- Modify: `apps/web/src/app/admin/(global)/integrations/[id]/runs-tab.tsx`
- Modify: `apps/web/src/app/admin/(global)/integrations/[id]/field-mappings-tab.tsx`
- Create: `apps/web/src/app/admin/(global)/integrations/[id]/completeness-tab.tsx`
- Create: `apps/web/src/app/admin/(global)/integrations/[id]/completeness-tab.test.tsx`
- Create: `apps/web/src/components/integrations/provenance-badge.tsx`
- Create: `apps/web/src/components/integrations/provenance-badge.test.tsx`
- Modify: asset, article, and `ipam/[subnetId]/subnet-detail-view.tsx` detail surfaces to render provenance/state

- [ ] **Step 1: Write failing API/UI tests**

Add bounded paginated completeness/gap endpoints and test tenant authorization, filtering, stale/blocked/error labels, safe messages, and summary counts. UI tests cover all six completeness categories, mapping/resource filters, run counters, provenance dates/state/source, and absence of raw source values.

- [ ] **Step 2: Run and confirm failures**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integrations.controller'
pnpm --filter @weavestream/web test -- --runInBand --testPathPattern='completeness-tab|provenance-badge|field-mappings-tab'
```

- [ ] **Step 3: Add target-aware configuration**

Show the generic field-mapping editor only for compatible asset/native paths. Article resources configure folder/visibility/template; IPAM resources show normalization/match behavior; relation resources show dependency keys/type mapping. Fix transform UI round-tripping so edits do not reset `transform` to null.

- [ ] **Step 4: Add completeness/provenance views**

Expose `GET /v1/admin/integrations/:id/completeness` and a paginated gaps route under the existing admin controller. Render current/manual/blocked/missing/stale/error distinctly and link only to native Weavestream targets.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integrations.controller'
pnpm --filter @weavestream/web test -- --runInBand --testPathPattern='integration|completeness|provenance'
git add apps/api/src/integrations apps/web/src/app/admin/\(global\)/integrations apps/web/src/components/integrations apps/web/src/app/admin/companies
git commit -m "feat(integrations): show reconstruction completeness"
```

---

### Task 10: Standalone company export and PDF

**Files:**

- Modify: `apps/api/src/exports/company-export-data.service.ts`
- Create: `apps/api/src/exports/company-export-data.service.spec.ts`
- Modify: `apps/worker/src/company-pdf-export/pdf-builder.ts`
- Modify: `apps/worker/src/company-pdf-export/pdf-builder.spec.ts`
- Modify: `apps/worker/src/company-pdf-export/company-pdf-export.processor.spec.ts`

**Export additions:**

```ts
export interface CompanyExportData {
  // existing company, members, assets, passwords, articles, domains, uploads
  ipam: ExportSubnet[];
  relations: ExportRelation[];
  reconstruction: {
    summaries: ExportReconstructionSummary[];
    gaps: ExportSafeReconstructionGap[];
    provenance: ExportSourceProvenance[];
  };
}
```

- [ ] **Step 1: Write failing export-data tests**

Seed assets/articles/subnets/reservations/relations plus current/stale provenance and each safe gap kind. Assert company scoping, readable endpoint labels, source age/state, deterministic ordering, no raw upstream JSON, and no blocked secret value. Preserve existing explicit `includePasswords` behavior; Breeze sync never changes it.

- [ ] **Step 2: Write failing PDF tests**

Assert new sections and page contents for IPAM, static/reserved addresses, device/interface/IP links, topology/dependencies, reconstruction procedures, stale/source dates, and safe completeness gaps. Essential values must be text in the PDF, not available only through a Breeze URL. Cover empty sections, pagination/page breaks, long tables, Unicode, and secret absence.

- [ ] **Step 3: Run and confirm failures**

```bash
pnpm --filter @weavestream/api test -- --runInBand apps/api/src/exports/company-export-data.service.spec.ts
pnpm --filter @weavestream/worker test -- --runInBand src/company-pdf-export/pdf-builder.spec.ts src/company-pdf-export/company-pdf-export.processor.spec.ts
```

- [ ] **Step 4: Extend gather and PDF rendering**

Fetch native IPAM/relations/reconstruction data in `gather`, with tenant filters and bounded gap details. Add `renderIpam`, `renderRelationships`, and `renderReconstruction` after assets/articles in a readable order. Reuse existing formatting/layout helpers and keep links optional.

- [ ] **Step 5: Render and visually inspect fixture PDF**

Run the company export against the deterministic fixture, render PDF pages with Poppler, and inspect every page for clipping, orphan headings, unreadable tables, missing procedures, and accidental secrets. Record the fixture/export command in the test README so CI/manual QA can reproduce it.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm --filter @weavestream/api test -- --runInBand apps/api/src/exports/company-export-data.service.spec.ts
pnpm --filter @weavestream/worker test -- --runInBand src/company-pdf-export/pdf-builder.spec.ts src/company-pdf-export/company-pdf-export.processor.spec.ts
git add apps/api/src/exports apps/worker/src/company-pdf-export
git commit -m "feat(exports): render reconstruction dossier"
```

---

### Task 11: Cross-stack E2E, scale/failure injection, audit catalog, and documentation

**Files:**

- Modify: `apps/api/src/audit/audit-actions.ts`
- Modify: adjacent audit action catalog test
- Create: `apps/api/src/integrations/reconstruction/integration-reconstruction.integration.spec.ts`
- Create: `apps/api/src/integrations/reconstruction/reconstruction-scale.spec.ts`
- Create: `docs/integrations/breeze.md`
- Modify: `apps/api/src/ai-help/content/integration-syncs.md`

- [ ] **Step 1: Write the real-database reconstruction scenario**

Using the roadmap fixture, verify credential test, explicit org mapping, unmapped skip, sites/devices, inventory/software/warranty, subnet/reservation, articles, relations, idempotent second run, manual preservation, blocked secret, missing dependency, full-crawl stale, return/restore, completeness, export, and PDF. Include two Weavestream companies and prove target lookups cannot cross companies.

- [ ] **Step 2: Add failure injection**

Inject 401/403, 429 with `Retry-After`, transient 5xx, timeout, malformed page, repeated cursor, unknown schema, invalid record, worker crash after write, missing dependency, and partial full traversal. Assert bounded retries/quarantine and no loss/stale transition of last-known-good data.

- [ ] **Step 3: Add the 10,000-device scale scenario**

Use paginated synthetic data with realistic software/interface/relationship cardinality. Assert bounded batch sizes/query counts/memory, no duplicate bindings, capped gaps/conflicts, resumable checkpoints, no indefinitely overlapping 15-minute incremental jobs, and no stale sweep after an incomplete crawl.

- [ ] **Step 4: Add generic audit actions**

Register and test `integration.target.created`, `.updated`, `.stale`, `.restored`, and `.blocked`; record integration/mapping/resource/target identity and safe counts only.

- [ ] **Step 5: Publish operator documentation**

Document Breeze prerequisite scopes and URL, encrypted credential handling, organization mapping, 15-minute schedule/manual/full modes, retries, rotation/revocation, safe private-network allowlisting, resource mappings, field ownership, blocked/missing/stale meaning, PDF/export behavior, backup/restore of integration state, and recovery after credential or schema failure.

- [ ] **Step 6: Run complete Weavestream verification**

```bash
pnpm --filter @weavestream/db prisma:generate
pnpm --filter @weavestream/shared typecheck
pnpm --filter @weavestream/api test -- --runInBand --testPathPattern='integrations|exports'
pnpm --filter @weavestream/worker test -- --runInBand
pnpm --filter @weavestream/web test -- --runInBand
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/audit apps/api/src/integrations/reconstruction docs/integrations/breeze.md apps/api/src/ai-help/content/integration-syncs.md
git commit -m "test(integrations): verify Breeze reconstruction sync"
```

## Completion Checklist

- [ ] Breeze appears as a normal built-in integration and uses existing encrypted credentials, mappings, schedules, manual sync, and run history.
- [ ] One connection lists all source organizations; only explicit UUID mappings write company data.
- [ ] Sites/devices/inventory/software/warranty/custom fields are native structured assets without monitoring state.
- [ ] Networks use native IPAM, dependencies use native relations, desired state uses versioned articles, and expirations use existing expiry-marked fields.
- [ ] Manual fields/articles/relations/password references are never overwritten or deleted.
- [ ] Secret-bearing definitions create safe gaps without storing their values.
- [ ] Resource dependencies are acyclic and stage-ordered.
- [ ] Checkpoints resume safely; only a fully successful full traversal marks unseen bindings stale; returned records restore their original targets.
- [ ] Completeness distinguishes synchronized, manual, blocked, missing, stale, and error states.
- [ ] Ordinary company export/PDF contains the reconstruction dossier and remains usable while Breeze is unavailable.
- [ ] Cross-company tests, failure injection, and 10,000-device scale tests pass.
