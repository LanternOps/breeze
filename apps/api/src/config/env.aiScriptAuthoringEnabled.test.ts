import { afterEach, describe, expect, it } from 'vitest';
import { aiScriptAuthoringEnabled } from './env';

const KEY = 'BREEZE_AI_SCRIPT_AUTHORING_ENABLED';
afterEach(() => { delete process.env[KEY]; });

describe('aiScriptAuthoringEnabled()', () => {
  // W03 (#5612): the default flipped to ON. Unset and empty both mean "use the
  // default"; an explicit, recognised false still turns it off.
  it.each([undefined, ''])('defaults to true for %s (W03)', (value) => {
    if (value === undefined) delete process.env[KEY]; else process.env[KEY] = value;
    expect(aiScriptAuthoringEnabled()).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'garbage'])('is false for %s', (value) => {
    process.env[KEY] = value;
    expect(aiScriptAuthoringEnabled()).toBe(false);
  });

  it('is read at CALL time, so a flip needs no module reload', () => {
    process.env[KEY] = 'false';
    expect(aiScriptAuthoringEnabled()).toBe(false);
    process.env[KEY] = 'true';
    expect(aiScriptAuthoringEnabled()).toBe(true);
  });

  it.each(['true', '1', 'yes', 'on', 'TRUE', '  true  '])('is true for %s', (value) => {
    process.env[KEY] = value;
    expect(aiScriptAuthoringEnabled()).toBe(true);
  });
});
