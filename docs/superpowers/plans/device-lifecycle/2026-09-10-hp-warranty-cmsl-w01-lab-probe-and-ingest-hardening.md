---
tracking_issue: LanternOps/breeze#5511
---

# Wave 01 — HP warranty via HP CMSL: lab probe + ingest hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two halves of W01 — (A) a safe, reversible, copy-pasteable HP lab probe that answers the three hardware questions W03 and W04 are gated on, and (B) the ingest hardening that stops the server from destroying agent-collected warranty data, widens the agent path to carry HP's N entitlements, and makes manual refresh tell the truth for HP.

**Architecture:** One new dependency-free module, `apps/api/src/services/warrantyDataSources.ts`, becomes the single definition of "an agent wrote this row" and of which vendor a synthesised agent entitlement belongs to. Four existing writers adopt it: the direct-sync preservation branch and the 7-day sweep selector (`warrantySync.ts`), the CSV importer's apply and preview paths (`warrantyTarget.ts`, `valueImport.ts`), and the manual-refresh route (`routes/devices/warranty.ts`). The agent report path widens across all three of its layers — zod schema, handler field selection, service interface — to carry an entitlements array. No database migration: `entitlements` is already `jsonb NOT NULL DEFAULT '[]'` and `data_source` is an unconstrained `varchar(50)`. The lab half ships as one committed PowerShell probe with five phases plus a results template posted to #5512.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS), zod, Vitest (unit + `vitest.integration.config.ts`), PowerShell 5.1 (the lab probe; CMSL's own floor).

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md` — layer 6 (reporting and ingest) and the wave-1 gate in "Wave sketch"/"Risks". Its **"Corrections after ground-truth verification (2026-09-10)"** section supersedes the body wherever they disagree, and this plan follows the corrections.

**Cross-wave contract:** `contract-B-hp-cmsl.md` (coordinator, authoritative). W01 owns decisions **D9, D10, D11** and the three lab-gate questions. Every locked decision is copied verbatim into Global Constraints below.

**Depends on:** nothing. W03 (#5514) and W04 (#5515) depend on this wave's *lab answers*; nothing depends on its code.

## Global Constraints

Copied verbatim from the contract. No task may rename or re-shape anything here. A task that believes one of these is wrong **stops and reports** rather than diverging.

- **D9 — data source value and the preservation generalisation.** Agent-reported HP rows carry `data_source = 'agent_cmsl'` (varchar(50), no CHECK, so no migration). The preservation branch is generalised, not given a second hardcoded string:
  ```ts
  export const AGENT_OWNED_WARRANTY_SOURCES = new Set(['agent_plist', 'agent_cmsl']);
  export function isAgentOwnedWarrantySource(dataSource: string | null | undefined): boolean;
  ```
  Applied in THREE places, not one: (1) `warrantySync.ts:153` — the preservation branch; (2) the sweep candidate selector / direct sync — exclude HP from provider lookup so an HP device is not re-run every 7 days into an overwrite; (3) `apps/api/src/services/customFields/import/warrantyTarget.ts:181,238` — the CSV-import guard is `'provider'`-only today and therefore already stomps `agent_plist` rows.
- **D10 — entitlements require widening `AgentWarrantyData`.** W01 widens all three layers — schema, handler selection, service type — with bounds: **at most 25 entitlements per report**; **each string field ≤ 200 chars**; **dates as ISO-8601 strings, preserved as HP reports them**; the synthesised entitlement's `provider` is **derived from the reporting source, never hardcoded** — `provider: 'apple' as const` (`warrantySync.ts:367`) is a verified defect and W01 fixes it. `'hp'` is already in the union (`warrantyProviders/types.ts:2`).
- **D11 — manual refresh on an HP device.** `POST /devices/:id/warranty/refresh` (`devices/warranty.ts:42-67`) currently queues a server-side sync that can never produce HP data. It must not silently no-op. W01 makes it return an honest coded refusal for HP devices (`{ error: '...', code: 'WARRANTY_REFRESH_NOT_AVAILABLE' }`, **409**); W03 may later upgrade it to request agent collection once there is a trigger to call. W01 states which it shipped — **this plan ships the coded refusal.**
- **D13 — migration slots.** Newest committed migration as of 2026-09-10: `apps/api/migrations/2026-10-15-150300-remote-session-revocation-lease.sql` (re-confirmed by this plan's ground-truth pass). **W01 is expected to need no migration.** If it turns out to need one, it takes the next free slot after that file and says so in its PR — it does **NOT** reuse W04's `2026-10-15-150402-…` slot. `2026-08-06` is a closed date block; today's date does not sort last.
- **Ownership — W01 must NOT touch:** config policy, any agent Go code, the catalog package, web. (`apps/web/**` is out of scope in every task below, including the `agent_cmsl` label in `DeviceWarrantyCard.tsx`, which is W05's.)
- **`targetWhere` is load-bearing on every `device_warranty` upsert.** `device_warranty` has TWO partial unique indexes (`db/schema/warranty.ts:60-65`); Postgres can only infer a partial unique index as the `ON CONFLICT` arbiter when the statement repeats its predicate. Dropping `targetWhere` reintroduces a runtime 42P10 on **every** warranty upsert, device rows included.
- **Non-negotiable testing gates.** The `agent_cmsl`-survives-a-sweep test is the direct regression for a verified data-loss defect and **MUST be written red against unmodified code first** — watched failing, not assumed to fail. Integration suites need a live DB and run only in the **Integration Tests** CI job; a locally-green branch proves nothing about them, so this plan runs them explicitly.
- **Scoped test runs:** `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` into argv, vitest stops flag parsing there, `--run` is swallowed as a positional filter, and the whole 1,470-file suite runs in watch mode. Vitest's path filter is a **plain substring match**, not a glob: a trailing slash silently skips sibling `foo.test.ts` files, and an asterisk matches nothing.
- **Typecheck:** `apps/api` has no `typecheck` script. Use `pnpm --filter @breeze/api exec tsc --noEmit`.
- **HP CMSL licence, for the lab half.** HP's licence states verbatim: *"You do not have the right to distribute the Software Product."* **Breeze must never mirror or host the CMSL installer** — install via winget or HP's own URL, both of which pull from HP. Auto-accepting the licence is accepting it on the customer's behalf, which is why the shipped feature is opt-in with recorded consent (W02) and why the probe runs only on hardware the operator owns or has written permission to modify. The licence also permits HP to collect technical information including IP address.
- **HP rate limit:** 300 requests / 5 minutes **per source IP** — a per-customer-NAT limit, not a per-device one. The probe must not loop `Get-HPWarrantyInfo`.

---

## 0. Ground truth

Every file below was re-opened in this worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing`, branch `spec/hp-warranty-and-desired-state-install`) on 2026-09-10 and quoted verbatim. The contract's "Verified starting facts" were **confirmed, not copied** — corrections are called out inline.

### The two verified defects

`apps/api/src/services/warrantySync.ts:141-176` — the preservation branch, string-keyed to `'agent_plist'`:

```ts
141    const provider = getProviderForManufacturer(manufacturer);
142    if (!provider) {
143      // Check if we already have agent-reported warranty data for this subject.
144      // If so, don't overwrite it with an error — just skip. Only an agent writes
145      // 'agent_plist', so only a device subject can ever carry it.
146      if (subject.kind === 'device') {
147        const [existing] = await db
148          .select({ dataSource: deviceWarranty.dataSource, status: deviceWarranty.status })
149          .from(deviceWarranty)
150          .where(eq(deviceWarranty.deviceId, subject.deviceId))
151          .limit(1);
152
153        if (existing?.dataSource === 'agent_plist') {
154          // Agent-reported data exists — preserve it regardless of status, just update nextSyncAt
155          const now = new Date();
156          await db
157            .update(deviceWarranty)
158            .set({
159              lastSyncAt: now,
160              lastSyncError: null,
161              nextSyncAt: new Date(now.getTime() + SYNC_CADENCE_MS),
162              updatedAt: now,
163            })
164            .where(eq(deviceWarranty.deviceId, subject.deviceId));
165          return;
166        }
167      }
168
169      // No provider and no agent data — upsert as unknown (not an error)
170      await upsertWarranty(subject, orgId, manufacturer, serialNumber, {
171        found: false,
172        entitlements: [],
173        warrantyStartDate: null,
174        warrantyEndDate: null,
175      });
176      return;
177    }
```

`:153` confirmed. **The fall-through at `:170-176` is the data-loss path**: `upsertWarranty` writes `dataSource: 'provider'` (`:289`, `:305`), `warrantyStartDate: null`, `warrantyEndDate: null`, `entitlements: []`. An `agent_cmsl` row reaching it loses everything and changes owner.

`apps/api/src/services/warrantySync.ts:364-373` — the hardcoded provider:

```ts
364    // Build entitlements array from agent data
365    const entitlements = data.coverageType
366      ? [{
367          provider: 'apple' as const,
368          serviceLevelDescription: data.coverageType,
369          entitlementType: data.coverageType,
370          startDate: data.coverageStartDate ?? '',
371          endDate: data.coverageEndDate ?? '',
372        }]
373      : [];
```

`:367` confirmed. `apps/api/src/services/warrantyProviders/types.ts:1-7` confirms `'hp'` is already legal:

```ts
1  export interface WarrantyEntitlement {
2    provider: 'dell' | 'hp' | 'lenovo' | 'apple';
3    serviceLevelDescription: string;
4    entitlementType: string;
5    startDate: string;
6    endDate: string;
7  }
```

### HP has no server-side provider at all

`apps/api/src/services/warrantyProviders/index.ts:7-30`:

```ts
 7  // hpProvider is deliberately NOT registered: its unofficial support.hp.com
 8  // endpoint now returns the site's HTML shell (verified 2026-09-09) and HP's real
 9  // backend is captcha-gated, so enabling it only parks devices in `unknown` with
10  // a JSON parse error. HP coverage is coming from the agent instead. The module
11  // is kept (and unit-tested) until that lands.
12  const providers: WarrantyProvider[] = [dellProvider, lenovoProvider];
13
14  export function normalizeManufacturer(raw: string): string {
15    const lower = raw.toLowerCase().trim();
16    if (lower.includes('apple')) return 'apple';
17    if (lower.includes('dell')) return 'dell';
18    if (lower.includes('hp') || lower.includes('hewlett')) return 'hp';
19    if (lower.includes('lenovo')) return 'lenovo';
20    return lower.replace(/[^a-z0-9]/g, '');
21  }
22
23  export function getProviderForManufacturer(manufacturer: string): WarrantyProvider | null {
24    for (const provider of providers) {
25      if (provider.supports(manufacturer) && provider.isConfigured()) {
26        return provider;
27      }
28    }
29    return null;
30  }
```

Consequence used throughout this plan: **`getProviderForManufacturer` is `null` for every HP device**, so an HP device always reaches the `!provider` branch above. Fixing `:153` therefore fixes the direct-sync path completely; the sweep-selector change is the second layer.

Neither `dellProvider.ts`, `lenovoProvider.ts` nor `throttle.ts` imports `../db` (checked) — so the new module in Task 4 may import `normalizeManufacturer` without dragging a database into a route's unit-test module graph.

### The sweep selector — **citation correction**

The contract cites `getDevicesNeedingWarrantySync` as `:454-484`. The function actually spans **`:454-524`**; `:454-484` is only its *device arm*. The device arm's `where(...)` is `:462-477`:

```ts
457    const deviceRows = await db
458      .select({ deviceId: devices.id, nextSyncAt: deviceWarranty.nextSyncAt })
459      .from(devices)
460      .leftJoin(deviceWarranty, eq(devices.id, deviceWarranty.deviceId))
461      .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
462      .where(
463        and(
464          // Quick Support exclusion — see syncWarrantyForDevice above.
465          eq(devices.isEphemeral, false),
466          // Virtual-machine exclusion — see syncWarrantyForDevice above.
467          eq(devices.isVirtual, false),
468          // Has hardware with serial number
469          sql`${deviceHardware.serialNumber} IS NOT NULL`,
470          sql`${deviceHardware.manufacturer} IS NOT NULL`,
471          // Either no warranty row or next sync is due
472          or(
473            isNull(deviceWarranty.id),
474            lt(deviceWarranty.nextSyncAt, now)
475          )
476        )
477      )
```

Confirmed: **no manufacturer or data-source exclusion of any kind.** The manual-asset arm (`:486-503`) needs no change — only a device subject can ever carry an agent-written row.

`warrantySync.ts` imports at `:3`: `import { eq, and, lt, isNull, or, sql } from 'drizzle-orm';` — `notInArray` is **not** imported yet.

### No migration is needed — confirmed against the schema, not the spec

`apps/api/src/db/schema/warranty.ts:43-68`:

```ts
43    status: warrantyStatusEnum('status').notNull().default('unknown'),
44    warrantyStartDate: date('warranty_start_date'),
45    warrantyEndDate: date('warranty_end_date'),
46    // True when coverage is an active recurring subscription (AppleCare), in which
47    // case warrantyEndDate is the next renewal date rather than a real expiry.
48    isSubscription: boolean('is_subscription').notNull().default(false),
49    entitlements: jsonb('entitlements').notNull().default([]),
50    dataSource: varchar('data_source', { length: 50 }).default('provider'),
...
58    // Two partial unique indexes, one per subject kind — both upsert conflict
59    // targets must stay valid now that either column can be NULL.
60    deviceIdIdx: uniqueIndex('device_warranty_device_id_idx')
61      .on(table.deviceId)
62      .where(sql`${table.deviceId} IS NOT NULL`),
63    manualAssetIdIdx: uniqueIndex('device_warranty_manual_asset_id_idx')
64      .on(table.manualAssetId)
65      .where(sql`${table.manualAssetId} IS NOT NULL`),
```

**Confirmed, independently of the spec: W01 needs no `device_warranty` migration.** `entitlements` is `jsonb NOT NULL DEFAULT '[]'` — an array of N objects fits with no DDL. `data_source` is `varchar(50)` with **no CHECK and no enum** (`status` is the enum, not `data_source`), so `'agent_cmsl'` (11 chars) is writable today. Because there is no DDL, there is also nothing to register in `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` or `CORE_TENANT_EXPORT_POLICY` — `device_warranty` is already in all of them and **no column is added to it**, which is the only thing that would fire the export-policy contract.

The `targetWhere` the contract warns about, `warrantySync.ts:395-399`:

```ts
395      .onConflictDoUpdate({
396        target: deviceWarranty.deviceId,
397        // device_warranty_device_id_idx is partial since #4622 W03 — the
398        // predicate must be repeated or Postgres cannot infer the arbiter (42P10).
399        targetWhere: sql`${deviceWarranty.deviceId} IS NOT NULL`,
```

Confirmed at `:399`. The same guard exists in `upsertWarranty` (`:296`) and in the importer (`warrantyTarget.ts:229`).

### The agent report path — all three layers

`apps/api/src/routes/agents/schemas.ts:647-675` (confirmed `:658-675`):

```ts
647  /** Coerce date strings to valid ISO date (YYYY-MM-DD) or null.
648   *  Accepts ISO-8601 datetime or date-only formats. */
649  const warrantyDateSchema = z.string().max(50).optional()
650    .transform((val) => {
651      if (!val) return undefined;
652      const d = new Date(val);
653      if (isNaN(d.getTime())) return undefined;
654      // Return date portion only (YYYY-MM-DD) for Postgres date columns
655      return d.toISOString().slice(0, 10);
656    });
657
658  export const agentWarrantyInfoSchema = z.object({
659    source: z.string().min(1).max(50),
660    manufacturer: z.string().min(1).max(100),
661    coverageEndDate: warrantyDateSchema,
662    coverageStartDate: warrantyDateSchema,
663    coverageType: z.string().max(200).optional(),
...
670    coverageKind: z
671      .enum(['subscription', 'fixed'])
672      .or(z.literal(''))
673      .optional(),
674    deviceName: z.string().max(200).optional(),
675  });
```

No `entitlements` key. `z.object` strips unknown keys by default, so an entitlements array is dropped silently today — confirmed.

`apps/api/src/routes/agents/inventory.ts:331-339` — the explicit field selection:

```ts
331      await upsertAgentWarranty(device.id, device.orgId, {
332        source: data.source,
333        manufacturer: data.manufacturer,
334        serialNumber: hw?.serialNumber ?? null,
335        coverageEndDate: data.coverageEndDate ?? null,
336        coverageStartDate: data.coverageStartDate ?? null,
337        coverageType: data.coverageType ?? null,
338        coverageKind: data.coverageKind ?? null,
339      });
```

Confirmed: the serial always comes from `device_hardware` (`:334`), never the payload; `deviceName` is accepted and discarded. A second, independent drop point.

`apps/api/src/services/warrantySync.ts:314-331` — `AgentWarrantyData`, a single coverage window:

```ts
314  /** Upsert warranty data reported directly by the agent (e.g. Apple plist). */
315  export interface AgentWarrantyData {
316    source: string;
317    manufacturer: string;
318    serialNumber: string | null;
319    coverageEndDate: string | null;
320    coverageStartDate: string | null;
321    coverageType: string | null;
...
330    coverageKind?: 'subscription' | 'fixed' | '' | null;
331  }
```

Confirmed: no entitlements, no service-level, no product-number field. Three layers, three separate widenings.

### The CSV importer already stomps `agent_plist` today

`apps/api/src/services/customFields/import/warrantyTarget.ts:179-183` and `:231-241`:

```ts
179    // A manufacturer lookup outranks a hand-typed CSV. Refused here so the
180    // operator gets `skipped-provider-owned` rather than a silent no-op.
181    if (existing && existing.dataSource === 'provider' && !options.overrideProvider) {
182      return 'skipped-provider-owned';
183    }
```

```ts
231        // The AUTHORITY on the provider rule; the read above is advisory. A row
232        // that turns provider-owned between the two matches no target here and
233        // the statement writes nothing rather than clobbering it.
234        ...(options.overrideProvider
235          ? {}
236          : {
237              setWhere: and(
238                sql`${deviceWarranty.dataSource} IS DISTINCT FROM 'provider'`,
239              ),
240            }),
```

Both confirmed at `:181` and `:238`. Neither mentions `agent_plist`, so a CSV import overwrites an agent-collected macOS row today.

**Found while verifying, and in scope:** the importer's **preview** path carries the same `'provider'`-only guard, `apps/api/src/services/customFields/import/valueImport.ts:343-348`:

```ts
343      const existing = state.warrantyByDevice.get(target.deviceId);
344      if (existing?.dataSource === 'provider' && !state.overrideProviderWarranty) {
345        return {
346          annotation: { target: mapping, outcome: 'skipped-provider-owned', warning: PROVIDER_WARRANTY_WARNING },
347        };
348      }
```

Leaving it out would make the preview promise `applied` for a row the apply path refuses — preview and commit disagreeing on the one surface whose entire job is to predict the other, which the file's own comment at `:349-353` says is the failure to avoid. It is in scope: `valueImport.ts` is an API service, not config policy / agent / catalog / web.

`WarrantyImportOutcome` (`import/types.ts:506-511`) is `'applied' | 'skipped-provider-owned' | 'skipped-already-set' | 'rejected' | 'none'`. Its members are mirrored in `apps/api/src/openapi.ts:2957` **and** in `apps/web/src/components/devices/CustomFieldImportPreviewTable.tsx:59-60,130-131,140-141` plus two i18n keys — all of which W01 must not touch. **Decision: reuse `'skipped-provider-owned'` for the agent-owned refusal and add a distinct `warning` string** (a free-form field, not an enum). A dedicated `skipped-agent-owned` member is recorded as a W05 follow-up.

### Manual refresh

`apps/api/src/routes/devices/warranty.ts:41-67`:

```ts
41  // POST /devices/:id/warranty/refresh - Queue on-demand warranty refresh
42  warrantyRoutes.post(
43    '/:id/warranty/refresh',
44    requireScope('organization', 'partner', 'system'),
45    requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
46    requireMfa(),
...
59      // force: an explicit click is the escape hatch when virtualization
60      // detection misfires, and it keeps this endpoint's "queued" promise
61      // truthful — without it a device flagged virtual would never advance
62      // lastSyncAt and the card would poll a refresh that never completes.
63      await queueWarrantySyncForDevice(deviceId, { force: true });
64
65      return c.json({ message: 'Warranty refresh queued' });
66    }
67  );
```

Confirmed `:42-67`, already `devices.write` + `requireMfa()`, always `force: true`, enqueues BullMQ and never reaches the agent. Its imports at `:4` are `{ deviceWarranty, devices }` — `deviceHardware` must be added.

The web caller (`apps/web/src/components/devices/DeviceWarrantyCard.tsx:162-173`) wraps this in `runAction` inside a `try`, and a non-401 `ActionError` is already toasted by `runAction` before `handleActionError` runs — so a 409 surfaces as an error toast and stops the spinner **with no web change**. Today's path instead resolves 200 and then polls `lastSyncAt` (`:182`) until the sweep stamps it, showing "Warranty updated" for a lookup that never happened.

### The winget half of the lab gate

`agent/internal/patching/winget_system.go:73-76` — the scan args, **verbatim, including two flags the spec's prose omits**:

```go
73  func systemScanArgs() []string {
74      return []string{"upgrade", "--include-unknown", "--scope", "machine",
75          "--source", "winget", "--accept-source-agreements", "--disable-interactivity"}
76  }
```

`:78-81` — the install args the probe must mirror exactly:

```go
78  func systemInstallArgs(id string) []string {
79      return []string{"install", "--exact", "--id", id, "--scope", "machine", "--silent",
80          "--accept-package-agreements", "--accept-source-agreements", "--source", "winget", "--disable-interactivity"}
81  }
```

`agent/internal/patching/winget_parse.go:66-73` — the parse is fixed-width on English headers:

```go
66  func parseWingetUpgradeOutput(output string) ([]AvailablePatch, error) {
67      cols := findColumnBoundaries(output, []string{"Name", "Id", "Version", "Available"})
68      if cols == nil {
69          if wingetReportsNoResults(output) {
70              return nil, nil
71          }
72          return nil, errWingetNoTable
73      }
```

So a non-English Windows UI yields `errWingetNoTable` → `ErrScanSkipped` and the probe must record the machine's UI culture.

`agent/internal/heartbeat/heartbeat.go:3571-3588` — the provider→source map:

```go
3571  func (h *Heartbeat) mapPatchProviderSource(provider string) string {
3572      switch provider {
3573      case "windows-update":
3574          return "microsoft"
...
3581      case "winget":
3582          return "third_party"
3583      case "apt", "yum":
3584          return "linux"
3585      default:
3586          return "custom"
3587      }
3588  }
```

**Citation nuance the contract does not spell out:** `:3586`'s `default: "custom"` is reached only when `p.Provider` is not one of the listed ids. The SYSTEM winget provider sets `p.Provider = "winget"` via `manager.go:155,165`, so a genuine machine-scope winget patch maps to `third_party` and *does* qualify for ring auto-approval. The `custom` risk is real but narrow: it fires if the CMSL upgrade is surfaced by some other provider id (e.g. a user-scope pass). `mapPatchSource` (`heartbeat.go:3558-3568`) is a *different* function with its own `default: "custom"`, applied to already-installed patches. **The probe must therefore capture the stored `patches.source` value, not assume it.**

`apps/api/src/services/patchApprovalEvaluator.ts:616-629` — the dual consent:

```ts
616    if (ringAutoApprove.enabled) {
617      if (isThirdPartyPatchSource(patch.source)) {
618        if (!(ringConfig.sources ?? []).includes('third_party')) {
619          return null;
620        }
621        if (!ringAutoApprove.thirdPartyApps) {
622          return null;
623        }
624        const hold = ringAutoApprove.thirdPartyDeferralDays ?? ringAutoApprove.deferralDays;
625        if (isHeldByDeferral(patch, hold, now, 'ring')) {
626          return null;
627        }
628        return 'ring_auto_approve';
629      }
```

Confirmed `:616-629`. Four conditions, all required: ring auto-approve enabled, policy `sources` containing the literal `'third_party'`, ring `autoApprove.thirdPartyApps === true`, and the deferral elapsed. `:610-615`'s comment records that the literal check is deliberately narrower than the `THIRD_PARTY_PATCH_SOURCES = ['third_party', 'custom']` bucket (`:185`), so **a patch stored as `custom` never ring-auto-approves.**

### Test conventions this wave reuses

- `apps/api/src/services/warrantySync.test.ts:5-53` — the file-level `insertMock`/`selectMock`, the `vi.mock('../db', ...)` / `vi.mock('../db/schema', ...)` / `vi.mock('./warrantyProviders', ...)` triple, and the `captureUpsert()` helper that returns `{ values, onConflictDoUpdate }`. Note `normalizeManufacturer` is mocked as `(m) => m.toLowerCase()` at `:34`.
- `apps/api/src/services/warrantySync.manualAsset.test.ts:82-97` — the `queueReads(...)` chainable select mock (`from/leftJoin/innerJoin/where/orderBy` return the chain; `.limit` and `.then` shift one canned result set).
- `apps/api/src/routes/devices/warranty.test.ts:1-62` — the route-test shape: `vi.hoisted` middleware mocks, `vi.mock('../../db', () => ({ db: { select: vi.fn() } }))`, `vi.mock('./helpers', ...)`, and the `registeredPermissionCalls` / `registeredMfaCallCount` module-load snapshots asserted at `:58-62`. **`getDeviceWithOrgAndSiteCheck` is mocked, so it consumes none of the `db.select` queue.**
- `apps/api/src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts:15-71` — `import './setup'`, `const runDb = it.runIf(!!process.env.DATABASE_URL)`, `seedTenant()` from `createPartner`/`createOrganization`/`createSite` in `./db-utils`, raw `getTestDb().execute(sql\`...\`)` for fixtures, and `withSystemDbAccessContext(() => ...)` around every call into a service. Its `:208-252` describe block is the `targetWhere` regression this wave extends; `:225` is the `upsertAgentWarranty` case.
- `apps/api/vitest.integration.config.ts` — `include` carries `'src/__tests__/integration/**/*.test.ts'` as a standing glob, so a new file in that directory needs **no config edit**.
- `apps/api/src/__tests__/integration/setup.ts:215-257` — `CLEANUP_TABLES` truncates `devices`, `device_hardware`, `organizations`, `partners`, `sites` (among ~35) `CASCADE` on **every** `beforeEach`. `device_warranty` is reached by the `devices`/`organizations` cascade. **Consequence used by Task 7: inside one integration test the only devices in the database are the ones that test seeded**, so a `getDevicesNeedingWarrantySync` assertion is deterministic.
- `withSystemDbAccessContext<T>(fn: () => Promise<T>, label?): Promise<T>` (`apps/api/src/db/index.ts:610`) — returns the callback's value, so it can wrap a read.
- `devices.isVirtual` (`db/schema/devices.ts:72`) and `devices.isEphemeral` (`:88`) are both `notNull().default(false)`, so a bare `INSERT INTO devices (...)` fixture passes the sweep's exclusions.
- `scripts/backup-assurance/seed-corpus.ps1:1-14` — the repo's lab-PowerShell convention: an ASCII-only header naming the invocation, a `param(...)` block, `$ErrorActionPreference = 'Stop'`. `scripts/hp-warranty-lab/` is the new sibling directory.

### Migration slot, re-confirmed

```
$ ls apps/api/migrations/*.sql | sort | tail -3
apps/api/migrations/2026-10-15-150100-governance-approval-generation.sql
apps/api/migrations/2026-10-15-150200-pam-dedicated-permissions.sql
apps/api/migrations/2026-10-15-150300-remote-session-revocation-lease.sql
```

Matches D13. **This wave adds none.**

---

## File structure

**Lab half (A)**

- **Create** `scripts/hp-warranty-lab/hp-cmsl-probe.ps1` — one self-contained, five-phase PowerShell probe (`Baseline`, `InstallPinned`, `WingetScan`, `Collect`, `Teardown`). Every phase writes JSON/text artefacts under `-OutRoot` and prints their paths. No Breeze code imports it; it is operator tooling.
- **Create** `scripts/hp-warranty-lab/README.md` — the run order, the safety and licence statement, the per-question pass/fail criteria, the server-side verification SQL, and the verbatim results template for #5512.

**Ingest half (B)**

- **Create** `apps/api/src/services/warrantyDataSources.ts` — the single definition of "an agent wrote this row" and of the entitlement provider. No `db` import, no I/O; pure predicates over strings. Imported by `warrantySync.ts`, `warrantyTarget.ts`, `valueImport.ts`, `routes/devices/warranty.ts` and `routes/agents/schemas.ts`.
- **Create** `apps/api/src/services/warrantyDataSources.test.ts` — unit tests, no mocks needed.
- **Create** `apps/api/src/__tests__/integration/agentWarrantyPreservation.integration.test.ts` — the real-DB data-loss regression and the sweep-selector exclusion.
- **Modify** `apps/api/src/services/warrantySync.ts` — preservation branch (`:153`), entitlement provider (`:367`), entitlements widening (`:315-331`, `:364-373`), sweep selector (`:471-475`).
- **Modify** `apps/api/src/routes/agents/schemas.ts` — bounded `entitlements` on `agentWarrantyInfoSchema`.
- **Modify** `apps/api/src/routes/agents/inventory.ts` — pass `entitlements` through the explicit field selection.
- **Modify** `apps/api/src/services/customFields/import/warrantyTarget.ts` — agent-owned guard + unconditional `setWhere` arm.
- **Modify** `apps/api/src/services/customFields/import/valueImport.ts` — the matching preview guard + its warning string.
- **Modify** `apps/api/src/routes/devices/warranty.ts` — D11's coded refusal.
- **Test (modify)** `apps/api/src/services/warrantySync.test.ts`, `apps/api/src/services/warrantySync.manualAsset.test.ts`, `apps/api/src/routes/devices/warranty.test.ts`, `apps/api/src/services/customFields/import/warrantyTarget.test.ts`, `apps/api/src/routes/agents/inventory.test.ts`, `apps/api/src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts`.

**Explicitly NOT touched:** `apps/web/**`, `agent/**`, `apps/api/src/services/configurationPolicy.ts`, `apps/api/src/services/builtinDeploymentPackages.ts`, `apps/api/src/openapi.ts`, `apps/api/migrations/**`.

---

## Task order and why

Tasks 1-3 (the probe) come first because their deliverable is a **hand-off**: the script and the results template can be committed in an hour, and the hardware runs then happen asynchronously on someone else's clock while Tasks 4-11 proceed. Each of those tasks ends with checkboxes that stay unchecked until real HP results land on #5512 — that is the gate, and it is explicitly *not* a blocker for the code half.

Within the lab half the phase order is forced: **Q1 must be measured on a machine that has never had CMSL installed**, so `Baseline` precedes every install. `InstallPinned` + `WingetScan` (Q2) leave CMSL at the *new* version, which is exactly the state `Collect` (Q3) wants — so Q2 before Q3 avoids an uninstall/reinstall cycle. If Q2 stalls (no ring available, no older version published), Q3 is **not** blocked: install the current version directly and run `Collect`.

---

### Task 1: The probe script and its Baseline phase — Q1, "does the WMI namespace exist without CMSL?"

**Files:**
- Create: `scripts/hp-warranty-lab/hp-cmsl-probe.ps1`
- Create: `scripts/hp-warranty-lab/README.md` (created here, extended in Tasks 2 and 3)

**Interfaces:**
- Produces: a PowerShell script with a `-Phase <Baseline|InstallPinned|WingetScan|Collect|Teardown>` parameter, a `-OutRoot` directory (default `%ProgramData%\BreezeLab\hp-cmsl-probe`) and a `-PinnedVersion` string used only by `InstallPinned`. Tasks 2 and 3 add phases to the same `switch` block; they do not create new scripts.
- Consumes: nothing.

**Why this question decides money.** If HP's factory image already populates `root/HP/InstrumentedServices/v1`, some fraction of the fleet yields warranty data at **zero install and zero EULA exposure** — the T0 tier alone would cover it, and layers 3 and 4 (the built-in catalog package and the update channel, i.e. all of W04) shrink to "the long tail". If the namespace is never present without CMSL, W04 is load-bearing. This is a measurement, not an estimate — the spec says so in "Risks", and no amount of reading HP's documentation substitutes for it.

- [ ] **Step 1: Create the script header, parameters and shared helpers**

Create `scripts/hp-warranty-lab/hp-cmsl-probe.ps1`:

```powershell
# HP CMSL warranty lab probe -- Breeze feature #5511, wave W01 (#5512).
#
# ASCII-only source, PowerShell 5.1 compatible (5.1 is CMSL's own floor, and the
# oldest shell a Breeze-managed Windows endpoint is guaranteed to have). Every
# phase writes artefacts under -OutRoot and prints their paths; paste them onto
# issue #5512 using the template in README.md.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File hp-cmsl-probe.ps1 -Phase Baseline
#   powershell -NoProfile -ExecutionPolicy Bypass -File hp-cmsl-probe.ps1 -Phase InstallPinned -PinnedVersion 1.8.4
#   powershell -NoProfile -ExecutionPolicy Bypass -File hp-cmsl-probe.ps1 -Phase WingetScan
#   powershell -NoProfile -ExecutionPolicy Bypass -File hp-cmsl-probe.ps1 -Phase Collect
#   powershell -NoProfile -ExecutionPolicy Bypass -File hp-cmsl-probe.ps1 -Phase Teardown
#
# WHAT THIS INSTALLS, AND ON WHOSE LICENCE
#   Phases InstallPinned and Collect install HP's Client Management Script
#   Library (winget id HP.HPCMSL) FROM HP, through winget. Breeze never mirrors
#   or hosts that installer: HP's licence says verbatim "You do not have the
#   right to distribute the Software Product". winget's --accept-package-
#   agreements flag (which a silent install requires) accepts HP's EULA ON
#   BEHALF OF THE MACHINE'S OWNER, and HP's licence permits HP to collect
#   technical information including this device's IP address when
#   Get-HPWarrantyInfo calls home. Run those phases ONLY on hardware you own or
#   have written permission to modify. Never run them against a customer
#   endpoint to satisfy this probe.
#
# RATE LIMIT
#   HP throttles the warranty backend to ~300 requests / 5 minutes PER SOURCE
#   IP -- that is per customer NAT, not per device. This script calls
#   Get-HPWarrantyInfo at most twice per run and never loops it.
#
# REVERSIBILITY
#   -Phase Teardown uninstalls HP.HPCMSL through winget and reports what
#   remained. It deliberately does NOT delete the WMI namespace
#   root/HP/InstrumentedServices/v1: whether that namespace survives an
#   uninstall is itself a Q1 datapoint for re-imaged machines, and deleting WMI
#   namespaces by hand on a live endpoint is not a safe operation.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Baseline', 'InstallPinned', 'WingetScan', 'Collect', 'Teardown')]
  [string]$Phase,

  [string]$OutRoot = "$env:ProgramData\BreezeLab\hp-cmsl-probe",

  # InstallPinned only. Must be an OLDER version than the one winget currently
  # publishes, or Q2 has nothing to upgrade.
  [string]$PinnedVersion
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$HpNamespaceV1 = 'root/HP/InstrumentedServices/v1'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $OutRoot ("{0}-{1}" -f $Phase, $stamp)
New-Item -ItemType Directory -Force -Path $out | Out-Null
Write-Host "artefact directory: $out"

function Save-Json {
  param([string]$Name, $Value)
  $path = Join-Path $out "$Name.json"
  # Depth 5: HP's CIM instances nest one level (an array of entitlement rows);
  # deeper only re-serializes CIM plumbing.
  ($Value | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $path -Encoding UTF8
  Write-Host "  wrote $path"
}

function Save-Text {
  param([string]$Name, [string]$Value)
  $path = Join-Path $out "$Name.txt"
  # Raw text, never reflowed: the Breeze winget parser is FIXED-WIDTH on the
  # English column headers, so column positions must survive the capture.
  Set-Content -LiteralPath $path -Value $Value -Encoding UTF8
  Write-Host "  wrote $path"
}

function Get-CimOrNull {
  param([string]$Namespace, [string]$ClassName)
  try { return Get-CimInstance -Namespace $Namespace -ClassName $ClassName -ErrorAction Stop }
  catch { return $null }
}

function Get-CimClassOrNull {
  param([string]$Namespace, [string]$ClassName)
  try { return Get-CimClass -Namespace $Namespace -ClassName $ClassName -ErrorAction Stop }
  catch { return $null }
}

function Describe-Properties {
  # Every property with its CLR type, its raw string, and whether it parses as a
  # date. This is how the HP cache timestamp gets IDENTIFIED rather than
  # guessed: W03's scheduler keys off that value, and its property name is not
  # documented anywhere we can trust.
  param($InputObject)
  if ($null -eq $InputObject) { return @() }
  $first = @($InputObject)[0]
  if ($null -eq $first) { return @() }
  return @($first.PSObject.Properties | ForEach-Object {
    $raw = [string]$_.Value
    $parsed = [datetime]::MinValue
    $isDate = [datetime]::TryParse($raw, [ref]$parsed)
    [pscustomobject]@{
      Name         = $_.Name
      ClrType      = $(if ($null -ne $_.Value) { $_.Value.GetType().FullName } else { '<null>' })
      Raw          = $raw
      ParsesAsDate = $isDate
      ParsedIso    = $(if ($isDate) { $parsed.ToString('o') } else { $null })
    }
  })
}

function Get-HpInstalledSoftware {
  # Registry uninstall keys, NOT Win32_Product. Querying Win32_Product makes the
  # MSI provider run a consistency check -- and frequently a REPAIR -- against
  # every installed MSI on the machine. That is a genuinely destructive thing to
  # do on someone's endpoint. Never use it in this script.
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  return @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'HP*' -or $_.Publisher -like 'HP*' -or $_.Publisher -like 'Hewlett*' } |
    Select-Object DisplayName, DisplayVersion, Publisher, InstallDate |
    Sort-Object DisplayName)
}

function Resolve-WingetPath {
  $cmd = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  # Under SYSTEM (which is how the Breeze agent runs) winget is usually NOT on
  # PATH even when App Installer is present, because the alias lives in a
  # per-user WindowsApps directory. Resolve the machine-scope payload directly
  # -- this is the same class of problem the agent solves internally, and a
  # probe that silently fell back to a user-context winget would answer a
  # different question than the one being asked.
  $candidate = Get-ChildItem 'C:\Program Files\WindowsApps' -Filter 'winget.exe' -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $candidate) { throw 'winget.exe not found: App Installer is missing, or not visible to this account' }
  return $candidate.FullName
}

function Invoke-Winget {
  param([string[]]$WingetArgs, [string]$Name)
  $exePath = Resolve-WingetPath
  Write-Host "  running: $exePath $($WingetArgs -join ' ')"
  $stdout = & $exePath @WingetArgs 2>&1 | Out-String
  Save-Text -Name $Name -Value $stdout
  Save-Json -Name "$Name-meta" -Value ([pscustomobject]@{
    Executable = $exePath
    Arguments  = $WingetArgs
    ExitCode   = $LASTEXITCODE
    RanAs      = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    IsSystem   = [System.Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
  })
  return $stdout
}
```

- [ ] **Step 2: Add the Baseline phase (Q1) to the same file**

Append to `scripts/hp-warranty-lab/hp-cmsl-probe.ps1`:

```powershell
switch ($Phase) {

'Baseline' {
  # Q1 -- does root/HP/InstrumentedServices/v1 exist WITHOUT CMSL installed?
  #
  # MUST run before any install phase on this machine. Once CMSL has run once,
  # this machine can never answer Q1 again.

  Save-Json -Name '01-identity' -Value ([pscustomobject]@{
    Hostname      = $env:COMPUTERNAME
    RunAs         = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    IsSystem      = [System.Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
    PSVersion     = $PSVersionTable.PSVersion.ToString()
    PSEdition     = $PSVersionTable.PSEdition
    OSCaption     = (Get-CimInstance Win32_OperatingSystem).Caption
    OSBuild       = (Get-CimInstance Win32_OperatingSystem).BuildNumber
    OSInstallDate = (Get-CimInstance Win32_OperatingSystem).InstallDate
    CultureTag    = (Get-Culture).Name
    UICultureTag  = (Get-UICulture).Name
    SystemLocale  = $(try { (Get-WinSystemLocale).Name } catch { '<unavailable>' })
    Tls12Enabled  = ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) -ne 0
  })

  Save-Json -Name '02-hardware' -Value ([pscustomobject]@{
    ComputerSystem = Get-CimInstance Win32_ComputerSystem |
      Select-Object Manufacturer, Model, SystemFamily, SystemSKUNumber
    Bios = Get-CimInstance Win32_BIOS |
      Select-Object Manufacturer, SerialNumber, SMBIOSBIOSVersion, ReleaseDate
    Product = Get-CimInstance -ClassName Win32_ComputerSystemProduct |
      Select-Object Name, Vendor, IdentifyingNumber, UUID
  })

  # PROVE CMSL IS ABSENT. Without this, a positive namespace result is
  # meaningless -- the machine may simply have had CMSL installed last year.
  $cmslModules = @(Get-Module -ListAvailable -Name HPCMSL -ErrorAction SilentlyContinue |
    Select-Object Name, Version, ModuleBase)
  $cmslCommand = @(Get-Command Get-HPWarrantyInfo -ErrorAction SilentlyContinue |
    Select-Object Name, Source, Version)
  Save-Json -Name '03-cmsl-absence' -Value ([pscustomobject]@{
    ModulesFound    = $cmslModules
    CommandFound    = $cmslCommand
    HpSoftware      = Get-HpInstalledSoftware
    ModuleDirExists = (Test-Path 'C:\Program Files\WindowsPowerShell\Modules\HPCMSL')
  })
  Invoke-Winget -Name '04-winget-list-hpcmsl' -WingetArgs @(
    'list', '--exact', '--id', 'HP.HPCMSL', '--scope', 'machine',
    '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'
  ) | Out-Null

  # THE QUESTION ITSELF. Walk down, so a negative result says WHERE it stopped:
  # "root\HP does not exist at all" and "root\HP exists but has no
  # InstrumentedServices child" are different findings about HP's factory image.
  $hpChildren  = Get-CimOrNull -Namespace 'root/HP' -ClassName '__NAMESPACE'
  $isvChildren = Get-CimOrNull -Namespace 'root/HP/InstrumentedServices' -ClassName '__NAMESPACE'
  Save-Json -Name '05-namespace-walk' -Value ([pscustomobject]@{
    RootHpExists              = ($null -ne $hpChildren)
    RootHpChildren            = @($hpChildren | Select-Object -ExpandProperty Name -ErrorAction SilentlyContinue)
    InstrumentedServicesExists = ($null -ne $isvChildren)
    InstrumentedServicesChildren = @($isvChildren | Select-Object -ExpandProperty Name -ErrorAction SilentlyContinue)
    # HP's BIOS WMI provider ships on the factory image independently of CMSL.
    # Capturing it distinguishes "this machine has NO HP WMI at all" from
    # "HP WMI is here, the warranty classes are not".
    InstrumentedBiosExists    = ($null -ne (Get-CimOrNull -Namespace 'root/HP/InstrumentedBIOS' -ClassName '__NAMESPACE'))
  })

  $warrantyClass     = Get-CimClassOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Warranty'
  $entitlementsClass = Get-CimClassOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Entitlements'
  $warrantyRows      = Get-CimOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Warranty'
  $entitlementRows   = Get-CimOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Entitlements'

  Save-Json -Name '06-warranty-classes-before-cmsl' -Value ([pscustomobject]@{
    Namespace              = $HpNamespaceV1
    HpWarrantyClassExists      = ($null -ne $warrantyClass)
    HpEntitlementsClassExists  = ($null -ne $entitlementsClass)
    HpWarrantyInstanceCount    = @($warrantyRows).Count
    HpEntitlementsInstanceCount = @($entitlementRows).Count
    HpWarrantyInstances     = @($warrantyRows | Select-Object -Property * -ExcludeProperty Cim*)
    HpEntitlementsInstances = @($entitlementRows | Select-Object -Property * -ExcludeProperty Cim*)
  })
  Save-Json -Name '07-warranty-property-shapes' -Value ([pscustomobject]@{
    HpWarranty     = Describe-Properties $warrantyRows
    HpEntitlements = Describe-Properties $entitlementRows
  })

  Save-Json -Name '08-hp-services' -Value @(Get-Service -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'HP*' -or $_.DisplayName -like 'HP *' } |
    Select-Object Name, DisplayName, Status, StartType)

  Write-Host ''
  Write-Host '=== Q1 ANSWER ==='
  Write-Host ("  CMSL installed already : {0}" -f ($cmslModules.Count -gt 0))
  Write-Host ("  {0} reachable : {1}" -f $HpNamespaceV1, ($null -ne $warrantyClass))
  Write-Host ("  HP_Warranty rows       : {0}" -f @($warrantyRows).Count)
  Write-Host ("  HP_Entitlements rows   : {0}" -f @($entitlementRows).Count)
  Write-Host 'A machine reporting CMSL installed already CANNOT answer Q1 -- record it as INELIGIBLE.'
}

}
```

- [ ] **Step 3: Run it against the operator's own HP machine to prove the script executes**

Run (on any HP Windows device, elevated):

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\hp-warranty-lab\hp-cmsl-probe.ps1 -Phase Baseline
```

Expected: the script completes with no red text and prints an artefact directory containing `01-identity.json` through `08-hp-services.json`. On a **non-HP** machine it still completes — `02-hardware.json` simply reports another manufacturer and `06-…` reports `false`/`0`. A crash here is a script bug, not a finding; fix it before hand-off.

- [ ] **Step 4: Write the README with the safety statement, run order and Q1 criteria**

Create `scripts/hp-warranty-lab/README.md`:

```markdown
# HP CMSL warranty lab probe (Breeze #5511 W01 / #5512)

Answers the three hardware questions wave W01 is the gate for. Results go on
GitHub issue #5512 using the template at the bottom of this file.

## Safety, licence and reversibility — read before running

- Phases `InstallPinned` and `Collect` install HP's Client Management Script
  Library (`HP.HPCMSL`) **from HP, via winget**. Breeze never mirrors or hosts
  that installer: HP's licence states verbatim *"You do not have the right to
  distribute the Software Product."*
- `--accept-package-agreements` (which a silent install requires) **accepts
  HP's EULA on behalf of the machine's owner**. Run those phases only on
  hardware you own or have written permission to modify. Never against a
  customer endpoint.
- HP's licence permits HP to collect technical information **including the
  device's IP address** when `Get-HPWarrantyInfo` calls home.
- HP rate-limits the warranty backend to ~300 requests / 5 minutes **per source
  IP** — per customer NAT, not per device. The script never loops the call.
- `-Phase Teardown` uninstalls CMSL. It does **not** delete the WMI namespace:
  whether `root/HP/InstrumentedServices/v1` survives an uninstall is itself a
  Q1 datapoint, and hand-deleting WMI namespaces on a live endpoint is not safe.
- Nothing in this directory writes to a Breeze database or touches a tenant.

## Run order (forced)

1. `-Phase Baseline` — **must be first on each machine.** Once CMSL has run
   once, that machine can never answer Q1 again.
2. `-Phase InstallPinned -PinnedVersion <older>` then `-Phase WingetScan` — Q2.
3. `-Phase Collect` — Q3. Leaves the machine on the current CMSL.
4. `-Phase Teardown` — optional; returns the machine toward its prior state.

If step 2 cannot be completed (no older version published, no ring available),
**step 3 is not blocked**: install the current version with
`winget install --exact --id HP.HPCMSL --scope machine --silent --accept-package-agreements --accept-source-agreements --source winget --disable-interactivity`
and run `-Phase Collect`.

## Q1 — does `root/HP/InstrumentedServices/v1` exist without CMSL?

Run `-Phase Baseline` on **at least three HP devices with different
provenance**: an untouched OEM image, a corporate re-image (MDT/Autopilot/SCCM
task sequence), and one that has been in service more than a year. One machine
answers nothing useful — the question is what fraction of a real fleet is
pre-populated.

- **Eligible** only if `03-cmsl-absence.json` shows `ModulesFound: []` and
  `CommandFound: []`. A machine with CMSL already installed is INELIGIBLE for
  Q1; record it as such rather than reporting its namespace as a positive.
- **PASS (pre-populated)** — `06-…json` has `HpWarrantyClassExists: true` **and**
  `HpWarrantyInstanceCount >= 1`. A class that exists with zero instances is
  **not** a pass: T0 would read nothing.
- **FAIL (not pre-populated)** — class missing, or present with zero rows.

Consequence, stated up front so the result is not re-litigated later: a
substantial PASS rate means T0 alone covers part of the fleet at zero install
and zero EULA exposure, and W04 (the built-in catalog package that keeps CMSL
installed) covers only the remainder. A uniform FAIL means W04 is load-bearing.
Either way the answer is recorded on #5512 as a table, one row per machine.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/hp-warranty-lab/hp-cmsl-probe.ps1 scripts/hp-warranty-lab/README.md
git commit -m "lab(warranty): HP CMSL probe script + Q1 namespace-without-CMSL baseline phase (#5512)"
```

- [ ] **Step 6 (operator, asynchronous): run Baseline on >= 3 HP devices and post the Q1 table to #5512**

This checkbox stays open until real hardware results exist. It does **not** block Tasks 4-11.

```
| Host | Model | Provenance | CMSL absent? | v1 namespace? | HP_Warranty rows | HP_Entitlements rows |
|------|-------|------------|--------------|---------------|------------------|----------------------|
```

Attach `05-namespace-walk.json`, `06-warranty-classes-before-cmsl.json` and
`07-warranty-property-shapes.json` from each machine.

---

### Task 2: The `InstallPinned` + `WingetScan` phases — Q2, "does a real old→new CMSL upgrade flow through a Breeze third-party ring?"

**Files:**
- Modify: `scripts/hp-warranty-lab/hp-cmsl-probe.ps1` (two new arms in the existing `switch`)
- Modify: `scripts/hp-warranty-lab/README.md` (Q2 section)

**Interfaces:**
- Consumes: Task 1's helpers (`Invoke-Winget`, `Save-Json`, `Save-Text`, `Get-HpInstalledSoftware`, `Resolve-WingetPath`).
- Produces: `-Phase InstallPinned -PinnedVersion <v>` and `-Phase WingetScan`. Leaves CMSL installed, which is the state Task 3 wants.

**What is actually unproven here.** Spec layer 4's *generic* half is real and needs no HP-specific registration: the agent retains the package id (`heartbeat.go:3437`), maps the `winget` provider to `third_party` (`:3581-3582`), ingest upserts `patches` + `device_patches` (`routes/agents/patches.ts:222,289`), and the evaluator loads rings. The unproven link is the **first** one: `winget upgrade --include-unknown --scope machine --source winget` enumerates *winget-tracked packages*, not PowerShell modules. It works only if winget classifies HP's InnoSetup-based installer as a machine-scope package **and** reports an available upgrade for it. `Install-Module -Scope AllUsers` establishes neither condition, and the user-scope fallback does not rescue it — `winget_system.go:186-194` refuses user-only remediation outright.

**If this fails, the decision goes back to Todd — a wave does not pick the fallback.** The fallback (the agent enforcing a floor CMSL version directly) **bypasses the customer's patch-approval rings**, and that was explicitly *not* the chosen option. Record the failure, state which of the four dual-consent conditions (`patchApprovalEvaluator.ts:616-629`) or which parse step broke, and re-open the decision on #5511. Do not implement a floor-version enforcer inside W03 on the strength of a red lab result.

- [ ] **Step 1: Add the `InstallPinned` arm**

Insert into the `switch ($Phase) { ... }` block in `scripts/hp-warranty-lab/hp-cmsl-probe.ps1`, after the `'Baseline'` arm:

```powershell
'InstallPinned' {
  # Q2 setup -- put an OLDER CMSL on the box so there is a real upgrade to see.
  # Installing the current version proves nothing: winget would report no
  # available upgrade and the whole chain would look "broken" for the wrong
  # reason.
  if (-not $PinnedVersion) {
    throw '-PinnedVersion is required for this phase. Run -Phase WingetScan first with no CMSL installed to list published versions, or use: winget show --exact --id HP.HPCMSL --source winget --versions'
  }

  Invoke-Winget -Name '10-available-versions' -WingetArgs @(
    'show', '--exact', '--id', 'HP.HPCMSL', '--source', 'winget',
    '--versions', '--accept-source-agreements', '--disable-interactivity'
  ) | Out-Null

  # EXACTLY the Breeze agent's own machine-scope install argv
  # (winget_system.go:78-81), plus --version. Any deviation answers a different
  # question than the one being asked.
  Invoke-Winget -Name '11-install-pinned' -WingetArgs @(
    'install', '--exact', '--id', 'HP.HPCMSL', '--version', $PinnedVersion,
    '--scope', 'machine', '--silent',
    '--accept-package-agreements', '--accept-source-agreements',
    '--source', 'winget', '--disable-interactivity'
  ) | Out-Null

  Invoke-Winget -Name '12-list-after-install' -WingetArgs @(
    'list', '--exact', '--id', 'HP.HPCMSL', '--scope', 'machine',
    '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'
  ) | Out-Null

  Save-Json -Name '13-post-install-state' -Value ([pscustomobject]@{
    RequestedVersion = $PinnedVersion
    ModulesFound     = @(Get-Module -ListAvailable -Name HPCMSL -ErrorAction SilentlyContinue |
                          Select-Object Name, Version, ModuleBase)
    HpSoftware       = Get-HpInstalledSoftware
  })

  Write-Host ''
  Write-Host '=== InstallPinned done. Next: -Phase WingetScan ==='
}
```

- [ ] **Step 2: Add the `WingetScan` arm**

Insert after the `'InstallPinned'` arm:

```powershell
'WingetScan' {
  # Q2 proper. THREE separate things must hold, and they fail in different
  # places, so all three are captured rather than collapsed into one verdict:
  #
  #  1. winget's machine-scope upgrade list mentions HP.HPCMSL at all;
  #  2. the output is the ENGLISH fixed-width table the Breeze parser needs
  #     (winget_parse.go:66-73 keys on the literal headers Name/Id/Version/
  #     Available; anything else yields errWingetNoTable -> ErrScanSkipped);
  #  3. the row survives the agent -> API -> ring chain, which is verified
  #     server-side, not here.
  #
  # RUN THIS AS SYSTEM. The Breeze agent is a SYSTEM service, and winget behaves
  # differently there (no user profile, different package visibility). Running
  # it as an interactive admin can pass while the agent's own scan finds
  # nothing. See README.md for both ways to get a SYSTEM shell.
  Save-Json -Name '20-scan-context' -Value ([pscustomobject]@{
    RunAs        = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    IsSystem     = [System.Security.Principal.WindowsIdentity]::GetCurrent().IsSystem
    CultureTag   = (Get-Culture).Name
    UICultureTag = (Get-UICulture).Name
    WingetPath   = Resolve-WingetPath
  })
  if (-not [System.Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
    Write-Warning 'NOT running as SYSTEM. This result does not answer Q2 -- see README.md.'
  }

  # Byte-for-byte the agent's scan argv (winget_system.go:73-76).
  $scan = Invoke-Winget -Name '21-system-upgrade-scan' -WingetArgs @(
    'upgrade', '--include-unknown', '--scope', 'machine',
    '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'
  )

  $hasEnglishHeaders = ($scan -match '\bName\b') -and ($scan -match '\bId\b') -and
                       ($scan -match '\bVersion\b') -and ($scan -match '\bAvailable\b')
  $cmslLines = @(($scan -split "`r?`n") | Where-Object { $_ -match 'HP\.HPCMSL' })

  Save-Json -Name '22-scan-verdict' -Value ([pscustomobject]@{
    EnglishHeadersPresent = $hasEnglishHeaders
    CmslRowPresent        = ($cmslLines.Count -gt 0)
    CmslLines             = $cmslLines
  })

  Write-Host ''
  Write-Host '=== Q2 (device half) ==='
  Write-Host ("  English fixed-width headers : {0}" -f $hasEnglishHeaders)
  Write-Host ("  HP.HPCMSL upgrade row       : {0}" -f ($cmslLines.Count -gt 0))
  Write-Host '  Server half: force a Breeze patch scan, then run the SQL in README.md.'
}
```

- [ ] **Step 3: Verify both arms parse**

Run (any Windows machine; `InstallPinned` will fail fast without a real HP box, which is fine — the point is that PowerShell accepts the file):

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('scripts\hp-warranty-lab\hp-cmsl-probe.ps1', [ref]$null, [ref]$errs); $errs"
```

Expected: no parse errors printed.

- [ ] **Step 4: Document Q2 in the README, including the server-side half**

Append to `scripts/hp-warranty-lab/README.md`:

```markdown
## Q2 — does an old→new CMSL upgrade reach a Breeze third-party ring?

**Preconditions, all of them.** Missing one turns a green chain red for the
wrong reason:

1. The device is enrolled in a Breeze instance you control (a worktree stack is
   fine; do not use production).
2. A **patch configuration policy** applying to this device has `sources`
   containing the literal `'third_party'`. The evaluator's check is deliberately
   narrower than its own source bucket — `patchApprovalEvaluator.ts:610-615`
   records that a policy whose sources are only `['custom']` does **not** grant
   third-party auto-approval.
3. The ring that policy links has `autoApprove.enabled = true`,
   `autoApprove.thirdPartyApps = true`, and
   `thirdPartyDeferralDays` (or `deferralDays`) `= 0`, so nothing is held.
   All four conditions: `patchApprovalEvaluator.ts:616-629`.
4. `-Phase WingetScan` runs **as SYSTEM**. Either:
   - run the command through a Breeze script on that device (the agent executes
     scripts as SYSTEM — this is the closest thing to the real path), or
   - `psexec -s -h -w C:\ powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\path\hp-cmsl-probe.ps1 -Phase WingetScan`
     (Sysinternals).

   A pass obtained as an interactive admin does **not** answer Q2.

**Device half — PASS** when `22-scan-verdict.json` reports
`EnglishHeadersPresent: true` **and** `CmslRowPresent: true`.
`EnglishHeadersPresent: false` on a localized Windows is a distinct, expected
finding: the Breeze parser is fixed-width on the English headers
(`winget_parse.go:66-73`) and returns `ErrScanSkipped` — record it as a
localization limitation, not as "CMSL does not surface".

**Server half.** Force a patch scan from Breeze for that device, then query the
API's database:

```sql
SELECT p.source,
       p.package_id,
       p.external_id,
       p.version        AS shared_version,
       p.vendor,
       p.category,
       dp.status,
       dp.available_version,
       dp.scope,
       dp.last_checked_at
FROM device_patches dp
JOIN patches p ON p.id = dp.patch_id
JOIN devices d ON d.id = dp.device_id
WHERE d.hostname = '<HOSTNAME>'
  AND p.package_id ILIKE 'HP.HPCMSL';
```

Local stack: `docker exec -it breeze-postgres psql -U breeze_app -d breeze`.

- **PASS** — a row exists, `p.source = 'third_party'`, and `dp.status` reaches
  `approved` after ring evaluation, and a subsequent install advances the
  installed version.
- **FAIL, ring-shaped** — the row exists but `p.source = 'custom'`. `custom` is
  outside the evaluator's literal `'third_party'` check
  (`patchApprovalEvaluator.ts:617-620`), so it can never ring-auto-approve.
  Record the exact provider id the agent reported.
- **FAIL, scan-shaped** — no row at all. Attach `21-system-upgrade-scan.txt`.

**If Q2 fails, stop.** The fallback — the agent enforcing a floor CMSL version
itself — bypasses the customer's approval rings, which Todd explicitly did not
choose. Post the failure on #5512, summarise which link broke, and re-open the
decision on #5511. **Do not let W03 adopt the fallback on its own authority.**
```

- [ ] **Step 5: Commit**

```bash
git add scripts/hp-warranty-lab/hp-cmsl-probe.ps1 scripts/hp-warranty-lab/README.md
git commit -m "lab(warranty): InstallPinned + WingetScan phases for the CMSL upgrade-through-a-ring gate (#5512)"
```

- [ ] **Step 6 (operator, asynchronous): run Q2 and post the verdict to #5512**

Stays open until real hardware results exist; does not block Tasks 4-11.

---

### Task 3: The `Collect` and `Teardown` phases — Q3, "what does `Get-HPWarrantyInfo` actually return?"

**Files:**
- Modify: `scripts/hp-warranty-lab/hp-cmsl-probe.ps1` (two new arms)
- Modify: `scripts/hp-warranty-lab/README.md` (Q3 section + results template)

**Interfaces:**
- Consumes: Task 1's helpers, especially `Describe-Properties` and `Get-CimOrNull`.
- Produces: `-Phase Collect` and `-Phase Teardown`. The captured JSON is the **input to W03's parser** — W03 writes its fixtures from these files, not from HP's documentation.

**Why the capture has to be this pedantic.** W03's collector reads
`root/HP/InstrumentedServices/v1` through `Get-CimInstance -Namespace`
(spec correction: the agent has no Go WMI binding), and its scheduler keys off
**HP's own cache timestamp** rather than a fixed interval — HP self-caches for
30 days, so a day-25 invocation returns stored data and refreshes nothing. That
timestamp's property name is not documented anywhere trustworthy, which is why
`Describe-Properties` reports every property's CLR type and whether its value
parses as a date: the timestamp gets *identified*, not guessed.

- [ ] **Step 1: Add the `Collect` arm**

Insert after the `'WingetScan'` arm in `scripts/hp-warranty-lab/hp-cmsl-probe.ps1`:

```powershell
'Collect' {
  # Q3 -- the field-by-field capture W03's parser is written against.

  Import-Module HPCMSL -ErrorAction Stop
  Save-Json -Name '30-module' -Value @(Get-Module HPCMSL |
    Select-Object Name, Version, ModuleBase, Path)

  # Does it really take no parameters, and is there any forced-refresh switch?
  # W03 needs to know whether a refresh can be forced AT ALL before designing a
  # due-time policy around HP's 30-day cache.
  $cmd = Get-Command Get-HPWarrantyInfo -ErrorAction Stop
  Save-Json -Name '31-command-surface' -Value ([pscustomobject]@{
    Name          = $cmd.Name
    ModuleName    = $cmd.ModuleName
    ParameterSets = @($cmd.ParameterSets | ForEach-Object { $_.ToString() })
    ParameterNames = @($cmd.Parameters.Keys)
  })
  Save-Text -Name '32-command-help' -Value ((Get-Help Get-HPWarrantyInfo -Full | Out-String))

  # TWO timed calls. A large first / tiny second is the cache doing its job, and
  # is the cheapest possible confirmation of HP's 30-day self-cache claim. Two
  # calls -- never a loop: the backend limit is ~300 requests / 5 minutes per
  # SOURCE IP, i.e. per customer NAT.
  $sw1 = [System.Diagnostics.Stopwatch]::StartNew()
  $first = Get-HPWarrantyInfo
  $sw1.Stop()
  $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
  $second = Get-HPWarrantyInfo
  $sw2.Stop()

  Save-Json -Name '33-cmdlet-output-first'  -Value $first
  Save-Json -Name '34-cmdlet-output-second' -Value $second
  Save-Json -Name '35-cmdlet-timing' -Value ([pscustomobject]@{
    FirstCallMs  = $sw1.ElapsedMilliseconds
    SecondCallMs = $sw2.ElapsedMilliseconds
    CachedLikely = ($sw2.ElapsedMilliseconds * 4) -lt $sw1.ElapsedMilliseconds
  })
  Save-Json -Name '36-cmdlet-property-shapes' -Value (Describe-Properties $first)

  # The WMI side -- this, not the cmdlet's return value, is what the agent's T0
  # tier actually reads.
  $warrantyRows    = Get-CimOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Warranty'
  $entitlementRows = Get-CimOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Entitlements'

  Save-Json -Name '37-wmi-hp-warranty' -Value @($warrantyRows |
    Select-Object -Property * -ExcludeProperty Cim*)
  Save-Json -Name '38-wmi-hp-entitlements' -Value @($entitlementRows |
    Select-Object -Property * -ExcludeProperty Cim*)
  Save-Json -Name '39-wmi-property-shapes' -Value ([pscustomobject]@{
    HpWarranty            = Describe-Properties $warrantyRows
    HpEntitlements        = Describe-Properties $entitlementRows
    HpEntitlementRowCount = @($entitlementRows).Count
  })

  # CIM class metadata: property names WITH their CIM types. A JSON dump alone
  # cannot tell a CIM_DATETIME from a string that happens to look like a date,
  # and W03's parser has to know which it is.
  foreach ($cls in @('HP_Warranty', 'HP_Entitlements')) {
    $c = Get-CimClassOrNull -Namespace $HpNamespaceV1 -ClassName $cls
    Save-Json -Name ("40-cimclass-" + $cls) -Value ([pscustomobject]@{
      ClassName  = $cls
      Exists     = ($null -ne $c)
      Properties = @($c.CimClassProperties | Select-Object Name, CimType, Flags)
    })
  }

  # The exact one-liner shape the agent will run, captured verbatim so W03 can
  # diff its own output against a known-good sample.
  $t0Script = "Get-CimInstance -Namespace '$HpNamespaceV1' -ClassName HP_Entitlements | Select-Object -Property * -ExcludeProperty Cim* | ConvertTo-Json -Depth 5"
  Save-Text -Name '41-t0-oneliner' -Value $t0Script
  Save-Text -Name '42-t0-oneliner-output' -Value ((powershell -NoProfile -NonInteractive -Command $t0Script) | Out-String)

  Write-Host ''
  Write-Host '=== Q3 ANSWER ==='
  Write-Host ("  first call {0} ms, second call {1} ms (cache likely: {2})" -f `
    $sw1.ElapsedMilliseconds, $sw2.ElapsedMilliseconds, (($sw2.ElapsedMilliseconds * 4) -lt $sw1.ElapsedMilliseconds))
  Write-Host ("  HP_Entitlements rows: {0}" -f @($entitlementRows).Count)
  Write-Host '  Identify the cache-timestamp property in 36-/39- (ParsesAsDate = true) and name it on #5512.'
}

'Teardown' {
  Invoke-Winget -Name '90-uninstall' -WingetArgs @(
    'uninstall', '--exact', '--id', 'HP.HPCMSL', '--scope', 'machine',
    '--silent', '--disable-interactivity'
  ) | Out-Null

  # Deliberately reports rather than deletes. Whether the namespace survives an
  # uninstall is a Q1 datapoint for re-imaged machines, and hand-deleting WMI
  # namespaces on a live endpoint is not a safe operation.
  Save-Json -Name '91-post-teardown' -Value ([pscustomobject]@{
    ModulesStillPresent   = @(Get-Module -ListAvailable -Name HPCMSL -ErrorAction SilentlyContinue |
                               Select-Object Name, Version, ModuleBase)
    ModuleDirStillExists  = (Test-Path 'C:\Program Files\WindowsPowerShell\Modules\HPCMSL')
    NamespaceStillPresent = ($null -ne (Get-CimClassOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Warranty'))
    WarrantyRowsRemaining = @(Get-CimOrNull -Namespace $HpNamespaceV1 -ClassName 'HP_Warranty').Count
    HpSoftware            = Get-HpInstalledSoftware
  })
  Write-Host ''
  Write-Host '=== Teardown done. Namespace intentionally left in place -- see 91-post-teardown.json ==='
}
```

- [ ] **Step 2: Verify the file still parses**

Run:

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "$errs=$null; $null = [System.Management.Automation.Language.Parser]::ParseFile('scripts\hp-warranty-lab\hp-cmsl-probe.ps1', [ref]$null, [ref]$errs); $errs"
```

Expected: no parse errors.

- [ ] **Step 3: Document Q3 and add the #5512 results template**

Append to `scripts/hp-warranty-lab/README.md`:

```markdown
## Q3 — what does `Get-HPWarrantyInfo` actually return?

Run `-Phase Collect` on one HP device with CMSL installed (Task 2 leaves it in
that state; otherwise install the current version directly).

Capture and post **all** of:

- `31-command-surface.json` — confirms or refutes "takes no parameters", and
  reveals whether a forced refresh is possible at all.
- `33-cmdlet-output-first.json` + `36-cmdlet-property-shapes.json` — every
  property with its CLR type and whether it parses as a date.
- `35-cmdlet-timing.json` — the two-call timing that confirms the self-cache.
- `37-wmi-hp-warranty.json`, `38-wmi-hp-entitlements.json`,
  `39-wmi-property-shapes.json` — **the rows W03's T0 tier actually reads.**
- `40-cimclass-HP_Warranty.json`, `40-cimclass-HP_Entitlements.json` — property
  names with their CIM types, which a JSON dump alone cannot distinguish.
- `42-t0-oneliner-output.txt` — the literal output of the command W03 will run.

**The one answer that must be stated in words, not just attached:** *which
property carries HP's own cache timestamp, what type it is, and what value it
held.* W03's scheduler keys off that value rather than a fixed interval —
HP self-caches for 30 days, so a day-25 invocation refreshes nothing. Look for
`ParsesAsDate: true` in `36-` and `39-`.

Also state the **entitlement row count** (`39-…HpEntitlementRowCount`) against
the contract's bound of 25 per report. A device exceeding it is a finding.

## Results template — paste onto issue #5512

```
### W01 lab gate results

**Q1 — namespace without CMSL**
| Host | Model | Provenance | CMSL absent? | v1 namespace? | HP_Warranty rows | HP_Entitlements rows |
|------|-------|------------|--------------|---------------|------------------|----------------------|
Verdict: PASS (pre-populated on N of M) / FAIL (never pre-populated)
Consequence for W04:

**Q2 — old→new CMSL upgrade through a Breeze ring**
- Pinned from version: ... → available version: ...
- Ran as SYSTEM: yes/no
- English fixed-width headers present: yes/no
- HP.HPCMSL row in the machine-scope upgrade list: yes/no
- Stored `patches.source`: ...
- `device_patches.status` after ring evaluation: ...
- Install actually applied and version advanced: yes/no
Verdict: PASS / FAIL (which link broke: ...)
If FAIL: decision re-opened with Todd on #5511 — W03 must NOT adopt the
agent-enforced floor-version fallback on its own authority.

**Q3 — Get-HPWarrantyInfo shape**
- Parameters: ...
- Cache-timestamp property: `<name>` (`<type>`), value `<value>`
- Forced refresh possible: yes/no (how)
- Entitlement row count: N (bound is 25)
- Attached: 31/33/35/36/37/38/39/40/42
```
```

- [ ] **Step 4: Commit**

```bash
git add scripts/hp-warranty-lab/hp-cmsl-probe.ps1 scripts/hp-warranty-lab/README.md
git commit -m "lab(warranty): Collect + Teardown phases and the #5512 results template (#5512)"
```

- [ ] **Step 5: Post the hand-off comment on #5512**

```bash
gh issue comment 5512 --body "$(cat <<'EOF'
W01 lab probe is committed: `scripts/hp-warranty-lab/hp-cmsl-probe.ps1` + `README.md`.

Run order (forced — Baseline must be first on each machine, and a machine that
has ever had CMSL installed cannot answer Q1):

1. `-Phase Baseline` on >= 3 HP devices with different provenance (OEM image,
   corporate re-image, >1 year in service).
2. `-Phase InstallPinned -PinnedVersion <older>` then `-Phase WingetScan`
   **as SYSTEM**, with a third-party-enabled ring in place (preconditions in
   README.md).
3. `-Phase Collect` on one device.
4. `-Phase Teardown` when finished.

Read the safety/licence section first: these phases install HP software from HP
and accept HP's EULA on the machine owner's behalf. Own hardware only.

Post results with the template at the bottom of README.md. **W03 (#5514) and
W04 (#5515) stay blocked until Q1/Q2/Q3 are answered here.** W01's ingest half
is independent and proceeds now.
EOF
)"
```

- [ ] **Step 6 (operator, asynchronous): run Q3 and post the answers**

Stays open until real hardware results exist. **The lab half of W01 is not
complete until #5512 carries all three answers**, and W03/W04 must not start
before then.

---

### Task 4: `warrantyDataSources.ts` — the one definition of "an agent wrote this row" (D9)

**Files:**
- Create: `apps/api/src/services/warrantyDataSources.ts`
- Test: `apps/api/src/services/warrantyDataSources.test.ts`

**Interfaces:**
- Consumes: `normalizeManufacturer` (`services/warrantyProviders/index.ts:14`) and the `WarrantyEntitlement` type (`warrantyProviders/types.ts:1-7`). Neither pulls in `../db` — verified in Ground truth.
- Produces, for Tasks 5-10:
  - `AGENT_PLIST_WARRANTY_SOURCE: 'agent_plist'`, `AGENT_CMSL_WARRANTY_SOURCE: 'agent_cmsl'`
  - `AGENT_OWNED_WARRANTY_SOURCE_LIST: readonly ['agent_plist', 'agent_cmsl']`
  - `AGENT_OWNED_WARRANTY_SOURCES: ReadonlySet<string>`
  - `isAgentOwnedWarrantySource(dataSource: string | null | undefined): boolean`
  - `isAgentCollectedWarrantyDevice(input: { manufacturer: string | null | undefined; dataSource: string | null | undefined }): boolean`
  - `warrantyEntitlementProviderForSource(source: string, manufacturer: string): 'dell' | 'hp' | 'lenovo' | 'apple' | null`
  - `MAX_AGENT_WARRANTY_ENTITLEMENTS: 25`

**Why a new module rather than more exports on `warrantySync.ts`.** Four
unrelated writers need the same rule and only two of them want a database. The
manual-refresh route (`routes/devices/warranty.ts`) would otherwise import
`warrantySync.ts` — and with it `../db` — into its unit-test module graph for a
two-line predicate, and `routes/agents/schemas.ts` would import a service just
to read one bound. The module is pure string predicates: no `db`, no I/O, so its
own test needs no mocks at all.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/warrantyDataSources.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  AGENT_CMSL_WARRANTY_SOURCE,
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
  AGENT_OWNED_WARRANTY_SOURCES,
  AGENT_PLIST_WARRANTY_SOURCE,
  MAX_AGENT_WARRANTY_ENTITLEMENTS,
  isAgentCollectedWarrantyDevice,
  isAgentOwnedWarrantySource,
  warrantyEntitlementProviderForSource,
} from './warrantyDataSources';

describe('isAgentOwnedWarrantySource', () => {
  it('recognises both agent collectors', () => {
    expect(isAgentOwnedWarrantySource(AGENT_PLIST_WARRANTY_SOURCE)).toBe(true);
    expect(isAgentOwnedWarrantySource(AGENT_CMSL_WARRANTY_SOURCE)).toBe(true);
  });

  it('does not claim server-written or imported rows', () => {
    expect(isAgentOwnedWarrantySource('provider')).toBe(false);
    expect(isAgentOwnedWarrantySource('import')).toBe(false);
  });

  it('is null-safe — data_source is a nullable varchar with no CHECK', () => {
    expect(isAgentOwnedWarrantySource(null)).toBe(false);
    expect(isAgentOwnedWarrantySource(undefined)).toBe(false);
    expect(isAgentOwnedWarrantySource('')).toBe(false);
  });

  it('keeps the set and the list in agreement', () => {
    expect([...AGENT_OWNED_WARRANTY_SOURCES].sort()).toEqual([...AGENT_OWNED_WARRANTY_SOURCE_LIST].sort());
  });
});

describe('warrantyEntitlementProviderForSource', () => {
  it('derives hp from the CMSL collector — the defect this replaces hardcoded apple', () => {
    expect(warrantyEntitlementProviderForSource(AGENT_CMSL_WARRANTY_SOURCE, 'HP')).toBe('hp');
    expect(warrantyEntitlementProviderForSource(AGENT_CMSL_WARRANTY_SOURCE, 'Hewlett-Packard')).toBe('hp');
  });

  it('keeps apple for the macOS plist collector', () => {
    expect(warrantyEntitlementProviderForSource(AGENT_PLIST_WARRANTY_SOURCE, 'Apple Inc.')).toBe('apple');
  });

  it('falls back to the normalized manufacturer for an unknown source', () => {
    expect(warrantyEntitlementProviderForSource('agent_future', 'Dell Inc.')).toBe('dell');
    expect(warrantyEntitlementProviderForSource('agent_future', 'LENOVO')).toBe('lenovo');
  });

  it('returns null rather than mislabelling coverage it cannot attribute', () => {
    expect(warrantyEntitlementProviderForSource('agent_future', 'Acme Whitebox')).toBeNull();
    expect(warrantyEntitlementProviderForSource('agent_future', '')).toBeNull();
  });

  it('trusts the source over a contradictory manufacturer string', () => {
    // A CMSL report is produced by HP's own tooling on an HP device; a garbled
    // SMBIOS manufacturer must not turn its entitlements into Apple ones.
    expect(warrantyEntitlementProviderForSource(AGENT_CMSL_WARRANTY_SOURCE, 'Apple Inc.')).toBe('hp');
  });
});

describe('isAgentCollectedWarrantyDevice', () => {
  it('is true for any HP device, with or without a stored row', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'HP', dataSource: null })).toBe(true);
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Hewlett-Packard', dataSource: 'provider' })).toBe(true);
  });

  it('is true for a device whose row an agent already owns', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Apple Inc.', dataSource: AGENT_PLIST_WARRANTY_SOURCE })).toBe(true);
  });

  it('is false for a device a registered vendor provider can answer for', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Dell Inc.', dataSource: 'provider' })).toBe(false);
    expect(isAgentCollectedWarrantyDevice({ manufacturer: 'Lenovo', dataSource: null })).toBe(false);
  });

  it('is false when the manufacturer is unknown and no agent row exists', () => {
    expect(isAgentCollectedWarrantyDevice({ manufacturer: null, dataSource: null })).toBe(false);
    expect(isAgentCollectedWarrantyDevice({ manufacturer: '', dataSource: undefined })).toBe(false);
  });
});

describe('MAX_AGENT_WARRANTY_ENTITLEMENTS', () => {
  it('is the contract bound of 25', () => {
    expect(MAX_AGENT_WARRANTY_ENTITLEMENTS).toBe(25);
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/api && npx vitest run src/services/warrantyDataSources.test.ts`
Expected: FAIL — `Failed to resolve import "./warrantyDataSources"`.

- [ ] **Step 3: Write the module**

Create `apps/api/src/services/warrantyDataSources.ts`:

```ts
/**
 * Which `device_warranty.data_source` values were written BY AN AGENT, and
 * which vendor a synthesised agent entitlement belongs to.
 *
 * Its own module rather than more exports on `warrantySync.ts` because four
 * unrelated writers need the same rule and only two of them want a database:
 *   - `warrantySync.ts`                      — the direct sync + the 7-day sweep
 *   - `customFields/import/warrantyTarget.ts` and `valueImport.ts` — CSV import
 *   - `routes/devices/warranty.ts`            — manual refresh
 *   - `routes/agents/schemas.ts`              — the entitlements bound
 * Importing `warrantySync.ts` from a route would drag `../db` into that route's
 * unit-test module graph for a two-line predicate. Nothing here does I/O.
 *
 * THE RULE: a row an agent wrote describes hardware the agent can see. A
 * server-side vendor lookup, or a hand-typed CSV, must never overwrite it — the
 * agent rewrites it on its next report anyway, so the overwrite destroys data
 * and reports success. #5511 W01; `agent_plist` was already exposed to this
 * before HP existed.
 */
import type { WarrantyEntitlement } from './warrantyProviders/types';
import { normalizeManufacturer } from './warrantyProviders';

/** macOS: `CollectAppleWarranty` reads the on-device AppleCare plist. */
export const AGENT_PLIST_WARRANTY_SOURCE = 'agent_plist';
/** Windows/HP: HP CMSL writes `root/HP/InstrumentedServices/v1`; the agent reads it. */
export const AGENT_CMSL_WARRANTY_SOURCE = 'agent_cmsl';

/**
 * Ordered, so SQL predicates generated from it are stable across builds.
 * `device_warranty.data_source` is `varchar(50)` with no CHECK and no enum
 * (`db/schema/warranty.ts:50`), so THIS LIST — not the database — is the
 * definition of "agent-owned".
 */
export const AGENT_OWNED_WARRANTY_SOURCE_LIST = [
  AGENT_PLIST_WARRANTY_SOURCE,
  AGENT_CMSL_WARRANTY_SOURCE,
] as const;

export const AGENT_OWNED_WARRANTY_SOURCES: ReadonlySet<string> = new Set(
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
);

export function isAgentOwnedWarrantySource(dataSource: string | null | undefined): boolean {
  return typeof dataSource === 'string' && AGENT_OWNED_WARRANTY_SOURCES.has(dataSource);
}

/** Contract bound: at most 25 entitlements per agent report. */
export const MAX_AGENT_WARRANTY_ENTITLEMENTS = 25;

type EntitlementProvider = WarrantyEntitlement['provider'];

/** The closed union from `warrantyProviders/types.ts:2`, as a runtime value. */
const ENTITLEMENT_PROVIDERS: readonly EntitlementProvider[] = ['dell', 'hp', 'lenovo', 'apple'];

const SOURCE_ENTITLEMENT_PROVIDER: Readonly<Record<string, EntitlementProvider>> = {
  [AGENT_PLIST_WARRANTY_SOURCE]: 'apple',
  [AGENT_CMSL_WARRANTY_SOURCE]: 'hp',
};

/**
 * The `provider` a synthesised agent entitlement carries.
 *
 * Reporting source FIRST — the collector knows which vendor's data it read, and
 * a garbled SMBIOS manufacturer string must not be able to re-attribute it —
 * then the normalized manufacturer for any future collector not listed here.
 *
 * Returns null when neither resolves, and the caller then synthesises NO
 * entitlement: one stamped with the wrong vendor is worse than a missing one.
 * Everything downstream reads `entitlements[].provider` as ground truth, which
 * is exactly why the hardcoded `provider: 'apple' as const` at
 * `warrantySync.ts:367` was a defect and not a cosmetic default.
 */
export function warrantyEntitlementProviderForSource(
  source: string,
  manufacturer: string,
): EntitlementProvider | null {
  const bySource = SOURCE_ENTITLEMENT_PROVIDER[source];
  if (bySource) return bySource;
  const normalized = normalizeManufacturer(manufacturer ?? '');
  return ENTITLEMENT_PROVIDERS.find((p) => p === normalized) ?? null;
}

/**
 * True when a SERVER-SIDE warranty sync cannot produce anything for this
 * device, so queuing one and answering "refresh queued" would be a lie (D11).
 *
 * Two cases:
 *  - the stored row is already agent-owned — the device, not the server, is its
 *    writer; and
 *  - the device is HP — `warrantyProviders/index.ts:7-12` deliberately does not
 *    register `hpProvider`, so `getProviderForManufacturer` returns null for
 *    every HP device whether or not a row exists yet.
 */
export function isAgentCollectedWarrantyDevice(input: {
  manufacturer: string | null | undefined;
  dataSource: string | null | undefined;
}): boolean {
  if (isAgentOwnedWarrantySource(input.dataSource)) return true;
  return normalizeManufacturer(input.manufacturer ?? '') === 'hp';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/warrantyDataSources.test.ts`
Expected: PASS, 1 file, all cases green.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/warrantyDataSources.ts apps/api/src/services/warrantyDataSources.test.ts
git commit -m "feat(warranty): add warrantyDataSources — one definition of an agent-owned warranty row (D9, #5512)"
```

---

### Task 5: Defect 1 — the synthesised entitlement's provider stops being hardcoded `'apple'`

**Files:**
- Modify: `apps/api/src/services/warrantySync.ts:364-373`
- Test: `apps/api/src/services/warrantySync.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `warrantyEntitlementProviderForSource` from Task 4.
- Produces: nothing new; `upsertAgentWarranty`'s signature is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/warrantySync.test.ts` (the file's existing
`insertMock`, `captureUpsert()`, `DEVICE_ID`, `ORG_ID` and `inDays()` are reused
verbatim — do not redeclare them):

```ts
describe('upsertAgentWarranty entitlement provider (#5511 W01, defect 1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("labels an HP CMSL entitlement 'hp', not 'apple'", async () => {
    const { values, onConflictDoUpdate } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_cmsl',
      manufacturer: 'HP',
      serialNumber: 'HP-SERIAL-1',
      coverageEndDate: inDays(400),
      coverageStartDate: inDays(-100),
      coverageType: 'HP 3y Next Business Day Onsite',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlements: [expect.objectContaining({ provider: 'hp' })],
      }),
    );
    // The UPDATE arm carries the same value — a fix applied to only one of the
    // two would mislabel every row after the first report.
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          entitlements: [expect.objectContaining({ provider: 'hp' })],
        }),
      }),
    );
  });

  it("still labels a macOS plist entitlement 'apple'", async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'APPLE-SERIAL-1',
      coverageEndDate: inDays(400),
      coverageStartDate: inDays(-100),
      coverageType: 'AppleCare+',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlements: [expect.objectContaining({ provider: 'apple' })],
      }),
    );
  });

  it('synthesises no entitlement at all when the vendor cannot be attributed', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_future',
      manufacturer: 'Acme Whitebox',
      serialNumber: 'ACME-1',
      coverageEndDate: inDays(400),
      coverageStartDate: inDays(-100),
      coverageType: 'Some coverage',
    });

    // A mislabelled entitlement is worse than a missing one: everything
    // downstream reads entitlements[].provider as ground truth.
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ entitlements: [] }));
  });
});
```

**Note for the implementer:** this file mocks `./warrantyProviders` with
`normalizeManufacturer: (m: string) => m.toLowerCase()` (`:34`). That mock is
what the *new* module will resolve too, so `'HP'.toLowerCase() === 'hp'`
happens to satisfy the fallback path. The `'hp'` result above comes from the
**source** map, not the manufacturer fallback, so the assertion holds either
way — and `'Acme Whitebox'.toLowerCase()` is not in the union, so the third
case is genuinely exercised.

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/api && npx vitest run src/services/warrantySync.test.ts`
Expected: FAIL — the first case reports `provider: 'apple'` where `'hp'` was
expected; the third reports one entitlement where `[]` was expected. The two
pre-existing describe blocks stay green.

- [ ] **Step 3: Make the change**

In `apps/api/src/services/warrantySync.ts`, add to the imports near `:1-6`:

```ts
import { warrantyEntitlementProviderForSource } from './warrantyDataSources';
```

Replace `:364-373` with:

```ts
  // Build the entitlements array from agent data.
  //
  // The provider is DERIVED, never hardcoded. This read `provider: 'apple' as
  // const` (#5511 W01, defect 1), so every HP entitlement collected by CMSL
  // would have been stored as an Apple entitlement — `'hp'` has been legal in
  // the union (`warrantyProviders/types.ts:2`) the whole time. A null return
  // means the coverage cannot be attributed to a vendor at all, in which case
  // no entitlement is synthesised: a mislabelled one is worse than none.
  const entitlementProvider = warrantyEntitlementProviderForSource(data.source, data.manufacturer);
  const entitlements = data.coverageType && entitlementProvider
    ? [{
        provider: entitlementProvider,
        serviceLevelDescription: data.coverageType,
        entitlementType: data.coverageType,
        startDate: data.coverageStartDate ?? '',
        endDate: data.coverageEndDate ?? '',
      }]
    : [];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/warrantySync.test.ts`
Expected: PASS — all three new cases plus the four pre-existing coverage-kind
cases and the five VM-exclusion cases.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/warrantySync.ts apps/api/src/services/warrantySync.test.ts
git commit -m "fix(warranty): derive the agent entitlement provider instead of hardcoding apple (D10, #5512)"
```

---

### Task 6: Defect 2 — the preservation branch stops being keyed to the literal `'agent_plist'` (real-DB, red-first)

**Files:**
- Create: `apps/api/src/__tests__/integration/agentWarrantyPreservation.integration.test.ts`
- Modify: `apps/api/src/services/warrantySync.ts:153-165`

**Interfaces:**
- Consumes: `isAgentOwnedWarrantySource` from Task 4; `warrantyEntitlementProviderForSource`'s effect from Task 5 (the `'hp'` assertion below relies on it).
- Produces: the new integration file, which Task 7 extends with a second describe block.

**This is the data-loss defect, and its test must be watched failing.** On
unmodified code an `agent_cmsl` row reaching `syncWarrantyForSubject` falls
past `:153`'s literal string comparison into the `!provider` fall-through at
`:170-176`, which calls `upsertWarranty(..., { found: false, entitlements: [],
warrantyStartDate: null, warrantyEndDate: null })` — writing `dataSource:
'provider'` (`:289`/`:305`), erasing both dates and emptying `entitlements`.
Frequent agent reports keep pushing `nextSyncAt` out and mask it until reporting
stops, which is what makes it latent rather than obvious.

**Why it cannot be a unit test.** Every unit suite mocks `../db`, so the branch
is exercised against a canned `dataSource` value rather than against the row the
previous statement actually wrote. The whole point is that the *stored* row
survives the *real* second write.

**No config edit is needed:** `vitest.integration.config.ts`'s `include` already
carries the standing glob `'src/__tests__/integration/**/*.test.ts'`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/integration/agentWarrantyPreservation.integration.test.ts`:

```ts
/**
 * Real-PostgreSQL proof that an AGENT-OWNED warranty row survives the
 * server-side warranty machinery (#5511 W01).
 *
 * Both properties proven here are invisible to the mocked unit suites:
 *
 *  - `syncWarrantyForDevice` reads the STORED row and branches on its
 *    `data_source`. Every unit test mocks `../db`, so that branch runs against
 *    a canned value rather than against the row the previous statement wrote.
 *  - `getDevicesNeedingWarrantySync`'s exclusion is a SQL predicate. The
 *    chainable select mock returns whatever rows it is handed regardless of the
 *    WHERE clause, so a unit test literally cannot fail when it is wrong.
 *
 * On unmodified code the first test is RED: the preservation branch is keyed to
 * the literal 'agent_plist' (`warrantySync.ts:153`), so an `agent_cmsl` row
 * falls through to the unknown-result upsert, which nulls both dates, empties
 * `entitlements` and flips `data_source` back to 'provider'. That is silent
 * data loss, not a cosmetic mislabel.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import {
  getDevicesNeedingWarrantySync,
  syncWarrantyForDevice,
  upsertAgentWarranty,
} from '../../services/warrantySync';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { org, site };
}

/** `is_virtual` and `is_ephemeral` default to false, so this row passes the sweep's exclusions. */
async function seedDevice(orgId: string, siteId: string, agentId: string): Promise<string> {
  const [row] = (await getTestDb().execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${orgId}, ${siteId}, ${agentId}, ${'hp-host-' + agentId}, 'windows', '11', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

/** The sweep requires a NON-NULL serial AND manufacturer on device_hardware. */
async function seedHardware(deviceId: string, orgId: string, manufacturer: string, serial: string): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO device_hardware (device_id, org_id, manufacturer, serial_number)
    VALUES (${deviceId}, ${orgId}, ${manufacturer}, ${serial})
  `);
}

interface StoredWarranty {
  data_source: string | null;
  start_date: string | null;
  end_date: string | null;
  entitlement_count: number;
  entitlement_provider: string | null;
}

async function readWarranty(deviceId: string): Promise<StoredWarranty[]> {
  return (await getTestDb().execute(sql`
    SELECT data_source,
           warranty_start_date::text        AS start_date,
           warranty_end_date::text          AS end_date,
           jsonb_array_length(entitlements) AS entitlement_count,
           entitlements #>> '{0,provider}'  AS entitlement_provider
    FROM device_warranty
    WHERE device_id = ${deviceId}
  `)) as unknown as StoredWarranty[];
}

describe('agent-owned warranty rows survive a server sync (#5511 W01, defect 2)', () => {
  runDb('an agent_cmsl row is preserved, not overwritten with an unknown provider result', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `hp-cmsl-${suffix}`);
    await seedHardware(deviceId, org.id, 'HP', `SN-HP-${suffix}`);

    await withSystemDbAccessContext(() =>
      upsertAgentWarranty(deviceId, org.id, {
        source: 'agent_cmsl',
        manufacturer: 'HP',
        serialNumber: `SN-HP-${suffix}`,
        coverageStartDate: '2024-03-01',
        coverageEndDate: '2099-03-01',
        coverageType: 'HP 3y Next Business Day Onsite',
        coverageKind: 'fixed',
      }),
    );

    // Precondition, asserted rather than assumed: without it a green result
    // below could mean the agent write never landed.
    const before = await readWarranty(deviceId);
    expect(before).toHaveLength(1);
    expect(before[0]!.data_source).toBe('agent_cmsl');

    // EXACTLY what the 7-day sweep does with a selected device subject, and
    // what a manual refresh queues.
    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId));

    const after = await readWarranty(deviceId);
    expect(after).toHaveLength(1);
    expect(
      after[0]!.data_source,
      'a server sweep must never take ownership of an agent-collected row',
    ).toBe('agent_cmsl');
    expect(after[0]!.end_date, 'the agent-reported coverage end date must survive').toBe('2099-03-01');
    expect(after[0]!.start_date).toBe('2024-03-01');
    expect(after[0]!.entitlement_count, 'entitlements must not be emptied').toBe(1);
    expect(after[0]!.entitlement_provider).toBe('hp');
  });

  runDb('an agent_plist row is preserved too — the generalisation did not narrow it', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `apple-plist-${suffix}`);
    await seedHardware(deviceId, org.id, 'Apple Inc.', `SN-APPLE-${suffix}`);

    await withSystemDbAccessContext(() =>
      upsertAgentWarranty(deviceId, org.id, {
        source: 'agent_plist',
        manufacturer: 'Apple Inc.',
        serialNumber: `SN-APPLE-${suffix}`,
        coverageStartDate: '2024-01-01',
        coverageEndDate: '2098-01-01',
        coverageType: 'AppleCare+',
        coverageKind: 'fixed',
      }),
    );

    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId));

    const after = await readWarranty(deviceId);
    expect(after).toHaveLength(1);
    expect(after[0]!.data_source).toBe('agent_plist');
    expect(after[0]!.end_date).toBe('2098-01-01');
    expect(after[0]!.entitlement_provider).toBe('apple');
  });

  runDb('a provider-owned row is still refreshed — the preservation branch did not swallow everyone', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `whitebox-${suffix}`);
    await seedHardware(deviceId, org.id, 'Acme Whitebox', `SN-ACME-${suffix}`);

    // POSITIVE CONTROL. No provider is registered for this manufacturer, so the
    // sync takes the `!provider` fall-through and writes an `unknown` row with
    // data_source 'provider' — which is the CORRECT behaviour for a device no
    // agent has claimed, and must keep working after the fix.
    await withSystemDbAccessContext(() => syncWarrantyForDevice(deviceId));

    const after = await readWarranty(deviceId);
    expect(after).toHaveLength(1);
    expect(after[0]!.data_source).toBe('provider');
  });
});
```

- [ ] **Step 2: Run it against a real database to watch the RED**

Bring the test database up if it is not already running, then run only this file:

```bash
pnpm --filter @breeze/api test:docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agentWarrantyPreservation.integration.test.ts
```

Expected, on unmodified code: **the first case FAILS** with
`expected 'provider' to be 'agent_cmsl'` (and the date/entitlement assertions
would fail too). The second and third cases PASS — the second because
`'agent_plist'` still matches the literal at `:153`, the third because a
provider-owned row is supposed to be rewritten.

**Do not proceed on an assumed red.** If every case passes, the fixture is
wrong — most likely `DATABASE_URL` is unset, so `it.runIf` skipped the whole
file. A skipped suite reports as green. Confirm the runner printed
`3 passed` / `1 failed`, not `3 skipped`.

- [ ] **Step 3: Generalise the preservation branch**

In `apps/api/src/services/warrantySync.ts`, extend the Task 5 import:

```ts
import {
  isAgentOwnedWarrantySource,
  warrantyEntitlementProviderForSource,
} from './warrantyDataSources';
```

Replace `:143-166` with:

```ts
      // Check if we already have agent-reported warranty data for this subject.
      // If so, don't overwrite it with an error — just skip. Only an agent
      // writes an agent-owned source, so only a device subject can carry one.
      if (subject.kind === 'device') {
        const [existing] = await db
          .select({ dataSource: deviceWarranty.dataSource, status: deviceWarranty.status })
          .from(deviceWarranty)
          .where(eq(deviceWarranty.deviceId, subject.deviceId))
          .limit(1);

        // Generalised, not given a second hardcoded string (#5511 W01, D9).
        // Keyed to the literal 'agent_plist', this let an `agent_cmsl` row fall
        // through to the unknown-result upsert below, which nulls both dates,
        // empties `entitlements` and flips `data_source` back to 'provider'.
        if (isAgentOwnedWarrantySource(existing?.dataSource)) {
          // Agent-reported data exists — preserve it regardless of status.
          //
          // `lastSyncAt` is deliberately NOT stamped here: nothing was fetched.
          // That column records the last time warranty data was actually
          // OBTAINED, and the device card polls it to decide whether a manual
          // refresh completed (`DeviceWarrantyCard.tsx:182`). Advancing it on a
          // no-op reports success for a lookup that never happened.
          const now = new Date();
          await db
            .update(deviceWarranty)
            .set({
              lastSyncError: null,
              nextSyncAt: new Date(now.getTime() + SYNC_CADENCE_MS),
              updatedAt: now,
            })
            .where(eq(deviceWarranty.deviceId, subject.deviceId));
          return;
        }
      }
```

**Decision recorded (the contract did not settle it):** dropping `lastSyncAt`
from this `set` is the spec's Layer 6 instruction — *"stop the Apple branch's
habit of stamping `lastSyncAt` when nothing was fetched"* — and it is the reason
Task 10's refusal must cover `agent_plist` as well as HP. The two are a matched
pair: stop the false timestamp, and refuse the refresh up front so nobody waits
on a spinner for it. Distinguishing HP's real *fetch* time from WMI *observation*
time and report *receipt* time needs new columns and therefore a migration, so
it is **not** W01 — it belongs to W03 if it is wanted.

- [ ] **Step 4: Re-run the integration file to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agentWarrantyPreservation.integration.test.ts`
Expected: PASS, `3 passed`.

- [ ] **Step 5: Re-run the unit suites this touched**

Run: `cd apps/api && npx vitest run src/services/warrantySync.test.ts src/services/warrantySync.manualAsset.test.ts`
Expected: PASS, 2 files. (Both filenames are listed explicitly — a bare
`src/services/warrantySync` substring would also drag in unrelated matches, and
a trailing-slash path would skip both.)

- [ ] **Step 6: Commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/warrantySync.ts apps/api/src/__tests__/integration/agentWarrantyPreservation.integration.test.ts
git commit -m "fix(warranty): preserve any agent-owned row on a server sync, not just agent_plist (D9, #5512)

A sweep pass over an agent_cmsl row nulled both coverage dates, emptied
entitlements and flipped data_source back to 'provider'. Real-DB regression
watched failing on unmodified code first."
```

---

### Task 7: The 7-day sweep stops re-selecting agent-owned rows (D9, place 2)

**Files:**
- Modify: `apps/api/src/services/warrantySync.ts:3` (import) and `:471-475` (the device arm's due-ness predicate)
- Test: `apps/api/src/__tests__/integration/agentWarrantyPreservation.integration.test.ts` (second describe block)

**Interfaces:**
- Consumes: `AGENT_OWNED_WARRANTY_SOURCE_LIST` from Task 4; Task 6's preservation branch (the second layer of the same defence).
- Produces: nothing new. `getDevicesNeedingWarrantySync(limit = 50)` keeps its signature.

**Why this is needed once Task 6 already prevents the overwrite.** Two reasons,
both real. First, every selected-but-preserved row consumes one of the page's
`limit` slots (default 50) — an MSP with a large HP fleet would starve the
subjects a vendor *can* answer for out of the sweep indefinitely. Second, it is
defence in depth on a data-loss path: the preservation branch is one `if` away
from the destructive fall-through, and a future refactor that moves it is
otherwise unguarded.

**The NULL trap this predicate has to get right.** `notInArray` compiles to
`NOT IN (...)`, and `NULL NOT IN ('a','b')` evaluates to **NULL**, not TRUE.
A row whose `data_source` was never set would therefore be dropped from the
sweep entirely — fail-closed in the direction that silently stops syncing.
The explicit `isNull(...)` arm is what keeps it eligible, and it is the same
three-valued-logic trap that produced a fail-open SQL guard in W01 of #5099.

- [ ] **Step 1: Write the failing test**

Append a second describe block to
`apps/api/src/__tests__/integration/agentWarrantyPreservation.integration.test.ts`
(it reuses the file's existing `seedTenant`, `seedDevice`, `seedHardware` and
`runDb` — do not redeclare them):

```ts
describe('the fleet sweep excludes agent-owned rows (#5511 W01, D9)', () => {
  runDb('selects a device a vendor can answer for, skips one an agent owns', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const agentDeviceId = await seedDevice(org.id, site.id, `hp-owned-${suffix}`);
    await seedHardware(agentDeviceId, org.id, 'HP', `SN-HP-${suffix}`);

    const providerDeviceId = await seedDevice(org.id, site.id, `dell-provider-${suffix}`);
    await seedHardware(providerDeviceId, org.id, 'Dell Inc.', `SN-DELL-${suffix}`);

    await withSystemDbAccessContext(() =>
      upsertAgentWarranty(agentDeviceId, org.id, {
        source: 'agent_cmsl',
        manufacturer: 'HP',
        serialNumber: `SN-HP-${suffix}`,
        coverageStartDate: '2024-03-01',
        coverageEndDate: '2099-03-01',
        coverageType: 'HP 3y Next Business Day Onsite',
        coverageKind: 'fixed',
      }),
    );

    // upsertAgentWarranty stamped next_sync_at 7 days out. Make the row OVERDUE
    // so it would genuinely be a candidate on unmodified code — otherwise the
    // exclusion assertion below passes for the wrong reason.
    await getTestDb().execute(sql`
      UPDATE device_warranty SET next_sync_at = now() - interval '1 day'
      WHERE device_id = ${agentDeviceId}
    `);

    // The Dell device has no warranty row at all, which is the most overdue
    // state there is (the NULLS FIRST ordering exists for exactly that).
    const subjects = await withSystemDbAccessContext(() => getDevicesNeedingWarrantySync(100));
    const deviceIds = subjects.filter((s) => s.kind === 'device').map((s) => s.deviceId);

    // POSITIVE CONTROL FIRST. setup.ts TRUNCATEs `devices` on every beforeEach,
    // so these two are the only devices in the database — if the sweep returns
    // neither, the exclusion assertion below is vacuous.
    expect(
      deviceIds,
      'the sweep must still pick up a device a registered vendor provider can answer for',
    ).toContain(providerDeviceId);

    expect(
      deviceIds,
      'an agent-owned row must not be re-selected — it can only be overwritten, and it starves the page',
    ).not.toContain(agentDeviceId);
  });

  runDb('a device with NO warranty row is still selected (the NULL data_source arm)', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `never-synced-${suffix}`);
    await seedHardware(deviceId, org.id, 'Dell Inc.', `SN-NEW-${suffix}`);

    const subjects = await withSystemDbAccessContext(() => getDevicesNeedingWarrantySync(100));
    const deviceIds = subjects.filter((s) => s.kind === 'device').map((s) => s.deviceId);

    // `NULL NOT IN (...)` is NULL, not TRUE. Without the explicit isNull arm
    // this device would be silently dropped from the sweep forever.
    expect(deviceIds, 'a never-synced device is the most overdue subject there is').toContain(deviceId);
  });
});
```

- [ ] **Step 2: Run it to watch the first case fail**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agentWarrantyPreservation.integration.test.ts`
Expected: the first new case FAILS with
`an agent-owned row must not be re-selected: expected [ ... ] not to contain '<agentDeviceId>'`.
The second new case PASSES already (it is the regression guard for the fix, not
for the bug), and Task 6's three cases stay green. Confirm the runner reports
`4 passed | 1 failed`, not a skip.

- [ ] **Step 3: Make the change**

In `apps/api/src/services/warrantySync.ts`, extend the drizzle import at `:3`:

```ts
import { eq, and, lt, isNull, or, sql, notInArray } from 'drizzle-orm';
```

and the Task 6 import:

```ts
import {
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
  isAgentOwnedWarrantySource,
  warrantyEntitlementProviderForSource,
} from './warrantyDataSources';
```

Replace `:471-475` (the device arm's due-ness predicate) with:

```ts
        // Either no warranty row at all, or one that is due AND not agent-owned.
        //
        // An agent-owned row must never be re-selected (#5511 W01, D9): no
        // registered provider answers for HP or Apple, so the sync can only
        // overwrite it, and every selected-but-preserved row burns one of this
        // page's `limit` slots — a large HP fleet would starve the subjects a
        // vendor CAN answer for out of the sweep entirely.
        //
        // The explicit isNull arm is load-bearing. `notInArray` compiles to
        // `NOT IN (...)`, and `NULL NOT IN ('a','b')` is NULL, not TRUE — a row
        // whose data_source was never set would otherwise be dropped from the
        // sweep forever, which is the fail-closed direction of the same
        // three-valued-logic trap as #5099 W01.
        or(
          isNull(deviceWarranty.id),
          and(
            lt(deviceWarranty.nextSyncAt, now),
            or(
              isNull(deviceWarranty.dataSource),
              notInArray(deviceWarranty.dataSource, [...AGENT_OWNED_WARRANTY_SOURCE_LIST]),
            ),
          ),
        )
```

The manual-asset arm (`:490-500`) is deliberately unchanged: `device_warranty`'s
XOR subject means only a device row can ever carry an agent-written source.

- [ ] **Step 4: Run the integration file to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/agentWarrantyPreservation.integration.test.ts`
Expected: PASS, `5 passed`.

- [ ] **Step 5: Run the sweep's own unit suite for regressions**

Run: `cd apps/api && npx vitest run src/services/warrantySync.manualAsset.test.ts`
Expected: PASS — the two `getDevicesNeedingWarrantySync` cases at `:204-241`
still hold. They drive a chainable mock that ignores the WHERE clause entirely,
which is precisely why the real assertion lives in the integration file.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/warrantySync.ts apps/api/src/__tests__/integration/agentWarrantyPreservation.integration.test.ts
git commit -m "fix(warranty): exclude agent-owned rows from the 7-day sweep selector (D9, #5512)"
```

---

### Task 8: CSV import stops stomping agent-owned rows, in both the apply and the preview path (D9, place 3)

**Files:**
- Modify: `apps/api/src/services/customFields/import/warrantyTarget.ts:38-47` (imports), `:179-183` (guard), `:231-240` (`setWhere`)
- Modify: `apps/api/src/services/customFields/import/valueImport.ts:161-163` (a second warning constant) and `:343-348` (the preview guard)
- Test: `apps/api/src/services/customFields/import/warrantyTarget.test.ts`

**Interfaces:**
- Consumes: `AGENT_OWNED_WARRANTY_SOURCE_LIST`, `isAgentOwnedWarrantySource` from Task 4.
- Produces: no new exported symbol. `applyWarrantyImport`'s signature and its
  `WarrantyImportOutcome` return union are unchanged **on purpose**.

**Two decisions, both stated because a reviewer will ask.**

1. **The agent-owned guard is unconditional — `overrideProvider` does not unlock
   it.** That option has always meant "override a VENDOR lookup". An agent
   rewrites its row on the next report, so an import that "won" would be
   reverted within one heartbeat while the operator was told `applied`.
2. **The refusal reuses the existing `'skipped-provider-owned'` outcome rather
   than adding a member.** `WarrantyImportOutcome` (`import/types.ts:506-511`)
   is mirrored in `apps/api/src/openapi.ts:2957` and in
   `apps/web/src/components/devices/CustomFieldImportPreviewTable.tsx:59-60,
   130-131,140-141` plus two i18n keys — all outside W01's ownership. A distinct
   `warning` string (a free-form field, not an enum) carries the real reason to
   the operator. A dedicated `skipped-agent-owned` member is a W05 follow-up.

The preview path is included because leaving it out makes the preview promise
`applied` for a row the apply path refuses — preview and commit disagreeing on
the one surface whose entire job is to predict the other, which that file's own
comment at `:349-353` calls out as the failure to avoid.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/customFields/import/warrantyTarget.test.ts`.
It reuses that file's existing helpers verbatim — `rigExisting(existing)`
(`:73-78`), `captureUpsert(returned?)` (`:81-87`), the module-level `tx` handle
(`:92-95`), the `DEVICE` / `ORG` constants (`:57-58`), `inDays()` (`:60-62`) and
the `ExistingWarranty` interface (`:64-70`). Do not redeclare any of them:

```ts
describe('agent-owned warranty rows are never stomped by an import (#5511 W01, D9)', () => {
  const agentRow = (dataSource: string, manufacturer: string): ExistingWarranty => ({
    dataSource,
    warrantyStartDate: null,
    warrantyEndDate: null,
    manufacturer,
    status: 'active',
  });

  it('refuses an agent_cmsl row', async () => {
    rigExisting(agentRow('agent_cmsl', 'hp'));
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(400) },
      { overrideProvider: false },
    );

    expect(outcome).toBe('skipped-provider-owned');
    expect(upsert.values).not.toHaveBeenCalled();
  });

  it('refuses an agent_plist row — the pre-existing macOS exposure', async () => {
    rigExisting(agentRow('agent_plist', 'apple'));
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(400) },
      { overrideProvider: false },
    );

    expect(outcome).toBe('skipped-provider-owned');
    expect(upsert.values).not.toHaveBeenCalled();
  });

  it('refuses an agent-owned row even with overrideProvider — that flag only ever meant "override a VENDOR lookup"', async () => {
    rigExisting(agentRow('agent_cmsl', 'hp'));
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(400) },
      { overrideProvider: true },
    );

    expect(outcome).toBe('skipped-provider-owned');
    expect(upsert.values).not.toHaveBeenCalled();
  });

  it('still writes when nothing owns the row, and keeps the partial-index arbiter', async () => {
    rigExisting(null);
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(400) },
      { overrideProvider: false },
    );

    expect(outcome).toBe('applied');
    // 42P10 guard: device_warranty_device_id_idx is PARTIAL, so the statement
    // must repeat the predicate or Postgres cannot infer the arbiter.
    expect(upsert.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ targetWhere: expect.anything() }),
    );
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/api && npx vitest run src/services/customFields/import/warrantyTarget.test.ts`
Expected: FAIL — the three refusal cases report `'applied'`, and
`upsert.values` was called, because today's guard only tests `=== 'provider'`.
The fourth case passes already; it is the regression guard for the fix.

**Mock note:** this file already mocks `'../../warrantyProviders'` (`:47-50`),
which resolves to the same module `warrantyDataSources.ts` imports, so the new
module picks up that mock's `normalizeManufacturer` — no extra `vi.mock` is
needed. `warrantyDataSources.ts` imports nothing else at runtime.

- [ ] **Step 3: Change the apply path**

In `apps/api/src/services/customFields/import/warrantyTarget.ts`, add to the
imports at `:38-47`:

```ts
import {
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
  isAgentOwnedWarrantySource,
} from '../../warrantyDataSources';
```

Insert immediately **above** the existing provider guard at `:179-183`:

```ts
  // An agent-collected row is owned by the device itself, and `overrideProvider`
  // does NOT unlock it (#5511 W01, D9) — that flag has always meant "override a
  // VENDOR lookup". The agent rewrites this row on its next report, so an import
  // that won here would be reverted within one heartbeat while the operator was
  // told `applied`. Reported as `skipped-provider-owned` rather than a new
  // outcome member: that union is mirrored in `openapi.ts:2957` and in the web
  // import-preview table, both outside this wave's ownership.
  if (existing && isAgentOwnedWarrantySource(existing.dataSource)) {
    return 'skipped-provider-owned';
  }
```

Replace the conditional `setWhere` spread at `:234-240` with an unconditional
`setWhere`:

```ts
      // The AUTHORITY on both ownership rules; the reads above are advisory. A
      // row that turns provider- or agent-owned between the read and the write
      // matches no target here and the statement writes nothing rather than
      // clobbering it. The agent-owned arms are unconditional — see the guard
      // above for why `overrideProvider` does not reach them.
      //
      // `IS DISTINCT FROM` rather than `<>` on every arm: data_source is
      // nullable, and `NULL <> 'provider'` is NULL, which would refuse every
      // brand-new row.
      setWhere: and(
        ...(options.overrideProvider
          ? []
          : [sql`${deviceWarranty.dataSource} IS DISTINCT FROM 'provider'`]),
        ...AGENT_OWNED_WARRANTY_SOURCE_LIST.map(
          (source) => sql`${deviceWarranty.dataSource} IS DISTINCT FROM ${source}`,
        ),
      ),
```

The `targetWhere` at `:229` is untouched — dropping it is a runtime 42P10 on
every imported warranty row.

- [ ] **Step 4: Change the preview path so it predicts the same outcome**

In `apps/api/src/services/customFields/import/valueImport.ts`, add next to
`PROVIDER_WARRANTY_WARNING` at `:161-163`:

```ts
const AGENT_WARRANTY_WARNING =
  'This device reports its own warranty data through the Breeze agent — '
  + 'an import cannot replace it, and the next agent report would overwrite it';
```

and add the import:

```ts
import { isAgentOwnedWarrantySource } from '../../warrantyDataSources';
```

Insert immediately **above** the existing provider check at `:344`:

```ts
    // Mirrors `applyWarrantyImport`'s unconditional agent-owned refusal. Without
    // it the preview reports `applied` for a row the commit refuses — preview
    // and commit disagreeing on the one surface whose whole job is to predict
    // the other (see the comment below, which says exactly that about the
    // already-set case).
    if (isAgentOwnedWarrantySource(existing?.dataSource)) {
      return {
        annotation: { target: mapping, outcome: 'skipped-provider-owned', warning: AGENT_WARRANTY_WARNING },
      };
    }
```

Note the ordering: `const existing = state.warrantyByDevice.get(target.deviceId);`
at `:343` must stay above both checks.

- [ ] **Step 5: Run both suites to verify they pass**

Run: `cd apps/api && npx vitest run src/services/customFields/import/warrantyTarget.test.ts src/services/customFields/import/valueImport.test.ts`
Expected: PASS, 2 files. `valueImport.test.ts:366-371` (the provider-owned
preview case) must still be green — the new branch sits above it and does not
match a `'provider'` row.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/customFields/import/warrantyTarget.ts apps/api/src/services/customFields/import/warrantyTarget.test.ts apps/api/src/services/customFields/import/valueImport.ts
git commit -m "fix(import): CSV import must not overwrite agent-collected warranty rows (D9, #5512)

Guarded in the apply path, its authoritative setWhere, and the preview path, so
preview and commit agree. Unconditional of overrideProvider."
```

---

### Task 9: Entitlements across all three layers of the agent path (D10)

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts:647-675`
- Modify: `apps/api/src/routes/agents/inventory.ts:331-339`
- Modify: `apps/api/src/services/warrantySync.ts:314-331` and the Task 5 entitlements block
- Test: `apps/api/src/routes/agents/schemas.test.ts` (schema bounds)
- Test: create `apps/api/src/routes/agents/inventoryWarranty.test.ts` (handler pass-through)
- Test: `apps/api/src/services/warrantySync.test.ts` (service mapping)
- Test: `apps/api/src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts` (extend the `targetWhere` case)

**Interfaces:**
- Consumes: `MAX_AGENT_WARRANTY_ENTITLEMENTS` and `warrantyEntitlementProviderForSource` from Task 4.
- Produces, for W03's collector:
  ```ts
  export interface AgentWarrantyEntitlement {
    serviceLevelDescription?: string;
    entitlementType?: string;
    startDate?: string;
    endDate?: string;
  }
  ```
  and `AgentWarrantyData.entitlements?: AgentWarrantyEntitlement[] | null`. The
  wire field is `entitlements` on the existing
  `PUT /agents/:id/warranty-info` body. **`provider` is not part of the wire
  shape** — the server derives it.

**Three independent drop points, which is why all three layers move together.**
`agentWarrantyInfoSchema` is a `z.object`, so it strips unknown keys silently
(layer 1). The handler's field selection at `inventory.ts:331-339` is an
explicit object literal that would drop the array even if zod kept it (layer 2).
`AgentWarrantyData` has no such field at all, so the service could not carry it
(layer 3). Widening any two of the three still ships a silent drop.

- [ ] **Step 1: Write the failing schema test**

Append to `apps/api/src/routes/agents/schemas.test.ts`:

```ts
describe('agentWarrantyInfoSchema entitlements (#5511 W01, D10)', () => {
  const base = { source: 'agent_cmsl', manufacturer: 'HP' };

  it('accepts a bounded entitlements array and normalises its dates', () => {
    const parsed = agentWarrantyInfoSchema.parse({
      ...base,
      entitlements: [
        {
          serviceLevelDescription: 'HP 3y Next Business Day Onsite',
          entitlementType: 'Hardware Support',
          startDate: '2024-03-01T00:00:00Z',
          endDate: '2027-02-28',
        },
      ],
    });

    expect(parsed.entitlements).toEqual([
      {
        serviceLevelDescription: 'HP 3y Next Business Day Onsite',
        entitlementType: 'Hardware Support',
        startDate: '2024-03-01',
        endDate: '2027-02-28',
      },
    ]);
  });

  it('rejects more than 25 entitlements', () => {
    const many = Array.from({ length: 26 }, () => ({ entitlementType: 'x' }));
    expect(() => agentWarrantyInfoSchema.parse({ ...base, entitlements: many })).toThrow();
  });

  it('accepts exactly 25', () => {
    const many = Array.from({ length: 25 }, () => ({ entitlementType: 'x' }));
    expect(agentWarrantyInfoSchema.parse({ ...base, entitlements: many }).entitlements).toHaveLength(25);
  });

  it('rejects a string field over 200 chars', () => {
    expect(() =>
      agentWarrantyInfoSchema.parse({
        ...base,
        entitlements: [{ serviceLevelDescription: 'x'.repeat(201) }],
      }),
    ).toThrow();
  });

  it('never accepts a client-supplied provider — the server derives it', () => {
    const parsed = agentWarrantyInfoSchema.parse({
      ...base,
      entitlements: [{ entitlementType: 'Hardware Support', provider: 'apple' }],
    });
    expect(parsed.entitlements![0]).not.toHaveProperty('provider');
  });

  it('still parses a payload with no entitlements at all (macOS plist collectors)', () => {
    const parsed = agentWarrantyInfoSchema.parse({
      source: 'agent_plist',
      manufacturer: 'Apple',
      coverageType: 'AppleCare+',
    });
    expect(parsed.entitlements).toBeUndefined();
  });
});
```

Add `agentWarrantyInfoSchema` to that file's existing import from `./schemas`.

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/api && npx vitest run src/routes/agents/schemas.test.ts`
Expected: FAIL — the first case reports `parsed.entitlements` as `undefined`
(stripped), and the 26-element case does not throw.

- [ ] **Step 3: Widen the schema (layer 1)**

In `apps/api/src/routes/agents/schemas.ts`, add the import at the top of the
file, next to the existing zod import:

```ts
import { MAX_AGENT_WARRANTY_ENTITLEMENTS } from '../../services/warrantyDataSources';
```

Insert between `warrantyDateSchema` (`:649-656`) and `agentWarrantyInfoSchema`:

```ts
/**
 * One entitlement from an agent collector (#5511 W01, D10). HP CMSL reports N
 * of these per device out of `HP_Entitlements`; the macOS plist collector
 * reports none and keeps using the flat `coverageType` fields below.
 *
 * `provider` is deliberately NOT part of the wire shape. The server derives it
 * from `source` (`warrantyEntitlementProviderForSource`): an agent that could
 * name the vendor could label HP coverage as Apple, which is exactly the defect
 * this wave fixes at `warrantySync.ts:367`. `z.object` strips it silently, and
 * the schema test pins that.
 *
 * Dates run through the same `warrantyDateSchema` as the flat fields, so HP's
 * own per-entitlement dates are PRESERVED (never re-derived from the coverage
 * window) while still landing as ISO-8601 `YYYY-MM-DD`. An unparseable date
 * becomes undefined rather than poisoning the jsonb column.
 */
const agentWarrantyEntitlementSchema = z.object({
  serviceLevelDescription: z.string().max(200).optional(),
  entitlementType: z.string().max(200).optional(),
  startDate: warrantyDateSchema,
  endDate: warrantyDateSchema,
});
```

and add one key inside `agentWarrantyInfoSchema`, after `coverageType` (`:663`):

```ts
  entitlements: z.array(agentWarrantyEntitlementSchema).max(MAX_AGENT_WARRANTY_ENTITLEMENTS).optional(),
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/agents/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing handler test (layer 2)**

Create `apps/api/src/routes/agents/inventoryWarranty.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * The warranty-info handler's explicit field selection (`inventory.ts:331-339`)
 * is a SECOND, independent drop point for anything the zod schema accepts: it
 * is a hand-written object literal, so a field can pass validation and still
 * never reach the service. #5511 W01 (D10).
 */
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Real schema objects (cheap table definitions) so the transitive service
// import graph resolves; the client itself is mocked above. Same rationale as
// `inventory.test.ts:15-21`.
vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

const upsertAgentWarrantyMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/warrantySync', () => ({
  upsertAgentWarranty: (...args: unknown[]) => upsertAgentWarrantyMock(...args),
}));

import { db } from '../../db';
import { inventoryRoutes } from './inventory';

function makeApp() {
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('agent', { orgId: 'org-1', agentId: 'agent-1', role: 'agent' });
    await next();
  });
  app.route('/agents', inventoryRoutes);
  return app;
}

/** Two reads in order: the device row, then the hardware row for the serial. */
function rigReads(device: unknown[], hardware: unknown[]) {
  const queue = [device, hardware];
  vi.mocked(db.select).mockImplementation((() => ({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }) }),
  })) as never);
}

describe('PUT /agents/:id/warranty-info entitlements pass-through (#5511 W01, D10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertAgentWarrantyMock.mockResolvedValue(undefined);
  });

  it('forwards the entitlements array to the service', async () => {
    rigReads([{ id: 'device-1', orgId: 'org-1' }], [{ serialNumber: 'HP-SERIAL-1' }]);

    const res = await makeApp().request('/agents/agent-1/warranty-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'agent_cmsl',
        manufacturer: 'HP',
        coverageStartDate: '2024-03-01',
        coverageEndDate: '2027-02-28',
        entitlements: [
          { serviceLevelDescription: 'HP 3y NBD Onsite', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2027-02-28' },
          { serviceLevelDescription: 'HP Pickup and Return', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2026-02-28' },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(upsertAgentWarrantyMock).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({
        source: 'agent_cmsl',
        // The serial always comes from device_hardware, never the payload.
        serialNumber: 'HP-SERIAL-1',
        entitlements: [
          { serviceLevelDescription: 'HP 3y NBD Onsite', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2027-02-28' },
          { serviceLevelDescription: 'HP Pickup and Return', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2026-02-28' },
        ],
      }),
    );
  });

  it('passes null when the collector reports none (macOS plist)', async () => {
    rigReads([{ id: 'device-1', orgId: 'org-1' }], [{ serialNumber: 'APPLE-1' }]);

    const res = await makeApp().request('/agents/agent-1/warranty-info', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'agent_plist', manufacturer: 'Apple', coverageType: 'AppleCare+' }),
    });

    expect(res.status).toBe(200);
    expect(upsertAgentWarrantyMock).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ entitlements: null }),
    );
  });
});
```

- [ ] **Step 6: Run it to watch it fail**

Run: `cd apps/api && npx vitest run src/routes/agents/inventoryWarranty.test.ts`
Expected: FAIL — the first case's `expect.objectContaining({ entitlements: [...] })`
does not match, because the handler's literal never sets the key.

- [ ] **Step 7: Widen the handler (layer 2)**

In `apps/api/src/routes/agents/inventory.ts`, add one line to the call at
`:331-339`, after `coverageKind`:

```ts
      coverageKind: data.coverageKind ?? null,
      // #5511 W01 (D10). This literal is an independent drop point from the zod
      // schema: a field can validate and still never reach the service.
      entitlements: data.entitlements ?? null,
```

- [ ] **Step 8: Run the handler test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/agents/inventoryWarranty.test.ts`
Expected: PASS, 2 cases. This will still be red at the type level until Step 10
adds the field to `AgentWarrantyData` — run `tsc` only after Step 10.

- [ ] **Step 9: Write the failing service test (layer 3)**

Append to `apps/api/src/services/warrantySync.test.ts`:

```ts
describe('upsertAgentWarranty entitlements array (#5511 W01, D10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores every reported entitlement, each stamped with the derived provider", async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_cmsl',
      manufacturer: 'HP',
      serialNumber: 'HP-SERIAL-1',
      coverageStartDate: '2024-03-01',
      coverageEndDate: '2027-02-28',
      coverageType: 'HP 3y Next Business Day Onsite',
      entitlements: [
        { serviceLevelDescription: 'HP 3y NBD Onsite', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2027-02-28' },
        { serviceLevelDescription: 'HP Pickup and Return', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2026-02-28' },
      ],
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlements: [
          { provider: 'hp', serviceLevelDescription: 'HP 3y NBD Onsite', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2027-02-28' },
          { provider: 'hp', serviceLevelDescription: 'HP Pickup and Return', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2026-02-28' },
        ],
      }),
    );
  });

  it('preserves HP dates rather than re-deriving them from the coverage window', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_cmsl',
      manufacturer: 'HP',
      serialNumber: 'HP-SERIAL-2',
      coverageStartDate: '2024-03-01',
      coverageEndDate: '2027-02-28',
      coverageType: 'HP 3y Next Business Day Onsite',
      entitlements: [{ entitlementType: 'Battery', startDate: '2024-03-01', endDate: '2025-03-01' }],
    });

    const written = values.mock.calls[0]![0] as { entitlements: Array<{ endDate: string }> };
    expect(written.entitlements[0]!.endDate).toBe('2025-03-01');
  });

  it('re-slices to the bound so a non-HTTP caller cannot bypass the schema', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_cmsl',
      manufacturer: 'HP',
      serialNumber: 'HP-SERIAL-3',
      coverageStartDate: '2024-03-01',
      coverageEndDate: '2027-02-28',
      coverageType: 'x',
      entitlements: Array.from({ length: 40 }, (_, i) => ({ entitlementType: `e${i}` })),
    });

    const written = values.mock.calls[0]![0] as { entitlements: unknown[] };
    expect(written.entitlements).toHaveLength(25);
  });

  it('falls back to the single synthesised window when the collector reports none', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'APPLE-1',
      coverageStartDate: '2024-01-01',
      coverageEndDate: '2027-01-01',
      coverageType: 'AppleCare+',
      entitlements: null,
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlements: [expect.objectContaining({ provider: 'apple', entitlementType: 'AppleCare+' })],
      }),
    );
  });
});
```

- [ ] **Step 10: Widen the service type and the mapping (layer 3)**

In `apps/api/src/services/warrantySync.ts`, extend the Task 7 import:

```ts
import {
  AGENT_OWNED_WARRANTY_SOURCE_LIST,
  MAX_AGENT_WARRANTY_ENTITLEMENTS,
  isAgentOwnedWarrantySource,
  warrantyEntitlementProviderForSource,
} from './warrantyDataSources';
```

and the type import at `:5`:

```ts
import type { WarrantyEntitlement, WarrantyLookupResult } from './warrantyProviders';
```

Add above `AgentWarrantyData` (`:314`):

```ts
/**
 * One entitlement as an agent collector reports it (#5511 W01, D10). No
 * `provider` field: the server derives that from the reporting source, so an
 * agent cannot attribute HP coverage to Apple.
 */
export interface AgentWarrantyEntitlement {
  serviceLevelDescription?: string;
  entitlementType?: string;
  startDate?: string;
  endDate?: string;
}
```

and one field inside `AgentWarrantyData`, after `coverageKind` (`:330`):

```ts
  /**
   * Per-entitlement coverage rows when the collector produces them (HP CMSL's
   * `HP_Entitlements`). Bounded to MAX_AGENT_WARRANTY_ENTITLEMENTS by
   * `agentWarrantyInfoSchema`, and re-sliced below so a non-HTTP caller cannot
   * bypass that bound. Absent, null or empty keeps the legacy single-window
   * behaviour synthesised from `coverageType`.
   */
  entitlements?: AgentWarrantyEntitlement[] | null;
```

Replace the Task 5 entitlements block with:

```ts
  // Build the entitlements array from agent data.
  //
  // The provider is DERIVED, never hardcoded (#5511 W01, defect 1). A null
  // return means the coverage cannot be attributed to a vendor at all, in which
  // case NO entitlement is synthesised: a mislabelled one is worse than none,
  // because everything downstream reads entitlements[].provider as ground truth.
  //
  // Reported rows win over the synthesised window: HP reports its real
  // per-entitlement dates, which the single coverageStart/End pair cannot
  // express. The .slice is a second bound behind the schema's .max — the schema
  // only guards the HTTP path, and this function is exported.
  const entitlementProvider = warrantyEntitlementProviderForSource(data.source, data.manufacturer);
  const reported = data.entitlements ?? [];
  const entitlements: WarrantyEntitlement[] = !entitlementProvider
    ? []
    : reported.length > 0
      ? reported.slice(0, MAX_AGENT_WARRANTY_ENTITLEMENTS).map((e) => ({
          provider: entitlementProvider,
          serviceLevelDescription: e.serviceLevelDescription ?? '',
          entitlementType: e.entitlementType ?? '',
          startDate: e.startDate ?? '',
          endDate: e.endDate ?? '',
        }))
      : data.coverageType
        ? [{
            provider: entitlementProvider,
            serviceLevelDescription: data.coverageType,
            entitlementType: data.coverageType,
            startDate: data.coverageStartDate ?? '',
            endDate: data.coverageEndDate ?? '',
          }]
        : [];
```

Both the `values(...)` payload (`:389`) and the `onConflictDoUpdate` `set`
(`:408`) already reference this one `entitlements` const — do not duplicate it.

- [ ] **Step 11: Extend the real-DB `targetWhere` regression with an HP payload**

In `apps/api/src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts`,
append inside the `describe('device_warranty upsert arbiters survive the partial indexes (#4622)')`
block that ends at `:253`:

```ts
  runDb('upsertAgentWarranty carries an entitlements ARRAY through both arbiter arms (#5511 W01)', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const deviceId = await seedDevice(org.id, site.id, `xor-hp-entitlements-${suffix}`);

    const payload = {
      source: 'agent_cmsl',
      manufacturer: 'HP',
      serialNumber: `SN-HP-${suffix}`,
      coverageStartDate: '2024-03-01',
      coverageEndDate: '2027-02-28',
      coverageType: 'HP 3y Next Business Day Onsite',
      coverageKind: 'fixed' as const,
      entitlements: [
        { serviceLevelDescription: 'HP 3y NBD Onsite', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2027-02-28' },
        { serviceLevelDescription: 'HP Pickup and Return', entitlementType: 'Hardware Support', startDate: '2024-03-01', endDate: '2026-02-28' },
      ],
    };

    // The INSERT arm, then the ON CONFLICT arm — the one that needs the partial
    // index predicate repeated, or Postgres raises 42P10.
    await withSystemDbAccessContext(() => upsertAgentWarranty(deviceId, org.id, payload));
    await withSystemDbAccessContext(() =>
      upsertAgentWarranty(deviceId, org.id, {
        ...payload,
        entitlements: [...payload.entitlements, { entitlementType: 'Battery', startDate: '2024-03-01', endDate: '2025-03-01' }],
      }),
    );

    const rows = (await getTestDb().execute(sql`
      SELECT data_source,
             jsonb_array_length(entitlements) AS entitlement_count,
             entitlements #>> '{0,provider}'  AS first_provider,
             entitlements #>> '{2,endDate}'   AS third_end_date
      FROM device_warranty WHERE device_id = ${deviceId}
    `)) as unknown as Array<{
      data_source: string | null;
      entitlement_count: number;
      first_provider: string | null;
      third_end_date: string | null;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_source).toBe('agent_cmsl');
    // The UPDATE arm actually ran: three rows, not the two the INSERT wrote.
    expect(rows[0]!.entitlement_count).toBe(3);
    expect(rows[0]!.first_provider).toBe('hp');
    expect(rows[0]!.third_end_date).toBe('2025-03-01');
  });
```

- [ ] **Step 12: Run everything this task touched**

```bash
cd apps/api && npx vitest run \
  src/routes/agents/schemas.test.ts \
  src/routes/agents/inventoryWarranty.test.ts \
  src/services/warrantySync.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts
```

Expected: PASS, 3 unit files; PASS, 1 integration file (`5 passed` — the four
pre-existing cases plus the new one).

- [ ] **Step 13: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/schemas.test.ts \
        apps/api/src/routes/agents/inventory.ts apps/api/src/routes/agents/inventoryWarranty.test.ts \
        apps/api/src/services/warrantySync.ts apps/api/src/services/warrantySync.test.ts \
        apps/api/src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts
git commit -m "feat(warranty): carry agent-reported entitlements through schema, handler and service (D10, #5512)

Three independent drop points, widened together: z.object strips unknown keys,
the handler's field literal drops what zod keeps, and AgentWarrantyData had no
field at all. Bounds: 25 rows, 200 chars, ISO-8601 dates preserved as reported."
```

---

### Task 10: Manual refresh tells the truth for an agent-collected device (D11)

**Files:**
- Modify: `apps/api/src/routes/devices/warranty.ts:4` (import) and `:47-66` (handler)
- Test: `apps/api/src/routes/devices/warranty.test.ts`

**Interfaces:**
- Consumes: `isAgentCollectedWarrantyDevice` from Task 4.
- Produces: a new refusal on `POST /devices/:id/warranty/refresh` —
  `409 { error: string, code: 'WARRANTY_REFRESH_NOT_AVAILABLE' }`. W03 may
  later upgrade this to a real agent-collection trigger; the code string is the
  stable thing a caller branches on.

**What the endpoint does today, and why it is a lie.** It answers
`200 { message: 'Warranty refresh queued' }` and enqueues
`syncWarrantyForDevice(deviceId, { force: true })`. For an HP device that job
reaches `getProviderForManufacturer('HP') === null` — HP has no registered
provider and cannot get one — and, after Task 6, the preservation branch, which
changes nothing an operator can see. The card then polls `lastSyncAt`
(`DeviceWarrantyCard.tsx:182`) waiting for a timestamp that (also after Task 6)
correctly no longer advances.

**Scope decision the contract did not settle — stated so a reviewer can object
deliberately.** D11 says "for HP devices". This ships a predicate that is
`manufacturer normalizes to 'hp'` **OR** `the stored row is agent-owned`, which
additionally covers a Mac carrying an `agent_plist` row. Three reasons: those
devices have the identical dead-end (Apple has no registered provider either);
Task 6 stopped the false `lastSyncAt` stamp that used to make the Mac case
*look* like it succeeded, so without this the Mac case degrades from a false
success into a spinner-to-timeout; and W01 may not touch web, so an immediate
coded refusal is the only honest outcome available to it. A Mac with **no**
warranty row yet is unaffected — it still queues, exactly as today.

**No web change is needed.** `DeviceWarrantyCard.tsx:162-173` wraps the call in
`runAction` inside a `try`; `runAction` already toasts a non-401 `ActionError`,
and the `catch` clears the spinner. A 409 therefore surfaces as an error toast
today. Softening that copy into a purpose-written "collected by the agent"
message is a W05 follow-up.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/devices/warranty.test.ts`. Note this file mocks
`db` as `{ select: vi.fn() }` and mocks `getDeviceWithOrgAndSiteCheck`, so the
handler's two new reads are the **only** consumers of the select queue:

```ts
describe('manual refresh refuses agent-collected devices (#5511 W01, D11)', () => {
  /** Two reads in order: device_hardware.manufacturer, then device_warranty.dataSource. */
  function rigRefreshReads(hardware: unknown[], warranty: unknown[]) {
    const queue = [hardware, warranty];
    vi.mocked(db.select).mockImplementation((() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }) }),
    })) as never);
  }

  beforeEach(() => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: 'device-1', orgId: 'org-123' } as never);
  });

  it('refuses an HP device with a coded 409 instead of queueing a sync that can never answer', async () => {
    rigRefreshReads([{ manufacturer: 'HP' }], []);

    const res = await app.request('/devices/device-1/warranty/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'WARRANTY_REFRESH_NOT_AVAILABLE' });
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
  });

  it('refuses a device whose row an agent already owns', async () => {
    rigRefreshReads([{ manufacturer: 'Apple Inc.' }], [{ dataSource: 'agent_plist' }]);

    const res = await app.request('/devices/device-1/warranty/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(409);
    expect(queueWarrantySyncForDevice).not.toHaveBeenCalled();
  });

  it('still queues for a device a registered vendor provider can answer for', async () => {
    rigRefreshReads([{ manufacturer: 'Dell Inc.' }], [{ dataSource: 'provider' }]);

    const res = await app.request('/devices/device-1/warranty/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledWith('device-1', { force: true });
  });

  it('still queues for a device with no hardware row and no warranty row', async () => {
    rigRefreshReads([], []);

    const res = await app.request('/devices/device-1/warranty/refresh', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(queueWarrantySyncForDevice).toHaveBeenCalledWith('device-1', { force: true });
  });
});
```

The pre-existing case at `:87-101` ("queues a manual refresh with force…") does
not rig `db.select`, so its two new reads resolve against a `vi.fn()` returning
`undefined` and would throw. **Add `rigRefreshReads([], [])` — or the same
inline chain — to that test as part of this step**, keeping its assertions
untouched: with no hardware row and no warranty row the device is not
agent-collected, so it still queues.

- [ ] **Step 2: Run it to watch it fail**

Run: `cd apps/api && npx vitest run src/routes/devices/warranty.test.ts`
Expected: FAIL — the first two new cases return 200 and call
`queueWarrantySyncForDevice`.

- [ ] **Step 3: Make the change**

In `apps/api/src/routes/devices/warranty.ts`, widen the schema import at `:4`
and add the predicate import:

```ts
import { deviceWarranty, deviceHardware, devices } from '../../db/schema';
import { isAgentCollectedWarrantyDevice } from '../../services/warrantyDataSources';
```

Insert into the refresh handler, between the device checks (which end at `:57`)
and the `queueWarrantySyncForDevice` call:

```ts
    // #5511 W01 (D11) — never queue a sync that cannot produce anything.
    //
    // `warrantyProviders/index.ts:7-12` deliberately does not register
    // `hpProvider` (HP's real backend is captcha-gated and its official API is
    // closed to MSPs), so `getProviderForManufacturer` is null for every HP
    // device; and an agent-owned row is written by the device, not the server.
    // In both cases the queued job changes nothing an operator can see, while
    // this endpoint has already answered "Warranty refresh queued" — a promise
    // nothing can keep. Refuse with a code the caller can branch on instead.
    const [hw] = await db
      .select({ manufacturer: deviceHardware.manufacturer })
      .from(deviceHardware)
      .where(eq(deviceHardware.deviceId, deviceId))
      .limit(1);

    const [existingWarranty] = await db
      .select({ dataSource: deviceWarranty.dataSource })
      .from(deviceWarranty)
      .where(eq(deviceWarranty.deviceId, deviceId))
      .limit(1);

    if (
      isAgentCollectedWarrantyDevice({
        manufacturer: hw?.manufacturer ?? null,
        dataSource: existingWarranty?.dataSource ?? null,
      })
    ) {
      return c.json(
        {
          error:
            "This device's warranty is collected by the Breeze agent, not by a vendor lookup. "
            + 'A server-side refresh cannot produce newer data.',
          code: 'WARRANTY_REFRESH_NOT_AVAILABLE',
        },
        409,
      );
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/devices/warranty.test.ts`
Expected: PASS — the four new cases plus the four pre-existing ones, including
`registeredPermissionCalls`/`registeredMfaCallCount` at `:58-62`. That
assertion is a guard worth re-reading: this task adds no middleware, so
`requireMfa` must still be registered exactly once.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/routes/devices/warranty.ts apps/api/src/routes/devices/warranty.test.ts
git commit -m "fix(warranty): refuse manual refresh on agent-collected devices with a coded 409 (D11, #5512)"
```

---

### Task 11: Verification gate — full suites, the real integration run, and the PR

**Files:** none changed. This task is the gate that stops a locally-green branch
from being mistaken for a correct one.

- [ ] **Step 1: Typecheck the whole package**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 2: Lint**

Run: `pnpm --filter @breeze/api lint`
Expected: clean. If a rule is genuinely inapplicable, use `as never` rather than
an `eslint-disable` for an unregistered rule — that disable comment IS itself
the lint error in this repo.

- [ ] **Step 3: Run every unit file this wave touched, by explicit path**

```bash
cd apps/api && npx vitest run \
  src/services/warrantyDataSources.test.ts \
  src/services/warrantySync.test.ts \
  src/services/warrantySync.manualAsset.test.ts \
  src/services/customFields/import/warrantyTarget.test.ts \
  src/services/customFields/import/valueImport.test.ts \
  src/routes/agents/schemas.test.ts \
  src/routes/agents/inventoryWarranty.test.ts \
  src/routes/agents/inventory.test.ts \
  src/routes/devices/warranty.test.ts
```

Expected: PASS, **9 files**. Count them in the output. Paths are listed
individually on purpose: vitest's filter is a plain substring match, so
`src/services/warranty` would silently pull in unrelated files and
`src/services/customFields/import/` (trailing slash) would skip nothing here but
does skip siblings elsewhere.

- [ ] **Step 4: Run the API unit suite for collateral damage**

Run: `cd apps/api && npx vitest run`
Expected: PASS. `warrantyAlertEvaluator.test.ts` and
`warrantyProviderThrottle.test.ts` are the likely collateral — neither is
modified by this wave, and `hpProvider.ts` is deliberately left in place (its
deletion is W05's).

- [ ] **Step 5: Run the integration suites against a real database — this is the step that is not optional**

```bash
pnpm --filter @breeze/api test:docker:up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/agentWarrantyPreservation.integration.test.ts \
  src/__tests__/integration/deviceWarrantyManualSubject.integration.test.ts \
  src/services/warrantyAlertEvaluator.integration.test.ts
```

Expected: PASS, 3 files. **Confirm the runner reports passes, not skips.** Every
case is `it.runIf(!!process.env.DATABASE_URL)`; with `DATABASE_URL` unset the
whole file reports green while executing nothing, which is the exact shape of a
false negative this wave cannot afford. `src/__tests__/integration/setup.ts:32-33`
defaults to `postgresql://breeze_test:breeze_test@localhost:5433/breeze_test`,
which `docker-compose.test.yml` provisions — but the `runIf` reads the env var,
so it must actually be exported in the shell running vitest.

- [ ] **Step 6: Re-confirm no migration is needed, and that no cascade list moved**

```bash
grep -n "entitlements\|data_source" apps/api/src/db/schema/warranty.ts
git diff --name-only origin/main... -- apps/api/migrations/
grep -rn "device_warranty" apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/tenantExportPolicyRegistry.ts
```

Expected: `entitlements` is still `jsonb ... notNull().default([])` and
`data_source` still `varchar(50)` with no CHECK; **the migrations diff is
empty**; and `device_warranty` still appears in all three registries with the
same column classification. This wave adds **no column to any org-cascade
table**, which is the only thing that fires the export-policy contract on a
non-DDL change. Also re-run `ls apps/api/migrations/*.sql | sort | tail -1` and
confirm nothing now sorts after `2026-10-15-150300` that would invalidate D13's
statement in the PR body.

- [ ] **Step 7: Merge main and re-verify — a local branch green is not a CI green**

```bash
git fetch origin && git merge origin/main
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/services/warrantySync.test.ts src/routes/devices/warranty.test.ts
```

PR CI tests the **merge commit**, not your branch tip.

- [ ] **Step 8: Open the PR**

```bash
gh pr create --title "W01: HP warranty lab probe + warranty ingest hardening (#5512)" --body "$(cat <<'EOF'
Closes #5512

Wave W01 of #5511. Two halves.

## A — lab probe (procedure, not a result)

`scripts/hp-warranty-lab/hp-cmsl-probe.ps1` + `README.md`: a five-phase,
reversible probe answering the three questions W03/W04 are gated on —
(1) does `root/HP/InstrumentedServices/v1` exist without CMSL, (2) does a real
old→new CMSL upgrade surface through `winget upgrade --include-unknown --scope
machine --source winget` and flow through a Breeze third-party ring, (3) what
does `Get-HPWarrantyInfo` return field by field, including its own cache
timestamp. Results are posted to #5512; **W03 and W04 stay blocked until they
land.** If (2) fails, the decision goes back to Todd on #5511 — the fallback
(the agent enforcing a floor version) bypasses customer approval rings and was
explicitly not chosen.

The probe installs HP CMSL **from HP via winget** and never mirrors it; HP's
licence forbids redistribution, and `--accept-package-agreements` accepts HP's
EULA on the machine owner's behalf. Own hardware only.

## B — ingest hardening

- **New** `services/warrantyDataSources.ts` — one definition of an agent-owned
  warranty row (D9), applied in all three places the contract names plus the
  importer's preview path.
- **Data-loss fix:** a server sweep over an `agent_cmsl` row nulled both
  coverage dates, emptied `entitlements` and flipped `data_source` back to
  `provider`. Real-DB regression watched failing on unmodified code first.
- **Mislabel fix:** the synthesised agent entitlement's `provider` is derived
  from the reporting source instead of the hardcoded `'apple' as const`.
- **Sweep selector** no longer re-selects agent-owned rows (they can only be
  overwritten, and they starve the page's `limit`). The explicit `isNull` arm is
  load-bearing: `NULL NOT IN (...)` is NULL, not TRUE.
- **CSV import** stops stomping agent-owned rows, in the apply path, its
  authoritative `setWhere`, and the preview path so the two agree.
  Unconditional of `overrideProvider`.
- **Entitlements (D10)** now cross all three layers of the agent path — zod
  schema, the handler's field literal, and `AgentWarrantyData` — bounded at 25
  rows / 200 chars, HP's own dates preserved. Any two of the three still ships a
  silent drop.
- **Manual refresh (D11)** returns `409 WARRANTY_REFRESH_NOT_AVAILABLE` for an
  agent-collected device instead of queueing a sync that can never answer.

## No migration

Confirmed against `db/schema/warranty.ts:49-50`, not against the spec:
`entitlements` is `jsonb NOT NULL DEFAULT '[]'` and `data_source` is
`varchar(50)` with no CHECK and no enum. No column is added to any org-cascade
table, so no cascade or export-policy registration changes. `targetWhere` is
preserved on every upsert (42P10).

## Decisions this PR made that the contract left open

1. D11's refusal covers **agent-owned rows generally**, not only HP — a Mac
   `agent_plist` row has the identical dead end, and Task 6 removed the false
   `lastSyncAt` stamp that used to make it look successful.
2. The importer refusal reuses `skipped-provider-owned` rather than adding a
   `WarrantyImportOutcome` member, because that union is mirrored in
   `openapi.ts` and in web, both outside W01's ownership. A dedicated member is
   a W05 follow-up.
3. The importer's **preview** path is included alongside the apply path so the
   two cannot disagree.

## Verification

- `tsc --noEmit`, `lint`, full API unit suite.
- Integration (real Postgres): `agentWarrantyPreservation`,
  `deviceWarrantyManualSubject`, `warrantyAlertEvaluator` — confirmed executed,
  not `runIf`-skipped.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

- [ ] **Step 9: Record the wave state**

```bash
gh issue comment 5512 --body "Ingest half of W01 is open as a PR. The lab half is committed as a procedure; Q1/Q2/Q3 answers are still outstanding and W03 (#5514) / W04 (#5515) remain blocked on them."
```

---

## Self-review

**1. Spec coverage.** Every W01 item in the contract's ownership row maps to a
task:

| Contract item | Task |
|---|---|
| The lab probe and its recorded answers (Q1/Q2/Q3) | 1, 2, 3 |
| Defect 2 — preservation branch (`warrantySync.ts:153`) | 6 |
| Defect 1 — `provider: 'apple' as const` (`:367`) | 5 |
| D9 `AGENT_OWNED_WARRANTY_SOURCES` / `isAgentOwnedWarrantySource` | 4 |
| D9 place 1 — preservation branch | 6 |
| D9 place 2 — sweep selector / direct sync | 7 |
| D9 place 3 — `warrantyTarget.ts:181,238` | 8 |
| D10 — entitlements across schema, handler, service type | 9 |
| D11 — manual-refresh honesty | 10 |
| "No migration is needed — confirm it yourself" | Ground truth §"No migration is needed"; re-checked in Task 11 Step 6 |
| `targetWhere` preserved; extend `deviceWarrantyManualSubject.integration.test.ts:225` | 9 Step 11; asserted again in 8 Step 1 |
| Red-first, real-DB, watched failing | 6 Step 2 (explicit "do not proceed on an assumed red") |
| Integration run with `vitest.integration.config.ts` | 6 Step 2/4, 7 Step 4, 9 Step 12, 11 Step 5 |

Spec items deliberately **not** covered, each with its owner: the `agent_cmsl`
label in `DeviceWarrantyCard.tsx`, deleting `hpProvider.ts` / `HP_WARRANTY_ENABLED`
and the docs update (all W05); the `hpCmsl` opt-in block, consent, the MFA gate
and D12's guard arm (W02); the collector and its scheduling (W03); the built-in
catalog package (W04). The spec's "distinguish HP's real fetch timestamp from
WMI observation time and report receipt time" needs new columns and therefore a
migration, so it is flagged in Task 6 Step 3 as W03's, not silently dropped.

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task
N", no "write tests for the above". Every code step carries complete code,
including all five PowerShell phases. Two things are deliberately parameterised
rather than fixed, and both say so: `-PinnedVersion` (the operator reads the
published version list in the same phase) and the `<HOSTNAME>` in the
verification SQL.

**3. Type consistency.** `isAgentOwnedWarrantySource`,
`isAgentCollectedWarrantyDevice`, `warrantyEntitlementProviderForSource`,
`AGENT_OWNED_WARRANTY_SOURCE_LIST`, `AGENT_OWNED_WARRANTY_SOURCES`,
`MAX_AGENT_WARRANTY_ENTITLEMENTS`, `AGENT_PLIST_WARRANTY_SOURCE` and
`AGENT_CMSL_WARRANTY_SOURCE` are defined once in Task 4 and used under exactly
those names in Tasks 5-10. `AgentWarrantyEntitlement` is defined in Task 9 and
referenced only there and by W03. The import line in `warrantySync.ts` grows
across Tasks 5 → 6 → 7 → 9 and each task shows the **complete** line for its
point in the sequence, not a fragment. The test-helper names in Task 8
(`rigExisting`, `captureUpsert`, `tx`, `DEVICE`, `ORG`, `inDays`,
`ExistingWarranty`) were read out of the existing file rather than invented, and
differ from the `DEVICE_ID`/`ORG_ID` used in `warrantySync.test.ts` — that
difference is real and is called out at the point of use.

**4. Fixed during review.** Task 8's first draft invented a `makeExecutor(...)`
helper; corrected to the file's real `rigExisting`/`captureUpsert`/`tx`. The
contract's `getDevicesNeedingWarrantySync` span (`:454-484`) was corrected to
`:454-524` in Ground truth. Task 10 Step 1 gained the instruction to rig
`db.select` in the pre-existing refresh test, which the new reads would
otherwise break.
