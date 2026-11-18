import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import HelperTab from './HelperTab';

const saveMock = vi.hoisted(() => vi.fn(async () => ({ id: 'link-1' })));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: vi.fn(async () => true),
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import type { FeatureTabProps, FeatureLink } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

const helperLink = (enabled: boolean): FeatureLink => ({
  id: 'link-1',
  featureType: 'helper',
  featurePolicyId: null,
  inlineSettings: { enabled },
});

describe('HelperTab', () => {
  // OD-11 (#10190): a helper policy being created deploys Breeze Assist unless
  // the technician turns it off. Existing links keep what they store.
  it('defaults deploy on for a new helper policy and saves enabled: true', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} />);
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.every((c) => !c.disabled)).toBe(true);
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: Record<string, unknown> }];
    expect(call[1].inlineSettings.enabled).toBe(true);
  });

  it('exposes the deploy toggle as a named switch with its state (on for a new policy, off for a stored off)', () => {
    const { unmount } = render(<HelperTab {...baseProps} />);
    expect(screen.getByRole('switch', { name: 'Deploy Breeze Assist to devices' }).getAttribute('aria-checked')).toBe('true');
    unmount();
    render(<HelperTab {...baseProps} existingLink={helperLink(false)} />);
    expect(screen.getByRole('switch', { name: 'Deploy Breeze Assist to devices' }).getAttribute('aria-checked')).toBe('false');
  });

  it('shows deploy off when a link without settings arrives after the first render', () => {
    const { rerender } = render(<HelperTab {...baseProps} />);
    rerender(<HelperTab {...baseProps} existingLink={{ ...helperLink(false), inlineSettings: null }} />);
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.every((c) => c.disabled)).toBe(true);
  });

  it('shows deploy off for an existing link that does not decide enabled', () => {
    render(<HelperTab {...baseProps} existingLink={{ ...helperLink(false), inlineSettings: { showOpenPortal: true } }} />);
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.every((c) => c.disabled)).toBe(true);
  });

  it('keeps tray-menu options visible but disabled when deploy is off (#1863)', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(false)} />);

    // The toggles are discoverable (rendered), not hidden...
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    // The three menu items. The tray icon itself is always shown (#8138).
    expect(checkboxes.length).toBe(3);
    // ...but disabled until deploy is enabled, with a hint explaining why.
    expect(checkboxes.every((c) => c.disabled)).toBe(true);
    expect(screen.getByText(/Enable "Deploy Breeze Assist to devices" above/i)).toBeTruthy();
  });

  it('shows a "Saved (not deployed)" badge when a link exists but deploy is off', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(false)} />);
    expect(screen.getByText('Saved (not deployed)')).toBeTruthy();
    expect(screen.queryByText('Configured')).toBeNull();
  });

  it('shows "Configured" and enables the toggles when deploy is on', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.queryByText('Saved (not deployed)')).toBeNull();
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.every((c) => !c.disabled)).toBe(true);
  });

  it('has no tray-icon toggle — the tray icon is always shown (#8138)', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    expect(screen.queryByTestId('helper-show-tray-icon')).toBeNull();
  });

  it('does not re-save a legacy showTrayIcon key from an existing link (#8138)', async () => {
    saveMock.mockClear();
    render(
      <HelperTab
        {...baseProps}
        existingLink={{
          ...helperLink(true),
          inlineSettings: { enabled: true, showTrayIcon: false },
        }}
      />,
    );

    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [
      unknown,
      { inlineSettings: Record<string, unknown> },
    ];
    expect(call[1].inlineSettings).not.toHaveProperty('showTrayIcon');
    expect(call[1].inlineSettings.enabled).toBe(true);
  });

  it('renders the lifecycle-mode select defaulting to auto', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    const select = screen.getByTestId('helper-lifecycle-mode') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('auto');
  });

  it('includes lifecycleMode in the saved inlineSettings when set to on-demand', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    fireEvent.change(screen.getByTestId('helper-lifecycle-mode'), {
      target: { value: 'on-demand' },
    });
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [
      unknown,
      { inlineSettings: Record<string, unknown> },
    ];
    expect(call[1].inlineSettings.lifecycleMode).toBe('on-demand');
  });

  it('omits lifecycleMode from the saved inlineSettings when left on auto', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [
      unknown,
      { inlineSettings: Record<string, unknown> },
    ];
    expect('lifecycleMode' in call[1].inlineSettings).toBe(false);
  });

  it('has an Endpoint messaging toggle that defaults off and saves endpointMessaging.enabled', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    const toggle = screen.getByTestId('helper-endpoint-messaging');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Endpoint messaging')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: Record<string, unknown> }];
    expect(call[1].inlineSettings.endpointMessaging).toEqual({ enabled: true, allowUserReply: true });
  });

  it('saves endpointMessaging.enabled false by default and reads a stored true', async () => {
    saveMock.mockClear();
    const { unmount } = render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: Record<string, unknown> }];
    expect(call[1].inlineSettings.endpointMessaging).toEqual({ enabled: false, allowUserReply: true });
    unmount();

    render(
      <HelperTab
        {...baseProps}
        existingLink={{ ...helperLink(true), inlineSettings: { enabled: true, endpointMessaging: { enabled: true } } }}
      />,
    );
    expect(screen.getByTestId('helper-endpoint-messaging').getAttribute('aria-checked')).toBe('true');
  });

  it('has an "Allow replies from the user" switch that defaults on and saves with enabled (#8743)', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    const toggle = screen.getByTestId('helper-allow-user-reply');
    expect(screen.getByText('Allow replies from the user')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('helper-endpoint-messaging'));
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: Record<string, unknown> }];
    expect(call[1].inlineSettings.endpointMessaging).toEqual({ enabled: true, allowUserReply: false });
  });

  it('reads a stored allowUserReply:false and treats an absent value as on (#8743)', () => {
    const { unmount } = render(
      <HelperTab
        {...baseProps}
        existingLink={{ ...helperLink(true), inlineSettings: { enabled: true, endpointMessaging: { enabled: true, allowUserReply: false } } }}
      />,
    );
    expect(screen.getByTestId('helper-allow-user-reply').getAttribute('aria-checked')).toBe('false');
    unmount();
    render(
      <HelperTab
        {...baseProps}
        existingLink={{ ...helperLink(true), inlineSettings: { enabled: true, endpointMessaging: { enabled: true } } }}
      />,
    );
    expect(screen.getByTestId('helper-allow-user-reply').getAttribute('aria-checked')).toBe('true');
  });

  // #5080: `featurePolicyId` means a standalone entity id — Breeze Assist is
  // inline settings, so it must never carry the parent CONFIG policy's id.
  it('sends featurePolicyId: null even when a parent config policy is linked', async () => {
    saveMock.mockClear();
    render(<HelperTab {...baseProps} linkedPolicyId="parent-1" />);
    fireEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [unknown, { featurePolicyId: string | null }];
    expect(call[1].featurePolicyId).toBeNull();
  });
  describe('branding', () => {
    const lastPayload = () => {
      const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: Record<string, unknown> }];
      return call[1].inlineSettings;
    };
    const type = (field: string, value: string) =>
      fireEvent.change(screen.getByTestId(`helper-branding-${field}`), { target: { value } });

    it('renders text and colour fields and no asset, URL, CSS or HTML field', () => {
      render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
      const ids = Array.from(
        screen.getByTestId('helper-branding').querySelectorAll('[data-testid^="helper-branding-"]'),
      ).map((e) => e.getAttribute('data-testid'));
      expect(ids).toEqual(
        [
          'displayName', 'companyName', 'welcomeTitle', 'welcomeMessage',
          'supportLabel', 'portalLabel', 'primaryColor', 'accentColor',
        ].map((f) => `helper-branding-${f}`),
      );
    });

    it('omits branding from the payload when every field is blank', async () => {
      saveMock.mockClear();
      render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
      type('displayName', 'x');
      type('displayName', '');
      fireEvent.click(screen.getByText('Save'));
      await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
      expect('branding' in lastPayload()).toBe(false);
    });

    it('saves only filled fields; blank fields are omitted (inherit)', async () => {
      saveMock.mockClear();
      render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
      type('displayName', 'Example Assist');
      type('primaryColor', '#1A3C8F');
      fireEvent.click(screen.getByText('Save'));
      await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
      expect(lastPayload().branding).toEqual({ displayName: 'Example Assist', primaryColor: '#1A3C8F' });
      expect(Object.keys(lastPayload())).not.toEqual(
        expect.arrayContaining(['logoUrl', 'customCss', 'html']),
      );
    });

    it('loads stored branding and drops unknown stored keys on the next save', async () => {
      saveMock.mockClear();
      render(
        <HelperTab
          {...baseProps}
          existingLink={{
            ...helperLink(true),
            inlineSettings: { enabled: true, branding: { companyName: 'Contoso', logoUrl: 'https://x/y.png' } },
          }}
        />,
      );
      expect((screen.getByTestId('helper-branding-companyName') as HTMLInputElement).value).toBe('Contoso');
      fireEvent.click(screen.getByText('Save'));
      await vi.waitFor(() => expect(saveMock).toHaveBeenCalled());
      expect(lastPayload().branding).toEqual({ companyName: 'Contoso' });
    });

    it('shows the inherited value and its source for a blank field on an own override', () => {
      render(
        <HelperTab
          {...baseProps}
          existingLink={helperLink(true)}
          parentLink={{ ...helperLink(true), id: 'p', inlineSettings: { enabled: true, branding: { displayName: 'Parent Assist' } } }}
        />,
      );
      expect(screen.getByText(/Inherited from parent policy: Parent Assist/)).toBeTruthy();
    });

    it('counts length by code points: 60 emoji pass, 61 fail and block save', async () => {
      saveMock.mockClear();
      render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
      type('displayName', '😀'.repeat(60));
      expect(screen.queryByTestId('helper-branding-displayName-error')).toBeNull();
      type('displayName', '😀'.repeat(61));
      expect(screen.getByTestId('helper-branding-displayName-error')).toBeTruthy();
      fireEvent.click(screen.getByText('Save'));
      await new Promise((r) => setTimeout(r, 20));
      expect(saveMock).not.toHaveBeenCalled();
    });

    it.each([
      ['red'],
      ['#FFF'],
      ['#12345G'],
      ['#1A3C8F80'],
      ['rgb(0,0,0)'],
    ])('rejects non-strict colour %s', (value) => {
      render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
      type('accentColor', value);
      expect(screen.getByTestId('helper-branding-accentColor-error')).toBeTruthy();
    });

    it('rejects an unreadable colour and control or bidi characters', () => {
      render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
      type('primaryColor', '#808080');
      expect(screen.getByTestId('helper-branding-primaryColor-error')).toBeTruthy();
      type('welcomeTitle', 'Hi\u202Ethere');
      expect(screen.getByTestId('helper-branding-welcomeTitle-error')).toBeTruthy();
      // welcomeMessage is a textarea, the only field that can carry a line break.
      type('welcomeMessage', 'Hi\nthere');
      expect(screen.getByTestId('helper-branding-welcomeMessage-error')).toBeTruthy();
    });
  });
});
