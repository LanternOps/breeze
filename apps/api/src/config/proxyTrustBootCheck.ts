import { BlockList, isIP } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/**
 * Boot-time sanity check for TRUSTED_PROXY_CIDRS (#2987).
 *
 * A syntactically valid TRUSTED_PROXY_CIDRS can still name the wrong host: a
 * pinned container /32 goes stale when the container network is recreated or
 * the host reboots and addresses are reassigned. The API then rejects the real
 * reverse proxy as an untrusted peer. This check compares the configured list
 * with the subnets the API is actually attached to and, when none overlap,
 * produces ONE warning naming both. It is advisory only — a proxy outside the
 * attached networks is a legitimate topology — so it never throws and never
 * alters config.
 *
 * Limitation: overlap is judged per subnet, so a stale /32 that still falls
 * inside the same attached network is not detected — only subnet-level drift.
 */

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

interface ParsedCidr {
  raw: string;
  family: 'ipv4' | 'ipv6';
  network: string;
  prefix: number;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Mirrors services/clientIp.ts: unset/'auto' trusts headers outside production. */
function proxyHeadersTrusted(env: Record<string, string | undefined>): boolean {
  const mode = (env.TRUST_PROXY_HEADERS ?? 'auto').trim().toLowerCase();
  if (mode === 'auto') return env.NODE_ENV !== 'production';
  return TRUTHY.has(mode);
}

function parseCidr(entry: string): ParsedCidr | null {
  const [network, prefixRaw, extra] = entry.split('/');
  if (!network || extra !== undefined) return null;
  const version = isIP(network);
  if (version === 0) return null;
  const maxPrefix = version === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (prefixRaw !== undefined) {
    if (!/^\d{1,3}$/.test(prefixRaw)) return null;
    prefix = Number.parseInt(prefixRaw, 10);
    if (prefix > maxPrefix) return null;
  }
  return { raw: entry, family: version === 4 ? 'ipv4' : 'ipv6', network, prefix };
}

function contains(outer: ParsedCidr, address: string, family: 'ipv4' | 'ipv6'): boolean {
  if (outer.family !== family) return false;
  const list = new BlockList();
  list.addSubnet(outer.network, outer.prefix, outer.family);
  return list.check(address, family);
}

/** Two CIDRs overlap iff one contains the other's network address. */
function overlaps(a: ParsedCidr, b: ParsedCidr): boolean {
  return contains(a, b.network, b.family) || contains(b, a.network, a.family);
}

/** Network (not host) form of an interface CIDR, e.g. 192.0.2.5/24 -> 192.0.2.0/24. */
function networkOf(info: NetworkInterfaceInfo): ParsedCidr | null {
  if (!info.cidr) return null;
  const parsed = parseCidr(info.cidr);
  if (!parsed) return null;
  const masked = maskAddress(parsed);
  return { ...parsed, network: masked, raw: `${masked}/${parsed.prefix}` };
}

function maskAddress(c: ParsedCidr): string {
  if (c.family === 'ipv4') {
    const octets = c.network.split('.').map(Number);
    let bits = c.prefix;
    const out = octets.map((o) => {
      const keep = Math.max(0, Math.min(8, bits));
      bits -= 8;
      return keep === 0 ? 0 : o & (0xff << (8 - keep)) & 0xff;
    });
    return out.join('.');
  }
  const groups = expandIpv6(c.network);
  let bits = c.prefix;
  const out = groups.map((g) => {
    const keep = Math.max(0, Math.min(16, bits));
    bits -= 16;
    return keep === 0 ? 0 : g & (0xffff << (16 - keep)) & 0xffff;
  });
  return compressIpv6(out);
}

function expandIpv6(addr: string): number[] {
  const noZone = addr.split('%')[0]!;
  const [head, tail] = noZone.split('::');
  const toGroups = (s: string | undefined): number[] =>
    s ? s.split(':').filter(Boolean).map((g) => Number.parseInt(g, 16)) : [];
  const h = toGroups(head);
  if (tail === undefined) return h;
  const t = toGroups(tail);
  return [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill(0), ...t];
}

function compressIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export interface TrustedProxyCidrCheckInput {
  trustProxyHeaders: boolean;
  trustedProxyCidrs: string | undefined;
  interfaces: InterfaceMap;
}

/**
 * Returns the warning text when proxy headers are trusted, the configured list
 * has at least one well-formed entry, at least one non-loopback subnet is
 * attached, and no entry overlaps any attached subnet. Otherwise null.
 */
export function findTrustedProxyCidrMismatch(input: TrustedProxyCidrCheckInput): string | null {
  if (!input.trustProxyHeaders) return null;

  const configured = (input.trustedProxyCidrs ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map(parseCidr)
    .filter((c): c is ParsedCidr => c !== null);
  if (configured.length === 0) return null;

  const attached: ParsedCidr[] = [];
  for (const infos of Object.values(input.interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      const net = networkOf(info);
      if (net) attached.push(net);
    }
  }
  if (attached.length === 0) return null;

  if (configured.some((c) => attached.some((a) => overlaps(c, a)))) return null;

  // A proxy on the same host (API run directly, proxy on loopback) is a normal
  // topology; loopback is excluded from `attached`, so recognise it here.
  const loopbacks = [parseCidr('127.0.0.0/8'), parseCidr('::1/128')].filter((l): l is ParsedCidr => l !== null);
  if (configured.some((c) => loopbacks.some((l) => overlaps(c, l)))) return null;

  const uniqueAttached = [...new Set(attached.map((a) => a.raw))];
  return (
    `[proxy-trust] TRUSTED_PROXY_CIDRS (${configured.map((c) => c.raw).join(', ')}) does not overlap any subnet this API is attached to `
    + `(${uniqueAttached.join(', ')}). If your reverse proxy runs on one of these networks, the list is likely STALE `
    + '(for example a pinned container address that changed after a recreate or host reboot) and every proxied request '
    + 'will be treated as coming from an untrusted peer — with FORCE_HTTPS that becomes a redirect loop for agents and the web UI. '
    + 'Set TRUSTED_PROXY_CIDRS to the proxy\'s current address (a /32 or /128), or pin the proxy to a static address. '
    + 'Ignore this warning only if the proxy deliberately connects from outside these networks.'
  );
}

export interface BootCheckOptions {
  interfaces?: InterfaceMap | (() => InterfaceMap);
  warn?: (message: string) => void;
}

/** Runs the check against the live environment; never throws. */
export function warnOnTrustedProxyCidrMismatch(
  env: Record<string, string | undefined>,
  options: BootCheckOptions = {},
): void {
  try {
    const interfaces = typeof options.interfaces === 'function'
      ? options.interfaces()
      : options.interfaces ?? networkInterfaces();
    const message = findTrustedProxyCidrMismatch({
      trustProxyHeaders: proxyHeadersTrusted(env),
      trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS,
      interfaces,
    });
    if (message) (options.warn ?? console.warn)(message);
  } catch (err) {
    // Advisory only: must never affect boot, but say that the check did not run
    // so a skipped check is not mistaken for a passing one.
    (options.warn ?? console.warn)(
      `[proxy-trust] could not verify TRUSTED_PROXY_CIDRS against attached subnets (check skipped): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
