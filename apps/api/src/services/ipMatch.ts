// Pure IPv4/IPv6 single-address and CIDR matching. No IO.
// Used by the partner IP allowlist. BigInt-based so IPv6 is supported.

function ipv4ToInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8n) | BigInt(n);
  }
  return result;
}

function ipv6ToInt(ip: string): bigint | null {
  let s = ip;
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // strip zone id

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const expand = (segment: string): string[] | null => {
    if (!segment) return [];
    const out: string[] = [];
    for (const p of segment.split(':')) {
      if (p.includes('.')) {
        // embedded IPv4 (e.g. ::ffff:1.2.3.4)
        const v4 = ipv4ToInt(p);
        if (v4 === null) return null;
        out.push(((v4 >> 16n) & 0xffffn).toString(16));
        out.push((v4 & 0xffffn).toString(16));
      } else {
        out.push(p);
      }
    }
    return out;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (head === null || tail === null) return null;

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

function isV6(s: string): boolean {
  return s.includes(':');
}

function matchOne(ip: string, entry: string): boolean {
  const slash = entry.indexOf('/');
  const network = slash === -1 ? entry : entry.slice(0, slash);
  const entryIsV6 = isV6(network);
  if (entryIsV6 !== isV6(ip)) return false; // never cross families

  const toInt = entryIsV6 ? ipv6ToInt : ipv4ToInt;
  const totalBits = entryIsV6 ? 128n : 32n;
  const maxBits = entryIsV6 ? 128 : 32;

  const ipNum = toInt(ip);
  const netNum = toInt(network);
  if (ipNum === null || netNum === null) return false;

  if (slash === -1) {
    return ipNum === netNum;
  }

  const bits = Number(entry.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return false;
  const mask =
    bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << (totalBits - BigInt(bits));
  return (ipNum & mask) === (netNum & mask);
}

/** True if `ip` matches any IP or CIDR entry. Blank entries are ignored. */
export function ipMatchesAny(ip: string, entries: string[]): boolean {
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (matchOne(ip, entry)) return true;
  }
  return false;
}

/** Validates a single allowlist entry: an IPv4/IPv6 address or CIDR. */
export function isValidIpOrCidr(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  const slash = trimmed.indexOf('/');
  const network = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const v6 = isV6(network);
  const parsed = v6 ? ipv6ToInt(network) : ipv4ToInt(network);
  if (parsed === null) return false;
  if (slash === -1) return true;
  const bits = Number(trimmed.slice(slash + 1));
  const maxBits = v6 ? 128 : 32;
  return Number.isInteger(bits) && bits >= 0 && bits <= maxBits;
}
