import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeArgs } from './topologyPhysicalSeed';

/**
 * M3 operations fixture on the REAL worktree stack: the M2 physical fixture
 * plus seeded SNMP interface samples on one port and a site monitoring policy
 * with activation intent (apps/api/src/__tests__/helpers/topologyOperationsSeed.cli.ts).
 * Nothing is armed and no command is queued by the seed.
 */
export type TopologyOperationsFixture = {
  orgId: string; siteId: string;
  nodes: { agent: string; A: string; B: string; sourceNode: string };
  link: string; port: { id: string; name: string | null; epoch: string };
  telemetrySourceId: string; policyId: string; collectorDeviceId: string; credentialProfileId: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export function seedOperationsTopology(): TopologyOperationsFixture {
  const out = execFileSync('docker', [...composeArgs(), 'exec', '-T', 'api', 'npx', 'tsx', 'src/__tests__/helpers/topologyOperationsSeed.cli.ts'],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 180_000 });
  const line = out.split('\n').find((l) => l.startsWith('TOPOLOGY_OPERATIONS_FIXTURE='));
  if (!line) throw new Error(`topology operations seed printed no fixture:\n${out.slice(-2000)}`);
  return JSON.parse(line.slice('TOPOLOGY_OPERATIONS_FIXTURE='.length)) as TopologyOperationsFixture;
}

function psql(query: string): string {
  return execFileSync('docker', [...composeArgs(), 'exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze', '-tA', '-c', query],
    { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** Rows only a mutation creates for the site: commands, diagnostic runs, telemetry arms, armed policies, samples, discovery jobs. */
export function operationsMutationRows(f: TopologyOperationsFixture): string {
  return psql(`SELECT (SELECT count(*) FROM device_commands c JOIN devices d ON d.id = c.device_id WHERE d.site_id = '${f.siteId}') || '/' ||
    (SELECT count(*) FROM topology_diagnostic_runs WHERE site_id = '${f.siteId}') || '/' ||
    (SELECT count(*) FROM topology_telemetry_arms WHERE site_id = '${f.siteId}') || '/' ||
    (SELECT count(*) FROM topology_monitoring_policies WHERE site_id = '${f.siteId}' AND enabled) || '/' ||
    (SELECT count(*) FROM topology_interface_samples WHERE site_id = '${f.siteId}') || '/' ||
    (SELECT count(*) FROM discovery_jobs WHERE site_id = '${f.siteId}')`);
}

/** The stored state of the fixture's telemetry arms, `state:blocked_reason` newest first. */
export function telemetryArmStates(f: TopologyOperationsFixture): string[] {
  return psql(`SELECT state || ':' || coalesce(blocked_reason, '') FROM topology_telemetry_arms WHERE site_id = '${f.siteId}' ORDER BY created_at DESC`)
    .split('\n').map((l) => l.trim()).filter(Boolean);
}

export function policyState(f: TopologyOperationsFixture): string {
  return psql(`SELECT enabled || ':' || coalesce(blocked_reason, '') FROM topology_monitoring_policies WHERE id = '${f.policyId}'`);
}
