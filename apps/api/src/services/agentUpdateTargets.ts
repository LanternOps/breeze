import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { agentVersions, organizations } from '../db/schema';
import {
  normalizeAgentUpdateSettings,
  shouldSendAgentUpgrade,
  type AgentUpdateMode,
  type AgentUpdateSettings,
  type LegacyAgentUpdateSettings,
} from '../routes/agents/agentUpdatePolicy';

export type AgentUpdateComponent = 'agent' | 'watchdog';

export interface ComponentUpdateDecision {
  available: boolean;
  currentVersion: string | null;
  targetVersion: string | null;
  mode: AgentUpdateMode;
  autoInstall: boolean;
  pinned: boolean;
  action?: 'component-update' | 'legacy-agent-update';
  blockedBy?: 'legacy-agent' | 'legacy-watchdog' | 'missing-watchdog';
  missing?: boolean;
  reason?:
    | 'current'
    | 'downgrade'
    | 'dev-build'
    | 'manual'
    | 'outside-schedule'
    | 'unsupported-architecture'
    | 'no-target'
    | 'pin-unavailable'
    | 'non-release-version'
    | 'legacy-agent'
    | 'legacy-watchdog'
    | 'watchdog-required';
}

export interface DeviceUpdateMetadata {
  agentUpdate: ComponentUpdateDecision;
  watchdogUpdate: ComponentUpdateDecision;
}

export interface DeviceUpdateInput {
  id: string;
  orgId: string;
  osType: string | null;
  architecture: string | null;
  agentVersion: string | null;
  watchdogVersion: string | null;
}

const COMPONENTS: AgentUpdateComponent[] = ['agent', 'watchdog'];
// 0.83.1 shipped before the component-update plumbing in this branch merged,
// so official release agents/watchdogs at 0.83.1 and below are still legacy.
const COMPONENT_UPDATE_AGENT_MIN_VERSION = '0.83.2';
const WATCHDOG_HEALTHY_COMMAND_MIN_VERSION = '0.83.2';

function normalizeArchitecture(architecture: string | null | undefined): 'amd64' | 'arm64' | null {
  if (!architecture) return null;
  const normalized = architecture.trim().toLowerCase();
  if (normalized === 'amd64' || normalized === 'x86_64' || normalized === 'x64') return 'amd64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return null;
}

function normalizePlatform(platform: string | null | undefined): 'windows' | 'macos' | 'linux' | null {
  if (!platform) return null;
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'darwin') return 'macos';
  if (normalized === 'windows' || normalized === 'macos' || normalized === 'linux') return normalized;
  return null;
}

function parseComparableVersion(raw: string): { core: number[]; prerelease: string | null } | null {
  const trimmed = raw.trim().replace(/^v/i, '');
  if (!trimmed) return null;
  const [rawCorePart, prereleasePart] = trimmed.split('-', 2);
  if (!rawCorePart) return null;
  const core = rawCorePart.split('.').map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 10);
  });
  if (core.some((part) => !Number.isFinite(part))) return null;
  return { core, prerelease: prereleasePart ?? null };
}

export function compareAgentReleaseVersions(leftRaw: string, rightRaw: string): number {
  const left = parseComparableVersion(leftRaw);
  const right = parseComparableVersion(rightRaw);
  if (!left || !right) return 0;

  const maxLen = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < maxLen; i += 1) {
    const leftPart = left.core[i] ?? 0;
    const rightPart = right.core[i] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function isComparableReleaseVersion(raw: string | null | undefined): boolean {
  return !!raw && parseComparableVersion(raw) !== null;
}

function isAtLeastComparableVersion(raw: string, minimum: string): boolean {
  if (!isComparableReleaseVersion(raw)) return false;
  return compareAgentReleaseVersions(raw, minimum) >= 0;
}

export function isMainAgentComponentUpdateCapable(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (raw.startsWith('dev-')) return false;
  if (!isComparableReleaseVersion(raw)) return true;
  return isAtLeastComparableVersion(raw, COMPONENT_UPDATE_AGENT_MIN_VERSION);
}

export function isWatchdogHealthyCommandCapable(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (raw.startsWith('dev-')) return false;
  if (!isComparableReleaseVersion(raw)) return true;
  return isAtLeastComparableVersion(raw, WATCHDOG_HEALTHY_COMMAND_MIN_VERSION);
}

function emptyDecision(
  settings: AgentUpdateSettings,
  currentVersion: string | null,
  pinned: boolean,
  reason: ComponentUpdateDecision['reason'],
  missing = false,
): ComponentUpdateDecision {
  return {
    available: false,
    currentVersion,
    targetVersion: null,
    mode: settings.mode,
    autoInstall: false,
    pinned,
    ...(missing ? { missing: true } : {}),
    reason,
  };
}

function coerceAgentUpdateSettings(settings: AgentUpdateSettings | LegacyAgentUpdateSettings): AgentUpdateSettings {
  if ('policy' in settings) {
    return normalizeAgentUpdateSettings({
      agentUpdatePolicy: settings.policy,
      maintenanceWindow: settings.maintenanceWindow,
    });
  }
  return {
    ...settings,
    pins: settings.pins ?? {},
  };
}

export async function getOrgAgentUpdateSettings(orgId: string): Promise<AgentUpdateSettings> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const settings = org?.settings && typeof org.settings === 'object' && !Array.isArray(org.settings)
    ? org.settings as Record<string, unknown>
    : {};
  return normalizeAgentUpdateSettings(settings.defaults);
}

export async function validateAgentVersionPinsAvailable(defaultsRaw: unknown): Promise<string | null> {
  const settings = normalizeAgentUpdateSettings(defaultsRaw);
  for (const component of COMPONENTS) {
    const pin = settings.pins[component];
    if (!pin) continue;
    const [row] = await db
      .select({ id: agentVersions.id })
      .from(agentVersions)
      .where(and(eq(agentVersions.component, component), eq(agentVersions.version, pin)))
      .limit(1);
    if (!row) {
      return `${component} version pin ${pin} is not registered in agent_versions`;
    }
  }
  return null;
}

async function findVersionTarget(args: {
  platform: string;
  architecture: 'amd64' | 'arm64';
  component: AgentUpdateComponent;
  version?: string;
}): Promise<string | null> {
  const conditions = [
    eq(agentVersions.platform, args.platform),
    eq(agentVersions.architecture, args.architecture),
    eq(agentVersions.component, args.component),
  ];
  if (args.version) {
    conditions.push(eq(agentVersions.version, args.version));
  } else {
    conditions.push(eq(agentVersions.isLatest, true));
  }

  const [row] = await db
    .select({ version: agentVersions.version })
    .from(agentVersions)
    .where(and(...conditions))
    .orderBy(desc(agentVersions.createdAt))
    .limit(1);
  return row?.version ?? null;
}

export async function resolveComponentUpdateDecision(args: {
  device: DeviceUpdateInput;
  component: AgentUpdateComponent;
  settings: AgentUpdateSettings | LegacyAgentUpdateSettings;
  now?: Date;
  requestedVersion?: string;
}): Promise<ComponentUpdateDecision> {
  const settings = coerceAgentUpdateSettings(args.settings);
  const platform = normalizePlatform(args.device.osType);
  const architecture = normalizeArchitecture(args.device.architecture);
  const currentVersion = args.component === 'agent' ? args.device.agentVersion : args.device.watchdogVersion;
  const missing = args.component === 'watchdog' && !currentVersion;
  const pin = settings.pins[args.component];
  const pinned = !args.requestedVersion && typeof pin === 'string' && pin.length > 0;

  if (!platform || !architecture) {
    return emptyDecision(settings, currentVersion, pinned, 'unsupported-architecture', missing);
  }

  const targetVersion = await findVersionTarget({
    platform,
    architecture,
    component: args.component,
    version: args.requestedVersion ?? pin,
  });
  if (!targetVersion) {
    return emptyDecision(settings, currentVersion, pinned, pinned ? 'pin-unavailable' : 'no-target', missing);
  }

  if (args.component === 'watchdog' && !isMainAgentComponentUpdateCapable(args.device.agentVersion)) {
    return {
      available: true,
      currentVersion,
      targetVersion,
      mode: settings.mode,
      autoInstall: false,
      pinned,
      blockedBy: 'legacy-agent',
      ...(missing ? { missing: true } : {}),
      reason: 'legacy-agent',
    };
  }

  if (currentVersion && !isComparableReleaseVersion(currentVersion)) {
    return {
      available: true,
      currentVersion,
      targetVersion,
      mode: settings.mode,
      autoInstall: false,
      pinned,
      action: 'component-update',
      reason: 'non-release-version',
    };
  }

  if (currentVersion?.startsWith('dev-')) {
    return {
      ...emptyDecision(settings, currentVersion, pinned, 'dev-build', missing),
      targetVersion,
    };
  }

  if (currentVersion) {
    const cmp = compareAgentReleaseVersions(targetVersion, currentVersion);
    if (cmp < 0) {
      return {
        ...emptyDecision(settings, currentVersion, pinned, 'downgrade', missing),
        targetVersion,
      };
    }
    if (cmp === 0) {
      return {
        ...emptyDecision(settings, currentVersion, pinned, 'current', missing),
        targetVersion,
      };
    }
  }

  const gate = shouldSendAgentUpgrade(settings, args.now ?? new Date());
  if (args.component === 'agent' && !isMainAgentComponentUpdateCapable(currentVersion)) {
    return {
      available: true,
      currentVersion,
      targetVersion,
      mode: settings.mode,
      autoInstall: gate.allow,
      pinned,
      action: 'legacy-agent-update',
      reason: 'legacy-agent',
    };
  }
  if (args.component === 'agent' && !args.device.watchdogVersion) {
    return {
      available: true,
      currentVersion,
      targetVersion,
      mode: settings.mode,
      autoInstall: false,
      pinned,
      blockedBy: 'missing-watchdog',
      reason: 'watchdog-required',
    };
  }
  if (args.component === 'agent' && !isWatchdogHealthyCommandCapable(args.device.watchdogVersion)) {
    return {
      available: true,
      currentVersion,
      targetVersion,
      mode: settings.mode,
      autoInstall: false,
      pinned,
      blockedBy: 'legacy-watchdog',
      reason: 'legacy-watchdog',
    };
  }
  return {
    available: true,
    currentVersion,
    targetVersion,
    mode: settings.mode,
    autoInstall: gate.allow,
    pinned,
    action: 'component-update',
    ...(missing ? { missing: true } : {}),
    ...(gate.allow ? {} : { reason: gate.reason === 'manual-approval' ? 'manual' : 'outside-schedule' }),
  };
}

export async function buildDeviceUpdateMetadata(
  devices: DeviceUpdateInput[],
  now: Date = new Date(),
): Promise<Map<string, DeviceUpdateMetadata>> {
  const result = new Map<string, DeviceUpdateMetadata>();
  if (devices.length === 0) return result;

  const orgIds = [...new Set(devices.map((device) => device.orgId))];
  const orgRows = await db
    .select({ id: organizations.id, settings: organizations.settings })
    .from(organizations)
    .where(inArray(organizations.id, orgIds));

  const settingsByOrg = new Map<string, AgentUpdateSettings>();
  for (const org of orgRows) {
    const settings = org.settings && typeof org.settings === 'object' && !Array.isArray(org.settings)
      ? org.settings as Record<string, unknown>
      : {};
    settingsByOrg.set(org.id, normalizeAgentUpdateSettings(settings.defaults));
  }

  for (const device of devices) {
    const settings = settingsByOrg.get(device.orgId) ?? normalizeAgentUpdateSettings({});
    const [agentUpdate, watchdogUpdate] = await Promise.all([
      resolveComponentUpdateDecision({
        device,
        component: 'agent',
        settings,
        now,
      }),
      resolveComponentUpdateDecision({
        device,
        component: 'watchdog',
        settings,
        now,
      }),
    ]);
    result.set(device.id, { agentUpdate, watchdogUpdate });
  }

  return result;
}

export async function resolveManualComponentTarget(args: {
  device: DeviceUpdateInput;
  component: AgentUpdateComponent;
  version?: string;
}): Promise<
  | { ok: true; targetVersion: string; decision: ComponentUpdateDecision }
  | { ok: false; status: number; code: string; message: string; decision?: ComponentUpdateDecision }
> {
  const settings = await getOrgAgentUpdateSettings(args.device.orgId);
  const requestedVersion = args.version?.trim() || undefined;
  const decision = await resolveComponentUpdateDecision({
    device: args.device,
    component: args.component,
    settings,
    requestedVersion,
  });

  if (!decision.targetVersion) {
    return {
      ok: false,
      status: decision.reason === 'unsupported-architecture' ? 400 : 409,
      code: decision.reason ?? 'NO_TARGET',
      message: decision.reason === 'pin-unavailable'
        ? `Pinned ${args.component} version is not available for this device platform.`
        : `No ${args.component} update target is available for this device platform.`,
      decision,
    };
  }
  if (decision.reason === 'dev-build') {
    return {
      ok: false,
      status: 409,
      code: 'DEV_BUILD',
      message: `Refusing to replace dev ${args.component} builds through component update.`,
      decision,
    };
  }
  if (decision.reason === 'downgrade') {
    return {
      ok: false,
      status: 409,
      code: 'DOWNGRADE',
      message: `Refusing to downgrade ${args.component} from ${decision.currentVersion} to ${decision.targetVersion}.`,
      decision,
    };
  }
  if (decision.action === 'legacy-agent-update') {
    return {
      ok: false,
      status: 409,
      code: 'LEGACY_AGENT_UPDATE_REQUIRED',
      message: 'Legacy agents must be upgraded through the legacy agent update path first.',
      decision,
    };
  }
  if (decision.blockedBy) {
    return {
      ok: false,
      status: 409,
      code: decision.blockedBy === 'legacy-agent'
        ? 'LEGACY_AGENT_REQUIRED'
        : decision.blockedBy === 'legacy-watchdog'
          ? 'LEGACY_WATCHDOG_REQUIRED'
          : 'WATCHDOG_REQUIRED',
      message: decision.blockedBy === 'legacy-agent'
        ? 'Update the main agent before updating or repairing the watchdog.'
        : decision.blockedBy === 'legacy-watchdog'
          ? 'Update the watchdog before updating the main agent.'
          : 'Watchdog is required to update the main agent. Repair watchdog first.',
      decision,
    };
  }
  if (!decision.available) {
    return {
      ok: false,
      status: 409,
      code: 'ALREADY_CURRENT',
      message: `${args.component} is already on ${decision.targetVersion}.`,
      decision,
    };
  }
  return { ok: true, targetVersion: decision.targetVersion, decision };
}

export async function resolveLegacyAgentUpdateTarget(args: {
  device: DeviceUpdateInput;
  version?: string;
}): Promise<
  | { ok: true; targetVersion: string; decision: ComponentUpdateDecision }
  | { ok: false; status: number; code: string; message: string; decision?: ComponentUpdateDecision }
> {
  const settings = await getOrgAgentUpdateSettings(args.device.orgId);
  const requestedVersion = args.version?.trim() || undefined;
  const decision = await resolveComponentUpdateDecision({
    device: args.device,
    component: 'agent',
    settings,
    requestedVersion,
  });

  if (!decision.targetVersion) {
    return {
      ok: false,
      status: decision.reason === 'unsupported-architecture' ? 400 : 409,
      code: decision.reason ?? 'NO_TARGET',
      message: 'No legacy agent update target is available for this device platform.',
      decision,
    };
  }
  if (decision.action !== 'legacy-agent-update') {
    return {
      ok: false,
      status: 409,
      code: decision.reason === 'current' ? 'ALREADY_CURRENT' : 'NOT_LEGACY_AGENT',
      message: decision.reason === 'current'
        ? `Agent is already on ${decision.targetVersion}.`
        : 'This agent already supports component updates.',
      decision,
    };
  }
  return { ok: true, targetVersion: decision.targetVersion, decision };
}
