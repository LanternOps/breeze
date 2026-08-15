import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
}));

import { db } from '../../db';
import {
  extractScreenConnectGuids,
  isDeniedHostname,
  syncEndpointFingerprints,
  loadRecidivistMatches,
  computeRecidivistSignals,
  type RecidivistMatch,
} from './recidivistEndpoint';
import { SIGNAL_DEFAULTS, type SignalConfig } from './config';

// All fixture partner/device ids below are invented UUID-shaped fixture
// values — never real tenants.

beforeEach(() => vi.clearAllMocks());

describe('extractScreenConnectGuids', () => {
  it('extracts a lowercase 16-hex GUID from a ScreenConnect Client display name', () => {
    expect(extractScreenConnectGuids('ScreenConnect Client (0123456789abcdef)')).toEqual([
      '0123456789abcdef',
    ]);
  });

  it('is case-sensitive on the label and hex digits, matching the brief exactly', () => {
    // Wrong case on the label: no match at all.
    expect(extractScreenConnectGuids('screenconnect client (0123456789abcdef)')).toEqual([]);
    // Uppercase hex digits: not [0-9a-f], so no match.
    expect(extractScreenConnectGuids('ScreenConnect Client (ABCDEF0123456789)')).toEqual([]);
  });

  it('extracts multiple distinct GUIDs from one string', () => {
    const name = 'ScreenConnect Client (0123456789abcdef); ScreenConnect Client (fedcba9876543210)';
    expect(extractScreenConnectGuids(name)).toEqual(['0123456789abcdef', 'fedcba9876543210']);
  });

  it('de-duplicates a repeated GUID', () => {
    const name = 'ScreenConnect Client (0123456789abcdef) ScreenConnect Client (0123456789abcdef)';
    expect(extractScreenConnectGuids(name)).toEqual(['0123456789abcdef']);
  });

  it('returns empty for unrelated software names', () => {
    expect(extractScreenConnectGuids('Google Chrome')).toEqual([]);
    expect(extractScreenConnectGuids('AnyDesk')).toEqual([]);
  });

  it('does not match a GUID shorter than 16 hex digits', () => {
    expect(extractScreenConnectGuids('ScreenConnect Client (abc123)')).toEqual([]);
  });

  it('does not match non-hex characters inside the parens', () => {
    expect(extractScreenConnectGuids('ScreenConnect Client (zzzzzzzzzzzzzzzz)')).toEqual([]);
  });
});

describe('isDeniedHostname', () => {
  it('denies empty and blank hostnames', () => {
    expect(isDeniedHostname('')).toBe(true);
    expect(isDeniedHostname('   ')).toBe(true);
  });

  it('denies localhost (case-insensitive)', () => {
    expect(isDeniedHostname('localhost')).toBe(true);
    expect(isDeniedHostname('LOCALHOST')).toBe(true);
  });

  it('denies a short WIN- default hostname', () => {
    expect(isDeniedHostname('WIN-ABC123')).toBe(true); // 10 chars, < 12
    expect(isDeniedHostname('win-abcdefg')).toBe(true); // 11 chars, < 12
  });

  it('allows a WIN- hostname at or above the length threshold', () => {
    expect(isDeniedHostname('WIN-ABCDEFGH')).toBe(false); // 12 chars
    expect(isDeniedHostname('WIN-ABCDEFGHIJ')).toBe(false); // 14 chars
  });

  it('allows an ordinary managed-looking hostname', () => {
    expect(isDeniedHostname('ACMEIT-DESKTOP-07')).toBe(false);
    expect(isDeniedHostname('finance-pc-12')).toBe(false);
  });
});

describe('syncEndpointFingerprints', () => {
  const now = new Date('2026-08-15T12:00:00Z');

  it('does nothing further when no software or device rows exist', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never) // software_inventory scan
      .mockResolvedValueOnce([] as never); // devices scan

    await syncEndpointFingerprints(now);

    expect(db.execute).toHaveBeenCalledTimes(2); // no upsert issued
  });

  it('extracts a remote_tool_guid fingerprint and issues an upsert', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([
        { device_id: 'device-1', partner_id: 'partner-a', name: 'ScreenConnect Client (0123456789abcdef)' },
      ] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never); // the upsert itself

    await syncEndpointFingerprints(now);

    expect(db.execute).toHaveBeenCalledTimes(3);
    const upsertCall = vi.mocked(db.execute).mock.calls[2]![0] as { strings: string[]; queryChunks?: unknown };
    const upsertSql = JSON.stringify(upsertCall);
    expect(upsertSql).toContain('remote_tool_guid');
    expect(upsertSql).toContain('0123456789abcdef');
    expect(upsertSql).toContain('partner-a');
  });

  it('records a hostname fingerprint (lowercased) but skips a denied hostname', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never) // software_inventory scan
      .mockResolvedValueOnce([
        { id: 'device-1', partner_id: 'partner-a', hostname: 'Finance-PC-01', last_seen_ip: null, enrollment_ip: null },
        { id: 'device-2', partner_id: 'partner-a', hostname: 'WIN-ABC123', last_seen_ip: null, enrollment_ip: null },
      ] as never)
      .mockResolvedValueOnce([] as never); // the upsert

    await syncEndpointFingerprints(now);

    const upsertCall = vi.mocked(db.execute).mock.calls[2]![0] as unknown;
    const upsertSql = JSON.stringify(upsertCall);
    expect(upsertSql).toContain('finance-pc-01');
    expect(upsertSql).not.toContain('win-abc123');
    expect(upsertSql).not.toContain('WIN-ABC123');
  });

  it('records egress_ip from last_seen_ip, falling back to enrollment_ip', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { id: 'device-1', partner_id: 'partner-a', hostname: '', last_seen_ip: '203.0.113.5', enrollment_ip: '198.51.100.9' },
        { id: 'device-2', partner_id: 'partner-b', hostname: '', last_seen_ip: null, enrollment_ip: '198.51.100.10' },
        { id: 'device-3', partner_id: 'partner-c', hostname: '', last_seen_ip: null, enrollment_ip: null },
      ] as never)
      .mockResolvedValueOnce([] as never);

    await syncEndpointFingerprints(now);

    const upsertCall = vi.mocked(db.execute).mock.calls[2]![0] as unknown;
    const upsertSql = JSON.stringify(upsertCall);
    expect(upsertSql).toContain('203.0.113.5'); // last_seen_ip wins over enrollment_ip
    expect(upsertSql).not.toContain('198.51.100.9');
    expect(upsertSql).toContain('198.51.100.10'); // fallback to enrollment_ip
  });

  it('de-dupes by (partnerId, kind, value) so one upsert row covers repeated observations', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([
        { device_id: 'device-1', partner_id: 'partner-a', name: 'ScreenConnect Client (0123456789abcdef)' },
        { device_id: 'device-2', partner_id: 'partner-a', name: 'ScreenConnect Client (0123456789abcdef)' },
      ] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    await syncEndpointFingerprints(now);

    // Postgres rejects an INSERT ... ON CONFLICT DO UPDATE that hits the same
    // row twice in one statement, so the dedup must collapse both software
    // rows down to exactly ONE VALUES row for this (partner, kind, value).
    // db is mocked, so that constraint can't fire here — instead assert the
    // guid value appears exactly once in the built statement, which is what
    // guarantees only one VALUES row was emitted for it.
    const upsertCall = vi.mocked(db.execute).mock.calls[2]![0] as unknown;
    const occurrences = JSON.stringify(upsertCall).split('0123456789abcdef').length - 1;
    expect(occurrences).toBe(1);
  });

  it('chunks the upsert into batches of at most 500 rows per statement when the corpus exceeds one chunk', async () => {
    // 1,200 distinct hostname rows across 1,200 distinct devices/partners ->
    // 1,200 distinct (partnerId, kind, value) keys, so none collapse in the
    // de-dup map. At 500 rows/chunk that must issue 3 upsert statements
    // (500 + 500 + 200), each with <= 500 VALUES tuples.
    const deviceRows = Array.from({ length: 1200 }, (_, i) => ({
      id: `device-${i}`,
      partner_id: `partner-${i}`,
      hostname: `finance-pc-${i}`,
      last_seen_ip: null,
      enrollment_ip: null,
    }));
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never) // software_inventory scan
      .mockResolvedValueOnce(deviceRows as never) // devices scan
      .mockResolvedValue([] as never); // the chunked upserts

    await syncEndpointFingerprints(now);

    // 2 setup calls + 3 upsert chunk calls.
    expect(db.execute).toHaveBeenCalledTimes(5);
    const chunkSizes = vi.mocked(db.execute).mock.calls.slice(2).map((call) => {
      const sqlObj = call[0] as { queryChunks?: unknown[] };
      // Each VALUES tuple appears as its own queryChunks entry boundary —
      // count occurrences of the fingerprint kind cast, one per row, as a
      // stand-in for "how many VALUES tuples landed in this statement".
      const asString = JSON.stringify(sqlObj);
      return asString.split('hostname').length - 1;
    });
    expect(chunkSizes).toEqual([500, 500, 200]);
    expect(chunkSizes.every((n) => n <= 500)).toBe(true);
  });

  it('truncates deterministically and warns when the corpus exceeds FINGERPRINT_UPSERTS_PER_SWEEP_CAP', async () => {
    // 10,050 distinct rows -> exceeds the 10,000 cap by 50; the sync must
    // truncate to exactly 10,000 (20 chunks of 500) and log a warning
    // instead of silently dropping the overflow unnoticed.
    const deviceRows = Array.from({ length: 10_050 }, (_, i) => ({
      id: `device-${i}`,
      partner_id: `partner-${i}`,
      hostname: `finance-pc-${i}`,
      last_seen_ip: null,
      enrollment_ip: null,
    }));
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce(deviceRows as never)
      .mockResolvedValue([] as never);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await syncEndpointFingerprints(now);

    // 2 setup calls + 20 upsert chunk calls (10,000 / 500).
    expect(db.execute).toHaveBeenCalledTimes(22);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('FINGERPRINT_UPSERTS_PER_SWEEP_CAP'));
    warnSpy.mockRestore();
  });
});

describe('loadRecidivistMatches', () => {
  it('shapes match rows and scanned partner ids from the two queries', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([
        {
          partner_id: 'partner-active',
          kind: 'remote_tool_guid',
          value: '0123456789abcdef',
          other_partner_id: 'partner-suspended',
          other_partner_name: 'Suspended Co',
          other_partner_status: 'suspended',
        },
      ] as never)
      .mockResolvedValueOnce([{ partner_id: 'partner-active' }] as never);

    const result = await loadRecidivistMatches();

    expect(result.matches).toEqual([
      {
        partnerId: 'partner-active',
        kind: 'remote_tool_guid',
        value: '0123456789abcdef',
        otherPartnerId: 'partner-suspended',
        otherPartnerName: 'Suspended Co',
        otherPartnerStatus: 'suspended',
      },
    ]);
    expect(result.scannedPartnerIds).toEqual(['partner-active']);
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it('returns empty matches and scannedPartnerIds when nothing correlates', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([] as never);

    const result = await loadRecidivistMatches();

    expect(result.matches).toEqual([]);
    expect(result.scannedPartnerIds).toEqual([]);
  });
});

describe('computeRecidivistSignals', () => {
  const cfg: SignalConfig = SIGNAL_DEFAULTS;

  function match(overrides: Partial<RecidivistMatch>): RecidivistMatch {
    return {
      partnerId: 'partner-active',
      kind: 'remote_tool_guid',
      value: 'v1',
      otherPartnerId: 'partner-suspended',
      otherPartnerName: 'Suspended Co',
      otherPartnerStatus: 'suspended',
      ...overrides,
    };
  }

  it('fires the fingerprint axis at fingerprint_score for any remote_tool_guid match', () => {
    const signals = computeRecidivistSignals([match({ kind: 'remote_tool_guid', value: 'abc' })], cfg);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.score).toBe(cfg['rmm.recidivist_endpoint.fingerprint_score']);
    expect(signals[0]!.severity).toBe('alert');
    expect((signals[0]!.evidence as { axes: string[] }).axes).toEqual(['fingerprint']);
  });

  it('fires the hostname axis alone at hostname_score when there is no same-counterpart ip match', () => {
    const signals = computeRecidivistSignals([match({ kind: 'hostname', value: 'finance-pc-01' })], cfg);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.score).toBe(cfg['rmm.recidivist_endpoint.hostname_score']);
    expect((signals[0]!.evidence as { axes: string[] }).axes).toEqual(['hostname']);
  });

  it('upgrades to hostname_ip when hostname and egress_ip match the SAME other partner', () => {
    const signals = computeRecidivistSignals(
      [
        match({ kind: 'hostname', value: 'finance-pc-01', otherPartnerId: 'partner-suspended' }),
        match({ kind: 'egress_ip', value: '203.0.113.5', otherPartnerId: 'partner-suspended' }),
      ],
      cfg,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.score).toBe(cfg['rmm.recidivist_endpoint.hostname_ip_score']);
    expect((signals[0]!.evidence as { axes: string[] }).axes).toEqual(['hostname_ip']);
  });

  it('stays at hostname_score (not hostname_ip) when the hostname and ip matches are against DIFFERENT other-partners', () => {
    const signals = computeRecidivistSignals(
      [
        match({ kind: 'hostname', value: 'finance-pc-01', otherPartnerId: 'partner-suspended-a' }),
        match({ kind: 'egress_ip', value: '203.0.113.5', otherPartnerId: 'partner-suspended-b' }),
      ],
      cfg,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.score).toBe(cfg['rmm.recidivist_endpoint.hostname_score']);
    expect((signals[0]!.evidence as { axes: string[] }).axes).toEqual(['hostname']);
  });

  it('emits no signal for an egress_ip-only match', () => {
    const signals = computeRecidivistSignals([match({ kind: 'egress_ip', value: '203.0.113.5' })], cfg);
    expect(signals).toEqual([]);
  });

  it('scores the MAX of matched axes, never the sum, when a partner matches all three', () => {
    const signals = computeRecidivistSignals(
      [
        match({ kind: 'remote_tool_guid', value: 'abc', otherPartnerId: 'partner-suspended' }),
        match({ kind: 'hostname', value: 'finance-pc-01', otherPartnerId: 'partner-suspended' }),
        match({ kind: 'egress_ip', value: '203.0.113.5', otherPartnerId: 'partner-suspended' }),
      ],
      cfg,
    );
    expect(signals).toHaveLength(1);
    // fingerprint (100) beats hostname_ip (90) — max, not 100+90+... summed.
    expect(signals[0]!.score).toBe(cfg['rmm.recidivist_endpoint.fingerprint_score']);
    expect((signals[0]!.evidence as { axes: string[] }).axes).toEqual(
      expect.arrayContaining(['fingerprint', 'hostname_ip']),
    );
  });

  it('maps severity at defaults: fingerprint and hostname_ip alert, hostname watch', () => {
    const fingerprintSignal = computeRecidivistSignals([match({ kind: 'remote_tool_guid' })], cfg)[0]!;
    expect(fingerprintSignal.score).toBe(100);
    expect(fingerprintSignal.severity).toBe('alert');

    const hostnameIpSignal = computeRecidivistSignals(
      [
        match({ kind: 'hostname', otherPartnerId: 'partner-suspended' }),
        match({ kind: 'egress_ip', otherPartnerId: 'partner-suspended' }),
      ],
      cfg,
    )[0]!;
    expect(hostnameIpSignal.score).toBe(90);
    expect(hostnameIpSignal.severity).toBe('alert');

    const hostnameSignal = computeRecidivistSignals([match({ kind: 'hostname' })], cfg)[0]!;
    expect(hostnameSignal.score).toBe(60);
    expect(hostnameSignal.severity).toBe('watch');
  });

  it('respects overridden axis scores via injected SignalConfig', () => {
    const overridden: SignalConfig = { ...cfg, 'rmm.recidivist_endpoint.fingerprint_score': 42 };
    const signals = computeRecidivistSignals([match({ kind: 'remote_tool_guid' })], overridden);
    expect(signals[0]!.score).toBe(42);
  });

  it('caps evidence.matches to the first 10 matches for a partner', () => {
    const matches = Array.from({ length: 15 }, (_, i) =>
      match({ kind: 'hostname', value: `host-${i}`, otherPartnerId: `partner-suspended-${i}` }),
    );
    const signals = computeRecidivistSignals(matches, cfg);
    expect(signals).toHaveLength(1);
    expect((signals[0]!.evidence as { matches: unknown[] }).matches).toHaveLength(10);
  });

  it('never re-checks partner status — trusts whatever matches it is given (direction rule enforced upstream in SQL)', () => {
    // A match whose otherPartnerStatus is 'active' would never legitimately
    // reach this function (Task 2's SQL join filters it out), but the scorer
    // itself has no status-checking logic at all — it fires on the shape of
    // the input alone, documenting that the contract lives in the SQL, not here.
    const signals = computeRecidivistSignals(
      [match({ kind: 'remote_tool_guid', otherPartnerStatus: 'active' })],
      cfg,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.score).toBe(cfg['rmm.recidivist_endpoint.fingerprint_score']);
  });
});
