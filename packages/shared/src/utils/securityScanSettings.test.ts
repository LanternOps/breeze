import { describe, it, expect } from 'vitest';
import {
  SECURITY_SCAN_SETTINGS_DEFAULTS,
  parseSecurityScanSettings,
  securityScanCron,
} from './securityScanSettings';
import { YARA_MAX_RULE_SETS_PER_POLICY } from '../types/yara';

describe('parseSecurityScanSettings', () => {
  it('returns defaults for a non-object', () => {
    expect(parseSecurityScanSettings(null)).toEqual(SECURITY_SCAN_SETTINGS_DEFAULTS);
    expect(parseSecurityScanSettings('nope')).toEqual(SECURITY_SCAN_SETTINGS_DEFAULTS);
  });

  it('drops the five removed toggles instead of carrying them through', () => {
    const parsed = parseSecurityScanSettings({
      realTimeProtection: true,
      behavioralMonitoring: true,
      cloudLookup: true,
      blockUntrustedUsb: true,
      notifyUser: true,
      autoQuarantine: false,
    });
    expect(parsed).not.toHaveProperty('realTimeProtection');
    expect(parsed).not.toHaveProperty('behavioralMonitoring');
    expect(parsed).not.toHaveProperty('cloudLookup');
    expect(parsed).not.toHaveProperty('blockUntrustedUsb');
    expect(parsed).not.toHaveProperty('notifyUser');
    expect(parsed.autoQuarantine).toBe(false);
  });

  it('clamps the numeric fields into range and coerces strings', () => {
    expect(parseSecurityScanSettings({ maxFileSizeMb: 0 }).maxFileSizeMb).toBe(1);
    expect(parseSecurityScanSettings({ maxFileSizeMb: 9999 }).maxFileSizeMb).toBe(512);
    expect(parseSecurityScanSettings({ maxFileSizeMb: '64' }).maxFileSizeMb).toBe(64);
    expect(parseSecurityScanSettings({ maxFileSizeMb: 'abc' }).maxFileSizeMb)
      .toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.maxFileSizeMb);
    expect(parseSecurityScanSettings({ scanTimeoutMinutes: 1 }).scanTimeoutMinutes).toBe(5);
    expect(parseSecurityScanSettings({ scanTimeoutMinutes: 5000 }).scanTimeoutMinutes).toBe(720);
  });

  it('keeps only string exclusions, trims them, and drops blanks and duplicates', () => {
    expect(parseSecurityScanSettings({
      exclusions: ['C:\\Backups', ' C:\\Backups ', '', 7, null, 'D:\\VMs'],
    }).exclusions).toEqual(['C:\\Backups', 'D:\\VMs']);
  });

  it('falls back to the default scan type for an unknown value', () => {
    expect(parseSecurityScanSettings({ scanType: 'custom' }).scanType).toBe('quick');
    expect(parseSecurityScanSettings({ scanType: 'full' }).scanType).toBe('full');
  });

  it('rejects cron field values it did not offer', () => {
    const parsed = parseSecurityScanSettings({ scanMinute: '7', scanHour: '23', scanDayOfWeek: 'Tue' });
    expect(parsed.scanMinute).toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.scanMinute);
    expect(parsed.scanHour).toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.scanHour);
    expect(parsed.scanDayOfWeek).toBe(SECURITY_SCAN_SETTINGS_DEFAULTS.scanDayOfWeek);
  });
});

describe('parseSecurityScanSettings ruleSetIds (#6263 W03)', () => {
  const A = '6f1d2c3b-0000-4000-8000-0000000000a1';
  const B = '6f1d2c3b-0000-4000-8000-0000000000b2';

  it('defaults to an empty list (empty = legacy scan, DECISION W03-e)', () => {
    expect(SECURITY_SCAN_SETTINGS_DEFAULTS.ruleSetIds).toEqual([]);
    expect(parseSecurityScanSettings({}).ruleSetIds).toEqual([]);
    expect(parseSecurityScanSettings({ ruleSetIds: 'nope' }).ruleSetIds).toEqual([]);
  });

  it('drops non-UUIDs and duplicates, lower-cases, and keeps first-seen order', () => {
    expect(parseSecurityScanSettings({
      ruleSetIds: [B.toUpperCase(), 'not-a-uuid', 42, A, B, ` ${A} `, null],
    }).ruleSetIds).toEqual([B, A]);
  });

  it(`truncates to ${YARA_MAX_RULE_SETS_PER_POLICY} entries`, () => {
    const ids = Array.from({ length: 25 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const parsed = parseSecurityScanSettings({ ruleSetIds: ids }).ruleSetIds;
    expect(parsed).toHaveLength(YARA_MAX_RULE_SETS_PER_POLICY);
    expect(parsed).toEqual(ids.slice(0, YARA_MAX_RULE_SETS_PER_POLICY));
  });

  it('never shares the defaults array with a parsed result', () => {
    const parsed = parseSecurityScanSettings(null);
    parsed.ruleSetIds.push(A);
    expect(SECURITY_SCAN_SETTINGS_DEFAULTS.ruleSetIds).toEqual([]);
  });
});

describe('securityScanCron', () => {
  it('is null when scheduling is off', () => {
    expect(securityScanCron({ ...SECURITY_SCAN_SETTINGS_DEFAULTS, scheduledScans: false })).toBeNull();
  });

  it('emits five fields in minute hour dom month dow order', () => {
    expect(securityScanCron({
      ...SECURITY_SCAN_SETTINGS_DEFAULTS,
      scheduledScans: true,
      scanMinute: '30',
      scanHour: '2',
      scanDayOfMonth: '*',
      scanDayOfWeek: '1',
    })).toBe('30 2 * * 1');
  });
});
