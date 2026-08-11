import { Hono } from 'hono';
import { authMiddleware, requireMfa, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  readPartnerRemoteAccessSettings,
  readRemoteAccessSettingsForPartner,
  toProviderSummaries,
} from '../../services/remoteAccessProviders';
import { sessionRoutes } from './sessions';
import { supportSessionRoutes } from './supportSessions';

export const remoteRoutes = new Hono();

// Apply auth middleware globally
remoteRoutes.use('*', authMiddleware);
remoteRoutes.use('*', requirePermission(PERMISSIONS.REMOTE_ACCESS.resource, PERMISSIONS.REMOTE_ACCESS.action), requireMfa());

// GET /remote/providers - the tenant's remote-access providers, id/name/enabled
// only.
//
// Lives here rather than under /orgs because the gate above is exactly right:
// the same `remote:access` permission that guards issuing a launch URL, and no
// partner-scope requirement. The only existing source is GET /orgs/partners/me,
// which is partner-scope gated AND returns the whole settings blob including
// encrypted provider passwords — the wrong exposure path for a control a
// technician needs (#3404).
//
// Consumers: the profile "preferred remote tool" chooser (#3391/#3389), the
// org-restriction reads in #3404, and the availability check in #3402.
remoteRoutes.get('/providers', async (c) => {
  const auth = c.get('auth') as AuthContext;

  // A partner-scoped caller names its own partner; an org-scoped one does not
  // (and its accessible-partner list is empty), so resolve through the org the
  // same way the launcher walks device -> org -> partner.
  const settings = auth.partnerId
    ? await readRemoteAccessSettingsForPartner(auth.partnerId)
    : auth.orgId
      ? await readPartnerRemoteAccessSettings(auth.orgId)
      : undefined;

  // No resolvable partner (e.g. a system-scoped caller with no org context) is
  // an empty directory, not an error: the caller simply has no tenant whose
  // providers to list.
  return c.json(toProviderSummaries(settings));
});

// Mount sub-routes
remoteRoutes.route('/', sessionRoutes);
// Quick Support inherits the same auth + remote:access + MFA gate above.
remoteRoutes.route('/', supportSessionRoutes);
