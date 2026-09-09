import { describe, it, expect, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
vi.mock('./api', () => ({ coreRequest: (...args: unknown[]) => coreRequest(...args) }));

import { listOrgContacts } from './orgContacts';

beforeEach(() => { coreRequest.mockReset(); });

describe('listOrgContacts', () => {
  it('asks the org-scoped contacts endpoint for the server maximum page and narrows the row', async () => {
    coreRequest.mockResolvedValue({
      data: [
        { id: 'c1', orgId: 'o1', name: 'Alex Admin', email: 'alex@acme.test', isPrimary: true, phone: '555', notes: 'x' },
        { id: 'c2', orgId: 'o1', name: null, email: 'bailey@acme.test', isPrimary: false },
      ],
      pagination: { page: 1, limit: 100, total: 2 },
    });

    const contacts = await listOrgContacts('o1');

    expect(coreRequest).toHaveBeenCalledWith('/orgs/organizations/o1/contacts?limit=100');
    expect(contacts).toEqual([
      { id: 'c1', name: 'Alex Admin', email: 'alex@acme.test', isPrimary: true },
      { id: 'c2', name: null, email: 'bailey@acme.test', isPrimary: false },
    ]);
  });

  it('encodes the org id into the path rather than interpolating it raw', async () => {
    coreRequest.mockResolvedValue({ data: [] });
    await listOrgContacts('o 1/../x');
    expect(coreRequest).toHaveBeenCalledWith('/orgs/organizations/o%201%2F..%2Fx/contacts?limit=100');
  });

  it('defaults a missing name/email/isPrimary rather than passing undefined to the picker', async () => {
    coreRequest.mockResolvedValue({ data: [{ id: 'c3' }] });
    expect(await listOrgContacts('o1')).toEqual([{ id: 'c3', name: null, email: null, isPrimary: false }]);
  });

  it('tolerates an empty body', async () => {
    coreRequest.mockResolvedValue({});
    expect(await listOrgContacts('o1')).toEqual([]);
  });
});
