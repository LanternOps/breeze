# PR 0: Reusable Script-Dispatch Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a single reusable per-device script-dispatch service (`services/scriptDispatch.ts`) and make all live dispatch sites thin callers of it, absorbing five known fixes, so #3409's variable-resolution work later hooks one seam instead of five.

**Architecture:** A new `dispatchScriptToDevice()` owns invariant checks → `script_executions` row → payload build → `encryptSensitivePayloadFields` → `queueCommand` → claim/`decryptCommandForDelivery`/WS-send/release. Callers (`executeScriptOnDevices`, automation `run_script` + `execute_command`, mobile route, AI `run_script` tool) keep their own auth/permission/maintenance logic above the seam. Sources are discriminated: `{kind:'saved', script}` vs `{kind:'raw', content, language, provenance}`.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Vitest (Drizzle-mock unit tests per `services/scriptExecution.test.ts` patterns).

## Global Constraints

- Branch: `ToddHebebrand/scripts-custom-variables` (current worktree). Commit per task.
- **Pure refactor discipline**: behavior deltas are ONLY the six intended ones listed below; anything else observed in tests is a bug in the refactor.
  1. Mobile script runs now WS-push immediately (previously heartbeat-only) and now honor maintenance windows (can return 409).
  2. AI `run_script` now creates `script_executions` rows and can see partner-wide (`org_id NULL`) scripts.
  3. Manual/route + mobile script commands now get the `agent.command.script` audit row (via `queueCommand`), which they previously skipped.
  4. The execution-status update on delivery is now guarded on `status='pending'` on ALL paths (route path was unguarded — see the race comment at `automationRuntime.ts:996`).
  5. Multi-org batches are split per org (`script_execution_batches` no longer records the first device's org for other orgs' devices).
  6. Dead `deploymentWorker` script path removed.
- Do NOT change transaction semantics in this PR: inserts run in the caller's ambient DB context exactly as today. The commit-before-deliver upgrade is deferred to PR 4 (noted in #3409 scope).
- No new migrations. No agent (Go) changes.
- Tests: `pnpm --filter @breeze/api test -- run <file>` for targeted runs. Do not run the RLS/integration suites for this PR (no tenancy-surface changes) — but DO run the full API unit suite before the final commit.
- Never edit `scripts.parameters` handling semantics (that's PR 2/3).

---

### Task 1: `scriptDispatch.ts` core service + unit tests

**Files:**
- Create: `apps/api/src/services/scriptDispatch.ts`
- Test: `apps/api/src/services/scriptDispatch.test.ts`

**Interfaces:**
- Consumes: `queueCommand` (`services/commandQueue.ts:456`), `claimPendingCommandForDelivery`/`releaseClaimedCommandDelivery` (`services/commandDispatch.ts`), `decryptCommandForDelivery`+`encryptSensitivePayloadFields` (`services/sensitiveCommandPayload.ts`), `sendCommandToAgent` (`routes/agentWs.ts`).
- Produces (later tasks rely on these exact names/types):

```ts
export type ScriptDispatchSource =
  | { kind: 'saved'; script: typeof scripts.$inferSelect }
  | { kind: 'raw'; content: string; language: string; provenance: string };

export type DispatchScriptInput = {
  device: Pick<typeof devices.$inferSelect, 'id' | 'orgId' | 'osType' | 'status' | 'agentId'>;
  source: ScriptDispatchSource;
  parameters?: Record<string, unknown>;
  triggerType?: string;                 // 'manual' | 'scheduled' | 'alert' | 'policy' | 'automation' | 'ai'
  triggeredBy?: string | null;          // script_executions.triggered_by
  createdBy?: string | null;            // device_commands.created_by
  runAs?: 'system' | 'user';
  timeoutSeconds?: number;
  targetSessionId?: number;
  batchId?: string | null;
  automationRunId?: string | null;
  requireOnline?: boolean;              // automation semantics: refuse non-online devices
  deliver?: boolean;                    // default true; false = queue only (heartbeat pickup)
};

export type DispatchScriptResult =
  | { ok: true; commandId: string; executionId: string | null; delivered: boolean; executedAt: Date | null }
  | { ok: false; code: 'device_decommissioned' | 'device_offline' | 'os_mismatch' | 'org_mismatch' | 'insert_failed'; error: string };

export async function dispatchScriptToDevice(input: DispatchScriptInput): Promise<DispatchScriptResult>;
```

- [ ] **Step 1: Verify `CommandTypes.SCRIPT` is in `AUDITED_COMMANDS`**

Run: `grep -n "SCRIPT" apps/api/src/services/commandQueue.ts | head -20` and inspect the `AUDITED_COMMANDS` set start (~line 400). If `CommandTypes.SCRIPT` is NOT in the set, stop and flag — Task 1 assumes `queueCommand` writes the `agent.command.script` audit row for script commands.

- [ ] **Step 2: Write failing tests**

Create `apps/api/src/services/scriptDispatch.test.ts` mirroring the mock style of `scriptExecution.test.ts:1-60` (chainable Drizzle mocks; mock `./commandQueue` → `queueCommand`, `./commandDispatch`, `./sensitiveCommandPayload`, `../routes/agentWs`). Cover, at minimum:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('./commandQueue', () => ({ queueCommand: vi.fn() }));
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { claimPendingCommandForDelivery } from './commandDispatch';
import { decryptCommandForDelivery, encryptSensitivePayloadFields } from './sensitiveCommandPayload';
import { sendCommandToAgent } from '../routes/agentWs';
import { dispatchScriptToDevice } from './scriptDispatch';

const savedScript = (o = {}) => ({
  id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false,
  osTypes: ['linux'], language: 'bash', content: 'echo hi',
  timeoutSeconds: 60, runAs: 'system', deletedAt: null, ...o,
}) as any;

const device = (o = {}) => ({
  id: 'device-1', orgId: 'org-a', osType: 'linux', status: 'online', agentId: null, ...o,
}) as any;

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as any);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as any);
});

describe('dispatchScriptToDevice — invariants', () => {
  it('rejects a decommissioned device', async () => {
    const r = await dispatchScriptToDevice({ device: device({ status: 'decommissioned' }), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('device_decommissioned');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects offline device when requireOnline', async () => {
    const r = await dispatchScriptToDevice({ device: device({ status: 'offline' }), requireOnline: true, source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('device_offline');
  });

  it('queues for an offline device when requireOnline is not set (manual semantics)', async () => {
    const r = await dispatchScriptToDevice({ device: device({ status: 'offline' }), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(true);
  });

  it('rejects cross-org saved script (org-equality invariant)', async () => {
    const r = await dispatchScriptToDevice({ device: device({ orgId: 'org-b' }), source: { kind: 'saved', script: savedScript({ orgId: 'org-a' }) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('org_mismatch');
  });

  it('allows org-null (system/partner-wide) saved script on any device', async () => {
    const r = await dispatchScriptToDevice({ device: device({ orgId: 'org-b' }), source: { kind: 'saved', script: savedScript({ orgId: null }) } });
    expect(r.ok).toBe(true);
  });

  it('rejects OS-incompatible saved script', async () => {
    const r = await dispatchScriptToDevice({ device: device({ osType: 'windows' }), source: { kind: 'saved', script: savedScript({ osTypes: ['linux'] }) } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('os_mismatch');
  });
});

describe('dispatchScriptToDevice — rows and payload', () => {
  it('saved: creates an execution row with the DEVICE org and passes executionId in payload', async () => {
    const r = await dispatchScriptToDevice({
      device: device(), source: { kind: 'saved', script: savedScript() },
      parameters: { a: '1' }, triggeredBy: 'user-1', triggerType: 'manual', automationRunId: null,
    });
    expect(r.ok).toBe(true);
    const execValues = vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
    expect(execValues).toMatchObject({ scriptId: 'script-1', deviceId: 'device-1', orgId: 'org-a', triggeredBy: 'user-1', status: 'pending' });
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ scriptId: 'script-1', executionId: 'exec-1', language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system' });
  });

  it('raw: creates NO execution row and uses provenance as payload scriptId', async () => {
    const r = await dispatchScriptToDevice({
      device: device(), source: { kind: 'raw', content: 'ipconfig', language: 'powershell', provenance: 'automation:auto-1' },
      timeoutSeconds: 300, runAs: 'system',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.executionId).toBeNull();
    expect(db.insert).not.toHaveBeenCalled(); // no scriptExecutions insert; command goes via queueCommand
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ scriptId: 'automation:auto-1', content: 'ipconfig', language: 'powershell' });
    expect((payload as Record<string, unknown>).executionId).toBeUndefined();
  });

  it('runs the payload through encryptSensitivePayloadFields before queueCommand', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    expect(encryptSensitivePayloadFields).toHaveBeenCalledWith('script', expect.any(Object));
    expect(vi.mocked(encryptSensitivePayloadFields).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(queueCommand).mock.invocationCallOrder[0]!);
  });

  it('input runAs/timeoutSeconds override script defaults', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() }, runAs: 'user', timeoutSeconds: 5 });
    const [, , payload] = vi.mocked(queueCommand).mock.calls[0]!;
    expect(payload).toMatchObject({ runAs: 'user', timeoutSeconds: 5 });
  });

  it('deletes the pending execution row if queueCommand throws', async () => {
    const del = { where: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(db.delete).mockReturnValue(del as any);
    vi.mocked(queueCommand).mockRejectedValue(new Error('boom'));
    await expect(dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } })).rejects.toThrow('boom');
    expect(db.delete).toHaveBeenCalled();
  });
});

describe('dispatchScriptToDevice — delivery', () => {
  it('claims, decrypts via decryptCommandForDelivery, sends, and marks execution running (guarded)', async () => {
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValue({ set: vi.fn().mockReturnValue({ where: updateWhere }) } as any);
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date('2026-08-11T00:00:00Z') } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(decryptCommandForDelivery).toHaveBeenCalled();
    expect(sendCommandToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ id: 'cmd-1', type: 'script' }));
    if (r.ok) { expect(r.delivered).toBe(true); expect(r.executedAt).toEqual(new Date('2026-08-11T00:00:00Z')); }
  });

  it('releases the claim when decrypt returns null (does NOT send raw payload)', async () => {
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date() } as any);
    vi.mocked(decryptCommandForDelivery).mockReturnValue(null as any);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(releaseClaimedCommandDelivery).toHaveBeenCalledWith('cmd-1', expect.any(Date));
    if (r.ok) expect(r.delivered).toBe(false);
  });

  it('releases the claim when the WS send fails', async () => {
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ executedAt: new Date() } as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(false);
    const { releaseClaimedCommandDelivery } = await import('./commandDispatch');
    const r = await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), source: { kind: 'saved', script: savedScript() } });
    expect(releaseClaimedCommandDelivery).toHaveBeenCalled();
    if (r.ok) expect(r.delivered).toBe(false);
  });

  it('skips delivery entirely when deliver:false or agentId null', async () => {
    await dispatchScriptToDevice({ device: device({ agentId: 'agent-1' }), deliver: false, source: { kind: 'saved', script: savedScript() } });
    await dispatchScriptToDevice({ device: device({ agentId: null }), source: { kind: 'saved', script: savedScript() } });
    expect(claimPendingCommandForDelivery).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests, verify they fail** — `pnpm --filter @breeze/api test -- run src/services/scriptDispatch.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `apps/api/src/services/scriptDispatch.ts`**

```ts
import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import { devices, scriptExecutions, scripts } from '../db/schema';
import {
  claimPendingCommandForDelivery,
  releaseClaimedCommandDelivery,
} from './commandDispatch';
import { queueCommand } from './commandQueue';
import {
  decryptCommandForDelivery,
  encryptSensitivePayloadFields,
} from './sensitiveCommandPayload';
import { sendCommandToAgent } from '../routes/agentWs';

/**
 * Single seam through which every script reaches a device (#3409 PR 0).
 * Owns: invariant checks → script_executions row (saved sources) → payload
 * build → sensitive-field encryption at enqueue → queueCommand (audit +
 * dispatch metrics) → claim / JIT-decrypt / WS send / release.
 *
 * Callers own: auth, site permissions, maintenance windows, batching, and
 * any caller-specific status bookkeeping (e.g. automation's 'queued' state).
 * Inserts run in the caller's ambient DB context — request paths stay under
 * RLS; system-context callers must validate ownership before calling.
 */
export type ScriptDispatchSource =
  | { kind: 'saved'; script: typeof scripts.$inferSelect }
  | { kind: 'raw'; content: string; language: string; provenance: string };

export type DispatchScriptInput = {
  device: Pick<typeof devices.$inferSelect, 'id' | 'orgId' | 'osType' | 'status' | 'agentId'>;
  source: ScriptDispatchSource;
  parameters?: Record<string, unknown>;
  triggerType?: string;
  triggeredBy?: string | null;
  createdBy?: string | null;
  runAs?: 'system' | 'user';
  timeoutSeconds?: number;
  targetSessionId?: number;
  batchId?: string | null;
  automationRunId?: string | null;
  requireOnline?: boolean;
  deliver?: boolean;
};

export type DispatchScriptResult =
  | { ok: true; commandId: string; executionId: string | null; delivered: boolean; executedAt: Date | null }
  | { ok: false; code: 'device_decommissioned' | 'device_offline' | 'os_mismatch' | 'org_mismatch' | 'insert_failed'; error: string };

export async function dispatchScriptToDevice(input: DispatchScriptInput): Promise<DispatchScriptResult> {
  const { device, source } = input;

  if (device.status === 'decommissioned') {
    return { ok: false, code: 'device_decommissioned', error: 'Device is decommissioned' };
  }
  if (input.requireOnline && device.status !== 'online') {
    return { ok: false, code: 'device_offline', error: `Device is ${device.status}, cannot execute command` };
  }

  if (source.kind === 'saved') {
    const script = source.script;
    // Org-equality invariant (mirrors scriptExecution.ts / playbooks.ts): an
    // org-less script (system or partner-wide) is universally runnable, but a
    // non-null script org must match the target device's org.
    if (script.orgId !== null && script.orgId !== device.orgId) {
      return { ok: false, code: 'org_mismatch', error: 'Script and device must belong to the same organization' };
    }
    if (!script.osTypes.includes(device.osType)) {
      return { ok: false, code: 'os_mismatch', error: 'Script is not compatible with device OS' };
    }
  }

  const parameters = input.parameters ?? {};
  const language = source.kind === 'saved' ? source.script.language : source.language;
  const content = source.kind === 'saved' ? source.script.content : source.content;
  const runAs = input.runAs ?? (source.kind === 'saved' ? source.script.runAs : 'system');
  const timeoutSeconds = input.timeoutSeconds ?? (source.kind === 'saved' ? source.script.timeoutSeconds : 300);
  const payloadScriptId = source.kind === 'saved' ? source.script.id : source.provenance;

  let executionId: string | null = null;
  if (source.kind === 'saved') {
    // Child rows always take the DEVICE's org (partner-wide fan-out rule).
    const [execution] = await db
      .insert(scriptExecutions)
      .values({
        scriptId: source.script.id,
        deviceId: device.id,
        orgId: device.orgId,
        triggeredBy: input.triggeredBy ?? null,
        triggerType: input.triggerType ?? 'manual',
        ...(input.automationRunId ? { automationRunId: input.automationRunId } : {}),
        parameters,
        status: 'pending',
      })
      .returning({ id: scriptExecutions.id });
    if (!execution) {
      return { ok: false, code: 'insert_failed', error: 'Failed to create execution' };
    }
    executionId = execution.id;
  }

  const payload = encryptSensitivePayloadFields('script', {
    scriptId: payloadScriptId,
    ...(executionId ? { executionId } : {}),
    ...(input.batchId ? { batchId: input.batchId } : {}),
    language,
    content,
    parameters,
    timeoutSeconds,
    runAs,
    ...(input.targetSessionId != null ? { targetSessionId: input.targetSessionId } : {}),
  });

  let command: Awaited<ReturnType<typeof queueCommand>>;
  try {
    command = await queueCommand(device.id, 'script', payload, input.createdBy ?? undefined);
  } catch (err) {
    // Don't leave an orphaned pending execution the reaper would later
    // mislabel 'timeout' (mirrors discardQueuelessExecution in automationRuntime).
    if (executionId) {
      await db.delete(scriptExecutions).where(and(
        eq(scriptExecutions.id, executionId),
        eq(scriptExecutions.status, 'pending'),
      ));
    }
    throw err;
  }
  if (!command) {
    return { ok: false, code: 'insert_failed', error: 'Failed to create command' };
  }

  let delivered = false;
  let executedAt: Date | null = null;
  if (device.agentId && input.deliver !== false) {
    const claimed = await claimPendingCommandForDelivery(command.id);
    if (claimed) {
      const deliverable = decryptCommandForDelivery({ id: command.id, type: 'script', payload });
      const sent = deliverable
        ? sendCommandToAgent(device.agentId, deliverable as { id: string; type: string; payload: Record<string, unknown> })
        : false;
      if (sent) {
        delivered = true;
        executedAt = claimed.executedAt;
        if (executionId) {
          // Guarded on pending: a fast agent can already have driven the row
          // terminal via handleScriptResult (see automationRuntime.ts:996).
          await db
            .update(scriptExecutions)
            .set({ status: 'running', startedAt: claimed.executedAt })
            .where(and(eq(scriptExecutions.id, executionId), eq(scriptExecutions.status, 'pending')));
        }
      } else {
        await releaseClaimedCommandDelivery(command.id, claimed.executedAt);
      }
    }
  }

  return { ok: true, commandId: command.id, executionId, delivered, executedAt };
}
```

- [ ] **Step 5: Run tests to green** — `pnpm --filter @breeze/api test -- run src/services/scriptDispatch.test.ts` → PASS. Adjust mocks to real Drizzle chain shapes if the implementation's call pattern differs — never weaken assertions.

- [ ] **Step 6: Commit** — `git add apps/api/src/services/scriptDispatch.ts apps/api/src/services/scriptDispatch.test.ts && git commit -m "feat(api): add scriptDispatch core service (#3409 PR0)"`

---

### Task 2: `executeScriptOnDevices` becomes a thin caller

**Files:**
- Modify: `apps/api/src/services/scriptExecution.ts:177-252` (per-device loop)
- Test: `apps/api/src/services/scriptExecution.test.ts` (existing suite must stay green unmodified except mock target changes)

**Interfaces:**
- Consumes: `dispatchScriptToDevice`, `ScriptDispatchSource` from Task 1.
- Produces: `executeScriptOnDevices` signature and result type UNCHANGED (callers in `routes/scripts.ts:872`, `routes/remediationSuggestions.ts:865`, and Task 3's mobile route depend on it).

- [ ] **Step 1: Replace the per-device loop body.** Delete the direct `scriptExecutions`/`deviceCommands` inserts and the `sendCommandToAgent` block (lines 178-245) and replace with:

```ts
  const executions: Array<{ executionId: string; deviceId: string; commandId: string }> = [];
  for (const device of executableDevices) {
    const dispatch = await dispatchScriptToDevice({
      device,
      source: { kind: 'saved', script },
      parameters,
      triggerType,
      triggeredBy: input.auth.user.id,
      createdBy: input.auth.user.id,
      runAs,
      targetSessionId: input.targetSessionId,
      batchId,
    });
    if (!dispatch.ok) {
      // Pre-checks above (org access, os filter, decommissioned filter) make
      // these unreachable for this caller; treat as the insert failures the
      // old code threw on.
      throw new Error(dispatch.error);
    }
    executions.push({
      executionId: dispatch.executionId!,
      deviceId: device.id,
      commandId: dispatch.commandId,
    });
  }
```

Remove now-unused imports (`deviceCommands`, `claimPendingCommandForDelivery`, `releaseClaimedCommandDelivery`, `sendCommandToAgent`) and add `import { dispatchScriptToDevice } from './scriptDispatch';`. Note `runAs` passed explicitly: preserves the existing `input.runAs ?? script.runAs` precedence computed at line 154.

- [ ] **Step 2: Fix the existing test mocks.** `scriptExecution.test.ts` mocks `./commandDispatch` and `../routes/agentWs` directly; the service no longer imports them. Replace those two `vi.mock` blocks with a mock of `./scriptDispatch` that returns `{ ok: true, commandId: 'cmd-1', executionId: 'exec-1', delivered: false, executedAt: null }`, and update row-insertion assertions to assert on `dispatchScriptToDevice` call args instead of `db.insert` where the test was asserting command-payload contents. Keep all isolation/permission test intents identical.

- [ ] **Step 3: Run** — `pnpm --filter @breeze/api test -- run src/services/scriptExecution.test.ts src/services/scriptDispatch.test.ts` → PASS.

- [ ] **Step 4: Run the route callers' suites** — `pnpm --filter @breeze/api test -- run src/routes/scripts.test.ts src/routes/remediationSuggestions.test.ts` (skip a file if it doesn't exist) → PASS.

- [ ] **Step 5: Commit** — `git commit -am "refactor(api): executeScriptOnDevices dispatches via scriptDispatch core (#3409 PR0)"`

---

### Task 3: Mobile route delegates to `executeScriptOnDevices`

**Files:**
- Modify: `apps/api/src/routes/mobile.ts:1199-1290` (`run_script` branch)
- Test: `apps/api/src/routes/mobile.test.ts` (or the existing mobile route test file — locate with `ls apps/api/src/routes/ | grep -i mobile`)

**Interfaces:**
- Consumes: `executeScriptOnDevices` (unchanged signature from Task 2).

- [ ] **Step 1: Replace the inline duplicate.** Delete lines 1199-1290's script/execution/command handling and replace with:

```ts
    if (data.action === 'run_script') {
      const result = await executeScriptOnDevices({
        scriptId: data.scriptId as string,
        deviceIds: [device.id],
        parameters: data.parameters as Record<string, unknown> | undefined,
        triggerType: 'manual',
        auth,
        permissions,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, result.status);
      }

      const execution = result.executions[0]!;
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'mobile.device.action',
        resourceType: 'device',
        resourceId: device.id,
        resourceName: device.hostname,
        details: {
          action: data.action,
          scriptId: result.scriptId,
          executionId: execution.executionId,
          commandId: execution.commandId,
        },
      });

      return c.json({
        action: data.action,
        executionId: execution.executionId,
        commandId: execution.commandId,
      }, 201);
    }
```

Add `import { executeScriptOnDevices } from '../services/scriptExecution';`. Remove imports that become unused (`scriptExecutions`, `deviceCommands`, `scripts` — only if not used elsewhere in the file; check with grep before removing). The device-level org/site/decommissioned checks above the branch stay — they cover the 404/403 the old inline code produced, and `executeScriptOnDevices` re-derives script access, org-equality, and OS compat. **Intended behavior deltas** (Global Constraints #1): WS push on dispatch, maintenance-window 409, coarser error copy for os/org mismatch (`'No accessible or compatible devices found'`, 400 instead of bespoke messages).

- [ ] **Step 2: Update/extend mobile route tests** for the new mock target (`executeScriptOnDevices`) asserting: single-device call shape, 201 response shape unchanged (`{action, executionId, commandId}`), error passthrough of `result.status`/`result.error`, audit still written.

- [ ] **Step 3: Run** the mobile route test file → PASS.

- [ ] **Step 4: Commit** — `git commit -am "refactor(api): mobile run_script delegates to executeScriptOnDevices — gains WS push + maintenance windows (#3409 PR0)"`

---

### Task 4: AI `run_script` — dispatch core, execution rows, partner-wide visibility

**Files:**
- Modify: `apps/api/src/services/aiToolsScripts.ts:150-231`
- Test: `apps/api/src/services/aiToolsScripts.runScript.orgEquality.test.ts` (extend), new assertions in same file

**Interfaces:**
- Consumes: `dispatchScriptToDevice` (Task 1), `waitForCommandResult` (`services/commandQueue.ts:538`).

- [ ] **Step 1: Fix script visibility.** Replace lines 172-174:

```ts
      const scriptConditions: SQL[] = [eq(scripts.id, input.scriptId as string), isNull(scripts.deletedAt)];
      // Partner-wide scripts have org_id NULL; the plain orgCondition would
      // exclude them even though RLS makes them visible to this session.
      // Defense-in-depth stays: org-owned scripts must satisfy orgCondition,
      // org-less rows pass here and are constrained per-device below.
      const orgCond = auth.orgCondition(scripts.orgId);
      if (orgCond) scriptConditions.push(or(isNull(scripts.orgId), orgCond)!);
```

Add `or` to the drizzle-orm import. Widen the script `select` to include `partnerId` and `osTypes` columns.

- [ ] **Step 2: Add the system-context partner guard.** The intent-release worker runs this tool under a system DB context where RLS does not filter partner-wide rows. After loading the script, add once (before the device loop):

```ts
      // Under a system context (intent-release worker) RLS no longer scopes
      // partner-wide rows — verify partner ownership explicitly against each
      // target device's org below. Request paths already saw RLS filtering.
      const scriptPartnerId = script.partnerId ?? null;
```

and inside the device loop, after the org-equality check:

```ts
          if (scriptPartnerId !== null) {
            const [deviceOrg] = await db
              .select({ partnerId: organizations.partnerId })
              .from(organizations)
              .where(eq(organizations.id, access.device.orgId))
              .limit(1);
            if (!deviceOrg || deviceOrg.partnerId !== scriptPartnerId) {
              results[deviceId] = { error: 'Device not found or access denied' };
              continue;
            }
          }
```

Add `organizations` to the schema import.

- [ ] **Step 3: Dispatch via the core with an execution row.** Replace the `executeCommand` call (lines 214-221) with:

```ts
          const dispatch = await dispatchScriptToDevice({
            device: access.device,
            source: { kind: 'saved', script },
            parameters: (input.parameters as Record<string, unknown>) ?? {},
            triggerType: 'ai',
            triggeredBy: auth.user.id,
            createdBy: auth.user.id,
            requireOnline: true,
          });
          if (!dispatch.ok) {
            results[deviceId] = { error: dispatch.error };
            continue;
          }
          results[deviceId] = await waitForCommandResult(dispatch.commandId, 60000);
```

The `script` selected must now be the full row shape `dispatchScriptToDevice` expects (`typeof scripts.$inferSelect` fields it reads: `id, orgId, osTypes, language, content, timeoutSeconds, runAs`) — switch the select to `db.select().from(scripts)` full-row for simplicity. First `grep -rn "triggerType" apps/api/src/db/schema/scripts.ts` to confirm `trigger_type` is a plain text column (no CHECK/enum); if constrained, use `'manual'` instead of `'ai'`.

- [ ] **Step 4: Extend tests.** In `aiToolsScripts.runScript.orgEquality.test.ts`: keep existing org-equality cases green; add (a) partner-wide script (`orgId: null, partnerId: 'p1'`) reachable when the device org's partner matches and rejected when it doesn't, (b) assertion that `dispatchScriptToDevice` is called (execution row creation is Task 1's tested concern), (c) result comes from `waitForCommandResult`.

- [ ] **Step 5: Run** — `pnpm --filter @breeze/api test -- run src/services/aiToolsScripts.runScript.orgEquality.test.ts src/services/aiToolsScripts.commandTypes.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git commit -am "fix(api): AI run_script gains execution rows + partner-wide script support via dispatch core (#3409 PR0)"`

---

### Task 5: Automation actions dispatch via the core

**Files:**
- Modify: `apps/api/src/services/automationRuntime.ts:910-1030` (`executeRunScriptAction`) and `:1042-1095` (`executeCommandAction`)
- Test: `apps/api/src/services/automationRuntime.runScript.test.ts` (existing suite; update mock targets)

**Interfaces:**
- Consumes: `dispatchScriptToDevice` (Task 1).

- [ ] **Step 1: Rewrite `executeRunScriptAction` dispatch.** Keep the existing script-load and OS pre-check log messages (they produce action-log copy tests may assert). Replace the execution-insert + `queueCommandForExecution` + discard + status-update block (lines 923-1018) with:

```ts
  const dispatch = await dispatchScriptToDevice({
    device: context.device,
    source: { kind: 'saved', script },
    parameters,
    triggerType: 'automation',
    triggeredBy: context.automation.createdBy ?? null,
    createdBy: context.automation.createdBy ?? null,
    runAs: action.runAs ?? script.runAs,
    automationRunId: context.runId,
    requireOnline: true,
  });

  if (!dispatch.ok) {
    return {
      success: false,
      log: logEntry('Failed to queue run_script action command', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: { error: dispatch.error, scriptId: script.id },
      }),
    };
  }

  if (!dispatch.delivered && dispatch.executionId) {
    // Undelivered-but-queued: matches the old 'queued' status write; the core
    // only writes 'running' on actual delivery.
    await db
      .update(scriptExecutions)
      .set({ status: 'queued' })
      .where(and(
        eq(scriptExecutions.id, dispatch.executionId),
        eq(scriptExecutions.status, 'pending'),
      ));
  }

  return {
    success: true,
    log: logEntry('Queued run_script action', 'info', {
      actionType: action.type,
      actionIndex,
      deviceId: context.device.id,
      commandId: dispatch.commandId,
      details: { scriptId: script.id, executionId: dispatch.executionId },
    }),
  };
```

Semantics preserved: `requireOnline:true` reproduces `queueCommandForExecution`'s online gate (offline → `dispatch.ok === false`, no orphan row — the core never inserted one because the check precedes the insert); a `queueCommand` throw deletes the pending execution inside the core (old `discardQueuelessExecution` catch). If `discardQueuelessExecution` has no remaining callers after this change, delete it.

`context.device` must satisfy the core's device projection (`id, orgId, osType, status, agentId`) — check the `ActionExecutionContext` type; if `status`/`agentId` are missing from the automation device context, extend the context's device select (grep where `context.device` is built in `automationWorker.ts`/`automationRuntime.ts`) rather than re-querying per action.

- [ ] **Step 2: Rewrite `executeCommandAction`.** Replace the `queueCommandForExecution` call (lines 1049-1070) with:

```ts
  const dispatch = await dispatchScriptToDevice({
    device: context.device,
    source: {
      kind: 'raw',
      content: action.command,
      language: shell === 'cmd' ? 'cmd' : shell,
      provenance: `automation:${context.automation.id}`,
    },
    timeoutSeconds: 300,
    runAs: 'system',
    createdBy: context.automation.createdBy ?? null,
    requireOnline: true,
  });

  if (!dispatch.ok) {
    return {
      success: false,
      log: logEntry('Failed to queue execute_command action', 'error', {
        actionType: action.type,
        actionIndex,
        deviceId: context.device.id,
        details: { error: dispatch.error, shell },
      }),
    };
  }
```

Keep the success log lines below unchanged (swap `queueResult.command.id` → `dispatch.commandId`). Raw sources create no execution row (unchanged — `script_executions.script_id` is NOT NULL).

- [ ] **Step 3: Update `automationRuntime.runScript.test.ts` mocks** from `queueCommandForExecution` to `dispatchScriptToDevice`, preserving every scenario's intent (offline → failure log, throw → propagates with no orphan row [now asserted via the core's own tests], delivered → success log with commandId, undelivered → `queued` status write).

- [ ] **Step 4: Run** — `pnpm --filter @breeze/api test -- run src/services/automationRuntime.runScript.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "refactor(api): automation run_script/execute_command dispatch via scriptDispatch core (#3409 PR0)"`

---

### Task 6: Per-org batch rows

**Files:**
- Modify: `apps/api/src/services/scriptExecution.ts:156-175` (batch creation), `:247-252` (batch status), result type `:43-55`
- Modify: `apps/api/src/routes/scripts.ts` execute-route response (only if it names `batchId` — it spreads `result` fields; verify)
- Test: `apps/api/src/services/scriptExecution.test.ts`

- [ ] **Step 1: Check web/UI consumers.** `grep -rn "batchId" apps/web/src --include='*.tsx' --include='*.ts' | grep -v test` and `grep -rn "batchId" apps/api/src/routes/scripts.ts`. Record which response fields the web actually reads. If the web reads `batchId` only for display/polling of a single batch, the compat rule below suffices; if it aggregates across batches, extend the UI in this task.

- [ ] **Step 2: Write failing test:** two orgs' devices in one call produce two `script_execution_batches` inserts, each with its own org's device count, and each device's command payload carries its org's `batchId`.

```ts
  it('splits batches per org for a multi-org run of an org-null script', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(scriptSelectChain([baseScript({ orgId: null, isSystem: true })]) as any)
      .mockReturnValueOnce(devicesSelectChain([
        baseDevice({ id: 'device-1', orgId: 'org-a' }),
        baseDevice({ id: 'device-2', orgId: 'org-a' }),
        baseDevice({ id: 'device-3', orgId: 'org-b' }),
      ]) as any);
    const result = await executeScriptOnDevices({ scriptId: 'script-1', deviceIds: ['device-1', 'device-2', 'device-3'], auth: multiOrgAuth });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.batchIds).toHaveLength(2);
      expect(result.batchId).toBe(result.batchIds[0]);
    }
    // batch insert values: one orgId 'org-a' devicesTargeted 2, one 'org-b' devicesTargeted 1
  });
```

- [ ] **Step 3: Implement.** Group `executableDevices` by `orgId`; create one batch per org **when that org's group has >1 device OR more than one org is targeted** (single-device single-org keeps today's no-batch behavior); pass the device's org-batch id into `dispatchScriptToDevice`. Result type: add `batchIds: string[]`; keep `batchId: string | null` = `batchIds[0] ?? null` for compat. Update the final batch-status write to update all created batches (`inArray`).

- [ ] **Step 4: Run** the scriptExecution + scripts-route test files → PASS. If Step 1 found UI aggregation needs, make those edits and run `pnpm --filter @breeze/web test -- run <affected files>`.

- [ ] **Step 5: Commit** — `git commit -am "fix(api): split multi-org script batches per org (#3409 PR0)"`

---

### Task 7: Delete the dead deploymentWorker script path

**Files:**
- Modify/Delete: `apps/api/src/jobs/deploymentWorker.ts` (script branch at :933-949, or whole file)

- [ ] **Step 1: Verify deadness.** `grep -rn "deploymentWorker\|initializeDeploymentWorkers\|startDeployment" apps/api/src --include='*.ts' | grep -v deploymentWorker.ts | grep -v test`. If ZERO non-test importers: delete the file and its test file, and remove any barrel exports. If there ARE importers: delete only `executeScriptPayload` and its `'run_script'` dispatch branch (the command type the agent doesn't register), leaving the rest.

- [ ] **Step 2: Run** — `pnpm --filter @breeze/api test -- run src/jobs` (or the surviving affected test files) → PASS; confirm no TS references break: `pnpm --filter @breeze/api exec tsc --noEmit 2>&1 | head -30` (if OOM per known issue, rely on vitest + eslint instead).

- [ ] **Step 3: Commit** — `git commit -am "chore(api): remove dead deploymentWorker script dispatch path (#3409 PR0)"`

---

### Task 8: Full-suite verification + PR

- [ ] **Step 1:** `pnpm --filter @breeze/api test` (full unit suite) → PASS.
- [ ] **Step 2:** `pnpm lint` → clean for touched files.
- [ ] **Step 3:** Grep sweep for stragglers: `grep -rn "deviceCommands" apps/api/src/services/scriptExecution.ts apps/api/src/routes/mobile.ts` → no direct script-command inserts remain outside `scriptDispatch.ts`; `grep -rn "sendCommandToAgent" apps/api/src/services | grep -v scriptDispatch` → no script-path direct sends.
- [ ] **Step 4:** Push branch, open PR titled `refactor(api): extract scriptDispatch core; consolidate 5 script dispatch sites (#3409 PR 0)`. PR body: the six intended behavior deltas from Global Constraints, the deferred commit-before-deliver note, link to #3409 scoping comment. End body with the standard generated-with footer.
- [ ] **Step 5:** Run one code-review round (`superpowers:requesting-code-review`), act only on confirmed consequential findings.

## Self-Review Notes

- Spec coverage vs #3409 PR 0 line: dispatch extraction ✓ (T1-T5), mobile WS push ✓ (T3), AI execution rows ✓ (T4), AI partner-wide filter fix ✓ (T4), delivery-decrypt bypass retired ✓ (T1 Step 4 delivery block), batch tenancy ✓ (T6), dead code ✓ (T7). Deferred to PR 4 per Global Constraints: commit-before-deliver transaction shape. Not in PR 0 by design: any variable resolution, `secretEnv`, digest changes.
- Type consistency: `dispatchScriptToDevice` / `DispatchScriptInput` / `DispatchScriptResult` / `ScriptDispatchSource` names used identically in Tasks 2-5.
- Known judgment calls an executor must NOT "fix": raw sources create no execution row; automation's `queued` status write stays in the caller; mobile's coarser error copy is accepted.
