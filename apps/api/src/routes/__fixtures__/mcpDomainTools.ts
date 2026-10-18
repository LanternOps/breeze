/**
 * Shared deterministic fixtures for the B-W02 (#6156) per-grant tool-domain
 * suites. The tool set deliberately spans core, two granted-able domains,
 * a wholly-gated tier-3 tool, a mixed multiplexer, an extension (unclassified)
 * tool, a deprecated alias and a tenant (BYO MCP) tool, so every branch of the
 * domain gate has a row.
 */
export const DOMAIN_TEST_TOOLS = [
  { name: 'query_devices', description: 'List devices', input_schema: { type: 'object', properties: {} } },
  { name: 'get_device_details', description: 'Device detail', input_schema: { type: 'object', properties: { deviceId: { type: 'string' } } } },
  {
    name: 'manage_services',
    description: 'Manage services',
    input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'restart'] } } },
  },
  { name: 'list_tickets', description: 'List tickets', input_schema: { type: 'object', properties: {} } },
  { name: 'create_ticket', description: 'Create a ticket', input_schema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'run_script', description: 'Run a script', input_schema: { type: 'object', properties: {} } },
  { name: 'get_invite_funnel', description: 'Invite funnel', input_schema: { type: 'object', properties: {} } },
  { name: 'ext_vendor_lookup', description: 'Extension tool', input_schema: { type: 'object', properties: {} } },
] as const;

export const DOMAIN_TEST_TIERS: Record<string, number> = {
  query_devices: 1,
  get_device_details: 1,
  manage_services: 2,
  list_tickets: 1,
  create_ticket: 2,
  run_script: 3,
  get_invite_funnel: 1,
  ext_vendor_lookup: 1,
};

/** `undefined` = unclassified (an extension tool has no domain). */
export const DOMAIN_TEST_DOMAINS: Record<string, string | undefined> = {
  query_devices: 'core',
  get_device_details: 'devices',
  manage_services: 'devices',
  list_tickets: 'tickets',
  create_ticket: 'tickets',
  run_script: 'scripts',
  get_invite_funnel: 'accounts',
  ext_vendor_lookup: undefined,
};

export function makeTenantDescriptor(qualifiedName = 'hudu__get_asset', tier: 1 | 2 | 3 = 1) {
  return {
    id: `tool-${qualifiedName}`,
    sourceId: 'source-1',
    sourceName: 'Hudu',
    sourceKind: 'mcp' as const,
    ownerRef: { orgId: 'org-1', partnerId: null },
    qualifiedName,
    name: qualifiedName.split('__')[1] ?? qualifiedName,
    description: 'Get an asset',
    inputSchema: { type: 'object' },
    tier,
    revision: 'rev-1',
    rateLimitPerMinute: 60,
    validate: () => ({ success: true as const }),
    definition: { name: qualifiedName, description: 'Get an asset', input_schema: { type: 'object' } },
  };
}
