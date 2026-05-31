import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import { requestJson, DnsProviderHttpError } from './http';
import { SsrfBlockedError, __setLookupForTests } from '../urlSafety';

/**
 * Build an https.request mock that lands one response with the given status and
 * body. Used (with a literal IP + allowPrivateNetwork) to exercise the response
 * path past the SSRF gate without real network I/O.
 */
function mockHttpsOnce(opts: { statusCode: number; statusMessage: string; body: string }) {
  return vi
    .spyOn(https, 'request')
    .mockImplementation((_options: any, callback?: any) => {
      const req = new EventEmitter() as any;
      req.write = vi.fn();
      req.destroy = vi.fn();
      req.setTimeout = vi.fn();
      req.end = vi.fn(() => {
        const res = new EventEmitter() as any;
        res.statusCode = opts.statusCode;
        res.statusMessage = opts.statusMessage;
        res.headers = { 'content-type': 'application/json' };
        callback?.(res);
        res.emit('data', Buffer.from(opts.body));
        res.emit('end');
      });
      return req;
    });
}

describe('requestJson — SSRF safety via safeFetch', () => {
  afterEach(() => {
    __setLookupForTests(null);
    vi.restoreAllMocks();
  });

  describe('strict mode (allowPrivateNetwork unset)', () => {
    it('rejects a hostname that resolves to cloud metadata (169.254.169.254)', async () => {
      __setLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
      await expect(requestJson('https://attacker.example/x')).rejects.toBeInstanceOf(
        SsrfBlockedError
      );
    });

    it('rejects a hostname that resolves to an RFC1918 address', async () => {
      __setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);
      await expect(requestJson('https://attacker.example/x')).rejects.toBeInstanceOf(
        SsrfBlockedError
      );
    });

    it('rejects a literal metadata URL without performing DNS', async () => {
      let dnsCalled = false;
      __setLookupForTests(async () => {
        dnsCalled = true;
        return [{ address: '8.8.8.8', family: 4 }];
      });
      await expect(
        requestJson('http://169.254.169.254/latest/meta-data')
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(dnsCalled).toBe(false);
    });

    it('rejects a literal IPv4-mapped IPv6 hex-form metadata URL (::ffff:a9fe:a9fe)', async () => {
      let dnsCalled = false;
      __setLookupForTests(async () => {
        dnsCalled = true;
        return [{ address: '8.8.8.8', family: 4 }];
      });
      // [::ffff:a9fe:a9fe] == 169.254.169.254
      await expect(
        requestJson('http://[::ffff:a9fe:a9fe]/latest/meta-data')
      ).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(dnsCalled).toBe(false);
    });

    it('rejects a literal RFC1918 URL (10.0.0.5) in strict mode', async () => {
      await expect(requestJson('http://10.0.0.5/x')).rejects.toBeInstanceOf(SsrfBlockedError);
    });
  });

  describe('on-prem opt-in (allowPrivateNetwork: true)', () => {
    it('proceeds for an RFC1918 target and returns the parsed body', async () => {
      // Hostname resolves to a 10.x address (permitted under opt-in). We stub
      // https.request so the pinned connect "lands" and returns an empty body,
      // proving the request got past the SSRF gate and parses successfully.
      __setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);
      const requestSpy = vi
        .spyOn(https, 'request')
        .mockImplementation((_options: any, callback?: any) => {
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.destroy = vi.fn();
          req.setTimeout = vi.fn();
          req.end = vi.fn(() => {
            const res = new EventEmitter() as any;
            res.statusCode = 200;
            res.statusMessage = 'OK';
            res.headers = { 'content-type': 'application/json' };
            callback?.(res);
            res.emit('data', Buffer.from('{}'));
            res.emit('end');
          });
          return req;
        });

      const result = await requestJson('https://appliance.local/x', {
        allowPrivateNetwork: true,
        maxRetries: 0
      });
      expect(result).toEqual({});
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    it('proceeds for a LITERAL RFC1918 IP target (10.0.0.5) and returns the parsed body', async () => {
      // No DNS hook needed — literal IPs are treated as pre-resolved. Verifies
      // the literal-IP allow path past the SSRF gate (was previously untested).
      const requestSpy = vi
        .spyOn(https, 'request')
        .mockImplementation((_options: any, callback?: any) => {
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.destroy = vi.fn();
          req.setTimeout = vi.fn();
          req.end = vi.fn(() => {
            const res = new EventEmitter() as any;
            res.statusCode = 200;
            res.statusMessage = 'OK';
            res.headers = { 'content-type': 'application/json' };
            callback?.(res);
            res.emit('data', Buffer.from('{}'));
            res.emit('end');
          });
          return req;
        });

      const result = await requestJson('https://10.0.0.5/x', {
        allowPrivateNetwork: true,
        maxRetries: 0
      });
      expect(result).toEqual({});
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    it('STILL rejects cloud metadata (169.254.169.254) even with opt-in', async () => {
      __setLookupForTests(async () => [{ address: '169.254.169.254', family: 4 }]);
      await expect(
        requestJson('https://attacker.example/x', {
          allowPrivateNetwork: true,
          maxRetries: 0
        })
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('STILL rejects loopback (127.0.0.1) even with opt-in', async () => {
      __setLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
      await expect(
        requestJson('https://attacker.example/x', {
          allowPrivateNetwork: true,
          maxRetries: 0
        })
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('STILL rejects CGNAT (100.64.0.1) even with opt-in', async () => {
      __setLookupForTests(async () => [{ address: '100.64.0.1', family: 4 }]);
      await expect(
        requestJson('https://attacker.example/x', {
          allowPrivateNetwork: true,
          maxRetries: 0
        })
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('STILL rejects hex-form mapped metadata (::ffff:a9fe:a9fe) even with opt-in', async () => {
      __setLookupForTests(async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }]);
      await expect(
        requestJson('https://attacker.example/x', {
          allowPrivateNetwork: true,
          maxRetries: 0
        })
      ).rejects.toBeInstanceOf(SsrfBlockedError);
    });
  });

  describe('SSRF-blocked requests are NOT retried', () => {
    it('fails fast on a blocked host even with maxRetries:3 (DNS lookup invoked exactly once)', async () => {
      // Regression guard: the `!isSsrfBlocked` short-circuit in http.ts must
      // prevent retrying an SSRF policy violation. If SsrfBlockedError were
      // ever reclassified as retriable, the lookup would run maxRetries+1 times.
      let lookupCalls = 0;
      __setLookupForTests(async () => {
        lookupCalls += 1;
        return [{ address: '169.254.169.254', family: 4 }];
      });

      await expect(
        requestJson('https://attacker.example/x', {
          allowPrivateNetwork: true,
          maxRetries: 3
        })
      ).rejects.toBeInstanceOf(SsrfBlockedError);

      expect(lookupCalls).toBe(1);
    });
  });

  describe('transient failures ARE retried (positive branch)', () => {
    it('retries a transient 5xx and eventually succeeds (multiple transport attempts)', async () => {
      // Literal allowed IP so there is no DNS hop; count transport invocations
      // to confirm the retry loop runs more than once for a retriable 5xx.
      let attempts = 0;
      const requestSpy = vi
        .spyOn(https, 'request')
        .mockImplementation((_options: any, callback?: any) => {
          const req = new EventEmitter() as any;
          req.write = vi.fn();
          req.destroy = vi.fn();
          req.setTimeout = vi.fn();
          req.end = vi.fn(() => {
            attempts += 1;
            const res = new EventEmitter() as any;
            const firstAttempt = attempts === 1;
            res.statusCode = firstAttempt ? 503 : 200;
            res.statusMessage = firstAttempt ? 'Service Unavailable' : 'OK';
            res.headers = firstAttempt
              ? { 'content-type': 'application/json', 'retry-after': '0' }
              : { 'content-type': 'application/json' };
            callback?.(res);
            res.emit('data', Buffer.from('{}'));
            res.emit('end');
          });
          return req;
        });

      const result = await requestJson('https://10.0.0.5/x', {
        allowPrivateNetwork: true,
        maxRetries: 3
      });

      expect(result).toEqual({});
      expect(requestSpy.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('DnsProviderHttpError — no upstream body in .message', () => {
    it('throws a body-free DnsProviderHttpError on a non-2xx response, keeping the body on responseBody', async () => {
      // 4xx is non-retriable, so a single transport attempt surfaces the error.
      mockHttpsOnce({
        statusCode: 403,
        statusMessage: 'Forbidden',
        body: 'UPSTREAM_BODY_MARKER: secret internal detail'
      });

      const error = await requestJson('https://10.0.0.5/x', {
        allowPrivateNetwork: true,
        maxRetries: 0
      }).then(
        () => {
          throw new Error('expected requestJson to reject');
        },
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(DnsProviderHttpError);
      const httpError = error as DnsProviderHttpError;
      expect(httpError.status).toBe(403);
      expect(httpError.statusText).toBe('Forbidden');
      // SECURITY: status line only — the upstream body must NOT leak into the
      // (tenant-visible) message.
      expect(httpError.message).toBe('HTTP 403 Forbidden');
      expect(httpError.message).not.toContain('UPSTREAM_BODY_MARKER');
      // Raw body preserved for server-side logging only.
      expect(httpError.responseBody).toBe('UPSTREAM_BODY_MARKER: secret internal detail');
    });

    it('throws a body-free DnsProviderHttpError on an unparseable 2xx body, keeping the body on responseBody', async () => {
      mockHttpsOnce({
        statusCode: 200,
        statusMessage: 'OK',
        body: 'not json UPSTREAM_BODY_MARKER'
      });

      const error = await requestJson('https://10.0.0.5/x', {
        allowPrivateNetwork: true,
        maxRetries: 0
      }).then(
        () => {
          throw new Error('expected requestJson to reject');
        },
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(DnsProviderHttpError);
      const httpError = error as DnsProviderHttpError;
      expect(httpError.message).toBe('Provider returned invalid JSON payload');
      // SECURITY: the raw payload must NOT leak into the tenant-visible message.
      expect(httpError.message).not.toContain('UPSTREAM_BODY_MARKER');
      // Raw text preserved for server-side logging only.
      expect(httpError.responseBody).toBe('not json UPSTREAM_BODY_MARKER');
    });
  });
});
