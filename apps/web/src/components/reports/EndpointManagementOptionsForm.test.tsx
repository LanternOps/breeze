import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS,
  endpointManagementOptionsFromConfig,
} from './EndpointManagementOptionsForm';

// endpointManagementOptionsFromConfig reads a persisted report `config` back
// into option state for the edit page. It must never hand the number inputs an
// out-of-range or non-numeric value (the inputs enforce their own min/max, but
// a stored config can predate the clamp or be hand-edited), and must treat the
// licence toggle as "on unless explicitly false".
describe('endpointManagementOptionsFromConfig', () => {
  it('clamps a stored 0 up to the minimum of 1', () => {
    expect(endpointManagementOptionsFromConfig({ staleEnrolmentDays: 0 }).staleEnrolmentDays).toBe(1);
    expect(endpointManagementOptionsFromConfig({ trendDays: 0 }).trendDays).toBe(1);
  });

  it('clamps each field down to its OWN maximum, which differ', () => {
    expect(endpointManagementOptionsFromConfig({ staleEnrolmentDays: 500 }).staleEnrolmentDays).toBe(180);
    expect(endpointManagementOptionsFromConfig({ trendDays: 500 }).trendDays).toBe(365);
  });

  it('falls back to the default for a non-number value like the string "30" — no coercion', () => {
    expect(endpointManagementOptionsFromConfig({ staleEnrolmentDays: '30' }).staleEnrolmentDays)
      .toBe(DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS.staleEnrolmentDays);
    expect(endpointManagementOptionsFromConfig({ trendDays: '90' }).trendDays)
      .toBe(DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS.trendDays);
  });

  it('treats the licence toggle as on unless explicitly false', () => {
    expect(endpointManagementOptionsFromConfig({}).includeLicences).toBe(true);
    expect(endpointManagementOptionsFromConfig({ includeLicences: undefined }).includeLicences).toBe(true);
    expect(endpointManagementOptionsFromConfig({ includeLicences: false }).includeLicences).toBe(false);
  });

  it('round-trips the registry default config unchanged', () => {
    expect(endpointManagementOptionsFromConfig({
      sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true,
    })).toEqual(DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS);
  });
});
