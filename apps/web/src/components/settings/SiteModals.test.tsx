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
  it('delete renders a destructive confirm dialog whose Delete button fires onConfirmDelete', () => {
    const { onConfirmDelete } = renderModals('delete');

    const dialog = screen.getByRole('dialog', { name: 'Delete Site' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent(SITE.name);

    fireEvent.click(screen.getByTestId('site-delete-confirm'));
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
  });

  it('delete dialog closes on Escape', () => {
    const { onClose } = renderModals('delete');

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Delete Site' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
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
});
