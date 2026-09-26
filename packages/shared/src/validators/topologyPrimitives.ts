import './topologyZod';
import { z } from 'zod';

export const topologyUtf8KeySchema = z.string().min(1).refine(s => new TextEncoder().encode(s).length <= 255, 'Maximum 255 UTF-8 bytes');
export const topologySequenceSchema = z.string().regex(/^(0|[1-9]\d{0,19})$/).refine(s => /^(0|[1-9]\d{0,19})$/.test(s) && BigInt(s) <= 18446744073709551615n, 'uint64 overflow');
export const topologyDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const topologyFamilySchema = z.enum(['ipv4', 'ipv6']);
export const topologyUint32Schema = z.number().int().min(0).max(4294967295);
export const topologyPortSchema = z.number().int().min(1).max(65535);
export const topologyTimestampSchema = z.string().datetime({ offset: false });
export const topologyReasonSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).max(64);
export const topologyIpSchema = z.union([z.ipv4(), z.ipv6()]).transform(s => {
  if (!s.includes(':')) return s;
  return new URL(`http://[${s}]/`).hostname.slice(1, -1);
});
export const topologyCidrSchema = z.string().transform((s, ctx) => {
  const parts = s.split('/');
  const ip = topologyIpSchema.safeParse(parts[0]);
  const prefix = parts[1];
  if (parts.length !== 2 || !ip.success || !prefix || !/^(0|[1-9]\d*)$/.test(prefix) || Number(prefix) > (ip.data.includes(':') ? 128 : 32)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid IP prefix' }); return z.NEVER;
  }
  // Canonical network prefix: clear host bits, including IPv6 compressed forms.
  if (!ip.data.includes(':')) {
    const n = ip.data.split('.').reduce((v, b) => (v << 8) | Number(b), 0) >>> 0;
    const network = (n & (Number(prefix) === 0 ? 0 : 0xffffffff << (32 - Number(prefix)))) >>> 0;
    return `${[24, 16, 8, 0].map(shift => (network >>> shift) & 255).join('.')}/${prefix}`;
  }
  const halves = ip.data.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  let value = groups.reduce((n: bigint, group: string) => (n << 16n) | BigInt(`0x${group}`), 0n);
  const bits = BigInt(128 - Number(prefix)); value = (value >> bits) << bits;
  const expanded = Array.from({ length: 8 }, (_, i) => ((value >> BigInt(112 - i * 16)) & 65535n).toString(16)).join(':');
  return `${new URL(`http://[${expanded}]/`).hostname.slice(1, -1)}/${prefix}`;
});
export const topologyMacSchema = z.string().regex(/^(?:[\da-fA-F]{2}[:-]){5}[\da-fA-F]{2}$/).transform(s => s.replaceAll('-', ':').toLowerCase());
export const topologyHostnameSchema = z.string().min(1).max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.?$/).transform(s => s.toLowerCase().replace(/\.$/, ''));
export function topologyJsonBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return Infinity; }
}
const UPLOADED_AUTHORITY_KEYS = ['orgId', 'siteId', 'agentId', 'deviceId', 'producerId', 'partnerId'];
/** Run before stripping minor fields so unknown content cannot evade transport limits.
 * `rowFieldExemptions` names typed row fields that merely share a name with an
 * authority key (UniFi rows carry the CONTROLLER's `deviceId`); they are allowed
 * only directly on an element of a `rows` array, nowhere else. */
export function topologyWireGuard(maxBytes: number, options: { rowFieldExemptions?: readonly string[] } = {}) {
  const exempt = new Set(options.rowFieldExemptions ?? []);
  return z.unknown().superRefine((value, ctx) => {
    if (topologyJsonBytes(value) > maxBytes) ctx.addIssue({ code: 'custom', message: 'Payload byte limit exceeded' });
    const seen = new WeakSet<object>();
    const visit = (v: unknown, isRow: boolean): boolean => {
      if (!v || typeof v !== 'object') return false;
      if (seen.has(v)) return true;
      seen.add(v);
      const forbidden = Array.isArray(v)
        ? v.some(child => visit(child, isRow))
        : Object.entries(v).some(([k, child]) => (UPLOADED_AUTHORITY_KEYS.includes(k) && !(isRow && exempt.has(k))) || visit(child, k === 'rows'));
      seen.delete(v);
      return forbidden;
    };
    if (visit(value, false)) ctx.addIssue({ code: 'custom', message: 'Uploaded authority is forbidden' });
  });
}
