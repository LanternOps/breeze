import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import ScriptsPage from './ScriptsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => ({ currentOrgId: null, organizations: [] }), {
    getState: () => ({ currentOrgId: null, organizations: [] })
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
