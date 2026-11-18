/**
 * #10428 (W05; spec §5.2 (i)) — the chip under a Wisp reply: what the
 * turn-end capture saved, and the three things a person can do with it.
 *
 *   Keep                     → confirm every block of the instruction
 *   Keep for everyone at Org → confirmed org-owned copies; the user blocks are
 *                              superseded by them. Offered only when every
 *                              target device is in ONE org the caller can see,
 *                              so content is never published across orgs.
 *   Forget                   → retract every block of the instruction
 *
 * Human side, request context: RLS isolates, and memoryService.ts restricts
 * every read and write to the caller's own captured user blocks (another
 * person's instructionId is `not_found`). This module shapes the chip's DTO,
 * reads the target devices' orgs (under RLS) and decides the single-org check,
 * and delegates every write to memoryService.ts.
 */
import {
  standingInstructionContentSchema,
  type CapturedInstructionDto,
  type StandingInstructionContent,
  type WispInstructionCaptureStatusResponse,
} from '@breeze/shared';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { devices, organizations } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { readInstructionCapture } from './instructionCaptureStatus';
import {
  MemoryServiceError,
  confirmInstructionGroupBlocks,
  instructionGroupDeviceIds,
  listCapturedInstructionBlocks,
  promoteInstructionGroupBlocksToOrg,
  retractInstructionGroupBlocks,
  type CapturedInstructionBlock,
  type CapturedInstructionFilter,
} from './memoryService';
import { isEnforceableDeny } from './standingInstructions';

type DeviceOrg = { orgId: string; orgName: string };

/** The org of each device the caller can see (RLS); an invisible device is absent. */
async function deviceOrgs(deviceIds: string[]): Promise<Map<string, DeviceOrg>> {
  const unique = [...new Set(deviceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: devices.id, orgId: devices.orgId, orgName: organizations.name })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(inArray(devices.id, unique));
  return new Map(rows.map((r) => [r.id, { orgId: r.orgId, orgName: r.orgName }]));
}

/** The one org every device is in, or null (none, spread across orgs, or any not visible). */
function singleOrg(deviceIds: Array<string | null>, orgs: Map<string, DeviceOrg>): DeviceOrg | null {
  if (deviceIds.length === 0 || deviceIds.some((id) => id === null)) return null;
  const found = deviceIds.map((id) => orgs.get(id!));
  if (found.some((o) => o === undefined)) return null;
  const first = found[0]!;
  return found.every((o) => o!.orgId === first.orgId) ? first : null;
}

type Group = { content: StandingInstructionContent; live: CapturedInstructionBlock[]; promoted: CapturedInstructionBlock[] };

/** One DTO per instructionId, in capture order. A group fully replaced by a newer capture of the same clause is dropped. */
async function toDtos(blocks: CapturedInstructionBlock[], now: Date = new Date()): Promise<CapturedInstructionDto[]> {
  const groups = new Map<string, Group>();
  for (const entry of blocks) {
    const parsed = standingInstructionContentSchema.safeParse(entry.block.content);
    if (!parsed.success) continue;
    const group = groups.get(parsed.data.instructionId) ?? { content: parsed.data, live: [], promoted: [] };
    if (entry.block.supersededById === null) group.live.push(entry);
    else if (entry.supersededByOwnerKind === 'org') group.promoted.push(entry);
    groups.set(parsed.data.instructionId, group);
  }

  const deviceIdsOf = (g: Group) => [...g.live, ...g.promoted].map((e) => (e.block.content as StandingInstructionContent).deviceId);
  const orgs = await deviceOrgs([...groups.values()].flatMap(deviceIdsOf).filter((id): id is string => id !== null));

  const out: CapturedInstructionDto[] = [];
  for (const [instructionId, group] of groups) {
    if (group.live.length === 0 && group.promoted.length === 0) continue;
    const keptForOrg = group.live.length === 0;
    const statuses = group.live.map((e) => e.block.status);
    const status: CapturedInstructionDto['status'] = keptForOrg ? 'confirmed'
      : statuses.includes('unconfirmed') ? 'unconfirmed'
        : statuses.every((s) => s === 'retracted') ? 'retracted' : 'confirmed';
    const deviceIds = deviceIdsOf(group);
    const org = singleOrg(deviceIds, orgs);
    const { content } = group;
    const capturedAt = [...group.live, ...group.promoted]
      .map((e) => e.block.createdAt)
      .reduce((a, b) => (a <= b ? a : b));
    out.push({
      instructionId,
      captureId: content.captureId,
      capturedAt: capturedAt.toISOString(),
      text: content.text,
      status,
      enforceable: status !== 'retracted' && isEnforceableDeny(content, now),
      verb: content.verb,
      targetLabels: content.targetLabels,
      until: content.until,
      orgId: org?.orgId ?? null,
      orgName: org?.orgName ?? null,
      unmatched: content.deviceId === null && content.targetLabels.length > 0,
      keptForOrg,
    });
  }
  return out;
}

async function dtosFor(auth: AuthContext, filter: CapturedInstructionFilter): Promise<CapturedInstructionDto[]> {
  return toDtos(await listCapturedInstructionBlocks(auth, filter));
}

/** The chips for a session, recovered from the persisted blocks (a reload). */
export async function listCapturedInstructions(auth: AuthContext, sessionId: string): Promise<CapturedInstructionDto[]> {
  return dtosFor(auth, { sessionId });
}

/**
 * The status the chip polls after `done`. Only the person who sent the message
 * sees it: an unknown, expired or someone else's capture is `not_found`.
 */
export async function captureStatus(auth: AuthContext, captureId: string): Promise<WispInstructionCaptureStatusResponse> {
  const record = await readInstructionCapture(captureId);
  if (!record || record.userId !== auth.user.id) {
    throw new MemoryServiceError('not_found', 'Instruction capture not found');
  }
  return {
    status: record.status,
    instructions: record.status === 'saved' ? await dtosFor(auth, { captureId }) : [],
  };
}

export async function confirmInstructionGroup(auth: AuthContext, instructionId: string): Promise<CapturedInstructionDto[]> {
  await confirmInstructionGroupBlocks(auth, instructionId);
  return dtosFor(auth, { instructionId });
}

export async function retractInstructionGroup(auth: AuthContext, instructionId: string): Promise<CapturedInstructionDto[]> {
  await retractInstructionGroupBlocks(auth, instructionId);
  return dtosFor(auth, { instructionId });
}

/** Keep for everyone: refused `cross_org` unless every target device is in one org the caller can see. */
export async function promoteInstructionGroupToOrg(auth: AuthContext, instructionId: string): Promise<CapturedInstructionDto[]> {
  const deviceIds = await instructionGroupDeviceIds(auth, instructionId);
  const org = singleOrg(deviceIds, await deviceOrgs(deviceIds.filter((id): id is string => id !== null)));
  if (!org) {
    throw new MemoryServiceError('cross_org', 'Every device this instruction names must be in one organization to share it');
  }
  await promoteInstructionGroupBlocksToOrg(auth, instructionId, org.orgId);
  return dtosFor(auth, { instructionId });
}
