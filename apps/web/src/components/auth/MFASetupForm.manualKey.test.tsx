import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MFASetupForm from './MFASetupForm';

/**
 * #5319 — the forced-MFA enrollment screen is mandatory: a QR image with no
 * text alternative locks out anyone whose authenticator lives on the device
 * already showing this page, and anyone using a screen reader.
 */

const SECRET = 'JBSWY3DPEHPK3PXP';
const GROUPED = 'JBSW Y3DP EHPK 3PXP';

afterEach(() => {
  // @ts-expect-error — test-only teardown of the stubbed clipboard
  delete navigator.clipboard;
});

describe('MFASetupForm — manual TOTP entry key (#5319)', () => {
  it('renders the secret in readable groups', () => {
    render(<MFASetupForm qrCodeDataUrl="data:image/png;base64,abc" totpSecret={SECRET} />);
    expect(screen.getByTestId('mfa-totp-secret').textContent).toBe(GROUPED);
  });

  it('copies the raw unspaced secret', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<MFASetupForm totpSecret={SECRET} />);

    fireEvent.click(screen.getByTestId('mfa-copy-totp-secret'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
  });

  it('reports a denied clipboard instead of pretending it copied', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) },
    });
    render(<MFASetupForm totpSecret={SECRET} />);

    fireEvent.click(screen.getByTestId('mfa-copy-totp-secret'));

    expect(await screen.findByTestId('mfa-copy-totp-secret-error')).toBeTruthy();
  });

  it('renders nothing extra when the API returned no secret', () => {
    render(<MFASetupForm qrCodeDataUrl="data:image/png;base64,abc" />);
    expect(screen.queryByTestId('mfa-totp-secret')).toBeNull();
  });
});
