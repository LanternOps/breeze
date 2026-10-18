// Network Proxy dedicated tunnel origin (#8155 W03, plan Task 15) on a
// worktree stack (`pnpm wt-stack up`).
//
// The app runs on `app.localhost:<port>` and tunnels on
// `<id>.tunnel.localhost:<port>`: different registrable domains, so the iframe
// is genuinely cross-site (plan amendment 2 / W00). Bare `localhost` would not
// prove that. Chromium and Firefox store `Secure` / `Partitioned` cookies on
// `http://*.localhost`; WebKit does not (spec "W00 spike results").
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setStackEnvValues } from '../../scripts/dev/wt-stack/env';
import { composeArgs } from './topologyPhysicalSeed';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export const TUNNEL_SUFFIX = 'tunnel.localhost';
export const APP_HOST = 'app.localhost';
/** The seeded device the tunnels are opened on (e2e-tests/seed-fixtures.sql). No agent is connected. */
const DEVICE_AGENT_ID = 'e2e-macos-agent';
const ADMIN_EMAIL = 'admin@breeze.local';

function stackPort(): number {
  const file = process.env.E2E_STACK_FILE ?? path.join(repoRoot, '.breeze-stack.json');
  let parsed: { webPort?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { webPort?: unknown };
  } catch (err) {
    throw new Error(`tunnel-origin e2e needs a worktree stack (${file}); run \`pnpm wt-stack up\` first: ${String(err)}`);
  }
  if (typeof parsed.webPort !== 'number') throw new Error(`${file} has no numeric webPort`);
  return parsed.webPort;
}

/** The app origin every spec in this suite uses (also the config's baseURL). */
export function appBaseUrl(): string {
  return `http://${APP_HOST}:${stackPort()}`;
}

export function tunnelHost(id: string): string {
  return `${id}.${TUNNEL_SUFFIX}`;
}

function compose(args: string[], opts: { encoding?: 'utf8' } = {}): string {
  return execFileSync('docker', [...composeArgs(), ...args], {
    cwd: repoRoot,
    encoding: opts.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 300_000,
  });
}

function psql(sql: string): string {
  // `breeze` is the postgres superuser in the dev image, so RLS does not apply;
  // the system scope is set anyway so the statement is valid under breeze_app too.
  return compose(['exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze', '-v', 'ON_ERROR_STOP=1', '-tA',
    '-c', `SELECT set_config('breeze.scope','system',false);`, '-c', sql]);
}

function recreateApiAndCaddy(port: number): void {
  compose(['up', '-d', '--no-deps', '--force-recreate', 'api', 'caddy']);
  compose(['exec', '-T', 'api', 'sh', '-c',
    'for i in $(seq 1 120); do wget -qO- http://127.0.0.1:3001/health >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1']);
  // Caddy is up once the app answers through it on the pinned port.
  execFileSync('sh', ['-c',
    `for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:${port}/health && exit 0; sleep 1; done; exit 1`],
  { stdio: 'inherit', timeout: 90_000 });
}

/**
 * Turn host mode on for this worktree stack and recreate api + caddy.
 * Caddy's published port is pinned to its current value first: a recreate
 * would otherwise pick a new ephemeral port and strand the template (#8718).
 */
export function enableTunnelOriginOnStack(): { port: number; appOrigin: string } {
  const port = stackPort();
  const appOrigin = `http://${APP_HOST}:${port}`;
  setStackEnvValues(repoRoot, {
    BREEZE_WT_CADDY_PORT: String(port),
    TUNNEL_ORIGIN_TEMPLATE: `http://{id}.${TUNNEL_SUFFIX}:${port}`,
    TUNNEL_FRAME_ANCESTOR: appOrigin,
    TUNNEL_SITE_ADDRESS: `http://*.${TUNNEL_SUFFIX}, http://*.*.${TUNNEL_SUFFIX}`,
    TUNNEL_HOST_SUFFIX: TUNNEL_SUFFIX,
    // With a template set, the API validator checks separation from every app
    // URL and refuses compose's host-less `https://${BREEZE_DOMAIN}/portal`.
    PUBLIC_PORTAL_URL: `${appOrigin}/portal`,
  });
  recreateApiAndCaddy(port);
  return { port, appOrigin };
}

/** Back to the default (host mode off, Caddy tunnel block on the placeholder). */
export function disableTunnelOriginOnStack(): void {
  const port = stackPort();
  setStackEnvValues(repoRoot, {
    BREEZE_WT_CADDY_PORT: String(port),
    TUNNEL_ORIGIN_TEMPLATE: '',
    TUNNEL_FRAME_ANCESTOR: '',
    TUNNEL_SITE_ADDRESS: '',
    TUNNEL_HOST_SUFFIX: '',
    PUBLIC_PORTAL_URL: '',
  });
  recreateApiAndCaddy(port);
}

/**
 * Set the seeded device's partner opt-in (`settings.networkProxy`), or clear it
 * with `null`. The API resolves it per tunnel from the session's org.
 */
export function setPartnerTunnelOriginOptIn(value: boolean | null): void {
  const next = value === null
    ? `COALESCE(p.settings, '{}'::jsonb) - 'networkProxy'`
    : `jsonb_set(COALESCE(p.settings, '{}'::jsonb), '{networkProxy}', '{"dedicatedTunnelOrigin": ${value}}'::jsonb, true)`;
  const out = psql(`UPDATE partners p SET settings = ${next}
    FROM organizations o JOIN devices d ON d.org_id = o.id
    WHERE d.agent_id = '${DEVICE_AGENT_ID}' AND p.id = o.partner_id RETURNING p.id;`);
  if (!/[0-9a-f-]{36}/.test(out)) throw new Error(`setPartnerTunnelOriginOptIn: no partner updated:\n${out}`);
}

/** A fresh pending proxy tunnel on the seeded macOS device, owned by the e2e admin. */
export function seedProxyTunnel(): string {
  const out = psql(`INSERT INTO tunnel_sessions (device_id, user_id, org_id, type, status, target_host, target_port, scheme)
    SELECT d.id, u.id, d.org_id, 'proxy', 'pending', '192.0.2.10', 80, 'http'
    FROM devices d, users u WHERE d.agent_id = '${DEVICE_AGENT_ID}' AND u.email = '${ADMIN_EMAIL}'
    RETURNING id;`);
  const id = out.split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f-]{36}$/.test(l));
  if (!id) throw new Error(`seedProxyTunnel: no id in:\n${out}`);
  return id;
}

export function tunnelStatus(id: string): string {
  return psql(`SELECT status FROM tunnel_sessions WHERE id = '${id}';`).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
}
