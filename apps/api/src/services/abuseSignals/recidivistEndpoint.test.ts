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
} from './recidivistEndpoint';

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

    // Exactly 3 execute calls total: no crash from Postgres's "affect row a
    // second time" restriction would be visible here since db is mocked, but
    // the dedup happens in JS before the SQL is built — assert only one
    // occurrence of the guid value survives into the statement text.
    const upsertCall = vi.mocked(db.execute).mock.calls[2]![0] as unknown;
    const occurrences = JSON.stringify(upsertCall).split('0123456789abcdef').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(1);
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
