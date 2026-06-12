import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

import PatchAppRulesSection, { type PolicyAppRule } from './PatchAppRulesSection';

const options = [
  { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox', inCatalog: true },
  { source: 'third_party', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', displayName: 'VLC', inCatalog: false },
];

describe('PatchAppRulesSection', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: options }) });
  });

  it('renders existing rules with action and pinned version', () => {
    const apps: PolicyAppRule[] = [
      { source: 'third_party', packageId: 'Mozilla.Firefox', displayName: 'Firefox', action: 'block' },
      { source: 'third_party', packageId: 'VideoLAN.VLC', displayName: 'VLC', action: 'pin', pinnedVersion: '3.0.20' },
    ];

    render(<PatchAppRulesSection apps={apps} onChange={() => {}} />);

    expect(screen.getByText('Firefox')).toBeTruthy();
    expect(screen.getByTestId('app-rule-action-third_party|mozilla.firefox')).toHaveValue('block');
    expect(screen.getByDisplayValue('3.0.20')).toBeTruthy();
  });

  it('adds a block rule from picker search results', async () => {
    const onChange = vi.fn();
    render(<PatchAppRulesSection apps={[]} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('app-rules-add'));
    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'fire' } });

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('app-option-third_party-Mozilla.Firefox'));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }),
    ]);
  });

  it('disables custom and third_party duplicates as the same app-rule bucket', async () => {
    const onChange = vi.fn();
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { source: 'custom', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox custom', inCatalog: false },
        ],
      }),
    });

    render(
      <PatchAppRulesSection
        apps={[{ source: 'third_party', packageId: 'mozilla.firefox', action: 'block' }]}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByTestId('app-rules-add'));
    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'fire' } });

    const option = await screen.findByTestId('app-option-custom-Mozilla.Firefox');
    expect(option).toBeDisabled();
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes a rule', () => {
    const onChange = vi.fn();
    render(
      <PatchAppRulesSection
        apps={[{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }]}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByTestId('app-rule-remove-third_party|mozilla.firefox'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('switches a rule to pin and sets the version', () => {
    const onChange = vi.fn();
    render(
      <PatchAppRulesSection
        apps={[{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '' }]}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByTestId('app-rule-pin-version-third_party|videolan.vlc'), {
      target: { value: '3.0.20' },
    });

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ action: 'pin', pinnedVersion: '3.0.20' }),
    ]);
  });

  it('uses source|lowercased-packageId identity so similar ids do not collide', () => {
    const onChange = vi.fn();
    const apps: PolicyAppRule[] = [
      // Under the old `${source}-${packageId}` scheme both rules keyed to 'third-party_Foo-Bar'-style collisions.
      { source: 'third_party', packageId: 'Foo-Bar', action: 'block' },
      { source: 'third_party-Foo', packageId: 'Bar', action: 'block' },
    ];
    render(<PatchAppRulesSection apps={apps} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('app-rule-remove-third_party|foo-bar'));

    expect(onChange).toHaveBeenCalledWith([apps[1]]);
  });

  it('shows a load error and clears stale options when the fetch returns non-OK', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PatchAppRulesSection apps={[]} onChange={() => {}} />);

    fireEvent.click(screen.getByTestId('app-rules-add'));
    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'fire' } });
    await screen.findByTestId('app-option-third_party-Mozilla.Firefox');

    fetchWithAuthMock.mockResolvedValue({ ok: false, status: 500 });
    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'firefox' } });

    const error = await screen.findByTestId('app-rules-load-error');
    expect(error.textContent).toMatch(/couldn't load applications/i);
    expect(screen.queryByTestId('app-option-third_party-Mozilla.Firefox')).toBeNull();
    expect(screen.queryByText('No matches.')).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('shows the load error instead of "No matches." when the fetch rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuthMock.mockRejectedValue(new Error('network down'));
    render(<PatchAppRulesSection apps={[]} onChange={() => {}} />);

    fireEvent.click(screen.getByTestId('app-rules-add'));
    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'fire' } });

    const error = await screen.findByTestId('app-rules-load-error');
    expect(error.textContent).toMatch(/couldn't load applications/i);
    expect(screen.queryByText('No matches.')).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('recovers from a load error once a fetch succeeds again', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuthMock.mockResolvedValueOnce({ ok: false, status: 500 });
    render(<PatchAppRulesSection apps={[]} onChange={() => {}} />);

    fireEvent.click(screen.getByTestId('app-rules-add'));
    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'fire' } });
    await screen.findByTestId('app-rules-load-error');

    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'firefox' } });
    await screen.findByTestId('app-option-third_party-Mozilla.Firefox');
    expect(screen.queryByTestId('app-rules-load-error')).toBeNull();
    consoleSpy.mockRestore();
  });
});
