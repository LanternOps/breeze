import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import {
  MCP_REQUEST_STATE_MAX_BYTES,
  MCP_REQUEST_STATE_TTL_S,
  mcpRequestStateKey,
  openMcpRequestState,
  sealMcpRequestState,
} from './mcpRequestState';

const ID = '11111111-1111-4111-8111-111111111111';
const REF = 'api_key:22222222-2222-4222-8222-222222222222';
const KEY = randomBytes(32);
const baseNoW = { a: ID, p: REF, m: 'tools/call' as const, t: 'manage_quotes', d: 'abc123' };
// #12427: every seal writes the surface byte; 1 (call_tool) is the longer form for the size cap.
const base = { ...baseNoW, w: 1 as const };
const flip = (s: string) => s.slice(0, 3) + (s[3] === 'A' ? 'B' : 'A') + s.slice(4);
const signRaw = (text: string, key = KEY) => {
  const part = Buffer.from(text).toString('base64url');
  return `${part}.${createHmac('sha256', key).update(part).digest().toString('base64url')}`;
};
const forge = (payload: unknown) => signRaw(JSON.stringify(payload));

afterEach(() => vi.unstubAllEnvs());

describe('mcpRequestState', () => {
  it('TTL is 600s and the cap is 1 KiB', () => {
    expect(MCP_REQUEST_STATE_TTL_S).toBe(600);
    expect(MCP_REQUEST_STATE_MAX_BYTES).toBe(1024);
  });

  it('round-trips and rejects a flipped byte', () => {
    const s = sealMcpRequestState(base, KEY, 1000);
    expect(openMcpRequestState(s, KEY, 1001)).toEqual({ ok: true, payload: { v: 1, ...base, e: 1600 } });
    expect(openMcpRequestState(flip(s), KEY, 1001)).toEqual({ ok: false, reason: 'invalid_request_state' });
  });

  it('expired authentic state returns its payload so the caller can check p before exposing a', () => {
    expect(openMcpRequestState(sealMcpRequestState(base, KEY, 0), KEY, 601)).toEqual({
      ok: false,
      reason: 'request_state_expired',
      payload: expect.objectContaining({ a: ID, p: REF }),
    });
  });

  it('is still valid at exactly the expiry second', () => {
    expect(openMcpRequestState(sealMcpRequestState(base, KEY, 0), KEY, 600).ok).toBe(true);
  });

  it('an expired state under the wrong key is invalid, not expired (no payload leak)', () => {
    const s = sealMcpRequestState(base, KEY, 0);
    expect(openMcpRequestState(s, randomBytes(32), 9999)).toEqual({ ok: false, reason: 'invalid_request_state' });
  });

  it.each([
    ['non-string', 42],
    ['undefined', undefined],
    ['empty', ''],
    ['no dot', 'abcdef'],
    ['three parts', 'a.b.c'],
    ['oversize', 'x'.repeat(MCP_REQUEST_STATE_MAX_BYTES + 1)],
  ])('rejects %s', (_n, raw) => {
    expect(openMcpRequestState(raw, KEY, 1)).toEqual({ ok: false, reason: 'invalid_request_state' });
  });

  it.each([
    ['v != 1', { v: 2, ...base, e: 100 }],
    ['wrong m', { v: 1, ...base, m: 'tools/list', e: 100 }],
    ['non-integer e', { v: 1, ...base, e: 1.5 }],
    ['string e', { v: 1, ...base, e: '100' }],
    ['numeric a', { v: 1, ...base, a: 5, e: 100 }],
    ['missing d', { v: 1, a: ID, p: REF, m: 'tools/call', t: 'x', e: 100 }],
    ['null', null],
  ])('rejects a correctly signed payload with %s', (_n, payload) => {
    expect(openMcpRequestState(forge(payload), KEY, 1)).toEqual({ ok: false, reason: 'invalid_request_state' });
  });

  it('rejects non-JSON that is correctly signed', () => {
    expect(openMcpRequestState(signRaw('not json'), KEY, 1)).toEqual({ ok: false, reason: 'invalid_request_state' });
  });

  it('fits within the size cap for realistic input', () => {
    const s = sealMcpRequestState({ ...base, d: 'f'.repeat(64) }, KEY, 1);
    expect(s.length).toBeLessThanOrEqual(MCP_REQUEST_STATE_MAX_BYTES);
  });
});

describe('mcpRequestStateKey', () => {
  it('derives a stable 32-byte key from the app secret, distinct per secret', () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', 'secret-one');
    const a = mcpRequestStateKey();
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a.length).toBe(32);
    expect(mcpRequestStateKey().equals(a)).toBe(true);
    vi.stubEnv('APP_ENCRYPTION_KEY', 'secret-two');
    expect(mcpRequestStateKey().equals(a)).toBe(false);
  });

  it('throws in production with no secret', () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => mcpRequestStateKey()).toThrow();
  });

  it('falls back outside production', () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', '');
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '');
    vi.stubEnv('NODE_ENV', 'test');
    expect(mcpRequestStateKey().length).toBe(32);
  });

  // #12427 (spec §3.4, OD-8 A): the surface byte. 0 = direct, 1 = through call_tool.
  it('seals w when given and opens a state sealed before w existed', () => {
    expect(openMcpRequestState(sealMcpRequestState({ ...baseNoW, w: 1 }, KEY, 1000), KEY, 1001))
      .toEqual({ ok: true, payload: { v: 1, ...baseNoW, w: 1, e: 1600 } });
    expect(openMcpRequestState(sealMcpRequestState({ ...baseNoW, w: 0 }, KEY, 1000), KEY, 1001))
      .toEqual({ ok: true, payload: { v: 1, ...baseNoW, w: 0, e: 1600 } });
    expect(openMcpRequestState(forge({ v: 1, ...baseNoW, e: 1600 }), KEY, 1001)).toEqual({ ok: true, payload: { v: 1, ...baseNoW, e: 1600 } });
  });

  it.each([2, '1', null, true])('a state with w = %j is invalid', (w) => {
    expect(openMcpRequestState(forge({ v: 1, ...baseNoW, w, e: 1600 }), KEY, 1001)).toEqual({ ok: false, reason: 'invalid_request_state' });
  });
});
