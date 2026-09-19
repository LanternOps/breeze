import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * aiGuardrails.ts is imported by routes and services whose tests partially
 * mock db/schema (mcpServer.*.test.ts, intentService.tier2Agent.test.ts).
 * aiToolSchemas.ts imports Drizzle enum objects from db/schema, so a
 * guardrails → aiToolSchemas import turns every one of those partial mocks
 * into "No <enum> export is defined on the mock" at import time (#5054).
 * Registry-dependent helpers belong in aiToolActions.ts.
 */
describe('aiGuardrails.ts import surface', () => {
  it('does not import the tool input schemas or the definitions walker', () => {
    const src = readFileSync(new URL('./aiGuardrails.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from '\.\/aiToolSchemas'/);
    expect(src).not.toMatch(/\bgetToolDefinitions\b/);
  });
});
