# Device Group Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-select device group filter to the DeviceList "More" panel, with inline group creation, so users can filter devices by group and create groups without leaving `/devices`.

**Architecture:** Extend the `GET /device-groups` API to optionally return device IDs per group. DevicesPage fetches groups+memberships and passes them to DeviceList. DeviceList adds a checkbox dropdown in the "More" filters row. A lightweight CreateGroupModal handles inline group creation.

**Tech Stack:** Hono (API), React, Vitest, Zod, existing FilterBuilder component

---

### File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `apps/api/src/routes/groups.ts` | Add `includeMemberships` query param to GET / |
| Modify | `apps/api/src/routes/groups_list.test.ts` | Test the new query param |
| Modify | `apps/web/src/components/devices/DevicesPage.tsx` | Fetch groups, build membership map, pass to DeviceList |
| Modify | `apps/web/src/components/devices/DeviceList.tsx` | Group filter state, dropdown UI, filter logic |
| Create | `apps/web/src/components/devices/CreateGroupModal.tsx` | Minimal modal for creating a group |

---

### Task 1: API — Add `includeMemberships` to GET /device-groups

**Files:**
- Modify: `apps/api/src/routes/groups.ts:56-61` (listGroupsQuerySchema)
- Modify: `apps/api/src/routes/groups.ts:220-238` (list handler response)
- Test: `apps/api/src/routes/groups_list.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new test case in `apps/api/src/routes/groups_list.test.ts` inside the existing `describe('GET /groups')` block, after the existing tests:

```typescript
    it('should return deviceIds when includeMemberships=true', async () => {
      const groups = [makeGroup(), makeGroup({ id: GROUP_ID_2, name: 'Second Group' })];
      vi.mocked(db.select)
        // First call: fetch groups
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(groups)
            })
          })
        } as any)
        // Second call: device counts
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { groupId: GROUP_ID, count: 2 },
                { groupId: GROUP_ID_2, count: 1 }
              ])
            })
          })
        } as any)
        // Third call: membership deviceIds
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { groupId: GROUP_ID, deviceId: DEVICE_ID },
              { groupId: GROUP_ID, deviceId: DEVICE_ID_2 },
              { groupId: GROUP_ID_2, deviceId: DEVICE_ID }
            ])
          })
        } as any);

      const res = await app.request('/groups?includeMemberships=true', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data[0].deviceIds).toEqual([DEVICE_ID, DEVICE_ID_2]);
      expect(body.data[1].deviceIds).toEqual([DEVICE_ID]);
    });

    it('should not return deviceIds when includeMemberships is not set', async () => {
      const groups = [makeGroup()];
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue(groups)
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([{ groupId: GROUP_ID, count: 3 }])
            })
          })
        } as any);

      const res = await app.request('/groups', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data[0].deviceIds).toBeUndefined();
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/groups_list.test.ts`
Expected: FAIL — `deviceIds` is undefined because the API doesn't return it yet.

- [ ] **Step 3: Add `includeMemberships` to the query schema**

In `apps/api/src/routes/groups.ts`, update `listGroupsQuerySchema` (line 56):

```typescript
const listGroupsQuerySchema = z.object({
  siteId: z.string().uuid().optional(),
  type: z.enum(['static', 'dynamic']).optional(),
  parentId: z.string().uuid().optional(),
  search: z.string().optional(),
  includeMemberships: z.enum(['true', 'false']).optional()
});
```

- [ ] **Step 4: Add `deviceIds` to the response type and mapper**

In `apps/api/src/routes/groups.ts`, update the `DeviceGroup` type (line 18) to add an optional field:

```typescript
type DeviceGroup = {
  id: string;
  orgId: string;
  siteId: string | null;
  name: string;
  type: 'static' | 'dynamic';
  rules: unknown;
  filterConditions: FilterConditionGroup | null;
  filterFieldsUsed: string[];
  parentId: string | null;
  deviceCount: number;
  createdAt: string;
  updatedAt: string;
  deviceIds?: string[];
};
```

Update `mapGroupRow` (line 158) to accept an optional `deviceIds` param:

```typescript
function mapGroupRow(
  group: typeof deviceGroups.$inferSelect,
  deviceCount: number,
  deviceIds?: string[]
): DeviceGroup {
  const result: DeviceGroup = {
    id: group.id,
    orgId: group.orgId,
    siteId: group.siteId,
    name: group.name,
    type: group.type,
    rules: group.rules,
    filterConditions: group.filterConditions as FilterConditionGroup | null,
    filterFieldsUsed: group.filterFieldsUsed ?? [],
    parentId: group.parentId,
    deviceCount,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString()
  };
  if (deviceIds) {
    result.deviceIds = deviceIds;
  }
  return result;
}
```

- [ ] **Step 5: Fetch and attach memberships in the list handler**

In the GET / handler (around line 236), after building `countMap`, add membership fetching and pass it to `mapGroupRow`:

```typescript
    // Optionally fetch device memberships
    let membershipMap: Map<string, string[]> | null = null;
    if (query.includeMemberships === 'true' && groupIds.length > 0) {
      const membershipRows = await db
        .select({
          groupId: deviceGroupMemberships.groupId,
          deviceId: deviceGroupMemberships.deviceId
        })
        .from(deviceGroupMemberships)
        .where(inArray(deviceGroupMemberships.groupId, groupIds));

      membershipMap = new Map<string, string[]>();
      for (const row of membershipRows) {
        const existing = membershipMap.get(row.groupId) ?? [];
        existing.push(row.deviceId);
        membershipMap.set(row.groupId, existing);
      }
    }

    const data = results.map((group) =>
      mapGroupRow(
        group,
        countMap.get(group.id) ?? 0,
        membershipMap?.get(group.id)
      )
    );

    return c.json({ data, total: data.length });
```

- [ ] **Step 6: Run the tests**

Run: `cd apps/api && npx vitest run src/routes/groups_list.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/groups.ts apps/api/src/routes/groups_list.test.ts
git commit -m "feat(api): add includeMemberships query param to GET /device-groups

Returns deviceIds array per group when includeMemberships=true,
enabling client-side group filtering on the devices page."
```

---

### Task 2: DevicesPage — Fetch groups and pass to DeviceList

**Files:**
- Modify: `apps/web/src/components/devices/DevicesPage.tsx`
- Modify: `apps/web/src/components/devices/DeviceList.tsx` (props only)

- [ ] **Step 1: Add group types and state to DevicesPage**

In `apps/web/src/components/devices/DevicesPage.tsx`, after the existing `Site` type (around line 30), add:

```typescript
type DeviceGroup = {
  id: string;
  name: string;
  type: 'static' | 'dynamic';
  deviceCount: number;
  deviceIds?: string[];
};
```

Inside the `DevicesPage` component, after `const [sites, setSites] = useState<Site[]>([]);` (line 35), add:

```typescript
  const [deviceGroups, setDeviceGroups] = useState<DeviceGroup[]>([]);
  const [groupMembershipMap, setGroupMembershipMap] = useState<Map<string, Set<string>>>(new Map());
```

- [ ] **Step 2: Fetch groups in the existing parallel fetch**

In `fetchDevices`, add the groups fetch to the existing `Promise.all` (line 65):

```typescript
      const [devicesResponse, orgsResponse, sitesResponse, groupsResponse] = await Promise.all([
        fetchWithAuth('/devices?includeDecommissioned=true'),
        fetchWithAuth('/orgs'),
        fetchWithAuth('/orgs/sites'),
        fetchWithAuth('/device-groups?includeMemberships=true')
      ]);
```

After the sites processing block (around line 119), add groups processing:

```typescript
      // Fetch groups for group filter
      let groupsList: DeviceGroup[] = [];
      if (groupsResponse.ok) {
        const groupsData = await groupsResponse.json();
        groupsList = groupsData.data ?? groupsData.groups ?? [];
      }

      // Build group membership map: groupId -> Set<deviceId>
      const memberMap = new Map<string, Set<string>>();
      for (const group of groupsList) {
        if (group.deviceIds) {
          memberMap.set(group.id, new Set(group.deviceIds));
        }
      }

      setDeviceGroups(groupsList);
      setGroupMembershipMap(memberMap);
```

- [ ] **Step 3: Add group props to DeviceList**

In `apps/web/src/components/devices/DeviceList.tsx`, update the `DeviceListProps` type (line 38) to add:

```typescript
type DeviceListProps = {
  devices: Device[];
  orgs?: { id: string; name: string }[];
  sites?: { id: string; name: string }[];
  groups?: { id: string; name: string; type: 'static' | 'dynamic'; deviceCount: number }[];
  groupMembershipMap?: Map<string, Set<string>>;
  timezone?: string;
  onSelect?: (device: Device) => void;
  onAction?: (action: string, device: Device) => void;
  onBulkAction?: (action: string, devices: Device[]) => void;
  pageSize?: number;
  serverFilter?: FilterConditionGroup | null;
};
```

Add the new props to the destructuring (line 77):

```typescript
export default function DeviceList({
  devices,
  orgs = [],
  sites = [],
  groups = [],
  groupMembershipMap = new Map(),
  timezone,
  onSelect,
  onAction,
  onBulkAction,
  pageSize = 10,
  serverFilter = null
}: DeviceListProps) {
```

- [ ] **Step 4: Pass groups to DeviceList in DevicesPage**

In `DevicesPage.tsx`, update the `<DeviceList>` usage (around line 554) to pass group data:

```tsx
        <DeviceList
          devices={devices}
          orgs={orgs}
          sites={sites}
          groups={deviceGroups}
          groupMembershipMap={groupMembershipMap}
          onSelect={handleSelectDevice}
          onAction={handleDeviceAction}
          onBulkAction={handleBulkAction}
          serverFilter={advancedFilter}
        />
```

- [ ] **Step 5: Verify no type errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors (pre-existing errors may appear).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DevicesPage.tsx apps/web/src/components/devices/DeviceList.tsx
git commit -m "feat(web): fetch device groups and pass to DeviceList

DevicesPage fetches groups with memberships in parallel with existing
data. Group data and membership map passed as new DeviceList props."
```

---

### Task 3: DeviceList — Add group filter UI and logic

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx`

- [ ] **Step 1: Add group filter state**

In `DeviceList`, after `const [siteFilter, setSiteFilter] = useState<string>('all');` (line 96), add:

```typescript
  const [groupFilter, setGroupFilter] = useState<string[]>([]);
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 2: Add click-outside handler for the group dropdown**

After the existing `rowMenuOpenId` click-outside effect (around line 118), add:

```typescript
  // Close group dropdown on outside click
  useEffect(() => {
    if (!groupDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(e.target as Node)) {
        setGroupDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [groupDropdownOpen]);
```

- [ ] **Step 3: Add group filter logic to `filteredDevices`**

In the `filteredDevices` useMemo (line 164), add the group match after `matchesSite` (line 183):

```typescript
      const matchesGroup = groupFilter.length === 0
        ? true
        : groupFilter.some(gId => groupMembershipMap.get(gId)?.has(device.id));

      return matchesQuery && matchesStatus && matchesOs && matchesRole && matchesOrg && matchesSite && matchesGroup;
```

Update the dependency array to include `groupFilter` and `groupMembershipMap`:

```typescript
  }, [devices, query, statusFilter, osFilter, roleFilter, orgFilter, siteFilter, groupFilter, groupMembershipMap, serverFilterIds]);
```

- [ ] **Step 4: Update `moreFiltersCount` and "Clear filters"**

Update `moreFiltersCount` (line 227):

```typescript
  const moreFiltersCount = [roleFilter, orgFilter, siteFilter].filter(f => f !== 'all').length + (groupFilter.length > 0 ? 1 : 0);
```

In the "Clear filters" condition (line 331), add group check:

```typescript
            {(query || statusFilter !== 'all' || osFilter !== 'all' || roleFilter !== 'all' || orgFilter !== 'all' || siteFilter !== 'all' || groupFilter.length > 0) && (
```

In the "Clear filters" click handler (line 334), add group reset:

```typescript
                onClick={() => {
                  setQuery('');
                  setStatusFilter('all');
                  setOsFilter('all');
                  setRoleFilter('all');
                  setOrgFilter('all');
                  setSiteFilter('all');
                  setGroupFilter([]);
                  setCurrentPage(1);
                }}
```

- [ ] **Step 5: Add the group dropdown UI in the "More" panel**

In the "More" filters expandable row, after the sites `<select>` (around line 404), add the group dropdown:

```tsx
              {groups.length > 0 && (
                <div className="relative" ref={groupDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setGroupDropdownOpen(!groupDropdownOpen)}
                    className="h-10 whitespace-nowrap rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted flex items-center gap-1.5"
                  >
                    Groups
                    {groupFilter.length > 0 && (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                        {groupFilter.length}
                      </span>
                    )}
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  {groupDropdownOpen && (
                    <div className="absolute left-0 top-full z-20 mt-1 w-64 rounded-md border bg-card shadow-lg">
                      <div className="max-h-48 overflow-y-auto p-2">
                        {groups.map(group => (
                          <label key={group.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                            <input
                              type="checkbox"
                              checked={groupFilter.includes(group.id)}
                              onChange={() => {
                                setGroupFilter(prev =>
                                  prev.includes(group.id)
                                    ? prev.filter(id => id !== group.id)
                                    : [...prev, group.id]
                                );
                                setCurrentPage(1);
                              }}
                              className="h-4 w-4 rounded border-border"
                            />
                            <span className="text-sm truncate">{group.name}</span>
                            <span className="ml-auto text-[10px] text-muted-foreground">{group.type}</span>
                          </label>
                        ))}
                      </div>
                      <div className="border-t px-2 py-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setGroupDropdownOpen(false);
                            onCreateGroup?.();
                          }}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          + New Group
                        </button>
                        <a
                          href="/devices/groups"
                          className="text-xs text-muted-foreground hover:text-foreground ml-auto"
                        >
                          Manage Groups
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}
```

- [ ] **Step 6: Add `onCreateGroup` and auto-select props**

In the `DeviceListProps` type, add:

```typescript
  onCreateGroup?: () => void;
  autoSelectGroupId?: string | null;
  onAutoSelectConsumed?: () => void;
```

Add them to the destructuring:

```typescript
  onCreateGroup,
  autoSelectGroupId,
  onAutoSelectConsumed,
```

- [ ] **Step 7: Handle auto-select effect**

After the group dropdown click-outside effect, add:

```typescript
  // Auto-select a newly created group
  useEffect(() => {
    if (autoSelectGroupId && groups.some(g => g.id === autoSelectGroupId)) {
      setGroupFilter(prev =>
        prev.includes(autoSelectGroupId) ? prev : [...prev, autoSelectGroupId]
      );
      onAutoSelectConsumed?.();
    }
  }, [autoSelectGroupId, groups, onAutoSelectConsumed]);
```

- [ ] **Step 8: Verify no type errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/devices/DeviceList.tsx
git commit -m "feat(web): add multi-select device group filter to DeviceList

Adds a checkbox dropdown in the 'More' filters panel. Devices are
filtered client-side using the group membership map (union/OR).
Includes badge count, clear support, and onCreateGroup callback."
```

---

### Task 4: CreateGroupModal — Inline group creation

**Files:**
- Create: `apps/web/src/components/devices/CreateGroupModal.tsx`

- [ ] **Step 1: Create the CreateGroupModal component**

Create `apps/web/src/components/devices/CreateGroupModal.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import type { FilterConditionGroup } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from '../filters/FilterBuilder';
import { fetchWithAuth } from '../../stores/auth';

type GroupType = 'static' | 'dynamic';

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (groupId: string) => void;
}

const EMPTY_FILTER: FilterConditionGroup = {
  operator: 'AND',
  conditions: [{ field: 'hostname', operator: 'contains', value: '' }]
};

export default function CreateGroupModal({ isOpen, onClose, onCreated }: CreateGroupModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<GroupType>('static');
  const [filterConditions, setFilterConditions] = useState<FilterConditionGroup>(EMPTY_FILTER);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = { name: name.trim(), type };
      if (type === 'dynamic') {
        body.filterConditions = filterConditions;
      }

      const res = await fetchWithAuth('/device-groups', {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Failed to create group (${res.status})`);
      }

      const data = await res.json();
      const newGroupId = data.data?.id ?? data.id;

      // Reset form
      setName('');
      setType('static');
      setFilterConditions(EMPTY_FILTER);
      onCreated(newGroupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create group');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setName('');
    setType('static');
    setFilterConditions(EMPTY_FILTER);
    setError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-background/80 backdrop-blur-sm" onClick={handleClose} />
      <div className="relative z-50 w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">New Device Group</h2>
          <button type="button" onClick={handleClose} className="rounded-md p-1 hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="group-name" className="block text-sm font-medium mb-1">Name</label>
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Production Servers"
              required
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Type</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setType('static')}
                className={`rounded-md border px-4 py-2 text-sm font-medium transition ${
                  type === 'static' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                }`}
              >
                Static
              </button>
              <button
                type="button"
                onClick={() => setType('dynamic')}
                className={`rounded-md border px-4 py-2 text-sm font-medium transition ${
                  type === 'dynamic' ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'
                }`}
              >
                Dynamic
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {type === 'static'
                ? 'Manually add and remove devices after creation.'
                : 'Devices are auto-assigned based on filter rules.'}
            </p>
          </div>

          {type === 'dynamic' && (
            <div>
              <label className="block text-sm font-medium mb-1">Filter Rules</label>
              <FilterBuilder
                value={filterConditions}
                onChange={setFilterConditions}
                filterFields={DEFAULT_FILTER_FIELDS}
                showPreview={false}
              />
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify no type errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/devices/CreateGroupModal.tsx
git commit -m "feat(web): add CreateGroupModal for inline group creation

Minimal modal with name, static/dynamic toggle, and FilterBuilder
for dynamic rules. Posts to /device-groups and signals parent on success."
```

---

### Task 5: Wire CreateGroupModal into DevicesPage

**Files:**
- Modify: `apps/web/src/components/devices/DevicesPage.tsx`

- [ ] **Step 1: Import and add modal state**

In `DevicesPage.tsx`, add the import at the top:

```typescript
import CreateGroupModal from './CreateGroupModal';
```

After `const [advancedFilter, setAdvancedFilter] = useState<FilterConditionGroup | null>(null);` (line 45), add:

```typescript
  const [showCreateGroup, setShowCreateGroup] = useState(false);
```

- [ ] **Step 2: Add the group-created handler and auto-select state**

After `const [showCreateGroup, setShowCreateGroup] = useState(false);`, add:

```typescript
  const [autoSelectGroupId, setAutoSelectGroupId] = useState<string | null>(null);
```

After `fetchDevices` (around line 140), add:

```typescript
  const handleGroupCreated = useCallback(async (newGroupId: string) => {
    setShowCreateGroup(false);
    setAutoSelectGroupId(newGroupId);
    await fetchDevices();
  }, [fetchDevices]);
```

- [ ] **Step 3: Pass onCreateGroup and autoSelectGroupId to DeviceList**

Update the `<DeviceList>` usage to include:

```tsx
          onCreateGroup={() => setShowCreateGroup(true)}
          autoSelectGroupId={autoSelectGroupId}
          onAutoSelectConsumed={() => setAutoSelectGroupId(null)}
```

- [ ] **Step 4: Add the modal to the JSX**

After the `<AddDeviceModal>` closing tag (around line 576), add:

```tsx
      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
        onCreated={handleGroupCreated}
      />
```

- [ ] **Step 5: Verify no type errors**

Run: `cd apps/web && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DevicesPage.tsx
git commit -m "feat(web): wire CreateGroupModal into DevicesPage

Opens from DeviceList's group dropdown '+ New Group' button.
Re-fetches groups after creation to update the filter dropdown."
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Start dev servers**

Run: `pnpm dev`

- [ ] **Step 2: Verify the group filter appears**

1. Navigate to `/devices`
2. Click "More" filters button
3. Verify "Groups" dropdown appears (or is hidden if no groups exist yet)

- [ ] **Step 3: Create a group via the modal**

1. Click "More" → the "Groups" button (if groups exist) or proceed to step 4 if no groups
2. If visible, click "+ New Group" at the bottom of the dropdown
3. Enter a name like "Test Static Group", leave type as Static
4. Click "Create Group"
5. Verify modal closes and the group appears in the dropdown

- [ ] **Step 4: Create a dynamic group**

1. Open the create modal again
2. Enter "Windows Machines", switch type to Dynamic
3. Add a filter rule: OS Type equals windows
4. Click "Create Group"
5. Verify it appears in the dropdown

- [ ] **Step 5: Test filtering**

1. Check one or more groups in the dropdown
2. Verify the device list filters to only show devices in those groups
3. Verify the "More" badge increments
4. Click "Clear filters" and verify group selection is cleared

- [ ] **Step 6: Verify "Manage Groups" link**

1. Click "Manage Groups" in the dropdown
2. Verify it navigates to `/devices/groups`
