import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PortalAccessPolicyForm } from './PortalAccessPolicyForm';
import { makePolicyView } from './viewFixture';
import type { PortalAccessPolicyView } from '@breeze/shared';
import type { PortalAccessPolicyDraft } from './types';

function renderForm(view: PortalAccessPolicyView, draft: PortalAccessPolicyDraft = {}, extra: Partial<Parameters<typeof PortalAccessPolicyForm>[0]> = {}) {
  const onChange = vi.fn();
  render(<PortalAccessPolicyForm view={view} draft={draft} onChange={onChange} {...extra} />);
  return onChange;
}

const radio = (id: string) => screen.getByTestId(id) as HTMLInputElement;

describe('PortalAccessPolicyForm', () => {
  it('shows the Password row with the inherited value and source, and the always-on invites row', () => {
    renderForm(makePolicyView());
    expect(radio('portal-access-policy-password-inherit').checked).toBe(true);
    expect(screen.getByText('Inherit — Allowed (Partner default)')).toBeInTheDocument();
    expect(screen.getByTestId('portal-access-policy-invites')).toHaveTextContent('Always on');
  });

  it('form hides Microsoft/Google/self-registration rows when capabilities are off', () => {
    renderForm(makePolicyView());
    expect(screen.queryByTestId('portal-access-policy-microsoft')).toBeNull();
    expect(screen.queryByTestId('portal-access-policy-google')).toBeNull();
    expect(screen.queryByTestId('portal-access-policy-self-registration')).toBeNull();
    expect(screen.queryByTestId('portal-access-policy-sso-new-person')).toBeNull();
  });

  it('shows each row once the deployment can run it', () => {
    renderForm(makePolicyView({ capabilities: { entra: true, google: true, selfRegistration: true } }));
    expect(screen.getByTestId('portal-access-policy-microsoft')).toBeInTheDocument();
    expect(screen.getByTestId('portal-access-policy-google')).toBeInTheDocument();
    expect(screen.getByTestId('portal-access-policy-self-registration')).toBeInTheDocument();
    expect(screen.getByTestId('portal-access-policy-sso-new-person')).toBeInTheDocument();
  });

  it('sso_only option is disabled with a hint while no SSO method is on', () => {
    renderForm(makePolicyView());
    expect(radio('portal-access-policy-password-sso_only').disabled).toBe(true);
    expect(screen.getByText('Available once Microsoft or Google sign-in is turned on.')).toBeInTheDocument();
  });

  it('sso_only option is enabled once the draft turns an available SSO method on', () => {
    renderForm(makePolicyView({ capabilities: { entra: true }, entraTenantProven: true }), { entraEnabled: true });
    expect(radio('portal-access-policy-password-sso_only').disabled).toBe(false);
  });

  it('an inherited SSO method also enables sso_only', () => {
    renderForm(makePolicyView({ capabilities: { google: true }, inherited: { googleEnabled: true } }));
    expect(radio('portal-access-policy-password-sso_only').disabled).toBe(false);
  });

  it('an inherited SSO method the deployment cannot run does not enable sso_only', () => {
    renderForm(makePolicyView({ inherited: { entraEnabled: true } }));
    expect(radio('portal-access-policy-password-sso_only').disabled).toBe(true);
  });

  it('shows the fallback notice', () => {
    renderForm(makePolicyView({ values: { passwordMode: 'sso_only' }, passwordModeFallback: true }));
    expect(screen.getByTestId('portal-access-policy-fallback')).toHaveTextContent(
      'Password sign-in is on because no Microsoft or Google sign-in is enabled.',
    );
  });

  it('no fallback notice when the policy is not falling back', () => {
    renderForm(makePolicyView());
    expect(screen.queryByTestId('portal-access-policy-fallback')).toBeNull();
  });

  it('emits a draft with the changed field, and drops it when set back to the saved value', () => {
    const view = makePolicyView({ values: { passwordMode: 'allowed' } });
    const onChange = renderForm(view);
    fireEvent.click(radio('portal-access-policy-password-inherit'));
    expect(onChange).toHaveBeenLastCalledWith({ passwordMode: null });
    onChange.mockClear();
    fireEvent.click(radio('portal-access-policy-password-allowed'));
    // Already the saved value: the radio is checked and nothing changes.
    expect(onChange).not.toHaveBeenCalled();
  });

  it('read-only when canEdit is false', () => {
    renderForm(makePolicyView({ kind: 'partner', canEdit: false, capabilities: { entra: true } }));
    expect(screen.getByTestId('portal-access-policy-read-only')).toBeInTheDocument();
    expect(radio('portal-access-policy-password-allowed').disabled).toBe(true);
    expect(radio('portal-access-policy-microsoft-on').disabled).toBe(true);
  });

  it('partner view has no inherit radio and tags the Breeze default', () => {
    renderForm(makePolicyView({ kind: 'partner' }));
    expect(screen.queryByTestId('portal-access-policy-password-inherit')).toBeNull();
    expect(radio('portal-access-policy-password-allowed').checked).toBe(true);
    expect(screen.getByTestId('portal-access-policy-password-source')).toHaveTextContent('Breeze default');
  });

  it('shows Requests (n) only with pending requests and calls onShowRequests', () => {
    const onShowRequests = vi.fn();
    renderForm(makePolicyView(), {}, { pendingRequestCount: 3, onShowRequests });
    fireEvent.click(screen.getByTestId('portal-access-policy-requests'));
    expect(screen.getByTestId('portal-access-policy-requests')).toHaveTextContent('Requests (3)');
    expect(onShowRequests).toHaveBeenCalledTimes(1);
  });

  it('no Requests button without pending requests', () => {
    renderForm(makePolicyView(), {}, { pendingRequestCount: 0, onShowRequests: vi.fn() });
    expect(screen.queryByTestId('portal-access-policy-requests')).toBeNull();
  });

  it('shows a server field error under its row', () => {
    renderForm(makePolicyView(), {}, { fieldErrors: { passwordMode: 'Turn on Microsoft or Google sign-in first.' } });
    expect(screen.getByTestId('portal-access-policy-passwordMode-error')).toHaveTextContent('Turn on Microsoft or Google sign-in first.');
  });

  // W4 (#11381)
  it('session hours row hidden without an SSO capability and saves a number', () => {
    renderForm(makePolicyView());
    expect(screen.queryByTestId('portal-access-policy-session-hours')).toBeNull();
    cleanup();

    const view = makePolicyView({ capabilities: { entra: true }, inherited: { ssoSessionMaxHours: 12 } });
    const onChange = renderForm(view);
    const input = screen.getByTestId('portal-access-policy-session-hours') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toContain('12');
    fireEvent.change(input, { target: { value: '8' } });
    expect(onChange).toHaveBeenLastCalledWith({ ssoSessionMaxHours: 8 });
  });

  it('session hours: clearing inherits (null); out-of-range or fractional values stay out of the draft', () => {
    const view = makePolicyView({ capabilities: { entra: true }, values: { ssoSessionMaxHours: 4 } });
    const onChange = renderForm(view);
    const input = screen.getByTestId('portal-access-policy-session-hours') as HTMLInputElement;
    expect(input.value).toBe('4');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ ssoSessionMaxHours: null });
    onChange.mockClear();
    fireEvent.change(input, { target: { value: '169' } });
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.change(input, { target: { value: '0' } });
    // An invalid value never reaches the draft: the field goes back to its saved value.
    for (const [d] of onChange.mock.calls) expect(d).not.toHaveProperty('ssoSessionMaxHours');
    expect(screen.getByTestId('portal-access-policy-ssoSessionMaxHours-error')).toHaveTextContent('Enter a whole number of hours from 1 to 168.');
  });

  it('session hours: typing past the range drops the valid prefix from the draft and reports invalid', () => {
    const onInvalidChange = vi.fn();
    const view = makePolicyView({ capabilities: { entra: true } });
    const onChange = renderForm(view, {}, { onInvalidChange });
    const input = screen.getByTestId('portal-access-policy-session-hours') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '20' } });
    expect(onChange).toHaveBeenLastCalledWith({ ssoSessionMaxHours: 20 });
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
    // The draft prop is not re-rendered here; the form computes from the draft it was given ({}).
    fireEvent.change(input, { target: { value: '200' } });
    expect(onChange).toHaveBeenLastCalledWith({});
    expect(onInvalidChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(input, { target: { value: '24' } });
    expect(onChange).toHaveBeenLastCalledWith({ ssoSessionMaxHours: 24 });
    expect(onInvalidChange).toHaveBeenLastCalledWith(false);
  });

  it('renders the entra slot under the Microsoft row only when the row is visible', () => {
    renderForm(makePolicyView(), {}, { entraSlot: <div data-testid="slot">tenant</div> });
    expect(screen.queryByTestId('slot')).toBeNull();
    cleanup();
    renderForm(makePolicyView({ capabilities: { entra: true } }), {}, { entraSlot: <div data-testid="slot">tenant</div> });
    expect(screen.getByTestId('slot')).toBeInTheDocument();
  });

  it('sso_only stays disabled while Microsoft is on but the org tenant is not proven', () => {
    renderForm(makePolicyView({ capabilities: { entra: true }, inherited: { entraEnabled: true }, entraTenantProven: false }));
    expect(radio('portal-access-policy-password-sso_only').disabled).toBe(true);
    cleanup();
    renderForm(makePolicyView({ capabilities: { entra: true }, inherited: { entraEnabled: true }, entraTenantProven: true }));
    expect(radio('portal-access-policy-password-sso_only').disabled).toBe(false);
  });
});
