import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import FeatureTabShell from './FeatureTabShell';
import { FeatureDirtyReporterContext, FeatureReadOnlyContext, useFeatureDirty } from './featureEditing';
import { i18n, loadLocale } from '../../../lib/i18n';

// FeatureTabShell renders the footer controls for EVERY configuration-policy
// feature tab, so the disabled-state rules below apply fleet-wide, not just to
// the tab that surfaced the bug (#2336, OneDrive Helper).
describe('FeatureTabShell footer controls', () => {
  const baseProps = {
    title: 'OneDrive Helper',
    description: 'Auto-mount SharePoint libraries.',
    icon: <span data-testid="icon" />,
    isConfigured: false,
    children: <div data-testid="body" />,
  };

  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  const overrideButton = () => screen.getByRole('button', { name: /Override/i });

  it('disables Override while a save is in flight (#2336)', () => {
    // Override POSTs a brand-new link (persist(null)). Only Save was gated on
    // `saving`, so a double-click during the round-trip fired the create twice
    // — the second one landing on a policy that already had the link.
    const onOverride = vi.fn();
    render(
      <FeatureTabShell
        {...baseProps}
        saving
        isInherited
        onOverride={onOverride}
        onSave={vi.fn()}
      />,
    );

    expect(overrideButton()).toBeDisabled();
    fireEvent.click(overrideButton());
    expect(onOverride).not.toHaveBeenCalled();
  });

  it('still disables Override on client-side validation failure while idle', () => {
    render(
      <FeatureTabShell
        {...baseProps}
        saving={false}
        saveDisabled
        isInherited
        onOverride={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(overrideButton()).toBeDisabled();
  });

  it('enables Override when idle and valid', () => {
    const onOverride = vi.fn();
    render(
      <FeatureTabShell
        {...baseProps}
        saving={false}
        isInherited
        onOverride={onOverride}
        onSave={vi.fn()}
      />,
    );

    expect(overrideButton()).toBeEnabled();
    fireEvent.click(overrideButton());
    expect(onOverride).toHaveBeenCalledTimes(1);
  });

  describe('blocked save feedback (#11554)', () => {
    let scrollSpy: ReturnType<typeof vi.fn>;
    const originalScroll = Element.prototype.scrollIntoView;
    beforeEach(() => {
      scrollSpy = vi.fn();
      Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView;
    });
    afterEach(() => {
      Element.prototype.scrollIntoView = originalScroll;
    });

    it('focuses the first invalid field, scrolls to it, and says why next to Save', async () => {
      render(
        <FeatureTabShell {...baseProps} saving={false} onSave={vi.fn()}>
          <div>
            <input data-testid="bad-input" />
            <p data-field-error="">Add at least one backup path</p>
          </div>
        </FeatureTabShell>,
      );

      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      await waitFor(() => expect(screen.getByTestId('bad-input')).toHaveFocus());
      expect(scrollSpy).toHaveBeenCalled();
      expect(screen.getByTestId('save-blocked-hint')).toBeInTheDocument();
    });

    it('falls back to the error banner and shows the message next to Save', async () => {
      render(
        <FeatureTabShell
          {...baseProps}
          saving={false}
          error="Please select a backup configuration"
          onSave={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

      const hint = await screen.findByTestId('save-blocked-hint');
      expect(hint).toHaveTextContent('Please select a backup configuration');
      await waitFor(() => expect(screen.getByTestId('feature-tab-error')).toHaveFocus());
    });

    it('reveals a failure from a void-returning onSave once saving settles, and drops the hint when the error clears', async () => {
      const props = { ...baseProps, onSave: () => undefined };
      const { rerender } = render(<FeatureTabShell {...props} saving={false} />);
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      rerender(<FeatureTabShell {...props} saving />);
      rerender(<FeatureTabShell {...props} saving={false} error="Server said no" />);

      expect(await screen.findByTestId('save-blocked-hint')).toHaveTextContent('Server said no');
      await waitFor(() => expect(screen.getByTestId('feature-tab-error')).toHaveFocus());

      // error cleared (e.g. user fixed it / later save succeeded) -> hint goes away
      rerender(<FeatureTabShell {...props} saving={false} />);
      await waitFor(() => expect(screen.queryByTestId('save-blocked-hint')).toBeNull());
    });

    it('is not mute when onSave rejects', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(
        <FeatureTabShell
          {...baseProps}
          saving={false}
          onSave={() => Promise.reject(new Error('boom'))}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      expect(await screen.findByTestId('save-blocked-hint')).toHaveTextContent('boom');
      spy.mockRestore();
    });

    it('shows no hint when the save left nothing wrong', async () => {
      const onSave = vi.fn();
      render(<FeatureTabShell {...baseProps} saving={false} onSave={onSave} />);
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId('save-blocked-hint')).toBeNull();
    });
  });
});

describe('FeatureTabShell state badge (#12306, #12469)', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  const badge = (props: Partial<React.ComponentProps<typeof FeatureTabShell>>) => {
    render(
      <FeatureTabShell title="Patches" description="d" icon={<span />} isConfigured={false} saving={false} onSave={vi.fn()} {...props}>
        <div />
      </FeatureTabShell>,
    );
  };

  it('the badge reads Set here, From parent or Not set', async () => {
    await i18n.changeLanguage('en');
    badge({ isConfigured: true });
    expect(screen.getByText('Set here')).toBeInTheDocument();
    cleanup();
    badge({ isInherited: true });
    expect(screen.getByText('From parent')).toBeInTheDocument();
    cleanup();
    badge({});
    expect(screen.getByText('Not set')).toBeInTheDocument();
    cleanup();
    // The amber saved-but-not-deployed state is unchanged.
    badge({ isConfigured: true, configuredButInactive: true });
    expect(screen.getByText('Saved (not deployed)')).toBeInTheDocument();
  });

  it('the state badge text comes from i18n', async () => {
    await loadLocale('pt-BR');
    await i18n.changeLanguage('pt-BR');
    const expected = i18n.t('policies:configurationPolicies.featureStates.set_here.label');
    expect(expected).not.toMatch(/set_here/);
    expect(expected).not.toBe('Set here');
    badge({ isConfigured: true });
    expect(screen.getByText(expected)).toBeTruthy();
  });
});

describe('FeatureTabShell for a read-only viewer (#12469)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('renders no footer action and a disabled form', () => {
    render(
      <FeatureReadOnlyContext.Provider value>
        <FeatureTabShell
          title="Patches"
          description="d"
          icon={<span />}
          isConfigured
          saving={false}
          onSave={vi.fn()}
          onRemove={vi.fn()}
          onRevert={vi.fn()}
        >
          <input data-testid="field" />
        </FeatureTabShell>
      </FeatureReadOnlyContext.Provider>,
    );
    // Not rendered, not merely disabled.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('field')).toBeDisabled();
    // The state still shows.
    expect(screen.getByText('Set here')).toBeInTheDocument();
  });

  it('offers no Override on an inherited feature', () => {
    render(
      <FeatureReadOnlyContext.Provider value>
        <FeatureTabShell title="Patches" description="d" icon={<span />} isConfigured={false} isInherited onOverride={vi.fn()} saving={false} onSave={vi.fn()}>
          <div />
        </FeatureTabShell>
      </FeatureReadOnlyContext.Provider>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('FeatureTabShell unsaved changes (#12469)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  function Picker() {
    const { markDirty } = useFeatureDirty();
    return (
      <button type="button" data-testid="pick" onClick={markDirty}>
        pick
      </button>
    );
  }

  const renderShell = (props: Partial<React.ComponentProps<typeof FeatureTabShell>> = {}) => {
    const report = vi.fn();
    const utils = render(
      <FeatureDirtyReporterContext.Provider value={report}>
        <FeatureTabShell title="Patches" description="d" icon={<span />} isConfigured saving={false} onSave={vi.fn()} {...props}>
          <input data-testid="field" />
          <select data-testid="choice" defaultValue="a">
            <option value="a">a</option>
            <option value="b">b</option>
          </select>
          <Picker />
        </FeatureTabShell>
      </FeatureDirtyReporterContext.Provider>,
    );
    return { ...utils, report };
  };

  it('typing in a feature marks it dirty', () => {
    const { report } = renderShell();
    expect(report).not.toHaveBeenCalledWith(true);
    fireEvent.input(screen.getByTestId('field'), { target: { value: 'x' } });
    expect(report).toHaveBeenLastCalledWith(true);
  });

  it('a change event (select) marks it dirty', () => {
    const { report } = renderShell();
    fireEvent.change(screen.getByTestId('choice'), { target: { value: 'b' } });
    expect(report).toHaveBeenLastCalledWith(true);
  });

  it('a switch, checkbox, radio, option or pressed-button control marks it dirty', () => {
    for (const attrs of [
      { role: 'switch', 'aria-checked': 'false' },
      { role: 'checkbox', 'aria-checked': 'false' },
      { role: 'radio', 'aria-checked': 'false' },
      { role: 'option', 'aria-selected': 'false' },
      { 'aria-pressed': 'false' },
    ]) {
      const report = vi.fn();
      const { unmount } = render(
        <FeatureDirtyReporterContext.Provider value={report}>
          <FeatureTabShell title="Patches" description="d" icon={<span />} isConfigured saving={false} onSave={vi.fn()}>
            <button type="button" data-testid="control" {...attrs}>
              <span data-testid="inner">x</span>
            </button>
            <button type="button" data-testid="disclosure" aria-expanded="false">more</button>
          </FeatureTabShell>
        </FeatureDirtyReporterContext.Provider>,
      );
      fireEvent.click(screen.getByTestId('disclosure'));
      expect(report).not.toHaveBeenCalledWith(true);
      fireEvent.click(screen.getByTestId('inner'));
      expect(report).toHaveBeenLastCalledWith(true);
      unmount();
    }
  });

  it('a picker selection marks it dirty', () => {
    const { report } = renderShell();
    fireEvent.click(screen.getByTestId('pick'));
    expect(report).toHaveBeenLastCalledWith(true);
  });

  it('a successful save clears dirty', async () => {
    const { report } = renderShell({ onSave: () => Promise.resolve() });
    fireEvent.input(screen.getByTestId('field'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith(false));
  });

  it('a save that is still in flight, then fails, never clears dirty', async () => {
    // A void-returning tab: the shell sees `saving` go true, then settle with
    // an error banner. Dirty must survive the whole round trip.
    const report = vi.fn();
    const Host = ({ saving, error }: { saving: boolean; error?: string }) => (
      <FeatureDirtyReporterContext.Provider value={report}>
        <FeatureTabShell title="Patches" description="d" icon={<span />} isConfigured saving={saving} error={error} onSave={() => undefined}>
          <input data-testid="field" />
        </FeatureTabShell>
      </FeatureDirtyReporterContext.Provider>
    );
    const { rerender } = render(<Host saving={false} />);
    fireEvent.input(screen.getByTestId('field'), { target: { value: 'x' } });
    expect(report).toHaveBeenLastCalledWith(true);
    report.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    rerender(<Host saving />);
    await new Promise((r) => setTimeout(r, 5));
    rerender(<Host saving={false} error="Server said no" />);
    await screen.findByTestId('save-blocked-hint');
    expect(report).not.toHaveBeenCalledWith(false);
  });

  it('a save that throws keeps dirty', async () => {
    const { report } = renderShell({ onSave: () => Promise.reject(new Error('nope')) });
    fireEvent.input(screen.getByTestId('field'), { target: { value: 'x' } });
    expect(report).toHaveBeenLastCalledWith(true);
    report.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByTestId('save-blocked-hint');
    expect(report).not.toHaveBeenCalledWith(false);
  });

  it('reports clean when it unmounts', () => {
    const { report, unmount } = renderShell();
    fireEvent.input(screen.getByTestId('field'), { target: { value: 'x' } });
    unmount();
    expect(report).toHaveBeenLastCalledWith(false);
  });
});
