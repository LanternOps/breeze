import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_VERSION } from '../version';
import { buildHealthPayload, getVersionInfo } from './versionInfo';

describe('versionInfo', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.BINARY_VERSION;
    delete process.env.BREEZE_BINARIES_VERSION;
    process.env.BREEZE_VERSION = '0.118.2';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('server-only image: reports the server version and the paired binaries version separately', () => {
    process.env.BREEZE_BINARIES_VERSION = '0.118.0';
    expect(getVersionInfo()).toEqual({ version: API_VERSION, binariesVersion: '0.118.0' });
  });

  it('full-release image: binariesVersion is the server release', () => {
    expect(getVersionInfo().binariesVersion).toBe('0.118.2');
  });

  it('an explicit BINARY_VERSION override is what binariesVersion reports', () => {
    process.env.BREEZE_BINARIES_VERSION = '0.118.0';
    process.env.BINARY_VERSION = '0.117.9';
    expect(getVersionInfo().binariesVersion).toBe('0.117.9');
  });

  it('/health payload: status, version, binariesVersion, uptime', () => {
    process.env.BREEZE_BINARIES_VERSION = '0.118.0';
    const payload = buildHealthPayload(1_000, 61_500);
    expect(payload).toEqual({
      status: 'ok',
      version: API_VERSION,
      binariesVersion: '0.118.0',
      uptime: 60,
    });
    expect(Object.keys(payload)).toEqual(['status', 'version', 'binariesVersion', 'uptime']);
  });

  it('index.ts serves /health from buildHealthPayload', () => {
    const index = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    const handler = index.slice(index.indexOf("app.get('/health',"), index.indexOf("app.get('/health/live',"));
    expect(handler).toContain('buildHealthPayload(startedAt)');
  });
});
