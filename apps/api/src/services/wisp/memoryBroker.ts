/**
 * Wisp W03 — the memory broker (Wisp design §8.4): the ONLY agent-side path to
 * `ai_memory_blocks`.
 *
 * Agents never hold a user identity (agent DB contexts carry `userId: null`), so
 * the broker reads and writes under the SYSTEM DB context and does the
 * isolation itself, from the pinned W02 `GrantCeiling`: the grantor's own user
 * blocks, org blocks inside the ceiling, and — for a partner-wide ceiling only
 * — the anchor partner's blocks; nothing else. Memory is context, never authority (§8.3): nothing here widens
 * what a grant may do.
 *
 * Contract (w00 "Memory (W03)", A23): recallForGrant, rememberForGrant,
 * renderMemoryForPrompt. Human-side reads/writes live in memoryService.ts.
 * memoryBroker.singleCaller.contract.test.ts pins the table's callers.
 */
import { and, desc, eq, inArray, isNull, like, ne, sql, type SQL } from 'drizzle-orm';
import {
  MEMORY_BLOCK_TYPES, MEMORY_CONFIDENCES, MEMORY_OWNER_KINDS,
  standingInstructionContentSchema,
  type MemoryBlockStatus, type MemoryConfidence, type StandingVerb,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiMemoryBlocks, type AiMemoryBlockRow } from '../../db/schema/aiMemoryBlocks';
import { UNTRUSTED_TOOL_OUTPUT_RULE } from '../aiAgentSystemPrompt';
import { sanitizeUntrustedToolText, wrapUntrustedData } from '../aiInputSanitizer';
import { captureException } from '../sentry';
import { assertWithinCeiling, CeilingViolationError, GrantInactiveError, type GrantCeiling } from './grantAuthority';
import { isEnforceableDeny } from './standingInstructions';

export type MemoryOwner = { kind: 'user'; userId: string } | { kind: 'org'; orgId: string } | { kind: 'partner' };
/** work_summary: spec §6.1 (3) / §8.1 — what a working session did, org-owned (w00 A23). */
export type MemoryBlockType = 'preference' | 'standing_instruction' | 'fact' | 'decision' | 'concern_outcome' | 'work_summary';
export type MemoryBlock = {
  id: string;
  tenantPartnerId: string;
  owner: MemoryOwner;
  blockType: MemoryBlockType;
  subjectKey: string;
  content: Record<string, unknown>;
  confidence: MemoryConfidence;
  status: MemoryBlockStatus;
  authoredByGrantId: string | null;
  authoredByGrantRevisionId: string | null;
  supersededById: string | null;
  /** ai_sessions(id), ON DELETE SET NULL — provenance only (w00 A23). */
  sourceSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
export type RecallQuery = {
  owners?: MemoryOwner['kind'][];
  subjectKeyPrefix?: string;
  blockTypes?: MemoryBlockType[];
  orgId?: string | null;
  limit?: number;
};
export type RememberInput = Omit<
  MemoryBlock,
  'id' | 'status' | 'createdAt' | 'updatedAt' | 'authoredByGrantId' | 'authoredByGrantRevisionId' | 'tenantPartnerId' | 'supersededById' | 'sourceSessionId'
> & { sourceSessionId?: string | null };

/** JSON.stringify(content).length ceiling on remember. */
export const MEMORY_CONTENT_MAX_BYTES = 8_192;
export const MEMORY_SUBJECT_KEY_MAX_LENGTH = 280;
export const MEMORY_RECALL_DEFAULT_LIMIT = 50;
export const MEMORY_RECALL_MAX_LIMIT = 200;

/** Row → contract shape. A row whose owner columns break the CHECK cannot exist; fail loudly if one does. */
export function toMemoryBlock(row: AiMemoryBlockRow): MemoryBlock {
  let owner: MemoryOwner;
  if (row.ownerKind === 'user' && row.ownerUserId) owner = { kind: 'user', userId: row.ownerUserId };
  else if (row.ownerKind === 'org' && row.ownerOrgId) owner = { kind: 'org', orgId: row.ownerOrgId };
  else if (row.ownerKind === 'partner') owner = { kind: 'partner' };
  else throw new Error(`ai_memory_blocks row ${row.id} has an invalid owner shape (${row.ownerKind})`);
  return {
    id: row.id,
    tenantPartnerId: row.tenantPartnerId,
    owner,
    blockType: row.blockType,
    subjectKey: row.subjectKey,
    content: row.content,
    confidence: row.confidence,
    status: row.status,
    authoredByGrantId: row.authoredByGrantId ?? null,
    authoredByGrantRevisionId: row.authoredByGrantRevisionId ?? null,
    supersededById: row.supersededById ?? null,
    sourceSessionId: row.sourceSessionId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A remember input the broker refuses on shape alone (before any ceiling or DB work). */
export class MemoryValidationError extends Error {
  readonly code = 'invalid_memory' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

const BROKER_DB_LABEL = 'wisp.memoryBroker';

/**
 * System scope for the broker. Agents carry no user identity, so RLS cannot
 * isolate their reads; the ceiling filters below do. Called from inside a
 * request (W04 chat), so leave the request context first — unless the caller
 * already holds a SYSTEM context, which sees the table in full; reusing it
 * avoids holding a second pooled connection (db/partnerAxisRead.ts).
 */
function inBrokerContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, BROKER_DB_LABEL));
}

function assertActive(ceiling: GrantCeiling): void {
  if (ceiling.status !== 'active') throw new GrantInactiveError(ceiling.grantId, ceiling.status);
}

/** Escape LIKE metacharacters (Postgres' default escape character is `\`). */
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MEMORY_RECALL_DEFAULT_LIMIT;
  return Math.min(MEMORY_RECALL_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The grant's view of memory, under system scope. Three owner branches, each
 * bounded by the ceiling, all inside `tenant_partner_id = ceiling.partnerId`:
 *   - user:    the grantor's own blocks only. A grantor whose user row sits in
 *              another partner matches nothing — the anchor filter plus the
 *              (owner_user_id, tenant_partner_id) composite FK make that
 *              structural, not a check that could be forgotten;
 *   - org:     `q.orgId` (asserted inside the ceiling) or every ceiling org;
 *              an empty set contributes no rows;
 *   - partner: the anchor partner's shared memory — ONLY for a partner-wide
 *              ceiling (`ceiling.partnerWide`: a partner grant whose grantor
 *              still reaches every org). Partner memory is context for every
 *              org of the partner, so a grant narrowed to some orgs (org-scoped,
 *              or a grantor on org_access 'selected') reads user + in-ceiling
 *              org blocks only — the same bar rememberForGrant sets for writing
 *              a partner block (assertWithinCeiling with orgId null).
 * Retracted and superseded blocks are never returned. Confirmed first, then
 * most recently updated. An explicit empty `owners` / `blockTypes` list
 * selects nothing.
 */
export async function recallForGrant(ceiling: GrantCeiling, q: RecallQuery): Promise<MemoryBlock[]> {
  assertActive(ceiling);
  if (typeof q.orgId === 'string') assertWithinCeiling(ceiling, { orgId: q.orgId });

  const owners = new Set<MemoryOwner['kind']>(q.owners ?? MEMORY_OWNER_KINDS);
  const branches: SQL[] = [];
  if (owners.has('user')) {
    branches.push(and(eq(aiMemoryBlocks.ownerKind, 'user'), eq(aiMemoryBlocks.ownerUserId, ceiling.grantorUserId))!);
  }
  if (owners.has('org')) {
    const orgIds = typeof q.orgId === 'string' ? [q.orgId] : [...ceiling.orgIds];
    if (orgIds.length > 0) {
      branches.push(and(eq(aiMemoryBlocks.ownerKind, 'org'), inArray(aiMemoryBlocks.ownerOrgId, orgIds))!);
    }
  }
  // Same predicate as the partner-owner write gate; never on a narrowed grant.
  if (owners.has('partner') && ceiling.partnerWide === true && ceiling.scopeOrgId === null) {
    branches.push(eq(aiMemoryBlocks.ownerKind, 'partner'));
  }
  if (branches.length === 0) return [];
  if (q.blockTypes !== undefined && q.blockTypes.length === 0) return [];

  const conditions: SQL[] = [
    eq(aiMemoryBlocks.tenantPartnerId, ceiling.partnerId),
    ne(aiMemoryBlocks.status, 'retracted'),
    isNull(aiMemoryBlocks.supersededById),
    branches.length === 1 ? branches[0]! : sql`(${sql.join(branches, sql` OR `)})`,
  ];
  if (q.blockTypes !== undefined) conditions.push(inArray(aiMemoryBlocks.blockType, q.blockTypes));
  if (q.subjectKeyPrefix) conditions.push(like(aiMemoryBlocks.subjectKey, `${escapeLikePrefix(q.subjectKeyPrefix)}%`));

  const rows = await inBrokerContext(() => db
    .select()
    .from(aiMemoryBlocks)
    .where(and(...conditions))
    .orderBy(
      desc(sql`(${aiMemoryBlocks.status} = 'confirmed')`),
      desc(aiMemoryBlocks.updatedAt),
      desc(aiMemoryBlocks.id),
    )
    .limit(clampLimit(q.limit)));
  return rows.map(toMemoryBlock);
}

function validateRememberInput(block: RememberInput): void {
  const subjectKey: unknown = block.subjectKey;
  if (typeof subjectKey !== 'string' || subjectKey.trim().length === 0) {
    throw new MemoryValidationError('subjectKey must be a non-empty string');
  }
  // Postgres text/jsonb cannot hold NUL; refuse it here rather than as a driver error.
  if (subjectKey.includes('\u0000')) throw new MemoryValidationError('subjectKey must not contain NUL');
  // varchar(280) counts characters (code points), not UTF-16 units.
  if ([...subjectKey].length > MEMORY_SUBJECT_KEY_MAX_LENGTH) {
    throw new MemoryValidationError(`subjectKey must be at most ${MEMORY_SUBJECT_KEY_MAX_LENGTH} characters`);
  }
  if (!(MEMORY_BLOCK_TYPES as readonly string[]).includes(block.blockType)) {
    throw new MemoryValidationError(`blockType must be one of ${MEMORY_BLOCK_TYPES.join(', ')}`);
  }
  if (!(MEMORY_CONFIDENCES as readonly string[]).includes(block.confidence)) {
    throw new MemoryValidationError(`confidence must be one of ${MEMORY_CONFIDENCES.join(', ')}`);
  }
  const content: unknown = block.content;
  const proto = content !== null && typeof content === 'object' ? Object.getPrototypeOf(content) : undefined;
  if (Array.isArray(content) || (proto !== Object.prototype && proto !== null)) {
    throw new MemoryValidationError('content must be a plain JSON object');
  }
  let serialized: string;
  let hasNul = false;
  try {
    serialized = JSON.stringify(content, (key: string, value: unknown) => {
      if (key.includes('\u0000') || (typeof value === 'string' && value.includes('\u0000'))) hasNul = true;
      return value;
    });
  } catch {
    throw new MemoryValidationError('content must be JSON-serialisable');
  }
  if (hasNul) throw new MemoryValidationError('content must not contain NUL');
  if (serialized.length > MEMORY_CONTENT_MAX_BYTES) {
    throw new MemoryValidationError(`content must serialise to at most ${MEMORY_CONTENT_MAX_BYTES} characters`);
  }
}

/** Owner checks against the ceiling. Throws before any write. */
function assertOwnerWithinCeiling(ceiling: GrantCeiling, owner: MemoryOwner): void {
  switch (owner?.kind) {
    case 'user':
      // A grant writes only its grantor's own user memory, never a colleague's.
      if (owner.userId !== ceiling.grantorUserId) {
        throw new CeilingViolationError('permission', 'a grant may write user memory only for its grantor');
      }
      return;
    case 'org':
      assertWithinCeiling(ceiling, { orgId: owner.orgId });
      return;
    case 'partner':
      // Partner memory is read in every org of the partner: writing it needs a
      // partner-wide grant whose grantor still has full partner org access, or
      // a narrowed grant could plant context in orgs it cannot reach.
      assertWithinCeiling(ceiling, { orgId: null });
      return;
    default:
      throw new MemoryValidationError(`owner.kind must be one of ${MEMORY_OWNER_KINDS.join(', ')}`);
  }
}

/**
 * The per-key advisory lock every writer of one (tenant, owner, block_type,
 * subject_key) takes — rememberForGrant here, confirmBlock and recordHumanBlock
 * in memoryService.ts — so an agent write and a human write on one key
 * serialize. JSON, not a NUL-joined string: Postgres text rejects NUL (22021).
 */
export function memoryKeyLock(key: {
  tenantPartnerId: string; ownerKind: MemoryOwner['kind']; ownerUserId: string | null; ownerOrgId: string | null;
  blockType: MemoryBlockType; subjectKey: string;
}): SQL {
  const lockKey = JSON.stringify([key.tenantPartnerId, key.ownerKind, key.ownerUserId ?? key.ownerOrgId, key.blockType, key.subjectKey]);
  return sql`SELECT pg_advisory_xact_lock(hashtext('wisp.memory.remember'), hashtext(${lockKey}))`;
}

/**
 * Write one block for the grant: status 'unconfirmed', stamped with the grant
 * and revision that authored it, anchored on the ceiling's partner. Then, in
 * the same transaction, supersede the previous live UNCONFIRMED block with the
 * same (owner, blockType, subjectKey). A per-key advisory lock serialises
 * concurrent writers so two racing writes cannot both stay live.
 *
 * An agent write never supersedes a human-confirmed block (spec §8.3: a person
 * confirms, Wisp proposes): the confirmed block stays live beside the new
 * proposal and recalls first; only a human confirm of the proposal
 * (memoryService.confirmBlock) replaces it. Otherwise a prompt-injected
 * `remember` could silently drop a technician's confirmed preference.
 */
export async function rememberForGrant(ceiling: GrantCeiling, block: RememberInput): Promise<MemoryBlock> {
  assertActive(ceiling);
  validateRememberInput(block);
  assertOwnerWithinCeiling(ceiling, block.owner);

  const row = await inBrokerContext(async () => {
    await db.execute(memoryKeyLock(lockKeyFor(ceiling, block)));
    return insertAndSupersede(ceiling, block);
  });
  return toMemoryBlock(row);
}

/** Maximum blocks one instruction-capture group write may carry (5 instructions × 20 targets). */
export const MEMORY_GROUP_MAX_BLOCKS = 100;

/**
 * #10428 (W05): the blocks one turn-end instruction capture wrote, all in ONE
 * transaction — every block lands or none does. Each block follows
 * rememberForGrant's rule exactly (unconfirmed, grant + revision stamped, the
 * previous live UNCONFIRMED block with the same key superseded, a confirmed
 * one never). Every block is validated and ceiling-checked before any write,
 * and the per-key locks are taken in one sorted order, so two concurrent group
 * writes over overlapping keys cannot deadlock.
 */
export async function rememberInstructionGroupForGrant(ceiling: GrantCeiling, blocks: RememberInput[]): Promise<MemoryBlock[]> {
  assertActive(ceiling);
  if (blocks.length === 0) return [];
  if (blocks.length > MEMORY_GROUP_MAX_BLOCKS) {
    throw new MemoryValidationError(`a group write carries at most ${MEMORY_GROUP_MAX_BLOCKS} blocks`);
  }
  for (const block of blocks) {
    validateRememberInput(block);
    assertOwnerWithinCeiling(ceiling, block.owner);
  }

  const locks = [...new Map(blocks.map((block) => {
    const key = lockKeyFor(ceiling, block);
    return [JSON.stringify(key), key] as const;
  })).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const rows = await inBrokerContext(async () => {
    for (const [, key] of locks) await db.execute(memoryKeyLock(key));
    const inserted: AiMemoryBlockRow[] = [];
    for (const block of blocks) inserted.push(await insertAndSupersede(ceiling, block));
    return inserted;
  });
  return rows.map(toMemoryBlock);
}

function lockKeyFor(ceiling: GrantCeiling, block: RememberInput): Parameters<typeof memoryKeyLock>[0] {
  const { owner } = block;
  return {
    tenantPartnerId: ceiling.partnerId,
    ownerKind: owner.kind,
    ownerUserId: owner.kind === 'user' ? owner.userId : null,
    ownerOrgId: owner.kind === 'org' ? owner.orgId : null,
    blockType: block.blockType,
    subjectKey: block.subjectKey,
  };
}

/** The write half of rememberForGrant; the caller holds the key's advisory lock inside the broker context. */
async function insertAndSupersede(ceiling: GrantCeiling, block: RememberInput): Promise<AiMemoryBlockRow> {
  const { owner } = block;
  const ownerUserId = owner.kind === 'user' ? owner.userId : null;
  const ownerOrgId = owner.kind === 'org' ? owner.orgId : null;
  const [inserted] = await db.insert(aiMemoryBlocks).values({
    tenantPartnerId: ceiling.partnerId,
    ownerKind: owner.kind,
    ownerUserId,
    ownerOrgId,
    blockType: block.blockType,
    subjectKey: block.subjectKey,
    content: block.content,
    confidence: block.confidence,
    status: 'unconfirmed',
    authoredByGrantId: ceiling.grantId,
    authoredByGrantRevisionId: ceiling.revisionId,
    sourceSessionId: block.sourceSessionId ?? null,
  }).returning();
  if (!inserted) throw new Error('ai_memory_blocks insert returned no row');

  await db.update(aiMemoryBlocks)
    .set({ supersededById: inserted.id, updatedAt: sql`now()` })
    .where(and(
      eq(aiMemoryBlocks.tenantPartnerId, ceiling.partnerId),
      eq(aiMemoryBlocks.ownerKind, owner.kind),
      ownerUserId === null ? isNull(aiMemoryBlocks.ownerUserId) : eq(aiMemoryBlocks.ownerUserId, ownerUserId),
      ownerOrgId === null ? isNull(aiMemoryBlocks.ownerOrgId) : eq(aiMemoryBlocks.ownerOrgId, ownerOrgId),
      eq(aiMemoryBlocks.blockType, block.blockType),
      eq(aiMemoryBlocks.subjectKey, block.subjectKey),
      ne(aiMemoryBlocks.id, inserted.id),
      eq(aiMemoryBlocks.status, 'unconfirmed'),
      isNull(aiMemoryBlocks.supersededById),
    ));
  return inserted;
}

/**
 * #10428 W06 (spec §5.3): one remembered standing instruction that a tool call
 * on one of its devices would break. `strength` is how the call's verb matched
 * (`exact`: the call does it; `possible`: an opaque tool might).
 */
export type StandingInstructionMatch = {
  blockId: string;
  instructionId: string;
  status: 'confirmed' | 'unconfirmed';
  text: string;
  deviceId: string;
  verb: StandingVerb;
  enforceable: boolean;
  strength: 'exact' | 'possible';
};

/**
 * Upper bound on the rows one enforcement lookup reads. The lookup must be
 * complete for its devices (it is not the recall path), so reaching the bound
 * throws instead of deciding on a partial set; the caller fails closed.
 */
export const STANDING_MATCH_MAX_ROWS = 500;

/**
 * Every live standing instruction a call on `deviceIds` would break, for
 * enforcement (not recall: no 50/200-row limit, complete for the devices).
 * Under system scope inside `tenant_partner_id = ceiling.partnerId`, over the
 * W05 `ai_memory_blocks_standing_device_idx`, with the recall owner rule:
 *   - user:    the grantor's own blocks;
 *   - org:     blocks of the ceiling's orgs. A block is keyed on its device
 *              (`content.deviceId`), and "Keep for everyone" writes it to the
 *              one org every target device is in, so no device → org lookup is
 *              needed; a call on a device outside the ceiling is refused by
 *              the ceiling itself, and an org outside it never lends its text;
 *   - partner: only for a partner-wide ceiling (recallForGrant's rule).
 * Retracted and superseded blocks never match; nor does a block whose `until`
 * has passed or whose verb the call cannot break. Content that fails the
 * schema is ignored and reported. Narrowing only: a match can turn a call
 * into a refusal or a warning, never admit one, so the ceiling's status is not
 * asserted here (a release re-check may run on a paused grant).
 */
export async function findStandingInstructionMatches(input: {
  ceiling: GrantCeiling;
  deviceIds: string[];
  exact: StandingVerb[];
  possible: StandingVerb[];
  now?: Date;
}): Promise<StandingInstructionMatch[]> {
  const { ceiling } = input;
  const exact = new Set(input.exact);
  const possible = new Set(input.possible.filter((v) => !exact.has(v)));
  const deviceIds = [...new Set(input.deviceIds)];
  if (deviceIds.length === 0 || (exact.size === 0 && possible.size === 0)) return [];
  const now = input.now ?? new Date();

  const branches: SQL[] = [
    and(eq(aiMemoryBlocks.ownerKind, 'user'), eq(aiMemoryBlocks.ownerUserId, ceiling.grantorUserId))!,
  ];
  if (ceiling.orgIds.size > 0) {
    branches.push(and(eq(aiMemoryBlocks.ownerKind, 'org'), inArray(aiMemoryBlocks.ownerOrgId, [...ceiling.orgIds]))!);
  }
  if (ceiling.partnerWide === true && ceiling.scopeOrgId === null) branches.push(eq(aiMemoryBlocks.ownerKind, 'partner'));

  const rows = await inBrokerContext(() => db
    .select({ id: aiMemoryBlocks.id, status: aiMemoryBlocks.status, content: aiMemoryBlocks.content })
    .from(aiMemoryBlocks)
    .where(and(
      eq(aiMemoryBlocks.tenantPartnerId, ceiling.partnerId),
      eq(aiMemoryBlocks.blockType, 'standing_instruction'),
      inArray(sql<string>`(${aiMemoryBlocks.content}->>'deviceId')`, deviceIds),
      ne(aiMemoryBlocks.status, 'retracted'),
      isNull(aiMemoryBlocks.supersededById),
      sql`(${sql.join(branches, sql` OR `)})`,
    ))
    .limit(STANDING_MATCH_MAX_ROWS + 1));
  if (rows.length > STANDING_MATCH_MAX_ROWS) {
    throw new Error(`standing-instruction lookup for grant ${ceiling.grantId} exceeded ${STANDING_MATCH_MAX_ROWS} rows`);
  }

  const wanted = new Set(deviceIds);
  const matches: StandingInstructionMatch[] = [];
  for (const row of rows) {
    if (row.status !== 'confirmed' && row.status !== 'unconfirmed') continue;
    const parsed = standingInstructionContentSchema.safeParse(row.content);
    if (!parsed.success) {
      // The SQL matched it on one of the call's devices but its verb cannot
      // be read: never decide it is no match. It warns (a human sees the
      // call), and never refuses on content nobody can read.
      console.error(`[memoryBroker] standing_instruction ${row.id} fails its schema; enforced as a warning`);
      captureException(new Error(`ai_memory_blocks ${row.id}: standing_instruction content fails its schema; enforced as a warning`));
      const raw = row.content as Record<string, unknown>;
      const rawDevice = typeof raw.deviceId === 'string' ? raw.deviceId.toLowerCase() : '';
      matches.push({
        blockId: row.id,
        instructionId: typeof raw.instructionId === 'string' ? raw.instructionId : row.id,
        status: row.status,
        text: typeof raw.text === 'string' && raw.text.length > 0 ? raw.text.slice(0, 500) : 'a remembered instruction for this device',
        deviceId: wanted.has(rawDevice) ? rawDevice : deviceIds[0]!,
        verb: 'any_change',
        enforceable: false,
        strength: 'possible',
      });
      continue;
    }
    const c = parsed.data;
    if (c.verb === null || c.deviceId === null || !wanted.has(c.deviceId)) continue;
    if (c.until !== null && !(Date.parse(c.until) > now.getTime())) continue;
    const strength = exact.has(c.verb) ? 'exact' : possible.has(c.verb) ? 'possible' : null;
    if (strength === null) continue;
    matches.push({
      blockId: row.id,
      instructionId: c.instructionId,
      status: row.status,
      text: c.text,
      deviceId: c.deviceId,
      verb: c.verb,
      enforceable: isEnforceableDeny(c, now),
      strength,
    });
  }
  return matches;
}

/**
 * The hybrid rule (spec §5.3): a CONFIRMED, enforceable deny on an EXACT verb
 * refuses; any other match warns (an unconfirmed one, a conditional one, a
 * `prefer`/`require`, or a `possible` match from an opaque tool).
 */
export function standingInstructionDecision(
  matches: StandingInstructionMatch[],
): { action: 'refuse'; match: StandingInstructionMatch } | { action: 'warn'; matches: StandingInstructionMatch[] } | { action: 'none' } {
  const refusing = matches.find((m) => m.status === 'confirmed' && m.enforceable && m.strength === 'exact');
  if (refusing) return { action: 'refuse', match: refusing };
  if (matches.length > 0) return { action: 'warn', matches };
  return { action: 'none' };
}

export function standingInstructionRefusalMessage(m: StandingInstructionMatch): string {
  return `Refused: matches a standing instruction ('${m.text}'). Ask the user to lift it.`;
}

/**
 * Memory as prompt context: '' for none; otherwise the untrusted-output rule
 * followed by one `wisp_memory` untrusted-data fence, confirmed blocks first.
 * Subject keys and content are model-authored, so both are sanitised per line
 * (forged fences become `[filtered]`) and the whole body goes through
 * `wrapUntrustedData`. Context, never authority (§8.3).
 */
export function renderMemoryForPrompt(blocks: MemoryBlock[]): string {
  if (blocks.length === 0) return '';
  const ordered = [
    ...blocks.filter((b) => b.status === 'confirmed'),
    ...blocks.filter((b) => b.status !== 'confirmed'),
  ];
  const lines = ordered.map((b) =>
    `- [${b.blockType}/${b.status}/${b.confidence}] ${sanitizeUntrustedToolText(b.subjectKey)}: `
    + sanitizeUntrustedToolText(JSON.stringify(b.content)));
  return `${UNTRUSTED_TOOL_OUTPUT_RULE}\n${wrapUntrustedData('wisp_memory', lines.join('\n'))}`;
}
