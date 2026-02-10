import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import OrgBrandingEditor from './OrgBrandingEditor';

describe('OrgBrandingEditor', () => {
  it('opens a live preview modal using current branding inputs', async () => {
    render(<OrgBrandingEditor organizationName="Acme Systems" />);

    const portalBlock = screen.getByText('Portal subdomain').parentElement;
    const subdomainInput = portalBlock?.querySelector('input');
    expect(subdomainInput).not.toBeNull();

    fireEvent.change(subdomainInput as HTMLInputElement, { target: { value: 'acme-it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await screen.findByText('Portal preview');
    expect(screen.queryByText('Preview opened in a mock window.')).toBeNull();
    expect(screen.getAllByText('https://acme-it.breeze.app').length).toBeGreaterThan(0);
    expect(screen.queryByText('Acme Systems Portal')).not.toBeNull();
  });
});
