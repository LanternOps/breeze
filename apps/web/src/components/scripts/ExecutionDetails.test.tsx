import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExecutionDetails from './ExecutionDetails';
import type { ScriptExecution } from './ExecutionHistory';

function baseExecution(overrides: Partial<ScriptExecution> = {}): ScriptExecution {
  return {
    id: 'exec-1',
    scriptId: 'script-1',
    scriptName: 'Inventory Sync',
    deviceId: 'device-1',
    deviceHostname: 'workstation-01',
    status: 'completed',
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: '2026-09-01T10:00:05.000Z',
    exitCode: 0,
    stdout: 'ok',
    ...overrides
  };
}

function renderExecution(overrides: Partial<ScriptExecution> = {}) {
  return render(
    <ExecutionDetails
      execution={baseExecution(overrides)}
      isOpen={true}
      onClose={() => {}}
    />
  );
}

describe('ExecutionDetails custom-field write summary', () => {
  it('shows applied and rejected custom-field writes', async () => {
    renderExecution({
      stdout: 'ok',
      customFieldResult: {
        applied: ['ram_slot_type'],
        rejected: [{ key: 'asset_tag', reason: 'not_script_writable' }]
      }
    });

    expect(await screen.findByTestId('exec-custom-fields-applied')).toHaveTextContent('ram_slot_type');
    expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('asset_tag');
    expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('not_script_writable');
  });

  it('renders nothing when customFieldResult is null', () => {
    renderExecution({ customFieldResult: null });

    expect(screen.queryByTestId('exec-custom-fields-applied')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exec-custom-fields-rejected')).not.toBeInTheDocument();
  });

  it('renders the rejected list even when nothing was applied', () => {
    renderExecution({
      customFieldResult: {
        applied: [],
        rejected: [{ key: 'asset_tag', reason: 'unknown_field' }]
      }
    });

    expect(screen.getByTestId('exec-custom-fields-applied')).toBeInTheDocument();
    expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('asset_tag');
    expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('unknown_field');
  });
});
