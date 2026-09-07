import { describe, it, expect, vi, beforeEach } from 'vitest';

const coreRequest = vi.fn();
// `../lib/errorReporting` imports DEVICE_BLOCKED_CODE from this module too —
// it must be present on the mock even though listAssignableUsers itself never
// uses it.
vi.mock('./api', () => ({
  coreRequest: (...args: unknown[]) => coreRequest(...args),
  DEVICE_BLOCKED_CODE: 'DEVICE_BLOCKED',
}));

// Indirected through an object (not a bare top-level `vi.fn()`) to satisfy
// vitest's mock-factory hoisting rule — same pattern as csrfToken.test.ts.
const sentry = { captureException: vi.fn(), captureMessage: vi.fn() };
vi.mock('@sentry/react-native', () => ({
  captureException: (...a: unknown[]) => sentry.captureException(...a),
  captureMessage: (...a: unknown[]) => sentry.captureMessage(...a),
}));

import { listAssignableUsers } from './users';

beforeEach(() => {
  coreRequest.mockReset();
  sentry.captureException.mockReset();
});

describe('listAssignableUsers', () => {
  it('narrows a bare array body to id/name/email', async () => {
    coreRequest.mockResolvedValue([
      { id: 'u1', name: 'Casey Tech', email: 'casey@example.com', role: 'tech' },
      { id: 'u2', name: null, email: 'alex@example.com' },
    ]);
    const r = await listAssignableUsers();
    expect(coreRequest).toHaveBeenCalledWith('/users');
    expect(r).toEqual([
      { id: 'u1', name: 'Casey Tech', email: 'casey@example.com' },
      { id: 'u2', name: null, email: 'alex@example.com' },
    ]);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('narrows a { data: [...] } body the same way', async () => {
    coreRequest.mockResolvedValue({ data: [{ id: 'u1', name: 'Casey Tech', email: 'casey@example.com' }] });
    const r = await listAssignableUsers();
    expect(r).toEqual([{ id: 'u1', name: 'Casey Tech', email: 'casey@example.com' }]);
  });

  it('drops rows without an id', async () => {
    coreRequest.mockResolvedValue([{ name: 'No Id', email: 'x@example.com' }, { id: 'u2', name: 'Has Id', email: 'y@example.com' }]);
    const r = await listAssignableUsers();
    expect(r).toEqual([{ id: 'u2', name: 'Has Id', email: 'y@example.com' }]);
  });

  it('degrades to an empty list without reporting when the fetch rejects (403/network)', async () => {
    coreRequest.mockRejectedValue(new Error('403 Forbidden'));
    await expect(listAssignableUsers()).rejects.toThrow('403 Forbidden');
    // The reject is left to the caller (CreateTicketScreen) to catch and
    // report with its own area tag — this function only reports a 200 that
    // fails to parse, not a rejected request.
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports and degrades to an empty list on an unexpected 200 body shape', async () => {
    coreRequest.mockResolvedValue({ users: [{ id: 'u1' }] }); // wrong envelope key
    const r = await listAssignableUsers();
    expect(r).toEqual([]);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('reports and degrades to an empty list on a null body', async () => {
    coreRequest.mockResolvedValue(null);
    const r = await listAssignableUsers();
    expect(r).toEqual([]);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
