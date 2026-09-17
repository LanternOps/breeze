import { describe, expect, it } from 'vitest';
import { fillDevicePlaceholders, interpolateAlertTemplate, resolveAlertTitle } from './alertTemplate';

describe('interpolateAlertTemplate', () => {
  it('substitutes a named token from context', () => {
    expect(
      interpolateAlertTemplate('{{deviceName}} is offline', { deviceName: 'DESKTOP-8UG65K6' }),
    ).toBe('DESKTOP-8UG65K6 is offline');
  });

  it('fills {{device}} from deviceName so titles do not leak the placeholder', () => {
    expect(
      interpolateAlertTemplate('{{device}} offline', { deviceName: 'DESKTOP-8UG65K6' }),
    ).toBe('DESKTOP-8UG65K6 offline');
  });

  it('fills {{device}} from hostname when deviceName is missing', () => {
    expect(
      interpolateAlertTemplate('{{device}} offline', { hostname: 'KHPC' }),
    ).toBe('KHPC offline');
  });

  it('fills {{deviceName}} from hostname when deviceName is blank', () => {
    expect(
      interpolateAlertTemplate('{{deviceName}} is offline', { deviceName: '', hostname: 'FRONTDESK-1' }),
    ).toBe('FRONTDESK-1 is offline');
  });

  it('leaves unknown tokens unchanged', () => {
    expect(interpolateAlertTemplate('CPU {{metric}} high', { deviceName: 'HOST' })).toBe(
      'CPU {{metric}} high',
    );
  });

  it('does not re-scan substituted values', () => {
    expect(
      interpolateAlertTemplate('{{deviceName}}', { deviceName: '{{hostname}}', hostname: 'NO' }),
    ).toBe('{{hostname}}');
  });
});

describe('fillDevicePlaceholders', () => {
  it('fills leftover {{device}} from the device label', () => {
    expect(fillDevicePlaceholders('{{device}} offline', 'DESKTOP-8UG65K6')).toBe(
      'DESKTOP-8UG65K6 offline',
    );
  });

  it('passes through copy with no tokens', () => {
    expect(fillDevicePlaceholders('Disk almost full', 'HOST')).toBe('Disk almost full');
  });
});

describe('resolveAlertTitle', () => {
  it('uses the fallback when the title is blank', () => {
    expect(resolveAlertTitle('  ', 'HOST', 'Alert')).toBe('Alert');
  });
});

