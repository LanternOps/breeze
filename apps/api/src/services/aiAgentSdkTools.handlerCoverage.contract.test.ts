/**
 * Spec 2026-09-13 execution-plane §12 "Registry contracts": every tool the
 * chat/agent MCP server declares through `makeHandler('<name>', …)` routes to
 * `executeTool(name, …)`, which throws `Unknown tool` unless the name is in
 * the core `aiTools` registry (or the session-aware M365/Google tier tables).
 * Three backup tools sat declared-but-unregistered for months: every call the
 * model made failed at execution and no suite noticed, because the existing
 * parity suites only compare `TOOL_TIERS` with the registry, never the
 * `tool()` declarations with the registry.
 *
 * Source-level on purpose (same technique as aiAgentSdkTools.mcpCoverage):
 * the declarations live inside a factory and are not importable. The extractor
 * throws if it finds NOTHING so a restructure cannot make this vacuously pass.
 *
 * NOTE: no vi.mock — this suite needs the REAL registry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAllRegisteredToolNames } from './aiTools';

const SOURCE = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');

/** Every `makeHandler('<name>'` literal — the exact string executeTool receives. */
function makeHandlerNames(): string[] {
  const names = Array.from(SOURCE.matchAll(/\bmakeHandler\(\s*'([a-z0-9_]+)'/g), (m) => m[1]!);
  if (names.length < 50) {
    throw new Error(`extractor found only ${names.length} makeHandler declarations — aiAgentSdkTools.ts was restructured; fix the regex`);
  }
  return names;
}

/**
 * Frozen allowlist of declared names with no handler. Must stay EMPTY: a new
 * entry means a tool shipped that the model can see and can never run.
 */
const KNOWN_UNBACKED_DECLARATIONS: ReadonlySet<string> = new Set<string>([]);

describe('createBreezeMcpServer: every makeHandler declaration is executable (execution-plane §12)', () => {
  it('every makeHandler(name) has a registered handler executeTool can dispatch', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const unbacked = [...new Set(makeHandlerNames())]
      .filter((name) => !registered.has(name))
      .filter((name) => !KNOWN_UNBACKED_DECLARATIONS.has(name))
      .sort();
    expect(
      unbacked,
      'These tools are declared on the Breeze MCP server via makeHandler(...) but no handler ' +
        'is registered under that name, so every model call throws "Unknown tool". Register ' +
        'the handler (registerXTools in aiTools.ts) or delete the declaration, its TOOL_TIERS ' +
        'entry, its TOOL_PERMISSIONS entry and its input schema.',
    ).toEqual([]);
  });

  it('KNOWN_UNBACKED_DECLARATIONS stays empty and never rots', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const stale = [...KNOWN_UNBACKED_DECLARATIONS].filter((name) => registered.has(name));
    expect(stale).toEqual([]);
    expect(KNOWN_UNBACKED_DECLARATIONS.size).toBe(0);
  });
});
