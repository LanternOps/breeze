import { describe, expect, it } from 'vitest';
import { createCorsOriginResolver, DEFAULT_ALLOWED_ORIGINS } from './corsOrigins';

describe('cors origin resolver', () => {
  it('allows known default origin', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'production'
    });

    expect(resolveOrigin('http://localhost:4321')).toBe('http://localhost:4321');
  });

  it('allows configured custom origin', () => {
    const resolveOrigin = createCorsOriginResolver({
      configuredOriginsRaw: 'https://app.example.com, https://admin.example.com',
      nodeEnv: 'production'
    });

    expect(resolveOrigin('https://admin.example.com')).toBe('https://admin.example.com');
  });

  it('allows localhost variants in development', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'development'
    });

    expect(resolveOrigin('http://localhost:9999')).toBe('http://localhost:9999');
    expect(resolveOrigin('http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000');
  });

  it('falls back to default for unknown production origin', () => {
    const resolveOrigin = createCorsOriginResolver({
      nodeEnv: 'production'
    });

    expect(resolveOrigin('https://malicious.example')).toBe(DEFAULT_ALLOWED_ORIGINS[0]);
  });
});
