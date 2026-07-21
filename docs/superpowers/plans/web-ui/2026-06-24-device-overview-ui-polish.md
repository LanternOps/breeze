# Device Overview UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Device → Overview tab clearer: surface automated activity (scheduled patches, automations) in the Activity feed, collapse the Activity pane when empty, and de-confuse the Reliability card (`Health N/100` labels + tooltips).

**Architecture:** Four focused changes. (1) The events API gains an opt-in `includeAutomated` flag that ORs in `agent.command.%` rows scoped to `actor_type IN ('system','agent')` (the dedup discriminator). (2) The Reliability panel relabels factor scores and adds `HelpTooltip` explainers. (3) The Activity feed renders those automated rows with an "Automated" chip. (4) The feed reports content state up so `DeviceDetails` collapses the right rail when empty.

**Tech Stack:** Hono + Drizzle + Zod (API, Vitest), Astro/React + Tailwind (web, Vitest + jsdom + Testing Library), Lucide icons.

## Global Constraints

- API tests: Vitest with shallow Drizzle mocks — see `apps/api/src/routes/devices/events.test.ts`. No real DB in the unit job.
- Web tests: Vitest + jsdom + `@testing-library/react`; mock `fetchWithAuth` from `../../stores/auth`.
- Reuse the shared tooltip primitive `apps/web/src/components/shared/HelpTooltip.tsx` (`<HelpTooltip text={...} />`) — do not build a new one.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Run web tests with: `pnpm --filter @breeze/web test -- <path>`. Run API tests with: `pnpm --filter @breeze/api exec vitest run <path>`.
- Branch: `worktree-device-overview-ui` (already created; spec at `docs/superpowers/specs/web-ui/2026-06-24-device-overview-ui-polish-design.md`).

---

## File Structure

- `apps/api/src/routes/devices/events.ts` — add `includeAutomated` query param + predicate; add 5 `agent.command.*` labels; `export` `formatActionMessage`.
- `apps/api/src/routes/devices/events.test.ts` — validation + label-formatting tests.
- `apps/web/src/components/devices/DeviceReliabilityPanel.tsx` — `Health N/100` factor labels; tooltips on factor cards, Score, At-risk badge.
- `apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx` — extend.
- `apps/web/src/components/devices/DeviceActivityFeed.tsx` — `includeAutomated=true`; automated icons; "Automated" chip; `onHasContentChange` + `layout` props.
- `apps/web/src/components/devices/DeviceActivityFeed.test.tsx` — new file.
- `apps/web/src/components/devices/DeviceDetails.tsx` — collapse the Overview right rail when the feed is empty.

---

## Task 1: API — `includeAutomated` filter + automated-command labels

**Files:**
- Modify: `apps/api/src/routes/devices/events.ts`
- Test: `apps/api/src/routes/devices/events.test.ts`

**Interfaces:**
- Produces: `GET /devices/:id/events?includeAutomated=true` — when set, the response also includes rows whose `action LIKE 'agent.command.%'` AND `actor_type IN ('system','agent')`. New `actionLabels` entries for `agent.command.{install_patches,rollback_patches,script,software_uninstall,software_update}`. `formatActionMessage` becomes an exported function.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/routes/devices/events.test.ts`. First extend the import on line 81:

```ts
import { eventsRoutes, likePrefixPattern, formatActionMessage } from './events';
```

Then add two new `describe` blocks (place after the existing `likePrefixPattern` describe):

```ts
describe('formatActionMessage (automated command labels)', () => {
  it('labels automated patch installs', () => {
    expect(formatActionMessage('agent.command.install_patches', 'host-1', 'success'))
      .toBe('Patches installed — host-1');
  });
  it('labels automated script runs', () => {
    expect(formatActionMessage('agent.command.script', null, 'success'))
      .toBe('Script ran');
  });
  it('marks a failed automated patch install', () => {
    expect(formatActionMessage('agent.command.install_patches', 'host-1', 'failure'))
      .toBe('Patches installed — host-1 (failed)');
  });
  it('labels rollback, uninstall, and update', () => {
    expect(formatActionMessage('agent.command.rollback_patches', null, 'success')).toBe('Patches rolled back');
    expect(formatActionMessage('agent.command.software_uninstall', null, 'success')).toBe('Software uninstalled');
    expect(formatActionMessage('agent.command.software_update', null, 'success')).toBe('Software updated');
  });
});
```

And inside the existing `describe('GET /devices/:id/events validation', ...)` block, add:

```ts
  it('accepts includeAutomated=true', async () => {
    const res = await app.request('/00000000-0000-0000-0000-000000000001/events?includeAutomated=true');
    expect(res.status).toBe(200);
  });
  it('accepts includeAutomated=false', async () => {
    const res = await app.request('/00000000-0000-0000-0000-000000000001/events?includeAutomated=false');
    expect(res.status).toBe(200);
  });
  it('rejects an invalid includeAutomated value with 400', async () => {
    const res = await app.request('/00000000-0000-0000-0000-000000000001/events?includeAutomated=maybe');
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/devices/events.test.ts`
Expected: FAIL — `formatActionMessage` is not exported (import error) and the `includeAutomated=maybe` case returns 200 (no validation yet).

- [ ] **Step 3: Add the query param, predicate, labels, and export**

In `apps/api/src/routes/devices/events.ts`:

(a) In `eventsQuerySchema` (after the `actions` field, before `withTotal`), add:

```ts
  // Opt-in: also surface automated agent-dispatched commands (scheduled
  // patches, automations) that are written as `agent.command.<type>` with
  // actor_type 'system'/'agent'. Off by default so existing callers are
  // unaffected (issue: device-overview automated activity).
  includeAutomated: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
```

(b) Update the destructure (currently lines ~96-97) to include it:

```ts
    const { search, category, result, initiatedBy, from, to, page, limit, actions, withTotal, includeAutomated } =
      c.req.valid('query');
```

(c) Replace the existing `actions` filter block:

```ts
    if (actions && actions.length > 0) {
      // Match any of the supplied action prefixes (server-side equivalent of the
      // overview pane's "deliberate action" filter). `LIKE` with an escaped
      // prefix keeps it index-friendly and avoids ILIKE's case-fold cost — audit
      // action keys are already lowercase dotted identifiers.
      conditions.push(
        or(...actions.map((prefix) => sql`${auditLogs.action} LIKE ${likePrefixPattern(prefix)}`))!
      );
    }
```

with:

```ts
    // The overview "deliberate action" filter: any supplied action prefix, plus
    // (opt-in) automated agent-dispatched commands. Both go into one OR group.
    const actionClauses: SQL[] = [];
    if (actions && actions.length > 0) {
      // `LIKE` with an escaped prefix keeps it index-friendly and avoids ILIKE's
      // case-fold cost — audit action keys are already lowercase dotted ids.
      for (const prefix of actions) {
        actionClauses.push(sql`${auditLogs.action} LIKE ${likePrefixPattern(prefix)}`);
      }
    }
    if (includeAutomated) {
      // Automated patch runs / automations are written by commandQueue as
      // `agent.command.<type>` with actor_type 'system'/'agent' and no
      // route-audit twin. Manual commands (actor_type 'user') are excluded —
      // they're already represented by their richer route audit
      // (script.execute, device.patch.*), so this avoids double-listing.
      actionClauses.push(
        sql`(${auditLogs.action} LIKE ${likePrefixPattern('agent.command.')} AND ${auditLogs.actorType} IN ('system','agent'))`
      );
    }
    if (actionClauses.length > 0) {
      conditions.push(or(...actionClauses)!);
    }
```

(d) Add the five labels to the `actionLabels` map (e.g. right after the `'script.execution.cancel'` entry):

```ts
  'agent.command.install_patches': 'Patches installed',
  'agent.command.rollback_patches': 'Patches rolled back',
  'agent.command.script': 'Script ran',
  'agent.command.software_uninstall': 'Software uninstalled',
  'agent.command.software_update': 'Software updated',
```

(e) Export `formatActionMessage` — change its declaration from
`function formatActionMessage(` to `export function formatActionMessage(`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/devices/events.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/events.ts apps/api/src/routes/devices/events.test.ts
git commit -m "feat(api): surface automated agent-command activity in device events feed

Adds opt-in includeAutomated flag that ORs in agent.command.% rows scoped
to actor_type system/agent (dedup vs manual route audits), plus labels for
automated patch/script/software commands.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Reliability panel — `Health N/100` + explainer tooltips

**Files:**
- Modify: `apps/web/src/components/devices/DeviceReliabilityPanel.tsx`
- Test: `apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx`

**Interfaces:**
- Consumes: `HelpTooltip` from `../shared/HelpTooltip` (`<HelpTooltip text={string} />`), `scoreBandLabel` (already in file).
- Produces: factor cards render `Health {score}/100`; a Score tooltip and an At-risk tooltip with computed text.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx`. The existing `renders reliability score drivers` test seeds a snapshot with `score: 20` for the Crashes driver; add assertions in a new test that reuses the same fetch setup. Append inside the `describe('DeviceReliabilityPanel', ...)` block:

```ts
  it('labels factor scores as Health N/100 (not a bare count)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          reliabilityScore: 55,
          trendDirection: 'stable',
          trendConfidence: 0.7,
          uptime30d: 16.8,
          crashCount30d: 0,
          hangCount30d: 4,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 0,
          mtbfHours: 7,
          topIssues: [],
          drivers: [
            { factor: 'crashes', label: 'Crashes', score: 100, weight: 25, lostPoints: 0, evidence: { crashCount7d: 0 } },
          ],
          computedAt: '2026-06-23T19:00:00Z',
        },
      })
    );
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    expect(await screen.findByText('Health 100/100')).toBeInTheDocument();
  });

  it('shows an At-risk explainer tooltip naming the top drag factor', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          reliabilityScore: 55,
          trendDirection: 'stable',
          trendConfidence: 0.7,
          uptime30d: 16.8,
          crashCount30d: 0,
          hangCount30d: 4,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 0,
          mtbfHours: 7,
          topIssues: [],
          drivers: [
            { factor: 'uptime', label: 'Uptime', score: 0, weight: 30, lostPoints: 30, evidence: {} },
          ],
          computedAt: '2026-06-23T19:00:00Z',
        },
      })
    );
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    // The At-risk help icon reveals its tooltip text on hover/click.
    const atRiskHelp = await screen.findByTestId('reliability-atrisk-help');
    fireEvent.click(atRiskHelp.querySelector('button')!);
    expect(await screen.findByText(/Biggest drag: Uptime/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/web test -- src/components/devices/DeviceReliabilityPanel.test.tsx`
Expected: FAIL — "Health 100/100" and `reliability-atrisk-help` don't exist yet.

- [ ] **Step 3: Implement the panel changes**

In `apps/web/src/components/devices/DeviceReliabilityPanel.tsx`:

(a) Add the import at the top (with the other component imports):

```ts
import HelpTooltip from '../shared/HelpTooltip';
```

(b) Add a helper to compute the top-drag factor label (place near the other top-level helpers, after `scoreBandLabel`):

```ts
function topDragLabel(snapshot: ReliabilitySnapshot): string | null {
  const driver = (snapshot.drivers ?? [])[0];
  if (driver) return driver.label;
  const issue = snapshot.topIssues[0];
  return issue ? issueLabels[issue.type] : null;
}
```

(c) Wrap the Score block (currently the `<div className="text-xs text-muted-foreground">Score</div>` group) so the label carries a tooltip. Replace:

```tsx
            <div>
              <div className="text-xs text-muted-foreground">Score</div>
              <div className={`text-3xl font-semibold tabular-nums ${scoreClass(snapshot.reliabilityScore)}`}>
                {snapshot.reliabilityScore}
              </div>
            </div>
```

with:

```tsx
            <div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                Score
                <HelpTooltip
                  text={`Reliability score ${snapshot.reliabilityScore}/100 — ${scoreBandLabel(snapshot.reliabilityScore)}. Bands: ≤50 critical, ≤70 poor, ≤85 fair, else good.`}
                />
              </div>
              <div className={`text-3xl font-semibold tabular-nums ${scoreClass(snapshot.reliabilityScore)}`}>
                {snapshot.reliabilityScore}
              </div>
            </div>
```

(d) Add a tooltip beside the At-risk badge. Replace:

```tsx
            {snapshot.reliabilityScore <= 70 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                At risk
              </span>
            )}
```

with:

```tsx
            {snapshot.reliabilityScore <= 70 && (
              <span className="inline-flex items-center gap-1" data-testid="reliability-atrisk-help">
                <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  At risk
                </span>
                <HelpTooltip
                  text={
                    topDragLabel(snapshot)
                      ? `Shown when the reliability score is ≤ 70. Biggest drag: ${topDragLabel(snapshot)}.`
                      : 'Shown when the reliability score is ≤ 70.'
                  }
                />
              </span>
            )}
```

(e) Relabel the factor-card score. Replace:

```tsx
              <span className={`text-sm font-semibold tabular-nums ${scoreClass(driver.score)}`}>{driver.score}</span>
```

with:

```tsx
              <span className="flex items-center gap-1">
                <span className={`text-sm font-semibold tabular-nums ${scoreClass(driver.score)}`}>
                  Health {driver.score}/100
                </span>
                <HelpTooltip
                  text={`Factor health 0–100; 100 = no issues detected. Counts to ${driver.weight}% of the overall reliability score. The raw counts are listed below.`}
                />
              </span>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @breeze/web test -- src/components/devices/DeviceReliabilityPanel.test.tsx`
Expected: PASS (existing + new). Note: the existing `renders reliability score drivers` test asserts the driver score `20` is shown — verify it still passes; if it asserted the bare text `'20'`, update that assertion to `'Health 20/100'`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceReliabilityPanel.tsx apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx
git commit -m "feat(web): clarify reliability card (Health N/100 + explainer tooltips)

Factor cards now read 'Health N/100' so a perfect '100' no longer reads as a
count; adds HelpTooltips on the Score and At-risk badge explaining the bands
and the top drag factor.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Activity feed — render automated rows + "Automated" chip

**Files:**
- Modify: `apps/web/src/components/devices/DeviceActivityFeed.tsx`
- Test: `apps/web/src/components/devices/DeviceActivityFeed.test.tsx` (new)

**Interfaces:**
- Consumes: `GET /devices/:id/events?...&includeAutomated=true` (Task 1).
- Produces: feed rows for `agent.command.*` actions with sensible icons; an "Automated" chip when `initiatedBy` is null and `actor.type` is `system`/`agent`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/devices/DeviceActivityFeed.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceActivityFeed from './DeviceActivityFeed';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// Route the events call vs the alerts call by URL.
function mockFeed(events: unknown[], alerts: unknown[] = []) {
  fetchWithAuthMock.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes('/events')
        ? jsonResponse({ data: events, pagination: { page: 1, limit: 10, total: null } })
        : jsonResponse({ data: alerts })
    )
  );
}

describe('DeviceActivityFeed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('requests automated activity', async () => {
    mockFeed([]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        expect.stringContaining('includeAutomated=true'),
        expect.anything()
      )
    );
  });

  it('shows an Automated chip for a system-initiated row with no initiatedBy', async () => {
    mockFeed([
      {
        id: 'e1',
        action: 'agent.command.install_patches',
        message: 'Patches installed — host-1',
        result: 'success',
        initiatedBy: null,
        timestamp: new Date().toISOString(),
        actor: { type: 'system', name: 'System' },
      },
    ]);
    render(<DeviceActivityFeed deviceId="dev-1" />);
    expect(await screen.findByText('Patches installed — host-1')).toBeInTheDocument();
    expect(screen.getByText('Automated')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/web test -- src/components/devices/DeviceActivityFeed.test.tsx`
Expected: FAIL — request lacks `includeAutomated=true` and no "Automated" chip is rendered.

- [ ] **Step 3: Implement the feed changes**

In `apps/web/src/components/devices/DeviceActivityFeed.tsx`:

(a) Add icons for automated commands to `ACTION_RULES` (append after the existing entries, before the closing `];`):

```ts
  { prefix: 'agent.command.install_patches', icon: Download },
  { prefix: 'agent.command.rollback_patches', icon: RotateCcw },
  { prefix: 'agent.command.script', icon: Terminal },
  { prefix: 'agent.command.software_uninstall', icon: Package },
  { prefix: 'agent.command.software_update', icon: Package },
```

(b) Add `&includeAutomated=true` to the events URL. Change the `eventsUrl` template:

```ts
        const eventsUrl = `/devices/${deviceId}/events?limit=${PAGE_SIZE}&page=${page}&includeAutomated=true&actions=${encodeURIComponent(
          ACTION_PREFIXES
        )}`;
```

(c) Derive an "Automated" chip when there's no `initiatedBy` but the actor is system/agent. In the row render, the existing code computes `initiator`. Just below it add:

```ts
              const automated =
                !initiator && (e.actor?.type === 'system' || e.actor?.type === 'agent');
```

Then change the chip-rendering block. Replace:

```tsx
                      {/* Show the initiator chip only when it isn't already the "who". */}
                      {initiator && who !== initiator && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {initiator}
                        </span>
                      )}
```

with:

```tsx
                      {/* Show the initiator chip only when it isn't already the "who". */}
                      {initiator && who !== initiator && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {initiator}
                        </span>
                      )}
                      {/* System/agent-dispatched commands carry no initiatedBy; mark them Automated. */}
                      {automated && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Automated
                        </span>
                      )}
```

Note: `ACTION_PREFIXES` (line ~59) is derived from `ACTION_RULES`, so the new `agent.command.*` prefixes are automatically included in the `actions=` param. Keep `includeAutomated=true` as the explicit server-side opt-in (the server applies the `actor_type` dedup that the prefix list alone cannot).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @breeze/web test -- src/components/devices/DeviceActivityFeed.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceActivityFeed.tsx apps/web/src/components/devices/DeviceActivityFeed.test.tsx
git commit -m "feat(web): show automated activity in device feed with an Automated chip

Requests includeAutomated=true, renders agent.command.* rows with icons, and
tags system/agent-dispatched rows (no initiatedBy) as 'Automated'.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Activity feed — collapse the rail when empty

**Files:**
- Modify: `apps/web/src/components/devices/DeviceActivityFeed.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx`
- Test: `apps/web/src/components/devices/DeviceActivityFeed.test.tsx`

**Interfaces:**
- Consumes: `DeviceActivityFeed` from Task 3.
- Produces: `DeviceActivityFeed` accepts `onHasContentChange?: (hasContent: boolean) => void` and `layout?: 'rail' | 'strip'` (default `'rail'`). `DeviceDetails` Overview renders full-width main + bottom strip when the feed reports no content.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/components/devices/DeviceActivityFeed.test.tsx`:

```tsx
  it('reports no content when the feed is empty', async () => {
    mockFeed([], []);
    const onHasContentChange = vi.fn();
    render(<DeviceActivityFeed deviceId="dev-1" onHasContentChange={onHasContentChange} />);
    await waitFor(() => expect(onHasContentChange).toHaveBeenLastCalledWith(false));
  });

  it('reports content when there are events', async () => {
    mockFeed([
      {
        id: 'e1',
        action: 'agent.command.script',
        message: 'Script ran',
        result: 'success',
        initiatedBy: null,
        timestamp: new Date().toISOString(),
        actor: { type: 'system', name: 'System' },
      },
    ]);
    const onHasContentChange = vi.fn();
    render(<DeviceActivityFeed deviceId="dev-1" onHasContentChange={onHasContentChange} />);
    await waitFor(() => expect(onHasContentChange).toHaveBeenLastCalledWith(true));
  });

  it('renders a compact one-line empty state in strip layout', async () => {
    mockFeed([], []);
    render(<DeviceActivityFeed deviceId="dev-1" layout="strip" />);
    expect(await screen.findByTestId('activity-empty-strip')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @breeze/web test -- src/components/devices/DeviceActivityFeed.test.tsx`
Expected: FAIL — props don't exist; no `activity-empty-strip` testid.

- [ ] **Step 3: Implement the feed prop changes**

In `apps/web/src/components/devices/DeviceActivityFeed.tsx`:

(a) Extend the props type:

```ts
type DeviceActivityFeedProps = {
  deviceId: string;
  timezone?: string;
  layout?: 'rail' | 'strip';
  onHasContentChange?: (hasContent: boolean) => void;
};
```

(b) Update the component signature:

```ts
export default function DeviceActivityFeed({
  deviceId,
  timezone,
  layout = 'rail',
  onHasContentChange,
}: DeviceActivityFeedProps) {
```

(c) Report content state after each settled load. Add an effect after the existing mount effect (after the `useEffect` that calls `loadPage(1, ...)`):

```ts
  // Report whether the pane has anything worth showing so the parent can
  // collapse the right rail when it's empty. Only meaningful once loaded.
  useEffect(() => {
    if (loading) return;
    onHasContentChange?.(events.length > 0 || activeAlerts > 0);
  }, [loading, events.length, activeAlerts, onHasContentChange]);
```

(d) Render a compact empty state in `strip` layout. Replace the empty-state line:

```tsx
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent actions on this device.</p>
        ) : (
```

with:

```tsx
        ) : visible.length === 0 ? (
          layout === 'strip' ? (
            <div data-testid="activity-empty-strip" className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              <span>No recent actions on this device.</span>
              <a href="#activities" className="font-medium text-primary hover:underline">
                View all activity →
              </a>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No recent actions on this device.</p>
          )
        ) : (
```

Note: in `strip` layout the empty state already includes its own "View all activity" link, and the bottom `View all activity` link (rendered when `!loading && !error`) would duplicate it. Guard that bottom link so it's hidden when the strip empty-state is shown. Change:

```tsx
      {!loading && !error && (
        <a
          href="#activities"
```

to:

```tsx
      {!loading && !error && !(layout === 'strip' && visible.length === 0) && (
        <a
          href="#activities"
```

- [ ] **Step 4: Run the feed tests to verify they pass**

Run: `pnpm --filter @breeze/web test -- src/components/devices/DeviceActivityFeed.test.tsx`
Expected: PASS (all feed tests, including Task 3's).

- [ ] **Step 5: Wire the collapse into DeviceDetails**

In `apps/web/src/components/devices/DeviceDetails.tsx`:

(a) Add an `activityHasContent` state inside the component (near the other `useState`s; default `true` so the populated case never flashes):

```ts
  const [activityHasContent, setActivityHasContent] = useState(true);
```

(b) Replace the Overview grid block (currently the `{activeTab === 'overview' && ( ... )}` region, the `grid gap-6 lg:grid-cols-3` wrapper through `<DeviceActivityFeed ... />`):

```tsx
      {activeTab === 'overview' && (
        <div className={activityHasContent ? 'grid gap-6 lg:grid-cols-3' : 'space-y-6'}>
          <div className={`space-y-6 ${activityHasContent ? 'lg:col-span-2' : ''}`}>
            {/* ... existing CPU/RAM/Uptime + Last Seen/User/Idle stat card ... */}
            {/* ... existing DeviceReliabilityPanel / DevicePerformanceGraphs / DeviceWarrantyCard ... */}
          </div>

          {activityHasContent ? (
            <DeviceActivityFeed
              deviceId={device.id}
              timezone={effectiveTimezone}
              onHasContentChange={setActivityHasContent}
            />
          ) : (
            <DeviceActivityFeed
              deviceId={device.id}
              timezone={effectiveTimezone}
              layout="strip"
              onHasContentChange={setActivityHasContent}
            />
          )}
        </div>
      )}
```

Keep the existing inner stat-card and panel JSX exactly as-is inside the left `<div>` — only the wrapper `className`s and the `DeviceActivityFeed` invocation change. The empty case puts the strip feed full-width at the bottom of the `space-y-6` stack.

- [ ] **Step 6: Build-check the web app (type safety on the layout change)**

Run: `pnpm --filter @breeze/web exec astro check 2>&1 | tail -20`
Expected: no new type errors in `DeviceDetails.tsx` / `DeviceActivityFeed.tsx`. (If `astro check` is slow/unavailable, run `pnpm --filter @breeze/web exec tsc --noEmit` on the web package instead.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/devices/DeviceActivityFeed.tsx apps/web/src/components/devices/DeviceDetails.tsx apps/web/src/components/devices/DeviceActivityFeed.test.tsx
git commit -m "feat(web): collapse the device Activity rail when empty

The feed reports content state up; DeviceDetails spans the Overview main
column full-width and drops Activity to a compact bottom strip when there are
no recent actions and no active alerts.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification + spec sync

**Files:** none (verification only), plus optional doc touch-ups.

- [ ] **Step 1: Run all touched test suites**

```bash
pnpm --filter @breeze/api exec vitest run src/routes/devices/events.test.ts
pnpm --filter @breeze/web test -- src/components/devices/DeviceActivityFeed.test.tsx src/components/devices/DeviceReliabilityPanel.test.tsx
```
Expected: all green.

- [ ] **Step 2: Manual smoke (optional but recommended)**

Bring up the worktree stack (see `worktree-stack` skill) or `make dev-push`, open a device with no recent actions, confirm: Activity collapses to a bottom strip and the Overview content spans full width; open a device with automated patch/automation history and confirm automated rows show with an "Automated" chip; confirm the Reliability factor cards read `Health N/100` and the Score / At-risk tooltips appear on hover.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin worktree-device-overview-ui
gh pr create --title "Device overview UI polish: automated activity, collapsing Activity pane, clearer Reliability" --body "$(cat <<'EOF'
## Summary
- Surface automated activity (scheduled patches, automations) in the device Activity feed, tagged with an **Automated** chip. Server adds an opt-in `includeAutomated` flag that ORs in `agent.command.%` rows scoped to `actor_type IN ('system','agent')` — manual commands are excluded (already shown via their route audits), so no double-listing.
- Collapse the Activity rail when a device has no recent actions and no active alerts: the Overview main column goes full-width and Activity drops to a compact bottom strip.
- De-confuse the Reliability card: factor scores now read **`Health N/100`** (a green `100` no longer reads as a crash count), with `HelpTooltip` explainers on the Score and the **At risk** badge.

Spec: `docs/superpowers/specs/web-ui/2026-06-24-device-overview-ui-polish-design.md`
Plan: `docs/superpowers/plans/web-ui/2026-06-24-device-overview-ui-polish.md`

## Out of scope (follow-ups)
- Fine-grained `initiatedBy` (schedule vs automation vs policy) plumbed through `queueCommand` call sites for richer-than-"Automated" badges.
- macOS↔Linux reliability factor order/weight inconsistency (WIP).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Automated activity in feed → Task 1 (API) + Task 3 (web). ✓
- Alerts already in pane → no change needed (documented in spec findings). ✓
- Collapse empty Activity pane → Task 4. ✓
- Reliability `Health N/100` → Task 2. ✓
- At-risk + Score tooltips → Task 2. ✓
- Dedup hazard (manual double-listing) → Task 1 `actor_type` guard. ✓
- Out-of-scope items → captured in PR body. ✓

**Placeholder scan:** All steps contain concrete code/commands. The one `{/* ... existing ... */}` marker in Task 4 Step 5 is an explicit "leave this JSX unchanged" instruction, not a missing implementation. ✓

**Type consistency:** `onHasContentChange: (hasContent: boolean) => void` and `layout?: 'rail' | 'strip'` are used identically in the feed (Tasks 3–4) and `DeviceDetails` (Task 4). `formatActionMessage(action, resourceName, result)` signature matches its definition in `events.ts`. `topDragLabel(snapshot)` returns `string | null`, handled in both call sites. ✓
