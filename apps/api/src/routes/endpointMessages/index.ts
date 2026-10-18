import { Hono } from 'hono';
import { sendRoutes } from './send';
import { listRoutes } from './list';
import { retractRoutes } from './retract';
import { resendRoutes } from './resend';
import { conversationRoutes } from './conversations';

// Endpoint messaging (#8741 W1, #8742 W2, #8743 W3 live chat). Auth, scope, permission (and MFA
// where required) are declared on each route itself.
export const endpointMessageRoutes = new Hono();

// Live chat (#8743 W03) first: listRoutes' GET /:id would otherwise claim
// /conversations (and 400 it as a non-uuid id).
endpointMessageRoutes.route('/conversations', conversationRoutes);
endpointMessageRoutes.route('/', sendRoutes);
endpointMessageRoutes.route('/', listRoutes);
endpointMessageRoutes.route('/', retractRoutes);
endpointMessageRoutes.route('/', resendRoutes);
