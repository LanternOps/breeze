/**
 * Wisp W08 Task 5 — the two thread-link chat tools (w00 A35, Review Focus 3).
 *
 *   link_entity  (T2)  link one Breeze object to the grant's thread (auto-executes
 *                      with an audit row and no approval card, like
 *                      `raise_concern` and `remember`; rate limited)
 *   list_links   (T1)  the objects linked to the grant's thread that this
 *                      caller and grant can see right now
 *
 * Both refuse without `auth.wispGrant` (`wisp_grant_required`, as the W05a
 * concern tools): an ordinary chat, an MCP key or an `ai_agent` principal
 * without a stamped grant reads and writes nothing. Exposure is dark too: with
 * `wispEnabled()` off neither is declared to chat (`wispLinkToolDefinitions`)
 * nor listed or callable over Breeze's MCP server (`isToolEnvGatedOff`).
 *
 * Every link goes through `services/wisp/threadLinks.ts` → `resolveEntityRef`:
 * the object is read first and its org taken FROM THE OBJECT; the model's
 * `orgId` is only a lookup hint and a mismatch is `not_found` (nothing is
 * written). The model's `label` is ignored — the label is always the
 * object's own, re-resolved on every read. Labels and statuses are tenant
 * text, so each is sanitized and the result rides one untrusted-data fence.
 *
 * The per-call ceiling gate (tool allowlist, denied tools, permission) is W04's
 * `createSessionPreToolUse`, which runs before any handler; it is not repeated.
 */
import { z } from 'zod';
import { linkEntitySchema, WISP_THREAD_LINK_LIMIT, type WispThreadLink } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { sanitizeUntrustedToolText, wrapUntrustedData } from '../aiInputSanitizer';
import type { AiTool } from '../aiTools';
import { linkEntityShape, listLinksInputSchema, listLinksShape } from '../aiToolSchemas';
import { captureException } from '../sentry';
import { GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import { addLink, listLinks, ThreadLinkError } from './threadLinks';
import { getOrCreateThread } from './threads';

/**
 * The parse schemas, by tool name — the shared validators, never a re-typed
 * copy (list_links extends the shared empty object with an output `limit`).
 */
export const WISP_LINK_TOOL_SCHEMAS = {
  link_entity: linkEntitySchema,
  list_links: listLinksInputSchema,
} as const;

type Handler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

const GRANT_REQUIRED = JSON.stringify({ error: 'wisp_grant_required' });
const FENCE_SOURCE = 'wisp_thread_links';

function inputSchemaFor(shape: z.ZodRawShape): AiTool['definition']['input_schema'] {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
  return schema as AiTool['definition']['input_schema'];
}

function invalid(error: z.ZodError): string {
  const message = error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  return JSON.stringify({ error: 'invalid_input', message });
}

/**
 * Typed refusals → model-facing JSON. Anything else is a real failure and
 * propagates to the dispatcher (which sanitizes it) — never swallowed into a
 * success-shaped string.
 */
function mapServiceError(err: unknown): string {
  if (err instanceof ThreadLinkError) return JSON.stringify({ refused: err.code });
  if (err instanceof GrantInactiveError) {
    if (err.kind === 'corrupt') {
      captureException(err, undefined, { grantId: err.grantId, op: 'wisp.link_tool' });
      return JSON.stringify({ error: 'grant_corrupt' });
    }
    return JSON.stringify({ error: 'grant_inactive' });
  }
  throw err;
}

/**
 * Grant check → parse → ceiling → body. The grant check comes first so a
 * grantless caller learns nothing about input shape and nothing is read.
 */
function grantTool<S extends z.ZodType>(
  schema: S,
  body: (input: z.infer<S>, ceiling: GrantCeiling, auth: AuthContext) => Promise<string>,
): Handler {
  return async (input, auth) => {
    const grant = auth.wispGrant;
    if (!grant) return GRANT_REQUIRED;
    const parsed = schema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
      const ceiling = await resolveGrantCeiling(grant.grantId, grant.grantRevisionId);
      return await body(parsed.data, ceiling, auth);
    } catch (err) {
      return mapServiceError(err);
    }
  };
}

/** The model-facing projection of a link: by handle, tenant text sanitized. */
function toolView(link: WispThreadLink) {
  return {
    kind: link.ref.kind,
    id: link.ref.id,
    orgId: link.ref.orgId,
    label: sanitizeUntrustedToolText(link.label),
    status: link.status === null ? null : sanitizeUntrustedToolText(link.status),
    href: link.href,
    source: link.source,
    lastTouchedAt: link.lastTouchedAt,
  };
}

const fenced = (payload: unknown) => wrapUntrustedData(FENCE_SOURCE, JSON.stringify(payload));

const linkEntityHandler = grantTool(linkEntitySchema, async (input, ceiling, auth) => {
  const thread = await getOrCreateThread(ceiling.grantId);
  // `label` is deliberately dropped: the label is always the object's own.
  const ref = {
    kind: input.kind,
    id: input.id,
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
  };
  const link = await addLink({ auth, ceiling }, thread.id, ref, { source: 'wisp_pin', addedByGrantId: ceiling.grantId });
  return fenced({ linked: true, link: toolView(link) });
});

const listLinksHandler = grantTool(listLinksInputSchema, async (input, ceiling, auth) => {
  const thread = await getOrCreateThread(ceiling.grantId);
  // listLinks re-resolves every row (newest first) and already caps at the
  // per-thread limit; `limit` only trims the page the model reads.
  const rows = await listLinks({ auth, ceiling }, thread.id);
  const page = rows.slice(0, input.limit ?? WISP_THREAD_LINK_LIMIT);
  const held = rows.length - page.length;
  return fenced({ links: page.map(toolView), ...(held > 0 ? { more: held } : {}) });
});

export function registerWispLinkTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('link_entity', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'pin a ticket, quote, invoice, contract, device, organization, site, alert, run, task or user to the Wisp thread',
    definition: {
      name: 'link_entity',
      description: 'Link one Breeze object (ticket, quote, invoice, contract, device, org, site, alert, run, task, user) to this Wisp thread so it stays in view. The org is read from the object; a wrong orgId hint links nothing. The label input is ignored.',
      input_schema: inputSchemaFor(linkEntityShape),
    },
    handler: linkEntityHandler,
  });

  aiTools.set('list_links', {
    tier: 1,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'objects linked to the Wisp thread: pinned tickets, devices, quotes, customers',
    definition: {
      name: 'list_links',
      description: 'List the Breeze objects linked to this Wisp thread that you can still see, newest first: kind, id, org, current label, status and page link. Call the object\'s own read tool for detail.',
      input_schema: inputSchemaFor(listLinksShape),
    },
    handler: listLinksHandler,
  });
}
