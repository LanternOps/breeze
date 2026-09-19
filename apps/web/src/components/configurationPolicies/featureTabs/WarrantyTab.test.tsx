import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WarrantyTab from './WarrantyTab';
import { HP_CMSL_EULA_ID } from '@breeze/shared';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(async () => ({ id: 'link-1' }));
const removeMock = vi.fn(async () => true);

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import type { FeatureLink, FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

const CONSENT = {
  acceptedByUserId: 'user-7',
  acceptedAt: '2026-09-10T12:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

function link(id: string, inlineSettings: Record<string, unknown>): FeatureLink {
  return { id, featureType: 'warranty', featurePolicyId: null, inlineSettings };
}

function clickSave() {
  const button = screen
    .getAllByRole('button')
    .find((b) => /^save/i.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
  fireEvent.click(button);
}

function savedSettings(): Record<string, any> {
  const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: Record<string, any> }];
  return call[1].inlineSettings;
}

describe('WarrantyTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  // #5080: `featurePolicyId` means a standalone entity id (update ring, backup
  // profile, ...) — Warranty is inline settings, so it must never carry the
  // parent CONFIG policy's own id.
  it('sends featurePolicyId: null even when a parent config policy is linked', () => {
    render(<WarrantyTab {...baseProps} linkedPolicyId="parent-1" />);
    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const call = saveMock.mock.calls[0] as unknown as [unknown, { featurePolicyId: string | null }];
    expect(call[1].featurePolicyId).toBeNull();
  });

  it('defaults HP collection to off and says so in the payload', () => {
    render(<WarrantyTab {...baseProps} />);
    clickSave();

    expect(savedSettings().hpCmsl).toEqual({ enabled: false });
  });

  it('sends hpCmsl.enabled true once the box is ticked', () => {
    render(<WarrantyTab {...baseProps} />);
    fireEvent.click(screen.getByTestId('warranty-tab-hp-cmsl-toggle'));
    clickSave();

    expect(savedSettings().hpCmsl).toEqual({ enabled: true });
  });

  it('NEVER echoes a recorded consent back to the server (#5511 D3)', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-1', { enabled: true, warnDays: 90, criticalDays: 30, hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );
    clickSave();

    expect(savedSettings().hpCmsl).toEqual({ enabled: true });
    expect(JSON.stringify(savedSettings())).not.toContain('consent');
  });

  it('renders the consent explainer and, once recorded, who accepted', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-1', { hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );

    expect(screen.getByTestId('warranty-tab-hp-cmsl-consent')).toBeTruthy();
    expect(screen.getByTestId('warranty-tab-hp-cmsl-acceptance').textContent).toContain('user-7');
    expect(screen.queryByTestId('warranty-tab-hp-cmsl-superseded')).toBeNull();
  });

  it('flags an acceptance recorded against superseded terms (#5511 D2)', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-1', {
          hpCmsl: { enabled: true, consent: { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } },
        })}
      />,
    );

    expect(screen.getByTestId('warranty-tab-hp-cmsl-superseded')).toBeTruthy();
  });

  it('warns that overriding a collecting parent DROPS collection, and proves the drop (#5511 D5)', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-child', { enabled: true, warnDays: 14, criticalDays: 7 })}
        parentLink={link('link-parent', { hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );

    // The child link carries no hpCmsl block, so the tab shows collection OFF
    // and warns. Saving writes `false` — the inherited block is NOT merged in.
    expect(screen.getByTestId('warranty-tab-inheritance-warning')).toBeTruthy();
    clickSave();
    expect(savedSettings().hpCmsl).toEqual({ enabled: false });
  });

  it('Override of an inherited collecting link sends a fresh request with NO consent (#5511 D3)', () => {
    // Override POSTs a brand-new link built from the INHERITED state, which
    // carries the parent's recorded consent — the exact object the server
    // refuses with a coded 400. The new link must request collection only.
    render(
      <WarrantyTab
        {...baseProps}
        linkedPolicyId="parent-1"
        parentLink={link('link-parent', { enabled: true, warnDays: 90, criticalDays: 30, hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(saveMock).toHaveBeenCalled();
    const call = saveMock.mock.calls[0] as unknown as [string | null, { inlineSettings: Record<string, any> }];
    expect(call[0]).toBeNull();
    expect(call[1].inlineSettings.hpCmsl).toEqual({ enabled: true });
    expect(JSON.stringify(call[1].inlineSettings)).not.toContain('consent');
  });

  it('does not warn when the child keeps collection on', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-child', { hpCmsl: { enabled: true, consent: CONSENT } })}
        parentLink={link('link-parent', { hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );

    expect(screen.queryByTestId('warranty-tab-inheritance-warning')).toBeNull();
  });

  it('does not warn when the parent does not collect', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-child', { warnDays: 14 })}
        parentLink={link('link-parent', { enabled: true, warnDays: 90 })}
      />,
    );

    expect(screen.queryByTestId('warranty-tab-inheritance-warning')).toBeNull();
  });
});
