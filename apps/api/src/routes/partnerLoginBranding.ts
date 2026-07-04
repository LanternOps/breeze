import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partnerLoginBranding } from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { writeRouteAudit } from '../services/auditEvents';

// Partner admin read/write for the MSP's own technician-login branding
// (#2183). Deliberately NOT under orgRoutes' /orgs/partners/me or the
// legacy singular /partner router — mounted directly at /partners so the
// final URL is /api/v1/partners/me/login-branding.
export const partnerLoginBrandingRoutes = new Hono();

const brandingSchema = z.object({
  logoUrl: z.string().max(400_000)
    .refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), {
      message: 'logoUrl must be an https:// URL or a data:image/ URI'
    })
    .nullable().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accentColor must be a #rrggbb hex color')
    .nullable().optional(),
  headline: z.string().max(120).nullable().optional()
});

partnerLoginBrandingRoutes.get('/me/login-branding', authMiddleware, requireScope('partner'), async (c) => {
  const auth = c.get('auth') as AuthContext;
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);

  const [row] = await db
    .select({
      logoUrl: partnerLoginBranding.logoUrl,
      accentColor: partnerLoginBranding.accentColor,
      headline: partnerLoginBranding.headline
    })
    .from(partnerLoginBranding)
    .where(eq(partnerLoginBranding.partnerId, auth.partnerId))
    .limit(1);

  return c.json({ data: row ?? null });
});

partnerLoginBrandingRoutes.put(
  '/me/login-branding',
  authMiddleware,
  requireScope('partner'),
  zValidator('json', brandingSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 400);
    if (!canManagePartnerWidePolicies(auth)) {
      return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    }

    const body = c.req.valid('json');
    const [row] = await db
      .insert(partnerLoginBranding)
      .values({
        partnerId: auth.partnerId,
        logoUrl: body.logoUrl ?? null,
        accentColor: body.accentColor ?? null,
        headline: body.headline ?? null
      })
      .onConflictDoUpdate({
        target: partnerLoginBranding.partnerId,
        set: {
          logoUrl: body.logoUrl ?? null,
          accentColor: body.accentColor ?? null,
          headline: body.headline ?? null,
          updatedAt: new Date()
        }
      })
      .returning({
        logoUrl: partnerLoginBranding.logoUrl,
        accentColor: partnerLoginBranding.accentColor,
        headline: partnerLoginBranding.headline
      });

    // Full-replace semantics: an omitted field is coalesced to null above, so
    // a "changed fields" list derived from the request body would misrepresent
    // what happened (e.g. PUT {accentColor} also NULLs logoUrl/headline). Log
    // the effective applied row instead — truthful regardless of which fields
    // were present in the request.
    writeRouteAudit(c, {
      orgId: null,
      action: 'partner.login_branding.update',
      resourceType: 'partner_login_branding',
      resourceId: auth.partnerId,
      details: { partnerId: auth.partnerId, applied: row }
    });

    return c.json({ data: row });
  }
);
