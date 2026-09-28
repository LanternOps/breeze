import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `physical-enrichment` fixture for the REAL worktree stack (not a mocked
 * server): the seed runs inside the stack's api container through the same
 * routes, authority, ingest and publisher as the API vertical integration test
 * (apps/api/src/__tests__/helpers/topologyPhysical.ts). Only the switches' SNMP
 * agents and the UniFi controller are simulated, at the transport boundary.
 */
export type PhysicalTopologyFixture = {
  orgId: string; siteId: string;
  nodes: { agent: string; desk: string; A: string; B: string; gateway: string; manualA: string | null; manualB: string | null };
  pins: { agent: { x: number; y: number }; gateway: { x: number; y: number } };
  relationships: { parallelA: string; parallelB: string; fdbOnly: string; competing: string[]; vpn: string; wireless: string; uplink: string; legacy: string };
  ports: { parallelA: string; parallelB: string };
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export function composeArgs(): string[] {
  const stackFile = process.env.E2E_STACK_FILE ?? path.join(repoRoot, '.breeze-stack.json');
  if (!existsSync(stackFile)) throw new Error(`topology-physical needs a worktree stack (${stackFile}); run \`pnpm wt-stack up\` first`);
  const { project } = JSON.parse(readFileSync(stackFile, 'utf8')) as { project: string };
  return ['compose', '-p', project, '--env-file', '.env', '--env-file', '.env.stack',
    '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml.dev', '-f', 'docker-compose.override.yml.worktree'];
}

export function seedPhysicalTopology(): PhysicalTopologyFixture {
  const out = execFileSync('docker', [...composeArgs(), 'exec', '-T', 'api', 'npx', 'tsx', 'src/__tests__/helpers/topologyPhysicalSeed.cli.ts'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 180_000 });
  const line = out.split('\n').find((l) => l.startsWith('TOPOLOGY_PHYSICAL_FIXTURE='));
  if (!line) throw new Error(`topology physical seed printed no fixture:\n${out.slice(-2000)}`);
  const fixture = JSON.parse(line.slice('TOPOLOGY_PHYSICAL_FIXTURE='.length)) as PhysicalTopologyFixture;
  for (const [key, value] of Object.entries(fixture.relationships)) {
    if (!value || (Array.isArray(value) && value.length !== 2)) throw new Error(`topology physical seed is missing relationship ${key}`);
  }
  return fixture;
}

/** Read-only probe of the saved positions (every layout) for the fixture site: `nodeId:view=x,y,pinned`. */
export function savedPositions(fixture: PhysicalTopologyFixture): string[] {
  const out = execFileSync('docker', [...composeArgs(), 'exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze', '-tA', '-c',
    `SELECT p.node_id || ':' || l.view || '=' || p.x || ',' || p.y || ',' || p.pinned || ',' || p.revision FROM topology_node_positions p
      JOIN topology_layouts l ON l.id = p.layout_id WHERE p.site_id = '${fixture.siteId}' AND p.deleted_at IS NULL ORDER BY 1`],
  { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Rows that only a mutation creates for this site: commands, discovery jobs, diagnostic runs, exclusions, layout writes. */
export function mutationRows(fixture: PhysicalTopologyFixture): string {
  return execFileSync('docker', [...composeArgs(), 'exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze', '-tA', '-c',
    `SELECT (SELECT count(*) FROM device_commands c JOIN devices d ON d.id = c.device_id WHERE d.site_id = '${fixture.siteId}') || '/' ||
      (SELECT count(*) FROM discovery_jobs WHERE site_id = '${fixture.siteId}') || '/' ||
      (SELECT count(*) FROM topology_diagnostic_runs WHERE site_id = '${fixture.siteId}') || '/' ||
      (SELECT count(*) FROM topology_view_exclusions WHERE site_id = '${fixture.siteId}') || '/' ||
      (SELECT coalesce(max(revision), 0) FROM topology_layouts WHERE site_id = '${fixture.siteId}')`],
  { cwd: repoRoot, encoding: 'utf8' }).trim();
}
