import { describe, it, expect } from 'vitest';
import { handlePromptsList, handlePromptsGet } from './mcpServer';

describe('prompts handlers', () => {
  it('lists the five prompts', () => {
    const res = handlePromptsList(1) as { result: { prompts: { name: string }[] } };
    expect(res.result.prompts).toHaveLength(5);
  });

  it('gets a prompt with argument substitution', () => {
    const res = handlePromptsGet(2, { name: 'breeze-device-investigate', arguments: { device: 'HOST-9' } }) as {
      result: { messages: { content: { text: string } }[] };
    };
    expect(res.result.messages[0]!.content.text).toContain('HOST-9');
  });

  it('returns a JSON-RPC error for a missing name', () => {
    const res = handlePromptsGet(3, {}) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
  });

  it('returns a JSON-RPC error for an unknown prompt', () => {
    const res = handlePromptsGet(4, { name: 'ghost' }) as { error: { code: number } };
    expect(res.error.code).toBe(-32602);
  });
});
