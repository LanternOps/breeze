import { describe, expect, it } from 'vitest';
import {
  anyOfStatus,
  defaultStatus,
  defineEntry,
  flagStatus,
  hasValue,
  isFlagOn,
  isSet,
  listNames,
} from './statusHelpers';

describe('hasValue / isSet (D11)', () => {
  it('treats blank and whitespace-only values as unset', () => {
    expect(hasValue({ A: '' }, 'A')).toBe(false);
    expect(hasValue({ A: '   ' }, 'A')).toBe(false);
    expect(hasValue({}, 'A')).toBe(false);
    expect(hasValue({ A: 'x' }, 'A')).toBe(true);
  });

  it('counts NAME_FILE as set without opening the file', () => {
    // The path does not exist: if isSet tried to read it, it would throw.
    expect(isSet({ REDIS_PASSWORD_FILE: '/nonexistent/redis_password' }, 'REDIS_PASSWORD')).toBe(true);
    expect(isSet({ REDIS_PASSWORD: 'x' }, 'REDIS_PASSWORD')).toBe(true);
    expect(isSet({ REDIS_PASSWORD_FILE: '  ' }, 'REDIS_PASSWORD')).toBe(false);
  });
});

describe('isFlagOn', () => {
  it.each(['1', 'true', 'TRUE', ' yes ', 'on'])('%j is on', (raw) => {
    expect(isFlagOn({ F: raw }, 'F')).toBe(true);
  });
  it.each(['0', 'false', 'no', 'off', '', 'enabled'])('%j is off', (raw) => {
    expect(isFlagOn({ F: raw }, 'F')).toBe(false);
  });
});

describe('listNames', () => {
  it('joins names in English', () => {
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
    expect(listNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('defaultStatus', () => {
  const entry = {
    vars: [
      { name: 'SMTP_HOST', required: true },
      { name: 'SMTP_PASS', required: true },
      { name: 'SMTP_PORT', secret: false },
    ],
  };

  it('enabled when every required var is set; optional vars do not matter', () => {
    expect(defaultStatus(entry, { SMTP_HOST: 'h', SMTP_PASS: 'p' })).toEqual({ status: 'enabled' });
  });

  it('disabled when no required var is set, even if an optional one is', () => {
    expect(defaultStatus(entry, { SMTP_PORT: '587' })).toEqual({ status: 'disabled' });
  });

  it('required_missing (not disabled) for a core entry', () => {
    expect(defaultStatus({ ...entry, core: true }, {})).toEqual({
      status: 'required_missing',
      reason: 'SMTP_HOST and SMTP_PASS are not set',
    });
  });

  it('misconfigured names what is set and what is missing', () => {
    expect(defaultStatus(entry, { SMTP_HOST: 'h' })).toEqual({
      status: 'misconfigured',
      reason: 'SMTP_HOST is set but SMTP_PASS is missing',
    });
  });
});

describe('flagStatus / anyOfStatus', () => {
  it('disabled while every flag is off', () => {
    expect(flagStatus(['F1', 'F2'], ['NEED'], { F1: 'false' })).toEqual({ status: 'disabled' });
  });
  it('enabled when a flag is on and requirements are met', () => {
    expect(flagStatus(['F1', 'F2'], ['NEED'], { F2: 'true', NEED: 'x' })).toEqual({ status: 'enabled' });
  });
  it('misconfigured when a flag is on and a requirement is missing', () => {
    expect(flagStatus(['F1'], ['NEED_A', 'NEED_B'], { F1: '1', NEED_A: 'x' })).toEqual({
      status: 'misconfigured',
      reason: 'F1 is on but NEED_B is missing',
    });
  });
  it('anyOf is enabled when any alternative is set', () => {
    expect(anyOfStatus(['A', 'B'], { B: 'x' })).toEqual({ status: 'enabled' });
    expect(anyOfStatus(['A', 'B'], {})).toEqual({ status: 'disabled' });
  });
});

describe('defineEntry', () => {
  it('rejects a status that refers to a var the entry does not list', () => {
    expect(() =>
      defineEntry({
        id: 'x',
        group: 'integrations',
        label: 'X',
        vars: [{ name: 'X_ENABLED', secret: false }],
        status: { kind: 'flags', flags: ['X_ENABLED'], requiredWhenOn: ['X_TOKEN'] },
      }),
    ).toThrow(/X_TOKEN/);
  });

  it('rejects a default-status entry with no required var', () => {
    expect(() =>
      defineEntry({ id: 'x', group: 'integrations', label: 'X', vars: [{ name: 'X_TOKEN' }] }),
    ).toThrow(/required/);
  });

  it('routes status() through the chosen spec', () => {
    const entry = defineEntry({
      id: 'x',
      group: 'integrations',
      label: 'X',
      vars: [{ name: 'X_TOKEN', required: true }],
    });
    expect(entry.status({ X_TOKEN: 't' })).toEqual({ status: 'enabled' });
    expect(entry.status({})).toEqual({ status: 'disabled' });
  });
});
