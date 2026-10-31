import { isIP } from 'node:net';
import { ECH_DOH_ENDPOINT_URLS, isolationAllowEntrySchema, type IsolationAllowEntry } from '@breeze/shared';

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
 * cannot be expressed throws: an isolation must never be sent without a working control-plane permit.
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

function urlDestination(raw: string, label: string): { destination: Destination; port: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (!url.hostname) throw new Error(`${label} has no host`);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { destination: destinationOf(url.hostname), port };
}

function parsePort(raw: string | undefined, fallback: number, label: string): number {
  const value = raw?.trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be a port number`);
  return port;
}

export function buildIsolationAllowlist(ctx: IsolationAllowlistContext): IsolationAllowEntry[] {
  const env = ctx.env ?? process.env;
  // Destinations merge on (destination, proto): one entry per host with every port it needs.
  const merged = new Map<string, { destination: Destination; proto: Proto; ports: Set<number> }>();
  const permit = (destination: Destination, proto: Proto, ports: readonly number[]) => {
    const key = `${destination.kind}|${destination.kind === 'host' ? destination.host : destination.cidr}|${proto}`;
    const existing = merged.get(key);
    if (existing) for (const p of ports) existing.ports.add(p);
    else merged.set(key, { destination, proto, ports: new Set(ports) });
  };

  // 1. The control plane: always.
  const control = urlDestination(ctx.serverUrl, 'serverUrl');
  permit(control.destination, 'tcp', [control.port]);

  // 2. The backup control plane, when configured (agent failover).
  const backupRaw = env.AGENT_BACKUP_SERVER_URL?.trim();
  if (backupRaw) {
    const backup = urlDestination(backupRaw, 'AGENT_BACKUP_SERVER_URL');
    permit(backup.destination, 'tcp', [backup.port]);
  }

  // 3. The TURN relay, only when the episode asks for relay-only remote desktop.
  if (ctx.remoteRelay) {
    const ports = [
      parsePort(env.TURN_PORT, DEFAULT_TURN_PORT, 'TURN_PORT'),
      parsePort(env.TURN_TLS_PORT, DEFAULT_TURN_TLS_PORT, 'TURN_TLS_PORT'),
    ];
    for (const raw of [env.TURN_HOST, env.TURN_TLS_HOST]) {
      const host = raw?.trim();
      if (host) permit(destinationOf(host), 'udp+tcp', ports);
    }
  }

  // 4. The ECH DoH endpoints the agent's control-plane dial uses.
  for (const url of ECH_DOH_ENDPOINT_URLS) {
    const doh = urlDestination(url, 'ECH_DOH_ENDPOINT_URLS');
    permit(doh.destination, 'tcp', [doh.port]);
  }

  const built: IsolationAllowEntry[] = [];
  for (const { destination, proto, ports } of merged.values()) {
    const candidate = { ...destination, proto, ports: [...ports].sort((a, b) => a - b), scope: 'breeze' as const };
    const parsed = isolationAllowEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`cannot express ${destination.kind === 'host' ? destination.host : destination.cidr} as an isolation permit`);
    }
    built.push(parsed.data);
  }

  // 5. Policy extras, validated, appended as given.
  for (const [i, extra] of (ctx.policyExtras ?? []).entries()) {
    const parsed = isolationAllowEntrySchema.safeParse(extra);
    if (!parsed.success) throw new Error(`policyExtras[${i}] is not a valid isolation permit`);
    built.push(parsed.data);
  }

  return built;
}
