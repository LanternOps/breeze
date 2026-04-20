import type { BootstrapTool } from './types';
import { createTenantTool } from './tools/createTenant';
import { verifyTenantTool } from './tools/verifyTenant';
import { attachPaymentMethodTool } from './tools/attachPaymentMethod';
import { sendDeploymentInvitesTool } from './tools/sendDeploymentInvites';
import { checkMcpBootstrapStartup } from './startupCheck';

export function initMcpBootstrap(): {
  unauthTools: BootstrapTool<any, any>[];
  authTools: BootstrapTool<any, any>[];
} {
  checkMcpBootstrapStartup();
  return {
    // Unauth tools: reachable before the partner has an API key (pre-activation).
    unauthTools: [createTenantTool, verifyTenantTool, attachPaymentMethodTool],
    // Auth tools require a valid API key AND a payment method on file
    // (enforced via the requirePaymentMethod decorator). configureDefaultsTool
    // lands in Phase 6.
    authTools: [sendDeploymentInvitesTool],
  };
}

export { BOOTSTRAP_TOOL_NAMES, BootstrapError } from './types';
export { mountActivationRoutes } from './activationRoutes';
export { mountInviteLandingRoutes } from './inviteLandingRoutes';
