import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

function setClipboard(writeText: ((value: string) => Promise<void>) | null) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

afterEach(() => {
  setClipboard(null);
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('names what it copies for assistive tech', () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" />);
    expect(screen.getByTestId('copy-ip')).toHaveAttribute('aria-label', expect.stringContaining('IP address'));
  });

  it('copies the value, announces it, and shows a transient confirmation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const onCopied = vi.fn();
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" onCopied={onCopied} />);

    await userEvent.click(screen.getByTestId('copy-ip'));

    expect(writeText).toHaveBeenCalledWith('10.0.0.9');
    await waitFor(() => expect(onCopied).toHaveBeenCalledWith(expect.stringContaining('Copied')));
    expect(screen.getByTestId('copy-ip').textContent).toContain('Copied');
  });

  it('clears the confirmation after two seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" />);

    await user.click(screen.getByTestId('copy-ip'));
    await waitFor(() => expect(screen.getByTestId('copy-ip').textContent).toContain('Copied'));

    await vi.advanceTimersByTimeAsync(2_100);
    await waitFor(() => expect(screen.getByTestId('copy-ip').textContent).not.toContain('Copied'));
  });

  it('does not claim success when the clipboard API is missing', async () => {
    setClipboard(null);
    const onCopied = vi.fn();
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" onCopied={onCopied} />);
    await userEvent.click(screen.getByTestId('copy-ip'));
    expect(onCopied).not.toHaveBeenCalled();
    expect(screen.getByTestId('copy-ip').textContent).not.toContain('Copied');
  });

  it('does not claim success when the write is rejected', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    const onCopied = vi.fn();
    render(<CopyButton value="10.0.0.9" label="IP address" testId="copy-ip" onCopied={onCopied} />);
    await userEvent.click(screen.getByTestId('copy-ip'));
    await waitFor(() => expect(screen.getByTestId('copy-ip').textContent).not.toContain('Copied'));
    expect(onCopied).not.toHaveBeenCalled();
  });
});
