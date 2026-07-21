# Reliability Card CTA + Feedback UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Device Reliability card a primary "Ask AI about reliability" action (auto-seeded with the snapshot) and consolidate the three ML-feedback buttons into a de-emphasized "Mark outcome" menu.

**Architecture:** Frontend-only. Extend `aiStore.startDeviceTask` to optionally auto-send a seed message after creating the device-scoped session. The `DeviceReliabilityPanel` builds a client-side seed prompt from the snapshot it already holds and wires the new CTA; the feedback buttons become a single click-outside menu matching the existing `SavedViewsMenu` idiom. No API or scoring changes (issue #1721 Part 3 shipped in #1804).

**Tech Stack:** React + TypeScript, Zustand store, Tailwind, lucide-react icons, Vitest + Testing Library (jsdom).

## Global Constraints

- Node: prefix test/typecheck commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (repo pins node 22.20.0; default node breaks pnpm engine-strict).
- Do **not** change the ML-feedback API contract: outcome values stay `failure_confirmed` / `replaced` / `false_alarm`; endpoint stays `POST /reliability/:id/feedback`.
- `AiPageContext` device shape (from `@breeze/shared`): `{ type: 'device'; id: string; hostname: string; os?: string; status?: string; ip?: string }`.
- Reuse `useClickOutside(isActive, ref, onOutside)` from `apps/web/src/hooks/useClickOutside.ts` for the menu (do not hand-roll a listener).
- Run affected web test files single-file (not the whole suite) to avoid known cross-file flakiness.

---

### Task 1: Auto-seed `startDeviceTask` in the AI store

**Files:**
- Modify: `apps/web/src/stores/aiStore.ts` (type decl ~line 59, implementation ~lines 155-161)
- Test: `apps/web/src/stores/aiStore.test.ts`

**Interfaces:**
- Produces: `startDeviceTask(deviceId: string, ctx: AiPageContext, initialMessage?: string): Promise<void>` — when `initialMessage` is a non-empty string and session creation succeeded, it forwards the message to `sendMessage`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/src/stores/aiStore.test.ts` inside the `describe('ai store', …)` block:

```ts
  it('startDeviceTask forwards initialMessage to sendMessage', async () => {
    const state = useAiStore.getState();
    const createSpy = vi.spyOn(state, 'createSession').mockImplementation(async () => {
      useAiStore.setState({ sessionId: 'session-x' });
    });
    const sendSpy = vi.spyOn(state, 'sendMessage').mockResolvedValue();

    await useAiStore.getState().startDeviceTask(
      'dev-1',
      { type: 'device', id: 'dev-1', hostname: 'host-1' },
      'seed prompt',
    );

    expect(createSpy).toHaveBeenCalledWith({ deviceId: 'dev-1' });
    expect(sendSpy).toHaveBeenCalledWith('seed prompt');
    expect(useAiStore.getState().isOpen).toBe(true);
    expect(useAiStore.getState().pageContext).toEqual({ type: 'device', id: 'dev-1', hostname: 'host-1' });
  });

  it('startDeviceTask does not send when initialMessage is omitted', async () => {
    const state = useAiStore.getState();
    vi.spyOn(state, 'createSession').mockImplementation(async () => {
      useAiStore.setState({ sessionId: 'session-x' });
    });
    const sendSpy = vi.spyOn(state, 'sendMessage').mockResolvedValue();

    await useAiStore.getState().startDeviceTask('dev-1', { type: 'device', id: 'dev-1', hostname: 'host-1' });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('startDeviceTask does not send when session creation failed', async () => {
    const state = useAiStore.getState();
    vi.spyOn(state, 'createSession').mockImplementation(async () => {
      useAiStore.setState({ sessionId: null, error: 'nope' });
    });
    const sendSpy = vi.spyOn(state, 'sendMessage').mockResolvedValue();

    await useAiStore.getState().startDeviceTask('dev-1', { type: 'device', id: 'dev-1', hostname: 'host-1' }, 'seed prompt');

    expect(sendSpy).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/stores/aiStore.test.ts -t startDeviceTask`
Expected: FAIL — the `startDeviceTask forwards initialMessage` test fails because the current implementation never calls `sendMessage`.

- [ ] **Step 3: Update the type declaration**

In `apps/web/src/stores/aiStore.ts`, change the `AiState` interface member (currently `startDeviceTask: (deviceId: string, ctx: AiPageContext) => Promise<void>;`) to:

```ts
  startDeviceTask: (deviceId: string, ctx: AiPageContext, initialMessage?: string) => Promise<void>;
```

- [ ] **Step 4: Update the implementation**

Replace the existing `startDeviceTask` implementation (the block starting `startDeviceTask: async (deviceId, ctx) => {`) with:

```ts
  // Start a fresh AI session bound to a specific device ("Ask AI about reliability"
  // on the device page). Sets the device page-context, opens the panel, creates a
  // device-scoped session, and — when an initial message is supplied — auto-sends it
  // so the tech gets an answer without retyping the context.
  startDeviceTask: async (deviceId, ctx, initialMessage) => {
    set({ pageContext: ctx, sessionId: null, messages: [], isFlagged: false, flagReason: null, isOpen: true });
    await get().createSession({ deviceId });
    // Only send if the session was actually created — createSession leaves
    // sessionId null and sets `error` on failure; sending then would be session-less.
    if (initialMessage && initialMessage.trim() && get().sessionId) {
      await get().sendMessage(initialMessage);
    }
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/stores/aiStore.test.ts`
Expected: PASS (all existing tests plus the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/stores/aiStore.ts apps/web/src/stores/aiStore.test.ts
git commit -m "feat(web): auto-seed startDeviceTask with an initial message (#1721)"
```

---

### Task 2: Primary "Ask AI about reliability" CTA on the card

**Files:**
- Modify: `apps/web/src/components/devices/DeviceReliabilityPanel.tsx`
- Test: `apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx`

**Interfaces:**
- Consumes: `useAiStore` selector → `startDeviceTask(deviceId, ctx, initialMessage?)` from Task 1.
- Produces: a `buildReliabilitySeedPrompt(snapshot, drivers)` helper and an `askAi()` handler within the component.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx`, add the store mock near the other `vi.mock` calls (top of file, after the existing mocks):

```ts
const startDeviceTaskMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/aiStore', () => ({
  useAiStore: (selector: (s: { startDeviceTask: unknown }) => unknown) =>
    selector({ startDeviceTask: startDeviceTaskMock }),
}));
```

Then add this test inside the `describe` block:

```ts
  it('Ask AI button starts a device task seeded with the snapshot', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          hostname: 'host-1',
          osType: 'windows',
          status: 'online',
          reliabilityScore: 44,
          trendDirection: 'degrading',
          trendConfidence: 0.8,
          uptime30d: 94.2,
          crashCount30d: 4,
          hangCount30d: 1,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 1,
          mtbfHours: 72,
          topIssues: [{ type: 'crashes', count: 4, severity: 'critical' }],
          drivers: [
            { factor: 'crashes', label: 'Crashes', score: 20, weight: 36, lostPoints: 28.8, evidence: { crashCount30d: 4 } },
          ],
          computedAt: '2026-06-18T12:00:00.000Z',
        },
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByTestId('reliability-ask-ai'));

    expect(startDeviceTaskMock).toHaveBeenCalledTimes(1);
    const [deviceId, ctx, seed] = startDeviceTaskMock.mock.calls[0];
    expect(deviceId).toBe('dev-1');
    expect(ctx).toMatchObject({ type: 'device', id: 'dev-1', hostname: 'host-1', os: 'windows', status: 'online' });
    expect(seed).toContain('44/100');
    expect(seed).toContain('Crashes');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/components/devices/DeviceReliabilityPanel.test.tsx -t "Ask AI"`
Expected: FAIL — `Unable to find an element by: [data-testid="reliability-ask-ai"]`.

- [ ] **Step 3: Extend the snapshot type and add helpers**

In `DeviceReliabilityPanel.tsx`, add `hostname`, `osType`, `status` to the `ReliabilitySnapshot` type (these are already returned by `GET /reliability/:id`):

```ts
type ReliabilitySnapshot = {
  deviceId: string;
  hostname?: string;
  osType?: 'windows' | 'macos' | 'linux';
  status?: string;
  reliabilityScore: number;
  trendDirection: 'improving' | 'stable' | 'degrading';
  trendConfidence: number;
  uptime30d: number;
  crashCount30d: number;
  hangCount30d: number;
  serviceFailureCount30d: number;
  hardwareErrorCount30d: number;
  mtbfHours: number | null;
  topIssues: ReliabilityTopIssue[];
  drivers?: ReliabilityDriver[];
  computedAt: string;
};
```

Add the imports at the top of the file:

```ts
import type { AiPageContext } from '@breeze/shared';
import { Sparkles } from 'lucide-react';
import { useAiStore } from '../../stores/aiStore';
```

(Merge `Sparkles` into the existing `lucide-react` import line rather than adding a duplicate import.)

Add these module-level helpers (near `scoreClass`):

```ts
function scoreBandLabel(score: number): string {
  if (score <= 50) return 'critical';
  if (score <= 70) return 'poor';
  if (score <= 85) return 'fair';
  return 'good';
}

function buildReliabilitySeedPrompt(snapshot: ReliabilitySnapshot, drivers: ReliabilityDriver[]): string {
  const mtbf = snapshot.mtbfHours === null ? 'unknown' : `${Math.round(snapshot.mtbfHours)}h`;
  const driverText = drivers.length > 0
    ? drivers.map((d) => `${d.label} (score ${d.score})`).join('; ')
    : 'none flagged';
  return [
    `Review this device's reliability and recommend what to do.`,
    `Score ${snapshot.reliabilityScore}/100 (${scoreBandLabel(snapshot.reliabilityScore)}), trend ${snapshot.trendDirection}.`,
    `30-day uptime ${snapshot.uptime30d.toFixed(1)}%, MTBF ${mtbf}.`,
    `Top factors dragging the score: ${driverText}.`,
    `What are the likely root causes, and what remediation — scripts, checks, or a ticket — do you recommend?`,
  ].join(' ');
}
```

- [ ] **Step 4: Wire the handler and button**

Inside the component, after the `drivers` memo, add:

```ts
  const startDeviceTask = useAiStore((s) => s.startDeviceTask);

  const askAi = useCallback(() => {
    if (!snapshot) return;
    const ctx: AiPageContext = {
      type: 'device',
      id: deviceId,
      hostname: snapshot.hostname ?? deviceId,
      os: snapshot.osType,
      status: snapshot.status,
    };
    void startDeviceTask(deviceId, ctx, buildReliabilitySeedPrompt(snapshot, drivers));
  }, [snapshot, deviceId, drivers, startDeviceTask]);
```

In the JSX, replace the opening of the action container `<div className="flex flex-wrap gap-2">` (the wrapper around the three feedback buttons, around line 249) so the Ask AI button comes first inside a column wrapper. Change that wrapper to:

```tsx
        <div className="flex flex-col items-start gap-2 xl:items-end">
          <button
            type="button"
            data-testid="reliability-ask-ai"
            onClick={askAi}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Sparkles className="h-4 w-4" />
            Ask AI about reliability
          </button>
          <div className="flex flex-wrap gap-2">
```

Note: this adds one extra closing `</div>` requirement — the existing feedback-button group `</div>` now closes the inner `flex flex-wrap gap-2`, and you must add a second `</div>` to close the new outer column wrapper. (Task 3 replaces the inner group entirely, so the final structure is settled there; for this task just ensure the file compiles with balanced tags.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/components/devices/DeviceReliabilityPanel.test.tsx`
Expected: PASS (existing tests still green — the three feedback buttons remain for now — plus the new Ask AI test).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DeviceReliabilityPanel.tsx apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx
git commit -m "feat(web): add Ask AI about reliability CTA to the reliability card (#1721)"
```

---

### Task 3: Consolidate feedback into a "Mark outcome" menu

**Files:**
- Modify: `apps/web/src/components/devices/DeviceReliabilityPanel.tsx`
- Test: `apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx`

**Interfaces:**
- Consumes: existing `submitFeedback(outcome)` (unchanged), `useClickOutside` hook.
- Produces: a click-outside dropdown with `data-testid` `reliability-outcome-trigger`, `reliability-outcome-menu`, and per-item `reliability-outcome-{outcome}`.

- [ ] **Step 1: Rework the failing tests**

In `DeviceReliabilityPanel.test.tsx`:

(a) Add a helper near the top of the `describe` block:

```ts
  const openOutcomeMenu = async () => {
    fireEvent.click(await screen.findByTestId('reliability-outcome-trigger'));
  };
```

(b) In the **"posts false alarm feedback through runAction"** test, replace the lines that find and click the false-alarm button:

```ts
    const falseAlarm = await screen.findByRole('button', { name: /false alarm/i });
    fireEvent.click(falseAlarm);
```

with:

```ts
    await openOutcomeMenu();
    fireEvent.click(screen.getByTestId('reliability-outcome-false_alarm'));
```

(c) In the **"toasts an error when feedback submission fails (non-2xx)"** test, replace:

```ts
    fireEvent.click(await screen.findByRole('button', { name: /false alarm/i }));
```

with:

```ts
    await openOutcomeMenu();
    fireEvent.click(screen.getByTestId('reliability-outcome-false_alarm'));
```

(d) In the **"shows a disabled state…"** test, replace the final assertion:

```ts
    expect(screen.queryByRole('button', { name: /false alarm/i })).toBeNull();
```

with:

```ts
    expect(screen.queryByTestId('reliability-outcome-trigger')).toBeNull();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/components/devices/DeviceReliabilityPanel.test.tsx`
Expected: FAIL — `reliability-outcome-trigger` testid does not exist yet.

- [ ] **Step 3: Add menu state and item config**

In `DeviceReliabilityPanel.tsx`:

Add imports — `useRef` to the React import, `ChevronDown` to the lucide import, and the hook:

```ts
import { useClickOutside } from '../../hooks/useClickOutside';
```

Remove `CheckCircle` from the lucide-react import (it is no longer used after this task; `AlertTriangle`, `Wrench`, `XCircle`, `Sparkles`, `ShieldCheck`, `RefreshCw` remain).

Add a module-level constant (near the other consts):

```ts
const OUTCOME_ITEMS: Array<{
  outcome: 'failure_confirmed' | 'replaced' | 'false_alarm';
  label: string;
  Icon: typeof AlertTriangle;
  iconClass: string;
}> = [
  { outcome: 'failure_confirmed', label: 'Device failed', Icon: AlertTriangle, iconClass: 'text-destructive' },
  { outcome: 'replaced', label: 'Device replaced', Icon: Wrench, iconClass: 'text-muted-foreground' },
  { outcome: 'false_alarm', label: 'False alarm', Icon: XCircle, iconClass: 'text-muted-foreground' },
];
```

Inside the component, after the `askAi` handler, add:

```ts
  const [outcomeMenuOpen, setOutcomeMenuOpen] = useState(false);
  const outcomeMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(outcomeMenuOpen, outcomeMenuRef, () => setOutcomeMenuOpen(false));

  function handleOutcome(outcome: 'failure_confirmed' | 'replaced' | 'false_alarm') {
    setOutcomeMenuOpen(false);
    void submitFeedback(outcome);
  }
```

- [ ] **Step 4: Replace the three buttons with the menu**

Replace the inner feedback-button group (the `<div className="flex flex-wrap gap-2">` containing the three `submitFeedback` buttons) with this menu block (it lives inside the column wrapper added in Task 2):

```tsx
          <div ref={outcomeMenuRef} className="relative">
            <button
              type="button"
              data-testid="reliability-outcome-trigger"
              aria-haspopup="true"
              aria-expanded={outcomeMenuOpen}
              disabled={labeling !== null}
              onClick={() => setOutcomeMenuOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Mark outcome
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {outcomeMenuOpen && (
              <div
                role="menu"
                data-testid="reliability-outcome-menu"
                className="absolute right-0 top-9 z-30 w-64 rounded-md border bg-popover p-1 shadow-lg"
              >
                <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Was this accurate?
                </p>
                {OUTCOME_ITEMS.map(({ outcome, label, Icon, iconClass }) => (
                  <button
                    key={outcome}
                    type="button"
                    data-testid={`reliability-outcome-${outcome}`}
                    disabled={labeling !== null}
                    onClick={() => handleOutcome(outcome)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
                    {label}
                  </button>
                ))}
                <hr className="my-1" />
                <p className="px-2 pb-1.5 pt-0.5 text-xs text-muted-foreground">
                  These train the reliability model — they don't change the device.
                </p>
              </div>
            )}
          </div>
```

Verify the action container now reads: outer `<div className="flex flex-col items-start gap-2 xl:items-end">` → Ask AI button → the `reliability-outcome` menu `<div>` → single closing `</div>` for the outer wrapper. (The inner `flex flex-wrap gap-2` wrapper from Task 2 is fully replaced by this menu block.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run src/components/devices/DeviceReliabilityPanel.test.tsx`
Expected: PASS (all tests, including the reworked feedback tests and the Ask AI test).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DeviceReliabilityPanel.tsx apps/web/src/components/devices/DeviceReliabilityPanel.test.tsx
git commit -m "feat(web): consolidate reliability feedback into a Mark outcome menu (#1721)"
```

---

### Task 4: Typecheck and final verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the web package**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web typecheck`
Expected: exit 0, no errors. (If the script name differs, run `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec tsc --noEmit -p tsconfig.json`.)

- [ ] **Step 2: Re-run both affected test files**

Run:
```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run \
  src/stores/aiStore.test.ts \
  src/components/devices/DeviceReliabilityPanel.test.tsx
```
Expected: PASS, no `CheckCircle`/unused-import or unbalanced-JSX errors.

- [ ] **Step 3: Confirm no stray references to removed affordances**

Run: `grep -n "CheckCircle\|flex flex-wrap gap-2" apps/web/src/components/devices/DeviceReliabilityPanel.tsx`
Expected: no `CheckCircle`; the only `flex flex-wrap` matches are the unrelated header rows (score/trend/uptime), not a feedback-button group.

---

## Self-Review

**Spec coverage:**
- Spec "Part 1 — AI store extension" → Task 1. ✓
- Spec "Part 1 — Card UI / seed prompt" → Task 2 (`buildReliabilitySeedPrompt`, `askAi`, `reliability-ask-ai` button, snapshot type extension). ✓
- Spec "Part 2 — Mark outcome menu" (relabel, icons, heading, training note, click-outside, separated from CTA) → Task 3. ✓
- Spec "Testing — panel + aiStore" → Tasks 1, 2, 3 tests + Task 4 verification. ✓
- Spec "Non-Goals" (no API change, no deep-linking, tiles read-only) → respected; no task touches the API or tiles. ✓

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N". All code blocks are concrete. ✓

**Type consistency:** `startDeviceTask(deviceId, ctx, initialMessage?)` is defined identically in Task 1 (decl + impl) and consumed in Task 2. Outcome union `'failure_confirmed' | 'replaced' | 'false_alarm'` matches `submitFeedback`'s existing signature, `OUTCOME_ITEMS`, and `handleOutcome`. `AiPageContext` device fields (`hostname` required, `os`/`status` optional) match the shared type and the snapshot fields read in `askAi`. ✓
