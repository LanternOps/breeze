import { describe, it, expect } from 'vitest';
import { aiTools } from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS } from './aiGuardrails';

describe('aiTools registry parity', () => {
  const toolNames = Array.from(aiTools.keys());

  // Registration-debt payoff: every tool that was ever missing a schema/
  // permission entry has now been given one — both sets are intentionally
  // EMPTY. Do NOT add a tool name back into either set as a way to skip
  // writing its schema/permissions; add the real entry in aiToolSchemas.ts /
  // aiGuardrails.ts instead. A newly-registered tool with no schema or no
  // permission entry is exactly the bug this contract test exists to catch.
  const legacySchemaGaps = new Set<string>([]);

  // See legacySchemaGaps above — kept empty on purpose.
  const legacyPermissionGaps = new Set<string>([]);

  it('every registered tool has a Zod input schema, except tracked legacy gaps', () => {
    const missing = toolNames.filter(name => !(name in toolInputSchemas));
    const untracked = missing.filter(name => !legacySchemaGaps.has(name));
    expect(untracked, `Tools missing from toolInputSchemas: ${untracked.join(', ')}`).toEqual([]);
  });

  it('every registered tool has a TOOL_PERMISSIONS RBAC entry, except tracked legacy gaps', () => {
    const missing = toolNames.filter(name => !(name in TOOL_PERMISSIONS));
    const untracked = missing.filter(name => !legacyPermissionGaps.has(name));
    expect(untracked, `Tools missing from TOOL_PERMISSIONS: ${untracked.join(', ')}`).toEqual([]);
  });
});
