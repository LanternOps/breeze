import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #4888 — `resolveScriptRunContextForApproval` decides what an approver is
 * TOLD about the run context an assistant chose, before the tool actually
 * runs. Getting this wrong either hides a genuine escalation (a script whose
 * saved default is the logged-in user, launched as SYSTEM because the model
 * asked) or crashes the approval path on a transient script-lookup failure —
 * the module's docstring calls out "fail-soft" as deliberate, so this file
 * also pins that a thrown lookup doesn't propagate.
 */

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

const mocks = vi.hoisted(() => ({ selectImpl: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => mocks.selectImpl(...args) },
  // Passthrough — this module's own RLS scoping isn't what's under test here;
  // scriptDispatch.test.ts and the RLS contract suite cover that.
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

import { captureException } from './sentry';
import {
  resolveScriptRunContextForApproval,
  describeScriptRunContext,
  isScriptLaunchTool,
} from './scriptRunContextApproval';

const ORG_ID = 'org-1';
const SCRIPT_ID = 'script-1';

/** Queues the row(s) `db.select(...).from(...).where(...).limit(1)` resolves to. */
function mockScriptRow(runAs: string | null) {
  mocks.selectImpl.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ runAs }]),
      }),
    }),
  });
}

/** Models the lookup THROWING (e.g. a transient DB fault). */
function mockScriptLookupThrows(err: unknown) {
  mocks.selectImpl.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockRejectedValue(err),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isScriptLaunchTool / resolveScriptRunContextForApproval — which tools this applies to', () => {
  it('returns null for a non-script tool', async () => {
    const result = await resolveScriptRunContextForApproval('manage_services', {}, ORG_ID);
    expect(result).toBeNull();
    // No lookup should even be attempted for a tool this doesn't apply to.
    expect(mocks.selectImpl).not.toHaveBeenCalled();
  });

  it('matches run_script', () => {
    expect(isScriptLaunchTool('run_script')).toBe(true);
  });

  it('matches execute_script_on_device', () => {
    expect(isScriptLaunchTool('execute_script_on_device')).toBe(true);
  });

  it('matches the mcp__script_builder__ prefixed form of execute_script_on_device', () => {
    expect(isScriptLaunchTool('mcp__script_builder__execute_script_on_device')).toBe(true);
  });

  it('does not match an unrelated prefixed tool name', () => {
    expect(isScriptLaunchTool('mcp__breeze__manage_services')).toBe(false);
  });
});

describe('resolveScriptRunContextForApproval — effective context resolution', () => {
  it('an assistant-chosen runAs overrides the script default and is flagged chosenByAssistant', async () => {
    mockScriptRow('user');

    const result = await resolveScriptRunContextForApproval(
      'run_script',
      { scriptId: SCRIPT_ID, runAs: 'system' },
      ORG_ID,
    );

    expect(result).toEqual({
      effectiveRunAs: 'system',
      scriptDefaultRunAs: 'user',
      chosenByAssistant: true,
      targetSessionId: null,
    });
  });

  it('with nothing supplied, the effective context is the script default and chosenByAssistant is false', async () => {
    mockScriptRow('user');

    const result = await resolveScriptRunContextForApproval('run_script', { scriptId: SCRIPT_ID }, ORG_ID);

    expect(result).toEqual({
      effectiveRunAs: 'user',
      scriptDefaultRunAs: 'user',
      chosenByAssistant: false,
      targetSessionId: null,
    });
  });

  it('when the script lookup throws, resolves fail-soft with scriptDefaultRunAs null instead of rejecting', async () => {
    mockScriptLookupThrows(new Error('connection reset'));

    const result = await resolveScriptRunContextForApproval(
      'run_script',
      { scriptId: SCRIPT_ID, runAs: 'system' },
      ORG_ID,
    );

    expect(result).toEqual({
      effectiveRunAs: 'system',
      scriptDefaultRunAs: null,
      chosenByAssistant: true,
      targetSessionId: null,
    });
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('describeScriptRunContext — the exact strings surfaced on the approval card', () => {
  it('names SYSTEM and the overridden default when the assistant chose SYSTEM over a user-default script', () => {
    const text = describeScriptRunContext({
      effectiveRunAs: 'system',
      scriptDefaultRunAs: 'user',
      chosenByAssistant: true,
      targetSessionId: null,
    });

    expect(text).toContain('SYSTEM');
    expect(text).toBe(
      "Runs as SYSTEM (full machine privileges) — chosen by the assistant, overriding the script's saved default of the logged-in user",
    );
  });

  it('names the inherited default when the assistant chose nothing', () => {
    const text = describeScriptRunContext({
      effectiveRunAs: 'user',
      scriptDefaultRunAs: 'user',
      chosenByAssistant: false,
      targetSessionId: null,
    });

    expect(text).toBe("Runs as the logged-in user — the script's saved default");
  });

  it('falls back to the generic sentence when nothing could be resolved (effectiveRunAs null)', () => {
    const text = describeScriptRunContext({
      effectiveRunAs: null,
      scriptDefaultRunAs: null,
      chosenByAssistant: false,
      targetSessionId: null,
    });

    expect(text).toBe("Runs in the script's saved run context");
  });
});
