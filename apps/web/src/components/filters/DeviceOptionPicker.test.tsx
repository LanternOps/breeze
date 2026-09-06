import { fireEvent, render, screen } from '@testing-library/react';
import type { DeviceOption } from '@breeze/shared';
import { describe, expect, it, vi } from 'vitest';
import type { UseDeviceOptionsResult } from '../../hooks/useDeviceOptions';
import { DeviceOptionPicker } from './DeviceOptionPicker';

function option(id: string, hostname = id): DeviceOption {
  return {
    id,
    hostname,
    displayName: null,
    osType: 'windows',
    status: 'online',
    siteId: null,
    siteName: null,
  };
}

function result(overrides: Partial<UseDeviceOptionsResult> = {}): UseDeviceOptionsResult {
  return {
    options: [],
    page: null,
    state: 'loading',
    error: null,
    canSubmit: false,
    loadMore: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    ...overrides,
  };
}

describe('DeviceOptionPicker', () => {
  it('announces loading without rendering a false empty state', () => {
    render(
      <DeviceOptionPicker
        result={result()}
        selectedIds={[]}
        onSelectedIdsChange={vi.fn()}
        search=""
        onSearchChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent(/loading devices/i);
    expect(screen.queryByText(/no devices found/i)).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: /search devices/i })).toBeDisabled();
  });

  it('renders an accessible error with retry', () => {
    const retry = vi.fn();
    render(
      <DeviceOptionPicker
        result={result({ state: 'error', error: new Error('network down'), retry })}
        selectedIds={[]}
        onSelectedIdsChange={vi.fn()}
        search=""
        onSearchChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/network down/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('keeps stale labels visible, announces their state, and blocks submission', () => {
    const onCanSubmitChange = vi.fn();
    render(
      <DeviceOptionPicker
        result={result({
          options: [option('device-a', 'Old label')],
          state: 'stale',
        })}
        selectedIds={['device-a']}
        onSelectedIdsChange={vi.fn()}
        search="new scope"
        onSearchChange={vi.fn()}
        onCanSubmitChange={onCanSubmitChange}
      />,
    );

    expect(screen.getByText('Old label')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/updating device choices/i);
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(false);
  });

  it('renders an empty state only after a settled empty response', () => {
    render(
      <DeviceOptionPicker
        result={result({ state: 'empty', canSubmit: true, page: {
          nextCursor: null,
          returned: 0,
          total: 0,
          hasMore: false,
          observedAt: '2026-08-24T12:00:00.000Z',
        } })}
        selectedIds={[]}
        onSelectedIdsChange={vi.fn()}
        search="missing"
        onSearchChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/no devices found/i)).toBeInTheDocument();
  });

  it('blocks submission when any selected ID is unresolved', () => {
    const onCanSubmitChange = vi.fn();
    render(
      <DeviceOptionPicker
        result={result({
          options: [option('resolved')],
          state: 'ready',
          canSubmit: true,
        })}
        selectedIds={['resolved', 'missing']}
        onSelectedIdsChange={vi.fn()}
        search=""
        onSearchChange={vi.fn()}
        onCanSubmitChange={onCanSubmitChange}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/selected device.*could not be resolved/i);
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(false);
  });

  it('shows load-more for truncated exhaustive results and select-all only when complete', () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    const props = {
      selectedIds: [] as string[],
      onSelectedIdsChange: vi.fn(),
      search: '',
      onSearchChange: vi.fn(),
      showSelectAll: true,
    };
    const { rerender } = render(
      <DeviceOptionPicker
        {...props}
        result={result({
          options: [option('one')],
          state: 'truncated',
          page: {
            nextCursor: 'next',
            returned: 1,
            total: 2,
            hasMore: true,
            observedAt: '2026-08-24T12:00:00.000Z',
          },
          loadMore,
        })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/more devices must be loaded/i);
    expect(screen.queryByRole('button', { name: /select all/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(loadMore).toHaveBeenCalledTimes(1);

    rerender(
      <DeviceOptionPicker
        {...props}
        result={result({
          options: [option('one'), option('two')],
          state: 'ready',
          canSubmit: true,
          page: {
            nextCursor: null,
            returned: 2,
            total: 2,
            hasMore: false,
            observedAt: '2026-08-24T12:00:01.000Z',
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /select all/i }));
    expect(props.onSelectedIdsChange).toHaveBeenLastCalledWith(['one', 'two']);
  });

  it('offers checkbox labels and toggles selection without deriving labels client-side', () => {
    const onChange = vi.fn();
    render(
      <DeviceOptionPicker
        result={result({ options: [option('device-a', 'Workstation A')], state: 'ready', canSubmit: true })}
        selectedIds={[]}
        onSelectedIdsChange={onChange}
        search=""
        onSearchChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: /workstation a/i }));
    expect(onChange).toHaveBeenCalledWith(['device-a']);
  });
});
