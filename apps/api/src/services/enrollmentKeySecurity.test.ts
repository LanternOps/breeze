import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { hashEnrollmentKey, getDefaultEnrollmentKeyTtlMinutes } from './enrollmentKeySecurity';

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  ENROLLMENT_KEY_PEPPER: process.env.ENROLLMENT_KEY_PEPPER,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
  ENROLLMENT_KEY_DEFAULT_TTL_MINUTES: process.env.ENROLLMENT_KEY_DEFAULT_TTL_MINUTES,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('enrollment key peppering', () => {
  afterEach(restoreEnv);

  it('uses only ENROLLMENT_KEY_PEPPER for enrollment key hashes', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENROLLMENT_KEY_PEPPER = 'dedicated-enrollment-pepper-32-chars';
    process.env.APP_ENCRYPTION_KEY = 'app-key-must-not-be-used';
    process.env.SECRET_ENCRYPTION_KEY = 'secret-key-must-not-be-used';
    process.env.JWT_SECRET = 'jwt-key-must-not-be-used';

    expect(hashEnrollmentKey('raw-key')).toBe(
      createHash('sha256')
        .update('dedicated-enrollment-pepper-32-chars:raw-key')
        .digest('hex')
    );
  });

  it('does not fall back to app, secret, or JWT keys when the pepper is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ENROLLMENT_KEY_PEPPER;
    process.env.APP_ENCRYPTION_KEY = 'app-key-must-not-be-used';
    process.env.SECRET_ENCRYPTION_KEY = 'secret-key-must-not-be-used';
    process.env.JWT_SECRET = 'jwt-key-must-not-be-used';

    expect(() => hashEnrollmentKey('raw-key')).toThrow('ENROLLMENT_KEY_PEPPER');
  });
});

// #4126 follow-up: the human "Add Device" create route
// (routes/enrollmentKeys.ts) raised its no-env-set fallback to 43200 minutes
// (30 days), but this Partner-API provisioning helper was missed and stayed
// at 60 — a self-hoster who sets neither env var got 30-day keys from Add
// Device but 1-hour keys from partner-API provisioning.
describe('getDefaultEnrollmentKeyTtlMinutes', () => {
  afterEach(restoreEnv);

  it('falls back to 43200 minutes (30 days) — matching the human route — when the env var is unset', () => {
    delete process.env.ENROLLMENT_KEY_DEFAULT_TTL_MINUTES;
    expect(getDefaultEnrollmentKeyTtlMinutes()).toBe(43200);
  });

  it('falls back to 43200 when the env var is set to an empty string (compose renders unset as "")', () => {
    process.env.ENROLLMENT_KEY_DEFAULT_TTL_MINUTES = '';
    expect(getDefaultEnrollmentKeyTtlMinutes()).toBe(43200);
  });

  it('falls back to 43200 when the env var is unparsable', () => {
    process.env.ENROLLMENT_KEY_DEFAULT_TTL_MINUTES = 'not-a-number';
    expect(getDefaultEnrollmentKeyTtlMinutes()).toBe(43200);
  });

  it('still honors an explicit ENROLLMENT_KEY_DEFAULT_TTL_MINUTES override', () => {
    process.env.ENROLLMENT_KEY_DEFAULT_TTL_MINUTES = '120';
    expect(getDefaultEnrollmentKeyTtlMinutes()).toBe(120);
  });
});
