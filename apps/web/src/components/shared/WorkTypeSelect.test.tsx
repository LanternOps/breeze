// apps/web/src/components/shared/WorkTypeSelect.test.tsx
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import WorkTypeSelect, { resetWorkTypeCache } from './WorkTypeSelect';

beforeEach(() => {
  resetWorkTypeCache();
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ workTypes: [
      { id: 'wt-1', name: 'Remote', isActive: true },
      { id: 'wt-2', name: 'On-site', isActive: true },
    ] }),
  });
});

describe('WorkTypeSelect', () => {
  it('renders the active work types plus a blank "no work type" option', async () => {
    render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
    await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Remote'));
    const select = screen.getByTestId('wt') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Remote', 'On-site']),
    );
    // The orphan-value trap (CLAUDE.md): an unmatched value reads as ''. Assert
    // the blank option EXISTS rather than inferring it from the value.
    expect([...select.options].some((o) => o.value === '')).toBe(true);
  });

  it('reports the selected id, and null for the blank option', async () => {
    const onChange = vi.fn();
    render(<WorkTypeSelect value={null} onChange={onChange} testId="wt" />);
    await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Remote'));
    await userEvent.selectOptions(screen.getByTestId('wt'), 'wt-2');
    expect(onChange).toHaveBeenCalledWith('wt-2');
    await userEvent.selectOptions(screen.getByTestId('wt'), '');
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('renders an ARCHIVED value from fallbackOption instead of silently showing None', async () => {
    render(
      <WorkTypeSelect
        value="wt-archived" onChange={() => {}} testId="wt"
        fallbackOption={{ id: 'wt-archived', name: 'Legacy Bench Work', isActive: false }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Remote'));
    const select = screen.getByTestId('wt') as HTMLSelectElement;
    expect(select.value).toBe('wt-archived');
    expect([...select.options].map((o) => o.textContent)).toContain('Legacy Bench Work (archived)');
  });

  it('fetches ONCE across two mounted instances', async () => {
    render(<><WorkTypeSelect value={null} onChange={() => {}} testId="wt-a" /><WorkTypeSelect value={null} onChange={() => {}} testId="wt-b" /></>);
    await waitFor(() => expect(screen.getByTestId('wt-a')).toHaveTextContent('Remote'));
    await waitFor(() => expect(screen.getByTestId('wt-b')).toHaveTextContent('Remote'));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('renders a disabled select with an explanatory option when the fetch fails — never an empty box', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
    await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Work types unavailable'));
    expect(screen.getByTestId('wt')).toBeDisabled();
  });
});

it('refreshes mounted pickers after invalidation', async () => {
  render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
  await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Remote'));
  fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ workTypes: [
    { id: 'wt-3', name: 'Project', isActive: true },
  ] }) });
  act(() => resetWorkTypeCache());
  await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Project'));
  expect(screen.getByTestId('wt')).not.toHaveTextContent('Remote');
  expect(fetchWithAuth).toHaveBeenCalledTimes(2);
});

it('discards an in-flight response from before reset', async () => {
  let resolveOld!: (response: unknown) => void;
  fetchWithAuth.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
  act(() => resetWorkTypeCache());
  await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Remote'));
  await act(async () => resolveOld({ ok: true, json: async () => ({ workTypes: [
    { id: 'old', name: 'Old partner label', isActive: true },
  ] }) }));
  expect(screen.getByTestId('wt')).not.toHaveTextContent('Old partner label');
});

it('retries on a later mount after a network failure', async () => {
  fetchWithAuth.mockRejectedValueOnce(new Error('offline'));
  const first = render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
  await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Work types unavailable'));
  first.unmount();
  render(<WorkTypeSelect value={null} onChange={() => {}} testId="wt" />);
  await waitFor(() => expect(screen.getByTestId('wt')).toHaveTextContent('Remote'));
  expect(screen.getByTestId('wt')).toBeEnabled();
});
