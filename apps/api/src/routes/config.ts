import { Hono } from 'hono';

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
  });
});
