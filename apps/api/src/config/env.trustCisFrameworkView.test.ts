import { afterEach, describe, expect, it } from 'vitest';
import { trustCisFrameworkViewEnabled } from './env';

const KEY = 'BREEZE_TRUST_CIS_FRAMEWORK_VIEW';
afterEach(() => { delete process.env[KEY]; });

describe('trustCisFrameworkViewEnabled()', () => {
  it.each([undefined, '', 'false', '0', 'no', 'off', 'garbage'])('defaults OFF for %s', (value) => {
    if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
    expect(trustCisFrameworkViewEnabled()).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE', '  true  '])('is ON for %s', (value) => {
    process.env[KEY] = value;
    expect(trustCisFrameworkViewEnabled()).toBe(true);
  });

  it('is read at call time', () => {
    process.env[KEY] = 'true';
    expect(trustCisFrameworkViewEnabled()).toBe(true);
    process.env[KEY] = 'false';
    expect(trustCisFrameworkViewEnabled()).toBe(false);
  });
});
