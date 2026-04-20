import type { BootstrapTool } from './types';
import { createTenantTool } from './tools/createTenant';
import { verifyTenantTool } from './tools/verifyTenant';
import { attachPaymentMethodTool } from './tools/attachPaymentMethod';
import { sendDeploymentInvitesTool } from './tools/sendDeploymentInvites';
import { configureDefaultsTool } from './tools/configureDefaults';
import { checkMcpBootstrapStartup } from './startupCheck';

export function initMcpBootstrap(): {
  unauthTools: BootstrapTool[];
  authTools: BootstrapTool[];
} {
  checkMcpBootstrapStartup();
  return {
    unauthTools: [createTenantTool, verifyTenantTool, attachPaymentMethodTool],
    authTools: [sendDeploymentInvitesTool, configureDefaultsTool],
  };
}

export { BOOTSTRAP_TOOL_NAMES, BootstrapError } from './types';
export { mountActivationRoutes } from './activationRoutes';
export { mountInviteLandingRoutes } from './inviteLandingRoutes';
