import { Hono } from 'hono';
import { partnerApiAuthMiddleware } from '../../middleware/partnerApiAuth';

export const partnerApiRoutes = new Hono();

// All versioned partner-export endpoints added beneath this router inherit the
// dedicated service-principal authentication and partner RLS context.
partnerApiRoutes.use('*', partnerApiAuthMiddleware);
