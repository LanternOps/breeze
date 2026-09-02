import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireFreshMfaStepUp } from '../auth/helpers';
import {
  buildEvidenceCard,
  consumeTrustActionToken,
  renderEvidenceCardSummary,
  verifyTrustActionToken,
} from '../../services/partnerTrustEvidenceCard';
import { setTrustState } from '../../services/partnerTrust';
import { suspendPartnerForAbuse } from './abuse';

export const trustActionAdminRoutes = new Hono();

const actionBodySchema = z.object({
  token: z.string().min(1),
  totp: z.string().trim().regex(/^\d{6}$/),
});

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function forbidden(c: Context) {
  return c.json({ error: 'Invalid or expired trust action' }, 403);
}

trustActionAdminRoutes.get('/trust/act', async (c) => {
  const token = c.req.query('token');
  const auth = c.get('auth');
  if (!token) return forbidden(c);
  const payload = await verifyTrustActionToken(token, auth.user.id);
  if (!payload) return forbidden(c);

  let card;
  try {
    card = await buildEvidenceCard(payload.partnerId);
  } catch {
    return forbidden(c);
  }
  const summary = renderEvidenceCardSummary(card);
  const title = payload.action === 'approve' ? 'Approve partner' : 'Suspend partner';
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title></head><body><main><h1>${title}</h1>
<pre>${escapeHtml(summary)}</pre>
<form method="post" action="/admin/trust/act">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label>Fresh TOTP code <input name="totp" inputmode="numeric" pattern="[0-9]{6}" required autocomplete="one-time-code"></label>
<button type="submit">${title}</button>
</form></main></body></html>`);
});

trustActionAdminRoutes.post('/trust/act', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let raw: unknown;
  try {
    raw = contentType.includes('application/json') ? await c.req.json() : await c.req.parseBody();
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
