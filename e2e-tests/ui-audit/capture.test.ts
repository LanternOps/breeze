import { describe, expect, it } from 'vitest';
import { isBlockedWrite } from './capture';

const origin = 'http://localhost:4321';
const blocked = (method: string, pathname: string, from = origin) => isBlockedWrite(method, new URL(pathname, from), origin);

describe('isBlockedWrite', () => {
  it('blocks same-origin writes the page makes on load', () => {
    expect(blocked('POST', '/api/v1/reports')).toBe(true);
    expect(blocked('DELETE', '/api/v1/devices/1')).toBe(true);
  });

  it('lets reads, auth, and read-only POSTs through', () => {
    expect(blocked('GET', '/api/v1/reports')).toBe(false);
    expect(blocked('POST', '/api/v1/auth/refresh')).toBe(false);
    expect(blocked('POST', '/api/v1/events/ws-ticket')).toBe(false);
    expect(blocked('POST', '/api/v1/devices/search')).toBe(false);
  });

  it('lets the report builder live preview through (it only computes and returns data)', () => {
    expect(blocked('POST', '/api/v1/reports/generate')).toBe(false);
  });

  it('leaves other origins alone', () => {
    expect(blocked('POST', '/collect', 'https://telemetry.example.com')).toBe(false);
  });
});
