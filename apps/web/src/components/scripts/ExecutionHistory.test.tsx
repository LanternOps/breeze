import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ExecutionHistory, { type ScriptExecution } from './ExecutionHistory';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

// The list endpoint omits `scriptName` on some rows and the device join can be
// null, so both fields arrive as undefined/null in production payloads. Typed
// as ScriptExecution deliberately via a cast: the type claims they're required,
// the API does not honour that — which is exactly the regression under test.
const rows = [
  {
    id: 'e1',
    scriptId: 's1',
    scriptName: 'Disk Cleanup',
    deviceId: 'd1',
    deviceHostname: 'alpha-01',
    status: 'completed',
    startedAt: '2026-08-10T10:00:00.000Z',
    duration: 12,
    exitCode: 0,
  },
  {
    id: 'e2',
    scriptId: 's2',
    // scriptName omitted entirely by the API
    deviceId: 'd2',
    deviceHostname: 'beta-02',
    status: 'failed',
    startedAt: '2026-08-10T11:00:00.000Z',
    duration: 3,
    exitCode: 1,
  },
  {
    id: 'e3',
    scriptId: 's3',
    scriptName: 'Patch Report',
    deviceId: 'd3',
    deviceHostname: null, // device join came back null
    status: 'running',
    startedAt: '2026-08-10T12:00:00.000Z',
  },
] as unknown as ScriptExecution[];

// The data rows carry role="button" (the whole row is clickable), so the
// implicit "row" ARIA role is gone — query the DOM directly instead.
function bodyRows(): HTMLElement[] {
  const body = screen.getByRole('table').querySelector('tbody')!;
  return Array.from(body.querySelectorAll('tr'));
}

describe('ExecutionHistory', () => {
  it('filters on a search term without throwing when scriptName or deviceHostname is missing', () => {
    render(<ExecutionHistory executions={rows} />);

    const search = screen.getByPlaceholderText('Search...');
    // Unguarded `.toLowerCase()` on the undefined scriptName of row e2 throws a
    // TypeError out of the filter useMemo, killing the whole render.
    fireEvent.change(search, { target: { value: 'alpha' } });

    expect(screen.getByText('Disk Cleanup')).toBeInTheDocument();
    expect(screen.getByText('alpha-01')).toBeInTheDocument();
    expect(screen.queryByText('beta-02')).toBeNull();
    expect(screen.queryByText('Patch Report')).toBeNull();
    expect(bodyRows()).toHaveLength(1);
  });

  it('matches on the device hostname of a row whose script name is missing', () => {
    render(<ExecutionHistory executions={rows} />);

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'beta' } });

    expect(screen.getByText('beta-02')).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(1);
    expect(screen.queryByText('Disk Cleanup')).toBeNull();
  });

  it('finds nothing (rather than throwing) for a term no row matches', () => {
    render(<ExecutionHistory executions={rows} />);

    fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'zzz-nomatch' } });

    expect(screen.getByText(/No executions found/i)).toBeInTheDocument();
  });

  it('sorts by script name with missing script names present', () => {
    render(<ExecutionHistory executions={rows} />);

    // localeCompare on an undefined scriptName throws out of the sort useMemo.
    fireEvent.click(screen.getByText('Script'));

    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText('Disk Cleanup')).toBeInTheDocument();
    expect(screen.getByText('Patch Report')).toBeInTheDocument();
    // The blank-named row sorts first ascending and is still rendered.
    expect(within(bodyRows()[0]).getByText('beta-02')).toBeInTheDocument();

    // Reversing the direction must also survive the null rows.
    fireEvent.click(screen.getByText('Script'));
    expect(bodyRows()).toHaveLength(3);
  });

  it('sorts by device with a null device hostname present', () => {
    render(<ExecutionHistory executions={rows} />);

    fireEvent.click(screen.getByText('Device'));

    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText('alpha-01')).toBeInTheDocument();
    expect(screen.getByText('beta-02')).toBeInTheDocument();
    // The null-hostname row sorts first ascending; its script name still shows.
    expect(within(bodyRows()[0]).getByText('Patch Report')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Device'));
    expect(bodyRows()).toHaveLength(3);
  });

  it('sorts by script and then by device in one session without throwing', () => {
    render(<ExecutionHistory executions={rows} />);

    fireEvent.click(screen.getByText('Script'));
    fireEvent.click(screen.getByText('Device'));

    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText('Disk Cleanup')).toBeInTheDocument();
  });

  it('reports the view-details row to the caller when the eye action is clicked', () => {
    const onViewDetails = vi.fn();
    render(<ExecutionHistory executions={rows} onViewDetails={onViewDetails} />);

    fireEvent.click(screen.getAllByTitle('View details')[0]);

    expect(onViewDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1' }));
  });
});

// A `pending` execution has no `started_at` yet (the API returns NULL until
// the agent picks it up); the STARTED column must not misrender that as an
// epoch date, and DURATION must be computed from real timestamps rather than
// a `duration` field the API never returns.
describe('ExecutionHistory pending/duration rendering', () => {
  it('does not render an epoch date in the STARTED column for a pending execution', () => {
    const pendingRow = {
      id: 'p1',
      scriptId: 's1',
      scriptName: 'Pending Script',
      deviceId: 'd1',
      deviceHostname: 'gamma-03',
      status: 'pending',
      startedAt: null,
    } as unknown as ScriptExecution;

    render(<ExecutionHistory executions={[pendingRow]} />);

    const row = bodyRows()[0];
    // Columns: script, device, status, STARTED, duration, exit code, actions.
    const startedCell = row.querySelectorAll('td')[3];
    // Pre-fix, `new Date(null)` is epoch (Jan 1 1970 UTC) and formats as a
    // real-looking date/time ("Dec 31, 05:00 PM") since the STARTED column's
    // format string carries no year to give the bug away numerically — the
    // placeholder is the only reliable signal that it was NOT formatted.
    expect(startedCell).toHaveTextContent('—');
  });

  it('computes the DURATION column from startedAt/completedAt when the API omits `duration`', () => {
    const completedRow = {
      id: 'c1',
      scriptId: 's1',
      scriptName: 'Timed Script',
      deviceId: 'd1',
      deviceHostname: 'delta-04',
      status: 'completed',
      startedAt: '2026-08-10T10:00:00.000Z',
      completedAt: '2026-08-10T10:01:00.000Z',
      // no `duration` field — exactly what the API returns today
    } as unknown as ScriptExecution;

    render(<ExecutionHistory executions={[completedRow]} />);

    const row = bodyRows()[0];
    expect(within(row).getByText('1m 0s')).toBeInTheDocument();
  });
});
