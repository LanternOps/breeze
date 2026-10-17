// Owner: W02g (partner-wide trust page template), mounted at /trust-page-template.
// Trust Center W2 (#8770, spec §18.8, §19 item 33). The partner's own default for every inheritable trust page
// setting: an org page inherits it wherever its own value is NULL, and publish freezes the resolved values.
// Reads: partner scope (its own partner) or system scope with ?partnerId=. Writes additionally need full partner
// org access (canManagePartnerWidePolicies — the template reaches every org, including future ones) and MFA.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { partners } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { writeRouteAudit } from '../services/auditEvents';
import { loadPartnerTemplate, savePartnerTemplate, type PartnerTemplatePatch } from '../services/trustPage/template';
import { sanitizeIntro } from '../services/trustPage/payloadBuilder';
import { defaultFrameworkView, frameworkOptionsFor } from '../services/trustPage/sections/frameworks';
import { TRUST_BUILTIN_DEFAULTS, TRUST_INTRO_STORED_MAX_CHARS, trustTemplateUpdateSchema } from '@breeze/shared';

export const trustPageTemplateRoutes = new Hono();
trustPageTemplateRoutes.use('*', authMiddleware);

const scopes = requireScope('partner', 'system');
const orgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
const orgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const partnerQuery = z.object({ partnerId: z.string().guid().optional() });

export const TEMPLATE_REVISION_MISMATCH_MESSAGE = 'The partner template changed since you loaded it. Reload and try again.';

type PartnerResolution = { partnerId: string; country: string | null } | Response;

/** The partner the call is about: the caller's own (partner scope) or the named one (system scope). */
async function resolvePartner(c: Context, queryPartnerId: string | undefined): Promise<PartnerResolution> {
  const auth = c.get('auth') as AuthContext;
  const partnerId = auth.scope === 'system' ? queryPartnerId : auth.partnerId;
  if (!partnerId) {
    return c.json({ error: auth.scope === 'system' ? 'partnerId is required for system scope' : 'Partner context required', code: 'PARTNER_REQUIRED' }, 400);
  }
  const [row] = await db.select({ id: partners.id, country: partners.billingAddressCountry }).from(partners)
    .where(eq(partners.id, partnerId)).limit(1);
  if (!row) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return { partnerId: row.id, country: row.country ?? null };
}

trustPageTemplateRoutes.get('/', scopes, orgRead, zValidator('query', partnerQuery), async (c) => {
  const resolved = await resolvePartner(c, c.req.valid('query').partnerId);
  if (resolved instanceof Response) return resolved;
  const auth = c.get('auth') as AuthContext;
  const template = await loadPartnerTemplate(resolved.partnerId);
  return c.json({ data: {
    template: template?.settings ?? null,
    // 0 = no template row yet; the form sends it back as expectedRevision.
    revision: template?.revision ?? 0,
    defaults: { ...TRUST_BUILTIN_DEFAULTS, frameworkView: defaultFrameworkView() },
    frameworkOptions: frameworkOptionsFor({ partnerCountry: resolved.country }),
    canManage: canManagePartnerWidePolicies(auth),
  } });
});

trustPageTemplateRoutes.put('/', scopes, orgWrite, requireMfa(), zValidator('query', partnerQuery), zValidator('json', trustTemplateUpdateSchema), async (c) => {
  const auth = c.get('auth') as AuthContext;
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_REQUIRED' }, 403);
  }
  const resolved = await resolvePartner(c, c.req.valid('query').partnerId);
  if (resolved instanceof Response) return resolved;
  const { expectedRevision, ...body } = c.req.valid('json');

  const patch: PartnerTemplatePatch = {};
  if (body.introHtml !== undefined) {
    // null = the template sets no intro (pages inherit the Breeze default: none); any string is the template's
    // intro, and one that sanitizes to nothing is '' — explicitly "no intro", same rule as the org page.
    const intro = body.introHtml === null ? null : (sanitizeIntro(body.introHtml) ?? '');
    if (intro !== null && intro.length > TRUST_INTRO_STORED_MAX_CHARS) {
      return c.json({ error: 'The intro is too long after formatting; shorten it.', code: 'INTRO_TOO_LONG' }, 422);
    }
    patch.introHtml = intro;
  }
  for (const k of ['searchIndexable', 'showPercentages', 'showDeviceCount', 'showManagedBy', 'showHistory', 'hiddenControlIds', 'frameworkView'] as const) {
    if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
  }

  const saved = await savePartnerTemplate({ partnerId: resolved.partnerId, expectedRevision, patch, actorUserId: auth.user.id, actor: auth });
  if (!saved.ok) return c.json({ error: TEMPLATE_REVISION_MISMATCH_MESSAGE, code: 'REVISION_MISMATCH' }, 409);

  writeRouteAudit(c, {
    orgId: null,
    action: 'trust_page_template.update',
    resourceType: 'trust_page_template',
    resourceId: resolved.partnerId,
    details: { partnerId: resolved.partnerId, fields: Object.keys(patch), revision: saved.revision },
  });
  return c.json({ data: { template: saved.settings, revision: saved.revision } });
});
