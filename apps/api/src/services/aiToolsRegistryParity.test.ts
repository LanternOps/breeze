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

  // Both exemption lists above are `.filter()`ed out of the MISSING set, so a
  // tool that later gets its schema/permission keeps its exemption forever and
  // the list quietly stops describing reality. These two tests are what make
  // the lists shrink-only (#2814).
  it('keeps legacySchemaGaps honest — every entry is still missing a schema', () => {
    const stale = Array.from(legacySchemaGaps).filter(name => name in toolInputSchemas);
    expect(stale, `Now have schemas — drop from legacySchemaGaps: ${stale.join(', ')}`).toEqual([]);
  });

  it('keeps legacyPermissionGaps honest — every entry is still missing a permission', () => {
    const stale = Array.from(legacyPermissionGaps).filter(name => name in TOOL_PERMISSIONS);
    expect(stale, `Now have permissions — drop from legacyPermissionGaps: ${stale.join(', ')}`).toEqual([]);
  });

  // Neither list may name a tool that no longer exists in the registry, which
  // would otherwise mask a rename.
  it('neither exemption list names an unregistered tool', () => {
    const registered = new Set(toolNames);
    const unknown = [...legacySchemaGaps, ...legacyPermissionGaps].filter(name => !registered.has(name));
    expect(unknown, `Not in the aiTools registry: ${unknown.join(', ')}`).toEqual([]);
  });
});
