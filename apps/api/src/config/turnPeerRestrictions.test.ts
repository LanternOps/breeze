import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every shipped coturn configuration must confine relay allocations to public
 * peers: loopback, private/VPC, CGNAT/tailnet, link-local (including the cloud
 * metadata address), documentation/benchmark, multicast and reserved ranges are
 * refused, for IPv4 and IPv6 alike. The same rule set is shipped in four places
 * (the standalone config template, both Compose files and the external-server
 * guide), so this also pins them to one another.
 *
 * The dev override is intentionally out of scope: it runs with host networking
 * and `external-ip=127.0.0.1`, so loopback relaying is how it works locally.
 */

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function coturnBlock(composeFile: string): string {
  const text = read(composeFile);
  const start = text.indexOf('\n  coturn:');
  expect(start, `${composeFile} has no coturn service`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n(?: {2})?[a-z_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function docsConfig(): string {
  const text = read('apps/docs/src/content/docs/deploy/turn-server.mdx');
  const start = text.indexOf("cat > /etc/turnserver.conf <<'EOF'");
  expect(start, 'turn-server guide has no turnserver.conf heredoc').toBeGreaterThan(-1);
  const end = text.indexOf('\nEOF', start);
  return text.slice(start, end);
}

interface Source {
  name: string;
  text: string;
  /** Active (uncommented) option lines, normalised to `key[=value]`. */
  options: string[];
  /** Commented-out option lines, normalised the same way. */
  commented: string[];
}

function confSource(name: string, text: string): Source {
  const lines = text.split('\n').map((l) => l.trim());
  return {
    name,
    text,
    options: lines.filter((l) => l && !l.startsWith('#')),
    commented: lines.filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s*/, '')),
  };
}

function composeSource(file: string): Source {
  const block = coturnBlock(file);
  // List items may be YAML-quoted (a value ending in `:` must be, or it parses
  // as a mapping), so unquote them.
  const lines = block
    .split('\n')
    .map((l) => l.trim().replace(/^(#\s*)?- '(.*)'$/, '$1- $2'));
  return {
    name: file,
    text: block,
    options: lines.filter((l) => l.startsWith('- --')).map((l) => l.slice(4)),
    commented: lines.filter((l) => /^#\s*- --/.test(l)).map((l) => l.replace(/^#\s*- --/, '')),
  };
}

const SOURCES: Source[] = [
  confSource('docker/turnserver.conf', read('docker/turnserver.conf')),
  composeSource('docker-compose.yml'),
  composeSource('deploy/docker-compose.prod.yml'),
  confSource('turn-server.mdx heredoc', docsConfig()),
];

function ipToBigInt(ip: string): { family: 4 | 6; value: bigint } {
  if (!ip.includes(':')) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      throw new Error(`bad IPv4 ${ip}`);
    }
    return { family: 4, value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = ip.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  if (groups.length !== 8) throw new Error(`bad IPv6 ${ip}`);
  return { family: 6, value: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

function denyRanges(src: Source) {
  return src.options
    .filter((o) => o.startsWith('denied-peer-ip='))
    .map((o) => {
      const spec = o.slice('denied-peer-ip='.length);
      // coturn ranges are `first-last`; IPv6 addresses never contain `-`.
      const [lo = '', hi = lo] = spec.split('-');
      const a = ipToBigInt(lo);
      const b = ipToBigInt(hi);
      expect(a.family, `${src.name}: mixed-family range ${spec}`).toBe(b.family);
      expect(a.value <= b.value, `${src.name}: inverted range ${spec}`).toBe(true);
      return { spec, family: a.family, lo: a.value, hi: b.value };
    });
}

type Addr = { family: 4 | 6; value: bigint };

/**
 * coturn's own `addr_less_eq`: addresses of different families compare by
 * family number (AF_INET < AF_INET6), so an IPv4 address sorts below every
 * IPv6 address.
 */
function coturnLessEq(a: Addr, b: Addr): boolean {
  if (a.family !== b.family) return a.family < b.family;
  return a.value <= b.value;
}

/**
 * coturn's own `ioa_addr_in_range`: an all-zero bound (`0.0.0.0` or `::`) is
 * treated as "no bound". A lone `::` entry therefore matches every peer, and an
 * IPv6 range starting at `::` matches every IPv4 peer. Modelling this exactly
 * is what lets the public-peer checks below catch such an entry.
 */
function coturnInRange(r: { family: 4 | 6; lo: bigint; hi: bigint }, ip: Addr): boolean {
  const lo: Addr = { family: r.family, value: r.lo };
  const hi: Addr = { family: r.family, value: r.hi };
  if (r.lo !== 0n && !coturnLessEq(lo, ip)) return false;
  return r.hi === 0n || coturnLessEq(ip, hi);
}

function isDenied(src: Source, ip: string): boolean {
  const addr = ipToBigInt(ip);
  return denyRanges(src).some((r) => coturnInRange(r, addr));
}

// The unspecified addresses (`0.0.0.0`, `::`) need no entry: coturn refuses a
// zero peer address on its own. Listing `::` would match every peer (see
// coturnInRange), so the configs must not.
const MUST_DENY = [
  '0.0.0.1',
  '10.124.0.4',
  '100.114.219.9', // CGNAT / tailnet
  '127.0.0.1',
  '169.254.169.254', // cloud metadata
  '172.16.5.5',
  '192.0.0.8',
  '192.0.2.10',
  '192.88.99.1',
  '192.168.1.1',
  '198.18.0.1',
  '198.51.100.7',
  '203.0.113.5',
  '224.0.0.1',
  '255.255.255.255',
  '::1',
  '64:ff9b:1::a00:1',
  // IPv4-mapped IPv6 (::ffff:0:0/96): 127.0.0.1, 10.124.0.4, 169.254.169.254
  '::ffff:7f00:1',
  '::ffff:a7c:4',
  '::ffff:a9fe:a9fe',
  // NAT64 well-known prefix (64:ff9b::/96): 127.0.0.1, 169.254.169.254
  '64:ff9b::7f00:1',
  '64:ff9b::a9fe:a9fe',
  '2001::1',
  '2002:a00:1::1',
  'fd12:3456::1',
  'fe80::1',
  'ff02::1',
];

const MUST_ALLOW = ['8.8.8.8', '1.1.1.1', '203.0.114.1', '2606:4700:4700::1111', '2001:4860:4860::8888'];

describe.each(SOURCES)('coturn peer restrictions ($name)', (src) => {
  it.each(MUST_DENY)('refuses relaying to %s', (ip) => {
    expect(isDenied(src, ip)).toBe(true);
  });

  it.each(MUST_ALLOW)('still relays to public peer %s', (ip) => {
    expect(isDenied(src, ip)).toBe(false);
  });

  it('has no entry with an all-zero bound that coturn reads as unbounded', () => {
    for (const r of denyRanges(src)) {
      expect(r.hi, `${src.name}: ${r.spec} has an all-zero upper bound`).not.toBe(0n);
      if (r.family === 6) {
        expect(r.lo, `${src.name}: ${r.spec} starts at :: and would match every IPv4 peer`).not.toBe(0n);
      }
    }
  });

  it('disables TCP relay and multicast peers', () => {
    expect(src.options).toContain('no-tcp-relay');
    expect(src.options).toContain('no-multicast-peers');
  });

  it('keeps per-user and total allocation quotas', () => {
    expect(src.options.some((o) => o.startsWith('user-quota='))).toBe(true);
    expect(src.options.some((o) => o.startsWith('total-quota='))).toBe(true);
  });

  it('does not enable verbose logging', () => {
    expect(src.options).not.toContain('verbose');
  });

  it('denies the IPv4-mapped and NAT64 ranges as active rules', () => {
    const mapped = 'denied-peer-ip=::ffff:0:0-::ffff:ffff:ffff';
    const nat64 = 'denied-peer-ip=64:ff9b::-64:ff9b::ffff:ffff';
    for (const line of [mapped, nat64]) {
      expect(src.options).toContain(line);
      expect(src.commented).not.toContain(line);
    }
  });

  it("warns against denying the relay's own public address", () => {
    expect(src.text).toMatch(/own public (IP|address)/i);
  });
});

describe('coturn peer restrictions stay identical across shipped configs', () => {
  const [reference, ...others] = SOURCES as [Source, ...Source[]];
  const canonical = denyRanges(reference).map((r) => r.spec).sort();
  it.each(others)('$name matches docker/turnserver.conf', (src) => {
    expect(denyRanges(src).map((r) => r.spec).sort()).toEqual(canonical);
  });
});
