import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from './validate';

function withEnv(overrides: Record<string, string>, fn: () => void) {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    original[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    fn();
  } finally {
    for (const [key, val] of Object.entries(original)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/breeze',
  JWT_SECRET: 'a7f3b9c2d1e4f6a8b0c3d5e7f9a1b3c5e7d9f1a3b5c7d9e1f3a5b7c9d1e3f5',
  APP_ENCRYPTION_KEY: 'x9y8z7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4',
  MFA_ENCRYPTION_KEY: 'k4j3i2h1g0f9e8d7c6b5a4x9y8z7w6v5u4t3s2r1q0p9o8n7m6l5',
  NODE_ENV: 'development',
};

describe('validateConfig', () => {
  afterEach(() => {
    // Reset singleton between tests by reimporting is not practical,
    // but validateConfig() can be called multiple times safely
  });

  it('passes with valid config in development', () => {
    withEnv(validEnv, () => {
      const config = validateConfig();
      expect(config.DATABASE_URL).toBe(validEnv.DATABASE_URL);
      expect(config.JWT_SECRET).toBe(validEnv.JWT_SECRET);
      expect(config.NODE_ENV).toBe('development');
      expect(config.API_PORT).toBe(3001);
      expect(config.REDIS_URL).toBe('redis://localhost:6379');
    });
  });

  it('passes with valid config in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('production');
    });
  });

  it('throws when DATABASE_URL is missing', () => {
    withEnv({ ...validEnv, DATABASE_URL: '' }, () => {
      expect(() => validateConfig()).toThrow('DATABASE_URL');
    });
  });

  it('throws when DATABASE_URL has invalid format', () => {
    withEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' }, () => {
      expect(() => validateConfig()).toThrow('postgres');
    });
  });

  it('accepts postgres:// prefix', () => {
    withEnv({ ...validEnv, DATABASE_URL: 'postgres://user:pass@localhost/db' }, () => {
      const config = validateConfig();
      expect(config.DATABASE_URL).toContain('postgres://');
    });
  });

  it('throws when JWT_SECRET is missing', () => {
    const env = { ...validEnv };
    delete (env as any).JWT_SECRET;
    withEnv({ ...env, JWT_SECRET: '' }, () => {
      expect(() => validateConfig()).toThrow('JWT_SECRET');
    });
  });

  it('throws when APP_ENCRYPTION_KEY is missing', () => {
    withEnv({ ...validEnv, APP_ENCRYPTION_KEY: '' }, () => {
      expect(() => validateConfig()).toThrow('APP_ENCRYPTION_KEY');
    });
  });

  it('throws when MFA_ENCRYPTION_KEY is missing', () => {
    withEnv({ ...validEnv, MFA_ENCRYPTION_KEY: '' }, () => {
      expect(() => validateConfig()).toThrow('MFA_ENCRYPTION_KEY');
    });
  });

  it('rejects insecure JWT_SECRET in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'changeme',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
    }, () => {
      expect(() => validateConfig()).toThrow('insecure');
    });
  });

  it('rejects known placeholder values in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'your-super-secret-jwt-key-change-in-production-must-be-at-least-32-chars',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
    }, () => {
      expect(() => validateConfig()).toThrow('insecure');
    });
  });

  it('allows any JWT_SECRET value in development', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'development',
      JWT_SECRET: 'changeme',
    }, () => {
      const config = validateConfig();
      expect(config.JWT_SECRET).toBe('changeme');
    });
  });

  it('allows any JWT_SECRET value in test', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'test',
      JWT_SECRET: 'e2e-test-jwt-key-with-the-word-changeme',
    }, () => {
      const config = validateConfig();
      expect(config.NODE_ENV).toBe('test');
    });
  });

  it('rejects wildcard CORS in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: '*',
    }, () => {
      expect(() => validateConfig()).toThrow('CORS_ALLOWED_ORIGINS');
    });
  });

  it('rejects missing CORS in production', () => {
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
    }, () => {
      expect(() => validateConfig()).toThrow('CORS_ALLOWED_ORIGINS');
    });
  });

  it('allows missing CORS in development', () => {
    withEnv(validEnv, () => {
      const config = validateConfig();
      expect(config.CORS_ALLOWED_ORIGINS).toBeUndefined();
    });
  });

  it('parses API_PORT correctly', () => {
    withEnv({ ...validEnv, API_PORT: '8080' }, () => {
      const config = validateConfig();
      expect(config.API_PORT).toBe(8080);
    });
  });

  it('rejects invalid API_PORT', () => {
    withEnv({ ...validEnv, API_PORT: '99999' }, () => {
      expect(() => validateConfig()).toThrow();
    });
  });

  it('rejects non-numeric API_PORT', () => {
    withEnv({ ...validEnv, API_PORT: 'abc' }, () => {
      expect(() => validateConfig()).toThrow();
    });
  });

  it('defaults API_PORT to 3001', () => {
    withEnv(validEnv, () => {
      const config = validateConfig();
      expect(config.API_PORT).toBe(3001);
    });
  });

  it('logs warnings for insecure optional secrets', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({
      ...validEnv,
      AGENT_ENROLLMENT_SECRET: 'changeme',
    }, () => {
      validateConfig();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('AGENT_ENROLLMENT_SECRET')
      );
    });
    warnSpy.mockRestore();
  });

  it('logs FORCE_HTTPS warning in production', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withEnv({
      ...validEnv,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.breeze.io',
    }, () => {
      validateConfig();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('FORCE_HTTPS')
      );
    });
    warnSpy.mockRestore();
  });

  it('includes formatted error banner on failure', () => {
    withEnv({ ...validEnv, DATABASE_URL: '' }, () => {
      try {
        validateConfig();
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('CONFIGURATION VALIDATION FAILED');
        expect(err.message).toContain('Hint:');
      }
    });
  });
});
