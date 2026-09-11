import { describe, expect, it, vi } from 'vitest';

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
import { getContract } from './contractService';
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
    (getContract as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      contract: { id: 'ct-1', currencyCode: 'USD' }, lines: [decorated], periods: [],
    });
    const out = JSON.parse(await getTool('get_contract').handler({ contractId: 'ct-1' }, auth));
    expect(out.lines[0]).toMatchObject({ site: { id: 'site-1', name: 'HQ' }, deviceGroup: null });
  });
});
