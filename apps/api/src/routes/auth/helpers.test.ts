import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { getAllowedOrigins } from './helpers';

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
