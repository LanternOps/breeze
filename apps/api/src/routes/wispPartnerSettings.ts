/**
 * Wisp W08 Task 6 (#9914, w00 A35) — the partner's Wisp enable switch.
 * Mounted by W02's hub:
 *
 *   GET /api/v1/wisp/partner-settings → { data: { enabled } }   (any caller past the hub gates; missing row = enabled)
 *   PUT /api/v1/wisp/partner-settings   { enabled } (strict) → { data: { enabled } };
 *                                       403 partner_admin_required unless canManagePartnerWidePolicies(auth)
 *
 * GATES are inherited from the hub's `use('*')` chain (auth → 404 while
 * !wispEnabled() → partner scope → ai_sessions:use → requireEntitlement
 * ('wisp')); never mount this router anywhere but under `wispRoutes`
 * (routes/wisp.entitlement.contract.test.ts). Nothing in the hub consults the
 * switch itself, so a disabled-but-entitled partner can still read it and
 * turn it back on here.
 *
 * Spec §17.2 (4): the entitlement is commercial, this switch is governance,
 * BREEZE_WISP_ENABLED is the deployment kill switch — none overrides another.
 *
 * Settings rule 9 (docs/agents/settings.md): home = the Wisp card under
 * Settings → AI Agents; level = partner only; resolver =
 * getPartnerSettings(partnerId).enabled (default true); configured in one
 * place.
 */
import { Hono, type Context } from 'hono';
import { wispPartnerSettingsSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import type { AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PartnerWideWriteDeniedError,
} from '../services/partnerWideAccess';
import { getPartnerSettings, setPartnerEnabled } from '../services/wisp/partnerSettings';

const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

/** The hub's requireScope('partner') guarantees it; re-asserted for the type and as a belt. */
function partnerIdOf(auth: AuthContext): string {
  if (!auth.partnerId) throw new Error('wisp partner-settings route reached without a partner (hub gates bypassed?)');
  return auth.partnerId;
}

export const wispPartnerSettingsRoutes = new Hono();

wispPartnerSettingsRoutes.get('/', async (c) => {
  const { enabled } = await getPartnerSettings(partnerIdOf(authOf(c)));
  return c.json({ data: { enabled } });
});

wispPartnerSettingsRoutes.put('/', zValidator('json', wispPartnerSettingsSchema), async (c) => {
  const auth = authOf(c);
  const denied = () => c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'partner_admin_required' }, 403);
  // Partner-wide state (epic #2135): gated here and again in the service.
  if (!canManagePartnerWidePolicies(auth)) return denied();
  const partnerId = partnerIdOf(auth);
  let enabled: boolean;
  try {
    ({ enabled } = await setPartnerEnabled(auth, c.req.valid('json').enabled));
  } catch (err) {
    if (err instanceof PartnerWideWriteDeniedError) return denied();
    throw err;
  }
  writeRouteAudit(c, {
    orgId: null,
    partnerId,
    action: 'wisp.partner.enabled_changed',
    resourceType: 'partner',
    resourceId: partnerId,
    details: { enabled },
  });
  return c.json({ data: { enabled } });
});
