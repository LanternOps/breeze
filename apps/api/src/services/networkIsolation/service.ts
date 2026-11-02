import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  NETWORK_ISOLATION_TTL, isResolvedTerminalIsolationState, isUnresolvedTerminalIsolationState, startNetworkIsolationSchema,
  releaseNetworkIsolationSchema, extendNetworkIsolationSchema,
  type IsolationReleaseKind, type StartNetworkIsolationInput, type ReleaseNetworkIsolationInput,
} from '@breeze/shared';
import { db, withDbAccessContext, withDbTransaction, runAfterDbContextCommit } from '../../db';
import { devices, organizations, incidents, incidentActions, deviceNetworkIsolations, type DeviceNetworkIsolation } from '../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { assertDeviceExecuteAllowed, deviceExecuteAllowedForOrg, TrustDeniedError } from '../partnerTrust.commands';
import { dispatchDeviceCommand } from '../dispatchDeviceCommand';
import { deliveryTtlMs } from '../commandOfflinePolicy';
import { encryptSensitivePayloadFields } from '../sensitiveCommandPayload';
import { encryptSecret, decryptSecret } from '../secretCrypto';
import { columnAad } from '../encryptedColumnTransform';
import { writeRouteAudit, requestLikeFromSnapshot, type AuthContext as AuditContext } from '../auditEvents';
import { buildIsolationAllowlist, IsolationAllowlistError } from './allowlist';
import { generateEpisodeSecret, currentBreakGlassCodes } from './breakGlass';
import { createEpisode, findUnresolvedEpisode, findUnconfirmedTombstone, withEpisodeLock, writeEpisodeSnapshot, toEpisodeSnapshot, listEpisodes, type EpisodeTx } from './episodeStore';
import { applyEpisodeEvent, type EpisodeEvent } from './stateMachine';
import { ISOLATION_SECRET_COLUMN } from './reconcile';
import { captureException } from '../sentry';
import { isolationStartGate, type IsolationStartRefusal } from './gates';
export type { IsolationStartRefusal } from './gates';
export interface ApprovalBinding { orgId: string; deviceId: string; isolationId: string; generation: number }
export type IsolationRefusalCode = IsolationStartRefusal
  | 'device_not_found' | 'isolation_not_found' | 'relay_unavailable' | 'invalid_allowlist'
  | 'isolation_conflict' | 'isolation_secret_unavailable' | 'approval_mismatch'
  | 'device_offline' | 'device_decommissioned' | 'device_pending_assignment' | 'backup_helper_update_required';
class IsolationRefusal extends Error { constructor(readonly code: IsolationRefusalCode, readonly networkIsolationUnsupportedReason?: string) { super(code); } }
function refuse(code: IsolationRefusalCode, reason?: string): never { throw new IsolationRefusal(code, reason); }
function secretUnavailable(error: unknown, deviceId: string, isolationId?: string): never {
  const fault = error instanceof Error ? error : new Error('Isolation secret unavailable');
  console.error('[isolation] secret unavailable', { deviceId, isolationId });
  captureException(fault, undefined, { phase: 'isolation_secret_unavailable', deviceId, ...(isolationId ? { isolationId } : {}) });
  return refuse('isolation_secret_unavailable');
}

/** A refusal rolls back the whole savepoint, including incident/action/command inserts. */
async function inScope<T>(auth: AuthContext, deviceId: string, work: (tx: EpisodeTx) => Promise<T>): Promise<T | { error: IsolationRefusalCode; networkIsolationUnsupportedReason?: string }> {
  try {
    return await withDbAccessContext(dbAccessContextFromAuth(auth), () => withDbTransaction(() => work(db as unknown as EpisodeTx)));
  } catch (error) {
    if (error instanceof IsolationRefusal) {
      // Run after the failed savepoint has rolled back: a refusal audit must survive it.
      console.info('[isolation] refused', { deviceId, code: error.code });
      writeRouteAudit({ ...requestLikeFromSnapshot({}), get: () => auth }, { orgId: auth.orgId ?? undefined, action: 'device.isolation.refused', resourceType: 'device', resourceId: deviceId, details: { code: error.code } });
      return { error: error.code, ...(error.networkIsolationUnsupportedReason ? { networkIsolationUnsupportedReason: error.networkIsolationUnsupportedReason } : {}) };
    }
    throw error;
  }
}
async function loadDevice(tx: EpisodeTx, auth: AuthContext, deviceId: string) {
  // Same lock order as heartbeat and org moves: device, then episode.
  const [device] = await tx.select().from(devices).where(eq(devices.id, deviceId)).limit(1).for('no key update');
  if (!device || !auth.canAccessOrg(device.orgId)) return refuse('device_not_found');
  if (auth.canAccessSite ? !auth.canAccessSite(device.siteId) : auth.allowedSiteIds !== undefined && (!device.siteId || !auth.allowedSiteIds.includes(device.siteId))) return refuse('site_forbidden');
  return device;
}
async function partnerFor(tx: EpisodeTx, orgId: string) {
  const [org] = await tx.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return org?.partnerId ?? null;
}
function safeEpisode(row: DeviceNetworkIsolation) {
  const { breakGlassSecretEnc: _secret, ...episode } = row;
  return { ...episode, lastReportedGeneration: row.lastAgentReport && 'generation' in row.lastAgentReport ? row.lastAgentReport.generation : null };
}
async function queue(device: { id: string; orgId: string }, type: 'execute_containment' | 'release_containment', commandId: string, payload: Record<string, unknown>, auth: AuthContext, expiresAt?: Date) {
  const result = await dispatchDeviceCommand({ deviceId: device.id, expectedOrgId: device.orgId, type, commandId,
    userId: auth.user.id, deferDelivery: true,
    payload: encryptSensitivePayloadFields(type, payload),
    ...(expiresAt ? { offlinePolicy: { kind: 'queue' as const, deliverWithinMs: Math.max(0, Math.min(expiresAt.getTime() - Date.now(), deliveryTtlMs('standard'))) } } : {}),
  });
  if (!result.ok) return refuse(result.code === 'trust_denied' ? 'trust_restricted' : result.code);
  if (result.deliver) {
    const deliver = result.deliver;
    runAfterDbContextCommit('networkIsolation.deliver', async () => { await deliver(); });
  }
  return commandId;
}
export async function startNetworkIsolation(auth: AuthContext, deviceId: string, raw: StartNetworkIsolationInput, opts: { requestedByKind: 'user' | 'brain' | 'system'; approvalRef?: string }) {
  const input = startNetworkIsolationSchema.parse(raw);
  return inScope(auth, deviceId, async (tx) => {
    const device = await loadDevice(tx, auth, deviceId);
    const gate = isolationStartGate(device, await partnerFor(tx, device.orgId));
    if (gate) return refuse(gate, gate === 'agent_not_ready' ? device.networkIsolationUnsupportedReason ?? undefined : undefined);
    try { await assertDeviceExecuteAllowed(device.id, 'execute_containment', auth.user.id); }
    catch (error) { if (error instanceof TrustDeniedError) return refuse('trust_restricted'); throw error; }
    const unresolved = await findUnresolvedEpisode(tx, device.id);
    if (unresolved) return refuse(isUnresolvedTerminalIsolationState(unresolved.state) ? 'isolation_unacknowledged' : 'isolation_already_active');
    if (await findUnconfirmedTombstone(tx, device.id)) return refuse('isolation_already_active');
    const remoteRelay = input.remoteRelay ?? false;
    if (remoteRelay && !process.env.TURN_HOST?.trim() && !process.env.TURN_TLS_HOST?.trim()) return refuse('relay_unavailable');
    let allow;
    try { allow = buildIsolationAllowlist({ serverUrl: device.agentServerUrl ?? process.env.AGENT_SERVER_URL ?? '', remoteRelay }); }
    catch (error) { if (error instanceof IsolationAllowlistError) return refuse('invalid_allowlist'); throw error; }
    const now = new Date();
    let incidentId = input.incidentId;
    if (input.createIncident) {
      incidentId = randomUUID();
      await tx.insert(incidents).values({ id: incidentId, orgId: device.orgId, classification: 'manual_containment', title: input.createIncident.title,
        severity: input.createIncident.severity, affectedDevices: [device.id], detectedAt: now });
    } else {
      const [incident] = await tx.select().from(incidents).where(and(eq(incidents.id, incidentId!), eq(incidents.orgId, device.orgId))).limit(1).for('update');
      if (!incident || incident.orgId !== device.orgId || incident.status === 'closed' || !incident.affectedDevices.includes(device.id)) return refuse('incident_mismatch');
    }
    const id = randomUUID(); const actionId = randomUUID(); const commandId = randomUUID();
    const expiresAt = new Date(now.getTime() + (input.ttlHours ?? NETWORK_ISOLATION_TTL.defaultHours) * 3_600_000);
    const secret = generateEpisodeSecret().toString('base64');
    let sealedSecret: string | null;
    try { sealedSecret = encryptSecret(secret, { aad: columnAad(ISOLATION_SECRET_COLUMN, id) }); }
    catch (error) { return secretUnavailable(error, device.id, id); }
    if (!sealedSecret) return secretUnavailable(new Error('Isolation secret encryption returned no value'), device.id, id);
    await tx.insert(incidentActions).values({ id: actionId, orgId: device.orgId, incidentId: incidentId!, actionType: 'network_isolation',
      description: 'Network isolation', executedBy: opts.requestedByKind, status: 'in_progress', reversible: true,
      result: { commandId }, approvalRef: opts.approvalRef ?? null, executedAt: now });
    const created = await createEpisode(tx, { id, orgId: device.orgId, deviceId: device.id, incidentId, incidentActionId: actionId, commandId,
      requestedByKind: opts.requestedByKind, requestedByUserId: opts.requestedByKind === 'system' ? null : auth.user.id,
      reason: input.reason, expiresAt, deadManSeconds: 0, remoteRelay, allowSnapshot: allow,
      breakGlassSecretEnc: sealedSecret,
    });
    if (!created.ok) return refuse(created.error);
    await queue(device, 'execute_containment', commandId, { incidentId, actionId, actionType: 'network_isolation', breakGlassSecret: secret,
      parameters: { isolationId: id, generation: 1, expiresAt: expiresAt.toISOString(), deadManSeconds: 0, remoteRelay, allow } }, auth, expiresAt);
    const prev = toEpisodeSnapshot(created.episode);
    const transition = applyEpisodeEvent(prev, { type: 'dispatched', generation: 1, at: now });
    if (!('next' in transition) || !await writeEpisodeSnapshot(tx, id, prev, transition.next, now)) return refuse('isolation_conflict');
    return { episode: safeEpisode({ ...created.episode, ...transition.next }), commandId };
  });
}
async function locked<T>(auth: AuthContext, deviceId: string, isolationId: string, work: (tx: EpisodeTx, row: DeviceNetworkIsolation) => Promise<T>) {
  return inScope(auth, deviceId, async tx => {
    const device = await loadDevice(tx, auth, deviceId);
    const result = await withEpisodeLock(tx, isolationId, async row => {
      if (row.deviceId !== device.id || row.orgId !== device.orgId) return refuse('isolation_not_found');
      return work(tx, row);
    });
    if (!result.found) return refuse('isolation_not_found');
    return result.value;
  });
}
async function transition(tx: EpisodeTx, row: DeviceNetworkIsolation, event: EpisodeEvent) {
  const prev = toEpisodeSnapshot(row); const result = applyEpisodeEvent(prev, event);
  if (!('next' in result)) return refuse('isolation_conflict');
  if (!await writeEpisodeSnapshot(tx, row.id, prev, result.next, event.at)) return refuse('isolation_conflict');
  return { ...row, ...result.next };
}
export async function releaseNetworkIsolation(auth: AuthContext, deviceId: string, isolationId: string, raw: ReleaseNetworkIsolationInput, opts: { kind: IsolationReleaseKind; approvalBinding?: ApprovalBinding }) {
  const input = releaseNetworkIsolationSchema.parse(raw);
  return locked(auth, deviceId, isolationId, async (tx, row) => {
    const binding = opts.approvalBinding;
    if (binding && (binding.orgId !== row.orgId || binding.deviceId !== row.deviceId || binding.isolationId !== row.id || binding.generation !== row.generation)) return refuse('approval_mismatch');
    // A resolved but unconfirmed tombstone still deserves another delivery. No start checks here.
    if (isResolvedTerminalIsolationState(row.state) && row.releaseConfirmedAt) return { episode: safeEpisode(row), commandId: row.releaseCommandId };
    const updated = row.desiredState === 'released' ? row : await transition(tx, row, { type: 'release_requested', generation: row.generation, kind: opts.kind, at: new Date() });
    const commandId = randomUUID();
    await queue({ id: row.deviceId, orgId: row.orgId }, 'release_containment', commandId, { isolationId: row.id, generation: updated.generation, reason: input.reason }, auth);
    await tx.update(deviceNetworkIsolations).set({ releaseCommandId: commandId }).where(eq(deviceNetworkIsolations.id, row.id));
    return { episode: safeEpisode({ ...updated, releaseCommandId: commandId }), commandId };
  });
}
export async function extendNetworkIsolation(auth: AuthContext, deviceId: string, isolationId: string, ttlHours: number) {
  extendNetworkIsolationSchema.parse({ ttlHours });
  return locked(auth, deviceId, isolationId, async (tx, row) => {
    // Renewal starts now, so repeated extensions cannot exceed the maximum remaining TTL.
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
    const updated = await transition(tx, row, { type: 'extend', generation: row.generation, expiresAt, at: new Date() });
    return { episode: safeEpisode(updated) };
  });
}
export async function acknowledgeNetworkIsolation(auth: AuthContext, deviceId: string, isolationId: string) {
  return locked(auth, deviceId, isolationId, async (tx, row) => {
    const updated = await transition(tx, row, { type: 'acknowledge', generation: row.generation, userId: auth.user.id, at: new Date() });
    return { episode: safeEpisode(updated) };
  });
}
export async function getBreakGlassCodes(auth: AuthContext, deviceId: string, isolationId: string, auditContext?: AuditContext) {
  return locked(auth, deviceId, isolationId, async (_tx, row) => {
    if (isResolvedTerminalIsolationState(row.state)) return refuse('isolation_conflict');
    if (!row.breakGlassSecretEnc) return secretUnavailable(new Error('Isolation secret is missing'), row.deviceId, row.id);
    let secret: string | null;
    try { secret = decryptSecret(row.breakGlassSecretEnc, { aad: columnAad(ISOLATION_SECRET_COLUMN, row.id), strict: true }); }
    catch (error) { return secretUnavailable(error, row.deviceId, row.id); }
    if (!secret) return secretUnavailable(new Error('Isolation secret decryption returned no value'), row.deviceId, row.id);
    const generation = row.lastAgentReport && 'generation' in row.lastAgentReport ? row.lastAgentReport.generation : row.generation;
    writeRouteAudit(auditContext ?? { ...requestLikeFromSnapshot({}), get: () => auth }, { orgId: row.orgId, action: 'device.isolation.break_glass_code_view', resourceType: 'device', resourceId: row.deviceId, details: { isolationId: row.id, generation } });
    return { generation, ...currentBreakGlassCodes(Buffer.from(secret, 'base64'), row.id, generation, new Date()) };
  });
}
export async function listDeviceIsolations(auth: AuthContext, deviceId: string) {
  return inScope(auth, deviceId, async tx => {
    const device = await loadDevice(tx, auth, deviceId);
    const episodes = await listEpisodes(tx, device.id);
    let reason: IsolationStartRefusal | null = isolationStartGate(device, await partnerFor(tx, device.orgId));
    if (!reason && !await deviceExecuteAllowedForOrg(device.orgId, 'execute_containment', auth.user.id)) reason = 'trust_restricted';
    const unresolved = await findUnresolvedEpisode(tx, device.id);
    if (!reason && unresolved) reason = isUnresolvedTerminalIsolationState(unresolved.state) ? 'isolation_unacknowledged' : 'isolation_already_active';
    if (!reason && await findUnconfirmedTombstone(tx, device.id)) reason = 'isolation_already_active';
    return { episodes: episodes.map(({ breakGlassSecretEnc: _secret, ...episode }: typeof episodes[number] & { breakGlassSecretEnc?: string }) => ({ ...episode, lastReportedGeneration: episode.lastAgentReport && 'generation' in episode.lastAgentReport ? episode.lastAgentReport.generation : null })), startEligibility: { allowed: reason === null, reason, networkIsolationUnsupportedReason: device.networkIsolationUnsupportedReason ?? null } };
  });
}
