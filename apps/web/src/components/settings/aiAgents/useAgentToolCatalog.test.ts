import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '../../../stores/auth';
import { useAgentToolCatalog } from './useAgentToolCatalog';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const CATALOG = {
  capabilities: [{ id: 'services_startup', tone: 'standard' }],
  tools: [
    {
      name: 'manage_services',
      capability: 'services_startup',
      tier: 3,
      readOnly: false,
      operations: [{ key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false, policyDecidable: true, actEligible: true, actRequiresAuthorizedScripts: false }],
    },
  ],
  presets: { triage: ['manage_services:restart'], patch: [], helpdesk: [] },
};

const CEILING = { toolAllowlist: ['manage_services'], supervisedActionKeys: [] };

describe('useAgentToolCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the catalog exactly once and returns it', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ data: CATALOG }));
      return Promise.resolve(json({ data: null }));
    });

    const { result } = renderHook(() => useAgentToolCatalog({ kind: 'triage', ownerScope: 'partner' }));

    await waitFor(() => expect(result.current.catalog).toEqual(CATALOG));
    expect(fetchMock).toHaveBeenCalledWith('/ai/agents/tool-catalog');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/ai/agents/tool-catalog')).toHaveLength(1);
    expect(result.current.error).toBe(false);
  });

  it('does not fetch the ceiling for a partner-owned draft', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ data: CATALOG }));
      return Promise.resolve(json({ data: CEILING }));
    });

    const { result } = renderHook(() => useAgentToolCatalog({ kind: 'triage', ownerScope: 'partner' }));

    await waitFor(() => expect(result.current.catalog).toEqual(CATALOG));
    expect(fetchMock.mock.calls.some(([url]) => (url as string).startsWith('/ai/agents/ceiling'))).toBe(false);
    expect(result.current.ceiling).toBeNull();
  });

  it('fetches the ceiling with the kind in the query only for an organization-owned draft, and re-fetches when kind changes', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ data: CATALOG }));
      if (url === '/ai/agents/ceiling?kind=triage') return Promise.resolve(json({ data: CEILING }));
      if (url === '/ai/agents/ceiling?kind=patch') return Promise.resolve(json({ data: { toolAllowlist: ['run_script'], supervisedActionKeys: [] } }));
      return Promise.resolve(json({ data: null }));
    });

    const { result, rerender } = renderHook(
      ({ kind }: { kind: 'triage' | 'patch' }) => useAgentToolCatalog({ kind, ownerScope: 'organization' }),
      { initialProps: { kind: 'triage' } },
    );

    await waitFor(() => expect(result.current.ceiling).toEqual(CEILING));
    expect(fetchMock).toHaveBeenCalledWith('/ai/agents/ceiling?kind=triage');

    rerender({ kind: 'patch' });

    await waitFor(() => expect(result.current.ceiling).toEqual({ toolAllowlist: ['run_script'], supervisedActionKeys: [] }));
    expect(fetchMock).toHaveBeenCalledWith('/ai/agents/ceiling?kind=patch');
  });

  it('sets error true on a non-OK response and never throws', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ error: 'boom' }, false, 500));
      return Promise.resolve(json({ data: CEILING }));
    });

    const { result } = renderHook(() => useAgentToolCatalog({ kind: 'triage', ownerScope: 'organization' }));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.catalog).toBeNull();
  });

  it('sets error true when fetchWithAuth throws', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') return Promise.reject(new Error('network down'));
      return Promise.resolve(json({ data: CEILING }));
    });

    const { result } = renderHook(() => useAgentToolCatalog({ kind: 'triage', ownerScope: 'partner' }));

    await waitFor(() => expect(result.current.error).toBe(true));
  });

  it('reports loading true until the catalog fetch resolves, independent of the ceiling fetch', async () => {
    let resolveCatalog!: (value: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') {
        return new Promise((resolve) => {
          resolveCatalog = resolve;
        });
      }
      return Promise.resolve(json({ data: null }));
    });

    const { result } = renderHook(() => useAgentToolCatalog({ kind: 'triage', ownerScope: 'partner' }));
    expect(result.current.loading).toBe(true);

    resolveCatalog(json({ data: CATALOG }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.catalog).toEqual(CATALOG);
  });

  it('reports loading false once the catalog fetch fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ error: 'boom' }, false, 500));
      return Promise.resolve(json({ data: CEILING }));
    });

    const { result } = renderHook(() => useAgentToolCatalog({ kind: 'triage', ownerScope: 'partner' }));

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.loading).toBe(false);
  });
});
