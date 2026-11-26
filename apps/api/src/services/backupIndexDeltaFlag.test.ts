import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveDeltaPublishSetting,
  resolveDeltaPublishMode,
  resetDeltaPublishFlagWarningsForTests,
  BACKUP_INDEX_DELTA_PUBLISH_ENV,
  BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS_ENV,
} from './backupIndexDeltaFlag';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const E = BACKUP_INDEX_DELTA_PUBLISH_ENV;
const L = BACKUP_INDEX_DELTA_PUBLISH_ORG_IDS_ENV;

describe('backupIndexDeltaFlag', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetDeltaPublishFlagWarningsForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe('setting', () => {
    it('is off when unset', () => {
      expect(resolveDeltaPublishSetting({})).toBe('off');
      expect(resolveDeltaPublishMode(ORG_A, {})).toBe('rows');
      expect(warn).not.toHaveBeenCalled();
    });

    it('is off silently when empty or whitespace', () => {
      expect(resolveDeltaPublishSetting({ [E]: '' })).toBe('off');
      expect(resolveDeltaPublishSetting({ [E]: '   ' })).toBe('off');
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['off', 'canary', 'on'] as const)('accepts %s', (v) => {
      expect(resolveDeltaPublishSetting({ [E]: v })).toBe(v);
      expect(warn).not.toHaveBeenCalled();
    });

    it('trims and ignores case', () => {
      expect(resolveDeltaPublishSetting({ [E]: '  On ' })).toBe('on');
      expect(resolveDeltaPublishSetting({ [E]: 'CANARY' })).toBe('canary');
      expect(warn).not.toHaveBeenCalled();
    });

    it('treats an unknown value as off and warns once per distinct value', () => {
      expect(resolveDeltaPublishSetting({ [E]: 'yes' })).toBe('off');
      expect(resolveDeltaPublishSetting({ [E]: 'yes' })).toBe('off');
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain(E);
      expect(msg).toContain('"yes"');
      expect(msg).toContain('off');
      expect(resolveDeltaPublishSetting({ [E]: 'maybe' })).toBe('off');
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('truncates a long unknown value in the warning', () => {
      resolveDeltaPublishSetting({ [E]: 'x'.repeat(500) });
      expect(String(warn.mock.calls[0][0]).length).toBeLessThan(300);
    });
  });

  describe('canary org list', () => {
    const canary = (list?: string) => ({
      [E]: 'canary',
      ...(list === undefined ? {} : { [L]: list }),
    });

    it('publishes delta for a listed org and rows for others', () => {
      const env = canary(`${ORG_A},${ORG_B}`);
      expect(resolveDeltaPublishMode(ORG_A, env)).toBe('delta');
      expect(resolveDeltaPublishMode(ORG_B, env)).toBe('delta');
      expect(resolveDeltaPublishMode(ORG_C, env)).toBe('rows');
    });

    it('is rows for an empty or unset list', () => {
      expect(resolveDeltaPublishMode(ORG_A, canary(''))).toBe('rows');
      expect(resolveDeltaPublishMode(ORG_A, canary())).toBe('rows');
      expect(warn).not.toHaveBeenCalled();
    });

    it('tolerates spaces and empty items', () => {
      const env = canary(` ${ORG_A} , ,${ORG_B},`);
      expect(resolveDeltaPublishMode(ORG_A, env)).toBe('delta');
      expect(resolveDeltaPublishMode(ORG_B, env)).toBe('delta');
      expect(warn).not.toHaveBeenCalled();
    });

    it('ignores a bad uuid with one warning and still matches valid ones', () => {
      const env = canary(`not-a-uuid,${ORG_A}`);
      expect(resolveDeltaPublishMode(ORG_A, env)).toBe('delta');
      expect(resolveDeltaPublishMode(ORG_A, env)).toBe('delta');
      expect(resolveDeltaPublishMode('not-a-uuid', env)).toBe('rows');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(L);
      expect(String(warn.mock.calls[0][0])).toContain('not-a-uuid');
    });

    it('compares case-insensitively', () => {
      expect(resolveDeltaPublishMode(ORG_C, canary(ORG_C.toUpperCase()))).toBe('delta');
      expect(resolveDeltaPublishMode(ORG_C.toUpperCase(), canary(ORG_C))).toBe('delta');
    });
  });

  it('on ignores the list', () => {
    expect(resolveDeltaPublishMode(ORG_A, { [E]: 'on' })).toBe('delta');
    expect(resolveDeltaPublishMode(ORG_A, { [E]: 'on', [L]: ORG_B })).toBe('delta');
  });

  it('off ignores the list', () => {
    expect(resolveDeltaPublishMode(ORG_A, { [E]: 'off', [L]: ORG_A })).toBe('rows');
  });

  it('reads process.env at call time by default', () => {
    const prev = process.env[E];
    try {
      process.env[E] = 'on';
      expect(resolveDeltaPublishMode(ORG_A)).toBe('delta');
      process.env[E] = 'off';
      expect(resolveDeltaPublishMode(ORG_A)).toBe('rows');
    } finally {
      if (prev === undefined) delete process.env[E];
      else process.env[E] = prev;
    }
  });
});
