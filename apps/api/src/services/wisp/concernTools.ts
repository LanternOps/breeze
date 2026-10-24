/**
 * Wisp W05a — the five concern/watch chat tools (Wisp design §7.4 reply in
 * thread, §6.1 (4) pending items from conversation, §14; w00 A25, A35).
 *
 *   list_concerns    (T1)  the concerns this grant's ceiling covers
 *   raise_concern    (T2)  note a loose end for one customer (auto-approved, like `remember`)
 *   snooze_concern   (T2)  quiet one concern for this grant, up to 30 days
 *   resolve_concern  (T2)  close one concern; the outcome is remembered
 *   create_watch     (T2)  ask Wisp to check something on a cadence
 *
 * Every tool refuses without `auth.wispGrant` (W04 sets it for a chat turn
 * under a grant). An ordinary chat, an MCP key, or an `ai_agent` principal
 * without a stamped grant gets `wisp_grant_required` and nothing runs.
 * Exposure is dark too: with `wispEnabled()` off none of the five is declared
 * to chat (`wispConcernToolDefinitions`) or listed or callable over Breeze's
 * MCP server (`isToolEnvGatedOff`). The assessment run's outcome tools
 * (`record_concern`, `update_concern`, `nudge`, …) are W05b's, not these.
 *
 * The per-call ceiling gate (`assertToolCallWithinCeiling`: tool allowlist,
 * denied tools, permission) is NOT repeated here — it is W04's
 * `createSessionPreToolUse` (w00 A14), which runs before any handler. These
 * handlers enforce only what is specific to concerns: the services filter
 * every read by the ceiling, `raise_concern` checks the org against the
 * ceiling and the subject against the org before writing, and a snooze or
 * resolve first confirms the concern is visible to this grant.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  createWatchInputSchema,
  raiseConcernChatSchema,
  resolveConcernToolSchema,
  snoozeConcernToolSchema,
  type ChatRaiseConcernSubjectKind,
  type Concern,
} from '@breeze/shared';
import { db } from '../../db';
import { contracts, devices, invoices, quotes, tickets } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { sanitizeUntrustedToolText, wrapUntrustedData } from '../aiInputSanitizer';
import type { AiTool } from '../aiTools';
import { captureException } from '../sentry';
import {
  createWatchShape,
  LIST_CONCERNS_DEFAULT_LIMIT,
  listConcernsInputSchema,
  listConcernsShape,
  raiseConcernShape,
  resolveConcernShape,
  snoozeConcernShape,
} from '../aiToolSchemas';
import {
  ConcernNotFoundError,
  getConcernForCeiling,
  listConcernsForCeiling,
  markAnswered,
  resolveConcern,
  snoozeConcern,
  upsertConcern,
} from './concerns';
import {
  assertWithinCeiling,
  CeilingViolationError,
  GrantInactiveError,
  inSystemContext,
  resolveGrantCeiling,
  type GrantCeiling,
} from './grantAuthority';
import { createWatch, WatchLimitReachedError } from './watches';

/**
 * The parse schemas, by tool name — the shared validators, never a re-typed
 * copy (list_concerns extends the shared filter with an output `limit`).
 */
export const WISP_CONCERN_TOOL_SCHEMAS = {
  list_concerns: listConcernsInputSchema,
  raise_concern: raiseConcernChatSchema,
  snooze_concern: snoozeConcernToolSchema,
  resolve_concern: resolveConcernToolSchema,
  create_watch: createWatchInputSchema,
} as const;

type WispGrantRef = NonNullable<AuthContext['wispGrant']>;
type Handler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

const GRANT_REQUIRED = JSON.stringify({ error: 'wisp_grant_required' });
const CONCERN_NOT_FOUND = JSON.stringify({ error: 'concern_not_found' });

function inputSchemaFor(shape: z.ZodRawShape): AiTool['definition']['input_schema'] {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
  return schema as AiTool['definition']['input_schema'];
}

function invalid(error: z.ZodError): string {
  const message = error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  return JSON.stringify({ error: 'invalid_input', message });
}

/**
 * Map the services' typed refusals to model-facing JSON. Anything else is a
 * real failure and propagates to the dispatcher (which sanitizes it) — never
 * swallowed into a success-shaped string.
 */
function mapServiceError(err: unknown): string {
  if (err instanceof GrantInactiveError) {
    // A corrupt pin is data damage, not a pause: surface it (the routes do the same).
    if (err.kind === 'corrupt') {
      captureException(err, undefined, { grantId: err.grantId, op: 'wisp.concern_tool' });
      return JSON.stringify({ error: 'grant_corrupt' });
    }
    return JSON.stringify({ error: 'grant_inactive' });
  }
  if (err instanceof CeilingViolationError) return JSON.stringify({ error: 'ceiling_violation', code: err.code });
  if (err instanceof ConcernNotFoundError) return CONCERN_NOT_FOUND;
  if (err instanceof WatchLimitReachedError) return JSON.stringify({ error: 'watch_limit_reached' });
  throw err;
}

const isLive = (c: Concern) => c.status === 'open' || c.status === 'snoozed';
const notLive = (c: Concern) => JSON.stringify({ error: 'concern_not_live', status: c.status });

function ceilingFor(grant: WispGrantRef): Promise<GrantCeiling> {
  return resolveGrantCeiling(grant.grantId, grant.grantRevisionId);
}

/**
 * Grant check → parse → ceiling → body, with the shared error mapping. The
 * grant check comes first so a grantless caller learns nothing about input
 * shape and nothing is read.
 */
function grantTool<S extends z.ZodType>(
  schema: S,
  body: (input: z.infer<S>, ceiling: GrantCeiling) => Promise<string>,
): Handler {
  return async (input, auth) => {
    const grant = auth.wispGrant;
    if (!grant) return GRANT_REQUIRED;
    // Parse (not just validate): zod strips unknown keys, so nothing the model
    // adds (a grantId, a partnerId) reaches a service.
    const parsed = schema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
      return await body(parsed.data, await ceilingFor(grant));
    } catch (err) {
      return mapServiceError(err);
    }
  };
}

// ---------------------------------------------------------------------------
// raise_concern subject verification (w00 A25 + A35)
// ---------------------------------------------------------------------------

type RecordSubjectKind = Exclude<ChatRaiseConcernSubjectKind, 'org'>;

/**
 * Each record kind's `(id, org_id)` read; every table carries a NOT NULL
 * `org_id`. Spelled out per table (not a table map) so each select stays
 * fully typed.
 */
const SUBJECT_IN_ORG: Record<RecordSubjectKind, (id: string, orgId: string) => Promise<unknown[]>> = {
  ticket: (id, orgId) => db.select({ id: tickets.id }).from(tickets)
    .where(and(eq(tickets.id, id), eq(tickets.orgId, orgId))).limit(1),
  quote: (id, orgId) => db.select({ id: quotes.id }).from(quotes)
    .where(and(eq(quotes.id, id), eq(quotes.orgId, orgId))).limit(1),
  invoice: (id, orgId) => db.select({ id: invoices.id }).from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.orgId, orgId))).limit(1),
  contract: (id, orgId) => db.select({ id: contracts.id }).from(contracts)
    .where(and(eq(contracts.id, id), eq(contracts.orgId, orgId))).limit(1),
  device: (id, orgId) => db.select({ id: devices.id }).from(devices)
    .where(and(eq(devices.id, id), eq(devices.orgId, orgId))).limit(1),
};

/**
 * True when the record exists AND belongs to `orgId`. Read in system context:
 * the org is already inside the ceiling, and the `(id, org_id)` predicate is
 * what keeps a record of another customer (or another partner) out.
 */
async function subjectBelongsToOrg(kind: RecordSubjectKind, id: string, orgId: string): Promise<boolean> {
  const rows = await inSystemContext(() => SUBJECT_IN_ORG[kind](id, orgId));
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * One line per concern. Summaries are written by models and people, so each
 * is sanitized and the whole list rides one untrusted-data fence (the
 * renderMemoryForPrompt precedent).
 */
function renderConcerns(rows: Concern[]): string {
  const lines = rows.map((c) => {
    const parts = [
      c.id,
      c.severity,
      c.status,
      `${c.subject.kind}:${c.subject.id}`,
      sanitizeUntrustedToolText(c.summary.replace(/\s+/g, ' ')),
    ];
    if (c.recipient?.snoozedUntil) parts.push(`quiet until ${c.recipient.snoozedUntil}`);
    if (c.recipient?.digestOnly) parts.push('digest only');
    return parts.join(' | ');
  });
  return wrapUntrustedData('wisp_concerns', lines.join('\n'));
}

const listConcernsHandler = grantTool(listConcernsInputSchema, async (q, ceiling) => {
  const rows = await listConcernsForCeiling(ceiling, { status: q.status, orgId: q.orgId });
  if (rows.length === 0) return "No concerns on Wisp's radar.";
  // The service orders highest severity first, so a short page keeps what matters.
  const page = rows.slice(0, q.limit ?? LIST_CONCERNS_DEFAULT_LIMIT);
  const hidden = rows.length - page.length;
  const more = hidden > 0 ? `\n(${hidden} more; raise limit or filter by orgId or status.)` : '';
  return renderConcerns(page) + more;
});

const raiseConcernHandler = grantTool(raiseConcernChatSchema, async (input, ceiling) => {
  // Ceiling first: an out-of-ceiling org reads and writes nothing.
  assertWithinCeiling(ceiling, { orgId: input.orgId });
  const { subject } = input;
  if (subject.kind === 'org') {
    if (subject.id !== input.orgId) return JSON.stringify({ error: 'subject_org_mismatch' });
  } else if (!(await subjectBelongsToOrg(subject.kind, subject.id, input.orgId))) {
    return JSON.stringify({ error: 'subject_not_in_org' });
  }
  const { id, created } = await upsertConcern({
    partnerId: ceiling.partnerId,
    orgId: input.orgId,
    subject,
    summary: input.summary,
    severity: input.severity,
    evidence: input.evidence ?? {},
    raisedByGrantId: ceiling.grantId,
  });
  return created
    ? `Concern raised (ID: ${id}).`
    : `Already on Wisp's radar (ID: ${id}) — use resolve_concern or snooze_concern.`;
});

const snoozeConcernHandler = grantTool(snoozeConcernToolSchema, async (input, ceiling) => {
  // Existence-neutral: not found and not visible to this grant read the same.
  const visible = await getConcernForCeiling(ceiling, input.concernId);
  if (!visible) return CONCERN_NOT_FOUND;
  if (!isLive(visible)) return notLive(visible);
  const until = new Date(input.until);
  await snoozeConcern(visible.id, { grantId: ceiling.grantId, userId: ceiling.grantorUserId }, until);
  await markAnswered(visible.id, ceiling.grantId, new Date());
  return `Concern ${visible.id} snoozed for you until ${until.toISOString()}.`;
});

const resolveConcernHandler = grantTool(resolveConcernToolSchema, async (input, ceiling) => {
  const visible = await getConcernForCeiling(ceiling, input.concernId);
  if (!visible) return CONCERN_NOT_FOUND;
  if (!isLive(visible)) return notLive(visible);
  // The grantId form remembers the outcome as a concern_outcome memory block.
  const { resolved, remembered } = await resolveConcern(visible.id, { grantId: ceiling.grantId }, input.outcome);
  // Closed by someone else between the read and the write.
  if (!resolved) return JSON.stringify({ error: 'concern_not_live' });
  await markAnswered(visible.id, ceiling.grantId, new Date());
  return remembered
    ? `Concern ${visible.id} resolved; the outcome is remembered for next time.`
    : `Concern ${visible.id} resolved; the outcome could not be saved to Wisp memory.`;
});

const createWatchHandler = grantTool(createWatchInputSchema, async (input, ceiling) => {
  const watch = await createWatch(ceiling, {
    orgId: input.orgId,
    kind: input.kind,
    params: input.params,
    cadenceMinutes: input.cadenceMinutes,
  });
  return `Watch created (ID: ${watch.id}), first check ${watch.nextDueAt}.`;
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWispConcernTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_concerns', {
    tier: 1,
    domain: 'ai',
    deviceArgs: [],
    searchHint: "what Wisp is tracking: open loose ends, follow-ups and things it will remind you about",
    definition: {
      name: 'list_concerns',
      description: 'List the concerns Wisp is tracking for customers this grant covers (default: open and snoozed), highest severity first: id, severity, status, subject, summary, and when a snooze ends.',
      input_schema: inputSchemaFor(listConcernsShape),
    },
    handler: listConcernsHandler,
  });

  aiTools.set('raise_concern', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'track a loose end or follow-up for a customer: waiting on someone, a ticket, quote or invoice to revisit',
    definition: {
      name: 'raise_concern',
      description: 'Note a loose end for this customer that Wisp should keep tracking and remind you about — something you are waiting on, or a ticket, quote, invoice, contract or device to revisit. Subject is the org or one of its records.',
      input_schema: inputSchemaFor(raiseConcernShape),
    },
    handler: raiseConcernHandler,
  });

  aiTools.set('snooze_concern', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'quiet a Wisp concern or reminder until a later date',
    definition: {
      name: 'snooze_concern',
      description: 'Snooze one Wisp concern for this grant until a time up to 30 days ahead; Wisp stops nudging about it until then.',
      input_schema: inputSchemaFor(snoozeConcernShape),
    },
    handler: snoozeConcernHandler,
  });

  aiTools.set('resolve_concern', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'close a Wisp concern or loose end and record what happened',
    definition: {
      name: 'resolve_concern',
      description: 'Resolve one Wisp concern with a short outcome. Wisp remembers the outcome for that customer.',
      input_schema: inputSchemaFor(resolveConcernShape),
    },
    handler: resolveConcernHandler,
  });

  aiTools.set('create_watch', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'ask Wisp to keep an eye on something: a waiting ticket, alert pattern, backups, patching, security findings',
    definition: {
      name: 'create_watch',
      description: 'Ask Wisp to check something on a cadence (every 15 minutes to 7 days) for one customer, or for every customer on a partner-wide grant, and raise a concern when it needs you.',
      input_schema: inputSchemaFor(createWatchShape),
    },
    handler: createWatchHandler,
  });
}
