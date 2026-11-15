import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDirectoryModeWarningsForTests, isDirectoryDeprovisionEnforced } from './mode';

const NAME = 'PORTAL_DIRECTORY_DEPROVISION_ENFORCE';

describe('isDirectoryDeprovisionEnforced (D7)', () => {
  let saved: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = process.env[NAME];
    __resetDirectoryModeWarningsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[NAME];
    else process.env[NAME] = saved;
    warn.mockRestore();
  });

  it('unset, false, 0 and invalid values are report (invalid warns); true and 1 enforce', () => {
    delete process.env[NAME];
    expect(isDirectoryDeprovisionEnforced()).toBe(false);
    for (const value of ['', 'false', '0', ' FALSE ']) {
      process.env[NAME] = value;
      expect(isDirectoryDeprovisionEnforced()).toBe(false);
    }
    expect(warn).not.toHaveBeenCalled();
    for (const value of ['true', '1', ' TRUE ']) {
      process.env[NAME] = value;
      expect(isDirectoryDeprovisionEnforced()).toBe(true);
    }
    for (const value of ['yes', 'on', 'enforce']) {
      process.env[NAME] = value;
      expect(isDirectoryDeprovisionEnforced()).toBe(false);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).toContain(NAME);
  });

  it('warns once per invalid value, not on every read', () => {
    process.env[NAME] = 'yes';
    for (let i = 0; i < 5; i += 1) expect(isDirectoryDeprovisionEnforced()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reads the environment on every call (a restart is not needed to fall back to report)', () => {
    process.env[NAME] = 'true';
    expect(isDirectoryDeprovisionEnforced()).toBe(true);
    process.env[NAME] = 'false';
    expect(isDirectoryDeprovisionEnforced()).toBe(false);
  });
});
