---
tracking_issue: TBD (register after Gate B)
wave_issue: TBD (W02 sub-issue)
branch: feature/<parent>-ai-scorecard/wave-<sub-issue>
---

# AI Scorecard W02 — Device page surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Read the hub first:** [`2026-09-13-ai-scorecard.md`](./2026-09-13-ai-scorecard.md). Its *Global Constraints* section is part of every task below.
> **Hard dependency: W01 must be merged.** W02 renders W01's columns and audit rows. Do not start it on a branch that lacks them.

**Goal:** A technician opening a device page can see at a glance that an AI touched the machine, what it did, and — when their own authority allows it — which conversation or agent run to open.

**Architecture:** Three read surfaces, no mutations. `GET /devices/:id/scripts` widens its projection by `aiInitiatorKind` plus a boolean `hasAiOrigin`; the raw session and run ids are **never** in that payload. A new `GET /devices/:id/ai-origin` resolves one execution's or command's origin *against the origin object's own ownership rules* and omits the id entirely when the viewer cannot reach it. A new `GET /devices/:id/ai-activity` returns a de-duplicated count for the Overview right rail. On the web side, a new `AiInitiatorChip` renders **alongside** `RunContextChip` (which encodes OS execution privilege and must not be overloaded), both device feeds learn the `ai.command.` action, and every string ships in all 8 locales.

**Tech Stack:** Hono, Drizzle, Vitest; React + Astro + react-i18next, `data-testid`-based tests.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-13-ai-scorecard-attribution-and-impact-design.md` §3.4, OD-9 A, OD-10 A.

**Tracking:** feature TBD, wave TBD. Branch `feature/<parent>-ai-scorecard/wave-<sub-issue>` off `main` **after W01 merges**. One PR, body `Closes #<wave sub-issue>` and `Refs #5022`.

## Global Constraints

Hub *Global Constraints* apply. W02-specific additions:

- **No migration in this wave.** If you find yourself writing one, stop — the schema is W01's.
- **OD-9 A is not negotiable: a provenance pointer is not permission to disclose its target.** An `ai_sessions` transcript is owner-bound (`services/aiAgent.ts:221-229`: `getSession` adds `eq(aiSessions.userId, auth.user.id)` unless `allowAnyOwnerInOrg`). A technician with `devices:read` does **not** thereby have transcript access. The DTO **omits** the id — it does not return it and hide it client-side.
- **Do not reuse `RunContextChip`** (`apps/web/src/components/common/RunContext.tsx:192-226`). It encodes OS execution privilege (`system | user | elevated`, `:25`), which is orthogonal to AI initiation. Overloading it would *hide* the privilege a tech most needs to see on an AI-run script. Ship a distinct `AiInitiatorChip` and render both.
- **NULL renders as absence, never as "a human did this".** No "Human" chip, no "Manual" chip, no tooltip that says a human ran it. An unmarked row shows nothing.
- **The Overview count is labelled "dispatched", not "completed", and must not double-count.** One AI script produces both a `script_executions` row *and* a `device_commands` row (`scriptDispatch.ts` inserts the execution at `:535-555` and then calls `queueCommand(device.id, 'script', …)` at `:644`), so a naive sum over both tables double-counts every script.
- **Best-effort copy.** Any tooltip or empty state that talks about completeness says "recorded", never "all". Spec OD-10 A.
- New strings go in **all 8 locales** with real translations: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/`. Enforced by `apps/web/src/lib/i18n/localeParity.test.ts` and `translationCoverage.test.ts` — an English string copied into a non-English file is counted as an untranslated duplicate against that namespace's frozen baseline.
- Web tests query the DOM through **`data-testid` only** (repo convention, `e2e-tests/README.md`).
- Every task ends with `cd apps/web && npx astro check` (or the API typecheck for API tasks), the targeted vitest run, and a commit.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/routes/devices/scripts.ts` (modify, `:31-59`) | widen projection with `aiInitiatorKind` + `hasAiOrigin` |
| `apps/api/src/routes/devices/aiOrigin.ts` (create) | `GET /:id/ai-origin` (authorized summary) and `GET /:id/ai-activity` (de-duplicated count) |
| `apps/api/src/routes/devices/index.ts` (modify) | mount the new router after `coreRoutes` (`:129`) |
| `apps/api/src/services/aiOriginSummary.ts` (create) | resolve + authorize one origin; the only place that decides whether an id is disclosed |
| `packages/shared/src/types/aiOrigin.ts` (modify — created in W01) | `AiOriginSummaryDto`, `DeviceAiActivityDto` |
| `apps/web/src/components/common/AiInitiatorChip.tsx` (create) | the chip + its origin popover |
| `apps/web/src/components/devices/DeviceScriptHistory.tsx` (modify, `:503-544`, `:675`) | per-row chip column |
| `apps/web/src/components/devices/DeviceActivityFeed.tsx` (modify, `:59-82`) | `ai.command.` action rule |
| `apps/web/src/components/devices/DeviceEventLogViewer.tsx` (modify, `:59-131`, `:176-211`) | audit the AI category/initiator rendering |
| `apps/web/src/components/devices/DeviceAiActivitySignal.tsx` (create) | the Overview right-rail line |
| `apps/web/src/components/devices/DeviceDetails.tsx` (modify, `:782-788`) | mount the signal |
| `apps/web/src/locales/*/devices.json`, `*/common.json` (modify ×8 each) | translations |

---

### Task 1: `GET /devices/:id/scripts` projects the AI marker (and nothing disclosable)

**Files:**
- Modify: `apps/api/src/routes/devices/scripts.ts` (projection at `:31-59`; the handler is the whole file, 68 lines, fixed `.limit(50)` at `:64`, response `{ data: executions }`)
- Modify: `packages/shared/src/types/aiOrigin.ts`
- Test: `apps/api/src/routes/devices/scripts.test.ts` (create if absent)

**Interfaces:**
- Consumes: W01's `scriptExecutions.aiInitiatorKind | aiSessionId | aiAgentRunId`.
- Produces: each row in `{ data: [...] }` gains `aiInitiatorKind: 'ai_assistant' | 'ai_agent' | null` and `hasAiOrigin: boolean`. **The raw `aiSessionId` / `aiAgentRunId` are deliberately NOT projected** — they are disclosable only through Task 2's authorized endpoint.

- [ ] **Step 1: Write the failing test**

```ts
it('projects the AI initiator kind and an origin-presence flag', async () => {
  seedExecution({ aiInitiatorKind: 'ai_assistant', aiSessionId: 'sess-1', aiAgentRunId: null });
  const res = await app.request(`/devices/${DEVICE_ID}/scripts`, {}, env);
  const body = await res.json();
  expect(body.data[0]).toMatchObject({ aiInitiatorKind: 'ai_assistant', hasAiOrigin: true });
});

it('never leaks the raw session or run id in the list payload', async () => {
  seedExecution({ aiInitiatorKind: 'ai_agent', aiSessionId: 'sess-1', aiAgentRunId: 'run-1' });
  const body = await (await app.request(`/devices/${DEVICE_ID}/scripts`, {}, env)).json();
  expect(JSON.stringify(body)).not.toContain('sess-1');
  expect(JSON.stringify(body)).not.toContain('run-1');
});

it('reports an unmarked row as null, never as a human attribution', async () => {
  seedExecution({ aiInitiatorKind: null, aiSessionId: null, aiAgentRunId: null });
  const body = await (await app.request(`/devices/${DEVICE_ID}/scripts`, {}, env)).json();
  expect(body.data[0].aiInitiatorKind).toBeNull();
  expect(body.data[0].hasAiOrigin).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/devices/scripts.test.ts`
Expected: FAIL — `aiInitiatorKind: undefined`.

- [ ] **Step 3: Write the implementation**

In the select at `:31-59` add:

```ts
      aiInitiatorKind: scriptExecutions.aiInitiatorKind,
      // Presence only. The ids themselves are an authorization decision, not a
      // projection: an ai_sessions transcript is owner-bound (aiAgent.ts:229),
      // and a device that moved tenants can hold a pointer into the source org.
      // Disclosure happens in GET /devices/:id/ai-origin, per-row, on demand.
      hasAiOrigin: sql<boolean>`(${scriptExecutions.aiSessionId} IS NOT NULL OR ${scriptExecutions.aiAgentRunId} IS NOT NULL)`,
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/devices/scripts.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/scripts.ts apps/api/src/routes/devices/scripts.test.ts packages/shared/src/types/aiOrigin.ts
git commit -m "feat(devices): project the AI initiator marker on the device scripts list"
```

---

### Task 2: The authorized origin-summary endpoint

**Files:**
- Create: `apps/api/src/services/aiOriginSummary.ts`
- Create: `apps/api/src/services/aiOriginSummary.test.ts`
- Create: `apps/api/src/routes/devices/aiOrigin.ts`
- Modify: `apps/api/src/routes/devices/index.ts` (mount after `coreRoutes`, `:129`; only *static*-path routers need to precede it, per the file's own ordering convention)
- Modify: `packages/shared/src/types/aiOrigin.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface AiOriginSummaryDto {
    kind: 'ai_assistant' | 'ai_agent';
    /** Agent name, or the assistant label. Never a transcript excerpt. */
    label: string;
    occurredAt: string;              // ISO
    toolName: string | null;
    /** Present ONLY when the viewer can actually open it. Omitted otherwise. */
    session?: { id: string };
    agentRun?: { id: string };
    /** false ⇒ the UI reads "origin not available". */
    resolvable: boolean;
  }
  export async function resolveAiOriginSummary(
    auth: AuthContext,
    source: { kind: 'execution' | 'command'; id: string; deviceId: string },
  ): Promise<AiOriginSummaryDto | null>;
  ```
  Route: `GET /devices/:id/ai-origin?source=execution|command&sourceId=<uuid>` → `{ data: AiOriginSummaryDto | null }`, `404` when the source row is not on that device or not visible to the caller.

- [ ] **Step 1: Write the failing test**

```ts
describe('resolveAiOriginSummary (#5022 W02, OD-9)', () => {
  it('includes the session id for the session owner', async () => {
    const dto = await resolveAiOriginSummary(authFor(OWNER_USER), { kind: 'execution', id: EXEC, deviceId: DEV });
    expect(dto).toMatchObject({ kind: 'ai_assistant', resolvable: true, session: { id: SESSION_ID } });
  });

  it('OMITS the session id for a technician who cannot open the transcript', async () => {
    const dto = await resolveAiOriginSummary(authFor(OTHER_TECH), { kind: 'execution', id: EXEC, deviceId: DEV });
    expect(dto).toMatchObject({ kind: 'ai_assistant', resolvable: false });
    expect(dto).not.toHaveProperty('session');           // omitted, not nulled
    expect(JSON.stringify(dto)).not.toContain(SESSION_ID);
  });

  it('OMITS a run id that now lives in a different tenant', async () => {
    // ai_agent_runs stays with the source org across a device move; W01 detaches
    // the pointer, but a row written before W01's detach — or a run the caller
    // simply cannot see — must still not leak its id.
    const dto = await resolveAiOriginSummary(authFor(TECH), { kind: 'execution', id: FOREIGN_RUN_EXEC, deviceId: DEV });
    expect(dto!.resolvable).toBe(false);
    expect(dto).not.toHaveProperty('agentRun');
  });

  it('still reports the KIND when the id is unresolvable — the fact survives', async () => {
    const dto = await resolveAiOriginSummary(authFor(OTHER_TECH), { kind: 'execution', id: EXEC, deviceId: DEV });
    expect(dto!.kind).toBe('ai_assistant');
  });

  it('returns null for a row with no AI marker at all', async () => {
    expect(await resolveAiOriginSummary(authFor(TECH), { kind: 'execution', id: HUMAN_EXEC, deviceId: DEV })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiOriginSummary.test.ts`
Expected: FAIL — "Failed to resolve import ./aiOriginSummary".

- [ ] **Step 3: Write the implementation**

`aiOriginSummary.ts`:

```ts
/**
 * Resolve one execution's or command's AI origin into a summary the CALLER is
 * allowed to see (#5022 W02, spec OD-9 A).
 *
 * The headline risk this closes: treating a provenance pointer as permission to
 * disclose its target. Device history can move tenants while agent-run history
 * stays behind, and transcripts are owner-private (`aiAgent.ts:229`). So the id
 * is authorized against the ORIGIN OBJECT'S OWN rules -- getSession for a
 * session, the run's own org/site visibility for a run -- and OMITTED from the
 * DTO when that check fails. Never returned-and-hidden client-side.
 *
 * The KIND is always disclosed when a marker exists: knowing "an AI did this"
 * is exactly what the device page is for, and it reveals nothing about whose
 * conversation it was.
 */
```

- Load the source row scoped to the device under the caller's own request context (`withDbAccessContext`; RLS enforces the tenant boundary). `source.kind === 'execution'` reads `script_executions`; `'command'` reads `device_commands` **joined to `devices` for the org check**, because `device_commands` is system-scoped and has no `org_id` of its own.
- Return `null` when `ai_initiator_kind IS NULL`.
- For `aiSessionId`: call `getSession(sessionId, auth)` (`services/aiAgent.ts:221`) **without** `allowAnyOwnerInOrg`; on a hit, include `session: { id }` and use the session title/type for `label`; on a miss, set `resolvable: false` and omit the key.
- For `aiAgentRunId`: load the run under the caller's context and additionally apply `runSiteScopeCondition(auth)` (`services/aiAgentRunSiteScope.ts:18`); on a hit include `agentRun: { id }` and use the agent's name for `label`; otherwise omit.
- `label` when nothing resolves: the plain kind label (`'AI assistant'` / `'AI agent'`) — resolved on the client from `kind`, so the server sends a stable key, not a localized string.
- `toolName` comes from the audit row's `details.toolName` when one exists for that command/execution; `null` otherwise. Do **not** fail the summary when the audit row is missing — audit is best-effort (OD-10 A).

Route file, mounted after `coreRoutes`:

```ts
deviceAiOriginRoutes.get('/:id/ai-origin', zValidator('query', z.object({
  source: z.enum(['execution', 'command']),
  sourceId: z.string().uuid(),
})), async (c) => { /* device access check, then resolveAiOriginSummary */ });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiOriginSummary.test.ts src/routes/devices/aiOrigin.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiOriginSummary.ts apps/api/src/services/aiOriginSummary.test.ts apps/api/src/routes/devices packages/shared/src/types/aiOrigin.ts
git commit -m "feat(devices): authorized AI origin summary endpoint that omits ids the viewer cannot reach"
```

---

### Task 3: `GET /devices/:id/ai-activity` — the de-duplicated Overview count

**Files:**
- Modify: `apps/api/src/routes/devices/aiOrigin.ts`
- Modify: `packages/shared/src/types/aiOrigin.ts`
- Test: `apps/api/src/routes/devices/aiOrigin.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DeviceAiActivityDto {
    /** DISPATCHED mutations, not completed ones. */
    dispatchedActions: number;
    windowDays: number;   // 7
    since: string;        // ISO
  }
  ```
  Route: `GET /devices/:id/ai-activity?days=7` → `{ data: DeviceAiActivityDto }`, `days` capped at 30.

**The de-duplication rule.** A single AI script dispatch writes one `script_executions` row **and** one `device_commands` row of `type = 'script'` (`scriptDispatch.ts:644` calls `queueCommand(device.id, 'script', …)`). Counting both double-counts every script. Therefore:

```
dispatchedActions
  = count(script_executions WHERE device_id = D AND ai_initiator_kind IS NOT NULL AND created_at >= since)
  + count(device_commands   WHERE device_id = D AND ai_initiator_kind IS NOT NULL AND created_at >= since
                              AND type <> 'script')
```

A cancel command is a *distinct* AI mutation and is counted on its own — say so in the tooltip copy rather than hiding it. Both arms are served by W01's partial indexes (`script_executions_ai_device_created_idx`, `device_commands_ai_device_created_idx`, both `(device_id, created_at DESC) WHERE ai_initiator_kind IS NOT NULL`).

- [ ] **Step 1: Write the failing test**

```ts
it('counts one AI script dispatch exactly once, not twice', async () => {
  // one script_executions row AND its type='script' device_commands row
  seedAiScriptDispatch({ deviceId: DEV, kind: 'ai_assistant' });
  const body = await (await app.request(`/devices/${DEV}/ai-activity?days=7`, {}, env)).json();
  expect(body.data.dispatchedActions).toBe(1);
});

it('counts a direct AI command', async () => {
  seedAiCommand({ deviceId: DEV, type: 'run_shell', kind: 'ai_agent' });
  const body = await (await app.request(`/devices/${DEV}/ai-activity?days=7`, {}, env)).json();
  expect(body.data.dispatchedActions).toBe(1);
});

it('excludes unmarked rows entirely', async () => {
  seedHumanScriptDispatch({ deviceId: DEV });
  const body = await (await app.request(`/devices/${DEV}/ai-activity?days=7`, {}, env)).json();
  expect(body.data.dispatchedActions).toBe(0);
});

it('excludes rows outside the window', async () => {
  seedAiCommand({ deviceId: DEV, type: 'run_shell', kind: 'ai_agent', createdAt: daysAgo(20) });
  const body = await (await app.request(`/devices/${DEV}/ai-activity?days=7`, {}, env)).json();
  expect(body.data.dispatchedActions).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/devices/aiOrigin.test.ts`
Expected: FAIL — 404 (route not mounted), or `2` for the first case if implemented naively.

- [ ] **Step 3: Write the implementation** — the two counts above, summed, with the `type <> 'script'` exclusion commented with the reason.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/routes/devices/aiOrigin.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/aiOrigin.ts apps/api/src/routes/devices/aiOrigin.test.ts packages/shared/src/types/aiOrigin.ts
git commit -m "feat(devices): de-duplicated 7-day AI activity count endpoint"
```

---

### Task 4: `AiInitiatorChip` + the origin popover

**Files:**
- Create: `apps/web/src/components/common/AiInitiatorChip.tsx`
- Create: `apps/web/src/components/common/AiInitiatorChip.test.tsx`
- Modify: `apps/web/src/locales/en/common.json` (and the other 7 in Task 8)

**Interfaces:**
- Produces:
  ```tsx
  export function AiInitiatorChip(props: {
    kind: 'ai_assistant' | 'ai_agent' | null;
    hasOrigin?: boolean;
    /** Called when the chip is opened; resolves the authorized summary. */
    loadOrigin?: () => Promise<AiOriginSummaryDto | null>;
    className?: string;
    testId?: string;              // default 'ai-initiator-chip'
  }): JSX.Element | null;
  ```
  **Returns `null` when `kind` is null** — an unmarked row renders nothing at all.

Follow the shape of `RunContextChip` (`apps/web/src/components/common/RunContext.tsx:192-226`) and `SlaChip` (`apps/web/src/components/tickets/SlaChip.tsx:5`): a `<span>` with `rounded-full border`, state-keyed colours via `cn(...)`, a `data-testid`, and `useTranslation`.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders nothing for an unmarked row — absence is not a human attribution', () => {
  render(<AiInitiatorChip kind={null} />);
  expect(screen.queryByTestId('ai-initiator-chip')).toBeNull();
});

it('renders the assistant variant', () => {
  render(<AiInitiatorChip kind="ai_assistant" />);
  expect(screen.getByTestId('ai-initiator-chip')).toHaveTextContent('AI assistant');
});

it('renders the autonomous-agent variant distinctly from the assistant one', () => {
  const { rerender } = render(<AiInitiatorChip kind="ai_assistant" />);
  const assistant = screen.getByTestId('ai-initiator-chip').className;
  rerender(<AiInitiatorChip kind="ai_agent" />);
  expect(screen.getByTestId('ai-initiator-chip').className).not.toEqual(assistant);
  expect(screen.getByTestId('ai-initiator-chip')).toHaveTextContent('AI agent');
});

it('shows "origin not available" when the summary is unresolvable, and offers no link', async () => {
  render(<AiInitiatorChip kind="ai_assistant" hasOrigin loadOrigin={async () => ({
    kind: 'ai_assistant', label: 'AI assistant', occurredAt: ISO, toolName: 'run_script', resolvable: false,
  })} />);
  await userEvent.click(screen.getByTestId('ai-initiator-chip'));
  expect(await screen.findByTestId('ai-origin-unavailable')).toBeInTheDocument();
  expect(screen.queryByTestId('ai-origin-open-session')).toBeNull();
});

it('offers the session link only when the summary carries an id', async () => {
  render(<AiInitiatorChip kind="ai_assistant" hasOrigin loadOrigin={async () => ({
    kind: 'ai_assistant', label: 'Support chat', occurredAt: ISO, toolName: 'run_script',
    resolvable: true, session: { id: 'sess-1' },
  })} />);
  await userEvent.click(screen.getByTestId('ai-initiator-chip'));
  expect(await screen.findByTestId('ai-origin-open-session')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/common/AiInitiatorChip.test.tsx`
Expected: FAIL — cannot resolve `./AiInitiatorChip`.

- [ ] **Step 3: Write the implementation**

- Chip body: icon + `t('aiInitiator.assistant')` / `t('aiInitiator.agent')`. Distinct colour families from `RunContextChip`'s amber/sky/red so the two chips beside each other are never confused (suggest violet for `ai_agent`, indigo for `ai_assistant`).
- Popover on click, only when `hasOrigin` and `loadOrigin` are supplied; it calls `loadOrigin()` **once** and caches. Renders `label`, `occurredAt`, `toolName`, and then exactly one of:
  - `resolvable && session` → a button `data-testid="ai-origin-open-session"` that calls `useAiStore.getState().switchSession(session.id)` (`apps/web/src/stores/aiStore.ts:565` — sessions are opened through the store, **not** a URL; there is no deep-link route today, so do not fabricate an `href`);
  - `resolvable && agentRun` → a link `data-testid="ai-origin-open-run"` to the agent-run detail page;
  - otherwise → `data-testid="ai-origin-unavailable"` with `t('aiInitiator.originUnavailable')`.
- No mutation, so `runAction` does not apply.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/common/AiInitiatorChip.test.tsx
cd apps/web && npx astro check
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/common/AiInitiatorChip.tsx apps/web/src/components/common/AiInitiatorChip.test.tsx apps/web/src/locales/en/common.json
git commit -m "feat(web): AiInitiatorChip with an authorization-aware origin popover"
```

---

### Task 5: Scripts tab — a per-row AI column beside the run-context chip

**Files:**
- Modify: `apps/web/src/components/devices/DeviceScriptHistory.tsx` (786 lines; fetch at `:306`; table headers `:503-509`; row cells `:532-544`; existing `RunContextChip` import at `:26`, rendered at `:675` **inside the detail drawer only**)
- Test: `apps/web/src/components/devices/DeviceScriptHistory.test.tsx` (exists)

**Interfaces:**
- Consumes: Task 1's `aiInitiatorKind` / `hasAiOrigin`; Task 2's endpoint; Task 4's chip.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders the AI chip in the row for an AI-dispatched execution', async () => {
  mockScripts([{ id: 'e1', scriptName: 'Disk cleanup', status: 'completed', aiInitiatorKind: 'ai_agent', hasAiOrigin: true }]);
  render(<DeviceScriptHistory deviceId="dev-1" />);
  expect(await screen.findByTestId('ai-initiator-chip')).toHaveTextContent('AI agent');
});

it('renders no AI chip for an unmarked execution', async () => {
  mockScripts([{ id: 'e1', scriptName: 'Disk cleanup', status: 'completed', aiInitiatorKind: null, hasAiOrigin: false }]);
  render(<DeviceScriptHistory deviceId="dev-1" />);
  await screen.findByText('Disk cleanup');
  expect(screen.queryByTestId('ai-initiator-chip')).toBeNull();
});

it('keeps the run-context chip visible alongside the AI chip in the detail drawer', async () => {
  mockScripts([{ id: 'e1', scriptName: 'x', status: 'completed', runAs: 'elevated', aiInitiatorKind: 'ai_agent', hasAiOrigin: true }]);
  render(<DeviceScriptHistory deviceId="dev-1" />);
  await userEvent.click(await screen.findByText('x'));
  expect(screen.getByTestId('run-context-chip')).toBeInTheDocument();   // OS privilege — must NOT be replaced
  expect(screen.getByTestId('ai-initiator-chip')).toBeInTheDocument();  // who decided
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceScriptHistory.test.tsx`
Expected: FAIL — no element with testid `ai-initiator-chip`.

- [ ] **Step 3: Write the implementation**

- Add one `<th>` (`:503-509`) and one `<td>` (`:532-544`) rendering `<AiInitiatorChip kind={row.aiInitiatorKind} hasOrigin={row.hasAiOrigin} loadOrigin={() => fetchOrigin('execution', row.id)} />`. The chip returns `null` for unmarked rows, so the column is empty rather than showing a placeholder.
- Add `<AiInitiatorChip …>` to the detail drawer beside the existing `RunContextChip` at `:675` — **beside**, not replacing it. The run-context chip encodes OS execution privilege; hiding it on an AI-run script would remove exactly the fact a tech most needs.
- `fetchOrigin` calls `fetchWithAuth('/devices/${deviceId}/ai-origin?source=execution&sourceId=${id}')`. Read-only, so no `runAction`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceScriptHistory.test.tsx src/components/devices/DeviceScriptHistory.cancel.test.tsx
cd apps/web && npx astro check
```
Expected: PASS, 2 files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceScriptHistory.tsx apps/web/src/components/devices/DeviceScriptHistory.test.tsx
git commit -m "feat(web): AI initiator chip on the device Scripts tab rows and detail drawer"
```

---

### Task 6: Both device feeds learn `ai.command.`

**Files:**
- Modify: `apps/web/src/components/devices/DeviceActivityFeed.tsx` (`ACTION_RULES` at `:59-82`; `ACTION_PREFIXES` derives from it at `:96-101`; `INITIATOR_LABELS` at `:108-114`; chip precedence `:418-479`)
- Modify: `apps/web/src/components/devices/DeviceEventLogViewer.tsx` (`categoryConfig` `:59-131`, `initiatedByConfig` `:176-211`)
- Test: `apps/web/src/components/devices/DeviceActivityFeed.test.tsx`, `apps/web/src/components/devices/DeviceEventLogViewer.test.tsx` (both exist)

**Interfaces:**
- Consumes: W01's `ai.command.executed` audit rows.

**What is already there (verified on `main`, do not re-add):** `ACTION_RULES` already carries `{ prefix: "ai.script.", icon: Sparkles }` at `:62`; `INITIATOR_LABELS.ai = "AI"` at `:108-114` and already outranks the "Automated" chip in the precedence at `:429-441`; `DeviceEventLogViewer` already has `ai` entries in **both** `categoryConfig` (`:129-133`) and `initiatedByConfig` (`:184-189`). API-side, `deriveCategory()` (`routes/devices/events.ts:433-450`) already maps `ai.` → `'ai'` and `resolveActorLabel()` (`:421-431`) already renders `'AI Agent'`. **The only genuinely missing piece is the `ai.command.` prefix rule in `ACTION_RULES`** — the Activities tab filters by *category*, not by action prefix, so it needs no rule at all. Both components still need tests proving the rows render, because "already wired" and "proven to render" are different claims.

- [ ] **Step 1: Write the failing test**

```tsx
// DeviceActivityFeed.test.tsx
it('requests the ai.command. prefix so AI commands reach the Overview feed', async () => {
  render(<DeviceActivityFeed deviceId="dev-1" />);
  await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
  const url = fetchWithAuthMock.mock.calls[0]![0] as string;
  expect(decodeURIComponent(url)).toContain('ai.command.');
});

it('renders an ai.command.executed row with the AI initiator chip', async () => {
  mockEvents([{ id: 'a1', action: 'ai.command.executed', category: 'ai', initiatedBy: 'ai',
                actor: { type: 'ai_agent', name: 'AI Agent' }, timestamp: ISO, result: 'dispatched' }]);
  render(<DeviceActivityFeed deviceId="dev-1" />);
  expect(await screen.findByText('AI')).toBeInTheDocument();
});

// DeviceEventLogViewer.test.tsx
it('renders an ai.command.executed row under the AI category with the AI initiator badge', async () => {
  mockEvents([{ id: 'a1', action: 'ai.command.executed', category: 'ai', initiatedBy: 'ai',
                actor: { type: 'ai_agent', name: 'AI Agent' }, timestamp: ISO, result: 'dispatched' }]);
  render(<DeviceEventLogViewer deviceId="dev-1" />);
  expect(await screen.findByTestId('event-category-ai')).toBeInTheDocument();
  expect(screen.getByTestId('event-initiated-by-ai')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceActivityFeed.test.tsx src/components/devices/DeviceEventLogViewer.test.tsx`
Expected: FAIL — the URL does not contain `ai.command.`; the testids do not exist yet.

- [ ] **Step 3: Write the implementation**

In `ACTION_RULES` (`:59-82`), directly beneath the existing `ai.script.` entry:

```ts
  { prefix: "ai.command.", icon: Sparkles }, // #5022 W01/W02 — AI-dispatched device commands
```

`ACTION_PREFIXES` (`:96-101`) derives from `ACTION_RULES` and already excludes `agent.command.*`, so the new prefix flows into the `actions=` query parameter automatically — verify that with the first test rather than assuming.

In `DeviceEventLogViewer`, add the two `data-testid` attributes the tests query (`event-category-${category}`, `event-initiated-by-${initiatedBy}`) to the existing badge renderers around `:518-600`; no new config entries are needed.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceActivityFeed.test.tsx src/components/devices/DeviceEventLogViewer.test.tsx
cd apps/web && npx astro check
```
Expected: PASS, 2 files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceActivityFeed.tsx apps/web/src/components/devices/DeviceEventLogViewer.tsx apps/web/src/components/devices/DeviceActivityFeed.test.tsx apps/web/src/components/devices/DeviceEventLogViewer.test.tsx
git commit -m "feat(web): surface ai.command. rows in both device feeds"
```

---

### Task 7: The Overview AI signal line

**Files:**
- Create: `apps/web/src/components/devices/DeviceAiActivitySignal.tsx`
- Create: `apps/web/src/components/devices/DeviceAiActivitySignal.test.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (right rail, beside `<DeviceActivityFeed …>` at `:782-788`)

**Interfaces:**
- Consumes: Task 3's `GET /devices/:id/ai-activity`.
- Produces: one line — *"AI activity — N actions dispatched in the last 7 days"* — hidden entirely when `N === 0`.

- [ ] **Step 1: Write the failing test**

```tsx
it('shows the dispatched count with the window', async () => {
  mockAiActivity({ dispatchedActions: 3, windowDays: 7, since: ISO });
  render(<DeviceAiActivitySignal deviceId="dev-1" />);
  expect(await screen.findByTestId('device-ai-activity-signal')).toHaveTextContent('3');
  expect(screen.getByTestId('device-ai-activity-signal')).toHaveTextContent('7');
});

it('renders nothing when there is no recorded AI activity', async () => {
  mockAiActivity({ dispatchedActions: 0, windowDays: 7, since: ISO });
  render(<DeviceAiActivitySignal deviceId="dev-1" />);
  await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
  expect(screen.queryByTestId('device-ai-activity-signal')).toBeNull();
});

it('says "dispatched", never "completed", and never claims completeness', async () => {
  mockAiActivity({ dispatchedActions: 2, windowDays: 7, since: ISO });
  render(<DeviceAiActivitySignal deviceId="dev-1" />);
  const text = (await screen.findByTestId('device-ai-activity-signal')).textContent!;
  expect(text.toLowerCase()).toContain('dispatched');
  expect(text.toLowerCase()).not.toContain('completed');
  expect(text.toLowerCase()).not.toMatch(/\ball\b/);
});

it('renders nothing when the request fails — a signal is not worth a broken rail', async () => {
  mockAiActivityError();
  render(<DeviceAiActivitySignal deviceId="dev-1" />);
  await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
  expect(screen.queryByTestId('device-ai-activity-signal')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceAiActivitySignal.test.tsx`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation** — a small read-only component using `fetchWithAuth`, returning `null` on zero and on error, with the tooltip copy: *"Counts AI-dispatched scripts and commands recorded on this device. A cancel counts as its own action. Recorded on a best-effort basis."*

Mount it above `<DeviceActivityFeed>` in the Overview right rail (`DeviceDetails.tsx:782-788`).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/components/devices/DeviceAiActivitySignal.test.tsx src/components/devices/DeviceDetails.test.tsx
cd apps/web && npx astro check
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices
git commit -m "feat(web): Overview AI activity signal on the device page"
```

---

### Task 8: Translations in all 8 locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json` and `.../devices.json`
- Test: `apps/web/src/lib/i18n/localeParity.test.ts`, `apps/web/src/lib/i18n/translationCoverage.test.ts` (both exist)

**Keys to add** (`common.json` → `aiInitiator.*`; `devices.json` → `aiActivity.*`):

`aiInitiator.assistant`, `aiInitiator.agent`, `aiInitiator.originUnavailable`, `aiInitiator.openSession`, `aiInitiator.openAgentRun`, `aiInitiator.tool`, `aiInitiator.occurredAt`, `aiActivity.title`, `aiActivity.count`, `aiActivity.tooltip`.

- [ ] **Step 1: Run the parity tests to see them fail**

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
```
Expected: FAIL — keys present in `en` and missing in the other seven.

- [ ] **Step 2: Write real translations**

**Not English copied into seven files.** `translationCoverage.test.ts` maintains a per-namespace "exact-English duplicate" baseline and a copied string counts against it. Translate each of the ten keys into de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR and tr-TR.

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts
```
Expected: PASS, with no baseline number raised.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/locales
git commit -m "i18n(devices): AI initiator and AI activity strings in all 8 locales"
```

---

### Task 9: Full sweep and the PR

- [ ] **Step 1: Run every affected suite**

```bash
cd apps/web && npx vitest run src/components/devices src/components/common/AiInitiatorChip.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
cd apps/api && npx vitest run src/routes/devices src/services/aiOriginSummary.test.ts
```
`src/components/devices` and `src/routes/devices` are **substring** filters — check the reported file counts and make sure `DeviceDetails.test.tsx`, `DeviceActivityFeed.test.tsx`, `DeviceEventLogViewer.test.tsx`, `DeviceScriptHistory.test.tsx` and `DeviceScriptHistory.cancel.test.tsx` all actually ran.

- [ ] **Step 2: Live-DB suites**

W02 adds no table and no column, so the cascade/export/merge contracts are untouched. Still run the one suite this wave can plausibly break, because the new endpoints read `audit_logs` and `device_commands` under RLS:

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/deviceEventsFeedIndexes.integration.test.ts \
  src/__tests__/integration/aiOriginAttribution.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts
pnpm test-stack down
```
Expected: all PASS. `deviceEventsFeedIndexes` is the one that catches an `ai.command.executed` row that the feed's two index arms cannot serve (its EXPLAIN-as-`breeze_app` assertions are why the 2026-09-03 US incident is not still happening).

- [ ] **Step 3: Typecheck and lint**

```bash
cd apps/web && npx astro check
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
pnpm lint
```

- [ ] **Step 4: Manual authorization check (do not skip — this is OD-9's whole point)**

Log in as a technician who is **not** the owner of the AI session that ran a script on the device. Open the Scripts tab, click the AI chip, and confirm: the kind is shown, the popover reads "origin not available", **no link is offered**, and the network response body contains no session id (check the response in devtools, not the rendered DOM).

- [ ] **Step 5: PR**

Open against `main`, body `Closes #<wave sub-issue>` and `Refs #5022`. Merge with `gh pr merge <N>` — never `--admin`.
