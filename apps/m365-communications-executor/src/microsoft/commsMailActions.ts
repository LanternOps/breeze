import {
  M365_COMMS_ACTION_FIELDS,
  M365_COMMS_ATTACHMENT_FIELDS,
  M365_COMMS_MAX_RETRIEVED_BODY_BYTES,
  m365CommsFailureCodeSchema,
  type M365CommsInlineAction,
  type M365CommsMailFolder,
  type M365CommsResult,
} from '@breeze/shared/m365';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './delegatedClient';

export interface GraphCommsActionContext {
  accessToken: OpaqueAccessToken;
  graphClient: MicrosoftGraphClient;
  now?: () => Date;
}

const FOLDER_PATHS: Record<M365CommsMailFolder, string> = {
  inbox: 'inbox', sentitems: 'sentitems', drafts: 'drafts', archive: 'archive',
};

/** Strips every non-allowlisted field — a Graph response smuggling extra
 *  fields (internetMessageHeaders, …) comes back without them. */
function project(item: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (field in item) out[field] = item[field];
  return out;
}

function projectAttachments(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((attachment) =>
    attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment)
      ? project(attachment as Record<string, unknown>, M365_COMMS_ATTACHMENT_FIELDS)
      : attachment);
}

/**
 * Caps `body.content` at M365_COMMS_MAX_RETRIEVED_BODY_BYTES measured in
 * UTF-8 BYTES; on truncation, cuts at a code-point boundary and sets
 * `truncated`. HTML bodies pass through as text (`body.contentType` reported
 * as Graph returned it; content is not sanitized — the API/UI layer owns
 * rendering).
 */
function projectMessageWithBodyCap(
  resource: Record<string, unknown>,
  fields: readonly string[],
): { projected: Record<string, unknown>; truncated: boolean } {
  const projected = project(resource, fields);
  if ('attachments' in projected) {
    projected.attachments = projectAttachments(projected.attachments);
  }
  let truncated = false;
  const body = projected.body;
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const bodyRecord = { ...(body as Record<string, unknown>) };
    const content = bodyRecord.content;
    if (typeof content === 'string') {
      const encoder = new TextEncoder();
      if (encoder.encode(content).byteLength > M365_COMMS_MAX_RETRIEVED_BODY_BYTES) {
        let kept = '';
        let bytes = 0;
        for (const codePoint of content) {
          const size = encoder.encode(codePoint).byteLength;
          if (bytes + size > M365_COMMS_MAX_RETRIEVED_BODY_BYTES) break;
          kept += codePoint;
          bytes += size;
        }
        bodyRecord.content = kept;
        truncated = true;
      }
    }
    projected.body = bodyRecord;
  }
  return { projected, truncated };
}

/**
 * `graph_not_found` on a mail.get is the comms taxonomy's `message_not_found`;
 * other Graph codes pass through where the comms enum carries them, and the
 * caller-facing enum's gaps (graph_request_invalid, graph_provider_rejected)
 * fold into graph_response_invalid — the read executor's precedent.
 * `graph_throttled` keeps retryAfterSeconds. Non-Graph errors re-throw and
 * surface as the app's 500 — never a fabricated failure result.
 */
function mapGraphFailure(error: unknown, actionType: M365CommsInlineAction['type']): M365CommsResult {
  if (!(error instanceof GraphClientError)) throw error;
  const translated = error.code === 'graph_not_found' && actionType === 'm365.comms.mail.get'
    ? 'message_not_found'
    : error.code;
  const parsed = m365CommsFailureCodeSchema.safeParse(translated);
  const errorCode = parsed.success ? parsed.data : 'graph_response_invalid' as const;
  return error.retryAfterSeconds === undefined
    ? { success: false, errorCode }
    : { success: false, errorCode, retryAfterSeconds: error.retryAfterSeconds };
}

function sinceIso(sinceHours: number, ctx: GraphCommsActionContext): string {
  const now = ctx.now?.() ?? new Date();
  return new Date(now.getTime() - sinceHours * 60 * 60 * 1_000).toISOString();
}

export async function executeGraphCommsInlineAction(
  action: M365CommsInlineAction,
  ctx: GraphCommsActionContext,
): Promise<M365CommsResult> {
  try {
    switch (action.type) {
      case 'm365.comms.mail.list': {
        const fields = M365_COMMS_ACTION_FIELDS['m365.comms.mail.list'];
        const query: Record<string, string> = {
          $select: fields.join(','),
          $top: String(action.pageSize ?? 25),
        };
        if (action.search !== undefined) {
          // $search excludes $orderby and $filter at Graph; the schema already
          // refuses search+sinceHours, and we drop $orderby here for the same
          // reason (Graph orders $search results by relevance).
          query.$search = `"${action.search}"`;
        } else {
          query.$orderby = 'receivedDateTime desc';
          if (action.sinceHours !== undefined) {
            query.$filter = `receivedDateTime ge ${sinceIso(action.sinceHours, ctx)}`;
          }
        }
        const { items, truncated } = await ctx.graphClient.readCollection({
          accessToken: ctx.accessToken,
          path: `/me/mailFolders/${FOLDER_PATHS[action.folder]}/messages`,
          query,
          maxItems: action.pageSize ?? 25,
          maxPages: 1,
        });
        return { success: true, kind: 'collection', items: items.map((item) => project(item, fields)), truncated };
      }
      case 'm365.comms.mail.get': {
        const fields = M365_COMMS_ACTION_FIELDS['m365.comms.mail.get'];
        const resource = await ctx.graphClient.readResource({
          accessToken: ctx.accessToken,
          path: `/me/messages/${encodeURIComponent(action.messageId)}`,
          select: fields.filter((field) => field !== 'attachments'),
          expand: `attachments($select=${M365_COMMS_ATTACHMENT_FIELDS.join(',')})`,
        });
        const { projected, truncated } = projectMessageWithBodyCap(resource, fields);
        return { success: true, kind: 'resource', resource: projected, truncated };
      }
      case 'm365.comms.mail.draft.create': {
        const created = await ctx.graphClient.post({
          accessToken: ctx.accessToken,
          path: '/me/messages',
          body: {
            subject: action.subject,
            body: { contentType: 'Text', content: action.bodyText },
            toRecipients: action.to.map((address) => ({ emailAddress: { address } })),
            ccRecipients: (action.cc ?? []).map((address) => ({ emailAddress: { address } })),
          },
        });
        const body = created.body;
        const record = body !== null && typeof body === 'object' && !Array.isArray(body)
          ? body as Record<string, unknown>
          : {};
        return {
          success: true,
          kind: 'resource',
          resource: project(record, M365_COMMS_ACTION_FIELDS['m365.comms.mail.draft.create']),
        };
      }
      default: {
        const exhaustive: never = action;
        throw new Error(`unhandled comms action ${String(exhaustive)}`);
      }
    }
  } catch (error) {
    return mapGraphFailure(error, action.type);
  }
}
