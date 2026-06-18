import { describe, it, expect, vi } from 'vitest';
import { processScriptStreamEvent } from './scriptAiStore';

// processScriptStreamEvent takes set/get as params, so the apply pipeline can be
// driven directly with a fake store + a mock editor bridge — no SSE plumbing.

type AnyState = Record<string, any>;

function makeBridge(overrides: Record<string, any> = {}) {
  return {
    getFormValues: vi.fn(() => ({})),
    setFormValues: vi.fn(),
    takeSnapshot: vi.fn(() => ({ content: 'previous' })),
    restoreSnapshot: vi.fn(),
    ...overrides,
  };
}

function harness(initial: AnyState) {
  const state: AnyState = {
    messages: [],
    _bridge: null,
    error: null,
    hasApplied: false,
    hasReverted: false,
    formSnapshot: null,
    appliedSnapshot: null,
    ...initial,
  };
  const set = (fn: (s: AnyState) => Partial<AnyState>) => {
    Object.assign(state, fn(state));
  };
  const get = () => state;
  return { state, set, get };
}

function toolUseMsg(toolName: string, toolUseId = 't1') {
  return { id: `tool-${toolUseId}`, role: 'tool_use', toolName, toolUseId, content: '', createdAt: new Date() };
}

function applyEvent(output: unknown, toolUseId = 't1', isError = false) {
  return { type: 'tool_result', toolUseId, output, isError } as any;
}

function findResult(state: AnyState, toolUseId = 't1') {
  return state.messages.find((m: any) => m.id === `result-${toolUseId}`);
}

describe('processScriptStreamEvent — apply tool result', () => {
  it('applies code to the editor, marks hasApplied, and clears error on success', () => {
    const bridge = makeBridge();
    const { state, set, get } = harness({ _bridge: bridge, messages: [toolUseMsg('apply_script_code')] });

    processScriptStreamEvent(applyEvent({ code: 'echo hi', language: 'bash' }), set as any, get as any, null, false);

    expect(bridge.setFormValues).toHaveBeenCalledWith({ content: 'echo hi', language: 'bash' });
    expect(state.hasApplied).toBe(true);
    expect(state.error).toBeNull();
    expect(findResult(state)?.applyFailed).toBeFalsy();
  });

  it('applies metadata fields to the editor', () => {
    const bridge = makeBridge();
    const { state, set, get } = harness({ _bridge: bridge, messages: [toolUseMsg('apply_script_metadata')] });

    processScriptStreamEvent(
      applyEvent({ name: 'Disk Cleanup', category: 'Maintenance', timeoutSeconds: 600 }),
      set as any, get as any, null, false,
    );

    expect(bridge.setFormValues).toHaveBeenCalledWith({ name: 'Disk Cleanup', category: 'Maintenance', timeoutSeconds: 600 });
    expect(state.hasApplied).toBe(true);
    expect(state.error).toBeNull();
  });

  it('resolves MCP-prefixed apply tool names', () => {
    const bridge = makeBridge();
    const { state, set, get } = harness({
      _bridge: bridge,
      messages: [toolUseMsg('mcp__script_builder__apply_script_code')],
    });

    processScriptStreamEvent(applyEvent({ code: 'Get-Process', language: 'powershell' }), set as any, get as any, null, false);

    expect(bridge.setFormValues).toHaveBeenCalledWith({ content: 'Get-Process', language: 'powershell' });
    expect(state.hasApplied).toBe(true);
  });

  it('surfaces a specific error and flags the message when an apply result carries no usable fields', () => {
    const bridge = makeBridge();
    const { state, set, get } = harness({ _bridge: bridge, messages: [toolUseMsg('apply_script_code')] });

    // The #568 compaction failure mode: code stripped, only codeOmitted present.
    processScriptStreamEvent(
      applyEvent({ applied: true, codeOmitted: true, codeChars: 12 }),
      set as any, get as any, null, false,
    );

    expect(bridge.setFormValues).not.toHaveBeenCalled();
    expect(state.hasApplied).toBe(false);
    expect(state.error).toContain('no changes to insert');
    expect(findResult(state)?.applyFailed).toBe(true);
  });

  it('flags an empty apply_script_metadata result as a failure too', () => {
    const bridge = makeBridge();
    const { state, set, get } = harness({ _bridge: bridge, messages: [toolUseMsg('apply_script_metadata')] });

    processScriptStreamEvent(applyEvent({ applied: true }), set as any, get as any, null, false);

    expect(bridge.setFormValues).not.toHaveBeenCalled();
    expect(state.error).toContain('no changes to insert');
    expect(findResult(state)?.applyFailed).toBe(true);
  });

  it('surfaces a specific error and flags the message when no editor bridge is registered', () => {
    const { state, set, get } = harness({ _bridge: null, messages: [toolUseMsg('apply_script_code')] });

    processScriptStreamEvent(applyEvent({ code: 'echo hi', language: 'bash' }), set as any, get as any, null, false);

    expect(state.error).toContain('script editor is not ready');
    expect(state.hasApplied).toBe(false);
    expect(findResult(state)?.applyFailed).toBe(true);
  });

  it('surfaces a specific error and flags the message when applying to the form throws', () => {
    const bridge = makeBridge({ setFormValues: vi.fn(() => { throw new Error('boom'); }) });
    const { state, set, get } = harness({ _bridge: bridge, messages: [toolUseMsg('apply_script_code')] });

    processScriptStreamEvent(applyEvent({ code: 'echo hi', language: 'bash' }), set as any, get as any, null, false);

    expect(state.error).toContain('Failed to apply');
    expect(state.hasApplied).toBe(false);
    expect(findResult(state)?.applyFailed).toBe(true);
  });

  it('ignores an apply tool result flagged isError (no apply, no client error)', () => {
    const bridge = makeBridge();
    const { state, set, get } = harness({ _bridge: bridge, messages: [toolUseMsg('apply_script_code')] });

    processScriptStreamEvent(
      applyEvent({ error: 'tool failed server-side' }, 't1', true),
      set as any, get as any, null, false,
    );

    expect(bridge.setFormValues).not.toHaveBeenCalled();
    expect(state.hasApplied).toBe(false);
    expect(state.error).toBeNull();
    expect(findResult(state)?.applyFailed).toBeFalsy();
  });

  it('does not treat a non-apply tool result as an apply (no bridge calls, no error)', () => {
    const bridge = makeBridge();
    const { state, set, get } = harness({ _bridge: bridge, messages: [toolUseMsg('query_devices')] });

    processScriptStreamEvent(applyEvent({ devices: [], total: 0 }), set as any, get as any, null, false);

    expect(bridge.setFormValues).not.toHaveBeenCalled();
    expect(state.error).toBeNull();
    expect(state.hasApplied).toBe(false);
  });

  it('takes the Revert snapshot only once across multiple applies in a turn', () => {
    const bridge = makeBridge();
    const { set, get } = harness({
      _bridge: bridge,
      messages: [toolUseMsg('apply_script_code', 't1'), toolUseMsg('apply_script_metadata', 't2')],
    });

    const r1 = processScriptStreamEvent(applyEvent({ code: 'echo hi', language: 'bash' }, 't1'), set as any, get as any, null, false);
    const r2 = processScriptStreamEvent(applyEvent({ name: 'X' }, 't2'), set as any, get as any, null, r1.snapshotTaken);

    expect(r1.snapshotTaken).toBe(true);
    expect(r2.snapshotTaken).toBe(true);
    expect(bridge.takeSnapshot).toHaveBeenCalledTimes(1);
  });
});
