import { afterEach, describe, expect, it } from 'vitest';
import { aiScriptAuthoringEnabled } from './env';

const KEY = 'BREEZE_AI_SCRIPT_AUTHORING_ENABLED';
afterEach(() => { delete process.env[KEY]; });

describe('aiScriptAuthoringEnabled()', () => {
  it.each([undefined, '', 'false', '0', 'no', 'off', 'garbage'])('is false for %s', (value) => {
    if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
    expect(aiScriptAuthoringEnabled()).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE', '  true  '])('is true for %s', (value) => {
    process.env[KEY] = value;
    expect(aiScriptAuthoringEnabled()).toBe(true);
  });
});
