import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { parseNetworkAttachmentsReport, type NetworkAttachmentsReport } from '@breeze/shared';
import { learnedNetworksIngestEnabled } from '../../config/env';
import { isNonPublicAddress } from '../ipClassifyOfflineData';
import { NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS } from './constants';

/**
 * Learned networks W01b (#12369): heartbeat ingest. Spec
 * docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md §8.1; index contract E3.
 *
 * The planner is pure. Only an `apply` plan touches the learned tables, and this module never writes `devices`:
 * the heartbeat folds `deviceFields` into its own `updateOwnDeviceRow` call.
 */

export type AttachmentDeviceState = {
  id: string; orgId: string; isEphemeral: boolean;
  networkAttachmentEpoch: string | null; networkAttachmentSequence: number | null;
  networkAttachmentDigest: string | null;
};

export type AttachmentDeviceFields = {
  networkAttachmentEpoch: string; networkAttachmentSequence: number;
  networkAttachmentDigest: string; networkAttachmentsConfirmedAt: Date;
};

export type IngestIgnoreReason =
  | 'absent' | 'disabled' | 'ephemeral' | 'invalid_report' | 'stale_sequence' | 'capture_time_out_of_bounds';

export type IngestPlan =
  | { kind: 'ignore'; reason: IngestIgnoreReason }
  | { kind: 'confirm'; deviceFields: AttachmentDeviceFields }
  | { kind: 'apply'; deviceFields: AttachmentDeviceFields; report: NetworkAttachmentsReport; wanAddress: string | null };

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SHA-256 hex of `['v1', complete, wan, rows]`, rows sorted by interface name, gateway address, gateway MAC.
 * `epoch`, `sequence` and `capturedAt` are deliberately left out: only what the device is attached to counts.
 */
export function attachmentDigest(report: NetworkAttachmentsReport, wanAddress: string | null): string {
  const rows = report.attachments
    .map((a) => [a.interfaceName, a.localAddress, a.prefixLength, a.gatewayAddress, a.gatewayMac, a.primary] as const)
    .sort((x, y) => compareText(x[0], y[0]) || compareText(x[3], y[3]) || compareText(x[4] ?? '', y[4] ?? ''));
  return createHash('sha256').update(JSON.stringify(['v1', report.complete, wanAddress, rows])).digest('hex');
}

/**
 * The WAN address is recorded only when the trusted client IP is a public IP and the report has a primary
 * attachment with a gateway MAC (the network the WAN row goes to). Anything else is null, in the digest too.
 */
function normalizeWanAddress(report: NetworkAttachmentsReport, wanAddress: string | null): string | null {
  const ip = wanAddress?.trim() ?? '';
  if (!ip || isIP(ip) === 0 || isNonPublicAddress(ip)) return null;
  return report.attachments.some((a) => a.primary && a.gatewayMac !== null) ? ip : null;
}

/** Pure. No database access; reads only the kill switch. The first reason that applies wins. */
export function planNetworkAttachmentIngest(
  device: AttachmentDeviceState, raw: unknown, wanAddress: string | null, now: Date,
): IngestPlan {
  // An absent field means "no change" (contract C1): the agent attaches each finished report to one beat.
  if (raw === undefined) return { kind: 'ignore', reason: 'absent' };
  if (!learnedNetworksIngestEnabled()) return { kind: 'ignore', reason: 'disabled' };
  if (device.isEphemeral) return { kind: 'ignore', reason: 'ephemeral' };

  const parsed = parseNetworkAttachmentsReport(raw);
  if (!parsed.accepted) return { kind: 'ignore', reason: 'invalid_report' };
  const report = parsed.report;

  if (
    report.epoch === device.networkAttachmentEpoch
    && device.networkAttachmentSequence !== null
    && report.sequence <= device.networkAttachmentSequence
  ) {
    return { kind: 'ignore', reason: 'stale_sequence' };
  }

  if (Math.abs(now.getTime() - Date.parse(report.capturedAt)) > NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS) {
    return { kind: 'ignore', reason: 'capture_time_out_of_bounds' };
  }

  const wan = normalizeWanAddress(report, wanAddress);
  const digest = attachmentDigest(report, wan);
  const deviceFields: AttachmentDeviceFields = {
    networkAttachmentEpoch: report.epoch,
    networkAttachmentSequence: report.sequence,
    networkAttachmentDigest: digest,
    networkAttachmentsConfirmedAt: now,
  };
  if (digest === device.networkAttachmentDigest) return { kind: 'confirm', deviceFields };
  return { kind: 'apply', deviceFields, report, wanAddress: wan };
}
