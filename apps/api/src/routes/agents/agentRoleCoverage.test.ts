import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MAIN_AGENT_ONLY_TELEMETRY_ROUTES = [
  new URL('./changes.ts', import.meta.url),
  new URL('./connections.ts', import.meta.url),
];

describe('main-agent-only telemetry route invariant', () => {
  it.each(MAIN_AGENT_ONLY_TELEMETRY_ROUTES)('%s mounts requireAgentRole at router scope', (file) => {
    const source = readFileSync(file, 'utf8');

    expect(source).toMatch(/import\s+\{\s*requireAgentRole\s*\}/);
    expect(source).toMatch(/\.use\(\s*['"]\*['"]\s*,\s*requireAgentRole\s*\)/);
  });
});
