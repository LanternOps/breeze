import { describe, expect, it } from 'vitest';
import { fillStoredAlertCopy } from './alertCopy';

describe('fillStoredAlertCopy', () => {
  it('fills {{device}} from the joined hostname', () => {
    const filled = fillStoredAlertCopy({
      title: '{{device}} offline',
      message: '{{deviceName}} has been offline',
      deviceHostname: 'DESKTOP-8UG65K6',
      context: null,
    });
    expect(filled.title).toBe('DESKTOP-8UG65K6 offline');
    expect(filled.message).toBe('DESKTOP-8UG65K6 has been offline');
  });

  it('prefers a stored deviceName over the hostname join', () => {
    const filled = fillStoredAlertCopy({
      title: '{{device}} offline',
      deviceHostname: 'HOST-1',
      context: { deviceName: 'Front desk' },
    });
    expect(filled.title).toBe('Front desk offline');
  });

  it('leaves a fully interpolated title alone', () => {
    const filled = fillStoredAlertCopy({
      title: 'HOST-1 is offline',
      deviceHostname: 'HOST-1',
      context: null,
    });
    expect(filled.title).toBe('HOST-1 is offline');
  });

  it('prefers an explicit deviceLabel over the hostname join', () => {
    const filled = fillStoredAlertCopy({
      title: '{{device}} offline',
      deviceHostname: 'DESKTOP-8UG65K6',
      context: null,
    }, 'Front desk');
    expect(filled.title).toBe('Front desk offline');
  });
});
