import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// The tab bodies fetch their own data; this file only covers the page's hash
// contract with the header org switch, so they render as stubs.
vi.mock('./DashboardTab', () => ({ default: () => <div data-testid="tab-dashboard" /> }));
vi.mock('./FindingsTab', () => ({ default: () => <div data-testid="tab-findings" /> }));
vi.mock('./ScansTab', () => ({ default: () => <div data-testid="tab-scans" /> }));
vi.mock('./PoliciesTab', () => ({ default: () => <div data-testid="tab-policies" /> }));

import SensitiveDataPage from './SensitiveDataPage';
import { orgSwitchKeptHash } from '../../lib/orgSwitch';

// #10083: switching org in the header re-renders the page in place. The tab is
// org-agnostic, so the page asks the switch to keep it.
describe('SensitiveDataPage — keeps its tab across an org switch (#10083)', () => {
  it('offers the selected tab, following the URL, and withdraws on unmount', () => {
    window.history.replaceState({}, '', '/sensitive-data#policies');
    const { unmount, getByTestId } = render(<SensitiveDataPage />);
    expect(getByTestId('tab-policies')).toBeTruthy();
    expect(orgSwitchKeptHash()).toBe('policies');

    // Asked at switch time: follows the tab the user has moved to since mount.
    window.history.replaceState({}, '', '/sensitive-data#scans');
    expect(orgSwitchKeptHash()).toBe('scans');

    unmount();
    expect(orgSwitchKeptHash()).toBeNull();
  });

  it('keeps nothing for a hash that is not one of its tabs', () => {
    window.history.replaceState({}, '', '/sensitive-data#finding-3f0c2b7e');
    render(<SensitiveDataPage />);
    expect(orgSwitchKeptHash()).toBeNull();
  });
});
