/**
 * Pure data structures and lookups behind the offline IP classifier (#11698).
 * No I/O and no side-effect imports: loading, refresh and caching live in
 * ipClassifyOffline.ts, and partnerTrustPromotion imports the source markers
 * from here without pulling in Redis or BullMQ.
 */
import { isIP } from 'node:net';

import type { IpClass } from '../db/schema/orgs';

/**
 * The offline baseline checked the address against the Tor exit list AND
 * resolved it to an announced ASN that it checked against the hosting-ASN
 * list. With `ipClass: 'unknown'` this is "baseline checked, nothing found".
 */
export const IP_CLASS_SOURCE_OFFLINE = 'offline';
/**
 * Only part of the baseline could run: the Tor list was checked, but the ASN
 * database or hosting-ASN list was unavailable, or the address is not in any
 * announced prefix. A hosting address can hide here, so `unknown` with this
 * source is still treated as unclassified.
 */
export const IP_CLASS_SOURCE_OFFLINE_PARTIAL = 'offline-partial';
/** Nothing was checked: a private, loopback or unparseable address. */
export const IP_CLASS_SOURCE_NONE = 'none';

export type IpClassifier = 'offline' | 'ipinfo' | 'ipdata';

/** The classifier a configured provider resolves to; `none` means the offline baseline. */
export function classifierFor(provider: 'ipinfo' | 'ipdata' | 'none'): IpClassifier {
  return provider === 'none' ? 'offline' : provider;
}

export type IpClassification = {
  ipClass: IpClass;
  asn: number | null;
  /**
   * Which classifier produced this result: a keyed provider name, or one of
   * the IP_CLASS_SOURCE_* markers above. Persisted on partners as
   * `signup_ip_class_source`.
   */
  provider: string;
};

/**
 * True when an `unknown` signup class is the offline baseline's "checked,
 * nothing found" rather than "never classified". Only meaningful while the
 * offline classifier is the active one: once a keyed provider is configured,
 * an offline result is no longer the best evidence available and the address
 * is re-classified by the provider instead.
 */
export function isOfflineBaselineClear(
  ipClass: IpClass,
  source: string | null,
  activeClassifier: IpClassifier,
): boolean {
  return ipClass === 'unknown' && source === IP_CLASS_SOURCE_OFFLINE && activeClassifier === 'offline';
}

function expandIpv6(ip: string): string[] | null {
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  const parts = [...left, ...Array(fill).fill('0'), ...right];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => part.padStart(4, '0'));
}

/**
 * Canonical form used as the Tor-set key: dotted IPv4 as given, IPv6 fully
 * expanded and lowercased, and an IPv4-mapped IPv6 address unwrapped to its
 * IPv4 form. Returns null for anything that is not an IP address.
 */
export function normalizeIp(raw: string): string | null {
  const ip = raw.trim();
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!;
  const parts = expandIpv6(ip);
  return parts ? parts.join(':') : null;
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.').map(Number) as [number, number, number, number];
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function ipv6High64(normalized: string): bigint {
  return BigInt(`0x${normalized.split(':').slice(0, 4).join('')}`);
}

const NON_PUBLIC_V4: Array<[number, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base as string), bits as number]);

/**
 * Addresses that say nothing about the network a request came from: RFC 1918,
 * loopback, link-local, CGNAT, multicast/reserved, and the IPv6 equivalents.
 * Documentation ranges are deliberately NOT listed — they never occur in real
 * traffic, and the test suites use them as stand-ins for public addresses.
 */
export function isNonPublicAddress(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ip) return true;
  if (isIP(ip) === 4) {
    const value = ipv4ToInt(ip);
    return NON_PUBLIC_V4.some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (ip === '0000:0000:0000:0000:0000:0000:0000:0000' || ip === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return true;
  }
  const first = parseInt(ip.slice(0, 4), 16);
  return (first & 0xfe00) === 0xfc00 // fc00::/7 unique local
    || (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
    || (first & 0xff00) === 0xff00; // ff00::/8 multicast
}

/** One address per line (the Tor bulk exit list format); junk lines are dropped. */
export function parseTorExitList(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ip = normalizeIp(trimmed);
    if (ip) out.add(ip);
  }
  return out;
}

/** CSV whose first column is an ASN (`64500` or `AS64500`); header and junk rows are dropped. */
export function parseHostingAsnList(text: string): Set<number> {
  const out = new Set<number>();
  for (const line of text.split('\n')) {
    const first = line.split(',', 1)[0]?.trim().replace(/^"|"$/g, '').replace(/^AS/i, '') ?? '';
    if (!/^\d{1,10}$/.test(first)) continue;
    const asn = Number(first);
    if (asn > 0 && asn <= 0xffffffff) out.add(asn);
  }
  return out;
}

export type AsnTable = {
  v4Start: Uint32Array;
  v4End: Uint32Array;
  v4Asn: Uint32Array;
  /** IPv6 ranges keyed by their upper 64 bits; announced prefixes are never longer than /64. */
  v6Start: BigUint64Array;
  v6End: BigUint64Array;
  v6Asn: Uint32Array;
  ranges: number;
};

/**
 * Builds an AsnTable from `range_start <TAB> range_end <TAB> asn [<TAB> ...]`
 * rows — the iptoasn.com `ip2asn-combined.tsv` format. Rows with ASN 0 ("Not
 * routed") or that do not parse are skipped.
 */
export class AsnTableBuilder {
  private v4: number[] = [];
  private v6: bigint[] = [];
  private v6Asns: number[] = [];

  add(line: string): void {
    const fields = line.split('\t');
    if (fields.length < 3) return;
    const asnField = fields[2]!.trim();
    if (!/^\d{1,10}$/.test(asnField)) return;
    const asn = Number(asnField);
    if (asn <= 0 || asn > 0xffffffff) return;
    const start = normalizeIp(fields[0]!);
    const end = normalizeIp(fields[1]!);
    if (!start || !end) return;
    const version = isIP(start);
    if (version !== isIP(end)) return;
    if (version === 4) {
      const s = ipv4ToInt(start);
      const e = ipv4ToInt(end);
      if (e < s) return;
      this.v4.push(s, e, asn);
    } else {
      const s = ipv6High64(start);
      const e = ipv6High64(end);
      if (e < s) return;
      this.v6.push(s, e);
      this.v6Asns.push(asn);
    }
  }

  build(): AsnTable {
    const v4Count = this.v4.length / 3;
    const v4Order = Array.from({ length: v4Count }, (_, i) => i);
    v4Order.sort((a, b) => this.v4[a * 3]! - this.v4[b * 3]!);
    const v4Start = new Uint32Array(v4Count);
    const v4End = new Uint32Array(v4Count);
    const v4Asn = new Uint32Array(v4Count);
    v4Order.forEach((src, i) => {
      v4Start[i] = this.v4[src * 3]!;
      v4End[i] = this.v4[src * 3 + 1]!;
      v4Asn[i] = this.v4[src * 3 + 2]!;
    });

    const v6Count = this.v6Asns.length;
    const v6Order = Array.from({ length: v6Count }, (_, i) => i);
    v6Order.sort((a, b) => {
      const x = this.v6[a * 2]!;
      const y = this.v6[b * 2]!;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const v6Start = new BigUint64Array(v6Count);
    const v6End = new BigUint64Array(v6Count);
    const v6Asn = new Uint32Array(v6Count);
    v6Order.forEach((src, i) => {
      v6Start[i] = this.v6[src * 2]!;
      v6End[i] = this.v6[src * 2 + 1]!;
      v6Asn[i] = this.v6Asns[src]!;
    });

    this.v4 = [];
    this.v6 = [];
    this.v6Asns = [];
    return { v4Start, v4End, v4Asn, v6Start, v6End, v6Asn, ranges: v4Count + v6Count };
  }
}

function searchRange<T extends number | bigint>(
  starts: ArrayLike<T>,
  ends: ArrayLike<T>,
  asns: Uint32Array,
  value: T,
): number | null {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0 || value > ends[found]!) return null;
  return asns[found]!;
}

export function lookupAsn(table: AsnTable, raw: string): number | null {
  const ip = normalizeIp(raw);
  if (!ip) return null;
  if (isIP(ip) === 4) return searchRange(table.v4Start, table.v4End, table.v4Asn, ipv4ToInt(ip));
  return searchRange(table.v6Start, table.v6End, table.v6Asn, ipv6High64(ip));
}

export type OfflineDataset = {
  tor: ReadonlySet<string>;
  hosting: ReadonlySet<number>;
  asn: AsnTable | null;
};

/**
 * The offline baseline. It can prove `tor` (Tor exit list) and `hosting`
 * (the address's ASN is on the hosting-ASN list); it can never prove
 * `residential` or `business`, so everything else stays `unknown` — with the
 * source saying how much of the baseline actually ran.
 */
export function classifyWithOfflineData(raw: string, data: OfflineDataset): IpClassification {
  if (isNonPublicAddress(raw)) return { ipClass: 'unknown', asn: null, provider: IP_CLASS_SOURCE_NONE };
  const ip = normalizeIp(raw)!;
  const asn = data.asn ? lookupAsn(data.asn, ip) : null;
  const complete = asn !== null && data.hosting.size > 0;
  const provider = complete ? IP_CLASS_SOURCE_OFFLINE : IP_CLASS_SOURCE_OFFLINE_PARTIAL;
  if (data.tor.has(ip)) return { ipClass: 'tor', asn, provider };
  if (asn !== null && data.hosting.has(asn)) return { ipClass: 'hosting', asn, provider };
  return { ipClass: 'unknown', asn, provider };
}
