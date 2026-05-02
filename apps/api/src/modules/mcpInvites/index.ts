import type { BootstrapTool } from './types';
import { sendDeploymentInvitesTool } from './tools/sendDeploymentInvites';
import { configureDefaultsTool } from './tools/configureDefaults';

export function initMcpBootstrap(): {
  unauthTools: BootstrapTool<any, any>[];
  authTools: BootstrapTool<any, any>[];
} {
  return {
    // Unauth tools: create_tenant, verify_tenant, attach_payment_method were
    // deleted in Phase 3. The bootstrap flow now happens via OAuth
    // Create Account → /auth/register-partner (Phase 1) → consent handler
    // redirects inactive partners to BILLING_URL (Phase 2).
    unauthTools: [],
    // Auth tools require a valid API key OR Bearer token. Partner status
    // (active vs pending/suspended/churned) is enforced upstream:
    //   - For Bearer tokens: at the OAuth consent step (oauthInteraction.ts)
    //     and via partnerGuard middleware on subsequent requests.
    //   - For X-API-Key: no per-call partner-status check at the tool dispatch
    //     layer (relies on key revocation as the gate).
    authTools: [sendDeploymentInvitesTool, configureDefaultsTool],
  };
}

export { BootstrapError } from './types';
export { mountInviteLandingRoutes } from './inviteLandingRoutes';
