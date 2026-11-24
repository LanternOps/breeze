import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FeatureTabShell from './FeatureTabShell';
import { FeaturePolicyContext, type FeaturePolicyInfo } from './featurePolicyContext';
import { FeatureReadOnlyContext } from './featureEditing';
import { i18n } from '../../../lib/i18n';
import type { ConfigPolicyReach } from '../appliesTo/appliesToApi';

// What a save, a Remove and a Reset to parent change on devices (plan W03c
// F3; spec "Save model": "Save · reaches 212 devices").
const reach = (direct: number, throughChildren = 0, partial = false): ConfigPolicyReach => ({
  direct,
  throughChildren,
  organizations: 1,
  ...(partial ? { partial: true as const } : {}),
});

const info = (over: Partial<FeaturePolicyInfo['reach'] & object> = {}, parent: FeaturePolicyInfo['parent'] = null): FeaturePolicyInfo => ({
  reach: { status: 'active', reach: reach(200, 12), childPolicyCount: 0, ...over },
  parent,
});

const shell = (value: FeaturePolicyInfo | null, props: Partial<React.ComponentProps<typeof FeatureTabShell>> = {}) =>
  render(
    <FeaturePolicyContext.Provider value={value}>
      <FeatureTabShell title="Patches" description="d" icon={<span />} isConfigured saving={false} onSave={vi.fn()} {...props}>
        <input data-testid="field" />
      </FeatureTabShell>
    </FeaturePolicyContext.Provider>,
  );

const saveButton = () => screen.getByRole('button', { name: /^save/i });

describe('FeatureTabShell reach (#12470)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('the save reach line shows direct plus through-children on an active policy', () => {
    shell(info());
    expect(saveButton()).toHaveTextContent('Save · reaches 212 devices');
  });

  it("an unapplied parent's saves carry its through-children reach", () => {
    shell(info({ status: 'inactive', reach: reach(0, 148), childPolicyCount: 3 }));
    expect(saveButton()).toHaveTextContent('Save · in use through 3 policies · 148 devices');
  });

  it('a partial reach reads "at least"', () => {
    shell(info({ reach: reach(200, 12, true) }));
    expect(saveButton()).toHaveTextContent('Save · reaches at least 212 devices');
  });

  it('reads plain Save when the reach is unknown, the page gives none, or the save reaches nothing', () => {
    const view = shell(null);
    expect(saveButton()).toHaveTextContent(/^Save$/);
    view.unmount();
    const unknown = shell(info({ reach: null }));
    expect(saveButton()).toHaveTextContent(/^Save$/);
    unknown.unmount();
    shell(info({ status: 'inactive', reach: reach(40), childPolicyCount: 0 }));
    expect(saveButton()).toHaveTextContent(/^Save$/);
  });

  it('Remove says what changes on devices', () => {
    shell(info(), { onRemove: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Not set');
    expect(dialog).toHaveTextContent('This policy reaches 212 devices');
  });

  it("Reset to parent on a parent says its children's devices get the parent's settings", () => {
    shell(info({ status: 'inactive', reach: reach(0, 148), childPolicyCount: 3 }), { onRevert: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /reset to parent/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('3 policies, 148 devices');
    expect(dialog).toHaveTextContent("parent policy's Patches settings");
  });

  it('Remove on an inactive policy nothing is based on says no device changes now', () => {
    shell(info({ status: 'inactive', reach: reach(40), childPolicyCount: 0 }), { onRemove: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    expect(screen.getByRole('dialog')).toHaveTextContent('No device changes now');
  });

  it('an unknown reach adds no device claim to the confirm', () => {
    shell(info({ reach: null }), { onRemove: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveTextContent('reaches');
    expect(dialog).not.toHaveTextContent('No device changes now');
  });

  it('an inherited feature names its parent, with Open when the caller may open it', () => {
    const view = shell(info({}, { name: 'Standard Workstation', href: '/configuration-policies/p-1' }), { isInherited: true });
    const line = screen.getByTestId('feature-tab-from-parent');
    expect(line).toHaveTextContent('From Standard Workstation');
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/configuration-policies/p-1');
    view.unmount();
    shell(info({}, { name: 'MSP Baseline', href: null }), { isInherited: true });
    expect(screen.getByTestId('feature-tab-from-parent')).toHaveTextContent('From MSP Baseline');
    expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
  });

  it('a feature set here names no parent', () => {
    shell(info({}, { name: 'Standard Workstation', href: '/configuration-policies/p-1' }));
    expect(screen.queryByTestId('feature-tab-from-parent')).toBeNull();
  });

  it('a read-only viewer still sees where an inherited feature comes from', () => {
    render(
      <FeatureReadOnlyContext.Provider value>
        <FeaturePolicyContext.Provider value={info({}, { name: 'Standard Workstation', href: null })}>
          <FeatureTabShell title="Patches" description="d" icon={<span />} isConfigured isInherited saving={false} onSave={vi.fn()} onUnlock={vi.fn()}>
            <input />
          </FeatureTabShell>
        </FeaturePolicyContext.Provider>
      </FeatureReadOnlyContext.Provider>,
    );
    expect(screen.getByTestId('feature-tab-from-parent')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
