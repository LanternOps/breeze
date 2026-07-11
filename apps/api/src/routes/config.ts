import { Hono } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { cfAccessTrustEnabled } from '../config/env';
import { envFlag } from '../utils/envFlag';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { resolveAllMlFeatureFlagsForOrg } from '../services/mlFeatureFlags';

export const configRoutes = new Hono();

const mlFeatureFlagsQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
});

// GET /api/v1/config — returns feature flags for the UI. No auth required;
// flags are derived purely from server env, not user state, so self-hosted
// deployments can fetch this before login to decide what to render.
configRoutes.get('/', (c) => {
  const hasExternalServices = !!process.env.BREEZE_BILLING_URL;
  return c.json({
    features: {
      billing: hasExternalServices,
      support: hasExternalServices,
    },
    cfAccessLogin: {
      enabled: cfAccessTrustEnabled(),
    },
    // Runtime source of truth for whether self-service MSP registration is
    // open. The web bundle can't read PUBLIC_ENABLE_REGISTRATION at runtime
    // (it's frozen into the prebuilt image at build time), so the UI gates the
    // "Register your MSP" link and the register pages on this value instead —
    // keeping it in lockstep with the same ENABLE_REGISTRATION env the
    // /auth/register-partner enforcement reads (issue #1308).
    registration: {
      enabled: envFlag('ENABLE_REGISTRATION', false),
    },
  });
});

configRoutes.get(
  '/ml-feature-flags',
  authMiddleware,
  requireScope('organization', 'partner', 'system'),
  zValidator('query', mlFeatureFlagsQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const query = c.req.valid('query');
    const orgId = query.orgId ?? auth.orgId;

    if (!orgId) {
      return c.json({ error: 'Organization context required' }, 400);
    }
    if (!auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Organization not found or access denied' }, 403);
    }

    const flags = await resolveAllMlFeatureFlagsForOrg(orgId);
    return c.json({ orgId, mlFeatureFlags: flags, data: flags });
  }
);
