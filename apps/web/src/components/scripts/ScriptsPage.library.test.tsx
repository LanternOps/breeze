import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import ScriptsPage from './ScriptsPage';
import { fetchWithAuth } from '../../stores/auth';

const state = vi.hoisted(() => ({
  scope: 'partner', canManagePartnerWide: true, currentOrgId: null as string | null,
  organizations: [{ id: 'org-a', name: 'Alpha' }, { id: 'org-b', name: 'Beta' }],
  scripts: [] as Array<Record<string, unknown>>,
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../shared/Toast', () => ({ showToast: toast }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => ({ status: 'resolved', claims: { scope: state.scope, partnerId: 'partner-a', orgId: 'org-a' } }) }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: { canManagePartnerWide: state.canManagePartnerWide } }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => state, {
    getState: () => state
  })
}));

const script = {
  id: 'custom', name: 'Custom script', language: 'bash', category: 'maintenance', osTypes: ['linux'],
  createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z', origin: 'human'
};

describe('ScriptsPage built-in provenance', () => {
  it('opens the existing library instead of filtering tenant scripts to an empty list', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async (input) => {
      const url = String(input);
      return new Response(JSON.stringify({ data: url.startsWith('/scripts?') ? [script] : url === '/scripts/system-library' ? [{ ...script, id: 'built-in', name: 'Built-in cleanup' }] : [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    });
    render(<ScriptsPage />);
    const filter = await screen.findByTestId('script-origin-filter');
    fireEvent.change(filter, { target: { value: 'system' } });
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/scripts/system-library'));
    expect(screen.getByTestId('scripts-library-dialog')).toHaveTextContent('Built-in cleanup');
    expect(screen.getByTestId('script-row-custom')).toBeInTheDocument();
    expect(filter).toHaveValue('all');
    fireEvent.click(screen.getByTestId('scripts-library-close'));
    expect(screen.queryByTestId('scripts-library-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('script-row-custom')).toBeInTheDocument();
  });
});


describe('system library import target', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.scope = 'partner';
    state.canManagePartnerWide = true;
    state.currentOrgId = null;
    state.scripts = [script];
    vi.mocked(fetchWithAuth).mockImplementation(async input => new Response(JSON.stringify({
      data: String(input).startsWith('/scripts?') ? state.scripts : String(input) === '/scripts/system-library'
        ? [{ ...script, id: 'built-in', name: 'Built-in cleanup' }] : [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  });

  async function openLibrary() {
    render(<ScriptsPage />);
    fireEvent.change(await screen.findByTestId('script-origin-filter'), { target: { value: 'system' } });
    return screen.findByTestId('scripts-library-import-built-in');
  }

  it('defaults All Orgs to partner-wide and reports success', async () => {
    const button = await openLibrary();
    expect(screen.getByTestId('scripts-library-target')).toHaveValue('partner');
    fireEvent.click(button);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/scripts/import/built-in', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ ownerScope: 'partner' }),
    })));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('defaults to the current org and allows switching to partner-wide after importing', async () => {
    state.currentOrgId = 'org-a';
    const button = await openLibrary();
    expect(screen.getByTestId('scripts-library-target')).toHaveValue('org-a');
    fireEvent.click(button);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/scripts/import/built-in', expect.objectContaining({
      body: JSON.stringify({ ownerScope: 'organization', orgId: 'org-a' }),
    })));
    await waitFor(() => expect(screen.getByTestId('scripts-library-target')).not.toBeDisabled());
    fireEvent.change(screen.getByTestId('scripts-library-target'), { target: { value: 'partner' } });
    fireEvent.click(await screen.findByTestId('scripts-library-import-built-in'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/scripts/import/built-in', expect.objectContaining({ body: JSON.stringify({ ownerScope: 'partner' }) })));
  });

  it('lets restricted users choose an org and explains why All orgs is unavailable', async () => {
    state.canManagePartnerWide = false;
    const button = await openLibrary();
    expect(screen.getByTestId('scripts-library-target')).toHaveValue('');
    expect(screen.getByTestId('scripts-library-target-help')).toHaveTextContent('Choose an organization');
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByTestId('scripts-library-target'), { target: { value: 'org-b' } });
    fireEvent.click(button);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/scripts/import/built-in', expect.objectContaining({ body: JSON.stringify({ ownerScope: 'organization', orgId: 'org-b' }) })));
  });

  it('keeps the organization-scope fast path', async () => {
    state.scope = 'organization';
    state.currentOrgId = 'org-a';
    const button = await openLibrary();
    expect(screen.queryByTestId('scripts-library-target')).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/scripts/import/built-in', expect.objectContaining({ body: JSON.stringify({ ownerScope: 'organization', orgId: 'org-a' }) })));
  });

  it('does not treat another org’s same-name script as already imported', async () => {
    state.scripts = [{ ...script, name: 'Built-in cleanup', orgId: 'org-b' }];
    expect(await openLibrary()).toBeEnabled();
  });

  it('shows a friendly partner permission error and keeps the import available', async () => {
    const button = await openLibrary();
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PARTNER_WIDE_FORBIDDEN', error: 'Forbidden' }), { status: 403 }));
    fireEvent.click(button);
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'You cannot import scripts for all organizations. Choose an organization instead.' }));
    expect(await screen.findByTestId('scripts-library-import-built-in')).toBeEnabled();
  });
});
