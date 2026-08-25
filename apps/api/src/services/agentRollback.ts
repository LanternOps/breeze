import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { compare, lt, prerelease, valid } from 'semver';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { agentRollbackDirectives, agentRollbackEvents, agentVersions, devices } from '../db/schema';
import { validateReleaseManifest } from '../routes/agentVersions';
import { getBinaryEdition } from './binaryEdition';
import { CommandTypes, insertQueuedCommandInTransaction } from './commandQueue';
import { consumeStepUpGrant, rollbackResourceDigest, validateStepUpGrant } from './mfaStepUpGrant';
import {
  signAgentRollbackDirective,
  type AgentRollbackDirectiveV1,
  type RollbackArtifactV1,
  type RollbackComponent,
} from './rollbackDirectiveSigning';

export interface RegisteredRollbackArtifact {
  id: string;
  version: string;
  platform: string;
  architecture: string;
  edition: string;
  component: string;
  downloadUrl: string;
  checksum: string;
  fileSize: bigint | null;
  releaseManifest: string | null;
  manifestSignature: string | null;
  signingKeyId: string | null;
}

export type VerifiedRegisteredRelease = RegisteredRollbackArtifact & {
  releaseManifest: string;
  manifestSignature: string;
  signingKeyId: string;
  fileSize: bigint;
};

export class AgentRollbackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRollbackValidationError';
  }
}

function normalizedStableVersion(version: string): string | null {
  const normalized = valid(version);
  return normalized && prerelease(normalized) === null ? normalized : null;
}

export function selectImmediateStableRollbackTarget(input: {
  currentVersion: string;
  platform: string;
  architecture: string;
  edition: string;
  releases: readonly RegisteredRollbackArtifact[];
}): RegisteredRollbackArtifact {
  const current = normalizedStableVersion(input.currentVersion);
  if (!current) throw new AgentRollbackValidationError('current agent version is not stable semver');
  const currentMatches = input.releases.filter((row) => row.component === 'agent'
    && row.platform === input.platform
    && row.architecture === input.architecture
    && row.edition === input.edition
    && valid(row.version) === current);
  if (currentMatches.length > 1) {
    throw new AgentRollbackValidationError(`current agent release ${current} is ambiguous`);
  }
  const candidates = input.releases.filter((row) => {
    const candidate = normalizedStableVersion(row.version);
    return row.component === 'agent'
      && row.platform === input.platform
      && row.architecture === input.architecture
      && row.edition === input.edition
      && candidate !== null
      && lt(candidate, current);
  }).sort((left, right) => compare(valid(right.version)!, valid(left.version)!));
  if (candidates.length === 0) {
    throw new AgentRollbackValidationError('no exact stable rollback target is registered');
  }
  const selectedVersion = valid(candidates[0]!.version)!;
  const duplicates = candidates.filter((row) => valid(row.version) === selectedVersion);
  if (duplicates.length !== 1) {
    throw new AgentRollbackValidationError(`ambiguous rollback target registration for ${selectedVersion}`);
  }
  return candidates[0]!;
}

const COMPONENT_ORDER: readonly RollbackComponent[] = ['agent', 'helper', 'user-helper', 'watchdog', 'backup'];

function requireSignedArtifact(row: RegisteredRollbackArtifact, component: RollbackComponent): VerifiedRegisteredRelease {
  const safeSize = row.fileSize == null ? null : Number(row.fileSize);
  if (!row.releaseManifest || !row.manifestSignature || !row.signingKeyId
      || !Number.isSafeInteger(safeSize) || safeSize === null || safeSize <= 0
      || !/^[a-fA-F0-9]{64}$/.test(row.checksum)) {
    throw new AgentRollbackValidationError(`missing exact signed target artifact for ${component}`);
  }
  return row as VerifiedRegisteredRelease;
}

export function buildRollbackArtifacts(input: {
  targetVersion: string;
  currentVersions: Partial<Record<RollbackComponent, string>> & { agent: string };
  releases: readonly RegisteredRollbackArtifact[];
}): {
  artifacts: RollbackArtifactV1[];
  componentVersions: Record<string, { current: string; target: string }>;
  releaseManifest: string;
  manifestSignature: string;
  manifestSigningKeyId: string;
} {
  const artifacts: RollbackArtifactV1[] = [];
  const componentVersions: Record<string, { current: string; target: string }> = {};
  let manifestIdentity: string | null = null;
  let manifest: Pick<VerifiedRegisteredRelease, 'releaseManifest' | 'manifestSignature' | 'signingKeyId'> | null = null;

  for (const component of COMPONENT_ORDER) {
    const currentVersion = input.currentVersions[component];
    if (!currentVersion) continue;
    const matches = input.releases.filter((row) => row.component === component && row.version === input.targetVersion);
    if (matches.length !== 1) {
      throw new AgentRollbackValidationError(
        matches.length === 0
          ? `missing exact signed target artifact for ${component}`
          : `ambiguous exact signed target artifact for ${component}`,
      );
    }
    const row = requireSignedArtifact(matches[0]!, component);
    const identity = `${row.releaseManifest}\u0000${row.manifestSignature}\u0000${row.signingKeyId}`;
    if (manifestIdentity !== null && manifestIdentity !== identity) {
      throw new AgentRollbackValidationError('rollback component artifacts do not share one signed release manifest');
    }
    manifestIdentity = identity;
    manifest = row;
    componentVersions[component] = { current: currentVersion, target: input.targetVersion };
    artifacts.push({
      component,
      currentVersion,
      targetVersion: input.targetVersion,
      downloadUrl: row.downloadUrl,
      sha256: row.checksum.toLowerCase(),
      size: Number(row.fileSize),
    });
  }
  if (!manifest) throw new AgentRollbackValidationError('rollback requires an agent artifact');
  return {
    artifacts,
    componentVersions,
    releaseManifest: manifest.releaseManifest,
    manifestSignature: manifest.manifestSignature,
    manifestSigningKeyId: manifest.signingKeyId,
  };
}

async function loadReleaseRows(input: {
  platform: string;
  architecture: string;
  edition: string;
}): Promise<RegisteredRollbackArtifact[]> {
  return db.select({
    id: agentVersions.id,
    version: agentVersions.version,
    platform: agentVersions.platform,
    architecture: agentVersions.architecture,
    edition: agentVersions.edition,
    component: agentVersions.component,
    downloadUrl: agentVersions.downloadUrl,
    checksum: agentVersions.checksum,
    fileSize: agentVersions.fileSize,
    releaseManifest: agentVersions.releaseManifest,
    manifestSignature: agentVersions.manifestSignature,
    signingKeyId: agentVersions.signingKeyId,
  }).from(agentVersions).where(and(
    eq(agentVersions.platform, input.platform),
    eq(agentVersions.architecture, input.architecture),
    eq(agentVersions.edition, input.edition),
  ));
}

async function releaseIsVerified(row: RegisteredRollbackArtifact): Promise<boolean> {
  const result = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    validateReleaseManifest({
      manifest: row.releaseManifest,
      signature: row.manifestSignature,
      version: row.version,
      platform: row.platform,
      arch: row.architecture,
      component: row.component,
      downloadUrl: row.downloadUrl,
      checksum: row.checksum,
      fileSize: row.fileSize,
      signingKeyId: row.signingKeyId,
    })));
  return result.ok;
}

export async function resolveImmediateStableRollbackTarget(input: {
  currentVersion: string;
  platform: 'windows' | 'macos' | 'linux';
  architecture: 'amd64' | 'arm64';
  edition: string;
}): Promise<VerifiedRegisteredRelease> {
  const rows = await loadReleaseRows(input);
  const current = normalizedStableVersion(input.currentVersion);
  if (!current) throw new AgentRollbackValidationError('current agent version is not stable semver');
  const currentRows = rows.filter((row) => row.component === 'agent' && valid(row.version) === current);
  if (currentRows.length !== 1) {
    throw new AgentRollbackValidationError(
      currentRows.length === 0 ? 'current agent release is not registered' : 'current agent release is ambiguous',
    );
  }
  if (!(await releaseIsVerified(currentRows[0]!))) {
    throw new AgentRollbackValidationError('current agent release is not signed and verified');
  }

  const remaining = [...rows];
  while (remaining.length > 0) {
    const candidate = selectImmediateStableRollbackTarget({ ...input, releases: remaining });
    const normalized = valid(candidate.version)!;
    const duplicateCount = remaining.filter((row) => row.component === 'agent' && valid(row.version) === normalized).length;
    if (duplicateCount !== 1) throw new AgentRollbackValidationError(`ambiguous rollback target registration for ${normalized}`);
    if (await releaseIsVerified(candidate)) return requireSignedArtifact(candidate, 'agent');
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (valid(remaining[index]!.version) === normalized) remaining.splice(index, 1);
    }
  }
  throw new AgentRollbackValidationError('no signed and verified stable rollback target is registered');
}

export interface CreateAgentRollbackInput {
  deviceId: string;
  targetVersion: string;
  reason: string;
  authorizedBy: string;
  stepUpGrantId: string;
  authEpoch: number;
  mfaEpoch: number;
  sid: string;
  now?: Date;
}

interface RollbackDeviceSnapshot {
  id: string;
  orgId: string;
  osType: string;
  architecture: string | null;
  agentVersion: string;
  agentEdition: string | null;
  rollbackProtocolVersion: number;
  watchdogVersion: string | null;
  backupVersion: string | null;
  rollbackComponentVersions: Record<string, string> | null;
}

function asProtocolPlatform(value: string): AgentRollbackDirectiveV1['platform'] {
  if (value === 'windows' || value === 'macos' || value === 'linux') return value;
  throw new AgentRollbackValidationError(`unsupported rollback platform ${value}`);
}

function asProtocolArchitecture(value: string | null): AgentRollbackDirectiveV1['architecture'] {
  if (value === 'amd64' || value === 'arm64') return value;
  throw new AgentRollbackValidationError(`unsupported rollback architecture ${value ?? 'missing'}`);
}

function wireTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}

async function loadDeviceSnapshot(deviceId: string): Promise<RollbackDeviceSnapshot> {
  const [row] = await db.select({
    id: devices.id,
    orgId: devices.orgId,
    osType: devices.osType,
    architecture: devices.architecture,
    agentVersion: devices.agentVersion,
    agentEdition: devices.agentEdition,
    rollbackProtocolVersion: devices.rollbackProtocolVersion,
    watchdogVersion: devices.watchdogVersion,
    backupVersion: devices.backupVersion,
    rollbackComponentVersions: devices.rollbackComponentVersions,
  }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!row) throw new AgentRollbackValidationError('device not found in authorized scope');
  return row;
}

function snapshotMatches(left: RollbackDeviceSnapshot, right: RollbackDeviceSnapshot): boolean {
  return left.id === right.id && left.orgId === right.orgId && left.osType === right.osType
    && left.architecture === right.architecture && left.agentVersion === right.agentVersion
    && left.agentEdition === right.agentEdition
    && left.rollbackProtocolVersion === right.rollbackProtocolVersion
    && left.watchdogVersion === right.watchdogVersion && left.backupVersion === right.backupVersion
    && componentInventoryKey(left.rollbackComponentVersions) === componentInventoryKey(right.rollbackComponentVersions);
}

function componentInventoryKey(inventory: Record<string, string> | null): string {
  return JSON.stringify(Object.entries(inventory ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function validatedRollbackComponentVersions(snapshot: RollbackDeviceSnapshot):
Partial<Record<RollbackComponent, string>> & { agent: string } {
  const inventory = snapshot.rollbackComponentVersions;
  if (!inventory || inventory.agent !== snapshot.agentVersion) {
    throw new AgentRollbackValidationError('complete installed rollback component inventory is unavailable');
  }
  const allowed = new Set<RollbackComponent>(COMPONENT_ORDER);
  for (const [component, version] of Object.entries(inventory)) {
    if (!allowed.has(component as RollbackComponent) || !normalizedStableVersion(version)) {
      throw new AgentRollbackValidationError(`installed rollback component ${component} is not trustworthy`);
    }
    if (component === 'user-helper' && snapshot.osType !== 'windows') {
      throw new AgentRollbackValidationError('user-helper is not a valid installed component on this platform');
    }
  }
  return inventory as Partial<Record<RollbackComponent, string>> & { agent: string };
}

export async function createAgentRollbackDirective(
  input: CreateAgentRollbackInput,
): Promise<AgentRollbackDirectiveV1> {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 1000) {
    throw new AgentRollbackValidationError('rollback reason must be 1-1000 characters');
  }
  const snapshot = await loadDeviceSnapshot(input.deviceId);
  if (snapshot.rollbackProtocolVersion !== 1) {
    throw new AgentRollbackValidationError('device has not declared rollback protocol v1');
  }
  const platform = asProtocolPlatform(snapshot.osType);
  const architecture = asProtocolArchitecture(snapshot.architecture);
  const edition = getBinaryEdition();
  if (snapshot.agentEdition !== edition) {
    throw new AgentRollbackValidationError('live agent edition does not match this server');
  }
  const target = await resolveImmediateStableRollbackTarget({
    currentVersion: snapshot.agentVersion,
    platform,
    architecture,
    edition,
  });
  if (target.version !== input.targetVersion) {
    throw new AgentRollbackValidationError('requested version is not the immediate stable rollback target');
  }
  const releaseRows = (await loadReleaseRows({ platform, architecture, edition }))
    .filter((row) => valid(row.version) === valid(target.version));
  const currentVersions = validatedRollbackComponentVersions(snapshot);
  const releaseSet = buildRollbackArtifacts({
    targetVersion: target.version,
    currentVersions,
    releases: releaseRows,
  });
  for (const artifact of releaseSet.artifacts) {
    const row = releaseRows.find((candidate) => candidate.component === artifact.component);
    if (!row || !(await releaseIsVerified(row))) {
      throw new AgentRollbackValidationError(`target artifact for ${artifact.component} is not signed and verified`);
    }
  }

  const digest = rollbackResourceDigest({
    deviceId: snapshot.id,
    currentVersion: snapshot.agentVersion,
    targetVersion: target.version,
    reason,
  });
  const grantBinding = {
    userId: input.authorizedBy,
    operation: 'agent_rollback' as const,
    authEpoch: input.authEpoch,
    mfaEpoch: input.mfaEpoch,
    sid: input.sid,
    resourceDigest: digest,
  };
  if (!(await validateStepUpGrant(input.stepUpGrantId, grantBinding))) {
    throw new AgentRollbackValidationError('step-up grant is missing, stale, or bound to different rollback inputs');
  }

  const rollbackId = randomUUID();
  const commandId = randomUUID();
  const approvedAt = new Date(Math.floor((input.now ?? new Date()).getTime() / 1000) * 1000);
  const expiresAt = new Date(approvedAt.getTime() + 5 * 60 * 1000);
  const directive = await runOutsideDbContext(() => signAgentRollbackDirective({
    schemaVersion: 1,
    rollbackId,
    deviceId: snapshot.id,
    orgId: snapshot.orgId,
    platform,
    architecture,
    currentVersion: snapshot.agentVersion,
    targetVersion: target.version,
    componentVersions: releaseSet.componentVersions,
    releaseManifest: releaseSet.releaseManifest,
    manifestSignature: releaseSet.manifestSignature,
    manifestSigningKeyId: releaseSet.manifestSigningKeyId,
    artifacts: releaseSet.artifacts,
    reason,
    authorizedBy: input.authorizedBy,
    approvedAt: wireTimestamp(approvedAt),
    expiresAt: wireTimestamp(expiresAt),
  }));

  return db.transaction(async (tx) => {
    const lockedRows = await tx.execute(sql`
      SELECT id, org_id AS "orgId", os_type AS "osType", architecture,
             agent_version AS "agentVersion", agent_edition AS "agentEdition",
             rollback_protocol_version AS "rollbackProtocolVersion",
             watchdog_version AS "watchdogVersion", backup_version AS "backupVersion",
             rollback_component_versions AS "rollbackComponentVersions"
      FROM devices WHERE id = ${snapshot.id} FOR UPDATE
    `) as unknown as RollbackDeviceSnapshot[];
    const locked = lockedRows[0];
    if (!locked || !snapshotMatches(snapshot, locked)) {
      throw new AgentRollbackValidationError('live device rollback state changed before authorization');
    }
    const active = await tx.select({ id: agentRollbackDirectives.id })
      .from(agentRollbackDirectives)
      .where(and(
        eq(agentRollbackDirectives.deviceId, snapshot.id),
        inArray(agentRollbackDirectives.status, ['requested', 'in_progress']),
      )).limit(1);
    if (active.length > 0) throw new AgentRollbackValidationError('device already has an active rollback');
    if (!(await consumeStepUpGrant(input.stepUpGrantId, grantBinding))) {
      throw new AgentRollbackValidationError('step-up grant was already consumed or expired');
    }

    await insertQueuedCommandInTransaction(tx, {
      id: commandId,
      deviceId: snapshot.id,
      type: CommandTypes.AGENT_ROLLBACK_V1,
      payload: { ...directive },
      createdBy: input.authorizedBy,
    });
    await tx.insert(agentRollbackDirectives).values({
      id: rollbackId,
      orgId: snapshot.orgId,
      deviceId: snapshot.id,
      platform,
      architecture,
      currentVersion: snapshot.agentVersion,
      targetVersion: target.version,
      componentVersions: releaseSet.componentVersions,
      releaseManifest: releaseSet.releaseManifest,
      manifestSignature: releaseSet.manifestSignature,
      manifestSigningKeyId: releaseSet.manifestSigningKeyId,
      artifacts: releaseSet.artifacts.map((artifact) => ({ ...artifact })),
      reason,
      authorizedBy: input.authorizedBy,
      approvedAt,
      expiresAt,
      directiveSigningKeyId: directive.directiveSigningKeyId,
      directiveSignature: directive.directiveSignature,
      commandId,
      status: 'requested',
    });
    await tx.insert(agentRollbackEvents).values({
      rollbackId,
      orgId: snapshot.orgId,
      deviceId: snapshot.id,
      phase: 'requested',
      observationId: `server-requested:${rollbackId}`,
      observedAt: approvedAt,
      currentVersion: snapshot.agentVersion,
      componentVersions: Object.fromEntries(
        Object.entries(releaseSet.componentVersions).map(([component, versions]) => [component, versions.current]),
      ),
      observation: { schemaVersion: 1, source: 'server' },
    });
    return directive;
  });
}
