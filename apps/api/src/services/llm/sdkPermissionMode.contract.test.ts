/**
 * #11817: every Agent SDK `query()` site passes the pinned permission mode.
 *
 * A source scan, because two kinds of site cannot be reached through a mocked
 * `query`: the spike scripts (CLI entrypoints with a `main()`) and the e2e
 * suites (they spawn the real CLI). The production and harness sites are also
 * covered on the options object they build — see the `permissionMode`
 * assertions in streamingSessionManager.toolSearch.test.ts, runLoop.test.ts,
 * runSurface.test.ts, surfaceTurnHarness.test.ts and
 * providerFidelityHarness.test.ts.
 *
 * A new `query()` site fails the inventory check until it is classified here,
 * so it cannot ship on the SDK's default mode by accident. Comments are
 * stripped before matching, and a file needs one pin per `query({` call
 * (unless its calls share one options builder).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_PERMISSION_MODE } from './sdkChildEnvGuards';

const API_SRC = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(API_SRC, '../../..');
const SCAN_ROOTS = [API_SRC, path.join(API_SRC, '../scripts'), path.join(REPO_ROOT, 'ee')];

/** Every file that calls the SDK's `query()`, by what it is. Paths are repo-relative. */
const QUERY_SITES: Record<string, 'production' | 'harness' | 'spike' | 'e2e'> = {
  'apps/api/src/services/streamingSessionManager.ts': 'production', // chat, Helper, script builder, client AI
  'apps/api/src/services/aiAgents/runLoop.ts': 'production', // headless agent runs
  'apps/api/src/services/llm/surfaceTurnHarness.ts': 'production', // offering verification turn
  'apps/api/src/services/llm/providerFidelityHarness.ts': 'production', // catalog provider fidelity check
  'apps/api/src/services/llm/toolCapture/runSurface.ts': 'harness', // ai:tool-capture / tool-eval
  'apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts': 'spike',
  'apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts': 'spike',
  'apps/api/src/services/aiModels/gateway/gatewaySdk.e2e.test.ts': 'e2e',
  'apps/api/src/services/aiSdkToolArgGuard.e2e.test.ts': 'e2e',
  'apps/api/src/services/llm/sdkPermissionMode.e2e.test.ts': 'e2e',
};

const SDK_IMPORT_WITH_QUERY = /import\s*\{[^}]*\bquery\b[^}]*\}\s*from\s*['"]@anthropic-ai\/claude-agent-sdk['"]/;
/** `const { query } = await import('@anthropic-ai/claude-agent-sdk')`, aliased or not. */
const DYNAMIC_DESTRUCTURED_QUERY = /\{[^}]*\bquery\b[^}]*\}\s*=\s*await\s+import\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]/;
/** A dynamically imported SDK module called as `<name>.query(` (the harnesses inject it as `sdk`). */
const DYNAMIC_SDK_IMPORT = /\bimport\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]\s*\)/;
const MEMBER_QUERY_CALL = /\b\w+\.query\(/;
/** One `query({`/`sdk.query({` call, counted after comments are stripped. */
const QUERY_CALL = /(?:(?<![\w.])|\bsdk\.)query\(\s*\{/g;
const PINNED = /\bpermissionMode:\s*SDK_PERMISSION_MODE\b/g;
/** Files whose calls all take their options from one builder that carries the single pin. */
const PINNED_IN_ONE_BUILDER = new Set(['apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts']);
/** Production sites spread a gateway child's extra options; the pin must come after the spread. */
const AFTER_QUERY_OPTIONS_SPREAD = ['apps/api/src/services/streamingSessionManager.ts', 'apps/api/src/services/aiAgents/runLoop.ts'];

const isCliScript = (file: string): boolean => file.startsWith('apps/api/scripts/');

/** Drops block and line comments, so a pin or a call written in a comment does not count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // ee/ is optional in a checkout
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
}

/** Unit tests mock `query`; only e2e suites call the real one. */
function isScanned(file: string): boolean {
  return !file.endsWith('.test.ts') || file.endsWith('.e2e.test.ts');
}

let scanned: Map<string, string> | undefined;

function querySites(): Map<string, string> {
  return (scanned ??= scanQuerySites());
}

function scanQuerySites(): Map<string, string> {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  const sites = new Map<string, string>();
  for (const file of files.filter(isScanned)) {
    const raw = readFileSync(file, 'utf8');
    if (!raw.includes('@anthropic-ai/claude-agent-sdk')) continue;
    const source = stripComments(raw);
    if (
      SDK_IMPORT_WITH_QUERY.test(source)
      || DYNAMIC_DESTRUCTURED_QUERY.test(source)
      || (DYNAMIC_SDK_IMPORT.test(source) && MEMBER_QUERY_CALL.test(source))
    ) {
      sites.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), source);
    }
  }
  return sites;
}

describe('Agent SDK permission mode (#11817)', () => {
  it("is pinned to 'dontAsk'", () => {
    expect(SDK_PERMISSION_MODE).toBe('dontAsk');
  });

  it('knows every query() site under src/ and ee/ (classify a new one in QUERY_SITES)', () => {
    expect([...querySites().keys()].filter((f) => !isCliScript(f)).sort()).toEqual(Object.keys(QUERY_SITES).sort());
  });

  function expectPinnedAtEveryCall(file: string): void {
    const source = querySites().get(file);
    expect(source, `${file} no longer calls query()`).toBeDefined();
    const calls = source!.match(QUERY_CALL)?.length ?? 0;
    const pins = source!.match(PINNED)?.length ?? 0;
    expect(calls, `${file}: no query({ call found`).toBeGreaterThan(0);
    if (PINNED_IN_ONE_BUILDER.has(file)) expect(pins).toBe(1);
    else expect(pins, `${file}: ${calls} query() call(s), ${pins} pin(s)`).toBeGreaterThanOrEqual(calls);
  }

  it.each(Object.keys(QUERY_SITES))('%s passes permissionMode: SDK_PERMISSION_MODE at every call', expectPinnedAtEveryCall);

  // Discovered, not named: a CLI-only script must not be named under src/
  // (each script's registration test greps src/ for its file name).
  it('every apps/api/scripts CLI that calls query() pins the mode at every call', () => {
    const scripts = [...querySites().keys()].filter(isCliScript);
    expect(scripts.length, 'no scripts query() site found; the scan root may be wrong').toBeGreaterThan(0);
    for (const file of scripts) expectPinnedAtEveryCall(file);
  });

  it.each(AFTER_QUERY_OPTIONS_SPREAD)('%s pins the mode after the child queryOptions spread', (file) => {
    const source = querySites().get(file)!;
    const spread = source.indexOf('...(child.queryOptions');
    expect(spread, `${file}: queryOptions spread not found`).toBeGreaterThan(-1);
    expect(source.search(PINNED)).toBeGreaterThan(spread);
  });
});
