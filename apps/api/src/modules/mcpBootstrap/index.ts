import type { BootstrapTool } from './types';
import { createTenantTool } from './tools/createTenant';
import { verifyTenantTool } from './tools/verifyTenant';
import { attachPaymentMethodTool } from './tools/attachPaymentMethod';
import { checkMcpBootstrapStartup } from './startupCheck';

export function initMcpBootstrap(): {
  unauthTools: BootstrapTool<any, any>[];
  authTools: BootstrapTool<any, any>[];
} {
  checkMcpBootstrapStartup();
  return {
    // Unauth tools: reachable before the partner has an API key (pre-activation).
    unauthTools: [createTenantTool, verifyTenantTool, attachPaymentMethodTool],
    // Auth tools land in Phase 3 (sendDeploymentInvitesTool, configureDefaultsTool).
    authTools: [],
  };
}

export { BOOTSTRAP_TOOL_NAMES, BootstrapError } from './types';
