import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SNAPSHOT, CONN, jsonRes } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import PartnerAiModelsTab from './PartnerAiModelsTab';

beforeEach(() => { fetchWithAuth.mockReset(); });

describe('PartnerAiModelsTab', () => {
  it('renders connections from GET /ai/models, platform row first and read-only', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes(SNAPSHOT));
    render(<PartnerAiModelsTab />);
    await screen.findByTestId('ai-connection-row-platform');
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/models');
    expect(screen.queryByTestId('ai-connection-edit-platform')).toBeNull();
    expect(screen.getByTestId(`ai-connection-edit-${CONN}`)).toBeTruthy();
    expect(screen.queryByTestId('ai-connection-add')).toBeNull(); // one Anthropic connection max (compat_uq)
    const rows = screen.getAllByTestId(/^ai-connection-row-/);
    expect(rows[0].getAttribute('data-testid')).toBe('ai-connection-row-platform');
  });

  it('offers Add connection when only the platform connection exists', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ ...SNAPSHOT, connections: [SNAPSHOT.connections[0]] }));
    render(<PartnerAiModelsTab />);
    await screen.findByTestId('ai-connection-add');
  });

  it('shows the forbidden state on 403', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x' }, 403));
    render(<PartnerAiModelsTab />);
    await screen.findByTestId('ai-models-forbidden');
  });

  it('shows a retry on a failed load', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x' }, 500));
    render(<PartnerAiModelsTab />);
    await screen.findByTestId('ai-models-load-error');
    expect(screen.getByTestId('ai-models-retry')).toBeTruthy();
  });
});
