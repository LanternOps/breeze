// Pure (no I/O) helpers for the recover-stuck-agents script. Split out so
// the unit test can import them without triggering the script's top-level
// main() — which opens the DB pool and exits the process.
//
// Behavioural orchestration (DB queries, command insert, exit codes) lives
// in recover-stuck-agents.ts.
import { normalizeAgentArchitecture } from '../src/routes/agents/helpers';

// Versions whose agents cannot reach the latest server via auto-update and
// need a one-time dev_update push to recover. Two failure modes are pooled
// here because the recovery flow is the same:
//
//   0.65.5 / 0.65.6: shipped with the wrong embedded manifest trust root
//   (#568), so manifest signature verification always fails. v0.65.7 fixed
//   the trust root.
//
//   0.65.7 / 0.65.8: predate the per-deployment manifest pinning shipped in
//   v0.65.9 (#625). On self-host BINARY_SOURCE=local servers, locally-signed
//   manifests are rejected because these agents only trust the LanternOps
//   build-time key. v0.65.9 agents pin the per-deployment pubkey via
//   heartbeat/enrollment and recover from there.
//
// Exact-match only — agent versions are bare semver per project convention
// (no `v` prefix, no pre-release suffixes in releases). The regression test
// in agent/internal/updater/updater_test.go prevents new releases from
// joining the trust-root group; the heartbeat-pinning machinery in
// agent/internal/heartbeat/heartbeat.go prevents new releases from joining
// the per-deployment-pin group.
export const BROKEN_AGENT_VERSIONS = ['0.65.5', '0.65.6', '0.65.7', '0.65.8'] as const;

export const RECOVERY_COMMAND_MARKER = 'agent_update_trust_root_recovery';

export type DeviceRow = {
  id: string;
  hostname: string | null;
  agentVersion: string | null;
  osType: string | null;
  architecture: string | null;
  status: string;
};

export type AgentVersionRow = {
  version: string;
  platform: string;
  architecture: string;
  downloadUrl: string;
  checksum: string;
};

export type Plan = {
  device: DeviceRow;
  binary: AgentVersionRow;
};

export type Skip = {
  device: DeviceRow;
  reason: string;
};

export function planRecovery(devs: DeviceRow[], binaries: AgentVersionRow[]): {
  plans: Plan[];
  skipped: Skip[];
} {
  const byPlatformArch = new Map<string, AgentVersionRow>();
  for (const b of binaries) {
    byPlatformArch.set(`${b.platform}/${b.architecture}`, b);
  }

  const plans: Plan[] = [];
  const skipped: Skip[] = [];

  for (const d of devs) {
    if (!d.osType) {
      skipped.push({ device: d, reason: 'os_type is null' });
      continue;
    }
    const arch = normalizeAgentArchitecture(d.architecture);
    if (!arch) {
      skipped.push({ device: d, reason: `unrecognised architecture: ${d.architecture}` });
      continue;
    }
    const binary = byPlatformArch.get(`${d.osType}/${arch}`);
    if (!binary) {
      skipped.push({
        device: d,
        reason: `no isLatest=true agent binary registered for ${d.osType}/${arch}`,
      });
      continue;
    }
    if (BROKEN_AGENT_VERSIONS.includes(binary.version as typeof BROKEN_AGENT_VERSIONS[number])) {
      skipped.push({
        device: d,
        reason: `latest binary is still ${binary.version} (broken). Bump BREEZE_VERSION on this server first.`,
      });
      continue;
    }
    plans.push({ device: d, binary });
  }

  return { plans, skipped };
}
