import { isIP } from 'node:net';
import { Queue } from 'bullmq';

import { ipClassifyApiKey, ipClassifyProvider } from '../config/env';
import type { IpClass } from '../db/schema/orgs';
import { partnerTrustMode } from '../config/partnerTrustMode';
import { getBullMQConnection, getRedis } from './redis';

const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 3_000;
const ABUSE_SIGNALS_QUEUE = 'abuse-signals';

export type IpClassification = {
  ipClass: IpClass;
  asn: number | null;
  provider: string;
};

export type IpClassifyTarget =
  | { kind: 'partner'; partnerId: string; ip: string }
  | { kind: 'device'; deviceId: string; ip: string };

let queue: Queue<IpClassifyTarget> | null = null;

function offlineClassification(ip: string): IpClassification {
  return {
    ipClass: isPrivateOrLoopback(ip) ? 'residential' : 'unknown',
    asn: null,
    provider: 'none',
  };
}

function isPrivateOrLoopback(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split('.').map(Number);
    return a === 10
      || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd');
  }
  return false;
}

function expandIpv6(ip: string): string[] | null {
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array(fill).fill('0'), ...right].map((part) => part.padStart(4, '0'));
}

export function ipCachePrefix(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (version === 6) {
    const parts = expandIpv6(ip);
    return parts ? `${parts.slice(0, 3).join(':')}::/48` : null;
  }
  return null;
}

function parseAsn(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/^AS/i, ''));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function mapProviderResponse(provider: 'ipinfo' | 'ipdata', body: any): IpClassification {
  if (provider === 'ipinfo') {
    const privacy = body?.privacy ?? {};
    const ipClass: IpClass = privacy.tor === true
      ? 'tor'
      : privacy.vpn === true
        ? 'vpn'
        : privacy.hosting === true
          ? 'hosting'
          : body?.company?.type === 'business'
            ? 'business'
            : 'residential';
    return { ipClass, asn: parseAsn(body?.asn?.asn ?? body?.asn), provider };
  }

  const threat = body?.threat ?? {};
  const ipClass: IpClass = threat.is_tor === true
    ? 'tor'
    : threat.is_vpn === true || threat.is_proxy === true
      ? 'vpn'
      : threat.is_datacenter === true || threat.is_hosting === true
        ? 'hosting'
        : body?.company?.type === 'business'
          ? 'business'
          : 'residential';
  return { ipClass, asn: parseAsn(body?.asn?.asn ?? body?.asn), provider };
}

function providerUrl(provider: 'ipinfo' | 'ipdata', ip: string, key: string): string {
  const encodedIp = encodeURIComponent(ip);
  const encodedKey = encodeURIComponent(key);
  return provider === 'ipinfo'
    ? `https://ipinfo.io/${encodedIp}/json?token=${encodedKey}`
    : `https://api.ipdata.co/${encodedIp}?api-key=${encodedKey}`;
}

function isCachedClassification(value: unknown): value is IpClassification {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return ['residential', 'business', 'hosting', 'vpn', 'tor', 'unknown'].includes(String(rec.ipClass))
    && (rec.asn === null || typeof rec.asn === 'number')
    && typeof rec.provider === 'string';
}

export async function classifyIp(ip: string): Promise<IpClassification> {
  const provider = ipClassifyProvider();
  if (provider === 'none') return offlineClassification(ip);

  const prefix = ipCachePrefix(ip);
  if (!prefix) return { ipClass: 'unknown', asn: null, provider };
  const cacheKey = `ipclass:v1:${prefix}`;
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed: unknown = JSON.parse(cached);
        if (isCachedClassification(parsed)) return parsed;
      }
    } catch {
      // Cache availability and malformed old values must not block lookup.
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(providerUrl(provider, ip, ipClassifyApiKey()), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`IP classification provider returned ${response.status}`);
    const result = mapProviderResponse(provider, await response.json());
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
      } catch {
        // Classification remains useful even when caching is unavailable.
      }
    }
    return result;
  } catch {
    return { ipClass: 'unknown', asn: null, provider };
  } finally {
    clearTimeout(timeout);
  }
}

export async function enqueueIpClassify(target: IpClassifyTarget): Promise<void> {
  if (partnerTrustMode() === 'off') return;
  if (!queue) {
    queue = new Queue<IpClassifyTarget>(ABUSE_SIGNALS_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  await queue.add('ip-classify', target, {
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1_000 },
  });
}

export async function shutdownIpClassifyQueue(): Promise<void> {
  if (queue) await queue.close();
  queue = null;
}
