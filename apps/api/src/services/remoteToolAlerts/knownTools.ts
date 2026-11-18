/**
 * Which RMM / remote access tools a management-posture scan added (#11306).
 * Pure: no database, so the posture route can call it on every scan.
 * The alerting side is alerts.ts.
 */

export type RemoteToolCategory = 'remoteAccess' | 'rmm';

/**
 * Every RMM and remote access signature name the agent reports
 * (agent/internal/mgmtdetect/signatures.go), by category. Only these names can
 * create an alert rule, so an agent cannot fill an org's rule list with
 * made-up names. knownTools.signatures.test.ts fails when this list and the
 * agent's signatures disagree.
 */
export const KNOWN_REMOTE_TOOLS: Readonly<Record<string, RemoteToolCategory>> = {
  // CategoryRMM
  'ConnectWise Automate': 'rmm',
  ScreenConnect: 'rmm',
  'Datto RMM': 'rmm',
  NinjaOne: 'rmm',
  Atera: 'rmm',
  SyncroMSP: 'rmm',
  'N-able': 'rmm',
  'Kaseya VSA': 'rmm',
  Pulseway: 'rmm',
  Level: 'rmm',
  'Tactical RMM': 'rmm',
  OpenFrame: 'rmm',
  // CategoryRemoteAccess
  TeamViewer: 'remoteAccess',
  AnyDesk: 'remoteAccess',
  Splashtop: 'remoteAccess',
  LogMeIn: 'remoteAccess',
  BeyondTrust: 'remoteAccess',
  'GoTo Resolve': 'remoteAccess',
  RustDesk: 'remoteAccess',
  SimpleHelp: 'remoteAccess',
  MeshCentral: 'remoteAccess',
  TightVNC: 'remoteAccess',
  RealVNC: 'remoteAccess',
  UltraVNC: 'remoteAccess',
  UltraViewer: 'remoteAccess',
  'Zoho Assist': 'remoteAccess',
  DWService: 'remoteAccess',
  Supremo: 'remoteAccess',
  'Ammyy Admin': 'remoteAccess',
  'Chrome Remote Desktop': 'remoteAccess',
};

export type AppearedRemoteTool = {
  name: string;
  category: RemoteToolCategory;
  /** The agent's detection status on the scan that found it. */
  status: string | null;
};

type PostureDetection = { name?: unknown; status?: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Known RMM / remote access tool names in a posture, with each one's status. */
function knownRemoteTools(posture: Record<string, unknown>): Map<string, string | null> {
  const found = new Map<string, string | null>();
  const categories = asRecord(posture.categories);
  if (!categories) return found;
  for (const key of ['remoteAccess', 'rmm'] as const) {
    const detections = categories[key];
    if (!Array.isArray(detections)) continue;
    for (const raw of detections as PostureDetection[]) {
      const name = typeof raw?.name === 'string' ? raw.name : null;
      if (!name || !Object.hasOwn(KNOWN_REMOTE_TOOLS, name) || found.has(name)) continue;
      found.set(name, typeof raw.status === 'string' ? raw.status : null);
    }
  }
  return found;
}

/**
 * The agent's scan error when it could not list processes
 * (agent/internal/mgmtdetect/runner.go). The scan then carries on with an empty
 * process list, so a tool seen only by a running process is missing from it.
 */
const PROCESS_SNAPSHOT_ERROR_PREFIX = 'process snapshot:';

/** True when a scan's own errors say its tool list may be missing tools. */
function scanMayHaveMissedTools(posture: Record<string, unknown>): boolean {
  const errors = posture.errors;
  return Array.isArray(errors)
    && errors.some((error) => typeof error === 'string' && error.startsWith(PROCESS_SNAPSHOT_ERROR_PREFIX));
}

/**
 * Known RMM / remote access tools in `after` that `before` did not have, in a
 * stable order. Empty when there is no usable previous posture to compare with:
 * - none stored yet: the device's first scan seeds the baseline, so the
 *   partner's own tools on a newly enrolled device raise nothing;
 * - the previous scan could not list processes: its tool list may be missing
 *   tools that are still there, and they would look new now.
 * A tool is matched by name across both categories, so a signature moving
 * between them is not a new tool; the category (and so the severity) comes from
 * KNOWN_REMOTE_TOOLS, not the agent.
 */
export function appearedRemoteTools(before: unknown, after: unknown): AppearedRemoteTool[] {
  const previous = asRecord(before);
  const next = asRecord(after);
  if (!previous || !asRecord(previous.categories) || !next) return [];
  if (scanMayHaveMissedTools(previous)) return [];

  const had = knownRemoteTools(previous);
  const appeared: AppearedRemoteTool[] = [];
  for (const [name, status] of knownRemoteTools(next)) {
    if (had.has(name)) continue;
    appeared.push({ name, category: KNOWN_REMOTE_TOOLS[name]!, status });
  }
  return appeared.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}
