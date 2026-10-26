import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PROMPT_KIND_NAMES } from '@breeze/shared/promptHost';
import {
  DEFAULT_ENABLED_PROMPT_KINDS,
  PROMPT_HOST_ENABLED_KINDS_ENV,
  __resetEnabledPromptKindsCacheForTests,
  enabledPromptKinds,
  parseEnabledPromptKinds,
} from './promptHostConfig';

// #10190 (plan P4, spec §3.1 rule 2): the server kill switch for prompt kinds.
// A stand-in default makes "unset -> default" and "'' -> kill switch"
// distinguishable while the shipped default is still empty (until W09).
const STAND_IN_DEFAULT = ['notice.info', 'restart.prompt@1'] as const;

let warn: MockInstance;
const originalEnv = process.env.PROMPT_HOST_ENABLED_KINDS;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  __resetEnabledPromptKindsCacheForTests();
});

afterEach(() => {
  warn.mockRestore();
  if (originalEnv === undefined) delete process.env.PROMPT_HOST_ENABLED_KINDS;
  else process.env.PROMPT_HOST_ENABLED_KINDS = originalEnv;
});

describe('DEFAULT_ENABLED_PROMPT_KINDS', () => {
  it('is empty in W02: the contract ships dormant (W09 flips it)', () => {
    expect(DEFAULT_ENABLED_PROMPT_KINDS).toEqual([]);
    expect(Object.isFrozen(DEFAULT_ENABLED_PROMPT_KINDS)).toBe(true);
  });

  it('names the env var the operator sets', () => {
    expect(PROMPT_HOST_ENABLED_KINDS_ENV).toBe('PROMPT_HOST_ENABLED_KINDS');
  });
});

describe('parseEnabledPromptKinds', () => {
  it.each([
    ['unset', undefined, [...STAND_IN_DEFAULT]],
    ['the literal "default" (how compose carries "unset")', 'default', [...STAND_IN_DEFAULT]],
    ['"default" with whitespace', '  default  ', [...STAND_IN_DEFAULT]],
    ['empty string (the kill switch)', '', []],
    ['whitespace only (the kill switch)', '   \t ', []],
    ['one bare kind', 'notice.info', ['notice.info']],
    ['a kind@n entry', 'restart.prompt@1', ['restart.prompt@1']],
    ['a mixed list, trimmed', ' notice.info , remote.consent@2 ,elevation.request', ['notice.info', 'remote.consent@2', 'elevation.request']],
    ['empty segments are ignored', ',notice.info,,', ['notice.info']],
    ['exact duplicates collapse, first order kept', 'remote.session,notice.info,remote.session, notice.info', ['remote.session', 'notice.info']],
    ['duplicate kind@n collapse', 'restart.final@3,restart.final@3', ['restart.final@3']],
    ['bare kind and kind@n are distinct entries', 'notice.info,notice.info@1', ['notice.info', 'notice.info@1']],
    ['every registered kind', PROMPT_KIND_NAMES.join(','), [...PROMPT_KIND_NAMES]],
  ])('%s', (_label, raw, expected) => {
    expect(parseEnabledPromptKinds(raw, STAND_IN_DEFAULT)).toEqual(expected);
  });

  it.each([
    ['an unknown kind', 'bogus.kind'],
    ['a kind outside the registry that looks valid', 'notice.warning@1'],
    ['version 0', 'notice.info@0'],
    ['a non-numeric version', 'notice.info@x'],
    ['a four-digit version', 'notice.info@1000'],
    ['an empty version', 'notice.info@'],
    ['upper case', 'Notice.Info'],
    ['no namespace', 'notice'],
    ['a negative version', 'notice.info@-1'],
    ['two versions', 'notice.info@1@2'],
    ['a leading-zero version (the shared kind-ad pattern)', 'notice.info@01'],
  ])('drops %s', (_label, entry) => {
    expect(parseEnabledPromptKinds(`${entry},notice.info`, STAND_IN_DEFAULT)).toEqual(['notice.info']);
    expect(parseEnabledPromptKinds(entry, STAND_IN_DEFAULT)).toEqual([]);
  });

  it('a list of only invalid entries is empty, not the default', () => {
    expect(parseEnabledPromptKinds('bogus.kind,notice.info@0', STAND_IN_DEFAULT)).toEqual([]);
  });

  it('defaults to DEFAULT_ENABLED_PROMPT_KINDS when no stand-in is given', () => {
    expect(parseEnabledPromptKinds(undefined)).toEqual([...DEFAULT_ENABLED_PROMPT_KINDS]);
  });

  it('returns a fresh array (callers cannot mutate the default)', () => {
    const out = parseEnabledPromptKinds(undefined, STAND_IN_DEFAULT);
    out.push('remote.consent');
    expect(parseEnabledPromptKinds(undefined, STAND_IN_DEFAULT)).toEqual([...STAND_IN_DEFAULT]);
  });

  it('warns exactly once per parse, naming every dropped entry', () => {
    parseEnabledPromptKinds('bogus.kind,notice.info,notice.info@0,notice.info@x', STAND_IN_DEFAULT);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('PROMPT_HOST_ENABLED_KINDS');
    for (const dropped of ['bogus.kind', 'notice.info@0', 'notice.info@x']) expect(message).toContain(dropped);
  });

  it('does not warn for a clean list, the kill switch, or unset', () => {
    parseEnabledPromptKinds('notice.info, restart.prompt@1,', STAND_IN_DEFAULT);
    parseEnabledPromptKinds('', STAND_IN_DEFAULT);
    parseEnabledPromptKinds(undefined, STAND_IN_DEFAULT);
    parseEnabledPromptKinds('default', STAND_IN_DEFAULT);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('enabledPromptKinds (reads PROMPT_HOST_ENABLED_KINDS)', () => {
  it('unset gives the code default', () => {
    delete process.env.PROMPT_HOST_ENABLED_KINDS;
    expect(enabledPromptKinds()).toEqual([...DEFAULT_ENABLED_PROMPT_KINDS]);
  });

  it('empty string gives nothing (kill switch)', () => {
    process.env.PROMPT_HOST_ENABLED_KINDS = '';
    expect(enabledPromptKinds()).toEqual([]);
  });

  it('a list is parsed', () => {
    process.env.PROMPT_HOST_ENABLED_KINDS = 'notice.info,restart.prompt@1';
    expect(enabledPromptKinds()).toEqual(['notice.info', 'restart.prompt@1']);
  });

  it('parses once per value: a bad entry warns once, not once per heartbeat', () => {
    process.env.PROMPT_HOST_ENABLED_KINDS = 'notice.info,bogus.kind';
    for (let i = 0; i < 5; i += 1) expect(enabledPromptKinds()).toEqual(['notice.info']);
    expect(warn).toHaveBeenCalledTimes(1);

    // A changed value (an operator flip without a restart, or a test) re-parses.
    process.env.PROMPT_HOST_ENABLED_KINDS = 'remote.consent,also.bogus';
    expect(enabledPromptKinds()).toEqual(['remote.consent']);
    expect(enabledPromptKinds()).toEqual(['remote.consent']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('the cached value cannot be mutated by a caller', () => {
    process.env.PROMPT_HOST_ENABLED_KINDS = 'notice.info';
    const first = enabledPromptKinds();
    expect(Object.isFrozen(first)).toBe(true);
    expect(enabledPromptKinds()).toEqual(['notice.info']);
  });
});
