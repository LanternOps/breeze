# Network Device Type Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users manually override a network-discovered device's type, and keep that override sticky across re-scans.

**Architecture:** Add provenance columns (`type_source`, `detected_asset_type`) to `discovered_assets` mirroring the existing `link_source` pattern. The `PATCH /discovery/assets/:id` route gains an `assetType` field (sets `type_source='manual'`) and a `resetTypeToAuto` flag (restores the scan's last classification). The discovery worker preserves `asset_type` when `type_source='manual'` but always records what the scan would have assigned. Two web surfaces get an editable type Select.

**Tech Stack:** Hono + Drizzle (API), hand-written SQL migration, BullMQ worker, Astro + React (web), Vitest.

## Global Constraints

- Migrations are hand-written SQL in `apps/api/migrations/`, idempotent, no inner `BEGIN;`/`COMMIT;`, filename `YYYY-MM-DD-<slug>.sql`. Never edit a shipped migration.
- `discovered_assets` is an existing tenant-scoped table (shape 1, direct `org_id`, RLS auto-discovered). Adding columns requires **no** RLS policy change and **no** `rls-coverage.integration.test.ts` allowlist edit.
- Web mutations go through `runAction` where the surface already uses it; follow each file's existing pattern (the detail page uses `runAction`; the modal currently uses `fetchWithAuth` for its save handler — match the file).
- Enum values (12), authoritative everywhere: `workstation, server, printer, router, switch, firewall, access_point, phone, iot, camera, nas, unknown`.
- Run all commands from the worktree root: `/Users/toddhebebrand/breeze/.claude/worktrees/slice2-1424-network-detail`.

---

### Task 1: DB columns — migration + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-06-28-discovered-asset-type-source.sql`
- Modify: `apps/api/src/db/schema/discovery.ts` (enum block ~line 45; table ~line 135)

**Interfaces:**
- Produces: `discoveredAssetTypeSourceEnum` pgEnum (`'manual' | 'auto'`); `discoveredAssets.typeSource` (NOT NULL default `'auto'`); `discoveredAssets.detectedAssetType` (nullable, same enum as `assetType`).

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-28-discovered-asset-type-source.sql`:

```sql
-- Type provenance for a discovered asset: 'manual' (a user set the type by hand)
-- or 'auto' (the discovery scan classified it). Once 'manual', re-scans never
-- overwrite asset_type. detected_asset_type always records what the most recent
-- scan WOULD have assigned, so "reset to auto" can restore it instantly.
-- Mirrors the link_source provenance pattern. discovered_asset_type enum already
-- exists (created with the table); reuse it for detected_asset_type.

DO $$
BEGIN
  CREATE TYPE discovered_asset_type_source AS ENUM ('manual', 'auto');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS type_source discovered_asset_type_source NOT NULL DEFAULT 'auto';

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS detected_asset_type discovered_asset_type;
```

- [ ] **Step 2: Add the enum + columns to the Drizzle schema**

In `apps/api/src/db/schema/discovery.ts`, after the `discoveredAssetLinkSourceEnum` block (ends line 48), add:

```typescript
export const discoveredAssetTypeSourceEnum = pgEnum('discovered_asset_type_source', [
  'manual',
  'auto'
]);
```

In the `discoveredAssets` table, immediately after the `linkSource` line (line 135), add:

```typescript
  typeSource: discoveredAssetTypeSourceEnum('type_source').notNull().default('auto'),
  detectedAssetType: discoveredAssetTypeEnum('detected_asset_type'),
```

- [ ] **Step 3: Verify schema matches migration (no drift)**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
```
Expected: no drift reported (schema and migrations agree). If the DB is empty/unavailable, start it first per CLAUDE.md docker instructions.

- [ ] **Step 4: Run the migration-ordering regression test**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
```
Expected: PASS (new migration sorts cleanly after the link-source migration; no same-day dependency).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-28-discovered-asset-type-source.sql apps/api/src/db/schema/discovery.ts
git commit -m "feat(api): type provenance columns for discovered assets (#1424)"
```

---

### Task 2: API — accept type override, surface provenance

**Files:**
- Modify: `apps/api/src/routes/discovery.ts` (`updateAssetSchema` line 336; PATCH handler lines 1150-1153; GET list serialization ~line 936; GET single serialization ~line 1035)
- Test: `apps/api/src/routes/discovery.test.ts`

**Interfaces:**
- Consumes: `discoveredAssetTypeEnum`, `discoveredAssets.typeSource`, `discoveredAssets.detectedAssetType` from Task 1.
- Produces: `PATCH /discovery/assets/:id` accepts `{ assetType?, resetTypeToAuto? }`; GET responses include `typeSource` and `detectedAssetType`.

- [ ] **Step 1: Write failing API tests**

In `apps/api/src/routes/discovery.test.ts`, add a `describe('PATCH /assets/:id type override', ...)` block. Mirror the existing PATCH test setup in that file (same auth/mock harness already used for label/notes/tags). Tests:

```typescript
it('sets assetType and marks type_source=manual', async () => {
  // PATCH the seeded asset with { assetType: 'router' }
  // expect 200, body.assetType === 'router', body.typeSource === 'manual'
});

it('rejects an invalid assetType value', async () => {
  // PATCH with { assetType: 'gateway' } (not in enum)
  // expect 400
});

it('rejects assetType and resetTypeToAuto together', async () => {
  // PATCH with { assetType: 'router', resetTypeToAuto: true }
  // expect 400
});

it('resetTypeToAuto restores detected_asset_type and sets type_source=auto', async () => {
  // seed asset with assetType='router', typeSource='manual', detectedAssetType='workstation'
  // PATCH with { resetTypeToAuto: true }
  // expect 200, body.assetType === 'workstation', body.typeSource === 'auto'
});

it('GET /assets/:id returns typeSource and detectedAssetType', async () => {
  // expect body.data.typeSource and body.data.detectedAssetType present
});
```

Follow the Drizzle mock conventions from the `breeze-testing` skill and the existing PATCH tests in this same file (copy their mock-builder usage verbatim, changing only the asserted fields).

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts -t "type override"
```
Expected: FAIL (schema rejects `assetType`; response lacks `typeSource`).

- [ ] **Step 3: Extend the update schema**

In `apps/api/src/routes/discovery.ts`, replace `updateAssetSchema` (lines 336-340) with:

```typescript
const updateAssetSchema = z.object({
  label: z.string().max(255).optional(),
  notes: z.string().nullish(),
  tags: z.string().array().optional(),
  assetType: z.enum([
    'workstation', 'server', 'printer', 'router', 'switch', 'firewall',
    'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown'
  ]).optional(),
  resetTypeToAuto: z.boolean().optional()
}).refine(
  (v) => !(v.assetType !== undefined && v.resetTypeToAuto === true),
  { message: 'assetType and resetTypeToAuto are mutually exclusive' }
);
```

- [ ] **Step 4: Apply the type changes in the PATCH handler**

In the PATCH handler, after the existing `tags` line (line 1153), add:

```typescript
    if (updates.assetType !== undefined) {
      setValues.assetType = updates.assetType;
      setValues.typeSource = 'manual';
    }
    if (updates.resetTypeToAuto) {
      // Restore the scan's last classification; fall back to current type if
      // the asset was never auto-classified (detectedAssetType still null).
      setValues.assetType = sql`coalesce(${discoveredAssets.detectedAssetType}, ${discoveredAssets.assetType})`;
      setValues.typeSource = 'auto';
    }
```

(`sql` is already imported in this file — it's used throughout.)

- [ ] **Step 5: Surface provenance in both GET serializers**

In the GET list serializer (after `linkSource: a.linkSource,` ~line 950) and the GET single serializer (after `linkSource: a.linkSource,` ~line 1050), add to each object:

```typescript
          typeSource: a.typeSource,
          detectedAssetType: a.detectedAssetType,
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts -t "type override"
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts
git commit -m "feat(api): PATCH discovered-asset type override + reset (#1424)"
```

---

### Task 3: Discovery worker — sticky manual type

**Files:**
- Modify: `apps/api/src/jobs/discoveryWorker.ts` (existing-asset select ~line 774; update/insert branches lines 819-842)
- Test: `apps/api/src/jobs/discoveryWorker.test.ts`

**Interfaces:**
- Consumes: `discoveredAssets.typeSource`, `discoveredAssets.detectedAssetType` from Task 1.
- Produces: re-scan preserves `asset_type` when `type_source='manual'`; always writes `detected_asset_type`; fresh inserts set `type_source='auto'`.

- [ ] **Step 1: Write failing worker tests**

In `apps/api/src/jobs/discoveryWorker.test.ts`, add tests covering `processResults`. Match the file's existing harness for invoking the worker on a host payload. Tests:

```typescript
it('preserves asset_type but updates detected_asset_type when type_source=manual', async () => {
  // existing asset: assetType='router', typeSource='manual'
  // incoming scan classifies host as 'workstation'
  // expect the UPDATE set: assetType NOT changed (stays 'router'),
  //   detectedAssetType === 'workstation'
});

it('updates asset_type normally when type_source=auto', async () => {
  // existing asset: assetType='unknown', typeSource='auto'
  // incoming scan classifies as 'printer'
  // expect UPDATE set: assetType === 'printer', detectedAssetType === 'printer'
});

it('fresh insert sets type_source=auto and detected_asset_type', async () => {
  // no existing asset; incoming scan classifies as 'server'
  // expect INSERT values: typeSource === 'auto', detectedAssetType === 'server'
});
```

Use the same Drizzle mock assertion style already present in `discoveryWorker.test.ts` (inspect the `.set(...)` / `.values(...)` argument captured by the mock).

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/jobs/discoveryWorker.test.ts -t "type_source"
```
Expected: FAIL (worker doesn't read or write the new columns yet).

- [ ] **Step 3: Read `typeSource` of the existing asset**

In `apps/api/src/jobs/discoveryWorker.ts`, change the existing-asset select (lines 774-783) to also fetch `typeSource`:

```typescript
    const [existing] = await db
      .select({ id: discoveredAssets.id, typeSource: discoveredAssets.typeSource })
      .from(discoveredAssets)
      .where(
        and(
          eq(discoveredAssets.orgId, data.orgId),
          sql`${discoveredAssets.ipAddress} = ${host.ip}`
        )
      )
      .limit(1);
```

- [ ] **Step 4: Make the update branch sticky; set provenance on insert**

Replace the `if (existing) { ... } else { ... }` block (lines 819-842). Keep `assetData` exactly as-is (it still carries `assetType`, which downstream device-role propagation at line ~867 relies on). Change only how it's written:

```typescript
    if (existing) {
      // Always record what the scan thinks; only overwrite the user-facing
      // asset_type when the type was NOT set manually.
      const updateSet: Record<string, unknown> = {
        ...assetData,
        detectedAssetType: resolvedAssetType
      };
      if (existing.typeSource === 'manual') {
        delete updateSet.assetType; // preserve the user's manual override
      }
      await db
        .update(discoveredAssets)
        .set(updateSet)
        .where(eq(discoveredAssets.id, existing.id));
      upsertedAssetId = existing.id;
      updatedCount++;

      // Check if already linked (preserve manual decisions)
      const [currentAsset] = await db
        .select({ linkedDeviceId: discoveredAssets.linkedDeviceId })
        .from(discoveredAssets)
        .where(eq(discoveredAssets.id, existing.id))
        .limit(1);
      alreadyLinked = !!currentAsset?.linkedDeviceId;
    } else {
      const [inserted] = await db.insert(discoveredAssets).values({
        orgId: data.orgId,
        siteId: data.siteId,
        ...assetData,
        detectedAssetType: resolvedAssetType,
        typeSource: 'auto'
      }).returning({ id: discoveredAssets.id });
      upsertedAssetId = inserted?.id ?? null;
      newCount++;
    }
```

(Note: device-role propagation at line ~867 continues to use the freshly-detected `assetData.assetType`. Leaving that as the detected value is intentional and out of scope — a manual *asset* type does not retroactively change linked-*device* role logic here.)

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/jobs/discoveryWorker.test.ts -t "type_source"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/discoveryWorker.ts apps/api/src/jobs/discoveryWorker.test.ts
git commit -m "feat(api): discovery re-scan preserves manual asset type (#1424)"
```

---

### Task 4: Web shared types + mapper

**Files:**
- Modify: `apps/web/src/components/discovery/DiscoveredAssetList.tsx` (`DiscoveredAsset` type line 26; `ApiDiscoveryAsset` type line 53; `mapAsset` line 148)
- Test: `apps/web/src/components/discovery/DiscoveredAssetList.test.tsx`

**Interfaces:**
- Produces: `DiscoveredAsset.typeSource?: DiscoveredAssetTypeSource | null`, `DiscoveredAsset.detectedType?: DiscoveredAssetType | null`; `mapAsset` populates both. `export type DiscoveredAssetTypeSource = 'manual' | 'auto'`.

- [ ] **Step 1: Write failing mapper test**

In `apps/web/src/components/discovery/DiscoveredAssetList.test.tsx`, add:

```typescript
it('mapAsset carries typeSource and detectedType through', () => {
  const mapped = mapAsset({
    id: 'a1', assetType: 'router', typeSource: 'manual', detectedAssetType: 'workstation'
  } as any);
  expect(mapped.typeSource).toBe('manual');
  expect(mapped.detectedType).toBe('workstation');
});

it('mapAsset defaults typeSource to auto when absent', () => {
  const mapped = mapAsset({ id: 'a2', assetType: 'server' } as any);
  expect(mapped.typeSource).toBe('auto');
});
```

(If `mapAsset` isn't already imported in this test file, add it to the existing import from `./DiscoveredAssetList`.)

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/discovery/DiscoveredAssetList.test.tsx -t "typeSource"
```
Expected: FAIL.

- [ ] **Step 3: Add the type alias and extend both types**

In `apps/web/src/components/discovery/DiscoveredAssetList.tsx`, after `DiscoveredAssetType` (line 22) add:

```typescript
export type DiscoveredAssetTypeSource = 'manual' | 'auto';
```

In `DiscoveredAsset` (after `linkSource` line 42) add:

```typescript
  typeSource?: DiscoveredAssetTypeSource | null;
  detectedType?: DiscoveredAssetType | null;
```

In `ApiDiscoveryAsset` (after `linkSource` line 68) add:

```typescript
  typeSource?: DiscoveredAssetTypeSource | null;
  detectedAssetType?: string | null;
```

- [ ] **Step 4: Populate them in `mapAsset`**

In `mapAsset` (after `linkSource:` line 165) add:

```typescript
    typeSource: asset.typeSource ?? 'auto',
    detectedType: asset.detectedAssetType
      ? (assetTypeMap[asset.detectedAssetType.toLowerCase()] ?? 'unknown')
      : null,
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/discovery/DiscoveredAssetList.test.tsx -t "typeSource"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/discovery/DiscoveredAssetList.tsx apps/web/src/components/discovery/DiscoveredAssetList.test.tsx
git commit -m "feat(web): carry discovered-asset type provenance through mapper (#1424)"
```

---

### Task 5: Web — editable type on the native detail page

**Files:**
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` (type badge ~line 247; "Asset Type" field ~line 320)
- Test: `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx`

**Interfaces:**
- Consumes: `typeConfig`, `DiscoveredAssetType`, `mapAsset`, `runAction`, and the `typeSource`/`detectedType` fields from Task 4.

- [ ] **Step 1: Write failing component tests**

In `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx`, add (matching the file's existing render harness + `fetchWithAuth`/`runAction` mocks):

```typescript
it('changing the type Select issues a PATCH with the chosen assetType', async () => {
  // render with a loaded asset (type='workstation')
  // change select [data-testid="network-asset-type-select"] to 'router'
  // expect fetchWithAuth called with /discovery/assets/<id>, method PATCH,
  //   body containing { assetType: 'router' }
});

it('shows a reset-to-auto control only when typeSource is manual', async () => {
  // render asset with typeSource='manual'
  // expect [data-testid="network-asset-type-reset"] present
  // re-render with typeSource='auto' -> control absent
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/devices/NetworkDeviceDetailPage.test.tsx -t "type"
```
Expected: FAIL.

- [ ] **Step 3: Add a type-change handler**

In `NetworkDeviceDetailPage.tsx`, near the existing unlink handler (~line 166), add a handler that PATCHes and refetches. Use `runAction` (the file already imports it):

```typescript
  const changeType = useCallback(async (next: DiscoveredAssetType | 'reset') => {
    if (!asset) return;
    await runAction({
      run: () => fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify(
          next === 'reset' ? { resetTypeToAuto: true } : { assetType: next }
        )
      }),
      successMessage: next === 'reset' ? 'Type reset to auto-detected' : 'Device type updated'
    }).then(() => { void reload(); })
      .catch(() => { /* runAction already toasted */ });
  }, [asset]);
```

Use the file's existing reload/refetch function name in place of `reload()` (the same one the unlink handler calls after success). Import `type DiscoveredAssetType` from `../discovery/DiscoveredAssetList` (extend the existing import on lines 9-15).

- [ ] **Step 4: Replace the read-only "Asset Type" field with a Select**

At the "Asset Type" `Field` (~line 320), render an editable Select plus the reset affordance. Replace:

```tsx
                <Field label="Asset Type" value={typeMeta.label} />
```

with:

```tsx
                <div>
                  <div className="text-xs font-medium text-muted-foreground">Asset Type</div>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="network-asset-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      value={asset.type}
                      onChange={(e) => void changeType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((t) => (
                        <option key={t} value={t}>{typeConfig[t].label}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="network-asset-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                        onClick={() => void changeType('reset')}
                      >
                        Reset to auto-detected
                      </button>
                    )}
                  </div>
                  {asset.typeSource === 'manual' && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Manually set{asset.detectedType ? ` · scan detected ${typeConfig[asset.detectedType].label}` : ''}
                    </p>
                  )}
                </div>
```

(The read-only badge at ~line 247 can stay — it reflects `asset.type`, which updates after reload.)

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/devices/NetworkDeviceDetailPage.test.tsx -t "type"
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/NetworkDeviceDetailPage.tsx apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx
git commit -m "feat(web): editable device type on network detail page (#1424)"
```

---

### Task 6: Web — editable type in the discovery modal

**Files:**
- Modify: `apps/web/src/components/discovery/AssetDetailModal.tsx` (type badge ~line 356; edit-info section ~lines 449-475; save handler ~line 213)
- Test: `apps/web/src/components/discovery/AssetDetailModal.test.tsx`

**Interfaces:**
- Consumes: `typeConfig`, `DiscoveredAssetType` from `./DiscoveredAssetList`; the `typeSource`/`detectedType` fields from Task 4.

- [ ] **Step 1: Write failing modal tests**

In `apps/web/src/components/discovery/AssetDetailModal.test.tsx`, add (matching the file's existing render harness + `fetchWithAuth` mock):

```typescript
it('saving with a changed type includes assetType in the PATCH body', async () => {
  // open modal on asset type='workstation'
  // change [data-testid="asset-modal-type-select"] to 'switch', click Save
  // expect fetchWithAuth PATCH /discovery/assets/<id> body contains assetType:'switch'
});

it('reset-to-auto control appears only when typeSource is manual', async () => {
  // typeSource='manual' -> [data-testid="asset-modal-type-reset"] present
  // typeSource='auto' -> absent
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/discovery/AssetDetailModal.test.tsx -t "type"
```
Expected: FAIL.

- [ ] **Step 3: Add type state + include it in the existing save handler**

In `AssetDetailModal.tsx`, add an `editType` state alongside the existing `editLabel`/`editNotes` state (near line 93):

```typescript
  const [editType, setEditType] = useState<DiscoveredAssetType>(asset?.type ?? 'unknown');
```

In the effect that resets `editLabel`/`editNotes` (near lines 93-94), add:

```typescript
    setEditType(asset?.type ?? 'unknown');
```

In `handleSaveInfo` (line 213), include the type in the PATCH body (line 225-229), sending `assetType` only when it changed from the asset's current type:

```typescript
        body: JSON.stringify({
          label: editLabel || null,
          notes: editNotes || null,
          tags,
          ...(editType !== asset.type ? { assetType: editType } : {})
        })
```

Import `type DiscoveredAssetType` from `./DiscoveredAssetList` (extend the existing import on line 4).

- [ ] **Step 4: Add a reset handler**

Add, next to `handleSaveInfo`:

```typescript
  const handleResetType = async () => {
    if (!asset) return;
    try {
      setSaving(true);
      setSaveError(undefined);
      const response = await fetchWithAuth(`/discovery/assets/${asset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ resetTypeToAuto: true })
      });
      if (!response.ok) throw new Error('Failed to reset type');
      setSaveSuccess(true);
      onUpdated?.(asset.id);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 5: Render the type Select in the edit-info section**

In the edit-info block (after the "Display Name" field ~line 449, before "Notes"), add:

```tsx
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Asset Type</label>
                  <div className="mt-1 flex items-center gap-2">
                    <select
                      data-testid="asset-modal-type-select"
                      className="rounded-md border bg-background px-2 py-1 text-sm"
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as DiscoveredAssetType)}
                    >
                      {(Object.keys(typeConfig) as DiscoveredAssetType[]).map((t) => (
                        <option key={t} value={t}>{typeConfig[t].label}</option>
                      ))}
                    </select>
                    {asset.typeSource === 'manual' && (
                      <button
                        type="button"
                        data-testid="asset-modal-type-reset"
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                        onClick={() => void handleResetType()}
                      >
                        Reset to auto-detected
                      </button>
                    )}
                  </div>
                </div>
```

- [ ] **Step 6: Run tests to verify they pass**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/discovery/AssetDetailModal.test.tsx -t "type"
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/discovery/AssetDetailModal.tsx apps/web/src/components/discovery/AssetDetailModal.test.tsx
git commit -m "feat(web): editable device type in discovery asset modal (#1424)"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: API suite**

Run:
```bash
pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts src/jobs/discoveryWorker.test.ts
```
Expected: PASS.

- [ ] **Step 2: Web suite (touched files)**

Run:
```bash
pnpm --filter @breeze/web exec vitest run src/components/discovery src/components/devices/NetworkDeviceDetailPage.test.tsx
```
Expected: PASS.

- [ ] **Step 3: Drift + typecheck**

Run:
```bash
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/web exec tsc --noEmit
```
Expected: no drift, no type errors.

- [ ] **Step 4: Final commit (only if any verification fix was needed)**

```bash
git add -A && git commit -m "test: verify network device type override end-to-end (#1424)"
```

---

## Self-Review

- **Spec coverage:** type_source + detected_asset_type columns (Task 1) ✓; sticky worker (Task 3) ✓; PATCH assetType + resetTypeToAuto, mutually exclusive (Task 2) ✓; GET surfaces provenance (Task 2) ✓; both web surfaces editable + reset-only-when-manual (Tasks 5,6) ✓; RLS no-op noted ✓; tests per breeze-testing (every task) ✓. Phase 2 detection explicitly out of scope ✓.
- **Placeholders:** none — every code step shows real code; test steps give concrete assertions and exact `-t` filters.
- **Type consistency:** `typeSource`/`detectedAssetType` (DB/API) ↔ `typeSource`/`detectedType` (web mapped) used consistently; `DiscoveredAssetTypeSource` defined in Task 4 before use; worker reads `existing.typeSource` defined in Task 1; `resetTypeToAuto` and `assetType` names match across API schema, handler, and both web callers.
