import { afterEach, describe, expect, it, vi } from 'vitest';
import { learnedNetworksIngestEnabled } from '../../config/env';
import { attachmentDigest, planNetworkAttachmentIngest, type AttachmentDeviceState } from './ingest';
import { parseNetworkAttachmentsReport, type NetworkAttachmentsReport } from '@breeze/shared';
import {
  LEARNED_NETWORKS_PER_ORG_MAX, NETWORK_ATTACHMENT_FRESHNESS_MS, NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS,
  NETWORK_DEVICE_RETENTION_DAYS, UNASSIGNED_NETWORK_RETENTION_DAYS, WAN_ADDRESSES_PER_NETWORK_MAX,
} from './constants';

const NOW = new Date('2026-11-20T15:05:00Z');

const att = (o: Record<string, unknown> = {}) => ({
  interfaceName: 'Ethernet', localAddress: '192.168.1.57', prefixLength: 24, gatewayAddress: '192.168.1.1',
  gatewayMac: 'a4:2b:b0:11:22:9c', primary: true, ...o,
});
const report = (o: Record<string, unknown> = {}) => ({
  epoch: '9f2c1e7ab4d04c11', sequence: 418, capturedAt: '2026-11-20T15:04:05Z', complete: true,
  attachments: [att()], ...o,
});
const parsed = (raw: unknown): NetworkAttachmentsReport => {
  const r = parseNetworkAttachmentsReport(raw);
  if (!r.accepted) throw new Error('fixture did not parse');
  return r.report;
};

const DEVICE: AttachmentDeviceState = {
  id: '00000000-0000-4000-8000-000000000001', orgId: '00000000-0000-4000-8000-000000000002', isEphemeral: false,
  networkAttachmentEpoch: '9f2c1e7ab4d04c11', networkAttachmentSequence: 418,
  networkAttachmentDigest: attachmentDigest(parsed(report()), '203.0.113.20'),
};

afterEach(() => { vi.unstubAllEnvs(); });

describe('constants (E2)', () => {
  it('match the spec limits', () => {
    expect(NETWORK_ATTACHMENT_FRESHNESS_MS).toBe(600_000);
    expect(NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS).toBe(600_000);
    expect(LEARNED_NETWORKS_PER_ORG_MAX).toBe(5_000);
    expect(WAN_ADDRESSES_PER_NETWORK_MAX).toBe(32);
    expect(UNASSIGNED_NETWORK_RETENTION_DAYS).toBe(90);
    expect(NETWORK_DEVICE_RETENTION_DAYS).toBe(90);
  });
});

describe('learnedNetworksIngestEnabled', () => {
  it('is on when unset or empty and off for false or 0', () => {
    vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', undefined);
    expect(learnedNetworksIngestEnabled()).toBe(true);
    vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', '');
    expect(learnedNetworksIngestEnabled()).toBe(true);
    vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false');
    expect(learnedNetworksIngestEnabled()).toBe(false);
    vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', '0');
    expect(learnedNetworksIngestEnabled()).toBe(false);
  });
});

describe('planNetworkAttachmentIngest', () => {
  it.each([
    ['absent', () => {}, {}, undefined],
    ['disabled', () => vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false'), {}, report({ sequence: 419 })],
    ['ephemeral', () => {}, { isEphemeral: true }, report({ sequence: 419 })],
    ['invalid_report', () => {}, {}, { epoch: 'nope' }],
    ['invalid_report', () => {}, {}, null],
    ['stale_sequence', () => {}, {}, report({ sequence: 418 })],
    ['stale_sequence', () => {}, {}, report({ sequence: 17 })],
    ['capture_time_out_of_bounds', () => {}, {}, report({ sequence: 419, capturedAt: '2026-11-20T14:54:59Z' })],
    ['capture_time_out_of_bounds', () => {}, {}, report({ sequence: 419, capturedAt: '2026-11-20T15:15:01Z' })],
  ] as const)('ignores with %s', (reason, arrange, over, raw) => {
    arrange();
    expect(planNetworkAttachmentIngest({ ...DEVICE, ...over }, raw, '203.0.113.20', NOW)).toEqual({ kind: 'ignore', reason });
  });

  it('first ignore reason wins', () => {
    vi.stubEnv('LEARNED_NETWORKS_INGEST_ENABLED', 'false');
    expect(planNetworkAttachmentIngest({ ...DEVICE, isEphemeral: true }, undefined, null, NOW)).toEqual({ kind: 'ignore', reason: 'absent' });
    expect(planNetworkAttachmentIngest({ ...DEVICE, isEphemeral: true }, { epoch: 'nope' }, null, NOW)).toEqual({ kind: 'ignore', reason: 'disabled' });
    vi.unstubAllEnvs();
    expect(planNetworkAttachmentIngest({ ...DEVICE, isEphemeral: true }, { epoch: 'nope' }, null, NOW)).toEqual({ kind: 'ignore', reason: 'ephemeral' });
    expect(planNetworkAttachmentIngest(DEVICE, { epoch: 'nope', capturedAt: '2026-11-19T00:00:00Z' }, null, NOW)).toEqual({ kind: 'ignore', reason: 'invalid_report' });
    expect(planNetworkAttachmentIngest(DEVICE, report({ sequence: 1, capturedAt: '2026-11-19T00:00:00Z' }), null, NOW)).toEqual({ kind: 'ignore', reason: 'stale_sequence' });
  });

  it('accepts capturedAt exactly 10 minutes either side', () => {
    for (const capturedAt of ['2026-11-20T14:55:00Z', '2026-11-20T15:15:00Z']) {
      expect(planNetworkAttachmentIngest(DEVICE, report({ sequence: 419, capturedAt }), '203.0.113.20', NOW).kind).toBe('confirm');
    }
  });

  it('same epoch, higher sequence, same content: confirm with the new sequence and NOW', () => {
    expect(planNetworkAttachmentIngest(DEVICE, report({ sequence: 419 }), '203.0.113.20', NOW)).toEqual({
      kind: 'confirm',
      deviceFields: {
        networkAttachmentEpoch: '9f2c1e7ab4d04c11', networkAttachmentSequence: 419,
        networkAttachmentDigest: DEVICE.networkAttachmentDigest, networkAttachmentsConfirmedAt: NOW,
      },
    });
  });

  it('a capturedAt change alone is a confirm', () => {
    expect(planNetworkAttachmentIngest(DEVICE, report({ sequence: 419, capturedAt: '2026-11-20T15:00:00Z' }), '203.0.113.20', NOW).kind)
      .toBe('confirm');
  });

  it('a different epoch replaces stored state even with a lower sequence', () => {
    const epoch = '0000000000000001';
    expect(planNetworkAttachmentIngest(DEVICE, report({ epoch, sequence: 1 }), '203.0.113.20', NOW)).toEqual({
      kind: 'confirm',
      deviceFields: {
        networkAttachmentEpoch: epoch, networkAttachmentSequence: 1,
        networkAttachmentDigest: DEVICE.networkAttachmentDigest, networkAttachmentsConfirmedAt: NOW,
      },
    });
    expect(planNetworkAttachmentIngest(DEVICE, report({ epoch, sequence: 1, attachments: [att({ localAddress: '192.168.1.58' })] }), '203.0.113.20', NOW))
      .toMatchObject({ kind: 'apply', deviceFields: { networkAttachmentEpoch: epoch, networkAttachmentSequence: 1 } });
  });

  it('changed content, a changed WAN, or complete flipping each produce apply', () => {
    for (const [raw, wan] of [
      [report({ sequence: 419, attachments: [att({ localAddress: '192.168.1.58' })] }), '203.0.113.20'],
      [report({ sequence: 419 }), '198.51.100.7'],
      [report({ sequence: 419, complete: false }), '203.0.113.20'],
    ] as const) {
      expect(planNetworkAttachmentIngest(DEVICE, raw, wan, NOW)).toMatchObject({ kind: 'apply', deviceFields: { networkAttachmentSequence: 419 } });
    }
  });

  it('apply carries the parsed report, the normalized WAN and the new digest', () => {
    const raw = report({ sequence: 419, attachments: [att({ gatewayMac: 'A4-2B-B0-11-22-9C', localAddress: '192.168.1.58' })] });
    const plan = planNetworkAttachmentIngest(DEVICE, raw, '198.51.100.7', NOW);
    expect(plan).toEqual({
      kind: 'apply',
      report: parsed(raw),
      wanAddress: '198.51.100.7',
      deviceFields: {
        networkAttachmentEpoch: '9f2c1e7ab4d04c11', networkAttachmentSequence: 419,
        networkAttachmentDigest: attachmentDigest(parsed(raw), '198.51.100.7'), networkAttachmentsConfirmedAt: NOW,
      },
    });
    expect(plan.kind === 'apply' && plan.report.attachments[0]!.gatewayMac).toBe('a4:2b:b0:11:22:9c');
  });

  it('first report on a device with no stored state applies', () => {
    const fresh = { ...DEVICE, networkAttachmentEpoch: null, networkAttachmentSequence: null, networkAttachmentDigest: null };
    expect(planNetworkAttachmentIngest(fresh, report({ sequence: 0 }), null, NOW)).toMatchObject({ kind: 'apply', wanAddress: null });
  });

  it('an empty complete list is a report (on no network), not an ignore', () => {
    expect(planNetworkAttachmentIngest(DEVICE, report({ sequence: 419, attachments: [] }), '203.0.113.20', NOW))
      .toMatchObject({ kind: 'apply', wanAddress: null });
  });

  it('WAN is kept only when public and a primary attachment has a MAC', () => {
    const fresh = { ...DEVICE, networkAttachmentEpoch: null, networkAttachmentSequence: null, networkAttachmentDigest: null };
    const wanOf = (raw: unknown, wan: string | null) => {
      const plan = planNetworkAttachmentIngest(fresh, raw, wan, NOW);
      if (plan.kind !== 'apply') throw new Error(`expected apply, got ${plan.kind}`);
      return plan.wanAddress;
    };
    for (const wan of ['192.168.1.20', '10.1.2.57', 'unknown', '', null]) expect(wanOf(report(), wan), String(wan)).toBeNull();
    expect(wanOf(report({ attachments: [att({ gatewayMac: null })] }), '198.51.100.7')).toBeNull();
    expect(wanOf(report({ attachments: [att({ primary: false })] }), '198.51.100.7')).toBeNull();
    expect(wanOf(report(), '198.51.100.7')).toBe('198.51.100.7');
    expect(wanOf(report({ attachments: [att({ primary: false }), att({ interfaceName: 'Wi-Fi', gatewayAddress: '10.1.2.100', localAddress: '10.1.2.57', gatewayMac: '00:1a:8c:00:00:01' })] }), '203.0.113.20'))
      .toBe('203.0.113.20');
  });

  it('a placeholder or multicast gateway MAC on the primary attachment behaves exactly as a null MAC', () => {
    const fresh = { ...DEVICE, networkAttachmentEpoch: null, networkAttachmentSequence: null, networkAttachmentDigest: null };
    const nullMac = planNetworkAttachmentIngest(fresh, report({ attachments: [att({ gatewayMac: null })] }), '198.51.100.7', NOW);
    for (const gatewayMac of ['02:00:00:00:00:00', '02-00-00-00-00-00', '01:00:5e:00:00:01', 'FF:FF:FF:FF:FF:FF']) {
      const plan = planNetworkAttachmentIngest(fresh, report({ attachments: [att({ gatewayMac })] }), '198.51.100.7', NOW);
      expect(plan, gatewayMac).toEqual(nullMac);
      expect(plan.kind === 'apply' && plan.wanAddress, gatewayMac).toBeNull();
    }
    const kept = planNetworkAttachmentIngest(fresh, report({ attachments: [att({ gatewayMac: '3C:37:86:AA:BB:10' })] }), '198.51.100.7', NOW);
    expect(kept).toMatchObject({ kind: 'apply', wanAddress: '198.51.100.7' });
    expect(kept.kind === 'apply' && kept.report.attachments[0]!.gatewayMac).toBe('3c:37:86:aa:bb:10');
  });
});

describe('attachmentDigest', () => {
  const two = [
    att(),
    att({ interfaceName: 'Wi-Fi', localAddress: '10.1.2.57', gatewayAddress: '10.1.2.100', gatewayMac: '00:1a:8c:00:00:01', primary: false }),
  ];
  const base = parsed(report({ attachments: two }));

  it('is 64 lower-case hex chars', () => {
    expect(attachmentDigest(base, '203.0.113.20')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores epoch, sequence, capturedAt and attachment order', () => {
    const other = parsed(report({
      epoch: '0000000000000001', sequence: 7, capturedAt: '2026-11-20T15:00:00Z', attachments: [...two].reverse(),
    }));
    expect(attachmentDigest(other, '203.0.113.20')).toBe(attachmentDigest(base, '203.0.113.20'));
  });

  it('orders by gateway address and MAC within one interface name', () => {
    const a = att({ gatewayAddress: '192.168.1.1', gatewayMac: 'a4:2b:b0:11:22:9c' });
    const b = att({ gatewayAddress: '192.168.1.1', gatewayMac: null });
    const c = att({ gatewayAddress: '10.1.2.100', gatewayMac: '3c:37:86:aa:bb:10' });
    expect(attachmentDigest(parsed(report({ attachments: [a, b, c] })), null))
      .toBe(attachmentDigest(parsed(report({ attachments: [c, a, b] })), null));
  });

  it('changes with every other field', () => {
    const digest = attachmentDigest(base, '203.0.113.20');
    const variants: NetworkAttachmentsReport[] = [
      { ...base, attachments: [{ ...base.attachments[0]!, interfaceName: 'Ethernet 2' }, base.attachments[1]!] },
      { ...base, attachments: [{ ...base.attachments[0]!, localAddress: '192.168.1.58' }, base.attachments[1]!] },
      { ...base, attachments: [{ ...base.attachments[0]!, prefixLength: 25 }, base.attachments[1]!] },
      { ...base, attachments: [{ ...base.attachments[0]!, gatewayAddress: '192.168.1.2' }, base.attachments[1]!] },
      { ...base, attachments: [{ ...base.attachments[0]!, gatewayMac: '3c:37:86:aa:bb:10' }, base.attachments[1]!] },
      { ...base, attachments: [{ ...base.attachments[0]!, gatewayMac: null }, base.attachments[1]!] },
      { ...base, attachments: [{ ...base.attachments[0]!, primary: false }, base.attachments[1]!] },
      { ...base, complete: false },
    ];
    for (const v of variants) expect(attachmentDigest(v, '203.0.113.20')).not.toBe(digest);
    expect(attachmentDigest(base, '198.51.100.7')).not.toBe(digest);
    expect(attachmentDigest(base, null)).not.toBe(digest);
  });

  it('is the SHA-256 of the documented canonical form', async () => {
    const { createHash } = await import('node:crypto');
    const one = parsed(report());
    const want = createHash('sha256').update(JSON.stringify(['v1', true, '203.0.113.20',
      [['Ethernet', '192.168.1.57', 24, '192.168.1.1', 'a4:2b:b0:11:22:9c', true]]])).digest('hex');
    expect(attachmentDigest(one, '203.0.113.20')).toBe(want);
  });
});
