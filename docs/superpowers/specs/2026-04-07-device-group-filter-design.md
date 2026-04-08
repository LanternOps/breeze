# Device Group Filter on Devices Page

**Date:** 2026-04-07
**Status:** Draft

## Problem

Device groups exist in the schema and API (`GET /device-groups`, `POST /device-groups`, etc.) with a full management page at `/devices/groups`, but that page is unreachable from the UI — no sidebar link, no navigation path. Groups are invisible to users.

## Solution

Integrate device group filtering directly into the DeviceList component on the main `/devices` page, and provide inline group creation so users can create and use groups without leaving the page.

## Design

### Data Fetching

On DevicesPage load, add a parallel fetch alongside existing devices/orgs/sites:

- `GET /device-groups?includeMemberships=true` — returns groups with `id`, `name`, `type`, `deviceCount`, and `deviceIds` (array of member device IDs)

The existing `GET /device-groups` endpoint returns `deviceCount` but not `deviceIds`. Add an optional `includeMemberships` query param that, when true, also returns the `deviceIds` array per group. This is a small addition to the list endpoint in `apps/api/src/routes/groups.ts`.

Build a `Map<groupId, Set<deviceId>>` for client-side filtering. Pass groups array and membership map down to DeviceList as props.

### Filter UI

Add a multi-select group filter to DeviceList's "More" filters panel (the expandable row containing role, org, site dropdowns).

**Component:** A button labeled "Groups" that opens a checkbox dropdown on click.

- Each row: checkbox + group name + type badge ("static" / "dynamic")
- Badge on the button shows count of selected groups
- Bottom of dropdown: "+ New Group" button and "Manage Groups" link (to `/devices/groups`)

**Filter logic:** If any groups are selected, a device must appear in at least one selected group's membership set (union/OR). Added to the existing `filteredDevices` memo alongside status, OS, role, org, site filters.

**Integration with existing filter controls:**
- `moreFiltersCount` includes group selections
- "Clear filters" resets group selection
- Group filter state: `groupFilter: string[]` (array of selected group IDs)

### Create Group Modal

Triggered by "+ New Group" in the dropdown. Minimal form:

- **Name** — text input, required
- **Type** — toggle between Static and Dynamic
- **Filter conditions** — shown only for Dynamic type, using the existing `FilterBuilder` component

On submit: `POST /device-groups` with `{ name, type, filterConditions? }`. On success:
- Refresh groups list
- Auto-select the new group in the filter
- Close modal

The modal does not replicate full group management (device assignment, drag-and-drop, bulk actions, policy linking). For those features, users follow the "Manage Groups" link to `/devices/groups`.

### Files to Modify

1. **`apps/api/src/routes/groups.ts`** — add `includeMemberships` query param to `GET /` list endpoint; when true, fetch and return `deviceIds` array per group
2. **`apps/web/src/components/devices/DevicesPage.tsx`** — fetch groups with memberships, build membership map, pass both to DeviceList
3. **`apps/web/src/components/devices/DeviceList.tsx`** — add group filter state, dropdown UI in "More" panel, filter logic in `filteredDevices` memo
4. **New: `apps/web/src/components/devices/CreateGroupModal.tsx`** — inline group creation modal

### What This Does NOT Change

- The existing DeviceGroupsPage at `/devices/groups` remains as-is for full group management
- The advanced FilterBuilder's `group.id` field remains available
- No sidebar navigation changes
- No API schema changes
