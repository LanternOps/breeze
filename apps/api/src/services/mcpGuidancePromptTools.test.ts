// apps/api/src/services/mcpGuidancePromptTools.test.ts
import { describe, it, expect } from 'vitest';
import { MCP_PROMPTS } from './mcpGuidance';
import { aiTools } from './aiTools';

describe('prompt guidance references only real tools', () => {
  const registered = new Set(aiTools.keys());

  it('every referencedTools entry exists in the aiTools registry', () => {
    const unknown: string[] = [];
    for (const p of MCP_PROMPTS) {
      for (const t of p.referencedTools) if (!registered.has(t)) unknown.push(`${p.name}:${t}`);
    }
    expect(unknown, `Prompt guidance references non-existent tools: ${unknown.join(', ')}`).toEqual([]);
  });
});
