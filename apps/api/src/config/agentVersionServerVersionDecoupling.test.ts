import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A server-only release runs a server version AHEAD of the agent binaries it
// serves (e.g. server 0.118.2 with binaries 0.118.0). Agent upgrade targets,
// binary selection and installer verification must therefore never compare an
// agent version against the SERVER version (API_VERSION / APP_VERSION): they
// follow agent_versions rows and getBinariesVersion() only. This static scan
// keeps a future edit from reintroducing that coupling.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'routes/agents/heartbeat.ts',
  'routes/agentVersions.ts',
  'services/promotedAgentVersion.ts',
  'services/binarySync.ts',
  'services/binarySource.ts',
  'services/installerBuilder.ts',
];

// The one reviewed exception: ensureCurrentVersionRegistered, the boot safety
// net for FULL releases (APP_VERSION catches RC deploys that /releases/latest
// excludes). Server-only boots return before reaching it.
const ALLOWED_APP_VERSION_READS: Record<string, number> = {
  'services/binarySync.ts': 1,
};

function code(rel: string): string {
  // Drop line and block comments so prose mentioning APP_VERSION is not a hit.
  return readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('agent version logic is decoupled from the server version', () => {
  it.each(FILES)('%s does not import the server version module', (rel) => {
    const src = code(rel);
    expect(src).not.toMatch(/from\s+['"](\.\.\/)+version['"]/);
    expect(src).not.toMatch(/\bAPI_VERSION\b/);
  });

  it.each(FILES)('%s reads APP_VERSION only where reviewed', (rel) => {
    const reads = code(rel).match(/process\.env\.APP_VERSION\b|process\.env\[['"]APP_VERSION['"]\]/g) ?? [];
    expect(reads.length).toBe(ALLOWED_APP_VERSION_READS[rel] ?? 0);
  });

  it('the allowed binarySync read is the full-release boot safety net', () => {
    const src = code('services/binarySync.ts');
    const fn = src.slice(src.indexOf('async function ensureCurrentVersionRegistered'));
    expect(fn.slice(0, 400)).toContain('process.env.APP_VERSION');
  });
});
