/**
 * Contract (spec 2026-10-15 §2 "Enforcement point"): the AI data policy gate
 * lives in `executeTool`, so every tool it governs must be dispatched through
 * `executeTool` on every surface. Two surfaces do NOT pass through it:
 * session-aware chat tools (`makeSessionAwareHandler` in aiAgentSdkTools.ts:
 * M365, Google, script proposals) and the helper's client-declared tools
 * (namespaced `mcp__client__*`, run on the client). Neither may ever carry a
 * policy-governed tool.
 *
 * Source-level on purpose, like aiAgentSdkTools.handlerCoverage: the
 * declarations live inside a factory. The extractors throw when they find
 * nothing so a restructure cannot make this pass vacuously.
 *
 * NOTE: no vi.mock — this suite needs the REAL tables.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PATH_FIELDS } from './aiToolPathFields';
import { OFF_DENIED_ACTIONS, OFF_DENIED_TOOLS } from './aiDevicePathPolicy';
import { aiTools } from './aiTools';
import { CLIENT_DECLARED_MCP_SERVER_NAME, clientDeclaredToolMcpNames } from './clientSessionTools';

const SDK_SOURCE = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');

function namesCalledWith(fn: string): Set<string> {
  const names = new Set(Array.from(SDK_SOURCE.matchAll(new RegExp(`\\b${fn}\\(\\s*'([a-z0-9_]+)'`, 'g')), (m) => m[1]!));
  if (names.size === 0) throw new Error(`no ${fn}('<name>') found in aiAgentSdkTools.ts — fix the extractor`);
  return names;
}

const GOVERNED = new Set([
  ...Object.entries(PATH_FIELDS).filter(([, c]) => c.kind !== 'exempt').map(([k]) => k.split('.')[0]!),
  ...OFF_DENIED_TOOLS,
  ...Object.keys(OFF_DENIED_ACTIONS),
]);

describe('AI data policy: every governed tool dispatches through executeTool', () => {
  it('the governed set is what the spec names', () => {
    expect([...GOVERNED].sort()).toEqual([
      'analyze_disk_usage', 'diagnostic_list_directory', 'diagnostic_read_file', 'disk_cleanup',
      'execute_command', 'file_operations', 'remediate_sensitive_data', 'request_diagnostic_access',
    ]);
  });

  it('every governed tool is a core registry tool (executeTool resolves it)', () => {
    for (const tool of GOVERNED) expect(aiTools.has(tool), tool).toBe(true);
  });

  it('chat/agent declare every governed tool they offer through makeHandler (→ executeTool), never a session-aware handler', () => {
    const declared = namesCalledWith('tool');
    const viaExecuteTool = namesCalledWith('makeHandler');
    const sessionAware = namesCalledWith('makeSessionAwareHandler');
    // Not every governed tool is offered to chat (remediate_sensitive_data is
    // MCP-only); the ones that are must reach executeTool.
    const governedInChat = [...GOVERNED].filter((tool) => declared.has(tool));
    expect(governedInChat.length).toBeGreaterThanOrEqual(7);
    for (const tool of governedInChat) {
      expect(viaExecuteTool.has(tool), `${tool} must be declared via makeHandler`).toBe(true);
    }
    for (const tool of GOVERNED) {
      expect(sessionAware.has(tool), `${tool} must not be session-aware`).toBe(false);
    }
  });

  it('helper client-declared tools live on their own MCP server, so a declared name cannot shadow a governed tool', () => {
    const [name] = clientDeclaredToolMcpNames([{ name: 'file_operations' } as never]);
    expect(CLIENT_DECLARED_MCP_SERVER_NAME).not.toBe('breeze');
    expect(name).toBe(`mcp__${CLIENT_DECLARED_MCP_SERVER_NAME}__file_operations`);
  });
});
