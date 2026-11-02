import { z } from 'zod';
import { NETWORK_ISOLATION_LIMITS, NETWORK_ISOLATION_TTL } from '../utils/networkIsolation';
import {
  isolationCidrSchema as cidrSchema,
  isolationHostNameSchema as hostNameSchema,
  isolationPortsSchema as portsSchema,
  isolationProtoSchema as protoSchema,
  type IsolationAllowEntry,
} from './networkIsolation';

const extraHostSchema = hostNameSchema.refine(
  (host) => !/(^|\.)localhost$/i.test(host),
  { message: 'loopback hostnames are not allowed' },
);

const extraCidrSchema = cidrSchema.refine((cidr) => {
  const [address, prefixText] = cidr.split('/');
  const prefix = Number(prefixText);
  if (!address) return false;
  if (!address.includes(':')) return prefix >= 8 && address.split('.')[0] !== '127';
  if (prefix < 32) return false;

  // Expand validated IPv6 (including a dotted IPv4 tail) before checking loopback, so alternate
  // spellings cannot bypass it. This stays browser-safe and performs no DNS/network access.
  const hexadecimal = address.replace(/\d+\.\d+\.\d+\.\d+$/, (ipv4) => {
    const octets = ipv4.split('.').map(Number);
    return [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!]
      .map((word) => word.toString(16)).join(':');
  });
  const [left = '', right = ''] = hexadecimal.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words = hexadecimal.includes('::')
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  const bits = words.map((word) => Number.parseInt(word, 16).toString(2).padStart(16, '0')).join('');
  // Reject every CIDR containing the IPv6 loopback, including a network address with host bits set.
  const loopbackBits = '0'.repeat(127) + '1';
  // IPv4-mapped IPv6 must also exclude the entire IPv4 loopback /8, in either spelling.
  const mappedLoopbackBits = '0'.repeat(80) + '1'.repeat(16) + '01111111';
  const mappedPrefix = Math.min(prefix, mappedLoopbackBits.length);
  return bits.slice(0, prefix) !== loopbackBits.slice(0, prefix)
    && bits.slice(0, mappedPrefix) !== mappedLoopbackBits.slice(0, mappedPrefix);
}, { message: 'CIDR must be at least /8 (IPv4) or /32 (IPv6) and exclude loopback' });

const extraFields = { proto: protoSchema, ports: portsSchema, label: z.string().trim().min(1).max(100) };
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
