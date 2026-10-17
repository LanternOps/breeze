import { Hono } from 'hono';
import { sendRoutes } from './send';
import { listRoutes } from './list';
import { retractRoutes } from './retract';
import { resendRoutes } from './resend';

// Endpoint messaging (#8741 W1, #8742 W2). Auth, scope, permission (and MFA
// where required) are declared on each route itself.
export const endpointMessageRoutes = new Hono();

endpointMessageRoutes.route('/', sendRoutes);
endpointMessageRoutes.route('/', listRoutes);
endpointMessageRoutes.route('/', retractRoutes);
endpointMessageRoutes.route('/', resendRoutes);
