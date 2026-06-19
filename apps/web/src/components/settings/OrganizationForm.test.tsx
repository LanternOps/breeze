import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import OrganizationForm, { slugifyOrganizationName } from './OrganizationForm';

describe('slugifyOrganizationName', () => {
  it('lowercases, hyphenates, and trims punctuation', () => {
    expect(slugifyOrganizationName('Acme Corp')).toBe('acme-corp');
    expect(slugifyOrganizationName('  Globex, Inc. ')).toBe('globex-inc');
    expect(slugifyOrganizationName('Foo & Bar 42')).toBe('foo-bar-42');
  });
});

describe('OrganizationForm slug auto-derive', () => {
  it('auto-populates the slug from the name as the user types', async () => {
    const user = userEvent.setup();
    render(<OrganizationForm />);

    const nameInput = screen.getByLabelText('Organization name');
    const slugInput = screen.getByLabelText('Slug') as HTMLInputElement;

    await user.type(nameInput, 'Acme Corp');

    expect(slugInput.value).toBe('acme-corp');
  });

  it('submits successfully with only the name filled (derived slug is valid)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OrganizationForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Organization name'), 'Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Save organization' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Acme Corp',
      slug: 'acme-corp'
    });
  });

  it('stops syncing once the slug is manually edited', async () => {
    const user = userEvent.setup();
    render(<OrganizationForm />);

    const nameInput = screen.getByLabelText('Organization name');
    const slugInput = screen.getByLabelText('Slug') as HTMLInputElement;

    await user.type(nameInput, 'Acme');
    expect(slugInput.value).toBe('acme');

    // User overrides the slug by hand.
    await user.clear(slugInput);
    await user.type(slugInput, 'custom-slug');
    expect(slugInput.value).toBe('custom-slug');

    // Changing the name again must NOT overwrite the manual slug.
    await user.type(nameInput, ' Corporation');
    expect(slugInput.value).toBe('custom-slug');
  });

  it('does not overwrite an existing slug supplied via defaultValues (edit mode)', async () => {
    const user = userEvent.setup();
    render(<OrganizationForm defaultValues={{ name: 'Acme', slug: 'existing-slug' }} />);

    const nameInput = screen.getByLabelText('Organization name');
    const slugInput = screen.getByLabelText('Slug') as HTMLInputElement;

    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Org');

    expect(slugInput.value).toBe('existing-slug');
  });
});
