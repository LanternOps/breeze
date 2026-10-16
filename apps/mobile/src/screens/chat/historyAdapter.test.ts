import { describe, expect, it } from 'vitest';

import type { ServerAiMessage } from '../../services/aiChat';
import { historyToMessages } from './historyAdapter';

function row(overrides: Partial<ServerAiMessage> & Pick<ServerAiMessage, 'id' | 'role'>): ServerAiMessage {
  return {
    content: null,
    toolName: null,
    toolUseId: null,
    toolInput: null,
    toolOutput: null,
    createdAt: '2026-05-07T00:00:00Z',
    ...overrides,
  } as ServerAiMessage;
}

describe('historyToMessages', () => {
  it('preserves user + assistant rows in order', () => {
    const out = historyToMessages([
      row({ id: 'u1', role: 'user', content: 'hi' }),
      row({ id: 'a1', role: 'assistant', content: 'hello back' }),
      row({ id: 'u2', role: 'user', content: 'and now?' }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ id: 'u1', role: 'user', content: 'hi' });
    expect(out[1]).toMatchObject({ id: 'a1', role: 'assistant', content: 'hello back' });
    expect(out[2]).toMatchObject({ id: 'u2', role: 'user', content: 'and now?' });
  });

  it('skips system rows entirely', () => {
    const out = historyToMessages([
      row({ id: 's1', role: 'system', content: 'system prompt' }),
      row({ id: 'u1', role: 'user', content: 'hi' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('u1');
  });

  it('attaches tool_use to the most recent assistant message as a started toolEvent', () => {
    const out = historyToMessages([
      row({ id: 'u1', role: 'user', content: 'do a thing' }),
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({ id: 'tu1', role: 'tool_use', toolUseId: 'tool-use-1', toolName: 'list_devices' }),
    ]);
    expect(out).toHaveLength(2);
    const assistant = out[1];
    expect(assistant.role).toBe('assistant');
    if (assistant.role === 'assistant') {
      expect(assistant.toolEvents).toHaveLength(1);
      expect(assistant.toolEvents[0]).toMatchObject({
        toolUseId: 'tool-use-1',
        toolName: 'list_devices',
        state: 'started',
      });
    }
  });

  it('pairs tool_result with its tool_use by toolUseId and flips state to completed', () => {
    const out = historyToMessages([
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({ id: 'tu1', role: 'tool_use', toolUseId: 'tu-x', toolName: 'list_devices' }),
      row({
        id: 'tr1',
        role: 'tool_result',
        toolUseId: 'tu-x',
        toolName: 'list_devices',
        toolOutput: { count: 7 },
      }),
    ]);
    const assistant = out[0];
    if (assistant.role === 'assistant') {
      expect(assistant.toolEvents).toHaveLength(1);
      const evt = assistant.toolEvents[0];
      expect(evt.state).toBe('completed');
      expect(evt.output).toEqual({ count: 7 });
      expect(evt.toolName).toBe('list_devices');
    }
  });

  it('orphan tool_use (no preceding assistant) synthesizes a placeholder assistant message', () => {
    const out = historyToMessages([
      row({ id: 'tu1', role: 'tool_use', toolUseId: 'tu-x', toolName: 'list_devices' }),
    ]);
    expect(out).toHaveLength(1);
    const placeholder = out[0];
    expect(placeholder.role).toBe('assistant');
    expect(placeholder.id).toBe('synth-tu1');
    if (placeholder.role === 'assistant') {
      expect(placeholder.toolEvents).toHaveLength(1);
      expect(placeholder.toolEvents[0].toolUseId).toBe('tu-x');
    }
  });

  it('orphan tool_result also synthesizes a placeholder', () => {
    const out = historyToMessages([
      row({ id: 'tr1', role: 'tool_result', toolUseId: 'tu-x', toolOutput: { ok: true } }),
    ]);
    expect(out).toHaveLength(1);
    const placeholder = out[0];
    if (placeholder.role === 'assistant') {
      expect(placeholder.id).toBe('synth-tr1');
      expect(placeholder.toolEvents).toHaveLength(1);
      expect(placeholder.toolEvents[0].state).toBe('completed');
      expect(placeholder.toolEvents[0].output).toEqual({ ok: true });
    }
  });

  it('a tool_use after a user message (no assistant in between) also synthesizes a placeholder', () => {
    const out = historyToMessages([
      row({ id: 'u1', role: 'user', content: 'hi' }),
      row({ id: 'tu1', role: 'tool_use', toolUseId: 'tu-x', toolName: 't' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[1].role).toBe('assistant');
    expect(out[1].id).toBe('synth-tu1');
  });

  it('carries toolInput onto the tool_use event (#5170)', () => {
    // Without this, a `manage_*` read-only call reads "Updated …" again on
    // reload/reconcile even though the live SSE path renders it correctly,
    // because `aiToolLabel` needs `input.action` to tell the two apart.
    const out = historyToMessages([
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({
        id: 'tu1',
        role: 'tool_use',
        toolUseId: 'tu-x',
        toolName: 'manage_automations',
        toolInput: { action: 'list' },
      }),
    ]);
    const assistant = out[0];
    if (assistant.role === 'assistant') {
      expect(assistant.toolEvents[0].input).toEqual({ action: 'list' });
    }
  });

  it('carries toolInput onto a tool_result-synthesized event too', () => {
    const out = historyToMessages([
      row({
        id: 'tr1',
        role: 'tool_result',
        toolUseId: 'tu-x',
        toolOutput: { ok: true },
        toolInput: { action: 'get' },
      }),
    ]);
    const placeholder = out[0];
    if (placeholder.role === 'assistant') {
      expect(placeholder.toolEvents[0].input).toEqual({ action: 'get' });
    }
  });

  it('leaves input undefined when toolInput is not an object', () => {
    const out = historyToMessages([
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({ id: 'tu1', role: 'tool_use', toolUseId: 'tu-x', toolName: 't', toolInput: null }),
    ]);
    const assistant = out[0];
    if (assistant.role === 'assistant') {
      expect(assistant.toolEvents[0].input).toBeUndefined();
    }
  });

  it('falls back to row.id when toolUseId is missing on a tool_use row', () => {
    const out = historyToMessages([
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({ id: 'tu-fallback', role: 'tool_use', toolUseId: null, toolName: 't' }),
    ]);
    const assistant = out[0];
    if (assistant.role === 'assistant') {
      expect(assistant.toolEvents[0].toolUseId).toBe('tu-fallback');
    }
  });
});

describe('historyToMessages action plans', () => {
  const input = {
    title: 'Fix printing',
    steps: [
      { toolName: 'manage_services', input: { name: 'Spooler' }, reasoning: 'Restart' },
      { toolName: 'run_script', input: {}, reasoning: 'Clear' },
    ],
  };

  it('rebuilds the plan from the propose_action_plan tool_use input', () => {
    const out = historyToMessages([
      row({ id: 'u1', role: 'user', content: 'fix printing' }),
      row({ id: 'a1', role: 'assistant', content: 'Here is the plan.' }),
      row({ id: 't1', role: 'tool_use', toolName: 'propose_action_plan', toolUseId: 'tu-plan', toolInput: input }),
    ]);
    const a = out[1];
    expect(a.role).toBe('assistant');
    if (a.role !== 'assistant') return;
    expect(a.plan).toMatchObject({ toolUseId: 'tu-plan', title: 'Fix printing', status: 'awaiting' });
    expect(a.plan?.steps.map((st) => st.toolName)).toEqual(['manage_services', 'run_script']);
    // The tool row itself stays, so turn-completeness still sees it as running.
    expect(a.toolEvents[0]).toMatchObject({ toolUseId: 'tu-plan', state: 'started' });
  });

  it('settles the plan from its tool_result (approved, rejected, dropped-call wrapper)', () => {
    const decided = (output: unknown) => {
      const out = historyToMessages([
        row({ id: 'a1', role: 'assistant', content: '' }),
        row({ id: 't1', role: 'tool_use', toolName: 'mcp__breeze__propose_action_plan', toolUseId: 'tu-plan', toolInput: input }),
        row({ id: 't2', role: 'tool_result', toolName: 'propose_action_plan', toolUseId: 'tu-plan', toolOutput: output }),
      ]);
      const a = out[0];
      return a.role === 'assistant' ? a.plan?.status : undefined;
    };
    expect(decided({ result: 'approved' })).toBe('approved');
    expect(decided({ result: 'rejected' })).toBe('rejected');
    expect(decided({ error: '{"result":"approved"}', droppedBeforeExecution: true })).toBe('approved');
    expect(decided({ error: 'Failed to create action plan' })).toBe('expired');
  });

  it('derives completed status and step ticks from the step tool results after approval', () => {
    const rows = (withSecond: boolean) => [
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({ id: 't1', role: 'tool_use', toolName: 'propose_action_plan', toolUseId: 'tu-plan', toolInput: input }),
      row({ id: 't2', role: 'tool_result', toolName: 'propose_action_plan', toolUseId: 'tu-plan', toolOutput: { result: 'approved' } }),
      row({ id: 't3', role: 'tool_use', toolName: 'manage_services', toolUseId: 'tu-1', toolInput: {} }),
      row({ id: 't4', role: 'tool_result', toolName: 'manage_services', toolUseId: 'tu-1', toolOutput: { ok: true } }),
      ...(withSecond ? [
        row({ id: 't5', role: 'tool_use', toolName: 'run_script', toolUseId: 'tu-2', toolInput: {} }),
        row({ id: 't6', role: 'tool_result', toolName: 'run_script', toolUseId: 'tu-2', toolOutput: { ok: true } }),
      ] : []),
    ];
    const done = historyToMessages(rows(true))[0];
    expect(done.role === 'assistant' ? done.plan?.status : null).toBe('completed');
    expect(done.role === 'assistant' ? done.plan?.steps.map((s) => s.status) : null).toEqual(['completed', 'completed']);
    const partial = historyToMessages(rows(false))[0];
    expect(partial.role === 'assistant' ? partial.plan?.status : null).toBe('approved');
    expect(partial.role === 'assistant' ? partial.plan?.steps.map((s) => s.status) : null).toEqual(['completed', 'pending']);
  });

  it('leaves non-plan tool rows without a plan', () => {
    const out = historyToMessages([
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({ id: 't1', role: 'tool_use', toolName: 'run_script', toolUseId: 'tu-1', toolInput: {} }),
    ]);
    const a = out[0];
    expect(a.role === 'assistant' ? a.plan : 'x').toBeUndefined();
  });
});

describe('historyToMessages model provenance (W05)', () => {
  const turnModel = {
    requestedModel: 'm', requestedDisplayName: 'Opus', servedModel: 'm', servedDisplayName: 'Opus',
    fallbackUsed: false, appliedOptions: {}, fastDowngraded: false,
  };

  it('stamps the session lastTurnModel on the last assistant turn only', () => {
    const out = historyToMessages([
      row({ id: 'u1', role: 'user', content: 'hi' }),
      row({ id: 'a1', role: 'assistant', content: 'one' }),
      row({ id: 'u2', role: 'user', content: 'again' }),
      row({ id: 'a2', role: 'assistant', content: 'two' }),
    ], turnModel);
    expect(out[1].role === 'assistant' && out[1].turnModel).toBeFalsy();
    expect(out[3].role === 'assistant' && out[3].turnModel).toEqual(turnModel);
  });

  it('does not stamp a turn that has not been answered yet', () => {
    const out = historyToMessages([
      row({ id: 'a1', role: 'assistant', content: 'one' }),
      row({ id: 'u2', role: 'user', content: 'pending' }),
    ], turnModel);
    expect(out[0].role === 'assistant' && out[0].turnModel).toBeFalsy();
  });

  it('does not stamp a trailing assistant row that is still in progress', () => {
    // A catch-up fetch mid-turn: the previous turn's provenance must not
    // render "Answered by" under a reply that has not finished.
    const out = historyToMessages([
      row({ id: 'u1', role: 'user', content: 'restart it' }),
      row({ id: 'a1', role: 'assistant', content: '' }),
      row({ id: 't1', role: 'tool_use', toolName: 'restart_device', toolUseId: 'tu1', toolInput: {} }),
    ], turnModel);
    expect(out[1].role === 'assistant' && out[1].turnModel).toBeFalsy();
  });

  it('ignores a malformed lastTurnModel', () => {
    const out = historyToMessages([row({ id: 'a1', role: 'assistant', content: 'one' })], { servedDisplayName: 7 });
    expect(out[0].role === 'assistant' && out[0].turnModel).toBeFalsy();
  });
});
