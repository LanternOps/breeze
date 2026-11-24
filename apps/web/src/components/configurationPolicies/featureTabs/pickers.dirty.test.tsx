import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// Pickers rendered inside the real FeatureTabShell: their own searching,
// closing, opening and retrying must not read as an unsaved edit, while a
// selection (which calls markDirty) must (#12469).

const m = vi.hoisted(() => ({
  fetchAllScripts: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/scriptsFetch', () => ({ fetchAllScripts: m.fetchAllScripts }));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));

import FeatureTabShell from './FeatureTabShell';
import InlineEntityPicker from './InlineEntityPicker';
import RemediationScriptPicker from './RemediationScriptPicker';
import RuleSetPicker from './RuleSetPicker';
import SoftwareCatalogPicker from './SoftwareCatalogPicker';
import { FeatureDirtyReporterContext } from './featureEditing';

const json = (payload: unknown) =>
  ({ ok: true, status: 200, json: async () => payload }) as unknown as Response;

function inShell(children: React.ReactNode, reporter: (dirty: boolean) => void) {
  return render(
    <FeatureDirtyReporterContext.Provider value={reporter}>
      <FeatureTabShell title="T" description="d" icon={<span />} isConfigured saving={false} onSave={vi.fn()}>
        {children}
      </FeatureTabShell>
    </FeatureDirtyReporterContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pickers and unsaved changes (#12469)', () => {
  it('searching and closing the remediation script picker does not mark dirty; choosing a script does', async () => {
    const reporter = vi.fn();
    m.fetchAllScripts.mockResolvedValue({
      data: [{ id: 's1', name: 'Fix disk', language: 'bash', category: 'General', osTypes: ['linux'] }],
    });
    inShell(<RemediationScriptPicker isOpen onClose={vi.fn()} onSelect={vi.fn()} />, reporter);
    await screen.findByText('Fix disk');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'fix' } });
    fireEvent.click(screen.getAllByRole('button').find((b) => /cancel|close/i.test(b.textContent ?? b.getAttribute('aria-label') ?? ''))!);
    expect(reporter).not.toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByText('Fix disk'));
    expect(reporter).toHaveBeenCalledWith(true);
  });

  it('browsing the software catalog picker does not mark dirty; choosing a version does', async () => {
    const reporter = vi.fn();
    m.fetchWithAuth.mockImplementation(async (url: string) =>
      url.includes('/versions')
        ? json({ data: [{ id: 'v1', version: '1.0', isLatest: true }] })
        : json({ data: [{ id: 'c1', name: 'Chrome', vendor: 'Google', category: 'browser' }] }),
    );
    inShell(<SoftwareCatalogPicker isOpen onClose={vi.fn()} onSelect={vi.fn()} />, reporter);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'chr' } });
    fireEvent.click(await screen.findByText('Chrome'));
    await waitFor(() => expect(screen.getAllByText(/latest/i).length).toBeGreaterThan(0));
    expect(reporter).not.toHaveBeenCalledWith(true);

    fireEvent.click(screen.getAllByRole('button', { name: /latest/i })[0]!);
    expect(reporter).toHaveBeenCalledWith(true);
  });

  it('opening and searching an entity picker does not mark dirty; choosing an option does', async () => {
    const reporter = vi.fn();
    m.fetchWithAuth.mockResolvedValue(json({ data: [{ id: 'aaaaaaaa-1', name: 'Alpha' }] }));
    inShell(<InlineEntityPicker value="" onChange={vi.fn()} endpoint="/things" label="Thing" />, reporter);
    const trigger = await screen.findByRole('button', { name: /select/i });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'alp' } });
    expect(reporter).not.toHaveBeenCalledWith(true);

    fireEvent.click(await screen.findByText('Alpha'));
    expect(reporter).toHaveBeenCalledWith(true);
  });

  it('retrying the rule set list does not mark dirty', async () => {
    const reporter = vi.fn();
    m.fetchWithAuth.mockResolvedValue({
      ok: false, status: 500, statusText: '500', json: async () => ({}), text: async () => '{}',
    } as unknown as Response);
    inShell(
      <RuleSetPicker
        value={[]}
        onChange={vi.fn()}
        policyOwner={{ orgId: '11111111-1111-4111-8111-111111111111', partnerId: null }}
        disabled={false}
        onBlockingChange={vi.fn()}
      />,
      reporter,
    );
    fireEvent.click(await screen.findByTestId('rule-set-picker-retry'));
    expect(reporter).not.toHaveBeenCalledWith(true);
  });
});
