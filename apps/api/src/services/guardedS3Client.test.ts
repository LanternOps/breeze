/**
 * The guarded S3 client's DNS policy, asserted at the layer that actually
 * enforces it: the `lookup` on the agents handed to the AWS SDK.
 *
 * Two directions matter and both are here. A self-hosted install backs up to
 * MinIO/a NAS on its own LAN, so RFC1918 must be reachable there; on hosted the
 * same endpoint is an SSRF primitive and must stay blocked. The third group is
 * the one that proves the opt-in did not become a blanket bypass: cloud
 * metadata and link-local are refused in BOTH modes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookupFunction } from 'node:net';

const s3CtorMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) {
      s3CtorMock(config);
    }
  },
}));

import { createGuardedS3Client } from './guardedS3Client';
import { SsrfBlockedError, __setLookupForTests } from './urlSafety';

/**
 * Build a client and hand back the DNS lookup its http agent will use. This is
 * the connect-time guard itself — asserting on it (rather than on a flag passed
 * around) is what makes the test non-vacuous.
 */
function guardedLookup(): LookupFunction {
  s3CtorMock.mockClear();
  createGuardedS3Client({ region: 'us-east-1', endpoint: 'http://storage.example.test:9000' });
  const config = s3CtorMock.mock.calls[0]?.[0] as {
    requestHandler: { httpAgent: { options: { lookup: LookupFunction } } };
  };
  return config.requestHandler.httpAgent.options.lookup;
}

/** Resolve through the guard, returning either the address or the error. */
function resolveVia(lookup: LookupFunction, host: string): Promise<{ err: Error | null; address: string }> {
  return new Promise((resolve) => {
    lookup(host, {}, (err, address) => resolve({ err: err as Error | null, address: address as string }));
  });
}

describe('createGuardedS3Client — private-network policy', () => {
  afterEach(() => {
    __setLookupForTests(null);
    delete process.env.IS_HOSTED;
  });

  it('allows an RFC1918 S3 endpoint when self-host is affirmatively declared', async () => {
    process.env.IS_HOSTED = 'false';
    __setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);

    const { err, address } = await resolveVia(guardedLookup(), 'minio.lan');

    expect(err).toBeNull();
    expect(address).toBe('10.0.0.5');
  });

  it('blocks the same RFC1918 endpoint on hosted', async () => {
    process.env.IS_HOSTED = 'true';
    __setLookupForTests(async () => [{ address: '10.0.0.5', family: 4 }]);

    const { err } = await resolveVia(guardedLookup(), 'minio.lan');

    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks RFC1918 when IS_HOSTED is unset — the opt-in is fail-closed', async () => {
    // #570 lesson: an unmapped IS_HOSTED must never silently weaken security.
    __setLookupForTests(async () => [{ address: '192.168.1.10', family: 4 }]);

    const { err } = await resolveVia(guardedLookup(), 'nas.lan');

    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it.each([
    ['self-host', 'false'],
    ['hosted', 'true'],
  ])('still blocks cloud metadata and link-local on %s', async (_mode, isHosted) => {
    process.env.IS_HOSTED = isHosted;

    for (const address of ['169.254.169.254', '169.254.10.1', 'fe80::1', '127.0.0.1']) {
      __setLookupForTests(async () => [{ address, family: address.includes(':') ? 6 : 4 }]);
      const { err } = await resolveVia(guardedLookup(), 'evil.example.test');
      expect(err, `${address} must stay blocked in ${_mode} mode`).toBeInstanceOf(SsrfBlockedError);
    }
  });
});
