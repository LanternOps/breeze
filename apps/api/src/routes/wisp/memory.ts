/**
 * Wisp W03 — the memory page's routes (Wisp design §8.3; w00 "Memory (W03)").
 * Mounted at /api/v1/wisp/memory, AHEAD of W02's /wisp router in index.ts:
 * that router's `use('*')` gates (partner scope only) would otherwise run in
 * front of these handlers and lock organization-scope users out of their own
 * org's memory.
 *
 *   GET  /?scope=mine|org|partner&orgId=  → { blocks: MemoryBlockDto[] }
 *   GET  /users/:userId                   → { blocks }  (partner admin's audited view of a colleague)
 *   POST /:id/confirm                     → { block }
 *   POST /:id/retract                     → { block }
 *
 * #10428 (W05): the chip under a Wisp reply, over the caller's own captured
 * standing instructions (services/wisp/instructionCaptures.ts):
 *   GET  /captures?sessionId=                       → { instructions: CapturedInstructionDto[] }
 *   GET  /captures/status/:captureId                → { status, instructions }
 *   POST /captures/:instructionId/keep              → { instructions }
 *   POST /captures/:instructionId/forget            → { instructions }
 *   POST /captures/:instructionId/keep-for-org      → { instructions }  (409 cross_org)
 * Each group write runs in one transaction, caught outside it, so a refusal
 * part-way leaves the whole group as it was.
 *
 * Gates, in order: authMiddleware → 404 while !wispEnabled() (read per
 * request; the flag wins over the entitlement) → ai_sessions:use →
 * requireEntitlement('wisp') (W04; spec §10, every /api/v1/wisp/* route —
 * pinned by routes/wisp.entitlement.contract.test.ts). Everything else — the
 * human-only rule, the partner-wide capability, the cross-partner refusal —
 * lives in services/wisp/memoryService.ts, under the caller's RLS context.
 *
 * The entitlement belongs to a PARTNER, but an organization-scope session
 * carries `partnerId: null` by design, so for those callers the gate checks
 * the partner that owns the caller's own org (`auth.orgId`, read under the
 * caller's RLS — an org session can always see its own org row). An org row
 * that is not visible fails closed.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { MemoryBlockDto } from '@breeze/shared';
import { eq } from 'drizzle-orm';
import { wispEnabled } from '../../config/env';
import { db, withDbTransactionIfHeld } from '../../db';
import { organizations } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { authMiddleware, requirePermission, type AuthContext } from '../../middleware/auth';
import { requireEntitlement } from '../../middleware/entitlement';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import type { MemoryBlock } from '../../services/wisp/memoryBroker';
import {
  captureStatus,
  confirmInstructionGroup,
  listCapturedInstructions,
  promoteInstructionGroupToOrg,
  retractInstructionGroup,
} from '../../services/wisp/instructionCaptures';
import {
  confirmBlock,
  listBlocksForOrg,
  listBlocksForPartner,
  listBlocksForUser,
  listUserBlocksForPartnerAdmin,
  MemoryServiceError,
  retractBlock,
} from '../../services/wisp/memoryService';

/** Field-by-field wire shape: never `{...block}`; the anchor partner and grant revision stay server-side. */
export function toMemoryBlockDto(block: MemoryBlock): MemoryBlockDto {
  return {
    id: block.id,
    ownerKind: block.owner.kind,
    ownerUserId: block.owner.kind === 'user' ? block.owner.userId : null,
    ownerOrgId: block.owner.kind === 'org' ? block.owner.orgId : null,
    blockType: block.blockType,
    subjectKey: block.subjectKey,
    content: block.content,
    confidence: block.confidence,
    status: block.status,
    authoredByGrantId: block.authoredByGrantId,
    supersededById: block.supersededById,
    sourceSessionId: block.sourceSessionId,
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
  };
}

/** MemoryServiceError → HTTP. Anything else rethrows to the app's error handler. */
function errorResponse(c: Context, err: unknown): Response {
  if (!(err instanceof MemoryServiceError)) throw err;
  switch (err.code) {
    case 'not_found':
      return c.json({ error: err.code }, 404);
    case 'retracted':
    case 'superseded':
    case 'cross_org':
      return c.json({ error: err.code }, 409);
    case 'partner_wide_write_denied':
    case 'human_only':
    case 'cross_partner':
    case 'owner_mismatch':
      return c.json({ error: err.code }, 403);
    case 'invalid_memory':
      return c.json({ error: err.code }, 400);
    default:
      throw err;
  }
}

const uuid = z.string().uuid();
const listQuery = z
  .object({ scope: z.enum(['mine', 'org', 'partner']), orgId: uuid.optional() })
  .refine((q) => q.scope !== 'org' || q.orgId !== undefined, { message: 'orgId is required when scope=org', path: ['orgId'] });
const idParam = z.object({ id: uuid });
const capturesQuery = z.object({ sessionId: uuid });
const captureIdParam = z.object({ captureId: uuid });
const instructionIdParam = z.object({ instructionId: uuid });
const userIdParam = z.object({ userId: uuid });

export const wispMemoryRoutes = new Hono();

wispMemoryRoutes.use('*', authMiddleware);
wispMemoryRoutes.use('*', async (c, next) => {
  if (!wispEnabled()) return c.json({ error: 'not_found' }, 404);
  await next();
});
wispMemoryRoutes.use('*', requirePermission(PERMISSIONS.AI_SESSIONS_USE.resource, PERMISSIONS.AI_SESSIONS_USE.action));
wispMemoryRoutes.use('*', requireEntitlement('wisp', { partnerIdOf: entitlementPartnerOf }));

const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

/** The partner whose `wisp` entitlement governs this caller (see the file header). */
async function entitlementPartnerOf(c: Context): Promise<string | null> {
  const auth = authOf(c);
  if (auth.partnerId) return auth.partnerId;
  if (auth.scope !== 'organization' || !auth.orgId) return null;
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, auth.orgId))
    .limit(1);
  return org?.partnerId ?? null;
}

// #10428 — registered ahead of the /:id routes.
wispMemoryRoutes.get('/captures', zValidator('query', capturesQuery), async (c) => {
  try {
    const instructions = await listCapturedInstructions(authOf(c), c.req.valid('query').sessionId);
    return c.json({ instructions });
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispMemoryRoutes.get('/captures/status/:captureId', zValidator('param', captureIdParam), async (c) => {
  try {
    return c.json(await captureStatus(authOf(c), c.req.valid('param').captureId));
  } catch (err) {
    return errorResponse(c, err);
  }
});

type CaptureAction = 'wisp.memory.capture_keep' | 'wisp.memory.capture_forget' | 'wisp.memory.capture_keep_for_org';
const CAPTURE_OPERATIONS: Array<[string, CaptureAction, typeof confirmInstructionGroup]> = [
  ['keep', 'wisp.memory.capture_keep', confirmInstructionGroup],
  ['forget', 'wisp.memory.capture_forget', retractInstructionGroup],
  ['keep-for-org', 'wisp.memory.capture_keep_for_org', promoteInstructionGroupToOrg],
];

for (const [path, action, operation] of CAPTURE_OPERATIONS) {
  wispMemoryRoutes.post(`/captures/:instructionId/${path}`, zValidator('param', instructionIdParam), async (c) => {
    const auth = authOf(c);
    const { instructionId } = c.req.valid('param');
    try {
      const instructions = await withDbTransactionIfHeld(() => operation(auth, instructionId));
      const [first] = instructions;
      writeRouteAudit(c, {
        orgId: first?.orgId ?? null,
        partnerId: auth.partnerId,
        action,
        resourceType: 'ai_memory_blocks',
        resourceId: instructionId,
        details: { status: first?.status ?? null, enforceable: first?.enforceable ?? false, keptForOrg: first?.keptForOrg ?? false },
      });
      return c.json({ instructions });
    } catch (err) {
      return errorResponse(c, err);
    }
  });
}

wispMemoryRoutes.get('/', zValidator('query', listQuery), async (c) => {
  const auth = authOf(c);
  const { scope, orgId } = c.req.valid('query');
  if (scope === 'partner' && (auth.scope !== 'partner' || !auth.partnerId)) {
    return c.json({ error: 'partner_scope_required' }, 403);
  }
  try {
    const blocks = scope === 'mine'
      ? await listBlocksForUser(auth)
      : scope === 'org'
        ? await listBlocksForOrg(auth, orgId!)
        : await listBlocksForPartner(auth);
    return c.json({ blocks: blocks.map(toMemoryBlockDto) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

// The service writes the 'wisp.memory.user_blocks_viewed' audit row itself
// (and refuses to serve the read unaudited), so no route audit here.
wispMemoryRoutes.get('/users/:userId', zValidator('param', userIdParam), async (c) => {
  try {
    const blocks = await listUserBlocksForPartnerAdmin(authOf(c), c.req.valid('param').userId);
    return c.json({ blocks: blocks.map(toMemoryBlockDto) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

function auditChange(c: Context, action: 'wisp.memory.confirm' | 'wisp.memory.retract', block: MemoryBlock): void {
  writeRouteAudit(c, {
    orgId: block.owner.kind === 'org' ? block.owner.orgId : null,
    partnerId: block.tenantPartnerId,
    action,
    resourceType: 'ai_memory_blocks',
    resourceId: block.id,
    details: { ownerKind: block.owner.kind, blockType: block.blockType, status: block.status },
  });
}

wispMemoryRoutes.post('/:id/confirm', zValidator('param', idParam), async (c) => {
  try {
    const block = await confirmBlock(authOf(c), c.req.valid('param').id);
    auditChange(c, 'wisp.memory.confirm', block);
    return c.json({ block: toMemoryBlockDto(block) });
  } catch (err) {
    return errorResponse(c, err);
  }
});

wispMemoryRoutes.post('/:id/retract', zValidator('param', idParam), async (c) => {
  try {
    const block = await retractBlock(authOf(c), c.req.valid('param').id);
    auditChange(c, 'wisp.memory.retract', block);
    return c.json({ block: toMemoryBlockDto(block) });
  } catch (err) {
    return errorResponse(c, err);
  }
});
