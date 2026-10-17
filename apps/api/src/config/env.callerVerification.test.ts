import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callerVerificationEnabled, callerVerificationWorkstationEnabled } from './env';

afterEach(() => vi.unstubAllEnvs());

function setEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    vi.stubEnv(name, '');
    delete process.env[name];
  } else {
    vi.stubEnv(name, value);
  }
}

describe('callerVerificationEnabled (default ON, exact true only)', () => {
  it.each([
    [undefined, true],
    ['true', true],
    ['', false],
    ['false', false],
    ['1', false],
    ['yes', false],
    ['TRUE', false],
  ])('CALLER_VERIFICATION_ENABLED=%s -> %s', (value, expected) => {
    setEnv('CALLER_VERIFICATION_ENABLED', value);
    expect(callerVerificationEnabled()).toBe(expected);
  });
});

describe('callerVerificationWorkstationEnabled (default OFF, exact true only)', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['1', false],
    ['yes', false],
    ['TRUE', false],
    ['true', true],
  ])('CALLER_VERIFICATION_WORKSTATION_ENABLED=%s -> %s', (value, expected) => {
    setEnv('CALLER_VERIFICATION_WORKSTATION_ENABLED', value);
    expect(callerVerificationWorkstationEnabled()).toBe(expected);
  });
});

describe('compose files map both flags', () => {
  const root = resolve(__dirname, '../../../..');
  for (const file of ['docker-compose.yml', 'deploy/docker-compose.prod.yml']) {
    it(`${file} defaults`, () => {
      const text = readFileSync(resolve(root, file), 'utf8');
      expect(text).toContain('CALLER_VERIFICATION_ENABLED: ${CALLER_VERIFICATION_ENABLED:-true}');
      expect(text).toContain(
        'CALLER_VERIFICATION_WORKSTATION_ENABLED: ${CALLER_VERIFICATION_WORKSTATION_ENABLED:-false}',
      );
    });
  }
});
