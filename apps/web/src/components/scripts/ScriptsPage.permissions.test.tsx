import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const h = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => h.granted.has(`${r}:${a}`) }),
  hasPermission: (_p: unknown, r: string, a: string) => h.granted.has(`${r}:${a}`),
}));

import ScriptsPage from './ScriptsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, tokens: null }),
    { getState: () => ({ user: null, tokens: null }) }
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => ({ currentOrgId: null, organizations: [] }), {
    getState: () => ({ currentOrgId: null, organizations: [] }),
  }),
}));
vi.mock('./ScriptList', () => ({
  default: ({ scripts }: { scripts: Array<{ id: string; name: string }> }) => (
    <div>{scripts.map(s => <span key={s.id}>Row {s.name}</span>)}</div>
  ),
}));
vi.mock('./ScriptExecutionModal', () => ({ default: () => null }));
vi.mock('./ExecutionDetails', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500) =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const script = {
  id: 'script-1',
  name: 'Cleanup Temp Files',
  language: 'bash',
  category: 'maintenance',
  osTypes: ['linux'],
  createdAt: '2026-02-09T10:00:00.000Z',
  updatedAt: '2026-02-09T10:00:00.000Z',
};

function mockScripts(data: unknown[]) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith('/scripts?')) return json({ data });
    return json({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.granted.clear();
});

describe('ScriptsPage write actions are permission-gated (#7215)', () => {
  it('hides Import bundle, Import from Library and New Script without scripts:write; Export stays', async () => {
    mockScripts([script]);
    render(<ScriptsPage />);
    expect(await screen.findByText('Row Cleanup Temp Files')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-export-open')).toBeInTheDocument();
    expect(screen.queryByTestId('bundle-import-open')).toBeNull();
    expect(screen.queryByRole('button', { name: /import from library/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /new script/i })).toBeNull();
  });

  it('shows them all with scripts:write', async () => {
    h.granted.add('scripts:write');
    mockScripts([script]);
    render(<ScriptsPage />);
    expect(await screen.findByText('Row Cleanup Temp Files')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-export-open')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-import-open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import from library/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new script/i })).toBeInTheDocument();
  });

  it('hides the empty-state Create Script link without scripts:write', async () => {
    mockScripts([]);
    render(<ScriptsPage />);
    expect(await screen.findByTestId('bundle-export-open')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /create/i })).toBeNull();
  });
});
