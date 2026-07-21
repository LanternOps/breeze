# Unlink Network-Discovered Device Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user unlink a manually-linked network-discovered asset from its managed device, on both the network device detail page and the asset detail modal.

**Architecture:** Add a nullable `link_source` enum (`'manual' | 'auto'`) to `discovered_assets`, stamped at the two existing write sites (manual link route, auto-linker worker). A new `DELETE /discovery/assets/:id/link` endpoint clears the link only when `link_source = 'manual'`. The web surfaces expose `linkSource` and show an Unlink button gated on `linkedDeviceId` being set AND `linkSource === 'manual'`.

**Tech Stack:** Hono + Drizzle (Postgres) API, Vitest (API + web/jsdom), React/Astro web, hand-written idempotent SQL migrations.

## Global Constraints

- **No backfill:** pre-existing linked rows keep `link_source = NULL` and are treated as non-manual (not unlinkable).
- **Keep approval:** unlink leaves `approval_status = 'approved'` unchanged.
- **Manual-only:** auto-linked or unknown-source links must never be unlinkable.
- **Unlink guards mirror the link route exactly:** `requireScope('organization','partner','system')`, `requireDiscoveryWrite`, `requireMfa()`, plus the same org/site authorization checks.
- **Migrations are idempotent** (`CREATE TYPE` in a `DO` block, `ADD COLUMN IF NOT EXISTS`); never edit a shipped migration; no inner `BEGIN/COMMIT`.
- **Web mutations use `runAction`** (`apps/web/src/lib/runAction.ts`) so success/failure is always surfaced.
- The only two write sites for `discovered_assets.linked_device_id` are `apps/api/src/routes/discovery.ts` (manual) and `apps/api/src/jobs/discoveryWorker.ts` (auto). `networkChanges.ts` / `networkBaseline.ts` write the same-named column on the **`network_change_events`** table — out of scope, do not touch.

---

### Task 1: Schema + migration for `link_source`

**Files:**
- Modify: `apps/api/src/db/schema/discovery.ts` (enum block ~line 23-43; `discoveredAssets` table ~line 107-140)
- Create: `apps/api/migrations/2026-06-27-discovered-asset-link-source.sql`

**Interfaces:**
- Produces: `discoveredAssetLinkSourceEnum` (Drizzle pgEnum), and column `discoveredAssets.linkSource` of type `'manual' | 'auto' | null`.

- [ ] **Step 1: Add the Drizzle enum**

In `apps/api/src/db/schema/discovery.ts`, after the `discoveredAssetApprovalStatusEnum` definition (~line 43), add:

```ts
export const discoveredAssetLinkSourceEnum = pgEnum('discovered_asset_link_source', [
  'manual',
  'auto'
]);
```

- [ ] **Step 2: Add the column to the table**

In the `discoveredAssets` table definition, immediately after the `linkedDeviceId` line (~line 129), add:

```ts
  linkSource: discoveredAssetLinkSourceEnum('link_source'),
```

(Nullable by default — do not add `.notNull()`.)

- [ ] **Step 3: Write the migration**

Create `apps/api/migrations/2026-06-27-discovered-asset-link-source.sql`:

```sql
-- Records how a discovered asset became linked to a managed device:
-- 'manual' (user action) or 'auto' (discovery worker MAC/IP match).
-- NULL = not linked, or link predates this column. NULL is treated as
-- non-manual and is NOT unlinkable. No backfill by design.

DO $$
BEGIN
  CREATE TYPE discovered_asset_link_source AS ENUM ('manual', 'auto');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE discovered_assets
  ADD COLUMN IF NOT EXISTS link_source discovered_asset_link_source;
```

- [ ] **Step 4: Verify no schema drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift reported (schema matches migrations).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/discovery.ts apps/api/migrations/2026-06-27-discovered-asset-link-source.sql
git commit -m "feat(api): add link_source to discovered_assets"
```

---

### Task 2: Stamp `link_source` at both write sites

**Files:**
- Modify: `apps/api/src/routes/discovery.ts` (manual link `.set({...})` ~line 1232-1237)
- Modify: `apps/api/src/jobs/discoveryWorker.ts` (auto-link `.set({...})` ~line 862)
- Test: `apps/api/src/routes/discovery.test.ts`

**Interfaces:**
- Consumes: `discoveredAssets.linkSource` from Task 1.
- Produces: manual links carry `linkSource: 'manual'`; auto links carry `linkSource: 'auto'`.

- [ ] **Step 1: Write the failing test (manual link sets source)**

In `apps/api/src/routes/discovery.test.ts`, add a test asserting the manual link handler's update payload includes `linkSource: 'manual'`. Follow the existing Drizzle-mock pattern already used in this file for the link route (capture the object passed to `.set(...)`).

```ts
it('manual link sets linkSource to manual', async () => {
  // arrange: mock so POST /assets/:id/link resolves org, finds asset + device
  // act: call the link route
  // assert: the .set(...) payload includes linkSource: 'manual'
  expect(capturedSetPayload).toMatchObject({
    linkedDeviceId: expect.any(String),
    approvalStatus: 'approved',
    linkSource: 'manual'
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test --filter=@breeze/api -- discovery.test.ts -t "manual link sets linkSource"`
Expected: FAIL — payload lacks `linkSource`.

- [ ] **Step 3: Add `linkSource: 'manual'` to the manual link update**

In `apps/api/src/routes/discovery.ts`, in the `POST /assets/:id/link` handler, update the `.set({...})` (~line 1233-1237) to:

```ts
      .set({
        approvalStatus: 'approved',
        linkedDeviceId: body.deviceId,
        linkSource: 'manual',
        updatedAt: new Date()
      })
```

- [ ] **Step 4: Add `linkSource: 'auto'` to the auto-link update**

In `apps/api/src/jobs/discoveryWorker.ts`, update the auto-link `.set({...})` (~line 862) to:

```ts
              .set({ linkedDeviceId: match.deviceId, approvalStatus: 'approved', linkSource: 'auto' })
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- discovery.test.ts -t "manual link sets linkSource"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/jobs/discoveryWorker.ts apps/api/src/routes/discovery.test.ts
git commit -m "feat(api): stamp link_source at manual and auto link sites"
```

---

### Task 3: `DELETE /discovery/assets/:id/link` unlink endpoint

**Files:**
- Modify: `apps/api/src/routes/discovery.ts` (add new handler immediately after the `POST /assets/:id/link` handler, ~line 1252)
- Test: `apps/api/src/routes/discovery.test.ts`

**Interfaces:**
- Consumes: `discoveredAssets.linkSource`; existing helpers already imported in this file: `requireScope`, `requireDiscoveryWrite`, `requireMfa`, `resolveOrgIdForAsset`, `canAccessSite`, `writeRouteAudit`, `eq`, `and`.
- Produces: `DELETE /assets/:id/link` → 200 `{updated asset}` (manual link cleared or already-unlinked no-op), 403 (non-manual link), 404 (asset not found).

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/routes/discovery.test.ts`, add tests covering:

```ts
describe('DELETE /assets/:id/link (unlink)', () => {
  it('clears a manual link, keeps approval_status approved, writes audit', async () => {
    // asset with linkedDeviceId set + linkSource 'manual'
    // expect .set(...) called with { linkedDeviceId: null, linkSource: null }
    // expect NO approvalStatus key in the unlink .set payload
    // expect writeRouteAudit called with action 'discovery.asset.unlink'
  });

  it('returns 403 for an auto-linked asset', async () => {
    // asset with linkedDeviceId set + linkSource 'auto'
    // expect 403, no update performed
  });

  it('returns 403 for a NULL-source linked asset', async () => {
    // asset with linkedDeviceId set + linkSource null
    // expect 403, no update performed
  });

  it('is a no-op for an already-unlinked asset', async () => {
    // asset with linkedDeviceId null
    // expect 200, returns asset, no update performed
  });

  it('returns 404 when the asset is not found', async () => {
    // resolveOrgIdForAsset/select returns nothing
    // expect 404
  });
});
```

Mirror the mocking style the existing link-route tests in this file already use (org resolution + asset select). For each case set the selected asset's `linkedDeviceId` and `linkSource` accordingly.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test --filter=@breeze/api -- discovery.test.ts -t "unlink"`
Expected: FAIL — route not defined (404 for all).

- [ ] **Step 3: Implement the handler**

In `apps/api/src/routes/discovery.ts`, directly after the closing `);` of the `POST /assets/:id/link` handler (~line 1252), add:

```ts
discoveryRoutes.delete(
  '/assets/:id/link',
  requireScope('organization', 'partner', 'system'),
  requireDiscoveryWrite,
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const assetId = c.req.param('id')!;
    const orgResult = await resolveOrgIdForAsset(auth, assetId);
    if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

    const conditions: SQL[] = [eq(discoveredAssets.id, assetId)];
    if (orgResult.orgId) conditions.push(eq(discoveredAssets.orgId, orgResult.orgId));

    const [existing] = await db.select({
      id: discoveredAssets.id,
      orgId: discoveredAssets.orgId,
      siteId: discoveredAssets.siteId,
      hostname: discoveredAssets.hostname,
      ipAddress: discoveredAssets.ipAddress,
      linkedDeviceId: discoveredAssets.linkedDeviceId,
      linkSource: discoveredAssets.linkSource
    }).from(discoveredAssets)
      .where(and(...conditions)).limit(1);
    if (!existing) return c.json({ error: 'Asset not found' }, 404);

    // Site-scope is an app-layer-only authz axis; RLS does not defend it.
    const perms = c.get('permissions') as UserPermissions | undefined;
    if (perms?.allowedSiteIds && typeof existing.siteId === 'string' && !canAccessSite(perms, existing.siteId)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    // Already unlinked: idempotent no-op.
    if (!existing.linkedDeviceId) {
      return c.json(existing);
    }

    // Only manually-created links may be removed here.
    if (existing.linkSource !== 'manual') {
      return c.json({ error: 'Only manually linked assets can be unlinked' }, 403);
    }

    const previousDeviceId = existing.linkedDeviceId;
    const [updated] = await db.update(discoveredAssets)
      .set({
        linkedDeviceId: null,
        linkSource: null,
        updatedAt: new Date()
      })
      .where(eq(discoveredAssets.id, assetId))
      .returning();

    writeRouteAudit(c, {
      orgId: updated?.orgId ?? orgResult.orgId,
      action: 'discovery.asset.unlink',
      resourceType: 'discovered_asset',
      resourceId: updated?.id ?? assetId,
      resourceName: updated?.hostname ?? updated?.ipAddress ?? undefined,
      details: { previousLinkedDeviceId: previousDeviceId }
    });

    return c.json(updated);
  }
);
```

Note: the unlink `.set(...)` deliberately omits `approvalStatus` so the asset stays `'approved'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test --filter=@breeze/api -- discovery.test.ts -t "unlink"`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts
git commit -m "feat(api): add unlink endpoint for manually linked discovered assets"
```

---

### Task 4: Expose `linkSource` in GET responses + web types

**Files:**
- Modify: `apps/api/src/routes/discovery.ts` (list GET response ~line 948; single-asset GET response ~line 1047)
- Modify: `apps/web/src/components/discovery/networkTypes.ts` (asset shape + parse — the discovered-asset type/parse, NOT the `NetworkChangeEvent` type)
- Modify: `apps/web/src/components/discovery/DiscoveredAssetList.tsx` (asset interfaces at lines ~40 and ~65; mapping at ~161)
- Modify: `apps/web/src/components/discovery/AssetDetailModal.tsx` (asset prop type ~line 15)
- Test: `apps/api/src/routes/discovery.test.ts`

**Interfaces:**
- Consumes: `discoveredAssets.linkSource`.
- Produces: every discovered-asset API payload includes `linkSource: 'manual' | 'auto' | null`; the web asset types include `linkSource?: 'manual' | 'auto' | null`.

- [ ] **Step 1: Write the failing test (single-asset GET includes linkSource)**

In `apps/api/src/routes/discovery.test.ts`, extend the existing `GET /assets/:id` test (or add one) to assert the response `data` includes `linkSource`:

```ts
it('GET /assets/:id includes linkSource', async () => {
  // mock selected asset row with linkSource: 'manual'
  // expect res.body.data.linkSource === 'manual'
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test --filter=@breeze/api -- discovery.test.ts -t "includes linkSource"`
Expected: FAIL — `linkSource` undefined in response.

- [ ] **Step 3: Add `linkSource` to both GET response objects**

In `apps/api/src/routes/discovery.ts`:

Single-asset GET — in the `data: {...}` object, after the `linkedDeviceName` line (~line 1048), add:

```ts
        linkSource: a.linkSource,
```

List GET — in the `results.map` returned object, after its `linkedDeviceName` line (~line 949), add:

```ts
          linkSource: a.linkSource,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test --filter=@breeze/api -- discovery.test.ts -t "includes linkSource"`
Expected: PASS.

- [ ] **Step 5: Add `linkSource` to the web asset types + parse**

In `apps/web/src/components/discovery/networkTypes.ts`, in the discovered-asset type (the one declaring `linkedDeviceId: string | null;` at ~line 45 of its own type — locate the asset type, not `NetworkChangeEvent`) add:

```ts
  linkSource: 'manual' | 'auto' | null;
```

and in its parse function (alongside `linkedDeviceId: asString(row.linkedDeviceId)` at ~line 186) add:

```ts
  linkSource: (row.linkSource as 'manual' | 'auto' | null) ?? null,
```

In `apps/web/src/components/discovery/DiscoveredAssetList.tsx`, add `linkSource?: 'manual' | 'auto' | null;` to the two asset interfaces (after the `linkedDeviceId` fields at ~line 40 and ~line 65), and add `linkSource: asset.linkSource,` to the mapping near line 161.

In `apps/web/src/components/discovery/AssetDetailModal.tsx`, add `linkSource?: 'manual' | 'auto' | null;` to the asset prop type after `linkedDeviceId` (~line 15).

- [ ] **Step 6: Typecheck the web package**

Run: `pnpm --filter=@breeze/web exec tsc --noEmit`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/discovery.ts apps/api/src/routes/discovery.test.ts apps/web/src/components/discovery/networkTypes.ts apps/web/src/components/discovery/DiscoveredAssetList.tsx apps/web/src/components/discovery/AssetDetailModal.tsx
git commit -m "feat: expose linkSource in discovery asset payloads and web types"
```

---

### Task 5: Unlink button on the network device detail page

**Files:**
- Modify: `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx` ("Linked Device" `Field` ~line 396-410)
- Test: `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx`

**Interfaces:**
- Consumes: `asset.linkSource` from Task 4; `runAction` from `apps/web/src/lib/runAction.ts`; existing `fetchWithAuth`.
- Produces: an Unlink control (`data-testid="network-detail-unlink"`) rendered only when `asset.linkedDeviceId` is set AND `asset.linkSource === 'manual'`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx`, add:

```tsx
it('shows Unlink for a manually linked asset', () => {
  // render with asset { linkedDeviceId: 'dev-1', linkSource: 'manual', ... }
  expect(screen.getByTestId('network-detail-unlink')).toBeInTheDocument();
});

it('hides Unlink for an auto-linked asset', () => {
  // asset { linkedDeviceId: 'dev-1', linkSource: 'auto' }
  expect(screen.queryByTestId('network-detail-unlink')).toBeNull();
});

it('hides Unlink for an unlinked asset', () => {
  // asset { linkedDeviceId: null, linkSource: null }
  expect(screen.queryByTestId('network-detail-unlink')).toBeNull();
});

it('calls DELETE on the link endpoint when confirmed', async () => {
  // stub window.confirm -> true, mock fetchWithAuth
  // click network-detail-unlink
  // expect fetchWithAuth called with `/discovery/assets/${id}/link` and method 'DELETE'
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test --filter=@breeze/web -- NetworkDeviceDetailPage.test.tsx`
Expected: FAIL — no `network-detail-unlink` element.

- [ ] **Step 3: Implement the Unlink control + handler**

In `apps/web/src/components/devices/NetworkDeviceDetailPage.tsx`, add a handler (near the component's other handlers). Use `runAction`; import it if not already imported (`import { runAction } from '../../lib/runAction';` — match the file's existing relative-import depth):

```tsx
const [unlinking, setUnlinking] = useState(false);

const handleUnlink = async () => {
  if (!asset?.linkedDeviceId) return;
  if (!window.confirm('Unlink this device?')) return;
  setUnlinking(true);
  try {
    await runAction({
      action: () => fetchWithAuth(`/discovery/assets/${asset.id}/link`, { method: 'DELETE' }),
      successMessage: 'Device unlinked.',
      errorMessage: 'Failed to unlink device.'
    });
    // reflect locally + refetch using whatever this page already does after a mutation
    await refetchAsset();
  } finally {
    setUnlinking(false);
  }
};
```

Adapt the `runAction(...)` call to the actual signature in `apps/web/src/lib/runAction.ts` and reuse the page's existing refetch function (whatever loads `asset`). Then, in the "Linked Device" `Field` (~line 396-410), when `asset.linkedDeviceId` is set, render the link followed by an Unlink button gated on manual source:

```tsx
{asset.linkedDeviceId && asset.linkSource === 'manual' && (
  <button
    type="button"
    data-testid="network-detail-unlink"
    onClick={handleUnlink}
    disabled={unlinking}
    className="ml-2 text-sm text-destructive hover:underline disabled:opacity-50"
  >
    {unlinking ? 'Unlinking…' : 'Unlink'}
  </button>
)}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test --filter=@breeze/web -- NetworkDeviceDetailPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/NetworkDeviceDetailPage.tsx apps/web/src/components/devices/NetworkDeviceDetailPage.test.tsx
git commit -m "feat(web): unlink button on network device detail page"
```

---

### Task 6: Unlink action in the asset detail modal

**Files:**
- Modify: `apps/web/src/components/discovery/AssetDetailModal.tsx` (link section + `handleLink` ~line 114-147)
- Modify: `apps/web/src/components/discovery/DiscoveredAssetList.tsx` (`onLinked`-style callback ~line 781-786 — add an `onUnlinked` analog that sets `linkedDeviceId: null, linkSource: null` and refetches)
- Test: `apps/web/src/components/discovery/AssetDetailModal.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `asset.linkSource`, `runAction`, `fetchWithAuth`.
- Produces: an Unlink control (`data-testid="asset-modal-unlink"`) in the modal, shown only when `asset.linkedDeviceId` is set AND `asset.linkSource === 'manual'`; on success it calls an `onUnlinked?(assetId)` prop.

- [ ] **Step 1: Write the failing tests**

In `apps/web/src/components/discovery/AssetDetailModal.test.tsx`:

```tsx
it('shows Unlink only for a manually linked asset', () => {
  // manual -> visible
  // auto   -> hidden
  // unlinked -> hidden
});

it('DELETEs the link and calls onUnlinked when confirmed', async () => {
  // stub confirm -> true, mock fetchWithAuth
  // click asset-modal-unlink
  // expect fetchWithAuth(`/discovery/assets/${id}/link`, { method: 'DELETE' })
  // expect onUnlinked called with asset.id
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test --filter=@breeze/web -- AssetDetailModal.test.tsx`
Expected: FAIL — no `asset-modal-unlink` element / `onUnlinked` not called.

- [ ] **Step 3: Implement the Unlink control + handler in the modal**

In `apps/web/src/components/discovery/AssetDetailModal.tsx`, add an `onUnlinked?: (assetId: string) => void` prop, and a handler mirroring `handleLink` (reuse the file's existing `linking`/error/success state pattern; wrap in `runAction`):

```tsx
const handleUnlink = async () => {
  if (!asset?.linkedDeviceId) return;
  if (!window.confirm('Unlink this device?')) return;
  try {
    setLinking(true);
    setLinkError(undefined);
    setLinkSuccess(undefined);
    await runAction({
      action: () => fetchWithAuth(`/discovery/assets/${asset.id}/link`, { method: 'DELETE' }),
      successMessage: 'Device unlinked.',
      errorMessage: 'Failed to unlink device.'
    });
    setLinkSuccess('Device unlinked.');
    onUnlinked?.(asset.id);
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) setLinkError(err instanceof Error ? err.message : 'An error occurred');
  } finally {
    setLinking(false);
  }
};
```

(Import `runAction`/`ActionError` from `../../lib/runAction` matching the file's import depth, and adapt to the actual `runAction` signature.) In the link section JSX, when `asset.linkedDeviceId && asset.linkSource === 'manual'`, render:

```tsx
<button
  type="button"
  data-testid="asset-modal-unlink"
  onClick={handleUnlink}
  disabled={linking}
  className="text-sm text-destructive hover:underline disabled:opacity-50"
>
  {linking ? 'Unlinking…' : 'Unlink'}
</button>
```

- [ ] **Step 4: Wire `onUnlinked` from the list**

In `apps/web/src/components/discovery/DiscoveredAssetList.tsx`, next to the existing `onLinked` handler (~line 781-786), pass an `onUnlinked`:

```tsx
onUnlinked={async (assetId) => {
  setSelectedAsset(prev => (prev && prev.id === assetId ? { ...prev, linkedDeviceId: null, linkSource: null } : prev));
  await fetchAssets();
}}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test --filter=@breeze/web -- AssetDetailModal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full web + api test sweep for touched files**

Run: `pnpm test --filter=@breeze/web -- AssetDetailModal.test.tsx NetworkDeviceDetailPage.test.tsx DiscoveredAssetList` and `pnpm test --filter=@breeze/api -- discovery.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/discovery/AssetDetailModal.tsx apps/web/src/components/discovery/AssetDetailModal.test.tsx apps/web/src/components/discovery/DiscoveredAssetList.tsx
git commit -m "feat(web): unlink action in asset detail modal"
```

---

## Self-Review Notes

- **Spec coverage:** schema/migration (T1); write-site stamping (T2); unlink endpoint with manual-only 403 + keep-approved + audit + idempotent no-op + MFA/authz (T3); expose linkSource + types (T4); detail-page button gated on manual (T5); modal button gated on manual (T6). No-backfill is honored by simply not adding a backfill statement (T1).
- **Type consistency:** `linkSource: 'manual' | 'auto' | null` used uniformly across API payloads and web types; endpoint path `/discovery/assets/:id/link` with method `DELETE` consistent across T3/T5/T6; testids `network-detail-unlink` and `asset-modal-unlink` are distinct and used consistently within their tasks.
- **Verify-before-finish:** adapt `runAction(...)` call shape and the page/modal refetch hooks to the real signatures in the codebase during implementation (the exact `runAction` API and existing refetch fns weren't pinned in this plan).
```
