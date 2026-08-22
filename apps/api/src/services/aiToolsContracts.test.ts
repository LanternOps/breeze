import { describe, expect, it, vi } from 'vitest';

vi.mock('./contractService', () => ({
  listContracts: vi.fn(),
  getContract: vi.fn(),
  createContract: vi.fn(),
  updateContract: vi.fn(),
  deleteDraftContract: vi.fn(),
  addContractLineToContract: vi.fn(),
  removeContractLine: vi.fn(),
  activateContract: vi.fn(),
  pauseContract: vi.fn(),
  resumeContract: vi.fn(),
  cancelContract: vi.fn(),
}));

import { registerContractTools } from './aiToolsContracts';
import type { AiTool } from './aiTools';

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
