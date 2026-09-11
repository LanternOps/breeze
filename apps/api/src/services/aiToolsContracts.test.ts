import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./contractService', () => ({
  listContracts: vi.fn(),
  getContract: vi.fn(),
  createContract: vi.fn(),
  updateContract: vi.fn(),
  updateContractLine: vi.fn(),
  deleteDraftContract: vi.fn(),
  addContractLineToContract: vi.fn(),
  removeContractLine: vi.fn(),
  activateContract: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  cancelContract: vi.fn(),
  contractLineAuditDetails: vi.fn(),
}));

import { registerContractTools } from './aiToolsContracts';
import * as contractService from './contractService';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const auth: AuthContext = {
  principal: { kind: 'user_session' },
  user: { id: 'u-1', email: 'user@example.test', name: 'User', isPlatformAdmin: false },
  token: {
    sub: 'u-1',
    email: 'user@example.test',
    roleId: null,
    orgId: null,
    partnerId: 'p-1',
    scope: 'partner',
    type: 'access',
    mfa: true,
  },
  partnerId: 'p-1',
  orgId: null,
  scope: 'partner',
  accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined,
  canAccessOrg: (orgId) => orgId === 'org-1',
};

function getTool(name: 'list_contracts' | 'get_contract' | 'manage_contracts'): AiTool {
  const tools = new Map<string, AiTool>();
  registerContractTools(tools);
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} not registered`);
  return tool;
}

describe('contract tool currency descriptions', () => {
  it.each(['list_contracts', 'get_contract'] as const)('%s documents per-currency grouping', (name) => {
    const description = getTool(name).definition.description;

    expect(description).toContain('currencyCode');
    expect(description).toContain('group by currencyCode');
  });

  it('manage_contracts documents contract line prices and totals in currencyCode', () => {
    expect(getTool('manage_contracts').definition.description).toContain('currencyCode');
  });
});

describe('get_contract line shape (#3205 W03)', () => {
  it('passes the decorated site and deviceGroup through to the model', async () => {
    const decorated = {
      id: 'l1', lineType: 'per_device', description: 'Managed device', unitPrice: '10.00',
      siteId: 'site-1', site: { id: 'site-1', name: 'HQ' },
      deviceGroupId: null, deviceGroupName: null, deviceGroup: null,
    };
    (contractService.getContract as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      contract: { id: 'ct-1', currencyCode: 'USD' }, lines: [decorated], periods: [],
    });
    const out = JSON.parse(await getTool('get_contract').handler({ contractId: 'ct-1' }, auth));
    expect(out.lines[0]).toMatchObject({ site: { id: 'site-1', name: 'HQ' }, deviceGroup: null });
  });
});

describe('contract tool scope parity with the recurring-contract HTTP surface', () => {
  beforeEach(() => vi.clearAllMocks());

  const authForScope = (scope: 'organization' | 'partner' | 'system'): AuthContext => ({
    ...auth,
    scope,
    orgId: scope === 'organization' ? 'org-1' : null,
    partnerId: scope === 'partner' ? 'p-1' : null,
    accessibleOrgIds: scope === 'system' ? null : ['org-1'],
    token: auth.token ? {
      ...auth.token,
      scope,
      orgId: scope === 'organization' ? 'org-1' : null,
      partnerId: scope === 'partner' ? 'p-1' : null,
    } : null,
  });

  it.each([
    ['list_contracts', {}, 'listContracts'],
    ['get_contract', { contractId: 'contract-1' }, 'getContract'],
    ['manage_contracts', { action: 'activate', contractId: 'contract-1' }, 'activateContract'],
  ] as const)('denies organization scope before %s reaches the contract service', async (toolName, input, serviceName) => {
    vi.mocked(contractService.listContracts).mockResolvedValue([]);
    vi.mocked(contractService.getContract).mockResolvedValue({ contract: {}, lines: [], periods: [] } as never);
    vi.mocked(contractService.activateContract).mockResolvedValue({ id: 'contract-1', status: 'active' } as never);

    const output = await getTool(toolName).handler(input, authForScope('organization'));

    expect(JSON.parse(output)).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(contractService[serviceName]).not.toHaveBeenCalled();
  });

  it.each(['partner', 'system'] as const)('preserves %s contract reads', async (scope) => {
    vi.mocked(contractService.listContracts).mockResolvedValueOnce([]);

    await expect(getTool('list_contracts').handler({}, authForScope(scope)))
      .resolves.toBe(JSON.stringify({ contracts: [], showing: 0 }));
    expect(contractService.listContracts).toHaveBeenCalledOnce();
  });

  it('fails closed for a malformed partner context with no partner identity', async () => {
    const malformed = { ...authForScope('partner'), partnerId: null };

    const output = await getTool('list_contracts').handler({}, malformed);

    expect(JSON.parse(output)).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(contractService.listContracts).not.toHaveBeenCalled();
  });
});
