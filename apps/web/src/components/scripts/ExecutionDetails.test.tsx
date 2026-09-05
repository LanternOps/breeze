import type { ComponentProps } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

function renderExecution(
  overrides: Partial<ScriptExecution> = {},
  extraProps: Partial<ComponentProps<typeof ExecutionDetails>> = {}
) {
  return render(
    <ExecutionDetails
      execution={baseExecution(overrides)}
      isOpen={true}
      onClose={() => {}}
      {...extraProps}
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

describe('ExecutionDetails "Run again" (#4885)', () => {
  it('does not render a Run again button when no handler is supplied', () => {
    renderExecution();

    expect(screen.queryByTestId('execution-run-again')).not.toBeInTheDocument();
  });

  it('invokes onRunAgain with the full execution record when clicked', () => {
    const onRunAgain = vi.fn();
    const execution = baseExecution({ parameters: { target: 'C:\\Temp' } });
    renderExecution({ parameters: { target: 'C:\\Temp' } }, { onRunAgain });

    fireEvent.click(screen.getByTestId('execution-run-again'));

    expect(onRunAgain).toHaveBeenCalledTimes(1);
    expect(onRunAgain).toHaveBeenCalledWith(expect.objectContaining({
      id: execution.id,
      scriptId: execution.scriptId,
      deviceId: execution.deviceId,
      parameters: { target: 'C:\\Temp' },
    }));
  });
});

describe('ExecutionDetails run context (#4888)', () => {
  it('names the system context for a run recorded as system', () => {
    renderExecution({ runAs: 'system' });

    expect(screen.getByTestId('run-context-chip')).toHaveTextContent('System');
  });

  it('names the target session for a run recorded as user with a session', () => {
    renderExecution({ runAs: 'user', targetSessionId: 3 });

    expect(screen.getByTestId('run-context-chip')).toHaveTextContent('session 3');
  });

  it('renders "not recorded" -- never "System" -- for a null runAs', () => {
    renderExecution({ runAs: null });

    const chip = screen.getByTestId('run-context-chip');
    expect(chip).toHaveTextContent('Not recorded');
    // This is the assertion that matters: a null runAs must never be
    // rendered as a plausible-but-invented "System", since the column is
    // nullable specifically because pre-#4888 rows genuinely don't know.
    expect(chip).not.toHaveTextContent('System');
  });
});

// The list/detail endpoints never return `duration` -- only startedAt/
// completedAt are on the wire -- so this panel must derive it, same as
// ExecutionHistory's table column.
describe('ExecutionDetails duration (no `duration` field on the wire)', () => {
  it('computes the Duration field from startedAt/completedAt when `duration` is absent', () => {
    renderExecution({
      startedAt: '2026-09-01T10:00:00.000Z',
      completedAt: '2026-09-01T10:01:00.000Z',
      duration: undefined,
    });

    const durationLabel = screen.getByText('Duration');
    expect(durationLabel.parentElement).toHaveTextContent('1m 0s');
  });

  it('shows a placeholder rather than "-" for a pending execution with no started/completed timestamps', () => {
    renderExecution({
      status: 'pending',
      startedAt: null,
      completedAt: undefined,
      duration: undefined,
    });

    const durationLabel = screen.getByText('Duration');
    expect(durationLabel.parentElement).toHaveTextContent('—');
  });
});
