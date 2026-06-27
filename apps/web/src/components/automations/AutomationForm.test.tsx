import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import AutomationForm from './AutomationForm';

const CATALOG = [
  { id: 'cat-1', name: 'Google Chrome', vendor: 'Google' },
  { id: 'cat-2', name: 'Firefox', vendor: 'Mozilla' },
];

describe('AutomationForm — deploy_software action', () => {
  it('renders a catalog picker + helper text and submits the chosen catalogId', async () => {
    const onSubmit = vi.fn();
    render(
      <AutomationForm
        onSubmit={onSubmit}
        defaultValues={{ name: 'Deploy Chrome' }}
        softwareCatalog={CATALOG}
      />,
    );

    // Switch the default action to Deploy Software.
    const actionTypeSelect = screen.getByDisplayValue('Run Script');
    fireEvent.change(actionTypeSelect, { target: { value: 'deploy_software' } });

    // Helper text + catalog picker appear.
    expect(
      screen.getByText(/Installs the latest version of the selected software/i),
    ).toBeTruthy();
    const catalogSelect = screen.getByDisplayValue('Select software...');
    expect(catalogSelect).toBeTruthy();
    // Populated from the software catalog list.
    expect(screen.getByRole('option', { name: 'Google Chrome (Google)' })).toBeTruthy();

    fireEvent.change(catalogSelect, { target: { value: 'cat-1' } });

    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = onSubmit.mock.calls[0][0];
    expect(values.actions[0].type).toBe('deploy_software');
    expect(values.actions[0].catalogId).toBe('cat-1');
  });
});
