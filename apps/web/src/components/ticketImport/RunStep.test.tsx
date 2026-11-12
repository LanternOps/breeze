import '@/lib/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), toastMock: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import RunStep, { runForStep } from './RunStep';
import { RUN_POLL_MS } from './useRunPolling';
import { ORG_A, SOURCE_ID, WINDOW_ID, counters, importRun, json, migrationWindow, sourceDetail } from './testFixtures';
import type { ImportRun } from './ticketImportApi';

const RUN_ID = '55555555-5555-4555-8555-555555555555';
const nameOfOrg = (id: string) => (id === ORG_A ? 'Acme' : id);

type Routes = { run: () => ImportRun; start?: () => Response; issues?: unknown[]; contacts?: unknown[] };
function route(r: Routes) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url === `/ticket-imports/sources/${SOURCE_ID}/runs`) return r.start?.() ?? json(201, { data: r.run() });
    if (method === 'POST' && url.endsWith('/cancel')) return json(200, { data: { ...r.run(), state: 'cancelled' }, alreadyFinished: false });
    if (url === `/ticket-imports/runs/${RUN_ID}`) return json(200, { data: r.run() });
    if (url.startsWith(`/ticket-imports/runs/${RUN_ID}/issues`)) return json(200, { data: r.issues ?? [], next: null });
    if (url.startsWith(`/ticket-imports/sources/${SOURCE_ID}/created-contacts`)) return json(200, { data: r.contacts ?? [], next: null });
    return json(404, { error: `unrouted ${method} ${url}` });
  });
}
const starts = () => fetchMock.mock.calls.filter(([url, init]) => url === `/ticket-imports/sources/${SOURCE_ID}/runs` && (init as { method?: string })?.method === 'POST')
  .map(([, init]) => JSON.parse((init as { body: string }).body));

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function renderStep(over: Partial<Parameters<typeof RunStep>[0]> = {}) {
  const props = {
    kind: 'dry_run' as const,
    source: sourceDetail(),
    runs: [] as ImportRun[],
    openWindow: null,
    nameOfOrg,
    onRunsChanged: vi.fn(),
    onContinue: vi.fn(),
    onOpenWindowStep: vi.fn(),
    ...over,
  };
  return { ...render(<RunStep {...props} />), props };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('RunStep — dry run (#8313 W6)', () => {
  it('starts a dry run, follows it every 5 s and reads the report with its contact predictions', async () => {
    vi.useFakeTimers();
    let state: ImportRun['state'] = 'queued';
    const finalCounters = counters({
      predicted: {
        ...counters().predicted,
        contactsToCreate: { [ORG_A]: 3 },
        contactsToCreateOverCap: 12,
      },
    });
    route({ run: () => importRun({ id: RUN_ID, state, phase: state === 'completed' ? 'done' : 'scan', counters: state === 'completed' ? finalCounters : counters() }) });
    const { props } = renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-run-start'));
    await act(flush);
    expect(starts()).toEqual([{ kind: 'dry_run' }]);
    expect(screen.getByTestId('ticket-import-run-state')).toHaveTextContent('Queued');
    expect(screen.getByTestId('ticket-import-run-cancel')).toBeInTheDocument();

    state = 'completed';
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS); await flush(); });
    expect(screen.getByTestId('ticket-import-run-state')).toHaveTextContent('Completed');
    expect(screen.getByTestId(`ticket-import-report-contacts-org-${ORG_A}`)).toHaveTextContent('Acme: 3 contacts');
    expect(screen.getByTestId('ticket-import-report-contacts-over-cap')).toHaveTextContent('12');
    expect(screen.getByTestId('ticket-import-report-predicted-creates')).toHaveTextContent('7');
    expect(props.onRunsChanged).toHaveBeenCalled();
    expect(screen.queryByTestId('ticket-import-run-cancel')).toBeNull();
  });

  it('lists issues by kind, including row_unreadable and a ticket_too_large failure', async () => {
    route({
      run: () => importRun({ id: RUN_ID }),
      issues: [
        { id: 'i-1', sourceTicketKey: '17', sourceTicketNumber: '41023', kind: 'failed', code: 'ticket_too_large', count: 1, createdAt: '2026-11-12T09:01:00Z' },
        { id: 'i-2', sourceTicketKey: '18', sourceTicketNumber: '41024', kind: 'row_unreadable', code: 'source_shape_invalid', count: 1, createdAt: '2026-11-12T09:01:00Z' },
      ],
    });
    renderStep({ runs: [importRun({ id: RUN_ID })] });
    expect(await screen.findByTestId('ticket-import-issue-i-1')).toHaveTextContent('41023');
    expect(screen.getByTestId('ticket-import-issue-i-1')).toHaveTextContent('Ticket too large');
    expect(screen.getByTestId('ticket-import-issue-i-2')).toHaveTextContent('Unreadable list row');

    fireEvent.change(screen.getByTestId('ticket-import-issues-kind'), { target: { value: 'row_unreadable' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('kind=row_unreadable'))).toBe(true));
  });

  it('reloads the issues when the run ends', async () => {
    vi.useFakeTimers();
    let state: ImportRun['state'] = 'running';
    let issues: unknown[] = [];
    route({ run: () => importRun({ id: RUN_ID, state, phase: state === 'running' ? 'scan' : 'done' }), issues: [] });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/ticket-imports/runs/${RUN_ID}`) return json(200, { data: importRun({ id: RUN_ID, state, phase: state === 'running' ? 'scan' : 'done' }) });
      if (url.startsWith(`/ticket-imports/runs/${RUN_ID}/issues`)) return json(200, { data: issues, next: null });
      return json(404, { error: 'unrouted' });
    });
    renderStep({ runs: [importRun({ id: RUN_ID, state: 'running', phase: 'scan' })] });
    await act(flush);
    expect(screen.getByTestId('ticket-import-issues-empty')).toBeInTheDocument();
    state = 'completed';
    issues = [{ id: 'late', sourceTicketKey: '5', sourceTicketNumber: '40005', kind: 'skipped_no_org', code: 'no_org', count: 1, createdAt: '2026-11-12T09:05:00Z' }];
    await act(async () => { vi.advanceTimersByTime(RUN_POLL_MS); await flush(); });
    expect(screen.getByTestId('ticket-import-issue-late')).toHaveTextContent('40005');
  });

  it('names an unmatched owner from the source, and falls back to the key when it cannot', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url === `/ticket-imports/runs/${RUN_ID}`) return json(200, { data: importRun({ id: RUN_ID }) });
      if (url.startsWith(`/ticket-imports/runs/${RUN_ID}/issues`)) {
        return json(200, { data: [
          { id: 'o-1', sourceTicketKey: '1', sourceTicketNumber: '41001', kind: 'owner_unmatched', code: '4', count: 1, createdAt: '2026-11-12T09:01:00Z' },
          { id: 'o-2', sourceTicketKey: '2', sourceTicketNumber: '41002', kind: 'owner_unmatched', code: '77', count: 1, createdAt: '2026-11-12T09:01:00Z' },
        ], next: null });
      }
      if (url === `/ticket-imports/sources/${SOURCE_ID}/source-users/resolve` && init?.method === 'POST') {
        expect(JSON.parse(init.body!)).toEqual({ keys: ['4', '77'] });
        return json(200, { data: { 4: { name: 'Bob Former', email: 'bob@example.test' }, 77: null } });
      }
      return json(404, { error: 'unrouted' });
    });
    renderStep({ runs: [importRun({ id: RUN_ID })] });
    await waitFor(() => expect(screen.getByTestId('ticket-import-issue-code-o-1')).toHaveTextContent('Bob Former (bob@example.test)'));
    expect(screen.getByTestId('ticket-import-issue-code-o-2')).toHaveTextContent('77');
  });

  it('a failed name lookup keeps the keys, without an error toast', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === `/ticket-imports/runs/${RUN_ID}`) return json(200, { data: importRun({ id: RUN_ID }) });
      if (url.startsWith(`/ticket-imports/runs/${RUN_ID}/issues`)) {
        return json(200, { data: [{ id: 'o-1', sourceTicketKey: '1', sourceTicketNumber: '41001', kind: 'owner_unmatched', code: '4', count: 1, createdAt: '2026-11-12T09:01:00Z' }], next: null });
      }
      if (init?.method === 'POST') return json(502, { error: 'down', code: 'TICKET_IMPORT_SOURCE_UNREACHABLE' });
      return json(404, { error: 'unrouted' });
    });
    renderStep({ runs: [importRun({ id: RUN_ID })] });
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as { method?: string })?.method === 'POST')).toBe(true));
    expect(screen.getByTestId('ticket-import-issue-code-o-1')).toHaveTextContent('4');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('says so when cancelling a run that had already finished', async () => {
    route({ run: () => importRun({ id: RUN_ID, state: 'running', phase: 'scan' }) });
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && url.endsWith('/cancel')) return json(200, { data: importRun({ id: RUN_ID }), alreadyFinished: true });
      if (url === `/ticket-imports/runs/${RUN_ID}`) return json(200, { data: importRun({ id: RUN_ID, state: 'running', phase: 'scan' }) });
      return json(200, { data: [], next: null });
    });
    renderStep({ runs: [importRun({ id: RUN_ID, state: 'running', phase: 'scan' })] });
    fireEvent.click(await screen.findByTestId('ticket-import-run-cancel'));
    fireEvent.click(await screen.findByTestId('ticket-import-run-cancel-confirm'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'This run had already finished.' })));
  });

  it('a refused start shows the reason', async () => {
    route({ run: () => importRun({ id: RUN_ID }), start: () => json(409, { error: 'active', code: 'TICKET_IMPORT_RUN_ACTIVE' }) });
    renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-run-start'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'A run of this source is in progress. Wait for it or cancel it.',
    })));
  });

  it('cancels an active run after confirmation', async () => {
    route({ run: () => importRun({ id: RUN_ID, state: 'running', phase: 'scan' }) });
    renderStep({ runs: [importRun({ id: RUN_ID, state: 'running', phase: 'scan' })] });
    fireEvent.click(await screen.findByTestId('ticket-import-run-cancel'));
    fireEvent.click(await screen.findByTestId('ticket-import-run-cancel-confirm'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => url === `/ticket-imports/runs/${RUN_ID}/cancel` && (init as { method?: string }).method === 'POST')).toBe(true));
  });
});

describe('RunStep — bulk and delta (#8313 W6)', () => {
  it('needs an open window before an import can start', () => {
    route({ run: () => importRun({ id: RUN_ID }) });
    const { props } = renderStep({ kind: 'bulk' });
    expect(screen.getByTestId('ticket-import-run-needs-window')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-run-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ticket-import-run-go-window'));
    expect(props.onOpenWindowStep).toHaveBeenCalled();
  });

  it('starts an import through the open window and shows the created contacts', async () => {
    route({
      run: () => importRun({ id: RUN_ID, kind: 'import', windowId: WINDOW_ID, state: 'running', phase: 'scan' }),
      contacts: [{ contactId: 'c-1', orgId: ORG_A, name: 'Ana Souza', email: 'ana@example.com', sourceUserKey: '9', createdAt: '2026-11-12T09:00:00Z', keptBecause: [] }],
    });
    renderStep({ kind: 'bulk', openWindow: migrationWindow() });
    fireEvent.click(screen.getByTestId('ticket-import-run-start'));
    await waitFor(() => expect(starts()).toEqual([{ kind: 'import', windowId: WINDOW_ID }]));
    expect(await screen.findByTestId('ticket-import-contact-c-1')).toHaveTextContent('Ana Souza');
  });

  it('asks for the freeze before a delta run', () => {
    route({ run: () => importRun({ id: RUN_ID }) });
    renderStep({ kind: 'delta', openWindow: migrationWindow() });
    expect(screen.getByTestId('ticket-import-run-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ticket-import-run-frozen'));
    expect(screen.getByTestId('ticket-import-run-start')).not.toBeDisabled();
  });

  it('picks each step\'s own run: the newest dry run, the window\'s first import, then the newest import after it ended', () => {
    const win = migrationWindow();
    const dry = importRun({ id: 'dry', startedAt: '2026-11-12T07:00:00.000Z' });
    const bulk = importRun({ id: 'bulk', kind: 'import', windowId: WINDOW_ID, startedAt: '2026-11-12T08:00:00.000Z', finishedAt: '2026-11-12T09:00:00.000Z' });
    const delta1 = importRun({ id: 'delta1', kind: 'import', windowId: WINDOW_ID, startedAt: '2026-11-13T08:00:00.000Z', finishedAt: '2026-11-13T08:10:00.000Z' });
    const delta2 = importRun({ id: 'delta2', kind: 'import', windowId: WINDOW_ID, startedAt: '2026-11-13T09:00:00.000Z', finishedAt: null, state: 'running' });
    const otherWindow = importRun({ id: 'other', kind: 'import', windowId: 'w-old', startedAt: '2026-11-14T00:00:00.000Z' });
    const runs = [otherWindow, delta2, delta1, bulk, dry]; // newest first, as the API lists them
    expect(runForStep('dry_run', runs, win)?.id).toBe('dry');
    expect(runForStep('bulk', runs, win)?.id).toBe('bulk');
    expect(runForStep('delta', runs, win)?.id).toBe('delta2');
    expect(runForStep('bulk', runs, null)).toBeNull();
    expect(runForStep('delta', runs, null)).toBeNull();
  });

  it('with only the bulk run, the delta step is empty, and stays empty while the bulk run is active', () => {
    const win = migrationWindow();
    const bulkDone = importRun({ id: 'bulk', kind: 'import', windowId: WINDOW_ID });
    expect(runForStep('delta', [bulkDone], win)).toBeNull();
    const bulkRunning = importRun({ id: 'bulk', kind: 'import', windowId: WINDOW_ID, state: 'running', finishedAt: null });
    const early = importRun({ id: 'early', kind: 'import', windowId: WINDOW_ID, startedAt: '2026-11-12T09:30:00.000Z' });
    expect(runForStep('delta', [early, bulkRunning], win)).toBeNull();
  });

  it('the delta step offers its own start, and continues only once a delta run completed', async () => {
    const bulk = importRun({ id: RUN_ID, kind: 'import', windowId: WINDOW_ID });
    route({ run: () => bulk });
    const { unmount } = renderStep({ kind: 'delta', openWindow: migrationWindow(), runs: [bulk] });
    expect(screen.getByTestId('ticket-import-run-start')).toHaveTextContent('Start delta run');
    expect(screen.queryByTestId('ticket-import-run-status')).toBeNull();
    expect(screen.queryByTestId('ticket-import-run-continue')).toBeNull();
    unmount();
    // The bulk step shows the bulk run, never a delta.
    const delta = importRun({ id: 'delta-run', kind: 'import', windowId: WINDOW_ID, startedAt: '2026-11-13T08:00:00.000Z', state: 'failed', stopReason: 'source_502' });
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `/ticket-imports/runs/${RUN_ID}`) return json(200, { data: bulk });
      if (url === '/ticket-imports/runs/delta-run') return json(200, { data: delta });
      if (url.includes('/issues')) return json(200, { data: [], next: null });
      return json(200, { data: [], next: null });
    });
    const bulkView = renderStep({ kind: 'bulk', openWindow: migrationWindow(), runs: [delta, bulk] });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === `/ticket-imports/runs/${RUN_ID}`)).toBe(true));
    expect(fetchMock.mock.calls.some(([u]) => u === '/ticket-imports/runs/delta-run')).toBe(false);
    bulkView.unmount();
    // A failed delta run: its reason in words, and no Continue.
    renderStep({ kind: 'delta', openWindow: migrationWindow(), runs: [delta, bulk] });
    expect(await screen.findByTestId('ticket-import-run-stop-reason')).toHaveTextContent('HTTP 502');
    expect(screen.queryByTestId('ticket-import-run-continue')).toBeNull();
  });
});
