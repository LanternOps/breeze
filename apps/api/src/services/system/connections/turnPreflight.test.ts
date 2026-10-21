import { describe, expect, it, vi } from 'vitest';
import {
  TURN_UNAUTH_ALLOCATE_WARNING,
  buildAllocateRequest,
  classifyAllocateResponse,
  getLastTurnPreflight,
  runTurnPreflight,
  startTurnPreflight,
  type AllocateTransport,
} from './turnPreflight';

const TXID = Buffer.from('000102030405060708090a0b', 'hex');
const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

// Byte fixtures (RFC 5766 / RFC 5389), transaction id 00..0b.
// Allocate request: type 0x0003, len 8, cookie, txid, REQUESTED-TRANSPORT(UDP).
const ALLOCATE_REQUEST = hex('0003 0008 2112a442 000102030405060708090a0b 0019 0004 11000000');
// Allocate Success (0x0103) with XOR-RELAYED-ADDRESS-ish attribute: coturn with no auth.
const ALLOCATE_SUCCESS = hex(
  '0103 000c 2112a442 000102030405060708090a0b 0016 0008 0001 e5a1 e112a443',
);
// Allocate Error (0x0113) 401: ERROR-CODE class 4 number 1, "Unauthorized".
const ALLOCATE_401 = hex(
  '0113 0010 2112a442 000102030405060708090a0b 0009 000c 0000 0401 556e617574686f72697a6564',
);
// Allocate Error 403 Forbidden.
const ALLOCATE_403 = hex(
  '0113 0010 2112a442 000102030405060708090a0b 0009 000c 0000 0403 466f7262696464656e21',
);

describe('buildAllocateRequest', () => {
  it('matches the captured Allocate request bytes (no MESSAGE-INTEGRITY)', () => {
    const req = buildAllocateRequest(TXID);
    expect(req.equals(ALLOCATE_REQUEST)).toBe(true);
  });

  it('generates a random 12-byte transaction id when none is given', () => {
    const a = buildAllocateRequest();
    const b = buildAllocateRequest();
    expect(a.length).toBe(28);
    expect(a.readUInt32BE(4)).toBe(0x2112a442);
    expect(a.subarray(8, 20).equals(b.subarray(8, 20))).toBe(false);
  });

  it('rejects a transaction id that is not 12 bytes', () => {
    expect(() => buildAllocateRequest(Buffer.alloc(4))).toThrow();
  });
});

describe('classifyAllocateResponse', () => {
  it('401 → unauthorized (healthy)', () => {
    expect(classifyAllocateResponse(ALLOCATE_401, TXID)).toEqual({ kind: 'unauthorized' });
  });

  it('Allocate Success → success (relay not enforcing auth)', () => {
    expect(classifyAllocateResponse(ALLOCATE_SUCCESS, TXID)).toEqual({ kind: 'success' });
  });

  it('other error codes → error with the code', () => {
    expect(classifyAllocateResponse(ALLOCATE_403, TXID)).toEqual({ kind: 'error', code: 403 });
  });

  it('mismatched transaction id → invalid', () => {
    expect(classifyAllocateResponse(ALLOCATE_401, Buffer.alloc(12, 9)).kind).toBe('invalid');
  });

  it('garbage / short / wrong cookie → invalid', () => {
    expect(classifyAllocateResponse(Buffer.from('hello'), TXID).kind).toBe('invalid');
    expect(classifyAllocateResponse(Buffer.alloc(0), TXID).kind).toBe('invalid');
    const badCookie = Buffer.from(ALLOCATE_401);
    badCookie.writeUInt32BE(0xdeadbeef, 4);
    expect(classifyAllocateResponse(badCookie, TXID).kind).toBe('invalid');
  });
});

describe('runTurnPreflight', () => {
  const env = { TURN_HOST: 'turn.example.test', TURN_PORT: '3479' };

  it('not configured → skipped, transport never called', async () => {
    const transport = vi.fn<AllocateTransport>();
    const r = await runTurnPreflight({}, transport);
    expect(r.status).toBe('skipped');
    expect(transport).not.toHaveBeenCalled();
  });

  it('401 → ok; request is sent to TURN_HOST:TURN_PORT', async () => {
    const transport = vi.fn<AllocateTransport>(async () => ALLOCATE_401);
    // transaction id is random, so echo it back into the fixture
    transport.mockImplementation(async (_h, _p, req) => {
      const res = Buffer.from(ALLOCATE_401);
      req.copy(res, 8, 8, 20);
      return res;
    });
    const r = await runTurnPreflight(env, transport);
    expect(r.status).toBe('ok');
    expect(transport.mock.calls[0]![0]).toBe('turn.example.test');
    expect(transport.mock.calls[0]![1]).toBe(3479);
  });

  it('defaults the port to 3478', async () => {
    const transport = vi.fn<AllocateTransport>(async () => null);
    await runTurnPreflight({ TURN_HOST: 'turn.example.test' }, transport);
    expect(transport.mock.calls[0]![1]).toBe(3478);
  });

  it('success → warn with the issue text, no host in the message', async () => {
    const transport: AllocateTransport = async (_h, _p, req) => {
      const res = Buffer.from(ALLOCATE_SUCCESS);
      req.copy(res, 8, 8, 20);
      return res;
    };
    const r = await runTurnPreflight(env, transport);
    expect(r.status).toBe('warn');
    expect(r.message).toBe(TURN_UNAUTH_ALLOCATE_WARNING);
    expect(TURN_UNAUTH_ALLOCATE_WARNING).toMatch(/never get a relay candidate/);
    expect(JSON.stringify(r)).not.toContain('turn.example.test');
  });

  it('timeout (null) → info, not a failure', async () => {
    const r = await runTurnPreflight(env, async () => null);
    expect(r.status).toBe('info');
  });

  it('transport throws → info, never rejects', async () => {
    const r = await runTurnPreflight(env, async () => {
      throw new Error('EHOSTUNREACH 10.0.0.1');
    });
    expect(r.status).toBe('info');
    expect(JSON.stringify(r)).not.toContain('10.0.0.1');
  });

  it('invalid reply → info', async () => {
    const r = await runTurnPreflight(env, async () => Buffer.from('nope'));
    expect(r.status).toBe('info');
  });
});

describe('startTurnPreflight', () => {
  it('runs once, non-blocking, logs a warning on success and caches the result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transport: AllocateTransport = async (_h, _p, req) => {
      const res = Buffer.from(ALLOCATE_SUCCESS);
      req.copy(res, 8, 8, 20);
      return res;
    };
    await startTurnPreflight({ TURN_HOST: 'turn.example.test' }, transport);
    expect(getLastTurnPreflight()?.status).toBe('warn');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[turn-preflight]'));
    warn.mockRestore();
  });
});
