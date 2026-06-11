import { describe, it, expect } from 'vitest';
import {
  MOBILE_DEVICE_ID_HEADER,
  normalizeDeviceId,
  readMobileDeviceId,
  carryForwardBinding,
} from './mobileDeviceBinding';

describe('mobileDeviceBinding helpers (SR-001)', () => {
  describe('normalizeDeviceId', () => {
    it('returns null for empty / whitespace / missing', () => {
      expect(normalizeDeviceId(undefined)).toBeNull();
      expect(normalizeDeviceId(null)).toBeNull();
      expect(normalizeDeviceId('')).toBeNull();
      expect(normalizeDeviceId('   ')).toBeNull();
    });
    it('trims and returns a valid id', () => {
      expect(normalizeDeviceId('  install-123  ')).toBe('install-123');
    });
    it('rejects ids longer than 255 chars', () => {
      expect(normalizeDeviceId('a'.repeat(256))).toBeNull();
      expect(normalizeDeviceId('a'.repeat(255))).toBe('a'.repeat(255));
    });
  });

  describe('readMobileDeviceId', () => {
    const ctx = (headers: Record<string, string>) =>
      ({ req: { header: (k: string) => headers[k] ?? headers[k.toUpperCase()] } }) as never;

    it('reads the lowercase header', () => {
      expect(readMobileDeviceId(ctx({ [MOBILE_DEVICE_ID_HEADER]: 'dev-1' }))).toBe('dev-1');
    });
    it('returns null when header absent', () => {
      expect(readMobileDeviceId(ctx({}))).toBeNull();
    });
  });

  describe('carryForwardBinding', () => {
    it('preserves a prior token binding (refresh keeps the device bound)', () => {
      expect(carryForwardBinding({ mdid: 'install-123' })).toBe('install-123');
    });
    it('returns undefined when the prior token was not bound', () => {
      expect(carryForwardBinding({})).toBeUndefined();
      expect(carryForwardBinding({ mdid: '' })).toBeUndefined();
    });
    it('ignores everything except the prior mdid — a refresh cannot introduce a new binding', () => {
      // Only the previously-signed value matters; there is no header input here
      // by design, so an attacker cannot un-bind by omitting a header on refresh.
      expect(carryForwardBinding({ mdid: 'bound-old' })).toBe('bound-old');
    });
  });
});
