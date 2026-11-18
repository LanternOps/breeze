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
import { computeCorroborationSignals } from './corroboration';
import type { ComputedSignal } from './types';

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

  // #11843: role-style names that many unrelated sites choose carry no
  // per-install entropy. A cross-partner collision on one is coincidence, not
  // a reused box.
  it('denies bare generic role hostnames (case-insensitive)', () => {
    for (const h of ['server', 'SERVER', 'Server', 'dc', 'fileserver', 'desktop', 'laptop', 'pc', 'admin', 'reception', 'workstation', 'nas']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  it('denies a generic role name with a short numeric suffix', () => {
    for (const h of ['dc01', 'DC-01', 'dc_2', 'server1', 'server-2', 'server2019', 'server9999', 'dc9999', 'srv-01', 'pc-0042']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  it('denies a generic role name with a single-letter suffix', () => {
    for (const h of ['SERVER-A', 'dc-b', 'pc-a', 'srv-x']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  it('denies fused role compounds', () => {
    for (const h of ['appserver', 'mailserver', 'dbserver', 'vpn', 'rdsh01']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  it('denies a hostname made only of generic words and short numbers', () => {
    for (const h of ['file-server', 'office-pc-01', 'front-desk', 'new-server', 'reception-pc', 'macbook-pro']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  it('denies a generic name under a generic DNS suffix', () => {
    for (const h of ['server.local', 'dc01.corp.local', 'desktop.localdomain', 'localhost.localdomain']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  it('denies OS-installer default names that every fresh install shares', () => {
    for (const h of ['ubuntu', 'debian', 'raspberrypi', 'kali']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  it('denies hostnames too short or too numeric to identify anything', () => {
    for (const h of ['x', 'ab', '01', '1234', 'a-1']) {
      expect(isDeniedHostname(h), h).toBe(true);
    }
  });

  // True positives the detector exists for must keep entering the corpus.
  it('keeps hostnames that carry per-install or per-site entropy', () => {
    for (const h of [
      'DESKTOP-AB12CD3', // Windows 10/11 default: 7 random chars
      'LAPTOP-9QK2M7XZ',
      'WIN-ABCDEFGHIJ', // Windows Setup default (intentionally kept, see WIN- rule)
      'acmeit-desktop-07', // site/org token
      'jsmith-laptop', // person token
      'server.contoso.local', // generic label, distinctive domain
      'srvacme01', // generic prefix fused to a site token
      'pc-48213', // 5-digit asset tag
      'server12345', // 5 fused digits: an asset tag, not a sequence number
      'dc12345',
      'pc-2019-0042', // 8 digits split across labels: still an asset tag
      'server-12-34-56-78',
      'file-acme-server', // distinctive label in the middle
      'server.local.acmecorp', // ...or at the end
      'kingstn.local',
      'server-kingstn',
      'сервер-бухгалтерия', // non-Latin names are distinctive, not "too short"
      'касса-1',
      'kingstn',
      'vps-7f3a9c',
    ]) {
      expect(isDeniedHostname(h), h).toBe(false);
    }
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
    const upsertCall = vi.mocked(db.execute).mock.calls[2]![0] as unknown;
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

  it('skips a generic role hostname so it never enters the cross-partner corpus (#11843)', async () => {
    vi.mocked(db.execute)
      .mockResolvedValueOnce([] as never) // software_inventory scan
      .mockResolvedValueOnce([
        { id: 'device-1', partner_id: 'partner-a', hostname: 'Finance-PC-01', last_seen_ip: null, enrollment_ip: null },
        { id: 'device-2', partner_id: 'partner-a', hostname: 'SERVER', last_seen_ip: null, enrollment_ip: null },
        { id: 'device-3', partner_id: 'partner-a', hostname: 'DC01', last_seen_ip: null, enrollment_ip: null },
      ] as never)
      .mockResolvedValueOnce([] as never); // the upsert

    await syncEndpointFingerprints(now);

    const upsertSql = JSON.stringify(vi.mocked(db.execute).mock.calls[2]![0] as unknown);
    expect(upsertSql).toContain('finance-pc-01');
    expect(upsertSql).not.toMatch(/"server"/);
    expect(upsertSql).not.toMatch(/"dc01"/);
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
        match({ kind: 'hostname', value: 'finance-pc-01', otherPartnerId: 'partner-suspended' }),
        match({ kind: 'egress_ip', value: '203.0.113.5', otherPartnerId: 'partner-suspended' }),
      ],
      cfg,
    )[0]!;
    expect(hostnameIpSignal.score).toBe(90);
    expect(hostnameIpSignal.severity).toBe('alert');

    const hostnameSignal = computeRecidivistSignals([match({ kind: 'hostname', value: 'finance-pc-01' })], cfg)[0]!;
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
      match({ kind: 'hostname', value: `acme-host-${i}`, otherPartnerId: `partner-suspended-${i}` }),
    );
    const signals = computeRecidivistSignals(matches, cfg);
    expect(signals).toHaveLength(1);
    expect((signals[0]!.evidence as { matches: unknown[] }).matches).toHaveLength(10);
  });

  // #11843: corpus rows written before the deny rule grew are never deleted
  // (the sync only upserts), so the scorer must ignore them too or a stale
  // 'server' row keeps an open signal alive forever.
  it('ignores a hostname match on a generic role name already in the corpus', () => {
    expect(computeRecidivistSignals([match({ kind: 'hostname', value: 'server' })], cfg)).toEqual([]);
  });

  it('drops generic hostname matches before the evidence cap, so they never take up evidence slots', () => {
    const matches = [
      ...Array.from({ length: 12 }, (_, i) => match({ kind: 'hostname', value: 'server', otherPartnerId: `partner-suspended-${i}` })),
      ...Array.from({ length: 3 }, (_, i) => match({ kind: 'hostname', value: `acme-host-${i}`, otherPartnerId: `partner-other-${i}` })),
    ];
    const signals = computeRecidivistSignals(matches, cfg);
    expect(signals).toHaveLength(1);
    const evidence = signals[0]!.evidence as { matches: Array<{ value: string }> };
    expect(evidence.matches.map((m) => m.value)).toEqual(['acme-host-0', 'acme-host-1', 'acme-host-2']);
  });

  it('only filters hostname matches — a guid or ip value is never run through the hostname deny rule', () => {
    const signals = computeRecidivistSignals(
      [
        match({ kind: 'hostname', value: 'finance-pc-01', otherPartnerId: 'partner-suspended' }),
        match({ kind: 'egress_ip', value: '10.0.0.1', otherPartnerId: 'partner-suspended' }),
      ],
      cfg,
    );
    expect((signals[0]!.evidence as { axes: string[] }).axes).toEqual(['hostname_ip']);
  });

  it('does not upgrade a generic hostname plus a same-counterpart ip match to hostname_ip', () => {
    const signals = computeRecidivistSignals(
      [
        match({ kind: 'hostname', value: 'server', otherPartnerId: 'partner-suspended' }),
        match({ kind: 'egress_ip', value: '203.0.113.5', otherPartnerId: 'partner-suspended' }),
      ],
      cfg,
    );
    expect(signals).toEqual([]);
  });

  it('still fires the fingerprint axis alongside a generic hostname match, and drops the generic match from evidence', () => {
    const signals = computeRecidivistSignals(
      [
        match({ kind: 'remote_tool_guid', value: 'abc' }),
        match({ kind: 'hostname', value: 'server' }),
      ],
      cfg,
    );
    expect(signals).toHaveLength(1);
    const evidence = signals[0]!.evidence as { axes: string[]; matches: Array<{ value: string }> };
    expect(evidence.axes).toEqual(['fingerprint']);
    expect(evidence.matches.map((m) => m.value)).toEqual(['abc']);
  });

  it('a generic hostname match no longer corroborates an enrollment burst into fraud.corroborated_watch', () => {
    const burst: ComputedSignal = {
      partnerId: 'partner-active',
      signalKey: 'rmm.enrollment_velocity',
      score: 55,
      severity: 'watch',
      evidence: {},
    };
    const generic = computeRecidivistSignals([match({ kind: 'hostname', value: 'server' })], cfg);
    expect(computeCorroborationSignals([...generic, burst], cfg)).toEqual([]);

    // Control: the same burst with a distinctive hostname match still corroborates.
    const distinctive = computeRecidivistSignals([match({ kind: 'hostname', value: 'finance-pc-01' })], cfg);
    const corroborated = computeCorroborationSignals([...distinctive, burst], cfg);
    expect(corroborated.map((s) => s.signalKey)).toEqual(['fraud.corroborated_watch']);
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
