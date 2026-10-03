/**
 * Numeric ordering and identity for IP addresses shown on topology tiles (#7880).
 * A plain string sort puts 10.1.2.14 after 10.1.2.137; these keys sort IPv4 by
 * value, then IPv6 by value, and treat different spellings of one IPv6 address
 * (`fe80::1`, `FE80:0:0:0:0:0:0:0001`, a `%zone` suffix) as the same address.
 */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(value: string): number[] | null {
  const match = IPV4.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function ipv6Hextets(raw: string): number[] | null {
  const value = raw.replace(/%.*$/, '');
  if (!value.includes(':') || value.split('::').length > 2) return null;
  const expand = (part: string) => {
    if (!part) return [] as number[];
    const pieces = part.split(':'), result: number[] = [];
    for (const [index, piece] of pieces.entries()) {
      // An embedded IPv4 tail (`::ffff:10.1.2.3`) is the last two hextets.
      const v4 = index === pieces.length - 1 ? ipv4Octets(piece) : null;
      if (v4) { result.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!); continue; }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      result.push(parseInt(piece, 16));
    }
    return result;
  };
  const [head, tail] = value.split('::');
  const left = expand(head!), right = tail === undefined ? [] : expand(tail);
  if (!left || !right) return null;
  if (tail === undefined) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  return fill >= 1 ? [...left, ...Array<number>(fill).fill(0), ...right] : null;
}

/** A fixed-width key that sorts lexically in numeric address order (IPv4 first), or null when `value` is not an IP address. */
export function ipSortKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const v4 = ipv4Octets(trimmed);
  if (v4) return `4:${v4.map((octet) => octet.toString(16).padStart(2, '0')).join('')}`;
  const v6 = ipv6Hextets(trimmed);
  return v6 ? `6:${v6.map((hextet) => hextet.toString(16).padStart(4, '0')).join('')}` : null;
}

/** Sort comparator: IPv4 by value, then IPv6 by value, then anything that is not an address (left in its original order). */
export function compareIpAddresses(a: string | null | undefined, b: string | null | undefined): number {
  const ka = ipSortKey(a), kb = ipSortKey(b);
  if (ka === kb) return 0;
  if (ka === null) return 1;
  if (kb === null) return -1;
  return ka < kb ? -1 : 1;
}
