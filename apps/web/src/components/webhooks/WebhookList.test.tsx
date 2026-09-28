import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import WebhookList from './WebhookList';

describe('WebhookList status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', () => {
    render(<WebhookList webhooks={[]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});
