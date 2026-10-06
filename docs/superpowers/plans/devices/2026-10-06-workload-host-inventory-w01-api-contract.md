# Workload Host Inventory W01 — API Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the API half of workload host inventory: two tenant-isolated device child tables, the `devices` host axis, the agent ingest route and device read route, and the `workload_inventory` configuration feature with heartbeat delivery. Nothing sends data yet; the feature is selectable through the policy API.

**Architecture:** One strict shared zod contract (`workloadsReportSchema`) feeds a pure planner (`planWorkloadSync`) that decides every write for one report: ordering guard, policy override, per-runtime replace-set or age-out, and the host-axis recompute. A thin ingest service applies the plan in one transaction under a per-device advisory lock. Enumeration is opt-in through an inline configuration feature whose resolver is shared by ingest and heartbeat delivery, so what the agent is told and what the server accepts cannot disagree.

**Tech Stack:** TypeScript, Zod 4, Hono, PostgreSQL (RLS), Drizzle, Redis (120 s settings cache), Vitest.

**Spec:** `docs/superpowers/specs/devices/2026-10-06-workload-host-inventory-design.md` (§4 data model and registrations, §6 ingest and read route, §7 configuration feature and delivery).

**Index:** `docs/superpowers/plans/devices/2026-10-06-workload-host-inventory.md`

Not in W01: any Go agent code (W02/W03), any web UI or fleet filter or AI tool or docs page (W04), any `upstream_*` / image-currency column or cache table (W05), compliance or monitor kinds (W06), partner API publication (OD-6).

## Global Constraints

Values below are verbatim from the spec; if code and this list disagree, the spec wins and the plan is wrong.

- **PR scope:** W01 only. Two migrations, no agent code, no web UI. Branch per the index: `feature/<parent#>-workload-inventory/wave-<sub-issue#>`; PR body carries `Closes #<sub-issue>`.
- **Migrations** (each idempotent, no inner `BEGIN`/`COMMIT`, **writes no rows**, so no `set_config('breeze.scope','system',true)` preamble and nothing is added to the `migrationRlsScope.test.ts` baseline):
  - `apps/api/migrations/2026-12-15-100000-device-workloads.sql` — `device_workloads`, `device_workload_runtimes`, `devices.hosts_workloads`, `devices.workload_runtimes`, `devices.workload_inventory_protocol_version`.
  - `apps/api/migrations/2026-12-15-100100-workload-inventory-config-feature.sql` — `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'workload_inventory'` and `config_policy_workload_inventory_settings`.
  - **Executor re-check before the first migration commit:** `ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -1`. Newest committed on 2026-10-05 was `2026-12-13-110200-org-erasure-fk-child-actions.sql`. If `origin/main` has moved past `2026-12-15-100000`, rename **both** files upward (and every `replayMigration('<name>')` reference in this plan's tests) before committing. The pre-push hook re-checks with `bash scripts/check-migration-naming.sh --against-ref origin/main`. Never use `2026-08-06-*`. Never rename a shipped migration.
- **`device_workloads` columns** (spec §4.1): `id uuid PK`, `device_id uuid NOT NULL`, `org_id uuid NOT NULL`, `runtime varchar(20) NOT NULL CHECK IN ('docker','podman','hyperv','proxmox')`, `kind varchar(20) NOT NULL CHECK IN ('container','vm','lxc')`, `workload_id varchar(128) NOT NULL`, `name varchar(255) NOT NULL`, `state varchar(20) NOT NULL` (`running|stopped|paused|restarting|other`), `raw_state varchar(40)`, `image_ref varchar(512)`, `image_repository varchar(400)`, `image_tag varchar(128)`, `image_digest varchar(80)`, `image_id varchar(80)`, `guest_os varchar(128)`, `compose_project varchar(128)`, `compose_service varchar(128)`, `compose_working_dir varchar(512)`, `restart_policy varchar(30)`, `cpu_count integer`, `memory_mb integer`, `started_at timestamp`, `runtime_created_at timestamp`, `first_seen_at/last_seen_at/updated_at timestamp NOT NULL`. Unique `(device_id, runtime, workload_id)`; index `(org_id)`; partial index `(org_id, image_repository, image_tag) WHERE kind = 'container'`.
- **`device_workload_runtimes` columns** (spec §4.2): `id`, `device_id`, `org_id`, `runtime varchar(20) NOT NULL` (CHECK adds `containerd`), `detection varchar(20) NOT NULL` (`present|absent|unknown`), `collection varchar(24) NOT NULL` (`ok|disabled|unavailable|permission_denied|error|unsupported`), `complete boolean NOT NULL`, `runtime_version varchar(64)`, `observed_count integer`, `reported_count integer`, `last_error varchar(500)`, `collected_at timestamp NOT NULL`, `last_attempt_at timestamp NOT NULL`, `last_success_at timestamp`, `updated_at timestamp NOT NULL`. Unique `(device_id, runtime)`.
- **Tenancy:** both tables are shape 5 with a denormalized `org_id`; composite FK `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`; RLS enabled + forced; four `breeze_org_isolation_*` policies on `breeze_has_org_access(org_id)`. Auto-discovered by `rls-coverage` — do **not** add to `DEVICE_ID_JOIN_POLICY_TABLES`.
- **No `jsonb` / `bytea` on either table** (D1) — each such column would be forced into `excludedOpen` in the tenant export. Every column is classified `included` (no name matches `SUSPICIOUS_NAME_PARTS`).
- **Not partner-export material (D12):** the W01 migration must **not** create the `breeze_partner_export_material_*` statement triggers and must **not** redefine `breeze_partner_export_device_child_*` functions (the memory-modules migration does both; copy only its table half). The `devices` update trigger compares an explicit column list (`2026-07-18-partner-export-org-locks.sql:310`), so the three new `devices` columns are non-material by construction.
- **Host axis (§4.3):** `devices.hosts_workloads boolean NOT NULL DEFAULT false`, `devices.workload_runtimes varchar(30)[] NOT NULL DEFAULT '{}'`. Ingest sets `workload_runtimes` = sorted runtimes with `detection = present`; `hosts_workloads = cardinality > 0`; a runtime with `detection = unknown` keeps its previous membership. Both columns are added to `PUBLIC_DEVICE_FIELDS` and to the `devices` export entry as `included`.
- **Capability:** `devices.workload_inventory_protocol_version integer NOT NULL DEFAULT 0` — the same shape as `consent_prompt_protocol_version` (`db/schema/devices.ts:266`); recognized value `1`; written non-sticky every heartbeat; classified `included` in the `devices` export entry.
- **Caps (§5.4, §6.2):** 1000 workloads per runtime per report (zod `.max(1000)`); 5 runtimes per report; truncated snapshots age out rows with `last_seen_at` older than **24 h**, then trim the oldest to **1500** retained rows per runtime.
- **Body limit:** `PUT /api/v1/agents/:id/workloads` is capped at **2 MiB** (`2 * 1024 * 1024`), enforced by both the route and the global gate rule `agent-workloads`.
- **Settings (§7.1):** `config_policy_workload_inventory_settings`: `feature_link_id` unique FK `ON DELETE CASCADE`, `enabled boolean NOT NULL DEFAULT false`, `docker_enabled/podman_enabled/hyperv_enabled/proxmox_enabled boolean NOT NULL DEFAULT true`, `interval_minutes integer NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 15 AND 1440)`. Parent-chain RLS plus the additive SELECT-only partner-wide branch. Inline feature: **not** added to `PARTNER_LINKABLE_FEATURE_TYPES`.
- **Trust tier:** `CONFIG_POLICY_FEATURE_TRUST_TIER.workload_inventory = 'protective'`.
- **Delivery (§7.2):** `configUpdate.workload_inventory_settings`; no policy → explicit defaults (`enabled: false`, so removing a policy turns collection off); resolver error → key omitted; Redis cache 120 s keyed by device; the same resolver runs inside ingest.
- **Tests run one file at a time:** `cd apps/api && npx vitest run <file>` (never `pnpm … test -- --run`; vitest paths are substring filters, check the reported file count). Integration suites need `pnpm test-stack up` and run with `npx vitest run --config vitest.integration.config.ts <file>`; the RLS coverage contract runs only as `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`. Typecheck with `NODE_OPTIONS=--max-old-space-size=12288` and check the exit code — never pipe `tsc` to `tail`.
- **Neutral wording:** public repo. Test names, comments and commit messages describe behavior; they do not characterize hostile inputs.

## Review Focus

These are the failure modes most likely to bite; each is pinned by a named test in its owning task.

1. **A replayed or reordered report must not overwrite newer state** — including an equal `collectedAt`; the guard compares `min(collectedAt, receivedAt)`, so a fast agent clock cannot park the device in the future (Task 3 "effective collection time"). Pinned in Task 3 `plan.test.ts` ("skips a runtime whose collectedAt is not newer…") and Task 6 `ingest.integration.test.ts` ("ignores a replayed report…"). Owner: Tasks 3, 6.
2. **A failing, unavailable, permission-denied or unsupported driver must never delete inventory.** Only an `ok` snapshot reconciles absence. Task 3 ("never deletes workloads for a failing collection") and Task 6 ("a failing driver leaves rows and last_success_at alone"). Owner: Tasks 3, 6.
3. **Disabled-by-policy deletes that runtime's rows, keeps the runtime row and keeps host-axis membership; and "no policy" means disabled.** Task 3 ("policy override…"), Task 5 `configUpdate.test.ts` (explicit defaults), Task 6 ("policy-disabled report deletes rows and keeps the host axis"). Owner: Tasks 3, 5, 6.
4. **Detection `unknown` keeps host-axis membership; `absent` removes it, keeps the runtime row marked `absent` (so the ordering guard survives) and deletes its workloads; a runtime the report does not mention is untouched** (an older agent build may not know a runtime). A replayed older `present` report after an `absent` one must be skipped. Task 3 ("host axis…", "a replayed older present report after an absent one is skipped"), Task 6. Owner: Tasks 3, 6.
5. **Duplicate `workloadId` within a runtime and duplicate runtime entries are a 400, not a unique-violation 500** (and a kind that does not fit the runtime, or any workload under `containerd`, is also a 400). Task 1 `workloads.test.ts`, Task 6 `workloads.test.ts` (route). Owner: Tasks 1, 6.
6. **A truncated snapshot (`complete = false` or `observedCount > workloads.length`) never reconciles by absence;** it ages rows out after 24 h and trims to 1500. Task 3 ("age-out…", "retained cap…", "observed greater than reported…"), Task 6. Owner: Tasks 3, 6.
7. **A resolver failure must never be read as "disabled".** Ingest resolves settings before any lock or write and throws; heartbeat omits the key. Task 5 ("rejects when the resolver fails"), Task 5 heartbeat test ("omits workload settings when its resolver fails"), Task 6 ("writes nothing when the caller cannot see the device (resolver and ownership checks fail closed)"). Owner: Tasks 5, 6.
8. **Registration is a mechanical contract, not a judgement call.** Cascade, device cascade, denormalized move list, merge policy, export policy (tables *and* the three new `devices` columns), `PUBLIC_DEVICE_FIELDS`, parent-FK RLS registration for the settings table. Task 2 and Task 4 steps, enforced end to end by Task 8. Owner: Tasks 2, 4, 8.

## File Structure

Task numbers are the owning task. Line numbers were verified against this checkout on 2026-10-05; re-grep the quoted anchor if a line has moved.

**Shared (`packages/shared/src`)**

- `constants/workloads.ts` (T1, create) — runtime / kind / state / detection / collection vocab, caps, protocol version, interval bounds.
- `constants/index.ts:185` (T1, modify) — `export * from './workloads';` next to `./timeSync`.
- `validators/workloads.ts` (T1, create) — `workloadsReportSchema`, nested schemas, inline settings schema, defaults, `isWorkloadRuntimeEnabled`.
- `validators/workloads.test.ts` (T1, create).
- `validators/index.ts:826` (T1, modify) — `export * from './workloads';` next to `./timeSync`.
- `constants/configFeatureTypes.ts:31,130` (T4, modify) — feature type + trust tier. `constants/configFeatureTypes.test.ts` (T4, modify).

**Database / API schema (`apps/api`)**

- `migrations/2026-12-15-100000-device-workloads.sql` (T2, create).
- `migrations/2026-12-15-100100-workload-inventory-config-feature.sql` (T4, create). *The brief grouped both migrations in one task; the enum value must land together with its Drizzle enum entry, the shared constant and the parity tests, so it travels with the configuration feature.*
- `src/db/schema/deviceWorkloads.ts` (T2, create); `src/db/schema/index.ts:17` (T2, modify).
- `src/db/schema/devices.ts:80,266` (T2, modify) — host axis + capability columns.
- `src/db/schema/configurationPolicies.ts:61,429` (T4, modify) — enum append + settings table.
- `src/services/tenantCascade.ts:565`, `src/routes/devices/core.ts:325,581`, `src/services/orgMergeRegistry.ts:903`, `src/services/tenantExportPolicyRegistry.ts:384,394`, `src/routes/devices/helpers.ts:27` (T2, modify).
- `src/__tests__/integration/rls-coverage.integration.test.ts:1020` (T4, modify) — settings table into `PARENT_FK_JOIN_POLICY_TABLES`.
- `vitest.config.ts` (exclude) and `vitest.integration.config.ts` (include) (T2, modify) — route `src/services/workloads/**/*.integration.test.ts` to the integration runner.

**API services (`apps/api/src/services/workloads/`)** — new directory

- `plan.ts`, `plan.test.ts` (T3) — pure planner.
- `settings.ts`, `settings.test.ts`, `settings.integration.test.ts` (T5) — resolver + cache.
- `configUpdate.ts`, `configUpdate.test.ts` (T5) — heartbeat wire payload.
- `testFixtures.ts` (T6) — typed raw report fixtures shared by route/ingest tests.
- `ingest.ts`, `ingest.integration.test.ts` (T6).
- `view.ts`, `view.test.ts`, `view.integration.test.ts` (T7).
- `migrations.integration.test.ts` (T2), `featureMigration.integration.test.ts` (T4) — real-Postgres proofs (the brief's `deviceWorkloads.integration.test.ts` is split across the owning tasks so each task's red/green is real).
- `src/services/inventoryChildSync.ts:84` (T6, modify) — export `lockDeviceInventory` with a narrower parameter type.

**API routes**

- `src/routes/agents/workloads.ts`, `workloads.test.ts`, `workloads.mounted.test.ts` (T6, create); `src/routes/agents/index.ts:19,88` (T6, modify).
- `src/middleware/bodyLimit.ts:37,208`, `bodyLimit.test.ts:250,366` (T6, modify).
- `src/routes/agents/parkedRouteClassification.test.ts:69`, `src/__tests__/writeRoutePermissionGate.contract.test.ts:139`, `src/__tests__/parkedFanout.contract.test.ts:299`, `src/services/mcpCoverage.ts:227,408` (T6/T7, modify) — the registries every new route or service file must join.
- `src/routes/devices/workloads.ts`, `workloads.test.ts` (T7, create); `src/routes/devices/index.ts:18,164` (T7, modify).
- `src/routes/agents/helpers.ts:70,2243` (T5, modify); `src/routes/agents/heartbeat.ts:42,297,983,2237-2371` (T5, modify); `src/routes/agents/schemas.ts:377` (T5, modify); `src/routes/agents/heartbeat.test.ts:181,3195` (T5, modify).
- `src/services/configurationPolicy.ts:16,65,895,1172,1223,1406,3134`, `src/routes/configurationPolicies/featureLinks.ts:17,380,654`, `src/services/policyBaselineDefaults.ts:17,64,114`, `src/services/aiToolsConfigPolicy.ts:248` (T4, modify); `apps/docs/src/content/docs/features/ai-tools.mdx:144` (T4, modify — the docs test pins every reference string).
- Web (T4, minimal, so the shared feature-type list still typechecks; the real tab is W04): `apps/web/src/components/configurationPolicies/featureTabs/types.ts:18`, `featureTypeParity.test.ts`, `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx:47`.

---

### Task 1: Shared workload constants, report schema and settings schema

**Files:**
- Create: `packages/shared/src/constants/workloads.ts`, `packages/shared/src/validators/workloads.ts`, `packages/shared/src/validators/workloads.test.ts`
- Modify: `packages/shared/src/constants/index.ts:185` (add `export * from './workloads';` directly after `export * from './timeSync';`), `packages/shared/src/validators/index.ts:826` (same, after `export * from './timeSync';`)

**Interfaces:**
- Produces (constants): `WORKLOAD_RUNTIMES`, `WORKLOAD_ENUMERATED_RUNTIMES`, `WORKLOAD_KINDS`, `WORKLOAD_STATES`, `WORKLOAD_DETECTIONS`, `WORKLOAD_COLLECTIONS`, `WORKLOAD_RUNTIME_KINDS`, `WORKLOADS_MAX_PER_RUNTIME = 1000`, `WORKLOADS_RETAINED_MAX_PER_RUNTIME = 1500`, `WORKLOADS_AGE_OUT_HOURS = 24`, `WORKLOADS_REPORT_MAX_BYTES = 2 * 1024 * 1024`, `WORKLOAD_INVENTORY_PROTOCOL_VERSION = 1`, `WORKLOAD_INVENTORY_{MIN,MAX,DEFAULT}_INTERVAL_MINUTES`; types `WorkloadRuntime`, `WorkloadEnumeratedRuntime`, `WorkloadKind`, `WorkloadState`, `WorkloadDetection`, `WorkloadCollection`.
- Produces (validators): `workloadReportItemSchema`, `workloadRuntimeReportSchema`, `workloadsReportSchema`, `workloadInventoryInlineSettingsSchema`, `WORKLOAD_INVENTORY_DEFAULTS`, `isWorkloadRuntimeEnabled(settings, runtime): boolean`; types `WorkloadReportItem`, `WorkloadRuntimeReport`, `WorkloadsReport`, `WorkloadInventoryInlineSettings`.
- Consumes: `zod` only. Note the report schema normalizes absent optional fields to `null` on **output** (`z.infer` is the output type), so downstream code never sees `undefined` for a column.
- Contract choices recorded in **Contract issues**: `workloadSchema` carries the agent-supplied subset of §4.1 (server-owned `id/device_id/org_id/runtime/first_seen_at/last_seen_at/updated_at` are not in the wire item); datetimes accept an offset (`{ offset: true }`).

- [ ] **Step 1: Write the failing test** — create `packages/shared/src/validators/workloads.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  WORKLOAD_INVENTORY_DEFAULTS,
  isWorkloadRuntimeEnabled,
  workloadInventoryInlineSettingsSchema,
  workloadsReportSchema,
} from './workloads';

const workload = (over: Record<string, unknown> = {}) => ({
  kind: 'container',
  workloadId: 'a'.repeat(64),
  name: 'web',
  state: 'running',
  ...over,
});
const runtime = (over: Record<string, unknown> = {}) => ({
  runtime: 'docker',
  detection: 'present',
  collection: 'ok',
  complete: true,
  runtimeVersion: '27.1.1',
  observedCount: 1,
  error: null,
  workloads: [workload()],
  ...over,
});
const report = (over: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  collectedAt: '2026-10-06T12:00:00Z',
  runtimes: [runtime()],
  ...over,
});

describe('workloadsReportSchema', () => {
  it('accepts a minimal report and normalizes absent optional columns to null', () => {
    const parsed = workloadsReportSchema.parse(report());
    const item = parsed.runtimes[0]!.workloads[0]!;
    expect(item).toMatchObject({
      kind: 'container',
      name: 'web',
      state: 'running',
      rawState: null,
      imageRef: null,
      imageDigest: null,
      composeProject: null,
      startedAt: null,
      cpuCount: null,
      memoryMb: null,
    });
  });

  it('accepts an offset timestamp as well as Z', () => {
    expect(
      workloadsReportSchema.safeParse(report({ collectedAt: '2026-10-06T08:00:00-04:00' })).success,
    ).toBe(true);
  });

  it('rejects an unknown key at every level (the field allowlist is enforced here, not only in the agent)', () => {
    expect(workloadsReportSchema.safeParse({ ...report(), extra: 1 }).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ extra: 1 })] })).success).toBe(false);
    for (const forbidden of ['env', 'command', 'entrypoint', 'args', 'mounts', 'volumes', 'ports', 'networks', 'labels']) {
      const result = workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ workloads: [workload({ [forbidden]: ['x'] })] })] }),
      );
      expect(result.success, `${forbidden} must be rejected`).toBe(false);
    }
  });

  it('rejects an unsupported protocol version and a missing collectedAt', () => {
    expect(workloadsReportSchema.safeParse(report({ protocolVersion: 2 })).success).toBe(false);
    const { collectedAt: _omit, ...rest } = report();
    expect(workloadsReportSchema.safeParse(rest).success).toBe(false);
  });

  it('bounds every string at its column length', () => {
    const tooLong: Array<[string, number]> = [
      ['workloadId', 129],
      ['name', 256],
      ['rawState', 41],
      ['imageRef', 513],
      ['imageRepository', 401],
      ['imageTag', 129],
      ['imageDigest', 81],
      ['imageId', 81],
      ['guestOs', 129],
      ['composeProject', 129],
      ['composeService', 129],
      ['composeWorkingDir', 513],
      ['restartPolicy', 31],
    ];
    for (const [field, length] of tooLong) {
      const result = workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ workloads: [workload({ [field]: 'x'.repeat(length) })] })] }),
      );
      expect(result.success, `${field} at ${length}`).toBe(false);
    }
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ runtimeVersion: 'x'.repeat(65) })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ error: 'x'.repeat(501) })] })).success).toBe(false);
  });

  it('caps a runtime at 1000 workloads and a report at 5 runtimes', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => workload({ workloadId: `w${i}` }));
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ workloads: many(1000), observedCount: 1000 })] })).success).toBe(true);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ workloads: many(1001), observedCount: 1001 })] })).success).toBe(false);
    const six = ['docker', 'podman', 'hyperv', 'proxmox', 'containerd', 'docker'].map((r) =>
      runtime({ runtime: r, workloads: [], observedCount: 0 }),
    );
    expect(workloadsReportSchema.safeParse(report({ runtimes: six })).success).toBe(false);
  });

  it('rejects a duplicate runtime entry', () => {
    const result = workloadsReportSchema.safeParse(report({ runtimes: [runtime(), runtime()] }));
    expect(result.success).toBe(false);
  });

  it('rejects a duplicate workloadId within one runtime but allows the same id under another runtime', () => {
    const dup = workloadsReportSchema.safeParse(
      report({
        runtimes: [runtime({ workloads: [workload(), workload()], observedCount: 2 })],
      }),
    );
    expect(dup.success).toBe(false);
    const cross = workloadsReportSchema.safeParse(
      report({
        runtimes: [
          runtime(),
          runtime({ runtime: 'podman' }),
        ],
      }),
    );
    expect(cross.success).toBe(true);
  });

  it('requires the workload kind to fit the runtime', () => {
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'hyperv', workloads: [workload({ kind: 'container' })] })] }),
      ).success,
    ).toBe(false);
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'proxmox', workloads: [workload({ kind: 'lxc' }), workload({ workloadId: '101', kind: 'vm' })], observedCount: 2 })] }),
      ).success,
    ).toBe(true);
  });

  it('allows containerd only as detection with no workloads', () => {
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'containerd', collection: 'unsupported', workloads: [], observedCount: 0 })] }),
      ).success,
    ).toBe(true);
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'containerd', workloads: [workload()] })] }),
      ).success,
    ).toBe(false);
  });

  it('rejects out-of-vocabulary values', () => {
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ detection: 'maybe' })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ collection: 'partial' })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ workloads: [workload({ state: 'exited' })] })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ runtime: 'lxd' })] })).success).toBe(false);
  });
});

describe('workloadInventoryInlineSettingsSchema', () => {
  it('defaults to disabled with every runtime allowed and a 60 minute interval', () => {
    expect(workloadInventoryInlineSettingsSchema.parse({})).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
    expect(WORKLOAD_INVENTORY_DEFAULTS).toEqual({
      enabled: false,
      dockerEnabled: true,
      podmanEnabled: true,
      hypervEnabled: true,
      proxmoxEnabled: true,
      intervalMinutes: 60,
    });
  });

  it.each([
    [14, false],
    [15, true],
    [1440, true],
    [1441, false],
    [60.5, false],
  ])('interval %s -> valid=%s', (intervalMinutes, valid) => {
    expect(workloadInventoryInlineSettingsSchema.safeParse({ intervalMinutes }).success).toBe(valid);
  });

  it('rejects unknown keys', () => {
    expect(workloadInventoryInlineSettingsSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
  });

  it('enables a runtime only when the feature and the runtime flag are both on; containerd is never enumerated', () => {
    const on = workloadInventoryInlineSettingsSchema.parse({ enabled: true, podmanEnabled: false });
    expect(isWorkloadRuntimeEnabled(on, 'docker')).toBe(true);
    expect(isWorkloadRuntimeEnabled(on, 'podman')).toBe(false);
    expect(isWorkloadRuntimeEnabled(on, 'hyperv')).toBe(true);
    expect(isWorkloadRuntimeEnabled(on, 'proxmox')).toBe(true);
    expect(isWorkloadRuntimeEnabled(on, 'containerd')).toBe(false);
    const off = workloadInventoryInlineSettingsSchema.parse({ enabled: false });
    expect(isWorkloadRuntimeEnabled(off, 'docker')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/shared && npx vitest run src/validators/workloads.test.ts
```

Expected FAIL: `Failed to resolve import "./workloads"` (module does not exist). Confirm exactly 1 file collected.

- [ ] **Step 3: Implement the constants** — create `packages/shared/src/constants/workloads.ts`:

```ts
/**
 * Workload host inventory (#3834) — shared vocabulary and limits. A pure leaf
 * module: no imports, so API, agent-facing validators and (later) web derive
 * from the same lists.
 */
export const WORKLOAD_RUNTIMES = ['docker', 'podman', 'hyperv', 'proxmox', 'containerd'] as const;
export type WorkloadRuntime = (typeof WORKLOAD_RUNTIMES)[number];

/** Runtimes whose workloads are enumerated in v1; `containerd` is detect-only. */
export const WORKLOAD_ENUMERATED_RUNTIMES = ['docker', 'podman', 'hyperv', 'proxmox'] as const;
export type WorkloadEnumeratedRuntime = (typeof WORKLOAD_ENUMERATED_RUNTIMES)[number];

export const WORKLOAD_KINDS = ['container', 'vm', 'lxc'] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

export const WORKLOAD_STATES = ['running', 'stopped', 'paused', 'restarting', 'other'] as const;
export type WorkloadState = (typeof WORKLOAD_STATES)[number];

export const WORKLOAD_DETECTIONS = ['present', 'absent', 'unknown'] as const;
export type WorkloadDetection = (typeof WORKLOAD_DETECTIONS)[number];

export const WORKLOAD_COLLECTIONS = [
  'ok',
  'disabled',
  'unavailable',
  'permission_denied',
  'error',
  'unsupported',
] as const;
export type WorkloadCollection = (typeof WORKLOAD_COLLECTIONS)[number];

/** Which workload kinds each runtime may report. containerd lists none in v1. */
export const WORKLOAD_RUNTIME_KINDS: Readonly<Record<WorkloadRuntime, readonly WorkloadKind[]>> = {
  docker: ['container'],
  podman: ['container'],
  hyperv: ['vm'],
  proxmox: ['vm', 'lxc'],
  containerd: [],
};

/** Per runtime per report (spec §5.4, §6.1). */
export const WORKLOADS_MAX_PER_RUNTIME = 1000;
/** Rows retained per runtime after a truncated snapshot (spec §6.2). */
export const WORKLOADS_RETAINED_MAX_PER_RUNTIME = 1500;
/** A truncated snapshot deletes rows not seen for longer than this (spec §6.2). */
export const WORKLOADS_AGE_OUT_HOURS = 24;
/** Body limit for PUT /agents/:id/workloads (spec §6.1). */
export const WORKLOADS_REPORT_MAX_BYTES = 2 * 1024 * 1024;

/** SecurityCapabilities.workloadInventoryProtocolVersion the API recognizes. */
export const WORKLOAD_INVENTORY_PROTOCOL_VERSION = 1;

export const WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES = 15;
export const WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES = 1440;
export const WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES = 60;
```

- [ ] **Step 4: Implement the validators** — create `packages/shared/src/validators/workloads.ts`:

```ts
import { z } from 'zod';
import {
  WORKLOAD_COLLECTIONS,
  WORKLOAD_DETECTIONS,
  WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES,
  WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES,
  WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES,
  WORKLOAD_KINDS,
  WORKLOAD_RUNTIME_KINDS,
  WORKLOAD_RUNTIMES,
  WORKLOAD_STATES,
  WORKLOADS_MAX_PER_RUNTIME,
  type WorkloadRuntime,
} from '../constants/workloads';

const nullableText = (max: number) =>
  z.string().max(max).nullish().transform((value) => value ?? null);
const nullableInt = (max: number) =>
  z.number().int().min(0).max(max).nullish().transform((value) => value ?? null);
const nullableTimestamp = z
  .string()
  .datetime({ offset: true })
  .nullish()
  .transform((value) => value ?? null);

/**
 * One workload as the agent reports it: the agent-supplied subset of the
 * device_workloads columns (spec §4.1). id / device / org / runtime /
 * first_seen / last_seen / updated_at are server-owned. Strict on purpose:
 * environment, command, mounts and labels are not representable (D8).
 */
export const workloadReportItemSchema = z
  .object({
    kind: z.enum(WORKLOAD_KINDS),
    workloadId: z.string().min(1).max(128),
    name: z.string().min(1).max(255),
    state: z.enum(WORKLOAD_STATES),
    rawState: nullableText(40),
    imageRef: nullableText(512),
    imageRepository: nullableText(400),
    imageTag: nullableText(128),
    imageDigest: nullableText(80),
    imageId: nullableText(80),
    guestOs: nullableText(128),
    composeProject: nullableText(128),
    composeService: nullableText(128),
    composeWorkingDir: nullableText(512),
    restartPolicy: nullableText(30),
    cpuCount: nullableInt(4096),
    memoryMb: nullableInt(100_000_000),
    startedAt: nullableTimestamp,
    runtimeCreatedAt: nullableTimestamp,
  })
  .strict();
export type WorkloadReportItem = z.infer<typeof workloadReportItemSchema>;

export const workloadRuntimeReportSchema = z
  .object({
    runtime: z.enum(WORKLOAD_RUNTIMES),
    detection: z.enum(WORKLOAD_DETECTIONS),
    collection: z.enum(WORKLOAD_COLLECTIONS),
    complete: z.boolean(),
    runtimeVersion: z.string().max(64).nullable(),
    observedCount: z.number().int().min(0).max(1_000_000),
    error: z.string().max(500).nullable(),
    workloads: z.array(workloadReportItemSchema).max(WORKLOADS_MAX_PER_RUNTIME),
  })
  .strict()
  .superRefine((report, ctx) => {
    const allowedKinds: readonly string[] = WORKLOAD_RUNTIME_KINDS[report.runtime];
    const seen = new Set<string>();
    report.workloads.forEach((workload, index) => {
      if (!allowedKinds.includes(workload.kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['workloads', index, 'kind'],
          message: `kind ${workload.kind} is not valid for runtime ${report.runtime}`,
        });
      }
      if (seen.has(workload.workloadId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['workloads', index, 'workloadId'],
          message: 'duplicate workloadId within the runtime',
        });
      }
      seen.add(workload.workloadId);
    });
  });
export type WorkloadRuntimeReport = z.infer<typeof workloadRuntimeReportSchema>;

/** Body of PUT /api/v1/agents/:id/workloads (spec §6.1). */
export const workloadsReportSchema = z
  .object({
    protocolVersion: z.literal(1),
    collectedAt: z.string().datetime({ offset: true }),
    runtimes: z.array(workloadRuntimeReportSchema).max(5),
  })
  .strict()
  .superRefine((report, ctx) => {
    const seen = new Set<string>();
    report.runtimes.forEach((entry, index) => {
      if (seen.has(entry.runtime)) {
        ctx.addIssue({
          code: 'custom',
          path: ['runtimes', index, 'runtime'],
          message: 'duplicate runtime entry',
        });
      }
      seen.add(entry.runtime);
    });
  });
export type WorkloadsReport = z.infer<typeof workloadsReportSchema>;

/**
 * Inline settings of the `workload_inventory` configuration feature (spec
 * §7.1). Detection always runs; these gate enumeration only (D4).
 */
export const workloadInventoryInlineSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    dockerEnabled: z.boolean().default(true),
    podmanEnabled: z.boolean().default(true),
    hypervEnabled: z.boolean().default(true),
    proxmoxEnabled: z.boolean().default(true),
    intervalMinutes: z
      .number()
      .int()
      .min(WORKLOAD_INVENTORY_MIN_INTERVAL_MINUTES)
      .max(WORKLOAD_INVENTORY_MAX_INTERVAL_MINUTES)
      .default(WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES),
  })
  .strict();
export type WorkloadInventoryInlineSettings = z.infer<typeof workloadInventoryInlineSettingsSchema>;

export const WORKLOAD_INVENTORY_DEFAULTS: WorkloadInventoryInlineSettings = {
  enabled: false,
  dockerEnabled: true,
  podmanEnabled: true,
  hypervEnabled: true,
  proxmoxEnabled: true,
  intervalMinutes: WORKLOAD_INVENTORY_DEFAULT_INTERVAL_MINUTES,
};

/**
 * Is enumeration enabled for this runtime under these settings? The feature
 * switch must be on AND the runtime's own flag. containerd has no flag and is
 * never enumerated in v1.
 */
export function isWorkloadRuntimeEnabled(
  settings: WorkloadInventoryInlineSettings,
  runtime: WorkloadRuntime,
): boolean {
  if (!settings.enabled) return false;
  switch (runtime) {
    case 'docker':
      return settings.dockerEnabled;
    case 'podman':
      return settings.podmanEnabled;
    case 'hyperv':
      return settings.hypervEnabled;
    case 'proxmox':
      return settings.proxmoxEnabled;
    default:
      return false;
  }
}
```

- [ ] **Step 5: Export from both barrels.**

In `packages/shared/src/constants/index.ts`, change

```ts
export * from './hardwareHealth';
export * from './timeSync';
```

to

```ts
export * from './hardwareHealth';
export * from './timeSync';
export * from './workloads';
```

In `packages/shared/src/validators/index.ts`, change

```ts
export * from './hardwareHealth';
export * from './timeSync';
```

to

```ts
export * from './hardwareHealth';
export * from './timeSync';
export * from './workloads';
```

- [ ] **Step 6: Run the test, then the shared typecheck**

```bash
cd packages/shared && npx vitest run src/validators/workloads.test.ts
cd /Users/toddhebebrand/breeze/.claude/worktrees/plan-3834 && pnpm --filter @breeze/shared typecheck
```

Expected PASS: all `workloads.test.ts` cases; `tsc --noEmit` exit code 0 (a duplicate-export collision from `export *` would show here).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/constants/workloads.ts packages/shared/src/constants/index.ts packages/shared/src/validators/workloads.ts packages/shared/src/validators/workloads.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(workloads): add shared workload report and settings contracts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Device workload tables, host axis, capability column and every lifecycle registration

**Files:**
- Create: `apps/api/migrations/2026-12-15-100000-device-workloads.sql`, `apps/api/src/db/schema/deviceWorkloads.ts`, `apps/api/src/services/workloads/migrations.integration.test.ts`
- Modify: `apps/api/src/db/schema/index.ts:17` (after `export * from './timeSync';`), `apps/api/src/db/schema/devices.ts:80,266`, `apps/api/src/services/tenantCascade.ts:565`, `apps/api/src/routes/devices/core.ts:325,581`, `apps/api/src/services/orgMergeRegistry.ts:903`, `apps/api/src/services/tenantExportPolicyRegistry.ts:384,394`, `apps/api/src/routes/devices/helpers.ts:27`, `apps/api/src/routes/devices/helpers.test.ts`, `apps/api/vitest.config.ts` (next to `'src/services/timeSync/**/*.integration.test.ts'`), `apps/api/vitest.integration.config.ts` (same neighbour)

**Interfaces:**
- Produces: `deviceWorkloads`, `deviceWorkloadRuntimes` Drizzle tables (+ `$inferSelect`/`$inferInsert`); `devices.hostsWorkloads: boolean`, `devices.workloadRuntimes: string[]`, `devices.workloadInventoryProtocolVersion: number`; the SQL tables of Global Constraints.
- Consumes: `devices(id, org_id)` unique index `devices_id_org_id_uniq` (`db/schema/devices.ts:343`), `organizations.id`, `breeze_has_org_access(uuid)`, `tablePolicy` (`tenantExportPolicyRegistry.ts:17`). Real-DB helpers verified at `apps/api/src/__tests__/integration/db-utils.ts` (`createPartner`, `createOrganization`, `createSite`), `setup.ts` (`getTestDb`), `replayMigration.ts` (`replayMigration`), `utils/pgErrors.ts` (`pgErrorCode`).
- The planning checkout's template is `2026-11-01-110000-device-memory-modules.sql:29-103` (columns, composite FK, RLS, grants). **Do not copy its lines 105-end** (partner-export function replay + triggers): D12.

- [ ] **Step 1: Write the failing integration test** — create `apps/api/src/services/workloads/migrations.integration.test.ts`:

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';

const MIGRATION = '2026-12-15-100000-device-workloads.sql';
const system: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};

async function fixture() {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const other = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const otherSite = (await createSite({ orgId: other.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'workload-fixture',
      osType: 'linux',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  // An org-scoped session of the SIBLING org: it must see and forge nothing here.
  const foreign: DbAccessContext = {
    scope: 'organization',
    orgId: other.id,
    accessibleOrgIds: [other.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const own: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  return { partner, org, other, site, otherSite, device: device!, foreign, own };
}

const insertWorkload = (deviceId: string, orgId: string, over: { runtime?: string; kind?: string; workloadId?: string } = {}) =>
  db.execute(sql`
    INSERT INTO device_workloads(device_id, org_id, runtime, kind, workload_id, name, state)
    VALUES (${deviceId}, ${orgId}, ${over.runtime ?? 'docker'}, ${over.kind ?? 'container'},
            ${over.workloadId ?? randomUUID()}, 'web', 'running')`);
const insertRuntime = (deviceId: string, orgId: string, runtime = 'docker', detection = 'present') =>
  db.execute(sql`
    INSERT INTO device_workload_runtimes(device_id, org_id, runtime, detection, collection, complete, collected_at, last_attempt_at)
    VALUES (${deviceId}, ${orgId}, ${runtime}, ${detection}, 'ok', true, now(), now())`);

it('adds the host-axis and capability columns with safe defaults', async () => {
  const f = await fixture();
  const [row] = await getTestDb().execute(sql`
    SELECT hosts_workloads, workload_runtimes, workload_inventory_protocol_version
      FROM devices WHERE id = ${f.device.id}`);
  expect(row).toMatchObject({
    hosts_workloads: false,
    workload_runtimes: [],
    workload_inventory_protocol_version: 0,
  });
});

it('forces RLS with four org policies, deferrable-immediate owner FKs and the indexes on both tables', async () => {
  for (const table of ['device_workloads', 'device_workload_runtimes']) {
    const [flags] = await getTestDb().execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = ${`public.${table}`}::regclass`);
    expect(flags).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await getTestDb().execute(sql`
      SELECT cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table} ORDER BY cmd`);
    expect(policies.map((p) => p.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    const [fk] = await getTestDb().execute(sql`
      SELECT condeferrable, condeferred, confupdtype, confdeltype FROM pg_constraint
       WHERE conname = ${`${table}_device_org_fk`}`);
    expect(fk).toMatchObject({ condeferrable: true, condeferred: false, confupdtype: 'c', confdeltype: 'c' });
  }
  const indexes = await getTestDb().execute(sql`
    SELECT indexname FROM pg_indexes
     WHERE tablename IN ('device_workloads', 'device_workload_runtimes')`);
  expect(indexes.map((i) => i.indexname)).toEqual(
    expect.arrayContaining([
      'device_workloads_device_runtime_workload_uniq',
      'device_workloads_org_id_idx',
      'device_workloads_org_image_idx',
      'device_workload_runtimes_device_runtime_uniq',
      'device_workload_runtimes_org_id_idx',
    ]),
  );
});

it('has no partner-export material triggers on either table (D12)', async () => {
  const triggers = await getTestDb().execute(sql`
    SELECT tgname FROM pg_trigger
     WHERE tgrelid IN ('public.device_workloads'::regclass, 'public.device_workload_runtimes'::regclass)
       AND NOT tgisinternal`);
  expect(triggers).toHaveLength(0);
});

it('denies a forged cross-tenant insert as breeze_app (42501) and a wrong composite owner (23503)', async () => {
  const f = await fixture();
  const [role] = await withDbAccessContext(f.foreign, () => db.execute(sql`SELECT current_user AS name`));
  expect(role!.name).toBe('breeze_app');
  for (const insert of [
    () => insertWorkload(f.device.id, f.org.id),
    () => insertRuntime(f.device.id, f.org.id),
  ]) {
    await expect(withDbAccessContext(f.foreign, insert)).rejects.toSatisfy(
      (e: unknown) => pgErrorCode(e) === '42501',
    );
  }
  // system scope passes RLS, so only the composite (device_id, org_id) FK can refuse a wrong owner.
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.other.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.other.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
});

it('isolates reads, updates and deletes by org', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id));
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id));
  for (const query of [
    sql`SELECT * FROM device_workloads WHERE device_id = ${f.device.id}`,
    sql`UPDATE device_workloads SET name = 'x' WHERE device_id = ${f.device.id} RETURNING *`,
    sql`DELETE FROM device_workloads WHERE device_id = ${f.device.id} RETURNING *`,
    sql`SELECT * FROM device_workload_runtimes WHERE device_id = ${f.device.id}`,
    sql`DELETE FROM device_workload_runtimes WHERE device_id = ${f.device.id} RETURNING *`,
  ]) {
    expect(await withDbAccessContext(f.foreign, () => db.execute(query))).toHaveLength(0);
  }
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`SELECT * FROM device_workloads WHERE device_id = ${f.device.id}`),
    ),
  ).toHaveLength(1);
});

it('enforces the runtime, kind, detection and collection vocabularies and the unique keys', async () => {
  const f = await fixture();
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { runtime: 'containerd' })),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { kind: 'pod' })),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'lxd')),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'docker', 'maybe')),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  // containerd IS allowed on the runtime table (detect-only).
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'containerd'));
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { workloadId: 'dup' }));
  await expect(
    withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id, { workloadId: 'dup' })),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
  await expect(
    withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id, 'containerd')),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
});

it('carries org_id onto both tables when the device moves org', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id));
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id));
  await withDbAccessContext(system, () =>
    db.execute(sql`
      UPDATE devices SET org_id = ${f.other.id}::uuid, site_id = ${f.otherSite.id}::uuid
       WHERE id = ${f.device.id}`),
  );
  for (const table of ['device_workloads', 'device_workload_runtimes']) {
    const rows = await getTestDb().execute(
      sql`SELECT org_id FROM ${sql.raw(table)} WHERE device_id = ${f.device.id}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe(f.other.id);
  }
});

it('replaying the migration is a no-op that preserves rows', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insertWorkload(f.device.id, f.org.id));
  await withDbAccessContext(system, () => insertRuntime(f.device.id, f.org.id));
  await replayMigration(MIGRATION);
  await replayMigration(MIGRATION);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM device_workloads WHERE device_id = ${f.device.id}`),
  ).toHaveLength(1);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM device_workload_runtimes WHERE device_id = ${f.device.id}`),
  ).toHaveLength(1);
});
```

- [ ] **Step 2: Add the real-DB runner routing.** In `apps/api/vitest.config.ts`, directly after the line `'src/services/timeSync/**/*.integration.test.ts',` (exclude list) add:

```ts
      'src/services/workloads/**/*.integration.test.ts',
```

In `apps/api/vitest.integration.config.ts`, directly after its `'src/services/timeSync/**/*.integration.test.ts',` add the same line.

- [ ] **Step 3: Run it and watch it fail (real database required)**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/migrations.integration.test.ts
```

Expected FAIL: `column "hosts_workloads" does not exist` and `relation "device_workloads" does not exist` (the migration is not written yet). Confirm exactly 1 file ran.

- [ ] **Step 4: Write the migration** — create `apps/api/migrations/2026-12-15-100000-device-workloads.sql`:

```sql
-- #3834 W01 — workload host inventory: per-device workload rows, per-runtime
-- detection/collection state, and the HOST axis on devices.
--
-- Spec: docs/superpowers/specs/devices/2026-10-06-workload-host-inventory-design.md §4.
--
-- 1. devices: hosts_workloads / workload_runtimes (the host axis, written by
--    ingest from DETECTION, never derived from workload rows) and
--    workload_inventory_protocol_version (agent capability handshake, written
--    non-sticky every heartbeat — same shape as consent_prompt_protocol_version).
-- 2. device_workloads — tenancy shape 5 (denormalized org_id), one row per
--    workload, typed columns only (no jsonb/bytea: D1).
-- 3. device_workload_runtimes — shape 5, one row per (device, runtime).
--
-- NOT a partner-export material table (spec D12): unlike
-- 2026-11-01-110000-device-memory-modules.sql this file creates no
-- breeze_partner_export_material_* triggers and redefines no partner-export
-- function. The devices update trigger compares an explicit column list
-- (2026-07-18-partner-export-org-locks.sql), so the three new devices columns
-- are non-material.
--
-- Writes no rows, so no `set_config('breeze.scope', 'system', true)` is needed.
-- Fully idempotent: integration suites replay it.

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS hosts_workloads boolean NOT NULL DEFAULT false;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS workload_runtimes varchar(30)[] NOT NULL DEFAULT '{}';
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS workload_inventory_protocol_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.device_workloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL
    CONSTRAINT device_workloads_device_id_devices_id_fk REFERENCES public.devices(id),
  org_id uuid NOT NULL
    CONSTRAINT device_workloads_org_id_organizations_id_fk REFERENCES public.organizations(id),
  runtime varchar(20) NOT NULL,
  kind varchar(20) NOT NULL,
  workload_id varchar(128) NOT NULL,
  name varchar(255) NOT NULL,
  state varchar(20) NOT NULL,
  raw_state varchar(40),
  image_ref varchar(512),
  image_repository varchar(400),
  image_tag varchar(128),
  image_digest varchar(80),
  image_id varchar(80),
  guest_os varchar(128),
  compose_project varchar(128),
  compose_service varchar(128),
  compose_working_dir varchar(512),
  restart_policy varchar(30),
  cpu_count integer,
  memory_mb integer,
  started_at timestamp,
  runtime_created_at timestamp,
  first_seen_at timestamp NOT NULL DEFAULT now(),
  last_seen_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT device_workloads_runtime_chk CHECK (runtime IN ('docker', 'podman', 'hyperv', 'proxmox')),
  CONSTRAINT device_workloads_kind_chk CHECK (kind IN ('container', 'vm', 'lxc')),
  CONSTRAINT device_workloads_state_chk CHECK (state IN ('running', 'stopped', 'paused', 'restarting', 'other'))
);

CREATE TABLE IF NOT EXISTS public.device_workload_runtimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL
    CONSTRAINT device_workload_runtimes_device_id_devices_id_fk REFERENCES public.devices(id),
  org_id uuid NOT NULL
    CONSTRAINT device_workload_runtimes_org_id_organizations_id_fk REFERENCES public.organizations(id),
  runtime varchar(20) NOT NULL,
  detection varchar(20) NOT NULL,
  collection varchar(24) NOT NULL,
  complete boolean NOT NULL,
  runtime_version varchar(64),
  observed_count integer,
  reported_count integer,
  last_error varchar(500),
  collected_at timestamp NOT NULL,
  last_attempt_at timestamp NOT NULL,
  last_success_at timestamp,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT device_workload_runtimes_runtime_chk
    CHECK (runtime IN ('docker', 'podman', 'hyperv', 'proxmox', 'containerd')),
  CONSTRAINT device_workload_runtimes_detection_chk
    CHECK (detection IN ('present', 'absent', 'unknown')),
  CONSTRAINT device_workload_runtimes_collection_chk
    CHECK (collection IN ('ok', 'disabled', 'unavailable', 'permission_denied', 'error', 'unsupported'))
);

-- Composite same-org FKs. DEFERRABLE INITIALLY IMMEDIATE is mandatory for every
-- composite FK referencing an org_id column: org merge runs
-- SET CONSTRAINTS ALL DEFERRED and re-points parent and child org_id in
-- separate statements. ON UPDATE CASCADE carries a device move's org_id onto
-- the rows; ON DELETE CASCADE because these rows are meaningless without their
-- device (the explicit device cascade list deletes them first anyway).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'device_workloads_device_org_fk'
       AND conrelid = 'public.device_workloads'::regclass
  ) THEN
    ALTER TABLE public.device_workloads
      ADD CONSTRAINT device_workloads_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES public.devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'device_workload_runtimes_device_org_fk'
       AND conrelid = 'public.device_workload_runtimes'::regclass
  ) THEN
    ALTER TABLE public.device_workload_runtimes
      ADD CONSTRAINT device_workload_runtimes_device_org_fk
      FOREIGN KEY (device_id, org_id) REFERENCES public.devices(id, org_id)
      ON UPDATE CASCADE ON DELETE CASCADE
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- The unique key leads with device_id, so it also serves every per-device
-- lookup (read route, ingest, cascade). The partial index is for the W05
-- image-currency worker's per-org distinct (repository, tag) scan.
CREATE UNIQUE INDEX IF NOT EXISTS device_workloads_device_runtime_workload_uniq
  ON public.device_workloads(device_id, runtime, workload_id);
CREATE INDEX IF NOT EXISTS device_workloads_org_id_idx
  ON public.device_workloads(org_id);
CREATE INDEX IF NOT EXISTS device_workloads_org_image_idx
  ON public.device_workloads(org_id, image_repository, image_tag)
  WHERE kind = 'container';

CREATE UNIQUE INDEX IF NOT EXISTS device_workload_runtimes_device_runtime_uniq
  ON public.device_workload_runtimes(device_id, runtime);
CREATE INDEX IF NOT EXISTS device_workload_runtimes_org_id_idx
  ON public.device_workload_runtimes(org_id);

ALTER TABLE public.device_workloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_workloads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_workloads;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_workloads;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_workloads;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_workloads;
CREATE POLICY breeze_org_isolation_select ON public.device_workloads
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_workloads
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_workloads
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_workloads
  FOR DELETE USING (public.breeze_has_org_access(org_id));

ALTER TABLE public.device_workload_runtimes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_workload_runtimes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON public.device_workload_runtimes;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.device_workload_runtimes;
DROP POLICY IF EXISTS breeze_org_isolation_update ON public.device_workload_runtimes;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.device_workload_runtimes;
CREATE POLICY breeze_org_isolation_select ON public.device_workload_runtimes
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON public.device_workload_runtimes
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON public.device_workload_runtimes
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON public.device_workload_runtimes
  FOR DELETE USING (public.breeze_has_org_access(org_id));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.device_workloads TO breeze_app;
    GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.device_workload_runtimes TO breeze_app;
  END IF;
END $$;
```

- [ ] **Step 5: Write the Drizzle schema** — create `apps/api/src/db/schema/deviceWorkloads.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type {
  WorkloadCollection,
  WorkloadDetection,
  WorkloadEnumeratedRuntime,
  WorkloadKind,
  WorkloadRuntime,
  WorkloadState,
} from '@breeze/shared';
import { devices } from './devices';
import { organizations } from './orgs';

// One row per workload (container / VM / LXC) on a workload host (#3834).
// Typed columns only — no jsonb/bytea (D1). Reconciled per runtime by
// services/workloads/ingest.ts. Migration 2026-12-15-100000-device-workloads.sql
// declares the composite FK DEFERRABLE INITIALLY IMMEDIATE (drizzle's
// foreignKey() builder has no deferrable option) and has NO partner-export
// triggers (D12).
export const deviceWorkloads = pgTable(
  'device_workloads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    runtime: varchar('runtime', { length: 20 }).$type<WorkloadEnumeratedRuntime>().notNull(),
    kind: varchar('kind', { length: 20 }).$type<WorkloadKind>().notNull(),
    workloadId: varchar('workload_id', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    state: varchar('state', { length: 20 }).$type<WorkloadState>().notNull(),
    rawState: varchar('raw_state', { length: 40 }),
    imageRef: varchar('image_ref', { length: 512 }),
    imageRepository: varchar('image_repository', { length: 400 }),
    imageTag: varchar('image_tag', { length: 128 }),
    imageDigest: varchar('image_digest', { length: 80 }),
    imageId: varchar('image_id', { length: 80 }),
    guestOs: varchar('guest_os', { length: 128 }),
    composeProject: varchar('compose_project', { length: 128 }),
    composeService: varchar('compose_service', { length: 128 }),
    composeWorkingDir: varchar('compose_working_dir', { length: 512 }),
    restartPolicy: varchar('restart_policy', { length: 30 }),
    cpuCount: integer('cpu_count'),
    memoryMb: integer('memory_mb'),
    startedAt: timestamp('started_at'),
    runtimeCreatedAt: timestamp('runtime_created_at'),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_workloads_device_runtime_workload_uniq').on(t.deviceId, t.runtime, t.workloadId),
    index('device_workloads_org_id_idx').on(t.orgId),
    index('device_workloads_org_image_idx')
      .on(t.orgId, t.imageRepository, t.imageTag)
      .where(sql`${t.kind} = 'container'`),
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_workloads_device_org_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check('device_workloads_runtime_chk', sql`${t.runtime} IN ('docker', 'podman', 'hyperv', 'proxmox')`),
    check('device_workloads_kind_chk', sql`${t.kind} IN ('container', 'vm', 'lxc')`),
    check(
      'device_workloads_state_chk',
      sql`${t.state} IN ('running', 'stopped', 'paused', 'restarting', 'other')`,
    ),
  ],
);

// One row per (device, runtime): detection (is it installed) kept apart from
// collection (did we enumerate it). An `absent` runtime keeps its row (detection
// = 'absent', workloads deleted) so the ordering guard still holds (§4.2).
export const deviceWorkloadRuntimes = pgTable(
  'device_workload_runtimes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    runtime: varchar('runtime', { length: 20 }).$type<WorkloadRuntime>().notNull(),
    detection: varchar('detection', { length: 20 }).$type<WorkloadDetection>().notNull(),
    collection: varchar('collection', { length: 24 }).$type<WorkloadCollection>().notNull(),
    complete: boolean('complete').notNull(),
    runtimeVersion: varchar('runtime_version', { length: 64 }),
    observedCount: integer('observed_count'),
    reportedCount: integer('reported_count'),
    lastError: varchar('last_error', { length: 500 }),
    // The agent's snapshot time: the ordering guard compares against this.
    collectedAt: timestamp('collected_at').notNull(),
    // Server receive time of the latest accepted report.
    lastAttemptAt: timestamp('last_attempt_at').notNull(),
    lastSuccessAt: timestamp('last_success_at'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('device_workload_runtimes_device_runtime_uniq').on(t.deviceId, t.runtime),
    index('device_workload_runtimes_org_id_idx').on(t.orgId),
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_workload_runtimes_device_org_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'device_workload_runtimes_runtime_chk',
      sql`${t.runtime} IN ('docker', 'podman', 'hyperv', 'proxmox', 'containerd')`,
    ),
    check('device_workload_runtimes_detection_chk', sql`${t.detection} IN ('present', 'absent', 'unknown')`),
    check(
      'device_workload_runtimes_collection_chk',
      sql`${t.collection} IN ('ok', 'disabled', 'unavailable', 'permission_denied', 'error', 'unsupported')`,
    ),
  ],
);
```

In `apps/api/src/db/schema/index.ts` add after `export * from './timeSync';`:

```ts
export * from './deviceWorkloads';
```

In `apps/api/src/db/schema/devices.ts`, directly after the line `virtualizationPlatform: varchar('virtualization_platform', { length: 30 }),` (line 80) insert:

```ts
  // Workload HOST axis (#3834): does this device host workloads (containers /
  // VMs), of which runtime. Distinct from isVirtual above (the GUEST axis).
  // Written by services/workloads/ingest.ts from runtime DETECTION, never
  // derived from device_workloads rows — an empty Docker host is still a
  // container host. workloadRuntimes is the sorted runtimes whose detection is
  // 'present'; a runtime reported 'unknown' keeps its previous membership.
  hostsWorkloads: boolean('hosts_workloads').notNull().default(false),
  workloadRuntimes: varchar('workload_runtimes', { length: 30 }).array().notNull().default([]),
```

and directly after `consentPromptProtocolVersion: integer('consent_prompt_protocol_version').notNull().default(0),` (line 266) insert:

```ts
  // #3834 — agent capability for workload inventory. 0 for every build
  // predating the collector and for any heartbeat omitting the field; only the
  // recognized integer version 1 is written as anything else. Non-sticky
  // (written every beat), so a downgrade reports back down. The device
  // Workloads view uses it to say "agent too old" instead of "no data".
  workloadInventoryProtocolVersion: integer('workload_inventory_protocol_version').notNull().default(0),
```

- [ ] **Step 6: Apply the migration to the stack and run the integration test**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/migrations.integration.test.ts
```

Expected PASS (setup auto-applies pending migrations): all 8 cases. If a case fails with `permission denied` on `current_user`, re-run `pnpm test-stack up` to confirm the stack's app role is `breeze_app`.

- [ ] **Step 7: Prove the existing contract tests are red for the missing registrations (unit job).**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
```

Expected FAIL: both name `device_workloads` and `device_workload_runtimes` as missing from `CORE_DEVICE_CASCADE_DELETE_TABLES` / `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (they read the Drizzle schema statically — this is the only registration contract that fails in the unit job).

- [ ] **Step 8: Register in every list.** Re-grep each anchor first (`grep -n "'device_warranty'" apps/api/src/...`) in case a line moved.

`apps/api/src/services/tenantCascade.ts` — in `CORE_ORG_CASCADE_DELETE_ORDER`, between `'device_warranty',` (line 565) and `'devices',` insert (alphabetical by `localeCompare`; `_runtimes` sorts before the plural `s`):

```ts
  // #3834 — workload host inventory. Composite FK (device_id, org_id) ->
  // devices(id, org_id) ON DELETE CASCADE; leaf tables, no children.
  'device_workload_runtimes',
  'device_workloads',
```

`apps/api/src/routes/devices/core.ts` — in `CORE_DEVICE_ORG_DENORMALIZED_TABLES` change line 325 `'device_vulnerabilities', 'device_warranty',` to

```ts
  'device_vulnerabilities', 'device_warranty',
  'device_workload_runtimes', 'device_workloads',
```

and in `CORE_DEVICE_CASCADE_DELETE_TABLES` change line 581 `'device_sessions', 'device_change_log', 'device_warranty', 'device_vulnerabilities',` to

```ts
  'device_sessions', 'device_change_log', 'device_warranty', 'device_vulnerabilities',
  // #3834 — workload inventory: leaf tables, FK (device_id, org_id) ->
  // devices(id, org_id) ON DELETE CASCADE.
  'device_workload_runtimes', 'device_workloads',
```

`apps/api/src/services/orgMergeRegistry.ts` — in the `repoint` list, after `"device_warranty",` (line 903) insert:

```ts
  // device_workloads / device_workload_runtimes (#3834): plain repoint — the
  // only unique keys are (device_id, runtime, workload_id) and (device_id,
  // runtime), which cannot collide across orgs because a device belongs to one org.
  "device_workload_runtimes",
  "device_workloads",
```

`apps/api/src/services/tenantExportPolicyRegistry.ts` — after the `"device_warranty": tablePolicy(...)` entry (line 384, before the comment block that precedes `"devices"`) insert:

```ts
  "device_workload_runtimes": tablePolicy("org_id", {"included":["id","device_id","org_id","runtime","detection","collection","complete","runtime_version","observed_count","reported_count","last_error","collected_at","last_attempt_at","last_success_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
  "device_workloads": tablePolicy("org_id", {"included":["id","device_id","org_id","runtime","kind","workload_id","name","state","raw_state","image_ref","image_repository","image_tag","image_digest","image_id","guest_os","compose_project","compose_service","compose_working_dir","restart_policy","cpu_count","memory_mb","started_at","runtime_created_at","first_seen_at","last_seen_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

and in the `"devices"` entry (line 394) replace the fragment `"backup_write_protocol_version","uninstall_intent_at"` with

```
"backup_write_protocol_version","workload_inventory_protocol_version","hosts_workloads","workload_runtimes","uninstall_intent_at"
```

(all three go in `included`: the capability version is a monotonic counter and the host-axis columns are customer data; none matches `SUSPICIOUS_NAME_PARTS`, none is json/bytea).

`apps/api/src/routes/devices/helpers.ts` — in `PUBLIC_DEVICE_FIELDS`, after the line `'isVirtual', 'virtualizationPlatform', 'osVersion', 'osBuild', 'architecture',` (line 27) insert a new line:

```ts
  'hostsWorkloads', 'workloadRuntimes',
```

(The capability column is deliberately not exposed on the device object: the read route in Task 7 reports it as `capability`.)

Add one assertion to `apps/api/src/routes/devices/helpers.test.ts`, inside the `describe` that contains `'is an allowlist of real schema columns…'`:

```ts
  it('exposes the workload host axis but not the capability counter', () => {
    expect(PUBLIC_DEVICE_FIELDS).toContain('hostsWorkloads');
    expect(PUBLIC_DEVICE_FIELDS).toContain('workloadRuntimes');
    expect(PUBLIC_DEVICE_FIELDS as readonly string[]).not.toContain('workloadInventoryProtocolVersion');
  });
```

- [ ] **Step 9: Run the unit contract tests, the drift check and the real-DB test**

```bash
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/helpers.test.ts src/services/deviceDeletion.test.ts src/services/orgMerge.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/migrations.integration.test.ts
cd /Users/toddhebebrand/breeze/.claude/worktrees/plan-3834 && DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.test | cut -d= -f2-)" pnpm db:check-drift
```

Expected PASS: both contract tests, `orgMerge.test.ts` (its merge engine walks the cascade order and throws `no merge policy registered for '<table>'` if the `orgMergeRegistry` entry is missing — that suite only reds in the full unit run, so run it by name here), `autoMigrate.test.ts`, `migrationRlsScope.test.ts` (no new baseline entry), drift check "no drift". If drift reports a CHECK or partial-index difference, align the Drizzle schema to the migration text — never edit the shipped migration.

- [ ] **Step 10: Commit**

```bash
git add apps/api/migrations/2026-12-15-100000-device-workloads.sql apps/api/src/db/schema/deviceWorkloads.ts apps/api/src/db/schema/index.ts apps/api/src/db/schema/devices.ts apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/devices/helpers.ts apps/api/src/routes/devices/helpers.test.ts apps/api/src/services/workloads/migrations.integration.test.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts
git commit -m "feat(workloads): persist per-device workload inventory and the host axis" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 3: Pure sync planner `planWorkloadSync`

**Files:**
- Create: `apps/api/src/services/workloads/plan.ts`, `apps/api/src/services/workloads/plan.test.ts`

**Interfaces:**
- Consumes: `planChildRowSync<S extends { id: string }, R>(stored, reported, identity): ChildRowPlan<R>` and `ChildRowPlan<R>` (`{ updates: Array<{ id: string; row: R }>; inserts: R[]; deleteIds: string[] }`), both exported from `apps/api/src/services/inventoryChildSync.ts:44`; shared types from Task 1.
- Produces (no DB, no clock — `now` is an input):

```ts
export interface StoredWorkloadRuntime { runtime: WorkloadRuntime; collectedAt: Date }
export interface StoredWorkload { id: string; runtime: WorkloadRuntime; workloadId: string; lastSeenAt: Date }
export interface WorkloadSyncInput {
  now: Date;                              // server receive time (the spec's receivedAt)
  collectedAt: Date;                      // report.collectedAt (guard uses min(collectedAt, now))
  runtimes: readonly WorkloadRuntimeReport[];
  storedRuntimes: readonly StoredWorkloadRuntime[];
  storedWorkloads: readonly StoredWorkload[];   // only rows of the reported runtimes are needed
  isEnabled: (runtime: WorkloadRuntime) => boolean;   // effective policy, per runtime
  previousHostRuntimes: readonly string[];        // devices.workload_runtimes before this report
  previousHostsWorkloads: boolean;                // devices.hosts_workloads before this report
}
export interface WorkloadRuntimeWrite { /* runtime-row upsert payload, see plan.ts */ }
export interface WorkloadRuntimePlan {
  runtime: WorkloadRuntime;
  applied: boolean;                       // false when the ordering guard skipped it
  collection: WorkloadCollection | null;  // after the policy override; null = skipped (no runtime row written)
  runtimeRow: WorkloadRuntimeWrite | null;
  workloads: ChildRowPlan<WorkloadReportItem>;  // deleteIds is FINAL (age-out / cap already applied)
}
export interface WorkloadHostAxis { workloadRuntimes: string[]; hostsWorkloads: boolean; changed: boolean }
export interface WorkloadSyncPlan { runtimes: WorkloadRuntimePlan[]; host: WorkloadHostAxis }
export function planWorkloadSync(input: WorkloadSyncInput): WorkloadSyncPlan;
```

Behavior (spec §6.2, one branch per bullet):
1. **Ordering guard:** effective time = `min(report.collectedAt, now)`; a runtime whose stored `collectedAt >= effective time` is skipped entirely (`applied: false`, nothing written, host axis unaffected by it). A runtime with no stored row is always applied. The effective time (not the raw `collectedAt`) is what is stored in `collected_at`.
2. **Policy override:** for an enumerated runtime (`docker|podman|hyperv|proxmox`) with `isEnabled(runtime) === false`, the effective collection is `disabled` whatever the agent sent and its workloads are ignored. `containerd` has no policy flag and passes through.
3. `detection = absent` → **upsert the runtime row** with `detection = absent` (collection as reported, `complete: true`, counts 0) and delete **all** its workload rows (this wins over the policy override); membership drops it. The row is kept so a replayed older `present` report is still skipped by rule 1.
4. `collection = disabled` (reported or overridden) → write the runtime row (`complete: true`, counts 0), delete all that runtime's workload rows; membership follows detection, not policy.
5. `collection = ok` and the snapshot is complete → replace-set (upsert reported, delete the rest; ids stable via `planChildRowSync`).
6. `collection = ok` and truncated (`complete = false` **or** `observedCount > workloads.length` — an agent claiming completeness while sending fewer rows than it saw is treated as truncated) → upsert reported only; delete rows of that runtime **not in the report** whose `lastSeenAt` is older than 24 h; then if more than 1500 rows remain, delete the oldest `lastSeenAt` (ties by id).
7. Any other collection (`unavailable|permission_denied|error|unsupported`) → write the runtime row only; **workload rows untouched**; `lastSuccessAt` stays unset.
8. **Host axis:** membership starts from `previousHostRuntimes`; a *newly applied* report entry with `detection = present` adds the runtime, `absent` removes it (the absent row is kept, but absent rows are never members), `unknown` leaves it; runtimes absent from the report and skipped runtimes are untouched. Result is sorted; `hostsWorkloads = length > 0`; `changed` compares both fields to the previous values.

- [ ] **Step 1: Write the failing table-driven test** — create `apps/api/src/services/workloads/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  workloadReportItemSchema,
  workloadRuntimeReportSchema,
  type WorkloadRuntime,
} from '@breeze/shared';
import {
  planWorkloadSync,
  type StoredWorkload,
  type StoredWorkloadRuntime,
  type WorkloadSyncInput,
} from './plan';

const NOW = new Date('2026-10-06T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const item = (workloadId: string, over: Record<string, unknown> = {}) =>
  workloadReportItemSchema.parse({ kind: 'container', workloadId, name: workloadId, state: 'running', ...over });

const runtimeReport = (over: Record<string, unknown> = {}) => {
  const workloads = (over.workloads as unknown[] | undefined) ?? [];
  return workloadRuntimeReportSchema.parse({
    runtime: 'docker',
    detection: 'present',
    collection: 'ok',
    complete: true,
    runtimeVersion: '27.1.1',
    observedCount: workloads.length,
    error: null,
    workloads: [],
    ...over,
  });
};

const storedRow = (id: string, workloadId: string, lastSeenHoursAgo = 0, runtime: WorkloadRuntime = 'docker'): StoredWorkload => ({
  id,
  runtime,
  workloadId,
  lastSeenAt: hoursAgo(lastSeenHoursAgo),
});

const input = (over: Partial<WorkloadSyncInput> = {}): WorkloadSyncInput => ({
  now: NOW,
  collectedAt: NOW,
  runtimes: [],
  storedRuntimes: [],
  storedWorkloads: [],
  isEnabled: () => true,
  previousHostRuntimes: [],
  previousHostsWorkloads: false,
  ...over,
});

const onlyPlan = (over: Partial<WorkloadSyncInput>) => planWorkloadSync(input(over)).runtimes[0]!;

describe('ordering guard', () => {
  it.each([
    ['older', hoursAgo(1)],
    ['equal', NOW],
  ])('skips a runtime whose collectedAt is not newer than the stored one (%s)', (_name, storedAt) => {
    const stored: StoredWorkloadRuntime = { runtime: 'docker', collectedAt: storedAt };
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ workloads: [item('a')] })],
        storedRuntimes: [stored],
        storedWorkloads: [storedRow('s1', 'gone')],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    const [docker] = plan.runtimes;
    expect(docker).toMatchObject({ runtime: 'docker', applied: false, collection: null, runtimeRow: null });
    expect(docker!.workloads).toEqual({ updates: [], inserts: [], deleteIds: [] });
    expect(plan.host.changed).toBe(false);
  });

  it('applies a newer report and still applies another runtime in the same report when one is skipped', () => {
    const plan = planWorkloadSync(
      input({
        collectedAt: NOW,
        runtimes: [
          runtimeReport({ runtime: 'docker', detection: 'absent', collection: 'unavailable' }),
          runtimeReport({ runtime: 'hyperv', workloads: [item('vm-1', { kind: 'vm' })] }),
        ],
        storedRuntimes: [{ runtime: 'docker', collectedAt: NOW }],
        storedWorkloads: [storedRow('d1', 'c1')],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.runtimes.map((r) => [r.runtime, r.applied])).toEqual([['docker', false], ['hyperv', true]]);
    // The skipped docker entry does not drop docker from the host axis even though it said absent.
    expect(plan.host.workloadRuntimes).toEqual(['docker', 'hyperv']);
  });

  it('always applies a runtime that has no stored row', () => {
    expect(onlyPlan({ runtimes: [runtimeReport()] }).applied).toBe(true);
  });
});

describe('effective collection time', () => {
  it('clamps a future-dated collectedAt to receipt time, so a later normal report is still applied', () => {
    const farFuture = new Date(NOW.getTime() + 48 * 3_600_000);
    const first = planWorkloadSync(input({ now: NOW, collectedAt: farFuture, runtimes: [runtimeReport()] }));
    const firstRow = first.runtimes[0]!;
    expect(firstRow.applied).toBe(true);
    expect(firstRow.runtimeRow!.collectedAt).toEqual(NOW);

    const later = new Date(NOW.getTime() + 60 * 60_000);
    const second = planWorkloadSync(
      input({
        now: later,
        collectedAt: later,
        runtimes: [runtimeReport({ workloads: [item('a')] })],
        storedRuntimes: [{ runtime: 'docker', collectedAt: firstRow.runtimeRow!.collectedAt }],
      }),
    );
    expect(second.runtimes[0]!.applied).toBe(true);
  });

  it('uses collectedAt when it is not in the future', () => {
    const past = hoursAgo(3);
    const plan = onlyPlan({ collectedAt: past, runtimes: [runtimeReport()] });
    expect(plan.runtimeRow!.collectedAt).toEqual(past);
  });
});

describe('replace-set for an ok and complete snapshot', () => {
  it('upserts the reported rows, keeps ids stable, and deletes only the rows that disappeared', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ workloads: [item('b'), item('c'), item('d')] })],
      storedRuntimes: [{ runtime: 'docker', collectedAt: hoursAgo(1) }],
      storedWorkloads: [storedRow('id-a', 'a'), storedRow('id-b', 'b'), storedRow('id-c', 'c')],
    });
    expect(plan.applied).toBe(true);
    expect(plan.collection).toBe('ok');
    expect(plan.workloads.updates.map((u) => u.id)).toEqual(['id-b', 'id-c']);
    expect(plan.workloads.inserts.map((r) => r.workloadId)).toEqual(['d']);
    expect(plan.workloads.deleteIds).toEqual(['id-a']);
    expect(plan.runtimeRow).toMatchObject({
      runtime: 'docker',
      detection: 'present',
      collection: 'ok',
      complete: true,
      runtimeVersion: '27.1.1',
      observedCount: 3,
      reportedCount: 3,
      lastError: null,
      collectedAt: NOW,
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
    });
  });

  it('an empty ok-and-complete snapshot deletes every stored row of that runtime only', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ workloads: [] })],
        storedWorkloads: [storedRow('x1', 'a'), storedRow('p1', 'a', 0, 'podman')],
      }),
    );
    expect(plan.runtimes[0]!.workloads.deleteIds).toEqual(['x1']);
  });
});

describe('a failing collection never deletes workloads', () => {
  it.each(['unavailable', 'permission_denied', 'error', 'unsupported'] as const)(
    'collection %s writes the runtime row only and leaves rows and last_success_at alone',
    (collection) => {
      const plan = onlyPlan({
        runtimes: [runtimeReport({ collection, complete: false, error: 'boom', workloads: [] })],
        storedWorkloads: [storedRow('s1', 'a'), storedRow('s2', 'b')],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      });
      expect(plan.workloads).toEqual({ updates: [], inserts: [], deleteIds: [] });
      expect(plan.runtimeRow).toMatchObject({
        collection,
        complete: false,
        lastError: 'boom',
        lastSuccessAt: null,
      });
    },
  );

  it('stores no error text for an ok collection', () => {
    expect(onlyPlan({ runtimes: [runtimeReport({ error: 'stale text' })] }).runtimeRow!.lastError).toBeNull();
  });
});

describe('truncated snapshots', () => {
  it('age-out: deletes unreported rows not seen for more than 24 h and keeps recent ones', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 5, workloads: [item('z')] })],
      storedWorkloads: [storedRow('old', 'x', 25), storedRow('fresh', 'y', 23), storedRow('edge', 'e', 24)],
    });
    expect(plan.workloads.inserts.map((r) => r.workloadId)).toEqual(['z']);
    // exactly 24 h is not "older than 24 h"
    expect(plan.workloads.deleteIds).toEqual(['old']);
  });

  it('retained cap: trims the oldest unreported rows down to 1500 retained', () => {
    const stored = Array.from({ length: 1000 }, (_, i) => ({
      id: `s${String(i).padStart(4, '0')}`,
      runtime: 'docker' as const,
      workloadId: `old-${i}`,
      lastSeenAt: new Date(NOW.getTime() - (i + 1) * 1000),
    }));
    const reported = Array.from({ length: 600 }, (_, i) => item(`new-${i}`));
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 1200, workloads: reported })],
      storedWorkloads: stored,
    });
    expect(plan.workloads.inserts).toHaveLength(600);
    // 600 reported + 1000 retained = 1600 > 1500: the 100 oldest unreported rows go.
    expect(plan.workloads.deleteIds).toHaveLength(100);
    expect(plan.workloads.deleteIds[0]).toBe('s0900');
    expect(plan.workloads.deleteIds.at(-1)).toBe('s0999');
  });

  it('treats observed greater than reported as truncated even when the agent claims complete', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: true, observedCount: 50, workloads: [item('a')] })],
      storedWorkloads: [storedRow('recent', 'b', 1)],
    });
    expect(plan.workloads.deleteIds).toEqual([]);
  });

  it('never deletes a row that the truncated report itself carried', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 3, workloads: [item('a')] })],
      storedWorkloads: [storedRow('id-a', 'a', 100)],
    });
    expect(plan.workloads.deleteIds).toEqual([]);
    expect(plan.workloads.updates.map((u) => u.id)).toEqual(['id-a']);
  });
});

describe('policy override', () => {
  it('a disabled runtime is recorded as disabled, its workloads are ignored and stored rows are deleted, but the host axis keeps the runtime', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ workloads: [item('a'), item('b')] })],
        storedWorkloads: [storedRow('s1', 'a'), storedRow('s2', 'z')],
        isEnabled: () => false,
      }),
    );
    const docker = plan.runtimes[0]!;
    expect(docker.collection).toBe('disabled');
    expect(docker.workloads).toEqual({ updates: [], inserts: [], deleteIds: ['s1', 's2'] });
    expect(docker.runtimeRow).toMatchObject({
      detection: 'present',
      collection: 'disabled',
      complete: true,
      observedCount: 0,
      reportedCount: 0,
      lastError: null,
      lastSuccessAt: null,
    });
    expect(plan.host).toEqual({ workloadRuntimes: ['docker'], hostsWorkloads: true, changed: true });
  });

  it('overrides an agent-reported error too, and honors only the per-runtime flag', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [
          runtimeReport({ runtime: 'docker', collection: 'error', error: 'x' }),
          runtimeReport({ runtime: 'hyperv', workloads: [item('vm', { kind: 'vm' })] }),
        ],
        isEnabled: (runtime) => runtime === 'hyperv',
      }),
    );
    expect(plan.runtimes.map((r) => [r.runtime, r.collection])).toEqual([['docker', 'disabled'], ['hyperv', 'ok']]);
  });

  it('an agent-reported disabled collection behaves like the override', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ collection: 'disabled', complete: true })],
      storedWorkloads: [storedRow('s1', 'a')],
    });
    expect(plan.workloads.deleteIds).toEqual(['s1']);
    expect(plan.runtimeRow).toMatchObject({ collection: 'disabled', observedCount: 0, reportedCount: 0 });
  });

  it('containerd is never enumerated and never policy-disabled', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ runtime: 'containerd', collection: 'unsupported', complete: false })],
      isEnabled: () => false,
    });
    expect(plan.collection).toBe('unsupported');
    expect(plan.workloads).toEqual({ updates: [], inserts: [], deleteIds: [] });
  });
});

describe('host axis', () => {
  it('detection present adds membership and the result is sorted', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'proxmox', workloads: [] }), runtimeReport({ runtime: 'docker', workloads: [] })],
      }),
    );
    expect(plan.host).toEqual({ workloadRuntimes: ['docker', 'proxmox'], hostsWorkloads: true, changed: true });
  });

  it('detection unknown keeps previous membership but still writes the runtime row and leaves workloads alone', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ detection: 'unknown', collection: 'error', complete: false, error: 'socket busy' })],
        storedWorkloads: [storedRow('s1', 'a')],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.host).toEqual({ workloadRuntimes: ['docker'], hostsWorkloads: true, changed: false });
    expect(plan.runtimes[0]!.runtimeRow).toMatchObject({ detection: 'unknown', collection: 'error' });
    expect(plan.runtimes[0]!.workloads.deleteIds).toEqual([]);
  });

  it('detection unknown does not add a runtime the device never had', () => {
    const plan = planWorkloadSync(input({ runtimes: [runtimeReport({ detection: 'unknown', collection: 'error' })] }));
    expect(plan.host).toEqual({ workloadRuntimes: [], hostsWorkloads: false, changed: false });
  });

  it('detection absent keeps the runtime row as absent, deletes every workload row and drops membership', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ detection: 'absent', collection: 'unavailable' })],
        storedRuntimes: [{ runtime: 'docker', collectedAt: hoursAgo(2) }],
        storedWorkloads: [storedRow('s1', 'a'), storedRow('s2', 'b')],
        previousHostRuntimes: ['docker', 'hyperv'],
        previousHostsWorkloads: true,
      }),
    );
    const docker = plan.runtimes[0]!;
    expect(docker).toMatchObject({
      applied: true,
      collection: 'unavailable',
      runtimeRow: {
        detection: 'absent',
        collection: 'unavailable',
        complete: true,
        observedCount: 0,
        reportedCount: 0,
        lastSuccessAt: null,
        collectedAt: NOW,
      },
    });
    expect(docker.workloads).toEqual({ updates: [], inserts: [], deleteIds: ['s1', 's2'] });
    expect(plan.host).toEqual({ workloadRuntimes: ['hyperv'], hostsWorkloads: true, changed: true });
  });

  it('absent wins over a policy override (the row records what the agent reported, not disabled)', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ detection: 'absent', collection: 'unavailable' })],
      isEnabled: () => false,
    });
    expect(plan.runtimeRow).toMatchObject({ detection: 'absent', collection: 'unavailable' });
  });

  it('a replayed older present report after an absent one is skipped', () => {
    const plan = planWorkloadSync(
      input({
        collectedAt: hoursAgo(1),
        runtimes: [runtimeReport({ detection: 'present', workloads: [item('a')] })],
        storedRuntimes: [{ runtime: 'docker', collectedAt: NOW }], // the absent row's collected_at
        previousHostRuntimes: [],
        previousHostsWorkloads: false,
      }),
    );
    expect(plan.runtimes[0]).toMatchObject({ applied: false, runtimeRow: null });
    expect(plan.host).toEqual({ workloadRuntimes: [], hostsWorkloads: false, changed: false });
  });

  it('a runtime the report does not mention is untouched', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'docker', detection: 'absent', collection: 'unavailable' })],
        previousHostRuntimes: ['docker', 'hyperv'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.runtimes).toHaveLength(1);
    expect(plan.host.workloadRuntimes).toEqual(['hyperv']);
  });

  it('containerd detection joins the host axis', () => {
    const plan = planWorkloadSync(
      input({ runtimes: [runtimeReport({ runtime: 'containerd', collection: 'unsupported', complete: false })] }),
    );
    expect(plan.host.workloadRuntimes).toEqual(['containerd']);
  });

  it('heals an inconsistent hosts_workloads flag', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'docker', workloads: [] })],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: false,
      }),
    );
    expect(plan.host).toEqual({ workloadRuntimes: ['docker'], hostsWorkloads: true, changed: true });
  });

  it('reports changed = false when membership and flag are already correct', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'docker', workloads: [] })],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.host.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/workloads/plan.test.ts
```

Expected FAIL: `Failed to resolve import "./plan"`. Exactly 1 file collected.

- [ ] **Step 3: Implement the planner** — create `apps/api/src/services/workloads/plan.ts`:

```ts
import {
  WORKLOAD_ENUMERATED_RUNTIMES,
  WORKLOADS_AGE_OUT_HOURS,
  WORKLOADS_RETAINED_MAX_PER_RUNTIME,
  type WorkloadCollection,
  type WorkloadDetection,
  type WorkloadReportItem,
  type WorkloadRuntime,
  type WorkloadRuntimeReport,
} from '@breeze/shared';
import { planChildRowSync, type ChildRowPlan } from '../inventoryChildSync';

/**
 * Pure planner for one workloads report (spec §6.2). Reads nothing, writes
 * nothing, has no clock: every decision the ingest transaction applies is made
 * here and is table-tested without a database. The branch order below is the
 * bullet order of spec §6.2.
 */

const HOUR_MS = 3_600_000;
const FAILURE_COLLECTIONS: ReadonlySet<WorkloadCollection> = new Set([
  'unavailable',
  'permission_denied',
  'error',
  'unsupported',
]);

export interface StoredWorkloadRuntime {
  runtime: WorkloadRuntime;
  collectedAt: Date;
}
export interface StoredWorkload {
  id: string;
  runtime: WorkloadRuntime;
  workloadId: string;
  lastSeenAt: Date;
}

export interface WorkloadSyncInput {
  /** Server receive time. */
  now: Date;
  /**
   * The agent's snapshot time (`report.collectedAt`). The ordering guard and
   * the stored collected_at use min(collectedAt, now) so a fast agent clock
   * cannot park the device in the future.
   */
  collectedAt: Date;
  runtimes: readonly WorkloadRuntimeReport[];
  storedRuntimes: readonly StoredWorkloadRuntime[];
  /** Only rows of the reported runtimes are needed. */
  storedWorkloads: readonly StoredWorkload[];
  /** Effective policy: is enumeration enabled for this runtime? */
  isEnabled: (runtime: WorkloadRuntime) => boolean;
  /** devices.workload_runtimes before this report. */
  previousHostRuntimes: readonly string[];
  /** devices.hosts_workloads before this report. */
  previousHostsWorkloads: boolean;
}

export interface WorkloadRuntimeWrite {
  runtime: WorkloadRuntime;
  detection: WorkloadDetection;
  collection: WorkloadCollection;
  complete: boolean;
  runtimeVersion: string | null;
  observedCount: number;
  reportedCount: number;
  lastError: string | null;
  collectedAt: Date;
  lastAttemptAt: Date;
  /** null = keep the stored last_success_at (only an ok collection advances it). */
  lastSuccessAt: Date | null;
}

export interface WorkloadRuntimePlan {
  runtime: WorkloadRuntime;
  /** false when the ordering guard skipped this runtime entirely. */
  applied: boolean;
  /** Collection after the policy override; null when the runtime was skipped. */
  collection: WorkloadCollection | null;
  runtimeRow: WorkloadRuntimeWrite | null;
  /** deleteIds is final: age-out and the retained cap are already applied. */
  workloads: ChildRowPlan<WorkloadReportItem>;
}

export interface WorkloadHostAxis {
  workloadRuntimes: string[];
  hostsWorkloads: boolean;
  changed: boolean;
}

export interface WorkloadSyncPlan {
  runtimes: WorkloadRuntimePlan[];
  host: WorkloadHostAxis;
}

const emptyWorkloadPlan = (): ChildRowPlan<WorkloadReportItem> => ({ updates: [], inserts: [], deleteIds: [] });

function isEnumeratedRuntime(runtime: WorkloadRuntime): boolean {
  return (WORKLOAD_ENUMERATED_RUNTIMES as readonly string[]).includes(runtime);
}

const sortedIds = (rows: readonly StoredWorkload[]): string[] => rows.map((row) => row.id).sort();

/**
 * A truncated snapshot (spec §6.2): rows absent from the report are NOT
 * deleted by absence. Rows not seen for more than 24 h age out; then the
 * oldest unreported rows are trimmed so at most 1500 remain.
 */
function truncatedDeleteIds(
  stored: readonly StoredWorkload[],
  reported: readonly WorkloadReportItem[],
  now: Date,
): string[] {
  const reportedIds = new Set(reported.map((workload) => workload.workloadId));
  const cutoff = now.getTime() - WORKLOADS_AGE_OUT_HOURS * HOUR_MS;
  const unreported = stored.filter((row) => !reportedIds.has(row.workloadId));
  const aged = unreported.filter((row) => row.lastSeenAt.getTime() < cutoff);
  const kept = unreported.filter((row) => row.lastSeenAt.getTime() >= cutoff);
  const overflow = reportedIds.size + kept.length - WORKLOADS_RETAINED_MAX_PER_RUNTIME;
  const trimmed =
    overflow > 0
      ? [...kept]
          .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime() || a.id.localeCompare(b.id))
          .slice(0, overflow)
      : [];
  return sortedIds([...aged, ...trimmed]);
}

function planWorkloads(
  report: WorkloadRuntimeReport,
  collection: WorkloadCollection,
  stored: readonly StoredWorkload[],
  now: Date,
): ChildRowPlan<WorkloadReportItem> {
  if (collection === 'disabled') {
    return { updates: [], inserts: [], deleteIds: sortedIds(stored) };
  }
  if (collection !== 'ok' || !isEnumeratedRuntime(report.runtime)) return emptyWorkloadPlan();
  const plan = planChildRowSync(stored, report.workloads, {
    storedKey: (row: StoredWorkload) => row.workloadId,
    reportedKey: (row: WorkloadReportItem) => row.workloadId,
    storedExact: (row: StoredWorkload) => row.workloadId,
    reportedExact: (row: WorkloadReportItem) => row.workloadId,
  });
  const truncated = !report.complete || report.observedCount > report.workloads.length;
  if (!truncated) return plan;
  return { updates: plan.updates, inserts: plan.inserts, deleteIds: truncatedDeleteIds(stored, report.workloads, now) };
}

/** Spec §6.2: min(collectedAt, receivedAt). */
function effectiveCollectedAt(input: WorkloadSyncInput): Date {
  return input.collectedAt.getTime() <= input.now.getTime() ? input.collectedAt : input.now;
}

function toRuntimeWrite(
  report: WorkloadRuntimeReport,
  collection: WorkloadCollection,
  input: WorkloadSyncInput,
): WorkloadRuntimeWrite {
  // An absent runtime has had all its workloads deleted: record it as cleared.
  const disabled = collection === 'disabled' || report.detection === 'absent';
  return {
    runtime: report.runtime,
    detection: report.detection,
    collection,
    complete: disabled ? true : report.complete,
    runtimeVersion: report.runtimeVersion,
    observedCount: disabled ? 0 : report.observedCount,
    reportedCount: disabled ? 0 : report.workloads.length,
    lastError: FAILURE_COLLECTIONS.has(collection) ? report.error : null,
    collectedAt: effectiveCollectedAt(input),
    lastAttemptAt: input.now,
    lastSuccessAt: collection === 'ok' ? input.now : null,
  };
}

export function planWorkloadSync(input: WorkloadSyncInput): WorkloadSyncPlan {
  const storedRuntime = new Map(input.storedRuntimes.map((row) => [row.runtime, row] as const));
  const membership = new Set(input.previousHostRuntimes);
  const effective = effectiveCollectedAt(input);

  const runtimes = input.runtimes.map((report): WorkloadRuntimePlan => {
    const existing = storedRuntime.get(report.runtime);
    if (existing && effective.getTime() <= existing.collectedAt.getTime()) {
      return {
        runtime: report.runtime,
        applied: false,
        collection: null,
        runtimeRow: null,
        workloads: emptyWorkloadPlan(),
      };
    }
    const stored = input.storedWorkloads.filter((row) => row.runtime === report.runtime);

    if (report.detection === 'absent') {
      membership.delete(report.runtime);
      // The row is KEPT (detection = absent) so the ordering guard survives a
      // replayed older `present` report; absent rows are never host-axis members.
      return {
        runtime: report.runtime,
        applied: true,
        collection: report.collection,
        runtimeRow: toRuntimeWrite(report, report.collection, input),
        workloads: { updates: [], inserts: [], deleteIds: sortedIds(stored) },
      };
    }
    if (report.detection === 'present') membership.add(report.runtime);

    const collection: WorkloadCollection =
      isEnumeratedRuntime(report.runtime) && !input.isEnabled(report.runtime) ? 'disabled' : report.collection;
    return {
      runtime: report.runtime,
      applied: true,
      collection,
      runtimeRow: toRuntimeWrite(report, collection, input),
      workloads: planWorkloads(report, collection, stored, input.now),
    };
  });

  const next = [...membership].sort();
  const previous = [...input.previousHostRuntimes].sort();
  const hostsWorkloads = next.length > 0;
  const changed =
    hostsWorkloads !== input.previousHostsWorkloads ||
    next.length !== previous.length ||
    next.some((runtime, index) => runtime !== previous[index]);
  return { runtimes, host: { workloadRuntimes: next, hostsWorkloads, changed } };
}
```

- [ ] **Step 4: Run the test**

```bash
cd apps/api && npx vitest run src/services/workloads/plan.test.ts
```

Expected PASS: every case in the five `describe` blocks (about 26 tests). If the retained-cap test fails on `deleteIds[0]`, check that ids sort lexicographically as zero-padded strings (`s0900`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/workloads/plan.ts apps/api/src/services/workloads/plan.test.ts
git commit -m "feat(workloads): plan per-report inventory sync as a pure function" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `workload_inventory` configuration feature end to end

**Files:**
- Create: `apps/api/migrations/2026-12-15-100100-workload-inventory-config-feature.sql`, `apps/api/src/services/workloads/featureMigration.integration.test.ts`, `apps/api/src/services/configurationPolicy.workloadInventory.test.ts`
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:61,429`, `packages/shared/src/constants/configFeatureTypes.ts:31,130`, `packages/shared/src/constants/configFeatureTypes.test.ts`, `apps/api/src/services/configurationPolicy.ts:16,65,895,1172,1223,1406,3134`, `apps/api/src/routes/configurationPolicies/featureLinks.ts:17,380,654`, `apps/api/src/routes/configurationPolicies/featureLinks.test.ts` (after the `time settings` it.each, line 235), `apps/api/src/services/policyBaselineDefaults.ts:17,64,114`, `apps/api/src/services/policyBaselineDefaults.test.ts`, `apps/api/src/services/aiToolsConfigPolicy.ts:248`, `apps/docs/src/content/docs/features/ai-tools.mdx:144`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:1020`, `apps/web/src/components/configurationPolicies/featureTabs/types.ts:18`, `apps/web/src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts`, `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx:47`

**Interfaces:**
- Produces: `configPolicyWorkloadInventorySettings` Drizzle table (`featureLinkId, enabled, dockerEnabled, podmanEnabled, hypervEnabled, proxmoxEnabled, intervalMinutes, createdAt, updatedAt`); `ConfigFeatureType` gains `'workload_inventory'`; `CONFIG_POLICY_FEATURE_TRUST_TIER.workload_inventory = 'protective'`; the feature round-trips through create / update / list / effective-config assemble with `WorkloadInventoryInlineSettings` as its inline shape.
- Consumes: `workloadInventoryInlineSettingsSchema`, `WORKLOAD_INVENTORY_DEFAULTS` (Task 1); the time-sync feature as the template: migration `2026-11-10-120000-time-sync-config-feature.sql` and its code sites (decompose `configurationPolicy.ts:895`, validate `:1172`, delete `:1223`, assemble `:1406`, inline-only branch `:3131-3140`, route `featureLinks.ts:380` / `:654`).
- Inline features are **not** added to `PARTNER_LINKABLE_FEATURE_TYPES` and not to `FEATURE_TABLE_MAP`; ownership is inherited from the configuration policy (org XOR partner).

- [ ] **Step 1: Write the failing tests.**

(a) Shared — in `packages/shared/src/constants/configFeatureTypes.test.ts`, add `'workload_inventory'` to the protective list in `'classifies protective/restrictive feature types as protective (never gated)'` (the array that ends `'warranty', 'time_sync'`), making it end `'warranty', 'time_sync', 'workload_inventory'`.

(b) Service — create `apps/api/src/services/configurationPolicy.workloadInventory.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';

const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserted: [] as any[],
  deleted: [] as unknown[],
}));
vi.mock('../db', () => {
  const tx: any = {};
  function result(rows: unknown[]) {
    const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const key of ['from', 'where', 'limit', 'orderBy', 'returning', 'for', 'innerJoin']) c[key] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({ set: () => result([{ id: '11111111-1111-4111-8111-111111111111' }]) });
  tx.delete = (table: unknown) => ({
    where: () => {
      m.deleted.push(table);
      return result([]);
    },
  });
  tx.insert = (table: unknown) => ({
    values: (value: unknown) => {
      m.inserted.push({ table, value });
      return result([]);
    },
  });
  return {
    db: tx,
    runOutsideDbContext: (f: any) => f(),
    withSystemDbAccessContext: (f: any) => f(),
    withDbAccessContext: (_c: any, f: any) => f(),
  };
});

import { listFeatureLinks, updateFeatureLink, validateFeaturePolicyExists } from './configurationPolicy';
import { configPolicyWorkloadInventorySettings } from '../db/schema';

const id = '11111111-1111-4111-8111-111111111111';
const settings = {
  enabled: true,
  dockerEnabled: true,
  podmanEnabled: false,
  hypervEnabled: true,
  proxmoxEnabled: false,
  intervalMinutes: 120,
};
const link = {
  id,
  configPolicyId: id,
  featureType: 'workload_inventory',
  featurePolicyId: null,
  inlineSettings: WORKLOAD_INVENTORY_DEFAULTS,
};
beforeEach(() => {
  m.rows = [];
  m.inserted = [];
  m.deleted = [];
});

it('reads typed columns instead of the stale inline mirror', async () => {
  m.rows = [[link], [settings]];
  expect((await listFeatureLinks(id))[0]!.inlineSettings).toEqual(settings);
});

it('replaces the settings row on update', async () => {
  m.rows = [[link]];
  await updateFeatureLink(id, { inlineSettings: settings }, id);
  expect(m.deleted).toContain(configPolicyWorkloadInventorySettings);
  expect(m.inserted).toContainEqual({
    table: configPolicyWorkloadInventorySettings,
    value: { featureLinkId: id, ...settings },
  });
});

it('rejects an invalid interval before deleting the existing settings', async () => {
  m.rows = [[link]];
  await expect(updateFeatureLink(id, { inlineSettings: { intervalMinutes: 5 } }, id)).rejects.toThrow();
  expect(m.deleted).toEqual([]);
});

it.each([
  { orgId: id, partnerId: null },
  { orgId: null, partnerId: id },
])('is inline-only for %j', async (owner) => {
  // A same-org configuration policy row exists, so only the inline-only branch can refuse the id.
  m.rows = [[{ id }]];
  expect(await validateFeaturePolicyExists('workload_inventory', null, owner)).toEqual({ valid: true });
  expect((await validateFeaturePolicyExists('workload_inventory', id, owner)).valid).toBe(false);
});
```

(c) Route — in `apps/api/src/routes/configurationPolicies/featureLinks.test.ts`, directly after the `it.each(['POST', 'PATCH'])('validates time settings on %s before mutation', …)` block that ends at line 235, add:

```ts
  it.each(['POST', 'PATCH'])(
    'validates workload inventory settings on %s before mutation',
    async (method) => {
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        featureLinks: [{ id: LINK_ID, featureType: 'workload_inventory' }],
      });
      validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
      const res = await app.request(
        `/${POLICY_ID}/features${method === 'PATCH' ? '/' + LINK_ID : ''}`,
        {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(method === 'POST' ? { featureType: 'workload_inventory' } : {}),
            inlineSettings: { intervalMinutes: 5 },
          }),
        },
      );
      expect(res.status).toBe(400);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    },
  );
```

(d) Baseline — in `apps/api/src/services/policyBaselineDefaults.test.ts`, add `import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';` (merge into the existing `@breeze/shared` import if one exists) and add inside the same `describe` as the `time_sync` baseline test:

```ts
  it('shows workload inventory as off by default and detection-only', () => {
    const entry = getPolicyBaselineDefaults().find((x) => x.featureType === 'workload_inventory')!;
    expect(entry).toMatchObject({ applied: false, inlineSettings: WORKLOAD_INVENTORY_DEFAULTS });
    expect(entry.behavior).toMatch(/off by default/i);
  });
```

(e) Real-DB — create `apps/api/src/services/workloads/featureMigration.integration.test.ts`:

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createPartner, createOrganization } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
import { pgErrorCode } from '../../utils/pgErrors';

const MIGRATION = '2026-12-15-100100-workload-inventory-config-feature.sql';

async function fixture() {
  const p = (await createPartner())!;
  const q = (await createPartner())!;
  const a = (await createOrganization({ partnerId: p.id }))!;
  const b = (await createOrganization({ partnerId: q.id }))!;
  const own: DbAccessContext = { scope: 'organization', orgId: a.id, accessibleOrgIds: [a.id], accessiblePartnerIds: [], currentPartnerId: p.id };
  const foreign: DbAccessContext = { scope: 'organization', orgId: b.id, accessibleOrgIds: [b.id], accessiblePartnerIds: [], currentPartnerId: q.id };
  const owner: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [a.id], accessiblePartnerIds: [p.id], currentPartnerId: p.id };
  const [policy] = await getTestDb().execute(sql`
    INSERT INTO configuration_policies(partner_id, name)
    VALUES (${p.id}, ${'Workload policy ' + randomUUID()}) RETURNING id`);
  const [link] = await getTestDb().execute(sql`
    INSERT INTO config_policy_feature_links(config_policy_id, feature_type)
    VALUES (${String(policy!.id)}, 'workload_inventory') RETURNING id`);
  await withDbAccessContext(owner, () =>
    db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id) VALUES (${String(link!.id)})`),
  );
  return { own, foreign, owner, linkId: String(link!.id) };
}

it('accepts the new feature type and applies the documented defaults', async () => {
  const f = await fixture();
  const [row] = await getTestDb().execute(sql`
    SELECT enabled, docker_enabled, podman_enabled, hyperv_enabled, proxmox_enabled, interval_minutes
      FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`);
  expect(row).toMatchObject({
    enabled: false,
    docker_enabled: true,
    podman_enabled: true,
    hyperv_enabled: true,
    proxmox_enabled: true,
    interval_minutes: 60,
  });
});

it('bounds the interval at 15..1440 and keeps one settings row per feature link', async () => {
  const f = await fixture();
  for (const bad of [14, 1441]) {
    await expect(
      withDbAccessContext(f.owner, () =>
        db.execute(sql`UPDATE config_policy_workload_inventory_settings SET interval_minutes = ${bad} WHERE feature_link_id = ${f.linkId}`),
      ),
    ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  }
  await expect(
    withDbAccessContext(f.owner, () =>
      db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id) VALUES (${f.linkId})`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
});

it('lets the owning partner write, shows partner-wide settings to its orgs read-only, and hides them from other tenants', async () => {
  const f = await fixture();
  const read = () => db.execute(sql`SELECT * FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`);
  expect(await withDbAccessContext(f.owner, read)).toHaveLength(1);
  // org-scoped session of the owning partner's org: SELECT-only partner-wide branch.
  expect(await withDbAccessContext(f.own, read)).toHaveLength(1);
  expect(await withDbAccessContext(f.foreign, read)).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`UPDATE config_policy_workload_inventory_settings SET enabled = true WHERE feature_link_id = ${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`DELETE FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  await expect(
    withDbAccessContext(f.foreign, () =>
      db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id) VALUES (${f.linkId})`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
});

it('cascades the settings row when its feature link is deleted', async () => {
  const f = await fixture();
  await getTestDb().execute(sql`DELETE FROM config_policy_feature_links WHERE id = ${f.linkId}`);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`),
  ).toHaveLength(0);
});

it('replaying the migration is a no-op that preserves rows', async () => {
  const f = await fixture();
  await replayMigration(MIGRATION);
  await replayMigration(MIGRATION);
  expect(
    await getTestDb().execute(sql`SELECT 1 FROM config_policy_workload_inventory_settings WHERE feature_link_id = ${f.linkId}`),
  ).toHaveLength(1);
});
```

(f) Web parity (red first) — in `apps/web/src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts`, replace the test `'exposes every canonical type and no retired type'` so the file states the temporary exclusion honestly:

```ts
  it('exposes every canonical type except the documented exclusions, and no retired type', () => {
    // W04 (#3834) adds the workload_inventory tab and removes this exclusion.
    expect([...EDITOR_EXCLUDED_FEATURE_TYPES]).toEqual(['workload_inventory']);
    expect(Object.keys(FEATURE_META).sort()).toEqual(
      CONFIG_FEATURE_TYPES.filter((t) => !(EDITOR_EXCLUDED_FEATURE_TYPES as readonly string[]).includes(t)).sort(),
    );
    for (const retired of RETIRED_CONFIG_FEATURE_TYPES) {
      expect(FEATURE_META).not.toHaveProperty(retired);
      expect(FEATURE_TYPES as readonly string[]).not.toContain(retired);
    }
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
(cd packages/shared && npx vitest run src/constants/configFeatureTypes.test.ts)
(cd apps/api && npx vitest run src/services/configurationPolicy.workloadInventory.test.ts src/services/policyBaselineDefaults.test.ts src/routes/configurationPolicies/featureLinks.test.ts)
(cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/featureMigration.integration.test.ts)
```

Expected FAIL: shared — the protective-list assertion fails (tier `undefined`); API — `configPolicyWorkloadInventorySettings` is not exported / the `workload_inventory` baseline is missing / the route does not return 400; web — `EDITOR_EXCLUDED_FEATURE_TYPES` equals `[]`; integration — `invalid input value for enum config_feature_type: "workload_inventory"`.

- [ ] **Step 3: Write the migration** — create `apps/api/migrations/2026-12-15-100100-workload-inventory-config-feature.sql`:

```sql
-- #3834 W01: inline `workload_inventory` configuration feature.
-- Settings child reaches its org/partner through feature_link ->
-- configuration_policies (parent-chain RLS, same shape as
-- config_policy_time_sync_settings) plus the additive SELECT-only partner-wide
-- branch (a partner-wide policy must reach org-scoped agent/heartbeat reads).
-- No row writes in this file.
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'workload_inventory';

CREATE TABLE IF NOT EXISTS config_policy_workload_inventory_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  docker_enabled boolean NOT NULL DEFAULT true,
  podman_enabled boolean NOT NULL DEFAULT true,
  hyperv_enabled boolean NOT NULL DEFAULT true,
  proxmox_enabled boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL DEFAULT 60,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT config_policy_workload_inventory_interval_chk CHECK (interval_minutes BETWEEN 15 AND 1440)
);
ALTER TABLE config_policy_workload_inventory_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_workload_inventory_settings FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t text := 'config_policy_workload_inventory_settings';
  predicate text;
BEGIN
  predicate := format('EXISTS (SELECT 1 FROM configuration_policies policy WHERE policy.id = (SELECT link.config_policy_id FROM config_policy_feature_links link WHERE link.id = %I.feature_link_id) AND (breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)))', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_select ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_insert ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_update ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_delete ON %I', t);
  EXECUTE format('CREATE POLICY breeze_parent_select ON %I FOR SELECT USING (%s)', t, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_insert ON %I FOR INSERT WITH CHECK (%s)', t, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t, predicate, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_delete ON %I FOR DELETE USING (%s)', t, predicate);
END $$;
DROP POLICY IF EXISTS config_policy_workload_inventory_settings_partner_wide_select ON config_policy_workload_inventory_settings;
CREATE POLICY config_policy_workload_inventory_settings_partner_wide_select
ON config_policy_workload_inventory_settings FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (
      SELECT fl.config_policy_id FROM config_policy_feature_links fl
      WHERE fl.id = config_policy_workload_inventory_settings.feature_link_id
    )
    AND cp.org_id IS NULL
    AND cp.partner_id = public.breeze_current_partner_id()
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON config_policy_workload_inventory_settings TO breeze_app;
```

- [ ] **Step 4: Drizzle schema.** In `apps/api/src/db/schema/configurationPolicies.ts` append to `configFeatureTypeEnum` after `'time_sync',` (line 61):

```ts
  // #3834. APPENDED, matching the migration's ADD VALUE order.
  'workload_inventory',
```

and add after the `configPolicyTimeSyncSettings` definition (it ends with `],\n);` at line ~429, directly before the `// Single-item: one row per feature link (sensitive data scan settings)` comment):

```ts
// Single-item: one row per feature link (workload inventory enumeration
// settings, #3834). Inline-only — no linked-policy variant. Detection is
// always on; these gate enumeration only.
export const configPolicyWorkloadInventorySettings = pgTable(
  'config_policy_workload_inventory_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    featureLinkId: uuid('feature_link_id')
      .notNull()
      .unique()
      .references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    dockerEnabled: boolean('docker_enabled').notNull().default(true),
    podmanEnabled: boolean('podman_enabled').notNull().default(true),
    hypervEnabled: boolean('hyperv_enabled').notNull().default(true),
    proxmoxEnabled: boolean('proxmox_enabled').notNull().default(true),
    intervalMinutes: integer('interval_minutes').notNull().default(60),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    check(
      'config_policy_workload_inventory_interval_chk',
      sql`${t.intervalMinutes} BETWEEN 15 AND 1440`,
    ),
  ],
);
```

- [ ] **Step 5: Shared constants.** In `packages/shared/src/constants/configFeatureTypes.ts` add to `CONFIG_FEATURE_TYPES` after `'time_sync',` (line 31):

```ts
  // #3834 — workload host inventory enumeration settings, inline-only.
  'workload_inventory',
```

and to `CONFIG_POLICY_FEATURE_TRUST_TIER` after the `time_sync` line (130):

```ts
  workload_inventory: 'protective', // opt-in, read-only enumeration of containers/VMs — nothing executes, installs or receives a secret
```

- [ ] **Step 6: Service wiring.** In `apps/api/src/services/configurationPolicy.ts`:

1. Add `configPolicyWorkloadInventorySettings,` to the `../db/schema` import list directly after `configPolicyTimeSyncSettings,` (line 16) and `workloadInventoryInlineSettingsSchema,` to the `@breeze/shared/validators` import list directly after `timeSyncInlineSettingsSchema,` (line 65).
2. Decompose — after the `case 'time_sync': { … break; }` block that ends near line 905:

```ts
    case 'workload_inventory': {
      const parsed = workloadInventoryInlineSettingsSchema.parse(s);
      await tx.insert(configPolicyWorkloadInventorySettings).values({
        featureLinkId: linkId,
        ...parsed,
      });
      break;
    }
```

3. `assertDecomposableInlineSettings` — after `case 'time_sync':` (line 1172):

```ts
    case 'workload_inventory':
      workloadInventoryInlineSettingsSchema.parse(settings);
      break;
```

4. Delete-by-link switch — after the `time_sync` case (line 1223):

```ts
    case 'workload_inventory':
      await tx.delete(configPolicyWorkloadInventorySettings).where(eq(configPolicyWorkloadInventorySettings.featureLinkId, linkId));
      break;
```

5. Assemble — after the `case 'time_sync': { … }` block ending near line 1421:

```ts
    case 'workload_inventory': {
      const [row] = await executor
        .select()
        .from(configPolicyWorkloadInventorySettings)
        .where(eq(configPolicyWorkloadInventorySettings.featureLinkId, linkId))
        .limit(1);
      return row
        ? workloadInventoryInlineSettingsSchema.parse({
            enabled: row.enabled,
            dockerEnabled: row.dockerEnabled,
            podmanEnabled: row.podmanEnabled,
            hypervEnabled: row.hypervEnabled,
            proxmoxEnabled: row.proxmoxEnabled,
            intervalMinutes: row.intervalMinutes,
          })
        : null;
    }
```

6. `validateFeaturePolicyExists` inline-only list (line ~3134): add `featureType === 'workload_inventory' ||` directly after `featureType === 'time_sync' ||`.

In `apps/api/src/routes/configurationPolicies/featureLinks.ts`: add `workloadInventoryInlineSettingsSchema,` to the `@breeze/shared/validators` import (after `timeSyncInlineSettingsSchema,`, line 17); after the create-path `time_sync` block (ends line ~388):

```ts
    if (data.featureType === 'workload_inventory' && data.inlineSettings) {
      const parsed = workloadInventoryInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid workload inventory settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }
```

and after the PATCH-path `if (existingLink.featureType === 'time_sync') { … }` block (ends line ~662):

```ts
      if (existingLink.featureType === 'workload_inventory') {
        const parsed = workloadInventoryInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid workload inventory settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
```

In `apps/api/src/services/policyBaselineDefaults.ts`: change the import (line 17) to `import { HARDWARE_MONITORING_DEFAULTS, TIME_SYNC_DEFAULTS, WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';`; widen the `NOT_ENFORCED` key exclusion (line 64) to `Exclude<ConfigFeatureType, 'remote_access' | 'pam' | 'hardware_monitoring' | 'time_sync' | 'workload_inventory'>`; and add before `const meta = NOT_ENFORCED[ft];` (after the `time_sync` branch):

```ts
    if (ft === 'workload_inventory') {
      return {
        featureType: ft,
        label: 'Workload Inventory',
        applied: false,
        inlineSettings: { ...WORKLOAD_INVENTORY_DEFAULTS },
        behavior:
          'Workload listing is OFF by default: container and VM runtimes are detected, but their workloads are not listed until a policy enables it.',
      };
    }
```

In `apps/api/src/services/aiToolsConfigPolicy.ts` add to `POLICY_FEATURE_INLINE_SETTINGS_REFERENCE` after the `time_sync:` entry (line 248):

```ts
  workload_inventory: `{ enabled: false, dockerEnabled: true, podmanEnabled: true, hypervEnabled: true, proxmoxEnabled: true, intervalMinutes: 60 } — inline-only workload inventory settings. enabled defaults to false (opt-in): runtimes are always detected, but containers and VMs are listed only when enabled is true and the runtime's own flag is true. Turning a runtime off deletes its listed workloads. intervalMinutes is an integer in 15..1440. Collection is read-only.`,
```

and add the matching docs row to `apps/docs/src/content/docs/features/ai-tools.mdx` on the line directly after the `| \`time_sync\` | … |` row (line 144). The docs test asserts `page.toContain(reference)` for every entry, so the string must match byte for byte:

```
| `workload_inventory` | `{ enabled: false, dockerEnabled: true, podmanEnabled: true, hypervEnabled: true, proxmoxEnabled: true, intervalMinutes: 60 } — inline-only workload inventory settings. enabled defaults to false (opt-in): runtimes are always detected, but containers and VMs are listed only when enabled is true and the runtime's own flag is true. Turning a runtime off deletes its listed workloads. intervalMinutes is an integer in 15..1440. Collection is read-only.` |
```

- [ ] **Step 7: RLS coverage registration.** In `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` add after the `['config_policy_time_sync_settings', ['configuration_policies']],` entry (line 1020):

```ts
  ['config_policy_workload_inventory_settings', ['configuration_policies']],
```

- [ ] **Step 8: Minimal web accommodation (the shared list is also a web type).** `workload_inventory` has no editor tab until W04; excluding it keeps the editor from rendering a blank tab and keeps the `Record<FeatureType, …>` maps compiling.

In `apps/web/src/components/configurationPolicies/featureTabs/types.ts` change line 18:

```ts
export const EDITOR_EXCLUDED_FEATURE_TYPES = [] as const;
```

to

```ts
// W04 (#3834) ships the workload_inventory tab and deletes this exclusion.
export const EDITOR_EXCLUDED_FEATURE_TYPES = ['workload_inventory'] as const;
```

(also update the preceding comment sentence "The exclusion list is currently EMPTY — …" to say the list holds only `workload_inventory` until W04).

In `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx` change `EFFECTIVE_CONFIG_EXCLUDED_FEATURE_TYPES` (line 47):

```ts
export const EFFECTIVE_CONFIG_EXCLUDED_FEATURE_TYPES = [
  "remote_access",
  "pam",
  // W04 (#3834) adds the workload_inventory row.
  "workload_inventory",
] as const;
```

- [ ] **Step 9: Run the targeted suites**

```bash
(cd packages/shared && npx vitest run src/constants/configFeatureTypes.test.ts src/validators/workloads.test.ts)
(cd apps/api && npx vitest run src/services/configurationPolicy.workloadInventory.test.ts src/services/configurationPolicy.timeSync.test.ts src/services/policyBaselineDefaults.test.ts src/routes/configurationPolicies/featureLinks.test.ts src/services/aiToolsConfigPolicy.test.ts src/services/mcpGuidancePromptTools.test.ts src/db/autoMigrate.test.ts)
(cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/featureMigration.integration.test.ts)
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

Expected PASS: all of the above. `policyBaselineDefaults.test.ts` also pins the canonical + retired feature types to the Drizzle `configFeatureTypeEnum` (enum order = migration `ADD VALUE` order). `mcpGuidancePromptTools.test.ts` asserts the docs table contains every reference string. If `configurationPolicy.workloadInventory.test.ts` mock-row sequencing differs from `configurationPolicy.timeSync.test.ts` (it should not — same code path), mirror that file's `m.rows` order exactly.

- [ ] **Step 10: Typecheck wide**

```bash
cd /Users/toddhebebrand/breeze/.claude/worktrees/plan-3834 && pnpm --filter @breeze/shared typecheck
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "api tsc exit=$?"
(cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm exec astro check; echo "web check exit=$?")
```

Expected: all exit 0. A non-exhaustive `Record<ConfigFeatureType, …>` anywhere else surfaces here as a TS error naming the file; add the `workload_inventory` entry there (do not widen the type).

- [ ] **Step 11: Commit**

```bash
git add apps/api/migrations/2026-12-15-100100-workload-inventory-config-feature.sql apps/api/src/db/schema/configurationPolicies.ts packages/shared/src/constants/configFeatureTypes.ts packages/shared/src/constants/configFeatureTypes.test.ts apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.workloadInventory.test.ts apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts apps/api/src/services/policyBaselineDefaults.ts apps/api/src/services/policyBaselineDefaults.test.ts apps/api/src/services/aiToolsConfigPolicy.ts apps/docs/src/content/docs/features/ai-tools.mdx apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/workloads/featureMigration.integration.test.ts apps/web/src/components/configurationPolicies/featureTabs/types.ts apps/web/src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx
git commit -m "feat(workloads): add the workload_inventory configuration feature" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 5: Settings resolver, heartbeat delivery and the capability handshake

**Files:**
- Create: `apps/api/src/services/workloads/settings.ts`, `settings.test.ts`, `settings.integration.test.ts`, `configUpdate.ts`, `configUpdate.test.ts` (all under `apps/api/src/services/workloads/`)
- Modify: `apps/api/src/routes/agents/helpers.ts:70,2243`, `apps/api/src/routes/agents/heartbeat.ts:42,297,983,2237,2245,2256,2330,2342,2360,2370`, `apps/api/src/routes/agents/schemas.ts:377`, `apps/api/src/routes/agents/heartbeat.test.ts:181,3195,3849`, `apps/api/src/__tests__/parkedFanout.contract.test.ts:299`

**Interfaces:**
- Produces:

```ts
// services/workloads/settings.ts
export interface ResolvedWorkloadInventorySettings { orgId: string; settings: WorkloadInventoryInlineSettings }
export const WORKLOAD_INVENTORY_SETTINGS_CACHE_TTL_SECONDS = 120;
export function resolveDeviceWorkloadInventorySettings(deviceId: string): Promise<ResolvedWorkloadInventorySettings>; // uncached
export function getDeviceWorkloadInventorySettings(deviceId: string): Promise<ResolvedWorkloadInventorySettings>;     // Redis 120 s, key `workloads:settings:device:<id>`
// services/workloads/configUpdate.ts
export interface WorkloadInventoryConfigUpdate {
  enabled: boolean; docker_enabled: boolean; podman_enabled: boolean;
  hyperv_enabled: boolean; proxmox_enabled: boolean; interval_minutes: number;
}
export function toWorkloadInventoryConfigUpdate(settings: WorkloadInventoryInlineSettings): WorkloadInventoryConfigUpdate;
export function buildResolvedWorkloadInventoryConfigUpdate(deviceId: string): Promise<WorkloadInventoryConfigUpdate>;
// routes/agents/helpers.ts
export function buildWorkloadInventoryConfigUpdate(deviceId: string): Promise<WorkloadInventoryConfigUpdate>;
// routes/agents/heartbeat.ts
export function normalizeWorkloadInventoryProtocolVersion(value: unknown): 0 | 1;
```

- Consumes: `workloadInventoryInlineSettingsSchema` (Task 1); `configPolicyWorkloadInventorySettings`, `configPolicyEffectiveFeatureLinks`, `configPolicyAssignments`, `configurationPolicies`, `devices`, `deviceGroupMemberships`, `organizations` (schema); `policyOwnershipCondition`, `withDevicePartnerPolicyVisibility` (`services/configPolicyOwnership`), `buildRoleOsFilterConditions`, `matchesRoleOsFilter` (`services/featureConfigResolver`), `getRedis` (`services/redis`) — all already used by `services/timeSync/settings.ts`, the structural template.
- Semantics (spec §7.2): winning assignment = highest level (device > device_group > site > organization > partner), then lowest `priority`, then oldest assignment; **no policy → `WORKLOAD_INVENTORY_DEFAULTS`** (enabled false); wire keys are snake_case like the other settings blocks; a resolver error **throws** (heartbeat omits the key; ingest 500s without writing); the cache entry carries `orgId` and is ignored when it differs from the device's current org (device moved).
- The heartbeat resolver block runs inside the shared `withSystemDbAccessContext` (system scope); ingest runs under the agent's org context, so the resolver must work in both — `withDevicePartnerPolicyVisibility` is what lets an org-scoped read see partner-wide policy.

- [ ] **Step 1: Write the failing tests.**

(a) `apps/api/src/services/workloads/configUpdate.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';

const m = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./settings', () => ({ getDeviceWorkloadInventorySettings: m.get }));
import { buildResolvedWorkloadInventoryConfigUpdate, toWorkloadInventoryConfigUpdate } from './configUpdate';

beforeEach(() => m.get.mockReset());

it('sends explicit defaults (enabled: false) when no policy applies, so removing a policy turns collection off', async () => {
  m.get.mockResolvedValue({ orgId: 'org-1', settings: WORKLOAD_INVENTORY_DEFAULTS });
  expect(await buildResolvedWorkloadInventoryConfigUpdate('device-1')).toEqual({
    enabled: false,
    docker_enabled: true,
    podman_enabled: true,
    hyperv_enabled: true,
    proxmox_enabled: true,
    interval_minutes: 60,
  });
});

it('maps every setting to its snake_case wire key', () => {
  expect(
    toWorkloadInventoryConfigUpdate({
      enabled: true,
      dockerEnabled: false,
      podmanEnabled: true,
      hypervEnabled: false,
      proxmoxEnabled: true,
      intervalMinutes: 30,
    }),
  ).toEqual({
    enabled: true,
    docker_enabled: false,
    podman_enabled: true,
    hyperv_enabled: false,
    proxmox_enabled: true,
    interval_minutes: 30,
  });
});

it('rejects when the resolver fails, so the heartbeat omits the key instead of sending defaults', async () => {
  m.get.mockRejectedValue(new Error('policy read failed'));
  await expect(buildResolvedWorkloadInventoryConfigUpdate('device-1')).rejects.toThrow('policy read failed');
});
```

(b) `apps/api/src/services/workloads/settings.test.ts` (cache and winner selection with a mocked database; the real-Postgres proof is (c)):

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';

const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  redis: null as null | { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> },
}));
vi.mock('../../db', () => {
  const result = (rows: unknown[]) => {
    const chain: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const key of ['from', 'where', 'limit', 'innerJoin', 'orderBy']) chain[key] = () => chain;
    return chain;
  };
  return { db: { select: () => result(m.rows.shift() ?? []) } };
});
vi.mock('../configPolicyOwnership', async () => {
  const { db } = await import('../../db');
  return {
    policyOwnershipCondition: () => undefined,
    withDevicePartnerPolicyVisibility: async (_db: unknown, _partnerId: unknown, fn: (executor: unknown) => unknown) => fn(db),
  };
});
vi.mock('../featureConfigResolver', () => ({
  buildRoleOsFilterConditions: () => [],
  matchesRoleOsFilter: () => true,
}));
vi.mock('../redis', () => ({ getRedis: () => m.redis }));

import { getDeviceWorkloadInventorySettings } from './settings';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PARTNER = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const POLICY = '55555555-5555-4555-8555-555555555555';

const policyRow = (over: Record<string, unknown> = {}) => ({
  policyId: POLICY,
  policyName: 'Policy',
  level: 'partner',
  assignmentPriority: 0,
  assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
  roleFilter: null,
  osFilter: null,
  enabled: true,
  dockerEnabled: true,
  podmanEnabled: false,
  hypervEnabled: true,
  proxmoxEnabled: true,
  intervalMinutes: 30,
  ...over,
});
/** Selects in a cache miss: device org, device row, org partner, groups, policy rows. */
const missRows = (policies: unknown[]) => [
  [{ orgId: ORG }],
  [{ orgId: ORG, siteId: SITE, deviceRole: 'server', osType: 'linux' }],
  [{ partnerId: PARTNER }],
  [],
  policies,
];

beforeEach(() => {
  m.rows = [];
  m.redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK') };
});

it('serves a cache hit without resolving and without writing the cache', async () => {
  const settings = { ...WORKLOAD_INVENTORY_DEFAULTS, enabled: true };
  m.redis!.get.mockResolvedValue(JSON.stringify({ orgId: ORG, settings }));
  m.rows = [[{ orgId: ORG }]];
  expect(await getDeviceWorkloadInventorySettings(DEVICE)).toEqual({ orgId: ORG, settings });
  expect(m.redis!.set).not.toHaveBeenCalled();
});

it('ignores a cache entry stamped with another org (the device moved) and re-resolves', async () => {
  m.redis!.get.mockResolvedValue(
    JSON.stringify({ orgId: '99999999-9999-4999-8999-999999999999', settings: { ...WORKLOAD_INVENTORY_DEFAULTS, enabled: true } }),
  );
  m.rows = missRows([]);
  const resolved = await getDeviceWorkloadInventorySettings(DEVICE);
  expect(resolved.settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
  expect(m.redis!.set).toHaveBeenCalledWith(
    `workloads:settings:device:${DEVICE}`,
    expect.any(String),
    'EX',
    120,
  );
});

it('falls back to the resolver when the cache entry is unreadable', async () => {
  m.redis!.get.mockResolvedValue('not json');
  m.rows = missRows([policyRow()]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toMatchObject({ enabled: true, intervalMinutes: 30 });
});

it('resolves without Redis', async () => {
  m.redis = null;
  m.rows = missRows([]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
});

it('returns defaults (enabled: false) when no policy applies', async () => {
  m.rows = missRows([]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
});

it('maps the winning policy row onto the settings', async () => {
  m.rows = missRows([policyRow()]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toEqual({
    enabled: true,
    dockerEnabled: true,
    podmanEnabled: false,
    hypervEnabled: true,
    proxmoxEnabled: true,
    intervalMinutes: 30,
  });
});

it('the nearer level wins over a partner-wide policy even when the partner-wide one is enabled', async () => {
  m.rows = missRows([
    policyRow({ level: 'partner', enabled: true }),
    policyRow({ level: 'organization', enabled: false }),
  ]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings.enabled).toBe(false);
});

it('within one level the lower priority number wins, then the older assignment', async () => {
  m.rows = missRows([
    policyRow({ level: 'site', assignmentPriority: 5, enabled: false }),
    policyRow({ level: 'site', assignmentPriority: 1, enabled: true, intervalMinutes: 45 }),
  ]);
  expect((await getDeviceWorkloadInventorySettings(DEVICE)).settings).toMatchObject({ enabled: true, intervalMinutes: 45 });
});

it('throws when the device is not visible (never resolves defaults for a device it cannot see)', async () => {
  m.rows = [[]];
  await expect(getDeviceWorkloadInventorySettings(DEVICE)).rejects.toThrow('not visible');
});
```

(c) `apps/api/src/services/workloads/settings.integration.test.ts` (real Postgres — the partner-wide fan-out proof the repo requires for every config-ish feature):

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { WORKLOAD_INVENTORY_DEFAULTS } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { resolveDeviceWorkloadInventorySettings } from './settings';

const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };

async function fixture() {
  const partner = (await createPartner())!;
  const otherPartner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'workload-settings',
      osType: 'linux',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  // An org-scoped session (what agent ingest runs as): blind to partner-wide
  // rows unless the resolver widens visibility to the device's own partner.
  const orgCtx: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const addPolicy = async (args: {
    owner: 'partner' | 'org' | 'other-partner';
    level: 'partner' | 'organization';
    enabled: boolean;
    podmanEnabled?: boolean;
    intervalMinutes?: number;
    status?: 'active' | 'inactive';
  }) => {
    const name = `Workloads ${randomUUID()}`;
    const status = args.status ?? 'active';
    const [policy] =
      args.owner === 'org'
        ? await getTestDb().execute(sql`INSERT INTO configuration_policies(org_id, name, status) VALUES (${org.id}, ${name}, ${status}::config_policy_status) RETURNING id`)
        : await getTestDb().execute(sql`INSERT INTO configuration_policies(partner_id, name, status) VALUES (${args.owner === 'partner' ? partner.id : otherPartner.id}, ${name}, ${status}::config_policy_status) RETURNING id`);
    const policyId = String(policy!.id);
    const [link] = await getTestDb().execute(
      sql`INSERT INTO config_policy_feature_links(config_policy_id, feature_type) VALUES (${policyId}, 'workload_inventory') RETURNING id`,
    );
    await withDbAccessContext(system, () =>
      db.execute(sql`
        INSERT INTO config_policy_workload_inventory_settings(feature_link_id, enabled, podman_enabled, interval_minutes)
        VALUES (${String(link!.id)}, ${args.enabled}, ${args.podmanEnabled ?? true}, ${args.intervalMinutes ?? 60})`),
    );
    const targetId = args.level === 'partner' ? (args.owner === 'other-partner' ? otherPartner.id : partner.id) : org.id;
    await getTestDb().execute(sql`
      INSERT INTO config_policy_assignments(config_policy_id, level, target_id)
      VALUES (${policyId}, ${args.level}::config_assignment_level, ${targetId})`);
  };
  const resolve = () => withDbAccessContext(orgCtx, () => resolveDeviceWorkloadInventorySettings(device!.id));
  return { addPolicy, resolve, org };
}

it('returns the defaults (disabled) for a device with no policy', async () => {
  const f = await fixture();
  expect((await f.resolve()).settings).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
});

it('a partner-wide policy reaches an org-scoped read (partner-wide fan-out against real Postgres)', async () => {
  const f = await fixture();
  await f.addPolicy({ owner: 'partner', level: 'partner', enabled: true, podmanEnabled: false, intervalMinutes: 30 });
  expect(await f.resolve()).toMatchObject({
    orgId: f.org.id,
    settings: { enabled: true, dockerEnabled: true, podmanEnabled: false, intervalMinutes: 30 },
  });
});

it('an org-level policy that disables the feature overrides an enabled partner-wide policy', async () => {
  const f = await fixture();
  await f.addPolicy({ owner: 'partner', level: 'partner', enabled: true });
  await f.addPolicy({ owner: 'org', level: 'organization', enabled: false });
  expect((await f.resolve()).settings.enabled).toBe(false);
});

it('ignores an inactive policy and another partner\'s policy', async () => {
  const f = await fixture();
  await f.addPolicy({ owner: 'partner', level: 'partner', enabled: true, status: 'inactive' });
  await f.addPolicy({ owner: 'other-partner', level: 'partner', enabled: true });
  expect((await f.resolve()).settings.enabled).toBe(false);
});
```

(d) Heartbeat (`apps/api/src/routes/agents/heartbeat.test.ts`):

1. In the `vi.mock('./helpers', …)` factory add, directly after `buildTimeSyncConfigUpdate: vi.fn(),` (line 181): `buildWorkloadInventoryConfigUpdate: vi.fn(),`
2. Directly after the `it.each([… consent … ])('persists tolerant non-sticky consent-prompt capability: $name', …)` block (it ends at line 3195, before the `// The backup helper's brokered-read protocol` comment) add:

```ts
  // workloadInventoryProtocolVersion: same non-sticky contract as the other
  // capability counters. Only the exact integer 1 is recorded; an agent that
  // stops reporting it (old build, downgrade) self-heals back to 0.
  it.each([
    { name: 'recognized version 1', capabilities: { workloadInventoryProtocolVersion: 1 }, expected: 1 },
    { name: 'omitted capability object', capabilities: undefined, expected: 0 },
    { name: 'omitted key (pre-collector agent)', capabilities: {}, expected: 0 },
    { name: 'explicit zero downgrade', capabilities: { workloadInventoryProtocolVersion: 0 }, expected: 0 },
    { name: 'unknown integer version', capabilities: { workloadInventoryProtocolVersion: 2 }, expected: 0 },
    { name: 'fractional version', capabilities: { workloadInventoryProtocolVersion: 1.5 }, expected: 0 },
    { name: 'string version', capabilities: { workloadInventoryProtocolVersion: '1' }, expected: 0 },
  ])('persists tolerant non-sticky workload-inventory capability: $name', async ({ capabilities, expected }) => {
    const setSpy = vi.fn(() => ({ where: vi.fn(() => whereResultWithReturning()) }));
    await setupMocks(setSpy);

    const body = capabilities === undefined
      ? minimalHeartbeatBody
      : { ...minimalHeartbeatBody, securityCapabilities: capabilities };
    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(resp.status).toBe(200);
    const updateArg = (setSpy.mock.calls as any[])[0]?.[0] as Record<string, unknown>;
    expect(updateArg.workloadInventoryProtocolVersion).toBe(expected);
  });
```

3. Directly after the `it('omits time settings on resolver failure while preserving the heartbeat', …)` block (ends ~line 3849) add:

```ts
  it('delivers workload inventory settings under the shared system context', async () => {
    const { buildWorkloadInventoryConfigUpdate } = await import('./helpers');
    const payload = {
      enabled: false,
      docker_enabled: true,
      podman_enabled: true,
      hyperv_enabled: true,
      proxmox_enabled: true,
      interval_minutes: 60,
    };
    vi.mocked(buildWorkloadInventoryConfigUpdate).mockResolvedValueOnce(payload);
    const res = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>).configUpdate.workload_inventory_settings).toEqual(payload);
  });

  it('omits workload settings when its resolver fails, preserving the heartbeat', async () => {
    const { buildWorkloadInventoryConfigUpdate } = await import('./helpers');
    vi.mocked(buildWorkloadInventoryConfigUpdate).mockRejectedValueOnce(new Error('policy read failed'));
    const res = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>).configUpdate ?? {}).not.toHaveProperty('workload_inventory_settings');
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/services/workloads/configUpdate.test.ts src/services/workloads/settings.test.ts src/routes/agents/heartbeat.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/settings.integration.test.ts
```

Expected FAIL: `Failed to resolve import "./configUpdate"` / `"./settings"`; in `heartbeat.test.ts` the delivery test finds no `workload_inventory_settings`, the capability table reads `undefined` for `workloadInventoryProtocolVersion`. Three files collected in the first command.

- [ ] **Step 3: Implement the resolver** — create `apps/api/src/services/workloads/settings.ts`:

```ts
import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  WORKLOAD_INVENTORY_DEFAULTS,
  workloadInventoryInlineSettingsSchema,
  type WorkloadInventoryInlineSettings,
} from '@breeze/shared';
import { db } from '../../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyWorkloadInventorySettings,
  configurationPolicies,
  deviceGroupMemberships,
  devices,
  organizations,
} from '../../db/schema';
import { policyOwnershipCondition, withDevicePartnerPolicyVisibility } from '../configPolicyOwnership';
import { buildRoleOsFilterConditions, matchesRoleOsFilter } from '../featureConfigResolver';
import { getRedis } from '../redis';

export interface ResolvedWorkloadInventorySettings {
  orgId: string;
  settings: WorkloadInventoryInlineSettings;
}

export const WORKLOAD_INVENTORY_SETTINGS_CACHE_TTL_SECONDS = 120;

const levelPriority: Record<string, number> = {
  partner: 1,
  organization: 2,
  site: 3,
  device_group: 4,
  device: 5,
};

const cacheSchema = z
  .object({ orgId: z.string().uuid(), settings: workloadInventoryInlineSettingsSchema })
  .strict();

/**
 * Resolve the device's effective workload-inventory settings (uncached).
 * Same winner rules as every inline feature: highest assignment level, then
 * lowest priority number, then oldest assignment. No applicable policy yields
 * the defaults — enabled: false — so removing a policy turns enumeration off.
 *
 * Runs under BOTH the heartbeat's system context and an agent's org-scoped
 * ingest context. An org-scoped caller cannot see partner-wide policy rows
 * unless visibility is widened to the device's own partner; partnerId comes
 * from the org row read here under the caller's RLS context, never from input.
 */
export async function resolveDeviceWorkloadInventorySettings(
  deviceId: string,
): Promise<ResolvedWorkloadInventorySettings> {
  const [device] = await db
    .select({
      orgId: devices.orgId,
      siteId: devices.siteId,
      deviceRole: devices.deviceRole,
      osType: devices.osType,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) throw new Error('Workload inventory device not visible');
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);
  const groups = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const targets = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId)),
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId)),
  ];
  if (device.siteId) {
    targets.push(and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId)));
  }
  if (org?.partnerId) {
    targets.push(and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId)));
  }
  if (groups.length) {
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'device_group'),
        inArray(
          configPolicyAssignments.targetId,
          groups.map((group) => group.groupId),
        ),
      ),
    );
  }
  const rows = await withDevicePartnerPolicyVisibility(db, org?.partnerId ?? null, (executor) =>
    executor
      .select({
        level: configPolicyAssignments.level,
        assignmentPriority: configPolicyAssignments.priority,
        assignmentCreatedAt: configPolicyAssignments.createdAt,
        roleFilter: configPolicyAssignments.roleFilter,
        osFilter: configPolicyAssignments.osFilter,
        enabled: configPolicyWorkloadInventorySettings.enabled,
        dockerEnabled: configPolicyWorkloadInventorySettings.dockerEnabled,
        podmanEnabled: configPolicyWorkloadInventorySettings.podmanEnabled,
        hypervEnabled: configPolicyWorkloadInventorySettings.hypervEnabled,
        proxmoxEnabled: configPolicyWorkloadInventorySettings.proxmoxEnabled,
        intervalMinutes: configPolicyWorkloadInventorySettings.intervalMinutes,
      })
      .from(configPolicyAssignments)
      .innerJoin(configurationPolicies, eq(configPolicyAssignments.configPolicyId, configurationPolicies.id))
      .innerJoin(
        configPolicyEffectiveFeatureLinks,
        and(
          eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
          eq(configPolicyEffectiveFeatureLinks.featureType, 'workload_inventory'),
        ),
      )
      .innerJoin(
        configPolicyWorkloadInventorySettings,
        eq(configPolicyWorkloadInventorySettings.featureLinkId, configPolicyEffectiveFeatureLinks.id),
      )
      .where(
        and(
          eq(configurationPolicies.status, 'active'),
          policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null }),
          or(...targets),
          ...buildRoleOsFilterConditions({ deviceRole: device.deviceRole, osType: device.osType }),
        ),
      ),
  );
  const eligible = rows.filter((row) => matchesRoleOsFilter(row, device));
  eligible.sort(
    (a, b) =>
      (levelPriority[b.level] ?? 0) - (levelPriority[a.level] ?? 0) ||
      a.assignmentPriority - b.assignmentPriority ||
      // Same tie-break as resolveEffectiveConfig (services/configurationPolicy.ts).
      a.assignmentCreatedAt.getTime() - b.assignmentCreatedAt.getTime(),
  );
  const winner = eligible[0];
  if (!winner) return { orgId: device.orgId, settings: { ...WORKLOAD_INVENTORY_DEFAULTS } };
  return {
    orgId: device.orgId,
    settings: workloadInventoryInlineSettingsSchema.parse({
      enabled: winner.enabled,
      dockerEnabled: winner.dockerEnabled,
      podmanEnabled: winner.podmanEnabled,
      hypervEnabled: winner.hypervEnabled,
      proxmoxEnabled: winner.proxmoxEnabled,
      intervalMinutes: winner.intervalMinutes,
    }),
  };
}

/**
 * Cached resolver (Redis, 120 s) shared by heartbeat delivery and ingest, so
 * what the agent is told and what the server accepts cannot disagree for more
 * than one TTL. The cache entry is stamped with the device's org and ignored
 * when that no longer matches (device moved between orgs).
 */
export async function getDeviceWorkloadInventorySettings(
  deviceId: string,
): Promise<ResolvedWorkloadInventorySettings> {
  const [device] = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) throw new Error('Workload inventory device not visible');
  const redis = getRedis();
  const key = `workloads:settings:device:${deviceId}`;
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const cached = cacheSchema.parse(JSON.parse(raw));
        if (cached.orgId === device.orgId) return cached;
      }
    } catch (error) {
      console.warn('[workloads] settings cache read failed', error);
    }
  }
  const resolved = await resolveDeviceWorkloadInventorySettings(deviceId);
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(resolved), 'EX', WORKLOAD_INVENTORY_SETTINGS_CACHE_TTL_SECONDS);
    } catch (error) {
      console.warn('[workloads] settings cache write failed', error);
    }
  }
  return resolved;
}
```

- [ ] **Step 4: Implement the wire payload** — create `apps/api/src/services/workloads/configUpdate.ts`:

```ts
import type { WorkloadInventoryInlineSettings } from '@breeze/shared';
import { getDeviceWorkloadInventorySettings } from './settings';

/** Wire payload for `configUpdate.workload_inventory_settings` (spec §7.2). */
export interface WorkloadInventoryConfigUpdate {
  enabled: boolean;
  docker_enabled: boolean;
  podman_enabled: boolean;
  hyperv_enabled: boolean;
  proxmox_enabled: boolean;
  interval_minutes: number;
}

export function toWorkloadInventoryConfigUpdate(
  settings: WorkloadInventoryInlineSettings,
): WorkloadInventoryConfigUpdate {
  return {
    enabled: settings.enabled,
    docker_enabled: settings.dockerEnabled,
    podman_enabled: settings.podmanEnabled,
    hyperv_enabled: settings.hypervEnabled,
    proxmox_enabled: settings.proxmoxEnabled,
    interval_minutes: settings.intervalMinutes,
  };
}

/**
 * Resolves the device's effective settings into the agent wire payload.
 * Defaults (enabled: false) are returned when no policy applies. Throws on any
 * resolver error — the heartbeat omits the key rather than send defaults that
 * could switch a running collection off.
 */
export async function buildResolvedWorkloadInventoryConfigUpdate(
  deviceId: string,
): Promise<WorkloadInventoryConfigUpdate> {
  const { settings } = await getDeviceWorkloadInventorySettings(deviceId);
  return toWorkloadInventoryConfigUpdate(settings);
}
```

- [ ] **Step 5: Wire the heartbeat.**

`apps/api/src/routes/agents/helpers.ts` — next to the existing import of `buildResolvedTimeSyncConfigUpdate` (line 70) add:

```ts
import {
  buildResolvedWorkloadInventoryConfigUpdate,
  type WorkloadInventoryConfigUpdate,
} from '../../services/workloads/configUpdate';
```

and directly after `buildTimeSyncConfigUpdate` (line 2243-2246) add:

```ts
/**
 * Build workload_inventory_settings config update payload for heartbeat
 * response (workload inventory spec §7.2). Explicit defaults (enabled: false)
 * are sent when no policy is assigned, so removing a policy turns enumeration
 * off; a resolver error throws so the heartbeat omits the key and the agent
 * keeps its previous settings.
 */
export async function buildWorkloadInventoryConfigUpdate(
  deviceId: string,
): Promise<WorkloadInventoryConfigUpdate> {
  return buildResolvedWorkloadInventoryConfigUpdate(deviceId);
}
```

`apps/api/src/routes/agents/schemas.ts` — directly after `consentPromptProtocolVersion: z.number().int().optional().catch(undefined),` (line 377) add:

```ts
    // #3834 workload inventory capability. Same tolerant contract: a malformed
    // value drops this field alone rather than rejecting the beat.
    workloadInventoryProtocolVersion: z.number().int().optional().catch(undefined),
```

`apps/api/src/routes/agents/heartbeat.ts`:

1. Add `buildWorkloadInventoryConfigUpdate,` to the `./helpers` import directly after `buildTimeSyncConfigUpdate,` (line 42).
2. Directly after `normalizeConsentPromptProtocolVersion` (ends line ~299) add:

```ts
/**
 * Normalize the only workload-inventory protocol version implemented here
 * (#3834). Absent, malformed, or a future version this server does not speak
 * is 0; the device Workloads view then reports "agent too old" rather than
 * treating a report it cannot interpret as data.
 */
export function normalizeWorkloadInventoryProtocolVersion(value: unknown): 0 | 1 {
  return value === 1 ? 1 : 0;
}
```

3. In the `deviceUpdates` literal, directly after the `consentPromptProtocolVersion: normalizeConsentPromptProtocolVersion(…),` property (line 983-985) add:

```ts
    // Workload inventory capability (#3834), same non-sticky contract: an
    // agent that stops reporting it self-heals back to 0.
    workloadInventoryProtocolVersion: normalizeWorkloadInventoryProtocolVersion(
      data.securityCapabilities?.workloadInventoryProtocolVersion,
    ),
```

4. Policy-config block: in the `PolicyConfigUpdates` type add after `timeSyncSettings: …` (line 2237) the line `workloadInventorySettings: Awaited<ReturnType<typeof buildWorkloadInventoryConfigUpdate>> | null;`; in the `policyConfigs` initializer add `workloadInventorySettings: null,` after `timeSyncSettings: null,` (line 2246); inside the `withSystemDbAccessContext` callback add `let workloadInventorySettings: Awaited<ReturnType<typeof buildWorkloadInventoryConfigUpdate>> | null = null;` after the `let timeSyncSettings …` line (2256); add this block directly after the time-sync `try/catch` (ends line ~2335) and before `return {`:

```ts
      // Workload inventory (spec §7.2). Last, like time sync: a resolver error
      // here only ever omits the key (the agent keeps its last applied
      // settings); and an earlier resolver's SQL error that aborts the shared
      // transaction makes this throw too, which also only omits.
      try {
        workloadInventorySettings = await buildWorkloadInventoryConfigUpdate(scoped.deviceId);
      } catch (err) {
        console.error(`[agents] failed to build workload inventory config update for ${agentId}:`, err);
        captureException(err);
      }
```

then add `workloadInventorySettings,` after `timeSyncSettings,` in the callback's returned object (line ~2343) and in the destructuring below it (line ~2360), and after the `if (timeSyncSettings) { … }` block (ends line ~2372) add:

```ts
  if (workloadInventorySettings) {
    policyConfigUpdate.workload_inventory_settings = workloadInventorySettings;
  }
```

6. `apps/api/src/__tests__/parkedFanout.contract.test.ts` — `services/workloads/settings.ts` reads `devices` and so is discovered; classify it in `EXEMPT` directly after the `'services/timeSync/configUpdate.ts'` entry (line 302):

```ts
  'services/workloads/settings.ts': 'derived: resolves policy settings for a single deviceId supplied by already-authorized callers (the calling agent\'s heartbeat/ingest, the device view); selects no work',
```

- [ ] **Step 6: Run the suites**

```bash
cd apps/api && npx vitest run src/services/workloads/configUpdate.test.ts src/services/workloads/settings.test.ts src/routes/agents/heartbeat.test.ts src/__tests__/parkedFanout.contract.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/settings.integration.test.ts
```

Expected PASS. If `parkedFanout.contract.test.ts` reports `services/workloads/configUpdate.ts` as stale or unclassified, it does not read `devices` and must **not** be listed; only files it names as unclassified get an entry. If the integration test shows the partner-wide policy invisible to the org-scoped read, the visibility helper is not applied — check `withDevicePartnerPolicyVisibility` is wrapping the policy select.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/workloads/settings.ts apps/api/src/services/workloads/settings.test.ts apps/api/src/services/workloads/settings.integration.test.ts apps/api/src/services/workloads/configUpdate.ts apps/api/src/services/workloads/configUpdate.test.ts apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.test.ts apps/api/src/__tests__/parkedFanout.contract.test.ts
git commit -m "feat(workloads): resolve and deliver workload inventory settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ingest service and the agent `PUT /:id/workloads` route

**Files:**
- Create: `apps/api/src/services/workloads/testFixtures.ts`, `apps/api/src/services/workloads/ingest.ts`, `apps/api/src/services/workloads/ingest.integration.test.ts`, `apps/api/src/routes/agents/workloads.ts`, `apps/api/src/routes/agents/workloads.test.ts`, `apps/api/src/routes/agents/workloads.mounted.test.ts`
- Modify: `apps/api/src/services/inventoryChildSync.ts:84`, `apps/api/src/routes/agents/index.ts:19,88`, `apps/api/src/middleware/bodyLimit.ts:37,208`, `apps/api/src/middleware/bodyLimit.test.ts:250,366`, `apps/api/src/routes/agents/parkedRouteClassification.test.ts:69`, `apps/api/src/__tests__/writeRoutePermissionGate.contract.test.ts:139`, `apps/api/src/__tests__/parkedFanout.contract.test.ts:299`, `apps/api/src/services/mcpCoverage.ts:227`

**Interfaces:**
- Produces:

```ts
// services/inventoryChildSync.ts — now exported, parameter narrowed so a context-bound `db` qualifies
export function lockDeviceInventory(tx: Pick<DbTx, 'execute'>, table: string, deviceId: string): Promise<void>;
// services/workloads/ingest.ts
export interface IngestWorkloadsArgs { deviceId: string; orgId: string; report: WorkloadsReport; receivedAt: Date }
export interface IngestWorkloadsResult { accepted: true; runtimes: Array<{ runtime: WorkloadRuntime; applied: boolean }> }
export function ingestWorkloadsReport(args: IngestWorkloadsArgs): Promise<IngestWorkloadsResult>;
// routes/agents/workloads.ts
export const workloadsRoutes: Hono; // PUT /:id/workloads
```

- Consumes: `planWorkloadSync` (Task 3), `getDeviceWorkloadInventorySettings` + `isWorkloadRuntimeEnabled` (Tasks 1, 5), `withDbTransaction` (`db/index.ts:1034`; rebinds the ambient `db` to a savepoint, so the resolver and the writes share one executor), `requireAgentRole` (`middleware/requireAgentRole`), `zValidator` (`lib/validation`), the `timeStatus.ts` route as the structural template.
- Response: `200 { accepted: true, runtimes: [{ runtime, applied }] }`; `400` schema (duplicate runtime/workloadId, bad kind, unknown key); `403` path id ≠ authenticated agent / watchdog or helper token; `404` device not found; `413` over 2 MiB. A skipped (stale) runtime is `applied: false` inside a 200 — a replay is not an error.
- Order inside ingest (the settings resolver runs **before** any lock or write, so a resolver failure rejects with nothing written): settings → advisory lock → device row lock (`FOR NO KEY UPDATE`, same order as the device-deletion cascade: device first) → load stored → plan → deletes → upserts → host-axis update.

- [ ] **Step 1: Write the failing tests.**

(a) Fixtures — create `apps/api/src/services/workloads/testFixtures.ts` (raw, pre-parse report objects, so tests exercise the real schema):

```ts
export const FIXTURE_AGENT_VERSION = '1.0.0';

export function workloadFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'container',
    workloadId: 'c'.repeat(64),
    name: 'web',
    state: 'running',
    rawState: 'running',
    imageRef: 'nginx:1.27',
    imageRepository: 'docker.io/library/nginx',
    imageTag: '1.27',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    imageId: `sha256:${'b'.repeat(64)}`,
    composeProject: 'shop',
    composeService: 'web',
    ...over,
  };
}

export function runtimeFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  const workloads = (over.workloads as unknown[] | undefined) ?? [workloadFixture()];
  return {
    runtime: 'docker',
    detection: 'present',
    collection: 'ok',
    complete: true,
    runtimeVersion: '27.1.1',
    observedCount: workloads.length,
    error: null,
    workloads,
    ...over,
  };
}

export function reportFixture(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    collectedAt: '2026-10-06T12:00:00.000Z',
    runtimes: [runtimeFixture()],
    ...over,
  };
}
```

(b) Route unit test — create `apps/api/src/routes/agents/workloads.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({ ingest: vi.fn(), rows: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }),
  },
}));
vi.mock('../../services/workloads/ingest', () => ({ ingestWorkloadsReport: m.ingest }));

import { workloadsRoutes } from './workloads';
import { reportFixture, runtimeFixture, workloadFixture } from '../../services/workloads/testFixtures';

const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';

function request(body: unknown = reportFixture(), role = 'agent', path = 'agent-1') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (role === 'missing') return c.json({ error: 'Unauthorized' }, 401);
    c.set('agent', { role, deviceId, orgId, agentId: 'agent-1' } as any);
    await next();
  });
  app.route('/', workloadsRoutes);
  return app.request(`/${path}/workloads`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  m.rows = [{ id: deviceId }];
  m.ingest.mockReset().mockResolvedValue({ accepted: true, runtimes: [{ runtime: 'docker', applied: true }] });
});

it('ingests with the authenticated ids and returns the per-runtime applied flags', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, runtimes: [{ runtime: 'docker', applied: true }] });
  expect(m.ingest).toHaveBeenCalledWith({
    deviceId,
    orgId,
    report: expect.objectContaining({ protocolVersion: 1 }),
    receivedAt: expect.any(Date),
  });
  // the service receives the parsed (null-normalized) report, not the raw body
  const parsed = m.ingest.mock.calls[0]![0].report;
  expect(parsed.runtimes[0].workloads[0].guestOs).toBeNull();
});

it.each([
  ['missing', 401],
  ['watchdog', 403],
  ['helper', 403],
])('rejects %s credentials', async (role, status) => {
  expect((await request(reportFixture(), role)).status).toBe(status);
  expect(m.ingest).not.toHaveBeenCalled();
});

it('rejects a path id that is not the authenticated agent before ingesting', async () => {
  expect((await request(reportFixture(), 'agent', 'agent-2')).status).toBe(403);
  expect(m.ingest).not.toHaveBeenCalled();
});

it.each([
  ['a duplicate workloadId within a runtime', reportFixture({ runtimes: [runtimeFixture({ workloads: [workloadFixture(), workloadFixture()] })] })],
  ['a duplicate runtime entry', reportFixture({ runtimes: [runtimeFixture(), runtimeFixture()] })],
  ['a kind that does not fit the runtime', reportFixture({ runtimes: [runtimeFixture({ runtime: 'hyperv' })] })],
  ['any workload under containerd', reportFixture({ runtimes: [runtimeFixture({ runtime: 'containerd' })] })],
  ['an unknown key', reportFixture({ extra: true })],
  ['a forbidden field', reportFixture({ runtimes: [runtimeFixture({ workloads: [workloadFixture({ env: ['A=B'] })] })] })],
  ['a negative observedCount', reportFixture({ runtimes: [runtimeFixture({ observedCount: -1 })] })],
])('returns 400, not a database error, for %s', async (_name, body) => {
  expect((await request(body)).status).toBe(400);
  expect(m.ingest).not.toHaveBeenCalled();
});

it('returns 404 for a device that is not visible and 500 for a service failure', async () => {
  m.rows = [];
  expect((await request()).status).toBe(404);
  m.rows = [{ id: deviceId }];
  m.ingest.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
  expect(m.ingest).toHaveBeenCalledTimes(1);
});

it('returns 200 with applied: false for a replayed runtime (not an error)', async () => {
  m.ingest.mockResolvedValue({ accepted: true, runtimes: [{ runtime: 'docker', applied: false }] });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, runtimes: [{ runtime: 'docker', applied: false }] });
});

it('caps the standalone route body at 2 MiB', async () => {
  expect((await request({ ...reportFixture(), padding: 'x'.repeat(2 * 1024 * 1024) })).status).toBe(413);
  expect(m.ingest).not.toHaveBeenCalled();
});
```

(c) Global-gate boundary test — create `apps/api/src/routes/agents/workloads.mounted.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: '11111111-1111-4111-8111-111111111111' }] }) }) }),
  },
}));
vi.mock('../../services/workloads/ingest', () => ({ ingestWorkloadsReport: m.ingest }));

import { workloadsRoutes } from './workloads';
import { createGlobalBodyLimitMiddleware } from '../../middleware/bodyLimitGate';
import { reportFixture } from '../../services/workloads/testFixtures';

const app = new Hono();
app.use('*', createGlobalBodyLimitMiddleware({ warn: () => {}, capture: () => {} }));
app.use('*', async (c, next) => {
  c.set('agent', {
    role: 'agent',
    agentId: 'agent-1',
    deviceId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
  } as any);
  await next();
});
app.route('/api/v1/agents', workloadsRoutes);

beforeEach(() => {
  m.ingest.mockReset().mockResolvedValue({ accepted: true, runtimes: [] });
});

function request(body: string, contentLength: boolean) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (contentLength) headers['content-length'] = String(Buffer.byteLength(body));
  return app.request('/api/v1/agents/agent-1/workloads', { method: 'PUT', headers, body });
}

it.each([false, true])('accepts exactly 2 MiB and rejects one byte over; Content-Length %s', async (length) => {
  const raw = JSON.stringify(reportFixture());
  const exact = raw + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(raw));
  expect((await request(exact, length)).status).toBe(200);
  expect(m.ingest).toHaveBeenCalledOnce();
  m.ingest.mockClear();
  expect((await request(exact + ' ', length)).status).toBe(413);
  expect(m.ingest).not.toHaveBeenCalled();
});
```

(d) Registries and gate (red until Step 5): in `apps/api/src/middleware/bodyLimit.test.ts` add `'agent-workloads': '/api/v1/agents/agent-1/workloads',` to the `sampled` record directly after the `'agent-time-status'` entry (line 251); add after the hardware-health 2 MiB test:

```ts
  it('allows exactly 2 MiB on workloads without widening sibling paths', () => {
    expect(bodyLimitForPath('/api/v1/agents/agent-1/workloads')).toEqual({
      rule: 'agent-workloads',
      maxSize: 2 * 1024 * 1024,
      error: 'Request body too large',
    });
    for (const suffix of ['workloads/extra', 'workloads-extra', 'warranty-info']) {
      expect(bodyLimitForPath(`/api/v1/agents/agent-1/${suffix}`).maxSize).toBe(1024 * 1024);
    }
  });
```

and add a route-registry entry after `'agents/timeStatus.ts': { … },` (line 366-370):

```ts
  'agents/workloads.ts': {
    paths: ['/api/v1/agents/agent-1/workloads'],
    globalMaxSize: 2 * MB,
    note: 'carved out — 2MB workload inventory report (#3834); route and gate agree at 2MB.',
  },
```

In `apps/api/src/routes/agents/parkedRouteClassification.test.ts` add after `'PUT /:id/time-status': 'deny',` (line 69): `'PUT /:id/workloads': 'deny',`.

In `apps/api/src/__tests__/writeRoutePermissionGate.contract.test.ts` add after the `'POST /api/v1/agents/:id/uninstall-intent'` entry (line 139):

```ts
  // routes/agents/workloads.ts
  'PUT /api/v1/agents/:id/workloads': 'device credential: agentAuthMiddleware (agent bearer token), device-scoped',
```

In `apps/api/src/services/mcpCoverage.ts` add after `'agents/wingetBootstrap.ts': { exempt: 'agent_transport' },` (line 227): `'agents/workloads.ts': { exempt: 'agent_transport' },`.

(e) Real-Postgres ingest test — create `apps/api/src/services/workloads/ingest.integration.test.ts`:

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { workloadsReportSchema } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceWorkloadRuntimes, deviceWorkloads } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { ingestWorkloadsReport } from './ingest';
import { reportFixture, runtimeFixture, workloadFixture } from './testFixtures';

// Settings changes in these tests must take effect immediately.
vi.mock('../redis', () => ({ getRedis: () => null }));

const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };
// Relative to real time: the ordering guard clamps a future collectedAt to receipt time.
const BASE = Date.now() - 3 * 3_600_000;
const at = (minute: number) => new Date(BASE + minute * 60_000).toISOString();
const wl = (id: string, over: Record<string, unknown> = {}) => workloadFixture({ workloadId: id, name: id, ...over });

async function fixture(opts: { enabled?: boolean } = {}) {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const other = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'workload-ingest',
      osType: 'linux',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  const [policy] = await getTestDb().execute(
    sql`INSERT INTO configuration_policies(partner_id, name) VALUES (${partner.id}, ${'Workloads ' + randomUUID()}) RETURNING id`,
  );
  const [link] = await getTestDb().execute(
    sql`INSERT INTO config_policy_feature_links(config_policy_id, feature_type) VALUES (${String(policy!.id)}, 'workload_inventory') RETURNING id`,
  );
  const linkId = String(link!.id);
  await withDbAccessContext(system, () =>
    db.execute(sql`INSERT INTO config_policy_workload_inventory_settings(feature_link_id, enabled) VALUES (${linkId}, ${opts.enabled ?? true})`),
  );
  await getTestDb().execute(
    sql`INSERT INTO config_policy_assignments(config_policy_id, level, target_id) VALUES (${String(policy!.id)}, 'partner'::config_assignment_level, ${partner.id})`,
  );
  const ctx: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const send = (report: Record<string, unknown>, orgId = org.id, context = ctx) =>
    withDbAccessContext(context, () =>
      ingestWorkloadsReport({
        deviceId: device!.id,
        orgId,
        report: workloadsReportSchema.parse(report),
        receivedAt: new Date(),
      }),
    );
  const setEnabled = (enabled: boolean) =>
    withDbAccessContext(system, () =>
      db.execute(sql`UPDATE config_policy_workload_inventory_settings SET enabled = ${enabled} WHERE feature_link_id = ${linkId}`),
    );
  const workloads = () => getTestDb().select().from(deviceWorkloads).where(eq(deviceWorkloads.deviceId, device!.id));
  const runtimes = () => getTestDb().select().from(deviceWorkloadRuntimes).where(eq(deviceWorkloadRuntimes.deviceId, device!.id));
  const host = async () => {
    const [row] = await getTestDb().select({ hostsWorkloads: devices.hostsWorkloads, workloadRuntimes: devices.workloadRuntimes }).from(devices).where(eq(devices.id, device!.id));
    return row!;
  };
  return { org, other, device: device!, ctx, send, setEnabled, workloads, runtimes, host };
}

it('creates the runtime row, the workload rows and the host axis from a first report', async () => {
  const f = await fixture();
  const result = await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  expect(result).toEqual({ accepted: true, runtimes: [{ runtime: 'docker', applied: true }] });
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['a', 'b']);
  expect(await f.runtimes()).toMatchObject([
    { runtime: 'docker', detection: 'present', collection: 'ok', complete: true, runtimeVersion: '27.1.1', observedCount: 2, reportedCount: 2 },
  ]);
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
});

it('keeps row ids and first_seen_at stable across later reports and advances last_seen_at', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  const [before] = await f.workloads();
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('a', { state: 'stopped' })] })] }));
  const [after] = await f.workloads();
  expect(after!.id).toBe(before!.id);
  expect(after!.firstSeenAt.getTime()).toBe(before!.firstSeenAt.getTime());
  expect(after!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before!.lastSeenAt.getTime());
  expect(after!.state).toBe('stopped');
});

it('replaces the set on an ok and complete report: inserts new, deletes vanished', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b'), wl('c')] })] }));
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('b'), wl('c'), wl('d')] })] }));
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['b', 'c', 'd']);
});

it('ignores a replayed or reordered report (older and equal collectedAt)', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(10), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  const older = await f.send(reportFixture({ collectedAt: at(5), runtimes: [runtimeFixture({ workloads: [wl('c')] })] }));
  const equal = await f.send(reportFixture({ collectedAt: at(10), runtimes: [runtimeFixture({ workloads: [wl('c')] })] }));
  expect(older.runtimes).toEqual([{ runtime: 'docker', applied: false }]);
  expect(equal.runtimes).toEqual([{ runtime: 'docker', applied: false }]);
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['a', 'b']);
});

it('a failing driver leaves rows and last_success_at alone', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  const [ok] = await f.runtimes();
  await f.send(
    reportFixture({
      collectedAt: at(1),
      runtimes: [runtimeFixture({ collection: 'error', complete: false, error: 'socket busy', workloads: [], observedCount: 0 })],
    }),
  );
  expect((await f.workloads()).map((w) => w.workloadId)).toEqual(['a']);
  const [failed] = await f.runtimes();
  expect(failed).toMatchObject({ collection: 'error', lastError: 'socket busy', complete: false });
  expect(failed!.lastSuccessAt!.getTime()).toBe(ok!.lastSuccessAt!.getTime());
});

it('a policy-disabled report deletes rows and keeps the host axis', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  await f.setEnabled(false);
  const result = await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  expect(result.runtimes).toEqual([{ runtime: 'docker', applied: true }]);
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.runtimes()).toMatchObject([{ collection: 'disabled', detection: 'present', reportedCount: 0 }]);
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
});

it('with no policy at all, enumeration is disabled (default off) but detection still sets the host axis', async () => {
  const f = await fixture({ enabled: false });
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
});

it('detection absent keeps the runtime row as absent, deletes its workloads and drops the host axis; a replayed older present report is then skipped', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  await f.send(
    reportFixture({
      collectedAt: at(10),
      runtimes: [runtimeFixture({ detection: 'absent', collection: 'unavailable', complete: false, workloads: [], observedCount: 0 })],
    }),
  );
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.runtimes()).toMatchObject([{ runtime: 'docker', detection: 'absent', collection: 'unavailable' }]);
  expect(await f.host()).toEqual({ hostsWorkloads: false, workloadRuntimes: [] });
  const replay = await f.send(reportFixture({ collectedAt: at(5), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  expect(replay.runtimes).toEqual([{ runtime: 'docker', applied: false }]);
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.host()).toEqual({ hostsWorkloads: false, workloadRuntimes: [] });
});

it('a future-dated collectedAt does not block a later normal report', async () => {
  const f = await fixture();
  const future = new Date(Date.now() + 48 * 3_600_000).toISOString();
  await f.send(reportFixture({ collectedAt: future, runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  // A normal report stamped at its own send time: clamped to its (later) receipt time, so it is newer than the
  // first report's clamped time only if the clamp worked (an unclamped +48 h stored time would skip it).
  await new Promise((resolve) => setTimeout(resolve, 20));
  const later = await f.send(reportFixture({ collectedAt: new Date().toISOString(), runtimes: [runtimeFixture({ workloads: [wl('b')] })] }));
  expect(later.runtimes).toEqual([{ runtime: 'docker', applied: true }]);
  expect((await f.workloads()).map((w) => w.workloadId)).toEqual(['b']);
});

it('detection unknown keeps the host-axis membership and the workload rows', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  await f.send(
    reportFixture({
      collectedAt: at(1),
      runtimes: [runtimeFixture({ detection: 'unknown', collection: 'error', complete: false, error: 'busy', workloads: [], observedCount: 0 })],
    }),
  );
  expect(await f.host()).toEqual({ hostsWorkloads: true, workloadRuntimes: ['docker'] });
  expect(await f.workloads()).toHaveLength(1);
  expect(await f.runtimes()).toMatchObject([{ detection: 'unknown', collection: 'error' }]);
});

it('leaves a runtime the report does not mention untouched', async () => {
  const f = await fixture();
  await f.send(
    reportFixture({
      collectedAt: at(0),
      runtimes: [runtimeFixture({ workloads: [wl('a')] }), runtimeFixture({ runtime: 'hyperv', workloads: [wl('vm1', { kind: 'vm' })] })],
    }),
  );
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }));
  expect((await f.workloads()).map((w) => `${w.runtime}:${w.workloadId}`).sort()).toEqual(['docker:a', 'hyperv:vm1']);
  expect((await f.host()).workloadRuntimes).toEqual(['docker', 'hyperv']);
});

it('a truncated report ages out stale rows and never deletes by absence', async () => {
  const f = await fixture();
  await f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a'), wl('b')] })] }));
  await getTestDb().execute(
    sql`UPDATE device_workloads SET last_seen_at = now() - interval '25 hours' WHERE device_id = ${f.device.id} AND workload_id = 'b'`,
  );
  await f.send(reportFixture({ collectedAt: at(1), runtimes: [runtimeFixture({ complete: false, observedCount: 9, workloads: [wl('c')] })] }));
  expect((await f.workloads()).map((w) => w.workloadId).sort()).toEqual(['a', 'c']);
});

it('serializes concurrent identical reports: exactly one is applied', async () => {
  const f = await fixture();
  const report = reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] });
  const results = await Promise.all([f.send(report), f.send(report)]);
  expect(results.map((r) => r.runtimes[0]!.applied).sort()).toEqual([false, true]);
  expect(await f.workloads()).toHaveLength(1);
});

it('writes nothing when the caller cannot see the device (resolver and ownership checks fail closed)', async () => {
  const f = await fixture();
  const foreign: DbAccessContext = {
    scope: 'organization',
    orgId: f.other.id,
    accessibleOrgIds: [f.other.id],
    accessiblePartnerIds: [],
  };
  await expect(
    f.send(reportFixture({ collectedAt: at(0), runtimes: [runtimeFixture({ workloads: [wl('a')] })] }), f.other.id, foreign),
  ).rejects.toThrow();
  expect(await f.workloads()).toHaveLength(0);
  expect(await f.runtimes()).toHaveLength(0);
  expect(await f.host()).toEqual({ hostsWorkloads: false, workloadRuntimes: [] });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/agents/workloads.test.ts src/routes/agents/workloads.mounted.test.ts src/middleware/bodyLimit.test.ts src/routes/agents/parkedRouteClassification.test.ts src/__tests__/mcp-coverage.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/ingest.integration.test.ts
```

Expected FAIL: `Failed to resolve import "./workloads"` / `"./ingest"`; `bodyLimit.test.ts` — `agent-workloads` rule missing (falls back to `agent-ingest` 5 MB / default); `parkedRouteClassification.test.ts` — `PUT /:id/workloads` listed in EXPECTED but not a registered route (stale entry); `mcp-coverage.test.ts` — "entries for files that do not exist" for `agents/workloads.ts`.

- [ ] **Step 3: Export the lock.** In `apps/api/src/services/inventoryChildSync.ts` replace line 84

```ts
async function lockDeviceInventory(tx: DbTx, table: string, deviceId: string) {
```

with

```ts
export async function lockDeviceInventory(tx: Pick<DbTx, 'execute'>, table: string, deviceId: string) {
```

(only `execute` is used, so a context-bound `db` — which is what `withDbTransaction` rebinds — is a valid argument; every existing call site passes a full `DbTx` and is unaffected).

- [ ] **Step 4: Implement ingest** — create `apps/api/src/services/workloads/ingest.ts`:

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  isWorkloadRuntimeEnabled,
  type WorkloadReportItem,
  type WorkloadRuntime,
  type WorkloadsReport,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { deviceWorkloadRuntimes, deviceWorkloads, devices } from '../../db/schema';
import { lockDeviceInventory } from '../inventoryChildSync';
import { planWorkloadSync, type WorkloadRuntimePlan } from './plan';
import { getDeviceWorkloadInventorySettings } from './settings';

export interface IngestWorkloadsArgs {
  deviceId: string;
  orgId: string;
  report: WorkloadsReport;
  receivedAt: Date;
}

export interface IngestWorkloadsResult {
  accepted: true;
  runtimes: Array<{ runtime: WorkloadRuntime; applied: boolean }>;
}

/** Rows per INSERT … ON CONFLICT statement (≈25 parameters each, well under the driver cap). */
const UPSERT_CHUNK = 200;

const toDate = (value: string | null): Date | null => (value ? new Date(value) : null);

function toWorkloadRow(args: IngestWorkloadsArgs, runtime: WorkloadRuntime, item: WorkloadReportItem) {
  return {
    deviceId: args.deviceId,
    orgId: args.orgId,
    // Only enumerated runtimes ever reach here (the planner emits no upserts for containerd).
    runtime: runtime as 'docker' | 'podman' | 'hyperv' | 'proxmox',
    kind: item.kind,
    workloadId: item.workloadId,
    name: item.name,
    state: item.state,
    rawState: item.rawState,
    imageRef: item.imageRef,
    imageRepository: item.imageRepository,
    imageTag: item.imageTag,
    imageDigest: item.imageDigest,
    imageId: item.imageId,
    guestOs: item.guestOs,
    composeProject: item.composeProject,
    composeService: item.composeService,
    composeWorkingDir: item.composeWorkingDir,
    restartPolicy: item.restartPolicy,
    cpuCount: item.cpuCount,
    memoryMb: item.memoryMb,
    startedAt: toDate(item.startedAt),
    runtimeCreatedAt: toDate(item.runtimeCreatedAt),
    firstSeenAt: args.receivedAt,
    lastSeenAt: args.receivedAt,
    updatedAt: args.receivedAt,
  };
}

async function applyRuntimePlan(args: IngestWorkloadsArgs, plan: WorkloadRuntimePlan) {
  // Deletes first so the (device_id, runtime, workload_id) unique key is trivially satisfied.
  // The runtime row is never deleted: an absent runtime is upserted as `absent`.
  if (plan.workloads.deleteIds.length > 0) {
    await db
      .delete(deviceWorkloads)
      .where(and(eq(deviceWorkloads.deviceId, args.deviceId), inArray(deviceWorkloads.id, plan.workloads.deleteIds)));
  }
  if (plan.runtimeRow) {
    const row = plan.runtimeRow;
    await db
      .insert(deviceWorkloadRuntimes)
      .values({
        deviceId: args.deviceId,
        orgId: args.orgId,
        runtime: row.runtime,
        detection: row.detection,
        collection: row.collection,
        complete: row.complete,
        runtimeVersion: row.runtimeVersion,
        observedCount: row.observedCount,
        reportedCount: row.reportedCount,
        lastError: row.lastError,
        collectedAt: row.collectedAt,
        lastAttemptAt: row.lastAttemptAt,
        lastSuccessAt: row.lastSuccessAt,
        updatedAt: args.receivedAt,
      })
      .onConflictDoUpdate({
        target: [deviceWorkloadRuntimes.deviceId, deviceWorkloadRuntimes.runtime],
        set: {
          detection: sql`excluded.detection`,
          collection: sql`excluded.collection`,
          complete: sql`excluded.complete`,
          runtimeVersion: sql`excluded.runtime_version`,
          observedCount: sql`excluded.observed_count`,
          reportedCount: sql`excluded.reported_count`,
          lastError: sql`excluded.last_error`,
          collectedAt: sql`excluded.collected_at`,
          lastAttemptAt: sql`excluded.last_attempt_at`,
          // Only an ok collection advances last_success_at; null = keep the stored value.
          lastSuccessAt: sql`COALESCE(excluded.last_success_at, ${deviceWorkloadRuntimes.lastSuccessAt})`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  const upserts = [...plan.workloads.updates.map((update) => update.row), ...plan.workloads.inserts];
  for (let offset = 0; offset < upserts.length; offset += UPSERT_CHUNK) {
    await db
      .insert(deviceWorkloads)
      .values(upserts.slice(offset, offset + UPSERT_CHUNK).map((item) => toWorkloadRow(args, plan.runtime, item)))
      .onConflictDoUpdate({
        // The unique key keeps ids and first_seen_at stable: neither is in `set`.
        target: [deviceWorkloads.deviceId, deviceWorkloads.runtime, deviceWorkloads.workloadId],
        set: {
          kind: sql`excluded.kind`,
          name: sql`excluded.name`,
          state: sql`excluded.state`,
          rawState: sql`excluded.raw_state`,
          imageRef: sql`excluded.image_ref`,
          imageRepository: sql`excluded.image_repository`,
          imageTag: sql`excluded.image_tag`,
          imageDigest: sql`excluded.image_digest`,
          imageId: sql`excluded.image_id`,
          guestOs: sql`excluded.guest_os`,
          composeProject: sql`excluded.compose_project`,
          composeService: sql`excluded.compose_service`,
          composeWorkingDir: sql`excluded.compose_working_dir`,
          restartPolicy: sql`excluded.restart_policy`,
          cpuCount: sql`excluded.cpu_count`,
          memoryMb: sql`excluded.memory_mb`,
          startedAt: sql`excluded.started_at`,
          runtimeCreatedAt: sql`excluded.runtime_created_at`,
          lastSeenAt: sql`excluded.last_seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
}

/**
 * Apply one agent workloads report (spec §6.2) in a single transaction.
 *
 * The effective policy is resolved BEFORE any lock or write: a resolver
 * failure rejects with nothing written, never "disabled" (which would delete
 * rows). All write decisions come from planWorkloadSync.
 */
export async function ingestWorkloadsReport(args: IngestWorkloadsArgs): Promise<IngestWorkloadsResult> {
  const { settings } = await getDeviceWorkloadInventorySettings(args.deviceId);
  return withDbTransaction(async () => {
    await lockDeviceInventory(db, 'device_workloads', args.deviceId);
    // Device row first, matching the device-deletion cascade's lock order.
    const [device] = await db
      .select({ id: devices.id, hostsWorkloads: devices.hostsWorkloads, workloadRuntimes: devices.workloadRuntimes })
      .from(devices)
      .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId)))
      .for('no key update');
    if (!device) throw new Error('Workload inventory device missing or ownership changed');

    const reported = args.report.runtimes.map((entry) => entry.runtime);
    const storedRuntimes = reported.length
      ? await db
          .select({ runtime: deviceWorkloadRuntimes.runtime, collectedAt: deviceWorkloadRuntimes.collectedAt })
          .from(deviceWorkloadRuntimes)
          .where(and(eq(deviceWorkloadRuntimes.deviceId, args.deviceId), inArray(deviceWorkloadRuntimes.runtime, reported)))
      : [];
    // containerd is detect-only: it never has workload rows, so it is not queried.
    const enumerated = reported.filter(
      (runtime): runtime is 'docker' | 'podman' | 'hyperv' | 'proxmox' => runtime !== 'containerd',
    );
    const storedWorkloads = enumerated.length
      ? await db
          .select({
            id: deviceWorkloads.id,
            runtime: deviceWorkloads.runtime,
            workloadId: deviceWorkloads.workloadId,
            lastSeenAt: deviceWorkloads.lastSeenAt,
          })
          .from(deviceWorkloads)
          .where(and(eq(deviceWorkloads.deviceId, args.deviceId), inArray(deviceWorkloads.runtime, enumerated)))
      : [];

    const plan = planWorkloadSync({
      now: args.receivedAt,
      collectedAt: new Date(args.report.collectedAt), // the planner clamps to min(collectedAt, receivedAt)
      runtimes: args.report.runtimes,
      storedRuntimes,
      storedWorkloads,
      isEnabled: (runtime) => isWorkloadRuntimeEnabled(settings, runtime),
      previousHostRuntimes: device.workloadRuntimes,
      previousHostsWorkloads: device.hostsWorkloads,
    });

    for (const runtimePlan of plan.runtimes) {
      if (runtimePlan.applied) await applyRuntimePlan(args, runtimePlan);
    }
    if (plan.host.changed) {
      await db
        .update(devices)
        .set({ hostsWorkloads: plan.host.hostsWorkloads, workloadRuntimes: plan.host.workloadRuntimes })
        .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId)));
    }
    return {
      accepted: true as const,
      runtimes: plan.runtimes.map(({ runtime, applied }) => ({ runtime, applied })),
    };
  });
}
```

Note for the executor: `devices.workloadRuntimes` is typed `string[]` and `storedWorkloads` rows carry the narrower enumerated-runtime union, which is assignable to the planner's `StoredWorkload[]`. If TS still objects, adapt at this call site with a `.map`, never by loosening the planner's types.

- [ ] **Step 5: Implement the route** — create `apps/api/src/routes/agents/workloads.ts`:

```ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { WORKLOADS_REPORT_MAX_BYTES, workloadsReportSchema } from '@breeze/shared';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { ingestWorkloadsReport } from '../../services/workloads/ingest';

export const workloadsRoutes = new Hono();
workloadsRoutes.use('*', requireAgentRole);
workloadsRoutes.put(
  '/:id/workloads',
  bodyLimit({
    maxSize: WORKLOADS_REPORT_MAX_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  zValidator('json', workloadsReportSchema),
  async (c) => {
    const agent = c.get('agent');
    if (c.req.param('id') !== agent.agentId) return c.json({ error: 'Agent identity mismatch' }, 403);
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, agent.deviceId), eq(devices.orgId, agent.orgId)))
      .limit(1);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    const result = await ingestWorkloadsReport({
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      report: c.req.valid('json'),
      receivedAt: new Date(),
    });
    return c.json(result);
  },
);
```

- [ ] **Step 6: Mount, gate and register.**

`apps/api/src/routes/agents/index.ts` — add `import { workloadsRoutes } from './workloads';` after `import { timeStatusRoutes } from './timeStatus';` (line 19) and `agentRoutes.route('/', workloadsRoutes);` after `agentRoutes.route('/', timeStatusRoutes);` (line 88).

`apps/api/src/middleware/bodyLimit.ts` — add `| 'agent-workloads'` to the rule union after `| 'agent-time-status'` (line 37) and this branch directly after the time-status branch (ends line ~214):

```ts
  // Workload inventory report (#3834): bounded at 2 MiB by the schema caps
  // (max 1000 workloads per runtime, max 5 runtimes) and the route's own gate.
  // Matched before the broader agent-ingest branch so it keeps its own label.
  if (path.match(/^\/api\/v1\/agents\/[^/]+\/workloads$/)) {
    return {
      rule: 'agent-workloads',
      maxSize: 2 * 1024 * 1024,
      error: 'Request body too large',
    };
  }
```

`apps/api/src/__tests__/parkedFanout.contract.test.ts` — `ingest.ts` reads `devices`; add to `EXEMPT` after the `'services/workloads/settings.ts'` entry (Task 5):

```ts
  'services/workloads/ingest.ts': 'agent self-service: ownership-checks device.id+orgId; mounted only under the agent\'s own workloads route',
```

- [ ] **Step 7: Run everything this task touches**

```bash
cd apps/api && npx vitest run src/routes/agents/workloads.test.ts src/routes/agents/workloads.mounted.test.ts src/middleware/bodyLimit.test.ts src/routes/agents/parkedRouteClassification.test.ts src/__tests__/writeRoutePermissionGate.contract.test.ts src/__tests__/parkedFanout.contract.test.ts src/__tests__/mcp-coverage.test.ts src/services/inventoryChildSync.test.ts src/routes/agents/inventory.test.ts src/routes/agents/timeStatus.mounted.test.ts src/routes/agents/hardwareHealth.mounted.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/ingest.integration.test.ts
```

Expected PASS. If `timeStatus.mounted.test.ts` / `hardwareHealth.mounted.test.ts` fail on the new `workloadsRoutes` import (they mount the real `agentRoutes`), add `vi.mock('./workloads', async () => ({ workloadsRoutes: new (await import('hono')).Hono() }));` beside their other sibling-router mocks. If `parkedFanout` names an unclassified file other than `ingest.ts`, add exactly that file with a reason; if it names a stale entry, remove it.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/workloads/testFixtures.ts apps/api/src/services/workloads/ingest.ts apps/api/src/services/workloads/ingest.integration.test.ts apps/api/src/services/inventoryChildSync.ts apps/api/src/routes/agents/workloads.ts apps/api/src/routes/agents/workloads.test.ts apps/api/src/routes/agents/workloads.mounted.test.ts apps/api/src/routes/agents/index.ts apps/api/src/middleware/bodyLimit.ts apps/api/src/middleware/bodyLimit.test.ts apps/api/src/routes/agents/parkedRouteClassification.test.ts apps/api/src/__tests__/writeRoutePermissionGate.contract.test.ts apps/api/src/__tests__/parkedFanout.contract.test.ts apps/api/src/services/mcpCoverage.ts
git commit -m "feat(workloads): ingest agent workload reports transactionally" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```


### Task 7: `GET /api/v1/devices/:id/workloads` read route

**Files:**
- Create: `apps/api/src/services/workloads/view.ts`, `view.test.ts`, `view.integration.test.ts` (under `apps/api/src/services/workloads/`), `apps/api/src/routes/devices/workloads.ts`, `apps/api/src/routes/devices/workloads.test.ts`
- Modify: `apps/api/src/routes/devices/index.ts:18,164`, `apps/api/src/services/mcpCoverage.ts:408`, `apps/api/src/__tests__/parkedFanout.contract.test.ts:299`

**Interfaces:**
- Produces:

```ts
// services/workloads/view.ts
export interface DeviceWorkloadRuntimeView {
  runtime: WorkloadRuntime; detection: WorkloadDetection; collection: WorkloadCollection; complete: boolean;
  runtimeVersion: string | null; observedCount: number | null; reportedCount: number | null; lastError: string | null;
  collectedAt: string; lastAttemptAt: string; lastSuccessAt: string | null;   // ISO-8601 UTC
}
export interface DeviceWorkloadView {
  id: string; runtime: WorkloadRuntime; kind: WorkloadKind; workloadId: string; name: string; state: WorkloadState;
  rawState: string | null; imageRef: string | null; imageRepository: string | null; imageTag: string | null;
  imageDigest: string | null; imageId: string | null; guestOs: string | null; composeProject: string | null;
  composeService: string | null; composeWorkingDir: string | null; restartPolicy: string | null;
  cpuCount: number | null; memoryMb: number | null; startedAt: string | null; runtimeCreatedAt: string | null;
  firstSeenAt: string; lastSeenAt: string;
}
export interface DeviceWorkloadsView { capability: 0 | 1; runtimes: DeviceWorkloadRuntimeView[]; workloads: DeviceWorkloadView[] }
export function buildDeviceWorkloadsView(capability: number, runtimeRows: RuntimeRow[], workloadRows: WorkloadRow[]): DeviceWorkloadsView; // pure
export function getDeviceWorkloadsView(deviceId: string): Promise<DeviceWorkloadsView | null>;  // null = device not visible
// routes/devices/workloads.ts
export const deviceWorkloadsRoutes: Hono; // GET /:id/workloads
```

- Response (spec §6.3): exactly `{ capability, runtimes, workloads }`. `capability` is `devices.workload_inventory_protocol_version` normalized to `0|1`. Workloads are sorted by runtime, then state, then name (plain ascending string order; `workloadId` breaks ties for a stable order). `device_id` and `org_id` are not returned.
- Access: the same gate as the time-status read — `authMiddleware`, `requireScope('organization','partner','system')`, `requirePermission(DEVICES_READ)`, then `getDeviceWithOrgAndSiteCheck` (org + site access) before any workload read. A device the caller cannot see is `404`, a denied site is `403`.
- Consumes: `deviceWorkloads`, `deviceWorkloadRuntimes`, `devices` (Task 2); `getDeviceWithOrgAndSiteCheck`, `SITE_ACCESS_DENIED` (`routes/devices/helpers.ts`); `PERMISSIONS.DEVICES_READ`.

- [ ] **Step 1: Write the failing tests.**

(a) `apps/api/src/services/workloads/view.test.ts`:

```ts
import { expect, it } from 'vitest';
import { buildDeviceWorkloadsView } from './view';

const T = new Date('2026-10-06T12:00:00Z');
const runtimeRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 'r1',
    deviceId: 'd1',
    orgId: 'o1',
    runtime: 'docker',
    detection: 'present',
    collection: 'ok',
    complete: true,
    runtimeVersion: '27.1.1',
    observedCount: 2,
    reportedCount: 2,
    lastError: null,
    collectedAt: T,
    lastAttemptAt: T,
    lastSuccessAt: T,
    updatedAt: T,
    ...over,
  }) as never;
const workloadRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 'w1',
    deviceId: 'd1',
    orgId: 'o1',
    runtime: 'docker',
    kind: 'container',
    workloadId: 'a',
    name: 'web',
    state: 'running',
    rawState: null,
    imageRef: null,
    imageRepository: null,
    imageTag: null,
    imageDigest: null,
    imageId: null,
    guestOs: null,
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    restartPolicy: null,
    cpuCount: null,
    memoryMb: null,
    startedAt: null,
    runtimeCreatedAt: null,
    firstSeenAt: T,
    lastSeenAt: T,
    updatedAt: T,
    ...over,
  }) as never;

it('returns exactly capability, runtimes and workloads, with ISO timestamps and no tenant ids', () => {
  const view = buildDeviceWorkloadsView(1, [runtimeRow()], [workloadRow({ startedAt: T })]);
  expect(Object.keys(view).sort()).toEqual(['capability', 'runtimes', 'workloads']);
  expect(view.runtimes[0]).toMatchObject({
    runtime: 'docker',
    collectedAt: '2026-10-06T12:00:00.000Z',
    lastSuccessAt: '2026-10-06T12:00:00.000Z',
  });
  expect(view.workloads[0]).toMatchObject({ startedAt: '2026-10-06T12:00:00.000Z', runtimeCreatedAt: null });
  for (const row of [...view.runtimes, ...view.workloads]) {
    expect(row).not.toHaveProperty('deviceId');
    expect(row).not.toHaveProperty('orgId');
    expect(row).not.toHaveProperty('updatedAt');
  }
});

it('sorts workloads by runtime, then state, then name, then workloadId', () => {
  const view = buildDeviceWorkloadsView(
    1,
    [],
    [
      workloadRow({ id: '1', runtime: 'proxmox', kind: 'vm', state: 'running', name: 'b', workloadId: '2' }),
      workloadRow({ id: '2', runtime: 'docker', state: 'stopped', name: 'a', workloadId: '3' }),
      workloadRow({ id: '3', runtime: 'docker', state: 'running', name: 'z', workloadId: '4' }),
      workloadRow({ id: '4', runtime: 'docker', state: 'running', name: 'a', workloadId: '6' }),
      workloadRow({ id: '5', runtime: 'docker', state: 'running', name: 'a', workloadId: '5' }),
    ],
  );
  expect(view.workloads.map((w) => w.id)).toEqual(['5', '4', '3', '2', '1']);
});

it('sorts runtimes by name', () => {
  const view = buildDeviceWorkloadsView(1, [runtimeRow({ runtime: 'proxmox' }), runtimeRow({ runtime: 'docker' })], []);
  expect(view.runtimes.map((r) => r.runtime)).toEqual(['docker', 'proxmox']);
});

it.each([
  [0, 0],
  [1, 1],
  [2, 1],
  [-1, 0],
])('normalizes stored capability %s to %s', (stored, expected) => {
  expect(buildDeviceWorkloadsView(stored, [], []).capability).toBe(expected);
});
```

(b) `apps/api/src/routes/devices/workloads.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  device: vi.fn(),
  view: vi.fn(),
  denied: Symbol('denied'),
  status: 0,
  permissionDenied: false,
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (m.status === 401) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {});
    return next();
  },
  requireScope: () => async (c: any, next: any) => (m.status === 403 ? c.json({ error: 'Forbidden' }, 403) : next()),
  requirePermission: () => async (c: any, next: any) => (m.permissionDenied ? c.json({ error: 'Forbidden' }, 403) : next()),
}));
vi.mock('./helpers', () => ({ getDeviceWithOrgAndSiteCheck: m.device, SITE_ACCESS_DENIED: m.denied }));
vi.mock('../../services/workloads/view', () => ({ getDeviceWorkloadsView: m.view }));

import { deviceWorkloadsRoutes } from './workloads';

const id = '11111111-1111-4111-8111-111111111111';
const request = () => deviceWorkloadsRoutes.request(`/${id}/workloads`);
beforeEach(() => {
  m.status = 0;
  m.permissionDenied = false;
  m.device.mockReset().mockResolvedValue({ id });
  m.view.mockReset().mockResolvedValue({ capability: 0, runtimes: [], workloads: [] });
});

it('returns the view, including the ordinary nothing-reported state, as 200', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ capability: 0, runtimes: [], workloads: [] });
  expect(m.view).toHaveBeenCalledWith(id);
});

it.each([401, 403])('rejects unauthorized scope %s', async (status) => {
  m.status = status;
  expect((await request()).status).toBe(status);
  expect(m.view).not.toHaveBeenCalled();
});

it('checks DEVICES_READ before the device lookup', async () => {
  m.permissionDenied = true;
  expect((await request()).status).toBe(403);
  expect(m.device).not.toHaveBeenCalled();
  expect(m.view).not.toHaveBeenCalled();
});

it.each([
  [null, 404],
  [m.denied, 403],
])('blocks an org/site-inaccessible device (%s)', async (value, status) => {
  m.device.mockResolvedValue(value);
  expect((await request()).status).toBe(status);
  expect(m.view).not.toHaveBeenCalled();
});

it('handles a device disappearing between authorization and read', async () => {
  m.view.mockResolvedValue(null);
  expect((await request()).status).toBe(404);
});

it('surfaces service errors', async () => {
  m.view.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
});
```

(c) `apps/api/src/services/workloads/view.integration.test.ts`:

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { getDeviceWorkloadsView } from './view';

const system: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null };

it('returns the device\'s own rows to its org and nothing to a sibling org', async () => {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const other = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({ orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'workload-view', osType: 'linux', osVersion: '1', architecture: 'x64', agentVersion: '1.0.0' })
    .returning();
  await getTestDb().execute(sql`UPDATE devices SET workload_inventory_protocol_version = 1 WHERE id = ${device!.id}`);
  await withDbAccessContext(system, async () => {
    await db.execute(sql`
      INSERT INTO device_workload_runtimes(device_id, org_id, runtime, detection, collection, complete, collected_at, last_attempt_at)
      VALUES (${device!.id}, ${org.id}, 'docker', 'present', 'ok', true, now(), now())`);
    await db.execute(sql`
      INSERT INTO device_workloads(device_id, org_id, runtime, kind, workload_id, name, state)
      VALUES (${device!.id}, ${org.id}, 'docker', 'container', 'a', 'web', 'running')`);
  });
  const ctx = (orgId: string): DbAccessContext => ({
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  });
  const own = await withDbAccessContext(ctx(org.id), () => getDeviceWorkloadsView(device!.id));
  expect(own).toMatchObject({ capability: 1 });
  expect(own!.runtimes).toHaveLength(1);
  expect(own!.workloads).toMatchObject([{ runtime: 'docker', workloadId: 'a', name: 'web', state: 'running' }]);
  expect(await withDbAccessContext(ctx(other.id), () => getDeviceWorkloadsView(device!.id))).toBeNull();
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/api && npx vitest run src/services/workloads/view.test.ts src/routes/devices/workloads.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/view.integration.test.ts
```

Expected FAIL: `Failed to resolve import "./view"` / `"./workloads"`.

- [ ] **Step 3: Implement the view** — create `apps/api/src/services/workloads/view.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import type {
  WorkloadCollection,
  WorkloadDetection,
  WorkloadKind,
  WorkloadRuntime,
  WorkloadState,
} from '@breeze/shared';
import { db } from '../../db';
import { deviceWorkloadRuntimes, deviceWorkloads, devices } from '../../db/schema';

type RuntimeRow = typeof deviceWorkloadRuntimes.$inferSelect;
type WorkloadRow = typeof deviceWorkloads.$inferSelect;

export interface DeviceWorkloadRuntimeView {
  runtime: WorkloadRuntime;
  detection: WorkloadDetection;
  collection: WorkloadCollection;
  complete: boolean;
  runtimeVersion: string | null;
  observedCount: number | null;
  reportedCount: number | null;
  lastError: string | null;
  collectedAt: string;
  lastAttemptAt: string;
  lastSuccessAt: string | null;
}

export interface DeviceWorkloadView {
  id: string;
  runtime: WorkloadRuntime;
  kind: WorkloadKind;
  workloadId: string;
  name: string;
  state: WorkloadState;
  rawState: string | null;
  imageRef: string | null;
  imageRepository: string | null;
  imageTag: string | null;
  imageDigest: string | null;
  imageId: string | null;
  guestOs: string | null;
  composeProject: string | null;
  composeService: string | null;
  composeWorkingDir: string | null;
  restartPolicy: string | null;
  cpuCount: number | null;
  memoryMb: number | null;
  startedAt: string | null;
  runtimeCreatedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Spec §6.3: exactly these three keys. */
export interface DeviceWorkloadsView {
  capability: 0 | 1;
  runtimes: DeviceWorkloadRuntimeView[];
  workloads: DeviceWorkloadView[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const iso = (value: Date) => value.toISOString();
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null);

/** Pure projection + ordering (runtime, state, name — workloadId breaks ties). */
export function buildDeviceWorkloadsView(
  capability: number,
  runtimeRows: readonly RuntimeRow[],
  workloadRows: readonly WorkloadRow[],
): DeviceWorkloadsView {
  const runtimes = [...runtimeRows]
    .sort((a, b) => cmp(a.runtime, b.runtime))
    .map(
      (row): DeviceWorkloadRuntimeView => ({
        runtime: row.runtime,
        detection: row.detection,
        collection: row.collection,
        complete: row.complete,
        runtimeVersion: row.runtimeVersion,
        observedCount: row.observedCount,
        reportedCount: row.reportedCount,
        lastError: row.lastError,
        collectedAt: iso(row.collectedAt),
        lastAttemptAt: iso(row.lastAttemptAt),
        lastSuccessAt: isoOrNull(row.lastSuccessAt),
      }),
    );
  const workloads = [...workloadRows]
    .sort(
      (a, b) =>
        cmp(a.runtime, b.runtime) || cmp(a.state, b.state) || cmp(a.name, b.name) || cmp(a.workloadId, b.workloadId),
    )
    .map(
      (row): DeviceWorkloadView => ({
        id: row.id,
        runtime: row.runtime,
        kind: row.kind,
        workloadId: row.workloadId,
        name: row.name,
        state: row.state,
        rawState: row.rawState,
        imageRef: row.imageRef,
        imageRepository: row.imageRepository,
        imageTag: row.imageTag,
        imageDigest: row.imageDigest,
        imageId: row.imageId,
        guestOs: row.guestOs,
        composeProject: row.composeProject,
        composeService: row.composeService,
        composeWorkingDir: row.composeWorkingDir,
        restartPolicy: row.restartPolicy,
        cpuCount: row.cpuCount,
        memoryMb: row.memoryMb,
        startedAt: isoOrNull(row.startedAt),
        runtimeCreatedAt: isoOrNull(row.runtimeCreatedAt),
        firstSeenAt: iso(row.firstSeenAt),
        lastSeenAt: iso(row.lastSeenAt),
      }),
    );
  return { capability: capability >= 1 ? 1 : 0, runtimes, workloads };
}

/** null = the device is not visible to the caller (RLS) or does not exist. */
export async function getDeviceWorkloadsView(deviceId: string): Promise<DeviceWorkloadsView | null> {
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, capability: devices.workloadInventoryProtocolVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return null;
  const runtimeRows = await db
    .select()
    .from(deviceWorkloadRuntimes)
    .where(and(eq(deviceWorkloadRuntimes.deviceId, deviceId), eq(deviceWorkloadRuntimes.orgId, device.orgId)));
  const workloadRows = await db
    .select()
    .from(deviceWorkloads)
    .where(and(eq(deviceWorkloads.deviceId, deviceId), eq(deviceWorkloads.orgId, device.orgId)));
  return buildDeviceWorkloadsView(device.capability, runtimeRows, workloadRows);
}
```

- [ ] **Step 4: Implement the route** — create `apps/api/src/routes/devices/workloads.ts`:

```ts
import { Hono } from 'hono';
import { authMiddleware, requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { getDeviceWorkloadsView } from '../../services/workloads/view';

export const deviceWorkloadsRoutes = new Hono();
deviceWorkloadsRoutes.use('*', authMiddleware);
deviceWorkloadsRoutes.get(
  '/:id/workloads',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const id = c.req.param('id')!;
    const device = await getDeviceWithOrgAndSiteCheck(c, id, c.get('auth'));
    if (device === SITE_ACCESS_DENIED) return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    const view = await getDeviceWorkloadsView(id);
    return view ? c.json(view) : c.json({ error: 'Device not found' }, 404);
  },
);
```

- [ ] **Step 5: Mount and register.**

`apps/api/src/routes/devices/index.ts` — add `import { deviceWorkloadsRoutes } from './workloads';` after `import { timeStatusRoutes } from './timeStatus';` (line 18) and `deviceRoutes.route('/', deviceWorkloadsRoutes);` after `deviceRoutes.route('/', timeStatusRoutes);` (line 164).

`apps/api/src/services/mcpCoverage.ts` — after `'devices/watchdogLogs.ts': { gap: '#6783' },` (line 408) add (the gate allows no new gap, and the AI tool is W04 — see Contract issues; `get_device_details` already returns the device projection that now carries the host axis):

```ts
  // #3834 W01: the host axis (hostsWorkloads/workloadRuntimes) is part of the
  // device projection that get_device_details returns. W04 adds
  // query_device_workloads for the per-workload list and replaces this entry.
  'devices/workloads.ts': { tools: ['get_device_details'] },
```

`apps/api/src/__tests__/parkedFanout.contract.test.ts` — `view.ts` reads `devices`; add to `EXEMPT` after the `services/workloads/ingest.ts` entry:

```ts
  'services/workloads/view.ts': 'derived: keyed on a single deviceId from already-authorized callers',
```

- [ ] **Step 6: Run the suites**

```bash
cd apps/api && npx vitest run src/services/workloads/view.test.ts src/routes/devices/workloads.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/parkedFanout.contract.test.ts src/__tests__/routerAuthGate.contract.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/view.integration.test.ts
```

Expected PASS. `routerAuthGate.contract.test.ts` confirms the new router carries `authMiddleware`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/workloads/view.ts apps/api/src/services/workloads/view.test.ts apps/api/src/services/workloads/view.integration.test.ts apps/api/src/routes/devices/workloads.ts apps/api/src/routes/devices/workloads.test.ts apps/api/src/routes/devices/index.ts apps/api/src/services/mcpCoverage.ts apps/api/src/__tests__/parkedFanout.contract.test.ts
git commit -m "feat(workloads): expose a device's workload inventory" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Contract suites, typechecks and PR evidence

**Files:** Test-only. Existing contract suites: `apps/api/src/__tests__/integration/{rls-coverage,tenantCascade,tenant-export-policy,tenantExportErasureRoundtrip,orgMergeRegistry,orgLifecycleFoundations}.integration.test.ts`, `apps/api/src/routes/devices/{cascadeDelete,moveOrg.coverage}.test.ts`. The only file this task may modify is this plan (execution record). No new production code belongs here; a failure is fixed in the owning task's files and re-run.

**Interfaces:** Consumes the whole W01 implementation. Produces: verified RLS coverage, composite-FK deferrability, cascade / move / merge / export coverage, migration ordering, and API/shared/web type consistency.

- [ ] **Step 1: Targeted unit regressions (no full suites yet)**

```bash
(cd packages/shared && npx vitest run src/validators/workloads.test.ts src/constants/configFeatureTypes.test.ts)
(cd apps/api && npx vitest run src/services/workloads/plan.test.ts src/services/workloads/settings.test.ts src/services/workloads/configUpdate.test.ts src/services/workloads/view.test.ts src/services/configurationPolicy.workloadInventory.test.ts src/services/configurationPolicy.timeSync.test.ts src/services/policyBaselineDefaults.test.ts src/routes/configurationPolicies/featureLinks.test.ts src/routes/agents/workloads.test.ts src/routes/agents/workloads.mounted.test.ts src/routes/devices/workloads.test.ts src/routes/agents/heartbeat.test.ts src/routes/devices/helpers.test.ts src/middleware/bodyLimit.test.ts)
(cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/deviceDeletion.test.ts src/services/orgMerge.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts)
(cd apps/api && npx vitest run src/routes/agents/parkedRouteClassification.test.ts src/__tests__/parkedFanout.contract.test.ts src/__tests__/writeRoutePermissionGate.contract.test.ts src/__tests__/routerAuthGate.contract.test.ts src/__tests__/mcp-coverage.test.ts src/services/mcpGuidancePromptTools.test.ts src/services/aiToolsConfigPolicy.test.ts)
(cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts)
```

Expected PASS (record each file count; a "No test files found" line means a typo'd path, not a pass).

- [ ] **Step 2: Real-Postgres tenancy and lifecycle contracts.** The RLS coverage suite has its own runner and is not selected through the integration config. The trap tears the stack down even when a command fails.

```bash
(
  set -e
  trap 'pnpm test-stack down' EXIT
  pnpm test-stack up
  DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/workloads/migrations.integration.test.ts src/services/workloads/featureMigration.integration.test.ts src/services/workloads/settings.integration.test.ts src/services/workloads/ingest.integration.test.ts src/services/workloads/view.integration.test.ts)
  DATABASE_URL="$(grep -E '^DATABASE_URL=' .env.test | cut -d= -f2-)" pnpm db:check-drift
)
```

Expected PASS: both device tables and the settings table covered by forced RLS and every tenant lifecycle list (`tenantCascade` asserts alphabetical order with `organizations` last and FK children before parents — the composite FKs are `ON DELETE CASCADE`); both composite FKs deferrable-but-initially-immediate (`orgLifecycleFoundations` "merge contract"); wrong-tenant insert is SQLSTATE `42501`; the export-policy suites classify every column of both new tables and the three new `devices` columns with no open container; drift check reports no drift. If `tenant-export-policy` names a column as unclassified, the registry entry in Task 2 is missing it — fix the entry, never the test.

- [ ] **Step 3: The exact CI typechecks.** Check each exit code; never pipe to `tail`.

```bash
cd /Users/toddhebebrand/breeze/.claude/worktrees/plan-3834
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "api tsc exit=$?"
pnpm --filter @breeze/shared typecheck; echo "shared tsc exit=$?"
(cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm exec astro check; echo "web check exit=$?")
```

Expected: three exit codes of 0 (API source + tests in build mode, shared source + tests, web Astro/React).

- [ ] **Step 4: Lint the touched packages**

```bash
pnpm --filter @breeze/api lint
pnpm --filter @breeze/web lint
(cd packages/shared && pnpm exec eslint src/constants/workloads.ts src/constants/configFeatureTypes.ts src/validators/workloads.ts src/validators/workloads.test.ts)
```

Expected: clean.

- [ ] **Step 5: Full API unit suite once before the PR** (the merge engine and several registry contracts only red in the full run, never in a touched-file run — CLAUDE.md "Test API" blind spot).

```bash
(cd apps/api && npx vitest run)
```

Expected: PASS with no new failures versus `origin/main`. Record the file/test counts.

- [ ] **Step 6: Registration greps, migration ordering and diff hygiene**

```bash
grep -n "device_workloads\|device_workload_runtimes" apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts
grep -n "hosts_workloads\|workload_runtimes\|workload_inventory_protocol_version" apps/api/src/services/tenantExportPolicyRegistry.ts
grep -n "hostsWorkloads" apps/api/src/routes/devices/helpers.ts
grep -n "config_policy_workload_inventory_settings" apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -3
bash scripts/check-migration-naming.sh --against-ref origin/main
git diff --check
```

Expected: `device_workloads` and `device_workload_runtimes` each appear in `tenantCascade.ts` (1), `core.ts` (2 lists each), `orgMergeRegistry.ts` (1) and `tenantExportPolicyRegistry.ts` (table entries); the three `devices` columns appear in the export registry; the settings table is in `rls-coverage`; the two W01 migrations are the newest two files (if `origin/main` moved past `2026-12-15-100000`, rename both upward and update the `replayMigration(...)` references in `migrations.integration.test.ts` and `featureMigration.integration.test.ts`, then rerun Steps 1-2); the naming guard passes; `git diff --check` is silent.

- [ ] **Step 7: Cross-tenant forge by hand (CLAUDE.md step 6)** against a throwaway stack, as `breeze_app`:

```bash
pnpm test-stack up
docker exec -it "$(docker ps --format '{{.Names}}' | grep -E 'postgres' | head -1)" psql -U breeze_app -d breeze -c "INSERT INTO device_workloads(device_id, org_id, runtime, kind, workload_id, name, state) VALUES (gen_random_uuid(), gen_random_uuid(), 'docker', 'container', 'x', 'x', 'running');"
pnpm test-stack down
```

Expected: `ERROR: new row violates row-level security policy for table "device_workloads"`. (The automated equivalent is `migrations.integration.test.ts` "denies a forged cross-tenant insert"; this is the by-hand confirmation the repo asks for.) Tear the stack down and say nothing was left running.

- [ ] **Step 8: Feature lifecycle and PR evidence.**
  - Before starting: `get_feature_status` for the feature, branch `feature/<parent#>-workload-inventory/wave-<sub-issue#>`, `start_wave` (index rule). After the PR merges: `complete_wave`.
  - PR body states: `Closes #<W01 sub-issue>`; the two migrations and that they write no rows; "no partner-export triggers (spec D12)"; the settings-rule-9 line for the new setting — **home:** configuration policy feature `workload_inventory` (UI tab arrives in W04); **level:** partner default → org override; **resolver:** `resolveDeviceWorkloadInventorySettings` (one, shared by heartbeat delivery and ingest); **places configured before → after:** 0 → 1 (API-only; the UI count is reported again in W04); and the contract-issues list below.
  - Run `/pr-review-toolkit:review-pr` once (Sonnet + Codex `medium` per the index); act only on confirmed, consequential findings. A fix that touches a tenancy, cascade or migration surface warrants one re-review; anything else does not.

- [ ] **Step 9: Record the execution** — tick the checkboxes above in this plan file only after the corresponding commands actually ran, preserve any verification failure and its fix, and commit the record:

```bash
git add docs/superpowers/plans/devices/2026-10-06-workload-host-inventory-w01-api-contract.md
git commit -m "docs(workloads): record W01 verification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

| Spec requirement | Task(s) |
|---|---|
| §2 D1 typed columns, no jsonb/bytea | T2 (migration + schema), T8 export-policy suites |
| §2 D2 detection vs collection split, `device_workload_runtimes` | T2, T3 (planner rows), T6 |
| §2 D3 host axis from detection, never from rows | T2 (columns), T3 (host-axis rules), T6 |
| §2 D4 default-off enumeration, detection always on | T1 (defaults), T3 (policy override), T4, T5, T6 |
| §2 D10 reconcile only ok-and-complete; failed/truncated/disabled never delete by absence | T3, T6 |
| §2 D11 disabling deletes that runtime's rows, runtime row stays | T3, T6 |
| §2 D12 not partner-export material | Global Constraints, T2 (migration has no triggers; test asserts zero) |
| §2 D16 trust tier protective | T4 |
| §4.1 `device_workloads` columns, CHECKs, FK, unique, indexes, RLS | T2 |
| §4.2 `device_workload_runtimes` | T2 |
| §4.3 `devices` host axis + `PUBLIC_DEVICE_FIELDS` + export `included` | T2 |
| §4.4 every registration (cascade, device cascade, denormalized, merge, export, settings RLS) | T2, T4; enforced end to end by T8 |
| §6.1 route, auth, 2 MiB, strict schema, duplicate → 400 | T1, T6 |
| §6.2 algorithm (guard, policy override, absent, disabled, replace-set, truncated, untouched runtimes, host recompute, response) | T3 (pure), T6 (transactional, real Postgres) |
| §6.2 `planWorkloadSync` reusing `planChildRowSync`; exported `lockDeviceInventory` | T3, T6 |
| §6.3 `GET /devices/:id/workloads` shape, sort, access check | T7 |
| §7.1 settings table, parent-chain RLS, partner-wide SELECT branch, inline feature wiring | T4 |
| §7.2 delivery: defaults, omit on error, 120 s cache, shared resolver | T5, T6 |
| §5.3 capability column + non-sticky write (API half only) | T2 (column), T5 |
| §13 API unit + integration tests (strictness, planner branches, ordering guard, disabled-by-policy, host-axis incl. unknown, registration contracts, RLS forge 42501, device move, merge repoint, erasure, export roundtrip, cascade order) | T1, T3, T6 (unit); T2, T4, T5, T6, T7, T8 (integration) |
| §5 agent code, §8 web/filters/AI/docs page, §9-§12 image currency, compliance, monitor kind, private registries, compose update | Out of W01 (W02–W08) |

**Placeholder scan:** no TBD, "add validation" or "similar to Task N" steps. Every schema, migration, zod schema, planner, service, route and test is full code; edits to existing files quote their anchor line and the exact replacement. The only conditional instructions are explicit contract-test follow-ups (`parkedFanout` classification, mounted-test mocks) with the rule for when each applies.

**Type-consistency check:** `WorkloadRuntimeReport`/`WorkloadReportItem` (T1) are the planner's input types (T3) and the ingest row mapper's (T6); the planner's `WorkloadRuntimeWrite` field names equal the `device_workload_runtimes` Drizzle columns (T2) one-for-one; `WorkloadInventoryInlineSettings` (T1) is the resolver's cache/return type (T5), the decompose/assemble shape (T4) and the planner's `isEnabled` source (T6); the wire keys of `WorkloadInventoryConfigUpdate` (T5) are the ones W02's agent must read; `DeviceWorkloadsView` (T7) is exactly the spec's three keys.

**Review Focus coverage:** focus 1 → T3 + T6; focus 2 → T3 + T6; focus 3 → T3, T5, T6; focus 4 → T3 + T6; focus 5 → T1 + T6; focus 6 → T3 + T6; focus 7 → T5 + T6; focus 8 → T2, T4, T8.

**Authoring verification:** every existing-file line number and anchor was read in this checkout on 2026-10-05; implementation tests were **not** run during plan authoring (this pass wrote no code). The first execution step of Tasks 2, 4, 5 and 6 is a red run, so a mistyped anchor or mock shape fails loudly there.

## Handoff to later waves

Accepted deviations that W01 leaves in place on purpose; each is owned by the wave named.

- **W04 — MCP coverage mapping.** `apps/api/src/services/mcpCoverage.ts` maps `'devices/workloads.ts'` to `{ tools: ['get_device_details'] }` only because the coverage gate allows no new `gap` entry. W04 adds `query_device_workloads` and **replaces** this entry.
- **W04 — temporary web exclusions.** `workload_inventory` is in `EDITOR_EXCLUDED_FEATURE_TYPES` (`featureTabs/types.ts`) and `EFFECTIVE_CONFIG_EXCLUDED_FEATURE_TYPES` (`DeviceEffectiveConfigTab.tsx`), and the `featureTypeParity.test.ts` assertion was updated to expect `['workload_inventory']`. W04 ships the editor tab and effective-config row, **removes both exclusions** and restores that assertion to `[]`.
- **W02 — wire contract.** The agent reads `configUpdate.workload_inventory_settings` with exactly the keys `enabled, docker_enabled, podman_enabled, hyperv_enabled, proxmox_enabled, interval_minutes`, and sends `securityCapabilities.workloadInventoryProtocolVersion = 1`. It keeps the payload under the 1.75 MB byte budget in spec §5.4 (route limit 2 MB; no API change).
- **Plan index.** Done — the index migration table lists `devices.workload_inventory_protocol_version`.

## Contract issues

Where the current code or the spec's own text does not line up. Items already folded into the spec are noted as resolved.

1. **Extra DB CHECKs.** The spec states CHECKs only for `runtime` and `kind`. The plan also adds closed-vocabulary CHECKs for `device_workloads.state` and `device_workload_runtimes.detection` / `collection`, so ingest's logic (`present`, `ok`, …) cannot be fed a free-text value by a future second writer. Cost: a new state/collection value needs a migration. Drop them in review if undesired (T2 migration, schema and the 23514 assertions).
2. **Wire keys for `workload_inventory_settings` are not fixed by §7.2** (it shows `{ enabled: false, ... }`). The plan uses snake_case (see Handoff, W02), matching `hardware_monitoring_settings` / `time_sync_settings`.
3. Resolved in spec: wire item is the agent-supplied subset and offset datetimes (was 1).
4. Resolved in spec: absent runtime rows are kept so the ordering guard survives (was 3).
5. Resolved in spec: `collectedAt` is clamped to `min(collectedAt, receivedAt)` (was 4).
6. Resolved in spec: `observedCount > workloads.length` is treated as truncated (was 5).
7. Resolved in spec: containerd entries carry no workloads (was 6).
8. Resolved in spec: capability column documented (was 7).
9. Accepted, tracked under Handoff (W04): MCP coverage mapping (was 9) and temporary web exclusions (was 10).
10. Resolved in spec: agent byte budget of 1.75 MB (was 11).
11. Resolved in spec: GET sort order by state as plain text (was 12).
12. Resolved in spec: `tenantCascade.ts` line reference (was 13).
