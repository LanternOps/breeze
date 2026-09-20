import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiTools } from './aiToolNames';
import { buildBreezeSdkTools } from './aiAgentSdkTools';

interface Descriptor {
  name: string;
  description?: string;
  input_schema: unknown;
}

function missingClauseActions(tool: Descriptor): string[] {
  const clause = tool.description?.match(/\bActions:\s*([^.;]+)/)?.[1];
  if (!clause) return [];
  const actions = (tool.input_schema as { properties?: { action?: { enum?: string[] } } })
    .properties?.action?.enum ?? [];
  const words = new Set(clause.match(/[a-z_]+/g));
  return actions.filter(action => !words.has(action));
}

describe('AI tool Actions clauses', () => {
  it('rejects partial clauses even when the prose names the missing actions', () => {
    expect(missingClauseActions({ name: 'fixture', description: 'Start services. Actions: list.',
      input_schema: { properties: { action: { enum: ['list', 'start'] } } },
    })).toEqual(['start']);
  });

  it('lists every action in each Actions clause on registry and emitted surfaces', () => {
    const descriptors: Descriptor[] = [...aiTools.values()].map(tool => tool.definition);
    for (const config of [
      { M365_ENABLED: 'false', GOOGLE_WORKSPACE_ENABLED: 'false', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false', DELEGANT_BASE_URL: '' },
      { M365_ENABLED: 'true', GOOGLE_WORKSPACE_ENABLED: 'true', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true', DELEGANT_BASE_URL: '' },
      { M365_ENABLED: 'false', GOOGLE_WORKSPACE_ENABLED: 'false', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false', DELEGANT_BASE_URL: 'https://delegant.example.com' },
    ]) {
      for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
      try {
        descriptors.push(...buildBreezeSdkTools(() => { throw new Error('handlers must not run'); }).map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: z.toJSONSchema(z.object(tool.inputSchema), { io: 'input', unrepresentable: 'any' }),
        })));
      } finally { vi.unstubAllEnvs(); }
    }
    const offenders = [...new Set(descriptors.flatMap(tool => {
      const missing = missingClauseActions(tool);
      return missing.length ? [`${tool.name}: ${missing.join(', ')}`] : [];
    }))];
    expect(offenders).toEqual([]);
  });
});
