import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetRuntimeConfigForTests,
  getApiBaseUrl,
  getEntraClientId,
  loadRuntimeConfig,
} from './config';

/** Build a minimal fetch stub returning the given /config.json response. */
function fetchReturning(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

const fetchRejecting: typeof fetch = (async () => {
  throw new Error('network down');
}) as unknown as typeof fetch;

/** ok:true but the body is not JSON (e.g. an HTML 200 error page) — json() throws. */
const fetchOkButNotJson: typeof fetch = (async () =>
  ({
    ok: true,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  }) as unknown as Response) as unknown as typeof fetch;

afterEach(() => {
  __resetRuntimeConfigForTests();
});

describe('runtime config', () => {
  it('defaults to localhost before any load', () => {
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });

  it('loads apiBaseUrl + entraClientId from /config.json', async () => {
    await loadRuntimeConfig(
      fetchReturning({ apiBaseUrl: 'https://us.2breeze.app', entraClientId: 'abc-123' }),
    );
    expect(getApiBaseUrl()).toBe('https://us.2breeze.app');
    expect(getEntraClientId()).toBe('abc-123');
  });

  it('strips a trailing slash from apiBaseUrl', async () => {
    await loadRuntimeConfig(fetchReturning({ apiBaseUrl: 'https://eu.2breeze.app/', entraClientId: 'x' }));
    expect(getApiBaseUrl()).toBe('https://eu.2breeze.app');
  });

  it('falls back to defaults on a non-ok response (404)', async () => {
    await loadRuntimeConfig(fetchReturning({}, false));
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });

  it('falls back to defaults when fetch rejects', async () => {
    await loadRuntimeConfig(fetchRejecting);
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
  });

  it('falls back per-field when config.json is missing/garbled fields', async () => {
    await loadRuntimeConfig(fetchReturning({ apiBaseUrl: 42, entraClientId: null }));
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });

  it('falls back when apiBaseUrl is an empty string (must not become "")', async () => {
    await loadRuntimeConfig(fetchReturning({ apiBaseUrl: '', entraClientId: '' }));
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });

  it('falls back when the body is a non-JSON 200 (json() throws)', async () => {
    await loadRuntimeConfig(fetchOkButNotJson);
    expect(getApiBaseUrl()).toBe('http://localhost:3001');
    expect(getEntraClientId()).toBe('');
  });

  it('collapses multiple trailing slashes in apiBaseUrl', async () => {
    await loadRuntimeConfig(fetchReturning({ apiBaseUrl: 'https://eu.2breeze.app//', entraClientId: 'x' }));
    expect(getApiBaseUrl()).toBe('https://eu.2breeze.app');
  });
});
