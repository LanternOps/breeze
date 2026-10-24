import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PartnerSettingsStatus, { deriveStatus, type StatusInput } from './PartnerSettingsStatus';
import { UNIT_TABS, type SaveUnit, type SaveUnitId, type TabValidity } from './saveUnits';
import type { TabKey } from './tabRegistry';

function unit(id: SaveUnitId, dirtyTabs: TabKey[] = [], invalid: Partial<Record<TabKey, TabValidity>> = {}): SaveUnit & { dirtyTabs: TabKey[] } {
  return {
    id,
    tabs: UNIT_TABS[id],
    dirtyTabs,
    isDirty: () => dirtyTabs.length > 0,
    validity: () => invalid,
    save: async () => ({ status: 'saved', savedAt: 1 }),
  };
}

const base = (over: Partial<StatusInput> = {}): StatusInput => ({
  units: [],
  dirtyTabs: {},
  saving: false,
  readOnly: false,
  failedUnits: [],
  otherUnitsSaved: false,
  savedAt: null,
  autosave: null,
  ...over,
});

describe('deriveStatus', () => {
  it('is clean with no time before anything saved', () => {
    expect(deriveStatus(base())).toEqual({ kind: 'clean', savedAt: null });
  });

  it('lists every dirty tab in rail order', () => {
    const units = [unit('loginBranding', ['loginBranding']), unit('partnersMe', ['security', 'company'])];
    const dirtyTabs = { security: true, company: true, loginBranding: true };
    expect(deriveStatus(base({ units, dirtyTabs }))).toEqual({ kind: 'dirty', tabs: ['company', 'security', 'loginBranding'] });
  });

  it('reports the first invalid tab of a dirty unit', () => {
    const units = [unit('partnersMe', ['company', 'aiBudgets'], {
      company: { isValid: true, invalidCount: 0, firstInvalidFieldId: null },
      aiBudgets: { isValid: false, invalidCount: 1, firstInvalidFieldId: 'thresholds' },
    })];
    expect(deriveStatus(base({ units, dirtyTabs: { company: true, aiBudgets: true } })))
      .toEqual({ kind: 'invalid', tab: 'aiBudgets', count: 1, fieldId: 'thresholds' });
  });

  it('read-only wins over everything', () => {
    expect(deriveStatus(base({ readOnly: true, saving: true, dirtyTabs: { company: true } }))).toEqual({ kind: 'readOnly' });
  });

  it('partial names the failed tabs while only they are dirty', () => {
    const units = [unit('loginBranding', ['loginBranding'])];
    expect(deriveStatus(base({ units, dirtyTabs: { loginBranding: true }, failedUnits: ['loginBranding'], otherUnitsSaved: true })))
      .toEqual({ kind: 'partial', tabs: ['loginBranding'] });
    expect(deriveStatus(base({ units, dirtyTabs: { loginBranding: true }, failedUnits: ['loginBranding'], otherUnitsSaved: false })))
      .toEqual({ kind: 'failed', tabs: ['loginBranding'] });
  });

  it('a new edit elsewhere after a partial failure shows the dirty list', () => {
    const units = [unit('loginBranding', ['loginBranding']), unit('partnersMe', ['company'])];
    expect(deriveStatus(base({ units, dirtyTabs: { loginBranding: true, company: true }, failedUnits: ['loginBranding'], otherUnitsSaved: true })))
      .toEqual({ kind: 'dirty', tabs: ['company', 'loginBranding'] });
  });

  it('reports the last autosave outcome when nothing is dirty', () => {
    expect(deriveStatus(base({ autosave: { tab: 'aiFeatures', outcome: { status: 'saved', savedAt: 5 } } })))
      .toEqual({ kind: 'autosaved', savedAt: 5 });
    expect(deriveStatus(base({ autosave: { tab: 'modules', outcome: { status: 'failed' } } })))
      .toEqual({ kind: 'autosaveFailed' });
    expect(deriveStatus(base({ dirtyTabs: { company: true }, units: [unit('partnersMe', ['company'])], autosave: { tab: 'modules', outcome: { status: 'failed' } } })).kind)
      .toBe('dirty');
  });
});

describe('PartnerSettingsStatus', () => {
  it('is a polite live region', () => {
    render(<PartnerSettingsStatus state={{ kind: 'clean', savedAt: null }} onOpenTab={vi.fn()} />);
    const status = screen.getByTestId('partner-settings-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('All changes saved');
  });

  it('shows the time of the last save', () => {
    render(<PartnerSettingsStatus state={{ kind: 'clean', savedAt: new Date(2026, 0, 1, 10, 58).getTime() }} onOpenTab={vi.fn()} />);
    expect(screen.getByTestId('partner-settings-status').textContent).toMatch(/^All changes saved · 10:58/);
  });

  it('links every dirty tab to its tab', async () => {
    const onOpenTab = vi.fn();
    render(<PartnerSettingsStatus state={{ kind: 'dirty', tabs: ['company', 'security'] }} onOpenTab={onOpenTab} />);
    expect(screen.getByTestId('partner-settings-status').textContent).toBe('Unsaved changes in Company, Security.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Company' }));
    expect(onOpenTab).toHaveBeenCalledWith('company', undefined);
  });

  it('the invalid link opens the tab at its first invalid field', async () => {
    const onOpenTab = vi.fn();
    render(<PartnerSettingsStatus state={{ kind: 'invalid', tab: 'aiBudgets', count: 1, fieldId: 'f-1' }} onOpenTab={onOpenTab} />);
    expect(screen.getByTestId('partner-settings-status').textContent).toBe('Fix 1 field in AI Budgets to save.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'AI Budgets' }));
    expect(onOpenTab).toHaveBeenCalledWith('aiBudgets', 'f-1');
  });

  it('pluralises the invalid count', () => {
    render(<PartnerSettingsStatus state={{ kind: 'invalid', tab: 'company', count: 2, fieldId: null }} onOpenTab={vi.fn()} />);
    expect(screen.getByTestId('partner-settings-status').textContent).toBe('Fix 2 fields in Company to save.');
  });

  it.each([
    [{ kind: 'saving' as const }, 'Saving…'],
    [{ kind: 'partial' as const, tabs: ['loginBranding' as const] }, "Couldn't save Login Branding. Other changes saved."],
    [{ kind: 'failed' as const, tabs: ['loginBranding' as const] }, "Couldn't save Login Branding."],
    [{ kind: 'autosaveFailed' as const }, "Couldn't save — try again"],
    [{ kind: 'readOnly' as const }, 'Saving needs full partner access'],
  ])('renders %o', (state, text) => {
    render(<PartnerSettingsStatus state={state} onOpenTab={vi.fn()} />);
    expect(screen.getByTestId('partner-settings-status').textContent).toBe(text);
  });

  it('renders the autosave time', () => {
    render(<PartnerSettingsStatus state={{ kind: 'autosaved', savedAt: new Date(2026, 0, 1, 9, 5).getTime() }} onOpenTab={vi.fn()} />);
    expect(screen.getByTestId('partner-settings-status').textContent).toMatch(/^Saved · 0?9:05/);
  });
});
