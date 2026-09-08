import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

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

describe('AutomationForm — run_script runAs override (#4888)', () => {
  const SCRIPTS = [{ id: 'script-1', name: 'Cleanup temp files' }];

  it('defaults to "Script default" and omits runAs from the submitted action', async () => {
    const onSubmit = vi.fn();
    render(
      <AutomationForm onSubmit={onSubmit} defaultValues={{ name: 'Cleanup automation' }} scripts={SCRIPTS} />,
    );

    // Default action is run_script; the run-as select should default to the
    // "Script default" option (empty value).
    const runAsSelect = screen.getByTestId('action-0-run-as-select') as HTMLSelectElement;
    expect(runAsSelect.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = onSubmit.mock.calls[0][0];
    expect(values.actions[0].type).toBe('run_script');
    expect('runAs' in values.actions[0]).toBe(false);
  });

  it('submits runAs: "user" when the operator picks "Logged-in user"', async () => {
    const onSubmit = vi.fn();
    render(
      <AutomationForm onSubmit={onSubmit} defaultValues={{ name: 'Cleanup automation' }} scripts={SCRIPTS} />,
    );

    const runAsSelect = screen.getByTestId('action-0-run-as-select');
    fireEvent.change(runAsSelect, { target: { value: 'user' } });

    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = onSubmit.mock.calls[0][0];
    expect(values.actions[0].runAs).toBe('user');
  });
});

describe('AutomationForm — whenOffline (#5128 W4)', () => {
  const SCRIPTS = [{ id: 'script-1', name: 'Cleanup temp files' }];

  it('renders the offline control on a run_script action, defaulting to Queue', () => {
    render(
      <AutomationForm onSubmit={vi.fn()} defaultValues={{ name: 'A' }} scripts={SCRIPTS} />,
    );

    const select = screen.getByTestId('action-0-when-offline-select') as HTMLSelectElement;
    expect(select.value).toBe('queue');
    expect(screen.getByRole('option', { name: 'Queue (default)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Skip' })).toBeTruthy();
  });

  it('renders the offline control on an execute_command action too', () => {
    render(<AutomationForm onSubmit={vi.fn()} defaultValues={{ name: 'A' }} />);

    fireEvent.change(screen.getByDisplayValue('Run Script'), {
      target: { value: 'execute_command' },
    });

    const select = screen.getByTestId('action-0-when-offline-select') as HTMLSelectElement;
    expect(select.value).toBe('queue');
  });

  it('does not render the offline control on a deploy_software action', () => {
    render(<AutomationForm onSubmit={vi.fn()} defaultValues={{ name: 'A' }} />);

    fireEvent.change(screen.getByDisplayValue('Run Script'), {
      target: { value: 'deploy_software' },
    });

    expect(screen.queryByTestId('action-0-when-offline-select')).toBeNull();
  });

  it('omits whenOffline from the payload when the operator never touches it', async () => {
    const onSubmit = vi.fn();
    render(
      <AutomationForm onSubmit={onSubmit} defaultValues={{ name: 'A' }} scripts={SCRIPTS} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect('whenOffline' in onSubmit.mock.calls[0][0].actions[0]).toBe(false);
  });

  it('submits whenOffline: "skip" once the operator picks Skip', async () => {
    const onSubmit = vi.fn();
    render(
      <AutomationForm onSubmit={onSubmit} defaultValues={{ name: 'A' }} scripts={SCRIPTS} />,
    );

    fireEvent.change(screen.getByTestId('action-0-when-offline-select'), {
      target: { value: 'skip' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].actions[0].whenOffline).toBe('skip');
  });
});
