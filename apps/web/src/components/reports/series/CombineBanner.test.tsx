import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('./CombineDialog', () => ({
  default: ({ onChanged }: { onChanged: () => void }) => <button type="button" data-testid="combine-dialog-stub" onClick={onChanged} />,
}));

import CombineBanner from './CombineBanner';

const groups = [{ groupKey: 'a'.repeat(64) }, { groupKey: 'b'.repeat(64) }];
const respond = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });

describe('CombineBanner (series W04)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when there is nothing to combine', async () => {
    fetchWithAuth.mockReturnValue(respond([]));
    render(<CombineBanner timezone="UTC" onCombined={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(screen.queryByTestId('reports-combine-banner')).toBeNull();
  });

  it('fetches cross-org (no ambient org injection) and opens the dialog', async () => {
    fetchWithAuth.mockReturnValue(respond(groups));
    render(<CombineBanner timezone="UTC" onCombined={vi.fn()} />);
    expect(await screen.findByTestId('reports-combine-banner')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/reports/series/combine-candidates', { skipOrgIdInjection: true });
    fireEvent.click(screen.getByTestId('reports-combine-review'));
    expect(screen.getByTestId('combine-dialog-stub')).toBeInTheDocument();
  });

  it('after a combine: refreshes the list and its own candidates, closes the dialog', async () => {
    fetchWithAuth.mockReturnValueOnce(respond(groups)).mockReturnValueOnce(respond([]));
    const onCombined = vi.fn();
    render(<CombineBanner timezone="UTC" onCombined={onCombined} />);
    fireEvent.click(await screen.findByTestId('reports-combine-review'));
    fireEvent.click(screen.getByTestId('combine-dialog-stub'));
    expect(onCombined).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('reports-combine-banner')).toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a failed candidate fetch hides the banner and never throws', async () => {
    fetchWithAuth.mockReturnValue(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    render(<CombineBanner timezone="UTC" onCombined={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(screen.queryByTestId('reports-combine-banner')).toBeNull();
  });
});
