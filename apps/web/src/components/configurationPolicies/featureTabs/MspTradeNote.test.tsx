import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'sp-1', name: 'Allowlist' }] }) })),
}));

import { i18n } from '@/lib/i18n';
import PolicyLinkSelector from './PolicyLinkSelector';
import InlineEntityPicker from './InlineEntityPicker';
import { FeaturePolicyContext, type FeaturePolicyInfo } from './featurePolicyContext';

const info = (mspManaged: boolean): FeaturePolicyInfo => ({ reach: null, parent: null, mspManaged });

// Spec Decision 1 / plan W03d C2: each linked picker of an MSP-managed policy
// states the trade.
describe('linked pickers on an MSP-managed policy state the trade', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each([
    ['PolicyLinkSelector', () => <PolicyLinkSelector fetchUrl="/software-policies" selectedId={null} onSelect={vi.fn()} />],
    ['InlineEntityPicker', () => <InlineEntityPicker value="" onChange={vi.fn()} endpoint="/scripts" label="Script" />],
  ])('%s', async (_name, picker) => {
    const view = render(<FeaturePolicyContext.Provider value={info(true)}>{picker()}</FeaturePolicyContext.Provider>);
    expect(await screen.findByTestId('linked-picker-msp-trade')).toHaveTextContent(/MSP-managed/);
    view.unmount();
    render(<FeaturePolicyContext.Provider value={info(false)}>{picker()}</FeaturePolicyContext.Provider>);
    await screen.findByText(/Allowlist|Script/);
    expect(screen.queryByTestId('linked-picker-msp-trade')).toBeNull();
  });
});
