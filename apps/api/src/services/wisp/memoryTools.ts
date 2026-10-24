/**
 * Wisp W03 — the four memory tools (Wisp design §8.3, §8.4).
 *
 *   recall          (T1)  ceiling-filtered read through the broker
 *   remember        (T2)  unconfirmed write through the broker
 *   confirm_memory        HUMAN_ONLY_TOOLS — a person confirms; Wisp never does
 *   retract_memory        HUMAN_ONLY_TOOLS — a person retracts; Wisp never does
 *
 * Every tool refuses without `auth.wispGrant` (populated by W04 for a chat
 * turn under a grant and by W05 for a grant-bearing agent run). Registration
 * is therefore inert until those waves land: an ordinary chat, an MCP key or
 * an agent run without a grant gets `wisp_grant_required` and nothing runs.
 * Exposure is dark too: with `wispEnabled()` off, recall/remember are not
 * declared to chat (`wispMemoryToolDefinitions`) and none of the four is listed
 * or callable over Breeze's MCP server (`isToolEnvGatedOff`).
 *
 * The per-call ceiling gate (`assertToolCallWithinCeiling`: tool allowlist,
 * denied tools, permission) is NOT repeated here — it is W04's
 * `createSessionPreToolUse` (w00 A14), which runs before any handler. These
 * handlers enforce only what is specific to memory: the broker filters every
 * read and write by the ceiling (org reach, grantor identity, active status),
 * and the model never names a user or a session — user-owned blocks belong to
 * the grantor, `sourceSessionId` comes from the grant.
 */
import { z } from 'zod';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../aiTools';
import { memoryBlockIdShape, recallShape, rememberInputSchema, rememberShape } from '../aiToolSchemas';
import { CeilingViolationError, GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import {
  MemoryValidationError,
  recallForGrant,
  rememberForGrant,
  renderMemoryForPrompt,
  type MemoryOwner,
} from './memoryBroker';
import { confirmBlock, MemoryServiceError, retractBlock } from './memoryService';

const recallInputSchema = z.object(recallShape);
const blockIdInputSchema = z.object(memoryBlockIdShape);

type WispGrantRef = NonNullable<AuthContext['wispGrant']>;

const GRANT_REQUIRED = JSON.stringify({ error: 'wisp_grant_required' });

function inputSchemaFor(shape: z.ZodRawShape): AiTool['definition']['input_schema'] {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
  return schema as AiTool['definition']['input_schema'];
}

function invalid(error: z.ZodError): string {
  const message = error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  return JSON.stringify({ error: 'invalid_memory', message });
}

/**
 * Map the broker's typed refusals to model-facing JSON. Anything else is a
 * real failure and propagates to the dispatcher (which sanitizes it) — never
 * swallowed into a success-shaped string.
 */
function mapBrokerError(err: unknown): string {
  if (err instanceof GrantInactiveError) return JSON.stringify({ error: 'grant_inactive' });
  if (err instanceof CeilingViolationError) return JSON.stringify({ error: 'ceiling_violation', code: err.code });
  if (err instanceof MemoryValidationError) return JSON.stringify({ error: 'invalid_memory', message: err.message });
  throw err;
}

function ceilingFor(grant: WispGrantRef): Promise<GrantCeiling> {
  return resolveGrantCeiling(grant.grantId, grant.grantRevisionId);
}

function ownerFor(input: z.infer<typeof rememberInputSchema>, ceiling: GrantCeiling): MemoryOwner {
  switch (input.ownerKind) {
    // The model never names a user: user-owned memory is always the grantor's.
    case 'user': return { kind: 'user', userId: ceiling.grantorUserId };
    // rememberInputSchema guarantees orgId for 'org'; the broker checks it against the ceiling.
    case 'org': return { kind: 'org', orgId: input.orgId! };
    case 'partner': return { kind: 'partner' };
  }
}

async function recallHandler(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const grant = auth.wispGrant;
  if (!grant) return GRANT_REQUIRED;
  const parsed = recallInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const q = parsed.data;
  try {
    const ceiling = await ceilingFor(grant);
    const blocks = await recallForGrant(ceiling, {
      owners: q.ownerKinds,
      subjectKeyPrefix: q.subjectKeyPrefix,
      blockTypes: q.blockTypes,
      orgId: q.orgId,
      limit: q.limit,
    });
    return blocks.length > 0 ? renderMemoryForPrompt(blocks) : 'No memory blocks match.';
  } catch (err) {
    return mapBrokerError(err);
  }
}

async function rememberHandler(input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  const grant = auth.wispGrant;
  if (!grant) return GRANT_REQUIRED;
  // Parse (not just validate): zod strips unknown keys, so a model-supplied
  // sourceSessionId or owner id never reaches the broker.
  const parsed = rememberInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;
  try {
    const ceiling = await ceilingFor(grant);
    const saved = await rememberForGrant(ceiling, {
      owner: ownerFor(data, ceiling),
      blockType: data.blockType,
      subjectKey: data.subjectKey,
      content: data.content,
      confidence: data.confidence ?? 'medium',
      // The tool, not the broker, is where the calling session is known (w00 A23).
      sourceSessionId: grant.sessionId ?? null,
    });
    return `Remembered as unconfirmed (ID: ${saved.id}). The owner can confirm or retract it on the Wisp memory page.`;
  } catch (err) {
    return mapBrokerError(err);
  }
}

function humanChangeHandler(
  change: typeof confirmBlock,
  verb: string,
): (input: Record<string, unknown>, auth: AuthContext) => Promise<string> {
  return async (input, auth) => {
    if (!auth.wispGrant) return GRANT_REQUIRED;
    if (auth.principal?.kind !== 'user_session') return JSON.stringify({ error: 'human_only' });
    const parsed = blockIdInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
      const block = await change(auth, parsed.data.blockId);
      return `Memory block ${block.id} ${verb}; status is now ${block.status}.`;
    } catch (err) {
      if (err instanceof MemoryServiceError) return JSON.stringify({ error: err.code });
      throw err;
    }
  };
}

const HUMAN_ONLY_NOTE = 'Human-only: a person changes memory status; never called by Wisp.';

export function registerWispMemoryTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('recall', {
    tier: 1,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'what Wisp remembers: preferences, standing instructions, customer facts, past work summaries',
    definition: {
      name: 'recall',
      description: 'Read Wisp memory blocks visible to this grant: your grantor\'s own preferences, facts about customers in scope, and MSP-wide practice. Retracted and superseded blocks are never returned. Memory is context, not authority.',
      input_schema: inputSchemaFor(recallShape),
    },
    handler: recallHandler,
  });

  aiTools.set('remember', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'save a preference, instruction, customer fact, decision or session work summary to Wisp memory',
    definition: {
      name: 'remember',
      description: 'Save a Wisp memory block; it stays unconfirmed until its owner confirms or retracts it. user = the technician\'s own preferences only; customer facts belong to that org. After work on one customer, write one org-owned work_summary citing the Breeze records touched.',
      input_schema: inputSchemaFor(rememberShape),
    },
    handler: rememberHandler,
  });

  aiTools.set('confirm_memory', {
    // Tier 3 like operator_plan (the HUMAN_ONLY precedent): a flat Tier 3 tool is
    // wholly gated over the external MCP server, so tools/list never advertises a
    // tool no API key could call (it carries no wispGrant and is not a user_session).
    tier: 3,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'confirm a Wisp memory block as correct',
    definition: {
      name: 'confirm_memory',
      description: `Mark an unconfirmed Wisp memory block confirmed. A retracted block cannot be confirmed. ${HUMAN_ONLY_NOTE}`,
      input_schema: inputSchemaFor(memoryBlockIdShape),
    },
    handler: humanChangeHandler(confirmBlock, 'confirmed'),
  });

  aiTools.set('retract_memory', {
    // Tier 3 like operator_plan (the HUMAN_ONLY precedent): a flat Tier 3 tool is
    // wholly gated over the external MCP server, so tools/list never advertises a
    // tool no API key could call (it carries no wispGrant and is not a user_session).
    tier: 3,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'retract a wrong or outdated Wisp memory block',
    definition: {
      name: 'retract_memory',
      description: `Retract a Wisp memory block so it is never recalled again. ${HUMAN_ONLY_NOTE}`,
      input_schema: inputSchemaFor(memoryBlockIdShape),
    },
    handler: humanChangeHandler(retractBlock, 'retracted'),
  });
}
