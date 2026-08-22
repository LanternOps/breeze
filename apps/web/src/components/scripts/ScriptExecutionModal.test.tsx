import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScriptExecutionModal, { type Device } from './ScriptExecutionModal';
import type { ScriptParameter } from './ScriptFormSchema';
import type { Script } from './ScriptList';

// The advanced-filter panel is closed on open, so `useFilterPreview` is disabled
// and never fetches — no transport stub is needed for these cases.

const devices: Device[] = [
  { id: 'd-1', hostname: 'ws-01', os: 'windows', status: 'online', siteId: 's-1', siteName: 'HQ' },
];

const baseScript: Script = {
  id: 'sc-1',
  name: 'Rotate token',
  language: 'powershell',
  category: 'Maintenance',
  osTypes: ['windows'],
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

function renderModal(parameters: ScriptParameter[], onExecute = vi.fn().mockResolvedValue(undefined)) {
  render(
    <ScriptExecutionModal
      script={{ ...baseScript, parameters }}
      devices={devices}
      isOpen
      onClose={vi.fn()}
      onExecute={onExecute}
    />
  );
  return { onExecute };
}

/** Select the one online device and drive the two-step execute button. */
async function execute() {
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByText('Execute'));
  fireEvent.click(await screen.findByText('Confirm Execute'));
}

describe('ScriptExecutionModal sourced parameters (#3409 PR3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prompts for runtime parameters and shows bound ones read-only', () => {
    renderModal([
      { name: 'message', type: 'string', required: true },
      { name: 'api_key', type: 'string', required: true, source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    expect(screen.getByText('Parameters')).toBeInTheDocument();
    const chip = screen.getByTestId('script-bound-parameter-api_key');
    expect(chip).toHaveTextContent('Supplied automatically from variable vendor_token');
    expect(chip.querySelector('input')).toBeNull();
  });

  it('shows the parameters section as read-only chips when every parameter is bound', () => {
    renderModal([
      { name: 'org', type: 'string', required: true, source: 'builtin', builtinKey: 'org.name' },
    ]);

    // The operator is about to run this on customer machines — the injected
    // contract must be visible even though there is nothing to fill in.
    expect(screen.getByText('Parameters')).toBeInTheDocument();
    const chip = screen.getByTestId('script-bound-parameter-org');
    expect(chip).toHaveTextContent('Supplied automatically from org.name');
    expect(chip.querySelector('input')).toBeNull();
    expect(screen.getByTestId('script-parameters-all-supplied')).toBeInTheDocument();
  });

  it('executes a fully-bound script and submits an empty parameters map', async () => {
    const { onExecute } = renderModal([
      { name: 'org', type: 'string', required: true, source: 'builtin', builtinKey: 'org.name' },
      { name: 'api_key', type: 'string', required: true, defaultValue: 'fallback', source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][2]).toEqual({});
    expect(screen.queryByText(/is required/)).toBeNull();
  });

  it('renders no parameters section when the script has no parameters at all', () => {
    renderModal([]);

    expect(screen.queryByText('Parameters')).toBeNull();
  });

  it('does not seed a bound parameter\'s default and never submits it', async () => {
    const { onExecute } = renderModal([
      { name: 'message', type: 'string', defaultValue: 'hello' },
      {
        name: 'api_key',
        type: 'string',
        required: true,
        defaultValue: 'fallback',
        source: 'tenantVariable',
        variableKey: 'vendor_token',
      },
    ]);

    // The runtime default IS seeded; the bound one's fallback is not — it is the
    // server's business, and a supplied value would come back in
    // `ignoredParameters`.
    expect(screen.getByDisplayValue('hello')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('fallback')).toBeNull();

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][2]).toEqual({ message: 'hello' });
  });

  it('lets a run proceed when the only unfilled required parameter is bound', async () => {
    const { onExecute } = renderModal([
      { name: 'api_key', type: 'string', required: true, source: 'tenantVariable', variableKey: 'vendor_token' },
      { name: 'message', type: 'string' },
    ]);

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/is required/)).toBeNull();
  });

  it('still blocks on a missing required RUNTIME parameter', () => {
    const { onExecute } = renderModal([
      { name: 'message', type: 'string', required: true },
      { name: 'api_key', type: 'string', required: true, source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Execute'));

    expect(screen.getByText('Parameter "message" is required')).toBeInTheDocument();
    expect(onExecute).not.toHaveBeenCalled();
  });
});

// #3409 PR4c-2: secrets ride an env var the helper IPC cannot carry, so a
// user-context run refuses them server-side. Warn before the operator submits.
describe('ScriptExecutionModal secret parameters (#3409 PR4c-2)', () => {
  const secretParam: ScriptParameter = {
    name: 'api_token',
    source: 'tenantSecret',
    variableKey: 'vendor_password',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const selectRunAs = (value: 'system' | 'user') => {
    fireEvent.change(screen.getByDisplayValue('System'), { target: { value } });
  };

  it('warns that secrets require system context once Run as user is selected', () => {
    renderModal([secretParam]);
    expect(screen.queryByTestId('script-secrets-require-system')).toBeNull();

    selectRunAs('user');

    expect(screen.getByTestId('script-secrets-require-system')).toHaveTextContent(
      /secret variables/i
    );
  });

  it('does not warn for a user run when no parameter is a secret', () => {
    renderModal([
      { name: 'api_key', type: 'string', source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    selectRunAs('user');

    expect(screen.queryByTestId('script-secrets-require-system')).toBeNull();
  });

  it('is a warning, not a block — the run still submits', async () => {
    const { onExecute } = renderModal([secretParam]);
    selectRunAs('user');

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][3]).toBe('user');
  });
});
