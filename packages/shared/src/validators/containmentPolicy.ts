import { z } from 'zod';
import { NETWORK_ISOLATION_LIMITS, NETWORK_ISOLATION_TTL } from '../utils/networkIsolation';
import {
  isolationCidrSchema as cidrSchema,
  isolationHostNameSchema as hostNameSchema,
  isolationPortsSchema as portsSchema,
  isolationProtoSchema as protoSchema,
  type IsolationAllowEntry,
} from './networkIsolation';

// Names that reach the local host without DNS: `localhost` and its subdomains, the common /etc/hosts
// aliases, and hex labels (`0x7f000001`, `0x7f.0x1`) that inet_aton-style parsers read as addresses.
// A public DNS name can still resolve to loopback; the agent must drop such addresses when it resolves.
const LOCAL_HOST_NAMES = new Set(['localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);
const extraHostSchema = hostNameSchema.refine(
  (host) => {
    const lower = host.toLowerCase();
    return !/(^|\.)localhost$/.test(lower)
      && !LOCAL_HOST_NAMES.has(lower)
      && !lower.split('.').some((label) => /^0x/.test(label));
  },
  { message: 'loopback hostnames are not allowed' },
);

/** Address bits as a '0'/'1' string (32 for IPv4, 128 for IPv6). Input is already a valid CIDR address. */
function addressBits(address: string): string {
  const v4 = (dotted: string) => dotted.split('.').map((o) => Number(o).toString(2).padStart(8, '0')).join('');
  if (!address.includes(':')) return v4(address);
  // A dotted IPv4 tail (`::ffff:127.0.0.1`) becomes two hex words before expansion.
  const hex = address.replace(/(\d+\.\d+\.\d+\.\d+)$/, (tail) => {
    const b = v4(tail);
    return `${parseInt(b.slice(0, 16), 2).toString(16)}:${parseInt(b.slice(16), 2).toString(16)}`;
  });
  const [left = '', right] = hex.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return words.map((w) => parseInt(w, 16).toString(2).padStart(16, '0')).join('');
}

function cidrBits(cidr: string): { bits: string; prefix: number } {
  const [address = '', prefix = ''] = cidr.split('/');
  return { bits: addressBits(address), prefix: Number(prefix) };
}

/**
 * Ranges an extra permit may not overlap: loopback and "this host" (0.0.0.0, ::), which Linux and macOS
 * route to the local host, in every IPv6 spelling that embeds them (IPv4-compatible ::/96, IPv4-mapped
 * ::ffff:0:0/96 and NAT64 64:ff9b::/96 forms).
 */
const BLOCKED_RANGES = [
  '127.0.0.0/8', '0.0.0.0/8',
  '::/96', // IPv4-compatible (deprecated): covers ::, ::1 and ::127.0.0.1
  '::ffff:127.0.0.0/104', '::ffff:0.0.0.0/104',
  '64:ff9b::127.0.0.0/104', '64:ff9b::0.0.0.0/104',
].map(cidrBits);

function overlapsBlockedRange(cidr: string): boolean {
  const target = cidrBits(cidr);
  return BLOCKED_RANGES.some((blocked) => {
    if (blocked.bits.length !== target.bits.length) return false;
    const n = Math.min(blocked.prefix, target.prefix);
    return blocked.bits.slice(0, n) === target.bits.slice(0, n);
  });
}

const extraCidrSchema = cidrSchema.refine((cidr) => {
  const { bits, prefix } = cidrBits(cidr);
  if (prefix < (bits.length === 32 ? 8 : 32)) return false;
  return !overlapsBlockedRange(cidr);
}, { message: 'CIDR must be at least /8 (IPv4) or /32 (IPv6) and exclude loopback and unspecified addresses' });

const extraFields = { proto: protoSchema, ports: portsSchema, label: z.string().trim().min(1).max(100).refine((l) => !/[\u0000-\u001f\u007f]/.test(l), { message: 'label must not contain control characters' }) };
// Strict alternatives enforce exactly one destination and reject guessed wire fields such as scope.
const extraAllowSchema = z.union([
  z.strictObject({ host: extraHostSchema, ...extraFields }),
  z.strictObject({ cidr: extraCidrSchema, ...extraFields }),
]);

export const containmentInlineSettingsSchema = z.strictObject({
  // System Protection has no version field; require v1 explicitly so future formats cannot be guessed.
  version: z.literal(1),
  // Reserve 32 of the 64 wire entries for server-built control-plane, DNS, and relay permits.
  extraAllow: z.array(extraAllowSchema).max(NETWORK_ISOLATION_LIMITS.maxAllowEntries - 32).default([]),
  defaultTtlHours: z.number().int().min(1).max(NETWORK_ISOLATION_TTL.maxHours).default(NETWORK_ISOLATION_TTL.defaultHours),
  deadManMinutes: z.union([z.literal(0), z.number().int().min(15).max(1440)]).default(0),
  remoteRelay: z.boolean().default(true),
  requireSignedReleaseToken: z.boolean().default(false),
});

export type ContainmentInlineSettings = z.infer<typeof containmentInlineSettingsSchema>;

/** W1's fixed fallback: no extra network permissions, with the original TTL and relay behaviour. */
export const CONTAINMENT_POLICY_DEFAULTS: Readonly<ContainmentInlineSettings> = Object.freeze(
  containmentInlineSettingsSchema.parse({ version: 1 }),
);
Object.freeze(CONTAINMENT_POLICY_DEFAULTS.extraAllow);

/** Pure conversion only; runtime isolation services do not consume containment policy settings yet. */
export function containmentExtraAllowToEntries(extraAllow: ContainmentInlineSettings['extraAllow']): IsolationAllowEntry[] {
  return extraAllow.map((entry) => ({
    ...('host' in entry ? { kind: 'host' as const, host: entry.host } : { kind: 'cidr' as const, cidr: entry.cidr }),
    proto: entry.proto,
    ports: [...entry.ports],
    scope: 'any' as const,
  }));
}
