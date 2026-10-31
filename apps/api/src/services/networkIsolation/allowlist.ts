import { isIP } from 'node:net';
import {
  ECH_DOH_ENDPOINT_URLS,
  NETWORK_ISOLATION_LIMITS,
  isolationAllowEntrySchema,
  type IsolationAllowEntry,
} from '@breeze/shared';

/**
 * The management-plane allowlist for an isolated device (spec §3.4). The server builds it from its own
 * environment on every isolate and every heartbeat; the agent resolves the host names and installs
 * numeric permits. Neither the AI nor an operator supplies entries: every entry built here is
 * `scope: 'breeze'` (Breeze processes only, where the OS can match a process), and a `scope: 'any'`
 * entry can only arrive through `policyExtras` (the W4 containment policy).
 *
 * Address literals become single-address `cidr` entries (`/32`, `/128`); `host` entries are DNS names
 * only. Nothing here resolves a name and no resolved address is ever stored (allow_snapshot keeps this
 * output). Every entry is checked against the wire schema before it is returned, and anything that
 * cannot be expressed throws `IsolationAllowlistError` naming its source: an isolation must never be
 * sent with a missing or malformed control-plane permit. Callers decide what a throw means — refuse
 * the isolate request, or (heartbeat, W1b) keep sending the episode's stored allow_snapshot.
 *
 * `remoteRelay` with no TURN host configured adds no relay permit: without TURN the API advertises no
 * relay at all, so there is nothing to permit. Whether to accept `remoteRelay: true` on such a
 * deployment is the start route's call (W1b).
 */

export interface IsolationAllowlistContext {
  /** The URL the device's agent talks to (its control plane). */
  serverUrl: string;
  /** Permit the TURN relay so relay-only remote desktop keeps working while isolated. */
  remoteRelay: boolean;
  /** Policy-supplied extras (W4). The only source of `scope: 'any'`. */
  policyExtras?: readonly IsolationAllowEntry[];
  /** Defaults to process.env; injectable for tests. Reads AGENT_BACKUP_SERVER_URL and TURN_*. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The allowlist cannot be built from this configuration. `source` names the input at fault. */
export class IsolationAllowlistError extends Error {
  constructor(readonly source: string, message: string) {
    super(`${source}: ${message}`);
    this.name = 'IsolationAllowlistError';
  }
}

type Proto = IsolationAllowEntry['proto'];
type Destination = { kind: 'host'; host: string } | { kind: 'cidr'; cidr: string };

const DEFAULT_TURN_PORT = 3478;
const DEFAULT_TURN_TLS_PORT = 5349;

function destinationOf(hostname: string): Destination {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const family = isIP(bare);
  if (family === 4) return { kind: 'cidr', cidr: `${bare}/32` };
  if (family === 6) return { kind: 'cidr', cidr: `${bare.toLowerCase()}/128` };
  return { kind: 'host', host: bare.toLowerCase() };
}

function urlDestination(raw: string, source: string): { destination: Destination; port: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IsolationAllowlistError(source, 'is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new IsolationAllowlistError(source, 'must be an http(s) URL');
  }
  if (!url.hostname) throw new IsolationAllowlistError(source, 'has no host');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { destination: destinationOf(url.hostname), port };
}

function parsePort(raw: string | undefined, fallback: number, source: string): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new IsolationAllowlistError(source, 'must be a port number');
  return port;
}

export function buildIsolationAllowlist(ctx: IsolationAllowlistContext): IsolationAllowEntry[] {
  const env = ctx.env ?? process.env;
  // Destinations merge on (destination, proto): one entry per host with every port it needs.
  const merged = new Map<string, { destination: Destination; proto: Proto; ports: Set<number>; sources: Set<string> }>();
  const permit = (destination: Destination, proto: Proto, ports: readonly number[], source: string) => {
    const key = `${destination.kind}|${destination.kind === 'host' ? destination.host : destination.cidr}|${proto}`;
    const existing = merged.get(key);
    if (existing) {
      for (const p of ports) existing.ports.add(p);
      existing.sources.add(source);
    } else {
      merged.set(key, { destination, proto, ports: new Set(ports), sources: new Set([source]) });
    }
  };

  // 1. The control plane: always.
  const control = urlDestination(ctx.serverUrl, 'serverUrl');
  permit(control.destination, 'tcp', [control.port], 'serverUrl');

  // 2. The backup control plane, when configured (agent failover).
  const backupRaw = env.AGENT_BACKUP_SERVER_URL?.trim();
  if (backupRaw) {
    const backup = urlDestination(backupRaw, 'AGENT_BACKUP_SERVER_URL');
    permit(backup.destination, 'tcp', [backup.port], 'AGENT_BACKUP_SERVER_URL');
  }

  // 3. The TURN relay, only when the episode asks for relay-only remote desktop.
  if (ctx.remoteRelay) {
    const ports = [
      parsePort(env.TURN_PORT, DEFAULT_TURN_PORT, 'TURN_PORT'),
      parsePort(env.TURN_TLS_PORT, DEFAULT_TURN_TLS_PORT, 'TURN_TLS_PORT'),
    ];
    for (const source of ['TURN_HOST', 'TURN_TLS_HOST'] as const) {
      const host = env[source]?.trim();
      if (host) permit(destinationOf(host), 'udp+tcp', ports, source);
    }
  }

  // 4. The ECH DoH endpoints the agent's control-plane dial uses (spec §3.4; DoH tunnelling through
  //    them is an accepted residual risk there).
  for (const url of ECH_DOH_ENDPOINT_URLS) {
    const doh = urlDestination(url, 'ECH_DOH_ENDPOINT_URLS');
    permit(doh.destination, 'tcp', [doh.port], 'ECH_DOH_ENDPOINT_URLS');
  }

  const built: IsolationAllowEntry[] = [];
  for (const { destination, proto, ports, sources } of merged.values()) {
    const candidate = { ...destination, proto, ports: [...ports].sort((a, b) => a - b), scope: 'breeze' as const };
    const parsed = isolationAllowEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      const what = destination.kind === 'host' ? destination.host : destination.cidr;
      throw new IsolationAllowlistError([...sources].join(', '), `cannot express ${JSON.stringify(what)} as an isolation permit`);
    }
    built.push(parsed.data);
  }

  // 5. Policy extras, validated, appended as given.
  for (const [i, extra] of (ctx.policyExtras ?? []).entries()) {
    const parsed = isolationAllowEntrySchema.safeParse(extra);
    if (!parsed.success) throw new IsolationAllowlistError(`policyExtras[${i}]`, 'is not a valid isolation permit');
    built.push(parsed.data);
  }

  if (built.length > NETWORK_ISOLATION_LIMITS.maxAllowEntries) {
    throw new IsolationAllowlistError(
      'policyExtras',
      `the allowlist has ${built.length} entries; at most ${NETWORK_ISOLATION_LIMITS.maxAllowEntries} fit in one desired block`,
    );
  }
  return built;
}
