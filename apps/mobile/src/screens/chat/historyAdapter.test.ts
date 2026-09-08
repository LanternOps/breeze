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
