import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithAuth } from '../../stores/auth';
import { updateContractLine } from './contracts';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

describe('updateContractLine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response());
  });

  it('PATCHes the selected contract line and omits undefined patch keys', () => {
    void updateContractLine('contract-1', 'line-1', { description: 'x', unitPrice: undefined });

    expect(fetchWithAuth).toHaveBeenCalledWith('/contracts/contract-1/lines/line-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'x' }),
    });
    const request = vi.mocked(fetchWithAuth).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).not.toHaveProperty('unitPrice');
  });
});
