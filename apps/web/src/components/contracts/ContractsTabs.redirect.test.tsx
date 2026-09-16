import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import '@/lib/i18n';

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('./ContractsList', () => ({ ContractsList: () => <div data-testid="stub-list" />, default: () => <div data-testid="stub-list" /> }));
vi.mock('./CurrencyMismatchesTab', () => ({ default: () => <div data-testid="stub-currency" /> }));

import ContractsTabs from './ContractsTabs';

describe('ContractsTabs legacy deep links', () => {
  beforeEach(() => { vi.clearAllMocks(); window.location.hash = ''; });

  it('redirects #tab=templates to the agreement templates route', () => {
    window.location.hash = 'tab=templates';
    render(<ContractsTabs />);
    expect(navigateTo).toHaveBeenCalledWith('/agreements/templates', { replace: true });
  });

  it('redirects #tab=documents to the signed agreements route', () => {
    window.location.hash = 'tab=documents';
    render(<ContractsTabs />);
    expect(navigateTo).toHaveBeenCalledWith('/agreements/signed', { replace: true });
  });

  it('leaves #tab=currency-mismatches alone', () => {
    window.location.hash = 'tab=currency-mismatches';
    render(<ContractsTabs />);
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('renders the contracts list with no tab bar by default', () => {
    render(<ContractsTabs />);
    expect(document.querySelector('[data-testid="contracts-tab-contracts"]')).toBeNull();
    expect(document.querySelector('[data-testid="contracts-tab-templates"]')).toBeNull();
    expect(document.querySelector('[data-testid="contracts-tab-documents"]')).toBeNull();
  });
});
