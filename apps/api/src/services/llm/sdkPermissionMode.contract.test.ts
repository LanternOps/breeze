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
 * so it cannot ship on the SDK's default mode by accident.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SDK_PERMISSION_MODE } from './sdkChildEnvGuards';

const API_SRC = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(API_SRC, '../../..');
const SCAN_ROOTS = [API_SRC, path.join(REPO_ROOT, 'ee')];

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
/** A dynamically imported SDK called as `sdk.query(` (the harnesses inject it). */
const DYNAMIC_SDK_QUERY = /\bsdk\.query\(/;
const PINNED = /\bpermissionMode:\s*SDK_PERMISSION_MODE\b/;

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
    const source = readFileSync(file, 'utf8');
    if (!source.includes('@anthropic-ai/claude-agent-sdk')) continue;
    if (SDK_IMPORT_WITH_QUERY.test(source) || DYNAMIC_SDK_QUERY.test(source)) {
      sites.set(path.relative(REPO_ROOT, file).split(path.sep).join('/'), source);
    }
  }
  return sites;
}

describe('Agent SDK permission mode (#11817)', () => {
  it("is pinned to 'dontAsk'", () => {
    expect(SDK_PERMISSION_MODE).toBe('dontAsk');
  });

  it('knows every query() site (classify a new one in QUERY_SITES)', () => {
    expect([...querySites().keys()].sort()).toEqual(Object.keys(QUERY_SITES).sort());
  });

  it.each(Object.keys(QUERY_SITES))('%s passes permissionMode: SDK_PERMISSION_MODE', (file) => {
    const source = querySites().get(file);
    expect(source, `${file} no longer calls query()`).toBeDefined();
    expect(source).toMatch(PINNED);
  });
});
