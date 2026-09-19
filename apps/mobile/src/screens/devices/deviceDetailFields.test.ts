import { describe, expect, it } from 'vitest';

import { formatCountLabel, formatDetailValue, formatIpValue, formatOsVersionValue } from './deviceDetailFields';

// #5140: Device Details v1 fields (decision #5117-2) — pure formatting rules
// so DeviceDetailScreen's render logic stays a straight prop-to-JSX mapping.
// "Empty values render '—', never blank" per the decision doc.

describe('formatDetailValue', () => {
  it('returns the value unchanged when present', () => {
    expect(formatDetailValue('jdoe')).toBe('jdoe');
  });

  it('returns an em dash for null', () => {
    expect(formatDetailValue(null)).toBe('—');
  });

  it('returns an em dash for undefined', () => {
    expect(formatDetailValue(undefined)).toBe('—');
  });

  it('returns an em dash for an empty/whitespace string', () => {
    expect(formatDetailValue('   ')).toBe('—');
  });
});

describe('formatIpValue', () => {
  it('shows just the LAN IP when there is no public IP', () => {
    expect(formatIpValue('10.0.0.5', null)).toBe('10.0.0.5');
  });

  it('puts the public IP on a second line when present', () => {
    expect(formatIpValue('10.0.0.5', '203.0.113.9')).toBe('10.0.0.5\n203.0.113.9');
  });

  it('em-dashes the LAN line when absent, but still appends a present public IP', () => {
    expect(formatIpValue(null, '203.0.113.9')).toBe('—\n203.0.113.9');
  });

  it('em-dashes when neither is present', () => {
    expect(formatIpValue(null, null)).toBe('—');
  });
});

describe('formatOsVersionValue', () => {
  it('appends the version next to the OS label when present', () => {
    expect(formatOsVersionValue('Linux', '22.04')).toBe('Linux · 22.04');
  });

  it('falls back to the bare OS label when no version is known', () => {
    expect(formatOsVersionValue('Linux', null)).toBe('Linux');
  });

  it('falls back to the bare OS label for a blank version string', () => {
    expect(formatOsVersionValue('Linux', '  ')).toBe('Linux');
  });
});

describe('formatCountLabel', () => {
  it('renders a real zero as a zero, not an em dash', () => {
    expect(formatCountLabel('Open alerts', 0)).toBe('Open alerts · 0');
  });

  it('renders a positive count', () => {
    expect(formatCountLabel('Open tickets', 4)).toBe('Open tickets · 4');
  });

  it('em-dashes a genuinely absent (undefined) count', () => {
    expect(formatCountLabel('Open alerts', undefined)).toBe('Open alerts · —');
  });

  it('em-dashes a null count', () => {
    expect(formatCountLabel('Open tickets', null)).toBe('Open tickets · —');
  });
});
