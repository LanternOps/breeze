/**
 * Wisp W03 — the human side of `ai_memory_blocks` (Wisp design §8.3, §8.4).
 *
 * Everything here runs in the caller's ordinary REQUEST DB context, so RLS does
 * the isolation: a user sees and changes their own user blocks, org blocks
 * follow org access, partner blocks follow partner access (the policy in
 * migrations/2027-01-04-110100-ai-memory-blocks.sql). The app-layer gates below
 * add what RLS cannot express — "a person did this" (`user_session`), and
 * "partner-owned memory is partner-wide state" (`canManagePartnerWidePolicies`,
 * epic #2135).
 *
 * The one deliberate widening is `listUserBlocksForPartnerAdmin`: a full-access
 * partner admin reading a colleague's private blocks. RLS would hide them, so
 * that read runs under the SYSTEM context, filtered here by the anchor partner,
 * and is not returned unless its audit row landed.
 *
 * Agent-side reads/writes never come through here — they go through
 * memoryBroker.ts, under the grant ceiling.
 */
import { and, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { MEMORY_BLOCK_TYPES, MEMORY_CONFIDENCES, type MemoryConfidence } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext, type Database } from '../../db';
import { aiMemoryBlocks, aiSessions, organizations, users } from '../../db/schema';
import type { AiMemoryBlockRow } from '../../db/schema/aiMemoryBlocks';
import type { AuthContext } from '../../middleware/auth';
import { createAuditLog } from '../auditService';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import {
  MEMORY_CONTENT_MAX_BYTES, MEMORY_SUBJECT_KEY_MAX_LENGTH, toMemoryBlock,
  memoryKeyLock, type MemoryBlock, type MemoryBlockType,
} from './memoryBroker';

export type MemoryServiceErrorCode =
  | 'not_found'
  | 'retracted'
  | 'partner_wide_write_denied'
  | 'human_only'
  | 'cross_partner'
  /** recordHumanBlock: input failed validation (subject key, content, closed lists, ids). */
  | 'invalid_memory'
  /** recordHumanBlock: the caller may not author memory for the named owner. */
  | 'owner_mismatch'
  /** confirmBlock: a newer block already replaced this one; confirming it would orphan the key. */
  | 'superseded';

export class MemoryServiceError extends Error {
  readonly code: MemoryServiceErrorCode;
  constructor(code: MemoryServiceErrorCode, message: string) {
    super(message);
    this.name = 'MemoryServiceError';
    this.code = code;
  }
}

/** The list pages show live memory: superseded rows are hidden, retracted ones stay (a human can see what they withdrew). */
export const MEMORY_LIST_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertHuman(auth: AuthContext): void {
  if (auth.principal?.kind !== 'user_session') {
    throw new MemoryServiceError('human_only', 'Only a signed-in person can change memory');
  }
}

function assertCanWritePartnerOwned(auth: AuthContext): void {
  if (!canManagePartnerWidePolicies(auth)) {
    throw new MemoryServiceError('partner_wide_write_denied', 'Partner-wide memory requires full partner org access');
  }
}

/**
 * The block fields an approval of `confirm_memory` / `retract_memory` pins
 * (actionIntents/effectDigest.ts). Reads through the CALLER's `database` —
 * the request-context handle at intent creation and release — so RLS still
 * applies: a block the caller cannot see is `undefined`, i.e. target_absent.
 * Lives here so effectDigest.ts never queries ai_memory_blocks itself
 * (memoryBroker.singleCaller.contract.test.ts).
 */
export async function readMemoryBlockForEffectDigest(database: Database, id: string) {
  const [row] = await database
    .select({
      id: aiMemoryBlocks.id,
      tenantPartnerId: aiMemoryBlocks.tenantPartnerId,
      ownerKind: aiMemoryBlocks.ownerKind,
      ownerUserId: aiMemoryBlocks.ownerUserId,
      ownerOrgId: aiMemoryBlocks.ownerOrgId,
      blockType: aiMemoryBlocks.blockType,
      subjectKey: aiMemoryBlocks.subjectKey,
      content: aiMemoryBlocks.content,
      confidence: aiMemoryBlocks.confidence,
      status: aiMemoryBlocks.status,
      supersededById: aiMemoryBlocks.supersededById,
      updatedAt: aiMemoryBlocks.updatedAt,
    })
    .from(aiMemoryBlocks)
    .where(eq(aiMemoryBlocks.id, id))
    .limit(1);
  return row;
}

async function selectBlock(id: string): Promise<AiMemoryBlockRow | undefined> {
  const [row] = await db.select().from(aiMemoryBlocks).where(eq(aiMemoryBlocks.id, id)).limit(1);
  return row;
}

async function listWhere(where: SQL | undefined): Promise<MemoryBlock[]> {
  const rows = await db.select().from(aiMemoryBlocks)
    .where(and(where, isNull(aiMemoryBlocks.supersededById)))
    .orderBy(desc(aiMemoryBlocks.updatedAt))
    .limit(MEMORY_LIST_LIMIT);
  return rows.map(toMemoryBlock);
}

/** Read the block (RLS-visible) and apply the human + partner-wide gates shared by confirm and retract. */
async function loadForChange(auth: AuthContext, id: string): Promise<AiMemoryBlockRow> {
  assertHuman(auth);
  const row = await selectBlock(id);
  if (!row) throw new MemoryServiceError('not_found', 'Memory block not found');
  if (row.ownerKind === 'partner') assertCanWritePartnerOwned(auth);
  return row;
}


/**
 * unconfirmed → confirmed. Already confirmed: returned unchanged. Retracted:
 * refused (`retracted`) — a confirm must never resurrect something a human
 * withdrew, so the UPDATE itself carries `status <> 'retracted'` and a retract
 * that lands between the read and the write still wins.
 *
 * Confirming is the human choosing this block for its key: in the same
 * transaction it supersedes every other live (non-retracted, non-superseded)
 * block with the same (tenant, owner, block_type, subject_key) — including an
 * older confirmed one, which an agent write alone can never replace
 * (memoryBroker.rememberForGrant).
 */
export async function confirmBlock(auth: AuthContext, id: string): Promise<MemoryBlock> {
  const row = await loadForChange(auth, id);
  if (row.status === 'retracted') throw new MemoryServiceError('retracted', 'A retracted memory block cannot be confirmed');
  if (row.status === 'confirmed') return toMemoryBlock(row);
  if (row.supersededById) throw new MemoryServiceError('superseded', 'A newer memory block already replaced this one');

  const updated = await db.transaction(async (tx) => {
    await tx.execute(memoryKeyLock(row));
    const [confirmed] = await tx.update(aiMemoryBlocks)
      .set({ status: 'confirmed', updatedAt: sql`now()` })
      .where(and(eq(aiMemoryBlocks.id, id), ne(aiMemoryBlocks.status, 'retracted'), isNull(aiMemoryBlocks.supersededById)))
      .returning();
    if (!confirmed) return undefined;
    await tx.update(aiMemoryBlocks)
      .set({ supersededById: confirmed.id, updatedAt: sql`now()` })
      .where(and(
        eq(aiMemoryBlocks.tenantPartnerId, confirmed.tenantPartnerId),
        eq(aiMemoryBlocks.ownerKind, confirmed.ownerKind),
        confirmed.ownerUserId === null ? isNull(aiMemoryBlocks.ownerUserId) : eq(aiMemoryBlocks.ownerUserId, confirmed.ownerUserId),
        confirmed.ownerOrgId === null ? isNull(aiMemoryBlocks.ownerOrgId) : eq(aiMemoryBlocks.ownerOrgId, confirmed.ownerOrgId),
        eq(aiMemoryBlocks.blockType, confirmed.blockType),
        eq(aiMemoryBlocks.subjectKey, confirmed.subjectKey),
        ne(aiMemoryBlocks.id, confirmed.id),
        ne(aiMemoryBlocks.status, 'retracted'),
        isNull(aiMemoryBlocks.supersededById),
      ));
    return confirmed;
  });
  if (updated) return toMemoryBlock(updated);

  const current = await selectBlock(id);
  if (!current) throw new MemoryServiceError('not_found', 'Memory block not found');
  if (current.status === 'retracted') throw new MemoryServiceError('retracted', 'A retracted memory block cannot be confirmed');
  if (current.supersededById) throw new MemoryServiceError('superseded', 'A newer memory block already replaced this one');
  return toMemoryBlock(current);
}

/** Any non-retracted status → retracted. Already retracted: returned unchanged. */
export async function retractBlock(auth: AuthContext, id: string): Promise<MemoryBlock> {
  const row = await loadForChange(auth, id);
  if (row.status === 'retracted') return toMemoryBlock(row);

  const [updated] = await db.update(aiMemoryBlocks)
    .set({ status: 'retracted', updatedAt: sql`now()` })
    .where(and(eq(aiMemoryBlocks.id, id), ne(aiMemoryBlocks.status, 'retracted')))
    .returning();
  if (updated) return toMemoryBlock(updated);

  // 0 rows: a concurrent retract won (idempotent) or the row is gone.
  const current = await selectBlock(id);
  if (!current) throw new MemoryServiceError('not_found', 'Memory block not found');
  return toMemoryBlock(current);
}

/** The caller's own user-owned blocks. */
export async function listBlocksForUser(auth: AuthContext): Promise<MemoryBlock[]> {
  return listWhere(and(eq(aiMemoryBlocks.ownerKind, 'user'), eq(aiMemoryBlocks.ownerUserId, auth.user.id)));
}

/** Org-owned blocks for one org the caller can reach. RLS would already hide the rest; the guard gives a clean not_found. */
export async function listBlocksForOrg(auth: AuthContext, orgId: string): Promise<MemoryBlock[]> {
  if (!auth.canAccessOrg(orgId)) throw new MemoryServiceError('not_found', 'Organization not found');
  return listWhere(and(eq(aiMemoryBlocks.ownerKind, 'org'), eq(aiMemoryBlocks.ownerOrgId, orgId)));
}

/** Partner-owned blocks of the caller's partner. Partner scope only; anything else gets [] without a query. */
export async function listBlocksForPartner(auth: AuthContext): Promise<MemoryBlock[]> {
  if (auth.scope !== 'partner' || !auth.partnerId) return [];
  return listWhere(and(eq(aiMemoryBlocks.ownerKind, 'partner'), eq(aiMemoryBlocks.tenantPartnerId, auth.partnerId)));
}

/**
 * A full-access partner admin's view of one colleague's user-owned blocks
 * (Review Focus 5). The only system-context read on the human side, so every
 * guard is here:
 *  - a person, partner scope, `canManagePartnerWidePolicies`;
 *  - the target user's `partner_id` is the caller's partner (request-context
 *    read of `users`; invisible or foreign → `cross_partner`);
 *  - the system read is filtered by `tenant_partner_id = auth.partnerId` too.
 * Exactly one audit row per call. The audit write is synchronous and a failure
 * fails the call: this is a privileged read of private data, so it is never
 * served unaudited.
 */
export async function listUserBlocksForPartnerAdmin(auth: AuthContext, userId: string): Promise<MemoryBlock[]> {
  assertHuman(auth);
  if (auth.scope !== 'partner' || !auth.partnerId || !canManagePartnerWidePolicies(auth)) {
    throw new MemoryServiceError('partner_wide_write_denied', 'Viewing a colleague’s memory requires full partner org access');
  }
  const partnerId = auth.partnerId;

  const [target] = UUID_RE.test(userId)
    ? await db.select({ partnerId: users.partnerId }).from(users).where(eq(users.id, userId)).limit(1)
    : [];
  if (!target || target.partnerId !== partnerId) {
    throw new MemoryServiceError('cross_partner', 'User not found in this partner');
  }

  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select().from(aiMemoryBlocks)
      .where(and(
        eq(aiMemoryBlocks.ownerKind, 'user'),
        eq(aiMemoryBlocks.ownerUserId, userId),
        eq(aiMemoryBlocks.tenantPartnerId, partnerId),
        isNull(aiMemoryBlocks.supersededById),
      ))
      .orderBy(desc(aiMemoryBlocks.updatedAt))
      .limit(MEMORY_LIST_LIMIT),
  'wisp.memoryService.adminView'));

  await createAuditLog({
    orgId: null,
    partnerId,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: 'wisp.memory.user_blocks_viewed',
    resourceType: 'ai_memory_blocks',
    resourceId: userId,
    details: { count: rows.length },
    result: 'success',
  });

  return rows.map(toMemoryBlock);
}

/** recordHumanBlock's owner: `{ kind: 'user' }` without a userId means the caller (the W06 call shape, w00 A34). */
export type HumanMemoryOwner = { kind: 'user'; userId?: string } | { kind: 'org'; orgId: string } | { kind: 'partner' };

export type RecordHumanBlockInput = {
  owner: HumanMemoryOwner;
  blockType: MemoryBlockType;
  subjectKey: string;
  content: Record<string, unknown>;
  confidence?: MemoryConfidence;
  /** Provenance only ("via Wisp for <grantor>"); no agent wrote the block, so no revision is stamped. */
  authoredByGrantId?: string | null;
  sourceSessionId?: string | null;
};

function invalid(message: string): never {
  throw new MemoryServiceError('invalid_memory', message);
}

function validateRecordInput(input: RecordHumanBlockInput): void {
  const { subjectKey, content, blockType, confidence, authoredByGrantId, sourceSessionId } = input;
  // varchar(280) counts characters (code points), not UTF-16 units.
  if (typeof subjectKey !== 'string' || subjectKey.trim().length === 0 || [...subjectKey].length > MEMORY_SUBJECT_KEY_MAX_LENGTH) {
    invalid(`subjectKey must be 1..${MEMORY_SUBJECT_KEY_MAX_LENGTH} characters`);
  }
  if (content === null || typeof content !== 'object' || Array.isArray(content)) invalid('content must be a JSON object');
  const proto = Object.getPrototypeOf(content);
  if (proto !== Object.prototype && proto !== null) invalid('content must be a plain JSON object');
  let serialized: string;
  try { serialized = JSON.stringify(content); } catch { invalid('content must be JSON-serializable'); }
  // The contract's ceiling: JSON.stringify(content).length (same measure as the broker).
  if (serialized.length > MEMORY_CONTENT_MAX_BYTES) invalid(`content must serialise to at most ${MEMORY_CONTENT_MAX_BYTES} characters`);
  if (!(MEMORY_BLOCK_TYPES as readonly string[]).includes(blockType)) invalid('unknown blockType');
  if (confidence !== undefined && !(MEMORY_CONFIDENCES as readonly string[]).includes(confidence)) invalid('unknown confidence');
  if (authoredByGrantId != null && (typeof authoredByGrantId !== 'string' || !UUID_RE.test(authoredByGrantId))) {
    invalid('authoredByGrantId must be a uuid');
  }
  if (sourceSessionId != null && (typeof sourceSessionId !== 'string' || !UUID_RE.test(sourceSessionId))) {
    invalid('sourceSessionId must be a uuid');
  }
}

type ResolvedOwner = {
  tenantPartnerId: string;
  ownerKind: 'user' | 'org' | 'partner';
  ownerUserId: string | null;
  ownerOrgId: string | null;
};

function ownerMismatch(message: string): never {
  throw new MemoryServiceError('owner_mismatch', message);
}

/** Resolve the owner columns and the anchor partner, refusing any owner the caller may not author for. */
async function resolveOwner(auth: AuthContext, owner: HumanMemoryOwner): Promise<ResolvedOwner> {
  switch (owner?.kind) {
    case 'user': {
      if (owner.userId !== undefined && owner.userId !== auth.user.id) ownerMismatch('A person can only record their own user memory');
      // User-owned rows are anchored on the caller's partner (the RLS user branch
      // requires tenant_partner_id = current partner). Organization-session
      // tokens carry no partner, so they cannot own user memory.
      if (auth.scope !== 'partner' || !auth.partnerId) ownerMismatch('User memory requires a partner-scope session');
      return { tenantPartnerId: auth.partnerId, ownerKind: 'user', ownerUserId: auth.user.id, ownerOrgId: null };
    }
    case 'org': {
      if (typeof owner.orgId !== 'string' || !UUID_RE.test(owner.orgId) || !auth.canAccessOrg(owner.orgId)) {
        ownerMismatch('Organization not reachable');
      }
      // The anchor is the org row's own partner (organization tokens carry no partnerId).
      const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
        .where(eq(organizations.id, owner.orgId)).limit(1);
      if (!org) ownerMismatch('Organization not reachable');
      if (auth.partnerId && org.partnerId !== auth.partnerId) ownerMismatch('Organization belongs to another partner');
      return { tenantPartnerId: org.partnerId, ownerKind: 'org', ownerUserId: null, ownerOrgId: owner.orgId };
    }
    case 'partner': {
      if (auth.scope !== 'partner' || !auth.partnerId) ownerMismatch('Partner memory requires a partner-scope session');
      assertCanWritePartnerOwned(auth);
      return { tenantPartnerId: auth.partnerId, ownerKind: 'partner', ownerUserId: null, ownerOrgId: null };
    }
    default:
      return invalid('unknown owner kind');
  }
}

/**
 * A person states a memory (w00 A34; first caller: W06 concern feedback). It
 * lands `confirmed` — a human said it — keeps `authored_by_grant_id` for
 * provenance, and stamps no grant revision (no agent wrote it). In one
 * transaction it supersedes the live (non-retracted, non-superseded) block with
 * the same (tenant, owner, block_type, subject_key). Request context: RLS also
 * refuses any owner the gates below missed.
 */
export async function recordHumanBlock(auth: AuthContext, input: RecordHumanBlockInput): Promise<MemoryBlock> {
  assertHuman(auth);
  validateRecordInput(input);
  const owner = await resolveOwner(auth, input.owner);

  if (input.sourceSessionId) {
    // The FK check ignores RLS; provenance must point at a session the caller can see.
    const [session] = await db.select({ id: aiSessions.id }).from(aiSessions)
      .where(eq(aiSessions.id, input.sourceSessionId)).limit(1);
    if (!session) invalid('sourceSessionId not found');
  }

  const row = await db.transaction(async (tx) => {
    // The shared per-key lock (memoryBroker.memoryKeyLock): a human record and an
    // agent remember on one key serialize, so two writes cannot both stay live.
    await tx.execute(memoryKeyLock({ ...owner, blockType: input.blockType, subjectKey: input.subjectKey }));

    const [created] = await tx.insert(aiMemoryBlocks).values({
      ...owner,
      blockType: input.blockType,
      subjectKey: input.subjectKey,
      content: input.content,
      confidence: input.confidence ?? 'medium',
      status: 'confirmed',
      authoredByGrantId: input.authoredByGrantId ?? null,
      authoredByGrantRevisionId: null,
      sourceSessionId: input.sourceSessionId ?? null,
    }).returning();
    if (!created) throw new Error('ai_memory_blocks insert returned no row');

    const ownerColumn = owner.ownerKind === 'user'
      ? eq(aiMemoryBlocks.ownerUserId, owner.ownerUserId!)
      : owner.ownerKind === 'org' ? eq(aiMemoryBlocks.ownerOrgId, owner.ownerOrgId!) : undefined;
    await tx.update(aiMemoryBlocks)
      .set({ supersededById: created.id, updatedAt: sql`now()` })
      .where(and(
        eq(aiMemoryBlocks.tenantPartnerId, owner.tenantPartnerId),
        eq(aiMemoryBlocks.ownerKind, owner.ownerKind),
        ownerColumn,
        eq(aiMemoryBlocks.blockType, input.blockType),
        eq(aiMemoryBlocks.subjectKey, input.subjectKey),
        ne(aiMemoryBlocks.status, 'retracted'),
        isNull(aiMemoryBlocks.supersededById),
        ne(aiMemoryBlocks.id, created.id),
      ));
    return created;
  });

  return toMemoryBlock(row);
}
