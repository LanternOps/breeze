/**
 * Wisp W06a Task 6 — nudge preferences (per user) and the partner's
 * urgent-capable severities (Wisp design §7.4; w00 "Nudges (W06)", A28, A29).
 * Mounted by W02's hub:
 *
 *   GET /api/v1/wisp/nudge-preferences → { data: { settings: WispNudgePreferences } }   (missing row = defaults; never inserts)
 *   PUT /api/v1/wisp/nudge-preferences   updateWispNudgePreferencesSchema (strict, non-empty) → { data: { settings } }
 *   GET /api/v1/wisp/nudge-settings    → { data: { settings: { urgentCapableSeverities } } }   (any partner member)
 *   PUT /api/v1/wisp/nudge-settings      { urgentCapableSeverities } (strict) → 403 partner_admin_required unless
 *                                        canManagePartnerWidePolicies(auth)
 *
 * GATES are inherited from the hub's `use('*')` chain (auth → 404 while
 * !wispEnabled() → partner scope → ai_sessions:use → requireEntitlement
 * ('wisp')); never mount these routers anywhere but under `wispRoutes`
 * (routes/wisp.entitlement.contract.test.ts).
 *
 * The user and partner ids come from auth, never the body. Reads and writes
 * run under the caller's own RLS: wisp_nudge_preferences admits only the
 * caller's own row inside their partner; wisp_partner_nudge_settings admits
 * the caller's partner.
 *
 * Settings rule 9 (docs/agents/settings.md): the phone-notification
 * preference's home is mobile Settings (W06c); the partner urgent-capable
 * mark is API-only this wave (spec §7.4 "default: none").
 */
import { Hono, type Context } from 'hono';
import { updateWispNudgePreferencesSchema, updateWispNudgeSettingsSchema } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import type { AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import {
  loadNudgePrefs,
  loadUrgentCapableSeverities,
  upsertNudgePrefs,
  upsertUrgentCapableSeverities,
} from '../services/wisp/nudgePreferences';

const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

/** The hub's requireScope('partner') guarantees it; re-asserted for the type and as a belt. */
function partnerIdOf(auth: AuthContext): string {
  if (!auth.partnerId) throw new Error('wisp nudge routes reached without a partner (hub gates bypassed?)');
  return auth.partnerId;
}

export const wispNudgePreferenceRoutes = new Hono();

wispNudgePreferenceRoutes.get('/', async (c) => {
  const settings = await loadNudgePrefs(authOf(c).user.id);
  return c.json({ data: { settings } });
});

wispNudgePreferenceRoutes.put('/', zValidator('json', updateWispNudgePreferencesSchema), async (c) => {
  const auth = authOf(c);
  const patch = c.req.valid('json');
  const settings = await upsertNudgePrefs(auth.user.id, partnerIdOf(auth), patch);
  writeRouteAudit(c, {
    orgId: auth.orgId ?? null,
    action: 'wisp.nudge_preferences.update',
    resourceType: 'user',
    resourceId: auth.user.id,
    details: { fields: Object.keys(patch).sort() },
  });
  return c.json({ data: { settings } });
});

export const wispNudgeSettingsRoutes = new Hono();

wispNudgeSettingsRoutes.get('/', async (c) => {
  const urgentCapableSeverities = await loadUrgentCapableSeverities(partnerIdOf(authOf(c)));
  return c.json({ data: { settings: { urgentCapableSeverities } } });
});

wispNudgeSettingsRoutes.put('/', zValidator('json', updateWispNudgeSettingsSchema), async (c) => {
  const auth = authOf(c);
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: 'Only a partner administrator can change this', code: 'partner_admin_required' }, 403);
  }
  const partnerId = partnerIdOf(auth);
  const urgentCapableSeverities = await upsertUrgentCapableSeverities(partnerId, c.req.valid('json').urgentCapableSeverities, auth.user.id);
  writeRouteAudit(c, {
    orgId: null,
    partnerId,
    action: 'wisp.nudge_settings.update',
    resourceType: 'partner',
    resourceId: partnerId,
    details: { urgentCapableSeverities },
  });
  return c.json({ data: { settings: { urgentCapableSeverities } } });
});
