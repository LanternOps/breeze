import { z } from 'zod';

/**
 * Learned networks B1 (#12369): the `networkAttachmentsV1` heartbeat report.
 * Spec docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md §7.1.
 *
 * A parse failure is report-local: the caller ignores the report and keeps the heartbeat.
 */

/** Attachments kept per report (spec §6). A longer list is cut to this and marked incomplete. */
export const NETWORK_ATTACHMENTS_MAX = 8;
/** Parse bound: a list longer than this is a malformed report, not one to cut. */
const NETWORK_ATTACHMENTS_PARSE_MAX = 64;

export interface NetworkAttachment {
  interfaceName: string;        // 1..128 chars
  localAddress: string;         // IPv4
  prefixLength: number;         // 0..32
  gatewayAddress: string;       // IPv4
  gatewayMac: string | null;    // lower-case aa:bb:cc:dd:ee:ff
  primary: boolean;
}

export interface NetworkAttachmentsReport {
  epoch: string;                // /^[0-9a-f]{16}$/
  sequence: number;             // non-negative safe integer
  capturedAt: string;           // ISO 8601
  complete: boolean;
  attachments: NetworkAttachment[];
}

export type NetworkAttachmentsParseResult =
  | { accepted: true; report: NetworkAttachmentsReport }
  | { accepted: false; reason: 'invalid_report' };

const MAC_FORM = /^[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}$/i;

/**
 * Values that name no gateway, so they must never become a fingerprint. Each is treated as an absent MAC
 * (an incomplete neighbour entry):
 * - all zeros and the broadcast address: incomplete neighbour entries;
 * - `02:00:00:00:00:00`: the placeholder macOS gives an unprivileged process in place of a real
 *   link-layer address, which would otherwise give every Mac behind any gateway at one address the same
 *   fingerprint;
 * - any address with the group bit set in its first octet (multicast; covers broadcast too).
 */
function normalizeGatewayMac(mac: string): string | null {
  const normalized = mac.toLowerCase().replace(/-/g, ':');
  if (normalized === '00:00:00:00:00:00' || normalized === '02:00:00:00:00:00') return null;
  if ((Number.parseInt(normalized.slice(0, 2), 16) & 1) === 1) return null;
  return normalized;
}

const gatewayMacSchema = z.union([
  z.null(),
  z.string().regex(MAC_FORM).transform(normalizeGatewayMac),
]);

const attachmentSchema = z.object({
  // No NUL: PostgreSQL text cannot store it, so the apply would fail on every beat instead of converging.
  interfaceName: z.string().min(1).max(128).refine((s) => !s.includes('\u0000')),
  localAddress: z.ipv4(),
  prefixLength: z.number().int().min(0).max(32),
  gatewayAddress: z.ipv4(),
  gatewayMac: gatewayMacSchema,
  primary: z.boolean(),
});

const reportSchema = z.object({
  epoch: z.string().regex(/^[0-9a-f]{16}$/),
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  capturedAt: z.iso.datetime({ offset: true }),
  complete: z.boolean(),
  attachments: z.array(attachmentSchema).max(NETWORK_ATTACHMENTS_PARSE_MAX),
});

/** Primary first, then by interface name (plain code-unit order, stable across locales). */
function keepOrder(a: NetworkAttachment, b: NetworkAttachment): number {
  if (a.primary !== b.primary) return a.primary ? -1 : 1;
  if (a.interfaceName < b.interfaceName) return -1;
  if (a.interfaceName > b.interfaceName) return 1;
  return 0;
}

export function parseNetworkAttachmentsReport(value: unknown): NetworkAttachmentsParseResult {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) return { accepted: false, reason: 'invalid_report' };
  const report: NetworkAttachmentsReport = parsed.data;
  if (report.attachments.length <= NETWORK_ATTACHMENTS_MAX) return { accepted: true, report };
  return {
    accepted: true,
    report: {
      ...report,
      complete: false,
      attachments: [...report.attachments].sort(keepOrder).slice(0, NETWORK_ATTACHMENTS_MAX),
    },
  };
}
