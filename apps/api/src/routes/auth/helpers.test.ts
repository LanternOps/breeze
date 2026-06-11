import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { getAllowedOrigins, hashRecoveryCode, userRequiresSetup } from './helpers';

describe('getAllowedOrigins (G5 — dev-origin gating)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;
  const originalIncludeFlag = process.env.CORS_INCLUDE_DEFAULT_ORIGINS;

  beforeEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.CORS_INCLUDE_DEFAULT_ORIGINS;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalCorsOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
    if (originalIncludeFlag === undefined) delete process.env.CORS_INCLUDE_DEFAULT_ORIGINS;
    else process.env.CORS_INCLUDE_DEFAULT_ORIGINS = originalIncludeFlag;
  });

  it('includes localhost dev origins in development', () => {
    process.env.NODE_ENV = 'development';
    const origins = getAllowedOrigins();
    expect(origins.has('http://localhost:4321')).toBe(true);
    expect(origins.has('http://127.0.0.1:4321')).toBe(true);
  });

  it('does NOT include localhost dev origins in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

    const origins = getAllowedOrigins();

    expect(origins.has('http://localhost:4321')).toBe(false);
    expect(origins.has('http://127.0.0.1:4321')).toBe(false);
    expect(origins.has('http://localhost:1420')).toBe(false);
    expect(origins.has('https://app.example.com')).toBe(true);
  });

  it('allows explicit opt-in via CORS_INCLUDE_DEFAULT_ORIGINS=true in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_INCLUDE_DEFAULT_ORIGINS = 'true';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com';

    const origins = getAllowedOrigins();

    expect(origins.has('http://localhost:4321')).toBe(true);
    expect(origins.has('https://app.example.com')).toBe(true);
  });
});

describe('userRequiresSetup', () => {
  it('requires setup for the legacy development bootstrap admin until setup is completed', () => {
    expect(
      userRequiresSetup({
        email: 'admin@breeze.local',
        setupCompletedAt: null,
      }),
    ).toBe(true);
  });

  it('requires setup for operator-provided bootstrap admins marked during seed', () => {
    expect(
      userRequiresSetup({
        email: 'owner@example.test',
        setupCompletedAt: null,
        preferences: { bootstrapSetupRequired: true },
      }),
    ).toBe(true);
  });

  it('does not send normal invited or provisioned users through bootstrap setup', () => {
    expect(
      userRequiresSetup({
        email: 'tech@example.test',
        setupCompletedAt: null,
      }),
    ).toBe(false);
  });

  it('does not require setup once completed', () => {
    expect(
      userRequiresSetup({
        email: 'owner@example.test',
        setupCompletedAt: new Date(),
        preferences: { bootstrapSetupRequired: true },
      }),
    ).toBe(false);
  });
});

describe('MFA recovery code peppering', () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    MFA_RECOVERY_CODE_PEPPER: process.env.MFA_RECOVERY_CODE_PEPPER,
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
    SECRET_ENCRYPTION_KEY: process.env.SECRET_ENCRYPTION_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses only MFA_RECOVERY_CODE_PEPPER for recovery code hashes', () => {
    process.env.NODE_ENV = 'production';
    process.env.MFA_RECOVERY_CODE_PEPPER = 'dedicated-recovery-pepper-32-chars';
    process.env.APP_ENCRYPTION_KEY = 'app-key-must-not-be-used';
    process.env.SECRET_ENCRYPTION_KEY = 'secret-key-must-not-be-used';
    process.env.JWT_SECRET = 'jwt-key-must-not-be-used';

    expect(hashRecoveryCode('abcd-1234')).toBe(
      createHash('sha256')
        .update('dedicated-recovery-pepper-32-chars:ABCD-1234')
        .digest('hex')
    );
  });

  it('does not fall back to app, secret, or JWT keys when the pepper is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MFA_RECOVERY_CODE_PEPPER;
    process.env.APP_ENCRYPTION_KEY = 'app-key-must-not-be-used';
    process.env.SECRET_ENCRYPTION_KEY = 'secret-key-must-not-be-used';
    process.env.JWT_SECRET = 'jwt-key-must-not-be-used';

    expect(() => hashRecoveryCode('abcd-1234')).toThrow('MFA_RECOVERY_CODE_PEPPER');
  });
});
