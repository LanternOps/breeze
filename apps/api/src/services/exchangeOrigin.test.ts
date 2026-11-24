import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyExchangeOrigin } from './exchangeOrigin';
import { TAURI_ORIGINS } from './corsOrigins';

describe('classifyExchangeOrigin', () => {
  beforeEach(() => {
    vi.stubEnv('PUBLIC_APP_URL', 'https://breeze.example.com');
    vi.stubEnv('DASHBOARD_URL', '');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('labels the dashboard origin "browser"', () => {
    expect(classifyExchangeOrigin('https://breeze.example.com')).toBe('browser');
  });

  it.each(TAURI_ORIGINS)('labels the Tauri origin %s "viewer"', (origin) => {
    expect(classifyExchangeOrigin(origin)).toBe('viewer');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['the opaque origin "null"', 'null'],
    ['a foreign origin', 'https://evil.example.net'],
    ['the dashboard host on another scheme', 'http://breeze.example.com'],
    ['the dashboard host on another port', 'https://breeze.example.com:8443'],
    ['a subdomain of the dashboard', 'https://sub.breeze.example.com'],
    ['the dashboard with a trailing slash', 'https://breeze.example.com/'],
    ['a Tauri origin on another scheme', 'https://tauri.localhost'],
  ])('labels %s "unknown"', (_label, origin) => {
    expect(classifyExchangeOrigin(origin)).toBe('unknown');
  });

  it('uses the origin of PUBLIC_APP_URL when it carries a path or trailing slash', () => {
    vi.stubEnv('PUBLIC_APP_URL', 'https://breeze.example.com/app/');
    expect(classifyExchangeOrigin('https://breeze.example.com')).toBe('browser');
  });

  it('falls back to DASHBOARD_URL when PUBLIC_APP_URL is unset', () => {
    vi.stubEnv('PUBLIC_APP_URL', '');
    vi.stubEnv('DASHBOARD_URL', 'https://dash.example.com');
    expect(classifyExchangeOrigin('https://dash.example.com')).toBe('browser');
  });

  it('does not treat another CORS-allowed origin as the dashboard', () => {
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://other.example.com,https://breeze.example.com');
    expect(classifyExchangeOrigin('https://other.example.com')).toBe('unknown');
  });

  it('labels a localhost origin "unknown" when no dashboard URL is configured', () => {
    vi.stubEnv('PUBLIC_APP_URL', '');
    expect(classifyExchangeOrigin('http://localhost:4321')).toBe('unknown');
  });

  it.each(['localhost:4321', 'not a url', 'file:///srv/app'])(
    'never matches a "null" Origin when the dashboard URL is %s',
    (configured) => {
      vi.stubEnv('PUBLIC_APP_URL', configured);
      expect(classifyExchangeOrigin('null')).toBe('unknown');
      expect(classifyExchangeOrigin('https://breeze.example.com')).toBe('unknown');
    },
  );
});
