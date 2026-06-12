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
    expect(screen.getByTestId('app-rule-action-third_party-Mozilla.Firefox')).toHaveValue('block');
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

  it('removes a rule', () => {
    const onChange = vi.fn();
    render(
      <PatchAppRulesSection
        apps={[{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }]}
        onChange={onChange}
      />
    );

    fireEvent.click(screen.getByTestId('app-rule-remove-third_party-Mozilla.Firefox'));

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

    fireEvent.change(screen.getByTestId('app-rule-pin-version-third_party-VideoLAN.VLC'), {
      target: { value: '3.0.20' },
    });

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ action: 'pin', pinnedVersion: '3.0.20' }),
    ]);
  });
});
