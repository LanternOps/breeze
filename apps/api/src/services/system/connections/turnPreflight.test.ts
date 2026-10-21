import dgram from 'node:dgram';
import { describe, expect, it, vi } from 'vitest';
import {
  TURN_UNAUTH_ALLOCATE_WARNING,
  buildAllocateRequest,
  classifyAllocateResponse,
  getLastTurnPreflight,
  runTurnPreflight,
  startTurnPreflight,
  udpAllocateTransport,
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
  '0113 0014 2112a442 000102030405060708090a0b 0009 0010 0000 0401 556e617574686f72697a6564',
);
// Allocate Error 403 Forbidden; reason is 10 bytes so the value (14) is padded to 16.
const ALLOCATE_403 = hex(
  '0113 0014 2112a442 000102030405060708090a0b 0009 000e 0000 0403 466f7262696464656e21 0000',
);
// 401 where ERROR-CODE follows a 5-byte attribute (SOFTWARE 0x8022) padded with 3 bytes.
const ALLOCATE_401_AFTER_PADDED_ATTR = hex(
  '0113 001c 2112a442 000102030405060708090a0b 8022 0005 6162636465 000000 0009 0010 0000 0401 556e617574686f72697a6564',
);
// Error response with no ERROR-CODE attribute at all.
const ALLOCATE_ERROR_NO_CODE = hex('0113 0000 2112a442 000102030405060708090a0b');
// Valid-cookie Binding success (0x0101): not an Allocate response.
const BINDING_SUCCESS = hex('0101 0000 2112a442 000102030405060708090a0b');

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

  it('mismatched transaction id → invalid (both directions)', () => {
    expect(classifyAllocateResponse(ALLOCATE_401, Buffer.alloc(12, 9)).kind).toBe('invalid');
    expect(classifyAllocateResponse(ALLOCATE_SUCCESS, Buffer.alloc(12, 9)).kind).toBe('invalid');
  });

  it('skips padded attributes to find ERROR-CODE', () => {
    expect(classifyAllocateResponse(ALLOCATE_401_AFTER_PADDED_ATTR, TXID)).toEqual({ kind: 'unauthorized' });
  });

  it('error without ERROR-CODE → error with null code', () => {
    expect(classifyAllocateResponse(ALLOCATE_ERROR_NO_CODE, TXID)).toEqual({ kind: 'error', code: null });
  });

  it('truncated attribute does not throw', () => {
    const truncated = ALLOCATE_401.subarray(0, 26);
    expect(() => classifyAllocateResponse(truncated, TXID)).not.toThrow();
    expect(classifyAllocateResponse(truncated, TXID).kind).toBe('error');
  });

  it('valid-cookie non-Allocate message → invalid', () => {
    expect(classifyAllocateResponse(BINDING_SUCCESS, TXID).kind).toBe('invalid');
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
    // transaction id is random, so echo it back into the fixture
    const transport = vi.fn<AllocateTransport>(async (_h, _p, req) => {
      const res = Buffer.from(ALLOCATE_401);
      req.copy(res, 8, 8, 20);
      return res;
    });
    const r = await runTurnPreflight(env, transport);
    expect(r.status).toBe('ok');
    expect(transport.mock.calls[0]![0]).toBe('turn.example.test');
    expect(transport.mock.calls[0]![1]).toBe(3479);
  });

  it.each([
    [undefined, 3478],
    ['', 3478],
    ['abc', 3478],
    ['0', 3478],
    ['65536', 3478],
    ['-1', 3478],
    ['3478abc', 3478],
    [' 3479 ', 3479],
  ])('TURN_PORT %j → port %i', async (raw, expected) => {
    const transport = vi.fn<AllocateTransport>(async () => null);
    await runTurnPreflight({ TURN_HOST: 'turn.example.test', TURN_PORT: raw }, transport);
    expect(transport.mock.calls[0]![1]).toBe(expected);
  });

  it('whitespace-only TURN_HOST → skipped', async () => {
    const r = await runTurnPreflight({ TURN_HOST: '   ' }, vi.fn<AllocateTransport>());
    expect(r.status).toBe('skipped');
  });

  it('a non-401 error reply → info naming the code', async () => {
    const r = await runTurnPreflight(env, async (_h, _p, req) => {
      const res = Buffer.from(ALLOCATE_403);
      req.copy(res, 8, 8, 20);
      return res;
    });
    expect(r.status).toBe('info');
    expect(r.message).toContain('403');
  });

  it('a reply with the wrong transaction id → info, not warn', async () => {
    const r = await runTurnPreflight(env, async () => Buffer.from(ALLOCATE_SUCCESS));
    expect(r.status).toBe('info');
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

  it('DNS failure → info naming TURN_HOST, without the host', async () => {
    const r = await runTurnPreflight(env, async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND turn.example.test'), { code: 'ENOTFOUND' });
    });
    expect(r.status).toBe('info');
    expect(r.message).toMatch(/did not resolve/);
    expect(JSON.stringify(r)).not.toContain('turn.example.test');
  });

  it('invalid reply → info', async () => {
    const r = await runTurnPreflight(env, async () => Buffer.from('nope'));
    expect(r.status).toBe('info');
  });
});

describe('udpAllocateTransport (real dgram, loopback)', () => {
  async function server(onMessage?: (msg: Buffer, reply: (b: Buffer) => void) => void) {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
    sock.on('message', (msg, rinfo) => onMessage?.(msg, (b) => sock.send(b, rinfo.port, rinfo.address)));
    return { sock, port: sock.address().port };
  }

  it('resolves with the reply datagram', async () => {
    const { sock, port } = await server((_m, reply) => reply(Buffer.from('pong')));
    try {
      const res = await udpAllocateTransport('127.0.0.1', port, buildAllocateRequest(TXID), 1000);
      expect(res?.toString()).toBe('pong');
    } finally {
      sock.close();
    }
  });

  it('delivers the exact Allocate request bytes', async () => {
    let seen: Buffer | null = null;
    const { sock, port } = await server((m, reply) => {
      seen = m;
      reply(Buffer.from('x'));
    });
    try {
      await udpAllocateTransport('127.0.0.1', port, buildAllocateRequest(TXID), 1000);
      expect(seen!.toString('hex')).toBe(ALLOCATE_REQUEST.toString('hex'));
    } finally {
      sock.close();
    }
  });

  it('resolves null on timeout', async () => {
    const { sock, port } = await server();
    try {
      expect(await udpAllocateTransport('127.0.0.1', port, buildAllocateRequest(TXID), 50)).toBeNull();
    } finally {
      sock.close();
    }
  });

  it('rejects on an invalid port', async () => {
    await expect(udpAllocateTransport('127.0.0.1', 70000, buildAllocateRequest(TXID), 200)).rejects.toBeDefined();
  });
});

describe('startTurnPreflight', () => {
  it('a later ok result replaces a cached warn and does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await startTurnPreflight({ TURN_HOST: 'turn.example.test' }, async (_h, _p, req) => {
      const res = Buffer.from(ALLOCATE_SUCCESS);
      req.copy(res, 8, 8, 20);
      return res;
    });
    expect(getLastTurnPreflight()?.status).toBe('warn');
    warn.mockClear();
    await startTurnPreflight({ TURN_HOST: 'turn.example.test' }, async (_h, _p, req) => {
      const res = Buffer.from(ALLOCATE_401);
      req.copy(res, 8, 8, 20);
      return res;
    });
    expect(getLastTurnPreflight()?.status).toBe('ok');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    info.mockRestore();
  });

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
