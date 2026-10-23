import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth }));

import OrganizationForm, { slugifyOrganizationName } from './OrganizationForm';

const ORG = '11111111-1111-4111-8111-111111111111';
const publication = (published: boolean) =>
  new Response(JSON.stringify({ data: { published, publicPath: published ? '/portal/trust/nw/acme' : null } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

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

  it('has no Max devices input and submits no maxDevices (#9260)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<OrganizationForm onSubmit={onSubmit} />);

    expect(screen.queryByLabelText(/max devices/i)).toBeNull();
    await user.type(screen.getByLabelText('Organization name'), 'Acme Corp');
    await user.click(screen.getByRole('button', { name: 'Save organization' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('maxDevices');
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

describe('OrganizationForm trust slug-rename warning (amendment 23)', () => {
  beforeEach(() => { fetchWithAuth.mockReset(); });

  it('warns only after the slug of an org with a published trust page is edited', async () => {
    fetchWithAuth.mockResolvedValue(publication(true));
    const user = userEvent.setup();
    render(<OrganizationForm orgId={ORG} defaultValues={{ name: 'Acme', slug: 'acme' }} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/orgs/${ORG}/trust-page/publication`));
    expect(screen.queryByTestId('org-slug-trust-warning')).toBeNull();

    const slugInput = screen.getByLabelText('Slug');
    await user.type(slugInput, '-co');
    expect((await screen.findByTestId('org-slug-trust-warning')).textContent).toBe(
      'This organization has a published trust page. Changing the slug changes its public URL, and the old link will stop working.'
    );

    // Back to the original slug: nothing will break, so no warning.
    await user.clear(slugInput);
    await user.type(slugInput, 'acme');
    expect(screen.queryByTestId('org-slug-trust-warning')).toBeNull();
  });

  it('does not warn for an org whose trust page is not published', async () => {
    fetchWithAuth.mockResolvedValue(publication(false));
    const user = userEvent.setup();
    render(<OrganizationForm orgId={ORG} defaultValues={{ name: 'Acme', slug: 'acme' }} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Slug'), '-co');
    expect(screen.queryByTestId('org-slug-trust-warning')).toBeNull();
  });

  it('create mode (no orgId) never asks for the publication status', async () => {
    const user = userEvent.setup();
    render(<OrganizationForm />);
    await user.type(screen.getByLabelText('Organization name'), 'Acme');
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.queryByTestId('org-slug-trust-warning')).toBeNull();
  });

  it('a failed status read shows no warning and does not break the form', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuth.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<OrganizationForm orgId={ORG} defaultValues={{ name: 'Acme', slug: 'acme' }} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Slug'), '-co');
    expect(screen.queryByTestId('org-slug-trust-warning')).toBeNull();
    warn.mockRestore();
  });
});
