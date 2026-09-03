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
    // The raw reason code is translated, not shown verbatim -- see the
    // 'falls back to the raw code' test below for the untranslated case.
    expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('Field is not script-writable');
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
    expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('No matching field definition');
  });

  it('falls back to the raw reason code for a reason with no translation', () => {
    renderExecution({
      customFieldResult: {
        applied: [],
        // Not one of the known CustomFieldWriteRejection values -- exercises
        // the t(key, { defaultValue }) fallback so a future backend-added
        // reason renders as something rather than an empty string.
        rejected: [{ key: 'asset_tag', reason: 'some_future_reason' }]
      }
    });

    expect(screen.getByTestId('exec-custom-fields-rejected')).toHaveTextContent('some_future_reason');
  });

  it('does not crash when the API payload is missing the applied/rejected arrays', () => {
    renderExecution({
      // Cast past the type: this simulates a malformed/partial API response,
      // which the component must tolerate rather than throw during render.
      customFieldResult: { applied: ['ram_slot_type'] } as unknown as ScriptExecution['customFieldResult']
    });

    expect(screen.getByTestId('exec-custom-fields-applied')).toHaveTextContent('ram_slot_type');
    expect(screen.queryByTestId('exec-custom-fields-rejected')).not.toBeInTheDocument();
  });
});
