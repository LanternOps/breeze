import { describe, it, expect, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import { listOrganizations } from './organizations';

beforeEach(() => { coreRequest.mockReset(); });

describe('listOrganizations', () => {
  it('asks for the server maximum page and narrows to id + name', async () => {
    coreRequest.mockResolvedValue({
      data: [
        { id: 'a', name: 'Acme', status: 'active', extra: 1 },
        { id: 'b', name: 'Bolt', status: 'active' },
      ],
      pagination: { page: 1, limit: 100, total: 2 },
    });
    const r = await listOrganizations();
    expect(coreRequest).toHaveBeenCalledWith('/orgs/organizations?limit=100');
    expect(r).toEqual({ orgs: [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Bolt' }], total: 2 });
  });

  it('passes a trimmed search through and drops an empty one', async () => {
    coreRequest.mockResolvedValue({ data: [], pagination: { page: 1, limit: 100, total: 0 } });
    await listOrganizations('  acm ');
    expect(coreRequest).toHaveBeenCalledWith('/orgs/organizations?limit=100&search=acm');
    await listOrganizations('   ');
    expect(coreRequest).toHaveBeenLastCalledWith('/orgs/organizations?limit=100');
  });

  it('tolerates an empty body', async () => {
    coreRequest.mockResolvedValue({});
    expect(await listOrganizations()).toEqual({ orgs: [], total: 0 });
  });
});
