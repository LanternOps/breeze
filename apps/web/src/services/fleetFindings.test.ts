import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listFindings } from './fleetFindings';
import { fetchWithAuth } from '@/stores/auth';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

function okResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

describe('listFindings org scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockResolvedValue(okResponse({ findings: [], total: 0 }));
  });

  it('suppresses the orgId auto-injection when no org filter is set (all orgs)', async () => {
    await listFindings({ statuses: ['open'] });

    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/fleet/findings?status=open',
      { skipOrgIdInjection: true }
    );
  });

  it('passes an explicit orgId through and keeps default injection semantics', async () => {
    const ORG = '11111111-1111-1111-1111-111111111111';
    await listFindings({ orgId: ORG });

    expect(fetchWithAuth).toHaveBeenCalledWith(
      `/fleet/findings?orgId=${ORG}`,
      undefined
    );
  });
});
