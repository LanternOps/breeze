import { describe, expect, it } from 'vitest';
import { ADMISSION_DEFAULTS, resolveAdmissionConfig } from './admissionConfig';

describe('resolveAdmissionConfig', () => {
  it('defaults to observe with the documented thresholds', () => {
    const { config, warnings } = resolveAdmissionConfig({});
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      mode: 'observe',
      lagMs: [200, 250, 600],
      dbWaitMs: [150, 200, 600],
      emergencyMs: 1_000,
      riseTicks: 3,
      level1HoldMs: 5_000,
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
      BREEZE_ADMISSION_RISE_TICKS: '2',
      BREEZE_ADMISSION_LEVEL1_HOLD_MS: '15000',
      BREEZE_ADMISSION_BULK_MAX_IN_FLIGHT: '6',
      BREEZE_ADMISSION_WS_RATE_PER_SEC: '2.5',
      BREEZE_ADMISSION_WS_BURST: '5',
      BREEZE_ADMISSION_WS_MAX_SETUPS: '3',
    });
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      mode: 'enforce', lagMs: [80, 200, 500], dbWaitMs: [50, 150, 400], emergencyMs: 800,
      riseTicks: 2, level1HoldMs: 15_000, bulkMaxInFlight: 6, wsRatePerSec: 2.5, wsBurst: 5, wsMaxSetups: 3,
    });
  });

  it.each([
    ['BREEZE_ADMISSION_MODE', 'shed-everything', 'mode'],
    ['BREEZE_ADMISSION_LAG_MS', '300,200,600', 'lagMs'],
    ['BREEZE_ADMISSION_LAG_MS', '100,250', 'lagMs'],
    ['BREEZE_ADMISSION_DB_WAIT_MS', '0,200,600', 'dbWaitMs'],
    ['BREEZE_ADMISSION_EMERGENCY_MS', '-5', 'emergencyMs'],
    ['BREEZE_ADMISSION_RISE_TICKS', '0', 'riseTicks'],
    ['BREEZE_ADMISSION_RISE_TICKS', '11', 'riseTicks'],
    ['BREEZE_ADMISSION_RISE_TICKS', '2.5', 'riseTicks'],
    ['BREEZE_ADMISSION_LEVEL1_HOLD_MS', '999', 'level1HoldMs'],
    ['BREEZE_ADMISSION_LEVEL1_HOLD_MS', '60001', 'level1HoldMs'],
    ['BREEZE_ADMISSION_LEVEL1_HOLD_MS', '1500.5', 'level1HoldMs'],
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

  it.each([
    ['BREEZE_ADMISSION_RISE_TICKS', '1', 'riseTicks', 1],
    ['BREEZE_ADMISSION_RISE_TICKS', '10', 'riseTicks', 10],
    ['BREEZE_ADMISSION_LEVEL1_HOLD_MS', '1000', 'level1HoldMs', 1_000],
    ['BREEZE_ADMISSION_LEVEL1_HOLD_MS', '60000', 'level1HoldMs', 60_000],
  ] as const)('%s=%s is accepted at the edge of its bounds', (name, value, key, expected) => {
    const { config, warnings } = resolveAdmissionConfig({ [name]: value });
    expect(warnings).toEqual([]);
    expect(config[key]).toBe(expected);
  });
});
