import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireFreshMfaStepUp } from '../auth/helpers';
import {
  buildEvidenceCard,
  consumeTrustActionToken,
  verifyTrustActionToken,
  verifyTrustActionTokenDetailed,
} from '../../services/partnerTrustEvidenceCard';
import { setTrustState } from '../../services/partnerTrust';
import { suspendPartnerForAbuse } from './abuse';

export const trustActionAdminRoutes = new Hono();

const actionBodySchema = z.object({
  token: z.string().min(1),
  totp: z.string().trim().regex(/^\d{6}$/),
});

function forbidden(c: Context) {
  return c.json({ error: 'Invalid or expired trust action' }, 403);
}

// This API is Bearer-only: an email link cannot authenticate to it directly,
// and an HTML `<form>` has no way to send a bearer token. So this route is
// JSON-only, verifies the token WITHOUT consuming it, and never acts — it
// exists purely so the web app's `/admin/trust/act` page (Wave 6) can show
// the operator what they're about to do (and why the link might already be
// dead) before it collects a fresh TOTP and calls POST below with the
// operator's own bearer.
trustActionAdminRoutes.get('/trust/act/preview', async (c) => {
  const token = c.req.query('token');
  const auth = c.get('auth');
  if (!token) {
    return c.json({ valid: false, reason: 'bad_signature' as const });
  }

  const result = await verifyTrustActionTokenDetailed(token, auth.user.id);
  if (!result.valid) {
    return c.json({ valid: false, reason: result.reason });
  }

  const { payload } = result;
  let card;
  try {
    card = await buildEvidenceCard(payload.partnerId);
  } catch {
    // Partner vanished (deleted/merged) between mint and preview — surface it
    // as an invalid token rather than 500ing the operator's preview page.
    return c.json({ valid: false, reason: 'bad_signature' as const });
  }

  return c.json({
    valid: true,
    action: payload.action,
    partner: {
      id: card.partner.id,
      name: card.partner.name,
      slug: card.partner.slug,
      plan: card.partner.plan,
      trustState: card.partner.trustState,
    },
    card,
  });
});

trustActionAdminRoutes.post('/trust/act', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  // JSON-only: the web app's `/admin/trust/act` page is the only caller (see
  // the comment on the preview route above), and it always sends JSON. A
  // form-encoded body has no legitimate caller here, so reject it outright
  // rather than accepting it via `parseBody`.
  if (!contentType.includes('application/json')) {
    return c.json({ error: 'Content-Type must be application/json' }, 415);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return forbidden(c);
  }
  const parsed = actionBodySchema.safeParse(raw);
  if (!parsed.success) return forbidden(c);

  const auth = c.get('auth');
  const payload = await verifyTrustActionToken(parsed.data.token, auth.user.id);
  if (!payload) return forbidden(c);

  const mfaFailure = await requireFreshMfaStepUp(
    c,
    auth.user.id,
    parsed.data.totp,
    'admin:trust-action',
  );
  if (mfaFailure) return forbidden(c);

  // Consume the jti BEFORE acting, deliberately: this is the anti-replay
  // gate, and it must close even if the action below throws. The tradeoff is
  // that a downstream failure (setTrustState / suspendPartnerForAbuse
  // throwing) leaves the token burned with the action never applied — that
  // requires a fresh evidence-card email rather than a raw retry, which is
  // an acceptable cost for never double-applying an approve/suspend.
  if (!await consumeTrustActionToken(payload.jti)) return forbidden(c);

  if (payload.action === 'approve') {
    await setTrustState(
      payload.partnerId,
      'trusted',
      'admin:approve_link',
      auth.user.id,
      { via: 'email_card' },
    );
    return c.json({ success: true, partnerId: payload.partnerId, trustState: 'trusted' });
  }

  return suspendPartnerForAbuse(c, payload.partnerId, 'trust_card_link');
});
