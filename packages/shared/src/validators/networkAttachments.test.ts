import { describe, expect, it } from 'vitest';
import { NETWORK_ATTACHMENTS_MAX, parseNetworkAttachmentsReport, type NetworkAttachment } from './networkAttachments';

const att = (o: Partial<Record<keyof NetworkAttachment, unknown>> = {}) => ({
  interfaceName: 'Ethernet', localAddress: '192.168.1.57', prefixLength: 24, gatewayAddress: '192.168.1.1',
  gatewayMac: 'a4:2b:b0:11:22:9c', primary: true, ...o,
});
const report = (o: Record<string, unknown> = {}) => ({
  epoch: '9f2c1e7ab4d04c11', sequence: 418, capturedAt: '2026-11-20T15:04:05Z', complete: true,
  attachments: [att()], ...o,
});

describe('parseNetworkAttachmentsReport', () => {
  it('accepts the spec example and an empty complete list', () => {
    expect(parseNetworkAttachmentsReport(report())).toEqual({ accepted: true, report: report() });
    expect(parseNetworkAttachmentsReport(report({ attachments: [] }))).toMatchObject({ accepted: true });
    expect(NETWORK_ATTACHMENTS_MAX).toBe(8);
  });

  it('strips unknown keys', () => {
    const r = parseNetworkAttachmentsReport({ ...report({ attachments: [{ ...att(), extra: 1 }] }), extra: 'x' });
    expect(r).toEqual({ accepted: true, report: report() });
  });

  it('normalizes MACs to lower-case colon form and placeholder, broadcast and multicast entries to null', () => {
    for (const [given, want] of [
      ['A4-2B-B0-11-22-9C', 'a4:2b:b0:11:22:9c'],
      ['3C:37:86:AA:BB:10', '3c:37:86:aa:bb:10'],
      ['00:1a:8c:00:00:01', '00:1a:8c:00:00:01'],
      ['00:00:00:00:00:00', null],
      ['ff:ff:ff:ff:ff:ff', null],
      ['FF-FF-FF-FF-FF-FF', null],
      // The placeholder macOS hands an unprivileged process in place of a real link-layer address.
      ['02:00:00:00:00:00', null],
      ['02-00-00-00-00-00', null],
      // Group bit set in the first octet: a multicast address is never a gateway's own MAC.
      ['01:00:5e:00:00:01', null],
      ['33:33:00:00:00:01', null],
      [null, null],
    ] as const) {
      const r = parseNetworkAttachmentsReport(report({ attachments: [att({ gatewayMac: given })] }));
      expect(r.accepted, `MAC ${given}`).toBe(true);
      expect(r.accepted && r.report.attachments[0]!.gatewayMac, `MAC ${given}`).toBe(want);
    }
  });

  it.each(['a42b.b011.229c', 'a4:2b:b0:11:22', 'a4:2b:b0:11:22:9c:00', 'g4:2b:b0:11:22:9c', 'a4:2b-b0:11:22:9c', '', 7])(
    'rejects MAC %j', (gatewayMac) => {
      expect(parseNetworkAttachmentsReport(report({ attachments: [att({ gatewayMac })] })))
        .toEqual({ accepted: false, reason: 'invalid_report' });
    });

  it.each([
    { gatewayAddress: 'fe80::1' }, { localAddress: '2001:db8::5' }, { prefixLength: 33 }, { prefixLength: -1 },
    { prefixLength: 24.5 }, { interfaceName: '' }, { interfaceName: 'x'.repeat(129) }, { primary: 'yes' },
    // PostgreSQL text cannot hold NUL: accepted, it would fail every apply for that device on every beat.
    { interfaceName: 'Ether\u0000net' },
    { gatewayAddress: undefined },
  ])('rejects attachment %j', (o) => {
    expect(parseNetworkAttachmentsReport(report({ attachments: [att(o)] })))
      .toEqual({ accepted: false, reason: 'invalid_report' });
  });

  it('accepts a 128-character interface name and prefix lengths 0 and 32', () => {
    expect(parseNetworkAttachmentsReport(report({ attachments: [att({ interfaceName: 'x'.repeat(128) })] })).accepted).toBe(true);
    expect(parseNetworkAttachmentsReport(report({ attachments: [att({ prefixLength: 0 })] })).accepted).toBe(true);
    expect(parseNetworkAttachmentsReport(report({ attachments: [att({ prefixLength: 32 })] })).accepted).toBe(true);
  });

  it.each([
    { epoch: '9F2C1E7AB4D04C11' }, { epoch: 'abc' }, { sequence: -1 }, { sequence: 1.5 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 }, { capturedAt: 'yesterday' }, { complete: 'yes' },
    { attachments: 'none' }, { epoch: undefined },
  ])('rejects %j', (o) => {
    expect(parseNetworkAttachmentsReport(report(o))).toEqual({ accepted: false, reason: 'invalid_report' });
  });

  it('accepts a capturedAt with an offset', () => {
    expect(parseNetworkAttachmentsReport(report({ capturedAt: '2026-11-20T17:04:05.123+02:00' })).accepted).toBe(true);
  });

  it('cuts more than 8 attachments to 8, primary first then by interfaceName, and forces complete false', () => {
    const many = ['eth9', 'eth1', 'eth5', 'eth3', 'eth7', 'eth2', 'eth8', 'eth4', 'eth6']
      .map((n) => att({ interfaceName: n, primary: n === 'eth9' }));
    const r = parseNetworkAttachmentsReport(report({ attachments: many }));
    expect(r.accepted && r.report.attachments.map((a) => a.interfaceName))
      .toEqual(['eth9', 'eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6', 'eth7']);
    expect(r.accepted && r.report.complete).toBe(false);
  });

  it('keeps exactly 8 attachments in their reported order and complete', () => {
    const eight = ['eth8', 'eth1', 'eth2', 'eth3', 'eth4', 'eth5', 'eth6', 'eth7'].map((n) => att({ interfaceName: n }));
    const r = parseNetworkAttachmentsReport(report({ attachments: eight }));
    expect(r.accepted && r.report.attachments.map((a) => a.interfaceName)).toEqual(eight.map((a) => a.interfaceName));
    expect(r.accepted && r.report.complete).toBe(true);
  });

  it('accepts 64 attachments and rejects more than 64 and anything that is not an object', () => {
    expect(parseNetworkAttachmentsReport(report({ attachments: Array.from({ length: 64 }, () => att()) })).accepted).toBe(true);
    expect(parseNetworkAttachmentsReport(report({ attachments: Array.from({ length: 65 }, () => att()) })))
      .toEqual({ accepted: false, reason: 'invalid_report' });
    for (const v of [null, undefined, 'x', 7, []]) {
      expect(parseNetworkAttachmentsReport(v)).toEqual({ accepted: false, reason: 'invalid_report' });
    }
  });
});
