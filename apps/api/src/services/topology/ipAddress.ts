/** Small IPv4/IPv6 helpers shared by the grouped overview and the neighbour-evidence selector. */
export type Family = 4 | 6;
export type Parsed = { family: Family; value: bigint };

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}
function parseIpv6(text: string): bigint | null {
  let value = text.toLowerCase();
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    // Embedded IPv4 (::ffff:10.1.2.3) becomes its two trailing groups.
    const v4 = parseIpv4(tail);
    if (v4 === null) return null;
    value = `${value.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]!);
  const rest = halves.length === 2 ? groupsOf(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  let result = 0n;
  for (const group of [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(parseInt(group, 16));
  }
  return result;
}
/** Parse an IPv4 or IPv6 address; an IPv6 zone (`%eth0`) is ignored. */
export function parseIpAddress(text: string): Parsed | null {
  const address = text.trim().split('%')[0]!;
  if (address.includes(':')) {
    const value = parseIpv6(address);
    return value === null ? null : { family: 6, value };
  }
  const value = parseIpv4(address);
  return value === null ? null : { family: 4, value };
}
export function parsePrefix(prefix: string): (Parsed & { length: number }) | null {
  const [base = '', lengthText, extra] = prefix.split('/');
  if (extra !== undefined) return null;
  const parsed = parseIpAddress(base);
  if (!parsed) return null;
  const bits = parsed.family === 4 ? 32 : 128;
  const length = lengthText === undefined ? bits : Number(lengthText);
  if (!/^\d{1,3}$/.test(lengthText ?? String(bits)) || length > bits) return null;
  return { ...parsed, length };
}
/** True when `address` lies inside `prefix` (IPv4 or IPv6, same family only). */
export function cidrContains(prefix: string, address: string): boolean {
  const network = parsePrefix(prefix);
  const host = parseIpAddress(address);
  if (!network || !host || network.family !== host.family) return false;
  const shift = BigInt((network.family === 4 ? 32 : 128) - network.length);
  return (network.value >> shift) === (host.value >> shift);
}

