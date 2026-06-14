import { Hono } from 'hono';
import { cfAccessTrustEnabled } from '../config/env';
import { envFlag } from '../utils/envFlag';

export const configRoutes = new Hono();

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
