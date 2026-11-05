import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SiteModals from './SiteModals';

const SITE = { id: 'site-1', name: 'Headquarters', timezone: 'UTC', deviceCount: 7 };

function renderModals(mode: 'add' | 'edit' | 'delete', overrides?: Partial<Parameters<typeof SiteModals>[0]>) {
  const onClose = vi.fn();
  const onConfirmDelete = vi.fn();
  render(
    <SiteModals
      mode={mode}
      selectedSite={SITE}
      guidingFirstSite={false}
      orgName="Acme Corp"
      submitting={false}
      onSubmit={vi.fn()}
      onClose={onClose}
      onConfirmDelete={onConfirmDelete}
      getSiteFormDefaults={() => ({
        name: SITE.name,
        timezone: SITE.timezone,
        addressLine1: '',
        addressLine2: '',
        city: '',
        state: '',
        postalCode: '',
        country: '',
        contactName: '',
        contactEmail: '',
        contactPhone: '',
      })}
      {...overrides}
    />,
  );
  return { onClose, onConfirmDelete };
}

describe('SiteModals — dialog semantics', () => {
  it('delete on an empty site names the site and the consequence, and Delete fires onConfirmDelete', () => {
    const { onConfirmDelete } = renderModals('delete', { selectedSite: { ...SITE, deviceCount: 0 } });

    const dialog = screen.getByRole('dialog', { name: 'Delete Site' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('Delete Headquarters? This removes the site permanently and cannot be undone.');

    const confirm = screen.getByTestId('site-delete-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(confirm);
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
  });

  it('delete on a site that still has devices explains the block and disables Delete', () => {
    const { onConfirmDelete } = renderModals('delete');

    expect(screen.getByRole('dialog', { name: 'Delete Site' })).toHaveTextContent(
      'Headquarters still has 7 devices. Move them to another site before deleting this one.',
    );
    const confirm = screen.getByTestId('site-delete-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirm);
    expect(onConfirmDelete).not.toHaveBeenCalled();
  });

  it('singular device copy', () => {
    renderModals('delete', { selectedSite: { ...SITE, deviceCount: 1 } });
    expect(screen.getByRole('dialog', { name: 'Delete Site' })).toHaveTextContent(
      'Headquarters still has 1 device. Move it to another site before deleting this one.',
    );
  });

  it('delete dialog closes on Escape', () => {
    const { onClose } = renderModals('delete');

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Delete Site' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('delete dialog ignores Escape while the delete is in flight', () => {
    const { onClose } = renderModals('delete', { selectedSite: { ...SITE, deviceCount: 0 }, submitting: true });

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Delete Site' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('add renders a dialog labelled by its visible heading', () => {
    renderModals('add', { selectedSite: null });

    expect(screen.getByRole('dialog', { name: 'Add Site' })).toHaveAttribute('aria-modal', 'true');
  });

  it('edit dialog ignores Escape while a submit is in flight', () => {
    const { onClose } = renderModals('edit', { submitting: true });

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Edit Site' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  describe('fleet-view org picker (#9794)', () => {
    const ORGS = [{ id: 'org-a', name: 'Alpha Co' }, { id: 'org-b', name: 'Bravo Ltd' }];
    const pickerModals = (value: string | null, onSubmit: () => void, onChange: (id: string | null) => void) => (
      <SiteModals
        mode="add"
        selectedSite={null}
        guidingFirstSite={false}
        submitting={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
        onConfirmDelete={vi.fn()}
        getSiteFormDefaults={vi.fn()}
        orgPicker={{ organizations: ORGS, value, onChange }}
      />
    );

    it('blocks submit until an org is picked, then submits', async () => {
      const onSubmit = vi.fn();
      const onChange = vi.fn();
      const { rerender } = render(pickerModals(null, onSubmit, onChange));
      const picker = screen.getByTestId('sites-org-picker') as HTMLSelectElement;
      expect(picker.value).toBe('');
      fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'New' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create site' }));
      expect(await screen.findByText('Choose the organization this site belongs to.')).toBeInTheDocument();
      expect(onSubmit).not.toHaveBeenCalled();

      fireEvent.change(picker, { target: { value: 'org-b' } });
      expect(onChange).toHaveBeenCalledWith('org-b');
      rerender(pickerModals('org-b', onSubmit, onChange));
      expect(screen.queryByText('Choose the organization this site belongs to.')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Create site' }));
      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    });

    it('renders no picker without the prop', () => {
      renderModals('add', { selectedSite: null });
      expect(screen.queryByTestId('sites-org-picker')).toBeNull();
    });
  });
});
