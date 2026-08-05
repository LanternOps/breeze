import { describe, expect, it } from 'vitest';
import { isEnvFlagEnabled } from './envFlag';

describe('isEnvFlagEnabled', () => {
  it('enables only on 1/true (case-insensitive, trimmed)', () => {
    expect(isEnvFlagEnabled('1')).toBe(true);
    expect(isEnvFlagEnabled('true')).toBe(true);
    expect(isEnvFlagEnabled(' TRUE ')).toBe(true);
  });

  it('treats explicit disables and junk as OFF — never as an accidental bypass', () => {
    expect(isEnvFlagEnabled(undefined)).toBe(false);
    expect(isEnvFlagEnabled('')).toBe(false);
    expect(isEnvFlagEnabled('0')).toBe(false);
    expect(isEnvFlagEnabled('false')).toBe(false);
    expect(isEnvFlagEnabled('no')).toBe(false);
    expect(isEnvFlagEnabled('yes')).toBe(false);
  });
});
