import { afterEach, describe, expect, it, vi } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import { requestJson } from './http';
import { SsrfBlockedError, __setLookupForTests } from '../urlSafety';

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
  });
});
