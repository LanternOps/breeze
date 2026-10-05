/**
 * Model pickers (AI model registry W05, #7603): the chat composer's menu and
 * the agent-policy form's model list. USER-scoped — deliberately not W04's
 * `partnerRead` (billing:manage); a tech who may chat may see what they may
 * pick. Read-only and a convenience: the turn claim (resolveModel) and the
 * agent write (bindAgentOffering) re-check everything.
 *
 * Self-managed DB context (selfManagedDbContextRoutes.ts): listModelChoices
 * reads through the loader's own short system transactions, which must never
 * run beside a held request transaction (#1105 / #2417 double-hold). The one
 * caller-scoped read (the owner-bound session) gets its own short context.
 *
 * Tenancy: an org-scope token reaches only its own org (`canAccessOrg`); a
 * partner-scope token only orgs of its own partner (`canAccessOrg` plus the
 * org's partner must equal the token's); a session only when the caller owns
 * it (`getSession` is owner-bound and org-conditioned). Every miss is an
 * opaque 404.
 */
import { Hono, type Context } from 'hono';
import {
  PERMISSION_GRANTS,
  agentModelChoicesQuerySchema,
  chatModelChoicesQuerySchema,
  type AiModelChoicesDto,
  type OfferingOptions,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope, withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { getSession } from '../../services/aiAgent';
import { readOrgPartnerId } from '../../services/aiModels/candidateLoader';
import { listModelChoices } from '../../services/aiModels/modelChoices';
import { LlmUnavailableError } from '../../services/llm/llmUnavailableError';

export const aiModelChoiceRoutes = new Hono();

const NOT_FOUND = { error: 'Not found' } as const;

/** The org's partner, or null when the caller may not see it (opaque 404). */
async function partnerFor(auth: AuthContext, orgId: string): Promise<string | null> {
  const partnerId = await readOrgPartnerId(orgId);
  if (!partnerId) return null;
  if (auth.scope === 'partner' && auth.partnerId !== partnerId) return null;
  return partnerId;
}

async function respond(c: Context, load: () => Promise<AiModelChoicesDto>): Promise<Response> {
  try {
    return c.json({ data: await load() });
  } catch (err) {
    if (err instanceof LlmUnavailableError) return c.json({ error: err.message, code: 'registry_unavailable' }, 503);
    throw err;
  }
}

aiModelChoiceRoutes.get(
  '/chat',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSION_GRANTS.AI_SESSIONS_USE.resource, PERMISSION_GRANTS.AI_SESSIONS_USE.action),
  zValidator('query', chatModelChoicesQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const q = c.req.valid('query');
    let orgId: string;
    let current: AiModelChoicesDto['current'] = null;
    if (q.sessionId) {
      const sessionId = q.sessionId;
      const session = await withAuthDbAccessContext(auth, () => getSession(sessionId, auth));
      if (!session) return c.json(NOT_FOUND, 404);
      orgId = session.orgId;
      // The session's STAMPED choice (stampSessionBinding): the offering and
      // the APPLIED options the last turn ran with — the fallen-back default
      // when that turn fell back. The composer starts from it.
      current = { offeringId: session.offeringId ?? null, options: (session.options as OfferingOptions | null) ?? null };
    } else {
      const candidate = q.orgId ?? auth.orgId ?? null;
      if (!candidate) return c.json({ error: 'Organization context required' }, 400);
      if (!auth.canAccessOrg(candidate)) return c.json(NOT_FOUND, 404);
      orgId = candidate;
    }
    const partnerId = await partnerFor(auth, orgId);
    if (!partnerId) return c.json(NOT_FOUND, 404);
    return respond(c, () => listModelChoices({ partnerId, orgId, userId: auth.user.id, surface: 'chat', current }));
  },
);

aiModelChoiceRoutes.get(
  '/ai-agents',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSION_GRANTS.AI_AGENTS_READ.resource, PERMISSION_GRANTS.AI_AGENTS_READ.action),
  zValidator('query', agentModelChoicesQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const q = c.req.valid('query');
    // userId = the caller: an agent run skips required_permission, so the
    // WRITER is who must hold it (bindAgentOffering) — the picker shows the
    // offerings this writer may bind, permission-gated ones disabled.
    if (!q.orgId) {
      // A partner-wide agent: only a partner-scope caller can own one.
      if (auth.scope !== 'partner' || !auth.partnerId) return c.json({ error: 'orgId is required' }, 400);
      const partnerId = auth.partnerId;
      return respond(c, () => listModelChoices({ partnerId, orgId: null, userId: auth.user.id, surface: 'ai_agents' }));
    }
    const orgId = q.orgId;
    if (!auth.canAccessOrg(orgId)) return c.json(NOT_FOUND, 404);
    const partnerId = await partnerFor(auth, orgId);
    if (!partnerId) return c.json(NOT_FOUND, 404);
    return respond(c, () => listModelChoices({ partnerId, orgId, userId: auth.user.id, surface: 'ai_agents' }));
  },
);
