import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.yml');
const CADDYFILE_PROD_PATH = path.join(REPO_ROOT, 'docker', 'Caddyfile.prod');

interface ComposeNetworkAttachment {
  ipv4_address?: string;
}

interface ComposeService {
  environment?: Record<string, string> | string[];
  networks?: string[] | Record<string, ComposeNetworkAttachment | null>;
}

interface ComposeNetworkDefinition {
  ipam?: { config?: Array<{ subnet?: string }> };
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, ComposeNetworkDefinition>;
}

function loadCompose(): ComposeFile {
  const raw = readFileSync(COMPOSE_PATH, 'utf8');
  return yaml.load(raw) as ComposeFile;
}

/**
 * docker-compose `${VAR}` / `${VAR:-default}` interpolation is invisible to
 * js-yaml — it just hands back the literal string. Resolve it the same way
 * Compose would when the shell env var is unset, which is exactly the
 * out-of-the-box `docker compose up` scenario this suite locks down.
 */
function resolveDefault(rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) return undefined;
  const trimmed = rawValue.trim();
  const withDefault = /^\$\{[A-Z0-9_]+:-(.*)\}$/.exec(trimmed);
  if (withDefault) return withDefault[1];
  if (/^\$\{[A-Z0-9_]+\}$/.test(trimmed)) return undefined; // no fallback -> unset
  return trimmed; // plain literal, not interpolation at all
}

function getServiceEnv(service: ComposeService | undefined, key: string): string | undefined {
  const env = service?.environment;
  if (!env) return undefined;
  if (Array.isArray(env)) {
    const entry = env.find((line) => line.startsWith(`${key}=`));
    return entry === undefined ? undefined : entry.slice(key.length + 1);
  }
  return env[key];
}

function getPinnedIpv4(service: ComposeService | undefined): string | undefined {
  const networks = service?.networks;
  if (!networks || Array.isArray(networks)) return undefined;
  return networks.breeze?.ipv4_address;
}

/**
 * Pure guard used by both the real-compose assertion below and a synthetic
 * red-path test, so we can prove the check itself actually fails on a bad
 * config rather than just happening to pass today because trust is off.
 */
function assertProxyTrustGuard(
  trustDefault: string | undefined,
  cidrsDefault: string | undefined,
  caddyIp: string | undefined,
): void {
  if (trustDefault !== 'true') return; // trust is opt-in; nothing to enforce
  if (!caddyIp) {
    throw new Error('TRUST_PROXY_HEADERS defaults to true but the caddy service has no pinned ipv4_address');
  }
  if (!cidrsDefault) {
    throw new Error('TRUST_PROXY_HEADERS defaults to true but TRUSTED_PROXY_CIDRS has no default (fails closed at best, spoofable at worst)');
  }
  const expected = `${caddyIp}/32`;
  if (cidrsDefault !== expected) {
    throw new Error(`TRUSTED_PROXY_CIDRS default "${cidrsDefault}" does not match the pinned caddy peer "${expected}"`);
  }
}

describe('bundled Caddy peer pinning + proxy-trust static contract (SR2-16)', () => {
  const compose = loadCompose();
  const caddy = compose.services.caddy;
  const api = compose.services.api;
  const network = compose.networks?.breeze;

  it('pins the caddy service to a static ipv4_address on a network with a declared subnet', () => {
    expect(caddy).toBeDefined();

    const ip = getPinnedIpv4(caddy);
    expect(ip, 'caddy service must declare networks.breeze.ipv4_address').toBeTruthy();
    // Must be a real dotted-quad, not a leftover interpolation expression.
    expect(ip).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);

    const subnets = (network?.ipam?.config ?? []).map((c) => c.subnet).filter(Boolean);
    expect(subnets.length, 'breeze network must declare an ipam subnet').toBeGreaterThan(0);
  });

  it('locks TRUST_PROXY_HEADERS default to false (opt-in trust — owner decision, SR2-16)', () => {
    const resolved = resolveDefault(getServiceEnv(api, 'TRUST_PROXY_HEADERS'));
    expect(resolved).toBe('false');
  });

  it('guard-bites on the real compose file: if TRUST_PROXY_HEADERS ever defaults to true, TRUSTED_PROXY_CIDRS must pin to the caddy address', () => {
    const trustDefault = resolveDefault(getServiceEnv(api, 'TRUST_PROXY_HEADERS'));
    const cidrsDefault = resolveDefault(getServiceEnv(api, 'TRUSTED_PROXY_CIDRS'));
    const caddyIp = getPinnedIpv4(caddy);

    expect(() => assertProxyTrustGuard(trustDefault, cidrsDefault, caddyIp)).not.toThrow();
  });

  it('guard-bite sanity check: the guard itself fails on a trust-on-but-unpinned config (proves it is not a vacuous no-op)', () => {
    expect(() => assertProxyTrustGuard('true', undefined, '172.31.0.10')).toThrow(/no default/);
    expect(() => assertProxyTrustGuard('true', '10.0.0.1/32', '172.31.0.10')).toThrow(/does not match/);
    expect(() => assertProxyTrustGuard('true', '172.31.0.10/32', undefined)).toThrow(/no pinned ipv4_address/);
    // The one shape that should pass once trust ever defaults on:
    expect(() => assertProxyTrustGuard('true', '172.31.0.10/32', '172.31.0.10')).not.toThrow();
  });

  it('Caddyfile.prod still overwrites client_ip_headers at the edge', () => {
    const caddyfile = readFileSync(CADDYFILE_PROD_PATH, 'utf8');
    expect(caddyfile).toMatch(/client_ip_headers/);
  });
});
