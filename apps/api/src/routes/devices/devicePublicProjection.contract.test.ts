import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('device response projection wiring', () => {
  it.each([
    ['core detail/update/decommission/restore', './core.ts', 4],
    ['provision', './provision.ts', 1],
    ['move organization', './moveOrg.ts', 1],
    ['maintenance enter/exit', './commands.ts', 2],
    ['AI device detail', '../../services/aiToolsDevice.ts', 1],
  ] as const)('%s sends every full device-row response through the public projection', (_name, file, expected) => {
    const body = source(file);
    expect(body.match(/projectPublicDevice\(/g)).toHaveLength(expected);
  });

  it('does not retain the evolving denylist serializer', () => {
    for (const file of ['./helpers.ts', './core.ts', './provision.ts', './moveOrg.ts', './commands.ts']) {
      expect(source(file)).not.toContain('stripSensitiveDeviceFields');
    }
  });
});
