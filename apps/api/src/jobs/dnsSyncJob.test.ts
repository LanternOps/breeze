import { describe, expect, it } from 'vitest';
import { runSequentialDomainMutations, tenantVisibleSyncError } from './dnsSyncJob';
import { DnsProviderHttpError } from '../services/dnsProviders';

describe('runSequentialDomainMutations (issue #827 — policy-sync rule clobbering)', () => {
  it('runs domain mutations one at a time, never concurrently', async () => {
    const domains = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'];
    let inFlight = 0;
    let maxConcurrent = 0;
    const completionOrder: string[] = [];

    await runSequentialDomainMutations(domains, async (domain) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Yield to the event loop — a concurrent caller would interleave here.
      await new Promise((resolve) => setTimeout(resolve, 1));
      completionOrder.push(domain);
      inFlight -= 1;
    });

    // The whole point of the fix: only one provider call is ever in flight.
    expect(maxConcurrent).toBe(1);
    expect(completionOrder).toEqual(domains);
  });

  it('does not invoke the operation for an empty domain list', async () => {
    let callCount = 0;
    await runSequentialDomainMutations([], async () => {
      callCount += 1;
    });
    expect(callCount).toBe(0);
  });

  it('preserves every change against a full-array (set_rules-style) provider', async () => {
    // Simulate a provider whose only mutation API replaces the ENTIRE rule
    // array per call (AdGuard Home's set_rules). Each addDomain does a
    // read-modify-write: GET current rules -> mutate -> POST full array.
    // Under the old concurrency-10 batching, ten calls would all read the
    // same baseline and the last POST would win, dropping the other nine.
    let serverRules: string[] = [];

    const addDomainViaSetRules = async (domain: string): Promise<void> => {
      // READ current rules from the "server".
      const current = [...serverRules];
      // Yield — gives any concurrent caller a chance to read the same stale
      // baseline. With sequential execution this is harmless.
      await new Promise((resolve) => setTimeout(resolve, 1));
      // MODIFY + WRITE the full array back.
      serverRules = [...current, domain];
    };

    const domains = Array.from({ length: 25 }, (_, i) => `domain-${i}.example.com`);
    await runSequentialDomainMutations(domains, addDomainViaSetRules);

    // No silent data loss: every domain made it into the final rule array.
    expect(serverRules).toHaveLength(domains.length);
    expect(new Set(serverRules)).toEqual(new Set(domains));
  });

  it('propagates the first error and stops processing remaining domains', async () => {
    const processed: string[] = [];
    const operation = async (domain: string): Promise<void> => {
      if (domain === 'bad.com') {
        throw new Error('provider rejected domain');
      }
      processed.push(domain);
    };

    await expect(
      runSequentialDomainMutations(['ok1.com', 'bad.com', 'ok2.com'], operation)
    ).rejects.toThrow('provider rejected domain');

    // Sequential execution means the failure halts before later domains run.
    expect(processed).toEqual(['ok1.com']);
  });
});

describe('tenantVisibleSyncError — no upstream body in stored sync error (SSRF read oracle)', () => {
  it('stores only the HTTP status line for a DnsProviderHttpError, never the upstream body', () => {
    const error = new DnsProviderHttpError(
      502,
      'Bad Gateway',
      'SECRET_INTERNAL_BODY_MARKER leaked from an upstream public host'
    );

    const stored = tenantVisibleSyncError(error);

    // The value persisted to lastSyncError / syncError is the body-free status line.
    expect(stored).toMatch(/HTTP \d{3}/);
    expect(stored).toBe('HTTP 502 Bad Gateway');
    // SECURITY: the upstream response body (the partial-read oracle) must NOT
    // appear in the tenant-visible column.
    expect(stored).not.toContain('SECRET_INTERNAL_BODY_MARKER');
    // ...and certainly not the raw responseBody field verbatim.
    expect(stored).not.toContain(error.responseBody);
  });

  it('stores the body-free message for an invalid-JSON DnsProviderHttpError', () => {
    const error = new DnsProviderHttpError(
      200,
      'OK',
      'not json SECRET_INTERNAL_BODY_MARKER',
      'Provider returned invalid JSON payload'
    );

    const stored = tenantVisibleSyncError(error);

    expect(stored).toBe('Provider returned invalid JSON payload');
    expect(stored).not.toContain('SECRET_INTERNAL_BODY_MARKER');
  });

  it('redacts secrets from a non-HTTP (transport) error message', () => {
    // Transport/SSRF errors carry no upstream body, but a Pi-hole URL can carry
    // ?auth=<apiKey> in a fetch error message — must still be redacted.
    const stored = tenantVisibleSyncError(
      new Error('connect failed for https://pihole.local/admin/api.php?auth=SUPERSECRETKEY')
    );

    expect(stored).not.toContain('SUPERSECRETKEY');
    expect(stored).toContain('[REDACTED]');
  });

  it('caps the stored value at 2000 chars', () => {
    const stored = tenantVisibleSyncError(new Error('x'.repeat(5000)));
    expect(stored.length).toBe(2000);
  });

  it('handles non-Error throwables without leaking', () => {
    expect(tenantVisibleSyncError('plain string failure')).toBe('plain string failure');
    expect(tenantVisibleSyncError(undefined)).toBe('undefined');
  });
});
