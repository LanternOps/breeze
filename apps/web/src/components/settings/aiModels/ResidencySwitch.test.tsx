import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { jsonRes } from './testFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import ResidencySwitch from './ResidencySwitch';

beforeEach(() => { fetchWithAuth.mockReset(); showToast.mockReset(); });

describe('ResidencySwitch', () => {
  it('turning on with impact opens a confirm that lists the surfaces, and only PUTs with acknowledgeImpact', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ unavailableSurfaces: ['chat', 'helper'], affectedOrgOverrides: [{ orgId: 'o1', orgName: 'Acme', surface: 'chat' }] }))
      .mockResolvedValueOnce(jsonRes({ residencyRequired: true, impact: { unavailableSurfaces: ['chat', 'helper'] } }));
    const onSaved = vi.fn();
    render(<ResidencySwitch required={false} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('ai-residency-switch'));
    const dialog = await screen.findByTestId('ai-residency-confirm');
    expect(within(dialog).getByTestId('ai-residency-confirm-surfaces').textContent).toMatch(/Chat/);
    expect(within(dialog).getByTestId('ai-residency-confirm-orgs').textContent).toMatch(/Acme/);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1); // nothing written yet
    fireEvent.click(screen.getByTestId('ai-residency-confirm-submit'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith('/ai/models/residency', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ required: true, acknowledgeImpact: true }),
    })));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    expect(onSaved).toHaveBeenCalled();
  });

  it('turning on with no impact PUTs directly without acknowledgeImpact', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ unavailableSurfaces: [], affectedOrgOverrides: [] }))
      .mockResolvedValueOnce(jsonRes({ residencyRequired: true, impact: { unavailableSurfaces: [], affectedOrgOverrides: [] } }));
    render(<ResidencySwitch required={false} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-residency-switch'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith('/ai/models/residency', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ required: true }),
    })));
    expect(screen.queryByTestId('ai-residency-confirm')).toBeNull();
  });

  it('cancelling the confirm leaves the switch off and writes nothing', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ unavailableSurfaces: ['chat'], affectedOrgOverrides: [] }));
    render(<ResidencySwitch required={false} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-residency-switch'));
    fireEvent.click(await screen.findByTestId('ai-residency-confirm-cancel'));
    expect((screen.getByTestId('ai-residency-switch') as HTMLInputElement).checked).toBe(false);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('reverts the switch when the PUT fails', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'nope' }, 500));
    render(<ResidencySwitch required onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-residency-switch')); // turning off: no preview
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect((screen.getByTestId('ai-residency-switch') as HTMLInputElement).checked).toBe(true));
  });

  it('does not turn on when the impact preview cannot be loaded', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'boom' }, 500));
    render(<ResidencySwitch required={false} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-residency-switch'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect((screen.getByTestId('ai-residency-switch') as HTMLInputElement).checked).toBe(false);
    expect(fetchWithAuth).toHaveBeenCalledTimes(1); // never PUT without knowing the impact
  });

  it('reopens the confirm when the server reports a not_eligible impact the preview missed', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes({ unavailableSurfaces: [], affectedOrgOverrides: [] }))
      .mockResolvedValueOnce(jsonRes({ error: 'x', code: 'not_eligible', details: { unavailableSurfaces: ['helper'], affectedOrgOverrides: [] } }, 409));
    render(<ResidencySwitch required={false} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ai-residency-switch'));
    const dialog = await screen.findByTestId('ai-residency-confirm');
    expect(within(dialog).getByTestId('ai-residency-confirm-surfaces').textContent).toMatch(/Helper/);
    expect((screen.getByTestId('ai-residency-switch') as HTMLInputElement).checked).toBe(false);
  });
});
