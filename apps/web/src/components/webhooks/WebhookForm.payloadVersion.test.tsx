import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import WebhookForm from './WebhookForm';

const defaults = {
  name: 'Relay', url: 'https://hooks.example.com/alerts', events: ['alert.triggered'],
  authType: 'hmac' as const, secret: 'test-signing-secret',
};

describe('WebhookForm payload version', () => {
  it('defaults to v2 and submits the numeric version', async () => {
    const onSubmit = vi.fn();
    render(<WebhookForm defaultValues={defaults} onSubmit={onSubmit} />);
    expect((screen.getByTestId('webhook-payload-version-2') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ payloadVersion: 2 })));
  });

  it.each([1, 2] as const)('shows stored v%i and supports switching versions', async payloadVersion => {
    const onSubmit = vi.fn();
    render(<WebhookForm defaultValues={{ ...defaults, payloadVersion }} onSubmit={onSubmit} />);
    expect((screen.getByTestId(`webhook-payload-version-${payloadVersion}`) as HTMLInputElement).checked).toBe(true);
    const next = payloadVersion === 1 ? 2 : 1;
    fireEvent.click(screen.getByTestId(`webhook-payload-version-${next}`));
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ payloadVersion: next })));
  });
});
