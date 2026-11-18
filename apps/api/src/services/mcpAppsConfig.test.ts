import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpAppsEnabled } from './mcpAppsConfig';

describe('mcpAppsEnabled (B-W05 D-B45)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    [' TRUE ', true],
    ['', false],
    [undefined, false],
    ['off', false],
    ['false', false],
    ['0', false],
    ['ture', false],
  ] as const)('MCP_APPS_ENABLED=%s → %s', (raw, expected) => {
    if (raw === undefined) vi.stubEnv('MCP_APPS_ENABLED', undefined as unknown as string);
    else vi.stubEnv('MCP_APPS_ENABLED', raw);
    expect(mcpAppsEnabled()).toBe(expected);
  });

  it('is read per call, not cached at import', () => {
    vi.stubEnv('MCP_APPS_ENABLED', 'false');
    expect(mcpAppsEnabled()).toBe(false);
    vi.stubEnv('MCP_APPS_ENABLED', 'true');
    expect(mcpAppsEnabled()).toBe(true);
  });
});
