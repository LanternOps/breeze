import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MFASettings from './MFASettings';

/**
 * #5319 — the TOTP enrollment screen rendered the QR image and nothing else.
 * A user enrolling on the same device the browser is on (no second camera),
 * or anyone using a screen reader, had no way to complete enrollment: the
 * secret the API already returns was never shown. Standard authenticator UX is
 * a "can't scan this?" manual-entry key with a copy action.
 *
 * Contract pinned here: the secret is rendered in readable groups, copies as
 * the raw unspaced key an authenticator app accepts, confirms a successful
 * copy, and says so inline when the clipboard refuses.
 */

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DP';
const GROUPED = 'JBSW Y3DP EHPK 3PXP JBSW Y3DP';

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  // @ts-expect-error — test-only teardown of the stubbed clipboard
  delete navigator.clipboard;
});

function renderSetup(props: Record<string, unknown> = {}) {
  return render(
    <MFASettings
      enabled={false}
      hasPassword
      ssoSetupReady
      qrCodeDataUrl="data:image/png;base64,abc"
      totpSecret={SECRET}
      onEnable={vi.fn()}
      {...props}
    />
  );
}

describe('MFASettings — manual TOTP entry key (#5319)', () => {
  it('renders the secret in readable groups alongside the QR code', async () => {
    renderSetup();

    await screen.findByText(/Set up authenticator/i);
    const key = screen.getByTestId('mfa-totp-secret');
    expect(key.textContent).toBe(GROUPED);
  });

  it('copies the raw unspaced secret and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    renderSetup();

    await screen.findByText(/Set up authenticator/i);
    fireEvent.click(screen.getByTestId('mfa-copy-totp-secret'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    expect(screen.getByTestId('mfa-totp-secret').textContent).toBe(GROUPED);
  });

  it('reports a denied clipboard inline instead of pretending it copied', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    renderSetup();

    await screen.findByText(/Set up authenticator/i);
    fireEvent.click(screen.getByTestId('mfa-copy-totp-secret'));

    expect(await screen.findByTestId('mfa-copy-totp-secret-error')).toBeTruthy();
  });

  it('still shows the manual key when the QR image is unavailable', async () => {
    renderSetup({ qrCodeDataUrl: undefined });

    await screen.findByText(/Set up authenticator/i);
    expect(screen.getByTestId('mfa-totp-secret').textContent).toBe(GROUPED);
  });

  it('omits the manual-entry block entirely when no secret was returned', async () => {
    renderSetup({ totpSecret: undefined });

    await screen.findByText(/Set up authenticator/i);
    expect(screen.queryByTestId('mfa-totp-secret')).toBeNull();
    expect(screen.queryByTestId('mfa-copy-totp-secret')).toBeNull();
  });
});
