import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MFASettings from './MFASettings';

/**
 * #4471 — recovery codes are shown exactly once (enrollment, or a confirmed
 * regenerate). "Copy codes" used to fire `navigator.clipboard.writeText` with
 * no await, no catch and no confirmation: a denied clipboard (non-secure
 * context, permissions policy, Safari gesture rules) left the user with
 * nothing copied and nothing telling them so, on the only screen that will
 * ever show those codes.
 *
 * Contract pinned here: a successful copy confirms itself on the button, and
 * a failed copy says so inline while the codes are still on screen.
 */

const CODES = ['COPY-0001', 'COPY-0002'];

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

async function enrollSmsAndShowCodes() {
  render(
    <MFASettings
      enabled={false}
      smsAllowed
      phoneVerified
      phoneLast4="1234"
      onEnableSmsMfa={vi.fn().mockResolvedValue({ success: true, recoveryCodes: CODES })}
    />
  );
  const enableButtons = await screen.findAllByRole('button', { name: /^Enable$/i });
  fireEvent.click(enableButtons[enableButtons.length - 1]);
  const smsPassword = document.getElementById('mfa-sms-password') as HTMLInputElement;
  fireEvent.change(smsPassword, { target: { value: 'hunter2-pw' } });
  fireEvent.click(screen.getByRole('button', { name: /Enable SMS MFA/i }));
  await screen.findByText(CODES[0]);
}

describe('MFASettings — copy recovery codes gives feedback (#4471)', () => {
  it('confirms a successful copy on the button and copies every code', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    await enrollSmsAndShowCodes();

    fireEvent.click(screen.getByTestId('mfa-copy-recovery-codes'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODES.join('\n')));
    expect(await screen.findByText(/^Copied$/i)).toBeTruthy();
    // The codes stay on screen — the confirmation must not replace them.
    expect(screen.getByText(CODES[0])).toBeTruthy();
  });

  it('reports a denied clipboard inline instead of pretending it copied', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    await enrollSmsAndShowCodes();

    fireEvent.click(screen.getByTestId('mfa-copy-recovery-codes'));

    expect(await screen.findByTestId('mfa-copy-recovery-codes-error')).toBeTruthy();
    expect(screen.queryByText(/^Copied$/i)).toBeNull();
    expect(screen.getByText(CODES[1])).toBeTruthy();
  });

  it('reports a missing clipboard API the same way', async () => {
    // @ts-expect-error — simulate an insecure context with no clipboard at all
    delete navigator.clipboard;
    await enrollSmsAndShowCodes();

    fireEvent.click(screen.getByTestId('mfa-copy-recovery-codes'));

    expect(await screen.findByTestId('mfa-copy-recovery-codes-error')).toBeTruthy();
  });
});
