import { describe, expect, it } from 'vitest';
import { ADMISSION_DEFAULTS, resolveAdmissionConfig } from './admissionConfig';

describe('resolveAdmissionConfig', () => {
  it('defaults to observe with the documented thresholds', () => {
    const { config, warnings } = resolveAdmissionConfig({});
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      mode: 'observe',
      lagMs: [100, 250, 600],
      dbWaitMs: [75, 200, 600],
      emergencyMs: 1_000,
      bulkMaxInFlight: 15,
      wsRatePerSec: 10,
      wsBurst: 20,
      wsMaxSetups: 8,
    });
    expect(config).toEqual(ADMISSION_DEFAULTS);
  });

  it('treats empty strings (compose ${VAR:-}) as unset', () => {
    const { config, warnings } = resolveAdmissionConfig({
      BREEZE_ADMISSION_MODE: '',
      BREEZE_ADMISSION_LAG_MS: '',
      BREEZE_ADMISSION_WS_BURST: '',
    });
    expect(warnings).toEqual([]);
    expect(config).toEqual(ADMISSION_DEFAULTS);
  });

  it('parses every knob', () => {
    const { config, warnings } = resolveAdmissionConfig({
      BREEZE_ADMISSION_MODE: ' Enforce ',
      BREEZE_ADMISSION_LAG_MS: '80, 200 ,500',
      BREEZE_ADMISSION_DB_WAIT_MS: '50,150,400',
      BREEZE_ADMISSION_EMERGENCY_MS: '800',
      BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT: '6',
      BREEZE_ADMISSION_WS_RATE_PER_SEC: '2.5',
      BREEZE_ADMISSION_WS_BURST: '5',
      BREEZE_ADMISSION_WS_MAX_SETUPS: '3',
    });
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      mode: 'enforce', lagMs: [80, 200, 500], dbWaitMs: [50, 150, 400], emergencyMs: 800,
      bulkMaxInFlight: 6, wsRatePerSec: 2.5, wsBurst: 5, wsMaxSetups: 3,
    });
  });

  it.each([
    ['BREEZE_ADMISSION_MODE', 'shed-everything', 'mode'],
    ['BREEZE_ADMISSION_LAG_MS', '300,200,600', 'lagMs'],
    ['BREEZE_ADMISSION_LAG_MS', '100,250', 'lagMs'],
    ['BREEZE_ADMISSION_DB_WAIT_MS', '0,200,600', 'dbWaitMs'],
    ['BREEZE_ADMISSION_EMERGENCY_MS', '-5', 'emergencyMs'],
    ['BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT', '2.5', 'bulkMaxInFlight'],
    ['BREEZE_ADMISSION_WS_RATE_PER_SEC', '0', 'wsRatePerSec'],
    ['BREEZE_ADMISSION_WS_BURST', 'lots', 'wsBurst'],
    ['BREEZE_ADMISSION_WS_MAX_SETUPS', '0', 'wsMaxSetups'],
  ] as const)('%s=%s falls back to the default with a warning', (name, value, key) => {
    const { config, warnings } = resolveAdmissionConfig({ [name]: value });
    expect(config[key]).toEqual(ADMISSION_DEFAULTS[key]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(name);
  });
});
