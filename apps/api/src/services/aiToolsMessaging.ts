/**
 * AI Endpoint Messaging Tool (#8742 W02)
 *
 * `send_endpoint_message` lets the assistant push a branded message to the
 * person at a device, and read the send history. A thin adapter: `send`
 * delegates to the SAME `executeEndpointMessageSend` the HTTP route and the
 * resend route use, so caps, rate limits, the agent version gate,
 * persistence, audit and the AI-origin stamp are one implementation.
 *
 * Guardrails (aiGuardrails.ts): `send` is ALWAYS Tier 3 (human approval; the
 * text is shown to an end user under the MSP's brand), `list`/`get` are
 * read-only Tier 1.
 */
import { randomUUID } from 'node:crypto';
import { ENDPOINT_MESSAGE_LIMITS, endpointMessageSendSchema } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import { isAiAgentPrincipal } from '../middleware/auth';
import { executeEndpointMessageSend } from '../routes/endpointMessages/send';
import {
  HISTORY_PAGE_MAX,
  decodeHistoryCursor,
  getEndpointMessageDetail,
  listEndpointMessages,
} from './endpointMessaging/history';
import { requestLikeFromSnapshot } from './auditEvents';
import { getUserPermissions, type UserPermissions } from './permissions';
import { hasExactDeviceCeiling } from './siteCeilingAccess';
import type { AiTool, AiToolTier } from './aiTools';

function jsonError(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...extra, error });
}

async function permissionsFor(auth: AuthContext) {
  const userBacked = auth.principal?.kind === 'user_session' || auth.principal?.kind === 'oauth_grant';
  if (!userBacked || auth.user.isPlatformAdmin) return undefined;
  return (await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  })) ?? undefined;
}

/**
 * The caller's SITE ceiling, resolved once per call. The history readers and
 * the send resolver narrow on `allowedSiteIds` (undefined = unrestricted, `[]`
 * = no sites). Loaded permissions exist only for a non-admin user-backed
 * principal; every other caller that reaches this tool (a site-clamped MCP
 * API key) carries its ceiling on `auth.allowedSiteIds` instead, and without
 * this it read every site's message history.
 */
interface SiteScope {
  permissions: UserPermissions | undefined;
  allowedSiteIds: string[] | undefined;
}

async function siteScopeFor(auth: AuthContext): Promise<SiteScope> {
  const permissions = await permissionsFor(auth);
  return { permissions, allowedSiteIds: permissions?.allowedSiteIds ?? auth.allowedSiteIds };
}

/** The history readers' site filter: only `allowedSiteIds` is read. */
function historySiteFilter(scope: SiteScope): Pick<UserPermissions, 'allowedSiteIds'> | undefined {
  return scope.allowedSiteIds === undefined ? undefined : { allowedSiteIds: scope.allowedSiteIds };
}

async function sendAction(input: Record<string, unknown>, auth: AuthContext, scope: SiteScope): Promise<string> {
  // An autonomous agent must never author end-user-visible text under the
  // MSP's brand.
  if (isAiAgentPrincipal(auth)) return jsonError('send_endpoint_message is not available to autonomous agents');
  // Only a human chat session, where every send passes the approval card. An
  // MCP credential (API key or OAuth grant) can be opted into unattended
  // Tier 3 (MCP_UNATTENDED_TIER3_PRINCIPALS), which would skip approval and
  // MFA for text shown to end users; that never applies to this tool.
  if (auth.principal?.kind !== 'user_session') {
    return jsonError('send_endpoint_message is only available in an interactive chat session');
  }
  // Without an origin the persisted row and queued commands would carry no AI
  // attribution (aiDispatch refuses the same way for device work).
  if (!auth.aiOrigin) return jsonError('send_endpoint_message requires an AI session origin');
  // The send resolver narrows on loaded permissions. A site-restricted session
  // whose permissions could not be loaded would resolve targets across every
  // site, so it fails closed.
  if (!scope.permissions && scope.allowedSiteIds !== undefined) {
    return jsonError('send_endpoint_message could not resolve your site access; try again');
  }

  // `confirmedCount` is a human's confirmation of a large send; the model can
  // never supply it. A send resolving above the threshold is refused below and
  // must be made from the console.
  const { action: _action, confirmedCount: _ignored, ...fields } = input;
  const parsed = endpointMessageSendSchema.safeParse({ ...fields, messageId: randomUUID() });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(`Invalid message: ${issue ? `${issue.path.join('.') || 'input'}: ${issue.message}` : 'invalid input'}`);
  }

  try {
    const outcome = await executeEndpointMessageSend(
      {
        req: requestLikeFromSnapshot({ userAgent: 'breeze-ai-tool' }),
        auth,
        permissions: scope.permissions,
      },
      parsed.data,
    );
    if (outcome.status !== 200) {
      const code = typeof outcome.body.error === 'string' ? outcome.body.error : 'send_failed';
      if (code === 'confirmation_required') {
        return jsonError(code, {
          ...outcome.body,
          status: outcome.status,
          message: `This send resolves to more than ${ENDPOINT_MESSAGE_LIMITS.confirmAbove} devices; the assistant cannot confirm that. Narrow the targets or send it from the Messages page.`,
        });
      }
      return jsonError(code, { ...outcome.body, status: outcome.status });
    }
    return JSON.stringify(outcome.body);
  } catch (err) {
    console.error('[send_endpoint_message]', err);
    return jsonError('Operation failed. Check server logs for details.');
  }
}

async function listAction(input: Record<string, unknown>, auth: AuthContext, scope: SiteScope): Promise<string> {
  const orgId = typeof input.orgId === 'string' ? input.orgId : undefined;
  if (orgId && !auth.canAccessOrg(orgId)) return jsonError('Access to this organization denied');
  const cursor = decodeHistoryCursor(typeof input.cursor === 'string' ? input.cursor : undefined);
  if (cursor === 'invalid') return jsonError('invalid_cursor');
  const limit = Math.min(Math.max(1, Number(input.limit) || 50), HISTORY_PAGE_MAX);
  try {
    return JSON.stringify(await listEndpointMessages({ auth, permissions: historySiteFilter(scope), orgId, limit, cursor }));
  } catch (err) {
    console.error('[send_endpoint_message:list]', err);
    return jsonError('Operation failed. Check server logs for details.');
  }
}

async function getAction(input: Record<string, unknown>, auth: AuthContext, scope: SiteScope): Promise<string> {
  if (typeof input.messageId !== 'string') return jsonError('messageId is required for get');
  try {
    const detail = await getEndpointMessageDetail({
      auth,
      permissions: historySiteFilter(scope),
      messageRowId: input.messageId,
    });
    return detail ? JSON.stringify(detail) : jsonError('not_found');
  } catch (err) {
    console.error('[send_endpoint_message:get]', err);
    return jsonError('Operation failed. Check server logs for details.');
  }
}

export function registerMessagingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('send_endpoint_message', {
    // Base tier 3: `send` is customer-visible and always needs human approval.
    // list/get are downgraded to Tier 1 in aiGuardrails (TIER1_ACTIONS).
    tier: 3 as AiToolTier,
    domain: 'tickets',
    searchHint: 'send a message or notice to a user at their computer, endpoint pop-up, announcement; message history',
    deviceArgs: [],
    definition: {
      name: 'send_endpoint_message',
      description:
        'Show a message card to the person at up to 100 devices. send always needs approval; list/get read history. Actions: send,list,get.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['send', 'list', 'get'], description: 'send (needs approval), list history, get one message' },
          targets: {
            type: 'object',
            description: 'send: at least one of deviceIds, siteIds, deviceGroupIds, orgId',
            properties: {
              deviceIds: { type: 'array', items: { type: 'string' } },
              siteIds: { type: 'array', items: { type: 'string' } },
              deviceGroupIds: { type: 'array', items: { type: 'string' } },
              orgId: { type: 'string' },
            },
          },
          title: { type: 'string', description: 'send: card title (max 120)' },
          body: { type: 'string', description: 'send: plain text or limited markdown, https links only (max 2000)' },
          severity: { type: 'string', enum: ['info', 'warning', 'critical'], description: 'send: card severity' },
          requiresAck: { type: 'boolean', description: 'send: require the user to acknowledge' },
          expiresInMinutes: { type: 'number', description: 'send: lifetime in minutes (default 1440, max 10080; null = until closed)' },
          orgId: { type: 'string', description: 'list: filter to one organization' },
          limit: { type: 'number', description: 'Max messages to return (default 50, max 100)' },
          cursor: { type: 'string', description: 'list: cursor from the previous page' },
          messageId: { type: 'string', description: 'get: message UUID from list' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      // Device axis: every action spans devices (a send fans out, history lists
      // deliveries across the fleet), so an exact-device ceiling cannot be
      // narrowed to and fails closed. Only an AI agent run carries one, and
      // AGENT_HUMAN_ONLY_TOOLS already keeps the tool from those; this holds if
      // that registry ever changes.
      if (hasExactDeviceCeiling(auth)) {
        return jsonError('send_endpoint_message is not available to a device-scoped caller');
      }
      let scope: SiteScope;
      try {
        scope = await siteScopeFor(auth);
      } catch (err) {
        console.error('[send_endpoint_message:scope]', err);
        return jsonError('Operation failed. Check server logs for details.');
      }
      switch (input.action) {
        case 'send': return sendAction(input, auth, scope);
        case 'list': return listAction(input, auth, scope);
        case 'get': return getAction(input, auth, scope);
        default: return jsonError('Unknown action. Use send, list or get.');
      }
    },
  });
}
