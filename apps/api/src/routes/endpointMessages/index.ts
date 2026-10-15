import { Hono } from 'hono';
import { sendRoutes } from './send';

// Endpoint messaging (#8741). Auth, scope, the `endpoint_messages:send`
// permission and MFA are declared on the route itself (send.ts).
export const endpointMessageRoutes = new Hono();

endpointMessageRoutes.route('/', sendRoutes);
