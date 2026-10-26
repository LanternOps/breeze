/**
 * Shared helpers for the W06 PSA configuration + ticket-ops tools
 * (full-control W06, #6776): `manage_ticket_config`,
 * `manage_ticket_checklist_templates`, `manage_ticket_inbox`,
 * `manage_ticket_attachments`, `manage_ticket_forms`,
 * `manage_ticket_response_templates`, `manage_time_suggestions`.
 *
 * Deliberately thin and import-light: the handler files import the db graph
 * lazily, this module does not.
 */
import type { ZodError, ZodType } from 'zod';
import type { AuthContext } from '../middleware/auth';
import { isAutomationPrincipal } from '../middleware/principalKind';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { getUserPermissions, hasPermission } from './permissions';

export const json = (value: unknown): string => JSON.stringify(value);

export function jsonError(error: string, code?: string): string {
  return JSON.stringify(code ? { error, code } : { error });
}

/**
 * True when the call is a machine principal — an autonomous `ai_agent` or a
 * `flow` run (#5219) — whose user id is not a `users` row, so a W06 write has
 * no human to attribute.
 */
export function isAgentPrincipal(auth: Pick<AuthContext, 'principal'>): boolean {
  return isAutomationPrincipal(auth);
}

/**
 * The refusal an `ai_agent` principal gets on a W06 write (W06-D8). Same
 * `{ error, action }` shape as `refuseAgentPrincipal` in aiToolsTicketing, with
 * NO `success` key so the SDK classifier records it as a tool error.
 */
export function agentRefusal(action: string): string {
  return JSON.stringify({ error: 'agent_principal_unsupported_action', action });
}

/** The routes behind these tools are `requireScope('partner','system')`; an org token is refused up front. */
export function partnerScopeRequiredError(): string {
  return jsonError('This action requires a partner or system token', 'PARTNER_SCOPE_REQUIRED');
}

export function isPartnerOrSystem(auth: Pick<AuthContext, 'scope'>): boolean {
  return auth.scope === 'partner' || auth.scope === 'system';
}

/** Partner-wide state needs full partner org access (`canManagePartnerWidePolicies`). */
export function partnerWideDeniedError(): string {
  return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
}

/**
 * `adminMiddleware` of routes/ticketConfig.ts, as a predicate: full partner
 * access AND (platform admin OR a wildcard `*:*` grant). `tickets:write` alone
 * is not enough for statuses, priorities, inbound domains or the email-inbound
 * queue. `TOOL_PERMISSIONS` cannot express this, so the handler applies it.
 * Returns an error JSON string to return, or null when the caller passes.
 */
export async function ticketConfigAdminDenied(auth: AuthContext): Promise<string | null> {
  if (!canManagePartnerWidePolicies(auth)) return partnerWideDeniedError();
  if (auth.user.isPlatformAdmin) return null;
  const perms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  });
  if (perms && hasPermission(perms, '*', '*')) return null;
  return jsonError('Managing ticket configuration requires an admin role', 'ACCESS_DENIED');
}

/** A partner id is required for every partner-keyed table; system callers must carry one too. */
export function partnerIdOrError(auth: Pick<AuthContext, 'partnerId'>): { partnerId: string } | { error: string } {
  return auth.partnerId
    ? { partnerId: auth.partnerId }
    : { error: jsonError('Partner context required', 'ACCESS_DENIED') };
}

/** First Zod issue, with its path, as one sentence the model can act on. */
export function zodMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid input';
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

/** Validate `data` with the SAME shared schema the REST route uses; a failure is a tool error JSON. */
export function parseData<T>(schema: ZodType<T>, data: unknown): { value: T } | { error: string } {
  const parsed = schema.safeParse(data ?? {});
  return parsed.success
    ? { value: parsed.data }
    : { error: jsonError(zodMessage(parsed.error), 'VALIDATION_ERROR') };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map a service refusal onto a tool error. Structural on purpose (name +
 * status/code), so it survives module mocking in tests and covers every W06
 * service error class without importing the db graph: TicketConfigServiceError,
 * TicketFormError, ChecklistTemplateServiceError, TicketServiceError,
 * TimeEntryServiceError, PartnerWideWriteDeniedError, TicketMergedError.
 * Returns null for anything else (the caller rethrows).
 */
export function serviceErrorJson(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; details?: unknown; mergedIntoTicketId?: unknown };
  if (e.name === 'PartnerWideWriteDeniedError') return partnerWideDeniedError();
  const known = new Set([
    'TicketConfigServiceError', 'TicketFormError', 'ChecklistTemplateServiceError',
    'TicketServiceError', 'TimeEntryServiceError', 'TicketMergedError',
  ]);
  if (typeof e.name !== 'string' || !known.has(e.name)) return null;
  return json({
    error: typeof e.message === 'string' ? e.message : 'Request refused',
    ...(typeof e.code === 'string' ? { code: e.code } : {}),
    ...(e.details !== undefined ? { details: e.details } : {}),
    ...(typeof e.mergedIntoTicketId === 'string' ? { mergedIntoTicketId: e.mergedIntoTicketId } : {}),
  });
}

/** Page window over an in-memory list (config lists are small and partner-bounded). */
export const LIST_PAGE = { defaultLimit: 50, maxLimit: 200 } as const;
