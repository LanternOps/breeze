import { describe, expect, it } from 'vitest';
import { readTlsObservation } from './tlsObservation';

/**
 * The agent's untyped `details` map is the only source of the typed tls_*
 * columns (#5754). The parser is separated from the worker so the decisions
 * that matter — "no ssl* keys at all means do not touch the observation" and
 * "a handshake failure clears the expiry" — are testable without a database.
 */
describe('readTlsObservation', () => {
  it('returns null when the result carries no sslState at all (an icmp/dns/tcp monitor)', () => {
    expect(readTlsObservation(undefined)).toBeNull();
    expect(readTlsObservation({})).toBeNull();
    expect(readTlsObservation({ monitorId: 'm', status: 'online', responseMs: 12 })).toBeNull();
  });

  it('parses an observed certificate into typed values', () => {
    const got = readTlsObservation({
      sslState: 'observed',
      sslExpiry: '2027-01-02T03:04:05Z',
      sslIssuer: 'CN=Example CA,O=Example Inc',
      sslObservedHost: 'final.example.com:443',
    });

    expect(got).not.toBeNull();
    expect(got!.state).toBe('observed');
    expect(got!.issuer).toBe('CN=Example CA,O=Example Inc');
    expect(got!.observedHost).toBe('final.example.com:443');
    expect(got!.notAfter?.toISOString()).toBe('2027-01-02T03:04:05.000Z');
  });

  it('reports handshake_failed with no certificate values, so a null expiry never reads as fine', () => {
    const got = readTlsObservation({
      sslState: 'handshake_failed',
      sslObservedHost: 'broken.example.com:443',
    });

    expect(got!.state).toBe('handshake_failed');
    expect(got!.notAfter).toBeNull();
    expect(got!.issuer).toBeNull();
    expect(got!.observedHost).toBe('broken.example.com:443');
  });

  it('reports not_tls for a plain-HTTP check', () => {
    const got = readTlsObservation({ sslState: 'not_tls', sslObservedHost: 'plain.example.com' });
    expect(got!.state).toBe('not_tls');
    expect(got!.notAfter).toBeNull();
  });

  it('drops an unparseable sslExpiry rather than writing an invalid date', () => {
    const got = readTlsObservation({
      sslState: 'observed',
      sslExpiry: 'not-a-date',
      sslObservedHost: 'h.example.com',
    });
    expect(got!.notAfter).toBeNull();
  });

  it('rejects an unknown sslState rather than writing a value the CHECK refuses', () => {
    expect(readTlsObservation({ sslState: 'totally_bogus', sslObservedHost: 'h' })).toBeNull();
    expect(readTlsObservation({ sslState: 42 })).toBeNull();
  });

  it('truncates issuer and host to the varchar(255) column width', () => {
    const got = readTlsObservation({
      sslState: 'observed',
      sslExpiry: '2027-01-02T03:04:05Z',
      sslIssuer: 'x'.repeat(400),
      sslObservedHost: 'y'.repeat(400),
    });
    expect(got!.issuer!.length).toBe(255);
    expect(got!.observedHost!.length).toBe(255);
  });

  it('treats an empty issuer or host as absent rather than writing an empty string', () => {
    const got = readTlsObservation({
      sslState: 'observed',
      sslExpiry: '2027-01-02T03:04:05Z',
      sslIssuer: '',
      sslObservedHost: '',
    });
    expect(got!.issuer).toBeNull();
    expect(got!.observedHost).toBeNull();
  });
});

describe('tlsObservationUpdate', () => {
  it('is empty for a result with no TLS keys, so a sibling monitor never clobbers a good observation', async () => {
    const { tlsObservationUpdate } = await import('./tlsObservation');
    expect(tlsObservationUpdate(undefined, new Date())).toEqual({});
  });

  it('clears not_after and issuer on handshake_failed while recording the state', async () => {
    const { tlsObservationUpdate } = await import('./tlsObservation');
    const now = new Date('2026-09-15T00:00:00Z');
    expect(tlsObservationUpdate({ sslState: 'handshake_failed', sslObservedHost: 'h' }, now)).toEqual({
      tlsState: 'handshake_failed',
      tlsObservedAt: now,
      tlsObservedHost: 'h',
      tlsNotAfter: null,
      tlsIssuer: null,
    });
  });

  it('never emits an observed row missing the values the shape CHECK requires', async () => {
    const { tlsObservationUpdate } = await import('./tlsObservation');
    const now = new Date('2026-09-15T00:00:00Z');
    // 'observed' with an unparseable expiry would violate
    // network_monitors_tls_observed_shape_chk, so it degrades rather than
    // aborting the whole check-result transaction with a 23514.
    const update = tlsObservationUpdate(
      { sslState: 'observed', sslExpiry: 'nope', sslObservedHost: 'h' },
      now,
    );
    expect(update.tlsState).not.toBe('observed');
    expect(update.tlsNotAfter).toBeNull();
  });

  // The agent truncates its echo to 255 BYTES, so for a long URL the two sides
  // of the provenance comparison are NOT the same string. Comparing them raw
  // would drop every observation for such a monitor forever, even though it
  // was never edited — a permanent silent outage of the whole feature for any
  // endpoint with a long query string.
  it('accepts a truncated echo of a URL longer than the agent can send', async () => {
    const { tlsObservationUpdate } = await import('./tlsObservation');
    const longUrl = `https://a.example/${'q'.repeat(400)}`;
    const update = tlsObservationUpdate(
      {
        sslState: 'observed',
        sslExpiry: '2027-01-02T03:04:05Z',
        sslIssuer: 'CN=CA',
        sslObservedHost: 'a.example',
        sslRequestedUrl: Buffer.from(longUrl, 'utf8').subarray(0, 255).toString('utf8'),
      },
      new Date(),
      { expectedRequestUrl: longUrl },
    );
    expect(update.tlsState).toBe('observed');
  });

  it('still rejects a SHORT echo that is merely a prefix of the current URL', async () => {
    const { tlsObservationUpdate } = await import('./tlsObservation');
    // The stale case: the monitor used to point at https://a.example and now
    // points at https://a.example/x. A prefix rule applied unconditionally
    // would wrongly accept this.
    const update = tlsObservationUpdate(
      {
        sslState: 'observed',
        sslExpiry: '2027-01-02T03:04:05Z',
        sslIssuer: 'CN=CA',
        sslObservedHost: 'a.example',
        sslRequestedUrl: 'https://a.example',
      },
      new Date(),
      { expectedRequestUrl: 'https://a.example/x' },
    );
    expect(update).toEqual({});
  });

  it('tolerates surrounding whitespace on either side rather than dropping forever', async () => {
    const { tlsObservationUpdate } = await import('./tlsObservation');
    const update = tlsObservationUpdate(
      {
        sslState: 'observed',
        sslExpiry: '2027-01-02T03:04:05Z',
        sslIssuer: 'CN=CA',
        sslObservedHost: 'a.example',
        sslRequestedUrl: ' https://a.example ',
      },
      new Date(),
      { expectedRequestUrl: 'https://a.example' },
    );
    expect(update.tlsState).toBe('observed');
  });

  it('writes a complete observed row when the agent supplied everything', async () => {
    const { tlsObservationUpdate } = await import('./tlsObservation');
    const now = new Date('2026-09-15T00:00:00Z');
    const update = tlsObservationUpdate(
      {
        sslState: 'observed',
        sslExpiry: '2027-01-02T03:04:05Z',
        sslIssuer: 'CN=Example CA',
        sslObservedHost: 'final.example.com',
      },
      now,
    );
    expect(update).toEqual({
      tlsState: 'observed',
      tlsObservedAt: now,
      tlsObservedHost: 'final.example.com',
      tlsNotAfter: new Date('2027-01-02T03:04:05Z'),
      tlsIssuer: 'CN=Example CA',
    });
  });
});
