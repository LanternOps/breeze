# Device Overview — collapsible Activity rail

**Date:** 2026-06-27
**Status:** Approved (design), implementation in progress
**Branch:** `worktree-activity-rail-collapse` (off `origin/main`)

## Problem

On the device details **Overview** tab, the Activity panel is a right-hand rail
(`lg:grid-cols-3`, main content `lg:col-span-2`). `activityHasContent` defaults
to `true`, so the page first paints the 3-column grid with an Activity skeleton.
`DeviceActivityFeed` only reports content *after* its fetch resolves; when a
device has no recent actions it fires `onHasContentChange(false)`, the grid
collapses to one column, and the main content snaps to 100% width. The result is
the "Activity column appears for a split second then disappears and the main
window stretches" glitch reported in the field (SemoTech, v0.85.0).

Today's "collapsed" state is a full-width **bottom strip** (`layout='strip'`),
which is not what users expect and still involves the jarring re-layout.

## Goal

Replace the rail↔bottom-strip swap with a **collapsible rail that collapses to a
thin vertical bar** on the right edge, showing the number of activity items.
Eliminate the load-time flash/stretch.

## Decisions (confirmed with Todd)

- **Scope:** device-details Overview tab only. No fleet-level activity row on the
  devices list (none exists today; SemoTech's "missing row" is a misremembering
  of this same rail).
- **Default state:** data-driven, **no persistence**. After the feed loads, the
  rail is **open** if there is content (events or active alerts), **collapsed**
  if empty. A manual toggle lasts only for the current view; switching devices
  re-derives from that device's own activity.
- **Load behavior — Option B:** during the async load the panel renders the
  **collapsed bar with a subtle spinner**. On load: if there is content it
  animates **open**; if empty it stays collapsed. This makes the empty-device
  case (the reported bug) produce **zero motion** — the page renders at full
  width and stays there.

## Design

### Layout (`DeviceDetails.tsx`)

The Overview container becomes a flex row on `lg+`, stacked below:

```
<div className="flex flex-col gap-6 lg:flex-row lg:items-start">
  <div className="min-w-0 flex-1 space-y-6"> …main content… </div>
  <div className="w-full shrink-0 overflow-hidden transition-[width] duration-300
                  ease-in-out lg:w-80 {collapsed ? 'lg:w-11' : 'lg:w-80'}">
    <DeviceActivityFeed collapsed={collapsed} onToggleCollapse={…} … />
  </div>
</div>
```

- The width transition animates collapse/expand on `lg+`. `overflow-hidden`
  clips the card during the reveal so it wipes in/out cleanly.
- Below `lg` the rail is always full width (`w-full`) and the collapse affordance
  is hidden — the vertical bar is a desktop side-rail concept only. Mobile shows
  the normal full-width card with its existing empty state.

### State (`DeviceDetails.tsx`)

```
const [collapsed, setCollapsed] = useState(true);   // Option B: collapsed during load
const userToggled = useRef(false);

// data-driven default — respect a manual toggle
const handleHasContentChange = useCallback((hasContent: boolean) => {
  if (userToggled.current) return;
  setCollapsed(!hasContent);
}, []);

const toggleCollapse = useCallback(() => {
  userToggled.current = true;
  setCollapsed((c) => !c);
}, []);

// re-derive per device (no persistence)
useEffect(() => {
  userToggled.current = false;
  setCollapsed(true);
}, [device.id]);
```

### `DeviceActivityFeed.tsx`

- New props: `collapsed?: boolean`, `onToggleCollapse?: () => void`.
- Drop the `layout` prop and the `'strip'` branches entirely (now unused).
- Keep `onHasContentChange` — it drives the parent's default.
- **Collapsed bar** (rendered only when `collapsed`, `hidden lg:flex`): a 44px
  vertical handle styled like the cards (`rounded-lg border bg-card shadow-xs`),
  containing an Activity icon, a count badge, a vertical `Activity` label
  (`[writing-mode:vertical-rl]`), and an expand chevron. The whole bar is a
  button → `onToggleCollapse`.
  - **Count badge** = `events.length + activeAlerts`, shown only when `> 0`,
    suffixed `+` when `hasMore`, capped `99+`. While `loading`, show a small
    spinner instead of the badge.
  - If `activeAlerts > 0`, tint the bar/badge with the warning accent and note
    the alert count in the `aria-label`.
- **Expanded card**: add a collapse button (chevron) in the header next to the
  `Activity` heading, `hidden lg:inline-flex` → `onToggleCollapse`. Card is
  `lg:hidden` when `collapsed` so it doesn't overflow the 44px rail.

### Accessibility

- Collapsed bar: `aria-label="Expand activity (N items, M active alerts)"`,
  `data-testid="activity-rail-collapsed"`.
- Expanded collapse button: `aria-label="Collapse activity"`.

## Testing

- Update `DeviceActivityFeed.test.tsx`: remove the `layout='strip'` test; keep
  the `onHasContentChange` content/empty/alerts tests (contract unchanged).
- Add tests: collapsed bar renders count badge from events+alerts; clicking the
  bar fires `onToggleCollapse`; spinner shows while loading; expanded header
  collapse button fires `onToggleCollapse`.
- (Parent data-driven default + per-device reset is verified manually via
  screenshots; the logic is thin and the feed-level contract is unit-tested.)

## Out of scope

- Fleet-level / devices-list activity aggregation.
- Persisting the collapse preference across visits.
```

