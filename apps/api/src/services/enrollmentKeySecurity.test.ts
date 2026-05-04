import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { hashEnrollmentKey } from './enrollmentKeySecurity';

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  ENROLLMENT_KEY_PEPPER: process.env.ENROLLMENT_KEY_PEPPER,
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
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
